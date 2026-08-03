# Blocks — training briefing

**Current state as of Jul 30 2026.** Read this before touching the corpus, the
labelling flow, or a training run. It is a *state* document, not a log — the
chronological history lives in the `category-model-training` memory.

**Naming.** This model was called **rubric** until Aug 2026 (and `blockcat`
before that); it is now the **blocks** stage of foundry, published as
`foundry-blocks-v<release>-<size>`. Its two siblings were renamed at the same
time: *galley* → **ocr**, *dagger* → **footnotes**. Older run names, eval JSON
filenames and the corpus directories on disk still carry the old words — those
are recorded artifacts, not instructions, and nothing renames them.

**The release number is not the prompt version.** `foundry-blocks-v1-4b` is
release 1 carrying the **v5 prompt**. The prompt format is declared in the
catalogs (`promptVersion`), never parsed out of an id — see
`electron/blocks-models.ts` and `tools/aligner/blocks-publish.sh`.

Blocks labels every text block on a page with what it **is** (body, chapter
opening, running head, footnote, caption, table fragment, …). That drives EPUB
export: what gets narrated, what gets dropped, where chapters split. See
`CLAUDE.md` § "Blocks — the page-layout model" for the serving side.

Goal: hand-label enough books that the model generalizes to layouts it has never
seen. **Not** an OCR-correction model — categorization only.

---

## 1. Where everything lives

| What | Where | Synced? |
|---|---|---|
| **MASTER corpus** | `/Volumes/Callisto/training/rubric/` (Mac) | **No** — machine-local |
| Backups (many, keep them) | `/Volumes/Callisto/Shared/BookForge/training-corpus-backups/` | Yes (Syncthing) |
| Per-book labels | `training/{slug}/labels.json` | via backups |
| Aligned datasets | `training/aligned/{book}/dataset.jsonl` + `source.json` | via backups |
| Gathered corpus | `training/corpus/{train,eval}.jsonl` + `manifest.json` | via backups |
| Built SFT | `training/sft/{train,eval}.jsonl` + `build-stats.json` | via backups |
| v3 relabel overlay | `training/matter-relabel/` (49 files) | via backups |
| Toolchain | `tools/aligner/` (in-repo) | git |
| Training rig | owens-pc, 3090 Ti 24 GB, `C:\Users\tellt\Projects\orpheus-finetune` | git on that box |

### Storage policy (user, Jul 30 2026)

- **WSL is staging ground only.** Stage data into WSL before training (faster
  than `/mnt/c`), then **clear it after**. Nothing in WSL is authoritative.
- **The master lives outside WSL** — currently the Mac's `/Volumes/Callisto/training/rubric/`.
- **Keep many backups.** Take one before any destructive corpus operation
  (relabel, re-OCR, split change) and after any labelling session:
  ```bash
  tar czf /Volumes/Callisto/Shared/BookForge/training-corpus-backups/blocks-corpus-$(date +%F).tar.gz \
      --exclude='*/blocks.json' -C ~/Documents/BookForge training/
  ```
  `blocks.json` is excluded because it is re-derivable from the PDF (see §6);
  `labels.json` is not.

**The standing risk:** the hand-labelling is the expensive artifact and the
master copy is on one machine-local disk outside Syncthing. The backups above are
what mitigate that. Every source PDF is re-derivable (12 sessions record
`sourceFile`, aligned books record pdf+epub in `source.json`), so a loss costs
labelling time, not data.

---

## 2. Corpus state (measured Jul 30 2026)

**13 labelled books, 36,882 labelled blocks.** Plus 5 aligned datasets built from
EPUB↔PDF pairs.

Nuremberg is now the USER'S complete pass (Jul 30 2026: 5,381 labels via the
detect→correct loop, 97.4% model agreement, full error report below) — it
supersedes the 4,170-block agent session, retired beside it as
`labels.json.v3-agent-session-superseded`. First book through the full loop.

Built corpus: **14 books, 4,256 train / 613 eval pages** (37,222 train blocks,
6,002 eval blocks).

Eval split (hold out by BOOK, never by page): **twisted-cross, gene-sharp
(from-dictatorship), niemoller (evangelical-kirch)**. Niemöller is the only
German book, so the split trains on English and tests on German — a free check
that the model keys on layout, not language.

### Per-class support and book spread — the number that matters

| class | blocks | books | state |
|---|---|---|---|
| body | 9,708 | 12 | healthy |
| footnote | 9,167 | 13 | healthy |
| list | 8,410 | 11 | healthy |
| header | 2,115 | 11 | healthy |
| quote | 1,793 | 12 | healthy |
| footer | 1,542 | 10 | healthy |
| heading | 1,094 | 12 | healthy |
| image | 938 | 8 | healthy |
| caption | 780 | 10 | healthy |
| **table** | **431** | **4** | needs BOOKS |
| **chapter** | **388** | **13** | thin but alive (F1 .66) |
| **subheading** | **152** | **5** | needs EXAMPLES |
| **title** | **91** | **10** | needs EXAMPLES |

### Measured error profiles (what the model actually gets wrong)

- **Nuremberg, full user pass, held-out-equivalent** (never trained on): 136
  errors / 5,321 blocks (97.4% agreement). Top confusions: `heading→list` 83
  (source-note entries — short numbered flush lines), `image→caption` 27.
  Recall: body 99.9, header 99.8, footnote 99.8, list 95.9, quote 88.2 —
  but caption 50.9, image 59.3, chapter 72.7. Zero `subheading`/`table`/`title`
  ever emitted (dead classes).
- **Churches V2, replayed on a TRAIN book** (memorization ceiling): 181 / 1,516
  wrong even at the floor; the image/caption/footer triangle is 86 of 181;
  caption recall 19/59 on trained data. Tool: `tools/blocks-replay.js`.
- Reading: the weak classes on both lists are the corpus's starving classes.
  No new failure mode — push the book-spread lever.

Who carries the starving classes:

- `table` — Pohl 334, Niemöller 78, Satanic Panic 11, Churches V2 8
- `subheading` — Gospel of Lies 90, Gene Sharp 52, Holy Reich 7, Twisted Cross 2
- `title` — Soul 20, Churches V2 12, Twisted Cross 10, Niemöller 9, Pohl 8

### Books labelled but NOT in the built corpus

- **Animal Farm** — 398 blocks, OCR-source, v3-clean. Simply not gathered.
- **The Coming of the Third Reich** — 4,736 blocks, `blockSource: embedded`, and
  **273 labels still in the retired classes** (`front_matter`/`back_matter`/
  `footnote_ref`). Not v3-clean; needs relabelling before it can be gathered.
  Note its class mix is attractive (caption 295, heading 487, chapter 96).

### OCR'd, awaiting labels (5 books)

`bonhoeffer-ethics` (10,787) · `deliverance-handbook` (673) ·
`hungarys-admiral-on-horseback` (4,034) · `siege-of-budapest` (6,013) ·
`unspeakable-truths`

The first four were OCR'd Jul 30 2026 and then RE-OCR'd the same night with the
split-only refined segmentation (21,507 blocks / 1,651 pages) — geometry
verified, zero blocks past a page edge, confidence median 0.93–0.95, no dropped
pages. `deliverance-handbook` was picked specifically for tables and lists, and
its bulleted lists now arrive one item per block.

---

## 3. Model state

**Shipping: `blocks-v3-4b`** (Qwen3-4B QLoRA, Q4_K_M GGUF, 2.5 GB), served by the
bundled llama-server on `/completion`. Distribution details in `CLAUDE.md`.

Scores on the 613-page held-out eval (trainer-side harness):

| | block acc | macro-F1 | exact pages |
|---|---|---|---|
| **Qwen3-4B** | 0.8032 | **0.5116** | 0.3670 |
| Qwen3-0.6B | 0.7544 | 0.4091 | — |

+0.10 macro-F1 is ~8× the measured seed noise (±0.012), so the 4B win is real.
The 4B also shares a base with the planned OCR-corrector.

Per-class F1 (4B): footnote .926, body .874, list .836, header .779, footer .722,
chapter .658, quote .568, heading .479, image .304, caption .303, title .200,
**table .000, subheading .000**.

**Always quote macro-F1, never micro accuracy** — body/footnote/list are most of
the blocks, so micro is propped up by the easy classes. And never judge by
`eval_loss`: loss covers only assistant tokens, and the block IDs ("1 ", "2 ", …)
are deterministic counting the model nails instantly.

**Format is solved.** 0 unparseable lines, 0 missing blocks, 0 illegal
categories, on both model sizes, from epoch 1. Every remaining error is category
confusion — a *feature/data* problem, not a contract problem. More epochs cannot
invent features.

---

## 4. THE LEVER: book spread beats example count

This is the central measured finding. Do not re-litigate it.

> `table` has 345 examples in **2** books → F1 **0.00**.
> `chapter` has 342 examples in **10** books → F1 **0.42**.
> Same count. 5× the spread. One learns, the other never does.

Pohl was book 3 in the learning-curve ordering, so its 334 tables were present at
every point (n=3, 6, 10) and `table` F1 never left zero. More pages of one book's
tables cannot teach another book's typography.

**Threshold: a class is alive at ≥500 examples across ≥5 books.** Everything
above that line is alive; everything below is dead or dying.

Learning curve (0.6B, 1 epoch, eval fixed to the 3 held-out books):

| train books | pages | block acc | macro-F1 | gain/book |
|---|---|---|---|---|
| 3 | 1,480 | 0.4007 | 0.1529 | — |
| 6 | 2,732 | 0.5896 | 0.2956 | +0.0476 |
| 10 | 3,806 | 0.7544 | 0.4091 | +0.0284 |

Still climbing at ~+0.028 macro-F1 per marginal book → ~10 more books of similar
character projects to roughly **0.65–0.70**. Worth the labelling. (Caveat: book
count and page count vary together here, so this curve alone does not isolate
diversity from volume; the table-vs-chapter comparison above does.)

**LABELLING TARGET: ~10 more books chosen so `table`, `subheading`, `caption` and
`title` each appear in ≥5 of them.** Volume from a single big book is the wrong
medicine.

Three distinct failure modes, do not confuse them:
- too few **books** → `table`, `subheading`
- too few **examples anywhere** → `title`
- healthy → everything ≥500 examples in ≥5 books

---

## 5. Settled decisions — do not re-propose

- **Tesseract is the only segmenter** in the labelling/classification path,
  whatever the source (born-digital, scan, DjVu, images). The classifier trains on
  Tesseract paragraph boundaries so it must be *served* them — anything else is a
  train/serve mismatch on the most basic feature there is, what counts as a block.
  Text for the final EPUB/TTS can still come from the embedded layer, bridged by
  containment mapping. *Rejected:* a `src=ocr|embedded` feature — it splits an
  already-starving corpus to avoid an OCR pass. *Also rejected (Jul 30):* neural
  layout systems (PP-Structure, DocLayout-YOLO, Surya) — they solve the semantic
  problem blocks already owns, at the cost of a heavy dependency and a second
  segmenter.
- **Tesseract is a LINE detector; block formation is ours (Jul 30 2026, e1fdfec).**
  Its line boxes are reliable; its paragraph *grouping* is not (it welds list runs
  and heading+paragraph into single blocks). `shared/ocr/ocr-post-processing.ts`
  refines split-only: a Tesseract paragraph boundary is never crossed (so every
  block nests inside one raw paragraph — containment transfer stays lossless), but
  within a paragraph three eager signals cut: gap > max(1.6×, +3pt) of the
  **book-wide** median within-par line gap, font-size step > 1.25×, bold flip.
  False split = cheap (same label twice); false merge = a block with no correct
  label. `blocks.json` and `manifest.editor.ocrBlocks` now carry the SAME blocks.
  Known gap: two items Tesseract reads as one LINE (side-by-side columns) need
  word-box x-gaps — parseHocr sees and discards them; same data the `table`
  column-run feature needs.
