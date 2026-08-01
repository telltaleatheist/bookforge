#!/usr/bin/env python3
"""
run-book.py — read every band of a book with Tesseract, one process per page.

bands.py has already decided where the lines are, so recognition never has to
do layout: every crop holds exactly one line and goes through --psm 7. The cost
of that is one tesseract invocation per LINE, and process start-up dominates a
crop that small - 4.0 s for a 44-line page in the metric-C sample, almost all of
it spent loading the language model 44 times.

So the crops of a page are handed to ONE tesseract as an image list (a text file
of image paths), which loads the model once and walks the list. The output is
read as TSV rather than plain text: its page_num column ties every word back to
the image it came from, which is a guarantee the plain-text form cannot give -
there the pages are separated by form feeds, and a blank line is indistinguishable
from a missing one. TSV also carries per-word confidence, which is passed through.

    python3 run-book.py <lab-dir> [--workers N] [--pages 1,2,10-20] [--out DIR]

<lab-dir> holds renders/page-<N>.png and bands/page-<N>.json; results go to
<lab-dir>/ocr-bands/page-<N>.json:

    {"page": N, "widthPx": W, "heightPx": H,
     "lines": [{"bbox": [x0,y0,x1,y1], "text": "...", "conf": 92.4, "psm": 7}]}

A crop that --psm 7 reads as nothing gets one more pass at --psm 13, which is
counted in the summary and recorded per line as psm 13; see RESCUE_PSM.

bbox is the band's TIGHT box in render pixels (the crop the recognizer saw is
that box plus bands.py's padding). There is exactly one entry per band, in band
order, and a band that read as nothing keeps its place with "" - a dropped line
is a silent loss, which is the whole failure mode this pipeline exists to end.

No fallbacks: a page whose tesseract run fails, or whose output does not account
for every crop, is reported by number and makes the run exit nonzero.
"""

import argparse
import io
import json
import multiprocessing as mp
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

from PIL import Image

PSM = "7"
# Second chance for a crop --psm 7 read as nothing. psm 7 still runs layout
# analysis inside the line; a crop a few pixels taller than the type - the
# ascenders of the line below just clipping the bottom edge - can make it decide
# there is no line there and return an EMPTY STRING, with no error and full exit
# status. That is the exact failure this pipeline exists to end, one level down.
# psm 13 skips the analysis and recognizes the raster as one line, and it read
# all 16 of the book's silently-empty body bands correctly. The retry only ever
# runs on a band that produced nothing (32 of 22600 here), it is counted in the
# summary, and every line records the psm that produced it.
RESCUE_PSM = "13"
DPI = "200"
LANG = "eng"


# ------------------------------------------------------------------ page input

def _read_retry(path):
    """~/Documents is an iCloud fileprovider container and a file that exists
    can still read back empty until it materialises. Three attempts, then it is
    a real error and gets reported by page number like everything else."""
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


def load_bands(lab, page):
    path = os.path.join(lab, "bands", "page-%d.json" % page)
    return json.loads(_read_retry(path).decode("utf-8"))


def load_render(lab, page):
    data = _read_retry(os.path.join(lab, "renders", "page-%d.png" % page))
    img = Image.open(io.BytesIO(data)).convert("L")
    img.load()
    return img


# ------------------------------------------------------------------- recognition

_TSV_HEAD = "level\tpage_num"


def run_tesseract_list(list_path, n_images, psm=PSM):
    """One tesseract over an image list; returns [(text, conf), ...], one per
    image, in list order. Raises if the output does not account for every image."""
    proc = subprocess.run(
        ["tesseract", list_path, "stdout", "--psm", psm, "--dpi", DPI,
         "-l", LANG, "tsv"],
        capture_output=True, text=True,
        env={**os.environ, "OMP_THREAD_LIMIT": "1"})
    if proc.returncode != 0:
        raise RuntimeError("tesseract exited %d: %s"
                           % (proc.returncode, (proc.stderr or "").strip()[-400:]))
    words = [[] for _ in range(n_images)]
    confs = [[] for _ in range(n_images)]
    seen = set()
    for row in proc.stdout.splitlines():
        if not row or row.startswith(_TSV_HEAD):
            continue
        f = row.split("\t")
        if len(f) < 12:
            continue
        try:
            level, page_num = int(f[0]), int(f[1])
        except ValueError:
            continue
        i = page_num - 1                      # tesseract counts images from 1
        if not 0 <= i < n_images:
            raise RuntimeError("tesseract reported image %d of %d"
                               % (page_num, n_images))
        if level == 1:
            seen.add(i)
            continue
        if level != 5:
            continue
        text = f[11].strip()
        if not text:
            continue
        words[i].append(text)
        try:
            confs[i].append(float(f[10]))
        except ValueError:
            pass
    if len(seen) != n_images:
        raise RuntimeError("tesseract accounted for %d of %d crops"
                           % (len(seen), n_images))
    out = []
    for i in range(n_images):
        conf = round(sum(confs[i]) / len(confs[i]), 2) if confs[i] else None
        out.append((" ".join(words[i]), conf))
    return out


