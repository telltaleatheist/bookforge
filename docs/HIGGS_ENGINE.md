# Higgs as a narration engine

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
    "adapterStrategies": ["lora-modules", "merged-dir"],
    "patches": [ { "id", "script", "target", "marker", "why" } ]
  },
  "models": [{
    "id": "default",
    "label": "Higgs v3 default (zero-shot)",
    "kind": "clips",              // BookForge'''s RULE selector, not the wire format
    "engineVersion": "v3",
    "voice": {                    // narrator'''s shape: always clips
      "clips": [],                //   [{path, transcript, seconds}] - ONE at most
      "adapterDir": "..."         //   present => it is a fine-tune
    },
    "adapterStrategy": "...",     // absent until one has actually been loaded
    "license": "boson-higgs-tts-3-research-noncommercial",
    "commercialUse": false,
    "sampleRate": 24000,
    "addedAt": "2026-09-04",
    "_pendingNote": "...",        // present => artifact not installed => REFUSED
    "backends": { "served": {
      "maxChars": 600,            // null on an unmeasured adapter => REFUSED
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
{ "<voiceId>": { "clips": [{ "path", "transcript", "seconds" }],
                 "scene"?, "adapterDir"?, "allowedControls"?, "maxReferenceSeconds"? } }
```

In **that** format a Higgs voice is **always clips**, and a fine-tune is an
`adapterDir` riding on the same object — there is no adapter kind on that side.

This catalog keeps an explicit `kind` anyway, because `kind` selects
**BookForge's own rules** (above all: `maxChars` is required-and-measured for an
adapter, and may be the engine placeholder for a zero-shot voice) and because a
picker has to tell a person which of the two they are choosing.
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
| `NARRATOR_HIGGS3_ADAPTER_STRATEGY` | `lora-modules` \| `merged-dir` — **emitted only when a voice declares one** |

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

`higgsSpawnEnv()` re-runs (3)–(5) at the boundary that actually emits the value.
A keeper caught an untranscribed clip reaching the document through a caller that
held a model from `listHiggsModels()` rather than `resolveHiggsModel()`.

None of these falls back. The v3 default voice measures at **12 % of the
narrator's 0.7656 ECAPA ceiling** — a *different speaker*, not a weak clone — so
a fallback is an hour of audio in the wrong voice.

### ⚠ A fine-tune's `maxChars` must be MEASURED — no inheritance, no default

The single most dangerous number in this catalog.

**A fine-tuned Higgs adapter's stop length tracks its TRAINING CLIP LENGTH, not
the text it is given.** The training side measured a 30-minute adapter trained on
8–22 s clips stopping after **~6–10 s of audio on any prompt over ~150
characters**. So the zero-shot 600 is not merely imprecise for an adapter — it is
wrong by roughly a factor of four, *in the direction that loses text*, and it
loses it while every duration check still looks plausible.

Therefore:

- `backends.served.maxChars` is **REQUIRED** on every `kind: 'adapter'` voice and
  must come from **that model's own length sweep**;
- `maxCharsSource` is required beside it — the number without its method is not
  evidence, and a duration ratio in particular is not a coverage proxy on this
  family (a v3 render measured ratio 0.99 while dropping 22 % of its text);
- the loader **refuses** an adapter without both. A `maxChars: 600` with no
  source is still refused;
- a zero-shot `kind: 'clips'` voice may carry the engine placeholder 600 with
  `maxCharsSource: "zero-shot placeholder"`.

The seeded **deathstalker** entry therefore has `maxChars: null`,
`maxCharsSource: null` and a `_pendingNote` — it is refused until the training
session sends the measured number. **The narration dropdown still shows it**,
greyed, carrying that note: a voice everyone is waiting for should not silently be
absent from the list.

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

`electron/higgs-spawn.ts`. The three phases go to three different places, and
that is not a design choice:

| phase | runs on | why |
|---|---|---|
| **prep** | ebook2audiobook | narrator **REFUSES `--prep_only`** by name — the packer is migration step 4 |
| **worker** | narrator `compat.worker` | e2a has no Higgs engine |
| **assembly** | narrator `compat.app --assemble_only` | Higgs needs the fades and the live `gapBefore/gapAfter`, which only narrator's assembler reads |

### Prep on e2a is sound, and it was checked

`lib/core.py:prep_ebook_info` parses the EPUB and packs sentences; **it loads no
TTS model.** The packing cap is a plain string comparison —
`elif tts_engine == 'orpheus': max_chars = int(os.environ['ORPHEUS_MAX_CHARS']) or 350`
(`lib/core.py:1553` and `:2437`). So a Higgs prep is spawned with:

- `--tts_engine orpheus` (`HIGGS_PREP_ENGINE_ALIAS`) — picks the PACKER;
- the **generic bundled env** (`HIGGS_PREP_ENV_ENGINE = 'xtts'`) — picks the
  interpreter, and keeps a text-only pass out of the WSL Orpheus spawn;
- `ORPHEUS_MAX_CHARS` = the Higgs catalog's measured `maxChars`;
- **no voice args** — a Higgs voice has no `--fine_tuned`/`--orpheus_*` form, and
  prep does not need to know the voice to pack text.

This is the same engine-agnostic-scaffolding move the codebase already makes in
the other direction (assembly's `--tts_engine xtts`).

> **Honest limitation.** This is e2a's SENTENCE packer. Owen's Higgs chunking rule
> is PARAGRAPH-based (v3's 8,192-token window fits ~4,000 chars). That packer is
> `narrator/text/paragraph_packer.py`, step 4, unwritten. Until it lands a Higgs
> book packs to 600-char sentence groups — which is exactly what every v3
> measurement was taken at, so it is the *measured* behaviour, not the *intended*
> one.

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
         --session <id> --session_dir <dir> --sentences_dir <dir> \
         --device CUDA --tts_engine higgs-v3 --higgs_voice <catalog id> \
         --sentence_start <n> --sentence_end <n>"
```

Assembly is the same shape with `-m narrator.compat.app` and the argv from
`--headless` onward.

- **`PYTHONPATH`, not `pip install -e`** (PORT_NOTES §9.2 offers both): the
  install is a per-env step a user must have run and is invisible when they have
  not. PYTHONPATH ships with the spawn, so the wiring and the thing it wires
  arrive together.
- **`cd ~`** — narrator reads cwd for nothing (PORT_NOTES §9.3) but the directory
  must exist inside the guest.
- **`EBOOK2AUDIOBOOK_PATH` is not set** — it was the sys.path bootstrap and
  narrator never reads it.

### Why it does NOT go through `spawnWithWslSupport`

`buildWslBashCommand` rewrites argv **by pattern**: any arg containing `orpheus`
becomes `-n <orpheusEnv>`, any path under the e2a root is remapped onto the WSL
e2a checkout, and it exports a fixed `ORPHEUS_*` `forwardKeys` list. Every one of
those rules is wrong here, and silently so — **a Higgs command through that
function comes out an Orpheus command.** Leaving it untouched is also what makes
the Orpheus argv provably unchanged.

### Refusals before the job is queued

`higgsPreflight()` runs in the modal (`stageRefusal`) and again at spawn time.
Twice on purpose: the first turns a doomed run into a sentence someone can read
while the dialog is still open; the second catches an env that broke *after*
queueing. Order is env → voice → narrator, because "there is no Higgs
environment" explains "this voice cannot render" and not the reverse.

### Watchdog

The ~55 s cold start needed **no change**: the only stall watchdog on this path is
`PREP_STALL_TIMEOUT_MS` (10 minutes), and the worker path has none.

---

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
| an invented `HIGGS_*` env set | `NARRATOR_HIGGS_VOICES` (a **path**), `NARRATOR_HIGGS3_{URL,SERVE_SCRIPT,ADAPTER_STRATEGY,WSL_DISTRO}` |
| caps passed as env vars | caps do **not** travel — narrator *raises* on a `caps` payload |
| the voice named by `--fine_tuned` | `--higgs_voice <catalog id>` (the two are not interchangeable) |
| `voice: {kind:'adapter', path}` \| `{kind:'clips', clips}` | always `clips`, with `adapterDir` on the same object |
| clips as `{path, transcript}` | `{path, transcript, **seconds**}` — a clip without a declared duration is refused |
| several clips allowed | **exactly one**; multi = a pre-joined wav, joined at staging |
| cold start ~55 s | **297 s**, against a 300 s `READY_TIMEOUT_SECONDS` |

Still open:

1. **`SentenceSink` reading `pads` / `edge_fade_ms`.** The engine reports both;
   nothing consumes them yet. Higgs is the first engine with `pads = False`, so
   the 10/25 ms fades and the live `gapBefore`/`gapAfter` need a consumer. Note
   the tail trim is **server-side** (`patch_tail_trim.py`) — the client must
   **not** trim again; what is left is a hard sample boundary, i.e. the fades.
2. **`narrator/text/paragraph_packer.py`** (step 4) — see §5's limitation.
3. **Packaging.** `python/` is not in electron-builder's `files`, so narrator is
   not packaged. Whoever ships narrator owns that; `narratorPythonRoot()` already
   resolves the dev and `asarUnpack` layouts.
4. **Where the launch script should live.** narrator invokes the *operator's*
   script rather than writing its own, and BookForge's installer deploys its copy
   to `<env>/bin/serve_higgs_v3.sh` — which is what `NARRATOR_HIGGS3_SERVE_SCRIPT`
   points at. If narrator would rather be handed the campaign path, that is a
   one-line change here.

### Waiting on the training session

5. **The deathstalker adapter.** What exists is a **quick 300-step r32 LoRA** at
   `…/higgs/v3_ft/runs/quick30_r32/final`; the full 12.4 h ds_ad4 corpus run has
   not been started. It must be staged at
   `/home/<user>/higgs-models/deathstalker` and the `_pendingNote` removed.
6. **Its `maxChars` must be MEASURED by a length sweep on that adapter**, and
   recorded with a `maxCharsSource`. This is the one the loader hard-refuses on:
   an adapter's stop length follows its **training clip length**, so the
   zero-shot 600 would silently lose most of every chunk. Verify by ASR
   alignment, never by duration ratio.
7. **`NARRATOR_HIGGS3_ADAPTER_STRATEGY` is UNKNOWN.** The fine-tune was rendered
   through the trainer's own `generate_audio`, never through the served stack, so
   whether vllm-omni takes `--lora-modules` for `higgs_multimodal_qwen3` — or
   whether a merged checkpoint served as its own model dir is the only route —
   has never been exercised. **Both strategies require a server restart.** No
   voice declares one, and nothing guesses: the wrong strategy is a server that
   comes up serving the **base** voice and renders an entire book in it while
   reporting success. `serve_higgs_v3.sh` already accepts `HIGGS_MODEL_DIR` for
   the `merged-dir` case.

### Decisions to confirm with Owen

8. **F5 and Voxtral left the picker** as a consequence of narrowing it (§2).
9. **The XTTS streaming runtime was kept** (§2) — Listen still defaults to XTTS
    on a machine with no configured engine.
10. **`custom-voices.ts:190` `CUSTOM_ENGINE = 'xtts'`** ties the whole *"add your
    own voice"* feature (checkpoint upload, `--custom_model`) to the retired
    engine. It still works — XTTS was retired as a *narration choice*, not
    deleted — but the feature now has no engine that a narration run can select.
    Higgs's `clips` voice kind is architecturally the natural replacement
    (zero-shot reference-clip cloning) and would need a real design pass.
    **Untouched — out of scope for this brief.**

---

## 9. Verification

| | |
|---|---|
| `npx tsc -p tsconfig.electron.json --noEmit` | clean |
| `npx tsc -p tsconfig.app.json --noEmit` | clean |
| `npx ng build` | clean (the 672 kB budget warning is pre-existing) |
| `node tools/run-keepers.js` | **ALL KEEPERS GREEN** — 54 suites |
| `install_higgs_env.sh --check` against the live `higgs3` env | verified read-only; found `launcher=absent` correctly, exit 1. **Nothing installed or modified.** |

New keepers:

- **`tools/test-higgs-engine.js`** — the engine-id model, legacy `xtts` handling,
  the voice-catalog routing switch, all three catalog refusals, caps and the
  `NARRATOR_*` env, the voice document, doctor↔catalog patch-table agreement, and that the WSL scripts
  are LF. *It found a real bug during authoring:* `higgsSpawnEnv` shipped an
  untranscribed clip because the refusal lived only in `resolveHiggsModel`.
- **`tools/test-orpheus-argv-snapshot.js`** — the baseline in
  `tools/snapshots/orpheus-argv-base.json` was extracted from **`01a3799b`, before
  any of this work**, and covers all five e2a doors (prep, retake, lightweight
  worker, app.py worker, assembly). The one licensed substitution
  (`prepEngine.envEngine` for `settings.ttsEngine`) is named in the test and
  backed by an assertion that `prepEngineFor` is the identity for every non-Higgs
  engine — not by a regenerated baseline.

Known unrelated flake: `test-bookshelf-stream-teardown` passes in the runner and
fails standalone on a timing-dependent idle-release assertion. This branch touches
**zero** bookshelf files.
