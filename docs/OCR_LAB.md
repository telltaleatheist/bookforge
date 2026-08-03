# OCR Lab — the band pipeline and the road to ocr

**Goal** (owner's words, Jul 2026): *"make ours ultimately as good as pdfelement's… we can work
with mangled/jumbled. we cannot work with missing."* Missing text is the fatal class; mangled
text is repairable downstream.

**Status (Aug 2026): architecture settled and measured.** The band pipeline beats the shipping
whole-page-Tesseract path on every axis, beats PDFelement on speed by 5–8×, and out-reads it on
decorative type. What remains is productization (TypeScript port into the app) and the correction
model (**ocr**).

## The pipeline

```
render 200dpi → border/edge masking → (XY-cut if columns) → projection-profile BANDS
             → per-line Tesseract --psm 7 (batched: ONE process per page, image list / TSV,
               empty→ retry --psm 13) → [ocr line correction — NOT BUILT YET]
             → deterministic band→block grouping (pitch/indent/gap) → blocks
```

Core idea: **take layout away from Tesseract**. Its layout analysis silently drops whole lines
(2 pages of deathstalker produced NOTHING; confidence cannot see it — 0.94 around the hole).
Bands partition the page's ink, so coverage is a *checkable invariant* (ink-outside-bands ≈ 0,
audited per page), and `--psm 7` on one line has no layout left to fail at. Font size/weight/slant
come from ink measurement (x-height, stroke width, shear), NOT from Tesseract — we need a
font-CHANGE detector, not a font identifier (PDFelement itself just snaps to Times/Arial).

## Tools (`tools/ocr-lab/`)

