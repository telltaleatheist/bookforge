# Setup and Settings, reworked around Crucible — the audit

Written 2026-09-14 on `feat/narrator-guarded-serve`, read-only, from the source and not
from memory. Owen's instruction: *"we have to completely rework and fully review every
single setup page and every option, and every single settings page option. all of them."*
and *"we dont need xtts - we removed it. so those setup pages can be removed completely."*

This document is the AUDIT and the PLAN. It changed nothing when it was written. Every row
names the file that proves it. Where a fact could not be verified it says so in the row
rather than guessing.

> **IMPLEMENTED 2026-09-14 — see §11 for the row-by-row ledger.** Thirteen commits, from
> `3dd3920e` to `1aa54721`. §11 says what each disposition became, with the commit that did
> it, and §11.8 names the eleven things that were NOT done with the reason for each. Read
> §11 before acting on any row above it: a row's disposition is what was DECIDED, and §11 is
> what HAPPENED.

## 0. The five rulings this audit is measured against

From `docs/CRUCIBLE_ROLLOUT_PLAN.md` §0a/§0b/§2a and `crucible/docs/PHASE13-OPERATOR.md`:

1. **One Crucible per machine, and it is the shared model pool.** Weights live once under
   `~/.crucible/{models,voices,rvc}/`; BookForge's own `runtime/higgs-models/`,
   `orpheus-models`, whisper models and RVC voices retire with the spawn layer that reads
   them (§2 ruling 1, §Tier-3 "one copy per model per machine").
2. **A model is unloaded the moment nothing holds it** (§2a.1). So no BookForge screen may
   present a model as "installed and therefore ready" — residency is a live fact of the
   server, and the only app-side verb is a lease.
3. **Crucible has its own page** (PHASE13 §0, §4). Install a job type, pull weights, watch
   progress, read the token — all on the server's own page. **What that deletes in the apps:
   the host probe, the step list, the printed pull list, the disabled "run it" button.** Both
   apps shrink to two doors: **Connect** (a pasted `crucible://` pairing line) and **Get one
   on this machine**, after which the door is **Open Crucible** (PHASE13 §5.2).
4. **Cloud is how an underpowered machine lights translate and simplify** (§2a.2), and the
   key picks the models — the app calls the provider's own listing, never a compiled list.
   **Foundry owns the cloud slots.**
5. **Orpheus goes INTO Crucible** (§0b B1, Owen 2026-09-14) or is retired in favour of
   Higgs. Until it does, deleting the legacy spawn layer deletes Orpheus.

Binding memory rulings: XTTS is deprecated and removed from narration pages; Higgs sampling
is ONE engine-level number (0.8/0.95/50, never a per-voice UI control); GPU is one global
choice; the align checkbox was removed; the ASR gate defaults off.

## 1. The two structural findings that decide most rows

### 1a. BookForge's Settings do not live in a file the main process can read

`SettingsService.saveSettings()` writes the whole settings blob to the RENDERER's
`localStorage['bookforge-settings']` (`src/app/core/services/settings.service.ts:600`;
loaded at `:564`). The class docblock at `:323` still claims
`~/Documents/BookForge/settings.json`, which is not true of any build.

Consequence, and it is the single biggest fact in this audit: **for most Settings options
there is no electron reader at all.** The value reaches the main process only as an
argument the renderer passes on an IPC call — so "who reads it" is usually "the renderer,
then whichever IPC handler that screen calls". The options that DO have a main-process
reader are exactly those persisted through main: `tool-paths.json`, `tts-engine.json`,
`tts-api.json`, `crucible-servers.json`, `crucible-routing.json`, `crucible-models.json`,
`app-settings.json` and the component registry.

The four keys actually in `%APPDATA%\BookForge\app-settings.json` on this machine are
`cleanTextModel`, `llmServer`, `vllmUrl`, `vllmModel` — that file is Foundry's, not the
Settings page's.

### 1b. The catalog of installable components IS the legacy spawn layer

`electron/components/component-catalog.ts:236` `getCatalog()` returns, in order:

| id | what it is | how it installs | resolved path read by |
|---|---|---|---|
| `calibre` | external binary | user installs Calibre | `electron/ebook-convert-bridge.ts:85` |
| `tesseract` | external binary | user installs Tesseract | OCR path (detect only) |
| `orpheus` | conda env (vLLM / MLX) | external detect; managed artifacts are STUBS (`url: ''`, `component-catalog.ts:187-191`) | `electron/narrator-paths.ts:308` → the WSL/native narrator spawn |
| `llama-cuda` | GPU pack for bundled llama.cpp | managed download | `electron/llama-bridge.ts:175` |
| `cuda-tts` | CUDA pack for the streaming TTS env | managed download | streaming engine |
| `cuda-rvc` | CUDA pack for the RVC env | managed download | `electron/rvc-bridge.ts` |
| `whisper-env` | conda env | managed download | `electron/components/whisper-env.ts:98` |
| `rvc-env` | conda env | managed download | `electron/rvc-bridge.ts:50` |
| `resemble-env` | conda env (Enhance) | external/native | `electron/enhance-bridge.ts:536` |
| `whisperx-env` | conda env (alignment) | managed download | `electron/whisperx-align-bridge.ts:128` |
| `qwen-align-env` | conda env (Qwen3 aligner) | managed download | `electron/qwen-aligner.ts:198` |
| `rvc-voice-*` (7) | RVC voice weights | managed download, `electron/data/rvc-voice-assets.json` | `electron/rvc-models.ts` |
| `whisper-model-*` (6: tiny…distil-large-v3) | ASR weights, `electron/whisper-models.ts:49-84` | managed download | `electron/transcribe-bridge.ts` |
| `foundry-cli` | the Foundry engine binary | GitHub release | `electron/foundry-bridge.ts:118,342` |

**Every row above except `calibre`, `tesseract` and `foundry-cli` is an env or a weight
that Crucible installs and holds** — job types `tts`, `asr`, `align`, `rvc`, `denoise`, and
the model/voice/rvc subjects of `GET /v1/catalog`. That is the whole of the
MOVE→CRUCIBLE / DELETE-AFTER-PASS column below.

Three defects found in the catalog while reading it:

- **`higgs-env` is resolved and never declared.** `electron/narrator-paths.ts:285` calls
  `componentManager.resolveEntry('higgs-env')`; no catalog entry has that id (grep returns
  that one line and nothing else). `resolveEntry` returns `null` for an unknown id
  (`component-manager.ts:1137`), so on a Mac `getEnvPathForEngine('higgs')` always throws
  "Higgs TTS environment not found. Install or locate it in Settings → Higgs" — and
  Settings → Higgs has no control that would create it.
- **`narrator-mlx` is the same shape** (`narrator-paths.ts:342`) — an env created by hand
  from `packaging/env/narrator-mlx.yml`, resolved through a registry nothing populates.
- **`generalAddOnIds` filters for `kind === 'blocks-model'`** (`settings.component.ts:2546`)
  and NO catalog entry declares that kind — the page-layout model the comment describes is
  not installable from anywhere.

## 2. First-run wizard — every step, every panel, every option

`src/app/features/first-run-setup/first-run-setup.component.ts` (882 lines, inline
template). Eight steps, declared at `:672-734`, ids at `:21`. Title is "Set up BookForge"
on a fresh install and "Configuration" otherwise (`:50`, `:745`). `next()` calls
`sel.enqueueSelected()` on EVERY transition (`:776`), so downloads start as you advance,
not at the end.

### 2.1 The eight steps

| # | step · what completing it writes | mounts | DISP | why |
|---|---|---|---|---|
| 1 | **library** — "Choose your library". Default folder or Browse; then `createLibraryAndAdvance()` (`:829-852`) → `library:set-root` → `<userData>/library-root.json`, plus `seedStarterLibrary()` (~550 MB sample, empty libraries only) and `ai.refresh()` | inline | **KEEP** | the only step that is not optional, and the only one about the user's own files. NOTE: `back()` is disabled at `currentStep() <= 1` (`:243`) — the library step is unreachable once passed |
| 2 | **ai** — "Set up AI". Writes nothing itself; the panel writes as you act | `ai-setup-wizard [embedded]` | **KEEP-REWORD** | survives as "AI and cloud keys", but four of its five cards move (§2.2) |
| 3 | **crucible** — "Where the GPU work happens (optional)". Writes nothing at step level | `crucible-doors` | **KEEP-REWORD** | becomes the CENTRE of the wizard, not an optional aside. Its subtitle ends "Skip it and BookForge keeps using this machine's own engines" — a sentence that stops being true the day the legacy switch is deleted |
| 4 | **orpheus** — "Orpheus — the narration engine" | `orpheus-voices-panel` | **DELETE** | it installs a LOCAL engine and pulls LOCAL voice weights. Ruling B1 decides whether Orpheus survives at all; either way this step becomes "which server", which is the Crucible step |
| 5 | **higgs** — "Higgs (optional)" | `higgs-voices-panel` | **DELETE** | same: a WSL env installer and an 8.5 GB HF pull, both Crucible's per PHASE13 §3.3 |
| 6 | **rvc** — "Voice enhancement (optional)" | `rvc-enhancement-panel` | **DELETE** | `rvc-env` + 7 voice archives; Crucible's `rvc` job type and `kind:"rvc"` subjects |
| 7 | **tools** — "Optional tools" | `multi-worker-toggle` + `add-ons-panel [selectionMode] [exclude]="['orpheus']"` | **KEEP-REWORD** | shrinks to Calibre + Tesseract + foundry-cli. The multi-worker toggle is inert (§3.7) and the CUDA packs are DELETE-AFTER-PASS |
| 8 | **download** — "Review & download": the selected components and their total bytes, then Finish | inline | **KEEP-REWORD** | becomes "Review" — with almost nothing left to download, it is a summary, not a download queue |

### 2.2 `ai-setup-wizard` (five cards) — mounted by step 2 AND by Settings → AI

Audited as rows in §3.4; the dispositions are the same in both hosts, which is the point of
one component with two hosts. In summary: Bundled local AI **MOVE→CRUCIBLE**, Ollama
**MOVE→FOUNDRY**, Crucible **KEEP**, Reading pages **MOVE→CRUCIBLE**, API keys
**MOVE→FOUNDRY**.

One wizard-specific row:

| option | what it does | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| the green "AI is already set up — you can continue." note (`:116-121`) | reads `ai.available()` | — | `AiService` | **KEEP-REWORD** | `ai.available()` is true for any provider including a Crucible whose model is not resident; after §2a.1 "set up" and "ready" are different facts |

### 2.3 `crucible-doors` — the three doors (mounted by step 3 AND by Settings → Crucible)

Audited in §3.13. `toggle()` lazily loads the install plan only for doors 2 and 3
(`:352-357`) because it spawns `wsl.exe -l -v` and `nvidia-smi` — correct, and worth
keeping when the doors are rebuilt.

| door | DISP | why |
|---|---|---|
| 1. Connect elsewhere (Name / Address / Token / Test / Add) | **KEEP-REWORD** | add PHASE13 §5.1's "Paste from Crucible" field |
| 2. Use the one on this machine (report + Test it) | **KEEP-REWORD** | PHASE13 §5.2: when `local` resolves, the door is **Open Crucible** |
| 3. Install one here (machine line, refusals, numbered commands, elevated commands, readme path, DISABLED "Install it for me") | **DELETE** the document, **KEEP** the probe and the driven button | PHASE13 §0: "the printed step list and pull list are DELETED". `DRIVEN_INSTALL_AVAILABLE` (`electron/crucible/install.ts`) is the flag, and §C4's order is: phase 13 lands → Owen publishes 0.6.0 → BookForge pins the tarball → flip |
| *(absent)* probe on entry | **RULING → BUILD** | §0b C2: the step should PROBE on entry — local found → connected + Open Crucible; none and hostable → Install; not hostable → Connect only. Today all three doors are always offered, closed |
| *(absent)* post-install module POST | **RULING → BUILD** | §0b C2 + PHASE13 §5.4 |

