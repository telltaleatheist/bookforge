#!/usr/bin/env python
"""
vtt-boundary-metric.py — label-free boundary-accuracy metric for an aligned VTT.

A sentence cue boundary produced by forced alignment should land in a PAUSE: the
narrator stops, then starts the next sentence. So the silence map of the audio is
a free ground truth for boundary quality — no human labels needed.

Metric (per boundary time B, where a boundary is a cue end or the next cue's
start; contiguous cues share one time and are counted once):

  hit       B falls strictly inside a detected silence interval
  near      B is within --tol seconds of the nearest silence interval
  distance  seconds from B to the nearest silence interval (0 when inside)

Reported as hit rate, near rate, and the distance distribution (median/p75/p90/
p95/max). Comparing two VTTs of the SAME audio with the SAME silence map makes
the numbers directly comparable.

Also counts HEADING-MERGED cues: a cue whose text opens with an unpunctuated
heading-like block lifted from the epub and then runs straight on into prose
("Part I Ohio Born and Molded 1 William McKinley, Ohioan It is generally
believed…"). Those are the cues that poison a training-corpus cut, because the
heading read and the pause after it are invisible inside a prose cue.

Silence sources (--silences):
  *.log   ffmpeg silencedetect output (silence_start/silence_end lines)
  *.json  {"silences": [[start, end], ...]}  (auto-editor levels dump)

Usage:
  vtt-boundary-metric.py --vtt A.vtt --silences silences.log [--epub B.epub]
                         [--tol 0.15] [--json out.json] [--compare BEFORE.vtt]
"""
import argparse, json, os, re, sys, zipfile
from bisect import bisect_left

TS = re.compile(r'(\d\d):(\d\d):(\d\d[.,]\d+)\s*-->\s*(\d\d):(\d\d):(\d\d[.,]\d+)')


def _sec(h, m, s):
    return int(h) * 3600 + int(m) * 60 + float(s.replace(',', '.'))


def parse_vtt(path):
    """[(start, end, text, note)] — `note` is the NOTE comment attached to the cue
    (the aligner tags asr-fallback / heading cues that way), or ''."""
    cues = []
    blocks = re.split(r'\n\s*\n', open(path, encoding='utf-8-sig').read().replace('\r\n', '\n'))
    pending_note = ''
    for b in blocks:
        b = b.strip()
        if not b or b.startswith('WEBVTT'):
            continue
        if b.startswith('NOTE'):
            pending_note = b[4:].strip()
            continue
        m = TS.search(b)
        if not m:
            pending_note = ''
            continue
        lines = b.split('\n')
        ti = next(i for i, l in enumerate(lines) if TS.search(l))
        text = ' '.join(l.strip() for l in lines[ti + 1:]).strip()
        cues.append((_sec(*m.group(1, 2, 3)), _sec(*m.group(4, 5, 6)), text, pending_note))
        pending_note = ''
    return cues


def parse_silences(path):
    """-> sorted [(start, end)]."""
    if path.lower().endswith('.json'):
        d = json.load(open(path, encoding='utf-8'))
        iv = [(float(a), float(b)) for a, b in d['silences']]
    else:
        iv, start = [], None
        for line in open(path, encoding='utf-8', errors='replace'):
            m = re.search(r'silence_start:\s*(-?[\d.]+)', line)
            if m:
                start = float(m.group(1)); continue
            m = re.search(r'silence_end:\s*(-?[\d.]+)', line)
            if m and start is not None:
                iv.append((start, float(m.group(1)))); start = None
    iv = [(a, b) for a, b in iv if b > a]
    iv.sort()
    return iv


def dist_to_silence(t, starts, iv):
    """0 if t is inside an interval, else seconds to the nearest interval edge."""
    if not iv:
        return float('inf')
    i = bisect_left(starts, t)
    best = float('inf')
    for j in (i - 1, i, i + 1):
        if 0 <= j < len(iv):
            a, b = iv[j]
            best = min(best, 0.0 if a <= t <= b else (a - t if t < a else t - b))
    return best


