#!/usr/bin/env python3
"""THIN ADAPTER — eval-guard.py is not modified.

`eval-guard generate --units` wants rows carrying {system, src, gold, ...}. An
existing DUMP carries the same rows minus `system` (which lives once, on the
meta line, as `systemPrompt`) plus the answers a previous model gave. This
re-emits the dump's unit set as a units file so a NEW model can be generated
over EXACTLY the same src units — same text, same order, same prompt.

    dump-to-units.py <dump.jsonl> <units.jsonl>
"""
import json, sys

src, dst = sys.argv[1], sys.argv[2]
lines = [json.loads(l) for l in open(src, encoding='utf-8') if l.strip()]
meta, rows = lines[0], lines[1:]
assert meta.get('meta'), f'{src} has no meta line'
system = meta['systemPrompt']
with open(dst, 'w', encoding='utf-8') as fh:
    for r in rows:
        fh.write(json.dumps({'system': system,
                             **{k: r[k] for k in ('src', 'gold', 'book', 'page',
                                                  'line', 'lines', 'identity')}},
                            ensure_ascii=False) + '\n')
print(f'{len(rows)} units -> {dst}')
