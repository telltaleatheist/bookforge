# NARRATOR_CUTOVER — what each phase actually changed

Companion to `docs/E2A_REMOVAL_PLAN.md`, which says what WILL happen. This says
what HAS, spawn by spawn, so a later reader can tell a deliberate change from a
regression without re-deriving either.

---

## Phase 2 — `narrator-spawn.ts` and the streaming server

Branch `feat/narrator-cutover`. Scope: the resident Listen/extension server only.
**Every batch door — prep, worker, retake, assembly, resume, list — is untouched**
and `tools/test-orpheus-argv-snapshot.js` proves it: all five array literals in
`parallel-tts-bridge.ts` are byte-identical to `tools/snapshots/orpheus-argv-base.json`
(the pre-Higgs baseline, commit 01a3799b). Phase 3 owns those.

### The one launcher

`electron/narrator-spawn.ts` is now the only place in the app that assembles a
python command line for narrator:

```ts
buildNarratorSpawn({ engine?, phase, args, envExtras, cwdHint? })
  -> { command, args, env, cwd, viaWsl, shell, describe() }
```

| phase | module | engine |
|---|---|---|
| `serve` | `narrator.serve` | required |
| `worker` | `narrator.compat.worker` | required |
| `prep` | `narrator.compat.app` | required |
| `assembly` | `narrator.compat.app` | **optional** |
| `resume` | `narrator.compat.app` | refused |
| `list` | `narrator.compat.app` | refused |

