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
const { speakableListenText, spellAcronyms, acronymReading } = require(path.join(DIST, 'listen-text.js'));
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

console.log('the shared footnote-marker predicate the extension strips with');
check('digits and separators are a marker; "th" is not', () => {
  assert.strictEqual(isFootnoteMarkerSupText('12'), true);
  assert.strictEqual(isFootnoteMarkerSupText('3, 4'), true);
  assert.strictEqual(isFootnoteMarkerSupText('th'), false);
  assert.strictEqual(isFootnoteMarkerSupText(''), false);
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nAll listen-text checks passed.');
