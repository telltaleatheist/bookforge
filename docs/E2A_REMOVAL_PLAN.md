# E2A_REMOVAL_PLAN - narrator replaces ebook2audiobook

Owen, 2026-09-05: "pull the trigger. remove e2a completely. don't delete the repo, just remove it from
bookforge and replace it with narrator. remove bilingual assembly (deprecated, depends on XTTS)."
Base: BookForge main 843bd469. Planned from `C:/tmp/xtts-root-inventory.md`, narrator's
`engine/PORT_NOTES.md` section 9, `compat/FLAGS.md`, `render/SESSION_READERS.md`, and the Higgs branch's
`electron/higgs-spawn.ts`.

## Design spine

`higgs-spawn.ts` (Higgs branch) already contains the whole narrator launcher: module selection
(`compat.app` / `compat.worker` / `serve`), `narratorPythonRoot()` + PYTHONPATH, per-arg `toGuestPath`
translation, per-env-value translation, its own `bash -c` that never touches `buildWslBashCommand`.
**Generalise it to `electron/narrator-spawn.ts`** taking `(engineId, phase, args, envExtras)`, conda env
chosen by `(engineId, platform)` through the component seam. `higgs-spawn.ts` becomes a thin caller. Every
phase spawns through that one module; no bridge builds a python command line again.

