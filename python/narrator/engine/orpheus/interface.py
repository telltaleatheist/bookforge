"""Orpheus as an implementation of `narrator.engine.protocol.Engine`.

ADDITIVE ONLY. Not one line of the ported Orpheus bodies moved to make this fit:
`OrpheusInterfaceMixin` reads the same class constants and the same per-voice cap
lookup the engine already used, and hands them back in the protocol's shape. If
this file were deleted the engine would render identically - it would simply no
longer satisfy isinstance(engine, Engine).

The three objects it produces:

  OrpheusCodec   SNAC geometry (7 tokens per 2048-sample frame at 24 kHz, no
                 trim) plus the two decode entry points the engine already has:
                 `_tokens_to_audio` for a whole clip and `WindowedFrameEmitter`
                 for fast start.
  OrpheusBudget  the packer's chars cap, the truncation guard's chars/sec, and
                 the audio-token cap expressed as a total-sequence ceiling.
  StopPolicy     max_new_tokens = MAX_AUDIO_TOKENS, eos_reliable False (Orpheus
                 needs the boost and the floor; see engine/orpheus/sampling.py),
                 resplit_on_cap True (the ladder in _generate_audio_vllm_safe /
                 _generate_mlx_safe), and every Orpheus lever under `levers`.

No torch, no vLLM, no mlx at import: the decode methods this file calls import
theirs inside themselves, exactly as before.
"""
from ..protocol import BackendSpec, StopPolicy
from .snac import SAMPLES_PER_FRAME, TOKENS_PER_FRAME, WindowedFrameEmitter


class OrpheusCodec:
    """SNAC 24 kHz, as `narrator.engine.protocol.Codec`.

    `frames_per_second` is DERIVED (24000 / 2048 = 11.71875 Hz), not the ~12 Hz
    the comments round to: it is the number a duration estimate must use.
    `trim_frames` is 0 - a torch SNAC decode of n frames returns exactly
    n * 2048 samples. (mlx_audio's SNAC returns n * 2048 + 75; that 75-sample
    tail is a property of THAT decoder, cut inside mlx_backend._mlx_frame_decoder,
    and never reaches this arithmetic - see engine/orpheus/mlx_backend.py.)
    """

    tokens_per_frame = TOKENS_PER_FRAME       # 7
    samples_per_frame = SAMPLES_PER_FRAME     # 2048
    trim_frames = 0

    def __init__(self, engine):
        self._engine = engine
        self.sample_rate = int(engine.SAMPLE_RATE)
        self.frames_per_second = self.sample_rate / float(self.samples_per_frame)

    def frames_for_tokens(self, n_tokens: int) -> int:
        return int(n_tokens) // self.tokens_per_frame

    def audio_frames(self, generated_frames: int) -> int:
        """Identity: SNAC has no delay pattern, so every generated frame is an
        audio frame."""
        return max(0, int(generated_frames) - self.trim_frames)

    def samples_for_frames(self, n_frames: int) -> int:
        return int(n_frames) * self.samples_per_frame

    def decode(self, tokens):
        """The engine's own whole-clip decode (SnacMixin._tokens_to_audio)."""
        return self._engine._tokens_to_audio(tokens)

    def streaming_decoder(self, decode_frames, label: str = ''):
        """SNAC's windowed emitter - the fast-start decoder the vLLM and MLX
        backends already drive."""
        return WindowedFrameEmitter(decode_frames, label=label)


class OrpheusBudget:
    """The packer's questions, answered from Orpheus's caps.

    max_chars: THE CATALOG OWNS IT. `maxChars` rides the same per-voice payload
    as the tuning caps (BookForge's orpheusVoiceCapsForModel) but is a PREP
    concern, so `register_voice_caps` accepts and ignores it by name - the
    engine's generation path never reads it. The Budget therefore reads it from
    the payload the engine was CONSTRUCTED with (`EngineConfig.caps`), for the
    voice that config named, and REFUSES anything else rather than inventing a
    number: a chunk size guessed from the token cap would be ~836 characters
    where the catalog says ~450, and the packer would silently build chunks no
    voice was tuned for.

    When the chunk packer lands (plan step 4) and the catalog becomes
    `engines/*.json` keyed on (engine, voice), this lookup becomes a registry
    read and the refusal below disappears with it.
    """

    def __init__(self, engine):
        self._engine = engine

    def _config_caps_for(self, voice):
        engine = self._engine
        want = (voice or engine.voice or '').strip().lower()
        have = (getattr(engine.config, 'voice', None) or '').strip().lower()
        caps = getattr(engine.config, 'caps', None)
        if not caps or want != have:
            raise ValueError(
                f"Orpheus has no maxChars for voice '{voice or engine.voice}': the "
                'catalog payload (orpheusVoiceCapsForModel) carries it and this '
                'engine was built with '
                + (f"caps for '{have}'" if caps else 'no caps at all')
                + '. Pass the voice its catalog caps on EngineConfig - refusing to '
                  'guess a chunk size.')
        return caps

    def max_chars(self, voice=None) -> int:
        caps = self._config_caps_for(voice)
        if 'maxChars' not in caps or caps['maxChars'] is None:
            raise ValueError(
                f"Orpheus caps for voice '{voice or self._engine.voice}' carry no "
                "'maxChars'. The packer's chunk size is a catalog value, not an "
                'engine constant.')
        return int(caps['maxChars'])

    def max_chars_per_sec(self, voice=None) -> float:
        """The truncation guard's live threshold - registered cap, then
        ORPHEUS_MAX_CHARS_PER_SEC, then DEFAULT_MAX_CHARS_PER_SEC."""
        return self._engine._max_chars_per_sec(voice)

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
        """prompt + MAX_AUDIO_TOKENS.

        Orpheus's cap is on the AUDIO tokens alone (MAX_AUDIO_TOKENS = 3700,
        ~44 s at 84 tokens/s), so the total this permits grows with the prompt.
        The model's own 4096 context is what MAX_AUDIO_TOKENS was sized against
        (see EngineDefaults.MAX_AUDIO_TOKENS) and is not re-checked here: the
        engine has always let the backend enforce it.
        """
        if int(prompt_tokens) < 0:
            raise ValueError(f'prompt_tokens must be >= 0, got {prompt_tokens}')
        return int(prompt_tokens) + int(self._engine.MAX_AUDIO_TOKENS)


