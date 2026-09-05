"""Finding the interpreter that can align, and driving it from one that cannot.

The aligner needs torch and whisperx. narrator's own interpreters do not have
them and must not grow them: `assemble` runs on a CPU env the reassembly bridge
spawns with `--tts_engine xtts`, and the Orpheus envs are pinned to torch 2.5.1
/ vLLM 0.7.3, which whisperx's torch 2.8 stack cannot coexist with. BookForge
already ships the right interpreter as a managed component -
`electron/components/whisperx-env.ts`, "Ebook Alignment (WhisperX)", CPU-only by
design - and `electron/scripts/align_audiobook.py` is spawned with it today.

So there are two ways to run an alignment and they are the SAME CODE:

  IN PROCESS   `narrator align` under the whisperx interpreter imports whisperx
               directly. This is what the CLI does when nothing says otherwise.
  OUT OF PROCESS  `--python <that interpreter>` spawns
               `python -m narrator.align.worker` there, over a JSON-lines
               protocol, with `PYTHONPATH` pointed at THIS checkout so the same
               narrator code runs on both sides. Nothing is installed; nothing
               is copied.

NO SILENT ROUTING. An interpreter that cannot import the backend and was given
no `--python` REFUSES, and the refusal names the interpreter it found on disk so
the operator can paste it back. Guessing which interpreter to spawn would make a
CPU-only add-on a hidden dependency of a command that appeared to run locally.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from typing import Optional, Sequence

#: An explicit "align with this interpreter", for a machine whose component
#: lives somewhere unusual.
ALIGN_PYTHON_ENV = 'NARRATOR_ALIGN_PYTHON'
#: The whisperx component's own "point at an existing env" variable
#: (`whisperx-env.ts`, `detect.envVar`).
WHISPERX_ENV_PATH = 'WHISPERX_ENV_PATH'
#: Where torch keeps the wav2vec2 align checkpoint (~378 MB). BookForge manages
#: one at `<userData>/runtime/whisperx-cache` and points TORCH_HOME at it
#: (`electron/whisperx-align-bridge.ts`); reusing it means the aligner downloads
#: nothing that BookForge has already fetched.
TORCH_HOME_ENV = 'TORCH_HOME'


def package_root() -> str:
    """The directory that must be on `PYTHONPATH` for `import narrator` to work
    - this checkout's `python/`, derived from this file, never guessed."""
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))))


def _python_in(env_root: str) -> str:
    if sys.platform == 'win32':
        return os.path.join(env_root, 'python.exe')
    return os.path.join(env_root, 'bin', 'python')


def managed_whisperx_root() -> Optional[str]:
    """BookForge's installed whisperx-env component directory, if it is there.

    The same path `electron/components/component-manager` installs into:
    `<userData>/components/whisperx-env`. userData is `%APPDATA%/BookForge` on
    Windows and `~/Library/Application Support/BookForge` on macOS.
    """
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA')
        if not base:
            return None
        root = os.path.join(base, 'BookForge', 'components', 'whisperx-env')
    elif sys.platform == 'darwin':
        root = os.path.expanduser(
            '~/Library/Application Support/BookForge/components/whisperx-env')
    else:
        return None
    return root if os.path.isdir(root) else None


def managed_torch_home() -> Optional[str]:
    """BookForge's managed torch cache, if it is there."""
    if sys.platform == 'win32':
        base = os.environ.get('APPDATA')
        if not base:
            return None
        home = os.path.join(base, 'BookForge', 'runtime', 'whisperx-cache')
    elif sys.platform == 'darwin':
        home = os.path.expanduser(
            '~/Library/Application Support/BookForge/runtime/whisperx-cache')
    else:
        return None
    return home if os.path.isdir(home) else None


def discover_align_python() -> Optional[str]:
    """An interpreter that probably has whisperx, or None. Never spawned by
    accident: the CLI only uses this to NAME one in a refusal."""
    explicit = (os.environ.get(ALIGN_PYTHON_ENV) or '').strip()
    if explicit:
        return explicit
    pointed = (os.environ.get(WHISPERX_ENV_PATH) or '').strip()
    if pointed:
        return _python_in(pointed)
    root = managed_whisperx_root()
    if root:
        candidate = _python_in(root)
        if os.path.isfile(candidate):
            return candidate
    return None


#: The module each backend needs importable. One row, because one aligner ships.
BACKEND_MODULES = {'whisperx': 'whisperx'}


