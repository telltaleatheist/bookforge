#!/usr/bin/env python3
"""
eval-line — score the galley LINE corrector on its held-out books.

    python3 tools/galley/eval-line.py \
        [--sft ~/Documents/BookForge/training/galley/sft-line/eval.jsonl] \
        [--endpoint http://localhost:8771] [--limit 2000] [--json out.json] [--show 15]

Serve the model first, on the binary that will serve it in the app:

    <llama-build>/llama-server -m galley-line-v1-0.6b-f16.gguf --port 8771 -c 1024

────────────────────────────────────────────────────────────────────────────────
READ `degraded` FIRST. EVERY TIME.
────────────────────────────────────────────────────────────────────────────────

`degraded` is the count of lines whose CER went UP because the model touched
them — text that was right and now is not. It is the only number that can make
this model worse than no model at all, and averages hide it completely: a book
is 80–95% already-correct lines, so a corrector can cut pooled CER handsomely
while mangling several hundred proper nouns, and the pooled figure will look
like a win. `Reichsführer` becoming `Reichsfuhrer` costs almost nothing in
aggregate characters and everything in a finished audiobook.

The headline is therefore a PAIR and neither half means anything alone:

    CER before -> CER after     did it repair anything
    degraded / false-edit rate  what it cost

A model that answers with the input unchanged, always, scores a perfect
false-edit rate and repairs nothing. That is the baseline this prints alongside
the model's own numbers, so the comparison cannot be skipped.

THE DAGGER LESSON, WHICH THIS MODEL DOES NOT GET FOR FREE. dagger could only
emit deletions, and its applier still had to reject any anchor it could not find
verbatim — the model physically could not corrupt text. A line corrector emits
free text: it CAN invent a word, and nothing downstream stops it. `--guard`
measures what a subsequence-style guard would buy, by re-scoring with every
model output rejected whose edit distance from the input exceeds a budget. If
`degraded` is materially lower under the guard, the guard belongs in the
pipeline before this model ships.

`--json` writes the full per-row disposition so a regression can be diffed
rather than re-argued.
"""
import argparse
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict

# Mirrored from tools/galley/build-dataset.py and tools/galley-score.js — the
# same metric has to mean the same thing in the builder and the scorer.
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


def cer(hyp, ref):
    return lev(hyp, ref) / len(ref) if ref else (0.0 if not hyp else 1.0)


def qwen3_prompt(system, user):
    """Qwen3's template with thinking DISABLED, built by hand.

    The empty `<think>\\n\\n</think>` block is the point. Training used
    enable_thinking=False, which inserts it; a stock template ends at
    `<|im_start|>assistant\\n` and feeds the model a shape it never saw. rubric
    lost time to exactly this (see CLAUDE.md, "Rubric — the page-layout model"),
    which is why this is built explicitly here and the endpoint is /completion,
    never a chat endpoint that would build its own.
    """
    return (f'<|im_start|>system\n{system}<|im_end|>\n'
            f'<|im_start|>user\n{user}<|im_end|>\n'
            f'<|im_start|>assistant\n<think>\n\n</think>\n\n')


def complete(endpoint, prompt, n_predict, timeout):
    body = json.dumps({
        'prompt': prompt,
        'n_predict': n_predict,
        # Greedy. A corrector that samples is a corrector whose output you cannot
        # reproduce, and reproducibility is the whole point of a held-out score.
        'temperature': 0.0,
        'top_k': 1,
        'stop': ['<|im_end|>'],
        'cache_prompt': True,
    }).encode()
    req = urllib.request.Request(endpoint.rstrip('/') + '/completion', data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())['content']


def report(rs, label):
    n = len(rs)
    if not n:
        return None
    gold_chars = sum(len(x['gold']) for x in rs)
    d_before = sum(lev(x['src'], x['gold']) for x in rs)
    d_after = sum(lev(x['out'], x['gold']) for x in rs)
    improved = sum(1 for x in rs if x['cerAfter'] < x['cerBefore'] - 1e-12)
    degraded = sum(1 for x in rs if x['cerAfter'] > x['cerBefore'] + 1e-12)
    idents = [x for x in rs if x['identity']]
    return {
        'label': label, 'rows': n,
        'cerBefore': d_before / max(1, gold_chars),
        'cerAfter': d_after / max(1, gold_chars),
        'improved': improved, 'unchanged': n - improved - degraded, 'degraded': degraded,
        'identityRows': len(idents),
        'falseEdits': sum(1 for x in idents if x['touched']),
        'falseEditRate': sum(1 for x in idents if x['touched']) / max(1, len(idents)),
        'exactMatch': sum(1 for x in rs if x['exact']) / n,
        'touched': sum(1 for x in rs if x['touched']),
        'guarded': sum(1 for x in rs if x['guarded']),
    }


