"""Expected-length arithmetic and the two end-of-speech levers.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _mlx_token_budget          (2160)
  _mlx_est_tokens            (2254)
  _expected_audio_tokens     (3108)
  _eos_floor_tokens          (3141)
  _eos_boost_processor       (3181)
  _mlx_eos_boost_processor   (3222)
  _vllm_sampling_params      (3266)

Everything here is float arithmetic over the caps registry. `_vllm_sampling_params`
imports vLLM lazily (one line, inside the function) and `_mlx_eos_boost_processor`
imports the MLX fast path's marked-closure factory the same way, so the module is
importable - and the EOS floor/boost math testable - with no torch, vLLM or mlx
installed. That is what tests/test_engine_eos_floor.py relies on.
"""
import math
from ..log import log


class SamplingMixin:

    # Voices whose EOS floor has been announced on the log. Class-level: the
    # audiobook worker is one voice per process (so this is "once per job"), the
    # streaming server serves many voices for the life of the process (so "once
    # per voice").
    _eos_floor_announced = set()

    def _mlx_token_budget(self, text: str) -> int:
        """Per-chunk MLX max_tokens CEILING sized from the text length, so a short
        repetition-primed chunk can't burn the flat MLX_MAX_TOKENS looping one
        sentence (the MLX runaway: minutes of the same line, because mlx-lm's
        ~20-token repetition penalty can't see a loop that is hundreds of audio
        tokens long).

        The divisor is the SLOWEST plausible reading rate, so the ceiling never
        clips HEALTHY audio (prose runs as slow as ~11 ch/s): the vLLM duration
        guard's per-voice rate (ORPHEUS_MAX_CHARS_PER_SEC - same source) when it is
        slower than the 12 ch/s slow-narrator floor, else the 12 floor. A smaller
        divisor = a MORE generous ceiling (safe); a larger one risks truncating
        slow narration, so we only ever go slower than 12, never faster. The 1.4
        factor is head-room over that worst case - only a runaway (many times the
        text's real token count) exceeds it.

        The tail allowance is added for the same reason _expected_audio_tokens
        exists (2026-08-28): chars/rate estimates SPEECH only, and the model's
        trained tail (~0.8-1.0 s) rides on every clip no matter how short the
        text. Without it this ceiling was catastrophically low for a heading:
        13 chars budgeted 128 tokens (1.52 s) against healthy renders of the same
        headings measured at 1.6-2.05 s, and 4 chars ("GOD.") budgeted 40 tokens
        against a measured 108 - a 37% ceiling. Adding a flat tail can only ever
        make the ceiling MORE generous, which is the safe direction; for prose it
        is noise."""
        env_rate = self._max_chars_per_sec()
        chars_per_sec_floor = min(env_rate, 12.0) if env_rate > 0 else 12.0
        speech = len(text) / chars_per_sec_floor * self.TOKENS_PER_AUDIO_SECOND
        return math.ceil((speech + self.SHORT_CHUNK_TAIL_TOKENS) * 1.4)

    def _mlx_est_tokens(self, audio) -> float:
        """Audio tokens the model must have emitted to produce `audio`, ESTIMATED
        from its duration - mlx_audio's generate() surfaces no token count, so
        duration x TOKENS_PER_AUDIO_SECOND is the only signal available. One home
        for the arithmetic (_generate_mlx's budget log and _mlx_looks_capped)."""
        if audio is None or len(audio) == 0:
            return 0.0
        return len(audio) / self.SAMPLE_RATE * self.TOKENS_PER_AUDIO_SECOND

    def _expected_audio_tokens(self, n_chars: int) -> float:
        """How many audio tokens a HEALTHY render of `n_chars` should take - the
        one estimate every anti-runaway lever is scaled from (both EOS-boost
        processors). Speech at the file's 18.4 ch/s anchor, plus the model's
        flat tail (SHORT_CHUNK_TAIL_TOKENS), never above the old flat floor.

        THE SHORT-CHUNK HOLE THIS CLOSES (2026-08-28). The estimate used to be
        `max(300.0, speech)`. The 300-token floor binds for every chunk under
        ~66 chars, so EVERY short chunk was handed the SAME expectation - and at
        deathstalker's eosBoostStart 2.0 that put the boost's start at 600 tokens
        (7.14 s of audio) for a 4-char title just as much as for a 65-char one.
        A healthy 13-char heading renders in ~130 tokens, so the boost - the only
        pressure that ever ends a stalled generation - could not engage until the
        clip had run more than 4x its natural length. It never engaged at all on
        the take that started this: "Introduction." spoken twice, 358 tokens.

        A flat floor was the wrong shape, not the wrong number: what a short
        chunk actually costs is its speech PLUS a tail that does not shrink with
        the text. So the floor becomes that sum, and the `min` keeps the change
        one-directional - this may only ever LOWER the expectation (engage the
        boost EARLIER), never raise it. Speech alone reaches 300 tokens at ~66
        chars and the tail-aware sum reaches it at ~45, so from there up the
        `min` returns the old value and NOTHING changes: ordinary prose, whose
        packing/gap/EOS behaviour is tuned, is untouched by construction. The
        whole change lives in chunks of 44 chars or fewer -
        tests/test_engine_short_chunk_repeat.py asserts that boundary rather than
        trusting it.
        """
        speech = n_chars / 18.4 * self.TOKENS_PER_AUDIO_SECOND
        return min(max(300.0, speech), self.SHORT_CHUNK_TAIL_TOKENS + speech)

    def _eos_floor_tokens(self, n_chars: int, voice: str = None) -> float:
        """The generated-token count BELOW which END_OF_SPEECH is forbidden for a
        chunk of `n_chars` (see the EOS_FLOOR comment in config.py), or 0.0 when
        the voice has no floor. Announced once per voice on first use.

        Refuses, loudly, a floor tighter than the truncation guard: the floor's
        own rate is eosFloorRate / eosFloor chars per second, and if that is not
        above maxCharsPerSec the floor would forbid EOS on reads the guard
        accepts as honest, gagging the model past its ending. A guard of 0 is
        "disabled" and imposes no bound."""
        ratio = self._voice_cap('eosFloor', voice)
        if ratio <= 0:
            return 0.0
        if voice is None:
            voice = self.voice
        if ratio >= 1.0:
            raise ValueError(
                f"Orpheus EOS floor for {voice!r}: eosFloor must be a fraction of the "
                f'expected length in (0, 1), got {ratio}')
        rate = self._voice_cap('eosFloorRate', voice)
        if rate <= 0:
            raise ValueError(
                f"Orpheus EOS floor for {voice!r}: eosFloorRate must be a positive "
                f'chars-per-second speech rate, got {rate}')
        floor_rate = rate / ratio
        guard = self._max_chars_per_sec(voice)
        if guard > 0 and floor_rate <= guard:
            raise ValueError(
                f"Orpheus EOS floor for {voice!r} is tighter than its truncation guard: "
                f'eosFloorRate {rate} / eosFloor {ratio} forbids EOS on any read faster '
                f'than {floor_rate:.1f} ch/s, but maxCharsPerSec {guard} accepts reads up '
                f'to {guard} ch/s as honest. Lower eosFloor or raise eosFloorRate.')
        if voice not in self._eos_floor_announced:
            self._eos_floor_announced.add(voice)
            log(f'Orpheus: EOS floor for {voice}: END_OF_SPEECH forbidden below '
                  f'{ratio:g} x expected (chars / {rate:g} ch/s x '
                  f'{self.TOKENS_PER_AUDIO_SECOND} tok/s), i.e. on any read faster than '
                  f'{floor_rate:.1f} ch/s (rate guard {guard:g})')
        return ratio * n_chars / rate * self.TOKENS_PER_AUDIO_SECOND

    def _eos_boost_processor(self, n_chars: int, voice: str = None):
        """Per-request vLLM logits processor carrying BOTH end-of-speech levers
        (see the EOS_BOOST and EOS_FLOOR comments in config.py):

          - the FLOOR: while fewer than _eos_floor_tokens have been generated,
            the EOS logit is -inf (an early stop cannot be sampled at all);
          - the BOOST: past eosBoostStart x _expected_audio_tokens, the EOS
            logit gains a bias that ramps with the overrun.

        The two windows never overlap (floor < ~0.55x expected, boost start >=
        1.2x expected), so the boost's arithmetic here is byte-for-byte what it
        was before the floor existed. Returns None when neither is configured,
        so an untuned voice pays nothing. Expected token counts use the file's
        own anchors (~18.4 chars/sec of speech for the boost, the voice's median
        rate for the floor) and TOKENS_PER_AUDIO_SECOND audio tokens/sec.

        `voice` is per-request because both levers are properties of the
        FINE-TUNE (only the bed-free voices carry the thin greedy EOS margin the
        boost corrects), and a batch may mix voices. vLLM hands the
        two-argument processor its GENERATED token ids only (0.7.3
        _apply_logits_processors: past_tokens_ids = output_token_ids), so `n`
        counts audio tokens with no prompt in it."""
        base = self._voice_cap('eosBoost', voice)
        floor = self._eos_floor_tokens(n_chars, voice)
        if base <= 0 and floor <= 0:
            return None
        expected = self._expected_audio_tokens(n_chars)
        start = self._voice_cap('eosBoostStart', voice) * expected
        eos = self.END_OF_AUDIO_TOKEN
        neg_inf = float('-inf')

        def _eos_levers(token_ids, logits):
            n = len(token_ids)
            if n < floor:
                logits[eos] = neg_inf
            elif base > 0 and n > start:
                # ramp with overrun, capped at 4x the base bias
                logits[eos] += base * min(4.0, 1.0 + (n - start) / expected)
            return logits
        return _eos_levers

    def _mlx_eos_boost_processor(self, n_chars: int):
        """The EOS boost, ported to mlx-lm's logits-processor contract
        (`(tokens_context, logits(1, vocab)) -> logits`, applied PER ROW by
        BatchGenerator with that row's own token history - the context is seeded
        empty at insert, so `len(tokens)` counts generated tokens plus one, the
        same quantity vLLM's processor sees). Returns None when the voice does
        not carry a boost, so an unconfigured voice pays nothing.

        Same base/ramp/4x arithmetic as `_eos_boost_processor`, with ONE
        deliberate divergence: the start is clamped to fire no later than 90% of
        MLX_MAX_TOKENS. With eosBoostStart 2.0 a ~500-char chunk's start
        (~4,600 tokens) sits beyond the 3,700-token cap, so the vLLM-tuned start
        can NEVER fire for a full-size chunk here - and the rows this port
        exists for (measured 2026-08-21: 2 cap-hits in 623 chunks AFTER the
        rep-window fix, both ~500-char slow-delivery passages) are exactly those.
        The clamp only moves the start for chunks whose natural start would
        outrun the cap; short-chunk runaways keep the vLLM behaviour."""
        floor = self._voice_cap('eosFloor')
        if floor > 0:
            # NOT a silent no-op: a voice tuned with a floor would otherwise render
            # a whole book on the Mac without it and nothing would say so. The
            # port needs its own arithmetic (mlx-lm's `len(tokens)` includes the
            # prompt) and its own fast-path marker; see the EOS_FLOOR comment.
            raise NotImplementedError(
                f'Orpheus EOS floor (eosFloor {floor:g}) is configured for '
                f'{self.voice!r} but is vLLM-only; the MLX backend has no port yet. '
                'Remove eosFloor from this voice\'s backends.mlx overlay / unset '
                'ORPHEUS_EOS_FLOOR to render on MLX.')
        base = self._voice_cap('eosBoost')
        if base <= 0:
            return None
        expected = self._expected_audio_tokens(n_chars)
        start = min(self._voice_cap('eosBoostStart') * expected,
                    0.9 * self.MLX_MAX_TOKENS)
        # Same closure as before, minted by the fast path's factory so the
        # batched step can read (base, start, expected, eos) off it instead of
        # guessing at an opaque closure. Called directly it behaves exactly as it
        # always did, so a stock (un-installed) model is unaffected.
        from .mlx_fastpath import make_eos_boost
        return make_eos_boost(base, start, expected, self.END_OF_AUDIO_TOKEN)

    def _vllm_sampling_params(self, n_chars: int, max_tokens: int = None, voice: str = None):
        """The ONE place vLLM SamplingParams are built, so every path carries
        identical sampling config + the (optional) per-request EOS boost.

        Every value is resolved for `voice` (default: this instance's voice) -
        see VOICE_CAP_SOURCES. That is what lets a single batch carry per-item
        voices, and it is why the BookForge streaming server must build its batch
        params HERE instead of assembling its own SamplingParams (which silently
        dropped the EOS boost for every streamed voice)."""
        from vllm import SamplingParams
        proc = self._eos_boost_processor(n_chars, voice)
        return SamplingParams(
            temperature=self._voice_cap('temperature', voice),
            top_p=self._voice_cap('topP', voice),
            min_p=self._voice_cap('minP', voice),
            repetition_penalty=self._voice_cap('repPenalty', voice),
            max_tokens=max_tokens if max_tokens is not None else self.MAX_AUDIO_TOKENS,
            stop_token_ids=[self.END_OF_AUDIO_TOKEN],
            logits_processors=[proc] if proc else None,
        )
