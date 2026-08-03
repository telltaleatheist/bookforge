/**
 * ocr's edit contract — derive edits from a pair, apply them, and prove the
 * applier can never invent text.
 *
 *   node tools/foundry-ocr/edits.mjs --self-test
 *
 * WHY THIS FILE EXISTS AT ALL. blocks labels a block and footnotes deletes from
 * one; both are safe by construction — a wrong label narrates the wrong thing,
 * a wrong deletion drops a character. ocr REWRITES prose that then becomes
 * the EPUB and the narration, so a hallucinated word ships to the listener as
 * though the author wrote it. The model is not what makes that safe. This is.
 *
 * The format is the footnotes model's, deliberately — one `before → after` per line, the
 * bare word `none` for a clean block — so both models parse the same way and
 * share one serving stack.
 *
 *     tbe rnain → the main
 *     none
 *
 * FOUR RULES, each rejecting rather than guessing. An edit that breaks any of
 * them is dropped and counted; the block keeps its original text. Silence is
 * always the safe failure here, because the input is already readable.
 *
 *   1. `before` must occur VERBATIM in the block. The model has to copy what it
 *      wants to change, which is the same anchor discipline the footnotes model proved: it
 *      cannot edit a region it could not quote.
 *   2. `before` must occur EXACTLY ONCE. Positions are not in the format — they
 *      are the thing a model gets wrong most often and a reader can check
 *      least — so uniqueness is what makes application deterministic without
 *      them. A repeated anchor is ambiguous, and ambiguous means rejected.
 *   3. Edits may not OVERLAP. Two edits claiming the same characters have no
 *      defined result, so neither is applied.
 *   4. An edit may not be a REWRITE. `before` is capped at MAX_BEFORE chars and
 *      the whole edit set may not change more than MAX_CHANGED_FRACTION of the
 *      block. This is the rule the footnotes model did not need and ocr cannot do
 *      without: substitution can say anything, so the budget — not the model's
 *      good intentions — is what keeps a repair from becoming a paraphrase.
 *
 * Rule 4 is deliberately blunt. A block so damaged that fixing it means
 * changing a quarter of its characters is not a block this format should be
 * repairing — §9b's fallback for those is full-text output on low-confidence
 * blocks, and the corpus builder drops them rather than teaching the model that
 * wholesale rewriting is in scope.
 *
 * DERIVATION IS THE SAME CONTRACT, RUN BACKWARDS. deriveEdits() only emits edit
 * sets that applyEdits() accepts and that reproduce the truth EXACTLY — it
 * verifies by applying its own output before returning it. So a corpus built
 * through this file cannot contain a target the applier would reject, and the
 * training data and the runtime guarantee cannot drift apart.
 */

export const ARROW = /\s*(?:→|->)\s*/;

export const LIMITS = {
  /** Longest anchor a single edit may quote. Long enough for a phrase with
   *  context, short enough that no edit can swallow a sentence. */
  MAX_BEFORE: 80,
  /** Equal characters between two damaged runs before they stop being one edit.
   *  "tbe rnain" is one error to a reader and should be one edit to the model. */
  MERGE_GAP: 6,
  /** Total fraction of the block's characters the edit set may touch. */
  MAX_CHANGED_FRACTION: 0.25,
  /** …but never below this many characters. Without a floor the fraction alone
   *  rejects correct work on short blocks: expanding two ligatures in a
   *  ten-character caption legitimately touches 40% of it. A rewrite worth
   *  fearing is a sentence, and a sentence is far longer than this. */
  MIN_CHANGED_ABS: 12,
  /** Give up deriving past this many character-level differences: the pair is
   *  too far apart to be a recognition error, and is almost always a broken
   *  alignment rather than a broken scan. */
  MAX_DIFF: 400,
};

// ── diff ────────────────────────────────────────────────────────────────────
/**
 * Myers O(ND) diff over characters, returning opcodes against `a` and `b`.
 *
 * O(ND) rather than the textbook O(NM) DP because D — the number of differing
 * characters — is the small quantity here: measured OCR is 97-99% correct, so
 * the grid is nearly all diagonal and the greedy walk touches almost none of
 * it. On a whole-block DP the same job allocates a matrix per row.
 */
