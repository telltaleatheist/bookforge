# Rubric — training briefing

**Current state as of Jul 30 2026.** Read this before touching the corpus, the
labelling flow, or a training run. It is a *state* document, not a log — the
chronological history lives in the `category-model-training` memory.

Rubric labels every text block on a page with what it **is** (body, chapter
opening, running head, footnote, caption, table fragment, …). That drives EPUB
export: what gets narrated, what gets dropped, where chapters split. See
`CLAUDE.md` § "Rubric — the page-layout model" for the serving side.

Goal: hand-label enough books that the model generalizes to layouts it has never
seen. **Not** an OCR-correction model — categorization only.

---

## 1. Where everything lives

| What | Where | Synced? |
|---|---|---|
| **MASTER corpus** | `~/Documents/BookForge/training/` (Mac) | **No** — machine-local |
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
- **The master lives outside WSL** — currently the Mac's `~/Documents/BookForge/training/`.
- **Keep many backups.** Take one before any destructive corpus operation
  (relabel, re-OCR, split change) and after any labelling session:
  ```bash
  tar czf /Volumes/Callisto/Shared/BookForge/training-corpus-backups/rubric-corpus-$(date +%F).tar.gz \
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
  caption recall 19/59 on trained data. Tool: `tools/rubric-replay.js`.
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

**Shipping: `rubric-v3-4b`** (Qwen3-4B QLoRA, Q4_K_M GGUF, 2.5 GB), served by the
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
  problem rubric already owns, at the cost of a heavy dependency and a second
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
     --project "<projects/{slug}>" --out ~/Documents/BookForge/training/{slug} --jobs 8

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
  --profile rubric_v4 \
  --train-data ~/training_data/block_categorize/train.jsonl \
  --eval-data  ~/training_data/block_categorize/eval.jsonl \
  --run-name rubric_v4 --out-base /home/telltale/xtts_ft train \
  2>&1 | tee ~/training_data/block_categorize/train_v4.log'"

# 5. Publish (on the Mac — needs llama.cpp + the HF token)
tools/aligner/rubric-publish.sh v4-4b ~/rubric-export/rubric-v4-4b-merged
```

**Block IDs are deterministic as of Jul 30 2026** (page + index + geometry/text
hash). An identical re-OCR reproduces identical IDs, so labels survive re-runs.
A re-OCR after a *segmentation code change* still re-mints (the hash moves), so
finish labelling — or export — before upgrading the post-processor on a book
mid-flight. Books OCR'd before Jul 30 carry the old random-suffix IDs until
re-OCR'd.

The headless Detect loop (see the CLIs): `cli/rubric-detect.js` paints a project
with model predictions and snapshots the run immutably in
`editor.rubricPredictions`; a human corrects in the picker (corrections are
inviolable — Detect never repaints them); `cli/rubric-report.js` diffs run vs
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

Rubric is one of three models that together turn a PDF into a clean, reflowed,
TTS-ready EPUB. The full pipeline, with each piece's status:

```
PDF → Tesseract lines → block formation (split-only refinement — SHIPPED e1fdfec)
    → RUBRIC: classify every block            (v4 training / shipping)
    → drop furniture, structure from labels   (headers/footers out; chapters,
                                               quotes, lists from label runs)
    → paragraph reflow                        (rubric v5 `continues` head — planned)
    → MARKER REMOVAL: strip footnote refs     (0.6B — corpus v1 BUILT)
    → OCR CORRECTION: fix the characters      (Qwen3-4B — designed)
    → EPUB with the book's real structure → TTS
```

The end goal, stated once: **a PDF in, a beautiful reflowed EPUB out** — original
paragraph breaks restored, footnote clutter gone, OCR garble repaired, chapters
and quotes structurally real so TTS reads a book, not a page scan.

### 9a. `dagger` — the footnote-marker remover (0.6B), trained Jul 30 2026

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
ordering is load-bearing). Legal inference-time features: rubric labels (list
blocks keep their numbers) and the chapter's expected next markers.

### 9b. `galley` — the OCR corrector (Qwen3-4B, 16-bit), designed Jul 30 2026

Named for the galley proof: in printing, a galley is the tray holding set type,
and the galley proof is the first impression pulled so a corrector can mark
errors before the forme is locked up. Reading a galley to catch what went wrong
in setting is the same job as reading OCR to catch what went wrong in scanning.

The three model names share a convention — a concrete object from the printing
and manuscript tradition, naming the thing the model works on: `rubric` (the
heading, historically inked red), `dagger` (`†`, the footnote reference mark),
`galley` (the proof you correct). The id carries version and size, because
`rubricVersionFor()` parses it: `galley-v1-4b`.

**Goal:** fix Tesseract's character errors ("bistory"→"history", `™`→nothing or
the right letter, umlaut damage) without touching anything that is already
right.

**Training data — where truth comes free (start with these 8, zero labelling):**
- The **5 aligned EPUB pairs** (matching proven at 98.8–99.9%).
- The **4 embedded-text-layer books** (Ethics, Admiral, Budapest, Deliverance):
  the PDF's own text layer is the truth, geometrically aligned to the same
  pages Tesseract read. Both sides already on disk from the Jul 30 re-OCR.
- Book count: measure the learning curve (the rubric method, §4) rather than
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
rubric, one serving stack for both. Train in 16-bit (the rig's own `ocr_repair`
profile note is binding: "quantization costs character fidelity"); block-level
sequences are short, so bf16 LoRA fits the 3090 easily. Judge by CER/WER
reduction AND false-edit rate on identity pairs, never loss.

### 9c. Paragraph reflow — rubric v5's `continues` head

The "restore the book's real paragraphs" goal is a LAYOUT decision (indent,
gap-above, wrap-hyphen evidence, sentence state), which is rubric's feature
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
