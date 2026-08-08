#!/usr/bin/env python3
"""
align-degraded — pair a scan of a DAMAGED raster against the source PDF's own
text, so induced OCR errors can be scored.

    python3 tools/foundry-ocr/align-degraded.py \
        --lines <run>/scan/lines.json --pdf <source.pdf> --first-page 1 --pages 8 \
        --out-lines line-units.jsonl --out-sentences sentence-units.jsonl [--cap 400]

────────────────────────────────────────────────────────────────────────────────
WHAT THIS IS FOR
────────────────────────────────────────────────────────────────────────────────

A real book has no gold, so a corrector pointed at one can only be REVIEWED
(review-edits.py), never scored. Induced damage gives it a gold: render the page,
damage the raster the way a scanner does (`degrade.py`), read it back with the
app's own OCR path (`foundry scan`), and the source PDF's text is what the
result should be corrected back to.

The truth NEVER passes through the degradation — only the OCR side is damaged.
Same labels, harder input. That is `degrade-batch.mjs`'s design and this file
follows it; what it does not follow is that file's geometry alignment, which
needs the app's own dump format. Here the two texts are aligned as CHARACTER
streams, which is sound precisely because they are 97-99% identical: the damage
is the small quantity.

────────────────────────────────────────────────────────────────────────────────
!! THE TRUTH IS ONLY AS GOOD AS THE TEXT LAYER, AND HERE IT IS NOT PERFECT !!
────────────────────────────────────────────────────────────────────────────────

`degrade-batch.mjs` was built for BORN-DIGITAL books, where the text layer is
the publisher's own file and is genuinely the truth. A PDF whose pages are
JBIG2 images with a text layer over them is a SCAN THAT WAS ALREADY OCRed, and
its text layer carries that OCR's mistakes.

Check before trusting a number out of this file: if the source's pages are
images and its fonts are substituted (`TimesNewRomanPSMT`, `WinAnsiEncoding`,
not embedded), the "truth" is an earlier OCR pass. It is still a usable
reference for RECALL — the errors the degradation induced are new, and the
reference's own errors appear identically on both sides and cancel — but a
model that CORRECTS a reference error scores as damage. Those show up in the
worst-damage list and have to be read, not averaged.

This file prints the source's page/font shape so that check cannot be skipped.

────────────────────────────────────────────────────────────────────────────────
UNITS
────────────────────────────────────────────────────────────────────────────────

Two files, from ONE alignment, so lines and sentences cover exactly the same
characters and the comparison is a comparison:

  line units      one scan line, its truth the span it aligned to.
  sentence units  `sentences.py`'s packing over the same lines — greedy to
                  --cap, cutting at the last sentence end that fits, never on a
                  wrap hyphen. Both sides join with the SAME rule, decided from
                  the OCR side, because that is the only side a pipeline sees.
"""
import argparse
import difflib
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('sentences', os.path.join(HERE, 'sentences.py'))
_S = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_S)