def run(rows, args):
    out_rows = []
    for i, r in enumerate(rows):
        msgs = {m['role']: m['content'] for m in r['messages']}
        src, gold = msgs['user'], msgs['assistant']
        prompt = qwen3_prompt(msgs['system'], src)
        try:
            raw = complete(args.endpoint, prompt, n_predict=len(src) + 64, timeout=args.timeout)
        except (urllib.error.URLError, OSError) as e:
            sys.exit(f'\neval-line: the server at {args.endpoint} did not answer ({e}).\n'
                     'Start llama-server on the GGUF first; there is no fallback backend on purpose.')
        out = raw.strip().split('\n')[0].strip()

        guarded = False
        if args.guard and out != src and lev(out, src) > args.guard * max(1, len(src)):
            out, guarded = src, True

        out_rows.append({
            'book': r.get('book'), 'page': r.get('page'), 'line': r.get('line'),
            'identity': bool(r.get('identity')),
            'src': src, 'gold': gold, 'out': out,
            'cerBefore': cer(src, gold), 'cerAfter': cer(out, gold),
            'touched': out != src, 'guarded': guarded,
            'exact': out == gold,
        })
        if (i + 1) % 200 == 0:
            print(f'  ... {i + 1}/{len(rows)}', flush=True)
    return out_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--sft', default='~/Documents/BookForge/training/galley/sft-line/eval.jsonl')
    ap.add_argument('--endpoint', default='http://localhost:8771')
    ap.add_argument('--limit', type=int, default=0, help='sample N rows, preserving the identity/edit mix')
    ap.add_argument('--seed', type=int, default=20260731)
    ap.add_argument('--show', type=int, default=15)
    ap.add_argument('--guard', type=float, default=0.0,
                    help='reject a model output whose edit distance from the input exceeds this '
                         'fraction of the input length, and score the input unchanged instead')
    ap.add_argument('--timeout', type=float, default=120)
    ap.add_argument('--german', default='~/Documents/BookForge/training/galley/sft-line/eval-german.jsonl',
                    help='the German diagnostic slice, scored and reported SEPARATELY; '
                         'pass "" to skip')
    ap.add_argument('--json', dest='json_out', default=None)
    args = ap.parse_args()

    path = os.path.expanduser(args.sft)
    if not os.path.isfile(path):
        sys.exit(f'eval-line: no such file: {path}')
    rows = [json.loads(l) for l in open(path) if l.strip()]
    if not rows:
        sys.exit('eval-line: eval file is empty')

    # Stratified subsample: the identity rate IS the baseline, so a sample that
    # changes it changes every number below it.
    if args.limit and args.limit < len(rows):
        rnd = random.Random(args.seed)
        ident = [r for r in rows if r.get('identity')]
        edit = [r for r in rows if not r.get('identity')]
        share = len(ident) / len(rows)
        k_i = round(args.limit * share)
        rows = rnd.sample(ident, min(k_i, len(ident))) + rnd.sample(edit, min(args.limit - k_i, len(edit)))
        rnd.shuffle(rows)

    print(f'eval-line — {len(rows)} rows from {path}')
    print(f'  endpoint {args.endpoint}')

    results = run(rows, args)
    # ── aggregate ───────────────────────────────────────────────────────────
    overall = report(results, 'ALL')
    print('\n' + '=' * 78)
    print('THE NUMBER THAT DECIDES: rows the model made WORSE')
    print('=' * 78)
    print(f'  degraded            {overall["degraded"]:6d}  ({overall["degraded"] / overall["rows"] * 100:.2f}% of rows)')
    print(f'  false edits on already-correct lines  {overall["falseEdits"]:6d} of {overall["identityRows"]}'
          f'  ({overall["falseEditRate"] * 100:.2f}%)')
    if args.guard:
        print(f'  outputs rejected by --guard {args.guard}  {overall["guarded"]}')

    print('\nDID IT REPAIR ANYTHING')
    print(f'  CER  {overall["cerBefore"] * 100:.3f}%  ->  {overall["cerAfter"] * 100:.3f}%'
          f'   ({(overall["cerBefore"] - overall["cerAfter"]) / max(1e-12, overall["cerBefore"]) * 100:+.1f}% relative)')
    print(f'  improved {overall["improved"]}   unchanged {overall["unchanged"]}   degraded {overall["degraded"]}')
    print(f'  exact match against gold  {overall["exactMatch"] * 100:.1f}%')
    print(f'\n  BASELINE, do nothing:  CER {overall["cerBefore"] * 100:.3f}%, 0 degraded, 0.00% false edits.')
    print('  A model only beats it by moving CER down without moving those two up.')

    print('\nPER BOOK')
    by = defaultdict(list)
    for x in results:
        by[x['book']].append(x)
    print(f'  {"book":34s}{"rows":>7s}{"CER before":>12s}{"CER after":>11s}{"impr":>7s}{"same":>7s}{"WORSE":>7s}{"falseEdit":>11s}')
    per_book = {}
    for b, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
        s = report(rs, b)
        per_book[b] = s
        print(f'  {str(b):34s}{s["rows"]:>7d}{s["cerBefore"] * 100:>11.3f}%{s["cerAfter"] * 100:>10.3f}%'
              f'{s["improved"]:>7d}{s["unchanged"]:>7d}{s["degraded"]:>7d}{s["falseEditRate"] * 100:>10.2f}%')

    worse = sorted([x for x in results if x['cerAfter'] > x['cerBefore']],
                   key=lambda x: x['cerBefore'] - x['cerAfter'])
    if worse:
        print(f'\nWORST DAMAGE ({min(args.show, len(worse))} of {len(worse)}) — read these, do not average them')
        for x in worse[:args.show]:
            print(f'  [{x["book"]} p{x["page"]}] cer {x["cerBefore"] * 100:.1f}% -> {x["cerAfter"] * 100:.1f}%'
                  f'{"  (was already correct)" if x["identity"] else ""}')
            print(f'    IN   {json.dumps(x["src"], ensure_ascii=False)}')
            print(f'    OUT  {json.dumps(x["out"], ensure_ascii=False)}')
            print(f'    GOLD {json.dumps(x["gold"], ensure_ascii=False)}')

    # ── the German diagnostic slice, reported apart from the headline ───────
    german_stats = None
    gpath = os.path.expanduser(args.german) if args.german else ''
    if gpath and os.path.isfile(gpath):
        grows = [json.loads(l) for l in open(gpath) if l.strip()]
        if args.limit and args.limit < len(grows):
            grows = random.Random(args.seed).sample(grows, args.limit)
        print(f'\n=== GERMAN DIAGNOSTIC SLICE — {len(grows)} rows, NOT part of the headline ===')
        print('  himmler-a-life, a contiguous German-dense page range held out of train.')
        print('  The headline eval is English throughout, so this is the only place the')
        print('  score can see a model "correcting" a German proper noun toward English.')
        gres = run(grows, args)
        g = report(gres, 'german')
        german_stats = g
        print(f'  degraded            {g["degraded"]:6d}  ({g["degraded"] / g["rows"] * 100:.2f}%)')
        print(f'  false edits         {g["falseEdits"]:6d} of {g["identityRows"]}'
              f'  ({g["falseEditRate"] * 100:.2f}%)')
        print(f'  CER  {g["cerBefore"] * 100:.3f}%  ->  {g["cerAfter"] * 100:.3f}%')
        print(f'  improved {g["improved"]}   unchanged {g["unchanged"]}   degraded {g["degraded"]}')
        gworse = sorted([x for x in gres if x['cerAfter'] > x['cerBefore']],
                        key=lambda x: x['cerBefore'] - x['cerAfter'])
        # Rows carrying non-ASCII are the ones this slice exists for.
        gworse = [x for x in gworse if any(ord(c) > 127 for c in x['gold'])] or gworse
        for x in gworse[:args.show]:
            print(f'  [p{x["page"]}] cer {x["cerBefore"] * 100:.1f}% -> {x["cerAfter"] * 100:.1f}%')
            print(f'    IN   {json.dumps(x["src"], ensure_ascii=False)}')
            print(f'    OUT  {json.dumps(x["out"], ensure_ascii=False)}')
            print(f'    GOLD {json.dumps(x["gold"], ensure_ascii=False)}')
    elif args.german:
        print(f'\n  (no German slice at {gpath} — skipped)')

    if args.json_out:
        out = os.path.expanduser(args.json_out)
        with open(out, 'w') as fh:
            json.dump({'sft': path, 'endpoint': args.endpoint, 'guard': args.guard,
                       'overall': overall, 'perBook': per_book, 'german': german_stats,
                       'rows': results}, fh, indent=1)
        print(f'\nwrote {out}')


if __name__ == '__main__':
    main()
