"""Higgs v2 in this process, through transformers.

Ported from the measured harness
`E:\\training\\_campaigns\\2026-09-01-cod-full-rebuild\\higgs\\render_v2.py`
(2026-09-04) - its model load, its `apply_chat_template` call and its
`model.generate` call, unchanged in substance. `smoke_v2.py` is where the
processor's shape was probed.

Measured on the RTX 3090 Ti in WSL env `higgs` (python 3.11, torch 2.6.0+cu124,
transformers 5.16.1): model load 15.6 s, generation RTF 1.124 single-stream,
decode RTF 0.0037, peak 16.26 GB bf16 with two reference clips in context.

THREE THINGS THAT ARE NOT OBVIOUS AND ARE NOT NEGOTIABLE

1. `processor.audio_tokenizer` LOADS ON CPU even with `device_map='cuda'`. It
   must be moved explicitly or the decode throws a device mismatch. render_v2.py
   does `processor.audio_tokenizer.to("cuda")` right after the model load; so
   does this.
2. `model.generate` returns the WHOLE audio stream, references included, as
   (batch, seq, 8) - not just the new frames. Locating the generated span is the
   codec's job (`codec.generated_span`).
3. `use_text_head` is NOT passed: the text LM head is not loaded at inference
   and that saves ~1.5 GiB. It is needed only for PEFT/SFT.

transformers, torch and the model are imported INSIDE the functions that need
them, exactly as the Orpheus backends do, so importing this module costs
nothing on an interpreter with neither.
"""
import time
from ..log import log

_DTYPES = ('bfloat16', 'float16', 'float32')


class HiggsTransformersBackend:
    """The loaded model + processor, and the one call that runs a chunk."""

    def __init__(self, config):
        self.config = config
        self.model = None
        self.processor = None
        self.device = None

    # -- lifecycle ------------------------------------------------------------

    def load(self):
        """Load the processor and the model. Loud about every step: this is a
        15 s, 16 GB operation and a silent one is indistinguishable from a
        hang."""
        import torch
        from transformers import AutoProcessor

        if self.config.dtype not in _DTYPES:
            raise ValueError(
                f'HiggsConfig.dtype {self.config.dtype!r} is not one of {_DTYPES}')
        try:
            from transformers import HiggsAudioV2ForConditionalGeneration
        except ImportError as exc:
            raise ImportError(
                'Higgs v2 needs transformers >= 5.3.0 for '
                'HiggsAudioV2ForConditionalGeneration (measured on 5.16.1 in the WSL '
                f'env `higgs`). Import failed: {exc}') from exc

        started = time.time()
        log(f'[HIGGS] loading {self.config.model_id} '
              f'({self.config.dtype}, {self.config.device})', flush=True)
        self.processor = AutoProcessor.from_pretrained(self.config.model_id)
        self.model = HiggsAudioV2ForConditionalGeneration.from_pretrained(
            self.config.model_id,
            dtype=getattr(torch, self.config.dtype),
            device_map=self.config.device)
        self.model.eval()
        # The audio tokenizer (the codec decoder) lands on the CPU whatever
        # device_map says - see the module docstring.
        self.processor.audio_tokenizer.to(self.config.device)
        self.device = self.model.device
        log(f'[HIGGS] loaded in {time.time() - started:.1f}s', flush=True)

    def unload(self):
        self.model = None
        self.processor = None
        self.device = None
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    # -- generation -----------------------------------------------------------

    def prompt_positions(self, conversation) -> int:
        """Text positions + reference audio frames for `conversation`. This is
        what HiggsBudget.max_total_tokens is asked about."""
        inputs = self._encode(conversation)
        text = int(inputs['input_ids'].shape[-1])
        audio = int(inputs['audio_input_ids'].shape[1]) if 'audio_input_ids' in inputs else 0
        return text + audio

    def _encode(self, conversation):
        if self.processor is None:
            raise RuntimeError('HiggsTransformersBackend.load() has not run')
        return self.processor.apply_chat_template(
            conversation, add_generation_prompt=True, tokenize=True,
            return_dict=True, sampling_rate=self.config.sample_rate,
            return_tensors='pt').to(self.model.device)

    def generate(self, conversation, max_new_tokens: int, seed=None):
        """Run one chunk. Returns the raw (seq, 8) audio-token matrix.

        Sampling is render_v2.py's: do_sample=True with temperature / top_p /
        top_k off the config. The seed is set per call (render_v2 used
        1234 + chunk index) so a re-render of the same chunk is reproducible.
        """
        import torch
        if self.model is None:
            raise RuntimeError('HiggsTransformersBackend.load() has not run')
        inputs = self._encode(conversation)
        if seed is not None:
            torch.manual_seed(int(seed))
        with torch.no_grad():
            out = self.model.generate(
                **inputs,
                max_new_tokens=int(max_new_tokens),
                do_sample=True,
                temperature=float(self.config.temperature),
                top_p=float(self.config.top_p),
                top_k=int(self.config.top_k))
        return out

    def audio_decoder(self):
        """The callable `HiggsCodec` needs: an (8, frames) int matrix in, a
        float32 waveform out.

        This is step 6 of the decode (see codec.py). It calls the audio
        tokenizer directly rather than `processor.batch_decode`, because
        batch_decode also performs steps 1-5 and its trim leaves the ramp-down
        sentinels' 240 ms of audible garbage on the end of every chunk - the
        thing `codec.trim_trailing_sentinels` removes by content.
        """
        def decode(codes_qt):
            import numpy as np
            import torch
            if self.processor is None:
                raise RuntimeError('HiggsTransformersBackend.load() has not run')
            tokens = torch.as_tensor(np.asarray(codes_qt), dtype=torch.long,
                                     device=self.processor.audio_tokenizer.device)
            with torch.no_grad():
                decoded = self.processor.audio_tokenizer.decode(tokens.unsqueeze(0))
            audio = getattr(decoded, 'audio_values', decoded)
            return audio.float().cpu().numpy().reshape(-1)
        return decode

