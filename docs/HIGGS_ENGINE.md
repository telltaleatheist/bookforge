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
    "voice": {
      "clips": [],                //   [{path, transcript, seconds}] - ONE at most
      "checkpoint": {             //   a MERGED fine-tune dir (~8.5 GB), ONE PER ARM
        "wsl":    "/home/telltale/higgs_v3_merged/<dir>",   // guest-absolute
        "darwin": "runtime/higgs-models/<dir>"              // relative to userData
      }
    },
    "license": "boson-higgs-tts-3-research-noncommercial",
    "commercialUse": false,
    "sampleRate": 24000,
    "addedAt": "2026-09-04",
    "_pendingNote": "...",        // present => artifact not installed => REFUSED
    "backends": {               // ONE BLOCK PER BACKEND; the loader picks by ARM
      "served": {               //   wsl    -> vllm-omni behind WSL
        "maxChars": 600,        // null on an unmeasured fine-tune => REFUSED
        "maxCharsSource": "placeholder",   // catalog | placeholder | length-sweep
        "edgeFadeMs": { "in": 10, "out": 25 },
        "sampling": { "temperature": 1.0, "topP": 0.95, "topK": 50 },
        "referenceSecondsCap": 30,
        "allowedControls": []
      },
      "mlx": { ... }            //   darwin -> in-process mlx-audio. ITS OWN cap.
    }
  }]
}
```

### One checkpoint per ARM, and one certificate per BACKEND

Two rules, both discovered the same way: **the two Higgs arms cannot see each
other's disks, and cannot inherit each other's measurements.**

**THE PATH.** A `checkpoint` voice had ONE `voice.checkpointDir`, and it held the
WSL guest's path. On the Mac that wrote `/home/telltale/higgs_v3_merged/...` into
the voice document and the MLX backend refused a directory that machine has never
had - correctly, by name, and five minutes after the environment had been reported
green. The merged directory is now staged on the Mac too (2026-09-05, sha256-verified
against the frozen WSL dir, same basename), so the catalog names it once per arm:

| key | shape | why |
|---|---|---|
| `wsl` | **absolute**, guest-resident (`/home/...`, or its `\\wsl$\<distro>\...` UNC form) | it is what the launch script is started on INSIDE the guest, whose home is fixed. A `C:` path is not another spelling - it is a different directory, behind the 9p mount, which is ruinous for 8.5 GB |
| `darwin` | **relative to the app's userData** (`runtime/higgs-models/<dir>`) | a Mac's Application Support path carries the ACCOUNT NAME, so an absolute `/Users/telltale/...` in a repo-tracked catalog names a directory that exists on exactly one machine. The app knows its userData; the catalog does not |

The exact Mac location today:

    /Users/<account>/Library/Application Support/BookForge/runtime/higgs-models/ds_ad4lm_prod_ckpt1080

- beside `.../runtime/higgs-models/base`, which is where `higgsMlxBaseDir()` puts
the zero-shot weights, so one directory holds everything the MLX arm loads.

`higgsVoicesDocument(model, target)` writes the ONE path for the arm being
spawned, resolved to absolute, so **the wire format is unchanged**: narrator still
reads a single `checkpointDir`. The retired `voice.checkpointDir` is REFUSED if it
reappears, the way narrator refuses `adapterDir` - a catalog still written the old
way would silently lose its staging.

**A MISSING ARM IS NOT A GAP TO FILL FROM THE OTHER ONE.** The voice is not
loadable there, and it is refused by name:

> Higgs voice "deathstalker" is not staged for the Mac: no darwin checkpoint in
> the catalog (it names only: wsl). A fine-tune renders from its OWN merged
> directory, and the two arms cannot see each other's disks - so the other arm's
> path is not an answer, it is a directory this machine has never had. Copy the
> merged directory to this machine, add its location to
> electron/data/higgs-models.json, and MEASURE this arm's cap: **a copy is the
> same weights but a new certificate.**

`listRenderableHiggsModels()`, `higgsNarrationVoices()` and `resolveHiggsModel()`
are arm-aware off ONE function - `higgsVoiceUnavailableReason()`, which returns
the refusal's own text - so the narration dropdown, the Listen voice list and the
run cannot disagree about which voices this machine has.

**THE CERTIFICATE.** `backends` holds one block per BACKEND, and they share no
numbers. An ARM is a filesystem; a BACKEND is a runtime; `BACKEND_FOR_ARM` in
`electron/higgs-models.ts` is the one place the two vocabularies meet
(`wsl -> served`, `darwin -> mlx`).

> **A copy is the same weights but a NEW CERTIFICATE for the MLX backend.**

A cap is produced by *rendering*. mlx-audio's top-k/top-p and vLLM's are different
implementations over different runtimes, so feeding both the same three numbers
from the same `generation_config.json` makes the **configuration** identical and
not the draws; the seeds are not comparable either (`mx.random.seed` vs vLLM's),
and as of 2026-09-05 nothing has compared a Mac render against a WSL one at all
(PORT_NOTES 13.11). So `deathstalker`'s `backends.mlx.maxChars` is `null` and the
loader refuses it on darwin - the same refusal the served `null` makes on WSL:

> Higgs fine-tune "deathstalker" has no MEASURED maxChars on the mlx backend (got
> null, source null, from backends.mlx). A CERTIFICATE IS PER (DIRECTORY,
> BACKEND): the number measured on the other backend does not transfer ...

The one thing that IS stated on both arms is a **placeholder**, and only because a
placeholder makes no claim: `default` carries 600/`placeholder` in both blocks, as
does narrator's own `HiggsV3Defaults.MAX_CHARS`.

#### What the MLX sweep must measure

Owed, on the Mac, against
`.../runtime/higgs-models/ds_ad4lm_prod_ckpt1080` - **the same ladder and the same
rule as the served certificate**, because the method is what transfers and the
number is not:

- lengths **600 / 900 / 1200 / 1500** characters, **4 seeds per length**;
- scored by **ASR alignment**, never by duration ratio (a v3 render measured
  duration ratio 0.99 while dropping 22 % of its text);
- the cap is the **largest length carrying zero babble across every seed AND
  >= 90 % coverage on every seed, contiguous from the shortest**;
- record it in `backends.mlx` with `maxCharsSource: "length-sweep"`.

The ckpt-480 served ladder (600 98.5 %, 900 97.7 %, 1200 95.5 %, 1500 87.2 %) is
that method's worked example and **not** a prediction of this arm's answer: it
belongs to another directory on another backend.

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
| `checkpoint` | `checkpointDir` | a **merged** fine-tune directory (~8.5 GB). ONE absolute path - the catalog holds one per arm and `higgsVoicesDocument` writes the arm's own |
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

The **deathstalker** entry therefore has `maxChars: null`, `maxCharsSource: null`
and a `_pendingNote` — it is refused until *this directory's* sweep sends the
number. **The narration dropdown still shows it**, greyed, carrying that note: a
voice everyone is waiting for should not silently be absent from the list.

`maxCharsSource` stays a **token**, not a sentence. It travels into narrator's
voice document, where `protocol.MAX_CHARS_SOURCES` is a closed vocabulary —
`catalog` | `placeholder` | `length-sweep` — and anything else is refused by name
at `load_voices`. So the method's *name* rides the wire and the measurement
itself lives in `_maxCharsNote`, which never leaves this side.

<a id="certificates-a-cap-belongs-to-a-directory"></a>

### Certificates: a cap belongs to a DIRECTORY, not to a voice

A cap is produced by rendering against **one merged directory** on **one patched
server**. So what is certified is a triple, and every part of it is load-bearing:

> **certificate = (checkpoint directory, stage-processor patch sha256, max_chars)**

- change the **directory** — a re-merge, a different checkpoint of the same run,
  a copy staged elsewhere — and the weights or their sampling file may differ;
- change the **patch** — even the one-line fix queued for the `:403` counting bug
  — and the decode path that produced the measurement is not the one running;
- and `max_chars` is the only number in the triple that can be *read* rather than
  measured, which is exactly why it must never be inherited.

Nothing compares two directories byte for byte. The binding is **stated**, here
and in the catalog's `_checkpointDirNote`, and a change to any part of it means a
**new certificate**, not a promotion.

#### What is on disk, 2026-09-05

| directory | what it is | certificate |
|---|---|---|
| `/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080` | **PRODUCTION.** ckpt-1080, the lowest-loss checkpoint, chosen by Owen after an ear test. What `electron/data/higgs-models.json` names | **none yet** — staged, not served-certified. `maxChars` is null and the loader refuses the voice |
| `/home/telltale/higgs_v3_merged/ds_ad4lm_prod` | **ALTERNATE.** ckpt-480, the rule-picked checkpoint. Kept on disk | **`max_chars` 1200**, certified 2026-09-05 against this directory and the patched stage processor `0b36f650…` |

Both are **frozen**: a re-merge or a recipe change writes a new directory name and
re-certifies, and since 2026-09-05 a merged directory may not be **renamed**
either (see the provenance correction below). Certification asserts that a
directory's `merge_manifest.out` names *itself*, so a checkpoint whose manifest
points somewhere else cannot be certified at all.

#### The ckpt-480 certificate — the method every sweep repeats

Measured 2026-09-05 by the Higgs fine-tuning session
(`E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs`), on the **served**
path: `vllm-omni` started on the directory, with that directory's
`generation_config.json` in place. **4 seeds per length**, scored by **ASR
alignment** and never by duration ratio.

**The rule.** The certified cap is the largest length carrying **zero babble
across every seed** *and* **≥ 90 % coverage on every seed**, **contiguous from the
shortest** — one good seed at a longer length does not extend it.

| chunk length | worst-seed ASR coverage | babble |
|---|---|---|
| 600 | **98.5 %** | 0/4 |
| 900 | **97.7 %** | 0/4 |
| **1200** | **95.5 %** | 0/4 → **certified** |
| 1500 | **87.2 %** | 0/4 → **fails on coverage** |

**1500 fails on coverage, not on babble.** Babble was **0/16** across the whole
sweep once the directory's `generation_config.json` restored `top_k 50` — which is
what identified the babble class as **untruncated sampling**, not length. That is
the same finding the required-file section above rests on.

**Provenance of the directory itself**, from `merge_manifest.json` beside the
weights: lora `runs/ds_ad4lm_prod/ckpt-480`, base snapshot `239f63fb…`,
`generation_config.json` written as an **OVERRIDE** from
`runs/ds_ad4lm_prod/generation_config.override.json` (`{temperature 1.0, top_p
0.95, top_k 50, repetition_penalty 1.0}`), 252 merged matrices, `model.safetensors`
8.49 GB.

**And why 1200 is not on the production entry.** ckpt-1080 is different weights.
Its own sweep has not been run, so its cap is `null` and the voice is refused —
by the `_pendingNote` *and*, independently, by `refuseUnmeasuredAdapter`. Copying
1200 across would be a cap nobody measured for those weights.

#### The three things the Mac doctor can say about a fine-tune

`mlxVoiceNotes` in `electron/higgs-doctor.ts` reports three distinct states,
because they send a person three different places. One sentence covered the first
two until 2026-09-05, which told a person to go looking on disk for a directory the
catalog had never named on this arm.

| note | what is true | the fix |
|---|---|---|
| `not staged for this arm` | the CATALOG names no `darwin` checkpoint | nothing to download until someone stages it - and staging means MEASURING this arm's cap |
| `staged path missing on disk` | the catalog says where it is and it is not there | copy the merged directory (~8.5 GB), or finish the interrupted copy |
| `loadable - fine-tuned weights at <dir>` | both | - |

They are **notes, never checks**: a green environment with no fine-tune staged is
a working installation. A malformed staged path is reported as a note too (through
`attempt()`), because a doctor that throws is a modal with no rows in it.

#### A provenance correction, and the two guards it bought

**Found 2026-09-05.** The ckpt-1080 directory's `merge_manifest.json` gave
`"out": ".../ds_ad4lm_prod"` — its *sibling's* path — and its
`generation_config.json` said `"_written_by": "backfilled 2026-09-05 for
ds_ad4lm_prod"`. Recorded rather than tidied away, because a stale path string is
exactly how two merged directories stop being distinguishable.

