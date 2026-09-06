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
from .aligner import (DEFAULT_BACKEND, AlignerError, align_chunk,
                      alignment_from_dict, load_backend)
from .coverage import coverage_document, evaluate_chunk
from .sentences import sentence_cues, write_sentence_vtt

#: What the report is called when the caller does not name one, and what
#: `assemble()` looks for beside a session. A constant, not a search.
DEFAULT_REPORT_NAME = 'coverage.json'
#: The sentence VTT's suffix - re-exported from `assemble/sentence_vtt.py`, where
#: it has to live because assembly writes the same file when no report exists and
#: assembly may not import this package. `cli.py` and the tests import it here.
__all__ = ['DEFAULT_REPORT_NAME', 'SENTENCE_VTT_SUFFIX', 'align_session',
           'engine_id_of', 'write_outputs']


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
                  progress=None) -> dict:
    """Align a rendered session. Returns `(document, cues)` as a dict.

    `python_exe` runs the alignments in ANOTHER interpreter over
    `align/worker.py`'s protocol - the whisperx env, from a narrator that has no
    torch. None means "in this process", and the caller is refused by name if
    this process cannot import the backend.
    """
    log = progress if progress is not None else (lambda line: print(line, flush=True))

    engine = engine_id_of(manifest)
    policy = profile_for(engine).coverage
    wanted = None if indices is None else set(int(i) for i in indices)

    spans = [(chunk, start, end) for chunk, start, end in chunk_spans(manifest, 'align')
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
                     'device': device, 'ffmpeg': ffmpeg})

    log(f'[align] {len(jobs)} chunk(s) to align, {len(skipped)} marker-only '
        f'chunk(s) skipped; engine {engine}, backend {backend}, '
        f'device {device}, audited={policy.audited}')
    if not jobs:
        raise AlignerError('every selected chunk is marker-only; there is '
                           'nothing to align')

    results = _run(jobs, python_exe, backend, log)

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
            cues.extend(sentence_cues(
                alignment, chunk_index=chunk.index, chunk_start_s=start,
                chunk_end_s=end, is_heading=chunk.kind == 'heading',
                text=chunk.text))
        except AlignerError as refused:
            _estimate(chunk, start, end, stage='cues', message=str(refused),
                      cues=cues, errors=errors, log=log)

    # The cues come out in the order the chunks were walked, which is manifest
    # order for a whole-book pass - but `--indices` walks a subset and an
    # estimated chunk contributes its cues from a different branch, so the sort
    # is what guarantees `build_sentence_vtt`'s monotonicity check is a check
    # rather than a coin toss.
    cues.sort(key=lambda cue: (cue.start_s, cue.chunk_index, cue.sentence_index))

    document = coverage_document(
        coverages, engine_id=engine, policy=policy, backend=backend,
        language=language, session_id=manifest.source.sessionId,
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


def _estimate(chunk, start: float, end: float, *, stage: str, message: str,
              cues: list, errors: list, log) -> None:
    """Record one chunk's failure BY NAME and cue it from its own audio anyway.

    The ruling of 2026-09-05 made concrete. Two things happen and both are
    visible: the report gains an `errors` row naming the chunk, the stage and
    the message the aligner gave, and the transcript gains cues that say - in
    the file - that they are proportional estimates rather than measurements.

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


def _run(jobs, python_exe, backend, log):
    """Align every job, here or in another interpreter.

    EVERY JOB, EITHER WAY. The out-of-process worker was always a batch protocol
    that finished its list; the in-process loop used to stop at the first bad
    chunk, which is the half of the old stop-on-failure design that lived here.
    Both now audit the whole book: a failed chunk is a RESULT with `ok: False`,
    and `align_session` turns it into a named error plus estimated cues.
    """
    progress = _progress_reporter(log)
    if python_exe:
        log(f'[align] running the aligner in {python_exe}')
        return align_env.run_jobs(python_exe, jobs, on_result=progress)

    if not align_env.backend_importable(backend):
        found = align_env.discover_align_python()
        hint = (f'Pass --python {found}' if found else
                'Install "Ebook Alignment (WhisperX)" from Settings -> Add-ons, '
                'then pass --python <that env>/python')
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
                ffmpeg=job['ffmpeg'])
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
