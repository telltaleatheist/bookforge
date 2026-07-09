#!/usr/bin/env python
"""
align_audiobook.py — force-align an EPUB's sentences to an audiobook's narration.

Produces a sentence-level VTT whose TEXT is the epub's canonical prose and whose
TIMING comes from wav2vec2 (WhisperX) phoneme forced-alignment — accurate and
immune to speech-to-text transcription errors.

Pipeline (all inside the whisperx conda env):
  1. Rough pass: faster-whisper transcribes ~600 s slices of the ORIGINAL audio
     in parallel worker processes (each slices with ffmpeg + loads its own model).
     Meanwhile the full-book 16 kHz wav — needed only by the align workers —
     decodes on a background thread, joined before the align pool starts.
  2. Coarse align: greedily map each epub sentence to a rough audio time using the
     transcript word stream (also finds narrated head/tail; trims non-narrated matter).
  3. Chunk by rough times (~CHUNK_S at sentence gaps), parallel WhisperX force-align
     each chunk's epub text to its audio slice.
  4. Emit a sentence VTT (epub text + precise times).

Default CPU. --device mps runs the align workers on Metal — measured safe and
~2.5x faster with 150 s chunks when torch.mps.empty_cache() runs after each
align (the Jul 8 disaster was huge segments in wired memory, not MPS itself).
MPS forces a single worker (one process owns the GPU). Rough transcribe is
always CPU (faster-whisper/ctranslate2 doesn't use torch MPS).

Progress protocol (stdout, one per line, for the bridge to parse):
  STAGE <name>
  PROGRESS <0-100>
  RESULT {"ok":true,"vtt":"<path>","cues":N,"aligned":N,"trimmedHead":N,"trimmedTail":N}
  ERROR <message>

Usage:
  align_audiobook.py --audio A.m4b --sentences S.json --out O.vtt
                     [--workers N] [--chunk-s 300] [--rough-model base]
                     [--lang en] [--tmp DIR] [--rough-cache C.json]
                     [--device cpu|mps]
  S.json: ["sentence 1", "sentence 2", ...]  (epub sentences, in reading order)
"""
import argparse, bisect, json, os, re, subprocess, sys, tempfile, threading, time
import multiprocessing as mp

DEVICE = "cpu"   # module default; transcribe is always cpu, align may opt into --device mps
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
# WORKER_THREADS is NOT about memory: A/B tested default-16 vs 4 and memory is
# identical (same RSS, same transient peak). It caps CPU oversubscription — with
# up to 4 workers on a 20-core machine, keep workers × threads ≈ cores so the
# pool doesn't thrash the scheduler (torch otherwise defaults to one OpenMP
# thread PER CORE, i.e. 4 workers × 20 threads = 80 threads fighting for 20 cores).
WORKER_THREADS = 4
_MODEL = None; _META = None; _WAV = None; _LANG = "en"; _DEVICE = DEVICE
def _winit(wav_path, lang, device):
    global _MODEL, _META, _WAV, _LANG, _DEVICE
    # must be set before torch/whisperx import so OpenMP honors it
    os.environ["OMP_NUM_THREADS"] = str(WORKER_THREADS)
    os.environ["MKL_NUM_THREADS"] = str(WORKER_THREADS)
    if device == "mps":
        os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"  # before torch import
    import torch, whisperx
    torch.set_num_threads(WORKER_THREADS)
    _WAV = wav_path; _LANG = lang; _DEVICE = device
    _MODEL, _META = whisperx.load_align_model(language_code=lang, device=device)

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
        res = whisperx.align(seg, _MODEL, _META, audio, _DEVICE, return_char_alignments=False)
        if _DEVICE == "mps":  # release Metal buffers per chunk — keeps wired memory flat
            import torch
            if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"): torch.mps.empty_cache()
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

# Memory model (measured M1 Ultra 64 GB, 150 s chunks): steady RSS after an
# align ≈ 3.4 GB/worker, but the TRANSIENT peak DURING a single-chunk align is
# ≈ 6.4 GB (ru_maxrss, ≈2× steady) — malloc never returns the peak, and RSS
# under pressure under-reports it. With N workers aligning concurrently, all N
# can be at their transient peak at once, so budget N × 6.5 GB. Thread count was
# A/B tested (default-16 vs 4) and does NOT change memory — identical RSS/peak.
GB_PER_WORKER = 6.5
RAM_HEADROOM_GB = 12.0  # leave room for the app + OS + other processes
MAX_WORKERS = 4

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

