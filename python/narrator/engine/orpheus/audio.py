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

    def _write_silence(self, sentence_index: int) -> bool:
        """Write a tiny silent clip for an empty sentence."""
        import torch
        import torchaudio
        silence = torch.zeros(1, int(self.params['samplerate'] * 0.1))
        torchaudio.save(self._sentence_file(sentence_index), silence,
                        self.params['samplerate'], format=self.config.audio_format)
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
        import torch
        import torchaudio
        if audio_np is None or len(audio_np) == 0:
            print(f"Orpheus returned no audio data for sentence {sentence_index}")
            return False
        final_sentence_file = self._sentence_file(sentence_index)
        audio_tensor = torch.from_numpy(audio_np).float()
        # NO-FALLBACK (2026-07-11): the trailing-silence trim was REMOVED here. It
        # silently erased the runaway silence a mis-behaving model emits (a stop-token
        # failure), masking the bug and destroying data - a forbidden fallback. The
        # end-of-sentence pause is added DETERMINISTICALLY below (trail_gap); the model
        # must be trained to stop cleanly (trimmed-tail clips), not have its dead air
        # papered over at save time. If a clip has abnormal trailing silence, that must
        # be VISIBLE, not hidden.
        if audio_tensor.dim() == 1:
            audio_tensor = audio_tensor.unsqueeze(0)
        # Normalize to prevent clipping
        max_val = audio_tensor.abs().max()
        if max_val > 0:
            if max_val > 1.0:
                audio_tensor = audio_tensor / max_val * 0.95
        else:
            audio_tensor = torch.zeros(1, int(self.params['samplerate'] * 0.1))
        # Inter-clip silence (tiers + durations decided by _classify_gap). The
        # leading pad is prepended (a boundary opening a new paragraph isn't placed
        # one sentence too late) and the trailing pad appended - BOTH can apply so
        # the tail is never bare.
        if (lead_gap and lead_gap > 0) or (trail_gap and trail_gap > 0):
            audio_tensor = audio_tensor.cpu()
            if lead_gap and lead_gap > 0:
                lead_pad = torch.zeros(1, int(self.params['samplerate'] * lead_gap))
                audio_tensor = torch.cat([lead_pad, audio_tensor], dim=1)
            if trail_gap and trail_gap > 0:
                trail_pad = torch.zeros(1, int(self.params['samplerate'] * trail_gap))
                audio_tensor = torch.cat([audio_tensor, trail_pad], dim=1)
        torchaudio.save(final_sentence_file, audio_tensor.cpu(),
                        self.params['samplerate'], format=self.config.audio_format)
        del audio_tensor
        if os.path.exists(final_sentence_file):
            return True
        print(f"Failed to create {final_sentence_file}")
        return False
