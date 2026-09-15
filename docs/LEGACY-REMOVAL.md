# Deleting the legacy local-render layer

Owen, 2026-09-15: *"Get rid of legacy logic. We've completely rebuilt the system, we don't
need legacy code hanging around."*

This is the removal order, what each deletion forces, and the refusal that replaces each
arm. It is written before the first deletion so that a half-finished tree is still
readable, and it is the record of the things that look legacy and stay.

## STATE, 2026-09-15 night — DONE

**Every stage is complete.** The switch, every venue arm, every `legacyLocal:`
dependency arm, the Settings checkbox, the IPC, the Listen facade's local backend, the
keepers — and, with Owen's authorisation on the night of the 15th, THE SPAWN LAYER ITSELF.

Owen, lifting the hold: *"is this legacy logic thats no longer necessary? remove it if it's
legacy. its just taking up space. that being said, the user should be able to pick the
engine (higgs) and the voice model. they can still do that right?"*

**They can, and it was verified by RUNNING rather than by reading.** The engine picker
answers `["higgs"]` and the voice picker answers ten voices from
`electron/data/higgs-models.json`. That is the boundary this deletion was not allowed to
cross, and it did not: what went is the machinery that DOWNLOADED weights and SPAWNED
processes, because weights are Crucible's now. The catalog is data and stays.

### What the hold was protecting, and why it could be lifted

The hold existed because Crucible's `mlx-darwin` arm was found rendering one chunk at a
time for want of `NARRATOR_HIGGS3_MLX_BATCH`, which suggested it had been written fresh
rather than carrying BookForge's proven spawn logic across. Four things closed that:
narrator now SHIPS the SGLang launcher as package data, Crucible's `cuda-linux` recipe
serves SGLang, the MLX tier table was transcribed into Crucible, and the reserved `local`
server was deleted so there is no local venue left for a spawn to serve. The record was
read out into this document's appendix first, in its own commit, before a byte was deleted.

### Files deleted

`orpheus-worker-pool.ts`, `orpheus-models.ts`, `orpheus-hf-catalog.ts`, `higgs-spawn.ts`,
`higgs-doctor.ts`, `higgs-hf-install.ts`, and all nine files of `electron/scripts/higgs/`.

### What was NOT deleted, and why

  - **`narrator-spawn.ts` stays.** It was on the list, and deleting it would have broken
    two things that are not legacy: `buildNarratorSpawn` builds the ASSEMBLY spawn, and
    `narratorPythonRoot` is read by `whisperx-align-bridge.ts` — the `epub-align` keeper.
    Only its WSL-crossing half goes.
  - **Four modules were extracted rather than lost**, because what they held was not spawn
    machinery: `streaming-contract.ts` (the shapes every Listen surface speaks, plus
    `STREAM_RAMP_WIDTH` — the pool's own header named this split as the thing to do when a
    second backend landed), `hf-token.ts` (a credential, not an Orpheus fact),
    `orpheus-assembly-tuning.ts` (per-voice gaps and filters for sessions rendered by the
    retired engine — audiobooks are never deleted and a re-cut must match the original),
    and `higgsModelForJob` / `HIGGS_VOICE_FLAG` into `higgs-models.ts`, where they were
    always catalog questions.

### Still standing, and why — the bridge's WSL machinery

`parallel-tts-bridge.ts` keeps a layer that is now PROVABLY DEAD rather than merely
unused, and it is worth saying exactly why it is dead, because that is what makes its
removal safe rather than hopeful:

  - `prepRunsInWsl(venue, …)` opens with `if (venue.where === 'crucible') return false`,
    and `GenerationVenue` has ONE member. It can no longer return true.
  - `sessionRunsInWsl(session)` is the same shape against `session.venue`.
  - So `sessionHomeFor`'s guest arm, every `if (sessionRunsInWsl(...))` branch, the WSL
    ebook staging, the guest sessions-root scan in the resume path, and
    `cleanupWslOrphanedProcesses` are all unreachable.

It was left in this pass for one honest reason: `tools/test-crucible-render-session.js`
drives `prepRunsInWsl` and `sessionHomeFor` with BOTH venues as its fixtures, and that
suite was being repaired concurrently. Collapsing the functions while another hand held
the test would have been two people editing one fact. **It is a follow-on, not a
survivor** — nothing about it is load-bearing.

