# Audio Enhancement Testing Notes

**Date**: January 29, 2025
**Status**: SUCCESS - Resemble Enhance works great!

## Problem
Orpheus TTS (Tara voice) has echo/reverb baked into the model. DeepFilterNet doesn't fix it.

## Solution Found
**Resemble Enhance** successfully removes the reverb and produces clean, natural-sounding audio. Testing confirmed it sounds "fantastic" on Orpheus TTS output.

## Integration Status: COMPLETE

Resemble Enhance is now integrated into BookForgeApp:

### Automatic Enhancement (Orpheus TTS)
- **Runs automatically** after TTS assembly when Orpheus engine is used
- No user action required - enhancement happens as part of the conversion pipeline
- If Resemble Enhance is not set up, conversion completes normally (no error)

### Manual Enhancement (Post-Processing Tab)
- Navigate to **Post-Processing** tab in the app
- Select audio files to enhance
- Click "Enhance Selected Files"
- Works with any audio file (M4B, M4A, MP3, WAV, etc.)

### Files Modified
- `electron/resemble-bridge.ts` - New bridge for Resemble Enhance
- `electron/parallel-tts-bridge.ts` - Auto-enhancement after Orpheus assembly
- `electron/main.ts` - IPC handlers for resemble operations
- `electron/preload.ts` - Exposed resemble API to renderer
- `electron/tool-paths.ts` - Configuration for resemble conda env
- `src/app/core/services/electron.service.ts` - Angular service methods
- `src/app/features/post-processing/post-processing.component.ts` - UI updated

### Notes
- Enhancement runs AFTER assembly completes
- Heavy on memory/CPU - don't run other heavy processes simultaneously
- Models download automatically on first run (~300MB)

## Tools Tested

### 1. Facebook Denoiser
- **Status**: Works but not suitable
- **Result**: Made audio muffled, worse than original
- **Install**: `pip install denoiser`
- **Use case**: Background noise removal, not reverb

### 2. SpeechBrain
- **Status**: Failed - dependency conflicts
- **Issue**: torchaudio version conflicts, HuggingFace API changes

### 3. Resemble Enhance
- **Status**: WORKING (with modifications)
- **Conda env**: `resemble`
- **Location**: `/tmp/resemble-enhance-repo` (patched version)

## Resemble Enhance Setup

### Create Environment
```bash
source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh
conda create -n resemble python=3.10 -y
conda activate resemble
```

### Install Dependencies
```bash
pip install torch==2.1.1 torchaudio==2.1.1 torchvision==0.16.1
pip install celluloid librosa matplotlib numpy==1.26.4 omegaconf pandas ptflops rich scipy soundfile tqdm resampy tabulate
```

### Clone and Patch (removes deepspeed dependency)
```bash
cd /tmp
git clone https://github.com/resemble-ai/resemble-enhance.git resemble-enhance-repo
cd resemble-enhance-repo

# Remove deepspeed from requirements
sed -i '' '/deepspeed/d' requirements.txt
sed -i '' '/gradio/d' requirements.txt
```

### Patch Files for Inference-Only Mode

**resemble_enhance/enhancer/inference.py** - Change line 9:
```python
# FROM:
from .train import Enhancer, HParams
# TO:
from .enhancer import Enhancer
from .hparams import HParams
```

**resemble_enhance/denoiser/inference.py** - Change line 7:
```python
# FROM:
from .train import Denoiser, HParams
# TO:
from .denoiser import Denoiser
from .hparams import HParams
```

**resemble_enhance/utils/distributed.py** - Replace entire file with stub:
```python
# Stub for inference without deepspeed
from functools import wraps
from typing import Callable

def get_free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]

def fix_unset_envs(): pass
def init_distributed(): pass
def local_rank(): return 0
def global_rank(): return 0
def is_local_leader(): return True
def is_global_leader(): return True

def local_leader_only(fn=None, boardcast_return=False):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper
    return decorator(fn) if fn else decorator

def global_leader_only(fn=None, boardcast_return=False):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            return func(*args, **kwargs)
        return wrapper
    return decorator(fn) if fn else decorator

def leader_only(leader_only_type, fn=None, boardcast_return=False):
    return global_leader_only(fn, boardcast_return)
```

