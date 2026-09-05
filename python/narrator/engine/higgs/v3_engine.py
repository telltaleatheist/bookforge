"""HiggsV3Engine - Higgs TTS 3 over a served vllm-omni backend.

Registry id `higgs-v3`. THE second engine (Owen, 2026-09-04 evening); Higgs v2
stayed only as interface scaffolding (`higgs-v2-scaffold`) because "it's
basically just Orpheus and we know Orpheus better".

The HTTP facts, the launch, the patches, the control-token allowlist, the 30 s
reference cap and the request/response shapes all live in `v3_served.py`. This
module is the `Engine` surface over them: codec geometry, budget, stop policy,
and the render calls.

WHAT IS DIFFERENT FROM ORPHEUS

  backend       SERVED, not in-process (`BackendSpec.kind == 'served'`). The
                engine owns a server process: it starts it, waits out a
                55-297 s cold start (the measured range on this box) for health,
                and stops it. While up, the server preallocates to its
                gpu-memory-utilization target and OWNS the GPU.
  pads          False. Higgs emits bare speech; the manifest's
                gapBefore/gapAfter are live and the assembler realizes them.
  edge_fade     EdgeFade(10, 25) - ASYMMETRIC. Even with the server's
                content trim applied, a decoded chunk ends on a hard sample
                boundary, which is a click; a chunk also begins on one. The tail
                needs more than twice the head's window. Agrees with
                assemble.engine_profiles.PROFILES['higgs-v3'].
  no EOS levers there is no boost, no floor, no ratchet and no resplit ladder.
                v3 stops on its own; what it does instead is DROP THE TAIL of a
                long chunk, which no lever fixed. Hence max_chars 600 and
                `coverage_check = 'asr'`: a duration ratio measured 0.99 on a
                chunk that delivered 0.778 coverage with a 26 % insert rate.
  voice         a MERGED CHECKPOINT the server runs on (production: Owen,
                2026-09-04 - "fine-tuned voices only"), or one reference clip
                with its book-exact transcript (DIAGNOSTIC: how a voice is
                auditioned before anyone trains it). There is no runtime LoRA -
                vllm-omni has no adapter flags and its talker does not implement
                SupportsLoRA - so a voice change is a server restart.
  no streaming  the endpoint used is the buffered POST /v1/audio/speech, which
                returns a finished wav. vllm-omni also exposes a WebSocket
                `/v1/audio/speech/stream`, which narrator does NOT use: nothing
                here has been measured against it. `generate_batch_stream`
                therefore emits per row at retirement, and says so.
  batching      CONCURRENT REQUESTS, `BATCH_SIZE` of them at once. The server
                is a continuous batcher: stage 0 admits up to `max_num_seqs`
                sequences and schedules them together, and vllm-omni's own
                `/v1/audio/speech/batch` is an `asyncio.gather` over the items
                and nothing more (measured 2026-09-05). So the batch IS N
                in-flight POSTs, N = `HIGGS_MAX_NUM_SEQS` (`serve_concurrency`),
                the same number the launch script passes the server. The
                render worker's flush hands `convert_batch` a pool twice that
                wide so a retired slot is refilled while the slowest row is
                still decoding; `generate_batch_stream` retires rows AS THEY
                COMPLETE, not in index order - the serve worker keys every
                callback by row and the batch-stream contract permits it.
"""
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..protocol import (BackendSpec, ClipsVoice, DefaultVoice, EdgeFade,
                        SpeechRequest, StopPolicy)
from ..log import log
from . import v3_served
from .prompt import clean_text
from .v3_served import HiggsV3ServedBackend


class HiggsV3Defaults:
    """Every v3 number, with the measurement behind it."""

    ENGINE_ID = 'higgs-v3'
    MODEL_ID = v3_served.MODEL_ID
    SAMPLE_RATE = v3_served.SAMPLE_RATE
    FRAMES_PER_SECOND = v3_served.FRAMES_PER_SECOND
    CONTEXT_TOKENS = v3_served.CONTEXT_TOKENS
    # <= 600 chars is the measured safe zone; the delivered render used 300.
    MAX_CHARS = v3_served.MAX_CHARS
    # The measured render sat at ~16.5 chars/s against the narrator's 15.0;
    # 20.0 leaves headroom. ADVISORY - coverage_check is the real gate.
    MAX_CHARS_PER_SEC = 20.0
    EDGE_FADE = EdgeFade(v3_served.EDGE_FADE_IN_MS,
                        v3_served.EDGE_FADE_OUT_MS)
    MAX_REFERENCE_SECONDS = v3_served.MAX_REFERENCE_SECONDS
    # v3's OWN control vocabulary (45 tokens). v2's default is empty, and a
    # voice loaded with v2's defaults would silently accept nothing - or, worse,
    # a v3 voice carrying v2's empty tuple would reject `<|prosody:long_pause|>`
    # while the model understands it perfectly.
    ALLOWED_CONTROLS = tuple(sorted(v3_served.ALLOWED_CONTROL_TOKENS))
    # COLD START IS NOT ONE NUMBER. Measured on this box, same script, same
    # env: 55 s (warm page cache), 146 s, and 297 s (cold weights, idle box,
    # narrator's own smoke). The spread is disk and first-run compilation, not
    # load. 900 s is therefore the default patience - long enough that a slow
    # start is never mistaken for a dead server, while `wait_ready` raises
    # IMMEDIATELY if the process actually died, so the wait is only ever paid
    # when something is genuinely still coming up.
    READY_TIMEOUT_SECONDS = 900.0