ONE THING INSIDE IT IS NOT DEAD and must not be swept up with it: `higgsPrepEnv` still
calls `writeHiggsVoicesDocument`, `higgsSpawnEnv` and `higgsCheckpointArm`. Prep runs
NATIVELY on this machine for a Crucible render, and the voices document is how
`NARRATOR_SENTENCE_GAP` and the venue's band reach narrator's packer. Those three
catalog functions survive in `higgs-models.ts` for that caller alone.

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

**The full read-out is the appendix at the end of this file.** What follows here is the
summary; the appendix is every number, incident, argument and protocol rule the deleted
files held, in the five categories a reimplementation loses in.

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

# Appendix: the spawn layer's full record

The section above is the summary. This is the READ-OUT — everything the deleted files
said that is not derivable from code, in the five categories a reimplementation loses in.
It is long on purpose. The 7x MLX regression cost a day because one number lived in one
header; every number below is that shape.

**How to use it:** where a row disagrees with what a Crucible recipe does, THE ROW IS THE
MEASUREMENT and the recipe is the thing to check.

## A. The serving environment, verbatim

### `serve_higgs_v3.sh` — the vllm-omni stack

`HIGGS_ENV` is **REQUIRED, exit 5**. It had a default of `$HOME/anaconda3/envs/higgs3`
until 2026-09-13; that is one machine's conda layout, so a caller who forgot it got a
server from a directory nobody named.

| Variable | Default | Why |
| --- | --- | --- |
| `HIGGS_PORT` / `HIGGS_HOST` | `8095` / `127.0.0.1` | |
| `HIGGS_GPU_MEM_UTIL` | `0.35` | Stage 0 (talker). A fraction of the WHOLE card, and it is the KV budget ON TOP of weights — not a cap on the stage. |
| `HIGGS_CODEC_GPU_MEM_UTIL` | `0.10` | Stage 1 (codec decoder); no KV cache. |
| `HIGGS_MAX_MODEL_LEN` | `8192` | Stage 0 ONLY — applying it globally clamped the codec stage, whose profile value is 65536. |
| `HIGGS_MAX_NUM_SEQS` | `16` | |
| `HIGGS_DEPLOY_CONFIG` | `$(dirname $0)/higgs_default_frames7500.yaml` | **`${VAR-...}`, not `${VAR:-...}`, deliberately:** unset = take the certified profile; set-but-EMPTY = vllm-omni's own auto-discovered profile, chosen on purpose. That distinction is the only way the auto profile stays reachable. |
| `HIGGS_MODEL_DIR` | unset → HF cache snapshot | Set-but-missing is **exit 2, never a fallback to base** — "it is a different speaker". |

Exported unconditionally: `CUDA_HOME=$HIGGS_ENV/lib/python3.11/site-packages/nvidia/cu13`,
`CUDA_PATH`, `PATH=$CUDA_HOME/bin:$HIGGS_ENV/bin:$PATH`,
`LD_LIBRARY_PATH=$CUDA_HOME/lib:...`, `VLLM_USE_FLASHINFER_SAMPLER=0`,
`VLLM_ATTENTION_BACKEND=${...:-FLASH_ATTN}`, `VLLM_DISABLE_FLASHINFER_PREFILL=1`,
`TORCH_CUDA_ARCH_LIST=${...:-8.6}`.

Argv: `vllm-omni serve $MODEL --served-model-name higgs-v3 --trust-remote-code
--stage-overrides $STAGE_OVERRIDES --attention-backend $VLLM_ATTENTION_BACKEND
[--deploy-config ...] --omni`, where `STAGE_OVERRIDES` is
`{"0":{"gpu_memory_utilization":…,"max_num_seqs":…,"max_model_len":…,"attention_backend":…},
"1":{"gpu_memory_utilization":…,"max_num_seqs":…}}`.

A bare profile NAME is refused (exit 4): `config_factory._load_user_deploy_config` joins a
bare name to the deploy dir **without appending `.yaml`** (measured 2026-09-05).

### `serve_higgs_sgl.sh` — the sglang-omni stack

