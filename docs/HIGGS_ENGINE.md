# Higgs as a narration engine

> **SUPERSEDED IN PART (2026-09-05).** This document records the branch that made
> Higgs an engine and XTTS a *retired choice*. The follow-up branch pulled XTTS,
> F5 and Voxtral out of the root entirely, so §2's "What STAYS" table is now
> history: the XTTS streaming pool, the voice catalog, `custom-voices.ts` (§8's
> "biggest loose end") and `catalog.bundled.ts` are all gone. What survived, and
> why, is in **`docs/XTTS_REMOVAL.md`**. Everything about the ENGINE MODEL below
> — the two unions, the refusal-by-name, the Higgs catalog — is unchanged and
> still current.

Built 2026-09-04 on branch `feat/higgs-engine-option`, cut from `01a3799b`.

Owen: *"Orpheus is a choice, XTTS used to be a choice but can now be removed,
Higgs will have to be added as an option, and the Higgs fine-tunes will have to
be added to the Higgs dropdowns on the narration page."*

This is what was added, what it waits on, and what was deliberately left alone.

---

## 1. The engine-id model

`shared/tts/engine-caps.ts` now declares **two** unions instead of one, because a
retired engine has to stay nameable:

```ts
type TtsEngineId      = 'orpheus' | 'higgs';          // can RENDER
type RetiredTtsEngine = 'xtts' | 'f5' | 'voxtral';    // loads, displays, refused
type TTSEngine        = TtsEngineId | RetiredTtsEngine;
```

A job record written last year says `xtts`. It must still load, and it must still
display — and the only way to do both while refusing to run it is for "an id this
build recognises" and "an id this build will render" to be different types. A
record field is typed `TTSEngine`; code about to queue work asks
`assertRunnableTtsEngine`.

| function | question it answers |
|---|---|
| `isTtsEngine(id)` | is this an id this build knows at all? (`xtts` → **true**) |
| `isRunnableTtsEngine(id)` | can it render today? (`xtts` → **false**) |
| `assertRunnableTtsEngine(id)` | narrow, or throw naming the engine and the date |
| `engineDisplayName(id)` | `'XTTS (retired)'`, `'Orpheus'`, `'Higgs'` |
| `narrationEngineOrder()` | `['orpheus', 'higgs']` — the picker's list |

**The refusal never coerces.** Quietly substituting Orpheus for a record that
says `xtts` renders a whole book in a voice nobody chose and reports success.

---

## 2. The XTTS removal list

### Removed as a CHOICE

| where | what changed |
|---|---|
| `shared/tts/engine-caps.ts` | `SELECTABLE_ORDER` is `['orpheus','higgs']`. Was `['xtts','f5','orpheus','voxtral']` and lived in the registry shim. |
| narration modal (`narration-modal.component.ts:323`) | reads `selectableEngines()` → the array above. **No template change was needed.** |
| Settings → Pipeline Defaults (`pipeline-defaults-panel.component.ts:63`) | same source, same story. |
| `settings.service.ts:84` | `DEFAULT_PIPELINE_DEFAULTS.ttsEngine` `'xtts'` → `'orpheus'`; `ttsVoice` `'ScarlettJohansson'` → `'leah'` (an XTTS clip name against an Orpheus default is a pair that cannot render). |
| Settings → TTS Server → Voice Engine | the XTTS button is `[disabled]` and labelled `XTTS (retired)`. |
| `streaming-engine.ts:getAvailableEngines` | XTTS is reported `available: false` with the retirement reason. The Listen tab's `@for` over that list already renders an unavailable engine as disabled-with-a-tooltip, so **one edit retired it in both pickers**. |
| `worker-config.service.ts:170` | the `engines` seed was `[{id:'xtts', available:true}]` — now a false statement, so it seeds `[]`. |
| First-run setup step `xtts` | retitled from *"XTTS — the built-in narrator"* to *"Language packs"*. |
| Settings section `xtts` | retitled to *"XTTS (retired)"*; description says what still lives there. |
| `job-details` / `job-step` `capitalizeEngine` | now `engineDisplayName`, so an old job's Engine row reads `XTTS (retired)`. |

`selectableEngines` being the single source is the reason this list is short:
**one array retired XTTS everywhere it was offered.**

### F5 and Voxtral

Not retired by a decision — they fall out as a **consequence** of narrowing the
picker to Orpheus and Higgs, and they are marked `retired` with exactly that
reason so they do not vanish silently. Both were component-gated (`f5-env` /
`voxtral-env`) so neither was visible on a machine that had not installed them.
Their `getEnvPathForEngine` wiring is untouched. **Re-listing either is one line
in `SELECTABLE_ORDER`.** Flagged for Owen — this was the one judgement call in
the removal.

### What STAYS, and why

| kept | why |
|---|---|
| `--tts_engine xtts` in `reassembly-bridge.ts:1517` and `parallel-tts-bridge.ts:5283` | **engine-agnostic scaffolding.** Assembly combines audio and never consults the name; both spawns pass the literal on every book including Orpheus ones. Documented in narrator's `compat/FLAGS.md`. |
| The XTTS streaming worker + `getSelectedEngineName()`'s `'xtts'` default | XTTS is still the **bundled streaming runtime**. Retiring the choice must not tear a running Listen session out from under someone, and Higgs is not a streaming engine (see §6). |
| Every `'xtts' \| 'orpheus'` DTO in `preload.ts` / `main.ts` / `manifest-types.ts` (~25 sites) | record types. Narrowing them is what would stop a legacy record loading — the opposite of the requirement. |
| `bilingual-cache-panel.component.ts` (its own hardcoded engine list) | **bilingual books stay on ebook2audiobook.** narrator REFUSES `--bilingual` by name because bilingual assembly inserts silence of its own, which falsifies every timing rule its assembler rests on. |
| `custom-voices.ts:190` `CUSTOM_ENGINE = 'xtts'` | ⚠️ see §8 — the biggest loose end. |
| `catalog.bundled.ts` (~40 × `"engine": "xtts"`) | data about a voice's **checkpoint format**, not an engine choice. |
| `manifest-migration.ts:480,711` | writes `engine: 'xtts'` when reconstructing a pre-manifest project — a statement about history, and a true one. |
| Settings section id `'xtts'` as a route key | `translation-panel.component.ts:543` deep-links `?section=xtts` for language packs. Renaming the key would break a link to fix a word. |

