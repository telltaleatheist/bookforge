# Orpheus adapter migration — implementation plan

Migrate Orpheus voice serving from one merged 6.6 GB model per voice to ONE shared
base (`unsloth/orpheus-3b-0.1-ft`) + per-voice LoRA adapters (~0.39 GB each), served
via vLLM multi-LoRA (`enable_lora=True`, per-request `LoRARequest`). Payoffs: instant
voice switching (no vLLM reload / CUDA-graph recapture), per-character dialogue
casting, 0.4 GB voice downloads.

Plan produced 2026-08-03 by a scoping pass over both repos with claims verified
against the installed vLLM 0.7.3 in the WSL `orpheus_tts` env. Definitive adapters
(pinned by weight arithmetic against the deployed merges, see memory
`orpheus-adapter-pattern-migration`):

- mistborn     = WSL `xtts_ft/mb_ae2_out/orpheus_mistborn_lora/checkpoint-327`
- thirdreich   = WSL `xtts_ft/tr_v2_out/orpheus_thirdreich_lora/checkpoint-366`
- deathstalker = WSL `xtts_ft/ds_mm3_out/orpheus_deathstalker_lora/checkpoint-500`
- ender: adapter lost; Owen retrains himself.

CAUTION: run-dir ROOT adapters are the FINAL epoch, which for every voice is NOT the
deployed keeper. Always use the pinned checkpoint-N subdir.

## Feasibility facts (verified, don't re-derive)

- Adapters are r=64 / alpha=64, q/k/v/o/gate/up/down only, `modules_to_save: null`,
  `use_dora: false` — passes vLLM 0.7.3 `PEFTHelper._validate_features`.
  peft 0.19.1's extra config keys are filtered harmlessly by `from_dict`.
- `max_lora_rank` legal values in 0.7.3: (8,16,32,64,128,256). Use 64.
- `max_loras` defaults to 1 = distinct adapters per BATCH (casting needs >1);
  `max_cpu_loras` = host cache, set to number of installed voices.
- `lora_extra_vocab_size` MUST stay 256 (the default). 0 CRASHES engine startup in
  0.7.3: `create_dummy_lora_weights` hardcodes a 10-row embeddings tensor for the
  warmup dummy LoRA (`RuntimeError: size of tensor a (0) must match ... b (10)` in
  profile_run). Verified harmless for non-embedding adapters: padded vocab is filled
  with -inf; 0 of 29,119 generated tokens landed outside the base 156,940 vocab.
  (Step-0 finding 2026-08-03.)
- Adapters ship a byte-identical tokenizer to base; loading base tokenizer is correct.
- Keep V1 OFF: `SamplingParams(logits_processors=...)` (EOS boost) is V0-only in 0.7.3.
- Merge is linear ⇒ adapters are also derivable losslessly from any merged model
  (merged − base is exactly rank-64; SVD). Recovery/validation tool, not needed for
  the three primaries.

## Work area A — e2a vLLM path (`ebook2audiobook/lib/classes/tts_engines/orpheus.py`)

- A1 `__init__` (262): add adapter mode alongside stock/custom-merged — session keys
  `orpheus_adapter_dir` + `orpheus_base_dir`; base becomes TRANSFORMERS_MODEL; voice
  token verbatim (same VALID_VOICES bypass at 316 that custom_model_dir gets, or
  `mistborn` falls back to `leah`). `custom_model_dir` path untouched (legacy).
- A2 `_load_vllm_engine` (535), LLM(...) at 609–615: add `enable_lora=True,
  max_lora_rank=64, max_loras=N, max_cpu_loras=M, lora_extra_vocab_size=0`.
  `enable_lora` is engine-construction-only — enable it whenever the install has any
  adapter voices, even if first request is stock.
- A3 new adapter registry: process-global `loaded_tts['orpheus_lora_ids']` (voice →
  stable unique int id) + `orpheus_lora_paths`; `_lora_request(voice)` →
  `LoRARequest | None`.
- A4 thread `lora_request=` through all 5 generate() sites: orpheus.py 1169,
  1204/1206, 1237/1239, 1870/1872, and bookforge `electron/scripts/orpheus_stream.py`
  498/500. Batch sites pass a LIST aligned to prompts (verified supported:
  `llm.py::_validate_and_add_requests`). PRESERVE the use_tqdm TypeError fallbacks —
  the retry call needs lora_request too or it silently renders the wrong voice.
