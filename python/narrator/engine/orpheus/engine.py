"""OrpheusEngine - the class every caller holds.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  the module-scope instance registry + atexit hook (26, 78-96)
  Orpheus.__init__ (763)               cleanup / __del__ (1118, 1154)
  detect_backend / _detect_backend (1161, 1177)
  load_engine (2021)                   _evict_global_cache (1086)
  convert (4610)                       convert_batch (4726)
  generate_batch_stream (3425)

THE SHAPE OF THE PORT. e2a's `Orpheus` was one 5,507-line class inheriting
TTSUtils + TTSRegistry. narrator keeps ONE class with the SAME method names and
signatures - that is the contract the serve worker and e2a's own worker_core
call through - but its body is assembled from mixins, one per seam, so a
reviewer can diff each seam against the region of orpheus.py it came from. The
method bodies are unchanged; only their file moved.

WHAT REPLACED THE e2a MACHINERY (the full table is in PORT_NOTES.md):
  TTSRegistry(name='orpheus')  gone - narrator serves exactly one engine
  TTSUtils                     _cleanup_memory -> audio.AudioMixin,
                               _split_long_text -> prompt.PromptMixin,
                               _build_vtt_file  -> NOT ported (assemble/ owns it)
  session: DictProxy           config.EngineConfig
  loaded_tts                   registry.LOADED
  load_engine_presets          config.STOCK_VOICE_PRESETS
  lib.conf's env block         cuda_env.apply(), at backend import
  common.headers               nothing: the engine imports what it uses

torch is imported lazily throughout, so `import narrator.engine` works on an
interpreter with no torch, vLLM or mlx - which is what lets the caps, prompt,
sampling, snac and guard tests run on the Windows interpreter.
"""
import atexit
import platform
import weakref

from .adapters import AdaptersMixin
from .audio import AudioMixin
from .caps import CapsMixin
from .config import STOCK_VOICE_PRESETS, EngineConfig, EngineDefaults
from .errors import TokenStreamMisaligned, is_fatal_cuda_error
from .guards import GuardsMixin
from .interface import OrpheusInterfaceMixin
from .mlx_backend import MlxBackendMixin
from .prompt import PromptMixin
from .registry import LOADED
from .sampling import SamplingMixin
from .snac import SnacMixin
from .transformers_backend import TransformersBackendMixin
from .vllm_backend import VllmBackendMixin
from ..log import log

# Track active engine instances for cleanup on exit
_active_instances = weakref.WeakSet()


def _cleanup_on_exit():
    """Called on process exit to ensure all engine instances are cleaned up"""
    import gc
    for instance in list(_active_instances):
        try:
            instance.cleanup()
        except Exception:
            pass
    # Final CUDA cleanup
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
        gc.collect()
    except Exception:
        pass


atexit.register(_cleanup_on_exit)


