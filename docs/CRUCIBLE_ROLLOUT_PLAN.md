# Three apps, one server — the rollout plan

Written 2026-09-13 19:50, the night Owen asked for *"three fully functioning apps when I
get up"*. This is the list, the order, and the honest state. It is updated at each wake
(2 AM, 6 AM) and is the first thing to read in the morning.

## 0a. WHERE IT STANDS AT 06:00, 2026-09-14 — read this first

**Crucible 0.6.0 is prepared, pushed and RUNNING on both machines** (`22eccf0`). Both were
upgraded and restarted at 06:05 and both report nothing resident — the Mac dropped a model a
test had left loaded four hours earlier, which is Owen's unload ruling doing its job.

**What is proven on real hardware, four things:** the first Higgs render through Crucible
(the Mac, 8/8 keeper checks); Foundry's `clean-text` through the chat door (734 blocks,
78.5 s); a model lease held through a whole book with both a second lease and a competing
load refused by name (Foundry's drive, 29 blocks, 99 s); and BookForge's own render seam
reaching another machine (partial — it exposed two defects, both fixed).

**What is built and has never met a card:** every other door. Each has a keeper against a
fake server. Nothing in the app has rendered, cleaned, transcribed, aligned, converted,
denoised or read a page on a GPU.

**What needs Owen, in order:**

1. **Publish v0.6.0** — one line, and it is what makes the client library and the installer
   package installable and both apps' setup screens clickable:
   `cd /c/Users/tellt/Projects/crucible && ./scripts/release.sh --branch feat/phase6-remote-render`
2. **The in-app pass on a free card.** Settings → Crucible Servers, Test each, render a short
   chapter. The first render goes to `local`.
3. **Five rulings**, each blocking a build: narrator into its own repo (a friend cannot
   install the tts env without credentials to a private one); `higgs-default` on cuda-linux;
   zero-shot voices at the load door; the retake ladder's sampling channel; narrator's
   items-in door so a remote alignment can finish.

**Gates at 06:00:** Crucible 1054, client 184, bootstrap 117, narrator 1449, BookForge 142
keepers, tsc clean. Both branches pushed, trees clean, nothing merged.

## 0b. THE COMPLETE MAP OF WHAT IS NOT WORKED OUT — 2026-09-14, morning

Owen asked: *"is there anything else that we havent fully and completely worked out already?
does bookforge correctly add gpu slots for each crucible server its connected to? does it
remove its own local slots if theres a crucible server installed locally?"* Read from the
code, not from memory. Each item names the file that proves it.

**Owen, 2026-09-14 (after reading this map): *"well lets fix it. i did expect orpheus to be in
there. sounds like the job isn't done yet."*** Rulings taken from that, then CORRECTED an hour later — **Owen, 2026-09-14: *"xtts is
completely deprecated and removed as of when narrator was created. orpheus is deprecated too but
hasnt been removed yet. higgs is the frontier."*** So **B1 = Orpheus is DEPRECATED, not built into
Crucible**: it lives only on the legacy local path and is DELETED with that layer after the in-app
pass; the Orpheus wizard step and Settings section go now (audit `docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md`);
Crucible's stray `orpheus` entries (`ttsstream.py` batch width, jobenv's "two tts envs") are
removed so the server does not name an engine it will never serve. Higgs is the one narration engine; **D-registry = hosted Foundry reads BookForge's server
registry** (one owner; Foundry's own registry is standalone-only); A1, A3, A5 and the stale
hosted-env refusal are BUILT, not ruled. Agents: scheduler (BookForge), hosted-Foundry seam
(BookForge), Orpheus (Crucible, after the phase-13 server agent lands), then the page and the
apps' doors.

### A. The scheduler — the two questions, answered NO and NOT YET

- **A1. Per-server GPU slots — BUILT 2026-09-14 (`67139746`).** `RESOURCE_SLOTS` is gone;
  `shared/queue/slot-sets.ts` is the capacity model and the engine composes the set list from
  the routing record onto every snapshot. One `[gpu]` set per ENABLED server (`local`
  included), one for the legacy narrator spawn, and `local-work [cpu][cpu]` for what BookForge
  does itself. A GPU step counts against the venue it RESOLVED to, recorded on the step
  (`QueueStep.venue`); `any` takes the first server whose slot is FREE in rank order; a
  disabled server keeps its set, marked `retiring`, until its occupant lands (§4.3); and
  `thisMachinesCardHeldBy` states the thing the old global number prevented by accident — the
  legacy spawn and a local Crucible are two venues over one card. The bench draws a lane per
  machine and a row waiting for a card is told WHICH card. 26-check keeper
  `tools/test-queue-slot-sets.js`. Two rulings recorded in §3 (the server CPU number, and the
  legacy set's own slot).
- **A2. Local slots are not "removed" when a local Crucible exists — they are RENAMED.** Once
  `local` resolves, this machine's card IS the `local` server's GPU slot; there is no separate
  "BookForge's own GPU" slot to remove. What still exists beside it is the LEGACY SPAWN LAYER
  (WSL narrator, local text engines, local VLM/RVC/align spawns) behind the ONE switch
  `routing.legacyLocalRender`. That layer is deleted after Owen's in-app pass (~250 GB of envs
  with it). Until then both paths exist and the switch decides. **DELETE after the pass.**
- **A3. Only two step kinds travel.** `machines()` is declared by `tts-conversion.ts` (`any`)
  and `foundry-job.ts` (per config). Every other GPU step — `align.ts`, `rvc-enhancement.ts`,
  `final-denoise.ts`, `vlm-convert.ts`, `generate-sentences.ts` (asr), `translation.ts`,
  `ai-provider.ts`, `book-analysis.ts` — had a Crucible DOOR in `electron/crucible/` that the
  queue step had not been taught to use. **BUILT 2026-09-14 (`61238640`):** all eight declare
  `machines()` and take the run's venue through `runVenueOfRow` instead of deciding again.
  `rvc-enhancement` and `final-denoise` cross-check the row against the session's own record
  and refuse a disagreement by name; `vlm-convert`'s door had no venue-following path at all
  and now takes one; `generate-sentences` travels for `whisper` only; the two AI steps travel
  against `crucible` only, and each bridge gained a Crucible arm through one extracted
  `crucibleChatOnce`. `align` travels and then REFUSES BY NAME before submitting, because a
  remote alignment cannot finish until B5 — see §3. 12-check keeper
  `tools/test-queue-step-travel.js`. Still local: the PASS steps (§3).
- **A4. Double admission on the local card.** For work `onThisMachine`, the queue still asks
  the lock file (`external-gpu-job.lock`) and the GPU arbiter AFTER Crucible admission
  (`queue-engine.ts:1844`). With a local Crucible, the server's `409 server_busy` and its
  accelerator probe are the truth about the card; the lock file is how a TRAINING CHAIN
  (not a Crucible client) tells BookForge the card is taken. Ruling: does the fine-tune
  register with Crucible (a lease on the card with no model — a new lease kind), or does the
  lock file stay as the one non-Crucible holder? **RULING.**
- **A5. One lease per row — BUILT 2026-09-14 (`52ed21c8`).** The scheduler runs every step
  inside a ROW SCOPE named by the run's id (`AsyncLocalStorage`, injected so the engine keeps
  its no-Electron property), and inside a scope `withCrucibleLease` hands its lease to the
  scope instead of releasing it. `settleStep` gives it back the moment nothing follows, which
  `StepModule.leasesModel` is what answers — so the lease is never held across an assembly or
  an hour of narration. Heartbeat and release semantics unchanged. 12-check keeper
  `tools/test-crucible-row-lease.js`. The act name it could not settle is a ruling in §3:
  Crucible's vocabulary has no name for "a row of acts", so the lease is stamped with the act
  that opened it while every request still names itself truthfully in `X-Crucible-Act`.

### B. Engines — one is missing entirely

- **B1. Orpheus is not in Crucible — and will not be (ruled deprecated 2026-09-14, see above).** Kept for the record: Every voice manifest is `narrator_engine = "higgs-v3"`;
  `engines/narrator.py` knows Orpheus only as a comment. CLAUDE.md still calls Orpheus "the
  narration engine" and the wizard gives it a step of its own. So an Orpheus render or Listen
  can ONLY take the legacy WSL path, and deleting that layer (A2) deletes Orpheus. Ruling:
  Orpheus manifests + a `narrator_engine = "orpheus"` env in Crucible (vLLM 0.7.3, its own
  venv — the CLI already has one venv per narrator engine), or Orpheus retired in favour of
  Higgs. **RULING, then BUILD or DELETE.**
