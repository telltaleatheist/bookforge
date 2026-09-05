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

- ~~**The WSL arm has never been run.**~~ **RESOLVED 2026-09-05** — see "The
  Windows/WSL GPU window" in the proof ledger. `buildSpawnPlan()`'s WSL arm ran as
  written, a real mistborn loaded on vLLM with CUDA graphs, and PORT_NOTES 9.5
  steps 2-4 completed against it in both streaming modes (buffered `batch_item`s
  and 21 fast-start `batch_chunk` slices), exit 0 each time. Step 5 — a `cancel`
  mid-batch against a real model — is still owed; it is covered against the fake
  by `tests/test_engine_serve_protocol.py`.
- **The macOS arm has not been run FROM THE POOL.** The `narrator-mlx` env is
  real and proven (a full kershaw render at 5.14x realtime, 2026-09-04), so the
  environment half is verified; what is outstanding is BookForge's own spawn
  reaching it — Listen on the Mac, start to sound. Corrected 2026-09-04: an
  earlier draft of this file said the env did not exist anywhere.
- Listen playback in the app, on either machine.

---

## Phase 3 — the Orpheus batch cut-over

Branch `feat/narrator-cutover`. Six doors moved off ebook2audiobook. Nothing in
`parallel-tts-bridge.ts` or `reassembly-bridge.ts` spawns `app.py` or `worker.py`
any more, and the WSL argv rewriter is deleted.

### The six doors, before and after

| door | before | after |
|---|---|---|
| prep | `<py> <e2a>/app.py --headless --ebook … --prep_only` (+ 6 XTTS sampling flags) | `<py> -u -m narrator.compat.app --headless --ebook … **--session_dir** … --prep_only` |
| worker | `<py> <e2a>/worker.py …` OR `<py> <e2a>/app.py --worker_mode --skip_deps …`, chosen by `useLightweightWorker` | `<py> -u -m narrator.compat.worker …` — ONE arm |
| retake | `<py> <e2a>/worker.py … --sentence_indices` (+ `--speed`) | `<py> -u -m narrator.compat.worker … --sentence_indices` |
| assembly (render) | `app.py --assemble_only`, one of THREE routes, `--tts_engine xtts` on the native one | `-m narrator.compat.app --assemble_only`, native tools env, always |
| assembly (reassembly) | `app.py --assemble_only`, WSL arm when the session was on ext4, `--tts_engine xtts` always | same one native door |
| resume / list | `<py> <e2a>/app.py --headless --resume_session\|--list_sessions` | `-m narrator.compat.app`, tools env |

Every `--tts_engine` value now comes from `narratorEngineId()`. BookForge says
`higgs`; narrator lists `higgs` under ENGINE_NEAR_MISSES beside `higgs-v2`,
`higgs-v2-scaffold` and `higgs_v3`, and refuses all four BY NAME — guessing which
Higgs a caller meant is how a whole book gets rendered by the wrong model.

### Flags that stopped being sent, and why

`--speed`, `--enable_text_splitting`, `--temperature`, `--top_p`, `--top_k`,
`--repetition_penalty`, `--skip_deps`. narrator parses all seven and honours none
(compat/FLAGS.md, IGNORE — six are "XTTS only", and narrator installs nothing).
Orpheus's equivalents arrive as `ORPHEUS_TEMPERATURE` / `ORPHEUS_TOP_P` /
`ORPHEUS_REP_PENALTY` or as registered per-voice caps. Passing a flag nothing
reads is a claim that a setting was honoured.

`--bilingual` / `--bilingual_pause` / `--bilingual_gap` are STILL SENT on the
render assembly door, deliberately. narrator REFUSES them by name, which is Phase
4's business; leaving them is what makes that refusal reachable from the app
instead of theoretical.

### The environment diff, per door

`buildNarratorSpawn` supplies `PYTHONUNBUFFERED`, `PYTHONIOENCODING`,
`PYTHONPATH`, and `NARRATOR_ENGINE` when an engine is named. Beyond that:

| door | added | removed |
|---|---|---|
| prep | `PYTHONPATH`, `NARRATOR_ENGINE`; `ORPHEUS_DISABLE_EAGER` on the WSL arm (was hard-coded inside `buildWslBashCommand`) | `EBOOK2AUDIOBOOK_PATH`; `VLLM_DISABLE_CUDA_GRAPH`/`VLLM_NO_CUDA_GRAPH` on the WSL arm only |
| worker / retake | same, plus **every** `ORPHEUS_*` value now crosses into WSL | the `forwardKeys` allowlist |
| assembly | `PYTHONPATH` | `EBOOK2AUDIOBOOK_PATH`, and every `ORPHEUS_*` — nothing here loads vLLM or MLX |
| resume / list | `PYTHONPATH` | `EBOOK2AUDIOBOOK_PATH`, the CUDA-graph pins |

Two of those are behaviour changes rather than renames:

- **`ORPHEUS_DISABLE_EAGER` is now arm-aware.** It turns CUDA graphs ON in Linux
  and is the entire reason Orpheus runs in WSL. `buildWslBashCommand` hard-coded
  it into its export line while the native arms set
  `VLLM_DISABLE_CUDA_GRAPH`/`VLLM_NO_CUDA_GRAPH` instead. Sending both sets into
  the guest would have them fight, so the arm decides, in the open.
- **The allowlist is gone.** `forwardKeys` was fourteen `ORPHEUS_*` names plus the
  two owner-pid vars — a list of variables somebody remembered. Forwarding is now
  every value in `envExtras`, which is the door's own declaration.

### `normalizeWslSessionToWindows` stays, and it is load-bearing

Orpheus prep and render still run in WSL, so the session is written to ext4.
That function copies it onto a Windows path after generation — the copy runs
INSIDE the guest, so it is fast — and repoints `prepInfo`. Native assembly is only
possible because of it: without it the assembler would be reading the `\\wsl$` 9p
mount, which is slow enough to dominate the job, or nothing at all when WSL is
down. Phase 3 made assembly native for BOTH engines and on every platform; it did
not make the copy unnecessary.

