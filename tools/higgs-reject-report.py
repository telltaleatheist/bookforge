#!/usr/bin/env python3
"""What the Higgs length guard threw away, transcribed and diffed against the
text it was given.

Owen, 2026-09-08, looking at a screen of guard fires on Shift: *"we should
probably whisper them and see what was missing. how much was missing, where it
stopped, etc. and pass it to the training agent."*

The guard already says a take was the WRONG LENGTH; it cannot say what the model
actually did with the words. This does: it reads a job's reject directory
(`HIGGS_REJECT_DIR`, written by `engine/higgs/truncation.py::keep_reject` - one
wav + one json per discarded take, plus an append-only `events.jsonl`),
transcribes every wav, and aligns the transcript to the chunk's own text.

WHAT IT ANSWERS, per discarded take:

  coverage      how much of the text was actually spoken (matched words /
                text words). A truncation's coverage is its cut point.
  stopped_at    for an early stop, the percentage through the text where the
                match ends, and the first words that were never spoken.
  extra         words in the audio that are not in the text, and whether they
                are a REPEAT of something the model already said (a run-on that
                loops) or new material (a run-on that invents).
  ratio         audio seconds over the seconds the text should take at the
                run's own pace, which is the number the guard fired on.

WHAT IT IS NOT: an aligner. Word timings here are whisper's, the match is
difflib over normalised words, and a chunk whose text is one long sentence read
with different contractions will show a lower coverage than a listener would.
It is a triage instrument for a training corpus, and every number it prints is
reproducible from the files it read.

USAGE (inside an env holding faster-whisper - BookForge's whisperx component env
or the WSL whisperx-cuda one; this script imports nothing from narrator):

    python tools/higgs-reject-report.py <reject-dir> [--model small.en]
        [--device cpu|cuda] [--out report.md] [--json report.json]

The reject directory is per job:
  Windows  %APPDATA%\\BookForge\\logs\\tts-rejects\\<jobId>
  macOS    ~/Library/Application Support/BookForge/logs/tts-rejects/<jobId>
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys

WORD_RE = re.compile(r"[a-z0-9']+")


def normalise(text: str) -> list:
    """Words, lowercased, punctuation dropped, the packer's markers removed.

    Deliberately crude and stated as such: it is the same normalisation on both
    sides of the diff, so a systematic loss (contractions, numerals read as
    words) shows up as a systematic and visible dent in coverage rather than as
    a silent bias in one direction.
    """
    text = re.sub(r'\[(break|heading|item|pause:[^\]]*)\]', ' ', text or '')
    return WORD_RE.findall(text.lower().replace('’', "'"))


def repeat_of_earlier(spoken: list, start: int, end: int, window: int = 6) -> bool:
    """Is the inserted span `spoken[start:end]` something already said?

    Checked as a `window`-word shingle against everything before it: a run-on
    that loops repeats a phrase, and a run-on that invents does not. Short
    insertions (< window) answer False rather than guessing.
    """
    span = spoken[start:end]
    if len(span) < window:
        return False
    head = ' '.join(span[:window])
    return head in ' '.join(spoken[:start])


def compare(text: str, transcript: str) -> dict:
    """The one comparison, so every field below is from the same alignment."""
    expected = normalise(text)
    spoken = normalise(transcript)
    if not expected:
        return {'error': 'the chunk has no words after normalisation'}
    matcher = difflib.SequenceMatcher(a=expected, b=spoken, autojunk=False)
    blocks = [b for b in matcher.get_matching_blocks() if b.size]
    matched = sum(b.size for b in blocks)
    last_expected = max((b.a + b.size for b in blocks), default=0)
    tail = expected[last_expected:]

    inserts = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ('insert', 'replace') and (j2 - j1) >= 3:
            inserts.append({
                'after_word': i1,
                'after_pct': round(100.0 * i1 / len(expected), 1),
                'words': j2 - j1,
                'repeat': repeat_of_earlier(spoken, j1, j2),
                'sample': ' '.join(spoken[j1:min(j2, j1 + 12)]),
            })
    return {
        'text_words': len(expected),
        'spoken_words': len(spoken),
        'matched_words': matched,
        'coverage': round(matched / len(expected), 3),
        'stopped_at_word': last_expected,
        'stopped_at_pct': round(100.0 * last_expected / len(expected), 1),
        'never_spoken_words': len(tail),
        'never_spoken_head': ' '.join(tail[:14]),
        'inserted_runs': inserts,
        'inserted_words': sum(run['words'] for run in inserts),
        'looped': any(run['repeat'] for run in inserts),
    }


def load_records(directory: str) -> list:
    """Every discarded take in the directory, from the per-take json files.

    `events.jsonl` carries the same records and is the fallback when a json was
    not written; the per-file read is preferred because it is what pairs a
    record with its wav on disk.
    """
    records = []
    for name in sorted(os.listdir(directory)):
        if not name.endswith('.json'):
            continue
        path = os.path.join(directory, name)
        with open(path, encoding='utf-8') as handle:
            record = json.load(handle)
        record['_stem'] = name[:-len('.json')]
        record['_wav'] = os.path.join(directory, record['_stem'] + '.wav')
        records.append(record)
    return records


def transcribe(model, wav: str) -> str:
    segments, _info = model.transcribe(wav, beam_size=1, language='en',
                                       condition_on_previous_text=False)
    return ' '.join(segment.text for segment in segments)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('directory', help='a job reject directory (HIGGS_REJECT_DIR)')
    parser.add_argument('--model', default='small.en', help='faster-whisper model (default small.en)')
    parser.add_argument('--device', default='cpu', help='cpu | cuda (default cpu)')
    parser.add_argument('--compute-type', default=None,
                        help='faster-whisper compute type (default int8 on cpu, float16 on cuda)')
    parser.add_argument('--out', default=None, help='markdown report path (default <dir>/reject-report.md)')
    parser.add_argument('--json', dest='json_out', default=None,
                        help='machine-readable path (default <dir>/reject-report.json)')
    args = parser.parse_args()

    directory = os.path.abspath(args.directory)
    if not os.path.isdir(directory):
        print(f'not a directory: {directory}', file=sys.stderr)
        return 2
    records = load_records(directory)
    if not records:
        print(f'no reject records in {directory} - the run kept nothing, or '
              'HIGGS_REJECT_DIR was not set for it.', file=sys.stderr)
        return 1

    from faster_whisper import WhisperModel
    compute = args.compute_type or ('float16' if args.device == 'cuda' else 'int8')
    print(f'loading faster-whisper {args.model} on {args.device} ({compute})…', file=sys.stderr)
    model = WhisperModel(args.model, device=args.device, compute_type=compute)

    results = []
    for i, record in enumerate(records, 1):
        wav = record['_wav']
        if not os.path.exists(wav):
            print(f'  [{i}/{len(records)}] {record["_stem"]}: no wav', file=sys.stderr)
            continue
        print(f'  [{i}/{len(records)}] {record["_stem"]}…', file=sys.stderr)
        transcript = transcribe(model, wav)
        row = {k: v for k, v in record.items() if not k.startswith('_')}
        row['stem'] = record['_stem']
        row['transcript'] = transcript.strip()
        row.update(compare(record.get('text', ''), transcript))
        results.append(row)

    out_md = args.out or os.path.join(directory, 'reject-report.md')
    out_json = args.json_out or os.path.join(directory, 'reject-report.json')
    with open(out_json, 'w', encoding='utf-8') as handle:
        json.dump({'directory': directory, 'model': args.model, 'rows': results},
                  handle, indent=1, ensure_ascii=False)

    lines = [f'# Higgs guard rejects — {os.path.basename(directory)}', '',
             f'{len(results)} discarded take(s), transcribed with faster-whisper `{args.model}`.',
             '', '| chunk | rung | side | chars | audio s | cps | coverage | stopped at | never spoken | extra words | looped |',
             '|---|---|---|---|---|---|---|---|---|---|---|']
    for row in sorted(results, key=lambda r: (r.get('index', 0), r.get('depth', 0))):
        lines.append('| {index} d{depth} | {rung} | {side} | {chars} | {seconds} | {cps} | {cov} | {stop}% | {never} | {extra} | {loop} |'.format(
            index=row.get('index'), depth=row.get('depth', 0), rung=row.get('rung', ''),
            side=row.get('side', ''), chars=row.get('chars', ''), seconds=row.get('seconds', ''),
            cps=row.get('chars_per_second', ''), cov=row.get('coverage', ''),
            stop=row.get('stopped_at_pct', ''), never=row.get('never_spoken_words', ''),
            extra=row.get('inserted_words', 0), loop='yes' if row.get('looped') else ''))
    lines += ['', '## Per chunk', '']
    for row in sorted(results, key=lambda r: (r.get('index', 0), r.get('depth', 0))):
        lines += [f"### chunk {row.get('index')} (depth {row.get('depth', 0)}, {row.get('side')}, "
                  f"{row.get('chars')} chars in {row.get('seconds')} s)",
                  '',
                  f"- coverage **{row.get('coverage')}** — {row.get('matched_words')} of "
                  f"{row.get('text_words')} words matched; the model spoke {row.get('spoken_words')}.",
                  f"- match ends at **{row.get('stopped_at_pct')}%** of the text; "
                  f"{row.get('never_spoken_words')} words never spoken"
                  + (f", starting \"{row.get('never_spoken_head')}\"" if row.get('never_spoken_words') else '.')]
        for run in row.get('inserted_runs', []):
            lines.append(f"- {'REPEAT' if run['repeat'] else 'extra'} of {run['words']} words at "
                         f"{run['after_pct']}% of the text: \"{run['sample']}…\"")
        lines.append('')
    with open(out_md, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')

    print(f'\nwrote {out_md}\n      {out_json}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