- **Split-only has exactly ONE exception: the display-run merge (Aug 2 2026).**
  Owner-directed, and it is the one shape where the asymmetry above does not
  apply. A chapter opening is cut into a tracked `CHAPTER 1` kicker, the title
  over two or three lines, sometimes a subtitle; every piece has the SAME correct
  label, so merging them removes a redundant label rather than manufacturing a
  block with no correct one. `shared/ocr/display-run-merge.ts` rejoins them, and
  runs between grouping and categorization so a heading is categorized as the
  heading it is. Adjacency is intervening content, NOT distance: a heading at the
  top of a page and one at the bottom with nothing between them is one heading
  that owns the page; heading / body / heading is two.
  - The same file is checked in VERBATIM in foundry at
    `src/blocks/display-run-merge.ts`, where it runs before the blocks model
    classifies anything, and `display-run-merge.fixture.json` is checked into
    both repos with a test each side. Corpus and inference must be segmented
    identically or the model is trained on one thing and served another.
  - Corpus-side the applier
    (`training/rubric/merge-experiment/apply_merge_inplace.py`) adds a LABEL GATE
    on top of the geometry — merge only where every member already carries the
    same human label and it is `title` or `chapter`. Inference has no gate,
    deliberately: training data must never launder a label disagreement, and
    inference has nothing to launder.
  - **It crosses Tesseract paragraph boundaries**, which the split-only rule
    above never did, so a merged heading's box is the union of two raw paragraphs
    plus the white space between them. Containment transfer still maps, but
    "every block nests inside one raw paragraph" is no longer true of display
    runs specifically. It is true of everything else.
  - Tuned against the corpus-wide LABEL CONFLICT count, which is the accept/
    reject number for any change: 59 units / 5 conflicts before, **114 units /
    175 blocks swallowed / 10 conflicts** after. Of the 10, four are unlabelled
    collage pages in Satanic Panic, five are stale labels on the punch list, and
    one is genuine (Hitler's Priests p222, an OCR-inflated first body line that
    reads as display). *Rejected, measured:* a generic "any short sub-display
    line may join" companion instead of the all-capitals kicker — it merged
    table-of-contents and index rows into their `Contents` and `Index` headings
    and took conflicts from 10 to 52. *Also rejected:* moving the 1.3x display
    floor (1.2/1.25/1.35/1.4 all traded worse).
- **Block IDs are deterministic** (page + index + geometry/text hash — verified
  identical across independent runs). An identical re-OCR no longer orphans
  labels; a *changed* segmentation changes the hash, so stale labels miss instead
  of silently mismatching. Blocks keep `line_boxes`, so under-segmented stragglers
  can be split in-app (`tools/split-ocr-block.js` covers old projects).
- **Tesseract is exactly reproducible** (measured: 206/206 identical bboxes and
  text on a 20-page re-run at `--dpi 200`; 673/673 identical ids on a full-book
  re-run). The one thing that must be pinned is **OCR render DPI = 200**.
- **fsize is a RATIO to the book's modal size, never raw.** Modal body size
  across the corpus runs 7→16 (2.3×), driven by scan DPI, not typography.
- **Integer encoding is essential.** Decimals cost 3–4 tokens each; whole-percent
  integers cut a 8,199-token page to 6,529 while carrying more features.
- **Headings are CENTRED, not indented** (66% centred). Send left-inset + width +
  signed-centre-offset (three of the four quantities — they have only two degrees
  of freedom).
- **1 epoch is the default.** Three runs out of three peaked at epoch 1.
- **Class-prior percentages in the prompt** — rejected. Every other feature is
  computable label-free at inference; a class prior is not. Static is constant
  across examples (no gradient); per-book is circular and would entrench the dead
  classes.
- **Fiction dialogue is `body`, not `quote`.** `quote` is *typographic* here
  (inset both sides / smaller type / block shape). Novel dialogue is typeset like
  body; labelling it `quote` would contradict all 2,184 existing examples.
- **Abbreviations → `table`** — tried, measured worse (macro-F1 0.409→0.374, ~3× seed
  noise, and `image` collapsed to 0.000 in both seeds), **reverted**. Abbreviation
  apparatus is `list`. `LABELING.md`'s rule text describes the rejected experiment.
- **Neighbour LABELS as a feature** — rejected; they vanish at inference.
  Transitions are already learned free via the autoregressive target.
- The heuristic post-processor's own categories are **irrelevant** to training —
  they are a starting paint that the human corrects. Expect `caption` to be badly
  over-fired in footnote-heavy books and `list`/`table` to be absent entirely; the
  heuristic cannot emit them. This is the reason the model exists.

---

## 6. How a book becomes training data

```bash
# 1. OCR it — writes blocks.json (corpus shape) AND manifest.editor.ocrBlocks
#    (so it opens already-OCR'd in Label mode). Verifies source PDF by sha256.
node --require cli/electron-stub.js cli/ocr-pdf.js "<book.pdf>" \
     --project "<projects/{slug}>" --out /Volumes/Callisto/training/rubric/{slug} --jobs 8

# 2. Label it in the pdf-picker (rail mode "Label"), then "Export training data"
#    → writes labels.json + dataset.jsonl to training/{slug}/

# 3. Gather + build
node tools/aligner/gather-corpus.mjs
node tools/aligner/build-sft-dataset.mjs

# 4. Stage to WSL, train, CLEAR THE STAGING AFTER
#    THE GPU MAY BE BUSY — the 3090 runs other jobs (voice training, etc.).
#    Check before launching (nvidia-smi via ssh owens-pc; idle ≈2.4 GB used),
#    and NEVER start a training run without the user's explicit green light.
#    HEAT: the box has a faulty fan. Watch GPU temp during the run (~82°C is
#    normal); at ≥86°C throttle NOW: nvidia-smi -pl 270, then 220 if still hot.
#
#    Staging: pipe stdin through ssh (PowerShell quoting mangles anything inline)
#    and verify sha256sum on both sides:
cat train.jsonl | ssh owens-pc "wsl -e bash -lc 'cat > ~/training_data/block_categorize/train.jsonl'"
#
#    Launch (three pitfalls baked in: conda is NOT on the wsl login PATH; the
#    training env is orpheus_train, not orpheus_ft; global options go BEFORE
#    the `train` subcommand). Run it as a BACKGROUND task so the ssh handle
#    stays alive — WSL kills detached descendants. NO --merge (merge on the Mac).
ssh owens-pc "wsl -e bash -lc 'source ~/anaconda3/etc/profile.d/conda.sh && \
  conda activate orpheus_train && cd /mnt/c/Users/tellt/Projects/orpheus-finetune && \
  PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python orpheus_owen.py \
  --profile blocks_v4 \
  --train-data ~/training_data/block_categorize/train.jsonl \
  --eval-data  ~/training_data/block_categorize/eval.jsonl \
  --run-name blocks_v4 --out-base /home/telltale/xtts_ft train \
  2>&1 | tee ~/training_data/block_categorize/train_v4.log'"

# 5. Publish (on the Mac — needs llama.cpp + the HF token)
tools/aligner/blocks-publish.sh v4-4b ~/blocks-export/blocks-v4-4b-merged
```

**Block IDs are deterministic as of Jul 30 2026** (page + index + geometry/text
hash). An identical re-OCR reproduces identical IDs, so labels survive re-runs.
A re-OCR after a *segmentation code change* still re-mints (the hash moves), so
finish labelling — or export — before upgrading the post-processor on a book
mid-flight. Books OCR'd before Jul 30 carry the old random-suffix IDs until
re-OCR'd.

The headless Detect loop (see the CLIs): `cli/blocks-detect.js` paints a project
with model predictions and snapshots the run immutably in
`editor.blocksPredictions`; a human corrects in the picker (corrections are
inviolable — Detect never repaints them); `cli/blocks-report.js` diffs run vs
corrections into a confusion table. Run detect with the book CLOSED — the picker
overwrites `editor.ocrBlocks` on save.

---

## 7. Open items

- **`saveSession` refuses to overwrite an existing `labels.json`** by design, so
  corrections to the 12 archived books never reach the corpus — it reports
  `written:false` and the export continues, which *looks* like it worked. Combined
  with `importTrainingLabelsOnce` matching by block ID only and running only for a
  project with zero labels, existing books cannot be edited in the app. User's
  position Jul 29: the archived books are trusted and don't need editing, so this
  is not urgent.
- **Third Reich needs a v3 relabel** (273 retired-class labels) before it can be
  gathered; Animal Farm just needs gathering.
- **Title-page convention is position-dependent** and the user flagged it: the same
  publisher line is `title` on the title page and `body` on the copyright page —
  the `front_matter` mistake in miniature. Proposed fix (NOT applied, user's
  call): `title` means display type standing alone; publisher/city/year → `body`
  everywhere. ~15 of 96 title blocks. Cannot yet tell whether title's low F1 is
  this heterogeneity or just 96 examples.
- **Free feature sitting unused:** `parseHocr` already reads every *word's*
  bounding box and discards them, keeping only the paragraph bbox. Per-line x-runs
  are exactly the structural `table` signal the v1 post-mortem asked for, and
  line-end fill ratio comes from the same data. No re-OCR, no flag change.
- **`image` cannot be learned from an image-only page** — Tesseract emits no block
  for a bare photo, so such pages produce nothing to label. The corpus's 893
  `image` blocks come from figures on text pages and scanner "Blank Page" stamps.
  Books whose figures are full-page plates add no `image` support.
- **LightGBM baseline on the Mac** — still unbuilt. Its confusion matrix was meant
  to decide which books/classes need data; the learning-curve work has largely
  answered that instead.
- **`continues` (paragraph-boundary) second head** — still unbuilt.
- Two labelled books are `blockSource: embedded` (Churches V2, Third Reich) and so
  sit outside the Tesseract-canonical decision. Coarse→fine transfer by
  containment is well-defined; they need an OCR pass and a containment map, not
  relabelling.

---

## 8. Measurement discipline

- **Seed noise floor is ±0.012 macro-F1.** Distrust single-run deltas under ~0.05.
  A fixed seed does *not* make data-edit comparisons valid — a 0.24% label edit
  once swung macro-F1 by 0.035 and collapsed `image` to 0.00.
- **Score the artifact you ship.** The merged f16 GGUF scored 78.8% / 0.494 where
  the trainer-side NF4 harness scored 75.4% / 0.409 on the same eval — deployed was
  slightly *better* (f16 is closer to the bf16 it trained in). Same dead classes,
  same confusion signature: the merge/convert round trip is faithful.
- **Testing on a training book is legitimate provided it is called what it is.**
  The 0.6B hit 0.806 macro-F1 on a book it trained on vs 0.494 held out — that is a
  memorization ceiling, and it proves capacity is not the constraint.
- `trainer_state.json` is authoritative, never the log tail — stdout is
  block-buffered and lags ~1 epoch behind tqdm's unbuffered stderr.

---

## 9. The sibling models — goals and plans

Blocks is one of three models that together turn a PDF into a clean, reflowed,
TTS-ready EPUB. The full pipeline, with each piece's status:

```
PDF → Tesseract lines → block formation (split-only refinement — SHIPPED e1fdfec)
    → BLOCKS: classify every block            (v4 training / shipping)
    → drop furniture, structure from labels   (headers/footers out; chapters,
                                               quotes, lists from label runs)
    → paragraph reflow                        (blocks v5 `continues` head — planned)
    → MARKER REMOVAL: strip footnote refs     (0.6B — corpus v1 BUILT)
    → OCR CORRECTION: fix the characters      (Qwen3-4B — designed)
    → EPUB with the book's real structure → TTS
```

The end goal, stated once: **a PDF in, a beautiful reflowed EPUB out** — original
paragraph breaks restored, footnote clutter gone, OCR garble repaired, chapters
and quotes structurally real so TTS reads a book, not a page scan.

### 9a. `dagger` — the footnote-marker remover (0.6B), trained Jul 30 2026

> **RETIRED.** Superseded by foundry's `footnotes` stage
> (`foundry-footnotes-v1-4b`, a 4B adapter on `foundry:4b`). The 0.6B weights,
> their HuggingFace repo, their downloader and their in-app server were all
> removed from BookForge in Aug 2026; the corpus below still lives at
> `training/dagger/` and is what a retrain would start from. Everything from
> here to the end of §9a is a record of that run, not an instruction.

**Goal:** delete inline footnote reference markers from block text — and nothing
else. Markers are sequential numbers, romans, letters, or symbols (`* † ‡`),
sometimes grouped ("…Auschwitz. 1,2,3"), sometimes block-leading, and after OCR
they are **punctuation soup**: measured across 2,242 EPUB-verified markers, only
~2% of numeric markers survive as recognizable digits. Per-digit garble map:
1→`*`/`!`/`'`, 0→`°`, 2→`?`, 6→`®`, 8→`®`/`8`, two-digit numbers become
two-char punctuation runs (`*°`, `!?`). Even `*` cues survive as an asterisk
only 61% of the time — and print cycles `* † ‡` where the EPUB says asterisk,
so EPUB surface ≠ print surface. Inventory: `dagger/garble-inventory.json`.

**Output contract (decided — this is what makes 0.6B sufficient):** the model
emits DELETIONS, never rewritten text: one `<anchor+marker> → <anchor>` line per
marker, or `none`. A deterministic applier executes them; a left-hand string not
found verbatim in the block is REJECTED and flagged. The model cannot corrupt
text it cannot quote. Failure mode becomes "missed a marker" (visible,
recoverable), never "silently altered text". Ships unquantized (0.6B precedent:
1.2 GB is not worth a lossy step, and exact quoting is the whole contract).