### The kill patterns, which fail silently in both directions

`(worker|app)\.py`, `ebook2audiobook.*\.py` and `app\.py.*<sid>` match nothing in
`python -u -m narrator.compat.worker`. A kill pattern that matches nothing does
not fail — the sweep reports success and leaves a vLLM process holding ~6 GB of
VRAM, which is the shape that wedges the WSL VM and the shape that makes the next
job refuse to start. All three now come from `narrator-spawn.ts`
(`NARRATOR_WORKER_RE`, `NARRATOR_APP_RE`, `NARRATOR_BATCH_RE`) beside
`SERVE_PROCESS_RE`, which the same sweeps must never touch.

### `shouldUseWslForSpawn` → `jobRunsInWsl`, and the lie it was telling

It returned false for Higgs on purpose: every caller was also the gate in front of
`spawnWithWslSupport`, and a Higgs command through that function came out an
Orpheus command. So each site that needed the truth had to write
`|| (isHiggsJob(...) && higgsRunsInWsl())` and remember to. Three did not:

- a Higgs job's guest workers were never session-torn-down,
- its retake never staged session state into the guest,
- a wedged VM never stopped it retrying.

`spawnWithWslSupport` is deleted, so the lie has no beneficiary. It now delegates
to `narratorRunsInWsl`, which is what the spawn itself asks.

### Three bugs the live proofs caught that no snapshot could

1. **Assembly needs the PROCESS dir.** Both doors passed the `ebook-<uuid>`
   session dir. `session_v1.build_manifest` opens `<dir>/session-state.json`
   directly; only the RENDER routes go through `session_store`, which walks a
   session dir's subdirectories for it. e2a resolved either, so this door sent the
   session dir for years. narrator refuses by name — and every book would have
   failed to assemble, with perfect flags and a perfect plan.
2. **`lastJsonValue` returned the last NESTED object.** Scanning backwards from
   the final `{` finds `"metadata": { … }`, which parses perfectly, so every field
   the caller wanted came back `undefined` — which reads downstream as "no session
   to resume", the same answer a fresh book gives. It now makes one forward pass
   and keeps the last span that opens and closes at depth ZERO.
3. **`--resume_session` and `--list_sessions` had been broken all along.** Both
   readers scanned stdout line by line calling `JSON.parse`; narrator and e2a both
   print `json.dumps(result, indent=2)`, where no line is valid JSON on its own.
   `checkResumeStatus` always returned "Failed to parse resume check output" and
   `listResumableSessions` had a comment claiming the output was "human-readable
   (not JSON)" and returned `[]`.

### Verified

- `npx tsc -p tsconfig.electron.json --noEmit`, `npx tsc -p tsconfig.app.json --noEmit`, `npx ng build` — clean.
- `node tools/run-keepers.js` twice — ALL KEEPERS GREEN.
- No `require("@shared/` in `dist/electron`.
- `tools/test-narrator-argv-snapshot.js`: six doors' flags, three arms' plans, plus
  the contract assertions (required flags present; no IGNORE-only flag sent; no
  ENGINE_NEAR_MISS; tools doors never WSL and never engine-named; every door
  reaches a module and no `.py`; PYTHONPATH set and guest-shaped in the guest;
  no `EBOOK2AUDIOBOOK_PATH`; no `--fake-engine`; argv AND env values translated).
- `tools/test-narrator-log-strings.js`: eight of narrator's real emitted lines
  through the four watchdog matchers, and narrator's source checked to still
  contain each one.
- `tools/smoke-narrator-tools-doors.js`: `--list_sessions` and `--resume_session`
  run through the real plan against a fixture session; the bridge's own compiled
  reader parses both.
- `tools/smoke-narrator-assembly.js`: the kershaw golden session assembled through
  the bridge's real plan — exit 0 in 67.6 s, native, no `NARRATOR_ENGINE`,
  **2615.4 s** (reference 2615.400), **133 cues** (reference 133, one per sentence
  FLAC), VTT byte-identical to `reference.vtt` modulo line endings (sha
  `a3789b4d…`).

### NOT verified — owed to the GPU window

**The GPU window happened on 2026-09-05.** See "The Windows/WSL GPU window" in the
proof ledger for the numbers; what each item below turned into:

- ~~**The prep and worker doors have never been RUN.**~~ **RESOLVED** — kershaw
  prepped and rendered end to end in WSL (133/133, 0 failed, 10.83x realtime), then
  resumed (132/133 skipped in 0.2 s).
- ~~The `GENERATION_ACTIVITY_RE` / `REPAIR_START_RE` matchers are pinned against
  narrator's SOURCE strings~~ **RESOLVED, and the answer needed both halves.** The
  bridge's five matchers were run over the live worker's STDOUT by
  `tools/smoke-narrator-watchdog-live.js`: the progress line and both model-load
  lines fired there and nowhere else. The two repair matchers fired ZERO times —
  which is the correct answer for a book that needed no repairs, and is what the
  keeper already asserts about a healthy vLLM batch. So "the watchdog fires" is
  proven for the three that must, and the repair ladder remains covered only by
  string agreement until a book actually needs one.
- **The Mac has run nothing of Phase 3** — still true for retake and serve; prep,
  worker and assembly are proven there (see the ledger).

---

## Higgs on Listen (2026-09-05)

Owen wants Higgs available for the browser extension, especially on the Mac. The
app side is built; the Mac half of it is blocked on narrator.

### One pool, two engines

`orpheus-worker-pool.ts` is not Orpheus machinery with a Higgs mode bolted on. It
speaks narrator's JSON-lines protocol, and which engine answers is
`NARRATOR_ENGINE` in the spawn — so the same object serves both and the difference
is confined to `buildSpawnPlan` and `resolveLoadPlan`. `setServeEngineProbe`
injects the selection (importing `streaming-engine.ts` back would be a cycle).