export function diffOpcodes(a, b, maxD = LIMITS.MAX_DIFF) {
  const N = a.length, M = b.length;
  const max = Math.min(maxD, N + M);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let done = -1;

  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= N && y >= M) { done = d; break outer; }
    }
  }
  if (done < 0) return null;   // beyond maxD — caller drops the pair

  // Walk the trace back to a concrete script.
  const ops = [];
  let x = N, y = M;
  for (let d = done; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vPrev[offset + k - 1] < vPrev[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(['equal', --x, --y]); }
    if (x > prevX) ops.push(['delete', --x, y]);
    else if (y > prevY) ops.push(['insert', x, --y]);
  }
  while (x > 0 && y > 0) ops.push(['equal', --x, --y]);
  ops.reverse();

  // Collapse the per-character script into runs.
  const out = [];
  for (const [tag, i, j] of ops) {
    const last = out[out.length - 1];
    if (last && last.tag === tag) { last.i2 = i + (tag === 'insert' ? 0 : 1); last.j2 = j + (tag === 'delete' ? 0 : 1); continue; }
    out.push({ tag, i1: i, i2: i + (tag === 'insert' ? 0 : 1), j1: j, j2: j + (tag === 'delete' ? 0 : 1) });
  }
  return out;
}

// ── derivation ──────────────────────────────────────────────────────────────
/**
 * ocr + truth -> the edit list that turns one into the other, or null.
 *
 * Returns `{ edits, changed }` where `edits` is [] for an already-correct block
 * (the identity row that teaches restraint) — or null when no edit set
 * satisfying the contract reproduces the truth, in which case the caller must
 * DROP the pair rather than weaken the rules to fit it.
 */
export function deriveEdits(ocr, truth, limits = LIMITS) {
  if (ocr === truth) return { edits: [], changed: 0 };

  const ops = diffOpcodes(ocr, truth, limits.MAX_DIFF);
  if (!ops) return null;

  // Damaged runs, with short stretches of intact text folded in: a reader sees
  // "tbe rnain" as one mistake, and splitting it into two edits teaches the
  // model to emit anchors too short to be unique.
  // Only damage opens or extends a run. Letting `equal` ops extend one was the
  // first bug this file's self-test caught: the intact tail of every block got
  // folded into the final edit, which then blew the change budget and threw the
  // pair away — a silent 100% loss that looked like "the format doesn't fit".
  // The gap folding still happens, because the NEXT damaged run is what asks
  // whether it is close enough to join the previous one.
  const runs = [];
  for (const op of ops) {
    if (op.tag === 'equal') continue;
    const last = runs[runs.length - 1];
    if (last && op.i1 - last.i2 <= limits.MERGE_GAP) {
      last.i2 = Math.max(last.i2, op.i2);
      last.j2 = Math.max(last.j2, op.j2);
    } else {
      runs.push({ i1: op.i1, i2: op.i2, j1: op.j1, j2: op.j2 });
    }
  }
  if (!runs.length) return null;

  const edits = [];
  let changed = 0;
  for (const r of runs) {
    let { i1, i2, j1, j2 } = r;
    let before = ocr.slice(i1, i2);
    let after = truth.slice(j1, j2);

    // Widen symmetrically until the anchor is unique AND has no whitespace at
    // its edges. The added characters are equal on both sides by construction,
    // so widening never changes what the edit MEANS — only how findable it is.
    //
    // The whitespace condition is the wire format's, not the applier's: lines
    // are trimmed on parse and the arrow eats the space around itself, so
    // ` the ` → ` ` arrives as `the` → `` and deletes the wrong thing. Spacing
    // is a real OCR error class, so the fix is to widen past the space rather
    // than to refuse the pair — `e the c` → `e c` says the same thing and
    // survives the round trip.
    const needsWidening = () => before === '' || after === ''
      || occurrences(ocr, before) !== 1
      || /^\s|\s$/.test(before) || /^\s|\s$/.test(after);
    // ALTERNATE sides. Growing left-first looks equivalent and is not: an
    // insertion starts as a zero-width anchor, and one-directional growth made
    // it drag in the entire line prefix before it could reach a character on
    // the right that ended the whitespace — turning a four-character insert
    // into a twenty-character anchor that then failed the rewrite budget.
    let guard = 0;
    let goLeft = true;
    while (needsWidening()
           && before.length < limits.MAX_BEFORE
           && guard++ < 2 * limits.MAX_BEFORE) {
      const canLeft = i1 > 0 && j1 > 0;
      const canRight = i2 < ocr.length && j2 < truth.length;
      if (!canLeft && !canRight) break;
      if (goLeft && canLeft) { i1--; j1--; }
      else if (canRight) { i2++; j2++; }
      else { i1--; j1--; }
      goLeft = !goLeft;
      before = ocr.slice(i1, i2);
      after = truth.slice(j1, j2);
    }
    if (needsWidening()) return null;
    if (before.length > limits.MAX_BEFORE) return null;
    // The arrow is the format's only reserved sequence; an anchor containing it
    // would not survive a round trip through the wire format.
    if (ARROW.test(before) || ARROW.test(after)) return null;
    // A newline inside an anchor would break the one-edit-per-line format.
    if (/[\r\n]/.test(before) || /[\r\n]/.test(after)) return null;

    edits.push({ before, after, at: i1 });
    changed += Math.max(before.length, after.length);
  }

  edits.sort((p, q) => p.at - q.at);
  for (let i = 1; i < edits.length; i++) {
    // Overlap after widening: two anchors grew into each other, so the pair
    // needs one wider edit rather than two, and deriving that is not worth a
    // special case — drop it.
    if (edits[i].at < edits[i - 1].at + edits[i - 1].before.length) return null;
  }
  if (overBudget(changed, ocr.length, limits)) return null;

  const clean = edits.map(({ before, after }) => ({ before, after }));

  // The verification that makes this file's promise real: derivation is only
  // trusted if the applier — the same code that will run in production —
  // reproduces the truth exactly from it.
  const check = applyEdits(ocr, clean, limits);
  if (!check.ok || check.text !== truth) return null;

  return { edits: clean, changed };
}

