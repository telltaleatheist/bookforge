"""The engine seam: what narrator needs of ANY LLM-codec TTS engine.

Designed in `docs/NARRATOR_PLAN.md` ("Engine interface"), shaped by two MEASURED
engines - Orpheus (SNAC: 7 tokens per ~11.72 Hz frame, 24 kHz, an audio-token cap,
EOS boost/floor levers, silence baked into every chunk) and Higgs v2 (8 codebooks
at 25 Hz with a delay pattern, 24 kHz, an 8,192-token context, EOS that fires
unaided, NO pads at either end) - and by one rejected (Llasa-8B, whose 2,048-token
total-sequence wall is what proved the Budget seam has to be about TOKENS and not
only characters).

Nothing here imports torch, vLLM, mlx or transformers, and nothing here is
Orpheus-specific: every Orpheus lever (eosBoost, eosFloor, the rate ratchet, the
truncation ladder, the short-chunk backstop) sits behind `StopPolicy.levers`,
opaque to the worker and the scheduler.

THE FOUR TYPES

  Codec        token stream -> waveform, and the frame arithmetic that goes with
               it. The only place a sample rate, a frame rate or a trim
               convention is allowed to be a number.
  VoiceRef     what "a voice" IS for an engine: a fine-tuned token (Orpheus), a
               set of reference clips WITH TRANSCRIPTS (Higgs), or a description
               (Maya1, later). A tagged union, not a string.
  Budget       how much text/how many tokens one chunk may carry. The chunk
               packer asks this; it never holds a constant of its own.
  StopPolicy   what makes generation stop, and whether a stop can be trusted.

`Engine` ties them together. `runtime_checkable` is deliberate: the registry and
tests assert conformance with isinstance() rather than trusting a docstring.

NOTE on runtime_checkable Protocols: isinstance() checks that every named member
EXISTS on the object (methods and attributes alike); it does NOT check
signatures. That is exactly the guard wanted here - a missing `pads` or a missing
`stop_policy` is caught, and the signatures are pinned by the tests that call
them.
"""
from dataclasses import dataclass, field
from typing import (Any, Callable, Mapping, Optional, Protocol, Sequence,
                    Tuple, Union, runtime_checkable)

# ---------------------------------------------------------------------------
# Voices
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceClip:
    """One reference recording and THE TEXT THAT WAS ACTUALLY SPOKEN IN IT.

    THE TRANSCRIPT IS NEVER AN ASR GUESS. It is the book-exact text the clip was
    cut from - the corpus row it came from, or the narration copy AFTER the
    narration-text pass (numbers, abbreviations and clock times already in their
    spoken forms). This is the same law the training corpora are held to
    (`orpheus-training-text-doctrine`): a transcript that says what the model
    hears is what teaches it the mapping; a transcript that merely says what an
    ASR THOUGHT it heard teaches it the ASR's errors.

    A clip whose transcript is empty is REFUSED at construction rather than
    quietly cloned from - a zero-shot clone conditioned on a wrong or absent
    transcript is a whole book in a subtly wrong voice, reported as success.

    WHICH CLIPS TO PICK (measured on Higgs, 2026-09-04, ECAPA cosine against the
    real narrator; self-ceiling 0.766):
      - SAME-BOOK clips beat cross-book by +0.076 cosine. Pick the reference out
        of the book being narrated whenever the corpus has one.
      - A SECOND clip adds +0.012. Worth having, far smaller than same-book.
      - `seconds` is optional and only used to enforce an engine's total
        reference budget (Higgs v3 caps the references at 30 s TOTAL; 42 s is
        an HTTP 400). Leave it None when the duration is not known and the
        engine will measure the file.
    """
    path: str
    transcript: str
    seconds: Optional[float] = None

    def __post_init__(self):
        if not (self.path or '').strip():
            raise ValueError('ReferenceClip requires a path')
        if self.seconds is not None and self.seconds <= 0:
            raise ValueError(
                f'ReferenceClip({self.path!r}) has seconds={self.seconds!r}; a '
                'duration is a positive number of seconds or None.')
        if not (self.transcript or '').strip():
            raise ValueError(
                f'ReferenceClip({self.path!r}) has no transcript. A reference clip '
                'is only usable with the BOOK-EXACT text spoken in it (the corpus '
                'row, or the narration copy after the narration-text pass) - never '
                'a transcription, and never nothing.')


