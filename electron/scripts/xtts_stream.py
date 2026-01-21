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
import numpy as np
import torch
import warnings

# Suppress warnings
warnings.filterwarnings('ignore')

# Add ebook2audiobook to path
E2A_PATH = '/Users/telltale/Projects/ebook2audiobook'
sys.path.insert(0, E2A_PATH)

from huggingface_hub import hf_hub_download

# Configuration
TTS_DIR = os.path.join(E2A_PATH, 'models', 'tts')
VOICES_DIR = os.path.join(E2A_PATH, 'voices')
DEFAULT_SAMPLERATE = 24000

# Fine-tuned models available
FINE_TUNED_MODELS = {
    'ScarlettJohansson': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/ScarlettJohansson/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'female', 'ScarlettJohansson_24000.wav')
    },
    'DavidAttenborough': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/DavidAttenborough/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'elder', 'male', 'DavidAttenborough_24000.wav')
    },
    'MorganFreeman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/MorganFreeman/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'male', 'MorganFreeman_24000.wav')
    },
    'NeilGaiman': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/NeilGaiman/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'male', 'NeilGaiman_24000.wav')
    },
    'RayPorter': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RayPorter/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'male', 'RayPorter_24000.wav')
    },
    'RosamundPike': {
        'repo': 'drewThomasson/fineTunedTTSModels',
        'sub': 'xtts-v2/eng/RosamundPike/',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'female', 'RosamundPike_24000.wav')
    },
    'internal': {
        'repo': 'coqui/XTTS-v2',
        'sub': '',
        'voice': os.path.join(VOICES_DIR, 'eng', 'adult', 'male', 'KumarDahl_24000.wav')
    }
}

