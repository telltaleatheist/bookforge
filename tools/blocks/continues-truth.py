"""Ground truth for blocks v5's `continues` head, mined from the PDF's own text layer.

THE QUESTION the head answers, for every adjacent pair of OCR blocks (A, B):
does B continue A's paragraph, or start a new one? OCR splits one real paragraph
across blocks, columns and pages, so this bit is what paragraph reflow needs.

WHY NOT the obvious "free" sources
----------------------------------
Two things that look like they hand you paragraph boundaries do NOT, and this was
measured before the rule below was written:

  * `page.get_text('blocks')` — mupdf merged the ENTIRE body column of
    siege-of-budapest p120 (5 real paragraphs) into one block, and the whole body
    of bonhoeffer-ethics p200 into one block. Its blocks are column regions, not
    paragraphs.
  * `page.get_text('xhtml')` — mupdf DOES emit <p> here, but it emitted ONE <p>
    for those same 5 siege paragraphs, and merged two bonhoeffer p210 paragraphs
    into one. Not usable as truth.

So paragraph boundaries have to be DERIVED from the clean layer's geometry. That
is still a huge win over hand labelling — the clean layer has exact coordinates
and exact characters, where Tesseract has neither — but it is a rule we own, not
a free structure someone else computed. It has to earn its confidence.

THE RULE: two independent geometric signals, confident only when they AGREE
-------------------------------------------------------------------------
For a body line L with predecessor P (in reading order):

  signal A (indent)     L.x0 > colLeft + INDENT_MIN
                        -> L is a first line, so L starts a paragraph
  signal B (prev short) P.x1 < colRight - SHORT_MIN
                        -> P was a LAST line, so L starts a paragraph

In justified body setting these are near-independent: A is about where the line
begins, B is about where the previous one ended. Both fire on a paragraph break;
neither fires mid-paragraph. They disagree on exactly the cases where one of them
is unsafe — a paragraph whose last line happens to fill the measure (B misses),
a flush-left paragraph after a heading (A misses), a hanging indent, a centred
line. Those are reported as UNDECIDED rather than guessed, which is what makes
the coverage number honest.

  A and B      -> new paragraph      (confident)
  neither      -> continues          (confident)
  exactly one  -> undecided          (reason recorded)

Nothing about this rule uses text similarity, and nothing uses the OCR text to
decide the bit — the same discipline as tools/foundry-ocr/align-pairs.py. OCR text is
only ever used afterwards, to SCORE a decision geometry already made (the
wrap-hyphen cross-check below).

PROJECTION onto OCR blocks: box overlap, nothing else
-----------------------------------------------------
The bit for pair (A, B) is a property of B alone: B continues iff B's FIRST truth
line is not a paragraph start. So no global reading order is needed to project —
only per-page reading order to compute the flags themselves. A truth line belongs
to the OCR block whose box it physically overlaps most, exactly as align-pairs.py
assigns truth words to OCR lines.

FAILS LOUDLY (no silent fallbacks) if:
  * more than 5% of pages have an OCR raster shape disagreeing with the PDF page
    rect by >2% — that is page indices misaligned, or the CropBox/MediaBox trap
    from §10b again. (A handful of such pages are cover spreads and inserted
    plates; those pages are dropped and counted, never guessed at.)
  * the book has no measurable paragraph indent (the rule cannot decide anything
    and must not pretend to);
  * a page has too few body lines to measure its own margins — those lines are
    left undecided rather than borrowing the book's margins.

KNOWN, MEASURED DEFECT still in the output: on tables of contents a bare numeral
legitimately sits inside the measure, so `is_marginalia` does not remove it and
the TOC entry after it is emitted as a body pair. 21 of bonhoeffer-ethics' 824
decided body pairs (2.5%) are this. Fix direction is a front/back-matter page
filter, not another text heuristic.

Usage:
  python3 tools/blocks/continues-truth.py <bookdir> <out.jsonl> [--stats out.json]
      <bookdir>  a corpus book dir containing blocks.json (which names its PDF)
"""
import json, sys, os, statistics
from collections import Counter, defaultdict

import fitz  # PyMuPDF

