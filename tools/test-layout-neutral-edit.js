#!/usr/bin/env node
/**
 * Which edits to a book's markup can be shown not to move a page.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-layout-neutral-edit.js
 *
 * Plain node — the rule is a string comparison and deserves to be testable
 * without a browser. The half that needs one (does quire's own shell agree, does
 * anything it injects select on the attribute) is in
 * tools/test-quire-cache-identity.js.
 *
 * The stakes: a wrong YES here means a page number that is quietly one line out,
 * on a book the user then strikes paragraphs in. A wrong NO costs a relayout,
 * which is what always used to happen. So every test below that could only fail
 * in one direction is written to fail in the dangerous one.
 */
'use strict';

const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const {
  layoutNeutralRewrite, bookforgeAttributeNames, stripBookforgeAttributes,
  stylesheetsMentioning, BOOKFORGE_ATTRIBUTE_PREFIX,
} = require(path.join(DIST, 'shared/document/layout-neutral-edit.js'));

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
function assert(cond, message) { if (!cond) throw new Error(message); }
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** A document as the stamper leaves it: quire ids on, BookForge attributes on. */
function doc(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
}

const PLAIN = doc(
  '<h1 data-quire-id="a.xhtml#0">A Chapter</h1>'
  + '<p data-quire-id="a.xhtml#1">Some prose that is here.</p>');

console.log('layout-neutral edits\n');

console.log('the namespace');
check('every data-bf-* attribute in a document is found, and nothing else is', () => {
  const found = bookforgeAttributeNames(doc(
    '<p data-quire-id="a#0" data-bf-user-cat="body" class="x" data-bf-group="g">t</p>'));
  assertEqual([...found].sort().join(','), 'data-bf-group,data-bf-user-cat',
    'the attributes found');
});
check('stripping takes the attribute out and leaves the rest byte for byte', () => {
  const before = '<p data-quire-id="a#0" data-bf-user-cat="body">t</p>';
  assertEqual(
    stripBookforgeAttributes(before, ['data-bf-user-cat']),
    '<p data-quire-id="a#0">t</p>',
    'the stripped markup');
});
check('the prefix is what the module says it is', () => {
  assertEqual(BOOKFORGE_ATTRIBUTE_PREFIX, 'data-bf-', 'the prefix');
});

console.log('\nneutral');
check('adding a label to one element is neutral', () => {
  const after = PLAIN.replace(
    '<h1 data-quire-id="a.xhtml#0">', '<h1 data-quire-id="a.xhtml#0" data-bf-user-cat="chapter">');
  const v = layoutNeutralRewrite(PLAIN, after, 'a.xhtml');
  assert(v.neutral, `not neutral: ${v.reason}`);
  assertEqual(v.attributes.join(','), 'data-bf-user-cat', 'the attributes named');
});
check('changing a label from one value to another is neutral', () => {
  const before = PLAIN.replace('<h1 ', '<h1 data-bf-user-cat="title" ');
  const after = PLAIN.replace('<h1 ', '<h1 data-bf-user-cat="chapter" ');
  const v = layoutNeutralRewrite(before, after, 'a.xhtml');
  assert(v.neutral, `not neutral: ${v.reason}`);
});
check('removing a label is neutral', () => {
  const before = PLAIN.replace('<h1 ', '<h1 data-bf-user-cat="title" ');
  const v = layoutNeutralRewrite(before, PLAIN, 'a.xhtml');
  assert(v.neutral, `not neutral: ${v.reason}`);
});
check('labelling several elements at once is neutral', () => {
  const after = PLAIN
    .replace('<h1 ', '<h1 data-bf-user-cat="chapter" ')
    .replace('<p ', '<p data-bf-user-cat="body" ');
  const v = layoutNeutralRewrite(PLAIN, after, 'a.xhtml');
  assert(v.neutral, `not neutral: ${v.reason}`);
});
check('a data-bf-* attribute this build has never heard of is still neutral', () => {
  const after = PLAIN.replace('<p ', '<p data-bf-something-invented-later="7" ');
  const v = layoutNeutralRewrite(PLAIN, after, 'a.xhtml');
  assert(v.neutral, `not neutral: ${v.reason}`);
  assertEqual(v.attributes.join(','), 'data-bf-something-invented-later', 'the attribute named');
});

