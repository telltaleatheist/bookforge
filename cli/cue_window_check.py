#!/usr/bin/env python
"""
cue_window_check.py — which cues touch a set of excluded audio windows?

Written for the deathstalker "compact" masters. Those are not continuous
recordings: spans were removed and the survivors butted together, and the build
kept an `_excludes.txt` listing a ~2.6 s window straddling every join, because the
audio right at a splice is a crossfade artifact rather than narration. A forced
alignment against such a master is still valid between the joins, but any cue that
EDGES INTO or SPANS one of those windows is suspect for corpus use.

    cue_window_check.py --vtt X.vtt --windows-file mck_a_excludes.txt [--json out.json]
    cue_window_check.py --vtt X.vtt --windows 1846.6-1849.2,2857.4-2860.0

Window file format: `start-end` pairs separated by commas and/or newlines, in
seconds on the SAME timeline as the VTT (i.e. the compact master's).

Reports, and exits 0 either way (this is a report, not a gate):
  edgeInWindow   a cue START or END lands inside an excluded window - the cut
                 itself would sit in the artifact
  spansWindow    the cue's interval covers a window - the clip would contain the
                 artifact in its middle
Both are listed with the cue's VTT index (1-based, as written), its times, and the
window it touches, so they can be dropped or re-cut by id.
"""
import argparse, json, re, sys

TS = re.compile(r'(\d+):(\d\d):(\d\d[.,]\d+)\s*-->\s*(\d+):(\d\d):(\d\d[.,]\d+)')


def _sec(h, m, s):
    return int(h) * 3600 + int(m) * 60 + float(s.replace(',', '.'))


def parse_vtt(path):
    """[(index, start, end, text)] with index the 1-based cue ordinal as written."""
    lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
    out, i, n = [], 0, 0
    while i < len(lines):
        m = TS.search(lines[i])
        if m:
            n += 1
            st, en = _sec(*m.group(1, 2, 3)), _sec(*m.group(4, 5, 6))
            buf, j = [], i + 1
            while j < len(lines) and lines[j].strip():
                buf.append(lines[j].strip())
                j += 1
            out.append((n, st, en, ' '.join(buf)))
            i = j
        else:
            i += 1
    return out


def parse_windows(text):
    """`start-end` pairs separated by commas/whitespace -> sorted [(a, z)]."""
    wins = []
    for tok in re.split(r'[,\s]+', text.strip()):
        if not tok:
            continue
        m = re.fullmatch(r'(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)', tok)
        if not m:
            sys.exit(f'cue_window_check: cannot parse window {tok!r} '
                     f'(expected START-END in seconds)')
        a, z = float(m.group(1)), float(m.group(2))
        if z > a:
            wins.append((a, z))
    wins.sort()
    return wins


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vtt', required=True)
    ap.add_argument('--windows', default='')
    ap.add_argument('--windows-file', default='')
    ap.add_argument('--json', default='')
    ap.add_argument('--list', type=int, default=40,
                    help='how many offending cues to print (default 40; 0 = all)')
    a = ap.parse_args()
    if not (a.windows or a.windows_file):
        sys.exit('cue_window_check: need --windows or --windows-file')
    text = a.windows
    if a.windows_file:
        text = (text + ' ' + open(a.windows_file, encoding='utf-8').read()).strip()
    wins = parse_windows(text)
    cues = parse_vtt(a.vtt)
    if not wins:
        sys.exit('cue_window_check: no usable windows parsed')

    edge, spans = [], []
    for idx, st, en, txt in cues:
        for (wa, wz) in wins:
            if wz <= st or wa >= en:
                continue                       # no overlap at all
            hit = {'cue': idx, 'start': round(st, 3), 'end': round(en, 3),
                   'window': [wa, wz],
                   'text': (txt[:90] + '…') if len(txt) > 90 else txt}
            if wa <= st <= wz or wa <= en <= wz:
                edge.append(hit)
            else:
                spans.append(hit)
            break

    n = len(cues)
    print(f'{a.vtt}: {n} cues, {len(wins)} excluded window(s)')
    print(f'  edge inside a window : {len(edge)} ({100.0 * len(edge) / max(1, n):.2f}%)')
    print(f'  cue spans a window   : {len(spans)} ({100.0 * len(spans) / max(1, n):.2f}%)')
    lim = None if a.list == 0 else a.list
    for label, rows in (('EDGE', edge), ('SPAN', spans)):
        for h in rows[:lim]:
            print(f'  {label} cue {h["cue"]:>5}  {h["start"]:>10.3f}-{h["end"]:<10.3f} '
                  f'window {h["window"][0]}-{h["window"][1]}  {h["text"][:60]!r}')
        if lim is not None and len(rows) > lim:
            print(f'  ... {len(rows) - lim} more {label} cue(s) not listed (--list 0 for all)')

    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump({'vtt': a.vtt, 'cues': n, 'windows': wins,
                       'edgeInWindow': edge, 'spansWindow': spans}, f, indent=2)
        print(f'wrote {a.json}')


if __name__ == '__main__':
    main()
