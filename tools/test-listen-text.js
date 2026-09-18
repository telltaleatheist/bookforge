#!/usr/bin/env node
/**
 * Keeper for shared/listen-text/normalize.ts — the ONE deterministic normalizer every
 * Listen sentence passes through (TTS API server / extension, reader bridge,
 * book render service). Owen's ruling of 2026-09-06: Listen is fast, so it is
 * cleaned deterministically to the best of our ability, no model.
 *
 * AND for the SENTENCE BOUNDARIES next door in segment.ts, which are the other
 * half of the same claim: what the reader highlights, what the transcript says
 * and what the voice is handed are one list of strings, so a segmenter that
 * EDITS the text to find a boundary has changed the book. It did until
 * 2026-09-18 — `no.` and `est.` were substring-replaced out of *piano.*,
 * *best.* and every superlative, which deleted the full stop between two
 * sentences and glued them into one row.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-text.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist', 'electron');
/** shared/, not electron/: the extension bundles the same module (Phase 16). */
const LISTEN_TEXT = path.join(__dirname, '..', 'dist', 'shared', 'listen-text', 'normalize.js');
const { speakableListenText, foldCapsRun, stripUnspokenGlyphs } = require(LISTEN_TEXT);
const { LETTERED_ACRONYMS } = require(LISTEN_TEXT);
const { splitIntoSentences } = require(path.join(__dirname, '..', 'dist', 'shared', 'listen-text', 'segment.js'));
const { SPOKEN_AS_WORD } = require(path.join(DIST, 'tts-spoken-forms.js'));
const fs = require('fs');
{
  // THE ONE ACRONYM LIST: both Listen sets are exactly the JSON narrator reads.
  const json = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'python', 'narrator', 'text', 'caps_acronyms.json'), 'utf-8'));
  assert.deepStrictEqual([...LETTERED_ACRONYMS].sort(), [...json.lettered].sort(), 'LETTERED_ACRONYMS drifted from caps_acronyms.json');
  for (const w of json.spokenAsWord) assert.ok(SPOKEN_AS_WORD.has(w.toLowerCase()), `${w} missing from SPOKEN_AS_WORD`);
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

console.log('acronyms reach the engine AS PRINTED (Owen, 2026-09-06: the sampling change resolved TPUSA)');
check('(TPUSA), REUTERS, FBI and CNN are left exactly as written', () => {
  assert.strictEqual(speakableListenText('Turning Point USA (TPUSA) said so.'), 'Turning Point USA (TPUSA) said so.');
  assert.strictEqual(speakableListenText('(Photos by Gage Skidmore and REUTERS/Angel Juarex)'), '(Photos by Gage Skidmore and REUTERS/Angel Juarex)');
  assert.strictEqual(speakableListenText('The FBI briefed CNN and WWII veterans.'), 'The FBI briefed CNN and WWII veterans.');
});

check('the whole pipeline: punctuation, number rules, expander, caps fold', () => {
  assert.strictEqual(speakableListenText('  The  GOP won 312 seats in 2024 (per CNN). '),
    'The GOP won three hundred twelve seats in twenty twenty-four (per CNN).');
});

console.log('unspoken glyphs are dropped (Owen, 2026-09-06: "it doesnt know how to read asterisks")');
check('asterisks, bullets, daggers, arrows, pilcrows, backticks and emoji go; words never fuse', () => {
  assert.strictEqual(speakableListenText('* Understanding which witch is which*'), 'Understanding which witch is which');
  assert.strictEqual(speakableListenText('word*word • item → next † note ¶ `code` ^ ~ #1'), 'word word item next note code one');
  assert.strictEqual(speakableListenText('Great news 🎉🎉 for everyone 👍🏽!'), 'Great news for everyone !');
  assert.strictEqual(stripUnspokenGlyphs('a\u00a0b'), 'a b');
});
check('what a narrator does read is kept: percent, dollars, ampersand, degree, section, slash, brackets, quotes, dashes', () => {
  assert.strictEqual(speakableListenText('50% of $5 & 20° in §3, a/b [sic] "yes" — no.'),
    'fifty percent of five dollars & twenty° in §three, a/b [sic] "yes" — no.');
});

