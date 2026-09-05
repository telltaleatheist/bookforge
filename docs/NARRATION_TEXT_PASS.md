# The narration text pass

**One text-normalization definition, shared by the Orpheus training corpora and
BookForge's narration**, run as an intentional step the user queues and the book
remembers.

---

> ## THE DOCTRINE MOVED. FOUNDRY OWNS IT NOW.
>
> Owen ruled on **2026-09-05** that this pass moves into the **Foundry engine** as
> a third ledger action beside translate and simplify, named **"Clean text"**,
> hosted-only in Foundry's own UI: *"cleanup will only ever be done on behalf of
> bookforge and wont be available in foundry since foundry isnt designed to
> narrate text … we can add the step/logic to foundry, but only make it visible
> when vendored to bookforge."*
>
> **The authority on every judgement below is now Foundry's
> `docs/CLEAN-TEXT.md`.** Its body IS this document, vendored byte-identical from
> BookForge `0f962d5f` and edited only where it names a file path that has moved.
> Foundry owns `NORMALIZER_VERSION` and `PUNCTUATION_SPEC_VERSION`, and it is the
> source the `orpheus-finetune` training repo vendors from. **The version-bump
> policy near the end of this file is THAT repository's to obey, not this one's.**
>
> The modules went across verbatim — `f2e3c2d` (the pass's ten files) and
> `770480d` (the three leaves they import) changed not one byte, and
> `tools/test-foundry-clean-text-vendor.js` is BookForge's own proof of it,
> runnable here, against both repositories' git rather than either working tree.
> `215294a` then ported them into the engine: import retargets, four provably
> unreferenced declarations deleted, the word list imported instead of read off
> `__dirname`, and `narration-text-pass.ts` REPLACED by a book-file driver. That
> keeper pins those four files by sha256 with what changed in each, so the
> documented port passes and a later, undocumented edit fails.
>
> ### The engine's door
>
> ```
> foundry clean-text --book <book.jsonl> --records <out.records.jsonl>
>                    --stamp <out.stamp.json> [--endpoint <url>]
>                    [--model <name>] [--keep-model]
> ```
>
> It reads a **book file**, not an EPUB, and writes a **records file** and a
> **stamp**. **It writes no book.** The cleaned edition is materialised by
> Foundry's app from the records and the parent book together, exactly as a
> translation's is, and an EPUB compiled from a position at-or-under a `clean`
> step carries the stamp because `--narration-stamp` rides the `vlm-compile`
> line.
>
> ### What stayed in BookForge, and why
>
> Everything that READS the result. The engine has no applied-passes model, so the
> ledger side could not have gone with it:
>
> | what | where | asks |
> |---|---|---|
> | the stamp shape and parser | `NarrationTextStamp`, `readNarrationTextStamp`, `writeNarrationTextStamp` (`electron/epub-processor.ts`) | a FILE: what does the OPF's `bookforge:narration-text` meta say |
> | the file gate | `narrationTextGate` (`electron/narration-clean-text.ts`) | a FILE: is there a stamp, and is it this build's version |
> | the project gate | `narrationTextReadiness` / `narrationTextReadinessFor` (`electron/narration-text-readiness.ts`), over IPC `narration:text-readiness` | a PROJECT: is there a `narration-text` entry, and is it the LAST text-changing one |
> | the door's naming of the case | `prepareNarrationInput` → `NarrationPrepResult.cleanup`: `stamped` / `unstamped` / `skipped-by-user` / `normalized-inline` | this RUN: what was read, and what the log should say |
> | the queue kind | `FoundryJobKind` gained `clean` and `simplify` (`electron/foundry-host-queue.ts`); a press in the hosted window mints a row HERE, Foundry executes it | scheduling, which crosses; execution, which does not |
>
> **The stamp is a wire between two repositories that do not compile against each
> other**, so it is held by a keeper that drives the real engine:
> `tools/test-foundry-narration-stamp.js` runs `foundry vlm-book --epub` and
> `foundry vlm-compile --narration-stamp` over a fixture and reads the result back
> with BookForge's own parser and gate, field for field, in both directions — a
> stamp this build composed, and the exact bytes a real `clean-text` run wrote. It
> runs no model. A field renamed on either side would otherwise make every cleaned
> book read **stale** here, silently and forever, because the reader downgrades a
> stamp it cannot understand rather than throwing — which is right at a render
> door and is exactly what would hide it.
>
> **A `clean` row needs an engine that HAS the command** — foundry **1.1.0**
> (`ca7a666`). `FOUNDRY_VERSION_FOR_CLEAN_TEXT` + `foundryTooOldForCleanText`
> refuse an older one by name, in the step module rather than at `enqueue` (that
> door is synchronous by contract and asking a binary its version is a spawn),
> reusing the one comparator `foundryVersionAtLeast`. Only `clean` is gated: a
> simplify is `translate --rewrite`, a command every foundry this app has adopted
> has had. **The FAILSAFE has a second floor**, foundry **1.2.0**
> (`FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB` + `foundryTooOldForCleanTextEpub`, in the
> same file, on the same comparator): 1.1.0 has `clean-text` and not its `--epub`
> door.
>
> ### THE GAP IS CLOSED — foundry 1.2.0, and the failsafe is Foundry-backed
>
> Until 2026-09-05 the engine could not clean an arbitrary EPUB in place, so
> `runNarrationTextPass` still ran BookForge's own copy of the three stages for a
> bare book. That was measured against the 1.1.0 binary and all of it failed:
> `vlm-compile` has no `--records`, so compiling the parent book file wrote a file
> CLAIMING a cleanup over text nobody cleaned; and the round trip was not
> preserving — every original id gone, `OEBPS/chapter1.xhtml` become
> `EPUB/text/c0001.xhtml`, `dc:identifier` replaced.
>
> **Foundry 1.2.0 (`d6509e7`) shipped the door instead**, and it is a door onto
> the same pass rather than a second implementation:
>
> ```
> foundry clean-text --epub <in.epub> --out <out.epub>
>                    [--endpoint <url>] [--model <name>] [--keep-model]
> ```
>
> It rides `translate`'s EPUB route: `readFoundryBook` for the container chain and
> the admission rule, `findBlocks` for the same walk over the same stamped
> categories, `spliceAll` to put every answer back into the SOURCE RANGE it came
> out of. The container, the ids, the spine, the file names, `dc:identifier`,
> every `data-bf-*` attribute and every unedited byte survive **by construction**;
> the `bookforge:narration-text` meta is its only change to the package document.
> An EPUB with no `data-bf-cat` anywhere is refused by name and pointed at
> `foundry epub-stamp`.
>
> **So BookForge's own copy of the pass is gone.** `electron/narration-text-pass.ts`
> was deleted on 2026-09-05 and `electron/narration-clean-text.ts` is what stands
> in its place — a spawn, a version floor, a progress parse and the file gate.
> Owen's ruling for the act it serves:
>
> > *"the cleaning step can be done on an epub because the user might forget it
> > should be done at all, and they'll be asked to do it again. it should replace
> > the epub that's currently there if one already exists. if the user deletes the
> > epub and re-exports, the cleaning job will be lost. that's the cost of doing it
> > to an epub. the user can be informed of it. the bookforge clean text action
> > outside of foundry is a failsafe in case the user forgets and just wants to get
> > it done immediately. it won't be treated as the standard method."*
>
> ### What is still in this repository, and why
>
> | file | why it stayed | who imports it |
> |---|---|---|
> | `electron/tts-punctuation.ts` | `canonicalizePunctuationText` is **stage 1 of the STREAMING path** — the live stream and the whole-book render clean punctuation inline, because that is instant and a pass is not. `PUNCTUATION_SPEC_VERSION` is also what the two gates measure a stamp by | `book-render-service.ts`, `reader-stream-bridge.ts`, `tts-api-server.ts`, `parallel-tts-bridge.ts`, `narration-text-readiness.ts`, `narration-clean-text.ts` |
> | `electron/tts-number-normalizer.ts` | the **`.txt` audition path**. `normalizeTextBlocks` / `splitTextBlocks` are how `--tts --text` reads its numbers, and a plain-text audition has no book, no chain and no stamp, so it has no engine route. `NORMALIZER_VERSION` is the gates' other half | `parallel-tts-bridge.ts` (`normalizeTextNumbersFor`), `narration-text-readiness.ts`, `narration-clean-text.ts` |
> | `electron/tts-number-rules.ts` | stage 2 of that audition, unforked | `tts-number-normalizer.ts` |
> | `electron/tts-spoken-forms.ts` | the reading tables the one-token law consults, on that same path | `tts-number-normalizer.ts` |
> | `electron/data/english-words.json` | the caps reading's word list | `tts-spoken-forms.ts` |
> | `electron/prompts/tts-number-normalize.txt` | the audition's prompt | `ai-bridge.ts` (`loadNumberNormalizePrompt`) |
> | `electron/prompts/tts-narration-text.txt` | the wider instruction `loadNarrationTextPrompt` composes onto it | `ai-bridge.ts` |
> | `electron/ai-cleanup-prepass.ts`, `electron/number-expansion.ts`, `shared/text/line-join.ts` | work that has **nothing to do with narration**: `ai-bridge.ts`'s edit-list applier and `mutool-bridge.ts`'s wrap-hyphen rule | `ai-bridge.ts`, `mutool-bridge.ts`, and the three above |
>
> All eight are also the files `tools/test-foundry-clean-text-vendor.js` pins by
> sha256 against Foundry's own copies, so the versions the gates demand here are
> the versions the engine stamps there. **Editing one without the other is the
> keeper's failure, by design.**
>
> What DID go: `electron/narration-text-pass.ts` (the EPUB driver, the punctuation
> span differ, the two-write staging, the gate) and its keeper
> `tools/test-narration-text-pass.js`. The gate moved verbatim into
> `electron/narration-clean-text.ts`; the keeper's reading-law half — every ruling
> of the four adversarial reviews of 2026-09-04 — is
> `tools/test-narration-reading-law.js`, which runs against the vendored validator
> those two paths still depend on.

---

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
| 2 | **The number rules** | the shapes a narrator's reading is *guaranteed*: dates, clock times, money, percent, decades, ordinals, `#N`, comma-grouped and bare integers. Citation apparatus is left as printed — and so, since n6, is every **scripture reference**, which this stage only *detects and protects*. | `electron/tts-number-rules.ts` |
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

**IT IS THE FAILSAFE, AND IT SPAWNS THE ENGINE.** The exact argv:

```
foundry clean-text --epub <the book the ledger names> --out <stages/NN-narration-text/narration-text.epub>
                   --endpoint <ollamaUrl> --model <defaultLlmModel>
```

`--endpoint` and `--model` are read from `userData/app-settings.json` — the same
file the hosted **Clean text** dialog seeds its two fields from (`llm:defaults`,
foundry-app/electron/ipc.ts), read here by mirroring `clampModelTag` and
`clampOllamaUrl` rather than by importing into the sealed subtree, on
`standaloneFoundryProjectsRoot`'s precedent. The two doors cannot run a cleanup
against different models.

The book the ledger names may be an **exploded working copy**, and the engine
reads an archive, so a tree is packed beside the stage through
`copyBookIntoContainer` — the one copy in this app that proves its result entry
by entry — and removed once the run is over. The landing is unchanged:
`replaceBookEpub` converts the produced archive back to the book's own kind and
lands it with **one rename**, and the pass then asserts that what it landed on is
the book it read.

The floor is **foundry 1.2.0** (`FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB`, beside
`FOUNDRY_VERSION_FOR_CLEAN_TEXT` in `electron/foundry-host-queue.ts`, sharing the
one comparator `foundryVersionAtLeast`). An older engine is refused by name,
naming the release, before anything is spawned.

**The notice.** Both places the failsafe is offered — the "Clean text…" button's
confirmation and the "Yes" arm of the Narrate gate's offer — show
`NARRATION_TEXT_FAILSAFE_NOTICE` (`shared/processing/narration-text-notice.ts`),
one constant, verbatim: *this cleans the exported EPUB in place, deleting or
re-exporting it loses the cleanup, and the standard method is the Clean text step
in the Foundry window.* The finished row's summary says it again, because the
moment somebody is about to re-export is later than the moment they pressed.

It records:

* `stages/NN-narration-text/diff.json` — the frozen receipt the versions page's
  **Review changes** reads (`writePassDiff` / `readPassDiff`);
* `stages/NN-narration-text/narration-text.receipt.json` — **the engine's own
  `<out>.receipt.json`, moved into the stage rather than recomposed**: per-rule
  punctuation counts, every refusal, every block left exactly as printed, and the
  unit record with every proposed edit and the validator's verdict on it;
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

**`--input` REPLACES THE BOOK.** Owen, 2026-09-05: *"it should replace the epub
that's currently there if one already exists."* The engine writes a
`<stem>.bookforge-clean-<uuid>.epub` beside the input and that is renamed onto it
— one rename, within one filesystem, so a reader sees the old book or the new one
and never a half-written one. The engine's receipt is kept beside it as
`<stem>.narration-text.json`; its two sidecars, which are named off the staging
path, are removed rather than left as orphans.

That ends the `<stem>.narration.epub` sibling and the whole `" (n)"` reuse ladder
that went with it. **What makes a second run cheap is the stamp the first one
wrote**: the step asks `narrationTextGate` first and does nothing at all for a
book that already carries a current one. (Inside the engine, a run killed part way
resumes off its own `<out>.clean-bank.jsonl` and re-buys nothing.)

`--model` is **ignored and said to be ignored** on both routes: the model is the
engine's setting now, and honouring a tag here would run a cleanup the app's own
settings say nothing about.

`cli/narration-text-step.js` is the one door; `cli/narration-text.js` is the
standalone command; both call the compiled `cleanTextEpub` — the same door the
queue job runs, never a reimplementation.

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
      content='{"normalizerVersion":"n6","punctuationSpec":"s1","model":"qwen3.5:9b-q8_0","at":"2026-09-05T…Z"}'/>
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
| `narrationTextGate(bookPath)` — `electron/narration-clean-text.ts` | a **file**: is there a stamp, and is it this build's version? | `prepareNarrationInput`, `cli/narration-text-step.js`, and the Narrate gate for the pressed row |
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
  text by n6/s1. It has to run again.")
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

**The FILE decides whether to ask; the chain is the second source.** The
readiness IPC returns both, and the Narrate button reads them in that order:

| what answers | when | what the modal does |
|---|---|---|
| the file's stamp | always, when the pressed file can be read | current stamp → no question; no stamp, or a stamp at older rule versions → the offer, quoting the gate's own sentence |
| the chain's ledger (`cleanupDone`) | only when the file could not be read at all | ever cleaned → no question; never → the offer |

"Cleanup done" is **derived, never stored**. There is deliberately no
`cleanupDone` field on a project: a stored flag answers a question about the
PROJECT, while what a narration reads is a FILE, so it would skip the offer
exactly when the user narrates a reading that predates the cleanup. The stamp
travels with every cut exported after the pass, which is what makes "everything
they do after that carries the cleanup along" true in code — strike blocks,
simplify, translate, export again, and the cut still carries it.

The gate only fires when something will actually be **read** — a cache-context
run ("assemble the clips I already rendered") reads no book text and is not
asked about.

`prepareNarrationInput` **does not refuse**. It reads the stamp for what it says,
writes one line about it, and renders (see *Skipping the cleanup* below). It does
**not** run the pass itself either: an hour of model time inside a render's prep
is exactly what the ruling moved out of there.

"Everything after it is finalized/fixed" is what that staleness rule means in
code: the pass may be run at any point, and the TTS copy is always cut from the
book as it stands after it.

### The gate is a question, not a lock

> Owen, 2026-09-04: *"If the user hits narrate before it does cleanup, it tells
> the user it still needs to do the cleanup step; then it does the cleanup step
> on whatever the last step they did before exporting the epub they were trying
> to narrate, and then they export the epub and queue narration."*

> Owen, 2026-09-05: *"make it so i dont HAVE to run cleanup. give me a skip
> button on that cleanup modal that appears."* And: *"text cleanup should be an
> optional (but encouraged) step where the user runs it at any point and
> everything they do after that carries the cleanup along… If that flag isnt set,
> ask the user if they want to run cleanup on the document when they hit the
> narrate button. yes/no/cancel."*

So the narration modal's `onSubmit` asks `narration:text-readiness` **before it
queues anything**. When the file it is about to read is not cleaned it shows ONE
dialog with THREE buttons (`ElectronService.showChoiceDialog` →
`DialogService.choose`, the in-app dialog's third-button form — not two stacked
confirms):

* **title** — "Narration text cleanup"
* **message** — the gate's own sentence, then "Run it before narrating?"
* **detail** — "You pressed &lt;file&gt;. Yes runs the cleanup on this book first and
  queues this narration behind it, reading the book the cleanup produced rather
  than the file on the row you pressed — minutes of model time over the whole
  book, once, and everything you do afterwards carries it along. No narrates the
  text exactly as printed: a year stays four digits for the voice to guess at,
  and the punctuation is the book's own."
* **Yes, run cleanup then narrate** · **No, narrate as printed** · **Cancel**

**Cancel** queues nothing and says so in the dialog's error line ("Run 'Clean
text…' on this book when you are ready, or press Narrate again and choose 'No,
narrate as printed'."). **No** queues the run exactly as pressed, carrying
`textCleanup: 'skipped'` — see *Skipping the cleanup*. **Yes** queues ONE run
through `QueueService.submitProcessingRun` —
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

## Skipping the cleanup

> Owen, 2026-09-05: *"make it so i dont HAVE to run cleanup."*

### The flag

One field on the run, stated by the modal and never defaulted downstream:

```ts
// shared/queue/narration-run.ts
type NarrationTextCleanupChoice = 'required' | 'skipped';
NarrationRunSettings.textCleanup: NarrationTextCleanupChoice
```

* `'required'` — the ordinary case. The file the run is about to read carries a
  current stamp, or the cleanup is queued in front of this run, or an unattended
  CLI chain ran the pass itself.
* `'skipped'` — set **only** when the user was shown the offer above and pressed
  **No, narrate as printed**.

### Its path, from the button to the door

| where | what carries it |
|---|---|
| the modal | `NarrationRunSettings.textCleanup`, set explicitly before the settings are built |
| the run description | `NarrationTtsConfig.textCleanup` (`narrationTtsStep`); `requireNarrationRun` refuses a run that says neither, at runtime as well as in the types |
| the queue row | `TtsConversionConfig.textCleanup` (renderer) / `TtsConfig.textCleanup` (`electron/queue-steps/tts-conversion.ts`) |
| the conversion | `ParallelConversionConfig.textCleanup` — beside `skipAssembly`, because both are facts about the DOOR rather than about the voice. Not on `config.settings`: those are what `renderRangeHeadless` is handed, and it preps nothing |
| the door | `NarrationPrepOptions.textCleanup`, required, checked at runtime too (the CLI adapters are plain JS against the compiled bundle) |

`startParallelConversion` **refuses** a conversion whose config does not say — a
queue.json row from a build that had no such question fails with "press Narrate
again on the book's version row", it is not read as either answer.

### What the door does with it

`prepareNarrationInput` never refuses about the cleanup any more. It writes one
line and renders, and `NarrationPrepResult.cleanup` names which case it was:

| `cleanup` | when | the line |
|---|---|---|
| `'skipped-by-user'` | `textCleanup: 'skipped'` | `console.log` **and** `logger.log('WARN')`: *"narration text cleanup SKIPPED by the user for this run — numbers and punctuation are read as printed"* |
| `'unstamped'` | `'required'`, and the file carries no current stamp | `console.warn` + WARN, quoting the gate's own reason: the render reads it **as printed** |
| `'stamped'` | `'required'`, current stamp | the INFO line naming the stamp's versions and model |
| `'normalized-inline'` | a `.txt` input | this door reads its numbers itself; there is no stamp and no ledger to carry |

The skip's provenance is deliberately not a model tag: `reused: false` and
`model: 'skipped (the user chose to narrate as printed)'`, because no model read
this book and naming one would be a lie in the render's record. The WARN goes to
the job's own persisted log (`audiobook-logger`, under this job's id), which is
where a finished render's receipt is read back from.

