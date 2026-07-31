# galley → the app: integration plan

**Status: PLAN. No app code written yet. galley is not trained yet.**

The instruction (Jul 31 2026): *integrate it the same way dagger was integrated —
except nothing gets commented out, galley replaces the old method completely. The
old method used smaller local models.*

This plan says what "completely" means, file by file, and leads with the one
measurement that decides the shape. Corpus state, training recipe and the reasons
behind them are in `RUBRIC_TRAINING.md` §12; this document is only about the seam
between the model and the app.

---

## 0. The correction that reshaped this plan

The pre-compaction note said the cleanup stage "rewrites a chunk of EPUB text with a
general model" and galley would be a different unit and a different failure mode.
Half of that is wrong, and the half that is wrong is the good half:

**The cleanup path is already an edit-list pipeline with a guarded applier.** It was
rebuilt that way after two shipped incidents (see the guard comments in
`ai-cleanup-prepass.ts` — a 2-char `find` MULTI-replaced across a chapter, and a
model freelancing footnote removal with bare-digit edits). `cleanChunkEditList` in
`ai-bridge.ts:2689` already asks a model for edits, not prose, and already refuses to
let the model write text directly.

So galley is not introducing the edit-list idea. It replaces the **model** inside a
pipeline shaped for it. The unit is close too: production chunks run 1400–1700 chars
(≈350–450 tokens) against galley's trained median of 188 and max of 1204 — in range,
though §4 has a caveat about uniqueness that follows from the size difference.

What is genuinely different is the **contract**, and that turns out to matter far
more than the unit.

---

## 1. THE MEASUREMENT: the two appliers are incompatible

`tools/galley/contract-crosscheck.mjs` runs every **gold** edit in galley's corpus
through the production applier. Gold, so every rejection is a contract mismatch, not
a model error. Over all 9,016 rows / 15,854 edits:

```
galley applier accepted rows:      4508/4508     ← the corpus guarantee holds
production applier reproduced row:  697/4508     DIFFERED: 3811

gold anchors present verbatim AND unique: 15854/15854
gold anchors absent verbatim:                  0
gold anchors a WORD-BOUNDARY guard rejects: 11502  (72.5%)

production dispositions over gold edits   (! = blocks a TRUE correction):
 ! NOT_FOUND                    8054  50.80%   "er. G" → "er G"
   APPLIED                      2949  18.60%   "|" → "I"
 ! INSERTION_BLOCKED            2059  12.99%   "t. \"you-b" → "t you b"
 ! DRIFT_BLOCKED                1245   7.85%   "” : :" → "”"
 ! QUOTE_EDIT_BLOCKED           1081   6.82%   "'" → "’"
 ! NUMERIC_EDIT_BLOCKED          351   2.21%   "&2" → "80"
 ! DIGIT_MUTATION_BLOCKED         80   0.50%   "22" → "72"
 ! DELETION_BLOCKED               18   0.11%   "ICHELLE w" → "w"
   FOUND_AFTER_QUOTE_NORM         16   0.10%   "6 it" → "6 It"
   MULTI                           1   0.01%   "’" → "’."
```

**The production applier lands 18.6% of galley's true corrections and blocks 81.4%.**

Piping galley through it would produce a model that scores well in `galley-score.js`
and does almost nothing to a book — the worst possible failure, because it is silent
and looks like success. This had to be measured before writing code, not after a
disappointing E2E run.

### Why, precisely

Every one of the 15,854 gold anchors is present verbatim and unique. Nothing is
malformed. Two structural facts explain the whole table:

1. **72.5% of galley's anchors sit mid-word.** `deriveEdits` widens an anchor
   character by character until it is unique in the block, so `"er. G"` is a normal,
   correct anchor. The production matcher requires a word boundary at any
   alphanumeric edge of `find` (`boundaryLookarounds`, `ai-cleanup-prepass.ts:1092`)
   — added because a general model emitted `find: "is"` and corrupted a chapter. Any
   mid-word anchor is NOT_FOUND by construction.

2. **The remaining guards encode "this model cannot be trusted with numbers, quotes,
   or word boundaries."** That distrust was *earned* — by a general instruct model
   asked to repair prose. But it is exactly galley's job description:
   `"&2" → "80"` is a numeric OCR misread, `"22" → "72"` is a digit misread, `"'" → "’"`
   is a quote misread, and `"d-b" → "d b"` is a wrap-hyphen repair that trips the
   insertion guard because the word count grows.

