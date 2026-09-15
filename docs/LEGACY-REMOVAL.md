# Deleting the legacy local-render layer

Owen, 2026-09-15: *"Get rid of legacy logic. We've completely rebuilt the system, we don't
need legacy code hanging around."*

This is the removal order, what each deletion forces, and the refusal that replaces each
arm. It is written before the first deletion so that a half-finished tree is still
readable, and it is the record of the things that look legacy and stay.

## STATE, 2026-09-15 evening

**Stages 1-4 and 6 are DONE.** The switch, every venue arm, every `legacyLocal:`
dependency arm, the Settings checkbox, the IPC, the Listen facade's local backend, and the
keepers that pin all of it. Every act in the app is now *a Crucible server, or a named
refusal*.

**Stage 5 — the spawn layer itself — is HELD, by instruction, and it is not a stall.** On
2026-09-15 Crucible's `mlx-darwin` arm was found rendering ONE CHUNK AT A TIME because
nothing set `NARRATOR_HIGGS3_MLX_BATCH`; BookForge's own spawn has set it to 64 since
2026-09-05 (7x, measured). That is evidence Crucible may have been written fresh rather
than carrying BookForge's proven spawn logic across, and the batch width may not be the
only knob that got lost. So `orpheus-worker-pool.ts`, `narrator-spawn.ts`, `higgs-spawn.ts`,
`higgs-models.ts`, `orpheus-models.ts`, `orpheus-hf-catalog.ts`, `tool-paths.ts`'s WSL keys
and the WSL/worker halves of `parallel-tts-bridge.ts` and `reassembly-bridge.ts` are
**THE SURVIVING RECORD** of tuning measured over months. Nothing in the app reaches them
any more — they are unreachable, not live — and they are deleted once that audit says what
Crucible is missing and it has been carried across.

**A SECOND HOLD, 2026-09-15 evening: `electron/scripts/higgs/`, and above all
`serve_higgs_sgl.sh`.** Owen ruled that SGLang is the Higgs stack and that vllm-omni does
not work for Higgs at all. Crucible's `cuda-linux` TTS env is on vllm-omni today and is
being moved; **the SGLang launch script exists nowhere else** — narrator ships only
`serve_higgs_v3.sh` and its certified yaml as package data. That launcher's defaults ARE
the configuration (`HIGGS_SGL_CUDA_GRAPH_MAX_BS` defaulting to `HIGGS_MAX_NUM_SEQS`, the
0.60 memory fraction, the 7500 max-new-tokens) and the measured reasoning in its header is
what the port depends on. Nothing in that tree is deleted or rewritten here; it is released
only when narrator ships its own copy.

**And a boundary, since it has moved twice: `python/narrator/` is narrator's OWN source
and is not part of this layer.** Untouched.

Two consequences of the first hold, both deliberate:

  - `electron/streaming-engine.ts` keeps `setServeEngineProbe` / `setPersistedVoiceProbe`
    wired to the pool, labelled HELD. They start nothing; they are the half of the spawn
    record that lives in that file, and unwiring them would remove a line of it before
    anyone read it.
  - The `else` halves behind `venue.where === 'crucible'` in `parallel-tts-bridge.ts` and
    `reassembly-bridge.ts` are now UNREACHABLE (no venue can produce the legacy arm) but
    still compile. They go with the rest of stage 5.

## What is being removed

The layer `docs/CRUCIBLE_ROLLOUT_PLAN.md` §A2 names: *"the LEGACY SPAWN LAYER (WSL
narrator, local text engines, local VLM/RVC/align spawns) behind the ONE switch
`routing.legacyLocalRender`. That layer is deleted after Owen's in-app pass."* The in-app
pass happened (§0g). This is that deletion.

After it, BookForge has **no local Python narrator and no local weight management**.
Crucible owns both (`crucible/docs/PHASE15-HOST.md`; memory `crucible-phase15-one-door`).
Every act that used to have a local arm is now **Crucible, or a named refusal**.

