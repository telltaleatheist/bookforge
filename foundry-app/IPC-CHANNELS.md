# Foundry's IPC channels — the whole list, for the collision audit

## A cleanup with its triage in front of it (2026-09-23)

**COUNTED BY SCRIPT OVER `app/electron/ipc.ts`: 143 `ipcMain.handle` call sites,
143 distinct channel names, zero `ipcMain.on`.** The figure before this change
measured **142**, one door arrived and none left. **AND THE HEAD OF THIS FILE WAS
STALE AGAIN:** the section below says 130, and the source at the commit before
this one measured 142 — twelve doors filed under an old figure, the standing
failure this file keeps recording. The distinct-vs-total equality holds, so
nothing in Foundry collides with itself.

| Channel | Request/result |
| --- | --- |
| `queue:enqueue-clean-triaged` | `CleanRequest` → `{triage: Job \| null, clean: Job}`. Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with snap and then we bring snap down and load the full normal cleaning logic."* Queues TWO rows from one press: a `clean-triage` row (a small `decide` model on a Crucible marks which blocks need cleaning at all, writing a verdicts file main names beside the records, `<key>.clean[.<id8>].triage.json`) and the `clean` row chained behind it (`after` = the triage's row id, `triagePath` = that file, so `clean-text --triage` asks the cleaner only about what was flagged). Both are pinned to the same ledger row, so both read one book; a cleanup pressed on a greyed card defers its triage on the same promise and waits behind the triage. `triage` is null only when a cleanup writing the same records was already queued without one — that row comes back as `clean`. Routed like `queue:enqueue-translate`, and NOT refused hosted: the pair goes to the host's queue as two `enqueue` calls. |

**A DOOR OF ITS OWN, NOT A FLAG ON `queue:enqueue-translate`.** That door
answers with one row, and the Clean text dialog acts on both of these — a server
picked there is pinned on each row and its Start releases each. The pair is made
in main, in one turn, because the three facts that make it correct (the verdicts
path, the pinned row, the link) are all main's; see `enqueueTriagedCleanup` in
`app/electron/job-queue.ts`.

**ONE PAYLOAD WIDENED INSIDE CHANNELS THAT DID NOT MOVE.** `Job.kind` gained
`clean-triage` and `JobProgress.phase` gained `triage` (`queue:changed`,
`queue:list`), and `CleanRequest` gained `triagePath`. **FOR BOOKFORGE:** the
host seam's `FoundryHostQueue.enqueue` now takes `CleanTriageRequest` as well, and
a host that mirrors rows has to name the kind — its lane (GPU), its label, its
progress line `clean-triage: n/m`, and the fact that it lands nothing in the tree.

## The install door can be watched, not only driven (2026-09-19, crucible PHASE19)

**COUNTED BY SCRIPT OVER `app/electron/ipc.ts` IN THIS WORKTREE: 130
`ipcMain.handle` call sites, 130 distinct channel names, zero `ipcMain.on`.**
The figure before this change measured **128**. Three doors arrived, one left,
and 128 − 1 + 3 = 130, which is the whole of the arithmetic. The distinct-vs-total
equality is the part worth re-running and it holds, so nothing in Foundry
collides with itself.

| Channel | Request/result |
| --- | --- |
| `crucible:install-status` | → `{running, outcome}` — crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.6's `GET /install`. `outcome` null means nothing has said yet, never "it is fine". A READ. |
| `crucible:install-event` | Push, BROADCAST to every window: one machine is being set up, not one window's install. The camelCase reading of `@crucible/bootstrap`'s `HostEvent` (`step`, `progress`, `state`, `line`, `done`, `failed`), shaped in `app/shared/crucible-install-wire.ts`. |
| `crucible:install-retry` | §2.5's **Try again** — the same run `crucible:install` performs, offered only on an outcome of `cannot` or `failed`. |
| `crucible:restart-windows` | §2.3's **Restart now** — `shutdown.exe /r /t 5`, as the interactive user, no elevation, and ONLY when a person presses it. Refuses off win32 by name. |

**REMOVED — `foundry:crucible-wsl-upgrade` and its push
`foundry:crucible-wsl-progress`.** They were the two halves of one button,
"Set up WSL acceleration", which submitted an `engine/wsl` task to a native
Windows engine and followed it. PHASE19 §0 deletes the offer on a ruling rather
than a refactor — Owen, 2026-09-18: *"we should assume the user doesn't know how
to do it, and we shouldn't offer to let them do it themselves … it should do it
automatically."* The move is Crucible's tray's now, decided at every start from
facts on disk (§2.3); an app that could also ask for it would be the second
owner of that decision. `app/electron/crucible-engine-upgrade.ts`,
`app/shared/engine-upgrade.ts` and the `upgradeWindowsEngine` / `onEngineUpgrade`
entries on `FoundryApi` went with them. **FOR BOOKFORGE:** a vendored bridge
entry for either name should be removed; the successor is the four doors above.

## Approved remote connection (2026-09-16)

| Channel | Request/result |
| --- | --- |
| `foundry:crucible-pair-start` | Computer address → public request ID, short approval code, name, URL, expiry and poll interval. Standalone only. |
| `foundry:crucible-pair-poll` | Request ID → pending/approved/denied/expired. Main registers approved credentials and coordinates the server. Requests belong to the initiating window. |
| `foundry:crucible-pair-cancel` | Cancels this window's pending local exchange state. Server requests expire independently. |
| `foundry:crucible-pair-requests` | Registered server name → pending approval codes, client names/addresses and expirations, through its authenticated front-door client, where pairing was requested. |
| `foundry:crucible-pair-decide` | Registered server, request ID, matching code, allow/deny → approval decision. Credentials remain in main. |

The private device code and approved bearer token never cross the preload into
the renderer. Closing a window, cancelling or replacing a request prevents a
late HTTP result from registering a server. Existing pasted connect codes remain
available. These prefixed channels do not collide with BookForge's pairing flow.

**TWELVE DOORS AND ONE PUSH REMOVED ON 2026-09-15 — FOUNDRY KEEPS NO MODEL.
COUNTED BY SCRIPT OVER `app/electron/ipc.ts`: 133 `ipcMain.handle` call sites,
133 distinct channel names, zero `ipcMain.on`.** Nothing was added, nothing was
renamed, and no surviving shape narrowed. The figure was 145 before this change
and 145 − 12 = 133, which is the whole of the arithmetic.

