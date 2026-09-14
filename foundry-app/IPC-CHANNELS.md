# Foundry's IPC channels — the whole list, for the collision audit

**THREE DOORS AND A NEW FAMILY ON 2026-09-14 — WAVE 61 PACKAGE F (APP HALF).
COUNTED BY SCRIPT OVER `app/electron/ipc.ts`: 130 `ipcMain.handle` call sites,
130 distinct channel names, zero `ipcMain.on`.** Nothing was removed, nothing was
renamed, and no existing shape narrowed. One payload widened
(`queue:list`/`queue:changed` carry `Job.usage`).

**AND THE STANDING FAILURE HAPPENED AGAIN, SO IT IS SAID HERE RATHER THAN LEFT
TO BE DISCOVERED.** The head of this file said **119** and the source measured
**127** before this change — eight doors added under a stale figure, which is the
exact failure the 2026-08-22 and 2026-08-23 paragraphs below already record twice.
A FIGURE QUOTED AS A GATE IS A MEASUREMENT OR IT IS DECORATION. The per-family
tables remain the authority for the NAMES; where a total contradicts them, the
tables win.

- **`cloud:settings` → `CloudSettingsView`** — every configured provider, the
  slot list as it now stands, and whether this window is hosted. One read,
  because the three are one picture: a card assembled from separate round trips
  draws a list that disagrees with its own slot preview for a frame.
- **`cloud:save` (providers) → `CloudSettingsView`** — REPLACE the whole list.
  `apiKey: null` on an entry keeps what is stored, matched by name. Rejects with
  a sentence naming the entry it cannot store — a missing model, a name a
  Crucible already has. Answered with the whole view, because enabling a
  provider changes the SLOTS. Refused outright while hosted. It fires
  `acts:gates-changed` and NOT the Crucible registry's own pass: connecting a
  provider moves the tiles and nothing else, and §5b's page-reader deletion can
  never follow from one, because a provider does not serve `pages` at all.
- **`cloud:test` (a whole `CloudProviderEdit`) → `CloudProbe`** — list the
  provider's models and say whether the chosen id is among them. A plain `GET`
  with the right header per kind (`Authorization: Bearer`, or `x-api-key` plus
  `anthropic-version`), so it costs no usage credits. It takes the UNSAVED edit,
  on `crucible:test-at`'s argument: saving a credential in order to find out
  whether it works would be this app writing into somebody's settings to answer a
  question. **The key crosses ONE WAY ONLY**, into main, out of a box somebody is
  typing in; `apiKey: null` means "the one already stored under this name", and
  no answer carries either back — `CloudProviderView` has `keySet: boolean` where
  the stored entry has a credential.

`cloud:` is a NEW FAMILY rather than three more members of `crucible:`, and that
is this file's own advice taken twice. On the merits: a cloud provider is not a
Crucible — no capability record, nothing resident, no lease, no busy state — and
a card reading `crucible:save` to store an OpenAI key would teach that they are
one kind of thing. On the audit: seven family collisions with BookForge are still
open, `crucible:` is a family BookForge does not have, and `cloud:` is one
neither side has, which is the cheapest possible answer.

**ONE PAYLOAD WIDENED INSIDE CHANNELS THAT DID NOT MOVE.** `Job` grew
`usage?: {requests, tokensIn, tokensOut}` — what a run spent, parsed off the
engine's own last line and ABSENT whenever no server counted (Ollama counts
nothing, so the engine prints nothing rather than a line of zeroes). It rides on
`queue:list` and the `queue:changed` push. A host mirroring rows need not carry
it; a row without it simply draws no cost line.

**FOUR DOORS AND ONE PUSH ON 2026-09-14 — WAVE 61 PACKAGE E, SO THE COUNT WAS
SAID TO BE 119.** Nothing was removed and no existing shape narrowed; three
payloads widened.

- **`crucible:test-at` (url, token) → `CrucibleProbe`** — test an address and a
  token that are NOT SAVED YET. The setup wizard's Connect door has three boxes
  and no registry entry behind them, and adding a server in order to find out
  whether it is a server leaves a dead entry behind every failure. The token
  crosses **one way only**, into main, out of a box somebody is typing in; it is
  used for one request and dropped, and `CrucibleProbe` has no token field.
- **`crucible:add` (name, url, token) → `CrucibleSettingsView`** — add ONE
  server, through `writeCrucibleServers`, the registry's one writer. Answered
  with the whole settings view rather than a list, because adding a loopback
  server changes the SLOTS. An existing name is replaced in place, keeping its
  rank and its enabled state.
- **`crucible:install-plan` → `CrucibleInstallPlan`** — the hand sequence for
  installing a Crucible on this machine, composed for this platform. A READ: the
  only process it spawns is `wsl.exe -l -v`, which lists. Everything else in the
  answer is a string for a person to read and run.
- **`crucible:install` → rejects** — the driven install, and it refuses on every
  machine today with `CrucibleInstallPlan.drivenWhy`'s sentence.
  `@crucible/bootstrap` is released with Crucible's next version and is
  deliberately not a dependency until it exists. The button is disabled with the
  same sentence AND the door refuses, because something reachable by an IPC
  message must refuse at the door or the disabling is a decoration.
- **`models:changed` (push, no payload)** — the weights on this disk moved. The
  one thing that moves them without somebody pressing a button on the card is
  SLOTS.md §5b's automatic removal, which fires from `crucible:save` and once at
  startup. No payload, on `acts:gates-changed`'s reasoning.

WIDENED INSIDE CHANNELS THAT DID NOT MOVE. `models:inventory` now carries
`MachineModels.pageReader` — §5b's offer: whether the reader has been (or would
be) removed, the bytes, and the REMOTE server page reading would then need.
`page-reader:state` carries `supersededBy`, the local Crucible that has taken
page reading over (null while `CRUCIBLE_READS` is false — see docs/SLOTS.md §5b).
`ollama:choices` carries `LlmChoices.crucible`, the classes a local Crucible
already serves, so the wizard says so in the rows rather than pulling a second
copy.

`crucible:add-local` is unchanged in shape and now runs §5b's pass when it lands,
exactly as `crucible:save` does.

**THREE DOORS AND ONE PUSH ON 2026-09-14 — WAVE 61 PACKAGE D, SO THE COUNT WAS
114.** Two NEW FAMILIES, `acts:` and `models:`, and the argument for them being
new rather than more members of `llm:` is with the family list below.

