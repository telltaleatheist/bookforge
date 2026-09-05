"""Waveform in, sentence file out - plus the silence trim the rate guard
measures against.

Ported from ebook2audiobook@9daab0ba:
  lib/classes/tts_engines/common/audio.py    trim_audio (36)
  lib/classes/tts_engines/common/utils.py    TTSUtils._cleanup_memory (24)
  lib/classes/tts_engines/orpheus.py         _sentence_file (4039),
                                             _write_silence (4139),
                                             _save_audio (4561)

`trim_audio` came from the shared engine helpers e2a's `headers` re-exported;
narrator has no such shared module, so it lives here beside its only caller
(`_speech_rate`) - and the parameters that caller passes (silence_threshold
0.01, buffer_sec 0.20) are the ones that decide what "speech seconds" means for
the truncation guard.

torch/torchaudio are imported LAZILY inside each function, so this module is
importable on an interpreter that has neither.

WRITING GOES THROUGH `soundfile`, NOT torchaudio - one writer, PCM_16, on every
backend. See `AudioMixin.write_chunk_file` for the two measured reasons (a
wheel-dependent FFmpeg requirement, and PCM_24-vs-PCM_16 chunks that the concat
demuxer drops frames on). Reading is unchanged from the port.
"""
import os


def trim_audio(audio_data, samplerate: int, silence_threshold: float = 0.003,
               buffer_sec: float = 0.005):
    """Strip leading/trailing silence from a 1-D mono tensor, keeping
    `buffer_sec` of it either side. Returns an EMPTY tensor when the whole clip
    is below the threshold."""
    import torch
    from torch import Tensor
    # Ensure audio_data is a PyTorch tensor
    if isinstance(audio_data, list):
        audio_data = torch.tensor(audio_data, dtype=torch.float32)
    if isinstance(audio_data, Tensor):
        if audio_data.ndim != 1:
            error = "audio_data must be a 1D tensor (mono audio)."
            raise ValueError(error)
        if audio_data.device.type != "cpu":
            audio_data = audio_data.cpu()
        # Detect non-silent indices
        non_silent_indices = torch.where(audio_data.abs() > silence_threshold)[0]
        if len(non_silent_indices) == 0:
            return torch.tensor([], dtype=audio_data.dtype)  # Preserves dtype
        # Calculate start and end trimming indices with buffer
        start_index = max(non_silent_indices[0].item() - int(buffer_sec * samplerate), 0)
        end_index = min(non_silent_indices[-1].item() + int(buffer_sec * samplerate),
                        audio_data.size(0))
        return audio_data[start_index:end_index]
    error = "audio_data must be a PyTorch tensor or a list of numerical values."
    raise TypeError(error)


