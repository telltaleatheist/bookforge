#!/usr/bin/env python3
"""
XTTS Streaming Server for BookForge Play Tab

This script loads the XTTS model once and accepts sentence requests via stdin.
Audio is returned as base64 PCM16 (24kHz mono) JSON lines on stdout.

Protocol (one JSON object per line):
  stdin:  {action: 'load', voice}
          {action: 'generate', text, language?, speed?, temperature?, top_p?,
           repetition_penalty?, stream?: bool}
          {action: 'cancel'}   # only honored between stream chunks
          {action: 'list_voices' | 'stop' | 'quit'}
  stdout: {type: 'ready', voices}
          {type: 'status' | 'loaded' | 'voices' | 'error' | 'stopped', ...}
          {type: 'audio', format: 'pcm16', data, duration, sampleRate}        # batch
          {type: 'chunk', seq, format: 'pcm16', data, duration, sampleRate}   # stream
          {type: 'done', duration, chunks, cancelled}                          # stream end
"""

import json
import select
import sys
import os
import base64
import gc
from contextlib import nullcontext
import numpy as np
import torch
import warnings
import psutil

# Suppress warnings
warnings.filterwarnings('ignore')

# XTTS GPT decode is sequential (token-by-token) and gains nothing past ~4
# threads. Pinning lets multiple workers share the P-cores without contention:
# benchmarked on M1 Ultra, 4 workers x 4 threads -> RTF ~1.9 per worker.
XTTS_THREADS = int(os.environ.get('XTTS_THREADS', '4'))
torch.set_num_threads(XTTS_THREADS)

# Clean up GPU caches / run gc only every N generations - gc.collect() on a
# multi-GB heap costs hundreds of ms, which used to run twice per sentence.
CLEANUP_EVERY_N_GENERATIONS = 50


def log_memory(label: str):
    """Log current memory usage for debugging."""
    process = psutil.Process(os.getpid())
    mem_info = process.memory_info()
    rss_gb = mem_info.rss / (1024 ** 3)
    print(f"[STREAM-MEMORY] {label}: {rss_gb:.2f} GB RSS", file=sys.stderr, flush=True)


# Add ebook2audiobook to path
def get_e2a_path():
    if os.environ.get('EBOOK2AUDIOBOOK_PATH'):
        return os.environ['EBOOK2AUDIOBOOK_PATH']
    home = os.path.expanduser('~')
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
# 'voice_path' is the local voice file for conditioning latents (relative to VOICES_DIR)
FINE_TUNED_MODELS = {
    'ScarlettJohansson': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/ScarlettJohansson/',
        'voice_path': 'eng/adult/female/ScarlettJohansson.wav',
    },
    'DavidAttenborough': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/DavidAttenborough/',
        'voice_path': 'eng/adult/male/DavidAttenborough.wav',
    },
    'MorganFreeman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/MorganFreeman/',
        'voice_path': 'eng/adult/male/MorganFreeman.wav',
    },
    'NeilGaiman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/NeilGaiman/',
        'voice_path': 'eng/adult/male/NeilGaiman.wav',
    },
    'RayPorter': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RayPorter/',
        'voice_path': 'eng/adult/male/RayPorter.wav',
    },
    'RosamundPike': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RosamundPike/',
        'voice_path': 'eng/adult/female/RosamundPike.wav',
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


def audio_to_pcm16_base64(audio_array) -> str:
    """Convert float audio (numpy or tensor) to base64-encoded raw PCM16."""
    if isinstance(audio_array, torch.Tensor):
        audio_array = audio_array.cpu().numpy()
    audio_array = np.clip(audio_array, -1.0, 1.0)
    audio_int16 = (audio_array * 32767).astype(np.int16)
    return base64.b64encode(audio_int16.tobytes()).decode('utf-8')