| Variable | Default | Why |
| --- | --- | --- |
| `HIGGS_SGL_ENV` | `$HOME/anaconda3/envs/sglomni` | Cannot share `higgs3`: python 3.12 + torch 2.13.0+cu130 + sglang 0.5.18 + sglang-omni 0.1.4 + flashinfer 0.6.17 vs python 3.11 + vllm-omni 0.28.0. Installing either into the other's env replaces the resolver's answer for torch and breaks both. |
| `HIGGS_SGL_PORT` | `8200` | So a server on this stack can never be confused with vllm-omni's 8095. |
| `HIGGS_SGL_MEM_FRACTION` | `0.60` | ONE fraction for the whole engine, unlike vllm-omni's two stages. Measured: holds ~19 GB of a 24.5 GB card at 16 in flight; CUDA graphs captured on sm_86 (prefill + decode + **150 codec graphs**); health at **~110 s**. |
| `HIGGS_MAX_NUM_SEQS` | `16` | The SAME variable as the other launcher — server admission width AND narrator's batch width, one number so they cannot disagree. |
| `HIGGS_SGL_CUDA_GRAPH_MAX_BS` | `$HIGGS_MAX_NUM_SEQS` | Separate because it is a **capture budget**, not a scheduling limit; graphs cost VRAM at startup. The catalog ships them equal. |
| `HIGGS_SGL_MAX_NEW_TOKENS` | `7500` | Applied as `min(request, this)`. **Not the real per-request ceiling** — that is the hard-coded 4096-token context (prompt + max_new_tokens), which narrator sizes against via `sgl_served.frame_cap`. |

`HIGGS_MODEL_DIR` here is **the only identity this server has**: sglang-omni's `/v1/models`
answers `ModelCard(id=model_name, root=model_name)` — the served name in both fields, never
the path — so narrator reads `HIGGS_MODEL_DIR` back out of `/proc/<pid>/environ`. It must be
EXPORTED, not merely used.

`--model-name higgs-v3-ds` is deliberately different from vllm-omni's `higgs-v3`: it is the
`model` field of every request and the id `/v1/models` reports, so a leftover server on the
wrong port is caught before a book renders against it.

### Every narrator spawn, both arms

`PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`, `PYTHONPATH=<narratorPythonRoot()>` —
**not `pip install -e`**: `-m` resolves the module before any of its code runs, so narrator
cannot bootstrap its own `sys.path`. `NARRATOR_ENGINE` is set only when an engine is named,
and BookForge's id and narrator's differ on purpose: `orpheus` → `"orpheus"`,
`higgs` → **`"higgs-v3"`**.

Native arm adds `NARRATOR_SESSIONS_ROOT` (**omitted, never substituted, when its volume is
not mounted**; it was `E2A_TMP_DIR` until Phase 6 and narrator refuses that old name BY
NAME), `CONDA_PREFIX`, and a `PATH` prepended with ffmpeg's directory — a packaged app
launched from Finder/Explorer inherits a minimal PATH and narrator's assembly shells out.

**Nothing crosses the WSL boundary unless written into the `export` line** — never
`process.env` wholesale, and explicitly never the old `forwardKeys` allowlist, on the
argument that *"an allowlist is a list of variables somebody remembered, and the ones that
matter are the ones nobody did."* Guest shape:
`export K='v' … && cd ~ && '<conda>' run --no-capture-output -n '<env>' python -u -m <module> '<arg>' …`
under `wsl.exe -d <distro> bash -c`. `cd ~` because cwd must EXIST inside the guest — a
translated Windows path may not be mounted.

### The Listen server and the Higgs doors

`VLLM_USE_V1=0` — streaming applies per-request logits processors (the EOS boost), a
**V0-only** feature; without it a future vLLM bump breaks ONLY streaming.
`ORPHEUS_DISABLE_EAGER=1` on the WSL arm turns CUDA graphs on and is "the whole reason
Orpheus uses WSL". `ORPHEUS_MLX_CACHE_LIMIT_GB` bounds the freed-buffer cache for the
**resident** server — unbounded it balloons to tens of GB and STAYS, which is worse for a
pinned process than for a batch worker.

`--fake-engine` is an **argv flag rather than an env var precisely so a spawn cannot enable
the sine-tone stand-in by forwarding `process.env`.**

`NARRATOR_HIGGS_VOICES` names a voice document written PER RUN, because a v3 server is
*started on* its voice. `NARRATOR_SENTENCE_GAP` is **prep-door only** and overrides
`text.gaps.classify_gap`'s hardcoded **0.6 s** floor; Higgs is `pads=false`, so every chunk
join IS that number plus the model's own tail, and the catalog's `injectS` is already net of
the tail. A voice with no `chunkGap` sets nothing and is byte-identical to before.