# ── thresholds ───────────────────────────────────────────────────────────────
# All in PDF points. Chosen against the measured geometry of the four
# embedded-layer books, not guessed: indents observed are +12.0pt (bonhoeffer,
# born-digital) and +29pt (siege, ABBYY layer); jitter of a "same" left edge is
# <=1.5pt on the noisiest of them. 5.0 sits clear of the jitter and well under
# the smallest real indent.
INDENT_MIN = 5.0
# A justified line's right edge jitters ~2pt; observed paragraph-final lines were
# short by 22-290pt. 8.0 is above the jitter and far below any real short line.
SHORT_MIN = 8.0
# A truth line counts as belonging to an OCR block if this much of the LINE's own
# area is inside the block box. Same 0.30 as align-pairs.py's word assignment,
# raised to 0.50 because a whole line is a much bigger object than a word and a
# half-in line means the boxes genuinely disagree.
MIN_OVERLAP = 0.50
# Fraction of page height treated as running-head / running-foot band. Running
# heads in bonhoeffer are set at the SAME size as body text, so a size filter
# cannot exclude them; their position can.
HEAD_BAND = 0.09
FOOT_BAND = 0.955
# Body size band, as a fraction of the book's dominant text size. Footnotes in
# bonhoeffer are 8.0 against a 10.0 body; the ABBYY layer in siege jitters the
# reported size of a single body line between 12.4 and 16.6, so the band has to
# be generous in that direction and is deliberately asymmetric downward.
SIZE_LO, SIZE_HI = 0.88, 1.30


def die(msg):
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(2)


def line_text(ln):
    return "".join(s["text"] for s in ln["spans"])


def page_truth_lines(page):
    """Every non-empty text line on the page with its box and dominant size."""
    out = []
    for bl in page.get_text("dict")["blocks"]:
        if bl["type"] != 0:
            continue
        for ln in bl["lines"]:
            t = line_text(ln)
            if not t.strip():
                continue
            x0, y0, x1, y1 = ln["bbox"]
            sizes = [s["size"] for s in ln["spans"] if s["text"].strip()]
            out.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1,
                        "text": t.rstrip("\n"),
                        "size": statistics.median(sizes) if sizes else 0.0})
    return out