---

## 3. The Higgs catalog

`electron/data/higgs-models.json` + `electron/higgs-models.ts`.

**It is not `orpheus-models.json` with the names changed.** That file OVERLAYS a
per-machine install manifest because an Orpheus voice is discovered by dropping a
folder somewhere. A Higgs voice is never discovered — it is the served model's own
zero-shot voice, or an artifact this file names. So there is **no runtime
manifest, no folder scanner and no reconcile fallback**: this file is the whole
roster, and a voice not in it is refused by name.

### Schema

```jsonc
{
  "version": 2,
  "engine": "higgs",
  "serving": {                    // selected by a model'''s engineVersion; a model
    "engineVersion": "v3",        // may declare its own, used INSTEAD (never merged)
    "narratorEngineId": "higgs-v3",
    "model": "bosonai/higgs-audio-v3-tts-4b",
    "env": "higgs3", "condaEnvName": "higgs3",
    "launchScript": "serve_higgs_v3.sh",
    "servedModelName": "higgs-v3",
    "host": "127.0.0.1", "port": 8095,
    "endpoint": "/v1/audio/speech", "healthEndpoint": "/health",
    "gpuMemoryUtilization": 0.6, "maxModelLen": 8192, "maxNumSeqs": 2,
    "attentionBackend": "FLASH_ATTN",
    "coldStartSeconds": 297, "readyTimeoutSeconds": 300,   // MEASURED
    "patches": [ { "id", "script", "target", "marker", "why" } ]
  },
  "models": [{
    "id": "default",
    "label": "Higgs v3 default (zero-shot)",
    "kind": "clips",              // BookForge'''s RULE selector, not the wire format
    "engineVersion": "v3",
    "voice": {                    // narrator'''s shape: always clips
      "clips": [],                //   [{path, transcript, seconds}] - ONE at most
      "checkpointDir": "..."      //   a MERGED fine-tune dir (~8.5 GB)
    },
    "license": "boson-higgs-tts-3-research-noncommercial",
    "commercialUse": false,
    "sampleRate": 24000,
    "addedAt": "2026-09-04",
    "_pendingNote": "...",        // present => artifact not installed => REFUSED
    "backends": { "served": {
      "maxChars": 600,            // null on an unmeasured fine-tune => REFUSED
      "maxCharsSource": "zero-shot placeholder",
      "edgeFadeMs": { "in": 10, "out": 25 },
      "sampling": { "temperature": 1.0, "topP": 0.95, "topK": 50 },
      "referenceSecondsCap": 30,
      "allowedControls": []
    }}
  }]
}
```

### Every number is measured

Provenance:
`E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\HIGGS_V3_LEVERS.md`.

- **`maxChars: 600`** — coverage (faster-whisper + difflib alignment) is 1.000 at
  213/440/504 chars and holds to 600; **898 chars fails reproducibly** (0.86 and
  0.78 on two seeds, tail coverage 0.314 and 0.000). A reference clip does not fix
  it. **Duration ratio is NOT a coverage proxy**: at temperature 0.7 the 898-char
  chunk gave ratio 0.99 while dropping 22 % of its text and padding with a 26 %
  insert rate. Any future cap must be measured by ASR alignment.
- **`edgeFadeMs: {in:10, out:25}`** — applied at ASSEMBLY, never baked into the
  chunk wav. Higgs emits no lead/trail silence, so a decoded chunk ends at a hard
  sample boundary and every join clicks without them. This is also why the
  manifest's `gapBefore`/`gapAfter` are **live** for Higgs and inert for Orpheus.
- **`sampling: 1.0 / 0.95 / 50`** — the server's own shipped defaults
  (`vllm_omni/deploy/higgs_multimodal_qwen3.yaml`, stage 0). Two traps: they are
  **not** fields of `OpenAICreateSpeechRequest` (pydantic drops them silently
  unless they travel in `extra_params`), and measured deviations (0.3/0.7/1.0 →
  cosine 0.653/0.675/0.642) sit **inside single-seed noise** — two seeds of the
  same setting differ by 0.04, so one seed per cell cannot rank them.
- **`referenceSecondsCap: 30`** — hard server limit; 42 s returns HTTP 400.
  vllm-omni takes exactly ONE reference, so multiple clips = one concatenated wav
  with transcripts joined in order.
- **`allowedControls: []`** — a safety rule. A control token outside
  `get_added_vocab()` is split into 7–10 text pieces and **read aloud**, derailing
  generation into a degenerate loop (ASR coverage **0.000**, pitch std 0.28 st,
  speaker cosine 0.05). v3 has no scene-description mechanism and no
  `neutral`/`calm` emotion. An empty allowlist means no engine has to get the
  validation right.

### The wire format is narrator's, and this catalog is not it

narrator reads a **voice document** whose path arrives in `NARRATOR_HIGGS_VOICES`
(`python/narrator/engine/higgs/config.py:load_voices`):

