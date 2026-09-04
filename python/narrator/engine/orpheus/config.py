"""What the engine is configured WITH, and every default it falls back to.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py: the
whole class-constant block of `class Orpheus` (lines 211-761) plus the parts of
`Orpheus.__init__` that read the e2a session dict.

TWO THINGS LIVE HERE.

`EngineConfig` replaces the e2a `session` DictProxy. e2a's engine reached into a
multiprocessing dict for `tts_engine`, `fine_tuned`, `orpheus_model_dir`,
`orpheus_adapter_dir`, `orpheus_base_dir`, `sentences_dir` and `process_dir`;
those are now named fields with types. Nothing else of the session was ever read
by orpheus.py (see PORT_NOTES.md for the enumeration).

`EngineDefaults` is every tuning constant, kept as CLASS ATTRIBUTES of the
engine (OrpheusEngine inherits it) because that is how they are read today -
`self.MAX_AUDIO_TOKENS`, `cls.LORA_MAX_RANK`, and the tests that set
`Orpheus.SHORT_CHUNK_MAX_CHARS = 0` to silence a report. Turning them into
dataclass fields would have changed all three call shapes; the values, the env
var names and the comments are unchanged.

Env vars are read at IMPORT here exactly as they were at import of orpheus.py.
The per-voice caps (narrator.engine.caps) are what re-read them per call.

No torch, no vLLM, no mlx.
"""
import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class EngineConfig:
    """Everything one OrpheusEngine instance is built from.

    `voice` is e2a's `session['fine_tuned']`: the voice TOKEN, which for a
    fine-tune is also its adapter-registry key. 'internal' is e2a's
    conf_models.default_fine_tuned sentinel for "--fine_tuned was never
    passed" and is refused in adapter mode, exactly as before.

    Exactly one of `model_dir` (a merged fine-tune - the voice IS the weights)
    or `base_dir` (+ optional `adapter_dir`) may be set; see
    OrpheusEngine._validate_adapter_mode for the three legal shapes.

    `sentences_dir` and `process_dir` are the SessionStore's, and only the
    file-writing half of the engine touches them: `sentences_dir` is where
    convert()/convert_batch() write `<index>.flac`, `process_dir` is what
    `_reject_dir()` derives the post-mortem directory from. Both may be None
    for an in-memory caller (the streaming server), which is exactly the
    "no session" case `_reject_dir` already handled.

    `caps` is the catalog payload BookForge passes as `orpheusVoiceCapsForModel`
    (camelCase keys). When present it is registered for `voice` at construction,
    which is what the resident streaming worker does with its 'load' message.
    Absent, the ORPHEUS_* environment is the channel, as for the audiobook
    worker.

    `backend` forces 'vllm' | 'mlx' | 'transformers'; None auto-detects. It is
    the constructor form of ORPHEUS_BACKEND, which is still honoured.

    THERE IS DELIBERATELY NO `language` AND NO `reject_dir` FIELD. orpheus.py
    read neither: the engine has no language-dependent behaviour at all (the
    prompt is `voice: text`, the guards measure characters), and the reject
    directory is ORPHEUS_REJECT_DIR's alone - see _reject_dir. Both were on this
    dataclass in an earlier draft of the port and were removed in review: an
    unread field invites a caller to set it and expect something, and a second
    source for the reject path would have changed where evidence lands whenever
    the env var was unset.
    """
    voice: Optional[str] = None
    model_dir: Optional[str] = None
    adapter_dir: Optional[str] = None
    base_dir: Optional[str] = None
    sentences_dir: Optional[str] = None
    process_dir: Optional[str] = None
    caps: Optional[dict] = None
    backend: Optional[str] = None
    audio_format: str = 'flac'