- **B2. `higgs-default` on cuda-linux** — the token voice exists as a manifest; whether the WSL
  server can serve it is the owed ruling from 06:00. **RULING.**
- **B3. Zero-shot voices** — Crucible's `zeroshot` takes clips in the request; the render door
  refuses it. Upload the clip, or local-only? **RULING.**
- **B4. The retake ladder's sampling channel** and the guard belonging to the model (the
  crucible-guard ruling, NOT STARTED). **RULING + BUILD.**
- **B5. Narrator's items-in door** — a remote ALIGN cannot finish without it. **BUILD (narrator).**
- **B6. Narrator into its own repo** — a friend cannot `crucible install tts` against a
  private BookForge sha. **RULING.**

### C. Install and stocking — phase 13, in flight

- **C1. Crucible's own page + operator API + generated module files** — being built now
  (`crucible/docs/PHASE13-OPERATOR.md`). Closes: no in-app model downloads, printed pull lists,
  two install stories, "how do I get the token".
- **C2. The wizard step probes on entry** (local found → connected + Open Crucible; none and
  hostable → Install; not hostable → Connect only) and **posts the module after a driven
  install.** §5.5 of the phase doc; BookForge's build after C1.
- **C3. The wizard's Orpheus / Higgs / RVC / Tools steps still install LOCAL engines** through
  the component manager. They become "which server" rows against the catalog once A2's layer
  is deleted — and B1 decides whether the Orpheus step survives at all.
- **C4. The driven install is gated on a published release** (`DRIVEN_INSTALL_AVAILABLE=false`).
  Order: phase 13 lands → Owen publishes 0.6.0 → BookForge pins the tarball → flip.
- **C5. Prebuilt env packs on the release** — speed only; after C1.

### D. Foundry seam

- **D1. Hosted Foundry's text acts — WORKED OUT, and what is left is a RE-VENDOR.** *(done
  2026-09-14; BookForge `e284c7bb`, `b2c50d78`, `70d3b896`.)* The refusal's premise had gone stale: foundry `f300fc6` gave
  the vendored `runEngine` an `extraEnv` argument and the 2026-09-14 re-vendor brought it in at
  `e6d5424`, while the guard went on quoting `env: process.env` for ten hours. Reading the
  subtree rather than the comment found the REAL gap, one layer along: the seam BookForge calls
  is `runJob(request, {parentStep, signal, onProgress})`, which carries no environment, and the
  only thing that fills `extraEnv` is the vendored DISPATCHER's own placement
  (`crucible-dispatch.ts`) — which hosted resolves credentials from a registry that is always
  empty. So the act cannot be composed here and could not be composed there. **Foundry fixed
  their half at `e096734`** (below); BookForge's half is built. What ships when `foundry-app/`
  is re-vendored at or past that commit: the refusal, the reach value and the venue resolution
  in `queue-steps/foundry-job.ts` all go, and the act's endpoint, model, header map, residency
  and **lease** become the dispatcher's — a BookForge lease on that path would be refused as a
  second lease (crucible allows one per server), which is the opposite of what the old note in
  that file said. The refusal is now keyed to the VENDORED SUBTREE and read by
  `tools/test-foundry-hosted-crucible-seam.js`, whose tripwire goes red ON the re-vendor with
  the instructions on it; `FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT` is deleted, because a version
  number standing in for a line of somebody else's code is how the stale guard survived.