@dataclass(frozen=True)
class TokenVoice:
    """Orpheus: the voice IS a token in the prompt (`deathstalker: <text>`), and
    the same token keys the LoRA adapter registry."""
    name: str
    kind: str = field(default='token', init=False)

    def __post_init__(self):
        if not (self.name or '').strip():
            raise ValueError('TokenVoice requires a voice token')


@dataclass(frozen=True)
class ClipsVoice:
    """Zero-shot cloning: reference clips placed in the CHAT HISTORY, each as a
    (user: transcript, assistant: audio) turn, optionally under a scene
    description.

    **DIAGNOSTIC, NOT THE PRODUCTION PATH** (Owen, 2026-09-04 evening).
    Production narration is FINE-TUNED VOICES ONLY - a merged checkpoint whose
    weights are the voice, prompted with text alone (`DefaultVoice`). Zero-shot
    cloning stays working and tested because it is how a voice is auditioned
    before anyone trains it, and how a regression in the reference path is
    caught - but it recovers only ~90 % of speaker identity (0.692 ECAPA cosine
    against a 0.766 self-ceiling) and no book is expected to ship on it.

    Two engine-version constraints ride on this object rather than on a constant
    somewhere downstream, because they differ BETWEEN Higgs versions:

    `checkpoint_dir` names a MERGED fine-tune whose weights are the voice. Not
    an adapter: vllm-omni cannot load a LoRA at runtime (it exposes no adapter
    flags and its talker class does not implement `SupportsLoRA`), so a Higgs
    voice ships as a full ~8.5 GB checkpoint directory and the server is started
    ON it. The LoRA is the archival artifact; merging is a CPU step outside
    narrator.

    `allowed_controls`   the inline control tokens this engine understands
                         (v3: emotion / style / prosody / sfx; v2: none, and
                         `<|scene_desc_start|>` is v2-ONLY - it is a v2 chat
                         role, not a control token). An UNKNOWN control token is
                         not ignored: the model READS IT ALOUD AS WORDS. Empty
                         means "this engine takes no control tokens".
    `max_reference_seconds`  total reference audio the engine will accept. Higgs
                         v3 caps it at 30 s ACROSS ALL CLIPS (42 s returns HTTP
                         400), which is about two of our 14 s clips. None means
                         no measured cap (Higgs v2 took 28.5 s of reference
                         happily and the cap there is context, not a rule).

    Neither is enforced here - the engine that owns the numbers enforces them,
    with its own message - but they travel WITH the voice so the refusal can
    happen before a render starts.

    `max_chars` is the PACKER's chunk size for THIS voice, and `max_chars_source`
    says where it came from ('catalog' when the voice document declared it,
    'placeholder' when it is the engine's measured default). A FINE-TUNED voice
    (`adapter_dir` set) with no `max_chars` is refused by the engine, exactly as
    Orpheus refuses a `maxChars`-less catalog payload: a fine-tune is tuned, and
    rendering it at the base model's chunk size is a whole book packed for a
    model that no longer exists.
    """
    clips: Tuple[ReferenceClip, ...]
    name: Optional[str] = None
    scene: Optional[str] = None
    checkpoint_dir: Optional[str] = None
    allowed_controls: Tuple[str, ...] = ()
    max_reference_seconds: Optional[float] = None
    max_chars: Optional[int] = None
    max_chars_source: Optional[str] = None
    kind: str = field(default='clips', init=False)

    def __post_init__(self):
        if not self.clips:
            raise ValueError(
                'ClipsVoice requires at least one reference clip; a zero-shot clone '
                'with no reference is just the model default voice, which is not '
                'the voice that was asked for.')
        for clip in self.clips:
            if not isinstance(clip, ReferenceClip):
                raise ValueError(
                    f'ClipsVoice takes ReferenceClip objects, got {type(clip).__name__} '
                    f'({clip!r}) - the transcript is part of the voice, not optional.')
        _check_max_chars(self)


