#!/usr/bin/env python
"""clip_sentences.py — accurate per-clip transcripts for Orpheus training.

The real worker behind ClipForge's `sentences` CLI verb.

DOCTRINE (Owen, verbatim): "we should always be using sentence generation to
get exact text for orpheus training." ASR alone gets proper nouns wrong; the
EPUB has the author's exact words. So this verb's output text is the EPUB's
words wherever alignment is CONFIDENT, and NOTHING (a flagged `uncertain`) where
it is not. Certainty over quantity: a clip we cannot place in the book gets no
text row — never a best-guess transcript. Ads / intros / outros legitimately
have no epub match; those are the expected `uncertain` case.

Two modes:

  MAP MODE (--book-vtt + --spans): the clip's position in the BOOK timeline is
    already known (a full-book sentence-VTT alignment exists). Text for a clip =
    the book-VTT cues contained in its span (cue-midpoint containment, EDGE_TOL
    default 0.35 s). A cue that straddles the clip boundary by more than EDGE_TOL
    => the clip is `uncertain` (partial-sentence audio must never pair with
    full-sentence text). Cues in `NOTE asr-fallback` regions are whisper
    hole-fill (ads/intros), NOT book truth — a clip overlapping one goes
    `uncertain`. This generalizes C:\\tmp\\ender_corpus_from_vtt.py (the main
    session's prototype).

  ANCHOR MODE (no --book-vtt): the clip's book position is UNKNOWN. CPU
    faster-whisper transcribes the clip — this ASR is only a LOCATOR, never the
    output text — then the ASR word sequence is fuzzy-anchored against the epub's
    full plain text (n-gram offset voting + difflib local sequence alignment).
    Output text = the EPUB's exact words for the matched span, expanded to
    sentence boundaries. If match similarity is below --similarity-threshold, or
    two distant book locations tie, or the sentence expansion overshoots the
    spoken audio, the clip goes `uncertain`.

epub extraction (epub_text/_Strip) and the smart-quote table are minimal ports
from C:\\Users\\tellt\\Projects\\orpheus-finetune\\correct_vtt.py and
align_excerpts.py (credited inline; NOT imported across repos, per task rule).

Progress protocol (stdout, one per line, for the JS bridge to parse):
  STAGE <name>
  PROGRESS <0-100>
  RESULT {"ok":true, ...}
  ERROR <message>

Usage:
  clip_sentences.py --mode map --clips <dir-or-list.txt> --epub <book.epub>
      --out <dir> --speaker <name> --book-vtt <vtt> --spans <json> [--edge-tol 0.35]
  clip_sentences.py --mode anchor --clips <dir-or-list.txt> --epub <book.epub>
      --out <dir> --speaker <name> [--model medium] [--device cpu]
      [--similarity-threshold 0.60] [--fidelity-threshold 0.85] [--ffmpeg <ffmpeg.exe>]
"""
import argparse
import bisect
import csv
import difflib
import html.parser
import json
import os
import re
import sys
import time
import zipfile
from collections import Counter
from datetime import datetime, timezone

SENTENCES_SCHEMA = "clipforge.sentences/1"

# ---- MEASURED defaults (see CLIPFORGE_PLAN.md "sentences verb" for evidence).
# Map mode:
EDGE_TOL_DEFAULT = 0.35        # s — cue-midpoint containment tolerance / straddle guard
# Anchor mode:
SIMILARITY_THRESHOLD_DEFAULT = 0.60   # anchor-window matched-ASR-words / ASR-words pre-gate
FIDELITY_THRESHOLD_DEFAULT = 0.85     # symmetric difflib ratio (final epub text vs ASR) — PRIMARY gate
NGRAM_K = 5                    # n-gram width for offset seeding
OFFSET_BUCKET = 50             # tokens — bucket width for offset voting
TIE_MIN_SEPARATION = 200       # tokens — two vote clusters this far apart with
TIE_VOTE_RATIO = 0.60          #   >= this vote ratio => ambiguous location
MIN_ASR_WORDS = 4              # fewer spoken words than this cannot be anchored


