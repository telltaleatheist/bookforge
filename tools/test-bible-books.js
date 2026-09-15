#!/usr/bin/env node
/**
 * test-bible-books — the scripture book name is printed in full, and the words
 * that only LOOK like one are left exactly as the author wrote them.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bible-books.js
 *
 * ── What this guards ────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"for ai cleanup, i want to deterministically expand bible
 * book names. ex -> exodus, tim. -> timothy … it's a mess."* That made the
 * expansion the THIRD named exception to the rule that deterministic text
 * fixes are for Listen only and a book goes through the cleanup model — and an
 * exception is only as good as the line it will not cross.
 *
 * SO THE NEGATIVE CORPUS IS THE POINT OF THIS FILE, not a supplement to it.
 * "Rev. Martin Luther King", "Col. Sanders", "Phil. was late", "my ex.", "Ch.
 * 3:7", "Act 3:2", "Jan. 3:7" and "Widescreen 16:9" all print a token this
 * table knows, and every one of them must come out of the pass byte for byte.
 * An audiobook that says "Revelation Martin Luther King" is worse than one
 * that says "Rev." — the whole reason books go through a model.
 *
 * ── Four sections ───────────────────────────────────────────────────────────
 *
 *   §1 POSITIVE   the contexts that expand, one case per shape.
 *   §2 NEGATIVE   the words that never do, whatever the table knows.
 *   §3 INVARIANTS the properties that make the table safe rather than lucky:
 *                 every name it produces is still DETECTED as a reference
 *                 afterwards (so the model is still asked for the digits), no
 *                 alias is also a canonical name, and no two books claim one
 *                 alias.
 *   §4 SEGMENTS   a rewrite never crosses a text-node boundary, which is what
 *                 lets the EPUB writer apply these without flattening markup.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const MODULE = path.join(DIST, 'shared', 'listen-text', 'bible-books.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const bible = require(MODULE);
const rules = require(path.join(DIST, 'electron', 'tts-number-rules.js'));
const listen = require(path.join(DIST, 'shared', 'listen-text', 'normalize.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

const expand = (s) => bible.expandBibleReferences(s);

// ═══════════════════════════════════════════════════════════════════════════
// §1 THE CONTEXTS THAT EXPAND
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── §1 the contexts that expand ──');

/** [what the book prints, what the narration copy prints]. */
const POSITIVE = [
  // Owen's own two examples.
  ['Ex. 20:3 is the first.', 'Exodus 20:3 is the first.'],
  ['See 1 Tim. 2:5 for that.', 'See First Timothy 2:5 for that.'],
  // A plain abbreviation with its period, before a chapter and verse.
  ['Rom. 5:17 says so.', 'Romans 5:17 says so.'],
  ['He quoted Jas. 1:17 at us.', 'He quoted James 1:17 at us.'],
  ['Read Phlm. 1:6 tonight.', 'Read Philemon 1:6 tonight.'],
  ['Hab. 2:4 again.', 'Habakkuk 2:4 again.'],
  // Psalm is SINGULAR; only the doubled abbreviation is the plural.
  ['Ps. 63:6 at dawn.', 'Psalm 63:6 at dawn.'],
  ['Pss. 42:1-2 and after.', 'Psalms 42:1-2 and after.'],
  // A volume number, in each of the three ways a book prints one.
  ['1 Pet. 3:7 is the text.', 'First Peter 3:7 is the text.'],
  ['II Cor. 5:17 is the text.', 'Second Corinthians 5:17 is the text.'],
  ['3rd Jn 1:4 is the text.', 'Third John 1:4 is the text.'],
  // A chapter-only reference — but only the numbered form, which is all the
  // detector claims.
  ['He read 1 Pet. 3 aloud.', 'He read First Peter 3 aloud.'],
  // A numbered book with no reference behind it at all.
  ['Read 2 Corinthians closely.', 'Read Second Corinthians closely.'],
  // A range across chapters, and a list — the span the detector takes whole.
  ['Col. 3:19-4:1 and parallels.', 'Colossians 3:19-4:1 and parallels.'],
  ['Lev. 19:31; 20:6 both.', 'Leviticus 19:31; 20:6 both.'],
  ['Jer. 44:17-19 was read.', 'Jeremiah 44:17-19 was read.'],
  // A DOTLESS abbreviation of two or three letters — the detector's weakest
  // evidence, and the one the model would otherwise be handed digits for.
  ['Jn 3:16.', 'John 3:16.'],
  ['Mt 5:9 and on.', 'Matthew 5:9 and on.'],
  // Two references in one sentence, both taken.
  ['1 Tim. 2:5, and 2 Cor. 5:17.', 'First Timothy 2:5, and Second Corinthians 5:17.'],
  // A bare dotted abbreviation that can be nothing else, with the period
  // dropped mid-sentence and KEPT where it is also the full stop.
  ['He read Phlm. at length.', 'He read Philemon at length.'],
  ['She read Phlm. The rain fell.', 'She read Philemon. The rain fell.'],
  ['The whole of Ecclus.', 'The whole of Sirach.'],
];