class OrpheusInterfaceMixin:
    """The protocol surface, bolted onto OrpheusEngine. Reads only what the
    engine already exposes."""

    ENGINE_ID = 'orpheus'

    # Orpheus BAKES the gaps in: _classify_gap returns (lead, trail) seconds and
    # _save_audio writes that silence into the chunk's own FLAC, so a chunk file
    # already contains its pauses and the assembler must not add them again.
    pads = True

    # No assembler-side fade: _save_audio trims the clip and writes the silence
    # around it itself, so the edges are already silent. (Higgs needs 10-25 ms;
    # see protocol.Engine.edge_fade_ms.)
    edge_fade_ms = 0.0

    # The eight stock voices. Custom fine-tunes are NOT here - they arrive with
    # a merged model dir or a LoRA adapter and use their token verbatim.
    # Duplicated from EngineDefaults.VALID_VOICES deliberately: this classmethod
    # is called BEFORE any engine exists, so it cannot read an instance.
    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """Validate a `load` message's voice AS ORPHEUS understands it.

        Moved here from serve/worker.py verbatim in behaviour when voice
        validation became the ENGINE's (a Higgs load was being checked against
        Orpheus's stock allowlist and rejected). Same two branches, same
        messages, same lower-casing:

          a modelDir or an adapterDir names WEIGHTS, so the token is taken
          verbatim - a single-speaker fine-tune is not in the allowlist and
          validating it there would drop it to the default. 'internal' (e2a's
          "no --fine_tuned given" sentinel) is fatal there, because the token is
          also the adapter's registry key and rendering under a token the
          adapter never saw sounds plausible and is wrong.

          otherwise the voice must be one of the eight stock ones. An unknown
          one FAILS the load rather than silently substituting the default - the
          wrong narrator reading a whole session is a silent failure.
        """
        if model_dir or adapter_dir:
            v = (voice or '').strip().lower()
            if not v or v == 'internal':
                raise ValueError(
                    'Orpheus custom voice load is missing its voice token '
                    f'(got {voice!r}). The token the fine-tune was trained on '
                    'is required - refusing to guess.')
            return v
        v = (voice or cls.DEFAULT_VOICE).lower()
        if v not in cls.VALID_VOICES:
            raise ValueError(
                f"Unknown Orpheus voice '{voice}' - expected one of: "
                f"{', '.join(sorted(cls.VALID_VOICES))} (or a custom voice "
                f"with a modelDir, or an adapter voice with adapterDir "
                f"+ baseDir). Refusing to substitute '{cls.DEFAULT_VOICE}'.")
        return v

    def backend_spec(self) -> BackendSpec:
        """All three Orpheus backends load the weights INTO THIS PROCESS: vLLM
        0.7.3's LLM object, the MLX model, or a transformers model. Nothing to
        launch, nothing to health-check, nothing to kill."""
        return BackendSpec(kind='inprocess', name=self.backend)

    def codec(self):
        codec = getattr(self, '_codec_obj', None)
        if codec is None:
            codec = OrpheusCodec(self)
            self._codec_obj = codec
        return codec

    def budget(self):
        budget = getattr(self, '_budget_obj', None)
        if budget is None:
            budget = OrpheusBudget(self)
            self._budget_obj = budget
        return budget

    def stop_policy(self, voice=None) -> StopPolicy:
        """Everything that decides when a chunk stops, for `voice`.

        `levers` carries the eight per-voice tuning caps verbatim from the same
        three-step lookup the sampler uses (registered cap -> ORPHEUS_* env ->
        class default), so a guard event or a post-mortem can report exactly
        what a chunk was rendered with. Nothing outside Orpheus reads them.
        """
        return StopPolicy(
            max_new_tokens=int(self.MAX_AUDIO_TOKENS),
            # Orpheus does NOT stop reliably on its own: the EOS boost
            # (sampling._eos_boost_processor), the EOS floor
            # (sampling._eos_floor_tokens) and the resplit ladder all exist
            # because it overruns and, on some voices, loops.
            eos_reliable=False,
            resplit_on_cap=True,
            max_chars_per_sec=float(self._max_chars_per_sec(voice)),
            # Orpheus's own guards ARE the coverage check: the chars/sec
            # threshold catches a chunk whose audio is too short for its text
            # and the ladder re-renders it split. No ASR gate (ORPHEUS_ASR_GATE
            # is default OFF and its scorer is word-level; see
            # engine/orpheus/asr_gate.py).
            coverage_check=None,
            levers={key: float(self._voice_cap(key, voice))
                    for key in ('temperature', 'topP', 'minP', 'repPenalty',
                                'eosBoost', 'eosBoostStart', 'eosFloor',
                                'eosFloorRate')},
        )
