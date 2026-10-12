"""Reader's LaTeX compiler on Google Cloud Run (worker/latex.js calls it).

POST /compile, with the Worker's secret as a bearer token and JSON
{main, flag, files: [{path, base64}]}, compiles the files with latexmk and all
of TeX Live and answers {pdf: base64 or '', log, exit, seconds}.

As Overleaf's compile servers do, a project's folder is kept between compiles
when the job names one (project, from the Worker: a hash of who and which
paper): the job then sends `manifest`, every file's path and the SHA-256 of its
base64, and only the files that changed. TeX's own files (.aux, .bbl, .toc)
stay, so latexmk reruns only what it must: one pass, usually, not four. A file
the folder lacks is asked for (409, {need: [paths]}); a file no longer in the
manifest is removed. Folders live in this instance's memory, the least
recently used dropped past MAX_PROJECTS; nothing outlives the instance, and
nothing of a paper is logged.

A paper is someone else's TeX, so it is compiled as an unprivileged user with
a clean environment (the secret is only in this process's, which that user
can't read), no shell escape, kpathsea told to open no absolute or dotted
paths (openin_any=p), and a time limit.

    LATEX_TOKEN   the secret the Worker sends (LATEX_CLOUD_RUN_TOKEN there)
    PORT          set by Cloud Run
"""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get('LATEX_TOKEN', '').strip()
MAX_BODY = 30 * 1024 * 1024
TIMEOUT_S = int(os.environ.get('LATEX_TIMEOUT_S', '240'))
FLAGS = {'-pdf', '-xelatex', '-lualatex', '-pdfdvi'}
USER = os.environ.get('LATEX_USER', 'tex')
PROJECTS = pathlib.Path(tempfile.gettempdir()) / 'reader-projects'
MAX_PROJECTS = int(os.environ.get('LATEX_MAX_PROJECTS', '30'))
LOCKS = {}
LOCKS_GUARD = threading.Lock()
LATEXMK = os.environ.get('LATEXMK', 'latexmk')
# What TeX sees: enough to find TeX Live, nothing of this process's own.
CLEAN_ENV = {
    'PATH': os.environ.get('PATH', '/usr/local/bin:/usr/bin:/bin'),
    'HOME': '/tmp',
    'LANG': 'C.UTF-8',
    'openin_any': 'p',
    'openout_any': 'p',
    'shell_escape': 'f',
}


def as_user():
    """Run TeX as the unprivileged user when this is root (as on Cloud Run); as itself otherwise (a local test)."""
    if os.geteuid() != 0:
        return {}
    try:
        import pwd
        entry = pwd.getpwnam(USER)
        return {'user': entry.pw_uid, 'group': entry.pw_gid, 'extra_groups': []}
    except KeyError:
        return {}


class NeedFiles(Exception):
    """The kept folder lacks these files: the page sends them and asks again."""

    def __init__(self, need):
        super().__init__('need files')
        self.need = need


def clean_path(path):
    path = str(path).lstrip('/')
    if not path or len(path) > 300 or any(part in ('', '.', '..') for part in path.split('/')):
        raise ValueError(f'a path: {path[:80]}')
    return path


def lock_for(key):
    with LOCKS_GUARD:
        return LOCKS.setdefault(key, threading.Lock())