**Training data — how it was created (reproducible: `dagger/build_corpus.py`):**
1. Parse the 5 aligned books' EPUBs; strip `epub:type="noteref"` elements
   (including wrapping `footnote-cue` spans) → clean truth + marker sites with
   anchors.
2. Match OCR blocks to EPUB paragraphs by normalized text (measured 99.4%).
3. At each marker site, diff the EPUB gap against the OCR gap with quote/dash
   folding, take PURE INSERTIONS only → the garbled marker substring, quoted
   verbatim from OCR. (Folding is what distinguishes a real closing quote from
   a marker in `existence.”’` — keep the `”`, delete the `’`.)
4. Validate every row: applying its deletions must strictly reduce edit distance
   to the clean truth. Failures → quarantine (rate: 0.35%).
5. Negatives: matched marker-free blocks rich in lookalikes (years, list
   numbers, `p.105 6`, citation runs) → target `none`. Blocks whose only marker
   Tesseract DROPPED are excluded from negatives (teaching `none` there teaches
   under-detection).
6. The 400-char dataset cap was healed from same-run blocks.json (markers
   cluster at paragraph ends; the cap was eating 43% of supervision).

**Corpus v1:** `dagger/sft/{train,eval}.jsonl` — train 2,598 rows
(1,569 pos / 1,029 neg), eval 190 rows (was-hitler-an-atheist, whole book held
out). 1,915 markers recovered = 85% of all EPUB markers; the missing 9% were
dropped by Tesseract entirely (that is the task ceiling, not an error).

**Train against:** `text_sft` chat-JSONL, assistant-only loss, bf16 LoRA (plain,
not QLoRA — same recipe as blockcat_small). Judge by deletion
precision/recall + false-fire rate on negatives, NEVER loss. The known
shortcut risk: markers cluster after sentence-final punctuation, so a lazy model
learns "delete trailing junk after a period" — the `existence.”’`-style rows
where a real quote must survive are the discriminator to watch.

**Known gaps / next data:** train prose is one book in three coats
(gods-people ×3 = 1,544 of 1,569 positives) + understanding-jw; eval is thin
(95 positives). Highest-value add: markers from a genuinely different book —
Ethics (embedded text layer + real footnote apparatus) is minable by the same
EPUB-free method as §9b. Tier-2 truth for scan-only books: the footnote-sequence
oracle with an ORDERED-cursor matcher (markers appear in note order;
anchor+LIS-style alignment — an any-number-in-any-run lookup was measured to
swing between 300 found (digit-only floor) and 344k (permissive ceiling), so
ordering is load-bearing). Legal inference-time features: blocks labels (list
blocks keep their numbers) and the chapter's expected next markers.

### 9b. `ocr` — the OCR corrector (Qwen3-4B, 16-bit), designed Jul 30 2026

Named for the ocr proof: in printing, a ocr is the tray holding set type,
and the ocr proof is the first impression pulled so a corrector can mark
errors before the forme is locked up. Reading a ocr to catch what went wrong
in setting is the same job as reading OCR to catch what went wrong in scanning.

The three models were originally named for a concrete object from the printing
and manuscript tradition, naming the thing each works on: `rubric` (the heading,
historically inked red), `dagger` (`†`, the footnote reference mark), `galley`
(the proof you correct). Aug 2026 replaced that convention with the plain job
name — `blocks`, `footnotes`, `ocr` — because the models moved into foundry,
where a stage's name is what a user types. Ids carry stage, release and base
size: `foundry-ocr-v1-4b`. The RELEASE is not the prompt version; the catalogs
declare `promptVersion` and nothing parses it out of an id.

**Goal:** fix Tesseract's character errors ("bistory"→"history", `™`→nothing or
the right letter, umlaut damage) without touching anything that is already
right.

**Training data — where truth comes free (start with these 8, zero labelling):**
- The **5 aligned EPUB pairs** (matching proven at 98.8–99.9%).
- The **4 embedded-text-layer books** (Ethics, Admiral, Budapest, Deliverance):
  the PDF's own text layer is the truth, geometrically aligned to the same
  pages Tesseract read. Both sides already on disk from the Jul 30 re-OCR.
- Book count: measure the learning curve (the blocks method, §4) rather than
  guess; expect 10–15. The lever is DIVERSITY OF DEGRADATION, not volume — a
  noisy tinted scan in an old typeface teaches error distributions a clean
  Vellum PDF cannot.

**The 32B's role — auditor, never author.** Do not have a big model "clean" the
truth: LLM cleanup silently normalizes spelling and punctuation, which poisons
ground truth at the root. Its legitimate job is a one-time offline audit: flag
pairs where truth and OCR disagree in a way that looks like an ALIGNMENT error
rather than an OCR error, so bad pairs die before training.

**Restraint is trained, not hoped for:** the corpus must be heavy with IDENTITY
pairs — blocks whose OCR is already perfect, target unchanged — selected via
the OCR confidence scores. Same philosophy as the marker model's `none` rows.

**Output format:** edit-list first (`bistory → history` lines, same
deterministic applier, same cannot-corrupt property) — measured garble is
sparse on decent scans (97–99% of characters correct), so edits are few. If
eval shows dense-error blocks (bad scans) defeat the format, fall back to
full-text output for low-confidence blocks only. Unit = one block.

**Model/config:** Qwen3-4B — shares the base and the bundled llama-server with
blocks, one serving stack for both. Train in 16-bit (the rig's own `ocr_repair`
profile note is binding: "quantization costs character fidelity"); block-level
sequences are short, so bf16 LoRA fits the 3090 easily. Judge by CER/WER
reduction AND false-edit rate on identity pairs, never loss.

### 9c. Paragraph reflow — blocks v5's `continues` head

The "restore the book's real paragraphs" goal is a LAYOUT decision (indent,
gap-above, wrap-hyphen evidence, sentence state), which is blocks's feature
space — so it is the long-planned second head, not a new model. Ground truth is
free: project EPUB `<p>` boundaries (aligned books) and embedded-layer paragraph
boundaries onto OCR blocks → every adjacent block pair gets a true
joins/does-not-join bit. Reflow then falls out at EPUB build: join `continues`
blocks, heal wrap hyphens via `lineSeparator`'s preserved evidence, and emit
paragraphs, with chapters/quotes/lists structured from the labels.

**Build order once v4 ships and the 0.6B trains:** pair-mine the 8 books → 32B
audit pass → correction corpus with identity discipline → 4B/16-bit run — and in
parallel, project `<p>` boundaries so the `continues` head is ready for v5.
Every step reuses infrastructure validated Jul 30; nothing here needs inventing.

### 9d. `continues` design settled with the owner (Aug 1 2026) — geometry-fed, applier-guarded

Four decisions, made against the paragraph-flow trace of the same day (Tesseract's
`par` level is read then thrown away; export `<p>` boundaries come solely from the
editor's indent/gap heuristic; the plain Export path silently emits one `<p>` per
chapter when detection never ran):

1. **The encoder feeds the model the geometry as explicit per-block facts** —
   first-line indent in body-size units, gap-above in line-pitch units,
   previous-line-ends-short, previous-block-ends-in-wrap-hyphen — all measured
   from the band pipeline's deskewed per-line boxes. The model weighs soft
   evidence (flush-left styles, dialogue, poetry); it does not re-derive
   arithmetic from raw coordinates. This is a new prompt format ⇒ a new version
   id (v6), per the version-parsing contract.
2. **The near-certain rules live in the APPLIER, where the model cannot overrule
   them**: wrap hyphen on the previous block ⇒ continue (132/133 measured);
   category transition ⇒ break. The model only adjudicates the residue —
   body→body and quote→quote junctions, which the category head has already
   isolated (breaks only ever exist inside body text).
3. **TTS asymmetry sets both default biases, and they point in OPPOSITE
   directions by stage**: block formation splits when unsure (a fused
   footnote+body block has no correct label and leaks into narration; an
   over-split body paragraph is healed downstream), paragraph assembly merges
   when unsure (a missed break is a long prosody run — owner: fine; a false
   break is a mid-sentence pause — owner: the actual problem). Low-confidence
   `continues` output ⇒ merge.
4. **The block splitter rebuilds in the band pipeline** with measured ink
   geometry: band-height step (font size — footnotes ~70–85% of body, headings
   larger), pitch step (footnote leading is tighter), x-extent/centering for
   headings, book-relative thresholds calibrated against each book's own body
   lines. Tesseract's `par` boundaries stay as an ADVISORY corroboration signal,
   never the final grouping — its ink coordinates are good, its font attributes
   are measured-unreliable (§ traps).
5. **Calibration decides WHICH signal carries paragraph information, per book**
   (owner, Aug 1): books commit to indent style (first-line indent, no gap) or
   block style (flush left, blank-line gap) — the signals are nearly mutually
   exclusive, so a fixed formula dilutes the live one with the dead one. One
   pass over the book's band geometry classifies the convention (bimodal
   line-start x ⇒ indent; gap clustering at ~1.5× pitch ⇒ block), and the
   verdict is fed to the model as an explicit fact. **When neither signal
   exists (poorly formatted source), the pipeline degrades to few/no breaks,
   REPORTED loudly, and never fails** — owner's rule: too few paragraphs is
   fine for TTS, too many is the problem, and bad formatting must not break
   the run.

Chain: bands (lines) → geometric splitter + Tesseract corroboration (blocks) →
blocks v6 (category + `continues`) → applier rules (paragraphs) → export. Every
deterministic stage is fixture-testable; both biases compose because splitting
runs before labelling and merging runs after.

---

# 10. Session log — Jul 30 2026 (read this first after a compaction)

Everything below is measured or shipped, not planned. Commits: `dbc7137`
(dagger + detect-on-import), `8be40d6` (ebooks/), `d2e15ef` (ocr naming),
`be8919c` (label-check), `7a7e076` (corpus mode).

## 10a. What shipped

**blocks v4 is live and is the default.** Trained overnight (798 steps, 3h04m),
published as `blocks-v4-4b-Q8_0.gguf`, installed on Mac + Windows, catalog rank
40. Scored on the new 6,966-block eval **through the path users actually run**
(bundled llama-server):

| | v3 | v4 | delta |
|---|---|---|---|
| block accuracy | 76.00% | **85.20%** | +9.2 pt |
| macro-F1 | 0.4874 | **0.5453** | +0.058 |
| page-exact | 23.6% | **47.5%** | +23.9 pt |

sha256 `441a5c88737a5592661c44d7e9f5e8c2fd65bb87926944e76b3cb2472f0fbb48`,
4,280,405,344 bytes.

**dagger v1 shipped** (`dagger-v1-0.6b-f16.gguf`, HF `owenmorgan/bookforge-dagger`,
sha `cbe3cee888c92caa6a67a9084d8b9e6bc3324479e52d2601c54eda71a241bff3`,
1,198,182,784 bytes). Verified through the production server, not just Ollama:
**180/190 held-out blocks byte-identical to gold, 0 silent failures, 11s for the
whole set.** It replaced the deterministic footnote path in AI cleanup; the old
path is COMMENTED OUT, not deleted. No fallback — cleanup failed loudly if dagger
was absent.

> **Superseded Aug 2026.** Footnote-marker removal is foundry's `footnotes`
> pass. AI cleanup's TTS-prep stage keeps only the markers the source EPUB's own
> `<sup>` markup PROVES, removes nothing it cannot prove, and loads no model at
> all.

**Also shipped:** detect-layout prompt on PDF import (EPUBs never asked; a
born-digital PDF skips OCR and classifies immediately); `ebooks/` deprecated in
code (1,529 lines deleted, one copy of every book under `projects/`);
corpus-book mode (File → Open Corpus Book…, labels save to the book's own
`labels.json`, nothing enters the library).

## 10b. Three bugs found by testing, two fixed

1. **FIXED — `blocksVersionFor()` did not know v4**, so `blocks-v4-4b` fell
   through to v1 and would have been served the retired 16-class prompt. Adding
   a catalog entry ALWAYS needs the matching encoder branch first.
2. **FIXED — server context was 8192**, sized against v3's longest page (6,529
   tokens). v4's finer segmentation pushes the longest to 10,404, so dense pages
   were truncated from the END of the block list. Now 12288. Re-measure whenever
   segmentation changes.
