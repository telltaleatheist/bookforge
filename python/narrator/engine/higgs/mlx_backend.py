"""Higgs TTS 3, IN-PROCESS on Apple Silicon, through mlx-audio.

Registry id `higgs-v3`, backend `mlx`, `BackendSpec.kind == 'inprocess'`. The
same engine as `v3_engine.HiggsV3Engine`, on the other side of a platform
split: on Windows/Linux v3 runs in a vllm-omni SERVER over HTTP (there is no HF
modeling class and its torch cannot share an env with Orpheus's vLLM); on the
Mac `mlx_audio.tts.models.higgs_audio_v3` implements the whole model natively,
so the weights load into THIS process and there is nothing to launch, health-
check or kill.

Owen, 2026-09-05: "make sure the Mac has Higgs built in for streaming the model
via the browser extension. I use that constantly on the Mac."

WHAT THIS MODULE OWNS AND WHAT IT BORROWS

  borrowed   the model object, its weights, the tokenizer, the prompt builder,
             the codec, and the per-step sampler
             (`higgs_audio_v3.generation.step`) - all of mlx-audio 0.4.8.
  owned      the generation LOOP, the decode, and every number narrator states.

The loop is narrator's rather than `Model.generate`'s for three measured
reasons, each of which is a contract narrator cannot express through that call:

  1. `Model.generate` applies `fade_in_ms=30, fade_out_ms=15` to the waveform
     BY DEFAULT. narrator's fade is the ASSEMBLER's (`edge_fade`,
     EdgeFade(10, 25)) and no engine may bake one in - a chunk file that is
     already faded is faded twice.
  2. `Model.generate` has no `should_stop`. It is a generator that yields ONCE,
     at the end, so a cancel could only land between rows - and one v3 chunk is
     up to 600 characters, tens of seconds of generation.
  3. `Model._decode_audio` hands `reverse_delay_pattern`'s output straight to
     the codec with no check that every code is a real code. See THE DECODE.

THE DECODE, AT THE TOKEN LEVEL
------------------------------
v3's audio vocabulary is 8 codebooks x 1024 real codes plus two STREAM
SENTINELS: 1024 (BOC, begin-of-codes) and 1025 (EOC, end-of-codes). The codec's
codebooks hold exactly 1024 entries (`VectorQuantizer(codebook_size=1024)`), so
1024 and 1025 are OUT OF RANGE for it. mlx's `nn.Embedding` does not bounds-
check a gather, so a sentinel reaching the codec is not an error - it is
whatever memory that index lands on, decoded as sound.

The delay pattern offsets codebook c by c rows: audio frame t of codebook c
sits at stream row t + c. Reverting takes the diagonal,
`raw[t, c] = delayed[t + c, c]`, and consumes Q - 1 = 7 rows.

WHAT THAT MEANS FOR THE THREE ENDINGS mlx-audio's sampler can produce:

  ramp-up      rows 0..6 carry FORCED BOC in every codebook above the diagonal
               (`generation.step`, the `delay_count < n` branch). Those sit
               strictly ABOVE the diagonal and the revert reads only ON and
               BELOW it, so no BOC can reach the codec from the head. Measured
               below, not assumed.
  clean end    codebook 0 emits EOC at row e; the sampler then runs n - 2 = 6
               more rows and stops, so L = e + 7 and T = L - 7 = e. The EOC
               diagonal sits at `delayed[e + c, c]`, which is raw frame t = e -
               one past the last frame the revert produces. **On a clean ending
               the revert is EXACT and nothing needs trimming.** This is why
               the "every chunk ends in garbage" story was wrong, and why a
               blind trailing trim is a band-aid: on the shape it was written
               for it removes real audio.
  ragged end   the ramp-down is SAMPLED, not forced (unlike the ramp-up).
               Nothing makes the model put EOC exactly on the diagonal, and
               nothing stops it emitting a sentinel mid-stream. Any such code
               lands INSIDE a raw frame the revert keeps, and goes to the codec.

So the fix is neither a trim nor a substitution. It is a filter by TOKEN
IDENTITY, applied after the revert: **a frame is kept iff all 8 of its
codebooks are in [0, 1023]**. Nothing out of range is handed to the codec at
all. This is the same root fix the training side landed for vllm-omni
(work/patch_sentinel_filter.py), whose upstream substituted 0 for every
sentinel - and 0 is a VALID code that decodes to real sound, so the
substitution was the defect, not the cure.

`real_code_frames` reports what it dropped. A leading or trailing drop is a
ragged ending; an INTERIOR drop is not an expected shape and is logged, because
a gate is a defect sensor, not a silent repair. No fade is added on top: a cut
in the code domain lands on a frame boundary the codec never rendered, so there
is nothing to click. The 10/25 ms `edge_fade` narrator declares is the
ASSEMBLER's join contract and is unrelated.

`revert_delay_pattern` and `real_code_frames` are PURE NUMPY and import no mlx,
so they are unit-testable on the Windows interpreter and are pinned against
saved token matrices from the vllm-omni investigation
(`tests/golden/higgs_sentinel/`).

STREAMING
---------
`generate_batch_stream` emits WHOLE ROWS at retirement, and says so. That is not
a shortcut: a delay-pattern codec's window is incomplete in its last 7 frames by
construction (codebook c of frame t has not been emitted until step t + c), and
the ragged-ending filter above can only run once generation has finished, so a
mid-row window cannot tell a ramp-down from speech. `codec().streaming_decoder()`
returns None for the same reason. `should_stop` is checked EVERY generation
step, so a cancel lands in milliseconds even though audio does not.

NO MLX AT IMPORT. Every mlx / mlx_lm / mlx_audio import is inside a function,
exactly as `engine/orpheus/mlx_backend.py` does it, so this module imports on a
machine with no MLX at all (`tests/test_engine_lazy_imports.py`).
"""
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np

from ..log import log
from ..protocol import BackendSpec, ClipsVoice, DefaultVoice, StopPolicy
from . import v3_served
from .prompt import clean_text
from .v3_engine import HiggsV3Defaults, apply_v3_voice_defaults

#: Codebooks per frame, and the size of one codebook. The two stream sentinels
#: live immediately above the real codes.
NUM_CODEBOOKS = 8
NUM_REAL_CODES = 1024
AUDIO_BOC_ID = 1024      # begin-of-codes, forced by the sampler's ramp-up
AUDIO_EOC_ID = 1025      # end-of-codes, SAMPLED on the ramp-down

