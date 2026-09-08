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

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import threading
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


#: The two variables torch reads for its CPU intra-op thread pool (OpenMP and
#: MKL). Named here because the POOL has to divide them: N aligner processes
#: that each open `cpu_count()` intra-op threads oversubscribe the machine and
#: spend the win on context switches.
THREAD_ENV_VARS = ('OMP_NUM_THREADS', 'MKL_NUM_THREADS')


def worker_environment(base: Optional[dict] = None,
                       threads: Optional[int] = None) -> dict:
    """The environment a spawned worker needs: this checkout on `PYTHONPATH`,
    and BookForge's torch cache when there is one.

    `threads` is the intra-op thread budget for ONE worker of a pool - see
    `run_jobs`. It is applied with `setdefault`, so AN EXPLICIT VALUE IN THE
    CALLER'S ENVIRONMENT WINS: an operator who exported `OMP_NUM_THREADS`
    already decided how much of this machine the aligner may have, and a pool
    dividing `cpu_count()` behind their back would be this module overruling
    them. None (the single-worker route) touches neither variable at all, which
    is what the app has always run.
    """
    env = dict(os.environ if base is None else base)
    root = package_root()
    existing = env.get('PYTHONPATH')
    env['PYTHONPATH'] = (root + os.pathsep + existing) if existing else root
    env.setdefault('PYTHONIOENCODING', 'utf-8')
    # `TOKENIZERS_PARALLELISM` off for the same reason the align bridge sets it:
    # a forked tokenizer pool warns on every chunk and buys nothing here.
    env.setdefault('TOKENIZERS_PARALLELISM', 'false')
    if threads is not None:
        for name in THREAD_ENV_VARS:
            env.setdefault(name, str(int(threads)))
    if TORCH_HOME_ENV not in env:
        home = managed_torch_home()
        if home:
            env[TORCH_HOME_ENV] = home
    return env


def _worker_name(number: int, pool: int, python_exe: str) -> str:
    """How a refusal names the worker it is about.

    A pool of one keeps the wording it has always had ("the align worker in
    <python>"), because that route is unchanged and its messages are what an
    operator has seen in every job log so far. A real pool says WHICH process
    died - "align worker 2 of 4" - since "the align worker exited 1" tells
    nobody which quarter of the book is missing.
    """
    if pool == 1:
        return f'the align worker in {python_exe}'
    return f'align worker {number} of {pool} in {python_exe}'


