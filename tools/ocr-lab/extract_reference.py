#!/usr/bin/env python3
"""
extract_reference.py — dump a searchable PDF's embedded text layer as per-page JSON.

WHY THIS EXISTS
---------------
When a scanned book has been OCR'd by a good commercial engine (Wondershare
PDFelement, ABBYY, Acrobat), the resulting text layer is the best reference we
have for measuring OUR OCR pipeline. This tool freezes that layer into a stable,
geometry-carrying JSON form so it can be diffed against our own output.

`mutool draw -F stext` is the extractor; the XML it emits is parsed with a REAL
XML parser. Never regex it: characters arrive as entities (&#x2019; for a
curly apostrophe, &#xad; for a soft hyphen) and ad-hoc parsing silently drops
them, which quietly corrupts the very reference you are measuring against.

USAGE
    extract_reference.py <searchable.pdf> <output-dir> [--dpi 200] [--pages 1-20]

OUTPUT
    <output-dir>/page-<N>.json   N is 0-INDEXED (page-0.json is PDF page 1)
    <output-dir>/summary.json

All coordinates are pixels at the target dpi (PDF points * dpi/72), 2 decimals.
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter

CHUNK = 25  # pages per mutool invocation


def run_mutool(pdf, first, last):
    """Return stext XML bytes for pages [first, last] (1-indexed, inclusive)."""
    cmd = ["mutool", "draw", "-F", "stext", "-o", "-", pdf, f"{first}-{last}"]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError(
            f"mutool failed on pages {first}-{last} (exit {proc.returncode}): "
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    return proc.stdout


def page_count(pdf):
    out = subprocess.run(
        ["mutool", "info", pdf], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    ).stdout.decode("utf-8", "replace")
    m = re.search(r"^Pages: (\d+)", out, re.M)
    if not m:
        raise RuntimeError(f"could not read page count from `mutool info {pdf}`")
    return int(m.group(1))


def quad_bbox(quad, s):
    n = [float(v) for v in quad.split()]
    if len(n) != 8:
        raise ValueError(f"expected 8 numbers in quad, got {len(n)}: {quad!r}")
    xs, ys = n[0::2], n[1::2]
    return [
        round(min(xs) * s, 2),
        round(min(ys) * s, 2),
        round(max(xs) * s, 2),
        round(max(ys) * s, 2),
    ]


def parse_page(page_el, scale, fonts):
    """Return (lines, mismatches) for one <page> element.

    `mismatches` counts lines whose own text= attribute disagrees with the
    characters we assembled — a canary for entity/parsing damage.
    """
    lines = []
    mismatches = 0
    for line_el in page_el.iter("line"):
        # chars are nested in <font> elements; a line may switch fonts mid-way.
        entries = []  # (char_el, font_name, font_size)
        for kid in line_el:
            if kid.tag == "font":
                name = kid.get("name") or "?"
                size = float(kid.get("size") or 0.0)
                for ch in kid.findall("char"):
                    entries.append((ch, name, size))
            elif kid.tag == "char":
                entries.append((kid, None, None))
        if not entries:
            continue

        used = Counter((n, round(sz, 1)) for _, n, sz in entries if n is not None)
        mixed = len(used) > 1
        dom_name, dom_size = used.most_common(1)[0][0] if used else (None, None)

        chars = []
        for ch, name, size in entries:
            c = ch.get("c")
            if c is None:
                raise ValueError("char element without a `c` attribute")
            quad = ch.get("quad")
            if quad is None:
                raise ValueError(f"char {c!r} has no quad attribute")
            entry = {"c": c, "bbox": quad_bbox(quad, scale)}
            if mixed and name is not None:
                entry["font"] = name
                entry["size"] = round(size, 2)
            chars.append(entry)
            if name is not None:
                fonts[f"{name}@{round(size, 1)}"] += 1

        bbox = [round(float(v) * scale, 2) for v in line_el.get("bbox").split()]
        text = "".join(e["c"] for e in chars)
        attr = line_el.get("text")
        if attr is not None and attr != text:
            mismatches += 1
        lines.append(
            {
                "bbox": bbox,
                "text": text,
                "font": dom_name,
                "size": round(dom_size, 2) if dom_size is not None else None,
                "chars": chars,
            }
        )
    return lines, mismatches


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("pdf")
    ap.add_argument("outdir")
    ap.add_argument("--dpi", type=float, default=200.0)
    ap.add_argument("--pages", help="1-indexed range, e.g. 1-20 (default: all)")
    args = ap.parse_args()

    pdf = os.path.abspath(args.pdf)
    if not os.path.isfile(pdf):
        sys.exit(f"no such PDF: {pdf}")
    os.makedirs(args.outdir, exist_ok=True)
    scale = args.dpi / 72.0

    total = page_count(pdf)
    if args.pages:
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", args.pages.strip())
        if not m:
            sys.exit(f"bad --pages value: {args.pages}")
        first = int(m.group(1))
        last = int(m.group(2) or m.group(1))
    else:
        first, last = 1, total
    last = min(last, total)

    fonts = Counter()
    per_page_lines = {}
    total_chars = 0
    mismatches = []  # pages where <line text=...> != concatenated chars
    written = 0

    for start in range(first, last + 1, CHUNK):
        stop = min(start + CHUNK - 1, last)
        xml = run_mutool(pdf, start, stop)
        try:
            root = ET.fromstring(xml)
        except ET.ParseError as exc:
            # Pinpoint the offending page instead of blaming the whole chunk.
            for p in range(start, stop + 1):
                try:
                    ET.fromstring(run_mutool(pdf, p, p))
                except ET.ParseError as one:
                    raise SystemExit(f"malformed stext XML on PDF page {p}: {one}")
            raise SystemExit(f"malformed stext XML in pages {start}-{stop}: {exc}")

        seen = set()
        for page_el in root.iter("page"):
            pid = page_el.get("id") or ""
            m = re.fullmatch(r"page(\d+)", pid)
            if not m:
                raise SystemExit(f"unexpected page id {pid!r} in pages {start}-{stop}")
            pno = int(m.group(1))  # 1-indexed
            seen.add(pno)
            lines, bad = parse_page(page_el, scale, fonts)
            for ln in lines:
                total_chars += len(ln["chars"])
            if bad:
                mismatches.append(pno)
            doc = {
                "page": pno - 1,
                "widthPx": round(float(page_el.get("width")) * scale, 2),
                "heightPx": round(float(page_el.get("height")) * scale, 2),
                "lines": lines,
            }
            with open(os.path.join(args.outdir, f"page-{pno - 1}.json"), "w") as fh:
                json.dump(doc, fh, ensure_ascii=False)
            per_page_lines[pno - 1] = len(lines)
            written += 1
        missing = set(range(start, stop + 1)) - seen
        if missing:
            raise SystemExit(f"mutool returned no <page> for {sorted(missing)}")

    counts = [per_page_lines[k] for k in sorted(per_page_lines)]
    summary = {
        "pdf": pdf,
        "dpi": args.dpi,
        "pagesWritten": written,
        "pdfPageCount": total,
        "totalLines": sum(counts),
        "totalChars": total_chars,
        "linesPerPage": {
            "min": min(counts) if counts else 0,
            "median": statistics.median(counts) if counts else 0,
            "max": max(counts) if counts else 0,
        },
        "emptyPages": [k for k in sorted(per_page_lines) if per_page_lines[k] == 0],
        "lineTextMismatchPages": sorted(set(mismatches)),
        "perPageLineCounts": {str(k): per_page_lines[k] for k in sorted(per_page_lines)},
        "fontInventory": dict(fonts.most_common()),
    }
    with open(os.path.join(args.outdir, "summary.json"), "w") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(
        f"wrote {written} pages, {summary['totalLines']} lines, "
        f"{total_chars} chars -> {args.outdir}"
    )


if __name__ == "__main__":
    main()