#: Where the base weights are. NO DEFAULT AND NO SEARCH: an unset variable is a
#: refusal naming it, because guessing a model directory is how a render ends up
#: in a different model's voice. The Mac's copy lives under
#: `~/Library/Application Support/BookForge/runtime/higgs-models/base`.
MODEL_ENV = 'NARRATOR_HIGGS3_MLX_MODEL'

#: The exact mlx-audio release this backend is written against. It is PINNED,
#: not floored: 0.5.1 cannot render Orpheus at all (pyproject `orpheus-mlx`),
#: and the private members used below are not a public API.
MLX_AUDIO_VERSION = '0.4.8'

#: The mlx-audio model package narrator loads, named EXPLICITLY rather than
#: sniffed out of `config.json` + the model path. See `load_engine`.
MLX_AUDIO_ARCH = 'higgs_audio_v3'


def _log(message: str) -> None:
    """One ASCII log line, to the HOST's log stream.

    NOT stdout-by-default: `narrator.serve`'s stdout IS the JSON-lines protocol,
    and a bare `print` from the engine layer lands between two protocol messages
    and breaks the client's parse. Found the first time this backend was driven
    through the real worker (2026-09-05): the load banner arrived where a
    `loaded` message was expected.

    Routed through `narrator.engine.log` so there is ONE mechanism for the whole
    engine layer rather than two. The default is stderr; the only host that
    redirects it to stdout is `narrator.compat.worker`, whose stdout
    parallel-tts-bridge.ts parses - and none of these strings match any of that
    bridge's five stdout-only patterns (checked: "loading Higgs v3 from ..." has
    no "model" token for MODEL_LOAD_START_RE, and "model loaded in 2.8s" lacks
    the "!" MODEL_LOAD_DONE_RE requires), so they are inert there.
    """
    log(f'[HIGGS-MLX] {message}')


# ---------------------------------------------------------------------------
# The decode, as pure numpy (no mlx; unit-tested on Windows)
# ---------------------------------------------------------------------------


class HiggsMlxStreamMisaligned(ValueError):
    """The delayed-row matrix cannot be turned into audio frames.

    Named for `engine.orpheus.errors.TokenStreamMisaligned` and for the same
    reason: a stream that cannot be interpreted is audio nobody can trust, so
    the row fails loudly instead of decoding whatever happens to be there.
    """


def revert_delay_pattern(delayed_lq) -> np.ndarray:
    """(L, 8) delayed stream rows -> (L - 7, 8) audio frames.

    `raw[t, c] = delayed[t + c, c]`: codebook c is delayed by c rows, so
    reverting takes the diagonal and consumes Q - 1 = 7 rows. Identical in
    content to `mlx_audio...higgs_audio_v3.generation.reverse_delay_pattern`
    (which returns the same thing as an mx.array); narrator keeps its own so the
    arithmetic is testable without mlx and so the FILTER below can run on the
    result before anything reaches the codec.

    A generation shorter than the diagonal carries no audio frames at all and
    returns an empty (0, 8) - it is not an error, it is a row that stopped
    before it said anything.
    """
    matrix = np.asarray(delayed_lq)
    if matrix.ndim != 2 or matrix.shape[1] != NUM_CODEBOOKS:
        raise HiggsMlxStreamMisaligned(
            f'Higgs v3 delayed rows must be (steps, {NUM_CODEBOOKS}); got shape '
            f'{tuple(matrix.shape)}')
    matrix = matrix.astype(np.int64, copy=False)
    keep = int(matrix.shape[0]) - (NUM_CODEBOOKS - 1)
    if keep <= 0:
        return np.zeros((0, NUM_CODEBOOKS), dtype=np.int64)
    return np.stack([matrix[c:c + keep, c] for c in range(NUM_CODEBOOKS)],
                    axis=1)


@dataclass(frozen=True)
class FrameFilterReport:
    """What `real_code_frames` dropped, and from where.

    `interior` is the one that matters: leading and trailing drops are a ragged
    ending, which the sampler can legitimately produce, while an interior drop
    means a sentinel appeared in the middle of speech and something is wrong
    upstream of the decode.
    """
    total: int
    kept: int
    leading: int
    interior: int
    trailing: int

    @property
    def dropped(self) -> int:
        return self.total - self.kept

    def as_log(self) -> str:
        return (f'frames {self.kept}/{self.total} kept '
                f'(lead {self.leading}, interior {self.interior}, '
                f'tail {self.trailing})')


def real_code_frames(raw_tq):
    """Keep only frames whose 8 codebooks are ALL real codes. -> (frames, report)

    THE ROOT FIX, decided by TOKEN IDENTITY and never by position or by audio
    content. Out-of-range values are the stream sentinels BOC=1024 / EOC=1025
    (and any negative pad). They are NOT substituted with 0: 0 is a valid
    codebook entry that decodes to real sound, which is exactly how the
    equivalent upstream code turned a ramp-down into an audible burst.

    Returns the kept frames and a `FrameFilterReport`. Nothing is trimmed on a
    clean ending, because on a clean ending the delay-pattern revert already
    ends one frame before the EOC diagonal and every frame is real.
    """
    frames = np.asarray(raw_tq)
    if frames.ndim != 2 or frames.shape[1] != NUM_CODEBOOKS:
        raise HiggsMlxStreamMisaligned(
            f'Higgs v3 audio frames must be (frames, {NUM_CODEBOOKS}); got shape '
            f'{tuple(frames.shape)}')
    total = int(frames.shape[0])
    if total == 0:
        return frames, FrameFilterReport(0, 0, 0, 0, 0)
    valid = ((frames >= 0) & (frames < NUM_REAL_CODES)).all(axis=1)
    kept_idx = np.nonzero(valid)[0]
    kept = int(kept_idx.size)
    if kept == 0:
        return (frames[:0], FrameFilterReport(total, 0, total, 0, 0))
    lo, hi = int(kept_idx[0]), int(kept_idx[-1])
    leading = lo
    trailing = total - 1 - hi
    interior = int((~valid[lo:hi + 1]).sum())
    return frames[valid], FrameFilterReport(total, kept, leading, interior,
                                            trailing)


