# OCR Lab — the band pipeline and the road to galley

**Goal** (owner's words, Jul 2026): *"make ours ultimately as good as pdfelement's… we can work
with mangled/jumbled. we cannot work with missing."* Missing text is the fatal class; mangled
text is repairable downstream.

**Status (Aug 2026): architecture settled and measured.** The band pipeline beats the shipping
whole-page-Tesseract path on every axis, beats PDFelement on speed by 5–8×, and out-reads it on
decorative type. What remains is productization (TypeScript port into the app) and the correction
model (**galley**).

## The pipeline

```
render 200dpi → border/edge masking → (XY-cut if columns) → projection-profile BANDS
             → per-line Tesseract --psm 7 (batched: ONE process per page, image list / TSV,
               empty→ retry --psm 13) → [galley line correction — NOT BUILT YET]
             → deterministic band→block grouping (pitch/indent/gap) → rubric
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

Data per book: `~/Documents/BookForge/ocr-lab/<book>/{renders,bands,ocr-bands,reference,scores}/`.

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

## Truth corpus (`~/Documents/BookForge/ocr-lab/gold/` + `manifest.json`)

19 books staged; `manifest.json` records per-book provenance + truthTier:
**tier 1** exact/definitive (owner's 3 authored born-digital books, himmler [publisher EPUB,
linked footnotes — the crown jewel: real scan + exact truth], michelle remembers, what-to-expect
×2, rise-and-fall [Calibre render, Computer Modern — degradation-ladder feedstock, NOT a scan]);
**tier 2** dual-OCR agreement (deathstalker series ×8 — EPUBs are OCR-derived but clean, with
"page N" markers = per-page alignment anchors, same edition);
**tier 3** PDFelement-only, trust-gated (nuremberg, transitional justice, soul of the people).

Trust gating is per-LINE, evidence-based, never by type: repetition self-validation for running
heads, EPUB agreement promotes to gold, dictionary/symbol sanity for the tail. German vocabulary
(Third Reich books) must never be "corrected" into English — soft priors only, edits gated on
OCR evidence (the dagger applier lesson).

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

- Training pairs' INPUT side comes from the NEW pipeline's own output (galley learns this
  pipeline's error distribution, not old whole-page Tesseract's). Old journals are measurement-only.
- Hold out books before any training (≥1 fiction + 1 nonfiction galley never sees).
- Eval only against tier-1 truth or hand-checked pages, never teacher-only.
- Aligners must handle transposed footnotes (order-free rescue) or they fake ~1.1% missing (4.5×
  the true rate on michelle remembers). Never force a match; unmatched → no pair.
- EPUB "page N" markers: exploit as anchors, exclude from pairs, don't pre-strip.

## Open fixes / next steps (ordered)

1. **TS port into the app**: `sharp` decodes renders; new engine id `tesseract-bands` through the
   existing `engine` string seam (headless-ocr → corpus-ocr-run → OCR settings modal); output
   conforms to `OcrResult` (bands→textLines, deterministic merger→paragraphs) so classifier/
   training page work unchanged; 1 tesseract process/page. Design settled Jul 31, not built.
2. Boxed text (ruled boxes defeat projection; What-to-Expect sidebars will hit this constantly —
   detect/erase box rules pre-profiling). Reversed type (invert-retry dark bands). Halftone-adjacent
   captions. Tighten tall-band flag (merges seen at 1.7–1.9× vs 2.5× threshold).
3. Aligner across the corpus → pair minting with per-book truth tiers.
4. **galley-v1** (0.6b-class line corrector; GPU offered but training ALWAYS needs an explicit
   green light — shared GPU, faulty fan). v1.5 option: fine-tuned Tesseract `.traineddata`
   (tesstrain) from the same pairs — drop-in, no fork, test before building the v2 custom recognizer.
5. Deferred: paragraph-detection model (deterministic rules first), glyph-clustering consistency
   signal (fixes display-type class), CoreML/ONNX custom recognizer (v2, only if galley plateaus).

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
