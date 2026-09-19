# Hand-run checks

**Nothing in here is a gate.** No npm script runs it, `bun test` does not pick it
up, and neither does a build. These are diagnostics you run by hand when you are
looking into the thing they were written for, and they are kept because writing
them again from scratch is the expensive part.

The two keepers that DO run on every build live one directory up — 
`tools/test-no-backticks-in-templates.js` and `tools/test-crucible-setup-surface.js`
— and are wired into `build:renderer`. Do not move anything here into that set
without meaning to.

| Script | Run it when |
|---|---|
| `install-attach.ts` | You changed `electron/crucible-install-door.ts` and want to know the door still joins a move the tray started. |
| `suite-order.sh` | A test passes alone and fails in the suite, or the reverse — anything that smells order-dependent. |

## install-attach.ts

```
cd app && bun tools/checks/install-attach.ts
```

Eight assertions against a **scripted** host door — a fake `fetch` and a fake
`Runner`, which are the SDK's own two seams, so nothing opens a socket and the
live Crucible on this desk is not consulted. It covers the thing that is easy to
break and invisible when broken: `attach()` joining a run this process did not
start, replaying the ring, folding the host's steps onto the six rows, dropping
the host's own `done`, opening exactly one stream however many windows ask, and
staying silent on a machine with no host pack.

## suite-order.sh

```
bash app/tools/checks/suite-order.sh        # 5 shuffled orders
bash app/tools/checks/suite-order.sh 12     # 12 of them
```

Runs the whole suite N times with the test files in a random order, and prints
the pass/fail line for each. Run from the repo root.

Why it exists: `bun test` walks the directory, and the walk is SORTED on Windows
and HASH-ORDERED on macOS. A test that leaves module state behind therefore fails
on one machine and not the other, with nothing in the diff to say which test is at
fault — the failures land in whatever file happened to run next. That is exactly
what `hosted-shelf.test.ts` did with `recordHost` on 2026-09-19: four failures in
`crucible-install-latest.test.ts`, none of them that file's fault.

**RUN IT ON THE MAC. A green run on Windows is not evidence.** Measured
2026-09-19 against the leaky file, restored on purpose: six shuffled orders on the
Mac failed, every one. Three shuffled orders on Windows stayed green — and so did
an explicit `hosted-shelf` → `crucible-install-latest` pairing. So the hash-ordered
walk is NOT the only thing that differs between the two machines; something about
how bun rebuilds the module graph around `mock.module('electron', …)` appears to
give the Windows run a fresh `electron/host.ts` where the Mac keeps the poisoned
one. That mechanism is unconfirmed, which is the point of writing it down rather
than asserting it — what IS confirmed is which machine reproduces.

And even there it is not a proof: it SAMPLES orders, it does not enumerate them.
