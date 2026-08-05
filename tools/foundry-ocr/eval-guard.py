#!/usr/bin/env python3
"""
eval-guard — GENERATE ONCE, SCORE MANY: what does each guard policy buy?

    # 1. generate, once, and keep the raw answers
    python3 tools/foundry-ocr/eval-guard.py generate \
        --units <eval.jsonl|sentences.jsonl> --dump lines.dump.jsonl \
        [--endpoint http://localhost:8771] [--adapter-id 0] [--concurrency 16]

    # 2. score that dump under every policy, as often as you like
    python3 tools/foundry-ocr/eval-guard.py score --dump lines.dump.jsonl [--show 8]

Serve the model the way the app serves it — base + adapter, not a fused file:

    llama-server -m foundry-4b-f16.gguf -c 32768 -np 16 -ngl 99 --no-webui \\
        --lora-scaled <relative-path-to>/foundry-ocr-v1-4b.gguf:0.0

and every request states the full scale vector, exactly as
`src/serve/llama-server.ts` does. `generate` records the server's own
`/props` alongside the arguments it was given, in the dump.

────────────────────────────────────────────────────────────────────────────────
READ `degraded` FIRST. EVERY TIME. — eval-line.py's doctrine, unchanged.
────────────────────────────────────────────────────────────────────────────────

`degraded` is the count of units whose CER went UP because the model touched
them. It is the only number that can make this model worse than no model at
all, and averages hide it: a book is 80-95% already-correct text, so a
corrector can cut pooled CER handsomely while mangling several hundred proper
nouns. The headline is a PAIR and neither half means anything alone:

    CER before -> CER after     did it repair anything
    degraded / false-edit rate  what it cost

The do-nothing baseline is printed alongside every table, because a model that
answers with its input unchanged scores a perfect false-edit rate and repairs
nothing.

────────────────────────────────────────────────────────────────────────────────
GENERATE ONCE, SCORE MANY
────────────────────────────────────────────────────────────────────────────────

Generation is the expensive half and the noisy half. Re-running it to try a
different guard costs GPU time AND lets sampling noise wear the costume of a
policy difference — two runs of the same policy would differ too, and nothing
in the output would say so. So `generate` writes every raw answer to a dump and
`score` never talks to a server. Decoding is greedy (temperature 0, top_k 1),
so the dump is reproducible rather than merely recorded.

Every policy is scored on the SAME dump, which is what makes the comparison a
comparison.

────────────────────────────────────────────────────────────────────────────────
THE THREE POLICIES
────────────────────────────────────────────────────────────────────────────────

  no-guard    ship whatever the model said. The control that shows what the
              guard is protecting against, not a candidate.
  whole-unit  the SHIPPED configuration. One illegal run discards the model's
              whole answer for the unit.
  per-run     keep the legal runs, revert only the illegal ones.

`whole-unit` and `per-run` enforce the IDENTICAL rule — a changed run is legal
only if it replaces N words with N words, each pair within Levenshtein 2. They
differ only in the blast radius of one violation. The Python below is a PORT of
foundry `src/ocr/guard.ts`; `guard-crosscheck.mjs` runs a dump through both
implementations and fails on any disagreement, because a scorer that guards
differently from the shipped stage measures nothing.

────────────────────────────────────────────────────────────────────────────────
COMPARING TWO UNIT SIZES
────────────────────────────────────────────────────────────────────────────────

`degraded` counts UNITS, so it is not comparable between a line dump and a
sentence dump: the same damage spread over 4.4x fewer, 4.4x longer units
produces a smaller count for free. Two rates are printed beside it that ARE
comparable, both denominated in the text itself rather than in units:

    degraded chars / 100k   sum of max(0, distAfter - distBefore)
    repaired chars / 100k   sum of max(0, distBefore - distAfter)

`degraded` remains the headline within one unit size. Across unit sizes, read
the per-100k pair.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict

# ─────────────────────────────────────────────────────────────────────────────
# metric — mirrored from eval-line.py, build-dataset.py and score.js. The same
# metric has to mean the same thing everywhere or the numbers cannot be diffed.
# ─────────────────────────────────────────────────────────────────────────────
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


# ─────────────────────────────────────────────────────────────────────────────
# the guard — a PORT of foundry src/ocr/guard.ts. Keep them identical.
# ─────────────────────────────────────────────────────────────────────────────
GUARD_MAX_WORD_DISTANCE = 2
POLICIES = ('no-guard', 'whole-unit', 'per-run')


def _equal_pairs(a, b):
    """LCS word alignment — guard.ts `equalPairs`, including its tie-break."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, nxt = dp[i], dp[i + 1]
        for j in range(m - 1, -1, -1):
            row[j] = nxt[j + 1] + 1 if a[i] == b[j] else max(nxt[j], row[j + 1])
    pairs = []
    i = j = 0
    while i < n and j < m:
        if a[i] == b[j]:
            pairs.append((i, j))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def _tokenize(s):
    """Words plus the whitespace that preceded each — guard.ts `tokenize`."""
    tokens = []
    lead = ''
    at = 0
    for k, m in enumerate(re.finditer(r'\S+', s)):
        gap = s[at:m.start()]
        if k == 0:
            lead = gap
            tokens.append({'word': m.group(0), 'sep': ''})
        else:
            tokens.append({'word': m.group(0), 'sep': gap})
        at = m.end()
    return lead, tokens, s[at:]


