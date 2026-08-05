#!/usr/bin/env python3
"""
sentences — re-join the line corpus into SENTENCE units, for the unit-size experiment.

    python3 tools/foundry-ocr/sentences.py \
        --sft <eval.jsonl> --out <sentences.jsonl> [--cap 400]
    python3 tools/foundry-ocr/sentences.py --self-test

────────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS
────────────────────────────────────────────────────────────────────────────────

The line model was trained and measured on ONE Tesseract `--psm 7` band: about
61 characters, a fragment with no left or right context. The open question is
whether the SAME weights do better on a sentence — a unit that carries enough
context for "who J still" to be obviously "who I still" — without retraining.
This file builds the sentence side of that comparison, and `eval-guard.py`
scores both.

The prompt is NOT touched. It says "a single line of text" and it stays saying
that (src/ocr/prompt.ts: a near-miss prompt is worse than an error). Feeding a
sentence to a line prompt is the experiment, not a bug to be tidied away.

────────────────────────────────────────────────────────────────────────────────
A UNIT IS A SET OF WHOLE LINES. THAT IS THE WHOLE TRICK.
────────────────────────────────────────────────────────────────────────────────

A sentence boundary falls mid-line, and cutting there would need a character
alignment between the OCR and the truth — the exact fragile machinery this is
supposed to be measuring an escape from. So a unit is a run of CONSECUTIVE
lines, and the truth for that unit is the same lines' truth, joined the same
way. Two consequences, both load-bearing:

  * The OCR unit and the truth unit are built from the SAME line set, so they
    correspond exactly, and CER means what it means at line level.
  * Where the unit boundaries land cannot bias the measurement. A sentence-end
    detector that misfires makes a slightly differently-shaped unit; it never
    makes the truth wrong. So the detector below is deliberately simple and its
    imperfection is not a caveat on any number.

Lines are the atoms the pipeline actually has (bands -> per-line tesseract ->
[ocr] -> grouping), so this is also the only re-unitisation the pipeline could
perform for real.

────────────────────────────────────────────────────────────────────────────────
THE WRAP HYPHEN
────────────────────────────────────────────────────────────────────────────────

8.68% of the eval's lines end in a hyphen, and the corpus builder already
repaired the truth so that the truth line ends in that hyphen too
(build-dataset.py `repair_hyphen`) — 1,884 of 1,886 hyphen rows agree on both
sides. Two rules follow, and neither of them invents a letter:

  1. A TRAILING HYPHEN IS A JOIN, NEVER A COMPLETION (src/ocr/edits.ts header).
     So the join closes the gap — no space — and the hyphen STAYS. Dropping it
     is `src/export/linejoin.ts`'s job and it only does so on the book's own
     attested vocabulary; this file has no vocabulary and therefore no right to
     an opinion. Keeping the hyphen is the recoverable direction.

  2. A UNIT NEVER ENDS ON A WRAP HYPHEN. Closing a unit after `inter-` hands the
     model exactly the half-word fragment this experiment exists to escape, so a
     hyphenated line is not a legal cut point and the unit keeps growing.

Each side decides its own separator from its own trailing character. In the two
rows where the hyphen IS the OCR error, the OCR side welds and the truth side
does not — which is correct: the truth is prose, and the extra character is
charged to the scan, where it belongs.

────────────────────────────────────────────────────────────────────────────────
PACKING
────────────────────────────────────────────────────────────────────────────────

Greedy to `--cap` (400) characters, cutting at the LAST sentence end that fits.
When no sentence ended inside the cap — one long sentence — the cut falls at a
line boundary instead, which is a WORD boundary by construction (see the hyphen
rule: the only way a line can end mid-word is a wrap hyphen, and those are not
cut points). Nothing here ever cuts at a fixed offset.

A run of consecutive lines ends where the corpus's `line` numbering breaks: the
eval is a holdout, not a whole book, and lines the builder dropped leave gaps
that are NOT adjacent text. `book` + `line` is reading order; a gap is a wall.
"""
import argparse
import json
import os
import re
import sys
from collections import defaultdict

# A line-final hyphen: ASCII, the two Unicode non-breaking forms, and soft hyphen.
WRAP_HYPHEN = re.compile(r'[-‐‑­]$')

# Sentence end at a LINE end: terminal punctuation, optionally behind closing
# quotes or brackets. See the header — this only shapes units, it cannot make a
# truth wrong, so it is allowed to be this simple.
SENTENCE_END = re.compile(r'[.!?…][\'"’”»)\]]*$')