#: Where a voice's `max_chars` came from. A number with no provenance is one
#: nobody can decide whether to trust, so the source is required alongside it.
#:   catalog       declared for this voice in the voice document
#:   placeholder   the engine's measured default for its BASE weights
#:   length-sweep  measured for this voice by a coverage sweep
MAX_CHARS_SOURCES = ('catalog', 'placeholder', 'length-sweep')


@dataclass(frozen=True)
class DefaultVoice:
    """A TEXT-ONLY PROMPT: no reference audio in the request at all.

    Two things wear this shape, and the second is **the production path**:

      `checkpoint_dir` set   a FINE-TUNED voice. Its weights ARE the voice, so
                             it needs no reference clips and is prompted with
                             text alone. Owen, 2026-09-04: production narration
                             is fine-tuned voices only. This is the primary,
                             best-tested request narrator makes.
      `checkpoint_dir` None  the model's OWN voice - the base checkpoint with
                             no conditioning. A legitimate served shape (v3
                             renders text-only happily, and the app catalog
                             ships exactly one such entry) and the right thing
                             for a smoke test or a demo. KNOW WHAT IT COSTS:
                             0.093 ECAPA cosine against the narrator, 12 % of
                             the 0.766 self-ceiling. It is never what a book
                             asked for by accident.

    It is a separate member of the union rather than "a ClipsVoice with no
    clips" because those are different things and only one of them is
    intentional - `ClipsVoice` keeps its >= 1 clip rule, so a clone that lost
    its references is still an error rather than a silent downgrade to this.
    """
    name: Optional[str] = None
    checkpoint_dir: Optional[str] = None
    max_chars: Optional[int] = None
    max_chars_source: Optional[str] = None
    kind: str = field(default='default', init=False)

    def __post_init__(self):
        _check_max_chars(self)


def _check_max_chars(voice) -> None:
    """Every voice's chunk size must say where it came from."""
    if voice.max_chars is None:
        if voice.max_chars_source is not None:
            raise ValueError(
                f'{type(voice).__name__}({voice.name!r}) has max_chars_source '
                f'{voice.max_chars_source!r} with no max_chars.')
        return
    if voice.max_chars_source is None:
        raise ValueError(
            f'{type(voice).__name__}({voice.name!r}) carries '
            f'max_chars={voice.max_chars} with no max_chars_source. Say where it '
            f"came from ({' | '.join(MAX_CHARS_SOURCES)}) - a number whose "
            'provenance is unknown is one nobody can decide whether to trust.')
    if voice.max_chars_source not in MAX_CHARS_SOURCES:
        raise ValueError(
            f'{type(voice).__name__}({voice.name!r}): max_chars_source '
            f'{voice.max_chars_source!r} is not one of '
            f"{' | '.join(MAX_CHARS_SOURCES)}.")


@dataclass(frozen=True)
class DescriptionVoice:
    """Maya1 (not implemented): the voice is a natural-language description."""
    text: str
    name: Optional[str] = None
    kind: str = field(default='description', init=False)

    def __post_init__(self):
        if not (self.text or '').strip():
            raise ValueError('DescriptionVoice requires a description')


VoiceRef = Union[TokenVoice, ClipsVoice, DefaultVoice, DescriptionVoice]