### 2.4 `add-ons-panel` in selection mode (step 7)

Shows every component EXCEPT `kind:'stt-model'`, `kind:'rvc-model'`, `rvc-env`, `cuda-rvc`,
and the `exclude` list (`['orpheus']`). An `effect()` pre-checks every compatible,
not-installed CUDA pack exactly once.

| option | what it does | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Select all / Deselect all, per-card "Add to downloads" | batches the downloads | `SetupDownloadService` (in-memory) | — | **KEEP-REWORD** | survives for three components |
| the auto-preselect of CUDA packs | ticks `llama-cuda` / `cuda-tts` / `cuda-rvc` on any NVIDIA machine | — | — | **DELETE** | it pre-selects gigabytes of local GPU stack on a machine that should be told to install a Crucible instead |
| System info line (platform · arch · CUDA name · VRAM · RAM · free disk) | explains an "incompatible" badge | `components:probe` | `system-probe.ts` | **KEEP-REWORD** | it should say what the SERVER has, from `GET /v1/accelerator`, beside what this machine has |
| Install / Download & Install / Cancel / Uninstall / Locate… / Use this path / Browse… / How to install / Test environment / Refresh / "Remove N downloaded add-ons" | the component lifecycle | `<userData>/components/installed.json` (`component-manager.ts:123`) | §1b's reader table | **KEEP** for calibre/tesseract/foundry-cli; **DELETE-AFTER-PASS** for every env and pack | see §1b |
| "Test environment" (only `orpheus`, `component-manager.ts:1418`) | runs `electron/python/env_diagnostics.py` | — | — | **DELETE-AFTER-PASS** | `crucible doctor` is the diagnostic |

### 2.5 `multi-worker-toggle` (step 7 and Settings → TTS Server)

`src/app/components/multi-worker-toggle/multi-worker-toggle.component.ts`.

| option | what it does | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| hardware advice banner | `WorkerConfigService.advice()` | — | renderer | **DELETE** (with the toggle) | |
| "Enable multiple TTS workers (advanced)" + 1–4 count | claims to set the worker count everywhere | **NOTHING** — the chain ends at `electron/orpheus-worker-pool.ts:2114`, an explicit no-op, and `:2096` hard-reports `enabled:false,count:1,min:1,max:1`; both stream engines map to that pool (`streaming-engine.ts:152-155`) | **NO READER** | **DELETE** | it persists nowhere and cannot change anything; its hint text ("Becomes the default everywhere") is false |

### 2.6 What the wizard's engine steps actually install (the DELETE case, in numbers)

From §1b and the panel audit, the four engine/tool steps offer, in total:
`orpheus` (conda env, managed artifacts are STUBS with `url:''`), `rvc-env`
(4.16 GB Windows / 577 MB macOS conda-pack), 7 RVC voice archives (80–185 MB each),
`resemble-env` (3.47 GB Windows / 936 MB macOS), `whisperx-env` (421 MB),
`qwen-align-env` (499 MB, macOS), `whisper` (35 MB overlay) + 6 whisper models
(75 MB – 3.09 GB), `llama-cuda` (~570 MB), `cuda-tts` (2.72 GB), `cuda-rvc` (2.72 GB),
and a Higgs WSL env + per-voice 8.5 GB checkpoint pulls.

**Every one of those is a job-type env or a subject in Crucible's catalog.** That is the
~250 GB §0b A2 says goes with the legacy layer, and it is why the four engine steps are
one step — "which server" — and not four.

## 3. Settings — every section, every option

15 sections are declared in `src/app/core/services/settings.service.ts:359-540`. Only TWO
(`general`, `audiobook`) have typed `fields`; the other 13 declare `fields: []` and are
drawn by hand inside `settings.component.ts` or by one of the eight panel components.

Columns: `section · option · what it does today · where its value lives · who reads it ·
DISPOSITION · why`.

### 3.1 `library` — "Library" (custom UI, `settings.component.ts:101-161`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Library Location + Browse + Save/Discard | the root of every project, audiobook and cache | `<userData>/library-root.json` (`electron/main.ts:1031`) | `main.ts:1014` at startup; `main.ts:5313-5331` on `library:set-root` | **KEEP** | files are the user's and nothing about them is a Crucible fact |
| `<app-remove-all-data />` | in-app uninstall of BookForge's data | — | its own IPC | **KEEP-REWORD** | must learn to say that Crucible's `~/.crucible` store is NOT BookForge's to remove |

### 3.2 `general` — "General" (typed fields)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| `maxRecentFiles` (number 5–50, default 10) | claims to cap the recents list | localStorage `bookforge-settings` | **NO READER FOUND** — `settings.service.ts:372` is the only occurrence repo-wide | **DELETE** | a control that reports success and does nothing |
| `diffIgnoreWhitespace` (toggle, default true) | AI-cleanup diff ignores whitespace | localStorage | `src/app/features/audiobook/services/diff.service.ts:107,1408,1416` (renderer only) | **KEEP** | a real, non-legacy reader; nothing to do with a server |
| "Guided setup" button | re-runs the first-run wizard at `/setup` | — | router | **KEEP** | the one door back into the wizard; it must point at the reworked wizard of §6 |

### 3.3 `storage` — "Storage" (custom UI, `settings.component.ts:162-235`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Page Render Cache: size / Refresh / Clear All Cache | `~/Documents/BookForge/cache/` | disk | `electronService.getTotalCacheSize()` / `clearAllCache()` | **KEEP** | page images, never a model |
| "Move to archive" (protect professionally-read audiobooks) | relocates uploads out of `output/` into `archive/` | disk | `library.migrateAudiobooksToArchive()` | **KEEP** | the AUDIOBOOKS-NEVER-DELETED rule's repair door |
| `<app-remove-all-data />` (second copy) | same as §3.1 | — | — | **KEEP-REWORD** | one copy is enough; and it must not claim to remove Crucible's store |
| *(absent)* — where the models are | — | — | — | **RULING** | after the cutover, "Storage" is the honest home for the one-copy-per-model-per-machine inventory. Foundry already has that card (`machine-models-card`). Does BookForge grow one, or link to Crucible's page? |

### 3.4 `ai` — "AI" (whole section = `<app-ai-setup-wizard [embedded]="true">`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Bundled local AI: per-model Download / Use / Delete / "Delete all downloaded models" | downloads a Cogito GGUF for the bundled llama.cpp | `<userData>` model dir; active id owned by main | `electron/llama-bridge.ts`, `electron/llama-model-server.ts` | **MOVE→CRUCIBLE** | an `llm` model is a Crucible subject (`GET /v1/catalog`); a second local llama.cpp is the second copy ruling 1 forbids |
| Bundled local AI: "Use local AI for cleanup" | sets `aiConfig.provider = 'local'` | localStorage `aiConfig` | `electron/ai-bridge.ts:2030` etc. via IPC args | **DELETE-AFTER-PASS** | its reader is the bundled llama server, part of the legacy local text layer the ONE switch covers (`electron/crucible/text-venue.ts:207`) |
| Ollama: Server URL + Test + "Get Ollama" | the Ollama base every non-Crucible text act uses | localStorage `aiConfig.ollama.baseUrl` | `electron/ai-bridge.ts` via IPC args; `pipeline-defaults-panel.component.ts:245` for the model list | **MOVE→FOUNDRY** | Owen's 22:40 reframe: Ollama is the beginner's default in STANDALONE Foundry, through Foundry's one door. Hosted BookForge is Crucible-only |
| Crucible: Server select | names a registry entry for the AI provider | localStorage `aiConfig.crucible.server` | `electron/ai-bridge.ts` (provider `crucible`) | **KEEP** | this is the shape everything else becomes |
| Crucible: Model select (+ "not resident" warning) | the model a cleanup runs on; never loads it | localStorage `aiConfig.crucible.model` | `electron/ai-bridge.ts`, residency checked at job start | **KEEP-REWORD** | §2a.1 makes "resident" momentary — the sentence should say the LEASE is what makes it resident, not an operator's earlier press |
| Crucible: "A model per text act" ×4 (clean / simplify / translate / analysis) | one Crucible model id per act | `<userData>/crucible-models.json` (`electron/crucible/text-models.ts`) | `electron/crucible/text-acts.ts`, `text-venue.ts` | **KEEP** | the act name travels on `X-Crucible-Act`; this is the built, ruled shape |
| Crucible: Test | ping+info against the chosen server | — | `crucible:test-server` | **KEEP** | |
| Crucible: "Use this Crucible for cleanup" | sets `provider='crucible'` | localStorage | `ai-bridge.ts` | **KEEP** | |
| Reading pages: Server URL / Model name / Pages at once / Test | an OpenAI-compatible VLM endpoint for Convert to EPUB | localStorage `vlmEndpointConfig` | reaches main only as IPC args: `electron/main.ts:10373`, consumed in `electron/vlm-convert.ts` | **MOVE→CRUCIBLE** | `vlm-convert.ts` already hands Foundry a Crucible base + `X-Crucible-Act: pages`; a hand-typed second endpoint is a competing owner of the same fact |
| Reading pages: "Pages would be read on X" | names the machine from the same decision the run makes | — | `resolveVlmRouteWithVenue` | **KEEP** | exactly the right pattern — the screen reads the decision, it does not restate it |
| API keys: Claude / OpenAI save · delete · clear all | cloud credentials for cleanup | localStorage `aiConfig.{claude,openai}.apiKey` | `electron/ai-bridge.ts:4575,4584` via IPC args | **MOVE→FOUNDRY** | ruling §2a.2 — Foundry owns cloud slots, and `foundry-app/src/app/pages/settings/cloud-card.component.ts` already implements them properly (kind, model, address, key, Test-that-lists) |
| *(implied)* the model dropdowns behind those keys | `CLAUDE_MODELS` / `OPENAI_MODELS` hardcoded at `src/app/core/models/ai-config.types.ts:90,96` | source | `pipeline-defaults-panel.component.ts:330-331` | **DELETE** | directly contradicts §2a.2 ("the key picks the models: the app calls the provider's own listing"). Three stale Claude ids and three stale OpenAI ids are shipped as the only choices |

### 3.5 `audiobook` — "Audiobook" (typed fields)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| `externalAudiobooksDir` (path) | pre-fills Export M4B | localStorage | `src/app/features/studio/studio.component.ts:2551` (renderer; then an IPC argument) | **KEEP** | user's files |
| `condaPath` (path) | conda executable override | localStorage **and** pushed into `tool-paths.json` by `narrator:configure-paths` (`main.ts:7331`, `narrator-paths.ts:164-170`) | `narrator-paths.ts:409,417`; `narrator-spawn.ts:714` | **DELETE-AFTER-PASS** | its only readers are the local narrator spawn's env resolution. **Also a duplicate**: the same key has a second control on Settings → Advanced |
| `narratorScratchPath` (path) | where in-progress narration sessions are written | localStorage **and** `tool-paths.json` | `main.ts:2765` → `narrator-paths.ts:88,108,116,128-138,668` | **KEEP** | a Crucible render still downloads artifacts into a local `sentencesDir` (`electron/crucible/render-artifacts.ts`), and assembly is local |

### 3.6 `bookshelf` — "Bookshelf Server" (custom UI, `settings.component.ts:239-332`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Port (number) | the LAN bookshelf's HTTP port | localStorage `bookshelfConfig.port`, sent as an IPC arg | `electron/bookshelf-server.ts` via `bookshelf:start` | **KEEP** | not a GPU fact at all |
| Start / Stop Server, status, Access URLs | runs the sharing server | — | `bookshelf:start/stop` | **KEEP** | |
| `bookshelfConfig.enabled` | set as a side effect of Start/Stop | localStorage | **NO READER** other than the settings UI — nothing auto-starts from it, despite the comment at `settings.service.ts:766-771` | **DELETE** | either it starts the server at launch or it should not exist |

