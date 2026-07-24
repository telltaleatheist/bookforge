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
    const hi = Math.min(3, Math.max(1, String(Math.trunc(p.max_value ?? 99)).length));
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

  // INVARIANT: never immediately followed by a letter → never mid-word.
  const pattern = lb + core + String.raw`(?![A-Za-z])` + followedByLookahead(p.followed_by);
  return new RegExp(pattern, 'g');
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
export function deriveArabicAnchors(text: string, maxDigits: number, fb: string | undefined): string | null {
  // Capture the anchor char (group 1) via a capturing group inside the lookbehind.
  const pat = new RegExp(
    String.raw`(?<=[^\d0-9]([${ALL_ANCHOR_CLASS}]))\d{1,${maxDigits}}(?![A-Za-z])` + followedByLookahead(fb),
    'g'
  );
  const matches = [...text.matchAll(pat)];
  if (matches.length === 0) return null;
  const values = matches.map(m => parseInt(m[0], 10));
  const perfect = values.every((v, i) => v === i + 1);
  if (!perfect) return null;
  const observed = new Set<string>();
  for (const m of matches) observed.add(m[1]);
  return escapeForClass([...observed].join(''));
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
    return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: 'model reported has_markers=false' };
  }
  const total = p.total_in_chapter;
  if (typeof total !== 'number' || total <= 0) {
    return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: `unusable total_in_chapter (${JSON.stringify(total)})` };
  }

  let regex: RegExp;
  try {
    regex = composeFootnoteRegex(p);
  } catch (e) {
    return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: `compose failed: ${(e as Error).message}` };
  }

  let matches = [...chapterText.matchAll(regex)];
  let derivedAnchors = false;

  // Model anchors matched nothing but it IS arabic → derive from the sequence.
  if (matches.length === 0 && (p.marker_type || 'arabic') === 'arabic') {
    const hi = Math.min(3, Math.max(1, String(Math.trunc(p.max_value ?? 99)).length));
    const derivedCls = deriveArabicAnchors(chapterText, hi, p.followed_by);
    if (derivedCls) {
      try {
        regex = composeFootnoteRegex(p, derivedCls);
        matches = [...chapterText.matchAll(regex)];
        derivedAnchors = true;
      } catch (e) {
        return { ...base, applied: false, regex: null, matchCount: 0, derivedAnchors: false, reason: `derived compose failed: ${(e as Error).message}` };
      }
    }
  }

  // Self-check 1: count must equal the model's reported total.
  if (matches.length !== total) {
    return { ...base, applied: false, regex: null, matchCount: matches.length, derivedAnchors, reason: `count mismatch: regex found ${matches.length}, model reported ${total}` };
  }
  // Self-check 2: arabic + sequential values must form a perfect 1..N.
  if ((p.marker_type || 'arabic') === 'arabic' && p.sequential) {
    const values = matches.map(m => parseInt(m[0], 10));
    const perfect = values.every((v, i) => v === i + 1);
    if (!perfect) {
      return { ...base, applied: false, regex: null, matchCount: matches.length, derivedAnchors, reason: `values do not form 1..N: [${values.join(',')}]` };
    }
  }

  // PASS. Return a fresh regex (matchAll consumed lastIndex is irrelevant for a
  // /g regex used via replace, but hand back a clean one to be safe).
  return {
    ...base,
    applied: true,
    regex: new RegExp(regex.source, 'g'),
    matchCount: matches.length,
    derivedAnchors,
    reason: derivedAnchors
      ? `PASS (anchors derived from sequence): ${matches.length} markers`
      : `PASS: ${matches.length} markers`,
  };
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
  | 'INSERTION_BLOCKED'
  | 'APPLIED'
  | 'MULTI'
  | 'FOUND_FUZZY'
  | 'FOUND_AFTER_QUOTE_NORM'
  | 'NOT_FOUND';

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

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build a whitespace- and quote-tolerant regex from an exact `find` string. */
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
  return new RegExp(out.join(''), 'g');
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

    // 3. INSERTION_BLOCKED — replace grows the text (more words, or >8 chars
    //    longer): catches fabricated-sentence appends smuggled through `replace`.
    if (wordCount(replace) > wordCount(find) || replace.length > find.length + 8) {
      rec.status = 'INSERTION_BLOCKED'; records.push(rec); continue;
    }

    // 4. Exact substring.
    if (text.includes(find)) {
      const cnt = countOccurrences(text, find);
      if (cnt > 1) { text = text.split(find).join(replace); rec.status = 'MULTI'; rec.count = cnt; }
      else { text = text.replace(find, replace); rec.status = 'APPLIED'; }
      records.push(rec); continue;
    }

    // 5. Fuzzy: whitespace/quote tolerant, applied ONLY if exactly one match.
    let fuzzyMatches: RegExpMatchArray[] = [];
    try { fuzzyMatches = [...text.matchAll(buildFuzzyRegex(find))]; } catch { fuzzyMatches = []; }
    if (fuzzyMatches.length === 1) {
      const m = fuzzyMatches[0];
      const span = m[0];
      // Re-check the insertion guard against the ACTUAL matched span.
      if (wordCount(replace) > wordCount(span) || replace.length > span.length + 8) {
        rec.status = 'INSERTION_BLOCKED'; rec.span = span; records.push(rec); continue;
      }
      const start = m.index ?? text.indexOf(span);
      text = text.slice(0, start) + replace + text.slice(start + span.length);
      rec.status = 'FOUND_FUZZY'; rec.span = span; records.push(rec); continue;
    }

    // 6. Quote-normalized fallback (length-preserving straighten-then-find).
    const nf = normalizeQuotes(find);
    const nt = normalizeQuotes(text);
    const j = nt.indexOf(nf);
    if (j >= 0) {
      const origSpan = text.slice(j, j + find.length); // qnorm preserves length 1:1
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