`acts:gates` answers, for all five acts at once, whether this MACHINE may run
them and the sentence either way (Owen, docs/SLOTS.md §1: *"the tiles arent lit
up until the models are present"*). It is one door and not five because every one
of those answers comes off the same probe of the same machine, and a dock asking
separately could draw a lit Translate beside a Simplify that had just gone dark.
The push `acts:gates-changed` carries NO PAYLOAD, on `projects:changed`'s
reasoning: main says the machine moved — a model pulled, the page reader
installed or removed, the language server repointed — and the renderer asks
again, so the shape has one composer and no pushed copy to go stale.

`models:inventory` and `models:remove-page-reader` are docs/SLOTS.md §5b's
"Models on this machine": every store of weights the app knows about, with sizes,
and a removal that touches ONLY the directory this app downloaded into. Ollama's
store is listed and has no door that writes to it — Owen: *"ollama has its own
thing going on and we should leave it be"* — and the removal answers with a
`RemovalOutcome` carrying the gigabytes freed, because a refusal here is a
sentence for the row rather than a rejection.

TWO PAYLOADS WIDENED INSIDE CHANNELS THAT DID NOT MOVE. `ollama:facts` and
`ollama:choices` now carry `OllamaFacts.holdings` — the same models as `models`,
each with the size `/api/tags` reports — so the inventory row can print bytes
without a second probe. `ollama:pull` and `page-reader:install` are unchanged in
shape and now fire `acts:gates-changed` when they land.

**REGENERATED 2026-09-13 FOR WAVE 61 PACKAGE B — NINE DOORS REMOVED, SIX ADDED,
AND ONE FAMILY RETIRED OUTRIGHT.** The app stopped building and launching a vLLM
inside WSL (docs/SLOTS.md §6, Owen: *"the plan is to leave VLLM to crucible
only"*), and the local page reader — a llama-server serving dots.ocr from a GGUF
this app downloads — took its place.

Gone, and BookForge must not keep a bridge entry for any of them:
`vllm:status`, `vllm:start`, `vllm:stop`, `vllm:keep-warm`, `vllm:set-keep-warm`,
`wsl:facts`, `wsl:tooling`, `backend:setup-run`, `backend:setup-cancel`, plus the
two pushes `vllm:status-changed` and `backend:setup-log`.

New: `page-reader:state`, `page-reader:install`, `page-reader:install-cancel`,
`page-reader:start`, `page-reader:stop`, `page-reader:set-keep-warm`, plus the
two pushes `page-reader:progress` and `page-reader:status-changed`.

Counted by script over `app/electron/ipc.ts` for this regeneration: **111
`ipcMain.handle` call sites, 111 distinct channel names, zero `ipcMain.on`**
(114 before it), and **16 pushes** — ten through `broadcast`, six to one
window's `webContents`. (Package D took it back to **114 handles and 17 pushes**
the next day; see the head of this file.)

NOTHING WAS RENAMED. `vllm:keep-warm` has no successor at all: its value rides
on `page-reader:state` instead, because everything that read changes with the
same directory walk and two reads could disagree.

---

Every channel name this app owns, enumerated from `app/electron` rather than
from memory, regenerated on 2026-09-05 for **the text-pass split** — ONE new
door, `workspace:plan-clean` (plan a narration cleanup: which records file it
writes, where its stamp goes, which step it will be filed as, and the position's
book materialised for the engine to read). It takes the document and nothing
else: a cleanup asks no language and no mode.

NO CHANNEL WAS RENAMED, AND ONE DELIBERATELY WAS NOT. `queue:enqueue-translate`
now takes all three text passes (`TextPassRequest` — a translation, a rewrite and
a cleanup), because everything the door does is the same for all three. Renaming
it to say so would be a new name for this file to audit plus an old one to prove
retired, paid for a door whose behaviour is unchanged; it is the family's door,
spelled after its eldest member.

**THREE MORE DOORS ON 2026-09-10 — the `capture:pdf-stage-*` trio, so the count
is 114.** A PDF dropped on the app can now mean "take this apart into one image
per page" as well as "open this" (Owen: *"give me the ability to drag/drop a pdf
into a new book, not just images. if i do, it should take each page as an
individual image"*). The RENDERER rasterizes, because pdf.js lives there and main
has no rasterizer at all; these three are main putting the pages on disk so that
`capture:intake` — unchanged, and this is the point — copies them in exactly as
it copies a photograph off a phone. `pdf-stage-begin` opens a staging directory
under %TEMP% and sweeps every one it is not holding open; `pdf-stage-page` takes
one page's PNG and answers where it landed, one page per call so a 300-page scan
is never resident in one heap; `pdf-stage-release` deletes the directory, and is
separate from the last page because the two callers let go at different moments —
a light table intakes and releases in one breath, a drop on Home leaves the pages
on the workspace table until somebody says which book they are. `capture:` now
keeps twelve doors and its intake-progress push.

**THE COUNT IN THIS FILE WAS 96 AND THE SOURCE MEASURES 108.** Counted by script
over `app/electron/ipc.ts` for this regeneration: **108 `ipcMain.handle` call
sites, 108 distinct channel names, zero `ipcMain.on`**; 107 before the door above.
Eleven doors were added under the stale 96 without this file moving — the exact
failure the 2026-08-23 paragraph below records happening once already, and the
standing rule it states is unchanged: regenerate this file in the same commit that
touches `ipcMain.handle`, not on the next wave. The per-family tables below are
the authority for the NAMES; where a total contradicts them, the tables win.

**TWO MORE DOORS ON 2026-09-08 — `llm:servers` and `llm:set-servers`, so the
count is 111.** The three language acts can now run against a vLLM instead of an
Ollama (`--server`, docs/VLLM.md), which is a property of the MACHINE rather than
of a book: which kind, both URLs, and the served model id. `llm:defaults` — again
unrenamed — now also answers `server` and RESOLVES the model and URL for
whichever kind is chosen, so the four dialogs keep asking one question and none
of them learns there was a choice. The new pair answers what is STORED, where
both servers exist at once and neither is in effect; it is a second channel
rather than more fields on `defaults` because `defaults` would otherwise have to
return the same URL twice under two names.

**SLOTS, 2026-09-14 (docs/SLOTS.md, Package C). TWO DOORS REMOVED, ELEVEN ADDED,
AND ONE PAYLOAD NARROWED. The source measures 123 `ipcMain.handle` call sites,
123 distinct names, zero `ipcMain.on`.**

- **REMOVED: `llm:servers`, `llm:set-servers`.** The setting behind them —
  "which kind of server does this machine speak to" — is gone. There is one local
  server and it is Ollama; every other server is a REGISTERED CRUCIBLE with a
  token, a rank and an enabled flag. **A vendored host calling either of these
  now gets no handler**, which is why this entry is at the top rather than in a
  table: it is the one breaking change in this wave.
- **ADDED, replacing them: `llm:ollama-url`, `llm:set-ollama-url`** — the one
  server address this app still keeps by itself.
- **NARROWED: `llm:defaults`.** The `server` field is gone and nothing is
  resolved behind it; `model`, `cleanModel` and `ollama` are the LOCAL slot's
  answers. A caller that read `server` reads `undefined`.
- **ADDED: `queue:set-wait-for`** — the row picker's one door.
- **ADDED: `slots:list`, `slots:rows-waiting-for`** — where work may go, and
  which waiting rows name one slot.
- **ADDED: `crucible:settings`, `crucible:save`, `crucible:test`,
  `crucible:add-local`, `crucible:set-wsl-distro`,
  `crucible:set-new-jobs-wait-for`** — the Servers card's own doors. **No token
  crosses any of them in either direction**: the renderer is told `tokenSet:
  boolean` and may send a NEW token, which is the whole of what a write-only
  field means.
- **No push was added.** The slot list changes when somebody edits a settings
  card, which is a screen they are standing on; a push would be main telling a
  window about a change that window made.

**ONE DOOR ADDED ON 2026-09-08 — `llm:set-clean-model`, so the count is 109.**
Clean text got its own persisted model setting (`cleanTextModel`,
app/electron/app-settings.ts, defaulting to `DEFAULT_CLEAN_TEXT_MODEL`) rather
than riding `defaultLlmModel`, which seeds translate, simplify and analyse. The
new door writes it; `llm:defaults` — unrenamed — now answers `cleanModel`
alongside `model`, a WIDENED payload inside an existing channel of the kind the
2026-08-17 and -08-18 sections below record. Hosted, BookForge's Clean text
press reads the same key out of the same `app-settings.json`, which is the
property this design exists to keep: one file, both doors, one model.

NO REGENERATION WAS OWED ON 2026-09-07, and it is recorded here so that the next
reader can tell a skipped regeneration from a deliberate one. Wave 56 (the promised
chain — grayed steps you can act from) WIDENED four existing doors with one optional
trailing argument each — `workspace:plan-export`, `workspace:plan-translation`,
`workspace:plan-simplify` and `workspace:plan-clean` now take the step id the press was
aimed at, and a caller that sends nothing gets exactly what it always got. No channel
was added, renamed or removed, so the count is unchanged and the tables below are
unchanged. This file's standing rule is about NAMES; arity is the API type's
(`FoundryApi.workspace`, app/shared/api.ts), which is where a caller reads it.

Before that, regenerated on 2026-08-25 for **Wave 50's hits-panel rework** —
two doors: `analysis:read-categories` and `analysis:write-categories`, the
categories a person writes themselves (name + the one sentence that becomes the
category's only hypothesis), kept app-level in `app-settings.json` beside the
library folder because they are the USER'S and not one project's. The write
takes the whole list and answers with the list as main stored it — every id
re-derived from its name, every field capped, every collision dropped — so the
window never holds an id the file does not. Counted by script: **96 `ipcMain.handle`
call sites, 96 distinct channel names, zero `ipcMain.on`** in
`app/electron/ipc.ts`.

Before that, regenerated on 2026-08-25 for **Wave 50's analysis** — three doors:
`workspace:plan-analysis` (mint the step and the report path, materialise the
book the run reads), `workspace:read-analysis` (one analysis step's report, for
the hits panel — the header, the findings and one sentence about staleness; the
cache rows never cross) and `queue:enqueue-analysis` (the held GPU job, which
REJECTS hosted: the host's queue takes the two request shapes its vendored copy
of `shared/api.ts` declares and this is a third). Counted by script:
**94 `ipcMain.handle` call sites, 94 distinct channel names, zero `ipcMain.on`**
in `app/electron/ipc.ts`. Each in the same commit as its handler, which is the
standing rule below.

Before that, regenerated on 2026-08-24 for **Wave 47's mint metadata** —
`meta:mint-read`, `meta:mint-write`, `meta:mint-stamp` and (2026-08-24, the
inheritance ruling) `meta:mint-host` — the per-project block the mint modal
edits, the in-place stamp its Save performs, and the host's seed underneath —
each in the same commit as its handler, which is the standing rule below.
Counted by script: **91 `ipcMain.handle` call sites, 91 distinct channel
names, zero `ipcMain.on`** in `app/electron/ipc.ts`.

Before that, regenerated on 2026-08-23 for **Wave 46, which adds two doors** —
`meta:read-epub` and `meta:write-epub`, the metadata dialog's EPUB arm
reopened. Counted by script for that regeneration: **87 `ipcMain.handle` call
sites, 87 distinct channel names, zero `ipcMain.on`** in `app/electron/ipc.ts`.
The gap was caught not here but by BookForge's own vendoring audit reading this
file as the authority it is ruled to be — the wave landed the doors and did not
move the doc, which is the exact staleness the paragraph two below records this
file already suffering once. Regenerate this file in the same commit that
touches `ipcMain.handle`, not on the next wave.

Before that, regenerated on 2026-08-22 for **Wave 41, which REMOVES a door** —
`capture:pages-load`, the listing of a mint's page images, retired with the
folder it listed when the mint went back to writing a PDF (docs/PLAN.md, Wave
41). It was the first removal this file recorded.

**THE COUNT IN THIS FILE WAS 71 AND THE SOURCE MEASURED 85.** Re-counted for
the Wave-41 regeneration, by script, over `app/electron/ipc.ts`: **84 `ipcMain.handle`
call sites, 84 distinct channel names, zero `ipcMain.on`** after the removal;
85 before it. Nothing was renamed and no name collides. The stale 71 dates from
2026-08-18 and every wave since has added doors under it without moving it —
which is the exact failure docs/PLAN.md §1 names about the test count, arriving
in the file whose whole job is to be counted. A FIGURE QUOTED AS A GATE IS A
MEASUREMENT OR IT IS DECORATION. The per-family tables below are the authority
for the NAMES; where a total contradicts them, the tables win.

Before that, regenerated on 2026-08-22 (the unapplied-work wave: four doors in
`book:`, and two names that had been missing from these tables since the capture
stage — `capture:remove` and the `capture:intake-progress` push, both in the
source and neither in a row). Before that on 2026-08-19 (the capture stage: eight doors, one new
family, and a second host on the one scheme; before that on
2026-08-18, the host status chip: two doors and one
push; then the offers push, which is a push and no door at all; then the
centralized queue, which added **nothing at all to either table** — see the
section on it below). It exists
because of the fifth thing Foundry owes BookForge before the first copy: *"A
channel audit. Enumerate both apps' IPC names once before the copy; Foundry's
are namespaced, so this is a check, not a design"*
(docs/BOOKFORGE-HANDOFF.md §8).

**Every name is `family:verb`.** That is the invariant this file exists to
prove, and it is the reason hosting is additive: `mountFoundry` registers these
into a main process that already has doors of its own, and one bare name would
be a collision waiting for a version bump. The last bare one — a renderer-bound
`navigate` — was renamed to `app:navigate` in the same wave that wrote this file.

**How to use it.** BookForge reads the family column against its own registry.
A shared FAMILY is survivable as long as no full name is shared —
`ipcMain.handle` throws on a duplicate channel, loudly, at registration, which
is the failure mode you want.

**AND IT HAS ALREADY BEEN READ, WITH AN ANSWER — THIS IS THE OPEN QUESTION.**
BookForge's side reported back the same day (`#bookforgenotes`, 2026-08-16):
nine of these families collide with channels it has registered — `book:`,
`dialog:`, `document:`, `library:`, `projects:`, `queue:`, `shell:`, `window:`,
`wsl:` — and its recommendation is that **Foundry prefixes at its registration
seam**, `foundry:<family>:<verb>`, on the argument that Foundry owns both ends
of every one of its channels (this file's `registerIpc` and
`app/electron/preload.ts`) while BookForge would have to touch hundreds of call
sites. It noted a near-miss worth remembering — Foundry's `vllm:` and
BookForge's `vlm:` — and that it already owns a literal `foundry:version` it
would move. **TWO OF THE NINE COLLISIONS ARE GONE AS OF 2026-09-13**: `wsl:`
retired with the launcher (this file's head), and with it the `vllm:`/`vlm:`
near-miss. Seven remain, and the ruling is still owed.

That is a ruling, not a refactor, and it is not made in this file. Wave 7's
channel work was the one rename the note above describes (`navigate` →
`app:navigate`); the prefix decision is the user's, and when it is made this
table is the list the wrapper is applied to. Until then, treat every name here
as the name.

The families are, RE-MEASURED BY SCRIPT on 2026-09-13, extended by two on
2026-09-14 (package D) and by `cloud` and `crucible` since, over every
`ipcMain.handle`, `broadcast` and `webContents.send` in `app/electron`: `acts`,
`analysis`, `app`, `book`, `capture`, `cloud`, `crucible`, `dialog`, `doctor`,
`document`, `documents`, `engine`, `env`, `export`, `host-ops`, `ledger`,
`library`, `llm`, `menu`, `meta`, `models`, `ollama`, `page-reader`, `project`,
`projects`, `queue`, `reading`, `recents`, `settings`, `setup`, `shell`,
`slots`, `system`, `window`, `workspace` — **thirty-five**. (The thirty-two that
stood here omitted `crucible` and `slots`, which package C registered, which is
the same staleness this file's head records about the door count.)

`acts:` and `models:` are NEW FAMILIES rather than members of `llm:`, and that is
this file's own advice taken: seven family collisions with BookForge are still
open and a new family is cheaper to audit than a new member of a colliding one.
It is also true on the merits — neither is about a language model in particular.
`acts:` answers whether an ACT may run here, which for reading a page has nothing
to do with `llm:` at all; `models:` is about weights on a DISK, in three stores
only one of which this app pulls into.

THE LIST THAT STOOD HERE SAID TWENTY-SEVEN AND WAS WRONG IN BOTH DIRECTIONS. It
had never been re-measured after the first-run wizard landed, so it was missing
`analysis`, `llm`, `ollama`, `setup` and `system` — five whole families that had
been registered for weeks — while still carrying `backend`, `vllm` and `wsl`, of
which `backend` was already empty of doors before this wave touched it. That is
the same failure the head of this file records twice about the door COUNT,
arriving in the sentence next to it. (The handoff's own note listed twenty-two;
it predates `app:` and had missed `reading:`. `project:` is a PUSH family with
exactly one member, `project:open` — a family with no door in it is still a name
this process owns.)

### Payloads that changed on 2026-08-17, inside channels that did not

Two names carry more than they did, and nothing was renamed — recorded here
because BookForge's keeper parses this file and a payload change is invisible to
a name-collision audit.

- `host-ops:invoke` grew a fourth argument, `settings: Record<string, unknown>` —
  the answers to the form the operation declared (`HostOperationOffer.form`), and
  `{}` for one that declared none. **This is the announced signature change**:
  `HostOperation.invoke(projectDir, nodeId)` becomes
  `invoke(projectDir, nodeId, settings)`. A host written against the old shape
  keeps working, because an argument nobody names is ignored.
- `host-ops:offers` now answers `{ operations, nodeActions }` rather than a bare
  array. `nodeActions` is the probe the tree draws Retry and Dismiss by — true
  only where the host registered `FoundryHost.onNodeAction`. It rides here rather
  than on a channel of its own because it is the same question in the same round
  trip, and a new name would be one more thing to audit.
- `HostOperationOffer.submitLabel?: string` joined the offer on
  `host-ops:offers` — the word the in-window dialog puts on its submit button.
  Owen: *"the button shouldnt say start if it isnt going to start, it should say
  add to queue."* Only the host knows whether its invoke runs the work now or
  files it, so the word is the host's to declare; **absent keeps Foundry's
  existing default ("Start")**, so a host that declares nothing is unaffected.
  One more optional field inside an existing payload — no channel changed.
- `NodeOutput` — the vocabulary of `HostOperationOffer.appliesTo` on
  `host-ops:offers`, and of `HostNode`'s implied output — grew a third member,
  `'export'`, beside `'book'` and `'audio'`. **No channel changed and no payload
  field was added or removed**; one enum inside an existing field accepts one more
  string. It exists so an operation can say it consumes the FINISHED FILE rather
  than the words: export rows produce `'export'` and ledger steps never do, so an
  op declaring it lands on `final/` rows alone (Owen's ruling, 2026-08-17 20:30 —
  *"The only options that exist are the ones that are possible for that stage"*).
  **A two-member host is unaffected**: `offeredFrom` is still one comparison, so
  an op still declaring `'book'` still lands on every book-producing step exactly
  as before. Recorded here because a keeper that parses names would not see it.

### Payloads that changed on 2026-08-18, inside channels that did not

- `HostOperationOffer.appliesTo` on `host-ops:offers` accepts **a list as well as
  a single value** — `NodeOutput | readonly NodeOutput[]`. It is a pure widening:
  `offeredFrom` reads both shapes through one test, so an operation declaring one
  string is offered exactly where it always was, and **a host that never sends a
  list is unaffected in every respect**. What the list buys is an act that belongs
  on BOTH currencies — `['book', 'export']` — which is Owen's ruling
  (2026-08-18): *"i dont think its intuitive to know you have to create an epub
  before you can narrate … if they arent doing it from an epub then we export the
  epub automatically and then run the task they assigned."* An act declared on
  `'book'` is offered from ledger steps, where there may be no export yet; the
  seam that makes that keepable is `exportEpubFromStep` in `app/electron/mount.ts`
  (a main-process function, not a channel — nothing in this table changes).
  **No channel changed and no payload field was added or removed**; one field
  accepts one more shape. Recorded here because a keeper that parses names would
  not see it.

### Three names added on 2026-08-18 — the host status chip

The first thing a host may draw in Foundry's own CHROME, rather than inside a
list Foundry already draws. Two doors and one push, all in `host-ops:`, which
is why they cost nothing to audit; the rows are in the tables below and the
contract is spelled out in the handoff's `#foundrynotes`.

- `host-ops:status` (invoke) answers `{ status: HostStatus | null; openable:
  boolean }` — the first paint, for a window that opened after the host had
  already pushed. `openable` is the probe the affordance is drawn by, riding on
  this answer for `host-ops:offers`' reason exactly: same question, same round
  trip, no extra name to audit.
- `host-ops:status-changed` (push, broadcast) carries `HostStatus | null`, the
  whole value on every change. **Null is a real statement** — it clears the chip
  and the chrome goes back to being Foundry's alone.
- `host-ops:status-open` (invoke) hands a click on the chip to the host's
  `onStatusOpen`. It refuses by name for a host that registered none, and the
  renderer never sends it in that case, because the chip is drawn as a readout
  rather than as a button when `openable` is false.
- `HostStatus` is four fields, all the host's own words or numbers:
  `headline` (required), `detail?`, `percent?` (0–100), `pending?`. Foundry
  draws them and interprets none of them. **Nothing is drawn at all when the
  status is null**, which is standalone always.

### One name added on 2026-08-18 — offers can be revised

**A push, and NOT a door: the `ipcMain.handle` count below is unchanged at 71.**
Said plainly because a keeper counting handles should not go looking for a
seventy-second one.

- `host-ops:offers-changed` (push, broadcast) carries the whole
  `{ operations, nodeActions }` answer — the same `HostOffers` shape
  `host-ops:offers` returns, composed by the same function in main
  (`hostOffers`, `app/electron/host-ops.ts`), so a window that asked and a
  window that was pushed at cannot hold different facts.
- **What it is for**: `host-ops:offers` is asked once, at first paint, and used
  to be the last word — a host whose own form legitimately changed while a
  Foundry window was up (a voice installed since, a setting changed since, an
  act it can no longer honour) had no way to publish it. The host pushes now,
  with `setHostOperations` on the mount seam; `setHostStatus`'s mechanics
  exactly, one surface along.
- **The renderer replaces BOTH halves on a push** and merges nothing, because
  what crosses is "here is everything I offer now" rather than a delta.
- **A host that never calls it is unchanged in every respect**, and standalone
  nothing ever pushes it. The subscription that never fires costs a window one
  listener.

### No name added on 2026-08-18 — the queue centralizes in the host

**NOTHING IN EITHER TABLE MOVED. Counted from source, not from memory: 71
`ipcMain.handle` call sites, 71 channel names, zero `ipcMain.on`; 14 pushes, 8 of
them broadcasts.** Said this plainly because the wave is a large one and a keeper
reading the changelog would reasonably go looking for a seventy-second door.

Owen ruled that the queue centralizes in BookForge (docs/PLAN.md, Wave 16) —
BookForge's engine schedules on a declared `gpu` resource and Foundry's pump was
a second scheduler that could not see it, so one machine's GPU had two owners.
What crosses for that is **main-process functions on the mount seam, not
channels**, exactly as `exportEpubFromStep` did in Wave 13:

- `runJob(request, {parentStep, onProgress, signal})` resolves with the settled
  `Job` row. The ROW and not a result type, because `JobState` distinguishes
  `done`, `failed` and `cancelled` and a result type cannot say cancelled — a
  cancel filed as a failure is how a host's retry restarts work a person stopped.
- `setHostQueueRows(projectDir, rows)` — the `setHost*` family's shape, and the
  rows are `FoundryJobRow`, which IS `Job`.
- `hostQueueDrained()` — the host's queue has drained of Foundry work.
- `mountFoundry({ …, hostQueue })` is what the host registers to take the
  deciding over. Absent, everything below behaves exactly as it did.

**Two existing channels carry a different LIST hosted, in the same shape.**
`queue:list` (door) and `queue:changed` (push) both answer `Job[]`, unchanged —
but with a host queue registered the array is the HOST's rows rather than
Foundry's, accumulated across projects from `setHostQueueRows` and keyed by the
folded directory. It is never a merge: hosted, one side is doing the scheduling
and that side's list is the one the shelf draws. Standalone, and for any host
that registers no queue, both answer exactly what they always answered.

**`host-ops:nodes` gained a second job and no second name.** It is the moment
main learns a window is drawing a particular book — `queue:list` is global and
names no project — so it also asks the host for that project's queue rows
(`FoundryHostQueue.rows`, optional) and seeds the mirror. The first paint for the
shelf, riding on the first paint for the tree, for the reason every rider in this
file rides: no new name for the collision keeper to audit.

**`host-ops` was invented rather than found**, and the reason belongs in this
file: it is the host-operations socket (the provenance tree's audio work, ordered
from a BookForge that has mounted this app), and a BRAND-NEW family is the one
kind that cannot collide with anything either side already owns. Every other
family here was audited against BookForge's registry once and the socket is
collision-safe by construction instead — which is worth having, because it is the
family most likely to grow doors.

---

### Eight names added on 2026-08-19 — the capture stage (a ninth, the intake-progress push, followed the same day; see the pushes section)

One new family, `capture:`, all of it registered in `app/electron/ipc.ts`
like every other door. Four answer today (create, intake, recipe-load,
recipe-save); the four mint doors are registered and REFUSE BY NAME until
the mint merge lands — a caller gets a sentence, not a missing-handler
throw. The family is new, so it cannot collide with anything BookForge
reported; the prefixing question above is unchanged by it. The same wave
added a SECOND HOST on the `foundry-file:` scheme — see the scheme
section at the bottom.

### One name REMOVED on 2026-08-22 — the mint writes a PDF again (Wave 41)

**`capture:pages-load` is gone.** It answered a mint's page images as plain
basenames in reading order plus a door token that served them, and it existed
only because the mint wrote a folder and no container — so the minted row had no
document for a viewer to open and the app grew a page-scroller for the occasion.

Owen ruled the container back in: *"maybe we should mint a pdf from the pages
after theyre fully arranged and complete… the pdf can exist so it doesnt confuse
bookforge or anything else"*, and *"the system isnt trying to sift through
images, it's using the original pdf just like it normally would."* The minted row
now resolves through `ledger:document-at` like every other document in the app,
pdf.js draws it, and there is nothing left for a listing door to answer.

- **Nothing else moved.** No name was renamed, no family was added or emptied —
  `capture:` keeps NINE doors (create, intake, recipe-load, recipe-save, remove,
  and the four mint doors) and its intake-progress push. The `foundry-file:`
  capture host is unchanged in shape and now registers ONE directory again
  (`derived/`) rather than two, which is a fact about which directories a token
  is minted for and not about the scheme — and it makes the scheme section at the
  bottom of this file true again, which it had quietly stopped being.
- **What a keeper should expect**: 84 `ipcMain.handle` call sites and 84 distinct
  names, down from 85. See the note at the top of this file about the 71 that had
  been sitting here since 2026-08-18.
- **Payload shapes**: `ReadRequest` LOST its optional `inputKind` and
  `ReadingPlan` its `sourceKind` — the two-value `'pdf' | 'pages'` selection that
  chose a read flag. A reading is of a PDF. This is inside `queue:enqueue` and
  `workspace:plan-reading`, neither of which is renamed, and both fields were
  Foundry's own — no host reads them.

### Four names added on 2026-08-22 — unapplied work stops being losable

No new family: all four are `book:`, which BookForge already reported as a
collision, so they change nothing about the prefixing question above. They land
together because they are two halves of one defect (Owen, 2026-08-21: a chapter
renamed and a block retyped in the book pane, no second Apply, Export pressed,
and the EPUB came out without either — then the stack was scrapped by a window
closing without the per-tab question ever running).

- `book:pending-save` (invoke) writes `<project>/ops/pending.jsonl` atomically —
  the book pane's stack as a DIFFERENCE against the tip step it grew from
  (`PendingStack` in `app/shared/ops.ts`: `{kept, tail, undone}`). The file is a
  JSON header line plus the existing ops serialization, so there is no second
  payload format; main stamps the header with the step the stack was made at and
  sixteen hex of the receipt the book is made from. **Nothing in the ledger names
  this file**, no replay reads it, and every book draws identically whether it
  exists or not — so a keeper diffing project layouts should expect it beside the
  step payloads and treat it as neither.
- `book:pending-read` (invoke) answers `PendingOutcome`: the stack, or `null` for
  a book with nothing held, or a REFUSAL with a sentence and a count when the
  held stack was made at another step or over a reading that has since moved. It
  never adopts silently and never scraps silently.
- `book:pending-clear` (invoke) deletes it. Three callers, every one of them a
  person speaking: an Apply, the closing card's Discard, and — since Owen's
  2026-08-22 ruling — the unapplied card's Discard.
- `book:confirm-unapplied` (invoke) is a QUESTION door in
  `document:confirm-close`'s exact shape — `Asked<UnappliedAnswer>`, main
  composing every sentence. **Both halves of its payload changed on 2026-08-22**
  and a keeper mirroring the types has to move with them:
  - `UnappliedWarning.act` widened from `MakeAct` to `UnappliedAct`, which is
    `MakeAct` plus `'stand'` — the card now stands in front of a move to another
    step as well as in front of the four make-acts. `MakeAct` itself is
    unchanged; a new union was added rather than a fifth member, because half a
    dozen other tests mean "an act that makes a book" by it.
  - `UnappliedAnswer` went from `'apply' | 'without' | 'cancel'` to
    `'apply' | 'discard' | 'cancel'`. `without` ("continue without them") is
    retired; `discard` DESTROYS the stack — the pane's copy, the parked copy and
    the sidecar — and then runs the act against the book as recorded. `cancel` is
    no longer a button: the card offers exactly two, and a dismissal (Escape or
    the scrim) is what answers `cancel`.

**One payload changed inside a channel that did not.** `document:confirm-close`
answers the same `Asked<CloseAnswer>` with the same three keys, and its WORDS are
different: closing no longer destroys a stack, so the card asks whether to record
the work rather than warning that it is about to be lost. Recorded here because a
keeper that parses names would not see it.

**And a main-process function, not a channel**, for completeness with
`exportEpubFromStep`'s precedent: that function is the one make-act in the app
the card above cannot gate, because it runs in main with no window to draw in.
Its own docblock names the limit.

### Eleven names added on 2026-08-26 — first-run setup (Wave 53)

Ten doors and one push, all of them reachable from the settings screen as well
as from the wizard, which is the point: setup is the first-run ARRANGEMENT of
questions the app can already answer, not a separate mechanism.

`setup:state`, `setup:finish`, `system:probe`, `ollama:facts`,
`ollama:choices`, `ollama:install`, `ollama:install-cancel`, `ollama:pull`,
`ollama:pull-cancel`, `llm:defaults`, `llm:set-model`; and the push
`ollama:progress`, shaped on `env:install-progress`.

Two things worth naming rather than leaving in the table. **`ollama:pull` and
`ollama:install` do not go through the job queue**, unlike `env:install` — the
queue keeps two expensive GPU runs from overlapping and gives a run a
cancellable row, and an ollama pull is neither: it happens in ollama's process
and finishes whether or not this app is looking. And **`ollama:install`
resolving `ok` means the installer was OPENED**, never that ollama is
installed — that happens minutes later in a window this app does not own, so
`ollama:facts` is the only thing that ever says so.

## Doors the renderer knocks on

All 130 are `ipcMain.handle` — there is not one `ipcMain.on` in the app, on
purpose: a renderer that cannot tell whether main heard it is a renderer that
cannot report a failure. They are registered in one function, `registerIpc`
(`app/electron/ipc.ts`), which `mountFoundry` calls.

| Channel | What it does |
| --- | --- |
| `acts:gates` | May each of the five acts run on THIS MACHINE, and the sentence either way — translate, simplify, analysis, clean, read. What is installed, what fits, what is serving. Not the stage gate: whether an act applies where somebody is standing is `shared/stages.ts`, in the renderer, and a tile needs both. |
| `analysis:read-categories` | The analysis categories this user wrote themselves, from `app-settings.json`. App-level: they are the reader's, not one project's. |
| `analysis:write-categories` | Replace that list, and answer with it as stored — ids re-derived from names, fields capped, collisions with a built-in or with each other dropped. |
| `app:hosted` | Whether another app mounted Foundry, so the renderer can drop the controls the host already answers. |
| `book:amend` | Amend the tip edit step's ops in place, under the ledger's lock. |
| `book:apply` | Land the proof sheet's stack of ops as a new edit step. |
| `book:confirm-unapplied` | Compose the "these changes are not applied yet" card, before Export, Translate, Simplify, a host act or a move to another step runs over a book pane holding a stack. Two answers — Apply changes, Discard changes — plus dismissal. Main owns the sentences. |
| `book:correct` | A corrected paragraph on a TRANSLATED position — a records correction, never an op. |
| `book:load` | The book at a project's position, as blocks the renderer draws; may spawn the engine to make it. |
| `book:load-at` | The same replay resolved to a NAMED step rather than to the pointer — Compare's read-only column. |
| `book:pending-clear` | Throw the held stack away — the sanctioned scrap, called by an Apply, by the closing card's Discard, by the unapplied card's Discard, and by nothing else. |
| `book:pending-read` | The held stack back, or a refusal naming the file when it was made at another step or over a reading that has since moved. |
| `book:pending-save` | The book pane's UNAPPLIED stack, written atomically to the project's sidecar. Not history: no step names it and no replay reads it. |
| `book:view` | A finished export, exploded and returned read-only. |
| `capture:create` | New Project: births a capture project, writes the empty recipe, appends the capture step, mints the door token. |
| `capture:intake` | Dropped photographs: copy to the bank, hash, decode, working copy + thumbnail, EXIF time, recipe append. Answers added/duplicates/refused so a mixed drop is countable. |
| `capture:mint-abort` | Abandon a mint in flight; the partial assembly is swept. Refuses by name until the mint merge. |
| `capture:mint-begin` | Open a mint: the page list with pixel-space quads and output sizes, one id to write against. Refuses by name until the mint merge. |
| `capture:mint-commit` | Close the mint: assemble the rectified pages into an image-only PDF, file it in `archive/` with a live copy and a `documents` origin row, set the manifest archive, append the step. |
| `capture:mint-page` | One rasterized page's JPEG, renderer to main, so no full-book buffer ever exists in one heap. Refuses by name until the mint merge. |
| `capture:pdf-stage-begin` | Open a staging directory for one dropped PDF, sweeping every leftover this run is not holding open. Answers the id the other two are addressed by. |
| `capture:pdf-stage-page` | One rasterized PDF page's PNG, renderer to main, staged under a checked basename; answers the path `capture:intake` will copy from. |
| `capture:pdf-stage-release` | The staged pages are in a project, or abandoned: delete the directory. Releasing twice is releasing once. |
| `cloud:settings` | Every configured cloud provider, the slots as they now stand, and whether this window is hosted — the Cloud providers card's one read. No key crosses: the renderer is told `keySet`. |
| `cloud:save` | Replace the whole provider list. `apiKey: null` keeps the stored key. Answered with the whole view, because enabling a provider changes the slots. Refused while hosted. |
| `cloud:test` | List that provider's models and say whether the chosen id is among them — a plain GET with the right header per kind, so it costs no usage credits. Takes the UNSAVED edit; the key goes one way, into main, and no answer carries it back. |
| `capture:recipe-load` | The recipe plus a fresh door token — how a reopened project gets its light table back. |
| `capture:recipe-save` | The whole recipe document, validated before it touches disk. |
| `capture:remove` | Remove photographs from a capture project's bank — the one door that deletes something irreplaceable, and the surface has already asked by name and count. |
| `dialog:open-document` | File→Open's native dialog, and the open that follows it. |
| `doctor:run` | `foundry doctor --json` — what this machine can and cannot do. |
| `document:confirm-close` | Compose the "close and lose these changes?" card. Main owns the sentences. |
| `document:open-path` | A dropped path, admitted by main or refused. |
| `document:read-bytes` | A whole opened document's bytes, for the app's own pdf.js. Gated by the allow-list. |
| `document:save-copy` | Save a copy of an open PDF where the user says. |
| `documents:delete` | Delete one document, export or facsimile out of a project. |
| `documents:describe` | What that delete would cost, as a card. |
| `engine:info` | Which `foundry` binary this app would spawn, and its version. |
| `env:cancel` | Cancel the running environment install, through the queue. |
| `env:catalog` | The prebuilt environments this machine could install. |
| `env:choose-dest` | Native directory picker for an install destination. |
| `env:install` | Queue an environment download; progress arrives on `env:install-progress`. |
| `export:save-copy` | Copy a file out of a project's `final/` tray to somewhere the user picks. |
| `host-ops:invoke` | Run one of the host's acts, named by id, from a node in the tree. Carries the answers to the act's own form. |
| `host-ops:node-action` | Retry or dismiss a host node that FAILED — the pair the tree draws on a failed card. |
| `host-ops:nodes` | One project's host-contributed nodes as they now stand — the first paint. |
| `host-ops:offers` | What the host registered at mount: its operations (with their forms), and whether failed nodes can be retried. |
| `host-ops:status` | What the host is doing right now, for the chip in this window's chrome — and whether a click on it goes anywhere. Null standalone. |
| `host-ops:status-open` | The chip was clicked: hand it to the host's `onStatusOpen`. Refuses by name for a host that registered none. |
| `ledger:delete` | Delete a step and sweep its payload. |
| `ledger:describe-delete` | What that step delete would take with it. |
| `ledger:document-at` | The document the project's position resolves to; admits it to the allow-list. |
| `ledger:document-at-step` | The document a NAMED step resolves to, for a compared row whose picture is a file; admits it too. |
| `ledger:go` | Move the project's position to a step. |
| `ledger:read` | The step ledger for a project. |
| `ledger:stand-for` | Move the position to the step a given document belongs to. |
| `library:choose` | Native directory picker for the library. Refuses while hosted. |
| `library:dir` | The effective library directory — the host's, when hosted. |
| `library:set` | Move the library. Refuses while hosted. |
| `llm:defaults` | What the language dialogs open with — the LOCAL slot's answers, and only those: `model` (translate/simplify/analyse), `cleanModel` (Clean text's own `cleanTextModel`), and `ollama`, the URL of the Ollama on this machine. Nothing is resolved behind it any more; a job sent to a Crucible takes its model and its address from that server at the spawn. |
| `llm:ollama-url` | Where Ollama is. The one server address this app still keeps by itself. |
| `llm:set-ollama-url` | Write it. Answers with what was STORED, never with what was sent. |
| `llm:set-clean-model` | Set the Clean text model. Answers with the tag AS STORED, same rule. |
| `llm:set-model` | Set the default model. Answers with the tag AS STORED — a name main clamped comes back changed. |
| `meta:mint-host` | The HOST's record of who this book is (`FoundryHost.mintMetaFor`), or null — the hosted mint modal's seed. Null standalone; a host that throws REJECTS in its own words so the form can say so. |
| `meta:mint-read` | The project's mint metadata block (shared/mint-meta.ts), or null for a project that has never confirmed one. |
| `meta:mint-stamp` | The whole block onto ONE finished export, in place — the metadata tile's Save over an EPUB. Tray-gated like the flat writer. |
| `meta:mint-write` | Replace that block — what the mint modal saves, and what the next mint pre-fills from. |
| `meta:read-epub` | A finished EPUB export's OPF metadata, through the engine. Only a file in the project's `final/` tray answers. |
| `meta:read-pdf` | A PDF's Info dictionary, through the engine. |
| `meta:write-epub` | Write the six OPF fields back to that export (side file + one rename), and record the metadata step with `kind: 'epub'`. |
| `meta:write-pdf` | Write it to the project's working copy, and record the metadata step. |
| `models:inventory` | Every store of weights on this machine, with sizes — Foundry's own downloads, Ollama's list, a local Crucible's residency (docs/SLOTS.md §5b). Measured, never cached. Carries `pageReader`, §5b's offer: what has been or would be removed, the bytes, and the remote server page reading would then need. |
| `models:remove-page-reader` | Delete the page reader Foundry downloaded — that directory and nothing else — stopping the server first if this app started it, and answer with the gigabytes freed. The one door in this app that deletes model files. A refusal is a result with a sentence, not a rejection. |
| `ollama:choices` | This machine, ollama's state, the Qwen lineup with one row badged, and today's model — the setup wizard's model step in one answer. |
| `page-reader:install` | Fetch whatever the local page reader is missing — a llama.cpp build for this machine and the two dots.ocr GGUF files — verify each against its published sha256, and unpack. Streams over `page-reader:progress`. A failure is a result, not a rejection. |
| `page-reader:install-cancel` | Stop that. What has already been fetched is KEPT: the next attempt resumes from it. |
| `page-reader:set-keep-warm` | Minutes an app-started page reader outlives a drained queue, clamped; answers with the value as stored. The read is on `page-reader:state`. |
| `page-reader:start` | Start it now, or adopt whatever is already answering on the port. Pre-warming, so the first book of an evening does not pay the load. Rejects with the server's own log tail. |
| `page-reader:state` | EVERYTHING THE SETTINGS ROW AND THE SETUP STEP NEED, IN ONE READ: supported on this platform, installed, which llama.cpp release and accelerator, both model files by name and size, what a download would cost right now, the server's status, and the keep-warm minutes. One call because every one of those is measured off the same directory at the same moment. |
| `page-reader:stop` | Stop it, if this app started it. A server it merely found is left alone and says so. |
| `ollama:facts` | Is ollama running, and is its binary here at all. Two different questions; never cached. |
| `ollama:install` | Fetch ollama's own installer and hand it to the OS. `ok` means it was OPENED, never that ollama is installed. |
| `ollama:install-cancel` | Abort that download. |
| `ollama:pull` | `POST /api/pull`, streamed. A failure is a result, not a rejection. Never routed to a queue. |
| `ollama:pull-cancel` | Abort that pull. |
| `projects:delete` | Delete a project directory, for real. |
| `projects:describe` | What that project delete would destroy, in words and bytes. |
| `projects:list` | Home's listing: one row per book, with what is in it. |
| `queue:cancel` | Cancel one job. Forwarded to the host's queue where one is registered. |
| `queue:clear-finished` | Clear the settled rows out of the shelf. Forwarded to the host's queue as well, where one is registered. |
| `queue:enqueue` | Queue a reading or a rendering; captures the project's position as the parent step. Filed in the host's queue instead, where one is registered — this door is a person pressing something. |
| `queue:enqueue-analysis` | Queue an analysis: the book read against the categories, held on the GPU lane. Never routed, and REFUSED outright hosted — the host's queue does not know this request shape, and Foundry's own queue is invisible in a hosted window. |
| `queue:enqueue-translate` | Queue a TEXT PASS — a translation, a simplification or a narration cleanup (`TextPassRequest`). Routed like `queue:enqueue`. The name is the family's eldest member, kept rather than renamed: the door's behaviour is unchanged and a rename costs this audit two entries. |
| `queue:list` | The queue, for the renderer's mirror — the host's rows where a host queue is registered, Foundry's own otherwise. |
| `queue:remove` | Remove a held or settled row. Forwarded to the host's queue where one is registered. |
| `queue:run` | Run an export NOW and resolve with the settled row — the Export dialog's door. Never routed to a host queue; the row leaves the list at the settle, so nothing lingers in the shelf. Refuses a `read` by name. |
| `queue:set-wait-for` | Send a held or queued row to a different SLOT — a slot name, or `any` (docs/SLOTS.md §3). Answers nothing; the row arrives on `queue:changed` like every other change. Refused silently on a row that has started, because a job is atomic on one slot. NOT forwarded to a host queue: a host's placement is the host's. |
| `queue:start` | Release everything held at this moment. Forwarded to the host's queue where one is registered. |
| `slots:list` | Every slot, in priority order — where compute-heavy work may go: this machine, one per enabled Crucible, then one per enabled cloud provider (`kind: 'cloud'`, and carrying no `url`, deliberately — see docs/SLOTS.md §7, Package F). Hosted, this is the host's own list (`FoundryHost.slots`). One entry or none is the ordinary answer and draws no picker anywhere. |
| `slots:rows-waiting-for` | The waiting rows of OURS that name one slot — what the Servers card shows before it offers to move any of them. Running rows are deliberately not included. |
| `crucible:settings` | Everything the Servers card draws in one read: the registry (with `tokenSet`, never a token), the derived slots, the new-jobs default, the WSL distro, and whether this window is hosted. |
| `crucible:save` | REPLACE the whole registry, in order — the array position IS the rank, so a drag is a save. `token: null` on an entry keeps what is stored. Rejects with a sentence naming the entry it cannot store. Refused outright while hosted. |
| `crucible:test` | Test connection (`client.info()`). A failure is a RESULT carrying the SDK's own sentence, not a rejection. |
| `crucible:test-at` | The same probe against an address and token that are NOT in the registry — the wizard's Connect door, which has nothing saved to test. Writes nothing. The token goes one way, into main, and no answer carries it back. |
| `crucible:add` | Add ONE server, through the registry's one writer. Answers with the whole settings view, because adding a loopback entry changes the slots. An existing name is replaced in place, keeping its rank. |
| `crucible:add-local` | Register the Crucible on this machine by reading its own `config.toml` — on Windows through `wsl.exe -d <distro> --exec`. The token is read and stored in main and never crosses this wire. Refused while hosted. |
| `crucible:set-wsl-distro` | Which WSL guest that read looks in. Empty is a real answer and means unset; there is no default. |
| `crucible:set-new-jobs-wait-for` | `top` or `any` — what a new row's `waitFor` starts as. Answers with what was stored. |
| `crucible:install-plan` | The hand sequence for installing a Crucible on this machine, composed for this platform: the numbered steps with every command copyable, the elevated ones listed apart, the README link and the wheel. A read — the only process it spawns is `wsl.exe -l -v`. |
| `crucible:install` | The driven install. REJECTS on every machine today with the same sentence the disabled button wears — `@crucible/bootstrap` ships with Crucible's next release. The door refuses as well as the button, because a disabled control over an open door is a decoration. |
| `reading:confirm-re-read` | Compose the "read this book again?" card, which spends GPU on a yes. |
| `recents:clear` | Forget every recent. |
| `recents:forget` | Forget one. |
| `recents:list` | The recents list. |
| `settings:read` | The engine's `settings.json`. |
| `settings:write` | Patch it. |
| `setup:finish` | First-run setup is over — FINISHED OR DISMISSED — with the list of steps that were skipped. |
| `setup:state` | Has this machine been through setup, and what was declined. |
| `shell:reveal` | Show a file in the OS file manager. |
| `system:probe` | What this computer is: GPU and VRAM, RAM, free disk, and the memory a model can actually expect. Cached for the process; the flag re-reads it. |
| `window:close` | Close the window — the ✕, pressed by the page. Hosted, running out of tabs. |
| `window:let-go` | The renderer's one answer to `window:closing`. |
| `workspace:plan-clean` | Plan a narration cleanup: which records file it writes, where the run's stamp goes, which step it will be filed as, and the position's book materialised for the engine to read. Takes the document and nothing else. |
| `workspace:plan-analysis` | Plan an analysis: which report file it writes, which step it will be filed as, and the position's book materialised for the engine to read. Checks every category name against the closed set this build knows. |
| `workspace:plan-export` | Plan a rendering that lands in the project's `final/` tray. |
| `workspace:plan-reading` | Plan an OCR read: which bank it fills. |
| `workspace:plan-simplify` | Plan a rewrite in one of three modes. |

| `workspace:plan-translation` | Plan a translation of an open document. |
| `workspace:read-analysis` | One analysis step's report — the header, the findings, and one sentence about whether it is still about this book. The cache rows (one per sentence) are dropped at the parse. |

### One push added on 2026-08-19 — intake progress

`capture:intake-progress`, the family's ninth name and its first push,
shaped verbatim on `env:install-progress`: broadcast from main during
the `capture:intake` invoke, one push per path asked for plus a closing
push, payload `{projectDir, done, total, file}`.

## Pushes main makes at the renderer

Seventeen, and every one of them is a state change the renderer holds a mirror of
or a question it has to answer. Eleven go to every window through `broadcast`
(`app/electron/window.ts`); the other six are sent to one window's `webContents`.

| Channel | What it says |
| --- | --- |
| `acts:gates-changed` | Something that decides a tile moved — a model pulled, the page reader installed or removed, the language server repointed. No payload: the renderer asks again on `acts:gates`, so the shape has one composer and no pushed copy to go stale. |
| `models:changed` | The weights on this disk moved without this window doing it — docs/SLOTS.md §5b's automatic removal, which fires from `crucible:save` and once at startup. No payload, for `acts:gates-changed`'s reason: the inventory costs a directory walk and has one composer. |
| `app:navigate` | Go to a route — File→Settings, and nothing else today. |
| `capture:intake-progress` | One dropped photograph copied, hashed and decoded — one push per path asked for, plus a closing one. |
| `document:opened` | A document was admitted and should open in a tab. |
| `document:relocated` | An opened document moved onto the project's working copy; the tab follows. |
| `env:install-progress` | An environment install changed phase. |
| `host-ops:changed` | The host pushed what it is making in one project — the whole set, every time. |
| `host-ops:offers-changed` | The host revised what it OFFERS — the whole `{operations, nodeActions}` answer again, replacing what `host-ops:offers` said. |
| `host-ops:status-changed` | The host pushed what it is doing at all — the whole value, every time. Null clears the chrome's chip. |
| `menu:action` | A menu item the renderer has to carry out, because it acts on a tab. |
| `ollama:progress` | The ollama installer download AND a model pull, on one channel — the wizard is the only thing that draws either, and one shape means one bar. |
| `page-reader:progress` | One file of the page reader's install, phase by phase — the llama.cpp archive, the CUDA runtime beside it on Windows, and each GGUF. Same five-phase shape as `ollama:progress`, deliberately: the wizard draws both and one shape means one bar. |
| `page-reader:status-changed` | The local page reader's status changed — coming up, serving, stopped, or failed with its own log tail on it. |
| `project:open` | Stand in this project — the hosted deep link, sent once as the window loads. |
| `projects:changed` | Something in the library moved. No payload: the renderer asks for the list. |
| `queue:changed` | The whole job list, on every mutation — the host's rows hosted, Foundry's own otherwise. Same shape either way. |
| `window:closing` | The window is going; ask the open documents and answer on `window:let-go`. |

---

## The one scheme, for completeness

Not IPC, but it is registered by the same call and it is process-global in the
same way: `foundry-file://book/<token>/<figure name>` serves a book file's
figure crops to the app's own page, and nothing else. Registered in
`app/electron/mount.ts`; the scheme name is Foundry's and stays Foundry's when
hosted. The same call now registers a second host on the same scheme:
`foundry-file://capture/<token>/<plain basename>` serves a capture
project's working copies and thumbnails out of `capture/derived/` — and
ONLY that directory, so the originals bank is unaddressable through the
scheme by construction. Same allow-list discipline as the book host,
name rule kept character for character.