| engine | Windows | macOS | Linux |
|---|---|---|---|
| orpheus render/serve | WSL `orpheus_tts` (conda run -n) | managed `narrator-mlx` env | managed orpheus env |
| orpheus prep | WSL `orpheus_tts` (same arm as today) | `narrator-mlx` | same |
| higgs-v3 | WSL `higgs3` env (served) | n/a | n/a |
| assembly / resume / list / CLI | native tools env (today's bundled relocatable env) | same | same |

## Phase 0 - land `feat/narrator`
`python/**` added; `package.json` `build.files` gains `python/**` + the four `!` excludes and `asarUnpack`
gains `python/**` (copy the Higgs-branch hunk exactly). No electron behaviour change.
Gate: `npm run build:electron` clean; narrator suite green on Windows + Mac; a packaged build contains
`resources/app.asar.unpacked/python/narrator/__init__.py`. ~6 h.

## Phase 1 - merge `feat/higgs-engine-option`
Engine union -> `orpheus | higgs` (+ `xtts` load-only legacy), picker, settings default off 'xtts',
`higgs-spawn.ts`, `tools/test-orpheus-argv-snapshot.js` + `tools/orpheus-argv-extract.js`, first-run edits,
bilingual-cache-panel deletion. Gate: keepers; argv snapshot byte-identical to
`tools/snapshots/orpheus-argv-base.json`; `tools/test-higgs-engine.js`. ~4 h.

## Phase 2 - `narrator-spawn.ts` + the streaming server cut-over
`electron/orpheus-worker-pool.ts` `resolveScriptPath()` (507-518) and `buildSpawnPlan()` (528-599) ->
`buildNarratorSpawn('orpheus','serve',...)`.

| | today | after |
|---|---|---|
| WSL argv | `conda run -n orpheus_tts python -u '<script.wsl>'` | `conda run -n orpheus_tts python -u -m narrator.serve` |
| WSL exports | `... EBOOK2AUDIOBOOK_PATH=<wslE2a>` | `... PYTHONPATH=<wslToGuest(repo/python)>`; EBOOK2AUDIOBOOK_PATH dropped |
| WSL cwd | `cd <wslE2a>` | `cd ~` |
| native argv | `[...py.args,'-u',scriptPath]` | `[...py.args,'-u','-m','narrator.serve']` |
| native env | `EBOOK2AUDIOBOOK_PATH: E2A_PATH` | `PYTHONPATH: narratorPythonRoot()` |
| native cwd | `E2A_PATH` | `app.getPath('userData')` |

All 33 other vars preserved verbatim (PORT_NOTES 9.4). Never add `--fake-engine`. Delete
`electron/scripts/orpheus_stream.py` + its build copy step; keep the reaper's serve exclusion until Phase 3.
Gate: PORT_NOTES 9.5 steps 1-5 by hand on Windows/WSL and Mac (ready -> loaded -> buffered generate_batch
-> streamed -> cancel); `test_engine_serve_protocol.py`; Listen playback in the app on both machines. ~14 h.

## Phase 3 - Orpheus batch cut-over (the big one)

### `electron/parallel-tts-bridge.ts`
| site | today | after |
|---|---|---|
| prep 3160-3242 | `[...pythonInvocation(engine).args, <e2a>/app.py, --headless ... --prep_only]` | `buildNarratorSpawn(engine,'prep', ['--headless','--ebook',p,'--session',id,'--session_dir',sessionDir (MANDATORY),'--language','--tts_engine','--device','--prep_only', ...voiceArgs, ...sentence_per_paragraph, ...skip_headings])` |
| prep 3224-3242 | XTTS sampling flag block | delete |
| worker 3877-3990 | `worker.py` vs `app.py --worker_mode` | single arm -> `buildNarratorSpawn(engine,'worker',...)`; delete the app.py branch, `useLightweightWorker`, `--skip_deps`, `--enable_text_splitting`, `--speed` |
| retake 3596-3652 | `worker.py` + the four retake flags | same flags, phase 'worker' |
| assembly 5145-5220 | `app.py --assemble_only`, `asmEngineArg='xtts'`, `assembleOrpheusNative` | `buildNarratorSpawn(undefined,'assembly',...)` in the tools env, always, every platform; drop the xtts literal (narrator does not gate assembly on engine); delete `assembleOrpheusNative` / `asmRoutingEngine` / `asmInvocation` |
| bilingual flags 5211-5215 | appended | Phase 4 |
| resume 8782-8790 / list 8878-8886 | `app.py --resume_session` / `--list_sessions` | `compat.app`, tools env, same flags, same stdout shape |
| WSL 1512-1620 | `buildWslBashCommand` (pattern rewriting, `-p python_env`, `rewriteUnderE2aRoot`, `forwardKeys`) | delete - narrator-spawn translates explicitly; forwarding = every value in `envExtras` |
| reapers 1676/1721/1739/1757 | `(worker|app)\.py.*<sid>`, `ebook2audiobook.*\.py` | `narrator\.compat\.(worker|app).*<sid>`; global fallback `narrator\.(compat|serve)`; keep the never-the-serve-process exclusion |
| 4175 | `Converting sentence N - P%: N/M` | delete (narrator never emits it) |
| 4176 | `Converting sentence N/M (P%)` | keep (matched byte-for-byte in the GPU smoke) |
| 2526/2527 | `Loading .*TTS with voice` / `TTS Loaded!` | keep (both matched) |
| 2514 GENERATION_ACTIVITY_RE, 2534 REPAIR_START_RE | e2a orpheus.py strings | VERIFY against narrator's engine output before merge; a miss = watchdog false-kill |

`prepInfo.sessionDir` is computed on both branches (3181 / 3199); passing it is one array element and is
mandatory: `sessions_root()` reads `$E2A_TMP_DIR`, narrator has no e2a-root fallback, and E2A_TMP_DIR cannot
be forwarded into WSL.

### Other bridges
- `reassembly-bridge.ts` 1501-1560: drop `appPath`, keep the arg list; route through
  `buildNarratorSpawn(undefined,'assembly')`; delete `buildWslAssemblyCommand` and the `sessionInWsl` WSL arm
  (assembly is native now). `e2aInstalled()` -> `narratorReady()`.
- `correct-sentences-bridge.ts`: logic unchanged; `parseE2aVtt` -> `parseNarratorVtt` (same bytes).
- `book-render-service.ts`: no e2a spawn; audit `engine:'xtts'` typing only.
- `cli/bookforge-tts.py` (130/206/323/834), `cli/orpheus-audiobook-render.js`, `cli/e2a-scratch.js`,
  `cli/narration-prep*.js`: same door swap; `applyE2aScratchDir` -> `applyNarratorSessionsRoot` (must set
  `--session_dir`).

Gate: (a) extend the argv snapshot keeper to `narrator-argv-base.json` covering all six doors x
{win-native, wsl, mac}; (b) resume the kershaw golden session end to end and reproduce render/PORT_NOTES
section 11's 25 checks; (c) full render of one short book on Windows/WSL + one on Mac, m4b duration and
chapter count equal to an e2a-rendered reference; (d) keepers. ~40 h.

## Phase 4 - bilingual assembly removed
`parallel-tts-bridge.ts:5211-5215` deleted unconditionally.
- Branch A (remove the whole LL/bilingual feature): delete `bilingual-assembly-bridge.ts` (416),
  `bilingual-processor.ts` (1712), `language-learning-jobs.ts` (447), `ll-jobs.ts`, `queue-steps/bilingual.ts`
  + registrations, `src/app/features/language-learning/**`, the `bilingualAssembly` maps in manifest types /
  preload / main, `translation-bridge.ts` if orphaned; keep `manifest-migration.ts` able to READ a legacy
  block. ~28 files, ~20 h.
- Branch B (keep LL, refuse assembly by name): the assembly step returns narrator's own sentence; translation/
  cache/player stay; `--sentence_per_paragraph` prep survives. ~6 h. **Recommended.**
Gate: an LL project loads without throwing; a bilingual assembly attempt yields one readable sentence in the
job log, never a wrong-length m4b.

## Phase 5 - XTTS / F5 / Voxtral removal from the root
Delete: `xtts-worker-pool.ts`, `xtts-streaming-bridge.ts` (dead), `scripts/xtts_stream.py` + build copy,
`xtts-voices.ts`, `custom-voices.ts`, `components/deepspeed-xtts.ts`, `components/cuda-tts.ts`,
`components/f5-env.ts`, `components/voxtral-env.ts`, the 81 XTTS voice records in `catalog.bundled.ts`,
`components/voice-components.ts:15-108`, `components/installed-voices.ts:5-90`, the first-run 'xtts' step,
`parallel-tts-bridge.ts:2242-2290` (DeepSpeed probe), the XTTS sampling fields in `settings.service.ts`.
Rewire: `streaming-engine.ts` loses its xtts arm (streaming = Orpheus-only); `tts-api-server.ts` and
`reader-stream-bridge.ts` import `PlaySettings` from `orpheus-worker-pool`; `stream-scheduler.ts` loses the
"opposite physics" branch; `e2a-paths.ts:135-172` drops the voxtral/f5 map and the python_env default.
Keep `manifest-migration.ts:480,711` and the 'xtts' id as load-and-refuse. Also delete
`components/language-pack-components.ts` (stanza; narrator imports none) unless open question 2 = B.
Gate: `npm run build:electron` zero TS errors; Listen smoke; Add-ons and Voices panels render; keepers. ~24 h.

## Phase 6 - assets, packaging, docs
- `e2a-env-bootstrap.ts`: KEEP the env download (now the tools env: whisper, metadata-tools, VLM convert,
  ffmpeg/ffprobe/sox for enhance/denoise/RVC, numpy/soundfile/mutagen for narrator.assemble); DELETE the code-
  snapshot half (`E2A_SNAPSHOT_STAMP`, `getBundledE2aSnapshotDir`, `installBundledE2a`, ~340 lines) and the
  `default-voice-johansson`, `library-voices`, `stanza-en` RUNTIME_ASSETS + gating (:314, 679-719). Bump
  ENV_VERSION.
- `packaging/stage-resources.js`: delete e2a source resolution/copy (`--e2a`, EBOOK2AUDIOBOOK_PATH,
  resources/e2a); `package.json` build.mac/win.extraResources drop `{from:'resources/e2a',to:'e2a'}`.
- `packaging/env/ebook2audiobook-*.yml`: strip TTS/gradio/stanza/calibre; rename `narrator-tools-*.yml`.
  Add `packaging/env/narrator-mlx.yml` (mlx 0.32.0 / mlx-lm 0.31.3 / **mlx-audio 0.4.8** / numpy / soundfile /
  mutagen / psutil / beautifulsoup4 / pillow) + a `narrator-mlx` component installer replacing the Mac
  `ebook2audiobook-orpheus` env.
- Release assets: stop publishing default-voice-johansson, library-voices, stanza-en,
  deepspeed-xtts-windows-x64, f5-env-*, voxtral-env-*. Republish the env tarballs under new names once
  slimmed (out of scope; keep names + payload this phase). Keep urvc/resemble/whisperx/rvc-base-models.
- Rename `e2a-paths.ts` -> `tools-paths-python.ts` (`getDefaultE2aPath`->`getToolsEnvRoot`,
  `getDefaultE2aTmpPath`->`getSessionsRoot`, `getEnvPathForEngine`->`getEnvPathFor`) with a one-release
  re-export shim for `cli/*.js`.
- Docs: rewrite windows-packaging-handoff, DISTRIBUTION, packaging-pipeline; touch the 10 light docs;
  CLAUDE.md's assembly line. Delete `.seed-cache/.../xtts-v2/**`.
Gate: packaged Windows install + Mac dmg on clean machines: first-run completes, one book renders and
assembles, transcription + metadata + enhance/denoise/RVC resolve their binaries. ~26 h.

## Open questions - DECIDED by Owen 2026-09-05
1. Language learning: **A - the whole feature goes** ("it needs to be rebuilt anyway ... clean it all out").
2. Non-English: **A - English-only for TTS** ("non-English books will be translated to English; there is
   already a Foundry pipeline for that; we will never TTS non-English books until a new pipeline"). Stanza
   language packs go. The bundled python env stays as the tools env; WSL keeps `orpheus_tts`.
Original framing follows for the record.

## Open questions (as put to Owen 2026-09-05)
1. Language learning: A delete (20 h, loses German LL projects) vs B keep + refuse assembly by name (6 h).
   Recommend B.
2. Non-English prep: narrator's prep gates on 'eng'; German projects exist. A English-only (0 h; existing
   German SESSIONS still render/assemble - the gate is prep-time only; delete stanza packs). B port e2a's
   stanza branch into `narrator/text/segment_stanza.py` behind an optional import + keep stanza packs
   (~24 h) for a capability nothing can render (Orpheus/Higgs are English). Recommend A.

## Risks
| risk | mitigation |
|---|---|
| Prep deps absent in WSL `orpheus_tts` (ebooklib/lxml/bs4/pillow) | `narrator[prep]` extras in the WSL env installer; the WSL doctor imports `narrator.text.prep` |
| Prep spawn ships without --session_dir | narrator refuses by name; the argv snapshot keeper asserts the flag on the prep row |
| GENERATION_ACTIVITY_RE / REPAIR_START_RE no longer match -> watchdog TERMs a working worker | pin narrator's real stderr through the regexes in a keeper before merging Phase 3 |
| Native assembly reads a WSL-rendered book (blocksize/bit depth mixes) | assembler re-encodes mixed sets losslessly (45fe5a35) |
| buildWslBashCommand deletion changes the Orpheus argv silently | the argv snapshot keeper; extend, never bypass |
| Losing forwardKeys over-forwards env into the guest | narrator-spawn forwards only envExtras, never process.env |
| Tools env drops a package narrator.assemble needs | pin numpy/soundfile/mutagen in narrator-tools-*.yml; import smoke in the first-run verifier |
| e2a repo removed from a dev machine mid-migration | nothing after Phase 3 reads it; keep resources/e2a staging until Phase 6 |

## Effort
Phase 0: 6 h; 1: 4 h; 2: 14 h; 3: 40 h; 4: 6 (B) / 20 (A) h; 5: 24 h; 6: 26 h. Total (B, English-only) ~120 h.