> ### THE COUNT ABOVE IS 2026-09-15's AND THE FILE DRIFTED UNDER IT
>
> **Re-counted 2026-09-17: 147, then 139 after the page-reader sweep the same
> evening. 139 `ipcMain.handle` call sites, 139 distinct names,
> zero `ipcMain.on`, zero duplicates.** One of those 147 is `queue:release`,
> added that evening (below). The other **thirteen** arrived between 09-15 and
> 09-17 without this line moving.
>
> That matters more than the arithmetic. BookForge's `tools/test-ipc-collision.js`
> reads THIS FILE as the authority on what Foundry claims, and two
> `ipcMain.handle` calls of one name in one main process throw at registration —
> the app does not start. A count that stopped tracking the source is a collision
> check that quietly stopped checking, in the document whose whole job is to
> prevent that.
>
> The distinct-vs-total equality is the part actually worth re-running, and it
> holds: 147 = 147, so nothing in Foundry collides with itself today. Whoever
> adds the next channel should re-run the count rather than trust the number
> above it.

**Owen, verbatim:** *"we dont have any local models. crucible handles all model
orchestration. if theres no connected crucible server then tiles should be
disabled. crucible is a service that foundry installs locally and connects to."*
And, sharpening it: *"crucible should handle model orchestration right? so
crucible is where which models to use is decided. but foundry does pass through
settings to crucible."*

**REMOVED — the `ollama:` family, entire (six doors and one push).**
`ollama:facts`, `ollama:choices`, `ollama:install`, `ollama:install-cancel`,
`ollama:pull`, `ollama:pull-cancel`, and the `ollama:progress` push. Foundry
pulls no models, so it has no standing to install the thing that pulls them; the
first-run wizard step these served is deleted with them. Ollama is still PROBED
in main, by one caller that is not a door — `machine-models.ts`, the "Models on
this machine" inventory (docs/SLOTS.md §5b), which counts weights already on the
disk and says nothing about where work runs.

**REMOVED — the `llm:` family, entire (six doors).** `llm:defaults`,
`llm:stored`, `llm:set-model`, `llm:set-clean-model`, `llm:ollama-url`,
`llm:set-ollama-url`. The model a request names is the ENGINE's capability
record's `selected` (crucible docs/PHASE15-HOST.md §3.3), applied over the
request at the spawn by the placement (`doorArgs`, electron/job-queue.ts) — so a
model chosen in Foundry was a choice that was then ignored, which is the defect
rather than the feature. `AppSettings.defaultLlmModel`, `cleanTextModel` and
`ollamaUrl` went with them; the engine's own `upstreams.ollama.url`
(PHASE15-HOST.md §3.2) is the surviving owner of that last fact.

**THE PASS-THROUGH IS UNTOUCHED, and it is the other half of Owen's ruling.**
`crucible:engine-settings`, `crucible:engine-settings-save` and
`crucible:engine-capability` write the ENGINE's own settings through
`PUT /v1/settings` — the route per llm class (`local` or `<upstream>/<model>`)
and the upstream keys. A route row legitimately contains a model NAME chosen by
a person; that is Foundry drawing the engine's store, not keeping one. No door,
shape or field of that family changed.

**FOR BOOKFORGE:** every name above is gone from the preload bridge and from
`FoundryApi` (`app/shared/api.ts`), whose `ollama` and `llm` namespaces are
deleted outright. A vendored bridge entry for any of the twelve should be
removed; there is no successor to point it at.

**THREE DOORS ON 2026-09-15 — WAVE 64 POINT 3, THE UNINSTALL DOOR. COUNTED BY
SCRIPT OVER `app/electron/ipc.ts`: 145 `ipcMain.handle` call sites, 145 distinct
channel names, zero `ipcMain.on`.** Nothing was removed, nothing was renamed, and
no existing shape narrowed. One shared file is new — `app/shared/uninstall-wire.ts`,
crucible `docs/INSTALL-UNINSTALL.md` §6.3 mirrored field for field.

**AND THE STANDING FAILURE, A FOURTH TIME.** The head below said **138** and the
source measured **142** before this change — four doors added under a stale
figure, which every dated paragraph in this file has now had to record. The
figure above is a measurement, taken by the script it names over the source in
this worktree.

- **`crucible:uninstall-availability` → `CrucibleUninstallAvailability`** — may
  the door be drawn at all. §6.1, and Owen's ruling with it: *the door only for a
  server the app can prove is this machine's; never a registry entry.* ONE
  function in main answers it and both doors below refuse on the same answer,
  because a hidden control over an open door is a decoration. It answers TWO
  questions, because on one machine they have different answers: what PROVED the
  server is this machine's (`pairing-file` — this machine's pairing file, read
  through the SDK, matching a registry entry on BOTH url and token, the name
  deliberately not having to match, since this PC's file says
  `crucible@example-pc-wsl` and the same engine is registered as `local`;
  `windows-host` — `%LOCALAPPDATA%\Crucible\host\crucible.cmd` exists, which is
  what "the host is installed" MEANS; `wsl-guest` — win32 with no host pack and a
  Crucible in the distro door 2 names), and what would RUN (`via`, §6.2's three
  lines). Owen's PC is proved by its pairing file and run through the host pack.
  §6.1's remaining proof — a server this app installed this session — is NOT
  implemented and cannot be: `crucible:install` refuses on every machine until
  `@crucible/bootstrap` ships. `:7101` is never knocked on: §6.2 says the host's
  loopback door was never extended with an uninstall, so there is no route there
  and asserting one would be inventing an endpoint. Hosted: always false. A READ.
- **`crucible:uninstall-dry-run` ({purgeWeights, wslToo}) → `CrucibleUninstallPlan`**
  — `crucible uninstall --json --dry-run`, §6.4 step 1. Touches nothing. The door
  asks it again whenever a checkbox moves, which is the contract's own
  instruction: the kept-models figure has to move, and the dry run is the only
  thing that knows the new number. Exit **1 is still a plan** — `ok: false` names
  the one step that failed and the others happened.
