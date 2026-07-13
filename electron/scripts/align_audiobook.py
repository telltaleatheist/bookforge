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
  4. Drift self-check: verify final cue times against the rough transcript and
     correct multi-second local drift it can unambiguously confirm (music
     bridges / recap montages can strand a chunk past the true audio, where
     forced alignment cannot recover).
  5. Emit a sentence VTT (epub text + precise times).

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
def ts(t): return f"{int(t//3600):02d}:{int(t%3600//60):02d}:{t%60:06.3f}"

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

# Memory model (measured M1 Ultra 64 GB at 150 s chunks): steady RSS after an
# align ≈ 3.4 GB/worker, transient peak DURING a single-chunk align ≈ 6.4 GB
# (ru_maxrss, ≈2× steady) — malloc never returns the peak, and RSS under
# pressure under-reports it. The transient over steady is dominated by wav2vec2
# attention, QUADRATIC in chunk span; at the current 60 s default the worst
# capped span is 120 s (~1.7 GB attention), so budget N × 5 GB — worker peaks
# scale down with --chunk-s, so re-derive this if that default changes. Thread
# count was A/B tested (default-16 vs 4) and does NOT change memory.
GB_PER_WORKER = 5.0
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
    parts = {}; parts_s = {}; done = 0; failed = []; failed_idx = []
    ctx = mp.get_context("spawn")
    with ctx.Pool(min(TRANSCRIBE_WORKERS, n), initializer=_tinit, initargs=(audio_src, model_size)) as pool:
        for si, words, segs, err in pool.imap_unordered(_transcribe_slice, tasks):
            parts[si] = words; parts_s[si] = segs; done += 1
            if err is not None: failed.append(err); failed_idx.append(si)
            progress(4 + int(30 * done / n))
            subprogress("transcribe", int(100 * done / n))
            if done % 10 == 0: log(f"transcribe {done}/{n} slices")
    if failed:
        log(f"transcribe: {len(failed)}/{n} slice(s) FAILED — each is ~{int(SLICE_S)}s of "
            f"audio missing from the anchor stream: {'; '.join(failed[:5])}")
    W = [w for i in sorted(parts) for w in parts[i]]  # stitch in timeline order
    S = [g for i in sorted(parts_s) for g in parts_s[i]]
    return W, lang, S, sorted(failed_idx), n

