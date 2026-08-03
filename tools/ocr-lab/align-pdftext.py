#!/usr/bin/env python3
"""
align-pdftext.py — pair our band OCR against a born-digital PDF's own text layer.

    python3 align-pdftext.py <lab-dir> [--out DIR] [--pages 1,2,10-20]

<lab-dir> holds ocr-bands/page-<N>.json (run-book.py) and reference/page-<N>.json
(extract_reference.py, --dpi 200). Results go to <lab-dir>/scores/
epub-align-pairs.json (the shared training-pair schema), pdftext-align.json and
pdftext-align-report.md.

Why this is not align-epub.py
-----------------------------
align-epub.py has to find WHERE in a book a line of OCR came from: an EPUB is one
long stream with no page geometry, so it anchors, takes an LIS, and resolves each
OCR line to an interval of truth words. All of that machinery exists because the
truth has no coordinates.

A born-digital PDF's embedded text HAS coordinates - the same ones the renderer
drew from - so the truth of a band is not searched for, it is READ OFF THE PAGE:
the reference line whose box the band's box overlaps. That removes the alignment
problem, and with it every way an aligner can lie (a lost lock reported as a
book-sized hole, a hyphen-join guess, a transposed footnote read as missing).
It also means the pairs are exact per PRINTED LINE - the reference is already
broken at the same line breaks our bands are, so no line ever has to be cut out
of a paragraph-shaped truth string.

What this measures, therefore, is the pipeline alone. On a born-digital render
there is no scan, no skew, no noise: every printed line is present, sharp, and
in its declared place. A truth line that no band overlaps is not a hard page - it
is a segmentation bug, and the report says so first.

Geometry
--------
Reference boxes are pixels at the extraction dpi; they are rescaled onto the OCR
page's pixel grid, then corrected for per-page origin drift with score.py's 1-D
ICP (`estimate_offset`). Even here that is not optional: a PDF may set a CropBox
per page, and matching raw geometry against a drifted origin fabricates phantom
misses (measured on the PDFelement references - ~2,300 of them).

Matching
--------
Reference lines and band lines on a page form a bipartite graph: an edge where
the boxes overlap by at least half the smaller box in BOTH axes. Its connected
components are the unit of accounting, and they are not all pairs:

  1 truth : 1 band     a pair.
  n truth : 1 band, all on one visual row (a running head beside a folio - the
                     reference splits those, the page does not)
                       a pair, truth joined left to right.
  n truth : 1 band, stacked
                       a MERGE: two printed lines in one band. Counted and
                       reported, never emitted - ocr corrects one line.
  1 truth : m bands    a SPLIT. Counted, not emitted.
  n : m                tangled. Counted, not emitted.
  1 truth : 0 bands    MISSING: nothing in the OCR claims this text. The fatal
                       class, and on this input a pure pipeline bug.
  0 truth : 1 band     an ORPHAN: we read something the PDF does not have there.

A band matched to truth that read as EMPTY text is not a pair either (an empty
input side would only teach the model to invent text); it is counted separately
as captured-but-unread, which is the same loss as MISSING one level down.

Nothing is ever forced: a component that is not a clean line pair yields no pair.
"""

import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
import time
from collections import defaultdict

import Levenshtein

TOOLS = os.path.dirname(os.path.abspath(__file__))

# The normalisation and the drift fit both have exactly one implementation in
# this lab, and it is not this file's. norm_text() decides what CER even means,
# so a second copy of it would make this tool's numbers incomparable with
# align-epub.py's the first time either changed.
sys.path.insert(0, TOOLS)
import score as _score                                    # noqa: E402


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_epub = _load("align_epub", "align-epub.py")
norm_text = _epub.norm_text

OVERLAP_FRAC = 0.5       # of the SMALLER box, in both axes, to call it an edge
PAIR_MIN_SIM = _epub.PAIR_MIN_SIM


# ------------------------------------------------------------------ page input

