/**
 * ai-cleanup-prepass.ts — deterministic pre-passes + edit-list machinery for the
 * AI cleanup (repair) task. This is the TypeScript port of the proven scratchpad
 * probes (editlist_test.py / editlist_test_C.py / param_detect.py /
 * build_instructions.py) whose evidence lives in AI_CLEANUP_TESTING.md §5–§7.
 *
 * The doctrine (ledger "Law"): the MODEL observes; VERIFIED CODE generates and
 * applies. Everything here that could damage text (a footnote-deletion regex, an
 * edit applied to prose) is composed/guarded by code with hard safety invariants
 * the model cannot switch off. A bad model answer degrades to "cleaned less",
 * never "corrupted more" — and every degradation is recorded, never silent
 * (no-fallbacks rule).
 *
 * Pure functions only — NO model calls, NO fs, NO Electron. ai-bridge orchestrates
 * the model calls and feeds their answers to these functions, which keeps this
 * module trivially unit-testable (see the scratch test in the PR).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Quote normalization (deterministic pre-pass 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize typographic quotes/apostrophes/ellipsis to their ASCII equivalents
 * for TTS. Dashes are deliberately NOT touched (they carry prosody). This mirrors
 * the QMAP in the probes, extended with the extra opening/guillemet/low variants
 * the ledger's quote-normalization rule calls for.
 *
 *  - curly/paired double quotes  “ ” „ « »  and doubled-single runs  ‘‘ ’’  → "
 *  - curly single quotes / apostrophes       ‘ ’ ‚                          → '
 *  - ellipsis                                 …                              → ...
 */
export function normalizeQuotes(text: string): string {
  return text
    // doubled single-quote runs first, else they'd become two apostrophes
    .replace(/‘‘|’’/g, '"')
    // curly / typographic double quotes and guillemets → straight double quote
    .replace(/[“”„«»]/g, '"')
    // curly single quotes / apostrophes / low-9 → straight apostrophe
    .replace(/[‘’‚]/g, "'")
    // ellipsis → three dots
    .replace(/…/g, '...');
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-break hyphen joins (deterministic pre-pass 2, with AI verdict arbitration)
// ─────────────────────────────────────────────────────────────────────────────

// A word, a hyphen, a line break (optionally padded with spaces/tabs), a word.
// Global + multiline so we can walk every occurrence across the whole book.
const HYPHEN_SPLIT = /([A-Za-zÀ-ÿ]+)-[ \t]*\n[ \t]*([A-Za-zÀ-ÿ]+)/g;

export type HyphenVerdict = 'join' | 'hyphen';

/**
 * Extract every UNIQUE `word-word` pair that a line break split with a hyphen.
 * The key is normalized to `first-second` (single hyphen, no newline) so it can be
 * used both as the batch item shown to the model and as the verdict-map key.
 */
export function extractHyphenPairs(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(HYPHEN_SPLIT)) {
    seen.add(`${m[1]}-${m[2]}`);
  }
  return [...seen];
}

export interface HyphenApplyResult {
  text: string;
  /** Pairs that had no valid verdict and took the conservative action, for the report. */
  degradations: Array<{ pair: string; why: string }>;
}

/**
 * Apply the model's join/keep verdicts to every `-\n` split in the text.
 *  - verdict 'join'   → \1\2        (a line break split one word: unbri-dled → unbridled)
 *  - verdict 'hyphen' → \1-\2       (a genuine compound: non-Aryan, Siegmund-Schultze)
 *  - NO valid verdict → \1-\2       (conservative: join the line break, KEEP the hyphen —
 *                                     least-destructive, still TTS-readable) and RECORDED.
 *
 * The conservative action for an un-adjudicated pair is a recorded degradation, not
 * a silent fallback: the caller writes every one to the job report.
 */