# ---------------------------------------------------------------------------
# Stopping
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EdgeFade:
    """The fade an ASSEMBLER applies at each end of a chunk, in milliseconds.

    ASYMMETRIC ON PURPOSE, and that is why this is not one number: a chunk
    begins on an attack the ear expects and ends on a decay it does not, so the
    tail needs more than twice the window the head does. Higgs measured 10 in /
    25 out to take a decoded edge from about -30 dB to -45..-48 dB; Orpheus is
    0/0 because it trims and pads its own edges, so a chunk FLAC is already the
    complete unit.

    `as_manifest()` is the manifest's `edgeFadeMs` block, and the values here
    must agree with `narrator.assemble.engine_profiles.PROFILES` - the
    assembler's copy of the same table, which exists because assembly runs on a
    machine with no engine to ask. `tests/test_engine_protocol.py` asserts the
    two agree; a disagreement is an audiobook that clicks at every join.
    """
    in_ms: float = 0.0
    out_ms: float = 0.0

    def __post_init__(self):
        if self.in_ms < 0 or self.out_ms < 0:
            raise ValueError(
                f'EdgeFade({self.in_ms}, {self.out_ms}): a fade is a non-negative '
                'number of milliseconds.')

    @property
    def is_none(self) -> bool:
        return self.in_ms == 0.0 and self.out_ms == 0.0

    def as_manifest(self) -> dict:
        return {'in': float(self.in_ms), 'out': float(self.out_ms)}


@dataclass(frozen=True)
class StopPolicy:
    """Why and when one chunk's generation ends - in engine-agnostic terms.

    The worker, the scheduler and the chunk packer read the four named fields.
    `levers` is the engine's OWN tuning, carried so a log line or a guard event
    can report it, and read by nothing outside the engine that produced it:
    Orpheus puts eosBoost / eosBoostStart / eosFloor / eosFloorRate / temperature
    / topP / minP / repPenalty there; Higgs v3 puts temperature / top_p / top_k
    there and needs no EOS help at all (measured: EOS 9/9 across 132-898 char
    chunks, zero runaways).

    max_new_tokens        the generation cap for ONE chunk, in the engine's own
                          step unit (Orpheus: audio tokens, 7 per SNAC frame;
                          Higgs: frames, one LM step each).
    eos_reliable          True when the model stops on its own and a cap hit is
                          a bug rather than a routine event. False for Orpheus,
                          which needs the boost/floor and a re-render ladder.
    resplit_on_cap        True when hitting the cap must be answered by
                          re-rendering the chunk split at sentence boundaries
                          (Orpheus's ladder) rather than shipping what came out.
    max_chars_per_sec     the truncation guard's threshold - text characters per
                          second of audio, above which the audio is too short
                          for the text. 0 disables the guard.
    coverage_check        None, or the name of the check the render layer must
                          run to prove the chunk SAID ALL THE TEXT. 'asr' for
                          Higgs, and it is not optional politeness: a v3 chunk
                          measured a duration ratio of 0.99 while dropping 22 %
                          of its text and inserting filler, so DURATION IS NOT A
                          COVERAGE PROXY on that family. Orpheus is None (its
                          own chars/sec guard and resplit ladder cover it). A
                          HOOK ONLY - nothing implements the ASR check yet, and
                          the field exists so the gate has a name to switch on
                          when it does.
    """
    max_new_tokens: int
    eos_reliable: bool
    resplit_on_cap: bool
    max_chars_per_sec: float
    levers: Mapping[str, float] = field(default_factory=dict)
    coverage_check: Optional[str] = None


# ---------------------------------------------------------------------------
# Backends: in-process, or a server this process owns
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BackendSpec:
    """WHERE the weights run.

    Two kinds, and the difference is a lifecycle, not a detail:

    'inprocess'  the model object lives in this Python process - vLLM 0.7.3
                 (Orpheus on CUDA), MLX (Orpheus on the Mac), transformers
                 (Orpheus fallback, and Higgs v2). Loading is an import plus a
                 `from_pretrained`; there is nothing to shut down but a
                 reference.
    'served'     the model runs in a SEPARATE server process reached over HTTP -
                 Higgs v3 under vllm-omni 0.28, which is not importable at all
                 (`higgs_multimodal_qwen3` has no HF modeling class) and whose
                 dependency set (torch 2.13+cu130) cannot coexist with vLLM
                 0.7.3 in one env. Something must LAUNCH it, wait for health,
                 and kill it - see ServedBackend.

    `base_url` is meaningful only for 'served'.
    """
    kind: str
    name: str
    version: Optional[str] = None
    base_url: Optional[str] = None
    notes: str = ''

    KINDS = ('inprocess', 'served')

    def __post_init__(self):
        if self.kind not in self.KINDS:
            raise ValueError(
                f"BackendSpec kind {self.kind!r} is not one of {self.KINDS}")
        if self.kind == 'served' and not (self.base_url or '').strip():
            raise ValueError(
                f"BackendSpec(kind='served', name={self.name!r}) needs a base_url - "
                'a served backend that does not say where the server is cannot be '
                'health-checked or stopped.')
        if self.kind == 'inprocess' and self.base_url:
            raise ValueError(
                f"BackendSpec(kind='inprocess', name={self.name!r}) carries a "
                f'base_url ({self.base_url!r}); an in-process backend has no URL.')