- A5 `_format_prompt_ids` (1104): take per-item voice (default self.voice); update
  call sites 1165, 1202, 1235, 1861, orpheus_stream.py:495.
- A6 `load_engine` caching (654) — HIGHEST RISK: switching key moves from
  `orpheus_model_dir` to a base key `(base ref, lora_enabled)`. Four places use the
  old key: `_evict_global_cache` (339), `cleanup` (368), `load_engine` (669, 704).
  Adapter-mode instances with matching base REUSE the engine, never evict.
- A7 per-voice tuning constants become per-request (PREREQUISITE for casting):
  TEMPERATURE/TOP_P/REP_PENALTY/MIN_P/EOS_BOOST/EOS_BOOST_START (221–254) are class
  attrs read at import. Add `_voice_caps: dict[voice, dict]`;
  `_vllm_sampling_params` (1143) and `_eos_boost_processor` (1123) take voice;
  resolution: per-voice caps → env → class default.
- A8 `worker.py`: add `--orpheus_adapter_dir` / `--orpheus_base_dir` (near 115),
  include in worker_args (191).
- A9 `_keep_reject` (1538/1570): record adapter ref in reject metadata.

## Work area B — Mac/MLX (same orpheus.py; no separate backend file)

MLX loads via `mlx_audio.tts.utils.load_model` (467) — NO adapter param. mlx-lm's
`load_adapters` expects mlx-lm's adapter schema, NOT PEFT's. `prepare_input_ids`
monkey-patch (482–506) is load-order sensitive. Two stages, neither blocks vLLM work:

- B1 (low risk): fuse at install — download base once + adapter, fuse locally on the
  Mac into `orpheus-models/<id>/` (new `electron/scripts/orpheus_fuse.py`, darwin
  only). NOTE: runtime e2a-env python lacks peft (per orpheus-finetune
  MAC_INFERENCE.md) — fuse needs its own env or mlx-native fuse. Gets the download
  win, not instant switching. Zero orpheus.py changes.
- B2: resident base + LoRA layer wrappers — `_apply_mlx_adapter(model, adapter_dir)`
  wrapping the 7 proj modules with W(x)+(alpha/r)·B(A(x)), ~40-line PEFT→mlx key
  remap, `_clear_mlx_adapter()` for switching. Must stay compatible with
  `mlx_lm.generate.BatchGenerator` (1051) batch prefill. Pre-deploy gating still on
  vLLM per MAC_INFERENCE.md (MLX/vLLM greedy ties differ).

## Work area C — streaming (bookforge/electron)

- C1 `scripts/orpheus_stream.py`:
  - `_ensure_engine` (257): 286–288 tears down on model_dir change — must NOT fire
    for adapter↔adapter; teardown only merged↔merged / merged↔adapter.
  - `load_voice` (389) / `load` action (821–824): accept adapterDir + baseDir;
    "load" = register adapter + set default, not load weights.
  - `_apply_voice_caps` (406–428) mutates os.environ — process-global, breaks
    mixed-voice batches. Replace with per-voice caps dict → `orph._voice_caps`.
  - **BUG FOUND: streaming currently runs every voice with eosBoost=0.** `_CAP_ENV`
    (400–404) omits eosBoost claiming "read at engine load", but EOS_BOOST is an
    import-time class attr and `buildSpawnPlan` (orpheus-worker-pool.ts:328–366)
    never exports ORPHEUS_EOS_BOOST. Catalog declares 8@2.0 for tr/mb/ender/ds.
    Fixed for free by A7.
  - `_generate_audio_batch` (464) builds its own SamplingParams (482–486), dropping
    the EOS-boost processor — switch to `orph._vllm_sampling_params(len, voice=...)`.
  - `generate` (767) / `generate_batch` (727): optional per-item voice.
- C2 `orpheus-worker-pool.ts`: `generateSentence` (788) stops discarding _settings;
  BatchItem/enqueueBatchItem/flushBatch (678/687/718) carry voice into the item map
  (743–746); `loadVoice` (535) sends {action:'load', voice, adapterDir, baseDir,
  caps} (keep 547–572 verbatim); 180s first-load timeout stays, adapter registration
  gets a short one; `translateModelDirForSpawn` (73) translates base AND adapter dirs.