class AudioMixin:

    def _cleanup_memory(self) -> None:
        """Drop host and device garbage between chunks. Ported from TTSUtils."""
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
            torch.cuda.synchronize()
        elif torch.backends.mps.is_available():
            # MPS (Apple Silicon) memory cleanup. Note: on non-Apple CPU builds
            # torch.mps.empty_cache exists but raises ("Cannot execute emptyCache()
            # without MPS backend"), so we must gate on the backend actually being
            # available, not merely on the attribute existing.
            torch.mps.empty_cache()

    def _sentence_file(self, sentence_index: int) -> str:
        """Where chunk `sentence_index` is written.

        e2a read `session['sentences_dir']`; narrator reads the same value off
        EngineConfig. It is REQUIRED here - a caller that renders to disk without
        one is a bug, not a case to invent a directory for.
        """
        sentences_dir = self.config.sentences_dir
        if not sentences_dir:
            raise ValueError(
                'OrpheusEngine has no sentences_dir: this engine was built for '
                'in-memory generation, so it cannot write sentence files. Set '
                'EngineConfig.sentences_dir, or call the in-memory generation '
                'methods instead of convert()/convert_batch().')
        return os.path.join(sentences_dir, f'{sentence_index}.{self.config.audio_format}')

    def write_chunk_file(self, path: str, audio, samplerate: int) -> None:
        """THE ONE WRITER for every chunk file narrator produces.

        DELIBERATE DEVIATION FROM THE PORT (ruled 2026-09-04, after the Mac MLX
        run). e2a wrote chunks with `torchaudio.save(..., format='flac')`. Two
        things are wrong with that, and both are invisible until late:

        1. IT IS WHEEL-DEPENDENT. On current wheels (torch 2.14 / torchaudio
           2.11) `torchaudio.save` routes through TorchCodec and needs the
           FFmpeg dylibs; without them every single sentence fails with
           "TorchCodec is required", which on the Mac meant a per-sentence
           failure until ffmpeg was conda-installed. A renderer's file writer
           must not depend on a media stack that may or may not be in the env.
        2. IT IS BIT-DEPTH-UNSTABLE. The same call produced PCM_24 there and
           PCM_16 under WSL/vLLM. Mixed bit depths across one session's chunks
           are exactly what ffmpeg's concat demuxer drops frames on, SILENTLY -
           the failure mode that ate sentences out of an assembled book before.

        So every backend - vLLM, MLX, transformers - writes through
        `soundfile.write(..., subtype='PCM_16')`. soundfile is already a base
        dependency (it has no FFmpeg dependency of its own), the subtype is
        stated rather than inferred, and the result is identical on every
        platform. torchaudio is no longer used to WRITE anything; the READ side
        (resume, trim) is unchanged from the port.

        `audio` is a float32 numpy array or a torch tensor of shape (1, N) or
        (N,); mono is the only shape narrator produces.
        """
        import numpy as np
        import soundfile as sf
        if hasattr(audio, 'detach'):
            audio = audio.detach().cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim == 2:
            if audio.shape[0] != 1:
                raise ValueError(
                    f'{path}: narrator writes MONO chunks; got shape '
                    f'{audio.shape}.')
            audio = audio[0]
        if audio.ndim != 1:
            raise ValueError(f'{path}: expected a 1-D waveform, got shape '
                             f'{audio.shape}.')
        # The container comes from the PATH's own extension, not from a config
        # field: the reject-clip writer asks for .wav and the chunk writer for
        # .flac, through this one function. Both are PCM_16.
        container = os.path.splitext(path)[1].lstrip('.').upper() or 'FLAC'
        sf.write(path, audio, int(samplerate), subtype='PCM_16',
                 format=container)

    def _write_silence(self, sentence_index: int) -> bool:
        """Write a tiny silent clip for an empty sentence."""
        import numpy as np
        rate = self.params['samplerate']
        self.write_chunk_file(self._sentence_file(sentence_index),
                              np.zeros(int(rate * 0.1), dtype=np.float32), rate)
        return True

    def _save_audio(self, sentence_index: int, audio_np, lead_gap: float = 0.0,
                    trail_gap: float = 0.0) -> bool:
        """Normalize, add the inter-clip pauses, and write a decoded waveform to
        the sentence file. Shared by convert(), convert_batch() and
        _convert_mlx_batch(). (lead_gap, trail_gap) come from _classify_gap():
        the trailing gap is appended after the speech, the leading gap prepended
        before it. Both can be non-zero - a chunk opened by a boundary token gets
        a long lead AND still gets its sentence-gap tail, so a chunk's tail is
        never bare (the invariant _classify_gap guarantees)."""
        import numpy as np
        if audio_np is None or len(audio_np) == 0:
            print(f"Orpheus returned no audio data for sentence {sentence_index}")
            return False
        final_sentence_file = self._sentence_file(sentence_index)
        # NUMPY, NOT TORCH (2026-09-04, with the soundfile writer). The
        # arithmetic below is a max, a scale and two concatenations - nothing
        # that needed a tensor - and torch here was the last thing keeping the
        # MLX render path dependent on a torch install for WRITING a file.
        # Values, order and results are identical.
        audio_tensor = np.asarray(audio_np, dtype=np.float32)
        # NO-FALLBACK (2026-07-11): the trailing-silence trim was REMOVED here. It
        # silently erased the runaway silence a mis-behaving model emits (a stop-token
        # failure), masking the bug and destroying data - a forbidden fallback. The
        # end-of-sentence pause is added DETERMINISTICALLY below (trail_gap); the model
        # must be trained to stop cleanly (trimmed-tail clips), not have its dead air
        # papered over at save time. If a clip has abnormal trailing silence, that must
        # be VISIBLE, not hidden.
        if audio_tensor.ndim == 1:
            audio_tensor = audio_tensor.reshape(1, -1)
        # Normalize to prevent clipping
        max_val = float(np.abs(audio_tensor).max())
        if max_val > 0:
            if max_val > 1.0:
                audio_tensor = audio_tensor / max_val * 0.95
        else:
            audio_tensor = np.zeros((1, int(self.params['samplerate'] * 0.1)),
                                    dtype=np.float32)
        # Inter-clip silence (tiers + durations decided by _classify_gap). The
        # leading pad is prepended (a boundary opening a new paragraph isn't placed
        # one sentence too late) and the trailing pad appended - BOTH can apply so
        # the tail is never bare.
        if (lead_gap and lead_gap > 0) or (trail_gap and trail_gap > 0):
            if lead_gap and lead_gap > 0:
                lead_pad = np.zeros((1, int(self.params['samplerate'] * lead_gap)),
                                    dtype=np.float32)
                audio_tensor = np.concatenate([lead_pad, audio_tensor], axis=1)
            if trail_gap and trail_gap > 0:
                trail_pad = np.zeros((1, int(self.params['samplerate'] * trail_gap)),
                                     dtype=np.float32)
                audio_tensor = np.concatenate([audio_tensor, trail_pad], axis=1)
        # ONE WRITER, PCM_16, every backend - see write_chunk_file for why this
        # is not torchaudio.save any more.
        self.write_chunk_file(final_sentence_file, audio_tensor,
                              self.params['samplerate'])
        del audio_tensor
        if os.path.exists(final_sentence_file):
            return True
        print(f"Failed to create {final_sentence_file}")
        return False