| tool | job |
|---|---|
| `extract_reference.py` | PDFelement searchable PDF → per-page gold JSON (lines, chars, fonts) via mutool stext; char-exact (validated vs mupdf's own line text, 532/532 pages) |
| `bands.py` | band segmentation, page-derived thresholds (nothing hand-tuned survives) |
| `run-book.py` | batched recognition: 1 tesseract/page over an image list, TSV parse, psm-13 rescue, parallel across pages |
| `score.py A|B|C|D|compare|scale|quirks` | metrics vs a reference (A=old pipeline text, B=band geometry, C=sample, D=full-book band text) |
| `align-epub.py` | OCR stream vs EPUB truth: anchor+LIS, hyphen-join gated on the EPUB's own vocabulary, **order-free rescue for transposed footnotes**, directional missing/orphan accounting; emits training pairs |

Data per book: `/Volumes/Callisto/training/ocr-lab/<book>/{renders,bands,ocr-bands,reference,scores}/`.

## Measured results

**deathstalker (532pp, poor scan; reference = PDFelement gold, furniture excluded):**

| | whole-page Tesseract (shipping) | bands + psm7 |
|---|---|---|
| line recall | 99.740% (55 missing) | **99.891% (23 missing)** |
| CER raw mean / p95 | 1.963% / 8.5% | **1.575% / 6.8%** |
| CER normalized mean / p95 | 0.519% / 3.6% | **0.117% / 0.000%** |
| pages with zero output | 2 (382, 522) | **0** |
| geometric capture of real lines | — | **100.000%** (22,134/22,134) |
| full-book wall time | — | **69.9 s** (12 workers; 1.22 s/page/worker) |

All 23 residual misses are non-body: 10 = a ruled-box ad page (boxes defeat projection — open fix),
7 = back-cover reversed type (needs invert-retry — open fix), 4 = decorative display lettering
(PDFelement mangles it too), plus the reference's own `CHRPT€R€L€V€N` which we read correctly as
`CHAPTER ELEVEN`. **Zero body-text misses.**

**michelle remembers (360pp, bad IA scan, publisher-quality EPUB truth; generalization test —
zero thresholds retuned):** missing body text **0.031%** (162 chars; mostly `I`→`|`, `Yes`→`Ves`
single-word recognition, only 92 chars from 2 merged bands). **No body line lost by segmentation.**
Thresholds self-derived correctly for 33% larger type + fainter scan; coverage BETTER than
deathstalker (median missed-ink 0.14% vs 0.19%). 352 pages in 37.6 s. Photo-insert captions lost
(halftones leave no blank rows — known projection limit, 8 pages). **Training yield: 8,956 pairs,
CER mean 4.4%, 43% byte-exact.**

## Page deskew (shipped Aug 1 2026)

A projection profile cannot see a line it is not parallel to: tilt the page and the blank leading
stops being a blank ROW, so two lines come back as one band. `bands.py` now straightens each page
before profiling it — coarse-to-fine (0.25° then 0.025°, bounded ±3°) over the **horizontal
projection profile's concentration** (sum of squared row counts), scored by shearing the ink
coordinates rather than resampling the raster. Each page records `deskewDeg`; `run-book.py` re-applies
it before cropping. The rotated content rect is the box **inscribed** in the rotated original — never
re-detect the border on a rotated page, its margin is diagonal and `local_paper` then eats the fill.

**deathstalker rebellion (516pp, the tilted sibling), before → after:**

| | before | after |
|---|---|---|
| bands >1.5× median height | 1.686% | **0.350%** (book 1, straight: 0.190%) |
| truth words aligned word-for-word | 96.69% | **99.37%** |
| MISSING body text, drift excluded | 17,696 chars (1.526%) | **1,536 chars (0.1325%)** |
| CER mean / p95 | 2.06% / 8.33% | **1.17% / 3.70%** |
| bands / psm-13 rescues | 21,648 / 585 | 22,008 / **90** |
| pages flagged | 63 | **22** |

Angles: 51.2% of pages ≥0.1°, |deg| p50 0.25 / p90 0.60 / max 0.95; even pages mean −0.119°, odd
+0.291° — a recto/verso signature, not a drift. **Tilt, not curl**: third-to-third spread within a
page is p50 0.038° / p90 0.175°, mean(top−bottom) −0.018° ± 0.093 — no systematic bow, and 0.2°
across a page is 2 px against a 25 px line pitch. **Do not build dewarp for this book.**

Cost: `estimate_skew` 31 ms/page + rotate 8 ms/page; `bands.py` over 516 pages 20.7 s → 40.5 s.
A page under 0.1° is not rotated at all, and the estimator's own dead zone (the t=0 cusp) is wider
still at ~0.25°, so straight books are untouched: **532/532 deathstalker book-1 pages read 0.000°
and produced byte-identical bands.**

## PDFelement dossier (reverse-engineered Jul 31 2026)

- **Single-threaded CPU engine.** powermetrics during a run: ANE 0 mW, GPU idle-frequency only,
  one P-core pegged; ~43 min CPU time over a ~45 min job. ~1 GB RSS (4.3 GB with two languages).
- **No language model**: it emitted `D€RTHSTRLK€R` 98× (457 mangled running heads in ~15
  spellings) — a glyph classifier with no language prior would; an LLM never would.
- **Per-language packs**: English+German ≈ 2× slower than English-only. Always convert English-only.
- The 99%-stall at the end (5–10 min) is book-global font matching/synthesis + searchable-PDF
  assembly — a deliverable we don't produce, so we never pay it.
- Its "font family" output is nearest-common-font (Times/Arial), not identification.
- Its searchable-PDF text layer does NOT carry its UI's block grouping (mupdf sees one block/page).
- Gold for body text; NOT gold for decorative type (excluded from scoring by furniture font
  ArialMT@7 + €-salad checks).

## Truth corpus (`/Volumes/Callisto/training/ocr-lab/gold/` + `manifest.json`)

19 books staged; `manifest.json` records per-book provenance + truthTier:
**tier 1** exact/definitive (owner's 3 authored born-digital books, himmler [publisher EPUB,
linked footnotes — the crown jewel: real scan + exact truth], michelle remembers, what-to-expect
×2 [NB the `What to Expect When Youre Expecting` folder is actually **What to Expect the First
Year, 3rd ed. 2014** — PDF and EPUB agree so measurements stand; folder name + `gold/manifest.json`
are mislabeled], rise-and-fall [Calibre render, Computer Modern — degradation-ladder feedstock,
NOT a scan]);
**tier 2** dual-OCR agreement (deathstalker series ×8 — EPUBs are OCR-derived but clean, same
edition; only BOOK 1 has "page N" markers, and they are the *ebook's* pagination [650 marker
pages vs 532 printed] — NOT usable as print-page anchors);
**tier 3** PDFelement-only, trust-gated (nuremberg, transitional justice, soul of the people).

Trust gating is per-LINE, evidence-based, never by type: repetition self-validation for running
heads, EPUB agreement promotes to gold, dictionary/symbol sanity for the tail. German vocabulary
(Third Reich books) must never be "corrected" into English — soft priors only, edits gated on
OCR evidence (the footnote-marker applier lesson).

**Teacher chain** for no-EPUB books: PDFelement → cogito:14b through `cli/ai-clean.js`
**edit-list lane** (`--stages ocr`) — the guarded applier makes untargeted text structurally
untouchable; rewrite lanes only gate gross truncation (<70%) and CAN silently drop a sentence,
so never use them for label minting. Calibrate the chain once on deathstalker vs EPUB truth.