@dataclass(frozen=True)
class SpeechRequest:
    """One chunk, addressed to a ServedBackend.

    `sampling` is a plain mapping and each client decides where it goes on the
    wire. It is NOT cosmetic which: vllm-omni 0.28's /v1/audio/speech SILENTLY
    DROPS top-level `temperature` / `top_p` / `top_k` and honours them only
    inside `extra_params`, so a client that puts them top-level renders at the
    server defaults while reporting the values it thought it sent. An EMPTY
    mapping means "the server's own defaults" (Higgs v3: temperature 1.0,
    top_p 0.95, top_k 50), which is what Owen asked the delivered v3 render to
    use.
    """
    text: str
    voice: VoiceRef
    max_new_tokens: int
    seed: Optional[int] = None
    sampling: Mapping[str, Any] = field(default_factory=dict)


@runtime_checkable
class ServedBackend(Protocol):
    """A model server this process OWNS: it starts it, waits for it, uses it,
    and stops it.

    The lifecycle is explicit because a served backend costs real things an
    in-process one does not - Higgs v3 under vllm-omni takes ~55 s from launch
    to health and preallocates ~24 GB of VRAM unless
    --gpu-memory-utilization is lowered - so "is it up?" and "let go of the GPU"
    are operations a caller has to be able to name.

    start()             launch the server process (idempotent: a second call on
                        a running server is a no-op, never a second process).
    wait_ready(timeout) block until the health endpoint answers; True if it came
                        up inside `timeout` seconds, False if it did not. It
                        does NOT raise on timeout - the caller decides whether a
                        slow start is fatal - but it MUST raise if the process
                        died, naming the exit status.
    speak(request)      one chunk in, `(audio, sample_rate)` out; audio is 1-D
                        float32 mono. Raises on any non-200, carrying the
                        server's own message.
    stop()              terminate the server and release the GPU. Idempotent.
    """

    spec: BackendSpec

    def start(self) -> None: ...

    def wait_ready(self, timeout: float) -> bool: ...

    def speak(self, request: SpeechRequest): ...

    def stop(self) -> None: ...


# ---------------------------------------------------------------------------
# Codec
# ---------------------------------------------------------------------------


