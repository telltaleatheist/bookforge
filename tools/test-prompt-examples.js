#!/usr/bin/env node
/**
 * test-prompt-examples.js — every worked example in every prompt this pass
 * sends, run through the validator that will judge the model's real answers.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-prompt-examples.js
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * The adversarial review of 2026-09-04 ran the shipped few-shot answers through
 * `validateNumberEdits` and found the demonstration was three-quarters refused:
 *
 *   [APPLIED]            "Henry VIII"   -> "Henry the Eighth"
 *   [REPLACE_NOT_WORDS]  "waited - and" -> "waited—and"     (no em dash in SPOKEN_BASE)
 *   [REPLACE_NOT_WORDS]  "waited - for" -> "waited—for"
 *   [NOT_FOUND]          "he SAID he"   -> "he said he"     (not verbatim in its own target)
 *
 * A prompt that teaches a shape the validator refuses categorically is a whole
 * class of the pass that can never produce an accepted edit — and because the
 * model pass costs a GPU, nobody sees it until a book has been paid for. This
 * suite is what catches it with no GPU at all: the prompt and the validator have
 * to agree, and here is where they are made to.
 *
 * It parses the prompt FILES rather than a copy, so a future edit to an example
 * is judged the moment it is written.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'tts-number-normalizer.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const norm = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));
const rules = require(path.join(DIST, 'electron', 'tts-number-rules.js'));
const punct = require(path.join(DIST, 'electron', 'tts-punctuation.js'));

const PROMPTS = [
  'electron/prompts/tts-number-normalize.txt',
  'electron/prompts/tts-narration-text.txt',
];

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
  }
}

/**
 * Every `TARGET: …` / `<answer>{…}</answer>` pair in a prompt file.
 *
 * The TARGET is one line (that is how the file is written); the answer is the
 * JSON between the tags. A pair that will not parse is a failure in itself — a
 * prompt whose own example is malformed teaches malformed answers.
 */
function examplesIn(file) {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');
  const out = [];
  const re = /^TARGET:\s*(.+)$\s*<answer>\s*([\s\S]*?)\s*<\/answer>/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(m[2]);
    } catch (err) {
      throw new Error(`${file}: the answer for ${JSON.stringify(target)} is not JSON: `
        + err.message);
    }
    assert.ok(Array.isArray(parsed.edits), `${file}: ${target} has no edits array`);
    out.push({ file, target, edits: parsed.edits });
  }
  return out;
}

const ALL = PROMPTS.flatMap(examplesIn);

console.log('\n── the prompts have examples at all ──');

test('every prompt file this pass sends carries worked examples', () => {
  for (const file of PROMPTS) {
    const found = ALL.filter((e) => e.file === file).length;
    assert.ok(found > 0, `${file} has no TARGET/<answer> pair`);
  }
  assert.ok(ALL.length >= 7, `${ALL.length} examples across ${PROMPTS.length} prompts`);
});

console.log('\n── every example is ACCEPTED by the validator that will judge it ──');

for (const example of ALL) {
  test(`${path.basename(example.file)} — ${example.target.slice(0, 58)}…`, () => {
    const { records } = norm.validateNumberEdits(
      example.target, [example.target.length], example.edits, [], norm.EVERY_CLASS);
    assert.strictEqual(records.length, example.edits.length,
      'every proposed edit is recorded');
    const refused = records.filter((r) => r.status !== 'APPLIED');
    assert.strictEqual(refused.length, 0,
      `the prompt teaches ${refused.length} edit(s) this validator refuses:\n`
      + refused.map((r) => `  [${r.status}] ${JSON.stringify(r.find)} -> `
        + `${JSON.stringify(r.replace)}${r.detail ? ` — ${r.detail}` : ''}`).join('\n'));
  });
}

console.log('\n── and every example TARGET is text the model could really be shown ──');

