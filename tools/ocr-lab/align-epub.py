#!/usr/bin/env python3
"""
align-epub.py — align a band-OCR run against a publisher EPUB and answer the
only question that matters: WHAT BODY TEXT DID WE MISS?

    python3 align-epub.py <lab-dir> <source.epub> [--out DIR]

<lab-dir> holds ocr-bands/page-<N>.json (from run-book.py). Results go to
<lab-dir>/scores/epub-align.json and epub-align-report.md.

Why not a pointer-walk
----------------------
The two sides are ordered streams of the same book, so it is tempting to walk
them together. That loses lock: one dropped paragraph, one photo caption, one
page of front matter the edition does not share, and the pointer never recovers
- and it recovers silently, reporting a book-sized loss that is really one
missed resync. So: anchors and LIS. Find word-shingles that occur EXACTLY ONCE
on each side and match, keep the longest strictly-increasing subsequence of
them so ordering is monotone by construction, and only then align inside the
windows those anchors fence off. An anchor that cannot be placed monotonically
is dropped, never forced.

Missing vs mangled
------------------
These are different failures and the file keeps them apart.

Every OCR line is resolved to an INTERVAL of truth words. A word inside that
interval that reads wrong is MANGLED - the line was found, the recognizer got
it wrong, and it shows up in the CER number. A truth word covered by NO line's
interval is MISSING - nothing in the OCR stream claims it, and that is the
fatal class. Coverage is therefore interval-based on purpose: garbled words sit
inside their line's span and cannot masquerade as holes.

Nothing is ever forced to match. An unmatched truth run stays unmatched; an
unmatched OCR line stays an orphan; where both sides have content that did not
pair, that is EDITION DRIFT, reported as a region and kept out of the miss rate
(the raw rate is reported too - drift never hides behind an exclusion).

Transposition
-------------
Monotone ordering is the right constraint and it has one honest cost: text that
BOTH sides carry in a DIFFERENT ORDER can never be matched, and would be filed
as a hole it is not. That is not hypothetical - it is what footnotes do. Print
sets them at the foot of the page the marker falls on; the EPUB collects them at
the end of the chapter. So every footnote in the book arrives as a truth run
with no in-order counterpart while its text sits in the OCR stream, read
perfectly, dozens of lines away.

So an unmatched truth run is not called missing until it has been looked for in
the WHOLE OCR stream, order ignored (offset voting over 4-word shingles, then a
similarity check). Found = TRANSPOSED: present, read, out of place. Only what
survives that search is MISSING.

Page markers
------------
Some EPUBs are page-faithful and say so in the text: a literal "Page 412" left
where the print page broke. That is a gift - a free anchor every page, exactly
where the anchor is worth most - and a trap, because the string is not on the
scan (the scan has a folio, which is furniture) so a naive run files every one
of them as a hole and charges its two words to every pair whose span crosses it.

So markers are found, USED, and then kept out of everything they are not part
of. Found by series, not by pattern: "page 182" also occurs in prose, so the
"page N" hits only count as markers when their numbers form one long increasing
run down the book (LIS over the values). Used by voting the constant offset
between the printed number and the lab page index off a first alignment pass,
then feeding marker->page-start pairs back in as candidate anchors for a second
pass - candidates, so the LIS still throws out any that do not fit monotonically.
Excluded by excising the marker text from the truth paragraphs after the anchors
are recorded, so it can never appear in a training pair or in a missing run.
The EPUB on disk is never touched.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import zipfile
from bisect import bisect_left
from collections import Counter, defaultdict
from difflib import SequenceMatcher

import Levenshtein
from lxml import html as lxml_html
from lxml import etree

SHINGLE = 6              # anchor length in words; long enough to be unique prose
SHINGLE_FINE = 4         # retry inside windows too big to align directly
ANCHOR_MAX_CELLS = 8e6   # SequenceMatcher budget per window (len(a) * len(b))
FUZZ_WORD = 0.75         # word-level fuzzy match floor inside a window
PAIR_MIN_SIM = 0.75      # a training pair must be at least this similar
FURNITURE_WORDS = 4      # <= this many words and an orphan is page furniture
FURNITURE_PAGES = 5      # a signature on this many pages is a running head
TRANS_MIN_WORDS = 5      # shorter than this, an out-of-order hit is coincidence
TRANS_SHINGLE = 4        # offset-voting shingle for the order-free search
TRANS_MIN_SIM = 0.75     # word-key similarity for "this is the same text"
MARKER_MIN_SERIES = 20   # "page N" is a marker series only this many long
MARKER_MIN_SHARE = 0.60  # ... and only if it is this share of all "page N" hits
MARKER_LOOKAHEAD = 60    # words searched past a marker for an aligned word
MARKER_MIN_OFFSET_AGREE = 0.50   # marker anchors need this much offset consensus

OPF_NS = {"o": "http://www.idpf.org/2007/opf"}
BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
              "dd", "dt", "td", "th", "pre", "div", "figcaption", "caption"}
DROP_TAGS = {"script", "style", "head", "title"}

# Typographic -> ASCII, for MATCHING only. The extracted truth text keeps its
# real apostrophes, quotes and diacritics; these maps never touch what we print.
PUNCT_MAP = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
    "ʼ": "'", "ʹ": "'", "´": "'", "`": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
    "«": '"', "»": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-", "­": "-",
    "…": "...", " ": " ", " ": " ", " ": " ", " ": " ",
}
_PUNCT_RE = re.compile("|".join(map(re.escape, PUNCT_MAP)))
# A hyphen SEPARATES tokens; only the apostrophe stays inside a word. Print and
# EPUB do not agree about hyphens - "twenty-two" is one EPUB word and two lines
# of scan, while "alone— because" is an EPUB em-dash plus a space that the print
# happens to break at - so a token that spans a hyphen would match on one side
# and not the other. Splitting always is the only symmetric choice; end-of-line
# hyphenation is then repaired in build_ocr, where the truth vocabulary can say
# whether the two halves are really one word.
_WORD_RE = re.compile(r"[^\W_]+(?:'[^\W_]+)*", re.UNICODE)
HYPHEN_END = re.compile(r"[\wÀ-ɏ](-|‐|‑|­)\s*$")
PAGE_MARKER_RE = re.compile(r"\bpage\s+(\d{1,4})\b", re.IGNORECASE)


def ascii_punct(s):
    return _PUNCT_RE.sub(lambda m: PUNCT_MAP[m.group(0)], s)


def norm_text(s):
    """Light normalisation: NFKC, ASCII punctuation, collapsed whitespace.
    CASE IS KEPT - this is what CER and similarity are measured on."""
    return re.sub(r"\s+", " ", ascii_punct(unicodedata.normalize("NFKC", s))).strip()


def norm_word(w):
    """Match key for one word: lowercased, punctuation stripped except the
    apostrophe INSIDE a word (don't/o'clock stay one token)."""
    w = ascii_punct(unicodedata.normalize("NFKC", w)).lower()
    m = _WORD_RE.search(w)
    return m.group(0) if m else ""


def tokenize(s):
    """[(word, char_start, char_end)] over the ORIGINAL string, so a span of
    words can always be rendered back with its real punctuation."""
    out = []
    for m in _WORD_RE.finditer(ascii_punct(unicodedata.normalize("NFKC", s))):
        out.append((m.group(0), m.start(), m.end()))
    return out


# ------------------------------------------------------------------ EPUB truth

def read_epub_docs(epub_path):
    """Spine-ordered (href, xhtml bytes). Parsed as XML/HTML, never regex."""
    zf = zipfile.ZipFile(epub_path)
    names = set(zf.namelist())
    container = etree.fromstring(zf.read("META-INF/container.xml"))
    rootfile = container.find(
        ".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
    opf_path = rootfile.get("full-path")
    opf_dir = os.path.dirname(opf_path)
    opf = etree.fromstring(zf.read(opf_path))

    manifest, props = {}, {}
    for it in opf.findall(".//o:manifest/o:item", OPF_NS):
        manifest[it.get("id")] = it.get("href")
        props[it.get("id")] = it.get("properties") or ""

    docs, skipped = [], []
    for ref in opf.findall(".//o:spine/o:itemref", OPF_NS):
        idref = ref.get("idref")
        href = manifest.get(idref)
        if not href:
            raise KeyError("spine references unknown manifest id %r" % idref)
        full = os.path.normpath(os.path.join(opf_dir, href)) if opf_dir else href
        if full not in names:
            raise KeyError("spine item missing from archive: %s" % full)
        base = os.path.basename(href).lower()
        # The navigation document and the cover are apparatus, not body text;
        # aligning a TOC against a scan invents a book-sized hole. Named, not
        # guessed, and reported so the exclusion is never silent.
        if "nav" in props.get(idref, "") or base in ("nav.xhtml", "toc.xhtml",
                                                     "cover.xhtml"):
            skipped.append(href)
            continue
        docs.append((href, zf.read(full)))
    zf.close()
    return docs, skipped


_XML_DECL_ENC = re.compile(rb"""<\?xml[^>]*?encoding\s*=\s*["']([\w.-]+)["']""",
                           re.I)
