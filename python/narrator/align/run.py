"""`narrator align` - align a rendered session, write the sentence VTT and the
coverage report.

One pass over the manifest's chunks:

  1. the chunk's cue span comes from `assemble/vtt.chunk_spans` - the SAME
     running sum of sample counts the chunk-level VTT uses, imported rather than
     copied, so a sentence cue can never fall outside its own chunk's cue;
  2. the chunk's audio is force-aligned against its SPOKEN text (markers
     stripped with `paragraph_packer.spoken`, which is the reading the engine
     prompt and the VTT cue take);
  3. `sentences.sentence_cues` places one cue per sentence inside that span;
  4. `coverage.evaluate_chunk` judges the chunk against its ENGINE's policy.

WHAT COMES OUT. `<stem>.sentences.vtt` (additive - the chunk-level `<stem>.vtt`
is untouched and stays what training and the bridges read) and `coverage.json`,
which `assemble()` reports on. BOTH ARE WRITTEN EVERY TIME.

THE RUN ALWAYS AUDITS THE WHOLE BOOK. Owen's ruling, 2026-09-05:

    there will always be truncations or errors of some sort. thats the nature of
    tts. nothing is going to come out perfect. we try our best to detect and
    reduce the number of errors but assembly will never function, ever, if we
    expect it to come out the other side flawless. we need to base assembly on
    the expected text and the actual real length of the audio.

So a chunk the aligner cannot place no longer stops the pass and no longer costs
the book its transcript. It is RECORDED in the report's `errors` with its index
and the aligner's own message, and its sentences are cued by
`assemble/sentence_vtt.proportional_cues` - the expected text spread over the
chunk's real audio span, every cue MARKED as an estimate in the VTT itself. Same
for a chunk that aligned but whose measured cues had to be refused (a sentence
with no placed word): the refusal is named under stage `cues` and the chunk is
estimated. Nothing is invented silently; the report names the chunk and the file
says the cue is a guess.

AND FOR A CHUNK WHOSE MEASUREMENT THIS MODULE DOES NOT BELIEVE (2026-09-08,
stage `gate`). The qwen3 backend has no confidence and never refuses - it PLACES
a window whose text does not match the speech - so `gate_refusal` checks each
chunk's measured cues against the proportional estimate for the same chunk and
against their own quality dicts, and a chunk that fails is recorded and
estimated exactly like one the aligner could not place. `GATE_MAX_SHIFT_S` is
the one number.

An earlier design stopped at the first failure and wrote nothing, with
`--continue-on-error` as the opt-in sweep. That made a 50-chunk book with 5
unplaceable chunks unassemblable, which is the thing the ruling forbids. The
sweep is now the only behaviour and the flag is a no-op that says so.
"""

from __future__ import annotations

import json
import os
from typing import Optional, Sequence

from ..assemble.engine_profiles import profile_for
from ..assemble.sentence_vtt import (SENTENCE_VTT_SUFFIX, SentenceVttError,
                                     count_estimated, proportional_cues)
from ..assemble.vtt import chunk_spans
from ..manifest import Manifest
from ..text.paragraph_packer import spoken
from . import env as align_env
from .aligner import (DEFAULT_BACKEND, SCORE_SOURCE_BY_BACKEND, AlignerError,
                      align_chunk, alignment_from_dict, load_backend)
from .coverage import coverage_document, evaluate_chunk
from .sentences import sentence_cues, write_sentence_vtt

#: What the report is called when the caller does not name one, and what
#: `assemble()` looks for beside a session. A constant, not a search.
DEFAULT_REPORT_NAME = 'coverage.json'
#: The sentence VTT's suffix - re-exported from `assemble/sentence_vtt.py`, where
#: it has to live because assembly writes the same file when no report exists and
#: assembly may not import this package. `cli.py` and the tests import it here.
__all__ = ['DEFAULT_REPORT_NAME', 'GATE_MAX_SHIFT_S', 'SENTENCE_VTT_SUFFIX',
           'align_session', 'engine_id_of', 'gate_refusal', 'write_outputs']