**What the listener hears.** e2a has no number transform of its own (permanently
disabled, 2026-09-02), so a skipped run is narrated exactly as the book prints:
`1933` is whatever the voice makes of four digits, `23/3/1933` likewise, and the
punctuation is the publisher's rather than the canonical set the pass writes.
That is the choice the button offers, said plainly.

### Headless

`cli/orpheus-audiobook-render.js --skip-text-cleanup` is the same instruction
without a user: it skips `runNarrationTextStep` **and** passes
`textCleanup: 'skipped'` to the door, so the log names the skip instead of
reporting an absent stamp. Every other adapter passes `'required'`
(`cli/narration-prep.js`, `cli/orpheus-batch-render.js`), and `runNarrationPrep`
refuses a caller that passes neither.

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
training side a rule moved when none did, and `NORMALIZER_VERSION` moved on its
own account (`n5` → `n6`, the scripture ruling of 2026-09-05). What changed here
is what a stamp *means*, so books
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

**A THREE-PART CLOCK LEAVES A RAW COLON.** `He ran the marathon in 3:42:15.`
comes out `three forty two:15` — the book-less rule matches the first two parts
and its trailing lookahead (`(?![A-Za-z\d])`) is satisfied by the `:` that
follows, so half the time is read and the rest is left with a colon standing next
to a digit. That is the exact wreckage shape the Ask-2b comment says must never
happen, and it reaches the model, which correctly declines a fragment it cannot
parse. **Pre-existing — it is on `main` too** (found by the adversarial review of
2026-09-05 while probing this branch) and it is not this branch's to fix: the
book-less rule is untouched here on purpose, because every change to it is a
change to how `main` reads text that has nothing to do with scripture.