_META_CHARSET = re.compile(rb"""<meta[^>]*?charset\s*=\s*["']?\s*([\w.-]+)""",
                           re.I)


def doc_encoding(doc_bytes, href):
    """The encoding of one EPUB content document.

    This must be decided here and not left to the parser. An EPUB content
    document is XML, and XML says: no declaration means UTF-8. lxml.html says
    the opposite - no declaration means the HTML default, ISO-8859-1 - and a
    file with neither an XML prolog nor a meta charset (common; the spec makes
    both optional precisely because UTF-8 is the default) then comes back with
    every curly apostrophe as three letters.

    That does not merely look wrong. "wouldn't" arrives as one unbroken word
    of letters, matches nothing on the OCR side, and takes its neighbours down
    with it: the book stops aligning and reports itself as missing. Two
    real books in this corpus read that way before this function existed.

    A document that declares nothing and is not valid UTF-8 is malformed; it is
    named and raised, never guessed at."""
    m = _XML_DECL_ENC.search(doc_bytes[:512]) or \
        _META_CHARSET.search(doc_bytes[:4096])
    if m:
        return m.group(1).decode("ascii", "replace")
    try:
        doc_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("%s declares no encoding and is not UTF-8: %s"
                         % (href, exc))
    return "utf-8"


def leaf_blocks(doc_bytes, href="?"):
    """Text of every block element that holds no nested block - so a <div>
    wrapping paragraphs is not counted twice."""
    try:
        root = lxml_html.fromstring(
            doc_bytes,
            parser=lxml_html.HTMLParser(encoding=doc_encoding(doc_bytes, href)))
    except etree.ParserError:
        return []
    for el in root.iter():
        if isinstance(el.tag, str) and el.tag.lower() in DROP_TAGS:
            el.getparent().remove(el) if el.getparent() is not None else None
    body = root.find(".//body")
    if body is None:
        body = root
    out = []
    for el in body.iter():
        if not isinstance(el.tag, str):
            continue
        if el.tag.lower() not in BLOCK_TAGS:
            continue
        if any(isinstance(c.tag, str) and c.tag.lower() in BLOCK_TAGS
               for c in el.iterdescendants()):
            continue
        txt = norm_text(el.text_content())
        if txt:
            out.append(txt)
    return out


def find_page_markers(paras):
    """Locate a page-marker SERIES: "page N" occurrences whose numbers climb
    monotonically down the book.

    Pattern alone is not enough - "see page 182" is ordinary prose and deleting
    it would be inventing a hole of our own. What a real marker series has and
    prose references do not is ORDER: page 3 before page 4 before page 5, all
    the way through. So every "page N" hit is a candidate, the longest
    increasing-by-number subsequence of them is the series, and it is only
    believed when it is long and accounts for most of the hits. A stray prose
    reference that happens to fit the ramp costs two words; a book with no
    markers gets an empty list and behaves exactly as before.

    Returns ([{"page": n, "para": pi, "cs": .., "ce": ..}], n_candidates)."""
    cand = []
    for pi, p in enumerate(paras):
        for m in PAGE_MARKER_RE.finditer(p["text"]):
            cand.append({"page": int(m.group(1)), "para": pi,
                         "cs": m.start(), "ce": m.end()})
    if len(cand) < MARKER_MIN_SERIES:
        return [], len(cand)
    series = [cand[i] for i in lis_indices([c["page"] for c in cand])]
    if len(series) < MARKER_MIN_SERIES or \
            len(series) < MARKER_MIN_SHARE * len(cand):
        return [], len(cand)
    return series, len(cand)


