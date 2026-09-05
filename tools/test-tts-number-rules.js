#!/usr/bin/env node
/**
 * Tests for the deterministic number rules — the shapes code reads before the
 * model is asked anything.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-tts-number-rules.js
 *
 * ── What is worth defending here ────────────────────────────────────────────
 *
 * THE GUARANTEE. Owen admitted these rules on one condition — *"just basic
 * deterministic stuff that we can guarantee will be correct on the other side"*
 * — so every rule below is pinned to the exact reading it promises, and every
 * shape the rules are NOT allowed to touch is pinned to coming out byte for byte
 * as it went in. A rule that quietly widened its net would be a defect the
 * record cannot show, because a rule edit is never refused for being wrong.
 *
 * THE MEASURED FAILURES. Every scripture case here is a span the 9b model got
 * WRONG on the 2026-09-02 run (record:
 * `narration-cuts/d7542db2804b8354.n1.qwen3.5-9b.norm.tts.edits.json`) —
 * "Jeremiah 44:17-19" as "four fourteen seventeen", "Daniel 4:33" as "four three
 * three", "Revelation 9:20–21" with the 20 dropped. Those are the reason the
 * pre-pass exists and they are the reason it is tested here by name.
 *
 * IDEMPOTENCE, because the rules run over a book that may already have been
 * through them (a re-prep, a heading reconciled against its contents entry), and
 * a rule that re-read its own output would compound.
 *
 * THE OFFSETS AND THE TEXT NODES, because the pass downstream splices by offset
 * into the ORIGINAL text and refuses a span that would flatten an `<em>`.
 *
 * Pure functions all the way down: no model, no GPU, no files.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'tts-number-rules.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const rules = require(path.join(DIST, 'electron', 'tts-number-rules.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Run the rules over one string held in ONE text node — the ordinary case. */
const read = (text) => rules.applyNumberRules(text, [text.length]);

/** What the rules make of `text`, as a string. */
const spoken = (text) => read(text).text;

/** The (rule, find) pairs the rules claimed, in order. */
const claims = (text) => read(text).rewrites.map((r) => [r.rule, r.find]);

/** Assert a reading, and assert that reading it again changes nothing. */
function reads(text, expected, message) {
  assert.strictEqual(spoken(text), expected, message ?? text);
  assert.strictEqual(read(expected).rewrites.length, 0,
    `not idempotent: "${expected}" was read again`);
}