**resemble_enhance/utils/train_loop.py** - Replace with stub:
```python
class TrainLoop:
    _running_loop = None
    @classmethod
    def get_running_loop(cls):
        return cls._running_loop

def is_global_leader():
    return True
```

**resemble_enhance/utils/__init__.py** - Replace with:
```python
from .distributed import global_leader_only
from .utils import save_mels, tree_map

try:
    from .engine import Engine, gather_attribute
    from .logging import setup_logging
    from .train_loop import TrainLoop, is_global_leader
except ImportError:
    pass
```

### Install Patched Version
```bash
pip install /tmp/resemble-enhance-repo
```

## Usage

```bash
source /opt/homebrew/Caskroom/miniconda/base/etc/profile.d/conda.sh
conda activate resemble

# Prepare input folder with WAV files
mkdir -p /tmp/enhance_input /tmp/enhance_output
ffmpeg -i input.m4b -acodec pcm_s16le -ar 44100 /tmp/enhance_input/audio.wav

# Run enhancement (CPU is more stable than MPS on Mac)
resemble-enhance /tmp/enhance_input /tmp/enhance_output --device cpu
```

### Options
- `--device cpu` - Use CPU (slower but stable)
- `--device mps` - Use Apple Silicon GPU (may need `PYTORCH_ENABLE_MPS_FALLBACK=1`)
- `--device cuda` - Use NVIDIA GPU (Windows/Linux)
- `--denoise_only` - Only denoise, skip enhancement
- `--lambd 0.5` - Denoise strength (0.0-1.0)

## Performance
- CPU on M-series Mac: ~2.5 minutes per 1 minute of audio
- Full audiobook would take many hours on CPU

## Other Tools to Try
- **Voicefixer** - Voice restoration + dereverb
- **NVIDIA Broadcast** - On Windows 3090 Ti, has echo removal
- **iZotope RX** - Professional, paid, best dereverb

## Cleanup
```bash
conda remove -n resemble --all  # Delete conda environment
rm -rf /tmp/resemble-enhance-repo  # Delete patched repo
```

## Test Results (Jan 29, 2025)

**Input**: Orpheus TTS output with Tara voice (had echo/reverb)
**Output**: Clean audio with reverb removed

### Test Files
- Input: `/tmp/resemble_test/input/sample.wav`
- Output: `/tmp/resemble_test/output/sample.wav`

### What Worked
1. CPU mode with default settings
2. Full enhancement mode (not denoise-only)
3. Command: `resemble-enhance /tmp/resemble_test/input /tmp/resemble_test/output --device cpu`

### What Didn't Work
- MPS (Apple Silicon GPU): Missing ops, fell back to CPU anyway
- PYTORCH_ENABLE_MPS_FALLBACK=1: Ran but produced empty output

### Resource Usage Warning
Running Resemble Enhance while Orpheus TTS is active can max out memory and CPU, potentially freezing other apps. Recommend:
- Run enhancement AFTER TTS completes, not during
- On Mac, close other heavy apps during enhancement
- Consider offloading to Windows machine with more VRAM

## Integration Plan for BookForgeApp

### Phase 1: Basic Integration
1. Add conda environment check in `tts-bridge.ts`
2. Add `resemble-enhance` subprocess wrapper
3. Add "Enhance Audio" checkbox in TTS Settings
4. Run enhancement as final step after M4B creation

### Phase 2: Per-Chapter Enhancement
1. Enhance each chapter WAV before merging to M4B
2. Allows parallel processing if multiple machines available
3. Can show progress per chapter

### IPC Handlers Needed
```typescript
// In electron/main.ts
'audio:check-enhance-available' // Check if resemble env exists
'audio:enhance-file'            // Enhance single WAV file
'audio:enhance-folder'          // Enhance all WAVs in folder
```

### UI Changes Needed
- Add "Enhance Audio" toggle in `tts-settings.component.ts`
- Add enhancement progress in `progress-panel.component.ts`
- Show "Enhancing..." phase after "Converting..." completes
