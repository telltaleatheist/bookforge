# Onboarding, Out-of-Box, and Optional-Component UX — Planning Doc

Written Jun 13 2026. Captures a batch of UX/packaging items raised after the
barebones-seed + downloadable-voices work landed (app `105532c`, e2a `cf66c795`).
Goal: make BookForge genuinely usable out of the box for a non-technical user
(the wife test), with a coherent story for getting more voices, models, and
optional tools. **Execute from this doc after a context clear.**

Grounding facts verified this session:
- Packaged builds resolve the **bundled relocatable env** (`e2a-paths.ts`
  `resolveCondaEnv` → `kind:'relocatable'` when `getActiveBundledEnvPath()` is
  set, line ~217). Conda is only used in dev or for BYO Orpheus.
- Add-ons backend: `electron/components/` (`component-catalog.ts`,
  `component-manager.ts`). Voices are `tts-model` components fetched via the e2a
  `bookforge_ext/download_model.py` helper into the bundled HF cache.
- Voice catalog: `electron/xtts-voices.ts` (6 fine-tuned + `xtts-base` Default
  Voice Pack + Voice Library). UI: `src/app/features/settings/components/voices-panel.component.ts`.
- Browser extension lists voices from the TTS API server
  (`electron/tts-api-server.ts` → `xttsWorkerPool.getAvailableVoices()`), which
  returns the **whole catalog**, not just installed ones.
- AI cleanup: `electron/ai-bridge.ts`, providers `ollama | claude | openai`,
  default Ollama model is **cogito**. Ollama is assumed external (not bundled,
  not in the component catalog). Briefcase does the same — it does NOT bundle an
  LLM, so there's no prior-art shortcut there.
- Existing onboarding: `src/app/components/onboarding/onboarding.component.ts`
  (412 lines, 2 steps: **welcome → library**). Does NOT cover voices/add-ons/AI.

---

## Workstream 1 — First-run gating / "Setting up…" loading screen  *(task #13, do FIRST)*

**Why:** After launch there's a ~40 s window where `ensureBundledE2a` +
`ensureBundledEnv` are still unpacking; the UI looks ready but a job started in
that window catches a half-ready runtime / conda fallback. The user hit this.

**Current:** `main.ts` runs the bootstrap fire-and-forget (now in independent
try blocks). The bootstrap already takes `onProgress` callbacks and logs
`Installing bundled TTS models…`, `Fixing environment paths (conda-unpack)…`,
`Bundled Python env ready`.

**Approach:**
- Add a main→renderer readiness channel: emit `runtime:progress {message}` from
  the bootstrap's `onProgress`, and `runtime:ready` when both
  `ensureBundledE2a` + `ensureBundledEnv` resolve (or `runtime:error`).
- Track a `runtimeReady` signal in a core service; **gate job submission AND the
  TTS server start** behind it (disable "Add to Queue" / show a blocking
  "Setting up the audiobook engine…" overlay with the streamed progress text).
- Dev / already-ready (markers current) → resolve immediately, no overlay.
- Stretch: a Doctor/Health view (env ready? e2a ready? components? disk?).

**Files:** `electron/main.ts` (emit), `electron/preload.ts` (expose),
`src/app/core/services/` (readiness signal), the shell/root component (overlay),
`queue.service.ts` + TTS-server start (gate).

---

## Workstream 2 — Out-of-box AI cleanup: PORT Briefcase's bundled-llama.cpp + AI setup wizard

**Goal:** cleanup works on first launch with NO user setup (no Ollama, no API
key), AND a wizard lets the user download a better/bigger model with one click.

**Current:** `ai-bridge.ts` hits Ollama at `http://localhost:11434` (default
model cogito). If Ollama isn't running / model not pulled → cleanup fails.

**PROVEN PRIOR ART — copy it from Briefcase** (`/Volumes/Callisto/Projects/Briefcase`).
Briefcase already does exactly this; port the architecture, restyle to BookForge's
creamsicle theme. Key files to copy/adapt:

| Briefcase file | What it does | BookForge port |
|---|---|---|
| `backend/src/bridges/llama-bridge.ts` | Spawns a persistent **`llama-server`** (llama.cpp) binary on a port; generates via HTTP. `LlamaConfig{binaryPath, port}` | New `electron/llama-bridge.ts` — spawn bundled `llama-server`, manage lifecycle |
| `backend/src/bridges/llama-manager.ts` | Lists `.gguf` in modelsDir, picks/loads active model | model resolution in the bridge |
| `backend/src/config/model-manager.service.ts` | **Cogito catalog** + download (progress/cancel via AbortController) + **GPU/RAM-aware recommendation** | reuse the existing component-manager download machinery; port the catalog + the hardware-recommend logic |
| `frontend-v3/src/app/components/ai-setup-wizard/` | Step wizard: "AI is optional" → detect hardware + recommend → click-download with progress → done | new Angular wizard, creamsicle-styled |
| `frontend-v3/src/app/services/ai-setup.service.ts` (+ `ai-setup-helper.service.ts`) | status checks, platform install hints, recommended models | the wizard's service |
| `AI_SETUP_GUIDE.md`, `BINARY_PACKAGING_GUIDE.md` | the UX spec + how the binary is bundled (extraResources) | follow for packaging |