**The load message could not be guessed, and reading narrator settled it.**
`higgs_v3_config_from_worker_kwargs` refuses `modelDir`, `baseDir`, `adapterDir`
and `caps` one at a time, by name: the served model is the launch script's
argument, v3 has no shared-base split, there is no runtime LoRA for an adapter dir
to load into, and the Orpheus cap names mean nothing there. A Higgs load carries
THE VOICE NAME AND NOTHING ELSE (an empty caps object is accepted — it is the
pool's "no catalog tuning" signal).

**A Higgs voice change is a NEW WORKER.** `HiggsV3Engine.set_voice` refuses in
place: a fine-tuned v3 voice IS the merged checkpoint the server was started on,
and vLLM-Omni has no adapter flags. The pool tears the session down and restarts,
which rewrites the voice document. Orpheus's switches stay free.

### The gap/fade contract for a streaming client

Higgs's codec has no sound windowed decode (`HiggsCodec.streaming_decoder()`
returns None on purpose — its delay pattern leaves a window's last frames
incomplete by construction), so it cannot emit audio mid-sentence.
`generate_batch_stream` emits WHOLE ROWS at retirement instead, which is the
pool's existing `batch_chunk` / `batch_item` path unchanged: a sentence arrives all
at once rather than in slices. **A latency difference, not a missing feature** —
an earlier version of `streaming-engine.ts` refused the engine outright over it.

So for a client: keep the 0.3 s inter-sentence gap, and apply NO client-side fade.
The `edgeFadeMs` the `loaded` message carries (10 in / 25 out) is the ASSEMBLER's,
for joining chunks inside one sentence; a streamed row is already whole.

### Availability, and why the Mac says no today

`getAvailableEngines()` lists both rows always, with `available` and a `reason`.
Higgs needs three things and each is false somewhere real: a platform backend, its
environment, and an installed voice (a voice whose artifact is missing renders in
the model's own speaker — 12% of the narrator's ECAPA ceiling, a different person).

| platform | today |
|---|---|
| Windows + "WSL2 for Higgs" | available |
| Windows, toggle off | refused, naming the toggle |
| macOS | **refused** — v3's only backend is a vLLM-Omni server and there is no macOS build |

`higgsMlxBackendPresent()` DETECTS the in-process MLX backend landing, by content
under `engine/higgs/` (the filename is the other builder's to choose), rather than
hard-coding a `false` somebody has to remember to flip.

**THE BACKEND IS REAL.** `feat/narrator-higgs-mlx` shipped it in `59549b91`
("Higgs v3 runs IN THIS PROCESS on the Mac - mlx-audio, no server"), with
`engine/higgs/mlx_backend.py` and its own tests. An earlier draft of this section
called that branch a plan document; that read predated the commit and was wrong.

It is not merged into THIS branch yet, so the detector still reads false here and
the darwin row still refuses. When the merge lands, the picker turns Higgs on by
itself and `test-stream-engine-availability.js` fails loudly — its darwin case
asserts the detector is still false and says in its message that the case must be
rewritten.

### `NARRATOR_HIGGS3_MLX_MODEL`, and the one thing the summary got backwards

The in-process backend loads weights from a directory this variable names, and
`model_dir_from_env()` refuses BY NAME when it is unset: *"no default and no
search"*, because an engine that guesses where its weights are can render a whole
book in the wrong model and report success. So the darwin spawn sets it, host-
native (there is no guest on a Mac), beside `NARRATOR_HIGGS_VOICES`.

**It is ALWAYS THE BASE CHECKPOINT, never a voice's own merged directory.** The
brief described it as "the merged checkpoint dir for a checkpoint voice, or the
base dir for `default`", and narrator's own code says otherwise:

```python
# higgs_v3_mlx_config_from_worker_kwargs
checkpoint = getattr(resolved, 'checkpoint_dir', None)
return HiggsV3MlxConfig(voice=resolved,
                        model_dir=checkpoint or model_dir_from_env())
```

A `checkpoint` voice's weights come from `checkpointDir` IN THE VOICE DOCUMENT and
this variable is not read at all; a `default` or `clips` voice loads the base from
it. Setting it per-voice would therefore be ignored exactly where it looked
meaningful, and would load a fine-tune as "the base" where it was not. BookForge
sets `<userData>/runtime/higgs-models/base` — which on macOS IS
`~/Library/Application Support/BookForge/runtime/higgs-models/base`, the path
narrator's own refusal message points at, rather than a second convention.

The Mac also resolves Higgs to the **`narrator-mlx`** env, the same one the Orpheus
MLX arm uses — NOT the `higgs-env` component, which is the SERVED stack's
environment and has no macOS build. Resolving that would refuse a Mac that can
render perfectly well.

### What is NOT proven

Nothing about Higgs streaming has been RUN. The WSL serve spawn is pinned by
snapshot (`higgs:wsl` in `serve-spawn-base.json`) and the two native arms are
pinned as refusals, but no Higgs Listen session has started, loaded a voice or
produced audio.

**DEFERRED, not merely owed (Owen, 2026-09-05).** It was scheduled into the
Windows GPU window of 2026-09-05 and cut from it: the training session needed the
card back, and the run is to be made against the CERTIFIED PRODUCTION CHECKPOINT
rather than `/home/telltale/higgs_v3_merged/ds_ad4lm`. So the next attempt is
waiting on a checkpoint, not on a GPU. It is still the first live Higgs-on-Listen
anywhere whenever it happens — the Mac's has not run either.

One thing the same window DID settle for Higgs, without loading it: the darwin
availability row. `feat/narrator-higgs-mlx` merged in `bbe845b8`, so
`higgsMlxBackendPresent()` now reads TRUE by itself and the Mac's Higgs answer is
decided by the `narrator-mlx` environment like Orpheus's, not by a missing
backend. `test-stream-engine-availability.js` failed loudly on exactly the case it
said it would and has been rewritten to pin the new question.

## The proof ledger

Every door, and what has actually been RUN through it rather than reasoned about.

| door | Windows / WSL | macOS (MLX) |
|---|---|---|
| prep | **PROVEN** 2026-09-05 — WSL `orpheus_tts`, spawn shape exactly as designed, `--session_dir` present | **PROVEN** 2026-09-05 — spawn shape exactly as designed |
| worker | **PROVEN** — 133/133 chunks, 43.7 min of 24 kHz PCM_16 in 241.8 s = **10.83x realtime**, CUDA graphs captured, one-line result JSON, session cached resume-ready | **PROVEN** — 108/108 sentences, 40.3 min in 486 s = **4.97x realtime**, one-line result JSON, session cached resume-ready |
| retake | **PROVEN** — 3 scattered indices in 76.9 s incl. model load; every take differs from the live cache and the live cache is byte-identical after | owed |
| assembly (render) | **PROVEN** — kershaw golden, 2615.4 s, 133 cues, VTT byte-identical to reference | **PROVEN** — exit 0, m4b 40.35 min, cover, tags, manifest registered, sidecars refreshed |
| assembly (reassembly) | **PROVEN** — live render, m4b 2619.500 s, narrator's own VTT **133 cues (1 empty), one per FLAC** | **PROVEN** (same door, via `cli/orpheus-audiobook-render.js --assemble-only`) |
| resume / list | **PROVEN** — real doors, fixture session, read by the bridge's own parser; and live: **132/133 skipped in 0.2 s** | n/a (native both sides) |
| serve (Listen, Orpheus) | **PROVEN for the PROTOCOL** — real mistborn in WSL, both stream modes, `ready -> loaded -> audio -> batch_item -> batch_done`, child closed cleanly. The smoke tool's OWN exit code is not evidence from these runs: its watchdog overwrote it (see below), so **a clean `--real` exit code is still owed**. | **PROVEN** 2026-09-05 (Mac agent, 8db243b2, through the pool's own plan: `conda run -p narrator-mlx python -u -m narrator.serve`, `NARRATOR_ENGINE=orpheus`, deathstalker) — cold start 2.5 s, load 4.2 s, `ready -> status -> loaded -> audio -> batch_item -> batch_done`, **exit 0**, stdout JSON-only (engine logging on stderr). Single 2.15 s row at 0.64x realtime and a 2-row batch at 0.65x: the known MLX short-row physics, which fast-start exists for. The tool itself was dead on arrival on every host until the probe fix below; the Mac run went through an 8-line pre-load wrapper doing exactly what the fix now does. |
| serve (Listen, Higgs) | argv/env snapshot only — **deferred** to the certified production checkpoint (Owen, 2026-09-05) | MLX backend merged (339cd668); **never started** — the Mac has no copy of the certified checkpoint, and the served proof is owed on the PC first |