console.log('caps headings fold to Title Case, acronyms kept (narrator fold_caps_run mirrored)');
check('a whole-caps heading folds; an acronym in it is kept for spelling', () => {
  assert.strictEqual(foldCapsRun('DOES GOD HOLD CHILDREN RESPONSIBLE?'), 'Does God Hold Children Responsible?');
  assert.strictEqual(speakableListenText('THE FBI FILES ON KELSIER'), 'The FBI Files On Kelsier');
  // Inside a caps run the guard is narrator's (allowlist or vowelless), so an
  // UNLISTED vowelled initialism folds like a name would — the same "Usa" trap the
  // packer states, fixed by listing it, never by spelling every unknown caps word.
  assert.strictEqual(speakableListenText('THE FBI FILES ON TPUSA'), 'The FBI Files On Tpusa');
  assert.strictEqual(speakableListenText('The FBI files on TPUSA.'), 'The FBI files on TPUSA.');
  assert.strictEqual(foldCapsRun('INTRODUCTION.'), 'Introduction.');
});
check('a single caps word at the head of a sentence, or a shout mid-sentence, is left alone', () => {
  assert.strictEqual(foldCapsRun('I went home.'), 'I went home.');
  assert.strictEqual(foldCapsRun('WHY did he say that? NEVER again.'), 'WHY did he say that? NEVER again.');
  assert.strictEqual(foldCapsRun('"KELSIER\'S," she said.'), '"KELSIER\'S," she said.');
  assert.strictEqual(foldCapsRun('"WHY NOT," she said.'), '"Why Not," she said.');
});

console.log('sentence boundaries: the abbreviation list is an EXCEPTION list, never a rewrite');
check('an ordinary word that ends in an abbreviation keeps its full stop', () => {
  // The defect this file exists for: `no.` and `est.` fired inside *piano.*,
  // *best.* and *honest.*, so two sentences arrived as one row with the stop gone.
  assert.deepStrictEqual(splitIntoSentences('He played the piano. Then he left.'),
    ['He played the piano.', 'Then he left.']);
  assert.deepStrictEqual(splitIntoSentences('It was the best. Honest.'),
    ['It was the best.', 'Honest.']);
  assert.deepStrictEqual(splitIntoSentences('The forest was honest. The volcano was not.'),
    ['The forest was honest.', 'The volcano was not.']);
  // Word-bounded, so a word that merely ENDS in a listed abbreviation is not one.
  assert.deepStrictEqual(splitIntoSentences('A Dino. Then a cat.'), ['A Dino.', 'Then a cat.']);
});
check('a dotted initialism keeps every period and does not end the segment', () => {
  assert.deepStrictEqual(splitIntoSentences('The U.S. Army marched.'), ['The U.S. Army marched.']);
  // U.S.S.R. used to come out as "USS.R." — the table rewrote its own prefix first.
  assert.deepStrictEqual(splitIntoSentences('The U.S.S.R. collapsed in 1991.'),
    ['The U.S.S.R. collapsed in 1991.']);
});
check('a title binds to the name after it, and a real boundary after that still splits', () => {
  assert.deepStrictEqual(splitIntoSentences('Mr. Smith left. He ran.'), ['Mr. Smith left.', 'He ran.']);
  assert.deepStrictEqual(splitIntoSentences('Dr. Jones and Mrs. Gale met at St. Paul. They talked.'),
    ['Dr. Jones and Mrs. Gale met at St. Paul.', 'They talked.']);
});
check('an abbreviation that can END a sentence is left to the segmenter', () => {
  // etc./Inc. are not exceptions: they are the last word of their phrase, so the
  // capitalised word after one begins a new sentence and the break is REAL.
  assert.deepStrictEqual(splitIntoSentences('Buy eggs, milk, etc. Then go home.'),
    ['Buy eggs, milk, etc.', 'Then go home.']);
  assert.deepStrictEqual(splitIntoSentences('He worked at Acme Inc. Then he quit.'),
    ['He worked at Acme Inc.', 'Then he quit.']);
  // And the WORD "no", which the old table's `no.` entry could not tell from the
  // abbreviation, ends sentences constantly.
  assert.deepStrictEqual(splitIntoSentences('He said no. Then he left.'),
    ['He said no.', 'Then he left.']);
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
