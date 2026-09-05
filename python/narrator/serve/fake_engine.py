"""A model-free stand-in for OrpheusEngine, so the WIRE PROTOCOL can be tested.

NOT a fallback and not a second implementation of the engine. It exists for one
reason: electron/orpheus-worker-pool.ts parses a JSON-lines protocol whose exact
message sequence and field set are a contract, and until now the only way to
exercise that contract was to load a 6 GB model on a GPU. This class produces
deterministic sine-wave audio whose length is a function of the text, which is
enough to drive serve/worker.py's real reader thread, real stdout lock, real
per-item bookkeeping and real one-answer-per-row guarantees.

It is reachable ONLY through the explicit `--fake-engine` argv flag (see
serve.worker._engine_class / main). Deliberately NOT an environment variable: both
spawn arms hand the worker the parent environment, so an env switch is something a
leaked variable could turn on by accident - and the failure it produces is a whole
book rendered as sine tones and reported as success. An argv flag has to be typed
by whoever wrote the command line, and the worker prints a loud stderr banner at
startup and at every 'ready'/'loaded' while it is on.

It reports `backend = 'transformers'`, which is the worker path with the fewest
vLLM-shaped objects in it: `generate_batch` takes the single-dispatch loop ->
_generate_audio_batch -> the sequential transformers branch -> _generate_audio,
which needs exactly two engine methods (_generate_tokens_transformers,
_tokens_to_audio). The fast-start path is exercised through `generate_batch_stream`,
which the fake implements directly by emitting the same windowed cadence
WindowedFrameEmitter would (4 frames per payload after the first 6).

The text cleaning is the REAL one (narrator.engine.orpheus.prompt.PromptMixin),
so the SML-stripping contract is not faked.

THERE IS ONE FAKE PER ENGINE. `fake_engine_class(engine_id)` mirrors
narrator.engine.registry, so `--fake-engine` with NARRATOR_ENGINE=higgs-v3 gets
FakeHiggsEngine - 960-sample frames, `pads = False`, whole-row streaming - and a
protocol test can prove the worker built the engine the environment asked for.
"""
import time

import numpy as np

from ..engine.orpheus.prompt import PromptMixin
from ..engine.protocol import EdgeFade
from ..engine.orpheus.snac import PAYLOAD_FRAMES, SAMPLES_PER_FRAME

SAMPLE_RATE = 24000

# Frames of audio the fake produces per character of text. 2048 samples per frame
# at 24 kHz is ~85 ms, so 0.16 frames/char is ~13.6 ms/char == ~73 chars/second of
# audio... deliberately FAST, so a protocol test renders a paragraph in
# milliseconds. Nothing downstream measures rate: the worker's only length-derived
# outputs are `duration` fields, which the tests compute the same way.
FRAMES_PER_CHAR = 0.16
MIN_FRAMES = 6          # enough for exactly one streamed payload plus its context

# Wall-clock a streamed row costs, so a 'cancel' written to stdin right after a
# generate_batch has somewhere to LAND. Without it the whole batch retires
# faster than the pipe round-trip and the cancel path is untestable - the fake
# would prove only that a batch nobody interrupted completes. 80 ms is far under
# any timeout in the protocol and only the streaming path pays it (the classic
# path has no should_stop to honour, exactly as on vLLM).
STREAM_ROW_SECONDS = 0.08


class FakeEngineConfig:
    """The subset of EngineConfig the worker passes. Kept as its own class so the
    fake never imports the real one (and so a missing field is a TypeError here
    rather than a silent None in the engine)."""

    def __init__(self, voice=None, model_dir=None, base_dir=None, adapter_dir=None,
                 caps=None, **extra):
        self.voice = voice
        self.model_dir = model_dir
        self.base_dir = base_dir
        self.adapter_dir = adapter_dir
        self.caps = caps or {}
        self.extra = extra