### The Windows/WSL GPU window, 2026-09-05 (08:06-08:45 local, ~26 min of GPU)

Everything below ran through BookForge's OWN spawn path — `cli/bookforge-tts.py
--audiobook` (which chains `prepareNarrationInput` -> `renderRangeHeadless` ->
`runFinalDenoise` -> `startReassembly`, the app's four calls), the bridge's own
`regenerateSentenceIndices`, and the pool's own `buildSpawnPlan`. No python
command line was typed by hand, with one exception noted below.

Book: kershaw (`Working Towards The Fuhrer`), voice **mistborn**, into an isolated
scratch library at `C:\tmp\narrator-smoke\wsl\lib` so the real library was never
written to.

**The prep spawn, verbatim** — compare with the Mac's, above:

```
wsl.exe -d Ubuntu bash -c 'export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 \
  NARRATOR_ENGINE=orpheus ORPHEUS_MAX_CHARS=430 ORPHEUS_DISABLE_EAGER=1 \
  VLLM_USE_V1=0 PYTHONPATH=/mnt/c/.../narrator-cutover/python \
  && cd ~ && conda run --no-capture-output -n orpheus_tts \
     python -u -m narrator.compat.app --headless --ebook <staged>.epub \
     --session <uuid> --session_dir <guest tmp>/ebook-<uuid> --language en \
     --tts_engine orpheus --device CPU --prep_only \
     --orpheus_model_dir /home/telltale/orpheus-models/mistborn \
     --fine_tuned mistborn'