### The safety argument shifts, it does not disappear

These are two different safety models, not a strong one and a weak one:

| | production `applyEditList` | galley `edits.mjs` |
|---|---|---|
| Trust model | model may do anything → **semantic** guards on every edit | model is trained narrow → **structural** contract |
| Anchor | word-bounded, fuzzy ladder, up to 3 occurrences | verbatim, **exactly one** occurrence, no overlaps |
| Scope limit | per-edit distance/mass/digit/quote rules | per-block change budget (≤25% or ≤12 chars) |
| Prose deletion | impossible (letter-deletion guard) | impossible (same guard, see below) |
| Residual risk | model proposes something the guards happen to allow | model proposes a wrong-but-unique substitution |

galley's residual risk — a confidently wrong substitution the structure cannot catch —
is real, and it is precisely what the **false-edit rate** in `galley-score.js`
measures and what the 50% identity rows train against. That measurement is the
safety case. It replaces the guards; it does not merely accompany them.

**Two production guards survive because they never fire on gold** — 0 hits across
15,854 edits:

- `LETTER_DELETION_BLOCKED` — a letter-bearing `find` replaced by blank. galley never
  does this; keeping it costs nothing and closes the prose-deletion hole permanently.
- `SUSPICIOUS_GLOBAL` — subsumed by galley's stricter uniqueness requirement.

The other eight must go **for the galley path**. Record why in the code, so nobody
restores them later as an obvious safety improvement. `DELETION_BLOCKED` is the
closest call at 18 gold hits (0.11%, e.g. a running-head fragment `"ICHELLE w" → "w"`);
it goes too, because galley's block-level budget already bounds it.

**None of this changes the legacy path.** `applyEditList` keeps all nine guards for
simplify, custom prompts and detailed-cleanup deletions, which still use a general
model. Two appliers, two trust models, both correct.

---

## 2. Exactly what galley replaces

In `cleanupEpub` (`ai-bridge.ts:3049`) the edit-list cleanup runs in two passes:

```
stages: 'ocr' | 'tts' | 'both'          (required — no default, ai-bridge.ts:3350)

pass 1  runOcrRepair   chunk loop → cleanChunkEditList → repaired.epub   ← GALLEY REPLACES THE MODEL HERE
pass 2  runTtsPrep     runTtsPrepPass: footnote markers (dagger) +
                       quotes + number expansion       → cleaned.epub    ← UNTOUCHED
```

**Replaced:** the model call inside `cleanChunkEditList` — today
`callProviderExtracted` against whichever provider the user picked (local
llama-bridge, Ollama, Claude, OpenAI) with the `tts-cleanup-editlist.txt` prompt plus
a per-chunk few-shot built from `scanDamagedWords`.

**Untouched:**
- pass 2 in full (dagger, deterministic hyphen/quote/number passes)
- the deterministic pre-passes that run before pass 1
- simplify, custom `cleanupPrompt`, detailed-cleanup deletions → legacy full-rewrite
- the checkpoint, diff cache, skipped-chunks report, and `state.editLog` audit trail

**Deleted, not commented out** (per instruction), once galley ships:
`loadEditListPrompt`, `EDITLIST_PROMPT_FILE_PATH`, `electron/prompts/tts-cleanup-editlist.txt`,
`buildFewShotBlock`/`scanDamagedWords` if pass 2 has no other caller, `EDITLIST_NUM_PREDICT`,
and the `edit-parse-fail` / `reasoning-overrun` handling specific to a thinking model.

---

## 3. Files — mirroring dagger exactly

dagger is ~700 lines across four files. galley is the same shape.

| New file | Mirrors | Contents |
|---|---|---|
| `electron/galley-models.ts` | `dagger-models.ts` (265 ln) | catalog: HF resolve URL, sha256, bytes, rank; `bestInstalledGalleyModel()`, download/delete |
| `electron/galley-server.ts` | `dagger-server.ts` (80 ln) | `LlamaModelServer`, **port 8771**, `GPU_OWNER_GALLEY = 'llama:galley'`, `/completion` only |
| `electron/galley-repair.ts` | `dagger-footnotes.ts` (275 ln) | prompt build, arrow-list parse, apply, per-edit disposition records |
| `electron/components/galley-model-components.ts` | `dagger-model-components.ts` (58 ln) | Add-ons + first-run entry |

