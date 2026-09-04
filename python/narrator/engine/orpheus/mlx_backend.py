"""The MLX backend: model load + prompt-framing patch, the batch scheduler, the
decode-overlap thread, and fast start.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _load_mlx_engine (1234)              _patch_mlx_prompt_framing (1298)
  _generate_mlx (2193)                 _mlx_looks_capped (2263)
  _generate_mlx_safe (2277)            batch_pool_size (2316)
  _mlx_width_for_depth (2349)          _mlx_kv_headroom_gb (2376)
  _mlx_batch_groups (2395)             _resolve_mlx_row (2448)
  _mlx_frame_decoder (2478)            _generate_mlx_batch_audio (2547)
  _mlx_decode_stream (4875)            _mlx_row_audio (4919)
  _mlx_rerender_capped (4940)          _mlx_resplit_deferred (4969)
  _mlx_generate_rows (4984)            _convert_mlx_batch (5324)

LOAD-BEARING LOG STRING. The heartbeat in _mlx_generate_rows is parsed by
BookForge twice - electron/mlx-batch-progress.ts:94 (the within-batch progress
bar) and electron/parallel-tts-bridge.ts:2513 (the watchdog's activity test) -
so its wording and field order are byte-identical to e2a's:
  [ORPHEUS] MLX batch generating: 95 rows, ~1259 tokens (step 1260/3400), 12/95 rows done, batch 1/2[ live 72]

mlx / mlx_lm / mlx_audio are imported LAZILY inside the functions, exactly as
e2a did, so this module imports on a machine with no MLX at all.
"""
import os
import sys

import numpy as np

from . import cuda_env
from .snac import (PAYLOAD_FRAMES, RIGHT_CONTEXT_FRAMES, SAMPLES_PER_FRAME,
                   TOKENS_PER_FRAME, StreamDecodeMisaligned,
                   WindowedFrameEmitter)

# lib/conf.py's block ran for every engine; on a Mac it is nearly a no-op but it
# is applied here for the same reason it is applied in vllm_backend: at import,
# before torch/mlx.
cuda_env.apply()