- **`crucible:uninstall` ({purgeWeights, wslToo}) → `CrucibleUninstallRun`** — the
  same flags, performed, §6.4 step 2: the same rows with `done` filling in. AND
  the one act that is Foundry's rather than the verb's — §2's box, *"THE TOKEN
  ALWAYS GOES, on every uninstall"* — so a run that stopped the engine removes the
  registry row the proof named, through the registry's one writer
  (`removeCrucibleServer`, new, `addCrucibleServer`'s twin), followed by
  `afterRegistryChanged`. `unregistered` names the row that went, or null when the
  proof named none (a `windows-host` proof names no row) or the engine was not
  stopped. Coordination state for that name is LEFT to the next connect: the map
  is keyed by registry name, the Servers card looks a row's state up by the row's
  name, and there is no row any more — so the stale entry draws nothing anywhere,
  and registering that name again coordinates afresh over it.

**THE APP-SIDE REFUSAL NAMES ARE AGREED WITH BOOKFORGE** (2026-09-15) so two apps
name one situation one way: `uninstall_not_local`, `uninstall_not_available`,
`uninstall_no_localappdata`, `uninstall_no_distro`, `uninstall_home_unreadable`,
`uninstall_wsl_too_needs_host`, `uninstall_unrun`, `uninstall_unreadable`,
`uninstall_failed`. They are facts about THIS APP's reach and are a different
layer from the CLI's own refusals, which arrive per step inside the plan in the
engine's words (§6.3's table) and are never translated.

**No token is in any of the three answers or in any line they log.** The plan's
paths — `home`, `kept.paths`, each step's `target` — are directories, which is
what a person reading a plan needs to see; the verb prints no credential, because
`remove-config` deletes the file holding the bearer token and never echoes it.

