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
| Source sha | **29c40a0** — *Wave 15: the import row orders a host act, and the host may revise its offers* |
| Copied on | 2026-08-18 |
| Copied by | `git -C <foundry> archive 1430bef app \| tar -x --strip-components=1` |

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

`IPC-CHANNELS.md` beside this file is `docs/IPC-CHANNELS.md` from the same sha —
it is not part of `app/`, it is carried along because it is the authority the
collision keeper (`tools/test-ipc-collision.js`) parses. Foundry's side has
committed to regenerating it from source on every wave.

## SEALED SUBTREE

**Edit in the Foundry repo and re-copy. Never here.** A fix made in this
directory is lost the next time the subtree is refreshed, and worse, it makes
the two copies disagree while both look authoritative. If something in here is
wrong, it is wrong in Foundry — say so on the message channel
(`E:\agent-bridge\bookforge-to-foundry.md`) and take the next sha.

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