def apply_v3_voice_defaults(voice: ClipsVoice) -> ClipsVoice:
    """Stamp v3's own rules onto a voice: its 45-token control allowlist and its
    30 s reference cap.

    A voice read with the v2 scaffold's defaults carries an EMPTY allowlist and
    no cap. Empty is not "anything goes" - it is "this engine takes no control
    tokens", which is true of v2 and false of v3, and it would reject
    `<|prosody:long_pause|>` while the model understands it. A voice that
    already declared its own (from the document) is left alone.
    """
    if not isinstance(voice, ClipsVoice):
        # A DefaultVoice has no reference and no per-voice control allowlist -
        # there is nothing on it for v3's rules to stamp.
        return voice
    controls = (voice.allowed_controls
                or tuple(sorted(v3_served.ALLOWED_CONTROL_TOKENS)))
    cap = (voice.max_reference_seconds
           if voice.max_reference_seconds is not None
           else v3_served.MAX_REFERENCE_SECONDS)
    if (controls == voice.allowed_controls
            and cap == voice.max_reference_seconds):
        return voice
    return ClipsVoice(
        clips=voice.clips, name=voice.name, scene=voice.scene,
        checkpoint_dir=voice.checkpoint_dir, allowed_controls=controls,
        max_reference_seconds=cap, max_chars=voice.max_chars,
        max_chars_source=voice.max_chars_source)


@dataclass
class HiggsV3Config:
    """What one HiggsV3Engine is built from.

    `sampling` EMPTY means THE MODEL DIRECTORY'S OWN SAMPLING - see
    `served_sampling`. For a checkpoint voice that is the directory's
    `generation_config.json`, which the server reads for itself and which
    narrator has proved is there; for base weights there IS no such file in the
    bosonai snapshot, so v3's deploy default is sent EXPLICITLY rather than
    left to a bare `SamplingParams()` (top_p 1.0, top_k disabled - the babble
    case, PORT_NOTES 12.8d). Anything set here rides in `extra_params` on top.
    """
    voice: ClipsVoice
    base_url: Optional[str] = None
    serve_script: Optional[str] = None
    checkpoint_dir: Optional[str] = None
    sampling: Optional[dict] = None
    seed: Optional[int] = 1234
    sentences_dir: Optional[str] = None
    process_dir: Optional[str] = None
    audio_format: str = 'flac'
    max_chars: int = HiggsV3Defaults.MAX_CHARS
    max_chars_per_sec: float = HiggsV3Defaults.MAX_CHARS_PER_SEC
    context_tokens: int = HiggsV3Defaults.CONTEXT_TOKENS
    ready_timeout: float = HiggsV3Defaults.READY_TIMEOUT_SECONDS
    #: Run the sentinel-filter tail MEASUREMENT after /health (see
    #: HiggsV3ServedBackend.probe_sentinel_filter). ON by default, and cheap -
    #: one ~1 s render per server start. It reports the tail level against the
    #: certified band and refuses only a 200 that carries no audio; it is NOT
    #: the proof that the patch is applied, which is the doctor's static
    #: marker/absent-marker grep of the stage processor. See that method for
    #: what a real proof would be and the TODO that names it.
    probe_sentinel_filter: bool = True

    def __post_init__(self):
        if not isinstance(self.voice, (ClipsVoice, DefaultVoice)):
            raise ValueError(
                'HiggsV3Config(voice=...) takes a ClipsVoice (a reference clip with '
                "its book-exact transcript) or a DefaultVoice (the model's own "
                f'voice). Got {type(self.voice).__name__}.')
        if not (self.voice.name or '').strip():
            raise ValueError('HiggsV3Config needs a NAMED voice.')
        # A voice built by hand (or loaded with another engine's defaults) may
        # carry v2's empty control allowlist and no reference cap. Stamp v3's on
        # it here so there is exactly ONE place a v3 voice acquires v3's rules.
        self.voice = apply_v3_voice_defaults(self.voice)
        # The 30 s cap and the one-reference rule, checked before a server is
        # ever started rather than after a 55 s launch and an HTTP 400.
        if isinstance(self.voice, ClipsVoice):
            v3_served.check_reference_budget(self.voice)
        # The voice may carry its own checkpoint; the config may name one
        # explicitly. They must not disagree.
        voice_checkpoint = getattr(self.voice, 'checkpoint_dir', None)
        if voice_checkpoint and self.checkpoint_dir and (
                voice_checkpoint != self.checkpoint_dir):
            raise ValueError(
                f"Higgs v3 voice '{self.voice.name}' names checkpoint "
                f'{voice_checkpoint} but the config names {self.checkpoint_dir}. One '
                'server runs on one checkpoint - refusing to pick.')
        if voice_checkpoint and not self.checkpoint_dir:
            self.checkpoint_dir = voice_checkpoint
        if self.checkpoint_dir:
            # Also proves the directory carries the generation_config.json the
            # server will read its sampling out of - see
            # v3_served.require_generation_config.
            v3_served.checkpoint_serve_target(self.checkpoint_dir,
                                              self.voice.name)

    #: The keys of `SERVER_DEFAULT_SAMPLING` that may ride in `extra_params`.
    #: `seed` is excluded: it is the request's TOP-LEVEL field and
    #: `build_request_body` refuses the duplicate.
    EXTRA_PARAM_KEYS = tuple(k for k in v3_served.SERVER_DEFAULT_SAMPLING
                             if k != 'seed')

    def served_sampling(self) -> dict:
        """What rides in the request's `extra_params` - decided by voice KIND.

        THE SYMMETRY WITH THE MLX ARM (`HiggsV3MlxConfig.mlx_sampling`). Both
        answer the same question - "what sampling does this voice render at?" -
        and both branch on whether the voice IS a merged checkpoint, never on
        whether some file happens to exist.

          checkpoint voice   SEND NOTHING. The server reads
                             `<checkpointDir>/generation_config.json` for
                             itself, and `require_generation_config` has already
                             proved it is there and carries usable sampling. An
                             `extra_params` here would OVERRIDE the model's own
                             declared sampling with narrator's opinion of it.
          base weights       SEND v3's deploy default EXPLICITLY. The
                             `bosonai/higgs-audio-v3-tts-4b` snapshot ships no
                             `generation_config.json` at all (verified on the
                             WSL HF cache and the Mac's base copy), so sending
                             nothing here is NOT "the deploy defaults" - it is
                             vllm-omni's bare `SamplingParams()`: top_p 1.0,
                             top_k DISABLED, the untruncated 1026-way codebook
                             tail that derails long chunks into babble. That is
                             the exact failure this branch exists to prevent,
                             and until 2026-09-05 it was live for every
                             non-checkpoint voice on the served arm.

        `sampling` is a named per-config override and is merged on top of
        either.
        """
        # `self.checkpoint_dir` and not `self.voice.checkpoint_dir`: this is the
        # config's resolved answer to "which directory is this server running
        # on", which __post_init__ takes from the voice when the voice names one
        # and which an operator may state directly.
        if self.checkpoint_dir:
            resolved = {}
        else:
            resolved = {k: v3_served.SERVER_DEFAULT_SAMPLING[k]
                        for k in self.EXTRA_PARAM_KEYS}
        resolved.update(self.sampling or {})
        return resolved

    def applied_sampling(self) -> dict:
        """What the model will actually SAMPLE at - which is not always what is
        sent (`served_sampling`), because a checkpoint's numbers live in its own
        directory and reach the server without passing through narrator.

        This is what `stop_policy` reports, and the manifest is the artifact that
        outlives the render: reporting the base default for a fine-tune would
        name sampling nobody used.

        A key the checkpoint's file omits is vLLM's own default; narrator has not
        measured those and does not state them, so only what the file says is
        reported.
        """
        if self.checkpoint_dir:
            document = v3_served.require_generation_config(
                self.checkpoint_dir, self.voice.name)
            resolved = {k: document[k] for k in self.EXTRA_PARAM_KEYS
                        if k in document}
        else:
            resolved = {k: v3_served.SERVER_DEFAULT_SAMPLING[k]
                        for k in self.EXTRA_PARAM_KEYS}
        resolved.update(self.sampling or {})
        return resolved


