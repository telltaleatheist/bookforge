"""The vLLM backend: engine construction, the batch/solo generation ladders and
fast-start streaming.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _VllmStreamRow (169)                   _load_vllm_engine (1581)
  _generate_tokens_vllm (3287)           _generate_audio_vllm_safe (3309)
  _generate_parts_batched (3363)         _absorb_stream_tokens (3537)
  _vllm_frame_decoder (3568)             _generate_batch_stream_vllm (3582)
  _emit_vllm_stream (3805)               _retire_vllm_stream_row (3833)
  _render_deferred_resplits (4683)       the vLLM half of convert_batch (4726)

The CUDA/vLLM platform environment is applied at IMPORT of this module (see
cuda_env), which is exactly when e2a applied it: lib/conf.py at `import
lib.conf`, and orpheus.py's own block at `import ...orpheus`. torch and vllm are
imported LAZILY inside the functions, so importing this module on a machine with
neither still works - and that is what makes `narrator.engine` importable on the
Windows test interpreter.
"""
import time as _time

import numpy as np

from . import cuda_env
from .errors import TokenStreamMisaligned, is_fatal_cuda_error
from .snac import (PAYLOAD_FRAMES, RIGHT_CONTEXT_FRAMES, TOKENS_PER_FRAME,
                   WindowedFrameEmitter)
from ..log import log

# Same platform conditions, same values, same ordering-before-torch as e2a.
cuda_env.apply()
cuda_env.apply_vllm_platform()


class _VllmStreamRow:
    """One in-flight vLLM request during a fast-start batch (2026-09-04).

    Pure state, no behaviour: _absorb_stream_tokens fills it and
    _retire_vllm_stream_row empties it. It exists because the streaming loop
    drives LLMEngine.step() directly instead of LLM.generate(), so nothing else
    is keeping the per-request bookkeeping any more.

    `raw_tokens` is EVERY generated token in order, which is exactly what
    `out.outputs[0].token_ids` would have handed the non-streaming ladder at the
    end - so a non-streamed row's decode/guard/resplit behaviour is unchanged by
    the fact that it arrived a step at a time.

    `audio_tokens` is the streamed row's separate, FILTERED view: SNAC codes
    only, EOS and anything out of the audio range dropped, because the windowed
    decoder slices it at exact multiples of 7 and a stray token would shift
    every later frame (the misalignment _redistribute_codes exists to catch).

    `consumed` tracks how much of the CUMULATIVE token_ids has already been
    folded in - vLLM 0.7.3 defaults SamplingParams.output_kind to CUMULATIVE, so
    every step re-sends the whole list and only the tail is new.
    """
    __slots__ = ('index', 'clean', 'voice', 'request_id', 'streamed',
                 'consumed', 'raw_tokens', 'audio_tokens', 'eos_seen',
                 'emitter', 'chunks', 'failed', 'retired')

    def __init__(self, index, clean, voice, request_id, streamed):
        self.index = index
        self.clean = clean
        self.voice = voice
        self.request_id = request_id
        self.streamed = streamed
        self.consumed = 0
        self.raw_tokens = []
        self.audio_tokens = []
        self.eos_seen = False
        self.emitter = None
        self.chunks = []
        self.failed = False
        self.retired = False


