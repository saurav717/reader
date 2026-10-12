"""Reader's LaTeX compiler on Google Cloud Run (worker/latex.js calls it).

POST /compile, with the Worker's secret as a bearer token and JSON
{main, flag, files: [{path, base64}]}, compiles the files with latexmk and all
of TeX Live and answers {pdf: base64 or '', log, exit}. Nothing is kept: each
compile is in a folder of its own, removed once it has answered, and nothing
of a paper is logged.

A paper is someone else's TeX, so it is compiled as an unprivileged user with
a clean environment (the secret is only in this process's, which that user
can't read), no shell escape, kpathsea told to open no absolute or dotted
paths (openin_any=p), and a time limit.

    LATEX_TOKEN   the secret the Worker sends (LATEX_CLOUD_RUN_TOKEN there)
    PORT          set by Cloud Run
"""

import base64
import hmac
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get('LATEX_TOKEN', '').strip()
MAX_BODY = 30 * 1024 * 1024
TIMEOUT_S = int(os.environ.get('LATEX_TIMEOUT_S', '240'))
FLAGS = {'-pdf', '-xelatex', '-lualatex', '-pdfdvi'}
USER = os.environ.get('LATEX_USER', 'tex')
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


def compile_job(job):
    """The PDF, the log and latexmk's exit code for a job's files."""
    main = str(job.get('main') or 'main.tex').lstrip('/')
    flag = job.get('flag') if job.get('flag') in FLAGS else '-pdf'
    if not main.endswith('.tex') or '..' in main.split('/'):
        raise ValueError('the main file')
    work = pathlib.Path(tempfile.mkdtemp(prefix='job-'))
    try:
        src = (work / 'src').resolve()
        src.mkdir()
        for f in job.get('files') or []:
            target = (src / str(f['path']).lstrip('/')).resolve()
            if src not in target.parents:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(f['base64']))
        user = as_user()
        if user:
            for path in [work, *work.rglob('*')]:
                os.chown(path, user['user'], user['group'])
        # Written beside the main file (-cd), as openout_any=p lets TeX write nowhere else.
        out = (src / main).parent
        command = [LATEXMK, flag, '-cd', '-g', '-f', '-interaction=nonstopmode', '-file-line-error', '-jobname=output', main]
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
        pdf = out / 'output.pdf'
        log = ''.join(p.read_text(errors='replace') for p in (out / 'output.log', work / 'stdout.txt') if p.exists())
        seconds = round(time.monotonic() - started, 2)
        return {'pdf': base64.b64encode(pdf.read_bytes()).decode() if pdf.exists() else '', 'log': log[-400_000:], 'exit': code, 'seconds': seconds}
    finally:
        shutil.rmtree(work, ignore_errors=True)


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