def strip_markers(paras, markers):
    """Cut the marker text out of the paragraphs it sits in and report where
    each marker now falls. The EPUB file is untouched; this is the in-memory
    truth stream, and after this the marker cannot reach a training pair, a CER
    number, or a missing run."""
    by_para = defaultdict(list)
    for mi, m in enumerate(markers):
        by_para[m["para"]].append(mi)
    at = {}                                  # marker index -> char pos in new text
    for pi, mis in by_para.items():
        txt = paras[pi]["text"]
        out, prev = [], 0
        for mi in sorted(mis, key=lambda i: markers[i]["cs"]):
            m = markers[mi]
            out.append(txt[prev:m["cs"]])
            at[mi] = sum(len(s) for s in out)
            prev = m["ce"]
        out.append(txt[prev:])
        new = "".join(out)
        # Re-collapsing whitespace would shift every recorded position, so the
        # cut is left as-is; tokenize ignores the extra space anyway.
        paras[pi]["text"] = new
    return at


def build_truth(epub_path, page_markers=True):
    docs, skipped = read_epub_docs(epub_path)
    paras = []
    for di, (href, data) in enumerate(docs):
        for txt in leaf_blocks(data, href):
            paras.append({"doc": href, "docIdx": di, "text": txt})

    markers, n_cand = find_page_markers(paras) if page_markers else ([], 0)
    at = strip_markers(paras, markers)

    words = []
    for pi, p in enumerate(paras):
        for w, cs, ce in tokenize(p["text"]):
            k = norm_word(w)
            if k:
                words.append({"k": k, "raw": w, "para": pi, "cs": cs, "ce": ce})

    # Each marker's anchor is the first truth word AFTER it: markers sit where
    # the print page ENDED, so the word that follows opens the next page.
    starts = {}                                # para -> first word index
    for wi, w in enumerate(words):
        starts.setdefault(w["para"], wi)
    for mi, m in enumerate(markers):
        pos, idx = at[mi], None
        for wi in range(starts.get(m["para"], len(words)), len(words)):
            if words[wi]["para"] != m["para"]:
                break
            if words[wi]["cs"] >= pos:
                idx = wi
                break
        if idx is None:                        # marker ended the paragraph
            for pj in range(m["para"] + 1, len(paras)):
                if pj in starts:
                    idx = starts[pj]
                    break
        m["truthWordIdx"] = idx
    markers = [m for m in markers if m.get("truthWordIdx") is not None]
    return paras, words, skipped, markers, n_cand


# -------------------------------------------------------------------- OCR side

def build_ocr(lab, vocab):
    """Ordered OCR lines and the word stream over them, with end-of-line
    hyphenation repaired BEFORE matching.

    A line ending in '-' hands its stub to the next line's first word, but only
    when the joined form is a word the EPUB actually uses. That test is what
    separates a real hyphenation ("millime-" + "ter" -> millimeter, a word) from
    an em-dash that merely landed at the line break ("alone-" + "because" ->
    alonebecause, which is not). Guessing instead of testing costs a false hole
    at every dash in the book, in both directions."""
    bdir = os.path.join(lab, "ocr-bands")
    pages = sorted(int(m.group(1)) for m in
                   (re.fullmatch(r"page-(\d+)\.json", n)
                    for n in os.listdir(bdir)) if m)
    lines = []
    for p in pages:
        # iCloud fileprovider: a file that exists can still read back empty.
        data = None
        for _ in range(3):
            try:
                with open(os.path.join(bdir, "page-%d.json" % p), "rb") as fh:
                    data = fh.read()
                if data:
                    break
            except OSError:
                data = None
            time.sleep(0.3)
        if not data:
            raise IOError("unreadable after 3 attempts: page-%d.json" % p)
        j = json.loads(data.decode("utf-8"))
        for li, ln in enumerate(j.get("lines", [])):
            lines.append({"id": len(lines), "page": p, "line": li,
                          "text": norm_text(ln.get("text") or ""),
                          "bbox": ln.get("bbox"), "conf": ln.get("conf")})

    words, pending = [], None          # pending = hyphen stub from the line above
    for ln in lines:
        toks = tokenize(ln["text"])
        keys = [(norm_word(w), w) for w, _, _ in toks]
        keys = [(k, w) for k, w in keys if k]
        start = 0
        if pending is not None and keys:
            stub_key, stub_line = pending
            k, w = keys[0]
            if (stub_key + k) in vocab:
                words.append({"k": stub_key + k, "line": stub_line,
                              "joined": True})
                start = 1
            else:                       # not a hyphenation: keep both halves
                words.append({"k": stub_key, "line": stub_line, "joined": False})
            pending = None
        elif pending is not None:
            words.append({"k": pending[0], "line": pending[1], "joined": False})
            pending = None
        tail = HYPHEN_END.search(ln["text"]) is not None
        end = len(keys) - 1 if tail and len(keys) > start else len(keys)
        for k, w in keys[start:end]:
            words.append({"k": k, "line": ln["id"], "joined": False})
        if tail and len(keys) > start:
            pending = (keys[-1][0], ln["id"])
    if pending is not None:
        words.append({"k": pending[0], "line": pending[1], "joined": False})
    return lines, words


# ------------------------------------------------------------ anchors and LIS

def unique_shingles(keys, n):
    seen, once = {}, {}
    for i in range(len(keys) - n + 1):
        s = " ".join(keys[i:i + n])
        if s in seen:
            once.pop(s, None)
        else:
            seen[s] = i
            once[s] = i
    return once


def anchor_pairs(tkeys, okeys, n, t_lo=0, o_lo=0):
    a = unique_shingles(tkeys, n)
    b = unique_shingles(okeys, n)
    pairs = [(a[s] + t_lo, b[s] + o_lo) for s in a.keys() & b.keys()]
    pairs.sort()
    return pairs


