#!/usr/bin/env node
/**
 * Turning a retyped paragraph into the smallest change to the markup.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-element-text-edit.js
 *
 * The arithmetic under `book:set-block-text`. It has to be exactly right in two
 * directions at once: too WIDE a span and an edit swallows inline markup the
 * reader never touched; too NARROW and the book ends up saying something the
 * reader did not type. Both are silent, so both are tested by applying the
 * splice and reading the result back.
 */
'use strict';

const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const {
  collapseWithIndex, spliceForCollapsedText,
} = require(path.join(DIST, 'shared/document/element-text-edit.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err && err.message ? err.message : err}`);
  }
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assert(cond, message) { if (!cond) throw new Error(message); }

/** The collapse the app uses, restated so the index can be checked against it. */
const collapse = (s) => s.replace(/\s+/g, ' ').trim();

/** Apply a splice and hand back the new raw text. */
function apply(raw, splice) {
  if (splice === null) return raw;
  return raw.slice(0, splice.start) + splice.replacement + raw.slice(splice.end);
}

/**
 * The round trip that matters: splice, then read the collapsed text back and
 * confirm it is what the reader typed.
 */
function roundTrip(raw, wanted) {
  const splice = spliceForCollapsedText(raw, wanted);
  const after = apply(raw, splice);
  assertEqual(collapse(after), collapse(wanted), `the collapsed text after editing ${JSON.stringify(raw)}`);
  return { splice, after };
}

console.log('element text edits\n');

console.log('the collapse index');
check('the collapsed text is exactly what the app collapses to', () => {
  for (const raw of [
    'He wrote to Bethge from Tegel,\n     in November.',
    '   leading and trailing   ',
    'tabs\tand\t\tnewlines\n\n',
    'single',
    '',
    '   ',
  ]) {
    assertEqual(collapseWithIndex(raw).text, collapse(raw), `collapsing ${JSON.stringify(raw)}`);
  }
});
check('every collapsed character remembers where it came from', () => {
  const raw = 'a  b\n\nc';
  const { text, rawOffset } = collapseWithIndex(raw);
  assertEqual(text, 'a b c', 'the collapsed text');
  assertEqual(rawOffset.length, text.length, 'one offset per character');
  assertEqual(raw[rawOffset[0]], 'a', 'where a came from');
  assertEqual(rawOffset[1], 1, 'a collapsed space points at the START of the run it stands for');
  assertEqual(raw[rawOffset[2]], 'b', 'where b came from');
  assertEqual(rawOffset[3], 4, 'the second run starts at 4');
  assertEqual(raw[rawOffset[4]], 'c', 'where c came from');
});

console.log('\nnothing to do');
check('text that already reads that way is not an edit', () => {
  assertEqual(spliceForCollapsedText('He wrote in November.', 'He wrote in November.'), null,
    'an identical retype');
});
check('whitespace the reader cannot see is not an edit', () => {
  assertEqual(spliceForCollapsedText('He wrote\n   in November.', 'He wrote in November.'), null,
    'the same words, differently laid out in the file');
  assertEqual(spliceForCollapsedText('He wrote in November.', '  He wrote  in November.  '), null,
    'a retype with stray spaces');
});

console.log('\nthe smallest change');
check('fixing one word touches the characters that differ, not the word', () => {
  // "November." and "December." share "ember.", so the minimal span is Nov→Dec.
  // That IS the point of anchoring on both ends: the smaller the span, the less
  // inline markup it can possibly cross, and the less the caller has to refuse.
  const raw = 'He wrote to Bethge from Tegel, in November.';
  const { splice } = roundTrip(raw, 'He wrote to Bethge from Tegel, in December.');
  assertEqual(raw.slice(splice.start, splice.end), 'Nov', 'what was replaced');
  assertEqual(splice.replacement, 'Dec', 'what replaced it');
});
check('a fix survives the markup being pretty-printed', () => {
  const raw = 'He wrote to Bethge from Tegel,\n     in November.';
  const { splice } = roundTrip(raw, 'He wrote to Bethge from Tegel, in December.');
  assertEqual(raw.slice(splice.start, splice.end), 'Nov', 'what was replaced');
  assert(splice.start > raw.indexOf('\n'), 'the span is past the line break, which is untouched');
});
check('deleting a trailing run touches only the tail', () => {
  const raw = 'The chapter ends here. Buy our other books at example.com!';
  const { splice } = roundTrip(raw, 'The chapter ends here.');
  // The separating space goes with the sentence it separated. Leaving it would
  // put a trailing space into the markup that the collapse then has to trim —
  // a byte written for nothing, in a file whose bytes key the page map.
  assertEqual(raw.slice(splice.start, splice.end), ' Buy our other books at example.com!',
    'what was deleted');
  assertEqual(splice.replacement, '', 'a deletion replaces with nothing');
  assertEqual(splice.end, raw.length, 'the deletion runs to the end');
});
check('deleting a leading run touches only the head', () => {
  const raw = 'CHAPTER SEVEN The prison letters begin.';
  const { splice } = roundTrip(raw, 'The prison letters begin.');
  assertEqual(raw.slice(splice.start, splice.end), 'CHAPTER SEVEN ', 'what was deleted');
});
check('appending lands at the end of the words, not after the file\'s whitespace', () => {
  const raw = 'The chapter ends here.\n  ';
  const { splice, after } = roundTrip(raw, 'The chapter ends here. And then it did not.');
  assertEqual(splice.start, splice.end, 'an append replaces nothing');
  assertEqual(splice.start, 22, 'an append lands just past the last real character');
  assert(after.endsWith('\n  '), `the file's trailing whitespace was eaten: ${JSON.stringify(after)}`);
});
check('inserting in the middle replaces nothing', () => {
  const raw = 'He wrote in November.';
  const { splice } = roundTrip(raw, 'He wrote to Bethge in November.');
  assertEqual(splice.start, splice.end, 'an insertion replaces nothing');
});
check('a repeated word does not confuse the anchoring', () => {
  const raw = 'the letter and the letter and the letter';
  const { splice } = roundTrip(raw, 'the letter and the note and the letter');
  assert(splice.replacement.includes('note'), `the replacement: ${JSON.stringify(splice.replacement)}`);
});

console.log('\nthe hard cases, checked by reading the result back');
check('replacing the whole text works, and says so by spanning it all', () => {
  const raw = 'A Chapter';
  const { splice } = roundTrip(raw, 'Something Entirely Different');
  assertEqual(splice.start, 0, 'the span starts at the beginning');
  assertEqual(splice.end, raw.length, 'the span runs to the end');
});
check('emptying the text is a splice over everything', () => {
  const raw = 'Delete all of this.';
  const { splice, after } = roundTrip(raw, '');
  assertEqual(splice.replacement, '', 'the replacement');
  assertEqual(collapse(after), '', 'what is left');
});
check('a one-character document edits correctly', () => {
  roundTrip('A', 'B');
  roundTrip('A', 'AB');
  roundTrip('A', '');
});
check('text that is only whitespace takes an insertion at the end', () => {
  const { after } = roundTrip('   \n ', 'Now it says something.');
  assertEqual(collapse(after), 'Now it says something.', 'what it says now');
});
check('a hundred random edits all read back as what was typed', () => {
  // Deterministic, so a failure can be reproduced: a fixed sequence rather than
  // a random one, over the shapes that actually occur in a book.
  const raws = [
    'He wrote to Bethge from Tegel, in November.',
    'He wrote to Bethge\n  from Tegel,\tin November.',
    '  CHAPTER SEVEN  ',
    'a',
    'the letter and the letter and the letter',
    'Ends with a marker.',
  ];
  const edits = [
    (s) => s.toUpperCase(),
    (s) => s.replace('the', 'a'),
    (s) => `${s} And more.`,
    (s) => s.slice(0, Math.floor(s.length / 2)),
    (s) => s.slice(Math.floor(s.length / 2)),
    (s) => s.split('').reverse().join(''),
    (s) => `Prefix. ${s}`,
    (s) => s.replace(/[aeiou]/g, ''),
    () => '',
    (s) => s,
  ];
  let n = 0;
  for (const raw of raws) {
    for (const edit of edits) {
      roundTrip(raw, edit(collapse(raw)));
      n++;
    }
  }
  assertEqual(n, raws.length * edits.length, 'the number of edits exercised');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
