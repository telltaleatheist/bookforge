# Wiring the queue's GPU admission to a Crucible accelerator probe

**Status: a proposal. No code for it exists, on this branch or anywhere.** It is app
surgery — the queue decides whether a nine-hour narration starts — and Owen tests app
changes himself, so this is written down rather than built.

Written 2026-09-13 alongside `feat/crucible-cli-v3`, which moved the SDK pin to v0.3.0 and
gave the CLI `--crucible-accelerator`. That command is the whole of the client side today:
it calls `GET /v1/accelerator` and prints what it says. Nothing in the app calls it.

---

## 1. What the seam is

```
electron/queue-engine.ts:1274   let gpuHolderProbe: () => string | null = () => null;
electron/queue-engine.ts:1275   export function setGpuHolderProbe(probe) { gpuHolderProbe = probe; }
electron/queue-engine.ts:1294   const holder = gpuHolderProbe();          // inside gpuAdmission()
electron/queue-engine.ts:1742   if (options.gpuHolder) gpuHolderProbe = options.gpuHolder;
electron/queue-ipc.ts:56        await engine.configure({ stateDir, gpuHolder });
```

`gpuHolder` there is `electron/gpu-arbiter.ts:60` — `holder?.owner ?? null`, the owner
string of the app's own in-process mutex. So today the queue's answer to "is anyone using
the card" is "is any *other part of this Electron process* using the card", plus the lock
file below. Two of the three real claimants — a WSL guest process, another machine's job,
anything outside this process — are invisible to it.

`gpuAdmission()` (`queue-engine.ts:1285`) asks two questions, in this order:

1. `gpuLockProbe()` — `shared/gpu/external-job-lock.ts`, i.e. does
   `%APPDATA%\BookForge\external-gpu-job.lock` exist. **Windows-only, and nothing inside the
   app creates it**: it is a convention with the training tooling. Its deletion is watched by
   nothing, which is why admission arms a 15-second recheck (`admissionRecheckMs = 15_000`,
   `queue-engine.ts:432`) — a poll standing in for an event.
2. `gpuHolderProbe()` — the in-process arbiter's owner.

Either one answering non-null holds the step in `admissionHold` with the reason as prose.

## 2. What the probe would resolve, and what would call it

**One registry entry, named in settings, resolved through the same door the CLI uses.**
`crucibleClientFor(name, 'bookforge')` (`electron/crucible/servers.ts:314`) against an entry
in `<userData>/crucible-servers.json`. Which entry is a **setting** — a new
`app-settings.json` key (working name `gpuProbeServer`) naming a registered server, not a
URL and not a default. Absent means the probe is not wired and admission behaves exactly as
it does today; that is the only defaulting in this design, and it is a feature being off
rather than a value being guessed.

The server named must be the one that shares this machine's card. On owens-pc that is the
WSL server (`wsl` in the registry today); on the Mac it is the local one. **A Crucible on
another machine must never be named here** — it would report a card this queue does not
schedule against, which is worse than no probe at all. The setting is therefore per-machine,
like `llmServer`, and the write-up owes a refusal: if `/v1/info`'s `host` is not this host,
say so by name rather than probing it.

## 3. The one hard constraint: `gpuHolderProbe` is synchronous

`() => string | null`. It is called from `gpuAdmission()`, which is called from `pump()`,
which is called after every state change and on the 15-second recheck. **An HTTP call cannot
happen inside it**, and making the signature async would push a promise through the whole
scheduler for a value the scheduler needs synchronously.

So the wiring is a **cached snapshot plus a refresher**:

- a module (`electron/crucible/gpu-probe.ts`) holds `{ answer: string | null, at: number }`;
- `setGpuHolderProbe(() => currentAnswer())` reads that cache and nothing else;
- a timer calls `client.accelerator()` and updates the cache. The refresh interval is the
  admission recheck's own — 15 s — because that is already the cadence at which a waiting
  step asks, and a faster poll would be an HTTP request per pump for an answer that cannot
  have changed;
- **the cache has an age, and a stale entry is not an answer.** Older than, say, 3 refresh
  intervals and the probe reports "cannot see the card" rather than its last reading. A
  reading from 40 minutes ago is not news about now.

This is also what stops the failure the ruling below is about: admission is never an HTTP
call, so a slow or hung server cannot stall the scheduler's pump. It can only make the
cache stale, which is handled above.

