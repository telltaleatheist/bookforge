#!/usr/bin/env python3
"""
bands.py — projection-profile line segmentation for scanned pages.

Tesseract's layout analysis silently DROPS whole lines: the region is never
handed to the recognizer, so the loss is invisible to confidence scores. This
takes layout away from it. We find the text lines ourselves with a horizontal
projection profile (rows that carry ink vs rows that do not) and emit one band
per line, so a downstream pass can run --psm 7 on crops that contain exactly
one line and cannot skip anything.

    python3 bands.py <renders-dir> <output-dir>

<renders-dir> holds page-<N>.png, N being the 0-indexed page number.
Writes <output-dir>/page-<N>.json per page plus <output-dir>/summary.json.

All boxes are [x0, y0, x1, y1] in page pixels, half-open on x1/y1 (PIL crop
order), always relative to the FULL page, never to the border-cropped content.

No fallbacks: a page that cannot be segmented raises, is reported by number,
and makes the run exit nonzero.
"""

import io
import json
import os
import re
import sys
import time

import numpy as np
from PIL import Image

# Ink is 25% darker than its LOCAL paper tone (and at least 15 levels darker, so
# scanner noise on bright paper does not qualify). Relative rather than absolute
# because these scans are unevenly lit: paper reads 158 mid-page and 85 in the
# corner shadow, and one absolute cut cannot serve both. The only pixel-level
# constants in the file; everything about line geometry is derived per page.
INK_RATIO = 0.75
INK_FLOOR = 15
BG_BLOCK = 64           # local-paper estimation block, px (>= 2 line pitches)
CROP_PAD = 4            # recognition crop padding, px (10 collapsed adjacent lines)
GAP_ROWS = 1            # need this many + 1 consecutive sub-threshold rows to end a band
TALL_FACTOR = 2.5       # band taller than this * median = suspected merged lines
RUN_FACTOR = 2.5        # column ink run this * median = scan strip, not type
COVERAGE_EPS = 0.005    # missed ink above this fraction gets the page flagged
# Edge-trim share that counts as unusual. The routine strip along this scan's
# outer edge is 1.4% of a page's ink at the median and 7.3% at p95 - all of it
# verified by eye to be shadow, not type - so only the tail is worth a flag.
TRIM_EPS = 0.15


# ---------------------------------------------------------------- page loading

def load_gray(path):
    # Read through memory and retry: renders live under ~/Documents, which is an
    # iCloud fileprovider container, and a freshly written file intermittently
    # opens as empty until it materialises. Three attempts, then it is a real
    # error and gets reported by page number like everything else.
    data = None
    for _ in range(3):
        try:
            data = open(path, "rb").read()
            if data[:8] == b"\x89PNG\r\n\x1a\n":
                break
        except OSError:
            data = None
        time.sleep(0.3)
    if not data:
        raise IOError("unreadable render: %s" % path)
    g = np.asarray(Image.open(io.BytesIO(data)).convert("L"), dtype=np.int16)
    if g.ndim != 2 or g.size == 0:
        raise ValueError("not a 2-D image: %s" % path)
    return g


