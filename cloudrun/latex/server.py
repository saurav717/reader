"""Reader's LaTeX compiler on Google Cloud Run (worker/latex.js calls it).

POST /compile, with the Worker's secret as a bearer token and JSON
{main, flag, files: [{path, base64}]}, compiles the files with latexmk and all
of TeX Live and answers {pdf: base64 or '', synctex: base64 of the gzipped
SyncTeX or '', log, exit, seconds}: SyncTeX takes a double-click on the PDF
to its source line, as Overleaf's does.

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
can't read), restricted shell escape only (TeX Live's default, as Overleaf's:
the few tools texmf.cnf lists as safe, such as repstopdf for .eps figures),
kpathsea told to open no absolute or dotted paths (openin_any=p), and a time
limit.

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
# A double-click's map from the PDF to its source: handed back up to this size (gzipped).
MAX_SYNCTEX = 8 * 1024 * 1024
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
    # XeLaTeX's and LuaLaTeX's font caches, built into the image (Dockerfile) rather than by each new instance's first compile.
    **({'TEXMFVAR': os.environ['TEXMFVAR']} if os.environ.get('TEXMFVAR') else {}),
    'openin_any': 'p',
    'openout_any': 'p',
    'shell_escape': 'p',
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
    command = [LATEXMK, flag, '-cd', *again, '-f', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-jobname=output', main]
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
    synctex = out / 'output.synctex.gz'
    log = ''.join(p.read_text(errors='replace') for p in (out / 'output.log', work / 'stdout.txt') if p.exists())
    return {'pdf': base64.b64encode(pdf.read_bytes()).decode() if pdf.exists() else '',
            'synctex': base64.b64encode(synctex.read_bytes()).decode() if pdf.exists() and synctex.exists() and synctex.stat().st_size <= MAX_SYNCTEX else '',
            'log': log[-400_000:], 'exit': code, 'seconds': seconds, 'cached': bool(cached)}


# ------------------------------------------------------------ Overleaf --
# A paper kept in Drive, in step with Overleaf (src/lib/overleafCloud.ts): the
# project cloned afresh into a folder of its own, what changed in Drive since the
# last sync committed on top of that sync's commit, merged with what Overleaf has
# now, pushed — and the files the page lacks handed back. Nothing kept after.

GIT_REMOTE = re.compile(r'^https://(git\.overleaf\.com/[A-Za-z0-9]+|github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(\.git)?/?$')
GIT_TIMEOUT_S = 120
# Local repositories never: a paper's sync reaches Overleaf or GitHub over HTTPS only (a test sets this to 'always').
GIT_FILE_PROTOCOL = 'never'


class GitRefused(Exception):
    def __init__(self, message, status=400, need_token=False):
        super().__init__(message)
        self.status = status
        self.need_token = need_token


BUILD_FILE = re.compile(r'\.(aux|log|fls|fdb_latexmk|synctex\.gz|synctex|out|toc|lof|lot|bbl|blg|bcf|run\.xml|nav|snm|vrb|xdv|dvi)$', re.I)


def find_commit(git, tree, depth=300):
    """The most recent commit whose files are exactly `tree` ({path: Git blob id}), or None."""
    if not isinstance(tree, dict) or not tree:
        return None
    wanted = {str(path): str(blob) for path, blob in tree.items()}
    for commit in git('rev-list', '-n', str(depth), 'HEAD').stdout.split():
        listed = {}
        for line in git('ls-tree', '-r', '-z', commit).stdout.split('\0'):
            if '\t' in line:
                meta, path = line.split('\t', 1)
                listed[path] = meta.split()[2]
        # The Drive copy left out dot-files and what compiling leaves (src/lib/overleaf.ts isBuildFile): so may the commit.
        kept = {path: blob for path, blob in listed.items() if not (any(part.startswith('.') for part in path.split('/')) or BUILD_FILE.search(path))}
        if kept == wanted:
            return commit
    return None


def git_check(job):
    """Whether `token` opens the project at `url`: `git ls-remote`, nothing cloned. Refused (401) when it can't."""
    url = str(job.get('url') or '')
    token = str(job.get('token') or '')
    if not GIT_REMOTE.match(url):
        raise GitRefused('Only an Overleaf Git address (https://git.overleaf.com/…) or a GitHub repository.')
    if not token:
        raise GitRefused('No Overleaf Git token.', 401, need_token=True)
    user = 'x-access-token' if 'github.com' in url else 'git'
    auth = base64.b64encode(f'{user}:{token}'.encode()).decode()
    work = pathlib.Path(tempfile.mkdtemp(prefix='git-'))
    env = {'PATH': CLEAN_ENV['PATH'], 'HOME': str(work), 'GIT_TERMINAL_PROMPT': '0', 'LANG': 'C.UTF-8'}
    try:
        done = subprocess.run(
            ['git', '-c', f'http.extraHeader=Authorization: Basic {auth}', '-c', f'protocol.file.allow={GIT_FILE_PROTOCOL}', 'ls-remote', '--heads', url],
            cwd=str(work), env=env, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
        if done.returncode == 0:
            return {'ok': True}
        text = ((done.stderr or '') + (done.stdout or '')).replace(token, '•••').replace(auth, '•••').strip()[-600:]
        if re.search(r'401|403|404|Authentication failed|could not read Username|invalid credentials|not found|does not exist|access rights', text, re.I):
            raise GitRefused('This token can’t open that Overleaf project: it is another account’s token, or the project isn’t this account’s or shared with it.', 401, need_token=True)
        raise GitRefused(f'git couldn\'t reach the project: {text}', 502)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def git_files(job):
    """The project's files at its latest commit, as base64, and that commit: nothing merged or pushed."""
    url = str(job.get('url') or '')
    token = str(job.get('token') or '')
    if not GIT_REMOTE.match(url):
        raise GitRefused('Only an Overleaf Git address (https://git.overleaf.com/…) or a GitHub repository.')
    if not token:
        raise GitRefused('No Overleaf Git token.', 401, need_token=True)
    user = 'x-access-token' if 'github.com' in url else 'git'
    auth = base64.b64encode(f'{user}:{token}'.encode()).decode()
    work = pathlib.Path(tempfile.mkdtemp(prefix='git-'))
    repo = work / 'repo'
    env = {'PATH': CLEAN_ENV['PATH'], 'HOME': str(work), 'GIT_TERMINAL_PROMPT': '0', 'LANG': 'C.UTF-8'}
    try:
        cloned = subprocess.run(
            ['git', '-c', f'http.extraHeader=Authorization: Basic {auth}', '-c', 'core.hooksPath=/dev/null', '-c', f'protocol.file.allow={GIT_FILE_PROTOCOL}', 'clone', '-q', '--depth', '1', url, str(repo)],
            cwd=str(work), env=env, capture_output=True, text=True, timeout=GIT_TIMEOUT_S, stdin=subprocess.DEVNULL)
        if cloned.returncode != 0:
            text = ((cloned.stderr or '') + (cloned.stdout or '')).replace(token, '•••').replace(auth, '•••').strip()[-600:]
            if re.search(r'401|403|Authentication failed|could not read Username|invalid credentials', text, re.I):
                raise GitRefused('Overleaf refused the Git token: generate another (Account Settings → Git integration) and give it again.', 401, need_token=True)
            raise GitRefused(f'git couldn\'t clone the project: {text}', 502)
        commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=str(repo), env=env, capture_output=True, text=True, timeout=30).stdout.strip()
        listed = subprocess.run(['git', '-c', 'core.quotepath=off', 'ls-files', '-z'], cwd=str(repo), env=env, capture_output=True, text=True, timeout=30).stdout
        files, size = [], 0
        for path in (p for p in listed.split('\0') if p):
            target = repo / path
            if not target.is_file():
                continue
            data = base64.b64encode(target.read_bytes()).decode()
            size += len(data)
            if size > MAX_BODY:
                raise GitRefused('The Overleaf project is too big to compare here (over 30 MB).', 413)
            files.append({'path': path, 'base64': data, 'sha': hashlib.sha256(data.encode()).hexdigest()})
        return {'ok': True, 'commit': commit, 'files': files}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def git_sync(job):
    url = str(job.get('url') or '')
    token = str(job.get('token') or '')
    if not GIT_REMOTE.match(url):
        raise GitRefused('Only an Overleaf Git address (https://git.overleaf.com/…) or a GitHub repository.')
    if not token:
        raise GitRefused('No Overleaf Git token.', 401, need_token=True)
    user = 'x-access-token' if 'github.com' in url else 'git'
    auth = base64.b64encode(f'{user}:{token}'.encode()).decode()
    work = pathlib.Path(tempfile.mkdtemp(prefix='git-'))
    repo = work / 'repo'
    env = {'PATH': CLEAN_ENV['PATH'], 'HOME': str(work), 'GIT_TERMINAL_PROMPT': '0', 'LANG': 'C.UTF-8'}

    def said(done):
        return ((done.stderr or '') + (done.stdout or '')).replace(token, '•••').replace(auth, '•••').strip()[-600:]

    def git(*args, cwd=repo, check=False):
        done = subprocess.run(
            ['git', '-c', f'http.extraHeader=Authorization: Basic {auth}', '-c', 'core.hooksPath=/dev/null', '-c', f'protocol.file.allow={GIT_FILE_PROTOCOL}',
             '-c', 'user.name=Reader', '-c', 'user.email=reader@localhost', '-c', 'core.quotepath=off', *args],
            cwd=str(cwd), env=env, capture_output=True, text=True, timeout=GIT_TIMEOUT_S, stdin=subprocess.DEVNULL)
        if check and done.returncode != 0:
            raise GitRefused(f'git {args[0]}: {said(done)}', 502)
        return done

    def blob(commit, path):
        done = subprocess.run(['git', 'show', f'{commit}:{path}'], cwd=str(repo), env=env, capture_output=True, timeout=GIT_TIMEOUT_S)
        return done.stdout

    try:
        cloned = git('clone', '-q', url, str(repo), cwd=work)
        if cloned.returncode != 0:
            text = said(cloned)
            if re.search(r'401|403|Authentication failed|could not read Username|invalid credentials', text, re.I):
                raise GitRefused('Overleaf refused the Git token: generate another (Account Settings → Git integration) and give it again.', 401, need_token=True)
            raise GitRefused(f'git couldn\'t clone the project: {text}', 502)
        branch = git('rev-parse', '--abbrev-ref', 'HEAD', check=True).stdout.strip()
        theirs = git('rev-parse', 'HEAD', check=True).stdout.strip()
        base = str(job.get('base') or '')
        if not re.fullmatch(r'[0-9a-f]{7,40}', base) or git('cat-file', '-e', f'{base}^{{commit}}').returncode != 0:
            # A paper moved into Drive from a clone on a computer: no commit yet, but its files' Git ids at the
            # move (baseTree). The commit that had exactly those files is where Drive's changes start from.
            base = find_commit(git, job.get('baseTree')) or theirs
        # What changed in Drive since the last sync, as a commit on top of it.
        git('checkout', '-q', '-b', 'reader', base, check=True)
        root = repo.resolve()
        for f in job.get('changed') or []:
            target = (root / clean_path(f['path'])).resolve()
            if root not in target.parents or '.git' in target.relative_to(root).parts:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(f['base64']))
        for path in job.get('deleted') or []:
            target = (root / clean_path(path)).resolve()
            if root in target.parents and target.is_file():
                target.unlink()
        git('add', '-A', check=True)
        committed = git('diff', '--cached', '--quiet').returncode == 1
        if committed:
            git('commit', '-q', '-m', str(job.get('message') or 'Edits from Reader')[:200], check=True)
        # Then what Overleaf has now, merged in.
        git('checkout', '-q', branch, check=True)
        merged = git('merge', '--no-edit', '-q', 'reader')
        conflicts = [line for line in git('diff', '--name-only', '--diff-filter=U').stdout.splitlines() if line.strip()]
        pushed = False
        if merged.returncode != 0 and not conflicts:
            raise GitRefused(f'git couldn\'t merge: {said(merged)}', 502)
        if conflicts:
            # Nothing pushed: the page gets the files as merged, marks and all, and goes on from Overleaf's commit.
            commit = theirs
        else:
            commit = git('rev-parse', 'HEAD', check=True).stdout.strip()
            if commit != theirs:
                done = git('push', '-q', 'origin', f'HEAD:{branch}')
                if done.returncode != 0:
                    raise GitRefused(f'git couldn\'t push to Overleaf: {said(done)}', 502)
                pushed = True
        # The files the page lacks, and those it has that are gone.
        manifest = job.get('manifest') or {}
        files, present = [], set()
        for path in (p for p in git('ls-files', '-co', '--exclude-standard', '-z').stdout.split('\0') if p):
            target = root / path
            if not target.is_file():
                continue
            present.add(path)
            data = base64.b64encode(target.read_bytes()).decode()
            if manifest.get(path) != hashlib.sha256(data.encode()).hexdigest():
                files.append({'path': path, 'base64': data})
        deleted = [path for path in manifest if path not in present]
        # The files at the commit the next sync goes on from: what it compares Drive against.
        tree = {}
        for path in (p for p in git('ls-tree', '-r', '--name-only', '-z', commit).stdout.split('\0') if p):
            tree[path] = hashlib.sha256(base64.b64encode(blob(commit, path))).hexdigest()
        return {'ok': not conflicts, 'commit': commit, 'committed': committed, 'pushed': pushed, 'files': files, 'deleted': deleted, 'conflicts': conflicts, 'tree': tree}
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ------------------------------------------------------------ warming --
# A new instance has TeX Live in its image but none of it read yet: Cloud Run
# fetches an image's files as they are first opened, so the first compile used
# to spend most of its time on the formats, the packages and the fonts — the
# page's wake-up (GET /) only started Python. Now the instance compiles a small
# paper of the usual packages as it starts, and GET / answers once that's done.