### 3.7 `tts-api` — "TTS Server" (custom UI, `settings.component.ts:333-617`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Access Token (Show / Copy) | bearer every WS client presents | `<userData>/tts-api.json` | `electron/tts-api-server.ts:204-206` | **KEEP** | this is BookForge's own server, not a Crucible |
| Port | WS port | `tts-api.json` | `tts-api-server.ts:245` | **KEEP** | |
| Allow LAN Access (toggle → host 0.0.0.0/127.0.0.1) | who may connect | `tts-api.json` | `tts-api-server.ts:203,216,245` | **KEEP** | |
| Voice Engine (button per engine main reports) | which engine backs Listen / extension / LAN | `<userData>/tts-engine.json` → `engine` | `electron/streaming-engine.ts:179` | **KEEP-REWORD** | the streaming door already routes to a Crucible session (`electron/crucible/stream.ts`); the label must stop implying a local engine install |
| Batch size (audiobook processing), Orpheus only | concurrent sentences for a book render | `<userData>/orpheus-batch.json` | `electron/orpheus-batch.ts:47,87` → `parallel-tts-bridge.ts:4203,4624` | **DELETE-AFTER-PASS** | reader is the legacy WSL Orpheus spawn; on a Crucible the width is the server's (`HIGGS_MAX_NUM_SEQS`, a Crucible config fact — see the DIVISION OF KNOWLEDGE ruling) |
| Voice (select, per engine) | the streaming voice | `tts-engine.json` → `voices[engine]` | `streaming-engine.ts`, `orpheus-worker-pool.ts:743` | **KEEP-REWORD** | on a Crucible venue a Listen refuses `voice_not_resident`; the picker should offer the server's voices, not the disk's |
| **Generation Device** (Auto / CPU / GPU / MPS) | claims to choose where streaming generates | **NOT PERSISTED** | **NO READER** — `orpheus-worker-pool.ts:2114 setStreamWorkerConfig()` is an explicit no-op and `:2096` returns a hardcoded `devicePref:'auto'`; the Crucible backend's copy (`electron/crucible/stream.ts:938-944`) is also a no-op | **DELETE** | an inert control on the most consequential-looking choice on the page. It also contradicts GPU-IS-ONE-GLOBAL-CHOICE: the venue is the choice now |
| `<app-add-ons-panel [onlyGpu]>` (CUDA acceleration pack) | downloads `cuda-tts` | `installed.json` | streaming engine | **DELETE-AFTER-PASS** | a local CUDA pack for a local engine; Crucible's `tts` env replaces it |
| **Streaming Engine** — `<app-multi-worker-toggle>` (enable + 1–4 count) | claims to set worker count everywhere | **NOT PERSISTED** | **NO READER** — same no-op path; `getStreamWorkerConfig()` returns fixed `enabled:false,count:1,min:1,max:1` | **DELETE** | inert, and the hint text ("Becomes the default everywhere") is false |
| Save / Discard | restarts the server with port+host | `tts-api.json` | `tts-api:configure` | **KEEP** | |

### 3.8 `orpheus` — "Orpheus" (custom UI, `settings.component.ts:762-1088`)

**The whole page is DELETE-AFTER-PASS or MOVE→CRUCIBLE, and B1 decides which.** Every row
below either installs a local engine or configures the WSL spawn.

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Engine — `<app-add-ons-panel [only]="['orpheus']">` | installs/locates the Orpheus conda env | `<userData>/components/installed.json` | `electron/narrator-paths.ts:308` → the narrator spawn | **DELETE-AFTER-PASS** | the legacy spawn layer behind `legacyLocalRender`; on B1 it becomes `crucible install tts --narrator-engine orpheus`, which is Crucible's page, not this one |
| `orpheusModelsDir` (path) | folder of custom Orpheus voices | `tool-paths.json` | `electron/orpheus-models.ts:482`; WSL-translated at `narrator-spawn.ts:737`, `higgs-models.ts:1606` | **MOVE→CRUCIBLE** | voices become `~/.crucible/voices/<id>/<backend>/`, pulled by the server |
| `orpheusHfUser` ("HuggingFace account") | claims to make your tagged repos downloadable | `tool-paths.json` | **NO READER FOUND** — nothing in `electron/` reads it; the catalog is driven by `orpheusVoiceSources` instead (`orpheus-hf-catalog.ts:78`) | **DELETE** | writes a value nothing consumes |
| `huggingFaceToken` (password) | token for private voice repos | `tool-paths.json` | `electron/orpheus-hf-catalog.ts:255` | **MOVE→CRUCIBLE** | pulling weights is the server's act (PHASE13 §3.3 `pull`); the token belongs where the pull happens |
| `ttsNumberNormalizerModel` | the Ollama model that speaks printed numbers | `tool-paths.json` | `electron/tts-number-normalizer-runner.ts:51` | **KEEP-REWORD** | a real, live reader — but it names an OLLAMA model for a pass that is now a text act; it should name a Crucible model id like the other four acts in `crucible-models.json` |
| `<app-orpheus-voices-panel>` — engine install, base-model install, per-voice Download/Uninstall, add/remove `owner/name` sources | the Orpheus voice catalog | `tool-paths.json → orpheusVoiceSources[]` (`orpheus-hf-catalog.ts:78,98,104`); weights under `orpheusModelsDir` | `orpheus-hf-catalog.ts`, `orpheus-models.ts` | **MOVE→CRUCIBLE** | PHASE13 §4 section 4: the catalog with Pull / Installed / Resident is the SERVER's page |
| `useWsl2ForOrpheus` (Windows) | routes Orpheus through WSL | `tool-paths.json` | `tool-paths.ts:2025` → `main.ts:2916`, `narrator-paths.ts:262`, `narrator-spawn.ts:470`, `orpheus-worker-pool.ts:162,929,1927`, `parallel-tts-bridge.ts:182,1887,1965`, `component-manager.ts:1176,1195` | **DELETE-AFTER-PASS** | 11 readers, every one of them in the legacy spawn layer |
| `wslDistro` | which WSL distro | `tool-paths.json` | `tool-paths.ts:2108` → **including `electron/crucible/install.ts:340,402,412` and `crucible/servers.ts:480`** | **KEEP** | the ONE WSL key with a non-legacy reader: `local.ts` reads the local Crucible's `config.toml` through `wsl.exe -d <distro>`. It should MOVE to the Crucible section |
| `wslCondaPath` | conda inside the guest | `tool-paths.json` | `tool-paths.ts:2116` → `higgs-*`, `narrator-spawn.ts:632`, `qwen-aligner.ts:171`, `text-server.ts:778,809`, `vlm-page-server.ts:240` | **DELETE-AFTER-PASS** | every reader is a spawn the switch covers |
| `wslSessionsRoot` | guest-side session scratch | `tool-paths.json` | `tool-paths.ts:2165` → `main.ts:2919`, `parallel-tts-bridge.ts:806,1780,9963,9991` | **DELETE-AFTER-PASS** | same |
| `useWsl2ForVlm` | serve the page VLM from WSL | `tool-paths.json` | `tool-paths.ts:2067` → `vlm-page-server.ts:191` | **DELETE-AFTER-PASS** | `vlm-page-server.ts`'s spawn half is already labelled DATED |
| `wslVlmCondaEnv` | the conda env holding vLLM | `tool-paths.json` | `vlm-page-server.ts:194,241` | **DELETE-AFTER-PASS** | same |
| `wslVlmModel` (`rednote-hilab/dots.ocr`) | the HF repo the page server loads | `tool-paths.json` | `vlm-page-server.ts:198,307` | **MOVE→CRUCIBLE** | the dots.ocr pin is a Crucible manifest fact; §0b D3 already has a ruling open on which pin wins |
| Save WSL Settings / Verify WSL Setup (conda ✓ / sessions root ✓ / orpheus_tts env ✓) | a WSL doctor | — | `wsl:check-orpheus-setup` (`tool-paths.ts:912`) | **DELETE-AFTER-PASS** | `crucible doctor` is the doctor now, on Crucible's page |

### 3.9 `higgs` — "Higgs" (custom UI, `settings.component.ts:1089-1166`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| `useWsl2ForHiggs` | routes Higgs through WSL | `tool-paths.json` | `tool-paths.ts:2222` → `higgs-doctor.ts:522`, `higgs-spawn.ts:106`, `narrator-paths.ts:277`, `narrator-spawn.ts:470`, `streaming-engine.ts:544` | **DELETE-AFTER-PASS** | all five readers are the local Higgs spawn |
| `wslHiggsCondaEnv` (`higgs3`) | the vllm-omni env | `tool-paths.json` | `tool-paths.ts:2236` → `higgs-hf-install.ts:188`, `higgs-spawn.ts:376`, `main.ts:8602`, `narrator-spawn.ts:637`, `text-server.ts:809` | **DELETE-AFTER-PASS** | Crucible's `tts` env replaces it (`~/.crucible/envs/tts`) |
| `qwenAlignEnv` (`qwen-align`) | the forced-aligner env | `tool-paths.json` | `tool-paths.ts:2255` → `electron/qwen-aligner.ts:166` (sole reader) | **DELETE-AFTER-PASS** | Crucible's `align` job type replaces it; the door already exists (`electron/crucible/align.ts`) |
| `<app-higgs-voices-panel>` · Re-check (doctor: distro, env, vllm-omni, patch, launcher-sha, profile-sha, narrator-deps) | proves the local serving env | — | `electron/higgs-doctor.ts` | **MOVE→CRUCIBLE** | PHASE13 §4 section 3 + `crucible doctor`; the two site-packages patches are already Crucible's (`crucible doctor` reports both `applied`) |
| `<app-higgs-voices-panel>` · Install / Repair (WSL arm) | builds the WSL Higgs env | disk | `higgs:install-env` | **MOVE→CRUCIBLE** | `crucible install tts --narrator-engine higgs-v3` |
| `<app-higgs-voices-panel>` · per-voice "Download from HuggingFace" (~8.5 GB) | pulls a checkpoint from a private HF repo named in `electron/data/higgs-models.json` `source` | the arm's checkpoint dir | `electron/higgs-hf-install.ts`, IPC `higgs:install-checkpoint` (`main.ts:8688`) | **MOVE→CRUCIBLE** | a voice is a Crucible subject; PHASE13 §3.3 `{"type":"pull","kind":"voice"}` |
| voice metadata shown read-only (kind, engine version, sample rate, char cap, licence) | informs the picker | `electron/data/higgs-models.json` | `electron/higgs-models.ts` | **RULING** | the cap is per (directory, backend) and Crucible's manifests now carry `[voice.serving]`. Does BookForge keep `higgs-models.json` as the catalog of record, or read `/v1/voices`? Two owners today |
| *(absent, and correctly so)* sampling | — | `electron/data/higgs-models.json` `_samplingNote` | narrator | **KEEP** | the panel exposes NO temperature/top-p/top-k control — the one-engine-level-number ruling is honoured. Do not add one |

