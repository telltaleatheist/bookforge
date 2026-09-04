# The narration text pass

**One text-normalization definition, shared by the Orpheus training corpora and
BookForge's narration**, run as an intentional step the user queues and the book
remembers.

> Owen, 2026-09-04: *"We should make this its own intentional step that the user
> runs and persists, so we don't have to run it again. It runs the step on an
> epub that foundry exported/completed and it creates an updated epub. This
> should be a foundry step that's necessary before it goes to TTS."*
>
> And on where it sits: *"a step that can be performed at any point, including on
> an epub, but it's a computationally expensive step that needs to take place
> somewhere along the line, and everything after it is finalized/fixed … a step
> that goes in just like translate/simplify."*

---

## What the pass does

Three stages, over every text of the book, **in this order**:

| # | stage | what | where |
|---|---|---|---|
| 1 | **Punctuation** | canonical ellipsis `...`, the quote map, control characters and invisibles deleted, every space variant to U+0020, repeated spaces collapsed, `--` to an em dash, `?!!` to one mark, trailing line space trimmed. **Dashes the book printed are kept.** | `electron/tts-punctuation.ts` (spec `s1`) |
| 2 | **The number rules** | the shapes a narrator's reading is *guaranteed*: scripture, dates, clock times, money, percent, decades, ordinals, `#N`, comma-grouped and bare integers. Citation apparatus is left as printed. | `electron/tts-number-rules.ts` |
| 3 | **The model, on the residue** | a bare four-digit year, a range, a decimal — the judgements only the sentence can settle. Every edit passes a wall of validators; a rejected edit means the printed digits stand and the rejection is recorded by name. | `electron/tts-number-normalizer.ts` (`NORMALIZER_VERSION`) |

**The order is load-bearing.** `normalizeQuotes` turning `…` into `...` *after*
`applyNumberRules` had computed offsets would invalidate every one of them.

Stage 1 writes a book and stages 2–3 read it — two writes, not one. Stage 1's
offsets are into the printed book, and the number rules' `find` strings routinely
contain characters stage 1 created (`"250 members` opens with a quote the printed
book set curly). Composing them into one rewrite list would mean either refusing
every number that stands beside a canonicalized quote, or hand-merging
overlapping spans: a second coordinate system to keep true. Both writes go
through `writeNarrationEpub`, which proves every rewrite landed or destroys its
output, and the intermediate is content-addressed and reused.

**It is text only.** `excludeCaptions`, `excludeFootnotes` and `stripSupMarkers`
are all forced OFF, against `writeNarrationEpub`'s own defaults, because this
edits *the book on the chain*. A pass that removed an element would be refused by
`registerLedgerPass`'s structural invariant and by `verifyNarrationCarry`, and
would move every narration strike the user ever made onto the wrong paragraph.
The caption/endnote/marker cut stays where it always was: in the render door, on
the second file.

A punctuation span that would have to cross an `<em>` or a `<sup>` is **refused
and recorded**, never flattened. The receipt names each one.

---

## Where it runs

### 1. As a ledger pass — the main door

Kind `narration-text`, label **"Narration text cleanup"**, offered in
`BOOK_PASS_OPTIONS` beside `footnote-refs` / `simplify` / `translate`, planned by
`electron/processing-chain.ts`, queued through `processing:submit-chain`, run by
`electron/queue-steps/pass.ts`'s shared `passModule`, executed by
`runNarrationTextPass` in `electron/processing-passes.ts`. It never runs inline.

It records:

* `stages/NN-narration-text/diff.json` — the frozen receipt the versions page's
  **Review changes** reads (`writePassDiff` / `readPassDiff`);
* `stages/NN-narration-text/narration-text.receipt.json` — the full record:
  per-rule punctuation counts, every refusal, and the number pass's own unit
  record with every proposed edit and the validator's verdict on it;
* an `appliedPasses` entry and a **ledger entry** with the diff as its receipt.

**Nothing to do is a refusal by name.** A book that already carries a current
stamp gets a sentence saying so and nothing is recorded — `footnote-refs`' rule.
The one difference: a book that merely prints no curly quote and no digit is
still a real run, because the *stamp* is what unlocks the render.

### 2. As a CLI stage

```bash
python cli/bookforge-tts.py --narration-text --input book.epub
python cli/bookforge-tts.py --narration-text --project "<projectDir>"
```

It writes `<stem>.narration.epub` and `<stem>.narration.narration-text.json`
beside the input. A file that already exists and describes a **different** book
is never overwritten — `uniqueOutputPath` gives the new one its `" (2)"`. A
cleaned book whose receipt names *this* source at *this* version is reused.