```jsonc
{ "<voiceId>": { "kind": "default" | "checkpoint" | "clips",
                 "clips"?: [{ "path", "transcript", "seconds" }],   // kind 'clips' only
                 "checkpointDir"?,                                   // kind 'checkpoint' only
                 "maxChars", "maxCharsSource",
                 "scene"?, "allowedControls"?, "maxReferenceSeconds"? } }
```

That format has **three shapes**, and only one of them carries clips:

| kind | carries | what it is |
|---|---|---|
| `default` | nothing | the served model's own speaker |
| `checkpoint` | `checkpointDir` | a **merged** fine-tune directory (~8.5 GB) |
| `clips` | `clips: [1]` | a zero-shot clone — **diagnostic only** |

**Why `checkpoint` and not `adapter`.** It was `adapter`/`adapterDir` until
2026-09-04, which named the artifact we *train* rather than the artifact that
*serves*. **vllm-omni cannot load a LoRA at run time** — `vllm-omni serve` has no
adapter flags and the `higgs_audio_v3` talker class does not implement
`SupportsLoRA` — so a LoRA is an archival input to a merge and never a thing the
catalog points at. The server is started **on** the merged directory, which makes
a voice switch a **server restart** (~55 s warm / ~300 s cold), not a message.

This catalog keeps an explicit `kind` anyway, because `kind` selects
**BookForge's own rules** (above all: `maxChars` is required-and-measured for a
fine-tune, and may be the engine placeholder for the default voice) and because a
picker has to tell a person which of them they are choosing — and because
production offers only two of the three (see Decisions, item 13).
`higgsVoicesDocument()` translates one into the other and is the only place the
two shapes meet.

**One voice per document, deliberately.** The format holds a map and it would be
easy to write the whole catalog in and let `--higgs_voice` pick. `load_voices`
also **validates every clip path in the file** (`os.path.isfile` on each), so one
voice whose reference had been moved would fail *every other voice's* render with
an error naming a file the user never asked for. A document of one cannot do that.

### The environment — all of it narrator's

An earlier draft of this work invented a `HIGGS_*` variable set, because
`engine/higgs/` had not landed on `feat/narrator` yet. It landed the same day
with different names. **Every invented name is gone**; these are the real ones:

