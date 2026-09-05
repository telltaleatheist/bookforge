"""Parity comparison helpers for the golden set (builder G).

Builder A's parity tests import `parse_vtt`, `compare_vtt`, `probe_m4b` and
`compare_m4b` from here. Nothing in this module knows about narrator's own
modules on purpose: it must be able to compare an e2a artefact against a
narrator artefact without importing either producer.

VTT dialects this must read
---------------------------
Two spellings of the same cue times reach these functions, and both are
legitimate inputs:

* e2a's own writers (`lib/core.py build_vtt_file`,
  `bookforge_ext/parallel/session.py build_vtt_file`,
  `lib/classes/tts_engines/common/utils.py _build_vtt_file`) all format a
  timestamp as `f'{int(h):02}:{int(m):02}:{s:06.3f}'` -> always three
  components, `HH:MM:SS.mmm`.
* ffmpeg's WebVTT muxer omits the hour field while it is zero, so a VTT that
  has been round-tripped through the m4b's `mov_text` track (which is how
  BookForge's `<book>.m4b.vtt` sidecar is produced -
  `electron/sidecar-migration.ts` -> `extractVttFromM4b`) reads `MM:SS.mmm`
  for every cue before the one-hour mark.

`parse_vtt` therefore accepts two- or three-component timestamps and returns
seconds, so a comparison never depends on which producer spelled the file.

Ported from ebook2audiobook@9daab0ba (cue semantics observed from
bookforge_ext/parallel/session.py:836 build_vtt_file and
lib/conf_models.py:116 vtt_cue_text).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

__all__ = [
    'parse_vtt',
    'compare_vtt',
    'probe_m4b',
    'compare_m4b',
    'VttDiff',
    'M4bDiff',
]

# `00:00.000` / `00:00:00.000`, and tolerant of an hour field wider than two
# digits (ffmpeg writes `100:00:00.000` rather than wrapping).
_TIME_RE = re.compile(r'^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$')
_ARROW = '-->'


def _parse_timestamp(raw: str) -> float:
    """Seconds from a WebVTT timestamp. Raises on anything unparseable."""
    m = _TIME_RE.match(raw.strip())
    if not m:
        raise ValueError('unparseable WebVTT timestamp: %r' % (raw,))
    hours = int(m.group(1)) if m.group(1) is not None else 0
    minutes = int(m.group(2))
    seconds = float(m.group(3))
    return hours * 3600.0 + minutes * 60.0 + seconds


def format_timestamp(seconds: float) -> str:
    """e2a's spelling: always three components.

    Mirrors build_vtt_file's local `format_timestamp` exactly so a rendered
    diff line looks like the file it came from.
    """
    if seconds < 0:
        raise ValueError('negative timestamp: %r' % (seconds,))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return '%02d:%02d:%06.3f' % (int(h), int(m), s)


def parse_vtt(text: str) -> list[dict]:
    """Parse a WebVTT document into a list of cue dicts.

    Each cue is ``{"index": int|None, "start": float, "end": float,
    "text": str, "notes": list[str]}``.

    * ``index`` is the cue identifier line when it is an integer, else None.
      e2a writes no identifier at all, so ``index`` is normally None; a
      producer that numbers its cues still compares cleanly.
    * ``notes`` holds the payloads of every ``NOTE`` block standing between
      the previous cue and this one, in order. A trailing NOTE block after the
      last cue has no cue to attach to and is an error, because it would
      silently vanish from any comparison.
    * ``text`` keeps the cue payload verbatim (including ``<b>`` markup, which
      is how e2a spells a heading) with only the trailing newline removed. An
      empty payload is preserved: e2a emits one cue per rendered chunk, and a
      row that is nothing but a stripped marker (e.g. a bare ``[break]``)
      legitimately produces an empty cue.
    """
    if not isinstance(text, str):
        raise TypeError('parse_vtt expects str, got %s' % type(text).__name__)

    body = text.replace('\r\n', '\n').replace('\r', '\n')
    body = body.lstrip('﻿')   # a UTF-8 BOM survives an encoding='utf-8' read
    if not body.startswith('WEBVTT'):
        raise ValueError('not a WebVTT document (no WEBVTT header)')

    blocks = re.split(r'\n[ \t]*\n', body)
    cues: list[dict] = []
    pending_notes: list[str] = []

    for pos, block in enumerate(blocks):
        raw = block.strip('\n')
        if not raw.strip():
            continue
        if pos == 0:
            # Header block; a WEBVTT line may carry a trailing description.
            continue
        if raw.startswith('NOTE'):
            note = raw[len('NOTE'):].strip()
            pending_notes.append(note)
            continue

        lines = raw.split('\n')
        timing_at = None
        for i, line in enumerate(lines):
            if _ARROW in line:
                timing_at = i
                break
        if timing_at is None:
            raise ValueError('WebVTT block %d has no timing line: %r' % (pos, raw[:80]))
        if timing_at > 1:
            raise ValueError(
                'WebVTT block %d has %d lines before its timing line (expected at most 1)'
                % (pos, timing_at)
            )

        index = None
        if timing_at == 1:
            ident = lines[0].strip()
            if re.fullmatch(r'\d+', ident):
                index = int(ident)

        timing = lines[timing_at]
        left, _, right = timing.partition(_ARROW)
        # A cue timing line may carry settings after the end time
        # ("00:00.000 --> 00:01.000 align:start"); they are not part of it.
        end_field = right.strip().split()[0] if right.strip().split() else ''
        start = _parse_timestamp(left)
        end = _parse_timestamp(end_field)

        cues.append({
            'index': index,
            'start': start,
            'end': end,
            'text': '\n'.join(lines[timing_at + 1:]),
            'notes': pending_notes,
        })
        pending_notes = []

    if pending_notes:
        raise ValueError(
            'WebVTT ends with %d NOTE block(s) after the last cue; they would be lost'
            % len(pending_notes)
        )
    return cues


@dataclass
class VttDiff:
    cue_count_equal: bool
    candidate_cues: int
    reference_cues: int
    text_mismatches: list = field(default_factory=list)   # [(i, cand, ref)]
    time_mismatches: list = field(default_factory=list)   # [(i, field, cand, ref, delta)]
    note_mismatches: list = field(default_factory=list)   # [(i, cand, ref)]
    max_abs_delta_s: float = 0.0
    ok: bool = False

    def describe(self) -> str:
        out = []
        out.append('cues: candidate=%d reference=%d %s'
                   % (self.candidate_cues, self.reference_cues,
                      'MATCH' if self.cue_count_equal else 'DIFFER'))
        out.append('max |time delta| = %.6f s' % self.max_abs_delta_s)
        out.append('text mismatches: %d' % len(self.text_mismatches))
        for i, cand, ref in self.text_mismatches[:20]:
            out.append('  cue %d:' % i)
            out.append('    candidate: %r' % (cand,))
            out.append('    reference: %r' % (ref,))
        if len(self.text_mismatches) > 20:
            out.append('  ... %d more' % (len(self.text_mismatches) - 20))
        out.append('time mismatches: %d' % len(self.time_mismatches))
        for i, fname, cand, ref, delta in self.time_mismatches[:20]:
            out.append('  cue %d %s: candidate=%s reference=%s delta=%+.6f s'
                       % (i, fname, format_timestamp(cand), format_timestamp(ref), delta))
        if len(self.time_mismatches) > 20:
            out.append('  ... %d more' % (len(self.time_mismatches) - 20))
        out.append('note mismatches: %d' % len(self.note_mismatches))
        for i, cand, ref in self.note_mismatches[:20]:
            out.append('  cue %d: candidate=%r reference=%r' % (i, cand, ref))
        out.append('OK' if self.ok else 'NOT OK')
        return '\n'.join(out)


def compare_vtt(candidate_text: str, reference_text: str,
                tolerance_s: float = 0.001) -> VttDiff:
    """Compare two WebVTT documents cue by cue.

    `tolerance_s` is the per-field allowance on start/end times; the contract's
    parity target is 1 ms, which is this default. Comparison runs over the
    overlapping prefix when the cue counts differ, so a count difference still
    reports where the content first diverges instead of reporting nothing.
    """
    cand = parse_vtt(candidate_text)
    ref = parse_vtt(reference_text)

    diff = VttDiff(
        cue_count_equal=len(cand) == len(ref),
        candidate_cues=len(cand),
        reference_cues=len(ref),
    )

    for i in range(min(len(cand), len(ref))):
        c, r = cand[i], ref[i]
        if c['text'] != r['text']:
            diff.text_mismatches.append((i, c['text'], r['text']))
        if c['notes'] != r['notes']:
            diff.note_mismatches.append((i, c['notes'], r['notes']))
        for fname in ('start', 'end'):
            delta = c[fname] - r[fname]
            if abs(delta) > diff.max_abs_delta_s:
                diff.max_abs_delta_s = abs(delta)
            if abs(delta) > tolerance_s:
                diff.time_mismatches.append((i, fname, c[fname], r[fname], delta))

    diff.ok = (
        diff.cue_count_equal
        and not diff.text_mismatches
        and not diff.time_mismatches
        and not diff.note_mismatches
    )
    return diff


def _resolve_ffprobe(ffprobe: str | None) -> str:
    if ffprobe:
        if not os.path.isfile(ffprobe):
            raise FileNotFoundError('ffprobe not found at %s' % ffprobe)
        return ffprobe
    found = shutil.which('ffprobe')
    if not found:
        raise RuntimeError(
            'ffprobe not on PATH; pass an explicit path as the `ffprobe` argument'
        )
    return found


def ffprobe_raw(path: str, ffprobe: str | None = None) -> dict:
    """The raw `-show_format -show_chapters -show_streams` JSON for `path`."""
    if not os.path.isfile(path):
        raise FileNotFoundError('media file not found: %s' % path)
    exe = _resolve_ffprobe(ffprobe)
    cmd = [
        exe, '-v', 'error',
        '-show_format', '-show_chapters', '-show_streams',
        '-print_format', 'json', path,
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            'ffprobe failed (%d) on %s: %s'
            % (proc.returncode, path, proc.stderr.decode('utf-8', 'replace').strip())
        )
    return json.loads(proc.stdout.decode('utf-8'))


def summarize_probe(raw: dict, path: str = '<probe>') -> dict:
    """Reduce raw ffprobe JSON to the fields parity actually compares.

    Kept separate from `probe_m4b` so the committed `reference-m4b.json`
    fixture (which holds the raw JSON) can be summarized without re-running
    ffprobe - the golden tests must work with no binaries present.
    """
    if 'format' not in raw:
        raise KeyError('ffprobe JSON for %s has no "format" object' % path)
    fmt = raw['format']
    if 'duration' not in fmt:
        raise KeyError('ffprobe format for %s has no duration' % path)

    chapters = []
    for ch in raw.get('chapters', []):
        tags = ch.get('tags', {})
        if 'start_time' not in ch or 'end_time' not in ch:
            raise KeyError('chapter in %s has no start_time/end_time' % path)
        chapters.append({
            'start': float(ch['start_time']),
            'end': float(ch['end_time']),
            'title': tags.get('title', ''),
        })

    streams = raw.get('streams', [])
    audio = None
    has_cover = False
    for st in streams:
        ctype = st.get('codec_type')
        if ctype == 'audio' and audio is None:
            audio = {
                'codec': st.get('codec_name'),
                'sample_rate': int(st['sample_rate']) if st.get('sample_rate') else None,
                'channels': st.get('channels'),
                'bit_rate': int(st['bit_rate']) if st.get('bit_rate') else None,
            }
        if ctype == 'video' or st.get('disposition', {}).get('attached_pic'):
            has_cover = True
    if audio is None:
        raise ValueError('no audio stream in %s' % path)

    return {
        'path': path,
        'duration': float(fmt['duration']),
        'chapters': chapters,
        'audio': audio,
        'has_cover': has_cover,
        'tags': dict(fmt.get('tags', {})),
    }


def probe_m4b(path: str, ffprobe: str | None = None) -> dict:
    """Format duration, chapters, audio stream, cover presence and tags."""
    return summarize_probe(ffprobe_raw(path, ffprobe), path)


#: Container tags that say nothing about parity: ffmpeg stamps its own
#: version into `encoder`, and the brand triple is decided by the muxer.
IGNORED_TAGS = ('encoder', 'major_brand', 'minor_version',
                'compatible_brands')


@dataclass
class M4bDiff:
    duration_candidate: float
    duration_reference: float
    duration_delta_s: float
    duration_ok: bool
    chapter_count_equal: bool
    chapter_count_candidate: int
    chapter_count_reference: int
    title_mismatches: list = field(default_factory=list)   # [(i, cand, ref)]
    start_mismatches: list = field(default_factory=list)   # [(i, cand, ref, delta)]
    audio_mismatches: list = field(default_factory=list)   # [(field, cand, ref)]
    cover_candidate: bool = False
    cover_reference: bool = False
    cover_equal: bool = True
    tag_mismatches: list = field(default_factory=list)     # [(key, cand, ref)]
    ok: bool = False

    def describe(self) -> str:
        out = []
        out.append('duration: candidate=%.3f s reference=%.3f s delta=%+.3f s %s'
                   % (self.duration_candidate, self.duration_reference,
                      self.duration_delta_s, 'OK' if self.duration_ok else 'OUT OF TOLERANCE'))
        out.append('chapters: candidate=%d reference=%d %s'
                   % (self.chapter_count_candidate, self.chapter_count_reference,
                      'MATCH' if self.chapter_count_equal else 'DIFFER'))
        out.append('chapter title mismatches: %d' % len(self.title_mismatches))
        for i, cand, ref in self.title_mismatches[:20]:
            out.append('  chapter %d: candidate=%r reference=%r' % (i, cand, ref))
        out.append('chapter start mismatches: %d' % len(self.start_mismatches))
        for i, cand, ref, delta in self.start_mismatches[:20]:
            out.append('  chapter %d: candidate=%.3f reference=%.3f delta=%+.3f s'
                       % (i, cand, ref, delta))
        out.append('audio stream mismatches: %d' % len(self.audio_mismatches))
        for fname, cand, ref in self.audio_mismatches:
            out.append('  %s: candidate=%r reference=%r' % (fname, cand, ref))
        out.append('cover: candidate=%s reference=%s %s'
                   % (self.cover_candidate, self.cover_reference,
                      'MATCH' if self.cover_equal else 'DIFFER'))
        out.append('tag mismatches: %d' % len(self.tag_mismatches))
        for key, cand, ref in self.tag_mismatches:
            out.append('  %s: candidate=%r reference=%r' % (key, cand, ref))
        out.append('OK' if self.ok else 'NOT OK')
        return '\n'.join(out)


def compare_m4b(candidate: dict, reference: dict,
                duration_tolerance_s: float = 0.05) -> M4bDiff:
    """Compare two `probe_m4b` results.

    Chapter starts are held to the same tolerance as the total duration: a
    chapter boundary is a concat point, so it drifts for the same reasons the
    total does.

    The comparison covers the TIMELINE (duration, chapter count, titles,
    starts), the AUDIO STREAM (codec, sample rate, channels), the COVER, and
    the container TAG SET. Timeline-only was not enough: a tagless, coverless,
    64 kbps file has the same timeline as the real thing and used to pass.
    `bit_rate` is deliberately NOT compared - it is a measured average that
    moves with the content - but codec, sample rate and channel count are
    exact, and the tag set pins down the rest of the mux.
    """
    for name, d in (('candidate', candidate), ('reference', reference)):
        for key in ('duration', 'chapters', 'audio', 'has_cover', 'tags'):
            if key not in d:
                raise KeyError('%s probe has no %r' % (name, key))

    delta = candidate['duration'] - reference['duration']
    cch, rch = candidate['chapters'], reference['chapters']

    diff = M4bDiff(
        duration_candidate=candidate['duration'],
        duration_reference=reference['duration'],
        duration_delta_s=delta,
        duration_ok=abs(delta) <= duration_tolerance_s,
        chapter_count_equal=len(cch) == len(rch),
        chapter_count_candidate=len(cch),
        chapter_count_reference=len(rch),
    )

    for i in range(min(len(cch), len(rch))):
        if cch[i]['title'] != rch[i]['title']:
            diff.title_mismatches.append((i, cch[i]['title'], rch[i]['title']))
        sdelta = cch[i]['start'] - rch[i]['start']
        if abs(sdelta) > duration_tolerance_s:
            diff.start_mismatches.append((i, cch[i]['start'], rch[i]['start'], sdelta))

    ca, ra = candidate['audio'], reference['audio']
    for fname in ('codec', 'sample_rate', 'channels'):
        if ca.get(fname) != ra.get(fname):
            diff.audio_mismatches.append((fname, ca.get(fname), ra.get(fname)))

    diff.cover_candidate = bool(candidate['has_cover'])
    diff.cover_reference = bool(reference['has_cover'])
    diff.cover_equal = diff.cover_candidate == diff.cover_reference

    ctags = {k: v for k, v in candidate['tags'].items() if k not in IGNORED_TAGS}
    rtags = {k: v for k, v in reference['tags'].items() if k not in IGNORED_TAGS}
    for key in sorted(set(ctags) | set(rtags)):
        if ctags.get(key) != rtags.get(key):
            diff.tag_mismatches.append((key, ctags.get(key), rtags.get(key)))

    diff.ok = (
        diff.duration_ok
        and diff.chapter_count_equal
        and not diff.title_mismatches
        and not diff.start_mismatches
        and not diff.audio_mismatches
        and diff.cover_equal
        and not diff.tag_mismatches
    )
    return diff


def _main(argv: list[str]) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        prog='python -m narrator.tests.golden_tools.compare',
        description='Print a readable diff between two VTTs or two m4b files.',
    )
    ap.add_argument('candidate', help='the produced file (VTT or m4b)')
    ap.add_argument('reference', help='the golden file (VTT or m4b)')
    ap.add_argument('--tolerance', type=float, default=None,
                    help='seconds; default 0.001 for VTT, 0.05 for m4b')
    ap.add_argument('--ffprobe', default=None, help='explicit ffprobe path (m4b only)')
    args = ap.parse_args(argv)

    for p in (args.candidate, args.reference):
        if not os.path.isfile(p):
            raise FileNotFoundError('no such file: %s' % p)

    cand_vtt = args.candidate.lower().endswith('.vtt')
    ref_vtt = args.reference.lower().endswith('.vtt')
    if cand_vtt != ref_vtt:
        raise ValueError('compare a VTT with a VTT and an m4b with an m4b')

    if cand_vtt:
        tol = 0.001 if args.tolerance is None else args.tolerance
        with open(args.candidate, encoding='utf-8') as f:
            c = f.read()
        with open(args.reference, encoding='utf-8') as f:
            r = f.read()
        diff = compare_vtt(c, r, tolerance_s=tol)
    else:
        tol = 0.05 if args.tolerance is None else args.tolerance
        diff = compare_m4b(
            probe_m4b(args.candidate, args.ffprobe),
            probe_m4b(args.reference, args.ffprobe),
            duration_tolerance_s=tol,
        )

    print(diff.describe())
    return 0 if diff.ok else 1


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
