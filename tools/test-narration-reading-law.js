#!/usr/bin/env node
/**
 * test-narration-reading-law.js — the READING LAW, over the vendored validator.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-reading-law.js
 *
 * ── What this file is, and what it stopped being ────────────────────────────
 *
 * It was `test-narration-text-pass.js`, and it drove BookForge's own copy of the
 * narration text cleanup over a real book with a scripted model. That pass is
 * gone: Owen ruled on 2026-09-05 that the cleanup lives in the Foundry engine,
 * and foundry 1.2.0's `clean-text --epub` is the one implementation. The door
 * that spawns it is held by `tools/test-narration-clean-text-door.js`.
 *
 * WHAT DID NOT MOVE IS THE LAW ITSELF. `electron/tts-number-normalizer.ts` and
 * `electron/tts-spoken-forms.ts` are still in this repository — the `.txt`
 * audition path on the render door calls them (`normalizeTextBlocks`,
 * `prepareNarrationInput`), and they are the modules Foundry vendors, pinned
 * against its copies by `tools/test-foundry-clean-text-vendor.js`. So the cases
 * below are the cases they were: every ruling of the four adversarial reviews of
 * 2026-09-04, each one a refusal the validator must still make.
 *
 * That is not duplication of the engine's tests. These run against THIS
 * repository's bytes, which are what the audition path and the vendor pin both
 * depend on; a rule that moved on one side and not the other is exactly what
 * they exist to catch.
 *
 * No book is written and no model is loaded: every case is one call to
 * `validateNumberEdits` over one block.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'tts-number-normalizer.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-reading-law-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const norm = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// What stands in for a lexical anchor on a text edit
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── the text-edit invariants ──');

/** Validate one proposed edit against a block, under the narration policy. */
function verdictOf(target, find, replace, policy = norm.EVERY_CLASS) {
  const { records } = norm.validateNumberEdits(
    target, [target.length], [{ find, replace }], [], policy);
  return records[0];
}

test('classifyEdit names the class from the span, never from the model', () => {
  assert.strictEqual(norm.classifyEdit('1934'), 'number');
  assert.strictEqual(norm.classifyEdit('Dr. Kempner'), 'abbreviation');
  assert.strictEqual(norm.classifyEdit('FBI'), 'all-caps');
  assert.strictEqual(norm.classifyEdit(' (see the note)'), 'bracketed');
  // A WHOLE bracketed insertion is a bracket first, even with a number in it —
  // which is a fact about the RECEIPT. What invariants it has to satisfy is
  // asked directly (does it print a digit; is it a removal).
  assert.strictEqual(norm.classifyEdit(' (see p. 12)'), 'bracketed');
  assert.strictEqual(norm.classifyEdit('cost (1934) and'), 'number');
  assert.strictEqual(norm.classifyEdit('waited - and'), 'spaced-hyphen');
  assert.strictEqual(norm.classifyEdit('Henry VIII'), 'roman');
  assert.strictEqual(norm.classifyEdit('he SAID so'), 'all-caps');
  assert.strictEqual(norm.classifyEdit('a quiet phrase'), 'other');
});

test('a text edit is REFUSED outright by the number pass, as it always was', () => {
  const record = verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith', norm.NUMBERS_ONLY);
  assert.strictEqual(record.status, 'NO_DIGIT_IN_FIND');
});

test('a text edit is accepted by the narration policy', () => {
  const record = verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith');
  assert.strictEqual(record.status, 'APPLIED');
  assert.strictEqual(record.editClass, 'abbreviation');
});

test('a DELETION is only ever a bracketed insertion', () => {
  assert.strictEqual(
    verdictOf('He said (see p. 12) so.', ' (see p. 12)', '').status, 'APPLIED');
  assert.strictEqual(
    verdictOf('He said the thing so.', 'the thing ', '').status, 'EMPTY_REPLACE');
});

test('a find long enough to be a clause is refused', () => {
  const target = `${'word '.repeat(60)}end.`;
  const find = target.slice(0, 205);
  assert.strictEqual(verdictOf(target, find, 'a short reading').status, 'EDIT_TOO_LONG');
});

test('a replacement no reading justifies is refused', () => {
  const record = verdictOf('He said FBI there.', 'FBI', 'F B I '.repeat(20));
  assert.strictEqual(record.status, 'REPLACE_TOO_LONG');
});

/** N distinct all-letter tokens, so every slice of the block is unique. */
function uniqueWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String.fromCharCode(97 + Math.floor(i / 26) % 26)
      + String.fromCharCode(97 + (i % 26)) + 'ord');
  }
  return out;
}

/** N distinct all-letter tokens, so every slice of the block is unique. */
function uniqueWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String.fromCharCode(97 + Math.floor(i / 26) % 26)
      + String.fromCharCode(97 + (i % 26)) + 'ord');
  }
  return out;
}

