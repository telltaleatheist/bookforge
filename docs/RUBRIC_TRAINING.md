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

Chain: bands (lines) → geometric splitter + Tesseract corroboration (blocks) →
boxes v6 (category + `continues`) → applier rules (paragraphs) → export. Every
deterministic stage is fixture-testable; both biases compose because splitting
runs before labelling and merging runs after.

---

# 10. Session log — Jul 30 2026 (read this first after a compaction)

Everything below is measured or shipped, not planned. Commits: `dbc7137`
(dagger + detect-on-import), `8be40d6` (ebooks/), `d2e15ef` (galley naming),
`be8919c` (label-check), `7a7e076` (corpus mode).

## 10a. What shipped

**rubric v4 is live and is the default.** Trained overnight (798 steps, 3h04m),
published as `rubric-v4-4b-Q8_0.gguf`, installed on Mac + Windows, catalog rank
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
path is COMMENTED OUT, not deleted. No fallback — cleanup fails loudly if dagger
is absent.

**Also shipped:** detect-layout prompt on PDF import (EPUBs never asked; a
born-digital PDF skips OCR and classifies immediately); `ebooks/` deprecated in
code (1,529 lines deleted, one copy of every book under `projects/`);
corpus-book mode (File → Open Corpus Book…, labels save to the book's own
`labels.json`, nothing enters the library).

## 10b. Three bugs found by testing, two fixed

1. **FIXED — `rubricVersionFor()` did not know v4**, so `rubric-v4-4b` fell
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
  measurable. `rubric-publish.sh` now takes the quant as an argument; decide it
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

### rubric — 13 hand-labelled books, 57,652 blocks
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

### galley — not built; the most material ready
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
   derived labels into the rubric corpus (backup already taken:
   `rubric-corpus-2026-07-30-pre-epub-derived.tar.gz`).
3. **Scale derivation to full books** — the 16× on subheading/caption.
4. **Rescue 12 orphan files** before deleting `ebooks/` — two are the only copy
   of a book whose project exists but whose `archive/` folder does not. Deleting
   also makes `scripts/reverse-migration.mjs` a one-way door.
5. **galley corpus**: convert ICDAR, build the scan↔EPUB sequence aligner
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

**rubric v5 training, on owens-pc.** Started 23:16 EDT, step ~96/930 at
12.4s/step, ETA ~3h. Launched per §6 exactly (that section is authoritative —
three of its four documented pitfalls bit before it was read: conda is not on the
wsl login PATH, the env is `orpheus_train` not `orpheus_ft`, global options go
BEFORE the `train` subcommand, and **no `--merge`** because the merge happens on
the Mac).

Profiles `rubric_v5` and `rubric_v5_seed2` are in `training_profiles.json` on
that box; the pre-run backup is `training_profiles.json.bak-pre-rubric-v5`.
Corpus staged at `~/rubric-v5/{train,eval}.jsonl`, log at
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
with a `labels.json`, and seven of those are labelled BY rubric-v4 and reviewed
by nobody. Under the old deny-list all seven would have been gathered as ground
truth. Skipped books are printed, never silently dropped.

Pre-flight that mattered: max token length **measured** at 10,402 against the
10,752 window, 0 examples over. `text_sft` refuses to truncate, so an unmeasured
longer page fails the run outright.

### 11c. OPEN BUG — `tools/rubric-detect-corpus.js` writes garbage silently

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

- **Training tab** (`/training`, nav rail after Queue). Three sub-tabs — rubric /
  dagger / galley — with per-book "mark reviewed". Only rubric books open in the
  editor; the other two are inventory and say so. 21 books listed.
