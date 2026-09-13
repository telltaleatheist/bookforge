# Three apps, one server — the rollout plan

Written 2026-09-13 19:50, the night Owen asked for *"three fully functioning apps when I
get up"*. This is the list, the order, and the honest state. It is updated at each wake
(2 AM, 6 AM) and is the first thing to read in the morning.

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
- [ ] PC: enable `tts`, `asr`, `align`, `rvc` in config.toml (add the keys; never `init --force`)
- [ ] PC: `crucible install tts --narrator-engine higgs-v3`, `… orpheus`, `install asr`, `install align`, `install rvc`
- [ ] PC: re-apply the two site-packages patches to the Higgs env; `crucible doctor` reports both `applied`
- [ ] PC: pull the weights BookForge uses: voices `deathstalker`, `mistborn`, `owen`, `sigma`, `thirdreich`, `zeroshot`, `higgs-default`; `faster-whisper-large-v3`; `qwen3-aligner`; rvc `sigma`, `deathstalker-rvc-v3`
- [ ] PC: `crucible capability --write`; `crucible doctor` healthy with every type ready
- [ ] Mac: checkout `feat/phase6-remote-render` (v0.5.0), `pip install -e .`, same enables, installs and pulls
- [ ] Mac: restart the server **at the 2 AM wake** (it drops whatever is resident; not during the stream)
- [ ] `crucible service install` — a systemd user unit in WSL, a launchd agent on the Mac (PHASE5-APPS.md section 6.0 ruled a local Crucible is a *service*). Both servers come up at login and survive the app.
- [ ] Owed to Foundry: per-model sampling and thinking defaults in manifests, applied server-side; then tell Foundry-pc-1.
- [ ] `denoise` job type (shares the RVC env; `audio-separator` pinned by name)

### Tier 2 — BookForge gets its doors (built + tested, unverified on a card)
- [x] **2.1 Local discovery, registry holds remotes only** (the fix Owen said go on): `electron/crucible/local.ts` reads the local server's own `config.toml` (`$CRUCIBLE_HOME`, on Windows through `wsl.exe -d <distro> --exec`); the reserved server name `local` resolves to it; `addServer` refuses loopback URLs by name; the stale `wsl` entry is refused at use with the fix in the message. *Done 20:05 — 20-check keeper `tools/test-crucible-servers.js`; live: `--list` shows `local` read through WSL, `--server wsl` refused as stale, `--server mac` healthy; the stale `wsl` entry was removed from the real registry with the CLI's own repair door.*
- [ ] **2.2 Servers settings row** (PHASE5-APPS §2, PHASE7-LANES §4.2.2): the local server first, then remotes; add/remove remote with **Test** (ping, then info); drag to rank; enable switch per server; **New jobs wait for: top-ranked / Any**. IPC + preload + renderer.
- [ ] **2.3 The `crucible` AI provider reachable from Settings**: renderer enum gains `crucible`, the AI setup picks a server (from 2.2's list) and a *resident* model; `checkProviderConnection` finally receives its server parameter.
- [ ] **2.4 Audiobook render through Crucible**: the narration modal's generation step submits a `tts` job (chunks up front, so there is a percentage), streams `chunk` events into the guard ledger, downloads artifacts into `sentencesDir` with the existing downloader, and assembly runs locally as it does today. The WSL narrator spawn stays **until Owen's in-app pass**, then is deleted in a commit he approves — a dated stopgap, not a fallback: the app takes the Crucible path whenever the selected server is reachable and refuses by name when it is not.
- [ ] **2.5 Per-row `waitFor`** on queue items (PHASE7 §4.2.1) — the default written from the 2.2 setting; disabling a server surfaces the rows that name it.

### Tier 3 — needs Owen, a free card, or days
- Owen's in-app pass on 2.2–2.4 with a free card; then delete the local narrator/llama/Ollama spawn layers.
- Streaming (Play tab, extension, Reader) through `stream-scheduler.ts` → Crucible streaming session — one seam, three consumers.
- Correct-sentences re-roll, ASR, align, RVC, VLM pages, denoise → their Crucible job types, each followed by deleting its spawn layer.
- The ~34 remaining log-line contracts (R4); next two: `isOomError` (`parallel-tts-bridge.ts:4773`) and the `.m4b` path extraction (`:6156`, `reassembly-bridge.ts:2100`).
- `orpheus-memory.ts` tier table deletion; narrator's verdict channel for the local driver.
- `@crucible/bootstrap` (install Crucible from BookForge's setup wizard; client mints the token and passes `crucible init --token`).
- Foundry: its four items, Ollama retirement, and consuming `local`/registry the same way (Bun parses TOML natively).
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

## 3. Rulings owed (record here, do not guess)

- Extract `narrator` into its own repo? (PLAN.md owed 1 — the pin is currently a git sha
  into the private BookForge repo; WSL and the Mac both authenticate to it today.)
- The take ladder's steps, and whether a resident model ever unloads itself.
- What a Listen verdict is *for*, beyond the record.
- Where urvc's base assets live for `rvc`.
- Publish the promoted fine-tune merges so the pace bands match the measured arms.

## 4. State log

- **19:50** plan written; wake timers set for 02:03 and 06:03; questions with defaults sent
  to Owen before his stream.