3. **FIXED (6ea3329) — `getPageSizes` reported the MediaBox, mutool renders the
   CropBox.** On a cropped PDF the app thought the page was bigger than what was
   rasterised, so every categorisation threshold in `ocr-post-processing.ts`
   (all fractions of page height) was computed against the wrong page. Now
   prefers CropBox, falls back to MediaBox.

   **The blast radius was far smaller than twice estimated.** First it was
   written down as "~10% off on any cropped PDF" — a guess. Measuring `mutool
   pages` over all 18 corpus books gives **one** book where the boxes differ:
   Twisted Cross, 4.0% of width and 2.7% of height.

   Then the *consequence* turned out to be near-nil too. Twisted Cross's CropBox
   is a symmetric 9pt inset (`l=9 b=9 r=441 t=657` in a 450×666 MediaBox), so OCR
   inflated block coordinates by 450/432 in x and 666/648 in y — **and stored
   `pageDimensions` as 450×666.** Coordinate and denominator are inflated by the
   same per-axis factor, so `x/pageWidth` and `y/pageHeight` are exactly right.
   Every threshold in `ocr-post-processing.ts` is a fraction of page height and
   every encoder feature (`il`, `w`, `cx`, `t`, `fs`-vs-body) is a same-axis
   ratio, so all of them are invariant. **Its labels and features are sound; do
   not re-OCR it to "fix" them.**

   The fix still matters, for the case where OCR coordinates meet a source that
   uses the true CropBox — mupdf's embedded text layer — and for any future
   absolute-size feature. But it was never corrupting labels.

   Two lessons, both cheap: "affects every X" deserves a count, and a coordinate
   bug deserves the ratio worked through before anyone is told their data is bad.

## 10c. Measurement discipline learned the hard way

- **Q4_K_M is not free.** f16 → Q4 cost 0.029 macro-F1, 2.2 pts accuracy and
  **9.2 pts page-exact** — more than the entire v3→v4 gain. Q8_0 costs nothing
  measurable. `blocks-publish.sh` now takes the quant as an argument; decide it
  per release, never inherit.
- **Seed alone moves macro-F1 0.018 and small-class F1 ~0.2**, while accuracy
  and page-exact are seed-invariant (0.15 pt, 0.1 pt). **Decide runs on accuracy
  and page-exact; quote macro-F1 only to say WHICH classes are broken.** This
  also exonerates the Jul 29 91-block relabel — `image` collapsing was seed
  noise, not the edit.
- **eval_loss is useless here.** seed2 had the lower loss at every epoch and
  scored within noise of v4, while its loss got *worse* each epoch as v4's
  improved.
- **Label-run cascades.** One near-tie flipped a whole page (0/26 vs 23/26)
  because the model repeated its choice for 24 consecutive blocks. Washes out
  over 613 pages but makes any small slice untrustworthy — re-measure on the
  full split before concluding a path is broken.

## 10d. Corpus state and intent, per model

### blocks — 13 hand-labelled books, 57,652 blocks
Still starving: `table` F1 0.00, `subheading` 0.00, `caption` 0.24, `image` 0.24.

**New free channel: EPUB-derived labels.** Align OCR blocks to an independent
EPUB's markup (`<h3>`→subheading, `<figcaption>`→caption). Measured:

| book | blocks | labelled | rate |
|---|---|---|---|
| What to Expect | 4,544 | 4,349 | 95.7% |
| Deathstalker | 605 | 588 | 97.2% |

Only 43 pages each so far — **scales ~16× on full books.** Output at
`/Volumes/Callisto/training/rubric/epub-derived/<book>/dataset.jsonl`, in the
ALIGNED tier (derived, never human).

**`table` did not come from this book — but the earlier explanation of why was
wrong.** Corrected Jul 30 by opening the EPUB and counting. The claim had been
that the publisher reflowed printed tables into `<p class="box">`; that is false.
All 1,520 `box` paragraphs begin with a `•` — **1,520 of 1,520, zero exceptions,
zero body text among them.** `box` is a bulleted list item inside a sidebar, and
the deriver already maps it to `list` correctly. The book simply *has* one table:
its single `<table>` is the Apgar score in chapter05, marked up as a real table
with `tablea`/`table2` cells averaging 15 and 8 characters.

So the honest limit is narrower and more actionable: **this channel yields the
classes a given book contains, and What to Expect contains one table.** The fix
for starving `table` is to derive from books that HAVE tables, not to abandon the
channel. Before assuming a class is unreachable, count the tags:

```
unzip -q book.epub -d /tmp/x && cd /tmp/x
grep -oh 'class="[^"]*"' $(find . -name '*.*html') | sort | uniq -c | sort -rn
grep -c '<table' $(find . -name '*.*html')
```

The real EPUB limit is **layout the markup does not encode**: heading-vs-
`subheading` LEVEL, and anything the print edition set as a table but the EPUB
ships as an image (the growth charts here are `image`, page 143).

**Verification is deterministic, not model-based** (`tools/label-check.js`). On
2,894 blocks it found 10 real problems — 6 blocks labelled `image` that carry
text, 4 mid-sentence fragments labelled heading. **99.65% pass.** A cogito 14b/32b
audit was tried first and rejected: ~1 flag in 4 survived inspection and the
stated reasons were self-contradictory ("page numbers at the top are footers").
`tools/label-audit.js` is kept as the evidence.

### dagger — v1 corpus, 2,598 train / 190 eval
Backed up: `training-corpus-backups/dagger-corpus-2026-07-30-v1.tar.gz`.
Held out on a whole book whose markers are LETTERS while training is numeric +
symbol — so 94.7% is generalisation, not memorisation. But numeric and symbol
markers have **no held-out measurement at all**.

**v2 needs, in order:** quote-balance negatives (all 3 damaging failures were
deleting a `”` mistaken for a marker — and `”` genuinely IS a marker 188 times
in this corpus); copy fidelity (`mercilessly."` → `merrical."` — shorten the
required anchor, or constrain decoding to input tokens); roman numerals, grouped
markers (`1,2,3`) and paragraph-initial markers, ALL absent from v1.

### ocr — not built; the most material ready
- **ICDAR 2017 + 2019 DOWNLOADED** to `training/galley/public-corpora/`
  (81 MB / 206 MB, 4,016 / 28,204 files). Needs converting to chat JSONL.
  RETAS also exists (IA scans ↔ Gutenberg). Layout datasets (PubLayNet,
  DocBank, DocLayNet) are scientific papers and business docs — WRONG DOMAIN,
  skip them.
- **5 confirmed scan+EPUB pairs**, verified independent by the hyphenation test
  (a scan's OCR carries line-break splits; a reflow inherits them, an
  independent ebook has the words joined): Deathstalker (1995 SF paperback),
  What to Expect First Year (2014 reference), What to Expect Second Year (same
  ISBN both files), Life—How Did It Get Here (1985 illustrated), JW Proclaimers.
  The test also correctly REJECTED Coming of the Third Reich (2017 PDF vs 2004
  EPUB — 0/5 joined).
- **175 born-digital PDFs = only 90 distinct books**, of which ~84 usable.
- **Clean-render CER is 0.449% folded, and it is the WRONG error distribution**:
  66% is ligature/quote/case normalisation, and l/1/I confusion occurs ONCE in
  115,273 chars. Training on clean pages builds a Unicode normaliser, not an OCR
  repairer. **Degradation is mandatory.** Measured ladder: optical damage (blur,
  JPEG, contrast, skew, 75-dpi) is nearly free; speckle is the smooth CER knob;
  **blur ~2.0 px produces the RIGHT errors** (`ss`→`w`, `e`→`c`, `li`→`h`) and
  cliffs hard at 3.0 (44% CER). **Stay under ~8% CER** — past that the geometry
  alignment itself collapses and you lose the labels with the text.
- **Born-digital does not mean the truth is right.** Satanic Panic's ToUnicode
  CMap is broken — truth reads `Frank =appa`, Tesseract was RIGHT. A text-quality
  gate over all 175 found **133 clean / 25 suspect / 17 unusable**.
- ≥50% identity pairs, hold out whole books, judge on CER **and false-edit rate
  on already-correct lines**.

## 10e. Next actions, cheapest first

1. ~~CropBox fix~~ — done (6ea3329). Only Twisted Cross was affected; its labels
   carry the old geometry until it is re-OCR'd.
2. **Review the 10 flagged labels** in corpus mode, then merge both books'
   derived labels into the blocks corpus (backup already taken:
   `blocks-corpus-2026-07-30-pre-epub-derived.tar.gz`).
3. **Scale derivation to full books** — the 16× on subheading/caption.
4. **Rescue 12 orphan files** before deleting `ebooks/` — two are the only copy
   of a book whose project exists but whose `archive/` folder does not. Deleting
   also makes `scripts/reverse-migration.mjs` a one-way door.
5. **ocr corpus**: convert ICDAR, build the scan↔EPUB sequence aligner
   (hyphenation rejoining that does NOT destroy real compounds like
   `hand-washing`), degradation ladder over the 84 books.
6. **dagger v2** data.
7. Relabel `The_Coming_of_the_Third_Reich` — 273 blocks still carry the retired
   `front_matter` class.

**Standing rule added this session: never launch more than 5 subagents, counting
transitively, and say what they will do before launching.** A research fan-out to
8 sub-agents burned an entire usage limit in ~5 minutes. Stopping a parent does
NOT kill its children — verify a stop actually stopped things.

---

## 11. Session log — Jul 30 2026 (evening): the reviewed corpus, and v5

### 11a. What is RUNNING as this was written

**blocks v5 training, on owens-pc.** Started 23:16 EDT, step ~96/930 at
12.4s/step, ETA ~3h. Launched per §6 exactly (that section is authoritative —
three of its four documented pitfalls bit before it was read: conda is not on the
wsl login PATH, the env is `orpheus_train` not `orpheus_ft`, global options go
BEFORE the `train` subcommand, and **no `--merge`** because the merge happens on
the Mac).

Profiles `blocks_v5` and `blocks_v5_seed2` are in `training_profiles.json` on
that box; the pre-run backup is `training_profiles.json.bak-pre-blocks-v5`.
Corpus staged at `~/blocks-v5/{train,eval}.jsonl`, log at
`~/training_data/block_categorize/train_v5.log`.

**A GPU temperature monitor is running** because §6 records that the box has a
faulty fan: it throttles to 270W at 86°C and 220W at 90°C. Do not run that box
unattended without it.

### 11b. The v5 corpus — 15 books, THREE changes and only three

Deliberately three, so the result is attributable (see 10c on changing one thing
at a time).

1. **Every session book re-reviewed by hand.** 410 corrections across 11 books,
   plus a complete pass over Coming of the Third Reich. Net movement says what
   the old labelling got wrong: `footnote` −141, `list` +126, `quote` +38,
   `subheading` −35 (and **+0** — it was never once corrected *to*).
2. **Evangelical Kirch dropped entirely**, including from eval, where it had been
   deliberately placed. It is the only German book and the labeller does not read
   German; reviewing the English books turned up real errors in all of them, so
   its labels cannot be assumed sound. An eval set nobody can verify silently
   misreports every score computed against it.
3. **`table` merged into `list`** at SFT build time (`--merge-table-into-list`).

`table` is gone because **nothing downstream ever distinguished it**: outside the
taxonomy it appears only as the `shift+t` shortcut and an unrelated HTML tag list
in epub-processor, and both classes are `enabled: true`, so export and TTS
narrate them identically. It was also unfixable — 92% of 839 table blocks sit in
one book (Pohl), the exact ≥500-examples-but-no-spread failure that keeps a class
at 0.00 F1. **The merge is a FLAG, not a relabel**: every labels.json keeps its
`table` blocks, `sft-split/` is built alongside `sft/`, and reverting is one
argument.

**WHEN v5 LANDS, JUDGE ON ACCURACY AND `list` F1 — NOT macro-F1.** Dropping a
class that scored 0.00 raises the macro average by arithmetic alone. That is not
progress, and it is the easiest false win available this round.

**The gatherer is now an ALLOW-LIST** (`INCLUDE_BOOKS` in `gather-corpus.mjs`).
This changed the night the Training tab shipped: a corpus book is now anything
with a `labels.json`, and seven of those are labelled BY blocks-v4 and reviewed
by nobody. Under the old deny-list all seven would have been gathered as ground
truth. Skipped books are printed, never silently dropped.

Pre-flight that mattered: max token length **measured** at 10,402 against the
10,752 window, 0 examples over. `text_sft` refuses to truncate, so an unmeasured
longer page fails the run outright.

### 11c. OPEN BUG — `tools/blocks-detect-corpus.js` writes garbage silently

**unspeakable-truths produced 1 label from 4,514 blocks and the tool reported
success.** The label written was `{"undefined": "footer"}` — the literal string
`undefined` as a block id. Reproduced on 3 pages. hungary (4,034) and siege
(6,013) completed fine, so it is book-specific, cause not yet diagnosed.

Two defects, both in the tool, both unfixed:

- **No sanity gate.** The picker has one — *"a model that answers nothing
  parseable for the first chunk is the wrong model, not a hard page"* — and the
  CLI has no equivalent, so it ground through 378 pages in 511s producing nothing
  and called it done.
- **No key validation.** A predicted id absent from the block set is a bug, not a
  label, and must never reach the labels map.

Fix both BEFORE running OCR + detect across more books, or the same silent
failure repeats on every one. `unspeakable-truths/labels.json` still holds the
bogus single label; `blocks.json` is intact, so deleting it reverts the book.