class FakeEngine(PromptMixin):
    """Deterministic audio, real text handling, no model. Orpheus-shaped."""

    ENGINE_ID = 'orpheus'
    END_OF_AUDIO_TOKEN = 128258
    SAMPLE_RATE = SAMPLE_RATE
    # Orpheus bakes its gaps into each chunk and needs no assembler-side fade.
    pads = True
    edge_fade = EdgeFade(0.0, 0.0)
    VALID_VOICES = {'tara', 'leah', 'jess', 'leo', 'dan', 'mia', 'zac', 'zoe'}
    DEFAULT_VOICE = 'leah'

    # Mirrors OrpheusEngine's class-level caps registry so the worker's
    # _apply_voice_caps sees the same shape.
    _voice_caps = {}

    def __init__(self, config: FakeEngineConfig):
        self.config = config
        self.backend = 'transformers'
        self.voice = (config.voice or 'leah').strip().lower()
        self.adapter_dir = config.adapter_dir
        self.base_dir = config.base_dir
        self.custom_model_dir = config.model_dir
        self.engine = object()   # truthy: the worker only tests it for None
        self.tokenizer = None
        self.mlx_model = None
        # UNCONDITIONAL with `or {}`, mirroring OrpheusEngine.__init__: an empty
        # payload is the RESET that drops a previous load's catalog tuning off a
        # class-level registry which outlives the engine. See that call site.
        self.register_voice_caps(self.voice, config.caps or {})

    # ---- lifecycle ----------------------------------------------------------

    @classmethod
    def detect_backend(cls) -> str:
        return 'transformers'

    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """Orpheus's rule, which is what the protocol tests assert against."""
        from ..engine.orpheus.interface import OrpheusInterfaceMixin
        return OrpheusInterfaceMixin.resolve_load_voice.__func__(
            cls, voice, model_dir=model_dir, adapter_dir=adapter_dir,
            base_dir=base_dir)

    def cleanup(self):
        self.engine = None

    def set_voice(self, voice: str, adapter_dir: str = None) -> None:
        if not voice:
            raise ValueError('FakeEngine.set_voice() requires a voice token')
        self.adapter_dir = adapter_dir
        self.voice = voice

    @classmethod
    def register_voice_caps(cls, voice: str, caps: dict) -> dict:
        """The real registry's shape and its refusal of unknown keys, so a test can
        prove the caps payload crosses the wire intact."""
        from ..engine.orpheus.caps import CapsMixin
        if not voice:
            raise ValueError('FakeEngine.register_voice_caps() requires a voice token')
        stored = {}
        for key, value in (caps or {}).items():
            if key in CapsMixin.VOICE_CAP_IGNORED:
                continue
            if key not in CapsMixin.VOICE_CAP_SOURCES:
                raise ValueError(
                    f"FakeEngine.register_voice_caps({voice!r}): unknown cap '{key}'")
            if value is None:
                continue
            stored[key] = float(value)
        cls._voice_caps[voice] = stored
        return stored

    # ---- audio --------------------------------------------------------------

    @staticmethod
    def frames_for(text: str) -> int:
        """How many SNAC-sized frames this text renders to. Pure function of the
        text, so a test can predict every duration on the wire."""
        return max(MIN_FRAMES, int(len(text) * FRAMES_PER_CHAR))

    @classmethod
    def audio_for(cls, text: str) -> np.ndarray:
        """A 220 Hz sine of frames_for(text) frames, at 0.5 amplitude.

        0.5 (not 1.0) keeps it under finalize_audio's peak-normalize branch, and a
        continuous tone keeps every sample above finalize_audio's 0.01 silence
        threshold - so the worker's trim is a no-op and the duration on the wire is
        exactly frames * 2048 + the inter-sentence gap."""
        n = cls.frames_for(text) * SAMPLES_PER_FRAME
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        return (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)

    def _generate_tokens_transformers(self, prompt: str) -> list:
        """`prompt` arrives as "voice: text" (the worker joins it), so the text half
        is what sizes the clip - the same quantity the real engine's token count
        would be proportional to."""
        text = prompt.split(': ', 1)[-1]
        return list(range(self.frames_for(text) * 7))

    def _tokens_to_audio(self, tokens: list) -> np.ndarray:
        n = (len(tokens) // 7) * SAMPLES_PER_FRAME
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        return (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)

    def _guard_truncation(self, sentence_index, clean, audio_np, resplit, voice=None):
        """The fake never truncates, so the guard is the identity - which is also
        what the real guard does for every healthy clip."""
        return audio_np

    # ---- fast start ---------------------------------------------------------

    def generate_batch_stream(self, texts, voices, stream_rows, on_chunk, on_row,
                              should_stop=None) -> None:
        """The real method's CONTRACT, with fake audio: same argument validation,
        same one-on_row-per-row guarantee, same payload cadence.

        A streamed row is emitted as PAYLOAD_FRAMES-sized chunks with seq counting
        from 0, then a final short tail if the row does not divide evenly - exactly
        what WindowedFrameEmitter produces. A stop abandons every row that has not
        been delivered, WITHOUT an on_row, which is the contract the worker's
        cancelled-sweep depends on.
        """
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'FakeEngine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'FakeEngine.generate_batch_stream: stream_rows names row(s) {stray} '
                f'outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'FakeEngine.generate_batch_stream: stream_rows is non-empty but no '
                'on_chunk was given')
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'FakeEngine.generate_batch_stream: row(s) {blank} have no text after '
                'cleaning.')

        for i, text in enumerate(texts):
            if should_stop is not None and should_stop():
                # Abandoned: no on_row for this row or any after it. That is the
                # real engine's contract too - a caller must never be able to
                # mistake an abandoned row for a finished one - and it is what
                # leaves the worker's `finally` sweep the rows to label
                # 'cancelled'.
                return
            time.sleep(STREAM_ROW_SECONDS)
            audio = self.audio_for(text)
            if i not in stream_rows:
                on_row(i, audio)
                continue
            frames = len(audio) // SAMPLES_PER_FRAME
            seq = 0
            emitted = 0
            while frames - emitted >= PAYLOAD_FRAMES:
                lo = emitted * SAMPLES_PER_FRAME
                hi = (emitted + PAYLOAD_FRAMES) * SAMPLES_PER_FRAME
                on_chunk(i, seq, audio[lo:hi].copy())
                seq += 1
                emitted += PAYLOAD_FRAMES
            if emitted < frames:
                on_chunk(i, seq, audio[emitted * SAMPLES_PER_FRAME:
                                       frames * SAMPLES_PER_FRAME].copy())
            on_row(i, audio)