## 4. An unreachable server must mean THE STEP DOES NOT START

This is the whole point, and it is the thing that must not be got wrong.

`CrucibleUnreachable`, a timeout, a 401, a 503 `accelerator_unreadable`, or a cache too old
to trust — **every one of them means admission refuses**, with a reason naming which it was.
None of them may mean "proceed".

> A queue that starts a GPU step when it cannot see the card has reinvented the bug it is
> replacing.

That bug is `gpu-arbiter.ts:86-97`: `acquireGpu(owner, {timeoutMs})` arms a timer that, on
expiry, logs `proceeding WITHOUT the lock` and **resolves the waiter anyway**. The later
`releaseGpu()` is then a no-op. It is a deadlock backstop that trades a hang for a silent
double-booking of the card, and the probe exists to make the hang impossible rather than to
make the double-booking cheaper. Retiring that path is part of this change, not a follow-up:
a live probe means a step that cannot start says why and waits, and there is no deadlock to
back out of.

`accelerator_unreadable` deserves its own message because it is its own thing: the SDK gives
it its own type (`CrucibleAcceleratorUnreadable`, a `CrucibleServerError` subclass, so order
your `instanceof` chain narrow-first — `cli/crucible.js`'s `describeSdkError` does). The
server raises it rather than returning zeroes precisely so it cannot be read as an idle card.
"Ask again" is the only correct response; "start the render" is not.

## 5. What the probe would say, and what it must not conclude

`AcceleratorState` carries more than a boolean, and the reason string the queue shows the
user should be built from it — `admissionHold` is prose the user reads while a job waits.

Three readings are refusals to answer, and the rules `cli/crucible.js` already follows apply
unchanged here:

- **`holders[].bytes` may be `null`** — the driver declining a per-process figure. Sum only
  over the holders that answered; never treat a null as 0.
- **An empty `holders` is not an idle card.** Under WSL2 — the host BookForge runs on — the
  driver shim answers the compute-app query with an empty list while a process inside that
  same VM holds 17 GB. Measured on owens-pc 2026-09-12, and reproduced by
  `--crucible-accelerator` on 2026-09-13: `0 compute app(s)` beside `unattributed 15.4 GiB`
  while a fine-tune ran. **`unattributedBytes` is the field that answers "is the card busy"
  on this machine**, and a wiring that reads only `holders` would report an idle card in the
  single case it most needs to get right.
- **`unattributedBytes` is `null` on `mlx-darwin`** and that is not zero either; on the Mac
  the honest reading is `freeBytes` against the step's own estimate.

`resident` says what *Crucible* holds (`{kind, id, since, memoryBytesEstimate}`) and
`ownedByCrucible` marks its own pids among the holders — which is how the queue tells "the
card is busy with work I asked for" from "the card is busy with somebody else's". The probe
**reports and never evicts**; nothing here asks anyone to leave, and that rule does not
soften because more job types depend on it.

## 6. What this retires

- **`external-gpu-job.lock`** — `shared/gpu/external-job-lock.ts` and the `gpuLockProbe`
  branch of `gpuAdmission()`. A Windows-only file convention with no producer inside the app,
  standing in for "somebody outside is using the card" — which is exactly what `holders` and
  `unattributedBytes` answer, from the driver, on both platforms. Retiring it also retires
  the 15-second admission recheck's *reason for existing*, though not necessarily the timer:
  the refreshed cache is itself a poll, and a push would need the server to grow one.
- **The arbiter's `timeoutMs` proceed-anyway path** (`gpu-arbiter.ts:86-97`), for the reason
  in section 4.
- Some of `wsl-lifecycle.ts`'s GPU-teardown ladder, which exists to make the card
  *observably* free because nothing could observe it. Not audited here; named because
  PHASE4-AUDIO.md section 5 names it.

Each of those is a separate commit with its own in-app test. **None of them may be removed
before the probe is live and its refusals are proven**, because every one of them is a
safety interlock and the failure mode of removing one early is silent.

## 7. What is deliberately not proposed

- **No eviction.** The queue may wait; it may not ask a holder to leave.
- **No second probe for `align` or `rvc`.** One card, one probe, one answer.
- **No IPC, no settings UI, in the first pass.** The setting is a key in
  `app-settings.json` written by hand, the way `llmServer` was before it had a row. A row
  comes after the mechanism is proven, not with it.