def lis_indices(values):
    """Indices of a longest strictly-increasing subsequence of `values`."""
    tails, tails_idx, back = [], [], [-1] * len(values)
    for i, v in enumerate(values):
        j = bisect_left(tails, v)
        if j > 0:
            back[i] = tails_idx[j - 1]
        if j == len(tails):
            tails.append(v)
            tails_idx.append(i)
        else:
            tails[j] = v
            tails_idx[j] = i
    if not tails_idx:
        return []
    out, i = [], tails_idx[-1]
    while i >= 0:
        out.append(i)
        i = back[i]
    return out[::-1]


def lis(pairs):
    """Longest strictly-increasing-in-y subsequence; enforces monotone order."""
    if not pairs:
        return []
    tails, tails_idx, back = [], [], [-1] * len(pairs)
    for i, (_, y) in enumerate(pairs):
        j = bisect_left(tails, y)
        if j > 0:
            back[i] = tails_idx[j - 1]
        if j == len(tails):
            tails.append(y)
            tails_idx.append(i)
        else:
            tails[j] = y
            tails_idx[j] = i
    out, i = [], tails_idx[-1]
    while i >= 0:
        out.append(pairs[i])
        i = back[i]
    return out[::-1]


# ----------------------------------------------------------- window alignment

def align_window(tkeys, okeys, t0, t1, o0, o1, out):
    """Map truth index -> ocr index inside one window. Exact matching blocks
    first, then a fuzzy pass over what is left; never a forced pairing."""
    a, b = tkeys[t0:t1], okeys[o0:o1]
    if not a or not b:
        return
    if len(a) * len(b) > ANCHOR_MAX_CELLS:
        sub = lis(anchor_pairs(a, b, SHINGLE_FINE, t0, o0))
        if sub:
            prev_t, prev_o = t0, o0
            for (ti, oi) in sub:
                align_window(tkeys, okeys, prev_t, ti, prev_o, oi, out)
                for d in range(SHINGLE_FINE):
                    out[ti + d] = oi + d
                prev_t, prev_o = ti + SHINGLE_FINE, oi + SHINGLE_FINE
            align_window(tkeys, okeys, prev_t, t1, prev_o, o1, out)
            return
        # Still too big and no anchors: genuinely divergent text. Leave it
        # unmatched rather than burn the budget forcing a pairing.
        return

    sm = SequenceMatcher(None, a, b, autojunk=False)
    blocks = sm.get_matching_blocks()
    prev_a = prev_b = 0
    for ai, bi, size in blocks:
        # fuzzy pass over the gap between the previous block and this one
        ga, gb = a[prev_a:ai], b[prev_b:bi]
        if ga and gb:
            fuzzy_gap(ga, gb, t0 + prev_a, o0 + prev_b, out)
        for d in range(size):
            out[t0 + ai + d] = o0 + bi + d
        prev_a, prev_b = ai + size, bi + size


def fuzzy_gap(ga, gb, tbase, obase, out):
    """Two short unmatched runs facing each other: pair them off the diagonal
    when the words are close enough. This is where OCR garble gets recognised
    as garble instead of as a hole."""
    if len(ga) > 400 or len(gb) > 400:
        return
    used = set()
    for i, wa in enumerate(ga):
        best, bestj = 0.0, -1
        lo = max(0, i - 4)
        for j in range(lo, min(len(gb), i + 5)):
            if j in used:
                continue
            r = Levenshtein.ratio(wa, gb[j])
            if r > best:
                best, bestj = r, j
        if bestj >= 0 and best >= FUZZ_WORD:
            out[tbase + i] = obase + bestj
            used.add(bestj)


# ------------------------------------------------------- transposition rescue

def build_shingle_index(okeys, n):
    idx = defaultdict(list)
    for i in range(len(okeys) - n + 1):
        idx[" ".join(okeys[i:i + n])].append(i)
    return idx


def find_transposed(tkeys, okeys, oidx, s, e):
    """Look for truth words s..e ANYWHERE in the OCR stream, order ignored.

    Every 4-gram of the run votes for the offset that would put it where it was
    found; the winning offset is then checked as a whole. Returns
    (ocr_start, ocr_end, similarity) or None. Cheap, and it cannot invent a hit:
    the similarity check is on the full run, not on the shingles that voted."""
    keys = tkeys[s:e + 1]
    if len(keys) < TRANS_MIN_WORDS or len(keys) < TRANS_SHINGLE:
        return None
    votes = Counter()
    for j in range(len(keys) - TRANS_SHINGLE + 1):
        for pos in oidx.get(" ".join(keys[j:j + TRANS_SHINGLE]), ()):
            if pos - j >= 0:
                votes[pos - j] += 1
    if not votes:
        return None
    best = None
    for off, _ in votes.most_common(5):
        end = min(len(okeys), off + len(keys))
        cand = " ".join(okeys[off:end])
        sim = Levenshtein.ratio(" ".join(keys), cand)
        if best is None or sim > best[2]:
            best = (off, end - 1, sim)
    if best and best[2] >= TRANS_MIN_SIM:
        return best
    return None


# ----------------------------------------------------------------------- main

def run_alignment(tkeys, okeys, anchors, widths=None):
    """Fence the streams off with the anchors, align inside each window.

    An anchor's WIDTH is how many words it claims are equal. A shingle anchor
    claims its SHINGLE words; a page-marker anchor claims NOTHING - width 0 - it
    only says the two streams are at the same place here, and leaves the words
    on either side to be matched on their own evidence. Anchors that overlap
    what an earlier one already spent are skipped rather than reconciled."""
    widths = widths or {}
    t2o, used = {}, []
    prev_t = prev_o = 0
    for (ti, oi) in anchors:
        if ti < prev_t or oi < prev_o:
            continue
        w = widths.get((ti, oi), SHINGLE)
        align_window(tkeys, okeys, prev_t, ti, prev_o, oi, t2o)
        for d in range(w):
            t2o[ti + d] = oi + d
        prev_t, prev_o = ti + w, oi + w
        used.append((ti, oi, w))
    align_window(tkeys, okeys, prev_t, len(tkeys), prev_o, len(okeys), t2o)
    return t2o, used