def _judge(delw, insw, max_dist):
    if len(delw) != len(insw):
        return False, (f'unbalanced change: [{" ".join(delw)}] -> [{" ".join(insw)}] '
                       f'({len(delw)} word{"" if len(delw) == 1 else "s"} -> {len(insw)})')
    for d, i in zip(delw, insw):
        dist = lev(d, i)
        if dist > max_dist:
            return False, f'word changed beyond distance {max_dist}: "{d}" -> "{i}" (distance {dist})'
    return True, None


def guard_resolve(src, out, policy, max_dist=GUARD_MAX_WORD_DISTANCE):
    """-> {'text', 'ok', 'why', 'runs', 'acceptedRuns', 'rejectedRuns'}"""
    if policy == 'no-guard':
        return {'text': out, 'ok': True, 'why': None, 'runs': [], 'acceptedRuns': 0, 'rejectedRuns': 0}
    if src == out:
        return {'text': out, 'ok': True, 'why': None, 'runs': [], 'acceptedRuns': 0, 'rejectedRuns': 0}

    lead_a, ta, trail_a = _tokenize(src)
    lead_b, tb, trail_b = _tokenize(out)
    a = [t['word'] for t in ta]
    b = [t['word'] for t in tb]

    segments = []
    ai = bi = 0
    for pi, pj in list(_equal_pairs(a, b)) + [(len(a), len(b))]:
        if pi > ai or pj > bi:
            segments.append(('run', ai, pi, bi, pj))
        if pi < len(a) and pj < len(b):
            segments.append(('equal', pi, pj))
        ai, bi = pi + 1, pj + 1

    runs = []
    verdicts = {}
    for k, seg in enumerate(segments):
        if seg[0] != 'run':
            continue
        _, a1, a2, b1, b2 = seg
        ok, why = _judge(a[a1:a2], b[b1:b2], max_dist)
        run = {'del': a[a1:a2], 'ins': b[b1:b2], 'ok': ok, 'why': why}
        runs.append(run)
        verdicts[k] = run

    bad = [r for r in runs if not r['ok']]
    base = {'ok': not bad, 'why': bad[0]['why'] if bad else None, 'runs': runs,
            'acceptedRuns': len(runs) - len(bad), 'rejectedRuns': len(bad)}
    if not bad:
        return {**base, 'text': out}
    if policy == 'whole-unit':
        return {**base, 'text': src}

    kept = []
    for k, seg in enumerate(segments):
        if seg[0] == 'equal':
            kept.append(tb[seg[2]])
            continue
        _, a1, a2, b1, b2 = seg
        kept.extend(tb[b1:b2] if verdicts[k]['ok'] else ta[a1:a2])

    if len(kept) == len(a) and all(t['word'] == w for t, w in zip(kept, a)):
        return {**base, 'text': src}
    text = lead_b + ''.join(('' if i == 0 else t['sep']) + t['word'] for i, t in enumerate(kept)) + trail_b
    return {**base, 'text': text}