def forget_old_projects():
    """Keeps the MAX_PROJECTS most recently compiled folders; this instance's disk is its memory."""
    try:
        folders = sorted(PROJECTS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    except FileNotFoundError:
        return
    for old in folders[MAX_PROJECTS:]:
        if lock_for(old.name).acquire(blocking=False):
            try:
                shutil.rmtree(old, ignore_errors=True)
            finally:
                lock_for(old.name).release()


def compile_job(job):
    """The PDF, the log and latexmk's exit code for a job's files; in the project's kept folder when it names one."""
    project = job.get('project')
    if project is None:
        work = pathlib.Path(tempfile.mkdtemp(prefix='job-'))
        try:
            return compile_in(work, job, keep=False)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    if not isinstance(project, str) or not re.fullmatch(r'[a-f0-9]{32,64}', project):
        raise ValueError('the project')
    PROJECTS.mkdir(exist_ok=True)
    with lock_for(project):
        work = PROJECTS / project
        result = compile_in(work, job, keep=True)
    forget_old_projects()
    return result


def compile_in(work, job, keep):
    main = clean_path(job.get('main') or 'main.tex')
    flag = job.get('flag') if job.get('flag') in FLAGS else '-pdf'
    if not main.endswith('.tex'):
        raise ValueError('the main file')
    work.mkdir(exist_ok=True)
    src = (work / 'src').resolve()
    state = json.loads((work / 'state.json').read_text()) if keep and (work / 'state.json').exists() else {'files': {}, 'flag': None}
    src.mkdir(exist_ok=True)
    if job.get('fresh'):
        # From scratch: TeX's own files (.aux, .bbl, the PDF) go, the paper's stay.
        for made in [p for p in src.rglob('*') if p.is_file() and str(p.relative_to(src)) not in state['files']]:
            made.unlink(missing_ok=True)
        state['flag'] = None
    cached = state.get('flag') is not None
    user = as_user()
    known = state['files']
    for f in job.get('files') or []:
        path = clean_path(f['path'])
        target = (src / path).resolve()
        if src not in target.parents:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(f['base64']))
        known[path] = hashlib.sha256(f['base64'].encode()).hexdigest()
    manifest = job.get('manifest')
    if keep and isinstance(manifest, dict):
        wanted = {clean_path(path): str(sha) for path, sha in manifest.items()}
        for gone in [path for path in known if path not in wanted]:
            (src / gone).unlink(missing_ok=True)
            del known[gone]
        need = [path for path, sha in wanted.items() if known.get(path) != sha]
        (work / 'state.json').write_text(json.dumps(state))
        if need:
            raise NeedFiles(need)
    if user:
        for path in [work, *work.rglob('*')]:
            os.chown(path, user['user'], user['group'])
    # Written beside the main file (-cd), as openout_any=p lets TeX write nowhere else.
    out = (src / main).parent
    # latexmk decides what to rerun from what changed; -g makes it do all, when the engine changed or nothing is kept.
    again = ['-g'] if not keep or state.get('flag') != flag else []
    command = [LATEXMK, flag, '-cd', *again, '-f', '-interaction=nonstopmode', '-file-line-error', '-jobname=output', main]
    started = time.monotonic()
    with open(work / 'stdout.txt', 'wb') as stdout:
        process = subprocess.Popen(command, cwd=src, env=CLEAN_ENV, stdout=stdout, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True, **user)
        try:
            code = process.wait(timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            stdout.write(f'\nStopped: it took longer than {TIMEOUT_S} seconds.\n'.encode())
            code = 124
    seconds = round(time.monotonic() - started, 2)
    state['flag'] = flag
    if keep:
        (work / 'state.json').write_text(json.dumps(state))
        os.utime(work)
    pdf = out / 'output.pdf'
    log = ''.join(p.read_text(errors='replace') for p in (out / 'output.log', work / 'stdout.txt') if p.exists())
    return {'pdf': base64.b64encode(pdf.read_bytes()).decode() if pdf.exists() else '', 'log': log[-400_000:], 'exit': code, 'seconds': seconds, 'cached': bool(cached)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'reader-latex'
    sys_version = ''

    def answer(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.answer(200, {'ok': True}) if self.path == '/' else self.answer(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/compile':
            return self.answer(404, {'error': 'not found'})
        given = self.headers.get('Authorization', '').removeprefix('Bearer ').strip()
        if not TOKEN or not hmac.compare_digest(given.encode(), TOKEN.encode()):
            return self.answer(401, {'error': 'not the Worker'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self.answer(413, {'error': 'a JSON body, 30 MB at most'})
        try:
            job = json.loads(self.rfile.read(length))
            result = compile_job(job)
        except NeedFiles as missing:
            return self.answer(409, {'need': missing.need})
        except (ValueError, KeyError, TypeError) as error:
            return self.answer(400, {'error': f'not a job: {error}'})
        self.answer(200, result)

    def log_message(self, format, *args):
        # The method, path and status only: never anything of a paper.
        sys.stderr.write('%s %s\n' % (self.command, args[1] if len(args) > 1 else ''))


if __name__ == '__main__':
    if not TOKEN:
        sys.stderr.write('LATEX_TOKEN is not set: every compile will be refused\n')
    ThreadingHTTPServer(('', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