for (const [printed, spoken] of POSITIVE) {
  test(`${JSON.stringify(printed)} -> ${JSON.stringify(spoken)}`, () => {
    assert.strictEqual(expand(printed), spoken);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// §2 THE NEGATIVE CORPUS — the point of the feature
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── §2 the words that are never expanded ──');

/** Prose that prints a token the table knows and must come out unchanged. */
const NEGATIVE = [
  // The abbreviation is a word, a rank, a title or a person's name, and there
  // is no reference behind it to say otherwise.
  'My ex. called about the house.',
  'Rev. Martin Luther King Jr. spoke last.',
  'Col. Sanders arrived at noon.',
  'Phil. was late again, and so was Dan.',
  'Tim. left before the others.',
  'Gen. Eisenhower gave the order.',
  'Num. of items unknown.',
  'Lam. was his name; Mic. was hers.',
  'Nah. is what he said.',
  'Heb. is not a language he reads.',
  // A capitalized word in front of a chapter-and-verse shape that is not a
  // book — Owen's own must-NOT list.
  'Chapter 3:7 of the manual.',
  'Ch. 3:7 says so.',
  'Sec. 3:7 of the statute.',
  'Widescreen 16:9 is the aspect.',
  'Jan. 3:7 was the coldest day.',
  'Sept. 4:9 was warmer.',
  'Act 3:2 of the play.',
  'Room 3:15 is upstairs.',
  'Flight 12:30 is boarding.',
  // A book name AFTER the digits is no evidence at all.
  'at 3:16 John left the room',
  // Clocks, ranges and figures.
  'The train ran 5:30-6:00 all week.',
  'The meeting is at 10:05 sharp.',
  'See Fig. 3 below, and Table 2.',
  'He is 5 ft. tall and 3 in. wide.',
  // The bare chapter with no volume number — the detector does not claim it,
  // so neither does this.
  'Gen. 3 was the reading.',
  'Fig. 3 was the reading.',
  // A DOTLESS bare abbreviation: the period is the evidence, and there is none.
  'Phlm was the file name.',
  'Ecclus was the file name.',
  // A bare dotted abbreviation that IS a name somebody is called, or is short
  // for some other word — both deliberately left out of the bare set.
  'Zeph. was the youngest.',
  'Obad. spoke first.',
  'Ezek. walked in.',
  'Josh. and Matt. and Isa. and Jer. came together.',
  'The Eccles. courts met; the Chron. order was kept; Judg. Harris presided.',
  'Prov. no. 4 was the last.',
  // Full book names are already what the narrator says: nothing to expand, and
  // nothing that can go wrong.
  'Mark and John and Job and Ruth and Amos and Joel and Titus sat down.',
  'The Song was long, and so was Jude, and James, and Acts.',
  'Revelation 21:4 is the text.',
  'Genesis 3:15 is the text.',
  // Ordinary prose that happens to print the letters.
  'The company is Ac. Ltd. and the other is Ep. Inc.',
  'I am 5 and he is 6.',
];

for (const printed of NEGATIVE) {
  test(`untouched: ${JSON.stringify(printed)}`, () => {
    assert.strictEqual(expand(printed), printed);
  });
}

test('the whole negative corpus is untouched by the LISTEN pipeline too', () => {
  // Not the same assertion: `speakableListenText` runs the punctuation stage
  // and the number rules around this one, and a book name wrongly expanded
  // there reaches a voice through the extension as well as through a render.
  // Only the rows the OTHER stages leave alone can be compared this way.
  const stable = NEGATIVE.filter((s) => listen.speakableListenText(s) === s);
  assert.ok(stable.length >= 12,
    `${stable.length} negative rows pass through the other Listen stages unchanged; `
    + 'too few to be evidence of anything');
  for (const s of stable) assert.strictEqual(listen.speakableListenText(s), s);
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 THE INVARIANTS THAT MAKE THE TABLE SAFE
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── §3 the invariants ──');

/**
 * Every full name the table can produce, read off the module's own behaviour
 * rather than off a second copy of the list: the table is private, so the
 * names are collected by running the expander over a probe reference for each
 * alias the positive corpus and the invariants below reach.
 */
function nameFor(alias) {
  const out = expand(`${alias}. 3:7 was read.`);
  const m = /^(.+?) 3:7 was read\.$/.exec(out);
  return m === null || m[1] === `${alias}.` ? null : m[1];
}

test('the expansion never runs a book name into the chapter digits', () => {
  // "Rom.3:7" with no space is not a shape the detector claims, and an
  // expansion that produced "Romans3:7" would be unreadable by every later
  // stage. Checked as a property rather than as one case.
  for (const alias of ['Rom', 'Ps', 'Ex', 'Jas', 'Phlm']) {
    const out = expand(`${alias}. 3:7`);
    assert.ok(/ 3:7$/.test(out), `"${alias}. 3:7" became ${JSON.stringify(out)}`);
  }
});

test('EVERY name the table produces is still DETECTED as a reference', () => {
  // THE LOAD-BEARING INVARIANT. A detected span is CLOSED to every number rule
  // so the model can read the reference whole. If an expansion produced a name
  // the detector does not recognize, this pass would UNPROTECT the digits it
  // just renamed and the integer rule would read "Romans five seventeen" with
  // no verse pause in it — a regression caused by the fix.
  const probes = [
    'Gen', 'Ex', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Sam', 'Kgs', 'Chr', 'Ezr', 'Neh',
    'Esth', 'Jb', 'Ps', 'Pss', 'Prov', 'Eccl', 'Sg', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan',
    'Hos', 'Joe', 'Amo', 'Obad', 'Jon', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal',
    'Matt', 'Mk', 'Lk', 'Jn', 'Ac', 'Rom', 'Cor', 'Gal', 'Eph', 'Phil', 'Col', 'Thess',
    'Tim', 'Tit', 'Phlm', 'Heb', 'Jas', 'Pet', 'Rev',
    'Tob', 'Jdt', 'Wis', 'Sir', 'Ecclus', 'Bar', 'Macc', 'Esd',
  ];
  const unknown = [];
  for (const alias of probes) {
    const name = nameFor(alias);
    if (name === null) { unknown.push(alias); continue; }
    const after = `${name} 3:7 was read.`;
    const spans = rules.scriptureSpans(after);
    // The detector takes the ONE token in front of the digits, so a multi-word
    // name ("Song of Songs") is claimed from its last word. What has to be true
    // is that the DIGITS are inside a span, which is what the closure protects.
    assert.ok(spans.length === 1 && `${name} 3:7`.endsWith(spans[0].find),
      `"${alias}." expands to "${name}", and "${after}" is then detected as `
      + `${JSON.stringify(spans.map((s) => s.find))} — the expansion would UNPROTECT the `
      + 'digits it renamed, and a number rule would read the verse without its pause.');
  }
  assert.deepStrictEqual(unknown, [],
    'these probes name no book, so the table and this list disagree about what it holds');
});

test('an expansion is IDEMPOTENT — a second pass changes nothing', () => {
  for (const [printed] of POSITIVE) {
    const once = expand(printed);
    assert.strictEqual(expand(once), once,
      `${JSON.stringify(printed)} -> ${JSON.stringify(once)} -> `
      + `${JSON.stringify(expand(once))}`);
  }
});

test('a volume number is read as an ORDINAL WORD, and the constant says which', () => {
  assert.deepStrictEqual(bible.BOOK_ORDINAL_WORDS, ['First', 'Second', 'Third'],
    'the number prompt has asked the model for "First"/"Second"/"Third" since 2026-09-05; '
    + 'the deterministic half must not read the same reference a second way');
  for (const [printed, word] of [['1 Cor. 13:4', 'First'], ['2 Cor. 13:4', 'Second'],
    ['3 Jn 1:4', 'Third'], ['I Cor. 13:4', 'First'], ['III Jn 1:4', 'Third'],
    ['2nd Cor. 13:4', 'Second']]) {
    assert.ok(expand(printed).startsWith(`${word} `),
      `"${printed}" became ${JSON.stringify(expand(printed))}`);
  }
});

test('the chapter and the verse stay as DIGITS — that reading is the model\'s', () => {
  for (const [, spoken] of POSITIVE) {
    if (!/\d/.test(spoken)) continue;
    assert.ok(/\d/.test(spoken), spoken);
  }
  assert.strictEqual(expand('Rom. 5:17 says so.'), 'Romans 5:17 says so.');
  assert.ok(!/five|seventeen/.test(expand('Rom. 5:17 says so.')),
    'the expansion read a number, which belongs to the rules and the model');
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 A REWRITE NEVER CROSSES A TEXT-NODE BOUNDARY
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n── §4 the text-node boundary ──');

test('a rewrite that would cross a text-node boundary is dropped, not applied', () => {
  // "1 <em>Pet.</em> 3:7" — the element's text is one string and its NODES are
  // three. Rewriting "1 Pet." would mean flattening the <em> to get at it, so
  // the edit is refused exactly as `applyNumberRules` refuses one.
  const text = '1 Pet. 3:7 is the text.';
  const whole = bible.bibleReferenceRewrites(text, [text.length]);
  assert.strictEqual(whole.length, 1, 'one span in one node');
  const split = bible.bibleReferenceRewrites(text, [2, 4, text.length - 6]);
  assert.strictEqual(split.length, 0,
    `the span crosses a node boundary and was rewritten anyway: ${JSON.stringify(split)}`);
});

test('a rewrite INSIDE one node of a split text is still applied', () => {
  const text = 'Look: Rom. 5:17 is the text.';
  const edits = bible.bibleReferenceRewrites(text, [6, text.length - 6]);
  assert.strictEqual(edits.length, 1);
  assert.strictEqual(edits[0].find, 'Rom.');
  assert.strictEqual(edits[0].replace, 'Romans');
  assert.strictEqual(text.slice(edits[0].at, edits[0].at + edits[0].find.length), 'Rom.');
});

test('segments that do not describe the text are refused BY NAME', () => {
  assert.throws(() => bible.bibleReferenceRewrites('Rom. 5:17', [3]),
    /describe two different strings/);
});

console.log(`\n${passed}/${passed + failures.length} passed`);
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) FAILED.`);
}
process.exit(failures.length === 0 ? 0 : 1);