def lev(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[len(b)]


def build_map(a, b):
    """Character index in `a` -> the corresponding index in `b`.

    Equal runs map one to one; inside a changed run the position is interpolated
    proportionally. Only unit BOUNDARIES are ever looked up, and a boundary
    almost always falls inside an equal run, so the interpolation is a
    tie-breaker rather than the mechanism.
    """
    pos = [0] * (len(a) + 1)
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                pos[i1 + k] = j1 + k
        else:
            span_a = max(1, i2 - i1)
            for k in range(i2 - i1):
                pos[i1 + k] = j1 + round(k / span_a * (j2 - j1))
    pos[len(a)] = len(b)
    # Monotone, so a span can never come out inverted.
    for i in range(1, len(pos)):
        if pos[i] < pos[i - 1]:
            pos[i] = pos[i - 1]
    return pos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lines', required=True, help='<run>/scan/lines.json from `foundry scan`')
    ap.add_argument('--pdf', required=True, help='the UNTOUCHED source PDF the truth comes from')
    ap.add_argument('--first-page', type=int, default=0, help='0-based page of --pdf that scan page 1 is')
    ap.add_argument('--pages', type=int, required=True)
    ap.add_argument('--book', default='degraded')
    ap.add_argument('--out-lines', default=None)
    ap.add_argument('--out-sentences', default=None)
    ap.add_argument('--cap', type=int, default=400)
    args = ap.parse_args()

    import fitz
    doc = fitz.open(os.path.expanduser(args.pdf))

    print(f'align-degraded — source {args.pdf}')
    imaged = 0
    substituted = 0
    for i in range(args.first_page, args.first_page + args.pages):
        p = doc[i]
        if p.get_images(full=True):
            imaged += 1
        if any(f[3] not in ('n/a',) and f[1] == 'n/a' for f in p.get_fonts()):
            substituted += 1
    print(f'  pages {args.first_page}..{args.first_page + args.pages - 1}: '
          f'{imaged} carry a page image, {substituted} use substituted (non-embedded) fonts')
    if imaged == args.pages and substituted == args.pages:
        print('  !! THE SOURCE IS A SCAN WITH AN OCR TEXT LAYER. The "truth" below is an')
        print('     earlier OCR pass, not the publisher\'s file. Recall is still measurable;')
        print('     a model CORRECTING a reference error will score as damage. Read the')
        print('     worst-damage list, do not average it.')

    truth = re.sub(r'\s+', ' ', ' '.join(
        doc[i].get_text() for i in range(args.first_page, args.first_page + args.pages))).strip()

    lines = json.load(open(os.path.expanduser(args.lines), encoding='utf-8'))['lines']
    lines = [l for l in lines if l['text'].strip()]
    texts = [re.sub(r'\s+', ' ', l['text']).strip() for l in lines]

    # The OCR stream, with each line's span in it.
    spans = []
    ocr = ''
    for t in texts:
        if ocr:
            ocr += ' '
        spans.append((len(ocr), len(ocr) + len(t)))
        ocr += t

    pos = build_map(ocr, truth)
    d = lev(ocr, truth)
    print(f'  scan {len(lines)} lines / {len(ocr)} chars   truth {len(truth)} chars')
    print(f'  whole-stream CER against the reference: {d / max(1, len(truth)) * 100:.3f}%')

    line_units = []
    for l, t, (s, e) in zip(lines, texts, spans):
        gold = truth[pos[s]:pos[e]].strip()
        line_units.append({
            'system': _S.OCR_SYSTEM_PROMPT, 'src': t, 'gold': gold,
            'book': args.book, 'page': l['page'], 'line': len(line_units),
            'lines': 1, 'identity': t == gold,
        })

    # Sentence units over the SAME lines, both sides joined by the same rule.
    sent_units = []
    for a, b in _S.pack(texts, args.cap):
        src = _S.join_all(texts[a:b])
        gold = _S.join_all([truth[pos[spans[i][0]]:pos[spans[i][1]]].strip() for i in range(a, b)])
        sent_units.append({
            'system': _S.OCR_SYSTEM_PROMPT, 'src': src, 'gold': gold,
            'book': args.book, 'page': lines[a]['page'], 'line': a,
            'lines': b - a, 'identity': src == gold,
        })

    for name, units, path in (('line', line_units, args.out_lines),
                              ('sentence', sent_units, args.out_sentences)):
        gc = sum(len(u['gold']) for u in units)
        dd = sum(lev(u['src'], u['gold']) for u in units)
        ident = sum(1 for u in units if u['identity'])
        print(f'  {name:9s} units {len(units):5d}   CER {dd / max(1, gc) * 100:6.3f}%   '
              f'already-correct {ident:5d} ({ident / max(1, len(units)) * 100:.1f}%)   '
              f'mean chars {gc / max(1, len(units)):.0f}')
        if path:
            with open(os.path.expanduser(path), 'w', encoding='utf-8') as fh:
                for u in units:
                    fh.write(json.dumps(u, ensure_ascii=False) + '\n')
            print(f'    wrote {path}')


if __name__ == '__main__':
    main()