/** The rewrite guard, in one place so derivation and application cannot drift. */
function overBudget(changed, length, limits = LIMITS) {
  if (changed <= limits.MIN_CHANGED_ABS) return false;
  return length > 0 && changed / length > limits.MAX_CHANGED_FRACTION;
}

function occurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    if (n > 1) return n;          // callers only ever ask "exactly one?"
    i = at + 1;
  }
}

// ── application ─────────────────────────────────────────────────────────────
/**
 * Apply an edit list to a block. This is the runtime path, and it is the only
 * thing standing between a model's output and the reader's ears.
 *
 * -> { ok, text, applied, rejected: [{ before, why }] }
 *
 * `ok` is false when ANY edit was rejected. Callers may still use `text` — the
 * accepted edits are individually safe — but a rejection means the model failed
 * to copy, which costs recall silently, so it is reported rather than swallowed.
 */
export function applyEdits(text, edits, limits = LIMITS) {
  const rejected = [];
  const claims = [];

  for (const e of edits ?? []) {
    const before = e?.before ?? '';
    const after = e?.after ?? '';
    if (!before) { rejected.push({ before, why: 'empty anchor' }); continue; }
    if (before.length > limits.MAX_BEFORE) { rejected.push({ before, why: `anchor over ${limits.MAX_BEFORE} chars` }); continue; }
    const first = text.indexOf(before);
    if (first < 0) { rejected.push({ before, why: 'not present in the block' }); continue; }
    if (text.indexOf(before, first + 1) >= 0) { rejected.push({ before, why: 'occurs more than once' }); continue; }
    claims.push({ at: first, before, after });
  }

  claims.sort((a, b) => a.at - b.at);
  const kept = [];
  for (const c of claims) {
    const prev = kept[kept.length - 1];
    if (prev && c.at < prev.at + prev.before.length) { rejected.push({ before: c.before, why: 'overlaps an earlier edit' }); continue; }
    kept.push(c);
  }

  const changed = kept.reduce((n, c) => n + Math.max(c.before.length, c.after.length), 0);
  if (overBudget(changed, text.length, limits)) {
    // Not per-edit: individually modest edits can still add up to a rewrite,
    // and it is the total that decides whether this is repair or replacement.
    return {
      ok: false, text, applied: 0,
      rejected: kept.map((c) => ({ before: c.before, why: 'edit set exceeds the block change budget' })).concat(rejected),
    };
  }

  let out = text;
  for (let i = kept.length - 1; i >= 0; i--) {
    const c = kept[i];
    out = out.slice(0, c.at) + c.after + out.slice(c.at + c.before.length);
  }
  return { ok: rejected.length === 0, text: out, applied: kept.length, rejected };
}

// ── wire format ─────────────────────────────────────────────────────────────
export function formatEdits(edits) {
  if (!edits?.length) return 'none';
  return edits.map((e) => `${e.before} → ${e.after}`).join('\n');
}