def _report_frames(report: FrameFilterReport, label: str) -> None:
    """ASCII log lines, and a LOUD one for the shape that should not happen."""
    if report.interior:
        _log(f'{label}: {report.interior} INTERIOR sentinel frame(s) dropped - '
             f'this is not an expected shape ({report.as_log()})')
    if report.kept == 0 and report.total:
        _log(f'{label}: every frame carried a stream sentinel; this row '
             'produced no audio')


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def model_dir_from_env() -> str:
    """The base weights directory, or a refusal naming the variable.

    NOT a search and NOT a default: an engine that guesses where its weights are
    is one that can render a whole book in the wrong model and report success.
    """
    path = (os.environ.get(MODEL_ENV) or '').strip()
    if not path:
        raise ValueError(
            f'{MODEL_ENV} is not set. The Higgs v3 MLX backend loads the merged '
            f'weights from a directory (or an HF repo id); there is no default and '
            f'no search. Point {MODEL_ENV} at the base checkpoint - on this Mac '
            f'that is "$HOME/Library/Application Support/BookForge/runtime/'
            f'higgs-models/base" ({v3_served.MODEL_ID}, ~8.5 GB).')
    return path


@dataclass
class HiggsV3MlxConfig:
    """What one HiggsV3MlxEngine is built from.

    `model_dir` is the weights the model object is loaded FROM. For a
    `checkpoint` voice that is the voice's own merged directory - its weights
    ARE the voice, exactly as on the served arm, and the only difference is that
    here loading it is a `load_model` call rather than a server restart. For a
    `clips` or `default` voice it is the base checkpoint from `MODEL_ENV`.

    `sampling` EMPTY means THE MODEL DIRECTORY'S OWN SAMPLING - see
    `mlx_sampling`, which reads it from the checkpoint's
    `generation_config.json` rather than from a constant here. The remaining
    keys of `v3_served.SERVER_DEFAULT_SAMPLING` are the SERVER's
    (`repetition_penalty`, `seed`) and have no counterpart in mlx-audio's
    sampler; passing one is refused by name rather than silently ignored.
    """
    voice: object
    model_dir: str
    sampling: Optional[dict] = None
    seed: Optional[int] = 1234
    sentences_dir: Optional[str] = None
    process_dir: Optional[str] = None
    audio_format: str = 'flac'
    max_chars: int = HiggsV3Defaults.MAX_CHARS
    max_chars_per_sec: float = HiggsV3Defaults.MAX_CHARS_PER_SEC
    context_tokens: int = HiggsV3Defaults.CONTEXT_TOKENS

    #: The sampling keys mlx-audio's `step()` actually takes.
    MLX_SAMPLING_KEYS = ('temperature', 'top_p', 'top_k')

    def __post_init__(self):
        if not isinstance(self.voice, (ClipsVoice, DefaultVoice)):
            raise ValueError(
                'HiggsV3MlxConfig(voice=...) takes a ClipsVoice (reference clips '
                "with their book-exact transcripts) or a DefaultVoice (a fine-tuned "
                'checkpoint, or the model\'s own voice). Got '
                f'{type(self.voice).__name__}.')
        if not (self.voice.name or '').strip():
            raise ValueError('HiggsV3MlxConfig needs a NAMED voice.')
        self.voice = apply_v3_voice_defaults(self.voice)
        if isinstance(self.voice, ClipsVoice):
            v3_served.check_reference_budget(self.voice)
        if not (self.model_dir or '').strip():
            raise ValueError(
                f"HiggsV3MlxConfig for voice '{self.voice.name}' has no model_dir. "
                'The MLX backend loads weights from a directory; see '
                f'{MODEL_ENV}.')
        unknown = sorted(set(self.sampling or {}) - set(self.MLX_SAMPLING_KEYS))
        if unknown:
            raise ValueError(
                f'Higgs v3 MLX sampling carried {unknown}. mlx-audio\'s sampler takes '
                f"only {list(self.MLX_SAMPLING_KEYS)}; the rest of the SERVED "
                "defaults ('repetition_penalty', 'seed') are vllm-omni's and have no "
                'counterpart here. Refusing a lever that would look applied and do '
                'nothing.')
        # VALIDATE NOW, at construction - the same moment `HiggsV3Config` does.
        # Both real doors already validate before building a config, so this
        # closes an asymmetry rather than a live hole: a caller that constructs
        # the dataclass directly should not get an object whose first refusal
        # arrives from inside the generation loop.
        self.mlx_sampling()

    def mlx_sampling(self) -> dict:
        """The three levers actually handed to `step()` - FROM THE MODEL DIR.

        **mlx-audio DOES NOT READ `generation_config.json`.** Measured against
        mlx-audio 0.4.8 on the Mac, 2026-09-05: `grep -rn generation_config` over
        `tts/models/higgs_audio_v3/` returns NOTHING, while three other model
        packages in the same release do read it (`moss_tts.py:349`,
        `qwen3_tts.py:2914`, `stt/models/whisper/whisper.py:717`), so its absence
        here is a gap and not a convention. `Model.generate`
        (`higgs_audio_v3/model.py:751-753`) defaults `temperature=1.0`,
        `top_p=None`, `top_k=None`, and `generation.step`
        (`generation.py:114-141`) takes all three as required keyword arguments -
        `_apply_top_k`/`_apply_top_p` (`generation.py:62-77`) are no-ops for
        None. So on this runtime the CALLER is the only thing that can apply the
        checkpoint's sampling, and passing nothing samples the untruncated
        codebook tail exactly as an unconfigured vllm-omni does.

        So narrator reads the file itself, and the FILE is the authority:

          checkpoint voice   `<checkpointDir>/generation_config.json`, which
                             `v3_served.require_generation_config` has already
                             proved is there and carries all three keys. That is
                             the same file the served arm's vllm-omni reads, so
                             both arms render one voice at one sampling.
          base weights       there is NO file to read: the
                             `bosonai/higgs-audio-v3-tts-4b` snapshot ships none
                             (verified 2026-09-05 on the WSL HF cache AND on the
                             Mac's `runtime/higgs-models/base`), which is the
                             whole reason a MERGED dir has to carry one. The
                             authority for base weights is therefore v3's
                             documented deploy default,
                             `v3_served.SERVER_DEFAULT_SAMPLING` - stated here,
                             not guessed. The SERVED arm now states the same
                             values for the same weights, explicitly, in
                             `extra_params` (`HiggsV3Config.served_sampling`),
                             so base weights render alike on both arms.

        `sampling` is a named per-config override on top and stays what it was.

        A `repetition_penalty` OTHER THAN 1.0 in the file is REFUSED, not
        dropped. mlx-audio's `higgs_audio_v3` has no repetition penalty at all -
        `Model.generate` takes no such argument and the word appears nowhere in
        the package (PORT_NOTES 13.11) - so a checkpoint whose file asks for one
        would render on the Mac with no penalty while the SAME directory on the
        served arm applies it: one voice, two samplings, silently. 1.0 is a
        no-op and is accepted as the nothing it is. This is the same rule
        `__post_init__` applies to a user-supplied `repetition_penalty`; a lever
        the runtime cannot honour is a refusal at either door.
        """
        if self.voice.checkpoint_dir:
            document = v3_served.require_generation_config(
                self.voice.checkpoint_dir, self.voice.name)
            # Absence is a real state - the key is optional in the file and an
            # absent penalty is no penalty - so it is tested for, not defaulted.
            penalty = document['repetition_penalty'] if (
                'repetition_penalty' in document) else 1.0
            if float(penalty) != 1.0:
                raise ValueError(
                    f"Higgs v3 voice '{self.voice.name}': its "
                    f'{v3_served.GENERATION_CONFIG_FILE} in '
                    f'{self.voice.checkpoint_dir} asks for repetition_penalty '
                    f'{penalty}, and mlx-audio has NO repetition penalty - '
                    'higgs_audio_v3.Model.generate takes no such argument and the '
                    'lever does not exist anywhere in the package. Rendering here '
                    'anyway would give this checkpoint one sampling on the Mac and '
                    'another on the vllm-omni server, from the same file. Render '
                    'this voice on the served arm, or re-merge it with a '
                    'repetition_penalty of 1.0.')
        else:
            document = v3_served.SERVER_DEFAULT_SAMPLING
        resolved = {k: document[k] for k in self.MLX_SAMPLING_KEYS}
        resolved.update(self.sampling or {})
        return {'temperature': float(resolved['temperature']),
                'top_p': float(resolved['top_p']),
                'top_k': int(resolved['top_k'])}