# ---- smart-quote table (port of align_excerpts._SMART) ---------------------
_SMART = str.maketrans({"⁠": "", "​": "", "“": '"', "”": '"',
                        "‘": "'", "’": "'", "—": " - ",
                        "–": "-", " ": " "})


def log_stage(name):
    print(f"STAGE {name}", flush=True)


def log_progress(pct):
    print(f"PROGRESS {int(pct)}", flush=True)


def die(msg):
    print(f"ERROR {msg}", flush=True)
    sys.exit(1)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# epub plain text + tokenization (port of correct_vtt.epub_text / _Strip)
# ---------------------------------------------------------------------------
class _Strip(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.buf = []
        self.skip = 0

    def handle_starttag(self, t, a):
        if t in ("script", "style"):
            self.skip += 1

    def handle_endtag(self, t):
        if t in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, d):
        if not self.skip:
            self.buf.append(d)


def epub_text(path):
    parts = []
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm"))]
        if not names:
            die(f"epub has no (x)html documents: {path}")
        for n in sorted(names):
            try:
                raw = z.read(n).decode("utf-8", "ignore")
            except Exception:  # noqa: BLE001
                continue
            p = _Strip()
            p.feed(raw)
            parts.append(" ".join(p.buf))
    text = " ".join(parts).translate(_SMART)
    return re.sub(r"\s+", " ", text).strip()


_TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


def tokenize(text):
    """Return (norms[], starts[], ends[]) — one entry per word token.

    norms[i] is the lowercase alnum form used for matching; starts/ends are char
    offsets into `text` so the ORIGINAL words (with their punctuation) can be
    sliced back out for output.
    """
    norms, starts, ends = [], [], []
    for m in _TOKEN_RE.finditer(text):
        norms.append(m.group(0).lower())
        starts.append(m.start())
        ends.append(m.end())
    return norms, starts, ends


def sentence_bounds(text):
    """Char offsets at which sentences START. A boundary is sentence-ending
    punctuation + optional closing quote/paren + whitespace, followed by an
    opening cap/quote. Coarse but sufficient to expand a matched span to whole
    sentences."""
    bounds = [0]
    for m in re.finditer(r'[.!?]["\')\]]*\s+(?=["\'(]?[A-Z0-9])', text):
        bounds.append(m.end())
    bounds.append(len(text))
    # de-dup + sort (len(text) may equal last real boundary)
    return sorted(set(bounds))


def build_epub_index(text):
    norms, starts, ends = tokenize(text)
    if len(norms) < NGRAM_K:
        die(f"epub plaintext too short to index ({len(norms)} tokens)")
    bounds = sentence_bounds(text)
    # token -> sentence id via its char start
    sent_id = [max(0, bisect.bisect_right(bounds, s) - 1) for s in starts]
    # n-gram (K normalized words) -> list of start token indices
    gram_index = {}
    for i in range(len(norms) - NGRAM_K + 1):
        key = " ".join(norms[i:i + NGRAM_K])
        gram_index.setdefault(key, []).append(i)
    return {
        "text": text, "norms": norms, "starts": starts, "ends": ends,
        "sent_id": sent_id, "bounds": bounds, "gram_index": gram_index,
    }


def expand_to_sentences(idx, t0, t1):
    """Given matched token span [t0, t1], return (etoks0, etoks1, out_text) where
    [etoks0, etoks1] is the span grown to whole-sentence boundaries and out_text
    is the exact epub substring for it (whitespace-collapsed)."""
    sent_id, norms = idx["sent_id"], idx["norms"]
    bounds, text = idx["bounds"], idx["text"]
    starts, ends = idx["starts"], idx["ends"]
    s_start = sent_id[t0]
    s_end = sent_id[t1]
    # first token whose sentence == s_start
    etoks0 = t0
    while etoks0 - 1 >= 0 and sent_id[etoks0 - 1] == s_start:
        etoks0 -= 1
    etoks1 = t1
    while etoks1 + 1 < len(norms) and sent_id[etoks1 + 1] == s_end:
        etoks1 += 1
    out = text[starts[etoks0]:ends[etoks1]]
    out = re.sub(r"\s+", " ", out).strip()
    return etoks0, etoks1, out


