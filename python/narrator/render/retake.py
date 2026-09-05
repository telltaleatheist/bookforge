"""Per-sentence re-render - Studio's "Correct Sentences" flow.

Ported from ebook2audiobook@9daab0ba:
  worker.py                              main()'s parsing of --sentence_indices,
                                         --num_takes, --take_temperatures and
                                         --sentence_overrides (431-465)
  bookforge_ext/parallel/worker_core.py  the take loop inside run_worker_tts
                                         (379-441) - which lives in render/worker.py

A retake is NOT a different renderer. It is `render.worker.run_worker` with four
extra inputs, in ONE model load:

  --sentence_indices     an explicit, scattered set of global 0-based indices
  --sentence_overrides   a JSON file, {index: replacement text}
  --num_takes            render each index this many times
  --take_temperatures    a temperature per take; its COUNT sets num_takes

This module owns the parsing and validation of those four (which in e2a lived in
`worker.py:main`, not in the loop) and nothing else. The loop, the take
directories and the progress lines are `render/worker.py`'s, unchanged, so a
retake and a book render cannot drift apart.

WHERE THE TAKES LAND, and who picks the winner
----------------------------------------------

`<--sentences_dir>/take<k>/<index>.flac`, `k` counting from 0 in the order of
`--take_temperatures`.

The subdirectories are written whenever `num_takes > 1` OR any
`--take_temperatures` was given - so a single-temperature "long override" take
still lands in `take0/` rather than beside the book's audio. That is
deliberate and load-bearing: `electron/correct-sentences-bridge.ts:429-441`
globs `take0 .. take<n-1>` under the scratch directory it passed as
`--sentences_dir`, and would find nothing if a one-take run wrote a bare
`<index>.flac`.

**e2a NEVER PICKS A WINNER, and neither does narrator.** The takes are
candidates. A person listens to them in Studio and commits one;
`correct-sentences-bridge.ts:482-517` then backs the original up to
`<sentencesDir>/.orig-backup/<index>.flac` (once) and renames the chosen take
over `<sentencesDir>/<index>.flac`. Nothing in Python ranks, scores or selects.
Adding a selector here would be a new behaviour, not a port.

Two other facts about the retake spawn, from the same bridge:

- The target directory is a SCRATCH dir, never the live sentence cache. The
  book's audio is only touched at commit time.
- Every candidate is transcoded to the book's own `sample_fmt` by the bridge
  (`matchSampleFmtInPlace`, 163-174) before it is offered - which is what keeps
  a committed take inside the assembler's FLAC homogeneity guard.

AN EDITED SENTENCE'S TEXT IS NOT WRITTEN BACK ANYWHERE
------------------------------------------------------

`--sentence_overrides` reaches exactly one place: the string handed to the
engine for THIS render (`render/worker.py:_text_for`). Nothing writes it into
`session-state.json`'s `chapter_sentences`, and every consumer of the chunk's
TEXT reads it from there - the VTT
(`bookforge_ext/parallel/session.py:build_vtt_file`), the manifest
(`render/session_v1.py`), and Studio's own cue list
(`correct-sentences-bridge.ts:281-283`, which reads `chapter_sentences`
directly and says so). So after committing an edited take the audio says one
thing and the transcript says another, permanently.

This is e2a's behaviour exactly and is preserved (see
`render/PORT_NOTES.md` section 9). It is not fixable here: the fix is for the
edit to land in whatever owns the chunk text, which is prep's manifest -
migration step 4.
"""
from __future__ import annotations

import json
import os

from .worker import WorkerRequest, run_worker


class RetakeArgumentError(ValueError):
    """A retake input that cannot be used. Carries e2a's own message text where
    e2a had one, because these strings are what a CLI user sees."""