# ---------------------------------------------------------------------------
# Codec and budget
# ---------------------------------------------------------------------------


class HiggsV3MlxCodec:
    """`protocol.Codec` for v3 on MLX - and unlike the served arm's codec, this
    one really decodes: the tokens ARE in this process.

    Geometry is v3's, unchanged: 8 codebooks at 25 fps, 24 kHz, 960 samples per
    frame, a 7-frame delay diagonal.
    """

    sample_rate = v3_served.SAMPLE_RATE
    frames_per_second = v3_served.FRAMES_PER_SECOND
    tokens_per_frame = NUM_CODEBOOKS
    samples_per_frame = int(v3_served.SAMPLE_RATE / v3_served.FRAMES_PER_SECOND)
    trim_frames = NUM_CODEBOOKS - 1

    def __init__(self, audio_decoder, label: str = ''):
        if not callable(audio_decoder):
            raise ValueError(
                'HiggsV3MlxCodec(audio_decoder) needs a callable taking a '
                '(frames, 8) int matrix and returning a float32 waveform '
                f'(the mlx-audio HiggsAudioTokenizer.decode); got '
                f'{type(audio_decoder).__name__}.')
        self._audio_decoder = audio_decoder
        self._label = label

    def frames_for_tokens(self, n_tokens: int) -> int:
        return int(n_tokens) // self.tokens_per_frame

    def audio_frames(self, generated_frames: int) -> int:
        """`generated_frames - 7`: reverting the delay pattern costs the
        diagonal. The sentinel filter may take MORE than this on a ragged
        ending, so it is a ceiling, not a promise."""
        return max(0, int(generated_frames) - self.trim_frames)

    def samples_for_frames(self, n_frames: int) -> int:
        return int(n_frames) * self.samples_per_frame

    def seconds_for_frames(self, n_frames: float) -> float:
        return float(n_frames) / self.frames_per_second

    def decode(self, tokens):
        """The delayed rows one generation produced -> 1-D float32 at 24 kHz.

        `tokens` is the (steps, 8) matrix of what the sampler emitted, exactly
        as generated - references and ramp-up included. Revert, filter by token
        identity, decode. Nothing else: no trim, no substitution, no fade.
        """
        raw, report = real_code_frames(revert_delay_pattern(tokens))
        _report_frames(report, self._label or 'decode')
        if raw.shape[0] == 0:
            raise HiggsMlxStreamMisaligned(
                'Higgs v3 MLX decode: no real-code frames survived the delay-pattern '
                'revert and the sentinel filter, so the row produced no speech. That '
                'is a failed render, not a silent one.')
        audio = self._audio_decoder(raw)
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        expected = self.samples_for_frames(int(raw.shape[0]))
        if audio.size != expected:
            raise HiggsMlxStreamMisaligned(
                f'Higgs v3 MLX decode: {raw.shape[0]} frames should decode to '
                f'{expected} samples at {self.sample_rate} Hz, got {audio.size}. The '
                'codec and this arithmetic disagree - refusing to ship audio of an '
                'unknown length.')
        return audio

    def streaming_decoder(self, decode_frames, label: str = ''):
        """None. A delay-pattern codec's window is incomplete in its last 7
        frames by construction, and the sentinel filter can only run once
        generation has finished, so a mid-row window cannot tell a ramp-down
        from speech. Rows are emitted at retirement instead; faking a stream out
        of independent decodes would ship audio the listener has already heard
        by the time anything could notice it was wrong."""
        return None


