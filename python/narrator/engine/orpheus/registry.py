"""The process-global loaded-model cache.

Ported from ebook2audiobook@9daab0ba lib/conf_models.py `loaded_tts` (a bare
module-level dict) as used by lib/classes/tts_engines/orpheus.py
(load_engine / _evict_global_cache / _register_lora).

WHY IT SURVIVES THE PORT. It is not a convenience: the resident streaming worker
builds a NEW engine object per voice switch against the SAME weights, and the
LoRA int-id registry it holds must line up across those objects (see
_register_lora). One dict, one process, exactly the semantics orpheus.py has.

Keys used by narrator (the same names, so a post-mortem of either codebase
reads the same):
  orpheus                  the backend engine object (vLLM LLM / mlx model /
                           transformers model)
  orpheus_backend          'vllm' | 'mlx' | 'transformers'
  orpheus_snac             the torch SNAC decoder (None on MLX)
  orpheus_tokenizer        the HF tokenizer (None on MLX)
  orpheus_device           'cuda' | 'mps' | 'cpu' | 'mlx'
  orpheus_mlx_model        the mlx model (== orpheus on that backend)
  orpheus_model_dir        cache key half 1: the merged fine-tune dir, or None
  orpheus_base_dir         cache key half 2: the shared base dir, or None
  orpheus_lora_ids         voice token -> lora_int_id
  orpheus_lora_paths       voice token -> adapter dir
  orpheus_lora_fingerprints voice token -> (mtime_ns, size) of its safetensors
  orpheus_lora_next_id     the id counter (only ever moves forward)

e2a's `cleanup_models_cache()` (which wipes this dict for the single-process GUI)
has no narrator counterpart and is not needed: only the GUI path called it, and
that path never sets an adapter dir at all. See PORT_NOTES.md.

No torch, no vLLM, no mlx.
"""

LOADED = {}