/** A block of `n` "Dr. <word>" spans — every one a legitimate class-2 edit. */
function doctorBlock(n) {
  return `${uniqueWords(n).map((w) => `Dr. ${w}`).join(', ')}.`;
}

test('a block whose text edits would rewrite a quarter of it is stopped', () => {
  // Every edit here is a real abbreviation reading — the one-token law has no
  // objection to any of them — so what stops the flood is the CHARACTER budget
  // and nothing else, which is what this is here to prove.
  const words = uniqueWords(40);
  const target = doctorBlock(40);
  const budget = Math.max(60, Math.floor(target.length * 0.25));
  const edits = words.map((w) => ({ find: `Dr. ${w}`, replace: `Doctor ${w}` }));
  const { records } = norm.validateNumberEdits(
    target, [target.length], edits, [], norm.EVERY_CLASS);
  const applied = records.filter((r) => r.status === 'APPLIED');
  assert.ok(applied.length > 0, 'the honest readings are taken');
  const stopped = records.find((r) => r.status === 'BLOCK_BUDGET');
  assert.ok(stopped !== undefined, JSON.stringify(records.map((r) => r.status)));
  assert.ok(stopped.detail.includes('25%'), stopped.detail);
  // And it stopped where the budget said it would: each reading spends the
  // longer of its two sides, which is "Doctor <word>" at eleven characters.
  assert.ok(applied.length * 11 <= budget + 11, `${applied.length} applied for a ${budget} budget`);
});

test('the budget has a FLOOR, so a heading\'s only edit is not refused', () => {
  // A quarter of "Dr. Smith waited." is four characters; without the floor the
  // one honest reading in it would be refused for being too big for its block.
  assert.strictEqual(verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith').status,
    'APPLIED');
});

test('the budget has a FLOOR, so a heading\'s only edit is not refused', () => {
  // A quarter of "Dr. Smith waited." is four characters; without the floor the
  // one honest reading in it would be refused for being too big for its block.
  assert.strictEqual(verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith').status,
    'APPLIED');
});

test('a block that proposes a rewrite\'s worth of edits is stopped', () => {
  // A block long enough that the CHARACTER budget affords all forty readings —
  // so the per-block CAP is the only thing that can stop the flood.
  const words = uniqueWords(40);
  const target = `${doctorBlock(40)} ${uniqueWords(400).slice(40).join(' ')}.`;
  const edits = words.map((w) => ({ find: `Dr. ${w}`, replace: `Doctor ${w}` }));
  const { records } = norm.validateNumberEdits(
    target, [target.length], edits, [], norm.EVERY_CLASS);
  const applied = records.filter((r) => r.status === 'APPLIED').length;
  assert.strictEqual(applied, 24, `${applied} applied — the cap is 24`);
  assert.ok(records.some((r) => r.status === 'TOO_MANY_EDITS'), 'the cap fired');
});

/**
 * THE ONE-TOKEN LAW, and the table the adversarial review of 2026-09-04 built
 * to show it was needed.
 *
 * Owen's ruling: for a non-number class the replacement must repeat every word
 * of the find, in order, EXCEPT the single token the class is about. Before it,
 * every row below was APPLIED — measured, not supposed — because the caps bound
 * SIZE and nothing bound MEANING.
 */
const CHAMBERLAIN = 'Neville Chamberlain returned from Munich with a piece of paper in his '
  + 'hand, and the man who had waited all afternoon on the tarmac was not convinced by any of '
  + 'it. The crowds cheered anyway. He did not believe the guarantee would hold, and he had '
  + 'already decided otherwise.';

test('the review\'s adversarial table — every row is refused, by name', () => {
  const rows = [
    ['A1 paraphrase', 'the man who had waited', 'the waiting man', 'NOT_A_CLASS'],
    ['A2 negation', 'was not convinced by any of it', 'was convinced by all of it', 'NOT_A_CLASS'],
    ['A3 name swap', 'Neville Chamberlain', 'Winston Churchill', 'NOT_A_CLASS'],
    ['A4 prose in brackets', 'the guarantee would hold', '', 'EMPTY_REPLACE'],
    ['A5a word swap', 'cheered', 'jeered', 'NOT_A_CLASS'],
    ['A5b negation', 'did not believe', 'believed', 'NOT_A_CLASS'],
    ['A5c negation', 'already decided', 'not yet decided', 'NOT_A_CLASS'],
    ['A6 OCR correction', 'tarmac', 'terrace', 'NOT_A_CLASS'],
    ['B1 prose deleted', 'The crowds cheered anyway. ', '', 'EMPTY_REPLACE'],
  ];
  for (const [name, find, replace, want] of rows) {
    assert.strictEqual(verdictOf(CHAMBERLAIN, find, replace).status, want, name);
  }
});