def _darwin_free_pct():
    """macOS free-memory percentage via `memory_pressure -Q`, or None on failure."""
    out = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    m = re.search(r"System-wide memory free percentage:\s*(\d+)", out)
    return int(m.group(1)) if m else None

def avail_ram_gb():
    """RAM AVAILABLE NOW (not total) — size workers against real headroom so we
    don't melt into swap when other apps (Final Cut etc.) already hold RAM."""
    try:
        if sys.platform == "darwin":
            pct = _darwin_free_pct()
            if pct is not None:
                return (pct / 100.0) * total_ram_gb()
            return total_ram_gb() * 0.5
        try:  # Linux (SC_AVPHYS_PAGES exists here, unlike Darwin)
            return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / (1024**3)
        except (ValueError, OSError, AttributeError):
            pass
        if sys.platform == "win32":  # reuse GlobalMemoryStatusEx, read ullAvailPhys
            import ctypes
            class MSX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = MSX(); m.dwLength = ctypes.sizeof(MSX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.ullAvailPhys / (1024**3)
    except Exception:
        pass
    return total_ram_gb() * 0.5

def auto_workers():
    cores = os.cpu_count() or 4
    usable = max(0.0, avail_ram_gb() - RAM_HEADROOM_GB)
    return max(1, min(cores // 2, int(usable // GB_PER_WORKER), MAX_WORKERS))

def extract_wav(src, dst, total_dur, emit_progress=True):
    """Decode the audiobook to a 16 kHz mono wav ONCE (align workers slice it);
    streams real ffmpeg progress as PROGRESS 2..10 unless emit_progress=False
    (the background-thread caller — so PROGRESS lines can't interleave)."""
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", str(SR),
                          "-c:a", "pcm_s16le", "-nostats", "-progress", "pipe:1", dst],
                         stdout=subprocess.PIPE, text=True)
    last = 2
    for line in p.stdout:  # always drain the pipe, even when not emitting
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try: t = int(line.split("=", 1)[1]) / 1e6  # both keys are microseconds
            except ValueError: continue
            pct = 2 + int(8 * min(1.0, t / max(1.0, total_dur)))
            if emit_progress and pct > last: progress(pct); last = pct
    if p.wait() != 0: raise RuntimeError("ffmpeg failed to decode the audiobook")

# ---- transcribe worker globals (faster-whisper model, loaded once per process) ----
# memory budget: ~2.6 GB/worker measured (base int8) — 4 workers ≈ 10 GB, no
# guardrail needed here (the align stage is the heavy one).
TRANSCRIBE_WORKERS = max(1, min(4, (os.cpu_count() or 4) // 4))
SLICE_S = 600.0  # ~10 min transcribe slices
_TMODEL = None; _TAUDIO = None
def _tinit(audio_path, model_size):
    global _TMODEL, _TAUDIO
    from faster_whisper import WhisperModel
    _TAUDIO = audio_path
    _TMODEL = WhisperModel(model_size, device=DEVICE, compute_type="int8", cpu_threads=4)

def _transcribe_slice(task):
    si, a, d, lang = task
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".wav"); os.close(fd)
        # -ss before -i: fast seek from the ORIGINAL audio, accurate enough for rough anchors
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(a), "-t", str(d),
                        "-i", _TAUDIO, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", tmp], check=True)
        segs, _ = _TMODEL.transcribe(tmp, language=lang, vad_filter=True, word_timestamps=True)
        W = []
        for s in segs:
            if s.words:
                for w in s.words:
                    n = _norm(w.word)
                    if n: W.append((n, a + w.start))
            else:
                st = a + s.start
                for w in s.text.split():
                    n = _norm(w)
                    if n: W.append((n, st))
        return (si, W)
    except Exception as e:
        log(f"transcribe slice {si} FAILED: {e}")
        return (si, [])
    finally:
        if tmp and os.path.exists(tmp):
            try: os.remove(tmp)
            except OSError: pass

def rough_transcribe(audio_src, model_size, lang, total_dur=0.0):
    """Sliced multiprocess faster-whisper -> flat word stream [(word_norm, time)].
    Workers ffmpeg-slice ~SLICE_S s straight from the ORIGINAL audio (no
    full-book wav dependency) and load the model once each. PROGRESS 4..34."""
    if lang == "auto":  # detect once in the parent on the first 60 s, then pin for all workers
        from faster_whisper import WhisperModel
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(suffix=".wav"); os.close(fd)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "0", "-t", "60",
                            "-i", audio_src, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", tmp], check=True)
            m = WhisperModel(model_size, device=DEVICE, compute_type="int8", cpu_threads=4)
            _, info = m.transcribe(tmp, language=None, vad_filter=True, word_timestamps=True)
            lang = info.language or "en"
            del m
        finally:
            if tmp and os.path.exists(tmp):
                try: os.remove(tmp)
                except OSError: pass
        log(f"detected language: {lang}")
    n = max(1, int((total_dur + SLICE_S - 1) // SLICE_S))
    tasks = [(i, i * SLICE_S, min(SLICE_S, total_dur - i * SLICE_S), lang) for i in range(n)]
    parts = {}; done = 0
    ctx = mp.get_context("spawn")
    with ctx.Pool(min(TRANSCRIBE_WORKERS, n), initializer=_tinit, initargs=(audio_src, model_size)) as pool:
        for si, words in pool.imap_unordered(_transcribe_slice, tasks):
            parts[si] = words; done += 1
            progress(4 + int(30 * done / n))
            if done % 10 == 0: log(f"transcribe {done}/{n} slices")
    W = [w for i in sorted(parts) for w in parts[i]]  # stitch in timeline order
    return W, lang

def coarse_align(sents, W):
    """Sentence -> rough audio time, drift-proof at book scale.

    PASS 1 (global anchors): index the transcript's 3-grams, confirm each
    sentence's opening 3-gram candidates with an ordered-hit check (tolerates
    1 miss for transcription errors), then keep the LONGEST INCREASING
    SUBSEQUENCE over (sentence asc, word position asc) — spurious matches die
    structurally instead of derailing a running pointer.
    PASS 2 (local fill): the old small-window walk runs BETWEEN consecutive
    anchors, constrained to their word range, so dead-reckoning drift is
    bounded by anchor spacing instead of the whole book (the failure mode that
    flatlined a 10k-sentence run at an 8.6% match rate).
    Returns (rough[], first_idx, last_idx)."""
    WT = [t for _, t in W]; WN = [w for w, _ in W]; M = len(WN)
    BACK, FWD, SPAN = 8, 60, 14   # local search window / confirm span
    N = len(sents); TK = [toks(s) for s in sents]
    rough = [None] * N

    def hits(j, tk, need):  # ordered token hits within SPAN words starting at j
        k = j; m = 0
        while k < min(M, j + SPAN) and m < need:
            if WN[k] == tk[m]: m += 1
            k += 1
        return m

    # PASS 1 — global anchors
    tri = {}
    for j in range(M - 2):
        tri.setdefault((WN[j], WN[j + 1], WN[j + 2]), []).append(j)
    cands = []
    for si in range(N):
        tk = TK[si]
        if len(tk) < 4: continue
        pos = tri.get((tk[0], tk[1], tk[2]))
        if not pos or len(pos) > 50: continue   # too common to be an anchor
        need = min(len(tk), 6)
        for j in pos:
            if hits(j, tk, need) >= max(3, need - 1):
                cands.append((si, j))
    # LIS: sort (si asc, j desc), patience over strictly-increasing j — the desc
    # tie-break means a chain can keep at most one candidate per sentence
    cands.sort(key=lambda c: (c[0], -c[1]))
    tails = []; tidx = []; parent = [-1] * len(cands)
    for i, (si, j) in enumerate(cands):
        p = bisect.bisect_left(tails, j)
        if p == len(tails): tails.append(j); tidx.append(i)
        else: tails[p] = j; tidx[p] = i
        parent[i] = tidx[p - 1] if p > 0 else -1
    anchors = []; i = tidx[-1] if tidx else -1
    while i != -1:
        anchors.append(cands[i]); i = parent[i]
    anchors.reverse()
    for si, j in anchors: rough[si] = WT[j]

    # PASS 2 — local fill between anchors (the old walk, word-range constrained)
    def walk(s_lo, s_hi, j_lo, j_hi, wi):
        for si in range(s_lo, s_hi):
            tk = TK[si]
            if len(tk) < 2:
                wi += 1; continue
            need = min(len(tk), 5)
            best = None
            lo = max(j_lo, wi - BACK); hi = min(j_hi, wi + FWD)
            for j in range(lo, hi):
                if WN[j] != tk[0]: continue
                if hits(j, tk, need) >= max(3, need - 1):   # strong local match
                    best = j; break
            if best is not None:
                rough[si] = WT[best]; wi = best + len(tk)
            else:
                wi += len(tk)               # keep tracking the rate through misses
    if anchors:
        for (sa, ja), (sb, jb) in zip(anchors, anchors[1:]):
            if sb > sa + 1: walk(sa + 1, sb, ja, jb, ja + len(TK[sa]))
        s0, j0 = anchors[0]   # head: dead-reckon a start, walk constrained to [0, j0)
        walk(0, s0, 0, j0, max(0, j0 - sum(len(t) for t in TK[:s0])))
        sl, jl = anchors[-1]  # tail: walk constrained to [jl, M)
        walk(sl + 1, N, jl, M, jl + len(TK[sl]))
    else:
        walk(0, N, 0, M, 0)   # no anchors (tiny/odd input): old full-range behavior

    matched = [i for i in range(N) if rough[i] is not None]
    log(f"coarse: {len(cands)} anchor candidates -> {len(anchors)} after LIS; "
        f"matches {len(matched)}/{N} sentences ({100.0 * len(matched) / max(1, N):.0f}%)")
    if not matched:
        return rough, 0, N
    first_idx, last_idx = matched[0], matched[-1] + 1
    # fill interior gaps by interpolation; clamp head/tail to nearest matched time
    last = rough[first_idx]
    for i in range(N):
        if rough[i] is None:
            nxt = next((rough[k] for k in range(i + 1, N) if rough[k] is not None), None)
            rough[i] = last if nxt is None else (last + nxt) / 2
        else:
            last = rough[i]
    for i in range(1, N):
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
    # cache the rough transcript (words+lang JSON) so re-runs skip the ~30-40 min
    # transcribe pass when iterating on the align stage
    ap.add_argument("--rough-cache", default="")
    ap.add_argument("--device", default="cpu", choices=["cpu", "mps"])
    args = ap.parse_args()

    sents = json.load(open(args.sentences, encoding="utf-8"))
    if sents and isinstance(sents[0], dict):
        sents = [s.get("text", "") for s in sents]
    N = len(sents)
    workers = args.workers if args.workers > 0 else auto_workers()
    if args.device == "mps" and workers != 1:
        log("device=mps: forcing 1 worker (a single MPS worker owns the GPU)")
        workers = 1
    # free-memory floor (%) below which the pool self-shrinks; tunable for testing
    pressure_floor = int(os.environ.get("ALIGN_PRESSURE_FLOOR", "15"))
    DUR = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                "-of", "default=nk=1:nw=1", args.audio],
                               capture_output=True, text=True).stdout.strip() or 0)
    log(f"{N} sentences, audio {DUR:.0f}s, {workers} workers, device={args.device}, "
        f"RAM total={total_ram_gb():.1f}GB avail={avail_ram_gb():.1f}GB")

    # the full-book 16k wav is only needed by the ALIGN workers (transcribe
    # slices from the original audio itself), so decode it on a background
    # thread overlapped with transcribe; joined before the align pool starts.
    fd, wav = tempfile.mkstemp(suffix=".wav"); os.close(fd)
    try:
        stage("prepare"); progress(2)
        xerr = []
        def _bg_extract():
            try: extract_wav(args.audio, wav, DUR, emit_progress=False)
            except Exception as e: xerr.append(e)
        xt = threading.Thread(target=_bg_extract, daemon=True); xt.start()
        progress(4)

        stage("transcribe")
        W = None
        if args.rough_cache and os.path.exists(args.rough_cache):
            try:
                c = json.load(open(args.rough_cache, encoding="utf-8"))
                W, lang = c["words"], c["lang"]  # lists unpack like tuples downstream
                log(f"using cached rough transcript: {len(W)} words, lang={lang} ({args.rough_cache})")
            except Exception as e:
                log(f"rough cache unreadable ({e}); transcribing")
                W = None
        if W is None:
            W, lang = rough_transcribe(args.audio, args.rough_model, args.lang, DUR)
            log(f"rough transcript: {len(W)} words, lang={lang}")
            if args.rough_cache:  # atomic write: tmp + replace
                tmpc = args.rough_cache + ".tmp"
                json.dump({"words": W, "lang": lang}, open(tmpc, "w", encoding="utf-8"))
                os.replace(tmpc, args.rough_cache)
                log(f"wrote rough cache: {args.rough_cache}")
        progress(35)

        stage("coarse-align")
        rough, first_idx, last_idx = coarse_align(sents, W)
        trimmed_head, trimmed_tail = first_idx, N - last_idx
        log(f"narrated sentences [{first_idx}:{last_idx}] (trim head={trimmed_head}, tail={trimmed_tail})")
        progress(42)

        # align workers read the full-book wav — join the background decode now
        if xt.is_alive(): log("waiting on background wav extraction")
        xt.join()
        if xerr: raise xerr[0]

        # chunk over the narrated range at sentence gaps ~every chunk-s
        stage("align"); chunks = []; cur = first_idx; base = rough[first_idx] if first_idx < N else 0.0
        capped = 0
        for i in range(first_idx + 1, last_idx + 1):
            if i == last_idx or (rough[i] - base) >= args.chunk_s:
                a = max(0.0, rough[cur] - PAD_HEAD)
                b = min(DUR, (rough[i] + PAD_TAIL) if i < last_idx else DUR)
                # safety net: wav2vec2 memory is quadratic in audio span, so no
                # coarse regression may ever produce a memory-bomb chunk
                if b - a > 2 * args.chunk_s:
                    b = a + 2 * args.chunk_s; capped += 1
                chunks.append((len(chunks), cur, i, a, b, sents[cur:i]))
                if i < last_idx: cur = i; base = rough[i]
        if capped:
            log(f"WARNING: {capped} chunk(s) exceeded the {2 * args.chunk_s:.0f}s span cap "
                f"and were truncated — coarse alignment is likely off")
        log(f"{len(chunks)} chunks")

        sent_start = list(rough)  # default to rough; refine with WhisperX
        ctx = mp.get_context("spawn")
        completed = set()          # chunk indices (chunks[k][0]) that have finished
        by_ci = {c[0]: c for c in chunks}
        # Self-protecting pool loop: chunks arrive unordered, and if free memory
        # drops below the floor we terminate the pool, HALVE the worker count and
        # re-run whatever hasn't completed on a smaller pool (can repeat 4→2→1).
        # Pending is always derived from `completed`, so a chunk dispatched to a
        # terminated worker but never finished is simply re-run (idempotent —
        # sent_start assignment overwrites).
        while len(completed) < len(chunks):
            pending = [by_ci[ci] for ci in by_ci if ci not in completed]
            shrink = False
            # maxtasksperchild recycles each cpu worker after 2 chunks: malloc
            # fragments across different-sized chunks and never returns the peak,
            # so short worker lives keep the retained footprint bounded (model
            # reload is ~5-10 s against ~10-20 s of useful work per chunk).
            # mps: memory measured FLAT with per-chunk empty_cache, so never
            # recycle — the single worker would otherwise reload every 2 chunks.
            mtpc = None if args.device == "mps" else 2
            with ctx.Pool(workers, initializer=_winit, initargs=(wav, lang, args.device), maxtasksperchild=mtpc) as pool:
                for ci, out in pool.imap_unordered(_align_chunk, pending):
                    completed.add(ci)
                    if out:
                        for si, t in out.items(): sent_start[si] = t
                    progress(42 + int(56 * len(completed) / max(1, len(chunks))))
                    if len(completed) % 3 == 0 and sys.platform == "darwin" and workers > 1:
                        try: free = _darwin_free_pct()
                        except Exception: free = None
                        if free is not None and free < pressure_floor:
                            new_w = max(1, workers // 2)
                            log(f"MEMORY PRESSURE: free {free}% < {pressure_floor}%; "
                                f"shrinking pool {workers} -> {new_w} workers")
                            pool.terminate(); pool.join()
                            workers = new_w; shrink = True
                            break
            if not shrink:
                break
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