| variable | value |
|---|---|
| `NARRATOR_ENGINE` | `higgs-v3` (selects the backend in narrator's registry) |
| `NARRATOR_HIGGS_VOICES` | **path** to the one-voice document, in the spawn's filesystem |
| `NARRATOR_HIGGS3_SERVE_SCRIPT` | `<env>/bin/serve_higgs_v3.sh`, when narrator must launch |
| `NARRATOR_HIGGS3_URL` | attach to an already-running server instead |
| `NARRATOR_HIGGS3_WSL_DISTRO` | the distro to launch in, on Windows |

And on the command line: `--tts_engine higgs-v3` plus **`--higgs_voice <catalog
id>`**. Not `--fine_tuned`: narrator's `compat/flags.py` accepts both and they are
**not interchangeable** — `--fine_tuned` carries an Orpheus voice *token* that
rides in the prompt, `--higgs_voice` is a *catalog id* that indexes the voice
document.

**The caps do NOT travel.** narrator's `higgs_v3_config_from_worker_kwargs`
**raises** on a `caps` payload by name, because those are Orpheus's knobs
(`eosBoost`, `eosFloor`, `maxCharsPerSec`) and v3 implements none of them —
accepting them would suggest they applied. Higgs's caps are BookForge's own two
jobs: sizing the prep packer (`maxChars`) and fading at assembly (`edgeFadeMs`).
They stay on this side, and a keeper asserts none of them leaks into the spawn env.

### The five refusals

`resolveHiggsModel()` / `higgsSpawnEnv()` throw, by name, for:

1. an **unknown** voice id;
2. a voice carrying `_pendingNote` (artifact not installed);
3. a clip with a **blank or missing transcript** — book-exact text per the
   training-text doctrine, because vllm-omni frames the prompt as
   `<|ref_text|> {transcript} <|ref_audio|>` and a blank transcript asserts the
   audio is silence;
4. a clip with **no declared `seconds`**, or **more than one clip**, or a
   reference **over 30 s** — narrator's `reference_seconds` refuses an undeclared
   duration rather than probing the file, and vllm-omni takes exactly one
   reference, so all three of these would otherwise fail *after* the server had
   spent five minutes coming up;
5. a **fine-tune with no measured `maxChars`** — see below.

A sixth requirement is *narrator's*, not this loader's, because it is about a
directory only narrator's process can see: a `kind: 'checkpoint'` voice's
directory must carry `generation_config.json` — see “A checkpoint's
`generation_config.json` is a REQUIRED FILE” below.

`higgsSpawnEnv()` re-runs (3)–(5) at the boundary that actually emits the value.
A keeper caught an untranscribed clip reaching the document through a caller that
held a model from `listHiggsModels()` rather than `resolveHiggsModel()`.

None of these falls back. The v3 default voice measures at **12 % of the
narrator's 0.7656 ECAPA ceiling** — a *different speaker*, not a weak clone — so
a fallback is an hour of audio in the wrong voice.

### ⚠ A fine-tune's `maxChars` must be MEASURED — no inheritance, no default

The single most dangerous number in this catalog.

**A fine-tuned Higgs checkpoint's stop length tracks its TRAINING CLIP LENGTH,
not the text it is given.** The training side measured a 30-minute fine-tune trained on
8–22 s clips stopping after **~6–10 s of audio on any prompt over ~150
characters**. So the zero-shot 600 is not merely imprecise for a fine-tune — it is
wrong by roughly a factor of four, *in the direction that loses text*, and it
loses it while every duration check still looks plausible.

Therefore:

- `backends.served.maxChars` is **REQUIRED** on every `kind: 'checkpoint'` voice and
  must come from **that model's own length sweep**;
- `maxCharsSource` is required beside it — the number without its method is not
  evidence, and a duration ratio in particular is not a coverage proxy on this
  family (a v3 render measured ratio 0.99 while dropping 22 % of its text);
- the loader **refuses** a fine-tune without both. A `maxChars: 600` with no
  source is still refused;
- a zero-shot `kind: 'clips'` voice may carry the engine placeholder 600 with
  `maxCharsSource: "zero-shot placeholder"`.

The seeded **deathstalker** entry therefore has `maxChars: null`,
`maxCharsSource: null` and a `_pendingNote` — it is refused until the training
session sends the measured number. **The narration dropdown still shows it**,
greyed, carrying that note: a voice everyone is waiting for should not silently be
absent from the list.

### ⚠ A checkpoint's `generation_config.json` is a REQUIRED FILE

The second most dangerous thing about a fine-tune, and it is not in this catalog
at all — it is in the checkpoint **directory**.

`vllm-omni serve <dir>` takes its sampling **from the model directory**:
`--generation-config` defaults to `auto`, and the launch script passes no
override. A merged directory *without* `generation_config.json` falls through to
vllm-omni's stage fallback (`entrypoints/openai/stage_params.py`), a bare
`SamplingParams()` — temperature 1.0, **top_p 1.0, top_k DISABLED** — which
samples the untruncated 1026-way codebook tail. Measured 2026-09-05: long
prompts derail into babble, a seed-dependent collapse to 3–10 s of audio at
≥ 600 characters, and the same server renders the same prompts correctly with the
file present. **Nothing per-request can fix it**: `OpenAICreateSpeechRequest`
carries no `temperature` / `top_p` / `top_k` fields, so the directory is the only
lever there is.

The provenance, which is *not* "the base ships one":

- `bosonai/higgs-audio-v3-tts-4b` ships **no** `generation_config.json` — verified
  across the whole WSL HF cache and the Mac's base snapshot. That is exactly why a
  merged dir must carry one;
- the **merge writes it**, from a recorded per-run
  `generation_config.override.json`, and refuses to produce a served dir without
  it;
- the values are vllm-omni's own `deploy/higgs_multimodal_qwen3.yaml` stage-0
  `default_sampling_params` — `{"temperature": 1.0, "top_p": 0.95, "top_k": 50,
  "repetition_penalty": 1.0}` — which `vllm-omni serve` on the CLI does *not*
  read, hence materialising them into the directory;
- `merge_manifest.json` beside the weights records which source was used.

So the required files of a `kind: 'checkpoint'` voice's directory are
`config.json`, `tokenizer.json`, `tokenizer_config.json`, `chat_template.jinja`,
the weights — **and `generation_config.json`**.

**narrator refuses by name** (`v3_served.require_generation_config`, reached from
`checkpoint_serve_target` and therefore from every door that resolves a
checkpoint voice) when the file is absent, unparseable, or present but carrying
none of `temperature` / `top_p` / `top_k` — a `generation_config.json` without
sampling is not the file this needs, because the server reads it, finds nothing
and falls back exactly as if it were absent. It never copies, synthesizes or
defaults one: writing it would be narrator deciding a model's sampling.

The refusal is narrator's and not `resolveHiggsModel()`'s on purpose: the
checkpoint lives inside WSL (or on the Mac), and the process that can *see* the
directory is the one that must check it.

**On the Mac this is not just the server's file — it is narrator's.** mlx-audio
0.4.8's `higgs_audio_v3` reads no `generation_config.json` at all (its
`Model.generate` defaults `top_p` and `top_k` to `None`, which disables both), so
the MLX backend reads the checkpoint's file itself and passes those exact values
to the sampler. A `repetition_penalty` other than 1.0 in the file is *refused*
there rather than dropped — mlx-audio has no such lever, and ignoring it would
give one checkpoint two samplings across the two arms. See
`python/narrator/engine/PORT_NOTES.md` 12.8d and 13.11.

**And the corollary, which is about `clips` and `default` voices:** if sending no
`extra_params` means the model directory, and the base snapshot has no file, then
a zero-shot voice rendering against the base was itself getting top_p 1.0 /
top_k disabled. So narrator now sends v3's deploy default **explicitly** in
`extra_params` for a base-weights voice, and sends nothing for a checkpoint voice
(whose directory carries the file the server reads for itself). `stop_policy` —
and therefore the manifest — reports what the model actually sampled at, which
for a fine-tune is its own directory's numbers.

### Cold start: 297 s, not 55

narrator's own GPU smoke measured **297 s** from launch to `/health` answering —
not the ~55 s the first audition reported, which was a warm cache. narrator's
`READY_TIMEOUT_SECONDS` is 300, so the measurement sits **three seconds under the
limit**.

Anything that decides a Higgs job is dead must clear five minutes. Checked
against the three that could, all in `parallel-tts-bridge.ts`:

| watchdog | value | clears 300 s? |
|---|---|---|
| `WORKER_STARTUP_TIMEOUT_MS` | 10 min | yes |
| `WORKER_PROGRESS_TIMEOUT_MS` | 12 min | yes |
| `PREP_STALL_TIMEOUT_MS` | 10 min | yes |

**No change was needed** — but they clear it by minutes, not by an order of
magnitude, so a keeper reads all three out of the source and fails if one is
tightened below the recorded cold start.

## 4. The environment

### Settings and routing

| setting | default | notes |
|---|---|---|
| `useWsl2ForHiggs` | off | Windows only; in `BOOLEAN_CONFIG_KEYS` so the renderer's `'true'` string coerces |
| `wslHiggsCondaEnv` | `higgs3` | overridable per-process via `WSL_HIGGS_CONDA_ENV` |
| distro / conda path | shared with the Orpheus settings | |