test('a whole heading, and a whole sentence, are not readings', () => {
  assert.strictEqual(
    verdictOf('The Coming of the War', 'The Coming of the War', 'How the War Arrived').status,
    'NOT_A_CLASS');
  const sentence = 'She had loved him once, and the memory of it was the only thing she still '
    + 'owned';
  assert.strictEqual(
    verdictOf(sentence, sentence,
      'She had hated him always, and the forgetting of it was the one thing she never owned')
      .status,
    'NOT_A_CLASS');
});

test('a bracketed insertion is apparatus only while it is SHORT', () => {
  assert.strictEqual(
    verdictOf('He said (see page twelve) so.', ' (see page twelve)', '').status, 'APPLIED');
  assert.strictEqual(verdictOf('It was [sic] there', '[sic] ', '').status, 'APPLIED');
  // ROUND brackets are the author's until the contents prove otherwise.
  const clause = 'He said (though not by the men who signed it) so.';
  const refused = verdictOf(clause, ' (though not by the men who signed it)', '');
  assert.strictEqual(refused.status, 'EMPTY_REPLACE');
  assert.ok(refused.detail.includes('round brackets'), refused.detail);
  assert.strictEqual(
    verdictOf('He agreed (he was lying) then.', ' (he was lying)', '').status, 'EMPTY_REPLACE');
  // SQUARE brackets are editorial, but an interpolation of WORDS is READ, not
  // deleted (Owen's ruling of 2026-09-04, the third review): the permitted edit
  // is to drop the brackets and keep the words.
  const square = 'He said [the guarantee would hold] so.';
  const long = verdictOf(square, ' [the guarantee would hold]', '');
  assert.strictEqual(long.status, 'EMPTY_REPLACE');
  assert.ok(long.detail.includes('interpolation of words'), long.detail);
  assert.strictEqual(
    verdictOf(square, '[the guarantee would hold]', 'the guarantee would hold').status,
    'APPLIED');
  assert.strictEqual(verdictOf('It was [ed.] there', '[ed.] ', '').status, 'APPLIED');
});

test('each class may change its OWN token, and only that one', () => {
  const ok = [
    ['abbreviation', 'Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith'],
    ['dotted abbreviation', 'the plan, e.g. the map, held', 'e.g.', 'for example'],
    ['all-caps', 'the FBI agent', 'FBI', 'F B I'],
    ['roman', 'Henry VIII reigned', 'Henry VIII', 'Henry the Eighth'],
    ['emphasis, a case change', 'he never SAID so', 'never SAID so', 'never said so'],
    ['spaced hyphen, punctuation only', 'the man - who waited', 'man - who', 'man\u2014who'],
  ];
  for (const [name, target, find, replace] of ok) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'APPLIED', name);
  }
  // And the neighbouring words may not move.
  assert.strictEqual(
    verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Jones').status, 'WORDS_DROPPED');
  assert.strictEqual(
    verdictOf('the man - who waited', 'man - who', 'fellow\u2014who').status, 'WORDS_DROPPED');
});

test('the em dash is the ONE character this pass may invent, and only from a hyphen', () => {
  // The class the adversarial review found could never produce an accepted edit:
  // SPOKEN_BASE holds no U+2014 and spokenWords admits only what the find had.
  assert.strictEqual(
    verdictOf('the man - who waited', 'man - who', 'man\u2014who').status, 'APPLIED');
  // A find with no hyphen has no dash to have come from.
  assert.strictEqual(
    verdictOf('the FBI agent', 'FBI', 'F\u2014B\u2014I').status, 'REPLACE_NOT_WORDS');
  // And a NUMBER edit can never invent one, hyphen or no hyphen.
  assert.strictEqual(
    verdictOf('from 1914-1918 it ran', '1914-1918', 'nineteen fourteen\u2014nineteen eighteen')
      .status,
    'REPLACE_NOT_WORDS');
});

test('a number reading may not invent a clause either', () => {
  // Measured by the review: every number invariant passed and the sentence was
  // inverted. WORDS_ADDED is what sees it.
  const inverted = verdictOf('The 12 men who refused were shot',
    'The 12 men who refused were shot',
    'The twelve men who refused were spared, and the men who shot');
  assert.strictEqual(inverted.status, 'WORDS_ADDED');
  assert.ok(inverted.detail.includes('joining word'), inverted.detail);
  // While the readings a conversion legitimately needs still fit.
  for (const [find, replace] of [
    ['1200 workers', 'twelve hundred workers'],
    ['1914-1918', 'nineteen fourteen to nineteen eighteen'],
    ['$5.50', 'five dollars and fifty cents'],
    ['June 12, 1933', 'June twelfth, nineteen thirty-three'],
  ]) {
    assert.strictEqual(verdictOf(`x ${find} y`, find, replace).status, 'APPLIED',
      `${find} -> ${replace}`);
  }
});

