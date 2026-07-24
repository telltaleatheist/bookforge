# AI Cleanup Testing Ledger

Results ledger for the AI cleanup (and simplify) pipeline experiments. Append every
experiment — configuration, fixture, measured outcome — so conclusions stay tied to
evidence. Campaign run 2026-07-22 → 2026-07-23 on cogito via local Ollama (RTX 3090 Ti),
always through the real code path: `cli/bookforge-tts.py --ai-cleanup` →
`cli/ai-clean.js` → `dist/electron/ai-bridge.js` (probes that bypass the CLI are marked).

## Method

- **Fixtures with known ground truth.** OCR noise injected into copies of real books
  with every injection logged (`noise_log.json`): the scorer knows exactly what damage
  exists, so FIXED / MISSED / MANGLED is mechanical, not judgment.
  - *Witnesses* first 3 chapters: 24 injections (21 in body prose, 3 landed in
    `<title>` metadata). Chapter 1 alone: 7 in-body injections, two of them
    letter-for-letter confusions (`dcmned`, `ministcrs`) used as withheld
    generalization tests.
  - *For the Soul of the People* ch. 1: genuine digit footnote markers 1..25.
  - *Black Sun* ch. 1: simplify fixture.
- **Collateral scoring.** Every run is diffed against its input and every change
  classified: quote normalization / footnote deletion / hyphen join (desired) vs
  prose deletion / word substitution with edit distance > 2 (damage) vs char repair
  with edit distance ≤ 2 (desired). Deletions are counted even when the output "reads
  fine" — that is the whole point.
- **Sequence ground truth for footnotes.** Genuine footnote markers form a complete
  ascending run 1..N per chapter. Any candidate detector can therefore be verified
  mechanically: right count, right values, perfect sequence, zero false positives.

## Experiments

### 1. Baseline: full-rewrite cleanup, cogito:32b, chunk 4000 (2026-07-22)

Witnesses 3-chapter noised fixture, shipped `tts-cleanup.txt` prompt, default
temperature (Ollama default 0.8). Fixed 20/21 body-prose injections — but deleted a
34-word gloss passage and drifted words (`Nonetheless` → `Nevertheless`). Simplify on
Black Sun ch. 1 with the same settings produced usable output (separate prompt path,
writes `simplified.epub`).

### 2. Temperature sweep: 0.1 / 0.6 / 0.8, identical input (2026-07-23)

| Event | 0.1 | 0.6 | 0.8 |
|---|---|---|---|
| 34-word German-Christians gloss | DELETED | DELETED | kept |
| part-one divider | kept | kept | DELETED |
| `past0rs` | MISSED | fixed | fixed |
| `chi1dren` | `child1dren` | `children` | `child1dren` |
| `unbri-\ndled` | `unbribed` | `unbribled` | `unrestrained` |
| OCR fixed / 21 | 20 | 21 | 20 |
| Quote runs lost | 5 | 5 | 7 |

**Conclusion: temperature is not the lever.** Every temperature deleted real content;
the same 34-word deletion occurred at 0.1 and 0.6. Deletions and drift are
prompt-driven (rules 1–2 of the shipped prompt), not sampling noise.

### 3. Thinking mode (chunk 2000, temp 0.6, chapter 1)

Cogito has **no** `thinking` capability flag in Ollama — `think:false` is a no-op.
Reasoning is triggered only by the literal phrase `Enable deep thinking subroutine.`
at the start of the system prompt, and arrives as in-band `<think>…</think>` text.

Thinking-only run: **zero deletions, zero quote loss**, `unbridled` correct — but
repair recall dropped (17 leftover hyphen splits vs 4; missed `c0nver`). Root cause:
the shipped prompt never authorizes character-level OCR repair, and two clauses
("leave as-is when unsure", "DO NOT make any other change") actively discourage it.
Un-thinking runs were doing the repairs by fluent-completion accident; thinking
obeys the prompt as written. **Thinking = restraint.**

### 4. Thinking leak incident → `extractAnswer`

At chunk 2000 with thinking, 2/23 chunks emitted `<think>` with **no closing tag** —
the old strip regex (`<think>[\s\S]*?</think>`) failed open and raw reasoning landed
in the book (+51 spurious quote runs, reasoning text replacing prose).