class HiggsV3Codec:
    """`protocol.Codec` for v3 - geometry only.

    THE SERVER DECODES. v3's tokens never reach this process: the endpoint
    returns a finished wav, and the patched server has already dropped every
    sentinel frame by token identity (work/patch_sentinel_filter.py, read to
    confirm it removes both the sentinel->0 substitution and the one-frame
    trim). So `decode()` refuses: a client-side trim on top would eat real
    speech, and there is nothing here to decode.

    The geometry is still reported, because the packer and the manifest need it:
    identical to v2 - 8 codebooks at 25 fps, 24 kHz, 960 samples per frame, a
    7-frame delay diagonal.
    """

    sample_rate = v3_served.SAMPLE_RATE
    frames_per_second = v3_served.FRAMES_PER_SECOND
    tokens_per_frame = 8
    samples_per_frame = int(v3_served.SAMPLE_RATE / v3_served.FRAMES_PER_SECOND)
    trim_frames = 7

    def frames_for_tokens(self, n_tokens: int) -> int:
        return int(n_tokens) // self.tokens_per_frame

    def audio_frames(self, generated_frames: int) -> int:
        return max(0, int(generated_frames) - self.trim_frames)

    def samples_for_frames(self, n_frames: int) -> int:
        return int(n_frames) * self.samples_per_frame

    def decode(self, tokens):
        raise NotImplementedError(
            'Higgs v3 decodes SERVER-SIDE: /v1/audio/speech returns a finished wav, '
            'and the patched server has already trimmed the sentinel tail by '
            'content. There are no audio tokens on this side to decode, and a '
            'second trim would eat speech. Use HiggsV3Engine.render_audio().')

    def streaming_decoder(self, decode_frames, label: str = ''):
        """None: the decode is behind the HTTP boundary. vllm-omni does expose a
        WebSocket `/v1/audio/speech/stream`, which nothing here has measured."""
        return None


