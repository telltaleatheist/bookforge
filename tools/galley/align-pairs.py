"""Geometry alignment: what the typesetter wrote vs what Tesseract read.

No text matching decides WHICH truth goes with WHICH OCR unit. We rendered the
page ourselves at a known scale, so every truth word's box and every OCR line's
box are in the same coordinate space (page points, top-left origin). A truth word
belongs to the OCR line whose box it physically overlaps most. That is the whole
correspondence — edit distance is only ever used afterwards, to SCORE a pair that
geometry already established.

Usage: align.py <dump.json> <pdf> <bookLabel> <pairs.jsonl.out> <stats.json.out>
"""
import fitz, json, sys, os, unicodedata, difflib
import numpy as np
from collections import Counter, defaultdict

dump_path, pdf_path, book, pairs_out, stats_out = sys.argv[1:6]
# Degraded rasters are re-wrapped as their own short PDF, so page N of the dump
# is page N+OFFSET of the book the truth comes from.
OFFSET = int(sys.argv[6]) if len(sys.argv) > 6 else 0
D = json.load(open(dump_path))
SCALE = D['renderScale']

# ── edit distance ────────────────────────────────────────────────────────────
def lev(a, b):
    """Levenshtein distance, row-vectorized so book-length blocks stay cheap."""
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = np.arange(len(b) + 1, dtype=np.int32)
    bb = np.frombuffer(b.encode('utf-32-le'), dtype=np.uint32)
    for i, ca in enumerate(a, 1):
        cur = np.empty_like(prev)
        cur[0] = i
        sub = prev[:-1] + (bb != ord(ca))
        # DP with the insertion dependency resolved by a running min pass
        cur[1:] = np.minimum(sub, prev[1:] + 1)
        for j in range(1, len(b) + 1):
            if cur[j - 1] + 1 < cur[j]:
                cur[j] = cur[j - 1] + 1
        prev = cur
    return int(prev[-1])

def ws(s):
    """Collapse whitespace — line wrapping is layout, not recognition.

    That claim is true for CHARACTER repair, which is all galley did when this
    was written, and the collapsed `ocr`/`truth` fields plus every CER derived
    from them keep exactly this meaning — 34+ books are already mined on them
    and build-corpus.mjs reads them, so they must never change.

    It is NOT true for PARAGRAPH repair. OCR routinely welds two paragraphs into
    one block or splits one across two, and once ws() has run the evidence is
    gone. So the pairs now ALSO carry the un-collapsed forms (`ocrRaw`,
    `truthRaw`) and the per-line material they were built from (`ocrLines`,
    `truthLines`, `truthPar`). Additive only: nothing above or below reads them.
    """
    return ' '.join(s.split())

QUOTES = {'‘': "'", '’': "'", '“': '"', '”': '"',
          '–': '-', '—': '-', '‒': '-', '‐': '-', '‑': '-',
          'ʼ': "'", '­': ''}
def typographic_fold(s):
    """NFKC (splits ligatures, folds sub/superscripts) + quote/dash flattening."""
    s = unicodedata.normalize('NFKC', s)
    return ''.join(QUOTES.get(c, c) for c in s)

# ── truth: per-word boxes from the typesetter's own text layer ───────────────
doc = fitz.open(pdf_path)
truth_pages = {}
geom = []
for pg_rec in D['pages']:
    p = pg_rec['page']
    page = doc[p + OFFSET]
    geom.append({'page': p, 'rect': list(page.rect), 'mediabox': list(page.mediabox),
                 'cropbox': list(page.cropbox), 'rotation': page.rotation})
    words = []
    for (x0, y0, x1, y1, w, bno, lno, wno) in page.get_text('words'):
        if w.strip():
            words.append({'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 't': w,
                          'b': bno, 'l': lno, 'w': wno})
    truth_pages[p] = words

# ── correspondence: max box overlap, nothing else ───────────────────────────
MIN_OVERLAP = 0.30      # of the truth word's own area
line_truth = {}         # (page, lineIdx) -> truth text
line_rec = {}
unclaimed = defaultdict(list)