def engine_id_of(manifest: Manifest) -> str:
    """Which engine rendered this book.

    The optional `engine` block when the manifest carries one; otherwise the
    voice's recorded `tts_engine`, which is a real value from the session state
    and not a guess. `profile_for` refuses anything it has no policy for.
    """
    if manifest.engine is not None:
        return manifest.engine.id
    return manifest.voice.engine


def align_session(manifest: Manifest, *, backend: str = DEFAULT_BACKEND,
                  language: str = 'en', device: str = 'cpu',
                  python_exe: Optional[str] = None,
                  ffmpeg: Optional[str] = None,
                  indices: Optional[Sequence[int]] = None,
                  workers: int = 1,
                  pace_chars_per_sec: Optional[float] = None,
                  chapter_gap: float = 0.0,
                  progress=None) -> dict:
    """Align a rendered session. Returns `(document, cues)` as a dict.

    `python_exe` runs the alignments in ANOTHER interpreter over
    `align/worker.py`'s protocol - the whisperx env, from a narrator that has no
    torch. None means "in this process", and the caller is refused by name if
    this process cannot import the backend.

    `workers` is how many of those interpreters run at once (`env.run_jobs`).
    It is a property of the OUT-OF-PROCESS route only: 1, the default, is the
    single process the app has always spawned, and asking for more without
    `python_exe` is refused by name rather than silently ignored.

    `pace_chars_per_sec` is the voice's measured speaking rate, used only by the
    RATE factor of a DERIVED word score (`aligner._derive_scores`, i.e. the
    qwen3 backend). IT IS NOT READ OFF THE MANIFEST, because the manifest has no
    such field: `Manifest.voice` carries `engine`/`fineTuned`/the model
    directories and `Manifest.engine` carries `pads`/`edgeFadeMs` - a pace lives
    in BookForge's voice catalog and has never been written into a render
    manifest. So a caller that knows it passes it; everybody else passes None
    and every chunk measures its own, which the Alignment records as
    `pace_source='chunk'`. Inventing a manifest field for it here would be
    inventing the number.

    `chapter_gap` is the silence ASSEMBLY will leave between chapters
    (`assemble.assemble(chapter_gap=...)`), in seconds. The cues written here are
    sealed into the m4b as its subtitle track, so they are timed against the
    finished audiobook: the value must be the one assembly is given, and a
    default of 0.0 is what every session assembled without a chapter gap wants.
    The audio this pass MEASURES is the session's own chunks, which never contain
    the gap; only the cue times move.
    """
    log = progress if progress is not None else (lambda line: print(line, flush=True))

    engine = engine_id_of(manifest)
    policy = profile_for(engine).coverage
    wanted = None if indices is None else set(int(i) for i in indices)

    spans = [(chunk, start, end)
             for chunk, start, end in chunk_spans(manifest, 'align', chapter_gap)
             if wanted is None or chunk.index in wanted]
    if not spans:
        raise AlignerError(
            f'no chunk of this session matches {sorted(wanted or ())}')

    # A MARKER-ONLY CHUNK IS SKIPPED, NOT FAILED. `[break]` rows speak nothing,
    # so their spoken text is empty and there is no alignment to make: a chunk
    # like that carries silence by design (e2a renders one as its gap) and
    # calling it an alignment failure would refuse a book for being correct.
    # It is COUNTED, so an enforced engine can still check that every chunk was
    # accounted for.
    jobs, skipped = [], []
    aligned_spans = []
    for chunk, start, end in spans:
        text = spoken(chunk.text)
        path = os.path.join(manifest.source.processDir, chunk.file) \
            if not os.path.isabs(chunk.file) else chunk.file
        if not text:
            skipped.append({'index': chunk.index, 'reason': 'no spoken text',
                            'text': chunk.text})
            continue
        aligned_spans.append((chunk, start, end))
        jobs.append({'index': chunk.index, 'audioPath': path, 'text': text,
                     'language': language, 'backend': backend,
                     'device': device, 'ffmpeg': ffmpeg,
                     'paceCharsPerSecond': pace_chars_per_sec})

    score_source = SCORE_SOURCE_BY_BACKEND[backend]
    log(f'[align] {len(jobs)} chunk(s) to align, {len(skipped)} marker-only '
        f'chunk(s) skipped; engine {engine}, backend {backend}, '
        f'device {device}, scores {score_source}, audited={policy.audited}')
    if not jobs:
        raise AlignerError('every selected chunk is marker-only; there is '
                           'nothing to align')

    results = _run(jobs, python_exe, backend, log, workers)

    cues = []
    coverages = []
    errors = []
    for (chunk, start, end), result in zip(aligned_spans, results):
        if not result['ok']:
            _estimate(chunk, start, end, stage='align',
                      message=result['error'], cues=cues, errors=errors, log=log)
            continue
        alignment = alignment_from_dict(result['alignment'])
        coverages.append(evaluate_chunk(alignment, policy, index=chunk.index))
        try:
            measured = sentence_cues(
                alignment, chunk_index=chunk.index, chunk_start_s=start,
                chunk_end_s=end, is_heading=chunk.kind == 'heading',
                text=chunk.text)
        except AlignerError as refused:
            _estimate(chunk, start, end, stage='cues', message=str(refused),
                      cues=cues, errors=errors, log=log)
            continue
        # THE GATE. A measurement this module cannot believe is estimated
        # instead, and says so - see `gate_refusal`.
        refusal = gate_refusal(measured, chunk_index=chunk.index,
                               chunk_start_s=start, chunk_end_s=end,
                               text=chunk.text,
                               is_heading=chunk.kind == 'heading')
        if refusal is not None:
            _estimate(chunk, start, end, stage='gate', message=refusal,
                      cues=cues, errors=errors, log=log)
            continue
        cues.extend(measured)

    # The cues come out in the order the chunks were walked, which is manifest
    # order for a whole-book pass - but `--indices` walks a subset and an
    # estimated chunk contributes its cues from a different branch, so the sort
    # is what guarantees `build_sentence_vtt`'s monotonicity check is a check
    # rather than a coin toss.
    cues.sort(key=lambda cue: (cue.start_s, cue.chunk_index, cue.sentence_index))

    document = coverage_document(
        coverages, engine_id=engine, policy=policy, backend=backend,
        language=language, score_source=score_source,
        session_id=manifest.source.sessionId,
        process_dir=manifest.source.processDir,
        chunks_in_manifest=sum(len(c.chunks) for c in manifest.chapters),
        errors=errors, skipped=skipped)
    summary = document['summary']
    log(f'[align] {summary["chunksAligned"]} aligned, '
        f'{summary["chunksFailed"]} failed coverage, {summary["errors"]} error(s); '
        f'median ratio {summary["alignedRatioMedian"]}, '
        f'median {summary["secondsPerChunkMedian"]}s/chunk')
    estimated = count_estimated(cues)
    if estimated:
        log(f'[align] {estimated} of {len(cues)} sentence cue(s) are ESTIMATES '
            f'- expected text over the chunk\'s real audio, marked in the VTT')
    return {'document': document, 'cues': cues}