# Internal voice names from speakers_xtts.pth
INTERNAL_VOICES = {
    "ClaribelDervla": "Claribel Dervla", "DaisyStudious": "Daisy Studious", "GracieWise": "Gracie Wise",
    "TammieEma": "Tammie Ema", "AlisonDietlinde": "Alison Dietlinde", "AnaFlorence": "Ana Florence",
    "AnnmarieNele": "Annmarie Nele", "AsyaAnara": "Asya Anara", "BrendaStern": "Brenda Stern",
    "GittaNikolina": "Gitta Nikolina", "HenrietteUsha": "Henriette Usha", "SofiaHellen": "Sofia Hellen",
    "TammyGrit": "Tammy Grit", "TanjaAdelina": "Tanja Adelina", "VjollcaJohnnie": "Vjollca Johnnie",
    "AndrewChipper": "Andrew Chipper", "BadrOdhiambo": "Badr Odhiambo", "DionisioSchuyler": "Dionisio Schuyler",
    "RoystonMin": "Royston Min", "ViktorEka": "Viktor Eka", "AbrahanMack": "Abrahan Mack",
    "AddeMichal": "Adde Michal", "BaldurSanjin": "Baldur Sanjin", "CraigGutsy": "Craig Gutsy",
    "DamienBlack": "Damien Black", "GilbertoMathias": "Gilberto Mathias", "IlkinUrbano": "Ilkin Urbano",
    "KazuhikoAtallah": "Kazuhiko Atallah", "LudvigMilivoj": "Ludvig Milivoj", "SuadQasim": "Suad Qasim",
    "TorcullDiarmuid": "Torcull Diarmuid", "ViktorMenelaos": "Viktor Menelaos", "ZacharieAimilios": "Zacharie Aimilios",
    "NovaHogarth": "Nova Hogarth", "MajaRuoho": "Maja Ruoho", "UtaObando": "Uta Obando",
}


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

    def load_model(self, voice_name: str = 'ScarlettJohansson'):
        """Load or switch XTTS model and voice"""
        try:
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts

            # Determine model paths
            if voice_name in FINE_TUNED_MODELS:
                model_info = FINE_TUNED_MODELS[voice_name]
            else:
                model_info = FINE_TUNED_MODELS['internal']
                voice_name = 'internal'

            # Download model files
            hf_repo = model_info['repo']
            hf_sub = model_info['sub']

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

            # Load speakers dictionary for internal voices
            if voice_name == 'internal' and self.speakers_dict is None:
                speakers_path = hf_hub_download(
                    repo_id=hf_repo,
                    filename="speakers_xtts.pth",
                    cache_dir=TTS_DIR
                )
                self.speakers_dict = torch.load(speakers_path)

            # Load model if not already loaded or if switching to different fine-tuned model
            if self.tts is None:
                send_response('status', {'message': f'Loading XTTS model ({self.device})...'})

                config = XttsConfig()
                config.load_json(config_path)

                self.tts = Xtts.init_from_config(config)
                # Use keyword arguments to avoid parameter order issues
                self.tts.load_checkpoint(
                    config,
                    checkpoint_path=checkpoint_path,
                    vocab_path=vocab_path,
                    use_deepspeed=False
                )
                self.tts.to(self.device)

                send_response('status', {'message': 'Model loaded'})

            # Compute speaker latents for the voice
            if self.current_voice != voice_name:
                send_response('status', {'message': f'Loading voice: {voice_name}'})

                # Check if it's an internal speaker
                if voice_name in INTERNAL_VOICES and self.speakers_dict:
                    speaker_name = INTERNAL_VOICES[voice_name]
                    if speaker_name in self.speakers_dict:
                        self.gpt_cond_latent, self.speaker_embedding = self.speakers_dict[speaker_name].values()
                    else:
                        # Use voice file
                        voice_path = model_info['voice']
                        self.gpt_cond_latent, self.speaker_embedding = self.tts.get_conditioning_latents(
                            audio_path=[voice_path]
                        )
                else:
                    # Use voice file for fine-tuned models
                    voice_path = model_info['voice']
                    if os.path.exists(voice_path):
                        self.gpt_cond_latent, self.speaker_embedding = self.tts.get_conditioning_latents(
                            audio_path=[voice_path]
                        )
                    else:
                        # Fallback: try ref.wav in model directory
                        model_dir = os.path.dirname(checkpoint_path)
                        ref_path = os.path.join(model_dir, 'ref.wav')
                        if os.path.exists(ref_path):
                            self.gpt_cond_latent, self.speaker_embedding = self.tts.get_conditioning_latents(
                                audio_path=[ref_path]
                            )
                        else:
                            raise FileNotFoundError(f"Voice file not found: {voice_path}")

                self.current_voice = voice_name
                send_response('status', {'message': f'Voice loaded: {voice_name}'})

            return True

        except Exception as e:
            send_response('error', {'message': f'Failed to load model: {str(e)}'})
            return False

    def generate_sentence(self, text: str, language: str = 'en', speed: float = 1.0,
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

            # Use inference_mode for better performance
            with torch.inference_mode():
                if stream and hasattr(self.tts, 'inference_stream'):
                    # Streaming mode - yield chunks as they're generated
                    chunks = []
                    for chunk in self.tts.inference_stream(
                        text=text,
                        language=language,
                        gpt_cond_latent=self.gpt_cond_latent,
                        speaker_embedding=self.speaker_embedding,
                        temperature=temperature,
                        top_p=top_p,
                        repetition_penalty=repetition_penalty,
                        speed=speed,
                        enable_text_splitting=False
                    ):
                        if isinstance(chunk, torch.Tensor):
                            chunk = chunk.cpu().numpy()
                        chunks.append(chunk)

                    # Concatenate all chunks
                    if chunks:
                        audio_data = np.concatenate(chunks)
                    else:
                        audio_data = None
                else:
                    # Non-streaming mode
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

            if audio_data is not None and len(audio_data) > 0:
                # Calculate duration
                duration = len(audio_data) / DEFAULT_SAMPLERATE

                # Convert to base64 WAV
                wav_base64 = audio_to_wav_base64(audio_data, DEFAULT_SAMPLERATE)

                send_response('audio', {
                    'data': wav_base64,
                    'duration': duration,
                    'sampleRate': DEFAULT_SAMPLERATE
                })
            else:
                send_response('error', {'message': 'No audio generated'})

        except Exception as e:
            send_response('error', {'message': f'Generation failed: {str(e)}'})

    def run(self):
        """Main loop: read requests from stdin, process, send responses to stdout"""
        send_response('ready', {'voices': list(FINE_TUNED_MODELS.keys())})

        for line in sys.stdin:
            try:
                line = line.strip()
                if not line:
                    continue

                request = json.loads(line)
                action = request.get('action')

                if action == 'load':
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