export function applyHyphenJoins(
  text: string,
  verdicts: Map<string, HyphenVerdict>
): HyphenApplyResult {
  const degradations: Array<{ pair: string; why: string }> = [];
  const seenDegraded = new Set<string>();
  const out = text.replace(HYPHEN_SPLIT, (_full, a: string, b: string) => {
    const key = `${a}-${b}`;
    const verdict = verdicts.get(key);
    if (verdict === 'join') return `${a}${b}`;
    if (verdict === 'hyphen') return `${a}-${b}`;
    // No usable verdict → conservative single-line hyphen kept, recorded once.
    if (!seenDegraded.has(key)) {
      seenDegraded.add(key);
      degradations.push({ pair: key, why: 'no valid verdict from model — kept hyphen, joined line break' });
    }
    return `${a}-${b}`;
  });
  return { text: out, degradations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Footnote-marker detection (deterministic, model-assisted — param_detect port)
// The MODEL fills in observed parameters; THIS code composes the regex from a
// template with hard safety invariants and self-checks it against the sequence.
// ─────────────────────────────────────────────────────────────────────────────

export interface FootnoteObservation {
  has_markers?: boolean;
  marker_type?: 'arabic' | 'roman' | 'letter' | 'symbol';
  symbol_chars?: string;
  anchors?: string[];
  space_between_anchor_and_marker?: boolean;
  followed_by?: 'whitespace' | 'line_end' | 'whitespace_then_capital';
  min_value?: number;
  max_value?: number;
  sequential?: boolean;
  restarts_each_chapter?: boolean;
  total_in_chapter?: number;
  examples?: string[];
  confusable_numbers_present?: unknown[];
}

// Anchor name → the raw character(s) that appear at that anchor position, as a
// fragment safe to drop inside a regex character class. Mirrors param_detect.py.
const ANCHOR_CHARS: Record<string, string> = {
  period: '\\.',
  question: '\\?',
  exclamation: '!',
  closing_double_quote: '”"',
  closing_single_quote: "’'",
  comma: ',',
  colon: ':',
};

// Every anchor character, used when deriving anchors from the found sequence.
const ALL_ANCHOR_CLASS = Object.values(ANCHOR_CHARS).join('');

function followedByLookahead(fb: string | undefined): string {
  switch (fb) {
    case 'line_end': return String.raw`(?=\s*$)`;
    case 'whitespace_then_capital': return String.raw`(?=\s+[A-Z“"‘'(])`;
    case 'whitespace':
    default: return String.raw`(?=\s|$)`;
  }
}

/**
 * Compose the deletion regex from observed parameters + NON-NEGOTIABLE invariants:
 *   - a marker never touches a letter        → can't eat OCR damage (c0nstitution)
 *   - arabic markers capped at ≤3 digits     → can't eat years (1918)
 *   - a NON-DIGIT before the anchor           → can't eat decimals (65.3)
 *   - the marker is immediately adjacent to its anchor (no space)
 *
 * `anchorClassOverride` replaces the model's anchor set with one derived from the
 * found sequence (see deriveArabicAnchors) when the model got anchors wrong.
 * Returns a fresh global RegExp, or throws for an unusable observation.
 */
export function composeFootnoteRegex(p: FootnoteObservation, anchorClassOverride?: string): RegExp {
  const t = p.marker_type || 'arabic';
  let core: string;
  if (t === 'arabic') {
    // When numbering does NOT restart per chapter, later chapters carry larger
    // values than the observed chapter — size to the 3-digit invariant, not to
    // the observed max (which would silently miss e.g. marker 100+).
    const hi = p.restarts_each_chapter === false
      ? 3
      : Math.min(3, Math.max(1, String(Math.trunc(p.max_value ?? 99)).length));
    core = String.raw`\d{1,${hi}}`; // INVARIANT: never 4+ digits (years)
  } else if (t === 'roman') {
    core = '[ivxlcdmIVXLCDM]{1,7}';
  } else if (t === 'letter') {
    core = '[a-z]';
  } else if (t === 'symbol') {
    const chars = p.symbol_chars || '';
    if (!chars) throw new Error('marker_type=symbol but symbol_chars is empty');
    core = `[${escapeForClass(chars)}]{1,4}`;
  } else {
    throw new Error(`unknown marker_type ${JSON.stringify(t)}`);
  }

  const parts: string[] = [];
  if (anchorClassOverride !== undefined) {
    if (!anchorClassOverride) throw new Error('empty derived anchor class');
    // INVARIANT: non-digit before the anchor char → kills decimals (65.3).
    parts.push(String.raw`(?<=[^\d0-9][${anchorClassOverride}])`);
  } else {
    const anchors = (p.anchors || []).filter(a => a in ANCHOR_CHARS);
    const wordAnchor = (p.anchors || []).includes('word_character');
    const cls = anchors.map(a => ANCHOR_CHARS[a]).join('');
    if (!cls && !wordAnchor) throw new Error('no usable anchors reported');
    if (cls) parts.push(String.raw`(?<=[^\d0-9][${cls}])`);
    if (wordAnchor) parts.push(String.raw`(?<=[A-Za-z])`);
  }
  const lb = parts.length === 1 ? parts[0] : `(?:${parts.join('|')})`;

  // Some books set markers a single space after the anchor (`period.” 2 Next` —
  // Killing America style). When the model observed that, the space is REQUIRED
  // and consumed by the match, so deletion removes " 2", leaving `.” Next`.
  // Space-separated markers lose the adjacency invariant, so callers MUST gate
  // their application per chapter (evaluateFootnoteChapterGate) — a bare
  // `. 40 million` is exactly what the sequence gate exists to catch.
  const gap = p.space_between_anchor_and_marker ? '[ ]' : '';

  // INVARIANT: never immediately followed by a letter → never mid-word.
  const pattern = lb + gap + core + String.raw`(?![A-Za-z])` + followedByLookahead(p.followed_by);
  return new RegExp(pattern, 'g');
}

/**
 * Deterministic prescan: how many digit-marker CANDIDATES does this chapter show
 * (a 1-3 digit number, adjacent or one space after a sentence-final anchor char,
 * not touching letters)? Used to pick the observation chapter — observing a
 * chapter with no markers (Killing America: chapter 1) makes the model correctly
 * report has_markers=false and the whole book keeps its markers.
 */
export function scoreFootnoteCandidates(text: string): number {
  const m = text.match(/(?<=[^\d0-9][.!?”’"'])[ ]?\d{1,3}(?![A-Za-z0-9])(?=\s|$)/g);
  return m ? m.length : 0;
}

/**
 * Bound the text sent to the footnote OBSERVATION call. Garbage-PDF exports often
 * put the WHOLE BOOK in one XHTML "chapter" (88 Reasons: 131k chars); shipping
 * that to Ollama overflows num_ctx, the truncation silently drops the
 * instructions, and the model free-associates a summary instead of the JSON.
 * Deterministically pick the maxLen-char window with the most marker candidates
 * (stride = maxLen/2, boundaries snapped to the nearest newline so the model
 * never sees a half-word at either edge). The SAME window must be used for the
 * self-check in detectFootnotes — the counts only mean anything against the text
 * the model actually saw.
 */
export function pickObservationWindow(text: string, maxLen = 12000): string {
  if (text.length <= maxLen) return text;
  const stride = Math.floor(maxLen / 2);
  let bestStart = 0, bestScore = -1;
  for (let start = 0; start < text.length; start += stride) {
    const score = scoreFootnoteCandidates(text.slice(start, start + maxLen));
    if (score > bestScore) { bestScore = score; bestStart = start; }
    if (start + maxLen >= text.length) break;
  }
  let start = bestStart;
  let end = Math.min(text.length, bestStart + maxLen);
  const nlBefore = text.lastIndexOf('\n', start);
  if (nlBefore !== -1 && start - nlBefore < 200) start = nlBefore + 1;
  const nlAfter = text.indexOf('\n', end);
  if (nlAfter !== -1 && nlAfter - end < 200) end = nlAfter;
  return text.slice(start, end);
}

export interface ChapterGateResult {
  apply: boolean;
  reason: string;
  values: number[];
}

/**
 * Per-chapter deterministic gate for ARABIC footnote deletion. The book-level
 * self-check proves the regex correct on the OBSERVED chapter only; every other
 * chapter must earn its deletion here, from its own text:
 *  - its matches must be strictly ascending in text order (a `. 40 million`
 *    intruder between markers 12 and 13 breaks the run → chapter skipped);
 *  - when numbering restarts per chapter, the first value must be small (≤3);
 *  - a chapter with no matches trivially passes (nothing to delete).
 * Non-arabic marker types (symbol glyphs etc.) skip this gate — they carry no
 * year/quantity ambiguity.
 */
export function evaluateFootnoteChapterGate(
  chapterText: string,
  regex: RegExp,
  p: FootnoteObservation
): ChapterGateResult {
  if ((p.marker_type || 'arabic') !== 'arabic') {
    return { apply: true, reason: 'non-arabic marker type — gate not applicable', values: [] };
  }
  const values = [...chapterText.matchAll(new RegExp(regex.source, 'g'))].map(m => parseInt(m[0], 10));
  if (values.length === 0) return { apply: true, reason: 'no matches in chapter', values };
  const ascending = values.every((v, i) => i === 0 || v > values[i - 1]);
  if (!ascending) {
    return { apply: false, reason: `matches not strictly ascending: [${values.join(',')}]`, values };
  }
  if (p.restarts_each_chapter !== false && values[0] > 3) {
    return { apply: false, reason: `numbering restarts per chapter but first match is ${values[0]}`, values };
  }
  return { apply: true, reason: `ascending run of ${values.length}`, values };
}

/** Indices of the longest STRICTLY ascending subsequence of `values`, in order. */
function longestAscendingIndices(values: number[]): number[] {
  const len = new Array<number>(values.length).fill(1);
  const prev = new Array<number>(values.length).fill(-1);
  let best = 0;
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    }
    if (len[i] > len[best]) best = i;
  }
  const out: number[] = [];
  for (let i = best; i !== -1; i = prev[i]) out.push(i);
  return out.reverse();
}

export interface FootnoteSelection {
  apply: boolean;
  reason: string;
  /** Spans to delete, ascending by index — ONLY ascending-chain members. */
  deletions: Array<{ index: number; length: number; value: number }>;
  /** Match values spared because they fall outside the ascending chain. */
  keptOutliers: number[];
}

/**
 * Chain-selective per-chapter application for ARABIC footnote deletion — the
 * outlier-tolerant successor to the all-or-nothing gate. Garbage scans corrupt
 * individual markers (Garbe: marker 26 OCR'd as `211`), and one bad marker must
 * not strand the other 300: compute the longest strictly-ascending subsequence
 * of matches and delete ONLY its members; everything off-chain stays in the
 * text. This is never more aggressive than the old gate (a fully-ascending
 * chapter deletes exactly the same set) and recovers chapters the old gate
 * skipped wholesale. Refusals remain:
 *  - chain shorter than 3 (too weak to call a sequence);
 *  - more than max(2, 10%) matches off-chain (the pattern isn't markers here);
 *  - restarting numbering whose chain starts above 3.
 */
export function selectFootnoteDeletions(
  chapterText: string,
  regex: RegExp,
  p: FootnoteObservation
): FootnoteSelection {
  const matches = [...chapterText.matchAll(new RegExp(regex.source, 'g'))];
  if ((p.marker_type || 'arabic') !== 'arabic') {
    return {
      apply: true, reason: 'non-arabic marker type — no sequence to gate on',
      deletions: matches.map(m => ({ index: m.index!, length: m[0].length, value: NaN })),
      keptOutliers: [],
    };
  }
  if (matches.length === 0) return { apply: true, reason: 'no matches in chapter', deletions: [], keptOutliers: [] };
  const values = matches.map(m => parseInt(m[0], 10));
  const chain = longestAscendingIndices(values);
  const outliers = values.length - chain.length;
  if (chain.length < 3) {
    return { apply: false, reason: `ascending chain too short (${chain.length} of ${values.length}: [${values.join(',')}])`, deletions: [], keptOutliers: values };
  }
  // Cap sized against random prose: n random numbers yield an ascending chain of
  // only ~2·√n (~31% at n=39), so demanding 80% chain membership still rejects
  // non-marker patterns outright, while tolerating a garbage scan's corrupted
  // markers and a concatenated next chapter's restarted numbering (Garbe).
  if (outliers > Math.max(2, Math.ceil(values.length * 0.2))) {
    return { apply: false, reason: `too many out-of-sequence matches (${outliers} of ${values.length}: [${values.join(',')}])`, deletions: [], keptOutliers: values };
  }
  if (p.restarts_each_chapter !== false && values[chain[0]] > 3) {
    return { apply: false, reason: `numbering restarts per chapter but chain starts at ${values[chain[0]]}`, deletions: [], keptOutliers: values };
  }
  const inChain = new Set(chain);
  return {
    apply: true,
    reason: `ascending chain of ${chain.length}/${values.length}${outliers ? ` (spared off-chain: [${values.filter((_, i) => !inChain.has(i)).join(',')}])` : ''}`,
    deletions: chain.map(i => ({ index: matches[i].index!, length: matches[i][0].length, value: values[i] })),
    keptOutliers: values.filter((_, i) => !inChain.has(i)),
  };
}

/** Splice a FootnoteSelection's deletions out of the chapter text. */
export function applyFootnoteSelection(chapterText: string, sel: FootnoteSelection): string {
  if (!sel.apply || sel.deletions.length === 0) return chapterText;
  let out = chapterText;
  for (let i = sel.deletions.length - 1; i >= 0; i--) {
    const d = sel.deletions[i];
    out = out.slice(0, d.index) + out.slice(d.index + d.length);
  }
  return out;
}

/** Escape characters that are special inside a regex character class. */
function escapeForClass(s: string): string {
  return s.replace(/[\]\\^-]/g, '\\$&');
}

/**
 * Derive the anchor character class for ARABIC SEQUENTIAL markers by walking the
 * 1..N sequence: find every ≤maxDigits number that (a) sits immediately after a
 * generic anchor char preceded by a non-digit, (b) is not adjacent to a letter,
 * (c) is followed by whitespace/line-end — then, IF those numbers form a perfect
 * 1..N run in text order, collect the anchor characters that actually preceded
 * them. The ledger proved the model reports anchors wrong but everything else
 * right; deriving from the sequence recovered 25/25 on the Soul fixture.
 *
 * Returns the derived class string, or null if no clean 1..N sequence is found.
 */
export interface DerivedAnchors {
  anchorClass: string;
  spaceBetween: boolean;
  followedBy: string;
  values: number[];
}

/**
 * One derivation attempt with explicit space/lookahead parameters. A run counts as
 * proof when its values are CONSECUTIVE ascending (v[i+1] = v[i]+1) — and, for
 * per-chapter-restarting numbering, start at 1. A consecutive run cannot happen by
 * chance in real prose; it is the strongest evidence available.
 */
function deriveVariant(text: string, maxDigits: number, fb: string | undefined, spaceBetween: boolean, restarts: boolean): DerivedAnchors | null {
  const pat = new RegExp(
    String.raw`(?<=[^\d0-9]([${ALL_ANCHOR_CLASS}]))` + (spaceBetween ? '[ ]' : '') +
    String.raw`\d{1,${maxDigits}}(?![A-Za-z])` + followedByLookahead(fb),
    'g'
  );
  const matches = [...text.matchAll(pat)];
  if (matches.length === 0) return null;
  const values = matches.map(m => parseInt(m[0], 10));

  // The broad candidate pattern also catches confusables (`, 200 million` after a
  // comma, small counts after a period), so the run is a SUBSEQUENCE of the match
  // list, not the whole list. Longest chain in text order where each picked value
  // is exactly prev+1; intruders between run members are fine here — they carry
  // different anchor chars, and any that share the derived anchors will break the
  // recompose-and-revalidate step in detectFootnotes, failing safe.
  const runLen: number[] = new Array(values.length).fill(1);
  const prevIdx: number[] = new Array(values.length).fill(-1);
  let bestEnd = -1;
  for (let i = 0; i < values.length; i++) {
    for (let j = i - 1; j >= 0; j--) {
      if (values[j] === values[i] - 1 && runLen[j] + 1 > runLen[i]) {
        runLen[i] = runLen[j] + 1;
        prevIdx[i] = j;
      }
    }
    const startVal = values[i] - runLen[i] + 1;
    if (restarts && startVal !== 1) continue;
    if (bestEnd === -1 || runLen[i] > runLen[bestEnd]) bestEnd = i;
  }
  if (bestEnd === -1 || runLen[bestEnd] < 2) return null;
  const runIdx: number[] = [];
  for (let i = bestEnd; i !== -1; i = prevIdx[i]) runIdx.push(i);
  runIdx.reverse();

  const observed = new Set<string>();
  for (const i of runIdx) observed.add(matches[i][1]);
  return {
    anchorClass: escapeForClass([...observed].join('')),
    spaceBetween,
    followedBy: fb || 'whitespace',
    values: runIdx.map(i => values[i]),
  };
}

/**
 * Derive the anchor set for ARABIC markers by walking the sequence — WITHOUT
 * trusting the model's space/lookahead parameters. Killing America: the model's
 * own examples showed `ones. 1` and `Year.” 5` (space, mid-paragraph) while it
 * reported space_between=false and followed_by=line_end — every quantitative
 * detail wrong, so the old single-variant derivation found nothing. This sweeps
 * the space flag and the lookahead variants; each candidate must still produce a
 * consecutive ascending run, so trying more variants adds zero risk. The variant
 * with the LONGEST proven run wins.
 */
export function deriveArabicAnchors(text: string, maxDigits: number, fb: string | undefined, spaceBetween?: boolean, restarts: boolean = true): DerivedAnchors | null {
  const spaceVariants = spaceBetween ? [true, false] : [false, true];
  const fbVariants = [...new Set([fb, 'whitespace', 'whitespace_then_capital'])];
  let best: DerivedAnchors | null = null;
  for (const spc of spaceVariants) {
    for (const f of fbVariants) {
      const d = deriveVariant(text, maxDigits, f, spc, restarts);
      if (d && (!best || d.values.length > best.values.length)) best = d;
    }
  }
  return best;
}

export interface FootnoteDetectResult {
  applied: boolean;
  regex: RegExp | null;
  matchCount: number;
  derivedAnchors: boolean;
  reason: string;
  observation: FootnoteObservation;
}

/**
 * Full footnote self-check pipeline (param_detect §5). Composes the regex from the
 * observation, self-checks it against the observation chapter (count must equal the
 * model's reported total; arabic+sequential values must form a perfect 1..N), and
 * derives anchors from the sequence if the model's anchors match nothing.
 *
 * PASS (applied:true) → the caller applies `regex` to EVERY chapter.
 * FAIL / has_markers=false → applied:false, regex:null; the caller applies nothing
 * and records `reason`. Never guesses — fail-safe by construction.
 */
export function detectFootnotes(p: FootnoteObservation, chapterText: string): FootnoteDetectResult {
  const base: Omit<FootnoteDetectResult, 'applied' | 'regex' | 'matchCount' | 'derivedAnchors' | 'reason'> = {
    observation: p,
  };
  if (p.has_markers === false) {
    // The model's denial is a QUALITATIVE claim — and a provable consecutive
    // marker sequence in the text is stronger evidence than any model claim
    // (Garbe: the model said has_markers=false on a window full of `death.”1`
    // adjacent markers — 336 in the book). Overriding a denial demands a HIGHER
    // bar than overriding a count: a derived run of >=8 consecutive values,
    // and the recomposed regex's full match set must be strictly ascending.
    const denial = deriveArabicAnchors(chapterText, 3, undefined, undefined, false);
    if (denial && denial.values.length >= 8) {
      try {
        const p2: FootnoteObservation = {
          ...p, has_markers: true, marker_type: 'arabic', sequential: true,
          restarts_each_chapter: false,
          space_between_anchor_and_marker: denial.spaceBetween,
          followed_by: denial.followedBy as FootnoteObservation['followed_by'],
        };
        const regex = composeFootnoteRegex(p2, denial.anchorClass);
        const sel = selectFootnoteDeletions(chapterText, regex, p2);
        if (sel.apply && sel.deletions.length >= 8) {
          return {
            ...base, applied: true, regex: new RegExp(regex.source, 'g'), matchCount: sel.deletions.length,
            derivedAnchors: true,
            reason: `model has_markers=false OVERRIDDEN by sequence proof (derived: anchors=[${denial.anchorClass}] space=${denial.spaceBetween} fb=${denial.followedBy}): ${sel.reason}, consecutive run ${denial.values.length}`,
          };
        }
      } catch { /* fall through to the denial */ }
    }
    return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: 'model reported has_markers=false' };
  }
  const total = p.total_in_chapter;
  if (typeof total !== 'number' || total <= 0) {
    return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: `unusable total_in_chapter (${JSON.stringify(total)})` };
  }

  // Both self-checks for one composed regex: count must equal the model's reported
  // total; arabic+sequential values must form a perfect 1..N. Returns null on pass.
  const validate = (matches: RegExpMatchArray[]): string | null => {
    if (matches.length !== total) {
      return `count mismatch: regex found ${matches.length}, model reported ${total}`;
    }
    if ((p.marker_type || 'arabic') === 'arabic' && p.sequential) {
      const values = matches.map(m => parseInt(m[0], 10));
      // Consecutive ascending; when numbering restarts per chapter it must start
      // at 1, while continuous (book-wide) numbering may start anywhere.
      const consecutive = values.every((v, i) => i === 0 || v === values[i - 1] + 1);
      if (!consecutive) return `values are not a consecutive run: [${values.join(',')}]`;
      if (p.restarts_each_chapter !== false && values[0] !== 1) return `restarting numbering must begin at 1, got ${values[0]}`;
    }
    return null;
  };

  // Attempt 1: the model's reported anchors.
  let modelFailure: string;
  try {
    const regex = composeFootnoteRegex(p);
    const matches = [...chapterText.matchAll(regex)];
    const fail = validate(matches);
    if (!fail) {
      return {
        ...base, applied: true, regex: new RegExp(regex.source, 'g'), matchCount: matches.length,
        derivedAnchors: false, reason: `PASS: ${matches.length} markers`,
      };
    }
    modelFailure = fail;
  } catch (e) {
    modelFailure = `compose failed: ${(e as Error).message}`;
  }

  // Attempt 2 (arabic only): derive ALL the quantitative parameters (anchors,
  // space flag, lookahead) by walking the sequence — the model is only trusted
  // for the qualitative facts (markers exist, they're arabic, restart behavior).
  // A derived CONSECUTIVE ascending run of >=5 is accepted as proof outright,
  // even against the model's count: Killing America's model said 47 where the
  // true inline run was shorter (it counted the endnote list too) — the sequence
  // is the ground truth, the count was never the strong evidence. The count
  // discrepancy is recorded, not silently ignored.
  if ((p.marker_type || 'arabic') === 'arabic') {
    const hi = p.restarts_each_chapter === false
      ? 3
      : Math.min(3, Math.max(1, String(Math.trunc(p.max_value ?? 99)).length));
    const restarts = p.restarts_each_chapter !== false;
    const derived = deriveArabicAnchors(chapterText, hi, p.followed_by, p.space_between_anchor_and_marker, restarts);
    if (derived) {
      try {
        const p2: FootnoteObservation = { ...p, space_between_anchor_and_marker: derived.spaceBetween, followed_by: derived.followedBy as FootnoteObservation['followed_by'] };
        const regex = composeFootnoteRegex(p2, derived.anchorClass);
        // Acceptance is chain-based, mirroring per-chapter application: the
        // longest strictly-ascending subsequence must dominate the match set
        // (selectFootnoteDeletions enforces the outlier cap — an OCR-corrupted
        // marker like Garbe's `211` no longer voids the whole observation), and
        // the chain must contain a consecutive run long enough to be proof.
        // Off-chain matches and unmatched-anchor markers under-clean — the safe
        // direction.
        const sel = selectFootnoteDeletions(chapterText, regex, p2);
        const chainVals = sel.deletions.map(d => d.value);
        let bestRun = 0;
        for (let i = 0, run = 1; i < chainVals.length; i++, bestRun = Math.max(bestRun, run)) {
          run = i > 0 && chainVals[i] === chainVals[i - 1] + 1 ? run + 1 : 1;
        }
        const countAgrees = chainVals.length === total;
        if (sel.apply && chainVals.length > 0 && (countAgrees || bestRun >= 5)) {
          const countNote = countAgrees ? '' : ` (model count ${total} OVERRIDDEN by sequence proof)`;
          return {
            ...base, applied: true, regex: new RegExp(regex.source, 'g'), matchCount: chainVals.length,
            derivedAnchors: true,
            reason: `PASS (derived: anchors=[${derived.anchorClass}] space=${derived.spaceBetween} fb=${derived.followedBy}): ${sel.reason}, best consecutive run ${bestRun}${countNote}`,
          };
        }
        return { ...base, applied: false, regex: null, matchCount: chainVals.length, derivedAnchors: true, reason: `model anchors: ${modelFailure}; derived chain not acceptable (${sel.reason}, bestRun=${bestRun}, chain=${chainVals.length} vs model ${total})` };
      } catch (e) {
        return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: true, reason: `model anchors: ${modelFailure}; derived compose failed: ${(e as Error).message}` };
      }
    }
  }

  return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: modelFailure };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic damage scan → few-shot block (build_instructions port)