**Cause.** It was merged *to* the path `ds_ad4lm_prod` and **renamed** to
`ds_ad4lm_prod_ckpt1080` when ckpt-480 took the `ds_ad4lm_prod` name. The path
strings were stale, and only the path strings.

**Corrected in place 2026-09-05T10:35:56** by the training side: both files now
name this directory, each carries a timestamped `provenance_correction` recording
the rename, and the original value is **kept** rather than overwritten
(`out_original_at_merge_time`).

**Confirmed** by re-reading both files read-only:

| | |
|---|---|
| `merge_manifest.out` | `/home/telltale/higgs_v3_merged/ds_ad4lm_prod_ckpt1080` ✓ |
| `generation_config._written_by` | `merge_for_serving.py for ds_ad4lm_prod_ckpt1080 (from runs/ds_ad4lm_prod/generation_config.override.json)` ✓ |
| `lora` | `runs/ds_ad4lm_prod/ckpt-1080` — unchanged |
| snapshot | `239f63fb…` — unchanged |
| sampling | `1.0 / 0.95 / 50 / 1.0` — unchanged |
| `model.safetensors` mtime | **08:08, unchanged** against the two JSONs' 10:35 — the weights were not touched |

**And it cannot happen again**, which is the part a certificate cares about:

1. the **immutability rule** now forbids renaming a merged directory at all — a
   re-merge writes a new name;