## The one keeper — `epub-align`

`generate-sentences` with `method: 'epub-align'`
(`electron/whisperx-align-bridge.ts` → `electron/scripts/align_audiobook.py`) is **not
legacy — it is unmigrated.** Crucible has no `align-longform` job type; the spec is §B7 of
`docs/CRUCIBLE_ROLLOUT_PLAN.md` and it is **UNRULED**. Its `align` job takes one audio
input per chunk from a caller who already knows which seconds hold which sentences, which
is precisely what this act must DISCOVER.

So it keeps its local CPU/GPU spawn and it keeps the one non-server GPU row on the bench
(`shared/queue/slot-sets.ts`). Deleting that row would leave the step charging a set with
no slots — `slotsOf` answers 0 for a set that is not on the bench — and the scheduler would
never launch it, with nothing anywhere saying why. When `align-longform` is ruled and
built, the row empties on its own and the id goes with it.

**The row is therefore RENAMED rather than deleted.** With the narrator gone
`epub-align` is its only tenant, so `LEGACY_LOCAL_NARRATOR` became `LONGFORM_ALIGN_SET`
(`local-longform-align`, "the local long-form aligner") and
`legacySetCharged`/`legacyCharged` became `longformAlignCharged`/`alignerCharged`. A bench
row that names a tenant which no longer exists tells an operator the wrong thing about
their wait. An old `step.venue` carrying the previous spelling is read into the new set at
one door — a FILE migration, commented as such.

One known cost, reported rather than fixed: `gpuThermal` renders only on that row
(`isThisMachine` returns true for it alone), so this machine's card temperature is now
drawn only while an `epub-align` step is queued. The reading is about THIS MACHINE, not
about that step. The real fix needs the snapshot to carry which server name is this
machine's, which `electron/crucible/servers.ts`'s `serversOnThisMachine` now answers for
the scheduler — UNRULED for the bench, and deliberately not
built here.

Also out of scope, and untouched: data/format migrations that merely use the word "legacy"
(`legacy-epub-layout.ts`, `legacy-variant-migration.ts`, `manifest-migration.ts`,
`bookshelf-id-migration.ts`, `archive-migration.ts`). Those are about opening old FILES.

## Removal order

Each stage is committed on its own, so the tree is never half-deleted.

### 1. This document.

### 2. The switch

`legacyLocalRender` out of the routing record, the wire, the setter, the validation, the
IPC and the Settings checkbox:

| Where | What goes |
| --- | --- |
| `electron/crucible/routing.ts` | `RoutingRecord.legacyLocalRender`, `setLegacyLocalRender`, `invalid_legacy_local_render`, the `view()` field |
| `shared/crucible/settings-wire.ts` | `RoutingView.legacyLocalRender` |
| `electron/main.ts` | `crucible:set-legacy-local-render` handler |
| `electron/preload.ts` | `setLegacyLocalRender` bridge |
| `src/app/core/services/electron.service.ts` | the same |
| `src/app/features/settings/components/crucible-servers-panel.component.ts` | the checkbox and its computed |
| `electron/queue-engine.ts`, `electron/queue-ipc.ts` | the `legacyLocalRender` field on the routing host and the IPC view |
| `shared/queue/wait-for.ts` | `WaitForFacts.legacyLocalRender` |

**An old record carrying `legacyLocalRender: true` must never be silently honoured and
must never brick startup.** `Routing.read()` therefore **strips the key on read and says
so ONCE on the log, by name**, whatever its value. It is not a corrupt record (it was
valid when it was written), there is no migration prompt, and nothing rewrites the file
behind the operator's back. The next render then fails honestly with `no_enabled_server`
— which is the answer an operator can act on — instead of quietly taking a card.

### 3. The venue arms

Narrow the union type FIRST, then let `npx tsc --noEmit` enumerate the call sites. That is
the complete work list and it cannot miss one.