class HiggsV3MlxBudget:
    """`protocol.Budget` for v3 on MLX. Same numbers as the served arm - they
    are properties of the MODEL, not of the runtime."""

    def __init__(self, config: HiggsV3MlxConfig):
        self._config = config

    def _voice(self, voice):
        if voice is not None and voice != self._config.voice.name:
            raise ValueError(
                f"HiggsV3MlxBudget: this engine serves '{self._config.voice.name}', "
                f"not '{voice}'. One loaded model answers for one voice.")
        return self._config.voice

    def max_chars(self, voice=None) -> int:
        """THE VOICE's chunk size, or the engine placeholder for a base-weights
        voice. A FINE-TUNE with no `maxChars` is REFUSED, by the same rule as
        `OrpheusBudget.max_chars` and `HiggsV3Budget.max_chars`: a fine-tune's
        safe chunk length is a measured property of THAT model."""
        ref = self._voice(voice)
        if ref.max_chars is None:
            if ref.checkpoint_dir:
                raise ValueError(
                    f"Higgs v3 voice '{ref.name}' is a fine-tune "
                    f'({ref.checkpoint_dir}) and has no maxChars. Measure the safe '
                    'chunk length for THAT model and declare it in the voice document '
                    f"- refusing to pack a book at the base model's "
                    f'{self._config.max_chars}-char placeholder.')
            return int(self._config.max_chars)
        return int(ref.max_chars)

    def max_chars_source(self, voice=None) -> str:
        return self._voice(voice).max_chars_source or 'placeholder'

    def max_chars_per_sec(self, voice=None) -> float:
        return float(self._config.max_chars_per_sec)

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
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


def higgs_v3_mlx_stop_policy(config: HiggsV3MlxConfig) -> StopPolicy:
    """v3 stops on its own; what it does instead is DROP TEXT, so
    `coverage_check` is 'asr'. Identical to the served arm's policy but for
    `levers`, which reports the three sampling values this runtime can actually
    apply rather than the server's five."""
    return StopPolicy(
        max_new_tokens=v3_served.cap_frames('x' * int(config.max_chars)),
        eos_reliable=True,
        resplit_on_cap=False,
        max_chars_per_sec=float(config.max_chars_per_sec),
        levers={k: float(v) for k, v in config.mlx_sampling().items()},
        coverage_check='asr',
    )


# ---------------------------------------------------------------------------
# The engine
# ---------------------------------------------------------------------------