Its own toggle rather than a second reader of the Orpheus one: a machine can have
one env and not the other. **A stronger reason than Orpheus's**, too — Orpheus
runs natively on Windows and merely runs badly (no CUDA graphs); vLLM-Omni has
**no Windows build at all**. So `getEnvPathForEngine('higgs')` on Windows without
the toggle **throws** rather than falling through to the bundled env, which has no
`vllm_omni` and would fail as an ImportError deep in a worker.

### The doctor — `checkWslHiggsSetup()`

**ONE `wsl.exe` round trip** (each spawn costs most of a second on a cold VM, and
a five-second doctor is a doctor nobody runs). The probe emits one `key=value` per
check and **never short-circuits** — every check is reported pass or fail, because
"the tail-trim patch is missing" and "there is no WSL distro" are both
`valid: false` and have nothing else in common.

| check | how |
|---|---|
| `distro` | did the probe run at all |
| `env` | `test -d <conda-base>/envs/<name>` |
| `vllm-omni` | `<env>/bin/python -c 'import vllm_omni'` |
| `patch:vllm-negative-token-id` | grep `min_input_id != -100` in `vllm/v1/engine/input_processor.py` |
| `patch:higgs-tail-trim` | grep `_trim_trailing_sentinel_frames` in `vllm_omni/.../higgs_audio_v3.py` |
| `launcher` | `test -x <env>/bin/serve_higgs_v3.sh` |

A missing probe line is **not** a pass — defaulting those to ok would report green
for a machine with no WSL.

The patches get their own rows **because pip reverts them silently**: any upgrade
in the env replaces the site-packages file and the patch is gone with no error.
Marker-grepping is what makes "is it applied" answerable without a diff.

### The two patches, and what breaks without them

| patch | without it |
|---|---|
| `patch_vllm.py` | vLLM 0.28's blanket negative-token-id rejection fires on vllm-omni's `AUDIO_PLACEHOLDER_ID` (-100). **Every voice-clone request returns HTTP 400** and only the default speaker can serve. |
| `patch_tail_trim.py` | the ramp-down BOC/EOC sentinels are substituted with codec code **0 — a valid code that decodes to real sound** — and only one frame (40 ms) is trimmed, leaving ~240 ms of audible garbage at the end of **every chunk**. Owen heard it as "a stray syllable or sound after each sentence". Measured effect of the fix on the terminal burst peak: −29.8→−46.2, −31.9→−43.4, −31.6→−52.8, −29.9→−49.1 dB. |

### The installer — `electron/scripts/higgs/install_higgs_env.sh`

Idempotent, **never automatic**, with a `--check` mode that reads and writes
nothing. Pins captured from the reference env's own `pip freeze`:
`vllm-omni==0.28.0`, `vllm==0.28.0`, `torch==2.13.0` (cu130). **No `--index-url`**
— the reference install passed none; `pip install vllm-omni` resolved torch from
PyPI as a transitive dependency, and adding an index would invent a step the
measured env never took.

Steps: conda env (py 3.11) → the stack → both patches → deploy the launcher into
`<env>/bin/` → the HF weights. Everything is skipped when already done, so a
re-run after a partial failure resumes.

`serve_higgs_v3.sh` is transcribed from the campaign's `serve_v3.sh` with exactly
two changes: the env prefix is a parameter, and `HIGGS_MODEL_DIR` can name a
merged fine-tune. It **refuses** a set-but-missing `HIGGS_MODEL_DIR` rather than
serving the base in its place — that would be a different narrator reported as
success. FlashInfer is routed around (`VLLM_USE_FLASHINFER_SAMPLER=0`,
`--attention-backend FLASH_ATTN`): its JIT nvcc build rejects the CUDA 13 nvcc
from the pip wheel on sm_86. Speed only.

**`.gitattributes` pins `electron/scripts/higgs/*` to LF.** `core.autocrlf=true`
would otherwise make a fresh checkout's `#!/bin/bash\r` a bad interpreter.

### Model layout

Orpheus keeps voices at `/home/<user>/orpheus-models/<voice>`; Higgs mirrors it at
`/home/<user>/higgs-models/<voice>`, WSL-native so weights load off ext4 rather
than the slow `/mnt/c` 9p mount. Catalog paths are WSL paths, like Orpheus's.

---

## 5. Routing a Higgs job

`electron/higgs-spawn.ts`. **All three phases go to narrator.**

| phase | door | why |
|---|---|---|
| **prep** | `compat.app --prep_only` | its `paragraph_packer.py` *is* the Higgs chunking rule |
| **worker** | `compat.worker` | e2a has no Higgs engine |
| **assembly** | `compat.app --assemble_only` | a Higgs session is a narrator session |

### Prep moved off e2a (review finding 5)

The first draft routed prep to ebook2audiobook as `--tts_engine orpheus` in the
bundled env, with `ORPHEUS_MAX_CHARS` carrying the Higgs cap. The mechanism was
verified in e2a's source and did work; the **premise expired hours later**.
`narrator/text/paragraph_packer.py` landed, `compat/app.py` now forces
`chunking = 'paragraph'` for `higgs-v3`, and `text/prep.py` refuses `higgs-v3`
with e2a chunking by name.

And the old route was wrong in three further ways, all silent — the session it
wrote recorded:

| | e2a route wrote | narrator writes |
|---|---|---|
| `tts_engine` | `"orpheus"` | `"higgs-v3"` |
| `higgs_voice` | *absent* | the catalog id |
| `bookforge_chunking` | *absent* | the chunking record |

