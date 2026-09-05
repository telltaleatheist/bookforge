"""Read and write session layout v1's `session-state.json`, and answer the two
questions everything else asks of a session: what is rendered, and what is not.

Ported from ebook2audiobook@9daab0ba:
  bookforge_ext/parallel/session.py   save_session_state (54), load_session_state (123),
                                      scan_completed_sentences (164),
                                      calculate_missing_ranges (193),
                                      list_resumable_sessions (221),
                                      check_resume_compatibility (265),
                                      resume_session (284)
  bookforge_ext/parallel/worker_core.py  load_session_state (87),
                                         scan_completed_sentences (112)

NOTHING ABOUT THE LAYOUT CHANGES. `render/SESSION_READERS.md` enumerates every
file in BookForge and e2a that reads a byte of it; this module reproduces what
e2a writes and what e2a reads, key for key.

Two facts a reader of this module needs, both MEASURED at 9daab0ba rather than
assumed:

1. **`session-state.json` is written exactly ONCE, by prep.** `save_session_state`
   is called from `prep_ebook_info` (session.py:553) and from nowhere else in the
   whole checkout. `status` is set to `'prepared'` there and no code path ever
   changes it; `updated_at` is stamped from the same `datetime.now()` call as
   `created_at` and never restamped. THE WORKER NEVER WRITES THIS FILE - it opens
   it read-only, and its progress is recorded in the filesystem (which `N.flac`
   files exist), not in the state. `set_status()` below exists because a state
   store must be able to express the transition and because the round-trip test
   drives it; it is called from nothing in narrator, exactly as its e2a
   counterpart is called from nothing after prep.

2. **e2a keeps TWO `load_session_state` copies that disagree.** worker_core.py's
   swallows every exception and returns None, so a corrupt state reads as "no
   session" and the worker answers `{'success': False, 'error': 'No
   session-state.json found in <dir>'}`. session.py's raises instead, with a
   comment explaining why ("treating a corrupt state as 'no session' made callers
   start fresh over an existing session's rendered files"). narrator ports the
   LOUD one: same outcome (the worker refuses), better message, and it is the
   copy e2a itself hardened. See render/PORT_NOTES.md.

Pure stdlib. No torch, no numpy.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime

#: The state file, in `<session_dir>/<hash>/`.
SESSION_STATE_FILENAME = 'session-state.json'

#: BookForge's OWN sidecar, which lives beside ours and is NOT this file.
#: Named here so nobody wires the two together by accident.
BOOKFORGE_SIDECAR_FILENAME = 'session_state.json'

#: `chapters/sentences` relative to the process dir - the default sentence store.
SENTENCES_SUBPATH = ('chapters', 'sentences')

#: The extensions `scan_completed_sentences` accepts, in e2a's order. First hit
#: wins, so a stale `0.wav` beside a good `0.flac` is never consulted.
SENTENCE_EXTENSIONS = ('flac', 'wav', 'mp3')

#: A file smaller than this does not count as rendered. e2a's `min_file_size`
#: default, and the reason a 0.1 s silence clip (about 100 bytes of FLAC) is
#: rescanned forever - see the note in worker.py's empty-sentence writer.
MIN_RENDERED_FILE_BYTES = 1024

#: Every key `save_session_state` writes, in the order its dict literal declares
#: them (session.py:61-110). The order is not decoration: the golden fixtures were
#: produced by that writer and `tests/test_render_session_store.py` compares this
#: tuple against them, so a key added in the wrong place is caught.
STATE_KEY_ORDER = (
    'version',
    'session_id',
    'epub_path',
    'source_epub_path',
    'epub_content_hash',
    'total_sentences',
    'total_chapters',
    'chapters',
    'chapter_sentences',
    'language',
    'language_iso1',
    'voice',
    'fine_tuned',
    'custom_model',
    'custom_model_dir',
    'orpheus_model_dir',
    'orpheus_adapter_dir',
    'orpheus_base_dir',
    'tts_engine',
    'device',
    'output_format',
    'audiobooks_dir',
    'created_at',
    'updated_at',
    'status',
    'metadata',
    'session_dir',
    'process_dir',
    'chapters_dir',
    'chapters_dir_sentences',
    'epub_path_internal',
    'filename_noext',
    'cover',
    'final_name',
    'chapter_titles',
    'chapter_docs',
    'chapter_titles_by_doc',
    'bookforge_metadata',
)

#: The state version prep writes. Anything else is refused by `require_v2`.
STATE_VERSION = 2


class SessionStateError(RuntimeError):
    """A session state that exists but cannot be used."""


# =============================================================================
# Locating and reading
# =============================================================================

def find_process_dir(session_dir: str) -> str | None:
    """The `<hash>` subdirectory of `session_dir` that holds the state file.

    e2a's `load_session_state` walks `os.listdir(session_dir)` and takes the
    first subdirectory containing `session-state.json`; that walk is reproduced
    here so a session with two hash dirs resolves the same way it does today
    (whichever the filesystem lists first - see "Suspected bugs preserved").

    Returns None when `session_dir` is not a directory or holds no state file,
    which is e2a's "no session" answer and the one case a caller may treat as
    absence rather than as an error.
    """
    if not os.path.isdir(session_dir):
        return None
    for name in sorted(os.listdir(session_dir)):
        candidate = os.path.join(session_dir, name)
        if not os.path.isdir(candidate):
            continue
        if os.path.exists(os.path.join(candidate, SESSION_STATE_FILENAME)):
            return candidate
    return None


def read_state_file(state_path: str) -> dict:
    """Parse one `session-state.json`. Raises on anything but a readable object."""
    try:
        with open(state_path, 'r', encoding='utf-8') as f:
            state = json.load(f)
    except Exception as e:
        raise SessionStateError(
            f'Session state exists at {state_path} but could not be read/parsed '
            f'({e}). Refusing to treat it as "no session" - that would silently '
            f'restart over the existing session. Fix or delete the file to proceed.'
        ) from e
    if not isinstance(state, dict):
        raise SessionStateError(
            f'{state_path} does not contain a JSON object (got '
            f'{type(state).__name__}).')
    return state


def load_session_state(session_dir: str) -> dict | None:
    """e2a `bookforge_ext/parallel/session.py:load_session_state`, verbatim in
    behaviour.

    Walks `session_dir`'s subdirectories for `session-state.json`, and on a hit
    OVERWRITES `process_dir` and `session_dir` in the returned dict with the
    directories it actually walked. That overwrite is the whole point: the paths
    stored in the file came from whichever machine wrote them (a WSL ext4 path,
    a Windows path, a tmp dir that no longer exists) and are never trusted.

    Returns None only when there is no state file anywhere under `session_dir`.
    A state file that exists and cannot be parsed RAISES.
    """
    process_dir = find_process_dir(session_dir)
    if process_dir is None:
        return None
    state = read_state_file(os.path.join(process_dir, SESSION_STATE_FILENAME))
    state['process_dir'] = process_dir
    state['session_dir'] = session_dir
    return state


def load_state_from_process_dir(process_dir: str) -> dict:
    """Read the state out of a `<hash>` directory that is named directly.

    This is the shape every narrator caller has (the bridges pass
    `--session_dir` pointing at the `ebook-<uuid>` dir and narrator resolves the
    hash dir below it, or a test hands over the hash dir itself), and it is what
    `render/session_v1.py:load_session_state` already does for the assembler.
    Unlike `load_session_state` it never returns None: a caller naming a process
    dir is asserting there is a session there.
    """
    state_path = os.path.join(process_dir, SESSION_STATE_FILENAME)
    if not os.path.exists(state_path):
        raise SessionStateError(f'No {SESSION_STATE_FILENAME} in {process_dir}')
    state = read_state_file(state_path)
    state['process_dir'] = process_dir
    state['session_dir'] = os.path.dirname(process_dir)
    return state


def resolve_process_dir(session_dir: str) -> str:
    """`session_dir` may be the `ebook-<uuid>` dir OR the `<hash>` dir below it.

    Both shapes reach the worker today: `parallel-tts-bridge.ts` passes the
    `ebook-<uuid>` dir (which is what e2a's walk expects), while the reassembly
    path and the CLI name the hash dir. Refuses rather than guessing when
    neither holds a state file.
    """
    if os.path.exists(os.path.join(session_dir, SESSION_STATE_FILENAME)):
        return session_dir
    found = find_process_dir(session_dir)
    if found is None:
        raise SessionStateError(
            f'No {SESSION_STATE_FILENAME} in {session_dir} or any of its '
            f'subdirectories.')
    return found


def require_v2(state: dict, where: str) -> None:
    """Refuse a state that is not the version this module understands."""
    version = state.get('version')
    if version != STATE_VERSION:
        raise SessionStateError(
            f'{where}: session state version is {version!r}, expected '
            f'{STATE_VERSION}.')


def sentences_dir_for(state: dict, override: str | None = None) -> str:
    """Where sentence audio is written and read.

    e2a's precedence, unchanged (worker_core.py:215, session.py:628):
      --sentences_dir  >  state['chapters_dir_sentences']  >
      <process_dir>/chapters/sentences

    This is a PRECEDENCE, not a fallback ladder hiding a missing value: the
    explicit flag exists because the stored path may name a machine that is not
    this one, and the derived path is what the layout guarantees.
    """
    if override:
        return override
    stored = state.get('chapters_dir_sentences')
    if stored:
        return stored
    return os.path.join(state['process_dir'], *SENTENCES_SUBPATH)


# =============================================================================
# Writing
# =============================================================================

def order_state(state: dict) -> dict:
    """`state`, with e2a's key order restored.

    Keys in `STATE_KEY_ORDER` come first, in that order and only when present;
    anything else follows in its own insertion order, so a state written by a
    newer or older writer round-trips without losing a field.
    """
    ordered = {k: state[k] for k in STATE_KEY_ORDER if k in state}
    for k, v in state.items():
        if k not in ordered:
            ordered[k] = v
    return ordered


def save_session_state(process_dir: str, state: dict) -> str:
    """Write `session-state.json` into `process_dir`. Returns the path written.

    e2a: `json.dump(state, f, indent=2)` into a text-mode handle
    (session.py:112-114). narrator matches the payload exactly - `indent=2`,
    `ensure_ascii=True` (json's default, which is what e2a got), keys in e2a's
    order - and differs in two declared ways:

    - **LF line endings on every platform.** e2a's text-mode `open` writes CRLF
      when prep runs on Windows and LF when it runs in WSL or on the Mac, so its
      own bytes already depend on the machine. Every reader is a JSON parser.
      Same deviation, same reasoning, as the VTT (assemble/README.md section 7).
    - **`ensure_ascii=False`**, where e2a takes json's `True` default. The LAST
      writer of a live `session-state.json` is not e2a at all: it is
      `reassembly-bridge.ts:1108-1159`, writing metadata back through
      `JSON.stringify`, which never escapes non-ASCII. So a real file on disk
      already carries a literal `u` with an umlaut in a title, and re-emitting it
      as `\\u00fc` would churn bytes on every book with an accent in its
      metadata, for no reader's benefit. Matching the file's actual last writer
      is the smaller deviation.
    - **The write is atomic** (temp file in the same directory, then
      `os.replace`). e2a truncates the real file and streams into it, so a crash
      mid-write leaves a corrupt state - which its own `load_session_state` then
      refuses, permanently, with no way back but deleting the file. Atomicity
      removes a failure mode; it adds none.
    """
    if not os.path.isdir(process_dir):
        raise SessionStateError(f'Not a directory: {process_dir}')
    state_path = os.path.join(process_dir, SESSION_STATE_FILENAME)
    payload = json.dumps(order_state(state), indent=2, ensure_ascii=False)
    fd, tmp_path = tempfile.mkstemp(
        prefix='.session-state-', suffix='.json', dir=process_dir)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, state_path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    return state_path


def set_status(state: dict, status: str) -> dict:
    """Stamp `status` and `updated_at` the way e2a stamps them at prep.

    `datetime.now().isoformat()` - naive, local, microsecond precision - because
    that is the literal e2a uses (session.py:84-86) and the format every reader
    of `created_at`/`updated_at` has seen.

    NOTHING IN NARRATOR CALLS THIS on the render path, because nothing in e2a
    does: prep sets `'prepared'` and no later stage rewrites the file. It is here
    so a store can express the transition and so the round-trip test has one.
    """
    if not status:
        raise ValueError('set_status() requires a status')
    state['status'] = status
    state['updated_at'] = datetime.now().isoformat()
    return state


# =============================================================================
# Scanning
# =============================================================================

def scan_completed_sentences(sentences_dir: str, total_sentences: int,
                             min_file_size: int = MIN_RENDERED_FILE_BYTES) -> dict:
    """Which of `0..total_sentences-1` are rendered. e2a session.py:164, verbatim.

    "Rendered" is: a file named `<i>.<ext>` exists for one of flac/wav/mp3 (in
    that order) AND is at least `min_file_size` bytes. The size rule is what
    makes a half-written file re-render instead of being kept; it is also why a
    0.1 s digital-silence FLAC never counts (about 100 bytes) and is rewritten on
    every pass - see worker.py.

    Returns e2a's exact dict: completed, missing, completed_count, missing_count,
    progress_percent (rounded to 1 dp, 0 for an empty book).
    """
    completed = []
    missing = []

    for i in range(total_sentences):
        found = False
        for ext in SENTENCE_EXTENSIONS:
            file_path = os.path.join(sentences_dir, f'{i}.{ext}')
            if os.path.exists(file_path):
                file_size = os.path.getsize(file_path)
                if file_size >= min_file_size:
                    completed.append(i)
                    found = True
                    break
        if not found:
            missing.append(i)

    return {
        'completed': completed,
        'missing': missing,
        'completed_count': len(completed),
        'missing_count': len(missing),
        'progress_percent': round(len(completed) / total_sentences * 100, 1) if total_sentences > 0 else 0
    }


def calculate_missing_ranges(missing_indices: list) -> list:
    """Collapse missing indices into contiguous ranges. e2a session.py:193, verbatim."""
    if not missing_indices:
        return []

    ranges = []
    sorted_indices = sorted(missing_indices)
    range_start = sorted_indices[0]
    range_end = sorted_indices[0]

    for i in range(1, len(sorted_indices)):
        if sorted_indices[i] == range_end + 1:
            range_end = sorted_indices[i]
        else:
            ranges.append({'start': range_start, 'end': range_end, 'count': range_end - range_start + 1})
            range_start = sorted_indices[i]
            range_end = sorted_indices[i]

    ranges.append({'start': range_start, 'end': range_end, 'count': range_end - range_start + 1})
    return ranges


# =============================================================================
# Listing and resume
# =============================================================================

SESSIONS_ROOT_ENV = 'NARRATOR_SESSIONS_ROOT'

#: The pre-Phase-6 spelling. REFUSED rather than honoured - see
#: `refuse_legacy_sessions_root_env`.
LEGACY_SESSIONS_ROOT_ENV = 'E2A_TMP_DIR'


def refuse_legacy_sessions_root_env() -> None:
    """Refuse `E2A_TMP_DIR` BY NAME if anything still sets it.

    It was this variable's name until 2026-09-05, when BookForge moved the
    session scratch out of the ebook2audiobook checkout. Accepting it as an alias
    would let a stale shell export, a CI job or an old launcher keep working by
    accident while every other name in the system said narrator - and the first
    time the two disagreed, the render would write a book into a directory
    nothing else looks in and report success.

    Called from `sessions_root()` and from both compat entry points, so it fires
    on every door rather than only on the two that read the root.
    """
    stale = os.environ.get(LEGACY_SESSIONS_ROOT_ENV, '').strip()
    if stale:
        raise SessionStateError(
            f'{LEGACY_SESSIONS_ROOT_ENV} is set ({stale}). It was renamed to '
            f'{SESSIONS_ROOT_ENV} when the session scratch stopped being an '
            f'ebook2audiobook directory. It is refused rather than honoured so '
            f'that nothing keeps working by accident - unset it, and set '
            f'{SESSIONS_ROOT_ENV} instead.')


def sessions_root() -> str:
    """The directory `--list_sessions` walks, and the base a bare session id is
    resolved under.

    The environment variable is the whole interface - and WHICH SPAWNS ACTUALLY
    SET IT MATTERS:

    - **Native spawns: yes.** `buildToolsSpawnEnv` sets it from the stated
      scratch root (`electron/narrator-paths.ts`), so the native worker, the
      native assembly and the `--list_sessions` / `--resume_session` probes all
      carry it. It is OMITTED, never substituted, when the scratch volume is not
      mounted - which is what brings a caller here to be refused instead of
      quietly writing somewhere else.
    - **WSL spawns: NO.** `buildNarratorSpawn`'s guest arm exports exactly the
      caller's `envExtras` plus four variables of its own, and this is not one of
      them. Inside WSL it is simply absent - and the Orpheus render path is
      exactly the one that goes through WSL. (It could not usefully cross anyway:
      it holds a HOST path, while a guest render's session dir is derived from
      the guest sessions root.)

    That is survivable because **every live render and retake spawn passes
    `--session_dir` explicitly**, which is the path that never reaches this
    function. What a WSL spawn cannot do is omit `--session_dir` and expect a
    session id to resolve.

    Unset is an error, not a guessed directory: listing or resolving under the
    wrong root would report "no session" for a machine full of them, and the
    caller would start fresh over existing rendered audio.
    """
    refuse_legacy_sessions_root_env()
    root = os.environ.get(SESSIONS_ROOT_ENV, '').strip()
    if not root:
        raise SessionStateError(
            f'{SESSIONS_ROOT_ENV} is not set, so there is no sessions root to '
            f'resolve a session id under - pass --session_dir. (narrator has no '
            f'default sessions root and will not guess. Note that a WSL spawn '
            f'never carries this variable: the guest arm exports only the '
            f"caller's envExtras plus PYTHONUNBUFFERED / PYTHONIOENCODING / "
            f'PYTHONPATH / NARRATOR_ENGINE.)')
    return root


def list_resumable_sessions(root: str | None = None) -> list:
    """Every `ebook-*` session under `root` with at least one missing sentence.

    e2a session.py:221, verbatim, with the root passed in instead of imported.
    The scan is over `<process_dir>/chapters/sentences` ONLY - never a denoised
    or RVC set - because that is the directory e2a scans.

    The listing is NOT sorted, because e2a's is not (`session.py:230` iterates
    raw `os.listdir`). Nothing downstream reads the order - the one caller
    discards the whole answer - so matching e2a costs nothing and guessing at an
    improvement would be a difference for its own sake.
    """
    resumable = []
    root = root if root is not None else sessions_root()

    if not os.path.exists(root):
        return resumable

    for session_name in os.listdir(root):
        if not session_name.startswith('ebook-'):
            continue

        session_dir = os.path.join(root, session_name)
        if not os.path.isdir(session_dir):
            continue

        state = load_session_state(session_dir)
        if not state:
            continue

        sentences_dir = os.path.join(state['process_dir'], *SENTENCES_SUBPATH)
        if not os.path.exists(sentences_dir):
            continue

        scan_result = scan_completed_sentences(sentences_dir, state['total_sentences'])

        if scan_result['missing_count'] > 0:
            resumable.append({
                'session_id': state['session_id'],
                'session_dir': session_dir,
                'title': state.get('metadata', {}).get('title', 'Unknown'),
                'total_sentences': state['total_sentences'],
                'completed_sentences': scan_result['completed_count'],
                'missing_sentences': scan_result['missing_count'],
                'progress_percent': scan_result['progress_percent'],
                'created_at': state.get('created_at'),
                'language': state.get('language'),
                'voice': state.get('voice')
            })

    return resumable


def check_resume_compatibility(state: dict, voice: str | None,
                               tts_engine: str | None) -> dict:
    """e2a session.py:265, verbatim. Always compatible; only warns.

    e2a took the whole args dict and read exactly two keys out of it; those two
    are named parameters here.
    """
    warnings = []

    saved_voice = state.get('voice')
    if saved_voice and voice and saved_voice != voice:
        warnings.append(f"Voice changed from '{saved_voice}' to '{voice}'")

    saved_engine = state.get('tts_engine')
    if saved_engine and tts_engine and saved_engine != tts_engine:
        warnings.append(f"TTS engine changed from '{saved_engine}' to '{tts_engine}'")

    return {'compatible': True, 'warnings': warnings}


def resume_session(session_path: str, voice: str | None = None,
                   tts_engine: str | None = None,
                   root: str | None = None) -> dict:
    """How far a session got, in the shape `--resume_session` prints today.

    e2a session.py:284. `session_path` is an absolute directory, an
    `ebook-<uuid>` name, or a bare uuid; the last two are resolved under `root`.

    Every key in both return shapes is read by
    `parallel-tts-bridge.ts:checkResumeStatus` (:8816-8840) - see
    render/SESSION_READERS.md - so none of them may be renamed or dropped.

    e2a wrapped the whole body in `except Exception -> {'success': False,
    'error': str(e)}`; that wrapper lives in `compat/app.py`, where the process
    exit code is decided, rather than here where it would hide a bug from a
    library caller.
    """
    if not session_path:
        return {'success': False, 'error': 'No session path provided'}

    if not os.path.isabs(session_path):
        base = root if root is not None else sessions_root()
        if session_path.startswith('ebook-'):
            session_dir = os.path.join(base, session_path)
        else:
            session_dir = os.path.join(base, f'ebook-{session_path}')
    else:
        session_dir = session_path

    if not os.path.exists(session_dir):
        return {'success': False, 'error': f'Session directory not found: {session_dir}'}

    state = load_session_state(session_dir)
    if not state:
        return {'success': False, 'error': 'No session-state.json found'}

    compat = check_resume_compatibility(state, voice, tts_engine)
    for warning in compat['warnings']:
        print(f'Warning: {warning}', flush=True)

    sentences_dir = os.path.join(state['process_dir'], *SENTENCES_SUBPATH)
    if not os.path.exists(sentences_dir):
        return {'success': False, 'error': f'Sentences directory not found: {sentences_dir}'}

    scan_result = scan_completed_sentences(sentences_dir, state['total_sentences'])

    if scan_result['missing_count'] == 0:
        return {
            'success': True,
            'complete': True,
            'message': 'All sentences already complete - ready for assembly',
            'session_id': state['session_id'],
            'session_dir': session_dir,
            'process_dir': state['process_dir']
        }

    missing_ranges = calculate_missing_ranges(scan_result['missing'])

    return {
        'success': True,
        'complete': False,
        'session_id': state['session_id'],
        'session_dir': session_dir,
        'process_dir': state['process_dir'],
        'chapters_dir': os.path.join(state['process_dir'], 'chapters'),
        'chapters_dir_sentences': sentences_dir,
        'total_sentences': state['total_sentences'],
        'total_chapters': state['total_chapters'],
        'completed_sentences': scan_result['completed_count'],
        'missing_sentences': scan_result['missing_count'],
        'missing_indices': scan_result['missing'],
        'missing_ranges': missing_ranges,
        'progress_percent': scan_result['progress_percent'],
        'chapters': state.get('chapters', []),
        'metadata': state.get('metadata', {}),
        'warnings': compat['warnings']
    }