```

Identical in shape to the Mac's, with the three arm-specific differences the
design predicts and no others: the WSL wrapper, `ORPHEUS_DISABLE_EAGER=1` (the
arm-aware CUDA-graph switch — this is what turns graphs ON), and `--device CPU`
where the Mac says `MPS`. `--session_dir` is present, which is the one fix
`compat/FLAGS.md` said the cut-over required. **`PYTHONPATH` is guest-shaped AND
points at the WORKTREE's `python/`, not the main checkout's** — run from the
worktree, the launcher resolves the repo it is actually in.

| measurement | value |
|---|---|
| chunks | **133** (see below) |
| generation | 133 converted, 0 skipped, **0 failed**, 241.8 s |
| worker process | 297 s (generation + model load + teardown) |
| audio | 2619.500 s = 43.66 min |
| realtime factor | **10.83x** on generation, 8.82x on the worker process, 4.77x on the whole `--audiobook` chain (549 s, including the narration-text model pass, prep, denoise and assembly) |
| CUDA graphs | **captured** — 35 shapes, `Graph capturing finished in 15 secs, took 0.16 GiB`, `enforce_eager=False` |
| VRAM peak | 16.4 GB rendering (`ORPHEUS_GPU_MEM_UTIL=0.54`, batch 64); 17.6 GB on the retake (batch 96); model weights 6.18 GB |
| retake | 3 indices, 76.9 s including a cold model load |
| resume | 132 of 133 skipped in **0.2 s** |
| serve, buffered | cold start 11.2 s, model load 30.5 s, batch of 2 rows = 17.02 s audio in 11.78 s = **1.45x realtime** |
| serve, token stream | cold start 10.0 s, model load 28.1 s, **21 `batch_chunk` slices** of 0.341 s, first at **0.7 s** after the request against a 7.0 s row; batch **1.38x realtime** |

#### 133 chunks, not 108, and the reason is the VOICE

The Mac rendered this book in 108 chunks and this run in 133. Neither packer
changed: `ORPHEUS_MAX_CHARS` is a per-voice registered cap, the Mac ran
**deathstalker** (`maxChars` 520) and this ran **mistborn** (`maxChars` 430). The
chunk count is a function of the voice, not of the platform or the port.

And 133 is the number the **e2a golden** has for this book — which was also
rendered with mistborn. So the ported packer reproduces e2a's chunking exactly,
for the same book at the same cap, which no snapshot could have shown.

#### The watchdog FIRES — not "the strings agree"

`tools/smoke-narrator-watchdog-live.js` ran the bridge's five real regexes over
the live worker's stdout, separated from its stderr by the bridge's own tags:

| matcher | on stdout | on stderr |
|---|---|---|
| `PROGRESS_LINE_RE` | **133** | 0 |
| `MODEL_LOAD_START_RE` | **2** (`Loading Orpheus TTS with voice 'mistborn'...`, `Loading Orpheus model with vLLM: …`) | 0 |
| `MODEL_LOAD_DONE_RE` | **1** (`Orpheus TTS Loaded!`) | 0 |
| `GENERATION_ACTIVITY_RE` | 0 | 0 |
| `REPAIR_START_RE` | 0 | 0 |

The two zeroes are the correct answer, not a gap: the keeper already asserts that
a healthy vLLM batch emits nothing `GENERATION_ACTIVITY_RE` matches, and this book
needed no repairs. The three that matter all fired, **on stdout**, which is the
only stream the bridge parses. The live progress line's capture groups were read
back as `(index, total, percent)` and checked for internal consistency.

That `MODEL_LOAD_DONE_RE` hit is the one that had to be seen rather than reasoned
about: `engine/log.py` now routes every engine line to a stream the HOST chooses,
and `compat/worker.py` opting into stdout is what puts `Orpheus TTS Loaded!` where
the bridge can see it. It does.

#### `normalizeWslSessionToWindows` ran, and assembly was native

The copy ran inside the guest (`wsl.exe … cp -r /home/telltale/… /mnt/c/…`),
`session-state.json`'s paths were rewritten to the Windows tree, the GPU lock was
released, and assembly then ran in the native tools env:

```
conda run --no-capture-output -p <e2a>\python_env python -u -m narrator.compat.app \
  --headless --ebook <staged>.epub --output_dir <staging> --session <uuid> \
  --session_dir <windows process dir> --device CPU --language en \
  --tts_engine orpheus --assemble_only --no_split \
  --sentences_dir <windows process dir>\chapters\sentences-denoised
```

Note `--tts_engine orpheus`: the hard-coded `xtts` literal is gone, and the value
comes from `narratorEngineId()` as Phase 3 designed.

#### Cue count: narrator writes 133, the pipeline ships 132 — on Windows too

Assembled to a scratch output dir, **narrator's own VTT has 133 cues, exactly one
of which is empty** — one cue per sentence FLAC, and the same shape as the golden
`reference.vtt`. The shipped `.m4b.vtt` has **132**.

This is the `mov_text` round-trip loss already documented above from the Mac,
reproduced independently on Windows on a different render. It is not narrator's
assembler and it is not the cut-over; it remains Owen's call.

#### The empty chunk is also the one that never resumes

Chunk 132 is a `[break]`-only silence chunk: 99 bytes, 0.100 s. On the resume run
the log says `resume: 133 cached sentence(s) found` and then
`resume: seeded 132/133` — BookForge's own seeding step drops it, so it is
re-rendered on every resume. It costs 0.2 s and nothing else, and it is the SAME
chunk the sidecar round-trip drops. Worth knowing that the two "off by one"s in
this book are one chunk, not two problems.

#### The serve door, with a real model

`tools/smoke-serve-spawn.js --real` runs the plan `buildSpawnPlan()` actually
returns — the WSL arm, no `--fake-engine` — and sends the load message
`resolveLoadPlan()` builds. Both are the pool's; the default of that tool stays
fake, because a GPU-free smoke is what it was written to be.

```
wsl.exe -d Ubuntu bash -c 'export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 \
  NARRATOR_ENGINE=orpheus VLLM_USE_V1=0 ORPHEUS_STREAM_BATCH=16 \
  ORPHEUS_STREAM_WARM_MAX=16 ORPHEUS_STREAM_RAMP=8 ORPHEUS_DISABLE_EAGER=1 \
  PYTHONPATH=/mnt/c/.../narrator-cutover/python \
  && cd ~ && conda run --no-capture-output -n orpheus_tts python -u -m narrator.serve'
