"""SNAC geometry: the windowed frame emitter (fast start) and the token ->
waveform decode.

Ported from ebook2audiobook@9daab0ba:
  lib/classes/tts_engines/orpheus_stream_decode.py   the WHOLE module
                                                     (PAYLOAD_FRAMES,
                                                      RIGHT_CONTEXT_FRAMES,
                                                      LEFT_CONTEXT_FRAMES,
                                                      SAMPLES_PER_FRAME,
                                                      TOKENS_PER_FRAME,
                                                      StreamDecodeMisaligned,
                                                      WindowedFrameEmitter)
  lib/classes/tts_engines/orpheus.py                 _redistribute_codes (3920),
                                                     _tokens_to_audio (3985)

The emitter half is pure numpy and is imported by tests with no torch present;
`SnacMixin` imports torch lazily, inside its two methods, for the same reason.
"""
import numpy as np

from .errors import TokenStreamMisaligned
from ..log import log

# Orpheus/SNAC geometry. 7 tokens per frame is the model's output framing
# (_redistribute_codes); 2048 samples per frame is snac_24khz's, and it is a
# FACT OF THE CHECKPOINT, not a tuning knob: decoder_rates [8, 8, 4, 2] gives
# 512 samples per latent step and vq_strides [4, 2, 1] puts 4 latent steps in
# the frame that carries 7 codes - 4 x 512 = 2048.
TOKENS_PER_FRAME = 7
SAMPLES_PER_FRAME = 2048

# The emission cadence. 4 frames is ~0.34 s of audio per chunk, small enough
# that the client can start playing early and large enough that the per-chunk
# overhead (a decode, a base64 payload, a JSON line) stays negligible. The
# first chunk therefore needs 4 + 2 = 6 frames (~0.5 s) of generation before
# anything can leave - that half second is the whole latency budget of fast
# start, and at ~84 tokens/s it is reached in well under a second.
PAYLOAD_FRAMES = 4
RIGHT_CONTEXT_FRAMES = 2
LEFT_CONTEXT_FRAMES = 1

# The audio-token block: [AUDIO_LO, AUDIO_HI) is EVERY SNAC code, 7 positional
# slots of 4096 each.
AUDIO_LO = 128266
AUDIO_HI = 128266 + 4096 * 7


class StreamDecodeMisaligned(ValueError):
    """The windowed decoder was handed, or handed back, something that cannot be
    sliced into whole frames.

    Always names the row and the numbers. There is deliberately no recovery
    path: a payload sliced out of the wrong place is audio a listener has
    ALREADY heard by the time anything downstream could notice, so the only
    honest response is to fail the row loudly and let the caller report it.
    """


