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
     transcript word stream (also finds narrated head/tail; trims non-narrated
     matter, and drops interior text runs the narrator never read — copyright
     pages, TOCs, acknowledgments, footnote bodies).
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
# per-stage local progress (0-100 within one stage) for the stacked stage bars;
# the bridge fills the near-instant stages (prepare/coarse-align/write) to 100 on
# stage transition, so only the two long stages need to report a live fraction.
def subprogress(name, p): emit(f"SUBPROGRESS {name} {int(p)}")
def log(m): print(f"[{time.time()-T0:6.1f}s] {m}", file=sys.stderr, flush=True)
def fail(msg, **extra):
    """Terminal failure: RESULT ok:false (machine-readable, with counters) +
    ERROR (human-readable) + exit 1. The bridge rejects on either signal."""
    emit("RESULT " + json.dumps({"ok": False, "error": msg, **extra}))
    emit(f"ERROR {msg}")
    sys.exit(1)

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
    ci, idxs, a, b, texts = args
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
        # Walk the aligned words in order, accepting a sentence only when its
        # opening tokens confirm as an ordered run inside a tight window. The old
        # rule (first token found ANYWHERE ahead) let a single common word like
        # "the" claim a time for never-narrated text, stealing the word pointer
        # and dragging every later sentence in the chunk late. A rejected
        # sentence simply keeps its coarse/interpolated time.
        out = {}; wi = 0
        for si, txt in zip(idxs, texts):
            tk = toks(txt)
            if not tk: continue
            need = min(len(tk), 4)
            j = wi
            while j < len(words):
                if words[j][1] == tk[0] and words[j][0] is not None:
                    m = 1; k = j + 1
                    while k < min(len(words), j + 12) and m < need:
                        if words[k][1] == tk[m]: m += 1
                        k += 1
                    if m >= (need if need <= 2 else need - 1):  # tolerate 1 miss when 3+
                        out[si] = words[j][0] + a
                        # skip roughly the rest of this sentence's words so the
                        # next sentence's scan can't false-match inside its tail
                        wi = min(k + max(0, len(tk) - need), len(words))
                        break
                j += 1
        return (ci, out)
    except Exception as e:
        log(f"chunk {ci} [{idxs[0]}:{idxs[-1] + 1}] FAILED: {e}")
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

