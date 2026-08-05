#!/usr/bin/env python3
"""
review-edits — every correction the model proposed on a real book, and what each
guard policy did with it.

    python3 tools/foundry-ocr/review-edits.py --dump <book.dump.jsonl> \
        [--watch Führer,Reichsführer,Sonderweg,Lammers,Broszat] \
        [--context 55] [--out review.txt]

────────────────────────────────────────────────────────────────────────────────
WHY A LIST AND NOT A SCORE
────────────────────────────────────────────────────────────────────────────────

`eval-guard.py` needs a gold to score against. A real book has none — that is
the whole reason a corrector is being pointed at it. So on a book the honest
output is not a number, it is a LIST: every word the model wanted to change,
with enough text around it to judge, and the guard's verdict beside it.

That is also the only form in which the failure that matters is visible.
`Reichsführer` becoming `Reichsfuhrer` costs almost nothing in average
characters and everything in a finished audiobook, and no aggregate will ever
show it. A reader can see it in one line.

ON A CLEAN BOOK, EVERY EDIT IS A FALSE EDIT UNTIL PROVEN OTHERWISE. The text
already in the EPUB is the text that would otherwise ship. So the counts below
are a false-edit inventory by default, and the reader's job is to find the ones
that are real repairs — not the other way round.

────────────────────────────────────────────────────────────────────────────────
THE THREE DISPOSITIONS
────────────────────────────────────────────────────────────────────────────────

Each proposed change is a RUN — a contiguous region where the model's answer
disagrees with the book. The rule (foundry `src/ocr/guard.ts`) accepts a run
only when it replaces N words with N words, each pair within Levenshtein 2.

    no-guard    every run ships.
    whole-unit  SHIPPED: if any run in the unit is illegal, the unit's whole
                answer is discarded — legal runs included.
    per-run     only the illegal runs are reverted.

The number this file exists to produce is the last one in the summary: how many
LEGAL runs `whole-unit` throws away because something else in the same unit was
illegal. That is exactly what switching to `per-run` would buy, and it is a
count of real corrections, not a rate.

`--watch` names the terms whose damage would be invisible in any average —
proper nouns, foreign titles. Every proposed edit touching one is repeated in
its own section, whatever the guard decided, so it cannot be missed.
"""
import argparse
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('eval_guard', os.path.join(HERE, 'eval-guard.py'))
_eg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_eg)
guard_resolve, POLICIES = _eg.guard_resolve, _eg.POLICIES


