#!/usr/bin/env node
/**
 * test-text-normalization.js — the SHARED fixture set, run against this app's
 * own deterministic narration stages.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-text-normalization.js
 *
 * ── Why these cases are not ours ────────────────────────────────────────────
 *
 * `tools/fixtures/text-normalization-cases.json` began as a copy of
 * `pipeline/normalization/fixtures/cases.json` from the orpheus-finetune
 * checkout, case ids kept. The training corpora and this app are meant to run
 * ONE text-normalization definition, so both sides are judged on the same file:
 * a case that one side passes and the other fails is a disagreement about the
 * SPEC, not about which examples anyone chose.
 *
 * ── THE TWO FILES HAVE DIVERGED, AND THIS IS THE LEDGER OF IT ───────────────
 *
 * As of 2026-09-04 this file holds **104** cases against their **53**, and until
 * their `cases.json` is updated the corpora and the renders normalize
 * DIFFERENTLY — by design, from rulings they have not mirrored yet, not by
 * accident. What the training side owes:
 *
 *   FOUR EXPECTATIONS TO CHANGE, all from Owen's ruling revising the
 *   leave-as-printed list, and all four are exactly what
 *   `run_fixtures.js --compare` reports as differences:
 *     leave-page-cite   "pp. 65-71" and "p. 23" are READ now
 *     leave-doc-code    the page reference beside the document code is read
 *     leave-glued       B-17 / COVID-19 / R2D2 are read
 *     leave-archive     their `known_defect`, FIXED here (isArchiveSigil)
 *
 *   FIFTY-ONE CASES TO ADD, every one marked `added_in` with the ruling or the
 *   review row it came from: the cross-chapter scripture range, the archive
 *   sigil's opposite direction, the page and glued readings, the unit suffixes,
 *   the `<br/>`-fused ordinals, and the year/decade/ordinal shapes the glued
 *   rule must leave to the model.
 *
 * Nothing here silently changed one of their cases: every divergence is one of
 * those 55, and each carries `changed_in` / `added_in` / `fixed_in` saying why.
 *
 * ── What each stage tag means ───────────────────────────────────────────────
 *
 *   punct   the punctuation pass ALONE must produce `want`.
 *   rules   punctuation + the deterministic number rules must produce `want`.
 *   leave   the deterministic pass must leave the text EXACTLY as printed. A
 *           case that changes here is the expensive failure: an unspeakable code
 *           read out loud.
 *   model   the deterministic pass must leave it ALONE. `want` is what the
 *           prompt instructs the model to produce, and no model runs here — the
 *           rules decline four-digit years, ranges and bare decimals on purpose,
 *           because only the sentence says whether 1200 is a year or a count.
 *           So the assertion is "punctuation-only output", never `want`.
 *
 * The chaining below is the SAME order the narration text pass uses
 * (`electron/narration-text-pass.ts`): punctuation first, then the number rules,
 * then — in the live pass and not here — the model on whatever digits are left.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const punct = require('../dist/electron/tts-punctuation.js');
const rules = require('../dist/electron/tts-number-rules.js');

const CASES = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'text-normalization-cases.json'), 'utf8'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** Stage 1 alone. */
const stagePunct = (text) => punct.canonicalizePunctuation(text).text;