// ─────────────────────────────────────────────────────────────────────────────

// A digit embedded in an alphabetic word = scanner damage ...
const DMG = /\b(?=[A-Za-zÀ-ÿ]*\d)(?=\d*[A-Za-zÀ-ÿ])[A-Za-zÀ-ÿ0-9]{3,}\b/g;
// ... except these legitimate shapes (years like 1920s, ordinals, pure numbers).
const NOT_DMG = /^\d{4}s?$|^\d+(st|nd|rd|th)$|^\d+$/i;

/**
 * Find words with a digit scanned in place of a letter (c0nstitution, past0rs),
 * excluding legitimate `\d{4}s?` / ordinals / pure numbers. Sorted + de-duped.
 * This is what code CAN see; the few-shot then asks the model to generalize to
 * letter-for-letter damage the scanner CANNOT see (the withheld-case test, §6).
 */
export function scanDamagedWords(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(DMG)) {
    if (!NOT_DMG.test(m[0])) found.add(m[0]);
  }
  return [...found].sort();
}

/**
 * Build the per-chunk few-shot block appended to the edit-list system prompt.
 * Digit-damage evidence only — NO hyphen section (those splits were already
 * joined by the deterministic pre-pass, so none remain in the chunk).
 */
export function buildFewShotBlock(damaged: string[]): string {
  const lines: string[] = [];
  lines.push(
    'This passage came from a book scanner and contains scanner damage. A deterministic ' +
    'scan of THIS passage found the problems below. They are real and present in the text you ' +
    'were given.'
  );
  if (damaged.length > 0) {
    lines.push(
      '\nDAMAGED WORDS FOUND (a digit was scanned in place of a letter). Report a repair that ' +
      'restores the word the author intended:'
    );
    lines.push('  ' + damaged.join(', '));
  }
  lines.push(
    '\nAlso repair any other similar damage where ONE LETTER was misread as another, producing a ' +
    'wrong word that still looks like a word (e.g. ministcrs → ministers). The scan above only ' +
    'catches damage that left a digit behind; read for sense and report those repairs too.'
  );
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarded edit-list applier (editlist_test_C port)
// ─────────────────────────────────────────────────────────────────────────────

export type EditStatus =
  | 'NOOP'
  | 'LETTER_DELETION_BLOCKED'
  | 'DELETION_BLOCKED'
  | 'DRIFT_BLOCKED'
  | 'INSERTION_BLOCKED'
  | 'SUSPICIOUS_GLOBAL'
  | 'QUOTE_EDIT_BLOCKED'
  | 'NUMERIC_EDIT_BLOCKED'
  | 'DIGIT_MUTATION_BLOCKED'
  | 'APPLIED'
  | 'MULTI'
  | 'FOUND_FUZZY'
  | 'FOUND_AFTER_QUOTE_NORM'
  | 'NOT_FOUND';

/** A repair targets a quasi-unique damaged token; more matches than this means the
 *  edit is a global grammar/style rewrite and is rejected as SUSPICIOUS_GLOBAL. */
const MULTI_CAP = 3;

export interface EditRecord {
  find: string;
  replace: string;
  status: EditStatus;
  count?: number;      // MULTI: how many occurrences replaced
  span?: string;       // FOUND_FUZZY / FOUND_AFTER_QUOTE_NORM: the actual matched span
}

const QUOTE_CHARS = new Set(['“', '”', '‘', '’', '"', "'"]);
const QUOTE_CLASS = '[“”‘’"\']';

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function hasLetter(s: string): boolean {
  return /[A-Za-zÀ-ÿ]/.test(s);
}

function letterCount(s: string): number {
  const m = s.match(/[A-Za-zÀ-ÿ]/g);
  return m ? m.length : 0;
}

/**
 * Length-preserving quote straightening for the step-6 match fallback ONLY: each
 * mapped character is replaced by exactly one character, so an index into the
 * normalized text is a valid index into the original. Deliberately NARROWER than
 * normalizeQuotes — no ‘‘/’’ pair collapse (2→1) and no …→... (1→3), because those
 * change length and would corrupt the index-based splice. Pairs/ellipses that
 * differ between find and text simply stay NOT_FOUND, which is the safe outcome.
 */
function normalizeQuotesCharwise(s: string): string {
  return s.replace(/[“”„«»]/g, '"').replace(/[‘’‚]/g, "'");
}

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LETTER = /[A-Za-zÀ-ÿ]/;
const ALNUM = /[A-Za-zÀ-ÿ0-9]/;

/**
 * Word-boundary lookarounds for a find string: when the find STARTS with a letter
 * or digit, a match may not be preceded by a letter/digit; when it ENDS with one,
 * it may not be followed by one. Letters: stops `find:"is"` from matching inside
 * "punished"/"this"/"seismic" (Killing America incident #1: a MULTI replace-all of
 * a 2-char find corrupted a whole chapter mid-word). Digits: stops `find:"8"` from
 * matching inside "1985" (incident #2: the model freelancing footnote-marker
 * removal with bare-digit edits). Finds edged by symbols (footnote-glyph strips
 * like `≤∑`) keep plain substring semantics on that edge.
 */
function boundaryLookarounds(find: string): { pre: string; post: string } {
  return {
    pre: ALNUM.test(find[0]) ? String.raw`(?<![A-Za-zÀ-ÿ0-9])` : '',
    post: ALNUM.test(find[find.length - 1]) ? String.raw`(?![A-Za-zÀ-ÿ0-9])` : '',
  };
}

const QUOTE_STRIP = /[“”‘’‚„«»"']/g;

/** Exact matcher, letter-boundary-guarded at letter edges. */
function buildExactRegex(find: string): RegExp {
  const { pre, post } = boundaryLookarounds(find);
  return new RegExp(pre + escapeRegex(find) + post, 'g');
}

/** Build a whitespace- and quote-tolerant regex from an exact `find` string,
 *  with the same letter-boundary guards as the exact matcher. */
function buildFuzzyRegex(find: string): RegExp {
  const out: string[] = [];
  let i = 0;
  while (i < find.length) {
    const c = find[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < find.length && /\s/.test(find[j])) j++;
      out.push('\\s+');
      i = j;
    } else if (QUOTE_CHARS.has(c)) {
      out.push(QUOTE_CLASS);
      i++;
    } else {
      out.push(escapeRegex(c));
      i++;
    }
  }
  const { pre, post } = boundaryLookarounds(find);
  return new RegExp(pre + out.join('') + post, 'g');
}

/** Plain Levenshtein distance (iterative two-row DP). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Apply an edit list to a chunk with the five-disposition guarded applier proven
 * as variant C. Prose DELETION is structurally impossible (LETTER_DELETION_BLOCKED),
 * INSERTION is capped (INSERTION_BLOCKED — catches fabricated-sentence appends),
 * and any `find` the model mis-copied fails the exact/fuzzy/quote-norm match ladder
 * and is discarded (NOT_FOUND). A discarded edit means the original text stands —
 * silently correct by construction, but every disposition is RECORDED.
 */
export function applyEditList(
  chunk: string,
  edits: Array<{ find?: unknown; replace?: unknown }>
): { text: string; records: EditRecord[] } {
  const records: EditRecord[] = [];
  let text = chunk;

  for (const ed of edits) {
    const find = typeof ed?.find === 'string' ? ed.find : '';
    const replace = typeof ed?.replace === 'string' ? ed.replace : '';
    const rec: EditRecord = { find, replace, status: 'NOOP' };

    // 1. NOOP — empty find or find===replace changes nothing.
    if (!find || find === replace) { rec.status = 'NOOP'; records.push(rec); continue; }

    // 2. LETTER_DELETION_BLOCKED — replacing a letter-bearing find with blank
    //    would delete prose. The whole point of the edit-list format.
    if (replace.trim() === '' && hasLetter(find)) { rec.status = 'LETTER_DELETION_BLOCKED'; records.push(rec); continue; }

    // 2b. Space-only edits are exempt from every content guard: when find and
    //     replace carry the IDENTICAL character sequence ignoring whitespace,
    //     the edit can only split merged words (`aboastful`→`a boastful`) or
    //     join split ones — no content added, none removed, provably safe.
    //     Without this exemption the insertion guard (word count grows) blocks
    //     the single most common repairable OCR damage after digit swaps.
    const spaceOnlyEdit = find.replace(/\s+/g, '') === replace.replace(/\s+/g, '') && replace.trim() !== '';

    // 3. INSERTION_BLOCKED — replace grows the text (more words, or >8 chars
    //    longer): catches fabricated-sentence appends smuggled through `replace`.
    if (!spaceOnlyEdit && (wordCount(replace) > wordCount(find) || replace.length > find.length + 8)) {
      rec.status = 'INSERTION_BLOCKED'; records.push(rec); continue;
    }

    // 3b. DELETION_BLOCKED — letter-mass invariant. A character repair changes
    //     letters ~1:1 and a footnote strip removes only digits/symbols, so the
    //     replace may never carry meaningfully fewer LETTERS than the find. This
    //     closes the loophole where a long letter-bearing find with a short
    //     non-empty replace slips past guard 2 and deletes prose.
    if (letterCount(replace) < letterCount(find) - 3) {
      rec.status = 'DELETION_BLOCKED'; records.push(rec); continue;
    }

    // 3c. DRIFT_BLOCKED — a repair fixes a few characters; it does not turn one
    //     word into a different word. Cap the edit distance relative to the find
    //     ('censored'→'canceled' and 'Disney'→'defend' were real 14b drift edits
    //     that passed every mass/size guard). Glyph strips and 1-2 char repairs
    //     sit well under the cap.
    if (levenshtein(find, replace) > Math.max(2, Math.ceil(find.length / 4))) {
      rec.status = 'DRIFT_BLOCKED'; records.push(rec); continue;
    }

    // 3d'. DIGIT_MUTATION_BLOCKED — same NUMBER of digits but different VALUES is
    //     the model rewriting a number, not repairing a scan (`’70s`→`'90s` changed
    //     a decade in Killing America; drift distance 1, invisible to 3c). Repairs
    //     that add/remove digits survive: c0nver→conver drops one, 1O0→100 gains one.
    {
      const fd = (find.match(/\d/g) || []).join('');
      const rd = (replace.match(/\d/g) || []).join('');
      if (fd && rd && fd.length === rd.length && fd !== rd) {
        rec.status = 'DIGIT_MUTATION_BLOCKED'; records.push(rec); continue;
      }
    }

    // 3d. QUOTE_EDIT_BLOCKED — an edit whose find and replace differ ONLY in
    //     quote/apostrophe characters is quote punctuation fiddling, which the
    //     deterministic pre-pass already owns. Killing America: the source read
    //     `'70s` (author's decade apostrophe); the model proposed find:"70s" →
    //     replace:"'70s" and the applier pasted a second apostrophe: `''70s`.
    if (find.replace(QUOTE_STRIP, '') === replace.replace(QUOTE_STRIP, '')) {
      rec.status = 'QUOTE_EDIT_BLOCKED'; records.push(rec); continue;
    }

    // 3e. NUMERIC_EDIT_BLOCKED — a find containing digits but NO letters is never
    //     a scanner-damage repair (damage-in-a-word always carries letters; pure
    //     numbers are years/quantities/markers). Killing America: the model tried
    //     to remove leftover footnote markers itself with edits like '9'→'and',
    //     '6'→'However', '8'→'' — marker removal is the pre-pass's job, never the
    //     model's.
    if (/\d/.test(find) && !hasLetter(find)) {
      rec.status = 'NUMERIC_EDIT_BLOCKED'; records.push(rec); continue;
    }

    // 4. Exact match, letter-boundary-guarded: a find that starts/ends with a
    //    letter may not match inside a word — `find:"is"` must never touch
    //    "punished"/"this"/"seismic" (the Killing America incident). Replacement
    //    is by index splice, so a `$` in the model's replace stays literal.
    let exactMatches: RegExpMatchArray[] = [];
    try { exactMatches = [...text.matchAll(buildExactRegex(find))]; } catch { exactMatches = []; }
    if (exactMatches.length > MULTI_CAP) {
      // 4b. A scanner-damaged token is quasi-unique; a find hitting many
      //     occurrences is a global rewrite (grammar/style), not a repair.
      rec.status = 'SUSPICIOUS_GLOBAL'; rec.count = exactMatches.length; records.push(rec); continue;
    }
    if (exactMatches.length >= 1) {
      for (let k = exactMatches.length - 1; k >= 0; k--) {
        const m = exactMatches[k];
        const start = m.index!;
        text = text.slice(0, start) + replace + text.slice(start + m[0].length);
      }
      if (exactMatches.length > 1) { rec.status = 'MULTI'; rec.count = exactMatches.length; }
      else { rec.status = 'APPLIED'; }
      records.push(rec); continue;
    }

    // 5. Fuzzy: whitespace/quote tolerant, applied ONLY if exactly one match.
    let fuzzyMatches: RegExpMatchArray[] = [];
    try { fuzzyMatches = [...text.matchAll(buildFuzzyRegex(find))]; } catch { fuzzyMatches = []; }
    if (fuzzyMatches.length === 1) {
      const m = fuzzyMatches[0];
      const span = m[0];
      // Re-check the insertion guard against the ACTUAL matched span (the
      //  space-only exemption transfers: identical letters, only spacing moves).
      const spanSpaceOnly = span.replace(/\s+/g, '') === replace.replace(/\s+/g, '') && replace.trim() !== '';
      if (!spanSpaceOnly && (wordCount(replace) > wordCount(span) || replace.length > span.length + 8)) {
        rec.status = 'INSERTION_BLOCKED'; rec.span = span; records.push(rec); continue;
      }
      const start = m.index ?? text.indexOf(span);
      text = text.slice(0, start) + replace + text.slice(start + span.length);
      rec.status = 'FOUND_FUZZY'; rec.span = span; records.push(rec); continue;
    }

    // 6. Quote-normalized fallback. MUST use the charwise (length-preserving)
    //    straightener, NOT normalizeQuotes: ‘‘→" (2→1) and …→... (1→3) shift every
    //    index after them, and this branch splices by index. With the charwise map
    //    an index into nt is a valid index into text, and span length === find length.
    const nf = normalizeQuotesCharwise(find);
    const nt = normalizeQuotesCharwise(text);
    const j = nt.indexOf(nf);
    const qnormBoundaryOk = j >= 0 &&
      !(LETTER.test(find[0]) && j > 0 && LETTER.test(text[j - 1])) &&
      !(LETTER.test(find[find.length - 1]) && j + find.length < text.length && LETTER.test(text[j + find.length]));
    if (qnormBoundaryOk && nt.indexOf(nf, j + 1) < 0) { // unambiguous single match, word-bounded
      const origSpan = text.slice(j, j + find.length);
      text = text.slice(0, j) + replace + text.slice(j + origSpan.length);
      rec.status = 'FOUND_AFTER_QUOTE_NORM'; rec.span = origSpan; records.push(rec); continue;
    }

    rec.status = 'NOT_FOUND';
    records.push(rec);
  }

  return { text, records };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) { count++; idx = haystack.indexOf(needle, idx + needle.length); }
  return count;
}

/**
 * Pull the first balanced {...} object out of a string, ignoring braces inside
 * JSON string literals. Returns the substring, or null. Mirrors first_json_object
 * in the probes so a model that wraps the object in prose/fences still parses.
 */
export function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
  }
  return null;
}
