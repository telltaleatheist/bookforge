# Pending, and where a book runs — Owen's rulings, 2026-09-15 → 2026-09-19

> **The "GPU dial" in this file's name is historical.** The dial was removed on
> 2026-09-19 (Owen: *"that works for me"*) and the per-slot enable switches replaced
> it. The filename is kept because ~30 code comments and keepers cite it by name;
> renaming it is a rename of all of them, not of one file.

A book is staged before it runs, and which machine it runs on is chosen while it is
staged. Two controls decide that, and only two:

- **The per-book server picker** — a named Crucible server, or **Any**, which means
  *the next available among the ENABLED servers*.
- **The per-server enable switch**, one above each slot card on the bench. A server
  that is switched off is never chosen, never probed, and never a candidate for
  *Any*.

Owen, **2026-09-15**: *"instead of having a dropdown that chooses whether to have
'any' or the given crucible servers, lets have a big checkbox above each gpu slot."*
That is the switch, and it is the whole of the awareness the *Any* answer depends on
(see **Where unassigned work goes**, below).

## The shape

1. **Adding a book puts it in PENDING, not in the live queue.** Nothing about a
   pending item is committed.
2. **In Pending you choose its server** — a named Crucible server, or *Any*.
3. **"Send to queue"** moves it into the live queue.
4. There is no fourth control. The queue-wide GPU dial that used to sit here is
   **deleted**: `electron/crucible/gpu-dial.ts`, the `dial` fact and its rungs in
   `shared/queue/wait-for.ts`, `jobs:set-gpu-dial`, `QueueSnapshot.gpuDial` and the
   renderer's `chooseGpuDial` all went on 2026-09-19. It had been a scheduler input
   with **no control on screen** since the enable switches landed — a file left by an
   earlier build, or written by the CLI, silently steered every *Any* book to one
   server and parked every named book with a sentence telling the operator to turn a
   dial that was not on the page.

## Running and Paused — a paused queue ACCEPTS rows

Owen, **2026-09-19**: a book added while the queue is paused *"just sits in the active
queue doing nothing"* until Resume. So:

- **Send to queue is never refused because the queue is paused.** The row lands in
  the live queue, `queued`, and waits.
- **Nothing is admitted while paused.** No slot is taken, no lease is reserved, no
  server is asked.
- Resume starts the rows in order. The Up next band says which state it is in;
  *Halt processing* remains the destructive sibling in the toolbar.

This matches the older ruling it follows from (2026-08-23): *"if I add something and
it isn't already moving, don't start it until I hit start."*

## Admission — the row does not take a slot until the server is free

Owen, **2026-09-19**: *"I don't think it should move out of the queue and into a slot
until it's available… the book would just sit there in the queue until it's free,
maybe retrying every so often… as long as the queue is running/unpaused."* And:
*"poll the server to see if it's available. If it isn't, it just waits in the queue
until it's available. It reserves the lease, THEN it takes the slot and starts real
work."*

The order, and nothing may be reordered inside it:

1. **Poll the server's activity** on the existing 15 s reach sweep. Crucible publishes
   the holder on `GET /v1/activity`; a busy server is known BEFORE anything is
   submitted, not from a `409` after a full prep.
2. **A busy server holds the row in the live queue**, showing the holder's line and
   progress. An *Any* row skips it and looks at the next enabled server; a row that
   NAMES it waits for it, which is the instruction. No ETA scheduling.
3. **Reserve the row's lease.** Local gates (the GPU arbiter, the lock file, the
   one-card rule) are asked BEFORE the reservation, so a reserved lease is never
   wasted on a row a local gate stops.
4. **Take the slot, then launch.** The venue is written onto the row when the LEASE
   is held — the moment the card is actually taken — never at the instant a step
   launches.

The `409 server_busy` path stays as the backstop it is, and when it fires it
**releases the venue** (`releaseVenueIfNothingStands`), so the next pass over an *Any*
row is free to take a different machine. A 409 that left the venue standing was the
bug that pinned a book to the server that had refused it.

