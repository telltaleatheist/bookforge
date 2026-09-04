# PORT_NOTES  -  `narrator/engine` and `narrator/serve`

What was ported, from where, what replaced each ebook2audiobook dependency, and
everything that was deliberately left behind.

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