`NARRATOR_HIGGS3_MLX_BATCH` — narrator's Higgs MLX backend **renders one row at a time
unless asked (default 1)**. The serve door takes the pool's ceiling PASSED IN and **refuses
by name if not supplied** rather than defaulting to the worker's width — "the inert-knob
failure in its quietest form". This is the 7x.

`--higgs_voice` is **NOT `--fine_tuned`**: the latter is an Orpheus voice TOKEN riding in the
prompt, the former a CATALOG ID indexing the voices document. Engine-id near-misses
(`higgs`, `higgs-v2`, `higgs_v3`) are refused BY NAME; no spawn site may pass
`settings.ttsEngine` through — it must pass `narratorEngineId()`.

## B. The measurements

**The stage-fraction ladder** (owens-pc, RTX 3090 Ti 24.5 GB, vllm-omni 0.28.0, 2026-09-05):

| talker + codec | Result |
| --- | --- |
| `0.60 + 0.25` | 24,274 MiB in use, WDDM paging into shared system RAM, render fell ~8 → ~2 chunks/min |
| `0.55 + 0.15` | 24.0 GB — still paging |
| **`0.35 + 0.10`** | **18.7–19.2 GB, 11,387–11,584 chars/min across three runs at 16 concurrent. Shipped.** |

At 0.35+0.10, **32 concurrent filled the card and stalled** — the other half of why
`HIGGS_MAX_NUM_SEQS` is 16.

**The stack bake-off** (2026-09-05; same 50 packed chunks, same checkpoint, same sampling,
one seed) — this is the measurement behind Owen's SGLang ruling:

| Stack | Early stops | Damaged | Voice switches | Throughput |
| --- | --- | --- | --- | --- |
| vllm-omni 0.28.0 @16 | 4 | 13/50 | 6 | 10,752 chars/min |
| **SGLang-Omni 0.1.4 @16** | **0** | **5/50** | **0** | **26,666 chars/min** |

vllm-omni's batched talker corrupts the newest batch row; SGLang-Omni does not.

**`max_tokens: 2048` in the auto-discovered deploy profile is an 81.92 s hard ceiling on
every render**, and the served speech endpoint **ignores a per-request `max_tokens`** — no
request parameter can raise it. 7500 frames = 300 s. That is what the certified profile buys.

**Hashes that are the identity of a measurement**, not decoration:
`higgs_default_frames7500.yaml` sha256 `24d288f193eaa8c5c10387d890b648949b88e8d357a3779e8c9487f9d38c7481`
(pinned to LF in `.gitattributes` — a CRLF checkout parses identically as YAML and is no
longer the file any cap certificate was measured against). Sentinel patch: pristine
`higgs_audio_v3.py` `376ca5647773cb191634b266b03bfefe490c080ef9f75aed045f1f31c9a19fb4`,
v2 output `0b36f650…`, v3 output `3cb29e6a735b026972d78844c7b05859aca481a1a5f9dfeb195f213f870375a8`.
**The check to repeat before trusting any future number: measure `.orig` FIRST — if it is
not `376ca564…` the package moved and both patched hashes describe a file that no longer
exists.**

**`HIGGS_MLX_AUDIO_VERSION = 0.4.8` is exact, not a floor:** 0.5.1 cannot render Orpheus at
all, 0.3.x drags mlx-lm below the batched fast path, 0.4.8 is the one release that renders
both engines.

**Listen batch width — three different numbers for three different reasons.**
`STREAM_BATCH_CEILING_DEFAULT = 16` (M1 Ultra 64 GB, deathstalker, ~135-char sentences):
realtime factor 4 → 0.84x (loses to playback), 8 → 1.53x, 12 → 2.15x, 16 → 2.80x. The
physics: **a row decodes at ~17–20 steps/s regardless of width**, so a batch takes ~30–43 s
wall at ANY width — width buys aggregate throughput, not latency, and narrow is the worst of
both worlds (same wait, a quarter of the cushion). On darwin the ceiling is the machine's
MLX tier width, not 16: measured 12.4 sent/min at 16, 22.8 at 48, 27–29 at 96 — pinning the
resident server at 16 while the audiobook path ran 96 is **why read-ahead could not stay
ahead of playback**.