**Prepare is its own CPU step** (Owen, 2026-09-19): it starts *"the moment a free CPU
slot is open and an item enters the active (and unpaused) queue"* — it does not wait
for a server. The lease and the GPU slot are asked for only once the chunks exist.

**A render step releases its lease when the render ends.** Owen: *"as soon as the GPU
finishes, it releases the lease."* Lease carry-over is feed-forward only — *"if the
next step is guaranteed to use the currently loaded model, we can leave it loaded"* —
and Align loads a different model, so Narrate always releases.

## What "adding a book" means — narration, and a hosted Foundry text act

Ruled twice. On 2026-09-15 the band was for **narration** only: a text act ordered from
Foundry's window was left alone, on the argument that staging it *"put a Send to queue
gate in front of a button pressed in ANOTHER APPLICATION'S window — where there is no
Pending band to press it in."*

Owen, **2026-09-18**, reversing that: *"when i add something to the queue in the
vendored copy of foundry, it doesnt add it to the pending section, where i can pick the
GPU. it just throws it right into the queue. it should add it to pending so i can
configure the gpu it should go to."*

The premise had stopped being true. Foundry is **hosted inside BookForge**: the queue
that holds the row and the Pending band that releases it are in the same application as
the button, one tab away, and Foundry's own shelf draws the row as `held` — which it
already words as *waiting for you*. And the other half of the old argument — that the
machine a text act lands on *"is not a decision anybody was making"* — was simply wrong.
A clean over a whole book is a model reading every block of it, which asks the same
question a render asks: **which card**.

**Two facts, asked separately** (`jobIsStageable`): the act must be in
`STAGED_JOB_TYPES` *and* the step must travel. So among Foundry's jobs:

| Foundry job | Travels | Stages |
|---|---|---|
| clean, translate, simplify | yes — a Crucible serves the model door | **yes** |
| read | **yes** — `resourceFor` maps it to `gpu`, so `machines()` answers `'any'`, and `crucible/pages.ts` sends the read to a Crucible | **yes** |
| export, compile, rasterise | no — arithmetic over a bank on disk | no |

**The `read` row changed on 2026-09-14 (`1e6cb1fb`).** This table used to say a read did
not travel and went straight into the live queue, on the grounds that the VLM door
spawned a local python env. It does not: `queue-steps/foundry-job.ts` `resourceFor`
maps `read` to the GPU resource, `machines()` therefore answers `'any'`, and
`crucible/pages.ts` composes the endpoint, the model and the credential for a Crucible
page read. **Reads stage in Pending, and their server picker is live.**

A **chained** request is not staged a second time — it is appended onto the run that
owns the row it follows, so one book is one decision.

## Chaining — as far as it can go, and no further

Owen, **2026-09-19**: try to make chaining available all the way from OCR to narrate,
but *"some things likely won't be chained; it'll probably be manually driven"* — the
book has to be opened and curated after an OCR read before it can be narrated.

**A chained text act follows its run's server** (`runVenueOfRow(ctx.job.waitForResolved)`
→ `venueForRunStep`), which is PHASE7-LANES §4.4 working as written: one book, one GPU.
So an OCR read on the Mac pins a `clean` chained under it to the Mac, even where another
machine would serve the model better. **That is the ruling, not a defect** — re-deciding
a later step's machine would mean a book's steps land on two cards, which is the thing
§4.3 forbids. No code change; recorded here so nobody "fixes" it.

## Where UNASSIGNED work goes — Listen, the CLI, and a standalone step

Everything the queue did not assign a server to goes through **one** decision —
`electron/crucible/venue-decision.ts`, which `generation-venue.ts` and `text-venue.ts`
both wrap and which `pages.ts` reaches through `step-venue.ts`. It has two answers:

1. **The caller named a server** — the CLI's `--crucible-server`, a resumed render's
   persisted choice, the queue row's resolved venue. It wins unconditionally and is
   never pinged: naming a machine means waiting for it.