- C3 `tts-api-server.ts`: `speak` voice contract (420–424) stays; the loaded-voice
  mismatch guard (443–449) becomes merged-mode-only or concurrent multi-voice
  clients reject each other.
- C4 `stream-scheduler.ts`: expected no-change; confirm settings.voice populated per
  session (~240–260).

## Work area D — catalog + download (bookforge)

- D1 `electron/data/orpheus-models.json`: two NEW inventory fields per voice —
  `"artifact": "adapter"` (absent ⇒ merged = exact current path; structural backward
  compat) and `"base": {"id": "orpheus-3b-base", "ref": "unsloth/orpheus-3b-0.1-ft"}`.
  Tuning fields untouched. Do NOT add to TUNING_KEYS (orpheus-models.ts:385);
  `applyTuning` (436) spread means catalog wins — correct, artifact is a fact about
  the voice.
- D2 WSL `/home/telltale/orpheus-models/models.json`: `kind: base|voice`
  discriminator; layout `_base/orpheus-3b-0.1-ft/` (one copy) + `adapters/<id>/` +
  legacy merged dirs coexisting. Add explicit skip-set for `_base`/`adapters` in the
  reconcile scan (listOrpheusModels 500–511).
- D3 `electron/orpheus-models.ts`: split `isModelFolder` (440) into
  merged/adapter/base predicates; `OrpheusModel` (96) + `OrpheusManifestEntry` (184)
  gain artifact/baseDir/kind; `resolveOrpheusModel` (522) returns baseDir and FAILS
  LOUDLY if adapter's base missing; new `resolveOrpheusBase()`;
  `orpheusVoiceCapsForModel` (573) unchanged (single source of truth).
- D4 `electron/orpheus-hf-catalog.ts`: card frontmatter keys `orpheus_artifact:
  adapter` + `orpheus_base:` (absent ⇒ merged); `installOrpheusModel` (333) becomes
  two-phase (ensure base, then adapter → `adapters/<id>/`) with separate progress;
  new `installOrpheusBase` / `isOrpheusBaseInstalled`; `removeOrpheusModel` (365)
  refuses base delete while referenced, deletes adapter subdir (currently hardcodes
  top-level path at 371).
- D5 `electron/scripts/orpheus_download.py`: `--kind {merged,adapter,base}` selects
  validation predicate (current config.json+safetensors check FAILS on adapter repos).
- D6 `electron/data/orpheus-voice-sources.json`: point at `-lora` repos.
- D7 `electron/main.ts` (4397–4493): add `orpheus:base-status` / `orpheus:base-install`
  IPC with the same isWslAlive guard (4450–4453); keep the refreshInstalledVoices
  call (4470–4472).
- D8 `src/app/features/settings/components/orpheus-voices-panel.component.ts`: add a
  "Base model" card (reuse Engine card markup, 40–72); voices show adapter size,
  Download disabled with "Requires the Orpheus base model" when base missing; update
  explainer copy (31–36, says "each is a full fine-tune"). Setup wizard
  (first-run-setup.component.ts:172) embeds this panel — inherits free.
- D9 `electron/parallel-tts-bridge.ts`: `pushVoiceArgs` (149) orpheus branch pushes
  `--orpheus_base_dir` + `--orpheus_adapter_dir` + `--fine_tuned` for adapter voices;
  loud throw (170–176) also fires when base missing. Audiobook one-voice-per-process
  env mechanism stays valid.
- D10 orpheus-finetune `deploy_voice.sh` + `upload_to_hf.py`: adapter mode (rsync
  `<out>/orpheus_<voice>_lora/checkpoint-N` → `adapters/<voice>/`, upload with
  `orpheus_artifact`/`orpheus_base` card keys). Keep merged path until adapters
  proven — deploying both for one voice is the cheapest A/B.

## HF artifact layout — DECIDED: one repo per voice adapter

`owenmorgan/<voice>-orpheus-3b-lora`; base pulled straight from
`unsloth/orpheus-3b-0.1-ft` (mirror only if upstream availability worries). Reasons:
catalog is repo-per-voice by construction (one model card per repo carries the
per-voice token/label/sample_rate); downloader is repo-scoped snapshot_download;
uninstall stays a folder delete; vLLM's own `get_adapter_absolute_path` accepts bare
repo ids with no subfolder support; per-voice privacy control (real-person clones,
PRIVATE by default).

