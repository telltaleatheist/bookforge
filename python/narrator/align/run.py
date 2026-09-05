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
which `assemble()` consults for an engine whose policy is enforced.

A CHUNK THAT FAILS TO ALIGN STOPS THE RUN, naming the chunk (Owen's ruling,
2026-09-05). No second attempt, no other backend, and no partial VTT written on
top of a failure. `continue_on_error=True` (`--continue-on-error`) is the
deliberate opposite for a sweep: it records every failure in the report's
`errors` with its index and the aligner's own message and finishes the pass, so
an operator auditing a 1,400-chunk book sees all of them once instead of one per
run. Neither mode invents anything for a failed chunk - it contributes no
sentence cues either way.
"""

from __future__ import annotations

import json
import os
from typing import Optional, Sequence

from ..assemble.engine_profiles import profile_for
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
#: The sentence VTT's suffix. `<stem>.vtt` is the chunk-level file; this sits
#: beside it and never replaces it.
SENTENCE_VTT_SUFFIX = '.sentences.vtt'


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
                  continue_on_error: bool = False,
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
        f'device {device}, enforced={policy.enforced}')
    if not jobs:
        raise AlignerError('every selected chunk is marker-only; there is '
                           'nothing to align')

    results = _run(jobs, python_exe, backend, log)

    cues = []
    coverages = []
    errors = []
    for (chunk, start, end), result in zip(aligned_spans, results):
        if not result['ok']:
            if not continue_on_error:
                raise AlignerError(
                    f'chunk {chunk.index} failed to align, so the run stops '
                    f'here and writes nothing: {result["error"]}\n'
                    f'Pass --continue-on-error to audit the whole book and '
                    f'collect every failure in the report instead.')
            errors.append({'index': chunk.index, 'stage': 'align',
                           'error': result['error']})
            log(f'[align] chunk {chunk.index} FAILED to align: {result["error"]}')
            continue
        alignment = alignment_from_dict(result['alignment'])
        coverages.append(evaluate_chunk(alignment, policy, index=chunk.index))
        try:
            cues.extend(sentence_cues(
                alignment, chunk_index=chunk.index, chunk_start_s=start,
                chunk_end_s=end, is_heading=chunk.kind == 'heading',
                text=chunk.text))
        except AlignerError as refused:
            if not continue_on_error:
                raise AlignerError(
                    f'chunk {chunk.index} produced no sentence cues, so the run '
                    f'stops here and writes nothing: {refused}\n'
                    f'Pass --continue-on-error to audit the whole book instead.')
            errors.append({'index': chunk.index, 'stage': 'cues',
                           'error': str(refused)})
            log(f'[align] chunk {chunk.index} produced no sentence cues: {refused}')

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
    return {'document': document, 'cues': cues}


def _run(jobs, python_exe, backend, log):
    """Align every job, here or in another interpreter."""
    if python_exe:
        log(f'[align] running the aligner in {python_exe}')
        return align_env.run_jobs(python_exe, jobs)

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
    return out


def write_outputs(result: dict, *, vtt_path: Optional[str],
                  report_path: Optional[str], log=None) -> dict:
    """Write whichever of the two outputs was asked for; return their paths."""
    log = log if log is not None else (lambda line: print(line, flush=True))
    written = {}
    if vtt_path:
        cues = result['cues']
        if not cues:
            raise AlignerError(
                f'no chunk produced a sentence cue, so {vtt_path} would be an '
                f'empty transcript; see the report for why')
        write_sentence_vtt(cues, vtt_path)
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