### 11d. Also shipped

- **Training tab** (`/training`, nav rail after Queue). Three sub-tabs — blocks /
  dagger / ocr — with per-book "mark reviewed". Only blocks books open in the
  editor; the other two are inventory and say so. 21 books listed.
- **Corpus books can now be OCR'd and pre-labelled**: `saveTrainingBlocks`
  (refuses on a book carrying hand labels; `force` moves them aside rather than
  deleting), `blocks-detect-corpus.js` with `--keep-pages` (a hard exclusion that
  doubles as free ground truth — it scores itself on those pages before writing).
- **EPUB-derived books are reviewable** (`epub-derived-to-corpus.js`). NOTE both
  cover ~10% of their book: what-to-expect pages 143–210 of 708, deathstalker
  100–159 of 532. Everything else is blank, not unlabelled.
- **label-check** gained `--corpus`, and learned that `[Image WxH]` is a
  PLACEHOLDER meaning no text. Reading it literally made the image rule fire on
  1,001 correct labels in one book and the repetition rule call it page furniture
  on 657 pages. Figure text ("NORTH SEA" on a map) is now a note, not an error.

### 11e. Two corrections to earlier claims in this document

Both were stated here as measurements when they were guesses. Worth the space
because the pattern is the lesson.

- **"EPUBs can't yield `table` because publishers reflow them into boxes"** —
  FALSE. `p class="box"` is 1,520 of 1,520 bulleted list items, already mapped to
  `list`. What to Expect simply has one table. Count the tags before writing off
  a channel (see §9b).
- **"The CropBox bug corrupts labels on every cropped PDF"** — FALSE twice over.
  One book of 18 differs, and its labels are FINE: coordinates and stored
  `pageDimensions` were inflated by the same per-axis factor, so every ratio
  feature is exact. Acting on the claim would have cost 3,982 hand labels to a
  needless re-OCR.

### 11f. Next, in order

1. **Fix the two `blocks-detect-corpus.js` defects** (11c). Blocks everything else.
2. **v5 lands (~3h)** → merge on the Mac (`blocks-merge-mac.sh`, and note its
   best-checkpoint picker sorts by step number), score with
   `tools/blocks-score-eval.js`, then `blocks_v5_seed2` for the noise floor —
   seed alone moves macro-F1 0.018 here.
3. **OCR the remaining corpus books**, run v5 over them, hand-correct. This is the
   loop `blocks-report.js` exists to measure.
4. **A `publisher` class** — PROPOSED, not decided. Jacket blurbs and author bios
   currently land in `body` (measured: Nuremberg p2, Holy Reich p2), so they both
   pollute the largest class and get narrated. It must be ONE class, not
   front/back (two would each starve, as `table` did), content-defined rather than
   positional (which is why `front_matter` was retired), and `enabled: false` or
   it changes nothing downstream. Zero retired-class labels remain on disk, so
   there is no seed — it needs a labelling pass over the first ~8 and last ~4
   pages of each book.
5. **ocr** — material is complete, corpus is not. ICDAR is 32,203
   character-aligned files (`[OCR_toInput]` / `[OCR_aligned]` / `[ GS_aligned]`,
   `#` unaligned, `@` insertion); converting to chat JSONL is mechanical. But
   ICDAR is 19th-century newspapers and BookForge serves Tesseract on modern book
   scans, so it is a pretraining stage, not the product. The domain half — the
   degradation ladder over ~84 born-digital books, blur ~2.0px, alignment
   collapses past ~8% CER — is still unbuilt, and the 5 real scan+EPUB pairs are
   the eval set, not training data.

   **Settle ocr's applier contract before training it.** It rewrites text,
   runs upstream of both the EPUB and the narration, and is the only one of the
   three models that can invent a word. Dagger only deletes and still needed a
   subsequence guard.

   No public corpus fits this job. Every one is pre-1930, because aligned ground
   truth for a modern book needs the publisher's text, which is copyrighted.
   That makes your own scan+EPUB pairs the rare material, not the fallback.

---

## 12. Session log — Jul 31 2026: ocr's corpus, built and gated

**Read this before touching ocr.** The corpus is DONE and the harness is
done; nothing has been trained yet.

### 12a. State

| artifact | where | numbers |
|---|---|---|
| domain corpus | `training/galley/sft/` | 7,525 train / 1,491 eval, 61 books, **exactly 50% identity** |
| ICDAR pretrain | `training/galley/sft-pretrain-icdar/` | 3,571 rows, separate stage |
| mined pairs | `training/galley/pairs/` | 63 `*.pairs.jsonl` + per-book stats |
| tooling | `tools/foundry-ocr/` | mine, gate, degrade, build, contract |
| scorer | `tools/foundry-ocr/score.js` | not yet run against a model |
| profiles | `tools/foundry-ocr/training-profiles.json` | `ocr_v1_4b` + `ocr_v1_06b` control |

**Eval baseline to beat: CER 1.129%** over 7 held-out books. "Always answer
`none`" scores exactly that with a perfect false-edit rate — which is why the
headline is a PAIR and neither number means anything alone.

### 12b. The contract is the safety, not the model

`tools/foundry-ocr/edits.mjs`. An edit must quote its anchor verbatim, that anchor
must occur exactly once, edits may not overlap, and the set may not exceed the
block's change budget. Derivation verifies by applying its own output, so the
corpus cannot contain a target the runtime would refuse — **9,016/9,016 gold
rows satisfy the production applier**, and drift between the two is a hard stop
in the scorer, not a warning.

Measured: **98.3% of real pairs derive**, so the edit-list format holds and
§9b's full-text fallback is not needed.

### 12c. THE TRUTH LIES — three ways, all systematic

A PDF text layer is *instructions for drawing glyphs, not a transcript*. Every
defect below is correct-for-rendering and wrong-as-truth, which is why they are
findable (they repeat) and why gating is mandatory:

1. **Broken ToUnicode CMaps** — Satanic Panic's layer reads `Frank =appa`.
   Tesseract was right.
2. **Small caps** — a running head sits in the layer lowercase while the page
   plainly reads uppercase. INVERTED to an identity row, not dropped: the OCR is
   correct, so `none` is the correct target.
3. **Soft hyphens (U+00AD)** — the layer records the line break, so the pair
   read `edi- tion` → `edi\xad tion`, training the model to swap an ASCII hyphen
   for a soft one AND KEEP THE SPACE. **747 of 12,594 pairs across 28 of 56
   books.** Healed at source; the target is now the join, `edi- tion → edition`.

**The gate that works is `gate-mined-truth.mjs`** — it runs `tools/text-quality.py`
over the truth we ACTUALLY MINED. Neither earlier signal survives alone:

| book | book-level verdict | CMap heuristic | correct call |
|---|---|---|---|
| Satanic Panic | unusable | 7 broken maps | exclude (agree) |
| Churches vol 1 | **clean** | `«`→`e` | **exclude** |
| Shirer | clean | `†`→`t` | **KEEP** |

The book-level verdict sampled English front matter while the mined pages are
Fraktur; the CMap heuristic flagged a correctly-set footnote dagger Tesseract
misread — a genuine, valuable error. **Only `unusable` excludes**; `suspect` is
weak on a 20-page fragment (Shirer scores suspect on ligatures and hyphenation).

### 12d. Degradation is mandatory — `speckle0.8`

Clean renders are 0.45% CER of which two-thirds is ligature/quote normalisation:
train on them alone and you build a Unicode normaliser. Measured, 3 books × 4
levels:

| level | align% | CER% | in 1-8% band | normalisation% | glyph% |
|---|---|---|---|---|---|
| clean | 100.0 | 0.565 | 77/396 | 66.1 | 33.9 |
| blur2.0 | **83.8** | 1.314 | 176/496 | 48.2 | 51.8 |
| speckle0.8 | 99.8 | 3.695 | **325/453** | **26.6** | **73.4** |
| combo-mild | 99.3 | 6.411 | 419/721 | 23.3 | 76.7 |

**Two corrections to §10d:**
- **"blur ~2.0 px produces the RIGHT errors" is WRONG.** Blur breaks
  SEGMENTATION, not glyphs, and CER hides it: 149 clean blocks → 206, only 65.5%
  aligned, 39.4% of truth words unclaimed, while CER looked a harmless 3.8%. The
  blocks that drop out are the hard ones, so survivors are biased easy.
- **The ladder is BOOK-RELATIVE.** Identical damage gave 3.74% CER on one book
  and 1.41% on another. A per-book CER-targeted search is the real fix; unbuilt.

Still open: **`l/1/I` confusion stays near zero at every level** — speckle makes
insertions from specks, a different flavour. ICDAR or the 5 real scan↔EPUB pairs
must cover it.

### 12e. Two traps that would have gone unnoticed

- **ICDAR must NOT be in the fine-tune mix.** 27% of rows but **70% of edits**
  (9.4/row vs 2.5) — the model would mostly learn Victorian typesetting.
  `--exclude-source icdar`. Removing it also took identity from 39.7% to exactly
  50%, dissolving the shortfall.
- **Degraded variants leak eval.** They carry the SAME PAGES as their source, so
  holding out `michelle-remembers` left its pages in train under a different id.
  Now closed over `sourceBook` in both directions. It also left that family at
  71% of eval; rebalanced to 40% across 7 books.

### 12f. §9c's "ground truth is free" is FALSE

`tools/blocks/continues-truth.py` derives the planned `continues` bit from page
geometry. `get_text('blocks')` merged five real paragraphs into one and `<p>`
extraction did the same, so boundaries must come from coordinates via a rule we
own. Coverage is **19–50%, not 100%**. It does yield 2,473 pair labels with no
hand labelling, hand-verified **12/12**, corroborated by wrap hyphens agreeing
with the geometry **132/133**. Cheap and already paid — not free.

Also: **`hungarys-admiral`'s "embedded text layer" is a GlyphLessFont — it IS
Tesseract output**, so it is not independent truth and blocks's book-spread count
is one book optimistic. All 57 ocr books were scanned; none affected.

### 12g. Paragraph repair, measured

Audit of 772 blocks (`tools/foundry-ocr/paragraph-audit.mjs`): wrap hyphens in
**17.1%** of blocks, genuine welded paragraphs in **0.29% of body blocks**. So
paragraph reflow does not earn a target and hyphen healing does — and 12c's fix
is what makes it learnable. No edit-format change needed; the join is already
one `before → after` pair in collapsed text.

### 12h. Next, in order

1. **Score v5** (`blocks-score-eval.js`) — accuracy and `list` F1, NOT macro-F1,
   which rises by arithmetic when a 0.00 class leaves the average.
2. **Install the ocr profiles and train `ocr_v1_4b`.** GPU may be busy;
   NEVER start without explicit green light. Then the 0.6B control.
3. **Score with `tools/foundry-ocr/score.js`.** Read `rows made worse` FIRST.
4. **Integrate — user's instruction: swap ocr in for the old cleanup path
   COMPLETELY, no commented-out fallback.** The old method is the Ollama
   whole-chunk rewrite in `ai-bridge.ts` (`cleanupEpub`, the `ocr-cleanup` /
   `bilingual-cleanup` jobs). Model dagger's integration. Note the shape change:
   old = rewrite a chunk of EPUB text; new = per-BLOCK edit list under a
   contract, which is a different unit and a different failure mode.

---

## 13. PLAN — Aug 3 2026: `foundry-blocks-v2-4b`, the paragraph `continues` head

**Nothing in this section is measured unless it says so.** Everything marked
*(estimate)* is arithmetic over numbers measured elsewhere in this document or
over artifacts on disk, and is to be replaced by a measurement, not defended.
This is the plan §9c and §9d have been pointing at since Jul 30; §12f already
found the first version of its "free ground truth" claim to be false, and this
section starts from that correction rather than repeating it.

The objective, stated once: **the next blocks model emits, per block, a second
answer — does this block continue the previous block's paragraph.** Foundry's
grouping ladder is already built to consume it (`src/paragraphs/grouping.ts`,
rung 2, confidence-gated, consulted only at body↔body and quote↔quote
junctions; hard rules and the merge bias outrank it). Nothing downstream needs
inventing. What is missing is the bit, the corpus that teaches it, and the
evidence that emitting it is safe.

### 13a. THE GATE — confident-break precision, and why it is the only gate

Owner's rule, and it sets everything else in this section:

> **Too many paragraph breaks is a problem — it breaks prosody. Too few
> paragraph breaks isn't as much of a problem.**

A missed break is a long prosody run: the narrator reads on. A false break is a
full stop in the middle of a sentence: the narrator stops, and the listener
hears a mistake. Those two costs are not within an order of magnitude of each
other, so a single blended F1 over the junction decision is the wrong number and
must not appear in any report about this head.