for pg_rec in D['pages']:
    p = pg_rec['page']
    words = truth_pages.get(p, [])
    boxes = []
    for i, ln in enumerate(pg_rec['lines']):
        x1, y1, x2, y2 = ln['bbox']
        boxes.append((x1 / SCALE, y1 / SCALE, x2 / SCALE, y2 / SCALE))
    assigned = defaultdict(list)
    for wi, w in enumerate(words):
        warea = max(1e-6, (w['x1'] - w['x0']) * (w['y1'] - w['y0']))
        best, best_ov = -1, 0.0
        for i, (bx0, by0, bx1, by1) in enumerate(boxes):
            ox = min(w['x1'], bx1) - max(w['x0'], bx0)
            oy = min(w['y1'], by1) - max(w['y0'], by0)
            if ox <= 0 or oy <= 0: continue
            ov = ox * oy / warea
            if ov > best_ov: best_ov, best = ov, i
        if best >= 0 and best_ov >= MIN_OVERLAP:
            assigned[best].append(w)
        else:
            unclaimed[p].append(w)
    for i, ln in enumerate(pg_rec['lines']):
        # Sorted by x ALONE. Membership of this line was already decided by the
        # line box, so any y term only re-sorts within it — and it did: figures
        # and superscripts sit on their own baselines, so a y-bucketed sort threw
        # "in December 1946," out to the end of the line and charged Tesseract
        # for a scramble the truth extractor had introduced.
        ws_ = sorted(assigned.get(i, []), key=lambda w: w['x0'])
        line_truth[(p, i)] = ' '.join(w['t'] for w in ws_)
        # PyMuPDF's OWN block/line numbering, carried through for the first and
        # last truth word that landed on this OCR line. This is the typesetter's
        # paragraph structure, independent of Tesseract's segmentation, and it is
        # the ONLY signal in this corpus that can say "the truth broke here and
        # the OCR did not". Geometry still decides membership; these numbers are
        # recorded, never used to assign.
        line_rec[(p, i)] = {'ocr': ln['text'], 'conf': ln['conf'], 'nwords': len(ws_),
                            'box': boxes[i],
                            'tpar': [ws_[0]['b'], ws_[0]['l'],
                                     ws_[-1]['b'], ws_[-1]['l']] if ws_ else None}

# ── block-level: the app's own segmentation, its own line-join rule ──────────
def line_separator(prev, nxt):
    """Mirror of shared/text/line-join.ts — a wrap hyphen is the one kept break."""
    import re
    return '\n' if (re.search(r'[A-Za-zÀ-ÿ]-[ \t]*$', prev) and
                    re.match(r'^[ \t]*[A-Za-zÀ-ÿ]', nxt)) else ' '

# map a block's line boxes back to the raw lines that made them
lines_by_key = {}
for pg_rec in D['pages']:
    p = pg_rec['page']
    for i, ln in enumerate(pg_rec['lines']):
        x1, y1, x2, y2 = ln['bbox']
        key = (p, round(x1 / SCALE, 1), round(y1 / SCALE, 1),
               round((x2 - x1) / SCALE, 1), round((y2 - y1) / SCALE, 1))
        lines_by_key[key] = i