/** Stage 1 then stage 2 — exactly how the narration text pass chains them. */
function deterministic(text) {
  const canonical = stagePunct(text);
  return rules.applyNumberRules(canonical, [canonical.length]).text;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared cases, each judged against the stage that owns it
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── the shared fixture set ──');

const byStage = {};
for (const c of CASES) {
  const stage = c.stage ?? 'rules';
  byStage[stage] = (byStage[stage] ?? 0) + 1;

  test(`${stage.padEnd(6)} ${c.rule.padEnd(9)} ${c.id}`, () => {
    if (stage === 'punct') {
      assert.strictEqual(stagePunct(c.in), c.want);
      return;
    }
    if (stage === 'model') {
      // The rules are SUPPOSED to decline this one: untouched (modulo the
      // punctuation stage) is the correct deterministic outcome, and a rule that
      // changed it is a rule overreaching into the model's judgement.
      assert.strictEqual(deterministic(c.in), stagePunct(c.in));
      return;
    }
    // 'rules' and 'leave' are the same assertion; 'leave' is the one whose
    // `want` happens to equal its `in`.
    assert.strictEqual(deterministic(c.in), c.want);
  });
}

test('every stage the shared file declares is actually exercised', () => {
  assert.deepStrictEqual(
    Object.keys(byStage).sort(), ['leave', 'model', 'punct', 'rules']);
  assert.ok(CASES.length >= 53, `${CASES.length} cases — the shared set is 53 plus ours`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence — the property that makes re-running the pass safe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ELEVEN PUNCTUATION CASES, BYTE FOR BYTE — the cross-check nothing else does.
 *
 * `run_fixtures.js --compare` on the training side compares the NUMBER cases
 * only: it skips every case tagged `punct`, by design, because that harness
 * exists to prove two number implementations byte-identical. So the branch's
 * central claim — that `electron/tts-punctuation.ts` is the shared spec s1 —
 * has no cross-check over there at all, and this is it over here: the shared
 * fixture file's own `punct` cases, through the COMPILED module, required equal
 * to `want` character for character.
 *
 * Asked for by the fourth adversarial review, 2026-09-04.
 */
test('the shared PUNCT cases are byte-identical through the compiled module', () => {
  const punctCases = CASES.filter((c) => c.stage === 'punct');
  assert.strictEqual(punctCases.length, 11,
    `${punctCases.length} punct cases — the shared file states eleven`);
  for (const c of punctCases) {
    const got = punct.canonicalizePunctuation(c.in).text;
    assert.strictEqual(got, c.want,
      `${c.id}: ${JSON.stringify(c.in)} -> ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`);
    // And byte for byte, not merely equal-looking: the ellipsis and the quote
    // rules are about exact characters.
    assert.deepStrictEqual(
      [...Buffer.from(got, 'utf8')], [...Buffer.from(c.want, 'utf8')], c.id);
  }
});

console.log('\n── idempotence ──');

test('the punctuation stage is idempotent over every case', () => {
  for (const c of CASES) {
    const once = stagePunct(c.in);
    assert.strictEqual(stagePunct(once), once, `${c.id}: ${JSON.stringify(once)}`);
  }
});

test('the deterministic chain is idempotent over every case', () => {
  for (const c of CASES) {
    const once = deterministic(c.in);
    assert.strictEqual(deterministic(once), once, `${c.id}: ${JSON.stringify(once)}`);
  }
});

test('a canonicalized text reports NO rule fired the second time', () => {
  for (const c of CASES) {
    const once = punct.canonicalizePunctuation(c.in).text;
    assert.deepStrictEqual(punct.canonicalizePunctuation(once).counts, {}, c.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The punctuation spec's own edges
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── the punctuation spec ──');

test('exactly two periods are NOT an ellipsis', () => {
  assert.strictEqual(stagePunct('wait.. what'), 'wait.. what');
});

test('every printed ellipsis form lands on the canonical one', () => {
  for (const printed of ['...', '. . .', '.. .', '....', '. . . .', '…', '. . .']) {
    assert.strictEqual(
      stagePunct(`He paused${printed} then went on.`),
      `He paused${punct.CANONICAL_ELLIPSIS} then went on.`,
      JSON.stringify(printed));
  }
});

test('dashes the book printed are kept — em, en, hyphen and a spaced hyphen', () => {
  for (const kept of ['a—b', 'a–b', 'a-b', 'a - b']) {
    assert.strictEqual(stagePunct(kept), kept, JSON.stringify(kept));
  }
});

test('a TYPEWRITER double hyphen becomes the em dash, spaces and all', () => {
  assert.strictEqual(stagePunct('He turned--slowly--and left.'),
    `He turned${punct.CANONICAL_DASH}slowly${punct.CANONICAL_DASH}and left.`);
  // The em-dash convention absorbs whatever spacing the book set around it.
  assert.strictEqual(stagePunct('He turned -- slowly.'),
    `He turned${punct.CANONICAL_DASH}slowly.`);
  // An ASCII rule has nothing but hyphens and line ends around it, and a run at
  // the start of a line has no character before it to anchor the lookbehind.
  assert.strictEqual(stagePunct('-----'), '-----');
  assert.strictEqual(stagePunct('--file book.epub'), '--file book.epub');
});

test('a run of terminal marks keeps ONE, and the question mark wins', () => {
  assert.strictEqual(stagePunct('Oh!!!'), 'Oh!');
  assert.strictEqual(stagePunct('What?!'), 'What?');
  assert.strictEqual(stagePunct('What?!?'), 'What?');
});

test('the rule names the pass can report are the ones it applies', () => {
  const seen = new Set();
  for (const c of CASES) {
    for (const rule of Object.keys(punct.canonicalizePunctuation(c.in).counts)) seen.add(rule);
  }
  for (const rule of seen) {
    assert.ok(punct.PUNCTUATION_RULES.includes(rule), `${rule} is not in PUNCTUATION_RULES`);
  }
});

test('the spec version is the one the record and the stamp will carry', () => {
  assert.strictEqual(punct.PUNCTUATION_SPEC_VERSION, 's1');
  assert.strictEqual(punct.CANONICAL_ELLIPSIS, '...');
  assert.strictEqual(punct.CANONICAL_DASH, '—');
});

test('normalizeQuotes is BookForge\'s own, re-exported and not reimplemented', () => {
  const prepass = require('../dist/electron/ai-cleanup-prepass.js');
  assert.strictEqual(punct.normalizeQuotes, prepass.normalizeQuotes);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ask 2 — an archive sigil in front of a bare integer is citation apparatus
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Ask 2: the archive sigil ──');

test('the reported line is left exactly as the archive prints it', () => {
  const line = 'HSG 11 Js. Sond. 298/38; GnH 3659/42; AfW HH R 231191.';
  assert.strictEqual(deterministic(line), line);
});

test('a sigil is recognized all-caps and mixed-case, and only before a bare integer', () => {
  assert.strictEqual(deterministic('HSG 11 Js.'), 'HSG 11 Js.');
  assert.strictEqual(deterministic('GnH 42 Js.'), 'GnH 42 Js.');
  assert.strictEqual(deterministic('AfW 42 Js.'), 'AfW 42 Js.');
  assert.strictEqual(deterministic('HH, 260488, Bl.'), 'HH, 260488, Bl.');
});

test('ORDINARY PROSE is not a sigil — the other direction, and the one that matters', () => {
  assert.strictEqual(deterministic('The 11 men waited.'), 'The eleven men waited.');
  assert.strictEqual(deterministic('In 11 days.'), 'In eleven days.');
  assert.strictEqual(deterministic('One 11 stands alone.'), 'One eleven stands alone.');
  assert.strictEqual(deterministic('and 250 members'), 'and two hundred fifty members');
});

test('the guard the rules use IS the guard the model validator uses', () => {
  assert.ok(rules.sitsInCitation('HSG 11 Js.', '11', 4));
  assert.ok(!rules.sitsInCitation('The 11 men', '11', 4));
});

// ─────────────────────────────────────────────────────────────────────────────
// Ask 2b — a cross-chapter scripture range, and NO orphan colon anywhere
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Ask 2b: the cross-chapter range ──');

test('a chapter-crossing range reads both numbers', () => {
  assert.strictEqual(deterministic('(Col. 3:19-4:1 and parallels)'),
    '(Colossians three nineteen through four one and parallels)');
  assert.strictEqual(deterministic('see Rom. 5:12–6:2 there'),
    'see Romans five twelve through six two there');
  assert.strictEqual(deterministic('Matt. 5:3-7:29 covers it'),
    'Matthew five three through seven twenty nine covers it');
});

test('a VERSE range and a lone reference are unchanged by the fix', () => {
  assert.strictEqual(deterministic('Col. 3:19-21 alone'),
    'Colossians three nineteen through twenty one alone');
  assert.strictEqual(deterministic('Col. 3:19 alone'), 'Colossians three nineteen alone');
  assert.strictEqual(deterministic('Jeremiah 44:17-19 is the passage.'),
    'Jeremiah forty four seventeen through nineteen is the passage.');
});

/**
 * NO ORPHAN COLON, EVER.
 *
 * The Ask 2b defect was not an unconverted number, it was a MALFORMED one:
 * "Colossians three nineteen through four:1" — the rule ate the chapter and left
 * the colon and the verse standing. Nothing downstream could catch it
 * (`NUMBER_DROPPED` watches the model, not the rules; `stillHasDigits` sent the
 * wreckage to the model, which declined a fragment it could not parse). So the
 * invariant is asserted directly, over a generated matrix of every reference
 * shape these rules claim: after the deterministic pass, a scripture line holds
 * no colon with a digit on either side of it.
 */
test('no rule output leaves a colon standing next to a digit', () => {
  const DIGIT_COLON = /\d\s*:|:\s*\d/;
  const books = ['Col.', 'Rom.', 'Matt.', 'Jeremiah', '2 Cor.', '1 Corinthians', 'Ps.'];
  const refs = [
    '3:19', '3:19a', '3:19-21', '3:19-21b', '3:19-4:1', '3:19–4:1', '3:19 - 4:1',
    '10:4', '10:4ff.', '119:105', '5:12-6:2', '44:17-19', '1:1-1:2',
  ];
  const frames = ['%s', '(%s and parallels)', 'see %s there', 'quoting %s.', '%s;'];
  let checked = 0;
  for (const book of books) {
    for (const ref of refs) {
      for (const frame of frames) {
        const line = frame.replace('%s', `${book} ${ref}`);
        const out = deterministic(line);
        checked++;
        if (out === line) continue;  // untouched text keeps whatever it printed
        assert.ok(!DIGIT_COLON.test(out),
          `${JSON.stringify(line)} -> ${JSON.stringify(out)} left a digit-adjacent colon`);
      }
    }
  }
  assert.ok(checked === books.length * refs.length * frames.length);
});

test('no rule REPLACEMENT ever contains a colon next to a digit', () => {
  for (const c of CASES) {
    const text = stagePunct(c.in);
    for (const rewrite of rules.applyNumberRules(text, [text.length]).rewrites) {
      assert.ok(!/\d\s*:|:\s*\d/.test(rewrite.replace),
        `${c.id}: the ${rewrite.rule} rule proposed ${JSON.stringify(rewrite.replace)}`);
    }
  }
});

test('a CLOCK range is still not a verse range', () => {
  assert.strictEqual(deterministic('open 5:30-6:00 only'), 'open 5:30-6:00 only');
});

// ─────────────────────────────────────────────────────────────────────────────
// Owen's 2026-09-04 revision of the leave-as-printed list
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── page references and letter-digit glue are READ ──');

test('a page reference is read, and the printed abbreviation picks the word', () => {
  assert.strictEqual(deterministic('see p. 23 now'), 'see page twenty three now');
  assert.strictEqual(deterministic('pp. 65-71'), 'pages sixty five to seventy one');
  assert.strictEqual(deterministic('P. 23 has it.'), 'Page twenty three has it.');
});

test('the CARDINALS stay unhyphenated — the corpus form, not the ordinal form', () => {
  // `cardinalWords` is deliberately not `integerToWords`: the fine-tunes were
  // trained on "ninety five", not "ninety-five" (see tts-number-rules.ts's own
  // doctrine note), and these two rules use the same expander as every other.
  assert.strictEqual(deterministic('p. 95'), 'page ninety five');
  assert.strictEqual(deterministic('I-95 north'), 'I-ninety five north');
  assert.strictEqual(deterministic('p. 23'), 'page twenty three');
});

test('a volume, a number and "ibid." are still apparatus', () => {
  assert.strictEqual(deterministic('vol. 2 and no. 5 stay'), 'vol. 2 and no. 5 stay');
  // The lead has to be the token immediately before the number — "ibid., 23"
  // (with a comma between) was never guarded and still is not, which is a
  // pre-existing gap in CITATION_LEAD and not something this ruling changed.
  assert.strictEqual(deterministic('ibid. 23 there'), 'ibid. 23 there');
});

test('digits glued to letters are read, hyphen kept, letters untouched', () => {
  assert.strictEqual(deterministic('COVID-19 era'), 'COVID-nineteen era');
  assert.strictEqual(deterministic('a B-17 flying'), 'a B-seventeen flying');
  assert.strictEqual(deterministic('the 7-Eleven'), 'the seven-Eleven');
  assert.strictEqual(deterministic('R2D2 beeping'), 'R two D two beeping');
  assert.strictEqual(deterministic('the 1940s-era rules'), 'the nineteen forties-era rules');
});

test('a code is not a word with a number in it', () => {
  for (const printed of [
    'the X-007 file', 'model Z-12345 here', 'part A1B2C3D4 here', 'v1.2 of the spec',
    'Document II 9/34', 'HSG 11 Js. Sond. 298/38; GnH 3659/42; AfW HH R 231191.',
    'call (405) 235-5396 after six', 'file 001 is missing',
  ]) assert.strictEqual(deterministic(printed), printed, printed);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ask 2c — a comma is a separator INSIDE one number
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Ask 2c: NUMBER_DROPPED counts numbers, not digit runs ──');

const norm = require('../dist/electron/tts-number-normalizer.js');

/** One proposed edit, and the disposition the validator gave it. */
function verdict(target, find, replace) {
  const { records } = norm.validateNumberEdits(target, [target.length], [{ find, replace }]);
  return records[0].status;
}

test('a comma-grouped number is ONE number, so its reading is not "dropped"', () => {
  // The refusals the training side measured on tr_dn3 (NORMALIZATION_SPEC.md §F4):
  // both readings are correct and both rows still print their digits today.
  assert.strictEqual(
    verdict('5,000 copies went out', '5,000 copies', 'five thousand copies'), 'APPLIED');
  assert.strictEqual(
    verdict('an 18,000-strong crowd', '18,000-strong', 'eighteen thousand strong'), 'APPLIED');
  assert.strictEqual(
    verdict('some 20-30,000 of them', '20-30,000', 'twenty to thirty thousand'), 'APPLIED');
});

test('and the floor it was protecting still fires', () => {
  // The case NUMBER_DROPPED exists for: a verse silently gone.
  assert.strictEqual(verdict('Leviticus 20:6 forbids', '20:6', 'twenty'), 'NUMBER_DROPPED');
  // And a year range read by half.
  assert.strictEqual(
    verdict('from 1914-1918 it ran', '1914-1918', 'nineteen fourteen'), 'NUMBER_DROPPED');
});

// ─────────────────────────────────────────────────────────────────────────────
// The ordering the whole handoff turns on
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── the order of the two stages ──');

test('punctuation runs BEFORE the numbers, and the reverse would be wrong', () => {
  // `normalizeQuotes` turning U+2026 into "..." AFTER the rules had computed
  // offsets would invalidate every one of them. Proven by the shape of the
  // answer: the number rule sees a canonical text.
  const printed = 'He counted 250 … then stopped.';
  assert.strictEqual(deterministic(printed), 'He counted two hundred fifty ... then stopped.');
});

test('a curly-quoted number is still read — the quote is canonical by then', () => {
  assert.strictEqual(deterministic('“250 members”'), '"two hundred fifty members"');
});

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURE(S)`);
  process.exit(1);
}