**The gate is confident-break PRECISION. Recall is the upside; precision is the
constraint.** The do-nothing baseline is *always-continue*: zero breaks, zero
false breaks, zero recall. It cannot be beaten on precision, only matched — so
every break the model adds has to pay for itself, and the ship decision is
"how much recall did we buy, at what false-break rate".

**Proposed gate (estimate, to be confirmed by the sweep in §13e):**

| quantity | floor | why |
|---|---|---|
| break precision, mid-page junctions | **≥ 0.98** | one false stop per ~6 pages in a book with ~2,500 paragraphs |
| break precision, blended incl. page/column boundaries | **≥ 0.95** | boundary junctions are the noisy ones; they may not drag the book below one false stop per ~2.5 pages |
| **false breaks per 100 pages** | **≤ 5** | the human-legible form of the same number; quote this one to the owner |
| break recall | **report, never gate** | the upside, measured at whatever τ the floors admit |

0.98 is not arbitrary: it is the standard the ladder's existing hard rules
already meet. The wrap-hyphen rule was measured 132/133 (0.992) and the
geometry probe's two-signal AND rule hand-verified 12/12 (§12f). A rung that
outranks geometry has to be at least as trustworthy as geometry.

**τ is chosen by measurement, not declared.** `grouping.ts` already takes
`continuesMinConfidence` (default 0.6). Sweep τ on the held-out books, take the
SMALLEST τ that clears the floors, ship that as the default, and paste the sweep
curve into this document as the evidence. **If no τ clears the floors, the head
does not ship** — the junction falls to geometry, which is today's behaviour,
and nothing is lost but the run.

**One change to `grouping.ts` follows directly from the asymmetry** and should
land with the model: today a single τ gates both directions. A confident
*continue* costs nothing — it agrees with the merge bias — while a confident
*break* is the only thing that can do damage. So the option becomes a pair:
`breakMinConfidence` (high, from the sweep) and `continueMinConfidence` (low,
0.5 — i.e. take the bit at face value). This is the literal implementation of
the owner's rule and it makes the gate structural rather than a number in a
report.

### 13b. P0 — THE BLOCK SPLITTER COMES FIRST, and here is the measurement that proves it

**Measured Aug 3 2026 on the Kershaw journal run**
(`~/Documents/BookForge/foundry-runs/…Working_Towards_The_Fuhrer…-7d8d23eb80f2`,
17 pages, `foundry` 0.1.0 (9d3fa8d), blocks served by `rubric-v5-4b-f16`):

| | |
|---|---|
| body blocks | **24** |
| body lines inside them | **578** |
| lines per body block | up to **42** — a whole page of prose in one block |
| body→body junctions in raw block order | **7** |
| paragraphs in the exported EPUB | **5** (one of them 19,894 characters) |
| paragraph openings visible in the ink | **~53** |