### 3.10 `enhancement` — "RVC Enhancement" (whole section = `<app-rvc-enhancement-panel>`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Engine: Download & Install / Uninstall / Cancel (`rvc-env`) | installs the RVC conda env | `installed.json` | `electron/rvc-bridge.ts:50` | **DELETE-AFTER-PASS** | Crucible's `rvc` job type and env replace it; the door exists (`electron/crucible/rvc.ts`) |
| per-voice Download & Install / Uninstall (7 `rvc-voice-*`) | RVC voice weights from `electron/data/rvc-voice-assets.json` | `installed.json` + disk | `electron/rvc-models.ts` | **MOVE→CRUCIBLE** | `kind: "rvc"` subjects in `/v1/catalog`; the PC already holds `sigma` and `deathstalker-rvc-v3` there |
| Add a source: Name + Archive URL + Add / ✕ | user-supplied RVC voice archives | `tool-paths.json → rvcVoiceSources[]` (`rvc-models.ts:142,149`) | `rvc-models.ts:123` | **RULING** | Crucible pulls from manifests it ships. How does a user's own archive become a Crucible subject — a manifest the app posts, or does this stay local? |
| *(absent from this panel)* index/protect/semitones/f0 | the conversion recipe | `pipelineDefaults.*` and the presets | `electron/rvc-job.ts` | **KEEP** | per-run recipe, not a server fact — and the two builtin presets carry auditions in their comments |

### 3.11 `speech-to-text` — "Speech to Text" (`settings.component.ts:1170-1189`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Engine — `<app-add-ons-panel [only]="['whisper']">` | installs the transcription conda env | `installed.json` | `electron/components/whisper-env.ts:98`, `electron/transcribe-bridge.ts` | **DELETE-AFTER-PASS** | Crucible's `asr` job type; `electron/crucible/asr.ts` is built |
| Models — `<app-whisper-models-panel>` Download / Delete (tiny, base, small, medium, large-v3, distil-large-v3) | faster-whisper weights | `<userData>/runtime/whisper-models/<id>/` | `electron/whisper-models.ts` | **MOVE→CRUCIBLE** | `faster-whisper-large-v3` is already pulled on the PC's Crucible |
| Ebook Alignment — `<app-add-ons-panel [only]="['whisperx-env','qwen-align-env']">` | installs the two aligners | `installed.json` | `whisperx-align-bridge.ts:128`, `qwen-aligner.ts:198` | **DELETE-AFTER-PASS** | Crucible's `align`; `qwen3-aligner` is already pulled there. NOTE: a Crucible-venue alignment cannot FINISH until narrator gains an items-in door (§0b B5) |
| *(absent, correctly)* an "align" checkbox | — | — | — | **KEEP** | the ALIGN CHECKBOX REMOVED ruling is honoured here |

### 3.12 `add-ons` — "General Add-ons" (`settings.component.ts:1190-1199`)

`generalAddOnIds()` = `['foundry-cli','calibre','tesseract','llama-cuda', …every component
whose kind is 'blocks-model']` (`settings.component.ts:2537-2548`).

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| `foundry-cli` Install / Update | the Foundry engine binary from its GitHub release | `installed.json` | `electron/foundry-bridge.ts:118,342` | **KEEP** | Foundry's engine rasterises and drives text acts against a Crucible endpoint; it is not itself a model |
| `calibre` Locate… / How to install | ebook-convert | `installed.json` | `electron/ebook-convert-bridge.ts:85` | **KEEP** | CPU tool, nothing to do with a card |
| `tesseract` Locate… / How to install | OCR | `installed.json` | detection | **KEEP** | same |
| `llama-cuda` Download & Install | the CUDA pack for the bundled llama.cpp | `installed.json` | `electron/llama-bridge.ts:175` | **DELETE-AFTER-PASS** | its only purpose is the local text engine the switch covers |
| the `blocks-model` filter | would list downloadable task models | — | **NO COMPONENT DECLARES THAT KIND** | **DELETE** | a filter over an empty set; the page-layout model is installable from nowhere |
| panel-level: Test environment / Refresh / "Remove N downloaded add-ons" | diagnostics and bulk uninstall | `installed.json` | `component-manager.ts` | **KEEP-REWORD** | survives for the three tools above; its system-info line (CUDA name, VRAM) should defer to `GET /v1/accelerator` |

### 3.13 `crucible` — "Crucible Servers" (whole section = `<app-crucible-servers-panel>`)

**This section is the survivor, and it grows.**

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| "This machine" card + Re-check | reads the local server's own `config.toml` (through `wsl.exe` on Windows); never copies the token | not persisted, by design (`electron/crucible/local.ts:104-118,241`) | the registry resolver | **KEEP** | ruling §2 no. 2: the local server has one owner, its own config file |
| per-row drag to rank | the list order IS the rank | `crucible-routing.json → order[]` | `generation-venue.ts:150`, `text-venue.ts:215`, `queue-engine.ts:1651-1664` | **KEEP** | PHASE7 §4.2 as written |
| per-row Enabled checkbox | takes a server out of rotation | `crucible-routing.json → disabled[]` | same | **KEEP** | |
| per-row Test (ping-then-info) | tells "nothing there" from "not a Crucible" from "wrong token" | — | `crucible:test-server` | **KEEP** | |
| per-row Refresh | test + activity + models | — | | **KEEP** | |
| per-row Remove (+confirm); `local` not removable | registry hygiene | `crucible-servers.json` | `electron/crucible/servers.ts` | **KEEP** | |
| per-model Load / Unload (two-step confirm) | operator verbs; each takes that machine's card | server-side | Crucible | **KEEP-REWORD** | after §2a.1 a manual Load is only meaningful under a lease; the row should say what releases it |
| "N queued books are waiting for X" + "Change them to Any" | surfaces orphaned rows | queue rows | `shared/queue/wait-for.ts` | **KEEP** | |
| "Forget it" (a ranked name nothing answers to) | registry repair | `crucible-routing.json` | | **KEEP** | |
| New jobs wait for: top-ranked / Any | the default a new queue row is written with | `crucible-routing.json → newJobsWaitFor` | `generation-venue.ts:150`, `text-venue.ts:215`, `queue-ipc.ts:95` | **KEEP** | |
| **legacy switch** — "Run renders and text passes with the local engines instead" | the ONE switch over the whole legacy spawn layer | `crucible-routing.json → legacyLocalRender` | `generation-venue.ts:141`, `text-venue.ts:207`, `streaming-engine.ts:344`, `queue-engine.ts:1651`, `queue-ipc.ts:85` | **DELETE-AFTER-PASS** | it is the dated stopgap by its own docblock; deleting it is what deletes ~250 GB of envs and every DELETE-AFTER-PASS row above |
| Add a Crucible server: Name / Address / Token / Test / Add | registry entry | `crucible-servers.json` | `electron/crucible/servers.ts` | **KEEP-REWORD** | PHASE13 §5.1: add a **"Paste from Crucible"** field taking one `crucible://name@host:port/#token` line through the SDK's `parsePairing` |
| "Get a Crucible" → `<app-crucible-doors>` door 1 (Connect elsewhere) | same three fields again | `crucible-servers.json` | same | **KEEP** | one component, two hosts — the right shape |
| door 2 (Use the one on this machine) | reports name/url/configPath; nothing to press | — | `crucible/local.ts` | **KEEP-REWORD** | PHASE13 §5.2: once `local` resolves, this becomes **Open Crucible** |
| door 3 (Install one here) — measured machine, ordered plan, copyable commands, elevation list, DISABLED "Install it for me" | the pre-server minute | — | `electron/crucible/install.ts` (`crucibleHostFacts`, `crucibleInstallPlan`, `DRIVEN_INSTALL_AVAILABLE=false`) | **DELETE** (most of it) | PHASE13 §0: "the printed step list and pull list are DELETED". Keep the host probe and the driven install; delete the printed pull list and `BOOKFORGE_JOB_TYPES` (`install.ts:147`) in favour of `shared/crucible/bookforge.module.json` (§5.4) |
| *(absent)* **Open Crucible** | — | — | **`crucible:open-ui` DOES NOT EXIST** — grep for `open-ui`/`Open Crucible` over `electron`, `src/app`, `shared` returns nothing | **RULING → BUILD** | PHASE13 §5.3 requires it; without it the whole "apps keep only Connect + Open Crucible" plan has no door |
| *(absent)* **"Set up for BookForge"** | — | — | `shared/crucible/bookforge.module.json` does not exist (`shared/crucible/` holds only `install-wire.ts`, `settings-wire.ts`) | **RULING → BUILD** | PHASE13 §5.4: the module file is the ONLY place BookForge states what it needs from a server |

### 3.14 `pipeline-defaults` — "Pipeline Defaults" (whole section = `<app-pipeline-defaults-panel>`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| AI cleanup / AI simplify / Translation — provider select ×3 (Ollama · Claude · OpenAI · Bundled local) | seeds the per-book flow | localStorage `pipelineDefaults.*Provider` | renderer only; the narration modal turns them into an IPC payload (`narration-modal.component.ts:926`) | **KEEP-REWORD** | **the enum omits `crucible`** even though `AIProvider` has it (`ai-config.types.ts:19`), so a default can never name a Crucible. That is the same one-fact-two-spellings defect §2.3 fixed for Settings → AI |
| model select ×3 | Ollama models live from `/api/tags`; Claude/OpenAI from the hardcoded lists | localStorage `pipelineDefaults.*Model` | renderer | **MOVE→FOUNDRY** (cloud) / **KEEP-REWORD** (Crucible) | the live-from-the-daemon pattern is right; the hardcoded cloud lists are not (§3.4) |
| Engine (button per `selectableEngines()`) | the engine a new narration run starts on | localStorage `pipelineDefaults.ttsEngine` | renderer → job payload | **KEEP-REWORD** | gated on a LOCAL component being installed; after the cutover it must be gated on the venue's `/v1/voices` |
| Processing device (Auto / CPU / GPU / MPS) | claims to choose the render device | localStorage `pipelineDefaults.ttsDevice` | renderer → job payload → the local spawn | **DELETE-AFTER-PASS** | a render's device is the SERVER's card; the venue is the only choice. GPU-IS-ONE-GLOBAL-CHOICE |
| Voice (select, engine-scoped) | default narration voice | localStorage `pipelineDefaults.ttsVoice` | `NarrationVoicesService` | **KEEP-REWORD** | should read the venue's voices |
| Voice enhancement (toggle) + Enhancement voice (select) | default RVC pass | localStorage | `electron/rvc-job.ts` via the job payload | **KEEP** | a per-book recipe |
| Speed (0.5–2.0) | narration speed | localStorage | job payload | **KEEP** | |
| Default format: Audiobook / Video | assembly output | localStorage `generateVideo` | assembly | **KEEP** | local, CPU |
| Save changes | commits the draft | localStorage | — | **KEEP** | |
| the two builtin presets (`builtin:leah-sigma`, `builtin:deathstalker-sigma`) | RVC recipes with auditions recorded in their comments | source (`settings.service.ts:191,243`) | `narration-modal` | **KEEP** | and note they correctly no longer set engine/voice/device/sampling |

### 3.15 `tools` — "Advanced" (custom UI, `settings.component.ts:618-761`)

| option | what it does today | value lives | who reads it | DISP | why |
|---|---|---|---|---|---|
| Conda (path; hidden on packaged builds) | conda override | `tool-paths.json → condaPath` | `tool-paths.ts:665` → `narrator-paths.ts:409,417`, `narrator-spawn.ts:714` | **DELETE-AFTER-PASS** | second control for the same key as §3.5; both readers are the local spawn |
| FFmpeg (path) | audio/video converter | `tool-paths.json → ffmpegPath` | `tool-paths.ts:692,740` → ~20 readers incl. `book-render-service.ts:552`, `metadata-tools.ts:504,777`, `enhance-bridge.ts`, `video-assembly-bridge.ts:681` | **KEEP** | assembly, muxing and duration probing stay local forever |
| Tools Python environment (path) | the env running assembly, resume, whisper, metadata tools | `tool-paths.json → toolsEnvPath` | `tool-paths.ts:428` → `narrator-paths.ts:192,221,226`, `vlm-convert.ts:167`, `component-catalog.ts:163` | **KEEP** | the CPU-side tools env is BookForge's own and is not a Crucible job type |
| Save / Discard / Refresh Detection | commits the tool-paths draft | `tool-paths.json` | `toolPaths:updateConfig` | **KEEP** | |

