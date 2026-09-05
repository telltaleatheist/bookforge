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

- **The prep and worker doors have never been RUN.** They are GPU-bound; the
  training session holds `external-gpu-job.lock`. Owed: a WSL prep + render of a
  short book, and the kershaw golden resumed end to end.
- The `GENERATION_ACTIVITY_RE` / `REPAIR_START_RE` matchers are pinned against
  narrator's SOURCE strings, not against a live worker's stderr. A live render is
  what turns that from "the strings agree" into "the watchdog fires".
- The Mac has run nothing of Phase 3.

---

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
3. **`tools/test-orpheus-argv-snapshot.js` + `orpheus-argv-base.json`** — keep
   this branch's retirement header, and keep their regenerated assembly row. The
   header now says so.

Renames on their side that any surviving import must follow:
`bilingual-processor.ts` → `text-ai.ts` (`splitForTts`), `ll-jobs.ts` →
`mono-translation-job.ts`. Deleted outright: `xtts-voices.ts`,
`custom-voices.ts`, `voice-components.ts`, `installed-voices.ts`,
`deepspeed-xtts.ts`, `f5-env.ts`, `voxtral-env.ts`,
`language-pack-components.ts`, the catalog service, `sentence-alignment-window.ts`.

**After the merge, regenerate `tools/snapshots/narrator-argv-base.json`**: the
assembly row must carry no bilingual arm, because the bridge will no longer build
one.