The 53 is measured, not guessed: over the 578 body lines the modal left edge is
168 px (the calibration's own `flushLeft`) and there is a second, clean cluster
at 198–204 px — **+1.2 body heights**, 53 lines, and every sampled one of them
is a genuine paragraph opening (`'There can be no principled objection…'`,
`'My starting point in these reflections…'`, `'Hitler's way of operating was…'`).
The previous line is short at nearly all of them.

Three things follow, and the third is the one that sets the plan's order.

1. **Calibration missed the live signal.** It returned `convention: 'block'`
   with `indent.fired: false` — *"only 1.8% of lines in the upper cluster —
   outliers, not a rhythm"* — because it clusters over ALL lines, and this
   book's centred display lines and deep footnote indents (x0 259–424) form an
   upper cluster that swallows the real one. Then the `block` verdict it did
   return is inert: **exactly ONE line-to-line advance in the whole book's body
   text clears the 1.39×-pitch gap threshold it derived.** A book was calibrated
   to a convention it does not use, and the convention it does use was reported
   as absent.
2. **The owner's reading of the page is that the convention is FLUSH** — no
   extra leading, and the only reliable boundary signal is the previous
   paragraph's short last line. The measurement above finds a real +1.2-body-height
   first-line indent as well. These are not in conflict for planning purposes and
   the discrepancy is *itself a finding*: a modest one-em journal indent reads as
   flush to the eye and is invisible to a calibrator tuned for book-length
   indents. **Both readings produce the same verdict about the code** — a binary
   indent-or-gap calibration is the weak link, the line-end fill ratio is the
   signal it is missing, and `flush` needs to exist as a third convention.
   Settle which this book is at the dataset build, on the mined labels, not by
   argument.
3. **THE CEILING.** `continues` is a per-BLOCK answer, so it can only ever place
   a break AT A BLOCK JUNCTION. On this book there are 7 body→body junctions and
   ~53 paragraphs. **A perfect `continues` model changes nothing here**, because
   the breaks are inside the blocks. Foundry says so itself, in
   `src/commands.ts`:

   > *"This grouping is PROVISIONAL, it is recorded as `gap-v0` in
   > `blocks/blocks.json`, and it is not the grouping the blocks model was
   > trained against."*

   `formBlocks` cuts on one rule — vertical gap > 0.8× the page's median line
   height, or no horizontal overlap. It never cuts at an indent, never cuts at a
   short previous line, and on a flush/short-line book it never cuts at all.

**So P0, before any label is minted: block formation must SPLIT AT PARAGRAPH-START
CANDIDATES.** This is not new scope — it is §9d decision 4, still unbuilt, and
§9d decision 3's whole composition argument depends on it: *block formation
splits when unsure, paragraph assembly merges when unsure; both biases compose
because splitting runs before labelling and merging runs after.* Today only half
of that exists. A candidate start is any of: first-line indent past the book's
own threshold, an advance past the book's own gap threshold, **or a previous
line ending short of the measure**. Over-splitting is cheap by construction —
`continues` merges it back, and until the model exists the merge bias does.

**And P0 is not optional for a different reason: train/serve segmentation
parity.** §5's cardinal rule. The junctions in the corpus must be the junctions
served, or the head is trained on one question and asked another. `gap-v0` vs
the corpus's Tesseract split-only formation is *already* a live mismatch for the
category head; adding a head whose entire unit is the junction makes it fatal.

**Estimated impact on class balance, and why it matters (estimate):** with a
paragraph-aware splitter, junctions ≈ paragraphs + over-splits, so labels skew
hard toward BREAK — see the counts in §13c, roughly 10:1 before over-splits are
counted. A precision-gated head trained on a 10:1 break-heavy corpus learns
"always break", which is the exact failure the gate forbids. **The over-split
`continues` rows are what balance the corpus**, and they only exist if the
splitter is generous. Measure the ratio at build time and report it; if it is
worse than ~3:1, downsample breaks rather than tighten the splitter.

### 13c. Corpus inventory — the paired books that already exist

The material is on disk and already aligned. `/Volumes/Callisto/training/ocr-lab/`
holds **16 books with a matching PDF and EPUB**, provenance recorded per book in
`gold/manifest.json` (truth tiers assigned from the owner's own descriptions,
Jul 31 2026). Their alignments were built for the ocr corrector and are reusable
verbatim.

| book | pages | OCR lines | EPUB paras | words/para | lines→truth | truth tier |
|---|---|---|---|---|---|---|
| himmler-a-life | 1,052 | 39,541 | 10,275 | 41.0 | 96.1% | 1 (publisher EPUB + real scan) |
| rise-and-fall | 1,040 | 48,254 | 11,325 | 55.4 | 99.8%¹ | 1 |
| what-to-expect-when-youre-expecting | 706 | 28,231 | 10,681 | 32.8 | 80.5% | 1 |
| what-to-expect-the-second-year | 532 | 19,839 | 7,870 | 33.3 | 81.8% | 1 |
| michelle-remembers | 327 | 9,672 | 2,619 | 37.4 | 93.6% | 1 |
| gods-people | 304 | 8,857 | 1,695 | 47.8 | 99.4%¹ | 1 (owner's own book) |
| understanding-jehovahs-witnesses | 397 | 11,506 | 2,155 | 48.0 | 99.3%¹ | 1 (owner's own) |
| was-hitler-an-atheist | 224 | 6,170 | 929 | 51.9 | 99.1%¹ | 1 (owner's own) |
| deathstalker-honor | 530 | 22,082 | 4,463 | 47.3 | 96.8% | 2 |
| deathstalker-legacy | 484 | 20,162 | 3,841 | 49.5 | 94.6% | 2 |
| deathstalker-war | 532 | 22,328 | 3,385 | 58.7 | 96.2% | 2 |
| deathstalker-destiny | 436 | 18,090 | 3,794 | 41.0 | 96.2% | 2 |
| deathstalker-rebellion | 515 | 22,008 | 3,352 | 61.8 | 96.5% | 2 |
| deathstalker-return | 484 | 16,505 | 3,215 | 54.4 | 96.3% | 2 |
| deathstalker-coda | 386 | 13,248 | 2,350 | 63.0 | 96.2% | 2 |
| ~~deathstalker (vol 1)~~ | 532 | 22,605 | **652** | **319.2** | 95.4% | **REJECTED** |

¹ aligned by `align-pdftext.py` against the PDF's own text layer per printed
line, not by `align-epub.py`; the EPUB is on hand in `gold/` and the paragraph
projection has to be built for these four the same as for the rest.

**The words-per-paragraph plausibility gate is a new, cheap, mandatory check.**
Deathstalker vol 1 reports 652 paragraphs for 208,130 words — 319 words each.
English prose runs 30–90. Its `<p>` structure is not paragraph truth (whatever
its OCR text is worth, and its OCR text is fine — it is the calibration book for
the whole lab). **An EPUB is admitted as paragraph truth only if its
words-per-paragraph lands in 25–100; anything outside is rejected by the
builder, loudly, with the count.** This is §10d's "count the tags before writing
off a channel" run in the other direction: count them before trusting one.

**Totals over the 15 admitted books: 7,949 pages, ~306,500 OCR lines, ~71,950
EPUB paragraphs.**

#### Junction yield (estimate)

Under a paragraph-aware splitter, per book: junctions ≈ body blocks − 1; breaks
≈ paragraphs − 1; confirmed continues ≈ paragraphs split across a page or column
boundary, plus the splitter's over-splits.

- **Break labels: ~71,900 floor** (one per paragraph after the first).
- **Page/column-crossing continues: ~6,000–8,000** (order one per page).
- **Over-split continues: unknown until P0 lands** — and, per §13b, this is the
  number that decides whether the corpus is trainable without downsampling.
- **Junctions lost to alignment coverage**: a junction is labelled only when
  BOTH sides resolve to a truth span, so expect ~0.96² ≈ 92% on the scan books
  and ~0.81² ≈ 66% on the two *What to Expect* volumes. **Unprovable junctions
  are DROPPED, never guessed** (§13d).
- Net **≈ 65,000 labelled junctions**, ~1,900–11,000 per book.

Cross-checked against the only junction counts that were ever actually measured
here — the geometry probe's `body` stream (§12f): bonhoeffer 4,355 pairs,
hungarys-admiral 1,910, siege 1,825, deliverance 481. Same order.

#### The spread problem, honestly stated

16 books is not 16 typographies. Distinct house styles:

| house style | books |
|---|---|
| Roc/Gollancz mass-market SF paperback (Simon R. Green) | 7 |
| Vellum, the owner's own titles | 3 |
| publisher-original trade hardback (Himmler) | 1 |
| bad IA scan, trade paperback (Michelle Remembers) | 1 |
| Workman reference, sidebars + boxes + multi-column | 2 |
| Calibre render of an ebook, Computer Modern | 1 |

**~6 distinct typographies.** §4's lever — book spread beats example count — was
about starving CLASSES, and `continues` is not a starving class: every one of
these books carries thousands of both values. So 6 typographies is enough to
TRAIN. It is **not** enough to be confident about, because the thing that varies
between books here is exactly the thing the head has to read: the convention.

#### Convention census — a phase-0 deliverable, NOT YET MEASURED

Per §13g, the corpus must cover the break taxonomy, and the first column of that
is the book-wide convention. **Run the census before the split is fixed**, one
line per book, from the mined labels rather than from calibration (calibration is
one of the things under test):

- **indent** — first line inset, no extra leading
- **gap / block** — flush left, blank-line separation
- **flush** — neither; the previous line's short last line is the only signal
  (the Kershaw shape, §13b)
- **hanging indent / outdent** — bibliographies and reference matter. Recognise
  it so it is not read as "indent"; it is almost never `body` and mostly leaves
  by category.

**Split targets: at least one book per convention in TRAIN and at least one in
EVAL, and the eval must contain a `flush` book** — that is the convention that
fools geometry hardest, and a head gated on precision has to be tested where the
rung it outranks is weakest. Two gaps are already visible and are the honest
shortfall of this inventory:

- **No non-English paired book.** The German material in the blocks corpus
  (Niemöller, Scholder vol 2) has no EPUB. §11b dropped Niemöller from eval for
  a good reason and this plan does not undo that; but a German book with
  guillemet/quotation-dash dialogue is not represented at all. **Named as a
  gap, not silently absorbed.**
- **Fiction/dialogue is 7 volumes of one series.** Adequate for the shape;
  a second, unrelated novel would be worth more than an eighth Deathstalker.

#### Is more pairing work needed?

**A scan of the library (`/Volumes/Callisto/Shared/BookForge/projects/`, 378
manifests, Aug 3 2026) says: almost none is available there.** 53 projects hold
both a PDF and an EPUB, but 47 of those "EPUBs" are `source/exported.epub` —
the project's own export, produced FROM that very PDF. Those are circular and
must never enter: an export's paragraphing is the output of the pipeline under
test. **Only 5 projects carry a genuinely independent EPUB in `archive[]`
alongside a PDF**: Ecclesiastical Investigations (Kurucz 2020), Jehovah's
Witnesses—Proclaimers (1993), The History of the German Christian Faith Movement
(1933, 66 KB — a pamphlet), What Did You Do In The War, Sister (2020), and
d'Souza (2023). A sixth, Transitional Justice, has an EPUB whose `role` is
`export` (266 MB — page images) and is not truth.

Of those, **Proclaimers is already one of §10d's five hyphenation-verified
scan+EPUB pairs** and is the only obvious addition. **Verdict: the 15 admitted
books are enough to build and train v6. The pairing work worth doing is
targeted, not bulk** — one non-English book with real dialogue, and one novel
outside the Deathstalker series. Both need the hyphenation independence test of
§10d before they are believed.

### 13d. Label derivation — mined from the EPUB, never guessed

The channel is the one that already works twice over: `align-epub.py`'s
scan↔EPUB alignment (the ocr corrector's feedstock, 93–99% of OCR lines
resolved on the scan books) and §10d's EPUB-derived label channel (95.7% /
97.2% of blocks labelled on two sample books). This build uses both, from one
pass.

**The derivation, end to end:**

1. **Blocks come from the Tesseract-canonical scan**, formed by the P0 splitter.
   Non-negotiable (§5): the classifier trains on the segmentation it is served.
2. **Align OCR lines to EPUB text.** Already computed and cached in
   `<lab>/<book>/scores/epub-align-pairs.json`. Each pair carries `line`,
   `page`, `ocr`, `truth`.
3. **Add paragraph identity to the pair record — the one code change the
   derivation needs.** `align-epub.py` already builds `paras[]` and tags every
   truth word with its `para` index (`build_truth`, `span_text`); the pairs
   emitter simply does not write it out. Emit `truthParaFirst` /`truthParaLast`
   per pair. Small, local, and it serves both heads.
4. **A junction's label is a property of B's FIRST line**, exactly as §12f
   established: B continues iff B's first line's truth paragraph is the same
   paragraph as A's last line's truth paragraph.
   - same `para` → **continue**
   - adjacent-or-later `para` → **break**
   - either side unresolved, or the two sides land in paragraphs that are not
     ordered (a transposition — himmler has 36 such runs, 0.22% of body) →
     **DROP. Never guess.** The coverage number stays honest and the corpus
     stays clean; §12f's whole lesson.
5. **Categories come from the same alignment** — §10d's EPUB-derived channel,
   `<p>`→body, `<h3>`→subheading, `<figcaption>`→caption, `blockquote`→quote.
   These rows enter the **ALIGNED tier** (derived, never human) as §1 already
   defines, and they carry §10d's known ceiling: the markup cannot encode
   heading LEVEL, and anything the print set as a table but the EPUB ships as an
   image is `image`. Both are category-head limits, not `continues` limits.
6. **Verify deterministically**, `tools/label-check.js --corpus` (99.65% pass on
   2,894 blocks), plus two `continues`-specific cross-checks that cost nothing:
   - **wrap hyphen vs label.** A junction whose A ends in a wrap hyphen must be
     `continue`. Measured 132/133 by the geometry probe. **A disagreement rate
     above ~1% on any book is an alignment fault in that book, not a hard case
     — quarantine the book, do not sand the rule.**
   - **sentence-final punctuation vs label.** A `break` whose A does not end in
     sentence-final punctuation is suspicious; report the rate per book. It is a
     diagnostic, never a filter (real paragraphs end on dashes and quotes).

**Expected label noise, named so it is looked for:**

- **EPUB paragraphing that differs from print.** Reflows split or merge; a
  publisher's ebook edition genuinely repunctuates. This is the residual risk of
  the whole channel and the words-per-paragraph gate (§13c) is the coarse
  screen. The fine screen is the two cross-checks above.
- **Poetry, verse, epigraphs.** Every line is its own `<p>`, so every junction
  reads as a break — technically true and prosodically wrong. **Excluded by
  CATEGORY, not by label**: they are not `body`, so the applier's rung-1 hard
  rules never let them reach the model. If a verse block is miscategorised as
  `body`, that is a category-head error and must be reported as one.
- **Lists.** Same shape, same answer: `list` is not a flowing category.
- **Tier-2 EPUBs.** The seven Deathstalker volumes are OCR-derived ebooks of the
  same edition. Their paragraph boundaries are proofread and page-anchored, but
  they are not publisher originals. **Hold at least one tier-1 book in eval**, so
  the headline precision is never measured only against tier-2 truth.

#### Which existing features already carry break signal — and the one that is missing

The encoder already sends geometry, and the model should learn geometry and text
jointly rather than be handed a verdict. What is there today
(`foundry/src/blocks/encoder.ts`, v2+ block line):

- **`g<gap above>`** — in units of the book's modal leading. This is the
  gap/block convention's signal, and it is already there.
- **`il<left inset>` / `w<width>` / `cx<centre offset>`** — the horizontal
  decomposition against the book's measure.
- **`q<ocr confidence>`, `r<repeats>`, `t<position in text block>`, `fs<size
  ratio>`** — furniture and structure signal; not break signal, but they are
  what keep a running head from ever reaching rung 2.

**The gap that matters: `il` is the BLOCK's left inset — the minimum over its
lines — so a paragraph whose FIRST line is indented and whose remaining lines
are flush reports `il0`.** The indent convention is invisible to the current
prompt. That is not a subtle deficiency; it is the reason a `continues` head
cannot be trained on the v5 line as it stands.

**New per-block integers for v6 (all percent-of-measure or 0/1, integer-encoded
per §5):**

| field | meaning | why |
|---|---|---|
| `fi` | first-line indent, % of measure, signed | the indent convention, which `il` hides |
| `pf` | **previous line's fill** — previous block's last line right edge as % of the measure | the flush convention's only signal; see below |
| `pp` | previous block's last line ends in sentence-final punctuation (0/1) | text evidence, cheap, style-independent |
| `ph` | previous block ends in a wrap hyphen (0/1) | the applier owns this rule; showing it stops the model contradicting a decision it cannot win |
| `bd` | this block opens a page or a column (0/1) | the two biggest false-break generators (§13g) get an explicit handle |

and one BOOK-level fact in the page header, per §9d decision 5: **the calibrated
convention** (`indent` / `gap` / `flush` / `none`), stated as a word.

**`pf` is the coordinator's point and it deserves its own paragraph.** The
asymmetry in it is exactly the asymmetry of the gate:

- **A FULL previous line is near-proof of continuation.** Paragraphs almost
  never end flush with the right margin — justified setting makes it possible,
  but it is rare. The STRONG direction of this signal is "do not break", which
  is free under the owner's rule: it can only ever suppress a false break.
- **A SHORT previous line is only a hint.** Its noise sources, named: the last
  line of a page (short for reasons of pagination, not paragraphing), the line
  before a heading, a line that simply happens to end near the margin, a
  displayed quote set to a narrower measure (the biggest single undecided bucket
  in §12f's first run — 1,314 of 4,549 bonhoeffer pairs), and any line in a
  ragged-right book.

So `pf` is a precision-friendly feature in the direction that matters, and its
weak direction is exactly where the model is supposed to weigh text evidence
(`pp`, plus whether B opens with a capital or an opening quote) instead of
arithmetic. That is §9d decision 1 restated: give the model facts, not
coordinates.

**Token budget — measure it, do not assume it.** §11b measured v5's longest page
at 10,402 tokens against a 10,752 window with zero rows over, and §10b bug 2
records the serving context at 12,288. Five new integers plus the answer field
add an estimated 8–10 tokens per block; at the 80-block endnote pages that is
+800, which puts the longest page at roughly **11,200 (estimate) — OVER the
current `max_seq_length`**. `text_sft` refuses to truncate, so one unmeasured
long row kills the run outright. Two levers, in order: raise `max_seq_length` to
12,288 to match the server, and if that is not enough, cut `TEXT_BUDGET` from
4,000 to 3,200 — **text shrinks, never geometry**, which is the existing rule and
the existing justification (dense pages are almost all footnote, whose class
comes from position and repetition).

### 13e. Output format — prompt v6, one extra field, integer-encoded

Today the model answers `<1-based index> <category>`, one line per block, and
**the format is solved**: 0 unparseable lines, 0 missing blocks, 0 illegal
categories, from epoch 1, at both model sizes (§3). Nothing in this change may
put that at risk.

**The v6 answer line:**

```
<index> <category> <k>
```

where `<k>` is **a single digit 0–9: the model's belief that this block
CONTINUES the previous one, in tenths.** 0 is "certainly a new paragraph", 9 is
"certainly continues". For any category that is not `body` or `quote`, `<k>` is
the literal `-`.

Why this shape:

- **One token.** Digits 0–9 are single tokens; a decimal probability is three to
  four (§5, integer encoding — the same finding that took a page from 8,199
  tokens to 6,529).
- **It is `{value, confidence}` with no second field.** `grouping.ts` wants
  `b.continues = { value, confidence }`; derive `value = k >= 5`,
  `confidence = k >= 5 ? k/9 : 1 − k/9`. Monotone, so the τ sweep of §13a is a
  sweep over an integer: *break iff k ≤ K*, K ∈ {0,1,2,3,4}. K=0 is the most
  conservative rung the model can offer, and it is the one the gate will
  probably select.
- **The `-` is causally legal.** The model emits the category first on the same
  line, so by the time it reaches the third field it has already committed to
  whether the block flows. It costs one token on furniture instead of a wasted
  digit, and it makes an illegal answer (a digit on a `header`) detectable
  rather than silently meaningless.
- **The category head is untouched.** Fields 1 and 2 are byte-identical to v5's
  line. A v5 parse of a v6 answer reads the category correctly and ignores a
  trailing token — which is a nice property but is NOT a licence to mix them:
  the catalog's `promptVersion` remains the only authority (§10b bug 1 — adding
  a catalog entry always needs the matching encoder branch FIRST).

**Version number: v6, shipped as `foundry-blocks-v2-4b`.** The encoder's v6 slot
already exists and already means "v5 features plus the `discard` class"; no
weights have ever been trained on it, and `tools/aligner/blocks-publish.sh`'s own
usage examples already read `./blocks-publish.sh v2-4b 6 …`. So **v6 carries both
changes — `discard` and `continues` — and release v2 is the first model to speak
it.**

**Two changes in one bump, against §10c's change-one-thing rule.** The exemption
is that they are measured by DISJOINT metrics: `discard` is judged on category
accuracy and page-exact, `continues` on break precision. Attribution survives.
What does not survive automatically is the category comparison against v5, since
`discard` moves blocks between classes — so **re-score v5's held-out split with
`discard` folded back into its v5 home before quoting any v5→v2 category delta.**
If that fold-back cannot be made clean, split the runs and take the extra 5 hours.

### 13f. What trains on what — the supervision problem, and its answer

The 15 paired books are not hand-labelled for category, and §11b's allow-list
exists precisely so that model-labelled books cannot enter as ground truth. The
15 hand-labelled corpus books are not EPUB-paired, so they have no `continues`
truth. Naively unioning them puts an invented answer in one field or the other.

**The answer is §10d's EPUB-derived channel: for a paired book, BOTH heads are
derived from the SAME alignment.** Category from the markup, `continues` from the
paragraph identity. Nothing is predicted; the aligned tier already exists in §1
for exactly this.

That leaves the hand-labelled books, whose category rows are the corpus's
crown jewels and whose `continues` field has no truth. **Preferred: per-field
loss masking** — the trainer already does assistant-only loss; masking the third
field on rows without `continues` truth (and the second field on derived rows,
if the derived categories are ever judged untrustworthy) is a bounded change to
the collator. **Verify it in phase 0, before the corpus is built.**

**Fallback if masking is not available:** train v6 on fully-supervised pages only
— the 15 paired books, ~7,950 pages. That is more pages than v5 trained on
(4,953), and it is enough for the `continues` head by §13c. The cost is that the
category head loses the hand-labelled corpus, which is a real regression risk and
a *measurable* one: score the v6 category head against v5's on the same held-out
split and say the number. If it regresses, the run is a `continues` prototype,
not a release, and masking becomes P1.

### 13g. The break taxonomy the corpus must cover

Mined labels teach all of these at once **only if the corpus contains them**.
This is the checklist the inventory (§13c) and the eval split are tied to.

**Book-wide conventions** — one book per convention in TRAIN, one in EVAL:

| convention | what it looks like | corpus status |
|---|---|---|
| indent | first line inset, no extra leading | present (census pending) |
| gap / block | flush left, blank-line separation | present (census pending) |
| **flush** | neither; short last line is the only signal | **Kershaw is the exemplar and is NOT in the paired set — find one** |
| hanging indent / outdent | bibliographies, reference matter | recognise; almost never `body` |

**Local events, inside any convention:**

- **First paragraph after a heading or chapter opening is set FLUSH.** The
  labels must not teach "flush start ⇒ continue". Rung 1 already breaks at
  category transitions, so these junctions never reach the model — but they must
  be verified as category transitions, not assumed.
- **Drop caps** distort the first line's geometry beyond recognition. Lean on
  text there; report drop-cap junctions separately if any book has them.
- **Scene / section breaks** — dinkus, fleuron, a large gap in fiction. Always a
  break, and prosodically the most important break in the book. The Deathstalker
  volumes carry these; make sure they survive the derivation rather than being
  dropped as unresolvable.
- **Dialogue paragraphs**, including the European quotation-dash and guillemet
  styles. Relevant to the German corpus and to the LL pipeline. Currently
  represented only by the Deathstalker series (English double quotes) — the gap
  named in §13c.
- **Numbered / lettered paragraphs** (`§`, `1.2`, `(a)`) — pure text signal, no
  geometry. Present in the reference and legal material.
- **Verse, poetry, epigraphs** — excluded by category, per §13d.
- **Page-boundary junctions** — a short page-final line and a flush page-top
  continuation are **the two biggest false-break generators there are**. Mined
  labels resolve them for free, which is the single best argument for this
  channel over any geometric rule. **The eval MUST report page-boundary
  junctions as their own precision column.**
- **Column-boundary junctions** — the same shape one level down. Same column.

### 13h. Measurement protocol

**Held-out BOOKS only, never held-out pages** (§2). Degraded or re-rendered
variants of a held-out book leak it — §12e caught exactly that in the ocr
corpus and it must be closed over `sourceBook` in both directions here too.
The eval split must satisfy §13g's convention coverage AND hold at least one
tier-1 book (§13d).

**Four columns, always reported together. A single blended number about this
head is a reporting error.**

| column | what it is |
|---|---|
| **always-continue** | the do-nothing baseline. 0 breaks, 0 false breaks, recall 0. It is the number the model has to justify itself against. |
| **geometry-today** | the shipped ladder with no model: calibration + rungs 3–4 of `grouping.ts`. This is what users get now. |
| **flush-rule** | the phase-0 candidate of §13i. |
| **model @ τ** | the sweep. |

**Rows, broken out by junction type** — never blended:

1. **mid-page body↔body** — the clean case, and the one the 0.98 floor applies to
2. **page-boundary** — B opens a page
3. **column-boundary** — B opens a column
4. **post-heading / after a non-body block** — decided by rung 1, so it never
   reaches the model; reported anyway as a **correctness check on the hard
   rule**, because the real failure mode here is a category error becoming a
   paragraph error. A heading mislabelled `body` is where damage enters this
   stage from outside it.

**Per cell:** confident-break precision, break recall, false breaks per 100
pages, and the count the cell is computed over.

**End-to-end sanity, on the Kershaw run.** 17 pages, 24 body blocks, ~53 ink
paragraph openings, **5 paragraphs in today's export** (§13b). Report the
paragraph count after P0 alone, after P0 + geometry, and after P0 + model, beside
the ~53. This is the number to show the owner; the precision table is the
number that decides the ship. **And re-read the export's longest paragraph:
19,894 characters today. If it is still five figures, nothing shipped.**

**Noise floor.** §10c's measured floors — seed alone moves macro-F1 0.018 while
accuracy and page-exact are seed-invariant — are **category-head numbers and do
not transfer.** The `continues` head's seed noise is UNMEASURED. **Run
`blocks_v2_seed2` and quote break precision with its seed spread before
believing any delta**, exactly as v4 and v5 did. Distrust anything smaller than
the spread. And do not judge by `eval_loss`: §10c measured seed2 with the lower
loss at every epoch scoring within noise, its loss getting *worse* each epoch as
v4's improved.

**Label-run cascades** (§10c) apply here too and are worse for a binary head:
one near-tie can flip a page's worth of junctions. Re-measure on the full split
before concluding anything from a slice.

### 13i. Phase 0 — the geometric `flush` rule, as a measured candidate

Not a commitment. A candidate that is cheap because the dataset build produces
its scoring set anyway.

**The rule:** add `flush` as a third calibration convention, or as a geometric
rung in `grouping.ts` — *the previous line ends well short of the measure, AND it
ends with sentence-final punctuation, AND B opens with a capital or an opening
quotation mark* ⇒ break. Everything else in the flush convention continues.

**It is scored in the same table (§13h), against the same mined labels, as its
own column.** It ships only if its false-break rate is ~zero under the owner's
gate — the same 0.98 / ≤5-per-100-pages floors, which a deterministic rule
either meets or does not. If it does not, it waits for the model and nothing is
lost: the code is a dozen lines and the measurement is a column.

**It is worth trying first for two reasons.** It is deterministic and
fixture-testable, so it can ship before any GPU time is spent; and if it clears
the gate on flush books it raises the bar the model must beat, which is
information either way. **It does not replace the model** — it cannot read
dialogue, drop caps, or a paragraph that legitimately ends flush with the margin,
which is precisely the residue §9d decision 2 reserves for rung 2.

### 13j. Run plan and estimates

Order is forced: P0 gates the corpus, the corpus gates the run.

| phase | work | estimate |
|---|---|---|
| **P0** | paragraph-aware block splitter in foundry (`formBlocks` cuts on indent / gap / short-previous-line); fixture tests; re-run block formation over the paired books | code, ~1 day; compute over 7,950 pages, minutes |
| **P0b** | verify the trainer's per-field loss masking (§13f); convention census (§13c); `max_seq_length` re-measure (§13d) | ~half a day |
| **P1** | `align-epub.py` emits paragraph identity; junction projection; category derivation from markup; cross-checks; the words-per-paragraph gate | code, ~1–2 days; compute **< 1 hour** — himmler's alignment ran in **6.5 s** for 1,052 pages and every render/band/OCR artifact is already on disk |
| **P2** | encoder v6 branch (5 new fields + the answer field), byte-exact replay against a regenerated fixture, `blocks-publish.sh` unchanged | ~1 day |
| **P3** | **training run** — see below | **~5 h (paired-only) / ~9 h (union)** |
| **P4** | seed-2 control | same again |
| **P5** | merge on the Mac, score, τ sweep, quant decision, publish | ~half a day |

**Training time (estimate, from the run history).** v4: 798 steps in 3 h 04 m =
13.8 s/step. v5: 930 steps at 12.4 s/step ≈ 3 h 12 m, on 4,953 train rows.

- **Paired-only** (§13f fallback): ~7,950 pages, ~6,400 train rows after holding
  out three books → ~1,200 steps; sequences ~10% longer → ~14 s/step →
  **≈ 4 h 40 m**.
- **Union with masking** (preferred): ~11,400 rows → ~2,150 steps →
  **≈ 8 h 30 m**. An overnight run.

**1 epoch is the default** (§5: three runs out of three peaked at epoch 1).
Nothing about a second head argues for more, and the format is already solved.

**The rig protocol is §6's and is not optional.** Check `nvidia-smi` via
`ssh owens-pc` first — the 3090 Ti runs other jobs, idle is ≈2.4 GB. **The box
has a faulty fan**: watch GPU temperature, ~82 °C is normal, at ≥86 °C
`nvidia-smi -pl 270` immediately and 220 if it stays hot, and do not run it
unattended without the monitor. Stage through stdin over ssh and verify
`sha256sum` on both sides; conda is not on the WSL login PATH; the env is
`orpheus_train`; global options go BEFORE the `train` subcommand; **no `--merge`**
— merging happens on the Mac. Clear the WSL staging afterwards.

**Eval time (estimate).** Score through the path users actually run — the bundled
llama-server — never only the trainer harness (§8: the merged f16 scored
*better* than the NF4 trainer harness on the same eval). The Kershaw blocks stage
did 17 pages in 26 s; at ~1.5 s/page a 450-page eval is **≈ 12 minutes per
model**. The τ sweep is free: it re-reads answers already generated.

**Publish (§6 step 5, `tools/aligner/blocks-publish.sh v2-4b 6 <merged>`).**

- **Quantization: start at Q8_0.** §10c measured Q4_K_M costing 0.029 macro-F1,
  2.2 pts accuracy and **9.2 pts page-exact** on v4 — more than the entire v3→v4
  gain — while Q8_0 cost nothing measurable, and the `rubric v4 scoring` memory
  says the same. **But that was measured on the CATEGORY head.** A single-digit
  confidence field is a new kind of output and quantization noise on it is
  unmeasured. **Re-run the τ sweep on the quantized artifact and confirm the gate
  still clears** before publishing anything but Q8_0.
- **Fused vs adapter.** Criterion, not a guess: blocks ships today as a
  standalone f16 GGUF (`foundry-blocks-v1-4b.gguf`, byte-identical to
  `rubric-v5-4b-f16.gguf`), while the footnotes stage already ships as a 4B
  ADAPTER on `foundry:4b` with `--lora-scaled`. **If BookForge's
  `electron/blocks-server.ts` can serve `--lora-scaled` by publish time, ship an
  adapter** — one base on disk for blocks/ocr/footnotes instead of three
  full checkpoints. If it cannot, ship fused and revisit; do not hold the model
  for it.
- **Catalog:** `id: 'foundry-blocks-v2-4b'`, **`promptVersion: 6`**, rank above
  v1's. **Keep the v1 entry** — someone is mid-book on it (§ the rubric-models
  rule). **Add the encoder branch BEFORE the catalog entry** (§10b bug 1: a
  catalog id with no matching encoder branch falls through to v1 and gets served
  a retired taxonomy — the failure looks exactly like a bad model).
- The sha256 and byte count are pasted by hand into BOTH catalogs, on purpose.

### 13k. Explicit non-goals

Nothing in this run touches any of the following, and none of them may be
re-proposed as part of it:

- **No taxonomy change beyond v6's already-decided `discard`.** No new
  categories. The proposed `publisher` class (§11f item 4) stays PROPOSED and
  out of this run.
- **`table` stays merged into `list`.** Owner decision, Aug 1 2026, settled
  (§11b, and the v6 comment in the encoder). Do not re-propose splitting them.
- **Tesseract stays the only segmenter** (§5). No PP-Structure, no
  DocLayout-YOLO, no Surya. No `src=ocr|embedded` feature.
- **No class-prior percentages in the prompt**, no neighbour LABELS as a feature
  — both rejected in §5, and the second is doubly wrong here because the
  autoregressive target already carries the transition.
- **Abbreviations stay `list`** (measured worse, reverted).
- **Fiction dialogue stays `body`.** `quote` is typographic. 2,184 existing
  examples say so.
- **No relabelling of the hand-labelled corpus** for this run. Third Reich's v3
  relabel and the `blocks-detect-corpus.js` defects (§11c) are separate work and
  neither blocks this.
- **No hand labelling of paragraph boundaries, at all.** If a junction cannot be
  proven from the EPUB, it is dropped. The whole point of this channel is that
  the expensive artifact is already paid for.
- **No re-OCR of Twisted Cross** to "fix" the CropBox geometry (§11e — its
  labels are sound and acting on the claim would cost 3,982 hand labels).

### 13l. The two questions that need a green light

1. **Run the dataset build?** — P0 through P2: the paragraph-aware block
   splitter, the paragraph-identity emission in `align-epub.py`, the junction
   projection over the 15 paired books, the convention census, and the v6
   encoder branch. **No GPU, no model inference, ~3–4 days of work and under an
   hour of compute.** It produces the corpus, the convention census, and the
   scoring set that the phase-0 flush rule and every later measurement need — so
   it is worth doing even if the training run never happens.

2. **Run the training?** — P3 plus the P4 seed-2 control on owens-pc:
   **~5 hours paired-only or ~9 hours union, twice** (the control is not
   optional; the noise floor for this head is unmeasured). The GPU may be busy,
   the box has a faulty fan, and **no run starts without this green light.**