#: How far a MEASURED cue's start may sit from the PROPORTIONAL start the same
#: sentence would have been given, before this module stops believing the
#: measurement and estimates the whole chunk instead. Seconds.
#:
#: THIS IS A FIRST ESTIMATE, NOT A MEASUREMENT, and it is chosen from the Mac
#: bake-off of 2026-09-08 (M-series, mps bf16, Shift's first hour, 61 chunk
#: starts scored against the assembled m4b): qwen3's five gross misses were
#: +3.5 s, -7.8 s and three tiny chunks collapsed onto ONE position 2.1-5.7 s
#: from where they belong, while every prose chunk it placed well sat within
#: 1.5 s of its proportional position. 2.0 s is the gap between those two
#: populations. Widen it if a real book's good chunks start tripping it; the
#: number is here, once, so that is one edit.
GATE_MAX_SHIFT_S = 2.0


def gate_refusal(measured: Sequence, *, chunk_index: int,
                 chunk_start_s: float, chunk_end_s: float, text: str,
                 is_heading: bool) -> Optional[str]:
    """Do this chunk's MEASURED cues survive a sanity check? None = yes.

    WHY A GATE AT ALL. qwen3 has no confidence and never refuses (see
    `aligner.py`): a window whose printed text differs from the speech is
    PLACED, not rejected. On Shift that was 59 headings and tiny chunks, and on
    the Mac's first hour it was five gross misses including three tiny chunks
    all predicted at one position. The aligner will not tell a caller that
    happened, so the caller measures it - against the one other answer it has,
    the proportional estimate over the chunk's own real audio.

    WHAT IS ALREADY SAFE, AND SO IS NOT CHECKED HERE. `sentences.sentence_cues`
    builds every cue INSIDE the chunk's own manifest span: the first cue starts
    at `chunk_start_s` and the last ends at `chunk_end_s`, whatever the aligner
    said, and the interior seams are clamped to `MIN_CUE_S` apart. So a chunk
    can never be dragged onto another chunk's audio by this door, and a
    single-sentence chunk - which is what a heading is - cannot be moved at all.
    That is why the gross-miss mode costs this door nothing on headings and why
    the gate is about the INTERIOR of a multi-sentence chunk. The door where a
    sentence really can land seconds away is the whole-book one,
    `electron/scripts/align_audiobook.py`, which gates on the same constant
    against its own coarse expectation.

    THE THREE CHECKS:

      shift      a cue whose start is more than `GATE_MAX_SHIFT_S` from the
                 start the proportional estimate would have given it. This is
                 the one that fires in practice.
      order      a cue whose `quality['monotonic']` is False - the alignment
                 placed this sentence's words backwards. `sentence_cues` already
                 guarantees the between-cue half of monotonic for any chunk it
                 did not refuse, so a False here is the within-cue half.
      collapse   two cues in this chunk with the SAME start. Today's seam
                 arithmetic (`low = previous seam + MIN_CUE_S`) makes that
                 unreachable, and it is checked anyway because it is the shape
                 the Mac's worst case took (1857.5 / 1859.1 / 1861.1 s all
                 predicted at 1855.43) and because a future change to that
                 arithmetic must not be able to reintroduce it silently.

    Returns the refusal SENTENCE - naming the check and the numbers - so the
    caller can put it in the report's `errors` under stage 'gate'.
    """
    if not measured:
        return None
    starts = [cue.start_s for cue in measured]
    for position in range(1, len(starts)):
        if starts[position] == starts[position - 1]:
            return (
                f'gate/collapse: sentences {position - 1} and {position} of chunk '
                f'{chunk_index} were both placed at {starts[position]:.3f}s, so '
                f'one of them has no audio of its own')
    for cue in measured:
        if cue.quality is None:
            # Only `sentences.sentence_cues` produces the cues this function is
            # given, and it fills `quality` on every one of them. A None here is
            # a caller handing us something else, and guessing "probably fine"
            # would let an unmeasured cue through the one check that exists to
            # catch unmeasured cues.
            return (
                f'gate/order: chunk {chunk_index} sentence {cue.sentence_index} '
                f'carries no quality measurement, so nothing here can judge it')
        if not cue.quality['monotonic']:
            return (
                f'gate/order: chunk {chunk_index} sentence {cue.sentence_index} '
                f'has words the aligner placed out of order, so its cue is not a '
                f'reading of this sentence')

    expected = proportional_cues(
        chunk_index=chunk_index, chunk_start_s=chunk_start_s,
        chunk_end_s=chunk_end_s, text=text, is_heading=is_heading)
    if len(expected) != len(measured):
        # Both sides run the SAME splitter (`split_chunk_sentences`) over the
        # same text, so this cannot differ - and if it ever does, the two lists
        # are not about the same sentences and comparing them position by
        # position would compare a cue with somebody else's expectation.
        return (
            f'gate/shift: chunk {chunk_index} measured {len(measured)} cue(s) but '
            f'splits into {len(expected)} sentence(s); the measured cues and the '
            f'proportional estimate are not about the same text')
    for cue, guess in zip(measured, expected):
        shift = abs(cue.start_s - guess.start_s)
        if shift > GATE_MAX_SHIFT_S:
            return (
                f'gate/shift: chunk {chunk_index} sentence {cue.sentence_index} '
                f'was placed at {cue.start_s:.3f}s, {shift:.3f}s from the '
                f'{guess.start_s:.3f}s its share of the chunk\'s audio gives it '
                f'(limit {GATE_MAX_SHIFT_S:.1f}s)')
    return None


