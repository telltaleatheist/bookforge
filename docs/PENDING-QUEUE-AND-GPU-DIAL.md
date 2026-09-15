# Pending, and the GPU dial — Owen's rulings, 2026-09-15

A book is staged before it runs, and which GPU it runs on is a dial you can turn while the
queue is running. Today the venue is guessed at enqueue time and there is no way to say
"use this card, right now" once work is moving.

## The shape

1. **Adding a book puts it in PENDING, not in the live queue.** Nothing about a pending
   item is committed.
2. **In Pending you choose its server** — a named Crucible server, or *let the queue
   decide*.
3. **"Send to queue"** moves it into the live queue.
4. **The queue itself carries a GPU dial**: *any*, or one named server.

## Precedence — the dial defers, it never overrides

| Item | Dial | Result |
|---|---|---|
| names a server | `any` | the item's server. An explicit instruction is never second-guessed. |
| `any` | names a server | the dial's server. |
| names a server | names the SAME server | runs there. |
| names a server | names a DIFFERENT server | **sits in the live queue** until the dial is switched to `any` or to that server. Not failed. Not re-routed. |
| `any` | `any` | today's behaviour — the first enabled server that answers. |

The dial is a dial, not a router. A named machine is an instruction; the answer to "I cannot
honour that right now" is to WAIT, never to quietly use a different card.

## Mutability — editable until a GPU takes it, immutable after

Owen: *"i should be able to switch either the queue item or the queue itself to resolve
that. all the way up to the moment it's taken by a gpu. the moment it's taken, it's
immutable. it's running and will have to be canceled and re-added to resolve it."*

- Both controls are live: change the ITEM's server, or the QUEUE's dial, to unblock a
  parked row.
- **Admission is the boundary.** The instant a row is taken by a GPU it is fixed.
- A running row's venue cannot be edited. To move it: cancel, then re-add.
- **The edit and admission race, and the race must be settled by name.** An edit that
  arrives after admission is REFUSED (naming the row and the server it went to), never
  silently applied to a running job and never silently dropped.

## A running job ignores the dial

By the time a job runs, its machine was already chosen. Jobs are atomic: *"if they start
somewhere, they finish on that server"* — a multi-step run resolves its venue once and
later steps follow it. Turning the dial governs ADMISSION of new runs only.

## A parked row says what would unblock it — three different sentences

Collapsing these would name the wrong cause, which is the failure shape that cost this
project a day on 2026-09-15.

- **The dial points elsewhere:** *"Waiting for 3090 Ti — the queue is set to M1 Ultra."*
  The card may be completely idle. The fix is a dial turn.
- **The server is occupied:** *"Waiting for the 3090 Ti to become free."* The dial matches,
  the card is working, and the fix is time.
- **The server is disabled or unreachable:** say THAT, not either of the above.

## Naming

There is no reserved `local` server any more (see `docs/` for that removal). A server's name
is what the operator typed, so servers are named after their GPU — "3090 Ti", "M1 Ultra".
No display-label indirection: the name IS the label.

`local-work` ("BookForge itself", 2 CPU slots) is NOT a Crucible server and is unaffected.

## Persistence

Pending survives a restart. A book staged but not sent must not vanish because the app
closed.

## The bench's layout — grouped, not one flat grid

Owen, 2026-09-15: *"im not a fan of how the slots are laid out. maybe we should have a
local cpu slot section and a gpu slot section. they look kind of ugly clustered together
randomly. and its hard to tell which slot im looking at unless i look closely at the
names."*

Today `queue.component.ts` renders `tray.lanes()` as ONE flat grid, so a GPU slot and a CPU
slot are the same card in the same run and the only thing separating them is a word inside
the strip. Group them instead:

- **GPU — the Crucible engines.** One row per engine, named by its GPU ("3090 Ti",
  "M1 Ultra"). This is the section the dial acts on.
- **CPU — BookForge itself.** The two `local-work` slots.
- The in-app long-form aligner row appears only while a step charges it, and belongs with
  the section its resource says it is.

Each section carries its own heading and its own in-use count; the overall "N of M slots in
use" stays. A section with no rows is not drawn — an empty heading is worse than nothing.

This is deliberately folded into the Pending/dial build rather than done separately: both
rework the same component, and two passes over one file is how two agents collide.

## The voice picker is grouped by server, and a voice can LOCK the server

Owen, 2026-09-15: *"maybe we should make the dropdown show voices in sections. one section
per crucible server. for servers that have the same registered voices, the same by model
name, it lists it in a section that includes shared voices. if the user picks a voice that
exists on the 3090 but not on m1 ultra, the server selection is locked to the 3090. if they
choose a voice that both servers have, they can pick which server they want to use on the
queue for that specific job/task."*

This INVERTS today's dependency. The voice list is currently a local catalog
(`electron/data/higgs-models.json` → `narration-voices.service.ts`) while the render goes to
a selected server — so the picker can offer a voice the venue cannot serve, and the failure
arrives at render time as a refusal rather than as an option that was never there.

**The sections.** A voice is identified ACROSS servers by its model name. Group each voice by
the exact SET of servers that serve it:

- Voices every enabled server has → one shared section.
- Voices unique to one server → that server's own section, named by the server ("3090 Ti",
  "M1 Ultra").
- With three or more servers a voice may be on a subset; the section is named by that subset.
  The rule is the same one: **the section is the set of machines that can render it.**

**The lock.** Choosing a voice that only one server serves **pins the venue to that server**,
and the queue-item server picker is locked to it — not defaulted to it. Choosing a shared
voice leaves the picker free across exactly the servers in that voice's set.

**How it composes with the dial** (no new rule needed — the existing precedence covers it):
a locked item names a server, so if the dial names a different one the row **parks** with the
dial sentence, exactly as any other named row does. The lock is an instruction like any
other; it is simply one the voice made rather than the operator.

**Source of truth.** The list must come from each server's own `GET /v1/voices`, not the local
catalog. `electron/crucible/voice-band.ts` already reads that endpoint for chunk packing, so
the read exists and has an owner.

**Owed a ruling:** what an UNREACHABLE or disabled server contributes. Its voices cannot be
listed from it, and showing a stale set invites picking a voice that cannot be rendered —
while hiding it silently removes a machine the operator knows they have. Say which, by name,
rather than defaulting.