def pct(sorted_vals, p):
    if not sorted_vals:
        return float('nan')
    k = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def boundary_times(cues):
    """Every cue end and every next-cue start, deduped to the millisecond.
    Contiguous cues (end_i == start_{i+1}) contribute ONE boundary, which is
    exactly the seam a corpus cutter cuts on."""
    seen, out = set(), []
    for i, (s, e, _t, _n) in enumerate(cues):
        for t in ((e,) if i == len(cues) - 1 else (e, cues[i + 1][0])):
            k = round(t, 3)
            if k not in seen:
                seen.add(k); out.append(t)
    return sorted(out)


# ---------------- heading detection ----------------

HEAD_MAX_CHARS, HEAD_MAX_WORDS = 90, 12
TERMINAL = re.compile(r'[.!?…]["”’\')\]]*$')


def looks_like_heading(block):
    b = ' '.join(block.split())
    if not b or len(b) > HEAD_MAX_CHARS or len(b.split()) > HEAD_MAX_WORDS:
        return False
    return not TERMINAL.search(b)


def epub_heading_blocks(epub_path):
    """Short, unpunctuated block-level text runs from the epub — part/chapter
    numbers, chapter titles, running heads, epigraph attributions. Crude on
    purpose: it only has to be good enough to COUNT merges, and it is applied
    identically to the before and after VTT."""
    heads = set()
    with zipfile.ZipFile(epub_path) as z:
        for n in z.namelist():
            if not n.lower().endswith(('.html', '.xhtml', '.htm')):
                continue
            s = z.read(n).decode('utf-8', 'replace')
            s = re.sub(r'<head[\s\S]*?</head>', ' ', s, flags=re.I)
            s = re.sub(r'<(script|style)[\s\S]*?</\1>', ' ', s, flags=re.I)
            for m in re.finditer(r'<(p|h[1-6]|div)\b[^>]*>([\s\S]*?)</\1>', s, flags=re.I):
                txt = re.sub(r'<[^>]+>', ' ', m.group(2))
                txt = (txt.replace('&nbsp;', ' ').replace('&amp;', '&')
                          .replace('&#8217;', '’').replace('&#8220;', '“')
                          .replace('&#8221;', '”'))
                txt = ' '.join(txt.split())
                if len(txt) >= 3 and looks_like_heading(txt) and re.search(r'[A-Za-z]', txt):
                    heads.add(txt)
    return heads


_PUNCT = str.maketrans({'‘': "'", '’': "'", '“': '"', '”': '"',
                        '–': '-', '—': '-', ' ': ' '})


def _norm(s):
    """Light normalization only — case and word boundaries are LOAD-BEARING here
    (see count_heading_merges), so nothing is lowercased or stripped of letters."""
    return ' '.join(s.translate(_PUNCT).split())


def count_heading_merges(cues, heads):
    """A cue is heading-merged when its text OPENS with a heading and then runs on
    into a new sentence. A cue that IS the heading (and nothing more) is the
    desired outcome, not a defect, so it is counted separately.

    TWO GUARDS, both learned from false positives on the first pass:

      * the heading must be at least 2 words. "McKinley" is a standalone block
        somewhere in this book (a running head), which made every one of the 60-odd
        cues that legitimately BEGIN with the word "McKinley" score as a merge.
      * what follows the heading must start with a CAPITAL — a merge is a heading
        butted against the start of a new sentence. "McKinley reclaimed my serious
        attention…" continues in lowercase and is plainly one sentence, not a
        heading plus prose.

    Both guards are applied identically to the before and after VTT, so the
    comparison stands whatever residual error the heuristic has."""
    nheads = sorted({_norm(h) for h in heads if len(_norm(h).split()) >= 2 and len(_norm(h)) >= 6},
                    key=len, reverse=True)
    merged, standalone, examples = 0, 0, []
    for s, _e, text, _n in cues:
        nt = _norm(text)
        for h in nheads:
            if nt == h:
                standalone += 1
                break
            if nt.startswith(h + ' '):
                rest = nt[len(h) + 1:]
                if not rest or not rest[0].isupper():
                    continue          # not a seam — keep looking for a longer head
                merged += 1
                if len(examples) < 12:
                    examples.append({'start': round(s, 2), 'heading': h[:60], 'text': text[:180]})
                break
    return merged, standalone, examples