2. **certification asserts `merge_manifest.out` equals the directory being
   certified**, so a stale path cannot reach a certificate in the first place.

The catalog path is still what says which weights render — but it is no longer
the *only* thing: the directory now names itself.

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

### The two doctors — `higgsDoctor()` (2026-09-05)

Higgs v3 is **one engine with two backends** (PORT_NOTES 13), so "is Higgs ready"
has two different answers and, since this branch, two different doctors.
`electron/higgs-doctor.ts` holds the dispatcher and the macOS one; the WSL one
stays in `tool-paths.ts` where it was.

| `process.platform` | doctor | `arm` |
|---|---|---|
| `win32` | the WSL doctor below, with the **"WSL2 for Higgs" toggle as its own row in front of it** | `wsl` |
| `darwin` | `checkDarwinHiggsSetupAsync()` — one `conda run --no-capture-output -p <narrator-mlx prefix> python -c` | `mlx` |
| anything else | a refusal that **names the platform** (BookForge builds neither backend on Linux) | `none` |

**Why this exists.** Until 2026-09-05 there was one doctor and it answered
everywhere, so on the Mac the narration modal said *"The Higgs environment is not
ready … : WSL distribution. Set it up in Settings → Higgs, or pick Orpheus on the
Reading tab"* — on a machine that renders Higgs fine. That string was the WSL
doctor's non-Windows early return, displayed as a diagnosis. The mirror-image bug
sat in `higgsEnvironmentRefusal()`, which returned `null` on darwin having checked
**nothing**: an unchecked pass, which lets a job start and fail an hour in.

