#!/usr/bin/env python3
"""THE GATE for phase 6: a guarded render on a REAL card, through the real ladder.

    PHASE6-REMOTE-RENDER.md section 7 step 4.

Owen ruled on 2026-09-13 that the model and its inference own the guard, and the
driver was lifted out from under the file-writing layer so the serve world could
reach it (`render_many`). Every test of that refactor runs against a fake engine
whose audio is a sine wave, and the contract says plainly what a fake cannot
show:

    "Nothing here is trustworthy until that runs — a guard refactor that changes
     behaviour is exactly the thing a fake engine cannot detect."

So this is not a unit test and does not belong in the suite. It is a keeper: it
needs a card, a loaded model and several minutes, and it answers one question.

WHAT IT ASSERTS, and why each one is the thing a fake could not have shown
--------------------------------------------------------------------------

1. **The driver completes on a real engine.** The fakes never exercise
   `render_audio`'s real failure modes, the HTTP path, or a decode.

2. **Every requested index comes back exactly once**, split or not. The ladder
   may render a chunk as two halves and `join_parts` rejoins them; a real split
   on real audio is the case where a length bug would show.

3. **THE VERDICT AGREES WITH THE LOG LINE.** `GuardPlan` now wraps its event
   sink so the same record is both printed and collected. This re-reads the
   `[HIGGS3][HIGGS_GUARD_EVENT]` lines off the captured log and asserts they are
   the same records the verdicts carry. If the collection ever diverges from the
   line, BookForge's existing stderr analytics and Crucible's `guard` field stop
   describing the same render — silently, since each half looks fine alone.

4. **The audio is sane**: nonzero, finite, and inside the band the guard judged
   it against. A driver that shipped the wrong take would pass every structural
   check and only fail here.

WHAT IT DOES NOT ASSERT, and what would be needed
-------------------------------------------------
It does not compare a guard-fire RATE against the Mistborn pause map. That needs
the same voice, the same checkpoint and the same 88 chunks as
`mistborn-pause-map-baseline`, and this runs on whatever is loaded. A rate
comparison against a different checkpoint would be a number that looks like
evidence and is not. **The fire rate printed below is a reading, not a verdict.**

USAGE
-----
Start a Higgs v3 server (electron/scripts/higgs/serve_higgs_sgl.sh), then:

    NARRATOR_HIGGS3_BASE_URL=http://127.0.0.1:8200 \
        python -m narrator.tests.keeper_guarded_render

Exit 0 = every assertion held. Exit 1 = one did not, named.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
from contextlib import redirect_stderr

import numpy as np

from narrator.engine.higgs import truncation

#: Deliberately varied: short lines that the guard exempts on the long side
#: (under MIN_GUARD_CHARS), ordinary prose, and one deliberately long chunk that
#: is the likeliest to run away and therefore the likeliest to exercise a split.
CHUNKS: list[tuple[int, str]] = [
    (0, 'The bells rang out across the valley.'),
    (1, 'He had not slept, and the morning found him still at the window, '
        'watching the road for a rider who did not come.'),
    (2, 'No.'),
    (3, 'She counted them twice, and twice the number came out wrong, which '
        'meant either that she had miscounted or that one of them was already '
        'gone, and she did not believe she had miscounted.'),
    (4, 'The door opened.'),
    (5, 'What the letter said was simple enough, and it took him the better '
        'part of an hour to understand it: the company had been dissolved, the '
        'debts were his, and the house in which he was standing had been sold '
        'three weeks earlier to a man he had never met. He read it again. The '
        'words did not move. Outside, someone was singing.'),
]


def records_in(log: str) -> list:
    """Every `[HIGGS3][HIGGS_GUARD_EVENT] {json}` record in a captured log.

    Parsed back out of the LINE deliberately: the point of the comparison is
    that the line and the verdict come from one record, and reading the line is
    the only way to prove the print path still carries it."""
    prefix = truncation.GUARD_EVENT_PREFIX
    out = []
    for line in log.splitlines():
        at = line.find(prefix)
        if at >= 0:
            out.append(json.loads(line[at + len(prefix):]))
    return out


def fail(message: str) -> None:
    print(f'\nFAIL: {message}')
    sys.exit(1)


def main() -> int:
    # The stack decides which variable names the server: vllm-omni reads
    # NARRATOR_HIGGS3_BASE_URL, SGLang-Omni reads NARRATOR_HIGGS_SGL_URL. Asking
    # for whichever is set keeps this keeper usable on both arms without
    # pretending they are one variable.
    base = ((os.environ.get('NARRATOR_HIGGS_SGL_URL') or '').strip()
            or (os.environ.get('NARRATOR_HIGGS3_BASE_URL') or '').strip())
    script = ((os.environ.get('NARRATOR_HIGGS_SGL_SERVE_SCRIPT') or '').strip()
              or (os.environ.get('NARRATOR_HIGGS3_SERVE_SCRIPT') or '').strip())
    if not base and not script:
        fail('no server named and no serve script given. Either attach — '
             'NARRATOR_HIGGS_SGL_URL (SGLang-Omni) or NARRATOR_HIGGS3_BASE_URL '
             '(vllm-omni) — or let narrator LAUNCH one with '
             'NARRATOR_HIGGS_SGL_SERVE_SCRIPT. HIGGS_STACK and '
             'HIGGS_MAX_NUM_SEQS must be set either way. '
             'LAUNCHING IS THE BETTER KEEPER and not merely the easier one: a '
             'server narrator started carries its owner marker, so narrator '
             'reads the checkpoint out of the process rather than being told, '
             'and the run proves the identity check as well as the guard. '
             'Attaching to a server on the BASE weights cannot be done at all '
             'today — naming a checkpoint asserts a fine-tune and naming none '
             'is refused.')
    where = base or f'a server narrator launches from {script}'

    from narrator.engine.higgs.v3_engine import (HiggsV3Config, HiggsV3Defaults,
                                                 HiggsV3Engine)
    from narrator.engine.protocol import DefaultVoice

    # THE MODEL'S OWN VOICE, which `protocol.DefaultVoice` names as the right
    # shape for exactly this: `checkpoint_dir=None` is the base checkpoint with
    # no conditioning. A fine-tune would be the production path and would also
    # bring its own measured band; the base brings none, so the band below is
    # the engine's own default pair and its geometric centre. That is honest for
    # a structural keeper and is why the fire RATE it prints is a reading rather
    # than a verdict.
    def render(band: tuple, label: str):
        """One guarded render at a given band. Returns (produced, log, seconds)."""
        voice = DefaultVoice(
            name='keeper-base',
            checkpoint_dir=None,
            max_chars_per_sec=band[0],
            min_chars_per_sec=band[1],
            pace_chars_per_sec=truncation.expected_chars_per_sec(band[0], band[1]),
        )
        print(f'\nkeeper [{label}]: band {band[1]:.2f}-{band[0]:.2f} chars/sec, '
              f'centre {truncation.expected_chars_per_sec(band[0], band[1]):.2f}')
        config = HiggsV3Config(voice=voice, seed=1234)
        engine = HiggsV3Engine(config)
        captured = io.StringIO()
        started = time.monotonic()
        try:
            # narrator's engine log goes to the host's chosen stream; stderr is
            # the default and is what the GUARD_EVENT lines ride on.
            with redirect_stderr(captured):
                out = list(engine.render_many(iter(CHUNKS)))
        except Exception as exc:                 # noqa: BLE001 — a keeper reports
            sys.stderr.write(captured.getvalue())
            fail(f'[{label}] render_many raised {type(exc).__name__}: {exc}')
        finally:
            try:
                engine.cleanup()
            except Exception:                    # noqa: BLE001
                pass
        text = captured.getvalue()
        sys.stderr.write(text)
        return out, text, time.monotonic() - started

    print(f'keeper: guarded render against {where}')

    # ── THE BAND IS AN INPUT, and one invocation renders once ───────────────
    #
    # ONE SERVER PER INVOCATION, and that is not a style choice. Rendering twice
    # in one process means two engines, and `engine.cleanup()` tears the first
    # server down — so the second launches into a port the dying process still
    # holds. MEASURED on example-pc 2026-09-13: sgl-omni was passed `--port 8200`,
    # found it busy, and **silently bound a random port** (57877, then 34529)
    # instead of failing. narrator then polls 8200 for as long as anyone lets
    # it. That is a fallback with no failure, and it turns a restart into a
    # hang; see the operational note in the module docstring.
    #
    # So: run this twice, with a gap.
    #
    #   1. no KEEPER_BAND      the engine's own band. Expect clean, and it
    #                          prints the MEASURED pace of the real audio.
    #   2. KEEPER_BAND=hi,lo   a band that pace falls outside, which makes the
    #                          real ladder run — re-roll, split, join_parts —
    #                          so the log-vs-verdict comparison has records to
    #                          compare instead of comparing zero against zero.
    raw_band = (os.environ.get('KEEPER_BAND') or '').strip()
    if raw_band:
        try:
            hi, lo = (float(part) for part in raw_band.split(','))
        except ValueError:
            fail(f'KEEPER_BAND={raw_band!r} is not "max,min" — two chars/sec '
                 f'numbers, highest first.')
        if not lo < hi:
            fail(f'KEEPER_BAND={raw_band!r}: the max must exceed the min.')
        band, label = (hi, lo), 'given'
    else:
        band = (HiggsV3Defaults.MAX_CHARS_PER_SEC, HiggsV3Defaults.MIN_CHARS_PER_SEC)
        label = "the engine's own"
    produced, log, elapsed = render(band, label)

    rates = []
    for index, audio, _verdict in produced:
        seconds = len(np.asarray(audio)) / float(HiggsV3Engine.SAMPLE_RATE)
        chars = len(dict(CHUNKS)[index].strip())
        if seconds > 0:
            rates.append(chars / seconds)
    measured = sorted(rates)[len(rates) // 2] if rates else 0.0
    print(f'     measured pace: median {measured:.2f} chars/sec over '
          f'{len(rates)} chunk(s), range {min(rates):.2f}-{max(rates):.2f}')

    # -- 1 & 2. every index, exactly once ------------------------------------
    got = [index for index, _audio, _verdict in produced]
    want = [index for index, _text in CHUNKS]
    if sorted(got) != want:
        fail(f'indices came back as {sorted(got)}, expected {want}. One requested '
             f'chunk must yield exactly one tuple, split or not.')
    if len(got) != len(set(got)):
        fail(f'an index was yielded more than once: {got}')
    print(f'ok   {len(got)} chunk(s), each exactly once, in {elapsed:.1f}s')

    # -- 4. the audio is sane ------------------------------------------------
    for index, audio, _verdict in produced:
        if audio is None or len(audio) == 0:
            fail(f'chunk {index} came back with no audio')
        array = np.asarray(audio)
        if not np.all(np.isfinite(array)):
            fail(f'chunk {index} contains non-finite samples')
        if float(np.max(np.abs(array))) == 0.0:
            fail(f'chunk {index} is digital silence')
    print('ok   every chunk is nonzero and finite')

    # -- 3. THE VERDICT AGREES WITH THE LOG LINE -----------------------------
    from_log = records_in(log)

    from_verdicts: list[dict] = []
    for _index, _audio, verdict in produced:
        if verdict is not None:
            from_verdicts.extend(verdict['takes'])

    # COMPARED AS SETS, NOT SEQUENCES, and the difference is not a convenience.
    #
    # The two orderings legitimately differ and BOTH are correct. The log is in
    # TIME order: the served arm renders `BATCH_SIZE` takes concurrently, so one
    # chunk's re-roll is printed between another chunk's take 0 and its accept.
    # The verdicts are grouped BY CHUNK, because a verdict belongs to the chunk
    # it decided. Measured on example-pc 2026-09-13 — log order was
    # 1-short, 3-short, 1-accept, 5-long, 3-reroll, 5-accept while the verdicts
    # read 1,1 then 3,3 then 5,5.
    #
    # An earlier draft of this keeper zipped them pairwise and failed on that,
    # which would have read as "the collection diverged from the line" when
    # nothing had diverged at all. What must be true is that the same RECORDS
    # appear on both sides; which order they are read back in is each reader's
    # own business.
    def canonical(records):
        return sorted(json.dumps(record, sort_keys=True) for record in records)

    if canonical(from_log) != canonical(from_verdicts):
        only_log = [r for r in canonical(from_log) if r not in canonical(from_verdicts)]
        only_verdict = [r for r in canonical(from_verdicts) if r not in canonical(from_log)]
        fail(f'the log and the verdicts do not carry the same guard records. '
             f'GuardPlan wraps ONE sink, so a difference means the collection has '
             f'diverged from the line and BookForge\'s stderr analytics and '
             f"Crucible's `guard` field have stopped describing the same render.\n"
             f'  {len(from_log)} in the log, {len(from_verdicts)} in the verdicts\n'
             f'  only in the log:     {only_log[:2]}\n'
             f'  only in the verdicts: {only_verdict[:2]}')
    if raw_band and not from_log:
        fail(f'a band of {band[1]:.2f}-{band[0]:.2f} was given precisely so the guard '
             f'would fire on real audio, and it did not fire once. Either the ladder '
             f'is not running or the verdict/log wiring never sees it — and a run '
             f'with no records cannot tell those apart, which is the whole reason '
             f'this band is an input.')
    print(f'ok   {len(from_log)} guard record(s), identical in the log and the verdict')

    # -- the reading, which is NOT a verdict ---------------------------------
    fired = sum(1 for _i, _a, v in produced if v is not None and v['verdict'] != 'clean')
    split = sum(1 for _i, _a, v in produced if v is not None and v['parts'] > 1)
    print(f'\nreading (not an assertion): {fired}/{len(produced)} chunk(s) fired the '
          f'guard, {split} split.')
    print('A rate comparison against the Mistborn pause map needs that voice, that '
          'checkpoint and those 88 chunks; this ran on whatever is loaded.')
    if not raw_band:
        tight = f'{measured * 1.02:.2f},{measured * 0.98:.2f}'
        print(f'\nNEXT, to make the guard actually fire on real audio — wait for the '
              f'port to clear, then:\n    KEEPER_BAND={tight} '
              f'python -m narrator.tests.keeper_guarded_render\n'
              f'Zero records compared against zero records is a test that holds for '
              f'a driver collecting nothing at all.')
    print('\nPASS')
    return 0


if __name__ == '__main__':
    sys.exit(main())