def backend_importable(backend: str) -> bool:
    """True when THIS interpreter can run `backend` without spawning anything.

    ONLY `ImportError` means "not here". Anything else - a DLL load failure, a
    torch/numpy ABI mismatch, both live hazards in this stack - is a whisperx
    that IS installed and IS broken, and reporting that as "this interpreter
    cannot import the backend, pass --python" sends the operator looking for the
    wrong thing entirely (review finding 6). It goes up.
    """
    module = BACKEND_MODULES.get(backend)
    if module is None:
        raise ValueError(
            f'unknown alignment backend {backend!r}; known: '
            f'{", ".join(sorted(BACKEND_MODULES))}')
    try:
        __import__(module)
    except ImportError:
        return False
    return True


def worker_environment(base: Optional[dict] = None) -> dict:
    """The environment a spawned worker needs: this checkout on `PYTHONPATH`,
    and BookForge's torch cache when there is one."""
    env = dict(os.environ if base is None else base)
    root = package_root()
    existing = env.get('PYTHONPATH')
    env['PYTHONPATH'] = (root + os.pathsep + existing) if existing else root
    env.setdefault('PYTHONIOENCODING', 'utf-8')
    # `TOKENIZERS_PARALLELISM` off for the same reason the align bridge sets it:
    # a forked tokenizer pool warns on every chunk and buys nothing here.
    env.setdefault('TOKENIZERS_PARALLELISM', 'false')
    if TORCH_HOME_ENV not in env:
        home = managed_torch_home()
        if home:
            env[TORCH_HOME_ENV] = home
    return env


def run_jobs(python_exe: str, jobs: Sequence[dict],
             timeout: Optional[float] = None,
             on_result=None) -> list:
    """Align `jobs` in `python_exe` and return one result document each.

    One process for the whole list, because loading the align model costs
    ~5.6 s warm and a book is hundreds of chunks. The protocol is
    `align/worker.py`'s: one JSON job per line in, one JSON result per line out,
    in order.

    `on_result(done, total)` IS CALLED AS EACH RESULT ARRIVES, which is why this
    streams instead of calling `subprocess.run`. It was a single blocking call
    until BookForge grew an Align queue row: a book is hundreds of chunks and
    minutes of CPU, and a row that cannot say how far it has got is a row a user
    reads as hung. The results are still returned as one list, in order, and the
    two refusals below are unchanged - this only stops the caller having to wait
    for the last chunk to learn about the first.

    STDERR GOES TO A TEMPORARY FILE rather than a second pipe. Reading one pipe
    while the child writes to another is the classic deadlock: the worker prints
    a model-load line and a per-failure line to stderr, and a full stderr buffer
    would stop it writing the stdout this loop is waiting on. A file has no such
    limit, and it is read once at the end for the message.
    """
    if not os.path.isfile(python_exe):
        raise FileNotFoundError(
            f'align interpreter {python_exe} does not exist; pass --python with '
            f'the whisperx env\'s python, or install "Ebook Alignment '
            f'(WhisperX)" from Settings -> Add-ons')
    payload = '\n'.join(json.dumps(job) for job in jobs) + '\n'
    results: list = []
    with tempfile.TemporaryFile() as errfile:
        proc = subprocess.Popen(
            [python_exe, '-m', 'narrator.align.worker'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errfile,
            env=worker_environment(),
        )
        try:
            # The whole job list is written up front, as it always was: the
            # worker reads stdin to EOF and a chunk of JSON lines is kilobytes,
            # far inside the pipe buffer for any book. Closing stdin is what
            # ends the worker's loop.
            proc.stdin.write(payload.encode('utf-8'))
            proc.stdin.close()
            for line in proc.stdout:
                text = line.decode('utf-8', 'replace').strip()
                if not text:
                    continue
                results.append(json.loads(text))
                if on_result is not None:
                    on_result(len(results), len(jobs))
            proc.wait(timeout=timeout)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        finally:
            proc.stdout.close()
        errfile.seek(0)
        stderr = errfile.read().decode('utf-8', 'replace').strip()[-800:]

    if proc.returncode != 0 and len(results) != len(jobs):
        raise RuntimeError(
            f'the align worker in {python_exe} exited {proc.returncode} after '
            f'{len(results)} of {len(jobs)} job(s): {stderr}')
    if len(results) != len(jobs):
        raise RuntimeError(
            f'the align worker in {python_exe} returned {len(results)} result(s) '
            f'for {len(jobs)} job(s); stderr: {stderr}')
    return results
