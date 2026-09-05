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

        THE BODY MOVED to `narrator/text/gaps.py` on 2026-09-04, unchanged, so
        `text/prep.py` can write the same numbers into `gaps.json` for an engine
        that does NOT bake them into its audio. Orpheus still bakes them: this
        method is called by `_save_audio` exactly as before and every call site
        is unchanged.

        The dependency points DOWN on purpose - `text/` is pure stdlib and must
        import with no torch, while importing `narrator.engine` pulls in the
        Orpheus package. Same reasoning as `assemble/engine_profiles.py`.

        See `text/gaps.py` for the 2026-07-17 ruling that removed the paragraph
        and section tiers, which is why everything but an explicit `[pause:X]`
        collapses to the sentence-gap floor.
        """
        from ...text.gaps import classify_gap

        return classify_gap(sentence)