So any door that does not pass the voice explicitly — **resume, retake** — read
that state back and either refused, or let `resolve_engine_id` fall through to
`tts_engine == 'orpheus'` and build the **Orpheus** engine for a Higgs book.

> **Owed to the training side.** Every v3 coverage measurement was taken at
> 600-char sentence groups. Owen's rule is that the paragraph is the chunk (v3's
> 8,192-token window fits ~4,000 chars), so **coverage must be re-measured at the
> new chunk sizes** — by ASR alignment, never by duration ratio.

### `--session_dir` is mandatory on every narrator spawn

`session_store.sessions_root()` reads `$E2A_TMP_DIR`. e2a survived without the
flag because `lib/conf.py` fell back to `<e2a_root>/tmp`, which happened to be the
path the bridge had already computed; **narrator has no e2a root and refuses to
guess.** Forwarding `E2A_TMP_DIR` is not an alternative — it holds a *Windows*
path while a WSL prep derives its session dir from the WSL e2a root, and
`spawnWithWslSupport` does not hand the Windows environment to the guest at all.

### The spawn

```
wsl.exe -d <distro> bash -c "export PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8 \
    NARRATOR_ENGINE=higgs-v3 \
    NARRATOR_HIGGS_VOICES=/mnt/c/.../<job>-<voice>.json \
    NARRATOR_HIGGS3_SERVE_SCRIPT=<env>/bin/serve_higgs_v3.sh \
    NARRATOR_HIGGS3_WSL_DISTRO=<distro> \
    PYTHONPATH=/mnt/c/<repo>/python \
  && cd ~ \
  && '<wslCondaPath>' run --no-capture-output -n 'higgs3' \
       python -u -m narrator.compat.worker \
         --session <id> --session_dir /mnt/c/... --sentences_dir /mnt/c/... \
         --device CUDA --tts_engine higgs-v3 --higgs_voice <catalog id> \
         --sentence_start <n> --sentence_end <n>"
```

Prep is the same shape with `-m narrator.compat.app --prep_only --ebook …`;
assembly with `--assemble_only` and **no `--tts_engine` at all** (see below).

- **`PYTHONPATH`, not `pip install -e`** (PORT_NOTES §9.2 offers both): the
  install is a per-env step a user must have run and is invisible when they have
  not. PYTHONPATH ships with the spawn.
- **`cd ~`** — narrator reads cwd for nothing (PORT_NOTES §9.3) but the directory
  must exist inside the guest.
- **`EBOOK2AUDIOBOOK_PATH` is not set** — it was the sys.path bootstrap and
  narrator never reads it.
- **No `ORPHEUS_*` variable rides along**, asserted by a keeper.

### Path translation — the bug that made every spawn unusable

The guard was `/^[A-Za-z]:[\/]/` — a character class holding an escaped
**forward** slash and nothing else. It matched `C:/x` and **missed** `C:\x`, and
`path.join` on win32 emits backslashes. So every `--session_dir` and
`--sentences_dir` crossed into the guest as a literal Windows path, single-quoted
so bash preserved it exactly, and narrator would have refused it as a directory
that does not exist — **potentially after the 297 s cold start had been paid.**

One `toGuestPath` helper now serves argv **and every environment value**. They
used to be translated by different code, one correct and one not, which is
exactly how the argv bug stayed invisible in a log that showed a correct-looking
`NARRATOR_HIGGS_VOICES`.

### Why it does NOT go through `spawnWithWslSupport`

`buildWslBashCommand` rewrites argv **by pattern**: any arg containing `orpheus`
becomes `-n <orpheusEnv>`, any path under the e2a root is remapped onto the WSL
e2a checkout, and it exports a fixed `ORPHEUS_*` `forwardKeys` list. Every one of
those rules is wrong here, and silently so — **a Higgs command through that
function comes out an Orpheus command.** Leaving it untouched is also what makes
the Orpheus argv provably unchanged.

### Assembly omits `--tts_engine`

`dispatch` routes `--assemble_only` **before** any engine resolution
(`compat/app.py`), and `check_engine` never runs on it — so the flag names
nothing. The value the argv would otherwise have carried is the literal `higgs`,
which `compat/flags.py` lists under `ENGINE_NEAR_MISSES` ("names no registry id")
and would refuse by name the moment assembly is ever gated. Omitting it is the
one option that is correct both now and then.

Assembly passes **no caps**. It routes to narrator because a Higgs session **is**
a narrator session — and, since narrator `4854aae4`, because narrator's assembler
is the thing that applies the 10/25 ms raised-cosine edge fades and realizes the
live `gapBefore`/`gapAfter` for a `pads=false` engine. Prep writes the `gaps.json`
those read; `session_v1` refuses a `pads=false` session without it.

### Refusals, and where each one fires

| gate | where | catches |
|---|---|---|
| retired engine | `narrationInputRefusal` (main.ts), the queue boundary | a saved `xtts` job re-run from the queue page |
| retired engine | `regenerateSentenceIndices` | a retake on an old XTTS book (reads `session_state.json`, no UI in between) |
| retired engine | `stageRefusal` (modal) | a preset or pipeline default written before the retirement |
| environment | `higgsEnvironmentRefusal`, awaited **once per job** in `prepareSession` | no WSL toggle, missing env, missing patch, missing launcher |
| environment | the modal's `higgsBlocked` snapshot | the same, while the dialog is still open |
| voice | `higgsPreflight` → `resolveHiggsModel`, at **every** spawn site | unknown / not-installed voice, bad clip, unmeasured fine-tune |