class HiggsV3MlxEngine:
    """One Higgs v3 model, loaded into this process by MLX."""

    ENGINE_ID = HiggsV3Defaults.ENGINE_ID          # 'higgs-v3'
    SAMPLE_RATE = HiggsV3Defaults.SAMPLE_RATE      # 24000
    pads = False
    edge_fade = HiggsV3Defaults.EDGE_FADE          # EdgeFade(10, 25)
    SUPPORTS_BATCH = True
    #: One row at a time. mlx-audio HAS a `batch_generate` with a left-padded
    #: BatchKVCache, and narrator does NOT use it: nothing here has measured it,
    #: and the Orpheus MLX backend's mixed-length batches are a KNOWN corruption
    #: hazard on this runtime. A measured widening is a separate change.
    BATCH_SIZE = 1

    def __init__(self, config: HiggsV3MlxConfig):
        if not isinstance(config, HiggsV3MlxConfig):
            raise ValueError(
                'HiggsV3MlxEngine(config) takes a '
                'narrator.engine.higgs.HiggsV3MlxConfig; got '
                f'{type(config).__name__}.')
        self.config = config
        self.backend = 'mlx'
        self.voice_ref = config.voice
        self.voice = config.voice.name
        self.params = {'samplerate': self.SAMPLE_RATE}
        self._model = None
        self._reference_codes = None
        self._reference_texts = None
        self._codec_obj = None
        self._budget = HiggsV3MlxBudget(config)
        # Resolved ONCE, from the model directory's generation_config.json (see
        # HiggsV3MlxConfig.mlx_sampling). Re-reading the file per chunk would ask
        # the same question thousands of times a book and would let the answer
        # change mid-render.
        self._sampling = config.mlx_sampling()
        self.load_engine()

    # ---- lifecycle ----------------------------------------------------------

    @classmethod
    def detect_backend(cls) -> str:
        """'mlx'. The import is the probe: a Mac without mlx-audio cannot serve
        this engine, and saying so here is what stops the worker handshaking as
        healthy and then failing every generate (PORT_NOTES 12.11)."""
        import mlx_audio.tts.utils  # noqa: F401
        return 'mlx'

    def load_engine(self):
        """Load the weights, the tokenizer and the codec, and encode the voice's
        reference clips ONCE.

        `mlx_audio.tts.utils.load_model` reads `config.json`, builds
        `higgs_audio_v3.Model`, applies its `sanitize()` weight-name map and
        then its `post_load_hook`, which builds the tokenizer from
        `tokenizer.json` and the codec from the SAME safetensors shards
        (`HiggsAudioTokenizer.from_higgs_tts_checkpoint`). So the OFFICIAL HF
        weights load directly - there is no MLX conversion step, no quantized
        mlx-community repo needed and no separate codec download.

        `model_type` IS PASSED EXPLICITLY, and that is not belt-and-braces.
        v3's `config.json` says `model_type: "higgs_multimodal_qwen3"`, and
        mlx-audio 0.4.8 does carry the remapping for it
        (`tts/utils.py:MODEL_REMAPPING`) - but `utils.get_model_class` can never
        reach it: the branch that applies a remapping is
        `elif model_type_mapped is not None`, guarded by
        `if model_name is not None and model_type_mapped != model_type`, and a
        real remapping ALWAYS differs from its key, so the first branch always
        wins and the alias is never consulted. That branch instead scans the
        model PATH's components for something that happens to be named like a
        model directory. Measured on this Mac, 2026-09-05:

            ValueError: Model type higgs_multimodal_qwen3 not supported for tts.

        Naming the weights directory `higgs_audio_v3` would satisfy that scan -
        and that is exactly the wrong fix: it makes a load depend on a directory
        name, and it leaves the same path scan free to pick a DIFFERENT
        architecture out of any other component of the path (`llama`, `spark`
        and `dense` are all real model directories). `model_type=` skips the
        sniffing entirely and states which architecture narrator wants. The
        assertion in `_require_mlx_audio_surface` proves it is what it got.
        """
        import time

        import mlx.core as mx
        from mlx_audio.tts.utils import load_model

        target = self.config.model_dir
        # Bound the MLX buffer cache, exactly as the Orpheus MLX backend does at
        # load. Without a limit the allocator keeps every freed buffer, and a
        # single long Higgs render (per-step generation buffers in many distinct
        # sizes, then the codec decode) grew one process to ~50 GB resident on
        # the M1 Ultra before `cleanup()`'s `mx.clear_cache()` ever ran (Owen,
        # 2026-09-05, watching the MLX cap sweep). A bounded cache keeps the
        # footprint flat for the whole run and still reuses buffers, which a
        # per-chunk flush does not. The knob is the same shape as Orpheus's:
        # HIGGS_MLX_CACHE_LIMIT_GB, a documented tunable with a measured default,
        # not a fallback for a value that should have been set.
        cache_gb = float(os.environ.get('HIGGS_MLX_CACHE_LIMIT_GB', '8'))
        mx.set_cache_limit(int(cache_gb * 1e9))
        _log(f'Higgs MLX buffer cache limited to {cache_gb:g} GB')
        _log(f'loading Higgs v3 from {target}')
        started = time.perf_counter()
        model = load_model(target, model_type=MLX_AUDIO_ARCH)
        self._require_mlx_audio_surface(model)
        mx.eval(model.parameters())
        elapsed = time.perf_counter() - started
        _log(f'model loaded in {elapsed:.1f}s '
             f'(peak {mx.get_peak_memory() / 1e9:.2f} GB)')
        self._model = model
        self._codec_obj = HiggsV3MlxCodec(
            self._decode_frames, label=f'voice {self.voice}')
        self._encode_references()
        _log(f'sampling {self._sampling} from ' + (
            os.path.join(self.config.voice.checkpoint_dir,
                         v3_served.GENERATION_CONFIG_FILE)
            if self.config.voice.checkpoint_dir
            else "v3's deploy default (the base weights carry no "
                 'generation_config.json)'))
        return model

    @staticmethod
    def _require_mlx_audio_surface(model) -> None:
        """The loop below drives mlx-audio's model through members that are not
        a public API. Say so, and REFUSE by name when one is missing, rather
        than discovering it half a book in.

        Pinned to mlx-audio MLX_AUDIO_VERSION; a newer release that renames one
        of these must be measured, not adapted to at runtime.
        """
        # WHICH ARCHITECTURE ACTUALLY LOADED. mlx-audio's type resolution scans
        # the model PATH for a component named like one of its model packages
        # (see load_engine), so a directory called `llama` or `dense` anywhere in
        # the path could still override the explicit `model_type`. Check the
        # class narrator got rather than the one it asked for.
        module = type(model).__module__
        if not module.endswith(f'.{MLX_AUDIO_ARCH}.model'):
            raise RuntimeError(
                f'mlx-audio loaded {module}.{type(model).__name__} for a Higgs v3 '
                f'checkpoint; narrator asked for {MLX_AUDIO_ARCH}. mlx-audio picks an '
                'architecture partly from the model PATH, so a path component named '
                'like another model package can hijack the load - rename the weights '
                'directory rather than render a book with the wrong model.')
        needed = ('_build_prompt_embeddings', '_audio_logits',
                  '_embed_audio_codes', 'backbone', 'config', 'codec')
        missing = [name for name in needed if not hasattr(model, name)]
        if missing:
            raise RuntimeError(
                f'mlx-audio\'s higgs_audio_v3 model is missing {missing}. narrator\'s '
                f'MLX backend drives it through those members and is written against '
                f'mlx-audio {MLX_AUDIO_VERSION}; a release that renamed them needs the '
                'loop re-measured, not a guess at the new names.')
        if model.codec is None:
            raise RuntimeError(
                'mlx-audio loaded the Higgs v3 model with NO codec '
                '(post_load_hook found neither an audio_tokenizer/ directory nor '
                'codec tensors in the safetensors shards). There is nothing to turn '
                'tokens into audio - refusing to report a loaded engine.')
        if int(model.config.audio_num_codebooks) != NUM_CODEBOOKS:
            raise RuntimeError(
                f'Higgs v3 checkpoint declares '
                f'{model.config.audio_num_codebooks} codebooks; this backend\'s '
                f'delay-pattern arithmetic is written for {NUM_CODEBOOKS}.')
        if int(model.config.sample_rate) != v3_served.SAMPLE_RATE:
            raise RuntimeError(
                f'Higgs v3 checkpoint declares sample rate '
                f'{model.config.sample_rate}; narrator states '
                f'{v3_served.SAMPLE_RATE} on the wire and in every manifest.')

    def _encode_references(self) -> None:
        """A ClipsVoice's reference audio, encoded ONCE at load.

        The reference is re-used verbatim for every chunk, so encoding it per
        request would pay the codec's encoder (HuBERT + the RVQ) thousands of
        times for an identical answer. mlx-audio exposes exactly this:
        `encode_reference_audio` returns the DELAYED reference codes that
        `generate(ref_audio_codes=...)` takes.
        """
        voice = self.voice_ref
        if not isinstance(voice, ClipsVoice):
            self._reference_codes = None
            self._reference_texts = None
            return
        codes, texts = [], []
        for clip in voice.clips:
            codes.append(self._model.encode_reference_audio(clip.path))
            texts.append(clip.transcript)
        self._reference_codes = codes
        self._reference_texts = texts
        total = v3_served.reference_seconds(voice)
        _log(f'encoded {len(codes)} reference clip(s) ({total:.1f}s) '
             f'for voice {self.voice}')

    def cleanup(self) -> None:
        """Release the model and let MLX give the memory back. Idempotent."""
        self._model = None
        self._codec_obj = None
        self._reference_codes = None
        self._reference_texts = None
        try:
            import mlx.core as mx
        except ImportError:
            return
        mx.clear_cache()

    # ---- the seam -----------------------------------------------------------

    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """The SAME refusals as the served arm, for the same reasons.

        `modelDir` is refused even though this backend does load a directory:
        which weights it loads is decided by the VOICE (a `checkpoint` voice
        names its own merged directory) or by MODEL_ENV, never by a per-load
        field - a load that could re-point the weights would let one worker
        answer for two different models under one name.
        """
        if model_dir:
            raise ValueError(
                f'Higgs v3 load carried modelDir={model_dir!r}. Which weights the MLX '
                f'backend loads comes from the voice document (a "checkpoint" voice '
                f'names its own merged directory) or from {MODEL_ENV}, not from a '
                'per-load field.')
        if base_dir:
            raise ValueError(
                f'Higgs v3 load carried baseDir={base_dir!r}. v3 has no shared-base + '
                'per-voice-adapter split.')
        if adapter_dir:
            raise ValueError(
                f'Higgs v3 load carried adapterDir={adapter_dir!r}. A fine-tuned Higgs '
                'voice is a MERGED checkpoint declared in the NARRATOR_HIGGS_VOICES '
                'document ({"kind": "checkpoint", "checkpointDir": ...}), not an '
                'adapter directory - and mlx-audio loads whole weights, not adapters.')
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
            # The checkpoint's REQUIRED FILES, at the load message - here the
            # generation_config.json is not just the server's sampling, it is
            # THIS process's (see HiggsV3MlxConfig.mlx_sampling).
            v3_served.checkpoint_serve_target(checkpoint, resolved.name)
        return name

    def backend_spec(self) -> BackendSpec:
        """IN-PROCESS. This is the whole point of the Mac arm: the weights are
        in this interpreter, so there is no server to launch, health-check or
        kill, and no HTTP between a chunk and its audio."""
        return BackendSpec(
            kind='inprocess', name='mlx',
            notes=f'mlx-audio {MLX_AUDIO_VERSION} higgs_audio_v3, '
                  f'weights {self.config.model_dir}')

    def codec(self) -> HiggsV3MlxCodec:
        if self._codec_obj is None:
            raise RuntimeError(
                'HiggsV3MlxEngine.codec(): the engine has been cleaned up; its codec '
                'went with the model.')
        return self._codec_obj

    def budget(self) -> HiggsV3MlxBudget:
        return self._budget

    def stop_policy(self, voice=None) -> StopPolicy:
        if voice is not None and voice != self.voice:
            raise ValueError(
                f'HiggsV3MlxEngine.stop_policy({voice!r}): this engine holds '
                f"'{self.voice}'. A second voice is a second engine.")
        return higgs_v3_mlx_stop_policy(self.config)

    def set_voice(self, voice: str, adapter_dir: str = None) -> None:
        """A second load on a live worker.

        The SAME voice is a no-op, which is what a pool re-issuing an identical
        load wants. A DIFFERENT voice is refused by name: a v3 voice is either a
        merged checkpoint (different weights - this engine holds one model) or a
        reference set encoded against those weights, and swapping either in
        place would leave the worker reporting voice B while it renders voice A.
        Unlike the served arm the fix is cheap - quit and reload, no 55-300 s
        server start - but it is still a reload.
        """
        want = (voice or '').strip()
        if adapter_dir:
            raise ValueError(
                f'HiggsV3MlxEngine.set_voice({want!r}, adapterDir={adapter_dir!r}): '
                'there is no runtime adapter on this stack.')
        if want == self.voice:
            return
        raise ValueError(
            f'HiggsV3MlxEngine cannot switch voice in place: this process loaded '
            f"'{self.voice}' from {self.config.model_dir}, and a load for '{want}' "
            'needs the weights and/or the encoded reference of a different voice. '
            'Quit this worker and start one for that voice.')

    def _apply_voice_caps(self, voice: str, caps: dict) -> None:
        """The Orpheus tuning caps have no meaning here. An EMPTY payload is the
        pool's "no catalog tuning" signal and is the no-op it looks like;
        anything else is refused by name."""
        if caps:
            raise ValueError(
                f'Higgs v3 load for {voice!r} carried caps={sorted(caps)}. Those are '
                'ORPHEUS tuning caps and v3 implements none of them.')

    def _clean_sentence_for_tts(self, sentence: str) -> str:
        """The SML strip, shared by every engine."""
        return clean_text(sentence)

    # ---- generation ---------------------------------------------------------

    def _seed_for(self, index: int):
        """THE seed rule, one place: chunk i renders with `seed + i`.

        Same rule as the served arm. A re-render of one chunk reproduces it, and
        two chunks of a batch never share a draw - rendering every sentence at a
        flat seed makes a whole book of identical draws for identical text.
        """
        if self.config.seed is None:
            return None
        return int(self.config.seed) + int(index)

    def _decode_frames(self, frames_tq):
        """(frames, 8) real codes -> a float32 waveform. The codec call, and
        nothing else - every filter has already run in HiggsV3MlxCodec.decode."""
        import mlx.core as mx
        codes = mx.array(np.ascontiguousarray(frames_tq.astype(np.int32)))
        audio = self._model.codec.decode(codes)
        mx.eval(audio)
        return np.asarray(audio, dtype=np.float32).reshape(-1)

    def _generate_delayed_rows(self, text: str, cap: int, seed,
                               should_stop=None):
        """Run the sampler and return the (steps, 8) delayed rows, or None if
        `should_stop` went true mid-row.

        This is `Model.generate`'s loop with three differences and no others:
        `should_stop` is checked every step, no fade is applied (there is no
        waveform here at all - the caller decodes), and the rows are returned as
        emitted so the decode can filter them by token identity.
        """
        import mlx.core as mx
        from mlx_audio.tts.models.higgs_audio_v3.generation import (
            HiggsSamplerState, step)
        from mlx_lm.models.cache import make_prompt_cache

        model = self._model
        if model is None:
            raise RuntimeError(
                'HiggsV3MlxEngine: no model is loaded (cleanup() has run).')
        if seed is not None:
            mx.random.seed(int(seed))

        references = self._references_for()
        prompt_embeds, prompt_tokens = model._build_prompt_embeddings(
            text, references)
        mx.eval(prompt_embeds)
        # The context window is a CEILING the prompt eats into; refuse a prompt
        # that already fills it rather than generating into nothing.
        self._budget.max_total_tokens(int(prompt_embeds.shape[1]))

        cache = make_prompt_cache(model)
        hidden = model.backbone(
            mx.zeros((1, prompt_embeds.shape[1]), dtype=mx.int32),
            cache=cache, input_embeddings=prompt_embeds)
        last_hidden = hidden[:, -1, :]

        state = HiggsSamplerState(num_codebooks=NUM_CODEBOOKS)
        sampling = self._sampling
        rows = []
        for _ in range(int(cap)):
            if should_stop is not None and should_stop():
                return None
            codes = step(model._audio_logits(last_hidden)[0], state,
                         temperature=sampling['temperature'],
                         top_p=sampling['top_p'], top_k=sampling['top_k'],
                         boc_id=int(model.config.audio_boc_token_id),
                         eoc_id=int(model.config.audio_eoc_token_id))
            rows.append(codes)
            if state.generation_done:
                break
            next_embed = model._embed_audio_codes(codes)[None]
            hidden = model.backbone(mx.zeros((1, 1), dtype=mx.int32),
                                    cache=cache, input_embeddings=next_embed)
            last_hidden = hidden[:, -1, :]
        if not rows:
            raise HiggsMlxStreamMisaligned(
                f'Higgs v3 MLX: the sampler emitted no rows at all for a '
                f'{len(text)}-char chunk (cap {cap} frames, prompt {prompt_tokens} '
                'tokens).')
        stacked = mx.stack(rows, axis=0)
        mx.eval(stacked)
        return np.asarray(stacked).astype(np.int64)

    def _references_for(self):
        """The encoded reference clips as mlx-audio's `ReferenceCodes`, or ()
        for a DefaultVoice (a fine-tuned checkpoint, or the model's own voice) -
        both of which are prompted with TEXT ALONE."""
        if self._reference_codes is None:
            return ()
        from mlx_audio.tts.models.higgs_audio_v3.prompt import ReferenceCodes
        return [ReferenceCodes(codes=codes, text=text)
                for codes, text in zip(self._reference_codes,
                                       self._reference_texts)]

    def render_audio(self, text: str, seed=None, index: int = 0,
                     should_stop=None):
        """One chunk of text -> a float32 mono waveform at 24 kHz.

        `index` is the chunk's own index and is what seeds it (see `_seed_for`);
        an explicit `seed` overrides. Returns None only when `should_stop` went
        true mid-generation.
        """
        clean = (text or '').strip()
        if not clean:
            raise ValueError('HiggsV3MlxEngine.render_audio(): the chunk has no text')
        # The 45-token allowlist. An UNKNOWN control token is not ignored: the
        # model reads it out loud as words and the chunk collapses.
        v3_served.validate_control_tokens(clean)
        rows = self._generate_delayed_rows(
            clean, self._budget.cap_frames(clean),
            self._seed_for(index) if seed is None else seed,
            should_stop=should_stop)
        if rows is None:
            return None
        return self.codec().decode(rows)

    def _sentence_file(self, sentence_number: int) -> str:
        if not self.config.sentences_dir:
            raise ValueError(
                'HiggsV3MlxEngine.convert() needs a sentences_dir: this engine was '
                'built for in-memory generation, so there is nowhere to write chunk '
                f'{sentence_number}. Use generate_batch_stream / render_audio.')
        return os.path.join(self.config.sentences_dir,
                            f'{sentence_number}.{self.config.audio_format}')

    def convert(self, sentence_number: int, sentence: str) -> bool:
        """Render one chunk to `<sentences_dir>/<n>.<audio_format>`, EXACTLY AS
        DECODED - no trim, no fade, no pad. The fades are the assembler's
        (`edge_fade`) and the gaps are the manifest's."""
        import soundfile as sf
        path = self._sentence_file(sentence_number)
        audio = self.render_audio(sentence, index=sentence_number)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        sf.write(path, audio, self.SAMPLE_RATE, subtype='PCM_16',
                 format=self.config.audio_format.upper())
        return True

    def convert_batch(self, items) -> list:
        """SERIAL - see BATCH_SIZE."""
        return [self.convert(index, text) for index, text in items]

    def generate_batch_stream(self, texts, voices, stream_rows, on_chunk, on_row,
                              should_stop=None) -> None:
        """Whole rows, at retirement - the honest cadence for this codec.

        A row asked to stream gets its audio as a single `on_chunk(row, 0, pcm)`
        before its `on_row`: the streaming channel, filled with what there
        actually was, when there actually was it. See the module docstring for
        why a mid-row window is not sound here.

        A row abandoned because `should_stop` went true gets NO `on_row`, so a
        caller can never mistake an abandoned row for a finished one.
        """
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'HiggsV3MlxEngine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        if voices is not None:
            wrong = sorted({v for v in voices if v and v != self.voice})
            if wrong:
                raise ValueError(
                    f'HiggsV3MlxEngine.generate_batch_stream: rows ask for voice(s) '
                    f"{wrong}; this engine holds '{self.voice}'. One loaded model "
                    'answers for one voice, so a mixed-voice batch is impossible.')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'HiggsV3MlxEngine.generate_batch_stream: stream_rows names row(s) '
                f'{stray} outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'HiggsV3MlxEngine.generate_batch_stream: stream_rows is non-empty but '
                'no on_chunk was given')
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'HiggsV3MlxEngine.generate_batch_stream: row(s) {blank} have no text '
                'after cleaning.')

        for i, text in enumerate(texts):
            if should_stop is not None and should_stop():
                return
            audio = self.render_audio(text, index=i, should_stop=should_stop)
            if audio is None:      # should_stop went true mid-row
                return
            if i in stream_rows:
                on_chunk(i, 0, audio.copy())
            on_row(i, audio)