class OrpheusEngine(EngineDefaults, OrpheusInterfaceMixin, CapsMixin, PromptMixin,
                    SamplingMixin, SnacMixin, GuardsMixin, AudioMixin, AdaptersMixin,
                    VllmBackendMixin, MlxBackendMixin, TransformersBackendMixin):
    """Orpheus TTS engine - SOTA open-source TTS built on Llama-3b backbone.
    Excellent prosody and naturalness, ideal for audiobooks.

    Supports three backends (auto-detected by platform):
    - MLX (preferred on Mac) - Fast, uses Apple Silicon efficiently (~1.4x realtime)
    - vLLM (preferred on Windows/Linux with CUDA) - Fast batched inference
    - Transformers (fallback) - Slow but works everywhere

    IMPORTANT: Orpheus does NOT benefit from multiple workers like XTTS.
    - MLX uses unified memory - multiple workers compete, no speedup
    - vLLM has built-in batching - use single instance
    Always run with workers=1 for Orpheus.

    Voices: tara, leah, jess, leo, dan, mia, zac, zoe
    Emotion tags: <laugh>, <chuckle>, <sigh>, <cough>, <sniffle>, <groan>, <yawn>, <gasp>
    """

    # Device tracking
    _device = None

    def __init__(self, config: EngineConfig):
        try:
            if not isinstance(config, EngineConfig):
                raise TypeError(
                    'OrpheusEngine(config) takes a narrator.engine.EngineConfig; '
                    f'got {type(config).__name__}. (e2a passed a session DictProxy '
                    'here - see PORT_NOTES.md for the field mapping.)')
            self.config = config
            self.resampler_cache = {}
            self.audio_segments = []
            self.backend = None  # 'mlx', 'vllm', or 'transformers'
            self.snac_model = None
            self.tokenizer = None
            self.mlx_model = None  # For MLX backend

            # Session-scoped self-calibrating ceiling for the truncation guard's
            # chars/sec threshold (see _guard_truncation). Starts empty (no
            # ratchet); the guard only ever raises it, and only from rates
            # measured on force-split re-renders (which cannot be truncated).
            #
            # Keyed BY VOICE, because the thing it calibrates is one voice's natural
            # speaking rate: a resident streaming engine serves several voices, and a
            # ceiling ratcheted up by a fast fine-tune (deathstalker ~23.5 ch/s) would
            # otherwise disarm the guard for a slow one still reading at ~15.
            self._rate_ceilings = {}

            # Serial for fast-start vLLM request ids (see
            # _generate_batch_stream_vllm). Initialised here so the streaming
            # loop can just increment it - a getattr-with-default there would be
            # a fallback standing in for an attribute that should always exist.
            self._stream_batch_serial = 0

            # e2a loaded lib/classes/tts_engines/presets/orpheus_presets.py here.
            # Every entry in it maps a stock voice to itself; see
            # config.STOCK_VOICE_PRESETS.
            self.models = STOCK_VOICE_PRESETS

            self.params = {}
            self.params['samplerate'] = self.SAMPLE_RATE

            # ORPHEUS_BACKEND still works; an explicit config.backend beats it.
            self._forced_backend = config.backend

            # Custom Orpheus model (BookForge folder-discovered voices).
            # model_dir is an absolute path to a HF/MLX model folder whose FOLDER
            # NAME is the voice token it was fine-tuned on (e.g. .../owen -> token
            # "owen"). When present, point every backend at the local dir and use
            # the token verbatim - these single-speaker finetunes are NOT in the
            # built-in allowlist, so the usual validation would wrongly drop them
            # to the default voice (the leah fallback bug).
            self.custom_model_dir = config.model_dir

            # Adapter mode (see the LORA_* block in config.py): the served weights
            # are base_dir and the voice arrives per request as a LoRARequest built
            # from adapter_dir. Validated NOW so a broken install fails before the
            # engine loads, never mid-book and never by quietly rendering the base
            # voice.
            #
            # base_dir WITHOUT an adapter is the third legal shape:
            # "stock-from-local-base" (see _validate_adapter_mode).
            self.adapter_dir = config.adapter_dir
            self.base_dir = config.base_dir
            self._validate_adapter_mode()

            # Get voice from config
            voice = config.voice if config.voice is not None else self.DEFAULT_VOICE
            log(f"[ORPHEUS] Session fine_tuned value: '{voice}'")

            if self.custom_model_dir:
                self.MLX_MODEL = self.custom_model_dir
                self.TRANSFORMERS_MODEL = self.custom_model_dir
                self.voice = (voice or '').strip().lower() or self.DEFAULT_VOICE
                log(f"[ORPHEUS] Custom model dir: {self.custom_model_dir}")
                log(f"[ORPHEUS] Using custom voice token: '{self.voice}'")
            elif self.adapter_dir:
                # The base is the model that gets SERVED; the adapter carries the
                # voice. The token is taken verbatim for the same reason the custom
                # branch above takes it verbatim (a fine-tune's token is not in the
                # allowlist, so validation would drop it to leah), and it is REQUIRED
                # here: it is also the adapter's registry key, so there is nothing
                # sane to default to.
                #
                # BOTH model refs point at the base, because on BOTH backends that can
                # serve an adapter the base is the thing that gets LOADED and the
                # adapter is applied to it afterwards: vLLM per request (LoRARequest),
                # MLX by wrapping the projection modules of the resident model. The
                # base dir is an HF-format bf16 checkpoint, which is exactly what
                # mlx_audio's load_model reads for the legacy merged Mac voices.
                self.TRANSFORMERS_MODEL = self.base_dir
                self.MLX_MODEL = self.base_dir
                self.voice = (voice or '').strip().lower()
                # 'internal' is e2a conf_models.default_fine_tuned - the sentinel both
                # session builders substitute when --fine_tuned was never passed, so
                # an empty check alone can never fire. Rendering with "internal: "
                # would apply the right LoRA under a prompt token the adapter was
                # never trained on: audio that sounds plausible and is wrong.
                if self.voice in ('', 'internal'):
                    raise ValueError(
                        f'Orpheus adapter mode ({self.adapter_dir}) needs a voice token: '
                        'the token the adapter was trained on.'
                    )
                log(f"[ORPHEUS] Adapter base dir: {self.base_dir}")
                log(f"[ORPHEUS] Adapter dir: {self.adapter_dir}")
                log(f"[ORPHEUS] Using adapter voice token: '{self.voice}'")
            else:
                # STOCK-FROM-LOCAL-BASE: base_dir with no adapter. The weights served
                # are the same unsloth/orpheus-3b-0.1-ft checkpoint the stock path
                # pulls from the HF cache - just read from the local `_base` folder
                # instead - so the voice is still an allowlisted prompt prefix and
                # validation below is unchanged. The point is the ENGINE: on vLLM it
                # is built with enable_lora (see _load_vllm_engine), so a stock
                # session and an adapter session over the same base are the SAME
                # engine, and switching between them costs a registration instead of
                # a 6 GB reload plus a possible mid-session HF download.
                if self.base_dir:
                    # MLX_MODEL moves with it: the engine cache key is the (merged,
                    # base) pair, so a stock session naming this base and an adapter
                    # session naming it are the SAME engine - and they had better be
                    # the same weights. Same fine-tune either way
                    # (unsloth/orpheus-3b-0.1-ft), so the audio is unchanged; only
                    # the honesty of the key is.
                    self.TRANSFORMERS_MODEL = self.base_dir
                    self.MLX_MODEL = self.base_dir
                    log(f"[ORPHEUS] Stock voice served from local base dir: {self.base_dir}")

                # Handle preset lookups
                if voice in self.models:
                    voice = self.models[voice]

                # Normalize to lowercase for comparison
                voice_lower = voice.lower() if voice else self.DEFAULT_VOICE

                # Validate voice
                if voice_lower not in self.VALID_VOICES:
                    log(f"Warning: Unknown Orpheus voice '{voice}', defaulting to '{self.DEFAULT_VOICE}'")
                    voice_lower = self.DEFAULT_VOICE

                self.voice = voice_lower
                log(f"[ORPHEUS] Using voice: '{self.voice}'")

            # The catalog's per-voice tuning. UNCONDITIONAL, with `or {}` - the
            # same call e2a's streaming worker made (`register_voice_caps(v,
            # caps or {})`), at the same point in the sequence.
            #
            # REGISTERING AN EMPTY DICT IS THE RESET, and skipping it is a
            # silent wrong-voice render. `_voice_caps` is CLASS-level and
            # therefore survives _teardown_engine: load 'ender' with a catalog
            # payload, switch model dir (teardown), reload 'ender' with
            # `caps: {}` - which is exactly what orpheus-worker-pool.ts sends
            # when the voice resolves to no catalog model - and a conditional
            # registration would leave the FIRST payload's eosFloor/eosBoost
            # attached to a voice the catalog no longer tunes. Registering {}
            # empties the entry, so every cap falls back to ORPHEUS_* env then
            # the class default, which is what "no catalog tuning" means.
            #
            # The audiobook worker passes no caps at all: it registers {}, every
            # lookup falls through to its spawn environment, and that path is
            # byte-identical to e2a's (which never registered anything).
            self.register_voice_caps(self.voice, config.caps or {})

            self.engine = None
            self.engine = self.load_engine()

            # Register this instance for cleanup on exit
            _active_instances.add(self)

        except Exception as e:
            error = f'OrpheusEngine.__init__() error: {e}'
            raise ValueError(error)

    # ---- lifecycle ----------------------------------------------------------

    @staticmethod
    def _evict_global_cache():
        """Drop the process-global Orpheus model cache so the next load fetches a
        fresh model. Used when switching to a different model_dir or base_dir and
        on cleanup, so a custom voice's weights actually free instead of being
        reused.

        The LoRA registry (orpheus_lora_ids / orpheus_lora_paths / the fingerprints
        / the id counter) goes WITH the engine. lora_int_ids only ever need to be
        unique for the life of the ENGINE that caches weights under them - the cache
        is vLLM-internal and dies with the LLM object - so an engine reload starts
        from an empty adapter cache and ids may safely restart at 1.

        Keeping the registry across a reload was worse than useless: it made
        _register_lora refuse to re-point a voice at a different adapter dir
        (retraining a voice would have needed a process restart on the resident
        streaming server), while protecting an id space that no longer had anything
        cached under it."""
        for k in ('orpheus', 'orpheus_mlx_model', 'orpheus_snac', 'orpheus_tokenizer',
                  'orpheus_backend', 'orpheus_device', 'orpheus_model_dir',
                  'orpheus_base_dir', 'orpheus_lora_ids', 'orpheus_lora_paths',
                  'orpheus_lora_fingerprints', 'orpheus_lora_next_id'):
            if k in LOADED:
                try:
                    del LOADED[k]
                except Exception:
                    LOADED[k] = None

    def cleanup(self):
        """Explicitly release all resources (CUDA, vLLM, etc.)"""
        try:
            # Delete vLLM engine first (releases GPU memory)
            if hasattr(self, 'engine') and self.engine is not None:
                del self.engine
                self.engine = None

            # Delete SNAC decoder
            if hasattr(self, 'snac_model') and self.snac_model is not None:
                del self.snac_model
                self.snac_model = None

            # Delete tokenizer
            if hasattr(self, 'tokenizer') and self.tokenizer is not None:
                del self.tokenizer
                self.tokenizer = None

            # If the process-global cache holds THIS instance's model, evict it too so
            # the weights actually free and the next load reloads. Guarded by BOTH
            # model keys (merged dir and adapter base dir) so a stale instance's
            # __del__ can't clobber a newer, different model.
            try:
                if (LOADED.get('orpheus_model_dir', '\0') == getattr(self, 'custom_model_dir', None)
                        and LOADED.get('orpheus_base_dir', '\0') == getattr(self, 'base_dir', None)):
                    self._evict_global_cache()
            except Exception:
                pass
            self.mlx_model = None

            # Clear CUDA cache
            self._cleanup_memory()
            log("[ORPHEUS] Cleanup complete - resources released")
        except Exception as e:
            log(f"[ORPHEUS] Cleanup warning: {e}")

    def __del__(self):
        """Destructor - ensure cleanup when object is garbage collected"""
        try:
            self.cleanup()
        except Exception:
            pass  # Ignore errors during destruction

    # ---- backend selection --------------------------------------------------

    @classmethod
    def detect_backend(cls) -> str:
        """PUBLIC: which backend Orpheus WOULD use in this process, without loading
        anything.

        BookForge's streaming server reports this on its 'ready' line so the pool
        knows, authoritatively and before any voice is loaded, whether the engine can
        serve a voice PER REQUEST. Only vLLM can (multi-LoRA is a vLLM feature, and
        MLX builds one sampler per batch bucket from the engine's own caps, so even a
        stock per-row prompt token would carry the wrong voice's tuning). Guessing
        that from the OS or from a torch.cuda probe is exactly the kind of parallel
        second implementation that drifts - so it delegates to the same function
        load_engine uses.
        """
        return cls._detect_backend()

    @staticmethod
    def _detect_backend(forced: str = None) -> str:
        """Detect best available backend for this platform.

        Priority:
        1. MLX on Mac (fastest, ~1.4x realtime)
        2. vLLM on CUDA (fast, good for Windows/Linux)
        3. Transformers (slow fallback, ~27x realtime on Mac MPS)

        `forced` is EngineConfig.backend; it beats ORPHEUS_BACKEND, which is the
        e2a-era channel and still honoured. e2a read the env var only.
        """
        import os

        import torch

        is_mac = platform.system() == 'Darwin'
        has_cuda = torch.cuda.is_available()

        # Check for backend override: the constructor's, then the environment.
        # ORPHEUS_BACKEND can be: mlx, vllm, transformers
        forced_backend = (forced or os.environ.get('ORPHEUS_BACKEND', '')).lower()
        if forced_backend:
            log(f"Orpheus: Backend override via ORPHEUS_BACKEND={forced_backend}")
            if forced_backend in ('mlx', 'vllm', 'transformers'):
                return forced_backend
            else:
                log(f"Warning: Unknown backend '{forced_backend}', using auto-detect")

        # Try MLX first on Mac (19x faster than transformers!)
        if is_mac:
            try:
                from mlx_audio.tts.utils import load_model  # noqa: F401
                log("Orpheus: Using MLX backend (Apple Silicon optimized)")
                return 'mlx'
            except ImportError:
                log("Orpheus: MLX not available (install with: pip install mlx-audio)")

        # Try vLLM on CUDA (best for Windows/Linux)
        if has_cuda and not is_mac:
            try:
                from vllm import LLM  # noqa: F401
                log("Orpheus: Using vLLM backend (CUDA detected)")
                return 'vllm'
            except ImportError:
                log("Orpheus: vLLM not available, trying transformers...")

        # Fall back to transformers (works everywhere but slow on Mac)
        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: F401
            backend_device = "MPS" if is_mac else ("CUDA" if has_cuda else "CPU")
            log(f"Orpheus: Using transformers backend ({backend_device})")
            if is_mac:
                log("WARNING: Transformers on Mac MPS is ~27x slower than MLX!")
                log("         Install mlx-audio for much better performance: pip install mlx-audio")
            return 'transformers'
        except ImportError:
            raise ImportError(
                "No Orpheus backend available. Install one of:\n"
                "  Mac: pip install mlx-audio\n"
                "  Windows/Linux: pip install vllm (requires CUDA)\n"
                "  Fallback: pip install transformers"
            )

    def load_engine(self):
        try:
            msg = f"Loading Orpheus TTS with voice '{self.voice}'..."
            log(msg)
            self._cleanup_memory()

            # Check if already loaded - but ONLY reuse the process-global cache when
            # it holds the SAME model. The cache is keyed by engine name ('orpheus'),
            # so without a model-dir check a custom single-speaker finetune
            # (model_dir) would be served from a cache populated by a DIFFERENT
            # model. The voice of a finetune is its WEIGHTS, not just the prompt token,
            # so reusing the wrong weights makes voice switching in the streaming worker
            # silently keep the first-loaded voice. Reload whenever the dir differs.
            #
            # ADAPTER MODE inverts that: the voice is NOT the weights, it is a
            # per-request LoRA over a shared base. So the cache is keyed on the pair
            # (merged dir, base dir), and two adapter voices sharing a base REUSE the
            # engine - never evict it, which is the whole point of the migration (no
            # vLLM reload, no CUDA-graph recapture to switch voice). Both keys are
            # None in stock mode and base_dir is None in merged mode, so a session
            # with no adapter keys compares exactly as it did before.
            engine_key = 'orpheus'
            engine = LOADED.get(engine_key, False)
            cached_dir = LOADED.get('orpheus_model_dir', None)
            cached_base = LOADED.get('orpheus_base_dir', None)
            if engine and cached_dir == self.custom_model_dir and cached_base == self.base_dir:
                self.backend = LOADED.get('orpheus_backend', 'transformers')
                self.snac_model = LOADED.get('orpheus_snac', None)
                self.tokenizer = LOADED.get('orpheus_tokenizer', None)
                self._device = LOADED.get('orpheus_device', 'cpu')
                self.mlx_model = LOADED.get('orpheus_mlx_model', None)
                log(f"Orpheus already loaded (backend: {self.backend}, model_dir: {cached_dir}, "
                      f"base_dir: {cached_base})")
                # A cached MLX model carries whatever adapter the PREVIOUS instance
                # applied to it - the weights are shared, so "same engine" does not
                # mean "same voice". Bring it to this session's adapter (or to the bare
                # base) before returning it, or a second instance over the same base
                # would render its own voice's prompt token through the first voice's
                # LoRA. No-op when they already agree.
                if self.backend == 'mlx' and (self.adapter_dir or
                                              getattr(self.mlx_model, '_orpheus_mlx_lora', None)):
                    self._sync_mlx_adapter(self.mlx_model, self.adapter_dir)
                return engine
            if engine:
                # A different model is cached (switching custom voices, custom<->stock,
                # or merged<->adapter). Evict it so its weights free before we load the new one.
                log(f"Orpheus model changed (cached={cached_dir!r}/{cached_base!r} -> "
                      f"want={self.custom_model_dir!r}/{self.base_dir!r}); reloading")
                self._evict_global_cache()

            # Detect and load appropriate backend
            self.backend = self._detect_backend(self._forced_backend)

            # Adapter mode needs a backend that can actually APPLY a LoRA. vLLM does it
            # per request; MLX does it by wrapping the resident model's projections
            # (_apply_mlx_adapter). The transformers path has no PEFT wiring at all, so
            # it would serve the BARE BASE under the voice's name - a render that
            # sounds finished and is in the wrong voice.
            if self.adapter_dir and self.backend not in ('vllm', 'mlx'):
                raise ValueError(
                    f"Orpheus adapter mode is not supported on the '{self.backend}' backend: "
                    'there is no PEFT wiring there, so the adapter would be silently ignored '
                    'and the base rendered under this voice\'s name. Use vLLM (CUDA) or MLX '
                    '(Apple Silicon), or install this voice as a merged model.'
                )
            # Now that the backend is known, re-validate the adapter against ITS limits.
            # __init__ ran the universal checks before anything loaded; this is the pass
            # that knows whether the rank ceiling or the per-module-pattern rule applies,
            # and it still runs BEFORE a single byte of the base is read.
            if self.adapter_dir:
                self.validate_adapter_dir(self.adapter_dir, self.backend)

            if self.backend == 'mlx':
                engine = self._load_mlx_engine()
                self.mlx_model = engine
                # The base is loaded; the voice is the LoRA on top of it. Applied here
                # rather than lazily at first generate, so a broken adapter fails the
                # LOAD - the one moment a caller is prepared for a voice to be refused.
                if self.adapter_dir:
                    self._apply_mlx_adapter(engine, self.adapter_dir)
            elif self.backend == 'vllm':
                engine = self._load_vllm_engine()
                self._load_snac()
            else:
                engine = self._load_transformers_engine()
                self._load_snac()

            # Cache everything
            LOADED[engine_key] = engine
            LOADED['orpheus_backend'] = self.backend
            LOADED['orpheus_snac'] = self.snac_model
            LOADED['orpheus_tokenizer'] = self.tokenizer
            LOADED['orpheus_device'] = self._device
            LOADED['orpheus_mlx_model'] = self.mlx_model
            LOADED['orpheus_model_dir'] = self.custom_model_dir
            LOADED['orpheus_base_dir'] = self.base_dir

            # Register the session's own adapter against the FRESH engine, with its
            # content fingerprint. Doing it here rather than in __init__ matters: the
            # eviction above wipes the registry, so anything registered earlier would
            # be gone. Without this the first registration would happen lazily on the
            # first request, with no fingerprint - and a later re-install of the same
            # voice would then have nothing to compare against.
            #
            # vLLM only: the registry maps a voice to the int id vLLM caches its weights
            # under, and MLX has no such cache - its adapter is applied to the model and
            # its content identity is tracked by _MlxAdapterState.fingerprint instead.
            if self.adapter_dir and self.backend == 'vllm':
                self._register_lora(self.voice, self.adapter_dir,
                                    self._adapter_fingerprint(self.adapter_dir))

            log('Orpheus TTS Loaded!')
            return engine

        except Exception as e:
            error = f'OrpheusEngine.load_engine() error: {e}'
            import traceback
            traceback.print_exc()
            raise ValueError(error)

    # ---- the file-writing API (worker_core calls these) ---------------------

    def convert(self, sentence_index: int, sentence: str) -> bool:
        try:
            if not self.engine:
                log("Orpheus TTS engine not loaded!")
                return False

            lead_gap, trail_gap = self._classify_gap(sentence)
            clean = self._clean_sentence_for_tts(sentence)
            if not clean:
                return self._write_silence(sentence_index)

            try:
                if self.backend == 'mlx':
                    audio_np = self._generate_mlx(clean, sentence_index=sentence_index)
                    # Backstop a silent early-EOS truncation (audio too short for text).
                    # force_split: a whole-chunk re-render would just clean-EOS
                    # (truncated) again - the resplit must actually split.
                    audio_np = self._guard_truncation(
                        sentence_index, clean, audio_np,
                        lambda c: self._generate_mlx_safe(c, force_split=True)
                    )
                    # ...and REPORT the opposite failure on a sub-floor chunk: audio
                    # far LONGER than the text can justify (a heading spoken twice).
                    # Reported only - the take stands; see the SHORT_CHUNK_* block.
                    self._report_short_chunk_overrun(sentence_index, clean, audio_np)
                elif self.backend == 'vllm':
                    try:
                        audio_np = self._tokens_to_audio(self._generate_tokens_vllm(clean))
                    except TokenStreamMisaligned as align_err:
                        # Stochastic sampling glitch - one re-render (fresh tokens)
                        # almost always fixes it. If it misaligns again, let it fail.
                        log(f"Orpheus: sentence {sentence_index} token stream misaligned ({align_err}); re-rendering once")
                        audio_np = self._generate_audio_vllm_safe(clean)
                    # Backstop a silent early-EOS truncation (audio too short for text).
                    audio_np = self._guard_truncation(
                        sentence_index, clean, audio_np,
                        lambda c: self._generate_audio_vllm_safe(c, force_split=True)
                    )
                    # ...and REPORT the opposite failure on a sub-floor chunk.
                    self._report_short_chunk_overrun(sentence_index, clean, audio_np)
                    # ASR verify gate: right length, wrong WORDS (mid-chunk
                    # derailment on dates/citations). Risk-flagged chunks only.
                    audio_np = self._asr_verify_or_retry(
                        sentence_index, clean, audio_np, self._generate_audio_vllm_safe)
                else:
                    audio_np = self._tokens_to_audio(
                        self._generate_tokens_transformers(f"{self.voice}: {clean}")
                    )
                ok = self._save_audio(sentence_index, audio_np, lead_gap, trail_gap)
                self._cleanup_memory()
                return ok
            except Exception as gen_error:
                log(f"Orpheus generation error for sentence {sentence_index}: {gen_error}")
                import traceback
                traceback.print_exc()
                if is_fatal_cuda_error(gen_error):
                    # Poisoned CUDA context: nothing else in this process can
                    # succeed. Die loudly so the worker respawns fresh.
                    raise
                return False

        except Exception as e:
            if is_fatal_cuda_error(e):
                raise
            log(f'OrpheusEngine.convert() error: {e}')
            import traceback
            traceback.print_exc()
            return False

    def convert_batch(self, items: list) -> list:
        """Convert many sentences in ONE vLLM generate() call.

        items: list of (sentence_index, sentence). Returns list[bool] aligned to items.

        vLLM is built to run many prompts at once: batching is faster (real
        concurrency) AND collapses tens of thousands of single-prompt calls into
        ~len(book)/BATCH_SIZE calls, which avoids the steady host-RAM growth the
        per-call path caused over a long book. MLX has its own batched path
        (_convert_mlx_batch); transformers falls back to per-item convert().

        `items` is batch_pool_size long: BATCH_SIZE on vLLM, and on MLX either
        BATCH_SIZE or 4 x BATCH_SIZE when continuous batching is on (see
        batch_pool_size). _convert_mlx_batch re-slices it against the MLX memory
        budget, so an MLX batch is never WIDER than BATCH_SIZE and may be narrower.
        """
        if self.backend == 'mlx' and self.mlx_model:
            return self._convert_mlx_batch(items)
        if self.backend != 'vllm' or not self.engine:
            return [self.convert(idx, s) for idx, s in items]
        try:
            return self._convert_vllm_batch(items)
        except Exception as e:
            log(f'OrpheusEngine.convert_batch() error: {e}')
            import traceback
            traceback.print_exc()
            if is_fatal_cuda_error(e):
                # A poisoned CUDA context: nothing else in this process can
                # succeed. Die loudly so the worker respawns fresh.
                raise
            # A batch-level failure FAILS THE BATCH, by name. It used to re-render
            # every row through convert() one at a time - a try-A-then-B that hid
            # whatever broke the batch behind a slower success (Owen, 2026-09-05:
            # "did you say fallback"). The rows are reported failed; the worker's
            # failed list and resume are the recovery, and the log says why.
            indices = [idx for idx, _ in items]
            log(f'OrpheusEngine.convert_batch() FAILED {len(items)} row(s) '
                f'{indices[0]}..{indices[-1]} together ({type(e).__name__}: {e}); '
                'not re-rendering them one by one - a batch that breaks is reported, '
                'not retried.')
            return [False] * len(items)

    # ---- fast-start streaming (the serve worker calls this) -----------------
    #
    # THE FEATURE, in one paragraph (2026-09-04). Without it the browser
    # extension waits ~30 s before the first word: a sentence is generated whole,
    # decoded whole, and only then does any audio leave the worker, and the
    # client gates playback on a cushion on top of that. Fast start does not
    # change batching width, scheduling, sampling or the guards - it changes WHEN
    # audio leaves: a streamed row's audio is windowed-decoded and emitted every
    # ~0.34 s while the row is still generating. It is an EXPERIMENTAL mode
    # behind a switch that ships OFF (the extension's "buffer before playing" is
    # ON by default); with the switch on, nothing here is called and no byte of
    # the old path changes.
    #
    # THE ONE RULE THAT SHAPES EVERYTHING: audio that has been emitted has been
    # HEARD. Nothing can retract it. So a streamed row gets no re-render, no
    # resplit and no retake - the truncation guard's verdict is taken and LOGGED
    # (that is what the [ORPHEUS][STREAM] lines are for) and the audio stands.

    def generate_batch_stream(self, texts: list, voices: list, stream_rows: set,
                              on_chunk, on_row, should_stop=None) -> None:
        """Generate a batch, streaming sub-sentence audio for `stream_rows`.

        texts[i]   - ALREADY cleaned/normalized by the caller, exactly as
                     _generate_mlx_batch_audio receives them today. Nothing here
                     re-runs _clean_sentence_for_tts. A row that is blank after
                     cleaning is REFUSED with a ValueError naming it, not
                     answered: callers filter empty rows before calling, and the
                     worker answers them as silence itself, so answering one here
                     could only mislabel a deliberate gap as a failed sentence.
        voices[i]  - that row's voice, or None for this engine's loaded voice.
                     May be None entirely (every row on the loaded voice). vLLM
                     resolves prompt token, sampling caps AND adapter per row;
                     MLX serves exactly one voice, so a per-row voice naming
                     anything else is REFUSED here rather than rendered with the
                     wrong tuning.
        stream_rows- indices to stream. Rows outside it are rendered and
                     delivered exactly as they are today.
        on_chunk(i, seq, audio_float32) - one emitted payload of row i, seq
                     counting from 0 for that row. Streamed rows only.
        on_row(i, audio_float32_or_None) - the row is finished. For a streamed
                     row `audio` is the CONCATENATION of what was streamed (the
                     caller uses it for duration/metrics only, never to re-send
                     the audio); None means the row failed and whatever chunks
                     were already sent should be discarded.
        should_stop() - checked once per decode step. When it goes true the
                     batch is ABANDONED where it stands: rows that have not been
                     delivered get no on_row at all, so a caller can never
                     mistake an abandoned row for a finished one.

        CALLBACK THREADING. on_chunk and on_row may be invoked from a DECODER
        THREAD, not from the thread that called this. On MLX that is the norm
        (the windowed decodes run on the one cross-thread mlx stream, so
        generation is not stalled by SNAC); on vLLM everything runs on the
        calling thread. A caller whose sink is not thread-safe - and the
        streaming worker's stdout, which IS the JSON-lines protocol, is exactly
        such a sink - must queue these callbacks and drain them on its own
        thread.

        AND THE SINK MUST NOT BLOCK. The obvious way to make the callbacks
        thread-safe is a queue the caller's main thread drains - but that main
        thread is the one blocked inside this call, so a BOUNDED queue would
        deadlock: the decoder thread waits for space, the join waits for the
        decoder thread, and nothing drains until MLX_DECODE_JOIN_SECONDS (600 s)
        expires and the batch is declared wedged. Use an unbounded queue, or
        write straight through under a lock; never a bounded put that waits.
        """
        import sys
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'OrpheusEngine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'OrpheusEngine.generate_batch_stream: stream_rows names row(s) {stray} '
                f'outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'OrpheusEngine.generate_batch_stream: stream_rows is non-empty but no '
                'on_chunk was given; there would be nowhere for the streamed '
                'audio to go')
        # A BLANK ROW IS A CALLER ERROR, not a row to answer. This method's
        # contract is one on_row per row, and neither backend can generate
        # anything from empty text - so a blank row could only ever be answered
        # as a FAILURE, which is a lie: the worker's own contract is that an
        # empty sentence becomes a short silence, and the worker already applies
        # it before calling here.
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'OrpheusEngine.generate_batch_stream: row(s) {blank} have no text after '
                'cleaning. Callers filter empty rows before calling; the worker '
                'answers them as silence itself.')
        # stderr, not stdout: this lands mid-batch and the streaming worker's
        # stdout is the protocol. Once per batch, as the contract specifies.
        log(f'[ORPHEUS][STREAM] fast-start: streaming {len(stream_rows)} of '
              f'{len(texts)} rows', flush=True)
        if self.backend == 'vllm':
            self._generate_batch_stream_vllm(texts, voices, stream_rows,
                                             on_chunk, on_row, should_stop)
            return
        if self.backend == 'mlx':
            # ONE voice per MLX engine: the bucket's sampler and adapter come
            # from this instance's own caps, so a row asking for another voice
            # could get its prompt token and never its tuning.
            for i, v in enumerate(voices if voices is not None else ()):
                if v is not None and v != self.voice:
                    raise ValueError(
                        f'OrpheusEngine.generate_batch_stream: row {i} asks for voice '
                        f'{v!r} but the MLX backend has {self.voice!r} loaded; '
                        'MLX serves exactly one voice at a time')
            self._generate_mlx_batch_audio(texts, on_row=on_row,
                                           should_stop=should_stop,
                                           stream_rows=stream_rows,
                                           on_chunk=on_chunk)
            return
        raise NotImplementedError(
            f'OrpheusEngine.generate_batch_stream: the {self.backend!r} backend has no '
            'streaming path. Fast start needs per-step access to the generated '
            'tokens, which vLLM (LLMEngine.step) and MLX (BatchGenerator) give '
            'and transformers.generate() does not - it returns only when the '
            'whole sequence is done. Render this batch through the ordinary '
            'non-streaming path instead.')