class WindowedFrameEmitter:
    """Turns a growing token count into contiguous, non-overlapping payloads.

    THE PROBLEM THIS SOLVES. Orpheus emits 7 audio tokens per SNAC frame and one
    frame is 2048 samples at 24 kHz (~85 ms). Without fast start a sentence is
    decoded ONCE, as a whole clip, after its generation finishes - which is why
    the browser extension waits ~30 s before the first word. Fast start decodes
    the row WHILE it is still generating and ships the audio out in ~0.34 s
    pieces.

    You cannot do that by simply decoding frames [a, b) on their own. SNAC's
    decoder is a stack of transposed convolutions: the samples near a decode's
    edges are computed against zero padding rather than against the neighbouring
    frames, so a sequence of independent per-piece decodes clicks audibly at
    every seam. The cure (the same one upstream orpheus_tts's streaming decoder
    uses) is to decode a WINDOW that overhangs the payload on both sides and keep
    only the interior:

          window   [a-1 .................................. b+2)
          payload        [a .......... b)                        <- emitted
                     ^^^                ^^^^
                 left context        right context

    The left frame has already been emitted and the right two have not been
    emitted yet; both are decoded purely so the payload frames see real
    neighbours. Nothing is emitted twice and nothing is skipped, so the
    concatenation of every payload of a row is EXACTLY n * 2048 samples for n
    frames - bit-comparable in length to the whole-clip decode it replaces.

    `decode_frames(first_frame, last_frame_exclusive) -> np.ndarray` renders one
    window of the row being streamed and must return exactly
    (last - first) * SAMPLES_PER_FRAME float samples. The emitter never touches
    tokens itself - the backend owns those - which is exactly what lets one
    implementation serve torch SNAC and mlx SNAC and a fake.

    Usage, per row:
        em = WindowedFrameEmitter(decode, label='row 7')
        per generation step:   for seq, pcm in em.push(len(audio_tokens)): ...
        at EOS / cap:          for seq, pcm in em.flush(len(audio_tokens)): ...

    push() and flush() return LISTS, not generators, on purpose: the emitter's
    state advances as each payload is produced, and a generator the caller
    forgot to drain would leave that state silently half-advanced.

    NO RE-DECODE ECONOMY IS ATTEMPTED. Each payload of 4 frames costs a 7-frame
    decode, i.e. 1.75x the whole-clip decode work spread across the row. That is
    the price of the seams and it is deliberate; upstream pays 4x for the same
    effect.
    """

    def __init__(self, decode_frames, label=''):
        self._decode = decode_frames
        self.label = label
        self.emitted_frames = 0     # `a` in the docstring above
        self.emitted_samples = 0
        self.seq = 0                # next chunk's sequence number for this row
        self.decoded_windows = 0    # windows decoded, for logging/metrics
        self._flushed = False

    # ---- emission -----------------------------------------------------------

    def push(self, n_tokens: int):
        """Emit every payload that `n_tokens` generated tokens now permit.

        Returns [(seq, payload_float32), ...] - usually empty (a decode step
        adds one token per row, and it takes 7 of those to move the frame count
        at all), occasionally one, and more than one only if the caller batched
        several steps' tokens before calling.
        """
        if self._flushed:
            raise StreamDecodeMisaligned(
                f'{self.label}: push() after flush() - the row was already '
                'closed out and its payloads have been delivered')
        return self._drain(self._frames(n_tokens))

    def flush(self, n_tokens: int):
        """Close the row out: drain what the cadence allows, then emit whatever
        tail is left with whatever right context exists.

        The tail is at most PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES - 1 = 5 frames
        (~0.43 s), because anything more would already have been drained by the
        loop above it. It is decoded as [max(0, a-1), n) - left context as
        usual, no right context, because there is none: the row has stopped.
        That last window's final frames are the ones the whole-clip decode also
        computed against silence, so the seam quality at the END of a streamed
        row is exactly the quality it has today.
        """
        if self._flushed:
            raise StreamDecodeMisaligned(
                f'{self.label}: flush() called twice; a row is closed out once')
        n = self._frames(n_tokens)
        out = self._drain(n)
        self._flushed = True
        if n > self.emitted_frames:
            out.append(self._emit(self.emitted_frames, n, n))
        return out

    @property
    def closed(self) -> bool:
        return self._flushed

    # ---- internals ----------------------------------------------------------

    def _frames(self, n_tokens: int) -> int:
        """Whole frames available from `n_tokens` audio tokens.

        A partial frame is not audio yet - 6 of the 7 codes cannot be decoded -
        so it simply waits for its seventh token. The floor division is the only
        place that truncation happens, and it is why the total emitted for a row
        is (tokens // 7) * 2048 samples and not something that depends on when
        the caller happened to call.
        """
        if n_tokens < 0:
            raise StreamDecodeMisaligned(
                f'{self.label}: negative token count {n_tokens}')
        n = n_tokens // TOKENS_PER_FRAME
        if n < self.emitted_frames:
            # Tokens only ever accumulate. A shrinking count means the caller
            # handed a different row's list, or re-used an emitter across rows.
            raise StreamDecodeMisaligned(
                f'{self.label}: {n_tokens} tokens is {n} frames, but '
                f'{self.emitted_frames} frames have already been emitted')
        return n

    def _drain(self, n: int) -> list:
        """Every full-cadence payload the frame count `n` now permits."""
        out = []
        while n >= self.emitted_frames + PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES:
            a = self.emitted_frames
            b = a + PAYLOAD_FRAMES
            out.append(self._emit(a, b, b + RIGHT_CONTEXT_FRAMES))
        return out

    def _emit(self, a: int, b: int, window_end: int):
        """Decode [max(0, a-1), window_end) and cut the payload frames [a, b) out
        of it. Advances the row's cursor by exactly the frames emitted."""
        w0 = max(0, a - LEFT_CONTEXT_FRAMES)
        audio = self._decode(w0, window_end)
        self.decoded_windows += 1
        if audio is None:
            raise StreamDecodeMisaligned(
                f'{self.label}: decoder returned None for frames '
                f'[{w0}, {window_end})')
        want = (window_end - w0) * SAMPLES_PER_FRAME
        if len(audio) != want:
            # Not a tolerance to widen. The payload is cut by FRAME ARITHMETIC,
            # so a decoder that returns a different number of samples per frame
            # would have every later slice land in the wrong place - silently,
            # as audio that is already playing.
            raise StreamDecodeMisaligned(
                f'{self.label}: decoding frames [{w0}, {window_end}) returned '
                f'{len(audio)} samples, expected {want} '
                f'({window_end - w0} frames x {SAMPLES_PER_FRAME})')
        lo = (a - w0) * SAMPLES_PER_FRAME
        hi = (b - w0) * SAMPLES_PER_FRAME
        # .copy(): the slice is a VIEW of the whole decoded window, and the
        # payload outlives this call (it is queued for the wire). Copying 4
        # frames of float32 is 32 KB and lets the window's other frames go.
        payload = np.asarray(audio[lo:hi], dtype=np.float32).copy()
        self.emitted_frames = b
        self.emitted_samples += len(payload)
        seq = self.seq
        self.seq += 1
        return seq, payload