## Version bump policy

> **THIS SECTION IS FOUNDRY'S TO OBEY NOW** (Owen, 2026-09-05). The modules it
> names live at `src/clean/` in the Foundry repo, and `NORMALIZER_VERSION` and
> `PUNCTUATION_SPEC_VERSION` are read from there. It stands here because the
> BookForge copies are still on disk for the doors named in the ruling above, and
> **an edit to one of them without the matching edit in Foundry is the drift both
> keepers exist to catch** — `test-foundry-clean-text-vendor` fails on the bytes
> and `test-foundry-narration-stamp` fails on the versions.

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
node tools/test-narration-reading-law.js
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
`fixtures/cases.json`, case ids kept. **The two files have diverged**: 132 cases
here against 53 there, and **until their file is updated the corpora and the
renders normalize differently** — by design, from rulings they have not mirrored,
not by accident.

| what | how many | which |
|---|---|---|
| expectations to **change** | 3 | `leave-page-cite`, `leave-doc-code`, `leave-glued` |
| `known_defect` now **fixed** | 1 | `leave-archive` |
| cases moved `rules` → `model` | 9 | every `scripture-*` case, from the n6 ruling: the deterministic pass no longer reads a reference, so `want` is what the MODEL must produce |
| `known_defect` now **deferred to the model** | 2 | `scripture-ref-abbrev-numbered-book`, `scripture-ref-abbrev-plain-book` — their two 2026-09-05 cases, ids kept, at stage `model` |
| cases to **add** | 64 | every one marked `added_in` with its ruling or review row |