# ---------------------------------------------------------------------------
# The Higgs variant
# ---------------------------------------------------------------------------

# Higgs geometry (narrator/engine/higgs/codec.py): 25 frames/s at 24 kHz is 960
# samples per frame, against SNAC's 2048. Same sample rate, different framing -
# which is exactly what a protocol test should be able to tell apart.
HIGGS_SAMPLES_PER_FRAME = 960
HIGGS_FRAMES_PER_CHAR = 0.34      # ~13.6 ms/char, matching FakeEngine's pace


class FakeHiggsEngineConfig(FakeEngineConfig):
    """Same stand-in shape; kept as its own class so a Higgs protocol test can
    assert which engine the worker built."""


class FakeHiggsEngine(FakeEngine):
    """The Higgs contract, with fake audio.

    Two things differ from the Orpheus fake, and they are the two things the
    ASSEMBLER has to know about a Higgs render:

      pads = False        Higgs emits bare speech - no silence, no fade at
                          either end - so the manifest's gapBefore/gapAfter are
                          live and the assembler realizes them.
      edge_fade 10/25     the assembler fades each chunk edge (-30 dB -> about
                          -46 dB) before joining, asymmetrically.

    It also streams the way the real HiggsEngine does: ONE whole-row chunk at
    retirement, because a delay-pattern codec has no sound windowed decode (see
    HiggsCodec.streaming_decoder). A fake that emitted SNAC's 4-frame cadence
    would be testing a cadence no Higgs render can produce.
    """

    # The fake that BOTH Higgs ids share. It is named for what it fakes - Higgs
    # geometry - not for one id, because a fake claiming to be 'higgs-v3' while
    # serving a `higgs-v2-scaffold` spawn is exactly the mislabelling the
    # registry ids exist to prevent. `ENGINE_ID` is set per instance from the id
    # that selected it (see fake_engine_class).
    ENGINE_ID = 'higgs'
    pads = False
    edge_fade = EdgeFade(10.0, 25.0)

    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """A Higgs voice is a NAME, not one of Orpheus's eight tokens.

        The fake does not read the voice document (it has no clips to load), but
        it refuses the two fields Higgs has no meaning for, so a protocol test
        sees the same refusals the real engine gives.
        """
        if model_dir:
            raise ValueError(
                f'Higgs load carried modelDir={model_dir!r}. The served model is '
                "the launch script's argument, not a per-load field.")
        if base_dir:
            raise ValueError(
                f'Higgs load carried baseDir={base_dir!r}. Higgs has no '
                'shared-base + per-voice-adapter split.')
        name = (voice or '').strip()
        if not name:
            raise ValueError(
                'Higgs load has no voice name. The name selects an entry in the '
                'NARRATOR_HIGGS_VOICES document; there is no default.')
        return name

    @staticmethod
    def frames_for(text: str) -> int:
        return max(MIN_FRAMES, int(len(text) * HIGGS_FRAMES_PER_CHAR))

    @classmethod
    def audio_for(cls, text: str) -> np.ndarray:
        n = cls.frames_for(text) * HIGGS_SAMPLES_PER_FRAME
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        return (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)

    def _tokens_to_audio(self, tokens: list) -> np.ndarray:
        """8 codebook entries per frame, against SNAC's 7."""
        n = (len(tokens) // 8) * HIGGS_SAMPLES_PER_FRAME
        t = np.arange(n, dtype=np.float32) / SAMPLE_RATE
        return (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)

    def _generate_tokens_transformers(self, prompt: str) -> list:
        text = prompt.split(': ', 1)[-1]
        return list(range(self.frames_for(text) * 8))

    def render_audio(self, text: str, seed=None, index: int = 0,
                     should_stop=None) -> np.ndarray:
        """ONE chunk in, one waveform out - the per-chunk entry point EVERY real
        Higgs engine has (`HiggsEngine`, `HiggsV3Engine`, `HiggsV3MlxEngine`)
        and the one the worker actually calls for a non-Orpheus engine.

        Before the worker keyed its render arms on ENGINE_ID rather than on the
        backend NAME, this fake was driven through
        `_generate_tokens_transformers` + `_tokens_to_audio` - Orpheus's
        transformers arm - because it reports `backend = 'transformers'`. It
        therefore tested a code path no Higgs engine has ever used. Those two
        methods stay (the v2 scaffold really does run on transformers, and the
        geometry they encode is still 8 entries per frame), but this is the
        method under test now.
        """
        if not (text or '').strip():
            raise ValueError('FakeHiggsEngine.render_audio(): the chunk has no text')
        return self.audio_for(text)

    def generate_batch_stream(self, texts, voices, stream_rows, on_chunk, on_row,
                              should_stop=None) -> None:
        """Whole rows, at retirement - the real Higgs cadence."""
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'FakeHiggsEngine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'FakeHiggsEngine.generate_batch_stream: stream_rows names row(s) '
                f'{stray} outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'FakeHiggsEngine.generate_batch_stream: stream_rows is non-empty but '
                'no on_chunk was given')
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'FakeHiggsEngine.generate_batch_stream: row(s) {blank} have no text '
                'after cleaning.')

        for i, text in enumerate(texts):
            if should_stop is not None and should_stop():
                return
            time.sleep(STREAM_ROW_SECONDS)
            audio = self.audio_for(text)
            if i in stream_rows:
                on_chunk(i, 0, audio.copy())
            on_row(i, audio)


