# PORT_NOTES  -  `narrator/engine` and `narrator/serve`

What was ported, from where, what replaced each ebook2audiobook dependency, and
everything that was deliberately left behind.

> **2026-09-04: the engine interface was extracted and every Orpheus module
> moved down one level, into `engine/orpheus/`.** Nothing in this file's
> descriptions of the Orpheus port changed - the bodies did not move, only the
> files did. Read section 12 first for the old -> new path table, the two new
> packages (`engine/protocol.py` + `engine/registry.py`, and `engine/higgs/`),
> and the compatibility aliases that keep every old import path working. Where a
> row below says `engine/<name>.py`, the file is now
> `engine/orpheus/<name>.py`.

**Sources** (all read-only):

| source | commit | what came from it |
|---|---|---|
| `ebook2audiobook` `lib/classes/tts_engines/orpheus.py` (5,507 lines) | `9daab0ba` (branch `bookforge`) | the engine |
| `ebook2audiobook` `lib/classes/tts_engines/orpheus_stream_decode.py` | `9daab0ba` | `engine/snac.py`'s emitter half |
| `ebook2audiobook` `lib/classes/tts_engines/orpheus_mlx_fastpath.py` | `9daab0ba` | `engine/mlx_fastpath.py` (verbatim) |
| `ebook2audiobook` `lib/conf.py` | `9daab0ba` | `engine/cuda_env.py` |
| `ebook2audiobook` `lib/classes/tts_engines/common/{audio,utils,asr_gate,orpheus_text,preset_loader}.py` | `9daab0ba` | four helpers, see the table below |
| `ebook2audiobook` `lib/conf_models.py` | `9daab0ba` | `SML_UNSPOKEN_PATTERN`, `loaded_tts` |
| `bookforge` `electron/scripts/orpheus_stream.py` (1,658 lines) | `3b4d0b17` | `serve/worker.py` |

**97 of the 99 top-level/class definitions in `orpheus.py` are ported.** The two
that are not are the class itself (renamed `OrpheusEngine`) and `create_vtt`  - 
see "Dropped" below.

---

## 1. Every e2a dependency, and what replaced it

`orpheus.py` reached outside itself through eight import lines. This is the
complete list of the SYMBOLS it actually used from them (measured, not assumed:
`grep -c '\b<name>\b'` over the file), and what each became.

### `from lib.classes.tts_engines.common.headers import *`

| symbol | uses | replaced by |
|---|---|---|
| `loaded_tts` | 34 | `engine/registry.py:LOADED`  -  a plain module dict, same keys, same semantics. See that module's docstring for why a process-global cache survives the port at all. |
| `TTSUtils` | base class | Gone. Only three of its 15 methods were ever called: `_cleanup_memory` -> `engine/audio.py:AudioMixin`, `_split_long_text` -> `engine/prompt.py:PromptMixin`, `_build_vtt_file` -> not ported (see "Dropped"). |
| `TTSRegistry` | base class | Gone. Its whole job was `TTSRegistry.ENGINES['orpheus'] = cls` so `TTSManager` could look an engine up by name from a session dict. narrator serves exactly one engine; the caller imports the class. |
| `DictProxy` | 1 (the `__init__` annotation) | `engine/config.py:EngineConfig`, a dataclass. See section 2. |
| `trim_audio` | 1 call (`_speech_rate`) | `engine/audio.py:trim_audio`, verbatim. |
| `default_audio_proc_format` | 3 | `EngineConfig.audio_format` (default `'flac'`, the same value `lib/conf.py` set). |
| `SML_UNSPOKEN_PATTERN` | 1 use | `engine/text.py:SML_UNSPOKEN_PATTERN`, verbatim from `lib/conf_models.py`. |
| `tts_dir` | 1 (`self.cache_dir = tts_dir`) | **Dropped**: `self.cache_dir` is never read again anywhere in `orpheus.py`. Dead. |
| `Path` | 1 (in `create_vtt`) | n/a  -  `create_vtt` is not ported. |
| `Any` | 3 (type annotations) | n/a. |
| `random` | 4 | already a *local* `import random` inside `_load_vllm_engine`; kept there. |
| `shutil`, `subprocess`, `uuid`, `hf_hub_download`, `detect_gender`, `is_audio_data_valid`, `devices`, `TTS_ENGINES`, `TTS_VOICE_CONVERSION`, `TTS_SML`, `SML_TAG_PATTERN`, `default_vc_model`, `default_engine_settings` | **0** | Never referenced by `orpheus.py`. The star-import pulled them in and nothing used them. |

### The other seven import lines

| import | replaced by |
|---|---|
| `common.preset_loader.load_engine_presets` | `engine/config.py:STOCK_VOICE_PRESETS`. The presets module was `models[voice] = {lang, voice, description, gender, samplerate}` and `orpheus.py` read exactly one field of it (`.get('voice', voice)`), whose value is the key itself for all eight stock voices. Reduced to `{v: v}`  -  an identity for the allowlist, a miss for anything else, which is what the lookup delivered. |
| `common.audio.trim_audio` | `engine/audio.py:trim_audio`, verbatim. |
| `common.orpheus_text.asr_gate_risk` | `engine/text.py:asr_gate_risk`, verbatim (with `num_to_words` / `_big_num_words` / `_NUMBER_WORDS`, which the gate needs). |
| `common.asr_gate` | `engine/asr_gate.py`, verbatim except one import rewired (`_big_num_words` now from `engine.text`). |
| `orpheus_stream_decode` | `engine/snac.py`, verbatim (constants, `StreamDecodeMisaligned`, `WindowedFrameEmitter`). |
| `orpheus_mlx_fastpath` (3 lazy sites) | `engine/mlx_fastpath.py`, VERBATIM code; only prose path references and non-ASCII punctuation changed. |
| `lib.conf` (transitively, for the CUDA env) | `engine/cuda_env.py`, applied at import of each backend module. |

### The session dict

`orpheus.py` read exactly eight session keys (`grep -o "self\.session\(\.get(...)\|\[...\]\)"`):

| session key | reads | `EngineConfig` field |
|---|---|---|
| `fine_tuned` | 1 | `voice` |
| `orpheus_model_dir` | 2 (1 + the reject record) | `model_dir` |
| `orpheus_adapter_dir` | 2 | `adapter_dir` |
| `orpheus_base_dir` | 2 | `base_dir` |
| `sentences_dir` | 2 | `sentences_dir` |
| `process_dir` | 2 | `process_dir` |
| `tts_engine` | 1 (`load_engine_presets(session['tts_engine'])`) | dropped with the preset loader |
| `final_name` | 1 (in `create_vtt`) | n/a  -  not ported |

`EngineConfig` adds three fields e2a carried in the environment or not at all:
`caps` (the catalog payload the streaming server used to register in a separate
step), `backend` (the constructor form of `ORPHEUS_BACKEND`, which is still
honoured), and `audio_format` (was `lib/conf.default_audio_proc_format`). It
deliberately has NO `reject_dir` and NO `language` field - see section 8.

---

## 2. The shape of the port

`orpheus.py` was ONE 5,507-line class inheriting `TTSUtils` + `TTSRegistry`.
`OrpheusEngine` is one class assembled from mixins, one per seam, so a reviewer
can diff each file against the region of `orpheus.py` it came from. **Method
bodies are unchanged**; only their file moved and their `self.session[...]`
became `self.config....`.

```
EngineDefaults          config.py            every tuning constant, as CLASS attributes
CapsMixin               caps.py              VOICE_CAP_SOURCES, register_voice_caps, _voice_cap
PromptMixin             prompt.py            clean / format_prompt_ids / split_long_text / classify_gap
SamplingMixin           sampling.py          expected tokens, EOS floor + boost, vLLM SamplingParams
SnacMixin               snac.py              _redistribute_codes, _tokens_to_audio (+ WindowedFrameEmitter)
GuardsMixin             guards.py            speech rate, rejects, guard events, truncation verdict + ratchet
AudioMixin              audio.py             trim_audio, _save_audio, _write_silence, _cleanup_memory
AdaptersMixin           adapters.py          LoRA validation, the vLLM id registry, the MLX applier
VllmBackendMixin        vllm_backend.py      engine load, batch/solo ladders, fast start
MlxBackendMixin         mlx_backend.py       model load, batch scheduler, decode overlap, fast start
TransformersBackendMixin transformers_backend.py  the slow fallback
OrpheusEngine           engine.py            __init__ / load_engine / cleanup / convert / convert_batch /
                                             generate_batch_stream / detect_backend
```

Constants stayed CLASS attributes rather than becoming dataclass fields because
that is how all three of their call shapes read them today  -  `self.MAX_AUDIO_TOKENS`,
`cls.LORA_MAX_RANK`, and the tests that set `Orpheus.SHORT_CHUNK_MAX_CHARS = 0`
to silence a report.

**Lazy imports.** e2a imported `torch`, `torchaudio` and `numpy` at
`orpheus.py`'s module scope and got the CUDA-env ordering right only because
`lib.conf` happened to be imported first through `common.headers`. narrator
imports `numpy` at module scope and torch / torchaudio / vLLM / mlx / mlx_lm /
mlx_audio / transformers / snac **only inside the functions that use them**, so
`import narrator.engine` costs nothing and works on an interpreter with none of
them. `tests/test_engine_lazy_imports.py` asserts this as a contract, in a fresh
subprocess, for every module.

---

## 3. Function -> module map

Line numbers are `orpheus.py` at `9daab0ba`, so each row is a one-command diff.

| e2a line | name | narrator module |
|---|---|---|
| 29 | `TokenStreamMisaligned` | `errors.py` |
| 51 | `is_fatal_cuda_error` | `errors.py` |
| 56-75 | the platform vLLM block (module scope) | `cuda_env.apply_vllm_platform` |
| 78 | `_cleanup_on_exit` + `_active_instances` + `atexit` | `engine.py` |
| 106 | `_MlxAdapterState` | `adapters.py` |
| 133 | `_mlx_lora_linear_cls` | `adapters.py` |
| 169 | `_VllmStreamRow` | `vllm_backend.py` |
| 211-761 | the class-constant block | `config.py:EngineDefaults` |
| 665-728 | `VOICE_CAP_SOURCES` / `VOICE_CAP_IGNORED` / `_voice_caps` | `caps.py:CapsMixin` |
| 730-734 | `_eos_floor_announced` | `sampling.py:SamplingMixin` |
| 736-755 | `_reject_lock` | `guards.py:GuardsMixin` |
| 763 | `__init__` | `engine.py` |
| 910 | `_validate_adapter_mode` | `adapters.py` |
| 978 | `validate_adapter_dir` | `adapters.py` |
| 1011 | `_read_adapter_config` | `adapters.py` |
| 1019 | `_validate_adapter_config` | `adapters.py` |
| 1053 | `_validate_adapter_config_vllm` | `adapters.py` |
| 1067 | `_validate_adapter_config_mlx` | `adapters.py` |
| 1087 | `_evict_global_cache` | `engine.py` |
| 1118 | `cleanup` | `engine.py` |
| 1154 | `__del__` | `engine.py` |
| 1162 | `detect_backend` | `engine.py` |
| 1178 | `_detect_backend` | `engine.py` |
| 1234 | `_load_mlx_engine` | `mlx_backend.py` |
| 1298 | `_patch_mlx_prompt_framing` | `mlx_backend.py` |
| 1347 | `MLX_LORA_PREFIX` | `config.py` |
| 1350 | `_mlx_lora_scale` | `adapters.py` |
| 1367 | `_mlx_walk` | `adapters.py` |
| 1377 | `_mlx_adapter_plan` | `adapters.py` |
| 1481 | `_apply_mlx_adapter` | `adapters.py` |
| 1518 | `_clear_mlx_adapter` | `adapters.py` |
| 1532 | `_sync_mlx_adapter` | `adapters.py` |
| 1554 | `_load_snac` | `vllm_backend.py` |
| 1581 | `_load_vllm_engine` | `vllm_backend.py` |
| 1689 | `_adapter_fingerprint` | `adapters.py` |
| 1708 | `_register_lora` | `adapters.py` |
| 1772 | `register_adapter` | `adapters.py` |
| 1805 | `set_voice` | `adapters.py` |
| 1870 | `adapter_capable` | `adapters.py` |
| 1888 | `_lora_request` | `adapters.py` |
| 1925 | `register_voice_caps` | `caps.py` |
| 1966 | `_voice_cap` | `caps.py` |
| 1986 | `_load_transformers_engine` | `transformers_backend.py` |
| 2021 | `load_engine` | `engine.py` |
| 2142 | `_max_chars_per_sec` | `caps.py` |
| 2160 | `_mlx_token_budget` | `sampling.py` |
| 2193 | `_generate_mlx` | `mlx_backend.py` |
| 2254 | `_mlx_est_tokens` | `sampling.py` |
| 2263 | `_mlx_looks_capped` | `mlx_backend.py` |
| 2277 | `_generate_mlx_safe` | `mlx_backend.py` |
| 2317 | `batch_pool_size` | `mlx_backend.py` |
| 2349 | `_mlx_width_for_depth` | `mlx_backend.py` |
| 2376 | `_mlx_kv_headroom_gb` | `mlx_backend.py` |
| 2395 | `_mlx_batch_groups` | `mlx_backend.py` |
| 2448 | `_resolve_mlx_row` | `mlx_backend.py` |
| 2478 | `_mlx_frame_decoder` | `mlx_backend.py` |
| 2547 | `_generate_mlx_batch_audio` | `mlx_backend.py` |
| 3082 | `_format_prompt_ids` | `prompt.py` |
| 3108 | `_expected_audio_tokens` | `sampling.py` |
| 3141 | `_eos_floor_tokens` | `sampling.py` |
| 3181 | `_eos_boost_processor` | `sampling.py` |
| 3222 | `_mlx_eos_boost_processor` | `sampling.py` |
| 3266 | `_vllm_sampling_params` | `sampling.py` |
| 3287 | `_generate_tokens_vllm` | `vllm_backend.py` |
| 3309 | `_generate_audio_vllm_safe` | `vllm_backend.py` |
| 3363 | `_generate_parts_batched` | `vllm_backend.py` |
| 3425 | `generate_batch_stream` | `engine.py` |
| 3537 | `_absorb_stream_tokens` | `vllm_backend.py` |
| 3568 | `_vllm_frame_decoder` | `vllm_backend.py` |
| 3582 | `_generate_batch_stream_vllm` | `vllm_backend.py` |
| 3805 | `_emit_vllm_stream` | `vllm_backend.py` |
| 3833 | `_retire_vllm_stream_row` | `vllm_backend.py` |
| 3886 | `_generate_tokens_transformers` | `transformers_backend.py` |
| 3920 | `_redistribute_codes` | `snac.py` |
| 3985 | `_tokens_to_audio` | `snac.py` |
| 4039 | `_sentence_file` | `audio.py` |
| 4042 | `_clean_sentence_for_tts` | `prompt.py` |
| 4075 | `_classify_gap` | `prompt.py` |
| 4139 | `_write_silence` | `audio.py` |
| 4146 | `_speech_rate` | `guards.py` |
| 4167 | `_reject_dir` | `guards.py` |
| 4194 | `_keep_reject` | `guards.py` |
| 4216 | `_keep_reject_locked` | `guards.py` |
| 4266 | `_emit_guard_event` | `guards.py` |
| 4289 | `_chunk_csv_sentinel` | `guards.py` |
| 4307 | `_log_chunk_stats` | `guards.py` |
| 4331 | `_log_batch_stats` | `guards.py` |
| 4344 | `_asr_verify_or_retry` | `guards.py` |
| 4401 | `_guard_truncation` | `guards.py` |
| 4453 | `_rate_ceiling` | `guards.py` |
| 4460 | `_needs_resplit` | `guards.py` |
| 4493 | `_report_short_chunk_overrun` | `guards.py` |
| 4540 | `_ratchet_after_resplit` | `guards.py` |
| 4561 | `_save_audio` | `audio.py` |
| 4610 | `convert` | `engine.py` |
| 4683 | `_render_deferred_resplits` | `vllm_backend.py` |
| 4726 | `convert_batch` | `engine.py` (dispatch) + `vllm_backend.py:_convert_vllm_batch` (body) |
| 4875 | `_mlx_decode_stream` | `mlx_backend.py` |
| 4919 | `_mlx_row_audio` | `mlx_backend.py` |
| 4940 | `_mlx_rerender_capped` | `mlx_backend.py` |
| 4969 | `_mlx_resplit_deferred` | `mlx_backend.py` |
| 4984 | `_mlx_generate_rows` | `mlx_backend.py` |
| 5324 | `_convert_mlx_batch` | `mlx_backend.py` |
| 5498 | `create_vtt` | **not ported** |