The environment check is **async and once per job**. It used to be a synchronous
`execSync` at prep, at every worker start, at assembly and at retake — a
per-range health check on the thread the bookshelf server shares, for a resource
that cannot change between the workers of one job. The voice check stays at every
site because it is pure: a catalog lookup, no filesystem, no WSL.

### Watchdogs

The measured 297 s cold start clears all three, and **no change was needed**:

| watchdog | value |
|---|---|
| `WORKER_STARTUP_TIMEOUT_MS` | 10 min |
| `WORKER_PROGRESS_TIMEOUT_MS` | 12 min |
| `PREP_STALL_TIMEOUT_MS` | 10 min |

A keeper reads all three **out of the source** and fails if one is tightened
below the recorded cold start.

## 6. What Higgs is NOT

**Not a streaming engine.** `getAvailableEngines()` omits it rather than listing
it as unavailable. The v3 backend is a served endpoint and its codec is a
delay-pattern one with no sound windowed decode — narrator's
`HiggsCodec.streaming_decoder()` returns `None` on purpose. Listing it would
promise a Listen feature that does not exist.

---

## 7. Licence — read this before shipping

Higgs Audio v3 (`bosonai/higgs-audio-v3-tts-4b`) is **Research and
Non-Commercial** (Creator Use Grant, mandatory Boson AI credit), and **a fine-tune
of those weights inherits it**. Personal use is fine and is why this is enabled.
A commercial BookForge build needs a separate licence from Boson AI.

Every catalog entry carries `license` and `commercialUse: false`, and the Settings
panel shows the warning. **Higgs Audio v2 is the trainable-and-shippable family**
(Community licence: attribution + a naming constraint) and is deliberately NOT in
this catalog — Owen dropped v2 on 2026-09-04 ("basically just Orpheus and we know
Orpheus better").

---

## 8. Open items

### Waiting on narrator (`feat/narrator`)

**RECONCILED 2026-09-04, later the same day.** Items 1-3 below were open when this
was first written and are now closed: `engine/{protocol,registry}.py` and
`engine/higgs/{v3_served,v3_engine,config}.py` landed in the narrator worktree,
and every guess this side had made was corrected to them rather than negotiated.
What changed here:

| was (BookForge's guess) | is (narrator's contract) |
|---|---|
| an invented `HIGGS_*` env set | `NARRATOR_HIGGS_VOICES` (a **path**), `NARRATOR_HIGGS3_{URL,SERVE_SCRIPT,WSL_DISTRO}` |
| caps passed as env vars | caps do **not** travel — narrator *raises* on a `caps` payload |
| the voice named by `--fine_tuned` | `--higgs_voice <catalog id>` (the two are not interchangeable) |
| `voice: {kind:'adapter', path}` \| `{kind:'clips', clips}` | three kinds: `default` / `clips` / `checkpoint` |
| clips as `{path, transcript}` | `{path, transcript, **seconds**}` — a clip without a declared duration is refused |
| several clips allowed | **exactly one**; multi = a pre-joined wav, joined at staging |
| cold start ~55 s | **297 s**, against a 300 s `READY_TIMEOUT_SECONDS` |

**Closed since, by the two review rounds (2026-09-05):**

- `paragraph_packer.py` landed, so **Higgs prep moved to narrator** (§5) and the
  e2a scaffolding is deleted.
- `python/**` is now in electron-builder's `files` (minus `__pycache__`, `*.pyc`,
  `narrator/tests/**` and `**/golden/**`) and in `asarUnpack`.
- **THE EDGE FADE IS APPLIED** (narrator `4854aae4`): `assemble/engine_profiles.py`
  (orpheus pads/no fade; higgs-v3 no pads, 10/25 ms **raised-cosine** fades),
  `assemble/edges.py`, a manifest `engine` block (additive — absent means
  Orpheus), and `_plan_unpadded` realizing `gapBefore`/`gapAfter` as generated
  silence through one FLAC writer so the concat stays homogeneous. Prep writes a
  `gaps.json` sidecar from the SAME classifier Orpheus bakes into its FLACs, and
  `session_v1` refuses a `pads=False` session without it (or a `pads=True`
  session with it). Orpheus golden parity unchanged. **Higgs books no longer
  click on their joins**, and §3's note is corrected accordingly.