Those four changed expectations are exactly the four differences
`run_fixtures.js --compare` reports. The 56 additions cover the cross-chapter
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

The keepers sit in **two** suites on purpose. `tools/test-text-normalization.js`
judges the shared definition; `tools/test-tts-number-normalizer.js` owns the
disposition itself, so a regression in `digitRuns` has to fail the suite that
owns `NUMBER_DROPPED` and not only the fixture one. The comma-grouped cases are
in both, in both directions — `5,000` → *"five"* and `20-30,000` → *"twenty
thousand"* are still `NUMBER_DROPPED`, and `5,000 copies in 12 crates` →
*"five thousand copies in crates"* proves a comma-grouped number standing beside
a **bare** one is still two numbers.

Two notes the record needs. `18,000-strong` may be read *"eighteen
thousand-strong"* or *"eighteen thousand strong"* — the prompt lets a
replacement carry a hyphen and the compound's own hyphen is the book's (as in
`1940s-era` → *"nineteen forties-era"*), so the validator accepts both and the
choice is the model's. And a find whose second number is dropped **along with
its prose words** — `5,000 copies and 12 men` → *"five thousand copies"* — is
refused one check earlier, as `WORDS_DROPPED`: `keepsEveryWord` runs ahead of
the number floor. Refused either way; the record just names the right reason.

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

