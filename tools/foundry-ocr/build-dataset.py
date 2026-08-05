#!/usr/bin/env python3
"""
build-dataset — assemble foundry-ocr's SFT split from the band pipeline's own
aligner output, at either of two UNITS: one Tesseract line, or a sentence.

    python3 tools/foundry-ocr/build-dataset.py \
        [--lab /Volumes/Callisto/training/ocr-lab] \
        [--unit line|sentence] [--cap 400] \
        [--out /Volumes/Callisto/training/rubric/galley/sft-{line,sent}] \
        [--identity-share 0.5] [--sim-floor 0.75] [--max-cer 0.30] \
        [--include-quarantined] [--dry-run]

Input  : <lab>/<book>/scores/epub-align-pairs.json, one file per book, written by
         tools/ocr-lab/align-epub.py. Rows are {line, page, ocr, truth, sim, cer,
         cerCaseFolded}.
Output : <out>/{train,eval}.jsonl  — chat JSONL, the exact shape the rig's
         `text_sft` trainer consumed for dagger_v1
         <out>/pairs-repaired.jsonl — LINE mode: the repaired pairs, so a
         different target format (e.g. the block model's edit list) can be built
         without re-deriving the repairs
         <out>/units.jsonl — SENTENCE mode: every packed unit, before the
         downsample, tagged with its split and its drop reason. The same job one
         scale up, and the base an identity-share sweep re-derives from
         <out>/eval-parity-1k.jsonl — SENTENCE mode: a balanced 500/500 slice
         <out>/build-stats.json

THIS IS THE LINE MODEL, NOT THE BLOCK MODEL. `tools/foundry-ocr/build-corpus.mjs`
builds a different corpus for a different unit (one OCR *block*, target = an
edit list under the tools/foundry-ocr/edits.mjs contract). This one is the unit
docs/OCR_LAB.md's pipeline actually has a slot for — one band, one Tesseract
--psm 7 line, corrected in place, upstream of block grouping. The two do not
share an output directory and neither overwrites the other. Which one ships is
an OPEN QUESTION for the owner; see tools/foundry-ocr/README.md.

────────────────────────────────────────────────────────────────────────────────
WHAT THIS FILE IS MOSTLY ABOUT: THE TRUTH LIES, AND IT LIES SYSTEMATICALLY
────────────────────────────────────────────────────────────────────────────────

Take the pairs as the aligner writes them and the biggest thing ocr learns is
not OCR repair. On michelle-remembers, 56.8% of pairs are non-identity and **48%
of those differ from the truth by nothing but a trailing punctuation mark** —
the OCR reads `...called the Devil.` and the truth reads `...called the Devil`.
One-directional: thousands of rows where the truth dropped punctuation, ZERO
where it added any. That is not an OCR error. It is the aligner emitting a truth
span of matched WORDS and losing the punctuation attached to the last one.

Train on it and ocr learns to delete the final period of every line it sees.
The downstream consumer is TTS, whose sentence boundaries are those periods.
That single artifact would have been the model's largest learned behaviour, and
it is invisible in any aggregate CER.

It is not the only one. Each of these was found by reading the data, is measured,
and has its own rung in the ladder below — with the count printed on every run,
so the day the aligner is fixed the rung reads zero and can be deleted:

  edge punctuation lost   thousands  `does."` -> `does`, and the same at the left
                                     edge on an opening quote. 424 of them sit on
                                     a word that ALSO has a real OCR error
                                     (`"Tt could` -> `It could`), so the match
                                     has to be fuzzy or those rows teach the
                                     model to delete a quote while fixing a letter.
  whole edge words lost   1,320 on   `ture in Adrienne's` -> `in Adrienne's`.
                          one book   The truth window simply starts a word late.
  edge words EXTENDED     32% of     `neede` -> `needed`, `murs` -> `Murmurs`.
                          edit rows  The BAND CROPPER clipped the line and the
                                     truth still has the characters. Clamped, not
                                     learned: a model that completes a clipped
                                     edge cannot tell a clipped line from a line
                                     that ends there, so it fires on correct text.
  wrap-hyphen joins       3.9% of    see below — the hallucination case.
                          lines
  small caps              hundreds   `APPENDICES` -> `appendices`. CSS sets the
                                     case; the page reads capitals. Tesseract is
                                     RIGHT and the truth is wrong.
  typography              hundreds   `. . .` -> `...`, curly quotes, `∗` vs `*`.
                                     A preference, not a recognition error. §10d
                                     of docs/BLOCKS_TRAINING.md measured that
                                     training on these builds a Unicode
                                     normaliser instead of an OCR repairer.
  welded words            2,387      `on the mission` -> `onthe mission`. The
                                     DIRECTION is the whole rule: fewer spaces in
                                     the truth is the truth lying, more spaces is
                                     the scanner welding (`Iam` -> `I am`) and is
                                     a real error that must survive.
  truth `1` for `I`       45         The EPUB's own OCR damage. Left alone it
                                     trains the l/1/I confusion BACKWARDS.
  CMap damage             574        `Different` arriving as `Di#erent`. Cannot
                                     be repaired, only refused — §12c's broken
                                     ToUnicode CMaps, one scale down.

Every repairable one is repaired the same way and for the same reason: **the OCR
is right, so the correct target is the OCR**, and the row becomes an identity
example. That is not a new policy — build-corpus.mjs already inverts
folding-equal pairs to identity for the block corpus. This applies it to the
artifacts a LINE-level aligner produces.

THE REAL FIX FOR MOST OF THESE IS UPSTREAM, in align-epub.py's truth-span
extraction and in the band cropper's right margin. Repairing them here is a
workaround that lets training proceed; it is not a reason to leave them.

────────────────────────────────────────────────────────────────────────────────
THE HYPHEN FAMILY — the only place a line model can be taught to hallucinate
────────────────────────────────────────────────────────────────────────────────

3.9% of lines end in a wrap hyphen, and the aligner writes the JOINED word into
the truth of BOTH lines:

    ocr   "The reader is invited upon an extraordi-"
    truth "The reader is invited upon an extraordinary"       <- next line's half
    ocr   "nary journey, into the memory and soul of"
    truth "extraordinary journey, into the memory and soul of" <- prev line's half

A line model cannot see the other line. Trained on this it learns to invent the
completion of every hyphenated word — the one failure mode that ships invented
prose into a finished audiobook.

They are REPAIRED rather than dropped, because they carry a lesson worth
thousands of rows: *leave the wrap hyphen alone*. The repair is evidence-gated
exactly the way the dagger applier is — the truth's joined word must actually
begin (or end) with the OCR's own fragment, or the row is dropped rather than
guessed at. Healing the hyphen is the block assembler's job downstream (§12g
measured wrap hyphens in 17.1% of blocks), not the line model's, and the system
prompt says so in as many words.

────────────────────────────────────────────────────────────────────────────────
--unit sentence — THE SAME LADDER, ONE UNIT UP
────────────────────────────────────────────────────────────────────────────────

`--unit sentence` packs the SAME repaired line pairs into sentence-sized units
with tools/foundry-ocr/sentences.py, which mirrors foundry `src/ocr/sentences.ts`
and is imported, never forked: a training unit and a serving unit that drift
apart is the whole failure this exists to prevent. One file and one flag, so the
two corpora provably share a repair ladder — that is the point of extending this
builder rather than writing a second one.

THE ORDER OF OPERATIONS IS THE WHOLE DESIGN (docs/OCR_SENTENCE_CORPUS_SURVEY.md
§5b). `train.jsonl` cannot be re-unitised after the fact: the identity
downsample shreds line contiguity, and the measurement says so — mean
consecutive run 1.28 lines in train against 33.6 in the raw aligner output, so
packing the shipped train file yields 1.3-line "sentences". So:

    raw pairs (contiguous)
      -> per-line repair ladder + per-line gates        (collect_pairs, shared)
      -> holdout split, German slice carve              (LINE level, so no unit
                                                         straddles a boundary)
      -> PACK                                           (sentences.py build/pack/join)
      -> per-UNIT gates, thresholds re-derived          (train only — see below)
      -> identity downsample AT UNIT LEVEL, per-book caps
      -> emit

THE PER-LINE GATES STAY. §5e says the line thresholds do not transfer, and they
do not — but they are gates on the ALIGNER's window, which is a per-line object.
A line whose truth window is 40% wrong is still 40% wrong after it is buried
inside 300 correct characters, where a unit-level gate can no longer see it.
Both scales gate; the unit scale gets its own numbers.

THE UNIT THRESHOLDS ARE THE LINE THRESHOLDS' PERCENTILES, not their values.
`--sim-floor 0.75` was the 1st percentile of line `sim`; on a 400-character unit
0.75 is a hundred differing characters and means something else entirely. So the
builder measures where each line threshold SITS in the pre-gate line
distribution and takes that same percentile of the unit distribution. Printed on
every run and recorded in build-stats.json, with the histograms it read them off.

THE UNIT GATES SHAPE TRAIN ONLY. The same reason the identity downsample does
(see "identity discipline" below): eval's mix IS the baseline, and
`sft-sent/eval.jsonl` has one more obligation — it must cover EXACTLY the
characters `sft-line/eval.jsonl` covers, or the line-vs-sentence comparison is
between two different books. That is asserted against the shipped file, not
assumed. The count of eval units the train gates WOULD have dropped is printed,
so nothing hides.
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict

# ── the split is law ────────────────────────────────────────────────────────
#
# Held out BY BOOK, named explicitly rather than sampled, so a rebuild is the
# same split. One fiction and one nonfiction, per docs/OCR_LAB.md "Rules that
# must not regress". A page-level split leaks: the same running heads, the same
# scanner, the same typeface on both sides, and the model scores well by
# recognising a book.
HOLDOUT_BOOKS = [
    # fiction. Tier 2, 1990s SF paperback. NOT deathstalker 1 — that was the
    # CALIBRATION book the band pipeline's thresholds were developed against, so
    # it has to stay in train; holding it out would measure the pipeline's own
    # tuning rather than the model's generalisation.
    'deathstalker-coda',
    # nonfiction. Tier 1 truth (publisher EPUB) over a BAD IA scan, which is the
    # point: high error density makes it an informative eval, and it is the only
    # large book the pipeline was never tuned on.
    'michelle-remembers',
]

# Excluded from TRAIN this round pending the owner's review of their boxed-text
# damage report. docs/OCR_LAB.md open fix #2: ruled boxes defeat the projection
# profiler and the What-to-Expect sidebars hit it constantly, so their pairs may
# be aligned against text the bands never captured cleanly. --include-quarantined
# opts back in, deliberately and visibly.
QUARANTINED_BOOKS = [
    'what-to-expect-when-youre-expecting',
    'what-to-expect-the-second-year',
]

# ── books whose share of train is capped ────────────────────────────────────
#
# rise-and-fall-of-the-third-reich is a PRISTINE CALIBRE RENDER, not a scan
# (gold/manifest.json calls it degradation-ladder feedstock and says so
# explicitly). It is also the largest book in the lab: 48,224 pairs, 24% of
# everything, 86.7% of them byte-exact.
#
# Uncapped, the identity downsample would draw ~34% of its identity rows from
# this one book and hand it roughly a quarter of train — a quarter of the signal
# describing what a *clean render* looks like, in a corpus whose entire job is
# scan damage. §12d of docs/BLOCKS_TRAINING.md already measured the endpoint of
# that road: clean renders are 0.45% CER of which two thirds is ligature and
# quote normalisation, so training on them builds a Unicode normaliser instead
# of an OCR repairer.
#
# 10% keeps it as a useful "correct text looks like this" signal — restraint
# supervision from a source with almost no real errors to confuse it — without
# letting a non-scan set the error distribution. The cap is applied AFTER the
# identity downsample decides how many identity rows train wants, and the budget
# it frees is refilled from the other books, so the two mechanisms compose
# instead of fighting: the corpus stays at --identity-share, and only the
# provenance mix moves.
CAPPED_BOOKS = {'rise-and-fall': 0.10}

# ── the German diagnostic slice ─────────────────────────────────────────────
#
# Carved OUT of train, scored separately, never part of the headline.
#
# The headline eval is michelle-remembers, which is English throughout. himmler
# -a-life is the largest book in train and the only heavy source of German
# proper nouns and umlaut damage (`Reichsftihrer` -> `Reichsführer`,
# `Raterepublik` -> `Räterepublik`). Without this slice the score literally
# cannot see the failure mode that decides the model-size question: a thin
# language prior does not merely fail to fix a German name, it "corrects" it
# toward something more English-looking, and that ships into narration.
#
# It is a CONTIGUOUS page range, not a sample, for the same reason holdouts are
# whole books: neighbouring lines share a page, a typeface and a scanner
# artefact, so a scattered sample of German lines would still have its own pages
# in train. Chosen by scanning for the window of pages richest in non-ASCII
# truth characters.
GERMAN_SLICE_BOOK = 'himmler-a-life'
GERMAN_SLICE_SHARE = 0.10

# ── the prompt is half the contract ─────────────────────────────────────────
#
# It must arrive at inference byte-identical to this, inside the Qwen3 template
# with thinking disabled. The hyphen rule is load-bearing: without it the model
# has no way to know that a line-final hyphen is deliberate, and the repaired
# hyphen rows would read as noise.
SYSTEM = '\n'.join([
    'You correct OCR errors in a single line of text from a scanned book.',
    '',
    'Reply with the corrected line and nothing else.',
    '',
    'Rules:',
    '- Reply with the whole line, not just the part you changed.',
    '- Correct only what the scanner misread. Do not reword, translate, modernise',
    '  spelling, or change punctuation that is merely old-fashioned.',
    '- Keep a hyphen at the end of the line exactly as it is. The word finishes on',
    '  the next line, which you cannot see.',
    '- If the line has no OCR errors, reply with it unchanged.',
])

# Where each unit's corpus lives. sft-line/ is the provenance of the shipped
# foundry-ocr-v1-4b and the only thing that lets a sentence model be compared
# against a line model on the same books, so the two never share a directory and
# neither default can overwrite the other.
DEFAULT_OUT = {
    'line': '/Volumes/Callisto/training/rubric/galley/sft-line',
    'sentence': '/Volumes/Callisto/training/rubric/galley/sft-sent',
}

TRAILING_PUNCT = '.,!?;:\'"“”‘’)]}…'
LEADING_PUNCT = '\'"“”‘’([{—–'
HYPHENS = '-‐‑‒–—'


# ── metrics ─────────────────────────────────────────────────────────────────
def lev(a, b):
    """Levenshtein, two-row. Lines are short; this is not the bottleneck.

    Mirrored from tools/foundry-ocr/score.js and tools/foundry-ocr/eval-line.py — the same
    metric has to mean the same thing in the builder, the scorer and the report.
    """
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[len(b)]


def cer(ocr, truth):
    return lev(ocr, truth) / len(truth) if truth else (0.0 if not ocr else 1.0)


def slug(s):
    """Book ids arrive three ways — the ocr-lab directory (`michelle-remembers`),
    the gold manifest key (`himmler - a life`) and the constants above. Compare
    them on one normalised form or a holdout silently fails to match and lands
    in train, which is the one outcome this file exists to prevent."""
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s.lower())).strip('-')


def norm_ws(s):
    return re.sub(r'\s+', ' ', s).strip()


def strip_band_edge(s):
    """Drop a trailing band-edge pipe.

    MEASURED, and the measurement is the whole argument. `|` appears in 184 of
    9,053 michelle-remembers lines. 142 of those are INTERIOR and every one is
    Tesseract reading a capital I as a pipe (`| know` -> `I know`) — the classic
    l/1/I confusion §12d recorded as missing from the block corpus, and the most
    valuable single error class in this data. 43 are TRAILING and are the band
    cropper clipping the right edge (`PART |`, `ascend|`, `He quickly S|`);
    stripping them turns 15 of the 43 byte-exact and halves their mean CER.

    Same character, opposite lessons, told apart only by position. 43 examples
    cannot teach a positional exception against 142 counter-examples, so the
    positional case is removed deterministically instead — and because it is a
    property of the band cropper, THE SAME STRIP MUST RUN AT SERVING TIME,
    before ocr sees the line. It is a pipeline step, not a model behaviour.
    """
    out = re.sub(r'\s*\|\s*$', '', s)
    return out if out.strip() else s


def fold_typographic(s):
    """Fold the differences that are a typographic preference rather than a
    recognition error, for the identity test ONLY. Never applied to the text
    that is written out.

    The ellipsis rule collapses ANY run of three or more periods with any
    spacing, because the print sets `. . . .` and the EPUB sets `…` and the
    aligner's word-rejoining turns the pair into `okay....` vs `okay... .`. 422
    rows carry an ellipsis run; without the collapse they teach the model to
    re-space ellipses, which is the Unicode-normaliser failure §10d warns about.
    """
    s = s.replace('…', '...')
    s = re.sub(r'(?:\.\s*){3,}', '... ', s)
    s = re.sub(r'[“”]', '"', s)
    s = re.sub(r'[‘’]', "'", s)
    s = re.sub(r'[‐‑‒–—]', '-', s)
    s = re.sub(r'[∗⁎﹡＊]', '*', s)
    s = s.replace('ﬁ', 'fi').replace('ﬂ', 'fl')
    return re.sub(r'\s+', ' ', s).strip()


# ── the repairs ─────────────────────────────────────────────────────────────
#
# ONE LADDER, applied in order, each rung evidence-gated and counted. Every rung
# means the same thing — the aligner's truth WINDOW is unreliable at its two
# ends, so where the truth lost content the OCR still has, the OCR is right.
#
# The ladder is general because the artifact is not: measured across the first
# two books, michelle-remembers loses trailing PUNCTUATION (2,470 rows / 27%)
# while deathstalker-rebellion loses whole leading TOKENS (1,320 rows / 6.3%)
# and trailing punctuation too (2,977 rows / 14%). A rule tuned to one book's
# symptom silently passes the other's straight into training, which is why the
# gate is "the truth lost something at an edge", not "the truth lost a period".
def restore_lost_edge_tokens(ocr, truth, counts, max_tokens=2):
    """Restore up to `max_tokens` whole words the truth window dropped at either
    end. Gated on a difflib DELETE opcode that touches the edge: the tokens must
    be present in the OCR and absent from the truth with everything between them
    matching, which is evidence, not inference. An INSERT at the edge is left
    alone — that is the truth carrying characters the scanner lost
    (`candlesti` -> `candlestick`), which is a real repair ocr should learn.
    """
    import difflib
    ow, tw = ocr.split(), truth.split()
    if not ow or not tw:
        return truth
    ops = difflib.SequenceMatcher(None, ow, tw, autojunk=False).get_opcodes()
    head, tail = [], []
    if ops and ops[0][0] == 'delete' and ops[0][1] == 0 and 0 < ops[0][2] <= max_tokens:
        head = ow[:ops[0][2]]
    if ops and ops[-1][0] == 'delete' and ops[-1][2] == len(ow) and 0 < len(ow) - ops[-1][1] <= max_tokens:
        tail = ow[ops[-1][1]:]
    if not head and not tail:
        return truth
    counts['edgeTokensRestored'] += len(head) + len(tail)
    return ' '.join(head + tw + tail)


def restore_lost_edge_punct(ocr, truth, counts):
    """The same loss one scale down: the truth's first/last WORD survived but
    the punctuation attached to it did not (`does."` -> `does`). Measured
    one-directional on both books — thousands of rows where the truth dropped
    punctuation, ZERO where it added any — so the direction of the repair is a
    fact about the aligner, not a preference.

    The remainder match is FUZZY on purpose. 424 rows have a lost opening quote
    on a word that ALSO carries a real OCR error (`"Tt could` -> `It could`);
    an exact-remainder rule skips exactly those and leaves the model taught to
    delete an opening quote while fixing the letter. The gate stays evidence-
    based: the two remainders must be the same length and within a small edit
    distance, so the punctuation moves and the word's own error does not.
    """
    ow, tw = ocr.split(), truth.split()
    if not ow or not tw:
        return truth
    changed = False

    def close(a, b):
        return a == b or (len(a) == len(b) and lev(a, b) <= max(1, len(b) // 4))

    o_body, t_body = ow[-1].rstrip(TRAILING_PUNCT), tw[-1].rstrip(TRAILING_PUNCT)
    if len(ow[-1]) - len(o_body) > len(tw[-1]) - len(t_body) and close(o_body, t_body):
        tw[-1] = t_body + ow[-1][len(o_body):]
        changed = True
    o_body, t_body = ow[0].lstrip(LEADING_PUNCT), tw[0].lstrip(LEADING_PUNCT)
    if len(ow[0]) - len(o_body) > len(tw[0]) - len(t_body) and close(o_body, t_body):
        tw[0] = ow[0][:len(ow[0]) - len(o_body)] + t_body
        changed = True
    if not changed:
        return truth
    counts['edgePunctRestored'] += 1
    return ' '.join(tw)


def clamp_edge_extensions(ocr, truth, counts):
    """Refuse to teach the model to EXTEND the first or last word of a line.

    MEASURED, and it is the largest remaining defect: 1,886 of 5,852 edit rows
    (32%) have a truth whose edge word strictly extends the OCR's — `neede` ->
    `needed`, `murs` -> `Murmurs`, `unwit` -> `unwittingly`. The band cropper
    clipped a character or two off the line and the EPUB truth still has them.

    Some of those completions are near-certain (`candlesti`). It does not
    matter. A model taught to complete a clipped edge word cannot tell a clipped
    line from a line that simply ends there, so it fires on correct text too —
    and `rows made worse` is the number that decides whether this model ships.
    Restoring the OCR's own token costs a repair we could sometimes make and
    removes a whole class of invention we would otherwise have to police at
    inference.

    The clipping itself is a BAND-CROPPER bug, not a model problem, and the
    count printed by this rung is the measurement of it. Fixing it upstream
    turns these rows back into ordinary supervision.
    """
    ow, tw = ocr.split(), truth.split()
    if not ow or not tw:
        return truth
    changed = False
    if len(tw[-1]) > len(ow[-1]) and tw[-1].casefold().startswith(ow[-1].casefold()):
        tw[-1] = ow[-1]
        changed = True
    if len(tw[0]) > len(ow[0]) and tw[0].casefold().endswith(ow[0].casefold()):
        tw[0] = ow[0]
        changed = True
    if not changed:
        return truth
    counts['edgeExtensionsClamped'] += 1
    return ' '.join(tw)


def restore_edge_punct_runs(ocr, truth, counts):
    """The catch-all for the same loss, at character scale.

    The token rules above miss a truth that dropped a whole RUN of trailing
    marks (`'had time.' "` -> `'had time`), because the last token was replaced
    rather than deleted. 953 rows survived the token rules with a lost trailing
    run and 257 with a lost leading one. This rung is strictly safe: it only
    ever appends or prepends characters the OCR already has, and only when they
    are punctuation or space, so it cannot move a letter.
    """
    changed = False
    if ocr != truth and ocr.startswith(truth):
        rest = ocr[len(truth):]
        if rest and all(c.isspace() or not c.isalnum() for c in rest):
            truth = ocr
            changed = True
    if ocr != truth and ocr.endswith(truth):
        rest = ocr[:len(ocr) - len(truth)]
        if rest and all(c.isspace() or not c.isalnum() for c in rest):
            truth = ocr
            changed = True
    if changed:
        counts['edgePunctRunsRestored'] += 1
    return truth


def undo_truth_space_loss(ocr, truth, counts):
    """The truth welded two words together.

    `concentrate on the mission` -> `concentrate onthe mission`,
    `heard " at least` -> `heard "at least`. Seen throughout
    rise-and-fall-of-the-third-reich, whose truth is a Calibre render rather
    than a publisher EPUB.

    DIRECTION IS THE WHOLE RULE. Strip all whitespace and the two sides match
    either way, but only one direction is a lie: if the truth has FEWER spaces
    the truth welded them, and if it has MORE the SCANNER welded them (`Iam` ->
    `I am`) — which is a real and valuable OCR error that must survive. An
    undirected whitespace fold would silently delete that entire class.
    """
    if ocr == truth:
        return truth
    if re.sub(r'\s', '', ocr) != re.sub(r'\s', '', truth):
        return truth
    if truth.count(' ') >= ocr.count(' '):
        return truth
    counts['truthSpaceLoss'] += 1
    return ocr


def ligature_defect(truth):
    """True when the TRUTH has an exclamation mark with a letter on each side.

    was-hitler-an-atheist's embedded text layer mis-maps the `ff`/`fi`/`fl`
    ligatures onto the `!` slot, so its truth reads `e!orts` for `efforts` and
    `!rst` for `first`. 251 pairs in that book, plus one each in two others,
    which is the same defect appearing once. Word-internal `!` does not occur in
    real prose at all, which is what makes the signature safe to act on: a real
    exclamation mark is followed by a space or a quote, never a letter.

    Left in, these rows teach ocr to CREATE the damage — `first` -> `!rst` —
    on text the scanner read correctly. Same family as the CMap damage rung, a
    different slot, and common enough in one book to deserve its own count.
    """
    return re.search(r'(?<=[^\W\d_])!(?=[^\W\d_])', truth) is not None


def truth_glyph_damage(ocr, truth):
    """True when the truth carries a symbol INSIDE a word that the OCR does not.

    `Different` arriving as `Di#erent`, `Institute*` as `Institute∗`: a broken
    ToUnicode CMap decoding an `ff` ligature to a punctuation slot. §12c of
    docs/BLOCKS_TRAINING.md measured this as one of the three systematic ways a
    text layer lies, and gates it at BOOK level with tools/text-quality.py. This
    corpus has no such gate yet, so the row-level signature is used instead:
    letters on both sides of a non-alphanumeric character that the OCR never
    read. Conservative — it fires on the damage and not on real punctuation,
    which has a space or a word edge beside it.
    """
    for m in re.finditer(r'(?<=[^\W\d_])([^\w\s\'’\-‐])(?=[^\W\d_])', truth):
        if m.group(1) not in ocr:
            return True
    return False


def undo_truth_glyph_lies(ocr, truth, counts):
    """`1` standing alone in the truth where the OCR reads `I`.

    40 rows, all of them the pronoun (`1 understand what`, `"1 can understand
    your"`). The EPUB carries the damage, not the page — this corpus is one of
    the few places where the truth is itself OCR-derived. Left alone it trains
    ocr to turn `I` into `1`, which is the l/1/I confusion RUN BACKWARDS and
    would be shipped into narration as the digit one.
    """
    ow, tw = ocr.split(), truth.split()
    if len(ow) != len(tw):
        return truth
    changed = False
    for k, (o, t) in enumerate(zip(ow, tw)):
        if t.strip(TRAILING_PUNCT + LEADING_PUNCT) == '1' and o.strip(TRAILING_PUNCT + LEADING_PUNCT) == 'I':
            tw[k] = o
            changed = True
    if not changed:
        return truth
    counts['truthGlyphLies'] += 1
    return ' '.join(tw)


def case_diff_chars(a, b):
    return sum(1 for x, y in zip(a, b) if x != y) if len(a) == len(b) else 10 ** 6


def invert_lies(ocr, truth, counts):
    """The two remaining ways the truth is wrong about a page it describes
    correctly. Both end as identity rows because the scanner read the page
    right; §12c of docs/BLOCKS_TRAINING.md decided this for the block corpus and
    the reasoning is unchanged at line scale.

    SMALL CAPS is gated at >= 2 differing characters. `APPENDICES` ->
    `appendices` differs in ten and is a CSS text-transform lying about the
    page. `Speaking` -> `speaking` differs in one and is a real (if inaudible)
    Tesseract case error on a mid-sentence word — measured on
    deathstalker-rebellion, where an ungated rule fired on 65 of them.
    """
    if ocr == truth:
        return truth, None
    if ocr.casefold() == truth.casefold() and case_diff_chars(ocr, truth) >= 2:
        counts['smallCapsInverted'] += 1
        return ocr, 'small-caps'
    if fold_typographic(ocr) == fold_typographic(truth):
        counts['typographyInverted'] += 1
        return ocr, 'typography'
    return truth, None


def repair_hyphen(ocr, truth, position, counts):
    """Undo the aligner's wrap-hyphen join for one side of the pair.

    position 'A' = this line ENDS in the hyphen, so the truth's last word was
    completed from the next line. position 'B' = the line right after an A, so
    the truth's first word was completed from the previous one.

    The gate is the dagger lesson in miniature: the repair is only applied when
    the OCR's own fragment is literal evidence for it (the joined word starts
    with, or ends with, the fragment). No evidence, no guess — the row is
    dropped. Case-insensitive because the fragment may begin a sentence.
    """
    o_words, t_words = ocr.split(), truth.split()
    if not o_words or not t_words:
        return None

    if position == 'A':
        frag = o_words[-1].rstrip(HYPHENS)
        joined = t_words[-1]
        if len(joined) <= len(frag):
            return None                       # nothing was joined; leave it alone
        if not joined.casefold().startswith(frag.casefold()) or not frag:
            counts['hyphenNoEvidence'] += 1
            return None
        return ' '.join(t_words[:-1] + [o_words[-1]])

    frag = o_words[0]
    joined = t_words[0]
    if len(joined) <= len(frag):
        return None
    if not joined.casefold().endswith(frag.casefold()) or not frag:
        counts['hyphenNoEvidence'] += 1
        return None
    return ' '.join([o_words[0]] + t_words[1:])


# ── load ────────────────────────────────────────────────────────────────────
def load_books(lab):
    books = {}
    if not os.path.isdir(lab):
        sys.exit(f'build-dataset: no such lab dir: {lab}')
    for name in sorted(os.listdir(lab)):
        p = os.path.join(lab, name, 'scores', 'epub-align-pairs.json')
        if not os.path.isfile(p):
            continue
        # ~/Documents is iCloud: a fresh read can come back empty rather than
        # failing (docs/OCR_LAB.md, measurement gotchas). An empty pairs file is
        # a read that did not happen, not a book with no pairs — say so and stop
        # rather than silently building a corpus with a book missing.
        for attempt in range(3):
            raw = open(p, 'rb').read()
            if raw.strip():
                break
        if not raw.strip():
            sys.exit(f'build-dataset: {p} read back empty three times (iCloud eviction?). Refusing to build a corpus that is silently missing a book.')
        rows = json.loads(raw)
        if not isinstance(rows, list):
            sys.exit(f'build-dataset: {p} is not a JSON list')
        books[slug(name)] = rows
    return books


def load_tiers(lab):
    p = os.path.join(lab, 'gold', 'manifest.json')
    if not os.path.isfile(p):
        return {}
    m = json.load(open(p))
    return {slug(k): v.get('truthTier') for k, v in m.get('books', {}).items()}


# ── the per-LINE half of the build ──────────────────────────────────────────
def resolve_caps(args):
    caps = dict(CAPPED_BOOKS) if args.cap_books else {}
    for spec in (args.cap_book or []):
        name, _, share = spec.partition('=')
        caps[slug(name)] = float(share)
    return caps


def downsample_identity(train_all, share, caps, rnd):
    """Hold train at `share` identity rows, drawing them subject to the per-book
    caps. ONE description, used at both units — a sentence unit is identity only
    when every line in it was, which changes the population and nothing else.

    ── per-book caps, composed with the identity budget ────────────────────
    The identity downsample decides HOW MANY identity rows train wants; the cap
    decides WHERE they may come from. Doing it in that order is what makes the
    two compose: a capped book gives back part of the identity budget, the
    other books refill it, and --identity-share still holds exactly.
    """
    ident = [r for r in train_all if r['identity']]
    edit = [r for r in train_all if not r['identity']]
    want = round(len(edit) * share / max(1e-9, 1 - share))

    train_target = len(edit) + want
    ident_by_book = defaultdict(list)
    for r in ident:
        ident_by_book[r['book']].append(r)
    for b in ident_by_book:
        _shuffle(ident_by_book[b], rnd)

    used_ident, cap_report = [], {}
    for b, cap_share in caps.items():
        e_b = sum(1 for r in edit if r['book'] == b)
        allowance = max(0, int(round(cap_share * train_target)) - e_b)
        pool = ident_by_book.pop(b, [])
        taken = pool[:allowance]
        used_ident += taken
        if pool:
            cap_report[b] = {'share': cap_share, 'editRows': e_b, 'identityAvailable': len(pool),
                             'identityTaken': len(taken), 'identityDropped': len(pool) - len(taken)}
    rest = [r for rs in ident_by_book.values() for r in rs]
    _shuffle(rest, rnd)
    used_ident += rest[:max(0, want - len(used_ident))]
    return edit, ident, want, used_ident, cap_report, want - len(used_ident)


def collect_pairs(args, books, tiers, holdouts, quarantined):
    """Repair ladder + per-line gates. BOTH units stand on exactly this.

    Lifted out of main() unchanged when --unit sentence arrived, so the two
    corpora provably share a repair ladder rather than sharing one by inspection.

    It also records, for every EDIT row that reaches the gates, the length / sim
    / CER it arrived with — the PRE-gate distribution. The sentence corpus
    derives its own thresholds from the percentile these line thresholds sit at,
    and a percentile read off the survivors would be a percentile of the answer.
    """
    counts = Counter()
    drops = Counter()
    per_book = defaultdict(lambda: Counter())
    kept = []
    edit_dist = {'len': [], 'sim': [], 'cer': []}

    for book, rows in books.items():
        is_holdout = book in holdouts
        if book in quarantined and not args.include_quarantined and not is_holdout:
            drops['quarantinedBook'] += len(rows)
            per_book[book]['quarantined'] = len(rows)
            continue

        # A row's neighbour decides whether it is a hyphen 'B', so index in
        # reading order first.
        order = sorted(range(len(rows)), key=lambda i: (rows[i].get('page', 0), rows[i].get('line', 0)))
        pos = {}
        for k, i in enumerate(order):
            o = strip_band_edge(norm_ws(str(rows[i].get('ocr', ''))))
            if o and o[-1] in HYPHENS:
                pos[i] = 'A'
                if k + 1 < len(order) and order[k + 1] not in pos:
                    pos[order[k + 1]] = 'B'

        for i, r in enumerate(rows):
            for f in ('ocr', 'truth'):
                if not isinstance(r.get(f), str):
                    sys.exit(f'build-dataset: {book} row {i} has no string "{f}" — the aligner wrote a shape this builder does not know')
            ocr = strip_band_edge(norm_ws(r['ocr']))
            truth = norm_ws(r['truth'])
            sim = float(r.get('sim', 1.0))
            if not ocr or not truth:
                drops['empty'] += 1
                continue

            # A ligature-defect truth is unusable whatever the OCR says.
            if ligature_defect(truth):
                drops['ligatureDefect'] += 1
                per_book[book]['ligatureDefect'] += 1
                continue

            # hyphen family first: its repair changes what "identity" means.
            hyph = pos.get(i)
            if hyph:
                if args.hyphen_policy == 'drop':
                    drops['hyphen'] += 1
                    per_book[book]['hyphenDropped'] += 1
                    continue
                if args.hyphen_policy == 'repair':
                    fixed = repair_hyphen(ocr, truth, hyph, counts)
                    if fixed is None and truth != ocr:
                        # No literal evidence for the join. A guess here is an
                        # invented word in a finished audiobook.
                        if _joined_looking(ocr, truth, hyph):
                            drops['hyphenNoEvidence'] += 1
                            per_book[book]['hyphenDropped'] += 1
                            continue
                    elif fixed is not None:
                        truth = fixed
                        counts['hyphenRepaired'] += 1

            # The edge ladder. `--truth-edges keep` trains on the artifact as
            # found, which is only ever useful for measuring what it costs.
            if args.truth_edges != 'keep' and ocr != truth:
                before = truth
                if args.edge_extensions == 'clamp':
                    truth = clamp_edge_extensions(ocr, truth, counts)
                truth = restore_lost_edge_tokens(ocr, truth, counts)
                truth = restore_lost_edge_punct(ocr, truth, counts)
                truth = restore_edge_punct_runs(ocr, truth, counts)
                truth = undo_truth_space_loss(ocr, truth, counts)
                truth = undo_truth_glyph_lies(ocr, truth, counts)
                if truth != before and args.truth_edges == 'drop':
                    drops['truthEdgeArtefact'] += 1
                    per_book[book]['edgeDropped'] += 1
                    continue

            # A truth carrying CMap damage cannot be repaired, only refused.
            if ocr != truth and truth_glyph_damage(ocr, truth):
                drops['truthGlyphDamage'] += 1
                per_book[book]['glyphDamage'] += 1
                continue

            truth, reason = invert_lies(ocr, truth, counts)

            identity = ocr == truth

            # Filters apply to EDIT rows only. A byte-exact pair is never
            # dropped for being short or scoring badly on a similarity the
            # repairs have just invalidated — identity examples are what teach
            # the model to leave correct text alone, and they are the cheapest
            # supervision in the corpus (43% of it, free).
            if not identity:
                c = cer(ocr, truth)
                edit_dist['len'].append(len(ocr))
                edit_dist['sim'].append(sim)
                edit_dist['cer'].append(c)
                if len(ocr) < args.min_len:
                    drops['tooShort'] += 1
                    continue
                if sim < args.sim_floor:
                    drops['simFloor'] += 1
                    per_book[book]['simDropped'] += 1
                    continue
                if len(ocr) >= args.min_len_for_cer and c > args.max_cer:
                    drops['maxCer'] += 1
                    per_book[book]['cerDropped'] += 1
                    continue
            else:
                c = 0.0

            kept.append({
                'book': book, 'page': r.get('page'), 'line': r.get('line'),
                'ocr': ocr, 'truth': truth, 'cer': round(c, 5),
                'sim': sim, 'identity': identity,
                'repair': reason or (hyph and 'hyphen') or None,
                'truthTier': tiers.get(book),
            })
            per_book[book]['kept'] += 1
            per_book[book]['identity' if identity else 'edit'] += 1

    return kept, counts, drops, per_book, edit_dist


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--lab', default='/Volumes/Callisto/training/ocr-lab')
    ap.add_argument('--unit', choices=['line', 'sentence'], default='line',
                    help='the training unit. line = one Tesseract --psm 7 band (the shipped '
                         'foundry-ocr-v1-4b). sentence = consecutive lines packed to --cap.')
    ap.add_argument('--cap', type=int, default=400,
                    help='--unit sentence: characters a packed unit aims not to exceed')
    ap.add_argument('--out', default=None,
                    help='defaults per --unit; see DEFAULT_OUT')
    ap.add_argument('--unit-sim-floor', type=float, default=None,
                    help='--unit sentence: override the derived unit sim gate')
    ap.add_argument('--unit-max-cer', type=float, default=None,
                    help='--unit sentence: override the derived unit CER gate')
    ap.add_argument('--unit-min-len', type=int, default=None,
                    help='--unit sentence: override the derived unit length gate')
    ap.add_argument('--parity-rows', type=int, default=1000,
                    help='--unit sentence: rows in eval-parity-1k.jsonl, half identity')
    ap.add_argument('--parity-against', default=None,
                    help='--unit sentence: the line eval whose characters the sentence eval '
                         'must cover exactly (default <out>/../sft-line/eval.jsonl)')
    ap.add_argument('--sim-floor', type=float, default=0.75)
    ap.add_argument('--max-cer', type=float, default=0.30)
    ap.add_argument('--min-len-for-cer', type=int, default=40)
    ap.add_argument('--min-len', type=int, default=8)
    ap.add_argument('--identity-share', type=float, default=0.5)
    ap.add_argument('--truth-edges', choices=['restore', 'drop', 'keep'], default='restore')
    ap.add_argument('--edge-extensions', choices=['clamp', 'keep'], default='clamp')
    ap.add_argument('--hyphen-policy', choices=['repair', 'drop', 'keep'], default='repair')
    ap.add_argument('--include-quarantined', action='store_true')
    ap.add_argument('--cap-books', dest='cap_books', action='store_true', default=True)
    ap.add_argument('--no-cap-books', dest='cap_books', action='store_false')
    ap.add_argument('--cap-book', action='append', metavar='BOOK=SHARE',
                    help='cap a book at SHARE of train rows (repeatable)')
    ap.add_argument('--german-slice', dest='german_slice', action='store_true', default=True)
    ap.add_argument('--no-german-slice', dest='german_slice', action='store_false')
    ap.add_argument('--allow-tier3-eval', action='store_true')
    ap.add_argument('--seed', type=int, default=20260731)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    lab = os.path.expanduser(args.lab)
    out = os.path.expanduser(args.out or DEFAULT_OUT[args.unit])
    args.out = out                      # so build-stats records where it landed
    holdouts = {slug(b) for b in HOLDOUT_BOOKS}
    quarantined = {slug(b) for b in QUARANTINED_BOOKS}

    books = load_books(lab)
    tiers = load_tiers(lab)
    if not books:
        sys.exit(f'build-dataset: no <book>/scores/epub-align-pairs.json under {lab}')

    banner = 'LINE model' if args.unit == 'line' else f'SENTENCE units, cap {args.cap}'
    print(f'ocr build-dataset ({banner}) — {len(books)} book(s) with pairs under {lab}')

    missing_holdouts = [b for b in holdouts if b not in books]
    if missing_holdouts:
        print('\n!! DECLARED HOLDOUTS WITH NO PAIRS YET: ' + ', '.join(sorted(missing_holdouts)))
        print('   The split still refuses to put them in train, but this build has no')
        print('   eval rows from them. Mint their pairs before judging a model on it.')

    kept, counts, drops, per_book, edit_dist = collect_pairs(args, books, tiers, holdouts, quarantined)

    if not kept:
        sys.exit('build-dataset: nothing survived the filters')

    # ── identity discipline ─────────────────────────────────────────────────
    # Downsample identity rows to the target share, exactly as build-corpus.mjs
    # does. Repairing the aligner's punctuation artifact turns ~27% of the
    # corpus into identity rows, which would otherwise push restraint to ~70%
    # of the signal and starve the repair half.
    # THE SPLIT COMES FIRST. Downsampling before splitting would thin the eval
    # set's identity rows too, and the eval set's identity rate IS the baseline:
    # "CER before correction" and "false edits on already-correct lines" are only
    # meaningful against the mix a real book actually presents. Train is shaped
    # for learning; eval is left as the pipeline produced it.
    rnd = _lcg(args.seed)
    train_all = [r for r in kept if r['book'] not in holdouts]
    ev = [r for r in kept if r['book'] in holdouts]

    # ── the German diagnostic slice comes out of train BEFORE anything else ──
    german, german_pages = [], None
    if args.german_slice and GERMAN_SLICE_BOOK in {r['book'] for r in train_all}:
        german_pages = pick_german_window(
            [r for r in train_all if r['book'] == GERMAN_SLICE_BOOK], GERMAN_SLICE_SHARE)
        german = [r for r in train_all
                  if r['book'] == GERMAN_SLICE_BOOK and german_pages[0] <= (r['page'] or -1) <= german_pages[1]]
        gset = {id(r) for r in german}
        train_all = [r for r in train_all if id(r) not in gset]

    # ── one unit up ─────────────────────────────────────────────────────────
    #
    # Everything above is per-LINE and shared. Everything below the branch is the
    # line corpus, untouched. The sentence corpus packs the three groups the
    # split has just produced — which is why no unit can straddle the holdout
    # boundary or the German page window: those walls were built at line level,
    # one step ago, and a gap in the line numbering is where the packer stops.
    if args.unit == 'sentence':
        return build_sentence_corpus(
            args, out, lab, tiers, holdouts, quarantined, books,
            counts, drops, per_book, edit_dist, rnd,
            train_all, ev, german, german_pages)

    caps = resolve_caps(args)
    edit, ident, want, used_ident, cap_report, shortfall = downsample_identity(
        train_all, args.identity_share, caps, rnd)

    train = edit + used_ident
    _shuffle(train, rnd)
    _shuffle(ev, rnd)
    _shuffle(german, rnd)
    corpus = train + ev + german

    leaked = sorted({r['book'] for r in train} & holdouts)
    if leaked:
        sys.exit(f'build-dataset: REFUSING TO WRITE — holdout book(s) {leaked} reached train. '
                 'The split is law; this is a bug in the builder, not a warning.')
    bad_tier = sorted({r['book'] for r in ev if tiers.get(r['book']) == 3})
    if bad_tier and not args.allow_tier3_eval:
        sys.exit(f'build-dataset: REFUSING TO WRITE — eval contains tier-3 (teacher-only) book(s) {bad_tier}. '
                 'docs/OCR_LAB.md: eval only against tier-1 truth or hand-checked pages. '
                 '--allow-tier3-eval to override deliberately.')

    # ── report ──────────────────────────────────────────────────────────────
    n_in = sum(len(v) for v in books.values())
    print(f'\nREAD  {n_in} raw pairs')
    print('\nTHE TRUTH WAS REPAIRED (the OCR was right and the aligner was not).')
    print('  These are ALIGNER artefacts. If they ever read 0, align-epub.py was fixed')
    print('  and these branches are dead code -- check before assuming the corpus shrank.')
    print(f'  edge words CLAMPED (band clipped them) {counts["edgeExtensionsClamped"]:6d}  <-- a band-cropper measurement')
    print(f'  whole words restored at a line edge   {counts["edgeTokensRestored"]:6d}')
    print(f'  rows with edge punctuation restored   {counts["edgePunctRestored"]:6d}')
    print(f'  small caps inverted to identity       {counts["smallCapsInverted"]:6d}')
    print(f'  typography inverted to identity       {counts["typographyInverted"]:6d}')
    print(f'  wrap-hyphen joins undone              {counts["hyphenRepaired"]:6d}')
    print(f'  edge punctuation RUNS restored        {counts["edgePunctRunsRestored"]:6d}')
    print(f'  truth-side welded words separated     {counts["truthSpaceLoss"]:6d}')
    print(f'  truth `1` for `I` undone              {counts["truthGlyphLies"]:6d}')

    print('\nDROPPED')
    for k in ('quarantinedBook', 'empty', 'ligatureDefect', 'hyphen', 'hyphenNoEvidence',
              'truthEdgeArtefact', 'truthGlyphDamage', 'tooShort', 'simFloor', 'maxCer'):
        if drops[k]:
            print(f'  {k:22s} {drops[k]:6d}')
    if not sum(drops.values()):
        print('  nothing')

    if cap_report:
        print('\nCAPPED BOOKS (a clean render must not set the error distribution)')
        for b, c in cap_report.items():
            print(f'  {b:34s} capped at {c["share"] * 100:.0f}% of train — kept {c["editRows"]} edit + '
                  f'{c["identityTaken"]} identity, dropped {c["identityDropped"]} identity rows')
        print('  The freed identity budget was refilled from the other books, so')
        print('  --identity-share still holds exactly. Only the provenance mix moved.')

    if german:
        print(f'\nGERMAN DIAGNOSTIC SLICE — carved OUT of train, scored separately')
        print(f'  {GERMAN_SLICE_BOOK} pages {german_pages[0]}-{german_pages[1]}: {len(german)} rows'
              f'  ({sum(1 for r in german if not r["identity"])} edit)')
        na = sum(sum(1 for c in r['truth'] if ord(c) > 127) for r in german)
        print(f'  non-ASCII truth characters: {na}  ({na / max(1, len(german)):.2f} per row)')
        print('  NOT part of the headline eval. It is the canary for a small model')
        print('  "correcting" a German proper noun toward something more English-looking.')

    print('\nTRAIN CORPUS (eval is left at its natural identity rate on purpose)')
    print(f'  edit rows      {len(edit)}')
    print(f'  identity rows  {len(used_ident)} of {len(ident)} available '
          f'({len(used_ident) / max(1, len(train)) * 100:.1f}% of train)')
    if shortfall > 0:
        print(f'  !! {shortfall} short of --identity-share {args.identity_share}. Restraint is undertrained;')
        print('     more clean books is the fix, not a lower target.')

    ev_ident = sum(1 for r in ev if r['identity'])
    if ev:
        print(f'  eval identity rate {ev_ident / len(ev) * 100:.1f}%  '
              f'(the baseline a do-nothing model scores against)')

    hist = _cer_hist(edit)
    print('\nCER HISTOGRAM (edit rows only; identity rows are 0 by construction)')
    for label, n in hist:
        bar = '#' * int(60 * n / max(1, len(edit)))
        print(f'  {label:12s} {n:6d}  {n / max(1, len(edit)) * 100:5.1f}%  {bar}')

    print(f'\nBOOKS ({len(per_book)})')
    print('  (kept/ident/edit are BEFORE the identity downsample above)')
    print(f'  {"":5s}{"book":38s}{"tier":>5s}{"kept":>8s}{"ident":>8s}{"edit":>7s}{"ident%":>8s}')
    for b in sorted(per_book, key=lambda b: -per_book[b]['kept']):
        c = per_book[b]
        tag = 'EVAL ' if b in holdouts else ('QUAR ' if c['quarantined'] else '     ')
        tot = c['kept']
        share = f'{c["identity"] / tot * 100:.1f}' if tot else '-'
        print(f'  {tag}{b:38s}{str(tiers.get(b, "?")):>5s}{tot:>8d}{c["identity"]:>8d}{c["edit"]:>7d}{share:>8s}')

    no_tier = sorted(b for b in per_book if tiers.get(b) is None and per_book[b]['kept'])
    if no_tier:
        print(f'\n  !! no truthTier in gold/manifest.json for: {", ".join(no_tier)}')
        print('     The tier-3 eval refusal cannot protect a book it cannot identify.')
        print('     Either the ocr-lab directory name and the manifest key disagree, or the')
        print('     book was never registered.')

    print(f'\nSPLIT  train {len(train)}   eval {len(ev)}   eval-german {len(german)}')
    if not ev:
        print('  !! NO EVAL ROWS. Both holdout books are unminted; do not judge a model on this build.')

    if args.dry_run:
        print('\n--dry-run: nothing written')
        return

    os.makedirs(out, exist_ok=True)
    for name, rows_ in (('train', train), ('eval', ev), ('eval-german', german)):
        if name == 'eval-german' and not rows_:
            continue
        with open(os.path.join(out, f'{name}.jsonl'), 'w') as fh:
            for r in rows_:
                fh.write(json.dumps({
                    'messages': [
                        {'role': 'system', 'content': SYSTEM},
                        {'role': 'user', 'content': r['ocr']},
                        {'role': 'assistant', 'content': r['truth']},
                    ],
                    'book': r['book'], 'page': r['page'], 'line': r['line'],
                    'cer': r['cer'], 'identity': r['identity'], 'truthTier': r['truthTier'],
                }, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'pairs-repaired.jsonl'), 'w') as fh:
        for r in corpus:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'build-stats.json'), 'w') as fh:
        json.dump({
            'generated': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
            'lab': lab, 'args': vars(args),
            'holdoutBooks': sorted(holdouts), 'quarantinedBooks': sorted(quarantined),
            'rawPairs': n_in, 'repairs': dict(counts), 'dropped': dict(drops),
            'editRows': len(edit), 'identityRows': len(used_ident),
            'identityAvailable': len(ident), 'identityShortfall': shortfall,
            'cerHistogram': dict(hist),
            'books': {b: dict(c) for b, c in per_book.items()},
            'truthTiers': {b: tiers.get(b) for b in per_book},
            'train': len(train), 'eval': len(ev), 'evalGerman': len(german),
            'germanSlice': ({'book': GERMAN_SLICE_BOOK, 'pages': list(german_pages),
                             'rows': len(german)} if german else None),
            'cappedBooks': cap_report,
            'system': SYSTEM,
        }, fh, indent=1)
    print(f'\nwrote {out}/{{train,eval}}.jsonl + pairs-repaired.jsonl + build-stats.json')


# ── --unit sentence ─────────────────────────────────────────────────────────
def _sentences_module():
    """Import the sibling splitter rather than reimplementing it.

    tools/foundry-ocr/sentences.py mirrors foundry `src/ocr/sentences.ts`, which
    OWNS the boundary rules. A second copy of them in this file is how a training
    unit and a serving unit drift apart — the exact failure the sentence corpus
    exists to remove — so the corpus is packed by the same code the harness uses.

    The prompt crosscheck runs in both directions: sentences.py --self-test reads
    SYSTEM out of this file, and this reads OCR_SYSTEM_PROMPT out of that one.
    """
    import importlib.util
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sentences.py')
    if not os.path.isfile(p):
        sys.exit(f'build-dataset: sentences.py is not beside this file ({p}). '
                 '--unit sentence has no splitter and will not guess at one.')
    spec = importlib.util.spec_from_file_location('foundry_ocr_sentences', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if mod.OCR_SYSTEM_PROMPT != SYSTEM:
        sys.exit('build-dataset: sentences.py OCR_SYSTEM_PROMPT and this file\'s SYSTEM differ. '
                 'The prompt is half the contract; refusing to build two corpora with two prompts.')
    return mod


def _levenshtein():
    """The C Levenshtein — the same library align-epub.py used to write `sim`.

    A unit is ~400 characters and this file's own lev() is a pure-Python O(n*m)
    two-row DP: ~24 ms a unit, hours over the corpus. Speed is not the only
    reason though — `sim` has to MEAN what the aligner meant by it, and
    Levenshtein.ratio is where that meaning came from.

    lev() stays the contract for `cer`, so the library is proved against it here
    rather than trusted across a version bump.
    """
    try:
        import Levenshtein
    except ImportError:
        sys.exit('build-dataset: --unit sentence needs the Levenshtein module — the same one\n'
                 '  tools/ocr-lab/align-epub.py writes `sim` with.  pip3 install python-Levenshtein')
    for a, b in (('kitten', 'sitting'), ('', 'abc'), ('abc', ''),
                 ('Reichsftihrer', 'Reichsführer'), ('the same', 'the same'),
                 ('. . . okay', '... okay')):
        if Levenshtein.distance(a, b) != lev(a, b):
            sys.exit(f'build-dataset: Levenshtein.distance disagrees with this file\'s lev() on '
                     f'{a!r}/{b!r} — refusing to measure a corpus with a metric that moved.')
    return Levenshtein


def pack_units(rows, cap, mod, tiers, split):
    """Kept LINE rows -> sentence units, via sentences.build.

    A unit is a run of CONSECUTIVE lines of ONE book, joined the way the pipeline
    would join them, so the OCR unit and the truth unit are built from the same
    line set and correspond exactly. A gap in the line numbering is a wall — which
    is what makes the holdout split and the German page window walls too, since
    both were carved out at line level before this ran.
    """
    if not rows:
        return []
    chat = [{'messages': [{'role': 'system', 'content': SYSTEM},
                          {'role': 'user', 'content': r['ocr']},
                          {'role': 'assistant', 'content': r['truth']}],
             'book': r['book'], 'page': r['page'], 'line': r['line'],
             'identity': r['identity']} for r in rows]
    return [{'book': u['book'], 'page': u['page'], 'line': u['line'],
             'lineRange': u['lineRange'], 'lines': u['lines'],
             'ocr': u['src'], 'truth': u['gold'],
             'identity': u['identity'], 'truthTier': tiers.get(u['book']),
             'split': split, 'dropped': None}
            for u in mod.build(chat, cap)]


def measure_units(units, lv):
    """CER and sim, recomputed on the UNIT. Neither can be carried up from the
    lines: CER is a ratio over a different denominator, and the aligner's `sim`
    described a window this unit is several of."""
    for u in units:
        if u['ocr'] == u['truth']:
            u['cer'], u['sim'] = 0.0, 1.0
            continue
        u['cer'] = round(lv.distance(u['ocr'], u['truth']) / len(u['truth']), 5)
        u['sim'] = round(lv.ratio(u['ocr'], u['truth']), 5)


def assert_units_sound(units, rows, mod, label):
    """Every unit is EXACTLY its own lines, joined — no character invented, none
    lost, and no unit spanning a book.

    The index is keyed on (book, line), so a unit that reached across a book
    boundary could not resolve its own lines and stops the build by name. §5f
    asks for this to be asserted rather than argued from construction.
    """
    index = {(r['book'], r['line']): r for r in rows}
    for u in units:
        a, b = u['lineRange']
        want = list(range(a, b + 1))
        if len(want) != u['lines']:
            sys.exit(f'build-dataset: {label} unit {u["book"]} lines {a}-{b} claims {u["lines"]} '
                     f'lines but its range covers {len(want)} — the packer and the record disagree.')
        part = []
        for ln in want:
            r = index.get((u['book'], ln))
            if r is None:
                sys.exit(f'build-dataset: {label} unit {u["book"]} lines {a}-{b} covers line {ln}, '
                         'which is not in the split it was packed from. A unit crossed a wall — '
                         'a book boundary, the holdout split or the German page window.')
            part.append(r)
        if mod.join_all([r['ocr'] for r in part]) != u['ocr'] or \
           mod.join_all([r['truth'] for r in part]) != u['truth']:
            sys.exit(f'build-dataset: {label} unit {u["book"]} lines {a}-{b} is not its lines '
                     'joined. The packer invented or lost characters.')


def _percentile(sorted_vals, q):
    if not sorted_vals:
        return None
    k = min(len(sorted_vals) - 1, max(0, int(round(q / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def _rank_of(sorted_vals, v, inclusive=False):
    """Where a threshold sits in a distribution, as a percentile — i.e. what
    fraction of the population the gate at that value cuts away.

    `inclusive` for a gate that keeps `<= v` (`--max-cer`) rather than one that
    cuts everything below it.
    """
    import bisect
    if not sorted_vals:
        return 0.0
    k = bisect.bisect_right(sorted_vals, v) if inclusive else bisect.bisect_left(sorted_vals, v)
    return k / len(sorted_vals) * 100


def derive_unit_thresholds(args, edit_dist, unit_edit):
    """CARRY THE PERCENTILE ACROSS, NOT THE NUMBER.

    docs/OCR_SENTENCE_CORPUS_SURVEY.md §5e: the line gates were calibrated on a
    ~60-character band and measure a different object at ~300. `--sim-floor 0.75`
    was the 1st percentile of line `sim`; on a 400-character unit the same 0.75 is
    a hundred differing characters, a far coarser gate than the one that was
    argued for. `--min-len 8` is simply inert. `--max-cer 0.30` was a secondary
    gate above `--min-len-for-cer 40` and becomes the primary one.

    So each line threshold is located in the line distribution and the same
    percentile is taken of the unit distribution. The derivation is mechanical
    and printed, so a later argument about a threshold is an argument about a
    percentile rather than about a taste.

    THE GATES ARE A CASCADE AND THE PERCENTILE HAS TO BE READ THAT WAY. Measured
    the naive way — every percentile off the whole pre-gate population — the CER
    gate reads as the 92.8th percentile, because the rows carrying huge CERs are
    the two-character ones the length gate already removed and the ones under 40
    characters the CER gate is explicitly not applied to. Carrying 92.8% across
    would build a unit gate that throws away a tenth of the corpus in the name of
    a line gate that dropped 93 rows. So each threshold is ranked against the
    population that gate actually SEES, in the order collect_pairs applies them,
    and the unit side is cascaded identically.
    """
    rows = list(zip(edit_dist['len'], edit_dist['sim'], edit_dist['cer']))
    units = [(len(u['ocr']), u['sim'], u['cer']) for u in unit_edit]

    def take(pop, i):
        return sorted(x[i] for x in pop)

    # gate 1 — length, against everything that reaches the gates
    q_len = _rank_of(take(rows, 0), args.min_len)
    u_len = int(_percentile(take(units, 0), q_len))

    # gate 2 — sim, against what survived the length gate
    l1 = [r for r in rows if r[0] >= args.min_len]
    n1 = [u for u in units if u[0] >= u_len]
    q_sim = _rank_of(take(l1, 1), args.sim_floor)
    u_sim = round(_percentile(take(n1, 1), q_sim), 4)

    # gate 3 — the length above which CER is judged at all, then CER, each
    # against what survived everything before it
    l2 = [r for r in l1 if r[1] >= args.sim_floor]
    n2 = [u for u in n1 if u[1] >= u_sim]
    q_mlc = _rank_of(take(l2, 0), args.min_len_for_cer)
    u_mlc = int(_percentile(take(n2, 0), q_mlc))
    l3 = [r for r in l2 if r[0] >= args.min_len_for_cer]
    n3 = [u for u in n2 if u[0] >= u_mlc]
    q_cer = _rank_of(take(l3, 2), args.max_cer, inclusive=True)
    u_cer = round(_percentile(take(n3, 2), q_cer), 4)

    q = {'minLen': q_len, 'simFloor': q_sim, 'minLenForCer': q_mlc, 'maxCer': q_cer}
    pop = {'minLen': len(rows), 'simFloor': len(l1), 'minLenForCer': len(l2), 'maxCer': len(l3)}
    unit_pop = {'minLen': len(units), 'simFloor': len(n1), 'minLenForCer': len(n2), 'maxCer': len(n3)}
    derived = {'minLen': u_len, 'simFloor': u_sim, 'minLenForCer': u_mlc, 'maxCer': u_cer}
    used = dict(derived)
    override = {}
    for key, val in (('minLen', args.unit_min_len), ('simFloor', args.unit_sim_floor),
                     ('maxCer', args.unit_max_cer)):
        if val is not None:
            used[key] = val
            override[key] = val
    return {'linePercentile': q, 'linePopulation': pop, 'unitPopulation': unit_pop,
            'lineValue': {'minLen': args.min_len, 'minLenForCer': args.min_len_for_cer,
                          'simFloor': args.sim_floor, 'maxCer': args.max_cer},
            'derived': derived, 'override': override, 'used': used}


def gate_units(units, th, tally, mark):
    """The unit gates, on EDIT units only — the same asymmetry the line gates
    have, and for the same reason: an already-correct unit is what teaches
    restraint and is never dropped for scoring badly on a similarity the repairs
    invalidated.

    `mark=False` answers "what would this have taken out?" without touching the
    units, which is how the eval side reports the gates it deliberately skips.
    """
    out = []
    for u in units:
        why = None
        if not u['identity']:
            if len(u['ocr']) < th['minLen']:
                why = 'unitTooShort'
            elif u['sim'] < th['simFloor']:
                why = 'unitSimFloor'
            elif len(u['ocr']) >= th['minLenForCer'] and u['cer'] > th['maxCer']:
                why = 'unitMaxCer'
        if why is None:
            out.append(u)
            continue
        tally[why] += 1
        if mark:
            u['dropped'] = why
    return out


def verify_eval_parity(units, line_eval_path):
    """sft-sent/eval.jsonl must cover EXACTLY the characters sft-line/eval.jsonl
    covers, or the line-vs-sentence comparison is between two different books.

    It holds by construction — the sentence eval is packed from the same kept
    line rows the line eval was emitted from, and the unit gates deliberately do
    not run on it — but "by construction" is what every leak was before it was
    measured. So it is checked against the file ON DISK: the same line numbers,
    per book, and the same non-whitespace character count. Whitespace is excluded
    because joining lines ADDS the separator a line break stood for; that is the
    one character a unit has that its lines did not.
    """
    if not os.path.isfile(line_eval_path):
        print(f'\n!! NO CHARACTER-PARITY CHECK: {line_eval_path} is not there.')
        print('   The sentence eval is packed from the same kept rows, but nothing proved it.')
        return None
    line_rows = [json.loads(l) for l in open(line_eval_path, encoding='utf-8') if l.strip()]
    lhs, rhs = defaultdict(lambda: {'lines': set(), 'chars': 0}), defaultdict(lambda: {'lines': set(), 'chars': 0})
    for r in line_rows:
        u = {m['role']: m['content'] for m in r['messages']}['user']
        lhs[r['book']]['lines'].add(r['line'])
        lhs[r['book']]['chars'] += len(re.sub(r'\s', '', u))
    for u in units:
        a, b = u['lineRange']
        rhs[u['book']]['lines'].update(range(a, b + 1))
        rhs[u['book']]['chars'] += len(re.sub(r'\s', '', u['ocr']))

    report = {}
    bad = []
    for book in sorted(set(lhs) | set(rhs)):
        L, R = lhs[book], rhs[book]
        report[book] = {'lineRowsInLineEval': len(L['lines']), 'linesCoveredBySentenceEval': len(R['lines']),
                        'nonWhitespaceCharsLine': L['chars'], 'nonWhitespaceCharsSentence': R['chars'],
                        'linesEqual': L['lines'] == R['lines'], 'charsEqual': L['chars'] == R['chars']}
        if not report[book]['linesEqual'] or not report[book]['charsEqual']:
            bad.append(book)
    print(f'\nCHARACTER PARITY WITH {line_eval_path}')
    print(f'  {"book":26s}{"line rows":>11s}{"lines covered":>15s}{"chars (line)":>14s}{"chars (sent)":>14s}')
    for book, c in report.items():
        print(f'  {book:26s}{c["lineRowsInLineEval"]:>11d}{c["linesCoveredBySentenceEval"]:>15d}'
              f'{c["nonWhitespaceCharsLine"]:>14d}{c["nonWhitespaceCharsSentence"]:>14d}')
    if bad:
        sys.exit(f'build-dataset: REFUSING TO WRITE — the sentence eval does not cover the same '
                 f'characters as the line eval for {bad}. The two evals would score different books.')
    print('  identical line sets and identical non-whitespace character counts, per book.')
    return report


def _hist(vals, edges):
    """(label, count) buckets over ascending upper edges."""
    counts = Counter()
    labels = [lab for _, lab in edges]
    for v in vals:
        for hi, lab in edges:
            if v <= hi:
                counts[lab] += 1
                break
    return [(lab, counts[lab]) for lab in labels]


def _print_hist(title, rows, n):
    print(title)
    for label, c in rows:
        bar = '#' * int(50 * c / max(1, n))
        print(f'  {label:12s} {c:7d}  {c / max(1, n) * 100:5.1f}%  {bar}')


def _quantiles(vals):
    s = sorted(vals)
    return {'min': s[0], 'p10': _percentile(s, 10), 'p50': _percentile(s, 50),
            'p90': _percentile(s, 90), 'p99': _percentile(s, 99), 'max': s[-1],
            'mean': round(sum(s) / len(s), 1)}


# ── the token budget ────────────────────────────────────────────────────────
#
# MEASURED 2026-08-05 with the real Qwen3 tokenizer (apply_chat_template,
# enable_thinking=False, the shape text_sft trains on), over the corpora this
# file builds:
#
#     sft-line/train.jsonl    p50 163  p90 175  p99 201  max 246    0 over 512
#     sft-line/eval.jsonl     p50 165  p90 173  p99 179  max 197    0 over 512
#     sft-sent/train.jsonl    p50 283  p90 319  p99 405  max 573   15 over 512
#     sft-sent/eval.jsonl     p50 275  p90 314  p99 343  max 432    0 over 512
#     sft-sent/eval-german    p50 357  p90 434  p99 509  max 579    8 over 512
#
# 246 on lines is the number line-training-profiles.json's max_seq_length 512 was
# set against. AT --cap 400 THE SENTENCE CORPUS OVERFLOWS 512 — 23 rows do, and
# text_sft refuses to truncate, so that is a hard failure mid-run, not a silently
# clipped example. 768 holds the measured maximum with room.
#
# THE TAIL IS GERMAN, and that is why an average-case estimate is worse than
# useless here: English prose runs ~3.5 characters a token, umlauts and long
# compounds run ~2.2, so a chars/3.5 heuristic reports that this corpus fits
# inside 512 while the tokenizer reports that it does not. This file has no
# tokenizer (and will not grow a transformers dependency to get one), so it
# reports a WORST-CASE BOUND and never a verdict. Re-measure with train-line.sh
# --preflight before any run; if --cap moves, this whole block is stale.
CHARS_PER_TOKEN_WORST = 2.2
TEMPLATE_TOKENS = 30
MEASURED_TOKENS = {
    'measuredOn': '2026-08-05',
    'tokenizer': 'Qwen3 (apply_chat_template, enable_thinking=False)',
    'sft-line/train.jsonl': {'p50': 163, 'p90': 175, 'p99': 201, 'max': 246, 'over512': 0},
    'sft-line/eval.jsonl': {'p50': 165, 'p90': 173, 'p99': 179, 'max': 197, 'over512': 0},
    'sft-sent/train.jsonl': {'p50': 283, 'p90': 319, 'p99': 405, 'max': 573, 'over512': 15},
    'sft-sent/eval.jsonl': {'p50': 275, 'p90': 314, 'p99': 343, 'max': 432, 'over512': 0},
    'sft-sent/eval-german.jsonl': {'p50': 357, 'p90': 434, 'p99': 509, 'max': 579, 'over512': 8},
}


def token_bound(units):
    """An UPPER BOUND on the sequence length, not an estimate of it."""
    return _quantiles([(len(SYSTEM) + len(u['ocr']) + len(u['truth'])) / CHARS_PER_TOKEN_WORST
                       + TEMPLATE_TOKENS for u in units])


def build_sentence_corpus(args, out, lab, tiers, holdouts, quarantined, books,
                          counts, drops, per_book, edit_dist, rnd,
                          train_all, ev, german, german_pages):
    """The sentence half. Everything above the branch was per-line and shared."""
    mod = _sentences_module()
    lv = _levenshtein()

    # ── pack ────────────────────────────────────────────────────────────────
    u_train = pack_units(train_all, args.cap, mod, tiers, 'train')
    u_eval = pack_units(ev, args.cap, mod, tiers, 'eval')
    u_german = pack_units(german, args.cap, mod, tiers, 'eval-german')
    assert_units_sound(u_train, train_all, mod, 'train')
    assert_units_sound(u_eval, ev, mod, 'eval')
    assert_units_sound(u_german, german, mod, 'eval-german')
    for group in (u_train, u_eval, u_german):
        measure_units(group, lv)
    all_units = u_train + u_eval + u_german

    n_in = sum(len(v) for v in books.values())
    n_lines = len(train_all) + len(ev) + len(german)
    print(f'\nREAD  {n_in} raw pairs -> {n_lines} kept lines -> {len(all_units)} packed units')
    print(f'      (a unit is {n_lines / len(all_units):.2f} lines on average, cap {args.cap})')

    # ── the histograms the thresholds are read off ──────────────────────────
    lens = [len(u['ocr']) for u in all_units]
    q_len = _quantiles(lens)
    print(f'\nUNIT LENGTH (characters, OCR side; all {len(all_units)} units)')
    print(f'  min {q_len["min"]}  p10 {q_len["p10"]}  p50 {q_len["p50"]}  p90 {q_len["p90"]}  '
          f'p99 {q_len["p99"]}  max {q_len["max"]}  mean {q_len["mean"]}')
    over_cap = sum(1 for v in lens if v > args.cap)
    print(f'  over the cap ({args.cap}): {over_cap}  ({over_cap / len(lens) * 100:.2f}%)  '
          '— one sentence longer than the cap, cut at a line boundary rather than mid-word')
    _print_hist('', _hist(lens, [(50, '<=50'), (100, '(50,100]'), (200, '(100,200]'),
                                 (300, '(200,300]'), (400, '(300,400]'), (10 ** 9, '>400')]),
                len(lens))

    edit_units = [u for u in all_units if not u['identity']]
    if not edit_units:
        sys.exit('build-dataset: no edit units — nothing to gate and nothing to learn from')
    _print_hist(f'\nUNIT CER (edit units only, {len(edit_units)}; identity units are 0 by construction)',
                _hist([u['cer'] for u in edit_units],
                      [(0.005, '(0,0.5%]'), (0.01, '(0.5,1%]'), (0.02, '(1,2%]'), (0.05, '(2,5%]'),
                       (0.10, '(5,10%]'), (0.20, '(10,20%]'), (1e9, '>20%')]), len(edit_units))
    _print_hist('\nUNIT SIM (edit units only)',
                _hist([u['sim'] for u in edit_units],
                      [(0.80, '<=0.80'), (0.90, '(0.80,0.90]'), (0.95, '(0.90,0.95]'),
                       (0.98, '(0.95,0.98]'), (0.99, '(0.98,0.99]'), (2.0, '>0.99')]), len(edit_units))

    # ── thresholds ──────────────────────────────────────────────────────────
    #
    # Derived from TRAIN units only. A threshold is a scalar and the leak would be
    # tiny, but a number read partly off the holdout books is a number the holdout
    # books helped choose, and the split is law.
    th = derive_unit_thresholds(args, edit_dist, [u for u in u_train if not u['identity']])
    print('\nUNIT THRESHOLDS — the LINE thresholds\' percentiles, not their values')
    print(f'  {"gate":16s}{"line":>10s}{"of N lines":>12s}{"percentile":>13s}'
          f'{"unit":>10s}{"of N units":>12s}')
    for key in ('minLen', 'simFloor', 'minLenForCer', 'maxCer'):
        mark = '  <- --unit-* override' if key in th['override'] else ''
        print(f'  {key:16s}{th["lineValue"][key]:>10}{th["linePopulation"][key]:>12d}'
              f'{th["linePercentile"][key]:>12.3f}%{th["used"][key]:>10}'
              f'{th["unitPopulation"][key]:>12d}{mark}')
    print('  Each percentile is read against the population that gate actually SEES, in the')
    print('  order collect_pairs applies them — a cascade, not four reads of one distribution.')

    # ── the gates shape TRAIN only ──────────────────────────────────────────
    #
    # eval's mix IS the baseline (see "identity discipline"), and the sentence
    # eval carries one more obligation: it must cover exactly the characters the
    # LINE eval covers. A gate that dropped a unit there would score the two
    # models on different books. What the gates WOULD have taken out of eval is
    # counted and printed instead of hidden.
    unit_drops = Counter()
    u_train = gate_units(u_train, th['used'], unit_drops, True)
    would = Counter()
    gate_units(u_eval, th['used'], would, False)
    gate_units(u_german, th['used'], would, False)
    drops.update(unit_drops)

    print('\nDROPPED (unit scale; the per-line ladder\'s drops are above)')
    for k in sorted(unit_drops):
        print(f'  {k:22s} {unit_drops[k]:6d}')
    if not unit_drops:
        print('  nothing — every packed train unit passed the unit gates')
    if would:
        print('  the same gates on eval / eval-german, NOT applied (character parity is law):')
        for k in sorted(would):
            print(f'    {k:20s} {would[k]:6d}')

    # ── identity, at both scales ────────────────────────────────────────────
    line_ident = sum(1 for r in (train_all + ev + german) if r['identity'])
    unit_ident = sum(1 for u in all_units if u['identity'])
    print('\nIDENTITY AT TWO SCALES (a unit is already-correct only if EVERY line in it was)')
    print(f'  lines {line_ident}/{n_lines} = {line_ident / n_lines * 100:.1f}%')
    print(f'  units {unit_ident}/{len(all_units)} = {unit_ident / len(all_units) * 100:.1f}%')
    print('  A unit-level share is a HARSHER object than the same number at line level:')
    print('  the corpus carries more damaged characters per token at the same percentage.')

    caps = resolve_caps(args)
    edit, ident, want, used_ident, cap_report, shortfall = downsample_identity(
        u_train, args.identity_share, caps, rnd)

    train = edit + used_ident
    _shuffle(train, rnd)
    _shuffle(u_eval, rnd)
    _shuffle(u_german, rnd)

    leaked = sorted({u['book'] for u in train} & holdouts)
    if leaked:
        sys.exit(f'build-dataset: REFUSING TO WRITE — holdout book(s) {leaked} reached train. '
                 'The split is law; this is a bug in the builder, not a warning.')
    bad_tier = sorted({u['book'] for u in u_eval if tiers.get(u['book']) == 3})
    if bad_tier and not args.allow_tier3_eval:
        sys.exit(f'build-dataset: REFUSING TO WRITE — eval contains tier-3 (teacher-only) book(s) {bad_tier}. '
                 '--allow-tier3-eval to override deliberately.')
    cross = sorted({u['book'] for u in train} & {u['book'] for u in u_eval})
    if cross:
        sys.exit(f'build-dataset: REFUSING TO WRITE — book(s) {cross} are in both train and eval.')

    parity = verify_eval_parity(u_eval, args.parity_against or
                                os.path.join(os.path.dirname(out.rstrip('/')), 'sft-line', 'eval.jsonl'))

    # ── the balanced slice ──────────────────────────────────────────────────
    #
    # sft-line/eval-parity-1k.jsonl is 500 already-correct rows and 500 edit rows
    # drawn at random from the eval: a cell where a do-nothing model scores
    # exactly 50%, so a repair rate and a false-edit rate are read off the same
    # thousand answers. The sentence file is the same DESIGN at the unit scale —
    # not the same characters, which is eval.jsonl's job and is exact.
    pi = [u for u in u_eval if u['identity']]
    pe = [u for u in u_eval if not u['identity']]
    _shuffle(pi, rnd)
    _shuffle(pe, rnd)
    half = args.parity_rows // 2
    parity_rows = pi[:half] + pe[:half]
    _shuffle(parity_rows, rnd)
    if len(pi) < half or len(pe) < half:
        print(f'\n!! eval-parity-1k is short: {min(len(pi), half)} identity + {min(len(pe), half)} edit '
              f'(wanted {half} + {half})')

    if cap_report:
        print('\nCAPPED BOOKS (a clean render must not set the error distribution)')
        for b, c in cap_report.items():
            print(f'  {b:34s} capped at {c["share"] * 100:.0f}% of train — kept {c["editRows"]} edit + '
                  f'{c["identityTaken"]} identity, dropped {c["identityDropped"]} identity units')

    if german:
        print('\nGERMAN DIAGNOSTIC SLICE — carved out of train at LINE level, BEFORE packing,')
        print('  so no unit straddles the page window.')
        print(f'  {GERMAN_SLICE_BOOK} pages {german_pages[0]}-{german_pages[1]}: '
              f'{len(german)} lines -> {len(u_german)} units '
              f'({sum(1 for u in u_german if not u["identity"])} edit)')

    print('\nTRAIN CORPUS (eval is left at its natural identity rate on purpose)')
    print(f'  edit units      {len(edit)}')
    print(f'  identity units  {len(used_ident)} of {len(ident)} available '
          f'({len(used_ident) / max(1, len(train)) * 100:.1f}% of train)')
    if shortfall > 0:
        print(f'  !! {shortfall} short of --identity-share {args.identity_share}. Restraint is undertrained;')
        print('     more clean books is the fix, not a lower target.')

    tok = token_bound(train)
    tok_all = token_bound(all_units)
    print(f'\nTOKEN BUDGET — a BOUND, from chars/{CHARS_PER_TOKEN_WORST} (the worst measured '
          f'ratio, German) + {TEMPLATE_TOKENS}')
    print(f'  train  p50 {tok["p50"]:.0f}  p90 {tok["p90"]:.0f}  p99 {tok["p99"]:.0f}  max {tok["max"]:.0f}')
    print(f'  all    p50 {tok_all["p50"]:.0f}  p90 {tok_all["p90"]:.0f}  p99 {tok_all["p99"]:.0f}  '
          f'max {tok_all["max"]:.0f}')
    print(f'  MEASURED with the real Qwen3 tokenizer on {MEASURED_TOKENS["measuredOn"]}:')
    for k in ('sft-line/train.jsonl', 'sft-sent/train.jsonl', 'sft-sent/eval-german.jsonl'):
        m = MEASURED_TOKENS[k]
        print(f'    {k:28s} p50 {m["p50"]:4d}  p90 {m["p90"]:4d}  p99 {m["p99"]:4d}  '
              f'max {m["max"]:4d}   {m["over512"]:3d} over 512')
    print('  max_seq_length 512 OVERFLOWS this corpus at cap 400 (23 rows, the tail German).')
    print('  text_sft refuses to truncate, so that is a hard failure mid-run. 768 holds.')
    print('  Re-measure with train-line.sh --preflight if --cap moves.')

    # ── the final table ─────────────────────────────────────────────────────
    files = [('train.jsonl', train), ('eval.jsonl', u_eval), ('eval-german.jsonl', u_german),
             ('eval-parity-1k.jsonl', parity_rows), ('units.jsonl', all_units)]
    print('\nFINAL')
    print(f'  {"file":24s}{"rows":>8s}{"identity":>10s}{"ident%":>9s}{"books":>7s}'
          f'{"len p50":>9s}{"len p90":>9s}{"len max":>9s}{"over cap":>10s}')
    for name, rows_ in files:
        if not rows_:
            continue
        ln = [len(u['ocr']) for u in rows_]
        qi = _quantiles(ln)
        ni = sum(1 for u in rows_ if u['identity'])
        print(f'  {name:24s}{len(rows_):>8d}{ni:>10d}{ni / len(rows_) * 100:>8.1f}%'
              f'{len({u["book"] for u in rows_}):>7d}{qi["p50"]:>9d}{qi["p90"]:>9d}{qi["max"]:>9d}'
              f'{sum(1 for v in ln if v > args.cap):>10d}')

    print(f'\nSPLIT  train {len(train)}   eval {len(u_eval)}   eval-german {len(u_german)}   '
          f'units {len(all_units)}')

    if args.dry_run:
        print('\n--dry-run: nothing written')
        return

    os.makedirs(out, exist_ok=True)
    for name, rows_ in (('train', train), ('eval', u_eval), ('eval-german', u_german),
                        ('eval-parity-1k', parity_rows)):
        if not rows_:
            continue
        with open(os.path.join(out, f'{name}.jsonl'), 'w') as fh:
            for u in rows_:
                fh.write(json.dumps({
                    'messages': [
                        {'role': 'system', 'content': SYSTEM},
                        {'role': 'user', 'content': u['ocr']},
                        {'role': 'assistant', 'content': u['truth']},
                    ],
                    'book': u['book'], 'page': u['page'], 'line': u['line'],
                    'lineRange': u['lineRange'], 'lines': u['lines'],
                    'cer': u['cer'], 'identity': u['identity'], 'truthTier': u['truthTier'],
                }, ensure_ascii=False) + '\n')
    # Every packed unit, gated or not, downsampled or not — the base an
    # identity-share sweep (0.5 / 0.65 / 0.8) re-derives from without re-packing,
    # and the sentence corpus's answer to pairs-repaired.jsonl.
    with open(os.path.join(out, 'units.jsonl'), 'w') as fh:
        for u in all_units:
            fh.write(json.dumps(u, ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'build-stats.json'), 'w') as fh:
        json.dump({
            'generated': __import__('datetime').datetime.now().isoformat(timespec='seconds'),
            'unit': 'sentence', 'cap': args.cap,
            'lab': lab, 'args': vars(args),
            'holdoutBooks': sorted(holdouts), 'quarantinedBooks': sorted(quarantined),
            'rawPairs': n_in, 'keptLines': n_lines, 'packedUnits': len(all_units),
            'repairs': dict(counts), 'dropped': dict(drops),
            'unitGatesNotAppliedToEval': dict(would),
            'unitThresholds': th,
            'unitLength': q_len, 'unitLengthHistogram': dict(_hist(
                lens, [(50, '<=50'), (100, '(50,100]'), (200, '(100,200]'),
                       (300, '(200,300]'), (400, '(300,400]'), (10 ** 9, '>400')])),
            'overCap': over_cap,
            'unitCerHistogram': dict(_hist([u['cer'] for u in edit_units],
                                           [(0.005, '(0,0.5%]'), (0.01, '(0.5,1%]'), (0.02, '(1,2%]'),
                                            (0.05, '(2,5%]'), (0.10, '(5,10%]'), (0.20, '(10,20%]'),
                                            (1e9, '>20%')])),
            'identityShare': {'lines': round(line_ident / n_lines, 4),
                              'units': round(unit_ident / len(all_units), 4),
                              'lineRows': line_ident, 'lineTotal': n_lines,
                              'unitRows': unit_ident, 'unitTotal': len(all_units),
                              'trainTarget': args.identity_share},
            'editUnits': len(edit), 'identityUnits': len(used_ident),
            'identityAvailable': len(ident), 'identityShortfall': shortfall,
            'books': {b: dict(c) for b, c in per_book.items()},
            'unitsPerBook': {b: sum(1 for u in all_units if u['book'] == b)
                             for b in sorted({u['book'] for u in all_units})},
            'truthTiers': {b: tiers.get(b) for b in per_book},
            'train': len(train), 'eval': len(u_eval), 'evalGerman': len(u_german),
            'evalParity': len(parity_rows),
            'germanSlice': ({'book': GERMAN_SLICE_BOOK, 'pages': list(german_pages),
                             'lines': len(german), 'units': len(u_german)} if german else None),
            'cappedBooks': cap_report,
            'evalCharacterParity': parity,
            'tokenBudget': {'bound': f'chars/{CHARS_PER_TOKEN_WORST} + {TEMPLATE_TOKENS}',
                            'boundTrain': tok, 'boundAll': tok_all,
                            'measured': MEASURED_TOKENS,
                            'maxSeqLength512': 'OVERFLOWS — 23 rows measured over 512; use 768'},
            'system': SYSTEM,
        }, fh, indent=1)
    print(f'\nwrote {out}/{{train,eval,eval-german,eval-parity-1k}}.jsonl + units.jsonl + build-stats.json')


def pick_german_window(rows, share):
    """Find the contiguous page range, covering roughly `share` of a book's
    pairs, whose TRUTH is richest in non-ASCII characters.

    Non-ASCII density is the cheapest honest proxy for "German-dense" in this
    corpus: umlauts and eszett are what makes a German name hard, and they are
    exactly what a thin language prior strips when it "corrects" toward English.
    Sliding the window by page rather than sampling lines keeps the slice out of
    train page-wise, not just row-wise — neighbouring lines share a page, a
    typeface and a scanner artefact.
    """
    by_page = defaultdict(list)
    for r in rows:
        by_page[r['page'] if r['page'] is not None else -1].append(r)
    pages = sorted(by_page)
    counts = [len(by_page[p]) for p in pages]
    nonascii = [sum(sum(1 for c in r['truth'] if ord(c) > 127) for r in by_page[p]) for p in pages]
    target = share * sum(counts)

    best, best_density = None, -1.0
    lo = 0
    run_n, run_x = 0, 0
    for hi in range(len(pages)):
        run_n += counts[hi]
        run_x += nonascii[hi]
        while run_n > target and lo < hi:
            run_n -= counts[lo]
            run_x -= nonascii[lo]
            lo += 1
        if run_n >= target * 0.8:
            density = run_x / max(1, run_n)
            if density > best_density:
                best_density, best = density, (pages[lo], pages[hi])
    return best or (pages[0], pages[min(len(pages) - 1, max(0, int(len(pages) * share)))])


def _joined_looking(ocr, truth, position):
    """Would this row teach a completion the model cannot see? Only then is an
    un-repairable hyphen row worth dropping."""
    ow, tw = ocr.split(), truth.split()
    if not ow or not tw:
        return False
    return len(tw[-1]) > len(ow[-1].rstrip(HYPHENS)) if position == 'A' else len(tw[0]) > len(ow[0])


def _lcg(seed):
    s = [seed & 0xFFFFFFFF]

    def rand():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 4294967296
    return rand


def _shuffle(a, rand):
    for i in range(len(a) - 1, 0, -1):
        j = int(rand() * (i + 1))
        a[i], a[j] = a[j], a[i]


def _cer_hist(rows):
    edges = [(0.02, '(0,2%]'), (0.05, '(2,5%]'), (0.10, '(5,10%]'),
             (0.20, '(10,20%]'), (0.30, '(20,30%]'), (1e9, '>30%')]
    out = [(label, 0) for _, label in edges]
    counts = Counter()
    for r in rows:
        for hi, label in edges:
            if r['cer'] <= hi:
                counts[label] += 1
                break
    return [(label, counts[label]) for _, label in edges]


if __name__ == '__main__':
    main()
