"""The audiobook worker: a sentence range in, `<i>.flac` files out.

Ported from ebook2audiobook@9daab0ba:
  bookforge_ext/parallel/worker_core.py  log_memory (28), register_tts_engine (59),
                                         create_worker_session (149),
                                         memory_cleanup (240),
                                         run_worker_tts (254) - the whole loop
  worker.py                              _graceful_exit (33), the parent-death
                                         watchdog (54-343), main()'s argument
                                         parsing (346-521)

WHICH e2a WORKER THIS IS. e2a has two: `app.py --headless --worker_mode` ->
`session.worker_only` -> `lib/core.convert_chapters2audio`, and the lightweight
`worker.py` -> `worker_core.run_worker_tts`. BookForge spawns the SECOND
(`parallel-tts-bridge.ts`), and only the second is batched, has the
size-gated resume skip, and prints the `Converting sentence N/M (P%)` line the
bridge's progress regex reads. So `run_worker` below is a port of
`run_worker_tts`, and `compat/app.py --worker_mode` routes here - i.e. narrator
answers `app.py --worker_mode` with the code path BookForge actually uses, not
with `convert_chapters2audio`. `compat/FLAGS.md` records that as a deliberate
unification, and the two paths' observable outputs (`<i>.flac` at the same
indices) are the same set.

WHAT THIS MODULE DOES NOT DO:

- It never writes `session-state.json`. Neither does e2a's worker: the state file
  is written once by prep and the render's progress lives in the filesystem. See
  session_store.py.
- It never re-implements an engine guard. The truncation backstop, the EOS
  floor/boost, the resplit ladder, the rate ratchet, the reject dir and the
  `[ORPHEUS][ORPHEUS_GUARD_EVENT]` lines all belong to `narrator.engine` and are
  reached by calling `convert()` / `convert_batch()` - exactly the two methods
  e2a's `TTSManager` delegated to.
- It never realizes a gap. Every gap is PCM inside the chunk's own FLAC, written
  by the engine's `_save_audio` from `_classify_gap`'s `(lead_gap, trail_gap)`.
  See `assemble/README.md` section 1 and `render/gaps.py`.

`log_memory`'s psutil import is the one relocation: e2a imported psutil at
worker_core's module scope, so importing that module cost psutil. Here it is
imported inside the function, like torch is inside the engine, so
`import narrator.render.worker` costs nothing.
"""
from __future__ import annotations

import gc
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

from . import session_store
from .session_store import SessionStateError

#: e2a's `lib/conf.default_audio_proc_format`. The engine writes this extension
#: and the assembler's homogeneity guard reads the FLACs it produces.
AUDIO_PROC_FORMAT = 'flac'

#: e2a `conf_models.default_fine_tuned`: the sentinel meaning "--fine_tuned was
#: never passed". The Orpheus engine refuses it in adapter mode by name.
DEFAULT_FINE_TUNED = 'internal'

#: The resume floor inside the loop. NOTE the strict `>`: e2a's loop skips a file
#: only when it is STRICTLY larger than 1024 bytes, while
#: `scan_completed_sentences` counts one of exactly 1024 bytes as complete. A
#: 1024-byte file is therefore "done" to a resume scan and "missing" to the
#: worker, which re-renders it. Preserved; see PORT_NOTES.md.
RESUME_MIN_BYTES = 1024


# =============================================================================
# Memory
# =============================================================================

def log_memory(label: str) -> None:
    """`[MEMORY] <label>: <rss> GB`. e2a worker_core.py:28, verbatim.

    Not parsed by any bridge regex (grepped over `electron/`, 2026-09-04) - it is
    read by a human reading a worker log, which is why it survives the port at all.
    """
    import psutil
    process = psutil.Process(os.getpid())
    mem_info = process.memory_info()
    rss_gb = mem_info.rss / (1024 ** 3)
    print(f"[MEMORY] {label}: {rss_gb:.2f} GB", flush=True)


def memory_cleanup(sentence_idx: int = 0, interval: int = 100) -> None:
    """e2a worker_core.py:240, verbatim. torch is imported lazily."""
    if sentence_idx % interval == 0:
        gc.collect()
        import torch
        # is_available(), not hasattr: the MPS module exists on Linux where the
        # backend does not.
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        elif torch.cuda.is_available():
            torch.cuda.empty_cache()