/**
 * NOTHING MAY BE ADDED, and the replacement must be a READING of the token that
 * changed.
 *
 * The second adversarial review of 2026-09-04 found the one-token law bounded
 * deletion and substitution but not INSERTION, and never checked WHAT a token
 * became — so a sentence could be extended, a negation inserted, and every
 * class token swapped for an unrelated word.
 */
test('a text reading may not ADD words either', () => {
  // A whole sentence is prose, and a period at the END of a span is a sentence
  // and not an abbreviation — the unanchored test read it as one, which is how
  // this got as far as the one-token law at all.
  const target = 'He did not believe it.';
  assert.strictEqual(norm.classifyEdit(target), 'other');
  assert.strictEqual(
    verdictOf(target, target, 'He did not believe it. He had never believed it, and he said so.')
      .status, 'NOT_A_CLASS');
  // A real class token, with a word inserted beside it: this is the bound.
  assert.strictEqual(
    verdictOf('Dr. Kempner was convinced', 'Dr. Kempner was convinced',
      'Dr. Kempner was not convinced').status, 'WORDS_ADDED');
  assert.strictEqual(
    verdictOf('the FBI agent came', 'the FBI agent', 'the F B I agent of the Gestapo').status,
    'WORDS_ADDED');
  assert.strictEqual(norm.classifyEdit('Dr. Kempner'), 'abbreviation');
  // A period mid-span is an abbreviation; a span-final one only when the table
  // already knows it, which is the same "never guessed" rule the readings keep.
  assert.strictEqual(norm.classifyEdit('Kempner of the Dept. said'), 'abbreviation');
  assert.strictEqual(norm.classifyEdit('he read etc.'), 'abbreviation');
  assert.strictEqual(norm.classifyEdit('he believed it.'), 'other');
});