/** -> { edits, bad } — `bad` counts lines that were not parseable at all. */
export function parseEdits(text) {
  const raw = String(text ?? '').trim();
  if (!raw || /^none$/i.test(raw)) return { edits: [], bad: 0 };
  const edits = [];
  let bad = 0;
  for (const ln of raw.split('\n')) {
    const line = ln.trim();
    if (!line || /^none$/i.test(line)) continue;
    const parts = line.split(ARROW);
    if (parts.length !== 2 || !parts[0]) { bad++; continue; }
    edits.push({ before: parts[0], after: parts[1] });
  }
  return { edits, bad };
}

// ── self-test ───────────────────────────────────────────────────────────────
/**
 * Every case here is a way this could ship damage to a listener, not a way it
 * could fail a unit test. The adversarial half — the last six — matter more
 * than the happy path: they are the model emitting something wrong, and each
 * one asserts the text survives unchanged rather than asserting an error.
 */
const CASES = [
  ['identity', 'The quick brown fox.', 'The quick brown fox.'],
  ['one word', 'The quick brovn fox.', 'The quick brown fox.'],
  ['two errors', 'Tbe quick brovn fox.', 'The quick brown fox.'],
  ['adjacent damage', 'tbe rnain street', 'the main street'],
  ['repeated word, unique anchor', 'the cat sat on the rnat', 'the cat sat on the mat'],
  ['insertion', 'the cat sat on mat', 'the cat sat on the mat'],
  ['deletion', 'the the cat sat', 'the cat sat'],
  ['diacritic', 'Uber den Berg', 'Über den Berg'],
  ['ligature', 'ﬁrst ﬂight', 'first flight'],
  ['hyphen wrap kept', 'inter-\nnational', 'inter-\nnational'],
  ['long block', 'a'.repeat(400) + ' bistory ' + 'b'.repeat(400), 'a'.repeat(400) + ' history ' + 'b'.repeat(400)],
];

function selfTest() {
  let fail = 0;
  const ok = (name, cond, detail = '') => {
    if (!cond) { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
    else console.log(`  ok    ${name}`);
  };

  console.log('derive → format → parse → apply == truth');
  for (const [name, ocr, truth] of CASES) {
    const d = deriveEdits(ocr, truth);
    if (!d) { ok(name, false, 'derivation returned null'); continue; }
    const round = parseEdits(formatEdits(d.edits));
    const applied = applyEdits(ocr, round.edits);
    ok(name, applied.ok && applied.text === truth,
      applied.text === truth ? '' : `got ${JSON.stringify(applied.text.slice(0, 60))}`);
  }

  console.log('\nthe applier refuses what it cannot verify');
  const T = 'the cat sat on the mat';

  let r = applyEdits(T, [{ before: 'dog', after: 'cat' }]);
  ok('anchor absent → rejected, text untouched', !r.ok && r.text === T && r.applied === 0);

  r = applyEdits(T, [{ before: 'the', after: 'a' }]);
  ok('anchor ambiguous → rejected, text untouched', !r.ok && r.text === T && r.applied === 0);

  r = applyEdits(T, [{ before: 'cat sat', after: 'dog sat' }, { before: 'sat on', after: 'sat in' }]);
  ok('overlapping edits → one applied, one rejected',
    !r.ok && r.applied === 1 && r.rejected.length === 1);

  r = applyEdits(T, [{ before: 'cat', after: 'cat, which had been sleeping all afternoon,' }]);
  ok('edit set over budget → rejected, text untouched', !r.ok && r.text === T);

  r = applyEdits(T, [{ before: 'mat', after: 'hat' }, { before: 'nope', after: 'x' }]);
  ok('one good edit survives a bad sibling', r.text === 'the cat sat on the hat' && !r.ok);

  const p = parseEdits('tbe → the\ngarbage line without an arrow\nrnain → main');
  ok('unparseable line counted, not guessed', p.edits.length === 2 && p.bad === 1);

  r = applyEdits(T, parseEdits('none').edits);
  ok('`none` is a no-op', r.ok && r.text === T && r.applied === 0);

  console.log('\nderivation refuses pairs the format cannot carry');
  ok('wholesale rewrite → null',
    deriveEdits('the cat sat on the mat', 'a dog stood beneath a tree') === null);
  ok('empty vs long → null', deriveEdits('x', 'the quick brown fox jumps over') === null);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  return fail;
}

if (process.argv[1] && process.argv[1].endsWith('edits.mjs')) {
  if (process.argv.includes('--self-test')) process.exit(selfTest() ? 1 : 0);
  console.error('usage: node tools/foundry-ocr/edits.mjs --self-test');
  process.exit(1);
}