### The one method body that was split

`convert_batch` (4726) is a 3-line backend dispatch wrapped around a 120-line
vLLM body inside one `try/except`. The dispatch stays on the class (`engine.py`)
because it names all three backends; the body moved to
`vllm_backend.py:_convert_vllm_batch` because it is pure vLLM. The `try/except`
that wraps it  -  including the fatal-CUDA re-raise and the per-item
`convert()` retry  -  stays exactly where it was, around the call. No statement
changed, no order changed.

---

## 4. Public surface

Everything `bookforge_ext/parallel/worker_core.py` (through `TTSManager`) and
`electron/scripts/orpheus_stream.py` call, with the same signatures:

| caller | member |
|---|---|
| worker_core / TTSManager | `SUPPORTS_BATCH`, `BATCH_SIZE`, `batch_pool_size`, `params['samplerate']`, `voice`, `TEMPERATURE`, `register_voice_caps(voice, caps)`, `convert(i, sentence) -> bool`, `convert_batch(items) -> list[bool]` |
| the streaming worker | `OrpheusEngine(config)`, `detect_backend()` (classmethod), `backend`, `voice`, `engine`, `END_OF_AUDIO_TOKEN`, `cleanup()`, `set_voice(voice, adapter_dir)`, `register_voice_caps`, `_clean_sentence_for_tts`, `_format_prompt_ids`, `_vllm_sampling_params`, `_lora_request`, `_tokens_to_audio`, `_generate_tokens_transformers`, `_generate_audio_vllm_safe`, `_generate_mlx_safe`, `_generate_mlx_batch_audio`, `_guard_truncation`, `generate_batch_stream(texts, voices, stream_rows, on_chunk, on_row, should_stop=None)` |

`register_adapter`, `adapter_capable` and `validate_adapter_dir` are also public
and unchanged.

`TTSManager` itself is NOT ported: it is four one-line delegations plus a
registry lookup keyed on `session['tts_engine']`, and narrator's caller holds the
engine directly.

---

## 5. Load-bearing log strings preserved byte-for-byte

Measured against the BookForge regexes that read them (`grep` over `electron/`):

| string | read by |
|---|---|
| `[ORPHEUS][ORPHEUS_GUARD_EVENT] {json}` | `parallel-tts-bridge.ts:111` slices this exact prefix off before `JSON.parse` |
| `MLX batch generating: <N> rows, ~<T> tokens (step <S>/<D>), <R>/<N> rows done, batch <G>/<C>[ live <L>]` | `mlx-batch-progress.ts:94` (the within-batch progress bar) AND `parallel-tts-bridge.ts:2513` (watchdog activity) |
| `audio-token cap` | `GENERATION_ACTIVITY_RE` (watchdog) and `REPAIR_START_RE` |
| `re-rendering split` | `GENERATION_ACTIVITY_RE` |
| `sentence <N> hit the MLX audio-token cap` | `REPAIR_START_RE` (`parallel-tts-bridge.ts:2534`) |
| `sentence <N> produced no audio` | `REPAIR_START_RE` |
| `sentence <N> audio too short for text` | `REPAIR_START_RE` |
| `[ORPHEUS][SHORT_CHUNK_OVERRUN] sentence=... chars=... seconds=... allowed=... ratio=... text=...` | counted with `grep -c SHORT_CHUNK_OVERRUN` |
| `[ORPHEUS][STREAM] ...` (fast start, stderr) | operator-read; not regex-parsed today |

**One deliberate character change.** Three prose log lines carried a U+2014 em
dash; CONTRACTS.md forbids non-ASCII in anything reaching a console. They are now
`-`. Verified against every regex above: the matched substrings all end BEFORE
the dash, so no parser sees a difference.

- `Orpheus: sentence N produced no audio - re-rendering split at sentence boundaries`
- `Orpheus: sentence N audio too short for text (X ch/s > Y) - re-rendering split at sentence boundaries`
- `Orpheus: voice 'v' measured natural rate X ch/s exceeds guard threshold Y - recalibrating threshold to Z for this session`

Comment/docstring em dashes elsewhere were normalised to `-` as well; the split
characters in `_split_long_text`'s `split_chars` list (U+2014 em dash, U+2013 en dash) are DATA
matched against book text and are unchanged.

---

## 6. Dropped

### Dead code (kept out, listed here)

| what | why it is dead |
|---|---|
| `self.cache_dir = tts_dir` (`__init__`, line 766) | assigned once and never read anywhere in `orpheus.py`. |
| the 13 unused `common.headers` star-imports (section 1) | zero references in the file. |
| `orpheus_text.to_tts_form` and its three transforms (`expand_digits`, `normalize_scripture`, `expand_grouped_integers`) plus `year_words` | THE ENGINE READS THE TEXT AS PRINTED (Owen, 2026-09-02, permanently): `_clean_sentence_for_tts` strips SML and nothing else, and never calls them. Their one live reader inside the engine was `asr_gate._norm_words` -> `_big_num_words`, which IS ported. `year_words` additionally reached back into `lib.core.year2words`, pulling in `num2words` and e2a's phoneme tables for a function narrator never calls. |
| `TTSRegistry` | see section 1. |
| the 12 unused `TTSUtils` methods | never called by `orpheus.py`. |
| e2a's `cleanup_models_cache()` interaction | that function belongs to the single-process GUI path, which never sets `orpheus_adapter_dir` and therefore has no LoRA registry to desynchronise. narrator has no GUI path at all. |

### Owned by another module

| what | who owns it |
|---|---|
| `create_vtt` (5498) + `TTSUtils._build_vtt_file` | `narrator/assemble/` (builder A). Reached only from `lib/core.py`'s non-parallel GUI path  -  never from `worker_core.py` and never from the streaming worker (`grep create_vtt` over `bookforge_ext/` finds nothing). `_build_vtt_file` also needs `gradio`, `tqdm` and `get_audiolist_duration`, none of which belong in the engine. Contract 5 of `docs/NARRATOR_PLAN.md` puts the VTT in `assemble/`. |
| `lib/conf.py`'s non-CUDA environment | Not narrator's. `HUGGINGFACE_HUB_CACHE`/`HF_HOME`/`TORCH_HOME`/`XDG_CACHE_HOME` point at e2a's `models/` tree; `CALIBRE_*`, `GRADIO_DEBUG`, `STANZA_RESOURCES_DIR`, `ARGOS_TRANSLATE_PACKAGE_PATH`, `BARK_CACHE_DIR`, `TTS_CACHE`, `SUNO_*`, `TESSDATA_PREFIX` and the espeak-ng shims belong to engines and tools the plan deletes. The `TMPDIR`/`tempfile.tempdir` relocation and the macOS multiprocessing socket-dir fix belong to a session store, which is `render/`'s. Only the CUDA/graph/allocator block moved (`cuda_env.apply`), plus `PYTHONUTF8`, `PYTHONIOENCODING`, `TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD` and `PYTORCH_ENABLE_MPS_FALLBACK`, which are torch-process facts. |

#### 6(a) `_reject_dir`: the environment is the only override

e2a: `os.environ.get('ORPHEUS_REJECT_DIR','').strip()`, then derive
`<tmp>/tts_rejects/<ebook-uuid>/` from `session['process_dir']`, then `None`.
narrator: identical, reading `config.process_dir`. An earlier draft of this port
inserted `config.reject_dir` ahead of the env var; that field is gone (see
section 8). Restored so the precedence is e2a's exactly: **env, then derived,
then None**.

### Not ported from `orpheus_stream.py`

| what | why |
|---|---|
| `get_e2a_path()` + `sys.path.insert(0, E2A_PATH)` | there is no ebook2audiobook checkout to find. |
| the `hasattr(orph, 'register_voice_caps')` guard | it existed to catch an e2a checkout older than per-voice caps. The engine now ships inside this package; the version skew it defended against cannot happen. |
| the `hasattr(orph, 'generate_batch_stream')` guard | same reason ("pull the bookforge branch" is not advice narrator can give). |

---

## 7. Suspected bugs preserved

**One, found by running the MLX tests on the Mac (2026-09-04).**

`mlx_fastpath.install()` imports the class it is going to patch BEFORE it checks
the version pin:

```python
def install(model, *, rep_window, max_tokens):
    import mlx.nn as nn
    import mlx_lm
    from mlx_lm.generate import GenerationBatch      # <- line 3
    version = getattr(mlx_lm, '__version__', '<unknown>')
    if version != REQUIRED_MLX_LM:                   # <- the pin check, line 5
        raise FastPathUnsupported('... pinned to mlx-lm 0.31.3 ...')
```

`GenerationBatch` was added in mlx-lm **0.31.3** - the pinned version - so on any
older mlx_lm the import on line 3 raises a bare `ImportError` and line 5 never
runs. The module's own docstring promises the opposite: *"Raises
FastPathUnsupported, by name, for every condition the patch cannot honour."*

MEASURED on the Mac's live Orpheus env (`ebook2audiobook-orpheus`, mlx_lm 0.29.1):

```
install() raised ImportError (NOT the documented refusal):
  cannot import name 'GenerationBatch' from 'mlx_lm.generate'
```

**Preserved, not fixed** - the port reproduces e2a's ordering exactly (this file's
rule: note a suspected bug, do not repair it). It still REFUSES, which is what
protects a render; only the message is worse than advertised, and
`_load_mlx_engine` does not catch either exception so the load fails loudly
either way. `tests/test_engine_mlx_fastpath.py::MlxFastPathPinTest` pins both
halves: `test_install_never_returns_silently_below_the_pin` (the invariant that
actually matters, asserted in every env) and
`test_below_the_pin_the_refusal_is_an_ImportError_not_FastPathUnsupported` (the
defect itself, so a future fix is deliberate and visible rather than silent).

> **Operational consequence, for whoever owns the Mac env.** With mlx_lm 0.29.1
> installed, `_load_mlx_engine` -> `mlx_fastpath.install(...)` raises
> `ImportError` and the MLX load DIES, unless `ORPHEUS_MLX_FASTPATH=0` is set.
> That is e2a@9daab0ba's behaviour too, not something this port introduced. The
> fix is the env, not the code: see section 7a.

### 7a. What the MLX backend requires of its environment

Measured across the three conda envs on the Mac, 2026-09-04:

| env | mlx | mlx_lm | `new_thread_unsafe_stream` | `GenerationBatch` |
|---|---|---|---|---|
| `ebook2audiobook-orpheus` (BookForge's Orpheus env) | 0.30.4 | 0.29.1 | no | no |
| `ebook2audiobook` | 0.30.4 | 0.30.5 | no | no |
| `finetune` | **0.32.0** | **0.31.3** | **yes** | **yes** |

- **mlx-lm == 0.31.3** for the batched fast path. `mlx_fastpath` is pinned, not
  feature-detected, on purpose ("a silently different `_step` is exactly the
  failure this module must not have"). Below it, `install()` refuses.
- **mlx >= 0.32.0** for decode overlap. `_mlx_decode_stream()` needs
  `mx.new_thread_unsafe_stream`; without it the engine prints
  `[ORPHEUS] MLX decode overlap unavailable ...` and decodes serially. Correct
  audio, no overlap - a documented, asserted fallback, not a failure.
- `mlx_audio` is needed only for real rendering; every test stubs it.

NB when checking these by hand: `import mlx_lm.generate as G` binds the generate
FUNCTION (mlx_lm re-exports it from `__init__`), **not** the submodule, so
`hasattr(G, 'GenerationBatch')` is always False that way. Use
`importlib.import_module('mlx_lm.generate')`.

Two places where a reader might expect a bug and there is none:

- `_mlx_eos_boost_processor`'s `len(tokens)` includes the PROMPT, while
  `_eos_boost_processor`'s does not. e2a documents this divergence in
  `mlx_fastpath.make_eos_boost` ("Kept byte-for-byte identical in behaviour,
  including the fact that `n` is `len(tokens)` over a context that ALREADY
  contains the prompt ... This module reproduces today's semantics; it does not fix
  them"). It is a known, deliberate, documented divergence and it is preserved
  exactly.
- `_convert_mlx_batch`'s two paths cap a row differently: the fresh-group path
  uses the GROUP's depth, the continuous path each row's own budget. That is
  what `tests/test_engine_mlx_continuous.py` calls "the one place the two paths
  are DELIBERATELY different". Preserved.

## 8. Behaviour differences (exhaustive)

Four, all structural, none audible:

1. **Torch is imported lazily.** e2a imported it at `orpheus.py` module scope.
   Nothing observable changes: the CUDA env is still set before torch, and the
   first function that needs torch imports it.
2. **`EngineConfig.backend` beats `ORPHEUS_BACKEND`.** e2a read only the env var;
   the constructor now offers the same override typed. `ORPHEUS_BACKEND` still
   works identically when `backend` is `None`, which is the default and what
   every current spawn produces.
3. **`EngineConfig.caps` registers at construction**, UNCONDITIONALLY, as
   `register_voice_caps(voice, caps or {})`. e2a's streaming worker made the same
   call in a separate step just after building the engine; doing it in `__init__`
   removes the window in which a loaded engine could serve one request with
   default tuning. The values, the registry and the resolution order are
   unchanged, and the audiobook worker (which passes no `caps` and uses the
   `ORPHEUS_*` env) resolves exactly what it always did.

   > **Corrected 2026-09-04 (adversarial review).** The first draft registered
   > only `if config.caps`, which broke e2a's RESET semantics. `_voice_caps` is
   > class-level and survives `_teardown_engine`, and
   > `orpheus-worker-pool.ts:864` sends `caps: {}` whenever a voice resolves to
   > no catalog model - so *load V with catalog tuning -> modelDir change ->
   > teardown -> reload V with `{}`* would have left V rendering with the
   > previous payload's `eosFloor`/`eosBoost`, as a success. Registering `{}` is
   > what empties the entry so every cap falls back to env then class default.
   > `tests/test_engine_serve_protocol.py:VoiceCapsResetTest` covers both the
   > reload-after-teardown branch and the warm `set_voice` branch.
4. **`OrpheusEngine(config)` type-checks its argument.** e2a took whatever the
   session dict was and failed later, deep inside a `.get`. The check is inside
   the same `try` that wrapped `__init__`, so the exception a caller sees is the
   `ValueError('OrpheusEngine.__init__() error: ...')` it always was; only the
   message is earlier and readable. A caller passing a real `EngineConfig` cannot
   reach it.

### Every changed message string, by cause

AST-diffed (`raise <Exc>(...)` and `print(...)` string arguments, f-string pieces
joined): **152 texts in `orpheus.py`, 30 changed, and every one of the 30 falls
into four mechanical causes.** No condition, no code path and no exception type
changed anywhere.

| cause | count | example |
|---|---|---|
| class rename `Orpheus.` -> `OrpheusEngine.` | 15 | `OrpheusEngine.convert() error:`; `OrpheusEngine.set_voice() requires a voice token`; the six `generate_batch_stream:` refusals; the four `register_voice_caps` / `register_adapter` refusals; `OrpheusEngine.convert_batch() error:` |
| non-ASCII -> ASCII (`U+2014` -> `-`, `U+2192` -> `->`) | 11 + 4 shared | `Orpheus: sentence N produced no audio - re-rendering split...`; `Orpheus MLX batch budget ... -> max R rows...`; `mlx SNAC returned N samples for frames [a, b) - fewer than...` |
| session key -> config field (`orpheus_model_dir` -> `model_dir`, etc.) | 4 (3 shared with ASCII) | `Orpheus got both model_dir (...) and adapter_dir (...)` |
| CLI flag reworded | 1 | `Orpheus adapter mode (...) needs --fine_tuned:` -> `... needs a voice token:` (narrator has no `--fine_tuned`) |

The other 122 texts are byte-identical. `engine/mlx_fastpath.py`'s messages
carry one more of the same kind: the module path it names in its "build it with
those" advice (`orpheus_mlx_fastpath` -> `narrator.engine.mlx_fastpath`).

### Small shape changes, all documented rather than hidden

- **`audio.py:_sentence_file` gained a guard.** e2a was a one-line
  `os.path.join(session['sentences_dir'], ...)`, which on a session with no
  `sentences_dir` raised `KeyError: 'sentences_dir'` from inside a path join.
  narrator raises a `ValueError` naming the situation ("this engine was built for
  in-memory generation") because the streaming server legitimately builds an
  engine with no `sentences_dir` and a reader of that traceback needs to know
  that is the case, not that a dict key was absent. Same outcome (an exception,
  no file written), better message. It is the one place this port adds a check.
- **`audio.py:trim_audio` is a port, not a transcription.** Two `return`
  statements sat AFTER `raise` in e2a's copy (lines 44 and 57, with a comment
  calling one of them "just for static analyzers"). Unreachable, so they are
  gone. Nothing else in the function moved.
- **`_reject_dir` is env-only.** See section 6(a) note below.

Two removed `EngineConfig` fields, listed so nobody re-adds them by accident:

- **`reject_dir`** - an earlier draft let it beat `ORPHEUS_REJECT_DIR`. Removed:
  e2a read the environment and nothing else, and a config field would have
  changed where evidence lands whenever the env var was unset. The env var is the
  whole interface, and `parallel-tts-bridge.ts` sets it per job.
- **`language`** - never read. `orpheus.py` has no language-dependent behaviour
  at all: the prompt is `voice: text` and every guard measures characters. An
  unread field invites a caller to set it and expect something.

---

## 9. Cut-over checklist for `orpheus-worker-pool.ts`

**NOTHING CAN SPAWN THIS WORKER YET.** `serve/worker.py` is a faithful port and
`python -m narrator.serve` runs, but `electron/orpheus-worker-pool.ts` still
spawns a SCRIPT PATH, and `narrator` is not importable from where it puts the
process. Migration step 2 does not ship until the pool is changed; `electron/`
is out of this builder's column, so this is the exact change list rather than
the change.

Everything below is `buildSpawnPlan` (`orpheus-worker-pool.ts:528-599`) and
`resolveScriptPath` (`:507-518`). Both arms need the same four edits.

### 1. The command

| | today | after |
|---|---|---|
| native | `[...py.args, '-u', scriptPath]` | `[...py.args, '-u', '-m', 'narrator.serve']` |
| WSL | `python -u ${shellQuote(scriptWsl)}` | `python -u -m narrator.serve` |

`-u` stays: the protocol is line-oriented and the pool reads it live.
`resolveScriptPath()` and its three `existsSync` fallbacks + `toUnpackedPath`
become dead - there is no script file to find, packaged or not.

### 2. Making `narrator` importable (pick ONE, per env)

The package lives at `<repo>/python/narrator`. `orpheus_stream.py` bootstrapped
itself with `sys.path.insert(0, EBOOK2AUDIOBOOK_PATH)`; `-m` cannot do that, so
the path has to come from outside:

- **`pip install -e <repo>/python` into each Orpheus env** (WSL `orpheus_tts`,
  Mac `ebook2audiobook-orpheus`, the managed Windows env). Cleanest, matches
  `docs/NARRATOR_PLAN.md` step 5 ("`pip install -e` in both envs"), and makes
  `-m narrator.serve` work from any cwd. Needs `python/pyproject.toml` (builder
  A's) and one install step per env in the component installer.
- **or `PYTHONPATH=<repo>/python`** in both arms - WSL: add
  `PYTHONPATH=${shellQuote(windowsToWslPath(pythonRoot))}` to the `export` line;
  native: add `PYTHONPATH: pythonRoot` to the `buildCondaSpawnEnv({...})` object.
  Zero install, but it must also be added to `parallel-tts-bridge.ts` when the
  audiobook worker follows, and it loses to a `.pth` already on the path.

Whichever is chosen, drop `EBOOK2AUDIOBOOK_PATH` from the spawn env: it was the
sys.path bootstrap and `narrator` never reads it.

### 3. `cwd`

Today both arms `cd` into the e2a root (native `cwd: E2A_PATH`; WSL
`cd ${shellQuote(wslE2a)}`), because `orpheus_stream.py:get_e2a_path()` used cwd
as its fallback bootstrap. `narrator.serve` reads cwd for NOTHING. Point it at
whatever the runtime should own - the WSL scratch on the WSL arm, `app.getPath`
on the native one - but it must be a directory that exists in that filesystem.

### 4. The environment: all 33 variables are preserved

Verified against `config.py` / `caps.py` / the backends. **No spawn env var
changes name, meaning, default or precedence.** Grouped by who reads them:

| variable | read by | note |
|---|---|---|
| `PYTHONUNBUFFERED`, `PYTHONIOENCODING` | Python | keep |
| `VLLM_USE_V1=0` | vLLM | keep - per-request logits processors (the EOS boost) are V0-only |
| `ORPHEUS_DISABLE_EAGER` (WSL arm) | `vllm_backend._load_vllm_engine` | keep - this is what turns CUDA graphs ON |
| `ORPHEUS_FORCE_EAGER` | same | unchanged |
| `ORPHEUS_GPU_MEM_UTIL` | same | unchanged |
| `ORPHEUS_VLLM_DTYPE` | same | unchanged |
| `ORPHEUS_BACKEND` | `engine._detect_backend` | unchanged (the new `EngineConfig.backend` is `None` from every spawn) |
| `ORPHEUS_STREAM_BATCH`, `ORPHEUS_STREAM_RAMP`, `ORPHEUS_STREAM_WARM_MAX` | `serve/worker.py` (`_warmup`, `_generate_batch_mlx_ordered`) | unchanged |
| `ORPHEUS_STREAM_GAP` | `serve/worker.py` (`finalize_audio`, the fast-start tail chunk) | unchanged |
| `ORPHEUS_SKIP_WARMUP` | `serve/worker.py:_warmup` | unchanged |
| `ORPHEUS_MLX_CACHE_LIMIT_GB`, `ORPHEUS_MLX_MEM_BUDGET_GB` | `mlx_backend` | unchanged |
| `ORPHEUS_MLX_MAX_TOKENS`, `ORPHEUS_MLX_REP_WINDOW`, `ORPHEUS_MLX_DECODE_OVERLAP`, `ORPHEUS_MLX_CONTINUOUS`, `ORPHEUS_MLX_CONTINUOUS_POOL`, `ORPHEUS_MLX_CONTINUOUS_PREFILL`, `ORPHEUS_MLX_FASTPATH` | `config.py` / `mlx_backend` | unchanged |
| `ORPHEUS_BATCH_SIZE`, `ORPHEUS_MAX_TOKENS` | `config.py` | unchanged |
| the nine caps (`ORPHEUS_TEMPERATURE`, `ORPHEUS_TOP_P`, `ORPHEUS_MIN_P`, `ORPHEUS_REP_PENALTY`, `ORPHEUS_EOS_BOOST`, `ORPHEUS_EOS_BOOST_START`, `ORPHEUS_EOS_FLOOR`, `ORPHEUS_EOS_FLOOR_RATE`, `ORPHEUS_MAX_CHARS_PER_SEC`) | `caps.VOICE_CAP_SOURCES` | unchanged, same precedence (registered cap -> env -> class default) |
| `ORPHEUS_SENTENCE_GAP` | `prompt._classify_gap` | unchanged |
| `ORPHEUS_SHORT_CHUNK_CHARS`, `ORPHEUS_SHORT_CHUNK_SECONDS_BASE`, `ORPHEUS_SHORT_CHUNK_SECONDS_PER_CHAR`, `ORPHEUS_SHORT_TAIL_TOKENS` | `config.py` | unchanged |
| `ORPHEUS_REJECT_DIR` | `guards._reject_dir` | unchanged, and now the ONLY source (section 6(a)) |
| `ORPHEUS_ASR_GATE` | `engine/asr_gate.py` | unchanged, still default OFF |
| `ORPHEUS_CHUNK_CSV` (+ the `~/.orpheus_chunk_csv` sentinel) | `guards` | unchanged |
| ~~`EBOOK2AUDIOBOOK_PATH`~~ | nothing | **remove** |

### 5. Smoke the cut-over in this order

1. `python -m narrator.serve` in the target env prints
   `{"type": "ready", "device": "cuda", "backend": "vllm"}` and exits 0 on
   `{"action":"quit"}`. (Verified by hand in WSL, 2026-09-04.)
2. Pool starts a session -> `ready` -> `loaded` for one adapter voice.
3. One `generate_batch`, buffered mode (no `stream` flag): one `batch_item` per
   `i`, then `batch_done`.
4. One `generate_batch` with `stream: true` on the played row: `batch_chunk`s
   with `seq` 0..n-1, then `batch_item{streamed:true}`.
5. `cancel` mid-batch: every row answered, `batch_done` last, worker not tainted.

Steps 2-5 are what `tests/test_engine_serve_protocol.py` already asserts against
the fake; the cut-over smoke is the same sequence against a real model.

### 6. `--fake-engine` must never reach a production spawn

The protocol-test engine is an **argv flag**, not an env var, precisely so the
pool cannot enable it by forwarding `process.env`. Do not add it to either arm.
A worker running with it prints a five-line banner to stderr at startup and at
every `ready`/`loaded`.

## 10. Could not verify

- ~~The three MLX test ports have never been executed~~ **RESOLVED 2026-09-04**:
  run on the Mac in both `ebook2audiobook-orpheus` (43 tests, OK, 8 skipped -
  the env is below both API floors, section 7a) and `finetune` (43 tests, OK,
  1 skipped - at the mlx-lm pin, so every install and thread-placement case
  actually EXERCISES). The MLX backend's batched logits math, the decode-overlap
  hand-off, continuous batching and every `install()` refusal are now proven, not
  merely imported. They still SKIP on Windows and in WSL `orpheus_tts` (no mlx).
- **No MLX model has been loaded.** The tests stub `mlx_audio`'s llama module and
  fake the BatchGenerator, so `_load_mlx_engine`, `_patch_mlx_prompt_framing`,
  `_generate_mlx` and the MLX half of `adapters.py` (`_mlx_adapter_plan` /
  `_apply_mlx_adapter`) are still import-checked only - they need real weights.
- **No GPU render** - the GPU was held by another job's lock
  (`%APPDATA%\BookForge\external-gpu-job.lock`, `ds_ad4s raw-verbatim
  train+gate chain`) at 13.2 GB / 94-98% / 76 C, so the smoke guard was not met
  and nothing was run on it.
- **The cut-over itself** (section 9) is untested end to end: no BookForge spawn
  has ever reached this worker, because `orpheus-worker-pool.ts` still points at
  a script path. `python -m narrator.serve` reaching `ready` in WSL is as far as
  it has been taken.
- **The vLLM arm of `serve/worker.py:_generate_audio_batch`** is not covered by
  the protocol tests: `FakeEngine` reports `backend='transformers'`, so the
  `TokensPrompt` / `_vllm_sampling_params` / per-row `lora_request` list path is
  exercised only by a real model. The fast-start path IS covered, because it goes
  through `generate_batch_stream` on either backend.

## 11. Review history

**2026-09-04, adversarial AST review** (94 functions diffed, 61 code-identical,
32 differences all benign; protocol identical). Seven findings, all addressed in
this worktree:

| # | finding | fix |
|---|---|---|
| F1 | `import narrator.engine` imported torch on Windows (the cudart lookup ran at `vllm_backend` import), and the lazy-import test masked it by inheriting `VLLM_CUDART_SO_PATH` from earlier test modules - alone it failed with 18 errors | `cuda_env.resolve_vllm_cudart()` split out and called from `_load_vllm_engine` between `import torch` and `from vllm import LLM`; every probe subprocess now gets a `VLLM_*`/`ORPHEUS_*`-scrubbed env, plus a regression test that the import leaves the variable unset |
| F2 | first-load path registered caps only `if config.caps`, losing e2a's reset | unconditional `register_voice_caps(voice, caps or {})`; `VoiceCapsResetTest` covers the reload-after-teardown and warm-switch branches; section 8.3 corrected |
| F3 | nothing tested a cancel DURING a batch | `_assert_batch_closed` (batch_done last + exactly one message per `i` + every row answered) applied to every batch test, plus `test_cancel_DURING_a_batch_still_closes_it` and `test_a_batch_after_a_cancel_is_not_suppressed`; the fake got a per-row delay so a cancel has somewhere to land |
| F4 | nothing can spawn `python -m narrator.serve` | section 9, the cut-over checklist (no `electron/` change made) |
| F5 | `NARRATOR_FAKE_ENGINE=1` could put the production entry point into sine-tone mode via a forwarded env var | replaced with the `--fake-engine` argv flag + a stderr banner at startup and at every `ready`/`loaded` |
| F6 | section 8 "exhaustive" was not | `_reject_dir` restored to env-only and `EngineConfig.reject_dir`/`language` removed; the `_sentence_file` guard, `trim_audio`'s two dead returns and all 30 changed message strings now listed (AST-diffed, four mechanical causes) |
| F7 | re-verify | suite re-run both ways; nothing outside column E touched |

**2026-09-04, Mac run of the MLX suite** (coordinator: 103 tests, 2 failures,
6 errors). Both were **environment facts, not port regressions**, and both are
now asserted contracts instead of holes:

| what failed | cause | proof | fix |
|---|---|---|---|
| 6 errors, all `MlxFastPathInstallTest`: `ImportError: cannot import name 'GenerationBatch'` | `GenerationBatch` exists only at mlx-lm 0.31.3 (the pin); the test env has 0.29.1, so `install()` is unreachable | measured across all three Mac envs (section 7a); e2a's `install()` has the identical import ordering, so it errors the same way - confirmed by running it directly | `MlxFastPathInstallTest` skips below the pin, naming the version; new `MlxFastPathPinTest` asserts install() never returns silently, in every env, and pins the ImportError-vs-refusal defect (section 7) |
| 2 failures, `test_rows_are_written_while_the_batch_is_still_generating` and `test_the_split_between_the_threads` | `mx.new_thread_unsafe_stream` arrived in mlx 0.32.0; the env has 0.30.4, so `_mlx_decode_stream()` returns None and the engine DECLINES to overlap - it printed `[ORPHEUS] MLX decode overlap unavailable ...` in the failing run | **e2a's own `tools/test_mlx_decode_overlap.py`, run unmodified in the same env, fails the same four thread-placement checks and passes every correctness check**; and the port's `_mlx_decode_stream` + overlap-decision block are byte-identical to e2a's (diffed, 9 and 19 lines) | the two thread-placement tests skip without the stream; new `test_it_degrades_to_serial_without_a_cross_thread_stream` asserts the fallback either way - the log line and no decoder thread when absent, a live decoder thread when present, identical results in both |

---

## 12. The engine-interface extraction (2026-09-04) - what moved and what is new

`docs/NARRATOR_PLAN.md` ("Engine interface") designed a seam shaped by TWO
measured engines - Orpheus/SNAC and Higgs v2's 8-codebook delay pattern - and one
rejected (Llasa-8B). This is what the extraction actually did.

**Rule of the move: no Orpheus METHOD BODY changed.** Not "two lines" - that
was wrong and is corrected here. What actually changed in the moved files:

| file | change |
|---|---|
| `orpheus/engine.py` | ONE import (`from .interface import OrpheusInterfaceMixin`) and the `class OrpheusEngine(...)` statement, which gained that mixin |
| `orpheus/__init__.py` | ~15 lines: the package docstring's opening (it is now the Orpheus package, not `narrator.engine`) plus the `interface` imports and three `__all__` entries |

Every other moved file is byte-identical (`git diff -M` shows pure renames), and
no method body moved anywhere. Proof is the unchanged test suite: **147 engine
tests** on the Windows interpreter (43 skipped - the MLX ones) and the same 147
in WSL `orpheus_tts`, both OK, with the 103 that existed before the extraction
untouched. The Higgs suites add **163** more, on both interpreters.

### 12.1 Old path -> new path

| before | after |
|---|---|
| `engine/__init__.py` | `engine/orpheus/__init__.py` (a NEW `engine/__init__.py` re-exports it - see 12.4) |
| `engine/adapters.py` | `engine/orpheus/adapters.py` |
| `engine/asr_gate.py` | `engine/orpheus/asr_gate.py` |
| `engine/audio.py` | `engine/orpheus/audio.py` |
| `engine/caps.py` | `engine/orpheus/caps.py` |
| `engine/config.py` | `engine/orpheus/config.py` |
| `engine/cuda_env.py` | `engine/orpheus/cuda_env.py` |
| `engine/engine.py` | `engine/orpheus/engine.py` |
| `engine/errors.py` | `engine/orpheus/errors.py` |
| `engine/guards.py` | `engine/orpheus/guards.py` |
| `engine/mlx_backend.py` | `engine/orpheus/mlx_backend.py` |
| `engine/mlx_fastpath.py` | `engine/orpheus/mlx_fastpath.py` |
| `engine/prompt.py` | `engine/orpheus/prompt.py` |
| `engine/registry.py` (the `loaded_tts` cache) | **`engine/orpheus/registry.py`** - the name `engine/registry.py` is now the ENGINE registry (12.3) |
| `engine/sampling.py` | `engine/orpheus/sampling.py` |
| `engine/snac.py` | `engine/orpheus/snac.py` |
| `engine/text.py` | `engine/orpheus/text.py` |
| `engine/transformers_backend.py` | `engine/orpheus/transformers_backend.py` |
| `engine/vllm_backend.py` | `engine/orpheus/vllm_backend.py` |

Done with `git mv`, so `git log --follow` and rename detection still work. Every
intra-package import was already relative (`from .snac import ...`), so not one
import line inside the moved files changed either.

### 12.2 The one addition to the Orpheus port: `engine/orpheus/interface.py`

`OrpheusEngine` gained ONE base class, `OrpheusInterfaceMixin`, and with it
`ENGINE_ID`, `pads`, `edge_fade`, `resolve_load_voice()`, `backend_spec()`,
`codec()`, `budget()` and
`stop_policy()`. All of them read constants and lookups the engine already had:

- `OrpheusCodec` wraps `SnacMixin._tokens_to_audio` and `WindowedFrameEmitter`
  and states the geometry (7 tokens per frame, 2048 samples per frame,
  24000/2048 = 11.71875 frames/s, `trim_frames` 0).
- `OrpheusBudget.max_chars_per_sec` IS `_max_chars_per_sec`;
  `max_total_tokens(p)` is `p + MAX_AUDIO_TOKENS`.
- `stop_policy()` reads the eight per-voice caps through `_voice_cap`, so it is
  a VIEW of the live three-step lookup (registered cap -> `ORPHEUS_*` env ->
  class default), never a copy taken at construction.

**`OrpheusBudget.max_chars` refuses rather than guessing.** `maxChars` rides the
catalog payload but `register_voice_caps` accepts and IGNORES it by name (it is
a prep concern), so the engine has never stored it. The Budget reads it from the
`EngineConfig.caps` the engine was constructed with, for the voice that config
named, and raises for anything else. Deriving it from the token cap would give
~836 characters where the catalog says ~450. When the chunk packer lands (plan
step 4) and the catalog becomes `engines/*.json` keyed on (engine, voice), this
becomes a registry read and the refusal goes with it.

### 12.3 New: `engine/protocol.py` and `engine/registry.py`

`protocol.py` (no torch, no backend of any kind): `Codec`, `Budget`, `Engine`
and `ServedBackend` as `runtime_checkable` Protocols; `StopPolicy`,
`BackendSpec`, `SpeechRequest`, `ReferenceClip` and the `VoiceRef` tagged union
(`TokenVoice` | `ClipsVoice` | `DescriptionVoice`) as frozen dataclasses.
`tests/test_engine_protocol.py` asserts conformance with `isinstance`, pins the
member list, and asserts the two engines DISAGREE where the plan says they must.

`registry.py` maps an engine id to a pair of FACTORIES - `'orpheus'` and
`'higgs-v2'` - so "which engines exist?" is answerable on an interpreter with no
backend installed. An unknown id raises, naming the id and the known ones; it
never defaults.

### 12.4 Compatibility aliases (and how to remove them)

`render/worker.py` imports `..engine.config`, and the engine test modules name
`narrator.engine.snac`, `narrator.engine.mlx_fastpath` and every module in
`tests/test_engine_lazy_imports.py`'s list. Both are outside this column, so
`engine/__init__.py` binds the old dotted names to THE SAME module objects
(`narrator.engine.snac is narrator.engine.orpheus.snac`), plus a package
`__getattr__` for `mlx_fastpath`, which must not be imported eagerly (its module
scope does `import mlx.core`). `asr_gate` is imported explicitly for the same
reason in reverse - nothing else pulls it in, and the lazy-import test imports it
by dotted path in a fresh subprocess.

CANONICAL PATH IS `narrator.engine.orpheus.<module>`; everything inside
`engine/` and `serve/` already uses it. **To remove the aliases:** re-point
`render/worker.py:engine_config_from` (`from ..engine.orpheus.config import
EngineConfig`) and the module lists in `tests/test_engine_lazy_imports.py`,
`tests/test_engine_stream_window.py` and `tests/test_engine_mlx_fastpath.py`,
then delete the `_MOVED_TO_ORPHEUS` block and `__getattr__`. `OrpheusEngine` and
`EngineConfig` stay exported from `narrator.engine` regardless - that is the
one-engine caller's front door.

### 12.5 New: `engine/higgs/` - two Higgs engines, one of them shipped

**RULING, Owen, 2026-09-04 evening: the second engine is Higgs v3. Higgs v2 is
DROPPED** - "basically just Orpheus and we know Orpheus better". The v2 code
built earlier that day is KEPT, deliberately, as INTERFACE SCAFFOLDING under the
registry id `higgs-v2-scaffold`: a complete, tested reference implementation of
`engine/protocol.py` for an engine that is not SNAC, emits no pads and carries
its voice as clips in a chat history. It proves the seams fit something that is
not Orpheus, in-process, with no server in the way. Nothing renders a book with
it, and no GPU smoke is owed for it. Its id says so on purpose.

#### 12.5a `higgs-v2-scaffold` (NOT SHIPPED) - what it demonstrates

Built from the MEASURED campaign
`E:\training\_campaigns\2026-09-01-cod-full-rebuild\higgs\` (2026-09-04):
`render_v2.py` (the render path, copied - not the model card), `smoke_v2.py`
(the processor probe), `v2_pokemon_para_log.json` (the nine-chunk audition),
`HIGGS_NOTES.md` (the verbatim chat template, the token ids, the licences) and
`HIGGS_V3_LEVERS.md` + `work/` (the v3 lever sweep, DESIGN input only).

| module | what it is |
|---|---|
| `higgs/config.py` | `HiggsConfig`, `HiggsDefaults` (every measured number with its measurement), `HiggsBudget`, `higgs_stop_policy`, the voice document reader, and the load-message mapping |
| `higgs/codec.py` | the six-step decode as pure numpy up to the tokenizer call: generated span, delay-pattern revert, sentinel content trim, clip |
| `higgs/prompt.py` | `build_conversation` - render_v2.py's `build_conv`, turn for turn - plus the recorded special-token ids |
| `higgs/transformers_backend.py` | the in-process load + `generate` + the audio-decoder callable |
| `higgs/engine.py` | `HiggsEngine`, implementing `Engine` |
| `higgs/v3_served.py` | Higgs v3 as a SERVED backend - designed, every call raises |

Measured facts the code encodes, each with its consequence:

- **24 kHz mono, 8 codebooks x 1024 + stream bos/eos 1024/1025, 25 LM steps per
  second of audio** (delay pattern). 960 samples per frame.
- **Decode = `frames - 7` (the delay diagonal) AND a trailing sentinel run
  trimmed BY CONTENT.** The second trim is the fix for "a stray syllable after
  each sentence": the ramp-down sentinels smear across the last seven frames,
  the shipped code substitutes them with codec code 0 - which decodes to sound -
  and trims exactly one frame. Trimming by content cannot eat real speech and
  must run BEFORE the substitution; `tests/test_higgs_codec.py` pins that order,
  because doing it the other way round looks identical and is a no-op.
- **NO pads and NO fades at either end.** `HiggsEngine.pads = False`, so the
  manifest's `gapBefore`/`gapAfter` are LIVE for this engine and the assembler
  realizes them. `edge_fade = EdgeFade(10, 25)`: even content-trimmed, an edge sits near
  -30 dB and clicks on a join; the fade takes it to -45..-48 dB.
- **EOS fires unaided** - 9/9 chunks of 132-898 chars, zero runaways, zero cap
  hits. So `eos_reliable=True`, `resplit_on_cap=False`, and there is no boost,
  no floor, no ratchet and no ladder. `coverage_check='asr'` instead: a DURATION
  RATIO IS NOT A COVERAGE PROXY on this family (a v3 chunk measured 0.99 while
  dropping 22 % of its text and inserting filler). The ASR gate is a documented
  HOOK; nothing implements it yet.
- **The voice is reference clips WITH BOOK-EXACT TRANSCRIPTS** in the chat
  history. `ReferenceClip` refuses a clip without one, and its docstring carries
  the law (corpus row or narration copy, never a transcription) and the measured
  guidance: same-book clips beat cross-book by +0.076 ECAPA cosine, a second
  clip adds +0.012, self-ceiling 0.766. Because clips cannot ride a command
  line, they come from a JSON document named by `NARRATOR_HIGGS_VOICES`; an
  unset variable is a refusal, not a search.
- **Batches are SERIAL** (`convert_batch` renders one chunk at a time) and there
  is **no streaming** (`generate_batch_stream` emits whole rows at retirement,
  and `HiggsCodec.streaming_decoder()` returns None). A delay-pattern codec's
  window is incomplete in its last seven frames by construction and its
  ramp-down only exists once generation has finished, so a windowed decode is
  not sound; faking one would ship audio the listener has already heard.
- **Licence: Boson Higgs Audio 2 Community License.** Usable at our scale, but
  it obliges the "Built with Higgs Materials..." attribution plus Meta Llama 3's,
  and ANY FINE-TUNE WE SHIP MUST CARRY "Higgs Audio 2" IN ITS NAME.

#### 12.5b `higgs-v3` - THE second engine, a SERVED backend

`higgs/v3_served.py` (the HTTP client, the launch, the request/response) and
`higgs/v3_engine.py` (the `Engine` surface). Higgs TTS 3, 4B, Qwen3 backbone,
served by **vllm-omni 0.28.0** in WSL env `higgs3` - it has no HF modeling class
and its torch 2.13+cu130 cannot share an env with Orpheus's vLLM 0.7.3, so it is
a separate process reached over HTTP. This is what `BackendSpec.kind ==
'served'` exists for.

Sources, all measured 2026-09-04: `serve_v3.sh` (the launch line, invoked -
narrator does NOT write its own: the CUDA_HOME / flashinfer workarounds live
there), `work/render_final.py` + `work/confirm.py` (the request body),
`work/patch_vllm.py` + `work/patch_tail_trim.py` (the two patches),
`HIGGS_V3_LEVERS.md` (the lever sweep), `work/added_vocab.json` (the control
tokens), `work/refs/manifest.json` (the references), `work/serve_v3c.log` (the
routes).

| fact | consequence in the code |
|---|---|
| cloning WORKS - the HTTP 400 was a one-line vLLM 0.28 bug rejecting the -100 audio placeholder; ECAPA cosine 0.704 vs a 0.766 narrator self-ceiling | v3 is usable as a voice; `patch_vllm.py` is a hard prerequisite and is named in the unreachable-server message |
| sampling is NOT a top-level field - pydantic drops `temperature`/`top_p`/`top_k` silently | `build_request_body` puts them in `extra_params` and NOWHERE else; empty means the server's own stage-0 defaults (1.0 / 0.95 / 50), which is what the delivered render used and what Owen asked for |
| an out-of-vocabulary control token is READ ALOUD and collapses the render (coverage 0.000, pitch std 0.28 st, cosine 0.05) | `ALLOWED_CONTROL_TOKENS` is the 45-token vocabulary read off `get_added_vocab()`, and `validate_control_tokens` runs on EVERY request. There is no `<|emotion:neutral|>`, no `<|emotion:calm|>`, the pause token is `<|prosody:long_pause|>`, and `<|scene_desc_*|>` is v2-only |
| exactly ONE reference, capped at 30 s TOTAL (42 s -> HTTP 400) | `reference_for` refuses a multi-clip voice with the instruction (pre-join the clips, 0.35 s apart, transcripts in the same order); `check_reference_budget` refuses before a server is ever started |
| `<= 600` chars is safe; 900 drops the tail REPRODUCIBLY and cloning does not fix it | `MAX_CHARS = 600` (placeholder until the catalog carries it; the delivered render used 300) |
| a duration ratio of 0.99 hid 0.778 coverage with a 26 % insert rate | `StopPolicy.coverage_check = 'asr'` - a HOOK with a name; nothing implements the check yet |
| the server ALREADY trims the sentinel tail by content (`patch_tail_trim.py`, read to confirm) | `HiggsV3Codec.decode()` REFUSES: there are no tokens on this side, and a second trim would eat speech. The codec reports geometry only |
| a decoded chunk still ends on a hard sample boundary | `edge_fade = EdgeFade(10.0, 25.0)` - ASYMMETRIC, applied by the ASSEMBLER, never here (12.10) |
| `--max-model-len 8192`; 27 s of reference is ~685 positions | `max_total_tokens` is that ceiling and refuses a prompt that fills it |
| vllm-omni cannot load a LoRA at runtime - no adapter flags, and the talker does not implement `SupportsLoRA` | every fine-tuned voice is a MERGED CHECKPOINT the server runs on (`CHECKPOINT_STRATEGY`); `lora-modules` is refused by name. See 12.8c |
| the endpoint used is the buffered POST /v1/audio/speech | `generate_batch_stream` emits whole rows at retirement and `streaming_decoder()` returns None. vllm-omni also exposes a WebSocket `/v1/audio/speech/stream`; nothing here has measured it |

`ATTACH` vs `LAUNCH`: `NARRATOR_HIGGS3_URL` attaches to a server somebody else
started (`start()` a no-op, `stop()` refuses to kill it);
`NARRATOR_HIGGS3_SERVE_SCRIPT` names their `serve_v3.sh` and narrator runs it.
Neither set is a refusal naming both. `serve_v3.sh` takes NO arguments (it
`exec`s a fixed command line), so `extra_args` is refused with the two ways
round it - the script gains a `"$@"` (their file) or the operator launches by
hand and narrator attaches.

**Response format, stated as an assumption.** With `"response_format": "wav"`
the endpoint returns a WAV FILE as the raw body - that is what every render
script does (`sf.read(io.BytesIO(r.content))`), and it is now also what the GPU
smoke observed. There is still no byte-level capture in the campaign; when one
lands in `<campaign>/higgs/captures/`, `tests/test_higgs_v3.py`'s
script-derived expectations are what it replaces, and `decode_response` is the
single place any correction goes.

### 12.10 The streaming wire: trim, gap, rate, and the `loaded` line

`serve/worker.py:finalize_audio` used to do three things to every clip
unconditionally. Two of them are Orpheus's, and one is the client's:

- **The trim is ORPHEUS's** and now runs only for a `pads=True` engine. Orpheus
  bakes its lead/trail silence in and its end-pause is long enough to hear as a
  stall. Higgs emits bare speech, so the same 0.01-threshold trim would cut into
  a quiet final consonant with no padding in front of it to absorb the cut.
- **The 0.3 s gap is appended for EVERY engine, deliberately.** This is the
  decision the review asked for. `pads` says who owns the silence INSIDE a chunk
  file for ASSEMBLY; the streaming wire is a different contract, where the
  player concatenates chunks with no gap of its own and the worker is the only
  thing that can put one between two sentences. Dropping it for Higgs would make
  every streamed sentence run into the next. The audiobook path never passes
  through here - it writes chunk files, and the assembler realizes the
  manifest's gaps.
- **The rate is the LOADED ENGINE's**, not `DEFAULT_SAMPLERATE`. Both shipping
  engines are 24 kHz, so no byte on either path changes today; what it prevents
  is the next engine mis-timing every cue in a session.

The `loaded` message gained four ADDITIVE fields - `engine`, `sampleRate`,
`pads` and `edgeFadeMs: {in, out}` - so the pool can read the engine's edge
contract instead of assuming Orpheus's. The existing reader takes `voice` and
`backend` and ignores the rest, so nothing on the wire breaks.

`edge_fade` is an `EdgeFade(in_ms, out_ms)`, not one float: Higgs's fade is
ASYMMETRIC (10 in / 25 out) because a chunk ends on a decay the ear does not
expect. The values must agree with `narrator/assemble/engine_profiles.py` -
assembly's own copy of the table, which exists because assembly runs without an
engine to ask - and `tests/test_engine_protocol.py` asserts they do.

### 12.11 A worker that cannot render must not handshake

Found on the Mac, 2026-09-04: `detect_backend()` swallowed every exception and
"reported unknown", so an ImportError - which means NO engine will ever load in
that process - still produced `{"type":"ready","device":"mlx"}`. The pool saw a
healthy handshake and every generate answered "Model not loaded", forever.

`detect_backend()` now raises, `main()` turns that into **exit 3 with the reason
on stderr and no `ready` line**, and the same path catches an unservable
`NARRATOR_ENGINE`. A backend NAME the worker does not recognise still returns
None - the engine loaded and answered, we simply have no guard calibrated for
what it said, which is a different thing from a dead worker.

The MLX test modules had the same shape of bug and are fixed with it: their
`except Exception` around the mlx import reported a narrator LAYOUT ImportError
as "mlx is not installed (Mac only)" and skipped 25 tests on the one machine
that can run them. They now catch only an ImportError naming `mlx`/`mlx_lm`/
`mlx_audio` and re-raise anything else.

### 12.6 `NARRATOR_ENGINE`, and what it does NOT change

`serve/worker.py` now picks its engine from `NARRATOR_ENGINE` (default
`orpheus`), through the registry, in `_engine_class()` / `_engine_config()`.
`_generate_audio` gained ONE branch: a backend that is none of Orpheus's three
is a SERVED engine, and one sentence is `engine.render_audio(text)` - no token
stream, no re-render ladder (v3 stops on its own; dropping a long chunk's tail
is a packer concern, not a retry). An engine on that branch with no
`render_audio` is a named error, not a fallback.
Every one of the 33 spawn environment variables in section 9.4 keeps its name,
meaning, default and precedence; `NARRATOR_ENGINE` is the 34th and its absence
is exactly today's behaviour. `--fake-engine` picks a fake PER ENGINE
(`serve/fake_engine.py:fake_engine_class`), so a Higgs protocol test sees
`pads = False` and 960-sample frames.

The rest of `serve/worker.py` is still Orpheus-shaped: `VALID_VOICES`, the
merged/adapter/base load modes, `set_voice`, `_apply_voice_caps` and the
per-request LoRA path in `_generate_audio_batch`. Higgs answers the ones it
needs and REFUSES the ones it cannot honour (`baseDir` and any Orpheus `caps`
payload, by name, in `higgs_config_from_worker_kwargs`) rather than accepting a
payload that would look applied and do nothing. Making that half of the worker
engine-agnostic is a separate change and is not in this one.

### 12.7 The GPU smoke (Higgs v3), 2026-09-04 19:23-19:29

Run under the shared guard: `%APPDATA%\BookForge\external-gpu-job.lock` was
ABSENT, WSL `nvidia-smi` read 1.77 GB with no compute apps; the lock was taken as
`narrator-H smoke <ISO>`, and released after, with the server verified stopped
(`pgrep -f 'vllm-omni serve'` empty, 1.75 GB).

narrator's OWN path, end to end: `registry.engine_class('higgs-v3')` ->
`HiggsV3Config(load_voice('deathstalker'))` -> `HiggsV3Engine.__init__` ->
`HiggsV3ServedBackend.start()` (which ran THEIR `serve_v3.sh`) -> `wait_ready`
-> `render_audio` -> wav -> `cleanup()`.

```
engines: ['higgs-v2-scaffold', 'higgs-v3', 'orpheus']
reference: work/refs/refs x2, 27.42 s, one pre-joined clip
[HIGGS3] launching: bash <campaign>/serve_v3.sh
READY_SEC 297.0
backend_spec: BackendSpec(kind='served', name='vllm-omni', version='0.28.0',
              base_url='http://127.0.0.1:8095', ...)
pads False   edge_fade EdgeFade(in_ms=10.0, out_ms=25.0)
stop_policy: max_new_tokens=2150 eos_reliable=True resplit_on_cap=False
             max_chars_per_sec=20.0 coverage_check='asr'
             levers={temperature 1.0, top_p 0.95, top_k 50, repetition_penalty 1.0, seed 42}
{"wav": "/mnt/c/tmp/narrator-smoke/higgs3-one.wav", "samples": 111360,
 "seconds": 4.64, "sample_rate": 24000, "gen_sec": 43.09, "rtf": 9.286,
 "chars": 78, "chars_per_sec": 16.81, "cap_frames": 410}
SMOKE_OK
```

Two numbers to read carefully:

- **READY_SEC 297, not the documented ~55 s.** That is a COLD start of a server
  whose weights were not in the page cache, on a box that had just been idle;
  55 s was measured on a warm repeat and a third run took 146 s.
  `HiggsV3Defaults.READY_TIMEOUT_SECONDS` is **900** for exactly this spread; it
  was 300 when this smoke ran, which the smoke overrode to 420 - a value that
  would have been a coin flip on the slowest of the three.
- **RTF 9.29 is not a throughput measurement.** It is ONE 78-character sentence:
  the per-request prefill of a 27 s reference and the first CUDA graph are
  amortised over 4.6 s of audio. The campaign's own RTF caveat applies too
  (1.12-3.64 across a session under CPU contamination). Re-measure over a
  paragraph on an idle box before comparing v3 to anything.

`chars_per_sec 16.81` sits right on the delivered render's ~16.5 and above the
real narrator's 15.0 - the "consistently slightly rushed" reading the lever
notes describe, reproduced from narrator's own client.

### 12.8 Owed at cut-over

- **The two Higgs v3 site-packages patches are a managed-env recipe.**
  `work/patch_vllm.py` (allow the -100 audio placeholder through vLLM 0.28's
  negative-id check - without it EVERY clone request is HTTP 400) and
  `work/patch_tail_trim.py` (the sentinel content trim) edit files inside the
  `higgs3` env's `site-packages` and MUST BE RE-APPLIED AFTER ANY PIP UPGRADE
  THERE. They are not narrator's code and cannot be shipped as narrator's code;
  they belong in the component installer's recipe for that env, next to the
  `CUDA_HOME` / `VLLM_USE_FLASHINFER_SAMPLER` / `--attention-backend FLASH_ATTN`
  launch facts recorded in `higgs/v3_served.py`.
- `pip install -e python/[orpheus]` or `python/[higgs-v3-server]` into the
  matching env - the groups are mutually exclusive by design (the v2 scaffold's
  is `[higgs-v2-scaffold]`, and installing it is only for running that
  reference implementation against a model); see `python/pyproject.toml`. NB
  the v3 CLIENT needs none of them: numpy, soundfile and urllib.
- A `higgs3` extra in `python/pyproject.toml` pins the SERVED env
  (torch 2.13.0+cu130, vllm 0.28.0, vllm-omni 0.28.0). It is a THIRD mutually
  exclusive group: it can share an env with neither Orpheus nor the v2
  scaffold.
- The v3 CLIENT needs nothing but numpy, soundfile and the standard library
  (urllib), on purpose - so the engine can be driven from the Orpheus env, or
  from a plain interpreter, while the model runs in `higgs3`.
- No Higgs **v2** model has ever been loaded from narrator's code, and none is
  owed: v2 is scaffolding. Higgs **v3** rendered a sentence end to end - see
  12.7.

### 12.8a One writer for every chunk file (ruled 2026-09-04, after the Mac run)

**e2a's `torchaudio.save(..., format='flac')` is gone from the write path.** It
was replaced, in `engine/orpheus/audio.py:AudioMixin.write_chunk_file`, by
`soundfile.write(path, audio_float32, samplerate, subtype='PCM_16')` - on every
backend (vLLM, MLX, transformers) and in every engine. This is a DELIBERATE
DEVIATION from the port, for two measured reasons:

1. **`torchaudio.save` is wheel-dependent.** On current wheels (torch 2.14 /
   torchaudio 2.11) it routes through TorchCodec and needs the FFmpeg dylibs.
   The Mac MLX run hit "TorchCodec is required" on EVERY SENTENCE until ffmpeg
   was conda-installed. A renderer's file writer must not depend on a media
   stack that may or may not be in the environment.
2. **It is bit-depth-unstable.** The same call produced **PCM_24** there and
   **PCM_16** under WSL/vLLM. Mixed bit depths across one session's chunks are
   exactly what ffmpeg's concat demuxer drops frames on, SILENTLY - the failure
   that has eaten sentences out of an assembled book before.

`_write_silence` and the post-mortem reject clips (`guards.py:_keep_reject_locked`)
go through the same writer; the container comes from the path's own extension
(`.flac` for chunks, `.wav` for rejects) and the subtype is always stated, never
inferred. **Reading is unchanged** - resume and `trim_audio` still use the ported
torch path. `tests/test_engine_protocol.py:ChunkWriterTest` asserts a written
FLAC reads back 24 kHz mono PCM_16 with the exact sample count, and AST-checks
that nothing under `engine/orpheus/` calls `torchaudio.save` any more.

### 12.8a-ii The minimal Mac (MLX) recipe, after the writer change

Measured by the Mac validation run, 2026-09-04. The run itself PASSED end to
end - 133/133 sentences rendered, fast start clean, 5.14x realtime - and these
are the pins it needs:

```
mlx        >= 0.32.0     mx.new_thread_unsafe_stream (decode overlap; below it
                         the engine degrades to serial, loudly)
mlx-lm     == 0.31.3     THE fast-path pin. mlx_fastpath is version-pinned, not
                         feature-detected; GenerationBatch exists only here
mlx-audio  == 0.4.8      THE ONLY WORKING VERSION. 0.5.1 cannot render Orpheus:
                         mlx_audio/lm/generate.py `_eos_ids` does
                         `set(tokenizer.eos_token_ids)` on an int (128009) under
                         transformers 5.x -> TypeError on EVERY generate. 0.3.x
                         drags mlx-lm below the fast-path pin. 0.4.8 requires
                         only mlx>=0.31.1, so all three coexist
torch      >= 2.5        still required - see below
snac, transformers       as the CUDA recipe
```

**torchaudio, torchcodec and ffmpeg are NO LONGER NEEDED** on this path. That is
what the soundfile writer (12.8a) bought: the only thing that pulled them in was
`torchaudio.save`, in the chunk writer and the reject-clip writer, and both now
go through `soundfile`. `_save_audio`'s own arithmetic (a max, a scale, two
concatenations) moved from torch to numpy with it.

**torch itself does NOT drop out**, and this is stated plainly rather than
claimed away: `trim_audio` - the read side the ruling preserves - is torch, and
`_speech_rate` calls it for every chunk to compute the chars/sec guard;
`_cleanup_memory` uses `torch.cuda` / `torch.mps`. So the Mac recipe still
installs torch, but the CPU/MPS wheel with no media stack. Verified by AST over
`engine/orpheus/**`: `torchaudio` now appears only in `asr_gate.py` (default
OFF, not on the render path).

### 12.8b `DefaultVoice`: the model's own voice is a shape, not an absence

The app catalog ships a `default` Higgs v3 voice - no reference audio, which v3
serves happily - and narrator refused it, because it arrived as a `ClipsVoice`
with zero clips and `ClipsVoice` requires at least one. **That rule is right and
stays**: a clone whose references went missing must be an error, never a silent
downgrade to a different narrator. So "no reference" became its own member of
the `VoiceRef` union.

`DefaultVoice(kind='default')` carries `name`, `adapter_dir` and the two tuning
fields. It sends **no `references` key at all**; the 30 s cap and the transcript
law have nothing to apply to. `adapter_dir` is on it because a FINE-TUNE needs
no reference clips either - its weights are the voice and its prompt is
text-only - which is the third document shape the loader now accepts.

> **Deviation, stated.** The review asked for "no fields beyond kind/name". A
> clip-less ADAPTER entry - which the same instruction asks the loader to accept
> - cannot then be represented at all, and the two tuning fields are what every
> voice carries. So `DefaultVoice` has four fields, not one. Flagged rather than
> silently widened.

Three document shapes, all tested through the real loader and the real request
builder (`tests/test_higgs_v3.py:VoiceDocumentShapesTest`):

| entry | voice | request |
|---|---|---|
| `{"clips": [...]}` | `ClipsVoice` | one `references` entry |
| `{"kind": "default"}` | `DefaultVoice` | no `references` key |
| `{"kind": "adapter", "adapterDir": ...}` | `DefaultVoice` with `adapter_dir` | no `references` key |

`{"clips": []}` is REFUSED and names `kind: 'default'` as what to say instead.
An entry with no `clips`, no `adapterDir` and no `kind` is refused with what the
default voice costs (12 % of the narrator ceiling) in the message.

`max_chars_source` has a CLOSED vocabulary - `catalog` | `placeholder` |
`length-sweep` (`protocol.MAX_CHARS_SOURCES`) - and is required whenever
`max_chars` is set: a number whose provenance is unknown is one nobody can
decide whether to trust.

### 12.8c Fine-tuned Higgs voices are MERGED CHECKPOINTS

Measured by the training side, 2026-09-04 (`HIGGS_FIELD_NOTES.md`):

> **vllm-omni cannot load a LoRA at runtime.** It exposes no adapter flags at
> all, and its `higgs_audio_v3` talker class does not implement `SupportsLoRA`.

So there is no runtime adapter and no per-request adapter. Every fine-tuned
Higgs voice ships as a MERGED CHECKPOINT DIRECTORY (~8.5 GB, Boson's layout) and
the server is started ON that directory. The LoRA is the archival artifact;
merging is a CPU step outside narrator.

What that changed here:

- `ADAPTER_STRATEGIES` is gone. There is one strategy, `CHECKPOINT_STRATEGY =
  'checkpoint'`; `check_strategy` refuses `lora-modules` BY NAME citing
  `SupportsLoRA`, and `merged-dir` as its old name.
- The voice document's shape is `{"kind": "checkpoint", "checkpointDir": ...,
  "maxChars": N}`, and `adapterDir` is refused by name with what to write
  instead. `ClipsVoice.adapter_dir` / `DefaultVoice.adapter_dir` became
  `checkpoint_dir`.
- The served backend is KEYED ON ITS CHECKPOINT: a request for another voice is
  a server RESTART (~55 s warm, up to ~300 s cold), and
  `HiggsV3Engine.set_voice` refuses in place with that in the message.
- **Which checkpoint is running cannot be discovered** - `/v1/models` reports
  the served NAME (`higgs-v3`), not the path, and `serve_v3.sh` `exec`s a
  hard-coded snapshot, so narrator can neither read it nor choose it. The
  operator states it through `NARRATOR_HIGGS3_CHECKPOINT`. A checkpoint voice
  with nothing stated is REFUSED, naming the variable; a stated one that
  disagrees with the voice is refused as a mismatch; a match is logged as an
  ASSERTION, not a verification. Unchecked, a server left running for another
  voice renders a whole book in that narrator.

**And the production path moved.** Owen, 2026-09-04 evening: production is
FINE-TUNED VOICES ONLY - no zero-shot cloning expected. So the text-only request
to a merged checkpoint (`DefaultVoice` with `checkpoint_dir`) is the primary,
best-tested path, and the reference-clip path (`ClipsVoice`) is marked
DIAGNOSTIC in its own docstring: kept working and tested because it is how a
voice is auditioned before anyone trains it, and how a regression in the
reference path is caught.

**The chunk-tail sentinel trim is NOT baked into narrator.** It is a band-aid,
and a token-level fix in vllm-omni's decode is queued on the training side.
`HiggsV3Codec.decode()` therefore REFUSES - v3's tokens never reach this process
and a client-side trim on top of the server's would eat real speech. What
narrator does instead is DETECT a contaminated tail: `probe_tail_trim` renders
one fixed-seed word at load and refuses a server whose last 300 ms is above
-45 dBFS. That gate is about the SERVER's output, so it keeps working unchanged
when the upstream fix lands and the site-packages patch goes away.

### 12.8d `generation_config.json` is a REQUIRED file of a merged checkpoint

Measured by the fine-tune campaign, 2026-09-05, and now refused by name in
narrator: **the checkpoint directory's `generation_config.json` is the sampling
the served model actually uses.**

`vllm-omni serve <dir>` resolves sampling FROM THE MODEL DIRECTORY -
`--generation-config` defaults to `auto`, and `serve_v3.sh` passes no override.
A merged dir WITHOUT the file makes vllm-omni's stage fallback
(`vllm_omni/entrypoints/openai/stage_params.py`) hand back a bare
`SamplingParams()`: temperature 1.0, **top_p 1.0, top_k DISABLED**. That samples
the untruncated 1026-way codebook tail, and long prompts derail into babble -
a seed-dependent collapse to 3-10 s of audio at >= 600 characters. The same
server with the file present renders the same prompts correctly.

**Nothing per-request can correct it.** `OpenAICreateSpeechRequest` has no
`temperature` / `top_p` / `top_k` fields at all; pydantic drops them silently
(the same trap the module docstring records for `extra_params`). The MODEL
DIRECTORY is the only lever there is.

WHERE THE FILE COMES FROM - the provenance, which is not "the base ships one":

| | |
|---|---|
| `bosonai/higgs-audio-v3-tts-4b` | ships **NO** `generation_config.json`. Verified 2026-09-05 across the whole WSL HF cache AND the Mac's `runtime/higgs-models/base` snapshot. This is precisely why a merged dir has to carry one. |
| every merged dir | gets one **written by the merge** (`v3_ft/merge_for_serving.py`, `ensure_generation_config`) from a recorded per-run override, `runs/<run>/generation_config.override.json`. The merge REFUSES to write a served dir without it. |
| the values | vllm-omni's own `deploy/higgs_multimodal_qwen3.yaml` stage-0 `default_sampling_params` - `{"temperature": 1.0, "top_p": 0.95, "top_k": 50, "repetition_penalty": 1.0}`. vllm-omni ships that YAML for this model and `vllm-omni serve` on the CLI **does not read it**, so the values have to be materialised into the directory. |
| the record | `merge_manifest.json` beside the weights carries `generation_config_source`, `generation_config_override` and the resulting `sampling`. |

Those four numbers are also what `v3_served.SERVER_DEFAULT_SAMPLING` has always
held; that constant is now documented AT ITS DEFINITION as the deploy default
for the BASE WEIGHTS, and is never used to stand in for a checkpoint's file.
Every docstring that used to say "sending no `extra_params` uses these verbatim"
said the thing this section refutes, and now says what actually happens.

**AND BASE WEIGHTS MUST STATE THEM.** The corollary took a review to see: if
sending nothing means the model directory, and the base snapshot has no file,
then a `clips` or `default` voice rendering against the base was itself getting
top_p 1.0 / top_k disabled - the babble sampling, live on the served arm for
every non-checkpoint voice. So `HiggsV3Config.served_sampling()` branches on
voice KIND exactly as the MLX arm does:

    checkpoint voice   send NO extra_params. The server reads the directory's
                       file for itself, and an extra_params here would override
                       the model's own declared sampling with narrator's opinion
                       of it.
    base weights       send SERVER_DEFAULT_SAMPLING explicitly (minus `seed`,
                       which is the request's top-level field and which
                       `build_request_body` refuses inside extra_params).

`HiggsV3Config.applied_sampling()` is the other half: what the model will
actually SAMPLE at, which for a checkpoint is its directory's file and is NOT
what was sent. That is what `higgs_v3_stop_policy` reports, because the manifest
outlives the render and reporting the base default for a fine-tune would name
sampling nobody used.

TYPES, NOT JUST PRESENCE. The validator also checks what the three values ARE:
`temperature` and `top_p` (and `repetition_penalty` when present) must be finite
non-bool numbers in range, and `top_k` must be a whole number >= 0. Presence
without type is not validation - `"top_k": 50.7` truncates silently to 50 in
every consumer, `"top_p": "0.95"` coerces, and `"temperature": null` used to
raise a bare `TypeError` naming neither the voice nor the file. `0.0`
temperature, `1.0` top_p and `0` top_k are ACCEPTED: a checkpoint that states
them is stating them deliberately and narrator does not second-guess a model's
own file. An unreadable file (permissions, a broken symlink) is refused by name
like every other state rather than raising a bare `OSError`.

WHAT NARRATOR DOES ABOUT IT. One validator,
`v3_served.require_generation_config(checkpoint_dir, voice_name)`, called from
`v3_served.checkpoint_serve_target()` - the one place that decides which
directory a voice's server runs on - and therefore from every door that resolves
a checkpoint voice: `HiggsV3Config.__post_init__`,
`HiggsV3Engine.resolve_load_voice`, `HiggsV3MlxEngine.resolve_load_voice` and
`higgs_v3_mlx_config_from_worker_kwargs`. It refuses, naming the voice, the
directory, the file and why, when the file is

- **absent**, or its checkpoint directory is not a directory;
- **unparseable** JSON, or a JSON document that is not an object;
- **present but carrying no sampling** - missing any of `temperature`, `top_p`,
  `top_k`. A `generation_config.json` without those is not the file this needs:
  the server reads it, finds no sampling, and falls back exactly as if it were
  absent, so presence is checked BY CONTENT and not by name.

It reads the file and returns it; it never copies, synthesizes or defaults one.
Writing the file would be narrator deciding a model's sampling, and repairing a
misconfigured directory is the kind of silent substitution this codebase does
not do. The refusal lands at LOAD - before the 55-297 s server start and before
anything holds the GPU - which is the same layer as, and for the same reason as,
the missing-`maxChars` refusal beside it.

Tested behaviourally in `tests/test_higgs_v3.py::GenerationConfigTest` on real
temp-dir layouts (absent / malformed / missing-key / present-and-valid, plus
each door), with the valid case carrying the real merged dir's file content
byte for byte. Mutation-checked: neutering the absent-file check fails six
tests, and emptying the missing-key list fails all four subtests of the sampling
case.

### 12.9 Every guess in this work, and what would settle it

Written down rather than buried, because each one is a place a reader should
not assume measurement.

| # | guess | how it would be settled |
|---|---|---|
| 1 | **`CONTEXT_TOKENS = 8192` for the v2 scaffold.** Taken from the plan and the v3 card. v2's Llama-3.2-3B backbone nominally carries more, and it was never probed. Conservative. | probe the v2 processor's max positions |
| 2 | **`MAX_CHARS_PER_SEC` 20.0 on both Higgs engines.** Measured ceilings are 18.0 (v2 audition) and ~16.5 (v3 delivered); 20.0 is that plus headroom. It is ADVISORY - `coverage_check='asr'` is the real gate | an ASR coverage run over a book |
| 3 | **v3 `max_chars = 600`.** The measured safe zone; the delivered render used 300 and 900 fails reproducibly. A PLACEHOLDER until the catalog carries it per (engine, voice) | catalog rows per voice |
| 4 | **The response is a WAV file body.** From the render scripts, and now observed in the smoke - but there is still no byte-level capture. `decode_response` refuses a non-WAV 200 by name, so a wrong guess is loud rather than silent | a capture in `<campaign>/higgs/captures/` |
| 5 | **The env var names** (`NARRATOR_HIGGS_VOICES`, `NARRATOR_HIGGS3_URL`, `NARRATOR_HIGGS3_SERVE_SCRIPT`, `NARRATOR_HIGGS3_ADAPTER_STRATEGY`, `NARRATOR_ENGINE`). Invented here; clips cannot ride a command line and there was no existing channel | the electron cut-over picks the names it will pass |
| 6 | **The tail-trim probe's -45 dBFS gate.** Derived from two points: our own smoke measured -62.4 dBFS patched, and the campaign's diagnosis puts an unpatched tail near -31 dBFS. Two samples, not a distribution | run the probe against an unpatched server once |
| 7 | ~~**The adapter strategy.**~~ SETTLED 2026-09-04: vllm-omni has no runtime LoRA (no adapter flags; the talker does not implement `SupportsLoRA`), so every voice is a merged checkpoint. See 12.8c | measured by the training side |
| 8 | **`DefaultVoice` has four fields, not "kind/name".** See 12.8b - the review's wording would make a clip-less adapter entry unrepresentable | a ruling either way |
| 9 | **`HiggsV3Engine.__init__` starts the server** (a constructor side effect). Reviewed and KEPT DELIBERATELY: `OrpheusEngine.__init__` loads its model, and both `serve/worker.py` and `render/worker.py` are written to that contract - deferring it for v3 alone would give those callers an engine that silently never started. Nothing needs an engine to ask a budget: `HiggsV3Budget(config)`, `higgs_v3_stop_policy(config)` and `HiggsV3Codec()` all answer with no server | a decision to change the contract for ALL engines at once |

Two things the review flagged as guesses are now MEASURED-OR-REFUSED rather than
assumed: silent server adoption (now `/v1/models` must name `higgs-v3`, and the
adapter too) and the timeout leak (a failed load now stops the server in a
`finally`). `finalize_audio` on served audio is a stated DECISION, not a guess -
see 12.10.

---

## 13. Higgs v3 on the Mac: the in-process MLX backend (2026-09-05)

Owen, 2026-09-05: *"make sure the Mac has Higgs built in for streaming the model
via the browser extension. I use that constantly on the Mac."*

`higgs-v3` is now ONE engine with TWO backends, chosen by **platform** in
`engine/registry.py:higgs_v3_backend_for_platform()`:

| platform | backend | `BackendSpec.kind` | module |
|---|---|---|---|
| `darwin` | mlx-audio, in this process | `inprocess` | `engine/higgs/mlx_backend.py` |
| everything else | vllm-omni over HTTP | `served` | `engine/higgs/v3_engine.py` |

The id, the voice document, the geometry (8 codebooks / 25 fps / 24 kHz / 960
samples), the budget, `pads = False`, `edge_fade = EdgeFade(10, 25)` and
`StopPolicy(eos_reliable=True, resplit_on_cap=False, coverage_check='asr')` are
IDENTICAL on both arms - they are properties of the model, not of the runtime.
Only *where the weights run* differs.

It is a function of `sys.platform` and NOT a capability probe. Whether
mlx-audio happens to import is a question about an environment; answering it
here would let a Mac with a broken install fall silently through to a served
backend whose server does not exist on that machine. The platform decides; the
backend then fails loudly (`detect_backend()` imports `mlx_audio.tts.utils`).

### 13.1 What mlx-audio provides, and what narrator kept for itself

mlx-audio **0.4.8** - the version already pinned for Orpheus - carries
`tts/models/higgs_audio_v3/` (a Qwen3 backbone with a fused multi-codebook head)
and `codec/models/higgs_audio/` (the 8-codebook DAC). Measured on the Mac
2026-09-05: **the OFFICIAL `bosonai/higgs-audio-v3-tts-4b` safetensors load
directly.** There is no MLX conversion step, no `mlx-community` repo, and no
separate codec download - `post_load_hook` builds the tokenizer from
`tokenizer.json` and the codec from the *same* shards
(`HiggsAudioTokenizer.from_higgs_tts_checkpoint`, prefix
`tied.embedding.modality_embeddings.0.model.`).

narrator borrows the model, the weights, the tokenizer, the prompt builder, the
codec and the per-step sampler (`generation.step`). It keeps the **generation
loop** and the **decode**, for three reasons that are contracts rather than
preferences:

1. `Model.generate` applies `fade_in_ms=30, fade_out_ms=15` **by default**.
   narrator's fade is the ASSEMBLER's (`edge_fade`); an engine that bakes one in
   gets it applied twice.
2. `Model.generate` has no `should_stop`, and yields once at the end. One v3
   chunk is up to 600 characters - tens of seconds - so a cancel could only land
   *between* rows. narrator's loop checks every step.
3. `Model._decode_audio` hands the reverted frames to the codec with no check
   that every code is a real code. See 13.3.

### 13.2 `model_type` is passed EXPLICITLY, and that is a bug workaround

v3's `config.json` says `model_type: "higgs_multimodal_qwen3"`. mlx-audio 0.4.8
*does* carry the alias (`tts/utils.py:MODEL_REMAPPING`), but
`utils.get_model_class` can never reach it: the branch that applies a remapping
is `elif model_type_mapped is not None`, guarded by
`if model_name is not None and model_type_mapped != model_type` - and a real
remapping ALWAYS differs from its key, so the first branch always wins. That
branch instead scans the model PATH's components for something named like a
model directory. Measured:

    ValueError: Model type higgs_multimodal_qwen3 not supported for tts.

Naming the weights directory `higgs_audio_v3` would satisfy the scan. That is
the wrong fix: it makes a load depend on a directory name, and it leaves the
same scan free to pick a DIFFERENT architecture out of any other path component
(`llama`, `spark` and `dense` are all real model packages). narrator passes
`model_type='higgs_audio_v3'` and then ASSERTS the class it got
(`_require_mlx_audio_surface`), so a hijack is loud rather than a book in the
wrong model.

### 13.3 The end of a chunk, at the TOKEN level - and why there is NO trim

The brief for this work asked for "trim the trailing sentinel run by content".
**It was not implemented, because the measurement says there is nothing to
trim.** The mechanism, established rather than assumed:

v3's audio vocabulary is 8 codebooks x 1024 real codes plus stream sentinels
**1024 (BOC)** and **1025 (EOC)**; the codec's codebooks hold exactly 1024
entries, and mlx's `nn.Embedding` does not bounds-check a gather, so a sentinel
reaching the codec is whatever memory that index lands on, decoded as sound.
The delay pattern offsets codebook `c` by `c` rows; reverting takes the diagonal
`raw[t, c] = delayed[t + c, c]` and consumes `Q - 1 = 7` rows.

- **Ramp-up**: rows 0..6 carry FORCED BOC in every codebook *above* the diagonal
  (`generation.step`, the `delay_count < n` branch). The revert reads only ON and
  BELOW it, so **no BOC can reach the codec from the head.**
- **Clean end**: codebook 0 emits EOC at row `e`; the sampler runs `n - 2 = 6`
  more rows and stops, so `L = e + 7` and `T = L - 7 = e`. The EOC diagonal sits
  at `delayed[e + c, c]` = raw frame `t = e`, **one past the last frame the
  revert produces.** On a clean ending the revert is EXACT.
- **Ragged end** (cap hit, abandoned mid-ramp, an off-diagonal sentinel): a
  sentinel CAN land inside a frame the revert keeps.

Measured on the Mac, 2026-09-05, `bosonai/higgs-audio-v3-tts-4b`, a 107-char
chunk, two fixed seeds, decoded twice over the SAME token matrix:

| seed | rows | audio frames | out-of-range codes | tail 300 ms RMS, untreated | ...filtered |
|---|---|---|---|---|---|
| 1234 | 152 | 145 | **0** | -60.13 dB | -60.13 dB |
| 1235 | 154 | 147 | **0** | -47.64 dB | -47.64 dB |

Identical sample counts, identical RMS: on these endings a filter removes
nothing and **a trailing trim would have removed real audio.** The "every chunk
ends in garbage" story belongs to vllm-omni, whose upstream substituted **0** for
every sentinel - 0 being a VALID code that decodes to real sound, so the
substitution WAS the artifact - and then trimmed exactly one frame. mlx-audio
does neither, so neither defect exists on this path.

What narrator ships instead is a **sensor**, not a repair: after the revert, a
frame is kept iff **all 8 codebooks are in [0, 1023]** (`real_code_frames`).
Nothing out of range ever reaches the codec; nothing is substituted; a dropped
frame is *gone*, not zeroed. `FrameFilterReport` separates leading / interior /
trailing, and an INTERIOR drop is logged loudly because it is not an expected
shape. No fade: a cut in the code domain lands on a frame boundary the codec
never rendered, so there is nothing to click.

The filter is pinned against the SAVED TOKEN MATRICES from the training side's
vllm-omni investigation, copied read-only into
`tests/golden/higgs_sentinel/talker_rows_*.npy`:

| fixture | raw frames | kept | leading | interior | trailing |
|---|---|---|---|---|---|
| `talker_rows_{0,1,2,clean}` | 301/451/201/301 | raw-1 | 0 | 0 | **1** |
| `talker_rows_capped` | 260 | 260 | 0 | 0 | **0** |
| `talker_rows_partial_ramp` | 236 | 236 | 0 | 0 | **0** |
| `talker_rows_pad_row` | 201 | 192 | 0 | **8** | 1 |

`capped` and `partial_ramp` are the shapes upstream's blind one-frame trim was
eating a REAL 40 ms frame on. `pad_row` is the one no positional trim can reach:
8 interior frames of `-1` pad, which a trailing walk-back never sees. Those two
rows are the whole argument for deciding by token identity.

### 13.4 The worker no longer routes by backend NAME

`serve/worker.py`'s mlx / vllm / transformers arms call ORPHEUS's own methods
(`_generate_mlx_safe`, `_generate_mlx_batch_audio`, `_generate_audio_vllm_safe`,
`_guard_truncation`, `_tokens_to_audio`). They were selected by
`engine.backend`, which is a RUNTIME name and not an engine - and Higgs v3 on
the Mac truthfully reports `backend == 'mlx'` while having none of them. A Higgs
load would have gone straight into Orpheus's MLX ladder.

`_uses_orpheus_token_pipeline(engine)` (`ENGINE_ID == 'orpheus'`) is now the
discriminator, in three places: `_generate_audio`, `_generate_audio_batch` and
the `generate_batch` dispatcher. The backend name only picks BETWEEN Orpheus's
three. Everything else renders one chunk with `render_audio(text, index=i)`, and
an engine offering neither is a named error.

`serve/fake_engine.py:FakeHiggsEngine` gained `render_audio` with it. It had none
- it reported `backend='transformers'` and was therefore driven through
Orpheus's transformers arm, testing a code path no Higgs engine has ever used.

### 13.5 Engine logs are the HOST's to route (and Orpheus had the bug too)

Found the first time this backend was driven through the real worker: a bare
`print` from the engine layer lands on **stdout, which IS the JSON-lines
protocol**, between two protocol messages. `mlx_backend._log()` writes to stderr.

**THE SAME BUG WAS LIVE FOR ORPHEUS, and is now fixed** (2026-09-05, at the
reviewer's direction) - so this was a Listen-on-the-Mac defect for BOTH engines.
`serve/worker.py` does no stdout redirection and `engine/orpheus/` held 111
`print` calls, so a real (non-fake) Orpheus worker emitted non-JSON on the
protocol stream. The protocol tests never saw it because they run
`--fake-engine`.

`narrator/engine/log.py` now owns the destination, and **the destination is the
HOST's choice, not the engine's** - because the two hosts' stdout contracts are
incompatible and the second one PARSES the very lines that break the first.
Measured in `electron/parallel-tts-bridge.ts`: its worker `stdout` handler runs
five parsers its `stderr` handler does not -

    MODEL_LOAD_START_RE   /Loading Orpheus model with/   the load bar starting
    MODEL_LOAD_DONE_RE    /model loaded!/                the load bar finishing
    REPAIR_START_RE       /sentence N hit the ... cap/   the repair-ladder bar
    parseMlxHeartbeat()   "[ORPHEUS] MLX batch generating: ..."    the batch bar
    parseOrpheusGuardEvent()  "[ORPHEUS][ORPHEUS_GUARD_EVENT]"     the guard index

- every one of those strings printed by `engine/orpheus/`. A blanket move to
stderr would have fixed the serve protocol and silently broken the audiobook
progress UI, which is a different bug in a place nobody would look.

    narrator.serve            stdout is JSON   -> engine logs to STDERR (default)
    narrator.compat.worker    stdout is PARSED -> set_log_stream(sys.stdout)

The default is stderr so a host that forgets to choose gets the safe answer; the
host that genuinely needs stdout is the one that has to say so.

**NO STRING CHANGED - BUT 31 CALLS CHANGED DESTINATION, AND THE FIRST WRITE-UP
DID NOT SAY SO.** It claimed "nothing but call-name swaps plus ten imports".
That is not what happened. Exactly:

|  n  | what it was | what changed |
|---|---|---|
| 94 | bare `print(...)` in `engine/orpheus/` | the call name only |
| 17 | `print(..., file=sys.stderr)` in `engine/orpheus/` | **the kwarg was DELETED** |
| 14 | `print(..., file=sys.stderr)` in `engine/higgs/` | **the kwarg was DELETED** |
| 1 | `engine/higgs/mlx_backend.py::_log` | authored as `log()` |
| **126** | | |

Deleting `file=sys.stderr` is not cosmetic: `log()` does
`kwargs.setdefault('file', log_stream())`, so KEEPING the kwarg would have
pinned those calls to stderr for ever, and removing it hands them to the host's
stream - i.e. STDOUT under `compat.worker`. That was the intent (a call that
names its own stream cannot be routed, which is the whole point of this module),
but "call-name swaps" does not describe it.

It was checked before it was made, two ways, and re-checked in review. All 31
are `[ORPHEUS][STREAM]` / `[HIGGS3]` / `[HIGGS]` diagnostics: the Orpheus 17 are
emitted only from `generate_batch_stream`, whose sole non-test caller is
`serve/worker.py` (`compat/` and `render/` never call it, so under
`compat.worker` they cannot be emitted at all); and across all 31 strings
exactly ONE matches any bridge pattern - `GENERATION_ACTIVITY_RE`, which the
bridge already runs on BOTH streams. No match for `MODEL_LOAD_START_RE`,
`MODEL_LOAD_DONE_RE`, `REPAIR_START_RE`, `parseOrpheusGuardEvent` or
`parseMlxHeartbeat`.

The Orpheus 17: engine.py:750; mlx_backend.py:703, 747, 767, 780, 889, 993;
vllm_backend.py:677, 690, 725, 750, 763, 770, 793, 820, 831, 844. The Higgs 14:
v3_served.py:589, 596, 618, 622, 684, 745, 818, 839, 843, 851, 862, 870;
transformers_backend.py:65, 77.

`tests/test_engine_log_stream.py` pins all of it: NOTHING under `engine/**`
calls `print` at all - not even with `file=`, which is the shape those 31 had
and which bypasses `set_log_stream` so the host cannot route it (`engine/log.py`
is the single exemption, held to exactly one print). It is an AST walk over the
tree RECURSIVELY, because the first version walked one directory
non-recursively plus one named file while claiming to cover the engine layer.

THE FIVE BRIDGE PINS ARE THE BRIDGE'S OWN REGEXES, COPIED VERBATIM with the .ts
line each came from - and that matters, because the first version paraphrased
two of them into weaker substrings. Measured in review: against the REAL
`REPAIR_START_RE` and `HEARTBEAT_RE`, the reconstructed literals matched ZERO,
because `_literals()` flattened f-strings by dropping every `{...}` - so
`f'sentence {idx} hit the ... cap'` became `'sentence  hit the ... cap'`.
Deleting that `sentence {idx} ` prefix, or renaming the heartbeat's `rows`
field, PASSED the test and froze the progress bar. Interpolations are now
replaced by `'0'`, and both mutations were confirmed to fail the test.
Docstrings are excluded too (the earlier claim that the AST did so was simply
false - `ast.walk` yields them), which matters because `mlx_backend.py`'s module
docstring quotes the heartbeat verbatim and would otherwise satisfy the most
important pin with a comment ABOUT the message.

Other things it pins: the default is stderr and resolves at CALL time; the real
`python -m narrator.serve` keeps stdout JSON-only for both engine ids; a real
engine log line lands on stderr and never on stdout (`FakeEngine` logs at load,
as a real engine does, so the proof is not vacuous); `compat.worker` really does
point the channel at stdout; and the SWEEP'S SIZE, which is counted by AST and
asserted against one constant (`LOG_CALLS_BY_PACKAGE`) - the first write-up
carried four disagreeing numbers for it (116, 116, 94, 94; the measurement is
126), which a change whose whole argument is "measured, not assumed" cannot do.

The num2words work grew a home of its own too,
`tests/test_serve_number_normalization.py`: the blank-language refusal, the
one-refusal-per-request language check, and that each of the five helpers raises
rather than returning the raw digits.

Two smaller things went with it. `serve/worker.py`'s load failure said "Failed to
load Orpheus" for every engine - it now names `engine_id()`, because that message
is read at exactly the moment someone is working out WHICH of two engines broke.
And `num2words` lost its `_HAS_NUM2WORDS` guard and its five
`except Exception: return <the digits>` fallbacks: it is a declared base
dependency, and a missing or failing one used to make the listen path read
"$5.50" as punctuation for a whole session without saying anything. It now
refuses by name (`_number_refusal`).

Two follow-ups from review on that. The refusal was PER SENTENCE for a cause
that is per SESSION - num2words raises for a language it has no module for, so
every digit-bearing sentence failed separately with the same message. Now
`check_language()` asks it ONCE per language per process, at the top of
`generate` / `generate_batch`, and refuses the whole request. And
`(language or 'en')` inside `normalize_for_tts` was a second default underneath
the protocol's own documented one - a `x or default` on a required value, two
lines from the five being removed. `resolve_language()` refuses a blank one by
name: reading an unknown language as English is the same silent substitution.

### 13.6 What was measured, end to end (Mac, 2026-09-05)

`python -m narrator.serve` with `NARRATOR_ENGINE=higgs-v3`, the `default` voice,
through the real JSON-lines protocol - one `generate` and one `generate_batch`
with one row streamed. **ALL PASS.**

    {"type":"ready","device":"mlx","backend":"mlx"}
    {"type":"loaded","voice":"base","backend":"mlx","engine":"higgs-v3",
     "sampleRate":24000,"pads":false,"edgeFadeMs":{"in":10.0,"out":25.0}}

| measurement | value |
|---|---|
| model download | 8.7 GiB, 12 files, official HF repo, not gated |
| cold load (warm page cache) | 2.8 s; `ready` -> `loaded` 3.7 s |
| peak memory, one row | 8.89 GB (10.32 GB across the two-seed probe) |
| single `generate` | 5.90 s of audio in 3.37 s wall - **RTF 0.571** |
| speech rate | 15.9 chars/s (probe: 18.2-18.5) |
| batch of 2, one streamed | `batch_chunk` x2 (audio + the worker's gap chunk - see 13.7), `batch_item` x2, `batch_done` |

Wav: `~/narrator-smoke/higgs3-mlx-one.wav`, copied to
`C:\tmp\narrator-smoke\mac\`. **NOT EAR-CHECKED** - no one has listened to it.

**PROVENANCE OF THE NUMBERS ABOVE.** They were taken on a tree STAGED to the Mac
at `~/narrator-higgs-mlx`, which differed from what was ultimately committed:
`mlx_backend.py` gained the `model_type`/architecture assertion and the stderr
log routing after some of them were measured. They are therefore indicative, not
the record.

**THE MEASUREMENT OF RECORD is the reviewer's re-run of the COMMITTED tree**
(2026-09-05): **RTF 0.507**, cold load **4.5 s**, peak **8.89 GB**, stdout
JSON-only. Where the two disagree, the committed-tree figures are the ones to
quote. Both agree on the only number anything depends on - 8.89 GB peak - and
both are comfortably faster than realtime.

Re-run once more after the engine-wide print sweep (13.5), on the final tree:
**RTF 0.500**, load 2.9 s, peak 8.89 GB, ALL PASS, and the two `[HIGGS-MLX]`
lines now appear on STDERR where the smoke script prints its stderr tail - which
is the sweep working, visible.

### 13.7 Streaming is PER ROW, and that is the honest cadence

`generate_batch_stream` emits a streamed row as one `on_chunk(row, 0, pcm)` at
retirement, then `on_row`.

TWO LAYERS, AND AN EARLIER DRAFT OF THIS NOTE CONFLATED THEM (caught in review:
13.6's smoke logged TWO `batch_chunk` messages for one streamed row while this
section said one). Both are right about their own layer. The ENGINE emits ONE
`on_chunk` per streamed row. The WORKER then appends the inter-sentence gap as
that row's LAST chunk - `serve/worker.py`'s `on_row` does
`on_chunk(row, sent, gap)` when `STREAM_GAP_SEC > 0`, because a 0.3 s gap is the
only part of `finalize_audio` that can still be applied to audio already in
flight (PORT_NOTES 12.10). So the WIRE carries `audio, gap, batch_item` for a
streamed row, and the engine's contract is unchanged.

`codec().streaming_decoder()` returns None. A
delay-pattern codec's window is incomplete in its last 7 frames by construction,
and the ragged-ending filter can only run once generation has finished, so a
mid-row window cannot tell a ramp-down from speech. `should_stop` IS checked
every generation step, so a cancel lands in milliseconds even though audio does
not. Whether the DAC decoder tolerates overlapped windows the way SNAC does is
**unmeasured**; that is the open question if per-row latency turns out to matter
for the browser extension.

`BATCH_SIZE = 1`. mlx-audio HAS a `batch_generate` with a left-padded
`BatchKVCache` and narrator does not use it: nothing here has measured it, and
mixed-length MLX batches are a known corruption hazard on this runtime.

### 13.8 Guesses and open questions in THIS work

| # | guess / open question | how it would be settled |
|---|---|---|
| 1 | **`MLX_AUDIO_VERSION = '0.4.8'` is a hard pin and the private members it drives (`_build_prompt_embeddings`, `_audio_logits`, `_embed_audio_codes`) are not a public API.** A rename is a refusal, not an adaptation | re-measure the loop against a newer mlx-audio |
| 2 | **Interior sentinels never occur on the MLX path.** 0 in 2 fixed-seed renders is not a distribution; the code logs them rather than assuming | a book's worth of renders with the warning watched |
| 3 | **`max_chars = 600` and `max_chars_per_sec = 20.0` are inherited from the SERVED arm.** The tail-dropping that set 600 was measured on vllm-omni, not on MLX | a coverage sweep on the Mac |
| 4 | **Per-row streaming is the only sound cadence.** Argued from the delay pattern; the DAC decoder's behaviour on overlapped windows is untested | a windowed-decode experiment against a whole-row reference |
| 5 | **`NARRATOR_HIGGS3_MLX_MODEL`** - invented here, like the other v3 variables | the electron cut-over picks the names it will pass |
| 6 | **The audio has not been heard.** Every number above is arithmetic | someone listens to `higgs3-mlx-one.wav` |

### 13.9 Incident: the Mac GPU lock was overwritten (2026-09-05)

Recorded so the procedure is fixed rather than remembered. This session took
`/tmp/bookforge-mac-gpu.lock` with a plain truncating redirect:

    echo "narrator-higgs-mlx $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /tmp/bookforge-mac-gpu.lock

The file did not exist when this session checked for it, and did when it wrote -
another agent's 108-sentence Orpheus proof had taken it in between. `>` is a
truncate, not a claim: it destroyed the holder's record. (The render survived on
memory headroom.) The release was `rm -f`, which is the same defect at the other
end - it removes whoever's lock is there.

**The lock is exclusive, must be taken ATOMICALLY, and a lock you did not take
is not yours to remove:**

    # take: fails if it exists, so two writers cannot both win
    ( set -o noclobber
      echo "narrator-higgs-mlx $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        > /tmp/bookforge-mac-gpu.lock ) 2>/dev/null \
      || { echo "held by: $(cat /tmp/bookforge-mac-gpu.lock)"; exit 1; }
    # ... load the model, do the work, then release ONLY your own:
    grep -q narrator-higgs-mlx /tmp/bookforge-mac-gpu.lock \
      && rm /tmp/bookforge-mac-gpu.lock

If it exists, READ IT, name the holder in the log, and WAIT (poll 30-60 s, up to
90 min). Never overwrite.

### 13.10 OWED AT CUT-OVER: the Mac spawn must set NARRATOR_HIGGS3_MLX_MODEL

`engine/higgs/mlx_backend.py` refuses to load without it, by name and with no
search - guessing where a model directory is is how a book ends up rendered in
a different model's voice. Nothing in `electron/` sets it today, so **a Mac
Higgs spawn from the app will fail at load until it does.** Routed to the
cut-over builder (coordinator, 2026-09-05).

    NARRATOR_HIGGS3_MLX_MODEL = <userData>/runtime/higgs-models/base

which on this Mac resolves to
`~/Library/Application Support/BookForge/runtime/higgs-models/base` - the
`bosonai/higgs-audio-v3-tts-4b` snapshot, 8.7 GiB, downloaded with
`huggingface_hub.snapshot_download`. It is the 35th spawn variable (section 9.4
lists 33; `NARRATOR_ENGINE` was the 34th) and it belongs beside the other
`NARRATOR_HIGGS3_*` names, which are equally invented here and equally the
cut-over's to confirm (12.9 guess 5, 13.8 guess 5).

TWO THINGS THAT DO NOT NEED IT. A `checkpoint` voice names its own merged
directory in the voice document and loads that instead - the variable is only
the BASE. And the served (Windows/WSL) arm never reads it at all.

### 13.11 mlx-audio does NOT read `generation_config.json` - so narrator does

The counterpart of 12.8d on this arm, established by reading mlx-audio 0.4.8 in
the Mac's `narrator-mlx` env
(`/opt/homebrew/Caskroom/miniconda/base/envs/narrator-mlx/lib/python3.11/
site-packages/mlx_audio/`), 2026-09-05.

**THE FINDING.** `grep -rn generation_config` over
`tts/models/higgs_audio_v3/` returns NOTHING - no match in `model.py`,
`generation.py`, `config.py`, `prompt.py` or `continuous_batching.py`. It is not
that mlx-audio has no such convention: three other packages in the SAME release
do read the file -

| file:line | what it reads |
|---|---|
| `tts/models/moss_tts/moss_tts.py:349-361` | `_load_generation_config(model_path)` -> `model.generation_config`, then `temperature` / `top_p` / `top_k` / `repetition_penalty` off it (`:1610-1636`) |
| `tts/models/qwen3_tts/qwen3_tts.py:2914` | `gen_config_path = model_path / "generation_config.json"` |
| `stt/models/whisper/whisper.py:716-726` | alignment heads out of the same file |

so its absence in `higgs_audio_v3` is a GAP, not a convention. Nor does the
loader supply it: `tts/utils.py:load_model` (`:100-129`) delegates to
`mlx_audio/utils.py`'s loader, which reads `config.json` to pick an
architecture and attaches no generation config to the model object.

**WHAT THE SAMPLER APPLIES.** `higgs_audio_v3/model.py:737-758` -
`Model.generate(...)` defaults `temperature: float = 1.0`,
`top_p: Optional[float] = None`, `top_k: Optional[int] = None`, and takes NO
repetition-penalty argument (there is no repetition penalty anywhere in the
package). `generation.py:114-141` - `step()` takes `temperature`, `top_p` and
`top_k` as REQUIRED keyword arguments and forwards them to `sample_independent`
(`generation.py:80-95`), which divides the logits by `temperature`, then applies
`_apply_top_k` and `_apply_top_p`. Both of those are NO-OPS for `None`
(`generation.py:62-77`: top_k is skipped when `None`, `<= 0` or `>= vocab`;
top_p when `None`, `<= 0.0` or `>= 1.0`). So mlx-audio's own default - and
anything that passes nothing - samples the untruncated codebook tail exactly as
an unconfigured vllm-omni does.

**THEREFORE narrator reads the file itself.** `HiggsV3MlxConfig.mlx_sampling()`
no longer resolves from a constant:

    checkpoint voice   <checkpointDir>/generation_config.json, through
                       v3_served.require_generation_config - the SAME file
                       vllm-omni reads on the other arm, so one voice renders at
                       one sampling on both. The refusal in 12.8d has already
                       proved it is there and carries all three keys.
    base weights       there is no file to read: the bosonai snapshot ships none
                       (verified on the WSL HF cache and on the Mac's
                       runtime/higgs-models/base). The stated authority is v3's
                       documented deploy default,
                       v3_served.SERVER_DEFAULT_SAMPLING, which is the same
                       stage-0 block the served arm runs those weights under.

It is resolved ONCE, in `HiggsV3MlxEngine.__init__`, and logged at load with its
source; re-reading per chunk would ask the same question thousands of times a
book and would let the answer change mid-render. `HiggsV3MlxConfig.sampling`
stays what it was: a named per-config override on top, and
`HiggsV3MlxConfig.__post_init__` now resolves the sampling at CONSTRUCTION, the
same moment its served twin validates, so a caller building the dataclass
directly cannot get an object whose first refusal arrives from inside the
generation loop.

**A `repetition_penalty` other than 1.0 in the file is REFUSED here, not
dropped.** mlx-audio has no such lever at all - `Model.generate` takes no such
argument and the word appears nowhere in the package - so honouring the file is
impossible on this runtime, and ignoring it would give one checkpoint two
samplings: penalised on the vllm-omni server, unpenalised on the Mac, from the
same file. 1.0 is a no-op and is accepted as the nothing it is, which is what
every correctly merged checkpoint carries. The same rule already applied to a
user-supplied `repetition_penalty`; a lever the runtime cannot honour is a
refusal at either door.

`higgs_v3_mlx_stop_policy` therefore reports the CHECKPOINT's own levers, so a
manifest never names sampling nobody used.

WHAT THIS DOES NOT SETTLE. mlx-audio's sampler and vLLM's are different
implementations of top-k/top-p over different runtimes; feeding both the same
three numbers makes the CONFIGURATION identical, not the draws. Nothing here has
compared a Mac render against a WSL one at the same seed - and the seeds are not
comparable either (`mx.random.seed` vs vLLM's). That is a listening test, not an
assertion this code makes.