class VllmBackendMixin:

    # ---- load ---------------------------------------------------------------

    def _load_vllm_engine(self):
        """Load model using vLLM backend."""
        import gc
        import os
        import platform
        import random

        import torch
        # BETWEEN the two imports on purpose: the cudart lookup needs torch (to
        # find the DLL beside it) and vLLM needs the env var it sets (it reads
        # VLLM_CUDART_SO_PATH as it loads). orpheus.py did this at module scope
        # because it imported torch at module scope; narrator does not, so the
        # one statement that needs torch happens here instead. Windows-only and
        # a no-op when VLLM_CUDART_SO_PATH is already set. See cuda_env.
        cuda_env.resolve_vllm_cudart()
        from vllm import LLM
        from transformers import AutoTokenizer

        is_windows = platform.system() == 'Windows'

        # Clear any leftover CUDA state from previous failed attempts
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            gc.collect()

        # On Windows, use random port to avoid ZMQ port conflicts between workers
        if is_windows:
            # Use random port in high range to avoid conflicts
            random_port = random.randint(40000, 50000)
            os.environ['VLLM_RPC_PORT'] = str(random_port)

        log(f"Loading Orpheus model with vLLM: {self.TRANSFORMERS_MODEL}")

        # Load tokenizer (needed for prompt formatting with special tokens)
        self.tokenizer = AutoTokenizer.from_pretrained(self.TRANSFORMERS_MODEL)

        # On Windows, CUDA graph capture can fail. Check env var to override behavior.
        # Set ORPHEUS_DISABLE_EAGER=1 to try CUDA graphs (faster if it works)
        # Set ORPHEUS_FORCE_EAGER=1 to always use eager mode (slower but stable)
        force_eager = os.environ.get('ORPHEUS_FORCE_EAGER', '0') == '1'
        disable_eager = os.environ.get('ORPHEUS_DISABLE_EAGER', '0') == '1'

        if disable_eager:
            use_eager = False
            log("Orpheus: CUDA graphs ENABLED (ORPHEUS_DISABLE_EAGER=1)")
        elif force_eager or is_windows:
            use_eager = True
            log("Orpheus: Using eager mode (no CUDA graphs) for Windows compatibility")
        else:
            use_eager = False

        # Clean up CUDA state before vLLM initialization
        # This helps prevent CUDA graph capture failures caused by prior CUDA operations
        if torch.cuda.is_available():
            gc.collect()
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
            # Reset CUDA context to clean state
            torch.cuda.reset_peak_memory_stats()
            log("Orpheus: CUDA state cleaned before vLLM init")

        # gpu_memory_utilization: fraction of TOTAL VRAM vLLM reserves for weights
        # + KV cache. Default 0.70 (not 0.85) because on a desktop the GPU is SHARED
        # with the Windows compositor / browser / Electron GPU process. At 0.85 vLLM
        # grabs ~20.4 GiB of 24, leaving too little for the desktop - and when VRAM
        # is oversubscribed the WDDM driver spills GPU memory into SYSTEM RAM, which
        # thrashes and maxes both (observed: hard OOM crash). 0.70 ~= 16.8 GiB still
        # leaves ample KV cache for batched Orpheus (weights are only ~6.2 GiB).
        # Override with ORPHEUS_GPU_MEM_UTIL for headless / dedicated-GPU machines.
        gpu_mem_util = float(os.environ.get('ORPHEUS_GPU_MEM_UTIL', '0.70'))
        log(f"Orpheus: vLLM gpu_memory_utilization={gpu_mem_util}")
        # dtype: the fine-tune checkpoints are bfloat16; the old hardcoded
        # "float16" forced a lossy cast on load. A/B'd 2026-07-12: bf16 is
        # AUDIBLY clearer / less muffled (Owen: "significantly... a keeper")
        # even though the >8kHz RMS delta measured only 0.6dB. Same VRAM and
        # speed; Ampere+ runs bf16 natively (pre-Ampere would need the env
        # override back to float16). ORPHEUS_VLLM_DTYPE overrides.
        vllm_dtype = os.environ.get('ORPHEUS_VLLM_DTYPE', 'bfloat16')
        log(f"Orpheus: vLLM dtype={vllm_dtype}")
        # Multi-LoRA is an ENGINE-CONSTRUCTION property - it cannot be turned on for a
        # later request - so it is set here, for this session, from the session's own
        # base key. A session with no base_dir (stock from the HF cache, or a merged
        # fine-tune) builds exactly the engine it always did.
        #
        # Keyed on base_dir, NOT adapter_dir: a stock-from-local-base session names the
        # base and no adapter, and it must still build LoRA-capable, because that is
        # what lets the resident streaming server add an adapter voice to a warm stock
        # engine (and vice-versa) without a 6 GB reload.
        lora_kwargs = {}
        if self.base_dir:
            lora_kwargs = dict(
                enable_lora=True,
                max_lora_rank=self.LORA_MAX_RANK,
                max_loras=self.LORA_MAX_LORAS,
                max_cpu_loras=self.LORA_MAX_CPU_LORAS,
            )
            log(f"Orpheus: vLLM multi-LoRA enabled (max_lora_rank={self.LORA_MAX_RANK}, "
                  f"max_loras={self.LORA_MAX_LORAS}, max_cpu_loras={self.LORA_MAX_CPU_LORAS})")
        engine = LLM(
            model=self.TRANSFORMERS_MODEL,
            dtype=vllm_dtype,
            max_model_len=4096,
            gpu_memory_utilization=gpu_mem_util,
            enforce_eager=use_eager,
            **lora_kwargs,
        )
        self._device = 'cuda'
        return engine

    def _load_snac(self):
        """Load the SNAC audio decoder (not needed for MLX - it handles decoding
        internally).

        It lives in this module rather than snac.py because it is the TORCH SNAC
        loader, and both torch backends use it: load_engine calls it after
        _load_vllm_engine AND after _load_transformers_engine. Same placement
        relative to its callers as e2a's (orpheus.py:1554)."""
        import torch
        if self.backend == 'mlx':
            return None  # MLX handles SNAC internally

        if self.snac_model is not None:
            return self.snac_model

        try:
            from snac import SNAC
            log("Loading SNAC audio decoder...")

            # Determine device
            if torch.cuda.is_available():
                self._device = 'cuda'
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                self._device = 'mps'
            else:
                self._device = 'cpu'

            self.snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").to(self._device)
            self.snac_model.eval()
            log(f"SNAC loaded on {self._device}")
            return self.snac_model
        except Exception as e:
            raise ValueError(f"Failed to load SNAC decoder: {e}")

    # ---- generation ---------------------------------------------------------

    def _generate_tokens_vllm(self, prompt: str, max_tokens: int = None) -> list:
        """Generate audio tokens using vLLM backend."""
        from vllm import TokensPrompt
        if max_tokens is None:
            max_tokens = self.MAX_AUDIO_TOKENS

        # Feed token IDs directly (no decode->re-tokenize round-trip; see _format_prompt_ids)
        prompt_ids = self._format_prompt_ids(prompt)

        sampling_params = self._vllm_sampling_params(len(prompt), max_tokens)

        outputs = self.engine.generate([TokensPrompt(prompt_token_ids=prompt_ids)], sampling_params,
                                       lora_request=self._lora_request())
        tokens = list(outputs[0].outputs[0].token_ids)

        # Truncate at end-of-audio token if present
        if self.END_OF_AUDIO_TOKEN in tokens:
            end_idx = tokens.index(self.END_OF_AUDIO_TOKEN)
            tokens = tokens[:end_idx]

        return tokens

    def _generate_audio_vllm_safe(self, clean: str, depth: int = 0, force_split: bool = False,
                                  voice: str = None):
        """Render audio for `clean`; if the model hits the token cap before emitting the
        end-of-audio token (the chunk is too long to finish), split it at the nearest
        sentence/space boundary and render each half, concatenating the audio. Recurses
        up to a small depth so even an unusually dense chunk produces complete,
        un-clipped audio. Returns a numpy waveform (same as _tokens_to_audio).

        force_split=True skips the whole-chunk render and splits IMMEDIATELY. The
        truncation _guard_truncation detects is a CLEAN early EOS - a whole-chunk
        re-render would very likely EOS cleanly (and truncated) again, and the
        `finished` accept below would return it without ever splitting: a re-roll,
        not a fix. Forcing the split renders half-length parts well inside the
        reliable zone. Parts recurse WITHOUT force_split (the normal cap logic
        applies to them); text that can't be split (parts < 2) falls through to a
        normal render.

        `voice` (default: this instance's voice) selects the prompt token, the
        sampling caps AND the adapter, so a mixed-voice batch's per-row retakes
        re-render in the row's OWN voice. Every recursion carries it: a retake that
        silently dropped back to the default voice would swap the narrator
        mid-sentence, on exactly the rows that already needed help.
        """
        from vllm import TokensPrompt
        if voice is None:
            voice = self.voice
        if force_split:
            parts = self._split_long_text(clean, max_length=max(60, len(clean) // 2))
            if len(parts) >= 2:
                return np.concatenate(self._generate_parts_batched(parts, depth + 1, voice))
        sampling_params = self._vllm_sampling_params(len(clean), voice=voice)
        prompt = TokensPrompt(prompt_token_ids=self._format_prompt_ids(clean, voice))
        # lora_request goes on BOTH calls: the fallback exists only for a vLLM build
        # that doesn't take use_tqdm, and a retry without the adapter would render the
        # base voice while reporting success.
        lora_request = self._lora_request(voice)
        try:
            outputs = self.engine.generate([prompt], sampling_params, use_tqdm=False,
                                           lora_request=lora_request)
        except TypeError:
            outputs = self.engine.generate([prompt], sampling_params, lora_request=lora_request)
        tokens = list(outputs[0].outputs[0].token_ids)
        finished = self.END_OF_AUDIO_TOKEN in tokens
        if finished:
            tokens = tokens[:tokens.index(self.END_OF_AUDIO_TOKEN)]
        # Accept what we have once it fits, can't be split sensibly, or we've recursed enough.
        if finished or depth >= 3 or len(clean) < 80:
            return self._tokens_to_audio(tokens)
        parts = self._split_long_text(clean, max_length=max(60, len(clean) // 2))
        if len(parts) < 2:
            return self._tokens_to_audio(tokens)
        return np.concatenate(self._generate_parts_batched(parts, depth + 1, voice))

    def _generate_parts_batched(self, parts: list, depth: int, voice: str = None) -> list:
        """Render many text parts in ONE vLLM generate() call. Returns waveforms
        aligned to `parts`.

        This used to be `[self._generate_audio_vllm_safe(p, depth+1) for p in parts]` -
        a Python loop of SINGLE-prompt generate() calls, each running at a concurrency
        of one while the 60-odd other chunks of the batch that triggered it sat waiting
        for their turn through the result loop. vLLM schedules a list of prompts
        natively, so every part now runs concurrently in one scheduling round.

        A part that STILL hits the token cap (or whose token stream misaligns) falls
        back to the recursive serial ladder at `depth`. That is rare, and preserving its
        exact recursion/accept behaviour matters more than batching it.
        """
        from vllm import TokensPrompt
        if voice is None:
            voice = self.voice
        sampling_params = [self._vllm_sampling_params(len(p), voice=voice) for p in parts]
        prompts = [TokensPrompt(prompt_token_ids=self._format_prompt_ids(p, voice)) for p in parts]
        # Every part is the same voice (they are pieces of ONE sentence), so one
        # LoRARequest covers the call - vLLM applies a scalar lora_request to all
        # prompts (_validate_and_add_requests).
        lora_request = self._lora_request(voice)
        try:
            outputs = self.engine.generate(prompts, sampling_params, use_tqdm=False,
                                           lora_request=lora_request)
        except TypeError:
            outputs = self.engine.generate(prompts, sampling_params, lora_request=lora_request)
        waves = []
        for part, out in zip(parts, outputs):
            tokens = list(out.outputs[0].token_ids)
            if self.END_OF_AUDIO_TOKEN in tokens:
                tokens = tokens[:tokens.index(self.END_OF_AUDIO_TOKEN)]
                try:
                    waves.append(self._tokens_to_audio(tokens))
                    continue
                except TokenStreamMisaligned as align_err:
                    log(f"Orpheus: split part token stream misaligned ({align_err}); re-rendering once")
            waves.append(self._generate_audio_vllm_safe(part, depth, voice=voice))
        return waves

    def _render_deferred_resplits(self, deferred: list, results: dict) -> None:
        """Re-render every truncated chunk of a batch in ONE pooled generate() call.

        deferred: list of (sentence_index, clean, gap, reason). Fills `results` in place.

        Each chunk is split exactly as the inline guard split it
        (_generate_audio_vllm_safe with force_split - half-length parts, well inside the
        reliable zone). The ONLY change is scheduling: the parts of every deferred chunk
        in the batch are submitted together, so a batch carrying 3 truncations costs one
        extra scheduling round rather than 3+ serial single-prompt rounds, each of which
        used to hold up the whole batch's remaining results.

        Audio is byte-for-byte the same decision path - same text, same split, same
        per-part sampling params. Only the wall-clock changes.
        """
        flat, owners = [], []     # part texts, and the deferred[] position each belongs to
        for pos, (_idx, clean, _gap, _reason) in enumerate(deferred):
            parts = self._split_long_text(clean, max_length=max(60, len(clean) // 2))
            if len(parts) < 2:
                # Unsplittable text - the ladder falls through to a plain render, and so
                # do we. _generate_parts_batched still applies the cap ladder to it.
                parts = [clean]
            for p in parts:
                flat.append(p)
                owners.append(pos)

        waves = self._generate_parts_batched(flat, 1)

        for pos, (idx, clean, gap, reason) in enumerate(deferred):
            try:
                mine = [w for w, o in zip(waves, owners) if o == pos]
                audio_np = np.concatenate(mine) if len(mine) > 1 else mine[0]
                if reason == 'short':
                    self._ratchet_after_resplit(clean, audio_np)
                results[idx] = self._save_audio(idx, audio_np, gap[0], gap[1])
            except Exception as resplit_err:
                log(f"Orpheus deferred re-render failed for sentence {idx}: {resplit_err}")
                if is_fatal_cuda_error(resplit_err):
                    # Poisoned context - every remaining sentence would fail instantly.
                    raise
                results[idx] = False

    def _convert_vllm_batch(self, items: list) -> list:
        """The vLLM half of convert_batch: many sentences in ONE generate() call.

        items: list of (sentence_index, sentence). Returns list[bool] aligned to items.
        """
        import gc
        from vllm import TokensPrompt

        results = {}
        gen = []  # (idx, clean_text, prompt_ids, (gap_lead, gap_trail)) for non-empty sentences
        for idx, sentence in items:
            gap = self._classify_gap(sentence)
            clean = self._clean_sentence_for_tts(sentence)
            if not clean:
                results[idx] = self._write_silence(idx)
            else:
                gen.append((idx, clean, self._format_prompt_ids(clean), gap))

        if gen:
            # Per-item SamplingParams: the EOS-boost threshold depends on each
            # sentence's expected length. vLLM accepts a list aligned to prompts.
            sampling_params = [self._vllm_sampling_params(len(clean)) for _, clean, _, _ in gen]
            prompts = [TokensPrompt(prompt_token_ids=fp) for _, _, fp, _ in gen]
            # One voice per audiobook worker, so one LoRARequest covers the whole
            # batch (vLLM applies a scalar to every prompt). It rides on BOTH
            # calls - the use_tqdm fallback without it would render the base voice.
            lora_request = self._lora_request()
            # use_tqdm=False: a per-call progress bar adds overhead and noise.
            _batch_t0 = _time.time()
            try:
                outputs = self.engine.generate(prompts, sampling_params, use_tqdm=False,
                                               lora_request=lora_request)
            except TypeError:
                outputs = self.engine.generate(prompts, sampling_params,
                                               lora_request=lora_request)
            self._log_batch_stats(len(prompts), _time.time() - _batch_t0)
            # Chunks whose audio came back truncated are NOT re-rendered here. The
            # verdict (_needs_resplit) is pure text-vs-audio, and the force-split
            # re-render is deterministic - the split follows from the text alone -
            # so every failure in this batch can be pooled into ONE extra generate()
            # after the loop instead of N serial single-prompt calls that stall the
            # remaining results behind them. See _render_deferred_resplits.
            deferred = []   # (sentence_index, clean, gap, reason)
            # vLLM returns outputs in the same order as prompts.
            for (idx, clean, _, gap), out in zip(gen, outputs):
                try:
                    tokens = list(out.outputs[0].token_ids)
                    if self.END_OF_AUDIO_TOKEN in tokens:
                        # Finished cleanly: decode up to the end-of-audio token.
                        tokens = tokens[:tokens.index(self.END_OF_AUDIO_TOKEN)]
                        try:
                            audio_np = self._tokens_to_audio(tokens)
                        except TokenStreamMisaligned as align_err:
                            # Stochastic sampling glitch - one re-render (fresh
                            # tokens) almost always fixes it. If it misaligns
                            # again, the outer except fails just this sentence.
                            log(f"Orpheus: sentence {idx} token stream misaligned ({align_err}); re-rendering once")
                            audio_np = self._generate_audio_vllm_safe(clean)
                    else:
                        # Hit the token cap without finishing -> the chunk was too long
                        # and the audio would be clipped. Re-render it split at sentence
                        # boundaries so nothing is cut off.
                        log(f"Orpheus: sentence {idx} hit the audio-token cap; re-rendering split at sentence boundaries")
                        # Keep the RUNAWAY itself before the re-render overwrites it:
                        # this is the one failure that never leaves evidence otherwise.
                        try:
                            capped_np = self._tokens_to_audio(tokens)
                        except Exception:
                            capped_np = None
                        self._keep_reject(idx, clean, capped_np, 'cap',
                                          {'tokens_emitted': len(tokens),
                                           'token_cap': self.MAX_AUDIO_TOKENS})
                        audio_np = self._generate_audio_vllm_safe(clean)
                    self._log_chunk_stats(idx, clean, out, audio_np)
                    # Backstop a silent early-EOS truncation (clean EOS, audio too
                    # short for the text) that the cap check above can't catch.
                    # Only the VERDICT is taken here; the re-render is pooled.
                    reason = self._needs_resplit(idx, clean, audio_np)
                    if reason is not None:
                        deferred.append((idx, clean, gap, reason))
                        continue
                    # REPORT the opposite failure on a sub-floor chunk - audio
                    # far LONGER than the text can justify. Nothing is deferred
                    # and nothing re-rendered: the take stands and is counted.
                    self._report_short_chunk_overrun(idx, clean, audio_np)
                    # ASR verify gate: right length, wrong WORDS. Only
                    # risk-flagged chunks pay the CPU check; a rare failure
                    # re-renders serially here (census: ~1% of chunks).
                    audio_np = self._asr_verify_or_retry(
                        idx, clean, audio_np, self._generate_audio_vllm_safe)
                    results[idx] = self._save_audio(idx, audio_np, gap[0], gap[1])
                except Exception as decode_err:
                    log(f"Orpheus batch decode error for sentence {idx}: {decode_err}")
                    if is_fatal_cuda_error(decode_err):
                        # Poisoned CUDA context: every remaining sentence would
                        # fail instantly too. Die loudly; the worker respawns and
                        # resumes from the sentence files already on disk.
                        raise
                    results[idx] = False

            if deferred:
                self._render_deferred_resplits(deferred, results)

        # NO _cleanup_memory() here: it empty_cache()s the CUDA allocator, and at
        # one flush per batch (~113 per book) every subsequent batch re-allocates
        # from the raw driver - through WSL's paravirtual (dxg) path that is both
        # slow and a VA-fragmentation source (the very OOMs the decode ladder
        # above recovers from). The caching allocator is bounded by vLLM's
        # reservation regardless.
        gc.collect()
        return [results.get(idx, False) for idx, _ in items]

    # -- fast-start streaming -------------------------------------------------
    #
    # THE ONE RULE THAT SHAPES EVERYTHING: audio that has been emitted has been
    # HEARD. Nothing can retract it. So a streamed row gets no re-render, no
    # resplit and no retake - the truncation guard's verdict is taken and LOGGED
    # (that is what the [ORPHEUS][STREAM] lines are for) and the audio stands.
    # A row that cannot be decoded at all is reported as a failure so the client
    # can throw away the chunks it has; a row that merely read fast is kept,
    # because the alternative is a stutter followed by the same sentence again.

    def _absorb_stream_tokens(self, row, token_ids) -> None:
        """Fold ONE step's cumulative `token_ids` into `row`.

        vLLM 0.7.3 re-sends the whole generated sequence every step
        (RequestOutputKind.CUMULATIVE), so only the tail past `row.consumed` is
        new. Walking just the tail keeps a 3,700-token row linear instead of
        quadratic - at ~84 tokens/s and one step per token, re-filtering the
        whole list every step would be millions of comparisons per row.

        The audio-range test is _redistribute_codes' filter, applied HERE
        instead of at decode time: the windowed decoder slices at exact
        multiples of 7, so a non-audio token left in the list would shift every
        following frame by one slot. Dropping it as it arrives keeps
        `audio_tokens` a pure frame sequence - and _redistribute_codes still
        validates each window's slots, so a genuinely malformed stream is caught
        with the same TokenStreamMisaligned it always was.
        """
        if len(token_ids) < row.consumed:
            raise TokenStreamMisaligned(
                f'row {row.index}: vLLM returned {len(token_ids)} cumulative '
                f'tokens after {row.consumed} were already consumed; the request '
                'output went backwards')
        eos = self.END_OF_AUDIO_TOKEN
        for t in token_ids[row.consumed:]:
            row.raw_tokens.append(t)
            if t == eos:
                row.eos_seen = True
            elif not row.eos_seen and 128266 <= t < 128266 + 4096 * 7:
                row.audio_tokens.append(t)
        row.consumed = len(token_ids)

    def _vllm_frame_decoder(self, row):
        """The `decode_frames` callable WindowedFrameEmitter drives for `row`.

        Frames [first, last) are tokens [first*7, last*7) of the row's filtered
        audio-token list, decoded through the ordinary _tokens_to_audio - same
        SNAC model, same OOM ladder, same misalignment check as a whole clip.
        The closure reads `row.audio_tokens` LIVE, so the window is always cut
        from whatever has arrived by the time the decode runs.
        """
        def _decode(first, last):
            return self._tokens_to_audio(
                row.audio_tokens[first * TOKENS_PER_FRAME:last * TOKENS_PER_FRAME])
        return _decode

    def _generate_batch_stream_vllm(self, texts, voices, stream_rows,
                                    on_chunk, on_row, should_stop) -> None:
        """Fast start on vLLM: drive LLMEngine.step() and emit per frame group.

        WHY NOT LLM.generate(). The offline `LLM.generate()` runs its own loop
        until nothing is unfinished and hands back finished RequestOutputs - by
        construction there is no per-step hook in it. The engine underneath
        (`self.engine.llm_engine`) is the same object generate() drives, with the
        same continuous batching and the same scheduler; add_request/step is
        simply the API that lets us look at the tokens as they land. Sampling is
        UNCHANGED because it still comes from _vllm_sampling_params - which is
        what keeps the per-request EOS boost AND the EOS floor applying to every
        row, streamed or not.

        WHY NO MODEL CALL HAPPENS INSIDE THE LOOP. _generate_audio_vllm_safe and
        the resplit ladder call LLM.generate(), which would run ITS OWN
        step-until-empty loop over the very engine we are streaming through -
        swallowing our requests' outputs and dropping them on the floor. So a
        non-streamed row that needs the model again (cap hit, or a truncation
        verdict) is DEFERRED to after the loop. A non-streamed row that needs
        nothing is delivered at retirement, so it still arrives ahead of the
        slowest row of the batch.

        A STOP DROPS THE DEFERRED RE-RENDERS TOO - including ones for rows whose
        GENERATION had already completed. A deferred row is one whose first take
        was rejected (cap hit, or too fast for its text); finishing it means
        running the model again for tens of seconds, which is precisely the work
        the stop exists to avoid. Those rows therefore get no on_row, like every
        other abandoned row, and the caller reports them as cancelled.

        THE ENGINE IS SHARED AND MUST BE LEFT CLEAN. Every exit runs the finally
        below, which aborts every request this batch still has in flight and
        answers every row it never answered. Leaking one live request would be
        permanent: the NEXT batch's step() would hand it back, hit the
        unknown-request guard, and raise - for every batch after it, until the
        worker is restarted.
        """
        import sys

        from vllm import TokensPrompt
        llm_engine = self.engine.llm_engine
        # Request ids must be unique among everything in flight on this engine.
        # A per-instance serial plus the row index is enough and stays readable
        # in a vLLM log line.
        self._stream_batch_serial += 1
        serial = self._stream_batch_serial

        rows = {}          # request_id -> _VllmStreamRow
        deferred = []      # (row, reason) - needs the MODEL, so after the loop
        answered = set()   # row indices that have had their on_row
        stopped = False

        def deliver(i, audio):
            """on_row, at most once per row. The finally reconciles against it,
            so a row can be answered on the fast path AND swept without the
            caller ever seeing two items for one sentence."""
            if i in answered:
                return
            answered.add(i)
            on_row(i, audio)

        try:
            for i, text in enumerate(texts):
                clean = text.strip()
                # A None entry means "the loaded voice" - the caller's documented
                # contract (the worker's _row_voice), not a fallback for a
                # missing value.
                voice = self.voice if (voices is None or voices[i] is None) else voices[i]
                rid = f'bf-stream-{serial}-{i}'
                row = _VllmStreamRow(i, clean, voice, rid, i in stream_rows)
                if row.streamed:
                    row.emitter = WindowedFrameEmitter(self._vllm_frame_decoder(row),
                                                       label=f'row {i}')
                # Registered BEFORE add_request, so an add_request that throws
                # half way through the batch still leaves every row it did add
                # in `rows` for the finally to abort. (A row that failed to be
                # added is retired-and-unanswered, which the finally answers.)
                rows[rid] = row
                try:
                    llm_engine.add_request(
                        rid,
                        TokensPrompt(prompt_token_ids=self._format_prompt_ids(clean, voice)),
                        self._vllm_sampling_params(len(clean), voice=voice),
                        lora_request=self._lora_request(voice))
                except BaseException:
                    row.retired = True    # nothing in flight for it to abort
                    raise

            while llm_engine.has_unfinished_requests():
                # Once per decode step - a callback against a forward pass over
                # the whole batch.
                if should_stop is not None and should_stop():
                    stopped = True
                    break
                for out in llm_engine.step():
                    row = rows.get(out.request_id)
                    if row is None:
                        # Something else is using this engine concurrently, and
                        # this loop has just consumed ITS output - which nothing
                        # will deliver, because step() hands each output out
                        # once. Fail loudly rather than drop someone else's
                        # sentence.
                        raise RuntimeError(
                            f'Orpheus fast start: LLMEngine.step() returned request '
                            f'{out.request_id!r}, which this batch did not add. The '
                            'streaming loop must own the engine for the duration of '
                            'a batch.')
                    if row.retired:
                        continue
                    self._absorb_stream_tokens(row, out.outputs[0].token_ids)
                    if row.streamed and not self._emit_vllm_stream(row, 'push', on_chunk):
                        # The row is dead. Retire it HERE - an aborted request
                        # never comes back through step() with finished=True, so
                        # without this the caller would wait forever for a row
                        # that will never arrive.
                        row.retired = True
                        llm_engine.abort_request(row.request_id)
                        deliver(row.index, None)
                        continue
                    if out.finished:
                        self._retire_vllm_stream_row(row, on_chunk, deliver, deferred)

            if stopped:
                # The finally aborts what is still live; say what happened, and
                # do NOT answer the abandoned rows (that is the contract).
                live = [r.index for r in rows.values() if not r.retired]
                log(f'[ORPHEUS][STREAM] vLLM batch abandoned on request '
                      f'({len(live)} of {len(rows)} rows unrendered)', flush=True)
                return

            # THE SWEEP. has_unfinished_requests() has gone false, so nothing of
            # ours can produce another output - yet a row here has never been
            # retired, which means step() never returned it finished. That
            # should be impossible; if it happens, the row would otherwise hang
            # the caller forever, so answer it as a failure and say so loudly.
            for row in sorted(rows.values(), key=lambda r: r.index):
                if row.retired:
                    continue
                log(f'[ORPHEUS][STREAM] row {row.index} never finished although '
                      f'the engine reports nothing unfinished; reporting it as a '
                      f'failure', flush=True)
                row.retired = True
                deliver(row.index, None)

            # Everything that needed the model, now that no request of ours is
            # in flight. Sorted by row index, not retirement order, so the
            # re-renders (and the rate ratchet one can raise) land in the order
            # the serial path would have run them.
            for row, reason in sorted(deferred, key=lambda d: d[0].index):
                try:
                    if reason == 'cap':
                        # Hit the token cap without an end-of-speech: the clip
                        # would be clipped. Same ladder the batch path uses today
                        # - render whole first (it may finish cleanly at this
                        # length), then the early-EOS backstop.
                        audio = self._generate_audio_vllm_safe(row.clean, voice=row.voice)
                        audio = self._guard_truncation(
                            row.index, row.clean, audio,
                            lambda c, rv=row.voice: self._generate_audio_vllm_safe(
                                c, force_split=True, voice=rv),
                            row.voice)
                    else:
                        # The verdict was already taken (and logged, and the
                        # reject kept) at retirement by _needs_resplit - this is
                        # only the re-render half of _guard_truncation, so
                        # calling the whole guard again would double-log and
                        # double-reject.
                        audio = self._generate_audio_vllm_safe(
                            row.clean, force_split=True, voice=row.voice)
                        if reason == 'short':
                            self._ratchet_after_resplit(row.clean, audio, row.voice)
                    deliver(row.index, audio)
                except Exception as deferred_err:
                    log(f'[ORPHEUS][STREAM] deferred re-render failed for row '
                          f'{row.index}: {deferred_err}', flush=True)
                    if is_fatal_cuda_error(deferred_err):
                        # Poisoned context - every remaining row would fail
                        # instantly. The finally still answers them.
                        raise
                    deliver(row.index, None)
        finally:
            # LEAVE THE ENGINE CLEAN, ALWAYS. Any exception at all - a callback
            # raising, TokenStreamMisaligned, the fatal-CUDA re-raise, the
            # unknown-request guard, add_request itself - would otherwise leave
            # live requests in this shared LLMEngine, and the next batch's very
            # first step() would return them, hit the unknown-request guard and
            # raise. That is not a lost batch, it is a bricked worker.
            # NOTHING IN HERE MAY THROW. This block runs while an exception is
            # already in flight most of the time it matters, and a raise from a
            # finally REPLACES that exception - the real first cause would be
            # lost, and every orphan after the one that threw would go
            # unanswered. So the abort and each individual deliver get their own
            # try/except: report and carry on.
            live = [rid for rid, r in rows.items() if not r.retired]
            if live:
                try:
                    llm_engine.abort_request(live)
                except Exception as abort_err:
                    log(f'[ORPHEUS][STREAM] could not abort {len(live)} live '
                          f'request(s): {abort_err}', flush=True)
                for rid in live:
                    rows[rid].retired = True
            if not stopped:
                # On a STOP, unanswered rows stay unanswered by design. On any
                # other exit they must be answered exactly once, or the caller
                # waits forever for a row that no longer exists. On the normal
                # path this loop finds nothing.
                orphans = sorted(r.index for r in rows.values()
                                 if r.index not in answered)
                for i in orphans:
                    try:
                        log(f'[ORPHEUS][STREAM] row {i} left unanswered when the '
                              f'batch ended; reporting it as a failure', flush=True)
                        deliver(i, None)
                    except Exception as sweep_err:
                        # A raising on_row is the caller's bug; it must not cost
                        # the REST of the orphans their answer.
                        log(f'[ORPHEUS][STREAM] on_row raised while failing row '
                              f'{i}: {sweep_err}', flush=True)

    def _emit_vllm_stream(self, row, kind, on_chunk) -> bool:
        """Run the emitter for `row` ('push' mid-row, 'flush' at the end), hand
        every payload to on_chunk, and report whether it worked.

        A decode failure fails the ROW and marks it so: there is no re-render to
        fall back to (the audio is already playing) and emitting past a bad
        window would splice the row's own audio out of order. Only the caller
        knows what to do about it - abort the request, deliver the failure -
        because only the caller is holding the engine and the callbacks.

        The on_chunk loop is deliberately OUTSIDE the try: a callback that
        raises is the caller's bug, and blaming it on the windowed decode would
        send whoever reads the log to the wrong place.
        """
        import sys
        try:
            pairs = (row.emitter.flush(len(row.audio_tokens)) if kind == 'flush'
                     else row.emitter.push(len(row.audio_tokens)))
        except Exception as emit_err:
            row.failed = True
            log(f'[ORPHEUS][STREAM] row {row.index} windowed decode failed '
                  f'({emit_err}); the row is reported as a failure and its '
                  f'chunks are discarded', flush=True)
            return False
        for seq, pcm in pairs:
            row.chunks.append(pcm)
            on_chunk(row.index, seq, pcm)
        return True

    def _retire_vllm_stream_row(self, row, on_chunk, deliver, deferred) -> None:
        """One vLLM row whose tokens are final: deliver it, or defer the half
        that needs the model.

        `deliver` is the caller's exactly-once wrapper around on_row, not on_row
        itself, so a row answered here can never be answered a second time by
        the caller's end-of-batch sweep."""
        import sys
        row.retired = True
        if row.streamed:
            # A row that fails HERE has already been streamed in part, so `full`
            # is None and the caller reports a failure - which is the client's
            # signal to throw away the chunks it holds. (A row that failed
            # mid-generation never reaches this method; the loop retires it on
            # the spot.)
            ok = self._emit_vllm_stream(row, 'flush', on_chunk)
            full = np.concatenate(row.chunks) if (ok and row.chunks) else None
            if not row.eos_seen:
                log(f'[ORPHEUS][STREAM] row {row.index} stopped without an '
                      f'end-of-speech token ({len(row.audio_tokens)} audio tokens); '
                      'the streamed audio stands - nothing can retract audio that '
                      'has already been played', flush=True)
            if full is not None:
                # Verdict only. _needs_resplit still logs the detection and keeps
                # the reject, which is how a fast/empty streamed read stays
                # visible in the log and in the reject folder; what it does NOT
                # get is the re-render.
                verdict = self._needs_resplit(row.index, row.clean, full, row.voice)
                if verdict is not None:
                    log(f'[ORPHEUS][STREAM] row {row.index} truncation verdict '
                          f'{verdict!r}: kept as streamed, no re-render', flush=True)
            deliver(row.index, full)
            return
        # Not streamed: today's ladder, one row at a time.
        try:
            if not row.eos_seen:
                deferred.append((row, 'cap'))
                return
            tokens = row.raw_tokens[:row.raw_tokens.index(self.END_OF_AUDIO_TOKEN)]
            audio = self._tokens_to_audio(tokens)
        except Exception as decode_err:
            log(f'[ORPHEUS][STREAM] row {row.index} decode failed: {decode_err}', flush=True)
            if is_fatal_cuda_error(decode_err):
                raise
            deliver(row.index, None)
            return
        reason = self._needs_resplit(row.index, row.clean, audio, row.voice)
        if reason is not None:
            deferred.append((row, reason))
            return
        deliver(row.index, audio)


# Re-exported so the streaming loop's cadence constants read from one place.
__all__ = ['VllmBackendMixin', '_VllmStreamRow', 'PAYLOAD_FRAMES',
           'RIGHT_CONTEXT_FRAMES']