class SnacMixin:
    """The torch-SNAC half: token ids -> a float32 waveform."""

    def _redistribute_codes(self, tokens: list) -> list:
        """Redistribute Orpheus tokens to SNAC's 3-layer format.

        Orpheus outputs 7 tokens per audio frame. SNAC expects these
        distributed across 3 layers:
        - Layer 1: 1 code per frame
        - Layer 2: 2 codes per frame
        - Layer 3: 4 codes per frame

        Raises TokenStreamMisaligned if any token lands outside its positional
        slot. Each of the 7 positions in a frame must fall in ITS OWN 4096-wide
        sub-range (position p in [p*4096, (p+1)*4096)); the global-range filter
        below silently drops any interleaved non-audio token, which SHIFTS every
        later token one position over and makes the offset subtraction produce
        negative/oversized codes. Those used to go straight into SNAC's codebook
        index_select on the GPU -> `srcIndex < srcSelectDimSize` device-side
        assert -> the CUDA context is poisoned and EVERY later sentence in the
        run fails instantly (2026-07-05: one bad sentence burned 1200). Failing
        Python-side keeps it a one-sentence problem the caller can re-render.
        """
        import torch
        # Filter to valid audio tokens (128266 to 128266+4096*7)
        audio_tokens = [t for t in tokens if AUDIO_LO <= t < AUDIO_HI]

        if not audio_tokens:
            return None

        # Truncate to multiple of 7
        code_length = (len(audio_tokens) // 7) * 7
        audio_tokens = audio_tokens[:code_length]

        if code_length == 0:
            return None

        # Subtract base offset
        code_list = [t - AUDIO_LO for t in audio_tokens]

        # Every code must sit in its positional slot BEFORE the per-layer offset
        # subtraction - see the docstring for why an out-of-slot code is fatal.
        for i in range(len(code_list) // 7):
            for pos in range(7):
                code = code_list[7 * i + pos]
                if not (pos * 4096 <= code < (pos + 1) * 4096):
                    raise TokenStreamMisaligned(
                        f"frame {i} slot {pos}: code {code} outside [{pos * 4096}, {(pos + 1) * 4096})"
                    )

        # Distribute across 3 layers with offset subtraction
        layer_1, layer_2, layer_3 = [], [], []

        for i in range(len(code_list) // 7):
            layer_1.append(code_list[7*i])
            layer_2.append(code_list[7*i + 1] - 4096)
            layer_3.append(code_list[7*i + 2] - (2 * 4096))
            layer_3.append(code_list[7*i + 3] - (3 * 4096))
            layer_2.append(code_list[7*i + 4] - (4 * 4096))
            layer_3.append(code_list[7*i + 5] - (5 * 4096))
            layer_3.append(code_list[7*i + 6] - (6 * 4096))

        codes = [
            torch.tensor(layer_1).unsqueeze(0).to(self._device),
            torch.tensor(layer_2).unsqueeze(0).to(self._device),
            torch.tensor(layer_3).unsqueeze(0).to(self._device)
        ]
        return codes

    def _tokens_to_audio(self, tokens: list) -> np.ndarray:
        """Convert Orpheus tokens to audio using SNAC decoder.

        OOM-resilient: a CUDA OOM here used to fail the whole sentence, which the
        batch path then re-generated through vLLM - wasted GPU-minutes for an
        audio-decode hiccup. Seen in production as tiny (32-88 MiB) allocations
        failing with ~11 GiB reported free: allocator/VA fragmentation in the
        long-lived WSL worker, not real memory pressure. Recovery ladder:
          (1) torch.cuda.empty_cache() and retry on the GPU;
          (2) decode THIS sentence on CPU (SNAC is a small convnet - one CPU
              decode is cheap) and move the model back to the GPU after;
          (3) if it can't move back, leave SNAC on CPU permanently - decodes
              keep working (slightly slower) instead of failing the run.
        Every step logs loudly so a degraded run is visible, never silent.
        """
        import torch
        if not tokens:
            return np.zeros(int(self.SAMPLE_RATE * 0.1), dtype=np.float32)

        # Redistribute tokens to SNAC's 3-layer format
        codes = self._redistribute_codes(tokens)
        if codes is None:
            return np.zeros(int(self.SAMPLE_RATE * 0.1), dtype=np.float32)

        # Decode on whatever device SNAC currently lives on (it may have been
        # stranded on the CPU by a previous OOM - see the ladder below).
        snac_device = next(self.snac_model.parameters()).device
        codes = [c.to(snac_device) for c in codes]

        try:
            with torch.no_grad():
                audio = self.snac_model.decode(codes)
        except torch.cuda.OutOfMemoryError:
            log("Orpheus SNAC decode hit CUDA OOM; freeing the allocator cache and retrying on GPU")
            torch.cuda.empty_cache()
            try:
                with torch.no_grad():
                    audio = self.snac_model.decode(codes)
            except torch.cuda.OutOfMemoryError:
                log("Orpheus SNAC decode OOM persists; decoding this sentence on the CPU")
                cpu_codes = [c.cpu() for c in codes]
                self.snac_model.to('cpu')
                with torch.no_grad():
                    audio = self.snac_model.decode(cpu_codes)
                try:
                    self.snac_model.to(self._device)
                except torch.cuda.OutOfMemoryError:
                    # Stay on CPU: future decodes follow snac_device above, so the
                    # run keeps producing audio instead of dying. Loud, not silent.
                    log("Orpheus SNAC could not return to the GPU; leaving the decoder on CPU for the rest of this run")

        # Convert to numpy
        audio_np = audio.squeeze().cpu().numpy()
        return audio_np