2. **Otherwise: the first ENABLED server, in rank order, that ANSWERS.** Never a
   disabled one. Never one that does not answer. When none is left it refuses by name,
   listing every server it tried and what each one said.

Owen, **2026-09-19**: *"WSL is always preferred for me, but I often stream on it. It
should never take next available unless the user is aware of which ones are enabled…
the user just needs control over which one is used and when, but should be able to feed
into the next available at will."* **The enable switches ARE that awareness.**

**This changed on 2026-09-19.** Until then the decision honoured the routing record's
`newJobsWaitFor`: on `top-ranked` it took the top enabled server UNPINGED, on the
argument that naming a machine is an instruction. But nobody had named it — the record
had — and the cost was real: with `top-ranked` set on this machine and the Mac asleep,
pressing Play on **Listen failed by name** while the PC sat awake and idle.

**`newJobsWaitFor` is now one thing only:** the default written onto a **new queue row**
(`shared/queue/wait-for.ts`, `queue-ipc.ts`) — `top-ranked` writes the top server's NAME
visibly onto the row, `any` writes `any`. A row carrying a name reaches the decision as
a caller-named server and is waited for. The setting has nothing to say about Listen, the
CLI, or a standalone step.

## Mutability — editable until a GPU takes it, immutable after

Owen: *"i should be able to switch either the queue item or the queue itself to resolve
that. all the way up to the moment it's taken by a gpu. the moment it's taken, it's
immutable. it's running and will have to be canceled and re-added to resolve it."*

- The ITEM's server is editable right up to admission. (The queue-wide dial that was
  the other half of that sentence no longer exists.)
- **Admission is the boundary**, and admission is now the moment the LEASE is held —
  see the order above.
- A running row's venue cannot be edited. To move it: cancel, then re-add.
- **The edit and admission race, and the race must be settled by name.** An edit that
  arrives after admission is REFUSED (naming the row and the server it went to), never
  silently applied to a running job and never silently dropped.
- A row whose venue was fixed at admission is refused edits by
  `venue_fixed_at_admission`. Its hold sentence must therefore offer the act that
  WORKS — *cancel this book to send it back to Pending* — not *"or set this book to
  Any"*, a control that refuses.

## A running job keeps its machine

By the time a job runs, its machine was already chosen. Jobs are atomic: *"if they start
somewhere, they finish on that server"* — a multi-step run resolves its venue once and
later steps follow it.

## A parked row says what would unblock it — different sentences for different causes

Collapsing these would name the wrong cause, which is the failure shape that cost this
project a day on 2026-09-15. With the dial gone, its sentence goes with it; what remains
must still be told apart:

- **The server is occupied:** *"Waiting for the 3090 Ti to become free"*, with the
  holder's line and its progress. The fix is time.
- **The server is disabled:** say THAT, and name the switch that turns it back on.
- **The server is unreachable:** say THAT, and name what it said.
- **The row's venue was fixed at admission:** say that, and offer Cancel — the one act
  that works.

**Every step module parks on a leased or busy card; none of them fails the row.** Until
2026-09-19 only narration, `pass.ts`, `align.ts` and `generate-sentences.ts` did:
translation, book analysis, RVC, denoise and VLM read all ended as FAILED rows in *Needs
you*, waiting for a Retry press over a card that was simply busy. Owen: *"let's fix
that."* The refusal's `busyLine` now rides `StepOutcome` so no module has to remember to
call `noteStepBusy`.

**A failed Align step STOPS the book** (Needs you; assembly is held behind it). Owen:
*"But we need to fix it so it doesn't fail. It should only fail because of a
misconfiguration, which can be repaired."* Every remaining Align failure must name the
misconfiguration.

## Known gap — "on this machine" is decided by loopback URL alone

`electron/crucible/servers.ts` `serversOnThisMachine()` recognises "here" by
`isLoopbackUrl`. **A Crucible running on THIS machine but registered by hostname — the
way the PC entry is spelled here — is treated as remote.** Two things that should apply
therefore do not:

- the one-card interlock between the in-app long-form aligner and that Crucible, so
  both can hold the same card at once;