**The Cogito catalog (verified, bartowski GGUFs on HF, direct resolve URLs):**
- `cogito-3b` — 2.24 GB, minRAM 4 — "Lightweight and fast" ← out-of-box default
- `cogito-8b` — 4.92 GB, minRAM 6 — "Good balance"
- `cogito-14b` — 8.99 GB, minRAM 10 — "Higher quality"
- `cogito-32b` — 19.85 GB, minRAM 24 — "Best quality (Mac 32GB+ unified)"
URL pattern: `https://huggingface.co/bartowski/deepcogito_cogito-v1-preview-<llama-3B|llama-8B|qwen-14B|qwen-32B>-GGUF/resolve/main/<filename>.gguf`

**Runtime:** bundle the per-platform `llama-server` binary (llama.cpp) via
electron-builder `extraResources` + `asarUnpack` if spawned from the asar — SAME
hazards we just hit with `xtts_stream.py` (resolve to `app.asar.unpacked`, real
file on disk). `ai-bridge.ts` gets a 4th provider `local` that hits the local
llama-server (it speaks an OpenAI-compatible / `/completion` endpoint), so the
Ollama/Claude/OpenAI providers stay for power users.

**Out-of-box decision (recommended):** bundle the `llama-server` binary + the
**Cogito 3B (2.24 GB)** GGUF as the default → cleanup works offline on first run.
The wizard then offers 8B/14B/32B as one-click downloads (hardware-recommended)
into the same models dir. Seed grows ~4 GB → ~6.5 GB. Alt: bundle only the
binary, make even 3B a first-run download (lean seed, needs network once).

**This IS the setup wizard** the user asked for — it merges with Workstream 8:
the AI step of onboarding is this wizard ("AI cleanup is optional; bundled 3B
works now, or download a bigger one"). Frame AI as optional (cleanup can be
skipped, or use an API key).

**Files (BookForge):** `electron/llama-bridge.ts` (new), `electron/ai-bridge.ts`
(local provider), model catalog (reuse component-manager download), packaging
(bundle binary + 3B GGUF, extraResources/asarUnpack), new AI setup wizard
component + service, settings AI section.

**Open:** confirm Cogito redistribution license for bundling the 3B; pick where
GGUFs live (userData/models vs the e2a runtime models dir); decide bundle-3B vs
download-3B.

---

## Workstream 3 — Remove/relabel Conda from External Tools

**Finding:** the "Conda — required for TTS" entry (settings `tools` section,
`condaPath`) is **wrong for packaged builds** — they use the bundled relocatable
env and never need conda. Conda only matters in dev or for a BYO Orpheus env.

**Approach:** in packaged builds, hide the Conda tool row (or relabel to
"Optional — only for advanced/BYO setups" and drop "required for TTS"). Gate on
`app.isPackaged` / whether the bundled env is active. Keep it visible in dev.

**Files:** `src/app/features/settings/settings.component.ts` (tools section),
possibly a `runtime:usingBundledEnv` flag over IPC.

---

## Workstream 4 — Browser extension: show only available voices

**Finding:** `tts-api-server.ts` sends `xttsWorkerPool.getAvailableVoices()` =
the full catalog; the extension (`extension/src/offscreen.ts`, `messages.ts`)
lists them all, including voices whose models aren't downloaded.

**Approach:** filter server-side — `getAvailableVoices()` returns only voices
whose model is present (reuse the component manager's installed-glob, or check
the HF cache / ref-wav presence). The extension then naturally shows only usable
voices. Re-emit `config`/`status` when a voice is downloaded so the list updates
live.

**Files:** `electron/tts-api-server.ts`, `electron/xtts-worker-pool.ts`
(`getAvailableVoices`), maybe `componentManager` helper to list installed voices.

---

## Workstream 5 — User-added (custom) fine-tuned voice models

**Goal:** let users add their OWN fine-tuned XTTS checkpoints, with guidance on
where to put them and a Browse/Locate flow.

**Approach:**
- e2a already supports `--custom_model <name>` loading from a local folder
  (`xtts.py` lines 42–47: `custom_model_dir/<engine>/<name>/{config,model,vocab}`).
  Lean on that path rather than the HF-cache path.
- Add an "Add your own voice…" action in the Voices panel: a Locate… folder
  picker that validates the 3 files (config.json/model.pth/vocab.json) + a ref
  wav, records it (installed.json as a `source:'external'` voice), and surfaces
  it in the dropdown + extension.
- Show the canonical drop-in location + a short "where to download fine-tunes"
  note (e.g. the drewThomasson repo / HF) in the panel.

**Files:** `voices-panel.component.ts` (Locate flow), `component-manager.ts`
(record external voice + verify), `xtts-voices.ts` (surface external voices),
bridges that build `--fine_tuned`/`--custom_model` args.

**Open:** custom voices need a ref wav too — let the user pick it, or derive.