def read_pending_action() -> str | None:
    """Non-blocking peek at stdin between stream chunks.

    Returns the action of a pending request ('cancel'/'quit') if one arrived,
    consuming it. The pool only ever sends 'cancel' or 'quit' while a
    generation is in flight, so anything else is ignored.
    """
    try:
        readable, _, _ = select.select([sys.stdin], [], [], 0)
        if not readable:
            return None
        line = sys.stdin.readline()
        if not line:
            return 'quit'  # stdin closed - parent died
        line = line.strip()
        if not line:
            return None
        request = json.loads(line)
        return request.get('action')
    except (json.JSONDecodeError, ValueError):
        return None


class XTTSStreamServer:
    def __init__(self):
        self.tts = None
        self.current_voice = None
        self.gpt_cond_latent = None
        self.speaker_embedding = None
        # Use CPU on Mac - MPS causes memory pressure without speed benefits for XTTS
        # CUDA still preferred on Linux/Windows where it provides real speedup
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.speakers_dict = None
        self.generations_since_cleanup = 0

    def _cleanup_memory(self):
        """Clean up GPU/MPS memory after generation"""
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            torch.cuda.synchronize()
        elif hasattr(torch, 'mps') and hasattr(torch.mps, 'empty_cache'):
            torch.mps.empty_cache()

    def _maybe_cleanup(self):
        self.generations_since_cleanup += 1
        if self.generations_since_cleanup >= CLEANUP_EVERY_N_GENERATIONS:
            self.generations_since_cleanup = 0
            self._cleanup_memory()

    def load_model(self, voice_name: str = 'ScarlettJohansson'):
        """Load fine-tuned XTTS model for the specified voice"""
        try:
            log_memory("Before load_model cleanup")
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

            # Use local voice file for conditioning latents
            voice_rel_path = model_info.get('voice_path')
            if voice_rel_path:
                ref_path = os.path.join(VOICES_DIR, voice_rel_path)
                if not os.path.exists(ref_path):
                    raise FileNotFoundError(f"Voice file not found: {ref_path}")
            else:
                raise ValueError(f"No voice_path configured for {voice_name}")

            # Load model if not already loaded (or reload if switching voices)
            # Fine-tuned models need their specific checkpoint, so reload when switching
            if self.tts is None or self.current_voice != voice_name:
                send_response('status', {'message': f'Loading XTTS model ({self.device})...'})
                log_memory("Before model load")

                # Clean up old model if switching
                if self.tts is not None:
                    del self.tts
                    self.tts = None
                    self._cleanup_memory()
                    log_memory("After cleanup old model")

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
                log_memory(f"After to({self.device})")

                send_response('status', {'message': 'Model loaded'})

                # Compute speaker latents from ref.wav
                send_response('status', {'message': f'Loading voice: {voice_name}'})
                self.gpt_cond_latent, self.speaker_embedding = self.tts.get_conditioning_latents(
                    audio_path=[ref_path]
                )
                log_memory("After get_conditioning_latents")
                self.current_voice = voice_name
                send_response('status', {'message': f'Voice loaded: {voice_name}'})

            return True

        except Exception as e:
            send_response('error', {'message': f'Failed to load model: {str(e)}'})
            return False

    def _autocast_ctx(self):
        if self.device in ['cuda', 'mps']:
            return torch.autocast(device_type=self.device, dtype=torch.float16)
        return nullcontext()

    def generate_sentence(self, text: str, language: str = 'en', speed: float = 1.25,
                          temperature: float = 0.75, top_p: float = 0.85,
                          repetition_penalty: float = 3.0):
        """Generate audio for a whole sentence and return one PCM16 message."""
        try:
            if self.tts is None or self.gpt_cond_latent is None:
                send_response('error', {'message': 'Model not loaded'})
                return

            with torch.no_grad():
                with self._autocast_ctx():
                    result = self.tts.inference(
                        text=text,
                        language=language,
                        gpt_cond_latent=self.gpt_cond_latent,
                        speaker_embedding=self.speaker_embedding,
                        temperature=float(temperature),
                        top_p=float(top_p),
                        repetition_penalty=float(repetition_penalty),
                        speed=float(speed),
                        enable_text_splitting=False
                    )
                    audio_data = result.get('wav')
                    if isinstance(audio_data, torch.Tensor):
                        audio_data = audio_data.cpu().numpy()
                    del result

            if audio_data is not None and len(audio_data) > 0:
                duration = len(audio_data) / DEFAULT_SAMPLERATE
                send_response('audio', {
                    'format': 'pcm16',
                    'data': audio_to_pcm16_base64(audio_data),
                    'duration': duration,
                    'sampleRate': DEFAULT_SAMPLERATE
                })
                del audio_data
            else:
                send_response('error', {'message': 'No audio generated'})

            self._maybe_cleanup()

        except Exception as e:
            self._cleanup_memory()
            send_response('error', {'message': f'Generation failed: {str(e)}'})

    def generate_sentence_stream(self, text: str, language: str = 'en', speed: float = 1.25,
                                 temperature: float = 0.75, top_p: float = 0.85,
                                 repetition_penalty: float = 3.0):
        """Generate audio chunk-by-chunk via inference_stream().

        First chunk lands in ~2-3s on CPU (vs waiting the whole sentence).
        Requires coqui-tts >= 0.27.3 for transformers >= 4.57 compatibility.
        Returns True if the caller should quit (stdin closed / quit received).
        """
        try:
            if self.tts is None or self.gpt_cond_latent is None:
                send_response('error', {'message': 'Model not loaded'})
                return False

            total_samples = 0
            seq = 0
            cancelled = False
            should_quit = False

            with torch.no_grad():
                with self._autocast_ctx():
                    stream = self.tts.inference_stream(
                        text=text,
                        language=language,
                        gpt_cond_latent=self.gpt_cond_latent,
                        speaker_embedding=self.speaker_embedding,
                        temperature=float(temperature),
                        top_p=float(top_p),
                        repetition_penalty=float(repetition_penalty),
                        speed=float(speed),
                        enable_text_splitting=False,
                        stream_chunk_size=20,
                    )
                    for chunk in stream:
                        if isinstance(chunk, torch.Tensor):
                            chunk = chunk.cpu().numpy()
                        if chunk is None or len(chunk) == 0:
                            continue
                        total_samples += len(chunk)
                        send_response('chunk', {
                            'seq': seq,
                            'format': 'pcm16',
                            'data': audio_to_pcm16_base64(chunk),
                            'duration': len(chunk) / DEFAULT_SAMPLERATE,
                            'sampleRate': DEFAULT_SAMPLERATE
                        })
                        seq += 1

                        pending = read_pending_action()
                        if pending == 'cancel':
                            cancelled = True
                            break
                        if pending == 'quit':
                            cancelled = True
                            should_quit = True
                            break

            send_response('done', {
                'duration': total_samples / DEFAULT_SAMPLERATE,
                'chunks': seq,
                'cancelled': cancelled
            })
            self._maybe_cleanup()
            return should_quit

        except Exception as e:
            self._cleanup_memory()
            send_response('error', {'message': f'Streaming generation failed: {str(e)}'})
            return False

    def run(self):
        """Main loop: read requests from stdin, process, send responses to stdout"""
        available_voices = get_available_voices()
        send_response('ready', {'voices': available_voices})

        while True:
            line = sys.stdin.readline()
            if not line:
                break  # stdin closed
            try:
                line = line.strip()
                if not line:
                    continue

                request = json.loads(line)
                action = request.get('action')

                if action == 'list_voices':
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

                    kwargs = dict(
                        text=text,
                        language=request.get('language', 'en'),
                        speed=request.get('speed', 1.0),
                        temperature=request.get('temperature', 0.75),
                        top_p=request.get('top_p', 0.85),
                        repetition_penalty=request.get('repetition_penalty', 3.0),
                    )
                    if request.get('stream', False):
                        if self.generate_sentence_stream(**kwargs):
                            break  # quit received mid-stream
                    else:
                        self.generate_sentence(**kwargs)

                elif action == 'cancel':
                    # Nothing in flight (cancel mid-stream is consumed by
                    # read_pending_action) - acknowledge and move on.
                    send_response('stopped')

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