Downloads probe (12 more PDFs, `~/Downloads/pdfs/`): 2 born-digital (Braune=InDesign,
Zundel=PrinceXML — free tier 1), 3 with ABBYY layers already (hypnosis, twisted cross,
**october fifteenth 1957 — the only pre-1960 book**; ABBYY ≈ PDFelement class, usable as tier 3
directly), 6 IA/Adobe-layer scans where PDFelement conversion actually buys truth. Two IA books
are LuraDocument-recoded (JBIG2-style glyph substitution risk — treat as a degradation class).

## Rules that must not regress

- Training pairs' INPUT side comes from the NEW pipeline's own output (ocr learns this
  pipeline's error distribution, not old whole-page Tesseract's). Old journals are measurement-only.
- Hold out books before any training (≥1 fiction + 1 nonfiction ocr never sees).
- Eval only against tier-1 truth or hand-checked pages, never teacher-only.
- Aligners must handle transposed footnotes (order-free rescue) or they fake ~1.1% missing (4.5×
  the true rate on michelle remembers). Never force a match; unmatched → no pair.
- EPUB "page N" markers: exploit as anchors, exclude from pairs, don't pre-strip.
- **Hyphenation is a JOIN, never a completion** (owner decision, Aug 1 2026). A line-level
  corrector must never invent the far half of a word it cannot see — that is the hallucinated-
  completion failure the footnote-marker applier already taught us (`after` must be a subsequence of
  `before`). So: line-level truth keeps the fragment as the page prints it (`per-` stays `per-`),
  and the join happens deterministically at band→block grouping, where BOTH halves are in hand
  and the result is knowledge rather than a guess. Where the partner half is off-page (hyphen on
  a page's last line), resolve it across the page boundary so the joiner still *knows* the whole
  word — never leave it dangling and never let the model fill it in. Reverses the sweep's
  provisional convention (844 pairs on deathstalker book 1 asked ocr to expand `per-` →
  `performance."`); needs a `build_ocr` change in `align-epub.py` before the next pair mint.

## Open fixes / next steps (ordered)

1. **TS port into the app**: `sharp` decodes renders; new engine id `tesseract-bands` through the
   existing `engine` string seam (headless-ocr → corpus-ocr-run → OCR settings modal); output
   conforms to `OcrResult` (bands→textLines, deterministic merger→paragraphs) so classifier/
   training page work unchanged; 1 tesseract process/page. Design settled Jul 31, not built.
2. Boxed text (ruled boxes defeat projection; What-to-Expect sidebars will hit this constantly —
   detect/erase box rules pre-profiling). **Two-column gutter detection** (WTE's real damage:
   `find_gutter` needs a ≤3 px-ink stripe, but grey-paper gutters carry 4–11 px + a printed rule,
   so 12/708 + 4/532 pages read interleaved — shuffled, not lost; a page-derived noise floor finds
   the gutter on 32/40 test pages vs 0/40 shipped — build with box-rule erasure). Reversed type
   (invert-retry dark bands). Halftone-adjacent captions. Tighten tall-band flag (merges seen at
   1.7–1.9× vs 2.5× threshold). ~~Deskew~~ **DONE Aug 1 2026** — see *Page deskew* below.
3. Aligner across the corpus → pair minting with per-book truth tiers. **DONE Aug 1 2026**:
   11 scanned books / 6,201 pages swept → 227,423 pairs (192,778 at sim ≥0.75); truth-side fixes
   alone moved corpus CER 0.0468→0.0350, byte-exact 43.5%→61.0%; report in
   `<lab>/sweep-report.md`.
4. **foundry-ocr-v1** (0.6b-class line corrector; GPU offered but training ALWAYS needs an explicit
   green light — shared GPU, faulty fan). v1.5 option: fine-tuned Tesseract `.traineddata`
   (tesstrain) from the same pairs — drop-in, no fork, test before building the v2 custom recognizer.
5. Deferred: paragraph-detection model (deterministic rules first), glyph-clustering consistency
   signal (fixes display-type class), CoreML/ONNX custom recognizer (v2, only if ocr plateaus).

## Measurement gotchas (each cost real time once)

- PDFelement reference geometry drifts per page (CropBox): fit origin/scale per page (ICP) or
  fabricate ~2,300 phantom misses. `score.py` does this; `--no-align` reproduces the raw numbers.
- Corpus `blocks.json` x/y/w/h are 72dpi POINTS; journal `textLines[].bbox` are 200dpi PIXELS.
- iCloud (`~/Documents`) spawns conflict copies (`page-180 2.json`) and returns empty on fresh
  reads — exact filenames only, retry ×3. Consider moving ocr-lab out of iCloud.
- This scan's paper is grey (bg ~157, ink ~22–34): ink thresholds near 100, not 200.
- Reference stext chars are XML entities — real XML parse only, or apostrophes vanish and
  PDFelement gets blamed for errors it didn't make.
- mutool page output is 1-indexed; everything in ocr-lab is 0-indexed (`page-N` = PDF page N+1).