# ---------------------------------------------------------------------------
# The registry's factory
# ---------------------------------------------------------------------------


def higgs_v3_mlx_config_from_worker_kwargs(voice=None, model_dir=None,
                                           base_dir=None, adapter_dir=None,
                                           caps=None, **extra):
    """Build a HiggsV3MlxConfig from the keywords `narrator.serve` hands an
    engine. The refusals are `resolve_load_voice`'s, at the other boundary."""
    from .config import load_voice
    HiggsV3MlxEngine.resolve_load_voice(
        voice, model_dir=model_dir, adapter_dir=adapter_dir, base_dir=base_dir)
    if caps:
        raise ValueError(
            f'Higgs v3 load carried caps={sorted(caps)}. Those are ORPHEUS tuning '
            'caps and v3 implements none of them.')
    if extra:
        raise ValueError(f'Higgs v3 load carried unknown keys: {sorted(extra)}.')
    resolved = load_voice(
        voice.strip(),
        allowed_controls=HiggsV3Defaults.ALLOWED_CONTROLS,
        max_reference_seconds=HiggsV3Defaults.MAX_REFERENCE_SECONDS,
        placeholder_max_chars=HiggsV3Defaults.MAX_CHARS)
    # A fine-tuned voice's WEIGHTS are the voice, so the model loaded is the
    # voice's own checkpoint. Everything else loads the base.
    checkpoint = getattr(resolved, 'checkpoint_dir', None)
    if checkpoint:
        v3_served.checkpoint_serve_target(checkpoint, resolved.name)
    return HiggsV3MlxConfig(voice=resolved,
                            model_dir=checkpoint or model_dir_from_env())