# ─────────────────────────────────────────────────────────────────────────────
# generation
# ─────────────────────────────────────────────────────────────────────────────
def qwen3_prompt(system, user):
    """Qwen3's template with thinking DISABLED, built by hand — identical to
    eval-line.py `qwen3_prompt` and foundry `toOcrRawPrompt`. The empty
    `<think>\\n\\n</think>` block is the point: training ran with
    enable_thinking=False, and a stock template ends at `assistant\\n` and feeds
    the model a shape it never saw."""
    return (f'<|im_start|>system\n{system}<|im_end|>\n'
            f'<|im_start|>user\n{user}<|im_end|>\n'
            f'<|im_start|>assistant\n<think>\n\n</think>\n\n')


def complete(endpoint, prompt, n_predict, timeout, adapter_id):
    body = {
        'prompt': prompt,
        'n_predict': n_predict,
        # Greedy. A corrector that samples is a corrector whose output you cannot
        # reproduce, and reproducibility is what makes "score many" honest.
        'temperature': 0.0,
        'top_k': 1,
        'stop': ['<|im_end|>'],
        'cache_prompt': True,
    }
    if adapter_id is not None:
        # The FULL scale vector on every request, like src/serve/llama-server.ts:
        # llama-server carries the last vector forward, so a partial one makes
        # the applied adapter depend on request order.
        body['lora'] = [{'id': adapter_id, 'scale': 1.0}]
    req = urllib.request.Request(endpoint.rstrip('/') + '/completion',
                                 data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())['content']


def read_units(path):
    """Both corpus shapes: the line corpus's chat rows, and sentences.py's units."""
    units = []
    for ln in open(path, encoding='utf-8'):
        if not ln.strip():
            continue
        r = json.loads(ln)
        if 'messages' in r:
            m = {x['role']: x['content'] for x in r['messages']}
            units.append({'system': m['system'], 'src': m['user'], 'gold': m['assistant'],
                          'book': r.get('book'), 'page': r.get('page'), 'line': r.get('line'),
                          'lines': 1, 'identity': bool(r.get('identity'))})
        else:
            units.append({'system': r['system'], 'src': r['src'], 'gold': r['gold'],
                          'book': r.get('book'), 'page': r.get('page'), 'line': r.get('line'),
                          'lines': r.get('lines', 1), 'identity': bool(r.get('identity'))})
    return units


def do_generate(args):
    path = os.path.expanduser(args.units)
    if not os.path.isfile(path):
        sys.exit(f'eval-guard: no such file: {path}')
    units = read_units(path)
    if not units:
        sys.exit('eval-guard: the unit file is empty')

    # The prompt has to be the one the model was trained on, byte for byte, and
    # every row in a corpus should carry the same one. A corpus that does not is
    # a corpus that was built twice; refuse it rather than average over it.
    systems = {u['system'] for u in units}
    if len(systems) != 1:
        sys.exit(f'eval-guard: {len(systems)} distinct system prompts in {path}. '
                 'The prompt is load-bearing (foundry src/ocr/prompt.ts); refusing to guess.')

    props = None
    try:
        with urllib.request.urlopen(args.endpoint.rstrip('/') + '/props', timeout=30) as r:
            props = json.loads(r.read())
    except (urllib.error.URLError, OSError) as e:
        sys.exit(f'eval-guard: the server at {args.endpoint} did not answer /props ({e}).\n'
                 'Start llama-server on the base + adapter first; there is no fallback backend on purpose.')

    def one(u):
        raw = complete(args.endpoint, qwen3_prompt(u['system'], u['src']),
                       n_predict=len(u['src']) + 64, timeout=args.timeout,
                       adapter_id=args.adapter_id)
        # eval-line.py's reduction, exactly, and foundry's `extractOcrAnswer`.
        return {**{k: u[k] for k in ('book', 'page', 'line', 'lines', 'identity', 'src', 'gold')},
                'raw': raw, 'out': raw.strip().split('\n')[0].strip()}

    started = time.time()
    from concurrent.futures import ThreadPoolExecutor
    rows = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = [ex.submit(one, u) for u in units]
        for i, f in enumerate(futs):
            try:
                rows.append(f.result())
            except (urllib.error.URLError, OSError) as e:
                sys.exit(f'\neval-guard: the server at {args.endpoint} stopped answering ({e}).')
            if (i + 1) % 500 == 0:
                rate = (i + 1) / (time.time() - started)
                print(f'  ... {i + 1}/{len(units)}  ({rate:.1f}/s, '
                      f'{(len(units) - i - 1) / rate / 60:.1f} min left)', flush=True)

    meta = {
        'meta': True,
        'units': path,
        'unitCount': len(rows),
        'endpoint': args.endpoint,
        'adapterId': args.adapter_id,
        'serverProps': props,
        'serverArgs': args.server_args,
        'sampling': {'temperature': 0.0, 'top_k': 1, 'stop': ['<|im_end|>'],
                     'n_predict': 'len(src) + 64', 'cache_prompt': True},
        'systemPrompt': next(iter(systems)),
        'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'seconds': round(time.time() - started, 1),
    }
    out = os.path.expanduser(args.dump)
    with open(out, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(meta, ensure_ascii=False) + '\n')
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    print(f'eval-guard: {len(rows)} units in {meta["seconds"]}s -> {out}')