test('a caps word is read as ITS letters or ITS own word, never another', () => {
  assert.strictEqual(verdictOf('the FBI agent', 'FBI', 'F B I').status, 'APPLIED');
  assert.strictEqual(verdictOf('he never SAID so', 'never SAID so', 'never said so').status,
    'APPLIED');
  for (const [target, find, replace] of [
    ['the FBI agent', 'FBI', 'Gestapo'],
    ['the SS men', 'SS', 'Gestapo'],
    ['he never SAID so', 'never SAID so', 'never whispered so'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'NOT_A_READING',
      `${find} -> ${replace}`);
  }
  // An acronym a person decided is said as a WORD is read as printed.
  assert.strictEqual(verdictOf('the NASA launch', 'NASA', 'N A S A').status, 'NOT_A_READING');
});

test('an abbreviation is read from the TABLE, and an unknown one is refused by name', () => {
  assert.strictEqual(verdictOf('in St. Petersburg', 'St. Petersburg', 'Saint Petersburg').status,
    'APPLIED');
  assert.strictEqual(verdictOf('on Baker St. now', 'Baker St.', 'Baker Street').status, 'APPLIED');
  assert.strictEqual(verdictOf('the plan, e.g. the map', 'e.g.', 'for example').status, 'APPLIED');
  assert.strictEqual(verdictOf('in St. Petersburg', 'St. Petersburg', 'Moscow Petersburg').status,
    'NOT_A_READING');
  assert.strictEqual(verdictOf('at nine a.m. sharp', 'nine a.m. sharp', 'nine midnight sharp')
    .status, 'NOT_A_READING');
  const unknown = verdictOf('the Ptre. said', 'Ptre. said', 'Presbyter said');
  assert.strictEqual(unknown.status, 'NOT_A_READING');
  assert.ok(unknown.detail.includes('never guessed'), unknown.detail);
  assert.ok(unknown.detail.includes('Ptre.'), 'and it names the token, so it can be reviewed');
});

test('a roman numeral is read as its own value, and no other', () => {
  assert.strictEqual(verdictOf('Henry VIII reigned', 'Henry VIII', 'Henry the Eighth').status,
    'APPLIED');
  assert.strictEqual(verdictOf('Part IV begins', 'Part IV', 'Part Four').status, 'APPLIED');
  const wrong = verdictOf('Part IV begins', 'Part IV', 'Part Nine');
  assert.strictEqual(wrong.status, 'NOT_A_READING');
  assert.ok(wrong.detail.includes('IV is 4'), wrong.detail);
});

test('the tables are the one place a reading is decided', () => {
  const forms = require(path.join(DIST, 'electron', 'tts-spoken-forms.js'));
  assert.strictEqual(forms.romanValue('VIII'), 8);
  assert.strictEqual(forms.romanValue('XIV'), 14);
  assert.strictEqual(forms.romanValue('IIII'), null, 'a numeral nobody writes is not one');
  assert.strictEqual(forms.romanValue('FBI'), null);
  assert.ok(forms.ABBREVIATION_READINGS.has('dr'));
  assert.ok(!forms.ABBREVIATION_READINGS.has('mr'), 'Mr. is left as printed, on purpose');
  assert.strictEqual(forms.bracketRemovalRefusal('[sic]'), null);
  assert.strictEqual(forms.bracketRemovalRefusal('(see page twelve)'), null);
  assert.ok(forms.bracketRemovalRefusal('(he was lying)') !== null);
});

/**
 * OWEN'S RULINGS OF 2026-09-04, third review — the reading law's own edges.
 *
 * Every row below was measured as APPLIED before the ruling it belongs to, and
 * three of them were written into a working copy.
 */
test('R3-1 a reading may not move the punctuation around the word it changes', () => {
  // Measured into a book: "Dr. Kempner; they" -> "Doctor Kempner they" fused two
  // sentences, because the law compared words and counted them.
  assert.strictEqual(
    verdictOf('Dr. Kempner; they left', 'Dr. Kempner; they', 'Doctor Kempner they').status,
    'NOT_A_READING');
  assert.strictEqual(
    verdictOf('Dr. Kempner; they left', 'Dr. Kempner; they', 'Doctor Kempner; they').status,
    'APPLIED');
});

test('R3-1 a span-final abbreviation keeps a period that may end the sentence', () => {
  // "Oxford St. The rain" -> "Oxford Street The rain", also measured into a book.
  assert.strictEqual(
    verdictOf('Oxford St. The rain fell', 'Oxford St.', 'Oxford Street').status,
    'NOT_A_READING');
  assert.strictEqual(
    verdictOf('Oxford St. The rain fell', 'Oxford St.', 'Oxford Street.').status, 'APPLIED');
  // Mid-sentence there is no sentence to keep, and the period goes with the word.
  assert.strictEqual(verdictOf('on Baker St. now', 'Baker St.', 'Baker Street').status, 'APPLIED');
});

test('R3-1 a table key that is also an English word needs its context', () => {
  // "a flat no. The committee" -> "a flat number The committee": the wrong word
  // AND a fused sentence.
  assert.strictEqual(
    verdictOf('a flat no. The committee met', 'flat no.', 'flat number').status, 'NOT_A_READING');
  assert.strictEqual(
    verdictOf('a flat no. 5 was', 'flat no.', 'flat number').status, 'APPLIED');
  assert.strictEqual(verdictOf('I am. The end', 'I am.', 'I a m').status, 'NOT_A_READING');
  assert.strictEqual(verdictOf('at two a.m. sharp', 'two a.m.', 'two a m').status, 'APPLIED');
  assert.strictEqual(verdictOf('the co. of it', 'the co.', 'the company').status, 'NOT_A_READING');
  assert.strictEqual(verdictOf('the Ford Co. sold', 'Ford Co.', 'Ford company').status, 'APPLIED');
});

test('R3-2 the letters reading is NEVER forbidden by the roman table', () => {
  // MD, CD, DC, MC, CV, MM, XL, DI, LI, IX, CIV and MIX are legal numerals AND
  // ordinary acronyms; forcing them through the roman table made "M I X"
  // impossible and "one thousand nine" the only reading.
  for (const caps of ['MIX', 'MD', 'CD', 'DC', 'MC', 'CV', 'MM', 'XL', 'DI', 'LI', 'IX', 'CIV']) {
    const letters = [...caps].join(' ');
    assert.strictEqual(verdictOf('the ' + caps + ' was odd', caps, letters).status,
      'APPLIED', caps);
  }
  assert.strictEqual(verdictOf('the MIX was odd', 'MIX', 'one thousand nine').status,
    'NOT_A_READING');
});

test('R3-2 the roman reading is offered where a book prints a numeral', () => {
  assert.strictEqual(verdictOf('Part IV begins', 'Part IV', 'Part Four').status, 'APPLIED');
  assert.strictEqual(verdictOf('Henry VIII reigned', 'Henry VIII', 'Henry the Eighth').status,
    'APPLIED');
  assert.strictEqual(
    verdictOf('the XIX century', 'the XIX century', 'the nineteenth century').status, 'APPLIED');
  assert.strictEqual(verdictOf('Part IV begins', 'Part IV', 'Part Nine').status, 'NOT_A_READING');
});

test('R3-3 a round bracket is the book\'s own unless its SHAPE is apparatus', () => {
  for (const aside of ['(note she wept)', '(see he lied)', '(source of evil)',
    '(cited by him)']) {
    assert.strictEqual(verdictOf('He left ' + aside + ' then', ' ' + aside, '').status,
      'EMPTY_REPLACE', aside);
  }
  for (const apparatus of ['(sic)', '(see page twelve)', '(emphasis added)', '(Kershaw 1993)',
    '(12)']) {
    assert.strictEqual(verdictOf('He left ' + apparatus + ' then', ' ' + apparatus, '').status,
      'APPLIED', apparatus);
  }
});

test('R3-4 a square-bracketed interpolation of WORDS is read, not deleted', () => {
  for (const words of ['[he said]', '[the Fuhrer]', '[God help us]']) {
    assert.strictEqual(verdictOf('He left ' + words + ' then', ' ' + words, '').status,
      'EMPTY_REPLACE', words);
  }
  // The permitted edit: drop the brackets, keep the words.
  assert.strictEqual(
    verdictOf('He left [he said] then', '[he said]', 'he said').status, 'APPLIED');
  // And apparatus still goes.
  for (const apparatus of ['[sic]', '[...]', '[12]', '[ed.]', '[*]']) {
    assert.strictEqual(verdictOf('He left ' + apparatus + ' then', ' ' + apparatus, '').status,
      'APPLIED', apparatus);
  }
  // A parenthesis is not offered the bracket-drop: it is the book's punctuation.
  assert.strictEqual(
    verdictOf('He left (he said) then', '(he said)', 'he said').status, 'NOT_A_CLASS');
});

test('R3-5 a reading is written in the case the table wrote it', () => {
  assert.strictEqual(
    verdictOf('in St. Petersburg', 'St. Petersburg', 'SAINT Petersburg').status, 'NOT_A_READING');
  assert.strictEqual(
    verdictOf('in St. Petersburg', 'St. Petersburg', 'Saint Petersburg').status, 'APPLIED');
  assert.strictEqual(
    verdictOf('the FBI had it', 'the FBI had', 'The f b i had').status, 'NOT_A_READING');
  assert.strictEqual(
    verdictOf('the FBI had it', 'the FBI had', 'the F B I had').status, 'APPLIED');
});

test('R3-10 a spaced hyphen may be read as a dash beside a digit', () => {
  // The class was impossible next to a number: the find classified as a number
  // edit and the replacement was refused DIGIT_IN_REPLACE.
  assert.strictEqual(
    verdictOf('he waited 12 - and left', '12 - and', '12\u2014and').status, 'APPLIED');
  assert.strictEqual(verdictOf('the man - who waited', 'man - who', 'man\u2014who').status,
    'APPLIED');
  // And the shape has to be EXACT: nothing else may change with it.
  assert.notStrictEqual(
    verdictOf('he waited 12 - and left', '12 - and', '13\u2014and').status, 'APPLIED');
});

/**
 * THE FOURTH ADVERSARIAL REVIEW, 2026-09-04 — the reading law's last five.
 */
test('F1 the sentence-period rule is driven off the BLOCK, not off the find', () => {
  // The prompt tells the model to widen a find until it is unique, and the rule
  // used to ask "is this token the LAST thing in the find?" — so the moment it
  // widened, the guard switched off and "Oxford St. The" -> "Oxford Street The"
  // was applied, fusing two sentences. The correct reading was refused at the
  // same time, because the accounting had stripped the token's own period.
  const rows = [
    ['Oxford St. The rain fell', 'Oxford St.', 'Oxford Street.', 'Oxford Street'],
    ['Oxford St. The rain fell', 'Oxford St. The', 'Oxford Street. The', 'Oxford Street The'],
    ['Oxford St. The rain fell', 'Oxford St. The rain', 'Oxford Street. The rain',
      'Oxford Street The rain'],
    ['He left the Dept. The next day', 'the Dept. The', 'the Department. The',
      'the Department The'],
    ['He left the Dept. The next day', 'left the Dept. The next', 'left the Department. The next',
      'left the Department The next'],
    ['a Prof. "You there"', 'a Prof. "You', 'a Professor. "You', 'a Professor "You'],
  ];
  for (const [target, find, good, bad] of rows) {
    assert.strictEqual(verdictOf(target, find, good).status, 'APPLIED', find + ' -> ' + good);
    assert.notStrictEqual(verdictOf(target, find, bad).status, 'APPLIED', find + ' -> ' + bad);
  }
  // Mid-sentence there is no sentence to keep, however wide the find is.
  assert.strictEqual(
    verdictOf('on Baker St. now it rained', 'Baker St. now', 'Baker Street now').status,
    'APPLIED');
  assert.notStrictEqual(
    verdictOf('on Baker St. now it rained', 'Baker St. now', 'Baker Street. now').status,
    'APPLIED');
});

test('F1 a TITLE prefixing a name is not a sentence end', () => {
  // The other direction of the same rule: a capital after "Dr." is the name, and
  // treating it as a sentence refused the prompt's own worked example.
  assert.strictEqual(
    verdictOf('and Dr. Kempner spoke', 'Dr. Kempner', 'Doctor Kempner').status, 'APPLIED');
  assert.strictEqual(
    verdictOf('near Mt. Everest today', 'Mt. Everest', 'Mount Everest').status, 'APPLIED');
  assert.strictEqual(
    verdictOf('in St. Petersburg then', 'St. Petersburg', 'Saint Petersburg').status, 'APPLIED');
  // But a title that FOLLOWS a capitalized word is a suffix, and then the
  // capital after it is a new sentence: "Oxford St. The rain".
  assert.notStrictEqual(
    verdictOf('Oxford St. The rain', 'Oxford St. The', 'Oxford Street The').status, 'APPLIED');
});

test('F2 "no." is only an abbreviation when it is NUMBERING something', () => {
  // "The answer was no. 12 men voted" -> "The answer was number 12 men voted":
  // the word "no" ending a sentence, with the next sentence's number taken as
  // its own. A digit after it is not enough.
  for (const [target, find, replace] of [
    ['The answer was no. 12 men voted', 'was no.', 'was number'],
    ['He said no. 5 of them walked', 'said no.', 'said number'],
    ['She answered no. 3 left', 'answered no.', 'answered number'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'NOT_A_READING', find);
  }
  for (const [target, find, replace] of [
    ['Doc. no. 5 was filed', 'Doc. no.', 'Doc. number'],
    ['the file no. 12 was lost', 'file no.', 'file number'],
    ['No. 5 on the list', 'No.', 'Number'],
    ['the Reichsgesetzblatt no. 7 said', 'Reichsgesetzblatt no.', 'Reichsgesetzblatt number'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'APPLIED', find);
  }
});

test('F3 the roman reading follows a REGNAL name, not any capital', () => {
  // "Doctor Smith MD" -> "Smith one thousand five hundred"; "the London CD" ->
  // "London four hundred". Any capitalized word offered the numeral reading.
  for (const [target, find, replace] of [
    ['Doctor Smith MD wrote', 'Smith MD', 'Smith one thousand five hundred'],
    ['the London CD sold', 'London CD', 'London four hundred'],
    ['the Berlin MM group', 'Berlin MM', 'Berlin two thousand'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'NOT_A_READING', find);
  }
  // The letters reading is still there for every one of them.
  assert.strictEqual(verdictOf('Doctor Smith MD wrote', 'Smith MD', 'Smith M D').status,
    'APPLIED');
  // And the real regnal, part-word and century contexts still read.
  for (const [target, find, replace] of [
    ['Henry VIII reigned', 'Henry VIII', 'Henry the Eighth'],
    ['Pius XII spoke', 'Pius XII', 'Pius the Twelfth'],
    ['Part IV begins', 'Part IV', 'Part Four'],
    ['the XIX century', 'the XIX century', 'the nineteenth century'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'APPLIED', find);
  }
});

test('F4 the emphasis reading is for a WORD in capitals, not an initialism', () => {
  // "The US Army" -> "The us Army", "The WHO issued" -> "The who issued": the
  // recase path reached the book without going through the caps table at all.
  for (const [target, find, replace] of [
    ['The US Army moved', 'The US Army', 'The us Army'],
    ['The WHO issued it', 'The WHO issued', 'The who issued'],
    ['The SS arrived', 'The SS arrived', 'The ss arrived'],
    ['The NSDAP met', 'The NSDAP met', 'The nsdap met'],
  ]) {
    assert.notStrictEqual(verdictOf(target, find, replace).status, 'APPLIED', find);
  }
  // A two- or three-letter run gets the LETTERS reading, which is the right one.
  assert.strictEqual(verdictOf('The US Army moved', 'The US Army', 'The U S Army').status,
    'APPLIED');
  assert.strictEqual(verdictOf('The WHO issued it', 'The WHO issued', 'The W H O issued').status,
    'APPLIED');
  // And a real shouted word still reads.
  assert.strictEqual(verdictOf('he never SAID so', 'never SAID so', 'never said so').status,
    'APPLIED');
  assert.strictEqual(verdictOf('he NEVER went', 'he NEVER went', 'he never went').status,
    'APPLIED');
});

test('F5 the ampersand is a class, because the prompt teaches it', () => {
  assert.strictEqual(norm.classifyEdit('&'), 'ampersand');
  assert.strictEqual(verdictOf('Smith & Co sold it', '&', 'and').status, 'APPLIED');
  assert.strictEqual(verdictOf('Smith & Co sold it', 'Smith & Co', 'Smith and Co').status,
    'APPLIED');
  // And nothing else may ride in on it.
  assert.notStrictEqual(verdictOf('Smith & Co sold it', '&', 'plus').status, 'APPLIED');
  assert.notStrictEqual(
    verdictOf('Smith & Co sold it', 'Smith & Co', 'Smith and Company').status, 'APPLIED');
});

/**
 * THE FIFTH ADVERSARIAL REVIEW, 2026-09-04.
 */
test('NF1 a GLUED ampersand is one token, and both sides are read', () => {
  // ampersandToAnd was a bare replace with no word boundary, so "AT&T" read
  // "ATandT" and was written into a book, while every reading a person would
  // give it was refused.
  for (const [target, find, replace] of [
    ['the AT&T deal', 'AT&T', 'ATandT'],
    ['the R&D unit', 'R&D', 'RandD'],
    ['the S&P index', 'S&P', 'SandP'],
    ['Smith&Jones sold it', 'Smith&Jones', 'SmithandJones'],
    // The left side unread is not a reading either.
    ['the AT&T deal', 'AT&T', 'AT and T'],
  ]) {
    assert.notStrictEqual(verdictOf(target, find, replace).status, 'APPLIED',
      find + ' -> ' + replace);
  }
  for (const [target, find, replace] of [
    ['the AT&T deal', 'AT&T', 'A T and T'],
    ['the R&D unit', 'R&D', 'R and D'],
    ['the S&P index', 'S&P', 'S and P'],
    ['the B&B stay', 'B&B', 'B and B'],
    ['the M&S store', 'M&S', 'M and S'],
    ['Smith&Jones sold it', 'Smith&Jones', 'Smith and Jones'],
    // And a SPACED ampersand is still the word in place of the sign.
    ['Smith & Co sold it', '&', 'and'],
    ['Smith & Co sold it', 'Smith & Co', 'Smith and Co'],
  ]) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'APPLIED',
      find + ' -> ' + replace);
  }
  // Two glued ampersands in one span is a list, not a reading.
  assert.notStrictEqual(
    verdictOf('the A&B and C&D deal', 'A&B and C&D', 'A and B and C and D').status, 'APPLIED');
});

test('NF2 the emphasis reading needs a real WORD, from the list', () => {
  const forms = require(path.join(DIST, 'electron', 'tts-spoken-forms.js'));
  assert.ok(forms.englishWordCount() > 1000,
    forms.englishWordCount() + ' words — the list is shipped and loaded');

  // A denylist cannot bound an open class, and every one of these accepted the
  // lower-cased reading before the word test.
  for (const acronym of ['OSCE', 'RSHA', 'SHAEF', 'BOAC', 'ICAO', 'IATA', 'ASEAN', 'SWAPO',
    'UNITA', 'FRELIMO', 'COMECON', 'UNPROFOR', 'ELAS', 'EOKA', 'ODESSA']) {
    assert.strictEqual(forms.isEmphasisWord(acronym), false, acronym);
    assert.notStrictEqual(
      verdictOf('the ' + acronym + ' met', 'the ' + acronym + ' met',
        'the ' + acronym.toLowerCase() + ' met').status,
      'APPLIED', acronym);
    // And the letters reading is still there for every one of them.
    assert.strictEqual(
      verdictOf('the ' + acronym + ' met', acronym, [...acronym].join(' ')).status,
      'APPLIED', acronym);
  }
  // A word the author shouted still reads.
  for (const word of ['SAID', 'NEVER', 'STOP', 'HELP', 'IMPOSSIBLE', 'ABSOLUTELY', 'LISTEN']) {
    assert.strictEqual(forms.isEmphasisWord(word), true, word);
  }
  // An acronym that HAPPENS to be an English word keeps both readings, which is
  // accepted: both are real readings of those letters.
  assert.strictEqual(forms.isEmphasisWord('ARMS'), true);
  assert.strictEqual(verdictOf('the ARMS deal', 'ARMS', 'arms').status, 'APPLIED');
  assert.strictEqual(verdictOf('the ARMS deal', 'ARMS', 'A R M S').status, 'APPLIED');
  // Two and three letters get the letters reading only, whatever they spell.
  assert.strictEqual(forms.isEmphasisWord('WHO'), false);
  assert.strictEqual(forms.isEmphasisWord('US'), false);
});

test('the number invariants are untouched for a digit-bearing find', () => {
  assert.strictEqual(
    verdictOf('Leviticus 20:6 forbids', '20:6', 'twenty').status, 'NUMBER_DROPPED');
  assert.strictEqual(
    verdictOf('in 1934 he left', '1934', 'nineteen 34').status, 'DIGIT_IN_REPLACE');
  assert.strictEqual(
    verdictOf('on 12 June 1933', '12 June 1933', 'the twelfth, nineteen thirty-three').status,
    'WORDS_DROPPED');
});

test('an edit may not reach into a span the RULES already read', () => {
  const target = 'He read Dr. Smith there, page twenty three.';
  const { records } = norm.validateNumberEdits(
    target, [target.length], [{ find: 'Dr. Smith', replace: 'Doctor Smith' }],
    [{ at: 8, end: 17 }], norm.EVERY_CLASS);
  assert.strictEqual(records[0].status, 'OVERLAPS_APPLIED');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures.length === 0 ? 0 : 1);
})();