@runtime_checkable
class Codec(Protocol):
    """Tokens -> waveform, plus every number that conversion implies.

    SNAC (Orpheus)   tokens_per_frame 7, samples_per_frame 2048, 24 kHz =>
                     11.719 frames/s; trim_frames 0 - n frames decode to
                     exactly n * 2048 samples (mlx_audio's SNAC returns
                     n * 2048 + 75 and the MLX backend cuts the 75-sample tail;
                     torch SNAC is exact).
    Higgs v2/v3      tokens_per_frame 8 (one entry per codebook), 25 frames/s,
                     24 kHz => samples_per_frame 960; trim_frames 7, because
                     reverting the delay pattern takes diagonal slices and
                     yields frames - (num_codebooks - 1) frames.

    TWO TRIMS, NOT ONE (Higgs; measured 2026-09-04). `trim_frames` is the fixed
    delay-pattern diagonal. It is NOT enough on its own: the stream's BOC/EOC
    SENTINELS (1024/1025) map to codec code 0, which DECODES TO SOUND, and the
    delay pattern smears that run across seven frames - heard as a stray
    syllable after every chunk. The sentinel run must be trimmed BY CONTENT
    (drop the trailing frames whose codes are all sentinel/0, however many there
    turn out to be), never by a fixed count. vllm-omni ships exactly this as
    `_filter_real_code_frames()` and never calls it.

    What content-trimming leaves is a chunk edge around -30 dB, which still
    clicks on a join; the ENGINE declares `edge_fade` and the assembler applies
    it (Higgs `EdgeFade(10, 25)` takes the edges to -45..-48 dB - asymmetric,
    because a chunk ends on a decay the ear does not expect). Orpheus declares
    `EdgeFade(0, 0)` - it bakes its own padded, trimmed edges.
    """

    #: Output sample rate in Hz. Mono, float32, always.
    sample_rate: int
    #: LM frames per second of audio (SNAC 24000/2048; Higgs 25.0).
    frames_per_second: float
    #: Token entries the model emits per frame (SNAC 7; Higgs 8 codebooks).
    tokens_per_frame: int
    #: Waveform samples one frame decodes to (SNAC 2048; Higgs 960).
    samples_per_frame: int
    #: Frames consumed by the codec's own framing and NOT audible - the delay
    #: pattern's diagonal (Higgs 7). 0 when there is no such convention (SNAC).
    trim_frames: int

    def frames_for_tokens(self, n_tokens: int) -> int:
        """Whole frames `n_tokens` emitted entries make up (a partial frame at
        the end is not a frame)."""

    def audio_frames(self, generated_frames: int) -> int:
        """Frames of AUDIO left after the codec's own framing is removed from
        `generated_frames` LM steps: SNAC the identity (trim_frames 0), Higgs
        `generated_frames - 7` (the delay pattern's diagonal). Never negative -
        a generation shorter than the diagonal carries no audio at all."""

    def samples_for_frames(self, n_frames: int) -> int:
        """The EXACT sample count decoding `n_frames` of AUDIO frames must
        produce (pass `audio_frames(...)`, not the raw generated count). A
        decode that returns anything else is a bug, not a rounding
        difference."""

    def decode(self, tokens) -> Any:
        """`tokens` -> a 1-D float32 mono numpy array at `sample_rate`."""

    def streaming_decoder(self, decode_frames: Callable, label: str = ''):
        """A windowed emitter for fast start, or None when this codec cannot be
        decoded incrementally without seams.

        SNAC returns `narrator.engine.orpheus.snac.WindowedFrameEmitter`.
        Returning None is a STATEMENT - "this codec has no sound windowed
        decode" - and the caller must fall back to whole-row emission, never to
        faking a stream out of independent decodes.
        """


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


@runtime_checkable
class Budget(Protocol):
    """How much one chunk may carry, per voice. The chunk packer asks THIS.

    Every method takes `voice` because tuning is keyed on (engine, voice), not
    on voice alone and never on a module constant: deathstalker reads ~23.5 ch/s
    where the Orpheus default guard is 19.0, and a per-voice model has its own
    packed-chunk size in the catalog.
    """

    def max_chars(self, voice=None) -> int:
        """The largest chunk, in characters of text, the packer may build."""

    def max_chars_per_sec(self, voice=None) -> float:
        """Characters of text per second of audio above which the audio is too
        short for the text (0 = no guard)."""

    def max_total_tokens(self, prompt_tokens: int, voice=None) -> int:
        """The largest TOTAL sequence - prompt plus generated - one chunk may
        run to.

        The generation budget is therefore `max_total_tokens(p) - p`. Orpheus's
        audio-token cap is independent of the prompt (3,700 audio tokens
        whatever the prompt costs), so its answer GROWS with the prompt; Higgs's
        8,192-token context is a hard ceiling the prompt eats into, so its
        answer is constant and it refuses a prompt that already fills the
        window. Llasa's 2,048-token wall is what proved both shapes have to be
        expressible here.
        """


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


