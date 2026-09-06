#!/usr/bin/env node
/**
 * Keeper for electron/listen-text.ts — the ONE deterministic normalizer every
 * Listen sentence passes through (TTS API server / extension, reader bridge,
 * book render service). Owen's ruling of 2026-09-06: Listen is fast, so it is
 * cleaned deterministically to the best of our ability, no model.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-text.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist', 'electron');
const { speakableListenText, spellAcronyms, acronymReading, foldCapsRun } = require(path.join(DIST, 'listen-text.js'));
const { LETTERED_ACRONYMS } = require(path.join(DIST, 'listen-text.js'));
const { SPOKEN_AS_WORD } = require(path.join(DIST, 'tts-spoken-forms.js'));
const fs = require('fs');
{
  // THE ONE ACRONYM LIST: both Listen sets are exactly the JSON narrator reads.
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'python', 'narrator', 'text', 'caps_acronyms.json'), 'utf-8'));
  assert.deepStrictEqual([...LETTERED_ACRONYMS].sort(), [...json.lettered].sort(), 'LETTERED_ACRONYMS drifted from caps_acronyms.json');
  for (const w of json.spokenAsWord) assert.ok(SPOKEN_AS_WORD.has(w.toLowerCase()), `${w} missing from SPOKEN_AS_WORD`);
  assert.strictEqual(acronymReading('SCOTUS'), 'S C O T U S');
  assert.strictEqual(acronymReading('COVID'), null);
  console.log('  ok    the acronym sets are the shared JSON');
}
const { isFootnoteMarkerSupText } = require(path.join(__dirname, '..', 'dist', 'shared', 'text', 'sup-markers.js'));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (err) { failed++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

console.log('numbers read as words before the render server sees them');
check("Owen's example: a year reads as a year", () => {
  assert.strictEqual(speakableListenText('Project 2025 was published in 2023.'),
    'Project twenty twenty-five was published in twenty twenty-three.');
});
check('ordinary integers, ordinals, decades, money', () => {
  assert.strictEqual(speakableListenText('In the 1930s he paid $5 for 1,500 books, the 2nd time.'),
    'In the nineteen thirties he paid five dollars for one thousand five hundred books, the second time.');
});
check('the rules know clocks and glued numbers; a phone number is left alone', () => {
  assert.strictEqual(speakableListenText('Call 555-1234 about COVID-19 at 5:30.'),
    'Call 555-1234 about COVID-nineteen at five thirty.');
});

console.log('acronyms are spelled out unless they are read as words');
check("Owen's example: (TPUSA) is spelled", () => {
  assert.strictEqual(spellAcronyms('Turning Point USA (TPUSA) said so.'), 'Turning Point U S A (T P U S A) said so.');
});
check('lettered allowlist, spoken-as-word set, roman numerals, capitalised words', () => {
  assert.strictEqual(acronymReading('FBI'), 'F B I');
  assert.strictEqual(acronymReading('NASA'), null);
  assert.strictEqual(acronymReading('XIV'), null);
  assert.strictEqual(acronymReading('GOD'), null);
  assert.strictEqual(acronymReading('PARENTS'), null);
  assert.strictEqual(acronymReading('CNN'), 'C N N');
  assert.strictEqual(acronymReading('WWII'), 'World War Two');
});
check('a token glued to letters or digits is not an acronym', () => {
  assert.strictEqual(spellAcronyms('MI5 and iPHONE and NASDAQ100'), 'MI5 and iPHONE and NASDAQ100');
});
check('the whole pipeline: numbers first, then acronyms', () => {
  assert.strictEqual(speakableListenText('  The  GOP won 312 seats in 2024 (per CNN). '),
    'The G O P won three hundred twelve seats in twenty twenty-four (per C N N).');
});

console.log('caps headings fold to Title Case, acronyms kept (narrator fold_caps_run mirrored)');
check('a whole-caps heading folds; an acronym in it is kept for spelling', () => {
  assert.strictEqual(foldCapsRun('DOES GOD HOLD CHILDREN RESPONSIBLE?'), 'Does God Hold Children Responsible?');
  assert.strictEqual(speakableListenText('THE FBI FILES ON KELSIER'), 'The F B I Files On Kelsier');
  // Inside a caps run the guard is narrator's (allowlist or vowelless), so an
  // UNLISTED vowelled initialism folds like a name would — the same "Usa" trap the
  // packer states, fixed by listing it, never by spelling every unknown caps word.
  assert.strictEqual(speakableListenText('THE FBI FILES ON TPUSA'), 'The F B I Files On Tpusa');
  assert.strictEqual(speakableListenText('The FBI files on TPUSA.'), 'The F B I files on T P U S A.');
  assert.strictEqual(foldCapsRun('INTRODUCTION.'), 'Introduction.');
});
check('a single caps word at the head of a sentence, or a shout mid-sentence, is left alone', () => {
  assert.strictEqual(foldCapsRun('I went home.'), 'I went home.');
  assert.strictEqual(foldCapsRun('WHY did he say that? NEVER again.'), 'WHY did he say that? NEVER again.');
  assert.strictEqual(foldCapsRun('"KELSIER\'S," she said.'), '"KELSIER\'S," she said.');
  assert.strictEqual(foldCapsRun('"WHY NOT," she said.'), '"Why Not," she said.');
});

console.log('the shared footnote-marker predicate the extension strips with');
check('digits and separators are a marker; "th" is not', () => {
  assert.strictEqual(isFootnoteMarkerSupText('12'), true);
  assert.strictEqual(isFootnoteMarkerSupText('3, 4'), true);
  assert.strictEqual(isFootnoteMarkerSupText('th'), false);
  assert.strictEqual(isFootnoteMarkerSupText(''), false);
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll listen-text checks passed.');