def parse_sentence_indices(raw: str | None) -> list[int] | None:
    """`--sentence_indices "3,7,11"` -> [3, 7, 11]. e2a worker.py:432-441.

    None (the flag absent) means "use the range"; an EMPTY list is refused,
    because a caller who typed the flag meant to name something.
    """
    if raw is None:
        return None
    try:
        indices = [int(x) for x in raw.split(',') if x.strip() != '']
    except ValueError:
        raise RetakeArgumentError(
            '--sentence_indices must be a comma-separated list of integers')
    if not indices:
        raise RetakeArgumentError('--sentence_indices was provided but empty')
    return indices


def parse_take_temperatures(raw: str | None) -> list[float] | None:
    """`--take_temperatures "0.4,0.8,1.0"` -> [0.4, 0.8, 1.0]. e2a worker.py:444-453."""
    if raw is None:
        return None
    try:
        temps = [float(x) for x in raw.split(',') if x.strip() != '']
    except ValueError:
        raise RetakeArgumentError(
            '--take_temperatures must be a comma-separated list of numbers')
    if not temps:
        raise RetakeArgumentError('--take_temperatures was provided but empty')
    return temps


def parse_sentence_overrides(path: str | None) -> dict[int, str] | None:
    """Read `{index: text}` out of the overrides JSON. e2a worker.py:457-465.

    The file is written by `correct-sentences-bridge.ts:391-395` at
    `<scratchRoot>/candidates/overrides.json`. Keys arrive as JSON strings and
    are coerced to int; values to str - both exactly as e2a coerced them.
    """
    if path is None:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        return {int(k): str(v) for k, v in raw.items()}
    except Exception as e:
        raise RetakeArgumentError(f'failed to read --sentence_overrides: {e}') from e


def effective_num_takes(num_takes: int, take_temperatures: list[float] | None) -> int:
    """The temperature list's LENGTH wins when it is present. e2a worker.py:454."""
    return len(take_temperatures) if take_temperatures else num_takes


def take_dir(sentences_dir: str, take: int, multi_take: bool) -> str:
    """Where take `take` is written. The one definition of the layout.

    `multi_take` mirrors `render/worker.py`: `num_takes > 1 or bool(take_temperatures)`.
    """
    return os.path.join(sentences_dir, f'take{take}') if multi_take else sentences_dir


def is_multi_take(num_takes: int, take_temperatures: list[float] | None) -> bool:
    return num_takes > 1 or bool(take_temperatures)


def candidate_files(sentences_dir: str, indices: list[int], num_takes: int,
                    take_temperatures: list[float] | None,
                    audio_format: str = 'flac') -> list[str]:
    """Every path a retake with these inputs is expected to produce, in the order
    Studio globs them (take 0 first, then index order within a take).

    Used by the tests and by anyone verifying a run; it computes paths and touches
    no filesystem.
    """
    multi = is_multi_take(num_takes, take_temperatures)
    takes = effective_num_takes(num_takes, take_temperatures)
    out = []
    for take in range(takes):
        base = take_dir(sentences_dir, take, multi)
        for i in indices:
            out.append(os.path.join(base, f'{i}.{audio_format}'))
    return out


def run_retake(request: WorkerRequest, engine_factory=None) -> dict:
    """Render `request`'s explicit indices, `num_takes` times, in one model load.

    A thin, VALIDATING wrapper over `run_worker`: the retake path is the same loop
    with `sentence_indices` set, and keeping it that way is what guarantees a
    retaken chunk goes through the same guards, the same gap classification and
    the same FLAC parameters as the chunk it replaces.

    Refuses a request with no `sentence_indices`, because a "retake" of a range is
    just a render and should say so.

    `engine_factory=None` means "the loop picks, from the session's engine id"
    (`render/worker.build_engine_for`). The default used to be the Orpheus
    factory, which would have silently retaken a Higgs chunk with Orpheus - the
    exact class of substitution `engine/registry.py` refuses to make.
    """
    if not request.sentence_indices:
        raise RetakeArgumentError(
            'run_retake() requires sentence_indices; a contiguous range is a '
            'render - call render.worker.run_worker.')
    if request.num_takes < 1:
        raise RetakeArgumentError(
            f'num_takes must be at least 1 (got {request.num_takes})')
    return run_worker(request, engine_factory=engine_factory)