# =============================================================================
# The parent-death watchdog
# =============================================================================
#
# THE WORKER MUST NOT OUTLIVE WHOEVER STARTED IT. Ported from e2a worker.py
# (54-343) with its reasoning intact; the short version is that on 2026-09-01 an
# Electron process was Ctrl-C'd, `before-quit` never ran, nothing signalled
# anything, and a worker rendered on as an orphan for 91 minutes holding ~6 GB of
# weights while the next render started on top of it.
#
# Two rules, either of which fires:
#   the ppid CHANGED   - an orphan is reparented on macOS/Linux/WSL the moment
#                        its parent dies, and that change needs no pid to be
#                        remembered, so it cannot race pid reuse.
#   the OWNER is gone  - BOOKFORGE_OWNER_PID names the app itself, watched through
#                        however many `conda run` / bash wrappers sit between us,
#                        with the owner's START TIME as the pid-reuse guard.
#
# The owner rule is armed only when the owner and this process share a pid
# namespace (BOOKFORGE_OWNER_PLATFORM): a Windows pid means nothing, or something
# worse, inside a WSL guest.
#
# What fires is COOPERATIVE - SIGTERM to ourselves, so the handler raises
# SystemExit in the MAIN thread, the loop unwinds, half-written outputs are
# dropped and atexit releases the GPU from inside the process. SIGKILLing a guest
# process parked in a dxg GPU wait is what wedges the whole WSL VM.

ORPHAN_GRACE_ENV = 'ORPHEUS_WORKER_ORPHAN_GRACE_SECONDS'
ORPHAN_GRACE_DEFAULT_SECONDS = 60.0
PARENT_POLL_SECONDS = 2.0
OWNER_PID_ENV = 'BOOKFORGE_OWNER_PID'
OWNER_PLATFORM_ENV = 'BOOKFORGE_OWNER_PLATFORM'


def graceful_exit(signum, frame):
    """SIGTERM/SIGINT -> SystemExit(143). e2a worker.py:33, verbatim.

    Python's default SIGTERM disposition kills the process WITHOUT running atexit
    hooks, so torch/vLLM never release the GPU and the zombie collides with the
    next job. Raising SystemExit unwinds the sentence loop (dropping in-flight
    outputs), runs finally/atexit, and exits 143.
    """
    print(f"[WORKER] Signal {signum} received - shutting down cleanly (releasing GPU)...",
          flush=True)
    raise SystemExit(143)


def install_signal_handlers() -> None:
    """Arm the cooperative stop. Called from the entry point BEFORE the heavy
    imports, so a TERM during a model load still exits cleanly. (On native
    Windows `taskkill` bypasses signals; this is for POSIX and WSL.)"""
    signal.signal(signal.SIGTERM, graceful_exit)
    signal.signal(signal.SIGINT, graceful_exit)


def orphan_grace_seconds() -> float:
    """How long the cooperative stop gets before the GPU is taken back by force."""
    raw = os.environ.get(ORPHAN_GRACE_ENV, '').strip()
    if not raw:
        return ORPHAN_GRACE_DEFAULT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        print(f"[WORKER] {ORPHAN_GRACE_ENV}={raw!r} is not a number; using "
              f"{ORPHAN_GRACE_DEFAULT_SECONDS:g}s", flush=True)
        return ORPHAN_GRACE_DEFAULT_SECONDS
    return max(0.0, value)


