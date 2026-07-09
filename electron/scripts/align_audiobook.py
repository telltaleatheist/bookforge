#!/usr/bin/env python
"""
align_audiobook.py — force-align an EPUB's sentences to an audiobook's narration.

Produces a sentence-level VTT whose TEXT is the epub's canonical prose and whose
TIMING comes from wav2vec2 (WhisperX) phoneme forced-alignment — accurate and
immune to speech-to-text transcription errors.

Pipeline (all inside the whisperx conda env, CPU-only):
  1. Rough pass: faster-whisper transcribes the audio (segment times + text).
  2. Coarse align: greedily map each epub sentence to a rough audio time using the
     transcript word stream (also finds narrated head/tail; trims non-narrated matter).
  3. Chunk by rough times (~CHUNK_S at sentence gaps), parallel WhisperX force-align
     each chunk's epub text to its audio slice.
  4. Emit a sentence VTT (epub text + precise times).

CPU ONLY — never MPS (Metal balloons memory and can wedge the machine).

Progress protocol (stdout, one per line, for the bridge to parse):
  STAGE <name>
  PROGRESS <0-100>
  RESULT {"ok":true,"vtt":"<path>","cues":N,"aligned":N,"trimmedHead":N,"trimmedTail":N}
  ERROR <message>

Usage:
  align_audiobook.py --audio A.m4b --sentences S.json --out O.vtt
                     [--workers N] [--chunk-s 300] [--rough-model base]
                     [--lang en] [--tmp DIR]
  S.json: ["sentence 1", "sentence 2", ...]  (epub sentences, in reading order)
"""
import argparse, json, os, re, subprocess, sys, tempfile, time
import multiprocessing as mp

DEVICE = "cpu"   # HARD RULE — never "mps"
SR = 16000
PAD_HEAD, PAD_TAIL = 4.0, 20.0
T0 = time.time()

def emit(line): print(line, flush=True)
def stage(s): emit(f"STAGE {s}")
def progress(p): emit(f"PROGRESS {int(p)}")
def log(m): print(f"[{time.time()-T0:6.1f}s] {m}", file=sys.stderr, flush=True)

_norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
def toks(s): return [t for t in (_norm(w) for w in s.split()) if t]

# ---- worker globals (WhisperX align model, loaded once per process) ----
_MODEL = None; _META = None; _WAV = None; _LANG = "en"
def _winit(wav_path, lang):
    global _MODEL, _META, _WAV, _LANG
    import whisperx
    _WAV = wav_path; _LANG = lang
    _MODEL, _META = whisperx.load_align_model(language_code=lang, device=DEVICE)

def _align_chunk(args):
    ci, lo, hi, a, b, texts = args
    import whisperx
    t0 = time.time(); tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(a), "-t", str(b - a),
                        "-i", _WAV, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", tmp], check=True)
        audio = whisperx.load_audio(tmp)
        seg = [{"text": " ".join(texts), "start": 0.0, "end": len(audio) / SR}]
        res = whisperx.align(seg, _MODEL, _META, audio, DEVICE, return_char_alignments=False)
        words = []
        for sg in res["segments"]:
            for w in sg.get("words", []):
                words.append((w.get("start"), _norm(w.get("word", ""))))
        out = {}; wi = 0
        for k, txt in enumerate(texts):
            tk = toks(txt); first = None; matched = 0; j = wi
            while j < len(words) and matched < min(len(tk), 4):
                if words[j][1] == tk[matched]:
                    if matched == 0 and words[j][0] is not None: first = words[j][0]
                    matched += 1
                j += 1
            if first is not None: out[lo + k] = first + a; wi = j
        return (ci, out)
    except Exception as e:
        log(f"chunk {ci} [{lo}:{hi}] FAILED: {e}")
        return (ci, None)
    finally:
        if tmp and os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass

# Peak RSS per worker scales with chunk length (wav2vec2 attention is quadratic
# in segment length) and torch's CPU allocator RETAINS the peak for the life of
# the process. Measured (M1 Ultra): 2-min chunk ≈ 2.9 GB, 5-min ≈ 4.7 GB,
# 6-min ≈ 5.0 GB. At the 150 s default chunk, plan ~3.5 GB per worker.
GB_PER_WORKER = 3.5
RAM_HEADROOM_GB = 12.0  # leave room for the app + OS + other processes
MAX_WORKERS = 6