def _win_memstatus():
    """Windows GlobalMemoryStatusEx struct, or None off-Windows / on failure."""
    if sys.platform != "win32": return None
    try:
        import ctypes
        class MSX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        m = MSX(); m.dwLength = ctypes.sizeof(MSX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m
    except Exception:
        return None

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
    m = _win_memstatus()
    if m: return m.ullTotalPhys / (1024**3)
    return 16.0  # conservative default

def _darwin_free_pct():
    """macOS free-memory percentage via `memory_pressure -Q`, or None on failure."""
    out = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    m = re.search(r"System-wide memory free percentage:\s*(\d+)", out)
    return int(m.group(1)) if m else None

def free_pct():
    """System free-memory percentage on any platform, or None if unknown.
    Drives the align pool's self-shrink guardrail — must work on Windows too."""
    try:
        if sys.platform == "darwin":
            return _darwin_free_pct()
        m = _win_memstatus()
        if m: return max(0, 100 - int(m.dwMemoryLoad))
        av = os.sysconf('SC_AVPHYS_PAGES'); tot = os.sysconf('SC_PHYS_PAGES')  # Linux
        if tot > 0: return int(100 * av / tot)
    except Exception:
        pass
    return None

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
        m = _win_memstatus()
        if m: return m.ullAvailPhys / (1024**3)
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
        W = []; S = []
        for s in segs:
            txt = " ".join((s.text or "").split())
            if txt: S.append((a + s.start, a + s.end, txt))  # readable segments for fallback cues
            if s.words:
                for w in s.words:
                    n = _norm(w.word)
                    if n: W.append((n, a + w.start))
            else:
                st = a + s.start
                for w in s.text.split():
                    n = _norm(w)
                    if n: W.append((n, st))
        return (si, W, S, None)
    except Exception as e:
        # The per-slice catch is deliberate (one bad slice must not kill the
        # whole pass), but the failure is COUNTED by rough_transcribe and
        # reported in RESULT.failedSlices — never silently swallowed: each
        # failed slice is ~SLICE_S seconds of audio missing from the anchor
        # stream.
        log(f"transcribe slice {si} FAILED: {e}")
        return (si, [], [], f"slice {si}: {e}")
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
    parts = {}; parts_s = {}; done = 0; failed = []
    ctx = mp.get_context("spawn")
    with ctx.Pool(min(TRANSCRIBE_WORKERS, n), initializer=_tinit, initargs=(audio_src, model_size)) as pool:
        for si, words, segs, err in pool.imap_unordered(_transcribe_slice, tasks):
            parts[si] = words; parts_s[si] = segs; done += 1
            if err is not None: failed.append(err)
            progress(4 + int(30 * done / n))
            subprogress("transcribe", int(100 * done / n))
            if done % 10 == 0: log(f"transcribe {done}/{n} slices")
    if failed:
        log(f"transcribe: {len(failed)}/{n} slice(s) FAILED — each is ~{int(SLICE_S)}s of "
            f"audio missing from the anchor stream: {'; '.join(failed[:5])}")
    W = [w for i in sorted(parts) for w in parts[i]]  # stitch in timeline order
    S = [g for i in sorted(parts_s) for g in parts_s[i]]
    return W, lang, S, len(failed), n

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
        return rough, 0, N, 0
    first_idx, last_idx = matched[0], matched[-1] + 1

    # Narration rate (tokens/sec) measured from closely-spaced matched pairs —
    # the yardstick for judging whether an unmatched run could fit its audio gap.
    tok_sum = 0; t_sum = 0.0
    for a_i, b_i in zip(matched, matched[1:]):
        dt = rough[b_i] - rough[a_i]
        if 0 < dt <= 30:
            tok_sum += sum(len(TK[k]) for k in range(a_i, b_i)); t_sum += dt
    rate = (tok_sum / t_sum) if t_sum > 0 and tok_sum > 0 else 2.5

    # Interior unmatched runs. A SHORT gap is a transcription miss of narrated
    # text -> token-weighted interpolation between its matched neighbors. A run
    # whose spoken duration could never fit the audio gap is text the narrator
    # skipped (copyright page, TOC, acknowledgments, footnote bodies) -> keep it
    # None so it's excluded from chunking and the VTT, instead of smeared over
    # real audio (the Well of Ascension failure: ~90 unspoken front-matter
    # sentences dragged chapter 1's cues ~85 s late for the first ~5 minutes).
    dropped = 0; rescued = 0
    for a_i, b_i in zip(matched, matched[1:]):
        if b_i == a_i + 1: continue
        gap = rough[b_i] - rough[a_i]
        run_tok = sum(len(TK[k]) for k in range(a_i + 1, b_i))
        if run_tok >= 12 and run_tok / rate > 2.0 * gap + 10.0:
            # Non-narrated run — but rescue any sentence inside it that still
            # confirms on an INTERIOR trigram within the gap's transcript window.
            # Narrated sentences land in dropped runs when the transcriber
            # misheard their opening (PASS 1 anchors on openings only): "King
            # Elend" -> "King Ellen", or a heading glued onto real prose. The
            # match time is back-extrapolated to the sentence start by o/rate.
            last_t = rough[a_i]
            for k in range(a_i + 1, b_i):
                tk = TK[k]
                for o in range(0, len(tk) - 2):  # every trigram start (needs >=3 tokens)
                    need = min(len(tk) - o, 6)
                    hit = None
                    for j in (tri.get((tk[o], tk[o + 1], tk[o + 2])) or []):
                        if not (last_t < WT[j] < rough[b_i]): continue
                        if hits(j, tk[o:], need) >= max(3, need - 1):
                            hit = j; break
                    if hit is not None:
                        rough[k] = max(last_t, WT[hit] - o / rate)
                        last_t = WT[hit]; rescued += 1
                        break
                if rough[k] is None: dropped += 1
            continue
        total = (run_tok + len(TK[a_i])) or 1
        cum = len(TK[a_i])
        for k in range(a_i + 1, b_i):
            rough[k] = rough[a_i] + gap * (cum / total)
            cum += len(TK[k])
    if dropped or rescued:
        log(f"coarse: dropped {dropped} interior non-narrated sentence(s), "
            f"rescued {rescued} via interior trigrams (rate {rate:.1f} tok/s)")
    prev = None
    for i in range(N):
        if rough[i] is None: continue
        if prev is not None and rough[i] < prev: rough[i] = prev
        prev = rough[i]
    return rough, first_idx, last_idx, dropped

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
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    args = ap.parse_args()

    # auto: Apple-Silicon Macs get MPS — validated full-book (10539/10540 cues
    # identical to CPU, wired memory flat at ~5.3 GB, same wall time as 4 CPU
    # workers at a tenth of the memory budget). Everything else gets CPU. The
    # probe runs in a subprocess so the parent never pays the torch import.
    if args.device == "auto":
        args.device = "cpu"
        if sys.platform == "darwin":
            try:
                p = subprocess.run([sys.executable, "-c",
                                    "import torch;print(int(torch.backends.mps.is_available()))"],
                                   capture_output=True, text=True, timeout=60)
                if p.stdout.strip() == "1": args.device = "mps"
            except Exception:
                pass
        log(f"device auto-resolved to {args.device}")

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
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nk=1:nw=1", args.audio],
                           capture_output=True, text=True)
    dur_raw = probe.stdout.strip()
    try:
        DUR = float(dur_raw)
    except ValueError:
        # DUR=0 would silently corrupt every downstream slice/chunk/cue
        # computation (0 transcribe slices, empty chunks, cues clamped to 0) —
        # fail here, naming the tool and the file, instead of producing garbage.
        raise RuntimeError(
            f"ffprobe returned no parsable duration for {args.audio!r} "
            f"(exit {probe.returncode}, stdout {dur_raw!r}, stderr: {probe.stderr.strip()[-500:]!r})")
    if DUR <= 0:
        raise RuntimeError(f"ffprobe reported non-positive duration {DUR} for {args.audio!r}")
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
        W = None; rough_segs = []; failed_slices = 0; total_slices = 0
        if args.rough_cache and os.path.exists(args.rough_cache):
            try:
                c = json.load(open(args.rough_cache, encoding="utf-8"))
                W, lang = c["words"], c["lang"]  # lists unpack like tuples downstream
                rough_segs = [tuple(g) for g in c.get("segs", [])]
                log(f"using cached rough transcript: {len(W)} words, "
                    f"{len(rough_segs)} segments, lang={lang} ({args.rough_cache})")
                if not rough_segs:
                    log("cache predates segment support; whisper-fallback cues disabled this run")
            except Exception as e:
                log(f"rough cache unreadable ({e}); transcribing")
                W = None
        if W is None:
            W, lang, rough_segs, failed_slices, total_slices = rough_transcribe(args.audio, args.rough_model, args.lang, DUR)
            log(f"rough transcript: {len(W)} words, {len(rough_segs)} segments, lang={lang}, "
                f"failed slices {failed_slices}/{total_slices}")
            if total_slices > 0 and failed_slices == total_slices:
                # No transcript at all — coarse align would match nothing and the
                # run would end as a bare WEBVTT masquerading as success.
                fail(f"rough transcription failed on all {total_slices} slice(s) — no usable "
                     f"transcript (ffmpeg or faster-whisper is broken in the whisperx env; see stderr log)",
                     failedSlices=failed_slices, totalSlices=total_slices)
            if failed_slices and args.rough_cache:
                # Don't cache a transcript with holes — a re-run would inherit the
                # missing ~10 min stretches forever without ever re-transcribing.
                log(f"NOT writing rough cache: {failed_slices} failed slice(s) would poison re-runs")
            if args.rough_cache and not failed_slices:  # atomic write: tmp + replace
                tmpc = args.rough_cache + ".tmp"
                json.dump({"words": W, "lang": lang, "segs": rough_segs}, open(tmpc, "w", encoding="utf-8"))
                os.replace(tmpc, args.rough_cache)
                log(f"wrote rough cache: {args.rough_cache}")
        subprogress("transcribe", 100)  # normalize (cache-hit path never ran the loop)
        progress(35)

        stage("coarse-align")
        rough, first_idx, last_idx, interior_dropped = coarse_align(sents, W)
        trimmed_head, trimmed_tail = first_idx, N - last_idx
        log(f"narrated sentences [{first_idx}:{last_idx}] (trim head={trimmed_head}, "
            f"tail={trimmed_tail}, interior dropped={interior_dropped})")
        progress(42)

        # align workers read the full-book wav — join the background decode now
        if xt.is_alive(): log("waiting on background wav extraction")
        xt.join()
        if xerr: raise xerr[0]

        # chunk over the NARRATED sentences at gaps ~every chunk-s. rough=None
        # means "not narrated" (interior drop) — excluded from chunk text so the
        # CTC align isn't fed pages of words that have no audio.
        stage("align")
        narr = [i for i in range(first_idx, last_idx) if rough[i] is not None]
        chunks = []; capped = 0; cur = 0; base = rough[narr[0]] if narr else 0.0
        for x in range(1, len(narr) + 1):
            if x == len(narr) or (rough[narr[x]] - base) >= args.chunk_s:
                idxs = narr[cur:x]
                a = max(0.0, rough[idxs[0]] - PAD_HEAD)
                b = min(DUR, (rough[narr[x]] + PAD_TAIL) if x < len(narr) else DUR)
                # safety net: wav2vec2 memory is quadratic in audio span, so no
                # coarse regression may ever produce a memory-bomb chunk
                if b - a > 2 * args.chunk_s:
                    b = a + 2 * args.chunk_s; capped += 1
                chunks.append((len(chunks), idxs, a, b, [sents[i] for i in idxs]))
                if x < len(narr): cur = x; base = rough[narr[x]]
        if capped:
            log(f"WARNING: {capped} chunk(s) exceeded the {2 * args.chunk_s:.0f}s span cap "
                f"and were truncated — coarse alignment is likely off")
        log(f"{len(chunks)} chunks")

        sent_start = list(rough)  # default to rough; refine with WhisperX
        ctx = mp.get_context("spawn")
        completed = set()          # chunk indices (chunks[k][0]) that have finished
        failed_chunks = set()      # chunks whose align errored (kept coarse timing)
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
                    # out is None ONLY on an align error (ffmpeg/whisperx blew up
                    # in _align_chunk) — those sentences keep coarse timing BY
                    # DESIGN, but the failure is counted and reported. An empty
                    # dict is a successful align that confirmed no sentence.
                    if out is None:
                        failed_chunks.add(ci)
                    else:
                        failed_chunks.discard(ci)
                        for si, t in out.items(): sent_start[si] = t
                    progress(42 + int(56 * len(completed) / max(1, len(chunks))))
                    subprogress("align", int(100 * len(completed) / max(1, len(chunks))))
                    if len(completed) % 3 == 0 and workers > 1:
                        free = free_pct()  # cross-platform (darwin/win32/linux), None if unknown
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

    if failed_chunks:
        log(f"align: {len(failed_chunks)}/{len(chunks)} chunk(s) FAILED — their sentences "
            f"carry coarse (rough-transcript) timing, not forced alignment")
    if chunks and len(failed_chunks) == len(chunks):
        # Every single chunk errored: whisperx/ffmpeg is broken and the ENTIRE
        # VTT would be rough timing while claiming forced-alignment accuracy.
        fail(f"forced alignment failed on all {len(chunks)} chunk(s) — whisperx/ffmpeg is "
             f"broken in the align env (see stderr log); refusing to emit a VTT that is "
             f"100% rough timing",
             failedSlices=failed_slices, totalSlices=total_slices,
             failedChunks=len(failed_chunks), totalChunks=len(chunks))

    prev = None
    for i in narr:
        if prev is not None and sent_start[i] < prev: sent_start[i] = prev
        prev = sent_start[i]

    stage("write")
    def ts(t): return f"{int(t//3600):02d}:{int(t%3600//60):02d}:{t%60:06.3f}"
    # Dropped (non-narrated) sentences get no cue at all: their text occupies no
    # audio, so the preceding cue correctly runs to the next narrated start —
    # capped at MAX_CUE_S so a long unaligned stretch can't become one hour-long
    # stale cue (which also overflowed the mp4 muxer's 32-bit packet duration).
    MAX_CUE_S = 120.0
    events = []  # [start, end, text] — ebook-aligned cues
    for x, i in enumerate(narr):
        s = sent_start[i]; e = sent_start[narr[x + 1]] if x + 1 < len(narr) else min(s + 4, DUR)
        e = min(e, s + MAX_CUE_S)
        if e <= s: e = s + 0.4
        events.append([s, e, sents[i]])

    # Whisper-text fallback: audio stretches with no matching ebook text (intros,
    # credits, music, content missing from the epub) get cues from the rough
    # transcript's segments instead of dead air. Ebook cues always win — fallback
    # only fills holes ≥ HOLE_MIN_S, and the preceding ebook cue is retracted to
    # hand off at the first ASR cue instead of sitting stale over foreign audio.
    HOLE_MIN_S = 30.0
    fallback = []
    if rough_segs:
        def est_end(x):  # plausible end of event x's narration (~2.5 tokens/s + margin)
            return events[x][0] + min(MAX_CUE_S, 1.0 + 0.45 * len(events[x][2].split()))
        holes = []  # (lo, hi, index of preceding event or None)
        if events:
            if events[0][0] > HOLE_MIN_S: holes.append((0.0, events[0][0], None))
            for x in range(len(events)):
                lo = min(events[x][1], est_end(x))
                hi = events[x + 1][0] if x + 1 < len(events) else DUR
                if hi - lo > HOLE_MIN_S: holes.append((lo, hi, x))
        else:
            holes.append((0.0, DUR, None))
        si = 0  # rough_segs cursor — holes are in timeline order, so one pass
        for lo, hi, ev_x in holes:
            first = None
            while si < len(rough_segs) and rough_segs[si][0] < lo: si += 1
            while si < len(rough_segs) and rough_segs[si][0] < hi - 0.5:
                ss, se, txt = rough_segs[si]; si += 1
                if not txt: continue
                cs = max(ss, lo); ce = min(max(se, ss + 0.4), hi, ss + MAX_CUE_S)
                if ce <= cs: continue
                fallback.append([cs, ce, txt])
                if first is None: first = cs
            if ev_x is not None and first is not None and first < events[ev_x][1]:
                events[ev_x][1] = max(events[ev_x][0] + 0.4, first)
        if fallback:
            log(f"whisper-fallback: {len(fallback)} cue(s) fill {len(holes)} unaligned hole(s)")

    lines = ["WEBVTT", ""]; n = 0
    for s, e, txt in sorted(events + fallback, key=lambda c: c[0]):
        n += 1; lines += [str(n), f"{ts(s)} --> {ts(e)}", txt, ""]
    if n == 0:
        # A bare WEBVTT is not a transcript — refuse to write it and claim success.
        fail("alignment produced 0 cues — no sentence could be matched to the audio "
             "(and the rough transcript offered no fallback segments)",
             failedSlices=failed_slices, totalSlices=total_slices,
             failedChunks=len(failed_chunks), totalChunks=len(chunks))
    open(args.out, "w", encoding="utf-8").write("\n".join(lines))
    progress(100)
    emit("RESULT " + json.dumps({"ok": True, "vtt": args.out, "cues": n,
                                 "fallbackCues": len(fallback),
                                 "trimmedHead": trimmed_head, "trimmedTail": trimmed_tail,
                                 "skippedInterior": interior_dropped,
                                 "failedSlices": failed_slices, "totalSlices": total_slices,
                                 "failedChunks": len(failed_chunks), "totalChunks": len(chunks)}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(f"ERROR {e}")
        sys.exit(1)