Ports in use: 8766 tts-api, 8769 rubric/llama-bridge, 8770 dagger → **8771 galley**.

### 3a. One contract implementation, three consumers

`tools/galley/edits.mjs` is currently the trainer's and the scorer's. The app needs
it too, and a second copy would drift — exactly the mistake `rubric-encoder.ts`
avoids by being THE prompt format with main never parsing answers.

**Port it to `shared/text/galley-edits.ts`** and have `tools/galley/edits.mjs`
re-export from the compiled output, the way `ai-cleanup-prepass.ts:68` already
re-exports `isWrapHyphenBreak` from `shared/text/line-join`. The self-test moves with
it and must keep running in CI.

The system prompt is part of the contract. It must be byte-identical to the one in
`build-corpus.mjs`, and — like rubric — the prompt goes to `/completion` **verbatim**
in Qwen3 raw form with `enable_thinking: false`'s empty `<think>\n\n</think>` block.
A server that re-templates feeds the model a shape it never saw.

---

## 4. The open question worth measuring before wiring: chunk or block?

galley trained on **blocks** (median 188 tokens). Production feeds **chunks** of
1400–1700 chars. Length alone is fine — a chunk is ≈350–450 tokens, well inside the
1204 max.

The risk is not length, it is **uniqueness**. galley learned to widen an anchor until
it is unique *within a block*. In a chunk four times larger, an anchor that would
have been unique is more likely to repeat — and a non-unique anchor is rejected by
its own applier. That would show up as quiet recall loss, the same failure mode as §1
in a different disguise.

Cheap to settle: run `galley-score.js` twice on the held-out books, once at block
granularity and once with blocks concatenated to production chunk size, and compare
CER reduction and rejection rate. If chunking hurts, feed galley paragraph-sized
units inside the chunk loop — the chunker already tracks paragraph structure
(`splitProseIntoChunks`, `chunkChapterProse`), and more, smaller local calls cost
little against a resident llama-server.

**Do this before writing `galley-repair.ts`**, since it decides that file's unit.

---

## 5. What the UI has to say now

Today the Cleanup step offers a provider + model, and that choice drives both passes.
After the swap, **OCR repair is not a provider choice** — it is one specific local
model, like dagger.

- `stages: 'ocr'` must not accept Claude/OpenAI/Ollama for pass 1.
- Missing model → the same hard, actionable failure dagger already throws
  (`ai-bridge.ts:3373`): name the model, its size, where to install it, and what the
  user can run instead. Not a fallback to the old path — that is the fallback rule,
  and it would silently produce different output from the same button.
- The provider picker still applies to simplify, custom prompts and translation, so
  it stays — but the Cleanup step must show, when OCR repair is on, that repair runs
  on galley regardless.

Touch points: `ll-wizard.component.ts` (`cleanupStages` signal, ~2987), the model/
provider controls in that step, and `queue.service.ts` (2872, 4511) which threads
`cleanupStages` through.

---

## 6. Order of work, with gates

1. **Train `galley_v1_4b`.** Profiles in `tools/galley/training-profiles.json`.
   **Never start a run without an explicit green light** — shared GPU, faulty fan.
   Then the 0.6B control.
2. **Score** with `tools/galley-score.js` on the 7 held-out books. Read
   **`rows made worse` first**. Beat CER 1.129% *and* hold false-edit rate low —
   neither number means anything alone.
3. **Settle §4** (chunk vs block) with the same scorer. Decides the call unit.
4. **Publish** the GGUF at Q8_0 — Q4_K_M cost more than the whole v3→v4 gain on
   rubric, and this task is near-verbatim string copying, where quantization hurts
   most. Catalog entry into `galley-models.ts`.
5. **Ship the contract** to `shared/text/galley-edits.ts`; re-point the tools at it.
6. **Server + catalog + Add-ons component.** galley downloadable, startable,
   GPU-arbitrated alongside rubric and dagger.
7. **Swap the call** in `cleanChunkEditList`; delete the old prompt path (§2).
8. **UI** (§5).
9. **E2E on a held-out book, diff-reviewed by eye in the Review Changes UI.** The
   corpus cannot catch a whole-book regression, and this is the last point where one
   is cheap to find.

Gates 1–3 are measurement; nothing in 5–9 should start before 3 answers §4.