pairs, stats_blocks = [], []
lost_lines = 0
for b in D['blocks']:
    idxs = []
    for (lx, ly, lw, lh) in b['lineBoxes']:
        i = lines_by_key.get((b['page'], lx, ly, lw, lh))
        if i is None:
            lost_lines += 1
        idxs.append(i)
    tlines = [line_truth.get((b['page'], i), '') if i is not None else '' for i in idxs]
    nwords = sum(line_rec[(b['page'], i)]['nwords'] if i is not None else 0 for i in idxs)
    truth = ''
    for i, t in enumerate(tlines):
        truth = t if i == 0 else truth + line_separator(truth, t) + t
    ocr = b['text']
    # The material `truth` and `ocr` were assembled FROM, before ws() flattens
    # it. `truthLines[i]` is the truth for `ocrLines[i]` — same index, because
    # geometry assigned truth words to that very OCR line box. Kept as arrays
    # rather than one joined string because line_separator() is lossy on
    # purpose: it emits '\n' only at a wrap hyphen and ' ' everywhere else, so
    # from the joined form alone you cannot tell where the page actually broke.
    olines = [line_rec[(b['page'], i)]['ocr'] if i is not None else '' for i in idxs]
    tpar = [line_rec[(b['page'], i)]['tpar'] if i is not None else None for i in idxs]
    o, t = ws(ocr), ws(truth)
    ratio = (len(t) / len(o)) if o else 0.0
    matched = (all(x for x in tlines) and 0.6 <= ratio <= 1.6 and len(o) >= 3)
    d = lev(t, o) if t else None
    cer = (d / len(t)) if t else None
    tf, of = typographic_fold(t), typographic_fold(o)
    df = lev(tf, of) if t else None
    cerf = (df / len(tf)) if t else None
    # Case-folded on top: small-caps running heads sit in the text layer as
    # lowercase but LOOK like capitals, so Tesseract's "error" there is a
    # property of the truth, not of the recognition.
    dc = lev(tf.lower(), of.lower()) if t else None
    cerc = (dc / len(tf)) if t else None
    stats_blocks.append({'page': b['page'], 'id': b['id'], 'cat': b['category'],
                         'matched': matched, 'ratio': ratio, 'cer': cer, 'cerFold': cerf,
                         'cerCase': cerc,
                         'nTruthChars': len(t), 'nOcrChars': len(o), 'conf': b['conf'],
                         'emptyLines': sum(1 for x in tlines if not x), 'nLines': len(tlines)})
    if matched:
        pairs.append({'book': book, 'page': b['page'], 'blockId': b['id'],
                      'category': b['category'], 'ocr': o, 'truth': t,
                      'cer': round(cer, 5), 'cerFolded': round(cerf, 5),
                      'cerFoldedCaseless': round(cerc, 5),
                      'ocrConf': b['conf'],
                      # ── additive, for paragraph repair. Everything above is
                      # unchanged and unchanged in meaning. ──
                      'ocrRaw': ocr, 'truthRaw': truth,
                      'ocrLines': olines, 'truthLines': tlines, 'truthPar': tpar})

# ── error taxonomy, from the pairs geometry already established ─────────────
LIG = {'ﬁ', 'ﬂ', 'ﬀ', 'ﬃ', 'ﬄ', 'ﬅ', 'ﬆ', 'œ', 'æ', 'Œ', 'Æ'}
CONFUSE = {frozenset('l1'), frozenset('lI'), frozenset('1I'), frozenset('li'),
           frozenset('0O'), frozenset('0o'), frozenset('Oo'), frozenset('5S'),
           frozenset('8B'), frozenset('rn'), frozenset('cC'), frozenset('vy')}
tax = Counter()
examples = defaultdict(list)

def has_diacritic(s):
    return any(unicodedata.combining(c) or (unicodedata.decomposition(c) and
               ord(c) > 127) for c in s)