def _estimate(chunk, start: float, end: float, *, stage: str, message: str,
              cues: list, errors: list, log) -> None:
    """Record one chunk's failure BY NAME and cue it from its own audio anyway.

    The ruling of 2026-09-05 made concrete. Two things happen and both are
    visible: the report gains an `errors` row naming the chunk, the stage and
    the message the aligner gave, and the transcript gains cues that say - in
    the file - that they are proportional estimates rather than measurements.

    `stage` is one of `align` (the backend refused or blew up), `cues` (it
    aligned but a sentence had no placed word) or `gate` (it placed every
    sentence and `gate_refusal` did not believe where). All three end here
    because all three mean the same thing to the reader of the transcript:
    this chunk's cues are the estimate, and the report says why.

    A failure to lay even the estimate (a chunk whose manifest span is zero, so
    there is no audio to spread anything over) is recorded as its own `estimate`
    stage rather than swallowed: that is a broken manifest, not a bad render.
    """
    errors.append({'index': chunk.index, 'stage': stage, 'error': message})
    log(f'[align] chunk {chunk.index} FAILED at {stage}: {message}')
    try:
        estimated = proportional_cues(
            chunk_index=chunk.index, chunk_start_s=start, chunk_end_s=end,
            text=chunk.text, is_heading=chunk.kind == 'heading')
    except SentenceVttError as refused:
        errors.append({'index': chunk.index, 'stage': 'estimate',
                       'error': str(refused)})
        log(f'[align] chunk {chunk.index} could not even be estimated: {refused}')
        return
    cues.extend(estimated)
    log(f'[align] chunk {chunk.index}: {len(estimated)} ESTIMATED cue(s) over '
        f'its {end - start:.2f}s of audio')


