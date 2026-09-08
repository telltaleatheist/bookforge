#!/usr/bin/env python3
# tools/align-bakeoff.py - the forced-aligner bake-off kit (2026-09-08, PC).
#
# COMMITTED so the Mac can run the SAME measurement on the same Higgs session
# (switchboard #180: its 95-s window found qwen3 0.38 s early at 3 of 4 chunk
# starts where this kit found 890/1083 within 0.1 s after the head silence).
# Run it from any interpreter that has numpy + soundfile + the backend under
# test (qwen_asr for --arm qwen, whisperx for --arm whisperx) and ffmpeg on PATH.
# chunks.json comes from tools/align-bakeoff-chunks.js beside this file: every
# "NOTE estimated chunk N" block's first cue start in the assembled m4b's
# sentence VTT is the chunk's EXACT start (the manifest's sample sums).
"""Forced-aligner bake-off on a real audiobook with a free ground truth.

The Shift m4b was assembled from 1,313 Higgs chunks, and the assembly's own
transcript records where every chunk STARTS in the finished file (the manifest's
running sum of sample counts; the sentence divisions inside a chunk are
estimates, the chunk starts are not). So every chunk boundary is a known
sentence-start time, and an aligner given the book text over a span of audio
can be scored on how far it puts the first word of each chunk from that time.

Both arms see the SAME windows (consecutive chunks packed to <= --window-seconds,
cut at chunk boundaries, decoded once to 16 kHz mono) and the SAME text (the
chunks' texts joined). That is generous to both - production has to find the
text for a window itself - and equal for both, which is what a bake-off needs.

  python bakeoff.py --arm qwen     --m4b shift.m4b --chunks chunks.json --minutes 60
  python bakeoff.py --arm whisperx --m4b shift.m4b --chunks chunks.json --minutes 60
"""
import argparse, json, os, re, subprocess, sys, time

import numpy as np
import soundfile as sf

SR = 16000