def evaluate(vtt, iv, tol, epub, heads_cache):
    cues = parse_vtt(vtt)
    starts = [a for a, _b in iv]
    B = boundary_times(cues)
    d = sorted(dist_to_silence(t, starts, iv) for t in B)
    n = len(d) or 1
    hits = sum(1 for x in d if x == 0.0)
    near = sum(1 for x in d if x <= tol)
    out = {
        'vtt': os.path.abspath(vtt),
        'cues': len(cues),
        'boundaries': len(d),
        'hitRate': round(hits / n, 4),
        'nearRate': round(near / n, 4),
        'tolSeconds': tol,
        'distanceSeconds': {
            'median': round(pct(d, 50), 3), 'p75': round(pct(d, 75), 3),
            'p90': round(pct(d, 90), 3), 'p95': round(pct(d, 95), 3),
            'max': round(d[-1], 3) if d else None,
            'mean': round(sum(d) / n, 3),
        },
        'noteTaggedCues': {},
    }
    for _s, _e, _t, note in cues:
        if note:
            k = note.split()[0]
            out['noteTaggedCues'][k] = out['noteTaggedCues'].get(k, 0) + 1
    if epub:
        if heads_cache.get('h') is None:
            heads_cache['h'] = epub_heading_blocks(epub)
        merged, standalone, ex = count_heading_merges(cues, heads_cache['h'])
        out['headingMergedCues'] = merged
        out['headingStandaloneCues'] = standalone
        out['headingMergeExamples'] = ex
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vtt', required=True)
    ap.add_argument('--compare', default='', help='a second VTT (the BEFORE run) to report beside --vtt')
    ap.add_argument('--silences', required=True)
    ap.add_argument('--epub', default='')
    ap.add_argument('--tol', type=float, default=0.15)
    ap.add_argument('--json', default='')
    a = ap.parse_args()

    iv = parse_silences(a.silences)
    print(f'silence map: {len(iv)} interval(s), '
          f'{sum(b - x for x, b in iv):.0f}s total  <- {a.silences}')
    cache = {'h': None}
    results = []
    if a.compare:
        results.append(('BEFORE', evaluate(a.compare, iv, a.tol, a.epub, cache)))
    results.append(('AFTER' if a.compare else 'VTT', evaluate(a.vtt, iv, a.tol, a.epub, cache)))

    for label, r in results:
        d = r['distanceSeconds']
        print(f'\n== {label}: {os.path.basename(r["vtt"])}')
        print(f'   cues {r["cues"]}, boundaries {r["boundaries"]}')
        print(f'   boundary IN a silence      : {r["hitRate"]*100:6.2f}%')
        print(f'   boundary within {a.tol:.2f}s of one: {r["nearRate"]*100:6.2f}%')
        print(f'   distance to nearest silence: median {d["median"]}s  p75 {d["p75"]}s  '
              f'p90 {d["p90"]}s  p95 {d["p95"]}s  max {d["max"]}s  mean {d["mean"]}s')
        if 'headingMergedCues' in r:
            print(f'   heading-merged cues        : {r["headingMergedCues"]}  '
                  f'(standalone heading cues: {r["headingStandaloneCues"]})')
        if r['noteTaggedCues']:
            print(f'   NOTE-tagged cues           : {r["noteTaggedCues"]}')
    if len(results) == 2:
        b, aft = results[0][1], results[1][1]
        print('\n== DELTA (after - before)')
        print(f'   hit rate   {b["hitRate"]*100:6.2f}% -> {aft["hitRate"]*100:6.2f}%  '
              f'({(aft["hitRate"]-b["hitRate"])*100:+.2f} pts)')
        print(f'   near rate  {b["nearRate"]*100:6.2f}% -> {aft["nearRate"]*100:6.2f}%  '
              f'({(aft["nearRate"]-b["nearRate"])*100:+.2f} pts)')
        print(f'   median d   {b["distanceSeconds"]["median"]}s -> {aft["distanceSeconds"]["median"]}s')
        print(f'   p90 d      {b["distanceSeconds"]["p90"]}s -> {aft["distanceSeconds"]["p90"]}s')
        if 'headingMergedCues' in b:
            print(f'   heading-merged cues {b["headingMergedCues"]} -> {aft["headingMergedCues"]}')

    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        json.dump({'silenceMap': {'path': os.path.abspath(a.silences), 'intervals': len(iv)},
                   'results': {k: v for k, v in results}}, open(a.json, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=2)
        print(f'\nwrote {a.json}')


if __name__ == '__main__':
    main()