#: How often the pass says how far it has got, in chunks. One line per chunk is
#: hundreds of lines in a job log for a measurement whose whole point is that it
#: is fast; one line per ten is a bar that moves visibly on a 130-chunk book and
#: costs nothing on a 1,400-chunk one. The LAST chunk always reports, so the
#: count a reader ends on is the real one rather than the last multiple of ten.
PROGRESS_EVERY = 10


def _progress_reporter(log):
    """`on_result(done, total)` -> the one line BookForge's Align row parses.

    The wording is a CONTRACT, not a log message: `electron/coverage-align-job.ts`
    matches `[align] aligned <done>/<total> chunk(s)` to move the row's bar and
    to give it a rate-based ETA. Changing the words silently stops the bar,
    which is why they are written down in both places.
    """
    def report(done: int, total: int) -> None:
        if done % PROGRESS_EVERY == 0 or done == total:
            log(f'[align] aligned {done}/{total} chunk(s)')
    return report


def _run(jobs, python_exe, backend, log, workers=1):
    """Align every job, here or in another interpreter.

    EVERY JOB, EITHER WAY. The out-of-process worker was always a batch protocol
    that finished its list; the in-process loop used to stop at the first bad
    chunk, which is the half of the old stop-on-failure design that lived here.
    Both now audit the whole book: a failed chunk is a RESULT with `ok: False`,
    and `align_session` turns it into a named error plus estimated cues.

    THE POOL IS THE SPAWNED ROUTE'S. `workers` > 1 spawns that many worker
    interpreters (Owen, 2026-09-08, on Shift: "align is taking way too long...
    3x slower than the TTS render" - 11.4 chunks/min, 115 min against a
    37-minute render). In process there is ONE interpreter and ONE loaded model,
    so there is nothing to spread the chunks over; asking for a pool here is
    refused by name rather than quietly aligning at 1, because the caller who
    asked for four workers would otherwise wait out the same 115 minutes and be
    told nothing.
    """
    progress = _progress_reporter(log)
    if python_exe:
        log(f'[align] running the aligner in {python_exe} with {workers} '
            f'worker process(es)')
        return align_env.run_jobs(python_exe, jobs, on_result=progress,
                                  workers=workers)

    if workers != 1:
        raise AlignerError(
            f'--workers {workers} asks for a pool of aligner processes, but this '
            f'run has no --python: in-process alignment is one interpreter with '
            f'one loaded model and cannot be spread over several. Pass --python '
            f'<the whisperx env>/python to use a pool, or --workers 1 to align '
            f'here.')

    if not align_env.backend_importable(backend):
        if backend == 'qwen3':
            # There is no BookForge component for this one: `qwen-asr` needs a
            # CUDA torch env, and the whisperx component is CPU-only by design.
            # So the hint names the install rather than a discovered path - and
            # `discover_align_python()` would have named the WHISPERX env, which
            # cannot import qwen_asr either.
            hint = ('`pip install qwen-asr` into a CUDA torch env and pass '
                    '--python <that env>/python; on this PC the WSL env '
                    '`qwen-align` has it')
        else:
            found = align_env.discover_align_python()
            hint = (f'Pass --python {found}' if found else
                    'Install "Ebook Alignment (WhisperX)" from Settings -> '
                    'Add-ons, then pass --python <that env>/python')
        raise AlignerError(
            f'this interpreter cannot import the {backend!r} backend, and no '
            f'--python was given. narrator will not pick an interpreter for '
            f'you. {hint}.')

    # Load before the first chunk is timed, for the same reason the worker does.
    seconds = load_backend(backend, jobs[0]['language'], jobs[0]['device'])
    log(f'[align] loaded {backend} in {seconds:.1f}s')

    out = []
    for job in jobs:
        try:
            alignment = align_chunk(
                job['audioPath'], job['text'], language=job['language'],
                backend=job['backend'], device=job['device'],
                ffmpeg=job['ffmpeg'],
                pace_chars_per_sec=job['paceCharsPerSecond'])
            out.append({'ok': True, 'index': job['index'],
                        'alignment': alignment.as_dict()})
        except AlignerError as refused:
            out.append({'ok': False, 'index': job['index'],
                        'error': str(refused)})
        progress(len(out), len(jobs))
    return out


