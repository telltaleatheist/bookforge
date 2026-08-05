# The soft hyphen pdf.js throws away — a library-wide measurement

**Measured 2026-08-05 over Owen's whole archive corpus. Every number below has a
command or a script behind it. Nothing was written into any project.**

The finding being scoped: pdf.js's `getTextContent` drops every Unicode `Cf`
character, glyph and advance both, at one unconditional line in
`src/core/evaluator.js`:

```js
const SpecialCharRegExp = /^(\s)|(\p{Mn})|(\p{Cf})$/u;
...
if (category.isInvisibleFormatMark) { continue; }
```

Books typeset with a **soft hyphen (U+00AD)** as their wrap hyphen therefore
reach foundry with the mark gone, the two halves on separate lines, and
`src/export/linejoin.ts` joins them with a space: `totali tarianism`,
`modernis ing`, `commit tees`.

---

## 0. Method, and how it was validated

Three independent instruments, deliberately:

1. **A patched copy of pdf.js**, in the scratchpad only, never in the foundry
   repo. `pdfjs-dist@6.2.108` (foundry's exact pinned version, copied out of
   `foundry/node_modules`) with the drop site made switchable and every dropped
   glyph counted, plus an instrumentation hook on each font's finished
   `ToUnicode` map. Each book is read **twice in one process** — once in `drop`
   mode (byte-identical to stock) and once in `keep` mode — and the two line
   sets are diffed. Line assembly is ported verbatim from foundry's
   `src/pdf/extract.ts` (`BASELINE_TOLERANCE 0.4`, `WORD_GAP 0.2`, page-median
   type size, `disableNormalization: true`), so the lines compared are the lines
   foundry would build.

   *Validity check:* `verify-stock.mjs` runs the STOCK build and the patched
   build in `drop` mode over a whole book and compares every text item's string,
   width and transform. `IDENTICAL: true` on Kershaw *Working Towards The
   Fuhrer* (17 pp, 1,147,539 chars of item dump) and on Bergen *Twisted Cross*
   (40 pp, 1,229,455 chars). The "what foundry sees today" numbers are foundry's
   reader, not my patch.

2. **mutool 1.27.0** (`bookforge-app/resources/bin/mutool.exe`), a completely
   separate PDF engine that preserves U+00AD, as an outside check on the counts.

3. **`getOperatorList()`**, used to prototype repair option (a).

### The corpus