console.log('\nNOT neutral — the answers that matter');
check('a changed word is not neutral', () => {
  const before = PLAIN.replace('<h1 ', '<h1 data-bf-user-cat="chapter" ');
  const after = before.replace('A Chapter', 'A Chapter Renamed');
  const v = layoutNeutralRewrite(before, after, 'a.xhtml');
  assert(!v.neutral, 'a rename was called neutral');
  assert(/part company/.test(v.reason), `the reason does not locate it: ${v.reason}`);
});
check('a removed element is not neutral', () => {
  const before = PLAIN.replace('<h1 ', '<h1 data-bf-user-cat="chapter" ');
  const after = before.replace('<p data-quire-id="a.xhtml#1">Some prose that is here.</p>', '');
  assert(!layoutNeutralRewrite(before, after, 'a.xhtml').neutral, 'a deletion was called neutral');
});
check('a changed class is not neutral, though it is only an attribute', () => {
  const before = doc('<p data-quire-id="a#0" data-bf-user-cat="body" class="run-in">t</p>');
  const after = doc('<p data-quire-id="a#0" data-bf-user-cat="body" class="display">t</p>');
  assert(!layoutNeutralRewrite(before, after, 'a.xhtml').neutral, 'a class change was called neutral');
});
check('a changed inline style is not neutral', () => {
  const before = doc('<p data-quire-id="a#0" data-bf-user-cat="body" style="margin:0">t</p>');
  const after = doc('<p data-quire-id="a#0" data-bf-user-cat="body" style="margin:4em">t</p>');
  assert(!layoutNeutralRewrite(before, after, 'a.xhtml').neutral, 'a style change was called neutral');
});
check('a changed quire stamp is not neutral — the enumeration moved', () => {
  const before = doc('<p data-quire-id="a#0" data-bf-user-cat="body">t</p>');
  const after = doc('<p data-quire-id="a#1" data-bf-user-cat="body">t</p>');
  assert(!layoutNeutralRewrite(before, after, 'a.xhtml').neutral, 'a re-stamp was called neutral');
});
check('a document with no data-bf-* attribute at all is never neutral', () => {
  const v = layoutNeutralRewrite(PLAIN, PLAIN, 'a.xhtml');
  assert(!v.neutral, 'a document with nothing to be neutral about was called neutral');
  assert(/carries no data-bf-\* attribute/.test(v.reason), `the reason: ${v.reason}`);
});
check('a changed stylesheet link is not neutral', () => {
  const before = doc('<p data-quire-id="a#0" data-bf-user-cat="body">t</p>')
    .replace('<title>t</title>', '<title>t</title><link rel="stylesheet" href="a.css"/>');
  const after = doc('<p data-quire-id="a#0" data-bf-user-cat="body">t</p>')
    .replace('<title>t</title>', '<title>t</title><link rel="stylesheet" href="b.css"/>');
  assert(!layoutNeutralRewrite(before, after, 'a.xhtml').neutral, 'a stylesheet swap was called neutral');
});

console.log('\nthe stylesheets the book brings');
check('a stylesheet that selects on the attribute is named, with the attribute', () => {
  const hits = stylesheetsMentioning(
    new Map([
      ['EPUB/css/base.css', 'p { margin: 0 }'],
      ['EPUB/css/x.css', 'p[data-bf-user-cat="chapter"] { page-break-before: always }'],
    ]),
    ['data-bf-user-cat']);
  assertEqual(hits.length, 1, 'the number of hits');
  assertEqual(hits[0].entry, 'EPUB/css/x.css', 'the stylesheet named');
  assertEqual(hits[0].attribute, 'data-bf-user-cat', 'the attribute named');
});
check('a stylesheet that only mentions it in a comment is still a hit', () => {
  const hits = stylesheetsMentioning(
    new Map([['x.css', '/* nothing here uses data-bf-user-cat */ p { margin: 0 }']]),
    ['data-bf-user-cat']);
  assertEqual(hits.length, 1, 'a mention in a comment must still cost a relayout');
});
check('stylesheets that say nothing about it are no hits', () => {
  const hits = stylesheetsMentioning(
    new Map([['a.css', 'p { margin: 0 }'], ['b.css', 'h1 { font-size: 2em }']]),
    ['data-bf-user-cat', 'data-bf-group']);
  assertEqual(hits.length, 0, 'the number of hits');
});
check('a book with no stylesheets at all is no hits', () => {
  assertEqual(stylesheetsMentioning(new Map(), ['data-bf-user-cat']).length, 0, 'the number of hits');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