def detect_border(gray):
    """Find the scan border: near-black rows/columns hugging the page edge.

    Counted as ink, a border makes every row look inky and the whole page comes
    back as one band. Rather than cropping a fixed margin (a per-book constant in
    disguise) we walk inward from each edge while the edge line is mostly
    NEAR-BLACK, tolerating a few light lines inside the border, and stop at the
    first real paper. Soft vignettes and corner shadows are deliberately NOT
    handled here - they are paper, just dim, and local_paper() reads them as
    paper. This is only for the hard black margin of a platen scan.

    Returns (y0, y1, x0, x1), half-open, the content rectangle.
    """
    h, w = gray.shape
    paper = float(np.percentile(gray, 80))
    # Only a genuinely black page is an error; a dark cover scan is not, and the
    # ink test is relative so it works at any brightness.
    if paper < 30:
        raise ValueError("page is black (paper tone %.0f) - not a scan?" % paper)
    dark = gray < 0.35 * paper
    rf, cf = dark.mean(axis=1), dark.mean(axis=0)
    y0, y1 = _walk(rf, h // 8, 0.6), h - _walk(rf[::-1], h // 8, 0.6)
    x0, x1 = _walk(cf, w // 8, 0.6), w - _walk(cf[::-1], w // 8, 0.6)
    if y1 - y0 < h // 4 or x1 - x0 < w // 4:
        raise ValueError("border detection ate the page: %s" % ((y0, y1, x0, x1),))
    return y0, y1, x0, x1


def _walk(frac, limit, thresh, gap=3):
    """Walk in from an edge while the edge line qualifies, tolerating `gap`
    non-qualifying lines, for at most `limit` lines. Returns lines to drop.

    A walk that spends its whole allowance without ever reaching paper has not
    found the inner edge of a border - it has found a page that is dark all the
    way in, which is a cover, not a margin. A saturated detector is not a
    detection, so it trims nothing. (Page 531, the back cover, is printed light
    on near-black: every row of it cleared the near-black test, the walk ran the
    full h/8 allowance, and the content rect opened 166 px down the page with
    the first two lines of blurb outside it.)
    """
    last, i = -1, 0
    limit = max(0, min(limit, len(frac)))
    saturated = limit > 0
    while i < limit:
        if frac[i] >= thresh:
            last = i
        elif i - last > gap:
            saturated = False
            break
        i += 1
    if saturated:
        return 0
    # +2 shaves the antialiased inner edge of a border we actually found.
    return last + 3 if last >= 0 else 0


def _edge_strip(strip, limit):
    """Lines to drop from one edge, given a per-line "scan artifact, not type"
    flag. Everything out to the INNERMOST flagged line inside the allowance goes.

    _walk cannot start inland: it gives up after `gap` clean lines, so an
    artifact that leaves a few pixels of paper between itself and the paper edge
    survives it. Page 176 carries a dark blob down its left edge starting nine
    columns in; the walk stopped at column 8, the blob stayed, and it glued the
    top bands together and cost four lines (running head, folio and two lines of
    body). Since no column of type can raise this flag - that is exactly what
    the ink-run test buys, see trim_inky_edges - the paper between the edge and
    a flagged column is margin whether or not the flagging is continuous, and
    an unflagged edge still loses nothing.
    """
    limit = max(0, min(limit, len(strip)))
    idx = np.flatnonzero(strip[:limit])
    # The two extra lines shave the artifact's antialiased inner edge, as _walk
    # does with a border's.
    return int(idx[-1]) + 3 if idx.size else 0


def longest_runs(mask, axis=0):
    """Longest run of True per line (axis 0 = down each column)."""
    m = mask if axis == 0 else mask.T
    h, w = m.shape
    a = np.vstack([np.zeros((1, w), bool), m, np.zeros((1, w), bool)])
    f = np.ascontiguousarray(a.T).ravel()          # one column after another
    idx = np.flatnonzero(f[1:] != f[:-1])
    out = np.zeros(w, dtype=np.int64)
    if idx.size:
        starts, ends = idx[0::2] + 1, idx[1::2] + 1
        np.maximum.at(out, starts // (h + 2), ends - starts)
    return out


def trim_inky_edges(ink, rect):
    """Second border pass, run on the ink mask, to catch the grey strips these
    scans carry along the paper edge: too pale to be near-black (the raw pass
    misses them) and too steep for the local-paper estimate to absorb, so they
    read as ink and glue the first or last line of the page to the edge.

    A strip is told from type by the LENGTH OF ITS INK RUN, not by how much ink
    it holds. Type cannot produce a long vertical run: a column through the left
    stems of every line on the page is 36% ink, but no single run in it is taller
    than one line. A shadow's run is 50 to 1289 pixels. The median column run is
    the x-height of the type (19-20px throughout this book); no column of type
    can carry an unbroken run longer than one glyph, and the tallest glyph is
    under twice that, so RUN_FACTOR sits at 2.5. Unlike an ink-fraction test it
    keeps working after the walk reaches the text block, so a page whose
    type runs right up to the shadow with no blank margin between them is safe.
    Measured: an ink-fraction rule at 0.06 ate ~100 columns of text on pages 44,
    58, 237 and 461, and the coverage audit could not see it, because trimmed ink
    leaves the denominator. That is what trimmedInkPx now reports.
    """
    # Rows keep the ink-fraction rule, and with it the walk: a horizontal smear
    # is a fraction of the width, the row equivalent of the run test would fire
    # on a bold line, and type CAN raise an ink-fraction flag - so a row flag is
    # only trusted while it runs continuously from the paper edge. Columns,
    # whose flag type cannot raise, take the stronger _edge_strip rule instead.
    # Columns and rows are trimmed alternately until stable, since removing a
    # full-height strip changes every row's ink fraction (and vice versa). Each
    # side may lose at most a sixteenth of the ORIGINAL dimension however many
    # rounds run, so an all-ink page (a dark cover) cannot be eaten away round by
    # round - it comes out with its flags raised instead.
    oy0, oy1, ox0, ox1 = rect
    y0, y1, x0, x1 = rect
    ch, cw = (oy1 - oy0) // 16, (ox1 - ox0) // 16
    for _ in range(3):
        runs = longest_runs(ink[y0:y1, x0:x1])
        live = runs[runs > 0]
        ref = float(np.median(live)) if live.size else 0.0
        strip = runs >= max(RUN_FACTOR * ref, 20.0)
        nx0 = x0 + _edge_strip(strip, cw - (x0 - ox0))
        nx1 = x1 - _edge_strip(strip[::-1], cw - (ox1 - x1))
        rf = ink[y0:y1, nx0:nx1].mean(axis=1)
        ny0 = y0 + _walk(rf, ch - (y0 - oy0), 0.15, gap=8)
        ny1 = y1 - _walk(rf[::-1], ch - (oy1 - y1), 0.15, gap=8)
        if (ny0, ny1, nx0, nx1) == (y0, y1, x0, x1):
            break
        y0, y1, x0, x1 = ny0, ny1, nx0, nx1
    ny0, ny1, nx0, nx1 = y0, y1, x0, x1
    if ny1 - ny0 < (oy1 - oy0) // 2 or nx1 - nx0 < (ox1 - ox0) // 2:
        raise ValueError("inky-edge trim ate the page: %s" % ((ny0, ny1, nx0, nx1),))
    before = int(ink.sum())
    ink[:ny0, :] = False
    ink[ny1:, :] = False
    ink[:, :nx0] = False
    ink[:, nx1:] = False
    # Report what the trim destroyed. Trimmed ink leaves the coverage audit's
    # denominator, so without this number an over-eager trim could delete a
    # column of type and still score perfect coverage.
    return (ny0, ny1, nx0, nx1), before - int(ink.sum())


def local_paper(sub):
    """Paper tone estimated per BG_BLOCK tile and bilinearly interpolated.

    A global paper tone cannot survive these scans: the page corner sits in a
    shadow whose paper is darker than the ink threshold derived mid-page, so a
    global cut turns the whole corner into ink, glues the last lines together
    and swallows the page number. The 75th percentile inside a tile two line
    pitches across is paper even when the tile is full of type, because type
    never covers most of a tile.
    """
    h, w = sub.shape
    b = BG_BLOCK
    ph, pw = -(-h // b) * b, -(-w // b) * b
    g = np.pad(sub.astype(np.float32), ((0, ph - h), (0, pw - w)), mode="edge")
    tiles = g.reshape(ph // b, b, pw // b, b).transpose(0, 2, 1, 3).reshape(ph // b, pw // b, b * b)
    grid = np.percentile(tiles, 75, axis=2).astype(np.float32)
    return np.asarray(Image.fromarray(grid, mode="F").resize((pw, ph), Image.BILINEAR),
                      dtype=np.float32)[:h, :w]


def ink_mask(gray, rect):
    """Boolean ink mask over the whole page, False outside the content rect."""
    y0, y1, x0, x1 = rect
    sub = gray[y0:y1, x0:x1].astype(np.float32)
    paper = local_paper(sub)
    ink = np.zeros(gray.shape, dtype=bool)
    ink[y0:y1, x0:x1] = (sub < paper * INK_RATIO) & (sub < paper - INK_FLOOR)
    return ink


# ---------------------------------------------------------------- line banding

def band_region(ink, rect, xa, xb):
    """Band one column of one page. Returns (bands, stats).

    bands are [top, bot) row ranges; stats carries the derived thresholds.
    """
    y0, y1 = rect[0], rect[1]
    rowink = ink[:, xa:xb].sum(axis=1).astype(np.int64)
    rowink[:y0] = 0
    rowink[y1:] = 0
    active = rowink[rowink > 0]
    if active.size == 0:
        return [], {"inkThreshold": 0, "minBandH": 0, "medianPitch": 0}

    # INK THRESHOLD, derived from the page. The row-ink distribution is bimodal:
    # rows through the body of a line darken a large fraction of the text width,
    # while the descenders reaching into the gap below darken only a handful of
    # columns. p75 of the inked rows lands squarely in the text-row mode and so
    # measures "what a line of this book's type looks like"; 12% of that sits in
    # the valley below it. (The prototype's 5%-of-page-width is the same number
    # for this book's type size only - at 2% descenders bridged the lines and 44
    # lines came back as 16 bands.)
    typical = float(np.percentile(active, 75))
    # One refinement: rows carrying only scanner smear drag p75 down on a sparse
    # page, so re-take it over rows that clear 2% of the first estimate.
    active = rowink[rowink >= max(2.0, 0.02 * typical)]
    if active.size:
        typical = float(np.percentile(active, 75))
    thresh = max(3.0, 0.12 * typical)
    # INKED-ROW FLOOR. A descender row carries a few percent of a full text row;
    # the grey smear along a scan edge carries one to three pixels. 2% of a text
    # row separates them, and without it a band grows down the smear to the foot
    # of the page (page 521's last band ran 1223-1289 instead of 1223-1248).
    floor = max(2.0, 0.02 * typical)
    on = rowink > thresh

    def runs(minh):
        out, start, blanks = [], None, 0
        for i in range(y0, y1):
            if on[i]:
                if start is None:
                    start = i
                blanks = 0
            elif start is not None:
                blanks += 1
                if blanks > GAP_ROWS:
                    if i - blanks - start >= minh:
                        out.append([start, i - blanks])
                    start = None
        if start is not None and y1 - start >= minh:
            out.append([start, y1])
        return out

    # MINIMUM BAND HEIGHT, derived from the line pitch. A first pass at minh=3
    # gives band tops; the median spacing between them is the leading of this
    # book at this dpi. A real line's inked core is a large share of the pitch,
    # dust and speckle are not, so a quarter of the pitch separates them. (For
    # this book that lands near the prototype's hand-tuned 8px at 200 dpi.)
    prelim = runs(3)
    tops = [b[0] for b in prelim]
    pitch = float(np.median(np.diff(tops))) if len(tops) >= 3 else 0.0
    minh = max(4, int(round(0.25 * pitch))) if pitch > 0 else 4
    bands = runs(minh)

    # Grow each band over inked-but-below-threshold rows so descenders, accents
    # and the tails of a display capital land inside the band instead of being
    # counted as missed coverage. Growth is bounded by the neighbouring band,
    # taken in order, so two bands can never claim the same row.
    # Growth also stops after half a line pitch: an ascender or descender lives
    # inside its own line's pitch by definition, so anything further is not part
    # of this line. Without the cap the top and bottom lines of a page grow down
    # the horizontal edge smear all the way to the paper edge - that, not merged
    # type, was 17 of the 25 tall bands in the first full run of this book.
    reach = max(4, int(round(0.5 * pitch))) if pitch > 0 else 4
    for i, b in enumerate(bands):
        up_stop = max(bands[i - 1][1] if i else y0, b[0] - reach)
        while b[0] > up_stop and rowink[b[0] - 1] >= floor:
            b[0] -= 1
        down_stop = min(bands[i + 1][0] if i + 1 < len(bands) else y1, b[1] + reach)
        while b[1] < down_stop and rowink[b[1]] >= floor:
            b[1] += 1

    # ORPHAN RESCUE. A line only a few characters wide ('tha."' ending a
    # paragraph) never clears the ink threshold, which is calibrated on full
    # lines - page 521 lost exactly that line, and the coverage audit is what
    # caught it. So any island of inked rows left outside every band is a band
    # if it is line-height AND carries at least as much ink as one full text
    # row. Speckle and dust clear neither test.
    covered = np.zeros(rowink.shape, dtype=bool)
    for b in bands:
        covered[b[0]:b[1]] = True
    live = (rowink >= floor) & ~covered
    start = None
    for i in range(y0, y1 + 1):
        if i < y1 and live[i]:
            start = i if start is None else start
        elif start is not None:
            if i - start >= minh and rowink[start:i].sum() >= thresh:
                bands.append([start, i])
            start = None
    bands.sort()

    heights = [b[1] - b[0] for b in bands]
    stats = {
        "inkThreshold": round(thresh, 1),
        "minBandH": minh,
        "medianPitch": round(pitch, 1),
        "medianBandH": float(np.median(heights)) if heights else 0.0,
    }
    return bands, stats


def x_height(ink, rect):
    """The x-height of this page's type, in pixels: the median column ink run
    inside the content rect. A column of type is broken by the paper between
    the lines, so its longest unbroken run is one glyph tall, and the median
    over every inked column is the height of the commonest glyph body (19-20 px
    throughout this book at 200 dpi). trim_inky_edges already derives its
    shadow-vs-type threshold from it; tight_box derives its word-gap scale from
    it. Zero on a page with no ink, and every user falls back accordingly."""
    runs = longest_runs(ink[rect[0]:rect[1], rect[2]:rect[3]])
    live = runs[runs > 0]
    return float(np.median(live)) if live.size else 0.0


def tight_box(ink, top, bot, xa, xb, xh=0.0):
    """Ink extent of a band, resistant to margin noise.

    A band is one line of type, so its inked columns arrive in word-sized
    clusters separated by word spaces - and a word space is a FRACTION of the
    x-height (5 to 9 px against 19-20 in this book), never a multiple of it. So
    the clusters are cut at blank gaps wider than one x-height, and a cluster at
    either END of the line is dropped when nothing in it could be type: when its
    tallest vertical ink run is under a quarter of the x-height, i.e. shorter
    than the shortest mark the type sets. Only the ends are ever dropped -
    something between two clusters of type is part of the line whatever it looks
    like - and the last surviving cluster is never dropped, so a band made
    entirely of dirt still yields a box and still gets read and reported.

    Page 64's fifth band is what this is for: a nine-word line ending at x=101
    came out 28..784 wide because ONE ink pixel sat in the right margin, and the
    full-width --psm 7 crop that produced read back empty - a line lost to a
    single pixel of scanner noise, with nothing in the geometry to show for it.
    """
    sub = ink[top:bot, xa:xb]
    cols = np.flatnonzero(sub.any(axis=0))
    if cols.size == 0:
        return None
    gap = max(2, int(round(xh)))
    solid = max(2, int(round(0.25 * xh)))
    runs = longest_runs(sub)
    groups, start, prev = [], int(cols[0]), int(cols[0])
    for c in cols[1:]:
        c = int(c)
        if c - prev > gap:
            groups.append((start, prev))
            start = c
        prev = c
    groups.append((start, prev))

    def dust(g):
        return int(runs[g[0]:g[1] + 1].max()) < solid

    while len(groups) > 1 and dust(groups[0]):
        groups.pop(0)
    while len(groups) > 1 and dust(groups[-1]):
        groups.pop()
    lo, hi = groups[0][0], groups[-1][1]
    rows = np.flatnonzero(sub[:, lo:hi + 1].any(axis=1))
    if rows.size == 0:
        return None
    return [int(xa + lo), int(top + rows[0]),
            int(xa + hi) + 1, int(top + rows[-1]) + 1]


# ------------------------------------------------------------ column splitting

def find_gutter(ink, rect):
    """One level of XY-cut: a sustained full-height blank gutter inside the text
    block. Returns the split x, or None. Margins are excluded by looking only
    inside the inked block, and only at its middle 60%."""
    y0, y1, x0, x1 = rect
    colink = ink[y0:y1, x0:x1].sum(axis=0)
    nz = np.flatnonzero(colink > 0)
    if nz.size == 0:
        return None
    bx0, bx1 = int(nz[0]), int(nz[-1]) + 1
    bw = bx1 - bx0
    blank = colink <= max(1, int(0.002 * (y1 - y0)))
    best, run = None, None
    for i in range(bx0, bx1 + 1):
        if i < bx1 and blank[i]:
            run = i if run is None else run
            continue
        if run is not None:
            width, centre = i - run, (run + i) // 2
            if (width >= max(15, int(0.03 * bw))
                    and bx0 + 0.2 * bw <= centre <= bx0 + 0.8 * bw
                    and (best is None or width > best[0])):
                best = (width, centre)
            run = None
    return x0 + best[1] if best else None


# --------------------------------------------------------------- page pipeline

def process_page(path, page):
    gray = load_gray(path)
    h, w = gray.shape
    rect = detect_border(gray)
    ink = ink_mask(gray, rect)
    rect, trimmed = trim_inky_edges(ink, rect)
    total_ink = int(ink.sum())
    if total_ink == 0:
        raise ValueError("no ink found after border masking")

    def band_columns(spans):
        out = []
        for xa, xb in spans:
            bands, st = band_region(ink, rect, xa, xb)
            out.append((xa, xb, bands, st))
        return out

    spans = [(rect[2], rect[3])]
    cols = band_columns(spans)
    gutter = find_gutter(ink, rect)
    if gutter is not None:
        two = band_columns([(rect[2], gutter), (gutter, rect[3])])
        counts = sorted(len(c[2]) for c in two)
        # A blank stripe through a sparse page (a section break, a title) looks
        # like a gutter. A real gutter yields two well-populated, comparably
        # sized columns; validate that before accepting the split.
        if counts[0] >= 10 and counts[1] <= 3 * counts[0]:
            cols = two
        else:
            gutter = None

    xh = x_height(ink, rect)
    bands, heights = [], []
    for xa, xb, raw, _ in cols:
        for top, bot in raw:
            tb = tight_box(ink, top, bot, xa, xb, xh)
            if tb is None:
                raise ValueError("band %d-%d has no ink" % (top, bot))
            bands.append({"tight": tb, "crop": [max(0, tb[0] - CROP_PAD),
                                               max(0, tb[1] - CROP_PAD),
                                               min(w, tb[2] + CROP_PAD),
                                               min(h, tb[3] + CROP_PAD)],
                          "tall": False})
            heights.append(tb[3] - tb[1])

    med_h = float(np.median(heights)) if heights else 0.0
    for b, hh in zip(bands, heights):
        b["tall"] = bool(med_h > 0 and hh > TALL_FACTOR * med_h)

    covered = np.zeros(ink.shape, dtype=bool)
    for b in bands:
        x0, y0, x1, y1 = b["tight"]
        covered[y0:y1, x0:x1] = True
    missed = int((ink & ~covered).sum()) / total_ink

    pitches = [c[3]["medianPitch"] for c in cols if c[3]["medianPitch"]]
    return {
        "page": page,
        "widthPx": w, "heightPx": h,
        "columns": len(cols),
        "contentRect": list(rect[2:4]) + list(rect[0:2]),  # [x0,x1,y0,y1]
        "stats": {
            "medianPitch": round(float(np.median(pitches)), 1) if pitches else 0.0,
            "inkThreshold": round(float(np.median([c[3]["inkThreshold"] for c in cols])), 1),
            "minBandH": int(np.median([c[3]["minBandH"] for c in cols])),
            "medianBandH": round(med_h, 1),
            "xHeightPx": round(xh, 1),
            # inkPx is the denominator of coverageMissed. A blank page carries a
            # few dozen ink pixels of dirt, so its coverage fraction swings wildly
            # on nothing; read the two together.
            "inkPx": total_ink,
            "trimmedInkPx": trimmed,
            "coverageMissed": round(missed, 6),
        },
        "bands": bands,
    }


def main(argv):
    if len(argv) != 3:
        print(__doc__.strip())
        return 2
    src, dst = argv[1], argv[2]
    os.makedirs(dst, exist_ok=True)
    pages = []
    for name in os.listdir(src):
        m = re.fullmatch(r"page-(\d+)\.png", name)
        if m:
            pages.append((int(m.group(1)), os.path.join(src, name)))
    if not pages:
        raise SystemExit("no page-<N>.png files in %s" % src)
    pages.sort()

    per_page, failures = [], []
    for page, path in pages:
        try:
            res = process_page(path, page)
        except Exception as exc:                       # loud, named, never silent
            print("ERROR page %d (%s): %s" % (page, path, exc), file=sys.stderr)
            failures.append({"page": page, "error": str(exc)})
            continue
        with open(os.path.join(dst, "page-%d.json" % page), "w") as fh:
            json.dump(res, fh)
        per_page.append(res)
        if page % 50 == 0:
            print("page %d: %d bands, missed %.5f" %
                  (page, len(res["bands"]), res["stats"]["coverageMissed"]))

    cov = sorted(r["stats"]["coverageMissed"] for r in per_page)
    flagged = []
    for r in per_page:
        why = []
        if r["stats"]["coverageMissed"] > COVERAGE_EPS:
            why.append("coverage %.4f of %d ink px"
                       % (r["stats"]["coverageMissed"], r["stats"]["inkPx"]))
        ntall = sum(1 for b in r["bands"] if b["tall"])
        if ntall:
            why.append("%d tall bands" % ntall)
        if not r["bands"]:
            why.append("zero bands")
        if r["stats"]["trimmedInkPx"] > TRIM_EPS * (r["stats"]["inkPx"] + r["stats"]["trimmedInkPx"]):
            why.append("edge trim removed %d ink px" % r["stats"]["trimmedInkPx"])
        if r["columns"] > 1:
            why.append("%d columns" % r["columns"])
        if why:
            flagged.append({"page": r["page"], "reasons": why})

    def pct(p):
        return round(float(np.percentile(cov, p)), 6) if cov else None

    summary = {
        "boxFormat": "[x0,y0,x1,y1] half-open, full-page pixel coords",
        "pagesProcessed": len(per_page),
        "pagesFailed": failures,
        "totalBands": sum(len(r["bands"]) for r in per_page),
        "totalTallBands": sum(sum(1 for b in r["bands"] if b["tall"]) for r in per_page),
        "multiColumnPages": [r["page"] for r in per_page if r["columns"] > 1],
        "zeroBandPages": [r["page"] for r in per_page if not r["bands"]],
        "coverage": {"min": pct(0), "median": pct(50), "p95": pct(95), "max": pct(100),
                     "epsilon": COVERAGE_EPS,
                     "over": [r["page"] for r in per_page
                              if r["stats"]["coverageMissed"] > COVERAGE_EPS]},
        "bandCounts": {str(r["page"]): len(r["bands"]) for r in per_page},
        "flagged": flagged,
    }
    with open(os.path.join(dst, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    print("\n%d pages, %d bands, coverage median %.6f p95 %.6f max %.6f, %d flagged, %d failed"
          % (len(per_page), summary["totalBands"], summary["coverage"]["median"],
             summary["coverage"]["p95"], summary["coverage"]["max"],
             len(flagged), len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