## Risks

- VRAM: each GPU-resident adapter ~0.39 GB + punica workspace; `max_loras=4` ≈
  +1.6 GB over the ~6.2 GB base. Collides with `orpheus-memory.ts` VLLM_TIERS
  (light capMB 8704 / moderate 10240 sized for one 6.6 GB model) — raise caps or
  derive max_loras from tier. Also update `computeSafeGpuUtil` (gpu-arbiter.ts:196)
  and the ORPHEUS_MIN_VRAM_MB preflight (parallel-tts-bridge.ts:5811–5971).
- CUDA graphs × LoRA: streaming sets ORPHEUS_DISABLE_EAGER=1 for graphs
  (orpheus-worker-pool.ts:329; honoured orpheus.py:569–571). MEASURE capture time +
  steady throughput with enable_lora before committing (expect ~10–20% kernel cost).
- Four copies of the voice allowlist need the adapter bypass: orpheus.py:113,
  orpheus-worker-pool.ts:63, parallel-tts-bridge.ts:147, orpheus_stream.py:246.
- Kill/session separation must stay: parallel-tts-bridge.ts:1493–1519 excludes
  orpheus_stream.py from audiobook kill scans; orpheus-worker-pool.ts:903–908 kills
  by pattern. Don't blur under a "one resident server" refactor.
- Every new `\\wsl$` fs touch goes through the wedge gates (orpheus-models.ts:42–46,
  302, 322, 527) — sync stat on a wedged VM hangs the main thread.
- QUALITY: base+LoRA is not guaranteed bit-equal to merged (bf16 merge rounding +
  different kernel compute order). Voices were selected on razor-thin margins
  (thirdreich ep366 over ep549 by 0.0066 eval loss; EOS ties). Gate everything.

## Implementation order + gates

0. **Standalone proof (no repo changes)**: WSL scratch script; base +
   enable_lora + LoRARequest at the PINNED checkpoint vs the merged model; greedy
   20-chunk token comparison; then eos_gate battery + rate measure + graph-capture
   timing. Near-identical tokens ⇒ proceed; divergence ⇒ diagnose first.
   **PASSED 2026-08-03** (artifacts: WSL `/home/telltale/scratch_step0/RESULTS.txt`).
   Key findings: free-running greedy token identity is UNACHIEVABLE for this model
   class — the merged model vs ITSELF at a different batch shape also gives 0/20
   exact matches (chosen SNAC codes average only 17.5% probability; ~7.6% of
   positions flip on any kernel-order change). The decisive metric is teacher-forced
   argmax agreement: merged self-floor 92.417%, adapter 92.300% — a 7-in-6000 gap,
   inside the merged model's own noise. CPU weight check: best-fit scale
   0.9997–1.0000; the MERGED checkpoint is the lossy artifact (bf16 store rounding
   is the same order as the LoRA delta), not the adapter. Perf: graph capture NOT
   penalized (5s vs 7s); LoRA throughput cost 18.9% at max_num_seqs=20 (675.8 vs
   833.2 tok/s) — re-measure at production batch sizes. All health gates clean
   (20/20 stop, 0 cap hits, SNAC framing intact, 0 vocab-pad leaks). Audio/ear
   check deferred to step 1's gate by design.
1. e2a vLLM adapter mode (A1–A6, A8), audiobook path only. Gate: full-chapter A/B
   vs merged; zero cap hits/EOS failures; ear check.
2. Per-voice caps refactor (A7) + SamplingParams unification (C1 partial). Gate:
   single-voice renders byte-identical to step 1; streaming now applies eosBoost 8.
3. Catalog + download (D1–D8, D10), one voice first. Gate: fresh-machine wizard =
   base once + adapter; dev machine with merged installs unchanged (explicit
   backward-compat gate).
4. Streaming per-request voice (C1–C3). Gate: warm server, mid-article voice switch,
   NO reload in worker log, first-audio latency normal; then mixed-voice batch.
5. Mac stage 1 fuse-at-install (B1). Gate: identical audio to current Mac path.
6. Mac stage 2 resident adapters (B2). Gate: greedy compare vs Mac's own fused model.
7. Per-character casting: max_loras>1, per-sentence voices.
