# foundry-app — a VENDORED subtree. Do not edit it here.

This directory is a mechanical copy of the Foundry desktop app's `app/` folder.
BookForge hosts the Foundry window inside its own process (the ruling in
Foundry's `docs/BOOKFORGE-HANDOFF.md` §8), and the copy is how that happens:
one authoritative repo, a mechanical copy, never a fork maintained by hand in
two places.

| | |
| --- | --- |
| Source repo | `C:\Users\tellt\Projects\foundry` (branch `main`) |
| Source path | `app/` — the whole folder, source only |
| Source sha | **e4a4641** — *Hosted, a long act goes to BookForge's queue and not to a modal* |
| Engine sha | **40aaa42** (v2.0.0) — the binary has NOT been rebuilt for this copy, so the two now DIFFER. See the paragraph below: that is the normal state, and the clean-text keeper anchors on the binary. |
| Copied on | 2026-09-18 |
| Copied by | Mechanical source sync, verified against Foundry `e4a4641:app/`; details below |

## The `572656c → e4a4641` re-vendor — hosted acts go to the queue (2026-09-18)

Two commits, no tracked-file change at all: 183 files before and after, nothing
added, nothing removed, `package.json` and `package-lock.json` untouched — so no
`npm ci`, only a rebuild. Verified both directions against
`git ls-tree -r --name-only e4a4641 app` and sampled by `git hash-object`.

What moved is behaviour this app is the other half of. **A long act started in
Foundry's window now goes to BookForge's QUEUE rather than to a modal of its
own**, which is the hosted shape those dialogs were missing — Foundry hosted has
no hold of its own, and a modal there was a control that changed nothing. And
their engine picker now chooses an engine that can actually do the work, rather
than offering every server and refusing late.

**Their second commit is the same complaint Owen made here the same night** —
*"stop showing logs"*. Both apps were putting an engine's log tail in front of a
person: Foundry in its act dialogs, BookForge in the queue's GPU slots. Neither
is the engine's fault; `warming_message` in `crucible/engines/base.py` appends
`log_tail(1)` because that is what an operator wants when a load is STUCK, and
early in a load that last line is the log file's own header, which is the spawn
command. Where it belongs is a display decision, and both apps have now made it
the same way.

`docs/IPC-CHANNELS.md` gains 13 lines and the count is unchanged; the collision
keeper passes 7/7 against it.

## The `7f7c06b → 572656c` re-vendor — the SDK reaches 1.0.0 here too (2026-09-18)

Three commits, taken the same night as the one below because the note below said
the subtree was the only thing in this checkout still on an older SDK. That is
now resolved at the source rather than tolerated: **the two `vendor/` archives
move 0.6.12 → 1.0.0**, which is the whole tracked-file change in the range
(183 files before and after; two out, two in).

`npm ci` rather than a rebuild, because the lockfile moves with them, and the
installed package was asked its own version rather than the filename being
trusted — `node_modules/@crucible/client/package.json` says **1.0.0**. Junction
check printed False. `npm run build` exited 0.

The other two commits are Foundry's own: the Apple-silicon analysis pack that
lets the Mac analyse at all, and a correction to sixteen dates in their notes.
Neither touches this subtree's tracked files.

**`docs/IPC-CHANNELS.md` does not move in this range**, so the channel count
stays 139 and the collision keeper's reading is unchanged from the refresh
below. It is re-copied anyway, because the recipe copies it unconditionally and
a conditional copy is a step somebody eventually skips.

**The two-SDK-versions note below is now history.** It said a reader finding
0.6.12 here beside BookForge's 1.0.0 would go looking for a bug; there is
nothing left to find, and the note stays as the record of why it was written.

## The `4e8ad65 → 7f7c06b` re-vendor — Foundry's settings become this app's shape (2026-09-18)

Asked for by Owen through the Foundry session: *"when youre done, tell bookforge
to revendor."* Twenty-two commits, and the range is mostly Foundry adopting the
settings shape BookForge landed the same night — four sections (General,
Crucible Servers, AI, Doctor), one row per job in the AI pane rather than two
cards answering "where does this class run" and "which model runs it"
separately, and act dialogs that name their engine.

**183 files, checked both ways rather than one.** A tar extract ADDS and
overwrites; it never deletes, so the half that goes wrong is the removed file
that survives. The file set was compared against `git ls-tree -r --name-only
7f7c06b app` in both directions — nothing missing, nothing extra — and a sample
compared by `git hash-object` against `git rev-parse 7f7c06b:app/<path>`,
because `core.autocrlf=true` makes a byte comparison of working trees
meaningless.

**Nine files left and eight arrived.** Five settings cards went
(`cloud-card`, `engine-models-card`, `engine-settings-card`,
`machine-models-card`, `page-reader-card`) and two panes replaced them
(`ai-pane`, `doctor-pane`); `run-progress` and `run-target` are the dialogs'
new shared children. **`electron/page-reader.ts` and
`electron/machine-models.ts` are deleted outright** — Foundry has no local page
reader any more, which is the same conclusion BookForge reached about its own
VLM endpoint box on 2026-09-17 and for the same reason: an app-side reader that
won over the engine the queue had chosen.

**The two superseded `vendor/` archives were removed BY HAND**, as this
document's recipe says they must be every time: the refresh deletes only
`electron/`, `shared/` and `src/`, so `crucible-bootstrap-0.6.7.tgz` and
`crucible-client-0.6.7.tgz` would otherwise have sat beside the 0.6.12 pair
forever. The tracked-file-set diff is what finds them.

**THE SDK IN THIS SUBTREE IS 0.6.12 AND BOOKFORGE IS PAST IT.** Crucible cut
1.0.0 on 2026-09-17 and all three engines run it. That is not a fault and
nothing is owed here: the subtree carries its own `node_modules` and its own
SDK, the contract between them is `API_VERSION` (1, unchanged), and every
engine answers both. Worth writing down because a reader who finds two SDK
versions in one checkout will otherwise go looking for the bug.

`npm ci` — the lockfile moved with the SDK bump. Junction check printed False;
`npm run build` exited 0; `tools/test-ipc-collision.js` passes 7/7 against the
refreshed `IPC-CHANNELS.md`.

**Foundry's channel count is 139, down from 147** — eight `page-reader:` and
`models:` doors removed with the reader, one added (`queue:release`, which
releases ONE held row rather than the whole batch). `queue:` is a shared family
and BookForge registers only `queue:run-pass` in it, so the new name is
verb-disjoint and the keeper agrees. Their doc had ALSO drifted before this
range — claiming 133 against a source of 146 — and is re-counted now, so the
file this keeper reads is accurate for the first time in several refreshes.

## The `c3489bb → 4e8ad65` re-vendor — 0.6.7 everywhere (2026-09-16)

A second refresh the same night, and deliberately so. Owen: *"0.6.0 literally
doesn't exist anywhere at all in the entire world... everything should be
brought fully current, including bookforge and foundry everywhere."*

All 184 files byte-exact against Foundry `4e8ad65`, verified per-file with
`git hash-object` as before. What moved is the version and the three things that
carry it: the vendored SDK pair to `0.6.7` (0.6.6 removed), and the two
byte-for-byte files that name what generated them —
`shared/foundry.module.json` to `0.6.7+92b04d4bd398`, and
`shared/model-lineup.json` to `generated_from c04ef2c`. BookForge's own
`shared/crucible/bookforge.module.json` moved the same way in the same commit,
so all four vendored copies agree with the crucible checkout at one sha.

`npm ci` — NOT `--ignore-scripts`; see the recipe above, and note that the
recipe is the reason this refresh went cleanly where the last one did not.

## The `24f586b → c3489bb` re-vendor (2026-09-16)

**All 184 tracked authoritative app files are byte-exact copies of Foundry
`c3489bb`**, verified one at a time by comparing `git hash-object` of each file
here against `git rev-parse c3489bb:app/<path>` there — the platform-neutral
check, because `core.autocrlf=true` makes a byte comparison of working trees
meaningless. 184, not 180: six files arrived (`electron/crucible-models.ts`,
`shared/model-wire.ts`, `src/app/pages/settings/engine-models-card.component.ts`,
`test/crucible-http.test.ts`, and the two 0.6.6 archives) and the two 0.6.2
archives were removed. The refresh recipe below does not delete outside
`electron/`, `shared/` and `src/`, so superseded `vendor/` archives have to be
taken out by hand every time — the tracked-file-set diff against
`git ls-tree -r --name-only <sha> app` is how they are found.

**The SDK moved 0.6.2 → 0.6.6** with it, which is why `package.json` and
`package-lock.json` are in the diff and why this refresh needed `npm ci` rather
than a rebuild. `node_modules/foundry` was NOT created: the `foundry: file:..`
self-link is gone from authoritative source, so the junction hazard the recipe
warns about no longer applies to this subtree. The check still costs nothing and
is still worth running.

### This copy fixes a Foundry defect that BookForge's build is what found

Fourteen commits of settings work arrived — a model per act (`c4e0f67`), the
model panel (`39c8504`), remove-weights (`2a789da`), greyed-but-pressable rows
(`59a3a8e`) — and **none of it drew anything**. `EngineModelsCardComponent` was
imported by `settings-page.component.ts` and listed in its `imports:`, and never
placed in the template. Angular said so on every build, as `NG8113:
EngineModelsCardComponent is not used within the template of
SettingsPageComponent`, at `warning` — the default for that check — under a
bundle-budget warning that is always there, with exit code 0 either side of it.

Per SEALED SUBTREE the fix was made in Foundry (`c3489bb`) and re-copied, not
made here. It places the card under `<app-engine-settings-card />` and promotes
`unusedStandaloneImports` to `error` in the subtree's own `tsconfig.json`, so
the next one fails the build instead of scrolling past. Foundry: 877 pass, 0
fail; both builds green.

## Corrected 2.0.2 source sync (2026-09-16)

All 180 tracked authoritative app files are byte-exact copies of Foundry 24f586b.
Client/bootstrap archives are the frozen Crucible 0.6.2 bytes; old 0.6.1 archives
were removed. Finish waits for preparation and fresh stock verification; the host
uses the same readiness-guaranteed resumeModelPreparation() export. Source tests:
870 pass. IPC documentation remains a separately copied authoritative document.

## Native model preparation and first-run sync (2026-09-16)

Source a34b3b7 includes native engine reinstall repair and deferred preparation
until model/upstream choices are complete. Hosted readiness uses
`modelPreparationReady()` and `resumeModelPreparation()`; all five native Foundry
operation routes have fixture regression coverage. Generated backend annotations are
filtered before comparison and stripped before posting module tasks. This source follows the 2.0.1
prerelease; its published binaries have not yet been rebuilt with these changes.

## Foundry 2.0.1 connection and release sync (2026-09-16)

All 180 tracked authoritative app files were mechanically copied and verified byte
for byte against Foundry a34b3b7, including the final Crucible client 0.6.1 SDK
from Crucible 407886b. IPC documentation is copied separately from Foundry docs.
A pre-existing incorrect asar package integrity was corrected against the official
npm registry so fresh installs validate correctly. New first-run refresh, address pairing, in-app approval and optional WSL engine
task controls have CPU regression coverage; Foundry's 866 tests pass. Standalone
and embedded Electron/Angular production builds pass (existing bundle warning).
The unused `foundry: file:..` dependency was removed in authoritative source;
older historical notes below about intentionally recreating its junction and
rewriting the embedded lock describe the former package layout, not current work.
The lock remains a mechanical source copy after installing dependencies.

## Crucible integration audit sync (2026-09-16)

Mechanically copied all **19 changed/new authoritative `foundry/app` files**,
including client/bootstrap **0.6.1** tarballs, package/lock files, the generated
module manifest and lifecycle/race tests. Removed superseded 0.6.0 tarballs.
Every copied file was SHA-256 checked against its source after restoring the
embedded lockfile following npm install; `IPC-CHANNELS.md` was refreshed from
Foundry's documentation. The resulting source is committed at **3938e31**.
All 173 authoritative app files were checked: 110 were byte-exact and 63 differed
only in line endings, with no missing source files or semantic differences.
Standalone and embedded runtime bundles were rebuilt
successfully after this sync; Foundry's 847 tests passed.

The authoritative app bootstrap and Settings server card were also refreshed:
those two files had real pre-existing drift (other apparent differences were
line endings). The stale server card lacked the required shared-engine field
and prevented the embedded renderer from building.

This sync removes Foundry's WSL-only local discovery and hardcoded startup,
wires Crucible's shared lifecycle/native installation flow, and repairs
cancellation, lease renewal and duplicate-engine alias handling. See Foundry's
`docs/CRUCIBLE-INTEGRATION-AUDIT-2026-09-16.md` for evidence and limitations.
The 0.6.1 binary release is unpublished: fresh installs request that version and
fail explicitly until its corrected runtime packs are published. This source
sync does not deploy or validate a clean-machine binary installation.

## The `44b5b8a → 3b65be5` re-vendor (2026-09-16)

Three commits, no deletions, 169/169 blobs verified, `dist/` rebuilt.

- **`3452e71`** — an edit racing admission refuses BY NAME instead of vanishing.
  Foundry's `setWaitFor` opened with a bare return for any state but held or
  queued; the picker IS drawn on a queued row and their pump marks running before
  its first await, so a click could land between the frame a person read and the
  row being admitted — and the edit silently did nothing. They took BookForge's
  `venue_fixed_at_admission` for the running case and added `already_finished`
  for terminal ones, because "a GPU took it before your change arrived" is false
  about a row that ran an hour ago.
- **`d3529bd`** — the live queue's GPU dial, mirroring
  `docs/PENDING-QUEUE-AND-GPU-DIAL.md`. Owen ruled that Foundry's existing `held`
  state IS the pending band rather than a second band in front of it. Their dial
  RESTRICTS and does not redirect, independently matching `decideWaitFor`.
- **`3b65be5`** — `{name, source} | null` instead of a venue with a defaulted
  source beside it.

The third one came out of a BookForge observation and is worth keeping. Our
`VenueSource` has no default — not by foresight, but because the parameter is
required and every call site passes a literal. Said plainly to Foundry, whose
version was safe only because a path could not be reached, which is a claim that
decays the moment somebody adds a branch. They restructured so the wrong default
has nowhere to LIVE rather than nowhere to be read.

That is the same shape as `waitForResolved` being its own lock: no separate flag
beside a resolved venue, no separate source beside a venue that might be absent.
Both make the bad state unconstructible instead of unreachable.

## The `75e53b3 → 44b5b8a` re-vendor (2026-09-16)

Three commits, none of them deleting a file:

- **`aafaf3b`** — the setup wizard describes the CONNECTED ENGINE rather than
  this computer. Owen opened `electron:dev` against a perfectly healthy Crucible
  and was shown his own GPU from nvidia-smi, three connect doors over a
  connection that already existed, and a page of Python env cards.
- **`778a57c`** — a wizard step that vanishes under you moves you FORWARD rather
  than to Welcome. Hiding the page-reader step made the step list shrink for the
  first time, so `indexOf` went to -1. Foundry's first fix read the landing out
  of the clamped index and put everybody on Welcome — the same bug wearing the
  fix's face.
- **`44b5b8a`** — both of Foundry's registry doors refuse a duplicate ADDRESS.
  The mirror of bookforge `e70f30f6`; see below.

**169/169 blobs hash-verified** against `44b5b8a:app/<path>`, zero mismatched, and
the orphan check (`git ls-tree -r` against `git ls-files`) found no deletions and
no new files — the only two files here that are not Foundry's are `VENDORED.md`
and `IPC-CHANNELS.md`, which are ours. `package-lock.json` is Foundry's own bytes
(`65d40ac2`), unchanged by the rebuild, and its `".."` entry is still absent —
that is the field `npm install` corrupts, not the top-level `name`.

**`dist/` WAS REBUILT THIS TIME, and the previous re-vendor is why.** This
directory is gitignored and `build:electron` does not rebuild it, so vendoring
`75e53b3` left the hosted window running the `40aaa42` bundle: source and bundle
diverged silently, and nothing in either tree said so. Rebuilding is now part of
the re-vendor rather than something to remember.

### What this range cost us, and it was worth more than the diff

`44b5b8a` came out of a cross-session exchange that found a real defect on THIS
side. Foundry asked whether our registry refused a duplicate address; it refused
a duplicate NAME and never looked at the URL, so two rows could point at one
engine and the bench would draw two GPU lanes over one card (`e70f30f6`). They
then warned that a pre-check duplicating the registry's rule is where the same
shape hides — and ours had one, on the STARTUP path, narrower than the new rule
and bypassing the door entirely (`e875c9a5`).

Their failure was loud (a throw on every launch); ours was silent (a duplicate
row). Same cause: a second copy of a rule that has an owner.

## The `40aaa42 → 75e53b3` re-vendor (2026-09-15)

Two commits, both BREAKING, both about the same retreat: Foundry stops owning
anything that decides where or on what a job runs.

- **`631bb9c`** — *no local GPU slot; one lane per connected engine, and the CPU
  lane stays local.*
- **`75e53b3`** — *Foundry keeps no models; the local text path is deleted and
  the engine decides.*

**Three files were DELETED**, which a plain `tar -x` over the top does not do —
it only adds and overwrites. They were removed by hand after the extract, and
the reconciliation was done by comparing `git ls-tree -r 75e53b3 app/` against
`git ls-files foundry-app/`, not by eye:

    shared/model-lineup-local.json
    src/app/core/llm-defaults.ts
    src/app/pages/settings/llm-card.component.ts

The only other files in this subtree that are NOT in Foundry's `app/` are
`VENDORED.md` and `IPC-CHANNELS.md`, which are ours. That difference is what
makes the comparison above a reliable orphan check rather than a guess.

**All 169 blobs hash-verified** against `75e53b3:app/<path>` with
`git hash-object`, 0 mismatched — including `package-lock.json`, which matters
because `npm install` in this directory resolves `"foundry": "file:.."` to the
BookForge repository root and rewrites the lock's `name` to `bookforge-app`. No
install was run; the lock is Foundry's own bytes
(`65d40ac2943f13d1dea87a5cee32fd378f1e6f51`). `package.json` did not move at all,
so the `file:..` devDependency is still there and the hazard is unchanged.

**`node_modules` was confirmed a REAL directory here, not a junction**, before
anything touched this tree.

**Nothing in BookForge broke, and the reason is structural rather than lucky.**
This subtree is SEALED: BookForge imports nothing from it, and every reference to
it in `electron/` is a comment beside a fact re-declared on the house rule. So
BookForge's own `tsc` says NOTHING about this copy — a green typecheck here is
not evidence. What is evidence: the keepers that read this subtree as TEXT
(`test-foundry-manifest-version`, `test-foundry-hosted-crucible-seam`,
`test-foundry-host-queue`, `test-foundry-clean-text-vendor`,
`test-foundry-host-nodes`) all pass, and the subtree's OWN two typechecks
(`tsconfig.electron.json`, `tsconfig.app.json`, run inside `foundry-app/`) are
clean.

**THE APP SHA AND THE ENGINE SHA ARE ALLOWED TO DIFFER — and at `40aaa42` they
agree**, which is the normal state rather than a problem: this table
names the code COMPILED INTO THIS APP, and
`tools/test-foundry-clean-text-vendor.js`'s tier-2 anchor names the code that
RUNS (the commit the installed binary reports). The paragraph below describes
the 2026-09-14 copy, when they happened to agree, and is kept because the
argument in it is what the keeper is built on.

*(2026-09-14.)* The `81fdc30..e6d5424` range
carries two engine commits, `527b0db` (the Ollama door back beside the OpenAI
one) and `76444fb` (a cloud provider is a door); the Foundry session rebuilt at
the tip, so `dist/foundry-windows-x64.exe` answers `foundry 1.3.0 (e6d5424)` and
`git log 12b065d..e6d5424 -- src` is empty either way. That matters for
`tools/test-foundry-clean-text-vendor.js`, whose tier-2 anchor is **the commit
the BINARY reports** rather than the commit this subtree was copied from — by
design, because BookForge spawns an installed binary that may be older than the
checkout, newer than it, or the only foundry on a machine with no checkout. Here
that keeper says `Shipped (e6d5424)` and this table says `e6d5424`, and the two
are consistent rather than drifted: one names the code that RUNS, the other the
code that is COMPILED INTO THIS APP. They re-converge at Foundry's next release.

The go-signal named `48f3a59` ("Wave 7 is complete"); `7e0bf21` added the
optional `onImport` half of the host contract, `c805bd6` added the
`foundryBusy()` export that gates BookForge's library-move door, and `4071d77`
added the `opts.document` deep-link so an Open button lands ON a file (same
admission rules as a drop). `6a9d31c` brought Owen's first-smoke fixes:
`74c20c8` (hosted, the dev-checkout engine fallback refuses out loud),
`911eab9` (the aligned view says "simplification" when the pass was a
simplify), `82a3763` (hosted, closing the last tab closes the window instead
of falling through to Foundry Home — this one added the `window:close`
channel, the first channel change since the copy began), and `6a9d31c` itself
(a project opens showing the latest change its position names, not the
original file). `ec1edda` brought the queue-rebuild pair: `e8b0399` — the
HOST-OPERATIONS SOCKET (`mountFoundry({hostOperations})`, `setHostNodes()`,
the `host-ops:` channel family — three handles and one push, a family
BookForge owns nothing in, so collision-safety is structural) — and
`ec1edda` itself, the provenance-tree redesign (cards on a drawn spine,
plain-sentence titles, host nodes drawn in the same grammar; the composer
of Owen's pipeline ruling). `6925d21` brought Owen's viewer rewrite: `7f7bd8e`
(a contents entry pointing inside a chapter is a heading, not a division),
`e6a736c` (the register stands above the paper), `7d34935` (chapter marker at
the hand — an X on the rule, right-click starts one), `370fafc` (ONE VIEWER,
NO TABS — columns, strips and pins retire), `218f0b2` (TabsService becomes
five services), `1858041` (Compare — a second read-only column locked to a
chosen step), `7eb10da` (Wave 6 closes), and `6925d21` itself (the book
scrolls again). `a32c087` is HOST-OPS ROUND 2, the whole delta from 6925d21
in one commit: `ExportLanding.stepId` (exports know their ledger step, also
in project.json final[] rows), host ops offered on export rows, the in-window
form dialog (`HostOperationOffer.form: HostOpField[]`, `invoke` grew a third
`settings` arg — two-arg hosts keep working), nav-rail buttons for formed
'book' ops, failed nodes withhold chaining ops (CHAINABLE_FROM table) and
render Retry/Dismiss when the host registers `FoundryHost.onNodeAction`
(new handle `host-ops:node-action`; 69 total). `host-ops:offers` now answers
`{operations, nodeActions}`. `1c7d6c9` is Owen's per-stage ruling ("the only
options that exist are the ones that are possible for that stage"), Wave 10:
`NodeOutput` grew `'export'` — export rows produce it, ledger steps never do,
`offeredFrom` stays one comparison — so BookForge's narrate moved to
`appliesTo: 'export'` in the SAME commit as this refresh (at 1c7d6c9 a narrate
still saying 'book' would draw on steps only, the exact inverse of the
ruling); Foundry's own offers now gate per act on shared possibility
predicates (new `shared/stages.ts`), and the delta also carried `0fc3bfd`
(docs-only date corrections). Each refresh changed only the files its commits
name and was hash-verified against the source tree. `69998c7` closed the two
gaps Owen hit minutes after 1c7d6c9 landed: the export row's click now TAKES
the selection (so the "from here" footer — where narrate lives — can actually
open on it; pickRow's old premise "nothing is ever made from an export" was
made false by Wave 10 itself), only the EPUB export row produces 'export'
(a txt/reprint offering a file-consuming act could only refuse), and the
rail's formed host acts gray on the new `hasEpubExport` predicate instead of
refusing at press. `e8396b4` is Wave 11 — Owen's six rulings off the first
real narrate press: no "from here" label on export rows, the dialog's submit
says what the host declares (`HostOperationOffer.submitLabel?`, BookForge
declares "Add to queue"), export rows are addressable (`export:<file>` node
ids — a RESERVED prefix on the socket — sent by both the row's press and the
rail, so ghost audio rows hang under the EPUB card), the EPUB export nests
under its provenance step, the sidebar widened, and the rail's buttons moved
into the sidebar bottom with the tree scrolling above. `1430bef` is Wave 12,
Owen's action-menu ruling ("no longer a nav rail, now its an action menu.
[icon] [action], one after another"): the dock is a vertical ordered list —
navigation, then the pipeline in run order (Read, Translate, Simplify,
Export, Metadata, audio acts last), then Settings under a divider; graying
unchanged. Renderer-internal rename: ToolRailComponent → ActionMenuComponent
(`components/action-menu/`); no channel, shared type, or preload surface
moved (94/94 blobs at 1430bef). `fd99b39` is Owen's verdict on the first
formed dialog ("looks ridiculous, things are all over the place, splitting
lines"): the host-op dialog's body now lays a runtime form out by RULE over
the four field kinds — a toggle is one line of prose with its checkbox
beside it, adjacent numbers pair two to a row (the translate dialog's
`.pair`, as `.row.two`), selects/text stay full-width, help notes live in a
per-field `.cell` under the half they explain, card 460→520px. One file,
renderer-internal; no channel, shared type, or preload surface moved (94/94
blobs at fd99b39). `d5b236c` is Owen's narrate-from-any-step ruling ("if they
arent doing it from an epub then we export the epub automatically"): the
mount seam gains `exportEpubFromStep(projectDir, stepId) →
Promise<ExportLanding>` (the export dialog's own plan/enqueue/landing path
with nobody in front of it; `ExportLanding` re-exported through mount),
`HostOperation.appliesTo` widens to `NodeOutput | readonly NodeOutput[]` (a
single value behaves byte-identically — a host that has not moved is
untouched), `job-queue` gains a multi-listener `onJobSettled` firing AFTER
the landing, the `workspace.ts` facsimile-name conflation splits into
`forStep`/`keyedTo`, and the action menu's host-act gray moves from
`hasEpubExport` onto `canRunHostActFrom` (= `hasBookAt`, one predicate for
gray and refusal alike) with book-consuming acts pressing the standing
step's own id. No IPC channel added or renamed; the `appliesTo` payload
widening carries a dated row in `IPC-CHANNELS.md` (94/94 blobs at d5b236c).
`2934adc`+`8691110` are Owen's next two rulings in one refresh: the host's
formed acts move up the action menu to sit right after Simplify ("right next
to translate and simplify"), and the window chrome gains the HOST STATUS
CHIP — the one surface a host may draw there: `HostStatus {headline,
detail?, percent?, pending?}` in shared/host-ops.ts, `setHostStatus(status |
null)` through the mount seam (per process, not per project), optional
`FoundryHost.onStatusOpen` making the chip clickable, three new channels
`host-ops:status` / `status-changed` / `status-open` — 71 invoke handles now,
`status-changed` being a push in the push table, not a handle. Standalone
Foundry draws nothing — the chip's host element is display:none until a host
pushes, so the un-hosted window is unchanged in every pixel (95/95 blobs at
8691110). `29c40a0` is Wave 15, both halves of Owen's narrate report
("the narrate button in the bottom left of the foundry window is disappearing
and disabling seemingly at random") that were NOT ours to fix: (a) the import
row orders a host act — `canRunHostActFrom` is now `hasBookAt` MINUS the import
clause and nothing else, `hasBookAt` itself byte-for-byte unchanged, and the new
`hostActPositionFrom(ledger, standing)` decides what the press names (an import
names its NEWEST reading; everything else names itself; a bank with no read step
in the ledger REFUSES with a sentence rather than sending a node whose own export
path would decline it). Consequence to expect rather than debug: a narration
ordered from the import row hangs under the READING in the tree, because we echo
the nodeId verbatim. (b) `setHostOperations(operations)` + the
`host-ops:offers-changed` push, mirroring `status-changed` — the offers were asked
ONCE at renderer boot and nothing could revise them, so a voice installed after
the window came up was invisible until it was closed and reopened;
`refreshFoundryNarrateForm` now pushes on every recompute, in both directions
(a refresh that FAILED has revised the form too). Handles stay 71 — a push is not
a handle — and the push table goes 13 → 14. Still grey where it should be: an
UNREAD scan has no bank for `exportEpubFromStep` to mint from, and Read is
already the act offered there. NOT in the diff and available on request: the
TREE's root row for a read scan still offers no host acts, because that gate is
the row's `produces` rather than this predicate (95/95 blobs at 29c40a0).
`c999195` is ONE LINE in `electron/window.ts` and it closes a defect that had
been reachable in every hosted build since the queue started broadcasting.
`broadcast` sent to `win.webContents` for every `BrowserWindow.getAllWindows()`
with no guard; `getAllWindows()` filters destroyed WINDOWS but not a live window
whose WEBCONTENTS has died, which is what a crashed renderer leaves — and HOSTED,
that list is BookForge's windows too, so the exposure exists only in the
configuration standalone Foundry cannot produce. Found by bookforge-mac-2 reading
the 15b diff: `setHostOperations` had become the one statement in an AWAITED
`refreshFoundryNarrateForm` that could reject, which would have meant the Foundry
window never opening. The queue path is worse and older: their `changed()` is an
unguarded `notify(listJobs())` wired to `broadcast('queue:changed')` and called
throughout `pump()`, so a throw unwinds between a row being marked running and
the engine being spawned, or straight out of `enqueue()` into a person's press.
One line, and it covers `setHostNodes`, `setHostStatus`, `queue:changed`,
`projects:changed`, `vllm:status-changed` and `env:install-progress` (94/94 blobs
at c999195). `d1dd5b6` IS THE QUEUE SEAM — Owen's ruling of 2026-08-18, "we need
to centralize the queue in bookforge… things shouldnt be queued in foundry's
queue from within bookforge". `mountFoundry({hostQueue})`: when a host supplies
one, a press in the hosted window mints no local row — Foundry calls our
`enqueue` and returns the row WE minted, and its shelf mirrors our list. Three
new exports come back the other way: `runJob(request, {parentStep, onProgress,
signal})` executes ONE job now and resolves with the settled `Job` row (a row is
born running; nothing is held or queued locally), `setHostQueueRows(projectDir,
rows)` pushes our rows at their shelf, `hostQueueDrained()` is how their vLLM
reading server learns our queue has no Foundry work RUNNING. ROUTING IS A DOOR
RATHER THAN A FLAG — `enqueue`/`cancel`/`remove`/`start`/`clearFinished` route;
`enqueueHere`/`cancelHere`/`enqueueEnvInstall`/`runJob` cannot, so no path can
half-route — and a `runJob` run sits OUTSIDE their serial slot deliberately: it
must not wait for the slot and must not hold it, or a host awaiting
`exportEpubFromStep` behind a three-hour read would deadlock. Env installs stay
theirs (a precondition of the engine running at all). Three things they REPORTED
rather than quietly fixed: a reading never fires `onJobSettled` (pre-existing;
nothing here subscribes, but anything that ever waits on a read that way HANGS
rather than fails), an env-install row is invisible in the hosted shelf until
they union it in, and the enqueue dedupe moved to us with the scheduling — see
`productOf` in electron/foundry-host-queue.ts, which keeps their rule that the
OUTPUT is the identity (94/94 blobs at d1dd5b6). `92ab737` IS THE FIRST REFRESH
SINCE THE COPY BEGAN THAT MOVES THE ENGINE — `src/vlm/book-run.ts` is outside
`app/`, so `dist/foundry-windows-x64.exe` had to be rebuilt
(`bash tools/release-build.sh windows-x64` in the Foundry checkout), not just the
subtree. Three fixes: (a) THE REFLOW RACE — `writeBookFile` now holds one
in-flight promise per folded output path, so a second caller awaits the first
instead of spawning a rival engine. That race is what produced Owen's "could not
be turned into a book" refusal on a book that HAD been made: the queue's reflow
and the window's `ensureReadingBook` ran together, and the second deleted crops
the first was still writing (EBUSY at image #41). The gate is at the chokepoint
rather than at the two call sites, so the next caller is serialised by
construction; `writeEpubBook` got the same gate because `ensureReadingBook`'s
check-then-act guards both branches. A retry ladder on EBUSY/EPERM/EACCES is in
as DEFENCE IN DEPTH and its docblock says so in as many words — we both nearly
shipped the ladder AS the fix. And a reflow failure with a book already on disk
now RETURNS that book instead of claiming none exists. (b) THE STRUCK-PICTURE X —
BookForge's diagnosis: the mark is a background-image on `.body` and a plate is
opaque CONTENT painted over it, so prose showed the X through its glyph gaps and
a picture hid it entirely. `figure::after` carries the same gradients over the
plate, keeps the growth on `background-size`, keeps `mix-blend-mode: multiply`,
and is named in the reduced-motion list; the body's own mark is suppressed under
`:has(figure)` or a narrow plate wears two marks at two sizes. Named cost:
multiply cannot lighten, so the X approaches invisibility over a near-black
region of a plate. (c) ENV-INSTALL ROWS are unioned into the hosted shelf at
BookForge's request — and drawing the row made its cross reachable, so their
`cancel`/`remove` now test the KIND before forwarding rather than assuming no row
in the shelf is theirs (95/95 blobs at 92ab737). `73e7147` is a MODE-ONLY commit
— the four `tools/*.sh` committed 100644, which bookforge-mac-2 found by trying
to build the engine on a Mac; verified here as 0 insertions and 0 deletions, so
the engine binary stands. `b2b8562` is Wave 18, Owen's ruling on what the
workbench draws: *"it should never show html tags on the workbench, it should
just show the product of the tags"*. (a) `productOf` consolidated to one function
on their side, the debt they owed after BookForge shipped the mirror-image bug.
(b) EMPHASIS — `app/shared/inline.ts` restates the engine's inline rules on the
app side, deliberately NOT shared code, because the app never imports the engine,
it SPAWNS it; verified by equivalence over all 734 asterisk-bearing blocks in the
library, compared character by character with per-character bold/italic flags,
zero disagreements. (c) THE TABLE draws a grid, and the sanitiser is stronger
than an allowlist: not one character of the model's string becomes markup — the
fragment is read into rows, cells and two clamped integers and the component
draws THAT. No innerHTML, no bypassSecurityTrust, nothing a later hand can relax;
a fragment it cannot parse prints as prose under a sentence saying so, never
blank. CORRECTION CARRIED WITH IT: their earlier claim that the engine escaped
`**` into the EPUB — and therefore that BookForge's TTS had been reading
asterisks aloud — WAS FALSE. `src/vlm/dots.ts:492` has converted `**bold**` to
`<strong>` for as long as the function has existed, both EPUB writers reach it,
and an EPUB on disk carries `<strong>` with zero asterisks. Owen saw the
workbench, never the EPUB. BookForge had already closed the question by the other
route: e2a's `chars_remove` maps `*` to a space in `normalize_text`, so nothing
was ever spoken (95/95 blobs at b2b8562). `961a726`+`f8c8d6a` are Foundry's
answer to a defect BookForge reported from the OTHER side of the same wall: WSL
auto-mounts FIXED drives only, so a mapped drive is a network path wearing a
letter and no string test tells it from `C:`. `env-install.ts` downloads the
five-gigabyte environment archive to `FOUNDRY_ENV_TMP` — which exists precisely
so a machine with a small system SSD can send it somewhere roomier, and on a
machine like this one the roomier place IS the NAS — then hands that path to the
distro so its own tar can unpack it. Where BookForge STAGES (right for a few
kilobytes of session state, wrong for 5 GB), Foundry REFUSES EARLY: a new
`networkPathBehind()` asks the filesystem which share a path really lives on,
checked right after the temp dir is made and only when a distro is involved, so
the cost is a second rather than a whole download. Three limits they drew
deliberately — the host-side unpack reads the archive with Node and is happy on a
share, so no distro means no check (refusing there would break a working case);
an unresolvable path answers `null`, because "I could not tell" must never read
as "network drive"; and `toWslPath` stays PURE, with its docblock corrected —
it claimed a protection it only half had, which is what made this cost them an
hour. `f8c8d6a` itself repairs a PLAN.md entry that a `String.replace` had
spliced 1,507 lines into (`wsl$` + `` ` `` is JavaScript's "everything before the
match"), caught because the commit stat said 1549 insertions where 45 were
expected. No IPC change — still 71 handles, 14 pushes — and nothing outside
`app/` moved, verified here rather than taken, so the engine binary stands
(96/96 blobs at f8c8d6a).
`f858e41` is 105 commits and the biggest refresh since the copy began — Owen's
capture stage (photograph a book, light table, crop/turn/split, mint to pages)
plus the two fixes BookForge asked for over the switchboard. **The narrate fix
is `a7d88bf`, and it was never narrate:** every host act vanished at once,
because `projectDirOf` asked `pathIsProject` first and looked a book tab's path
up as a project DIRECTORY by exact match — true of the tab `bookTabIn` makes,
FALSE of the one `openExportView` makes, whose path is an EPUB in `final/`. So
the window could not say which book was in front of it and `ActionMenu.hostReady`
had nothing to ask about; the tree's export row kept its button because that path
asks what the ROW produces. **The hosted-Home guard is `0ab0e51`** — two routes
reached Foundry's Home in a hosted window, a deep link that resolves to nothing
openable and closing the shown document with another still open; both drew a
front door to a library BookForge owns. 15 files added, none removed, 111/111
blobs hash-verified. IPC: the new `capture:` family, nine names (eight doors and
one push), a family BookForge owns nothing in — so collision-safe by
construction, and the keeper agrees. **THE ENGINE MOVED and its binary is
STALE:** `git log f8c8d6a..f858e41 -- src` names **seven** commits, all dated
2026-08-20, and `dist/foundry-windows-x64.exe` was built 2026-08-18 23:19 — so
every one of them is on the wrong side of it. `--pages` was parsed and never
registered (so it was never reachable at all), the token cap belongs to the book
rather than the model and is asked at the send, a refused page names the cap that
stopped it, a runaway becomes an empty page, and a read takes PAGES. The subtree
here is current; the binary a hosted read spawns is not, until
`bash tools/release-build.sh windows-x64` is run in the Foundry checkout.
SCOPE THE COUNT TO `src`, NOT `src/vlm` — the build entry is `src/cli.ts`
(`tools/release-build.sh:113`), and `--pages` lives in `src/commands.ts`, so the
narrower path misses it. And scope it to the FETCHED RANGE, never `--since` from
HEAD: run from a checkout that is behind (the pinned subtree is one by
construction) `git log` cannot walk to commits that exist only ahead of it, and
answers with a clean nothing — the staleness being tested for is the staleness
that hides the evidence. bookforge-mac-2 hit exactly that, 2026-08-21.

`98031b0` is 24 commits and seventeen waves, released by Owen ("looks good. lets
release the re-vendor.") after the Wave 25 hand-test that seq 151 held it for.
114/114 blobs hash-verified against `98031b0:app/`, plus `IPC-CHANNELS.md`
byte-identical to `98031b0:docs/IPC-CHANNELS.md`. **`fd899bf` closes the hole
this side reported** (switchboard seq 158): our `1ed04c1d` removed the hold and
their `d9ed267` removed the hosted shelf, and together a hosted Add answered
nothing anywhere. `ui.confirmQueued(said)` is the one door — hosted it writes
the notice surface (a TOAST TRAY as of Wave 32), standalone it announces to the
shelf's live region exactly as before — so the routing is one rule rather than
a `hosted()` branch in four dialogs. Option (a) in all but name, and theirs, as
it should have been. **IPC: the doc's own count was stale at 71 since 08-18 and
is now correct.** Verified HERE from the vendored source rather than taken from
the header: `84` `ipcMain.handle` call sites, `84` distinct channel names, zero
duplicate registrations, zero `ipcMain.on` — and the collision keeper is green
against it. Net channel deltas vs f858e41: **+ `book:confirm-unapplied`,
+ `book:pending-save` / `-read` / `-clear`** (waves 29/36, the unapplied-work
guards); `capture:pages-load` was added in Wave 34 and REMOVED in Wave 41, so it
never reaches us — `electron/ipc.ts:1692` carries its gravestone. The mount seam,
`hostQueue` routing, `runJob` and `exportEpubFromStep` are UNCHANGED; all twelve
seam exports rebuilt and present. Inherited but never executed hosted: the queue
slot board (gpu 1 / cpu 2), the Home intake workspace, the action-menu tile grid,
the capture two-pass rework. `package.json`, `package-lock.json`, `angular.json`
and all three `tsconfig*.json` are unmoved by this refresh, so the existing
`node_modules` stands and no install was run. `npm run build` clean; `ng build`
756.21 kB, budget WARNING only.

**THE HOSTED ENGINE IS 70 `src` COMMITS BEHIND, and it is NOT the binary this
file has been warning about.** The f858e41 note pointed at
`<foundry>/dist/foundry-windows-x64.exe`; that is not what a hosted read spawns.
`engineCommand()` refuses its dev-checkout fallback when hosted, so the answer
comes from BookForge: `main.ts` sets `FOUNDRY_BIN` from
`resolveFoundryPath()` → `componentManager.resolveEntry('foundry-cli')`. On this
machine that is
`%APPDATA%\BookForge\components\foundry-cli\foundry.exe`, and it answers
**`foundry 0.9.1 (72817c6)`**, installed 2026-08-11 — while the checkout's dist
exe is `0.9.2 (92ab737)` and source is now 98031b0. Neither `FOUNDRY_CLI_PATH`
nor `FOUNDRY_BIN` is set at User or Machine scope, so nothing overrides it. There
is no version floor that would refuse: `effectiveFoundryVersion()` feeds
staleness display, not a gate, so an old engine runs QUIETLY. Ten of those 70
commits are the ones the vendored app now expects (`--pages` reachable at all,
the per-book token cap, a refused page naming its cap, the reflow race, the
Wave 37 pages face). Closing it is two steps and neither is a subtree refresh:
`bash tools/release-build.sh windows-x64` in the Foundry checkout, then
reinstalling the `foundry-cli` component from that artifact. Left undone here
deliberately — it rewrites Owen's installed environment, which a vendor commit
should not do.

`2dbd557` is three commits and ONE app file. `9317b3a` is the whole of it —
*a read is the book arriving, not the project arriving* — the arrival test gets its
own table in `app/shared/ledger.ts`, after Owen hit a freshly-read book with
Translate/Simplify/Export greyed and `hostActPositionFrom` answering null from the
read step (Reinhold Krause, 2026-08-22). `3264e10` is docs-only (Wave 42 proposed,
the engine version floor) and `2dbd557` is the version bump this side asked for,
which touches the repo root and not `app/`. 114/114 blobs hash-verified;
`IPC-CHANNELS.md` byte-identical and UNCHANGED from 98031b0 — no channel moved,
so the count stands at 84/84/84. Build config and deps unmoved again; `npm run
build` clean, ng 756.29 kB, budget WARNING only; all 44 keepers green.

**THE ENGINE GAP THE LAST ENTRY RECORDED IS CLOSED, and the fix was a release
rather than a hand-copy.** v0.9.3 is published from `2dbd557` with the
four-platform asset set plus `checksums.txt`, and `api.github.com/.../releases/latest`
answers it — so the managed `foundry-cli` component can do the install the way the
machinery was built to, on every machine, instead of one binary being copied into
place here. Two facts from that night worth keeping beside the last entry's
warning: the published v0.9.2 (2026-08-17) was built from `92ab737` and carried
only ONE of the seven engine commits this app depends on, so upgrading to it would
have closed 60 of the 70 `src` commits and almost nothing that mattered; and
`0.9.2` had come to name at least four distinct builds, because foundry's semver
is a hand-edited `package.json` field that no build moves. The number was bumped
BEFORE the release build so the tag names exactly one commit. The parenthesised
sha in `--version` is still the only part that identifies a build, and Foundry's
proposed version floor (their Wave 42) is specified to compare that sha rather
than the number.

`644831a` is ONE component and it closes something Owen saw: a hosted narrate
refusal drew its toast *"elevated to halfway up the screen"*. The tray is
`position: fixed; bottom: 424px`, an offset derived to clear the queue shelf —
and hosted there is NO shelf (`d9ed267`, Owen's ruling), so it cleared a surface
that was not there. Foundry had NAMED that cost in the tray's own docblock rather
than missed it; what this side contributed was the separation: the motion they
refused was a tray reading QUEUE STATE and moving under a reader's eye, whereas
`hosted()` is fixed for the life of the window, so a hosted anchor is a second
static layout and not a moving one. Taken verbatim as `:host(.hosted) { bottom:
16px }` with the standalone gap untouched. 114/114 blobs; `IPC-CHANNELS.md`
unchanged again, so still 84/84/84 and no channel moved; all 44 keepers green.

Recorded for the next person who reads a refusal sentence and goes looking in the
wrong repo: the OTHER half of that same report — narrate refusing from the nav
tiles on a freshly-read book, while working from the EPUB tree row — was already
fixed by `9317b3a` in the previous refresh. `shared/ledger.ts` has the account: an
arrival weld made `hostActPositionFrom` answer null from a read step, *"refusing
the host act on the very row that IS the reading it wanted"*. Two symptoms, one
press, two different files, and only one of them was ever ours to look at.

`be937ea` is four commits — three waves and one fix — and **not one of them
touches the host contract.** `electron/mount.ts`, `shared/types.ts`,
`shared/host-ops.ts`, `electron/preload.ts` and `docs/IPC-CHANNELS.md` are
byte-identical to 644831a; re-counted HERE from the vendored source rather than
taken from the header, `84` `ipcMain.handle` call sites, `84` distinct channel
names, zero duplicates, zero `ipcMain.on` — unmoved, and the collision keeper is
green against it. 118/118 blobs hash-verified against `be937ea:app/` (114 last
time: five files added, one deleted). `package.json`, `package-lock.json`,
`angular.json` and all three `tsconfig*.json` are unmoved again, so the existing
`node_modules` stands and no install was run; `npm run build` clean, ng 801.07 kB
(756.29 → 801.07, budget WARNING only, matching Foundry's own gate line); all 44
keepers green.

`d2ad1cf` is Wave 43, and it is the one that changes what the hosted window is
made of — by SUBTRACTION. Owen's ruling ("make the queue shelf a bar along the
top right... a button in it for more info thatll take me to a queue page that
looks like bookforge's queue page") retires `components/queue-shelf` for a chip
in the title corner, a tray under it, a `/queue` page read from BookForge's own,
and one `core/queue-view.service.ts` both surfaces speak. **Hosted, all of it is
inert on purpose**: the route is `standaloneOnly` in `app.routes.ts` and the chip
renders under `@if (!hosted())`, because "the hosted window's queue IS the
host's". So the hosted window gains no surface and loses the slot board the last
entry listed as inherited-but-never-executed. Scheduler, slots, doors and drain
untouched.

**The hosted toast-tray override this side sent last refresh is GONE, and that is
the fix landing rather than being reverted.** `:host(.hosted) { bottom: 16px }`
existed to clear a 424-pixel shelf; Wave 43 deleted the shelf in both worlds, so
the tray simply anchors `bottom: 16px` everywhere and there is no hosted branch
left to keep in step. The argument this side contributed survives verbatim in the
tray's docblock — a tray that READ queue state and moved would be motion under a
reader's eye, whereas `hosted()` is fixed for the life of the window, so the
hosted anchor was a second static layout — now generalised into one rule.

`5c4bb68` is Wave 44 (a hand-renamed or composed chapter title becomes an
ordinary records row at a chapter position — a prefix on an existing field, so
every old records file parses unchanged and no KEY_FORMAT bump was needed; it
rides masking, batching, retries, the cost cache, resume and user-row
protection), `2f09c66` fixes the page-glance card into the workbench gray
(`position: fixed`, clamped and vertically centred, no scroll listener) and
centres the queue page, and `be937ea` itself is Wave 45, THE SWEEP: a census
modal over one regex, each match verdicted keep/strike, landing as pending edits
— span cuts as serial record corrections with the seam mended, a match that
empties its block as an op — through two new `BookStack` members. Its contract is
Foundry's `docs/SWEEP.md`, which is not part of `app/` and so is not carried here.
Renderer-and-shared only: `core/sweep.ts`, `components/sweep-dialog/`,
`components/queue-bar/`, `pages/queue/`, `core/queue-view.service.ts` are the new
files; `shared/materialize.ts` and `shared/records.ts` carry the title rows.

**THE INSTALLED ENGINE IS ONE `src` COMMIT BEHIND AND ITS VERSION NUMBER CANNOT
SAY SO.** `%APPDATA%\BookForge\components\foundry-cli\foundry.exe` answers
`foundry 0.9.3 (2dbd557)`, which is the published v0.9.3 the last entry recorded
as closing the gap — but Wave 44 moved the engine (`src/translate/bookrows.ts`,
`records.ts`, `run.ts`, `commands.ts`) WITHOUT moving the hand-edited version
field, so source and installed both read `0.9.3` and only the parenthesised sha
separates them. The consequence hosted is narrow and silent: the app can read and
draw translated spine titles, and an engine that never writes those records rows
simply leaves chapter titles in the source language. Nothing refuses, nothing
crashes. Closing it is a release from `be937ea` (bump first, so the tag names one
commit), not a subtree refresh — left undone here deliberately, as before,
because it rewrites Owen's installed environment.

`c0e30e1` is ONE app file and one root file, and it CLOSES the paragraph above it
in the same night that paragraph was written. `d39f3a1` is Owen's fix to his own
Wave-43 glance: `viewChild<ElementRef>('glance')` is a type assertion the runtime
never sees, `#glance` stands on a component, so the query answered with the
component instance, `nativeElement` was undefined, `placeGlance` failed its first
test on every click, and `aimGlance`'s own *"a card that cannot be placed is not
shown"* rule then dismissed the card silently, every session. `read: ElementRef`
is the whole of it — noted here because it typechecks perfectly and no gate on
either side of the copy could have caught it. `c0e30e1` itself is the version
bump this side asked for, which touches the repo root and not `app/`, so the sha
that names the release also names the copy. 118/118 blobs hash-verified;
`IPC-CHANNELS.md` unchanged again (84/84/84, no channel moved); build config and
deps unmoved, no install; `npm run build` clean, ng 801.17 kB (WARNING only);
all 44 keepers green.

**THE ENGINE GAP IS CLOSED, and this time by a release WITH the bump.** v0.9.4 is
published from `c0e30e1` with the four-platform asset set plus `checksums.txt`,
`api.github.com/.../releases/latest` answers it, and this machine took it through
the ordinary path — the startup sweep (`checkForComponentUpgrades`) adopted the
release, `componentManager.install('foundry-cli')` downloaded, verified against
the release's own `checksums.txt`, extracted and verify-ran it, and
`%APPDATA%\BookForge\components\foundry-cli\foundry.exe` now answers
**`foundry 0.9.4 (c0e30e1)`**. No binary was copied anywhere by hand, and the
same release is what every other machine will see. Wave 44's translate engine
(`src/translate/{bookrows,records,run}.ts`, `src/commands.ts`) is in it, so a
hosted translate can now write the spine-title records the vendored app was
already able to read and draw.

Worth keeping beside the previous entry's warning, because it is the same hazard
twice: 0.9.3 named two different builds for a day for exactly the reason 0.9.2
named four — the semver is a hand-edited field and NO build moves it, so an
engine can be rewritten under a number that cannot say so. The bump is a separate
deliberate act before the build, and if it is skipped the component's staleness
comparison is not wrong, it is answering a question about a number that stopped
tracking the thing it names.

`eb24afa` is Owen's ruling about what a queue is FOR, and it is the first
refresh that REMOVES work from BookForge's side of the seam rather than adding
it. *"Only things that take a long time or use lots of resources go to the
queue. epubs can be processed right there on the spot, in the modal that spawned
the job."* So the Export dialog stopped enqueueing: a new channel `queue:run`
(the 100th row in the table, invoke → the settled `Job`) runs the export
DETACHED at the press via `runNow` → `runJob`, the dialog reports the settled
outcome itself, and the row leaves Foundry's list at the settle so nothing
lingers as history.

**What that means for the host, said plainly because it is a behaviour change we
did not make and cannot see:** hosted, no export pressed in that dialog will
reach our `enqueue` or ever appear as a row of ours. `queue:run` is never routed
to a host queue — by construction, not by configuration. What did NOT move is the
landing: `executeJob` still fires `onExport` when the file is in the project's
`final/`, so the export-as-version machinery on this side is untouched, and the
sweep still reconciles. Readings and translations route through `enqueue` exactly
as before, and `FoundryHostQueue`'s shape is unchanged — nothing in
`electron/foundry-host-queue.ts` had to move, and nothing did. Left standing and
worth saying out loud: `FoundryJobKind`'s `'epub' | 'txt' | 'pdf'` members are
now UNREACHABLE through the host queue, because `queue:enqueue` has exactly two
callers left on their side (the OCR dialog and the translate path) and neither
makes an export. They are kept, not deleted, and Foundry's
side gave the reason on the channel when we raised it — worth writing down
because it corrects the weaker one this note first carried. **The seam's
vocabulary names WHAT A JOB IS; routing is a door, not a fact about a kind**
(`job-queue.ts`'s own header rule). Those three still cross the seam in the other
direction: `exportEpubFromStep` mints such a row on Foundry's internal queue,
`runJob` returns it settled, and `ExportLanding.kind` is exactly where this side
reads the format off it. Narrowing the host-queue face would encode today's
routing accident into the type, and the next door that legitimately wants a
person-pressed rendering routed would have to widen it back. Unreachable-through-
`enqueue` is true and fine; `IPC-CHANNELS.md` and the collision keeper are the
record of it. Foundry carried
the correction into `docs/BOOKFORGE-HANDOFF.md` beside the `exportEpubFromStep`
paragraph it amends, so the contract doc and the code agree.

9 app files (`electron/{ipc,job-queue,preload}.ts`, `shared/api.ts`, the export
dialog, queue bar, queue service and queue page) plus the regenerated channels
doc — exactly the files the commit names. 119/119 blobs hash-verified against
`foundry@eb24afa` by index blob sha (LF on both sides, so `autocrlf` cannot
lie); build config and deps unmoved, so no install; `npm run build` clean in the
subtree, ng 801.59 kB (the pre-existing budget WARNING only); collision keeper
6/6 with the new channel in its input, all 44 keepers green.

Procedure note, because this refresh cost a round-trip to discover: the change
arrived UNCOMMITTED in the Foundry checkout, and `git archive` cannot copy a
dirty tree. The sha is the only thing that identifies a build, so the copy waits
for the commit — asked for and landed over the live cross-session channel
(`ListAgents` → `SendMessage`), which is now the fastest route to the Foundry
side. The whole recipe is written out in `docs/RE-VENDOR-FOUNDRY.md`.

`ada67e2` is Wave 46 and its two follow-ups, and it is the largest app delta
since the copy began: `page-glance.component.ts` (688 lines) is DELETED and
`original-panel.component.ts` (607) stands in its place — the original no longer
hovers as a card, it stands BESIDE the book — with `book-view` rewritten around
it, the action menu, metadata dialog, open-documents and `documents.service`
following. `3c6d4dd` centres the pair as one group and stops the work tree lying
about captured books; `ada67e2` itself retries the atomic rename through the
transient locks Windows takes on a file somebody just wrote, which is a fix this
platform earns and other platforms never see.

**THE CHANNELS DOC IS STALE AT THIS SHA, and this is the first time that has
happened.** `app/electron/ipc.ts` gained two handles — `meta:read-epub` and
`meta:write-epub`, the metadata dialog's doors — and `docs/IPC-CHANNELS.md` did
not move in the whole range. Verified by parsing the vendored `ipc.ts` against
the vendored doc: 87 handles in the source, 100 documented rows, and exactly
those two names in the source and not the doc. **No collision** — BookForge owns
no `meta:` channel at all, so there is nothing to hit — and the keeper passes
6/6. But it passes on an authority that is now incomplete, which is a different
thing from passing: if this app ever adds a `meta:` name, the keeper would clear
it against a doc that does not know Foundry has one. Said on the switchboard — and CLOSED THE SAME NIGHT, which
is why this table names `19f219f` and the copy command still names `ada67e2`:
`19f219f` is docs-only, `app/` is byte-identical at both, and the sha that names
this copy is the one whose DOC it carries. The doc now has both rows (102), the
parse that found the gap answers `none` against it, `ipcMain.on` is 0 so the
handle census is the whole surface, and their header gained a standing rule —
regenerate in the same commit that touches `ipcMain.handle` — so this keeper
stops inheriting their lag. Worth keeping: staleness has now landed twice in the
file whose entire job is to be counted, and both times the thing that caught it
was a refresh reading the doc as an authority rather than a formality.

`6646153` is Wave 47 and the range carries the whole answer to the
German-for-English narrate incident (2026-08-24, the Niemöller book). `18445d9`
first: THE DOCK'S HOST ACT NAMES A FILE, NEVER A RESOLUTION — the export being
viewed when the focused tab is one of the project's finished EPUBs, else the
single finished EPUB, else the pick-in-the-tree sentence, and an arrival-parked
position gets a sentence instead of the `hostActPositionFrom` hop that resolved
Owen's press to the German read step. Tree-row step presses are unchanged, which
is why BookForge's own translation guard (`stepPressTranslationCheck`, landed
the same day at 864c754c) still matters. Then the modal itself: every EPUB mint
asks WHO THE BOOK IS before it exists — Owen's ruling — through two doors, the
Export dialog's EPUB press and the dock's Metadata tile over a finished export
(Save stamps the file in place via epub-meta and persists the project block so
the next mint inherits). `shared/mint-meta.ts` carries BookForge's own filename
convention, mirrored field for field from our metadata editor: title/subtitle,
contributors with add/remove and the comma-never-reinverts rule, the two-author
"and" / three-plus "et al." forms, collapseFilenameDots, ASCII fold on disk with
Unicode kept in embedded metadata. THE SEAM GREW ITS AGREED FIELD:
`ExportLanding.metadata` is FROZEN in `shared/types.ts` — `{ title, subtitle?,
contributors[{first,last}], year?, language?, filename }`, `language` a plain
primary subtag (our amendment, recorded at their 9266fa3), absent-means-
minted-before-the-field, same posture as `stepId`. `language` follows the STEP'S
OWN CHAIN on host mints — an auto-export of a German step says `de` whatever the
stored preference — which is the seam-level twin of our guard. Landings minted
through the modal now arrive under descriptive names, so our rename-on-the-way-in
becomes a passthrough; the `(projectKey, fileName)` join is untouched. Engine
behaviour worth an audit line: `epub-meta --creator` is now repeatable and
REPLACES the set of `dc:creator` elements (paired positionally with
`--creator-file-as`; a single `--creator` against a multi-creator book used to
refuse and now replaces loudly), `--subtitle` writes the EPUB3 title-type
refinement, `--date` takes a bare year, and read output gains `subtitle` and
`creators[{name, fileAs}]` with `fields.title` now the MAIN title. Three new
channels — `meta:mint-read`, `meta:mint-write`, `meta:mint-stamp` — with the doc
regenerated in the same commit under their standing rule; no `meta:` name on our
side, keeper 6/6. Deferred out loud on their side: the cover picker (rides their
packageVlmEpub cover wave; `MintMeta.coverPath` exists in the source type but is
NOT in the landing block until then) and the narrate-confirmation target card.
Verification: 123/123 blobs hash-verified against `6646153:app/` plus
`IPC-CHANNELS.md` identical to `6646153:docs/IPC-CHANNELS.md`; `package.json`
moved for electron-builder icons only (new `build/` icons, un-ignored by the
subtree's own `.gitignore` change) with the lockfile untouched, so `npm ci` had
nothing to do and was skipped; build clean with the standing budget warning
(826.87 kB); keepers ALL GREEN.

`49bbe4a` is the same-night catch-up Owen asked for by name ("revendor to the
latest foundry engine and app versions"), and it is deliberately small: the
whole `6646153..49bbe4a` delta is TWO commits with ZERO in the engine's `src/`
(bookforge-mac-2 measured it in the checkout before this copy was taken), so
nothing about what the app or the engine DOES moved — `5818783` teaches
`electron:dev` to free its own port first (new `tools/free-port.cjs`, a
dev-workflow file end users never run), and `49bbe4a` itself is the 0.9.5
version bump, which lives in the engine's ROOT package.json and therefore
barely grazes `app/` (one dev-script line). The v0.9.5 GitHub RELEASE is the
thing this bump exists for and is tracked separately — the engine is a managed
component off GH releases, and refreshing this subtree does nothing to it, per
the standing rule at the bottom of this file. Verification: 124/124 blobs
hash-verified against `49bbe4a:app/` plus `IPC-CHANNELS.md` identical (no
channel moved); `package.json` moved for the one script line with the lockfile
untouched, so `npm ci` was skipped; build clean, same standing budget warning;
keepers ALL GREEN.

`99a7606` is the apparatus-crosses-translation refresh, taken the same night:
`8b30b2e` makes the reference apparatus survive translation — Owen's translated
evangelische book carried hundreds of bare superscript numbers, because every
ref is dropped at translation (no offset in a rewritten sentence is a known
fact). The app half vendored here is `shared/materialize.ts` (plus its
`electron/book.ts` caller): the marker runs survive translation and three
no-guess rules prove where each landed — same-sequence identity, unique-digits
order-checked, and Owen's bracket rule between proven markers, which also
splits a fused run like ⁹¹⁰ back into ⁹ and ¹⁰. It runs in MAIN at
translate-cast time, so hosted translated books get the recovery from this
refresh on. The OTHER half is ENGINE-side (`src/vlm/compile.ts`: tiled runs as
adjacent anchors, numbers no note answers for REMOVED and counted) and ships as
the **v0.9.6 release** (tag at this same `99a7606`; cut and published by the
Foundry session, verified against the built binary — 381/382 links on the
evangelische book, zero bare numbers). ORDERING that matters to a user:
re-minting a translated book needs BOTH this vendor and the 0.9.6 engine — the
new engine over the old materialize would strip every number and produce a
clean-for-TTS but linkless book. Verification: 124/124 blobs against
`99a7606:app/`, `IPC-CHANNELS.md` identical (no channel moved), two files
moved (`materialize.ts`, `book.ts`), lockfile untouched so `npm ci` skipped;
build clean; keepers ALL GREEN.

`c403ee5` is the mint modal's INHERITANCE, taken the same night it was ruled
(Owen: "when i generate an epub in bookforge foundry, it should inherit the
parent document's metadata. ill fill out whatever is missing"): the mount seam
grows optional `FoundryHost.mintMetaFor(projectDir) → Promise<HostMintMeta |
null>` — the shape frozen between the two sessions that day (`title?`,
`contributors? [{first,last}]`, `year?`, `language?` plain subtag, `coverPath?`
absolute; no subtitle, no publisher, argued in their docblock) — and the mint
dialog merges with Foundry's STORED block winning per-field, the host's answer
filling every gap, and the position still feeding the language select. A throw
from the host resolver is swallowed to null with a console line. BookForge's
half landed FIRST (8d76baf8, `foundryMintMetaFor` in main.ts answering from
the manifest: recorded contributors win, else the author string read as one
name under the comma law, "Unknown" answers nothing, cover as an absolute
existence-checked path), so the pair goes live at the next app launch with no
further wiring. One new channel — `meta:mint-host` — doc regenerated in their
same commit (91 handles, 91 rows); no `meta:` name on our side, keeper 6/6.
Verification: 124/124 blobs against `c403ee5:app/`, `IPC-CHANNELS.md`
identical to `c403ee5:docs/`, lockfile untouched so `npm ci` skipped; build
clean; keepers ALL GREEN.

The engine question, asked because `src/` moved too (translate `tablecells.ts`
is new, `bookrows`/`run` grew, five `vlm/` files changed): the metadata dialog's
new shape does NOT open a gap. It stopped editing the working tree in place —
that tree, its reader and its tab kind are deleted (their docs/RENDERER.md §7) —
and now writes through a side file with `epub-meta --epub <file> --out <path>`,
over a finished export in `final/`. The RELEASED engine already answers that
form: `src/epub/meta.ts` at `c0e30e1` refuses a file WITHOUT `--out` and names
the flag in its own refusal, so v0.9.4 predates the app that needs it. What is
gapped is narrower and silent in the same way as before: table-cell translation
and this wave's vlm work live in an engine nobody has released, and
**`package.json` still reads 0.9.4** — the fourth build to wear a number that
stopped tracking it. Closing it is a bump-then-release from `ada67e2`, not a
subtree refresh, and it is left undone here deliberately because it rewrites
Owen's installed environment mid-narration.

119/119 blobs hash-verified (one file deleted, one added — the count is a
coincidence, not a no-op); build config and deps unmoved, no install; `npm run
build` clean, ng 811.91 kB (the budget WARNING only, up 10 kB with the new
panel); all 44 keepers green.

`2dfea95` is a small renderer-only follow-on, taken the same day: Owen asked to
merge two body blocks that a since-struck image once separated, and Ctrl+J
refused the exact pair the strike set up — `flowNeighbours` still counted the
cancelled block as standing between them. Struck rows now skip like shelved
ones when adjacency is judged (unstruck notes still refuse), and the block
right-click menu gains "Join onto the block above" so the gesture is
discoverable. Two files (`book-view.component.ts`, `flow.ts`), no engine or
IPC change — engine v0.9.7 stands, `IPC-CHANNELS.md` byte-identical.
Verification: 124/124 blobs against `2dfea95:app/`, lockfile untouched so
`npm ci` skipped; build clean; keepers ALL GREEN.

`5b507fe`, taken the same day, is one file: the metadata sheet's category chip
clipped again in a second layout ("ECTION HEADER" with the original panel
docked) because the sheet's width caps were fractions (92%) — at some window
width a fraction always leaves less gray margin than the chip hangs into. The
caps' fallback arms are now absolute, `calc(100% - 10rem)`, guaranteeing 5rem
of gray each side in every mode. No engine or IPC change — v0.9.7 stands.
Verification: 124/124 blobs against `5b507fe:app/`, lockfile untouched so
`npm ci` skipped; build clean; keepers ALL GREEN.

`21bef24` (same night, tip of the **v0.9.8** release chain) carries `c626e8e`:
Owen's hosted export refused with *"block 1 is called \"u1\", which is not a
name this format mints"* — the app's insert op (missing chapter titles, 08-23)
mints `u<n>` ids, but the ENGINE's ROW_ID grammar was never grown to match, so
any book with a hand-added block refused to compile on every engine through
0.9.7. The fix grows the grammar to admit `u<n>` (with `#`/`/`/`?` riders) in
BOTH statements same-commit per the mirror rule — engine `src/` AND
`app/shared/book.ts`, which is why this vendor moves: a subtree at `5b507fe`
paired with the 0.9.8 engine would leave the app-side grammar still refusing
`u<n>`. Engine **v0.9.8 published** (binaries report "foundry 0.9.8
(21bef24)"); the pending PC adoption becomes 0.9.4 → 0.9.8 in one hop.
Verification: 124/124 blobs against `21bef24:app/`, one file moved
(`shared/book.ts`), lockfile untouched so `npm ci` skipped; build clean;
keepers ALL GREEN.

**cbc6f4c (2026-08-24):** renderer-only — `8d4d9b2` stops the sweep dialog's keep/cut rows
resizing on hover. The fuller-quotation swap used to grow the hovered row and shove every row
below it, moving the verdict button out from under the pointer (Owen's ruling). The hover
context now floats as a fixed-positioned glance at the row's edge (`pointer-events: none`,
cleared on list scroll); rows never change size. One file:
`src/app/components/sweep-dialog/sweep-dialog.component.ts`. `cbc6f4c` itself is docs-only
(SWEEP.md §2.4, outside `app/`). No host-seam or channel change; no engine change (0.9.9
stands, vendor and engine move independently here). Verified: 124/124 blobs + IPC-CHANNELS.md
identical, lockfile unmoved, subtree build clean (pre-existing 500 kB budget WARNING only),
keepers ALL GREEN.

**009a0f1 (2026-08-26):** five things landed since cbc6f4c, per the Foundry
session's own summary and the diff. (1) The capture-stage rework (Waves
51/51b/51c — sticky Global checkbox with odd/even parity scopes, live
propagation, finalize/generate renames, grid drag fixes). (2) The first-run
setup wizard (Wave 53) — **~11 new IPC channels** (setup/ollama/llm families;
`IPC-CHANNELS.md` refreshed from the same sha, collision keeper GREEN), new
app-settings fields, two new env-catalog targets (`nli-mac-arm64` deliberately
null-sha until built on a Mac). (3) `viewExportedBook` surfaces the engine's
refusal sentence in the pane instead of console-only. (4) `analyze: rank|verify
n/m` progress lines — this REQUIRED A MIRROR UPDATE on our side:
`parseFoundryProgressLine` (`electron/foundry-host-queue.ts`) gained the
pattern in the vendored order and the `foundryPhase` unions widened to carry
`rank`/`verify` (`electron/queue-engine.ts`, `shared/queue/engine-types.ts`);
the drift keeper caught it, as designed. (5) `009a0f1` itself: the action
menu's `offer.form !== undefined` filter is gone — a FORMLESS host offer now
gets a tile and is invoked immediately (one shared `press()` with the tree
footer). That change was BookForge's own pre-vendor ask: `bookforge.narrate`
becomes a formless launcher when the narration-modal branch merges (Owen's
2026-08-26 ruling — the dialog is BookForge's again), and without it Narrate
would have vanished from the action menu. Offers WITH forms are byte-for-byte
the old behavior, so this copy and that branch can land in either order.
Engine note, not part of `app/`: foundry v1.0.1 published the same day (join
fix, triple-emphasis fix, and export now REFUSES a non-well-formed spine
document by name — a refusal our pipeline may meet). Verified: 137/137 blobs
against `009a0f1:app/`, lockfile unmoved so `npm ci` skipped; subtree build
clean (pre-existing 500 kB budget WARNING only); keepers ALL GREEN after the
mirror update.

**2026-09-05 — `9f4ee4e`, THE TEXT-PASS SPLIT AND THE NARRATION CLEANUP.** The
one refresh so far that their own handoff calls **REQUIRED rather than
recommended**, and the reason is on the wire: a simplify pressed in a hosted
window sends `kind: 'simplify'` from the moment this snapshot lands, where it
used to arrive as `kind: 'translate'` wearing a `rewrite`. Vendoring the app
without teaching our queue the new kinds would have every simplify arrive as a
row this side could not name, could not dedupe (a text pass names no
`outputPath`) and would file on the wrong resource lane.

Owen ruled that day that BookForge's narration text cleanup MOVES INTO THE
FOUNDRY ENGINE as a third ledger action beside translate and simplify, named
**Clean text**, hosted-only in the UI: *"cleanup will only ever be done on behalf
of bookforge and wont be available in foundry since foundry isnt designed to
narrate text … we can add the step/logic to foundry, but only make it visible
when vendored to bookforge."* The tile, the dialog and the tree's "from here"
entry are all `@if (hosted())`; the step, the queue job, the ledger row
("Cleaned for narration") and the render path exist regardless.

**THREE CONTRACT CHANGES, and all three needed code on our side:**

1. **`HostOperation.invoke` gained a FOURTH argument** — `context:
   HostInvokeContext`, which is `{ cleaned: boolean }`: true when Foundry's
   narration cleanup is in effect at the step the act was ordered from. The
   mirrored interface in `electron/main.ts` declares it and all three of our
   operations name it. `invokeFoundryNarrate` READS it and DECIDES NOTHING with
   it (`sayWhatEachSideThinksAboutTheCleanup`): `cleaned` is false for every
   position Foundry cannot resolve — including an EXPORT row, one of the two
   currencies Narrate is offered from — so acting on it would refuse a press on
   a correctly cleaned file about half the time. What it does instead is write
   one line comparing it with the FILE's own `bookforge:narration-text` stamp,
   because the disagreement (Foundry says cleaned, the export carries no stamp
   ⇒ `vlm-compile --narration-stamp` did not ride that line) is a fact neither
   side can see alone.
2. **`FoundryHostQueue.enqueue` may be handed three text-pass shapes** —
   `TranslateRequest | SimplifyRequest | CleanRequest`. `FoundryJobKind` gained
   `simplify` and `clean` (`electron/foundry-host-queue.ts`); `productOf` now
   asks the FAMILY (`recordsPath`) rather than the translation, because a
   `clean` carries no `outputPath` at all and would otherwise dedupe against
   nothing; `labelFor` names the ACT ("Clean text — book.epub", "Simplify —
   …"), which is their own `titleForTextPass` rule for the same reason — three
   buttons now make a text pass over one book; and `resourceFor`
   (`electron/queue-steps/foundry-job.ts`) files both new kinds on the **gpu**
   lane, as their `JOB_RESOURCE` does. A cleanup is not the cheap one of the
   three: it asks the model about EVERY block of the book, one call each.
3. **`parseProgressLine` learned `clean-text: n/m`** — MIRROR UPDATE required,
   the second time this has happened (the first was `analyze: rank|verify`).
   `parseFoundryProgressLine` gained the pattern **in the vendored order** and
   the `foundryPhase` unions widened to carry `clean`
   (`electron/queue-engine.ts`, `shared/queue/engine-types.ts`). The pattern is
   anchored to the END of the line (`$`) and that is load-bearing: `clean-text`
   names what it counts only in its FINAL line, so a `\b` would read
   "412 blocks, 87 changed" as 412 of 87 and drive the bar past its own end at
   the moment the run finished. The drift keeper caught the change, as designed.

One new IPC door on their side (`workspace:plan-clean`); `IPC-CHANNELS.md`
regenerated at 108 handles and refreshed here from the same sha; the collision
keeper is green.

**A `clean` row needs an ENGINE that has the command.** It is released as foundry
**1.1.0** (`ca7a666`, "the engine that owns the narration text pass" — that
commit touches only `package.json`/`package-lock.json`, so `app/` is byte-identical
at `9f4ee4e` and at the tag). BookForge refuses a `clean` row against an older
binary by name, in the step module rather than at `enqueue` (that door is
synchronous by contract and asking a binary its version is a spawn):
`FOUNDRY_VERSION_FOR_CLEAN_TEXT` + `foundryTooOldForCleanText`, reusing the one
comparator `foundryVersionAtLeast`. Only `clean` is gated — a simplify is
`translate --rewrite`, a command every foundry this app has adopted has had.

**What did NOT change here, and is worth saying:** the engine's `clean-text`
reads a BOOK FILE and writes RECORDS plus a stamp; it writes no EPUB. So
BookForge's own narration text pass (`electron/narration-text-pass.ts`) is
UNTOUCHED by this refresh and still owns the bare-EPUB door — see
`docs/NARRATION_TEXT_PASS.md`, which now states the division of labour and the
measured gap.

Verified: **139/139** blobs against `9f4ee4e:app/` plus `IPC-CHANNELS.md`, and
zero strays; `package.json`/`package-lock.json` unmoved, so `npm ci` was skipped;
subtree build clean (pre-existing 500 kB budget WARNING only, ~925 kB);
`dist/electron/mount.js` fresh.

**c93004f (2026-09-05, evening) — every export carries the plan through one function, and a cleanup's card says so.** Two defects Owen hit on the hosted window after his first `Clean text` run (witches, 863 blocks, qwen3.8:27b): the EPUB he exported from the clean position carried no `bookforge:narration-text` meta, so BookForge's narrate gate reported it uncleaned and offered the failsafe over a book that WAS cleaned (862 of 863 cleaned records verbatim in the file); and the clean step's document card was titled "Translated". Cause of the first: the plan composed `narrationStamp` correctly, but only `exportEpubFromStep` (mount.ts) spread it into the job request — the Export dialog and the mint-metadata dialog copied records/language/bookPath off the plan by hand and stopped one field short. Foundry fixed it at the source: `carriedFromPlan(plan)` in `shared/pipeline.ts` is now the ONE function that carries a `WorkspacePlan` into a `JobRequest`, and all three builders spread it. Cause of the second: `titleForStep` had no `case 'clean'` and fell to the translate sentence; it now says "Cleaned for narration". App-only — the engine stays 1.2.0 (d6509e7); BookForge's `electron/main.ts` seam is untouched (mount exports unchanged, verified in `dist/electron/mount.js`). Verification: 139 blobs matched, 0 problems; no dependency movement; `npm run build` green with the one pre-existing budget warning; keepers `test-ipc-collision`, `test-foundry-narration-stamp` (6), `test-foundry-host`, `test-foundry-landing`, `test-foundry-narrate-target` (33) all green. End-to-end proof still owed: one export from the witches clean step (9198be16) after an app restart must show the OPF meta with `blocks` 863.

`IPC-CHANNELS.md` beside this file is `docs/IPC-CHANNELS.md` from the same sha —
it is not part of `app/`, it is carried along because it is the authority the
collision keeper (`tools/test-ipc-collision.js`) parses. Foundry's side has
committed to regenerating it from source on every wave.

## SEALED SUBTREE

**Edit in the Foundry repo and re-copy. Never here.** A fix made in this
directory is lost the next time the subtree is refreshed, and worse, it makes
the two copies disagree while both look authoritative. If something in here is
wrong, it is wrong in Foundry — say so on the `bookforge-sync` switchboard
channel (the `E:\agent-bridge` file pair it replaced was deleted 2026-08-18) and
take the next sha.

The one exception is this file, which is BookForge's own note about the copy.

## Refreshing it

```
cd C:\Users\tellt\Projects\foundry
git archive <new-sha> app > <scratch>\foundry-app.tar
# in BookForge:
rm -r foundry-app/electron foundry-app/shared foundry-app/src   # sources only
cd foundry-app && tar --force-local -xf <scratch>\foundry-app.tar --strip-components=1
git -C C:\Users\tellt\Projects\foundry show <new-sha>:docs/IPC-CHANNELS.md > foundry-app/IPC-CHANNELS.md
```

Then rebuild (below) and run `node tools/run-keepers.js` — the collision keeper
reads the refreshed `IPC-CHANNELS.md` and fails if a new Foundry channel name
now collides with one of BookForge's own.

## Building it — its own recipe, not BookForge's

The subtree keeps its own `package.json`, `angular.json` and `tsconfig*.json`,
its own `node_modules`, and its own Angular major (21, where BookForge is on its
own). BookForge's build does not compile a line of it; `tsconfig.electron.json`
and `tsconfig.app.json` are `include`-based and name only `electron/`,
`shared/`, `packages/quire/src/` and `src/` — this directory is outside all of
them, deliberately.

```
cd foundry-app
npm install
npm run build      # tsc -p tsconfig.electron.json  -> dist/electron + dist/shared
                   # ng build                       -> dist/renderer
```

`dist/` and `node_modules/` here are build output and are gitignored by the
subtree's own `.gitignore` (which came with the copy).

**`npm ci`, not `npm install`, when the refresh moves `package.json`.** f858e41
added two runtime deps (`libheif-js`, `pdf-lib` — the capture stage decodes
phone photographs), and the lockfile arrives with the copy already naming them.
`npm ci` installs exactly what that lockfile says and never writes
`package.json`; `npm install <pkg>` on this machine has been observed rewriting
a package.json and dropping its `scripts` block entirely.

**PLAIN `npm ci`. NOT `--ignore-scripts`.** This line recommended the flag
until 2026-09-16, and the flag is what broke the refresh — for the second time,
in the same way, for the same reason.

```
cd foundry-app
npm ci
powershell -c "$i=Get-Item node_modules\foundry -Force -EA SilentlyContinue; if ($i -and $i.LinkType) { $i.Delete() }"
powershell -c "Test-Path node_modules\foundry"   # MUST print False
npm run build
```

WHY THE FLAG WAS HERE, AND WHY IT IS NOT NOW. It guarded a self-link. `4beb88b`
gave the subtree's `package.json` a `"foundry": "file:.."`, and here `..` is
BookForge's own root, so `npm ci` made `foundry-app/node_modules/foundry` a
**JUNCTION to the whole checkout** — and the worktree-hygiene rule at the top of
`CLAUDE.md` exists because a recursive delete follows a junction. Skipping
lifecycle scripts kept a linked target's `postinstall` from running against our
root. **That dependency is gone from authoritative source** (recorded in the
2.0.1 sync note below), so at this sha `npm ci` creates no junction and the flag
protects nothing. Measured rather than assumed: the check above printed `absent`
after this refresh.

WHAT IT COSTS WHEN IT IS WRONG. `--ignore-scripts` skips Electron's
`postinstall`, which is the step that downloads the binary, so
`node_modules/electron/index.js` throws *"Electron failed to install
correctly"*. **Nothing in the build notices.** `npm run build` is clean, both
programs compile, the bundle is the right size — because nothing on the build
path requires Electron at run time. It surfaces in one place only: the
subtree's compiled `app-settings.js` requires it, and
`tools/test-clean-step-door.js` requires that, so a single keeper dies with a
stack trace naming a file nobody edited.

AND IT HAD ALREADY HAPPENED ONCE. The v0.5.0 sync hit this and wrote the remedy
down — `npm rebuild electron` — **in its own historical note further down this
file**, and left the recipe up here still saying `--ignore-scripts`. So the fix
was in the document and the instruction was still wrong, and the next person to
follow the instruction was the next person to lose the evening. A note that
records a fix is not a recipe that prevents it. THIS BLOCK is the recipe; the
note below is history and stays as written.

THE JUNCTION CHECK IS KEPT even though the self-link is gone. It costs a line
and a millisecond, it is the cheap half of a rule whose expensive half gutted
the main checkout's `node_modules` twice, and if Foundry ever re-adds the
self-link this is the thing that notices.

## What BookForge imports

Exactly one module, and it is imported at the TOP of `electron/main.ts`, before
anything that waits on app-ready:

```
foundry-app/dist/electron/mount.js
```

It registers the privileged `foundry-file://` scheme at import time, which
Electron refuses to do after `whenReady`. Importing it runs nothing else. The
seam's exports: `mountFoundry(host?)`, `openFoundryWindow(dir?)`,
`stopFoundry()`, `hostedLibraryDir()`, and — since ec1edda — `setHostNodes()`
plus the `HostOperation`/`HostNode` types for the host-operations socket
(`hostOperations` rides in on the host object).

The host object BookForge hands to `mountFoundry` carries `libraryDir`,
`onExport(ExportLanding)` — a finished file landed in a project's `final/` — and
`onImport(ImportLanding)`, the optional first-contact announcement that tells the
host which project key Foundry minted for a file imported from outside the
library. Both are wired in `electron/main.ts`.

The compiled main-process code runs on **BookForge's** Electron. The subtree
declares `electron ^33` as a devDependency (types at build time, plus a binary
`npm install` fetches that nobody here runs) and BookForge is on Electron 33 —
they match, so the devDep is left exactly as Foundry ships it.

**688c888 (copied 2026-09-07) — PENDING NODES AND CHAINS (Wave 56), Owen's ruling of the
same night:** a queued act draws a GREYED node where its output will land, derived FROM THE
QUEUE ROW (nothing minted or stored: the row IS the node, `row.mints` is the ledger step id it
will land under, `row.after` the row it waits on, `row.forStep` an export's step); acts pressed
on a pending node chain onto it (`request.after` = the pending row id, `deferred: {from}` plans
re-planned at spawn inside runJob); a removed/cancelled/failed row takes every node under it.
Four plan doors gained a trailing optional `from` arg; NO IPC channel added or renamed (108
handles). New `HostInvokeContext.pendingRow` when a narrate is ordered from a pending export
node. Foundry's own standalone queue carries the same hold/cascade. The host half is BookForge
bac5b3d1 (`FoundryJobRequest.after` → `appendStep` onto the followed row's run;
`queue-engine.removeStep`; `clearFinished` holds a settled root over a pending subtree).
17 files, 139 blobs hash-verified, no dep movement.
**88029f7 (copied 2026-09-07) — CHAIN ANYTHING, Owen's follow-up ruling the same night
("I'd like to make it possible to chain anything and have it pick up required settings from the
last step after it finishes ... translate -> simplify -> tts -> assembly"):** Wave 56's one refusal
(a deferred simplify under a promised translate/simplify) is gone — the step id is minted at
press and the records file is named at spawn from the landed ledger; a deferred pass is enqueued
with a PLACEHOLDER records path (`readings/<key>.<action>[.<mode>].pending-<id8>.records.jsonl`,
never written) that runJob rewrites to the real name once the parent lands. Two new optional row
fields, copied verbatim off the request by the host: `row.into` (= `request.to`, a translation's
target language) and `row.mode` (= `request.rewrite`), which only feed the promised card's
wording. No IPC change. Documented gap (both sides): a deferred pass that resolves at spawn onto
an EXISTING step lands as that step, its promised id never appears, and a child chained under the
promised id fails at its own spawn with the cascade's sentence — re-parenting a live chain is not
built. BookForge host side: 371244ef (Narrate on a pending export chains under a
`foundry-export-landing` row) + the `into`/`mode` copy in this refresh. 7 files, 139 blobs
hash-verified, no dep movement.
**be61db0 (copied 2026-09-07) — the Mac's stray-EPUB night: four fixes and Owen's app changes.**
`ed4d218` (the Mac's branch, merged verbatim): the mint-meta dialog joined the export's outputPath
with a LITERAL backslash, so on darwin a renamed export was written relative to cwd — an untracked
file named `\Volumes\iO\...\Mutineer's Moon ... .epub` landed in Owen's BookForgeApp checkout; it
now keeps the plan's own separator, and `enqueue` refuses BY NAME a product path that is not
`path.isAbsolute` before either queue sees it. `75236ab`: an EPUB export nobody confirmed at the
mint form (a host-ordered `exportEpubFromStep`, narrate on a step with no file) used to carry the
project's stored mint block or NOTHING — a bare-document project has no block until a mint is
confirmed, which is why foundry-exported books had no `dc:creator`; the settle now inherits the
request's block, else the stored block with the host's `mintMetaFor` answer underneath per field
(`inheritMintMeta`, shared/mint-meta.ts), stamps it via `epub-meta`, and announces it on
`ExportLanding.metadata` (optional; the host does not read it yet). `e4987ca`: the book's undo
listens for Ctrl/Cmd+Z and Shift+Z on its own window keydown, so a HOSTED window on Windows/Linux
gets it beside the host's `role: 'undo'` menu; on a Mac the host's role menu eats the key, so
BookForge's Edit menu now routes Cmd+Z / Cmd+Shift+Z to `menu:action` 'undo'/'redo' when the
focused window is Foundry's (`routeUndoRedo`, electron/main.ts — darwin only, else two undos a
press). Also in `e4987ca`: the sweep has a third verdict BLOCK (strike the whole paragraph), no
hover glance, and the cut/keep pill fills its column. `d463ad6`: a chained pass is deduped on what
it is, not on the name it does not have yet. No IPC channel added or renamed (`IPC-CHANNELS.md`
refreshed, byte-identical to `be61db0:docs/`). 9 files, 139 blobs hash-verified, no dep movement.
**f761f8a (copied 2026-09-07) — `foundryWindow()` crosses the mount seam** (one line in mount.ts:
`export { foundryWindow } from './window'`; null before the window opens and after it closes).
BookForge's darwin Edit menu now tests `BrowserWindow.getFocusedWindow()` against it instead of
against a `browser-window-created` capture that was right only while Foundry opens one window.
1 file, 139 blobs hash-verified, no IPC change, no dep movement.
**5a6f7d9 (copied 2026-09-07) — a host seed failure is a sentence under the mint form, not a
blank one.** `hostMintMeta` no longer swallows a `mintMetaFor` throw: the `meta:mint-host` door
rejects in the host's words ("The host could not say who this book is: …"), the modal shows it as
its problem line and still opens for typing, and the export settle catches the same throw itself
and logs by name, so an export never fails on a seed. Host counterpart: BookForge 22e8af61 (the
answering branch of `foundryMintMetaFor` logs key, projectDir, projectId and counts). IPC-CHANNELS.md
wording for `meta:mint-host` changed; no channel added. 4 files, 139 blobs hash-verified, no dep
movement.
**c8808f3 (copied 2026-09-07) — docs only: `Job.outputPath` is the row's IDENTITY on Foundry's side,
not a display field.** The Job docblock (shared/types.ts) and BOOKFORGE-HANDOFF §8b now say a host's
mirrored row must carry the product there by `productOf`'s rule: rendering → file, reading →
readingsPath, text pass incl. clean → recordsPath, analysis → report; `shelfJobsFor(projectDir)`
files rows by `projectDirOf(job.outputPath)`. Host side: BookForge 1b91d85d (a text pass's row
reports its records file — before it, every promised card was dead). 1 file, 139 blobs
hash-verified, no IPC change, no dep movement.
**11bd14c (copied 2026-09-08) — WAVE 57, Owen's "show what changed" (app-only):** stand on a
cleaned/simplified step, press Compare, pick the parent (or any step) — both columns light at WORD
granularity (shared/word-diff.ts; core/changes.service.ts): removed words red-and-struck on the
older side, added words green-washed on the newer, the ledger deciding which side is older; the
compare head reads "N blocks changed", has a Changes toggle, and ↑↓ walk the changed blocks in
both columns. Computed on demand from the two sheets' rows and memoised — NOT a stored diff and
not the engine's (foundry docs/COMPARE-CHANGES.md argues why): works for any pair of steps, never
stale, no engine release. A translation shows as whole-block changes by a rewrite guard. Not
built: hover-shows-original (the other column IS the original). 2 new files + 2 changed; 141
blobs hash-verified; no IPC change, no dep movement; nothing on the host side.
**f1d1eb0 (copied 2026-09-08) — Export EPUB on a GREYED clean waits behind it.** Owen (Mac, Shift):
"instead of queuing it to create after the cleaning finished, it just created the epub above the
cleaning." The export dialog hands a bare project (no mint block) to the mint-meta dialog, which
planned twice with NO aim, so the export was made from the landed parent, never deferred, no
`after`. Both of its planExport calls now pass `ledger.aimedAt(projectDir)` and a deferred plan is
ENQUEUED (the export dialog's own branch): the row carries `after`, the tree greys it under the
clean, and the confirmed filename survives the spawn (materializeDeferred leaves outputPath alone).
1 file, 141 blobs hash-verified, no IPC change, no dep movement, nothing on the host side.
**ceaad53 (copied 2026-09-08) — `exportEpubFromStep(projectDir, stepId, opts?: { to?: string })`,
for Owen's ruling that Narrate IMPLIES the export and the implied EPUB is nobody's version.** `to` is
an absolute `.epub` path OUTSIDE every project in the library (refused by name otherwise); with it the
file is written there and nowhere Foundry keeps — not final/, not the tray, not rotated, not drawn —
and NOT announced through `onExport`: the promise resolves with the same `ExportLanding` carrying
`unfiled: true` (shared/types.ts), the only word. A promised step still plans deferred with `after`;
the narration stamp, the metadata patch steps, the chain's language and the mint-block inheritance
ride unchanged because the request carries `home: <projectDir>` (new optional
`ConversionRequest.home`) and every project derivation asks `homeOf(request)` first
(materializeDeferred, reconcileChains, chainLanguageOf, recordFor, the settle). Hosted, the row
crosses with `outputPath` = the host's path and `home` set; the host copies it verbatim. Host side:
BookForge's implied-export wave (narrator-paths.ts `mintImpliedExportPath`, the landing step's
`unfiledPath` mode, `impliedExportPathFor` in main.ts). 3 files, 141 blobs hash-verified, no IPC
change, no dep movement.
**ceaad53 + f1a494a (copied 2026-09-08) — `exportEpubFromStep` takes `to`; Clean text opens on its
OWN model.** `ceaad53` (PC): `exportEpubFromStep(projectDir, stepId, { to? })` — an EPUB written
where the host says; the option is additive and BookForge's two-argument call at
electron/main.ts:1470 stands (types.ts, mount.ts, job-queue.ts). `f1a494a` (Mac): the Clean dialog
seeds only its Ollama URL from `defaultLlmModel` and opens on `DEFAULT_CLEAN_TEXT_MODEL`
(`qwen3.5:9b-q8_0`, the mirror of the engine's `DEFAULT_NORMALIZER_MODEL`) — the 27b that setting
names ran Shift at 8.7 blocks/min against ~50 on the 9b-q8_0 (pipeline.ts, clean-dialog,
llm-defaults `seedOllamaDefault`). BookForge's own press moved the same way in 77d00744
(`ttsNumberNormalizerModel`, never `defaultLlmModel`). 6 files, tree diff-verified against
foundry/app, no IPC change, no dep movement.

**2f7376a (copied 2026-09-08) — `cleanTextModel`, Clean text's OWN stored model, read by both doors.**
Owen: the cleanup gets a persisted setting in app-settings.json, separate from `defaultLlmModel`
(translate/simplify/analyse), default `DEFAULT_CLEAN_TEXT_MODEL` = `qwen3.5:9b-q8_0`. The Clean
dialog opens on it (`seedCleanDefaults`), the settings card edits it, `llm:defaults` answers
`cleanModel` beside `model`, and `llm:set-clean-model` is the 109th handle (IPC-CHANNELS.md
refreshed here in step). Hosted, BookForge's userData IS Foundry's, so BookForge's own press
(4f190253) reads the same key out of the same file — one file, one model. Per-machine by
construction: userData never syncs. 7 files + the IPC doc, tree diff-verified, one new channel
(BookForge owns nothing on `llm:`), no dep movement.

**a279c5d (copied 2026-09-08) — the Clean text model is a LIST of three.** Owen: a dropdown, not a
text box. `CLEAN_TEXT_MODELS` (shared/pipeline.ts) — 9B 8-bit (default), 9B 16-bit, 27B — in the
Clean dialog and the Settings card; a stored tag outside the list rides at the top as itself.
3 files, tree diff-verified, no IPC change, no dep movement.
**2b1bcd1 (copied 2026-09-08) — the two ghost-row bugs Owen hit on his first press of the promised
chain.** (A) Narrate on a greyed clean refused "The step this was to be made from never landed, and
nothing in the queue is going to make it" while the clean was queued on the HOST: `chainedBehind`
composed `after` from `shelfJobs()` (host rows included) but `chainVerdict` resolved the parent from
Foundry's own `jobs` array, which never holds a host row — undefined, verdict 'unknown', the ledger
asked, the row cancelled. It now resolves from `shelfJobs()`, the same shelf, and reads only `state`,
which our rows carry. (B) Delete on a ghost hit `ledger:describe-delete` → "This ledger has no step
called <id>" — a promise is a QUEUE ROW, not a ledger step. `describe-delete` now asks
`rowMinting(shelfJobsFor(dir), stepId)` first and answers a StepDeletion with a new optional
`queued: true`, casualties = the row plus every row transitively chained behind it by `after`, no
files, no belongings; `ledger:delete` on a ghost calls `queue.remove(row.id)` (or `cancel` when it is
already running), which forward to BookForge's `remove`/`cancel` hosted, so our `queue-engine
.removeStep` cascade is what takes the promised subtree. The confirm card reads "Remove <label> from
the queue?" and names the chained rows — the labels are OUR `Job.title` (`labelFor`,
foundry-host-queue.ts: "Clean text — <file>", "Simplify — <file>", …). 4 files, 141 blobs
hash-verified, no IPC channel added (IPC-CHANNELS.md wording only), no dep movement.
**b381122 (copied 2026-09-08) — a ghost's delete calls `remove` in EVERY state, running included.**
2b1bcd1 called `cancel` for a running ghost; hosted that stops the work but leaves the rows on the
shelf as `cancelled`, where Owen's ruling is that they disappear. BookForge's `remove` needs no
special case — `queue-engine.removeStep` stops each running step in the subtree (module cancel +
abort) and then drops the rows — so `remove` is now the whole gesture. `cancel` survives as a
fallback for Foundry's STANDALONE queue, whose own `remove` splices held/queued rows only; it is
guarded on the row still being `running` afterwards, so hosted it never fires. 1 file (ipc.ts), 141
blobs hash-verified, no IPC change, no dep movement.
**ffee3b8 (copied 2026-09-08) — A RUNNING GHOST IS LOCKED; SUPERSEDES b381122's remove-in-every-state.**
Owen, 2026-09-08: *"maybe we turn it red while its running and lock it. the user has to remove it from
the queue itself. again, if it's removed as a ghost, everything under it is removed as well. that
simplifies the logic so it doesnt hit a bug where narration is trying to run on the wrong thing, or
nothing at all."* So `refuseRunningGhost(row)` throws from BOTH `ledger:describe-delete` (the confirm
card never opens) and `ledger:delete` (nothing races between the question and the press): "<label> is
running, so it cannot be removed from here. Stop it in the queue…". Nothing is removed or cancelled
from the tree, and their standalone `cancel` fallback is gone with it. A QUEUED promise is unchanged
(2b1bcd1: `queue.remove(row.id)` = our `removeStep`, subtree with it). DRAWN: `.card.locked` on a
promise whose row is running — `--warn` ink on the border and the kind chip, border solid rather than
the queued card's dashed — deliberately NOT the failure red (`.card.failed` fills with `--error-soft`),
because a card that looked failed while the work was healthy would be the worse lie. Reads `row.state`
off the rows we push, so nothing new crosses the seam. 2 files, 141 blobs hash-verified, no IPC change,
no dep movement.
**ca0bf1c (copied 2026-09-08) — a press that throws says so.** Owen pressed Narrate on a RUNNING
ghost and NOTHING happened: no notice in the Foundry window, no terminal line, no queue row, no
implied-export directory. The whole act press is now wrapped, so anything it throws reaches the
notice strip as "“Narrate” could not be started: <message>" and the console. WHY IT WAS
INVISIBLE IS OURS, not theirs: every refusal `invokeFoundryNarrate` raises goes out through
`sayToUser` (main.ts), which broadcasts `jobs:notice` — a channel only BOOKFORGE's renderer listens
on; the Foundry window is not subscribed to it and cannot be, so a host refusal for an act pressed
in THAT window lands in a strip nobody was looking at, and nothing logs it. The door does re-throw,
so with this wrap the message now surfaces where the press was made. 1 file, 141 blobs
hash-verified, no IPC change, no dep movement.
**5ee8be6 (copied 2026-09-08) — the hosted shelf draws Foundry's OWN live rows, and its ✕ reaches
them.** Fallout from the implied-export hunt: an export the host orders NEVER routes to our queue
(`exportEpubFromStep` ends in `queue.enqueueHere`, by the seam's oldest rule), so a DEFERRED one
waits on Foundry's internal list for as long as the text pass it is chained behind takes — and
hosted `shelfJobs()` used to show only our rows plus their never-routed kinds, which made that wait
invisible and uncancellable. It now includes every LIVE row of theirs (settled ones still leave at
the settle), and `cancel`/`remove` route on WHOSE list the id is in rather than on the row's kind —
which also closes a latent one, a ✕ on one of their rows forwarding to us with an id we have never
seen. The implied export's row is titled "Book for narration — <file>" to read as the same act our
landing row names. Owen's ruling that an implied EPUB is invisible is about FILES and VERSIONS, not
about a running job he cannot see or stop. 141 blobs hash-verified, no IPC change, no dep movement.

**4d62293 (copied 2026-09-08) — `CleanRequest.concurrency` / `keepModel`, `argsFor` exported.** Additive,
for BookForge's headless Clean text door (`cli/clean-step.js`, `--clean`): the app's clean argv passes
`--concurrency <n>` when set and `--keep-model` only when asked; `argsFor` is exported so a dry run prints
the spawn without making it. 3 files, tree diff-verified, no IPC change, no dep movement.
**74f933c (copied 2026-09-08) — a host’s push WAKES the scheduler.** The other half of what Owen
watched: *“the epub generation step is supposed to be rapid. it happens in seconds. but its sitting
in the cpu slot doing nothing for two minutes now”*. `setHostQueueRows` called `changed()` and never
`pump()`, so when a host row went running → done and this side pushed the new list, Foundry’s mirror
updated and its SCHEDULER never looked — a deferred export sat `queued` behind a row that had already
finished, indefinitely, and only another press in the window could free it. It now pumps when the
pushed rows hold anything queued (guarded: a push arrives on every progress tick and the reconcile
reads a manifest per row it cannot decide from memory), and `hostQueueDrained` does the same for the
sharper case. BookForge’s half of that same screenshot was its own bug, fixed in 2ca0222b: a step
whose whole job is waiting no longer holds one of two CPU slots (`StepResource` gains `wait`). The
two were compounding — a waiting narration was starving the very export it waited for. 141 blobs
hash-verified, no IPC change, no dep movement.
**8969762 + 98acf5a (copied 2026-09-08).** `8969762`: the ALIGNED pair lights its own diff — the
real answer to Owen’s “cleanup didn’t highlight anything”, which was the aligned view rather than
the compare column. Wave 57 passed an empty map to the aligned source sheet on the reasoning that it
is “a third book”: true of the compare column, false of the aligned pair, which is one pass’s own two
sides matched by block id inside one component. Removals now draw on the source sheet, additions on
the bench.

`98acf5a` is **Owen’s spine ruling**: *“for translate, we need it to translate the epub spine … for
translate, it will. simplify/cleanup, no.”* `clean-text` no longer sends chapter titles at all;
`translate` skips them when the run carries a rewrite mode. NO version constant moved — this changes
which targets are ASKED, not the transform — so nothing re-stales and no cleaned book needs redoing.
A text-pass card also offers **Compare**, standing on the pass and opening its parent beside it with
the changes lit, so the picker no longer has to be aimed by hand.

**THE NARRATION CONSEQUENCE, which is BookForge’s to weigh:** a spine title asked about on its own is
now pinned to what the book printed, so anything that reads a chapter title aloud gets the printed
form — “4. 2110: Silo 1” rather than words. A title that is a provable COPY of a heading is still
derived from that heading and therefore still moves when a cleanup cleans the heading; only the
standalone spine is pinned. 141 blobs hash-verified, no IPC change, no dep movement.
**13b98a3 (copied 2026-09-08) — Owen’s two adjustments after the aligned highlight worked.** The
two aligned columns were each `width: 100%` of half the pane with a 38rem sheet centred inside, so
the leftover gray fell BETWEEN the sheets as well as outside them; each column now takes a basis
just over its own sheet and the pair centres as one group, the rule the original panel already had.
And a **“Quote fixes” checkbox, off by default**: a narration pass curls every quote in a book, so
hundreds of true edits were drowning the two or three worth scanning for. Unchecked, the diff is
taken over strings with typographer’s quotes folded to typist’s (`foldQuotes`, `shared/word-diff.ts`,
exported and pure) — one character for one, so a range measured in the folded text lights the same
characters of the written text. THE TEXT IS UNTOUCHED EITHER WAY: both sheets draw the quotes they
actually hold and only the highlight moves. Guillemets are deliberately NOT folded, because a
translation turning `"` into `«` HAS changed the page, and that is the thing somebody comparing a
translation is looking for. 141 blobs hash-verified, no IPC change, no dep movement.
**79a3c3a (copied 2026-09-08) — one act, one card.** Owen, with Shift rendering and the GPU slot
free: *“i went to julius streicher by bytwerk and added cleaning to the queue and it immediately
started it without me hitting a button … but foundry added a second cleaning step to the step
list, so i had two that were listed and said ‘running’ simultaneously.”* The immediate start
was right (the queue was moving, the slot was empty). The pair was the PROMISE and the REAL STEP:
`admitPending` decided “this promise has happened, stop drawing it” from the ROW’S state, and
`PENDING_IN` excludes `done` — but a text pass lands its step in the ledger at the settle, while the
row that minted it does not read `done` in Foundry’s mirror until the scheduler settles it and,
hosted, until BookForge’s NEXT push carries the new state. In that window the ledger held the step
and the row still said running, so the tree drew both cards. It now asks the LEDGER: a candidate
whose `mints` is already a step is never drawn (it stays a legal parent for anything chained under
it, so chains are untouched), and the two delete doors took the same guard — otherwise, inside the
window, deleting a REAL step was refused as “that promise is running”. The window is as wide as
the gap between the engine settling and the next `setHostQueueRows`; nothing changes on this side.
Two files (`electron/ipc.ts`, `shared/pending.ts`); 141 blobs hash-verified, no IPC change, no dep
movement.
**19f5e70 (copied 2026-09-08) — the three text acts speak vLLM.** Owen: *“lets build in vllm
batching. ollama batching doesnt work. its an unfinished feature ollama tried to implement but isnt
accessible on the mac or pc. cuda graphs/vllm would probably be the best for all three features.”*
Measured first: Ollama 0.33.3 refuses to decode the qwen35 architecture in parallel on llama.cpp, so
the four-in-flight pools bought nothing. The ENGINE half (`--server ollama|vllm` on `translate`,
simplify and `clean-text`; `/v1/models` proof; `/v1/chat/completions` with byte-identical prompts;
`chat_template_kwargs.enable_thinking=false` plus a defensive leading-`<think>` strip; `--model`
optional under vLLM and the SERVED id recorded in bank key, records key and stamp; `--concurrency`
default 12; `release()` a declared no-op; no stampVersion bump and NO precision field — a server
cannot report its dtype, so the served name must be honest, `Qwen3.5-9B-bf16` on this PC) reaches
BookForge as `dist/foundry-windows-x64.exe`, not through this subtree. The APP half is what this
copy carries: Settings → Language model gains a Server select, a vLLM URL and a served-model
field, kept beside the Ollama ones so switching back costs no retyping; `llm:defaults` answers
`server` and resolves model/URL for the chosen kind; TWO NEW CHANNELS `llm:servers` /
`llm:set-servers` (count 111); `TranslateRequest.server` / `CleanRequest.server` ride on the
request; the queue writes `--server vllm` and OMITS `--model` when the field is blank. app-settings
keys: `llmServer`, `vllmUrl`, `vllmModel` (empty = “whatever it is serving”). Consequence for
Owen: the model name is part of the records/bank key, so a book cleaned through
`qwen3.5:9b-q8_0` re-asks every block through vLLM — two precisions are two answers; pick one
server per machine. BookForge’s half (weights, WSL launcher on 8300, the arbiter that starts the
server before a text pass and stops it after, and its own bare-EPUB Clean text door learning the
flag) is BookForge’s. 141 blobs hash-verified with `git hash-object`; IPC-CHANNELS.md refreshed
byte-identical to `19f5e70:docs/`; no dep movement.

**eb69b7a / 5c53cb7 (copied 2026-09-08, Mac) — analyze joins the vLLM side; its closed question learns the
second dialect.** App half of eb69b7a (job-queue.ts, shared/types.ts, analysis-dialog); 5c53cb7 is docs-only
on the engine side. Tree diff-verified against foundry/app, no IPC change beyond what 34cd9258 recorded, no
dep movement.

**2b44cc7 (copied 2026-09-08, Mac) — the Clean text picker's 16-bit entry is the MLX tag on Apple Silicon.**
`cleanTextModelsFor(mlx)`; preload exposes `arch` beside `platform` (a preload field, not a channel —
IPC-CHANNELS unchanged). Measured 32 vs 61 blocks/min, llama.cpp vs MLX runner, same weights. Tree
diff-verified, no dep movement.
**03ff788 / 37eb95b / a9ee9e3 (copied 2026-09-11, Mac) — the hosted shelf draws ONE card per job, and the
dock's host act aims where the tree's card aims.** 03ff788: a dropped PDF can be the pages of a book
(`core/pdf-pages.service.ts`, capture/intake changes). 37eb95b: `runJob` marks the local twin it mints for
HOST-scheduled work (`hostScheduled`, a WeakSet at the mint) and `shelfJobs()` hosted no longer draws it beside
the host's own row — Owen's double "Cleaned for narration" card, which appeared the moment BookForge's pump
ran the row. a9ee9e3: `runHostAct` (the dock) resolves its target through `hostActAimFrom` (shared/stages.ts):
a PROMISE being stood on wins ahead of the finished-export fork (which would have narrated an OLD export),
an EPUB import row names itself (the scan refusal stays), and the press is wrapped so a throw becomes a
notice — Owen's "the narrate tile didnt work, but the narrate button on the card did". Tests added:
`test/hosted-shelf.test.ts`, `test/host-act-aim.test.ts`. Tree diff-verified against foundry/app at
a9ee9e3 (only .DS_Store and this folder's two notes differ); the `Job` wire shape is unchanged, so
BookForge's re-declaration in electron/foundry-host-queue.ts needed no edit; no dep movement
(package.json / package-lock.json byte-identical to 2b44cc7). IPC-CHANNELS.md refreshed from
`a9ee9e3:docs/` (+19 lines, the channels 03ff788's page intake added).
**3b13392 (copied 2026-09-11, Mac) — the pump picks a row once.** Since 688c888 (2026-09-07) `runInSlot`
awaited `materializeDeferred` BEFORE anything marked the row running, and `nextStartable` never consulted
`slots`, so a two-lane CPU row (every export) was re-picked on every turn of the synchronous `for (;;)`
pump — one `runInSlot` promise per turn until the host's V8 heap hit its 8 GB cap. That is what killed
BookForge twice on 2026-09-11: at 12:21 when the Tender cleanup landed and its chained export became
startable, and at 12:31 the moment Owen pressed Narrate (which orders an export). Both crash reports:
`node::OnFatalError` out of GC = JS heap out of memory. Fixed: the picker skips a row that already holds a
slot, and a start marks the row running synchronously before its first await. Test:
`test/cpu-lane-pump.test.ts`. Behavioural note for this side's mirror: a deferred row now reads `running`
while its request is being materialised, where it read `queued` until the engine spawned. Tree
diff-verified against foundry/app at 3b13392; no dep movement; IPC-CHANNELS.md unchanged.

**83d7b66 (copied 2026-09-13) — ONE INFERENCE DOOR. The engine's second dialect is gone, the
act says its own name, and a pass never loads a model.** Owen's ruling, in his words:
*"everything compute intensive must go through crucible. if theres no crucible server, theres no
foundry. it's a necessary service… we should adapt it to using the models through crucible
instead."* The whole of it is Foundry's `646e8a1` (tag `engine-one-door`); `83d7b66` is the 1.3.0
version bump on top, and `git diff 646e8a1 83d7b66` is **two root files** — `package.json` and
`package-lock.json` — with `app/` byte-identical at both, verified here rather than taken. The copy
names the RELEASE commit because that is what the released binary reports and what this repo's
`test-foundry-clean-text-vendor` keeper therefore asks about.

**The app half of the rework is TWO FILES and it is all this subtree carries.** `646e8a1` touches 25
files; 23 of them are `src/`, `test/` and `docs/`, outside `app/`. What arrived here:

- `electron/engine.ts` — `parseProgressLine` accepts **`simplify: block n/m`** beside
  `translate: block n/m`. Owen: *"they can't lie to the user and say a translate job is running when
  it's actually a simplify job."* The engine now prefixes every line of a `--rewrite` run with the
  act it is actually running (`src/translate/act.ts`, new). The `phase` token stays `translate`
  deliberately — it names the SHAPE of the progress (blocks of a text act) and the row's own kind
  names the act.
- `electron/job-queue.ts` — `modelArgs` no longer composes `--server vllm`, and the analyze and
  translate lines spell **`--endpoint`** where they spelled `--ollama`. The request FIELD is still
  called `ollama` on the app side and is renamed with Foundry's picker rework, so a reader of
  `'--endpoint', request.ollama` is looking at a rename in flight rather than a mistake.

**ONE THING THE HANDOFF NOTE DID NOT SAY, found by grepping the copy rather than reading the
message: `electron/job-queue.ts:2683` STILL SPELLS `--keep-model`.** `if (request.keepModel ===
true) args.push('--keep-model')`, on the clean-text line, with a docblock above it describing a
release semantics the engine no longer has. The flag was retired from the engine by this very
commit and is now refused by name (`foundry: unknown option --keep-model`), so any `CleanRequest`
crossing the seam with `keepModel: true` produces a run that dies at argument parsing. It is
UNREACHABLE today — `CleanRequest.keepModel` (shared/types.ts:1023) is Foundry's `4d62293`, added
for BookForge's headless door, and nothing in the vendored app sets it; BookForge's own clean-text
CLI does not go through `job-queue.ts`. So it is dead code and not a live defect, and per the
SEALED SUBTREE rule it is NOT fixed here. Reported to the Foundry side; the fix is theirs, in the
same commit that renames the `ollama` field.

**What the engine now refuses, which is why BookForge's own spawn lines moved in the commit after
this one.** `--server`, `--ollama` and `--keep-model` are gone from `translate`, `simplify`,
`clean-text` and `analyze`; `--endpoint <url>` replaces them on every text act and, absent, the
engine reads `backend.endpointUrl` from its own settings — the READING door's setting, because it
is the same server. `--model` absent is the served model, always, and the listing's `id` is what
the bank key, the records key and the stamp carry. The engine never loads and never unloads: a
server holding a different model refuses by name, and `release()` on the clean runner is a stated
no-op whose member survives only because `NumberNormalizerRunner` is the vendored interface.
`clean-text` measures its longest request against `max_model_len` (`fitsWindow`) before request one
instead of sending a 128-token cap no edit list fits and counting the truncation as a parse
failure. `--concurrency` defaults to 12 (`DEFAULT_TEXT_CONCURRENCY`); the vendored driver's own
`DEFAULT_CLEAN_CONCURRENCY` (4) is not read by the engine and was deliberately left alone so this
repo's sha pin would hold. `chat_template_kwargs: {enable_thinking: false}` is still on the wire.

**The text pass itself did not move, and that is now ASSERTED rather than believed.**
`tools/test-foundry-clean-text-vendor.js` gains a TIER 3: the three `tts-*` leaves are checked
byte-identical between `969dd96` (the last commit that touched the pass's rules) and whatever
commit the binary reports. Tier 1 asks about the handover and tier 2 asks whether bytes equal a
pin — neither can check the claim a 1,296-insertion/1,802-deletion rework makes when it says it
left three files alone. Over the whole `cd89ee7..83d7b66` range, twelve of the thirteen mapped
files have an EMPTY log and no pin was regenerated; the thirteenth is `tts-spoken-forms.ts`, moved
by `7fbe763` (covid) and `969dd96` (wwi/wwii), both conformance fixes to this side's
`caps_acronyms.json`, both caught by the VALUE check that exists for exactly them.

Verification: **145/145 blobs** hash-verified against `83d7b66:app/` with `git hash-object` vs
`git rev-parse` (index shas both sides, so `autocrlf` cannot lie), and the only files in the
subtree that are not in `app/` are this note and `IPC-CHANNELS.md`. `IPC-CHANNELS.md` refreshed
from `83d7b66:docs/` and **byte-identical to the copy already here** — no channel moved, and the
collision keeper is 6/6 against it. `package.json`, `package-lock.json`, `angular.json` and all
three `tsconfig*.json` are unmoved from `3b13392`, so the existing `node_modules` stands and no
install was run (per the `npm ci`-not-`npm install` rule above, which only fires when the refresh
moves a dep file). `npm run build` clean, ng 957.01 kB with the standing budget WARNING only; all
foundry keepers green.

**THE MANAGED ENGINE DOES NOT MATCH THIS COPY YET, and for once the gap is one release away rather
than one hand-copy.** Foundry v1.3.0 is committed and its release tarballs are built, but
`gh release create` is deliberately left for Owen — so `api.github.com/.../releases/latest` still
answers **v1.2.0**, whose engine still speaks `--server`. `electron/foundry-cli-components.ts`
pins nothing and installs the newest release, which is the right behaviour and is NOT changed here.
The dev checkout's `dist/foundry-windows-x64.exe` already answers `foundry 1.3.0 (83d7b66)`, so a
dev run matches; a managed install does not until the release is cut. Tracked as a Tier 3 line in
`docs/CRUCIBLE_ROLLOUT_PLAN.md`.

**81fdc30 (copied 2026-09-13) — the residue the last entry reported is gone, and it took
the field with it.** The previous refresh recorded, as a thing found by grepping the copy
rather than by reading the handoff note, that `electron/job-queue.ts:2683` still carried
`if (request.keepModel === true) args.push('--keep-model')` after `646e8a1` had retired
the flag from the engine. Foundry's fix is the whole of this delta: the push is deleted
and so is `CleanRequest.keepModel` (`shared/types.ts`), which is the better half of it —
a field left standing is a door onto a flag that no longer exists, and the next caller to
find it would have written a command line that dies at the engine's argument parser
before a block is read.

**The engine did NOT move and this copy does not ask it to.** `git diff --stat 83d7b66
81fdc30` is exactly two files, both under `app/`; `git log 83d7b66..81fdc30 -- src` is
empty. The 1.3.0 binaries stand, the managed-component gap recorded in the last entry is
unchanged (still v1.2.0 on GitHub until Owen cuts the release), and nothing about
`foundry-cli-components.ts` needed to move.

**BookForge's side dropped a keeper rather than gaining one.** `tools/test-clean-step-door.js`
had pinned the defect as a HAZARD — a test asserting the bad line was still there, whose
failure message said "Foundry fixed it, delete me". That message has now been earned, so
the pin is gone: a pin that can never fire again is noise pretending to be a guard. What
stands in its place is the question the pin was standing in for, asked of the SOURCE
rather than of one composed line — **no retired flag (`--keep-model`, `--server`,
`--ollama`) appears as a quoted string literal anywhere in `electron/job-queue.ts` or
`shared/types.ts`**, so the next refresh that brings one back on ANY command's line fails
by name. Quote characters are `'` and `"` only and the reason is written at the regex:
both files are full of backticked prose ABOUT the retirement, and an earlier draft that
matched markdown failed on eight comments explaining the fix.

Left standing and deliberately not failed on: `server?: LlmServerKind` survives on three
request types (`shared/types.ts` 787/1001/1160). It is inert on every argv — `modelArgs`
stopped reading it at `646e8a1` — and Foundry's note says it is still read by their
settings screen to pick WHICH URL to hand over, retiring with the picker rework. That is
a different case from `keepModel`, which `argsFor` was actually WRITING; the keeper
above tests what reaches a command line, which is the thing that can break a run.

Verification: **145/145 blobs** hash-verified against `81fdc30:app/` with `git hash-object`
vs `git rev-parse`, and the only files in the subtree that are not in `app/` are this note
and `IPC-CHANNELS.md`. `IPC-CHANNELS.md` byte-identical to `81fdc30:docs/` and to the copy
already here — no channel moved, collision keeper 6/6. `package.json`, `package-lock.json`,
`angular.json` and all three `tsconfig*.json` unmoved from `83d7b66`, so the existing
`node_modules` stands and no install was run; `node_modules` confirmed a real directory
(`LinkType` empty) before anything was removed, per the worktree-hygiene rule. `npm run
build` clean, ng 957.01 kB with the standing budget WARNING only; `npx tsc -p
tsconfig.electron.json` clean; all foundry keepers green.

**e6d5424 (copied 2026-09-14) — SLOTS, and the first refresh that ever forced a
BookForge channel to change its name.** Twenty-one commits, five of Foundry's
"packages" (C, D, E and both halves of F), 59 files. Foundry
now has a Crucible registry of its own, a per-row slot picker, a dispatch that
reads capability and LEASES a model, an `acts:gates` surface, a model inventory,
a setup-wizard Crucible step, and a local page reader that is llama-server plus a
dots.ocr GGUF — `electron/vllm-server.ts` (527 lines) and `electron/wsl.ts` (413)
are DELETED, `electron/machine-models.ts` (367) and `electron/page-reader.ts`
(1,602) are new. Their plans of record are `docs/SLOTS.md` §§6–7, `docs/SETUP.md`
§5/§5b and the regenerated `docs/IPC-CHANNELS.md`.

**WHAT MATTERS TO THIS SIDE IS SMALL, AND THAT IS THE POINT.** `FoundryHost`
gained ONE optional member, `slots?(): readonly ComputeSlot[]`, and BookForge
registers nothing — so every job takes exactly the path it took yesterday: no
picker, no placement, no capability read, no lease. `Job` grew two optional
fields (`waitFor`, `ranOn`); absent is what a host offering no slots produces, so
`electron/foundry-host-queue.ts`'s re-declaration needed no edit and got none.
The mount seam is otherwise unmoved — thirteen exports, all rebuilt and present.
`llm:servers` / `llm:set-servers` were REMOVED and `server?: LlmServerKind` went
with them; grepped here rather than taken on their note — BookForge has never
spelled any of the three, so the removal costs this side nothing. Package F's app
half (`ebb55a8`) adds cloud providers as SLOTS — one slot per enabled provider,
appended after every Crucible slot and never taken by `any`, text acts only,
spawned with that provider's auth header and no `X-Crucible-*` — with a new
`cloud:` family (`cloud:settings`, `cloud:save`, `cloud:test`; both write doors
refuse when hosted) and `Job.usage {requests, tokensIn, tokensOut}` riding
`queue:list` / `queue:changed`. Hosted, a window takes its slots from the host,
so BookForge offering none means the vendored app draws none — the feature
arrives inert on this side, exactly like the Crucible registry above it.

**AND `--server` CAME BACK FROM THE DEAD, WHICH MADE ONE OF OUR KEEPERS WRONG.**
The engine half of package F is two commits: `527b0db` reopened the Ollama door
beside the OpenAI one and `76444fb` added Anthropic as a third DECLARED dialect.
So `--server` — retired by `646e8a1` only two vendors ago, and guarded ever since
by `tools/test-clean-step-door.js`'s "no retired flag appears as a quoted string
literal" grep — is a live flag again on every text act, and the vendored
`argsFor` composes `['--server','ollama']` / `['--server','anthropic']`
correctly. The keeper went red on exactly that, and the honest answer was NOT a
cleverer regex: the flag is not retired, so it left the list. What it means has
changed though, and that is why this took a read rather than a delete — the
retired `--server` picked between "which KIND of server does this machine talk
to" (`vllm` vs `ollama`) and died when the answer became "one door, always"; the
returned `--server` names a WIRE DIALECT, three request shapes behind one act,
declared and never sniffed. `--keep-model` and `--ollama` STAY retired, verified
in the engine's `src/` at this sha rather than assumed (both appear only in prose
explaining their own removal). In place of the deleted assertions,
`assertDeclaredDialect` asks the thing that was actually being protected: a
`--server` on a line this side composes must carry one of the three declared
values, never nothing, and never `vllm`.

**THE COLLISION FINALLY HAPPENED, and OUR name is the one that moved.** Foundry's
package C and E added `crucible:test` and `crucible:add`; BookForge minted its
own Crucible Servers row the same night, with sixteen `crucible:` channels
including those two exact names. Two `ipcMain.handle` registrations of one name
in one Electron main process THROW at registration, so BookForge would not have
started with the Foundry window mounted — a boot failure, not a matter of style.
Per the SEALED SUBTREE rule above, ours renamed:
**`crucible:add` → `crucible:add-server`** and
**`crucible:test` → `crucible:test-server`**, in `electron/main.ts` and
`electron/preload.ts` and nowhere else, because the renderer only ever spells the
preload's METHOD name (`crucible.add`, `crucible.test`) and those did not move —
grep of `dist/renderer` for any `crucible:` channel string returns nothing, which
is the proof rather than the hope. Near-misses deliberately left alone: their
`crucible:test-at` (probe an unsaved address) is the twin of our
`crucible:test-address` and collides with nothing; their `crucible:add-local`,
`crucible:install`, `crucible:install-plan`, `crucible:settings`,
`crucible:save`, `crucible:set-wsl-distro` and `crucible:set-new-jobs-wait-for`
are theirs alone; their `models:changed`, `models:inventory`,
`models:remove-page-reader`, `acts:gates`, `slots:list`, `slots:rows-waiting-for`,
`queue:set-wait-for` and package F's whole `cloud:` family (`cloud:settings`,
`cloud:save`, `cloud:test`) hit nothing of ours. The collision keeper is the
record: 6/6 green, reading Foundry's names out of the vendored
`IPC-CHANNELS.md`'s TABLE ROWS and ours out of BookForge's TypeScript sources.

**Their doc's own header had drifted, and our keeper never read it — now it says
so.** `IPC-CHANNELS.md` claimed **119** handlers while their tree held **127**,
eight doors added under a stale figure; `e6d5424` records the real number. Ours
was never exposed to that (it parses rows, and `MIN_FOUNDRY_CHANNELS = 60` is a
no-op floor, not a count), but its docblock quoted a stale "62 handles + 11
pushes" of its own. Replaced with a MEASUREMENT taken here over the vendored
source and the vendored doc — **130 `ipcMain.handle` call sites, 130 distinct
names, zero `ipcMain.on`, zero handles absent from the doc, 148 table rows
(130 handles + 18 pushes)** — plus the reason the floor is deliberately left far
below it: raising it to the current count would make our file the fourth
hand-maintained number in this story.

**`app/package.json` GREW A DEPENDENCY THAT CANNOT MEAN HERE WHAT IT MEANS
THERE, and it is a junction landmine.** The refresh adds two deps: `@crucible/client`
pinned to the v0.5.0 release tarball (genuinely imported — `electron/crucible-dispatch.ts`
and `electron/crucible-registry.ts`), and **`"foundry": "file:.."`**, Foundry's
self-link back to its own repo root. Inside `<foundry>/app` that resolves to
`foundry@1.3.0`. Inside `<bookforge>/foundry-app` it resolves to
**`bookforge-app@0.1.7` — this repository's root** — and `npm ci` duly created
`foundry-app/node_modules/foundry` as a **JUNCTION to `C:\Users\tellt\Projects\bookforge\`**,
verified by `(Get-Item …).LinkType` before it was removed. That is a loaded gun
next to the standing worktree-hygiene rule: any later `rm -rf
foundry-app/node_modules` would follow it and delete the entire checkout. So the
install was done as `npm ci --ignore-scripts` (our root carries a `postinstall`
that rebuilds native modules, and a linked target's lifecycle is not a thing to
gamble on), the junction was then removed **non-recursively** via
`(Get-Item …).Delete()`, and the repo was confirmed intact afterwards (root
`package.json` present, root `node_modules` 769 entries). Nothing imports the
`foundry` package — grepped, zero hits in `electron/`, `shared/`, `src/`,
`test/`, `tools/` — so removing the link costs the build nothing, and `npm run
build` is clean without it. **This is a defect in the vendored copy and the
sealed-subtree rule says it is not fixed here; it is reported to the Foundry side.**
`// RULING OWED:` whether the self-link should be a `devDependency` they drop for
the app snapshot, or whether this side should keep deleting the junction on every
refresh. Until it is answered, THE STEP IS MANDATORY: after `npm ci` in this
subtree, delete `node_modules/foundry` non-recursively before anything else runs.

**THE KEEPER'S TIER-2 PIN WAS REGENERATED, AND THE DECISION IS THE WEAKEST PORT
THERE IS.** The shipped anchor moved `83d7b66 → e6d5424`. All thirteen mapped
files were read over that range, one path at a time; twelve have an EMPTY log.
The thirteenth is `src/clean/tts-number-normalizer.ts`, moved by exactly one
commit (`76444fb`), and its entire diff is one word inside a docblock — *"shared
by both doors unchanged"* became *"shared by every door unchanged"*, because
Anthropic made the door count three. `both doors` and `every door` are the same
nine characters, so the file is 122,131 bytes on each side and only the sha256
moved. **PORT, not a rule move**: not one byte outside a comment, no rule table,
no validator, no prompt, no constant — `NORMALIZER_VERSION` was right to stay at
`n6`, no corpus re-vendors and no cached record re-keys. Pin regenerated to
`f478c8a9…` with that reason written beside it. `ONE_DOOR_BASELINE` moved with it,
`969dd96 → 76444fb`, on the baseline's own stated rule ("it moves the next time
Foundry legitimately changes one of these") — not to clear a red keeper: the
alternative was whitelisting one file inside a freeze, which is how this keeper's
fixed anchor went wrong in the first place. No tier was loosened; tier 3 reads
3/3 frozen.

Verification: **158/158 blobs** hash-verified against `e6d5424:app/` with
`git hash-object` vs `git rev-parse` (index shas both sides, so `autocrlf` cannot
lie), and the only files in the subtree that are not in `app/` are this note and
`IPC-CHANNELS.md`. `IPC-CHANNELS.md` refreshed from `e6d5424:docs/` and
byte-identical to it. IPC census re-counted HERE from the vendored source rather
than taken from their header: **130 `ipcMain.handle` call sites, 130 distinct
names, zero duplicate registrations, zero `ipcMain.on`, and zero handles absent
from `IPC-CHANNELS.md`** — so their doc is an authority again at this sha, not a
formality. Deps MOVED this time (`@crucible/client` at the v0.5.0 tarball, and
the `file:..` self-link above), so `npm ci` ran, with the junction deleted after
it and `npm rebuild electron` run to restore the install scripts
`--ignore-scripts` had skipped — without that last step the subtree's compiled
`app-settings.js` throws *"Electron failed to install correctly"* and takes
`tools/test-clean-step-door.js` down with it, which is how the omission was
found. `node_modules` confirmed a real directory (`LinkType` empty) beforehand,
per the worktree-hygiene rule. `npm run build` clean in the subtree, ng **993.49
kB** (957.01 → 993.49, the standing budget WARNING only); `npx tsc -p
tsconfig.electron.json` and `npx ng build` clean on BookForge's side; collision
keeper 6/6, all twelve `test-foundry-*` keepers green, `test-cli-flags` 24/24
from PowerShell, `test-clean-step-door` green after the `--server` ruling above.

---

**1ce539a (copied 2026-09-15) — THE HOSTED TEXT ACT, which is what this whole
refresh is for.**

Owen, 2026-09-15: *"local text acts shouldnt work. text acts from foundry
through crucible should work, though. lets fix it so crucible can process text
acts for foundry, vendored or host, and it uses the same logic bookforge did
before we built crucible"* — and, clarifying the last clause, *"i.e. vllm."*

Until this copy a hosted `clean`, `translate` or `simplify` could not run at
all. BookForge refused it by name (`hosted_placement_not_vendored`) because the
seam it calls, `runJob(request, {parentStep, signal, onProgress})`, carries no
environment, and the vendored dispatcher resolved credentials from a registry
that is always empty hosted — so the act could be composed neither here nor
there. With the legacy local text engines deleted the same week, that meant
translate and simplify did not run as queue rows and neither did clean through
that door.

**`e096734` is what closes it** — *"hosted, the servers are the host's: one
registry, one derivation, and a placement that can always find its
credentials"*. `crucibleServers()` asks `FoundryHost.servers()` when it is
hosted, `computeSlots()` derives the slot list from that one registry, and
`placeOnCrucible` then does the whole act itself: `GET /v1/capability` for the
model, `GET /v1/models` and a `load-model` job for residency, the model lease
with its heartbeat, the header map carrying `X-Crucible-Act`, the OpenAI base,
and `runEngine(args, watch, placement.env)`.

**Why `1ce539a`.** Owen: *"the latest — so we can vendor a fully functional and
up to date version in."* `e096734` alone is not enough: the placement also needs
`RunOptions.waitFor` to cross `runJob`, or the machine a person chose on
BookForge's queue row is answered by that window's own `newJobsWaitFor` setting.
So the minimum correct target was `990bd2e`, and `ecd03e3` the first route-aware
one. `1ce539a` is main's tip and carries all of that plus the two things Owen's
sentence was actually waiting on — **`engineOf` adopted** and **the standing
refusal** — along with the settings window, the pairing/connect doors,
coordinate-on-connect and the uninstall door.

**`engineOf` is adopted: an orchestrator is not an engine.** One resolver,
`resolveEngine(entry)`: `info()` once, the SDK's `engineOf` for the rule (never
re-derived, or the two apps start disagreeing about which of two processes on a
machine does the work), and for an orchestrator a client at `engine.url` with
the SAME token — after reading THAT document and refusing
`orchestrator_engine_is_not_an_engine` if its role is anything but engine, so
*once, never a chain* is enforced rather than assumed. Cached on name+url and
**never on the token**, 60 s, in-flight deduped, forgotten on a registry change
BEFORE the capability cache because capability now reads through a hop. Every
engine caller goes through it, `placeOnCrucible` included — resolved once, so
the request and the spawn cannot end at two different processes.

This matters to BookForge more than to Foundry, because hosted it is OUR entry
being resolved: if a person registers the tray rather than the engine, every
hosted text act depends on that hop. `tools/test-foundry-hosted-crucible-seam.js`
drives the vendored resolver for real over a stubbed `fetch`, with rows of our
own shape — engine, orchestrator, chain, no-engine, and a rotated token —
because the hosted case is the one thing Foundry's own fifteen checks could not
exercise. It also pins that no refusal sentence carries the bearer token, since
ours are real and land in queue rows.

**One deliberate exception, mirrored rather than contradicted:** `crucible:open`
and `adoptPairingFile` do NOT follow the hop. A placement asks a machine to
*work* and only an engine can; a console is a person going to look at the
process they named, and after Phase 17 the orchestrator's console is the one
carrying install, restart and quit. BookForge grows no console or pairing door
on this seam, and the keeper pins that too.

**What it does NOT carry, and why that is fine.** Foundry's package L — the
PHASE15 §5.3 deletions: `cloud-providers.ts`, the cloud card, the
`ComputeSlotKind = 'cloud'` placement — has not landed; their L is gated on a
`llama-windows` server on a clean box. `docs/CRUCIBLE_ROLLOUT_PLAN.md` names
"their sha AFTER L" as *the single re-vendor* target, and that bundling is not
reachable yet, so this copy is deliberately the earlier of the two. The SECOND
tripwire in `tools/test-foundry-hosted-crucible-seam.js` is untouched and still
does its job: it passes while the vendored copy keeps its cloud layer and goes
red the day it does not.

Three cautions come with the tip and **Owen has accepted all three**, so they are
recorded rather than treated as blockers: `CRUCIBLE_READS` is true (a hosted
`read` can be placed on a Crucible, which this seam does not change — it sends
`waitFor: null` for a read, so their own default decides); the old cloud card
sits beside the engine settings card until a later package; and the engine
settings card is not hosted-gated.

**What BookForge changed to meet it.** `hostedCrucibleTextActNotVendored` and
the `hosted_placement_not_vendored` code are deleted, and so is the `none`
member of `EndpointHeaderReach` — a caller that makes no spawn now has no value
it could pass, which states the rule more strongly than the refusal did.
`FoundryRunJobOptions` grew `waitFor: string | null`, required, with `null`
meaning *this kind does not travel* (a read and a render) and the mount
translating that into an absent key, because their `placedBy` reads a literal
`null` as a pinned slot named null. `electron/queue-steps/foundry-job.ts`
composes nothing: no engine, no model, no endpoint, no lease, and the request
crosses verbatim. The one thing it still checks is the NAME, against the same
snapshot this app hands the window — their `slotNamed` matches
case-sensitively and exactly, and a name that misses is a `wait` a detached
`runJob` retries for ever, so it is refused here instead
(`hostedCrucibleServerNotOffered`).

**That check is narrower than it was, and the narrowing is Foundry's fix.** When
this seam was written EVERY hosted wait parked for ever. Foundry agreed the
defect was theirs and split the wait arm at this sha: `standing` is required at
all sixteen sites, through explicit constructors rather than an optional flag,
so *"nobody thought about it"* and *"this is transient"* cannot be the same
value — and a PINNED slot answering with a standing wait now REFUSES, carrying
the server's own reason and where to fix it. Standing: a disabled or empty
capability row, `upstream_unconfigured`, both orchestrator refusals, a cloud slot
stepped past by `any`. Transient and untouched: busy, engine in use, model
leased, model not resident, unreachable, capability undecided, network refusals,
a cancelled load, a slot switched off. A slot MISSING from the list stays
transient by their deliberate choice — right for a row sitting in their pump,
fatal for a detached `runJob`, which keeps no place — so BookForge's preflight
covers that one case and nothing else.

**A second effect, worth stating because it is invisible when it is wrong.** A
Crucible placement declares `door: 'openai'`, and the engine's pool default is
12 there against 4 on the Ollama door (Owen, 2026-09-08: *"lets build in vllm
batching. ollama batching doesnt work"*). Before this copy every hosted act
fell through `placeJob` UNPLACED to the Ollama door, so placing them is also
what gives them the wide pool vLLM has something to batch. Pinned in the seam
keeper rather than assumed.

**The install, DONE this time and in this order.** The subtree's
`@crucible/client` moved from the v0.5.0 release tarball to
`file:vendor/crucible-client-0.6.0.tgz` (the same bytes BookForge vendors at
`vendor/crucible-client-0.6.0.tgz`), so an install was required. Following the
2026-09-14 entry's procedure exactly: `foundry-app/node_modules` confirmed a
REAL directory first (`LinkType` empty, no reparse point) per the worktree-
hygiene rule; `npm install --no-audit --no-fund` — **never `npm ci`** — which
took `@crucible/client` 0.5.0 → 0.6.0; the `foundry` self-link junction it
creates (`"foundry": "file:.."`, which vendored here points at BookForge's REPO
ROOT) deleted with a NON-recursive `.Delete()` on the link and `Test-Path`
confirmed False, with the repo root and the main `node_modules` (769 entries)
verified intact either side; then `npm rebuild electron`, without which the
compiled `app-settings.js` throws *"Electron failed to install correctly"* and
takes `tools/test-clean-step-door.js` down with it. `npm run build` clean; ng
**1.03 MB** (993.49 kB → 1.03 MB, the standing budget WARNING only).

Verification: **171/171 blobs** hash-verified against `1ce539a:app/` with
`git hash-object` vs the source tree's index shas, so `autocrlf` cannot lie. 46
files changed from the committed base (33 modified, 13 added, **no deletions**),
matching `git diff --name-status e6d5424..1ce539a -- app` exactly. The only
files in the subtree that are not in `app/` are this note and
`IPC-CHANNELS.md`.

---

**40aaa42 (copied 2026-09-15, same day) — A LOCAL CRUCIBLE IS AN ORDINARY
SERVER, and the app sha and engine sha agree again.**

A same-day refresh over `1ce539a`, ten files, no deletions. Owen ruled the next
version is 2.0, and the binary was rebuilt clean from this tree, so
`dist/foundry-windows-x64.exe` answers **`foundry 2.0.0 (40aaa42)`** — all hex
in the parentheses, which is what `tools/test-foundry-clean-text-vendor.js`'s
tier-2 regex needs in order to find a commit and VERIFY rather than refuse.

What it carries: `registerPairing()` is the ONE writer both pairing doors share,
so a pairing file is registered exactly as a pasted connect code is — same
refusals, same clamp, the name taken from the LINE unless a person typed one,
and the `PAIRING_SERVER_NAME = 'local'` holdout gone structurally rather than by
swapping a constant. `adoptPairingFile`'s any-loopback decline became *"is this
file's URL already registered"*, and `coordinateEveryServer` now takes the
registry's drag rank rather than loopback-first — *"an address is not a ranking,
and `127.0.0.1` is as likely to be a tunnel as this machine."* Slot-name rules
gained one owner in their `shared/slots.ts`, consulted by all four callers and
applied to the cloud list too, with the silent `.slice(0, 60)` deleted outright.

── WHAT WAS CHECKED ON THIS SIDE, RATHER THAN ASSUMED ──────────────────────

The commit is marked BREAKING and its subject is about a reserved NAME, and
BookForge hands the hosted window an entry literally called `local`. Three
things were read before trusting the refresh:

  * **`local` is still a legal name.** The new forbidden set is `:`, `/`, `\`,
    control characters and the reserved words `any` / `This computer` (either
    case). `LOCAL_SLOT_NAME = 'This computer'` survives and is their own
    GPU-slot label, unrelated to a registry entry named `local`. What retired is
    the reserved name the PAIRING door used to write.
  * **The new name rules are not applied to host-supplied entries.**
    `cleanHostServers` still uses a bare `.trim()`; the three `tidySlotName`
    call sites are their standalone WRITE doors (add, remove, adopt-local).
    That matters because `tidySlotName` collapses runs of whitespace: if it ran
    on the hosted path, a BookForge server named `my␣␣mac` would become `my␣mac`
    over there, BookForge's preflight would pass, and their `slotNamed` would
    then miss — the exact forever-park the preflight exists to prevent. It does
    not run there, so the preflight's `entry.name.trim()` comparison is still
    byte-for-byte what they match against.
  * **`slotNamed` is still `slot.name === name`** — exact and case-sensitive,
    which is what `hostedCrucibleServerNotOffered` claims in its sentence.

── THE CONNECT-CODE DOOR NOW COORDINATES, AND NOTHING DOUBLES UP ───────────

That door was the one road into their registry that skipped the
coordinate-on-connect moment while `crucible:add` beside it took it. It is a
correctness fix and it changes nothing here: hosted, their registry is the
HOST's and read-only (`mount.ts` guards the pairing adoption to standalone), so
neither write door is reachable to add a server in the first place.

The startup sweep DOES run hosted, by their explicit design, and it is not
double coordination: *"each app still posts its OWN module: the union of the two
modules on one server is the contract. What is suppressed hosted is the DRAWING
(the Servers card is BookForge's), not the asking."* So a hosted launch has
BookForge posting `bookforge.module.json` and the window posting
`foundry.module.json` against the same servers — two different documents, by
contract. It is `void`-ed rather than awaited, so it costs a launch nothing.

── The install ────────────────────────────────────────────────────────────

`@crucible/client` did not move at this sha (still
`file:vendor/crucible-client-0.6.0.tgz`, already installed), so the install was
close to a no-op — but the full procedure was run anyway, inside the dist lock:
`node_modules` re-confirmed a REAL directory (`LinkType` empty) immediately
before `npm install --no-audit --no-fund` (**never `npm ci`**); the `foundry`
self-link junction that install recreates — `"foundry": "file:.."`, which
vendored here points at BookForge's REPO ROOT — deleted with a NON-recursive
`.Delete()` after asserting it really is a junction, with the repo root and the
main `node_modules` count verified either side; then `npm rebuild electron` and
`npm run build`.

── THE INSTALL POLLUTES `package-lock.json` — RESTORE IT AFTERWARDS ───────

Found 2026-09-15, in the subtree committed at `0da32263`. `npm install` resolves
this package's own `"foundry": "file:.."` dependency, and vendored here `..` is
**BookForge's repo root** — so npm rewrote the vendored lock's root entry to
`"name": "bookforge-app", "version": "0.1.7"` with BookForge's whole dependency
list, displacing foundry's own `"version": "1.3.0"`. The subtree stopped being a
mechanical copy of anything, and the next `npm install`/`npm ci` run in here
would have been resolving against BookForge's manifest.

It is harmless at runtime — `node_modules` is already built and the lock is only
read by the next install — which is exactly why it went unnoticed for a commit.

**So the last step of every re-vendor is to put the lock back:**
```
git -C <foundry> show <sha>:app/package-lock.json > foundry-app/package-lock.json
```
then re-run the blob verification, which is what catches it. Do this AFTER the
install and the build, not before. It is the same defect the self-link junction
has, in a file rather than a directory, and it wants the same treatment: let the
install create it, then undo it.

Verification: **171/171 blobs** hash-verified against `40aaa42:app/` — including
`package-lock.json`, restored per the note above after the install rewrote it.
