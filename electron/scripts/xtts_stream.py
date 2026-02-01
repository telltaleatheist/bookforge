#!/usr/bin/env python3
"""
XTTS Streaming Server for BookForge Play Tab

This script loads the XTTS model once and accepts sentence requests via stdin.
Each request generates audio chunks that are sent back as JSON lines to stdout.

Protocol:
- Requests are JSON lines on stdin
- Responses are JSON lines on stdout with types: "ready", "chunk", "done", "error"
"""

import json
import sys
import os
import base64
import io
import gc
from contextlib import nullcontext
import numpy as np
import torch
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

# Add ebook2audiobook to path
# Use environment variable if set, otherwise detect based on platform
def get_e2a_path():
    if os.environ.get('EBOOK2AUDIOBOOK_PATH'):
        return os.environ['EBOOK2AUDIOBOOK_PATH']
    # Check environment variable first, then use cross-platform default
    if os.environ.get('EBOOK2AUDIOBOOK_PATH'):
        return os.environ['EBOOK2AUDIOBOOK_PATH']

    home = os.path.expanduser('~')
    # Check -latest first, then fallback
    latest_path = os.path.join(home, 'Projects', 'ebook2audiobook-latest')
    if os.path.exists(latest_path):
        return latest_path
    return os.path.join(home, 'Projects', 'ebook2audiobook')

E2A_PATH = get_e2a_path()
sys.path.insert(0, E2A_PATH)

from huggingface_hub import hf_hub_download

# Configuration
TTS_DIR = os.path.join(E2A_PATH, 'models', 'tts')
VOICES_DIR = os.path.join(E2A_PATH, 'voices')
DEFAULT_SAMPLERATE = 24000

# Fine-tuned models available on HuggingFace (these are actual model checkpoints)
FINE_TUNED_MODELS = {
    'ScarlettJohansson': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/ScarlettJohansson/',
    },
    'DavidAttenborough': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/DavidAttenborough/',
    },
    'MorganFreeman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/MorganFreeman/',
    },
    'NeilGaiman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/NeilGaiman/',
    },
    'RayPorter': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RayPorter/',
    },
    'RosamundPike': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RosamundPike/',
    },
}


def get_available_voices() -> list:
    """Get list of available fine-tuned model voices"""
    return sorted(FINE_TUNED_MODELS.keys())


def send_response(response_type: str, data: dict = None):
    """Send a JSON response to stdout"""
    msg = {'type': response_type}
    if data:
        msg.update(data)
    print(json.dumps(msg), flush=True)


def audio_to_wav_base64(audio_array: np.ndarray, sample_rate: int = DEFAULT_SAMPLERATE) -> str:
    """Convert audio numpy array to base64-encoded WAV"""
    import wave

    # Ensure audio is in the right format
    if isinstance(audio_array, torch.Tensor):
        audio_array = audio_array.cpu().numpy()

    # Normalize and convert to int16
    audio_array = np.clip(audio_array, -1.0, 1.0)
    audio_int16 = (audio_array * 32767).astype(np.int16)

    # Write to WAV bytes
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_int16.tobytes())

    # Encode as base64
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode('utf-8')