class HiggsV3Budget:
    """`protocol.Budget` for v3."""

    def __init__(self, config: HiggsV3Config):
        self._config = config

    def _voice(self, voice):
        if voice is not None and voice != self._config.voice.name:
            raise ValueError(
                f"HiggsV3Budget: this engine serves '{self._config.voice.name}', not "
                f"'{voice}'. A v3 voice change is a server restart, so one engine "
                'answers for one voice.')
        return self._config.voice

    def max_chars(self, voice=None) -> int:
        """THE VOICE'S chunk size, not the engine's.

        A voice that declared `maxChars` in the NARRATOR_HIGGS_VOICES document
        gets its own number. A zero-shot clips voice that did not gets the
        engine placeholder - 600, the measured safe zone for the BASE model
        (900 chars drops the tail reproducibly, coverage 0.78-0.86, and a
        reference clip does not fix it; the delivered render used 300).

        AN ADAPTER VOICE WITH NO `maxChars` IS REFUSED, by the same rule as
        `OrpheusBudget.max_chars`: a fine-tune's safe chunk length is a measured
        property of that model, and the base model's placeholder is not it. The
        voice document normally catches this at load; this is the belt for a
        config assembled in code.
        """
        ref = self._voice(voice)
        if ref.max_chars is None:
            if ref.checkpoint_dir:
                raise ValueError(
                    f"Higgs v3 voice '{ref.name}' is a fine-tune "
                    f'({ref.checkpoint_dir}) and has no maxChars. Measure the safe chunk '
                    f'length for THAT model and declare it in the voice document - '
                    f"refusing to pack a book at the base model's "
                    f'{self._config.max_chars}-char placeholder.')
            return int(self._config.max_chars)
        return int(ref.max_chars)

    def max_chars_source(self, voice=None) -> str:
        """'catalog' or 'placeholder' - so a log line can say which."""
        ref = self._voice(voice)
        return ref.max_chars_source or 'placeholder'

    def max_chars_per_sec(self, voice=None) -> float:
        return float(self._config.max_chars_per_sec)

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
        """The 8,192-position window (`--max-model-len 8192`) - a ceiling the
        prompt eats into. 27 s of reference is ~685 placeholder rows of it."""
        prompt_tokens = int(prompt_tokens)
        if prompt_tokens < 0:
            raise ValueError(f'prompt_tokens must be >= 0, got {prompt_tokens}')
        window = int(self._config.context_tokens)
        if prompt_tokens >= window:
            raise ValueError(
                f'Higgs v3 prompt is {prompt_tokens} positions against a '
                f'{window}-position window, leaving nothing to generate. Shorten the '
                'chunk or the reference - 27 s of reference audio is about 685 of '
                'those positions.')
        return window

    def cap_frames(self, text: str) -> int:
        return v3_served.cap_frames(text)


def higgs_v3_stop_policy(config: HiggsV3Config) -> StopPolicy:
    """v3 stops on its own and never hit the cap - but it DROPS TEXT, so
    `coverage_check` is 'asr' and it is not optional politeness.

    `levers` reports what the model will actually SAMPLE AT, which is not the
    same as what is sent: a checkpoint voice sends no `extra_params` because its
    own directory carries `generation_config.json`, and THOSE are the numbers
    the render used. Reporting the base default for a fine-tune would put
    sampling nobody used into the manifest - the artifact that outlives the
    render. See `HiggsV3Config.applied_sampling`.
    """
    sampling = config.applied_sampling()
    return StopPolicy(
        max_new_tokens=v3_served.cap_frames('x' * int(config.max_chars)),
        eos_reliable=True,
        resplit_on_cap=False,
        max_chars_per_sec=float(config.max_chars_per_sec),
        levers={k: float(v) for k, v in sampling.items()},
        coverage_check='asr',
    )


