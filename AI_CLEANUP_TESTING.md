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

**Killing America incident (2026-07-23, first real-book run, cogito:14b).** The model
proposed `{find:"is", replace:"are"}` — a grammar rewrite, not a repair — and the
applier's MULTI branch replace-all'd it **mid-word** across a chunk
(`punished`→`punarehed`, `this`→`thare`, `seismic`→`searemic`,
`tsunamis`→`tsunamare`, `exercising`→`exercareing`); two further drift edits
(`censored`→`canceled`, `Disney`→`defend`) passed the mass/size guards. Fixed in
`ccbf2ee` with three applier hardenings: **letter-boundary matching** (a find edged
by letters only matches at word boundaries, in all three match ladders),
**DRIFT_BLOCKED** (edit distance capped at max(2, len/4) — a repair fixes
characters, it doesn't swap words), and **SUSPICIOUS_GLOBAL** (>3 bounded
occurrences = global rewrite, rejected). Lessons: fixture probes under-sample the
edit *proposal* distribution — the guards, not the model, are the safety boundary,
and every new failure class showed up in the very first uncontrolled book; and a
cleanup **resume keeps already-completed corrupted chapters** — after an applier
bug, delete `stages/01-cleanup` (progress + cleaned.epub) and re-run fresh.

**Round 2 (same book, chapter 3/5 findings → `30ebaaa`).** Markers survived because
the observation sampled chapter 1 (genuinely marker-free → `has_markers=false`) and
the book's space-separated style (`.” 2 Next`) was inexpressible anyway; the model
then freelanced marker removal (`'9'→'and'`, `'6'→'However'`, `'8'→''`) and quote
fiddling (source `'70s` + model's `70s→'70s` = `''70s`). Fixes: alphanumeric (not
just letter) boundary guards; QUOTE_EDIT_BLOCKED (find/replace differing only in
quote chars); NUMERIC_EDIT_BLOCKED (digits-without-letters finds are never damage);
observation chapter picked by deterministic candidate density;
`space_between_anchor_and_marker` honored in composition; 3-digit cap when
numbering doesn't restart; and a **per-chapter deterministic sequence gate** — the
observed chapter's self-check doesn't vouch for other chapters, so each chapter's
matches must form their own strictly-ascending run (start ≤3 when restarting) or
that chapter keeps its digits, recorded in `chapterGateSkips`.

Known-unhandled edge cases (recorded here so they're deliberate, not surprises):
`<sup>` markers are flattened to plain digits by text extraction before we ever see
them — the XHTML often carries the semantic answer (`<sup>1</sup>`) and a
tag-aware detector would beat all text heuristics; footnote/endnote BODIES at
chapter ends are not removed (edit-list structurally can't delete, needs its own
block-level deterministic pass); roman/letter markers get no sequence gate;
boundary classes are Latin-only (Cyrillic/Greek text unguarded); a lone
`. 40 Million` that happens to fit a chapter's ascending run would still be
deleted; one verdict per unique hyphen pair applies to all its occurrences;
DRIFT_BLOCKED can reject a legitimately heavy repair (recorded, inspectable).

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

## Round 3 — CLI curveball campaign (2026-07-24, commits `aaf307f` + follow-up)

Method change per Owen: "kill BookForge and test via the CLI until we get it — few
books, throw curveballs. Test the absolute worst case scenarios." `--test-mode`
runs the FULL deterministic pre-pass with only ~5 model chunks, so each real book
costs ~1 minute. Books: Killing America (KA), 88 Reasons Why The Rapture Will Be
In 1988 (numbered-list trap, 131k-char single-file export), Between Resistance
and Martyrdom (Garbe — scholarly, 887k-char single-file export, adjacent `.”1`
markers), Christian Nationalists vs German Christians (1968 scan, ® glyph
markers), CIA Sabotage Field Manual (1944 scan), plus a synthetic `hellscan.epub`
(Aesop text + logged injections: digit-OCR, rn→m confusion, hyphen breaks,
scan-edge word truncation, fake non-sequential markers, running headers
`AESOPS FABLES 29`, merged words, stray apostrophes).

### Failures found → fixes (each proven offline on the real text, then live)

1. **KA retest count-mismatch (`aaf307f`)** — the model's observation had every
   quantitative field wrong (space=false, fb=line_end, count 47) while its own
   examples showed `ones. 1`. Old derivation trusted those params → 161 markers
   left. Fix: `deriveArabicAnchors` sweeps space × lookahead variants; each finds
   the longest consecutive ascending SUBSEQUENCE (confusables like `, 200
   million` no longer poison the run); anchors derived from run members only.
   Acceptance: full match set ascending + consecutive run ≥5 = sequence proof
   OVERRIDES the model count (recorded). KA offline: 220 markers deleted, 0
   suspicious, both user-reported spots clean.
2. **DIGIT_MUTATION_BLOCKED (`aaf307f`)** — `’70s`→`'90s` decade corruption had
   drift distance 1. Same digit COUNT but different digit VALUES is never a scan
   repair; blocked. (`30s`→`1930s` digit-add still allowed.)
3. **Giant-chapter observation truncation** — garbage-PDF exports put the whole
   book in one XHTML file; 131k chars blew past num_ctx, ollama silently
   truncated the INSTRUCTIONS away, and the model returned a book summary (no
   JSON). Fix: `pickObservationWindow` — deterministic densest ~12k-char window,
   newline-snapped, used for the model call AND the self-check. Failed
   observations now record `rawAnswer` (600 chars) for diagnosis.
4. **Model denial with provable markers (Garbe)** — model said has_markers=false
   on a book with 336 real markers. Fix: a denial is a qualitative claim;
   a derived consecutive run ≥8 (higher bar than the count override's 5) on the
   FULL chapter text overrides it, recorded. 88 Reasons is the trap case —
   numbered reasons 1..88 — and stays refused (its longest candidate run is 4:
   line-start list numbers never match the trailing-marker pattern).
5. **Chain-selective deletion replaces the all-or-nothing chapter gate** — one
   OCR-corrupted marker (Garbe's `26`→`211`) or one intruder (KA's `189`) used to
   strand a whole chapter's markers. Now `selectFootnoteDeletions` deletes ONLY
   longest-ascending-chain members and spares everything off-chain in place;
   refusals: chain <3, off-chain > max(2, 20%) (random prose gives ~2·√n chain ≈
   31% at n=39 — 80% membership still rejects non-marker patterns), restarting
   numbering whose chain starts >3. Values duplicated within a chapter are
   ambiguous and spared entirely. KA's three formerly-skipped chapters now clean
   13+18+13 markers while sparing [189,16], [12], [18]; Garbe cleans 32/39 and
   spares the corrupt/restarted tail.
6. **Space-only split allowance** — merged words (`aboastful`) are the most
   common repairable damage after digit swaps, but the insertion guard blocked
   the fix (word count grows), so the model either skipped them or dropped the
   article (`aboastful`→`boastful`, a 1-char-distance word deletion). An edit
   whose find and replace are IDENTICAL ignoring whitespace can only move word
   boundaries — exempt from insertion/deletion guards. Prompt now teaches
   merged-word splits and explicitly forbids guessing letters onto truncated
   words.

### Hellscan scorecard (full run, before fixes 5–6)

0 lost word-runs; 2/2 edge-truncated words survived untouched; 3/3 fake markers
preserved; 11/12 hyphen pairs joined (12th was double-damaged by the generator
itself); 7/9 digit-OCR repaired; 12/12 running headers still present (edit-list
structurally cannot delete them — known, needs a future deterministic
header/page-number pre-pass); 0/6 merged words split (fix 6 addresses);
0/7 stray apostrophes removed (QUOTE_EDIT_BLOCKED intentionally owns these —
TTS-harmless). Model-quality degradations, all within guard tolerance:
`ungratefu1`→`ungreatful` (typo introduced), `Unwi1ling`→`unwilling` (case lost).

### Recorded, deliberately unhandled

® glyph markers (nationalists: superscripts OCR'd to ®, only 7 in book, no
sequence provable — left in place, fail-safe); running headers/page numbers
mid-prose (needs its own deterministic pass); the observation model sometimes
misreports marker_type for glyph ciphers (14b, known since Witnesses).

### Wave-3 live confirmation (test-mode, cogito:14b, temp 0.6)

KA: applied, chain 24/24, spared [189] and [18] in place — zero chapter skips
(previously three whole chapters kept their markers). 88 Reasons: no-markers,
nothing deleted (correct — trap held). Hellscan: no-markers (fakes never
sequence), 11/11 hyphen joins. Garbe first pass exposed the last gap: the
observation is temperature-variant (has_markers flipped true this run, count 9,
wrong anchors) and the true-path attempt-2 only saw the 12k window, whose best
consecutive run is 3 → refused. Fix: EVERY failed window-based detect escalates
to a full-chapter detect (same acceptance bars, richer sequence source) — with
the exact bad observation from that run, full-chapter detect passes: chain
31/37, consecutive run 13, spared [211,10,1,1,1,4]. Both branches of the
model's coin-flip now converge on the same deterministic outcome.

### Capstone — full Killing America run (2026-07-24, post-`a0a541a`)

20 minutes (was 42), cogito:14b, temp 0.6. Space-marker leftovers: **161 → 7**,
and every survivor is a deliberate, principled spare: four markers that follow a
year/quantity (`2023. 5`, `1989. 20`, `2022. 23`, `40,000. 1` — the
non-digit-before-anchor invariant cannot distinguish these from decimals and
correctly refuses), plus the chain-spared `[12]` and the ambiguous duplicate
`18` pair. All three originally-reported problem spots are clean. Integrity:
0 prose deletions, 0 drift substitutions; guards blocked 22 bad edits (9 drift,
7 insertion, 5 numeric, 1 quote); 31 repairs applied. Fresh-book checks the
same wave: A Culture of Conspiracy applied with sequence-proof count correction
AND refused its notes-section chapter (18 of 38 off-chain); 30 Years a
Watchtower Slave (clean ebook control) correctly reported no markers.

## Round 4 — OCR-repair / TTS-prep stage split (2026-07-24, `feat/cleanup-stage-split`)

The single cleanup pass conflated two different correctness criteria: FIDELITY
(fix what the scanner broke) and SPEAKABILITY (remove what TTS shouldn't read).
Round 4 split the edit-list pipeline into two sequential passes inside the one
user-facing cleanup stage:

- **Pass 1 — OCR repair** (model): line-break hyphen joins + guarded edit-list
  repair, nothing else. The pre-model transform is now hyphen-joins-only; the
  model sees footnote reference numbers and curly quotes and is prompt-forbidden
  from touching either (guards block it structurally regardless). Output:
  `repaired.epub` + `repaired.diff.json` — the faithful text, first-class
  artifact (listed on the versions page as "OCR-Repaired EPUB"; future
  fine-tuned corrector slots in here; also reading/translation/training truth).
- **Pass 2 — TTS prep** (pure code, zero model calls, seconds): footnote-marker
  removal (chain-selection machinery relocated verbatim — spared off-chain
  values still survive, because pass 1 cannot repair corrupt markers like
  Garbe's `211`: the NUMERIC/DIGIT guards forbid it), then quote normalization,
  then NEW deterministic English number expansion
  (`electron/number-expansion.ts`): thousands separators, years-read-as-years
  ("nineteen eighty-nine", "twenty ten"), decades, ordinals, currency, percent,
  decimals. Ambiguous shapes are left as digits by adjacency guards, never
  guessed: colon refs (5:30 / 13:1), ranges (1914-1918), fractions,
  word-embedded digits (COVID-19). Output: `cleaned.epub` + `cleaned.diff.json`
  (still original→cleaned, so the editor diff view is unchanged).

Number expansion previously happened only at engine time (per-engine Python
copies of `normalize_for_tts`); baking it into cleaned.epub unifies all engines
— the engine-time normalizers now see no digits and no-op.

Consequences: checkpoint version 1→2 (a v1 resume would splice single-pass
chapters into a pass-1 build — discarded loudly, fresh start); stale
`cleaned.epub` deleted before pass 1 so a mid-run failure can't leave
disagreeing artifacts; `repaired.*` owned by the cleanup delete handler;
simplify + legacy full-rewrite paths byte-identical.

Validation: 136/136 unit tests (71 Round-3 regression + 65 new: every expansion
rule, every non-goal, idempotence, `ttsPrepChapter` orchestration). Live
test-mode runs — KA: repaired keeps 2,065 curly quotes + all 239 markers,
cleaned has 0/0; 229 markers removed, 2 off-chain spared, 362 numbers expanded.
Watchtower (clean control): pass 1 untouched, pass 2 pure TTS prep (461
numbers). Hellscan: fake markers correctly NOT treated as footnotes — they
expand as ordinary prose numbers, which is what the engine would have spoken
anyway. Note for future scoring: the "leftover space-marker" regex metric goes
blind after pass 2 (spared markers become words); score marker leftovers on
`repaired.epub`, speakability on `cleaned.epub`.

## Round 5 — OCR repair becomes a user choice (2026-07-28)

Round 4 split the pipeline into pass 1 (OCR repair, model) and pass 2 (TTS prep,
deterministic) but chained them unconditionally: every cleanup job paid for a
full per-chunk model pass, including books that were never scanned. That pass is
the entire cost of the job — pass 2 finishes in seconds.

Pass 1 is now opt-in per job, via `enableOcrRepair`:

- **On** — unchanged Round-4 behaviour: hyphen arbitration + per-chunk edit-list
  repair → `repaired.epub`, then pass 2 → `cleaned.epub`.
- **Off** — no chunk loop at all. The footnote OBSERVATION call still runs (one
  call; pass 2 needs its plan either way), the hyphen pre-pass is skipped
  entirely (line-break hyphenation is a scanner artifact), and pass 2 runs
  straight over the source EPUB. Output is `cleaned.epub` + `cleaned.diff.json`
  only — no `repaired.epub`, no chunk checkpoint, no pass-1 diff cache. A
  `repaired.epub` left by an earlier repair run is deleted, so the Versions tab
  can never offer an artifact that disagrees with the cleaned.epub beside it.

`enableOcrRepair` is REQUIRED on the edit-list path — `cleanupEpub` throws
without it rather than guessing. Jobs queued before this change fail loudly on
resume instead of silently picking a pass.

**Default comes from provenance, not from the selected file.** The wizard's
source picker always lands on `exported.epub`, which looks identical whether it
was typeset or scraped off a scan, so the default keys on
`manifest.source.type` (surfaced as `StudioItem.sourceType`): `pdf` → on,
anything else → off. The checkbox latches once the user touches it, and
re-decides when a different project is selected. Not offered with Simplify on:
that combination takes the legacy single-pass rewrite prompt, where the two
concerns aren't separable — the UI says so instead of showing a dead control.

CLI parity: `--ocr-repair` / `--no-ocr-repair` on both `cli/ai-clean.js` and
`cli/bookforge-tts.py --ai-cleanup`; required for a plain cleanup, ignored for
`--simplify` / `--cleanup-prompt` / `--detailed-cleanup` (paths that never
consult it).

Validation: live CLI runs on an 8-chapter EPUB, ollama/cogito:14b. OFF — 17s,
one model call (footnote observation, `has_markers=false`), 8 chapters through
pass 2, 2 numbers expanded, output dir holds `cleaned.epub` +
`cleaned.diff.json` + `cleanup-prepass-report.json` and nothing else. ON
(`--test-mode --test-chunks 3`) — 48s, `repaired.epub` + `repaired.diff.json`
written by pass 1, then pass 2 → `cleaned.epub`, same 2 numbers. Both TS
projects typecheck; renderer builds. NOT yet exercised through the app UI.

## Round 6 — footnote anchors: the closer is a SUFFIX, not an anchor (2026-07-28)

Killing America was run through cleanup and kept most of its reference numbers,
which pass 2 then expanded into words (`border. 5 Or,` → `border. five Or,`).
`cleanup-prepass-report.json` had the whole story, and it was a cascade, not a
near-miss:

1. Derivation walks a proven consecutive run and collects the anchor chars of its
   MEMBERS. KA's observation chapter (ch 6, picked on candidate density) had a run
   that happened to be all period-anchored → derived class `[.]`.
2. So every `mankind.” 2` in the book — period, then a closing quote, then the
   marker — matched nothing. The anchor char immediately before the space is `”`,
   not `.`.
3. In five chapters the invisible low markers left the survivors looking like a
   chain starting at 4-6, and `selectFootnoteDeletions` refuses a restarting
   chapter whose chain starts above 3 → those chapters were skipped WHOLESALE.
4. Chapters 1, 3, 11, 12 and 2 deleted nothing. 124 markers removed book-wide.
5. Number expansion then turned the survivors into words, making the miss
   unrecoverable and invisible.

Fixes, all structural — no thresholds tuned, no model trusted further:

- **Closing quotes/brackets are a SUFFIX on the anchor, never an anchor of their
  own** (`CLOSER_CLASS`, `anchorLookbehind`). Both derivation and composition use
  the same shape, so `basis. 16` and `mankind.” 2` derive the same anchor `.` and
  one class covers the whole book. Up to TWO closers — `blow a kiss!’” 16` closes
  an inner and an outer quote.
- **The decimal invariant applies only to glued markers.** `[^\d0-9]` before the
  anchor exists to stop `65.3`; `65. 3` with a space is not a decimal in any
  notation. Dropping the guard when the observation says space-separated is what
  finally makes a marker after a YEAR visible (`in 2022. 23 Also,`).
- **A bullet counts as "then a capital"** in the followed_by lookahead: it opens a
  list item exactly as a capital opens a sentence, and unlike a dash it can never
  be the left edge of a numeric range (`lurking. 27 • Inciting racial wars.`).
- **Number expansion refuses footnote-marker position** (`inFootnoteMarkerPosition`
  in number-expansion.ts): a 1-3 digit integer after sentence punctuation + closers
  + one space + whitespace + capital/bullet is LEFT AS DIGITS. The engine speaks
  "five" either way, so this costs nothing at playback and keeps a missed marker
  greppable instead of laundered into prose. Counted and reported as
  `ttsPrep.totalMarkerShapedLeft`, and logged as a WARNING — the honest miss count.

Measured (probes drive the real detectFootnotes → selectFootnoteDeletions path,
including planFootnoteRemoval's full-chapter retry):

| book | before | after |
|---|---|---|
| Killing America (deletions) | 124 | **230** live re-run (223 by probe) |
| Apocalypse Delayed (deletions) | 961 | **1000** |

No regressions: Apocalypse gains 39, all of them digit-anchored markers after
years/verse refs (`up to 1925.⟦67⟧`, `Genesis 3:15.⟦7⟧`) that the old decimal guard
was wrongly blocking. Every digit-anchored deletion in BOTH books was inspected by
hand — 4 of 223 in KA, 40 of 1000 in Apocalypse — and all are genuine markers.
Expansion spot-checks confirm ordinary prose is untouched (`He bought 5 apples`,
`In 1999, 40 percent`, `1. Get milk` all expand as before).

Known residue, NOT fixed — genuinely ambiguous, and widening for it would admit
the `. 40 million` confusables the sequence gate exists to catch:
- markers anchored on a COMMA and followed by a LOWERCASE word (`open borders, 33
  killing hundreds`) — still matched by nothing, and still expanded to words,
  because the expansion guard requires a following capital/bullet;
- markers after a BARE closing quote with no sentence punctuation (`“like
  semi-fascism” 3 But`);
- KA ch 12 accordingly still fails the gate ("chain starts at 4") and deletes
  nothing.
KA's live re-run reports 11 marker-shaped numbers left as digits.

Re-running is now cheap: `repaired.epub` is offered as a cleanup source, so
TTS prep can be redone over the already-repaired text with OCR repair OFF — the KA
verification run took 21 seconds.

## Round 7 — gap recovery: the chapter's own numbering as the evidence (2026-07-28)

Round 6 left a residue that no regex widening can safely reach: markers anchored on
a COMMA and followed by a lowercase word (`copies sold, 4 told us`), on a SEMICOLON
(`Origen; 73 and from`), or after a bare closing quote (`blow a kiss!’” 16`). Any
pattern loose enough to match those also matches `In 1999, 40 percent` — the
confusable the whole sequence gate exists to reject. Widening was the wrong tool.

The right evidence was already in the text. A chapter whose proven chain reads
1,2,3,5,6,7 is making a checkable claim: **marker 4 exists, and it lies between
marker 3 and marker 5.** `recoverGapMarkers` checks exactly that. For each value
missing from the chain it accepts a recovery only when BOTH hold:

1. the value occurs exactly ONCE in the whole chapter in loose marker shape — the
   same chapter-wide uniqueness test `allowedValues` has always relied on; and
2. that single occurrence lies inside the gap, after the previous chain member and
   before the next.

A prose number fails (1) almost always and (2) nearly as often. `In 1999, 40
percent` can only be recovered if 40 is a missing marker AND appears nowhere else
in the chapter AND falls between markers 39 and 41 — at which point it is a marker.
The loose pattern is never applied on its own; it is only ever a value filter over
a set both proofs have already closed.

**Every recovery in both books was inspected by hand — 29 in KA, 11 in Apocalypse,
40 of 40 genuine markers, zero false positives.** Apocalypse's are all
semicolon/exclamation anchors the derived class `[.?,]` cannot include.

| book | original run | Round 6 | Round 7 |
|---|---|---|---|
| Killing America | 124 | 240 | **274** (chapters skipped: 5 → 0) |
| Apocalypse Delayed | 961 | 1000 | **1011** |

Generality check — every project with a cleanup report was re-run through the real
`detectFootnotes` → `selectFootnoteDeletions` → `recoverGapMarkers` path:

| book | before | after |
|---|---|---|
| And the Witnesses Were Silent | no-markers, 0 | no-markers, 0 |
| Deathstalker Ghostworld / Hellworld (novels) | no-markers, 0 | no-markers, 0 |
| God's People | failed (count mismatch), 0 | failed (count mismatch), 0 |
| Apocalypse Delayed | 961 | 1011 |
| Killing America | 124 | 274 |

**No book that previously deleted nothing now deletes anything.** Nothing in Rounds
6-7 names a book, a value, or a chapter: the regex changes are typographic facts
(a closing quote is not an anchor; `65. 3` is not a decimal; a bullet opens an item)
and recovery reads each chapter's own numbering.

KA's remaining `markerShapedLeft` is 7 (was 11), still reported and left as digits.

Also fixed: the TTS-prep-only path deleted a stale `repaired.epub` before reading
its input — which broke the case the source picker now invites (re-run TTS prep
over the already-repaired text). It is skipped when it IS the source.

## Round 8 — three explicit stages (2026-07-28)

Rounds 5-7 exposed OCR repair as a boolean, which could only express two of the
three real jobs: repair+prep, or prep alone. There was no way to repair a scan and
STOP — yet `repaired.epub` is the artifact reading, translation and training data
actually want (faithful text, markers and curly quotes intact). The boolean is now
`CleanupStages = 'ocr' | 'tts' | 'both'`, required on the edit-list path:

- **`ocr`** — pass 1 only. The footnote OBSERVATION call is skipped too (its plan is
  consumed only by pass 2, so an OCR-only job no longer spends a model round-trip
  deriving a plan nothing will apply). Final artifact `repaired.epub`.
- **`tts`** — pass 2 only. Unchanged from Round 5. Final artifact `cleaned.epub`.
- **`both`** — pass 1 then pass 2. Both artifacts.

`cleanupWillProduce()` now returns `repaired.epub` for an `ocr` run, so a chained
translate/TTS step reads the right file instead of a `cleaned.epub` that was never
written. CLI is `--stages <ocr|tts|both>` on both entry points, replacing
`--ocr-repair` / `--no-ocr-repair`. Wizard shows a three-option picker (same styling
as the simplify modes) defaulted from provenance: PDF → `both`, anything else →
`tts`; the origin ("imported from PDF") is shown beside it.

Verified by CLI, Killing America: missing `--stages` fails loudly with the three
choices named; `tts` → 27s, cleaned.epub + cleaned.diff.json only, 274 markers
removed, 7 marker-shaped left; `ocr` (test mode) → 47s, "Footnote pre-pass: skipped
(OCR repair only)", repaired.epub + repaired.diff.json only, NO cleaned.epub;
`both` (test mode) → 64s, footnote plan derived, pass 2 ran, both artifacts present.
Both TS projects typecheck; renderer builds. App UI still not smoke-tested.

## Round 9 — line-start markers, and a false-candidate hole (2026-07-28)

Reported miss: `The father's leadership ... has often been ridiculed\n9 and the
mother's role redefined. 10 Non-biblical viewpoints`. Marker 10 was removed (period
+ space + capital); marker 9 was not. The source really does put a bare number
mid-sentence with no punctuation anywhere near it — PDF text-flow extraction pushes
the marker onto the next line, so the only signal is that it starts a line.

Two changes, and the second is the interesting one.

**(a) Line-start branch.** `LOOSE_MARKER_SOURCE` now also matches `\n<digits> ` —
digits opening a line, followed by a space and a non-space. Requiring the TRAILING
space is what keeps numbered list items out: `\n1. Get milk` has a period after the
digit, not a space. Only ever applied under gap recovery's two proofs, never alone.

**(b) The real reason marker 9 failed was too MANY candidates, not too few.** Value
9 had three loose candidates in that chapter:

    Numbers 24:9 in the Bible says,      ← matched via the ':' anchor
    Jeremiah 17:9 (KJV) says:            ← same
    been ridiculed\n9 and the mother's   ← the actual marker, correctly in the gap

Chapter-wide uniqueness failed, so recovery correctly refused. The scripture
references were posing as markers because the loose pattern accepted a colon
preceded by a digit. The loose anchor now requires a NON-DIGIT before the
punctuation, which rules out both shapes number-expansion.ts already declares out of
scope: colon references (`24:9`, `5:30`, `13:1`) and the fraction of a decimal
(`1.9 million` was offering `.9`). The decimal case was the more dangerous of the
two — a false candidate that won a uniqueness proof would have spliced a digit out
of a genuine number.

So the lever was making the candidate set STRICTER, not looser. Tightening it let
the real marker win its proof.

| book | original | R6 | R7 | R8 | R9 |
|---|---|---|---|---|---|
| Killing America | 124 | 240 | 274 | 274 | **284** |
| Apocalypse Delayed | 961 | 1000 | 1011 | 1011 | **1011** (unchanged — all its markers are punctuation-anchored) |

All 44 KA recoveries and all 11 Apocalypse recoveries inspected by hand with
context; every one a genuine marker, zero false positives. Live run: 21s, the
reported passage now reads `...has often been ridiculed\nand the mother's role
redefined. Non-biblical viewpoints...`, and `Numbers 24:9` / `Jeremiah 17:9` are
untouched. `markerShapedLeft` 7 → 6.

## Round 10 — structural markers: proof replaces inference (2026-07-28)

Rounds 6-9 reconstructed footnote positions from SHAPE, because that is all
`exported.epub` contains. Asked whether the system reads `<sup>` markup, the answer
was: only one of the two forms publishers use, and not the common one.

`EpubProcessor.extractTextFromXhtml` strips `/<sup\b[^>]*>[\s\d,;–—-]+<\/sup>/` —
digits **immediately** inside the tag. That is the Evans form (`<sup class="calibre11">55</sup>`).
The far more common form wraps the digits in the link back to the note:

    ...has often been ridiculed<sup><a href="#fn-9" id="fn_9">9</a></sup> and the...

That regex never matches it. Survey of 180 archived original EPUBs: **~70 carry
digits-only `<sup>` footnote markers, and the anchor-wrapped form dominates** —
Himmler 3509, Aryan Jesus 2120, Third Reich at War 2093, Third Reich A New History
2036, Stormtroopers 1761, Seeking a Sanctuary 1750, Killing America 321. The bare
form is real too (Hitler A Biography 4799, Fateful Choices 1740, Third Reich in
Power 1639), so both must be handled. Note **The Third Reich at War is 2093
anchor-wrapped, 1 bare** — its markers were never stripped, which is the documented
cause of the thirdreich model learning junk-means-STOP.

The information was never missing; it was discarded. So pass 2 now reads it back off
the **archived original**, which is never modified:

- `extractStructuralMarkers` — every `<sup>` whose TEXT is digits-only, with the ~34
  chars of plain text before it. Both forms, because the test is on text, not markup.
- `selectUniqueStructuralMarkers` — keep only markers whose context matches EXACTLY
  ONCE across the working book AND is followed by the expected digits. Two
  independent agreements; either failing is a silent miss, never a guess.
- `applyStructuralMarkers` — deletes in REVERSE document order. A marker's context
  contains the previous marker's digits (`...ridiculed 9 and the mother's role
  redefined.` is the context for 10), so removing 9 first strands 10. Found live:
  the first run removed 297 of 317; reversing took it to 317 of 317.

**Where structural proof exists it REPLACES the inferred machinery entirely** — no
derived regex, no sequence chain, no gap recovery, no relaxed guards. Those exist
only to reconstruct this, and each carries a false-positive risk proof does not.
This is the "back it off" the brief asked for.

Killing America, `--stages tts --structural-source <archive>`: 321 markers in the
original, **317 proven unique (0 ambiguous, 4 not found), 317 removed**, 24s.
Compare the inferred pipeline on the same book: 284, every one an inference. Both
`Numbers 24:9` and `Jeremiah 17:9` untouched; chapter count and text volume intact.
Leftovers reported as 6.

Wiring: `cleanupEpub({ structuralSourceEpub })`; the IPC handler resolves
`manifest.archive[role=original, format=epub]`; CLI `--structural-source <epub>`.
Absent or unreadable → the inferred pipeline runs exactly as before, so PDF-derived
projects are unaffected.

NOT yet done: the observation model call still runs before pass 2 even when
structural proof will supersede it (wasted round-trip, no correctness impact); and
export still flattens the markup, so every project keeps needing the archive
cross-reference rather than never having lost it.

## Round 11 — a deterministic pass should not need a provider (2026-07-28)

Reported from the app: a TTS-cleaning run on Killing America died with
`Ollama is reachable but not serving generate requests: HTTP 500`. The question that
came with it was the right one — why is the TTS step touching Ollama at all?

It was touching it twice, both avoidable:

1. **The footnote OBSERVATION call.** Round 10 left this running even when structural
   proof would supersede its plan, which for this book it entirely does (321 markers
   in the archived original). A model round-trip whose output is discarded.
2. **The provider preflight**, which runs before anything else in `cleanupEpub` and
   fails the whole job. This is what actually killed the run — the job never got far
   enough to discover it needed nothing.

Both are now gated on `archiveHasStructuralMarkers()`, a cheap read of a zip we
already have, evaluated BEFORE provider validation:

- `noModelNeeded` = archive has proof AND stages==='tts' AND not simplify / custom
  prompt / detailed deletions (mirroring the edit-list conditions). When true the
  provider is never contacted, the observation call is skipped, and
  `releaseCleanupModel` is skipped too — there is nothing loaded to release, and
  asking a wedged provider to unload only logs a confusing warning.
- Everything else preflights exactly as before: an OCR or both run makes per-chunk
  calls, and a `tts` run over a PDF-derived book still needs the observation call.

A TTS-cleaning run on a book with structural markers is now fully offline and
finishes in **1 second** (was 24s with the model call, or a hard failure when the
provider was unwell): 16 chapters, **317/317 markers removed**, "no model calls in
this job, skipping provider preflight" logged explicitly. Verified the gate is
conditional, not blanket: the same book without `--structural-source` still runs the
preflight.

Note for future testing: `--ollama-url` does NOT reach the preflight (it reads the
configured base URL), so pointing it at a dead port does not simulate an outage.

## Round 12 — Review Changes must show the footnote removals (2026-07-28)

Reported: markers 12, 13, 14 came out of the text correctly, but Review Changes did
not show them going. Other removals rendered as red deletion marks, so the missing
ones read as "where did those go?".

Chapter 1's diff recorded pure deletions for 4-11, 15, 17-24, 26-36 — and nothing
for 12, 13, 14, 16, 25. Every one of those five sits immediately after a CURLY
CLOSING QUOTE. Footnote removal and quote normalization edit adjacent characters, so
a raw original-vs-final word diff has no way to report two things: it emits a single
`”12` -> `"` change, which renders as a quote edit. The removal was real; the diff
just could not attribute it. Same reason `”1` showed up as `rem=[”1] add=["]`.

Fixed by giving the diff the INTERMEDIATE state to compare against:

- `ttsPrepChapter` splits its transform into `removeFootnotes` and the rest, and
  returns `footnoteOnlyText` — the chapter with markers gone but quotes and numbers
  untouched, built through the same chunk+rebuild path so it lines up exactly.
- `addChapterDiff` computes a second diff (footnoteOnly -> cleaned). Both diffs end
  at the same text, so their `pos` values share a coordinate space and compare
  directly. Any change the footnote-free intermediate does not account for — absent
  there, or present with less removed text — is one the marker removal contributed
  to, and gets `fn: 'archive' | 'inferred'`.
- The tag rides through `hydrateDiff` on DiffWord, into the view's change regions,
  and renders as a green-tinted change with a `REF` badge and a title explaining
  which evidence removed it.

Killing America: **327 footnote-tagged change regions for 317 markers**, all
`archive`. Over-attribution, never under — a removal whose ripple splits into two
regions tags both, and a region that merged a marker with a quote edit is tagged
because it did contain one. 12, 13, 14, 15 and 16 all now carry `fn=archive`.

## Round 13 — the export-side stripper (2026-07-29)

The `<sup>` stripper in `EpubProcessor.extractTextFromXhtml` required digits
IMMEDIATELY inside the tag, so it only matched the bare form. It now measures
digits-only on the sup's TEXT, catching the anchor-wrapped form too:

    <sup class="calibre11">55</sup>              bare           — always worked
    <sup><a href="#fn-9" id="fn_9">9</a></sup>   anchor-wrapped — never matched

Verified on Killing America's archived original through `getChapterText`: the
passage now reads `has often been ridiculed and the mother's role redefined.
Non-biblical viewp`, and `write in cursive.” Why would` — markers 9, 10, 12, 13
gone at extraction. Ordinals (`<sup>th</sup>`) and lettered superscripts are kept.

NOT a complete answer to "stop exported.epub losing the markup", and worth being
precise about why. `source/exported.epub` is built in the RENDERER and shipped to
main as a buffer (`audiobook:export-from-project`). The renderer's builder emits
`<p>${escapeHtml(text)}</p>` from an array of plain-text blocks
(`pdf-picker/services/export.service.ts`), so ALL inline markup — `<sup>`, `<em>`,
links — is destroyed by design, not by accident. There is nowhere in that model for
a marker to live. Preserving `<sup>` would mean teaching the block model to carry
inline spans through extraction, the editor UI, user text corrections and export:
an editor refactor, not a tweak. The loss is not styling, which is what makes the
"keep the text, drop the fonts" framing not quite apply.

I did NOT confirm which extractor feeds the editor's blocks when the source is an
EPUB, so I cannot claim this fix reaches `exported.epub`. It is a strict improvement
regardless — every `getChapterText` consumer (play view, translation, reader ingest,
chapter recovery) stops seeing endnote digits as prose — and it is the documented
intent of the code it corrects.

Standing options: (a) strip at extraction, this round, prevents the problem for new
imports; (b) the archive cross-reference, shipped in Round 10, already handles old
and new alike at 317/317; (c) preserve the markup, the refactor above. (a) and (b)
are complementary; (c) is only worth it if the editor should show and keep markers.

## Round 14 — why EPUB markup cannot "carry over" (findings, 2026-07-29)

Investigated carrying the original markup into `exported.epub` for EPUB sources.
It is not a matter of escaping less, and the reason is architectural.

**The editor never sees the EPUB's HTML.** An EPUB opened in the picker goes through
`electron/mutool-bridge.ts` — MuPDF's `mutool`, the same path a PDF takes. MuPDF
reflows the book into PAGES and returns positioned text runs with character-level
bounding boxes, font names and sizes. That is why an EPUB's blocks carry x/y/width/
height/font_size, and why `exported.epub` has hard line breaks at ~70 chars: it was
laid out, not parsed. By the time a `TextBlock` exists there is no `<sup>`, no
`<em>`, no heading tag — only glyphs, coordinates and font metrics. The markup is
gone at ingestion, long before `escapeHtml` in export.service.ts.

So preserving it would mean a SECOND ingestion path that parses XHTML into blocks
directly. The picker's UI is built on a paged, positioned model — page images,
bounding boxes, the region/label rail — none of which an HTML document has. That is
a new document pipeline in the editor, not a change to the export.

**But the intended hook already exists, dormant.** `MuToolBlock` declares:

    is_superscript: boolean;      // set to false at block creation, never computed
    is_footnote_marker: boolean;  // set to false at block creation, never computed

Both are hardcoded `false` (mutool-bridge.ts ~549-551). MuPDF already supplies what
would compute them: per-character font size and baseline. A digit run in a smaller
font on a raised baseline IS a footnote marker, in a PDF and an EPUB alike, and the
block builder already iterates characters with font info (it derives is_bold /
is_italic there the same way).

Recommended next step, NOT implemented: compute those two flags in mutool-bridge and
strip marker runs from block text at ingestion. It would work for PDF sources too —
which today depend entirely on the text heuristics of Rounds 6-9 — and would stop
markers ever becoming prose, in the editor and in exported.epub. Wants its own
session: thresholds need calibrating against real mutool output for both formats.

Until then the archive cross-reference (Round 10) covers EPUB projects at 317/317,
old and new.

## Round 15 — the ~70-char line breaks are an extraction artifact (2026-07-29)

Traced the hard line breaks inside paragraphs. `electron/mutool-bridge.ts:489`:

    const text = currentBlockLines.map(l => l.text).join('\n');

A mutool BLOCK is a paragraph-ish group of lines, and its `.text` joins those lines
with a literal newline. Nothing consumes that newline: `line_count` is its own field
(the viewer uses it for overlay sizing, category-learner for a feature), and nothing
in the picker or export splits block text on `\n`. It travels intact into
`<p>${escapeHtml(text)}</p>`, into exported.epub, into cleanup, and into TTS.

Both downstream joiners already do the right thing BETWEEN blocks —
`joinParagraphLines` (export.service.ts) and `joinMultipleLines`
(epub-paragraph-merger.ts) join with a single space and dehyphenate a trailing `-`
before a lowercase continuation. The within-block join is the one place that uses a
newline, and it is the earliest one.

So: not necessary, on a PDF or an EPUB. The fix is to join block lines the way the
other two joiners already join blocks.

NOT changed yet, deliberately — two things make it more than a one-character edit:

1. **Dehyphenation must move with it.** Joining with a space naively turns
   `recon-\nstruct` into `recon- struct`. The joiner has to strip the hyphen before a
   lowercase continuation, exactly as the downstream two do.
2. **It would obsolete a calibrated subsystem.** The cleanup hyphen pre-pass
   (extractHyphenPairs / corpus attestation / proveHyphenVerdict / model arbitration
   for unproven pairs) exists precisely to repair line-break hyphenation downstream.
   Fixing extraction removes its input for NEW documents while every existing
   exported.epub still needs it. That interaction wants deliberate validation, not a
   blind edit — run the picker over a PDF and an EPUB and compare before/after.

Worth doing, and worth doing carefully: it is the root cause of a class of TTS
prosody complaints, and it feeds the same text the hyphen pre-pass then spends model
calls repairing.