# ---------------------------------------------------------------------------
# VTT parsing (asr-fallback aware — format per cut_audiobook.parse_vtt)
# ---------------------------------------------------------------------------
def parse_book_vtt(path):
    """Return (cues, asr_regions). cues = [(start, end, text)] of BOOK-truth cues
    (smart-quotes normalized). asr_regions = [(start, end)] of cues tagged
    `NOTE asr-fallback` — whisper hole-fill, NOT book text. A `NOTE asr-fallback`
    line tags the NEXT cue (same convention as orpheus-finetune cut_audiobook)."""
    def ts(t):
        p = t.strip().split(":")
        return (int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])) if len(p) == 3 \
            else int(p[0]) * 60 + float(p[1])
    lines = open(path, encoding="utf-8").read().splitlines()
    cues, asr_regions = [], []
    pending_asr = False
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("NOTE asr-fallback"):
            pending_asr = True
            i += 1
            continue
        m = re.match(r"(\d[\d:.]+)\s*-->\s*(\d[\d:.]+)", lines[i])
        if m:
            st, en = ts(m.group(1)), ts(m.group(2))
            buf, j = [], i + 1
            while j < len(lines) and lines[j].strip():
                buf.append(lines[j].strip())
                j += 1
            if pending_asr:
                asr_regions.append((st, en))
                pending_asr = False
            else:
                cues.append((st, en, " ".join(buf).translate(_SMART)))
            i = j
        else:
            i += 1
    return cues, asr_regions