def marker_anchor_pairs(markers, t2o, owords, lines, tkeys):
    """Turn a page-marker series into candidate anchor pairs.

    The printed number and the lab page index differ by a constant nobody wrote
    down (front matter, a cover the PDF has and the print did not), so it is
    voted for, not assumed: run one alignment, ask each marker which OCR page
    the text right after it landed on, and take the winning difference. A weak
    consensus means the markers and the scan do not describe the same pagination
    - a different edition - and no marker anchors are produced at all.

    Returns (pairs, diagnostics). Pairs are CANDIDATES: the LIS in the second
    pass keeps only the ones that fit monotonically, so a bad marker can shift
    nothing."""
    page_of_word = [lines[w["line"]]["page"] for w in owords]
    first_word_on_page = {}
    for oi, pg in enumerate(page_of_word):
        first_word_on_page.setdefault(pg, oi)

    votes, resolved = Counter(), []
    for m in markers:
        t = m["truthWordIdx"]
        hit = None
        for d in range(MARKER_LOOKAHEAD):
            if t + d < len(tkeys) and (t + d) in t2o:
                hit = page_of_word[t2o[t + d]]
                break
        if hit is None:
            continue
        resolved.append((m, hit))
        votes[hit - (m["page"] + 1)] += 1

    # A marker series that counts MORE pages than the scan has is not the
    # print pagination at all - it is the ebook's own reader pagination - and
    # the numbers say so before any voting does.
    diag = {"markers": len(markers), "resolved": len(resolved),
            "markerPageMin": min((m["page"] for m in markers), default=None),
            "markerPageMax": max((m["page"] for m in markers), default=None),
            "ocrPages": len({l["page"] for l in lines}),
            "labPageOffset": None, "offsetAgreement": None,
            "anchorCandidates": 0, "offsetVotes": {},
            "disagreeingMarkers": []}
    if not votes:
        return [], diag
    off, n = votes.most_common(1)[0]
    agree = n / len(resolved)
    diag["labPageOffset"] = off
    diag["offsetAgreement"] = round(agree, 4)
    diag["offsetVotes"] = {str(k): v for k, v in votes.most_common(6)}
    diag["disagreeingMarkers"] = [
        {"page": m["page"], "landedOnLabPage": pg,
         "impliedOffset": pg - (m["page"] + 1)}
        for m, pg in resolved if pg - (m["page"] + 1) != off][:60]
    if len(resolved) < MARKER_MIN_SERIES or agree < MARKER_MIN_OFFSET_AGREE:
        return [], diag

    pairs = []
    for m in markers:
        oi = first_word_on_page.get(m["page"] + 1 + off)
        if oi is not None and m["truthWordIdx"] < len(tkeys):
            pairs.append((m["truthWordIdx"], oi))
    pairs.sort()
    diag["anchorCandidates"] = len(pairs)
    return pairs, diag


def span_text(paras, twords, i, j):
    """Original text of truth words i..j inclusive, punctuation intact."""
    parts, k = [], i
    while k <= j:
        p = twords[k]["para"]
        m = k
        while m + 1 <= j and twords[m + 1]["para"] == p:
            m += 1
        parts.append(paras[p]["text"][twords[k]["cs"]:twords[m]["ce"]])
        k = m + 1
    return " ".join(parts)


def roman_or_number(s):
    return bool(re.fullmatch(r"[\d\s.,:;\-\[\]()]*", s)) or \
        bool(re.fullmatch(r"[ivxlcdm]+", s.lower().strip(" .[]()")))