class HiggsV3Engine:
    """One v3 server, owned."""

    ENGINE_ID = HiggsV3Defaults.ENGINE_ID
    SAMPLE_RATE = HiggsV3Defaults.SAMPLE_RATE
    pads = False
    edge_fade = HiggsV3Defaults.EDGE_FADE
    SUPPORTS_BATCH = True
    #: Class-level floor; the INSTANCE sets its own from `serve_concurrency()`
    #: (the render worker reads the attribute off the instance).
    BATCH_SIZE = 1

    def __init__(self, config: HiggsV3Config):
        if not isinstance(config, HiggsV3Config):
            raise ValueError(
                'HiggsV3Engine(config) takes a narrator.engine.higgs.HiggsV3Config; '
                f'got {type(config).__name__}.')
        self.config = config
        self.backend = 'vllm-omni'
        self.voice_ref = config.voice
        self.voice = config.voice.name
        self._codec = HiggsV3Codec()
        self._budget = HiggsV3Budget(config)
        self.params = {'samplerate': self.SAMPLE_RATE}
        # THE WIDTH OF THE BATCH = the server's admission width, one variable.
        # Resolved before the backend exists because a launch exports it.
        self.BATCH_SIZE = v3_served.serve_concurrency()
        # Twice the width per flush: the executor keeps BATCH_SIZE requests in
        # flight and refills a retired slot from the rest of the pool, so the
        # server is not left idling on the slowest row of every flush. A
        # cooperative stop discards at most one pool of finished work.
        self.batch_pool_size = 2 * self.BATCH_SIZE
        # THE CHECKPOINT GOES TO THE BACKEND: in launch mode it is exported as
        # HIGGS_MODEL_DIR so the server comes up ON this voice (it used not to
        # be, and the launcher served the base snapshot - Owen's first in-app
        # render, 2026-09-05); in both modes it is what the RUNNING server, as
        # reported by /v1/models, is held to in check_serves_expected_model.
        # THE SERVER'S LOG LIVES WITH THE RUN. `process_dir` is the session's
        # own directory - it already holds `session-state.json` and the Orpheus
        # guards' rejects - so a server this engine launches writes beside them
        # and the ledger can name one path for the whole run. With no session
        # (an audition, a test) the backend falls back to a per-instance file in
        # the temp dir and SAYS SO in its log line; what it never does is
        # discard the stream, which is what DEVNULL used to do and what left the
        # sentinel filter unprovable.
        self.server = HiggsV3ServedBackend(
            base_url=config.base_url, serve_script=config.serve_script,
            checkpoint_dir=config.checkpoint_dir,
            concurrency=self.BATCH_SIZE,
            server_log=(os.path.join(config.process_dir,
                                     v3_served.SERVER_LOG_NAME)
                        if config.process_dir else None))
        self.load_engine()

    # ---- lifecycle ----------------------------------------------------------

    def load_engine(self):
        """Start the server (or adopt one), wait for health, take the
        sentinel-filter tail measurement and READ THE SERVER'S LOG for the
        token-level sentinel proof.

        A server that does not come up is a hard failure here rather than at the
        first sentence: the caller is holding a GPU lock and needs to know now.

        EVERY FAILURE AFTER `start()` STOPS THE SERVER. Without that, a timeout
        leaves a ~14 GB vllm-omni running with nothing holding a reference to
        it - the GPU stays occupied, the lock gets released by the caller's
        `finally`, and the next job OOMs against a process nobody can name.
        `stop()` is a no-op in attach mode, so this never kills somebody else's
        server.
        """
        self.server.start()
        try:
            if not self.server.wait_ready(self.config.ready_timeout):
                raise v3_served.HiggsV3ServerError(
                    f'Higgs v3 server at {self.server.base_url} did not answer '
                    f'{v3_served.HEALTH_PATH} within {self.config.ready_timeout:.0f}s. '
                    'Measured cold starts on this box range 55-297 s (page cache and '
                    'first-run compilation), so a longer wait is normal; this is not. '
                    'Check its log, and that both site-packages patches are applied '
                    'in the higgs3 env.')
            self.server.check_serves_expected_model(
                checkpoint_dir=self.config.checkpoint_dir)
            if self.config.probe_sentinel_filter:
                self.server.probe_sentinel_filter()
                # PROOF (a), on the log the probe render just wrote into. It is
                # skipped only when there is no stream to read at all - an
                # attached server whose operator named no log - and that is said
                # out loud rather than passed over, because "not proved" and
                # "proved" must never look the same in a run log.
                if self.server.proof_log():
                    self.server.verify_sentinel_filter()
                else:
                    log('[HIGGS3] token-level sentinel proof UNAVAILABLE: attached '
                        'to a server this process did not start and no '
                        f'{v3_served.SERVER_LOG_ENV} was named, so there is no log '
                        'to read. The static half of the proof (no one-frame trim '
                        'left in the stage processor) is unaffected - it is a grep '
                        'the Higgs doctor runs before any server starts.',
                        flush=True)
        except BaseException:
            self.server.stop()
            raise
        return self.server

    def cleanup(self):
        """Stop the server and release the GPU. Idempotent."""
        self.server.stop()

    @classmethod
    def detect_backend(cls) -> str:
        return 'vllm-omni'

    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """Validate a `load` message's voice AS THIS ENGINE understands it.

        Orpheus's allowlist is eight stock TOKENS; v3's voices are entries in the
        NARRATOR_HIGGS_VOICES document, and a name like 'deathstalker' is neither
        stock-Orpheus nor a modelDir/adapterDir load. Checking a v3 load against
        Orpheus's list rejected every real v3 voice ("Unknown Orpheus voice
        'deathstalker'"), which is why voice validation belongs to the engine.

        Returns the voice name as the document spells it - NOT lower-cased:
        Orpheus tokens are case-folded because the prompt token is, and a v3
        voice name is a document key, where folding could miss an entry.
        """
        if model_dir:
            raise ValueError(
                f'Higgs v3 load carried modelDir={model_dir!r}. The served model is '
                "the launch script's argument, not a per-load field.")
        if base_dir:
            raise ValueError(
                f'Higgs v3 load carried baseDir={base_dir!r}. v3 has no shared-base + '
                'per-voice-adapter split.')
        name = (voice or '').strip()
        if not name:
            raise ValueError(
                'Higgs v3 load has no voice name. The name selects an entry in the '
                "NARRATOR_HIGGS_VOICES document; there is no default, and the model's "
                'own voice sits at 12 % of the narrator ceiling.')
        from .config import load_voice
        resolved = load_voice(
            name, allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
            max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
            placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)
        checkpoint = getattr(resolved, 'checkpoint_dir', None)
        if checkpoint:
            # A checkpoint voice's REQUIRED FILES are checked here, at the load
            # message, for the same reason `maxChars` is: the refusal belongs
            # before a 55-297 s server start and before anything holds a GPU.
            v3_served.checkpoint_serve_target(checkpoint, resolved.name)
        return name

    def backend_spec(self) -> BackendSpec:
        return self.server.spec

    # ---- the seam -----------------------------------------------------------

    def codec(self) -> HiggsV3Codec:
        return self._codec

    def budget(self) -> HiggsV3Budget:
        return self._budget

    def stop_policy(self, voice=None) -> StopPolicy:
        if voice is not None and voice != self.voice:
            raise ValueError(
                f"HiggsV3Engine.stop_policy({voice!r}): this engine serves "
                f"'{self.voice}'. A v3 voice is its reference (or its adapter, which "
                'is a server restart) - a second voice is a second engine.')
        return higgs_v3_stop_policy(self.config)

    def set_voice(self, voice: str, adapter_dir: str = None) -> None:
        """A SECOND load on a live v3 worker: refused by name.

        The serve worker's warm path calls this when a load arrives on an engine
        that is already up. For Orpheus it is a free prompt-prefix switch (or a
        LoRA re-point). For v3 it cannot be: a fine-tuned voice IS a merged
        checkpoint the server was started ON, and vllm-omni cannot load a voice
        into a running one - no adapter flags, and its talker does not implement
        `SupportsLoRA`. (A diagnostic clips voice is no better: its reference
        rides in every request.) Silently accepting would leave the worker
        reporting voice B while the server renders voice A for a whole book.

        Switching the SAME voice back to itself is a no-op, which is what a pool
        re-issuing an identical load actually wants.
        """
        want = (voice or '').strip()
        if want == self.voice and (adapter_dir or None) == (
                self.config.checkpoint_dir or None):
            return
        raise ValueError(
            f'HiggsV3Engine cannot switch voice in place: this server was started '
            f"for '{self.voice}'"
            + (f' on checkpoint {self.config.checkpoint_dir}'
               if self.config.checkpoint_dir else '')
            + f", and a load for '{want}'"
            + (f' (checkpoint {adapter_dir})' if adapter_dir else '')
            + ' needs a NEW server. vllm-omni cannot load a voice into a running '
              'one: it has no adapter flags and its talker does not implement '
              'SupportsLoRA, so every fine-tuned voice is a whole merged checkpoint '
              'the server runs ON. Quit this worker and start one for that voice '
              '(~55 s warm, up to ~300 s cold).')

    def _apply_voice_caps(self, voice: str, caps: dict) -> None:
        """Orpheus's per-voice tuning registry has no v3 counterpart - v3's
        sampling comes from the MODEL DIRECTORY's `generation_config.json`
        (12.8d), with `extra_params` the only channel that can override it. An
        EMPTY payload is the pool's "no catalog tuning" signal and is accepted
        as the no-op it is; anything else is refused by name rather than looking
        applied."""
        if caps:
            raise ValueError(
                f'Higgs v3 load for {voice!r} carried caps={sorted(caps)}. Those are '
                'ORPHEUS tuning caps and v3 implements none of them.')

    # ---- rendering ----------------------------------------------------------

    def _clean_sentence_for_tts(self, sentence: str) -> str:
        """The SML strip, shared by every engine. The serve worker calls this on
        the engine before it renders, so it is part of the surface."""
        return clean_text(sentence)

    def _seed_for(self, index: int):
        """THE seed rule, one place: chunk i renders with `seed + i`.

        `index` is the CHUNK's index - the sentence number for `convert`, the row
        for `generate_batch_stream`, and 0 only for a bare `render_audio` with no
        index of its own. render_final.py seeded chunk i with `1234 + i` for the
        same reason: a re-render of one chunk reproduces it, and two chunks of a
        batch never share a draw. Rendering every sentence at `seed` flat - which
        the served worker branch used to do - makes a whole book of identical
        draws for identical text.

        The seed travels as the request's TOP-LEVEL `seed` field and NEVER also
        inside `extra_params`; `build_request_body` refuses the duplicate.
        `HiggsV3Config.seed = None` means "do not seed at all".
        """
        if self.config.seed is None:
            return None
        return int(self.config.seed) + int(index)

    def render_audio(self, text: str, seed=None, index: int = 0) -> np.ndarray:
        """One chunk of text -> a float32 mono waveform at 24 kHz.

        `index` is the chunk's own index and is what seeds it (see `_seed_for`);
        an explicit `seed` overrides. Callers that HAVE an index must pass it -
        `convert` and `generate_batch_stream` do - so a book is not rendered at
        one seed from end to end.
        """
        # THE MODEL BOUNDARY STRIPS THE MARKUP - here, once, for every caller.
        # `[break]` / `[heading]` / `[item]` / `[pause:X]` are narrator's own
        # markers: the packer writes them into the chunk text (677 of 1067
        # chunks of Owen's first Higgs book began with `[break]`; every heading
        # with `[break][heading]`), the assembler realizes them as gaps, and
        # Orpheus's convert() strips them before its prompt. This path only
        # trimmed whitespace, so Higgs READ THEM: "break" spoken at the head of
        # most chunks, "[heading]" as 7-15 s of gibberish before "Dedication."
        # (measured on the Mac, 2026-09-05; identical on the served arm). The
        # serve worker cleans before it calls, which is why Listen never showed
        # it; the render worker hands convert() the stored text, which is why
        # every book did.
        clean = self._clean_sentence_for_tts(text)
        if not clean:
            raise ValueError(
                'HiggsV3Engine.render_audio(): the chunk has no text once its '
                f'markers are stripped ({(text or "").strip()!r}).')
        request = SpeechRequest(
            text=clean, voice=self.voice_ref,
            max_new_tokens=self._budget.cap_frames(clean),
            seed=self._seed_for(index) if seed is None else seed,
            sampling=self.config.served_sampling())
        audio, _rate = self.server.speak(request)
        return audio

    def _sentence_file(self, sentence_number: int) -> str:
        if not self.config.sentences_dir:
            raise ValueError(
                'HiggsV3Engine.convert() needs a sentences_dir: this engine was built '
                'for in-memory generation, so there is nowhere to write chunk '
                f'{sentence_number}. Use generate_batch_stream / render_audio.')
        return os.path.join(self.config.sentences_dir,
                            f'{sentence_number}.{self.config.audio_format}')

    def convert(self, sentence_number: int, sentence: str) -> bool:
        """Render one chunk to `<sentences_dir>/<n>.<audio_format>`, EXACTLY AS
        DECODED - no trim, no fade, no pad. The server already trimmed the
        sentinel tail; the fades are the assembler's (`edge_fade`), and the
        gaps are the manifest's."""
        import soundfile as sf
        path = self._sentence_file(sentence_number)
        audio = self.render_audio(sentence, index=sentence_number)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # PCM_16, stated - the same writer contract every narrator chunk uses.
        # See engine/orpheus/audio.py:write_chunk_file for why the bit depth is
        # never left to a library default.
        sf.write(path, audio, self.SAMPLE_RATE, subtype='PCM_16',
                 format=self.config.audio_format.upper())
        return True

    def _convert_one(self, index: int, text: str) -> bool:
        """`convert`, with the per-row failure policy of a batch.

        A refusal of ONE chunk (an HTTP 400 for its text, a decode failure) is
        that chunk's False, logged by name, and the batch goes on - the same
        policy as Orpheus's per-item path. A DEAD SERVER is not one chunk's
        failure: it propagates and ends the flush, because every remaining row
        would fail the same way and the worker would mark the whole book failed
        one sentence at a time.
        """
        try:
            return self.convert(index, text)
        except v3_served.HiggsV3ServerDown:
            raise
        except Exception as exc:
            log(f'[HIGGS3] sentence {index} failed: {exc}', flush=True)
            return False

    def convert_batch(self, items) -> list:
        """`BATCH_SIZE` requests in flight at once over `items`; results aligned
        to `items`. See the module docstring's `batching` entry for why N
        concurrent POSTs are the batch on this backend."""
        items = list(items)
        if not items:
            return []
        width = min(self.BATCH_SIZE, len(items))
        with ThreadPoolExecutor(max_workers=width,
                                thread_name_prefix='higgs3-render') as pool:
            futures = [pool.submit(self._convert_one, index, text)
                       for index, text in items]
            # `result()` re-raises a HiggsV3ServerDown from any row; the
            # executor's __exit__ then waits for the rows already in flight,
            # which fail fast against a dead port.
            return [future.result() for future in futures]

    def generate_batch_stream(self, texts, voices, stream_rows, on_chunk, on_row,
                              should_stop=None) -> None:
        """Whole rows, at retirement.

        The buffered endpoint returns a finished wav, so there is nothing to
        emit until the row is done. A row asked to stream gets its audio as a
        single `on_chunk(row, 0, audio)` before its `on_row` - the streaming
        channel, honestly filled, arriving when it actually arrived.
        """
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'HiggsV3Engine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        if voices is not None:
            wrong = sorted({v for v in voices if v and v != self.voice})
            if wrong:
                raise ValueError(
                    f'HiggsV3Engine.generate_batch_stream: rows ask for voice(s) '
                    f"{wrong}; this engine serves '{self.voice}'. A v3 voice change is "
                    'a server restart, so a mixed-voice batch is impossible.')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'HiggsV3Engine.generate_batch_stream: stream_rows names row(s) '
                f'{stray} outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'HiggsV3Engine.generate_batch_stream: stream_rows is non-empty but no '
                'on_chunk was given')
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'HiggsV3Engine.generate_batch_stream: row(s) {blank} have no text '
                'after cleaning.')

        def render(i: int, text: str):
            # Checked at the moment the row would be POSTed, not at submission:
            # rows queued behind the in-flight ones must not start once the
            # caller has asked for a stop. An abandoned row gets no on_row at
            # all, which is what the contract requires.
            if should_stop is not None and should_stop():
                return i, None, True
            return i, self.render_audio(text, index=i), False

        width = min(self.BATCH_SIZE, len(texts))
        with ThreadPoolExecutor(max_workers=width,
                                thread_name_prefix='higgs3-stream') as pool:
            futures = [pool.submit(render, i, text)
                       for i, text in enumerate(texts)]
            # Callbacks run HERE, on the caller's thread, as rows retire - the
            # serve worker's callbacks take their own locks but were written
            # for one caller at a time, and this keeps that true.
            for future in as_completed(futures):
                try:
                    i, audio, abandoned = future.result()
                except v3_served.HiggsV3ServerDown:
                    raise
                except Exception as exc:
                    # Which row is not recoverable from the exception; find the
                    # future's index and report that row failed.
                    i = futures.index(future)
                    log(f'[HIGGS3] row {i} failed: {exc}', flush=True)
                    on_row(i, None)
                    continue
                if abandoned:
                    continue
                if i in stream_rows:
                    on_chunk(i, 0, audio.copy())
                on_row(i, audio)


