#!/usr/bin/env python
"""
measure_cue_edges.py — label-free cue-EDGE accuracy for an aligned VTT.

The question `vtt-boundary-metric.py` cannot answer. That tool scores a cue
BOUNDARY against the silence map, which is partly circular when the aligner
snapped to that same map, and it treats a shared seam as one time. This one
scores each cue's two edges against the audio's own energy envelope and asks the
four questions a training-corpus cutter actually cares about:

  (a) endInSpeech        the 100 ms BEFORE the cue end is speech (RMS > --speech-db,
                         default -35 dBFS). The cue end is inside a word.
  (b) endAtNextOnset     the cue end is within --tol (default 40 ms) of the NEXT
                         cue's speech onset. This is the contiguous-cue defect:
                         the end IS the next sentence's first syllable, so a clip
                         cut with any trailing pad contains it.
  (c) startAtOwnOnset    the cue start is within --tol-start (default 20 ms) of, or
                         after, its OWN speech onset. No lead-in: a clip cut here
                         clips the first phone.
  (d) trailingPauseS     seconds between the last speech inside the cue and the cue
                         end. The median is the honest "how much of the narrator's
                         pause did this cue swallow" number.
  (e) midWordEdgePct     THE acceptance criterion ("no cuts in the middle of words"):
                         the share of ALL 2N cue edges with speech on BOTH sides —
                         the 40 ms before AND the 40 ms after are above --onset-db.
                         An edge like that is a cut through a word. Reported for
                         starts and ends separately as well.

(a), (b), (c) and (e) are DEFECT rates — lower is better, target <= 1%.
(d) is a distribution; a healthy non-contiguous build sits near --end-pad.

Speech detection is a fixed 20 ms non-overlapping RMS frame grid over a 16 kHz
mono decode of the master, so two VTTs of the same audio are directly comparable.

Usage:
  measure_cue_edges.py --audio A.m4a --vtt NEW.vtt [--compare OLD.vtt]
                       [--speech-db -35] [--onset-db -38] [--tol 0.04]
                       [--tol-start 0.02] [--json out.json]

Exit 0 always (this is a measurement, not a gate).
"""
import argparse, json, math, re, subprocess, sys

SR = 16000
FRAME = 320          # 20 ms at 16 kHz, non-overlapping
FULL_SCALE = 32768.0

TS = re.compile(r'(\d+):(\d\d):(\d\d[.,]\d+)\s*-->\s*(\d+):(\d\d):(\d\d[.,]\d+)')
TS_SHORT = re.compile(r'(\d\d):(\d\d[.,]\d+)\s*-->\s*(\d\d):(\d\d[.,]\d+)')


def _sec(h, m, s):
    return int(h) * 3600 + int(m) * 60 + float(s.replace(',', '.'))


def parse_vtt(path):
    """[(start, end, text, notes)] in file order. `notes` is the list of NOTE lines
    attached to the cue (the aligner emits one block per tag), so the
    `NOTE align matched=… start=… end=…` confidence line comes back with its cue."""
    lines = open(path, encoding='utf-8').read().splitlines()
    cues = []
    pending = []
    i = 0
    while i < len(lines):
        ln = lines[i].strip()
        if ln.startswith('NOTE'):
            pending.append(ln)
            i += 1
            continue
        m = TS.search(ln)
        if m:
            st, en = _sec(*m.group(1, 2, 3)), _sec(*m.group(4, 5, 6))
        else:
            m = TS_SHORT.search(ln)
            if not m:
                if not ln:
                    pass
                i += 1
                continue
            st, en = _sec(0, *m.group(1, 2)), _sec(0, *m.group(3, 4))
        buf, j = [], i + 1
        while j < len(lines) and lines[j].strip():
            buf.append(lines[j].strip())
            j += 1
        cues.append((st, en, ' '.join(buf), pending))
        pending = []
        i = j
    return cues


def rms_db(audio_path):
    """20 ms non-overlapping RMS frames of a 16 kHz mono decode, in dBFS."""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', audio_path, '-ac', '1',
                        '-ar', str(SR), '-f', 's16le', '-'],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.exit(f'ffmpeg failed to decode {audio_path}: {p.stderr.decode(errors="replace")[-400:]}')
    try:
        import numpy as np
    except ImportError:
        sys.exit('measure_cue_edges.py needs numpy (it is in the whisperx env)')
    x = np.frombuffer(p.stdout, dtype='<i2').astype(np.float32)
    n = len(x) // FRAME
    if n == 0:
        sys.exit('audio is shorter than one frame')
    f = x[:n * FRAME].reshape(n, FRAME)
    r = np.sqrt((f * f).mean(axis=1)) / FULL_SCALE
    return 20.0 * np.log10(np.maximum(r, 1e-9)), n