for pr in pairs:
    t, o = pr['truth'], pr['ocr']
    sm = difflib.SequenceMatcher(None, t, o, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal': continue
        ts, os_ = t[i1:i2], o[j1:j2]
        ctx = t[max(0, i1 - 14):i2 + 14]
        n = max(len(ts), len(os_))
        if any(c in LIG for c in ts):
            k = 'ligature'
        elif any(c in QUOTES for c in ts) or any(c in QUOTES for c in os_):
            k = 'quote/dash'
        elif has_diacritic(ts) and not has_diacritic(os_):
            k = 'diacritic-dropped'
        elif ts.strip() == '' and os_.strip() == '':
            k = 'spacing'
        elif ts.replace(' ', '') == os_.replace(' ', ''):
            k = 'spacing'
        elif ts.lower() == os_.lower():
            k = 'case'
        elif len(ts) <= 2 and len(os_) <= 2 and frozenset(ts + os_) in CONFUSE:
            k = 'glyph-confusion'
        elif ts and not os_:
            k = 'deletion'
        elif os_ and not ts:
            k = 'insertion'
        else:
            k = 'substitution-other'
        tax[k] += n
        if len(examples[k]) < 400:
            examples[k].append({'truth': ts, 'ocr': os_, 'ctx': ctx,
                                'page': pr['page'], 'book': book})

# ── truth-quality gate: is this text layer actually the typesetter's? ────────
#
# "Born-digital" says nobody OCR'd this book. It does NOT say the font's
# ToUnicode CMap is right. A publisher PDF whose ligature or small-cap slots map
# to junk hands out truth like "Áagship" for "flagship" — and a repair model
# trained on that learns to INTRODUCE the error. The tell is a systematic
# one-to-one substitution: the same truth symbol read as the same letter(s) over
# and over, which no recognition failure produces at that regularity.
sub_table = Counter()
for pr in pairs:
    sm = difflib.SequenceMatcher(None, pr['truth'], pr['ocr'], autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'replace' and i2 - i1 == 1 and 1 <= j2 - j1 <= 3:
            sub_table[(pr['truth'][i1:i2], pr['ocr'][j1:j2])] += 1
cmap_suspects = []
for (ts, os_), n in sub_table.most_common():
    if n < 4: continue
    # Truth side is not a letter/digit, OCR side is plain ASCII letters, and the
    # mapping is consistent — a broken glyph slot, not a misread.
    if (not ts.isalnum()) and os_.isalpha() and os_.isascii():
        cmap_suspects.append({'truthGlyph': ts, 'ocrReads': os_, 'count': n})

nm = [b for b in stats_blocks if b['matched']]
tot_t = sum(b['nTruthChars'] for b in nm)
tot_d = sum(round(b['cer'] * b['nTruthChars']) for b in nm)
stats = {
    'book': book, 'pdf': pdf_path,
    'pages': [p['page'] for p in D['pages']],
    'geometry': geom[:3],
    'nBlocks': len(stats_blocks),
    'nMatched': len(nm),
    'alignmentRate': round(len(nm) / max(1, len(stats_blocks)), 4),
    'lostLineBoxes': lost_lines,
    'truthWords': sum(len(v) for v in truth_pages.values()),
    'unclaimedTruthWords': sum(len(v) for v in unclaimed.values()),
    'unclaimedRate': round(sum(len(v) for v in unclaimed.values()) /
                           max(1, sum(len(v) for v in truth_pages.values())), 4),
    'unclaimedSamples': [w['t'] for p in unclaimed for w in unclaimed[p][:8]][:40],
    'charCER': round(tot_d / max(1, tot_t), 5),
    'charCERFolded': round(sum(round(b['cerFold'] * b['nTruthChars']) for b in nm) /
                           max(1, tot_t), 5),
    'charCERFoldedCaseless': round(sum(round(b['cerCase'] * b['nTruthChars']) for b in nm) /
                                   max(1, tot_t), 5),
    'cmapSuspects': cmap_suspects,
    'medianBlockCER': round(float(np.median([b['cer'] for b in nm])), 5) if nm else None,
    'p90BlockCER': round(float(np.percentile([b['cer'] for b in nm], 90)), 5) if nm else None,
    'perfectBlocks': sum(1 for b in nm if b['cer'] == 0),
    'truthChars': tot_t,
    'unmatchedReasons': Counter(
        'empty-truth-line' if b['emptyLines'] else
        ('ratio-off' if not (0.6 <= b['ratio'] <= 1.6) else 'too-short')
        for b in stats_blocks if not b['matched']),
    'taxonomy': dict(tax.most_common()),
    'taxonomyExamples': {k: examples[k][:25] for k in tax},
    'byCategory': {},
}
bycat = defaultdict(lambda: [0, 0, 0])
for b in nm:
    c = bycat[b['cat']]
    c[0] += 1; c[1] += b['nTruthChars']; c[2] += round(b['cer'] * b['nTruthChars'])
stats['byCategory'] = {k: {'blocks': v[0], 'chars': v[1],
                           'cer': round(v[2] / max(1, v[1]), 5)} for k, v in bycat.items()}
stats['unmatchedReasons'] = dict(stats['unmatchedReasons'])

with open(pairs_out, 'w') as f:
    for pr in pairs:
        f.write(json.dumps(pr, ensure_ascii=False) + '\n')
json.dump(stats, open(stats_out, 'w'), ensure_ascii=False, indent=1)

print(f"{book}: {len(nm)}/{len(stats_blocks)} blocks aligned "
      f"({stats['alignmentRate']*100:.1f}%), CER {stats['charCER']*100:.3f}% "
      f"(folded {stats['charCERFolded']*100:.3f}%), "
      f"unclaimed truth words {stats['unclaimedRate']*100:.2f}%")