**MERGE ORDER (Owen's ruling): `feat/narrator` lands first, or with this.** The
package is **not** vendored or copied here; it is resolved at `<repo>/python`,
and the spawn refuses **by name** — naming the branch, not "a packaging bug" —
when `python/narrator/__init__.py` is absent.

Still open on narrator's side:

1. **Where the launch script should live.** narrator invokes the *operator's*
   script rather than writing its own, and BookForge's installer deploys its copy
   to `<env>/bin/serve_higgs_v3.sh` — which is what `NARRATOR_HIGGS3_SERVE_SCRIPT`
   points at. If narrator would rather be handed the campaign path, that is a
   one-line change here.
2. **Coverage at the new chunk sizes.** Every v3 measurement was taken at 600-char
   sentence groups; prep now packs by paragraph. Re-measure by ASR alignment
   (never by duration ratio) — training side, noted in §5.

### Waiting on the training session

**RESOLVED 2026-09-04: there is no LoRA serving path, so a voice IS a merged
checkpoint.** vllm-omni cannot load an adapter at run time — `vllm-omni serve`
has no adapter flags, and the `higgs_audio_v3` talker class does not implement
`SupportsLoRA`. So the old "which adapter strategy?" question has no answer of
that shape: every voice ships as a **merged checkpoint directory (~8.5 GB)** at
`/home/<user>/higgs-models/<voice>/`, the server is started **on** that
directory, and `NARRATOR_HIGGS3_ADAPTER_STRATEGY` is deleted rather than left
open. A LoRA is an archival input to the merge and never a catalog field.

**A voice switch is therefore a server restart** — ~55 s warm, up to ~300 s cold
against the 300 s ready timeout. A book renders in one voice, so it is paid once
per job and never per chunk; but nothing can be built here that assumed mixing
voices within a render, or a cheap per-request voice cast.

Still owed:

3. **The deathstalker checkpoint.** What exists is a **quick 300-step r32 LoRA**
   at `…/higgs/v3_ft/runs/quick30_r32/final`; the full 12.4 h ds_ad4 corpus run
   has not been started, and the LoRA must be **merged into a full checkpoint**
   before it can serve at all. Stage the merged result at
   `/home/<user>/higgs-models/deathstalker/` and remove the `_pendingNote`.
4. **Its `maxChars` must be MEASURED by a length sweep on the merged
   checkpoint**, recorded with a `maxCharsSource`. This is the one the loader
   hard-refuses on: a fine-tune's stop length follows its **training clip
   length**, so the zero-shot 600 would silently lose most of every chunk.
   Verify by ASR alignment, never by duration ratio.

### Decisions to confirm with Owen

8. **F5 and Voxtral left the picker** as a consequence of narrowing it (§2).
   Confirmed by Owen at review; recorded here as the standing decision.
9. **The XTTS streaming runtime was kept** (§2) — Listen still defaults to XTTS
    on a machine with no configured engine. Confirmed; deferred to a follow-up.
13. **Production is FINE-TUNED VOICES ONLY** (Owen, 2026-09-04). The narration
    dropdown lists `checkpoint` voices and the served `default`; a `clips` clone
    is never offered. A clone recovers 92 % of the narrator's speaker identity
    and **none of his phrasing** — 2.01 pauses per 100 chars against his 1.39,
    pitch std 5.17 st against 4.36 — which is precisely the gap a fine-tune
    exists to close, so listing one beside a fine-tune invites picking it for a
    book. The `clips` SHAPE stays fully supported below the picker (the loader
    validates it, the document emits it, the narrator cross-check drives it): it
    is a diagnostic, not a dead branch.
10. **`custom-voices.ts:190` `CUSTOM_ENGINE = 'xtts'`** ties the whole *"add your
    own voice"* feature (checkpoint upload, `--custom_model`) to the retired
    engine. It still works — XTTS was retired as a *narration choice*, not
    deleted — but the feature now has no engine that a narration run can select.
    Higgs's `clips` voice kind is architecturally the natural replacement
    (zero-shot reference-clip cloning) and would need a real design pass.
    **Untouched — out of scope for this brief.**
11. **The bilingual cache panel was DELETED** (review finding 13, my call). It was
    the last selectable XTTS picker in the app *and* unreachable from any template
    or route: it hardcoded its own engine list, never imported `engine-caps`, and
    fell back to `xtts`. Dead code that contradicts a retirement is how the
    retirement gets undone by someone tidying up. Bilingual books stay on
    ebook2audiobook regardless — narrator refuses `--bilingual` by name.
12. **Higgs has `requiresComponent: null`** rather than a registered component.
    The first draft named `'higgs-env'`, which did not exist, so `isInstalled()`
    was false everywhere and **the engine never appeared in the picker at all**.
    Registering one would not be honest either: on Windows the Higgs environment
    is a WSL conda env, and a ComponentService entry describes a Windows install
    with a download and a path. The doctor is the gate, and it re-runs at spawn
    time where `isInstalled` would answer once from a manifest.

---

## 9. Verification

| | |
|---|---|
| `npx tsc -p tsconfig.electron.json --noEmit` | clean |
| `npx tsc -p tsconfig.app.json --noEmit` | clean |
| `npx ng build` | clean (the 672 kB budget warning is pre-existing) |
| `node tools/run-keepers.js` | **ALL KEEPERS GREEN**, twice — 53 suites |
| `install_higgs_env.sh --check` against the live `higgs3` env | verified read-only; found `launcher=absent` correctly, exit 1. **Nothing installed or modified.** |

New keepers:

- **`tools/test-higgs-engine.js`** — the engine-id model, legacy `xtts` handling,
  the voice-catalog routing switch, all three catalog refusals, caps and the
  `NARRATOR_*` env, the voice document, doctor↔catalog patch-table agreement, and that the WSL scripts
  are LF. *It found a real bug during authoring:* `higgsSpawnEnv` shipped an
  untranscribed clip because the refusal lived only in `resolveHiggsModel`.
- **`tools/test-narrator-argv-snapshot.js`** (was `test-orpheus-argv-snapshot.js`,
  deleted 2026-09-05 when Phase 3 replaced every door it anchored on) — the baseline in
  `tools/snapshots/orpheus-argv-base.json` was extracted from **`01a3799b`, before
  any of this work**, and covers all five e2a doors (prep, retake, lightweight
  worker, app.py worker, assembly). The one licensed substitution
  (`prepEngine.envEngine` for `settings.ttsEngine`) is named in the test and
  backed by an assertion that `prepEngineFor` is the identity for every non-Higgs
  engine — not by a regenerated baseline.

Known unrelated flake: `test-bookshelf-stream-teardown`, on *a pinned session
releases its descriptor when idle, and re-pins on return* ("the snapshot outlived
the descriptor that held it").

**It is INTERMITTENT, and both earlier descriptions of it were wrong.** An
earlier version of this document said it passes in the runner and fails
standalone; the review measured it failing in both of its runner passes. Measured
again on 2026-09-05 over three runner passes: **1 failure, 2 green**. So neither
"passes in the runner" nor "fails in the runner" is true — it is timing
dependent, which is what makes it a flake rather than a state.

Not this branch's either way: the diff touches **zero** bookshelf files.