def total_ram_gb():
    try:  # Linux
        return os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / (1024**3)
    except (ValueError, OSError, AttributeError):
        pass
    try:  # macOS (SC_PHYS_PAGES is unreliable / SC_AVPHYS_PAGES absent on Darwin)
        out = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip()
        if out: return int(out) / (1024**3)
    except (OSError, ValueError):
        pass
    try:  # Windows
        import ctypes
        class MSX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MSX(); m.dwLength = ctypes.sizeof(MSX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullTotalPhys / (1024**3)
    except Exception:
        pass
    return 16.0  # conservative default

def auto_workers():
    cores = os.cpu_count() or 4
    usable = max(0.0, total_ram_gb() - RAM_HEADROOM_GB)
    return max(1, min(cores // 2, int(usable // GB_PER_WORKER), MAX_WORKERS))

def rough_transcribe(audio, model_size, lang, total_dur=0.0):
    """faster-whisper -> flat word stream [(word_norm, time)] (approx).
    Streams incremental PROGRESS (2..34%) against audio position so the UI bar
    moves throughout the long transcribe pass instead of sitting frozen."""
    from faster_whisper import WhisperModel
    m = WhisperModel(model_size, device=DEVICE, compute_type="int8")
    segs, info = m.transcribe(audio, language=(None if lang == "auto" else lang),
                              vad_filter=True, word_timestamps=True)
    total = float(getattr(info, "duration", 0) or total_dur or 0) or 1.0
    W = []
    last_pct = 2; last_log = 0.0
    for s in segs:
        if s.words:
            for w in s.words:
                n = _norm(w.word)
                if n: W.append((n, w.start))
        else:
            st = s.start
            for w in s.text.split():
                n = _norm(w)
                if n: W.append((n, st))
        pos = float(getattr(s, "end", 0) or 0)
        pct = 2 + int(32 * min(1.0, pos / total))
        if pct > last_pct:
            progress(pct); last_pct = pct
        if pos - last_log >= 600:  # a heartbeat to stderr every ~10 audio-min
            log(f"transcribe {pos/60:.0f}/{total/60:.0f} min"); last_log = pos
    return W, (lang if lang != "auto" else (info.language or "en"))

def coarse_align(sents, W):
    """Streaming in-order map: epub sentence -> rough audio time.

    Uses a SMALL local window so common opening words can't jerk the pointer
    across the whole book, and advances the pointer by the sentence's length
    even on a miss so it tracks the narration rate and re-anchors on the next
    confident match. Returns (rough[], first_idx, last_idx)."""
    WT = [t for _, t in W]; WN = [w for w, _ in W]; M = len(WN)
    BACK, FWD, SPAN = 8, 60, 14   # local search window / confirm span
    rough = [None] * len(sents); wi = 0
    for si, s in enumerate(sents):
        tk = toks(s)
        if len(tk) < 2:
            wi += 1; continue
        need = min(len(tk), 5)
        best = None
        lo = max(0, wi - BACK); hi = min(M, wi + FWD)
        for j in range(lo, hi):
            if WN[j] != tk[0]:
                continue
            # count ordered token hits within a short span after j
            k = j; m = 0
            while k < min(M, j + SPAN) and m < need:
                if WN[k] == tk[m]: m += 1
                k += 1
            if m >= max(3, need - 1):   # strong local match
                best = j; break
        if best is not None:
            rough[si] = WT[best]; wi = best + len(tk)
        else:
            wi += len(tk)               # keep tracking the rate through misses
    matched = [i for i in range(len(sents)) if rough[i] is not None]
    if not matched:
        return rough, 0, len(sents)
    first_idx, last_idx = matched[0], matched[-1] + 1
    # fill interior gaps by interpolation; clamp head/tail to nearest matched time
    last = rough[first_idx]
    for i in range(len(sents)):
        if rough[i] is None:
            nxt = next((rough[k] for k in range(i + 1, len(sents)) if rough[k] is not None), None)
            rough[i] = last if nxt is None else (last + nxt) / 2
        else:
            last = rough[i]
    for i in range(1, len(sents)):
        if rough[i] < rough[i - 1]: rough[i] = rough[i - 1]
    return rough, first_idx, last_idx

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--sentences", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=0)
    # 150 s chunks: wav2vec2 attention is quadratic in segment length, so smaller
    # chunks are BOTH lower-memory (~3.3 vs ~5.8 GB/worker) and ~2x faster per
    # audio-second than the old 300 s default. Accuracy is unaffected (per-chunk
    # padding + in-order word walk handle boundaries).
    ap.add_argument("--chunk-s", type=float, default=150.0)
    ap.add_argument("--rough-model", default="base")
    ap.add_argument("--lang", default="en")
    args = ap.parse_args()

    sents = json.load(open(args.sentences, encoding="utf-8"))
    if sents and isinstance(sents[0], dict):
        sents = [s.get("text", "") for s in sents]
    N = len(sents)
    workers = args.workers if args.workers > 0 else auto_workers()
    DUR = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=nk=1:nw=1", args.audio],
                               capture_output=True, text=True).stdout.strip() or 0)
    log(f"{N} sentences, audio {DUR:.0f}s, {workers} workers, device={DEVICE}")

    stage("transcribe"); progress(2)
    W, lang = rough_transcribe(args.audio, args.rough_model, args.lang, DUR)
    log(f"rough transcript: {len(W)} words, lang={lang}")
    progress(35)

    stage("coarse-align")
    rough, first_idx, last_idx = coarse_align(sents, W)
    trimmed_head, trimmed_tail = first_idx, N - last_idx
    log(f"narrated sentences [{first_idx}:{last_idx}] (trim head={trimmed_head}, tail={trimmed_tail})")
    progress(42)

    # chunk over the narrated range at sentence gaps ~every chunk-s
    stage("align"); chunks = []; cur = first_idx; base = rough[first_idx] if first_idx < N else 0.0
    for i in range(first_idx + 1, last_idx + 1):
        if i == last_idx or (rough[i] - base) >= args.chunk_s:
            a = max(0.0, rough[cur] - PAD_HEAD)
            b = min(DUR, (rough[i] + PAD_TAIL) if i < last_idx else DUR)
            chunks.append((len(chunks), cur, i, a, b, sents[cur:i]))
            if i < last_idx: cur = i; base = rough[i]
    log(f"{len(chunks)} chunks")

    # pre-extract a clean 16k wav once (workers slice from it)
    fd, wav = tempfile.mkstemp(suffix=".wav"); os.close(fd)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", args.audio, "-ac", "1", "-ar", str(SR),
                    "-c:a", "pcm_s16le", wav], check=True)

    sent_start = list(rough)  # default to rough; refine with WhisperX
    try:
        ctx = mp.get_context("spawn")
        done = 0
        # maxtasksperchild recycles each worker after a few chunks so torch's
        # accumulated per-alignment memory is released back to the OS instead of
        # growing unbounded over the ~hundreds of chunks in a full book.
        with ctx.Pool(workers, initializer=_winit, initargs=(wav, lang), maxtasksperchild=4) as pool:
            for ci, out in pool.imap_unordered(_align_chunk, chunks):
                done += 1
                if out:
                    for si, t in out.items(): sent_start[si] = t
                progress(42 + int(56 * done / max(1, len(chunks))))
    finally:
        if os.path.exists(wav):
            try: os.remove(wav)
            except OSError: pass

    for i in range(1, N):
        if sent_start[i] < sent_start[i - 1]: sent_start[i] = sent_start[i - 1]

    stage("write")
    def ts(t): return f"{int(t//3600):02d}:{int(t%3600//60):02d}:{t%60:06.3f}"
    lines = ["WEBVTT", ""]; n = 0
    for i in range(first_idx, last_idx):
        s = sent_start[i]; e = sent_start[i + 1] if i + 1 < last_idx else min(s + 4, DUR)
        if e <= s: e = s + 0.4
        n += 1; lines += [str(n), f"{ts(s)} --> {ts(e)}", sents[i], ""]
    open(args.out, "w", encoding="utf-8").write("\n".join(lines))
    progress(100)
    emit("RESULT " + json.dumps({"ok": True, "vtt": args.out, "cues": n,
                                 "trimmedHead": trimmed_head, "trimmedTail": trimmed_tail}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(f"ERROR {e}")
        sys.exit(1)