---

## Workstream 6 — Calibre / Orpheus install UX (and what "Install" means)

**Current behavior (verified):**
- **Calibre / Tesseract**: `external`-only components. If missing, the Add-ons
  card shows **Locate…** + a "How to install" link (`externalHelpUrl`). No
  managed download — the user installs it themselves, then BookForge auto-detects
  or they point at it. (Calibre is already optional; built-in basic EPUB
  conversion covers the core path.)
- **Orpheus**: `external + managed`, but the managed artifact is a **stub**
  (`url:''`) → the Install button surfaces "isn't available for download yet —
  install it yourself" + the help link. So today Orpheus is effectively
  Locate-your-own-conda-env.

**Answers to the user's questions:**
- *If they don't have Calibre, what happens?* The format picker already gates
  (per memory: pdf/epub/jwpub only when Calibre absent) and surfaces an "install
  Calibre via Add-ons" prompt. The Add-ons card gives Locate… + the download
  page link. **No automated installer** — user installs Calibre themselves.
- *Orpheus Install button?* Currently a stub → tells them to install it
  themselves. A real managed install needs a hosted ~6 GB conda-pack env per
  platform (deferred; non-trivial). Orpheus genuinely needs system-dependent
  setup, so "BYO + Locate" is the honest default for now.

**Approach / decisions:**
- Make the external-tool UX crisp: clear "Not installed → [Install Calibre…]
  (opens download page) / [Locate…]" with one-line why-you-might-want-it.
- Decide whether to invest in **managed Orpheus hosting** (one-click 6 GB env) or
  keep BYO. Recommendation: keep BYO short-term; revisit after Mac/Win ship.
- Tesseract language packs remain the first real managed-download candidate
  (see packaging memory) — small `.traineddata` files, easy to host.

---

## Workstream 7 — Merge External Tools and Add-ons?  *(UX decision)*

**Two surfaces today:** Settings → **External Tools** (path pickers: conda,
ffmpeg, calibre, tesseract paths via `tool-paths.json`) and Settings →
**Add-ons** (the component system: Calibre, Tesseract, Orpheus) + the new
**Voices** panel.

**Overlap:** Calibre and Tesseract appear in BOTH (a path field in Tools, a
component card in Add-ons). That's the confusing redundancy the user noticed.

**Recommendation:** **merge toward the component system.** Make Add-ons the
single home for optional capabilities (Calibre, Tesseract, Orpheus, Voices, and
the local-AI model from WS2). Retire the External Tools path-pickers for things
the component system already resolves (Calibre/Tesseract path = the component's
`resolveEntry`/Locate). Keep a small "Advanced" tools area only for genuine
overrides (ffmpeg path, conda for dev, scratch dir). Net: **one "Add-ons &
Models" hub** + a thin Advanced section. (Conda row from WS3 lives in Advanced,
dev-only.)

---

## Workstream 8 — Setup / help wizard for voices + add-ons

**Current:** `onboarding.component.ts` is welcome → library only. No mention of
voices, add-ons, or AI setup.

**Approach:** extend onboarding into a short first-run flow:
1. Welcome
2. Library folder (existing)
3. **"You're ready"** — explains the bundled default voice works now, and points
   to Settings → Voices to download more, Add-ons for Calibre/Orpheus, and AI
   setup (local model from WS2 / or add an API key).
- Plus contextual nudges (already partly present for Calibre): empty-state hints
  in the Voices/Add-ons panels ("Bundled: ScarlettJohansson. Download more →").
- Gate the wizard's "ready" step on Workstream 1's `runtime:ready` so onboarding
  and first-run-unpack compose (don't tell them it's ready mid-unpack).

**Files:** `onboarding.component.ts`, panel empty-states, hook to `runtimeReady`.

---

## Recommended sequencing

1. **WS1 first-run gating** — unblocks safe use; everything else assumes a ready
   runtime. (Already task #13.)
2. **WS4 extension available-voices** + **WS3 conda relabel** — small, high-value
   correctness fixes.
3. **WS6/WS7** — tighten Calibre/Orpheus UX and merge Tools→Add-ons into one hub.
4. **WS5 custom voices** — leans on existing `--custom_model`.
5. **WS8 onboarding** — ties the story together; depends on WS1 + the hub.
6. **WS2 bundled local LLM** — biggest/most uncertain; do last, after a
   bundle-vs-download decision and a node-llama-cpp packaging spike.

## Cross-cutting decisions to make up front
- **WS2:** runtime is settled — **port Briefcase's bundled `llama-server`
  (llama.cpp) + Cogito catalog + AI setup wizard**, restyled. Decision left:
  bundle the Cogito 3B GGUF (+2.24 GB, true out-of-box) vs download-3B-on-first-
  run (lean seed). And where GGUFs live (userData/models vs e2a runtime models).
- **WS2↔WS8:** the AI setup wizard IS the onboarding AI step — build once, reuse.
- **WS7:** commit to one "Add-ons & Models" hub and retire redundant Tools rows?
- **WS6:** invest in managed Orpheus hosting, or keep BYO?