def process_page(args):
    lab, page, out_dir = args
    t0 = time.perf_counter()
    try:
        bd = load_bands(lab, page)
        bands = bd.get("bands", [])
        res = {"page": page, "widthPx": bd["widthPx"], "heightPx": bd["heightPx"],
               "lines": []}
        rescued = 0
        if bands:
            img = load_render(lab, page)
            W, H = img.size
            tmp = tempfile.mkdtemp(prefix="ocrlab-p%d-" % page)
            try:
                paths = []
                for bi, b in enumerate(bands):
                    x0, y0, x1, y1 = [int(round(v)) for v in b["crop"]]
                    x0, y0 = max(0, x0), max(0, y0)
                    x1, y1 = min(W, x1), min(H, y1)
                    if x1 <= x0 or y1 <= y0:
                        raise ValueError("band %d has an empty crop %s"
                                         % (bi, b["crop"]))
                    p = os.path.join(tmp, "b%04d.png" % bi)
                    img.crop((x0, y0, x1, y1)).save(p)
                    paths.append(p)
                list_path = os.path.join(tmp, "list.txt")
                with open(list_path, "w") as fh:
                    fh.write("\n".join(paths) + "\n")
                texts = run_tesseract_list(list_path, len(paths))
                psms = [int(PSM)] * len(paths)
                blank = [i for i, (t, _c) in enumerate(texts) if not t]
                if blank:
                    retry_list = os.path.join(tmp, "retry.txt")
                    with open(retry_list, "w") as fh:
                        fh.write("\n".join(paths[i] for i in blank) + "\n")
                    again = run_tesseract_list(retry_list, len(blank),
                                               psm=RESCUE_PSM)
                    for i, (text, conf) in zip(blank, again):
                        if text:
                            texts[i] = (text, conf)
                            psms[i] = int(RESCUE_PSM)
                            rescued += 1
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            for b, (text, conf), psm in zip(bands, texts, psms):
                res["lines"].append({"bbox": b["tight"], "text": text,
                                     "conf": conf, "psm": psm})
        with open(os.path.join(out_dir, "page-%d.json" % page), "w") as fh:
            json.dump(res, fh)
        secs = time.perf_counter() - t0
        return {"page": page, "bands": len(bands), "seconds": secs,
                "rescued": rescued,
                "empty": sum(1 for l in res["lines"] if not l["text"])}
    except Exception as exc:                       # loud, named, never silent
        return {"page": page, "error": "%s: %s" % (type(exc).__name__, exc),
                "seconds": time.perf_counter() - t0}


# -------------------------------------------------------------------------- run

def parse_pages(spec):
    pages = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part[1:]:
            a, b = part.split("-", 1)
            pages += list(range(int(a), int(b) + 1))
        else:
            pages.append(int(part))
    return pages


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lab", nargs="?",
                    default=os.path.expanduser(
                        "/Volumes/Callisto/training/ocr-lab/deathstalker"))
    ap.add_argument("--out", default=None,
                    help="output dir (default <lab>/ocr-bands)")
    ap.add_argument("--pages", default=None, help="comma list or a-b ranges")
    ap.add_argument("--workers", type=int, default=min(12, os.cpu_count() or 1))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    out_dir = args.out or os.path.join(args.lab, "ocr-bands")
    os.makedirs(out_dir, exist_ok=True)
    if args.pages:
        pages = parse_pages(args.pages)
    else:
        pages = sorted(int(m.group(1)) for m in
                       (re.fullmatch(r"page-(\d+)\.json", n)
                        for n in os.listdir(os.path.join(args.lab, "bands")))
                       if m)
    if not pages:
        raise SystemExit("no pages to run")

    t0 = time.time()
    jobs = [(args.lab, p, out_dir) for p in pages]
    if args.workers > 1:
        with mp.Pool(args.workers) as pool:
            results = []
            for r in pool.imap_unordered(process_page, jobs, chunksize=1):
                results.append(r)
                if not args.quiet and len(results) % 25 == 0:
                    print("  %d/%d pages" % (len(results), len(pages)),
                          file=sys.stderr)
    else:
        results = [process_page(j) for j in jobs]
    wall = time.time() - t0

    results.sort(key=lambda r: r["page"])
    failed = [r for r in results if "error" in r]
    ok = [r for r in results if "error" not in r]
    secs = sorted(r["seconds"] for r in ok)
    summary = {
        "pages": len(ok),
        "workers": args.workers,
        "wallSeconds": round(wall, 1),
        "pagesPerMinute": round(60.0 * len(ok) / max(1e-9, wall), 1),
        "totalBands": sum(r["bands"] for r in ok),
        "emptyTextBands": sum(r["empty"] for r in ok),
        "rescuedByPsm%s" % RESCUE_PSM: sum(r["rescued"] for r in ok),
        "pagesRescued": [r["page"] for r in ok if r["rescued"]],
        "pagesWithEmptyText": [r["page"] for r in ok if r["empty"]],
        "secondsPerPage": {
            "n": len(secs),
            "mean": round(sum(secs) / max(1, len(secs)), 3),
            "median": round(statistics.median(secs), 3) if secs else None,
            "p95": round(secs[min(len(secs) - 1, int(0.95 * len(secs)))], 3)
                   if secs else None,
            "max": round(secs[-1], 3) if secs else None,
        },
        "failedPages": failed,
    }
    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    for r in failed:
        print("ERROR page %d: %s" % (r["page"], r["error"]), file=sys.stderr)
    print(json.dumps({k: v for k, v in summary.items()
                      if k != "pagesWithEmptyText"}, indent=1))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