Fix (in `electron/ai-bridge.ts`): the prompt asks for the result in
`<answer>…</answer>` tags; `extractAnswer()` positively extracts the answer block and
**throws `REASONING_OVERRUN`** on any surviving `<think`, unclosed `<answer>`, or
multiple answer blocks. An overrun keeps the ORIGINAL chunk and records it in
`skipped-chunks.json` — **no retry** (see §8). Shared by the Ollama and local
llama.cpp paths.

### 5. Footnote-marker detection (deterministic, model-assisted)

- **Witnesses glyph markers**: OCR mis-decode of Mac OS Roman bytes 0xAD–0xBD, a
  substitution cipher for digits: `≠`0 `∞`1 `≤`2 `≥`3 `∂`4 `∑`5 `∏`6 `π`7 `∫`8 `Ω`9
  (proven by decoding to ascending 1..N per chapter). Deletion regex
  `[∞≤≥∂∑∏π∫Ω≠]+`. **Caveat:** four part-divider titles contain glyph-encoded year
  ranges (`1933–35` … `1945–50`) that must be *restored to digits*, not deleted.
- **Soul digit markers**: `(?<=[^\d][.?”])\d{1,3}(?![A-Za-z])(?=\s|$)` → 25/25,
  perfect 1..25 sequence, zero false positives.
- **Model-written regex is UNSAFE.** Asked directly for a regex, cogito produced
  `(?<=\.)\d+(?=\s|$)`: 90% precision / 75% recall — would corrupt decimals
  (`65.3`→`65.`) and missed all quote-anchored markers.
- **Parameter observation is SAFE.** Asked to fill in observed parameters
  (marker type, min/max, sequential, count, anchors) for a template with hard-coded
  safety invariants (never adjacent to a letter; ≤3 digits; non-digit before a
  period anchor), the model got everything right except `anchors` — and that failure
  was *fail-safe*: the composed regex found 0 matches and the count self-check flagged
  it. Anchors are better **derived** by walking the 1..N sequence (found `.`×18,
  `”`×5, `?`×1 → 25/25). **Law: the model observes; verified code generates.**

### 6. Detected-examples few-shot (generalization test)

A deterministic scan finds what code *can* find (digit-in-word damage: 16/16 in body
prose; line-break hyphen splits) and attaches the findings to the prompt as concrete
evidence plus "repair any other similar damage". Result: **all 7 chapter-1 injections
repaired including the two deliberately withheld letter-letter cases** (`dcmned`,
`ministcrs`) — the examples teach the *category*, and the model generalizes to
damage the scanner can't see. Hyphen joins rose 64 → 75.

No-thinking + examples control: still 7/7 repairs and 75 joins, zero quote loss —
but 4 prose deletions returned, including two lines of a pro-Hitler hymn (likely
content-flavored squeamishness, which does not prompt away) and
`unbri-\ndled` → "unbridged". Examples carry recall; **only thinking carries
restraint.**

### 7. Edit-list format (variants A/B/C, chapter 1 — scratchpad probes, direct Ollama)

The model emits `{"edits":[{"find","replace"}]}` instead of rewriting text; Python
applies with validation. Prose deletion becomes structurally impossible.

| | Full rewrite (think) | A: edit-list + think | B: edit-list, constrained JSON, no think | **C: pre-joined + edit-list + think** |
|---|---|---|---|---|
| Injections repaired | 7/7 | 5/7 | 4/7 | **7/7** (incl. both withheld) |
| Hyphen splits handled | 75/93 (model) | 21/93 | 17/93 | **93/93 deterministic pre-pass** |
| Prose deletions / insertions | 0 / 0 | 0 / 0 | 0 / **1 fabricated sentence** | **0 / 0** |
| Word-count delta | −20 | −20 | −9 | **−1** |
| Mis-copied finds (NOT_FOUND) | n/a | 19 | 31 | **3, all benign** |
| PARSE_FAIL chunks | n/a | 0/19 | 0/19 | 0/19 |
| GPU time | ~20 min | 8.7 min | 2.1 min | 7.9 min |