`cli/narration-text-step.js` is the one door; `cli/narration-text.js` is the
standalone command; both call the compiled `runNarrationTextPass` — the same
function the queue job runs, never a reimplementation.

`orpheus-batch-render.js` and `orpheus-audiobook-render.js` run that step
**automatically** before the prep, because an unattended chain has nobody to ask.

### 3. On the streaming path — punctuation only

`electron/tts-api-server.ts` and `electron/reader-stream-bridge.ts`, in
`handleSpeak`, immediately before `splitForTts`: the text is passed through
`canonicalizePunctuationText` and nothing else. Stage 1 is pure and instant and
has no opinion to get wrong; stages 2 and 3 are minutes of model time over a book
and are a *pass*, not something to do to a paragraph somebody is waiting to hear.

The `.txt` audition path (`--tts --text`, `--tts --input passage.txt`) keeps
cleaning inline in `prepareNarrationInput` — a plain-text audition has no document
chain to carry a stamp — and now runs stage 1 before the numbers there too, so an
audition measures the pipeline it claims to.

---

## The stamp

```xml
<meta name="bookforge:narration-text"
      content='{"normalizerVersion":"n5","punctuationSpec":"s1","model":"qwen3.5:9b-q8_0","at":"2026-09-04T…Z"}'/>
```

Written into the OPF's `<metadata>` by `writeNarrationTextStamp`, read by
`readNarrationTextStamp` (both `electron/epub-processor.ts`). EPUB-2's
`name`/`content` form on purpose: it needs no `prefix` declaration on `<package>`,
every reader and validator ignores an unknown `name`, and both EPUB versions this
app writes carry it unchanged. A stamp already present is **replaced**, never
joined — two stamps would be two claims about one file.

The ledger says a pass ran on a *project*; the stamp says it ran on a *file*. The
render door is handed a file — by the queue, by the CLI, by a batch chain on
another machine — so the file has to answer for itself.

---

## The gate

Two gates, one meaning:

| gate | asks | used by |
|---|---|---|
| `narrationTextGate(bookPath)` — `electron/narration-text-pass.ts` | a **file**: is there a stamp, and is it this build's version? | `prepareNarrationInput`, `cli/narration-text-step.js` |
| `narrationTextReadiness(appliedPasses)` — `electron/narration-text-readiness.ts` | a **project**: is there a `narration-text` entry, and is it the LAST text-changing one? | the app's Narrate / Process door |

The project gate knows something the file cannot: a `simplify` or `translate`
recorded *after* the cleanup leaves the stamp on the book (those passes rewrite
text nodes, not the OPF) while making it a claim about text that is no longer
there. So the answer is three-valued, and the third value has its own sentence:

* **missing** — "This book has not had the Narration text cleanup, so its
  punctuation is whatever the book printed and its numbers are still digits.
  Narration reads the text exactly as it stands, so it has to run first."
* **stale** — "The Narration text cleanup ran, but a later pass rewrote the text
  after it, so what it cleaned is not what a narrator would be handed now. It has
  to run again." (Or, for a version mismatch: "…ran at n4/s1, and this build reads
  text by n5/s1. It has to run again.")
* **ok**.

`prepareNarrationInput` refuses with the file gate's sentence plus
`"(Narration was asked to read <book>; nothing was rendered.)"`. It does **not**
run the pass itself: an hour of model time inside a render's prep is exactly what
the ruling moved out of there.

"Everything after it is finalized/fixed" is what that staleness rule means in
code: the pass may be run at any point, and the TTS copy is always cut from the
book as it stands after it.

---

## Version bump policy

**Changing `electron/tts-punctuation.ts`, `electron/tts-number-rules.ts`,
`electron/tts-number-normalizer.ts` or `electron/prompts/tts-number-normalize.txt`
is a change to the TRAINING CORPORA's text transform.**

The orpheus-finetune side vendors BookForge's compiled output byte-for-byte into
`pipeline/normalization/vendor/` and drift-checks it on every training build
(`check_vendored.py`, `PROVENANCE.json`). A silent change there means a fine-tune
is handed text that is not the text it learned.

So, on any such change:

1. bump `NORMALIZER_VERSION` (`electron/tts-number-normalizer.ts`) and say in its
   comment what changed — a stale `.nN.` copy on disk is a claim about a pass that
   no longer runs, and the cache keys on it;
2. bump `PUNCTUATION_SPEC_VERSION` (`electron/tts-punctuation.ts`) when a
   punctuation rule changes;
3. **tell the orpheus-finetune side to re-vendor**, and mirror any new fixture
   case into `pipeline/normalization/fixtures/cases.json`;
4. re-run both suites and their harness:

```bash
npx tsc -p tsconfig.electron.json
node tools/test-text-normalization.js
node tools/test-narration-text-pass.js
node C:/Users/tellt/Projects/orpheus-finetune/pipeline/normalization/run_fixtures.js \
     --mode bookforge --bookforge <this checkout>
node C:/Users/tellt/Projects/orpheus-finetune/pipeline/normalization/run_fixtures.js \
     --compare --bookforge <this checkout>
```

Bumping the version invalidates every cached copy and makes every stamped book
read **stale** — which is correct: those books were cleaned by rules this build no
longer uses.

---

## What the training side should vendor

`pipeline/normalization/vendor/` currently holds

```
electron/ai-cleanup-prepass.js
electron/number-expansion.js
electron/tts-number-normalizer.js
electron/tts-number-rules.js
prompts/tts-number-normalize.txt
shared/text/line-join.js
shared/text/sup-markers.js
```

**Add:**

```
electron/tts-punctuation.js
```

It is a straight port of `pipeline/normalization/punctuation.js` — same exported
names (`PUNCTUATION_SPEC_VERSION`, `CANONICAL_ELLIPSIS`, `CANONICAL_DASH`,
`PUNCTUATION_RULES`, `canonicalizePunctuation`, `canonicalizePunctuationText`,
re-exported `normalizeQuotes`), same rules in the same order — and its compiled
form requires **only** `./ai-cleanup-prepass.js`, which is already vendored, so it
loads under plain node with no Electron stub. Once vendored, `punctuation.js` on
that side can become a re-export of it, and the two halves of the shared
definition are both BookForge's.

### Shared fixtures

`tools/fixtures/text-normalization-cases.json` is a copy of their
`fixtures/cases.json`, case ids kept, plus five of ours marked `added_in`:

| id | why |
|---|---|
| `leave-archive` | their `known_defect` — **fixed** in n5 (`isArchiveSigil`) |
| `scripture-cross-chapter` | Ask 2b: `(Col. 3:19-4:1 and parallels)` |
| `scripture-cross-chapter-endash` | the same range with an en dash |
| `scripture-verse-range-plain` | the other direction: a verse range is unchanged |
| `scripture-lone-ref` | the other direction: a lone reference is unchanged |
| `archive-sigil-not-prose` | the other direction: `The 11 men` is still read |

---

## The two rule fixes in n5

**Ask 2 — an archive sigil in front of a bare integer is citation apparatus.**
`HSG 11 Js. Sond. 298/38` read the `11`. `isArchiveSigil` admits a 2–4 letter
token that is entirely uppercase (`HSG`, `HH`) or carries a capital after its
first character (`GnH`, `AfW`), and only in front of a **bare integer**, so
`The 11 men` is still read.

The other half of that ask — an *abbreviation after* the span (`Js.`, `Sond.`) —
is **deliberately not adopted**. It would also match `the 11 U.S. soldiers`,
`3 Dr. Smiths`, and every other abbreviation prose prints after a number; and this
guard is shared with the model validator (`CITATION_CODE`), so a false positive
means the digits reach the narrator with nothing downstream able to convert them.
The sigil is a shape; "a period on the next word" is not.

**Ask 2b — a chapter-crossing scripture range orphaned its colon.**
`SCRIPTURE_REF` modelled the range's second number as a *verse* only, so
`(Col. 3:19-4:1)` emitted `…through four` and left `:1` standing — a *malformed*
number, worse than an unconverted one, and invisible to every downstream guard
(`NUMBER_DROPPED` watches the model, not the rules; `stillHasDigits` sent the
wreckage to the model, which correctly declined a fragment it could not parse).
The range now admits its own chapter: *"three nineteen through four one"*. The
keeper scans a generated matrix of every reference shape these rules claim and
asserts no digit-adjacent colon survives.

---

## Files

| file | what |
|---|---|
| `electron/tts-punctuation.ts` | stage 1, the shared spec (`s1`) |
| `electron/tts-number-rules.ts` | stage 2 |
| `electron/tts-number-normalizer.ts` | stage 3 + the record (`NORMALIZER_VERSION`) |
| `electron/narration-text-pass.ts` | the pass, the receipt, `narrationTextGate` |
| `electron/narration-text-readiness.ts` | the ledger-side gate |
| `electron/epub-processor.ts` | `readNarrationTextStamp` / `writeNarrationTextStamp` |
| `electron/processing-passes.ts` | `runNarrationTextPass` — the ledger pass |
| `electron/queue-steps/pass.ts` | `narrationTextStep` |
| `cli/narration-text-step.js`, `cli/narration-text.js` | the CLI door and command |
| `tools/test-text-normalization.js` | the shared fixtures + both fixes |
| `tools/test-narration-text-pass.js` | the pass over a real book, no GPU |
| `tools/test-narration-text-readiness.js` | the ledger gate |