## Scripture: the rules DETECT it, the model READS it (n6)

### The ruling

Owen, 2026-09-05, after a Higgs A/B render of the deathstalker book narrated
`(1 Pet. 3:7)` as *"one pet three seven"*:

> **"I don't want to do it deterministically. An AI takes over. There are a
> billion ways Bible verses are abbreviated."**

Until n5 stage 2 *read* a reference from a table of book abbreviations
(`2 Cor. 10:4` → *"Second Corinthians ten four"*). A table is the wrong
instrument for an open set: `Pet.`, `1 Pt.`, `I Pet.`, `1 P.` and a hundred
house styles are one book, and a table that is 95% complete does not read the
last 5% *as printed* — it hands them to the generic integer rule, which narrates
"one pet three seven". So the table is gone from the shipped path.

### What stage 2 does now

`scriptureSpans(text)` recognizes a reference and returns it as a span.
`applyNumberRules` **closes** every such span before any rule runs, exactly as it
closes a clock range: nothing is rewritten inside one. The digits are therefore
still there when the model is asked, which is the only reason the model can read
it, and the block is never `RULES_ONLY`.

### The evidence test — three shapes, and no abbreviation table

Detection **consults no table of abbreviations**. A reference is claimed when the
token standing in front of the `c:v` carries one of exactly three kinds of
evidence:

| # | evidence | example |
|---|---|---|
| (a) | an **abbreviation** — the token carries its own period | `Pet. 3:7`, `Ps. 63:6`, `Zeph. 3:17` |
| (b) | a **volume number** in front of it — arabic `1-3`, roman `I/II/III`, or the ordinal forms | `1 John 3:16`, `II Cor. 5:17`, `1st John 1:9` |
| (c) | the token is one of the **73 full canonical book names** | `Genesis 3:15`, `Revelation 21:4`, `Qoheleth 3:1` |
| (d) | the token is **two or three letters** with no period at all | `Ps 23:1`, `Jn 3:16`, `Rev 21:4`, `Mt 5:3` |

and the rest of the reference comes with it:

| shape | detected | example |
|---|---|---|
| ranges, verse letters, `ff.`, chapter-crossing | yes, inside the same span | `Jer. 44:17-19`, `Gen. 1:1a-2b`, `Matt. 5:16ff.`, `Col. 3:19-4:1` |
| a LIST of references, bare verses included | yes, as **one** span, bounded (below) | `Lev. 19:31; 20:6`, `Genesis 6:11, 13 and 7:1` |
| chapter-only **with a volume number** | yes | `1 Pet. 3`, `2 Chron. 7` |
| chapter-only **without** one | **no** — see below | `Gen. 3` |
| a numbered book with no reference | yes (nine full names, John excluded) | `2 Corinthians`, `II Corinthians` |
| a book-LESS `c:v` | **no** — it is not known to be scripture | `3:16`, `5:45` |

**(d) is WEAK evidence, admitted on purpose, and it is cheap because of the claim
test.** A dotless `Ps 23:1` is the same shape as `Map 2:1` and `Bus 47:15`, so on
its own it proves nothing. It is admitted because (a)–(c) alone left every
dotless abbreviation *unreadable*: the model's `Psalm twenty three, verse one` was
refused `WORDS_DROPPED` — that relaxation is scoped to detected spans — and the
digits reached the narrator. Losing `Ps`, `Jn`, `Rev` and `Mt` is a regression
from this app's own behaviour in exactly the domain the branch exists for.

What pays for it is the **claim test** below, the same thing that makes a detected
`Sec. 3:7` affordable: the chapter-and-verse pause is asked only of a reading that
names a canonical book or an ordinal volume. So one detection serves both —
`Jn 3:16` → *"John three, verse sixteen"* is accepted as a reference, and
`Map 2:1` → *"Map two one"*, `Bus 47:15` → *"Bus forty seven fifteen"* are accepted
as the prose they are. The model decides which it is looking at, which is the
arrangement Owen ruled for.

**What (d) costs, stated rather than discovered later:** a 2–3 letter token in
front of a `c:v` is now *protected*, so the book-less rule no longer reads it and
its reading depends on the model where it used to be deterministic. The surface is
small — exactly two or three letters, no period, verse of ten or more
(`Bus 47:15`). **Four letters and up stay out**: `Then 9:45`, `Score 21:19`,
`Case 5:12`, `Odds 5:2`, `Route 66:1` and every longer word keep `main`'s
deterministic reading. Months are refused whether or not they print the period
(`Jan 3:7`), and so is the other grammatical slot — a short word that *points* at
a number instead of naming a thing (`See 20:6`, `In 20:16`). That exclusion list
is closed in a way the old deny-list of capitalised nouns never was, and the
reason is the length: the English function words of two or three letters are a
fixed, countable set; the capitalised nouns that can precede a colon-number are
not.

**The reading of Owen's ruling that (c) and (d) rest on — he may veto either.** His
objection was to enumerating *abbreviations*: "there are a billion ways Bible
verses are abbreviated", and that set really is open. The set of full canonical
names is neither open nor invented — 73 fixed words, closed since the canon was —
and it is used as a **shape**, never as a reading. If Owen reads the ruling as
forbidding this list too, delete `CANONICAL_BOOK_NAMES`; shapes (a) and (b) still
stand, and the cost is that a fully spelled book with no volume number
(`Genesis 3:15`) stops being protected. (d) asks the token's *length*, not its
identity, so it is not a table either — but it is the loosest of the four and the
one to remove first if he wants the detector tighter; deleting it restores
(a)–(c) exactly and costs the dotless abbreviations again.