Findings:
- **Format reliability was never the problem**: 0 parse failures in 38 chunks, both
  with answer-tag JSON and with Ollama grammar-constrained `format` schema.
- **Exact-copy fidelity was**: the model reasons out correct repairs but cannot
  reproduce a damaged substring spanning `-\n` verbatim (normalizes the newline,
  drops a letter, re-hyphenates from memory). Every near-miss fails the
  exact-substring gate — safely discarded, but recall lost.
- **Fix: remove multi-line damage deterministically first.** Variant C pre-joins all
  93 hyphen splits before the model pass; NOT_FOUND collapses 19→3 and the two
  injections buried inside splits (`condcmned`, `c0nversion`) go from MISSED to
  repaired. FOUND_FUZZY (whitespace-tolerant rematch) fired 0 times — the pre-pass,
  not the fuzzy matcher, is the load-bearing fix.
- **Insertion loophole**: deletion-proof ≠ insertion-proof. No-think variant B
  appended a fabricated sentence through a `replace` field. The applier must cap
  `replace` length/word count relative to `find` (INSERTION_BLOCKED guard). B also
  regurgitated the few-shot list as literal edits and corrupted two proper nouns.
- Ollama constrained decoding (`format` + JSON schema) guarantees parseable JSON at
  the sampler level but **suppresses cogito's in-band thinking** — the two are
  mutually exclusive.

### 8. Retry policy

Retry only when the failure cause is **independent of the input** (network errors —
still retried with backoff). Content-correlated failures (reasoning overrun,
would-be repetition) re-fail on re-roll and multiply processing time; they fall back
to the original chunk immediately, recorded in `skipped-chunks.json`. Never a silent
fallback; never book-fatal.

### 9. Model-size sweep (variant C config on cogito:14b / cogito:8b)

| | 32b | 14b | 8b |
|---|---|---|---|
| Injections repaired | 7/7 | **7/7** (incl. both withheld) | 5/7 (coincidental) |
| Integrity violations | 0 | 0 | 0 |
| NOT_FOUND edits | 3 | 2 | **44** |
| PARSE_FAIL chunks | 0/16 | 1/16 | 0/16 |
| GPU time | 475s | **129s** | 96s |

**14b is the smallest production-safe model — a clean win at ~4× the speed.** Its one
defect in 16 chunks was a dropped `<answer>` tag (recall-only: that chunk held no
tracked injection; parse-fail degrades to original-kept + recorded).

**8b is disqualified on effectiveness but validates the safety thesis.** It cannot do
the job — it sprayed the five few-shot examples into nearly every chunk regardless of
content (its 5/7 was those sprays coincidentally landing) — yet its 44 garbage edits
caused **zero damage**: every one failed the exact-match gate. A model too weak to
clean the text is also too weak to hurt it. Caveat: cogito 8b is **Llama-3.1-based**
while 14b/32b are **Qwen-2.5-based**, so this is a family boundary as much as a size
step; a small-model retry should use a Qwen-family model, not this 8b.

Model guidance: **cogito:14b default for cleanup** (32b for zero parse-fail
exposure); **keep 32b for simplify** (full rewrite has no edit-list safety net; 14b
unprobed there); 8b never.

## Implementation (2026-07-23, merged to main in `feat/ai-cleanup-editlist`)

The target architecture is built into `electron/ai-cleanup-prepass.ts` (pure,
unit-testable: quote norm, hyphen pair extract/apply, footnote compose + self-check +
anchor derivation, damage scan/few-shot, guarded applier, `firstJsonObject`) and
`electron/ai-bridge.ts` (orchestration: per-book pre-pass planning calls, per-chunk
`cleanChunkEditList`, `edit-log.json` + `cleanup-prepass-report.json` written on
success AND error paths). Prompt: `electron/prompts/tts-cleanup-editlist.txt`.
Edit-list activates for the pure cleanup task only — NOT simplify/bilingual, NOT a
custom `cleanupPrompt`, NOT detailed-cleanup deletions (those require the deleting
rewrite the applier forbids). Simplify: thinking + `<answer>` wrapping centralized at
prompt assembly, 4000-char default chunk (cleanup 2000; explicit `--chunk-size`
wins), 40% catastrophic-loss gate → `'acceptance-gate'` skip reason.