class EngineDefaults:
    """Every Orpheus tuning constant, verbatim from e2a's class body."""

    # Valid Orpheus voices (leah has best quality, tara has echo artifacts).
    # Custom finetunes are NOT listed here - they arrive via a folder-discovered
    # model dir (config.model_dir) and bypass this allowlist.
    VALID_VOICES = {'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'}
    DEFAULT_VOICE = 'leah'

    # Model configuration
    # MLX model (for Mac): mlx-community/orpheus-3b-0.1-ft-bf16
    # Transformers/vLLM model: unsloth/orpheus-3b-0.1-ft
    MLX_MODEL = "mlx-community/orpheus-3b-0.1-ft-bf16"
    TRANSFORMERS_MODEL = "unsloth/orpheus-3b-0.1-ft"
    SAMPLE_RATE = 24000

    # ---- Adapter mode --------------------------------------------------------
    #
    # One shared base model + a per-voice LoRA adapter, instead of one 6.6 GB merged
    # model per voice. Selected by config.base_dir (the base) + config.adapter_dir
    # (this voice's adapter); config.voice carries the voice token the adapter was
    # trained on.
    #
    # TWO backends apply it, and they are not the same mechanism:
    #   vLLM  PER REQUEST, as a LoRARequest over a multi-LoRA engine. Several voices
    #         are servable at once and one batch may mix them. The voice token is also
    #         its key in the process-global adapter registry (_register_lora), and the
    #         LORA_* constants below size that engine.
    #   MLX   APPLIED to the resident model by wrapping its projection modules
    #         (_apply_mlx_adapter). Exactly ONE voice is servable at a time; a switch
    #         swaps the wrappers, which costs ~a second instead of a 6.2 GB reload.
    #         None of the LORA_* constants below apply - see
    #         _validate_adapter_config_mlx for what MLX refuses instead.
    #
    # max_lora_rank must be one of vLLM 0.7.3's legal values (8/16/32/64/128/256)
    # and >= the adapter's own r; every deployed Orpheus adapter is r=64.
    # max_loras is how many DISTINCT adapters one batch may mix - the audiobook
    # worker renders one voice per process, so 1. max_cpu_loras is the host-side
    # adapter cache.
    #
    # lora_extra_vocab_size is deliberately NOT passed, leaving vLLM's default 256:
    # 0 crashes 0.7.3's startup warmup, where create_dummy_lora_weights allocates a
    # hardcoded 10-row embeddings tensor that cannot be copied into a 0-row buffer.
    # The padding is harmless for a non-embedding adapter - LogitsProcessorWithLoRA
    # fills the padded vocab with -inf, so those ids can never be sampled (measured:
    # 0 of 29,119 generated tokens landed outside the base vocab).
    LORA_MAX_RANK = 64
    LORA_MAX_LORAS = 1
    LORA_MAX_CPU_LORAS = 4

    # Batched inference (vLLM): feed many prompts to ONE engine.generate() call.
    # This is how vLLM is meant to be driven - it's faster (real batching) AND
    # avoids the host-RAM creep from tens of thousands of single-prompt calls over
    # a long book. The worker honors SUPPORTS_BATCH/BATCH_SIZE.
    # Override the size with ORPHEUS_BATCH_SIZE.
    SUPPORTS_BATCH = True
    BATCH_SIZE = int(os.environ.get('ORPHEUS_BATCH_SIZE', '16'))

    # Max audio tokens per MLX batched generation. Rows that hit this cap without
    # emitting the end-of-audio token would ship CLIPPED audio; the batch paths
    # detect that and re-render the row split at sentence boundaries
    # (_generate_mlx_safe with force_split, the cap being already proven),
    # mirroring the vLLM ladder below.
    #
    # 3700 matches MAX_AUDIO_TOKENS (the vLLM cap): ~8 audio tokens/char means the
    # ~450-char packed chunks need ~2500-3400 tokens, so the old 2048 default made
    # nearly EVERY prose chunk overflow into the split ladder - and those split
    # boundaries were a measured junk source. Validated 2026-07-08 on the 13-chunk
    # real-book set (M1 Ultra): 2048 -> 11 cap-hits, 12.1% WER, 1 catastrophic row,
    # ~310s; 3700 -> 0 cap-hits, 3.5% WER (Whisper noise floor), 0 catastrophic,
    # ~105s (2.8x faster), peak memory ~13.7 GB (vs ~14.2 at 2048).
    MLX_MAX_TOKENS = int(os.environ.get('ORPHEUS_MLX_MAX_TOKENS', '3700'))

    # ---- MLX repetition-penalty window -------------------------------------
    #
    # How far back the repetition penalty looks. mlx_lm's own default is 20
    # tokens (~0.24s of audio at 84 tok/s), and that is what this ran on until
    # 2026-08-21. It is far too short for SILENCE: a pause is a run of repeated
    # silence tokens, so once a pause passes a quarter second it falls out of
    # the window and the penalty stops discouraging it - the pause is free to
    # run on. vLLM applies the same penalty over the FULL context, which is why
    # the identical voice paused normally there and dragged here.
    #
    # 4096 exceeds MLX_MAX_TOKENS, so the window is effectively the whole
    # generation and the two backends now shape pauses the same way. Measured
    # on a 58-chunk God's People slice (thirdreich, M1 Ultra, width 96):
    #   window 20   -> 650s, 4 cap-hits, 38.5% silence, pause p90 2.34s, max 6.37s
    #   window 4096 -> 377s, 0 cap-hits, 30.9% silence, pause p90 1.63s, max 3.65s
    # (vLLM reference for the same voice: 31.0%, p90 1.68s, max 2.92s.)
    # Speech seconds went UP 2.3% while silence fell 26.9% - it removes dead
    # air, it does not clip. Killing the cap-hits also kills the serial
    # re-render ladder those trigger, which is the larger win on a full book.
    #
    # 8192, not 4096 (2026-09-01). The stated intent above is "the window is
    # effectively the whole generation", and 4096 only ever delivered that by
    # accident: the window is measured over the KV cache, which is PROMPT PLUS
    # generation, so at the 3700-token cap it covered the whole thing only while
    # the prompt stayed under 396 tokens (~1,500 chars). Real chunks frame to
    # ~140 tokens so nothing observable changes today - this closes a latent
    # cliff where a long chunk would silently drop back to a partial window, and
    # it is the exactness condition the MLX fast path (mlx_fastpath) checks at
    # load and again on every step.
    MLX_REP_WINDOW = int(os.environ.get('ORPHEUS_MLX_REP_WINDOW', '8192'))

    # ---- MLX decode overlap -------------------------------------------------
    #
    # A batch's rows retire CONTINUOUSLY, but until 2026-09-02 nothing was decoded
    # until every row had. Measured on a 106-chunk width-96 production run:
    # generation of batch 1 ended at ~413 s and the next batch did not start until
    # ~495 s - ~80 s (13% of a 601 s job) spent in the post-batch loop
    # (parse_output -> SNAC decode -> guard -> FLAC write, serially) with the GPU's
    # generation loop STOPPED. The same run had 1/96 rows retired by step 199,
    # 50/96 by 2174 and 93/96 by 2715, so nearly all of that work could have run
    # while the batch was still generating.
    #
    # With overlap on, a retired row is handed to ONE decoder thread the moment its
    # finish_reason lands; the thread does only the cheap, model-free half (decode,
    # the truncation VERDICT, the file write) and defers anything that would need
    # the model back to the main thread after bg.close(). The single-sentence
    # re-render ladder therefore NEVER runs next to a live BatchGenerator, so the
    # memory profile of that path is exactly what it was.
    #
    # ORPHEUS_MLX_DECODE_OVERLAP=0 restores the serial post-batch loop - the A/B
    # control, and the escape hatch if a thread ever proves to be the wrong tool.
    MLX_DECODE_OVERLAP = os.environ.get('ORPHEUS_MLX_DECODE_OVERLAP', '1') != '0'

    # How long to wait for the decoder thread after the batch ends. Its remaining
    # work at that point is at most the last few rows' SNAC decodes (~a second
    # each), so 10 minutes is not a tuning knob - it is the line past which the
    # thread is WEDGED and must be reported as an error rather than waited on.
    MLX_DECODE_JOIN_SECONDS = 600.0

    # ---- MLX continuous batching (EXPERIMENT) -------------------------------
    #
    # DEFAULT IS OFF (Owen, 2026-09-02) - MEASURED and retired. Honestly budgeted
    # (MLX_KV_MB_PER_TOKEN_ROW_STEADY: the steady state IS width x depth) it gets 36
    # rows at a 42 GB budget, and on a real book it ran 218 ms/step against the
    # fresh-group path's 111-180 at width 64: every refilled row is left-padded to
    # the oldest live row (BatchKVCache.extend) so every slot pays the straggler's
    # context, and each retirement/refill rebuilds the cache tensors. 13 sent/min
    # vs 40-50. The straggler tail it was meant to fix has a cheaper answer that
    # costs no memory: sort a slice by expected length before grouping. The code
    # stays as an opt-in measurement (ORPHEUS_MLX_CONTINUOUS=1); the width it
    # announces is the safe one.
    MLX_CONTINUOUS = os.environ.get('ORPHEUS_MLX_CONTINUOUS', '0') == '1'

    # How many rows the WORKER should pool per convert_batch call when continuous
    # batching is on (batch_pool_size). A continuous generator can only refill a
    # retired slot from rows it has been GIVEN, so a pool of exactly BATCH_SIZE
    # would leave it nothing to refill with and collapse it back into a fresh
    # group per call. 0 (the default) means 4 x BATCH_SIZE, resolved per instance
    # so an ORPHEUS_BATCH_SIZE override carries.
    MLX_CONTINUOUS_POOL = int(os.environ.get('ORPHEUS_MLX_CONTINUOUS_POOL', '0') or 0)

    # How many queued prompts one refill prefills at once (prefill_batch_size).
    # Prefill interleaves with full-width decode, so this is the knob that trades
    # refill latency against the memory spike July measured (36 GB peak at width
    # 96). Capped at the batch width by the caller.
    MLX_CONTINUOUS_PREFILL = int(os.environ.get('ORPHEUS_MLX_CONTINUOUS_PREFILL', '16'))

    # ---- MLX batch memory budget -------------------------------------------
    #
    # KV cache is the dominant term and it scales with width x depth: MEASURED
    # 0.1147 MB per token per row (28 layers, 8 KV heads, head_dim 128, bf16 =>
    # 28*2*8*128*2 bytes). 96 rows x 3700 tokens would be ~40.7 GB of KV alone,
    # plus ~6.9 GB weights plus the 8 GB buffer cache = ~55 GB - far too close to
    # a 64 GB ceiling. So _mlx_batch_groups derives a per-batch WIDTH cap from the
    # batch's own token depth (see _mlx_width_for_depth) targeting this budget.
    MLX_MEM_BUDGET_GB = float(os.environ.get('ORPHEUS_MLX_MEM_BUDGET_GB', '45'))
    # ARITHMETIC KV bytes per generated token per row, in MB: 28 layers x (K+V) x
    # 8 kv heads x 128 dims x 2 bytes. This is what the cache HOLDS. It is NOT what
    # the process PEAKS at - see MLX_KV_MB_PER_TOKEN_ROW_STEADY.
    MLX_KV_MB_PER_TOKEN_ROW = 0.1147
    # MEASURED peak memory per generated token per row, in MB (2026-09-01, bf16,
    # depth 1800, mx.get_peak_memory, cache excluded): width 12 -> 10.8 GB,
    # 48 -> 23.7, 96 -> 40.8. Every pair gives the same slope, 0.203 MB/token/row,
    # 1.77x the arithmetic figure, with a 6.5 GB intercept (the weights). The
    # GROUP path survives the arithmetic bound because rows retire long before the
    # batch reaches width x depth (measured real-book peak 26.9 GB at width 96
    # against a 55 GB bound). CONTINUOUS batching does not: a refilled row is
    # padded to the oldest live row, so the batch sits at full width x full depth
    # for the whole run - the worst case IS the steady state, and it must be
    # budgeted with the measured coefficient.
    MLX_KV_MB_PER_TOKEN_ROW_STEADY = 0.203
    # Resident bf16 weights for orpheus-3b, in GB (measured at load).
    MLX_WEIGHTS_GB = 6.9

    # Max audio tokens per generation. ~8 audio tokens/char, so ~3700 covers the
    # ~450-char multi-sentence chunks the packer feeds Orpheus while staying under
    # the 4096 model context (prompt + audio). A chunk that would exceed this is
    # re-rendered split at sentence boundaries (see _generate_audio_vllm_safe) so
    # the audio is never clipped. Override with ORPHEUS_MAX_TOKENS.
    MAX_AUDIO_TOKENS = int(os.environ.get('ORPHEUS_MAX_TOKENS', '3700'))

    # Audio-token <-> wall-clock relationship. Orpheus emits 7 audio tokens per
    # SNAC frame (_redistribute_codes); the SNAC-24kHz coarse-frame rate is ~12 Hz,
    # so ~84 audio tokens == 1 second of audio. Rounded UP to 84 because it only
    # sizes a per-chunk max_tokens CEILING (_mlx_token_budget), where a larger
    # value is the safe direction.
    TOKENS_PER_AUDIO_SECOND = 84

    # Truncation-guard rate, in characters of TEXT per second of AUDIO: above this,
    # the audio is too short for the text and the chunk is re-rendered split
    # (_needs_resplit). 19.0 is e2a's documented default for an UNCATALOGUED voice;
    # a catalogued one is given its own value through ORPHEUS_MAX_CHARS_PER_SEC
    # (BookForge passes e.g. 23.5 for deathstalker), and 0 disables the guard.
    #
    # This is the DEFAULT only - never the live value. Read it through
    # _max_chars_per_sec(), which resolves per voice on EVERY call (registered cap
    # -> env -> this default; see VOICE_CAP_SOURCES): the resident streaming worker
    # switches voices in-process, so a value captured at import or construction
    # would pin the first voice's threshold onto every later one.
    DEFAULT_MAX_CHARS_PER_SEC = '19.0'

    # Sampling params at the Orpheus reference values. Temperature: back at the 0.6
    # upstream reference (2026-07-13) as the clean baseline for the retrained
    # voices. All three override via env so they can be A/B-tuned live
    # (ORPHEUS_TEMPERATURE / ORPHEUS_TOP_P / ORPHEUS_REP_PENALTY).
    TEMPERATURE = float(os.environ.get('ORPHEUS_TEMPERATURE', '0.6'))
    TOP_P = float(os.environ.get('ORPHEUS_TOP_P', '0.8'))
    # Rep penalty 1.1: the penalty is the PAUSE governor (audio silence tokens
    # repeat; ladder-proven 2026-07-12: 1.0 = pauses sprawl to 2x runtime +
    # token-cap runaways, 1.05/1.07 = audibly long, 1.1 = right) but it also
    # chokes legitimately repeating codes mid-vowel, causing occasional breathy
    # voicing "cracks". Owen chose pauses-right over cracks-fewer; the real fix
    # is retrain-side.
    REP_PENALTY = float(os.environ.get('ORPHEUS_REP_PENALTY', '1.1'))
    # min_p drops tokens below this fraction of the top token's probability -
    # cuts the rare-junk tail without flattening expressive variety the way
    # lowering top_p does (confidence-scaled cutoff vs fixed probability mass).
    # Applied on the vLLM paths and the MLX BATCH paths (mlx_lm make_sampler
    # takes min_p). The MLX single-sentence path can't honor it: mlx_audio's
    # llama Model.generate builds its own sampler and only forwards top_k /
    # repetition_penalty from kwargs, so min_p would be silently dropped there.
    # Default 0 = off, matching upstream.
    MIN_P = float(os.environ.get('ORPHEUS_MIN_P', '0.0'))

    # EOS logit boost (2026-07-21, ghost-whisper campaign): voices trained on
    # bed-free corpora carry a thinner GREEDY end-of-speech margin (mb_2hd:
    # 15/20 greedy stops vs bed model's 20/20) - runaways are EOS losing
    # razor-thin ties to "one more audio frame". This adds a small bias to the
    # EOS logit, but ONLY once generation is past EOS_BOOST_START x the
    # chunk's expected token count (derived from text length), so it cannot
    # truncate speech that hasn't been spoken yet. Past that point the bias
    # ramps with the overrun. Default 0 = OFF; enable per-voice via
    # models.json backends.vllm.eosBoost, which reaches this either as the
    # registered 'eosBoost' cap (streaming) or as ORPHEUS_EOS_BOOST (audiobook
    # worker spawn env). vLLM paths only.
    EOS_BOOST = float(os.environ.get('ORPHEUS_EOS_BOOST', '0.0'))
    EOS_BOOST_START = float(os.environ.get('ORPHEUS_EOS_BOOST_START', '1.2'))

    # EOS minimum-length FLOOR (2026-09-03): the mirror of the boost. On the
    # mistborn 240-draw battery every fine-tune shows EARLY stops at 30-60% of
    # the text (ASR-verified), 5-15 per 240 depending on epoch, on top of the
    # loops the boost exists for; the served models only ever caught the fast
    # ones after the fact, via the maxCharsPerSec rate guard and a re-render.
    # This refuses END_OF_SPEECH at decode time instead: while a request has
    # generated fewer than EOS_FLOOR x its expected token count, the EOS logit
    # is -inf. Expected = chars / EOS_FLOOR_RATE ch-per-s x TOKENS_PER_AUDIO_SECOND,
    # a pure SPEECH estimate at the voice's MEDIAN rate (15.0 default; the
    # catalog can set a per-voice p50 through eosFloorRate). No tail allowance:
    # the model's flat tail only makes a real clip LONGER than the estimate, so
    # leaving it out keeps the floor one-directional safe. The honest fast reads
    # sit at >= 0.75 of expected and the truncations at 0.3-0.6, hence 0.55.
    #
    # THE INVARIANT that makes the floor safe: it forbids EOS exactly on a read
    # faster than EOS_FLOOR_RATE / EOS_FLOOR chars per second (15 / 0.55 = 27.3),
    # and a read that fast is one the rate guard (maxCharsPerSec) would already
    # reject and re-render. _eos_floor_tokens REFUSES a configuration where that
    # rate drops below the guard's, because a floor tighter than the guard would
    # gag the model past a correct ending and force it to invent audio.
    #
    # Independent of the boost: it never touches the boost's ramp (which starts
    # at eosBoostStart x a DIFFERENT expectation, _expected_audio_tokens), and the
    # two can never both be active at one step. Per request, sized from that
    # request's own prompt, so a batch is safe. Default 0 = OFF. vLLM only - the
    # MLX port is a separate job because mlx-lm's processor counts PROMPT tokens
    # in its context, so the same arithmetic would land the floor in the wrong
    # place there; a floor configured on MLX raises.
    EOS_FLOOR = float(os.environ.get('ORPHEUS_EOS_FLOOR', '0.0'))
    EOS_FLOOR_RATE = float(os.environ.get('ORPHEUS_EOS_FLOOR_RATE', '15.0'))

    # Tail allowance for a chunk's expected token count, in AUDIO TOKENS
    # (2026-08-28, short-heading repeat). The expected-length estimate every
    # anti-runaway lever is sized from is `chars / 18.4 ch-per-s x 84 tokens-per-s`
    # - a pure SPEECH estimate that forgets the model's own trained tail. Orpheus
    # emits that tail as part of the generation (nothing trims it: the save-time
    # trim was removed 2026-07-11, NO-FALLBACK), and it does NOT scale with the
    # text: deathstalker's catalog measures modelSelfTailS 0.81 s, and the 52
    # short chunks of the witches render measured a mean trailing silence of
    # 0.824 s whether the chunk was 4 chars or 59.
    #
    # 96 tokens = 1.14 s at TOKENS_PER_AUDIO_SECOND, swept against those 52 real
    # chunks. Every value in [84, 110] engages the EOS boost before the known
    # doubled take ("Introduction.", 13 chars, 358 tokens) and engages on NO
    # healthy clip; below 84 healthy clips start being boosted mid-speech (at 71
    # "Turtles", at 60 "NEW AGE."), and above ~110 the doubled take escapes again.
    SHORT_CHUNK_TAIL_TOKENS = float(os.environ.get('ORPHEUS_SHORT_TAIL_TOKENS', '96'))

    # Short-chunk overrun REPORT (2026-08-28). A sub-floor chunk whose audio runs
    # far longer than its text can justify - the model saying a two-word heading
    # twice instead of stopping - is PRINTED and then left exactly as it is.
    #
    # THIS MEASURES A MODEL DEFECT. IT DOES NOT COMPENSATE FOR ONE. Nothing is
    # re-rendered, nothing is selected, nothing is thrown away; the count is a
    # trend line for the retrain (grep -c SHORT_CHUNK_OVERRUN <log>).
    #
    # The curve `max_seconds = 0.9 + 0.19 x chars` is measured, not guessed:
    # against all 52 non-empty short chunks of the witches render it names the
    # known doubled take ("Introduction.", 13 chars, 4.267 s vs 3.37 s allowed)
    # and NOTHING else. Judged on the generated waveform BEFORE _save_audio
    # appends the inter-clip gaps.
    SHORT_CHUNK_OVERRUN_TAG = 'SHORT_CHUNK_OVERRUN'

    # One machine-readable line per guard fire, on stdout, so an orchestrator can
    # count runaways and truncations without reaching into the worker's filesystem
    # (on Windows the worker runs inside WSL, where its scratch is not a path the
    # host can conveniently read). The prose prints stay: they are what a person
    # watching the console reads. This is the same event, in a form a parser can
    # trust - tag, then one compact JSON object, on a single line.
    GUARD_EVENT_TAG = 'ORPHEUS_GUARD_EVENT'
    SHORT_CHUNK_MAX_CHARS = int(os.environ.get('ORPHEUS_SHORT_CHUNK_CHARS', '25'))
    SHORT_CHUNK_SECONDS_BASE = float(os.environ.get('ORPHEUS_SHORT_CHUNK_SECONDS_BASE', '0.9'))
    SHORT_CHUNK_SECONDS_PER_CHAR = float(os.environ.get('ORPHEUS_SHORT_CHUNK_SECONDS_PER_CHAR', '0.19'))

    # PEFT stores a LoRA as, per targeted projection:
    #   base_model.model.model.layers.N.<self_attn|mlp>.<proj>.lora_A.weight  (r, in)
    #   base_model.model.model.layers.N.<self_attn|mlp>.<proj>.lora_B.weight  (out, r)
    # and mlx_audio's Orpheus model IS mlx_lm's Llama, so stripping the
    # `base_model.model.` PEFT prefix leaves a path that walks the LIVE object.
    MLX_LORA_PREFIX = 'base_model.model.'

    # Special token IDs
    END_OF_AUDIO_TOKEN = 128258


# e2a's lib/classes/tts_engines/presets/orpheus_presets.py, reduced to the one
# thing orpheus.py ever read from it: `models[voice]['voice']`. Every entry there
# maps a stock voice name to ITSELF (the rest of each record is `lang`,
# `description`, `gender`, `samplerate`, none of which orpheus.py touches), so
# the lookup is an identity for the eight stock voices and a miss for anything
# else - exactly what `load_engine_presets` delivered.
STOCK_VOICE_PRESETS = {v: v for v in EngineDefaults.VALID_VOICES}
