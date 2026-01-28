# Orpheus TTS Setup Guide

Orpheus is a SOTA open-source TTS engine that produces better prosody and naturalness than XTTS, ideal for audiobooks.

## Platform-Specific Setup

### Mac (Apple Silicon) - MLX Backend

MLX is the fastest backend on Mac (~1.4x realtime).

```bash
pip install mlx-audio
```

Model `mlx-community/orpheus-3b-0.1-ft-bf16` downloads automatically on first run.

### Windows/Linux (CUDA) - vLLM Backend

vLLM provides fast batched inference on CUDA GPUs.

```bash
pip install vllm
pip install snac
```

Model `unsloth/orpheus-3b-0.1-ft` downloads automatically on first run (~6GB).

### Fallback - Transformers Backend

Works everywhere but is SLOW (~27x realtime on Mac MPS).

```bash
pip install transformers snac accelerate
```

**Warning:** On Mac, always install mlx-audio instead. Transformers is ~19x slower.

## Important: Single Worker Only

Unlike XTTS, Orpheus does NOT benefit from multiple workers:
- MLX uses unified memory - workers compete, no speedup
- vLLM has built-in batching - single instance is optimal

**Always run Orpheus with workers=1**

## Voices

8 American English voices available:
- `tara` (default, most natural)
- `leah`, `jess`, `leo`, `dan`, `mia`, `zac`, `zoe`

## Emotion Tags

Embed in text for expressiveness:
```
<laugh>, <chuckle>, <sigh>, <cough>, <sniffle>, <groan>, <yawn>, <gasp>
```

## Performance Expectations

| Platform | Backend | Realtime Factor | 10-hour Audiobook |
|----------|---------|-----------------|-------------------|
| Mac (Apple Silicon) | MLX | 1.4x | ~14 hours |
| Windows (3090 Ti) | vLLM | 2-5x | ~20-50 hours |
| Mac (MPS) | Transformers | 27x | ~11 days |

## e2a Integration

The Orpheus engine in ebook2audiobook auto-detects the best backend:

```
lib/classes/tts_engines/orpheus.py
```

Key points:
- Uses `mlx-community/orpheus-3b-0.1-ft-bf16` for MLX
- Uses `unsloth/orpheus-3b-0.1-ft` for vLLM/Transformers
- Sample rate: 24000 Hz
- Prompt format: `{voice}: {text}` (no special tokens)

## Troubleshooting

### "No Orpheus backend available"
Install one of the backends listed above.

### Model download fails
The models are ungated and should download automatically. If issues persist, check your internet connection and HuggingFace availability.

### Audio has garbage at the end
The engine should truncate at the end-of-audio token (128258). If you hear noise, ensure you're using the latest orpheus.py.

### Very slow on Mac
Make sure mlx-audio is installed. If using transformers backend, you'll see a warning:
```
WARNING: Transformers on Mac MPS is ~27x slower than MLX!
```