**The remedy travels with the result.** `HiggsSetupResult` carries `arm` and a
one-sentence `remedy`, and the modal and the Settings panel quote it rather than
appending their own. "Set it up in Settings → Higgs" is wrong advice on a Mac,
where that panel's only button builds a WSL environment — and the renderer is not
the place to work out which arm it is looking at.

**The toggle is a row, not an early return.** On Windows with `useWsl2ForHiggs`
off, the doctor still reports the five WSL rows *plus* a failing `toggle` row.
The environment can be perfectly installed with the toggle off, and the Settings
panel has to be able to show that.

#### The macOS doctor's checks

**ONE `conda run` round trip** — by PREFIX (`-p`), never by name (`-n`), because that
is what `narratorNativePython('higgs')` builds and the whole point is to probe the
environment the render will use — same one-round-trip rule as the WSL one, and it **imports, it
does not load** — the backend module imports mlx lazily by design, so the whole
probe is about a second rather than 8.5 GB.

| check | how |
|---|---|
| `env` | `narratorNativePython('higgs')` — **the spawn's own resolution**, so a green doctor cannot be about a different env from the render's |
| `python` | the interpreter in that env answered at all |
| `mlx` | `import mlx.core` |
| `mlx-audio` | installed **and** exactly `0.4.8` (`HIGGS_MLX_AUDIO_VERSION`, mirrored from `mlx_backend.MLX_AUDIO_VERSION`; a keeper asserts they agree) |
| `narrator` | `import narrator.engine.higgs.mlx_backend`, with `PYTHONPATH` = `narratorPythonRoot()` as the spawn sets it |
| `weights` | `NARRATOR_HIGGS3_MLX_MODEL`'s directory (`<userData>/runtime/higgs-models/base`) holds `config.json`, `tokenizer.json` and at least one `*.safetensors` |
| *(notes)* | which catalog voices this arm could load — **informational, never part of `valid`** |