- **D-registry. HOSTED FOUNDRY READS BOOKFORGE'S SERVER REGISTRY** (Owen's ruling, 2026-09-14 —
  one owner; Foundry's own registry is standalone-only). *Both halves built, neither wired:
  BookForge `b2c50d78`, foundry `e096734`.* Their `crucibleServers()` asks `FoundryHost.servers()`
  hosted and DERIVES the slot list from it, which closes a break nobody had pressed yet —
  `computeSlots()` took the host's `slots?()` list while `placeOnSlot` looked the credential up
  in a settings file that is empty hosted, so a row pinned to "mac" parked for ever on *"no
  longer registered"*. Ours: `electron/crucible/host-registry.ts`, offered at the mount in
  `main.ts`. Synchronous, because theirs is read while the queue page paints, so it answers from
  a SNAPSHOT taken at named moments (app start, every write to the registry or the rank record,
  and the Servers panel's read, which is where `local` is re-checked) — resolving `local` is a
  `wsl.exe` spawn and one per paint is a stuttering window. A call before the first reading is
  refused by name (`registry_snapshot_not_taken`) rather than answered with an empty list a
  window cannot tell from *"this machine has no servers"*. Priority order, disabled entries kept
  and marked, `local` present exactly when it resolves, a name that will not resolve omitted and
  RECORDED. We never offered `slots?()`, so there is nothing to delete on this side; their
  deletion of it lands with the re-vendor. **Owed: the re-vendor itself** (not built here), and
  the seam gap it exposes — see §3.
- **D2. Cloud slots** for translate/simplify on an underpowered machine — Foundry owns them
  (Owen's 01:40 ruling). BookForge's own AI providers already list models by key
  (`ai-bridge.ts:2148`, `2278`); the TILE rule (local floor OR an enabled cloud slot) is
  Foundry's. **Foundry, then re-vendor.**
- **D3. Lineup rulings:** `qwen3.8:27b-24g` is a local Modelfile not a published tag; the
  dots.ocr pin (Q8_0 vs F16) — one must move. **RULING.**
- **D4. `"foundry": "file:.."` devDependency** makes `npm ci` junction the subtree to the repo
  root. **RULING (Foundry drops it for the snapshot?).**

### E. Proven on a card: four things. Everything else: a keeper against a fake server.

Render (Mac), Foundry clean-text, a lease through a book, the render seam across machines.
Never met a card: cleanup, asr, align, rvc, denoise, pages, streaming, re-roll, every wizard
door. **Owen's in-app pass** is what turns the rest from "built" into "works".

### F. Small, known, owed

The `service install` over a loaded launchd agent (exit 5); a doctor verb comparing the running
version to the checkout (the stale-install 500s); the cold-VM `wsl.exe` exit −1 wanting a
reproduction; the ~34 remaining log-line contracts (R4); `orpheus-memory.ts` tier table; the
Mac's conda root not being one of the three ruled roots; `enableLinger` — what the app does
with it; `dots-ocr` `temperature = 0` server-side?; resume of a render across an app restart
(job id not persisted); re-pointing an assigned book is refused.

## 0. Where it actually stands tonight

**Crucible** (the server) is finished as a codebase: every job type exists, is tested, and
is on the wire as v0.5.0. But on the two machines that matter it is **deployed as an LLM
server only**:

| machine | version running | job types enabled | envs installed | models on disk |
|---|---|---|---|---|
| PC (WSL2, `crucible@owens-pc-wsl`) | 0.5.0, **not running** tonight | echo, llm | `llm` only | qwen3.5-9b, qwen3.8-27b-4bit |
| Mac (`crucible@owens-mac-studio`) | **0.4.0**, running since 16:38 from the `main` checkout, started by hand | echo, llm | `llm` only | qwen3.5-9b, qwen3.8-27b-4bit |

No `tts`, `asr`, `align` or `rvc` env has ever been installed anywhere. No voice, whisper,
aligner or RVC weights have been pulled. Neither server is a service; both were started
from a terminal.

**BookForge** (the app) has **no Crucible integration reachable from its UI.** Audited
tonight, every GPU feature the app exposes still spawns Python itself:

| feature | today | Crucible-side ready? |
|---|---|---|
| audiobook render (narration modal) | WSL narrator spawn in `parallel-tts-bridge.ts` | yes: `tts` job, guard verdicts on the wire, `render-artifacts.ts` downloader built and tested, **nothing calls it** |
| Play tab / extension / Reader streaming | local `stream-scheduler.ts` → narrator | yes: streaming session (`/v1/tts/stream`) |
| correct-sentences re-roll | local | yes: `tts` render job |
| AI cleanup / edit-list | Ollama / llama-server; a `crucible` provider exists in `ai-bridge.ts` but the renderer's enum lacks it, so **Settings cannot select it** | yes: chat door |
| simplify / translate / analysis (vendored Foundry) | Foundry → Ollama | yes: chat door with `X-Crucible-Act` |
| VLM page reading | WSL conda spawn | yes: `pages` |
| ASR "Generate sentences" | local whisper | yes: `asr` |
| forced alignment | local qwen3 aligner / whisperx | yes: `align` |
| RVC enhancement | local | yes: `rvc` |
| denoise | local audio-separator | **no**: `denoise` job type not built |

The registry (`<userData>/crucible-servers.json`) holds `mac` and `wsl`; the `wsl` entry
is a copy of the local server's own token, which is the duplication defect (section 2.1).

**Foundry** has its Crucible contract built (PHASE7-LANES.md section 8.0) and four items
of its own outstanding: Ollama retirement, the `capFor` 128-token floor, the `translate:`
log prefix on 43 lines, and the stamp decision.

## 1. What "fully functional" means, and what one night can deliver

Fully functional = *every GPU feature in every app goes through one Crucible per machine,
the old spawn layers are deleted, and Owen has run each feature in-app.* That is a
multi-day migration with an in-app pass between steps, and nothing tonight changes that.
The GPU is owned by fine-tuning all night, so **nothing that loads a model can be verified
before morning.**

What tonight delivers, in three tiers. Everything in tier 1 and 2 is committed on its
branch with tests; nothing is merged, because Owen tests in-app first.

### Tier 1 — Crucible becomes the full server on both machines (no GPU needed)
- [x] PC: enable `tts`, `asr`, `align`, `rvc` in config.toml (add the keys; never `init --force`) *19:45*
- [x] PC: `crucible install tts --narrator-engine higgs-v3`, `… orpheus`, `install asr`, `install align`, `install rvc` *done 20:17; asr's recipe had pinned numpy 2.5.3 (Python ≥3.12 only) — pinned 2.4.6, and all four chosen-set recipes were regenerated from the real installs' `pip freeze` (crucible `1ec936d`)*
- [x] PC: re-apply the two site-packages patches to the Higgs env; `crucible doctor` reports both `applied` *20:01*
- [x] PC: pull the weights BookForge uses (all pulled by 20:10): voices `deathstalker`, `mistborn`, `owen`, `sigma`, `thirdreich`, `zeroshot`, `higgs-default`; `faster-whisper-large-v3`; `qwen3-aligner`; rvc `sigma`, `deathstalker-rvc-v3`
- [x] PC: `crucible capability --write`; `crucible doctor` — every env ready, both patches applied, every type ready except `rvc` (base assets, see below) *20:25*
- [x] Mac: checkout `feat/phase6-remote-render` (v0.5.0), `pip install -e .`, same enables, installs and pulls *done 19:55; asr/align have no mlx-darwin recipe and `capability --write` recorded them off, correctly; doctor: `tts` NOT READY only because ffmpeg is off the non-login PATH, `rvc` NOT READY for the base assets*
- [x] Mac: restart the server *done 22:15 once Owen's stream ended and nothing was resident: checkout at the pushed branch, `pip install -e .`, `host = "0.0.0.0"` in its config, hand-started process stopped by Owen, `crucible service install` → launchd agent running v0.5.0, reachable from the PC; rvc base assets pulled; rvc env rebuilt with the separator pin; doctor: tts + rvc ready, `denoise` NOT READY until a pull verb exists — then `crucible denoise pull` landed (`83e3b86`) and both machines report `job denoise: ready`, installed `denoise-roformer` (0.91 GB, digests verified; one stamp per model; the puller and the job read one layout function). Crucible: 877 tests green.*
- [x] `crucible service install` — a systemd user unit in WSL, a launchd agent on the Mac (PHASE5-APPS.md section 6.0 ruled a local Crucible is a *service*). *Built (crucible `a838101`); installed on the PC 20:30 — the unit crash-looped because `python -m crucible` from systemd's $HOME cwd resolved `crucible.voices` to the checkout's `voices/` manifest directory; hand-fixed, then the generator fix landed (crucible `b40de27`: the unit runs the console script in `WorkingDirectory=<CRUCIBLE_HOME>`) and `service install` was re-run on the PC at 22:35. **The WSL server is up as a service now** (`{"crucible":true,"name":"crucible@owens-pc-wsl"}`), no model resident, no VRAM taken. Needs Owen: `sudo loginctl enable-linger telltale` so it survives the last shell. Mac: at the 2 AM wake.*
- [x] Owed to Foundry: per-model sampling and thinking defaults in manifests, applied server-side; then tell Foundry-pc-1. *Done 22:40 (crucible `835628e`, PHASE2-LLM.md §9): request states it → wins; else manifest; else engine; `X-Crucible-Sampling` header names the source per key; `qwen3.5-9b` ships `thinking = false`. Foundry told. Ruling owed: should `dots-ocr` state `temperature = 0` server-side?*
- [x] `denoise` job type (shares the RVC env; `audio-separator` pinned by name) *done (crucible `380e9d2`: roformer pass in the rvc env, `audio-separator==0.31.1` compatible-not-resolved until the first real install; `enable_denoise` flag; capability class). Also `5593320`: the urvc base assets are pulled from HF by pinned digest (`crucible rvc pull-base`) — the upstream is the installed fork's own `JackismyShephard/ultimate-rvc`, not the ancestral repos, and the embedder's `config.json` joined the list (without it transformers will not load the directory). Crucible: 859 tests green.*

### Tier 2 — BookForge gets its doors (built + tested, unverified on a card)
- [x] **2.1 Local discovery, registry holds remotes only** (the fix Owen said go on): `electron/crucible/local.ts` reads the local server's own `config.toml` (`$CRUCIBLE_HOME`, on Windows through `wsl.exe -d <distro> --exec`); the reserved server name `local` resolves to it; `addServer` refuses loopback URLs by name; the stale `wsl` entry is refused at use with the fix in the message. *Done 20:05 — 20-check keeper `tools/test-crucible-servers.js`; live: `--list` shows `local` read through WSL, `--server wsl` refused as stale, `--server mac` healthy; the stale `wsl` entry was removed from the real registry with the CLI's own repair door.*
- [x] **2.2 Servers settings row** (PHASE5-APPS §2, PHASE7-LANES §4.2.2): the local server first, then remotes; add/remove remote with **Test** (ping, then info); drag to rank; enable switch per server; **New jobs wait for: top-ranked / Any**. IPC + preload + renderer. *Done 20:55 (`f6ef8d76`, `ea39bc58`): **Settings → Crucible Servers**; routing record `<userData>/crucible-routing.json` (`electron/crucible/routing.ts`, 19-check keeper); live read-only probe of the Mac OK; Load/Unload buttons wired and never pressed. Open: the first `wsl.exe` read against a cold VM returned exit −1 and the second succeeded — the card has a Re-check button, and the root cause is owed a reproduction.*
- [x] **2.3 The `crucible` AI provider reachable from Settings**: renderer enum gains `crucible`, the AI setup picks a server (from 2.2's list) and a *resident* model; `checkProviderConnection` finally receives its server parameter. *Done 21:00 (`3a98ff70`): **Settings → AI → Crucible** card; a queue row cannot yet name a server (that is 2.5's `waitFor`), so that door refuses `crucible` by name.*
- [x] **2.4 Audiobook render through Crucible** *(built 21:25, `944d1f02`: `electron/crucible/render.ts`, one `tts` job per book with `take: 0`, voices checked against `/v1/voices` before the POST, 26-check keeper against a fake Crucible; three rulings owed in the file: zero-shot voices, whether a remote render holds this machine's GPU lease, resume across an app restart. Follow-up done 21:50, `dbc5633b`: `decideWhereGenerationRuns` in `electron/crucible/generation-venue.ts` — caller's name wins, else the legacy switch, else the top-ranked server (not pinged: a named machine is an instruction), else for `any` the first enabled server whose ping answers; refusals `no_enabled_server` / `no_reachable_server`, never a silent drop to local. The resolved venue is written onto the run's saved state so Continue goes back to the same machine. On this PC the default venue is `local`, the WSL service. The legacy switch is in Settings → Crucible Servers: "Render audiobooks with the local narrator instead (legacy — removed after the in-app pass)".)*: the narration modal's generation step submits a `tts` job (chunks up front, so there is a percentage), streams `chunk` events into the guard ledger, downloads artifacts into `sentencesDir` with the existing downloader, and assembly runs locally as it does today. The WSL narrator spawn stays **until Owen's in-app pass**, then is deleted in a commit he approves — a dated stopgap, not a fallback: the app takes the Crucible path whenever the selected server is reachable and refuses by name when it is not.
- [x] **2.5 Per-row `waitFor`** on queue items (PHASE7 §4.2.1) — the default written from the 2.2 setting; disabling a server surfaces the rows that name it. *Done 23:10 (`e91d2a41`): `shared/queue/wait-for.ts` holds the one pure decision and every hold sentence; `waitFor` on the run (one book = one GPU), `waitForResolved` written once at first admission; a row composed before this build carries NO instruction and holds until you pick (reported once at load — neither `local` nor `any` was manufactured); `409 server_busy` holds the row with the holder's name; queue page has the per-book picker; the Servers panel surfaces "N queued books are waiting for X, which is now disabled" with Change them to Any. 30-check keeper. Rulings owed: the GPU slot is still one global number (§2.4 per-server slots not built); only the render travels — RVC/align still run here; re-pointing an assigned book is refused.*

- [x] **2.6 Hosted Foundry's text acts through Crucible** (found 22:30 when Owen asked): translate / simplify / analysis in the hosted window and the narration clean-text pass still spawn the engine at BookForge's own text server. The engine gets `--endpoint <server>/v1/openai`, the header map (`FOUNDRY_ENDPOINT_HEADERS`) with the act named truthfully in `X-Crucible-Act`, and a per-act Crucible model id from Settings; residency checked by name before the spawn; text steps become travelling queue steps; the ONE legacy switch covers the local text engines too. *Built (`0088a296`, corrected `23700dc6`): `electron/crucible/text-acts.ts` (four acts, header map, base `<server>/openai`), `text-models.ts` (`<userData>/crucible-models.json`, one Crucible model id per act, picked in Settings → AI → Crucible), `text-venue.ts` (`decideWhereTextActRuns` + residency by name + `crucible_server_busy` → queue hold); BookForge's OWN driver path (narration clean-text, the CLI clean routes) runs a Crucible text act for real; the hosted job-queue path refuses `hosted_engine_takes_no_per_run_env` until Foundry's vendored `engine.ts` takes a per-run environment — Foundry's to build (they are building the reframe now). 31-check keeper. Ruling owed: what the hosted floor keys on once Foundry's next release exists.*

### Tier 3 — needs Owen, a free card, or days
- Owen's in-app pass on 2.2–2.4 with a free card; then delete the local narrator/llama/Ollama spawn layers.
- **After that pass — one copy per model per machine (Owen, 23:10).** Measured on the PC: Crucible holds the only copies that stay (`~/.crucible/{models 46G, voices 57G, envs 41G}`); to delete once the legacy paths are gone: WSL `~/higgs_v3_merged` (64G, the same merges Crucible mirrors), conda `higgs3`/`sglomni`/`orpheus_tts` (30G), the WSL HF cache (34G), the Ollama library (~120G: 9B ×3 quants, 27B ×2, cogito ×3, qwen3:32b), Foundry's own vLLM dots copy under `%LOCALAPPDATA%oundry` (its llama-server GGUFs stay for standalone). Formats cannot be shared across engines, so one copy = one engine per model per machine — the slot rule (a local Crucible replaces the local Ollama slot) is what makes it hold.
- [x] Streaming (Play tab, extension, Reader) through `stream-scheduler.ts` → Crucible streaming session — one seam, three consumers. *Built 00:45 (`f079b456`, `323803fb`): `electron/crucible/stream.ts` — a `StreamingEngine` whose worker is a Crucible session behind the same `getActiveEngine()` the scheduler drives; venue from `decideWhereGenerationRuns`; the idle sweep lifted into one `IdleWatch` owner; the streaming door carries NO guard verdict (Owen's ruling: streaming stays unguarded) so the ledger records `stream-unguarded`; 22-check keeper. Labelled stopgap: the SDK's session hides `ready`, so the first `say` waits out `stream_not_attached` — root fix owed in `sdk/ts/src/stream.ts`. Rulings owed: may a Listen make a voice resident (no BookForge door loads a VOICE yet); pack Listen rows to the venue's pace band; Orpheus Listen stays local until Orpheus manifests exist; where a Listen ledger persists. First Listen on this PC refuses `voice_not_resident` until a voice is loaded on the WSL Crucible.*
- [x] ASR and align → their Crucible job types *(01:00, `8c257cf1` the shared `runCrucibleJob` helper every later door uses, `838bf0f8` asr, `c1ba62ed` align, `48d10539` the rule that a run's later GPU steps follow the run's venue instead of deciding again — found live when an align step took the fine-tune's card). Align cannot FINISH remotely until narrator gains an items-in door (`narrator align --alignment <alignment.json>`): today a Crucible-venue alignment lands the model's items and then fails by name, and the legacy switch spawns the local narrator as before.*
- [x] Correct-sentences re-roll, RVC, denoise → their Crucible job types *(01:25: `9f24a629` the voice conversion, `ae22b855` the hiss pass, `6693c3ef` a sentence re-roll — each follows the book to the machine that rendered it, via `venueForRunStep`)*. VLM pages done *(01:55, `1e63e971`)*: the door that moved is the ENDPOINT, not a job submit — Crucible has no `pages` job type (PHASE3-VLM: pictures through the `llm` proxy; `pages` is a capability CLASS), and BookForge never holds a page image, so `vlm-convert.ts` now hands Foundry's engine a Crucible base + the header map with `X-Crucible-Act: pages`, and `vlm-page-server.ts`'s spawn half is labelled DATED. **Trap found:** Foundry's pages door does NOT normalise its endpoint while its text door does, so the bases differ by design — text `<server>/openai`, pages `<server>/openai/v1`; a keeper re-reads both rules from Foundry's source and they have been told. Refuses on this machine until a Foundry release carries the header support (the pinned 1.2.0 binary does not read it and reports the same version as one that does — the floor is conservative on purpose); the legacy switch keeps conversions working. Owed: `vlm:reader-status` still tells the renderer "this machine's GPU (WSL)" for a run about to go to a Crucible — a small `main.ts` + renderer follow-up. Deleting each spawn layer waits for Owen's in-app pass.
- [x] **The IPC collision** *(02:10, `bbac878a`)*: Foundry registered both `crucible:add` and `crucible:test`; two handlers of one name in one Electron process throw at startup, so the app would not have booted. Ours renamed — `crucible:add-server`, `crucible:test-server` — in `main.ts` and `preload.ts` only, since the renderer spells preload METHOD names and never a channel string (proved by grepping the built renderer). All sixteen of ours checked against their regenerated doc.
- The ~34 remaining log-line contracts (R4); next two: `isOomError` (`parallel-tts-bridge.ts:4773`) and the `.m4b` path extraction (`:6156`, `reassembly-bridge.ts:2100`).
- `orpheus-memory.ts` tier table deletion; narrator's verdict channel for the local driver.
- Crucible: `crucible service install` over an already-loaded launchd agent fails `launchctl bootstrap … exited 5` (already loaded) — install must bootout first (idempotency, PHASE11); found 23:50 on the Mac while re-recording the PATH.
- [x] Crucible SDK follow-ups *(01:40): `bcaa541` — `crucible.stream()` now RESOLVES ATTACHED (it reads the server's `ready` frame and checks voice/fingerprint/sample-rate/backend before returning), so BookForge's labelled ≤5 s `stream_not_attached` poll in `electron/crucible/stream.ts` can be deleted the day the client pin moves to a release carrying it; `f788faf` — `client.capability()` typed, with `capability_undecided` as a typed refusal; `3cd9d47` — `installed` on every capability row of `/v1/info` (align, asr, rvc, denoise, llm, tts) + the SDK type, and `describe_voices` stopped reading `residency._config` sideways. Crucible 1016 tests, SDK 182.*
- [x] `@crucible/bootstrap` (install Crucible from BookForge's setup wizard; client mints the token and passes `crucible init --token`). *Built 00:50 (crucible `3550763` `init --token`, `ab6d7bd` the package, `6b15c6d` release.sh fourth asset): `sdk/bootstrap/` — `detectHost / install / ensureRunning / readLocalConfig / health`, injectable runner, the WSL plumbing facts from Foundry carried with tests, 117 unit tests; live on this PC: WSL Ubuntu v2, the 3090 Ti, the conda interpreter, config read, service running with linger on. Rulings owed (PHASE12 §6): the Mac's conda root is `/opt/homebrew/Caskroom/miniconda/base` (not one of the three ruled roots — `condaRoots` override until ruled); may `install()` create the `crucible` env; prebuilt env archives need a catalog + downloader; what the app does with `enableLinger`. *Setup screens: BUILT in both apps (BookForge `eb7b4b73`, 02:30). BookForge's three doors live at
  **Settings → Crucible Servers → "Get a Crucible"** and as a first-run step, "Where the GPU work
  happens": connect to one elsewhere, use this machine's, or install one here — the third disabled
  with its reason stated, since no release carries the tarball. The install PLAN is drawn from facts
  BookForge can check itself (WSL2, the guest's card, an existing config) and lists the two commands
  the host must run. 41-check keeper. Also fixed there: the page-reader status cards said "this
  machine's GPU (WSL)" for a run about to go to a Crucible. Still owed: a Crucible release.*
- Foundry: its four items, Ollama retirement, and consuming `local`/registry the same way (Bun parses TOML natively).
- Foundry v1.3.0 (`83d7b66`) — tarballs built, `gh release create` needs Owen; the dev checkout's `dist/` already runs `83d7b66`, and until the release is cut the managed `foundry-cli` component stays on v1.2.0 (`eb69b7a`), whose engine still speaks `--server`. `foundry-cli-components.ts` pins nothing and takes the newest release, so cutting it is the whole fix.
- [x] Re-vendor `foundry-app/` *(02:10, `27da6a21`: Foundry `e6d5424`, 21 commits, 158/158 blobs hash-verified; app and engine shas agree for the first time)*. Three findings: **`--server` came back** as a wire dialect (`openai|ollama|anthropic`) after being retired as a server KIND, so a keeper guarding "nothing may write `--server`" was right to go red and now asserts the declared dialect instead; **`app/package.json` carries `"foundry": "file:.."`**, which made `npm ci` create a junction from the subtree to the BookForge repository root — a later recursive delete of `foundry-app/node_modules` would have deleted the repo (deleted non-recursively, repo verified intact, the step is now mandatory in VENDORED.md, and a ruling is owed on whether Foundry drops that devDependency for the snapshot); and the clean-text pin moved by exactly one docblock word (`both doors` → `every door`, the same nine characters), which is a port, not a rule move, so `NORMALIZER_VERSION` was right to stay.
- Merging `feat/narrator-guarded-serve` and `feat/phase6-remote-render` — after the pass.

## 2. Rulings taken tonight (defaults Owen can overturn in the morning)

1. **One Crucible per machine, and it is the shared pool.** Both apps are clients of the
   same server; job classes have independent envs under `~/.crucible/envs/`; weights live
   once under `~/.crucible/{models,voices,rvc}/<id>/<backend>/`. Two copies of the 9B only
   ever happen if two servers exist, so the rule is that none does. Existing weights on
   disk are **not adopted**: Ollama's GGUF blobs cannot be served by vLLM or MLX, and the
   PC and Mac need different formats of the same model anyway (AWQ safetensors vs
   `mlx-community` quantisations). BookForge's `runtime/higgs-models/` copies retire with
   the spawn layer that reads them.
2. **The local server has one owner: its own `config.toml`.** The registry holds remote
   servers only — the machines whose tokens Owen pasted, because no other source exists
   for them. This reconciles PHASE7 §7.1(A): the bootstrapper still mints the token, but
   it hands it to `crucible init --token` and keeps no copy.
3. **Listen never re-rolls.** The streaming verdict is recorded, not acted on; a listener
   cannot wait for a retake.
4. **Routing follows PHASE7 §4.2 as written** — per-row `waitFor`, rank by drag order,
   enable per server, "New jobs wait for" as the default's setting. (An earlier draft of
   tonight's questions said "one global choice"; the written contract wins.)
5. **Envs and weights are installed tonight; renders are not.** Installing is pip and
   disk. Rendering is the card, and the card is fine-tuning.
6. **The Mac restarts at 2 AM**, not during the stream.

## 2a. Rulings Owen made overnight (2026-09-14, 01:40)

1. **A model is unloaded the moment nothing holds it.** His words: *"Models should always be unloaded
   when we're done with them. Every time."* This OVERRULES PHASE5-APPS.md §7's proposed "no idle
   unload". "Done" is four facts, not a timer: no job on the lane, no lease open, no streaming
   session, no chat in flight. The lease built earlier tonight is what makes it safe — a client that
   intends a run of requests says so, and three books under one lease still load the model once.
   **Built 02:20 (crucible `5bf7d62`), and the measured consequence is worse than "reloads":** the chat
   door never loads, so a BookForge cleanup run finds the model gone the moment its previous
   completion returned and is answered `model_not_resident` until something submits a load. The lease
   is therefore what makes BookForge's Crucible provider FUNCTION, not merely what makes it fast.
   **BookForge leases as of 02:45** (`4267bf5e`, `1ac6fbd4`): `withCrucibleLease` takes one lease per
   RUN, heartbeats at a third of the ttl, and releases in a finally on success, throw, cancel and app
   quit; a 404 on release is a no-op and a 404 on a heartbeat re-leases (the server restarted and
   forgot). Leasing: the four text acts, the `crucible` AI provider, and page reading. NOT leasing, by
   name and pinned: every one-job door (render, asr, align, rvc, denoise, re-roll — they hold the lane,
   and `tts`/`align` would be refused by a lease they took themselves) and the streaming session (it
   holds the claim). A second agent is extending the server's lease to cover a voice and an aligner,
   because a book rendered or aligned chapter by chapter would otherwise pay a load per chapter.
   Owed: a queue row that cleans THEN simplifies takes two leases, so the model can go between them —
   one lease for the row needs a seam in `queue-engine.ts` and cannot carry one truthful act name.

2. **Cloud is how an underpowered machine lights translate and simplify.** His words: *"if a user
   can't run a 27b for translation, the only way the translate/simplify cards can light up is if we
   connect a cloud model."* So the local floor stays the 27B and is not lowered to the 9B; the tile's
   rule becomes *local floor OR an enabled cloud slot*. The key picks the models: the user enters an
   API key, the app calls the provider's own listing with it, and the dropdown is what came back —
   Briefcase's pattern (`backend/src/config/config.controller.ts`: OpenAI `/v1/models` with a bearer
   token filtered to chat models; Anthropic `/v1/models` with `x-api-key` + `anthropic-version`,
   labelled from `display_name`; no key is a stated empty list, not an error). Foundry owns the cloud
   slots and has been told. BookForge's own AI providers should take the same treatment.

## 3. Rulings owed (record here, do not guess)

- **SERVICE DEFECT (found 2026-09-14 16:10 restarting the local server onto the page build):** the
  unit says `Restart=on-failure`, so a clean SIGTERM (an operator's, or a future self-reload) leaves
  the server DOWN, and the user manager's `/run/user/1000/systemd/private` had vanished so
  `systemctl --user` could not reach it ("Failed to connect to bus") — recovered with
  `systemctl restart user@1000` as root, after which the enabled unit came up on its own. Owed in
  crucible `service.py`: `Restart=always` (+ `RestartSec`), and `crucible service status` should
  detect an unreachable user manager and name the root command. Bootstrap's `ensureRunning()`
  should do the same rather than report "running" from a stale pid.

- **WHICH DEATHSTALKER IS THE VOICE? (found 2026-09-14 by Training pc's hash).** Crucible's
  `voices/deathstalker` (pulled from HF `owenmorgan/deathstalker-higgs-v3` rev d732c38, 09-13) and
  the local higgs gate's `ds_v7_930_prod` (merged 09-11) have identical safetensors headers and
  DIFFERENT tensor data — two merges of one family, each the "voice" to a different server. R1: one
  owner. Ruling owed: which merge is canonical; then the HF mirror is re-uploaded from it (or not),
  the voice manifest's revision pin follows, and the other copy is deleted. Same question applies to
  mistborn/sigma/owen/thirdreich — nobody has hashed those.

- **STOPGAP, 2026-09-14 — `@crucible/client` is pinned to a LOCAL TARBALL, and the pin is
  replaced by the v0.6.0 release URL the day Owen publishes.** `package.json` says
  `"@crucible/client": "file:vendor/crucible-client-0.6.0.tgz"`, with the whole of this
  paragraph restated at the top-level `"//crucible-client"` key so nobody has to find this
  file to learn why. The reason is C4's order read backwards: PHASE13 §5 is built entirely on
  the operator door — `setup`, `catalog`, `submitTask`, `task`, `tasks`, `taskEvents`,
  `cancelTask`, `parsePairing` and the `CrucibleCardHeld` error — and the only PUBLISHED asset
  is v0.5.0, which has none of them. So the doors could not be built against the published
  release, and waiting for the publish would have parked the whole of this phase behind one
  line Owen has to type. The tarball is `npm pack` of the crucible checkout's `sdk/ts` at
  branch `feat/phase6-remote-render`, commit `54fe7a0` — **the same commit the release will be
  cut from, so the bytes match**; the replacement is a one-line edit to `package.json` and an
  `npm install`, and `vendor/crucible-client-0.6.0.tgz` is deleted in the same commit. It is a
  tarball FILE and never a `file:` DIRECTORY, because a directory dependency makes
  `node_modules/@crucible/client` a junction into the crucible checkout, and a later recursive
  delete of `node_modules` would follow it and take the SDK's source with it (memory:
  `git worktree remove` FOLLOWS the node_modules junction).

- **CPU SLOTS STAY LOCAL — Owen, 2026-09-14: *"cpu slots stay local though."*** Confirms the
  scheduler's ruling 1 as HIS: a Crucible server has 0 CPU slots; assembly, muxing and every
  `resource: 'cpu'` step run on this machine in the `local-work` set. Not a default any more.
- **A ROW LEASE IS PER MODEL (Foundry, 2026-09-14, caught before it shipped):** A5 kept the lease
  across steps whenever the next step declared `leasesModel`; clean (9B) → simplify (27B) would
  keep the 9B lease and refuse the 27B load `leased` by our own name. Fix: keep only when the next
  step's resolved model id equals the lease's subject; `leasesModel` is necessary, not sufficient.
  Hosted, the lease is Foundry's dispatcher's — `foundry-job.ts` carries a comment, not the flag.

- **CLOUD KEYS HAVE ONE OWNER: FOUNDRY'S CLOUD CARD, HOSTED TOO (default ruling 2026-09-14, Owen may
  overrule).** Foundry's registry seam (990bd2e) suppressed cloud providers hosted, which would leave a
  BookForge user on a laptop with NO way to light translate/simplify — against the 01:40 ruling. And
  BookForge's own AI page ships hardcoded three-item Claude/OpenAI lists (audit finding 3). So: hosted,
  Foundry's cloud-card is editable and its record in app-settings.json owns keys + models both ways;
  BookForge DELETES its own Claude/OpenAI key rows and model lists and its OCR-cleanup AI provider reads
  Foundry's record (as the clean door already reads `cleanTextModel`); `servers?()` stays Crucible-only.
  Foundry asked to un-suppress cloud hosted and keep the engine-config form + "run first-run setup
  again" GUARDED hosted. **Foundry landed all four at 33bb187** (cloud drawn hosted; card editable; engine
  settings form hidden + `settings:write` refused hosted — it had been writing the engine's machine-global
  settings.json; "run setup again" hidden + refused). **The single re-vendor targets foundry ≥ 33bb187.**
  Note: `cloudProviders` entries hold the KEY in app-settings.json (our userData hosted).

- **OWED AT THE RE-VENDOR (foundry 990bd2e, 2026-09-14):** `foundry-job.ts` passes the row's
  `waitForResolved` (a server name or `any`) as `RunOptions.waitFor` on `runJob` — the field
  did not exist in the vendored e6d5424, so it lands in the same commit as the subtree move;
  the hosted refusal `hosted_placement_not_vendored` is deleted there too (the keeper's
  tripwire says how). Foundry's registry seam now answers `host_provides_no_registry` (seam
  missing) vs `host_registry_unavailable` (our `registry_snapshot_not_taken`, quoted) — two
  facts, two codes. Ruled by both sides: hosted, Foundry's capability record owns the per-class
  model and `<userData>/crucible-models.json` GOES.

- Extract `narrator` into its own repo? (PLAN.md owed 1 — the pin is currently a git sha
  into the private BookForge repo; WSL and the Mac both authenticate to it today.)
- The take ladder's steps, and whether a resident model ever unloads itself.
- What a Listen verdict is *for*, beyond the record.
- Where urvc's base assets live for `rvc`.
- Publish the promoted fine-tune merges so the pace bands match the measured arms.
- From 2.4 (`electron/crucible/render.ts`): zero-shot voices — Crucible's `zeroshot` takes clips from the request and the render door refuses it; upload the clip, or local-only? Does a *remote* render hold this machine's GPU lease? Resume across an app restart (the job id is not persisted yet; Continue submits a new job for the missing chunks).
- From 2.3: a queue row cannot yet name a Crucible server (2.5's `waitFor`), so the queue's `crucible` provider door refuses by name until then.
- From the Crucible agent: should `crucible install <type>` end by offering the service (assumed no)? Fold `service status` into `doctor` (assumed no)? Should `dots-ocr` state `temperature = 0` server-side? Does audio-separator reach the network with both model files present (first real install settles it)? `torchcrepe` fetches its own weights, so `f0_method: "crepe"` may reach the network inside a job (every BookForge recipe uses `rmvpe`).
- **Model lease (Q3 from Foundry):** on a shared Crucible a chat holds no lane, so a `load-voice` from BookForge evicts Foundry's translator at block 400 of 2000. Proposed: an explicit lease on the resident model (`POST /v1/models/{id}/lease`, heartbeat for liveness, `DELETE` at run end); loads and unloads refuse `409 model_leased` naming client, act, since. Not a timer. *Owen said go at 23:45; built 01:05 (crucible `c5eb431` server, `aa2a24f` SDK): one lease per server; blocks load-model / unload-model / load-voice / tts / align at the job door (each evicts the resident model), never a chat; `/v1/activity.lease`; in-memory, restart forgets; 22 + 11 tests. Foundry builds the client side in its dispatch (lease → spawn → heartbeat at ttl/3 → release in settle). BookForge's text acts and renders should take leases too — owed.*
- **`[local]` block on model manifests** (Q2): *built (crucible `4e17842`): `[local]` validated like every other table; `scripts/gen-foundry-lineup.py` → `foundry-lineup.json` (schema 1, CI `--check`); Foundry told.* Rulings owed: `qwen3.8:27b-24g` is Owen's local Modelfile, not a published tag (`ollama pull` fails elsewhere) — name the published parent `qwen3.8:27b` or publish the Modelfile; Foundry's page reader pins `ggml-org/dots.ocr-GGUF` with the Q8_0 projector while the lineup names anthonym21's F16 — one must move.
- **Owen's tile rule (recorded 2026-09-13 22:40):** translate/simplify tiles do not light unless the machine can run at least the 9B; a job that would take a week on CPU is disabled, not allowed.
- **For your eyes (Foundry, overnight):** Foundry-pc-1 merged a third engine door, `--server anthropic` (Messages API, for analyze's verdict, with rate-limit backoff), at foundry `12b065d`. An older note in my memory says Claude-API simplify/translate was "not authorized" — if that still stands, it is theirs to hear from you; nothing in BookForge uses it.
- **From D1 (the hosted Foundry seam, 2026-09-14): the per-row venue does not cross `runJob`.**
  BookForge resolves which Crucible a row waits for (`waitForResolved`, 2.5) and hands the job
  to the hosted window — but the vendored side chooses the slot itself with
  `waitForOfNewJob()`, which reads FOUNDRY's `newJobsWaitFor` and its derived slot list, and
  `RunOptions` carries nothing to say otherwise. So after the re-vendor a hosted text act will
  land on a machine the row did not name, and "one book, one GPU" (PHASE7-LANES §4.4) would be
  two answers again. **Foundry's, and small: one field on `RunOptions` (or on the request) the
  placement prefers over its own default.** Nothing here should paper over it — a second
  scheduler deciding the machine is exactly what centralising the queue removed.
- **From D1: who leases a hosted act.** Settled by reading, and written into
  `queue-steps/foundry-job.ts`: the vendored dispatcher takes a model lease between making the
  model resident and spawning the engine, Crucible allows one lease per server, so BookForge
  must NOT lease around a hosted run. BookForge leases where BookForge spawns. Recorded here
  because the file used to say the opposite and somebody would have built it.
- **From D1: the two per-act model ids.** BookForge picks a Crucible model per act (Settings →
  AI → Crucible, `<userData>/crucible-models.json`); the vendored dispatcher picks the SERVER's
  own `selected` model for the capability class and says a configured id would be one that
  server may have refused. Both are defensible and they are two owners of one fact (R1). Owen's
  to rule once a hosted act actually runs: does BookForge's per-act choice travel, or is the
  server's capability record the only picker, in which case BookForge's own text acts should
  read it too?
- **From A1 (`shared/queue/slot-sets.ts`), the per-server slot sets:** PHASE7-LANES §2.4's
  table gives every server `[gpu][cpu][cpu]` and says in the same row that the CPU number is
  *"Zero today — no CPU work is sent to a server yet, and the slots exist so the bench and
  the model do not change when it is."* Built as `SERVER_CPU_SLOTS = 0`, because a lane the
  scheduler will never fill is a maybe (ARCHITECTURE.md R3) — no step module declares
  travelling CPU work, so every `cpu` step goes to `local-work`. **Ruling: confirm 0, or say
  the bench should draw two idle lanes per server against Crucible's ancillary lane landing.**
  One constant, one line, either way.
- **From A1, the LEGACY set and this machine's one card.** The legacy narrator spawn has a GPU
  slot of its own so the stopgap keeps its old behaviour, and it is present for as long as that
  spawn layer is (§0b A2 deletes both). §2.4 says *"there is no local gpu row"* — under it, the
  legacy spawn would occupy the LOCAL server's slot instead. It does not, because a GPU step
  whose module has not been taught to travel spawns here whatever the switch says and would
  otherwise have no set to charge. `thisMachinesCardHeldBy` is what stops the two sets starting
  two jobs on one 3090 Ti, which the old global `gpu: 1` prevented by accident. **Ruling owed
  only if the layer outlives the in-app pass**; if it is deleted as planned the question goes
  with it.
- **From A3 (`electron/queue-steps/align.ts`): align refuses BEFORE it submits, not after.**
  `electron/crucible/align.ts` was built to land `alignment.json` and then refuse
  `crucible_align_narrator_door_owed` — a loud dated partial, with the GPU work banked (R6).
  A row assigned to a server now refuses at the STEP, before anything is submitted, because
  loading a 3 GB aligner on somebody's card to produce an artifact nothing can read is a worse
  answer than the honest one. The after-the-fact message is unchanged and still what the
  in-flight path says. **Ruling: is the banked `alignment.json` worth the card once narrator's
  items-in door (B5) exists? If it is, the early refusal comes out in the same commit that
  lands that door.**
- **From A3: the PASS steps travel — DONE 2026-09-14 (`2f154f0b`).** `simplify`,
  `translate-pass` and `narration-text` declare `machines()` through the shared
  `machinesForAiStep`, follow the run's venue (`runVenueOfRow` → `providerConfigOf`, and
  `cleanTextEpub`'s existing `crucibleServer` door for the `clean` act), and declare
  `leasesModel` + `leasedModel`; `footnote-refs` stays `local`, being a string replace over a
  zip. The hand-built fourth copy of the provider mapping is DELETED — `providerConfigOf` is
  asked first, before the book is resolved and before a stage directory is made, so a
  `crucible_server_not_named` refusal costs no work. Two things the audit had not seen: a pass
  config nests its provider under `simplify`/`translate`, so `resource`, `machines` and
  `leasesModel` were all reading a top-level `aiProvider` that is never there (every pass filed
  on the GPU pool, including one against Claude); and `callAI` — the transport a translate
  pass actually reaches the model through — knew four providers and no Crucible, so the
  declaration alone would have failed the row an hour in. It takes the same `AIProviderConfig`
  now, through the shared `crucibleChatOnce`. 16-check keeper
  `tools/test-queue-pass-travel.js`.
- **From A3 / Foundry: `foundry-job.ts` does NOT declare `leasesModel`, and the absence is the
  statement (settled 2026-09-14, `2f154f0b`’s sibling).** The one-line addition was offered and
  declined: a hosted act's lease belongs to the vendored dispatcher, which takes one between
  making the model resident and spawning the engine and releases it in its own settle
  (`crucible-dispatch.ts placeOnCrucible`). Crucible allows ONE lease per server, so
  `leasesModel: true` here would describe a lease that does not exist AND would refuse theirs —
  in this app's own name. It does not become right at the re-vendor either; a row-keyed lease on
  that path would be Foundry's design to make, if Owen asks for one. The reasoning is written
  beside `machines()` in that file so the next reader does not re-derive it.
- **From A5 / Foundry: a row's lease is kept only for an act that wants the SAME model —
  BUILT 2026-09-14 (`ad86d91f`).** `leasesModel` alone was not enough: a lease is per MODEL
  (`POST /v1/models/{id}/lease`) and a server holds one, while clean runs on `qwen3.5-9b` and
  simplify/translate on `qwen3.8-27b-4bit`. So the archetypal clean→simplify row carried the
  9B's lease into the step that must load the 27B, and that load is refused `leased` naming
  `bookforge`. `StepModule.leasedModel` names the id, `CrucibleLeaseHost.leaseSubject` reports
  what is held, and the lease survives the seam only when they match. Scoped precisely, because
  half of it was already covered: `withRowLease` swaps on a model change, so BookForge's own
  chat acts never deadlocked — what the stale keep held was the GAP between steps, where
  `resolveCrucibleTextEngine`'s `loadFirst` door and an operator's CLI load both live. Also
  found: `settleStep` fires the release without awaiting it and pumps in the same tick, so a
  take could overtake it (`rowReleases` now waits). `tools/fake-crucible.js` enforces one lease
  per server, which is what makes any of this reproducible rather than assumed.
- **From A5 (`electron/crucible/lease.ts`): a row-wide lease carries the act that OPENED it,
  and Crucible has no name for "a row of acts".** `require_act_name` refuses anything outside
  its capability classes, and a lease carries one `act` with no route to re-state it. So a row
  that cleans and then simplifies holds one lease stamped `clean`. That is honest about what a
  lease answers (*why is this model being held*) and the other question — *what is running
  right now* — is answered per request by `X-Crucible-Act`, truthfully, and reported by
  `/v1/activity` as the in-flight entry's act. **Ruling: either Crucible gains a way to
  re-state a lease's act (an `act` on the heartbeat, or a PATCH), or a lease carries a LIST of
  acts, or this stays as the opening act's name.** The vocabulary is the server's, so it is not
  BookForge's to settle.
- Needs your hands, not a ruling: `sudo loginctl enable-linger telltale` in WSL (the service dies with your last shell otherwise); (Foundry v1.3.0 is VOID per Owen's 22:40 reframe — do not publish it); the first `wsl.exe` read against a cold VM returning −1 wants a reproduction.

## 4. State log

- **19:50** plan written; wake timers set for 02:03 and 06:03; questions with defaults sent
  to Owen before his stream.
- **19:45** Tier 1 installs started on both machines (nohup; logs `~/crucible-install-pc.log`
  in WSL, `~/crucible-install-mac.log` + `~/crucible-install-mac-tts.log` on the Mac). The
  Mac's first Higgs install failed on a zsh word-splitting quirk in my script (the argument
  arrived as one word); re-run under bash at 19:53.
- **20:05** 2.1 committed (`4787625a`). Three Opus agents running: 2.4 render seam, 2.2+2.3
  Servers row and provider, and the Crucible trio (service verb, manifest defaults, denoise).
  Foundry-pc-1 is taking its four engine items tonight and holds the registry work for
  Owen's word in its own session.
- **20:30** Foundry's engine phase landed (`646e8a1`, tag `engine-one-door`: one inference
  door, `--server`/`--ollama`/`--keep-model` retired, act-named log prefixes, `fitsWindow`).
  Fourth Opus agent started: re-vendor `foundry-app/` at 646e8a1 and retire the same flags
  on BookForge's side (`narration-clean-text.ts`, the clean CLI adapters, the `server`
  setting). Mac doctor found two real gaps — `ffmpeg` off the service PATH, RVC base
  assets with no source — both queued to the Crucible agent as root fixes.
- **21:30** 2.2, 2.3, 2.4 committed (`f6ef8d76`, `ea39bc58`, `3a98ff70`, `944d1f02`). Crucible:
  service verb landed (`a838101`), recipes resolved (`1ec936d`), branch pushed; the WSL
  server runs as a service with nothing resident. Foundry release prep done at `83d7b66`
  (publishing is Owen's). In flight: the render-routing follow-up, the re-vendor, and the
  Crucible agent's manifest defaults + denoise + rvc-base pull + service generator fix.
- **22:20** Re-vendor done: `foundry-app/` at Foundry `83d7b66` (`afe10842`, 145/145 blobs
  hash-verified), BookForge's own clean-text driver and CLI adapters stop speaking the
  retired dialect (`992a2fbf`: `--server`/`--ollama`/`--keep-model` gone from the spawn
  lines, refused by name in the CLI with the retiring commit; the `server` field of the
  clean-text settings is gone; the on-disk `llmServer` key is read as a selector and
  reported retired once). Found on the way: BookForge's mirror of Foundry's progress
  parser had already drifted — hosted Simplify progress stuck at block one — fixed,
  keeper 20/20. Two call-site pins moved for the Crucible seam (`8f3fd3d5`). Foundry's
  vendored `job-queue.ts` still spells `--keep-model` behind a flag nothing sets (dead,
  sealed subtree — reported to Foundry-pc-1). 2.5 (per-row `waitFor`) agent running.
- **23:40** 2.5 landed (`e91d2a41`); `foundry-app/` re-vendored at Foundry `81fdc30` after
  they removed the `--keep-model` residue (`a3ad3655`). Full keeper suite: 130 ran, 1 red —
  `test-bookshelf-stream-teardown`, a real race (the session said "released" before its
  snapshot directory was removed; lost under suite load, won alone). Fixed at the source
  (`cd6ab8b3`: the release is awaitable). Crucible: manifest defaults (`835628e`) and the
  service generator fix (`b40de27`) landed and are pushed; the WSL service was re-installed
  from the fixed generator and answers `/v1/ping`.
- **22:10** Owen finished streaming and gave me the card. The Mac is on v0.5.0 as a launchd
  service, reachable from the PC. **The first real Crucible `tts` render found the real
  gap**: narrator's vllm-omni arm needs `HIGGS_STACK`, `HIGGS_MAX_NUM_SEQS` and a launch
  script (`serve_higgs_v3.sh` + the certified frames-7500 deploy profile) that lived only in
  BookForge's `electron/scripts/higgs/`; Crucible set none of them. Fix in flight (Opus
  agent): the launcher becomes narrator's own package data, Crucible states the three
  variables (stack from the env spec, width from a `[serving]` table on each voice), the
  narrator pin moves, the tts envs are reinstalled, then the live keeper runs again. Also
  found: the regenerated rvc recipe had lost its PyTorch index line (`fa19e99`).
- **22:40** Owen reframed standalone Foundry: Crucible optional there (the speed tier and where
  WSL lives), Ollama through the one door as the beginner's default, the Ollama wizard stays,
  Foundry's own vLLM launcher is deleted for good; hosted Foundry inside BookForge stays
  Crucible-only. The 1.3.0 release prep is void. Foundry's three questions answered with
  evidence (dots.ocr runs under llama.cpp with a GGUF+mmproj pair, not under Ollama; one
  catalog of record = Crucible manifests with a `[local]` block; eviction mid-run = an
  explicit model lease, ruling owed).
- **22:57 THE FOUNDRY WIRE IS PROVEN LIVE.** `qwen3.5-9b` made resident on `local`; Foundry's
  `clean-text` ran against it — 734 blocks, 265 changed, 78.5 s, EPUB written. One Crucible
  fix on the way (`a97ef70`): the OpenAI door is also mounted at `/openai/v1/...`, where
  every OpenAI client composes it; the base is `<server>/openai`. 2.6 (`0088a296`) built the
  BookForge side with a version-floor refusal for that same gap — being corrected to the
  `/openai` base now; the one remaining hosted gap is Foundry's own: the vendored engine
  spawn takes no per-run environment, so the hosted job-queue path cannot carry a per-act
  header map until Foundry's `engine.ts` does. dots-ocr weights pulled on the PC (6.1 GB).
- **23:30** Owen handed the 3090 Ti to the fine-tuning agent (told "GPU free"; nothing of
  mine resident). **The live TTS keeper is deferred to the next free window** — the launcher
  fix lands without it and is verified only by narrator's and Crucible's own tests until
  then. Cleared on Owen's word: Ollama `cogito:8b/14b/32b`, the duplicate `qwen3.8:27b` tag
  (kept `27b-24g`), the 4-bit `qwen3.5:9b` (kept q8 and bf16); Foundry's ocr and footnote
  adapters and the orphan `foundry-4b-f16.gguf` base (~60 GB freed). Foundry landed its
  Package A (`374f18c`, engine `--server openai|ollama`) and B (`aa1c382`, local page reader
  = llama-server + dots GGUF); C (registry/slots/dispatch) in progress; one re-vendor after C.
- **23:45** Owen to bed: "power through until everything is done"; linger enabled; lease
  ruled go; the Mac's card offered for the TTS proof. Mac service re-recorded with
  Homebrew's PATH (ffmpeg refusal by name was the finding) and restarted; the live TTS
  keeper is running against the Mac in remote mode. Five Opus agents in flight: the
  narrator launcher (Crucible half), the model lease (server + SDK), the `[local]` block +
  `foundry-lineup.json` generator, `@crucible/bootstrap`, and BookForge streaming through a
  Crucible session. Foundry landed A and B; C and E in progress.
- **00:05** The launcher landed: narrator owns `serve_higgs_v3.sh` + the certified profile as
  package data (BookForge `0eeb0267`, narrator 1449 tests), Crucible states `HIGGS_STACK`
  (from the env spec), `HIGGS_ENV`, `HIGGS_MAX_NUM_SEQS` (from a `[voice.serving]` table)
  (`a7ab9af`, 894 tests); the tts envs were rebuilt on the new pin on both machines;
  both doctors healthy. Two more real defects behind it, agent assigned: Crucible's
  `load` sends `modelDir`, which narrator's served arm refuses by name, and narrator
  resolves the voice in a `NARRATOR_HIGGS_VOICES` document Crucible never wrote. Rulings
  owed: SGLang-Omni vs vllm-omni is named seven ways in this repo and the recipe installs
  vllm-omni; what Orpheus's narrator arm needs on cuda-linux (a whole `ORPHEUS_*` set).
- **00:20** Live keeper against the Mac (Owen offered its card): ping, voices, info, "nothing
  resident" all pass; the render fails at LOAD — narrator's MLX arm refuses the per-load
  `modelDir` exactly as the served arm does. Same defect, both arms; the load-contract agent
  has the live text. Two Mac service restarts tonight were for the same stale-process class:
  an editable install changed on disk under a running server (a doctor and a service verb
  that compare the running version to the checkout would name it — item for Tier 3).
- **01:20** The Higgs load contract landed (crucible `2d6b1f5`, 1009 tests): Crucible writes
  `~/.crucible/narrator-higgs-voices.json` from the voice manifest + pulled dir at every
  load and hands narrator `NARRATOR_HIGGS_VOICES`; the load message is the voice's name,
  no `modelDir`, on both arms; narrator unchanged. Both servers restarted on it (with the
  lease). Keeper rerunning on the Mac. Rulings owed: `higgs-default` (a token voice) on
  cuda-linux is refused until narrator can name the base dir for a `default` voice —
  Mac-only until then; zeroshot at the load door; take>0 needs a per-request sampling
  channel. Also landed: the lease (`c5eb431`/`aa2a24f`), `[local]` + lineup (`4e17842`,
  `9eb91bc`, `7e63905`), `@crucible/bootstrap` (`ab6d7bd` + `3550763` + `6b15c6d`);
  BookForge streaming via a Crucible session (`f079b456`, `323803fb`).
- **01:35 THE FIRST REAL HIGGS RENDER THROUGH CRUCIBLE PASSED — on the Mac, 8/8.** The live
  keeper in remote mode against `crucible@owens-mac-studio` (v0.5.0+ at `2d6b1f5`, narrator
  `0eeb0267`, deathstalker): voice loaded with `warming` lines, render ended `done`, a `chunk`
  event per row with its own seconds/chars/chars-per-sec (`capped` null, as PHASE3 says),
  both FLACs real and mono at 24 kHz naming the merge, a second render reused the resident
  voice without restarting narrator, `unload-voice` freed it. No memory measurement (remote
  mode cannot watch the card); the PC's measured peak still waits for a free 3090 Ti.
- **01:50 BookForge's own render seam reached the Mac too** (`bookforge-tts --tts --engine
  higgs --voice deathstalker --crucible-server mac`): the chunk rendered on the Mac's
  Crucible (its engine log shows the 00:49 start). Two defects behind it, both assigned:
  the new coverage-align step re-decided its venue (top-ranked = `local`) instead of
  following the run's, and loaded the qwen3-aligner on the fine-tune's card for ~1 min —
  unloaded, Finetuning-1 told; and a Crucible-bound run still preps its session inside
  WSL and then copies it to `Z:ookforge	mp`, a share WSL cannot mount (the known CLI
  defect) — a Crucible-venue run must live on a native path from the start.
- **02:00 Foundry drove the lease end to end on the Mac** (their hand-run of the app's
  dispatch against `2d6b1f5`): capability → load-model → lease (clean, ttl 120) → a second
  lease and a load-model both `409 model_leased` naming the holder → the built engine's
  `clean-text` through `<server>/openai` with the header map, 29 blocks in 99 s → heartbeat
  → release → a second release `404 unknown_lease (released)` → `activity.lease` null. The
  Mac's `qwen3.5-9b` is resident now (their run left it, by design). Foundry merged G (one
  queue lane per compute slot) at `f7ad5a9`; E still running.