**What is deliberately NOT detected.** A **single-letter** abbreviation
(`S. of S. 2:1`) — the token pattern needs two letters, because a one-letter
abbreviation is also every initial in a name. And a **longer dotless word**:
`Widescreen 16:9`, `Score 21:19`, `Wednesday 9:45`, `Then 9:45`. Four letters and
up with no period is the shape of every capitalised noun in English, and (d) stops
short of it deliberately.

**The list tail is bounded.** A tail carrying its own `c:v` is a reference
whatever its size; a **bare** tail number is admitted only when it could be a
verse — no verse is above Psalm 119:176 — and never when it is the head of a
comma-grouped number. Without those bounds `Quoting Rom. 8:28, 250 members left`
swallowed the 250 and `Isa. 5:20 and 1,000 copies` swallowed the grouped number,
and a swallowed number is one no rule can read any more. What the bounds do *not*
settle is `Gen. 1:1, 12 of them agreed`: 12 is a possible verse and nothing in the
shape says otherwise, so the model recovers it.

**A false positive is NOT free — measured, and it is why the evidence test
exists.** The first cut of this detector fired on any capitalised token in front
of a `c:v`, on the theory that "a span detected in error is merely sent to the
model". The adversarial review of 2026-09-05 falsified it: inside a detected span
the validator demands a chapter-and-verse pause, so the model's *correct* reading
of `Widescreen 16:9` → *"sixteen nine"* was refused and the digits reached the
narrator — and the book-less rule, which read `Score 21:19` correctly on `main`,
never got the chance. Detection took work away from a rule that was right.

Two things answer it, and both are in place: detection now requires **strong
evidence** (the three shapes above), and the pause is demanded only of a reading
that is *claiming* to be a reference (below). A miss is now what the design
originally claimed a false positive was: cheap.

**Why detection may use a list where a reading may not.** A missing entry in a
*reading* table produces a wrong reading, out loud, with nothing downstream to
catch it. A missing entry in the canonical-name list only means one span is not
protected — it is treated exactly as it was before this branch.

### The chapter-only decision

`Gen. 3` is **not** detected, and that is a decision, not an oversight. Telling
`Gen. 3` from `Fig. 3` requires knowing that Genesis is a book and a figure is
not, which is the table the ruling removed. A **leading volume number** is
evidence that survives without one — English prints `1 Pet. 3` and never
`1 Fig. 3` — so the numbered form is detected and the bare form is not. A bare
`Gen. 3` reaches the model with its digit intact and is read there.

### The must-NOT list

Owen's, 2026-09-05, one keeper each in `tools/test-tts-number-rules.js`:

| must not fire | why | what happens instead |
|---|---|---|
| `Jan. 3:7`, `Sept. 4:9` | a month is not a book | left as printed |
| `Gen. Patton` | no reference behind it | left as printed |
| `vs. 3:7`, `ex. 3:7` | lowercase — a book name is capitalized | left as printed |
| `1 Pet 3` (no period) | without the period the token is just a word | the integer rule reads the digits, as before n6 |
| `Chapter 3:7`, `Room 3:15`, `Act 3:2`, `Table 4:2` | an ordinary noun in front of a colon-number | the book-less rule reads it, or nothing does |
| `Verses 28:7-8`, `Chapters 3:1-4:2` | the plural of an ordinary noun | as above |
| `See 20:6`, `Read 20:6`, `Compare 20:16`, `In 20:16` | the sentence capitalized an ordinary word | as above |
| `at 3:16 John left` | a book name AFTER the digits is no evidence | the book-less reading, *"three sixteen"*, with no scripture pause |
| `Widescreen 16:9`, `Lakers 3:1`, `Route 66:1`, `Ratios 3:7` | four letters or more, no period, no volume number, no canonical name | left as printed, as on `main` |
| `Score 21:19`, `Flight 12:30`, `Windows 3:11`, `Docket 5:12`, `Recording 12:34` | same | the **book-less** reading — *"twenty one nineteen"* — which is what `main` read |
| `Map 2:1`, `Bus 47:15`, `BWV 3:7`, `Act 3:2` | three letters — evidence **(d) claims these** | detected, and the model reads them as the prose they are (`Map two one`); the claim test is what lets it |
| `Wednesday 9:45`, `Meeting Tuesday 14:30`, `Then 9:45` | a weekday or an adverb the sentence capitalised | the book-less reading, as on `main` |
| `2:00 p.m.`, `Luke 2:30 p.m.` | a meridiem says it was never a reference | the clock rule |
| `5:30-6:00` | a clock range is not a verse range | left whole |

**There is no deny-list of ordinary words any more, and there never could have
been one.** The first cut tried: months, nouns, their plurals, the
sentence-initial words. The review walked straight through it with `Lakers 3:1`,
`Widescreen 16:9`, `Flight 12:30`, `Route 66:1`, `Docket 5:12`, `BWV 3:7`,
`Recording 12:34`, every weekday (`Wednesday 9:45`), a sentence-initial `Then`,
and the short forms of words whose long forms were listed (`Ch.`, `Sec.`,
`Art.`, `Pt.`). Every case above is refused by the **evidence test** instead, and
each is a keeper carrying `main`'s own reading as its expected output.

**Months are the one word-level exception that remains**, because they have shape
(a): `Jan. 3:7` and `Sept. 4:9` are abbreviations carrying their periods, and
Owen's must-NOT list names them. Every other non-book abbreviation (`Sec.`,
`Ch.`, `Mr.`) *is* detected, and is read by the model as what it actually is.

The one shape kept from n5 is the **book-less `c:v`** (rule `verse-or-clock`,
renamed from `scripture`): with no book named, the pass does not know what the
digits are, so it reads them only where the verse and the clock readings
coincide — a verse of ten or more — and leaves the rest to the model. It is
deliberately **not** given the scripture pause.

### The reading — measured, not chosen

Whisper over the 23 scripture references carrying numbers in the deathstalker
corpus (`E:\training\deathstalker\build\ds_ad4s\scripture_spoken_forms_report.txt`,
2026-09-05) found:

* **22 of 23** say **"verse" / "verses"**; **1** is bare; **0** say "chapter".
* **"Psalm" singular** before a number, **4 times out of 4**.

So the default the prompt asks for is **`<Book> <chapter>, verse <n>`** —
*"First Peter three, verse seven"* — with ranges *"verses N to M"*
(*"Matthew twelve, verses thirty-four to thirty-six"*) and lists
*"verse N, M, and P"* (*"Psalm one hundred nineteen, verse ninety-seven, one
hundred one, and one hundred two"*). A leading book number is an **ordinal**
("First", "Second", "Third"), and the abbreviation is expanded to the book's full
name — and a **roman** volume numeral is the same number as an arabic one, so
`II Cor. 5:17` reads *"Second Corinthians five, verse seventeen"*. **The bare
comma form is accepted** (*"First John one, nine"* — the one bare clip), and
**"chapter" is refused**.

The prompt is the artifact the narrator hears, so which form it *asks for* is
pinned by its own keeper (`tools/test-prompt-examples.js`) and not only by which
forms the validator accepts: every chapter-and-verse reading the prompt states in
prose must carry "verse" and must not carry "chapter". Without that, a prompt
asking for the 1-of-23 minority form passes every other check on this branch —
including the `--scripture` probe, which scores `accept.some(...)` and holds the
comma form in every list.

### The validators — exactly one invariant relaxed

For an edit whose span overlaps a **detected reference**, and nowhere else:

* **Relaxed:** `keepsEveryWord` becomes `scriptureWordsSurvive` — the one-token
  law the text classes already live under. At most one prose word of the find may
  be missing, and **the word it was short for** must have arrived in its place:
  longer, and carrying the token's letters in order, which is what an
  abbreviation is. That admits every contraction a publisher prints (`Jas.` →
  James, `Phlm.` → Philemon, `Mk.` → Mark, `Pss.` → Psalms) and the ordinary words
  that are not scripture at all (`Sec.` → Section, `Ch.` → Chapter), and refuses
  "chapter" or "verse" standing in for `Pet.`. A **canonical book name** also
  counts, for the abbreviation whose reading is the book's other name (`Cant.` →
  Song of Songs). Without any of this, *"Pet." → "Peter"* is `WORDS_DROPPED`,
  which is what threw away 57 correct expansions on the 2026-09-02 run.
  A **roman volume numeral** is stripped from the words that must survive, for
  the same reason an arabic one is: it is a number, not a name. Without that,
  `II Cor. 5:17` cost two words and *every* reading of it was refused.
* **Relaxed:** the **citation guard** does not claim a detected reference.
  `sitsInCitation` reads a leading roman numeral as apparatus (`Document II
  9/34`), which is right everywhere except where a roman numeral is a volume:
  `II Cor. 5:17` was refused `CITATION_CODE` and narrated as digits. Outside a
  detected span the guard is untouched.
* **Added:** `SCRIPTURE_UNREAD`, last of the number invariants so every earlier
  one keeps its own name. It refuses a reference that came back half-read:
  * an **abbreviation still standing** — any token ending in a period except the
    last;
  * the **chapter/verse boundary gone** — fewer pauses (a comma, or the word
    "verse") than the find has printed `c:v` references;
  * the word **"chapter"**.

  The last two are asked **only of a reading that is claiming to be a
  reference** — one naming a canonical book or an ordinal volume. Detection
  admits any abbreviation with its period, and plenty of those are not books:
  `Sec. 3:7` of a statute is a detected span whose correct reading, *"Section
  three seven"*, has no pause in it and must pass. Demanding the pause of every
  reading of every detected span is what made a false positive expensive.

  (A **remaining digit** is the fourth thing a half-read reference can do, and
  `DIGIT_IN_REPLACE` has already refused it, for every class.)

  The measured residue this exists for: the deathstalker corpus served
  **"(Ps. sixty three six)"** — digits spelled out, the abbreviation intact and
  the boundary simply gone. Every other invariant passed it.

Nothing else is loosened. The same edit outside a detected span is judged exactly
as it was in n5. Every protected reference is also **named in the receipt**, as a
`SCRIPTURE_PROTECTED` line and a `scriptureReferences` count on the record: a
block that still holds digits after the rules ran has to be able to say why, and
a reference the model declines would otherwise leave a block that was asked
about, changed nothing, and explained nothing.

### Where the narration cuts go — an e2a-era path, owed to Phase 6

`narrationCutsDir()` is `path.join(getDefaultE2aTmpPath(), 'narration-cuts')`,
and `getDefaultE2aTmpPath()` falls back to `<e2a checkout>/tmp` when
`e2aScratchDir` is unset. Only `main.ts` ever sets it (`applyE2aScratchDir`,
Settings `ttsScratchPath`, else `<library>/tmp`) — so **anything without a main
process writes app state into a third-party checkout.**

