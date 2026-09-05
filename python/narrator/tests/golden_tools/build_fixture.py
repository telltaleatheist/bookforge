"""Build one committed golden fixture from a LOCAL copy of an e2a session.

This is the script that produced `python/narrator/tests/golden/<slug>/`. It is
committed so a fixture can be rebuilt (or a fourth book added) without
reconstructing the recipe from the README.

Usage (from the worktree root, Windows interpreter):

    python -m narrator.tests.golden_tools.build_fixture \
        --slug kershaw \
        --process-dir  C:\\tmp\\narrator-golden\\kershaw\\ebook-<uuid>\\<hash> \
        --reference-m4b C:\\tmp\\narrator-golden\\kershaw\\reference.m4b \
        --reference-vtt C:\\tmp\\narrator-golden\\kershaw\\reference.vtt

Sample counts come from each FLAC's STREAMINFO header, read here from the
raw bytes. Nothing is decoded and ffprobe is never asked for a sample count:
decoding 2 GB of FLAC to learn 1400 integers is absurd, and ffprobe reports a
*duration* that has already been rounded through a float. The reader is
checked against `soundfile.info(path).frames` on a spread of files in every
run (see --verify-count); a single disagreement aborts the build.

FLAC STREAMINFO (RFC 9639 / the FLAC format spec):

    "fLaC"                                   4 bytes magic
    METADATA_BLOCK_HEADER                    1 bit last-block, 7 bits type,
                                             24 bits length
    STREAMINFO is block type 0 and is always the FIRST metadata block,
    always 34 bytes. Bit offsets inside those 34 bytes:
        0   16  minimum block size
        16  16  maximum block size
        32  24  minimum frame size
        56  24  maximum frame size
        80  20  sample rate (Hz)
        100  3  channels - 1
        103  5  bits per sample - 1
        108 36  total samples in stream
        144 128 MD5 of the unencoded audio

Ported from ebook2audiobook@9daab0ba (session layout v1; the assembled
selection rule follows bookforge_ext/parallel/session.py detect_completed_chapters).
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from compare import ffprobe_raw, parse_vtt, summarize_probe  # noqa: E402

STREAMINFO_BYTES = 34


def read_streaminfo(path: str) -> dict:
    """sample_rate / channels / bits_per_sample / samples from a FLAC header.

    Raises on anything that is not a well-formed FLAC whose first metadata
    block is a 34-byte STREAMINFO. No fallback: a chunk we cannot measure is a
    bug to surface, never a zero to average away.
    """
    with open(path, 'rb') as f:
        magic = f.read(4)
        if magic != b'fLaC':
            raise ValueError('not a FLAC stream (magic %r): %s' % (magic, path))
        header = f.read(4)
        if len(header) != 4:
            raise ValueError('truncated metadata block header: %s' % path)
        block_type = header[0] & 0x7F
        length = int.from_bytes(header[1:4], 'big')
        if block_type != 0:
            raise ValueError(
                'first metadata block is type %d, expected 0 (STREAMINFO): %s'
                % (block_type, path))
        if length != STREAMINFO_BYTES:
            raise ValueError(
                'STREAMINFO is %d bytes, expected %d: %s'
                % (length, STREAMINFO_BYTES, path))
        block = f.read(STREAMINFO_BYTES)
        if len(block) != STREAMINFO_BYTES:
            raise ValueError('truncated STREAMINFO: %s' % path)

    packed = int.from_bytes(block, 'big')
    total_bits = STREAMINFO_BYTES * 8

    def field(offset: int, width: int) -> int:
        return (packed >> (total_bits - offset - width)) & ((1 << width) - 1)

    info = {
        'sample_rate': field(80, 20),
        'channels': field(100, 3) + 1,
        'bits_per_sample': field(103, 5) + 1,
        'samples': field(108, 36),
    }
    if info['sample_rate'] <= 0:
        raise ValueError('STREAMINFO sample rate is 0 (non-audio stream): %s' % path)
    if info['samples'] <= 0:
        raise ValueError('STREAMINFO total samples is 0 (unknown length): %s' % path)
    return info


def verify_reader(paths: list[str], count: int) -> list[str]:
    """Cross-check the header reader against soundfile on `count` files."""
    try:
        import soundfile as sf
    except ImportError as exc:                              # pragma: no cover
        raise RuntimeError(
            'soundfile is required to verify the STREAMINFO reader; '
            'install it or run this on the e2a python_env interpreter'
        ) from exc

    if count > len(paths):
        count = len(paths)
    if count < 1:
        raise ValueError('--verify-count must be at least 1')
    # A spread across the book, not the first N: late chunks are the ones a
    # packer change moves.
    step = max(1, len(paths) // count)
    picked = paths[::step][:count]
    if paths[-1] not in picked:
        picked[-1] = paths[-1]

    lines = []
    for p in picked:
        head = read_streaminfo(p)
        info = sf.info(p)
        if head['samples'] != info.frames:
            raise AssertionError(
                'STREAMINFO/soundfile disagree on %s: header=%d frames=%d'
                % (p, head['samples'], info.frames))
        if head['sample_rate'] != info.samplerate:
            raise AssertionError(
                'STREAMINFO/soundfile disagree on sample rate for %s: %d vs %d'
                % (p, head['sample_rate'], info.samplerate))
        if head['channels'] != info.channels:
            raise AssertionError(
                'STREAMINFO/soundfile disagree on channels for %s: %d vs %d'
                % (p, head['channels'], info.channels))
        lines.append(os.path.basename(p))
    return lines


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def read_json(path: str) -> dict:
    if not os.path.isfile(path):
        raise FileNotFoundError('required session file missing: %s' % path)
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def assembled_prefix(state: dict, rendered: int) -> list[int]:
    """The 1-based chapters an assembly of `rendered` leading chunks covers.

    e2a's `--chapters auto` walks chapter_sentences in order and stops at the
    first chapter that is not fully rendered, so the assembled set is always a
    contiguous prefix that ends exactly on a chapter boundary. Raises when
    `rendered` does not land on one, because that would mean the reference VTT
    and the session disagree about where chapters are.
    """
    chapters = state['chapter_sentences']
    total = 0
    selected = []
    for i, chapter in enumerate(chapters):
        if total + len(chapter) > rendered:
            break
        total += len(chapter)
        selected.append(i + 1)
    if total != rendered:
        raise ValueError(
            'the reference covers %d chunks, which is not a chapter boundary '
            '(nearest prefix of %d chapters covers %d)'
            % (rendered, len(selected), total))
    return selected


def build(args: argparse.Namespace) -> None:
    process_dir = os.path.abspath(args.process_dir)
    if not os.path.isdir(process_dir):
        raise NotADirectoryError('process dir not found: %s' % process_dir)

    sentences_dir = os.path.abspath(
        args.sentences_dir or os.path.join(process_dir, 'chapters', 'sentences'))
    if not os.path.isdir(sentences_dir):
        raise NotADirectoryError('sentences dir not found: %s' % sentences_dir)
    rel_sentences = os.path.relpath(sentences_dir, process_dir).replace('\\', '/')

    state = read_json(os.path.join(process_dir, 'session-state.json'))
    provenance = read_json(os.path.join(process_dir, 'chapter-provenance.json'))

    for key in ('total_sentences', 'total_chapters', 'chapter_sentences', 'chapters'):
        if key not in state:
            raise KeyError('session-state.json has no %r' % key)

    stems = sorted(int(n[:-5]) for n in os.listdir(sentences_dir) if n.endswith('.flac'))
    if not stems:
        raise ValueError('no FLAC chunks in %s' % sentences_dir)
    if stems != list(range(len(stems))):
        raise ValueError(
            'chunk indices in %s are not contiguous from 0 (first=%d last=%d count=%d)'
            % (sentences_dir, stems[0], stems[-1], len(stems)))

    with open(args.reference_vtt, encoding='utf-8') as f:
        vtt_text = f.read()
    cues = parse_vtt(vtt_text)

    # The reference governs how much of the session it describes. A full render
    # gives one cue per chunk; a partial assembly gives one cue per ASSEMBLED
    # chunk, and the rest of the session is simply not covered by this fixture.
    covered = len(cues)
    if covered > len(stems):
        raise ValueError(
            'reference VTT has %d cues but only %d chunks are rendered in %s'
            % (covered, len(stems), sentences_dir))
    selected_chapters = assembled_prefix(state, covered)

    paths = [os.path.join(sentences_dir, '%d.flac' % i) for i in range(covered)]
    for p in paths:
        if not os.path.isfile(p):
            raise FileNotFoundError('chunk file missing: %s' % p)

    verified = verify_reader(paths, args.verify_count)
    print('[golden] STREAMINFO reader verified against soundfile on %d files: %s'
          % (len(verified), ', '.join(verified[:6]) + (' ...' if len(verified) > 6 else '')))

    entries = []
    total_samples = 0
    rates = set()
    for i, p in enumerate(paths):
        info = read_streaminfo(p)
        rates.add(info['sample_rate'])
        total_samples += info['samples']
        entries.append({
            'index': i,
            'file': '%s/%d.flac' % (rel_sentences, i),
            'samples': info['samples'],
            'sampleRate': info['sample_rate'],
            'channels': info['channels'],
            'bytes': os.path.getsize(p),
            'sha256': sha256_file(p),
        })
    if len(rates) != 1:
        raise ValueError('mixed sample rates in %s: %r' % (sentences_dir, sorted(rates)))
    sample_rate = rates.pop()

    m4b_raw = ffprobe_raw(args.reference_m4b, args.ffprobe)
    m4b_summary = summarize_probe(m4b_raw, args.reference_m4b)
    m4b_doc = dict(m4b_raw)
    m4b_doc['sha256'] = sha256_file(args.reference_m4b)
    m4b_doc['bytes'] = os.path.getsize(args.reference_m4b)

    out = os.path.abspath(
        args.out or os.path.join(_HERE, '..', 'golden', args.slug))
    os.makedirs(out, exist_ok=True)

    shutil.copyfile(os.path.join(process_dir, 'session-state.json'),
                    os.path.join(out, 'session-state.json'))
    shutil.copyfile(os.path.join(process_dir, 'chapter-provenance.json'),
                    os.path.join(out, 'chapter-provenance.json'))
    with open(os.path.join(out, 'reference.vtt'), 'w', encoding='utf-8', newline='') as f:
        f.write(vtt_text)
    with open(os.path.join(out, 'sentences.json'), 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=1)
        f.write('\n')
    with open(os.path.join(out, 'reference-m4b.json'), 'w', encoding='utf-8') as f:
        json.dump(m4b_doc, f, indent=1)
        f.write('\n')

    metadata_src = args.metadata
    metadata_note = 'not present in the session'
    if metadata_src:
        if not os.path.isfile(metadata_src):
            raise FileNotFoundError('--metadata given but not found: %s' % metadata_src)
        shutil.copyfile(metadata_src, os.path.join(out, 'metadata.txt'))
        metadata_note = 'copied from `%s`' % os.path.basename(metadata_src)

    audio_seconds = total_samples / sample_rate
    readme = _render_readme(
        args=args, out=out, process_dir=process_dir, state=state,
        provenance=provenance, rel_sentences=rel_sentences, stems=stems,
        covered=covered, selected_chapters=selected_chapters,
        entries=entries, total_samples=total_samples, sample_rate=sample_rate,
        audio_seconds=audio_seconds, cues=cues, m4b_summary=m4b_summary,
        m4b_doc=m4b_doc, verified=verified, metadata_note=metadata_note,
    )
    with open(os.path.join(out, 'README.md'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(readme)

    size = sum(os.path.getsize(os.path.join(out, n)) for n in os.listdir(out))
    print('[golden] wrote %s (%d files, %.2f MB)'
          % (out, len(os.listdir(out)), size / 1e6))
    if size > 2 * 1024 * 1024:
        print('[golden] WARNING: fixture exceeds the 2 MB budget in CONTRACTS.md')


def _render_readme(**k) -> str:
    args = k['args']
    state = k['state']
    entries = k['entries']
    m4b = k['m4b_summary']
    covered = k['covered']
    stems = k['stems']

    full = covered == state['total_sentences']
    lines = []
    A = lines.append
    A('# golden fixture: `%s`' % args.slug)
    A('')
    A('Generated by `python -m narrator.tests.golden_tools.build_fixture` on %s.'
      % datetime.date.today().isoformat())
    A('')
    A('## Book')
    A('')
    meta = state.get('metadata', {})
    A('| field | value |')
    A('|---|---|')
    A('| title | %s |' % meta.get('title', ''))
    A('| author | %s |' % meta.get('creator', ''))
    A('| voice (`fine_tuned`) | %s |' % state.get('fine_tuned'))
    A('| engine | %s |' % state.get('tts_engine'))
    A('| session id | `%s` |' % state.get('session_id'))
    A('| source project (Z:) | `%s` |' % args.source_project)
    A('| local copy | `%s` |' % k['process_dir'])
    A('| e2a commit | `%s` |' % args.e2a_commit)
    A('')
    A('## What this fixture covers')
    A('')
    A('- `session-state.json` declares **%d chunks** across **%d chapters**.'
      % (state['total_sentences'], state['total_chapters']))
    A('- **%d** chunk FLACs are rendered in `%s` (indices 0..%d, contiguous).'
      % (len(stems), k['rel_sentences'], stems[-1]))
    A('- The reference describes **%d chunks** = chapters %s%s.'
      % (covered,
         '1..%d' % k['selected_chapters'][-1] if k['selected_chapters'] else 'none',
         ' (the whole book)' if full else ' (a PARTIAL assembly)'))
    A('- `sentences.json` has one row per covered chunk: %d rows.' % len(entries))
    A('- Total audio: **%d samples** at %d Hz = **%.3f s** (%.2f h).'
      % (k['total_samples'], k['sample_rate'], k['audio_seconds'], k['audio_seconds'] / 3600))
    A('')
    A('**The sentences dir the reference was assembled FROM is `%s`.**'
      % k['rel_sentences'])
    A('Parity runs must read that same directory: a narrator assembly pointed at a')
    A('different one will not reproduce these timings.')
    A('')
    A('## Reference outputs')
    A('')
    A('| file | value |')
    A('|---|---|')
    A('| reference m4b | `%s` |' % os.path.basename(args.reference_m4b))
    A('| m4b bytes | %d |' % k['m4b_doc']['bytes'])
    A('| m4b sha256 | `%s` |' % k['m4b_doc']['sha256'])
    A('| m4b duration | %.3f s |' % m4b['duration'])
    A('| m4b chapters | %d |' % len(m4b['chapters']))
    A('| audio stream | %s %s Hz, %s ch |'
      % (m4b['audio']['codec'], m4b['audio']['sample_rate'], m4b['audio']['channels']))
    A('| cover stream | %s |' % ('present' if m4b['has_cover'] else 'absent'))
    A('| reference vtt | `%s` |' % os.path.basename(args.reference_vtt))
    A('| vtt cues | %d |' % len(k['cues']))
    A('| metadata.txt | %s |' % k['metadata_note'])
    A('')
    A('## The cue-count rule (measured, not assumed)')
    A('')
    A('e2a emits **exactly one VTT cue per rendered chunk it assembled** - including')
    A('a chunk whose cue text is EMPTY. `vtt_cue_text` (e2a `lib/conf_models.py:116`)')
    A('strips every SML marker, so a row that is nothing but a marker (a bare')
    A('`[break]`) becomes an empty payload and e2a still writes its cue. So:')
    A('')
    A('    len(parse_vtt(reference.vtt)) == len(sentences.json)')
    A('')
    A('Do NOT compare the cue count against a `<book>.m4b.vtt` sidecar from a')
    A('BookForge project: that sidecar is not e2a output. It is ffmpeg re-muxing the')
    A("m4b's embedded `mov_text` track back to WebVTT")
    A('(`electron/sidecar-migration.ts` -> `extractVttFromM4b`), which drops every')
    A('empty cue and prints `MM:SS.mmm` instead of e2a\'s `HH:MM:SS.mmm`.')
    A('')
    A('## Sample counts')
    A('')
    A("`samples` is each FLAC's STREAMINFO total-samples field, read from the header")
    A('bytes - never decoded, never via ffprobe. The reader was cross-checked against')
    A('`soundfile.info(path).frames` on %d files in this build (%s) and every one'
      % (len(k['verified']), ', '.join(k['verified'][:6]) + (' ...' if len(k['verified']) > 6 else '')))
    A('agreed exactly.')
    A('')
    A('## Rebuilding')
    A('')
    A('The reference m4b/VTT are regenerated by e2a first (command above), then:')
    A('')
    A('```')
    A('python -m narrator.tests.golden_tools.build_fixture \\')
    A('    --slug %s \\' % args.slug)
    A('    --process-dir  "%s" \\' % k['process_dir'])
    A('    --sentences-dir "%s" \\' % os.path.join(k['process_dir'], k['rel_sentences'].replace('/', os.sep)))
    A('    --reference-m4b "%s" \\' % args.reference_m4b)
    A('    --reference-vtt "%s" \\' % args.reference_vtt)
    if args.metadata:
        A('    --metadata "%s" \\' % args.metadata)
    A('    --notes narrator/tests/golden_tools/notes/%s.md \\' % args.slug)
    A('    --source-project "%s" \\' % args.source_project)
    A('    --e2a-commit %s' % args.e2a_commit)
    A('```')
    A('')
    A('Everything below this line is `golden_tools/notes/%s.md`, appended verbatim.'
      % args.slug)
    A('')
    A('---')
    A('')
    if args.notes:
        with open(args.notes, encoding='utf-8') as f:
            lines.append(f.read().rstrip('\n'))
            A('')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog='python -m narrator.tests.golden_tools.build_fixture',
        description='Build one committed golden fixture from a local e2a session copy.')
    ap.add_argument('--slug', required=True)
    ap.add_argument('--process-dir', required=True,
                    help='the <hash> dir of a LOCAL copy (never a path on Z:)')
    ap.add_argument('--reference-m4b', required=True)
    ap.add_argument('--reference-vtt', required=True)
    ap.add_argument('--sentences-dir', default=None,
                    help='the dir the reference was assembled FROM '
                         '(default <process-dir>/chapters/sentences)')
    ap.add_argument('--metadata', default=None,
                    help="e2a's ;FFMETADATA1 file for this reference, if it wrote one")
    ap.add_argument('--out', default=None,
                    help='fixture dir (default ../golden/<slug>)')
    ap.add_argument('--notes', default=None,
                    help='markdown file appended verbatim to the README')
    ap.add_argument('--verify-count', type=int, default=20,
                    help='FLACs to cross-check against soundfile (default 20)')
    ap.add_argument('--ffprobe', default=None)
    ap.add_argument('--source-project', default='(unrecorded)',
                    help='the project directory on Z: this session came from')
    ap.add_argument('--e2a-commit', default='(unrecorded)')
    args = ap.parse_args(argv)

    if os.path.abspath(args.process_dir).upper().startswith('Z:'):
        raise ValueError('refusing to build from Z: - copy the session locally first')
    build(args)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