| | |
|---|---|
| project directories under `E:\Shared\BookForge\projects\` | 386 |
| directories with an `archive/` | 374 |
| PDFs in `archive/` | 165, across 159 projects |
| of those, macOS AppleDouble `._` stubs (4,096 bytes, not PDFs) | 4 |
| real archive PDFs | **161** |
| unreadable by pdf.js (`Illegal character: 41`; mutool also reports `format error: non-page object in page tree`) | 1 — *Reichsbishop Ludwig Muller*, Schneider 1993 |
| **measured** | **160 books, 50,581 pages, 1,790,536 assembled lines, 5.9 GB** |

This is not a sample — it is the population of archive PDFs. Books also exist
under `E:\Shared\BookForge\files\` and `E:\Shared\BookForge\ebooks\`, but those
are library copies, not project archives, and the picker reads the archive.
43 of the 161 are duplicates or second scans of a title held twice (Karl Barth
×2, *The German Christians* ×2, *One People One Reich* ×2, *Proclaimers* ×2), so
titles are slightly fewer than files; counts below are per file.

---

## A correction to the brief, and it matters

> "Foundry's join rule already handles U+00AD correctly and is inert because the
> character never arrives."

**It does not.** `src/paragraphs/hyphen.ts` defines

```ts
const WRAP_HYPHEN_END  = /[A-Za-zÀ-ÿ]-[ \t]*$/;
```

The `-` there is ASCII HYPHEN-MINUS U+002D. U+00AD is not in `À-ÿ`
(U+00C0–U+00FF) and is not U+002D, so `isWrapHyphenBreak` returns `false` for a
soft hyphen. `grep -rn` for `00ad|u00ad|soft hyphen|­` across foundry's `src/`,
`test/` and `docs/` returns **nothing**.

So fixing the reader alone makes the output *worse*, not better: `linejoin.ts`
would see a line ending in an invisible mark, take the `!halves` branch, and
emit `totali­ tarianism` — the same wrong space, now with a hidden character in
it. **Any reader-side fix must be paired with a foundry-side rule.** By
contrast BookForge's EPUB path already does `text.replace(/\u00AD\s*/g, '')`
(`electron/epub-processor.ts:756`), which is why this bites PDF-sourced books
only.

---

## 1. How widespread is it?

### Fonts that DECLARE a Cf character in ToUnicode

| | books | share |
|---|---|---|
| ≥1 font whose real `ToUnicode` CMap maps a glyph to a `Cf` codepoint | **61 / 160** | 38 % |
| …and that actually draw one | 43 | 27 % |
| …that declare but never draw | **18** | 11 % |

(Identity `ToUnicode` maps are excluded — an `IdentityToUnicodeMap` covers
0x0000–0xFFFF and would "declare" U+00AD for every CID font. Only real CMaps
are counted.)

Kershaw *Working Towards The Fuhrer* comes back **34 of 36 font loads carrying
U+00AD**, matching the brief's "34 of 42" exactly (42 is the PDF's font object
count; pdf.js loads 36).

The 18 declare-but-never-draw books are a red herring worth naming: they share a
producer that emits an enormous boilerplate `ToUnicode` covering U+200B, U+200C,
U+200D, U+200E/F, U+202A–E, U+2060–4, U+206A–F, U+FEFF, U+FFF9–B — 127 fonts
across 22 books declare that whole block, and **not one of those codepoints is
ever drawn anywhere in the corpus.** Declaration is not damage.

### Codes actually DRAWN in a content stream

Counted at the glyph, in the worker, in `keep` mode:

| codepoint | occurrences | books |
|---|---|---|
| **U+00AD SOFT HYPHEN** | **55,126** | **43** |
| U+0066 `f` (a two-character `ToUnicode` value ending in U+00AD) | 2 | 1 |
| U+002D `-` (same) | 1 | 1 |
| U+070F SYRIAC ABBREVIATION MARK | 1 | 1 |

Counted again at the text item, in the main thread, over the same 43 books:
**54,433**. Counted a third time by mutool: see §Cross-check. The three numbers
agree to ~1 %; the residue is glyphs in items that never survive into an
assembled line.

### How many line-ends would change

Diffing the `drop` and `keep` line sets over all 160 books:

* **54,305 assembled lines change** if the marks survive.
* **53,103** of them are lines whose LAST character becomes a soft hyphen —
  i.e. 53,103 words currently welded into two words by a space.
* Page-for-page the two passes are structurally identical: **160 / 160 books
  produced the same NUMBER of lines on every page in both modes**, so the
  diff is a character diff, not a re-layout.

### Per-book damage, the 43 affected books

`final` = line-final soft hyphens; `per1k` = per 1,000 assembled lines;
`vis-hy` = lines ending in a visible ASCII wrap hyphen, for scale.

| final | lines | per1k | vis-hy | book |
|---|---|---|---|---|
| 6,679 | 33,845 | 197.3 | 372 | Garbe, *Between Resistance and Martyrdom* |
| 5,525 | 38,965 | 141.8 | 164 | Bethge, *Dietrich Bonhoeffer* |
| 3,762 | 27,954 | 134.6 | 236 | Irving, *Göring* |
| 3,153 | 23,345 | 135.1 | 1,034 | Meier, *The German Christians* (×2 copies) |
| 2,440 | 15,509 | 157.3 | 96 | Spicer, *Hitler's Priests* |
| 2,422 | 19,363 | 125.1 | 103 | Persico, *Nuremberg* |
| 2,292 | 10,750 | **213.2** | 176 | Hanebrink, *In Defense of Christian Hungary* |
| 1,924 | 13,077 | 147.1 | 130 | Bergen, *Twisted Cross* |
| 1,832 | 17,631 | 103.9 | 160 | Ungváry, *The Siege of Budapest* |
| 1,704 | 15,547 | 109.6 | 58 | Barnett, *For the Soul of the People* |
| 1,378 | 13,688 | 100.7 | 58 | Steigmann-Gall, *The Holy Reich* |
| 1,023 | 4,075 | **251.0** | 69 | *One People, One Reich, One Faith* |
| … | | | | 31 further books, tailing to 1 |
| 31 | 798 | 38.8 | 4 | Kershaw, *Working Towards The Fuhrer* |

Damage in an affected book: **median 82 broken words per 1,000 lines, worst
251** — one line in four. 38 of the 43 are full-length books (>2,000 lines).

**The headline ratio.** In the affected books there are 53,103 soft wrap
hyphens and 6,464 visible ones: **89.1 % of every wrap hyphen in those books is
invisible to foundry.** These are not books that occasionally use U+00AD; these
are books whose ONLY wrap hyphen is U+00AD.

### Cross-check against mutool (independent engine)

`mutool draw -F txt` over nine whole books:

| pdf.js (patched) | mutool `\u00AD` | mutool `\u00AD\n` | book |
|---|---|---|---|
| 3,764 | 3,764 | 3,764 | Irving, *Göring* |
| 1,963 | 1,963 | 1,963 | Bergen, *Twisted Cross* |
| 1,378 | 1,378 | 1,378 | Steigmann-Gall, *The Holy Reich* |
| 1,223 | 1,223 | 1,223 | Busch, *Karl Barth* |
| 745 | 745 | 745 | Carsten, *Rise of Fascism* |
| 700 | 700 | 700 | Pintar & Lynn, *Hypnosis* |
| 263 | 263 | 263 | Smith, *Michelle Remembers* |
| 31 | 31 | 31 | Kershaw, *Working Towards The Fuhrer* |
| 0 | 0 | 0 | Green, *Deathstalker War* |

Exact agreement on every book, and mutool independently puts **100 % of them
immediately before a newline**.

---

## 2. What else is being dropped?

**Only U+00AD matters here, and the answer is not close.**

Of 55,130 `Cf` glyph occurrences drawn across 160 books and 50,581 pages,
**55,126 are U+00AD (99.993 %)**. U+200B, U+200C, U+200D, U+2060 and U+FEFF are
**drawn zero times anywhere in the corpus**, despite 22 books declaring all of
them in font `ToUnicode`. There is no Arabic or Indic material in this library
for ZWNJ/ZWJ to matter to.

The four non-U+00AD occurrences are worth one sentence each because they are a
*second*, subtler bug:

* The regex is `/^(\s)|(\p{Mn})|(\p{Cf})$/u`. The third alternative is anchored
  at the END only. `glyph.unicode` may be a MULTI-character string when one
  glyph's `ToUnicode` value is a sequence. Two glyphs in Bethge's *Bonhoeffer*
  map to `"f\u00AD"` and one in *Nuremberg* to `"-\u00AD"`; pdf.js drops the
  **whole string**, so a visible `f` and a visible `-` vanish from the text
  layer along with the mark.
* One U+070F (Syriac abbreviation mark) in *Nuremberg* is a mis-mapped glyph in
  a damaged font, drawn once.

Three lost visible characters in 50,581 pages. Real, but not a reason to do
anything.

---

## 3. Is the space always wrong?

Yes, essentially always.

**In foundry's assembled lines:** 53,103 line-final (97.6 %), 1,314 "interior"
(2.4 %), 0 line-initial.

But the 2.4 % is not what it looks like, and this is the one place where the
naive reading of the number would have been wrong. Counted **at the show-text
item** instead of at the assembled line, over all 43 affected books:

```
TOTAL item-final 54,429   item-interior 4
```

**Every soft hyphen but four sits at the end of its show-text item.** The 2.4 %
"interior" cases are foundry's own baseline clustering welding two columns of an
index or an endnote page into one line — the mark is still line-final on the
page, it just has the neighbouring column's text after it in foundry's string:

```
p823 "277 79, 284, 293, 295, 298; reorga­ and, 50-59; von Freyenwald and,"
p212 "A Study of Friedrich Nietzsche (Lon­ mann on modern art: Kunst (art) comes"
```

There is no population of mid-line "legal break point" soft hyphens in this
library. Typesetters here inserted U+00AD only where the line actually broke.
**Dropping it is wrong 99.99 % of the time it happens**, and the fix is not
smaller than it looks.

---

## 4. The repair options, costed

### (a) Reconcile `getOperatorList()` against `getTextContent()`

**Prototyped** (`prototype-a.mjs`), stock pdf.js, 161 books × first 60 pages =
8,444 pages.

The premise holds: the operator list keeps the marks. On Kershaw,
`cfInOps: 31, cfInText: 0`.

Reconciliation is *not* a plain diff — the streams never match as strings,
because `getTextContent` synthesises word spaces from geometry that the operator
list has no character for (`"CAMBRIDGEUNIVERSITY"` vs `"CAMBRIDGE UNIVERSITY"`).
Exact equality holds on **1,911 / 8,444 pages (23 %)**. But the useful invariant
does hold: strip whitespace from both and the operator stream minus its `Cf`
characters equals the text stream.

| | pages | non-space aligned | marks | placed |
|---|---|---|---|---|
| the 43 affected books | 2,428 | **2,424 (99.8 %)** | 7,830 | **7,818 (99.8 %)** |
| the 117 unaffected books | 6,016 | 5,521 (91.8 %) | 7 | n/a |

Reconstruction is correct where it aligns:

```
p2 " too, was — and intentionally so - a 'modernis­\ning dictator"
p3 "ing contrasts can be more valuable than compar­\ning similari"
```

**Cost.** `getOperatorList()` costs **90.3 ms/page** on the affected books
against **7.3 ms/page** for `getTextContent()` — a **12× increase in extraction
time**, because it decodes every image on the page as a side effect. On a
600-page scanned book that is ~1 minute added per `scan --pdf` / `reflow`.

**Risk.** You are asserting an invariant about pdf.js internals that pdf.js does
not promise: that the operator list's glyph order and the text content's
character order agree modulo whitespace. It holds on 99.8 % of affected pages
today and silently fails on 0.2 %, and a future pdf.js that changes when it
synthesises a space breaks it with no error. You would also be writing a real
alignment (my prototype assumes exact equality after the whitespace strip and
bails otherwise) plus a fallback path. **Effort: 1–2 days plus a permanent
maintenance liability. Damage fixed: ~99.8 %.**

### (b) A geometry rule with no character at all

**Measured** (`analyze-geometry.py`), on 36 affected books with ≥100 marks.
`bodyRight` computed the way `src/paragraphs/calibration.ts` computes it (modal
right edge). Because pdf.js discards the mark's ADVANCE as well, a line that had
one really does end short — the shortfall is directly measurable as
`keep_x1 − drop_x1`, **median 14 px at 300 dpi (≈3.4 pt)**.

The separation does not survive contact with real books:

| best-case precision of the tightest geometry band | books |
|---|---|
| ≥ 90 % | **7 of 36** (Irving *Göring* 99.7 %, *One People* 99.4 %, Steigmann-Gall 99.3 %, Haynes 99.7 %, Barnes 97.2 %, Streicher 95.2 %, Carsten 92.6 %) |
| 30–90 % | 2 |
| **< 30 %** | **27 of 36** — median precision ≈ 22 % |

The seven that work are rigidly justified books where every full line ends at
the same x. Everywhere else the wrap lines' right-edge distribution overlaps the
ordinary lines' completely (e.g. Scholder vol. 1: 2.4 % precision; Karl Barth:
8.6 %).

Two further objections that no calibration fixes: the shortfall (≈14 px) is
smaller than calibration's own bucket (`bodyHeight/4`, ≈10–14 px — the same
order), and the signal exists **only because of the bug** — it disappears the
moment the reader is fixed, so (b) can never be combined with (a) or (d).
**Effort: low. Damage fixed: reliably, on ~19 % of affected books. Verdict:
no.**

### (c) Corpus attestation over the join

**Measured** (`analyze-rule-c.py`), 161 books, **1,048,769 candidate line joins**
(consecutive lines, no visible hyphen, letter-to-letter). Ground truth is the
`keep` pass: a break really was a wrap iff the line ended in U+00AD. **51,968**
true joins are scorable in-page (177 more sit at a page end and were not scored).

**The rule as briefed does not work, and the reason is instructive.** "Join if
the joined form is attested and neither fragment is", run over the book's whole
vocabulary, **fired once in 161 books, with 0 true positives.** Because
`totali` and `tarianism` stand alone at a line edge, they enter the vocabulary
as free-standing words and **attest themselves**, so "neither fragment is
attested" is never true. `hyphen.ts` already masks visible `word-\nword` splits
out of the attestation for exactly this reason; the no-character case needs the
same protection and does not have it.

Fix the self-attestation — build the word set from **interior tokens only**
(tokens that are neither the first nor the last on their line) — and it works:

| rule | fires | TP | FP | recall | precision |
|---|---|---|---|---|---|
| R1 — as briefed, whole vocabulary | 1 | 0 | 1 | 0.0 % | — |
| **R2 — joined attested interior, neither fragment attested interior** | 18,091 | 17,896 | **195** | **34.4 %** | **98.9 %** |
| R3 — joined attested only (no fragment guard) | 52,303 | 42,426 | 9,877 | 81.6 % | 81.1 % |
| R4 — R2 + continuation is lowercase | 18,082 | 17,889 | 193 | 34.4 % | 98.9 % |
| R5 — R2 without the *tail* guard | 23,903 | 23,630 | 273 | 45.5 % | 98.9 % |
| R6 — R2 without the *head* guard | 28,414 | 28,094 | 320 | 54.1 % | 98.9 % |

**The false-positive test that matters** is the 118 books with no soft hyphen at
all, where every fire is by construction a fire on a genuine word boundary:
**685,233 candidate joins, R2 fires 74 times** — 10.8 per 100,000 joins, about
0.6 per book. (R3 fires 6,709 times there. R3 is out.)

**All 195 R2 false positives were captured and inspected by hand.** They are
almost entirely NOT errors — they are correct joins on wraps whose hyphen the
text layer never carried at all, for reasons unrelated to U+00AD (OCR layers,
producers that emit nothing at the break). My ground truth only knows about
U+00AD, so it scores them wrong:

```
'in das Konzen' + 'trationslager Sachse'  -> konzentrationslager
'Jahrestag der »Machtergrei' + 'fung«'    -> machtergreifung
'Darstellung der Ge' + 'schichte des jüd'  -> geschichte
'indicated that the estab' + 'lishment'    -> establishment
'by the force of the explo' + 'sion'       -> explosion
'commemorating-german-resist' + 'ance-ﬁghters'  -> (a wrapped URL)
```

By eye, **2 distinct genuine mis-welds in the whole corpus**: `Humani` +
`generis` → `humanigeneris` (a Latin two-word encyclical title, in Busch's *Karl
Barth*, which the library holds twice, so it appears as 2 of the 195), and one
`te` + `nd` → `tend` out of a garbled OCR line in *Life — How Did It Get Here?*.
**3 wrong welds, 2 of them the same error twice, in 1,048,769 line joins.**

Two more numbers that bound the option:

* **Recall ceiling is 81.6 %** — that is how often the joined form appears
  interior anywhere else in the same book. R2's 34.4 % is well under it; the gap
  is fragments that leak into the interior set through the same two-column line
  merges noted in §3. R5/R6 recover half of that gap, but sampling R6's extra
  fires shows its characteristic error — the head guard is what stops
  `to`+`ofter`→`too`, `a`+`loud`→`aloud`, `WILL`+`ing`→`willing`,
  `your`+`self-control`→`yourself`. **Keep both guards. R2 is the safe rule.**
* **1.2 % of true soft-hyphen joins (629 of 51,968) have `head-tail` attested as
  a single-line compound elsewhere in the book** — `non­\ndecision` where the
  book elsewhere writes `non-decision`. These must keep a hyphen, not weld.
  This is the measured cost of the unconditional `replace(/\u00AD\s*/g, '')`
  that BookForge's EPUB path uses, and the reason a restored U+00AD should be
  routed through `proveHyphenVerdict` rather than welded.

**Effort: a few hours, entirely inside `src/paragraphs/hyphen.ts` +
`src/export/linejoin.ts`. No reader change, no model, no new dependency. Damage
fixed: 34 %. Risk: ~2 wrong welds per million joins, and it also repairs
hyphen-less wraps that U+00AD has nothing to do with.**

### (d) Patch or fork pdf.js

* **Version and form:** `pdfjs-dist@6.2.108`, a plain `dependencies` entry in
  `foundry/package.json`, resolved in `bun.lock`. **Not vendored** — `vendor/`
  holds only tesseract. `src/pdf/runtime.ts` imports the *legacy* build and
  installs the in-process worker.
* **Is the check reachable through any option?** **No.** In the worker,
  `getTextContent` accepts `includeMarkedContent`, `disableNormalization` and
  `keepWhiteSpace`. `keepWhiteSpace` governs whitespace glyphs, not `Cf`, and
  more decisively `Page.streamTextContent` on the main thread forwards **only**
  `includeMarkedContent` and `disableNormalization` — `keepWhiteSpace` is
  unreachable from a caller. The `isInvisibleFormatMark` `continue` is
  unconditional and precedes `translateTextMatrix`, so glyph and advance both go.
  `disableNormalization` genuinely does not touch it: `normalizeUnicode`'s regex
  covers U+00A0, U+00B5, U+2000–A, ligatures and Arabic presentation forms, and
  contains no U+00AD.
* **The patch is one line.** Delete the `continue` (or gate it on a new option).
  Everything downstream already handles a `Cf` glyph like any other: it gets its
  advance, its width lands in `textChunk.width`, and the item string carries it.
  My `keep` mode is exactly this patch, and it ran clean over all 160 books.
* **Mechanics:** `bun patch pdfjs-dist@6.2.108` → edit → `bun patch --commit`,
  which writes `patches/pdfjs-dist@6.2.108.patch` and a `patchedDependencies`
  entry. `tools/release-build.sh` compiles from the installed `node_modules`, so
  the patch is baked into every `bun build --compile` target with no build
  change. Upstreaming is a separate, slower question: pdf.js has no
  `keepFormatMarks` option today and adding one is new public API.
* **Risk:** the patch itself is near-zero risk and self-documenting. The real
  risk is the pairing — **on its own it makes the output worse** (see the
  correction above), so it is only ever shipped together with foundry teaching
  `hyphen.ts` that U+00AD is a wrap hyphen. Maintenance is one patch file to
  re-check on each pdfjs bump.

**Effort: ~1 hour for the patch, ~2 hours for the foundry side (extend
`WRAP_HYPHEN_END`/`WRAP_HYPHEN_CONT`/`HYPHEN_SPLIT` to accept U+00AD, and in
`linejoin.ts` treat a U+00AD break as join evidence handed to
`proveHyphenVerdict` — with the `null` verdict resolving to *close the gap with
no hyphen*, since U+00AD by definition is not part of the word, unlike a visible
hyphen). Damage fixed: 100 %, with the 1.2 % compound cases decided by the
book's own vocabulary instead of welded.**

---

## 5. Recommendation

Ranked by (damage fixed) ÷ (risk × effort):

| | damage fixed | effort | risk | verdict |
|---|---|---|---|---|
| **(d) patch pdf.js + teach foundry U+00AD** | **100 %** | ~half a day | low, one patch file | **do this first** |
| (c) attestation over the bare join | 34 % | a few hours | ~2 wrong welds / 10⁶ joins | **do this too — it fixes a different bug** |
| (a) operator-list reconciliation | 99.8 % | 1–2 days | permanent invariant on pdf.js internals; 12× extraction cost | no |
| (b) geometry | ~19 % of books | low | unusable on 27 of 36 books; and it evaporates once (d) lands | no |

**Do (d) first.** The honest answer here is *not* "(c) is 90 % of the win for
5 % of the risk" — (c) is 34 % of the win. The brief's framing assumed (d) was
expensive; measured, it is one deleted line in a `bun patch` plus a regex and a
verdict branch in foundry, and it is the only option that recovers all 53,103
breaks with the mark's own meaning intact. Option (a) buys 99.8 % of the same
result for ten times the work, a 12× extraction slowdown and a standing bet on
pdf.js's internal ordering; there is no reason to pay that when the one-line
patch is available and reproducible from a lockfile.

**Then do (c) anyway, as a separate change.** It is not a fallback for (d) — it
addresses a *different* population. The 195 "false positives" measured against a
U+00AD ground truth are overwhelmingly real wraps in books that carry **no wrap
character at all** (Niedlich 1921, the *Proclaimers* volumes, the Deathstalker
set, several OCR layers). Those books are invisible to this survey's headline
count and (d) does nothing for them. R2's measured false-positive rate on
685,233 joins in 118 hyphen-free books is 74 fires — and hand-inspecting all 74
finds exactly **one** genuinely wrong weld (`te`+`nd`, out of a garbled OCR
line); the other 73 are correct joins the ground truth could not see.

**Two things to fix regardless of which option ships:**

1. `hyphen.ts` must mask candidate no-character line breaks out of the
   attestation before building the word set, or the fragments attest themselves
   and every such rule is silently inert (measured: R1 fires once in 161 books).
   The masking already exists for visible hyphens — it needs the analogue.
2. Two-column pages (indexes, endnotes) are being welded into single lines by
   `assembleLines`' baseline clustering. It is what makes 2.4 % of the marks look
   mid-line, and it corrupts those pages' text independently of anything in this
   report.

---

## 6. What this measurement does NOT support

* **Anything about non-Latin books.** The corpus is English and German. ZWNJ/ZWJ
  are drawn zero times here; that is a fact about this library, not about PDFs.
* **The 43 affected books are 43 *files*, ~40 titles** — four titles are held
  twice and both copies were measured, which slightly inflates corpus totals.
* **Option (a)'s alignment rate is measured on the first 60 pages of each book**
  (8,444 pages), not whole books; front matter is over-represented.
* **The FP classification in §4(c) is mine, by eye**, over all 195 captured
  cases. The 2-genuine-errors figure is a judgement about whether a join is
  correct, not a measurement.
* **Option (b)'s "best case precision"** is an oracle number — it uses the true
  answer to pick the band. A real implementation would do worse.
* **The 1 unreadable PDF** (Reichsbishop Ludwig Muller) is broken for foundry
  today, independently of any of this.

---

## Appendix — how to reproduce

Scripts lived in the session scratchpad and were removed after the numbers were
taken; each is a single file with no dependency beyond `bun`, `python` and the
copied `pdfjs-dist`.

| script | what it does |
|---|---|
| `patch-pdfjs.mjs` | makes the `Cf` drop switchable in a scratchpad copy of `pdfjs-dist@6.2.108`, and counts `ToUnicode` `Cf` declarations per font |
| `verify-stock.mjs` | proves patched-in-`drop`-mode is byte-identical to stock |
| `measure-book.mjs` | reads a book twice (drop/keep), assembles lines with foundry's algorithm, emits per-book counts + a compact ground-truth dump |
| `run-all.py` | drives the above over every archive PDF, 5-way parallel |
| `analyze-survey.py` | §1–§3 tables |
| `interior-probe.mjs` | item-level vs line-level position of each mark |
| `analyze-rule-c.py` / `summarize-rule-c.py` | §4(c), rules R1–R6 scored against the `keep`-pass ground truth |
| `analyze-geometry.py` | §4(b) |
| `prototype-a.mjs` | §4(a) |