def run_jobs(python_exe: str, jobs: Sequence[dict],
             timeout: Optional[float] = None,
             on_result=None, workers: int = 1) -> list:
    """Align `jobs` in `python_exe` and return one result document each.

    One process PER WORKER for the whole list, because loading the align model
    costs ~5.6 s warm and a book is hundreds of chunks. The protocol is
    `align/worker.py`'s: one JSON job per line in, one JSON result per line out,
    in order.

    `on_result(done, total)` IS CALLED AS EACH RESULT ARRIVES, which is why this
    streams instead of calling `subprocess.run`. It was a single blocking call
    until BookForge grew an Align queue row: a book is hundreds of chunks and
    minutes of CPU, and a row that cannot say how far it has got is a row a user
    reads as hung. The results are still returned as one list, in JOB order, and
    the two refusals below are unchanged - this only stops the caller having to
    wait for the last chunk to learn about the first.

    THE POOL (2026-09-08). Owen, on the Shift book: "align is taking way too
    long... 3x slower than the TTS render. we have to find a more efficient way
    of handling this." MEASURED there: 11.4 chunks/min, 115 min for a book whose
    37-minute render produced it (RTF ~0.08 on a 10-core / 20-thread i9-10900K,
    sharing the CPU with the assembly encode) - one process, one model, one
    chunk at a time. `workers` N spawns N of the SAME worker module and deals
    the jobs ROUND-ROBIN (job i to worker i % N), so a run of long chunks and a
    run of headings spread across the pool instead of loading one process with
    the whole slow half of the book. Each worker keeps its own stdin/stderr
    temp files and its own stdout reader thread - the reasoning below is per
    worker and unchanged.

    `workers=1` IS THE OLD ROUTE, byte for byte: one process, one payload, and
    NOTHING said about thread counts. It is the default until the pool is
    measured on a free CPU.

    THREAD OVERSUBSCRIPTION is the way a pool goes slower than one process:
    torch on CPU already opens `cpu_count()` intra-op threads, so N workers ask
    for N x the machine. Each worker of a pool therefore gets
    `cpu_count() // N` (at least 1) in `OMP_NUM_THREADS` / `MKL_NUM_THREADS` -
    unless the caller's environment already names them, which is a decision
    already made (see `worker_environment`).

    ONLY STDOUT IS A PIPE. `subprocess.run(input=...)` fed stdin and drained
    both output streams with `communicate()`, which juggles all three with
    select/threads; a loop that reads ONE pipe while the child writes to the
    other two deadlocks, and both other streams would reach the buffer:

      stdin   a book's job list is ~500 bytes a chunk, so 1,400 chunks is ~700 kB
              against a 64 kB pipe. Writing it inline would block this process
              part-way, while the worker - having read the first 64 kB - fills
              its own stdout buffer with alignments nobody is reading. Neither
              side moves again.
      stderr  the worker prints a model-load line and a line per failed chunk. A
              full stderr buffer stops it writing the stdout this loop waits on.

    So both are TEMPORARY FILES, which have no such limit: the payload is written
    and rewound before the child starts (it reads to EOF and stops, exactly as it
    did when `communicate()` closed the pipe), and stderr is read once at the end
    for the message. A POOL MAKES THAT ARGUMENT STRONGER, not weaker: N children
    writing into one parent's single reading loop is exactly the deadlock above,
    which is why each child gets its own files and its own thread.
    """
    if not os.path.isfile(python_exe):
        raise FileNotFoundError(
            f'align interpreter {python_exe} does not exist; pass --python with '
            f'the whisperx env\'s python, or install "Ebook Alignment '
            f'(WhisperX)" from Settings -> Add-ons')
    if isinstance(workers, bool) or not isinstance(workers, int) or workers < 1:
        raise ValueError(
            f'run_jobs: workers must be a whole number of processes, 1 or more; '
            f'got {workers!r}')
    jobs = list(jobs)
    if not jobs:
        return []

    # More processes than chunks would spawn a worker to load a 378 MB model and
    # align nothing. The POOL SIZE the thread budget is divided by is the number
    # that actually runs, so a 3-chunk book asked to use 8 workers runs 3 - and a
    # pool that collapses to one leaves the thread variables alone, exactly as
    # the single-worker route does.
    pool = min(workers, len(jobs))
    deals: list = [[] for _ in range(pool)]
    for position, job in enumerate(jobs):
        deals[position % pool].append((position, job))
    threads_each = None if pool == 1 else max(1, (os.cpu_count() or 1) // pool)

    results: list = [None] * len(jobs)
    done = 0
    progress_lock = threading.Lock()

    def drain(child: dict) -> None:
        """One worker's stdout, on its own thread. Records what it read on the
        child; an exception is CARRIED, not printed, and re-raised by the caller
        once every worker has been accounted for."""
        nonlocal done
        proc, deal = child['proc'], child['deal']
        count = 0
        try:
            for line in proc.stdout:
                text = line.decode('utf-8', 'replace').strip()
                if not text:
                    continue
                try:
                    record = json.loads(text)
                except ValueError:
                    # The worker reserves fd 1 for results
                    # (`worker._reserve_result_channel`), so a line that is
                    # not one is a broken worker, and it is named — the bare
                    # JSONDecodeError("Extra data") this used to raise told
                    # nobody which line, or whose.
                    raise RuntimeError(
                        f'{_worker_name(child["number"], pool, python_exe)} wrote '
                        f'a line on its result channel that is not a protocol '
                        f'result: {text[:300]!r}')
                if count < len(deal):
                    # RESULT k ANSWERS THE k-TH JOB THIS WORKER WAS DEALT. The
                    # mapping is the position we dealt from, never the record's
                    # own `index` field: that is the book's chunk number, a
                    # worker can be asked to align a subset (`--indices`), and
                    # trusting a number the child chose would let a broken
                    # worker place its results wherever it liked.
                    results[deal[count][0]] = record
                count += 1
                with progress_lock:
                    done += 1
                    if on_result is not None:
                        on_result(done, len(jobs))
        finally:
            child['count'] = count
            proc.stdout.close()

    def guarded(child: dict) -> None:
        try:
            drain(child)
        except BaseException as failure:   # carried to the parent thread
            child['error'] = failure

    with contextlib.ExitStack() as stack:
        children: list = []
        for number, deal in enumerate(deals, start=1):
            infile = stack.enter_context(tempfile.TemporaryFile())
            errfile = stack.enter_context(tempfile.TemporaryFile())
            payload = ''.join(json.dumps(job) + '\n' for _position, job in deal)
            infile.write(payload.encode('utf-8'))
            infile.seek(0)
            proc = subprocess.Popen(
                [python_exe, '-m', 'narrator.align.worker'],
                stdin=infile, stdout=subprocess.PIPE, stderr=errfile,
                env=worker_environment(threads=threads_each),
            )
            children.append({'number': number, 'proc': proc, 'deal': deal,
                             'errfile': errfile, 'count': 0, 'error': None})

        readers = [threading.Thread(target=guarded, args=(child,),
                                    name=f'align-worker-{child["number"]}',
                                    daemon=True)
                   for child in children]
        try:
            for reader in readers:
                reader.start()
            for reader in readers:
                reader.join()
            broken = next((c for c in children if c['error'] is not None), None)
            if broken is not None:
                raise broken['error']
            for child in children:
                child['proc'].wait(timeout=timeout)
        except BaseException:
            # ONE WORKER'S FAILURE ENDS THE POOL. The parent is the only thing
            # holding the others' stdout open; leaving them running would leak
            # N model loads for a run whose caller is already being refused.
            for child in children:
                if child['proc'].poll() is None:
                    child['proc'].kill()
                child['proc'].wait()
            raise

        for child in children:
            child['errfile'].seek(0)
            child['stderr'] = child['errfile'].read().decode(
                'utf-8', 'replace').strip()[-800:]

    for child in children:
        proc, dealt = child['proc'], len(child['deal'])
        if proc.returncode != 0 and child['count'] != dealt:
            raise RuntimeError(
                f'{_worker_name(child["number"], pool, python_exe)} exited '
                f'{proc.returncode} after {child["count"]} of {dealt} job(s): '
                f'{child["stderr"]}')
    for child in children:
        dealt = len(child['deal'])
        if child['count'] != dealt:
            raise RuntimeError(
                f'{_worker_name(child["number"], pool, python_exe)} returned '
                f'{child["count"]} result(s) for {dealt} job(s); stderr: '
                f'{child["stderr"]}')
    return results