def window(text, needle, radius):
    """`needle` inside `text`, with `radius` characters either side, or None."""
    if not needle:
        return None
    at = text.find(needle)
    if at < 0:
        return None
    lo, hi = max(0, at - radius), min(len(text), at + len(needle) + radius)
    return (('…' if lo else '') + text[lo:at] + '⟦' + needle + '⟧' + text[at + len(needle):hi]
            + ('…' if hi < len(text) else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', required=True)
    ap.add_argument('--context', type=int, default=55)
    ap.add_argument('--watch', default='')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    meta, rows = _eg.read_dump(os.path.expanduser(args.dump))
    watch = [w for w in args.watch.split(',') if w.strip()]

    out = open(os.path.expanduser(args.out), 'w', encoding='utf-8') if args.out else sys.stdout

    def w(line=''):
        print(line, file=out)

    w('=' * 100)
    w(f'review-edits — {len(rows)} units from {meta["units"]}')
    w('=' * 100)
    w(f'generated {meta["generatedAt"]} in {meta["seconds"]}s on {meta["endpoint"]}')
    if meta.get('serverArgs'):
        w(f'server: {meta["serverArgs"]}')
    w(f'sampling: {json.dumps(meta["sampling"])}')
    has_gold = any(r.get('gold') is not None for r in rows)
    w(f'gold available: {has_gold}'
      + ('' if has_gold else '   -> every proposed edit below is a FALSE EDIT until a reader says otherwise'))
    w()

    resolved = {p: [guard_resolve(r['src'], r['out'], p) for r in rows] for p in POLICIES}

    # ── summary ─────────────────────────────────────────────────────────────
    touched = sum(1 for r in rows if r['out'] != r['src'])
    runs_all = [(i, k, run) for i, g in enumerate(resolved['per-run'])
                for k, run in enumerate(g['runs'])]
    legal = [x for x in runs_all if x[2]['ok']]
    illegal = [x for x in runs_all if not x[2]['ok']]
    units_with_illegal = {i for i, _, run in runs_all if not run['ok']}
    # The count that decides the guard question: legal runs sitting in a unit
    # that whole-unit discards whole.
    stranded = [x for x in legal if x[0] in units_with_illegal]

    w('SUMMARY')
    w(f'  units                                        {len(rows)}')
    w(f'  units the model changed at all               {touched}  ({touched / len(rows) * 100:.1f}%)')
    w(f'  units the model returned unchanged           {len(rows) - touched}')
    w(f'  proposed runs (contiguous changed regions)   {len(runs_all)}')
    w(f'    legal under the rule                       {len(legal)}')
    w(f'    illegal under the rule                     {len(illegal)}')
    w(f'  units containing at least one illegal run    {len(units_with_illegal)}')
    w()
    w('  WHAT EACH POLICY SHIPS')
    applied = {
        'no-guard': len(runs_all),
        # whole-unit ships a run only if EVERY run in its unit was legal.
        'whole-unit': sum(1 for i, _, run in runs_all if i not in units_with_illegal),
        'per-run': len(legal),
    }
    for p in POLICIES:
        changed = sum(1 for r, g in zip(rows, resolved[p]) if g['text'] != r['src'])
        w(f'    {p:12s} units changed {changed:5d}   runs applied {applied[p]:5d}')
    w()
    w(f'  >>> LEGAL RUNS whole-unit DISCARDS because something else in the same unit')
    w(f'      was illegal — exactly what per-run would recover:   {len(stranded)}')
    w()

    # ── the list ────────────────────────────────────────────────────────────
    w('=' * 100)
    w('EVERY PROPOSED EDIT')
    w('=' * 100)
    w('  ⟦…⟧ marks the text the model wanted to change. `ship` is what each policy did.')
    w()
    n = 0
    for i, r in enumerate(rows):
        g = resolved['per-run'][i]
        if not g['runs']:
            continue
        unit_rejected_whole = i in units_with_illegal
        for run in g['runs']:
            n += 1
            before = ' '.join(run['del'])
            after = ' '.join(run['ins'])
            ctx = window(r['src'], before, args.context) or r['src']
            w(f'[{n:4d}] unit {i} ({r.get("book", "?")} block {r.get("page")}/{r.get("line")})')
            w(f'       {before!r}  ->  {after!r}')
            w(f'       {ctx}')
            if run['ok']:
                w(f'       ship: no-guard YES | whole-unit '
                  f'{"NO (a sibling run was illegal)" if unit_rejected_whole else "YES"} | per-run YES')
            else:
                w(f'       ship: no-guard YES | whole-unit NO | per-run NO')
                w(f'       refused: {run["why"]}')
            if r.get('gold') is not None:
                w(f'       gold: {json.dumps(r["gold"], ensure_ascii=False)}')
            w()

    # ── the watchlist ───────────────────────────────────────────────────────
    if watch:
        w('=' * 100)
        w(f'WATCHLIST — proposed edits touching: {", ".join(watch)}')
        w('  Damage here is invisible in any average and audible in a finished audiobook.')
        w('=' * 100)
        hits = 0
        for i, r in enumerate(rows):
            for run in resolved['per-run'][i]['runs']:
                joined = ' '.join(run['del']) + ' ' + ' '.join(run['ins'])
                if not any(t in joined for t in watch):
                    continue
                hits += 1
                w(f'  {" ".join(run["del"])!r} -> {" ".join(run["ins"])!r}'
                  f'   [{"legal" if run["ok"] else "ILLEGAL: " + run["why"]}]')
                w(f'    {window(r["src"], " ".join(run["del"]), args.context) or r["src"]}')
        if not hits:
            w('  none — the model proposed no edit touching any watched term.')
        w()
        w('  PRESENCE OF EACH WATCHED TERM IN THE BOOK, and whether it survived:')
        for t in watch:
            in_src = sum(r['src'].count(t) for r in rows)
            for p in POLICIES:
                after = sum(g['text'].count(t) for g in resolved[p])
                w(f'    {t:16s} in book {in_src:4d}   after {p:12s} {after:4d}'
                  + ('   <-- LOST' if after < in_src else ''))

    if args.out:
        out.close()
        print(f'wrote {args.out}  ({n} proposed edits over {len(rows)} units)')


if __name__ == '__main__':
    main()
