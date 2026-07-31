"""Cheap text-layer sanity check over every born-digital book.

The pilot found a book whose ToUnicode CMap is wrong: capitals come out of the
text layer as punctuation, so the "truth" reads "Frank =appa". That is invisible
to the born-digital test — nobody OCR'd the book, the typesetter's own font is
just mis-mapped — and it is poison for a repair corpus. The signature is a
SYMBOL welded inside an alphabetic word, which real prose essentially never does.
"""
import fitz, json, re, os, sys
BAD = re.compile(r'[A-Za-z][=/*%<>\[\]\\|@#^~`{}]|[=/*%<>\[\]\\|@#^~`{}][A-Za-z]')
WORD = re.compile(r'\S+')
recs = json.load(open(os.path.expanduser(
    '~/Documents/BookForge/training/ocr-repair/all-pdfs-classified.json')))
bd = [r for r in recs if r['bucket'] == 'born-digital']
out = []
for i, r in enumerate(bd):
    try:
        doc = fitz.open(r['path']); n = doc.page_count
        idxs = [int(n * f) for f in (0.3, 0.45, 0.6, 0.75)]
        bad = tot = 0
        for p in idxs:
            for w in WORD.findall(doc[p].get_text()):
                if len(w) < 3: continue
                tot += 1
                if BAD.search(w): bad += 1
        doc.close()
        r2 = {'name': r['name'], 'path': r['path'], 'pageCount': r['pageCount'],
              'tokens': tot, 'suspectTokens': bad,
              'suspectRate': round(bad / tot, 5) if tot else None}
        out.append(r2)
    except Exception as e:
        out.append({'name': r['name'], 'path': r['path'], 'error': str(e)[:80]})
    if i % 40 == 0: print(i, flush=True)
ok = [r for r in out if r.get('suspectRate') is not None]
bad = [r for r in ok if r['suspectRate'] > 0.01]
print(f"\n{len(ok)} born-digital books checked; {len(bad)} with >1% symbol-in-word tokens")
for r in sorted(bad, key=lambda r: -r['suspectRate'])[:20]:
    print(f"  {r['suspectRate']*100:6.2f}%  {r['pageCount']:5}p  {r['name'][:66]}")
json.dump(out, open(os.path.expanduser(
    '~/Documents/BookForge/training/ocr-repair/truth-layer-gate.json'), 'w'), indent=1)