class MlxBackendMixin:

    # ---- load ---------------------------------------------------------------

    def _load_mlx_engine(self):
        """Load model using MLX backend (Mac only, fastest)."""
        import mlx.core as mx
        from mlx_audio.tts.utils import load_model

        # Bound the MLX buffer cache. Without a limit the allocator's cache of
        # freed buffers grows to ~46 GB over a single batched chunk (measured,
        # M1 Ultra: SNAC decode + per-step generation buffers come in many
        # distinct sizes, so freed buffers pile up per size-bucket) - that's the
        # memory-pressure spike, NOT the active weights+KV (~22 GB at batch 96).
        # A bounded cache also beats the old per-chunk mx.clear_cache() flush:
        # buffers still get reused (a full flush forces cold Metal re-allocation
        # every chunk) and the footprint stays flat for the whole run.
        # Measured at batch 96: 8 GB limit = 28.1 sent/min vs 27.2 flush-per-chunk.
        cache_gb = float(os.environ.get('ORPHEUS_MLX_CACHE_LIMIT_GB', '8'))
        mx.set_cache_limit(int(cache_gb * 1e9))
        print(f"Orpheus MLX buffer cache limited to {cache_gb:g} GB")
        # Fail fast on an impossible memory budget, before any audio is rendered.
        headroom = self._mlx_kv_headroom_gb()
        print(f"Orpheus MLX batch budget {self.MLX_MEM_BUDGET_GB:g} GB "
              f"({headroom:.1f} GB for KV -> max {self._mlx_width_for_depth(self.MLX_MAX_TOKENS)} "
              f"rows at the {self.MLX_MAX_TOKENS}-token cap)")

        print(f"Loading Orpheus model with MLX: {self.MLX_MODEL}")
        model = load_model(self.MLX_MODEL)
        # Fine-tuned Orpheus voices were TRAINED with the prompt ending in
        # [128261, 128257] (START_OF_AI, START_OF_SPEECH) immediately before the audio
        # codes (orpheus_owen.py build_dataset; mirrored by _format_prompt_ids). But
        # mlx_audio's prepare_input_ids stops at [128009, 128260] (END_OF_TEXT,
        # END_OF_HUMAN) and relies on the BASE model to free-generate SOA/SOS - which is
        # out-of-distribution for our fine-tunes, so they vocalize the voice token /
        # stray syllables at chunk starts. The vLLM/transformers backends frame this
        # correctly via _format_prompt_ids; MLX bypasses that helper, so patch the
        # library's framing at load to restore the exact training frame.
        self._patch_mlx_prompt_framing(model)
        # ---- batched decode fast path ---------------------------------------
        #
        # mlx-lm's GenerationBatch._step does two things Orpheus does not need to
        # pay for on every one of ~3,700 steps:
        #   * it applies logits processors in a PYTHON LOOP over the batch -
        #     measured 151.7 vs 142.1 ms/step at width 96 with the processors
        #     removed entirely, i.e. ~9.6 ms/step (6%) that grows with width;
        #   * it projects the hidden state onto all 156,940 rows of the tied
        #     embedding when Orpheus can only emit EOS + the SNAC codes, a
        #     contiguous 28,680-id block - 964 MB of head weight read per step
        #     against 176 MB, 90.6 GFLOP against 16.6.
        # mlx_fastpath.install() replaces that step with a batched, sliced one.
        # It is PINNED to mlx-lm 0.31.3 (it reproduces _step line for line) and
        # it REFUSES by name - never silently falls back - on a non-tied or
        # quantized head, or on a repetition window too short to cover prompt +
        # generation, which is the exactness condition for its seen-mask form of
        # the penalty. ORPHEUS_MLX_FASTPATH=0 is the kill switch; everything else
        # about the render is unchanged.
        if os.environ.get('ORPHEUS_MLX_FASTPATH', '1') != '0':
            from .mlx_fastpath import install as _install_fastpath
            print(_install_fastpath(model, rep_window=self.MLX_REP_WINDOW,
                                    max_tokens=self.MLX_MAX_TOKENS))
        else:
            print('Orpheus MLX fast path disabled (ORPHEUS_MLX_FASTPATH=0); '
                  'using mlx-lm\'s stock per-row decode step')
        self._device = 'mlx'  # MLX manages its own device
        print("Orpheus MLX model loaded!")
        return model

    def _patch_mlx_prompt_framing(self, model):
        """Make mlx_audio frame fine-tuned voices exactly like training: append
        [START_OF_AI, START_OF_SPEECH] to the plain-voice prompt. Wrapping
        prepare_input_ids (which model.generate() also calls, llama.py:396) covers
        EVERY MLX path in one place - single (_generate_mlx), batch/streaming
        (_generate_mlx_batch_audio) and audiobook (_convert_mlx_batch). Voice-cloning
        calls (ref_audio/ref_text -> tuple return) are left untouched."""
        import mlx.core as mx
        orig = model.prepare_input_ids
        AI_SPEECH = mx.array([[128261, 128257]], dtype=mx.int64)  # START_OF_AI, START_OF_SPEECH

        def prepare_input_ids(prompt, voice=None, zeroprompt=None, ref_audio=None,
                              ref_text=None, *args, **kwargs):
            ids = orig(prompt, voice, zeroprompt, ref_audio, ref_text, *args, **kwargs)
            plain = (voice is not None and zeroprompt is None
                     and ref_audio is None and ref_text is None)
            # Only the plain fine-tuned-voice frame ([SOH]..[EOT EOH]) is missing the
            # SOA/SOS suffix; guard on the exact tail so nothing else is altered.
            if plain and not isinstance(ids, tuple) and ids.shape[0] == 1 \
                    and ids[0].tolist()[-2:] == [128009, 128260]:
                ids = mx.concatenate([ids, AI_SPEECH], axis=1)
            return ids

        model.prepare_input_ids = prepare_input_ids
        print("Orpheus MLX prompt framing patched for fine-tuned voices (SOA+SOS suffix)")

    # ---- solo generation ----------------------------------------------------

    def _generate_mlx(self, text: str, max_tokens: int = None,
                      sentence_index: int = None) -> np.ndarray:
        """Generate audio using MLX backend.

        max_tokens defaults to MLX_MAX_TOKENS. The old bare default was a stale
        2048 literal, which silently clipped ~450-char packed chunks (need
        2500-3400 tokens) on every bare call - and a 2048-clipped chunk implies
        ~18.4 chars/sec, just UNDER the truncation guard's measured 19.0
        threshold, so the guard could not catch what this default caused.

        Returns an EMPTY array when the model produced no audio - never
        fabricated silence, which would sail past _save_audio's empty-rejection
        and ship a missing sentence as success.
        """
        if max_tokens is None:
            max_tokens = self.MLX_MAX_TOKENS
        # Per-chunk anti-runaway ceiling - only ever LOWERS the cap (min), never
        # raises it (see _mlx_token_budget). A short chunk that tries to loop is
        # cut at its text-proportional budget instead of the flat MLX_MAX_TOKENS.
        budget = self._mlx_token_budget(text)
        effective_max = min(max_tokens, budget)
        # Match vLLM/transformers sampling params - repetition_penalty prevents
        # repeated audio patterns that can sound like echo/reverb
        print(f"[ORPHEUS] Generating with voice='{self.voice}' for: {text[:50]}...")
        # mlx_audio's generate() splits its input on newlines and yields ONE
        # GenerationResult per segment - accumulate them ALL; keeping only the
        # last silently dropped every segment before the final one.
        segments = []
        for result in self.mlx_model.generate(
            text,
            voice=self.voice,
            temperature=self._voice_cap('temperature'),
            top_p=self._voice_cap('topP'),
            repetition_penalty=self._voice_cap('repPenalty'),
            max_tokens=effective_max
        ):
            audio_data = result.audio
            if audio_data is None:
                continue
            # MLX returns audio as numpy array or MLX array
            if hasattr(audio_data, 'tolist'):
                audio_data = np.array(audio_data, dtype=np.float32)
            if len(audio_data) > 0:
                segments.append(audio_data)

        if not segments:
            return np.zeros(0, dtype=np.float32)
        audio = segments[0] if len(segments) == 1 else np.concatenate(segments)

        # Visibility: log only when the budget was the binding cap AND generation
        # ran right up to it - an actual runaway-shaped truncation, not a chunk
        # that finished early. tokens-emitted is ESTIMATED from audio duration
        # (_mlx_est_tokens; mlx_audio's generate() doesn't surface a token count).
        if effective_max < max_tokens:
            est_tokens = self._mlx_est_tokens(audio)
            if est_tokens >= effective_max * 0.95:
                idx_str = '' if sentence_index is None else f'sentence {sentence_index}: '
                print(f"[ORPHEUS] {idx_str}MLX per-chunk token budget truncated generation "
                      f"(len={len(text)}, budget={effective_max}, ~{int(est_tokens)} tokens emitted)")

        return audio

    def _mlx_looks_capped(self, clean: str, audio) -> bool:
        """True when a whole-text MLX render ran right up to its token cap, i.e. it
        was almost certainly CUT mid-sentence rather than finishing - the MLX
        stand-in for the vLLM ladder's `END_OF_AUDIO_TOKEN in tokens` check, which
        has no MLX equivalent. The cap is the one _generate_mlx would have applied:
        min(MLX_MAX_TOKENS, the per-chunk anti-runaway budget); 0.95 of it is
        'ran to the end' allowing for the estimate's slop.

        EMPTY audio is NOT capped (estimate 0): an empty render is a FAILED render
        (_guard_truncation's job), not a too-long one, and splitting it would only
        multiply the failure."""
        cap = min(self.MLX_MAX_TOKENS, self._mlx_token_budget(clean))
        return self._mlx_est_tokens(audio) >= cap * 0.95

    def _generate_mlx_safe(self, clean: str, depth: int = 0,
                           force_split: bool = False) -> np.ndarray:
        """The safe general-purpose SOLO MLX render - MLX sibling of
        _generate_audio_vllm_safe. Renders `clean` WHOLE first; only if that render
        hit the token cap (_mlx_looks_capped - it would ship clipped) does it split
        at the nearest sentence/space boundary and render each half, concatenating
        the audio. Recurses up to a small depth so even an unusually dense chunk
        produces complete, un-clipped audio; a part that still can't finish is
        accepted as-is (same bottom rung as the vLLM ladder).

        It used to split EAGERLY - every text >= 80 chars was halved BEFORE any
        render - which was harmless for its original proven-cap callers but wrong
        for the streamed opener, which renders each play action's first sentence
        through here: every half was voiced as a standalone utterance, so an
        ordinary sentence came out with a mid-sentence pause and sentence-final
        prosody. Callers that have already proven the whole render fails ask for the
        old behaviour explicitly, with force_split.

        force_split=True skips the whole-chunk render and splits IMMEDIATELY, for
        callers whose whole render ALREADY failed - a proven token-cap hit, or
        _guard_truncation's clean early EOS. Re-rendering the whole text would very
        likely fail the same way, and (for a clean early EOS) the accept rung below
        would then return it unsplit: a re-roll, not a fix. Parts recurse WITHOUT
        force_split (the normal cap logic applies to them); text that can't be split
        (parts < 2) falls through to a normal whole render.
        """
        if force_split:
            parts = self._split_long_text(clean, max_length=max(60, len(clean) // 2))
            if len(parts) >= 2:
                return np.concatenate([self._generate_mlx_safe(p, depth + 1) for p in parts])
        audio = self._generate_mlx(clean, max_tokens=self.MLX_MAX_TOKENS)
        # Accept what we have once it fits, can't be split sensibly, or we've recursed enough.
        if not self._mlx_looks_capped(clean, audio) or depth >= 3 or len(clean) < 80:
            return audio
        parts = self._split_long_text(clean, max_length=max(60, len(clean) // 2))
        if len(parts) < 2:
            return audio
        return np.concatenate([self._generate_mlx_safe(p, depth + 1) for p in parts])

    # ---- batch scheduling ---------------------------------------------------

    @property
    def batch_pool_size(self) -> int:
        """How many sentences the worker should accumulate before calling
        convert_batch(). Plain BATCH_SIZE everywhere EXCEPT MLX with continuous
        batching on, where it is MLX_CONTINUOUS_POOL (default 4 x BATCH_SIZE).

        A continuous BatchGenerator refills a retired slot from the rows it was
        given; handed exactly BATCH_SIZE rows it has nothing to refill with and
        degenerates into today's single fresh group. So the pool is what makes the
        experiment an experiment. Every other configuration returns BATCH_SIZE.

        THE POOL IS A FLUSH SIZE, NOT A BATCH WIDTH. _convert_mlx_batch still caps
        the rows generating at once at _mlx_width_for_depth (<= BATCH_SIZE); the
        pool only makes the CALL longer. What it does change is the worker's
        reporting granularity: the worker prints its per-sentence "Converting
        sentence i/N" lines only after a flush RETURNS, so they arrive in blocks of
        pool_size instead of BATCH_SIZE (the [ORPHEUS] heartbeat is the
        within-call progress source meanwhile), and a cooperative stop deletes the
        whole flush's in-flight indices. Both are re-rendered on resume;
        correctness is unaffected, wasted work is not."""
        width = max(1, int(self.BATCH_SIZE or 1))
        if self.MLX_CONTINUOUS and getattr(self, 'backend', None) == 'mlx':
            return max(width, int(self.MLX_CONTINUOUS_POOL or 0) or 4 * width)
        return width

    def _mlx_width_for_depth(self, depth: int, steady: bool = False) -> int:
        """Widest batch that keeps peak MLX memory inside MLX_MEM_BUDGET_GB when
        every row may generate up to `depth` tokens.

            width x depth x MLX_KV_MB_PER_TOKEN_ROW  +  weights  +  buffer cache
                <=  MLX_MEM_BUDGET_GB

        The buffer cache is pinned at load by mx.set_cache_limit
        (ORPHEUS_MLX_CACHE_LIMIT_GB) so it is a known constant, not a variable.
        Never returns more than BATCH_SIZE, never less than 1 (a single row must
        always be attemptable - it is the same work the solo path would do).

        Worked example at the shipped defaults (budget 45, cache 8, cap 3700):
        headroom = 45 - 6.9 - 8 = 30.1 GB; per-row KV = 3700 x 0.1147 / 1024 =
        0.414 GB; width = 72."""
        width = max(1, int(self.BATCH_SIZE or 1))
        if depth <= 0:
            return width
        headroom = self._mlx_kv_headroom_gb()
        # steady=True budgets the MEASURED peak per row (continuous batching, where
        # width x depth is the steady state), not the arithmetic cache size.
        mb = self.MLX_KV_MB_PER_TOKEN_ROW_STEADY if steady else self.MLX_KV_MB_PER_TOKEN_ROW
        kv_gb_per_row = depth * mb / 1024.0
        return max(1, min(width, int(headroom / kv_gb_per_row)))

    def _mlx_kv_headroom_gb(self) -> float:
        """GB left for KV after the resident weights and the pinned buffer cache.

        Raises when the configured budget cannot even hold those two: there is no
        sane width to fall back to, and silently running at full width would defeat
        the whole point of the budget. Validated once at engine load
        (_load_mlx_engine) so a bad ORPHEUS_MLX_MEM_BUDGET_GB fails before any
        audio is rendered rather than mid-book."""
        cache_gb = float(os.environ.get('ORPHEUS_MLX_CACHE_LIMIT_GB', '8'))
        headroom = self.MLX_MEM_BUDGET_GB - self.MLX_WEIGHTS_GB - cache_gb
        if headroom <= 0:
            raise ValueError(
                f'ORPHEUS_MLX_MEM_BUDGET_GB={self.MLX_MEM_BUDGET_GB:g} leaves no room for the '
                f'KV cache: {self.MLX_WEIGHTS_GB:g} GB of weights + {cache_gb:g} GB of pinned '
                f'buffer cache (ORPHEUS_MLX_CACHE_LIMIT_GB) already meet or exceed it. '
                f'Raise the budget or lower the cache limit.')
        return headroom

    def _mlx_batch_groups(self, entries: list) -> list:
        """entries: list of (key, prompt_token_list, payload, token_budget) in BOOK
        ORDER. Returns (batch_entries, depth) pairs to feed BatchGenerator.

        Batches are consecutive slices - no sorting, no bucketing. mlx-lm 0.31.3
        right-pads batch prefills, so a batch may mix a heading with packed prose
        without corrupting the short row. Book order matters for two reasons: the
        depth bound below is computed from the rows actually in the batch, and
        sentences finish in roughly the order the listener/progress bar expects.

        `depth` is the batch's max_tokens: the largest per-row anti-runaway budget
        (_mlx_token_budget) in the slice, clamped to MLX_MAX_TOKENS. A batch of
        short rows therefore gets a shallow cap - which both tightens the runaway
        guard and, via _mlx_width_for_depth, buys back width.

        Width is capped so width x depth of KV stays inside MLX_MEM_BUDGET_GB. When
        a slice is too deep to run at full width it is split EVENLY rather than into
        [allowed, remainder]: MLX throughput is bought by width (12.4 sent/min at
        16 vs 27-28 at 96), so a 96-row slice capped at 79 runs 48+48 rather than
        79+17 - same batch COUNT, but no near-solo tail batch."""
        width = max(1, int(self.BATCH_SIZE or 1))

        def _depth(rows):
            return min(self.MLX_MAX_TOKENS, max(e[3] for e in rows))

        groups = []
        i, n = 0, len(entries)
        while i < n:
            take = min(width, n - i)
            window = entries[i:i + take]
            i += take
            depth = _depth(window)
            allowed = self._mlx_width_for_depth(depth)
            if allowed >= take:
                groups.append((window, depth))
                continue
            parts = -(-take // allowed)  # ceil: fewest equal parts that all fit
            base, extra = divmod(take, parts)
            print(f"[ORPHEUS] MLX batch narrowed {take} rows -> {parts} x ~{base} "
                  f"(depth {depth} tok, cap {allowed}, budget {self.MLX_MEM_BUDGET_GB:g} GB)",
                  flush=True)
            pos = 0
            for p in range(parts):
                size = base + (1 if p < extra else 0)
                sub = window[pos:pos + size]
                pos += size
                groups.append((sub, _depth(sub)))
        return groups

    # ---- per-row decode -----------------------------------------------------

    def _mlx_decode_stream(self):
        """The ONE MLX stream a retired row's SNAC decode is scheduled on, so it
        does not queue behind the generation loop's own stream. None when this mlx
        cannot hand a stream across threads - the caller then declines to overlap
        rather than sharing the generation stream.

        API, quoted from the installed mlx 0.32.0 docstrings:

          mx.new_thread_unsafe_stream(device) -> Stream - "Make a new stream that
          can be used in any thread. Unlike new_stream which can only work on the
          thread of creation, streams created by this API can be passed to and
          evaluated anywhere, but note that currently all nodes in a graph must be
          evaluated in sequence and it is user's responsibilty to ensure there is
          no race condition."

          mx.stream(s) -> StreamContext - "Create a context manager to set the
          default device and stream."

        That caveat is honoured, not hoped over: exactly ONE decoder thread exists
        at a time (created and joined inside a single bucket), it is the only
        thread that ever touches this stream, and it evaluates one row's graph to
        completion - np.array() forces the eval - before it starts the next.

        mx.new_stream() is the WRONG call here: its stream is bound to the thread
        that created it, so it would have to be minted inside each decoder thread.
        Every mlx stream is a scheduler StreamThread plus, on Metal, its own
        command queue, and clear_streams() only reclaims the ones created on the
        CALLING thread - one per batch would leak both for the life of the process.
        Hence: created once, cached on self, reused by every batch for the life of
        the engine.
        """
        cached = getattr(self, '_mlx_decode_stream_obj', None)
        if cached is not None:
            return cached
        import mlx.core as mx
        factory = getattr(mx, 'new_thread_unsafe_stream', None)
        if factory is None:
            return None
        self._mlx_decode_stream_obj = factory(mx.default_device())
        return self._mlx_decode_stream_obj

    def _mlx_row_audio(self, ptoks: list, tokens: list):
        """ONE retired row's prompt+generated tokens -> float32 waveform.

        The cheap, model-free half of finishing a row: parse_output crops to the
        audio codes and SNAC decodes them. Empty (len 0) when the row produced no
        valid codes - EMPTY, never fabricated silence: fabricated zeros used to
        sail past _save_audio's empty-rejection and ship a sentence as a success
        with no audio. The caller's guard re-renders an empty once; if that fails
        too, _save_audio fails the row loudly.

        Raises on a decode failure - both callers own the failure contract.
        """
        import mlx.core as mx
        from mlx_audio.tts.models.llama.llama import decode_audio_from_codes
        ids = mx.array([ptoks + tokens])
        code_lists = self.mlx_model.parse_output(ids)
        if code_lists and len(code_lists[0]) > 0:
            return np.array(decode_audio_from_codes(code_lists[0])[0], dtype=np.float32)
        return np.zeros(0, dtype=np.float32)

    def _resolve_mlx_row(self, i: int, ptoks: list, clean: str, tokens: list, depth: int):
        """Turn ONE retired BatchGenerator row's tokens into audio (or None).

        Factored out of _generate_mlx_batch_audio so a row can be resolved the
        moment it retires (per-row streaming emission) using the exact same ladder
        the end-of-batch loop used to run:
          - tokens >= depth  -> the row hit the cap and would ship clipped, so
            re-render it split (force_split: the cap hit is PROVEN, skip the whole
            re-render _generate_mlx_safe would otherwise try first);
          - otherwise decode prompt+generated through parse_output/SNAC;
          - no codes, or a decode error -> None (the caller's failure contract).
        """
        import mlx.core as mx
        from mlx_audio.tts.models.llama.llama import decode_audio_from_codes
        try:
            if len(tokens) >= depth:
                # Cap hit without finishing - re-render split so the played audio is
                # never clipped mid-sentence.
                print(f"Orpheus: stream sentence [{i}] hit the MLX audio-token cap; re-rendering split")
                return self._generate_mlx_safe(clean, force_split=True)
            ids = mx.array([ptoks + tokens])
            code_lists = self.mlx_model.parse_output(ids)
            if code_lists and len(code_lists[0]) > 0:
                return np.array(decode_audio_from_codes(code_lists[0])[0], dtype=np.float32)
            return None
        except Exception as decode_err:
            print(f"Orpheus _generate_mlx_batch_audio decode error [{i}]: {decode_err}")
            return None

    def _mlx_frame_decoder(self, out: dict, uid, decode_stream):
        """The `decode_frames` callable WindowedFrameEmitter drives for ONE MLX
        row (2026-09-04, fast start).

        WHY NOT parse_output. _mlx_row_audio decodes a whole clip through
        mlx_model.parse_output, which crops at the LAST 128257 (the prompt's
        START_OF_SPEECH), removes 128258, trims to a multiple of 7 and subtracts
        128266 - walking the entire prompt+generation with a Python double loop
        over a mask, EVERY call. A windowed decode runs ~30x per row, so that
        cost would grow quadratically for no gain: we already hold the generated
        tokens on their own, with the stop token dropped by the generation loop,
        so `[t - 128266 for t in tokens[a*7:b*7]]` is exactly the code list
        parse_output would have produced for those frames.

        WHY READING `out[uid]` FROM THE DECODER THREAD IS SAFE. The generation
        thread only ever APPENDS to that list, and this closure only ever slices
        a PREFIX the dispatcher has already counted. CPython's list append and
        list slice both complete under the GIL, so the slice can never observe a
        half-written element or a reallocation in progress. The stream the
        decode runs on is the one cross-thread stream from _mlx_decode_stream,
        under the one-decoder-thread discipline documented there.

        THE 75-SAMPLE TAIL (measured on the Mac, 2026-09-04). mlx_audio's SNAC
        does NOT return n * 2048 samples for n frames - it returns n * 2048 + 75,
        every time and for every width (1 frame -> 2123, 4 -> 8267, 6 -> 12363,
        7 -> 14411, 20 -> 41035, 24 -> 49227). The extra 75 samples are a TAIL,
        not a lead-in: cross-correlating a window's interior against the
        whole-clip decode puts the best alignment at offset 0 (rms 0.0027 against
        a signal rms of 0.078), so samples [0, n*2048) of a window are the frames
        we asked for, in place, and everything past that is ring-out. So the
        window is TRIMMED to the frame arithmetic here rather than the frame
        arithmetic being loosened to fit it - the emitter's exact-length check
        stays exact, which is the one thing standing between a wrong slice and a
        listener's ears.

        The consequence, stated plainly: a STREAMED MLX row is 75 samples
        (3.1 ms at 24 kHz) shorter than the same row through _mlx_row_audio,
        because the whole-clip decode keeps its one trailing ring-out and the
        streamed row's last window has its trimmed off. 3 ms at the very end of
        a sentence, under the inter-sentence gap the worker appends, is
        inaudible; a mis-sliced payload would not be. torch SNAC (the vLLM path)
        returns exactly n * 2048 and is unaffected by any of this.
        """
        import mlx.core as mx
        from mlx_audio.tts.models.llama.llama import decode_audio_from_codes

        def _decode(first, last):
            codes = [t - 128266 for t in
                     out[uid][first * TOKENS_PER_FRAME:last * TOKENS_PER_FRAME]]
            if decode_stream is None:
                audio = decode_audio_from_codes(codes)[0]
            else:
                with mx.stream(decode_stream):
                    audio = decode_audio_from_codes(codes)[0]
            # np.array() forces the eval, so this row's graph is complete before
            # the next window's is built - the sequencing _mlx_decode_stream's
            # docstring requires.
            arr = np.array(audio, dtype=np.float32)
            want = (last - first) * SAMPLES_PER_FRAME
            if len(arr) < want:
                # SHORT is not a tail, it is a different decoder. Refuse rather
                # than pad: every later payload would be cut from the wrong place.
                raise StreamDecodeMisaligned(
                    f'mlx SNAC returned {len(arr)} samples for frames '
                    f'[{first}, {last}) - fewer than the {want} '
                    f'({last - first} x {SAMPLES_PER_FRAME}) those frames are')
            return arr[:want]
        return _decode

    # ---- the in-memory batch (streaming server) -----------------------------

    def _generate_mlx_batch_audio(self, texts: list, on_row=None, should_stop=None,
                                  stream_rows=None, on_chunk=None) -> list:
        """Batch-generate raw audio for many (already-cleaned) sentences in ONE
        MLX BatchGenerator pass - continuous batching, ~3.6x the per-sentence
        throughput. Returns float32 waveforms aligned to `texts` (None for an
        empty/failed item).

        In-memory sibling of _convert_mlx_batch's core (which writes FLACs): the
        streaming server uses this to generate a whole paragraph's sentences in
        parallel so MLX stays ahead of playback instead of dribbling one slow
        sentence at a time. MLX backend only.

        `on_row(i, audio)` - optional. Rows do NOT all finish together: mlx-lm
        retires each row as it hits its stop token, and the shortest row of a batch
        typically retires around 70% of the batch's depth. With a callback, each row
        is decoded (through the full cap/resplit ladder above) and handed over AT
        RETIREMENT instead of everything landing at the end, which is worth ~12s to
        the earliest sentences of a 30-43s batch. Called exactly ONCE per non-empty
        row, in RETIREMENT order (not `texts` order) - `i` is the index into `texts`,
        so an out-of-order-tolerant caller can reassemble.

        `should_stop()` - optional. Checked once per DECODE STEP (and once before
        each bucket), which is cheap next to a forward pass over the batch. When it
        goes true the generation is ABANDONED where it stands: the live
        BatchGenerator is closed, no further bucket is started, and every row that
        had not yet retired is left as None - deliberately NOT handed to on_row, so
        a caller streaming rows cannot mistake an abandoned row for a finished one.

        `stream_rows` / `on_chunk` - fast start (2026-09-04). Indices in
        `stream_rows` are WINDOW-DECODED WHILE THEY GENERATE: every ~28 generated
        tokens (4 frames, ~0.34 s of audio) the row's new frames are decoded with
        one frame of left context and two of right, and the interior is handed to
        `on_chunk(i, seq, audio)`. At retirement the row is flushed, its payloads
        are concatenated, and `on_row(i, full)` fires as usual. Default None ->
        not one line of the code below runs and the batch behaves exactly as it
        always did.

        A STREAMED ROW IS NEVER RE-RENDERED. _resolve_mlx_row's cap ladder and
        the truncation resplit both replace audio, and audio that has been
        emitted has been heard. So a streamed row skips that ladder entirely: the
        cap hit and the _needs_resplit verdict are LOGGED with an
        [ORPHEUS][STREAM] line and the audio stands.

        THREADING. The windowed decodes run on ONE decoder thread over the single
        cross-thread stream from _mlx_decode_stream() - so `on_chunk` and a
        streamed row's `on_row` ARE CALLED FROM THAT THREAD. A caller whose sink
        is not thread-safe must queue them. When this mlx cannot hand a stream
        across threads the decodes run inline on the generation thread instead
        (loudly - the callbacks then arrive on the calling thread).
        """
        from mlx_lm.generate import BatchGenerator
        from mlx_lm.sample_utils import make_sampler
        # The repetition penalty is minted by the fast path's factory rather than
        # make_logits_processors: same mlx-lm closure, plus the marker the batched
        # step reads (penalty, window) off. Behaves identically on a stock model.
        from .mlx_fastpath import make_rep_penalty

        stream_rows = set() if stream_rows is None else set(stream_rows)
        if stream_rows and on_chunk is None:
            raise ValueError(
                '_generate_mlx_batch_audio: stream_rows is non-empty but no '
                'on_chunk was given; there would be nowhere for the streamed '
                'audio to go')
        results = [None] * len(texts)
        gen = []  # (index, prompt_tokens, clean_text, token_budget) for non-empty sentences
        for i, t in enumerate(texts):
            clean = (t or '').strip()
            if clean:
                ptoks = self.mlx_model.prepare_input_ids(clean, self.voice)[0].tolist()
                gen.append((i, ptoks, clean, self._mlx_token_budget(clean)))

        if not gen:
            return results
        # Batches are consecutive BOOK-ORDER slices, width-capped against the MLX
        # memory budget (_mlx_batch_groups). No length bucketing: mlx-lm 0.31.3
        # right-pads batch prefills, so a heading may share a batch with prose.
        # Each group is its own BatchGenerator; the model stays loaded so extra
        # prefills are cheap. One bad group must not kill the rest, so each is
        # wrapped independently.
        stopped = False
        for bucket, depth in self._mlx_batch_groups(gen):
            # A stop between buckets: start nothing new. The rows of every remaining
            # bucket stay None, which is the caller's "not rendered" contract.
            if should_stop is not None and should_stop():
                stopped = True
                break
            # Named before the try so the exception handler can shut a decoder
            # thread down even when the failure landed before the streaming
            # state was built (a BatchGenerator that would not construct).
            # `stream_fatal` is created here, not inside, so the handler can
            # read it whatever happened. Non-empty means "this is not a
            # per-bucket problem" - see the two places that append to it.
            _stream_shutdown = None
            stream_fatal = []
            try:
                bg = BatchGenerator(
                    self.mlx_model,
                    max_tokens=depth,
                    # 0.31.3: stop SEQUENCES, not a set of ints. A set iterates
                    # without raising and silently fails to stop.
                    stop_tokens=[[self.END_OF_AUDIO_TOKEN]],
                    sampler=make_sampler(self._voice_cap('temperature'),
                                         top_p=self._voice_cap('topP'),
                                         min_p=self._voice_cap('minP')),
                    logits_processors=[make_rep_penalty(
                        self._voice_cap('repPenalty'), self.MLX_REP_WINDOW)],
                    completion_batch_size=len(bucket),
                    prefill_batch_size=len(bucket),
                )
                boosts = [self._mlx_eos_boost_processor(len(c)) for _, _, c, _ in bucket]
                if any(boosts):
                    rep = [make_rep_penalty(
                        self._voice_cap('repPenalty'), self.MLX_REP_WINDOW)]
                    uids = bg.insert(
                        [list(p) for _, p, _, _ in bucket],
                        logits_processors=[rep + [b] if b else list(rep) for b in boosts])
                else:
                    uids = bg.insert([list(p) for _, p, _, _ in bucket])
                out = {u: [] for u in uids}
                row_by_uid = dict(zip(uids, bucket))   # uid -> (i, ptoks, clean, budget)
                pending = set(uids)                    # rows not yet resolved

                # ---- fast start, for THIS bucket -----------------------------
                #
                # Everything below is inert when the caller named no stream_rows:
                # `streams` is empty, no thread is started, and the loop is the
                # loop it has always been.
                #
                # EVERY per-bucket name the nested functions touch is bound into
                # them as a KEYWORD DEFAULT, evaluated here, once. Read out of
                # the enclosing scope instead, `out`, `streams`, `emitters`,
                # `depth`, `row_by_uid` and `job_q` would all be REBOUND by the
                # next turn of the bucket loop - so a decoder thread that somehow
                # outlived its bucket (a join that timed out) would decode the
                # NEXT bucket's tokens against THIS bucket's emitters, writing
                # one row's audio into another row's stream. The join is what
                # should make that impossible; the binding is what makes it
                # impossible even when the join has failed.
                streams = {u: row_by_uid[u][0] for u in uids
                           if row_by_uid[u][0] in stream_rows}
                emitters = {}
                stream_chunks = {}       # uid -> [payloads]
                stream_failed = set()    # uids whose windowed decode broke
                stream_results = {}      # index -> audio; ALSO the answered set
                stream_error = []        # the decoder thread's own machinery failing
                stream_abandoned = []    # non-empty => drop whatever is still queued
                stream_closed = []       # shutdown runs exactly once per bucket
                stream_flushed = set()   # uids a flush has been DISPATCHED for
                # Per-uid high-water mark: the emitter's emitted_frames as of
                # this row's last dispatch. Written and read ONLY by the
                # generation thread (the dispatch site below), so unlike the
                # dicts the decoder thread touches it needs no keyword binding.
                last_dispatch_ef = {}
                job_q = None
                decoder_box = []         # the decoder thread, once it exists
                if streams:
                    decode_stream = self._mlx_decode_stream()
                    for u in streams:
                        emitters[u] = WindowedFrameEmitter(
                            self._mlx_frame_decoder(out, u, decode_stream),
                            label=f'row {streams[u]}')
                        stream_chunks[u] = []
                        last_dispatch_ef[u] = -1   # nothing dispatched yet
                    if decode_stream is None:
                        # No cross-thread stream on this mlx. Decoding on the
                        # GENERATION stream from another thread is the race
                        # _mlx_decode_stream refuses, so run inline instead and
                        # say so: generation pauses for each ~0.34 s window, which
                        # is slower than it should be but still starts fast.
                        print('[ORPHEUS][STREAM] mlx.core.new_thread_unsafe_stream '
                              'is missing, so windowed decodes cannot be moved off '
                              'the generation thread; decoding INLINE (callbacks '
                              'arrive on the calling thread)',
                              file=sys.stderr, flush=True)
                    else:
                        # Imported HERE, not at the top of the method: the
                        # switch-ON path must not pay so much as an import it
                        # never had.
                        import queue as _queue
                        job_q = _queue.Queue()

                def _stream_emit(uid, kind, n_tokens, *,
                                 _streams=streams, _emitters=emitters,
                                 _chunks=stream_chunks, _failed=stream_failed,
                                 _results=stream_results, _out=out,
                                 _rows=row_by_uid, _depth=depth):
                    """One emitter call for one row, wherever this runs.

                    'push' mid-row, 'flush' at retirement. A decode failure fails
                    the ROW and nothing else: there is no retake to fall back on
                    (the audio is playing) and emitting past a bad window would
                    splice the row's own audio out of order.

                    Every 'flush' writes _results[i] - including the failure
                    paths - so _results doubles as the ANSWERED set the shutdown
                    reconciles against.
                    """
                    i = _streams[uid]
                    if uid in _failed:
                        if kind == 'flush':
                            _results[i] = None
                            if on_row is not None:
                                on_row(i, None)
                        return
                    try:
                        # The on_chunk loop is deliberately OUTSIDE the try: a
                        # callback that raises is the caller's bug, and blaming
                        # it on the windowed decode would send whoever reads the
                        # log to the wrong place.
                        pairs = (_emitters[uid].flush(n_tokens) if kind == 'flush'
                                 else _emitters[uid].push(n_tokens))
                    except Exception as emit_err:
                        _failed.add(uid)
                        print(f'[ORPHEUS][STREAM] row {i} windowed decode failed '
                              f'({emit_err}); the row is reported as a failure and '
                              f'its chunks are discarded',
                              file=sys.stderr, flush=True)
                        if kind == 'flush':
                            _results[i] = None
                            if on_row is not None:
                                on_row(i, None)
                        return
                    for seq, pcm in pairs:
                        _chunks[uid].append(pcm)
                        on_chunk(i, seq, pcm)
                    if kind != 'flush':
                        return
                    clean = _rows[uid][2]
                    full = np.concatenate(_chunks[uid]) if _chunks[uid] else None
                    if len(_out[uid]) >= _depth:
                        # The cap ladder in _resolve_mlx_row would re-render this
                        # split. A streamed row cannot: the clipped audio has
                        # already been heard. Say so and keep it.
                        print(f'[ORPHEUS][STREAM] row {i} hit the MLX audio-token '
                              f'cap ({_depth}); the streamed audio stands - nothing '
                              f'can retract audio that has already been played',
                              file=sys.stderr, flush=True)
                    if full is not None:
                        # Verdict only: _needs_resplit still logs the detection and
                        # keeps the reject, so a fast or empty streamed read is
                        # still visible; what it does not get is the re-render.
                        # (_keep_reject underneath it takes _reject_lock, because
                        # this can run on the decoder thread while the main thread
                        # is judging a non-streamed row.)
                        verdict = self._needs_resplit(i, clean, full)
                        if verdict is not None:
                            print(f'[ORPHEUS][STREAM] row {i} truncation verdict '
                                  f'{verdict!r}: kept as streamed, no re-render',
                                  file=sys.stderr, flush=True)
                    _results[i] = full
                    if on_row is not None:
                        on_row(i, full)

                def _stream_worker(*, _q=job_q, _abandoned=stream_abandoned,
                                   _error=stream_error, _emit=_stream_emit):
                    try:
                        while True:
                            job = _q.get()
                            if job is None:      # sentinel: the bucket is over
                                return
                            if _abandoned:
                                # The batch was abandoned or the decoder wedged;
                                # emitting more now would race the caller's own
                                # recovery.
                                continue
                            _emit(*job)
                    except Exception as thread_err:
                        # A failure OUTSIDE a row (the thread's own machinery).
                        # Recorded, never swallowed: the shutdown answers every
                        # row this thread will now never reach and then re-raises
                        # this, because a batch that returns normally with rows
                        # silently unanswered is the one failure the caller
                        # cannot see.
                        #
                        # Exception, NOT BaseException: a KeyboardInterrupt or a
                        # SystemExit arriving in this thread should unwind it the
                        # way it would unwind any other thread, not be caught,
                        # boxed, and re-raised later on somebody else's stack
                        # under a "decode thread failed" banner.
                        _error.append(thread_err)

                def _stream_dispatch(uid, kind, n_tokens, *, _q=job_q,
                                     _emit=_stream_emit, _flushed=stream_flushed):
                    if kind == 'flush':
                        # From here on this row is OWED an on_row, and the
                        # shutdown is what guarantees it gets one.
                        _flushed.add(uid)
                    if _q is not None:
                        _q.put((uid, kind, n_tokens))
                    else:
                        _emit(uid, kind, n_tokens)

                def _stream_shutdown(abandon, *, _streams=streams, _q=job_q,
                                     _box=decoder_box, _closed=stream_closed,
                                     _abandoned=stream_abandoned,
                                     _error=stream_error, _results=stream_results,
                                     _flushed=stream_flushed,
                                     _fatal=stream_fatal):
                    """Drain (or drop) the decoder thread, answer every row it
                    owes, and merge its results.

                    Idempotent, because it is called on the normal path, on the
                    stop path and from the bucket's exception handler.

                    IT MUST BE CALLED BEFORE THE NEXT BUCKET STARTS - see the
                    keyword-default note above for what a thread that outlives
                    its bucket would do. A join that times out therefore does not
                    merely log: it marks the call WEDGED, and the bucket loop
                    ends the whole call rather than starting a second generation
                    beside a thread that is still running.

                    ONE LATE ANSWER IS POSSIBLE, and only here. A wedged thread is
                    still inside one job, and `stream_abandoned` only stops it
                    taking the NEXT one - so that job can still fire an on_chunk
                    and an on_row for its row AFTER this method has raised and the
                    call has unwound. At most one row, only ever after the 600 s
                    timeout, and only for a row the caller has by then given up
                    on. The caller must therefore tolerate one late answer for a
                    row it has already failed (ignore it - never emit a second
                    item for that sentence). Killing the thread instead is not on
                    the table: it is mid-decode on a live mlx stream.
                    """
                    if not _streams or _closed:
                        return
                    _closed.append(True)
                    if abandon:
                        _abandoned.append(True)
                    if _q is not None and _box:
                        decoder = _box[0]
                        _q.put(None)
                        decoder.join(timeout=self.MLX_DECODE_JOIN_SECONDS)
                        if decoder.is_alive():
                            # WEDGED. Stop it taking any further row, and refuse
                            # to answer rows it may still be mid-way through -
                            # two on_rows for one row is worse than none. See the
                            # docstring: the one job it is inside can still land
                            # after this raise.
                            _abandoned.append(True)
                            _fatal.append(True)
                            raise RuntimeError(
                                f'Orpheus MLX stream decode thread still running '
                                f'after {self.MLX_DECODE_JOIN_SECONDS:.0f}s with '
                                f'{_q.qsize()} job(s) still queued '
                                f'({len(_streams)} streamed row(s))')
                    # Past the join the thread has exited, so `_results` and
                    # `results` each have exactly one writer and need no lock.
                    #
                    # EXACTLY ONCE, even when the thread died. A row whose flush
                    # was dispatched is owed an on_row; if the worker fell over
                    # (or was abandoned) before reaching it, nothing else will
                    # ever answer it and the caller would wait forever. Answer
                    # those here as failures, loudly.
                    owed = [uid for uid in _flushed if _streams[uid] not in _results]
                    for uid in sorted(owed, key=lambda u: _streams[u]):
                        i = _streams[uid]
                        print(f'[ORPHEUS][STREAM] row {i} was never finished by the '
                              f'decode thread; reporting it as a failure',
                              file=sys.stderr, flush=True)
                        _results[i] = None
                        if on_row is not None:
                            on_row(i, None)
                    for idx, audio in _results.items():
                        results[idx] = audio
                    if _error:
                        # The decoder thread died on its own machinery. Every row
                        # it owed has just been answered by the sweep above, so
                        # nothing is left hanging - but this is NOT a per-bucket
                        # condition: the thread is gone, and every later bucket
                        # would silently fall back to answering all of its
                        # streamed rows as failures. So mark the call fatal
                        # BEFORE raising.
                        _fatal.append(True)
                        raise _error[0]

                if job_q is not None:
                    # Imported HERE for the same reason as queue above.
                    import threading as _threading
                    decoder_box.append(_threading.Thread(
                        target=_stream_worker, daemon=True,
                        name='orpheus-mlx-stream-decode'))
                    decoder_box[0].start()

                # 0.31.3: next() returns (prompt_responses, generation_responses),
                # so `while responses := bg.next()` would NEVER terminate.
                # next_generated() yields just the generation list and returns
                # empty once every row has retired.
                while responses := bg.next_generated():
                    for r in responses:
                        if r.finish_reason != 'stop':  # stop token (128258) is dropped
                            out[r.uid].append(r.token)
                            # Fast start: ask the emitter the INSTANT a whole
                            # payload plus its right context exists, so the MLX
                            # latency is the vLLM latency (6 frames to the first
                            # chunk, 4 thereafter). Pacing this at fixed
                            # multiples of 28 tokens instead would put every
                            # payload up to 4 frames late and the FIRST one at 8
                            # frames - a third of a second of the half-second
                            # budget fast start has, given away for nothing.
                            #
                            # Reading emitters[uid].emitted_frames across threads
                            # is a benign int read: only the decoder thread ever
                            # writes it, only this thread reads it, and CPython
                            # publishes the attribute atomically. A value one
                            # cadence stale can only cause a REDUNDANT dispatch
                            # (the emitter then emits nothing and returns), never
                            # a missed or duplicated payload.
                            #
                            # The high-water mark is what keeps that cheap. Once
                            # `len(out) >= need` the condition STAYS true on every
                            # later token until the decoder actually advances
                            # emitted_frames - so a lagging decoder would be sent
                            # one no-op job per token per row, and the row's FLUSH
                            # would then queue behind all of them. Dispatching
                            # only when emitted_frames has moved since the last
                            # dispatch bounds it to one job per cadence per row,
                            # with no added latency.
                            if r.uid in streams:
                                ef = emitters[r.uid].emitted_frames
                                need = ((ef + PAYLOAD_FRAMES + RIGHT_CONTEXT_FRAMES)
                                        * TOKENS_PER_FRAME)
                                if len(out[r.uid]) >= need and last_dispatch_ef[r.uid] != ef:
                                    last_dispatch_ef[r.uid] = ef
                                    _stream_dispatch(r.uid, 'push', len(out[r.uid]))
                        # A row reports finish_reason ('stop' or the 'length' cap)
                        # exactly once, on its LAST response, before BatchGenerator
                        # drops it from the live set - so its token list is final
                        # here and it can be resolved (and handed to on_row) now
                        # rather than after the slowest row of the batch. `pending`
                        # keeps that a promise, not an assumption: exactly once.
                        if r.finish_reason is not None and r.uid in pending:
                            pending.discard(r.uid)
                            i, ptoks, clean, _budget = row_by_uid[r.uid]
                            if r.uid in streams:
                                # Streamed: flush the tail, then on_row - both from
                                # the decoder thread. No _resolve_mlx_row, because
                                # its cap ladder re-renders and this row's audio is
                                # already out the door.
                                _stream_dispatch(r.uid, 'flush', len(out[r.uid]))
                            else:
                                results[i] = self._resolve_mlx_row(i, ptoks, clean, out[r.uid], depth)
                                if on_row is not None:
                                    on_row(i, results[i])
                    # Once per decode step - a dict lookup against a forward pass over
                    # the whole batch. Rows that retired above are already delivered;
                    # the rest are abandoned unresolved.
                    if should_stop is not None and should_stop():
                        stopped = True
                        break
                bg.close()
                if stopped:
                    # Drain, do NOT abandon: anything already queued is the flush
                    # of a row that genuinely retired before the stop arrived, and
                    # those rows stay delivered (the same promise the non-streamed
                    # abandon path makes). Streamed rows still generating were
                    # never dispatched a flush, so they get no on_row at all -
                    # the "not rendered" contract.
                    _stream_shutdown(False)
                    # stderr, not stdout: the streaming worker's stdout IS the
                    # JSON-lines protocol, and this line lands mid-batch.
                    print(f"[ORPHEUS] MLX batch abandoned on request "
                          f"({len(pending)} of {len(bucket)} rows unrendered)",
                          file=sys.stderr, flush=True)
                    break
                # Anything that never reported a finish_reason (shouldn't happen)
                # still gets resolved - and emitted - exactly once.
                for (i, ptoks, clean, _budget), uid in zip(bucket, uids):
                    if uid not in pending:
                        continue
                    pending.discard(uid)
                    if uid in streams:
                        _stream_dispatch(uid, 'flush', len(out[uid]))
                        continue
                    results[i] = self._resolve_mlx_row(i, ptoks, clean, out[uid], depth)
                    if on_row is not None:
                        on_row(i, results[i])
                _stream_shutdown(False)
            except Exception as e:
                print(f"Orpheus._generate_mlx_batch_audio() bucket error: {e}")
                import traceback
                traceback.print_exc()
                if _stream_shutdown is not None:
                    try:
                        # The thread must never outlive its bucket, whatever
                        # killed it - and after a bucket failure the state it
                        # would decode from is not trustworthy, so abandon.
                        _stream_shutdown(True)
                    except Exception as shutdown_err:
                        print('Orpheus._generate_mlx_batch_audio() stream shutdown '
                              f'also failed: {shutdown_err}')
                if stream_fatal:
                    # TWO conditions end the whole call rather than this bucket:
                    #  - a decoder thread that would not join is STILL RUNNING and
                    #    still holds this bucket's queue, emitters and mlx stream,
                    #    so starting the next bucket would run a second generation
                    #    beside it, over the same model;
                    #  - a decoder thread that DIED on its own machinery is gone
                    #    for good, so every later bucket would answer all of its
                    #    streamed rows as failures, one silent bucket at a time.
                    # Either way the caller's per-item recovery re-renders what is
                    # missing. `raise` re-raises whatever brought us here, which
                    # names the real first cause.
                    raise
        # No mx.clear_cache(): the cache is bounded at load (set_cache_limit),
        # and flushing per read-ahead batch just forces cold re-allocation.
        return results

    # ---- the audiobook batch (writes files) ---------------------------------

    def _mlx_rerender_capped(self, idx: int, clean: str, ptoks: list, tokens: list,
                             cap: int, gap) -> bool:
        """A row that hit the token cap without finishing: keep the runaway, then
        re-render it split at sentence boundaries. MAIN THREAD ONLY - it runs the
        model (_generate_mlx_safe), which must never overlap a live BatchGenerator.

        `cap` is THIS ROW's max_tokens, which is the batch depth on the fresh-group
        path and min(MLX_MAX_TOKENS, the row's own budget) on the continuous one.
        It is only recorded as evidence (`token_cap`), never re-derived.

        Keeping the capped take first is the point (see _keep_reject): the
        re-render is about to replace the only recording of the failure.
        force_split: the cap hit is PROVEN, so skip the whole re-render
        _generate_mlx_safe would otherwise try first.
        """
        print(f"Orpheus: sentence {idx} hit the MLX audio-token cap; re-rendering split at sentence boundaries")
        try:
            capped = self._mlx_row_audio(ptoks, tokens)
            if capped is not None and len(capped) == 0:
                capped = None
        except Exception:
            capped = None
        self._keep_reject(idx, clean, capped, 'cap',
                          {'tokens_emitted': len(tokens),
                           'token_cap': cap,
                           'backend': 'mlx'})
        audio = self._generate_mlx_safe(clean, force_split=True)
        return self._save_audio(idx, audio, gap[0], gap[1])

    def _mlx_resplit_deferred(self, idx: int, clean: str, gap, reason: str) -> bool:
        """The re-render half of _guard_truncation, run after the batch for a row
        whose VERDICT (_needs_resplit) was taken during it. MAIN THREAD ONLY.

        Identical work to _guard_truncation's own tail - same force_split ladder,
        same ratchet on a 'short' verdict, and the detection log line already fired
        inside _needs_resplit where the failure was seen. MLX sibling of the vLLM
        path's _render_deferred_resplits, minus the pooling: on MLX the re-render
        is a single-sequence render either way.
        """
        audio = self._generate_mlx_safe(clean, force_split=True)
        if reason == 'short':
            self._ratchet_after_resplit(clean, audio)
        return self._save_audio(idx, audio, gap[0], gap[1])

    def _mlx_generate_rows(self, rows: list, caps: list, *, depth: int, width: int,
                           prefill: int, results: dict, group_no: int,
                           group_count: int, continuous: bool) -> int:
        """Run ONE mlx_lm.BatchGenerator over `rows`, filling `results` in place.
        Returns the number of generation steps taken.

        THE ONE GENERATION LOOP. Both _convert_mlx_batch paths call this: the
        fresh-group path once per group (width == prefill == len(rows), one group
        of many), the continuous path once for the whole call (width from the
        memory rule, prefill from MLX_CONTINUOUS_PREFILL, rows far exceeding the
        width so mlx-lm's scheduler refills retired slots from its own queue).
        Factored so the two cannot drift apart - the heartbeat, the decode-overlap
        hand-off, `deferred`, the join and the main-thread deferred pass are
        literally the same code.

        rows:  [(sentence_index, prompt_tokens, (clean_text, gap), token_budget)]
        caps:  per-row max_tokens, aligned to `rows`. Group path: `depth` for every
               row (identical to BatchGenerator's own default, so that path is
               unchanged). Continuous: min(MLX_MAX_TOKENS, that row's budget), so
               the anti-runaway ceiling stays PER ROW even though every row now
               shares one generator - and the cap-hit test after retirement
               compares against THAT row's cap, never the batch depth.

        Raises on a generation-phase failure; the caller owns the per-item
        convert() recovery for the rows it left without a result.
        """
        import time as _time

        import mlx.core as mx
        from mlx_lm.generate import BatchGenerator
        from mlx_lm.sample_utils import make_sampler
        # The repetition penalty is minted by the fast path's factory rather than
        # make_logits_processors: same mlx-lm closure, plus the marker the batched
        # step reads (penalty, window) off. Identical on a stock model.
        from .mlx_fastpath import make_rep_penalty

        n_rows = len(rows)
        bg = BatchGenerator(
            self.mlx_model,
            max_tokens=depth,
            # 0.31.3: stop SEQUENCES, not a set of ints - a set iterates
            # without raising and silently fails to stop.
            stop_tokens=[[self.END_OF_AUDIO_TOKEN]],
            sampler=make_sampler(self._voice_cap('temperature'),
                                 top_p=self._voice_cap('topP'),
                                 min_p=self._voice_cap('minP')),
            logits_processors=[make_rep_penalty(
                self._voice_cap('repPenalty'), self.MLX_REP_WINDOW)],
            completion_batch_size=width,
            prefill_batch_size=prefill,
        )
        # Row slot 2 here is (clean_text, gap) - NOT the bare string the
        # other call site carries. len(c) on the tuple is 2, which floors
        # `expected` at 300 and fired the boost at ~600 tokens on EVERY
        # row (measured 2026-08-21: 46/46 chunks truncated to ~7s at
        # 40-60 ch/s before this line said c[0]).
        boosts = [self._mlx_eos_boost_processor(len(c[0])) for _, _, c, _ in rows]
        if any(boosts):
            rep = [make_rep_penalty(
                self._voice_cap('repPenalty'), self.MLX_REP_WINDOW)]
            uids = bg.insert(
                [list(p) for _, p, _, _ in rows],
                max_tokens=list(caps),
                logits_processors=[rep + [b] if b else list(rep) for b in boosts])
        else:
            uids = bg.insert([list(p) for _, p, _, _ in rows],
                             max_tokens=list(caps))
        out = {u: [] for u in uids}
        # uids come back in insert order == row order. In the continuous path that
        # is QUEUE order, not the order rows start generating in - every lookup
        # below goes through these maps, never through position.
        row_by_uid = dict(zip(uids, rows))     # uid -> row
        cap_by_uid = dict(zip(uids, caps))     # uid -> that row's token cap
        pending = set(uids)                    # rows not yet handed off

        # ---- decode overlap -------------------------------------
        #
        # See MLX_DECODE_OVERLAP. A row retires the moment its
        # finish_reason lands; handing it to ONE decoder thread there
        # buys back the ~80 s the serial post-batch loop used to spend
        # with generation stopped. The thread does the CHEAP half only
        # - SNAC decode, the truncation VERDICT (_needs_resplit), the
        # FLAC write - and defers every row that would need the MODEL
        # back to the main thread, which runs them after bg.close().
        # So _generate_mlx_safe is NEVER called next to a live
        # BatchGenerator and that path's memory profile is unchanged.
        deferred = []        # (idx, clean, gap, kind, ptoks, tokens, cap, err)
                             # kind: 'cap' | 'short' | 'empty' | 'error'
        worker_results = {}  # written ONLY by the decoder thread
        worker_error = []
        abandoned = []       # non-empty => stop after the current row
        row_q = None
        decoder = None
        overlap = bool(self.MLX_DECODE_OVERLAP)
        decode_stream = self._mlx_decode_stream() if overlap else None
        if overlap and decode_stream is None:
            # No cross-thread stream on this mlx: decoding on the
            # generation stream would just serialize behind it, which
            # is the thing being fixed. Say so and stay serial.
            print('[ORPHEUS] MLX decode overlap unavailable '
                  '(mlx.core.new_thread_unsafe_stream missing); '
                  'decoding serially after the batch', flush=True)
            overlap = False
        if not getattr(self, '_mlx_overlap_announced', False):
            self._mlx_overlap_announced = True
            print('[ORPHEUS] MLX decode overlap '
                  + ('ON: retired rows are decoded and written while the '
                     'batch keeps generating (ORPHEUS_MLX_DECODE_OVERLAP=0 '
                     'to disable)'
                     if overlap else
                     'OFF: rows are decoded serially after the batch'),
                  flush=True)

        def _finish_row_serially(idx, ptoks, clean, gap, tokens, cap):
            """ONE row, start to finish, on THIS thread - the whole
            kill-switch path, and the rescue path if the decoder
            thread dies. Model re-renders run inline, as they always
            did; every caller is the main thread."""
            try:
                if len(tokens) >= cap:
                    # Hit the token cap without finishing -> the audio
                    # would be clipped. Re-render split instead.
                    results[idx] = self._mlx_rerender_capped(
                        idx, clean, ptoks, tokens, cap, gap)
                    return
                audio = self._mlx_row_audio(ptoks, tokens)
                # Backstop a silent early-EOS truncation (clean stop,
                # audio too short for the text) the cap check can't
                # catch. force_split: a whole-chunk re-render would
                # just clean-EOS (truncated) again - the resplit must
                # actually split.
                audio = self._guard_truncation(
                    idx, clean, audio,
                    lambda c: self._generate_mlx_safe(c, force_split=True)
                )
                results[idx] = self._save_audio(idx, audio, gap[0], gap[1])
            except Exception as decode_err:
                print(f"Orpheus MLX batch decode error for sentence {idx}: {decode_err}")
                results[idx] = False

        def _decode_retired_row(idx, ptoks, clean, gap, tokens, cap):
            """ONE retired row on the DECODER THREAD. Everything here
            is model-free; anything that isn't goes on `deferred`."""
            if len(tokens) >= cap:
                # Cap hit -> a re-render, which is the model. Not here.
                deferred.append((idx, clean, gap, 'cap', ptoks, tokens, cap, None))
                return
            try:
                # mx.stream(): "Create a context manager to set the
                # default device and stream." Scheduling SNAC on our
                # own stream is the point - on the generation stream
                # the decode would queue behind the next forward pass.
                with mx.stream(decode_stream):
                    audio = self._mlx_row_audio(ptoks, tokens)
                # Only the VERDICT is taken here - _needs_resplit is
                # the decision half _guard_truncation was split into
                # for exactly this (its log line still fires here, at
                # detection). The re-render it implies is the model,
                # so it is deferred to the main thread.
                reason = self._needs_resplit(idx, clean, audio)
                if reason is not None:
                    deferred.append((idx, clean, gap, reason, ptoks, tokens, cap, None))
                    return
                worker_results[idx] = self._save_audio(idx, audio, gap[0], gap[1])
            except Exception as decode_err:
                # Fail this row, not the batch - and report it from the
                # main thread so the print order is deterministic.
                deferred.append((idx, clean, gap, 'error', ptoks, tokens, cap, decode_err))

        def _decode_worker():
            try:
                while True:
                    row = row_q.get()
                    if row is None:   # sentinel: the batch is over
                        return
                    if abandoned:
                        # The main thread gave up waiting and is
                        # re-rendering this bucket itself; writing more
                        # sentence files now would race it.
                        continue
                    _decode_retired_row(*row)
            except BaseException as thread_err:
                # A failure OUTSIDE a row (the thread's own machinery).
                # Recorded, never swallowed: the join below finishes
                # whatever is still queued on the main thread.
                worker_error.append(thread_err)

        if overlap:
            import queue as _queue
            import threading as _threading
            row_q = _queue.Queue()
            decoder = _threading.Thread(
                target=_decode_worker, daemon=True,
                name=f'orpheus-mlx-decode-{group_no}')
            decoder.start()

        # Heartbeat: a long MLX batch is otherwise SILENT for minutes, which
        # the BookForge worker watchdog reads as "stuck" and false-kills the
        # worker (its GENERATION_ACTIVITY_RE only knew vLLM's tqdm). Emit a
        # throttled liveness line carrying real progress - it keeps the
        # watchdog fresh AND is the ONLY thing the queue UI can draw a
        # within-batch progress bar from (the rendered files all land at
        # once when the batch ends, so the chunk bar is frozen until then).
        #
        # Payload, in the one order that keeps BOTH directions compatible:
        #   [ORPHEUS] MLX batch generating: 95 rows, ~1259 tokens
        #             (step 1260/3400), 12/95 rows done, batch 1/2
        # The leading "<N> rows, ~<T> tokens" is byte-identical to the old
        # line, so an OLD BookForge (whose regex ends there) still parses a
        # NEW fork; everything after is additive, so a NEW BookForge reads
        # the extra fields when they're there and degrades to token-only
        # progress when they aren't. `rows done` counts rows RETIRED
        # (finish_reason set - 'stop' or the 'length' cap), which each row
        # reports exactly once before BatchGenerator filters it out of the
        # live set: monotone, and exact at completion. step/depth is the
        # token-depth bound the width derivation used, so a fraction is
        # computable before any row has retired.
        #
        # The continuous path appends ONE more field, again additive and
        # again after everything that already existed:
        #   ..., batch 1/1 live 72
        # `live` is rows that have STARTED generating minus rows retired -
        # derived from the responses seen (a uid appears in a response only
        # once it is generating), not from BatchGenerator internals.
        #
        # Interval is 10 s: the line is now a UI progress source, not just a
        # liveness ping, and 10 s is under the "is it frozen?" threshold
        # while still costing ~36 log lines per 6-minute batch. The watchdog
        # (12 min) has an enormous margin either way.
        _step = 0
        _retired = 0
        _started = set()     # uids that have been seen generating at least once
        _HB_SECONDS = 10.0
        _last_hb = 0.0  # 0 -> the first generated step prints immediately
        # 0.31.3: next() returns (prompt_responses, generation_responses),
        # so `while responses := bg.next()` would never terminate.
        # next_generated() yields just the generation list and returns
        # empty once every row has retired AND the queue is drained.
        while responses := bg.next_generated():
            _step += 1
            for r in responses:
                _started.add(r.uid)
                if r.finish_reason != 'stop':  # stop token (128258) is dropped
                    out[r.uid].append(r.token)
                if r.finish_reason is not None:
                    # 'stop' (EOS matched) or 'length' (hit that row's
                    # max_tokens) - either way this row is done and won't be
                    # seen again, so out[uid] is FINAL here (the token above
                    # was its last) and the row can be decoded now instead of
                    # after the slowest row of the batch. `pending` keeps
                    # exactly-once a promise rather than an assumption.
                    _retired += 1
                    if overlap and r.uid in pending:
                        pending.discard(r.uid)
                        _idx, _ptoks, (_clean, _gap), _budget = row_by_uid[r.uid]
                        row_q.put((_idx, _ptoks, _clean, _gap, list(out[r.uid]),
                                   cap_by_uid[r.uid]))
            _now = _time.time()
            if _now - _last_hb >= _HB_SECONDS:
                _maxtok = max((len(v) for v in out.values()), default=0)
                _line = (f"[ORPHEUS] MLX batch generating: {n_rows} rows, "
                         f"~{_maxtok} tokens (step {_step}/{depth}), "
                         f"{_retired}/{n_rows} rows done, "
                         f"batch {group_no}/{group_count}")
                if continuous:
                    _line += f" live {len(_started) - _retired}"
                print(_line, flush=True)
                _last_hb = _now
        bg.close()
        if not overlap:
            # Kill-switch path: today's serial post-batch loop, in
            # row (== insert) order.
            for (idx, ptoks, (clean, gap), _budget), uid in zip(rows, uids):
                _finish_row_serially(idx, ptoks, clean, gap, out[uid], cap_by_uid[uid])
        else:
            # Anything that never reported a finish_reason (shouldn't
            # happen) still has to be handed over - exactly once.
            for (idx, ptoks, (clean, gap), _budget), uid in zip(rows, uids):
                if uid in pending:
                    pending.discard(uid)
                    row_q.put((idx, ptoks, clean, gap, list(out[uid]), cap_by_uid[uid]))
            row_q.put(None)   # drain what's queued, then exit
            decoder.join(timeout=self.MLX_DECODE_JOIN_SECONDS)
            if decoder.is_alive():
                # WEDGED. A partial batch must never be returned as a
                # whole one, so raise and let the bucket recovery in the
                # caller re-render these rows per item - naming what is
                # stuck. `abandoned` stops the thread taking any FURTHER
                # row, so the overlap with the recovery is one in-flight
                # row at worst (both takes are valid audio for the same
                # text).
                abandoned.append(True)
                raise RuntimeError(
                    f'Orpheus MLX decode thread still running after '
                    f'{self.MLX_DECODE_JOIN_SECONDS:.0f}s with {row_q.qsize()} '
                    f'row(s) still queued (batch {group_no}/{group_count}, '
                    f'{n_rows} rows)')
            # Merged AFTER the join, so `results` has exactly one writer
            # at a time and needs no lock. (worker_results is written
            # only by a thread that has now exited.)
            results.update(worker_results)
            if worker_error:
                # The thread died on its own machinery rather than on a
                # row. Whatever it never dequeued is still queued -
                # finish it here rather than lose it.
                print(f'Orpheus: MLX decode thread failed ({worker_error[0]}); '
                      f'finishing {row_q.qsize()} remaining row(s) on the main thread')
                while True:
                    try:
                        row = row_q.get_nowait()
                    except Exception:
                        break
                    if row is not None:
                        _finish_row_serially(*row)

        # Everything the decoder thread refused, on the MAIN thread,
        # exactly as the serial loop would have done it - so the
        # single-sentence model path never overlaps a BatchGenerator.
        # Sorted by sentence index, not retirement order, so the
        # re-renders (and the rate ratchet they can raise) land in the
        # same order the serial loop would have run them in.
        for _idx, _clean, _gap, _kind, _ptoks, _tokens, _cap, _err in sorted(
                deferred, key=lambda row: row[0]):
            try:
                if _kind == 'cap':
                    results[_idx] = self._mlx_rerender_capped(
                        _idx, _clean, _ptoks, _tokens, _cap, _gap)
                elif _kind == 'error':
                    print(f"Orpheus MLX batch decode error for sentence {_idx}: {_err}")
                    results[_idx] = False
                else:
                    results[_idx] = self._mlx_resplit_deferred(
                        _idx, _clean, _gap, _kind)
            except Exception as deferred_err:
                print(f"Orpheus MLX batch decode error for sentence {_idx}: {deferred_err}")
                results[_idx] = False
        return _step

    def _convert_mlx_batch(self, items: list) -> list:
        """Batched MLX decode via mlx_lm.BatchGenerator (Mac).

        items: list of (sentence_index, sentence). Returns list[bool] aligned to items.

        Mirrors the vLLM batch path - same per-item clean / _classify_gap /
        _write_silence handling and _save_audio finalize (so inter-sentence and
        paragraph pauses are preserved) - but drives ONE continuous-batching
        generate over the whole chunk instead of len(chunk) single-prompt calls.

        mlx_lm.BatchGenerator handles padding, a per-row BatchKVCache, and per-row
        stop tokens; insert() takes pre-tokenized prompts, which Orpheus needs
        (custom special-token prompts, not plain text). Audio is then reconstructed
        per row exactly as llama.py generate() does for the non-streaming path:
        parse_output(prompt+generated) -> decode_audio_from_codes.

        Memory (measured on M1 Ultra 64 GB, Jul 2026): weights ~6.9 GB, plus KV at
        a MEASURED 0.1147 MB per generated token per row - so peak scales with
        width x DEPTH, not with width alone. On top of that the allocator's buffer
        CACHE would grow unbounded (~46 GB over one chunk) if not limited -
        bounded once at load via mx.set_cache_limit (_load_mlx_engine), NOT by
        per-chunk flushes.

        Throughput is bought by BATCH WIDTH: 12.4 sent/min at B=16 -> 27-28 at
        B=96 (the knee; B=128 is slower). `items` is one batch_pool_size chunk.
        Either way the rows GENERATING at once never exceed _mlx_width_for_depth.

        Row scheduling is the one thing MLX_CONTINUOUS changes; both paths run
        through _mlx_generate_rows, which is the only place a BatchGenerator is
        built and driven.
        """
        try:
            import mlx.core as mx

            results = {}
            sentence_by_idx = dict(items)  # for per-item retry on a bucket failure
            gen = []  # (idx, prompt_tokens, (clean_text, gap), token_budget)
            for idx, sentence in items:
                gap = self._classify_gap(sentence)
                clean = self._clean_sentence_for_tts(sentence)
                if not clean:
                    results[idx] = self._write_silence(idx)
                else:
                    # prepare_input_ids prepends "voice: " itself; pass voice, not a
                    # pre-formatted string. Single-string call returns a [1, T] array.
                    ptoks = self.mlx_model.prepare_input_ids(clean, self.voice)[0].tolist()
                    gen.append((idx, ptoks, (clean, gap), self._mlx_token_budget(clean)))

            # HOW THE ROWS ARE SCHEDULED - the one thing MLX_CONTINUOUS changes.
            #
            # Fresh groups (ORPHEUS_MLX_CONTINUOUS=0, the default): consecutive
            # BOOK-ORDER slices whose width is capped against the MLX memory budget
            # from their own token depth (_mlx_batch_groups), each its own
            # BatchGenerator run to completion.
            #
            # Continuous: ONE BatchGenerator over every row of the call, width from
            # the same memory rule, and mlx-lm's own scheduler refills a retired
            # slot from the queue on the next step. See the MLX_CONTINUOUS block
            # for why this LOSES - extend() left-pads a refilled row to the oldest
            # live row's context.
            #
            # No length bucketing in either: mlx-lm 0.31.3 right-pads batch
            # prefills, so a short heading batched next to packed prose is safe.
            if not gen:
                # Every sentence in the call was empty; _write_silence has already
                # answered for all of them.
                pass
            elif self.MLX_CONTINUOUS:
                depth = min(self.MLX_MAX_TOKENS, max(e[3] for e in gen))
                # steady=True: continuous batching holds width x depth for the whole
                # run, so the width is derived from the MEASURED peak per row, not
                # the arithmetic cache size the group path can afford to use.
                width = self._mlx_width_for_depth(depth, steady=True)
                prefill = max(1, min(width, self.MLX_CONTINUOUS_PREFILL))
                # Per-row anti-runaway ceiling. One generator now carries rows of
                # very different lengths, so the cap CANNOT be the batch's depth -
                # it is each row's own budget, handed to insert() as a list, and
                # the cap-hit test after retirement compares against that.
                caps = [min(self.MLX_MAX_TOKENS, e[3]) for e in gen]
                if not getattr(self, '_mlx_continuous_announced', False):
                    self._mlx_continuous_announced = True
                    steady_gb = (self.MLX_WEIGHTS_GB
                                 + float(os.environ.get('ORPHEUS_MLX_CACHE_LIMIT_GB', '8'))
                                 + width * depth * self.MLX_KV_MB_PER_TOKEN_ROW_STEADY / 1024.0)
                    print(f'[ORPHEUS] MLX continuous batching ON: width {width}, '
                          f'prefill {prefill}, {len(gen)} rows queued, projected '
                          f'steady state {steady_gb:.1f} GB of the '
                          f'{self.MLX_MEM_BUDGET_GB:g} GB budget '
                          f'(ORPHEUS_MLX_CONTINUOUS=0 for fresh groups)', flush=True)
                try:
                    steps = self._mlx_generate_rows(
                        gen, caps, depth=depth, width=width, prefill=prefill,
                        results=results, group_no=1, group_count=1, continuous=True)
                    # mx.get_peak_memory() is the PROCESS high-water mark, not a
                    # per-call figure, and it is deliberately not reset: the
                    # question this experiment has to answer is whether continuous
                    # batching ever exceeded the 45 GB budget over the whole book.
                    print(f'[ORPHEUS] MLX continuous batch done: {len(gen)} rows, '
                          f'{steps} steps, peak {mx.get_peak_memory() / 1e9:.1f} GB',
                          flush=True)
                except Exception as bucket_err:
                    # A generation-phase failure (BatchGenerator/insert/next) must
                    # not drop the call's rows: retry per item via convert(),
                    # exactly as the group path does for one bucket.
                    print(f"Orpheus._convert_mlx_batch() bucket error: {bucket_err}")
                    import traceback
                    traceback.print_exc()
                    for idx, _ptoks, _payload, _budget in gen:
                        if idx not in results:
                            results[idx] = self.convert(idx, sentence_by_idx[idx])
            else:
                if not getattr(self, '_mlx_continuous_announced', False):
                    self._mlx_continuous_announced = True
                    print('[ORPHEUS] MLX continuous batching OFF: fresh groups',
                          flush=True)
                groups = self._mlx_batch_groups(gen)
                for group_no, (bucket, depth) in enumerate(groups, 1):
                    try:
                        # Uniform cap == BatchGenerator's own max_tokens default,
                        # so this path is byte-for-byte what it was.
                        self._mlx_generate_rows(
                            bucket, [depth] * len(bucket), depth=depth,
                            width=len(bucket), prefill=len(bucket),
                            results=results, group_no=group_no,
                            group_count=len(groups), continuous=False)
                    except Exception as bucket_err:
                        # A generation-phase failure (BatchGenerator/insert/next)
                        # for ONE bucket must not kill the others. Mirror the outer
                        # batch-level recovery at bucket granularity: retry this
                        # bucket's rows per item via convert() rather than dropping
                        # them.
                        print(f"Orpheus._convert_mlx_batch() bucket error: {bucket_err}")
                        import traceback
                        traceback.print_exc()
                        for idx, _ptoks, _payload, _budget in bucket:
                            if idx not in results:
                                results[idx] = self.convert(idx, sentence_by_idx[idx])

            # NO mx.clear_cache() / _cleanup_memory() here. The buffer cache is
            # bounded once at load (_load_mlx_engine sets mx.set_cache_limit), so
            # the footprint stays flat without flushing; a per-chunk flush forces
            # every next chunk to re-allocate cold from Metal (measured ~3% slower
            # at batch 96, and it HID the real problem: the cache ballooned to
            # ~46 GB DURING each chunk, between the flushes).
            return [results.get(idx, False) for idx, _ in items]
        except Exception as e:
            print(f'Orpheus._convert_mlx_batch() error: {e}')
            import traceback
            traceback.print_exc()
            # A batch-level failure shouldn't lose the whole chunk - retry per item.
            return [self.convert(idx, s) for idx, s in items]
