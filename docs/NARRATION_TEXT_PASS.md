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
| 3 | **The model, on EVERY block** | every judgement only the sentence can settle: number residue, abbreviations, all-caps runs, bracketed apparatus, spaced hyphens, roman numerals, footnote markers. Every edit passes a wall of validators; a rejected edit means the text stands as printed and the rejection is recorded by name. | `electron/tts-number-normalizer.ts` (`NORMALIZER_VERSION`) |

> Owen, 2026-09-04: *"send every single block through to be sure. I suspect
> deterministic decisions on this aren't the right way to do it. Let the model
> decide what should be updated."*
>
> So stage 3's selection is **not** a digit test. Every block of the book goes to
> the model — one call per block, `qwen3.8:27b`, temperature 0 — with the whole
> instruction set as the prompt. That cost is accepted for this pass because the
> pass runs **once** and the book keeps the result. The plain-text audition path
> (`--tts --text`) keeps the digit test: it has no chain, no stamp, and no book.

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

### What the model may and may not do

The model returns an **anchored edit list** — `{find, replace}` pairs, each a
verbatim span of the block — or an empty list. It never returns rewritten text.
Every edit is judged by `validateNumberEdits`, and the class it belongs to is
derived from the span (`classifyEdit`), never declared by the model.

A **number** edit has a lexical anchor: `keepsEveryWord` proves every prose word
of the find survives, and `NUMBER_DROPPED` proves every printed number came out
as words. Those invariants are unchanged.

A **text** edit — an abbreviation, an acronym, a bracketed aside — has no such
anchor: "Dr." → "Doctor" legitimately replaces the letters, so nothing can
compare the two sides word for word. What guards it instead:

| invariant | disposition |
|---|---|
| the find is verbatim in the block and occurs exactly once | `NOT_FOUND` / `AMBIGUOUS_FIND` |
| the find is at most 200 characters — a span, not a clause | `EDIT_TOO_LONG` |
| the replacement is spoken words, and carries no digit | `REPLACE_NOT_WORDS` / `DIGIT_IN_REPLACE` |
| the replacement is at most `4 × find + 40` characters | `REPLACE_TOO_LONG` |
| a **removal** is allowed only for a whole bracketed insertion | `EMPTY_REPLACE` |
| the text edits together replace at most 25% of the block (floor: 80 characters, so a heading's one edit is not refused) | `BLOCK_BUDGET` |
| at most 24 edits are accepted per block | `TOO_MANY_EDITS` |
| the edit may not touch a span the deterministic rules already rewrote | `OVERLAPS_APPLIED` |
| the span may not cross a text node — an `<em>`, a `<sup>`, a link | `SPANS_MARKUP` |

A block whose answer will not parse is retried once at the same settings
(temperature is pinned to 0 for every request), then recorded `UNIT_PARSE_FAIL`
with its text intact; more than 10% of blocks failing to parse fails the whole
pass by name. **A paraphrase is never silently accepted** — but see the OPEN
CONCERN below.

### The one-token law — what stands in for a lexical anchor

> Owen, 2026-09-04: for a non-number class the replacement must preserve every
> alphabetic word of the find, in order, EXCEPT the single token the class is
> allowed to change. **One-token edits only.**
>
> And the second adversarial review's ruling on top of it: the validator must
> verify that the replacement **is a reading of that token**.

A *number* edit has a lexical anchor: `keepsEveryWord` proves every prose word of
the find survives and `NUMBER_DROPPED` proves every printed number came out as
words. A *text* edit has none — "Dr." to "Doctor" legitimately replaces the
letters — so before this law the caps bounded size and nothing bounded meaning.
The adversarial review of 2026-09-04 measured what got through: a name swapped, a
negation flipped, an OCR "correction", a heading rewritten whole, an
89-character sentence 80 of whose characters were replaced. Every one is refused
now, and every one is a keeper test.

How it is enforced:

* the span's class is derived from the span (`classifyEdit`), never declared by
  the model;
* a span whose class is **other** — ordinary prose — is `NOT_A_CLASS`;
* at most **one** word token of the find may be missing from the replacement, and
  that one must be the class's own: a dotted abbreviation, a run of capitals, a
  roman numeral. Anything else is `WORDS_DROPPED`;
* a **spaced hyphen** edit may change no word at all — it is punctuation;
* a **removal** is allowed only for a whole bracketed insertion of at most three
  alphabetic words, so `[sic]` and `(see page twelve)` go and
  `(the guarantee would hold)` stays;
* a **number** reading may hold the find's own words, its number words and three
  joins, and no more — `WORDS_ADDED`, which is what stops
  "The 12 men who refused were shot" becoming "… were spared, and the men who
  shot" while passing every number invariant.

* **nothing may be ADDED** either — the replacement's words are the find's words,
  minus the token that changed, plus that token's reading, and no more
  (`WORDS_ADDED`). Without it a replacement could keep every word and append a
  sentence, or insert a "not";
* and the replacement must be **a reading of the token that changed**
  (`NOT_A_READING`). The model decides WHETHER a token is read differently;
  `electron/tts-spoken-forms.ts` decides what it may become:

| class | allowed reading |
|---|---|
| all-caps | its own letters, spaced (`FBI` → `F B I`), or its own word in ordinary case (`SAID` → `said`), **in that case exactly** — "The f b i had" was applied and written verbatim before the case was checked. The lower-cased reading needs **four letters and the lower-cased form to be an English word** in `electron/data/english-words.json`; a denylist could not bound an open class (OSCE, RSHA, SHAEF, BOAC, ICAO, IATA, ASEAN, SWAPO, UNITA, FRELIMO, COMECON, UNPROFOR, ELAS, EOKA, ODESSA all passed it). `US` and `WHO` get the letters reading only, by length. An acronym that happens to be a word (ARMS) keeps both readings, which is accepted. An acronym a person listed as *said as a word* (NASA, NATO, …) is read as printed |
| abbreviation | an entry from the curated table — Dr. Prof. St. Mt. Ave. Blvd. Rd. Jr. Sr. No. e.g. i.e. etc. vs. viz. cf. a.m. p.m. and the rest — in the case the table wrote it, all lower, or capitalized on the first letter. **An unknown abbreviation is REFUSED and named**, never guessed. Mr./Mrs./Ms. are deliberately absent — the prompt says to leave them |
| roman | exactly the cardinal or ordinal words of its value, with or without a leading "the" — **and only where a book prints a numeral**: after a part word, before a century, or after a name from the **curated regnal list** (monarchs, popes, emperors). "Any capitalized word" read "Doctor Smith MD" as "Smith one thousand five hundred". MD, CD, DC, MC, CV, MM, XL, DI, LI, IX, CIV and MIX are legal numerals *and* ordinary acronyms, and forcing them through the roman table made `M I X` impossible. **The letters reading is never forbidden** |
| bracket | **square** brackets: an interpolation of WORDS is READ — the permitted edit is to drop the brackets and keep the words (`[he said]` → `he said`) — and only apparatus is deleted (`[sic]`, `[12]`, `[ed.]`, `[…]`, `[*]`). **round** brackets: the author's, deleted only when the contents match an apparatus PATTERN with a digit, a citation abbreviation or a fixed editorial term (`(sic)`, `(see page twelve)`, `(emphasis added)`, `(Kershaw 1993)`, `(12)`), so `(note she wept)` and `(source of evil)` stay |

**A table key that is also an English word** (`no.`, `co.`, `am.`, `st.`) carries a
context rule and is refused without it: `am.` needs a number before it,
`st.`/`co.` a capitalized word on one side, and **`no.` must be NUMBERING
something** — a digit after it *and* a thing being numbered in front of it (a
capitalized word, a word like "file"/"doc"/"item", or the start of the block).
A digit alone was not enough: "The answer was no. 12 men voted" read "…was
number 12 men voted", taking the next sentence's number as its own. Without them
"a flat no. The committee" read "a flat number The committee" — the wrong word
*and* a fused sentence.

**A reading may not move the punctuation** around the word it changes: every
mark of the find outside the changed token must reappear, in order.

**An abbreviation whose period may end a sentence must keep it.** Asked of the
BLOCK at the token — what follows the *token*, not what follows the *find* —
because the prompt tells the model to widen a find until it is unique and the
guard used to switch off the moment it did. "Oxford St. The rain" reads "Oxford
Street. The rain" however wide the find is. The exception is a **title prefixing
a name** (`Dr.`, `Prof.`, `Mt.`, and `St.` when nothing capitalized already
stands in front of it): the capital after it is the name, not a new sentence, so
"Dr. Kempner" reads "Doctor Kempner".

**The ampersand** is its own class, and it has two shapes. A **spaced** `&`
reads "and". A **glued** one is a single token whose sides are read as class-3
tokens and joined by " and ": `AT&T` → `A T and T`, `R&D` → `R and D`,
`Smith&Jones` → `Smith and Jones`. A bare replace served both once, and wrote
`ATandT` into a book.

`classifyEdit` is per-token and position-aware: a period at the **end** of a span
is a sentence, not an abbreviation, so `He did not believe it.` is prose; a period
anywhere else is an abbreviation; a span-final one counts only when the table
already knows it.

The em dash is **the one character this pass may invent**. A spaced hyphen read
as a dash is checked by SHAPE — the replacement must be the find with its spaced
hyphens turned into em dashes and nothing else changed — so it works beside a
digit (`12 - and` → `12—and`), which it could not before: the find classified as a
number edit and the replacement was refused for carrying a digit.


## Where it runs

### 1. As a ledger pass — the main door

**The button is "Clean text…"**, on every EPUB version row of the versions page,
immediately left of "Narrate…" (`studio-versions.component.ts`,
`cleanNarrationText`). It submits through `processing:submit-chain` with the
pressed file as `sourcePath`, so the planner resolves the chain that file belongs
to and the pass cleans that book rather than the default family's.

The Narrate gate's offer (below) is the second door, not the only one — the first
cut of this work had no first-class control at all, which made the pass's own
"run it again" message name something the user could not find.

Kind `narration-text`, label **"Narration text cleanup"**, listed in
`BOOK_PASS_OPTIONS` beside `footnote-refs` / `simplify` / `translate` — a list
that **has no consumer today**: the passes modal it fed was deleted on
2026-08-18 and nothing renders it, so the entry keeps the data true and offers
nothing on its own. The live control is the **"Clean text…"** button above.
Planned by
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

**`--project` and `--input` are two different acts.** `--project` runs the app's
own pass (`planProcessingChain` + `runProcessingPass`), so the ledger, the
provenance record, the working-copy promotion and the narration re-cut all
happen exactly as they do from the button — writing a cleaned file *beside* a
project and touching nothing else left the project reading `missing` in the app
while its file carried a current stamp, which is the divergence that made the
re-run deadlock reachable. `--input` is the bare-EPUB door, for a file with no
project around it.

`--input` writes `<stem>.narration.epub` and
`<stem>.narration.narration-text.json` beside the input. A file that already exists and describes a **different** book
is never overwritten — `uniqueOutputPath` gives the new one its `" (2)"`. A
cleaned book whose receipt names *this* source at *this* version is reused, and
the reuse check enumerates **every** ` (n)` sibling: stat-ing only the bare name
meant that after one collision every later run minted a new copy and paid for a
full model pass while correctly-cleaned copies sat unread.

`cli/narration-text-step.js` is the one door; `cli/narration-text.js` is the
standalone command; both call the compiled `runNarrationTextPass` — the same
function the queue job runs, never a reimplementation.

`orpheus-batch-render.js` and `orpheus-audiobook-render.js` run that step
**automatically** before the prep, because an unattended chain has nobody to ask.

### 3. On the streaming path — punctuation only

**All three doors**, each immediately before `splitForTts`: the live stream
(`electron/tts-api-server.ts`, `electron/reader-stream-bridge.ts`, in
`handleSpeak`) and the persistent whole-book render the same bookshelf reader
plays from (`electron/book-render-service.ts`, both plan builders). The text is
passed through `canonicalizePunctuationText` and nothing else. Stage 1 is pure and instant and
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
| `narrationTextGate(bookPath)` — `electron/narration-text-pass.ts` | a **file**: is there a stamp, and is it this build's version? | `prepareNarrationInput`, `cli/narration-text-step.js`, and the Narrate gate for the pressed row |
| `narrationTextReadiness(appliedPasses)` — `electron/narration-text-readiness.ts` | a **project**: is there a `narration-text` entry, and is it the LAST text-changing one? | the app's Narrate door, over IPC `narration:text-readiness` |

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

A stamp this build cannot read — malformed, or written by a version that did not
record every field — reads **stale**, carrying the reader's own sentence inside
the reason. It never throws out of the render door.

**The pass guards itself with the LEDGER, not the stamp.** `simplify` copies the
OPF byte for byte, so a book cleaned and then simplified still carries a current
stamp while its text is no longer the text that was cleaned — which is exactly
why the project gate reports `stale`. Guarding the pass on the stamp made the
"Run cleanup again, then narrate" flow a hard deadlock: the pass refused as
"already done", the step failed, and the chained narration never ran. There is
one authority now, and "nothing to do" is a **success with a note** rather than a
failure, because work is chained behind it.

**Three answers, not two.** The readiness IPC returns the chain's answer *and*
the pressed file's own, because they can disagree:

| chain | file | what the modal does |
|---|---|---|
| not ok | — | offers the cleanup, chains the narration behind it |
| ok | not ok | "This version was exported before the cleanup" — offers to narrate the current book instead |
| unresolvable (two chains, the row names neither) | ok | proceeds; the file's stamp is authoritative |
| unresolvable | not ok | refuses, naming the chain problem and the file's reason |

The gate only fires when something will actually be **read** — a cache-context
run ("assemble the clips I already rendered") reads no book text and is not
asked about.

`prepareNarrationInput` refuses with the file gate's sentence plus
`"(Narration was asked to read <book>; nothing was rendered.)"`. It does **not**
run the pass itself: an hour of model time inside a render's prep is exactly what
the ruling moved out of there.

"Everything after it is finalized/fixed" is what that staleness rule means in
code: the pass may be run at any point, and the TTS copy is always cut from the
book as it stands after it.

### The gate is a question, not a lock

> Owen, 2026-09-04: *"If the user hits narrate before it does cleanup, it tells
> the user it still needs to do the cleanup step; then it does the cleanup step
> on whatever the last step they did before exporting the epub they were trying
> to narrate, and then they export the epub and queue narration."*

So the narration modal's `onSubmit` asks `narration:text-readiness` **before it
queues anything**. When the answer is missing or stale it shows a confirm dialog:

* **title** — "Narration text cleanup"
* **message** — the readiness sentence verbatim (see the three above)
* **detail** — "Run it now? The cleanup is queued first, and this narration run is
  queued behind it — it will read the book the cleanup produced. It is minutes of
  model time over the blocks of the book, and it only has to happen once."
* **confirm** — "Run cleanup, then narrate" (or "Run cleanup again, then narrate"
  when the state is stale) · **cancel** — "Cancel"

**Cancel** puts the readiness sentence in the dialog's error line and queues
nothing. **Confirm** queues ONE run through `QueueService.submitProcessingRun` —
which is `processing:submit-chain` with a `followOn` — so the whole thing is a
single queue-engine job with ordered steps:

1. `narration-text` (the pass, on the family's book)
2. `tts-conversion`
3. `rvc-enhancement` — when the run asked for it
4. `final-denoise` / `reassembly` — when the run asked for them
5. `video-assembly` — when the run asked for it

**What the follow-on narration reads is chosen by the PASS, not by the caller.**
The queue gives a chained step its parent's produced artifact and nothing else
(`queue-engine.resolveInput`: `sourceRef` is consulted only for a step with no
parent), and `tts-conversion` reads `ctx.input.path` with no config fallback. So
a caller "setting" `epubPath` on a follow-on job is inert — measured. The pass
therefore re-cuts the family's narration copy from the book it has just rewritten
(`ensureNarrationEpub`, which re-cuts exactly when `fromEpubSha256` no longer
matches) and names it in `PassJobResult.narrationInputPath`;
`queue-steps/pass.ts` produces that as the step's artifact. A re-cut that fails
is **said** — the pass still succeeded, the book is written and recorded — and
the chained step then reads the book itself, which `prepareNarrationInput` cuts
on its way in; what is lost is the user's own strikes, and the note says so.

The CLI's unattended chains do the same thing without asking, because they have
nobody to ask.

---

## What the pass will not touch

**A digit run glued to letters that OPEN a token** — `105mm`, `9mm`, `20km`,
`5kg`, `12V`, `8GB`, `6ft`, `4a`. That shape is a measurement or a designation
and its letters are a unit; this rule has no table of units, so it goes to the
model. The letter-prefix and hyphenated forms are exactly what the rule is for
and are untouched: `B-17`, `COVID-19`, `R2D2`, `F8F`, `C18`, `V-2`, `MP3`,
`7-Eleven`, `24-hour`, `30-year-old`.

**A digit run whose suffix another rule owns** — `mid-1920s`, `pre-1914`,
`mid-19th`, and the `<br/>`-fused forms `3rdday`, `21stcentury`, `90sera`. Those
are the decade, year and ordinal rules' shapes, and reading them here produced
`mid-one thousand nine hundred twenty s`.

**Preformatted text.** A `<pre>`, anything inside or containing one, and anything
whose inline style declares `white-space: pre` / `pre-wrap` / `pre-line` /
`break-spaces` is refused by BOTH stages and counted
(`NarrationNumberTarget.preformatted`). Everywhere else a run of spaces is a
layout artifact; in a code listing, an ASCII table or a verse laid out by hand it
is the content, and the pass rewrites the working copy — so collapsing it
destroys the user's book with only the archive to recover from.

**Footnote and reference markers.** The render door strips them from the
narration copy deterministically (`stripSupMarkers`). The prompt says so, and
does not ask the model for them.

**A span that crosses a text node.** Refused and recorded, never flattened.

Every refusal is counted in the receipt AND in the stamp
(`punctuationRefused`), so a book with three hundred unreachable ellipses is not
byte-indistinguishable from a clean one, and the "nothing to do" line on a second
run says how many spans it could not reach rather than claiming the book is
already canonical.

## The stamp's own version

`stampVersion` (currently **2**) versions the SHAPE of the stamp, apart from the
rules it records. It went 1 → 2 when `punctuationRefused` became required and the
validator learned that a reading must be a reading: neither is a change to the
punctuation spec, so bumping `PUNCTUATION_SPEC_VERSION` would have told the
training side a rule moved when none did, and `NORMALIZER_VERSION` is `n5` either
way because n5 has never shipped. What changed is what a stamp *means*, so books
stamped by an earlier build read stale **by rule** rather than by accident.

## Known limitation, not fixed here

`<br/>` fuses the words either side of it in the string the walk produces
(`<p>a<br/>b</p>` reads `"ab"`), so a heading split across a line break reaches
the rules and the model as `Chapter 1Dawn`. Pre-existing, and NOT fixed in this
pass: `getUnitTextContent` and `textNodeSegments` are one contract — the segments
are text-node lengths that must sum to `text.length` — and every offset in this
pass, in `applyNumberRules` and in `applyTextNodeRewrites` is expressed against
it. Inserting a synthetic space for a `<br/>` would make the segments describe a
string that is not the DOM's, which is precisely the class of bug the two-write
staging exists to make impossible. It belongs in the extractor, with its own
tests, not here.

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

**Add TWO files:**

```
electron/tts-punctuation.js
electron/tts-spoken-forms.js
```

`tts-spoken-forms.js` is what `tts-number-normalizer.js` now requires, and it is
a **leaf**: it imports nothing from this repo, so it drags nothing behind it. It
does read one DATA file at first use, through `fs` and `path` alone —

```
electron/data/english-words.json
```

— which decides whether a run of capitals is a word the author shouted or an
initialism. It is a positive list, compiled for this repository (no third-party
licence applies), and a word it does not carry is refused the lower-cased reading
and offered the spaced-letters one, which is the safe direction. Vendor it beside
the module. The number words a roman numeral may be read as are passed
*in* by the caller, which already has them — one definition, no second copy.

It is a straight port of `pipeline/normalization/punctuation.js` — same exported
names (`PUNCTUATION_SPEC_VERSION`, `CANONICAL_ELLIPSIS`, `CANONICAL_DASH`,
`PUNCTUATION_RULES`, `canonicalizePunctuation`, `canonicalizePunctuationText`,
re-exported `normalizeQuotes`), same rules in the same order — and its compiled
form requires **only** `./ai-cleanup-prepass.js`, which is already vendored, so it
loads under plain node with no Electron stub. Once vendored, `punctuation.js` on
that side can become a re-export of it, and the two halves of the shared
definition are both BookForge's.

### Shared fixtures — and what the training side owes

`tools/fixtures/text-normalization-cases.json` began as a copy of their
`fixtures/cases.json`, case ids kept. **The two files have diverged**: 104 cases
here against 53 there, and **until their file is updated the corpora and the
renders normalize differently** — by design, from rulings they have not mirrored,
not by accident.

| what | how many | which |
|---|---|---|
| expectations to **change** | 3 | `leave-page-cite`, `leave-doc-code`, `leave-glued` |
| `known_defect` now **fixed** | 1 | `leave-archive` |
| cases to **add** | 51 | every one marked `added_in` with its ruling or review row |

Those four changed expectations are exactly the four differences
`run_fixtures.js --compare` reports. The 51 additions cover the cross-chapter
scripture range, the archive sigil's opposite direction, the page and glued
readings, the unit suffixes, the `<br/>`-fused ordinals, and the
year/decade/ordinal shapes the glued rule must leave to the model.

A sample of the earliest of them:

| id | why |
|---|---|
| `leave-archive` | their `known_defect` — **fixed** in n5 (`isArchiveSigil`) |
| `scripture-cross-chapter` | Ask 2b: `(Col. 3:19-4:1 and parallels)` |
| `scripture-cross-chapter-endash` | the same range with an en dash |
| `scripture-verse-range-plain` | the other direction: a verse range is unchanged |
| `scripture-lone-ref` | the other direction: a lone reference is unchanged |
| `archive-sigil-not-prose` | the other direction: `The 11 men` is still read |

---

## Owen's 2026-09-04 revision of the leave-as-printed list

Two shapes moved OFF it, into rules of their own:

| printed | read | rule |
|---|---|---|
| `p. 23` | page twenty three | `page` |
| `pp. 65-71` | pages sixty five to seventy one | `page` |
| `COVID-19` | COVID-nineteen | `glued` |
| `B-17` | B-seventeen | `glued` |
| `I-95` | I-ninety five | `glued` |
| `7-Eleven` | seven-Eleven | `glued` |
| `R2D2` | R two D two | `glued` |
| `1940s-era` | nineteen forties-era | `decade` (it already owned it) |

Owen: *"COVID-nineteen is actually correct, that's how it's pronounced in real
life."*

**The cardinals are unhyphenated**, because that is what `cardinalWords` produces
and what the fine-tunes were trained on — `tts-number-rules.ts`'s own doctrine
note says the hyphenating `integerToWords` serves the OCR pass instead. So this
produces `I-ninety five` and `page twenty three` where the handoff's prose wrote
`I-ninety-five` and `twenty-three`: same reading, the corpus's own spelling. The
range word for pages is **"to"**, not the verse range's "through". The letters
are the book's and are never re-cased — `7-Eleven` keeps its capital E.

`CITATION_LEAD` lost `p.`/`pp.` and kept `vol. no. ibid. cf. fol.`. The guard is
shared with the model validator, so removing the page lead is what lets the model
read one too. The `glued` rule runs LAST of all the rules and refuses by shape,
not by list: a digit run over four digits, more than three runs, a leading zero,
a `/` on either side, or a `.` followed by a digit. `X-007`, `Z-12345`,
`A1B2C3D4`, `v1.2`, `298/38`, `Document II 9/34` and `AfW HH R 231191` are all
still printed as printed.

## Ask 2c — a comma is a separator inside one number

`NUMBER_DROPPED` counted runs of digits, and a comma splits one number into
several, so `"5,000 copies"` → *"five thousand copies"* was refused for having
two number words where three were demanded. Measured by the training side on
tr_dn3 (NORMALIZATION_SPEC.md §F4): it also refused `18,000-strong` and
`20-30,000`, and both rows still print their digits in the served corpus.
`digitRuns` now reads a comma-grouped number as ONE number. The floor it was
protecting still fires: `20:6` → *"twenty"* and `1914-1918` → *"nineteen
fourteen"* are both still refused.

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
| `tools/test-narration-text-two-family.js` | a TWO-CHAIN project, end to end, no GPU |
| `electron/tts-spoken-forms.ts` | what a token may be read AS — the curated tables (a LEAF: imports nothing from this repo) |
| `electron/data/english-words.json` | the word test behind the emphasis reading |
| `tools/test-prompt-examples.js` | every prompt example, through the validator that judges it |
| `electron/prompts/tts-narration-text.txt` | the wider instruction, appended to the number prompt |
| `shared/processing/book-passes.ts` etc. | the pass kind, registered in fourteen tables (that list itself has no consumer — see above) |
| `tools/test-prompt-examples.js` | every prompt example, through the validator that judges it |
| `studio-versions.component.ts` | the **Clean text…** button, beside Narrate |
| `electron/book-render-service.ts` | the third streaming door |
