"""HiggsEngine - Higgs Audio 2 as a narrator `Engine`.

Registry id `higgs-v2`. Backbone Llama-3.2-3B + a DualFFN audio adapter,
transformers class `HiggsAudioV2ForConditionalGeneration`, 24 kHz mono, 8
codebooks at 25 frames/s with a delay pattern. Ported from the measured harness
`E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\render_v2.py`
(2026-09-04).

WHAT IS DIFFERENT FROM ORPHEUS, AND WHY EACH DIFFERENCE IS HERE

  pads = False        Higgs emits BARE SPEECH: no silence, no fade, no trim at
                      either end (measured). Orpheus bakes its gaps into every
                      chunk FLAC. So the manifest's gapBefore/gapAfter become
                      LIVE for this engine and the assembler realizes them.
  edge_fade_ms = 10   even after the codec's sentinel trim the edges sit near
                      -30 dB; the assembler's fade takes them to -45..-48 dB.
  no EOS levers       EOS fired 9/9 across 132-898 char chunks with no boost, no
                      floor and no stop-string hack, and the cap was never
                      reached. There is no ratchet, no truncation ladder and no
                      short-chunk backstop, because there is nothing here for
                      them to catch. `StopPolicy.coverage_check` is 'asr'
                      instead: duration is not a coverage proxy on this family.
  voice = clips       a ClipsVoice, placed in the chat history. No adapter
                      registry, no voice token, no per-request LoRA.
  serial batches      `convert_batch` renders one chunk at a time. transformers
                      `generate` over a dual text/audio stream has no continuous
                      batching, and the audition measured RTF 1.12 single-stream
                      - real batching is a vLLM-Omni/SGLang concern and belongs
                      with a `served` backend, not here. Documented rather than
                      faked.
  no streaming        `generate_batch_stream` emits WHOLE ROWS at retirement.
                      See HiggsCodec.streaming_decoder for the measured reason a
                      windowed decode is not sound for a delay-pattern codec;
                      pretending otherwise would ship audio the listener has
                      already heard before anything could notice it was wrong.
"""
import os

import numpy as np

from ..protocol import BackendSpec, ClipsVoice, StopPolicy
from .codec import HiggsCodec
from .config import (HiggsBudget, HiggsConfig, HiggsDefaults, higgs_stop_policy)
from .prompt import (DEFAULT_SCENE, DEFAULT_SYSTEM_PROMPT,
                     build_conversation, clean_text)
from .transformers_backend import HiggsTransformersBackend