def decode(m4b, start, dur):
    cmd = ['ffmpeg', '-v', 'error', '-ss', f'{start:.3f}', '-t', f'{dur:.3f}', '-i', m4b,
           '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    return np.frombuffer(out, dtype='<f4').copy()


def windows(chunks, window_s, minutes, from_chunk):
    """Consecutive chunks packed to <= window_s seconds of audio, cut at chunk edges."""
    out, cur = [], []
    limit_t = chunks[from_chunk]['start'] + minutes * 60 if minutes else float('inf')
    for c in chunks[from_chunk:]:
        if c['start'] >= limit_t:
            break
        if not c['text'].strip():
            continue
        if cur and (c['end'] - cur[0]['start']) > window_s:
            out.append(cur)
            cur = []
        cur.append(c)
    if cur:
        out.append(cur)
    return out


_norm_re = re.compile(r'[^a-z0-9]+')


def norm(s):
    return _norm_re.sub('', s.lower())


def chunk_offsets(chunks_in_window):
    """Normalized-char offset at which each chunk's text begins in the joined text."""
    offsets, acc = [], 0
    for c in chunks_in_window:
        offsets.append(acc)
        acc += len(norm(c['text']))
    return offsets


def first_word_times(items, offsets):
    """items: [(word, start_s)] in order. For each chunk offset, the start of the
    item that begins at (or first after) that normalized offset."""
    times, acc, j = [], 0, 0
    starts = []
    for word, t in items:
        starts.append((acc, t))
        acc += len(norm(word))
    for off in offsets:
        while j < len(starts) and starts[j][0] < off:
            j += 1
        times.append(starts[j][1] if j < len(starts) else None)
    return times


class QwenArm:
    name = 'qwen3-forcedaligner-0.6b'

    def __init__(self, device):
        import torch
        from qwen_asr import Qwen3ForcedAligner
        t = time.time()
        self.model = Qwen3ForcedAligner.from_pretrained(
            'Qwen/Qwen3-ForcedAligner-0.6B', dtype=torch.bfloat16, device_map=device)
        self.load_s = time.time() - t

    def align(self, wav_path, text):
        res = self.model.align(audio=wav_path, text=text, language='English')
        items = res[0]
        out = []
        for it in items:
            st = getattr(it, 'start_time', None)
            if st is None and isinstance(it, dict):
                st = it.get('start_time')
            word = getattr(it, 'text', None) if not isinstance(it, dict) else it.get('text')
            out.append((word, float(st)))
        return out


class WhisperxArm:
    name = 'whisperx-wav2vec2'

    def __init__(self, device):
        import whisperx
        self.whisperx = whisperx
        self.device = device
        t = time.time()
        self.model, self.meta = whisperx.load_align_model(language_code='en', device=device)
        self.load_s = time.time() - t

    def align(self, wav_path, text):
        audio, sr = sf.read(wav_path, dtype='float32')
        seg = [{'text': text, 'start': 0.0, 'end': len(audio) / sr}]
        res = self.whisperx.align(seg, self.model, self.meta, audio, self.device,
                                  return_char_alignments=False)
        out = []
        for s in res['segments']:
            for w in s.get('words', []):
                if w.get('start') is None:
                    # untimed word: carry the previous time so offsets still advance
                    out.append((w['word'], out[-1][1] if out else 0.0))
                else:
                    out.append((w['word'], float(w['start'])))
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', choices=['qwen', 'whisperx'], required=True)
    ap.add_argument('--m4b', required=True)
    ap.add_argument('--chunks', required=True)
    ap.add_argument('--minutes', type=float, default=60.0, help='0 = whole book')
    ap.add_argument('--from-chunk', type=int, default=1)
    ap.add_argument('--window-seconds', type=float, default=290.0)
    ap.add_argument('--device', default='cuda:0')
    ap.add_argument('--out', default=None)
    ap.add_argument('--tmp', default='/tmp/bakeoff')
    a = ap.parse_args()

    chunks = json.load(open(a.chunks, encoding='utf-8'))
    wins = windows(chunks, a.window_seconds, a.minutes, a.from_chunk)
    os.makedirs(a.tmp, exist_ok=True)
    arm = QwenArm(a.device) if a.arm == 'qwen' else WhisperxArm(a.device)
    print(f'{arm.name}: model loaded in {arm.load_s:.1f}s; {len(wins)} window(s)', flush=True)

    errors, rows = [], []
    audio_s = 0.0
    t_align = 0.0
    t_decode = 0.0
    first_shape_printed = False
    for wi, win in enumerate(wins):
        w_start, w_end = win[0]['start'], win[-1]['end']
        dur = w_end - w_start
        t0 = time.time()
        audio = decode(a.m4b, w_start, dur)
        wav = os.path.join(a.tmp, f'w{wi}.wav')
        sf.write(wav, audio, SR, subtype='PCM_16')
        t_decode += time.time() - t0
        text = ' '.join(c['text'] for c in win)
        t0 = time.time()
        try:
            items = arm.align(wav, text)
        except Exception as e:
            print(f'window {wi} ({dur:.0f}s, {len(text)} chars) FAILED: {type(e).__name__}: {e}', flush=True)
            for c in win[1:]:
                rows.append({'chunk': c['index'], 'truth': c['start'], 'pred': None, 'err': None, 'window': wi})
            continue
        t_align += time.time() - t0
        audio_s += dur
        if not first_shape_printed:
            print('first items:', items[:3], '… total', len(items), 'words in text', len(text.split()), flush=True)
            first_shape_printed = True
        times = first_word_times(items, chunk_offsets(win))
        for c, t in zip(win[1:], times[1:]):
            if t is None:
                rows.append({'chunk': c['index'], 'truth': c['start'], 'pred': None, 'err': None, 'window': wi})
                continue
            pred = w_start + t
            err = pred - c['start']
            errors.append(abs(err))
            rows.append({'chunk': c['index'], 'truth': c['start'], 'pred': pred, 'err': err, 'window': wi})
        if (wi + 1) % 5 == 0 or wi == len(wins) - 1:
            e = np.array(errors) if errors else np.zeros(1)
            print(f'  window {wi + 1}/{len(wins)}: {audio_s / 60:.1f} min audio in {t_align:.1f}s align '
                  f'({audio_s / max(t_align, 1e-9):.0f}x realtime); median |err| {np.median(e):.3f}s '
                  f'p95 {np.percentile(e, 95):.3f}s', flush=True)

    e = np.array(errors)
    missing = sum(1 for r in rows if r['pred'] is None)
    print(f'\n== {arm.name} ==')
    print(f'boundaries scored {len(e)} (unplaced {missing}); audio {audio_s / 3600:.2f} h; '
          f'align {t_align:.1f}s ({audio_s / max(t_align, 1e-9):.0f}x realtime); decode {t_decode:.1f}s; '
          f'load {arm.load_s:.1f}s')
    if len(e):
        print(f'|err| median {np.median(e):.3f}s  p90 {np.percentile(e, 90):.3f}s  p95 {np.percentile(e, 95):.3f}s  '
              f'p99 {np.percentile(e, 99):.3f}s  max {e.max():.3f}s  >0.25s {int((e > 0.25).sum())}  '
              f'>0.5s {int((e > 0.5).sum())}  >2s {int((e > 2).sum())}')
    out = a.out or f'/mnt/c/tmp/bakeoff/{a.arm}.json'
    json.dump({'arm': arm.name, 'rows': rows, 'audio_s': audio_s, 'align_s': t_align,
               'decode_s': t_decode, 'load_s': arm.load_s}, open(out, 'w'), indent=1)
    print('rows ->', out)


if __name__ == '__main__':
    main()
