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
