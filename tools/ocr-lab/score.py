#!/usr/bin/env python3
"""
Score OCR approaches for one book against a gold reference.

The reference is a Wondershare PDFelement OCR pass over the SAME scans; its
text layer is good enough to treat as truth.  Three metrics, three questions:

  A  Current pipeline (whole-page Tesseract) vs reference.
     How much text did we never produce (missing), and how badly was the rest
     mangled (CER)?  Text-only, so it needs no coordinate reconciliation.

  B  Our band segmentation vs reference, geometrically.
     Does a band exist for every printed line, and where do its edges land?

  C  Bands + per-line Tesseract (--psm 7) on a 25-page sample.
     Does the proposed pipeline actually READ the text?  Reported next to A
     restricted to the same 25 pages, which is the comparison that decides the
     architecture.

  D  The same, over the WHOLE book, scoring the text run-book.py wrote to
     ocr-bands/.  Same matching and same exclusions as A, so the two numbers
     are comparable line for line (`compareD` prints them side by side).
     Because the reference mangles its own decorative-font lines, D also splits
     its unmatched lines into ones we genuinely lost and ones where the
     reference is the garbage - see referenceGarbage in the output.

Reference quirks handled here (see --report-quirks):
  * font ArialMT @ 7.0 is page furniture (running head + folio).  The recto
    running head is systematically mangled by the reference itself
    ("D€RTHSTRLK€R"), so furniture counts for geometric coverage (B) and is
    excluded from every text-accuracy number (A, C).
  * some reference lines have bboxes past the page edge - scan-edge specks.
    Excluded everywhere.
  * pages 0 and 530 carry no reference lines.
  * reference page dimensions differ from the render by ~0.1%; reference
    coordinates are scaled per page onto the render/band pixel grid.
"""

import argparse
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
from collections import defaultdict

try:
    import Levenshtein  # python-Levenshtein: C, ~1us per short-string compare
    _LEV = 'python-Levenshtein'

    def lev_distance(a, b):
        return Levenshtein.distance(a, b)

    def lev_ratio(a, b):
        return Levenshtein.ratio(a, b)
except ImportError:  # pragma: no cover - fallback, ~50x slower but correct
    import difflib
    _LEV = 'difflib+DP fallback'

    def lev_distance(a, b):
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                               prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]

    def lev_ratio(a, b):
        if not a and not b:
            return 1.0
        return 1.0 - (2.0 * lev_distance(a, b)) / (len(a) + len(b)) \
            if False else difflib.SequenceMatcher(None, a, b).ratio()


DEFAULT_LAB = os.path.expanduser('~/Documents/BookForge/ocr-lab/deathstalker')
DEFAULT_JOURNAL = os.path.expanduser(
    '~/Documents/BookForge/training/deathstalker-epub-derived/ocr-journal.jsonl')
DEFAULT_BLOCKS = os.path.expanduser(
    '~/Documents/BookForge/training/deathstalker-epub-derived/blocks.json')

N_PAGES = 532
EMPTY_PAGES = {0, 530}
FURNITURE_FONT = 'ArialMT'
FURNITURE_SIZE = 7.0
MIN_NORM_CHARS = 12
SIM_THRESHOLD = 0.75
INK_THRESHOLD = 100   # the scan is grey paper: background ~157, ink ~22-34

SAMPLE_FIXED = [23, 43, 362, 521]          # known whole-page-Tesseract failures
SAMPLE_SEED = 42
SAMPLE_RANGE = (10, 516)                   # 10..515 inclusive
SAMPLE_EXTRA = 21


def sample_pages():
    random.seed(SAMPLE_SEED)
    pool = [p for p in range(*SAMPLE_RANGE) if p not in SAMPLE_FIXED]
    return sorted(SAMPLE_FIXED + random.sample(pool, SAMPLE_EXTRA))


# --------------------------------------------------------------------------
# normalization
# --------------------------------------------------------------------------

_WS = re.compile(r'\s+')
_KEEP = re.compile(r"[^a-z0-9' ]+")
_LONE_APOS = re.compile(r"(?<![a-z0-9])'|'(?![a-z0-9])")


def collapse_ws(s):
    return _WS.sub(' ', s).strip()


def normalize(s):
    """lowercase, collapse whitespace, drop non-alphanumerics except
    intra-word apostrophes.  Soft hyphen is a join (removed with no space)."""
    s = s.replace('­', '')
    s = unicodedata.normalize('NFKC', s)
    s = s.replace('’', "'").replace('‘', "'")
    s = s.lower()
    s = _KEEP.sub(' ', s)
    s = _LONE_APOS.sub(' ', s)
    return _WS.sub(' ', s).strip()


def normalize_mapped(s):
    """normalize() but also return, for every character of the result, the
    index it came from in `s` - so a matched normalized span can be pulled
    back out of the raw text for a raw-string CER."""
    src_chars = []
    src_idx = []
    for i, ch in enumerate(s):
        if ch == '­':
            continue
        src_chars.append(ch)
        src_idx.append(i)
    out = []
    out_idx = []
    prev_space = True
    for ch, idx in zip(src_chars, src_idx):
        c = unicodedata.normalize('NFKC', ch)
        c = c[:1] if c else ' '
        if c in '’‘':
            c = "'"
        c = c.lower()
        if not (c.isascii() and (c.isalnum() or c in " '")):
            c = ' '
        if c == ' ':
            if prev_space:
                continue
            out.append(' ')
            out_idx.append(idx)
            prev_space = True
        else:
            out.append(c)
            out_idx.append(idx)
            prev_space = False
    # strip trailing space
    while out and out[-1] == ' ':
        out.pop()
        out_idx.pop()
    # drop apostrophes that are not intra-word
    res, res_idx = [], []
    for k, c in enumerate(out):
        if c == "'":
            prev_ok = k > 0 and out[k - 1].isalnum()
            next_ok = k + 1 < len(out) and out[k + 1].isalnum()
            if not (prev_ok and next_ok):
                if res and res[-1] != ' ':
                    res.append(' ')
                    res_idx.append(out_idx[k])
                continue
        res.append(c)
        res_idx.append(out_idx[k])
    # re-collapse any doubled spaces introduced above
    fin, fin_idx = [], []
    for c, i in zip(res, res_idx):
        if c == ' ' and (not fin or fin[-1] == ' '):
            continue
        fin.append(c)
        fin_idx.append(i)
    while fin and fin[-1] == ' ':
        fin.pop()
        fin_idx.pop()
    return ''.join(fin), fin_idx