- **Corpus books can now be OCR'd and pre-labelled**: `saveTrainingBlocks`
  (refuses on a book carrying hand labels; `force` moves them aside rather than
  deleting), `rubric-detect-corpus.js` with `--keep-pages` (a hard exclusion that
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

1. **Fix the two `rubric-detect-corpus.js` defects** (11c). Blocks everything else.
2. **v5 lands (~3h)** → merge on the Mac (`rubric-merge-mac.sh`, and note its
   best-checkpoint picker sorts by step number), score with
   `tools/rubric-score-eval.js`, then `rubric_v5_seed2` for the noise floor —
   seed alone moves macro-F1 0.018 here.
3. **OCR the remaining corpus books**, run v5 over them, hand-correct. This is the
   loop `rubric-report.js` exists to measure.
4. **A `publisher` class** — PROPOSED, not decided. Jacket blurbs and author bios
   currently land in `body` (measured: Nuremberg p2, Holy Reich p2), so they both
   pollute the largest class and get narrated. It must be ONE class, not
   front/back (two would each starve, as `table` did), content-defined rather than
   positional (which is why `front_matter` was retired), and `enabled: false` or
   it changes nothing downstream. Zero retired-class labels remain on disk, so
   there is no seed — it needs a labelling pass over the first ~8 and last ~4
   pages of each book.
5. **galley** — material is complete, corpus is not. ICDAR is 32,203
   character-aligned files (`[OCR_toInput]` / `[OCR_aligned]` / `[ GS_aligned]`,
   `#` unaligned, `@` insertion); converting to chat JSONL is mechanical. But
   ICDAR is 19th-century newspapers and BookForge serves Tesseract on modern book
   scans, so it is a pretraining stage, not the product. The domain half — the
   degradation ladder over ~84 born-digital books, blur ~2.0px, alignment
   collapses past ~8% CER — is still unbuilt, and the 5 real scan+EPUB pairs are
   the eval set, not training data.

   **Settle galley's applier contract before training it.** It rewrites text,
   runs upstream of both the EPUB and the narration, and is the only one of the
   three models that can invent a word. Dagger only deletes and still needed a
   subsequence guard.

   No public corpus fits this job. Every one is pre-1930, because aligned ground
   truth for a modern book needs the publisher's text, which is copyrighted.
   That makes your own scan+EPUB pairs the rare material, not the fallback.

---

## 12. Session log — Jul 31 2026: galley's corpus, built and gated

**Read this before touching galley.** The corpus is DONE and the harness is
done; nothing has been trained yet.

### 12a. State

| artifact | where | numbers |
|---|---|---|
| domain corpus | `training/galley/sft/` | 7,525 train / 1,491 eval, 61 books, **exactly 50% identity** |
| ICDAR pretrain | `training/galley/sft-pretrain-icdar/` | 3,571 rows, separate stage |
| mined pairs | `training/galley/pairs/` | 63 `*.pairs.jsonl` + per-book stats |
| tooling | `tools/galley/` | mine, gate, degrade, build, contract |
| scorer | `tools/galley-score.js` | not yet run against a model |
| profiles | `tools/galley/training-profiles.json` | `galley_v1_4b` + `galley_v1_06b` control |

**Eval baseline to beat: CER 1.129%** over 7 held-out books. "Always answer
`none`" scores exactly that with a perfect false-edit rate — which is why the
headline is a PAIR and neither number means anything alone.

### 12b. The contract is the safety, not the model

`tools/galley/edits.mjs`. An edit must quote its anchor verbatim, that anchor
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

`tools/rubric/continues-truth.py` derives the planned `continues` bit from page
geometry. `get_text('blocks')` merged five real paragraphs into one and `<p>`
extraction did the same, so boundaries must come from coordinates via a rule we
own. Coverage is **19–50%, not 100%**. It does yield 2,473 pair labels with no
hand labelling, hand-verified **12/12**, corroborated by wrap hyphens agreeing
with the geometry **132/133**. Cheap and already paid — not free.

Also: **`hungarys-admiral`'s "embedded text layer" is a GlyphLessFont — it IS
Tesseract output**, so it is not independent truth and rubric's book-spread count
is one book optimistic. All 57 galley books were scanned; none affected.

### 12g. Paragraph repair, measured

Audit of 772 blocks (`tools/galley/paragraph-audit.mjs`): wrap hyphens in
**17.1%** of blocks, genuine welded paragraphs in **0.29% of body blocks**. So
paragraph reflow does not earn a target and hyphen healing does — and 12c's fix
is what makes it learnable. No edit-format change needed; the join is already
one `before → after` pair in collapsed text.

### 12h. Next, in order

1. **Score v5** (`rubric-score-eval.js`) — accuracy and `list` F1, NOT macro-F1,
   which rises by arithmetic when a 0.00 class leaves the average.
2. **Install the galley profiles and train `galley_v1_4b`.** GPU may be busy;
   NEVER start without explicit green light. Then the 0.6B control.
3. **Score with `tools/galley-score.js`.** Read `rows made worse` FIRST.
4. **Integrate — user's instruction: swap galley in for the old cleanup path
   COMPLETELY, no commented-out fallback.** The old method is the Ollama
   whole-chunk rewrite in `ai-bridge.ts` (`cleanupEpub`, the `ocr-cleanup` /
   `bilingual-cleanup` jobs). Model dagger's integration. Note the shape change:
   old = rewrite a chunk of EPUB text; new = per-BLOCK edit list under a
   contract, which is a different unit and a different failure mode.
