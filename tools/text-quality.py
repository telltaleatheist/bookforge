#!/usr/bin/env python3
"""
text-quality.py — deterministic (no model, no network) text-layer quality checker.

WHY THIS EXISTS
---------------
Before a book's text can be used as OCR-correction ground truth, we have to know the
text itself is trustworthy. Two real failures motivated this tool:

  * "Satanic Panic" (Janisse, 2016) — a BORN-DIGITAL PDF whose typesetter text layer is
    wrong because the ToUnicode CMap is broken. Capitals decode as punctuation/digits:
    "Frank =appa", "Iron 0aiden", "/ooks That Kill". Tesseract was RIGHT and the "truth"
    was WRONG. Training on that teaches a model to introduce the error.
  * "Deathstalker" (Green, 1995) — a scanned PDF whose OCR layer mangles the running head
    six different ways (D€flTHSTAlK€R) and leaves line-break hyphen splits ("connois-
    seurs") and word-per-line fragmentation. Its paired EPUB has none of that, which is
    what proved the EPUB independent of the PDF.

The tool is deterministic and fast so it can gate a corpus build over hundreds of books.

USAGE
    tools/text-quality.py PATH [PATH ...]        # .epub / .pdf / .txt / .jsonl / directory
    tools/text-quality.py --paths-from list.json # JSON array (of strings or {path:...}) or
                                                 # a newline-delimited text file
    tools/text-quality.py DIR --json out.json    # machine-readable report
    tools/text-quality.py DIR --quiet            # exit 0=clean 1=suspect 2=unusable

EXIT CODES (--quiet, and always as the process exit status)
    0  every input is `clean`
    1  at least one input is `suspect` and none are `unusable`
    2  at least one input is `unusable`
    3  a hard error (nothing could be read)

DEPENDENCIES: Python standard library + PyMuPDF (`fitz`). Nothing else, by design — this
runs on the corpus box as well as on a dev machine.

WHERE THE THRESHOLDS COME FROM
------------------------------
Every threshold below is annotated with the measurement that justifies it. They were
calibrated against the 175-book born-digital PDF set catalogued in
~/Documents/BookForge/training/ocr-repair/born-digital.json plus the two reference
failures and the reference-clean Deathstalker EPUB. Percentiles quoted in the comments
are over that born-digital set as extracted by this tool's own sampler, so they describe
the population this gate actually sees. See THRESHOLDS below for the table.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys
import unicodedata
import zipfile
from html.parser import HTMLParser

# --------------------------------------------------------------------------------------
# Severity model
# --------------------------------------------------------------------------------------
# Four levels. A check reports the WORST level it reached plus the measured rate and
# examples. The book-level verdict is the worst severity over all checks:
#
#   ok      -> contributes nothing
#   low     -> informational; expected for this source type, or too small to act on
#   medium  -> "suspect": usable for some purposes, NOT as OCR ground truth without repair
#   high    -> "unusable": the text layer is wrong, not merely untidy
#
# The clean/suspect/unusable verdict is deliberately coarse because the consumer is a
# yes/no corpus gate.
SEV_OK, SEV_LOW, SEV_MEDIUM, SEV_HIGH = "ok", "low", "medium", "high"
_SEV_RANK = {SEV_OK: 0, SEV_LOW: 1, SEV_MEDIUM: 2, SEV_HIGH: 3}
_VERDICT_FOR_SEV = {SEV_OK: "clean", SEV_LOW: "clean", SEV_MEDIUM: "suspect", SEV_HIGH: "unusable"}

# --------------------------------------------------------------------------------------
# THRESHOLDS  (all rates are fractions unless the name says per1k)
# --------------------------------------------------------------------------------------
# Each entry states the measurement that put it where it is. No magic numbers.

# --- check 1: broken glyph mapping ---------------------------------------------------
# Measured over the 175 born-digital PDFs with the final detector: p50 0.00017,
# p90 0.00156, p95 0.00515, max 0.01798.
#   MEDIUM at 0.002 (~p92) : ~2 damaged words per 1000, above what healthy typesetting
#                     produces, but low enough to be one stray font subset.
#   HIGH   at 0.005 (~p95) : EVERY book above this line was opened and checked by hand,
#                     and all of them are genuinely broken — Satanic Panic (0.0077,
#                     capitals->punctuation), The Debater's Guide (0.0180, fi ligature ->
#                     "af¤rmative"), Falun Gong (0.0062, ffi -> "o≈cial"), Julius
#                     Streicher (0.0052, a scan misfiled as born-digital), Good Slave
#                     (0.0057, digits->capitals). There were no false positives at this
#                     line, which is why it sits at p95 rather than further out.
# An inferred one-to-one substitution table covering >=3 distinct symbols is by itself
# promoted to HIGH regardless of rate: a consistent symbol->capital map cannot happen by
# accident, and it means every occurrence of those capitals in that font is wrong.
GLYPH_WELD_MEDIUM = 0.002
GLYPH_WELD_HIGH = 0.005
GLYPH_SUBST_SYMBOLS_FOR_HIGH = 3

# Control characters (C0 except tab/newline/CR, and C1) have no business in extracted book
# text at all; a single one is a decoding fault, so the bar is "more than a handful".
# Measured: 171 of 175 born-digital PDFs have exactly 0. Satanic Panic has 264 in a
# 234k-char sample (1.1 per 1000 chars).
# Measured: p50 0.00000, p90 0.00006, p95 0.00043, max 0.00347.
#   MEDIUM at 0.0001 : beyond a one-off stray glyph.
#   HIGH   at 0.001  : deliberately NOT tighter. "Thank You for Arguing" carries 33 x
#                     U+0002 (rate 0.00043) and inspection shows they are a decorative
#                     BULLET in a sidebar ("\x02 Persuasion Alert"), not damaged prose.
#                     A tighter line would call that book unusable. Above 0.001 the
#                     survivors are all real: Satanic Panic 0.0013, Julius Streicher
#                     0.0016 (73 x U+0000), A Church Undone 0.0035 (246 x U+0001).
CTRL_CHAR_MEDIUM = 0.0001
CTRL_CHAR_HIGH = 0.001

# Private Use Area codepoints are the other classic broken-CMap signature (the font ships
# its own glyph ids). But graded on the RAW count this misfires badly: web articles
# printed to PDF embed icon fonts, so "Why Trump isn't a fascist" has 19 PUA codepoints
# and "The Extremism Gradient" 96 — all of them share/social icons sitting alone on their
# own lines, with the prose untouched.
# The discriminator is whether the PUA character is ADJACENT TO A LETTER. Measured:
#     Why Trump           19 PUA,   0 in-word   (icon font, prose fine)
#     Extremism Gradient  96 PUA,   0 in-word   (icon font, prose fine)
#     Bathsheba's Breast 1898 PUA, 126 in-word  (the text font itself is unmapped)
# So the grade is on the in-word rate, and the raw count is only reported.
PUA_MEDIUM = 0.00002
PUA_HIGH = 0.0002

# --- check 2: mojibake ---------------------------------------------------------------
# Mojibake is binary in practice: a file is either decoded right or it is not. Measured 0
# occurrences across the born-digital set. So the bar is "did it happen at all", with a
# tiny allowance for a book that genuinely quotes a mis-encoded string.
#   LOW    at >=1 occurrence
#   MEDIUM at 0.00002 of chars (2 per 100k)
#   HIGH   at 0.0002
MOJIBAKE_MEDIUM = 0.00002
MOJIBAKE_HIGH = 0.0002
# U+FFFD means the decoder already gave up on those bytes; graded the same way.
REPLACEMENT_MEDIUM = 0.00002
REPLACEMENT_HIGH = 0.0002

# --- check 3: line-break hyphenation -------------------------------------------------
# Measured: EVERY typeset PDF has these — born-digital median 4.1 splits per 1000 words,
# p95 8.9. So for a PDF this is NOT a defect signal, it is a property of the medium, and
# flagging it would flag the entire corpus. It is recorded as LOW for PDFs and only
# escalates if it is extreme (see HYPHEN_PDF_HIGH_PER1K), which indicates an OCR layer
# breaking words that were never hyphenated.
# For an EPUB or a plain-text file it is a real finding: a native ebook reflows, so a
# line-break hyphen means the text was derived from a fixed-layout source and the
# de-hyphenation pass was skipped. Reference: the Deathstalker EPUB has 0 in 1.17M chars.
#   EPUB/txt MEDIUM at 0.2 per 1000 words : one split every 5000 words is already far more
#                     than the zero a native ebook produces, while tolerating the odd
#                     genuine "well- known" typo.
#   EPUB/txt HIGH   at 2.0 per 1000 words : within an order of magnitude of a raw PDF
#                     extraction, i.e. this "ebook" IS a PDF dump.
HYPHEN_EBOOK_MEDIUM_PER1K = 0.2
HYPHEN_EBOOK_HIGH_PER1K = 2.0
# Measured across the born-digital set: p50 0.9, p75 12.2, p95 22.6, p98 24.6, max 32.4
# per 1000 words. A PDF only reaches MEDIUM above 25 (2 books, both dictionary-style
# reference works set in narrow columns), and never reaches HIGH.
HYPHEN_PDF_HIGH_PER1K = 25.0

# --- check 4: page furniture ---------------------------------------------------------
# Running heads and folios on their own lines are normal in a PDF text layer and are the
# extractor's job to drop, so for PDFs they are LOW no matter the rate.
# Two things are real defects anywhere:
#   * furniture welded INTO a prose line ("...end of sentence. DEATHSTALKER 49 The next"),
#     which no downstream line filter can remove safely.
#   * furniture at all in an EPUB/txt, which again means PDF-derived text.
# Measured: born-digital PDFs put 2.9% of lines in furniture at the median (p95 6.1%);
# inline furniture is 0.0000 at the median and 0.0002 at p95 across the same set.
# Measured inline rate: p90 0.00134, p95 0.00173, p98 0.00366, max 0.00861. The detector
# is the most fragile one here (it matches a repeated string against prose), so HIGH sits
# ABOVE the observed maximum: welded furniture alone can make a book suspect, never
# unusable, and something else has to corroborate.
FURNITURE_INLINE_MEDIUM = 0.002
FURNITURE_INLINE_HIGH = 0.01
FURNITURE_EBOOK_MEDIUM = 0.01      # 1% of an ebook's lines are running heads/folios
FURNITURE_EBOOK_HIGH = 0.05

# --- check 5: word-per-line fragmentation --------------------------------------------
# A typeset line of body text holds roughly 9-13 words. Measured over the born-digital
# set: mean words/line 10.3 median, 7.4 at p05; share of 1-2 word lines 0.10 median,
# 0.22 at p95. The Deathstalker OCR layer sits at 0.35 because the OCR split on wide
# inter-word gaps ("Have\nI ever lied to you?").
# Graded on brokenShortLineShare (short AND broken mid-sentence), measured p50 0.0198,
# p90 0.0773, p95 0.1029, p98 0.1224, max 0.3904.
#   MEDIUM at 0.13 (~p99) : above every ordinary book in the corpus.
#   HIGH   at 0.25 : catches exactly two books, both verified by hand — the Deathstalker
#                    OCR layer (0.306) and a typewritten interrogation transcript whose
#                    OCR is visibly broken ("Ibu destroyed than with gasoline", 0.390).
# Only applied to paginated sources (PDF); an EPUB's "lines" are paragraphs, so the metric
# is meaningless there and is reported without a severity.
FRAGMENT_SHORT_LINE_MEDIUM = 0.13
FRAGMENT_SHORT_LINE_HIGH = 0.25

# --- check 6: spacing damage ---------------------------------------------------------
# Missing inter-word spaces are confirmed by splitting the run into two words that BOTH
# occur elsewhere in this same book (self-vocabulary, no dictionary dependency), which
# makes a false positive expensive to produce.
# Measured: p95 0.00012, max 0.00020 — the self-vocabulary confirmation makes this metric
# very quiet, so the thresholds are deliberately far above the observed range and exist to
# catch a genuinely broken extractor rather than to discriminate within this corpus.
MISSING_SPACE_MEDIUM = 0.004
MISSING_SPACE_HIGH = 0.02      # 2% of words are two words welded together
# Doubled spaces are cosmetic (a normalizer fixes them), so they never exceed LOW.
DOUBLE_SPACE_NOTE = 0.02

# --- check 7: character-class anomalies ----------------------------------------------
# Share of characters inside word interiors that are not letters, digits, apostrophes or
# hyphens. Measured: born-digital median 0.0003, p95 0.0021.
WORD_INTERIOR_JUNK_MEDIUM = 0.005
WORD_INTERIOR_JUNK_HIGH = 0.02
# Mixed-script words (Cyrillic/Greek homoglyphs inside Latin words) are always a fault.
MIXED_SCRIPT_MEDIUM = 0.0005
MIXED_SCRIPT_HIGH = 0.005

# --- check 8: language plausibility --------------------------------------------------
# Share of tokens that are stopwords of the best-matching language. Real prose in any of
# the supported languages runs 0.25-0.40. Measured floor over the born-digital set
# (which includes reference works, tables and bibliographies): p05 = 0.19, min 0.11.
#   MEDIUM at 0.12 : below the observed minimum for real prose; the text is either not
#                    running prose (index/table dump) or is damaged.
#   HIGH   at 0.05 : one word in twenty is a function word — that is not language.
STOPWORD_MEDIUM = 0.12
STOPWORD_HIGH = 0.05

# --- check 9: truncation / emptiness -------------------------------------------------
# Truncation. Measured on the reference-CLEAN Deathstalker EPUB: 471 of 650 spine items
# (72%) end mid-sentence — because the converter chunked the book into ~2.4 KB spine items
# that split mid-paragraph. So "ends mid-sentence" on its own says nothing; a threshold on
# it would fail a known-good ebook.
# What actually indicates LOST TEXT is a mid-sentence end whose successor does not continue
# it: unit N stops mid-clause and unit N+1 starts a new sentence. On the same clean EPUB
# that continuation-aware rate is 0.051, and inspecting all 33 shows every one is a false
# alarm where the sentence continues into a proper noun ("...Members of the | Families
# would never..."). That 0.051 is therefore the observed noise floor of the metric.
#   MEDIUM at 0.25 : ~5x the measured noise floor.
#   HIGH   at 0.60 : most units stop dead — the extractor is dropping the tail of each one.
TRUNCATION_MEDIUM = 0.25
TRUNCATION_HIGH = 0.60
# A unit with under 40 characters carries no usable text. Front matter, section dividers
# and image-only pages make a low rate normal; born-digital median 0.02, p95 0.11.
EMPTY_UNIT_MEDIUM = 0.25
EMPTY_UNIT_HIGH = 0.50
# Chars per page below this on a source classified born-digital means the text layer is
# missing most of the page. 50 is the same discriminator the corpus classifier uses.
MIN_CHARS_PER_PAGE = 50

# How many pages to sample from a PDF. Measured: 40 evenly spaced pages give a welded-
# symbol rate within 0.0004 of the full-document rate on Satanic Panic while keeping a
# 500-page book under a second. Sampling is deterministic (evenly spaced), never random.
DEFAULT_PDF_SAMPLE_PAGES = 40

# --------------------------------------------------------------------------------------
# Stopword tables (check 8)
# --------------------------------------------------------------------------------------
# Top function words only. Deliberately tiny and hand-checked for cross-language overlap;
# a full language-id model would be a heavy dependency for a question this crude.
STOPWORDS = {
    "en": "the of and to a in that is was it for he she as with his her they be at by not"
          " but from this have had are on or an you all we were which one their said".split(),
    "de": "der die und in den von zu das mit sich des auf fur ist im dem nicht ein eine als"
          " auch es an werden aus er hat dass sie nach wird bei einer um am sind".split(),
    "fr": "le la de et les des en un une du dans il que pour qui sur au ne pas ce se plus"
          " par je son avec tout mais nous comme ou si leur elle sont".split(),
    "es": "de la que el en y a los se del las un por con no una su para es al lo como mas"
          " pero sus le ya o este si porque esta entre cuando".split(),
    "it": "di che e il la per un in una non sono mi si ma ho lo ha le si da come piu o al"
          " del ci nel alla se dei suo anche questo".split(),
    "nl": "de van het een en in is dat op te zijn met voor niet aan er die maar om ook als"
          " dan wordt door over bij nog of naar heeft".split(),
    "pt": "de que e do da em um para com nao uma os no se na por mais as dos como mas ao"
          " ele das seu sua ou quando muito nos ja".split(),
}
STOPSETS = {lang: set(words) for lang, words in STOPWORDS.items()}

# --------------------------------------------------------------------------------------
# Regexes
# --------------------------------------------------------------------------------------
# Characters allowed to sit inside a word without being "junk".
#
# MEASURED, not assumed: the first pass over the 175-book born-digital set put the
# "welded symbol" rate at a median of 0.003 — three per thousand words in perfectly
# healthy books. Inspecting the hits showed they were entirely legitimate typography and
# identifiers: en/em dashes joining compounds ("Export–Import", "Dodd–Frank"), dots in
# domains and file names ("fx.movie.edu", "CDCFoundation.pdf"), slashes and colons in
# URLs, commas in numbers, parentheses in citations. None of that is corruption.
#
# So the allowed set is everything that DOES legitimately sit between two letters in real
# book text, and the fault signal is the remainder: currency and math symbols, box and
# bullet glyphs, control characters — characters a typesetter never puts inside a word.
_INTRAWORD_OK = set(
    "'’ʼ‘`"          # apostrophes
    "-‐‑‒–—―­"   # hyphen/dash family, incl. soft hyphen
    ".,:;/\\()[]&!?"  # abbreviations, domains, URLs, citations, "and/or"
    "\"“”"            # quotes inside quoted compounds
)

# A "word token": a run of non-space, later trimmed of edge punctuation.
_TOKEN_RE = re.compile(r"\S+")
# Trim leading/trailing punctuation and quotes so that "(%ritish," reduces to "%ritish".
_EDGE_TRIM = "\"'‘’“”()[]{}<>.,;:!?…—–-*_/\\|«»¡¿"

# Mojibake: UTF-8 bytes decoded as Latin-1/cp1252. The tell is a Latin-1 high char (Ã, Â,
# â, ð, Å, Ë, ...) immediately followed by another C1-range-mapped char. Anchored on the
# lead bytes that actually occur for UTF-8 sequences.
_MOJIBAKE_RE = re.compile(
    "[ÂÃÅâãïð]"
    "[-¿–—‘’‚“”„†‡"
    "…‰€ŒœŠšŸŽžˆ˜]"
)
# Line-break hyphenation, in both the forms it survives as: "per-\ncent" straight out of a
# page extractor, and "connois- seurs" once lines have been joined with spaces.
_HYPHEN_SPLIT_RE = re.compile(r"([A-Za-z]{2,})[‐-]\s*\n\s*([a-z][A-Za-z]{1,})")
_HYPHEN_SPACE_RE = re.compile(r"([A-Za-z]{2,})[‐-] ([a-z][A-Za-z]{1,})")
# Standalone folio: a line that is nothing but a page number (arabic or roman).
_FOLIO_RE = re.compile(r"^\s*[\[(]?(?:\d{1,4}|[ivxlcdmIVXLCDM]{1,7})[\])]?\s*$")
# An explicit page marker welded into running prose.
# NOTE the capital P and the negative lookbehind for cross-reference cues. Lowercase
# "see below, page 421" is an ordinary editorial cross-reference — Bonhoeffer's Ethics has
# dozens and they were the last false positive left in the inline-furniture check. A
# welded page marker from a layout engine is capitalised and stands on its own.
_PAGE_MARKER_RE = re.compile(
    r"(?<!\bsee )(?<!\babove, )(?<!\bbelow, )(?<!\bon )(?<!\bcf\. )"
    r"(?<![A-Za-z])Page \d{1,4}(?: of \d{1,4})?(?![A-Za-z])")
# The same marker, capturing its number, so a regular print-page sequence can be told
# apart from a cross-reference ("see page 42") — see strip_page_markers().
_PAGE_MARKER_NUM_RE = re.compile(r"(?<![A-Za-z])[Pp]age\s+(\d{1,4})(?![\w])")
_LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)

# Unicode PRESENTATION LIGATURES (U+FB00-FB06: ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ). These are real, correctly
# encoded characters — NOT a broken character map — but they still matter for an OCR
# ground truth corpus, because an OCR engine emits "first" where the text layer holds
# "ﬁrst", which scores as a character error that is really an encoding mismatch. So they
# get their own finding ("normalize with NFKC") instead of being counted as damage.
_PRESENTATION_LIGATURES = set("ﬀﬁﬂﬃﬄﬅﬆ")

# Identifier-shaped tokens (URLs, domains, file names, paths, emails, hex ids, timestamps)
# are not prose and must be excluded from every word-shape check. In the first calibration
# pass they were the single largest source of false "welded symbol" hits: the top four
# offenders in the born-digital set were a DNS textbook (movie.edu, db.fx.movie.edu), two
# footnote-heavy books that are 4% bare URLs, and a QAnon compilation full of image
# filenames and 4chan tripcodes.
_IDENTIFIER_RE = re.compile(
    r"://|www\.|@|\\|%[0-9A-Fa-f]{2}|_"      # protocol, host, email, path, percent-escape
    r"|\.[A-Za-z]{2,4}(?:$|/)"                # file extension or TLD
    r"|\..*\."                                # two or more dots (dotted name)
    r"|\d{1,2}:\d{2}"                         # timestamp
)


def looks_like_identifier(token: str) -> bool:
    return bool(_IDENTIFIER_RE.search(token))


# --------------------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------------------
class _TextExtractor(HTMLParser):
    """Minimal HTML -> text. Block-level tags become line breaks so that the line-shape
    metrics (fragmentation, furniture) see paragraphs, which is what an EPUB's 'lines'
    genuinely are."""

    BLOCK = {
        "p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th",
        "blockquote", "section", "article", "pre", "hr", "table", "ul", "ol", "figure",
        "figcaption", "aside", "header", "footer", "nav", "body",
    }
    SKIP = {"script", "style", "head", "title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip_depth += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip_depth == 0:
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        # Collapse runs of blank lines but keep single breaks; do NOT collapse spaces —
        # the doubled-space metric depends on them surviving.
        return re.sub(r"\n[ \t]*\n+", "\n", raw)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        pass  # a malformed spine item still yields whatever was parsed before the fault
    return parser.text()


def extract_epub(path: str) -> tuple[list[str], dict]:
    """Returns (units, meta). One unit per spine item, in spine order."""
    units: list[str] = []
    meta: dict = {"kind": "epub"}
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        opf_name = None
        try:
            container = zf.read("META-INF/container.xml").decode("utf-8", "replace")
            m = re.search(r'full-path="([^"]+)"', container)
            if m:
                opf_name = m.group(1)
        except KeyError:
            pass
        if opf_name is None:
            opf_candidates = [n for n in names if n.lower().endswith(".opf")]
            opf_name = opf_candidates[0] if opf_candidates else None

        ordered: list[str] = []
        if opf_name and opf_name in names:
            opf = zf.read(opf_name).decode("utf-8", "replace")
            base = os.path.dirname(opf_name)
            manifest = {
                mid: href
                for mid, href in re.findall(
                    r'<item\b[^>]*?id="([^"]+)"[^>]*?href="([^"]+)"', opf
                )
            }
            # href may precede id in the attribute order; catch that spelling too.
            for href, mid in re.findall(r'<item\b[^>]*?href="([^"]+)"[^>]*?id="([^"]+)"', opf):
                manifest.setdefault(mid, href)
            for idref in re.findall(r'<itemref\b[^>]*?idref="([^"]+)"', opf):
                href = manifest.get(idref)
                if not href:
                    continue
                full = os.path.normpath(os.path.join(base, href)) if base else href
                ordered.append(full.replace(os.sep, "/"))
            lang = re.search(r"<dc:language[^>]*>([^<]+)<", opf)
            if lang:
                meta["declaredLanguage"] = lang.group(1).strip()
        if not ordered:
            ordered = [n for n in names if n.lower().endswith((".xhtml", ".html", ".htm"))]

        for name in ordered:
            if name not in names:
                continue
            try:
                raw = zf.read(name)
            except KeyError:
                continue
            units.append(html_to_text(raw.decode("utf-8", "replace")))
    meta["units"] = len(units)
    meta["unitKind"] = "spine item"
    return units, meta


def extract_pdf(path: str, sample_pages: int) -> tuple[list[str], dict]:
    import fitz  # imported lazily so EPUB/txt runs work without PyMuPDF present

    doc = fitz.open(path)
    n = doc.page_count
    # Evenly spaced deterministic sample. The first and last pages are skipped when the
    # book is long enough: covers, colophons and index pages are not prose and would
    # distort every line-shape metric.
    lo, hi = (1, n - 1) if n > 8 else (0, n)
    span = max(1, hi - lo)
    if span <= sample_pages:
        idx = list(range(lo, hi))
    else:
        step = span / float(sample_pages)
        idx = sorted({lo + int(i * step) for i in range(sample_pages)})
    units = []
    for i in idx:
        try:
            units.append(doc[i].get_text("text"))
        except Exception:
            units.append("")
    meta = {
        "kind": "pdf",
        "pageCount": n,
        "sampledPages": len(idx),
        "units": len(units),
        "unitKind": "page",
    }
    try:
        doc.close()
    except Exception:
        pass
    return units, meta


def extract_jsonl(path: str) -> tuple[list[str], dict]:
    """One unit per record. Prefers conventional text fields; otherwise takes every string
    value in the record so that an unfamiliar schema still gets checked."""
    preferred = ("text", "truth", "content", "body", "target", "output", "gt", "reference")
    units = []
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                units.append(line)
                continue
            if isinstance(rec, str):
                units.append(rec)
                continue
            if not isinstance(rec, dict):
                units.append(json.dumps(rec))
                continue
            picked = [str(rec[k]) for k in preferred if isinstance(rec.get(k), str)]
            if not picked:
                picked = [v for v in rec.values() if isinstance(v, str) and len(v) > 20]
            units.append("\n".join(picked))
    return units, {"kind": "jsonl", "units": len(units), "unitKind": "record"}


def extract_txt(path: str) -> tuple[list[str], dict]:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    # Blank-line separated blocks are the closest thing a flat file has to units.
    units = [u for u in re.split(r"\n[ \t]*\n", text)] or [text]
    return units, {"kind": "text", "units": len(units), "unitKind": "block"}


def extract(path: str, sample_pages: int) -> tuple[list[str], dict]:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".epub":
        return extract_epub(path)
    if ext == ".pdf":
        return extract_pdf(path, sample_pages)
    if ext in (".jsonl", ".ndjson"):
        return extract_jsonl(path)
    return extract_txt(path)


# --------------------------------------------------------------------------------------
# Tokenisation helpers
# --------------------------------------------------------------------------------------
def _trim(token: str) -> str:
    return token.strip(_EDGE_TRIM)


def _is_letter(ch: str) -> bool:
    return ch.isalpha()


def strip_page_markers(units: list[str]) -> tuple[list[str], int]:
    """Remove PRINT-PAGE-CORRESPONDENCE markers ("... in her Page 4") before analysis.

    WHY: EPUBs that carry the print edition's pagination emit these inline, as a span in
    the text flow. That is a deliberate, standardised accessibility feature — not damage —
    but it welds a number into the middle of a sentence, which would otherwise trip the
    inline-furniture and truncation checks. The reference-clean Deathstalker EPUB has 653
    of them. They are still reported (a consumer MUST strip them), just not as corruption.

    The regularity test is what separates a page-list from a genuine cross-reference:
      * at least 10 markers, and at least one per two units — a page list covers the book;
      * the numbers run non-decreasing across >=90% of consecutive pairs — cross-references
        ("see page 42 ... see page 7") do not.
    Anything that fails the test is left in place and gets flagged by check 4.
    """
    joined = "\n".join(units)
    nums = [int(m.group(1)) for m in _PAGE_MARKER_NUM_RE.finditer(joined)]
    if len(nums) < 10 or len(nums) < 0.5 * max(1, len(units)):
        return units, 0
    pairs = list(zip(nums, nums[1:]))
    if not pairs:
        return units, 0
    monotone = sum(1 for a, b in pairs if b >= a) / len(pairs)
    if monotone < 0.90:
        return units, 0
    return [_PAGE_MARKER_NUM_RE.sub(" ", u) for u in units], len(nums)


def _script_of(ch: str) -> str:
    """Coarse script bucket from the Unicode name. Enough to spot a Cyrillic 'а' hiding in
    a Latin word without pulling in a Unicode script database."""
    if not ch.isalpha():
        return "other"
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return "other"
    for script in ("LATIN", "CYRILLIC", "GREEK", "HEBREW", "ARABIC", "CJK", "HANGUL",
                   "HIRAGANA", "KATAKANA", "DEVANAGARI"):
        if name.startswith(script) or f" {script} " in name:
            return script
    return "other"


# --------------------------------------------------------------------------------------
# The analysis
# --------------------------------------------------------------------------------------
class Finding:
    def __init__(self, check, severity, rate, detail, examples=None, extra=None):
        self.check = check
        self.severity = severity
        self.rate = rate
        self.detail = detail
        self.examples = examples or []
        self.extra = extra or {}

    def to_dict(self):
        d = {
            "check": self.check,
            "severity": self.severity,
            "rate": None if self.rate is None else round(self.rate, 6),
            "detail": self.detail,
        }
        if self.examples:
            d["examples"] = self.examples[:12]
        if self.extra:
            d.update(self.extra)
        return d


def _grade(rate, medium, high):
    if rate >= high:
        return SEV_HIGH
    if rate >= medium:
        return SEV_MEDIUM
    if rate > 0:
        return SEV_LOW
    return SEV_OK


def analyse(units: list[str], meta: dict) -> dict:
    kind = meta.get("kind", "text")
    # Three provenance classes, because the same measurement means different things:
    #   paginated  (pdf)   - line-break hyphens and running heads are properties of the
    #                        medium, not defects; the consumer strips them.
    #   reflowable (epub)  - a native ebook reflows, so ANY of that means the text was
    #                        derived from a fixed-layout original.
    #   unknown    (txt/jsonl) - provenance unknowable. A pairs file of PDF-derived blocks
    #                        legitimately carries hyphenation. So these findings are
    #                        reported but capped at MEDIUM: worth knowing, never a
    #                        unilateral "unusable".
    paginated = kind == "pdf"
    reflowable = kind == "epub"
    units, page_markers = strip_page_markers(units)
    text = "\n".join(units)
    n_chars = len(text)
    if n_chars == 0:
        return {
            "metrics": {"chars": 0},
            "findings": [Finding("emptiness", SEV_HIGH, 1.0, "no text could be extracted")],
        }

    lines = [ln.strip() for ln in text.split("\n")]
    nonempty_lines = [ln for ln in lines if ln]
    n_lines = max(1, len(nonempty_lines))

    raw_tokens = _TOKEN_RE.findall(text)
    tokens = [t for t in (_trim(x) for x in raw_tokens) if t]
    n_tokens = max(1, len(tokens))

    # ---- self-vocabulary: the book's own clean words. Used by check 1 (substitution
    # inference) and check 6 (missing-space confirmation), so that neither needs a
    # dictionary file and both stay deterministic on any machine.
    vocab = collections.Counter()
    for t in tokens:
        low = t.lower()
        if len(low) >= 2 and low.isalpha() and low.isascii():
            vocab[low] += 1
    # by_suffix[N] maps "the word with its first N characters removed" -> what those N
    # characters were. N=1 recovers a substituted capital ("%ritish" -> B); N=2 recovers a
    # substituted LIGATURE, which is the other half of this failure mode: an unmapped fi/fl
    # ligature glyph shows up as one symbol standing for two letters ("Áagship" = flagship,
    # "af¤rmative" = affirmative, "o≈cial" = official).
    by_suffix: dict[int, dict[str, collections.Counter]] = {
        1: collections.defaultdict(collections.Counter),
        2: collections.defaultdict(collections.Counter),
    }
    by_prefix2: dict[str, list[str]] = collections.defaultdict(list)
    for w, c in vocab.items():
        by_suffix[1][w[1:]][w[0]] += c
        if len(w) > 2:
            by_suffix[2][w[2:]][w[:2]] += c
        by_prefix2[w[:2]].append(w)

    def complete(prefix: str, suffix: str, max_gap: int = 2):
        """Find what single symbol stood in for, by asking the book's own vocabulary which
        1-2 characters fill the gap between `prefix` and `suffix`. Returns (fill, share)
        or None. This is the whole substitution-inference engine: no dictionary, no
        network, and it can only ever propose letters this book actually uses."""
        cands: collections.Counter = collections.Counter()
        if not prefix:
            for n in (1, 2):
                for fill, c in by_suffix[n].get(suffix, {}).items():
                    cands[fill] += c
        else:
            for w in by_prefix2.get(prefix[:2], ()):
                if len(w) <= len(prefix) + len(suffix):
                    continue
                gap = len(w) - len(prefix) - len(suffix)
                if 1 <= gap <= max_gap and w.startswith(prefix) and w.endswith(suffix):
                    cands[w[len(prefix):len(prefix) + gap]] += vocab[w]
        if not cands:
            return None
        (fill, cnt), = cands.most_common(1)
        total = sum(cands.values())
        # Demand a dominant completion: an ambiguous gap ("_at" -> bat/cat/hat) is no
        # evidence at all, so the winner must carry >=70% of the weight and be attested
        # at least twice (one occurrence could itself be a corrupted token).
        if cnt >= 2 and cnt / total >= 0.70:
            return fill, cnt / total
        return None

    findings: list[Finding] = []
    metrics: dict = {
        "chars": n_chars,
        "tokens": len(tokens),
        "lines": len(nonempty_lines),
        "units": len(units),
        "unitKind": meta.get("unitKind", "unit"),
    }
    metrics["printPageMarkers"] = page_markers
    if page_markers:
        findings.append(Finding(
            "print-page-markers", SEV_LOW, page_markers / max(1, len(units)),
            f"{page_markers} regular print-page-correspondence markers removed before "
            f"analysis — a standard EPUB feature, but STRIP THEM before using this text"))

    # ==================================================================================
    # CHECK 1 — broken glyph mapping
    # ==================================================================================
    # Two distinct signatures, detected differently.
    #
    # (a) WORD-INITIAL substitution ("%ritish", "0aiden", "-ohn"). A leading non-letter is
    #     usually just punctuation the tokenizer kept, so the position alone proves
    #     nothing. What proves it is the book's OWN vocabulary: strip the leading symbol
    #     and ask whether the remainder is a word this book uses. "said" in "—said" is;
    #     "ritish" in "%ritish" is not, but "british" is. So the test is:
    #         remainder unknown  AND  exactly one letter completes it into a known word
    #     which is simultaneously the detector AND the inference for the substitution
    #     table. Evidence-based, so it cannot fire on ordinary punctuation, and it needs
    #     no dictionary file.
    #
    # (b) WORD-INTERIOR symbols with letters on both sides ("D€ATHSTALK€R", "film·s").
    #     Restricted to characters outside _INTRAWORD_OK, i.e. ones a typesetter never
    #     puts inside a word. Identifier-shaped tokens are excluded wholesale.
    weld_hits: list[tuple[str, str, int]] = []  # (symbol, token, index)
    subst: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    subst_words: dict[str, set] = collections.defaultdict(set)

    for raw in raw_tokens:
        t = raw.rstrip(_EDGE_TRIM)  # trailing punctuation only: the lead char is evidence
        if len(t) < 4 or looks_like_identifier(t):
            continue
        letters = sum(1 for c in t if c.isalpha())
        if letters < 3:
            continue

        # --- (a) word-initial. The head may be a non-letter (%ritish, 0aiden, -ohn) or a
        # non-ASCII letter standing in for a ligature (Áagship = flagship), which is why
        # the test is "not an ASCII letter" rather than "not a letter".
        head, rest = t[0], t[1:]
        if not (head.isascii() and head.isalpha()) and head not in "'’‘\"“”([" \
                and head not in _PRESENTATION_LIGATURES \
                and rest.isalpha() and rest.isascii() and rest.islower() and len(rest) >= 3:
            low = rest.lower()
            # A remainder the book uses as a word on its own means the lead character
            # really was punctuation ("—said"). Frequency floor of 2 so that one corrupted
            # token cannot vouch for another.
            if vocab.get(low, 0) < 2:
                got = complete("", low)
                if got:
                    fill, _ = got
                    weld_hits.append((head, t, 0))
                    subst[head][fill.upper() if len(fill) == 1 else fill] += 1
                    subst_words[head].add(t)

        # --- (b) word-interior
        for i in range(1, len(t) - 1):
            ch = t[i]
            if ch.isalpha() or ch in _INTRAWORD_OK:
                continue
            if not (t[i - 1].isalpha() and t[i + 1].isalpha()):
                continue
            if ch in _PRESENTATION_LIGATURES:
                continue
            if ch.isdigit():
                # A digit between letters is normally a real token ("H2O", "postmanrings2x",
                # "MP3s"). Only treat it as a substituted capital when the word is long and
                # otherwise entirely alphabetic, which is the shape prose words have.
                if len(t) < 6 or letters < len(t) - 1:
                    continue
            weld_hits.append((ch, t, i))
            # Infer interior substitutions the same way: "af¤rmative" -> affirmative -> fi.
            low = t.lower()
            pre, suf = low[:i], low[i + 1:]
            if pre.isalpha() and suf.isalpha() and pre.isascii() and suf.isascii():
                got = complete(pre, suf)
                if got:
                    fill, _ = got
                    subst[ch][fill] += 1
                    subst_words[ch].add(t)

    weld_rate = len(weld_hits) / n_tokens
    metrics["weldedSymbolRate"] = round(weld_rate, 6)
    inferred = {}
    for sym, ctr in subst.items():
        (letter, cnt), = ctr.most_common(1)
        total = sum(ctr.values())
        # Only report a mapping that is itself consistent (one symbol, one letter) and
        # attested by at least 2 distinct words — one word could be a coincidence.
        if cnt / total >= 0.80 and len(subst_words[sym]) >= 2:
            inferred[sym] = {"letter": letter, "occurrences": cnt,
                             "words": sorted(subst_words[sym])[:6]}
    systematic = len(inferred) >= GLYPH_SUBST_SYMBOLS_FOR_HIGH

    sev = _grade(weld_rate, GLYPH_WELD_MEDIUM, GLYPH_WELD_HIGH)
    if systematic:
        sev = SEV_HIGH
    if weld_hits:
        ex = [t for _, t, _ in weld_hits]
        common = [w for w, _ in collections.Counter(ex).most_common(10)]
        extra = {}
        if inferred:
            extra["substitutionTable"] = {
                s: f"{v['letter']} (x{v['occurrences']})" for s, v in sorted(inferred.items())
            }
            extra["substitutionEvidence"] = {s: v["words"] for s, v in sorted(inferred.items())}
        detail = f"{len(weld_hits)} welded symbols in {n_tokens} word tokens"
        if systematic:
            detail += (f"; SYSTEMATIC one-to-one glyph substitution over {len(inferred)}"
                       f" symbols — the text layer's character map is wrong")
        findings.append(Finding("glyph-mapping", sev, weld_rate, detail, common, extra))
    else:
        findings.append(Finding("glyph-mapping", SEV_OK, 0.0, "no welded symbols"))

    lig = sum(1 for c in text if c in _PRESENTATION_LIGATURES)
    lig_rate = lig / n_chars
    metrics["presentationLigatureRate"] = round(lig_rate, 8)
    if lig:
        # Never worse than LOW: the text is correct, it just needs normalizing. Reported
        # because an unnormalized ligature costs ~2 spurious character errors every time
        # it is compared against OCR output.
        findings.append(Finding(
            "presentation-ligatures", SEV_LOW, lig_rate,
            f"{lig} Unicode presentation ligatures (U+FB00-FB06) — correctly encoded, but "
            f"apply NFKC before comparing this text against OCR output"))

    # Control characters and Private Use Area codepoints — the other CMap tells.
    # Form feed is excluded: it is a legitimate page separator in plain-text corpora.
    ctrl = collections.Counter(
        c for c in text if (ord(c) < 32 and c not in "\n\t\r\f") or 0x7F <= ord(c) < 0xA0
    )
    ctrl_rate = sum(ctrl.values()) / n_chars
    metrics["controlCharRate"] = round(ctrl_rate, 8)
    if ctrl:
        findings.append(Finding(
            "control-chars", _grade(ctrl_rate, CTRL_CHAR_MEDIUM, CTRL_CHAR_HIGH), ctrl_rate,
            f"{sum(ctrl.values())} control characters in {n_chars} chars",
            [f"U+{ord(c):04X} x{n}" for c, n in ctrl.most_common(8)]))

    pua = pua_in_word = 0
    for i, c in enumerate(text):
        o = ord(c)
        if 0xE000 <= o <= 0xF8FF or 0xF0000 <= o <= 0x10FFFD:
            pua += 1
            # Adjacent to a letter => the TEXT font is unmapped. Alone on a line => an
            # icon font, which leaves the prose intact. See PUA_MEDIUM for the measurement.
            if (i and text[i - 1].isalpha()) or (i + 1 < n_chars and text[i + 1].isalpha()):
                pua_in_word += 1
    pua_rate = pua / n_chars
    pua_word_rate = pua_in_word / n_chars
    metrics["puaRate"] = round(pua_rate, 8)
    metrics["puaInWordRate"] = round(pua_word_rate, 8)
    if pua:
        sev = _grade(pua_word_rate, PUA_MEDIUM, PUA_HIGH)
        if pua_in_word == 0:
            sev = SEV_LOW  # icon font only; the prose is untouched
        findings.append(Finding("private-use-area", sev, pua_word_rate,
                                f"{pua} Private Use Area codepoints, {pua_in_word} of them "
                                f"adjacent to letters"
                                + (" — the text font is reporting glyph ids, not characters"
                                   if pua_in_word else
                                   " — isolated, consistent with an embedded icon font "
                                   "rather than damaged prose")))

    # ==================================================================================
    # CHECK 2 — mojibake
    # ==================================================================================
    moji = _MOJIBAKE_RE.findall(text)
    moji_rate = len(moji) / n_chars
    metrics["mojibakeRate"] = round(moji_rate, 8)
    if moji:
        ctx = []
        for m in _MOJIBAKE_RE.finditer(text):
            s = max(0, m.start() - 12)
            ctx.append(text[s:m.end() + 12].replace("\n", " "))
            if len(ctx) >= 6:
                break
        findings.append(Finding("mojibake", _grade(moji_rate, MOJIBAKE_MEDIUM, MOJIBAKE_HIGH),
                                moji_rate,
                                f"{len(moji)} UTF-8-as-Latin-1 sequences", ctx))
    repl = text.count("�")
    repl_rate = repl / n_chars
    metrics["replacementCharRate"] = round(repl_rate, 8)
    if repl:
        findings.append(Finding("replacement-chars",
                                _grade(repl_rate, REPLACEMENT_MEDIUM, REPLACEMENT_HIGH),
                                repl_rate,
                                f"{repl} U+FFFD replacement characters — bytes were already "
                                f"undecodable when this text was made"))

    # ==================================================================================
    # CHECK 3 — line-break hyphenation
    # ==================================================================================
    hyph_nl = _HYPHEN_SPLIT_RE.findall(text)
    hyph_sp = _HYPHEN_SPACE_RE.findall(text)
    n_words = max(1, len(tokens))
    hyph_per1k = (len(hyph_nl) + len(hyph_sp)) * 1000.0 / n_words
    metrics["hyphenSplitsPer1kWords"] = round(hyph_per1k, 3)
    if hyph_nl or hyph_sp:
        ex = [f"{a}- {b}" for a, b in (hyph_nl + hyph_sp)[:10]]
        if paginated:
            # Expected for any typeset page, and fully repairable by a de-hyphenation
            # pass, so it never reaches HIGH for a paginated source — the worst it can say
            # is "do not use this raw".
            sev = SEV_MEDIUM if hyph_per1k >= HYPHEN_PDF_HIGH_PER1K else SEV_LOW
            detail = (f"{len(hyph_nl) + len(hyph_sp)} line-break hyphen splits "
                      f"({hyph_per1k:.1f}/1k words) — normal for a paginated source, but the "
                      f"consumer MUST de-hyphenate")
        else:
            sev = _grade(hyph_per1k, HYPHEN_EBOOK_MEDIUM_PER1K, HYPHEN_EBOOK_HIGH_PER1K)
            if not reflowable:
                sev = min(sev, SEV_MEDIUM, key=lambda x: _SEV_RANK[x])
            where = ("a reflowable source — this text was derived from a fixed-layout "
                     "original" if reflowable else
                     "a source of unknown provenance — de-hyphenate before use")
            detail = (f"{len(hyph_nl) + len(hyph_sp)} line-break hyphen splits "
                      f"({hyph_per1k:.2f}/1k words) in {where}")
        findings.append(Finding("hyphenation", sev, hyph_per1k / 1000.0, detail, ex))

    # ==================================================================================
    # CHECK 4 — page furniture
    # ==================================================================================
    # Running head = a short line repeated across many units. Folio = a line that is only a
    # page number. Both are counted as separate lines AND, separately, where they appear
    # welded into a prose line.
    short_lines = collections.Counter(ln for ln in nonempty_lines if 2 <= len(ln) <= 60)
    repeat_floor = max(3, int(0.30 * len(units)))  # a real running head appears on most units
    running_heads = {
        ln for ln, c in short_lines.items()
        if c >= repeat_floor and not ln.endswith((".", "!", "?", ";"))
    }
    folios = [ln for ln in nonempty_lines if _FOLIO_RE.match(ln)]
    furniture_lines = sum(1 for ln in nonempty_lines if ln in running_heads) + len(folios)
    furniture_rate = furniture_lines / n_lines
    metrics["furnitureLineRate"] = round(furniture_rate, 5)

    # Inline furniture: a page marker inside prose, or a running head welded into a line
    # that also carries a sentence.
    # Inline furniture is deliberately NARROW, because a loose version produces real false
    # positives: Bonhoeffer's "Ethics" has "Ethics" as its running head, and a substring
    # match flagged 66 ordinary sentences that merely use the word. So a welded running
    # head must be (i) at least 10 characters and 2 words — a one-word common noun cannot
    # be told from prose; (ii) anchored at the START or END of the line, which is where a
    # head or folio actually collides with the text; and (iii) not continue into a word
    # ("Richard J Evans" inside "Richard J Evans's new book" is prose, not furniture).
    weldable = [h for h in running_heads if len(h) >= 10 and len(h.split()) >= 2]
    inline_hits = []
    for ln in nonempty_lines:
        if len(ln) < 40:
            continue
        for m in _PAGE_MARKER_RE.finditer(ln):
            inline_hits.append(ln[max(0, m.start() - 25):m.end() + 25])
            break
        else:
            for head in weldable:
                if ln == head:
                    continue
                if ln.startswith(head):
                    nxt = ln[len(head):len(head) + 1]
                elif ln.endswith(head):
                    nxt = ""
                else:
                    continue
                if nxt and (nxt.isalpha() or nxt in "'’-"):
                    continue  # the head is the start of a longer real word/possessive
                inline_hits.append(ln[:90])
                break
    inline_rate = len(inline_hits) / n_lines
    metrics["furnitureInlineRate"] = round(inline_rate, 6)

    if furniture_lines or inline_hits:
        if paginated:
            sev = _grade(inline_rate, FURNITURE_INLINE_MEDIUM, FURNITURE_INLINE_HIGH)
            detail = (f"{furniture_lines} furniture lines ({furniture_rate:.1%} of lines; "
                      f"expected in a paginated source and droppable), "
                      f"{len(inline_hits)} welded into prose lines")
        else:
            sev = max(
                _grade(furniture_rate, FURNITURE_EBOOK_MEDIUM, FURNITURE_EBOOK_HIGH),
                _grade(inline_rate, FURNITURE_INLINE_MEDIUM, FURNITURE_INLINE_HIGH),
                key=lambda s: _SEV_RANK[s],
            )
            if not reflowable:
                sev = min(sev, SEV_MEDIUM, key=lambda x: _SEV_RANK[x])
            where = ("reflowable source — this text came from a paginated original"
                     if reflowable else "source of unknown provenance")
            detail = (f"{furniture_lines} page-furniture lines ({furniture_rate:.1%}) in a "
                      f"{where}, {len(inline_hits)} welded into prose")
        ex = sorted(running_heads, key=lambda s: -short_lines[s])[:5] + inline_hits[:4]
        findings.append(Finding("page-furniture", sev, inline_rate, detail, ex,
                                {"runningHeads": sorted(running_heads,
                                                        key=lambda s: -short_lines[s])[:8],
                                 "folioLines": len(folios)}))

    # ==================================================================================
    # CHECK 5 — word-per-line fragmentation
    # ==================================================================================
    # A raw "share of short lines" is NOT usable on its own — measured, it flags title
    # pages, verse, interview transcripts and language-course books, which legitimately
    # have short lines. The Deathstalker signature is specifically a short line BROKEN
    # MID-SENTENCE: no terminal punctuation, and the next line resumes in lowercase
    # ("according | to the | sensors, very"). Measured on the same four books, the sharper
    # metric keeps Deathstalker at 0.306 while the Deliverance Handbook (a false positive
    # at 0.511 on the raw metric) drops to 0.008.
    words_per_line = [len(ln.split()) for ln in nonempty_lines]
    short_share = sum(1 for w in words_per_line if w <= 2) / n_lines
    mean_wpl = sum(words_per_line) / n_lines
    broken = []
    for i, ln in enumerate(nonempty_lines[:-1]):
        if len(ln.split()) <= 3 and ln[-1] not in '.!?:;”"’\'' \
                and nonempty_lines[i + 1][:1].islower():
            broken.append(ln)
    broken_share = len(broken) / n_lines
    metrics["shortLineShare"] = round(short_share, 4)
    metrics["brokenShortLineShare"] = round(broken_share, 4)
    metrics["meanWordsPerLine"] = round(mean_wpl, 2)
    if paginated:
        sev = _grade(broken_share, FRAGMENT_SHORT_LINE_MEDIUM, FRAGMENT_SHORT_LINE_HIGH)
        if sev != SEV_OK:
            findings.append(Finding(
                "fragmentation", sev, broken_share,
                f"{broken_share:.1%} of lines are <=3 words broken mid-sentence "
                f"({short_share:.1%} short lines overall, mean {mean_wpl:.1f} words/line) "
                f"— the segmenter is breaking lines at inter-word gaps", broken[:10]))

    # ==================================================================================
    # CHECK 6 — spacing damage
    # ==================================================================================
    # A missing space is only claimed when the long run splits into two words that BOTH
    # appear elsewhere in this same book, and both are >=4 letters (shorter halves make
    # spurious splits trivial). Frequency floor of 2 keeps a single corrupted token from
    # validating another.
    missing = []
    for t in tokens:
        low = t.lower()
        if len(low) < 18 or not low.isalpha() or not low.isascii():
            continue
        for cut in range(4, len(low) - 3):
            if vocab.get(low[:cut], 0) >= 2 and vocab.get(low[cut:], 0) >= 2:
                missing.append(f"{t} = {low[:cut]}|{low[cut:]}")
                break
    missing_rate = len(missing) / n_tokens
    metrics["missingSpaceRate"] = round(missing_rate, 6)
    if missing:
        findings.append(Finding("missing-spaces",
                                _grade(missing_rate, MISSING_SPACE_MEDIUM, MISSING_SPACE_HIGH),
                                missing_rate,
                                f"{len(missing)} words that split cleanly into two words the "
                                f"book uses elsewhere", missing[:10]))

    double_spaces = len(re.findall(r"[^\s]  +[^\s]", text))
    double_rate = double_spaces / n_tokens
    metrics["doubleSpaceRate"] = round(double_rate, 5)
    if double_rate >= DOUBLE_SPACE_NOTE:
        findings.append(Finding("erratic-spacing", SEV_LOW, double_rate,
                                f"{double_spaces} multi-space gaps ({double_rate:.1%} of "
                                f"tokens) — cosmetic, a normalizer fixes it"))

    # ==================================================================================
    # CHECK 7 — character-class anomalies
    # ==================================================================================
    interior_junk = 0
    interior_total = 0
    mixed_script_words = []
    for t in tokens:
        if len(t) < 3 or looks_like_identifier(t):
            continue
        core = t[1:-1]
        if not core:
            continue
        interior_total += len(core)
        interior_junk += sum(
            1 for c in core
            if not (c.isalpha() or c.isdigit() or c in _INTRAWORD_OK)
        )
        scripts = {s for s in (_script_of(c) for c in t if c.isalpha()) if s != "other"}
        if len(scripts) > 1:
            mixed_script_words.append(t)
    junk_rate = interior_junk / max(1, interior_total)
    metrics["wordInteriorJunkRate"] = round(junk_rate, 6)
    if interior_junk:
        findings.append(Finding("word-interior-junk",
                                _grade(junk_rate, WORD_INTERIOR_JUNK_MEDIUM,
                                       WORD_INTERIOR_JUNK_HIGH),
                                junk_rate,
                                f"{interior_junk} non-letter characters inside word interiors "
                                f"({junk_rate:.2%} of interior characters)"))
    mixed_rate = len(mixed_script_words) / n_tokens
    metrics["mixedScriptRate"] = round(mixed_rate, 6)
    if mixed_script_words:
        findings.append(Finding("mixed-script",
                                _grade(mixed_rate, MIXED_SCRIPT_MEDIUM, MIXED_SCRIPT_HIGH),
                                mixed_rate,
                                f"{len(mixed_script_words)} words mixing two scripts "
                                f"(homoglyph substitution)",
                                [w for w, _ in
                                 collections.Counter(mixed_script_words).most_common(8)]))

    # ==================================================================================
    # CHECK 8 — language plausibility
    # ==================================================================================
    lower_tokens = [t.lower() for t in tokens if t.isalpha()]
    scores = {}
    if lower_tokens:
        counted = collections.Counter(lower_tokens)
        total = sum(counted.values())
        for lang, stops in STOPSETS.items():
            scores[lang] = sum(c for w, c in counted.items() if w in stops) / total
    best_lang, best_score = ("?", 0.0)
    if scores:
        best_lang, best_score = max(scores.items(), key=lambda kv: kv[1])
    metrics["language"] = best_lang
    metrics["stopwordShare"] = round(best_score, 4)
    declared = meta.get("declaredLanguage")
    if declared:
        metrics["declaredLanguage"] = declared
    if best_score < STOPWORD_MEDIUM:
        sev = SEV_HIGH if best_score < STOPWORD_HIGH else SEV_MEDIUM
        findings.append(Finding(
            "language-plausibility", sev, best_score,
            f"best-matching language '{best_lang}' accounts for only {best_score:.1%} of "
            f"tokens (real prose runs 25-40% here) — either the text is damaged, or it is "
            f"in a language outside the checked set "
            f"({'/'.join(sorted(STOPSETS))}); it cannot be verified either way"))
    elif declared and declared[:2].lower() in STOPSETS and declared[:2].lower() != best_lang:
        findings.append(Finding(
            "language-plausibility", SEV_LOW, best_score,
            f"declared '{declared}' but reads as '{best_lang}' ({best_score:.1%} stopwords)"))

    # ==================================================================================
    # CHECK 9 — truncation / emptiness
    # ==================================================================================
    real_units = [u.strip() for u in units]
    empty_units = sum(1 for u in real_units if len(u) < 40)
    empty_rate = empty_units / max(1, len(real_units))
    metrics["emptyUnitRate"] = round(empty_rate, 4)
    if empty_units:
        findings.append(Finding("empty-units", _grade(empty_rate, EMPTY_UNIT_MEDIUM,
                                                      EMPTY_UNIT_HIGH), empty_rate,
                                f"{empty_units}/{len(real_units)} {meta.get('unitKind','unit')}s "
                                f"hold under 40 characters"))

    # Truncation only means something for a unit that is supposed to be a self-contained
    # chunk of prose (a spine item, a JSONL record). A PDF PAGE ends mid-sentence by
    # definition — that is what pagination is — so the check is skipped for paginated
    # sources rather than reporting a ~70% "truncation rate" on every book in the corpus.
    # Only EPUBs have chapters. A PDF page ends mid-sentence by definition, and JSONL
    # records are independent extractions with no "next unit" that could continue them —
    # running the check there produced a 36% "truncation" rate on a perfectly ordinary
    # OCR-pairs file. So it is scoped to reflowable sources, where spine items really are
    # consecutive prose.
    substantial_idx = [i for i, u in enumerate(real_units) if len(u) >= 200] \
        if reflowable else []
    mid_sentence, lost = [], []
    for i in substantial_idx:
        u = real_units[i].rstrip()
        if u[-1:] in '.!?"”’)—:':
            continue
        mid_sentence.append(u)
        nxt = real_units[i + 1].lstrip() if i + 1 < len(real_units) else ""
        # A chunked ebook splits mid-paragraph and the next unit resumes in lowercase.
        # A unit that stops mid-clause and is followed by a fresh sentence lost its tail.
        if not nxt[:1].islower():
            lost.append((u[-60:], nxt[:40]))
    n_sub = max(1, len(substantial_idx))
    metrics["midSentenceEndRate"] = round(len(mid_sentence) / n_sub, 4)
    trunc_rate = len(lost) / n_sub
    metrics["lostContinuationRate"] = round(trunc_rate, 4)
    if substantial_idx and trunc_rate >= TRUNCATION_MEDIUM:
        findings.append(Finding("truncation",
                                SEV_HIGH if trunc_rate >= TRUNCATION_HIGH else SEV_MEDIUM,
                                trunc_rate,
                                f"{len(lost)}/{n_sub} {meta.get('unitKind','unit')}s stop "
                                f"mid-sentence and are not continued by the next one",
                                [f"...{a} || {b}..." for a, b in lost[:5]]))

    if paginated:
        cpp = n_chars / max(1, meta.get("sampledPages", len(units)))
        metrics["charsPerSampledPage"] = round(cpp, 1)
        if cpp < MIN_CHARS_PER_PAGE:
            findings.append(Finding("emptiness", SEV_HIGH, cpp,
                                    f"{cpp:.0f} chars per sampled page — there is effectively "
                                    f"no text layer here"))

    return {"metrics": metrics, "findings": findings}


def check_path(path: str, sample_pages: int) -> dict:
    rec: dict = {"path": path, "name": os.path.basename(path)}
    try:
        units, meta = extract(path, sample_pages)
    except Exception as exc:  # unreadable file -> that is itself the verdict
        rec.update({"verdict": "unusable", "error": f"{type(exc).__name__}: {exc}",
                    "findings": [], "metrics": {}})
        return rec
    result = analyse(units, meta)
    findings = result["findings"]
    worst = SEV_OK
    for f in findings:
        if _SEV_RANK[f.severity] > _SEV_RANK[worst]:
            worst = f.severity
    rec.update({
        "source": meta,
        "metrics": result["metrics"],
        "findings": [f.to_dict() for f in findings if f.severity != SEV_OK],
        "worstSeverity": worst,
        "verdict": _VERDICT_FOR_SEV[worst],
    })
    return rec


# --------------------------------------------------------------------------------------
# Input collection
# --------------------------------------------------------------------------------------
SUPPORTED = (".epub", ".pdf", ".txt", ".text", ".jsonl", ".ndjson")


def collect(paths: list[str]) -> list[str]:
    out: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = sorted(d for d in dirs if not d.startswith("."))
                for f in sorted(files):
                    if f.lower().endswith(SUPPORTED) and not f.startswith("."):
                        out.append(os.path.join(root, f))
        elif os.path.isfile(p):
            out.append(p)
        else:
            print(f"warning: no such path: {p}", file=sys.stderr)
    return out


def paths_from_file(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return [ln.strip() for ln in raw.splitlines() if ln.strip() and not ln.startswith("#")]

    def harvest(node):
        if isinstance(node, str):
            return [node] if os.path.splitext(node)[1].lower() in SUPPORTED else []
        if isinstance(node, dict):
            if isinstance(node.get("path"), str):
                return [node["path"]]
            found = []
            for v in node.values():
                found.extend(harvest(v))
            return found
        if isinstance(node, list):
            found = []
            for v in node:
                found.extend(harvest(v))
            return found
        return []

    seen, ordered = set(), []
    for p in harvest(data):
        if p not in seen:
            seen.add(p)
            ordered.append(p)
    return ordered


# --------------------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------------------
_SEV_TAG = {SEV_LOW: "note", SEV_MEDIUM: "WARN", SEV_HIGH: "FAIL"}


def print_record(rec: dict, verbose: bool):
    v = rec["verdict"]
    print(f"\n{v.upper():9s} {rec['name']}")
    if rec.get("error"):
        print(f"          error: {rec['error']}")
        return
    m = rec.get("metrics", {})
    src = rec.get("source", {})
    bits = [f"{src.get('kind','?')}"]
    if src.get("pageCount"):
        bits.append(f"{src['pageCount']}pp ({src.get('sampledPages')} sampled)")
    bits.append(f"{m.get('chars',0):,} chars")
    bits.append(f"{m.get('tokens',0):,} words")
    bits.append(f"lang={m.get('language','?')} ({m.get('stopwordShare',0):.0%})")
    print("          " + " | ".join(bits))
    for f in rec.get("findings", []):
        if f["severity"] == SEV_LOW and not verbose:
            continue
        print(f"          [{_SEV_TAG[f['severity']]}] {f['check']}: {f['detail']}")
        if f.get("substitutionTable"):
            table = ", ".join(f"{k!r}->{val}" for k, val in f["substitutionTable"].items())
            print(f"                 substitutions: {table}")
        for ex in f.get("examples", [])[:5]:
            print(f"                 e.g. {ex!r}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Deterministic text-layer quality checker for corpus gating.")
    ap.add_argument("paths", nargs="*", help=".epub / .pdf / .txt / .jsonl / directory")
    ap.add_argument("--paths-from", help="JSON or newline-delimited file listing inputs")
    ap.add_argument("--json", dest="json_out", help="write the full report here")
    ap.add_argument("--quiet", action="store_true",
                    help="print only the verdict counts; exit code is the gate")
    ap.add_argument("--verbose", action="store_true", help="include low-severity findings")
    ap.add_argument("--sample-pages", type=int, default=DEFAULT_PDF_SAMPLE_PAGES,
                    help=f"pages sampled per PDF (default {DEFAULT_PDF_SAMPLE_PAGES})")
    ap.add_argument("--limit", type=int, default=0, help="stop after N inputs (debugging)")
    args = ap.parse_args(argv)

    inputs = collect(args.paths)
    if args.paths_from:
        inputs.extend(paths_from_file(args.paths_from))
    seen, ordered = set(), []
    for p in inputs:
        if p not in seen:
            seen.add(p)
            ordered.append(p)
    if args.limit:
        ordered = ordered[:args.limit]
    if not ordered:
        print("error: no inputs", file=sys.stderr)
        return 3

    records = []
    for i, p in enumerate(ordered, 1):
        if not args.quiet and len(ordered) > 1:
            print(f"[{i}/{len(ordered)}] {os.path.basename(p)}", file=sys.stderr)
        rec = check_path(p, args.sample_pages)
        records.append(rec)
        if not args.quiet:
            print_record(rec, args.verbose)

    counts = collections.Counter(r["verdict"] for r in records)
    if args.json_out:
        os.makedirs(os.path.dirname(os.path.abspath(args.json_out)) or ".", exist_ok=True)
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump({"generated": __file__, "counts": dict(counts), "books": records},
                      fh, indent=1, ensure_ascii=False)

    print(f"\n{'=' * 70}")
    print(f"clean={counts.get('clean',0)}  suspect={counts.get('suspect',0)}  "
          f"unusable={counts.get('unusable',0)}   (n={len(records)})")

    if counts.get("unusable"):
        return 2
    if counts.get("suspect"):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