Review fixes applied on top of the initial implementation (all unit-tested):
- **DELETION_BLOCKED letter-mass guard** — a long letter-bearing `find` with a short
  non-empty `replace` passed every guard; now `replace` may carry at most 3 fewer
  letters than `find` (repairs are ~1:1 in letters; footnote strips remove only
  digits/symbols).
- **`String.replace` `$`-patterns** — a `$` in a model `replace` was interpreted
  (`$&`, `$'`); function replacer keeps it literal.
- **Charwise quote fallback** — the match-rescue used `normalizeQuotes`, whose
  `‘‘`→`"` (2→1) and `…`→`...` (1→3) mappings shift indices and corrupt the splice;
  now a length-preserving single-char map, single-match only.
- **Edit-list `num_ctx`** — was sized by the rewrite-era input×2 estimate (~4k) while
  the calls generate a fixed 4096-token budget on top of prompt+input; thinking would
  overflow into overrun storms. Now budget-sized (`estimateNumCtxForBudget`);
  simplify estimate bumped to 3× for its in-band thinking.
- Footnote anchor derivation now rescues any failed self-check (count mismatch), not
  only zero matches — still gated by the same count + 1..N checks.

**E2E validation through the real CLI** (`bookforge-tts.py --ai-cleanup`, cogito:14b,
temp 0.6, Witnesses ch1-noised fixture, 19 chapters): **7/7 injections repaired, 0
prose deletions, 0 quote loss, 3m05s total.** Hyphen arbitration 87 pairs → 78 join /
9 hyphen / 2 unresolved-conservative (recorded); 1 chunk parse-fail (kept original,
recorded); audit files all written. Two recorded degradations: 14b reported
`has_markers=false` for the glyph-cipher markers (wrong, but fail-safe — nothing
deleted; glyphs are the pathological case; consider 32b for the one-off observation
call), and one benign overreach `Hapsburg`→`Habsburg` (spelling normalization, not
scanner damage — the guards permit letter-swaps in proper nouns).

**Simplify E2E probe** (`--ai-simplify --simplify-mode dejargon`, cogito:32b, Black
Sun ch. 1, 16 chunks @ 4000 default): thinking + answer-tag wiring active, num_ctx
12288 (the 3× bump), **zero reasoning leaks**, zero acceptance-gate false positives,
1/16 reasoning-overrun (kept original + recorded — the machinery working as
designed), chapter word ratio 0.81 (healthy simplify shortening, well clear of the
40% gate), output reads de-jargoned. 604s ≈ 38s/chunk with thinking.

Open: temperature
default for edit-list is 0.1 while the proven config ran 0.6 — untested at 0.1;
`cleanupText()`/`cleanupChapterStreaming()` single-chapter entry points still use the
legacy 8000-char full-rewrite path; resumed jobs re-run pre-pass planning (recorded,
chapter-consistent, but later chapters could get marginally different treatment).

## Target architecture (proven by §5–§7; not yet built into ai-bridge)

1. **Deterministic pre-passes** (whole book, verified code):
   footnote-marker removal (parameter-derived regex, 1..N sequence-verified) →
   line-break hyphen joins → quote normalization to ASCII.
2. **Model pass**: thinking + detected-examples few-shot, ~2000-char chunks, output
   is an edit list in `<answer>` tags — the model never rewrites text.
3. **Guarded applier**: exact-substring match; reject letter-deletions and
   insertions; log every applied/skipped edit. A failed edit means the original
   text stands.
4. **Failure handling**: no content-correlated retries; overruns and unmatched edits
   degrade to original-text-kept + recorded.

The shipped rewrite prompt's defensive rules (preserve quotes, don't delete, don't
reword) mostly exist to police a rewrite that no longer happens; the edit-list
prompt is far shorter. Open items: join-vs-keep-hyphen arbitration for genuine
compounds (AI verdict pass over extracted pairs, or char-LM perplexity à la
`dehyphen`); glyph year-range restoration for Witnesses part dividers;
simplify-mode evaluation of thinking (simplify is inherently generative — edit-list
does not apply there).