Measured, 2026-09-05: `tools/test-narration-text-two-family.js` had been writing
its content-addressed copies into the real
`Projects\ebook2audiobook\tmp\narration-cuts\` for at least a day, and on a
second run *reused* them — including a punctuation copy written by a **different
branch**, because that key is `s1` and does not move when the number rules do. A
green keeper could therefore be a replay of another branch's output. The keeper
now calls `setE2aScratchDir` on its own temp root, as
`tools/test-cli-narration-prep.js` already did, asserts the model was actually
called, and deletes the root afterwards.

**Owed to Phase 6:** narration cuts have nothing to do with e2a. The fallback
should be library-derived (`<library>/tmp`, which is what the app sets anyway) or
a loud refusal. A silent fallback into someone else's checkout is precisely the
class of thing that hid this.

### Where the book table went

`tools/fixtures/scripture-readings.json` — 102 cases: the 66 books in the
abbreviations a publisher prints, the deuterocanon, every shape, and the readings
measured off the corpus. It is used twice:

* **offline**, in `tools/test-tts-number-rules.js`: every reference must be
  DETECTED, whole, and left as printed. A book the detector misses is a book the
  model is never asked about.
* **with a model**, Ollama-gated and never in the keeper sweep:
  `node tools/test-tts-number-normalizer.js --scripture <model>` reads each one
  through the real prompt and reports how many readings match. Without the flag
  it does not run and nothing pretends it did.

`accept` is a **list** per case, because the narrator is not uniform: the comma
form, the "verse" form, and the default that carries both are all correct.

## What the 2026-09-04 live run settled

The first run against a real model (`qwen3.8:27b-24g`, Kershaw, 68 blocks, 120 s,
36 edits, 0 parse failures) is the evidence behind the three rulings below.

### All-caps initialisms are LEFT AS PRINTED

The model left every all-caps initialism in the book alone — `SA`, `SS` and the
rest came back exactly as printed, not as "ess ay" or "Sturmabteilung". **That is
not a defect and it is not to be "fixed".** The Orpheus training corpora carry
initialisms as printed, so leaving them is the reading that matches the
fine-tunes; a pass that expanded them would be feeding the voice a shape it was
never trained on.

The rule of record: **an all-caps initialism stays as printed unless the model
judges a spoken expansion necessary.** The judgement is the model's, per block,
and the validator's job is only to keep whatever it decides to a single token
(`capsReadingRefusal`). Nothing deterministic touches these.

### A day-first date with no year reads the American spoken way

`DATE_DAY_FIRST` required a year, so `"…his last detailed report, which was on 4
September."` fell through to the bare-integer rule and shipped as **"on four
September"**. The model's own correct repair — "September fourth" — was then
refused, because a mangled date is not one of the classes a reading may be about.

`DATE_DAY_FIRST_NO_YEAR` closes it: the with-year rule minus the year, both
orders (`4 September` and `September 4`). Two guards keep it honest — a lookahead
for a following year, so `4 September 1939` stays the with-year rule's; and
`DATE_LEAD_BLOCK`, so `Chapter 4 September` and `p. 4 September` keep the digit a
numbered thing.

The month abbreviation's period is the subtle half. `"4 Sept. and later"` is an
abbreviation mid-sentence and reads *"September fourth and later"*; `"4 Sept. The
next day"` is both an abbreviation and a sentence end and reads *"September
fourth. The next day"*. So the period is swallowed only when the month is
**abbreviated**, and written back when what follows could start a sentence. After
a full month name the period is never touched.

### A citation lead and an abbreviated page range are apparatus

The run read `iii. 1281-2` as **"one thousand two hundred eighty-one to two"** —
a volume, a page and a range misread at once. Two shapes now sit in
`sitsInCitation`, which stops the deterministic rules and the model alike:

- **A roman numeral and a period in front of a number** (`iii. 1281-2`, `II. 45`).
  The numeral grammar is **strict** — thousands, hundreds, tens, units — because a
  loose `[ivxlcdm]+` also spells ordinary English: `he did. 45 men`, `it was mild.
  12 degrees` and `the civil. 90 percent` all matched the loose form and would
  have had their numbers refused as apparatus.
- **An abbreviated page range behind a page lead** (`pp. 51-2`, `fol. 128-9`),
  where the second number is shorter than the first because it drops the shared
  leading digits. The page rule itself used to read `pp. 51-2` as *"pages fifty
  one to two"*; it now leaves the span whole.

**The page lead is required, and that is a deliberate narrowing of the ruling.**
The wider form — any abbreviated range — contradicts the shipped number prompt,
which teaches `"112–14" is "one hundred twelve to one hundred fourteen"`, and
`test-prompt-examples` refused it on exactly that line. So a **prose** range keeps
the prompt's reading, which is the correct one, and only an **apparatus** range is
left as printed. A year range (`1935-36`) abbreviates identically and reads
differently again, so it is never claimed here — that judgement is the model's,
and the live run measured it making it correctly.

---
---

## Files

| file | what |
|---|---|
| `electron/tts-punctuation.ts` | stage 1, the shared spec (`s1`) |
| `electron/tts-number-rules.ts` | stage 2 — the rules, and `scriptureSpans` (detect-and-protect) |
| `electron/tts-number-normalizer.ts` | stage 3 + the record (`NORMALIZER_VERSION`) |
| `electron/narration-clean-text.ts` | the FAILSAFE door — the `foundry clean-text --epub` spawn, the 1.2.0 floor, the engine's settings, and `narrationTextGate` |
| `electron/narration-text-readiness.ts` | the ledger-side gate, and `narrationTextCleanupDone` (derived, never stored) |
| `shared/processing/narration-text-notice.ts` | `NARRATION_TEXT_FAILSAFE_NOTICE` — the one sentence both offer surfaces show |
| `shared/queue/narration-run.ts` | `NarrationTextCleanupChoice` and the run's `textCleanup` |
| `electron/parallel-tts-bridge.ts` | `prepareNarrationInput` — the render door, which logs the cleanup's case and refuses nothing |
| `electron/epub-processor.ts` | `readNarrationTextStamp` / `writeNarrationTextStamp` |
| `electron/processing-passes.ts` | `runNarrationTextPass` — the ledger pass, which spawns the door and lands its result on the book |
| `electron/queue-steps/pass.ts` | `narrationTextStep` |
| `cli/narration-text-step.js`, `cli/narration-text.js` | the CLI door and command |
| `tools/test-text-normalization.js` | the shared fixtures + both fixes |
| `tools/fixtures/scripture-readings.json` | the 66 books, the deuterocanon and the measured readings — evidence for the MODEL, never a rule |
| `tools/test-narration-clean-text-door.js` | the failsafe door against the REAL foundry 1.2.0 binary. Its LIVE leg (a cleanup with a model actually loaded) is opt-in — `BOOKFORGE_CLEAN_TEXT_LIVE=1`, optionally `BOOKFORGE_CLEAN_TEXT_MODEL=<tag>` — because its runtime belongs to the machine and not to this repository: measured 175s and then a 300s engine timeout on the same book, same model, different VRAM weather. The deterministic case is a stamped book admitted, walked and carried to a dead endpoint, which proves everything this app is responsible for |
| `tools/test-narration-reading-law.js` | the reading law, over the vendored validator, no GPU |
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