# The abbreviations that end a line often enough to matter, plus a lone initial
# ("J. R. R." wrapping after "J."). A missed one costs a slightly longer unit.
ABBREVIATIONS = {
    'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'rev', 'hon', 'sr', 'jr',
    'vs', 'etc', 'ca', 'cf', 'ed', 'eds', 'vol', 'no', 'pp', 'op', 'cit',
    'ibid', 'al', 'inc', 'ltd', 'co', 'jan', 'feb', 'mar', 'apr', 'jun',
    'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
}


def ends_sentence(text: str) -> bool:
    s = text.rstrip()
    if not SENTENCE_END.search(s):
        return False
    word = re.search(r'([A-Za-zÀ-ɏ]+)\.$', s)
    if word:
        w = word.group(1)
        if w.lower() in ABBREVIATIONS:
            return False
        if len(w) == 1 and w.isupper():        # a lone initial
            return False
    return True


def ends_wrap_hyphen(text: str) -> bool:
    return bool(WRAP_HYPHEN.search(text.rstrip()))


def join(previous: str, nxt: str) -> str:
    """Two lines into one string, deciding the separator from the LEFT line.

    A wrap hyphen closes the gap and stays (see the header); anything else gets
    the single space that a line break stands for.
    """
    left = previous.rstrip()
    right = nxt.lstrip()
    if not left:
        return right
    if not right:
        return left
    return left + right if ends_wrap_hyphen(left) else left + ' ' + right


def join_all(lines) -> str:
    out = ''
    for text in lines:
        out = join(out, text) if out else text.strip()
    return out


def pack(lines, cap: int):
    """A run of consecutive lines -> a list of line-index slices.

    `lines` is a list of OCR strings. Cut points are decided on the OCR side,
    because that is the only side the pipeline can see at inference time.
    """
    units = []
    start = 0
    i = 0
    # The last index (exclusive) that would be a legal cut, and whether it was a
    # sentence end — recomputed as the unit grows.
    while i < len(lines):
        best_sentence = None
        best_any = None
        length = 0
        j = i
        while j < len(lines):
            length = len(join_all(lines[i:j + 1]))
            closable = not ends_wrap_hyphen(lines[j])
            if closable and length <= cap:
                best_any = j + 1
                if ends_sentence(lines[j]):
                    best_sentence = j + 1
            if length > cap:
                break
            j += 1
        cut = best_sentence or best_any
        if cut is None:
            # Nothing inside the cap was closable: either one line is longer
            # than the cap on its own, or a hyphen chain runs past it. Grow to
            # the first legal cut and let the unit exceed the cap rather than
            # cut mid-word.
            k = i
            while k < len(lines) and ends_wrap_hyphen(lines[k]):
                k += 1
            cut = min(k + 1, len(lines))
        units.append((start + i, start + cut))
        i = cut
    return units


def build(rows, cap: int):
    """The corpus's line rows -> sentence-unit rows, in reading order."""
    by_book = defaultdict(list)
    for r in rows:
        m = {x['role']: x['content'] for x in r['messages']}
        by_book[r['book']].append({
            'book': r['book'], 'page': r['page'], 'line': r['line'],
            'src': m['user'], 'gold': m['assistant'],
            'identity': bool(r.get('identity')), 'system': m['system'],
        })

    units = []
    for book in sorted(by_book):
        rs = sorted(by_book[book], key=lambda x: x['line'])
        # Split into runs of strictly consecutive line numbers.
        runs = []
        cur = [rs[0]]
        for prev, nxt in zip(rs, rs[1:]):
            if nxt['line'] == prev['line'] + 1:
                cur.append(nxt)
            else:
                runs.append(cur)
                cur = [nxt]
        runs.append(cur)

        for run in runs:
            for a, b in pack([x['src'] for x in run], cap):
                part = run[a:b]
                src = join_all([x['src'] for x in part])
                gold = join_all([x['gold'] for x in part])
                units.append({
                    'system': part[0]['system'],
                    'src': src,
                    'gold': gold,
                    'book': book,
                    'page': part[0]['page'],
                    'line': part[0]['line'],
                    'lines': len(part),
                    'lineRange': [part[0]['line'], part[-1]['line']],
                    # A unit is already correct only when EVERY line in it was.
                    # A weaker definition would let a damaged line hide inside a
                    # clean unit and stop false edits from being counted.
                    'identity': all(x['identity'] for x in part),
                })
    return units