class XTTSStreamServer:
    def __init__(self):
        self.tts = None
        self.current_voice = None
        self.gpt_cond_latent = None
        self.speaker_embedding = None
        self.device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
        self.speakers_dict = None

    def _cleanup_memory(self):
        """Clean up GPU/MPS memory after generation"""
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            torch.cuda.synchronize()
        elif hasattr(torch, 'mps') and hasattr(torch.mps, 'empty_cache'):
            torch.mps.empty_cache()

    def load_model(self, voice_name: str = 'ScarlettJohansson'):
        """Load fine-tuned XTTS model for the specified voice"""
        try:
            # Clean up before loading
            self._cleanup_memory()

            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts

            # Only fine-tuned models are supported
            if voice_name not in FINE_TUNED_MODELS:
                raise ValueError(f"Voice '{voice_name}' not found. Available: {list(FINE_TUNED_MODELS.keys())}")

            model_info = FINE_TUNED_MODELS[voice_name]
            hf_repo = model_info['repo']
            hf_sub = model_info['sub']

            # Download model files from HuggingFace
            config_path = hf_hub_download(
                repo_id=hf_repo,
                filename=f"{hf_sub}config.json",
                cache_dir=TTS_DIR
            )
            checkpoint_path = hf_hub_download(
                repo_id=hf_repo,
                filename=f"{hf_sub}model.pth",
                cache_dir=TTS_DIR
            )
            vocab_path = hf_hub_download(
                repo_id=hf_repo,
                filename=f"{hf_sub}vocab.json",
                cache_dir=TTS_DIR
            )

            # Download ref.wav for conditioning latents
            ref_path = hf_hub_download(
                repo_id=hf_repo,
                filename=f"{hf_sub}ref.wav",
                cache_dir=TTS_DIR
            )

            # Load model if not already loaded (or reload if switching voices)
            # Fine-tuned models need their specific checkpoint, so reload when switching
            if self.tts is None or self.current_voice != voice_name:
                send_response('status', {'message': f'Loading XTTS model ({self.device})...'})

                # Clean up old model if switching
                if self.tts is not None:
                    del self.tts
                    self.tts = None
                    self._cleanup_memory()

                config = XttsConfig()
                config.load_json(config_path)

                self.tts = Xtts.init_from_config(config)
                self.tts.load_checkpoint(
                    config,
                    checkpoint_path=checkpoint_path,
                    vocab_path=vocab_path,
                    eval=True
                )
                self.tts.to(self.device)

                send_response('status', {'message': 'Model loaded'})

                # Compute speaker latents from ref.wav
                send_response('status', {'message': f'Loading voice: {voice_name}'})
                self.gpt_cond_latent, self.speaker_embedding = self.tts.get_conditioning_latents(
                    audio_path=[ref_path]
                )
                self.current_voice = voice_name
                send_response('status', {'message': f'Voice loaded: {voice_name}'})

            return True

        except Exception as e:
            send_response('error', {'message': f'Failed to load model: {str(e)}'})
            return False

    def generate_sentence(self, text: str, language: str = 'en', speed: float = 1.25,
                         temperature: float = 0.75, top_p: float = 0.85,
                         repetition_penalty: float = 3.0, stream: bool = False):
        """Generate audio for a sentence and return as base64 WAV"""
        try:
            if self.tts is None or self.gpt_cond_latent is None:
                send_response('error', {'message': 'Model not loaded'})
                return

            # Ensure all parameters are floats
            temperature = float(temperature)
            top_p = float(top_p)
            repetition_penalty = float(repetition_penalty)
            speed = float(speed)

            # Use no_grad + autocast like e2a does
            # Note: inference_stream() has compatibility issues with transformers, use regular inference
            with torch.no_grad():
                autocast_ctx = torch.autocast(device_type=self.device, dtype=torch.float16) if self.device in ['cuda', 'mps'] else nullcontext()

                with autocast_ctx:
                    result = self.tts.inference(
                        text=text,
                        language=language,
                        gpt_cond_latent=self.gpt_cond_latent,
                        speaker_embedding=self.speaker_embedding,
                        temperature=temperature,
                        top_p=top_p,
                        repetition_penalty=repetition_penalty,
                        speed=speed,
                        enable_text_splitting=False
                    )
                    audio_data = result.get('wav')
                    if isinstance(audio_data, torch.Tensor):
                        audio_data = audio_data.cpu().numpy()
                    del result

            if audio_data is not None and len(audio_data) > 0:
                # Calculate duration
                duration = len(audio_data) / DEFAULT_SAMPLERATE

                # Convert to base64 WAV
                wav_base64 = audio_to_wav_base64(audio_data, DEFAULT_SAMPLERATE)

                # Clean up audio data before sending response
                del audio_data
                self._cleanup_memory()

                send_response('audio', {
                    'data': wav_base64,
                    'duration': duration,
                    'sampleRate': DEFAULT_SAMPLERATE
                })

                # Clean up base64 string after sending
                del wav_base64
            else:
                send_response('error', {'message': 'No audio generated'})

            # Final cleanup after each generation
            self._cleanup_memory()

        except Exception as e:
            self._cleanup_memory()
            send_response('error', {'message': f'Generation failed: {str(e)}'})

    def run(self):
        """Main loop: read requests from stdin, process, send responses to stdout"""
        # Discover voices from the voices directory
        available_voices = get_available_voices()
        send_response('ready', {'voices': available_voices})

        for line in sys.stdin:
            try:
                line = line.strip()
                if not line:
                    continue

                request = json.loads(line)
                action = request.get('action')

                if action == 'list_voices':
                    # Re-scan voices directory
                    voices = get_available_voices()
                    send_response('voices', {'voices': voices})

                elif action == 'load':
                    voice = request.get('voice', 'ScarlettJohansson')
                    success = self.load_model(voice)
                    if success:
                        send_response('loaded', {'voice': self.current_voice})

                elif action == 'generate':
                    text = request.get('text', '')
                    if not text:
                        send_response('error', {'message': 'No text provided'})
                        continue

                    self.generate_sentence(
                        text=text,
                        language=request.get('language', 'en'),
                        speed=request.get('speed', 1.0),
                        temperature=request.get('temperature', 0.75),
                        top_p=request.get('top_p', 0.85),
                        repetition_penalty=request.get('repetition_penalty', 3.0),
                        stream=request.get('stream', False)
                    )

                elif action == 'stop':
                    send_response('stopped')

                elif action == 'quit':
                    break

                else:
                    send_response('error', {'message': f'Unknown action: {action}'})

            except json.JSONDecodeError as e:
                send_response('error', {'message': f'Invalid JSON: {str(e)}'})
            except Exception as e:
                send_response('error', {'message': f'Error: {str(e)}'})


if __name__ == '__main__':
    server = XTTSStreamServer()
    server.run()