def measure(cues, db, nframes, speech_db, onset_db, tol, tol_start):
    import numpy as np
    speech = db > onset_db          # frame grid used for onsets/offsets
    fi = lambda t: max(0, min(nframes - 1, int(t * SR) // FRAME))

    def next_speech(t):
        """First speech frame at or after t; its START time, or None."""
        k = fi(t)
        idx = np.flatnonzero(speech[k:])
        return None if idx.size == 0 else (k + idx[0]) * FRAME / SR

    def last_speech_in(a, b):
        """END time of the last speech frame inside [a, b), or None."""
        ka, kb = fi(a), max(fi(a), min(nframes, int(math.ceil(b * SR / FRAME))))
        if kb <= ka:
            return None
        idx = np.flatnonzero(speech[ka:kb])
        return None if idx.size == 0 else (ka + idx[-1] + 1) * FRAME / SR

    def band_db(a, b):
        """RMS over [a, b) in dBFS, or None when the window is off the timeline."""
        ka, kb = fi(a), max(fi(a) + 1, min(nframes, int(math.ceil(b * SR / FRAME))))
        if kb <= ka:
            return None
        seg = db[ka:kb]
        return 20.0 * math.log10(max(float(np.sqrt((10.0 ** (seg / 10.0)).mean())), 1e-9))

    def mid_word(t, half=0.040):
        """True when the audio is speech on BOTH sides of the edge — a cut through
        a word rather than into a pause."""
        lo, hi = band_db(max(0.0, t - half), t), band_db(t, t + half)
        return lo is not None and hi is not None and lo > onset_db and hi > onset_db

    n = len(cues)
    end_in_speech = end_at_next = start_at_own = 0
    mid_start = mid_end = 0
    trailing = []
    lead = []
    for x, (s, e, _txt, _no) in enumerate(cues):
        # (e) mid-word edges — the acceptance criterion
        if mid_word(s): mid_start += 1
        if mid_word(e): mid_end += 1
        # (a) the 100 ms before the end is speech
        k0, k1 = fi(max(0.0, e - 0.100)), fi(max(0.0, e - 1e-6))
        if k1 >= k0:
            seg = db[k0:k1 + 1]
            lin = np.sqrt((10.0 ** (seg / 10.0)).mean())
            if 20.0 * math.log10(max(lin, 1e-9)) > speech_db:
                end_in_speech += 1
        # (b) the end sits at the next cue's speech onset
        if x + 1 < n:
            no = next_speech(cues[x + 1][0])
            if no is not None and abs(no - e) <= tol:
                end_at_next += 1
        # (c) no lead-in before this cue's own speech onset
        own = next_speech(s)
        if own is not None:
            lead.append(own - s)
            if own - s <= tol_start:
                start_at_own += 1
        # (d) trailing pause inside the cue
        le = last_speech_in(s, e)
        if le is not None:
            trailing.append(max(0.0, e - le))

    def med(v):
        v = sorted(v)
        return v[len(v) // 2] if v else None

    def pct(k):
        return 100.0 * k / n if n else 0.0

    return {
        'cues': n,
        'midWordEdgePct': round(100.0 * (mid_start + mid_end) / (2 * n), 2) if n else 0.0,
        'midWordStartPct': round(pct(mid_start), 2),
        'midWordEndPct': round(pct(mid_end), 2),
        'endInSpeechPct': round(pct(end_in_speech), 2),
        'endAtNextOnsetPct': round(pct(end_at_next), 2),
        'startAtOwnOnsetPct': round(pct(start_at_own), 2),
        'medianTrailingPauseS': round(med(trailing), 3) if trailing else None,
        'medianLeadInS': round(med(lead), 3) if lead else None,
        'medianCueS': round(med([e - s for s, e, _t, _n in cues]), 3) if cues else None,
        'totalCueSeconds': round(sum(e - s for s, e, _t, _n in cues), 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--vtt', required=True)
    ap.add_argument('--compare', default='')
    ap.add_argument('--speech-db', type=float, default=-35.0)
    ap.add_argument('--onset-db', type=float, default=-38.0)
    ap.add_argument('--tol', type=float, default=0.040)
    ap.add_argument('--tol-start', type=float, default=0.020)
    ap.add_argument('--json', default='')
    a = ap.parse_args()

    db, nframes = rms_db(a.audio)
    out = {'audio': a.audio, 'speechDb': a.speech_db, 'onsetDb': a.onset_db,
           'tolS': a.tol, 'tolStartS': a.tol_start}

    sets = [('new', a.vtt)] + ([('old', a.compare)] if a.compare else [])
    texts = {}
    for name, path in sets:
        cues = parse_vtt(path)
        texts[name] = [c[2] for c in cues]
        out[name] = measure(cues, db, nframes, a.speech_db, a.onset_db, a.tol, a.tol_start)
        out[name]['vtt'] = path

    if a.compare:
        # the payload text must be untouched — only NOTE lines may differ
        t_new, t_old = texts['new'], texts['old']
        same = t_new == t_old
        diff = 0 if same else sum(1 for x in range(min(len(t_new), len(t_old)))
                                  if t_new[x] != t_old[x]) + abs(len(t_new) - len(t_old))
        out['textIdentical'] = same
        out['textDiffCues'] = diff

    w = 24
    keys = ['cues', 'midWordEdgePct', 'midWordStartPct', 'midWordEndPct',
            'endInSpeechPct', 'endAtNextOnsetPct', 'startAtOwnOnsetPct',
            'medianTrailingPauseS', 'medianLeadInS', 'medianCueS', 'totalCueSeconds']
    cols = [n for n, _ in sets]
    print(f'{"metric":<{w}}' + ''.join(f'{c:>14}' for c in cols))
    for k in keys:
        print(f'{k:<{w}}' + ''.join(f'{str(out[c].get(k)):>14}' for c in cols))
    if a.compare:
        print(f'{"cue text identical":<{w}}{str(out["textIdentical"]):>14}'
              + (f'  ({out["textDiffCues"]} cue(s) differ)' if not out['textIdentical'] else ''))

    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2)
        print(f'\nwrote {a.json}')


if __name__ == '__main__':
    main()
