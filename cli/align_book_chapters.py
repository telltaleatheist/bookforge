#!/usr/bin/env python
"""
align_book_chapters.py — force-align a whole book, one chapter at a time, without
the app, and MEASURE the result.

    align_book_chapters.py <audio dir> <epub> <out dir> [options]

Per chapter audio file it runs the shipped pipeline end to end:

  split    the epub with the app's OWN splitter (cli/epub-chapter-sentences.js ->
           dist/electron/whisperx-align-bridge.splitSentences, behind
           cli/electron-stub.js). NOT a re-implementation: a second splitter in
           this file would drift from the one the app ships and every cue text
           would slowly stop being the book's.
  map      each audio file to its epub chapter(s) by matching the OLD per-chapter
           VTTs' cue text against each chapter's sentences (--old-vtt-dir). Titles
           are not reliable for this — "chapter 0 - introduction.wav" belongs to an
           epub chapter titled "Beginning" — but the prose is.
  align    electron/scripts/align_audiobook.py --device cpu --workers N
           --silence-source auto-editor --report
  measure  electron/scripts/measure_cue_edges.py against the chapter's own audio

then prints the five edge metrics per chapter and POOLED over the book (pooled
from raw counts, never by averaging per-chapter percentages — chapters here differ
in cue count by 25x).

RERUNNABLE. Every artifact lands in <out dir> and is reused when it is already
there: --rough-cache means a re-run skips the ~40%-of-wall-clock transcribe pass,
and --reuse-silences reuses the auto-editor map. Nothing outside <out dir> is
written, so the existing per-chapter VTTs are never touched.

Options:
  --workers N          align workers per chapter (default: physical cores, clamped
                       to available RAM at ~2 GB/worker — the align pool's own
                       pressure guard shrinks it further if it still gets tight)
  --dist DIR           built dist/ holding the compiled splitter (a git worktree
                       has no node_modules and must not be npm-installed, so point
                       this at the main checkout's dist)
  --old-vtt-dir DIR    per-chapter VTTs used ONLY to map audio -> epub chapter
                       (default: the audio dir; read-only)
  --reuse-silences     reuse <out>/<stem>.silences.json instead of re-running
                       auto-editor (a re-run convenience; the first run always
                       goes through --silence-source auto-editor)
  --only STEM[,STEM]   restrict to these audio stems
  --skip-existing      leave chapters that already have a VTT alone
  --measure-only       skip alignment, just re-measure what is in <out dir>
"""
import argparse, glob, json, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ALIGNER = os.path.join(REPO, "electron", "scripts", "align_audiobook.py")
MEASURE = os.path.join(REPO, "electron", "scripts", "measure_cue_edges.py")
SPLITTER = os.path.join(HERE, "epub-chapter-sentences.js")
STUB = os.path.join(HERE, "electron-stub.js")

_norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _safe(s):
    """Text that survives this console's encoding.

    Windows consoles default to cp1252, and a book's own chapter titles routinely
    are not encodable in it (curly quotes, an umlaut, a U+FFFD from a lossy source).
    Printing one killed a 7 h alignment run at the split step - the pipeline was
    fine, the PROGRESS REPORT crashed it. Never let logging be the thing that
    fails."""
    enc = (getattr(sys.stdout, "encoding", None) or "utf-8")
    return s.encode(enc, errors="replace").decode(enc, errors="replace")


def log(m): print(f"[book] {_safe(str(m))}", flush=True)


def die(m):
    print(f"[book] FATAL: {_safe(str(m))}", file=sys.stderr, flush=True)
    sys.exit(1)


def avail_ram_gb():
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
        return m.ullAvailPhys / (1024 ** 3)
    except Exception:
        try:
            return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / (1024 ** 3)
        except Exception:
            return 16.0