for (const example of ALL) {
  if (example.edits.length === 0) continue;
  test(`${path.basename(example.file)} — the deterministic stages leave it alone`, () => {
    // The model never sees a block the rules have not already read. An example
    // whose target still holds a shape the rules convert is teaching the model
    // to answer about text it will never be given — which is how the page
    // reference in the first narration example came to be written "p. 12".
    const canonical = punct.canonicalizePunctuationText(example.target);
    const ruled = rules.applyNumberRules(canonical, [canonical.length]).text;
    for (const edit of example.edits) {
      assert.ok(ruled.includes(edit.find),
        `after the deterministic stages the block reads ${JSON.stringify(ruled)}, `
        + `which does not contain the example's find ${JSON.stringify(edit.find)}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt's own PROSE, not only its worked examples
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every `"X" is "Y"` / `"X" becomes "Y"` pair the prompt states in prose.
 *
 * The fourth adversarial review found two defects that slipped past the
 * worked-example keeper because they were taught in a SENTENCE rather than
 * demonstrated in an `<answer>`: the prompt's own
 * `"Oxford St. The rain" becomes "Oxford Street. The rain"` was refused in that
 * exact form, and `"&" is "and"` had no class at all. A prompt that teaches a
 * reading the wall refuses is a class of the pass that cannot work, whether the
 * teaching is a demonstration or a claim.
 */
function quotedPairsIn(file) {
  const text = fs.readFileSync(path.join(REPO, file), 'utf8');
  const out = [];
  const re = /"([^"\n]+)"\s+(?:is|becomes)\s+"([^"\n]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ file, find: m[1], replace: m[2] });
  return out;
}

/**
 * The block a quoted pair is judged in.
 *
 * A pair that shows a SPAN (it has a space in it) carries its own context and is
 * judged exactly as written — that is the whole point of the sentence-period
 * case. A bare token is a dictionary gloss with no context at all, so it is set
 * in a neutral frame rather than being asked to stand alone: on its own, "Dr."
 * looks like the end of a sentence.
 */
function frameFor(find) {
  if (/\s/.test(find)) return find;
  // A GLUED AMPERSAND is a bare token that still needs a block around it, and it
  // is the one the fifth review found written into a book as "ATandT" — so the
  // prompt's own "AT&T" is "A T and T" is judged here like any other pair.
  if (/[A-Za-z0-9]&[A-Za-z0-9]/.test(find)) return `the ${find} deal was there`;
  // A bare token whose table entry demands a CONTEXT gets one: the gloss states
  // the reading, and asking whether the reading is reachable at all means giving
  // it the sentence the table says it needs, not a frame the keeper happened to
  // pick. ("St." alone is refused, correctly, for having no name beside it.)
  const forms = require(path.join(DIST, 'electron', 'tts-spoken-forms.js'));
  const entry = forms.ABBREVIATION_READINGS.get(forms.abbreviationKey(find));
  switch (entry === undefined ? undefined : entry.context) {
    case 'beside-a-proper-noun': return `in ${find} Petersburg it was there`;
    case 'numbers-a-thing':
    case 'followed-by-digit': return `the file ${find} 5 was there`;
    case 'after-a-number': return `at two ${find} it was there`;
    default: return `the ${find} was there`;
  }
}

/**
 * Pairs the prompt states but that are NOT single anchored edits.
 *
 * Named individually, with the reason, because "skip what does not pass" is how
 * a keeper stops being one.
 */
const NOT_AN_EDIT = new Map([
  // The deterministic clock rule converts this before the model ever sees it;
  // the prompt states the reading so the model knows it if one slips through.
  ['10:05', 'the clock rule converts it, so the model is never shown this shape'],
  ['7:02', 'the same'],
  ['6:00', 'the same'],
  ['2:00 p.m.', 'the same'],
]);

console.log('\n── every reading the prompt states in prose ──');

const PAIRS = PROMPTS.flatMap(quotedPairsIn);

test('the prompt states readings, and states enough of them', () => {
  assert.ok(PAIRS.length >= 8, `${PAIRS.length} quoted pairs across the prompts`);
});

for (const pair of PAIRS) {
  const skip = NOT_AN_EDIT.get(pair.find);
  test(`${path.basename(pair.file)} — "${pair.find}" is "${pair.replace}"`
    + (skip === undefined ? '' : ' (stated, not an edit)'), () => {
    if (skip !== undefined) return;
    const target = frameFor(pair.find);
    const { records } = norm.validateNumberEdits(
      target, [target.length], [{ find: pair.find, replace: pair.replace }], [],
      norm.EVERY_CLASS);
    assert.strictEqual(records[0].status, 'APPLIED',
      `the prompt teaches this reading and the validator answers ${records[0].status}`
      + `${records[0].detail ? ` — ${records[0].detail}` : ''}`);
  });
}

console.log(`\n${passed}/${passed + failures.length} passed`);
process.exit(failures.length === 0 ? 0 : 1);