def main(argv=None):
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("lab")
    ap.add_argument("epub")
    ap.add_argument("--out", default=None, help="default <lab>/scores")
    ap.add_argument("--no-page-markers", action="store_true",
                    help="measurement only: leave a 'page N' series in the "
                         "truth text, so the cost of not handling it is visible")
    args = ap.parse_args(argv)
    out_dir = args.out or os.path.join(args.lab, "scores")
    os.makedirs(out_dir, exist_ok=True)
    t_start = time.time()

    paras, twords, skipped, markers, n_marker_cand = build_truth(
        args.epub, page_markers=not args.no_page_markers)
    lines, owords = build_ocr(args.lab, {w["k"] for w in twords})
    tkeys = [w["k"] for w in twords]
    okeys = [w["k"] for w in owords]
    print("truth: %d paragraphs, %d words | ocr: %d lines, %d words"
          % (len(paras), len(twords), len(lines), len(owords)), file=sys.stderr)
    if n_marker_cand:
        print("page markers: %d 'page N' hits, %d form the series"
              % (n_marker_cand, len(markers)), file=sys.stderr)

    # --- anchors -----------------------------------------------------------
    raw = anchor_pairs(tkeys, okeys, SHINGLE)
    widths = {p: SHINGLE for p in raw}
    anchors = lis(raw)
    print("anchors: %d unique-both-sides, %d kept by LIS"
          % (len(raw), len(anchors)), file=sys.stderr)

    # --- alignment ---------------------------------------------------------
    t2o, used = run_alignment(tkeys, okeys, anchors, widths)

    # A page-marker series buys a second pass: vote the printed-to-lab page
    # offset off this alignment, then re-align with a fence at every page break.
    marker_diag = {"markers": 0, "candidates": n_marker_cand}
    if markers:
        mpairs, md = marker_anchor_pairs(markers, t2o, owords, lines, tkeys)
        marker_diag.update(md)
        marker_diag["candidates"] = n_marker_cand
        if mpairs:
            for p in mpairs:
                widths.setdefault(p, 0)
            pool = sorted(set(raw) | set(mpairs))
            anchors = lis(pool)
            t2o, used = run_alignment(tkeys, okeys, anchors, widths)
            kept = sum(1 for (ti, oi, w) in used if w == 0)
            marker_diag["anchorsKeptByLis"] = kept
            print("page-marker anchors: offset %+d (agreement %.2f), %d "
                  "candidates, %d kept by LIS; re-aligned"
                  % (md["labPageOffset"], md["offsetAgreement"],
                     md["anchorCandidates"], kept), file=sys.stderr)
    print("aligned %d of %d truth words (%.2f%%)"
          % (len(t2o), len(tkeys), 100.0 * len(t2o) / max(1, len(tkeys))),
          file=sys.stderr)

    # --- per-line truth intervals -----------------------------------------
    # A line owns the span of truth its matched words reach, extended over the
    # words at its edges that did not match, so garble at a line boundary does
    # not read as a hole.
    line_hits = defaultdict(list)                    # line id -> [(t, o)]
    for t, o in t2o.items():
        line_hits[owords[o]["line"]].append((t, o))
    line_words = defaultdict(list)                   # line id -> ocr indices
    for oi, w in enumerate(owords):
        line_words[w["line"]].append(oi)

    intervals = {}
    for lid, hits in line_hits.items():
        hits.sort()
        ts = [t for t, _ in hits]
        lo, hi = min(ts), max(ts)
        ows = line_words[lid]
        first_o = min(o for _, o in hits)
        last_o = max(o for _, o in hits)
        lo -= ows.index(first_o) if first_o in ows else 0
        hi += (len(ows) - 1 - ows.index(last_o)) if last_o in ows else 0
        intervals[lid] = (max(0, lo), min(len(tkeys) - 1, hi))

    covered = bytearray(len(tkeys))
    for lo, hi in intervals.values():
        for t in range(lo, hi + 1):
            covered[t] = 1

    # --- matched pairs: similarity and CER --------------------------------
    # Case is measured BOTH ways on purpose. The EPUB leans on CSS for small
    # caps, so a heading the scan shows as "APPENDICES" is the literal string
    # "appendices" in the file: a strict CER charges that as 100% wrong when
    # nothing was misread. The folded number is the honest mangling rate; the
    # strict one is kept beside it so real case errors cannot hide in the fold.
    pairs, sims, cers, cers_ci = [], [], [], []
    for lid, (lo, hi) in sorted(intervals.items()):
        ocr_t = lines[lid]["text"]
        truth_t = span_text(paras, twords, lo, hi)
        if not truth_t or not ocr_t:
            continue
        a, b = norm_text(ocr_t), norm_text(truth_t)
        sim = Levenshtein.ratio(a, b)
        cer = Levenshtein.distance(a, b) / max(1, len(b))
        cer_ci = Levenshtein.distance(a.lower(), b.lower()) / max(1, len(b))
        sims.append(sim)
        cers.append(cer)
        cers_ci.append(cer_ci)
        pairs.append({"line": lid, "page": lines[lid]["page"],
                      "ocr": ocr_t, "truth": truth_t,
                      "sim": round(sim, 4), "cer": round(cer, 4),
                      "cerCaseFolded": round(cer_ci, 4)})

    # --- missing truth runs -----------------------------------------------
    total_truth_chars = sum(len(p["text"]) for p in paras)
    line_of_t = {}
    for lid, (lo, hi) in intervals.items():
        for t in range(lo, hi + 1):
            line_of_t.setdefault(t, lid)

    oidx = build_shingle_index(okeys, TRANS_SHINGLE)
    missing, transposed, transposed_lines, t = [], [], set(), 0
    while t < len(tkeys):
        if covered[t]:
            t += 1
            continue
        s = t
        while t < len(tkeys) and not covered[t]:
            t += 1
        e = t - 1
        txt = span_text(paras, twords, s, e)

        # Not missing until the whole OCR stream has been searched out of order.
        hit = find_transposed(tkeys, okeys, oidx, s, e)
        if hit is not None:
            o0, o1, sim = hit
            hit_lines = sorted({owords[i]["line"] for i in range(o0, o1 + 1)})
            transposed_lines.update(hit_lines)
            transposed.append({
                "truthWordStart": s, "truthWordEnd": e, "words": e - s + 1,
                "chars": len(txt), "text": txt, "similarity": round(sim, 4),
                "para": twords[s]["para"],
                "doc": paras[twords[s]["para"]]["doc"],
                "foundOnPages": sorted({lines[l]["page"] for l in hit_lines}),
                "foundOcrText": " ".join(lines[l]["text"] for l in hit_lines),
                "expectedNearOcrPage": (lines[line_of_t[s - 1]]["page"]
                                        if s and (s - 1) in line_of_t else None),
                "wasOrphanText": all(l not in intervals for l in hit_lines),
            })
            continue

        before = span_text(paras, twords, max(0, s - 12), s - 1) if s else ""
        after = span_text(paras, twords, e + 1, min(len(tkeys) - 1, e + 12)) \
            if e + 1 < len(tkeys) else ""
        pl = line_of_t.get(s - 1)
        nl = line_of_t.get(e + 1)
        missing.append({
            "truthWordStart": s, "truthWordEnd": e, "words": e - s + 1,
            "chars": len(txt), "text": txt,
            "contextBefore": before, "contextAfter": after,
            "para": twords[s]["para"], "doc": paras[twords[s]["para"]]["doc"],
            "afterOcrPage": lines[pl]["page"] if pl is not None else None,
            "beforeOcrPage": lines[nl]["page"] if nl is not None else None,
            "prevOcrLine": lines[pl]["text"] if pl is not None else None,
            "nextOcrLine": lines[nl]["text"] if nl is not None else None,
        })

    # --- orphan OCR lines ---------------------------------------------------
    sig_pages = defaultdict(set)
    for ln in lines:
        sig = re.sub(r"\d+", "#", norm_word_seq(ln["text"]))
        if sig:
            sig_pages[sig].add(ln["page"])
    orphans_furniture, orphans_prose = [], []
    for ln in lines:
        # A line carrying transposed truth is not an orphan - it was matched,
        # just not in document order. Counting it here would report the same
        # footnote twice: once as text we lost, once as text we invented.
        if ln["id"] in intervals or ln["id"] in transposed_lines \
                or not ln["text"].strip():
            continue
        sig = re.sub(r"\d+", "#", norm_word_seq(ln["text"]))
        nw = len(sig.split())
        repeated = len(sig_pages.get(sig, ())) >= FURNITURE_PAGES
        rec = {"page": ln["page"], "line": ln["line"], "text": ln["text"],
               "words": nw, "repeatedOnPages": len(sig_pages.get(sig, ()))}
        if nw == 0 or roman_or_number(ln["text"]) or nw <= FURNITURE_WORDS \
                or repeated:
            orphans_furniture.append(rec)
        else:
            orphans_prose.append(rec)

    # --- edition drift ------------------------------------------------------
    # Both sides carry text that did not pair: a missing truth run sitting where
    # prose-like OCR orphans also sit. That is a different edition, not a loss.
    prose_pages = Counter(o["page"] for o in orphans_prose)
    drift = []
    for m in missing:
        pg = m["afterOcrPage"] if m["afterOcrPage"] is not None \
            else m["beforeOcrPage"]
        near = 0 if pg is None else sum(prose_pages.get(p, 0)
                                        for p in range(pg - 1, pg + 3))
        m["prosePicOrphansNearby"] = near
        m["drift"] = bool(near >= 2 and m["words"] >= 8)
        if m["drift"]:
            drift.append({"doc": m["doc"], "ocrPage": pg, "words": m["words"],
                          "chars": m["chars"], "orphansNearby": near,
                          "text": m["text"][:300]})

    miss_chars = sum(m["chars"] for m in missing)
    drift_chars = sum(m["chars"] for m in missing if m["drift"])
    real_miss = [m for m in missing if not m["drift"]]
    trans_chars = sum(x["chars"] for x in transposed)

    def dist(v):
        if not v:
            return None
        s = sorted(v)
        q = lambda p: round(s[min(len(s) - 1, int(p * len(s)))], 4)
        return {"n": len(s), "mean": round(sum(s) / len(s), 4),
                "median": q(.5), "p05": q(.05), "p25": q(.25),
                "p75": q(.75), "p95": q(.95),
                "min": round(s[0], 4), "max": round(s[-1], 4)}

    result = {
        "lab": os.path.abspath(args.lab),
        "epub": os.path.abspath(args.epub),
        "elapsedSeconds": round(time.time() - t_start, 1),
        "skippedSpineDocs": skipped,
        "truth": {"paragraphs": len(paras), "words": len(twords),
                  "chars": total_truth_chars},
        "ocr": {"pages": len({l["page"] for l in lines}), "lines": len(lines),
                "words": len(owords),
                "emptyLines": sum(1 for l in lines if not l["text"].strip())},
        "anchors": {"uniqueBothSides": len(raw), "keptByLis": len(anchors),
                    "usedAfterOverlapFilter": len(used)},
        "pageMarkers": marker_diag,
        "alignment": {
            "truthWordsAligned": len(t2o),
            "truthWordsAlignedPct": round(100.0 * len(t2o) / max(1, len(tkeys)), 3),
            "truthWordsCovered": int(sum(covered)),
            "truthWordsCoveredPct": round(100.0 * sum(covered) / max(1, len(tkeys)), 3),
            "linesWithInterval": len(intervals),
            "linesWithIntervalPct": round(100.0 * len(intervals) / max(1, len(lines)), 3),
        },
        "missing": {
            "runs": len(missing),
            "words": sum(m["words"] for m in missing),
            "chars": miss_chars,
            "pctOfEpubBodyChars": round(100.0 * miss_chars / max(1, total_truth_chars), 4),
            "driftRuns": len(drift),
            "driftChars": drift_chars,
            "realRuns": len(real_miss),
            "realChars": miss_chars - drift_chars,
            "realPctOfEpubBodyChars": round(
                100.0 * (miss_chars - drift_chars) / max(1, total_truth_chars), 4),
            "runs_detail": missing,
        },
        "transposed": {
            "runs": len(transposed),
            "words": sum(x["words"] for x in transposed),
            "chars": trans_chars,
            "pctOfEpubBodyChars": round(
                100.0 * trans_chars / max(1, total_truth_chars), 4),
            "runs_detail": transposed,
        },
        "orphans": {
            "furniture": len(orphans_furniture),
            "proseLike": len(orphans_prose),
            "matchedOutOfOrder": len(transposed_lines),
            "proseLike_detail": orphans_prose,
            "furniture_sample": orphans_furniture[:40],
        },
        "driftRegions": drift,
        "matchedPairs": {
            "count": len(pairs),
            "similarity": dist(sims),
            "cer": dist(cers),
            "cerCaseFolded": dist(cers_ci),
            "trainingPairsAtMinSim": sum(1 for s in sims if s >= PAIR_MIN_SIM),
            "trainingPairMinSim": PAIR_MIN_SIM,
        },
    }

    with open(os.path.join(out_dir, "epub-align.json"), "w") as fh:
        json.dump(result, fh, indent=1)
    with open(os.path.join(out_dir, "epub-align-pairs.json"), "w") as fh:
        json.dump(pairs, fh)
    write_report(os.path.join(out_dir, "epub-align-report.md"), result, pairs)
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ("missing", "orphans", "driftRegions",
                                   "transposed")}, indent=1))
    print("transposed (found out of order, NOT missing): %d runs, %d chars, %.4f%%"
          % (len(transposed), trans_chars,
             result["transposed"]["pctOfEpubBodyChars"]))
    print("missing: %d runs, %d chars, %.4f%% of body (%.4f%% excluding drift)"
          % (len(missing), miss_chars, result["missing"]["pctOfEpubBodyChars"],
             result["missing"]["realPctOfEpubBodyChars"]))
    return 0