def physical_cores():
    """Physical, not logical: the align workers are compute-bound wav2vec2, and
    hyperthread siblings buy nothing while doubling the memory bill."""
    try:
        out = subprocess.run(["wmic", "cpu", "get", "NumberOfCores"],
                             capture_output=True, text=True).stdout
        n = [int(x) for x in re.findall(r"\d+", out)]
        if n: return sum(n)
    except Exception:
        pass
    try:
        import multiprocessing
        return max(1, (multiprocessing.cpu_count() or 4) // 2)
    except Exception:
        return 4


def default_workers():
    cores = physical_cores()
    # ~2 GB per align worker (align_audiobook.GB_PER_WORKER), plus ~5 GB left for
    # the OS and whatever else is running. The pool self-shrinks below its own
    # pressure floor, but arriving there costs a terminated pool and re-run chunks.
    by_ram = int((avail_ram_gb() - 5.0) // 2.0)
    return max(1, min(cores, by_ram)), cores, by_ram


def parse_vtt_texts(path):
    """Cue texts of a VTT, in order. NOTE blocks are skipped (they are comments)."""
    out = []
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    i = 0
    while i < len(lines):
        if "-->" in lines[i]:
            j, buf = i + 1, []
            while j < len(lines) and lines[j].strip():
                buf.append(lines[j].strip()); j += 1
            if buf: out.append(" ".join(buf))
            i = j
        else:
            i += 1
    return out


def map_audio_to_chapters(stems, chapters, old_vtt_dir):
    """audio stem -> [epub chapter indices], decided by TEXT.

    For each stem, score every epub chapter by how many of the old VTT's cue texts
    appear in it (normalized, exact). The winner takes the chapter. An unclaimed
    SHORT chapter immediately before a claimed one (the "PART ONE" divider pages)
    is folded into it: if the narrator did read it, it belongs there; if not, the
    aligner's head-trim drops it, which costs nothing.
    """
    sets = [set(_norm(s["text"]) for s in c["sentences"]) for c in chapters]
    claimed = {}
    report = []
    for stem in stems:
        vtt = os.path.join(old_vtt_dir, stem + ".vtt")
        if not os.path.exists(vtt):
            report.append((stem, None, 0.0, "no old VTT to map from"))
            continue
        texts = [_norm(t) for t in parse_vtt_texts(vtt)]
        texts = [t for t in texts if len(t) > 20]
        if not texts:
            report.append((stem, None, 0.0, "old VTT had no usable cue text"))
            continue
        probe = texts[:40] + texts[len(texts) // 2: len(texts) // 2 + 20] + texts[-20:]
        best, best_score = None, 0.0
        for ci, st in enumerate(sets):
            score = sum(1 for t in probe if t in st) / len(probe)
            if score > best_score: best, best_score = ci, score
        if best is None or best_score < 0.5:
            report.append((stem, None, best_score, "no epub chapter matched >=50% of its cues"))
            continue
        claimed[stem] = [best]
        report.append((stem, best, best_score, ""))
    # fold in short unclaimed dividers immediately before a claimed chapter
    taken = set(ci for v in claimed.values() for ci in v)
    for stem, idxs in claimed.items():
        first = idxs[0]
        p = first - 1
        if p >= 0 and p not in taken and len(chapters[p]["sentences"]) <= 5:
            idxs.insert(0, p); taken.add(p)
    return claimed, report


def write_silence_cache(audio, out_path):
    """Cache auto-editor's silence map for --reuse-silences.

    Imports the aligner's OWN scanner rather than re-deriving one here: the
    threshold, the 0.04 s floor and the 30 fps timebase guard are decisions that
    live in align_audiobook.py and must not fork."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("aa", ALIGNER)
    aa = importlib.util.module_from_spec(spec); spec.loader.exec_module(aa)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nk=1:nw=1", audio], capture_output=True, text=True)
    dur = float(probe.stdout.strip())
    iv = aa.detect_silences_autoeditor(audio, 0.03, 0.04, dur)
    if not iv:
        die(f"auto-editor produced no silence map for {audio}")
    json.dump({"source": "auto-editor", "duration": dur,
               "silences": [[round(x, 4), round(y, 4)] for x, y in iv]},
              open(out_path, "w"))
    log(f"  cached {len(iv)} silence interval(s) -> {os.path.basename(out_path)}")


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace", **kw)


def main():
    ap = argparse.ArgumentParser()
    # A DIRECTORY of per-chapter audio, or a SINGLE whole-book master file. The
    # second case is not a special pipeline, just a different unit of work: one
    # "chapter" whose text is the whole epub. The aligner already trims epub text
    # the narrator never reached at either end, which is what makes a master
    # covering only part of a book (a day-batch, a compact master) work here.
    ap.add_argument("audio_dir", metavar="AUDIO_DIR_OR_FILE")
    ap.add_argument("epub")
    ap.add_argument("out_dir")
    ap.add_argument("--python", default=sys.executable,
                    help="interpreter for align_audiobook.py (default: this one)")
    ap.add_argument("--node", default="node")
    ap.add_argument("--dist", default="")
    ap.add_argument("--old-vtt-dir", default="")
    ap.add_argument("--workers", type=int, default=0)
    # cpu | cuda | mps. On a GPU align_audiobook.py forces a single worker (one
    # process owns the device), so --workers stops meaning anything there and the
    # RAM clamp below is irrelevant — the bill moves to VRAM.
    ap.add_argument("--device", default="cpu", choices=["cpu", "cuda", "mps", "auto"])
    ap.add_argument("--lang", default="en")
    # The ROUGH transcript model. It never supplies a word of cue text - it only
    # anchors epub sentences to audio time in coarse_align - but a sentence it
    # fails to anchor falls back to token-weighted INTERPOLATION between its
    # neighbours, and an interpolated cue's two edges inherit that guess. So this
    # sets how much of the corpus a cutter that honours matched=interpolated has to
    # throw away.
    #
    # DEFAULT medium.en, but the case is MARGINAL - read this before believing it.
    # A single-chapter sweep (God's People ch.10) looked decisive: interpolation
    # 30.1% -> 10.8% and every edge metric better. It did NOT replicate. Book-wide,
    # medium.en made the pooled edge metrics WORSE, and a later controlled replay
    # (same alignment cache, same silence map, same rule, only the model differing)
    # on two chapters came out a wash:
    #
    #                 direct cues   mid-word (direct)
    #     base            523             1.91%
    #     medium.en       556             1.89%
    #
    # i.e. ~6% more usable cues at the same edge quality, for ~2.6x the transcribe
    # cost. That is the whole of the honest case for it, and it is why the value is
    # a default for CORPUS work (where a few percent more usable narration is worth
    # GPU minutes) rather than a recommendation. align_audiobook.py still defaults
    # to `base`; pass --rough-model base here on CPU, or whenever wall clock matters
    # more than corpus yield.
    ap.add_argument("--rough-model", default="medium.en",
                    help="rough anchor model (default medium.en, tuned for corpus work; "
                         "use base on CPU)")
    ap.add_argument("--ext", default=".wav")
    ap.add_argument("--only", default="")
    # Single-file mode: which epub chapters make up this master's text.
    # "" = all of them (let the aligner trim). Accepts "0,4,6-19".
    ap.add_argument("--chapters", default="")
    ap.add_argument("--skip-existing", action="store_true")
    ap.add_argument("--measure-only", action="store_true")
    ap.add_argument("--reuse-silences", action="store_true")
    a = ap.parse_args()

    for p in (ALIGNER, MEASURE, SPLITTER, STUB):
        if not os.path.exists(p): die(f"missing {p}")
    single = os.path.isfile(a.audio_dir)
    if not single and not os.path.isdir(a.audio_dir):
        die(f"no audio dir or file {a.audio_dir}")
    if not os.path.exists(a.epub): die(f"no epub {a.epub}")
    os.makedirs(a.out_dir, exist_ok=True)
    old_vtt_dir = a.old_vtt_dir or a.audio_dir

    if a.device in ("cuda", "mps"):
        # one GPU worker owns the device; anything else is a lie the aligner would
        # override anyway (and it logs the override)
        workers, cores, by_ram = (a.workers or 1), physical_cores(), None
    elif a.workers > 0:
        workers, cores, by_ram = a.workers, physical_cores(), None
    else:
        workers, cores, by_ram = default_workers()
    t_start = time.time()

    # ---- 1. split (the app's own splitter, once for the book)
    chapters_json = os.path.join(a.out_dir, "_chapters.json")
    if not os.path.exists(chapters_json):
        cmd = [a.node, "--require", STUB, SPLITTER, "--epub", a.epub, "--out", chapters_json]
        if a.dist: cmd += ["--dist", a.dist]
        log("splitting the epub with the app's splitter …")
        r = run(cmd)
        sys.stdout.write(_safe(r.stdout))
        if r.returncode != 0:
            die(f"splitter failed:\n{r.stderr[-2000:]}")
    book = json.load(open(chapters_json, encoding="utf-8"))
    if not book.get("joinedMatchesPerChapter"):
        die("per-chapter split differs from the app's whole-book split — the cue "
            "text would no longer be what the app produces; see the splitter's warning")
    chapters = book["chapters"]

    # ---- 2. which audio file is which chapter
    if single:
        stem = os.path.splitext(os.path.basename(a.audio_dir))[0]
        if a.chapters:
            want = set()
            for part in a.chapters.split(","):
                part = part.strip()
                if "-" in part:
                    lo, hi = part.split("-", 1); want |= set(range(int(lo), int(hi) + 1))
                elif part:
                    want.add(int(part))
            bad = sorted(i for i in want if i >= len(chapters))
            if bad: die(f"--chapters names {bad}, but the epub has {len(chapters)} chapters")
            idxs = sorted(want)
        else:
            idxs = list(range(len(chapters)))
        mapping = {stem: idxs}
        n = sum(len(chapters[i]["sentences"]) for i in idxs)
        log(f"single master {stem!r}: {len(idxs)} epub chapter(s), {n} sentences "
            f"(the aligner trims whatever this master does not reach)")
        stems = [stem]
        audio_of = {stem: a.audio_dir}
    else:
        stems = sorted(os.path.splitext(os.path.basename(p))[0]
                       for p in glob.glob(os.path.join(a.audio_dir, "*" + a.ext)))
        # a whole-book decode living beside the chapters is not a chapter
        stems = [s for s in stems if not re.fullmatch(r"(gp_)?all|.*_all", s)]
        if a.only:
            want = set(x.strip() for x in a.only.split(","))
            stems = [s for s in stems if s in want]
            if not stems: die(f"--only matched no audio stem in {a.audio_dir}")
        mapping, mreport = map_audio_to_chapters(stems, chapters, old_vtt_dir)
        audio_of = {s: os.path.join(a.audio_dir, s + a.ext) for s in stems}
        log(f"{len(stems)} audio file(s); mapped {len(mapping)} to epub chapters")
        for stem, ci, score, why in mreport:
            if ci is None:
                log(f"  SKIP {stem!r}: {why} (best score {score:.0%})")
            else:
                idxs = mapping[stem]
                titles = " + ".join(chapters[i]["title"] for i in idxs)
                n = sum(len(chapters[i]["sentences"]) for i in idxs)
                log(f"  {stem!r} -> [{','.join(map(str, idxs))}] {titles!r} "
                    f"({n} sentences, cue match {score:.0%})")
        unclaimed = [c["title"] for i, c in enumerate(chapters)
                     if i not in set(x for v in mapping.values() for x in v)]
        if unclaimed:
            log(f"  epub chapters with no audio: {', '.join(repr(t) for t in unclaimed)}")
        stems = [s for s in stems if s in mapping]
    if not stems: die("no audio file could be mapped to an epub chapter")

    log(f"rough model {a.rough_model!r}")
    log(f"workers={workers} (physical cores {cores}"
        + (f", RAM allows {by_ram}" if by_ram is not None else "") + f"), device={a.device}")

    # ---- 3. align + measure, chapter by chapter
    rows = []
    for k, stem in enumerate(stems, 1):
        audio = audio_of[stem]
        sents_p = os.path.join(a.out_dir, stem + ".sentences.json")
        vtt_p = os.path.join(a.out_dir, stem + ".vtt")
        rep_p = os.path.join(a.out_dir, stem + ".report.json")
        edg_p = os.path.join(a.out_dir, stem + ".edges.json")
        rough_p = os.path.join(a.out_dir, stem + ".roughcache.json")
        alignc_p = os.path.join(a.out_dir, stem + ".aligncache.json")
        sil_p = os.path.join(a.out_dir, stem + ".silences.json")

        sents = [s for i in mapping[stem] for s in chapters[i]["sentences"]]
        json.dump(sents, open(sents_p, "w", encoding="utf-8"), ensure_ascii=False)

        t0 = time.time()
        if a.measure_only or (a.skip_existing and os.path.exists(vtt_p)):
            log(f"[{k}/{len(stems)}] {stem}: using the VTT already in the out dir")
        else:
            cmd = [a.python, ALIGNER, "--audio", audio, "--sentences", sents_p,
                   "--out", vtt_p, "--report", rep_p, "--rough-cache", rough_p,
                   "--align-cache", alignc_p,
                   "--device", a.device, "--workers", str(workers), "--lang", a.lang,
                   "--rough-model", a.rough_model]
            if a.reuse_silences:
                if not os.path.exists(sil_p): write_silence_cache(audio, sil_p)
                cmd += ["--silence-map", sil_p]
            else:
                cmd += ["--silence-source", "auto-editor"]
            log(f"[{k}/{len(stems)}] {stem}: aligning {len(sents)} sentences …")
            r = run(cmd)
            res = None
            for line in r.stdout.splitlines():
                if line.startswith("RESULT "):
                    try: res = json.loads(line[7:])
                    except ValueError: pass
            if r.returncode != 0 or not res or not res.get("ok"):
                err = next((l for l in r.stdout.splitlines() if l.startswith("ERROR ")), "")
                log(f"  FAILED: {err or r.stderr.strip()[-600:]}")
                rows.append({"stem": stem, "error": err or "align failed"})
                continue
            for line in r.stderr.splitlines():
                if ("cue edges:" in line or "silence map:" in line or "drift check" in line
                        or "cue confidence:" in line or "cue clocks:" in line
                        or "whisper-authority:" in line):
                    log("  " + line.split("] ", 1)[-1])
        align_s = time.time() - t0

        m = run([a.python, MEASURE, "--audio", audio, "--vtt", vtt_p, "--json", edg_p])
        if m.returncode != 0 or not os.path.exists(edg_p):
            log(f"  measure FAILED: {m.stderr.strip()[-400:]}")
            rows.append({"stem": stem, "error": "measure failed"})
            continue
        e = json.load(open(edg_p, encoding="utf-8"))["new"]
        rep = json.load(open(rep_p, encoding="utf-8")) if os.path.exists(rep_p) else {}
        summ = rep.get("summary", {})
        rows.append({
            "stem": stem, "alignSeconds": round(align_s, 1),
            "audioSeconds": summ.get("audioDurationSeconds"),
            "cues": e["cues"], "counts": e["counts"],
            "interpolatedCues": summ.get("interpolatedCues"),
            "suspectCues": summ.get("suspectCues"),
            "cueTimeSources": summ.get("cueTimeSources"),
            "edgeSources": summ.get("cueEdgeSources"),
            "silenceSource": (rep.get("boundarySnap") or {}).get("silenceSource"),
            "trailingPausesS": e["trailingPausesS"], "leadInsS": e["leadInsS"],
            "midWordEdgePct": e["midWordEdgePct"], "endInSpeechPct": e["endInSpeechPct"],
            "endAtNextOnsetPct": e["endAtNextOnsetPct"],
            "startAtOwnOnsetPct": e["startAtOwnOnsetPct"],
            "medianTrailingPauseS": e["medianTrailingPauseS"],
            "totalCueSeconds": e["totalCueSeconds"],
        })
        r0 = rows[-1]
        log(f"  {e['cues']} cues, mid-word {e['midWordEdgePct']}%, "
            f"end-in-speech {e['endInSpeechPct']}%, end-at-next {e['endAtNextOnsetPct']}%, "
            f"start-no-lead {e['startAtOwnOnsetPct']}%, "
            f"interpolated {r0['interpolatedCues']}, suspect {r0['suspectCues']}, "
            f"{align_s / 60:.1f} min")

    # ---- 4. summary, pooled from counts
    ok = [r for r in rows if "error" not in r]
    tot = {k: sum(r["counts"][k] for r in ok) for k in
           ("cues", "edges", "midWordStart", "midWordEnd", "endInSpeech",
            "endAtNextOnset", "startAtOwnOnset")} if ok else {}
    all_tp = sorted(v for r in ok for v in r["trailingPausesS"])
    all_li = sorted(v for r in ok for v in r["leadInsS"])
    pooled = {
        "chapters": len(ok), "cues": tot.get("cues", 0),
        "midWordEdgePct": round(100.0 * (tot.get("midWordStart", 0) + tot.get("midWordEnd", 0))
                                / max(1, tot.get("edges", 1)), 2),
        "endInSpeechPct": round(100.0 * tot.get("endInSpeech", 0) / max(1, tot.get("cues", 1)), 2),
        "endAtNextOnsetPct": round(100.0 * tot.get("endAtNextOnset", 0) / max(1, tot.get("cues", 1)), 2),
        "startAtOwnOnsetPct": round(100.0 * tot.get("startAtOwnOnset", 0) / max(1, tot.get("cues", 1)), 2),
        "medianTrailingPauseS": round(all_tp[len(all_tp) // 2], 3) if all_tp else None,
        "medianLeadInS": round(all_li[len(all_li) // 2], 3) if all_li else None,
        "interpolatedCues": sum(r["interpolatedCues"] or 0 for r in ok),
        "suspectCues": sum(r["suspectCues"] or 0 for r in ok),
        # cues a corpus cutter should DROP: never confirmed in audio, or confirmed
        # and then contradicted with no quiet place to put the edge.
        "droppableCues": sum((r["interpolatedCues"] or 0) + (r["suspectCues"] or 0) for r in ok),
        "audioSeconds": round(sum(r["audioSeconds"] or 0 for r in ok), 1),
        "cueSeconds": round(sum(r["totalCueSeconds"] for r in ok), 1),
        "wallSeconds": round(time.time() - t_start, 1),
        "workers": workers, "device": a.device,
    }
    hdr = (f"{'chapter':34}{'cues':>6}{'mid-word%':>10}{'endSpch%':>9}"
           f"{'endNext%':>9}{'startNL%':>9}{'medTrail':>9}{'interp':>7}{'susp':>6}"
           f"{'align_min':>10}")
    print("\n" + hdr)
    print("-" * len(hdr))
    for r in rows:
        if "error" in r:
            print(f"{r['stem'][:33]:34}{'ERROR: ' + r['error'][:60]}")
            continue
        print(f"{r['stem'][:33]:34}{r['cues']:>6}{r['midWordEdgePct']:>10}"
              f"{r['endInSpeechPct']:>9}{r['endAtNextOnsetPct']:>9}{r['startAtOwnOnsetPct']:>9}"
              f"{r['medianTrailingPauseS']:>9}{r['interpolatedCues']:>7}"
              f"{(r['suspectCues'] if r['suspectCues'] is not None else 0):>6}"
              f"{r['alignSeconds'] / 60:>10.1f}")
    print("-" * len(hdr))
    print(f"{'POOLED (' + str(pooled['chapters']) + ' chapters)':34}{pooled['cues']:>6}"
          f"{pooled['midWordEdgePct']:>10}{pooled['endInSpeechPct']:>9}"
          f"{pooled['endAtNextOnsetPct']:>9}{pooled['startAtOwnOnsetPct']:>9}"
          f"{pooled['medianTrailingPauseS']:>9}{pooled['interpolatedCues']:>7}"
          f"{pooled['suspectCues']:>6}{pooled['wallSeconds'] / 60:>10.1f}")
    print(f"\ndroppable (interpolated + suspect): {pooled['droppableCues']} of "
          f"{pooled['cues']} cues ({100.0 * pooled['droppableCues'] / max(1, pooled['cues']):.1f}%)")
    print(f"audio {pooled['audioSeconds'] / 3600:.2f} h, cue span "
          f"{pooled['cueSeconds'] / 3600:.2f} h, wall {pooled['wallSeconds'] / 3600:.2f} h "
          f"({pooled['workers']} worker(s), {pooled['device']})")

    out = {"epub": os.path.abspath(a.epub), "audioDir": os.path.abspath(a.audio_dir),
           "outDir": os.path.abspath(a.out_dir), "pooled": pooled,
           "chapters": [{k: v for k, v in r.items()
                         if k not in ("trailingPausesS", "leadInsS")} for r in rows]}
    sp = os.path.join(a.out_dir, "_summary.json")
    json.dump(out, open(sp, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"wrote {sp}")
    return 0 if all("error" not in r for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