def higgs_v3_prep_budget(voice_name: str):
    """The `Budget` a Higgs PREP packs a book against - the voice's own
    `maxChars` from the NARRATOR_HIGGS_VOICES document, carried as data.

    MEASURED BUG, both arms (the Mac agent, 2026-09-05, from Owen's "why 1067
    chunks when Orpheus made 576"): `compat/app.py:route_prep` built a Higgs
    prep with no budget, and `text/prep.py` then reached for
    `orpheus_budget_from_env()` - ORPHEUS_MAX_CHARS, which a Higgs spawn never
    carries, so e2a's 350-char default won. Every Higgs book so far was packed
    in ~220-char chunks while the voice document beside it said 900 (MLX) or
    1200 (served): the certified caps were never exercised by a book, and a
    voice trained on 900-1200-char clips was read in fragments.

    Same refusal as `HiggsV3Budget.max_chars`: a fine-tune with no measured cap
    is refused by name, never packed at the base model's placeholder. The rate
    is 0.0 - "no rate guard" - because the paragraph packer applies a rate only
    against an engine-owned audio window, and v3 has none of Orpheus's kind.
    """
    from ..protocol import ClipsVoice as _Clips  # noqa: F401  (type only)
    from ...text.paragraph_packer import CatalogBudget
    from .config import load_voice

    name = (voice_name or '').strip()
    if not name:
        raise ValueError(
            'A Higgs v3 prep needs --higgs_voice: the chunk cap is the VOICE\'s '
            'measured maxChars from the NARRATOR_HIGGS_VOICES document, and there '
            'is no engine-wide number to pack a book against.')
    resolved = load_voice(
        name,
        allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
        max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
        placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)
    cap = getattr(resolved, 'max_chars', None)
    if cap is None:
        if getattr(resolved, 'checkpoint_dir', None):
            raise ValueError(
                f"Higgs v3 voice '{name}' is a fine-tune "
                f'({resolved.checkpoint_dir}) and has no maxChars. Measure the safe '
                'chunk length for THAT model and declare it in the voice document - '
                f"refusing to pack a book at the base model's "
                f'{HiggsV3Defaults.MAX_CHARS}-char placeholder.')
        cap = HiggsV3Defaults.MAX_CHARS
    cap = int(cap)
    if cap <= 0:
        raise ValueError(
            f"Higgs v3 voice '{name}' declares maxChars {cap}, which is not a "
            'chunk size.')
    log(f"[HIGGS3] prep budget for '{name}': {cap} chars "
        f'({getattr(resolved, "max_chars_source", None) or "placeholder"})',
        flush=True)
    return CatalogBudget(chars=cap, chars_per_sec=0.0)