**FOUR DOORS ON 2026-09-14 — WAVE 62 PACKAGE J, CONNECT THREE WAYS. COUNTED BY
SCRIPT OVER `app/electron/ipc.ts` AFTER THE MERGE WITH PACKAGE H BELOW: 138
`ipcMain.handle` call sites, 138 distinct channel names, zero `ipcMain.on`.** Nothing was removed, nothing was renamed, and
no existing shape narrowed. One shared type gained a member
(`LocalCrucibleAdd` is now the pairing file's answer as well — see below).

**THE STANDING FAILURE, A THIRD TIME, AND IT IS RECORDED RATHER THAN QUIETLY
FIXED.** The head of this file said **130** and the source at `5d37806` measured
**132** — two doors added under a stale figure, which is the exact thing the
2026-08-22, 2026-08-23 and Wave 61 paragraphs below already record. **The figure above is a
measurement**, taken with the script over the source in this worktree; every
name in it is in the per-family tables, which are and remain the authority.

- **`crucible:add-from-pairing-file` → `LocalCrucibleAdd`** — look for the
  connect code Crucible leaves on this machine (`<CRUCIBLE_HOME>/pairing`,
  crucible `docs/PHASE15-HOST.md` §3.6, pinned in Crucible `3bcd003`) and
  **register it under the name the line itself carries** — the same writer, the
  same name source and the same clamp as `crucible:add-connect-code`, because a
  pairing file IS a connect code the machine left on disk. There is no reserved
  name: Owen, 2026-09-15 — *"it shouldnt be named 'local' anywhere. it might not
  be local. a local crucible server shouldnt be treated any differently than a
  remote crucible server. it should all be entered the exact same way."*
  (BookForge deleted its own reserved identity in `24b7bf67`.) It declines when
  **the address in the line is already registered** — the clamped URL, not the
  name and not whether the URL looks loopback, because `127.0.0.1` is as likely
  to be a tunnel to somebody else's card as it is to be this machine.
  **The same read runs once at start**
  (electron/mount.ts, standalone only — hosted the registry is the host's), so
  this door is §3.6's SECOND CHANCE: an engine installed after this app opened.
  `LocalCrucibleAdd` is REUSED rather than given a twin, because the two doors
  say the same three things — added, nothing here (`no_local_config`, and an
  absent file is a FACT, not a fallback), or something here that will not read
  (`config_unreadable`, carrying the SDK's own `invalid_pairing` sentence).
  **No token crosses**: main reads the line, writes the entry, answers the view.
- **`crucible:parse-connect-code` (line) → `ConnectCodePreview`** — what a pasted
  connect code says, **name and address only**. Pure: the SDK's `parsePairing`
  (PHASE13-OPERATOR.md §2.1) and no network, so the door runs on every change of
  the paste field. The person typed the token, but the answer does not carry it
  back — the renderer never holds a credential it did not type into a field for
  that purpose, and a preview carrying one would put a token in a signal for as
  long as the door stayed open.
- **`crucible:test-connect-code` (line) → `CrucibleProbe`** — `crucible:test-at`
  for a pasted line, and it exists BECAUSE that door cannot serve this one: it
  takes a token, and handing the code's token back so it could be handed forward
  is exactly what the preview refuses. Writes nothing. An unreadable line is a
  RESULT (`outcome: 'failed'` with the SDK's sentence), not a rejection.
- **`crucible:add-connect-code` (line, name) → `CrucibleSettingsView`** — add what
  the code names, through the registry's one writer. The NAME is the caller's
  (the preview filled the box and somebody may have renamed it); empty falls back
  to the name inside the code. Rejects by name on a line that will not parse, and
  answers the whole view for `crucible:add`'s reason. It now also **coordinates**
  with what it added (PHASE14 §4a: a server being added is the moment), which it
  did not before it and the pairing file's road were made one writer.

The line takes **the same road three times** rather than a token being handed
back and forth: preview, Test and Add each send the LINE into main, which parses
it afresh. Parsing is pure and costs nothing, and the alternative is a secret
making two extra crossings of the preload for no gain.

**TWO DOORS AND ONE PUSH ON 2026-09-14 — AUTOMATIC COORDINATION WITH EVERY
CONNECTED CRUCIBLE. COUNTED BY SCRIPT OVER `app/electron/ipc.ts`: 134
`ipcMain.handle` call sites, 134 distinct channel names, zero `ipcMain.on`.**
Nothing was removed, nothing was renamed, and no existing shape narrowed.

**AND THE STANDING FAILURE HAPPENED AGAIN, WHICH IS THE THIRD TIME THIS FILE
HAS HAD TO SAY SO.** The head below said **130** and the source measured **132**
before this change — two doors added under a stale figure. The figure above was
measured by the same script it names, over the file as it now stands. A FIGURE
QUOTED AS A GATE IS A MEASUREMENT OR IT IS DECORATION.

- **`crucible:coordination` → `CrucibleCoordinationMap`** — where coordination
  stands with every server it has anything to say about, keyed by registry
  name. A server absent from the map has not been asked yet, which is a real
  answer and deliberately not a member of the state union: "idle" drawn as a row
  would be a screen announcing the absence of news. A READ — it starts nothing.
- **`crucible:coordinate` (name) → `CrucibleCoordinationState`** — coordinate
  with one named server now. Idempotent and concurrency-safe: a second call
  while one is in flight joins the first rather than racing it into the
  `task_busy` the whole design exists to avoid. It does not reject — every way a
  conversation with a machine can end is a STATE, "there is no server called
  that" included. **There is no button behind it**: coordination runs by itself
  on every enabled server at app start, on `crucible:add`, on
  `crucible:add-local`, and on every entry a `crucible:save` added by name or
  switched back on (crucible `docs/PHASE14-ENVPACKS.md` §4a, Owen 2026-09-14:
  presence of the app is the request, and the enable switch in Settings is the
  one opt-out). This door exists for a screen that has just learnt about a
  server and would otherwise wait for a push already sent.
- **`crucible:coordination-changed` (push, `CrucibleCoordinationState`)** — one
  server's state, every time it moves. It CARRIES A PAYLOAD where
  `acts:gates-changed` and `models:changed` deliberately do not, and the reason
  is the shape of the news: those two say "ask again" about a composed answer
  that costs a probe, while this is a single small value the renderer already
  holds a mirror of — a push that only said "something moved" would make every
  window re-read the whole map on every byte of a download. Broadcast to every
  window, because coordination starts at APP START, before any window has asked
  for anything. **The payload gained `unmet` on 2026-09-14** (crucible
  `docs/PHASE15-HOST.md` §5.3a, crucible `e342fee`): the vendored module names
  CAPABILITY CLASSES rather than model ids now, and a class the engine has
  disabled is neither missing nor a refusal — it is a fact about that machine,
  and it travels on `stocked`, `preparing` and `waiting` as `{class, reason}`
  with the capability row's own reason verbatim. `CrucibleModuleProgress.unmet`
  carries the same thing off the finished task (`TaskStatus.unmet`), null until
  the task is terminal, because the server is the one that resolved the classes.
  A server with nothing missing and classes unmet is still `stocked`: the word
  means "nothing to download", and there is nothing.

**NO TOKEN CROSSES EITHER DOOR, in either direction**, which is the rule the
whole `crucible:` family keeps: a state names a server, a phase, what is
missing, and whatever sentence the SERVER itself wrote about the holder of its
card. The vendored module (`app/shared/foundry.module.json`) is read in main and
posted from main; the renderer is never told what is in it, and does not need to
be — the words are composed from the MISSING list in
`app/src/app/core/crucible-words.ts`.
**FOUR DOORS ON 2026-09-14 — WAVE 62 PACKAGE I, THE SETTINGS WINDOW. COUNTED BY
SCRIPT OVER `app/electron/ipc.ts` AFTER THE MERGE WITH PACKAGES H AND J: 142
`ipcMain.handle` call sites, 142 distinct channel names, zero `ipcMain.on`.**
Nothing was removed, nothing was renamed, and no existing shape narrowed.

**AND THE FIGURE BELOW WAS STALE AGAIN BY TWO.** The head of this file said
**130** and the source measured **132** before this change — two doors added
under a stale figure, which is the failure the paragraph under this one and the
2026-08-22 / 2026-08-23 paragraphs below already record three times. A FIGURE
QUOTED AS A GATE IS A MEASUREMENT OR IT IS DECORATION. The per-family tables
remain the authority for the NAMES; where a total contradicts them, the tables
win.

- **ADDED: `crucible:engine-settings`, `crucible:engine-settings-put`,
  `crucible:engine-upstream-test`, `crucible:engine-capability`** — the window
  onto ONE registered server's own settings (crucible `docs/PHASE15-HOST.md`
  §3.1, §3.2, §3.3, §5.2). Owen's ruling: the GPU engine is the SINGLE SOURCE OF
  TRUTH for AI settings, so these four read and write a store that lives on the
  SERVER and touch `app-settings.json` not at all — *"every control in these
  sections is a request to the engine, and its result is the engine's answer
  re-read. There is no Save button that writes an app file and syncs later."*
  Each row is described in the `crucible:` table below.

  **`engine-` rather than four more bare `crucible:` members**, because that
  family already means "this app's registry of servers" and these are not about
  the registry: they are about what ONE of those servers has been configured to
  do. **They take a server NAME**, like `crucible:open` and for the same reason —
  the address and the token are looked up in main, so nothing a renderer holds
  could send a key to an engine this app has not been told about. **And no answer
  on any of the four carries a credential**: `SettingsDocument` has `keyHint`,
  the last four characters, where the engine has a key, which is
  `CrucibleServerView.tokenSet`'s rule one wire along. The wire types live in
  `app/shared/engine-settings.ts`; `CapabilityRow`/`CapabilityRecord` MOVED there
  from `electron/crucible-dispatch.ts` unchanged, and that file re-exports them,
  so every existing importer is untouched and there is still one declaration.

  **No push was added.** A settings write moves the dock's tiles when it touched
  a route, and the existing `acts:gates-changed` (through `afterRegistryChanged`)
  is what says so — a second push for the same news would be two writers of one
  fact.

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
- **`crucible:install-plan` → `CrucibleInstallPlan`** — reads the native
  installation plan. Windows does not require WSL; the optional upgrade belongs
  to Crucible's own console.
- **`crucible:install` → void** — runs Crucible's installer, checks readiness and
  registers its published connection. Refuses hosted, unsupported platforms and
  concurrent installations. Errors preserve the installer's failure.
- **`crucible:install-line` (push, string)** — live installer output, sent only
  to the window that started the operation.
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

### Three names added on 2026-09-15 — the Uninstall door (Wave 64 point 3)

`crucible:uninstall-availability`, `crucible:uninstall-dry-run`,
`crucible:uninstall`. Built to crucible `docs/INSTALL-UNINSTALL.md` §6 (6.1–6.4),
which is the contract. The renderer is a FOURTH DOOR inside
`app-crucible-doors`, behind a `canUninstall` input the Servers card passes and
the first-run wizard does not: the child is mounted by both screens, and offering
to remove Crucible to somebody who has not installed it is a wizard arguing with
itself. Its words are BookForge's verbatim (agreed 2026-09-15) — two apps that
remove one engine off one machine must not describe it two ways.

Four things worth naming rather than leaving in the table.

**A `.cmd` cannot be spawned without a shell on this Node, and that is measured.**
Node 20.19.5 and Electron 33's Node both carry the CVE-2024-27980 fix, so
`spawn('…\\crucible.cmd', argv)` throws `EINVAL` outright — verified on this
machine before the module was written. So the win32 host arm takes §6.2's
documented fallback: `cmd.exe /d /s /c "<every token quoted>"` with
`windowsVerbatimArguments`, assembled from an argv array so nothing a person typed
can reach it, and a `%LOCALAPPDATA%` carrying a quote or a percent sign is refused
by name rather than escaped by guesswork. The WSL arm goes through `bash -c` with
a fixed script, for the reason `addLocalCrucible` already does: only the guest can
expand its own `CRUCIBLE_HOME`.

**Strict about fields, open about values.** A field §6.3 says is always there and
is not there is `uninstall_unreadable` — a plan with an invented `ok` is a plan
that says the wrong thing about a machine somebody is about to change. An OPTIONAL
field arrives as null and means what §6.3 says: an absent `bytes` is *"the target
is not a path"*, which is not zero. An unknown STEP NAME or action word is carried
through as a string and drawn, because two of §6.3's name shapes are open-ended
(`weights:<catalog kind>` is the server's list, `keep-unknown:<name>` is a file
Crucible did not write) and nothing in this app switches on one.

**`ok: false` is never "uninstall failed".** §6.3 is explicit that a fatal step does
not stop the run, so the door marks one row and says *a step refused, above, by
name; everything that DID finish is gone; nothing is half-removed silently* — and
there is no arrangement of that component that produces the other sentence.

**Both checkboxes default off, and changing either clears the plan before asking
for a new one.** Both halves matter: clearing is what stops a Remove button
sitting over rows priced for other flags, and the re-ask is §6.4's own instruction
so the kept figure moves with the box. Closing the door clears it too, and
reopening asks again.

## Doors the renderer knocks on

All 147 are `ipcMain.handle` — there is not one `ipcMain.on` in the app, on
purpose: a renderer that cannot tell whether main heard it is a renderer that
cannot report a failure. They are registered in one function, `registerIpc`
(`app/electron/ipc.ts`), which `mountFoundry` calls.

| Channel | What it does |
| --- | --- |
| `acts:gates` | Is anything SERVING each of the five acts, and the sentence either way — translate, simplify, analysis, clean, read. An enabled engine whose capability row says so, a connected cloud provider, or (for `read` alone) the page reader on this disk. It measured this machine — the card, the catalogue floor, Ollama's library — until 2026-09-15, and does not any more: Foundry runs no model. Not the stage gate: whether an act applies where somebody is standing is `shared/stages.ts`, in the renderer, and a tile needs both. |
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
| `cloud:save` | Replace the whole provider list. `apiKey: null` keeps the stored key. Provider names are refused by `crucible:save`'s one rule, because both lists feed one picker. Answered with the whole view, because enabling a provider changes the slots. Refused while hosted. |
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
| `page-reader:install` | Fetch whatever the local page reader is missing — a llama.cpp build for this machine and the two dots.ocr GGUF files — verify each against its published sha256, and unpack. Streams over `page-reader:progress`. A failure is a result, not a rejection. |
| `page-reader:install-cancel` | Stop that. What has already been fetched is KEPT: the next attempt resumes from it. |
| `page-reader:set-keep-warm` | Minutes an app-started page reader outlives a drained queue, clamped; answers with the value as stored. The read is on `page-reader:state`. |
| `page-reader:start` | Start it now, or adopt whatever is already answering on the port. Pre-warming, so the first book of an evening does not pay the load. Rejects with the server's own log tail. |
| `page-reader:state` | EVERYTHING THE SETTINGS ROW AND THE SETUP STEP NEED, IN ONE READ: supported on this platform, installed, which llama.cpp release and accelerator, both model files by name and size, what a download would cost right now, the server's status, and the keep-warm minutes. One call because every one of those is measured off the same directory at the same moment. |
| `page-reader:stop` | Stop it, if this app started it. A server it merely found is left alone and says so. |
| `projects:delete` | Delete a project directory, for real. |
| `projects:describe` | What that project delete would destroy, in words and bytes. |
| `projects:list` | Home's listing: one row per book, with what is in it. |
| `queue:cancel` | Cancel one job. Forwarded to the host's queue where one is registered. |
| `queue:clear-finished` | Clear the settled rows out of the shelf. Forwarded to the host's queue as well, where one is registered. |
| `queue:enqueue` | Queue a reading or a rendering; captures the project's position as the parent step. Filed in the host's queue instead, where one is registered — this door is a person pressing something. |
| `queue:enqueue-analysis` | Queue an analysis: the book read against the categories, held on the GPU lane. Never routed, and REFUSED outright hosted — the host's queue does not know this request shape, and Foundry's own queue is invisible in a hosted window. |
| `queue:enqueue-clean-triaged` | Queue a cleanup WITH ITS TRIAGE in front of it — a `clean-triage` row, then the `clean` row chained behind it reading its verdicts (`--triage`). Answers both rows. Routed like `queue:enqueue-translate`; see the 2026-09-23 section at the head of this file. |
| `queue:enqueue-translate` | Queue a TEXT PASS — a translation, a simplification or a narration cleanup (`TextPassRequest`). Routed like `queue:enqueue`. The name is the family's eldest member, kept rather than renamed: the door's behaviour is unchanged and a rename costs this audit two entries. |
| `queue:list` | The queue, for the renderer's mirror — the host's rows where a host queue is registered, Foundry's own otherwise. |
| `queue:remove` | Remove a held or settled row. Forwarded to the host's queue where one is registered. |
| `queue:run` | Run an export NOW and resolve with the settled row — the Export dialog's door. Never routed to a host queue; the row leaves the list at the settle, so nothing lingers in the shelf. Refuses a `read` by name. |
| `queue:set-wait-for` | Send a held or queued row to a different SLOT — a slot name, or `any` (docs/SLOTS.md §3). Answers nothing; the row arrives on `queue:changed` like every other change. Refused silently on a row that has started, because a job is atomic on one slot. NOT forwarded to a host queue: a host's placement is the host's. |
| `queue:start` | Release everything held at this moment. Forwarded to the host's queue where one is registered. |
| `slots:list` | `SlotAvailability` — the slots in priority order AND, when there is one, the reason there are none. The slots are where compute-heavy work may go: one per enabled Crucible server, then one per enabled cloud provider (`kind: 'cloud'`, and carrying no `url`, deliberately — see docs/SLOTS.md §7, Package F). **There is no local slot** (Wave 66, Owen: *"there should be no local gpu listed in the queue… one gpu slot in the queue per connected crucible server. including the local crucible, which is indistinguishable from the remote crucible server"*), so `kind` is `'crucible'` or `'cloud'` and never `'local'`, and an EMPTY list is the ordinary state of a machine with no engine registered — GPU work in that state is refused by name rather than run here, while CPU work (exports, compiles, rasterising) is unaffected. An entry whose address resolves to an orchestrator with no engine behind it is not listed, read from the resolver's cache only (never a network hop behind this door); an unprobed entry is listed. Hosted, they are derived from the host's own registry (`FoundryHost.servers`). One entry or none is the ordinary answer and draws no picker anywhere. **The answer is an object, not an array** (changed 2026-09-14): an empty array could not tell "no servers were added" from "there was nobody to ask", and a hosted window whose host offers no registry was drawing the second as the first. `refusal` is `null` in the ordinary case, else `{code, sentence}` with `code` one of `host_provides_no_registry` (the seam is missing from the host's build) or `host_registry_unavailable` (it is there and the call failed — BookForge throws before its first snapshot — and may answer on the next read). |
| `slots:rows-waiting-for` | The waiting rows of OURS that name one slot — what the Servers card shows before it offers to move any of them. Running rows are deliberately not included. |
| `crucible:settings` | Everything the Servers card draws in one read: the registry (with `tokenSet`, never a token), the derived slots, the new-jobs default, the WSL distro, and whether this window is hosted. |
| `crucible:save` | REPLACE the whole registry, in order — the array position IS the rank, so a drag is a save. `token: null` on an entry keeps what is stored. Rejects with a sentence naming the entry it cannot store. A NAME IS REFUSED BY ONE RULE — `slotNameRefusal` (app/shared/slots.ts): trimmed, 1-48 characters, no control character, no `:` (it is the mark between a slot and its upstream lane, so `3090:cloud` would be the same string as server `3090`'s lane), no `/` or `\` (a server name becomes a browser session partition), and not `any`, which the queue has already spent. (`This computer` was reserved beside it until Wave 66 deleted the local slot; a name nothing uses is not reserved, and the CPU lane needs no reservation because it has no name in this namespace — it is a count, `CPU_LANE_SLOTS`.) The same function is the clamp on the way to disk, so the writer and the file can no longer disagree. Refused outright while hosted. |
| `crucible:test` | Test connection (`client.info()`). A failure is a RESULT carrying the SDK's own sentence, not a rejection. **The probe FOLLOWS the orchestrator hop** (crucible `docs/PHASE17-ORCHESTRATOR.md` §6): a registered address that turns out to be an orchestrator is resolved to the engine it manages and the `ok` arm reports THAT engine's name, version, backend and card, with `via` — a present-null field, new 2026-09-15 — naming the orchestrator in front of it. An orchestrator fronting an engine is a SUCCESS and the card says both; an orchestrator with no engine, and a hop that points at a second orchestrator, are failures carrying `orchestrator_has_no_engine` / `orchestrator_engine_is_not_an_engine`'s own sentence. `crucible:test-at` and `crucible:test-connect-code` share the type and the behaviour. |
| `crucible:open` | Open a REGISTERED server's own operator page, by name. The window has no preload, is sandboxed, keeps its own session partition, refuses navigation off the server's origin and denies every popup and permission — it is a remote page this app merely hosts (electron/crucible-ui.ts argues each setting). By name rather than by URL so no token reaches the renderer. Deliberately NOT `crucible:open-ui`, which is BookForge's name for their own. **It opens the REGISTERED address and never the resolved engine** — the one door in this app that does not follow crucible `docs/PHASE17-ORCHESTRATOR.md` §6's hop, because a console is a person going to look at the process they named and the orchestrator's console is where §4's install/restart/quit buttons are (electron/crucible-ui.ts argues it). |
| `crucible:test-at` | The same probe against an address and token that are NOT in the registry — the wizard's Connect door, which has nothing saved to test. Writes nothing. The token goes one way, into main, and no answer carries it back. |
| `crucible:add` | Add ONE server, through the registry's one writer. Answers with the whole settings view, because adding a loopback entry changes the slots. An existing name is replaced in place, keeping its rank. |
| `crucible:add-local` | Register the connection Crucible published on this computer through the SDK pairing reader. Works with native Windows and WSL-managed engines; no distro choice. Existing address keeps its name, rank and enabled state while its token refreshes. Hosted is refused. |
| `crucible:add-from-pairing-file` | Look for the connect code Crucible leaves on this machine (`$CRUCIBLE_HOME/pairing`; `~/.crucible/pairing` on linux/darwin, `%LOCALAPPDATA%\Crucible\pairing` on win32 — PHASE15 §3.6, pinned in Crucible `3bcd003`) and register it under the NAME THE LINE CARRIES — the same writer, name source and clamp as `crucible:add-connect-code`, because a pairing file is a connect code the machine left on disk. There is no reserved name: Owen, 2026-09-15 — *"it shouldnt be named 'local' anywhere. it might not be local. a local crucible server shouldnt be treated any differently than a remote crucible server. it should all be entered the exact same way."* The read also runs once at app start (electron/mount.ts), standalone only; this door is §3.6's second chance, for an engine installed after the app opened. It declines when THE ADDRESS IN THE LINE is already registered (the clamped URL, never the name and never whether the URL looks loopback), because that is one engine with two rows. Answers `LocalCrucibleAdd`, reused: `added`, `no_local_config` (no file — a FACT the app shows, never a fallback it fills), `config_unreadable` (the SDK's `invalid_pairing` sentence, fragment already elided), `already_registered`. No token crosses. |
| `crucible:parse-connect-code` | What a pasted connect code says — **name and address only**, through the SDK's `parsePairing`. Pure and networkless, so the connect door runs it on every change of the paste field. The token is deliberately not in the answer, though the person pasted it: the renderer never holds a credential it did not type into a field for that purpose. `ConnectCodePreview`: `read` with name+url, or `refused` with the SDK's sentence. |
| `crucible:test-connect-code` | `crucible:test-at` for a pasted line. It exists because that door takes a TOKEN, and handing the code's token back to the renderer so it could be handed forward again is the one thing the preview refuses to do — so main re-reads the line instead. Writes nothing. An unreadable line is a RESULT with the SDK's sentence, not a rejection. |
| `crucible:add-connect-code` | Add what a pasted connect code names, through the registry's one writer — the SAME one `crucible:add-from-pairing-file` uses, and it coordinates with what it added (PHASE14 §4a) as that door does. Takes the line and a NAME — the preview filled the name box and somebody may have renamed the server before pressing; empty falls back to the name inside the code. Rejects by name on a line that will not parse. Answers the whole settings view, because a loopback code changes the slots. |
| `crucible:set-wsl-distro` | Which WSL guest that read looks in. Empty is a real answer and means unset; there is no default. |
| `crucible:set-new-jobs-wait-for` | `top` or `any` — what a new row's `waitFor` starts as. Answers with what was stored. |
| `crucible:install-plan` | Read the native installation plan and platform availability. Windows WSL migration belongs to the Crucible console. |
| `crucible:install` | Run the shared Crucible installer, verify readiness, register its published connection, and refresh capabilities. Installer progress goes to the requesting window. |
| `crucible:uninstall-availability` | May the Uninstall door be drawn at all — crucible `docs/INSTALL-UNINSTALL.md` §6.1, and Owen's ruling with it: **the door only for a server the app can prove is this machine's; never a registry entry.** A registry row says where a server is and what its token is, not whose machine it is on, and a loopback-looking address proves nothing (a tailnet, a port-forward or an SSH tunnel all put 127.0.0.1:7100 in front of somebody else's card). Answers what PROVED it (`pairing-file` / `windows-host` / `wsl-guest`) and, separately, what would RUN (`via`, §6.2's three lines) — two questions with different answers on one machine: Owen's PC is proved by its pairing file and run through the host pack. Also carries the registry name the proof named, or null, and whether `--wsl-too` may be offered (only the host drives the guest). Hosted: always false. A READ — a file test, and one `wsl.exe` call on the guest arm alone. |
| `crucible:uninstall-dry-run` | ({purgeWeights, wslToo}) → `CrucibleUninstallPlan` — `crucible uninstall --json --dry-run` (§6.2's verbatim argv). Touches nothing. Asked again whenever a checkbox moves, because the kept-models figure has to move and the dry run is the only thing that knows the new number. Exit **1 is still a plan** — `ok: false` names the one step that failed, the others happened, and a rejection there would tell somebody nothing happened when most of it did; exit **2 is `uninstall_not_available`**, an older Crucible that has no uninstall verb. |
| `crucible:uninstall` | ({purgeWeights, wslToo}) → `CrucibleUninstallRun` — the same flags, performed (§6.4 step 2): the same rows with `done` filling in. Then the one act that is Foundry's and not the verb's — §2's box, *"THE TOKEN ALWAYS GOES, on every uninstall"* — so a run that stopped the engine removes the registry row the proof named, through the registry's one writer, followed by `afterRegistryChanged`. `unregistered` names it or is null. The WRAPPER (`install.ps1 -Uninstall` / `install.sh --uninstall`) is never called from here: §6.2 — the verb is the machine-readable surface, and the door says in its own last line that the pack and the home stay, quoting the plan's `pack:server` / `pack:host` row. |
| `crucible:coordination` | Where coordination stands with every server it has anything to say about, keyed by registry name. A server absent from the map has not been asked yet. A read — it starts nothing. |
| `crucible:coordinate` | Coordinate with one named server NOW: read `/v1/info`, `/v1/catalog` and `/v1/capability`, compare the vendored module (whose `needs` are CLASSES the engine's capability record resolves, PHASE15-HOST.md §5.3a), and post a `module` task ONLY when something is missing — a class that engine has disabled is `unmet`, not missing, and posts nothing. Idempotent — a second call while one is in flight joins the first. It never rejects; every ending is a state. There is no button behind it, because coordination is automatic on every enabled server (§4a). |
| `crucible:engine-settings` | (serverName) → `SettingsDocument` — one server's OWN settings (`GET /v1/settings`, crucible docs/PHASE15-HOST.md §3.1): the route and model of each of the four llm classes, which of the three upstreams are configured, the desktop allowance and the backend kind. A REMOTE store — nothing in it is kept in `app-settings.json`. **No key comes back**: the document carries `keyHint`, the last four characters, where the engine carries a key. |
| `crucible:engine-settings-put` | (serverName, patch) → `SettingsDocument` — write through (`PUT /v1/settings`, §3.2). Any subset; `upstreams.<name>: null` REMOVES one. Answered with the whole document AFTER the write, so no window ever guesses what took. Rejects with a sentence naming the field for `route_not_routable` / `route_bad_model` / `route_upstream_unconfigured` / `upstream_in_use`. Runs the registry's own pass (`afterRegistryChanged`) when the patch touched a ROUTE — §2 recomputes capability on such a write and the dock's tiles are drawn from it — and not when it only saved a key, which moves no capability row. **The key crosses one way**, into main, out of a box somebody is typing in. |
| `crucible:engine-upstream-test` | (serverName, upstream, probe?) → `UpstreamTestResult` — `POST /v1/settings/upstreams/{name}/test`, the upstream's own model listing, unbilled. `probe` is an UNSAVED `{key}` or `{url}`; absent tests the configured one. This is the ONLY list of cloud model ids anywhere in this app — §2: *"the server does not ship a cloud model list"*, and a catalog compiled into a build is wrong by the next release. A failure is a RESULT carrying the engine's own sentence and its code (`upstream_unreachable` / `upstream_rejected` / `upstream_unconfigured`), not a rejection, so a card can print it beside the box. |
| `crucible:engine-capability` | (serverName) → `CapabilityRecord` — `GET /v1/capability` for one REGISTERED server, by name. The setup wizard's routes step reads it for the one thing `/v1/settings` does not carry: the server's own sentence about why a class will not run on its card (§5.2). It is `readCapability`, the dispatcher's own reader, exported rather than written twice. |
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

Eighteen, and every one of them is a state change the renderer holds a mirror of
or a question it has to answer. Twelve go to every window through `broadcast`
(`app/electron/window.ts`); the other six are sent to one window's `webContents`.
(It was nineteen until `ollama:progress` went with the model pull on 2026-09-15.)

(The head of this section said "Seventeen … Eleven … six", which does not add up
and did not match the table below it before `crucible:coordination-changed` was
added to either. The figures above were counted over the table and over
`broadcast(` in `app/electron/`, on the same rule the door count keeps: a figure
quoted as a gate is a measurement or it is decoration.)

| Channel | What it says |
| --- | --- |
| `acts:gates-changed` | Something that decides a tile moved — a server registered, enabled, renamed or removed, or the page reader installed or removed. (It also fired on a model pull until 2026-09-15, when Foundry stopped pulling models.) No payload: the renderer asks again on `acts:gates`, so the shape has one composer and no pushed copy to go stale. |
| `models:changed` | The weights on this disk moved without this window doing it — docs/SLOTS.md §5b's automatic removal, which fires from `crucible:save` and once at startup. No payload, for `acts:gates-changed`'s reason: the inventory costs a directory walk and has one composer. |
| `app:navigate` | Go to a route — File→Settings, and nothing else today. |
| `capture:intake-progress` | One dropped photograph copied, hashed and decoded — one push per path asked for, plus a closing one. |
| `crucible:install-line` | One installer output line, sent only to its requesting window. |
| `crucible:coordination-changed` | Where coordination with one server got to, every time it moves — checking, stocked, preparing (with the module task's own frames), waiting on a named holder, refused, unreachable. The three phases that compared carry `unmet`: the classes this engine does not serve, each with the capability row's own reason (PHASE15-HOST.md §5.3a). It CARRIES the state where `acts:gates-changed` carries nothing, because this is a small value the renderer mirrors rather than a composed answer that costs a probe: a payload-free push would make every window re-read the whole map on every byte of a download. Broadcast, because coordination starts at app start, before any window has asked anything. |
| `document:opened` | A document was admitted and should open in a tab. |
| `document:relocated` | An opened document moved onto the project's working copy; the tab follows. |
| `env:install-progress` | An environment install changed phase. |
| `host-ops:changed` | The host pushed what it is making in one project — the whole set, every time. |
| `host-ops:offers-changed` | The host revised what it OFFERS — the whole `{operations, nodeActions}` answer again, replacing what `host-ops:offers` said. |
| `host-ops:status-changed` | The host pushed what it is doing at all — the whole value, every time. Null clears the chrome's chip. |
| `menu:action` | A menu item the renderer has to carry out, because it acts on a tab. |
| `page-reader:progress` | One file of the page reader's install, phase by phase — the llama.cpp archive, the CUDA runtime beside it on Windows, and each GGUF. It was cut to the same five-phase shape as `ollama:progress`, deliberately, so the wizard could draw both with one bar; it is the half that survived, and the shape is kept as it is. |
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

## One held row released by name (2026-09-17)

| Channel | Request/result |
| --- | --- |
| `queue:release` | Job id → whether that row was released. Moves ONE held row to queued and pumps; `queue:start` releases the whole held batch and is the shelf's button. False covers released-already, started-already and removed-while-you-were-looking, which are one state to a caller. Hosted it forwards like Start and answers false. |

Added for the dialogs' own Start (Owen, 2026-09-17: *"the user can hit 'start', 'add to queue', or 'cancel'. if they hit start, progress shows in the modal live"*). A modal committing to its own run must not also let go of rows somebody parked deliberately, which is what routing it through `queue:start` would have done.

## Eight doors removed with the local page reader (2026-09-17)

`page-reader:state`, `page-reader:install`, `page-reader:install-cancel`,
`page-reader:start`, `page-reader:stop`, `page-reader:set-keep-warm`,
`models:inventory`, `models:remove-page-reader` — plus the `page-reader:progress`
and `page-reader:status-changed` pushes.

Owen, 2026-09-17: *"there sohuldnt be a local system. foundry does all ai work
through crucible."* Reading a page wants a GPU, so it belongs to an engine. The
six `page-reader:` doors drove a llama.cpp holding dots.ocr on this machine; the
two `models:` doors served the "Models on this machine" card, deleted as
unnecessary, and had no other caller. `electron/page-reader.ts` and
`electron/machine-models.ts` are deleted, and the first-run step that offered the
download went with them.

**147 → 139, measured by script, 139 distinct, zero `ipcMain.on`.** Removals only;
nothing was added or renamed in this pass.

## Which engine can do this act (2026-09-17)

| Channel | Request/result |
| --- | --- |
| `crucible:serves` | A model class → the first engine that serves it (`{server, route, selected, reason}`), or null. Reads the CACHED capability mirror the act gates decide on, loopback-ranked; it opens no socket, so a dialog may ask on every open. Distinct from `crucible:engine-capability`, which is a live read of ONE named server. |

Added so a run dialog can DEFAULT to an engine that can do the work, and so a
refusal can name the engine that can rather than telling somebody to go and
find it. Owen opened an OCR on an engine that cannot read pages and was told
*"crucible@example-mac-studio cannot read pages — choose another engine."*

**139 → 140, counted by script, 140 distinct, zero `ipcMain.on`.**

