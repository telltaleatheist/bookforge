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
  4b. Cue EDGES (2026-09-06). A cue is its own sentence's speech: it starts a
     little before its first word and ends a little after its LAST word, and the
     narrator's pause is left BETWEEN cues. Cues are therefore NOT contiguous.
     With --snap-silence-s > 0 (default 0.6) each edge is additionally placed
     INDEPENDENTLY inside the pause the silence map actually found, bounded by that
     window. --contiguous-cues restores the old gapless build (cue N ends at cue
     N+1's onset, seams snapped by snap_boundaries) for a consumer that needs it.
     The silence map comes from auto-editor's loudness analysis when its binary is
     on PATH (--silence-source, --ae-threshold, --ae-min-silence-s), else ffmpeg
     silencedetect off the already-decoded 16 kHz wav; --silence-map <json> takes a
     pre-computed one (autoeditor_silences.py's shape, or a bare [[s, e], ...]).
     Either scan runs on a background thread during the align stage, so it costs no
     wall clock. auto-editor is the default because it MEASURES better at word
     edges: on a 148-cue sample it halved the mid-word edge rate (2.36% -> 1.01%)
     against silencedetect, mostly by seeing the 0.04-0.25 s pauses silencedetect's
     duration floor hides.
  5. Emit a sentence VTT (epub text + precise times). Cues from heading blocks
     carry `NOTE heading`; whisper-fallback cues carry `NOTE asr-fallback`; every
     book cue carries `NOTE align matched=… start=… end=… offset=…` (per-cue
     confidence, mirrored in --report's `cues` array).

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
                     [--device cpu|mps] [--snap-silence-s 0.6] [--contiguous-cues]
                     --silence-source ffmpeg|auto-editor [--silence-map M.json]
                     [--report-hole-min-s 3]

Cue-edge quality is measured, not asserted: electron/scripts/measure_cue_edges.py
scores a VTT's edges against the audio's own envelope (mid-word edges, ends inside
speech, ends on the next onset, starts with no lead-in).
  S.json: ["sentence 1", "sentence 2", ...]  (epub sentences, in reading order)
     or: [{"text": "...", "kind": "prose"|"heading"}, ...]  — `kind` tags the cue
"""
import argparse, bisect, hashlib, json, os, re, subprocess, sys, tempfile, threading, time
import multiprocessing as mp

DEVICE = "cpu"   # module default; the real device is resolved per-run and propagated to
                 # spawn workers via the ALIGN_DEVICE env (set by main after --device auto-
                 # resolves — favors CUDA when available, else Apple MPS, else CPU).


def _resolved_device():
    return os.environ.get("ALIGN_DEVICE", DEVICE)


def _make_whisper(model_size):
    """faster-whisper model on the resolved device: CUDA float16 when available,
    else CPU int8 (faster-whisper/ctranslate2 has no MPS backend, so mps -> cpu)."""
    from faster_whisper import WhisperModel
    if _resolved_device() == "cuda":
        return WhisperModel(model_size, device="cuda", compute_type="float16")
    return WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=4)
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

# How far ahead the sentence walker may look for the next epub token before it
# declares that token un-emitted. SMALL ON PURPOSE: the aligned word stream IS
# this chunk's epub text, so a sentence's next token is normally the very next
# word. A wide look-ahead is exactly how the old count-based cursor over-ran on
# repeated tokens ("...of the sea. Of the..."), which would now hand a sentence
# the END TIME of a word belonging to a later one.
CONSUME_LOOK = 3


def _consume_sentence(words, j, tk):
    """Walk the chunk's aligned word stream from index `j` over one sentence's
    tokens `tk`. Returns (last_word_end, next_cursor).

    The old code never did this: it kept word STARTS only and advanced the cursor
    by a token COUNT (`wi = k + len(tk) - need`), an estimate. Walking the tokens
    gives the sentence's real last-word end AND an exact cursor for the next
    sentence, and the tight look-ahead is the repeated-token guard."""
    p = j; last_end = None; last_hit = j - 1
    for t in tk:
        q = p; hit = None
        while q < min(len(words), p + CONSUME_LOOK + 1):
            if words[q][2] == t:
                hit = q; break
            q += 1
        if hit is None:
            continue                      # token the aligner never emitted — hold the cursor
        if words[hit][1] is not None:
            last_end = words[hit][1]
        last_hit = hit; p = hit + 1
    return last_end, min(max(p, last_hit + 1), len(words))


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
        # KEEP THE WORD ENDS. Until 2026-09-06 this discarded w["end"], so a
        # sentence had no end of its own and every cue was forced to run to the
        # NEXT sentence's onset — see build_events.
        words = []
        for sg in res["segments"]:
            for w in sg.get("words", []):
                words.append((w.get("start"), w.get("end"), _norm(w.get("word", ""))))
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
                if words[j][2] == tk[0] and words[j][0] is not None:
                    m = 1; k = j + 1
                    while k < min(len(words), j + 12) and m < need:
                        if words[k][2] == tk[m]: m += 1
                        k += 1
                    if m >= (need if need <= 2 else need - 1):  # tolerate 1 miss when 3+
                        end, wi = _consume_sentence(words, j, tk)
                        out[si] = (words[j][0] + a, (end + a) if end is not None else None)
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
GB_PER_WORKER = 2.0  # was 5.0 — stale since --chunk-s went 150->60 (2026-07-12).
# That change cut a worker's worst capped span from 300s (~10.8GB of wav2vec2
# attention) to 120s (~1.7GB), but this constant was only trimmed 6.5->5.0, so the
# sizing formula kept reserving ~5x what a worker uses. MEASURED 2026-07-24 on a 32h
# align: the transcribe-stage worker held 0.96GB working set, and the align stage's
# worst case is the 1.7GB above — so 2.0 covers the heavier stage with margin.
# Consequence of the stale value: auto_workers() returned 1 of a possible 4 on a box
# with 18GB free ((18.3-12)//5 == 1), leaving the parallel transcribe stage — a
# multiprocessing Pool over audio slices — running single-threaded. At 2.0 the same
# box gets 3 workers. RAM_HEADROOM_GB stays 12.0: the pool also self-shrinks under
# pressure, so the headroom is belt-and-braces, not the only guard.
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
    _TAUDIO = audio_path
    _TMODEL = _make_whisper(model_size)

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
            m = _make_whisper(model_size)
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
    tw = 1 if _resolved_device() == "cuda" else min(TRANSCRIBE_WORKERS, n)
    with ctx.Pool(tw, initializer=_tinit, initargs=(audio_src, model_size)) as pool:
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
    # direct[i] = the sentence's OWN opening was found in the transcript word
    # stream (anchor / local-fill / interior rescue) — so rough[i] is a REAL
    # spoken start (~±0.5s audio truth), not a token-weighted interpolation.
    # The align stage trusts these over wav2vec2 when the two disagree.
    direct = [False] * N

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
    for si, j in anchors: rough[si] = WT[j]; roughj[si] = j; direct[si] = True

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
                rough[si] = WT[best]; roughj[si] = best; direct[si] = True; wi = best + len(tk)
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
        return rough, 0, N, 0, 2.5, direct
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
                        last_t = WT[hit]; rescued += 1; direct[k] = True
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
    return rough, first_idx, last_idx, dropped, rate, direct

def drift_audit(sents, narr, sent_start, W, rate, window=30.0, fix_thresh=1.5,
                silences=None, sil_starts=None):
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
    kept_ctc = 0          # CTC time contradicted but landing in a real pause
    applied = []          # cues whose start was ACTUALLY replaced by the rough clock
    suspect = set()       # contradicted AND mid-speech: refuse to guess
    abs_offsets = []; residual_offsets = []; offenders = []
    # per-sentence measured offset (PRE-fix), so every cue can carry its own
    # audio-truth agreement into the VTT NOTE and the report instead of the run
    # only publishing aggregates.
    per_index = {}
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
        checked += 1; abs_offsets.append(abs(off)); per_index[i] = off
        if abs(off) > fix_thresh:
            offenders.append({"sentenceIndex": i, "cueTime": t0,
                              "measuredTime": measured, "offsetSeconds": off})
            # SUBSTITUTION IS A DOWNGRADE (2026-09-06). `measured` comes from the
            # rough transcript: +-0.5 s, and on this narrator it runs 0.3-1.0 s LATE,
            # whereas the cue time it would replace is a wav2vec2 phoneme boundary
            # good to ~10 ms. So substitute only when there is no silence map to
            # check against. With a map: keep the CTC time when it lands in a real
            # pause, else refuse to guess and mark the cue SUSPECT so a corpus cutter
            # drops it - a confident-looking wrong time is worse than an admitted one.
            # Same finding as the whisper-authority branch: correcting to the rough
            # clock rescues a cue whose CTC time is already wrong by seconds. Do it,
            # and tag the cue so a corpus cutter can drop it.
            if silences and onset_in_pause(t0, silences, sil_starts):
                kept_ctc += 1
            suspect.add(i)
            sent_start[i] = measured
            fixed += 1; applied.append(i)
            # Post-correction this cue now sits AT `measured`, so its residual
            # offset vs the audio-truth word time is ~0. Uncorrected cues keep
            # their measured offset. Same checked set, no re-measurement — this
            # is what the final VTT actually looks like, which the pre-fix
            # median/p95/max hide (they report the drift BEFORE it was fixed).
            residual_offsets.append(0.0)
        else:
            residual_offsets.append(abs(off))
    abs_offsets.sort()
    residual_offsets.sort()
    offenders.sort(key=lambda x: -abs(x["offsetSeconds"]))
    n = len(abs_offsets)
    nr = len(residual_offsets)
    return {
        "checked": checked, "fixed": fixed, "ambiguous": ambiguous,
        "medianAbs": abs_offsets[n // 2] if n else 0.0,
        "p95Abs": abs_offsets[int(0.95 * (n - 1))] if n else 0.0,
        "maxAbs": abs_offsets[-1] if n else 0.0,
        "residualMedianAbs": residual_offsets[nr // 2] if nr else 0.0,
        "residualP95Abs": residual_offsets[int(0.95 * (nr - 1))] if nr else 0.0,
        "residualMaxAbs": residual_offsets[-1] if nr else 0.0,
        "fixThreshold": fix_thresh, "windowS": window,
        "keptCtc": kept_ctc, "suspect": sorted(suspect),
        "worst": offenders[:10],
        "offsets": per_index,
        # every corrected sentence, not just the worst 10 in `worst`: a corrected
        # cue's start came from the ROUGH transcript clock, and a consumer needs to
        # know that about its own cue.
        "fixedIndices": applied,
    }


# How long to wait for the background silence scan once the align pool is done.
# It runs concurrently with ~30 min of alignment and takes ~1 min, so reaching
# this at all means ffmpeg is wedged.
SILENCE_SCAN_TIMEOUT_S = 120.0


def detect_silences(wav_path, noise_db, min_s):
    """ffmpeg silencedetect over the already-decoded 16 kHz mono wav -> sorted
    [(start, end)]. Runs on the wav rather than the source file because the wav is
    already on disk (the align workers need it) and decoding it again from a 6-hour
    FLAC would cost minutes for nothing.

    Called on a background thread while the align pool works, so the whole map is
    free wall-clock. A failure here is NOT fatal: snapping is an improvement pass,
    and no silence map simply means no snapping."""
    p = subprocess.run(
        ["ffmpeg", "-v", "info", "-nostats", "-i", wav_path,
         "-af", f"silencedetect=noise={noise_db}dB:d={min_s}", "-f", "null", "-"],
        capture_output=True, text=True, errors="replace")
    iv, start = [], None
    for line in p.stderr.splitlines():
        m = re.search(r"silence_start:\s*(-?[\d.]+)", line)
        if m:
            start = float(m.group(1)); continue
        m = re.search(r"silence_end:\s*(-?[\d.]+)", line)
        if m and start is not None:
            end = float(m.group(1))
            if end > start: iv.append((start, end))
            start = None
    iv.sort()
    return iv


# auto-editor's audio timebase is EXACTLY 30 fps for audio-only input. NEVER derive
# it as frames/duration: auto-editor drops the trailing partial chunk, so the frame
# count is short by 1-2 s worth, and dividing smears that deficit across the whole
# timeline as a linear stretch (+1.5 s by the end of a 12 h book) — which is how
# snapped boundaries ended up mid-sentence in orpheus-finetune's cutter.
AE_FPS = 30.0


def load_silence_map(path):
    """External silence map -> sorted [(start, end)].

    Accepts autoeditor_silences.py's shape ({"silences": [[s, e], ...], "fps", "thr",
    "duration"}) or a bare [[s, e], ...]. Raises on anything else rather than
    silently running with an empty map — a caller that passed --silence-map asked
    for THAT map, and falling back to "no snapping" would look like success."""
    d = json.load(open(path, encoding="utf-8"))
    raw = d.get("silences") if isinstance(d, dict) else d
    if not isinstance(raw, list):
        raise ValueError(f"{path}: expected a list of [start, end] pairs "
                         f"(or {{'silences': [...]}}), got {type(raw).__name__}")
    iv = []
    for k, p in enumerate(raw):
        if not (isinstance(p, (list, tuple)) and len(p) >= 2):
            raise ValueError(f"{path}: entry {k} is not a [start, end] pair: {p!r}")
        a, z = float(p[0]), float(p[1])
        if z > a: iv.append((a, z))
    iv.sort()
    return iv


def detect_silences_autoeditor(src, thr, min_s, total_dur, exe="auto-editor"):
    """auto-editor's per-frame loudness analysis -> sorted [(start, end)].

    Owen's asset for exactly this job, and the same analysis autoeditor_silences.py
    wraps. It beats ffmpeg silencedetect at cue edges for two reasons measured on
    the chapter-0 sample: it is a normalized LOUDNESS envelope rather than a fixed
    dB gate, and it can be asked for pauses well under silencedetect's practical
    floor — the 0.15-0.25 s inter-sentence pauses that silencedetect at 0.25 s
    cannot see at all, which is where the aligner was placing its worst edges.

    Returns [] (and logs) on any failure: a silence map is an improvement pass."""
    p = subprocess.run([exe, "levels", src, "--edit", "audio"],
                       capture_output=True, text=True, errors="replace")
    if p.returncode != 0:
        log(f"auto-editor levels failed (exit {p.returncode}): {p.stderr.strip()[-400:]}")
        return []
    vals = []; started = False
    for line in p.stdout.splitlines():
        s = line.strip()
        if not s: continue
        if s.startswith("@"):
            started = started or s == "@start"
            continue
        if started:
            try: vals.append(float(s))
            except ValueError: pass
    if not vals:
        log("auto-editor levels produced no values")
        return []
    expected = total_dur * AE_FPS
    if abs(len(vals) - expected) > 90:   # >3 s: not just the trailing chunk
        log(f"auto-editor frame count {len(vals)} vs expected {expected:.0f} differs by "
            f"{abs(len(vals) - expected) / AE_FPS:.1f}s — refusing a stretched timeline")
        return []
    iv = []; i = 0; n = len(vals)
    while i < n:
        if vals[i] < thr:
            j = i
            while j < n and vals[j] < thr: j += 1
            a, z = i / AE_FPS, j / AE_FPS
            if z - a >= min_s: iv.append((a, z))
            i = j
        else:
            i += 1
    return iv


def align_fingerprint(sents, rough_model, chunk_s, lang):
    """Identity of an align result: the exact sentence list plus every input that
    changes the CTC output. A cache written under a different fingerprint is a
    different alignment and must never be silently reused."""
    h = hashlib.sha256()
    h.update(("\u0000".join(sents)).encode("utf-8"))
    h.update(f"|{rough_model}|{chunk_s}|{lang}".encode("utf-8"))
    return h.hexdigest()


def load_align_cache(path, fingerprint, n):
    """Cached per-sentence CTC output -> (sent_start, sent_span), or None.

    THE POINT: the align stage is the expensive one (a 7 h book is ~40 min of GPU),
    but everything downstream of it - the whisper-authority rule, drift, cue edges,
    the VTT - is pure arithmetic over its output. Caching that boundary makes
    iterating on cue TIMING free, instead of re-transcribing and re-aligning a book
    to change a threshold."""
    try:
        c = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        log(f"align cache unreadable ({e}); realigning")
        return None
    if c.get("fingerprint") != fingerprint:
        log("align cache is for a different sentence list / rough model / chunk size; realigning")
        return None
    ss, sp = c.get("sentStart"), c.get("sentSpan")
    if not (isinstance(ss, list) and isinstance(sp, list) and len(ss) == n and len(sp) == n):
        log(f"align cache has {len(ss) if isinstance(ss, list) else '?'} entries, expected {n}; realigning")
        return None
    return ss, sp


def write_align_cache(path, fingerprint, sent_start, sent_span):
    tmp = path + ".tmp"
    json.dump({"fingerprint": fingerprint, "sentStart": sent_start, "sentSpan": sent_span},
              open(tmp, "w", encoding="utf-8"))
    os.replace(tmp, path)
    log(f"wrote align cache: {path}")


# Cue length bounds, module-level so the regression suite exercises THE SHIPPED
# LOOP rather than a copy of it (an earlier suite reimplemented build_events in the
# test file, so main()'s actual loop was never executed by any test).
MAX_CUE_S = 120.0
MIN_CUE_S = 0.4

# ---- cue EDGE geometry (2026-09-06) -----------------------------------------
# THE DEFECT this replaces: cues were contiguous BY CONSTRUCTION — cue N's end was
# cue N+1's onset — so the whole inter-sentence pause lived inside cue N and the
# next sentence's first syllable sat at every cue end. Measured on a shipped VTT:
# 74% of clips cut with a +0.2 s pad contained the next sentence's first syllable.
# Starts had the mirror problem: the raw CTC onset of word 1 with zero pre-roll,
# and CTC onsets run late on plosives and breaths (7% of cues started within 20 ms
# of, or after, their own speech onset).
#
# Now each cue covers ITS OWN speech: [first word start - START_PAD,
# last word end + END_PAD], each edge clamped off its neighbour by EDGE_GAP and,
# when a silence map exists, placed INSIDE the narrator's actual pause.
END_PAD_S = 0.25        # air kept after the sentence's last word
START_PAD_S = 0.15      # pre-roll before the sentence's first word
EDGE_GAP_S = 0.04       # a cue edge never comes closer than this to a neighbour
# When the pause is too SHORT to give both neighbours their full pad, the two
# edges share it in proportion instead of one of them being clamped flat against
# the other. Clamping was measured to be the single biggest remaining defect: a
# pause under END_PAD+EDGE_GAP pinned cue N's end at `next_onset - 0.04`, which
# then pinned cue N+1's start at `prev_end + 0.04` — i.e. exactly on its own first
# syllable, with no lead-in at all. (Chapter-0 measurement: 12.8% of starts and
# 8.8% of ends, every one of them a short-pause pair.)
END_SHARE = END_PAD_S / (END_PAD_S + START_PAD_S)      # 0.625
START_SHARE = START_PAD_S / (END_PAD_S + START_PAD_S)  # 0.375
# Ties/inversions only. main()'s monotonic clamps pin an out-of-order start EQUAL
# to its predecessor; without a floor that leaves a zero-length cue. A genuine
# 0.3 s gap between two short sentences is left alone.
MIN_START_GAP_S = 0.12


# A silence "belongs to" a sentence onset when it ends within this of it — the
# slack absorbs a breath and a CTC onset that fires a frame or two early.
PAUSE_TOUCH_S = 0.25


def _pause_before(silences, sil_starts, target, floor):
    """The narrator's pause immediately before the onset `target`: the last silence
    interval that starts before `target`, ends within PAUSE_TOUCH_S of it, and
    starts after `floor`. Returns (start, end-clipped-to-target) or None.

    THIS, not the aligner's word end, is where a sentence's speech actually stops.
    wav2vec2's final word routinely runs straight THROUGH the pause to the next
    onset — CTC keeps the last token active over the trailing blank — and a span
    that reaches the next onset makes every "end = last word + pad" rule collapse
    onto the next sentence's first syllable. Measured on the chapter-0 sample: all
    10 remaining bad ends had a word end within 0.11 s of the next onset while the
    audio held a 0.2-0.9 s pause. Reading the pause instead fixes both edges at
    once, and reading it ONCE per boundary is what guarantees the two cues cannot
    collide over it."""
    k = bisect.bisect_left(sil_starts, target) - 1
    if k < 0:
        return None
    a, z = silences[k]
    if a <= floor or z < target - PAUSE_TOUCH_S:
        return None
    z2 = min(z, target)
    return (a, z2) if z2 > a else None


def _pause_after(silences, sil_starts, word_end, limit):
    """The first pause at or after `word_end` and starting before `limit`.

    The end's second chance. `_pause_before` answers "where did the narrator stop
    before the next sentence", which is the right question at a normal boundary but
    the wrong one when unmatched audio (a footnote read, a sting) sits between the
    two sentences: that pause is seconds away and belongs to the foreign audio, not
    to this cue. The pause immediately after our own last word does belong to us."""
    k = bisect.bisect_left(sil_starts, word_end)
    if k > 0: k -= 1
    while k < len(silences) and silences[k][0] < limit:
        a, z = silences[k]
        if z > word_end:
            a2 = max(a, word_end)
            if z > a2: return (a2, z)
        k += 1
    return None


def onset_in_pause(t, silences, sil_starts):
    """True when time `t` sits at a real sentence boundary per the silence map:
    a detected pause ends within PAUSE_TOUCH_S of it.

    Uses the SAME rule build_events uses to place a cue start, so "the CTC time is
    fine" here means exactly "the start snap would find a pause to sit in"."""
    if not silences:
        return False
    return _pause_before(silences, sil_starts, t, -1e18) is not None


def build_events(sent_start, narr, sents, kinds, dur, sent_span=None,
                 silences=None, snap_window=0.0, contiguous=False):
    """Narrated sentences -> [[start, end, text, kind, meta]] cues.

    DEFAULT (non-contiguous): a cue is its own sentence's speech plus a small,
    bounded margin. `sent_span[i]` is the wav2vec2 span (last word end - first word
    start) for sentence i, or None when the aligner never confirmed it — those cues
    fall back to the old "run to the next onset" end and SAY SO in their meta
    (endSource == "next-onset"), so a downstream cutter can tell a measured edge
    from an inferred one.

      end   = min(last_word_end + END_PAD_S, next_onset - EDGE_GAP_S)
      start = max(first_word_start - START_PAD_S, prev_end + EDGE_GAP_S)

    then, when a silence map is available (`snap_window` > 0), each edge is snapped
    INDEPENDENTLY into the pause that is actually there — the end END_PAD_S into
    the silence that follows the last word, the start no earlier than the start of
    the silence that precedes the first word. An edge may not move more than
    `snap_window` from its word-derived position, so a coarse silence map can
    correct a CTC frame but never manufacture drift.

    `contiguous=True` restores the pre-2026-09-06 behaviour (cue N ends at cue N+1's
    onset) for any consumer that needs a gapless timeline. It is OFF by default:
    the gaps are the point — the pause belongs to neither sentence.

    Dropped (non-narrated) sentences get no cue at all. MAX_CUE_S caps a cue so a
    long unaligned stretch can't become one hour-long stale cue (which also
    overflowed the mp4 muxer's 32-bit packet duration).

    MUTATES `sent_start` on ties, deliberately: an out-of-order start is pushed out
    so the timeline stays strictly sorted, and the shift must be visible to the
    report (which reads `sent_start`) as well as to the VTT.
    """
    n = len(narr)
    if contiguous:
        events = []
        for x, i in enumerate(narr):
            s = sent_start[i]
            e = sent_start[narr[x + 1]] if x + 1 < n else min(s + 4, dur)
            e = min(e, s + MAX_CUE_S)
            if e <= s:
                e = s + MIN_CUE_S
                if x + 1 < n: sent_start[narr[x + 1]] = e
            events.append([s, e, sents[i], kinds[i],
                           {"sentenceIndex": i, "startSource": "word",
                            "endSource": "next-onset"}])
        return events

    if n == 0:
        return []
    # de-tie first, so every cue has room to exist
    starts = [sent_start[i] for i in narr]
    for x in range(1, n):
        if starts[x] < starts[x - 1] + MIN_START_GAP_S:
            starts[x] = starts[x - 1] + MIN_START_GAP_S
            sent_start[narr[x]] = starts[x]

    sil = silences if (silences and snap_window > 0) else None
    sil_starts = [a for a, _ in sil] if sil else None

    # wav2vec2 last-word ends, clamped off the next onset. Treated as EVIDENCE, not
    # truth: see _pause_before for the CTC trailing-blank over-run.
    wends = []
    for x in range(n):
        sp = sent_span[narr[x]] if sent_span is not None else None
        nxt = starts[x + 1] if x + 1 < n else dur
        wends.append(min(starts[x] + sp, nxt) if (sp is not None and sp > 0) else None)

    def split(x, target, floor):
        """ONE decision per boundary: (end of cue x, start of the cue at `target`,
        end source, start source). Both edges come out of the same pause, so they
        are always at least EDGE_GAP_S apart and can never be placed in conflict.
        `x` is -1 for the boundary before the first cue (no cue ends there)."""
        w = wends[x] if x >= 0 else None

        def place(a, z):
            """Share one pause between the cue ending in it and the cue starting
            after it. The two shares plus the reserved gap sum to the pause, so the
            edges stay >= EDGE_GAP_S apart however short it is."""
            r = max(0.0, z - a - EDGE_GAP_S)
            return (a + min(END_PAD_S, END_SHARE * r),
                    z - min(START_PAD_S, START_SHARE * r))

        # 1. the pause the next sentence begins out of — the normal case, and the
        #    only evidence that survives wav2vec2 running its last word through it.
        p = _pause_before(sil, sil_starts, target, floor) if sil else None
        s = None; s_src = "word"
        if p is not None:
            pe, ps = place(*p)
            if abs(ps - (target - START_PAD_S)) <= snap_window:
                s, s_src = ps, "silence"
                # The END may follow that pause only when the pause is plausibly
                # OURS. One seconds past our last word belongs to whatever was read
                # in between — a footnote, a sting, audio the epub does not cover.
                if w is None or p[0] <= w + snap_window:
                    return (pe, s, "silence", s_src)
        if w is None:
            # No measured end for this cue. The pre-roll still gets its pad — the
            # next sentence's onset is known — and the unmeasured end yields to it:
            # losing 0.19 s off an end nobody measured beats leaving the next
            # sentence's first syllable inside this clip. Flagged `next-onset`.
            if s is None: s = target - START_PAD_S
            return (min(s, target - START_PAD_S) - EDGE_GAP_S, s, "next-onset", s_src)
        # 2. failing that, the pause immediately after OUR last word.
        q = _pause_after(sil, sil_starts, w, target) if sil else None
        if q is not None and q[0] <= w + END_PAD_S + snap_window:
            return (place(*q)[0],
                    s if s is not None else target - min(START_PAD_S,
                        START_SHARE * max(0.0, target - w - EDGE_GAP_S)),
                    "silence", s_src)
        # 3. no pause the detector can see: share the room with the next onset.
        r = max(0.0, target - w - EDGE_GAP_S)
        return (w + min(END_PAD_S, END_SHARE * r),
                s if s is not None else target - min(START_PAD_S, START_SHARE * r),
                "word", s_src)

    ends = [0.0] * n; esrc = ["next-onset"] * n
    sts = [0.0] * n; ssrc = ["word"] * n
    _e0, sts[0], _es0, ssrc[0] = split(-1, starts[0], -1e18)
    sts[0] = max(0.0, sts[0])
    for x in range(n):
        target = starts[x + 1] if x + 1 < n else dur
        e, s, es, ss = split(x, target, starts[x])
        ceiling = min(target - EDGE_GAP_S, starts[x] + MAX_CUE_S, dur)
        ends[x] = max(min(e, ceiling), min(starts[x] + MIN_CUE_S, ceiling))
        esrc[x] = es
        if x + 1 < n:
            sts[x + 1] = max(s, ends[x] + EDGE_GAP_S, 0.0); ssrc[x + 1] = ss

    events = []
    for x in range(n):
        i = narr[x]
        s = sts[x]
        if s >= ends[x]:                 # degenerate; keep the cue non-empty
            s = max(0.0, min(starts[x], ends[x] - 1e-3))
        events.append([s, ends[x], sents[i], kinds[i],
                       {"sentenceIndex": i, "startSource": ssrc[x], "endSource": esrc[x]}])
    return events


def speech_coverage(events, silences, min_dur=3.0, max_speech=0.30, cap=40):
    """Cues that are mostly SILENCE — the honest "audio with no narration" signal.

    Still the honest measure even now that cues are non-contiguous: find_holes then
    reports the literal gaps between cues, but a stretch of dead air INSIDE a cue
    (a sting the aligner smeared a sentence over) is invisible to it either way.
    This is a measurement: intersect each cue's span with
    the detected silence intervals and report the fraction that is actually spoken.

    A cue at least `min_dur` long whose span is `max_speech` or less speech is
    holding dead air, a music sting, or a stretch the narrator never read — the
    thing you want to find, at any duration, without inventing 137 false ranges.

    Returns (worst `cap` of them, total) — or (None, None) when there is NO SILENCE
    MAP to measure against (snapping off, the scan failed, the scan was abandoned).
    That distinction is the whole contract: returning ([], 0) there would report a
    clean book when what actually happened is that nobody looked."""
    if not silences:
        return None, None
    if not events:
        return [], 0
    sil_starts = [a for a, _ in silences]
    out = []
    for c in events:                      # index, not unpack: events carry a meta dict
        s, e, txt = c[0], c[1], c[2]
        span = e - s
        if span < min_dur:
            continue
        # silence intervals overlapping [s, e) — start just left of s
        i = bisect.bisect_left(sil_starts, s)
        if i > 0: i -= 1
        quiet = 0.0
        while i < len(silences) and silences[i][0] < e:
            quiet += max(0.0, min(silences[i][1], e) - max(silences[i][0], s))
            i += 1
        speech = 1.0 - quiet / span
        if speech <= max_speech:
            out.append({"audioStart": round(s, 2), "audioEnd": round(e, 2),
                        "startTimestamp": ts(s), "durationSeconds": round(span, 1),
                        "speechFraction": round(speech, 3),
                        "text": (txt[:120] + "…") if len(txt) > 120 else txt})
    total = len(out)
    out.sort(key=lambda c: c["speechFraction"])
    return out[:cap], total


def snap_boundaries(starts, ends, silences, window, min_gap=0.05):
    """Pull each cue SEAM onto the middle of a nearby silence.

    CONTIGUOUS MODE ONLY since 2026-09-06 (`--contiguous-cues`). The default build
    has no seams to snap: each cue's two edges are placed independently inside the
    pause by build_events, which is strictly better — a shared seam has to be one
    compromise time for two cues, and the pause belongs to neither sentence.

    In contiguous mode cues share a boundary — cue i ends exactly where cue i+1 begins
    — so a "boundary" is ONE time shared by two cues, and it is precisely the seam
    a training-corpus cutter cuts on. Forced alignment puts it at the CTC frame
    where the model thinks the last phone ended, which routinely lands a couple
    hundred ms early (clipping the word's tail) or late (leaking the next word's
    onset). The narrator's actual pause is a silence, and its MIDDLE is the safest
    place to cut: maximum margin on both sides, so neither clip loses a phone or
    gains half a breath.

    Rules, all of them conservative:
      * only silences OVERLAPPING [B-window, B+window] are candidates — a snap can
        never move a boundary further than `window`, so it cannot create drift;
      * the target is the midpoint of the candidate CLIPPED to that window, so a
        long silence (a chapter gap) pulls the seam to the window edge, not to its
        own distant centre;
      * the nearest candidate wins;
      * monotonicity is enforced against the already-placed previous boundary and
        the following raw one, leaving `min_gap` so no cue can collapse to zero.

    Mutates nothing; returns (new_starts, new_ends, stats)."""
    n = len(starts)
    if n == 0 or not silences or window <= 0:
        return starts, ends, {"considered": 0, "snapped": 0, "movedSeconds": []}
    sil_starts = [a for a, _ in silences]
    ns, ne = list(starts), list(ends)
    moved = []
    considered = 0
    for i in range(n - 1):
        b = ne[i]
        # cues are only "seamed" when the next cue starts where this one ends;
        # a gap (whisper-fallback retraction, MAX_CUE_S cap) is left alone.
        if abs(starts[i + 1] - ends[i]) > 1e-6:
            continue
        considered += 1
        lo, hi = b - window, b + window
        # bound the move by the neighbours so ordering and non-empty cues survive
        lo = max(lo, ns[i] + min_gap)
        hi = min(hi, (ends[i + 1] if i + 1 < n else b) - min_gap)
        if hi <= lo:
            continue
        j = bisect.bisect_left(sil_starts, b)
        best = None
        for k in range(max(0, j - 2), min(len(silences), j + 2)):
            a, z = silences[k]
            oa, oz = max(a, lo), min(z, hi)
            if oz <= oa:
                continue
            mid = 0.5 * (oa + oz)
            d = abs(mid - b)
            if best is None or d < best[0]:
                best = (d, mid)
        if best is None or best[0] < 1e-3:
            continue
        ne[i] = best[1]
        ns[i + 1] = best[1]
        moved.append(round(best[1] - b, 3))
    return ns, ne, {"considered": considered, "snapped": len(moved), "movedSeconds": moved}


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
    # REPORT-ONLY hole threshold, decoupled from --hole-min-s (2026-09-03). The
    # two were one number, so the only way to see a 4-second sting or a credits
    # read in the coverage report was to lower the threshold that also fills holes
    # with ASR cues — i.e. to change the VTT in order to inspect it. They are
    # separate concerns: LISTING short unmatched audio is free, FILLING it is not.
    # DEFAULTS TO --hole-min-s (i.e. changes nothing unless you ask). It was
    # briefly defaulted to 3 s, which was wrong: find_holes does NOT measure
    # literal unmatched audio. Cues are contiguous, so it compares each cue's span
    # against est_end() — "how long a slow reading of this text would take" — and
    # reports the surplus. At 30 s that surplus is a real ad/credits detector; at
    # 3 s it fires on ordinary brisk narration (measured on shipped VTTs: blacksun
    # 1 -> 65 ranges, ds 1 -> 137), and summary.unmatchedAudioSeconds stops meaning
    # anything. Lower it deliberately, per run, knowing that is what it measures.
    # For genuinely unnarrated audio see `lowSpeechCues`, which uses the silence
    # map rather than a reading-speed guess.
    ap.add_argument("--report-hole-min-s", type=float, default=None)
    # Silence snapping. SEMANTICS CHANGED 2026-09-06: cues are no longer
    # contiguous, so this no longer moves a shared seam — it snaps each cue's START
    # and END independently into the narrator's real pause (end END_PAD_S into the
    # silence after the last word; start no earlier than the start of the silence
    # before the first word). The number is still a bound: an edge may not move
    # further than this from its word-derived position, so a coarse map can correct
    # a CTC frame but can never manufacture drift. 0 disables snapping (raw
    # word-edge times). Under --contiguous-cues it keeps its old seam meaning.
    ap.add_argument("--snap-silence-s", type=float, default=0.6)
    # Escape hatch for a consumer that needs a gapless timeline: cue N ends at cue
    # N+1's onset, the pre-2026-09-06 behaviour, with seam snapping. OFF by
    # default — that construction is the defect this run fixes (the whole
    # inter-sentence pause, and the next sentence's first syllable, lived inside
    # cue N, which is what a training-corpus cutter then cut).
    ap.add_argument("--contiguous-cues", action="store_true")
    # silencedetect parameters for the snap map. -45 dB / 0.25 s is the pause
    # between sentences in a mastered audiobook; d must stay well BELOW a typical
    # sentence pause or the map misses the very seams we are trying to land in.
    ap.add_argument("--snap-noise-db", type=float, default=-45.0)
    ap.add_argument("--snap-min-silence-s", type=float, default=0.25)
    # Where the silence map comes from - STATED BY THE CALLER, no default and no
    # `auto`. auto-editor halves the mid-word edge rate against ffmpeg
    # silencedetect (measured on the chapter-0 sample: it is a normalized loudness
    # envelope and reports the 0.10-0.25 s inter-sentence pauses silencedetect's
    # duration floor hides), so it is what a machine that has it should use; but a
    # run that silently dropped to silencedetect when the binary was missing would
    # ship the 2.4 % edge rate under the 1.0 % label. The bridge decides per
    # machine and says which (whisperx-align-bridge.ts: silenceSourceFor), and a
    # source that was demanded and then fails is a failed run, not the other
    # source.
    ap.add_argument("--silence-source", required=True,
                    choices=["ffmpeg", "auto-editor"],
                    help="which silence scanner places the cue edges; the caller states it")
    ap.add_argument("--auto-editor-bin", default="auto-editor")
    ap.add_argument("--ae-threshold", type=float, default=0.03,
                    help="auto-editor normalized loudness below this counts as silence")
    # 0.04 s, not autoeditor_silences.py's 0.10: a cue EDGE only needs somewhere
    # quiet to land, and the sub-0.10 s gaps are exactly the boundaries that were
    # being cut mid-word. Swept on the chapter-0 sample (mid-word edge rate):
    # 0.10 -> 1.69%, 0.067 -> 1.35%, 0.04 -> 1.01%; thr 0.02 -> 1.69%,
    # 0.03 -> 1.01%, 0.05 -> 1.35%.
    ap.add_argument("--ae-min-silence-s", type=float, default=0.04)
    # A PRE-COMPUTED map (autoeditor_silences.py's JSON, or a bare [[s, e], ...]).
    # Skips the scan entirely — the analysis of a 12 h book is worth caching.
    ap.add_argument("--silence-map", default="")
    # Cache of the ALIGN stage's per-sentence CTC output. With this plus
    # --rough-cache and --silence-map, a re-run skips transcribe AND alignment and
    # only recomputes cue timing - seconds instead of tens of minutes per book.
    ap.add_argument("--align-cache", default="")
    # DIAGNOSTIC ONLY: drop the rough-transcript rescue on a >1 s disagreement and
    # leave the CTC time in place. Measured to be much WORSE (85-92% of those cues
    # start mid-word, and their neighbours degrade too) - kept runnable only so that
    # result can be reproduced. Never use it for corpus output.
    ap.add_argument("--no-rescue", action="store_true")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "mps", "cuda"])
    args = ap.parse_args()
    if args.hole_min_s < 0:
        ap.error(f"--hole-min-s must be >= 0 (got {args.hole_min_s}); 0 = report every gap")
    if args.report_hole_min_s is None:
        args.report_hole_min_s = args.hole_min_s
    if args.report_hole_min_s < 0:
        ap.error(f"--report-hole-min-s must be >= 0 (got {args.report_hole_min_s})")
    if args.snap_silence_s < 0:
        ap.error(f"--snap-silence-s must be >= 0 (got {args.snap_silence_s}); 0 = no snapping")

    # auto: Apple-Silicon Macs get MPS — validated full-book (10539/10540 cues
    # identical to CPU, wired memory flat at ~5.3 GB, same wall time as 4 CPU
    # workers at a tenth of the memory budget). Everything else gets CPU. The
    # probe runs in a subprocess so the parent never pays the torch import.
    if args.device == "auto":
        # Favor a GPU when present — CUDA on any platform, else Apple MPS on Macs —
        # otherwise CPU. Probe in a subprocess so the parent never pays the torch import.
        args.device = "cpu"
        try:
            p = subprocess.run([sys.executable, "-c",
                                "import torch;"
                                "print('cuda' if torch.cuda.is_available() else "
                                "('mps' if (getattr(torch.backends,'mps',None) and torch.backends.mps.is_available()) else 'cpu'))"],
                               capture_output=True, text=True, timeout=60)
            d = p.stdout.strip()
            if d in ("cuda", "mps"):
                args.device = d
        except Exception:
            pass
        log(f"device auto-resolved to {args.device}")
    # propagate to spawn workers — the transcribe + align pools re-import this module
    os.environ["ALIGN_DEVICE"] = args.device

    sents = json.load(open(args.sentences, encoding="utf-8"))
    # The bridge may hand us objects carrying a `kind` ("heading" = a short,
    # unpunctuated block of its own: part/chapter numbers, chapter titles,
    # epigraph attributions). Kept so the VTT can tag those cues; a plain list of
    # strings still works and yields all-prose.
    if sents and isinstance(sents[0], dict):
        kinds = [s.get("kind", "prose") for s in sents]
        sents = [s.get("text", "") for s in sents]
    else:
        kinds = ["prose"] * len(sents)
    N = len(sents)
    workers = args.workers if args.workers > 0 else auto_workers()
    if args.device in ("mps", "cuda") and workers != 1:
        log(f"device={args.device}: forcing 1 worker (a single GPU worker owns the device)")
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
    silences = []      # (start, end) pauses for edge snapping — filled on a bg thread
    sil_src = []       # ...and which scanner produced them (for the log + the report)
    sil_error = []     # a scanner failure, re-raised once the thread is joined
    sil_t = None       # ...which the finally below must join before the wav is deleted
    silence_ok = True  # False = the map is absent or untrustworthy; consumers must skip
                       # it rather than read a list a stranded thread may still write to
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
        rough, first_idx, last_idx, interior_dropped, narr_rate, matched_direct = coarse_align(sents, W, failed_ranges)
        trimmed_head, trimmed_tail = first_idx, N - last_idx
        log(f"narrated sentences [{first_idx}:{last_idx}] (trim head={trimmed_head}, "
            f"tail={trimmed_tail}, interior dropped={interior_dropped})")
        progress(42)

        # align workers read the full-book wav — join the background decode now
        if xt.is_alive(): log("waiting on background wav extraction")
        xt.join()
        if xerr: raise xerr[0]

        # Silence map for boundary snapping. Started HERE — the wav exists and the
        # align pool is about to run for ~30 minutes — so the scan is free wall
        # clock, and it must finish before the wav is deleted in the finally below.
        if args.snap_silence_s > 0:
            def _bg_silences():
                try:
                    if args.silence_map:
                        silences.extend(load_silence_map(args.silence_map))
                        sil_src.append(f"file:{os.path.basename(args.silence_map)}")
                        return
                    if args.silence_source == "auto-editor":
                        # auto-editor reads the ORIGINAL master, not our 16 kHz wav:
                        # its timebase is anchored to the file's own duration, and a
                        # re-decode is exactly the timeline risk this run had to rule
                        # out. (Verified sample-exact both ways on this sample.)
                        iv = detect_silences_autoeditor(args.audio, args.ae_threshold,
                                                        args.ae_min_silence_s, DUR,
                                                        args.auto_editor_bin)
                        if not iv:
                            raise RuntimeError(
                                "auto-editor produced no silence map (see the lines above "
                                "for its own error). It was the stated silence source, so "
                                "this run cannot place cue edges; fix auto-editor or run "
                                "with --silence-source ffmpeg and know the edges are coarser.")
                        silences.extend(iv); sil_src.append("auto-editor"); return
                    silences.extend(detect_silences(wav, args.snap_noise_db, args.snap_min_silence_s))
                    sil_src.append("ffmpeg-silencedetect")
                except Exception as e:
                    # A failed scan is a FAILED RUN: the cue edges are the point of
                    # this script now, and edges placed with no silence map are the
                    # pre-2026-09-06 build under a new label. Recorded here; raised
                    # by the join below, once the thread has stopped.
                    sil_error.append(e)
                    log(f"silence detection failed ({e})")
            sil_t = threading.Thread(target=_bg_silences, daemon=True); sil_t.start()

        # chunk over the NARRATED sentences at gaps ~every chunk-s. rough=None
        # means "not narrated" (interior drop) — excluded from chunk text so the
        # CTC align isn't fed pages of words that have no audio.
        stage("align")
        narr = [i for i in range(first_idx, last_idx) if rough[i] is not None]
        chunks = []; capped = 0; capped_ranges = []; cur = 0; base = rough[narr[0]] if narr else 0.0
        for x in range(1, len(narr) + 1):
            if x == len(narr) or (rough[narr[x]] - base) >= args.chunk_s:
                idxs = narr[cur:x]
                a = max(0.0, rough[idxs[0]] - PAD_HEAD)
                b = min(DUR, (rough[narr[x]] + PAD_TAIL) if x < len(narr) else DUR)
                # safety net: wav2vec2 memory is quadratic in audio span, so no
                # coarse regression may ever produce a memory-bomb chunk
                if b - a > 2 * args.chunk_s:
                    capped_ranges.append((a, b))  # the ORIGINAL (pre-truncation) span
                    b = a + 2 * args.chunk_s; capped += 1
                chunks.append((len(chunks), idxs, a, b, [sents[i] for i in idxs]))
                if x < len(narr): cur = x; base = rough[narr[x]]
        if capped:
            # Name the audio time range(s) of the truncated chunk(s) so a human can
            # seek straight to the suspect stretch(es) — a span cap means the coarse
            # anchors put two adjacent sentences implausibly far apart in audio.
            ranges = ", ".join(f"[{ts(a)}–{ts(b)}]" for a, b in capped_ranges)
            log(f"WARNING: {capped} chunk(s) exceeded the {2 * args.chunk_s:.0f}s span cap "
                f"and were truncated — coarse alignment is likely off: {ranges}")
        log(f"{len(chunks)} chunks")

        align_fp = align_fingerprint(sents, args.rough_model, args.chunk_s, lang)
        cached = (load_align_cache(args.align_cache, align_fp, N)
                  if (args.align_cache and os.path.exists(args.align_cache)) else None)
        sent_start = list(rough)  # default to rough; refine with WhisperX
        # wav2vec2 span (last word end - first word start) per sentence, or None
        # when the aligner never confirmed the sentence. Held as a SPAN, not an
        # absolute end, on purpose: every later stage (whisper-authority revert,
        # the monotonic clamps, drift correction) moves a cue's START, and a span
        # rides along with it instead of being silently left behind.
        sent_span = [None] * N
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
        if cached is not None:
            sent_start, sent_span = list(cached[0]), list(cached[1])
            log(f"align cache hit: reusing CTC output for {sum(1 for v in sent_span if v is not None)} "
                f"sentence(s); skipping the align pool")
            completed = set(c[0] for c in chunks)
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
                        for si, (t, te) in out.items():
                            sent_start[si] = t
                            sent_span[si] = (te - t) if (te is not None and te > t) else None
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
        if args.align_cache and cached is None:
            write_align_cache(args.align_cache, align_fp, sent_start, sent_span)
    finally:
        # The silence scan reads the wav — it must finish before the file goes.
        # BOUNDED: this finally also runs on the error path, and an ffmpeg wedged
        # on a bad file would otherwise hang the script forever holding a failure
        # nobody ever sees. Snapping is an improvement pass; losing it is a
        # degraded run, not a broken one, so we give up on it and say so.
        if sil_t is not None and sil_t.is_alive():
            log("waiting on background silence detection")
            sil_t.join(timeout=SILENCE_SCAN_TIMEOUT_S)
        if sil_error:
            # The STATED scanner failed. Not swapped for the other one - the run
            # goes on with no map, every cue edge says so in its NOTE (matched /
            # startSource / endSource) and the report carries the error, so the
            # degraded edges are never mistaken for placed ones.
            silence_ok = False
            log(f"silence source {args.silence_source} FAILED ({sil_error[0]}); cue edges "
                "fall on word times this run - see the report's silenceError")
            if sil_t.is_alive():
                # DO NOT clear `silences` here. The abandoned thread is still alive
                # and will extend() that same list when its ffmpeg finally returns,
                # so clearing it only opens a race: a later consumer would read a
                # map that filled in behind it, half-written, from a scan of a wav
                # this function is about to delete. Gate on a flag the consumers
                # check; leave the list alone.
                silence_ok = False
                log(f"silence detection still running after {SILENCE_SCAN_TIMEOUT_S:.0f}s "
                    f"— abandoning it; boundary snapping and speech coverage are "
                    f"disabled for this run")
        if os.path.exists(wav):
            try: os.remove(wav)
            except OSError: pass
    if args.snap_silence_s > 0:
        log(f"silence map: {len(silences)} interval(s) from "
            f"{sil_src[0] if sil_src else 'nothing'}")

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

    # Whisper-authority pass. THE fix for dramatization drift: a sentence whose
    # own opening was found in the rough transcript (matched_direct) has a REAL
    # spoken start — rough[i] = the time of its first narrated word, good to
    # ~±0.5s. wav2vec2 forced alignment is finer WHEN it agrees, but it forces
    # the epub words onto whatever audio is in its chunk, so over music bridges /
    # SFX / paraphrase / recap montages it slides — and cannot recover at all
    # when the true audio fell outside the chunk the coarse anchor built. So for
    # directly-matched sentences we KEEP wav2vec2 only when it lands within
    # WV_TRUST_S of the transcript word time; past that it's drift and we revert
    # to whisper. Interpolated/paraphrase sentences (not matched_direct) keep
    # whatever the align stage gave them — whisper had no word to anchor them.
    WV_TRUST_S = 1.0
    reverted = 0; max_revert = 0.0
    reverted_idx = set()   # cues whose start now comes from the ROUGH clock
    kept_ctc = 0           # contradicted, but CTC lands in a real pause -> trusted
    suspect_idx = set()    # contradicted AND mid-speech -> not guessed, tagged
    sil_starts = [a for a, _ in silences] if silences else None
    for i in narr:
        if matched_direct[i] and rough[i] is not None:
            d = abs(sent_start[i] - rough[i])
            if d > WV_TRUST_S:
                max_revert = max(max_revert, d)
                # MEASURED 2026-09-06, and it is the opposite of what it looks like.
                # Substituting the rough word time here is a RESCUE, not a downgrade.
                # The cues that reach this branch are the broken ones - selected
                # precisely because CTC and the transcript disagree by over a second -
                # so "reverted cues have worse edges than others" is a selection
                # effect, not causation. Scored on the SAME alignment, keeping the CTC
                # time instead: 85-92% of those cues then START MID-WORD (vs 3-18%
                # after substitution), and the damage spreads, because a cue left at a
                # wildly wrong time also bounds where its NEIGHBOURS' edges may go
                # (appendix direct-cue mid-word 3.62% -> 4.95% with the rescue removed).
                # So: substitute, because it is the better of two bad times - and TAG
                # the cue, because even after the rescue these are 3-6x worse than a
                # clean one and a corpus cutter should drop them.
                if not args.no_rescue:
                    sent_start[i] = rough[i]; reverted += 1
                    reverted_idx.add(i)
                    suspect_idx.add(i)
                    if silences and silence_ok and onset_in_pause(rough[i], silences, sil_starts):
                        kept_ctc += 1     # the substituted time lands in a real pause
                    continue
                suspect_idx.add(i)
    if reverted or suspect_idx:
        log(f"whisper-authority: {reverted} cue(s) rescued onto the transcript word time "
            f"(wav2vec2 disagreed by > {WV_TRUST_S:.1f}s; worst {max_revert:.1f}s) - of those "
            f"{kept_ctc} land in a detected pause. All {len(suspect_idx)} are tagged "
            f"matched=suspect: rescued is still 3-6x worse than a clean cue.")

    prev = None
    for i in narr:
        if prev is not None and sent_start[i] < prev: sent_start[i] = prev
        prev = sent_start[i]

    # Drift self-check: verify the final cue times against the rough transcript
    # and correct multi-second local drift it can unambiguously confirm (the
    # forced aligner can't recover when the true audio fell outside its chunk).
    drift = drift_audit(sents, narr, sent_start, W, narr_rate,
                        silences=(silences if silence_ok else None), sil_starts=sil_starts)
    suspect_idx |= set(drift.get("suspect", ()))
    if drift["checked"]:
        log(f"drift check: {drift['checked']} cue(s) verified against the rough transcript; "
            f"|offset| median {drift['medianAbs']:.2f}s p95 {drift['p95Abs']:.2f}s max {drift['maxAbs']:.2f}s; "
            f"corrected {drift['fixed']} cue(s) off by > {drift['fixThreshold']:.1f}s"
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
    # Cue EDGES, not seams: each cue covers its own sentence's speech, with the
    # narrator's pause left BETWEEN cues. Dropped (non-narrated) sentences get no
    # cue at all. See build_events for the geometry and the defect it replaces.
    usable_sil = silences if (silence_ok and args.snap_silence_s > 0) else None
    events = build_events(sent_start, narr, sents, kinds, DUR,
                          sent_span=sent_span, silences=usable_sil,
                          snap_window=args.snap_silence_s,
                          contiguous=args.contiguous_cues)

    # Per-cue confidence. `matched` says whether the sentence's own opening was
    # found in audio truth (direct) or its time came from interpolating between
    # neighbours (interpolated) — a downstream cutter must be able to drop the
    # latter. `offsetSeconds` is drift_audit's PRE-fix measured disagreement with
    # the rough transcript for this cue (null = the audit could not confirm it).
    drift_offsets = drift.get("offsets", {})
    # WHICH CLOCK placed this cue. wav2vec2 = the CTC frame (fine, ~10 ms).
    # whisper-revert / drift-fix = the ROUGH transcript word time, good to only
    # ~+-0.5 s. Both substitutions exist to rescue multi-second drift, but they hand
    # the cue a COARSER clock, so anything measuring edge quality must be able to
    # separate them from cues wav2vec2 placed.
    drift_fixed = set(drift.get("fixedIndices", ()))
    edge_counts = {"startWord": 0, "startSilence": 0,
                   "endWord": 0, "endSilence": 0, "endNextOnset": 0}
    interpolated_cues = 0; suspect_cues = 0
    time_sources = {"wav2vec2": 0, "whisper-revert": 0, "drift-fix": 0}
    for ev in events:
        m = ev[4]; i = m["sentenceIndex"]
        m["matched"] = ("suspect" if i in suspect_idx
                        else "direct" if matched_direct[i] else "interpolated")
        m["timeSource"] = ("drift-fix" if i in drift_fixed
                           else "whisper-revert" if i in reverted_idx
                           else "wav2vec2")
        if m["matched"] == "interpolated": interpolated_cues += 1
        if m["matched"] == "suspect": suspect_cues += 1
        time_sources[m["timeSource"]] = time_sources.get(m["timeSource"], 0) + 1
        off = drift_offsets.get(i)
        m["offsetSeconds"] = round(off, 3) if off is not None else None
        edge_counts["startSilence" if m["startSource"] == "silence" else "startWord"] += 1
        edge_counts["endSilence" if m["endSource"] == "silence"
                    else ("endWord" if m["endSource"] == "word" else "endNextOnset")] += 1
    log(f"cue confidence: {interpolated_cues} interpolated, {suspect_cues} suspect "
        f"(both are cues a corpus cutter should drop)")
    log(f"cue clocks: wav2vec2={time_sources['wav2vec2']} "
        f"whisper-revert={time_sources['whisper-revert']} drift-fix={time_sources['drift-fix']}")
    log(f"cue edges: end word={edge_counts['endWord']} silence={edge_counts['endSilence']} "
        f"next-onset={edge_counts['endNextOnset']}; start word={edge_counts['startWord']} "
        f"silence={edge_counts['startSilence']}; {interpolated_cues} interpolated cue(s)")

    # Contiguous mode only: cues share a seam, so snap the seam. The default build
    # has already placed both edges independently and has nothing to snap here.
    snap_stats = {"considered": 0, "snapped": 0, "movedSeconds": []}
    if args.contiguous_cues and args.snap_silence_s > 0 and silence_ok and silences and events:
        _s = [c[0] for c in events]; _e = [c[1] for c in events]
        _ns, _ne, snap_stats = snap_boundaries(_s, _e, silences, args.snap_silence_s)
        for x in range(len(events)):
            events[x][0] = _ns[x]; events[x][1] = _ne[x]
        mv = sorted(abs(m) for m in snap_stats["movedSeconds"])
        log(f"boundary snap: {snap_stats['snapped']}/{snap_stats['considered']} seam(s) moved "
            f"onto a silence (window {args.snap_silence_s:g}s"
            + (f", |move| median {mv[len(mv)//2]:.3f}s max {mv[-1]:.3f}s" if mv else "") + ")")

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
    def find_holes(min_s):
        # NON-CONTIGUOUS (default): a cue now ends at its own last word, so the gap
        # to the next cue IS the literal unmatched audio — measured, not guessed.
        # The reading-speed estimate below is only needed in --contiguous-cues
        # mode, where cues have no gaps by construction and est_end() is the only
        # way to infer one. (est_end is still a floor in that mode: a cue whose
        # measured end is EARLIER than a slow reading would take is trusted.)
        h = []  # (lo, hi, index of preceding event or None)
        if not events:
            return [(0.0, DUR, None)]
        if events[0][0] > min_s: h.append((0.0, events[0][0], None))
        for x in range(len(events)):
            lo = min(events[x][1], est_end(x)) if args.contiguous_cues else events[x][1]
            hi = events[x + 1][0] if x + 1 < len(events) else DUR
            if hi - lo > min_s: h.append((lo, hi, x))
        return h
    holes = find_holes(HOLE_MIN_S)
    # The REPORT's list is computed separately (2026-09-03). Fusing the two meant
    # the only way to SEE a 5-second sting or an unlisted credits read was to lower
    # the threshold that also injects ASR cues into the VTT. Listing is free.
    # Identical to `holes` unless the caller asked for a different threshold.
    report_holes = holes if args.report_hole_min_s == HOLE_MIN_S else find_holes(args.report_hole_min_s)

    def hole_transcripts(hole_list):
        """Rough-transcript text for each hole: ONE cursored pass over rough_segs
        (holes are in timeline order), selecting segments whose START falls in
        [lo, hi - 0.5).

        That selection rule is the one the fallback loop below uses to decide which
        segments belong to a hole. It is NOT the whole of what the fallback does —
        the fallback additionally clips each segment to the hole and to MAX_CUE_S,
        because it is building cues, whereas this is only gathering text. An
        earlier version recomputed the report's text with a different, cursor-less
        filter, which silently changed what the `transcript` field meant; sharing
        the selection rule is what stops that recurring."""
        out = [None] * len(hole_list)
        if not rough_segs:
            return out
        si = 0
        for hx, (lo, hi, _ev) in enumerate(hole_list):
            texts = []
            while si < len(rough_segs) and rough_segs[si][0] < lo: si += 1
            sj = si
            while sj < len(rough_segs) and rough_segs[sj][0] < hi - 0.5:
                if rough_segs[sj][2]: texts.append(rough_segs[sj][2])
                sj += 1
            if texts: out[hx] = " ".join(texts)
        return out

    fallback = []
    if rough_segs:
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
                # the edge is no longer where the word/silence evidence put it
                events[ev_x][4]["endSource"] = "asr-hole"
        if fallback:
            log(f"whisper-fallback: {len(fallback)} cue(s) fill {len(holes)} unaligned hole(s)")

    # Tag each cue with whether it is a whisper ASR-fallback (audio with no
    # matching ebook text — publisher branding, forewords, ads) vs a book-truth
    # ebook cue. Fallback cues get a standard WebVTT `NOTE asr-fallback` comment
    # block emitted on its OWN block (blank-line separated) immediately before
    # EACH such cue, so a downstream parser can tell ASR text from book prose. Per
    # WebVTT spec a NOTE block between cues is a comment and is skipped by every
    # conformant parser (native <track>, ffmpeg's webvtt reader); the cue id,
    # timestamps, and payload text are byte-identical to a run without NOTEs.
    #
    # HEADING cues carry `NOTE heading` by the same mechanism (2026-09-03). The
    # paragraph-aware segmenter now gives an unpunctuated block of its own — "Part
    # I", "1", "William McKinley, Ohioan" — its own cue instead of gluing it onto
    # the following prose. A training-corpus cutter wants those DROPPED (a title
    # announcement is not narration of the sentence it precedes), and reading a tag
    # beats every consumer re-deriving "looks like a heading" from the text.
    #
    # PER-CUE CONFIDENCE (2026-09-06). Every book cue also carries its own
    # `NOTE align ...` block — matched=direct|interpolated, the drift audit's
    # measured offset, and where each EDGE came from (word / silence /
    # next-onset / asr-hole). A training-corpus cutter must be able to drop
    # interpolated cues and treat a next-onset end as untrusted, and the VTT is
    # the artifact it actually has. Same NOTE mechanism, same guarantee: cue ids,
    # timestamps and payload text are byte-identical to a run without NOTEs.
    def _align_note(m):
        off = m.get("offsetSeconds")
        return (f"NOTE align matched={m['matched']} time={m['timeSource']} "
                f"start={m['startSource']} end={m['endSource']} "
                f"offset={'none' if off is None else format(off, '+.3f')}")
    tagged = [(c[0], c[1], c[2], "heading" if c[3] == "heading" else None, _align_note(c[4]))
              for c in events] \
           + [(s, e, txt, "asr-fallback", None) for s, e, txt in fallback]
    lines = ["WEBVTT", ""]; n = 0; heading_cues = 0
    for s, e, txt, note, anote in sorted(tagged, key=lambda c: c[0]):
        n += 1
        if note:
            lines += [f"NOTE {note}", ""]
            if note == "heading": heading_cues += 1
        if anote:
            lines += [anote, ""]
        lines += [str(n), f"{ts(s)} --> {ts(e)}", txt, ""]
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
    low_speech, low_speech_total = speech_coverage(events, silences if silence_ok else [])
    if low_speech_total is None:
        log("speech coverage: NOT MEASURED (no silence map this run) — "
            "lowSpeechCues is null, which is not the same as zero")
    elif low_speech_total:
        log(f"speech coverage: {low_speech_total} cue(s) ≥3s are ≤30% speech "
            f"(dead air / stings / unread text) — see the report")
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
        report_hole_text = hole_transcripts(report_holes)
        hole_set = set(holes)   # O(1) "did this range also get ASR cues"
        audio_unmatched = []
        for hx, (lo, hi, ev_x) in enumerate(report_holes):
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
                "transcript": _clip(report_hole_text[hx], 2500) if report_hole_text[hx] else None,
                # true when this range ALSO got whisper-fallback cues in the VTT
                # (i.e. it cleared --hole-min-s, not just --report-hole-min-s)
                "filledWithAsrCues": (lo, hi, ev_x) in hole_set,
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
                # These two keep their original meaning: the --hole-min-s list, the
                # one that also drives whisper-fallback cues. They do NOT follow
                # --report-hole-min-s, because that threshold changes what the
                # measure IS (see find_holes) and a summary total computed at 3 s
                # is not comparable with one computed at 30 s.
                "unmatchedAudioRanges": len(holes),
                "unmatchedAudioSeconds": round(sum(hi - lo for lo, hi, _ in holes), 1),
                "holeThresholdSeconds": HOLE_MIN_S,
                # The threshold the audioNotInEpub LIST below uses. Equal to
                # holeThresholdSeconds unless the caller lowered it on purpose.
                "reportHoleThresholdSeconds": args.report_hole_min_s,
                "reportedRanges": len(report_holes),
                "headingCues": heading_cues,
                "contiguousCues": bool(args.contiguous_cues),
                "interpolatedCues": interpolated_cues,
                "suspectCues": suspect_cues,
                "cueEdgeSources": edge_counts,
                "cueTimeSources": time_sources,
                # null, NOT 0, when there was no silence map to measure against —
                # "nobody looked" and "looked and found nothing" are different facts.
                "lowSpeechCues": low_speech_total,
            },
            # PER-CUE CONFIDENCE, in VTT cue order for the book cues (ASR-fallback
            # cues are not listed — they are tagged NOTE asr-fallback and carry no
            # epub sentence). `matched` and `endSource` are the two fields a
            # training-corpus cutter needs: an interpolated cue was never confirmed
            # in audio, and a "next-onset" end is inferred, not measured.
            "cues": [{
                "sentenceIndex": c[4]["sentenceIndex"],
                "audioStart": round(c[0], 3),
                "audioEnd": round(c[1], 3),
                "matched": c[4]["matched"],
                "offsetSeconds": c[4]["offsetSeconds"],
                "startSource": c[4]["startSource"],
                "endSource": c[4]["endSource"],
                "timeSource": c[4]["timeSource"],
                "kind": c[3],
            } for c in events],
            # Cues whose audio is mostly silence — measured against the silence map,
            # not guessed from reading speed. This is the short-unnarrated-audio
            # signal that lowering --report-hole-min-s was reaching for.
            # `measured` says whether the question was asked at all; `cues` is null
            # rather than [] when it was not, so a consumer cannot read an unrun
            # scan as a clean book.
            "lowSpeechCues": {
                "measured": low_speech is not None,
                "count": low_speech_total,
                "cues": low_speech,
            },
            # Boundary snapping: how many cue seams the silence map was able to
            # place inside a pause, and how far each moved. `snapped/considered`
            # IS the measurement — a low ratio means the silence map is too coarse
            # for this master (raise --snap-noise-db or lower --snap-min-silence-s),
            # not that the alignment is bad.
            "boundarySnap": {
                "windowSeconds": args.snap_silence_s,
                "silenceSource": (sil_src[0] if sil_src else None),
                "silenceError": (str(sil_error[0]) if sil_error else None),
                "noiseDb": args.snap_noise_db,
                "minSilenceSeconds": args.snap_min_silence_s,
                "aeThreshold": args.ae_threshold,
                "aeMinSilenceSeconds": args.ae_min_silence_s,
                "silenceIntervals": len(silences) if silence_ok else 0,
                "seamsConsidered": snap_stats["considered"],
                "seamsSnapped": snap_stats["snapped"],
                "medianAbsMoveSeconds": round(sorted(abs(m) for m in snap_stats["movedSeconds"])[len(snap_stats["movedSeconds"]) // 2], 3) if snap_stats["movedSeconds"] else 0.0,
                "maxAbsMoveSeconds": round(max((abs(m) for m in snap_stats["movedSeconds"]), default=0.0), 3),
            },
            "epubNotInAudio": excluded,
            "audioNotInEpub": audio_unmatched,
            "driftSelfCheck": {
                "checkedCues": drift["checked"],
                "medianAbsSeconds": round(drift["medianAbs"], 2),
                "p95AbsSeconds": round(drift["p95Abs"], 2),
                "maxAbsSeconds": round(drift["maxAbs"], 2),
                # residual* = the SAME checked cues but with corrected cues counted
                # at their post-correction offset (~0). This reflects the FINAL VTT
                # quality; the plain median/p95/max above are pre-correction (kept
                # unchanged for tools that already parse them).
                "residualMedianAbsSeconds": round(drift["residualMedianAbs"], 2),
                "residualP95AbsSeconds": round(drift["residualP95Abs"], 2),
                "residualMaxAbsSeconds": round(drift["residualMaxAbs"], 2),
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
            f"{len(report_holes)} unmatched audio range(s) ≥{args.report_hole_min_s:g}s "
            f"({len(holes)} of them ASR-filled) -> {args.report}")

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
                                 "driftFixed": drift["fixed"],
                                 "snappedBoundaries": snap_stats["snapped"],
                                 "totalBoundaries": snap_stats["considered"],
                                 "contiguousCues": bool(args.contiguous_cues),
                                 "interpolatedCues": interpolated_cues,
                                 "suspectCues": suspect_cues,
                                 "cueEdgeSources": edge_counts,
                                 "cueTimeSources": time_sources,
                                 "headingCues": heading_cues}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        emit(f"ERROR {e}")
        sys.exit(1)
