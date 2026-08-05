#!/usr/bin/env python3
"""Adapter activation proof for ocr_sent_v1_4b — same shape as the Aug 5
results-guard-experiment/adapter-activation-proof.txt.

Runs the SAME rows at scale 1.0 and scale 0.0 (bare base) and, as the control
that says scale 0.0 really is the base, with no `lora` field at all.
"""
import json, sys, urllib.request, argparse
from concurrent.futures import ThreadPoolExecutor

EP = 'http://127.0.0.1:8771'


def qwen3_prompt(system, user):
    return (f'<|im_start|>system\n{system}<|im_end|>\n'
            f'<|im_start|>user\n{user}<|im_end|>\n'
            f'<|im_start|>assistant\n<think>\n\n</think>\n\n')


def complete(prompt, n_predict, lora):
    body = {'prompt': prompt, 'n_predict': n_predict, 'temperature': 0.0,
            'top_k': 1, 'stop': ['<|im_end|>'], 'cache_prompt': True}
    if lora is not None:
        body['lora'] = [{'id': 0, 'scale': lora}]
    req = urllib.request.Request(EP + '/completion', data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())['content'].strip().split('\n')[0].strip()


def load(path, system):
    rows = []
    for ln in open(path, encoding='utf-8'):
        if not ln.strip():
            continue
        r = json.loads(ln)
        if r.get('meta'):
            continue
        if 'messages' in r:
            m = {x['role']: x['content'] for x in r['messages']}
            r = {'src': m['user'], 'gold': m['assistant'], 'book': r.get('book'),
                 'page': r.get('page'), 'line': r.get('line'),
                 'identity': bool(r.get('identity'))}
        rows.append(r)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', required=True)
    ap.add_argument('--n', type=int, default=120)
    ap.add_argument('--show', type=int, default=3)
    ap.add_argument('--label', default='')
    a = ap.parse_args()

    meta = json.loads(open(a.dump, encoding='utf-8').readline())
    system = meta['systemPrompt'] if meta.get('meta') else None
    rows = [r for r in load(a.dump, system) if not r['identity'] and r['src'] != r['gold']]
    rows = rows[:a.n]
    print(f'{a.label}: {len(rows)} damaged units from {a.dump}')

    def run(scale):
        with ThreadPoolExecutor(max_workers=8) as ex:
            return list(ex.map(lambda r: complete(qwen3_prompt(system, r['src']),
                                                  len(r['src']) + 64, scale), rows))

    on = run(1.0)
    off = run(0.0)
    none = run(None)

    print(f'  adapter ON   scale 1.0            exact match to truth   '
          f'{sum(1 for r, o in zip(rows, on) if o == r["gold"])}/{len(rows)}')
    print(f'  adapter OFF  scale 0.0            exact match to truth   '
          f'{sum(1 for r, o in zip(rows, off) if o == r["gold"])}/{len(rows)}')
    print(f'  no `lora` field at all            exact match to truth   '
          f'{sum(1 for r, o in zip(rows, none) if o == r["gold"])}/{len(rows)}')
    print(f'  rows where ON and OFF differ      '
          f'{sum(1 for x, y in zip(on, off) if x != y)}/{len(rows)}')
    print(f'  OFF is byte-identical to no-lora-field on '
          f'{sum(1 for x, y in zip(off, none) if x == y)}/{len(rows)} rows')

    shown = 0
    for r, o, f in zip(rows, on, off):
        if shown >= a.show:
            break
        if o == r['gold'] and f != r['gold']:
            print(f'\n  [{r["book"]} p{r["page"]} l{r["line"]}]')
            print(f'    INPUT (damaged)          {json.dumps(r["src"], ensure_ascii=False)}')
            print(f'    TRUTH                    {json.dumps(r["gold"], ensure_ascii=False)}')
            print(f'    adapter ON  (scale 1.0)  {json.dumps(o, ensure_ascii=False)}   <- matches truth')
            print(f'    adapter OFF (scale 0.0)  {json.dumps(f, ensure_ascii=False)}   <- bare base, still wrong')
            shown += 1


main()