# --------------------------------------------------------------------------
# fuzzy location of a reference line inside a page of OCR text
# --------------------------------------------------------------------------

def best_window(needle, hay):
    """Best-matching substring of `hay` for `needle`.

    Returns (similarity, start, end) in `hay` coordinates.  Coarse sliding
    scan, then a local refinement over offset and width so insertions and
    deletions inside the line do not cap the score.
    """
    n = len(needle)
    if n == 0 or not hay:
        return 0.0, 0, 0
    pos = hay.find(needle)
    if pos >= 0:
        return 1.0, pos, pos + n
    L = len(hay)
    if L <= n:
        return lev_ratio(needle, hay), 0, L
    step = max(1, n // 8)
    best = (0.0, 0, min(n, L))
    for i in range(0, L - n + 1 + step, step):
        w = hay[i:i + n]
        r = lev_ratio(needle, w)
        if r > best[0]:
            best = (r, i, i + len(w))
    # refine: offsets around the winner, widths +-25%
    bi = best[1]
    widths = sorted({n, max(1, int(n * 0.85)), int(n * 1.15), int(n * 1.3)})
    lo = max(0, bi - step - 2)
    hi = min(L, bi + step + 3)
    for i in range(lo, hi):
        for w in widths:
            seg = hay[i:i + w]
            if not seg:
                continue
            r = lev_ratio(needle, seg)
            if r > best[0]:
                best = (r, i, i + len(seg))
    return best


# --------------------------------------------------------------------------
# inputs
# --------------------------------------------------------------------------

class Lab:
    def __init__(self, lab_dir, journal=DEFAULT_JOURNAL):
        self.dir = lab_dir
        self.journal_path = journal
        self._journal = None

    def ref(self, page):
        with open(os.path.join(self.dir, 'reference', f'page-{page}.json')) as f:
            return json.load(f)

    def bands(self, page):
        with open(os.path.join(self.dir, 'bands', f'page-{page}.json')) as f:
            return json.load(f)

    def render(self, page):
        return os.path.join(self.dir, 'renders', f'page-{page}.png')

    def ocr_bands(self, page):
        with open(os.path.join(self.dir, 'ocr-bands', f'page-{page}.json')) as f:
            return json.load(f)

    def journal(self):
        if self._journal is None:
            self._journal = {}
            with open(self.journal_path) as f:
                for line in f:
                    line = line.strip()
                    if line:
                        e = json.loads(line)
                        self._journal[e['page']] = e
        return self._journal


def ref_lines(lab, page, scale_to=None):
    """Reference lines for a page, tagged and (optionally) rescaled onto the
    render pixel grid.  scale_to = (widthPx, heightPx) of the render/bands."""
    d = lab.ref(page)
    w, h = d['widthPx'], d['heightPx']
    sx = sy = 1.0
    if scale_to:
        sx, sy = scale_to[0] / w, scale_to[1] / h
    out = []
    for i, ln in enumerate(d.get('lines', [])):
        x0, y0, x1, y1 = ln['bbox']
        edge = (x0 < -0.5 or y0 < -0.5 or x1 > w + 0.5 or y1 > h + 0.5)
        furniture = (ln.get('font') == FURNITURE_FONT
                     and abs(float(ln.get('size', 0)) - FURNITURE_SIZE) < 0.51)
        raw = collapse_ws(ln.get('text', ''))
        out.append({
            'idx': i,
            'page': page,
            'bbox': [x0 * sx, y0 * sy, x1 * sx, y1 * sy],
            'rawBbox': [x0, y0, x1, y1],
            'text': raw,
            'norm': normalize(raw),
            'font': ln.get('font'),
            'size': ln.get('size'),
            'furniture': furniture,
            'edge': edge,
        })
    return out, (w, h)


def scored_ref_lines(lines):
    """Lines that count for TEXT accuracy."""
    return [l for l in lines
            if not l['edge'] and not l['furniture']
            and len(l['norm']) >= MIN_NORM_CHARS]


def geom_ref_lines(lines):
    """Lines that count for GEOMETRIC coverage (furniture included)."""
    return [l for l in lines if not l['edge']]


# --------------------------------------------------------------------------
# stats helpers
# --------------------------------------------------------------------------

def pct(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    k = min(len(xs) - 1, max(0, int(round((len(xs) - 1) * q))))
    return xs[k]


def summarize(xs):
    if not xs:
        return {'n': 0}
    return {
        'n': len(xs),
        'mean': sum(xs) / len(xs),
        'median': statistics.median(xs),
        'p95': pct(xs, 0.95),
        'max': max(xs),
    }


# --------------------------------------------------------------------------
# METRIC A - whole-page Tesseract vs reference (text only)
# --------------------------------------------------------------------------

def metric_a(lab, pages=None, verbose=True):
    journal = lab.journal()
    pages = pages if pages is not None else [p for p in range(N_PAGES)
                                             if p not in EMPTY_PAGES]
    per_page = {}
    all_cer_raw, all_cer_norm, all_sim = [], [], []
    missing_examples = []
    spurious_examples = []
    tot_lines = tot_missing = 0
    tot_ocr_lines = tot_spurious = 0
    for pg in pages:
        entry = journal.get(pg)
        page_text = entry.get('text', '') if entry else ''
        hay, hay_idx = normalize_mapped(page_text)
        lines, _ = ref_lines(lab, pg)
        scored = scored_ref_lines(lines)

        # precision side: OCR lines with no counterpart anywhere on the
        # reference page - specks, gutter marks, hallucinated fragments.
        pg_spurious = len(spurious_examples)
        pg_ocr = tot_ocr_lines
        ref_hay = normalize(' '.join(l['text'] for l in lines if not l['edge']))
        # the reference's own running head is mangled ("D€RTHSTRLK€R"), so an
        # OCR line sitting on a furniture row can never be scored for text -
        # locate furniture rows geometrically and skip those lines.
        try:
            bdims = lab.bands(pg)
            sl, _ = ref_lines(lab, pg, scale_to=(bdims['widthPx'],
                                                 bdims['heightPx']))
            furn_rows = [l['bbox'] for l in sl if l['furniture'] and not l['edge']]
        except FileNotFoundError:
            furn_rows = []
        for ol in (entry.get('textLines', []) if entry else []):
            on = normalize(ol.get('text', ''))
            if not on:
                continue
            oy0, oy1 = ol['bbox'][1], ol['bbox'][3]
            if any(overlap(oy0, oy1, f[1], f[3]) >= 0.5 * max(1, oy1 - oy0)
                   for f in furn_rows):
                continue
            tot_ocr_lines += 1
            sim = 1.0 if on in ref_hay else best_window(on, ref_hay)[0]
            if sim < SIM_THRESHOLD:
                tot_spurious += 1
                spurious_examples.append({'page': pg, 'text': ol.get('text', ''),
                                          'chars': len(on),
                                          'sim': round(sim, 3)})
        miss, cers_raw, cers_norm, sims = [], [], [], []
        for ln in scored:
            sim, i, j = best_window(ln['norm'], hay)
            sims.append(sim)
            if sim < SIM_THRESHOLD:
                miss.append({'page': pg, 'text': ln['text'], 'sim': round(sim, 3),
                             'font': ln['font'], 'size': ln['size'],
                             'bestSpan': hay[i:j][:100]})
                continue
            # raw CER on the matched span, pulled back out of the page text
            if hay_idx and j > i:
                a = hay_idx[i]
                b = hay_idx[min(j, len(hay_idx)) - 1] + 1
                raw_hyp = collapse_ws(page_text[a:b])
            else:
                raw_hyp = ''
            ref_raw = ln['text']
            cer_raw = lev_distance(ref_raw, raw_hyp) / max(1, len(ref_raw))
            cer_norm = lev_distance(ln['norm'], hay[i:j]) / max(1, len(ln['norm']))
            cers_raw.append(min(cer_raw, 2.0))
            cers_norm.append(cer_norm)
        tot_lines += len(scored)
        tot_missing += len(miss)
        all_cer_raw += cers_raw
        all_cer_norm += cers_norm
        all_sim += sims
        missing_examples += miss
        per_page[pg] = {
            'refLines': len(scored),
            'missing': len(miss),
            'cerRaw': cers_raw,
            'cerNorm': cers_norm,
            'missingLines': [m['text'] for m in miss],
            'spurious': len(spurious_examples) - pg_spurious,
            'ocrLines': tot_ocr_lines - pg_ocr,
        }
        if verbose and pg % 50 == 0:
            print(f'  A: page {pg}', file=sys.stderr)

    worst = sorted(((v['missing'], p) for p, v in per_page.items()
                    if v['missing']), reverse=True)[:15]
    page_mean_cer = [(sum(v['cerRaw']) / len(v['cerRaw']), p)
                     for p, v in per_page.items() if v['cerRaw']]
    worst_cer = sorted(page_mean_cer, reverse=True)[:15]
    empty_pages = [p for p in pages
                   if not journal.get(p, {}).get('text', '').strip()]
    def frac_over(t):
        return 100.0 * sum(1 for c in all_cer_raw if c > t) / max(1, len(all_cer_raw))
    return {
        'metric': 'A',
        'description': 'whole-page Tesseract (current pipeline) vs reference',
        'pages': len(pages),
        'refLinesScored': tot_lines,
        'missing': tot_missing,
        'missingPct': 100.0 * tot_missing / max(1, tot_lines),
        'pagesLosingALine': sum(1 for v in per_page.values() if v['missing']),
        'pagesWithNoOcrOutput': empty_pages,
        'cerBucketsPct': {'>2%': frac_over(0.02), '>5%': frac_over(0.05),
                          '>10%': frac_over(0.10), '>20%': frac_over(0.20)},
        'worstPagesByMeanCER': [{'page': p, 'meanCerRaw': round(c, 4),
                                 'refLines': per_page[p]['refLines']}
                                for c, p in worst_cer],
        'cerRaw': summarize(all_cer_raw),
        'cerNorm': summarize(all_cer_norm),
        'similarity': summarize(all_sim),
        'worstPages': [{'page': p, 'missingLines': n,
                        'refLines': per_page[p]['refLines']} for n, p in worst],
        'ocrLines': tot_ocr_lines,
        'spuriousLines': tot_spurious,
        'spuriousPct': 100.0 * tot_spurious / max(1, tot_ocr_lines),
        'spuriousExamples': spurious_examples[:400],
        'missingExamples': missing_examples[:400],
        'perPage': {str(p): {'refLines': v['refLines'], 'missing': v['missing'],
                             'cerRaw': v['cerRaw'], 'cerNorm': v['cerNorm'],
                             'spurious': v['spurious'], 'ocrLines': v['ocrLines']}
                    for p, v in per_page.items()},
    }


# --------------------------------------------------------------------------
# METRIC B - bands vs reference, geometric
# --------------------------------------------------------------------------

def overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def band_captures(ref, band_tight):
    x0, y0, x1, y1 = ref['bbox']
    bx0, by0, bx1, by1 = band_tight
    rh = max(1e-6, y1 - y0)
    rw = max(1e-6, x1 - x0)
    vo = overlap(y0, y1, by0, by1) / rh
    ho = overlap(x0, x1, bx0, bx1) / rw
    return vo >= 0.5 and ho >= 0.5, vo, ho


def side_by_side(a, b):
    """Two reference lines share a visual row (folio next to running head)."""
    ay0, ay1 = a['bbox'][1], a['bbox'][3]
    by0, by1 = b['bbox'][1], b['bbox'][3]
    h = min(ay1 - ay0, by1 - by0)
    vo = overlap(ay0, ay1, by0, by1)
    if h <= 0 or vo / h < 0.5:
        return False
    # and they must not overlap horizontally
    return overlap(a['bbox'][0], a['bbox'][2],
                   b['bbox'][0], b['bbox'][2]) <= 0.25 * min(
                       a['bbox'][2] - a['bbox'][0], b['bbox'][2] - b['bbox'][0])


def _row_centres(lines):
    rows = sorted((l['bbox'][1] + l['bbox'][3]) / 2 for l in lines
                  if not l['edge'] and l['bbox'][3] - l['bbox'][1] >= 8)
    out = []
    for c in rows:
        if out and c - out[-1][-1] < 12:
            out[-1].append(c)
        else:
            out.append([c])
    return [sum(r) / len(r) for r in out]


def estimate_offset(lines, bands):
    """The reference page box and our render do not always share a geometry.

    On a minority of pages the reference sits up to ~18 px off AND runs at a
    slightly different vertical scale (~3%), i.e. band_y ~= a*ref_y + b with
    a != 1 - a CropBox/MediaBox difference, not a segmentation failure.  Fit
    that (a, b) by 1-D ICP with several restarts (a pure cross-correlation
    aliases by one line pitch), scoring on how many reference rows AND bands
    snap into place.  Returns (a, b, votes, residual).
    """
    ref_c = _row_centres(lines)
    band_c = sorted((b['tight'][1] + b['tight'][3]) / 2 for b in bands)
    if len(ref_c) < 3 or len(band_c) < 3:
        return 1.0, 0.0, 0, None
    best = None
    for b0 in (0.0, -13.0, 13.0, -26.0, 26.0):
        a, b = 1.0, b0
        for _ in range(8):
            pairs = []
            for r in ref_c:
                y = a * r + b
                j = min(range(len(band_c)), key=lambda k: abs(band_c[k] - y))
                if abs(band_c[j] - y) <= 10:
                    pairs.append((r, band_c[j]))
            if len(pairs) < 4:
                break
            n = len(pairs)
            mx = sum(p[0] for p in pairs) / n
            my = sum(p[1] for p in pairs) / n
            sxx = sum((p[0] - mx) ** 2 for p in pairs)
            sxy = sum((p[0] - mx) * (p[1] - my) for p in pairs)
            a2 = min(1.06, max(0.94, sxy / sxx)) if sxx > 1e-6 else a
            b2 = my - a2 * mx
            done = abs(a2 - a) < 1e-6 and abs(b2 - b) < 0.05
            a, b = a2, b2
            if done:
                break
        hits_r = [min(abs(c - (a * r + b)) for c in band_c) for r in ref_c]
        hits_b = [min(abs(c - (a * r + b)) for r in ref_c) for c in band_c]
        n_r = sum(1 for h in hits_r if h <= 6)
        n_b = sum(1 for h in hits_b if h <= 6)
        resid = statistics.median([h for h in hits_r if h <= 6]) if n_r else 99.0
        key = (-(n_r + n_b), resid)
        if best is None or key < best[0]:
            best = (key, a, b, n_r + n_b, resid)
    return best[1], best[2], best[3], best[4]


def apply_offset(lines, a, b):
    for ln in lines:
        ln['bbox'][1] = a * ln['bbox'][1] + b
        ln['bbox'][3] = a * ln['bbox'][3] + b
    return lines


def metric_b(lab, pages=None, verbose=True, align=True):
    pages = pages if pages is not None else [p for p in range(N_PAGES)
                                             if p not in EMPTY_PAGES]
    misses = []
    tot = captured = split = merge = 0
    tot_sub = cap_sub = 0
    dx0, dx1, dyc = [], [], []
    scale_ratios = []
    offsets = []
    per_page = {}
    for pg in pages:
        bd = lab.bands(pg)
        bands = bd.get('bands', [])
        lines, (rw, rh) = ref_lines(lab, pg,
                                    scale_to=(bd['widthPx'], bd['heightPx']))
        scale_ratios.append((bd['widthPx'] / rw, bd['heightPx'] / rh))
        ga, gb, votes, resid = estimate_offset(lines, bands)
        offsets.append({'page': pg, 'a': round(ga, 4), 'b': round(gb, 2),
                        'votes': votes, 'refRows': len(_row_centres(lines)),
                        'bands': len(bands),
                        'residual': None if resid is None else round(resid, 2)})
        if align:
            apply_offset(lines, ga, gb)
        geo = geom_ref_lines(lines)
        band_hits = defaultdict(list)
        pg_miss = 0
        for ln in geo:
            hits = [bi for bi, b in enumerate(bands)
                    if band_captures(ln, b['tight'])[0]]
            tot += 1
            substantive = (len(ln['norm']) >= MIN_NORM_CHARS
                           or (ln['furniture'] and len(ln['norm']) >= 2
                               and ln['bbox'][2] - ln['bbox'][0] >= 20))
            tot_sub += 1 if substantive else 0
            if not hits:
                pg_miss += 1
                misses.append({'page': pg, 'text': ln['text'],
                               'bbox': [round(v, 1) for v in ln['bbox']],
                               'furniture': ln['furniture'],
                               'substantive': substantive})
                continue
            captured += 1
            cap_sub += 1 if substantive else 0
            if len(hits) > 1:
                split += 1
            for bi in hits:
                band_hits[bi].append(ln)
        # merges: a band covering 2+ VERTICALLY STACKED reference lines
        for bi, lns in band_hits.items():
            if len(lns) < 2:
                continue
            stacked = False
            for i in range(len(lns)):
                for j in range(i + 1, len(lns)):
                    if not side_by_side(lns[i], lns[j]):
                        stacked = True
            if stacked:
                merge += 1
        # boundary accuracy on strict 1:1 matches
        for ln in geo:
            hits = [bi for bi, b in enumerate(bands)
                    if band_captures(ln, b['tight'])[0]]
            if len(hits) != 1:
                continue
            bi = hits[0]
            if len(band_hits[bi]) != 1:
                continue
            bx0, by0, bx1, by1 = bands[bi]['tight']
            dx0.append(abs(bx0 - ln['bbox'][0]))
            dx1.append(abs(bx1 - ln['bbox'][2]))
            dyc.append(abs((by0 + by1) / 2 - (ln['bbox'][1] + ln['bbox'][3]) / 2))
        per_page[pg] = {'refLines': len(geo), 'bands': len(bands),
                        'missing': pg_miss}
        if verbose and pg % 50 == 0:
            print(f'  B: page {pg}', file=sys.stderr)

    sr_x = [s[0] for s in scale_ratios]
    sr_y = [s[1] for s in scale_ratios]
    return {
        'metric': 'B',
        'description': 'band segmentation vs reference, geometric coverage',
        'pages': len(pages),
        'aligned': align,
        'refLinesGeom': tot,
        'captured': captured,
        'captureRatePct': 100.0 * captured / max(1, tot),
        'substantiveRefLines': tot_sub,
        'substantiveCaptured': cap_sub,
        'substantiveCaptureRatePct': 100.0 * cap_sub / max(1, tot_sub),
        'specksInReference': tot - tot_sub,
        'refOffsets': {
            'summaryAbsB': summarize([abs(o['b']) for o in offsets]),
            'summaryScale': summarize([o['a'] for o in offsets]),
            'pagesShiftedOver5px': [o for o in offsets if abs(o['b']) > 5],
            'pagesRescaledOver1pct': [o for o in offsets if abs(o['a'] - 1) > 0.01],
            'all': offsets,
        },
        'missesCount': len(misses),
        'misses': misses,
        'splitRefLines': split,
        'mergeBands': merge,
        'boundary': {
            'n': len(dx0),
            'dx0': summarize(dx0),
            'dx1': summarize(dx1),
            'dyCenter': summarize(dyc),
        },
        'refToRenderScale': {'x': summarize(sr_x), 'y': summarize(sr_y)},
        'perPage': {str(p): v for p, v in per_page.items()},
    }


# --------------------------------------------------------------------------
# METRIC C - bands + per-line Tesseract on a sample
# --------------------------------------------------------------------------

def tesseract_version():
    out = subprocess.run(['tesseract', '--version'], capture_output=True,
                         text=True)
    return (out.stdout or out.stderr).splitlines()[0].strip()


def ocr_crop(png_path, tmpdir):
    r = subprocess.run(['tesseract', png_path, 'stdout', '--psm', '7',
                        '--dpi', '200', '-l', 'eng'],
                       capture_output=True, text=True,
                       env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
    return collapse_ws(r.stdout)


def metric_c(lab, pages=None, verbose=True, ink_threshold=INK_THRESHOLD):
    from PIL import Image
    import numpy as np

    pages = pages or sample_pages()
    tmpdir = tempfile.mkdtemp(prefix='ocrlab-')
    per_page = {}
    page_seconds = []
    empty_with_ink = []
    all_sim, all_cer_raw, all_cer_norm = [], [], []
    tot_ref = tot_recalled = 0
    tot_band_texts = tot_spurious = 0
    spurious = []
    examples = []

    for pg in pages:
        bd = lab.bands(pg)
        bands = bd.get('bands', [])
        img = None
        for attempt in range(3):
            try:
                img = Image.open(lab.render(pg)).convert('L')
                img.load()
                break
            except Exception as e:                      # iCloud fileprovider
                if attempt == 2:
                    raise
                time.sleep(1.0)
        arr = np.asarray(img)
        if (arr.shape[1], arr.shape[0]) != (bd['widthPx'], bd['heightPx']):
            print(f'  ! page {pg}: render {arr.shape[1]}x{arr.shape[0]} vs '
                  f'bands {bd["widthPx"]}x{bd["heightPx"]}', file=sys.stderr)

        texts = []
        t0 = time.perf_counter()
        for bi, b in enumerate(bands):
            x0, y0, x1, y1 = [int(round(v)) for v in b['crop']]
            x0 = max(0, x0); y0 = max(0, y0)
            x1 = min(arr.shape[1], x1); y1 = min(arr.shape[0], y1)
            path = os.path.join(tmpdir, f'p{pg}_b{bi}.png')
            img.crop((x0, y0, x1, y1)).save(path)
            texts.append(ocr_crop(path, tmpdir))
            os.unlink(path)
        secs = time.perf_counter() - t0
        page_seconds.append(secs)

        # ink check on empty results
        for bi, b in enumerate(bands):
            if texts[bi]:
                continue
            x0, y0, x1, y1 = [int(round(v)) for v in b['tight']]
            sub = arr[max(0, y0):y1, max(0, x0):x1]
            ink = int((sub < ink_threshold).sum()) if sub.size else 0
            if ink >= 20:
                empty_with_ink.append({'page': pg, 'band': bi,
                                       'tight': b['tight'], 'inkPx': ink})

        lines, _ = ref_lines(lab, pg, scale_to=(bd['widthPx'], bd['heightPx']))
        ga, gb, votes, resid = estimate_offset(lines, bands)
        apply_offset(lines, ga, gb)
        scored = scored_ref_lines(lines)
        pg_recall = 0
        sims, cers_raw, cers_norm = [], [], []
        for ln in scored:
            hits = [bi for bi, b in enumerate(bands)
                    if band_captures(ln, b['tight'])[0]]
            hay_raw = ' '.join(texts[bi] for bi in hits if texts[bi])
            hay, hay_idx = normalize_mapped(hay_raw)
            sim, i, j = best_window(ln['norm'], hay) if hay else (0.0, 0, 0)
            sims.append(sim)
            if sim >= SIM_THRESHOLD:
                pg_recall += 1
                if hay_idx and j > i:
                    a = hay_idx[i]
                    b_ = hay_idx[min(j, len(hay_idx)) - 1] + 1
                    raw_hyp = collapse_ws(hay_raw[a:b_])
                else:
                    raw_hyp = ''
                cers_raw.append(min(lev_distance(ln['text'], raw_hyp)
                                    / max(1, len(ln['text'])), 2.0))
                cers_norm.append(lev_distance(ln['norm'], hay[i:j])
                                 / max(1, len(ln['norm'])))
            else:
                examples.append({'page': pg, 'ref': ln['text'],
                                 'got': hay_raw[:120], 'sim': round(sim, 3)})
        # precision side, same rule as metric A: band text with no
        # counterpart anywhere on the reference page
        ref_hay = normalize(' '.join(l['text'] for l in lines if not l['edge']))
        pg_spur = 0
        for bi, t in enumerate(texts):
            on = normalize(t)
            if not on:
                continue
            tot_band_texts += 1
            sim = 1.0 if on in ref_hay else best_window(on, ref_hay)[0]
            if sim < SIM_THRESHOLD:
                pg_spur += 1
                tot_spurious += 1
                spurious.append({'page': pg, 'band': bi, 'text': t[:80],
                                 'sim': round(sim, 3)})
        tot_ref += len(scored)
        tot_recalled += pg_recall
        all_sim += sims
        all_cer_raw += cers_raw
        all_cer_norm += cers_norm
        per_page[pg] = {
            'bands': len(bands), 'refLines': len(scored),
            'recalled': pg_recall, 'seconds': secs,
            'cerRaw': cers_raw, 'cerNorm': cers_norm,
            'emptyBands': sum(1 for t in texts if not t),
            'spurious': pg_spur,
            'refAlign': {'a': round(ga, 4), 'b': round(gb, 2), 'votes': votes},
            'bandText': texts,
        }
        if verbose:
            print(f'  C: page {pg}  bands={len(bands)}  '
                  f'recall={pg_recall}/{len(scored)}  {secs:.1f}s',
                  file=sys.stderr)

    return {
        'metric': 'C',
        'description': 'bands + per-line Tesseract --psm 7 on a 25-page sample',
        'tesseract': tesseract_version(),
        'pages': pages,
        'refLinesScored': tot_ref,
        'recalled': tot_recalled,
        'lineRecallPct': 100.0 * tot_recalled / max(1, tot_ref),
        'cerRaw': summarize(all_cer_raw),
        'cerNorm': summarize(all_cer_norm),
        'similarity': summarize(all_sim),
        'secondsPerPage': summarize(page_seconds),
        'emptyBandsWithInk': {
            'count': len(empty_with_ink),
            'pages': sorted({e['page'] for e in empty_with_ink}),
            'items': empty_with_ink[:80],
        },
        'bandTexts': tot_band_texts,
        'spuriousLines': tot_spurious,
        'spuriousPct': 100.0 * tot_spurious / max(1, tot_band_texts),
        'spuriousExamples': spurious[:60],
        'failures': examples[:60],
        'perPage': {str(p): v for p, v in per_page.items()},
    }


# --------------------------------------------------------------------------
# METRIC D - bands + per-line Tesseract over the WHOLE book (ocr-bands/)
# --------------------------------------------------------------------------

DICT_PATHS = ('/usr/share/dict/words', '/usr/dict/words')


def load_dictionary():
    """A word list, for telling English from symbol salad.  Absent, every
    caller falls back to a shape test, so the classification degrades rather
    than disappearing."""
    for p in DICT_PATHS:
        if os.path.exists(p):
            with open(p, errors='ignore') as f:
                return {w.strip().lower() for w in f if w.strip()}
    return set()


def english_share(text, words):
    """(share, count) of a line's tokens that read as English.  With a
    dictionary that is a lookup (plus the plural/possessive the OCR of a novel
    is full of); without one it is the shape of a word: vowels, and no run of
    consonants a real word would not have.  Tokens under three characters are
    ignored - "ae", "hs", "cl" are what mangled text is MADE of, and counting
    them lets garbage score as English."""
    toks = [t for t in normalize(text).split() if len(t) >= 3]
    if not toks:
        return 0.0, 0
    hit = 0
    for t in toks:
        s = t.replace("'", '')
        if words:
            if s in words or s.rstrip('s') in words or s + 's' in words:
                hit += 1
        elif re.search(r'[aeiouy]', s) and not re.search(r'[bcdfghjklmnpqrstvwxz]{4}', s):
            hit += 1
    return hit / len(toks), hit


_ODD = re.compile(r"[^\x20-\x7e‘’“”—–…­]")


def metric_d(lab, pages=None, verbose=True):
    """Whole-book text accuracy of the bands + --psm 7 output.

    Matching, normalization and exclusions are metric A's, deliberately: the
    haystack is the page's whole OCR text, so a line the segmentation split or
    merged still matches, and the two metrics differ only in how the text was
    produced.  Furniture (ArialMT@7), reference edge specks and lines under
    MIN_NORM_CHARS are out of the text score exactly as in A.
    """
    pages = pages if pages is not None else [p for p in range(N_PAGES)
                                             if p not in EMPTY_PAGES]
    words = load_dictionary()
    per_page = {}
    all_cer_raw, all_cer_norm, all_sim = [], [], []
    missing, spurious = [], []
    tot_lines = tot_missing = 0
    tot_bands = tot_empty = tot_texts = tot_spurious = 0
    empty_pages = []
    missing_pages_no_output = []
    for pg in pages:
        try:
            od = lab.ocr_bands(pg)
        except FileNotFoundError:
            missing_pages_no_output.append(pg)
            continue
        ocr = od.get('lines', [])
        tot_bands += len(ocr)
        n_empty = sum(1 for l in ocr if not l['text'].strip())
        tot_empty += n_empty
        if n_empty:
            empty_pages.append({'page': pg, 'emptyBands': n_empty,
                                'bands': len(ocr)})
        page_text = ' '.join(l['text'] for l in ocr if l['text'].strip())
        hay, hay_idx = normalize_mapped(page_text)
        lines, _ = ref_lines(lab, pg)
        scored = scored_ref_lines(lines)

        # precision side, metric A's rule: our text with no counterpart
        # anywhere on the reference page.  Furniture rows are skipped, since
        # the reference mangles its own running head and could never match.
        ref_hay = normalize(' '.join(l['text'] for l in lines if not l['edge']))
        furn_rows = []
        try:
            sl, _ = ref_lines(lab, pg, scale_to=(od['widthPx'], od['heightPx']))
            bands = [{'tight': l['bbox']} for l in ocr]
            ga, gb, _v, _r = estimate_offset(sl, bands)
            apply_offset(sl, ga, gb)
            furn_rows = [l['bbox'] for l in sl if l['furniture'] and not l['edge']]
        except (FileNotFoundError, KeyError):
            pass
        pg_spur = pg_texts = 0
        for l in ocr:
            on = normalize(l['text'])
            if not on:
                continue
            y0, y1 = l['bbox'][1], l['bbox'][3]
            if any(overlap(y0, y1, f[1], f[3]) >= 0.5 * max(1, y1 - y0)
                   for f in furn_rows):
                continue
            pg_texts += 1
            tot_texts += 1
            sim = 1.0 if on in ref_hay else best_window(on, ref_hay)[0]
            if sim < SIM_THRESHOLD:
                pg_spur += 1
                tot_spurious += 1
                spurious.append({'page': pg, 'text': l['text'][:90],
                                 'sim': round(sim, 3)})

        miss, cers_raw, cers_norm, sims = [], [], [], []
        for ln in scored:
            sim, i, j = best_window(ln['norm'], hay) if hay else (0.0, 0, 0)
            sims.append(sim)
            if sim < SIM_THRESHOLD:
                near = collapse_ws(page_text[hay_idx[i]:
                                             hay_idx[min(j, len(hay_idx)) - 1] + 1]
                                   ) if hay_idx and j > i else ''
                rs, _rw = english_share(ln['text'], words)
                os_, ow = english_share(near, words)
                miss.append({'page': pg, 'ref': ln['text'], 'ours': near[:120],
                             'sim': round(sim, 3), 'font': ln['font'],
                             'size': ln['size'],
                             'refEnglishShare': round(rs, 2),
                             'ourEnglishShare': round(os_, 2),
                             'ourEnglishWords': ow,
                             'refOddChars': len(_ODD.findall(ln['text']))})
                continue
            if hay_idx and j > i:
                a = hay_idx[i]
                b = hay_idx[min(j, len(hay_idx)) - 1] + 1
                raw_hyp = collapse_ws(page_text[a:b])
            else:
                raw_hyp = ''
            cers_raw.append(min(lev_distance(ln['text'], raw_hyp)
                                / max(1, len(ln['text'])), 2.0))
            cers_norm.append(lev_distance(ln['norm'], hay[i:j])
                             / max(1, len(ln['norm'])))
        tot_lines += len(scored)
        tot_missing += len(miss)
        all_cer_raw += cers_raw
        all_cer_norm += cers_norm
        all_sim += sims
        missing += miss
        per_page[pg] = {'refLines': len(scored), 'missing': len(miss),
                        'bands': len(ocr), 'emptyBands': n_empty,
                        'cerRaw': cers_raw, 'cerNorm': cers_norm,
                        # ocrLines counts what the precision side scored, i.e.
                        # metric A's rule: non-empty and off the furniture rows.
                        'spurious': pg_spur, 'ocrLines': pg_texts}
        if verbose and pg % 50 == 0:
            print(f'  D: page {pg}', file=sys.stderr)

    # The reference OCR mangles the book's decorative fonts ("CHRPT€R
    # €L€V€N", "D€RTHSTRLK€R"), so some of what scores as OUR miss is the
    # reference being wrong.  Split the unmatched lines on the evidence:
    # our text reads as English and the reference's does not.
    garbage, genuine = [], []
    for m in missing:
        ref_bad = (m['refOddChars'] > 0 or m['refEnglishShare'] < 0.5)
        # two real words, not one lucky three-letter token in a row of debris.
        we_good = m['ourEnglishShare'] >= 0.6 and m['ourEnglishWords'] >= 2
        (garbage if (ref_bad and we_good
                     and m['ourEnglishShare'] - m['refEnglishShare'] >= 0.3)
         else genuine).append(m)

    def frac_over(t):
        return 100.0 * sum(1 for c in all_cer_raw if c > t) / max(1, len(all_cer_raw))

    return {
        'metric': 'D',
        'description': 'bands + per-line Tesseract --psm 7, whole book',
        'pages': len(per_page),
        'pagesWithNoOcrBandsFile': missing_pages_no_output,
        'refLinesScored': tot_lines,
        'recalled': tot_lines - tot_missing,
        'lineRecallPct': 100.0 * (tot_lines - tot_missing) / max(1, tot_lines),
        'missing': tot_missing,
        'missingPct': 100.0 * tot_missing / max(1, tot_lines),
        'pagesLosingALine': sum(1 for v in per_page.values() if v['missing']),
        'cerBucketsPct': {'>2%': frac_over(0.02), '>5%': frac_over(0.05),
                          '>10%': frac_over(0.10), '>20%': frac_over(0.20)},
        'cerRaw': summarize(all_cer_raw),
        'cerNorm': summarize(all_cer_norm),
        'similarity': summarize(all_sim),
        'bands': tot_bands,
        'emptyTextBands': tot_empty,
        'emptyTextPages': empty_pages,
        'ocrLines': tot_texts,
        'spuriousLines': tot_spurious,
        'spuriousPct': 100.0 * tot_spurious / max(1, tot_texts),
        'spuriousExamples': spurious[:400],
        'genuineMissesCount': len(genuine),
        'genuineMisses': genuine,
        'referenceGarbageCount': len(garbage),
        'referenceGarbage': garbage,
        'dictionary': bool(words),
        'perPage': {str(p): v for p, v in per_page.items()},
    }


def compare_a_d(scores_dir):
    """Whole-book old vs new, on exactly the pages both metrics scored."""
    A = json.load(open(os.path.join(scores_dir, 'metric-A.json')))
    D = json.load(open(os.path.join(scores_dir, 'metric-D.json')))
    pages = sorted(set(A['perPage']) & set(D['perPage']), key=int)
    rows = {}
    for name, M in (('old_wholePageTesseract', A), ('new_bandsPlusPsm7', D)):
        lines = miss = spur = ocr = 0
        cer_raw, cer_norm = [], []
        for p in pages:
            v = M['perPage'][p]
            lines += v['refLines']
            miss += v['missing']
            cer_raw += v['cerRaw']
            cer_norm += v['cerNorm']
            spur += v.get('spurious', 0)
            ocr += v.get('ocrLines', 0)
        rows[name] = {
            'refLines': lines, 'missing': miss,
            'lineRecallPct': 100.0 * (lines - miss) / max(1, lines),
            'cerRaw': summarize(cer_raw), 'cerNorm': summarize(cer_norm),
            'ocrLines': ocr, 'spuriousLines': spur,
            'spuriousPct': 100.0 * spur / max(1, ocr),
        }
    rows['old_wholePageTesseract']['pagesWithNoOcrOutput'] = \
        A.get('pagesWithNoOcrOutput', [])
    rows['new_bandsPlusPsm7'].update({
        'emptyTextBands': D['emptyTextBands'],
        'genuineMisses': D['genuineMissesCount'],
        'referenceGarbageMisses': D['referenceGarbageCount'],
    })
    watch = {}
    for p in ('382', '522'):
        if p in A['perPage'] and p in D['perPage']:
            watch[p] = {'old': A['perPage'][p], 'new': D['perPage'][p]}
            for side in watch[p].values():
                side.pop('cerRaw', None)
                side.pop('cerNorm', None)
    return {'metric': 'A-vs-D', 'pages': len(pages), **rows,
            'pagesWholePageTesseractLost': watch}


# --------------------------------------------------------------------------
# geometry sanity check for the current-pipeline blocks
# --------------------------------------------------------------------------

def check_scale(lab, blocks_path=DEFAULT_BLOCKS, pages=(23, 100, 200)):
    """Establish empirically what coordinate space blocks.json / the journal
    line boxes live in, by ink density inside vs outside the boxes."""
    from PIL import Image
    import numpy as np
    blocks = json.load(open(blocks_path))
    by_page = defaultdict(list)
    for b in blocks['blocks']:
        by_page[b['page']].append(b)
    journal = lab.journal()
    out = []
    for pg in pages:
        img = Image.open(lab.render(pg)).convert('L')
        arr = np.asarray(img)
        H, W = arr.shape
        pd = blocks['pageDimensions'][pg]
        rec = {'page': pg, 'render': [W, H],
               'blocksPageDim': [pd['width'], pd['height']],
               'scaleX': W / pd['width'], 'scaleY': H / pd['height']}
        ink = (arr < INK_THRESHOLD)
        total_ink = int(ink.sum())
        jl = [tuple(l['bbox']) for l in journal[pg]['textLines']]
        for label, boxes in (
                ('blocks@scale', [(b['x'] * rec['scaleX'], b['y'] * rec['scaleY'],
                                   (b['x'] + b['w']) * rec['scaleX'],
                                   (b['y'] + b['h']) * rec['scaleY'])
                                  for b in by_page[pg]]),
                ('blocks@raw', [(b['x'], b['y'], b['x'] + b['w'], b['y'] + b['h'])
                                for b in by_page[pg]]),
                ('journalLines@raw', jl),
                ('journalLines@div', [(x0 / rec['scaleX'], y0 / rec['scaleY'],
                                       x1 / rec['scaleX'], y1 / rec['scaleY'])
                                      for x0, y0, x1, y1 in jl]),
                ('bands@tight', [tuple(b['tight'])
                                 for b in lab.bands(pg)['bands']])):
            mask = np.zeros_like(ink)
            for x0, y0, x1, y1 in boxes:
                x0 = max(0, int(x0)); y0 = max(0, int(y0))
                x1 = min(W, int(x1)); y1 = min(H, int(y1))
                if x1 > x0 and y1 > y0:
                    mask[y0:y1, x0:x1] = True
            inside = int((ink & mask).sum())
            rec[label] = {'boxes': len(boxes),
                          'inkCovered': inside,
                          'inkCoveredPct': 100.0 * inside / max(1, total_ink),
                          'areaPct': 100.0 * float(mask.sum()) / mask.size}
        out.append(rec)
    return out


def compare_a_c(scores_dir):
    """Old pipeline vs new pipeline on the SAME pages - the deliverable."""
    A = json.load(open(os.path.join(scores_dir, 'metric-A.json')))
    C = json.load(open(os.path.join(scores_dir, 'metric-C.json')))
    pages = [str(p) for p in C['pages']]
    a_lines = a_missing = a_spur = a_ocr = 0
    a_cer = []
    for p in pages:
        v = A['perPage'][p]
        a_lines += v['refLines']
        a_missing += v['missing']
        a_cer += v['cerRaw']
        a_spur += v.get('spurious', 0)
        a_ocr += v.get('ocrLines', 0)
    c_lines = C['refLinesScored']
    c_missing = c_lines - C['recalled']
    c_cer = []
    for p in pages:
        c_cer += C['perPage'][p]['cerRaw']
    return {
        'metric': 'A-vs-C',
        'pages': C['pages'],
        'old_wholePageTesseract': {
            'refLines': a_lines,
            'missing': a_missing,
            'lineRecallPct': 100.0 * (a_lines - a_missing) / max(1, a_lines),
            'cerRaw': summarize(a_cer),
            'ocrLines': a_ocr,
            'spuriousLines': a_spur,
            'spuriousPct': 100.0 * a_spur / max(1, a_ocr),
        },
        'new_bandsPlusPsm7': {
            'refLines': c_lines,
            'missing': c_missing,
            'lineRecallPct': C['lineRecallPct'],
            'cerRaw': summarize(c_cer),
            'ocrLines': C.get('bandTexts'),
            'spuriousLines': C.get('spuriousLines'),
            'spuriousPct': C.get('spuriousPct'),
            'emptyBandsWithInk': C['emptyBandsWithInk']['count'],
            'secondsPerPageSingleThread': C['secondsPerPage'],
        },
    }


def report_quirks(lab):
    edge = furniture = total = 0
    empty = []
    fonts = defaultdict(int)
    for pg in range(N_PAGES):
        lines, _ = ref_lines(lab, pg)
        if not lines:
            empty.append(pg)
        for l in lines:
            total += 1
            fonts[(l['font'], l['size'])] += 1
            if l['edge']:
                edge += 1
            if l['furniture']:
                furniture += 1
    return {'refLinesTotal': total, 'edgeArtifacts': edge,
            'furnitureLines': furniture, 'emptyPages': empty,
            'fontsSizes': sorted(((f'{k[0]}@{k[1]}', v) for k, v in fonts.items()),
                                 key=lambda kv: -kv[1])[:12]}


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('metric',
                    choices=['A', 'B', 'C', 'D', 'compare', 'compareD',
                             'scale', 'quirks'])
    ap.add_argument('--lab', default=DEFAULT_LAB)
    ap.add_argument('--journal', default=DEFAULT_JOURNAL)
    ap.add_argument('--blocks', default=DEFAULT_BLOCKS)
    ap.add_argument('--out', default=None, help='directory for the JSON result')
    ap.add_argument('--pages', default=None,
                    help='comma list or a-b range; default = all (A,B) '
                         'or the seeded 25-page sample (C)')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--no-align', action='store_true',
                    help='do not correct the reference-to-render page offset')
    args = ap.parse_args()

    lab = Lab(args.lab, args.journal)
    pages = None
    if args.pages:
        pages = []
        for part in args.pages.split(','):
            if '-' in part:
                a, b = part.split('-')
                pages += list(range(int(a), int(b) + 1))
            else:
                pages.append(int(part))
        pages = [p for p in pages if p not in EMPTY_PAGES]

    t0 = time.time()
    if args.metric == 'A':
        res = metric_a(lab, pages, verbose=not args.quiet)
    elif args.metric == 'B':
        res = metric_b(lab, pages, verbose=not args.quiet,
                       align=not args.no_align)
    elif args.metric == 'C':
        res = metric_c(lab, pages, verbose=not args.quiet)
    elif args.metric == 'D':
        res = metric_d(lab, pages, verbose=not args.quiet)
    elif args.metric == 'compare':
        res = compare_a_c(args.out or '.')
    elif args.metric == 'compareD':
        res = compare_a_d(args.out or '.')
    elif args.metric == 'scale':
        res = {'metric': 'scale',
               'checks': check_scale(lab, args.blocks, pages or (23, 100, 200))}
    else:
        res = {'metric': 'quirks', **report_quirks(lab)}
    res['editDistanceImpl'] = _LEV
    res['elapsedSec'] = round(time.time() - t0, 1)

    text = json.dumps(res, indent=1)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        suffix = '' if pages is None else f'-{len(pages)}p'
        path = os.path.join(args.out, f'metric-{args.metric}{suffix}.json')
        with open(path, 'w') as f:
            f.write(text)
        print(f'wrote {path}', file=sys.stderr)
    slim = {k: v for k, v in res.items()
            if k not in ('perPage', 'missingExamples', 'misses', 'failures',
                         'genuineMisses', 'referenceGarbage',
                         'spuriousExamples', 'emptyTextPages')}
    print(json.dumps(slim, indent=1)[:6000])


if __name__ == '__main__':
    main()