The required files are read out of mlx-audio 0.4.8, not guessed: `load_model`
reads `config.json`, `post_load_hook` opens `tokenizer.json`, and the codec comes
out of the same shards (`from_higgs_tts_checkpoint`). `tokenizer_config.json` and
`chat_template.jinja` ship with the repo and are **not** read on this path;
`generation_config.json` is a *checkpoint voice's* sampling and is absent from the
base weights by design.

`env` and `weights` are answered on the HOST rather than inside the probe — on
darwin there is no guest, so it is the same filesystem, and answering them here
means they still report when the probe itself could not run.

There is **no macOS installer**. The `narrator-mlx` env is built by hand from
`packaging/env/narrator-mlx.yml`, so Settings → Higgs offers Install/Repair on the
WSL arm only and shows the remedy line instead.

### The WSL doctor — `checkWslHiggsSetup()`

**ONE `wsl.exe` round trip** (each spawn costs most of a second on a cold VM, and
a five-second doctor is a doctor nobody runs). The probe emits one `key=value` per
check and **never short-circuits** — every check is reported pass or fail, because
"the sentinel-filter patch is missing" and "there is no WSL distro" are both
`valid: false` and have nothing else in common.

| check | how |
|---|---|
| `distro` | did the probe run at all |
| `env` | `test -d <conda-base>/envs/<name>` |
| `vllm-omni` | `<env>/bin/python -c 'import vllm_omni'` |
| `patch:vllm-negative-token-id` | grep `min_input_id != -100` in `vllm/v1/engine/input_processor.py` |
| `patch:higgs-sentinel-filter` | grep `_filter_sentinel_frames` in `vllm_omni/.../higgs_audio_v3.py` **and** grep for the ABSENCE of `[:, :-1]` |
| `launcher` | `test -x <env>/bin/serve_higgs_v3.sh` |

A missing probe line is **not** a pass — defaulting those to ok would report green
for a machine with no WSL.

**The sentinel-filter row asks two questions, not one.** A marker alone answers
"did somebody apply something here", and that is not enough: the retired
`patch_tail_trim.py` wrote one of the same helpers
(`_trim_trailing_sentinel_frames`, which the live patch also writes for the
streaming path), so grepping for it would certify a band-aided file as patched.
The marker is therefore `_filter_sentinel_frames` — the string only the live
recipe produces — and it is paired with an **absent-marker**, `[:, :-1]`:
upstream's one-frame trim, which occurs **twice** in the pristine
`higgs_audio_v3.py` and **zero** times after the patch (measured on the
certifying box, vllm-omni 0.28.0, 2026-09-05). Marker-present **and**
trim-absent is exactly *"the token-identity filter is in and no trim code
remains"*. A file that satisfies one and not the other reports
`patch:...=trim-survived` — half-applied or stacked, which is not patched. Both
greps are `-F` (fixed string): `[:, :-1]` as a basic regular expression is a
bracket expression matching a single character, and would report every
environment broken.

The patches get their own rows **because pip reverts them silently**: any upgrade
in the env replaces the site-packages file and the patch is gone with no error.
Marker-grepping is what makes "is it applied" answerable without a diff.

### The two patches, and what breaks without them

| patch | without it |
|---|---|
| `patch_vllm.py` | vLLM 0.28's blanket negative-token-id rejection fires on vllm-omni's `AUDIO_PLACEHOLDER_ID` (-100). **Every voice-clone request returns HTTP 400** and only the default speaker can serve. |
| `patch_sentinel_filter.py` | the ramp-down BOC/EOC sentinels are substituted with codec code **0 — a valid code that decodes to real sound** — and only one frame (40 ms) is trimmed, leaving ~240 ms of audible garbage at the end of **every chunk**. Owen heard it as "a stray syllable or sound after each sentence". |

#### `patch_sentinel_filter.py` supersedes `patch_tail_trim.py` (2026-09-05)

The band-aid is **deleted** from `electron/scripts/higgs/`, not kept beside its
replacement: the two edit the same file, must never stack, and a retired script
next to the live one is how a retirement gets undone by somebody tidying up.

