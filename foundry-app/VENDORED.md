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
| Source sha | **c403ee5** — *feat(app): a hosted mint inherits the parent document's metadata* |
| Copied on | 2026-08-24 |
| Copied by | `git -C <foundry> archive c403ee5 app \| tar -x --strip-components=1` |

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