@runtime_checkable
class Engine(Protocol):
    """One loaded TTS model, ready to render chunks.

    Everything above this line in narrator - the manifest, the session layout,
    the VTT, assembly - is engine-independent; `sampleRate` has been a manifest
    field from the start for exactly this reason.
    """

    #: Registry id ('orpheus', 'higgs-v3'). Matches narrator.engine.registry.
    ENGINE_ID: str
    #: Output sample rate (== codec().sample_rate; kept as an attribute because
    #: the render worker and the manifest read it before any decode).
    SAMPLE_RATE: int
    #: True when the engine BAKES the inter-chunk silence into each chunk's
    #: audio (Orpheus: _classify_gap's lead/trail written by _save_audio), False
    #: when it emits bare speech and the ASSEMBLER must realize the gaps from
    #: the manifest's gapBefore/gapAfter (Higgs: measured, no pads or fades at
    #: either end). The SentenceSink reads this to decide whether to write the
    #: silence itself.
    pads: bool
    #: The fade the ASSEMBLER must apply at each chunk edge before joining, as
    #: an `EdgeFade(in_ms, out_ms)`. Orpheus 0/0 (it trims and pads its own
    #: edges). Higgs 10/25: after the codec's sentinel run is content-trimmed
    #: the edge still sits near -30 dB and clicks on a join, and the fade takes
    #: it to -45..-48 dB. Travels with the engine, not with the assembler,
    #: because it is a property of the codec's edges - and it must agree with
    #: `narrator.assemble.engine_profiles.PROFILES`, which is assembly's copy.
    edge_fade: EdgeFade
    #: 'vllm' | 'mlx' | 'transformers' | ... - which runtime is serving.
    backend: str
    #: The voice this engine renders by default.
    voice: str

    def resolve_load_voice(self, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """Validate a load request's voice AS THIS ENGINE understands one, and
        return the normalized name. Raise, with a message a user can act on, for
        anything this engine cannot serve.

        A CLASSMETHOD in every implementation: it runs BEFORE the engine exists,
        because it is what decides whether to build one.

        This is on the protocol because "what is a voice" is the single biggest
        thing that differs between engines and the one place a wrong answer is
        invisible. Orpheus's is a token - eight stock ones, or anything verbatim
        when a modelDir/adapterDir names weights. Higgs's is a key in a voice
        document. A worker that checked Higgs loads against Orpheus's allowlist
        rejected every real Higgs voice by name ("Unknown Orpheus voice
        'deathstalker'"), which is exactly how this member came to exist.
        """

    def backend_spec(self) -> BackendSpec:
        """Where this engine's weights run - in this process, or in a server it
        owns. `backend` is the name; this is the whole answer."""

    def codec(self) -> Codec:
        """This engine's codec (constant for the life of the engine)."""

    def budget(self) -> Budget:
        """This engine's chunk budget."""

    def stop_policy(self, voice=None) -> StopPolicy:
        """Resolved stop settings for `voice` (default: this engine's voice)."""

    def convert(self, sentence_number: int, sentence: str) -> bool:
        """Render one chunk to the session's sentences dir. True on success."""

    def convert_batch(self, items: Sequence[Tuple[int, str]]) -> Sequence[bool]:
        """Render many chunks. One bool per item, in order."""

    def generate_batch_stream(self, texts: Sequence[str], voices, stream_rows,
                              on_chunk, on_row, should_stop=None) -> None:
        """In-memory batch render with per-row streaming.

        `on_chunk(row, seq, pcm)` fires for rows named in `stream_rows` as their
        audio becomes available; `on_row(row, pcm)` fires EXACTLY ONCE per row
        that completes. A row abandoned because `should_stop()` went true gets
        NO on_row - a caller must never be able to mistake an abandoned row for
        a finished one.
        """

    def cleanup(self) -> None:
        """Release the model. Idempotent."""


__all__ = [
    'BackendSpec',
    'DefaultVoice',
    'EdgeFade',
    'MAX_CHARS_SOURCES',
    'Budget',
    'ClipsVoice',
    'Codec',
    'DescriptionVoice',
    'Engine',
    'ReferenceClip',
    'ServedBackend',
    'SpeechRequest',
    'StopPolicy',
    'TokenVoice',
    'VoiceRef',
]