def norm_word_seq(s):
    return " ".join(k for k in (norm_word(w) for w, _, _ in tokenize(s)) if k)


def write_report(path, r, pairs):
    L = []
    a = L.append
    a("# EPUB alignment report\n")
    a("- lab: `%s`" % r["lab"])
    a("- epub: `%s`" % r["epub"])
    a("- elapsed: %.1f s\n" % r["elapsedSeconds"])
    a("## Sizes\n")
    a("| | |\n|---|---|")
    a("| EPUB paragraphs | %d |" % r["truth"]["paragraphs"])
    a("| EPUB body words | %d |" % r["truth"]["words"])
    a("| EPUB body chars | %d |" % r["truth"]["chars"])
    a("| OCR pages | %d |" % r["ocr"]["pages"])
    a("| OCR lines | %d |" % r["ocr"]["lines"])
    a("| OCR words | %d |" % r["ocr"]["words"])
    a("| spine docs skipped | %s |" % (", ".join(r["skippedSpineDocs"]) or "none"))
    a("")
    a("## Alignment\n")
    al = r["alignment"]
    a("- anchors unique on both sides: %d; kept by LIS: %d"
      % (r["anchors"]["uniqueBothSides"], r["anchors"]["keptByLis"]))
    a("- truth words aligned word-for-word: %d (%.2f%%)"
      % (al["truthWordsAligned"], al["truthWordsAlignedPct"]))
    a("- truth words covered by some OCR line's interval: %d (%.2f%%)"
      % (al["truthWordsCovered"], al["truthWordsCoveredPct"]))
    a("- OCR lines resolved to a truth span: %d (%.2f%%)\n"
      % (al["linesWithInterval"], al["linesWithIntervalPct"]))
    pm = r.get("pageMarkers") or {}
    if pm.get("candidates"):
        a("### Page markers\n")
        a("Literal \"page N\" in the EPUB. Used as anchors, excised from the "
          "truth text so they reach neither a training pair nor a missing run; "
          "the EPUB file is untouched.\n")
        a("- \"page N\" hits: %d; forming the increasing series: %d"
          % (pm.get("candidates", 0), pm.get("markers", 0)))
        if pm.get("markerPageMax"):
            a("- marker numbers run %s..%s over %s scanned pages"
              % (pm["markerPageMin"], pm["markerPageMax"], pm["ocrPages"]))
        if pm.get("labPageOffset") is not None:
            a("- printed page -> lab page offset: %+d (agreement %.2f over %d "
              "resolved markers)" % (pm["labPageOffset"],
                                     pm["offsetAgreement"], pm["resolved"]))
            a("- anchor candidates: %d; kept by LIS: %s"
              % (pm.get("anchorCandidates", 0),
                 pm.get("anchorsKeptByLis", "0 (not used)")))
            bad = pm.get("disagreeingMarkers") or []
            a("- markers landing off the voted offset: %d%s"
              % (len(bad), (" (first: " + ", ".join(
                  "p%d->lab%d" % (b["page"], b["landedOnLabPage"])
                  for b in bad[:10]) + ")") if bad else ""))
        else:
            a("- no offset consensus: the series and the scan do not share a "
              "pagination (different edition?). No marker anchors used.")
        a("")
    tr = r["transposed"]
    a("## Transposed — present in the OCR, out of document order\n")
    a("Found by searching the whole OCR stream with ordering ignored. These are "
      "NOT losses; the scan and the EPUB simply place them differently "
      "(footnotes above all: page-foot in print, chapter-end in the EPUB).\n")
    a("**%d runs, %d chars = %.4f%% of EPUB body.**\n"
      % (tr["runs"], tr["chars"], tr["pctOfEpubBodyChars"]))
    for x in sorted(tr["runs_detail"], key=lambda d: -d["chars"]):
        a("- %d words / %d chars, sim %.3f — %s: expected near OCR page %s, "
          "found on page(s) %s"
          % (x["words"], x["chars"], x["similarity"], x["doc"],
             x["expectedNearOcrPage"],
             ",".join(str(p) for p in x["foundOnPages"])))
        a("  - truth: `%s`" % x["text"][:220])
        a("  - ocr:   `%s`" % x["foundOcrText"][:220])
    a("")
    m = r["missing"]
    a("## MISSING body text (the fatal class)\n")
    a("**%d runs, %d chars = %.4f%% of EPUB body.** "
      "Excluding edition drift: %d runs, %d chars = %.4f%%.\n"
      % (m["runs"], m["chars"], m["pctOfEpubBodyChars"],
         m["realRuns"], m["realChars"], m["realPctOfEpubBodyChars"]))
    a("Every run, longest first:\n")
    for x in sorted(m["runs_detail"], key=lambda d: -d["chars"]):
        a("### %d words / %d chars%s — %s, near OCR page %s"
          % (x["words"], x["chars"], " (DRIFT)" if x["drift"] else "",
             x["doc"], x["afterOcrPage"]))
        a("- before: `...%s`" % x["contextBefore"])
        a("- **MISSING: `%s`**" % x["text"])
        a("- after: `%s...`" % x["contextAfter"])
        a("- prev OCR line: `%s`" % (x["prevOcrLine"] or ""))
        a("- next OCR line: `%s`\n" % (x["nextOcrLine"] or ""))
    a("## OCR lines with no EPUB counterpart\n")
    a("- furniture (short / numeric / repeated across pages): %d"
      % r["orphans"]["furniture"])
    a("- matched out of order (transposed, not orphans): %d"
      % r["orphans"]["matchedOutOfOrder"])
    a("- prose-like orphans: %d\n" % r["orphans"]["proseLike"])
    if r["orphans"]["proseLike_detail"]:
        a("Prose-like orphans:\n")
        for o in r["orphans"]["proseLike_detail"]:
            a("- p%d/L%d (%d words): `%s`" % (o["page"], o["line"], o["words"],
                                              o["text"]))
        a("")
    a("## Edition drift regions\n")
    if not r["driftRegions"]:
        a("None.\n")
    for d in r["driftRegions"]:
        a("- %s near OCR page %s: %d words / %d chars, %d prose orphans nearby"
          % (d["doc"], d["ocrPage"], d["words"], d["chars"], d["orphansNearby"]))
        a("  - `%s`" % d["text"])
    a("")
    a("## Matched pairs (the mangling number, and the training yield)\n")
    mp = r["matchedPairs"]
    a("- pairs: %d" % mp["count"])
    for lbl, key in (("similarity", "similarity"), ("CER", "cer"),
                     ("CER case-folded", "cerCaseFolded")):
        d = mp[key]
        a("- %s: mean %.4f, median %.4f, p05 %.4f, p25 %.4f, p75 %.4f, "
          "p95 %.4f" % (lbl, d["mean"], d["median"], d["p05"], d["p25"],
                        d["p75"], d["p95"]))
    a("- **training pairs at sim >= %.2f: %d**\n"
      % (mp["trainingPairMinSim"], mp["trainingPairsAtMinSim"]))
    worst = sorted(pairs, key=lambda p: p["sim"])[:25]
    a("Worst 25 pairs:\n")
    for p in worst:
        a("- p%d sim %.3f cer %.3f\n  - ocr:   `%s`\n  - truth: `%s`"
          % (p["page"], p["sim"], p["cer"], p["ocr"], p["truth"]))
    with open(path, "w") as fh:
        fh.write("\n".join(L))


if __name__ == "__main__":
    sys.exit(main())