def process_start_time(pid: int):
    """The owner's start time as `ps` reports it, or None if `ps` cannot say.

    THE PID-REUSE GUARD. "pid 17311 still exists" and "pid 17311 is still the app
    that spawned me" are different claims, and only the second is worth killing a
    render over. None means "could not establish it", and the caller then falls
    back to the existence check rather than reading an unreadable clock as a change.
    """
    try:
        out = subprocess.run(
            ['ps', '-o', 'lstart=', '-p', str(pid)],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    stamp = out.stdout.strip()
    return stamp or None


def pid_is_alive(pid: int) -> bool:
    """True if `pid` exists. PermissionError means it exists and is not ours."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def resolve_owner():
    """The pid BookForge named for itself, if we can honestly watch it.

    Returns (pid, start_time) or None. Every refusal prints its reason: a watchdog
    that quietly loses half its coverage is how the zombie survived the first fix.
    """
    raw = os.environ.get(OWNER_PID_ENV, '').strip()
    if not raw:
        print(f"[WORKER] no {OWNER_PID_ENV} in the environment - the parent-pid rule "
              f"is the only orphan check", flush=True)
        return None

    try:
        owner = int(raw)
    except ValueError:
        print(f"[WORKER] {OWNER_PID_ENV}={raw!r} is not a pid; ignoring it", flush=True)
        return None
    if owner <= 1 or owner == os.getpid():
        print(f"[WORKER] {OWNER_PID_ENV}={owner} is not a usable owner; ignoring it",
              flush=True)
        return None

    owner_platform = os.environ.get(OWNER_PLATFORM_ENV, '').strip().lower()
    here_is_windows = sys.platform.startswith('win')
    owner_is_windows = owner_platform.startswith('win')
    if owner_platform and owner_is_windows != here_is_windows:
        print(f"[WORKER] owner pid {owner} belongs to a {owner_platform} host, not this "
              f"{sys.platform} process (WSL guest) - the parent-pid rule is the only "
              f"orphan check", flush=True)
        return None

    if not pid_is_alive(owner):
        print(f"[WORKER] owner pid {owner} is not visible from here - the parent-pid "
              f"rule is the only orphan check", flush=True)
        return None

    return owner, process_start_time(owner)


def orphan_reason(initial_ppid, owner):
    """Which rule fired, and about which pid - or None if neither has."""
    try:
        current = os.getppid()
    except (OSError, AttributeError):
        current = initial_ppid
    if initial_ppid is not None and current != initial_ppid:
        return initial_ppid, f'reparented from {initial_ppid} to {current}'

    if owner is not None:
        owner_pid, owner_started = owner
        if not pid_is_alive(owner_pid):
            return owner_pid, f'{OWNER_PID_ENV} {owner_pid} exited'
        if owner_started is not None:
            now_started = process_start_time(owner_pid)
            if now_started is not None and now_started != owner_started:
                return owner_pid, (f'{OWNER_PID_ENV} {owner_pid} was replaced - a new '
                                   f'process reused the pid')
    return None


def _parent_watch_loop(initial_ppid, owner, poll_seconds, grace_seconds):
    """Poll both rules; on either, take the SAME path the app's stop takes."""
    while True:
        time.sleep(poll_seconds)
        fired = orphan_reason(initial_ppid, owner)
        if fired is None:
            continue
        gone_pid, rule = fired

        print(f"[WORKER] parent process {gone_pid} is gone; shutting down "
              f"cooperatively ({rule})", flush=True)

        # The SIGNAL, deliberately, not a raise: the handler runs in the MAIN
        # thread, so SystemExit unwinds the sentence loop, the in-flight rows are
        # dropped (resume re-renders them), and atexit/finally release the GPU from
        # inside the process. Raising here would kill only this daemon thread.
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception as err:  # pragma: no cover - the ladder still applies
            print(f"[WORKER] could not signal self ({err}); going straight to the "
                  f"hard exit", flush=True)
            grace_seconds = 0.0

        deadline = time.monotonic() + grace_seconds
        while time.monotonic() < deadline:
            time.sleep(min(0.25, max(0.01, poll_seconds)))
        print(f"[WORKER] still running {grace_seconds:g}s after the orphan stop - "
              f"forcing exit 143 to release the GPU", flush=True)
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(143)


def start_parent_watch(poll_seconds=PARENT_POLL_SECONDS, grace_seconds=None):
    """Start the parent-death watchdog.

    Returns `{'parent': ppid|None, 'owner': owner_pid|None}` naming which rules are
    armed, or None if neither could be - in which case nothing is watching and the
    reason has been printed. Started from the entry point, never at import, so
    importing this module leaves no thread behind.
    """
    getppid = getattr(os, 'getppid', None)
    initial_ppid = None
    if getppid is None:  # native Windows has no reparenting to observe
        print("[WORKER] no getppid() on this platform - the parent-pid rule is off",
              flush=True)
    else:
        ppid = getppid()
        if ppid <= 1:
            print(f"[WORKER] started with no parent (ppid {ppid}) - a detached run has "
                  f"nothing to outlive, so the parent-pid rule is off", flush=True)
        else:
            initial_ppid = ppid

    owner = resolve_owner()

    if initial_ppid is None and owner is None:
        print("[WORKER] parent watchdog disabled: no parent to outlive and no owner "
              "pid to watch - nothing to outlive", flush=True)
        return None

    if grace_seconds is None:
        grace_seconds = orphan_grace_seconds()

    thread = threading.Thread(
        target=_parent_watch_loop,
        args=(initial_ppid, owner, poll_seconds, grace_seconds),
        name='parent-watch',
        daemon=True,
    )
    thread.start()
    armed = []
    if initial_ppid is not None:
        armed.append(f'parent pid {initial_ppid}')
    if owner is not None:
        started = 'start time recorded' if owner[1] else 'no start time available'
        armed.append(f'owner pid {owner[0]} ({started})')
    print(f"[WORKER] parent watchdog on: {', '.join(armed)}; polling every "
          f"{poll_seconds:g}s, {grace_seconds:g}s grace", flush=True)
    return {'parent': initial_ppid, 'owner': owner[0] if owner else None}


# =============================================================================
# The request
# =============================================================================

@dataclass
class WorkerRequest:
    """Everything `worker.py`'s argv carried into `run_worker_tts`.

    Field names are e2a's flag names with the dashes gone, so a reader can put
    this beside `compat/FLAGS.md` and see one row per field.
    """
    session_id: str
    session_dir: str | None = None

    sentence_start: int | None = None
    sentence_end: int | None = None
    chapter_start: int | None = None
    chapter_end: int | None = None

    #: A scattered explicit set (Studio's "Correct Sentences"). Beats the range.
    sentence_indices: list[int] | None = None
    #: index -> replacement text, already parsed out of the overrides JSON.
    sentence_overrides: dict[int, str] | None = None
    num_takes: int = 1
    take_temperatures: list[float] | None = None

    sentences_dir: str | None = None
    tts_engine: str | None = None
    fine_tuned: str | None = None
    voice: str | None = None
    device: str | None = None
    output_dir: str | None = None
    output_format: str | None = None

    orpheus_model_dir: str | None = None
    orpheus_adapter_dir: str | None = None
    orpheus_base_dir: str | None = None


# =============================================================================
# Building the engine
# =============================================================================

def resolve_session_dir(request: WorkerRequest) -> str:
    """e2a: `session_dir_override or os.path.join(tmp_dir, f"ebook-{session_id}")`.

    narrator has no `tmp_dir`, so the derived form reads the same environment
    variable e2a's `lib/conf` did (`E2A_TMP_DIR`, which every BookForge spawn
    sets) and refuses when it is absent rather than guessing a directory. Every
    live spawn passes `--session_dir` explicitly, so the derived form is the
    hand-run case.
    """
    if request.session_dir:
        return request.session_dir
    root = session_store.sessions_root()
    return os.path.join(root, f'ebook-{request.session_id}')


def engine_config_from(state: dict, request: WorkerRequest, sentences_dir: str):
    """The e2a session dict, reduced to the eight keys the engine ever read.

    Precedence is e2a's throughout (`worker_core.create_worker_session`):
    an explicit CLI value beats the persisted state, because the state may have
    been written on another machine. `voice` here is e2a's `fine_tuned` - the
    voice TOKEN, which the Orpheus engine takes as `EngineConfig.voice`.

    `EngineConfig` is imported inside the function so this module stays
    importable without `narrator.engine`'s constants.
    """
    from ..engine.config import EngineConfig

    fine_tuned = (request.fine_tuned or state.get('fine_tuned')
                  or DEFAULT_FINE_TUNED)
    return EngineConfig(
        voice=fine_tuned,
        model_dir=request.orpheus_model_dir or state.get('orpheus_model_dir'),
        adapter_dir=request.orpheus_adapter_dir or state.get('orpheus_adapter_dir'),
        base_dir=request.orpheus_base_dir or state.get('orpheus_base_dir'),
        sentences_dir=sentences_dir,
        process_dir=state['process_dir'],
        audio_format=AUDIO_PROC_FORMAT,
    )


def build_engine(config):
    """Construct the Orpheus engine. `OrpheusEngine.__init__` loads the model.

    This is the ONLY place `narrator.engine` is imported on the render path, and
    the only thing a test has to substitute to run the loop without a GPU
    (`run_worker(..., engine_factory=...)`).
    """
    from ..engine import OrpheusEngine

    return OrpheusEngine(config)


def resolve_device(request: WorkerRequest, state: dict) -> str:
    """What the worker PRINTS as the device. e2a worker_core.py:156-164.

    Orpheus reads none of this - `narrator/engine/PORT_NOTES.md` section 1 lists
    the eight session keys the engine touched and `device` is not among them; the
    backend is chosen by `detect_backend()`. The value is still resolved and
    printed because the line is in every worker log and because the fallback
    messages are how an operator learns CUDA was not there.

    THE `.lower()` IS LOAD-BEARING. `worker.py:487` lowercases the flag before it
    ever reaches this comparison, and the bridge always sends the UPPERCASE form
    (`resolveTtsDeviceArg` -> `'CUDA'`, because `app.py` wants uppercase). Without
    it `'CUDA' == 'cuda'` is False, neither branch is ever entered, and the
    "CUDA not available, falling back to CPU" diagnostic can never print - on the
    one machine configuration where an operator most needs to see it.
    """
    device = (request.device or state.get('device') or 'cpu').lower()
    import torch
    if device == 'cuda':
        if not torch.cuda.is_available():
            device = 'cpu'
            print("[WORKER] CUDA not available, falling back to CPU", flush=True)
    elif device == 'mps':
        if not torch.backends.mps.is_available():
            device = 'cpu'
            print("[WORKER] MPS not available, falling back to CPU", flush=True)
    return device


# =============================================================================
# The loop
# =============================================================================

@dataclass
class _Counters:
    """Per-RUN totals, carried across every take.

    `first_logged` is deliberately NOT here: e2a declares it inside the
    `if use_batch:` block, which is inside the take loop
    (`worker_core.py:468`), so `log_memory("After first sentence TTS")` prints
    once PER TAKE on the batched path. `_render_batched` owns its own local for
    that reason. The serial path's equivalent (`if processed == 1`) tests the
    cumulative counter, so it prints once per RUN - the two arms genuinely
    differ in e2a and the difference is preserved.
    """
    processed: int = 0
    skipped: int = 0
    failed: list = field(default_factory=list)


def flatten_sentences(state: dict) -> list:
    """`chapter_sentences` (a list per chapter) as one global 0-based list.

    The GLOBAL index of a chunk is its position here, which is also its FLAC
    stem. e2a worker_core.py:319-321.
    """
    all_sentences = []
    for chapter in state['chapter_sentences']:
        all_sentences.extend(chapter)
    return all_sentences


def chapter_range_to_sentences(state: dict, chapter_start: int, chapter_end: int):
    """1-based inclusive chapters -> 0-based inclusive global sentence indices.

    e2a worker_core.py:327-342, verbatim including its shape: `work_start`/
    `work_end` start at 0, so a `chapter_start` that matches no chapter yields
    start 0, and a `chapter_end` that matches none yields end 0. Preserved - see
    PORT_NOTES.md "Suspected bugs preserved".
    """
    sentence_offset = 0
    work_start = 0
    work_end = 0
    for i, chapter in enumerate(state['chapter_sentences']):
        chapter_num = i + 1
        if chapter_num == chapter_start:
            work_start = sentence_offset
        if chapter_num == chapter_end:
            work_end = sentence_offset + len(chapter) - 1
            break
        sentence_offset += len(chapter)
    return work_start, work_end


def run_worker(request: WorkerRequest, engine_factory=build_engine) -> dict:
    """Render `request`'s sentences. Port of `worker_core.run_worker_tts` (254).

    The return dict is e2a's, key for key, because `parallel-tts-bridge.ts`
    parses it off the worker's last stdout line.

    `engine_factory(config) -> engine` is the one seam this port adds: e2a built
    `TTSManager(session)` inline, which made the loop untestable without a 6 GB
    model. The default builds the real engine and nothing about the loop changes.
    The engine must offer exactly what `TTSManager` delegated to:
    `SUPPORTS_BATCH`, `BATCH_SIZE`, `batch_pool_size`, `params['samplerate']`,
    `voice`, `register_voice_caps` or `TEMPERATURE`, `convert`, `convert_batch`,
    `_write_silence`, and a mutable `config.sentences_dir`.
    """
    # Sentence indices whose output file may be half-written right now. A
    # cooperative stop (SIGTERM -> SystemExit) can land mid-conversion; the except
    # below deletes these so resume re-renders them instead of keeping a truncated
    # file that passes the >1KB resume check.
    in_flight: list[int] = []
    sentences_dir_for_cleanup: str | None = None
    num_takes = max(1, int(request.num_takes))
    try:
        session_dir = resolve_session_dir(request)
        if not os.path.exists(session_dir):
            return {'success': False, 'error': f"Session directory not found: {session_dir}"}

        state = session_store.load_session_state(session_dir)
        if not state:
            return {'success': False,
                    'error': f"No session-state.json found in {session_dir}"}

        if 'chapter_sentences' not in state or not state['chapter_sentences']:
            return {'success': False,
                    'error': 'session-state.json missing chapter_sentences'}

        print(f"[WORKER] Loaded session: {state['total_chapters']} chapters, "
              f"{state['total_sentences']} sentences", flush=True)

        # The engine must NAME its engine; guessing would render the wrong model.
        tts_engine = request.tts_engine or state.get('tts_engine')
        if not tts_engine:
            raise ValueError('No tts_engine in session state or args - the session '
                             'state must name its engine')
        if tts_engine != 'orpheus':
            raise ValueError(
                f"narrator renders 'orpheus' only; this session names "
                f"'{tts_engine}'. XTTS, F5, Voxtral, bark, vits, tortoise, "
                f"fairseq, tacotron and yourtts are not ported (see "
                f"docs/NARRATOR_PLAN.md 'What is deleted'); use ebook2audiobook "
                f"for them.")

        base_sentences_dir = session_store.sentences_dir_for(state, request.sentences_dir)
        os.makedirs(base_sentences_dir, exist_ok=True)
        sentences_dir_for_cleanup = base_sentences_dir

        device = resolve_device(request, state)
        config = engine_config_from(state, request, base_sentences_dir)

        all_sentences = flatten_sentences(state)

        sentence_start = request.sentence_start
        sentence_end = request.sentence_end
        chapter_mode = (request.chapter_start is not None
                        and request.chapter_end is not None)
        if chapter_mode:
            sentence_start, sentence_end = chapter_range_to_sentences(
                state, request.chapter_start, request.chapter_end)
            print(f"[WORKER] Chapter mode: chapters {request.chapter_start}-"
                  f"{request.chapter_end} = sentences {sentence_start}-{sentence_end}",
                  flush=True)

        # Discrete-index mode (Studio's "Correct Sentences") renders an explicit,
        # possibly scattered set; otherwise the contiguous [start, end] range.
        if request.sentence_indices is not None:
            for idx in request.sentence_indices:
                if idx < 0 or idx >= len(all_sentences):
                    return {'success': False,
                            'error': f'Invalid sentence index {idx} '
                                     f'(total: {len(all_sentences)})'}
            work_indices = list(request.sentence_indices)
        else:
            if sentence_start is None or sentence_end is None:
                return {'success': False,
                        'error': 'Must specify sentence or chapter range'}
            if sentence_start < 0 or sentence_end >= len(all_sentences):
                return {'success': False,
                        'error': f'Invalid sentence range: {sentence_start}-'
                                 f'{sentence_end} (total: {len(all_sentences)})'}
            work_indices = list(range(sentence_start, sentence_end + 1))

        print(f"[WORKER] Processing {len(work_indices)} sentence(s) on "
              f"{device.upper()}", flush=True)
        print(f"[WORKER] TTS engine: {tts_engine}, fine_tuned: {config.voice}",
              flush=True)
        print(f"[WORKER DEBUG] Full session dict:", flush=True)
        for k, v in sorted(_debug_view(state, config, request, device,
                                       base_sentences_dir, tts_engine).items()):
            print(f"  {k}: {v}", flush=True)

        log_memory("Before engine init")
        engine = engine_factory(config)
        log_memory("After engine init (model loaded)")

        counters = _Counters()
        # Write take<k>/ subdirs whenever there is >1 take OR explicit per-take
        # temperatures, so a single-temp "long override" take still lands in take0/,
        # matching how correct-sentences-bridge.ts collects candidates.
        multi_take = num_takes > 1 or bool(request.take_temperatures)
        total_to_process = len(work_indices) * num_takes
        total_sentences = state['total_sentences']
        start_time = time.time()

        for take in range(num_takes):
            pass_dir = (os.path.join(base_sentences_dir, f'take{take}')
                        if multi_take else base_sentences_dir)
            os.makedirs(pass_dir, exist_ok=True)
            # The engine reads config.sentences_dir at every write, so repointing
            # the config is what e2a did by repointing session['sentences_dir'].
            engine.config.sentences_dir = pass_dir
            sentences_dir_for_cleanup = pass_dir

            _apply_take_temperature(engine, take, request.take_temperatures)

            _render_take(engine, work_indices, all_sentences, request.sentence_overrides,
                         pass_dir, counters, total_to_process, total_sentences,
                         in_flight, announce_batch=(take == 0))

        elapsed = time.time() - start_time
        actual_converted = counters.processed - counters.skipped
        log_memory("After all sentences processed")

        print(f"[WORKER] Completed: {actual_converted} converted, "
              f"{counters.skipped} skipped in {elapsed:.1f}s", flush=True)
        if counters.failed:
            print(f"[WORKER] ERROR: {len(counters.failed)} sentence(s) failed to "
                  f"convert: {counters.failed}", flush=True)

        result = {
            'success': not counters.failed,
            'session_id': request.session_id,
            'sentences_processed': counters.processed,
            'sentences_converted': actual_converted,
            'sentences_skipped': counters.skipped,
            'sentences_failed': len(counters.failed),
            'failed_indices': counters.failed,
            'sentence_start': sentence_start,
            'sentence_end': sentence_end,
            'elapsed_seconds': elapsed,
        }
        if counters.failed:
            result['error'] = (f"{len(counters.failed)} sentence(s) failed to convert: "
                               f"{counters.failed}")
        return result

    except (KeyboardInterrupt, SystemExit):
        # Cooperative stop: delete any half-written in-flight outputs so resume
        # re-renders them, then RE-RAISE so the interpreter exits normally -
        # finally/atexit run (the engine's CUDA cleanup) and the GPU is released
        # from inside the process.
        if sentences_dir_for_cleanup and in_flight:
            for idx in in_flight:
                p = os.path.join(sentences_dir_for_cleanup,
                                 f'{idx}.{AUDIO_PROC_FORMAT}')
                try:
                    os.remove(p)
                except OSError:
                    pass
            print(f"[WORKER] Stop requested - dropped {len(in_flight)} in-flight "
                  f"output(s); exiting cleanly", flush=True)
        else:
            print("[WORKER] Stop requested - exiting cleanly", flush=True)
        raise

    except Exception as e:
        # e2a's shape exactly, INCLUDING the poisoned-CUDA case: the engine
        # re-raises a fatal CUDA error instead of retrying per item (so the rest of
        # the book is not rendered as garbage), and it arrives here, where it
        # becomes success=False + the error text. The process then exits 1 and
        # BookForge respawns a fresh worker, which is what makes the poison
        # recoverable at all. There is no special exit code: grep for one in e2a
        # finds nothing.
        import traceback
        traceback.print_exc()
        return {'success': False, 'error': str(e)}


def _debug_view(state, config, request, device, sentences_dir, tts_engine) -> dict:
    """The `[WORKER DEBUG] Full session dict:` payload.

    e2a printed its whole session dict minus `chapter_sentences`. narrator has no
    such dict, so this is the same information assembled from the state, the
    request and the engine config - the fields an operator reads that block for
    (which model, which directory, which voice).
    """
    return {
        'id': state.get('session_id'),
        'device': device,
        'tts_engine': tts_engine,
        'fine_tuned': config.voice,
        'voice': request.voice or state.get('voice'),
        'language': state.get('language'),
        'language_iso1': state.get('language_iso1'),
        'orpheus_model_dir': config.model_dir,
        'orpheus_adapter_dir': config.adapter_dir,
        'orpheus_base_dir': config.base_dir,
        'session_dir': state.get('session_dir'),
        'process_dir': state.get('process_dir'),
        'chapters_dir': state.get('chapters_dir'),
        'sentences_dir': sentences_dir,
        'audiobooks_dir': request.output_dir or state.get('audiobooks_dir'),
        'output_format': request.output_format or state.get('output_format'),
        'final_name': state.get('final_name'),
        'cover': state.get('cover'),
        'filename_noext': state.get('filename_noext'),
    }


def _apply_take_temperature(engine, take: int, take_temperatures) -> None:
    """Per-take sampling temperature IN THE SAME model load. e2a worker_core:423-440.

    The registry, not `engine.TEMPERATURE`: Orpheus resolves caps as
    registry -> env -> class attribute, so a bare TEMPERATURE assignment loses to
    an inherited `ORPHEUS_TEMPERATURE` and every take renders alike. Registration
    REPLACES the voice's caps dict, which is safe because the audiobook worker
    supplies every other cap through the environment and never the registry.
    """
    if not take_temperatures or take >= len(take_temperatures):
        return
    temp = float(take_temperatures[take])
    if hasattr(engine, 'register_voice_caps'):
        engine.register_voice_caps(engine.voice, {'temperature': temp})
        print(f"[WORKER] Take {take}: sampling temperature = {temp}", flush=True)
    elif hasattr(engine, 'TEMPERATURE'):
        engine.TEMPERATURE = temp
        print(f"[WORKER] Take {take}: sampling temperature = {temp}", flush=True)
    else:
        print(f"[WORKER] Take {take}: engine has no TEMPERATURE knob; using default",
              flush=True)


def _text_for(index: int, all_sentences: list, overrides) -> str:
    return overrides.get(index, all_sentences[index]) if overrides else all_sentences[index]


def _render_take(engine, work_indices, all_sentences, overrides, pass_dir,
                 counters: _Counters, total_to_process: int, total_sentences: int,
                 in_flight: list, announce_batch: bool) -> None:
    """One take over `work_indices`. e2a worker_core.py:442-558, both arms."""
    supports_batch = bool(getattr(engine, 'SUPPORTS_BATCH', False)
                          and hasattr(engine, 'convert_batch'))
    batch_size = int(getattr(engine, 'BATCH_SIZE', 1) or 1)
    use_batch = supports_batch and batch_size > 1

    if use_batch:
        # An engine may ask for a POOL deeper than its batch size and re-slice
        # internally; it never generates a batch WIDER than batch_size. Orpheus/MLX
        # asks for 4x while continuous batching is on: one BatchGenerator spans the
        # whole flush and refills a retired slot from the rows still queued, so a
        # pool of exactly batch_size would leave it nothing to refill with.
        # Consequences visible from here: the per-sentence "Converting sentence"
        # lines are printed only after a flush RETURNS, so they arrive in blocks of
        # pool_size (the engine's [ORPHEUS] heartbeat is the within-flush progress
        # source), and a cooperative stop drops the whole flush.
        pool_size = max(batch_size, _pool_size(engine, batch_size))
        if announce_batch:
            if pool_size != batch_size:
                print(f"[WORKER] Batched inference enabled (batch size {batch_size}, "
                      f"pooling {pool_size} sentences per call)", flush=True)
            else:
                print(f"[WORKER] Batched inference enabled (batch size {batch_size})",
                      flush=True)
        _render_batched(engine, work_indices, all_sentences, overrides, pass_dir,
                        counters, total_to_process, total_sentences, in_flight,
                        pool_size)
    else:
        _render_serial(engine, work_indices, all_sentences, overrides, pass_dir,
                       counters, total_to_process, total_sentences, in_flight)


def _pool_size(engine, batch_size: int) -> int:
    """`TTSManager.batch_pool_size`, which coerced anything unusable to 0."""
    pool = getattr(engine, 'batch_pool_size', None)
    try:
        pool = int(pool or 0)
    except (TypeError, ValueError):
        pool = 0
    return pool


def _already_rendered(pass_dir: str, index: int) -> bool:
    """The resume skip. STRICTLY greater than 1024 bytes - see RESUME_MIN_BYTES."""
    output_file = os.path.join(pass_dir, f'{index}.{AUDIO_PROC_FORMAT}')
    return os.path.exists(output_file) and os.path.getsize(output_file) > RESUME_MIN_BYTES


def _write_empty_sentence_silence(engine, index: int) -> None:
    """An empty sentence still gets a file at its index.

    Sentence indices are POSITIONAL: assembly and `detect_completed_chapters`
    require `{i}.flac` to exist for every index, so skipping without writing
    anything left a permanently un-assemblable hole. e2a wrote 0.1 s of zeros with
    torchaudio (`worker_core._write_empty_sentence_silence`); the engine's
    `_write_silence` is that same code (`orpheus.py:4139`), so the worker calls it
    rather than keeping a second copy - identical bytes, and torchaudio stays
    inside `engine/`.

    NOTE, unchanged from e2a: a digital-silence FLAC is about 100 bytes, below the
    1024-byte resume floor, so this index is listed as missing by every later scan
    and rewritten on every pass. The rewrite is idempotent and cheap, and assembly
    correctness only needs the file to exist.
    """
    engine._write_silence(index)


def _render_serial(engine, work_indices, all_sentences, overrides, pass_dir,
                   counters, total_to_process, total_sentences, in_flight) -> None:
    for i in work_indices:
        if _already_rendered(pass_dir, i):
            counters.skipped += 1
            counters.processed += 1
            continue

        sentence = _text_for(i, all_sentences, overrides)
        if not sentence or not sentence.strip():
            _write_empty_sentence_silence(engine, i)
            counters.skipped += 1
            counters.processed += 1
            continue

        progress_pct = (counters.processed / total_to_process) * 100
        print(f"Converting sentence {i}/{total_sentences} ({progress_pct:.1f}%)",
              flush=True)

        in_flight[:] = [i]
        success = engine.convert(i, sentence)
        in_flight.clear()
        if not success:
            print(f"[WORKER] Warning: Failed to convert sentence {i}", flush=True)
            # Keep processing the rest, but record the failure - the final result
            # must report success=False so the caller does not treat a run with
            # holes as complete.
            counters.failed.append(i)

        counters.processed += 1

        if counters.processed == 1:
            log_memory("After first sentence TTS")

        memory_cleanup(counters.processed, interval=10)


def _render_batched(engine, work_indices, all_sentences, overrides, pass_dir,
                    counters, total_to_process, total_sentences, in_flight,
                    pool_size) -> None:
    pending = []  # (sentence_index, sentence)
    # Per-TAKE, not per-run: e2a declares this inside the take loop's use_batch
    # block (worker_core.py:468), so each take logs its own first-sentence memory
    # reading. See _Counters.
    first_logged = False

    def flush():
        nonlocal first_logged
        if not pending:
            return
        # in_flight covers the WHOLE pending flush: a cooperative stop deletes these
        # outputs so resume re-renders them cleanly. With a pool the flush is
        # larger, so a stop discards a bit more finished work - correctness is
        # unaffected, and the engine gives no per-row completion signal to narrow it.
        in_flight[:] = [idx for idx, _ in pending]
        results = engine.convert_batch(pending)
        in_flight.clear()
        for (idx, _), ok in zip(pending, results):
            if not ok:
                print(f"[WORKER] Warning: Failed to convert sentence {idx}", flush=True)
                counters.failed.append(idx)
            counters.processed += 1
            progress_pct = (counters.processed / total_to_process) * 100
            print(f"Converting sentence {idx}/{total_sentences} ({progress_pct:.1f}%)",
                  flush=True)
            if not first_logged:
                log_memory("After first sentence TTS")
                first_logged = True
        pending.clear()

    for i in work_indices:
        # Skip already-rendered (resume) and empty sentences - the same as the
        # per-sentence path; empties never reach the batch.
        if _already_rendered(pass_dir, i):
            counters.skipped += 1
            counters.processed += 1
            continue
        sentence = _text_for(i, all_sentences, overrides)
        if not sentence or not sentence.strip():
            _write_empty_sentence_silence(engine, i)
            counters.skipped += 1
            counters.processed += 1
            continue
        pending.append((i, sentence))
        if len(pending) >= pool_size:
            flush()
    flush()