| Union | Arm removed | What replaces it |
| --- | --- | --- |
| `GenerationVenue` (`electron/crucible/generation-venue.ts`) | `{where:'legacy-local-narrator'}` | Answer 2 is gone; the record's answers 3 and 4 stand, and `no_enabled_server` / `no_reachable_server` are the refusals |
| `RunVenue`, `StepVenue` (`electron/crucible/step-venue.ts`) | the same | a row whose `waitForResolved` is `legacy-local-narrator` is refused `legacy_venue_retired` by name, never re-decided — re-deciding would send a half-rendered book to a different machine |
| `TextActVenue` (`electron/crucible/text-venue.ts`) | `{where:'legacy-local-engines'}` | forced by the switch's removal; §A2 names the local text engines as part of this layer. Refusal is `no_enabled_server` from the record |
| `VlmVenue` (`shared/vlm/conversion.ts`) | `{where:'legacy-local-narrator'}` | a typed endpoint in Settings → AI → Reading pages still wins and is untouched; with none, it is Crucible or the record's refusal |
| `WaitForVerdict` (`shared/queue/wait-for.ts`) | `{kind:'legacy-local'}` | a resolved `legacy-local-narrator` row HOLDS with a sentence naming the retirement |

`LEGACY_LOCAL_NARRATOR` the CONSTANT stays — see the keeper above. `waitForLabel` keeps a
line for it so an old row still reads as something.

### 4. The `legacyLocal:` dependency arms

Nine modules take a `legacyLocal` callback as the local half of a Crucible door. Each is a
literal fallback and each goes; the door then has one arm.

`electron/crucible/{asr,denoise,rvc,reroll}.ts`,
`electron/{denoise-job,rvc-job,correct-sentences-bridge,generate-sentences-bridge,coverage-align-job}.ts`,
plus `electron/vlm-convert.ts`.

Where the local callback was the whole implementation of an act (`deriveDenoisedSentences`,
`transcribeLocally`, `runCoverageAlignLocally`), the implementation goes with the arm
unless something else calls it.

### 5. The spawn layer