WARM_TEX = r'''\documentclass{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern,amsmath,amssymb,amsthm,mathtools,graphicx,xcolor,geometry,booktabs,hyperref,cleveref,natbib,tikz,pgfplots,float,caption,subcaption,enumitem,listings,algorithm,algpseudocode}
\usepackage[english,spanish]{babel}
\begin{document}
\section{Warm}
Warm \textbf{text} \emph{here}, $\int_0^1 x^2\,dx = \frac{1}{3}$ \cite{x}.
\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}
\bibliographystyle{plain}
\begin{thebibliography}{1}\bibitem{x} X.\end{thebibliography}
\end{document}
'''
WARM_S = int(os.environ.get('LATEX_WARM_S', '90'))
WARMED = threading.Event()


def warm():
    """Reads what nearly every compile reads (each engine's format, the usual packages and fonts), once per instance."""
    work = pathlib.Path(tempfile.mkdtemp(prefix='warm-'))
    try:
        for engine, fmt in (('pdftex', 'pdflatex.fmt'), ('xetex', 'xelatex.fmt'), ('luahbtex', 'lualatex.fmt')):
            found = subprocess.run(['kpsewhich', f'-engine={engine}', fmt], env=CLEAN_ENV, capture_output=True, text=True, timeout=20).stdout.strip()
            if found:
                with open(found, 'rb') as f:
                    while f.read(1 << 20):
                        pass
        (work / 'warm.tex').write_text(WARM_TEX)
        user = as_user()
        if user:
            for path in [work, *work.rglob('*')]:
                os.chown(path, user['user'], user['group'])
        # A package the image lacks only means less is warmed: -f goes on past it.
        process = subprocess.Popen([LATEXMK, '-pdf', '-f', '-interaction=batchmode', 'warm.tex'], cwd=work, env=CLEAN_ENV,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True, **user)
        try:
            process.wait(timeout=WARM_S)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        shutil.rmtree(work, ignore_errors=True)
        WARMED.set()


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
        if self.path != '/':
            return self.answer(404, {'error': 'not found'})
        # The page's wake-up: answered once TeX Live is warm (or after 50 s), so the request keeps the instance's CPU while it warms.
        self.answer(200, {'ok': True, 'warm': WARMED.wait(50)})

    def do_POST(self):
        if self.path not in ('/compile', '/git/sync', '/git/check', '/git/files'):
            return self.answer(404, {'error': 'not found'})
        given = self.headers.get('Authorization', '').removeprefix('Bearer ').strip()
        if not TOKEN or not hmac.compare_digest(given.encode(), TOKEN.encode()):
            return self.answer(401, {'error': 'not the Worker'})
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self.answer(413, {'error': 'a JSON body, 30 MB at most'})
        if self.path in ('/git/sync', '/git/check', '/git/files'):
            try:
                return self.answer(200, {'/git/sync': git_sync, '/git/check': git_check, '/git/files': git_files}[self.path](json.loads(self.rfile.read(length))))
            except GitRefused as refused:
                return self.answer(refused.status, {'error': str(refused), 'needToken': refused.need_token})
            except (ValueError, KeyError, TypeError) as error:
                return self.answer(400, {'error': f'not a sync: {error}'})
            except subprocess.TimeoutExpired:
                return self.answer(504, {'error': 'Overleaf took too long to answer.'})
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
    threading.Thread(target=warm, daemon=True).start()
    ThreadingHTTPServer(('', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