| | `patch_tail_trim.py` (retired) | `patch_sentinel_filter.py` (live) |
|---|---|---|
| decides by | **position** — walk back from the end while frames are bad | **token identity** — keep a frame iff all 8 codebooks are in [0, 1023] |
| the 0-substitution | kept, for every sentinel outside the trailing run | **gone**: nothing out of range reaches the codec at all |
| sync path (`talker2code2wav`) | trailing run only | full filter — leading, interior and trailing |
| streaming path (`async_chunk`) | trailing run | trailing run **only**, deliberately: Stage 1 trims `left_context_size`/`right_holdback_size` **by frame count**, so dropping a leading or interior frame would desync those trims and cut real speech |
| interior sentinels | reached the codec as code 0 | dropped **and logged** — a gate is a defect sensor, not a silent repair |
| measured effect on the terminal burst peak (band-aid vs unpatched) | −29.8→−46.2, −31.9→−43.4, −31.6→−52.8, −29.9→−49.1 dB | — |

**The shipped script is a transcription, and the transcription is measured.**
Every anchor, helper and replacement in `electron/scripts/higgs/patch_sentinel_filter.py`
is byte-identical to the campaign's `work/patch_sentinel_filter.py`; only the
target path (resolved from the env prefix, so it ships) and the supersession
handling differ. Verified 2026-09-05 against the pristine file read out of WSL:

| | sha256 |
|---|---|
| pristine `higgs_audio_v3.py` (vllm-omni 0.28.0) | `376ca5647773cb191634b266b03bfefe490c080ef9f75aed045f1f31c9a19fb4` |
| patched, on the certifying box | `0b36f6507dd11653253bbebb278c3657e5d17a2a52f78018cd0bddd45a7ac210` |
| patched by the repo script, from pristine | **the same** `0b36f650…` |
| patched by the repo script, from a band-aided file via its `.orig` | **the same** `0b36f650…` |

A band-aided file with **no** `.orig`, or an `.orig` that is itself patched, is
refused by name (`SUPERSEDED_NO_ORIG` / `ORIG_NOT_PRISTINE`, exit 1) rather than
guessed at — writing unknown bytes into the file whose sha256 a certificate names
is the one thing this script must never do.

#### The readiness probe is a SENSOR now, not a gate

`probe_tail_trim` rendered one fixed-seed word at load and **refused** a server
whose last 300 ms measured above **−45 dBFS**. That was valid while an unpatched
tail was ~250 ms of decoded sentinels at about −30 dB against a patched −62.4 dB.

**The sentinel filter invalidates it.** The filter *removes* those frames rather
than quieting them, so the window now holds the model's own audio: the certifying
box measured **−35 to −38 dBFS on BOTH builds** (2026-09-05). No level separates
them, so no threshold — looser or tighter — can decide this question. The method
is renamed `probe_sentinel_filter`, **reports** the level against that measured
band, and refuses only a 200 that carries no audio at all. A narrator test
asserts no `*MAX_DBFS` constant comes back, because a retired gate returns as a
new constant.

What *would* prove the patch, both halves from the fine-tuning session:

| half | state |
|---|---|
| **(a) the server's own log, READ.** Every trailing-ramp line reports exactly 2 frames, and **zero** sync-path interior drops — a frame failing the token test between two good ones, which offline classification puts at 0 on all real shapes and the detector has never fired on | **DONE 2026-09-05** — `verify_sentinel_filter`, below. `TODO(higgs-sentinel-proof)` is closed |
| **(b) no trim code left in the stage processor** (`[:, :-1]` absent) | **ENFORCED TODAY**, statically and before any server starts — the doctor's absent-marker, above |

#### The server's log is narrator's, and the proof reads it

`start()` used to send the launcher's stdout **and** stderr to
`subprocess.DEVNULL`. That threw away the only record of what the decode path
did — which is exactly where the sentinel filter reports itself — and it also
meant a server that died during its 55–297 s start left its reason nowhere,
while `wait_ready`'s "check its log" pointed at nothing.

Both streams now go to **one file the backend owns**, opened `wb` so each start
overwrites — the same contract as the training side's `serve_current.log`, and
what lets the proof say *this run* rather than *some run*.