/** Assert the rules leave a string exactly as printed. */
function untouched(text) {
  const out = read(text);
  assert.strictEqual(out.text, text, `expected untouched: ${text}`);
  assert.deepStrictEqual(out.rewrites, [], `expected no rewrites: ${text}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scripture — every one of these is a span the 9b model read WRONG
// ─────────────────────────────────────────────────────────────────────────────

test('scripture: the chapter and verse, in the training corpora\'s cardinal', () => {
  // 9b said "four fourteen seventeen to nineteen" — it read 44 as two numbers.
  reads('Jeremiah 44:17-19', 'Jeremiah forty four seventeen through nineteen');
  // 9b said "two twenty-three one".
  reads('Luke 22:31', 'Luke twenty two thirty one');
  // 9b said "four three three".
  reads('Daniel 4:33', 'Daniel four thirty three');
  // 9b said "nine twenty-one" — the 20 of the range simply vanished.
  reads('Revelation 9:20–21', 'Revelation nine twenty through twenty one');
  reads('Isaiah 5:20', 'Isaiah five twenty');
  reads('Exodus 22:18', 'Exodus twenty two eighteen');
});

test('scripture: an en dash is a range, exactly as a hyphen is', () => {
  reads('Deuteronomy 18:10–11', 'Deuteronomy eighteen ten through eleven');
  reads('Deuteronomy 18:10-11', 'Deuteronomy eighteen ten through eleven');
  // A book printed in capitals keeps its capitals: the name is not rewritten.
  reads('DEUTERONOMY 18:10–11', 'DEUTERONOMY eighteen ten through eleven');
});

test('scripture: a trailing verse letter is read as the letter', () => {
  reads('Revelation 18:23b', 'Revelation eighteen twenty three b');
  reads('Genesis 1:1a-2b', 'Genesis one one a through two b');
});

test('scripture: a numeric book prefix is an ORDINAL, not a count', () => {
  reads('1 John 4:1', 'First John four one');
  reads('1 John 1:9', 'First John one nine');
  reads('2 Cor. 10:4', 'Second Corinthians ten four');
  reads('2 Tim. 1:7', 'Second Timothy one seven');
  reads('1 Sam. 3:1', 'First Samuel three one');
  reads('Read 2 Chron. 7:14 aloud', 'Read Second Chronicles seven fourteen aloud');
});

test('scripture: a numbered book with NO reference still gets its ordinal', () => {
  // Owen's own example. "2 Corinthians" is a book in every context there is.
  reads('2 Corinthians teaches otherwise', 'Second Corinthians teaches otherwise');
  reads('1 Peter was written later', 'First Peter was written later');
  // JOHN is the exception, and deliberately: "1 John" with no reference after it
  // is as likely to be a person, so the SCRIPTURE rule declines it. (The generic
  // integer rule then reads the bare "1" as "one", which is what it reads every
  // other bare digit as — the point is that no ordinal was invented.)
  assert.ok(!claims('1 John was there').some(([rule]) => rule === 'scripture'),
    'no ordinal prefix without a reference to settle it');
});

test('scripture: the standard abbreviations expand to the book name', () => {
  // The 57 WORDS_DROPPED refusals of the 2026-09-02 run were exactly this: the
  // model expanding an abbreviation and the validator throwing it away.
  reads('Ps. 27:1', 'Psalm twenty seven one');
  reads('Eph. 6:12', 'Ephesians six twelve');
  reads('Rom. 1:22', 'Romans one twenty two');
  reads('Isa. 14:12-14', 'Isaiah fourteen twelve through fourteen');
  reads('Jam. 4:7', 'James four seven');
  reads('Lev. 20:27', 'Leviticus twenty twenty seven');
  reads('Matt. 7:22', 'Matthew seven twenty two');
  reads('Deut. 18:9–12', 'Deuteronomy eighteen nine through twelve');
  reads('Heb. 2:14-15', 'Hebrews two fourteen through fifteen');
  reads('Rev. 12:7-10', 'Revelation twelve seven through ten');
});

test('scripture: a BARE reference converts only when the two readings coincide', () => {
  // No book name, so it is scripture or a clock time. At a verse of ten or more
  // they read the same and it is safe: "6:59" is "six fifty nine" either way.
  reads('It was 6:59 p.m. exactly', 'It was six fifty nine p.m. exactly');
  reads('The meeting ran to 5:45', 'The meeting ran to five forty five');
  // Under ten they do NOT: "10:05" could be "ten oh five". Left for the model.
  untouched('The train left at 10:05 sharp');
  untouched('at 7:02 that morning');
});

test('clock: a meridiem or an on-the-hour time is a clock, never chapter and verse', () => {
  // The Mac's first live run (2026-09-03): "2:00 p.m." fell to the model and
  // came back "two oh two p.m.".
  reads('It began at 2:00 p.m. sharp', 'It began at two p.m. sharp');
  reads('at 10:05 am the bell rang', 'at ten oh five am the bell rang');
  reads('by 7:30 P.M.', 'by seven thirty P.M.');
  reads('The service was at 6:00', "The service was at six o'clock");
  assert.deepStrictEqual(claims('at 2:00 p.m. and again at 3:15 p.m.').map((c) => c[0]), ['clock', 'clock']);
  // Scripture still wins its own shapes: a verse of zero does not exist, and a
  // meridiem never follows a reference.
  reads('John 3:16 says so', 'John three sixteen says so');
  reads('(Leviticus 19:31; 20:6)', '(Leviticus nineteen thirty one; twenty six)');
  // A clock range stays whole for the model.
  untouched('open 9:00-5:00 daily');
});

test('scripture: a bare reference CONTINUING a book-anchored list is scripture', () => {
  // The n2 acceptance run (2026-09-02) left "20:6" to the model, which read it
  // "twenty". A reference joined to a named one by ; , or "and" is a verse of
  // that book, never a clock time — whatever the verse number.
  reads('(Leviticus 19:31; 20:6)', '(Leviticus nineteen thirty one; twenty six)');
  reads('Genesis 6:11, 13 and 7:1 say so', 'Genesis six eleven, thirteen and seven one say so');
  reads('see Isa. 5:20, 6:3', 'see Isaiah five twenty, six three');
  // Any other word between them breaks the chain: this is a time again.
  assert.deepStrictEqual(claims('Lev. 19:31 and then 7:02'), [['scripture', 'Lev. 19:31']]);
  assert.deepStrictEqual(claims('Lev. 19:31. At 7:02 he left'), [['scripture', 'Lev. 19:31']]);
});

test('scripture: a clock RANGE is left whole, never half-read', () => {
  // "6:00" is a verse under ten and would be declined on its own, which would
  // leave "five thirty-6:00" — half a range, in two notations. The whole shape
  // is blocked instead.
  untouched('from 5:30-6:00 today');
  // Two separate times, both past the coincidence point, are just two times.
  reads('between 9:15 and 10:45 he waited',
    'between nine fifteen and ten forty five he waited');
});

test('scripture: "ff." is read "and following", never dropped', () => {
  reads('Matthew 5:16ff. said so', 'Matthew five sixteen and following said so');
});

test('scripture: only the REFERENCE is claimed, never what trails it', () => {
  // Owen's two cases. The scripture rule takes the reference and stops.
  assert.deepStrictEqual(claims('Genesis 6:11, 13')[0], ['scripture', '6:11']);
  assert.deepStrictEqual(claims('Job 41:1–2, 14–34')[0], ['scripture', '41:1–2']);
  // A verse range trailing a reference is a dash between digits, which no rule
  // touches — so "14–34" reaches the model exactly as printed.
  assert.strictEqual(spoken('Job 41:1–2, 14–34'),
    'Job forty one one through two, 14–34');
});

// ─────────────────────────────────────────────────────────────────────────────
// The standalone integer
// ─────────────────────────────────────────────────────────────────────────────

test('integer: a bare 1-3 digit number, keeping the punctuation it wears', () => {
  reads('1. Amulet', 'one. Amulet');
  reads('12. Talisman', 'twelve. Talisman');
  reads('(see 8)', '(see eight)');
  reads('There were 8.', 'There were eight.');
  reads('Page 60', 'Page sixty');
  reads('Jude 9', 'Jude nine');
  reads('Isaiah 29 is the chapter', 'Isaiah twenty nine is the chapter');
});

test('integer: four digits are the model\'s judgement, not a rule\'s', () => {
  untouched('In 1985 it began');
  untouched('1200 people came');
  untouched('He was born in 1944 and never said so.');
  untouched('1144');
});

test('integer: every adjacency on Owen\'s list refuses it', () => {
  // COVID-19 and "p. 23" were on this list until Owen's ruling of 2026-09-04
  // moved them off it — a digit glued to letters and a page reference are both
  // READ now, by rules of their own below. What is left here is the apparatus
  // that has no spoken reading at all.
  untouched('file 298/38 there');          // a slash
  untouched('Document II 9/34 filed');     // a slash, and a roman numeral
  untouched('vol. 2');                     // a volume citation
  untouched('Chapter 3: The Long Year');   // a colon — a label, not a number
  untouched('235-5396');                   // dashes between digits
  untouched('8-9 of them');                // a range
  untouched('73101');                      // five digits
  untouched('code 001 here');              // a leading zero is a code, not one
});

test('integer: an area code beside a phone number is half a phone number', () => {
  // Measured 2026-09-02 on the scripture book: without this guard the rules read
  // "(405) 235-5396" as "(four hundred five) 235-5396" — the worst of both.
  untouched('call (405) 235-5396 today');
  untouched('scheduled at (619) 471-1722.');
  // And a bare number beside ordinary prose is still an ordinary number.
  reads('In 1985, 8 men came', 'In 1985, eight men came');
});

// ─────────────────────────────────────────────────────────────────────────────
// The rest of the rules
// ─────────────────────────────────────────────────────────────────────────────

test('marker: "#N" is "number N"', () => {
  reads('Argument #1', 'Argument number one');
  reads('Argument #12 follows', 'Argument number twelve follows');
});

test('ordinal: hyphenated, the one place the style differs from the cardinal', () => {
  reads('Friday the 13th', 'Friday the thirteenth');
  reads('the 7th of them', 'the seventh of them');
  reads('the 23rd time', 'the twenty-third time');
  reads('the 1st and the 2nd', 'the first and the second');
});

test('percent: the book\'s own word survives', () => {
  reads('74 percent', 'seventy four percent');
  reads('It was 50% done', 'It was fifty percent done');
  reads('37.4 per cent of it', 'thirty seven point four per cent of it');
  reads('74 per cent', 'seventy four per cent');
});

test('decade: the year, pluralized; the apostrophe form, as printed', () => {
  reads('the 1900s', 'the nineteen hundreds');
  reads('the 1930s', 'the nineteen thirties');
  reads("the '70s", 'the seventies');
});

test('grouped: a comma-grouped integer is the cardinal', () => {
  reads('5,000 of them', 'five thousand of them');
  reads('1,250,000 Marks', 'one million two hundred fifty thousand Marks');
  reads('Some 3,450 came', 'Some three thousand four hundred fifty came');
});

test('money: the amount, the unit, and the cents', () => {
  reads('$5.50', 'five dollars and fifty cents');
  reads('$5', 'five dollars');
  reads('$1', 'one dollar');
  reads('$0.50', 'fifty cents');
  reads('50¢', 'fifty cents');
  reads('$5,000', 'five thousand dollars');
  // The scale word takes the decimal WITH it — the defect number-expansion.ts
  // has for this exact shape (it reads "one million dollars", dropping the .5).
  reads('$1.5 million', 'one point five million dollars');
  reads('£5.50', 'five pounds and fifty pence');
  reads('€20', 'twenty euros');
});

test('date: American order, whichever order the book prints', () => {
  reads('December 19, 1991', 'December nineteenth, nineteen ninety-one');
  reads('12 June 1933', 'June twelfth, nineteen thirty-three');
  reads('March 14, 1955', 'March fourteenth, nineteen fifty-five');
  reads('October 31', 'October thirty-first');
  reads('December 19 alone', 'December nineteenth alone');
  // The weekday is not part of the date span, so it survives untouched.
  reads('Saturday, January 26, 1991',
    'Saturday, January twenty-sixth, nineteen ninety-one');
  reads('Monday, September 7, 1992', 'Monday, September seventh, nineteen ninety-two');
});

test('date: a month ABBREVIATION expands to the month', () => {
  reads('Dec. 19, 1991', 'December nineteenth, nineteen ninety-one');
  reads('Sept. 7, 1992', 'September seventh, nineteen ninety-two');
  reads('12 Jun. 1933', 'June twelfth, nineteen thirty-three');
});

test('the leave-alone list, in one place', () => {
  for (const printed of [
    'vol. 2', 'no. 5', 'Document II 9/34', '298/38', '9/34',
    '1985', '1200 people', '10:05', '73101',
    'AfW HH R 231191', 'a ratio of 3.14159 exactly', 'Henry VIII',
    // A serial, a version and a leading zero are still codes, whatever letters
    // stand beside them — the glued rule refuses all three by shape.
    'X-007', 'v1.2 of the spec', 'part A1B2C3D4 here', 'model Z-12345',
  ]) untouched(printed);
});

// ─────────────────────────────────────────────────────────────────────────────
// The two shapes Owen's 2026-09-04 ruling moved OFF the leave-alone list
// ─────────────────────────────────────────────────────────────────────────────

test('page: a page reference is READ — the abbreviation picks the word', () => {
  reads('see p. 23 now', 'see page twenty three now');
  reads('pp. 65-71', 'pages sixty five to seventy one');
  reads('P. 23 has the figure.', 'Page twenty three has the figure.');
  // An en dash is the same range.
  reads('pp. 65\u201371', 'pages sixty five to seventy one');
  // The cardinals are UNHYPHENATED, which is `cardinalWords`' form and the form
  // the fine-tunes were trained on — see this file's own doctrine note.
  reads('p. 95', 'page ninety five');
  // A volume, a number and "ibid." are still apparatus.
  untouched('vol. 2');
  untouched('no. 5');
  // A leading zero is a code, not a page.
  untouched('pp. 007-010');
});

test('glued: digits glued to letters are READ — "that is how it is pronounced"', () => {
  reads('COVID-19 spread', 'COVID-nineteen spread');
  reads('a B-17 flying past', 'a B-seventeen flying past');
  reads('I-95 north', 'I-ninety five north');
  reads('the 7-Eleven', 'the seven-Eleven');
  // No hyphen: the words need a space, or "Rtwo" is not a word.
  reads('R2D2 beeping', 'R two D two beeping');
  reads('an MP3 player', 'an MP three player');
  reads('ISBN-13 code', 'ISBN-thirteen code');
  // The DECADE rule owns this one, and it runs first: "1940s-era" is a decade
  // with a word after it, not a token with a number in it.
  reads('the 1940s-era rules', 'the nineteen forties-era rules');
  // And the letters are the book's, never re-cased: "7-Eleven" keeps its E.
  reads('7-Eleven', 'seven-Eleven');
});

test('glued: a FUSED suffix leaves the digits, because <br/> joins words', () => {
  // The walk joins the words either side of a line break with nothing between
  // them, so "the 3rd<br/>day" arrives as "the 3rdday". The trailing lookahead
  // that used to guard this was defeated by exactly that, and the token read
  // "three rdday" (the second adversarial review, 2026-09-04). n4 left the
  // digits for the model; so does n5.
  untouched('the 3rdday');
  untouched('the 21stcentury');
  untouched('mid-90sera');
  untouched('the 2ndhalf');
  untouched('a 4thwall');
});

test('glued: digits pressed against letters are a MEASUREMENT, left to the model', () => {
  // This rule has no table of units and cannot tell "4a" (a Sonderkommando) from
  // "4A" (a seat), so it read "one hundred five mm" and destroyed the digits.
  for (const printed of [
    'a 105mm gun', '9mm rounds', '20km away', '5kg of it', '12V supply', '8GB of RAM',
    '6ft tall', 'Sonderkommando 4a',
  ]) untouched(printed);
  // And the LETTER-prefix and hyphenated forms this rule is for are unaffected.
  reads('an F8F fighter', 'an F eight F fighter');
  reads('a C18 engine', 'a C eighteen engine');
  reads('a V-2 rocket', 'a V-two rocket');
  reads('the 7-Eleven', 'the seven-Eleven');
  reads('a 24-hour day', 'a twenty four-hour day');
});

test('glued: the n4 -> n5 RESIDUAL SET, and why each one stays', () => {
  // The five spans the third adversarial review measured as still printing a
  // digit after n5. Each is left deliberately, and this is the record of which:
  //
  //   RFZ 1     an archive sigil in front of a bare integer (isArchiveSigil)
  //   ADL 122   the same
  //   18B       digits pressed against a trailing letter (DIGITS_THEN_UNIT)
  //   SS1488    a FOUR-digit run inside a letter-prefixed token
  //   L-1011    the same, hyphenated
  //
  // The last two could only be read by admitting four-digit runs again, and that
  // is the exact shape of "pre-1914", "Kennedy-1963" and "Louis XIV-1715" — a
  // year. Nothing in a rule can tell an aircraft from a year, so they go to the
  // model, which can read the sentence. Left, and listed.
  for (const printed of ['RFZ 1', 'ADL 122', '18B', 'SS1488', 'L-1011']) untouched(printed);

  // And the defect that bought them stays bought.
  for (const printed of [
    'pre-1914 Europe', 'post-1945 Germany', 'the Kennedy-1963 assassination', 'Louis XIV-1715',
    'By the mid-1920s at the latest', 'a mid-19th century view',
  ]) untouched(printed);
});

test('glued: a code is still a code — the guards, one by one', () => {
  untouched('X-007 file');            // a leading zero
  untouched('model Z-12345');         // five digits
  untouched('part A1B2C3D4');         // four runs: a part number
  untouched('v1.2 of the spec');      // a version: a period then a digit
  untouched('Document II 9/34');      // a slash, and a roman neighbour
  untouched('298/38');                // a slash
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotence, offsets, and the text nodes
// ─────────────────────────────────────────────────────────────────────────────

test('running the rules on their own output changes nothing', () => {
  const book = [
    'On 23 March 1933 the Reichstag met, and the pamphlet cost $5.50.',
    'See 2 Cor. 10:4 and Ps. 27:1; 74 percent of the 1930s went that way.',
    '1. Amulet  2. Talisman  3. Charm — Argument #1 of the 1900s.',
    'Genesis 6:11, 13 and Job 41:1–2, 14–34 were read on December 19, 1991.',
    'It cost $1.5 million, or 5,000 marks, at 6:59 p.m. on the 23rd.',
  ].join('\n');
  const once = read(book);
  const twice = rules.applyNumberRules(once.text, [once.text.length]);
  assert.deepStrictEqual(twice.rewrites, [], `re-read: ${twice.text}`);
  assert.strictEqual(twice.text, once.text);
});

test('every offset is against the ORIGINAL text, exactly', () => {
  const text = 'On 23 March 1933 he read 2 Cor. 10:4 and paid $5.50 for it.';
  const out = read(text);
  assert.ok(out.rewrites.length >= 3, `three shapes at least: ${JSON.stringify(out.rewrites)}`);
  for (const edit of out.rewrites) {
    assert.strictEqual(text.slice(edit.at, edit.at + edit.find.length), edit.find,
      `"${edit.find}" is not at ${edit.at}`);
  }
  // Sorted and non-overlapping, which is what makes them spliceable in one pass.
  for (let i = 1; i < out.rewrites.length; i++) {
    const prior = out.rewrites[i - 1];
    assert.ok(prior.at + prior.find.length <= out.rewrites[i].at, 'no overlap');
  }
  // And splicing them by hand gives exactly the text the rules returned.
  let built = '';
  let cursor = 0;
  for (const edit of out.rewrites) {
    built += text.slice(cursor, edit.at) + edit.replace;
    cursor = edit.at + edit.find.length;
  }
  assert.strictEqual(built + text.slice(cursor), out.text);
});

test('a span that would cross a text node is REFUSED, and recorded', () => {
  // "He was born in " + "19" + "44 and paid $5." — the money sits across the
  // second boundary. (An <em> around the "19" is what makes three nodes.)
  const text = 'He was born in 1944 and paid $5.50 for it.';
  const cut = 'He was born in 1944 and paid $5.'.length;
  const out = rules.applyNumberRules(text, [cut, text.length - cut]);
  assert.strictEqual(out.text, text, 'nothing was applied');
  assert.deepStrictEqual(out.rewrites, []);
  assert.strictEqual(out.refused.length, 1);
  assert.strictEqual(out.refused[0].rule, 'money');
  assert.strictEqual(out.refused[0].find, '$5.50');
  assert.ok(out.refused[0].reason.includes('text-node'));
});

test('a refused span is closed to every later rule', () => {
  // The money rule cannot have "$5.50" whole, so the integer rule must not come
  // back and read the "50" out of the wreckage.
  const text = 'It cost $5.50 today.';
  const cut = 'It cost $5.'.length;
  const out = rules.applyNumberRules(text, [cut, text.length - cut]);
  assert.strictEqual(out.text, text);
  assert.ok(!out.text.includes('fifty'));
});

test('the segments come back grown by exactly what landed in each node', () => {
  const text = 'Paid $5.50 then, and $1 later.';
  const cut = 'Paid $5.50 then, '.length;
  const out = rules.applyNumberRules(text, [cut, text.length - cut]);
  assert.strictEqual(out.segments.reduce((a, b) => a + b, 0), out.text.length,
    'the node lengths still describe the text');
  assert.strictEqual(out.rewrites.length, 2);
});

test('segments that do not describe the text are an ERROR, not a guess', () => {
  assert.throws(() => rules.applyNumberRules('He paid $5.', [3]),
    /two different strings/);
});

test('a text with no digits comes back identical, with no work done', () => {
  const text = 'Nothing here but words, and a great many of them at that.';
  untouched(text);
  assert.strictEqual(rules.stillHasDigits(text), false);
  assert.strictEqual(rules.stillHasDigits('and 1944'), true);
});

test('the cardinal is the unhyphenated corpus form, and stops where e2a stops', () => {
  assert.strictEqual(rules.cardinalWords(0), 'zero');
  assert.strictEqual(rules.cardinalWords(44), 'forty four');
  assert.strictEqual(rules.cardinalWords(250), 'two hundred fifty');
  assert.strictEqual(rules.cardinalWords(3450), 'three thousand four hundred fifty');
  assert.strictEqual(rules.cardinalWords(10000), null, 'past e2a\'s own range');
  assert.strictEqual(rules.bigCardinalWords(1250000),
    'one million two hundred fifty thousand');
  assert.strictEqual(rules.bigCardinalWords(1e12), null);
});

// ─────────────────────────────────────────────────────────────────────────────

// ── the citation lead, and the words that only look like one ────────────────
//
// The LIVE model run of 2026-09-04 read "iii. 1281-2" as a quantity — "one
// thousand two hundred eighty-one to two" — a volume, a page and a range all
// misread at once. Owen's ruling: a roman numeral and a period in front of a
// number is a citation lead, and an abbreviated page range behind a page lead is
// apparatus. Both stay as printed.

const cited = (text, find) => rules.sitsInCitation(text, find, text.indexOf(find));

test('a roman citation lead makes the number after it apparatus', () => {
  assert.ok(cited('iii. 1281-2 is the passage.', 'iii. 1281-2'));
  assert.ok(cited('He cites iii. 1281-2 there.', '1281-2'));
  assert.ok(cited('The note reads II. 45 exactly.', 'II. 45'));
  assert.ok(cited('See pp. 51-2 for this.', '51-2'));
  assert.ok(cited('At fol. 128-9 in the file.', '128-9'));
});

test('an English word spelled from IVXLCDM is NOT a citation lead', () => {
  // A loose [ivxlcdm]+ also spells ordinary English, and every one of these
  // would have had its number refused as apparatus.
  assert.ok(!cited('he did. 45 men remained', '45'));
  assert.ok(!cited('it was mild. 12 degrees', '12'));
  assert.ok(!cited('the civil. 90 percent agreed', '90'));
  reads('he did. 45 men remained', 'he did. forty five men remained');
});

test('a bare prose range keeps the number prompt reading', () => {
  // The shipped prompt teaches an abbreviated range read in full, so only an
  // APPARATUS range is claimed here; `test-prompt-examples` holds the other end.
  assert.ok(!cited('A 112-14 spread ran in prose.', '112-14'));
  assert.ok(!cited('the 128-9 range of values', '128-9'));
  assert.ok(!cited('over 1935-36 the party grew', '1935-36'), 'a year range belongs to the model');
});

test('an abbreviated page range is left whole, not read literally', () => {
  // Until 2026-09-04 the page rule read "pp. 51-2" as "pages fifty one to two".
  untouched('See pp. 51-2 for this.');
  reads('See pp. 51-53 for this.', 'See pages fifty one to fifty three for this.');
});

test('a day-first date with no year reads the American spoken way', () => {
  reads('He wrote his last report, which was on 4 September.',
    'He wrote his last report, which was on September fourth.');
  reads('The order of 23 March was clear.',
    'The order of March twenty-third was clear.');
  // The abbreviation's period is the abbreviation's, unless a sentence follows.
  reads('it was on 4 Sept. and later', 'it was on September fourth and later');
  reads('It was 4 Sept. The next day it rained.',
    'It was September fourth. The next day it rained.');
});

test('the yearless rule does not touch a date that HAS a year', () => {
  reads('On 4 September 1939 the war began.',
    'On September fourth, nineteen thirty-nine the war began.');
  assert.deepStrictEqual(claims('On 4 September 1939 the war began.'),
    [['date', '4 September 1939']], 'one claim, by the with-year rule');
});

test('a lead word keeps the digit a numbered thing, not a day', () => {
  reads('Chapter 4 September opens the file.',
    'Chapter four September opens the file.');
  reads('Part 4 September follows.', 'Part four September follows.');
  reads('see p. 4 September there', 'see page four September there');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err && err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`\n${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