# ─────────────────────────────────────────────────────────────────────────────
# scoring
# ─────────────────────────────────────────────────────────────────────────────
def read_dump(path):
    lines = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    if not lines or not lines[0].get('meta'):
        sys.exit(f'eval-guard: {path} has no meta line — it was not written by `generate`.')
    return lines[0], lines[1:]


def score(rows, policy):
    scored = []
    for r in rows:
        g = guard_resolve(r['src'], r['out'], policy)
        before = lev(r['src'], r['gold'])
        after = lev(g['text'], r['gold'])
        scored.append({**r, 'text': g['text'], 'distBefore': before, 'distAfter': after,
                       'guardOk': g['ok'], 'why': g['why'],
                       'rejectedRuns': g['rejectedRuns'], 'acceptedRuns': g['acceptedRuns'],
                       'touched': g['text'] != r['src'],
                       'exact': g['text'] == r['gold']})
    return scored


def summarize(scored, policy):
    n = len(scored)
    gold_chars = sum(len(x['gold']) for x in scored)
    idents = [x for x in scored if x['identity']]
    degraded_chars = sum(max(0, x['distAfter'] - x['distBefore']) for x in scored)
    repaired_chars = sum(max(0, x['distBefore'] - x['distAfter']) for x in scored)
    return {
        'policy': policy, 'rows': n, 'goldChars': gold_chars,
        'cerBefore': sum(x['distBefore'] for x in scored) / max(1, gold_chars),
        'cerAfter': sum(x['distAfter'] for x in scored) / max(1, gold_chars),
        'improved': sum(1 for x in scored if x['distAfter'] < x['distBefore']),
        'degraded': sum(1 for x in scored if x['distAfter'] > x['distBefore']),
        'unchangedUnits': sum(1 for x in scored if x['distAfter'] == x['distBefore']),
        'identityRows': len(idents),
        'falseEdits': sum(1 for x in idents if x['touched']),
        'falseEditRate': sum(1 for x in idents if x['touched']) / max(1, len(idents)),
        'exactMatch': sum(1 for x in scored if x['exact']) / max(1, n),
        'corrections': sum(1 for x in scored if x['touched']),
        'unitsRefused': sum(1 for x in scored if not x['guardOk']),
        'runsReverted': sum(x['rejectedRuns'] for x in scored),
        'runsKept': sum(x['acceptedRuns'] for x in scored),
        'degradedChars': degraded_chars,
        'repairedChars': repaired_chars,
        'degradedPer100k': degraded_chars / max(1, gold_chars) * 100_000,
        'repairedPer100k': repaired_chars / max(1, gold_chars) * 100_000,
    }