# engine id -> (fake engine class, fake config class). Mirrors
# narrator.engine.registry, so `--fake-engine` exercises the same selection the
# real spawn makes.
FAKE_ENGINES = {
    'orpheus': (FakeEngine, FakeEngineConfig),
    # Both Higgs ids share one fake: what a protocol test can see of them is the
    # same - 24 kHz, 960-sample frames, pads = False, whole-row streaming - and
    # the difference between them (in-process transformers vs a vllm-omni
    # server) is below the wire, not on it. The v3 SERVER is faked separately,
    # by an HTTP server in tests/test_higgs_v3.py, which is the only way to
    # exercise the real client.
    'higgs-v3': (FakeHiggsEngine, FakeHiggsEngineConfig),
    'higgs-v2-scaffold': (FakeHiggsEngine, FakeHiggsEngineConfig),
}


def _fake_entry(engine_id: str):
    if engine_id not in FAKE_ENGINES:
        raise ValueError(
            f"--fake-engine has no stand-in for engine '{engine_id}'. Known: "
            f"{', '.join(sorted(FAKE_ENGINES))}.")
    return FAKE_ENGINES[engine_id]


def fake_engine_class(engine_id: str):
    """The fake for `engine_id`, STAMPED with that id.

    A subclass per call rather than a shared class: `ENGINE_ID` is read back off
    the engine in log lines and refusals, and a fake that reports the wrong id
    would make a `higgs-v2-scaffold` spawn look like a `higgs-v3` one in exactly
    the place a reader is trying to tell them apart.
    """
    base = _fake_entry(engine_id)[0]
    if base.ENGINE_ID == engine_id:
        return base
    return type(base.__name__, (base,), {'ENGINE_ID': engine_id})


def fake_engine_config(engine_id: str, **kwargs):
    return _fake_entry(engine_id)[1](**kwargs)