### 3.16 Keys with a reader but NO Settings control (hand-edit only)

| key | reader | DISP | why |
|---|---|---|---|
| `orpheusStreamingArtifact` (`adapter`\|`merged`) | `tool-paths.ts:2041` → `orpheus-models.ts:888` | **DELETE-AFTER-PASS** | a legacy-spawn detail with no door |
| `wslOrpheusCondaEnv` (default `orpheus_tts`) | `tool-paths.ts:2201` → `narrator-spawn.ts:637` | **DELETE-AFTER-PASS** | same |
| `useWsl2ForAllTts` | `tool-paths.ts:2021` — hard-wired `return false` | **DELETE** | dead |
| `wslE2aPath` | read only to produce a refusal (`tool-paths.ts:2192`) | **DELETE** | e2a is gone |
| `clipforgeRoot` | ClipForge UI | **KEEP** | training-data root, not a Settings row |
| `enhance.*` (launchMode, nativeEnvPath, scriptPath, params) | `tool-paths.ts:531` → `enhance-bridge.ts:557` | **RULING** | Resemble Enhance is a GPU act with no Crucible job type and no rollout-plan row. Does it become one, or stay a local env? |

## 4. Hosted Foundry's settings and wizard (read-only subtree)

Foundry's Settings page is reachable INSIDE BookForge: route `/settings` has no `canMatch`
guard (`foundry-app/src/app/app.routes.ts:38`) and neither does the gear that opens it
(`foundry-app/src/app/components/action-menu/action-menu.component.ts:294`). Its title is
**"Backend"**. Everything here is Foundry's to change; BookForge's job is to stop
duplicating it.

| section · option | what it does today | where its value lives | who reads it | DISPOSITION | why |
|---|---|---|---|---|---|
| Backend · Re-probe | runs `foundry doctor --json` against the URL on screen | nothing (read-only) | `foundry-app/electron/ipc.ts:3017` | KEEP | measurement, and it is Foundry's own engine |
| Backend · tier cards (Endpoint / vLLM in WSL / MLX / Native) | reports which inference tier was chosen | nothing | doctor | KEEP-REWORD | "vLLM in WSL" is the tier Crucible replaces; the label should say so once the hosted floor keys on a Crucible |
| settings.json · Mode (`auto`/`endpoint`/`mlx`) | which tier the engine may use | `%APPDATA%\foundry\settings.json` → `backend.mode` | `foundry-app/electron/settings.ts:105` | MOVE→FOUNDRY | Foundry's engine config; **no hosted guard** — it writes a machine-global file from inside BookForge (defect, §7) |
| settings.json · Endpoint URL | the OpenAI-compatible server the engine talks to | same → `backend.endpointUrl` | same | MOVE→FOUNDRY | hosted, BookForge sets this per run via `FOUNDRY_ENDPOINT_HEADERS` (`electron/crucible/text-acts.ts`); a second hand-typed endpoint is a competing owner |
| settings.json · Python | the interpreter with PyMuPDF for rasterising | same → `backend.python` | same | KEEP | rasterising is CPU and local by design; not a Crucible fact |
| Library location card | chooses Foundry's library folder | `userData/app-settings.json` → `libraryDir` | `foundry-app/electron/app-settings.ts:140` | KEEP | already hidden hosted (`settings-page.component.ts:143`) and refused in main (`ipc.ts:2781`) |
| Language model · Default model | seeds translate/simplify/analyse | `AppSettings.defaultLlmModel` | `foundry-app/electron/app-settings.ts:180` | MOVE→FOUNDRY | per-act model choice is Foundry's; BookForge's own duplicate is `crucible-models.json` (§3) |
| Language model · Clean text model | the model BookForge's Clean-text press uses too | `AppSettings.cleanTextModel` | `foundry-app/electron/app-settings.ts:194` | RULING | **two owners for one fact:** BookForge writes `cleanTextModel` into the same `app-settings.json` (memory ruling "CLEAN MODEL = qwen3.5:9b-bf16"), and BookForge also names a `clean` act model in `crucible-models.json`. Which one wins once the act runs on a Crucible? |
| Language model · `Ollama: <url>` | read-only display of the Ollama base URL | `AppSettings.ollamaUrl` | `foundry-app/electron/ipc.ts:3227` | MOVE→FOUNDRY | there is **no editor anywhere** — `setOllamaUrl` exists on the preload (`preload.ts:332`) and nothing in `src/` calls it, so moving Ollama means hand-editing JSON |
| Language model · "Run first-run setup again" | opens Foundry's 7-step wizard | — | `ui.service.ts:251` | DELETE | **no hosted guard**; inside BookForge it opens a wizard whose Library step calls an IPC that throws with no catch (`setup-wizard.component.ts:896`) |
| Servers card (standalone) · name/URL/token/enable/rank/Test/Remove/Save | Foundry's OWN Crucible registry | `AppSettings.crucibleServers[]` | `foundry-app/electron/crucible-registry.ts` | DELETE | ruling D-registry: **hosted Foundry reads BookForge's registry**. Already read-only hosted (`servers-card.component.ts:98`), backed by `refuseHostedRegistryChange` |
| Servers card · crucible-doors (Connect / Use this machine's / Install here) | Foundry's copy of the three doors | same | same | DELETE | one registry, one set of doors — BookForge's. Foundry's door 2 also owns its own `AppSettings.wslDistro`, a third spelling of a fact `tool-paths.json` already holds |
| Servers card · "New jobs wait for" (top/any) | Foundry's routing default | `AppSettings.newJobsWaitFor` | `crucible-registry.ts` | DELETE | BookForge already owns this (`crucible-routing.json`, `electron/crucible/routing.ts:86`) |
| Cloud providers · name / kind (openai, anthropic) / model (free text) / address / API key / Test | cloud slots for translate/simplify/clean/analyse | `AppSettings.cloudProviders[]` | `foundry-app/electron/cloud-providers.ts` | KEEP | **this is where Owen's §2a.2 ruling already lives, and it is built the right way** (a Test that lists the key's own models). Hosted it is read-only pending BookForge offering slots |
| Cloud providers · the standing sentence | "Text you translate, simplify, clean or analyse is sent to that provider." | `foundry-app/shared/slots.ts:338` | — | KEEP | declared shared so no surface can reword it |
| Environments card · per-env Destination + Install/Reinstall/Cancel | downloads prebuilt Pythons | shelf on disk | `foundry-app/electron/ipc.ts:3045` | RULING | Foundry's engine needs a Python for rasterising even with a Crucible. Does the hosted window keep an env installer, or does BookForge's "one copy per machine" rule extend to Foundry's shelf? |
| Page reader card · Download / Start / Stop / Check again | llama-server + dots.ocr GGUFs | Foundry's own store | `foundry-app/electron/ipc.ts:3084,3107` | MOVE→CRUCIBLE | the card already knows: it greys itself out with "The Crucible on this machine is reading pages" (`page-reader-card.component.ts:71`) |
| Page reader card · Keep warm for (minutes) | holds the local page server after the queue empties | `AppSettings.keepServerWarmMinutes` | `foundry-app/electron/ipc.ts:3113` | DELETE | contradicts §2a.1 (unload the moment nothing holds it). It is a timer; the ruling replaced timers with the four facts |
| Models on this machine · per-store sizes + "Remove Foundry's page reader" / "Remove Foundry's downloads" | inventory and reclaim | `AppSettings.pageReaderRemoved` | `foundry-app/electron/ipc.ts:3407` | KEEP-REWORD | this is the right screen for "one copy per model per machine"; it should name Crucible's store as the one that stays |
| Setup wizard (7 steps: welcome, library, ollama, crucible, envs, reading, done) | Foundry's own first run | writes as it goes; `setupCompleted`/`setupSkipped` at the end (`foundry-app/electron/setup.ts:44`) | — | DELETE (hosted only) | it refuses to AUTO-open hosted (`setup-wizard.component.ts:757`) but is mountable from the Language-model card. Standalone Foundry keeps it (Owen's 22:40 reframe) |

## 5. XTTS — every remnant, classified

Full sweep of `src/app`, `electron`, `shared`, `cli`, `tools` (excluding `foundry-app/` and
`node_modules`). The headline: **XTTS is already out of the root.** What survives is one
deliberate retired-id layer, ~100 comments, a keeper suite that pins the retirement, and
three genuine leftovers.

**The deliberate layer — KEEP, all of it.** `shared/tts/engine-caps.ts:91`
`RetiredTtsEngine = 'xtts' | 'f5' | 'voxtral'`, its table row at `:290-306`, the refusal
sentence at `:303`, `engineDisplayName` → `"XTTS (retired)"` at `:484`, the empty-voice-list
branch at `shared/tts/narration-voices.ts:123`, the loud migration of a `tts-engine.json`
that says `xtts` at `electron/streaming-engine.ts:233`, and the two live refusals at
`electron/parallel-tts-bridge.ts:2578` and `electron/reassembly-bridge.ts:528`. A record
written last year must still PARSE and DISPLAY; refusing to parse it would be the worse
failure. The keepers that pin this (`tools/test-higgs-engine.js`,
`test-retired-engine-settings.js`, `test-session-engine-provenance.js`,
`test-coverage-policy-mirror.js`, `test-narration-chain.js`, `test-no-e2a-doors.js`) all
KEEP.

**Not selectable anywhere.** One list: `shared/tts/engine-caps.ts:361`
`SELECTABLE_ORDER = ['orpheus','higgs']`. Both pickers read it through `selectableEngines`
(narration modal `:911`, pipeline-defaults panel `:197`), so no `@for` can emit an XTTS
card. `main.ts:7926` asserts again at job creation; `parallel-tts-bridge.ts:2573` asserts
again at spawn.

**CLAUDE.md is out of date on the assembly trick.** `--tts_engine xtts` is GONE from both
assembly doors: `parallel-tts-bridge.ts:6535` sends
`narratorEngineId(narratorEngineFor(settings))` and `reassembly-bridge.ts:1668` sends the
engine read from the session's own provenance. A keeper enforces it
(`tools/test-no-e2a-doors.js:104`). The CLAUDE.md paragraph and four in-tree comments
(`electron/sentence-gap.ts:74`, `reassembly-bridge.ts:1277,1588`, `engine-caps.ts:74-78` —
which names `asmEngineArg`, a variable that no longer exists) still assert the old
behaviour: **KEEP-REWORD** each, and CLAUDE.md with them.

**The three genuine leftovers — DELETE:**