def main():
    if len(sys.argv) < 3:
        die(__doc__.strip().splitlines()[-3])
    bookdir, out_path = sys.argv[1], sys.argv[2]
    stats_path = None
    if "--stats" in sys.argv:
        stats_path = sys.argv[sys.argv.index("--stats") + 1]

    B = json.load(open(os.path.join(bookdir, "blocks.json")))
    pdf = B["pdf"]
    if not os.path.exists(pdf):
        die(f"blocks.json names a PDF that is not on disk: {pdf}")
    doc = fitz.open(pdf)
    blocks = B["blocks"]

    # ── pass 1: the book's own typography, measured ──────────────────────────
    # Dominant text size over a sample of pages, weighted by characters, so a
    # page of footnotes cannot outvote the body.
    pages_with_blocks = sorted({b["page"] for b in blocks})
    sample = pages_with_blocks[len(pages_with_blocks) // 4: len(pages_with_blocks) // 4 + 60]
    size_w = Counter()
    for p in sample:
        for ln in page_truth_lines(doc[p]):
            size_w[round(ln["size"] * 2) / 2] += len(ln["text"])
    if not size_w:
        die("the PDF text layer is empty on the sampled pages — this book has no "
            "embedded text and cannot be mined this way")
    body_size = size_w.most_common(1)[0][0]

    # Column edges from body lines across the sample. colLeft is the MODE of the
    # rounded left edge (paragraph-first lines are a minority, so the mode is the
    # non-indented margin); colRight is the 90th percentile of right edges (the
    # measure), because short paragraph-final lines drag any mean or mode down.
    lefts, rights = [], []
    for p in sample:
        H = doc[p].rect.height
        for ln in page_truth_lines(doc[p]):
            if not (SIZE_LO * body_size <= ln["size"] <= SIZE_HI * body_size):
                continue
            if ln["y0"] < HEAD_BAND * H or ln["y1"] > FOOT_BAND * H:
                continue
            lefts.append(round(ln["x0"]))
            rights.append(ln["x1"])
    if len(lefts) < 50:
        die("fewer than 50 body lines found in the sample — the body-size / band "
            "filters did not find this book's body text")
    col_left = Counter(lefts).most_common(1)[0][0]
    rights.sort()
    col_right = rights[int(0.90 * (len(rights) - 1))]

    # Does this book indent paragraphs at all? If not, signal A never fires and
    # every decision would fall out of the AND — say so instead of emitting a
    # file of "continues".
    indented = [x for x in lefts if x > col_left + INDENT_MIN]
    indent_frac = len(indented) / len(lefts)
    indent_delta = (statistics.median(indented) - col_left) if indented else 0.0
    if indent_frac < 0.02:
        die(f"only {indent_frac:.3%} of body lines are indented past "
            f"colLeft+{INDENT_MIN}pt — this book does not mark paragraphs by "
            f"first-line indent, so the two-signal rule cannot decide it")

    typography = {"body_size": body_size, "col_left": col_left,
                  "col_right": round(col_right, 2),
                  "indent_frac": round(indent_frac, 4),
                  "indent_delta_pt": round(indent_delta, 2),
                  "sample_pages": [sample[0], sample[-1]], "body_lines": len(lefts)}

    # ── pass 2: per page, flag each body line as start / continue / undecided ─
    # Reading order within a page is plain top-to-bottom: all four embedded-layer
    # books are single column. ASSUMED, not measured per page — a two-column book
    # would need column splitting here and would silently mis-order without it.
    flags = {}           # (page, idx-in-page-body-order) -> record
    page_body = {}       # page -> list of body lines in reading order
    for p in pages_with_blocks:
        page = doc[p]
        H, W = page.rect.height, page.rect.width
        body = []
        for ln in page_truth_lines(page):
            if not (SIZE_LO * body_size <= ln["size"] <= SIZE_HI * body_size):
                continue
            if ln["y0"] < HEAD_BAND * H or ln["y1"] > FOOT_BAND * H:
                continue
            # Marginalia (Bonhoeffer's German pagination numbers) sit left of the
            # measure; they are not part of the body flow.
            if ln["x0"] < col_left - INDENT_MIN:
                continue
            # Block quotes / extracts are set at a NARROWER measure, inset on both
            # sides. Every one of their lines therefore looks "short" on the right,
            # which fires signal B on the line that follows and drove the biggest
            # undecided bucket in the first measured run (1,314 `prev_short_only`
            # of 4,549 body pairs in bonhoeffer). They are a separate text flow
            # with their own margins, so they leave the body flow here — which
            # also means this tool does not label pairs inside a quote.
            if ln["x0"] > col_left + 1.6 * max(indent_delta, INDENT_MIN):
                continue
            body.append(ln)
        body.sort(key=lambda l: (round(l["y0"], 1), l["x0"]))
        page_body[p] = body

    # Column geometry is PER PAGE, not per book. Measured, not assumed: on
    # siege-of-budapest (a scan) a book-global col_left of 45pt was 4pt off the
    # actual left edge of p120 (41pt), which silently turned real paragraph
    # openings into "continues" — the first version of this tool emitted 31
    # `continues` for the whole book and a hand-check found the sample of them all
    # wrong. Every page of a scan has its own offset and skew, so every page gets
    # its own margins. A page with too few body lines to measure is left
    # undecided rather than borrowing the book's margins.
    MIN_LINES_FOR_GEOM = 6
    page_geom = {}
    for p in pages_with_blocks:
        body = page_body[p]
        if len(body) < MIN_LINES_FOR_GEOM:
            page_geom[p] = None
            continue
        xs = Counter(round(l["x0"]) for l in body)
        pl = xs.most_common(1)[0][0]
        rs = sorted(l["x1"] for l in body)
        pr = rs[int(0.90 * (len(rs) - 1))]
        page_geom[p] = (pl, pr)

    ordered_pages = pages_with_blocks
    prev_line = None                      # carries across the page break, which is
    prev_page = None                      # exactly the case reflow cares about
    for p in ordered_pages:
        geom = page_geom[p]
        for i, ln in enumerate(page_body[p]):
            if geom is None:
                flags[(p, i)] = {"decision": "undecided",
                                 "reason": "page_geometry_unmeasurable",
                                 "sig_indent": None, "sig_prev_short": None,
                                 "prev_text": prev_line["text"] if prev_line else None,
                                 "prev_page": prev_page, "x0": round(ln["x0"], 2),
                                 "col_left": None, "col_right": None,
                                 "text": ln["text"]}
                prev_line, prev_page = ln, p
                continue
            col_left, col_right = geom
            sig_indent = ln["x0"] > col_left + INDENT_MIN
            if prev_line is None:
                rec = {"decision": "undecided", "reason": "no_predecessor",
                       "sig_indent": sig_indent, "sig_prev_short": None}
            else:
                # The predecessor is measured against ITS OWN page's right edge.
                pg = page_geom[prev_page]
                if pg is None:
                    rec = {"decision": "undecided", "reason": "prev_page_geometry_unmeasurable",
                           "sig_indent": sig_indent, "sig_prev_short": None}
                    rec["prev_text"] = prev_line["text"]
                    rec["prev_page"] = prev_page
                    rec["x0"] = round(ln["x0"], 2)
                    rec["col_left"], rec["col_right"] = col_left, round(col_right, 2)
                    rec["text"] = ln["text"]
                    flags[(p, i)] = rec
                    prev_line, prev_page = ln, p
                    continue
                sig_short = prev_line["x1"] < pg[1] - SHORT_MIN
                if sig_indent and sig_short:
                    rec = {"decision": "new", "reason": "both_signals"}
                elif not sig_indent and not sig_short:
                    rec = {"decision": "continues", "reason": "neither_signal"}
                else:
                    rec = {"decision": "undecided",
                           "reason": "indent_only" if sig_indent else "prev_short_only"}
                rec["sig_indent"] = sig_indent
                rec["sig_prev_short"] = sig_short
            rec["prev_text"] = prev_line["text"] if prev_line else None
            rec["prev_page"] = prev_page
            rec["x0"] = round(ln["x0"], 2)
            rec["col_left"], rec["col_right"] = col_left, round(col_right, 2)
            rec["text"] = ln["text"]
            flags[(p, i)] = rec
            prev_line, prev_page = ln, p

    # ── pass 3: project onto OCR blocks by box overlap ───────────────────────
    by_page = defaultdict(list)
    for bi, b in enumerate(blocks):
        by_page[b["page"]].append(bi)

    block_first = {}     # block index -> (page, body-line index) of its first truth line
    unmatched = Counter()
    geom_mismatch = {}   # page -> the two disagreeing page shapes
    for p, idxs in by_page.items():
        if p >= doc.page_count:
            die(f"blocks.json has page {p} but the PDF has {doc.page_count} pages")
        page = doc[p]
        # OCR stored its own page dimensions; scale into PDF points per axis. A
        # >2% mismatch means the page indices are not aligned at all.
        sx_ref = page.rect.width
        sy_ref = page.rect.height
        body = page_body[p]
        for bi in idxs:
            b = blocks[bi]
            sx = sx_ref / b["pageW"]
            sy = sy_ref / b["pageH"]
            if not (0.98 <= sx <= 1.02 and 0.98 <= sy <= 1.02):
                # One page whose OCR raster and PDF page disagree in SHAPE is a
                # cover spread or an inserted plate, not an index misalignment —
                # drop that page's blocks and count it. Many such pages means the
                # indices really are misaligned, which is fatal (checked below).
                geom_mismatch[p] = (b["pageW"], b["pageH"], round(sx_ref, 1), round(sy_ref, 1))
                continue
            bx0, by0 = b["x"] * sx, b["y"] * sy
            bx1, by1 = (b["x"] + b["w"]) * sx, (b["y"] + b["h"]) * sy
            best = None
            for li, ln in enumerate(body):
                area = max(1e-6, (ln["x1"] - ln["x0"]) * (ln["y1"] - ln["y0"]))
                ox = min(ln["x1"], bx1) - max(ln["x0"], bx0)
                oy = min(ln["y1"], by1) - max(ln["y0"], by0)
                if ox <= 0 or oy <= 0:
                    continue
                if ox * oy / area >= MIN_OVERLAP:
                    best = li
                    break            # body is in reading order, so the first hit is topmost
            if best is None:
                unmatched[b.get("category", "?")] += 1
            else:
                block_first[bi] = (p, best)

    if len(geom_mismatch) > 0.05 * len(pages_with_blocks):
        die(f"{len(geom_mismatch)}/{len(pages_with_blocks)} pages have an OCR "
            f"raster shape that disagrees with the PDF page — the page indices "
            f"are misaligned, not a handful of plates. Sample: "
            f"{list(geom_mismatch.items())[:5]}")

    # ── emit one record per adjacent block pair ─────────────────────────────
    # TWO adjacency streams, because they answer different questions:
    #   "raw"  — every consecutive pair in the app's own block order. This is what
    #            a naive reading of "adjacent block pair" means, and it is mostly
    #            useless for the cross-page case: MEASURED, 496 of siege's 500
    #            page-boundary pairs have a running head as B, so the pair that
    #            actually spans the page break never appears in this stream.
    #   "body" — consecutive pairs of the BODY subsequence, non-body blocks
    #            removed. This is the sequence paragraph reflow consumes, and it
    #            is the one that contains the cross-page continuations.
    # Footnotes and captions are their own text flows with their own margins and
    # are NOT covered here; they would need the same machinery run per flow.
    # MEASURED in the first spot-check (12 decisions, 12 right about the
    # paragraph, 2 wrong about the PAIR): Bonhoeffer's marginal German-pagination
    # numbers ("345", "159") sit in the middle of a paragraph, are categorised
    # `body` by OCR, and so land between the two halves of that paragraph in the
    # block chain. The bit "B continues its paragraph" was right both times; the
    # bit "B continues A" was wrong both times, because A was the page number.
    # They are excluded from the body flow by shape, not by text: a bare numeral
    # standing left of the measure is marginalia.
    def is_marginalia(b):
        t = b["text"].strip()
        if not (t.isdigit() and len(t) <= 4):
            return False
        pg = page_geom.get(b["page"])
        if pg is None:
            return False
        return b["x"] * (doc[b["page"]].rect.width / b["pageW"]) < pg[0] - INDENT_MIN

    n_marginalia = sum(1 for b in blocks if b.get("category") == "body" and is_marginalia(b))
    body_seq = [i for i, b in enumerate(blocks)
                if b.get("category") == "body" and not is_marginalia(b)]
    streams = {"raw": list(zip(range(len(blocks) - 1), range(1, len(blocks)))),
               "body": list(zip(body_seq, body_seq[1:]))}

    out = open(out_path, "w")
    stats_by_stream = {}
    for stream, pairs in streams.items():
        n, reasons, hyphen_agree = Counter(), Counter(), Counter()
        xpage = Counter()
        for ai, bi in pairs:
            a, b = blocks[ai], blocks[bi]
            key = block_first.get(bi)
            if key is None:
                dec, reason, ev = "undecided", "no_truth_overlap_B", {}
            else:
                f = flags[key]
                dec, reason = f["decision"], f["reason"]
                ev = {"sig_indent": f["sig_indent"], "sig_prev_short": f["sig_prev_short"],
                      "truth_x0": f["x0"], "col_left": f.get("col_left"),
                      "col_right": f.get("col_right"),
                      "truth_prev_line": f["prev_text"], "truth_first_line": f["text"]}
            # Independent cross-check, never an input: a wrap hyphen at the end of
            # A's OCR text is strong evidence of continuation. Recorded so the two
            # can be scored against each other.
            a_hyphen = a["text"].rstrip().endswith("-")
            if dec in ("continues", "new"):
                hyphen_agree[f"{a_hyphen}|{dec}"] += 1
                if a["page"] != b["page"]:
                    xpage[dec] += 1
            n[dec] += 1
            reasons[reason] += 1
            out.write(json.dumps({
                "book": os.path.basename(os.path.abspath(bookdir)),
                "stream": stream,
                "a_id": a["id"], "b_id": b["id"],
                "a_page": a["page"], "b_page": b["page"],
                "a_cat": a.get("category"), "b_cat": b.get("category"),
                "continues": (dec == "continues") if dec != "undecided" else None,
                "decision": dec, "reason": reason,
                "a_tail": a["text"][-70:], "b_head": b["text"][:70],
                "a_ends_hyphen": a_hyphen,
                "evidence": ev,
            }, ensure_ascii=False) + "\n")
        tot, dec_n = sum(n.values()), n["continues"] + n["new"]
        stats_by_stream[stream] = {
            "pairs": tot, "decisions": dict(n),
            "coverage": round(dec_n / tot, 4) if tot else 0,
            "class_balance_continues": round(n["continues"] / dec_n, 4) if dec_n else None,
            "cross_page_decided": dict(xpage),
            "reasons": dict(reasons),
            "hyphen_crosscheck": dict(hyphen_agree)}
    out.close()

    stats = {"book": os.path.basename(os.path.abspath(bookdir)), "pdf": pdf,
             "pages": len(pages_with_blocks), "blocks": len(blocks),
             "typography": typography, "streams": stats_by_stream,
             "pages_dropped_shape_mismatch": len(geom_mismatch),
             "body_blocks_dropped_as_marginalia": n_marginalia,
             "blocks_with_no_truth_overlap": dict(unmatched)}
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    if stats_path:
        json.dump(stats, open(stats_path, "w"), indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