`STREAM_RAMP_WIDTH = 8` is flat and deliberately not the ceiling (measured 2026-08-31):
12.7 chars/s at 1 row, 30–33 at 8, 41.8 at 32 — but a batch is ATOMIC to the listener, so
width 8 → ~48 s wall / ~75 s audio, width 16 → ~83 s / ~150 s, width 32 → ~150 s wall. A
doubling ladder (8→16→32) starved a ~75 s buffer with a ~150 s batch and **stopped playback
dead mid-article on its first real article.** 8 is the smallest width that clearly beats
speech rate.

`HIGGS_STREAM_BATCH_WIDTH = 1` (measured 2026-09-11, deathstalker/MLX/M1 Ultra): solo rows
of 65/116/197/319 chars → 1.8/2.1/2.1/2.0x realtime; a 4-row group is **exactly as fast as
four solo rows back to back**. Width buys Higgs nothing at Listen depths, and what a group
COSTS is atomicity — measured, a 7.5 s opener landed at 3.6 s while rows 1–3 landed at
13.0–13.9 s, **a ~2 s hole after the first sentence and ~8 s at paragraph length.** This one
number is simultaneously the scheduler's in-flight depth, the pool's dispatch width,
`NARRATOR_HIGGS3_MLX_BATCH` on the serve door, and the extension's `deviceWorkers`.

**Warming every width measured 176 s of a 184 s load**, which is why only width 1, the ramp
width and the full width were pre-warmed. A lazy MLX compile is **~10 s once per unseen
batch shape** (mlx-lm 0.31.3 right-pads batch prefills). A first load's discarded warm-up
renders cost **~40 s** against the same ~10 s absorbed by the first real batch — which is
what `LoadVoiceOptions.warm` decides.

**`FLUSH_GRACE_MS = 25`** — the extension sends the playing speak and its read-ahead speaks
as separate WebSocket messages a few ms apart; a 0 ms flush races them and a ramp-fill row
that misses it **waits out the entire ~28 s batch it existed to ride**. Against 20–40 s
renders, 25 ms is noise.

**`FALLBACK_SAMPLE_RATE = 24000`** — both shipping engines are 24 kHz, so this changes
nothing today; the guard exists because every duration is `bytes / (rate * 2)`, so a 44.1 kHz
engine read as 24 kHz would report every sentence at **~1.8x its real length** and the
scheduler would run the buffer dry while insisting it was ahead.

**Two more that died with the local worker**, recorded because each is a measurement
rather than a round number: `WORKER_PROGRESS_TIMEOUT_MS = 12 min`, widened from 5 because a
legitimate MLX batch on a slow voice under GPU contention can run several minutes between
per-sentence lines — the 5-minute version killed healthy renders; and
`RENDERED_POLL_INTERVAL_MS = 4000`, the Mac/MLX rendered-file poller's interval, which
existed because stdout would not mention a bucket completion for minutes.