# ---------------------------------------------------------------------------
# spans json — accept a ClipForge speakers.json OR a plain {name:{offset,dur}}
# ---------------------------------------------------------------------------
def load_spans(path):
    """Return {clip_basename: (offset, duration)}. Detects shape by structure;
    dies on neither (NO silent guess)."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    spans = {}
    if isinstance(data, dict) and isinstance(data.get("clips"), list):
        # ClipForge speakers.json — per-clip source_offset/duration
        for c in data["clips"]:
            if not isinstance(c, dict) or "file" not in c:
                continue
            off, dur = c.get("source_offset"), c.get("duration")
            if off is None or dur is None:
                continue  # directory-mode speakers clip (no source timeline)
            spans[os.path.basename(c["file"])] = (float(off), float(dur))
        if not spans:
            die("speakers.json has no clips with source_offset/duration — this is "
                "a directory-mode speakers run (no book timeline); map mode needs "
                "single-file speakers output or a plain {name:{offset,duration}} spans json")
        return spans
    if isinstance(data, dict):
        # plain {name: {offset, duration}} object
        ok = 0
        for name, v in data.items():
            if isinstance(v, dict) and "offset" in v and "duration" in v:
                spans[os.path.basename(name)] = (float(v["offset"]), float(v["duration"]))
                ok += 1
        if ok:
            return spans
    die(f"--spans {path} is neither a ClipForge speakers.json (has clips[] with "
        f"source_offset/duration) nor a plain object of {{name:{{offset,duration}}}}")


# ---------------------------------------------------------------------------
# clip enumeration
# ---------------------------------------------------------------------------
def enumerate_clips(clips_arg):
    """Return ordered [(basename, abspath)]. Accepts a directory (its *.wav/*.flac)
    or a newline-delimited .txt list of clip paths."""
    ap = os.path.abspath(clips_arg)
    if os.path.isdir(ap):
        out = []
        for f in sorted(os.listdir(ap)):
            if f.lower().endswith((".wav", ".flac")):
                out.append((f, os.path.join(ap, f)))
        if not out:
            die(f"no .wav/.flac clips in directory: {ap}")
        return out
    if os.path.isfile(ap):
        if not ap.lower().endswith(".txt"):
            die(f"--clips must be a directory or a .txt list (got file: {ap})")
        with open(ap, "r", encoding="utf-8") as f:
            paths = [ln.strip() for ln in f if ln.strip()]
        if not paths:
            die(f"--clips list is empty: {ap}")
        out = []
        for p in paths:
            pp = os.path.abspath(p)
            if not os.path.exists(pp):
                die(f"--clips list entry not found: {p}")
            out.append((os.path.basename(pp), pp))
        return out
    die(f"--clips not found: {ap}")


# ---------------------------------------------------------------------------
# map mode
# ---------------------------------------------------------------------------
def run_map(args, clips):
    edge = float(args.edge_tol)
    log_stage("load-vtt")
    cues, asr_regions = parse_book_vtt(os.path.abspath(args.book_vtt))
    if not cues:
        die(f"no book-truth cues parsed from {args.book_vtt}")
    spans = load_spans(os.path.abspath(args.spans))
    print(f"[map] {len(cues)} book cues, {len(asr_regions)} asr-fallback regions, "
          f"{len(spans)} spans", flush=True)

    records, rows = [], []
    counts = Counter()
    for k, (name, path) in enumerate(clips):
        if name not in spans:
            counts["uncertain"] += 1
            records.append({"clip": name, "clip_path": path, "mode": "map",
                            "status": "uncertain", "reason": "no span for clip in --spans"})
            continue
        off, dur = spans[name]
        a, b = off, off + dur
        # asr-fallback overlap => whisper hole-fill, not book truth
        if any(a < he and b > hs for hs, he in asr_regions):
            counts["uncertain"] += 1
            records.append({"clip": name, "clip_path": path, "mode": "map",
                            "status": "uncertain", "reason": "overlaps asr-fallback region",
                            "span": {"offset": round(a, 3), "duration": round(dur, 3)}})
            continue
        inside = [c for c in cues if a - edge < (c[0] + c[1]) / 2 < b + edge]
        if not inside:
            counts["uncertain"] += 1
            records.append({"clip": name, "clip_path": path, "mode": "map",
                            "status": "uncertain", "reason": "no cues in span",
                            "span": {"offset": round(a, 3), "duration": round(dur, 3)}})
            continue
        if inside[0][0] < a - edge or inside[-1][1] > b + edge:
            counts["uncertain"] += 1
            records.append({"clip": name, "clip_path": path, "mode": "map",
                            "status": "uncertain",
                            "reason": (f"boundary cue straddles edge "
                                       f"(first {inside[0][0]:.2f} vs {a - edge:.2f}, "
                                       f"last {inside[-1][1]:.2f} vs {b + edge:.2f})"),
                            "span": {"offset": round(a, 3), "duration": round(dur, 3)}})
            continue
        text = re.sub(r"\s+", " ", " ".join(c[2] for c in inside)).strip()
        if len(text) < 3:
            counts["uncertain"] += 1
            records.append({"clip": name, "clip_path": path, "mode": "map",
                            "status": "uncertain", "reason": "cues joined to empty text",
                            "span": {"offset": round(a, 3), "duration": round(dur, 3)}})
            continue
        counts["ok"] += 1
        rows.append([path, text, args.speaker])
        records.append({"clip": name, "clip_path": path, "mode": "map",
                        "status": "ok", "text": text,
                        "span": {"offset": round(a, 3), "duration": round(dur, 3)},
                        "cue_count": len(inside),
                        "cue_span": [round(inside[0][0], 3), round(inside[-1][1], 3)]})
        if k % 25 == 0:
            log_progress(100 * k / max(len(clips), 1))
    return records, rows, counts, {"mode": "map", "edge_tol": edge,
                                   "book_cues": len(cues), "asr_regions": len(asr_regions)}


# ---------------------------------------------------------------------------
# anchor mode
# ---------------------------------------------------------------------------
def anchor_clip(idx, asr_norm, sim_thresh, fidelity_thresh):
    """Locate asr_norm in the epub. Returns a dict describing the placement:
      {status: ok, text, similarity, fidelity, matched_span:[t0,t1], ...}
      OR  {status: uncertain, reason, ...diagnostics}.

    Two independent gates:
      similarity  = matched-ASR-words / ASR-words in the ANCHOR WINDOW (before
                    expansion). A cheap pre-gate that rejects a clip whose ASR
                    barely matches near the anchor.
      fidelity    = difflib ratio between the FINAL expanded epub text and the
                    ASR (symmetric). This is the PRIMARY certainty gate: it
                    penalizes BOTH overshoot (expanded text contains sentences
                    the audio never spoke) AND under-coverage (the audio spoke
                    words the expanded text drops), which the one-sided coverage
                    metric could not see. Proper-noun corrections cost only a
                    word or two, so genuine clips stay high.
    """
    n = len(asr_norm)
    if n < MIN_ASR_WORDS:
        return {"status": "uncertain", "reason": f"too little speech ({n} words) to anchor"}
    k = min(NGRAM_K, n)
    gram_index = idx["gram_index"]
    norms = idx["norms"]

    # ---- n-gram offset voting: each shared k-gram implies an alignment start
    # (epub_pos - asr_pos). Bucket the implied starts and vote.
    votes = Counter()
    implied_starts = []
    if k == NGRAM_K:
        for j in range(n - k + 1):
            key = " ".join(asr_norm[j:j + k])
            for pos in gram_index.get(key, ()):  # epub token index of this gram
                start = pos - j
                implied_starts.append(start)
                votes[start // OFFSET_BUCKET] += 1
    else:
        # ASR shorter than K — scan the whole book for the k-gram directly
        target = asr_norm[:k]
        for p in range(len(norms) - k + 1):
            if norms[p:p + k] == target:
                start = p
                implied_starts.append(start)
                votes[start // OFFSET_BUCKET] += 1

    if not votes:
        return {"status": "uncertain", "reason": "no epub anchor (no shared n-gram) - "
                                                 "likely not book content (ad/intro/outro)"}
    ranked = votes.most_common()
    best_bucket, best_votes = ranked[0]
    # ---- tie / ambiguity: a distant second cluster with comparable votes
    for bucket, v in ranked[1:]:
        if abs(bucket - best_bucket) * OFFSET_BUCKET >= TIE_MIN_SEPARATION and \
                v >= TIE_VOTE_RATIO * best_votes:
            return {"status": "uncertain",
                    "reason": (f"ambiguous location: {best_votes} votes near token "
                               f"{best_bucket * OFFSET_BUCKET} tie with {v} votes near "
                               f"{bucket * OFFSET_BUCKET}")}

    # refined anchor = median implied start among the winning bucket's votes
    in_bucket = sorted(s for s in implied_starts if s // OFFSET_BUCKET == best_bucket)
    anchor = in_bucket[len(in_bucket) // 2]

    # ---- local sequence alignment in a window around the anchor
    margin = max(20, n // 2)
    w0 = max(0, anchor - margin)
    w1 = min(len(norms), anchor + n + margin)
    window = norms[w0:w1]
    sm = difflib.SequenceMatcher(None, window, asr_norm, autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size > 0]
    if not blocks:
        return {"status": "uncertain", "reason": "no aligned block in anchor window"}
    matched = sum(b.size for b in blocks)
    similarity = matched / n
    first_epub = w0 + blocks[0].a
    last_epub = w0 + blocks[-1].a + blocks[-1].size - 1

    result = {"similarity": round(similarity, 4), "matched_word_count": matched,
              "asr_word_count": n, "matched_span": [first_epub, last_epub]}
    if similarity < sim_thresh:
        result.update({"status": "uncertain",
                       "reason": f"low similarity {similarity:.3f} < {sim_thresh}"})
        return result

    # ---- expand matched span to whole sentences -----------------------------
    etoks0, etoks1, text = expand_to_sentences(idx, first_epub, last_epub)
    expanded = etoks1 - etoks0 + 1
    coverage = matched / expanded if expanded else 0.0
    # ---- PRIMARY gate: symmetric fidelity of the FINAL text vs the spoken ASR.
    # Catches the failure modes the anchor-window similarity is blind to: a clip
    # cut mid-sentence whose expansion pulls in a whole neighbouring sentence
    # (overshoot), or a clip whose expansion drops audio the reader spoke
    # (under-coverage). On the MM 40-clip set this cleanly separated the 5
    # misaligned clips (fidelity <= 0.803) from every clean clip (>= 0.863),
    # proper-noun corrections included. See CLIPFORGE_PLAN.md for the evidence.
    out_norm = [w for w in re.split(r"\s+", re.sub(r"[^a-z0-9' ]", " ", text.lower())) if w]
    fidelity = difflib.SequenceMatcher(None, out_norm, asr_norm, autojunk=False).ratio()
    result.update({"expanded_tokens": expanded, "matched_tokens": matched,
                   "coverage": round(coverage, 4), "fidelity": round(fidelity, 4)})
    if fidelity < fidelity_thresh:
        result.update({"status": "uncertain",
                       "reason": (f"epub text diverges from spoken audio "
                                  f"(fidelity {fidelity:.3f} < {fidelity_thresh}); clip is "
                                  f"likely cut mid-sentence or the span edges misaligned")})
        return result
    result.update({"status": "ok", "text": text})
    return result


def run_anchor(args, clips):
    sim_thresh = float(args.similarity_threshold)
    fidelity_thresh = float(args.fidelity_threshold)
    log_stage("load-epub")
    text = epub_text(os.path.abspath(args.epub))
    idx = build_epub_index(text)
    print(f"[anchor] epub: {len(idx['norms'])} tokens, {len(idx['bounds']) - 1} sentences",
          flush=True)

    log_stage("load-whisper")
    try:
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except Exception as e:  # noqa: BLE001
        die(f"faster_whisper not importable in this python env: {e}\n"
            "  anchor mode needs the e2a runtime env "
            "(%APPDATA%\\BookForge\\runtime\\e2a-env\\python.exe) or pass --python "
            "at a env with faster_whisper installed.")
    ct = "int8" if args.device == "cpu" else "float16"
    t_load0 = time.time()
    model = WhisperModel(args.model, device=args.device, compute_type=ct)
    model_load_s = time.time() - t_load0
    print(f"[anchor] whisper {args.model}/{ct} loaded on {args.device} in {model_load_s:.1f}s",
          flush=True)

    SR = 16000
    records, rows = [], []
    counts = Counter()
    transcribe_times = []
    for k, (name, path) in enumerate(clips):
        t_tr0 = time.time()
        wav = decode_audio(path, sampling_rate=SR)
        segs, _ = model.transcribe(wav, language="en", beam_size=5)
        segs = list(segs)
        tr_s = time.time() - t_tr0
        transcribe_times.append(tr_s)
        asr_text = " ".join(s.text for s in segs).strip()
        asr_norm = [w for w in re.split(r"\s+", re.sub(r"[^a-z0-9'\s]", " ",
                    asr_text.lower())) if w]
        placed = anchor_clip(idx, asr_norm, sim_thresh, fidelity_thresh)
        rec = {"clip": name, "clip_path": path, "mode": "anchor",
               "asr_text": asr_text, "transcribe_seconds": round(tr_s, 2),
               "clip_seconds": round(len(wav) / SR, 2)}
        rec.update(placed)
        records.append(rec)
        if placed["status"] == "ok":
            counts["ok"] += 1
            rows.append([path, placed["text"], args.speaker])
        else:
            counts["uncertain"] += 1
        log_progress(100 * (k + 1) / max(len(clips), 1))
        print(f"  [{k + 1}/{len(clips)}] {name}  {placed['status']}"
              f"{'' if placed['status'] == 'ok' else ' (' + placed['reason'][:48] + ')'}"
              f"  {tr_s:.1f}s", flush=True)

    warm = transcribe_times[1:] if len(transcribe_times) > 1 else transcribe_times
    bench = {
        "model": args.model, "device": args.device, "compute_type": ct,
        "model_load_seconds": round(model_load_s, 2),
        "clips": len(clips),
        "transcribe_total_seconds": round(sum(transcribe_times), 2),
        "transcribe_mean_seconds": round(sum(transcribe_times) / len(transcribe_times), 2)
        if transcribe_times else 0.0,
        "transcribe_median_seconds": round(sorted(transcribe_times)[len(transcribe_times) // 2], 2)
        if transcribe_times else 0.0,
        "transcribe_warm_mean_seconds": round(sum(warm) / len(warm), 2) if warm else 0.0,
        "cold_first_clip_incl_load_seconds": round(model_load_s + transcribe_times[0], 2)
        if transcribe_times else round(model_load_s, 2),
    }
    return records, rows, counts, {"mode": "anchor",
                                   "similarity_threshold": sim_thresh,
                                   "fidelity_threshold": fidelity_thresh,
                                   "epub_tokens": len(idx["norms"]),
                                   "benchmark": bench}


# ---------------------------------------------------------------------------
def write_outputs(out_dir, records, rows, counts, meta, args):
    os.makedirs(out_dir, exist_ok=True)
    csv_path = os.path.join(out_dir, "metadata.csv")
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter="|")
        w.writerow(["audio_file", "text", "speaker_name"])
        w.writerows(rows)

    reason_counts = Counter(r["reason"] for r in records if r["status"] == "uncertain")
    report = {
        "schema": SENTENCES_SCHEMA,
        "created_by": {
            "tool": "clipforge-process sentences",
            "ranAt": now_iso(),
            "mode": meta["mode"],
            "epub": os.path.abspath(args.epub),
            "clips": os.path.abspath(args.clips),
            "speaker": args.speaker,
        },
        "meta": meta,
        "summary": {
            "total": len(records),
            "ok": counts.get("ok", 0),
            "uncertain": counts.get("uncertain", 0),
            "match_rate": round(counts.get("ok", 0) / max(len(records), 1), 4),
            "uncertain_reasons": dict(reason_counts),
        },
        "clips": records,
    }
    report_path = os.path.join(out_dir, "sentences.report.json")
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)

    log_progress(100)
    print("", flush=True)
    print(f"Sentences — mode={meta['mode']}  ok={counts.get('ok', 0)}  "
          f"uncertain={counts.get('uncertain', 0)}  of {len(records)} clips", flush=True)
    print(f"  metadata: {csv_path}", flush=True)
    print(f"  report:   {report_path}", flush=True)
    print("", flush=True)
    result = {
        "ok": True,
        "mode": meta["mode"],
        "metadataPath": csv_path,
        "reportPath": report_path,
        "total": len(records),
        "okCount": counts.get("ok", 0),
        "uncertainCount": counts.get("uncertain", 0),
        "matchRate": round(counts.get("ok", 0) / max(len(records), 1), 4),
    }
    if "benchmark" in meta:
        result["benchmark"] = meta["benchmark"]
    print("RESULT " + json.dumps(result), flush=True)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", required=True, choices=["map", "anchor"])
    ap.add_argument("--clips", required=True)
    ap.add_argument("--epub", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speaker", required=True)
    # map mode
    ap.add_argument("--book-vtt", dest="book_vtt")
    ap.add_argument("--spans")
    ap.add_argument("--edge-tol", dest="edge_tol", type=float, default=EDGE_TOL_DEFAULT)
    # anchor mode
    ap.add_argument("--model", default="medium")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--similarity-threshold", dest="similarity_threshold",
                    type=float, default=SIMILARITY_THRESHOLD_DEFAULT)
    ap.add_argument("--fidelity-threshold", dest="fidelity_threshold",
                    type=float, default=FIDELITY_THRESHOLD_DEFAULT)
    ap.add_argument("--ffmpeg")  # accepted for symmetry; decode_audio uses PyAV
    return ap.parse_args()


def main():
    args = parse_args()
    if not os.path.exists(args.epub):
        die(f"--epub not found: {args.epub}")
    clips = enumerate_clips(args.clips)
    print(f"[sentences] mode={args.mode}  {len(clips)} clips  speaker={args.speaker}", flush=True)

    if args.mode == "map":
        if not args.book_vtt or not args.spans:
            die("map mode requires --book-vtt <vtt> and --spans <json>")
        if not os.path.exists(args.book_vtt):
            die(f"--book-vtt not found: {args.book_vtt}")
        if not os.path.exists(args.spans):
            die(f"--spans not found: {args.spans}")
        records, rows, counts, meta = run_map(args, clips)
    else:
        records, rows, counts, meta = run_anchor(args, clips)

    write_outputs(os.path.abspath(args.out), records, rows, counts, meta, args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — protocol demands a loud ERROR line
        die(str(e))