def print_table(stats, meta):
    print(f'\n{"policy":12s}{"CER before":>12s}{"CER after":>11s}{"degraded":>10s}'
          f'{"deg/100k":>10s}{"rep/100k":>10s}{"falseEdit":>11s}{"corrections":>13s}{"exact":>8s}')
    # The baseline that makes the comparison impossible to skip: answer with the
    # input, always. Perfect on everything that punishes damage, repairs nothing.
    base = stats[0]
    exact_do_nothing = base['identityRows'] / max(1, base['rows'])
    print(f'  {"do nothing":10s}{base["cerBefore"] * 100:>10.3f}%{base["cerBefore"] * 100:>10.3f}%'
          f'{0:>10d}{0.0:>10.1f}{0.0:>10.1f}{0.0:>10.2f}%{0:>13d}{exact_do_nothing * 100:>7.1f}%')
    for s in stats:
        print(f'  {s["policy"]:10s}{s["cerBefore"] * 100:>10.3f}%{s["cerAfter"] * 100:>10.3f}%'
              f'{s["degraded"]:>10d}{s["degradedPer100k"]:>10.1f}{s["repairedPer100k"]:>10.1f}'
              f'{s["falseEditRate"] * 100:>10.2f}%{s["corrections"]:>13d}{s["exactMatch"] * 100:>7.1f}%')
    print(f'\n  {stats[0]["rows"]} units, {stats[0]["goldChars"]} gold characters, '
          f'{stats[0]["identityRows"]} already correct '
          f'({stats[0]["identityRows"] / max(1, stats[0]["rows"]) * 100:.1f}%)')
    if meta.get('serverProps', {}).get('model_path'):
        print(f'  model {meta["serverProps"]["model_path"]}')