| file:line | occurrence | class | disposition |
|---|---|---|---|
| `electron/manifest-migration.ts:480` and `:711` | `engine: 'xtts',` hardcoded into a NEW manifest when a legacy `abProject` is migrated | runtime branch | DELETE — it writes a retired engine into a fresh record regardless of what rendered the book, and `job-details.component.ts:463` then shows the user "XTTS (retired)" for a book that was never XTTS |
| `src/app/features/audiobook/components/play-view/play-view.component.ts:1157` | `selectedVoice = signal('ScarlettJohansson')` (and the preference at `:1768`) | runtime branch | DELETE — a stale XTTS voice id held until `loadVoices()` returns; `tools/test-no-e2a-doors.js:113` already names it as a real leftover |
| `src/app/features/audiobook/models/play.types.ts:69-75` | `AVAILABLE_VOICES` — the XTTS roster (Scarlett Johansson, David Attenborough, Morgan Freeman…) | dead branch | DELETE — one occurrence in all of `src`, its own declaration; nothing imports it |
| `src/app/core/models/manifest.types.ts:475`, `electron/manifest-types.ts:545`, `electron/web-fetch-bridge.ts:79` | `engine: 'xtts' \| 'orpheus'` | type-union member | DELETE (and replace with `TTSEngine` from `engine-caps.ts`) — **worse than the XTTS remnant: they make `higgs`, a currently selectable engine, untypeable in a manifest** |
| `src/app/features/settings/settings.component.ts:2485` | `// Deep-link: ?section=xtts …` | doc/comment naming a section that does not exist | KEEP-REWORD |
| `electron/components/catalog-types.ts:12,15,17` | `CatalogVoice` — `'xtts'`, `'xtts-v2/eng/ScarlettJohansson/'` | registry type for a catalog that is gone | RULING — the type is still imported by `electron/update/manifest-types.ts:26,147`; is the remote update catalog's voice shape still needed at all? |
| `electron/components/whisper-env.ts:8,19,72` | references `deepspeed-xtts.ts` as the pattern to imitate | doc/comment naming a deleted file | KEEP-REWORD |
| `electron/crucible/render.ts:199` | "the Orpheus and XTTS arms exist only in a locally spawned narrator" | UI string (live refusal) | KEEP-REWORD — XTTS has no arm anywhere; naming it in a 2026 refusal teaches the wrong thing |
| `electron/data/rvc-voice-assets.json:15` | `"matches": "the Owen Morgan fine-tuned XTTS voice"` | UI string in data | KEEP-REWORD |
| `packaging/.seed-cache/…/xtts-v2/eng/ScarlettJohansson/config.json` | an actual XTTS v2 checkpoint on disk | artifact | DELETE — `packaging/package-win.js:20` records that the seeding step left with XTTS, so nothing ships it; it is dead bytes |

**No bundled XTTS env or component exists** (`electron/components/` has no
`deepspeed-xtts.ts`; no component declares `id: 'xtts'`;
`component-manager.ts:1418` `DIAGNOSTIC_ENGINES = new Set(['orpheus'])`). So Owen's *"those
setup pages can be removed completely"* has already happened for XTTS specifically — the
setup pages that must now go are the ones for the engines that replaced it.

## 6. The wizard that results — four steps

The rule the shape follows: **a setup step exists only for something the app itself owns.**
Files, credentials, and which server. Everything about a model, a voice, an engine env or a
card belongs to Crucible's own page, reached with one button.

### Step 1 — Library
"Where BookForge keeps your books, projects and finished audiobooks." Default folder or
Browse; seeds the starter library into an empty one. Unchanged, and still the one step
nobody may skip. **Fix while here:** `back()` is disabled at `currentStep() <= 1`, so the
library step cannot be revisited — make it reachable like every other.

### Step 2 — AI and cloud keys
"Which model does the reading and writing, and whose credits pay for it." The Crucible card
(server + a model per text act) and the cloud keys, and nothing else: the bundled llama.cpp
downloads, the Ollama URL and the page-reading endpoint leave. The cloud rows are Foundry's
(§2a.2) — BookForge's part is to offer the door, not a second key store. Skippable: a
machine with no text model still narrates.

### Step 3 — Crucible
"Where the GPU work happens." **This step probes on entry** (§0b C2) and shows exactly one
of three faces:

- **`local` resolves** → *Connected*, its name/backend/card/job types, and one button,
  **Open Crucible** (`crucible:open-ui`, PHASE13 §5.3) plus **Set up for BookForge**, which
  POSTs `shared/crucible/bookforge.module.json` and shows the task's progress in the row
  (PHASE13 §5.4).
- **No local server and this machine can host one** → the install door: the measured
  machine, the two commands BookForge cannot run for anyone (`wsl --install -d Ubuntu`,
  `sudo loginctl enable-linger "$USER"`), and the driven **Install** button, gated on
  `DRIVEN_INSTALL_AVAILABLE`. The printed step list and the printed pull list are gone.
- **Not hostable** (no WSL2, no card, a Mac with no Crucible) → **Connect only**: one
  "Paste from Crucible" field taking a `crucible://name@host:port/#token` line, with
  Name / Address / Token still fillable by hand, Test then Add.

Skippable, and honestly so — a laptop that renders on the Mac is a laptop with one remote
server, and a laptop that renders nowhere yet is not broken. But the subtitle must stop
saying "BookForge keeps using this machine's own engines": after the legacy switch is
deleted, skipping means *no rendering yet*, and the step should say that.

### Step 4 — Review
What was chosen: the library path, the AI provider and per-act models, the server (or that
there is none) and what it can do. Plus the three small local tools if any were ticked
(Calibre, Tesseract, foundry-cli — the only downloads BookForge still owns). No progress
bars for gigabytes, because there are none left to download here.

**Deleted steps: Orpheus, Higgs, Voice enhancement, and the engine half of Optional tools.**
Four steps become zero, because each of them installed an env or a weight that Crucible
holds once per machine.

## 7. The Settings that result — eleven sections, in this order

| # | section | what it is now | change |
|---|---|---|---|
| 1 | **Library** | where your files live; remove-all-data | unchanged |
| 2 | **Crucible Servers** | this machine's server + the remotes, rank, enable, per-model Load/Unload, "New jobs wait for", the three doors, **Open** per row, **Set up for BookForge** | promoted from 13th to 2nd; grows the pairing-line field, the Open button and the module POST; loses the printed install document and, after the pass, the legacy switch |
| 3 | **AI** | provider (with `crucible`), server, a model per text act, cloud keys | loses the bundled-llama downloads, the Ollama URL and the page-reading endpoint; the cloud model lists stop being hardcoded |
| 4 | **Pipeline Defaults** | what a new book starts from: per-act model, engine, voice, speed, RVC recipe, output format | loses "Processing device"; gains `crucible` in the provider enum; engine/voice read the venue |
| 5 | **Audiobook** | export folder, narrator scratch folder | loses the duplicate `condaPath` |
| 6 | **Bookshelf Server** | port, start/stop, URLs | loses the unread `enabled` key |
| 7 | **TTS Server** | token, port, LAN, engine, voice | loses Generation Device, the worker toggle, the CUDA pack and the Orpheus batch size |
| 8 | **General Add-ons** | Calibre, Tesseract, foundry-cli | loses `llama-cuda` and the empty `blocks-model` filter |
| 9 | **Storage** | caches, "Move to archive", and (proposed) what models this machine holds | gains the one-copy-per-machine inventory, or a link to Crucible's page — RULING |
| 10 | **Advanced** | ffmpeg, tools Python env | loses conda |
| 11 | **General** | diff whitespace, Guided setup | loses `maxRecentFiles` |

**Deleted sections: Orpheus, Higgs, RVC Enhancement, Speech to Text.** Fifteen become
eleven. Note what that does to the per-engine reorganisation this repo did in August: the
reason a per-engine page existed was that an engine needed an env, a models dir, a doctor
and a voice catalog on one screen. Crucible owns all four, so the page has no content left.

## 8. The counts

164 rows audited.

| disposition | rows |
|---|---|
| **KEEP** | 52 |
| **KEEP-REWORD** | 30 |
| **MOVE→CRUCIBLE** | 12 |
| **MOVE→FOUNDRY** | 6 |
| **DELETE** | 29 |
| **DELETE-AFTER-PASS** | 24 |
| **RULING** | 11 |

By surface: first-run wizard 21, BookForge Settings 110, hosted Foundry 20, XTTS 13.

The 24 DELETE-AFTER-PASS rows all hang off ONE switch — `legacyLocalRender` in
`<userData>/crucible-routing.json`, read by `crucible/generation-venue.ts:141`,
`crucible/text-venue.ts:207`, `streaming-engine.ts:344`, `queue-engine.ts:1651` and
`queue-ipc.ts:85`. Deleting that switch is what makes them one commit rather than 24.

## 9. The RULING rows, verbatim

1. **§3.3 Storage — the model inventory.** *After the cutover, "Storage" is the honest home
   for the one-copy-per-model-per-machine inventory. Foundry already has that card
   (`machine-models-card`). Does BookForge grow one, or link to Crucible's page?*
2. **§3.9 Higgs — the voice catalog of record.** *The cap is per (directory, backend) and
   Crucible's manifests now carry `[voice.serving]`. Does BookForge keep
   `electron/data/higgs-models.json` as the catalog of record, or read `/v1/voices`? Two
   owners today.*
3. **§3.10 RVC — a user's own voice archive.** *Crucible pulls from manifests it ships. How
   does a user's own archive (`tool-paths.json → rvcVoiceSources`) become a Crucible
   subject — a manifest the app posts, or does this stay local?*
4. **§3.13 / §2.3 — Open Crucible does not exist.** *PHASE13 §5.3 requires `crucible:open-ui`
   and a per-row **Open** button; grep over `electron`, `src/app` and `shared` for
   `open-ui` / `Open Crucible` returns nothing. Without it the whole "apps keep only Connect
   + Open Crucible" plan has no door — build it, or name a different door.*
5. **§3.13 / §2.3 — the module file does not exist.** *PHASE13 §5.4 says
   `shared/crucible/bookforge.module.json` replaces `BOOKFORGE_JOB_TYPES`
   (`electron/crucible/install.ts:147`) and the printed pull list; `shared/crucible/` holds
   only `install-wire.ts` and `settings-wire.ts`. Build it, or keep the constant?*
6. **§2.3 — the Crucible step does not probe on entry.** *§0b C2 says the step should show
   one of three faces on arrival (connected / install / connect-only); today all three
   doors are always offered, closed. Build it?*
7. **§3.16 — Resemble Enhance.** *Enhance is a GPU act with a conda env
   (`resemble-env`, 3.47 GB on Windows) and NO Crucible job type and no row in the rollout
   plan. Does it become a job type, or stay a local env forever?*
8. **§4 — two owners for the clean-text model.** *BookForge writes `cleanTextModel` into
   Foundry's `app-settings.json` (the bf16 ruling) AND names a `clean` act model in
   `<userData>/crucible-models.json`. Which one wins once the act runs on a Crucible?*
9. **§4 — Foundry's Environments card, hosted.** *Foundry's engine needs a Python for
   rasterising even with a Crucible. Does the hosted window keep an env installer, or does
   "one copy per machine" extend to Foundry's shelf?*
10. **§5 — `CatalogVoice`.** *`electron/components/catalog-types.ts` still describes the
    remote XTTS voice catalog and is still imported by `electron/update/manifest-types.ts:26,147`.
    Is the remote update catalog's voice shape needed at all?*
11. **§0b B1, restated because every DELETE row above depends on it — Orpheus.** *Orpheus
    manifests + a `narrator_engine = "orpheus"` env in Crucible, or Orpheus retired in
    favour of Higgs? Deleting the legacy layer deletes Orpheus either way; this decides
    whether it comes back.*

## 10. What could not be verified

- **Nothing in this audit was run.** It is read from source on `feat/narrator-guarded-serve`
  at `4864afbb`, with two other agents editing the same checkout (queue-engine/scheduler and
  foundry-host/foundry-job files). Line numbers in those files may have moved.
- **The renderer's built output was not checked.** Per the "verify the settings row" rule, a
  row is proved by source + `settings.service` + the string in `dist/renderer`; this audit
  did the first two. No row here is being suggested to Owen as *already present in the app*
  — the point of the document is which rows should exist.
- **`shouldUseWsl2ForAllTts()` returning `false`** is read from source
  (`electron/tool-paths.ts:2021`); whether any build ever set it true was not traced.
- **The inert controls** (Generation Device, multi-worker) are proved by reading the only
  implementation of `setStreamWorkerConfig` (`electron/orpheus-worker-pool.ts:2114`) and the
  engine map (`streaming-engine.ts:152-155`). They were not observed failing in the app.
- **Foundry's hosted behaviour** is read from `foundry-app/`'s vendored source at the current
  re-vendor; it was not exercised inside the running window.
- **The size figures in §2.6** are the `sizeBytes` each component declares, not measured
  installs.