class HiggsEngine:
    """One loaded Higgs v2 model."""

    ENGINE_ID = HiggsDefaults.ENGINE_ID
    SAMPLE_RATE = HiggsDefaults.SAMPLE_RATE
    # Higgs supplies NO silence of its own - see the module docstring.
    pads = False
    edge_fade_ms = HiggsDefaults.EDGE_FADE_MS
    # The audiobook worker's batch protocol (mirrors OrpheusEngine's surface).
    SUPPORTS_BATCH = True
    BATCH_SIZE = 1

    def __init__(self, config: HiggsConfig):
        if not isinstance(config, HiggsConfig):
            raise ValueError(
                'HiggsEngine(config) takes a narrator.engine.higgs.HiggsConfig; got '
                f'{type(config).__name__}.')
        self.config = config
        self.backend = 'transformers'
        self.voice_ref: ClipsVoice = config.voice
        # NOT `or 'higgs'`: a voice with no name is a voice nobody can ask for
        # by name later, and HiggsConfig refuses one at construction.
        self.voice = config.voice.name
        self._backend = HiggsTransformersBackend(config)
        self._codec = None
        self._budget = HiggsBudget(config)
        self.params = {'samplerate': self.SAMPLE_RATE}
        self.load_engine()

    # ---- lifecycle ----------------------------------------------------------

    def load_engine(self):
        self._backend.load()
        self._codec = HiggsCodec(self._backend.audio_decoder())
        return self._backend.model

    def cleanup(self):
        """Release the model. Idempotent."""
        self._backend.unload()
        self._codec = None

    @classmethod
    def resolve_load_voice(cls, voice, model_dir=None, adapter_dir=None,
                           base_dir=None) -> str:
        """A Higgs voice is a NAME in the NARRATOR_HIGGS_VOICES document, never
        one of Orpheus's eight stock tokens. Present for completeness: this
        engine is scaffolding and `narrator.serve` refuses to run it at all
        (serve/worker.py UNSERVABLE_ENGINES)."""
        if base_dir:
            raise ValueError(
                f'Higgs load carried baseDir={base_dir!r}. Higgs has no shared-base '
                '+ per-voice-adapter split.')
        name = (voice or '').strip()
        if not name:
            raise ValueError(
                'Higgs load has no voice name. The name selects an entry in the '
                'NARRATOR_HIGGS_VOICES document; there is no default.')
        return name

    @classmethod
    def detect_backend(cls) -> str:
        """Higgs v2 has exactly one runtime: transformers, in this process.
        (v3 is a SERVED backend and is a different engine id - see
        narrator/engine/higgs/v3_served.py.)"""
        return 'transformers'

    def backend_spec(self) -> BackendSpec:
        return BackendSpec(kind='inprocess', name='transformers',
                           version=HiggsDefaults.MODEL_ID)

    # ---- the seam -----------------------------------------------------------

    def codec(self) -> HiggsCodec:
        if self._codec is None:
            raise RuntimeError(
                'HiggsEngine.codec() after cleanup(): the audio decoder went with the '
                'model.')
        return self._codec

    def budget(self) -> HiggsBudget:
        return self._budget

    def stop_policy(self, voice=None) -> StopPolicy:
        """Higgs has ONE voice per engine (the clips it was built with), so a
        `voice` naming anything else is a caller error, not a lookup."""
        if voice is not None and voice != self.voice:
            raise ValueError(
                f"HiggsEngine.stop_policy({voice!r}): this engine serves "
                f"'{self.voice}'. Higgs's voice is its reference clips, which are "
                'part of the prompt - a second voice is a second engine.')
        return higgs_stop_policy(self.config)

    # ---- rendering ----------------------------------------------------------

    def _clean_sentence_for_tts(self, sentence: str) -> str:
        """The SML strip, shared by every engine. The serve worker calls this on
        the engine before it renders, so it is part of the surface."""
        return clean_text(sentence)

    def _conversation(self, text: str):
        return build_conversation(
            text, self.voice_ref,
            system_prompt=(DEFAULT_SYSTEM_PROMPT if self.config.system_prompt is None
                           else self.config.system_prompt),
            scene=self.config.scene if self.config.scene is not None else DEFAULT_SCENE)

    def _seed_for(self, index: int):
        """render_v2.py seeded chunk i with `1234 + i`, so a re-render of the
        same chunk reproduces it and two chunks of the same batch do not share
        a draw. `HiggsConfig.seed = None` means "do not seed at all"."""
        if self.config.seed is None:
            return None
        return int(self.config.seed) + int(index)

    def render_audio(self, text: str, seed=None) -> np.ndarray:
        """One chunk of text -> a float32 mono waveform at 24 kHz.

        The whole path, in one place: chat history -> generate (capped in
        FRAMES) -> the codec's six-step decode. Raises on anything it cannot
        honestly answer; never returns silence.
        """
        clean = (text or '').strip()
        if not clean:
            raise ValueError('HiggsEngine.render_audio(): the chunk has no text')
        conversation = self._conversation(clean)
        cap = self._budget.cap_frames(clean)
        tokens = self._backend.generate(conversation, max_new_tokens=cap,
                                        seed=self._seed_for(0) if seed is None else seed)
        return self.codec().decode(tokens)

    def _sentence_file(self, sentence_number: int) -> str:
        if not self.config.sentences_dir:
            raise ValueError(
                'HiggsEngine.convert() needs a sentences_dir: this engine was built '
                'for in-memory generation (HiggsConfig.sentences_dir is None), so '
                'there is nowhere to write chunk '
                f'{sentence_number}. Use generate_batch_stream / render_audio.')
        return os.path.join(self.config.sentences_dir,
                            f'{sentence_number}.{self.config.audio_format}')

    def convert(self, sentence_number: int, sentence: str) -> bool:
        """Render one chunk to `<sentences_dir>/<n>.<audio_format>`.

        NO PADS AND NO GAPS ARE WRITTEN. Orpheus's `_save_audio` bakes
        `_classify_gap`'s lead and trail silence into the file; Higgs's chunk
        file is exactly the speech, and the assembler realizes the manifest's
        gapBefore/gapAfter around it. That is what `pads = False` MEANS, and it
        is the one behavioural difference an assembly has to honour.
        """
        import soundfile as sf
        path = self._sentence_file(sentence_number)
        audio = self.render_audio(sentence, seed=self._seed_for(sentence_number))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        sf.write(path, audio, self.SAMPLE_RATE)
        return True

    def convert_batch(self, items) -> list:
        """SERIAL, on purpose - see the module docstring. One bool per item, in
        order; a failed item raises rather than returning False silently, which
        is what the caller's own retry ladder expects."""
        return [self.convert(index, text) for index, text in items]

    def generate_batch_stream(self, texts, voices, stream_rows, on_chunk, on_row,
                              should_stop=None) -> None:
        """In-memory batch render. Rows are emitted WHOLE, at retirement.

        The argument validation is `OrpheusEngine.generate_batch_stream`'s,
        because the serve worker drives both through the same call, and the
        one-on_row-per-row / no-on_row-for-an-abandoned-row contract is
        identical.

        `stream_rows` is honoured by delivering the finished row as a SINGLE
        `on_chunk(row, 0, audio)` before its `on_row`, so a caller that asked
        for streaming still gets its audio on the streaming channel - it simply
        arrives in one piece, at the same moment the row finishes. Nothing here
        pretends to have started earlier than it did.
        """
        if not texts:
            return
        if voices is not None and len(voices) != len(texts):
            raise ValueError(
                f'HiggsEngine.generate_batch_stream: {len(voices)} voices for '
                f'{len(texts)} texts; voices must be aligned to texts or None')
        if voices is not None:
            wrong = sorted({v for v in voices if v and v != self.voice})
            if wrong:
                raise ValueError(
                    f'HiggsEngine.generate_batch_stream: rows ask for voice(s) '
                    f"{wrong}; this engine serves '{self.voice}'. Higgs's voice is its "
                    'reference clips, so a mixed-voice batch is a mixed-ENGINE batch.')
        stream_rows = set() if stream_rows is None else set(stream_rows)
        stray = [i for i in stream_rows if not (0 <= i < len(texts))]
        if stray:
            raise ValueError(
                f'HiggsEngine.generate_batch_stream: stream_rows names row(s) {stray} '
                f'outside the batch of {len(texts)}')
        if stream_rows and on_chunk is None:
            raise ValueError(
                'HiggsEngine.generate_batch_stream: stream_rows is non-empty but no '
                'on_chunk was given')
        blank = [i for i, t in enumerate(texts) if not (t or '').strip()]
        if blank:
            raise ValueError(
                f'HiggsEngine.generate_batch_stream: row(s) {blank} have no text after '
                'cleaning.')

        for i, text in enumerate(texts):
            if should_stop is not None and should_stop():
                # Abandoned: no on_row for this row or any after it.
                return
            audio = self.render_audio(text, seed=self._seed_for(i))
            if i in stream_rows:
                on_chunk(i, 0, audio.copy())
            on_row(i, audio)