# ── self-test ───────────────────────────────────────────────────────────────
def self_test():
    fails = []

    def check(name, got, want):
        if got != want:
            fails.append(f'{name}\n    got  {got!r}\n    want {want!r}')

    check('plain join', join('the cat', 'sat down'), 'the cat sat down')
    check('wrap hyphen welds and KEEPS the hyphen',
          join('inter-', 'national law'), 'inter-national law')
    check('unicode hyphen welds', join('inter‐', 'national'), 'inter‐national')
    check('sentence end', ends_sentence('He went home.'), True)
    check('abbreviation is not a sentence end', ends_sentence('spoke to Mr.'), False)
    check('lone initial is not a sentence end', ends_sentence('written by J.'), False)
    check('quote after the stop is still a sentence end', ends_sentence('"Go away."'), True)
    check('no terminal punctuation', ends_sentence('and then he'), False)

    # Packing: cuts at the last sentence end that fits.
    # Two sentences fit in 30 chars, three do not: [0,1] then [2,3].
    lines = ['One two three.', 'Four five six.', 'Seven eight nine.', 'Ten.']
    check('packs to the cap at a sentence end', pack(lines, 30), [(0, 2), (2, 4)])
    check('a tighter cap packs one sentence per unit', pack(lines, 20),
          [(0, 1), (1, 2), (2, 3), (3, 4)])

    # A unit never ends on a wrap hyphen even when the cap says it should.
    hy = ['aaaa bbbb cc-', 'dddd eeee.', 'ffff.']
    got = pack(hy, 14)
    if any(ends_wrap_hyphen(hy[b - 1]) for _, b in got):
        fails.append(f'a unit ended on a wrap hyphen: {got}')

    # One sentence longer than the cap falls back to a line boundary.
    long_ = ['aaaa bbbb cccc', 'dddd eeee ffff', 'gggg hhhh.']
    got = pack(long_, 16)
    check('over-cap sentence cuts at a line boundary', got, [(0, 1), (1, 2), (2, 3)])

    # Every unit's text is exactly its lines joined — no character invented or lost.
    rows = [{'messages': [{'role': 'system', 'content': 'S'},
                          {'role': 'user', 'content': t},
                          {'role': 'assistant', 'content': t}],
             'book': 'b', 'page': 1, 'line': i, 'identity': True}
            for i, t in enumerate(['Alpha beta gam-', 'ma delta.', 'Epsilon zeta.'])]
    units = build(rows, cap=400)
    check('hyphen healed across the join', [u['src'] for u in units],
          ['Alpha beta gam-ma delta. Epsilon zeta.'])

    # A gap in the line numbering is a wall.
    rows2 = [{'messages': [{'role': 'system', 'content': 'S'},
                           {'role': 'user', 'content': t},
                           {'role': 'assistant', 'content': t}],
              'book': 'b', 'page': 1, 'line': i, 'identity': True}
             for i, t in [(1, 'One.'), (2, 'Two.'), (9, 'Nine.')]]
    check('a numbering gap starts a new unit',
          [u['src'] for u in build(rows2, cap=400)], ['One. Two.', 'Nine.'])

    if fails:
        print('sentences: SELF-TEST FAILED')
        for f in fails:
            print('  ' + f)
        sys.exit(1)
    print('sentences: self-test passed')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sft', help='the line corpus JSONL (chat rows with book/page/line)')
    ap.add_argument('--out', help='where to write the sentence units')
    ap.add_argument('--cap', type=int, default=400)
    ap.add_argument('--self-test', action='store_true')
    args = ap.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.sft or not args.out:
        sys.exit('sentences: --sft and --out are required (or pass --self-test)')

    path = os.path.expanduser(args.sft)
    if not os.path.isfile(path):
        sys.exit(f'sentences: no such file: {path}')
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    if not rows:
        sys.exit('sentences: the corpus is empty')

    units = build(rows, args.cap)

    src_chars = sum(len(u['src']) for u in units)
    line_chars = sum(len({x['role']: x['content'] for x in r['messages']}['user']) for r in rows)
    with open(os.path.expanduser(args.out), 'w', encoding='utf-8') as fh:
        for u in units:
            fh.write(json.dumps(u, ensure_ascii=False) + '\n')

    print(f'sentences — {len(rows)} lines -> {len(units)} units (cap {args.cap})')
    print(f'  lines per unit   mean {len(rows) / len(units):.2f}   max {max(u["lines"] for u in units)}')
    print(f'  chars per unit   mean {src_chars / len(units):.1f}   max {max(len(u["src"]) for u in units)}')
    print(f'  over the cap     {sum(1 for u in units if len(u["src"]) > args.cap)}')
    print(f'  already-correct  {sum(1 for u in units if u["identity"])} '
          f'({sum(1 for u in units if u["identity"]) / len(units) * 100:.1f}%)')
    print(f'  characters: {line_chars} in lines -> {src_chars} in units '
          f'(+{src_chars - line_chars} join separators)')
    print(f'wrote {args.out}')


if __name__ == '__main__':
    main()
