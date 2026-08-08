#!/usr/bin/env python3
"""Is greedy decoding on this server byte-reproducible? Run the SAME condition
twice and diff. If it is not, a "the adapter changed the answer" claim built on
a single pair of runs is partly measuring batching noise."""
import json, urllib.request, argparse
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


ap = argparse.ArgumentParser()
ap.add_argument('--dump', required=True)
ap.add_argument('--n', type=int, default=103)
ap.add_argument('--scale', type=float, default=0.0)
ap.add_argument('--workers', type=int, default=8)
a = ap.parse_args()

lines = [json.loads(l) for l in open(a.dump, encoding='utf-8') if l.strip()]
meta, rows = lines[0], [r for r in lines[1:] if not r['identity'] and r['src'] != r['gold']][:a.n]
system = meta['systemPrompt']


def run(workers):
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(lambda r: complete(qwen3_prompt(system, r['src']),
                                              len(r['src']) + 64, a.scale), rows))


x = run(a.workers)
y = run(a.workers)
z = run(1)
print(f'{len(rows)} units, scale={a.scale}')
print(f'  run A vs run B (both -np {a.workers} concurrent)   identical on {sum(1 for p, q in zip(x, y) if p == q)}/{len(rows)}')
print(f'  run A vs run C (C is serial, 1 request at a time)  identical on {sum(1 for p, q in zip(x, z) if p == q)}/{len(rows)}')
print(f'  run B vs run C                                     identical on {sum(1 for p, q in zip(y, z) if p == q)}/{len(rows)}')
for i, (p, q) in enumerate(zip(x, y)):
    if p != q:
        print(f'\n  first divergence, unit {i} [{rows[i]["book"]} p{rows[i]["page"]} l{rows[i]["line"]}]')
        print(f'    A {json.dumps(p, ensure_ascii=False)}')
        print(f'    B {json.dumps(q, ensure_ascii=False)}')
        break
