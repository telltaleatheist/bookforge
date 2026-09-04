"""The transformers fallback backend: slow, but works everywhere.

Ported from ebook2audiobook@9daab0ba lib/classes/tts_engines/orpheus.py:
  _load_transformers_engine (1986)
  _generate_tokens_transformers (3886)

No adapter support: load_engine refuses adapter mode on this backend outright,
because there is no PEFT wiring here and it would serve the BARE BASE under the
voice's name - a render that sounds finished and is in the wrong voice.

torch is imported LAZILY inside the functions, so importing this module costs
nothing on a machine without it.
"""
from . import cuda_env

cuda_env.apply()


class TransformersBackendMixin:

    def _load_transformers_engine(self):
        """Load model using transformers backend."""
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        print(f"Loading Orpheus model with transformers: {self.TRANSFORMERS_MODEL}")

        # Determine device and dtype
        if torch.cuda.is_available():
            self._device = 'cuda'
            dtype = torch.float16
        elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
            self._device = 'mps'
            dtype = torch.float16
        else:
            self._device = 'cpu'
            dtype = torch.float32

        self.tokenizer = AutoTokenizer.from_pretrained(self.TRANSFORMERS_MODEL)

        # Load on CPU first (more reliable), then move to device
        print("Loading model weights on CPU...")
        model = AutoModelForCausalLM.from_pretrained(
            self.TRANSFORMERS_MODEL,
            torch_dtype=dtype,
            low_cpu_mem_usage=True
        )

        if self._device != 'cpu':
            print(f"Moving model to {self._device}...")
            model = model.to(self._device)

        model.eval()
        print(f"Model ready on {self._device}")
        return model

    def _generate_tokens_transformers(self, prompt: str, max_tokens: int = None) -> list:
        """Generate audio tokens using transformers backend."""
        import torch
        if max_tokens is None:
            max_tokens = self.MAX_AUDIO_TOKENS
        # Apply the SAME framing as the vLLM path (_format_prompt_ids): SOH + BOS+text
        # + EOT,EOH,SOA,SOS. Without it the model gets an un-framed prompt and vocalizes
        # the voice token at chunk starts. `prompt` arrives pre-joined as "voice: text".
        body = self.tokenizer(prompt).input_ids
        framed = [128259] + list(body) + [128009, 128260, 128261, 128257]
        input_ids = torch.tensor([framed], dtype=torch.long).to(self.engine.device)

        # Generate with repetition penalty to avoid garbage loops
        with torch.no_grad():
            outputs = self.engine.generate(
                input_ids,
                max_new_tokens=max_tokens,
                temperature=self._voice_cap('temperature'),
                top_p=self._voice_cap('topP'),
                repetition_penalty=self._voice_cap('repPenalty'),
                do_sample=True,
                pad_token_id=self.tokenizer.pad_token_id or self.tokenizer.eos_token_id,
                eos_token_id=self.END_OF_AUDIO_TOKEN
            )

        # Extract generated tokens (excluding prompt)
        generated = outputs[0][input_ids.shape[1]:].tolist()

        # Truncate at end-of-audio token if present
        if self.END_OF_AUDIO_TOKEN in generated:
            end_idx = generated.index(self.END_OF_AUDIO_TOKEN)
            generated = generated[:end_idx]

        return generated