def read_retry(path):
    """~/Documents is an iCloud fileprovider container: a file that exists can
    still read back empty until it materialises. Three attempts, then it is a
    real error and gets reported by page number."""
    for _ in range(3):
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            if data:
                return data
        except OSError:
            pass
        time.sleep(0.4)
    raise IOError("unreadable after 3 attempts: %s" % path)


def page_numbers(d):
    return sorted(int(m.group(1)) for m in
                  (re.fullmatch(r"page-(\d+)\.json", n) for n in os.listdir(d))
                  if m)


def load_json(lab, sub, page):
    return json.loads(read_retry(os.path.join(lab, sub, "page-%d.json" % page))
                      .decode("utf-8"))


# ------------------------------------------------------------------- geometry

def overlap(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def edge(ref_box, ocr_box):
    rx0, ry0, rx1, ry1 = ref_box
    ox0, oy0, ox1, oy1 = ocr_box
    rh, oh = max(1e-6, ry1 - ry0), max(1e-6, oy1 - oy0)
    rw, ow = max(1e-6, rx1 - rx0), max(1e-6, ox1 - ox0)
    vo = overlap(ry0, ry1, oy0, oy1)
    ho = overlap(rx0, rx1, ox0, ox1)
    return (vo >= OVERLAP_FRAC * min(rh, oh)
            and ho >= OVERLAP_FRAC * min(rw, ow))


def same_row(a, b):
    """Two reference lines the page prints on ONE row (running head + folio).

    Vertically they sit on top of each other and horizontally they do not
    overlap - which is exactly score.py's rule, reused so "one printed line"
    means the same thing in the pair minting as in the coverage metric."""
    return _score.side_by_side({"bbox": a["bbox"]}, {"bbox": b["bbox"]})


class Union:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


# --------------------------------------------------------------------- pairing

def page_pairs(ref, ocr, first_line_id, align=True):
    """Match one page. Returns (pairs, stats, detail)."""
    rw, rh = float(ref["widthPx"]), float(ref["heightPx"])
    ow, oh = float(ocr["widthPx"]), float(ocr["heightPx"])
    sx, sy = ow / rw, oh / rh

    refs = []
    for i, ln in enumerate(ref.get("lines", [])):
        text = norm_text(ln.get("text", ""))
        if not text:
            continue                       # a run of spaces is not a line
        x0, y0, x1, y1 = ln["bbox"]
        refs.append({"i": i, "text": text,
                     "bbox": [x0 * sx, y0 * sy, x1 * sx, y1 * sy],
                     "edge": False,
                     "font": ln.get("font"), "size": ln.get("size")})

    bands = []
    for bi, ln in enumerate(ocr.get("lines", [])):
        bands.append({"id": first_line_id + bi, "band": bi,
                      "text": norm_text(ln.get("text", "")),
                      "bbox": [float(v) for v in ln["bbox"]],
                      "conf": ln.get("conf"), "psm": ln.get("psm")})

    # per-page origin drift, score.py's 1-D ICP over row centres
    ga, gb, votes, resid = _score.estimate_offset(
        refs, [{"tight": b["bbox"]} for b in bands])
    if align:
        _score.apply_offset(refs, ga, gb)

    nR, nB = len(refs), len(bands)
    adj_r = defaultdict(list)
    adj_b = defaultdict(list)
    for ri, r in enumerate(refs):
        for bi, b in enumerate(bands):
            if edge(r["bbox"], b["bbox"]):
                adj_r[ri].append(bi)
                adj_b[bi].append(ri)

    uf = Union(nR + nB)
    for ri, bis in adj_r.items():
        for bi in bis:
            uf.union(ri, nR + bi)
    comps = defaultdict(lambda: ([], []))
    for ri in range(nR):
        comps[uf.find(ri)][0].append(ri)
    for bi in range(nB):
        comps[uf.find(nR + bi)][1].append(bi)

    pairs = []
    st = defaultdict(int)
    detail = {"missing": [], "orphans": [], "merged": [], "split": [],
              "tangled": [], "unread": []}
    st["refLines"] = nR
    st["ocrLines"] = nB
    st["ocrLinesEmpty"] = sum(1 for b in bands if not b["text"])

    for key in sorted(comps):
        ris, bis = comps[key]
        ris.sort(key=lambda i: (refs[i]["bbox"][1], refs[i]["bbox"][0]))
        bis.sort()
        if ris and not bis:
            for ri in ris:
                st["missing"] += 1
                detail["missing"].append({
                    "page": ocr["page"], "text": refs[ri]["text"],
                    "bbox": [round(v, 1) for v in refs[ri]["bbox"]],
                    "font": refs[ri]["font"], "size": refs[ri]["size"]})
            continue
        if bis and not ris:
            for bi in bis:
                if not bands[bi]["text"]:
                    continue               # an empty band claims nothing
                st["orphans"] += 1
                detail["orphans"].append({
                    "page": ocr["page"], "text": bands[bi]["text"],
                    "bbox": [round(v, 1) for v in bands[bi]["bbox"]],
                    "conf": bands[bi]["conf"]})
            continue

        one_band = len(bis) == 1
        stacked = False
        for i in range(len(ris)):
            for j in range(i + 1, len(ris)):
                if not same_row(refs[ris[i]], refs[ris[j]]):
                    stacked = True
        if one_band and not stacked:
            # one printed line: 1:1, or the reference splitting one row in two
            truth = " ".join(refs[ri]["text"] for ri in
                             sorted(ris, key=lambda i: refs[i]["bbox"][0]))
            band = bands[bis[0]]
            if len(ris) > 1:
                st["sameRowJoined"] += 1
            if not band["text"]:
                st["unread"] += 1
                st["unreadTruthLines"] += len(ris)
                detail["unread"].append({
                    "page": ocr["page"], "truth": truth,
                    "bbox": [round(v, 1) for v in band["bbox"]],
                    "psm": band["psm"]})
                continue
            a, b = band["text"], truth
            sim = Levenshtein.ratio(a, b)
            cer = Levenshtein.distance(a, b) / max(1, len(b))
            cer_ci = Levenshtein.distance(a.lower(), b.lower()) / max(1, len(b))
            pairs.append({"line": band["id"], "page": ocr["page"],
                          "ocr": a, "truth": b,
                          "sim": round(sim, 4), "cer": round(cer, 4),
                          "cerCaseFolded": round(cer_ci, 4)})
            st["pairs"] += 1
            st["pairTruthLines"] += len(ris)
            continue

        rec = {"page": ocr["page"],
               "truth": [refs[ri]["text"] for ri in ris],
               "ocr": [bands[bi]["text"] for bi in bis]}
        if one_band:
            st["merged"] += 1
            st["mergedTruthLines"] += len(ris)
            detail["merged"].append(rec)
        elif len(ris) == 1:
            st["split"] += 1
            st["splitTruthLines"] += len(ris)
            detail["split"].append(rec)
        else:
            st["tangled"] += 1
            st["tangledTruthLines"] += len(ris)
            detail["tangled"].append(rec)

    st["refAlignA"] = ga
    st["refAlignB"] = gb
    st["refAlignVotes"] = votes
    st["refAlignResidual"] = resid
    return pairs, st, detail


# ---------------------------------------------------------------------- report

def dist(xs):
    if not xs:
        return {"n": 0}
    s = sorted(xs)
    return {"n": len(s), "mean": round(sum(s) / len(s), 5),
            "median": round(statistics.median(s), 5),
            "p95": round(s[min(len(s) - 1, int(0.95 * len(s)))], 5),
            "max": round(s[-1], 5)}


def write_report(path, r, pairs):
    L = []
    a = L.append
    a("# PDF-text alignment report\n")
    a("- lab: `%s`" % r["lab"])
    a("- reference: the PDF's own embedded text layer (born-digital = exact truth)")
    a("- elapsed: %.1f s\n" % r["elapsedSeconds"])
    a("## Sizes\n")
    a("| | |\n|---|---|")
    a("| pages scored | %d |" % r["pages"])
    a("| reference lines | %d |" % r["refLines"])
    a("| OCR band lines | %d |" % r["ocrLines"])
    a("| OCR bands that read as nothing | %d |" % r["ocrLinesEmpty"])
    a("")
    a("## Directional accounting\n")
    a("| | count | % of side |\n|---|---:|---:|")
    a("| truth lines covered by a pair | %d | %.3f%% |"
      % (r["pairTruthLines"],
         100.0 * r["pairTruthLines"] / max(1, r["refLines"])))
    a("| pairs emitted | %d | |" % r["pairs"])
    a("| pairs whose truth is a row the reference split (head + folio) | %d | |"
      % r["sameRowJoined"])
    a("| **truth lines MISSING (no band overlaps)** | **%d** | **%.4f%%** |"
      % (r["missing"], 100.0 * r["missing"] / max(1, r["refLines"])))
    a("| truth lines captured but read as empty | %d | %.4f%% |"
      % (r["unread"], 100.0 * r["unread"] / max(1, r["refLines"])))
    a("| truth lines inside a MERGED band | %d | %.4f%% |"
      % (r["mergedTruthLines"], 100.0 * r["mergedTruthLines"] / max(1, r["refLines"])))
    a("| truth lines inside a tangled cluster | %d | %.4f%% |"
      % (r["tangledTruthLines"], 100.0 * r["tangledTruthLines"] / max(1, r["refLines"])))
    a("| truth lines split across bands | %d | |" % r["split"])
    a("| **every reference line accounted for** | %d of %d | |"
      % (r["accountedTruthLines"], r["refLines"]))
    a("| OCR lines ORPHANED (no truth overlaps) | %d | %.4f%% |"
      % (r["orphans"], 100.0 * r["orphans"] / max(1, r["ocrLines"])))
    a("")
    a("## Pair quality\n")
    a("| | mean | median | p95 | max |\n|---|---:|---:|---:|---:|")
    for label, key in (("similarity", "similarity"), ("CER", "cer"),
                       ("CER case-folded", "cerCaseFolded")):
        d = r["matchedPairs"][key]
        if d.get("n"):
            a("| %s | %.5f | %.5f | %.5f | %.5f |"
              % (label, d["mean"], d["median"], d["p95"], d["max"]))
    a("")
    a("- pairs: %d" % r["matchedPairs"]["count"])
    a("- byte-exact (case-sensitive): %d (%.2f%%)"
      % (r["matchedPairs"]["exact"], r["matchedPairs"]["exactPct"]))
    a("- byte-exact case-folded: %d (%.2f%%)"
      % (r["matchedPairs"]["exactCaseFolded"], r["matchedPairs"]["exactCaseFoldedPct"]))
    a("- pairs at sim >= %.2f: %d\n" % (PAIR_MIN_SIM,
                                        r["matchedPairs"]["trainingPairsAtMinSim"]))
    if r["missing"]:
        a("## Missing truth lines (segmentation bugs on this input)\n")
        for m in r["missingDetail"][:60]:
            a("- p%d `%s` %s" % (m["page"], m["text"][:110], m["bbox"]))
        if r["missing"] > 60:
            a("- ... %d more" % (r["missing"] - 60))
        a("")
    if r["unread"]:
        a("## Captured but read as empty\n")
        for m in r["unreadDetail"][:40]:
            a("- p%d `%s`" % (m["page"], m["truth"][:110]))
        a("")
    if r["orphans"]:
        a("## Orphan OCR lines\n")
        for m in r["orphansDetail"][:40]:
            a("- p%d `%s`" % (m["page"], m["text"][:110]))
        if r["orphans"] > 40:
            a("- ... %d more" % (r["orphans"] - 40))
        a("")
    if r["merged"]:
        a("## Merged bands (two printed lines in one band)\n")
        for m in r["mergedDetail"][:40]:
            a("- p%d truth %s" % (m["page"], " || ".join(t[:60] for t in m["truth"])))
        if r["merged"] > 40:
            a("- ... %d more" % (r["merged"] - 40))
        a("")
    if r["worstPairs"]:
        a("## Worst pairs by CER\n")
        for p in r["worstPairs"]:
            a("- p%d cer %.3f\n  - truth: `%s`\n  - ocr:   `%s`"
              % (p["page"], p["cer"], p["truth"][:110], p["ocr"][:110]))
        a("")
    with open(path, "w") as fh:
        fh.write("\n".join(L))


# ------------------------------------------------------------------------- run

def parse_pages(spec):
    pages = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part[1:]:
            x, y = part.split("-", 1)
            pages += list(range(int(x), int(y) + 1))
        else:
            pages.append(int(part))
    return pages


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lab")
    ap.add_argument("--out", default=None, help="default <lab>/scores")
    ap.add_argument("--pages", default=None, help="comma list or a-b ranges")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-align", action="store_true",
                    help="do not correct the reference-to-render origin drift "
                         "(score.py's flag, for reproducing the raw numbers)")
    args = ap.parse_args(argv)

    lab = os.path.expanduser(args.lab)
    out_dir = args.out or os.path.join(lab, "scores")
    os.makedirs(out_dir, exist_ok=True)

    ocr_pages = page_numbers(os.path.join(lab, "ocr-bands"))
    ref_pages = set(page_numbers(os.path.join(lab, "reference")))
    # A reference page with no OCR is a whole page lost, but only when the run
    # covered the book: --pages is a subset by request, not a loss.
    ref_without_ocr = sorted(ref_pages - set(ocr_pages))
    if args.pages:
        want = set(parse_pages(args.pages))
        ocr_pages = [p for p in ocr_pages if p in want]
        ref_without_ocr = [p for p in ref_without_ocr if p in want]

    t0 = time.time()
    pairs, per_page = [], {}
    tot = defaultdict(int)
    detail = {"missing": [], "orphans": [], "merged": [], "split": [],
              "tangled": [], "unread": []}
    ocr_without_ref = []
    line_id = 0
    for p in ocr_pages:
        if p not in ref_pages:
            ocr_without_ref.append(p)
            continue
        ocr = load_json(lab, "ocr-bands", p)
        ref = load_json(lab, "reference", p)
        pp, st, det = page_pairs(ref, ocr, line_id, align=not args.no_align)
        line_id += len(ocr.get("lines", []))
        pairs += pp
        for k in ("refLines", "ocrLines", "ocrLinesEmpty", "pairs",
                  "pairTruthLines", "unreadTruthLines", "splitTruthLines",
                  "missing",
                  "orphans", "merged", "mergedTruthLines", "split", "tangled",
                  "tangledTruthLines", "unread", "sameRowJoined"):
            tot[k] += st.get(k, 0)
        for k in detail:
            detail[k] += det[k]
        per_page[str(p)] = {
            "refLines": st["refLines"], "ocrLines": st["ocrLines"],
            "pairs": st.get("pairs", 0), "missing": st.get("missing", 0),
            "orphans": st.get("orphans", 0), "merged": st.get("merged", 0),
            "split": st.get("split", 0), "tangled": st.get("tangled", 0),
            "unread": st.get("unread", 0),
            "refAlign": {"a": round(st["refAlignA"], 4),
                         "b": round(st["refAlignB"], 2),
                         "votes": st["refAlignVotes"]},
        }
        if not args.quiet and p % 100 == 0:
            print("  page %d" % p, file=sys.stderr)

    # reference pages with no OCR at all are a loss of a whole page, not a
    # rounding error - count their lines into missing so the headline cannot
    # hide them.
    ref_page_lines_lost = 0
    for p in ref_without_ocr:
        ref = load_json(lab, "reference", p)
        n = sum(1 for ln in ref.get("lines", []) if norm_text(ln.get("text", "")))
        ref_page_lines_lost += n

    # THE INVARIANT. Every reference line ends up in exactly one bucket, so the
    # buckets must add up to the reference. A line that fell out of the
    # accounting would be a silent loss of the very thing being measured, and
    # this lane exists to make silent losses impossible.
    accounted = (tot["pairTruthLines"] + tot["missing"] + tot["unreadTruthLines"]
                 + tot["mergedTruthLines"] + tot["splitTruthLines"]
                 + tot["tangledTruthLines"])
    if accounted != tot["refLines"]:
        raise SystemExit("accounting does not close: %d reference lines, %d "
                         "accounted for" % (tot["refLines"], accounted))

    # Emitted in OCR-stream order, like align-epub.py's: components are visited
    # in union-find order inside a page, which is not reading order.
    pairs.sort(key=lambda x: x["line"])

    sims = [p["sim"] for p in pairs]
    cers = [p["cer"] for p in pairs]
    cers_ci = [p["cerCaseFolded"] for p in pairs]
    exact = sum(1 for p in pairs if p["ocr"] == p["truth"])
    exact_ci = sum(1 for p in pairs if p["ocr"].lower() == p["truth"].lower())
    worst = sorted(pairs, key=lambda p: -p["cer"])[:25]

    result = {
        "tool": "align-pdftext.py",
        "lab": lab,
        "originDriftCorrected": not args.no_align,
        "pages": len(per_page),
        "refPagesWithNoOcr": ref_without_ocr,
        "refLinesOnPagesWithNoOcr": ref_page_lines_lost,
        "ocrPagesWithNoReference": ocr_without_ref,
        "refLines": tot["refLines"],
        "ocrLines": tot["ocrLines"],
        "ocrLinesEmpty": tot["ocrLinesEmpty"],
        "pairs": tot["pairs"],
        "pairTruthLines": tot["pairTruthLines"],
        "accountedTruthLines": accounted,
        "sameRowJoined": tot["sameRowJoined"],
        "missing": tot["missing"],
        "missingPct": round(100.0 * tot["missing"] / max(1, tot["refLines"]), 4),
        "unread": tot["unread"],
        "orphans": tot["orphans"],
        "orphansPct": round(100.0 * tot["orphans"] / max(1, tot["ocrLines"]), 4),
        "merged": tot["merged"],
        "mergedTruthLines": tot["mergedTruthLines"],
        "split": tot["split"],
        "tangled": tot["tangled"],
        "tangledTruthLines": tot["tangledTruthLines"],
        "matchedPairs": {
            "count": len(pairs),
            "similarity": dist(sims),
            "cer": dist(cers),
            "cerCaseFolded": dist(cers_ci),
            "exact": exact,
            "exactPct": round(100.0 * exact / max(1, len(pairs)), 3),
            "exactCaseFolded": exact_ci,
            "exactCaseFoldedPct": round(100.0 * exact_ci / max(1, len(pairs)), 3),
            "trainingPairsAtMinSim": sum(1 for s in sims if s >= PAIR_MIN_SIM),
            "trainingPairMinSim": PAIR_MIN_SIM,
        },
        "worstPairs": worst,
        "missingDetail": detail["missing"],
        "unreadDetail": detail["unread"],
        "orphansDetail": detail["orphans"],
        "mergedDetail": detail["merged"],
        "splitDetail": detail["split"],
        "tangledDetail": detail["tangled"],
        "perPage": per_page,
        "elapsedSeconds": round(time.time() - t0, 1),
    }

    with open(os.path.join(out_dir, "pdftext-align.json"), "w") as fh:
        json.dump(result, fh, indent=1, ensure_ascii=False)
    with open(os.path.join(out_dir, "epub-align-pairs.json"), "w") as fh:
        json.dump(pairs, fh, ensure_ascii=False)
    write_report(os.path.join(out_dir, "pdftext-align-report.md"), result, pairs)

    slim = {k: v for k, v in result.items()
            if not k.endswith("Detail") and k not in ("perPage", "worstPairs")}
    print(json.dumps(slim, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