def higgs_v3_config_from_worker_kwargs(voice=None, model_dir=None, base_dir=None,
                                       adapter_dir=None, caps=None, **extra):
    """Build a HiggsV3Config from the keywords `narrator.serve` hands an engine.

      voice       the voice NAME, looked up in the NARRATOR_HIGGS_VOICES document
      adapter_dir REFUSED - see below. A fine-tuned Higgs voice is a merged
                  CHECKPOINT and it comes from the voice document.
      model_dir   REFUSED - the model the server serves is the launch script's
                  argument, not a per-load field
      base_dir    REFUSED - v3 has no shared-base + adapter split of Orpheus's kind
      caps        REFUSED - the Orpheus cap names have no meaning here
    """
    from .config import load_voice
    if model_dir:
        raise ValueError(
            f'Higgs v3 load carried modelDir={model_dir!r}. The served model is the '
            "launch script's argument (serve_v3.sh), not a per-load field: changing "
            'it is a server restart, not a message.')
    if base_dir:
        raise ValueError(
            f'Higgs v3 load carried baseDir={base_dir!r}. v3 has no shared-base + '
            'per-voice-adapter split at all: a fine-tuned voice is a whole merged '
            'checkpoint the server runs ON (v3_served.CHECKPOINT_STRATEGY).')
    if caps:
        raise ValueError(
            f'Higgs v3 load carried caps={sorted(caps)}. Those are ORPHEUS tuning '
            'caps and v3 implements none of them - its sampling rides in '
            'extra_params and its default is the server\'s own. Refusing a payload '
            'that would look applied and do nothing.')
    if adapter_dir:
        # THE SAME REFUSAL `load_voices` MAKES, at the other boundary. The pool's
        # field is called `adapterDir`, and taking it as a merged checkpoint
        # would accept an actual LoRA directory here and hand it to
        # `vllm-omni serve` - which cannot load one (no adapter flags; the
        # talker does not implement SupportsLoRA) and would come up on garbage
        # or on the base model. The two are not interchangeable and the field
        # name cannot tell them apart, so this end refuses too.
        raise ValueError(
            f'Higgs v3 load carried adapterDir={adapter_dir!r}. There is no '
            'runtime LoRA on this stack, so an adapter directory has nothing to '
            'be loaded into - and it is NOT a merged checkpoint. A fine-tuned '
            "voice is declared in the NARRATOR_HIGGS_VOICES document as "
            '{"kind": "checkpoint", "checkpointDir": ...}, and the server is '
            'started on that directory.')
    if extra:
        raise ValueError(f'Higgs v3 load carried unknown keys: {sorted(extra)}.')
    if not (voice or '').strip():
        raise ValueError(
            'Higgs v3 load has no voice name. The name selects an entry in the '
            'NARRATOR_HIGGS_VOICES document; there is no default, and the model\'s '
            'own voice sits at 12 % of the narrator ceiling.')

    resolved = load_voice(
        voice.strip(),
        allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
        max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
        placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)
    strategy = (os.environ.get('NARRATOR_HIGGS3_ADAPTER_STRATEGY') or '').strip()
    if strategy:
        # Retained as a refusal, not a switch: the only strategy is 'checkpoint'
        # and the retired names say why in their own message.
        v3_served.check_strategy(strategy)
    return HiggsV3Config(
        voice=resolved,
        checkpoint_dir=getattr(resolved, 'checkpoint_dir', None))