Assembly is the one `optional` because a Higgs assembly runs in the Higgs env
today (Phase 1's behaviour, preserved) while an Orpheus one is engine-agnostic.
Phase 3 makes both `undefined` and the distinction disappears. `resume` and `list`
REFUSE an engine rather than ignoring one: ignoring it would silently route a
session listing into a multi-gigabyte TTS environment.

Environment, by `(engine, platform)`:

| engine | Windows | macOS | Linux |
|---|---|---|---|
| `orpheus` | WSL `orpheus_tts` (`conda run -n`) when the toggle is on, else the managed `orpheus` component | **`narrator-mlx`** (new) | managed `orpheus` component |
| `higgs` | WSL `higgs3` | refused by name | refused by name |
| *(none)* | native tools env (`getPythonInvocation` with no engine) | same | same |

`getNarratorMlxEnv()` (in `e2a-paths.ts`, the component seam) resolves a managed
`narrator-mlx` component first, then
`/opt/homebrew/Caskroom/miniconda/base/envs/narrator-mlx`, then **refuses by
name**. No step-down to the ebook2audiobook Orpheus env: that env is below the
mlx 0.32.0 and mlx-lm 0.31.3 pins, so it would not fail — it would decline to
overlap decoding and read as "the Mac is just slower" (PORT_NOTES 7a).

**THE ENV EXISTS.** It was built by hand on the Mac Studio on 2026-09-04 (python
3.11, mlx 0.32.0, mlx-lm 0.31.3, mlx-audio 0.4.8, numpy, soundfile, mutagen,
psutil, beautifulsoup4, pillow) and rendered kershaw end to end at **5.14x
realtime**, so the macOS arm resolves today and the second lookup above is the one
that answers. What Phase 6 adds is not the environment but its REPRODUCIBILITY:
`packaging/env/narrator-mlx.yml` plus a component installer, so the next Mac does
not depend on somebody remembering the pins.

`higgs-spawn.ts` is now a thin caller. It keeps the voice document, the served
model's launch script and the catalog refusals — the things that are about Higgs —
and hands them over as `envExtras`. `tools/test-higgs-engine.js` is green with no
changes to the test.

### Before / after — the serve spawn

Captured from the real `buildSpawnPlan` by `tools/serve-spawn-extract.js`; the
"before" column is `tools/snapshots/serve-spawn-base.json`, committed in 0f0a68d5
from the code as it stood.

**WSL arm (Windows, `useWsl2ForOrpheus`)**

| | before | after |
|---|---|---|
| argv | `wsl.exe -d Ubuntu bash -c "…"` | unchanged |
| run | `conda run --no-capture-output -n orpheus_tts python -u '<repo-wsl>/electron/scripts/orpheus_stream.py'` | `… python -u -m narrator.serve` |
| cd | `cd '<wslE2aPath>'` | `cd ~` |
| exports | `PYTHONUNBUFFERED PYTHONIOENCODING ORPHEUS_DISABLE_EAGER VLLM_USE_V1 ORPHEUS_GPU_MEM_UTIL ORPHEUS_STREAM_BATCH ORPHEUS_STREAM_RAMP ORPHEUS_STREAM_WARM_MAX EBOOK2AUDIOBOOK_PATH` | same, **minus** `EBOOK2AUDIOBOOK_PATH`, **plus** `PYTHONPATH` `NARRATOR_ENGINE` |
| env | inherited `process.env` (nothing crosses) | unchanged |

**Native, Windows-without-WSL / Linux**

| | before | after |
|---|---|---|
| command | `getPythonInvocation(E2A_PATH, 'orpheus')` | unchanged |
| args | `[...py.args, '-u', <scriptPath>]` | `[...py.args, '-u', '-m', 'narrator.serve']` |
| cwd | `E2A_PATH` | `app.getPath('userData')` |
| env | `PYTHONUNBUFFERED PYTHONIOENCODING VLLM_USE_V1 EBOOK2AUDIOBOOK_PATH ORPHEUS_STREAM_BATCH ORPHEUS_STREAM_WARM_MAX ORPHEUS_STREAM_RAMP ORPHEUS_GPU_MEM_UTIL` | same, **minus** `EBOOK2AUDIOBOOK_PATH`, **plus** `PYTHONPATH` `NARRATOR_ENGINE` |

**Native, macOS** — as above, plus `ORPHEUS_MLX_CACHE_LIMIT_GB` and
`ORPHEUS_MLX_MEM_BUDGET_GB` (unchanged), and the interpreter moves from the
Orpheus component env to `conda run -p <…>/envs/narrator-mlx python`.

So: **four changes** everywhere (`-m narrator.serve`; `EBOOK2AUDIOBOOK_PATH` out;
`PYTHONPATH` in; `NARRATOR_ENGINE` in), **plus cwd** (narrator reads cwd for
nothing — PORT_NOTES 9.3), **plus the macOS interpreter**. Every one of the 33
variables in PORT_NOTES 9.4 keeps its name, its value and its precedence, and
`tools/test-serve-spawn-env.js` fails if any of that stops being true.

### The two process patterns that had to move with it

Deleting `electron/scripts/orpheus_stream.py` broke two matches, and **neither
would have failed loudly**:

- `orpheus-worker-pool.ts` waited for `orpheus_stream\.py` to leave the guest
  before signalling. A stale pattern sends every teardown straight to the
  `wsl.exe` taskkill with a live vLLM still holding ~6 GB — the shape that wedges
  the VM.
- `shared/tts/gpu-ownership.ts` EXCLUDED it from foreign-render detection. A stale
  pattern stops excluding anything, and the first render on a machine with the
  reader switched on is refused as somebody else's job.

Both now name `narrator.serve`. `SERVE_PROCESS_RE` lives in `narrator-spawn.ts`,
beside the thing that builds the command line, so the pool's MATCH and the batch
reaper's EXCLUSION cannot drift apart. `gpu-ownership.ts` keeps its own literal
because `shared/` cannot import from `electron/`.

### What the pool learned to read

`loaded` now carries `engine`, `sampleRate`, `pads` and `edgeFadeMs` (a SHAPE,
`{in, out}`, because Higgs's fade is asymmetric). The pool records all four and
`activeSampleRate()` replaces four hardcoded `24000`s. Both shipping engines are
24 kHz so nothing changes today; what it prevents is the next engine mis-timing a
session, since every duration the pool reports is `bytes / (rate * 2)`.

`narrator.serve` exits **3** when no engine can load (an unservable
`NARRATOR_ENGINE`, or a backend detection that raised) and deliberately prints no
`ready` first — a handshake followed by "Model not loaded" on every generate is a
worker that looks alive forever. `startupFailure()` turns exit 3 (and exit 2, a
rejected command line, which is a BookForge bug) into an error that names the
cause and carries the worker's own stderr, and says restarting will reproduce it.
There is no auto-restart path to suppress.

### Also fixed here, because the proof depended on it

`tools/orpheus-argv-extract.js` had been unable to run on Windows since it was
written: its anchors are `\n` and this repo is `core.autocrlf=true`, so every
`indexOf` returned -1 and the keeper died instead of reporting. Verified on a
clean checkout before touching it. Normalised at extract time; the snapshot is
byte-identical either way because `normalize()` already collapses all whitespace.

### Verified

- `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.app.json --noEmit`, `npx ng build` — clean.
- `node tools/run-keepers.js` twice — ALL KEEPERS GREEN (including the two new
  registrations, `test-serve-spawn-env` and `test-gpu-ownership`).
- No `require("@shared/` in `dist/electron`.
- `tools/smoke-serve-spawn.js`: the pool's REAL argv, env and cwd, run natively in
  the Windows tools env with `--fake-engine` appended **by the test alone**,
  reaching `ready -> loaded -> audio -> batch_item x2 -> batch_done -> exit 0`.
  The `loaded` line carried `engine: "orpheus"`, `sampleRate: 24000`,
  `pads: true`, `edgeFadeMs: {in: 0, out: 0}`.
- Exit 3 reproduced by hand with `NARRATOR_ENGINE=higgs-v2-scaffold`; the code
  survives `conda run` intact.

### NOT verified — owed

- **The WSL arm has never been run.** The GPU is held by the training session's
  `external-gpu-job.lock`, so no vLLM model was loaded and PORT_NOTES 9.5 steps
  2-5 against a real model are outstanding on Windows/WSL.
- **The macOS arm has not been run FROM THE POOL.** The `narrator-mlx` env is
  real and proven (a full kershaw render at 5.14x realtime, 2026-09-04), so the
  environment half is verified; what is outstanding is BookForge's own spawn
  reaching it — Listen on the Mac, start to sound. Corrected 2026-09-04: an
  earlier draft of this file said the env did not exist anywhere.
- Listen playback in the app, on either machine.

---

## What Phase 3 still owns

Everything in `parallel-tts-bridge.ts` and `reassembly-bridge.ts`, untouched here:

- the prep, worker, retake, assembly, resume and list spawns (all six still call
  `app.py` / `worker.py` in the e2a checkout);
- `buildWslBashCommand` and its pattern rewriting, `rewriteUnderE2aRoot`, the
  `forwardKeys` allowlist, `-p python_env`;
- `wslSessionPattern()` and the batch half of the orphan reapers, which still name
  `worker.py` / `app.py` / `ebook2audiobook.*\.py`;
- `assembleOrpheusNative` / `asmRoutingEngine` / `asmInvocation` and the
  `--tts_engine xtts` literal on the assembly door;
- `GENERATION_ACTIVITY_RE` and `REPAIR_START_RE`, which must be pinned against
  narrator's REAL stderr before the batch doors move — a miss there is a watchdog
  that TERMs a working worker;
- `cli/bookforge-tts.py`, `cli/orpheus-audiobook-render.js`, `cli/e2a-scratch.js`
  and `cli/narration-prep*.js`. (`cli/orpheus-stream.js` needed no change: it
  drives the pool through the TTS API server, so it followed the pool's door for
  free.)

Phase 5 (`feat/xtts-removal`, another branch) owns `streaming-engine.ts`'s xtts
arm, `xtts-worker-pool.ts`, `xtts-voices.ts` and `custom-voices.ts`. The only edit
made to `streaming-engine.ts` here is its Orpheus availability probe, which now
asks `narrator-spawn` the same question the spawn will ask — otherwise the Listen
picker would report "Orpheus: available" on a Mac with no `narrator-mlx`. On the
Mac Studio that env is present, so the probe passes there for the right reason.