def write_outputs(result: dict, *, vtt_path: Optional[str],
                  report_path: Optional[str], log=None) -> dict:
    """Write whichever of the two outputs was asked for; return their paths."""
    log = log if log is not None else (lambda line: print(line, flush=True))
    written = {}
    if vtt_path:
        cues = result['cues']
        if not cues:
            # Not "some chunks failed" - a failed chunk is ESTIMATED now, so an
            # empty cue list means not one chunk in the book had a span to lay
            # even an estimate over. That is a broken manifest.
            raise AlignerError(
                f'no chunk produced a sentence cue, not even an estimated one, '
                f'so {vtt_path} would be an empty transcript; see the report\'s '
                f'"errors" for why')
        try:
            write_sentence_vtt(cues, vtt_path)
        except SentenceVttError as bad:
            # The writer lives in `assemble/` (assembly writes this file too) and
            # raises its own type. `align`'s callers - the CLI, the queue's align
            # job - catch AlignerError and nothing else, so the boundary is
            # translated HERE rather than left to leak a traceback out of a door
            # whose whole contract is "refusals are named".
            raise AlignerError(str(bad)) from bad
        written['vtt'] = vtt_path
        log(f'[align] {len(cues)} sentence cue(s) -> {vtt_path}')
    if report_path:
        parent = os.path.dirname(os.path.abspath(report_path))
        os.makedirs(parent, exist_ok=True)
        with open(report_path, 'w', encoding='utf-8', newline='') as handle:
            json.dump(result['document'], handle, indent=2)
            handle.write('\n')
        written['report'] = report_path
        log(f'[align] coverage report -> {report_path}')
    return written