- **`~250 GB`** is the rollout plan's own figure (§Tier 3), not re-measured here.
- **Whether `packaging/.seed-cache/…/xtts-v2/…` is shipped** — `packaging/package-win.js`
  has no reference to it and records that the seeding step left with XTTS, so it appears to
  be dead bytes; the built installer was not inspected.

## 11. The ledger — what each disposition became, 2026-09-14

Thirteen commits: `3dd3920e` (the SDK pin) … `1aa54721` (the keepers). Owen's rulings since
the audit are folded in: **Orpheus is DEPRECATED** (its wizard step and Settings section go
NOW; its code path lives behind `legacyLocalRender` until the in-app pass), **XTTS is fully
removed**, **Higgs is the one narration engine**, **Crucible's `/v1/voices` and
`/v1/capability` are the catalogues of record**, the **six dead controls** go, **cloud keys
have one owner (Foundry's card)**, and **`<userData>/crucible-models.json` goes**.

### 11.1 The wizard (§2) — `3499bfaa`, and the Crucible step in `f1139476`

| audit row | disposition | what happened |
|---|---|---|
| §2.1 step 1 `library` | KEEP | kept. **And the `back()` bug is fixed**: the guard was `currentStep() <= 1`, which made the one step nobody may skip the one step nobody could revisit. It is `<= 0`. |
| §2.1 step 2 `ai` | KEEP-REWORD | now "AI and cloud keys". Carries ONE sentence about cloud keys living on Foundry's card, and nothing else. |
| §2.1 step 3 `crucible` | KEEP-REWORD | now "Where the GPU work happens", no longer "(optional)" in the title, and it mounts `<app-crucible-doors mode="probing">` — it PROBES ON ENTRY and shows one of three faces (§5.5 of the phase doc, which this work wrote). Its subtitle no longer says "BookForge keeps using this machine's own engines"; it says skipping means no rendering yet. |
| §2.1 steps 4/5/6 `orpheus` / `higgs` / `rvc` | DELETE | deleted, with their three panel components (nothing else in `src/` mounted them). |
| §2.1 step 7 `tools` | KEEP-REWORD | deleted AS A STEP; its three surviving components (Calibre, Tesseract, foundry-cli) moved onto Review, which is where the audit's §6 puts them. |
| §2.1 step 8 `download` | KEEP-REWORD | now `review`: the library path, whether AI is set up, the three local tools, and the download list only if something was ticked. |
| §2.2 the green "AI is already set up" note | KEEP-REWORD | kept as is. **NOT reworded** — see §11.8. |
| §2.3 doors 1/2/3 | KEEP-REWORD / DELETE | all three reworked; see §11.2. |
| §2.3 *(absent)* probe on entry | RULING → BUILD | **BUILT** (`f1139476`). The verdict is MAIN's (`hostabilityOf`) with THREE values, not two — see §11.2. |
| §2.3 *(absent)* post-install module POST | RULING → BUILD | **BUILT**: a completed driven install posts the module by itself. |
| §2.4 Select all / per-card add | KEEP-REWORD | kept; it now governs three components. |
| §2.4 the auto-preselect of CUDA packs | DELETE | deleted from `add-ons-panel.component.ts`. |
| §2.4 system info line | KEEP-REWORD | kept unchanged. **NOT reworded** — see §11.8. |
| §2.4 the component lifecycle buttons | KEEP / DELETE-AFTER-PASS | kept; the envs and packs are unreachable from the wizard now and reachable from Settings → General Add-ons until the layer goes. |
| §2.4 "Test environment" (orpheus) | DELETE-AFTER-PASS | left, with the layer. |
| §2.5 multi-worker toggle, both rows | DELETE | deleted, component file and all. |

### 11.2 The Crucible doors and the operator door (§2.3, §3.13) — `212e2ec2`, `f1139476`

| audit row | disposition | what happened |
|---|---|---|
| door 1, Connect | KEEP-REWORD | gains **"Paste from Crucible"**: one field, parsed in MAIN by the SDK's `parsePairing`. `invalid_pairing` is shown VERBATIM and nothing is filled. A paste reads itself. |
| door 2, this machine | KEEP-REWORD | once `local` resolves it is **Open Crucible** plus **Set up for BookForge**, with Test beside them. |
| door 3, install here | DELETE (most) | the printed pull list, the env installs and `capability --write` are DELETED from the sequence. What is left is the pre-server minute — a guest, a Python, the wheel, `crucible init` (with NO `--enable-*` flags), the service — ending in a step called **Open Crucible**. The host probe and the driven button stay; `DRIVEN_INSTALL_AVAILABLE` is UNCHANGED (`false`) because the release is not published. |
| *(absent)* **Open Crucible** | RULING → BUILD | **BUILT**: `crucible:open-ui`, `electron/crucible/operator-window.ts`. PHASE13 §5.3 exactly — no preload at all, `contextIsolation`, `sandbox`, `nodeIntegration: false`, its own `session.fromPartition('crucible-ui:<name>')`, `will-navigate` AND `will-redirect` denied off-origin, every `window.open` denied (http links handed to `shell.openExternal`), and both permission handlers refusing. The token is read in main from the registry or `local`'s config.toml. **Every server row in Settings → Crucible Servers has Open**, and the "This machine" card has "Open Crucible". |
| *(absent)* **"Set up for BookForge"** | RULING → BUILD | **BUILT**: `shared/crucible/bookforge.module.json` is a byte-for-byte copy of the crucible repo's generated file, pinned `-text` in `.gitattributes` and compared by `tools/test-crucible-module-file.js` (which SKIPS that one check by name when the crucible checkout is absent). `electron/crucible/module-setup.ts` posts it and streams the task; the row draws `step` / `progress` / `skipped` / `jobTypes` / `failed`. A `server_busy` held by a LEASE is drawn with the holder verbatim, never as a generic failure. |
| `BOOKFORGE_JOB_TYPES` + the pull list | — | **DELETED**, with `BOOKFORGE_NARRATOR_ENGINE` and the plan's `jobTypes` field. The driven install now derives its job types from the module file, and `test-crucible-install-seam` asserts the two agree. |
| every other §3.13 row | KEEP | unchanged: the local card, drag-to-rank, Enabled, Test, Refresh, Remove, per-model Load/Unload, the queued-rows count, "Forget it", "New jobs wait for", and the legacy switch (DELETE-AFTER-PASS, untouched). |

**The three-valued hostability, which the audit did not anticipate.** §6 says the third face
is for a machine that "cannot host". On Windows that question **cannot be asked** until
there is a WSL2 guest to ask it in, and `crucibleHostFacts` refuses to answer it from the
Windows-side `nvidia-smi` (a Windows driver that answers says nothing about whether the
passthrough works). So `plan.hostable` is `yes` / `no` / **`unknown`**, `unknown` draws the
INSTALL face — whose first step is the thing that settles it — and `hostableWhy` always says
which and why. Telling somebody with a 4090 "this machine cannot host one" because they have
not installed Ubuntu yet is a confident wrong answer, which R3 does not license just because
it is not a maybe. This is written into the phase doc as §5.5 (crucible `7d12072`).

### 11.3 Settings, the eleven sections (§3, §7) — `38e85249`

The eleven are in the audit's order, in `settings.service.ts`, with **Crucible Servers
second**. Deleted sections: **Orpheus, Higgs, RVC Enhancement, Speech to Text**, and the five
panel components they mounted (`orpheus-voices-panel`, `higgs-voices-panel`,
`rvc-enhancement-panel`, `whisper-models-panel`, `multi-worker-toggle`) — nothing else in
`src/` mounted any of them, so the files are deleted.

| audit row | disposition | what happened |
|---|---|---|
| §3.1 Library Location | KEEP | unchanged. |
| §3.1 `<app-remove-all-data />` | KEEP-REWORD | the Library page's copy is DELETED (one is enough, and Storage is where somebody reclaiming disk goes). The surviving one now says that a Crucible's `~/.crucible` store is shared with every app on the machine and is not BookForge's to delete. |
| §3.2 `maxRecentFiles` | DELETE | deleted. No reader repo-wide. |
| §3.2 `diffIgnoreWhitespace` | KEEP | unchanged. |
| §3.2 Guided setup | KEEP | unchanged; it opens the four-step wizard. |
| §3.3 Storage: cache, Move to archive | KEEP | unchanged. |
| §3.3 second `<app-remove-all-data />` | KEEP-REWORD | this is the copy that stayed. |
| §3.3 *(absent)* model inventory | RULING | **NOT BUILT** — Owen has not ruled; see §11.8. |
| §3.4 the whole AI section | see §11.5 | |
| §3.5 `externalAudiobooksDir` | KEEP | unchanged. |
| §3.5 `condaPath` (the duplicate) | DELETE-AFTER-PASS, and a duplicate | the AUDIOBOOK row is DELETED now (one fact, two doors). The Advanced one stays — see §11.8. |
| §3.5 `narratorScratchPath` | KEEP | unchanged. |
| §3.6 Port, Start/Stop, URLs | KEEP | unchanged. |
| §3.6 `bookshelfConfig.enabled` | DELETE | deleted, with both writes. Start and Stop are as live as they were; they just no longer write down a value nobody reads. |
| §3.7 Token / Port / LAN / Save | KEEP | unchanged. |
| §3.7 Voice Engine | KEEP-REWORD | reworded: it names an engine, not an install, and says that on a Crucible venue the streaming session is the server's. Orpheus is described as deprecated. |
| §3.7 Batch size (Orpheus) | DELETE-AFTER-PASS | the CONTROL is deleted now, with its reader in the component and `loadOrpheusBatch`. `<userData>/orpheus-batch.json` and `electron/orpheus-batch.ts` are untouched and die with the layer — on a Crucible the width is `HIGGS_MAX_NUM_SEQS`, the server's own config (DIVISION OF KNOWLEDGE). |
| §3.7 Voice | KEEP-REWORD | kept; the picker still reads `WorkerConfigService`. **Not yet venue-driven** — see §11.8. |
| §3.7 **Generation Device** | DELETE | deleted, with `setStreamDevice` and `gpuPackInstalled`. |
| §3.7 `<app-add-ons-panel [onlyGpu]>` | DELETE-AFTER-PASS | deleted from this page (it was offered under the device buttons); still reachable from General Add-ons until the layer goes. |
| §3.7 **Streaming Engine** multi-worker | DELETE | deleted. |
| §3.8 the whole Orpheus section | DELETE-AFTER-PASS / MOVE→CRUCIBLE | the SECTION is deleted. `orpheusHfUser` is deleted outright (no reader). `wslDistro` needed no move: its non-legacy reader is `crucible/local.ts`, which finds it in `tool-paths.json` exactly as before. Every other key is untouched and dies with the layer. |
| §3.9 the whole Higgs section | DELETE-AFTER-PASS / MOVE→CRUCIBLE | the SECTION is deleted; the keys stay for the layer. The `_samplingNote` row is honoured: no sampling control was added anywhere. |
| §3.10 RVC Enhancement | DELETE-AFTER-PASS / MOVE→CRUCIBLE | the SECTION is deleted. The user's-own-archive row is a RULING and is untouched — see §11.8. |
| §3.11 Speech to Text | DELETE-AFTER-PASS / MOVE→CRUCIBLE | the SECTION is deleted. |
| §3.12 `foundry-cli` / `calibre` / `tesseract` | KEEP | kept; they are the whole of General Add-ons now. |
| §3.12 `llama-cuda` | DELETE-AFTER-PASS | removed from `generalAddOnIds`, so the door is gone; the component stays for the layer. |
| §3.12 the `blocks-model` filter | DELETE | deleted. It was a filter over an empty set — no component declares that kind — so the list is a literal again. |
| §3.14 Pipeline Defaults | see §11.5 | |
| §3.15 Conda (Advanced) | DELETE-AFTER-PASS | **left, with a dated comment** — see §11.8. |
| §3.15 FFmpeg / Tools Python env / Save | KEEP | unchanged. |
| §3.16 `orpheusStreamingArtifact`, `wslOrpheusCondaEnv` | DELETE-AFTER-PASS | untouched; they die with the layer. |
| §3.16 `useWsl2ForAllTts` | DELETE | **deleted**, with `shouldUseWsl2ForAllTts()` (a hard-wired `return false` that two call sites branched on) and both call sites. |
| §3.16 `wslE2aPath` | DELETE | **deleted**, with `legacyGuestSessionsRoot()` and its caller `refuseLegacyGuestSessions()` — a UNC listing on the main thread, once per process, refusing an e2a upgrade path abandoned a year ago. |
| §3.16 `clipforgeRoot` | KEEP | unchanged. |
| §3.16 `enhance.*` | RULING | untouched, with the ruling named — see §11.8. |

### 11.4 Hosted Foundry (§4)

**Nothing in `foundry-app/` was touched; it is a vendored subtree and READ ONLY.** The rows
in §4 are Foundry's to change, and the one thing BookForge owed them — stop duplicating the
cloud card — is done in §11.5. The `cleanTextModel` two-owners ruling (§4, ruling 8) is
partly answered by §11.5: the per-ACT record is gone, so the only remaining clean-model
owners are Foundry's `cleanTextModel` (the legacy/Ollama venue) and the server's capability
record (the Crucible venue), which are two different venues rather than two opinions about
one.

### 11.5 AI, cloud keys and the per-act model (§3.4, §3.14) — `3764e575`, `c52db284`

| audit row | disposition | what happened |
|---|---|---|
| Bundled local AI downloads | MOVE→CRUCIBLE | **NOT DONE** — see §11.8. |
| "Use local AI for cleanup" | DELETE-AFTER-PASS | untouched. |
| Ollama URL + Test | MOVE→FOUNDRY | **NOT DONE** — see §11.8. |
| Crucible: Server select | KEEP | unchanged. |
| Crucible: Model select | KEEP-REWORD | unchanged. |
| Crucible: **a model per text act ×4** | KEEP (audit) → **MOVE→CRUCIBLE** (Owen's ruling) | `<userData>/crucible-models.json` and `electron/crucible/text-models.ts` are **DELETED**. `GET /v1/capability` owns the mapping: `crucible install` probes the card and picks the largest candidate that fits, so it is a per-HOST fact and an id chosen here was a second opinion about a decision that server had already made. `TextVenueHost.modelFor` became `capability(server)` plus a PURE `modelFromCapability`, with three named refusals — `crucible_capability_undecided`, `crucible_capability_disabled` (carrying the server's reason AND the shortfall in bytes) and `crucible_capability_no_model`. The Settings card draws the four acts as the server's ANSWER. |
| Crucible: Test / "Use this Crucible" | KEEP | unchanged. |
| Reading pages endpoint | MOVE→CRUCIBLE | **NOT DONE** — see §11.8. |
| Reading pages: "Pages would be read on X" | KEEP | unchanged. |
| **API keys: Claude / OpenAI** | MOVE→FOUNDRY | **DONE.** The card, `hasKey` / `saveKey` / `deleteKey` / `clearAllKeys` / `anyKeySaved` and the key store are deleted. In their place, one sentence naming Foundry's Backend → Cloud providers. `electron/cloud-credentials.ts` reads that record — the same shape `narration-clean-text.ts` uses for `cleanTextModel` — and refuses by name (`cloud_provider_not_configured`, `cloud_provider_incomplete`). The cleanup, analysis and translation cloud doors use it. |
| **`CLAUDE_MODELS` / `OPENAI_MODELS`** | DELETE | deleted. The comment above them already contained the argument, applied only to Ollama. |
| §3.14 provider select ×3 | KEEP-REWORD | **`crucible` added** to the enum — the one-fact-two-spellings defect the audit names. |
| §3.14 model select ×3 | MOVE→FOUNDRY / KEEP-REWORD | the cloud lists are gone; each non-Ollama provider's control now says where the choice lives ("Chosen on Foundry's cloud card", "Chosen by the server's capability record"). Drawn and disabled rather than hidden: a hidden control teaches nobody where to go. |
| §3.14 Engine / Voice | KEEP-REWORD | **NOT DONE** — see §11.8. |
| §3.14 Processing device | DELETE-AFTER-PASS | untouched. |
| §3.14 everything else | KEEP | unchanged, including both builtin presets. |

### 11.6 XTTS (§5) — `b326cab7`

| audit row | disposition | what happened |
|---|---|---|
| the deliberate retired-id layer, and its six keepers | KEEP | kept, all of it. |
| `manifest-migration.ts:480,711` `engine: 'xtts'` | DELETE | deleted. The legacy `abProject` record has NO engine field, so this stamped a retired engine into a fresh manifest regardless of what rendered the book. `TTSSettings.engine` is OPTIONAL now, and absent is the truthful value. |
| `play-view` `'ScarlettJohansson'` seed and preference | DELETE | both deleted; the seed is `''` and the preference is the engine's own default. |
| `play.types.ts` `AVAILABLE_VOICES` | DELETE | deleted (one occurrence in all of `src/`: its own declaration). |
| the three `engine: 'xtts' \| 'orpheus'` unions | DELETE | the two RECORD types take `TTSEngine` (wider on purpose — a record from last year must still parse and display); the web-fetch REQUEST takes `TtsEngineId`. `higgs` is typeable everywhere an engine is typed. |
| `settings.component.ts:2485` `?section=xtts` comment | KEEP-REWORD | reworded. |
| `catalog-types.ts` `CatalogVoice` | RULING | left, with the ruling written onto it — see §11.8. |
| `whisper-env.ts` deepspeed-xtts comments ×3 | KEEP-REWORD | reworded. |
| `crucible/render.ts:199` | KEEP-REWORD | reworded; the XTTS arm is not named, and Orpheus is described as deprecated. |
| `rvc-voice-assets.json:15` | KEEP-REWORD | reworded. |
| CLAUDE.md + four in-tree comments | KEEP-REWORD | all five reworded. **CLAUDE.md is gitignored in this repo**, so that edit is in the working tree and is not in any commit. |
| `packaging/.seed-cache/…/xtts-v2/…` | DELETE | **NOT DELETED** — see §11.8. |

### 11.7 The SDK pin, and the phase doc

- `3dd3920e` pins `@crucible/client` to `vendor/crucible-client-0.6.0.tgz`, a tarball packed
  from the crucible checkout at `feat/phase6-remote-render` `54fe7a0` — the same commit the
  release will be cut from. Labelled and dated in two places: `package.json`'s
  `"//crucible-client"` key and `docs/CRUCIBLE_ROLLOUT_PLAN.md` §3. A tarball FILE and never
  a `file:` DIRECTORY.
- crucible `7d12072` adds **§5.5** to `docs/PHASE13-OPERATOR.md`, in the crucible repo, in
  its own commit: the setup step probes and shows one face, the verdict is the app's main
  process's, and it has three values.
- The bump paid for itself immediately: SDK 0.6.0's `StreamSession` attaches its event
  stream and reads the server's `ready` frame BEFORE handing the session over, which
  DELETED a labelled stopgap in `electron/crucible/stream.ts` — a five-second poll around
  `stream_not_attached` on the first row of every session (`1aa54721`).

### 11.8 What was NOT done, and why

1. **§3.3 Storage — the model inventory (RULING 1).** Owen has not ruled whether BookForge
   grows a one-copy-per-machine card or links to Crucible's page. Untouched.
2. **§3.9 — the voice catalogue of record (RULING 2).** Owen ruled it: Crucible's
   `/v1/voices` is the catalogue. The Higgs SECTION is deleted, so nothing in Settings reads
   `electron/data/higgs-models.json` any more — but the FILE is not deleted, because it is
   still the local narrator's catalogue on the legacy path (`electron/higgs-models.ts`), and
   that path is what renders until the in-app pass. **What a non-legacy reader still needs
   from it: nothing.** It dies with `legacyLocalRender`.
3. **§3.10 — a user's own RVC archive (RULING 3).** Untouched, with the ruling named in the
   audit row. `tool-paths.json → rvcVoiceSources` and its reader are unchanged.
4. **§3.16 — Resemble Enhance (RULING 7).** Untouched, with the ruling named.
5. **§5 — `CatalogVoice` (RULING 10).** Left in place with the ruling written into its
   docblock: it is still imported by `electron/update/manifest-types.ts`, so deleting it is a
   decision about the remote update CATALOG, not about XTTS.
6. **§3.15 — Conda in Advanced.** §7's summary says "Advanced loses conda" and the row itself
   says DELETE-AFTER-PASS. The row wins, deliberately, and the reason is written at the
   control: now that the Audiobook duplicate is gone this is the LAST door to a key the
   legacy spawn still reads, and that spawn is what a bring-your-own setup renders with
   during the very pass that decides when the layer dies. Removing the door before the reader
   would strand exactly the machine the pass runs on.
7. **Three MOVE rows in §3.4 that are the LEGACY TEXT LAYER, not the cloud one**: the bundled
   local-AI downloads, the Ollama URL, and the page-reading endpoint. Each is a MOVE→CRUCIBLE
   or MOVE→FOUNDRY whose reader is the local text stack behind `legacyLocalRender`
   (`llama-bridge.ts`, `text-server.ts`, `vlm-page-server.ts`). Deleting the CONTROLS while
   the readers still run would leave a machine on the legacy path with no way to point them
   anywhere. They go in the commit that deletes the layer, which is the same commit the 24
   DELETE-AFTER-PASS rows go in.
8. **§3.7 / §3.14 — the voice and engine pickers reading the VENUE's `/v1/voices`.** Both are
   KEEP-REWORD rows asking the pickers to offer the server's voices rather than the disk's.
   Not done: `NarrationVoicesService` and `WorkerConfigService` read the local catalogue, and
   re-pointing them at a venue is the same one commit as item 7 — until the legacy path is
   gone, both answers are live and the picker must offer whichever the run will actually use.
9. **§2.2 / §2.4 — two KEEP-REWORD notes** ("AI is already set up", and the system-info line
   deferring to `GET /v1/accelerator`). Both are wording changes against facts that are still
   in flux (residency is momentary; the accelerator probe is not wired into that panel).
   Left as they were rather than reworded into a claim nothing supports yet.
10. **`packaging/.seed-cache/…/xtts-v2/…`** is DELETE in §5 and was not deleted: it is
    **untracked** (`.gitignore:79`), so there is nothing in the repo to remove. It is 1.8 GB
    of local disk on this machine only, referenced by no build step, and deleting somebody's
    local files is not a commit — Owen removes it when he wants the space.
11. **`shouldUseWsl2ForOrpheus()` and the remaining WSL keys** stay: every one is a
    DELETE-AFTER-PASS reader in the legacy spawn, and the audit's own §8 says the 24 of them
    are ONE commit rather than 24.

### 11.9 Two notes about the shared checkout

- `electron/crucible/text-models.ts` was deleted by a staged `git rm` of this work that a
  CONCURRENT commit (`bec1e66c`, another build's) swept up. The deletion was intended; the
  commit it landed in was not.
- `electron/queue-steps/pass.ts` is a file that build owns. Its two imports of the deleted
  module are repointed in `c52db284` rather than left red, and `leasedModel` for
  `narration-text` now answers `null` — which its own docblock already describes as a real
  answer — because the model is the server's, asked at run time, and that function is
  synchronous and runs before the step is placed. **OWED**, named in the comment: a `clean`
  row could keep its lease across a chain if `leasedModel` were allowed to be async and
  given the run's venue.