- `acquireGpuForJob` in `parallel-tts-bridge.ts` takes no local GPU lock and evicts no
  resident Ollama model for it, so a local render and a local Crucible job can collide
  over memory with nothing saying so.

The honest fix is to compare the server's `/v1/info` identity against the discovered
pairing file rather than the shape of its URL. Not done; recorded so the next person
who sees a double-booked card knows where to look.

## Naming

There is no reserved `local` server any more (see `docs/` for that removal). A server's
name is what the operator typed, so servers are named after their GPU — "3090 Ti",
"M1 Ultra". No display-label indirection: the name IS the label.

`local-work` ("BookForge itself", 2 CPU slots) is NOT a Crucible server and is
unaffected.

## Persistence

Pending survives a restart. A book staged but not sent must not vanish because the app
closed. A restored row carrying a retired field (`device`, `gpuDial`) must LOAD and be
ignored — a restored queue is never failed over a field that stopped meaning anything.

## The bench's layout — grouped, not one flat grid

Owen, 2026-09-15: *"im not a fan of how the slots are laid out. maybe we should have a
local cpu slot section and a gpu slot section. they look kind of ugly clustered together
randomly. and its hard to tell which slot im looking at unless i look closely at the
names."*

Group them:

- **GPU — the Crucible engines.** One row per engine, named by its GPU ("3090 Ti",
  "M1 Ultra"), each with its enable switch above it.
- **CPU — BookForge itself.** The two `local-work` slots. Prepare runs here.
- The in-app long-form aligner row appears only while a step charges it, and belongs
  with the section its resource says it is.

Each section carries its own heading and its own in-use count; the overall "N of M slots
in use" stays. A section with no rows is not drawn — an empty heading is worse than
nothing.

## The voice picker is grouped by server, and a voice can LOCK the server

Owen, 2026-09-15: *"maybe we should make the dropdown show voices in sections. one
section per crucible server. for servers that have the same registered voices, the same
by model name, it lists it in a section that includes shared voices. if the user picks a
voice that exists on the 3090 but not on m1 ultra, the server selection is locked to the
3090. if they choose a voice that both servers have, they can pick which server they want
to use on the queue for that specific job/task."*

This INVERTS today's dependency. The voice list is currently a local catalog
(`electron/data/higgs-models.json` → `narration-voices.service.ts`) while the render goes
to a selected server — so the picker can offer a voice the venue cannot serve, and the
failure arrives at render time as a refusal rather than as an option that was never
there.

**The sections.** A voice is identified ACROSS servers by its model name. Group each
voice by the exact SET of servers that serve it:

- Voices every enabled server has → one shared section.
- Voices unique to one server → that server's own section, named by the server
  ("3090 Ti", "M1 Ultra").
- With three or more servers a voice may be on a subset; the section is named by that
  subset. The rule is the same one: **the section is the set of machines that can render
  it.**

**The lock.** Choosing a voice that only one server serves **pins the venue to that
server**, and the queue-item server picker is locked to it — not defaulted to it.
Choosing a shared voice leaves the picker free across exactly the servers in that voice's
set. A locked item names a server, so it waits for that server exactly as any other named
row does; the lock is an instruction like any other, simply one the voice made rather
than the operator.

**Source of truth.** The list must come from each server's own `GET /v1/voices`, not the
local catalog. `electron/crucible/voice-band.ts` already reads that endpoint for chunk
packing, so the read exists and has an owner.

**Owed a ruling:** what an UNREACHABLE or disabled server contributes. Its voices cannot
be listed from it, and showing a stale set invites picking a voice that cannot be
rendered — while hiding it silently removes a machine the operator knows they have. Say
which, by name, rather than defaulting.

**The picker is a snapshot.** `loadVoicePicker()` runs once when the Narrate modal opens;
a server that wakes while the modal is up stays in `voiceServersMissing` until it is
reopened. That is acceptable — but the warning must say *"as of &lt;time&gt; · Re-check"*
beside it, so the person reading it knows they are reading a snapshot and how to refresh
it.