```

`loaded` carried `backend: "vllm"`, `engine: "orpheus"`, `sampleRate: 24000`,
`pads: true`, `edgeFadeMs: {in: 0, out: 0}`, `voice: "mistborn"` — so
`activeSampleRate()` is reading a real engine's answer, not a default. CUDA graphs
captured here too (13 s, 0.16 GiB).

Both runs completed the protocol — every message the pool waits for arrived, in
order, and the child process closed on its own. **What was NOT established is the
smoke tool's exit code.** Its watchdog overwrote it in both runs, for the reason
in the next section, so the runs that printed `SMOKE OK` also exited 1. The
protocol evidence stands on the message sequence, not on `$?`; a clean `--real`
exit code is owed and is listed as such in the ledger.

#### A fourth bug, found after the window closed, in the smoke tool itself

`smoke-serve-spawn.js` never cleared its watchdog `setTimeout`. Node keeps the
event loop alive for a pending timer, so a run that finished perfectly printed
`SMOKE OK`, set `exitCode = 0`, and then sat in silence until the timeout fired
and called `process.exit(1)`. **A successful `--real` run reported failure**, and
the two chained invocations in this window each stalled ~15 minutes past their own
completion — long enough that the second one started after its output directory
had been cleaned up.

Latent before this phase (the fake path had a 180 s window and nobody watched the
exit code); `--real` raised it to 900 s and made it impossible to miss. Fixed by
clearing the timer in the `close` handler, and verified on the fake path: 4 s wall,
exit 0, where it previously took 180 s and exited 1.

**Two honesty notes about the serve figures above.** The buffered-mode numbers are
from the run read live at 08:41:45 and are attributable with certainty. The
streamed-mode numbers were also read live, from a complete log carrying the
`LOAD :` line that only the post-`resolveLoadPlan` code emits, mistborn's real caps
and a coherent vLLM load — so the measurement is real — but the run logs were
deleted during scratch cleanup before this bug was understood, so WHICH invocation
wrote it can no longer be established. And the timer fix is verified on the fake
path only: the GPU lock passed to the `higgs-v3-finetune` agent at 08:51:56, so the
card was not taken back to re-run it. The fix is in the engine-agnostic `close`
handler, which the fake path exercises identically.

#### A fifth, found by the Mac agent: the tool died before any spawn, on every host

The review fix round made the pool's engine probe REQUIRED (236558d0): a pool asked
which engine a spawn is for, with nothing registered, now throws instead of
answering `'orpheus'` silently. In the app `streaming-engine.ts` registers the
probe at module load. `smoke-serve-spawn.js` required the pool and nothing else,
so from that commit on it exited 1 in 0 s — "No streaming engine probe is
registered" — fake mode included, before it could spawn anything. Nothing in the
keepers ran the tool, so nothing noticed until the Mac agent ran it at ffca9398.
Fixed 2026-09-05 by loading `dist/electron/streaming-engine.js` before the pool,
exactly as the app does, rather than registering a probe of the tool's own; the
Mac's SMOKE OK above came through an 8-line pre-load wrapper doing the same thing,
and the fake path on Windows now runs to `SMOKE OK`, exit 0, in 3 s.

**Rate against speech.** A single short row runs at 0.61-0.65x realtime — below
speech — while a two-row batch runs at 1.38-1.45x. That is the shape the fast-start
design predicts: one row alone is dominated by per-request overhead, and the reader
only gets ahead by batching. What closes the gap for a listener is the token
stream: the first `batch_chunk` arrives **0.7 s** after the request on a row that
takes 7.0 s to finish, so playback starts at a tenth of the row's duration and the
remaining 20 slices arrive faster than they play.

### Deferred, not owed

**Higgs v3 served on Listen** was cut from this window by Owen: the training
session needed the card back, and the run will be made against the CERTIFIED
production checkpoint rather than `/home/telltale/higgs_v3_merged/ds_ad4lm`. The
argv/env snapshot remains its only proof. It is still the FIRST live Higgs-on-Listen
anywhere when it happens.

### Three more bugs the live proofs caught

The four in "Three bugs the live proofs caught" and the Mac's assembly-door
refusal were found the same way. These are this window's, and none of them is
visible without a running model.

1. **`smoke-serve-spawn.js` could never have executed the WSL arm.** Its inline
   Electron stub answered the repo path for EVERY `app.getPath`, including
   `userData` — where `tool-paths.json` lives. So `shouldUseWsl2ForOrpheus()` read
   false, `buildSpawnPlan()` took the NATIVE arm, and on Windows that refuses for
   want of an Orpheus env. Harmless while `--fake-engine` was forced (nothing read
   userData) and fatal the moment `--real` existed, which is the trap: the tool
   agreed with itself. It now borrows `USER_DATA` from `cli/electron-stub.js` so
   there is one answer.

2. **A hand-rolled load message is not the pool's load message, and narrator said
   so.** `{action: 'load', voice: 'mistborn'}` was refused BY NAME — *"Refusing to
   substitute 'leah'"* — because a custom voice needs `modelDir` (guest-shaped on
   the WSL arm), the voice TOKEN rather than the catalog id, and its per-voice
   caps. That refusal is the correct behaviour working: the alternative is a whole
   Listen session in the wrong speaker with no error. `resolveLoadPlan` is now
   exported and the tool calls it, so the smoke cannot drift from what Listen
   sends.

3. **`pushVoiceArgs` does not refuse an ABSENT voice.** Its "voice is not
   installed" guard reads `if (requested && !ORPHEUS_STOCK_VOICES.includes(requested))`,
   so an UNDEFINED `settings.fineTuned` skips the refusal, pushes no `--fine_tuned`
   at all, and the render proceeds in whatever the engine defaults to. The retake
   smoke hit this on its first run — it had guessed the settings field names — and
   the spawn line that came out carried no voice arguments and no complaint.
   Inherited rather than introduced by the cut-over, and left alone here because
   the blast radius (XTTS's genuinely voice-less case) belongs to Phase 5. Recorded
   because a silent wrong-voice render is the failure this file exists to prevent.

### Still owed after this window

- **Listen playback in the app**, on either machine. The pool's spawn, load,
  buffered batch and token stream are proven; a browser extension actually
  playing them is not.
- **The Mac has run nothing of Phase 3** — retake and the serve door there.
- **Higgs on Listen**, deferred above.
- The `--real` serve runs drove the protocol directly rather than through
  `orpheus-worker-pool`'s own `startSession`/`loadVoice`/`generateSentence`. The
  spawn and the load message are the pool's; the message pump is the tool's.

**ALL THREE narrator doors are now proven live on the Mac**, through BookForge's
own bridge rather than by hand: prep and worker via `cli/bookforge-tts.py`, and
assembly via `cli/orpheus-audiobook-render.js --assemble-only`.

One thing that run recorded which the Windows side cannot: the Mac's tools env is
the NAMED conda env `ebook2audiobook`, not a `python_env` prefix, because that Mac
has no prefix env to find. Both resolve through the same
`getPythonInvocation`/`resolveCondaEnv` seam, so the assembly door works either
way — and it is one more reason Phase 6 is a relocation rather than a rename: the
env's NAME is as machine-specific as its location.

The prep spawn, verbatim:

```
conda run -p narrator-mlx python -u -m narrator.compat.app --headless \
  --ebook ... --session ... --session_dir ... --language en \
  --tts_engine orpheus --device MPS --prep_only \
  --orpheus_model_dir <runtime dir> --fine_tuned deathstalker