def do_score(args):
    meta, rows = read_dump(os.path.expanduser(args.dump))
    print(f'eval-guard — {len(rows)} units from {meta["units"]}')
    print(f'  generated {meta["generatedAt"]} in {meta["seconds"]}s on {meta["endpoint"]}')
    if meta.get('serverArgs'):
        print(f'  server args: {meta["serverArgs"]}')

    all_scored = {p: score(rows, p) for p in POLICIES}
    stats = [summarize(all_scored[p], p) for p in POLICIES]

    print('\n' + '=' * 96)
    print('THE NUMBER THAT DECIDES: units the model made WORSE (`degraded`), and what it repaired')
    print('=' * 96)
    print_table(stats, meta)
    print('\n  A model only beats "do nothing" by moving CER down without moving degraded')
    print('  and falseEdit up. `degraded` counts UNITS — compare it only within one unit')
    print('  size; deg/100k and rep/100k are characters and compare across sizes.')

    # ── per book ────────────────────────────────────────────────────────────
    for p in POLICIES:
        by = defaultdict(list)
        for x in all_scored[p]:
            by[x['book']].append(x)
        if len(by) < 2:
            break
        if p == POLICIES[0]:
            print('\nPER BOOK')
            print(f'  {"policy":12s}{"book":22s}{"units":>7s}{"CER before":>12s}{"CER after":>11s}'
                  f'{"WORSE":>7s}{"deg/100k":>10s}{"falseEdit":>11s}')
        for b, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
            s = summarize(rs, p)
            print(f'  {p:12s}{str(b):22s}{s["rows"]:>7d}{s["cerBefore"] * 100:>11.3f}%'
                  f'{s["cerAfter"] * 100:>10.3f}%{s["degraded"]:>7d}{s["degradedPer100k"]:>10.1f}'
                  f'{s["falseEditRate"] * 100:>10.2f}%')

    # ── the two populations, which answer two different questions ───────────
    #
    # Already-correct units are the false-edit denominator: the only thing the
    # model can do to them is damage. Damaged units are the recall denominator:
    # the only place it can earn anything. Pooling them is how a corrector looks
    # good while mangling proper nouns, so they are printed apart.
    print('\nWHERE THE WORK IS — already-correct units vs damaged units')
    print(f'  {"policy":12s}{"population":14s}{"units":>7s}{"CER before":>12s}{"CER after":>11s}'
          f'{"impr":>7s}{"WORSE":>7s}{"deg/100k":>10s}{"rep/100k":>10s}')
    for p in POLICIES:
        for name, pop in (('already-correct', [x for x in all_scored[p] if x['identity']]),
                          ('damaged', [x for x in all_scored[p] if not x['identity']])):
            if not pop:
                continue
            s = summarize(pop, p)
            print(f'  {p:12s}{name:14s}{s["rows"]:>7d}{s["cerBefore"] * 100:>11.3f}%'
                  f'{s["cerAfter"] * 100:>10.3f}%{s["improved"]:>7d}{s["degraded"]:>7d}'
                  f'{s["degradedPer100k"]:>10.1f}{s["repairedPer100k"]:>10.1f}')

    # ── is the model even answering with the unit? ──────────────────────────
    #
    # A line model asked for a sentence can fail in a way no guard measures: it
    # answers with a FRAGMENT. The guard would call that an unbalanced change
    # and refuse it — correctly — but the refusal would read as "the guard is
    # working" when the real finding is "the unit is the wrong size for these
    # weights". So the shape of the raw answer is reported before any policy.
    print('\nGENERATION HEALTH — the RAW answer, before any guard')
    short = sum(1 for r in rows if len(r['out']) < 0.9 * len(r['src']))
    long_ = sum(1 for r in rows if len(r['out']) > 1.1 * len(r['src']))
    empty = sum(1 for r in rows if not r['out'])
    multi = sum(1 for r in rows if len(r['raw'].strip().split('\n')) > 1)
    ceiling = sum(1 for r in rows if len(r['raw']) >= len(r['src']) + 60)
    print(f'  answers under 90% of the input length   {short:6d}  ({short / len(rows) * 100:.2f}%)')
    print(f'  answers over 110% of the input length   {long_:6d}  ({long_ / len(rows) * 100:.2f}%)')
    print(f'  empty answers                           {empty:6d}')
    print(f'  answers spanning more than one line     {multi:6d}   (only the first is kept)')
    print(f'  answers near the n_predict ceiling      {ceiling:6d}')

    # ── what the guard is doing ─────────────────────────────────────────────
    whole = all_scored['whole-unit']
    per_run = all_scored['per-run']
    print('\nWHAT THE GUARD REFUSED')
    print(f'  units with at least one illegal run   {sum(1 for x in whole if not x["guardOk"])}')
    print(f'  illegal runs                          {sum(x["rejectedRuns"] for x in whole)}')
    print(f'  legal runs in those same units        '
          f'{sum(x["acceptedRuns"] for x in whole if not x["guardOk"])}'
          f'   <- what whole-unit throws away and per-run keeps')

    # ── the question the experiment was run to answer ───────────────────────
    print('\nWHERE THE TWO POLICIES DISAGREE (same generation, different blast radius)')
    both = list(zip(whole, per_run))
    differ = [(w, r) for w, r in both if w['text'] != r['text']]
    won = [(w, r) for w, r in differ if r['distAfter'] < w['distAfter']]
    lost = [(w, r) for w, r in differ if r['distAfter'] > w['distAfter']]
    same = len(differ) - len(won) - len(lost)
    print(f'  units where the shipped text differs  {len(differ)}')
    print(f'    per-run CLOSER to the truth         {len(won)}'
          f'   ({sum(w["distAfter"] - r["distAfter"] for w, r in won)} characters recovered)')
    print(f'    per-run FURTHER from the truth      {len(lost)}'
          f'   ({sum(r["distAfter"] - w["distAfter"] for w, r in lost)} characters lost)')
    print(f'    same distance, different text       {same}')

    # The specific hazard: per-run keeps a legal-looking run out of an answer
    # whole-unit had already condemned, and the text gets worse than doing
    # nothing. This is the case the whole-unit default is a bet against.
    hazard = [(w, r) for w, r in both
              if r['distAfter'] > r['distBefore'] and w['distAfter'] <= w['distBefore']]
    print(f'\n  PER-RUN DEGRADED A UNIT THAT WHOLE-UNIT DID NOT: {len(hazard)}')
    for w, r in hazard[:args.show]:
        print(f'    [{r["book"]} p{r["page"]} l{r["line"]}] '
              f'dist {r["distBefore"]} -> {r["distAfter"]}'
              f'{"  (was already correct)" if r["identity"] else ""}')
        print(f'      SRC       {json.dumps(r["src"], ensure_ascii=False)}')
        print(f'      MODEL     {json.dumps(r["out"], ensure_ascii=False)}')
        print(f'      PER-RUN   {json.dumps(r["text"], ensure_ascii=False)}')
        print(f'      GOLD      {json.dumps(r["gold"], ensure_ascii=False)}')
        print(f'      refused   {r["why"]}')

    for p in POLICIES:
        worse = sorted([x for x in all_scored[p] if x['distAfter'] > x['distBefore']],
                       key=lambda x: x['distBefore'] - x['distAfter'])
        if not worse:
            continue
        print(f'\nWORST DAMAGE UNDER {p} ({min(args.show, len(worse))} of {len(worse)}) '
              '— read these, do not average them')
        for x in worse[:args.show]:
            print(f'  [{x["book"]} p{x["page"]} l{x["line"]}] dist {x["distBefore"]} -> {x["distAfter"]}'
                  f'{"  (was already correct)" if x["identity"] else ""}')
            print(f'    IN   {json.dumps(x["src"], ensure_ascii=False)}')
            print(f'    OUT  {json.dumps(x["text"], ensure_ascii=False)}')
            print(f'    GOLD {json.dumps(x["gold"], ensure_ascii=False)}')

    if args.json_out:
        with open(os.path.expanduser(args.json_out), 'w', encoding='utf-8') as fh:
            json.dump({'meta': meta, 'stats': {s['policy']: s for s in stats}}, fh, indent=1)
        print(f'\nwrote {args.json_out}')

    if args.emit_verdicts:
        # For guard-crosscheck.mjs: the input pair and what this port decided.
        with open(os.path.expanduser(args.emit_verdicts), 'w', encoding='utf-8') as fh:
            for w, r in both:
                fh.write(json.dumps({'src': w['src'], 'out': w['out'],
                                     'wholeUnit': {'ok': w['guardOk'], 'text': w['text'],
                                                   'rejectedRuns': w['rejectedRuns'],
                                                   'acceptedRuns': w['acceptedRuns']},
                                     'perRun': {'ok': r['guardOk'], 'text': r['text'],
                                                'rejectedRuns': r['rejectedRuns'],
                                                'acceptedRuns': r['acceptedRuns']}},
                                    ensure_ascii=False) + '\n')
        print(f'wrote {args.emit_verdicts}  (feed it to guard-crosscheck.mjs)')


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)

    g = sub.add_parser('generate', help='run the model once and dump the raw answers')
    g.add_argument('--units', required=True)
    g.add_argument('--dump', required=True)
    g.add_argument('--endpoint', default='http://localhost:8771')
    g.add_argument('--adapter-id', type=int, default=0,
                   help='the llama-server LoRA slot to set to scale 1.0; pass -1 for a fused model')
    g.add_argument('--concurrency', type=int, default=16,
                   help='parallel requests. Safe because decoding is greedy, so a unit\'s '
                        'answer does not depend on what else is in flight. Match llama-server -np.')
    g.add_argument('--timeout', type=float, default=300)
    g.add_argument('--server-args', default='',
                   help='the llama-server command line, recorded verbatim in the dump')
    g.set_defaults(func=do_generate)

    s = sub.add_parser('score', help='score a dump under every policy — no server needed')
    s.add_argument('--dump', required=True)
    s.add_argument('--show', type=int, default=8)
    s.add_argument('--json', dest='json_out', default=None)
    s.add_argument('--emit-verdicts', default=None)
    s.set_defaults(func=do_score)

    args = ap.parse_args()
    if getattr(args, 'adapter_id', None) == -1:
        args.adapter_id = None
    args.func(args)


if __name__ == '__main__':
    main()
