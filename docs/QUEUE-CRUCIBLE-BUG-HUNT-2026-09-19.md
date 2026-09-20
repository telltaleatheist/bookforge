# Queue ↔ Crucible ↔ Foundry bug hunt — 2026-09-19

Owen's brief: *"things don't exactly work right"* around which Crucible server a
job goes to, when it may go there, and under what circumstances it can be chosen;
the queue page *"looks a bit ugly"* (Pending and the live queue do not read
visually, six red cancel buttons far from the book's name); the live queue wants
a Running / Paused state that accepts or refuses new entries; GPU jobs *"sit in
the GPU slot for another 10 minutes"* after the render finishes; and the Narrate
modal (Foundry → BookForge) wants its voice logic checked and the Device control
cut.

Method: a code read of the whole admission path (`shared/queue/wait-for.ts`,
`electron/queue-engine.ts` pump/settle/retry, `electron/queue-ipc.ts`,
`electron/crucible/{routing,servers,gpu-dial,generation-venue,step-venue,
text-venue,job,lease}.ts`), the Foundry host seam (`electron/foundry-host-queue.ts`,
`queue-steps/foundry-job.ts`), the render tail (`parallel-tts-bridge.ts`,
`coverage-align-job.ts`, `crucible/render.ts`, Crucible's `jobs/queue.py`), the
queue page and tray, and the Narrate modal. Nothing was run against the live
queue; Owen's dev app is up in this checkout and a gate build would race it.
Every finding below cites the code it was read from. Where I could not confirm a
runtime consequence I say "verify".

Severity: **HIGH** = wrong machine, wrong outcome, or a row that cannot be
rescued. **MED** = real but recoverable, or a window. **LOW** = wording, drift,
or a stall measured in seconds. **DESIGN** = not a defect; a decision for Owen.

---

## A. Routing — which server, when, and under what circumstances

### A1 · HIGH · A `409 server_busy` pins the book to the server that refused it

**Symptom.** Book set to *Any*; the top-ranked server is running somebody else's
job; a second server is idle. The book waits on the busy server for as long as
that job runs (hours), never tries the idle one, and its server picker is
read-only, saying *"was taken by a GPU on X"* — which is false, nothing was taken.
This is the same shape as the Sep 19 retry bug (`33fd16c7`), reached through a
different door.

**Cause.** `assignRunVenue` (queue-engine.ts) writes `job.waitForResolved` at
the instant the step launches, before the server has answered. The bridge
submits, the server answers 409, `noteStepBusy` records the hold, and
`settleStep`'s busy branch (queue-engine.ts, the block that begins *"A 409 IS A
WAIT, NOT A FAILURE"*) sets the step back to `queued` — and leaves
`waitForResolved` standing. `decideWaitFor` then takes rung 1 (*resolved wins*)
and calls `forOneServer(resolved)` forever. `releaseVenueIfNothingStands` — the
function `33fd16c7` added for exactly this — is called only from `retry()`.

**Fix.** In the busy branch, compute the hold sentence first, then call
`releaseVenueIfNothingStands(job)` (no step done, none running → release, and
clear `step.venue`). Because `busyHolds` is keyed by server, the next pass over
an *Any* row skips the busy one and takes the next enabled, ready server. A row
that NAMES the busy server still waits on it, which is the instruction.

**Trap for the fixer.** The 409'd attempt has already run prep and written
`settings.crucible.server = X` into the scratch session's `session_state.json`
(`decideGenerationVenue` writes it onto the live settings, which
`savePersistentState` persists). If the row then goes to Y, the post-render
alignment refuses by name — `crucible_align_venue_disagrees`
(coverage-align-job.ts, `readSessionRunVenue` vs the row). A session that rendered
zero sentences is not "started on a machine": either the bridge must not persist
the venue until the server admitted the job, or a zero-sentence session must be
discarded/re-stamped on the next launch. Pin both halves with a keeper:
two servers, row `any`, 409 on A → next pass launches on B → alignment on B
accepts.

**Keeper.** `tools/test-queue-wait-for.js` ("a busy server holds the row…")
asserts the hold but nothing asserts `waitForResolved` after it. Add the
two-server case.

### A2 · MED · Every busy retry is a full re-launch, and the first one runs prep before it learns "busy"

**Symptom.** Against a busy server the row flips `queued → running → queued` every
15 s (`admissionRecheckMs`), each cycle blanking its progress and writing a new
`startedAt`. Worse: `startParallelConversion` runs `decideGenerationVenue` →
`prepareSession` (the whole prep, minutes on a long book) → submit → 409. The
re-launch does not auto-resume — `tts-conversion.run` resumes only when
`wasInterrupted` (a restart) or when a scratch session has `completedSentences > 0`
— so a zero-sentence 409'd session is not matched and the next launch preps
again into a NEW scratch session (`prepareSession` mints `crypto.randomUUID()`
per call). Verify the scratch-dir accumulation on disk; the code path says it
happens.

**Cause.** The scheduler's only knowledge of "busy" arrives AFTER a submit.
`serverState` is fed by `reachCache` (a `/v1/ping`) and `busyHolds` (a 409
already received). Crucible publishes the holder on `GET /v1/activity`
(`jobs/queue.py: busy_details`), and nothing here reads it before launching.

**Fix.** Make `CrucibleRoutingHost.reach()` return
`{ reachable, busy?: line }` by reading `/v1/activity` (or the SDK's equivalent)
alongside the ping, and let `serverState` surface `busy` from it. Then
`decideWaitFor` holds an *Any* row past a busy server and parks a named one with
`holdBusy` WITHOUT launching. Keep the 409 path as the backstop it is. The busy
hold's TTL can then follow the reach TTL rather than a blind 15 s.

### A3 · MED · Adding, removing or re-ranking a server does not reach the scheduler for up to 10 s

**Symptom.** Remove a server; within the next 10 s admission can still place an
*Any* row on it, the submit fails against a missing registry entry, and the row
FAILS (an error, not a hold). Add a server; the bench and admission do not see
it for up to 10 s.

**Cause.** `queue-ipc.ts` memoises the routing view for `ROUTING_CACHE_MS = 10_000`
and drops the memo only on `onCrucibleRecordChanged`. Only
`routing.setServerEnabled` calls `announceCrucibleRecordChanged()`.
`servers.addServer`, `servers.removeServer` (which does call
`forgetResolvedEngine`/`forgetCrucibleRoutes`) and `routing.setRoutingOrder` do
not. The main.ts handlers for `crucible:add-server` / `crucible:remove` refresh
the HOSTED Foundry registry snapshot but not this memo.

**Fix.** Announce from every registry and rank write (the memo is invalidated
where it lives, exactly the argument `33fd16c7` made for the enable switch). Or
delete the memo: two small synchronous file reads per pump are not worth a
staleness window on the list that says which machines exist.

### A4 · MED · The GPU dial is dead UI with live scheduler semantics

**Symptom.** None today on this machine (no `queue-gpu-dial.json` exists). But
the engine still enforces the dial on every pass (`decideWaitFor` rungs 3–4), the
IPC `jobs:set-gpu-dial` still turns it, `gpu-dial.ts` still persists it, and the
queue page has NO control that calls `chooseGpuDial` — the template's own comment
says the per-slot switches replaced it (Owen, 2026-09-15: *"instead of having a
dropdown that chooses whether to have 'any' or the given crucible servers, lets
have a big checkbox above each gpu slot"*). A dial file left by an earlier build,
or written by the CLI, silently steers every *Any* book to one server and parks
every named book with a sentence telling the operator to *"turn the queue's GPU
dial"* — a control that is not on the page.

**Fix (recommended).** Remove the dial: `electron/crucible/gpu-dial.ts`, the
`dial` fact and rungs 3–4 in `shared/queue/wait-for.ts`, `CrucibleRoutingHost.dial`,
`jobs:set-gpu-dial`, `QueueSnapshot.gpuDial`, `chooseGpuDial`/`setGpuDial` in
the renderer, `tools/test-queue-gpu-dial.js`, and the dial rows of
`docs/PENDING-QUEUE-AND-GPU-DIAL.md`. The per-slot enable switch + the per-book
picker are the two controls that survive, and `decideWaitFor` keeps rungs 1, 2
and 5. Alternative: put the control back. Either way the current state — a
scheduler input with no owner on screen — has to go.

### A5 · MED · Most step modules FAIL a row on a leased or busy card instead of parking it

**Symptom.** A translation, book analysis, RVC pass, denoise pass or VLM read
that meets `409 leased` / `server_busy` ends as a FAILED row in *Needs you*,
waiting for a Retry press. Only the narration (bridge → `noteStepBusy`),
`pass.ts`, `align.ts` and `generate-sentences.ts` park with the holder's line.

**Cause.** `noteStepBusy` must be called by the module before it throws.
`translation.ts` ignores `result.busyLine` (which `mono-translation-job.ts`
returns). `book-analysis.ts` throws `result.error` while `ai-bridge.ts` returns
`busyLine: err.leasedLine`. `rvc-enhancement.ts` / `final-denoise.ts` receive a
plain `error` string because `rvc-job.ts` / `denoise-job.ts` catch the
`CrucibleJobRefused` and stringify it. `vlm-convert.ts` lets `pages.ts`'s
`leasedLine` refusal propagate as an error.

**Fix.** One road: extend `StepOutcome` with `busyLine?: string`, let
`settleStep` read it (it already reads `live.busyLine`), and have every module
return the refusal's `busyLine` instead of each one remembering `noteStepBusy`.
Delete the four per-module calls once the seam carries it. Keeper: one per
module, driven by a fake that answers `409 leased`.

### A6 · LOW · A resolved row's hold names a control that refuses

`forOneServer(resolved, facts, 'row')` ends its sentence with *"…or set this book
to Any"*, but `setWaitFor` refuses every edit to a resolved row
(`venue_fixed_at_admission`). Add a third `VenueSource`, `'resolved'`, whose way
out is *"Cancel this book to send it back to Pending"* — the one act that works.

### A7 · LOW · An *Any* row stalls on the first unknown server even when a later one is ready

`decideWaitFor`'s rung-5 loop returns `ask` at the FIRST server whose state is
`unknown`, before looking at the rest. Each `reachTtlMs` (15 s) the top server
falls back to `unknown` and an *Any* row arriving in that window waits one round
trip (or one connect timeout, if that machine is asleep) instead of taking a
`ready` server further down. Finish the loop; return `ask` only when no server
answered `ready`.

### A8 · DESIGN · Three deciders, two rule sets

`decideWaitFor` (queue: enable, slot, busy, dial) is the one place routing is
supposed to be decided — yet `generation-venue.decideWhereGenerationRuns` and
`text-venue.decideWhereTextActRuns` are two identical copies of a different rule
(`top-ranked` = the top enabled name with no reachability check; `any` = first
ping). They serve Listen, the CLI and any unassigned step. With
`newJobsWaitFor: "top-ranked"` (this machine's setting), **Listen fails by name
when the rank-1 server is asleep although rank-2 is awake.** Collapse the two
copies into one module; decide whether Listen should honour rank as an
instruction (current) or take the first reachable server (what a person pressing
Play expects).

### A9 · LOW · "On this machine" is decided by loopback URL alone

`servers.serversOnThisMachine()` matches `isLoopbackUrl`. A Crucible on THIS
machine registered by hostname (the way the PC entry is spelled here) is treated
as remote: the one-card interlock between the in-app long-form aligner and that
Crucible does not apply, and `acquireGpuForJob` takes no local GPU lock and
evicts no Ollama model for it. The docs say this goes away with §B7; until then,
compare the server's `/v1/info` identity to the discovered pairing file rather
than the URL shape.

### A10 · LOW · Doc drift on which Foundry jobs stage

`docs/PENDING-QUEUE-AND-GPU-DIAL.md` says a Foundry `read` does not travel and
goes straight to the live queue. `queue-steps/foundry-job.ts` `resourceFor` maps
`read` to `gpu`, `machines()` therefore answers `'any'`, and `pages.ts` sends the
read to a Crucible (`1e6cb1fb`). Reads stage in Pending today. Update the table.

---

## B. The GPU slot held after the render (Owen's "another 10 minutes")

### B1 · MED · The slot is held through the post-render alignment, and the page barely says so

**What happens.** The narration step keeps its GPU slot until the bridge fires
`TTS_GPU_PHASE_OVER` (`announceGpuPhaseOver`). In the queue path
(`skipAssembly: true`) that fires after `runPostRenderAlignment` — the qwen3
coverage alignment, submitted as a Crucible `align` job to the SAME server
(`coverage-align-job.ts` → `runCoverageAlignOnCrucible`). On a long book that is
the 10–20 minutes Owen sees. Crucible's own lane is free the moment the render
job ends (`jobs/queue.py: _execute → _settle → _finish`; artifacts are streamed
during the job, not after), so what holds the slot is BookForge's own tail, not
a download.

It is honest GPU work — the aligner is on the card — but it is invisible: the
lane card still reads as the narration at 100 %, and the only sign is a stage row
("Aligning transcript (qwen3)") under it.

**Also.** In the inline-assembly path (`skipAssembly: false`) the announce fires
later still — after `cacheSessionToProject` (a whole-session copy, disk I/O) and
after RVC — so a GPU slot is held during a file copy.

**Fix (recommended).** Make the post-render alignment its own queue step: the
`align` step module already exists (`queue-steps/align.ts`), it already follows
the run's venue (`runVenueOfRow`) and already parks on busy. The narration step
then ends when the render ends, the bench shows *"Aligning · Book"* as its own
occupant with its own Stop, and the slot bookkeeping needs no special hand-over.
Minimum fix: fire `announceGpuPhaseOver` before `cacheSessionToProject` on the
inline path, and change the lane's verb to *Aligning* while that stage runs.

### B2 · MED · Alignment is skipped on machines without a LOCAL qwen env although it runs on Crucible

`runPostRenderAlignment` gates on `resolveQwenAlignEnv()` (*"Chunk alignment
skipped — no aligner env"*) — the local conda prefix — while the alignment itself
is dispatched to a Crucible server. A machine with no local `qwen-align` env
ships an unaligned transcript with a WARN in the log, even though the server it
just rendered on would have aligned it. `coverageAlignPython()` — the only
thing in `coverage-align-job.ts` that reads that env — is exported and has NO
callers anywhere in `electron/`, so the Crucible route never uses the local
python. The gate is dead and wrong: drop it (and the function).

---

## C. The Foundry seam

The seam itself read clean: a press in the hosted window mints a row here,
stages when the act travels (`jobIsStageable`), chained requests append onto the
followed row's run, dedupe is by product, and there is no lease on Foundry rows
(so no self-deadlock). Two things to fix, one to verify:

### C1 · MED · Server list handed to the hosted window lags the routing memo (see A3)

`foundry-job.run` refuses by name (`hostedCrucibleServerNotOffered`) when the
venue the QUEUE chose is not in `hostCrucibleServers()` or is disabled there. The
host snapshot is refreshed on add/remove/enable; the queue's routing memo is not
refreshed on add/remove. For ~10 s after a change the two lists can disagree and
the row fails instead of holding. A3's fix closes this.

### C2 · LOW · `read` rows share the run's venue with a later `clean`

A read that travels is assigned a server at launch; a `clean` chained under it
follows the run (`runVenueOfRow(ctx.job.waitForResolved)`), so an OCR read on the
Mac pins the clean-up to the Mac even if the PC would serve the model better.
That is §4.4 working as written; note it because Owen may want text acts to
re-decide.

### C3 · VERIFY · Narrate-from-Foundry refusals

`foundry-narrate-target.ts` throws by name (no export, ambiguous exports, a step
that made no file). Confirm those sentences reach the user as a toast or in the
modal rather than only the main log — I did not trace the renderer side of the
`onFoundryNarrate` channel past `narrationDialog.open`.

---

## D. The Narrate modal

### D1 · Cut the Device control (Owen's ruling, today)

Evidence it is wrong, not just redundant:

- `crucible/render.ts` never reads `settings.device` (0 references). The server
  decides its own device.
- `parallel-tts-bridge.ts` still runs `resolveTtsDeviceArg(settings.device)` +
  `assertDeviceUsable` for every render, including Crucible renders. Choosing
  *GPU* on a machine without the local CUDA pack REFUSES a render that would run
  on a CUDA server elsewhere. *Auto* resolves from THIS machine's hardware for a
  render happening on another.
- The only downstream consumer is narrator's `prep --device`, whose help text
  says *"reported in the log only"*.

Removal footprint: modal `devices` / `device` signal / template block; pipeline
defaults `ttsDevice` (`settings.service.ts`, the Settings page that edits it);
`shared/queue/narration-run.ts` `device` (two settings shapes + the step config);
`queue-steps/tts-conversion.ts` `TtsConfig.device`; the bridge's
`resolveTtsDeviceArg` / `assertDeviceUsable` / `--device` prep flag (drop, or pass
a constant); `job-details` and `analytics-panel` readouts; the CLI: audit `--device` in
`cli/bookforge-tts.py` — the epub-align door's flag (line ~3321) is legitimate and
stays; if the `--tts` door forwards one (line ~1310), remove it from `COMMAND_FLAGS`
and the help keeper (`test-cli-flags`). Persisted rows carrying `device` must still load — read and
ignore, never fail a restored queue on it.

### D2 · MED · The dropdown and the validator read two different voice lists

`voiceOptions` draws the servers' picker (`voicePicker().sections`) when it
answered; `stageRefusal` and `dropVoiceUnlessItBelongs` validate against the
flat LOCAL catalog (`voices.voicesFor(engine)`). A voice a server serves but the
local catalog does not list is offered and then refused (*"is not a Higgs voice
on this machine"*); a voice the picker marks unavailable is checked against the
catalog's `unavailable` instead of the picker's sentence. One source: when the
picker is present, validate against it.

### D3 · MED · Engines are offered by LOCAL install, not by what the servers serve

`engines = selectableEngines(isInstalled)`: Orpheus appears only if the
`orpheus` component is installed on THIS machine; Higgs (`requiresComponent:
null`) always appears. Rendering is on Crucible, so the honest list is the
engines the enabled servers serve (`voice-inventory.ts` already asks each server
what it has). Same shape as D1: BookForge deciding from its own disk about
another machine's card.

### D4 · LOW · Legacy copy on the Reading tab

*"Workers: More workers render faster on CPU. A GPU run uses one"* — the width
is the server's (`MLX_RENDER_WIDTH`, `HIGGS_MAX_NUM_SEQS`), not a slider here.
Hide the slider for Crucible renders or drop it with D1.

### D5 · LOW · Stale picker while the modal is open

`loadVoicePicker()` runs once at open; a server that wakes while the modal is up
stays in `voiceServersMissing` until reopen. Acceptable, but say "as of <time> ·
Re-check" beside the warning so the person knows it is a snapshot.

---

## E. The queue page — what reads wrong and a concrete proposal

What is on the page now (`queue.component.ts` template): **Needs you** (failed
steps, Retry / Remove), **On the bench** (per-server slot cards with the enable
switch above each — Owen likes these; keep), **Pending** (staged books: title,
native `<select>` server picker, ▶ Send to queue, ✕ Discard, then the chain of
steps each with a grey "Pending — not sent" sentence), **Up next** (live rows:
title, picker or *"Runs on X"*, ▶ Start this book, ✕ Cancel this book, 🗑 Delete,
then a chain row per step each carrying its own ✕ Cancel / ■ Stop / ▶ Start
button on the far right), **Finished today** (a table).

Why it reads as *"six red cancel buttons on the other side of the screen"*: every
card is one row of `card-head` with `.acts { margin-left: auto }`, so the book's
name is flush left and its three action buttons are flush right across the full
page width; then each step under it repeats a red ✕ at the far right. A book with
four steps shows five red buttons in a vertical stripe at the right edge, none of
them near the thing they act on. Two of them (*Cancel this book*, *Delete*) are
both red and both start with a glyph, so they read as one control twice.

### E1 · The Running / Paused state (Owen's ask)

The engine already has the state: `running` is *"the whole queue's dial"*; while
it is false nothing is admitted, and Send to queue still works (the row lands
`queued` and waits). What is missing is the WORD on the page — the toolbar has
*Pause after current* / *Resume queue* buttons but the Up next band never says
which state it is in. Proposal: the Up next band header carries a two-state
segmented control — **Running** (steps start as slots free) / **Paused** (rows
may be added and reordered, nothing starts) — bound to `tray.isRunning()` and
`pause()` / `start()`. *Halt processing* stays in the toolbar as the destructive
sibling. If Owen's intent is stricter — *Paused refuses Send to queue* — that is
a one-line refusal in `sendToQueue` (`queue_paused`) and the Pending band's Send
button greys with a title saying so; I recommend the softer reading (add while
paused, start on Resume) because it matches *"if I add something and it isn't
already moving, don't start it until I hit start"* (2026-08-23).

### E2 · Layout — two columns, actions beside the name

For **Pending** and **Up next** cards, replace the single full-width `card-head`
row with a two-column card:

```
┌──────────────────────────────────────────┬─────────────────────────────┐
│ [cover] Title                             │ Run on  [ crucible@mac  ▾ ] │
│         3 steps · Narrate → Enhance → M4B │ [▶ Send to queue] [Discard] │
├──────────────────────────────────────────┴─────────────────────────────┤
│ ● Narrate            Pending — not sent to the queue yet                │
│ ○ Enhance (RVC)      follows Narrate                                    │
│ ○ Assemble M4B       follows Enhance                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

- Left column (fluid): cover, title, one-line summary. Right column (fixed,
  ~300 px): the server picker on its own line, then the book-level actions.
  The actions sit inside the same card column as the picker, a hand's width from
  the title instead of a screen's.
- **One destructive control per card**, and it is not red by default: a quiet
  `⋯` / overflow or a plain *Remove* text button; red is reserved for the
  confirmed act. *Cancel this book* (→ Pending) and *Delete* become one menu with
  two entries whose labels say what each keeps.
- **Per-step controls appear on hover / focus only**, and only the one that
  applies (■ Stop for running, ✕ for waiting). The default state of a chain row is
  dot · name · reason · percent, no buttons. That alone removes four of the six
  red buttons.
- **Pending steps do not need a reason sentence each**: *"Pending — not sent to
  the queue yet"* repeated four times says nothing the band header did not. Show
  the chain as a compact arrow line (*Narrate → Enhance → Assemble*) in the
  summary and expand on click.
- The server picker becomes `desktop-select` (house rule: never a native
  `<select>`). Disabled servers listed greyed with *"(off)"*; *Any* labelled as
  today.
- **Up next** rows that are assigned show *"Runs on X"* as a chip in the same
  slot the picker occupied, so the eye finds the machine in one place whether
  the book is chosen or fixed.

### E3 · Pending vs Up next as one flow

They are the same card in two states; make that visible: same card component,
same column widths, Pending cards with a dashed border and a *Staged* tag, Up
next cards solid. The drag grip appears only in Up next. Consider the band
headers reading as a two-step strip: **Pending (2) → Up next (4)** so a person
reads down the page in the order the work moves (which the template comment
already intends).

### E4 · Small things

- `.acts` buttons wrap badly at narrow widths (three buttons + a select in one
  flex row); the two-column layout fixes that.
- Finished today's *Clear finished* lives inside the note span next to *"N
  failed"* — move it to the band's right edge as a proper button.
- The empty state copy is good; keep.

---

## F. Work packets — for the Opus subagents (max 5 at once)

Each packet is independent unless noted. Every packet ends with `npx tsc -p
tsconfig.electron.json`, the named keepers, and `ng build` (the renderer gate;
`tsc -p tsconfig.json` compiles nothing — see memory). No builds in Owen's
checkout while `electron:dev` is up: use a worktree.

| # | Packet | Findings | Files | Keeper(s) |
|---|--------|----------|-------|-----------|
| P1 | **Busy does not pin** | A1, A2, A6, A7 | `queue-engine.ts` (settle busy branch, `crucibleAdmission`/`reach`), `shared/queue/wait-for.ts`, `queue-ipc.ts` (`reach` reads activity), `parallel-tts-bridge.ts` (do not persist `settings.crucible` before admission, or discard a 0-sentence session), `coverage-align-job.ts` | `test-queue-wait-for.js` (+ two-server 409 case), `test-queue-engine.js`, `test-crucible-render.js` |
| P2 | **Record changes reach the scheduler** | A3, C1 | `crucible/servers.ts`, `crucible/routing.ts` (`setRoutingOrder`), `queue-ipc.ts` (drop or invalidate memo) | `test-queue-routing-freshness.js` (+ add/remove cases), `test-crucible-servers.js` |
| P3 | **Remove the GPU dial** (after Owen confirms) | A4 | `crucible/gpu-dial.ts` (delete), `wait-for.ts` rungs 3–4, `queue-engine.ts` host + snapshot, `queue-ipc.ts`, `queue.service.ts`, `queue-tray.service.ts`, `queue.component.ts`, `tools/test-queue-gpu-dial.js` (delete), `docs/PENDING-QUEUE-AND-GPU-DIAL.md`, CLI if it exposes it | all `test-queue-*.js` |
| P4 | **Every module parks on a leased card** | A5 | `queue-steps/runtime.ts` or `engine-types.ts` (`StepOutcome.busyLine`), `queue-engine.ts` `settleStep`, `translation.ts`, `book-analysis.ts`, `rvc-enhancement.ts`, `final-denoise.ts`, `vlm-convert.ts`, `rvc-job.ts`, `denoise-job.ts`; delete the four per-module `noteStepBusy` calls once the seam carries it | `test-queue-pass-travel.js`, one fake-409 case per module |
| P5 | **Alignment is its own step; slot hand-over honest** | B1, B2 | `shared/queue/narration-run.ts` (plan an `align` step after `tts-conversion`), `parallel-tts-bridge.ts` (remove inline `runPostRenderAlignment` from the queue path; announce before `cacheSessionToProject` on the inline path), `queue-steps/align.ts`, `coverage-align-job.ts` (drop the local-env gate if the Crucible route does not need it), bench verb | `test-queue-engine.js` (slot hand-over), `test-crucible-align.js`, narrator align keeper |
| P6 | **Narrate modal: device gone, one voice source, engines from servers** | D1–D4 | `narration-modal.component.ts`, `settings.service.ts` + Pipeline Defaults page, `shared/queue/narration-run.ts`, `queue-steps/tts-conversion.ts`, `parallel-tts-bridge.ts` (device arg), `job-details`, `analytics-panel`, `cli/bookforge-tts.py` + `COMMAND_FLAGS`, `narration-voices.service.ts`, `tts-engine-registry.ts` | `test-cli-flags`, a modal spec for D2 (voice offered ⇒ voice accepted), `ng build` |
| P7 | **Queue page redesign** | E1–E4 | `queue.component.ts` (template + styles), `queue-tray.service.ts` (Running/Paused state), `desktop-select` for the picker, `queue-engine.ts` only if Paused is to refuse Send | `test-queue-bench.js`, `ng build`, screenshots in the running app |
| P8 | **Docs + small drift** | A8 (decide), A9, A10, C2, D5 | `docs/PENDING-QUEUE-AND-GPU-DIAL.md`, `crucible/generation-venue.ts` + `text-venue.ts` (one module), `servers.ts` | existing keepers |

Order: P1 and P2 first (they are the *"which server, when"* complaints and are
small); P4 and P5 next; P3 after Owen's yes; P6 and P7 are UI and can run
alongside anything. P8 last.

## G. Owen's rulings (2026-09-19, evening) and what is still open

Ruled, verbatim where it matters:

- **A1 / A2 — do not launch at a busy server.** *"I don't think it should move
  out of the queue and into a slot until it's available… the book would just sit
  there in the queue until it's free, maybe retrying every so often… as long as
  the queue is running/unpaused. If the queue isn't active then it just sits in
  the active queue doing nothing."* And: *"poll the server to see if it's
  available. If it isn't, it just waits in the queue until it's available. It
  reserves the lease, THEN it takes the slot and starts real work."*
  → Admission becomes: poll activity (on the existing reach sweep) → the row
  waits with the holder's line and progress while busy → reserve the row lease →
  take the slot → launch. The 409 path stays as the backstop and RELEASES the
  venue (A1's fix) when it fires.
- **A3 — instant.** *"It can be a BookForge and Foundry-side change instantly.
  Nothing gets sent to the other server from the queue."* → Drop the routing memo
  (or announce on every registry/rank write); refresh the hosted Foundry snapshot
  in the same breath.
- **A4 — remove the GPU dial.** *"That works for me."*
- **A5 — every module parks on a leased card.** *"Let's fix that."*
- **B1 — alignment is its own queue step**, and *"as soon as the GPU finishes, it
  releases the lease"* — the narration step ends when the render ends and hands
  back its slot and its lease; Align takes its own.
- **E1 — Paused accepts rows and starts nothing** (from the A1 ruling: a book
  added while the queue is paused sits in the live queue until Resume). Send to
  queue is NOT refused while paused.

Ruled 2026-09-19, later the same evening:

1. **Prepare is its own CPU step**, and it starts *"the moment a free CPU slot is
   open and an item enters the active (and unpaused) queue"* — it does not wait
   for a server. The lease and the GPU slot are asked for only when the chunks
   exist.
2. **Lease carry-over is feed-forward.** *"If the next step is guaranteed to use
   the currently loaded model, we can leave it loaded"* — otherwise release at
   the step's end. That is what `leaseWantedAfter` already compares; keep it,
   make sure every GPU step's settle asks it, and a render step (Narrate) always
   releases because Align loads a different model.
3. **A failed Align step STOPS the book** (Needs you, assembly held behind it).
   *"But we need to fix it so it doesn't fail. It should only fail because of a
   misconfiguration, which can be repaired."* → B2's stale local-env gate goes;
   every remaining failure names the misconfiguration.
4. **Listen and "next available".** WSL is preferred but often streaming; *"it
   should never take next available unless the user is aware of which ones are
   enabled… the user just needs control over which one is used and when, but
   should be able to feed into the next available at will."* → The enable
   switches ARE that awareness. Listen takes the first REACHABLE server among the
   ENABLED ones, in rank order — never a disabled one. Queue rows keep the
   per-book picker (a named server, or Any = next available among enabled).
5. **Chaining.** Try to make chaining available all the way from OCR to narrate,
   but *"some things likely won't be chained; it'll probably be manually
   driven"* — the book has to be opened and curated after OCR. C2 stays as it is
   (a chained act follows its run's server); no code change now.
6. **Busy polling** rides the 15 s reach sweep; the row shows the holder's line
   and progress. No ETA scheduling.

### Packet changes from the rulings

- **P1** grows: admission reads `/v1/activity` through `reach()`; the lease is
  reserved by the scheduler BEFORE launch (an async admission phase — the pump
  stays synchronous and hands a `reserve` verdict to a follow-up that launches on
  success or writes the hold and releases on failure); local gates (arbiter, lock
  file, one-card rule) are asked before reserving so a reserved lease is never
  wasted on a row a local gate stops. The venue is written when the LEASE is
  held, which is the moment the card is actually taken.
- **P5** grows: `narration-run.ts` plans `prepare → tts-conversion → align → …`
  if decision 1 is yes; the bridge's inline `runPostRenderAlignment` and the
  `TTS_GPU_PHASE_OVER` hand-over go for queue rows (the step boundary is the
  hand-over); `settleStep` closes the row lease at the end of every GPU render
  step; old rows without an Align step keep inline alignment until they finish.
- **P3** is confirmed: delete the dial.
- **P7** takes E1 as "Paused accepts rows"; no engine change for Send to queue.

---

## H. Landed 2026-09-19 (night) — and what the fixes left owed

All eight packets are on `main` (merged through `integration/queue-hunt`).
Electron compile, the touched keepers, `ng build`, the hosted-Foundry seam and
the quire suites are green; the nine failing keeper suites are the known
environmental ones (Windows path converters on darwin, `extension/node_modules`,
the foundry dev binary present where a refusal is expected, one darwin
path-shape check in `test-crucible-render-session`).

What the fixers found on the way, and what is still owed:

- **A render has no lease to reserve.** Narration takes a job on the lane, not a
  lease, so for Narrate the admission is poll → slot and the `409` is still the
  door (which now releases the venue). Text acts reserve first as ruled.
- **`/v1/activity` arrived in Crucible 0.5.0.** An older server answers 404; the
  poll returns null, the row is admitted and the 409 backstop takes over — logged
  once per machine per app run.
- ~~**Prepare packs to a SERVER's voice band** (`max_chars`, pace) and refuses by
  name when no enabled server states one … with every server off or asleep,
  Prepare FAILS rather than parks. Owen may want it to hold.~~ **DONE, same
  night.** It parks. `electron/crucible/prep-band.ts` owns the line between the
  two answers: not one enabled server answered, every server switched off, or
  the chosen one stopped answering, are AVAILABILITY and the row waits with a
  sentence naming every machine that was asked, what each said, and every
  machine whose switch is off. No server registered at all, a voice the servers
  answered and do not serve, an unmapped voice, a row with no cap or no pace —
  those FAIL by name. The question is also asked FIRST now, before the narration
  copy is cut, so a parked pass costs one ping sweep instead of a copy and a
  scratch sweep. Keeper: `tools/test-queue-narration-plan.js` §7.
- ~~**A Prepare row cannot be cancelled** — `prepareSession` registers no handle;
  `prepare.cancel()` is deliberately empty and says so.~~ **DONE, same night.**
  `electron/prep-handles.ts` is the registry the render's `crucibleCancel`
  already had: keyed by the step's job id, it holds how to kill the spawn (a
  process tree here, a guest process and its wsl.exe wrapper over there) and the
  scratch session being written. A stop kills the spawn, WAITS for it, then
  removes the session — a half-written `session-state.json` is exactly what a
  resume and the clean-session sweep read a session back from — and names the
  directory in the log if it cannot. `stopParallelConversion` asks it first, so
  an INLINE prep (the CLI, the language-learning chain, a restored row) is
  stoppable too. Keeper: `tools/test-queue-narration-plan.js` §6.

Two things the park found on the way, neither patched (the engine is owned
elsewhere this week):

- **A parked CPU step has NO cool-off in the engine.** `settleStep` puts it back
  to `queued` and calls `pump()`; the pump's CPU branch asks nothing about
  admission (`busyHolds` is read by `decideWaitFor`, which is asked only for a
  travelling step, and `admissionBlocked`/`admissionRecheckTimer` are armed only
  there). So a parked prepare row relaunches on the very next turn — and a park
  that costs nothing would spin the main process flat out. The cadence therefore
  lives in the module (`queue-steps/prepare.ts`, `PARK_RECHECK_MS`, 15 s), and
  the row holds its `local-work` slot while it waits.
- **The park sentence does not survive the relaunch**, and for the same reason:
  `launch` resets `step.progress` to `{ percent: 0 }`. `progress.admissionHold`
  is a state the queue passes THROUGH for a CPU row rather than one it rests in,
  so the module keeps the line and reports it while it waits.
- **Every park records a server-wide busy hold**, including a CPU row's:
  `settleStep` answers every park with `holdServerBusy(job, line)`, keyed by the
  ROW's server. A prepare park is not about a card being held at all, so a named
  row's park marks that machine busy for 15 s for every other book bound for it,
  quoting a sentence about a chunk band. Harmless in practice today (if nothing
  states the band, nothing is reachable either), wrong in principle.
- **`TTS_GPU_PHASE_OVER` stayed.** `cacheSessionToProject` measured 458 s on
  *Letter to the American Church*, all after the card went quiet, so the render
  step hands its slot back the moment the last chunk lands and caches on the CPU
  pool.
- **Latent, pre-existing:** `rowLeaseStillWanted` compares `leasedModel(config)`
  to the held subject and every module answers `null` since phase 15 — so
  `pause()` closes the row lease of a step that is still running. Same before and
  after; worth its own fix.
- `busyLineOf`'s docstring says `CrucibleLeased` carries `busyLine`; it carries
  `leasedLine` (the reserve path translates it; other readers should not trust the
  docstring).
- **Running / Paused** lives on the Up next band header, so it is absent on an
  empty queue; a toolbar twin if Owen wants to pre-arm Paused.
- `cli/coverage-align.js` passes `device: 'cpu'`, which the Crucible align route
  refuses by name — pre-existing, a different door.
- `src/app/features/studio/models/tts.types.ts` `TTSSettings.device` is a dead
  type (no readers since 2026-09-14); the manifest's `TTSSettings.device` stays
  because records must keep parsing.
- The CLI `--tts` door keeps inline prep and aligns nothing; `cli/README.md` says
  so beside the queue's three-row shape.
- Owen's running `electron:dev` needs a restart to take the main-process changes;
  the renderer reloads on its own.