**Timeouts, each a diagnosis rather than a budget:** load 15 s warm / 180 s cold (a
registration is a dict write; a construction pays ~6 GB + graph capture), worker `ready`
120 s, batch 180 s, stream 120 s, guest exit 5 s after `quit`, guest destroy grace 20 s,
`taskkill /F /T` 5 s, `hostPrepRefusal` probe 60 s, `PROBE_TIMEOUT_MS` 10 min ("a wedge
detector, not a budget"). Higgs cold start ~55 s warm, up to ~300 s cold.

**Orpheus specifics worth keeping:** merged vs base+adapter are the same weights — verified
2026-08-09 by range-reading the deployed checkpoints, **28.3 M sampled elements per voice,
zero differing**. `merged` is the default because a warm LoRA switch still waits ~20–30 s
while the LoRA path costs **~10–20% more GEMMs on every token**. `ORPHEUS_STREAM_MAX_CHARS
= 450` deliberately above the batch default of 350; the "450 fails everywhere" verdict was
reached against a fleet including rohan-v2, since proven a broken training recipe —
deathstalker/owen/thirdreich were **0/126** on the chunks that broke it. vLLM 0.7.3 applies
repetition penalty over the WHOLE sequence and locks an EOS-weak fine-tune into an infinite
silence-frame loop at 1.1; 1.15 breaks it, 1.2+ overshoots to early-EOS; **MLX's 20-token
window renders clean at 1.1 and must not inherit the higher value.** `eosFloor 0.55` is the
measured line between honest fast reads (≥0.75 of expected) and truncations (0.3–0.6).
`minChunkGap` measured over **1151 chunks of The Mysterious Stranger**: median 0.81 s,
p10 0.39 s, min 0.00 s.

## B2. OWED NEXT — `electron/orpheus-memory.ts`, not yet harvested

It was not on the deletion list and it holds the TIER TABLES every number above is sized
against — `VLLM_TIERS` (`extreme: capMB 18432, marginMB 1024, ceiling 0.95, vllmBatch 96`)
and the MLX tiers (`extreme: batchSize 64, cacheLimitGB 8, memBudgetGB 42`;
`fast: 72/8/34`; `moderate: 48/6/22`; `light: 24/3/13`). Those are what
`ORPHEUS_MLX_CACHE_LIMIT_GB`, `ORPHEUS_MLX_MEM_BUDGET_GB`, `ORPHEUS_GPU_MEM_UTIL` and
`NARRATOR_HIGGS3_MLX_BATCH` are filled from, so they are the same class of fact as the 7x.
**Harvest this file before it goes**, whether or not it is deleted in the same pass.

## C. Incidents

- **2026-09-14 — a Crucible-bound prep was sent into the guest.** `narratorRunsInWsl`
  answers for the ENGINE, and the engine's env is a guest env, so a render going to a
  Crucible server still wrote its session to ext4 and had to be copied back. The copy is
  where it died: the library is on a network drive and the guest's `/mnt/z` was a stale,
  root-owned mount point (measured that night: `test -d` yes, `mountpoint -q` no).
- **2026-09-06 — a whole article failed in one second.** Each prefetch speak arriving during
  the ~40 s cold load saw no voice loaded and **restarted the worker that was loading it**.
  Fix: join an in-flight load BEFORE any teardown.
- **2026-09-06 — every cold Higgs start spawned twice**, because the test was
  `currentVoice !== wantHiggs`, true of a freshly spawned worker.
- **2026-09-06 — cold Listen loaded the wrong checkpoint twice.** With nothing loaded,
  `getDefaultVoice()` answered the catalog's FIRST renderable voice (the zero-shot base), so
  every cold start loaded the base, was told the user wanted deathstalker, and restarted —
  two checkpoint loads in series in front of the first sentence, for a voice nobody asked
  for. That is what `setPersistedVoiceProbe` exists for.
- **2026-09-05 — `ModuleNotFoundError: No module named 'bs4'`.** The installer installed
  vllm-omni and nothing else; narrator reaches the env over `PYTHONPATH`, never pip, so
  nothing ever resolved its dependency list there. **`regex` is the same shape and its
  pyproject declaration is STILL OWED** — six `narrator/text/*.py` modules import it at
  module scope and it is not in `python/pyproject.toml`.
- **The launcher "only if absent" bug.** The env's copy became a snapshot of the day it was
  built; every later fix shipped in the repo and was read by nobody, while the doctor's
  `test -x` reported the stale copy as ok.
- **`patch_vllm.py` patched from `.orig` instead of the live file**, so after a pip upgrade
  it **wrote old content back over the new site-packages file** — and the doctor's marker
  grep then certified stale code as patched, all-green, silently.
- **The chunk-tail "electronic syllable".** v1 kept upstream's order (substitute, then trim),
  so by the time the identity trim ran every sentinel was already code 0. **397 of 401
  requests** logged the warning.
- **The doctor certified an env by recognising a sentence** — the staleness marker was a
  fragment of a warning FORMAT STRING, so re-wording the warning would report a correctly
  patched env as stale.
- **narrator's own proof grepped the server's LOG FILE**, making vLLM's log formatter an API,
  and carried a v1 expectation so it passed both on an empty log and on a log full of the
  exact lines the patch exists to eliminate.
- **2026-08-03 — the `\\wsl$` LX-symlink.** Over the 9p mount Windows surfaces a WSL-native
  symlink as a reparse point it refuses to resolve: `readdir` on the parent reports
  `isSymbolicLink()`, while stat/readdir/readlink of the link itself fail **ENOENT, ENOENT,
  EISDIR**. Hence the `unverifiable` state, and it is win32-only — anywhere else an
  unstattable symlink is simply broken.
- **The half-downloaded base.** Two shards, so a download killed between them satisfies
  "config.json + at least one .safetensors" and reads as INSTALLED. Fix: when
  `model.safetensors.index.json` exists, EVERY shard it names must be present and non-empty.
- **A Higgs checkpoint without `generation_config.json`** samples the untruncated codebook
  tail — top_k disabled, prompts over ~600 chars derail into babble (2026-09-05).
- **The Mac's phantom WSL diagnosis.** One doctor answered every platform, so a Mac that
  renders Higgs fine displayed *"The Higgs environment is not ready … : WSL distribution."*
  The mirror bug: `higgsEnvironmentRefusal` returned `null` on darwin having checked
  **nothing** — an unchecked pass that lets a job start and fail an hour in.
- **The WSL kill pattern went stale at the cut-over.** Nothing FAILS when a kill pattern goes
  stale: the sweep reports success, matches nothing, and leaves ~6 GB of VRAM held — the
  exact shape that wedges the VM.
- **A microtask flush shipped every streaming batch one row short**, because the queue is
  refilled from promise continuations and a microtask flush runs before them. It must be a
  macrotask.
- **Worker death left `currentVoice` set**, so the next load short-circuited "already
  loaded", the fresh worker never received one, and every generation failed "Model not
  loaded" until the user restarted.
- **`serveEngineProbe` used to default to `() => 'orpheus'`**, turning a dropped registration
  into "a Higgs selection rendering an entire session in Orpheus, silently, with the app
  reporting Higgs throughout."

## D. Why this and not that

- **A phase with no engine is not a phase with a default engine.** Assembly/resume/list are
  engine-agnostic; naming an engine on one is refused rather than ignored, because "ignored"
  would silently route an assembly into a 6 GB vLLM env.
- **`align` is engine-refused yet can still cross into the guest.** It is ABOUT an engine but
  does not RUN one; the post-render alignment runs BEFORE the session is normalised, so the
  audio is still on ext4 and the qwen3 env is a WSL env. A NAME is passed rather than an
  engine, because naming an engine would resolve `narrator-mlx` on the Mac — the render's
  env, with no aligner in it.
- **`onHost` uses the TOOLS env, not "the engine's native env"** — on Windows there is no
  native engine env at all. **RULING OWED:** on macOS this moves a Crucible-venue prep out of
  `narrator-mlx` into the tools env, which is unmeasured for `regex` / `iso639-lang`.
- **`hostPrepRefusal` measures rather than infers** — it imports the exact modules the prep
  door imports, with the same PYTHONPATH, BEFORE the job holds a GPU lease.
- **One worker, always.** vLLM and MLX both saturate the single GPU and batch internally;
  extra processes duplicate ~6 GB and fight over the device.
- **The backend is ASKED, not derived** — deriving from `process.platform` would be a second
  implementation free to drift. **Unknown is not a waiver**: every consumer treats `null` as
  "not vLLM", because per-request voices and mixed-voice batches are vLLM-only.
- **A batch may only be cancelled when EVERY remaining row is stale** — one batch mixes
  sessions, and a row with no `isCancelled` predicate counts as LIVE.
- **`canServeVoicePerRequest` is a waiver, so unknown means exclusive.** On MLX a mismatched
  row does not produce a wrong voice, it produces a FAILED one.
- **An unknown voice id is rejected loudly** — the Python worker's allowlist would silently
  downgrade it to the default voice: wrong voice, no error.
- **Teardown discipline:** cooperative `quit` on stdin first (breaks the loop → normal exit →
  atexit CUDA cleanup releases the GPU from INSIDE the guest), then SIGTERM, then VM
  terminate. **NEVER SIGKILL in the guest** — force-killing a process kernel-stuck in a dxg
  GPU wait is what wedges the VM. **Never taskkill the `wsl.exe` wrapper while the guest
  process is alive.** **No global `pkill vllm`** — it used to hit batch workers too.
- **Step DOWN a memory tier rather than refusing.** The whole tier mechanism is
  **Orpheus-only** — it sizes vLLM's `gpu_memory_utilization`, a knob Higgs does not have.
- **Sentinel filtering by TOKEN IDENTITY, never position.** `0 is a valid codec code`, so
  substituting a sentinel with 0 converts it into real sound; codebook c is delayed by c
  positions, so sentinels smear across the last **Q−1 = 7** frames and trimming one leaves
  ~6 frames of garbage. **No fade is added** — that would be a content-domain fix for a
  token-domain defect.
- **The deploy profile is a FILE, not a site-packages edit** — a pip upgrade reverts a write
  silently, and a file **can be hashed**, which is what training certificates bind to.
- **Both patches must be re-applied after any pip upgrade**, which is why the doctor greps
  markers on EVERY check. Without `patch_vllm.py` every voice-clone request returns HTTP 400;
  without `patch_sentinel_filter.py` every chunk ends with **~240 ms of audible garbage**.
- **`grep -qF` (fixed string) for `[:, :-1]`** — as a basic regular expression that is a
  bracket expression matching one character, and would match nearly every line.
- **`python*` is globbed and deduped by REAL path** — conda ships a `lib/python3.1 →
  python3.11` symlink, so a naive count refuses a normal env.
- **The Orpheus install id is the card's `orpheus_token`, not the repo short name** — the
  catalog is keyed by id, so an install under the wrong name renders with no eosBoost,
  repPenalty, maxCharsPerSec or sentenceGap: the untuned configuration whose runaways those
  caps exist to prevent.
- **`DEFAULT_ORPHEUS_BASE` is emphatically not a fallback.** Serving a LoRA on the wrong base
  produces "confident, fluent, WRONG audio with no error anywhere".
- **Every sync fs call is WSL-gated** — the models dir is typically a `\\wsl$` UNC path, and
  when the VM is wedged a sync touch blocks the Electron main thread forever and the app
  white-screens.
- **`.fusework` and `.previous` are excluded by LOCATION, not content** — both hold a
  complete valid model shape mid-run.
- **Why a doctor is a separate probe:** ONE round trip (a doctor that takes five seconds is a
  doctor nobody runs); EVERY check reports pass or fail, never short-circuiting, and **a
  missing line is a failure, not a pass**; the remedy travels with the result; and it asks
  **the spawn's own resolution functions**, so a green doctor cannot be describing a
  different environment from the one the render will use.

## E. The JSON-lines protocol with `python -m narrator.serve`

One JSON object per line on stdin; stdout read with `readline`, `crlfDelay: Infinity`. **A
line not starting with `{` is not an error** — it is logged truncated to 120 chars and
skipped, so engine chatter cannot break the stream.

The worker is **strictly serial**, enforced pool-side by a two-tier queue (priority = the
playing session; normal = read-ahead), so two sessions never clobber the one stdin pipe.

Commands: `load {action,id,voice,modelDir?,adapterDir?,baseDir?,caps,warm}`,
`generate {action,text,language,stream,voice?}`, `generate_batch {action,items:[{i,text,voice?,stream?}]}`,
`cancel`, `stop`, `quit`. `load` carries BOTH `id` (catalog) and `voice` (prompt token) so
the worker can refuse a load whose token another id already claimed. `warm` is sent
explicitly on every load so the worker never infers intent from an absent field. A Higgs
`load` carries the voice name and nothing else — narrator refuses `modelDir`, `baseDir`,
`adapterDir` and `caps` field by field, though an **empty `caps` object IS accepted** as the
"no catalog tuning" signal.

Responses: `ready`, `status`, `loaded`, `audio`, `chunk`, `done`, `error`, `stopped`,
`batch_item`, `batch_chunk`, `batch_done`. **`ready` is a probe** emitted before any model
loads; **`loaded` is ground truth** from the engine that actually built (carries `engine`,
`backend`, `sampleRate`, `pads`, `edgeFadeMs`) and CORRECTS the startup probe.

Batch identity is the caller-supplied `i`. A row with `streamed: true` on its `batch_item`
carries **no `data`** — every byte already went out as `batch_chunk`s — and a caller must not
read missing audio as failure. **A `batch_chunk` whose index has no sink is a protocol break,
not a race to swallow.**

**The taint mechanism is part of the contract.** A timed-out generate or load leaves the
worker still rendering; dispatching new work would cross-wire late results (a stale
`batch_item {i:0}` resolving index 0 of the NEXT batch, or a late `loaded` resolving the next
load — both match on `sentenceIndex === -1`). The worker is tainted until the stale TERMINAL
message arrives and is discarded; **`loaded` must be in that list** or a timed-out load
leaves the worker refusing all work forever. `chunk` does not clear a taint. Sentinel
indices: `-1` = a load, `-2` = a stream.

Per-message `sampleRate` wins where present; `loaded`'s fills in otherwise.

**Exit codes are documented diagnoses:** `2` = bad arguments (a BookForge bug, so the message
says so and does not tell the user to reinstall), `3` = no engine could load — and narrator
**deliberately prints no `ready`** in that case, the alternative being a worker that looks
alive and answers "Model not loaded" to every generate. Restarting on either is pointless:
same argv, same env, same exit.