| | |
|---|---|
| where | `<process_dir>/higgs-v3-server.log` — the session's own directory, which already holds `session-state.json` and the Orpheus guards' rejects. narrator has no other log **file** anywhere: its engine lines go to a *stream* the host picks (`engine/log.py`), so this is a new artifact and it lives with the run |
| with no session | a per-instance file beside the pid file (`<tmp>/narrator-higgs3-<pid>-<id>.log`) — an audition or a test. Two workers must never share one log, for the reason they must never share one pid file |
| discoverable as | `BackendSpec.server_log`, and `serverLog` in the worker's `loaded` message. The log is **evidence**, so a tool or a ledger entry has to be able to find it without reconstructing a path |
| ATTACH mode | narrator did not start that server and its output went wherever its operator sent it. It reads a log **only** if the operator names one in **`NARRATOR_HIGGS3_SERVER_LOG`** — *no default*, because a stale log from an earlier run would let the proof pass on evidence from a server that is no longer up. The training side tees to `E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\v3_ft\logs\serve_current.log` (overwritten per start), which is the path to point it at — given in the form the **reading** process sees, so `/mnt/e/training/…` from inside WSL |
| adopted server | `start()` adopts a server already on the port; that one's output is not ours either, so the spec **stops naming** our file and the proof falls back to the operator's named log or to none |

`verify_sentinel_filter()` runs in `load_engine` immediately after the probe
render — the render that has just put one chunk through the decode path — and:

- **refuses if there is no log, or it cannot be read.** The proof *is* the
  stream; "no evidence" must never read as "no problem". When narrator is
  attached with no named log it does not call the proof at all and says
  **UNAVAILABLE** in the run log, because "not proved" and "proved" must not
  look the same;
- **requires every trailing-ramp line to report exactly 2 frames.** Not zero —
  see the instrumentation bug below. A line with any other count is a sentinel
  the trailing-run trim did not reach, and it is refused by name, with the count
  and the offending line quoted back;
- **refuses one single sync-path interior drop**, and any "every frame carried a
  stream sentinel" line;
- returns a report (log path, lines read, ramp lines, frames per line, sync
  interior drops) for a ledger.

Matching is on the **message**, not on `file:line`. On the certified build the
three lines are `higgs_audio_v3.py:403` (trailing ramp), `:126` (sync interior)
and `:119` (no audio at all) — but a line number is a property of the patch's
layout, and the queued fix below moves all three. The message text is what the
patch owns.

**The `higgs_audio_v3.py:403` warnings are not a defect in the audio.** The async
out-of-range count is taken *before* the trailing-run trim, so it counts the
normal 2-frame EOC ramp and prints "outside the trailing run" wrongly — an
instrumentation bug in the patch, measured equally in sequential and concurrent
renders. **Expect exactly `2 frame(s)` per chunk: count them and report the
count**, never read them as contamination. The one-line fix changes this file's
bytes and therefore lands as a **new server build with its own certificate**, not
under a cap certified against the current one.

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

**That is where a voice MAY be staged, and it is not where the deathstalker
fine-tune is.** Its merged directories live under `/home/telltale/higgs_v3_merged/`,
where the merge wrote them, and the catalog names one of those directly — because
**a cap is certified against a directory, not against a voice** (see
[Certificates](#certificates-a-cap-belongs-to-a-directory) below). Moving or
copying a certified checkpoint to the convention path would produce a directory
whose cap nobody measured, and nothing in BookForge, narrator or vllm-omni
compares two directories byte for byte.

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

3. ~~**The deathstalker checkpoint.**~~ **DONE 2026-09-05.** The quick 300-step
   r32 LoRA is history; the ds_ad4lm run trained, and two merged checkpoints are
   on disk — `ds_ad4lm_prod_ckpt1080` (production, chosen by ear) and
   `ds_ad4lm_prod` (ckpt-480, the alternate). Both carry the full required file
   set including `generation_config.json`. They are **not** at
   `/home/<user>/higgs-models/deathstalker/`, and deliberately so: see
   [Certificates](#certificates-a-cap-belongs-to-a-directory).
4. **`maxChars` for `ds_ad4lm_prod_ckpt1080` — STILL OPEN.** ckpt-480 is
   certified at **1200** (method and figures above); ckpt-1080 has no certificate
   and the catalog's `maxChars` is `null`, so the loader refuses the voice. The
   cap is per directory and may not be inherited. Run the same sweep on the
   production directory, then set `maxChars` + `maxCharsSource: "length-sweep"`
   and delete the `_pendingNote` — that is the whole promotion.
5. **No BookForge-side render has gone end to end against a Higgs checkpoint
   yet.** Every number here was taken by the training side's harness on the same
   served stack, which is not the same as a narration or Listen run through this
   app.
6. **The MLX arm has no copy of either directory.** They are WSL-only, so a Mac
   render of this voice refuses at `require_generation_config` — correctly, and
   by name — until a checkpoint is staged there. Staging one is a **new
   certification**, not an inheritance.

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