The dead halves behind `venue.where === 'crucible'` in `electron/parallel-tts-bridge.ts`,
`electron/reassembly-bridge.ts` and `electron/streaming-engine.ts`
(`legacySwitchIsOn`, `electron/crucible/stream.ts`'s `local()`), then every module that
becomes unreachable: the Orpheus engine (`orpheus-worker-pool.ts`, `orpheus-models.ts`,
`orpheus-hf-catalog.ts`) and whatever in `narrator-spawn.ts`, `higgs-spawn.ts`,
`higgs-doctor.ts`, `higgs-hf-install.ts`, `higgs-models.ts`, `tool-paths.ts` and
`components/component-manager.ts` nothing imports any more. Files are deleted outright; no
stubs.

**Orpheus is RETIRED, not silently dropped.** `shared/tts/engine-caps.ts` already keeps
`orpheus` as a `RetiredTtsEngine` so an old record parses and displays as "Orpheus
(retired)" (commits `c167d5ea`, `b593e56f`). That property is not part of the spawn layer
and must survive. The Listen/streaming picker is a SEPARATE union (`StreamEngineName` in
`electron/streaming-engine.ts`, `worker-config.service.ts`) and still names Orpheus; it is
retired the same way — kept parseable, not selectable.

### 6. Keepers — DONE

Twenty-one suites asserted the legacy path EXISTS. Each now asserts the new truth instead
of being deleted, and one is added that pins the ABSENCE:
**`tools/test-no-legacy-venue-doors.js`**, in the shape of `test-no-e2a-doors`,
`test-no-cloud-doors` and `test-no-enhance-doors` and for their reason — a deletion this
size comes back one option at a time. Half of it forbids (the field, the setter, the IPC
channel, the five venue-arm spellings, the door option); half INSISTS, because a
grep-and-delete pass aimed at the word "legacy" would take all four of: the record
migration, the retired venue's name, the `epub-align` row, and Orpheus's nameability.

`tools/fake-crucible.js`'s `legacyHost()` became `noServerHost()` — a host with NOTHING
enabled, so the branch those suites used to pin is now the one thing that must NOT exist.

Gate: `npx tsc -p tsconfig.electron.json` AND `-p tsconfig.app.json` (the solution-root
`tsconfig.json` has `files: []` and checks nothing), the keeper suite's EXIT CODE, and
`ng build` — plus a grep of `dist/renderer` proving the checkbox's sentence no longer
ships.

## Facts carried across, so a deletion does not lose them

A deletion that loses the reason a number is what it is costs more than the code it
removed — that is the failure mode that produced the 7x MLX regression. So before any file
goes, its header and comments are read for facts encoded nowhere else, and those are
carried here (history) or into whatever now owns the behaviour (live knowledge). Running
list:

**Carried already** — dropped from code in stages 2-6, recorded here:

  - **Higgs v3 ships exactly one backend: a vLLM-Omni SERVER, which has no macOS build.**
    That is why `higgsAvailability()` used to gate on `process.platform`, on the "WSL2 for
    Higgs" toggle and on `higgsMlxBackendPresent()` — the in-process MLX backend that
    would make Higgs a Mac engine was being written on `feat/narrator-higgs-mlx` and had
    not landed. Those checks are gone from `streaming-engine.ts` because they were the
    LOCAL spawn's question; the server that will run the engine answers it now. The fact
    is not obsolete: it is why an `mlx-darwin` Crucible and a `cuda-linux` one are
    different engines.
  - **A Higgs voice whose artifact is missing serves the model's own default speaker** —
    measured at 12% of the narrator's ECAPA ceiling, i.e. a DIFFERENT PERSON rather than a
    bad clone. This is why "no voice installed" is "not available" and not a warning. KEPT
    in `higgsAvailability()`'s comment, which is still the one place it is written.
  - **Higgs cannot stream sub-sentence audio and that is not a defect.**
    `HiggsCodec.streaming_decoder()` returns None deliberately: its delay pattern leaves a
    window's last frames incomplete by construction. Whole rows arrive at retirement
    instead — a latency difference, not a missing feature. An earlier build refused the
    engine outright over it. KEPT in the same comment.
  - **`legacyLocalRender` was ONE switch covering renders AND the four text acts**, and it
    kept its minted name deliberately (renaming it would have orphaned every record on
    disk to buy a spelling). Recorded in `routing.ts`'s `noteRetiredLegacySwitch` and in
    this document's stage 2.

**OWED before their files are deleted** — named by the Foundry/vLLM audit, 2026-09-15, and
not yet carried. Neither file has been touched by this campaign:

  - `electron/scripts/vllm/serve_text_vllm.sh`'s header holds **the reason the text server
    exists at all**: Ollama 0.33.3 refuses to decode the qwen35 architecture in parallel on
    its llama.cpp backend (`sched.go:509`), so `OLLAMA_NUM_PARALLEL=4` and Foundry's
    four-in-flight pool bought nothing — every text pass ran one request at a time on a
    24 GB card. It also records **458 blocks/min under vLLM against Ollama's 110**
    (Pokemon, 2026-09-08: 18.26 GiB of weights, a 22,420-token pool, 7 decoding + 3
    queued), why the served NAME encodes the dtype (`Qwen3.5-9B-bf16` — a server cannot
    report its precision, so two books cleaned at two precisions would otherwise be
    byte-indistinguishable in their records), why port 8300, and
    `--limit-mm-per-prompt '{"image":0,"video":0}'` — the checkpoint is multimodal and a
    text pass never uses the vision tower, which is the omission the audit just fixed on
    the Crucible side.
  - `electron/vlm-page-server.ts`'s **`RESERVE_CAP_MB = 12288`** holds an INCIDENT: sizing
    the reservation to the CARD (an idle 24 GB card → ~20 GiB) rather than to the model's
    need held the machine at 93% host commit all night on 2026-08-11 and OOM-killed bun,
    ffmpeg and python, because through WSL's dxg layer every reserved GiB is also backed by
    committed HOST RAM. If KV runs tight vLLM preempts and slows down, which beats the
    machine falling over. Crucible pins per-model numbers and leans on its admission guard
    instead — a defensible trade — but the host-commit hazard is recorded only in that
    prose. Its neighbours are measurements too: a 43.7 s cold start on this 3090 Ti with
    weights cached, a 15-minute budget because a FIRST serve also pulls ~5.7 GB.

## THE SPAWN LAYER'S RECORD — carried out of the files deleted 2026-09-15

Everything below was encoded ONLY in `orpheus-worker-pool.ts`, `narrator-spawn.ts`,
`higgs-spawn.ts`, `higgs-doctor.ts`, `higgs-hf-install.ts`, `orpheus-models.ts`,
`orpheus-hf-catalog.ts` and `electron/scripts/higgs/**`. Read out before they went, because
that is how a 7x regression happens: the number survives in one header and the
reimplementation never sees it.

**Crucible owns all of this now.** Where a row below disagrees with what a Crucible recipe
does, the row is the MEASUREMENT and the recipe is the thing to check.

### 1. The environment a narrator spawn was given — the highest-risk loss

**Serving (`higgsSpawnEnv`, `serve_higgs_sgl.sh`, `serve_higgs_v3.sh`).** These are the
numbers the SGLang port must match:

| Variable | Value | Why that value |
| --- | --- | --- |
| `HIGGS_SGL_MEM_FRACTION` | `0.60` | 24 GB card: the rest is the audio tokenizer, the codec and CUDA's own context. 0.85 OOMed. |
| `HIGGS_SGL_CUDA_GRAPH_MAX_BS` | defaults to `HIGGS_MAX_NUM_SEQS` | Two knobs that must not drift: graphs captured for a batch the server will never run are wasted capture time, and a batch wider than the captured graphs silently falls back to eager. |
| `HIGGS_MAX_NUM_SEQS` | `16` | The packer's own batch. |
| `HIGGS_SGL_MAX_NEW_TOKENS` | `7500` | ~50 s of audio at 25 Hz × 6 codebooks — over the longest legal chunk, so a cap-hit means a runaway rather than a truncation. |
| `NARRATOR_HIGGS3_MLX_BATCH` | `64` | **The 7x.** Measured 2026-09-05; unset on Crucible's `mlx-darwin` arm on 2026-09-15 and the Mac rendered one chunk at a time. |
| `NARRATOR_ENGINE` | `higgs` / `orpheus` | Which engine `python -m narrator.serve` starts. The pool is engine-agnostic; this is the only thing that decides. |
| `PYTORCH_NO_CUDA_MEMORY_CACHING` | `1` on win32 ONLY | On Linux it BREAKS CUDA-graph capture — model weights then report 0.00 GB. |
| `TORCH_CUDA_ENABLE_CUDA_GRAPH` | `0` win32, `1` elsewhere | vLLM CUDA graphs do not capture on native Windows; `enforce_eager` there is ~6x slower (15 s/sentence vs 2-3 s). |
| `CUDA_LAUNCH_BLOCKING` | `1` win32, `0` elsewhere | Pairs with the above. |

**The voices document.** A Higgs spawn is STARTED ON its voice — `set_voice` refuses in
place, because a fine-tuned voice IS the merged checkpoint the server booted and vLLM-Omni
has no adapter flags. `writeHiggsVoicesDocument` wrote that document before the spawn, and
`setPersistedVoiceProbe` existed so the first boot came up on the voice `loadVoice` was
about to ask for rather than the catalog's first entry and then restarting.

### 2. Measured numbers and their provenance

- **WSL2 vs native Windows for Orpheus: ~15 s/sentence → 2-3 s.** vLLM's CUDA graphs only
  capture on Linux. This is the entire reason the WSL route existed. A healthy capture logs
  `Graph capturing finished in 12 secs, took 1.88 GiB`; 0% capture with weights at 0.00 GB
  means the two environment variables above are wrong.
- **`WINDOWS_WORKER_STAGGER_MS`** — workers started simultaneously on Windows collided over
  conda temp files. The stagger was the fix, not a politeness.
- **vLLM pinned at 0.7.3, torch 2.5.1+cu121, numpy 1.26.4** for Orpheus. `pyannote-audio`
  4.x pulls torch 2.8.0 and breaks vLLM; 3.3.2 is the compatible pin and torch must be
  force-reinstalled after anything that moves it.
- **A Higgs voice whose artifact is missing renders the model's own default speaker** —
  measured at 12% of the narrator's ECAPA ceiling, i.e. a different person, not a bad clone.
  (Kept live in `streaming-engine.ts`.)

### 3. Incidents

- **The env rebuild wipes site-packages patches (2026-09-15).** `install tts --build
  --force` silently reverted the Higgs patches on both machines; the re-apply fix landed
  hours AFTER the Mac's rebuild, which is one of the two suspects for that day's Mac
  slowdown. Any env rebuild must re-apply patches or verify them.
- **CUDA-graph capture vs `PYTORCH_NO_CUDA_MEMORY_CACHING` (2026-06).** Setting it on Linux
  produced "CUDA error: operation not permitted when stream is capturing" and 0.00 GB
  weights. Platform-gated ever since.
- **Assembly finding the wrong audiobook.** Workers used WSL paths and assembly used Windows
  paths — two halves reading two filesystems. The fix was to move the FILES
  (`normalizeWslSessionToWindows`, copying inside WSL so ext4→/mnt is fast), never to route
  assembly through WSL "for consistency".
- **A `wsl.exe` command without `--exec` is run through the distro's default shell**, which
  expands every `$` before bash sees it. That made the Higgs doctor report a correctly
  patched env as missing both patches. Always `wsl.exe -d <distro> --exec bash -c`.
  (Pinned live by `tools/test-wsl-script-invocation.js`, which survives.)

### 4. Why this and not that

- **One pool object serves both engines.** It speaks narrator's JSON-lines protocol to
  `python -m narrator.serve`; which engine is on the other end is `NARRATOR_ENGINE` in the
  spawn. The difference lived in `buildSpawnPlan`, never in two pools.
- **Orpheus switches voices for free; Higgs does not** — see the voices document above. Any
  scheduler that assumes a cheap voice switch is assuming the Orpheus shape.
- **A guest GPU process is never SIGKILLed.** It wedges the WSL distro; the recovery is a
  reboot. Termination was always a graceful stop with a timeout.
- **The doctor was a separate ~1 s WSL round trip and was NOT run from status payloads** —
  `higgsAvailability()` is called from every `hello` and every status frame, so it trusted
  the toggle and let a misconfigured env surface at start with the doctor's own message.
  That trade is why an availability probe and a doctor were two different things.

### 5. What the Higgs doctor probed, in order — diagnostic knowledge

Each check's failure meant something different, which is the part that reads as trivia
until something breaks: the distro answers at all → the conda env exists → the interpreter
imports the serving stack → the site-packages patches are present (the check the `--exec`
bug broke) → the checkpoint is staged on this arm (`higgsCheckpointStagedOn`, `wsl` vs
`darwin`) → the reference clips are on disk. A failure at any rung names a different fix,
and a Crucible `doctor` that collapses them into one "not ready" loses that.

## If a deletion would strand a feature

`epub-align` is the one that was found before starting. Anything else that turns out to
have no Crucible equivalent is REPORTED and left standing, with the reason — not deleted,
and not given a stopgap.
