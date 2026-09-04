"""Text in, prompt token ids out - plus the two text decisions that ride with
it: what is stripped, and where a chunk may be split.

Ported from ebook2audiobook@9daab0ba:
  lib/classes/tts_engines/orpheus.py         _format_prompt_ids (3082),
                                             _clean_sentence_for_tts (4042),
                                             _classify_gap (4075)
  lib/classes/tts_engines/common/utils.py    TTSUtils._split_long_text (527)

`_split_long_text` came from TTSUtils, the shared engine base narrator does not
have; it is reproduced here verbatim because both resplit ladders
(_generate_audio_vllm_safe, _generate_mlx_safe) and _render_deferred_resplits
call it, and its exact split points decide where a re-render's parts fall.

`_format_prompt_ids` needs the tokenizer, which the backends own - nothing in
this module imports torch, vLLM or mlx.
"""
import os
import re

from .text import SML_UNSPOKEN_PATTERN


class PromptMixin:

    def _clean_sentence_for_tts(self, sentence: str) -> str:
        """Strip whitespace + the SML tags Orpheus doesn't understand
        (SML_UNSPOKEN_PATTERN:
        [break]/[pause]/[heading]/[item]/[music]/[sfx]/[silence]);
        Orpheus has its own emotion tags.

        THE ENGINE READS THE TEXT AS PRINTED (Owen, 2026-09-02). Until then this
        boundary also applied the book-exact -> model transform (to_tts_form:
        scripture refs + bare-integer expansion, the transforms the fine-tunes
        trained with). That is PERMANENTLY DISABLED, not switchable: number
        normalization is BookForge's job now - a model pass over the narration
        copy, every digit-bearing block including headings and TOC titles, in the
        spoken forms the fine-tunes trained on - and "we don't need the pass done
        in two places". Nothing here may expand a digit the pass deliberately
        left (a citation code it judged unspeakable), and there is no switch to
        turn the old transform back on: a knob would be a second place.

        Everything downstream (prompt, token budgets, chars/sec + truncation
        guards, resplit ladders) measures this function's return, which is the
        stored sentence with its SML stripped - the same text the transcript
        shows."""
        sentence = (sentence or '').strip()
        return SML_UNSPOKEN_PATTERN.sub('', sentence).strip()

    def _format_prompt_ids(self, text: str, voice: str = None) -> list:
        """Return the exact Orpheus input token IDs for `text` in `voice` (default:
        this instance's voice).

        Framing (MUST match training in orpheus_owen.py's build_dataset):
          [128259]                        START_OF_HUMAN
          + tokenizer("voice: text")      (leading BOS 128000 + text tokens)
          + [128009, 128260, 128261, 128257]   END_OF_TEXT, END_OF_HUMAN,
                                                START_OF_AI, START_OF_SPEECH

        These IDs are fed straight to vLLM via TokensPrompt. The OLD code decoded
        this sequence back to a STRING and let vLLM re-tokenize it, which prepended
        a STRAY second BOS (128000) - an out-of-distribution prompt that made the
        model vocalize the voice token at chunk starts (the "rohan"/"deathstalker"
        leak). Feeding IDs directly makes the runtime prompt byte-identical to the
        one the model was trained on, so the voice token is consumed silently.

        `voice` is per-item because a single batched generate() may carry
        sentences in different voices (per-character casting), each with its own
        prompt token and its own LoRARequest.
        """
        if voice is None:
            voice = self.voice
        body = self.tokenizer(f"{voice}: {text}").input_ids   # includes leading BOS
        return [128259] + list(body) + [128009, 128260, 128261, 128257]

    def _split_long_text(self, text: str, max_length: int = 250) -> list:
        """Split text longer than max_length at natural break points.

        Splits at punctuation marks (comma, semicolon, colon, dashes) or
        at word boundaries if no punctuation is found within the limit.
        """
        if len(text) <= max_length:
            return [text]

        result = []
        remaining = text

        # Punctuation marks to split at, in order of preference.
        # Sentence-ending punctuation first (period/question/exclamation + space),
        # then clause-level punctuation (comma, semicolon, etc.)
        split_chars = ['. ', '? ', '! ', ',', ';', ':', '—', '–', ' - ']

        while len(remaining) > max_length:
            # Find the best split point within max_length
            split_pos = -1

            # Try each punctuation mark
            for char in split_chars:
                # Look for the last occurrence of this char within max_length
                pos = remaining.rfind(char, 0, max_length)
                if pos > split_pos and pos > max_length // 4:  # Don't split too early
                    split_pos = pos + len(char)  # Include the punctuation
                    break

            # If no punctuation found, split at the last space
            if split_pos == -1:
                pos = remaining.rfind(' ', 0, max_length)
                if pos > max_length // 4:  # Don't split too early
                    split_pos = pos + 1  # Include the space
                else:
                    # Fallback: hard split at max_length (shouldn't happen often)
                    split_pos = max_length

            # Add the chunk and continue with remaining
            chunk = remaining[:split_pos].strip()
            if chunk:
                result.append(chunk)
            remaining = remaining[split_pos:].strip()

        # Add the final piece
        if remaining:
            result.append(remaining)

        return result

    def _classify_gap(self, sentence: str):
        """Inter-clip silence for a chunk. Returns (lead_gap_sec, trail_gap_sec).

        2026-07-17 - AUTO PARAGRAPH/SECTION GAPS REMOVED FOR ORPHEUS (deliberately).
        Root cause of the long-standing "dialogue has huge pauses" complaint: e2a's
        SHARED text prep rewrites EVERY blank line to a valueless [pause] token, and
        prose puts EVERY dialogue turn in its own blank-line-separated paragraph. The
        old three-tier logic here then stamped a deterministic SECTION gap (1.0-1.6s
        lead) on top of each turn's sentence-gap tail. Measured with auto-editor on
        the mistborn 0.6s-cap model: dialogue-turn gaps were 2.0-2.5s (13 of them, one
        per paragraph break) vs the narrator's own ~0.6-1.0s; a STRAIGHT-NARRATION
        render from the same model measured median 0.57s / max 1.17s with NO outliers
        - i.e. the Orpheus model, trained on clips that keep their natural
        inter-sentence pauses (only the clip EDGES trimmed), already reproduces the
        narrator's pausing itself. The paragraph/section insertion was therefore
        PURELY additive dead air.

        So for Orpheus we now keep ONLY:
          - the sentence-gap FLOOR on every chunk's tail (each chunk is a separate
            generation whose trailing silence is trimmed, so without a small floor the
            chunks butt together), and
          - an EXPLICIT [pause:X] (intentional, markup-specified beat) - still honored,
            because that's a deliberate pause, not the auto blank-line noise.
        The auto valueless [pause] (blank line) and [break]/[silence] (<p>/<br>) tiers
        are GONE. The tokens themselves still drive chunk boundaries in the packer and
        are stripped by _clean_sentence_for_tts before TTS - only their deterministic
        GAP is removed here.

        If a real scene/section break ever under-pauses as a result, re-introduce a
        section tier HERE (or emit an explicit [pause:X] at that break) - do NOT
        restore the blanket blank-line gap that caused the dialogue problem.

        Env override: ORPHEUS_SENTENCE_GAP (the floor; 0 disables).
        """
        raw = (sentence or '').strip()
        lowered = raw.lower()

        def _env(name):
            v = os.environ.get(name)
            return float(v) if v is not None else None

        # Sentence-gap floor: the minimum tail every chunk gets so a chunk-to-chunk
        # join is never bare. Override with ORPHEUS_SENTENCE_GAP.
        sentence_gap = _env('ORPHEUS_SENTENCE_GAP')
        if sentence_gap is None:
            sentence_gap = 0.6   # ear-approved on rohan (2026-07-12)

        # Honor ONLY an EXPLICIT [pause:X] - a deliberate, markup-specified beat.
        # (Auto valueless [pause] from a blank line is intentionally NOT matched: that
        # is the dialogue-pause noise removed 2026-07-17; see the docstring.)
        m = re.search(r'\[pause:([0-9.]+)\]', raw, flags=re.IGNORECASE)
        if m:
            token_gap = float(m.group(1))
            if lowered.startswith('[pause:'):
                return token_gap, sentence_gap               # explicit beat as lead + normal tail
            return 0.0, max(token_gap, sentence_gap)

        # Everything else - plain sentence end, auto [break]/[silence], auto valueless
        # [pause] - collapses to the sentence-gap floor. Orpheus supplies the real
        # inter-sentence pausing itself (learned from natural-pause training clips).
        return 0.0, sentence_gap