```

Two things that run found which nothing else could have:

1. **A missing `bs4` in the `narrator-mlx` env** — an environment fact, fixed
   there, not a cut-over defect.
2. **The assembly door refused before its spawn line**, on a session that had just
   rendered perfectly. That WAS a cut-over defect and it was mine: the engine
   check read `session_state.json` (BookForge's sidecar, which `renderRangeHeadless`
   never writes) instead of `session-state.json` (narrator's own, written by every
   prep). See "Three bugs the live proofs caught" — this is the fourth, and the
   only one a snapshot could never have found, because both files exist and on the
   machine the sidecar is written on it is always there.

### The shipped sidecar has one cue fewer than the book has chunks

The Mac's m4b shipped a `.m4b.vtt` with **107 cues for 108 FLACs**. The missing one
is chunk #107, a 0.10 s `[break]`-only silence chunk — an EMPTY cue.

**It is not narrator's assembler.** Measured locally on the kershaw golden pair,
same book, both files on disk:

| file | cues | empty |
|---|---|---|
| `reference.vtt` (narrator's assembler) | **133** | **1** |
| `shipped.m4b.vtt` (what the pipeline shipped) | **132** | 0 |

133 − 1 = 132. The round-trip drops exactly the empty cue, and nothing else.

**It is the sidecar round-trip, and it is pre-existing.** `reassembly-bridge.ts`
embeds narrator's VTT into the m4b as a `mov_text` track, and on a successful embed
*deletes the staging copy* (`deleteSidecarsForM4b`, `sealVttSource = undefined`).
The bound sidecar is then re-EXTRACTED from that track:
`regenerateBoundSidecars` → `migrateVariant` → `extractVttFromM4b(m4bAbs)` first,
with `externalVttPath` used only when the extract yields nothing. `mov_text` has no
representation for a cue with no text, so the empty cue does not survive.

So the shipped sidecar is a lossy derivative of a lossless file the pipeline
deliberately deletes. That predates the cut-over — the golden builder measured the
same thing on e2a's outputs — and the audio, the durations and the embedded track
are all unaffected; only the sidecar's cue COUNT is.

**Worth changing, and not by me unannounced.** Training and debug tools want cue ↔
FLAC 1:1, and `migrateVariant` already takes an `externalVttPath`: passing
narrator's VTT as `opts.vttPath` and preferring it over the extract is a small
change. But it changes what the sidecar IS for every book, and the embed-only
doctrine (the embedded track is the truth) was a deliberate decision — so it is
Owen's call, not a cleanup.

## The review round of 2026-09-05 (no GPU)

The whole-branch review came back MERGE AFTER FIXES: one blocker, nine majors and
23 minors. All ten of the first two classes are fixed, each as its own commit with
a keeper where a keeper can pin it, and each keeper mutation-checked — the fix is
reverted and the row is required to go red before it is trusted.

**Everything in that round is KEEPER-LEVEL PROOF ONLY.** The card belonged to the
`higgs-v3-finetune` training session for the whole window and was not touched. So:

| fix | pinned by | still owed live |
|---|---|---|
| BLOCKER — `processDir` left on the guest after normalization | `test-assembly-after-wsl-normalize.js` (post-normalization fixture) | one in-app Windows/WSL render whose assembly reads a Windows `--session_dir` |
| darwin GPU-ownership blind to narrator | `test-gpu-ownership.js` (both sides of the fixture) | a real Mac render refusing to start onto a busy GPU |
| `pushVoiceArgs` absent-voice refusal | `test-higgs-engine.js` | — (a refusal; nothing to render) |
| `extension/` typecheck red | `test-extension-typecheck.js` | — |
| the guest sweep now really excludes `narrator.serve` | `test-wsl-sweep-serve-exclusion.js` (shipped fn, fake guest table) | a batch job ending while a Listen session plays, with the server surviving |
| worker count applied to the outgoing engine | `test-stream-engine-availability.js` (order, in dist) | — |
| availability gate skipped a missing row; `isEngineName` refused Higgs by name | same file, functional rows | **Higgs on Listen has never been started** — deferred to the certified production checkpoint |
| serve-engine probe defaulted to Orpheus | same file | — |
| host-separator check could not fail | `test-serve-spawn-env.js` | — |
| three `assert.ok(true)` rows | `test-narrator-refusal-surfacing.js` | — |

Two live items are owed from the round BEFORE this one and are not discharged
here: a clean `--real` exit code from `smoke-serve-spawn.js` (its watchdog
overwrote the one the 08:53 window produced) and the macOS retake door.

Of the 23 minors, 19 are fixed. Four are left, with reasons:

- **17 — ~250 lines of dead e2a/XTTS code in `electron/tts-bridge.ts`.** Real, and
  it is Phase 5's file. The file survives for one live call (`initializeLogger`);
  gutting it during a review round mixes a deletion nobody has reviewed into a set
  of fixes that have been.
- **30 — two meta-checks assert against an extractor's own source.** They pin the
  harness rather than the product, which is what they say they do; both are named
  as such in their own rows. Deleting them would remove the only guard on the
  extractor forcing `process.platform`, which is not checkable any other way from
  one host.
- **12's second half — an async `narratorReady`.** The 60 s main-thread freeze is
  cut to 15 s and the `indexOf` hazard is closed, but making the probe async is a
  change to an IPC contract and belongs with the bookshelf-thread work, not here.
- **23's third spelling.** The check now catches a kill pattern written as a
  quoted string or a regex literal. A pattern assembled at runtime from fragments
  would still pass; no such sweep exists, and a source scan cannot see one.

## What is left after Phase 3

**Phase 4 — bilingual assembly.** `parallel-tts-bridge.ts` still appends
`--bilingual` / `--bilingual_pause` / `--bilingual_gap` when a job asks for it,
and narrator REFUSES all three by name. That is deliberate: leaving them is what
makes the refusal reachable from the app rather than theoretical. Owen's ruling is
Branch A — the whole language-learning feature goes.

**Phase 5 — XTTS / F5 / Voxtral out of the root** (`feat/xtts-removal`, landing on
main BEFORE this branch). `xtts-worker-pool.ts`, `xtts-voices.ts`,
`custom-voices.ts`, the DeepSpeed probe, the component installers. Two things this
branch left for it:

- `pythonInvocation(ttsEngine)` survives with exactly ONE caller —
  `xttsDeepspeedAvailable`, the DeepSpeed probe Phase 5 deletes. Nothing else in
  the bridge resolves a python any more.
- `streaming-engine.ts` keeps its xtts arm. The only edit made here is the Orpheus
  availability probe, which now asks `narrator-spawn` the same question the spawn
  will ask — otherwise the Listen picker would report "Orpheus: available" on a
  Mac with no `narrator-mlx`.

### Phase 6 is a RELOCATION, not a rename

Measured on this machine, 2026-09-05:

```
e2a root  : C:\Users\tellt\Projects\ebook2audiobook
tools env : C:\Users\tellt\Projects\ebook2audiobook\python_env
tmp root  : C:\Users\tellt\Projects\ebook2audiobook\tmp
```

The tools environment — the bundled relocatable python that every assembly,
resume and list door runs in — physically lives INSIDE the ebook2audiobook
checkout, and so does the default sessions root. All six doors pass
`cwdHint: getDefaultE2aPath()`, which is that same directory.

So "remove e2a" is not finished when nothing spawns `app.py`. Deleting the
checkout today takes the python interpreter and the session scratch with it. Phase
6 has to MOVE the env and the scratch somewhere that is BookForge's, and the
`e2a-paths.ts` → `tools-paths-python.ts` rename is the small half of that job, not
the job. Until it happens, `getDefaultE2aPath()` names a directory that must
continue to exist even though nothing in it is run any more.

**Phase 6 — assets, packaging, names.** `E2A_TMP_DIR` is still the variable
`narrator.render.session_store.sessions_root()` reads, and `EBOOK2AUDIOBOOK_PATH`
still names the tools-env root in `tool-paths.ts` and in `packaging/`. Both are
renames, not behaviour, and both are Phase 6's. `e2a-paths.ts` becomes
`tools-paths-python.ts`; `packaging/stage-resources.js` stops copying an e2a
checkout; `packaging/env/ebook2audiobook-*.yml` becomes `narrator-tools-*.yml` and
gains `narrator-mlx.yml` plus its component installer.

**Not a phase, but owed:** every GPU proof. See "NOT verified" above.

### The merge with `feat/xtts-removal`, which is owed

That branch (Phase 5 + Phase 4) lands on main BEFORE this one. As of this writing
main is `aa8648a1` and does not contain it, so this branch is merged up to date
with main but NOT with it. Three collisions are known, and the resolution is
recorded here so it is mechanical rather than a judgement call at merge time:

1. **`streaming-engine.ts`** — take THEIRS. The streaming contract types move to
   `orpheus-worker-pool.ts` (`xtts-worker-pool.ts` is deleted), `StreamEngineName`
   becomes a one-member union, and their `getSelectedEngineName` migration
   (persisted `'xtts'` → orpheus, logged; an unknown id throws) is the behaviour
   that ships. The only edit this branch made to the file is the Orpheus
   availability probe — keep that.
2. **`parallel-tts-bridge.ts`** — take THEIRS for the deletions, MINE for the
   rewrites. Do NOT restore `xttsDeepspeedAvailable`, `probeDeepspeedCompat`, the
   two `XTTS_USE_DEEPSPEED` env spreads (this branch preserved all of them
   verbatim because Phase 3's rule was to change nothing it did not have to), or
   the `config.bilingual?.enabled` tail on the assembly argv (kept here so
   narrator's refusal stayed reachable — Phase 4 is what removes it, and their
   branch IS Phase 4). Keep this branch's door rewrites and its `--tts_engine`
   literal drop. `pythonInvocation` loses its last caller with the DeepSpeed probe
   and can go.
3. **`tools/test-orpheus-argv-snapshot.js` + `orpheus-argv-base.json`** — the
   keeper is DELETED (2026-09-05: it could not run at all, since Phase 3 replaced
   every door its anchors named, and a test nobody can run looks like coverage in
   a directory listing). Their regenerated assembly row is kept. The baseline
   survives as data; `tools/snapshots/README.md` records what it is and the one
   caveat on reading it.

Renames on their side that any surviving import must follow:
`bilingual-processor.ts` → `text-ai.ts` (`splitForTts`), `ll-jobs.ts` →
`mono-translation-job.ts`. Deleted outright: `xtts-voices.ts`,
`custom-voices.ts`, `voice-components.ts`, `installed-voices.ts`,
`deepspeed-xtts.ts`, `f5-env.ts`, `voxtral-env.ts`,
`language-pack-components.ts`, the catalog service, `sentence-alignment-window.ts`.

**After the merge, regenerate `tools/snapshots/narrator-argv-base.json`**: the
assembly row must carry no bilingual arm, because the bridge will no longer build
one.