def coarse_align(sents, W, failed_ranges=()):
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
    Returns (rough[], first_idx, last_idx, dropped, rate)."""
    WT = [t for _, t in W]; WN = [w for w, _ in W]; M = len(WN)
    BACK, FWD, SPAN = 8, 60, 14   # local search window / confirm span
    N = len(sents); TK = [toks(s) for s in sents]
    rough = [None] * N
    roughj = [None] * N  # word-stream index behind each matched rough time

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
    for si, j in anchors: rough[si] = WT[j]; roughj[si] = j

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
                rough[si] = WT[best]; roughj[si] = best; wi = best + len(tk)
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
        return rough, 0, N, 0, 2.5
    first_idx, last_idx = matched[0], matched[-1] + 1

    # Narration rate (tokens/sec) measured from closely-spaced matched pairs —
    # the yardstick for judging whether an unmatched run could fit its audio gap.
    # Only pairs ADJACENT in sentence space (b_i - a_i <= 3) may contribute: in a
    # recap/montage the matched quotes are thousands of epub tokens apart but
    # seconds apart in audio, and one such pair poisons the whole estimate (a
    # GraphicAudio "story so far" measured 212 tok/s — 85x reality — which then
    # let a never-narrated 39-sentence run pass the fit test below and smear
    # itself 10s over a music bridge).
    tok_sum = 0; t_sum = 0.0
    for a_i, b_i in zip(matched, matched[1:]):
        dt = rough[b_i] - rough[a_i]
        if 0 < dt <= 30 and b_i - a_i <= 3:
            tok_sum += sum(len(TK[k]) for k in range(a_i, b_i)); t_sum += dt
    rate = (tok_sum / t_sum) if t_sum > 0 and tok_sum > 0 else 2.5
    if not (0.8 <= rate <= 8.0):
        log(f"coarse: implausible narration rate {rate:.1f} tok/s; clamping into [0.8, 8.0]")
        rate = min(8.0, max(0.8, rate))

    # Interior unmatched runs. A SHORT gap is a transcription miss of narrated
    # text -> token-weighted interpolation between its matched neighbors. A run
    # whose spoken duration could never fit the audio gap is text the narrator
    # skipped (copyright page, TOC, acknowledgments, footnote bodies) -> keep it
    # None so it's excluded from chunking and the VTT, instead of smeared over
    # real audio (the Well of Ascension failure: ~90 unspoken front-matter
    # sentences dragged chapter 1's cues ~85 s late for the first ~5 minutes).
    # Two independent fit tests, run judged non-narrated when EITHER says the
    # text can't be in the gap:
    #   time test — spoken duration at the measured rate vs the audio gap;
    #   word test — text tokens vs words the transcriber actually HEARD in the
    #     gap. Immune to rate poisoning and to dead air: a music bridge makes
    #     the time gap look roomy while the word count says nobody spoke.
    # The word test is only trusted where the transcriber actually RAN: a failed
    # transcribe slice leaves a wordless stretch of real narration, so any gap
    # touching a failed slice's time range falls back to the time test alone.
    dropped = 0; rescued = 0
    for a_i, b_i in zip(matched, matched[1:]):
        if b_i == a_i + 1: continue
        gap = rough[b_i] - rough[a_i]
        gap_words = max(0, roughj[b_i] - (roughj[a_i] + len(TK[a_i])))
        run_tok = sum(len(TK[k]) for k in range(a_i + 1, b_i))
        words_trusted = not any(lo < rough[b_i] and rough[a_i] < hi for lo, hi in failed_ranges)
        if run_tok >= 12 and ((run_tok / rate > 2.0 * gap + 10.0)
                              or (words_trusted and run_tok > 2.0 * gap_words + 25)):
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
        # Narrated run: distribute its sentences over the WORDS the transcriber
        # heard in the gap, not linearly over wall-clock time — a music bridge /
        # SFX pause contributes zero words, so interpolated sentences snap to
        # actual speech instead of being smeared into the silence (the uniform-
        # rate assumption put cues ~10 s late across one 16 s bridge). Falls
        # back to time-linear when the gap has too few words to carry the
        # distribution (failed transcribe slice, ASR that heard almost nothing).
        j_a = roughj[a_i] + len(TK[a_i]); j_b = roughj[b_i]
        n_words = j_b - j_a
        use_words = words_trusted and run_tok > 0 and n_words >= max(10, 0.2 * run_tok)
        total = (run_tok + len(TK[a_i])) or 1
        cum = len(TK[a_i]); cum_run = 0
        for k in range(a_i + 1, b_i):
            if use_words:
                jk = j_a + int(n_words * (cum_run / run_tok))
                rough[k] = WT[min(max(jk, 0), M - 1)]
            else:
                rough[k] = rough[a_i] + gap * (cum / total)
            cum += len(TK[k]); cum_run += len(TK[k])
    if dropped or rescued:
        log(f"coarse: dropped {dropped} interior non-narrated sentence(s), "
            f"rescued {rescued} via interior trigrams (rate {rate:.1f} tok/s)")
    prev = None
    for i in range(N):
        if rough[i] is None: continue
        if prev is not None and rough[i] < prev: rough[i] = prev
        prev = rough[i]
    return rough, first_idx, last_idx, dropped, rate

def drift_audit(sents, narr, sent_start, W, rate, window=30.0, fix_thresh=3.0):
    """Post-alignment self-check against the rough transcript (audio truth).

    For each narrated sentence, hunt for a strong, UNAMBIGUOUS trigram-confirmed
    occurrence of its text in the rough word stream within ±window s of its cue
    time and measure the offset. Offsets beyond fix_thresh are corrected IN
    PLACE: the rough word times are good to ~±0.5 s, far better than the
    multi-second drift this catches (misplaced align chunks, montage seams,
    interpolation error the forced aligner couldn't recover from because the
    true audio fell outside its chunk). Everything else is reported untouched —
    sub-threshold offsets are as likely whisper-vs-wav2vec2 disagreement as
    real drift. Returns stats + the worst PRE-fix offenders for the report."""
    WT = [t for _, t in W]; WN = [w for w, _ in W]; M = len(WN)
    SPAN = 14
    tri = {}
    for j in range(M - 2):
        tri.setdefault((WN[j], WN[j + 1], WN[j + 2]), []).append(j)

    def hits(j, tk, need):
        k = j; m = 0
        while k < min(M, j + SPAN) and m < need:
            if WN[k] == tk[m]: m += 1
            k += 1
        return m

    checked = 0; fixed = 0; ambiguous = 0
    abs_offsets = []; offenders = []
    for i in narr:
        tk = toks(sents[i])
        if len(tk) < 3: continue
        t0 = sent_start[i]
        found = None; multi = False
        for o in range(0, min(len(tk) - 2, 9)):
            need = min(len(tk) - o, 6)
            cands = [j for j in (tri.get((tk[o], tk[o + 1], tk[o + 2])) or [])
                     if abs((WT[j] - o / rate) - t0) <= window
                     and hits(j, tk[o:], need) >= max(3, need - 1)]
            if not cands: continue
            if max(WT[j] for j in cands) - min(WT[j] for j in cands) > 2.0:
                multi = True          # repeated text inside the window — can't
            else:                     # tell which occurrence is THIS sentence
                found = (cands[0], o)
            break
        if multi: ambiguous += 1
        if found is None: continue
        j, o = found
        measured = max(0.0, WT[j] - o / rate)
        off = measured - t0
        checked += 1; abs_offsets.append(abs(off))
        if abs(off) > fix_thresh:
            offenders.append({"sentenceIndex": i, "cueTime": t0,
                              "measuredTime": measured, "offsetSeconds": off})
            sent_start[i] = measured
            fixed += 1
    abs_offsets.sort()
    offenders.sort(key=lambda x: -abs(x["offsetSeconds"]))
    n = len(abs_offsets)
    return {
        "checked": checked, "fixed": fixed, "ambiguous": ambiguous,
        "medianAbs": abs_offsets[n // 2] if n else 0.0,
        "p95Abs": abs_offsets[int(0.95 * (n - 1))] if n else 0.0,
        "maxAbs": abs_offsets[-1] if n else 0.0,
        "fixThreshold": fix_thresh, "windowS": window,
        "worst": offenders[:10],
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--sentences", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=0)
    # 60 s chunks: wav2vec2 attention is QUADRATIC in segment length, so smaller
    # chunks are both lower-memory and faster per audio-second. Accuracy is
    # unaffected (per-chunk padding + in-order word walk handle boundaries) —
    # verified when 300 s was cut to 150 s, and the mechanism is the same here.
    # 150 s was cut to 60 s after a 5-hour book with sparse coarse anchors built
    # chunks at the 2x safety cap (300 s spans): one align worker peaked at
    # ~10 GB (attention alone at 300 s ≈ 12 heads x (300*50 frames)^2 x 4 B ≈
    # 10.8 GB) and OOM-pressured the whole machine (2026-07-12). At 60 s the
    # worst capped span is 120 s ≈ 1.7 GB of attention.
    ap.add_argument("--chunk-s", type=float, default=60.0)
    ap.add_argument("--rough-model", default="base")
    ap.add_argument("--lang", default="en")
    # cache the rough transcript (words+lang JSON) so re-runs skip the ~30-40 min
    # transcribe pass when iterating on the align stage
    ap.add_argument("--rough-cache", default="")
    # coverage report: JSON mapping epub↔audio coverage — which epub sentence runs
    # were never narrated (head/tail trims, interior drops) and which audio ranges
    # have no epub match (ads, intros, disc breaks), each with text/time anchors
    ap.add_argument("--report", default="")
    # minimum unmatched-audio duration treated as a hole. Drives BOTH the report's
    # audioNotInEpub entries AND whisper-fallback cue filling (same concept — audio
    # the ebook doesn't cover). Below it, gaps are absorbed as cue slack.
    ap.add_argument("--hole-min-s", type=float, default=30.0)
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "mps"])
    args = ap.parse_args()
    if args.hole_min_s < 0:
        ap.error(f"--hole-min-s must be >= 0 (got {args.hole_min_s}); 0 = report every gap")

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
        W = None; rough_segs = []; failed_slice_idx = []; failed_slices = 0; total_slices = 0
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
            W, lang, rough_segs, failed_slice_idx, total_slices = rough_transcribe(args.audio, args.rough_model, args.lang, DUR)
            failed_slices = len(failed_slice_idx)
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
        failed_ranges = [(si * SLICE_S, (si + 1) * SLICE_S) for si in failed_slice_idx]
        rough, first_idx, last_idx, interior_dropped, narr_rate = coarse_align(sents, W, failed_ranges)
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

    # Drift self-check: verify the final cue times against the rough transcript
    # and correct multi-second local drift it can unambiguously confirm (the
    # forced aligner can't recover when the true audio fell outside its chunk).
    drift = drift_audit(sents, narr, sent_start, W, narr_rate)
    if drift["checked"]:
        log(f"drift check: {drift['checked']} cue(s) verified against the rough transcript; "
            f"|offset| median {drift['medianAbs']:.2f}s p95 {drift['p95Abs']:.2f}s max {drift['maxAbs']:.2f}s; "
            f"corrected {drift['fixed']} cue(s) off by > {drift['fixThreshold']:.0f}s"
            + (f"; {drift['ambiguous']} ambiguous (repeated text) skipped" if drift["ambiguous"] else ""))
        for w in drift["worst"][:5]:
            log(f"  drift-fixed s{w['sentenceIndex']}: cue {ts(w['cueTime'])} -> "
                f"audio {ts(w['measuredTime'])} ({w['offsetSeconds']:+.1f}s)")
    if drift["fixed"]:
        prev = None  # corrections can disturb monotonicity — re-clamp
        for i in narr:
            if prev is not None and sent_start[i] < prev: sent_start[i] = prev
            prev = sent_start[i]

    stage("write")
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
    # The holes themselves are computed unconditionally: --report needs them even
    # when a cached rough transcript predates segment support. At --hole-min-s 0
    # EVERY positive gap registers (maximal ad-hunting: the report lists them all
    # and whisper cues fill any with transcript segments inside).
    HOLE_MIN_S = args.hole_min_s
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
    fallback = []
    hole_text = [None] * len(holes)  # rough-transcript text per hole (for --report)
    if rough_segs:
        si = 0  # rough_segs cursor — holes are in timeline order, so one pass
        for hx, (lo, hi, ev_x) in enumerate(holes):
            first = None; texts = []
            while si < len(rough_segs) and rough_segs[si][0] < lo: si += 1
            while si < len(rough_segs) and rough_segs[si][0] < hi - 0.5:
                ss, se, txt = rough_segs[si]; si += 1
                if not txt: continue
                cs = max(ss, lo); ce = min(max(se, ss + 0.4), hi, ss + MAX_CUE_S)
                if ce <= cs: continue
                fallback.append([cs, ce, txt])
                texts.append(txt)
                if first is None: first = cs
            if texts: hole_text[hx] = " ".join(texts)
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

    # --report: coverage map. Everything here is data the pipeline already
    # computed — the report just keeps it instead of discarding it. Anchors are
    # text snippets + timestamps so a human can search the epub / seek the audio
    # to find each boundary (sentence indexes refer to the extracted sentence
    # list, which the reader doesn't have — the text IS the locator).
    if args.report:
        def _clip(s, cap=200):
            s = " ".join(s.split())
            return s if len(s) <= cap else s[:cap - 1] + "…"
        def _neighbor(i):  # i is narrated ⇒ sent_start[i] is a real time
            return {"sentenceIndex": i, "text": _clip(sents[i]),
                    "audioTime": round(sent_start[i], 2), "timestamp": ts(sent_start[i])}
        narr_set = set(narr)
        excluded = []  # maximal runs of consecutive never-narrated sentences
        i = 0
        while i < N:
            if i in narr_set:
                i += 1; continue
            j = i
            while j < N and j not in narr_set: j += 1
            # runs are maximal, so a run starting before first_idx ends AT it
            reason = "head" if i < first_idx else ("tail" if i >= last_idx else "interior")
            excluded.append({
                "reason": reason,
                "sentenceRange": [i, j - 1],
                "count": j - i,
                "firstSentence": _clip(sents[i]),
                "lastSentence": _clip(sents[j - 1]),
                "narratedBefore": _neighbor(i - 1) if i > 0 else None,
                "narratedAfter": _neighbor(j) if j < N else None,
            })
            i = j
        audio_unmatched = []
        for hx, (lo, hi, ev_x) in enumerate(holes):
            if ev_x is not None:
                before = _neighbor(narr[ev_x])
                after = _neighbor(narr[ev_x + 1]) if ev_x + 1 < len(narr) else None
            else:  # hole before the first narrated sentence
                before = None
                after = _neighbor(narr[0]) if narr else None
            audio_unmatched.append({
                "audioStart": round(lo, 2), "audioEnd": round(hi, 2),
                "startTimestamp": ts(lo), "endTimestamp": ts(hi),
                "durationSeconds": round(hi - lo, 1),
                "epubBefore": before,
                "epubAfter": after,
                "transcript": _clip(hole_text[hx], 2500) if hole_text[hx] else None,
            })
        report = {
            "audio": os.path.abspath(args.audio),
            "epub": None,  # the script only sees extracted sentences; the bridge fills this in
            "summary": {
                "epubSentences": N,
                "narratedSentences": len(narr),
                "excludedSentences": N - len(narr),
                "excludedRuns": len(excluded),
                "trimmedHead": trimmed_head,
                "trimmedTail": trimmed_tail,
                "interiorDropped": interior_dropped,
                "audioDurationSeconds": round(DUR, 1),
                "audioDurationTimestamp": ts(DUR),
                "unmatchedAudioRanges": len(holes),
                "unmatchedAudioSeconds": round(sum(hi - lo for lo, hi, _ in holes), 1),
                "holeThresholdSeconds": HOLE_MIN_S,
            },
            "epubNotInAudio": excluded,
            "audioNotInEpub": audio_unmatched,
            "driftSelfCheck": {
                "checkedCues": drift["checked"],
                "medianAbsSeconds": round(drift["medianAbs"], 2),
                "p95AbsSeconds": round(drift["p95Abs"], 2),
                "maxAbsSeconds": round(drift["maxAbs"], 2),
                "correctedCues": drift["fixed"],
                "correctionThresholdSeconds": drift["fixThreshold"],
                "ambiguousSkipped": drift["ambiguous"],
                "corrected": [{
                    "sentenceIndex": w["sentenceIndex"],
                    "text": _clip(sents[w["sentenceIndex"]]),
                    "cueWas": ts(w["cueTime"]),
                    "movedTo": ts(w["measuredTime"]),
                    "offsetSeconds": round(w["offsetSeconds"], 2),
                } for w in drift["worst"]],
            },
        }
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        log(f"coverage report: {len(excluded)} excluded epub run(s), "
            f"{len(holes)} unmatched audio range(s) -> {args.report}")

    progress(100)
    emit("RESULT " + json.dumps({"ok": True, "vtt": args.out, "cues": n,
                                 "fallbackCues": len(fallback),
                                 "report": args.report or None,
                                 "trimmedHead": trimmed_head, "trimmedTail": trimmed_tail,
                                 "skippedInterior": interior_dropped,
                                 "failedSlices": failed_slices, "totalSlices": total_slices,
                                 "failedChunks": len(failed_chunks), "totalChunks": len(chunks),
                                 "driftChecked": drift["checked"],
                                 "driftMaxAbs": round(drift["maxAbs"], 2),
                                 "driftFixed": drift["fixed"]}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(f"ERROR {e}")
        sys.exit(1)
