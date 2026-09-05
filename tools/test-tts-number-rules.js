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
// Scripture — DETECTED and protected, never read here
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CONTRACT THESE TESTS DEFEND, and how it changed on 2026-09-05.
 *
 * Until n6 the rules READ a reference: "2 Cor. 10:4" came out "Second
 * Corinthians ten four", from a table of book abbreviations. Owen ended that
 * after a Higgs A/B render narrated "(1 Pet. 3:7)" as *"one pet three seven"*:
 * "I don't want to do it deterministically. An AI takes over. There are a
 * billion ways Bible verses are abbreviated."
 *
 * So the assertion changed shape. What is pinned now is:
 *
 *   DETECTION — the span is recognized, and recognized WHOLE. Half a reference
 *   protected is worse than none, because the unprotected half is what the
 *   integer rule reads, and "one pet three seven" is what that sounds like.
 *
 *   PROTECTION — the text comes back byte for byte. Every digit is still there
 *   when the model is asked, which is the only reason the model can read it.
 *
 *   THE MUST-NOT LIST — Owen's own, 2026-09-05, plus everything the adversarial
 *   review measured firing that day, one test per case. A detector is a claim
 *   about text the app does not own, and the cases it must NOT claim are the ones
 *   that say whether the claim is honest.
 *
 *   AND WHAT A MISS COSTS. A false positive is NOT free, which is the finding
 *   that produced the evidence test: inside a detected span the validator asks
 *   for a chapter-and-verse pause, so a detection on "Widescreen 16:9" made the
 *   correct reading unrepresentable — and the book-less rule, which read "Score
 *   21:19" correctly on main, never got the chance. So every must-NOT case below
 *   pins BOTH halves: nothing detected, and the reading main gave it, byte for
 *   byte.
 *
 * The READING lives in `electron/prompts/tts-number-normalize.txt` and is
 * measured against `tools/fixtures/scripture-readings.json` — sixty-six books
 * and the deuterocanon — by the Ollama-gated probe in
 * tools/test-tts-number-normalizer.js.
 */

/** The references the detector found, in order, exactly as printed. */
const detected = (text) => rules.scriptureSpans(text).map((s) => s.find);

/** Assert a text is detected as exactly these references, and left untouched. */
function protects(text, references) {
  assert.deepStrictEqual(detected(text), references, text);
  const out = read(text);
  assert.strictEqual(out.text, text, `a rule rewrote a protected reference: ${text}`);
  for (const rewrite of out.rewrites) {
    for (const span of out.scripture) {
      assert.ok(rewrite.at >= span.end || rewrite.at + rewrite.find.length <= span.at,
        `the ${rewrite.rule} rule reached into ${JSON.stringify(span.find)}`);
    }
  }
}

test('scripture: the reference Owen heard mangled is detected whole and left alone', () => {
  // The defect, verbatim from the render: "(1 Pet. 3:7)" narrated "one pet three
  // seven". Under n6 the whole reference — leading volume number included — is
  // one protected span, so the integer rule never sees the "1", the "3" or the
  // "7", and the model is asked for "First Peter three, seven".
  protects('to dwell with each other according to knowledge (1 Pet. 3:7).', ['1 Pet. 3:7']);
  protects('as it says in John 3:16 and 2 Cor. 5:17.', ['John 3:16', '2 Cor. 5:17']);
});

test('scripture: an abbreviation the app has never seen is detected on its shape', () => {
  // The point of dropping the table: detection asks nothing of the book but that
  // it be capitalized, so a house style nobody catalogued still gets protected.
  protects('see Zeph. 3:17 there', ['Zeph. 3:17']);
  protects('see Pt. 3:7 there', ['Pt. 3:7']);
  protects('see Qoheleth 3:1 there', ['Qoheleth 3:1']);
  protects('see Sirach 44:1 there', ['Sirach 44:1']);
});

test('scripture: ranges, letters, "ff." and chapter-crossing all belong to the span', () => {
  protects('Jeremiah 44:17-19 is the passage.', ['Jeremiah 44:17-19']);
  protects('Deuteronomy 18:10–11 says so', ['Deuteronomy 18:10–11']);
  protects('Revelation 18:23b says so', ['Revelation 18:23b']);
  protects('Genesis 1:1a-2b says so', ['Genesis 1:1a-2b']);
  protects('Matthew 5:16ff. said so', ['Matthew 5:16ff.']);
  protects('(Col. 3:19-4:1 and parallels)', ['Col. 3:19-4:1']);
});

test('scripture: a LIST of references is ONE span, bare verses included', () => {
  // The n2 acceptance run (2026-09-02) proved why: left outside the span, the
  // "20:6" of "Leviticus 19:31; 20:6" reached the model alone and came back
  // "twenty" — the verse gone. A bare "13" outside the span is worse still: the
  // integer rule reads it as a count while the model reads the rest as a verse.
  protects('(Leviticus 19:31; 20:6)', ['Leviticus 19:31; 20:6']);
  protects('Genesis 6:11, 13 and 7:1 say so', ['Genesis 6:11, 13 and 7:1']);
  protects('see Isa. 5:20, 6:3', ['Isa. 5:20, 6:3']);
  protects('Job 41:1–2, 14–34 there', ['Job 41:1–2, 14–34']);
  // Any other word between them breaks the chain, and the time is a time again.
  assert.deepStrictEqual(detected('Lev. 19:31 and then 7:02'), ['Lev. 19:31']);
  assert.strictEqual(spoken('Lev. 19:31 and then 7:02'), 'Lev. 19:31 and then 7:02');
});

test('scripture: a leading volume number makes a CHAPTER-ONLY reference detectable', () => {
  // THE DECISION, 2026-09-05: "1 Pet. 3" is detected and a bare "Gen. 3" is not.
  // Telling "Gen. 3" from "Fig. 3" needs a table of books, which is the very
  // thing Owen's ruling removed; a leading 1-3 is evidence that survives without
  // one, because English prints "1 Pet. 3" and never "1 Fig. 3".
  protects('1 Pet. 3 alone', ['1 Pet. 3']);
  protects('read 2 Chron. 7 aloud', ['2 Chron. 7']);
  assert.deepStrictEqual(detected('see Gen. 3 for that'), []);
  assert.strictEqual(spoken('see Gen. 3 for that'), 'see Gen. three for that');
});

test('scripture: a numbered book with no reference is protected, not read', () => {
  // "2 Corinthians" would otherwise be read "two Corinthians" by the integer
  // rule. It is protected so the model can say "Second"; the app no longer
  // claims to know that itself.
  protects('quoting 2 Corinthians at length', ['2 Corinthians']);
  protects('1 Peter was written later', ['1 Peter']);
  // JOHN is the exception, deliberately: "1 John" with no reference behind it is
  // as likely to be a person, so it is not detected and its "1" is read by the
  // integer rule exactly as every other bare digit is.
  assert.deepStrictEqual(detected('1 John was there'), []);
  assert.strictEqual(spoken('1 John was there'), 'one John was there');
});

// ─────────────────────────────────────────────────────────────────────────────
// Owen's MUST-NOT list, 2026-09-05 — one test per case
// ─────────────────────────────────────────────────────────────────────────────

/** Assert nothing is detected, and say what the deterministic pass does instead. */
function detectsNothing(text, expected) {
  assert.deepStrictEqual(detected(text), [], `wrongly detected: ${text}`);
  assert.strictEqual(spoken(text), expected, text);
}

test('must-NOT: a month is not a book', () => {
  detectsNothing('Jan. 3:7 was the date', 'Jan. 3:7 was the date');
  detectsNothing('Sept. 4:9 was the date', 'Sept. 4:9 was the date');
  // And with the verse past the coincidence point the book-LESS rule reads it —
  // "three seventeen" is what those digits say whether they turn out to be a
  // date, a time or something else, which is the whole licence that rule has.
  detectsNothing('Jan. 3:17 was the date', 'Jan. three seventeen was the date');
});

test('must-NOT: a title with no reference behind it', () => {
  detectsNothing('Gen. Patton arrived', 'Gen. Patton arrived');
  detectsNothing('Col. Nicholson agreed', 'Col. Nicholson agreed');
});

test('must-NOT: "vs." is not a book, and neither is a lowercase abbreviation', () => {
  detectsNothing('vs. 3:7 there', 'vs. 3:7 there');
  // "Ex." is Exodus and "ex." is not: a book name is capitalized, and the
  // capital is the only thing separating the two.
  assert.deepStrictEqual(detected('Ex. 3:7 vs ex. 3:7'), ['Ex. 3:7']);
  assert.strictEqual(spoken('Ex. 3:7 vs ex. 3:7'), 'Ex. 3:7 vs ex. 3:7');
});

test('must-NOT: an abbreviation with no period is not a chapter-only reference', () => {
  // Owen's case. Without the period the token is just a capitalized word, and
  // the detector has no evidence left; the integer rule reads the digits as it
  // reads every other bare digit, which is what it did before n6 too.
  detectsNothing('1 Pet 3 without period', 'one Pet three without period');
  // WITH a colon behind it the period is not needed — the reference shape is
  // its own evidence.
  protects('1 Pet 3:7 with a colon', ['1 Pet 3:7']);
});

test('must-NOT: an ordinary noun in front of a colon-number', () => {
  // No period, no volume number, not a canonical book name — no evidence, so no
  // claim. There is no list of these words any more: the first cut tried one and
  // the review walked straight through it with "Lakers", "Widescreen", "Flight",
  // "Docket", "BWV", every weekday and a sentence-initial "Then".
  detectsNothing('Chapter 3:7 begins', 'Chapter 3:7 begins');
  detectsNothing('Room 3:15 was locked', 'Room three fifteen was locked');
  detectsNothing('Table 4:2 shows it', 'Table 4:2 shows it');
  // "Acts" is a book and is NOT the "Act" of a play — but "Act" is THREE
  // LETTERS, so evidence (d) claims it anyway, exactly as it claims "Map" and
  // "Bus". The text still comes out as main printed it; the reading is the
  // model's, and the prompt names "Act 3:2" of a play among the shapes that get
  // no reference reading.
  protects('Acts 3:2 says so', ['Acts 3:2']);
  protects('Act 3:2 of the play', ['Act 3:2']);
});

test('must-NOT: an ordinary word capitalized by the sentence it starts', () => {
  // MEASURED against this suite, 2026-09-05: "See 20:6 there." put an ordinary
  // verb in the book's position — every word is capitalized at the start of a
  // sentence — and the reference was detected. It is the evidence test that
  // refuses it now, not a list of verbs.
  // Under ten the book-less rule declines the verse too, so the line stands as
  // printed and the model is asked about it — which is what it was before n6.
  detectsNothing('See 20:6 there.', 'See 20:6 there.');
  detectsNothing('Read 20:6 aloud', 'Read 20:6 aloud');
  // Past the coincidence point it reads them as the plain numbers they are.
  detectsNothing('Compare 20:16 with it', 'Compare twenty sixteen with it');
  detectsNothing('In 20:16 he says', 'In twenty sixteen he says');
});

test('must-NOT: a book citing its own last reference — "Verses 28:7-8"', () => {
  // "Verses" and "Chapters" have no evidence; "Acts", "Numbers", "Judges" and
  // "Lamentations" are canonical book names and have shape (c).
  assert.deepStrictEqual(detected('Verses 28:7-8 say so.'), []);
  assert.deepStrictEqual(detected('Chapters 3:1-4:2 cover it'), []);
  protects('Numbers 6:24 says so', ['Numbers 6:24']);
  protects('Judges 6:12 says so', ['Judges 6:12']);
  protects('Lamentations 3:22 says so', ['Lamentations 3:22']);
});

/**
 * THE FALSE-POSITIVE TABLE, from the adversarial review of 2026-09-05.
 *
 * Every one of these fired under the first cut of the detector. The expected
 * output of each is what `main` produces — measured, not guessed, by running
 * main's own compiled rules over the same strings — because the whole point of
 * the evidence test is that a shape with no evidence must keep the behaviour it
 * had before this branch existed.
 *
 * The three-letter ones from that table — "Map 2:1", "Bus 47:15", "BWV 3:7" —
 * are NOT here: evidence (d) claims them, deliberately, and they are asserted in
 * the (d) test above along with what that costs.
 */
test('must-NOT: none of the shapes the review measured firing', () => {
  // A capitalized word with no period, no volume number and no canonical name.
  detectsNothing('Widescreen 16:9 is standard.', 'Widescreen 16:9 is standard.');
  detectsNothing('Aspect 16:9 is standard.', 'Aspect 16:9 is standard.');
  detectsNothing('Lakers 3:1 in the series.', 'Lakers 3:1 in the series.');
  detectsNothing('Route 66:1 was renumbered.', 'Route 66:1 was renumbered.');
  detectsNothing('Ratios 3:7 and 4:8 measured.', 'Ratios 3:7 and 4:8 measured.');
  detectsNothing('Hebrews Street 3:7 nonsense.', 'Hebrews Street 3:7 nonsense.');
  // …and the ones main READ, which is the half a false positive was taking away.
  detectsNothing('Score 21:19 in the final set.', 'Score twenty one nineteen in the final set.');
  detectsNothing('Flight 12:30 boards now.', 'Flight twelve thirty boards now.');
  detectsNothing('Windows 3:11 was an OS.', 'Windows three eleven was an OS.');
  detectsNothing('Docket 5:12 was entered.', 'Docket five twelve was entered.');
  detectsNothing('Recording 12:34 shows the fault.', 'Recording twelve thirty four shows the fault.');
  detectsNothing('Dilution 1:100 of the reagent.', 'Dilution one one hundred of the reagent.');
  // Every weekday, which no list of nouns was ever going to hold.
  detectsNothing('Meeting Tuesday 14:30 tomorrow.', 'Meeting Tuesday fourteen thirty tomorrow.');
  detectsNothing('Wednesday 9:45 he arrived.', 'Wednesday nine forty five he arrived.');
  detectsNothing('Then 9:45 he arrived.', 'Then nine forty five he arrived.');
});

test('scripture: the four kinds of evidence, and nothing else', () => {
  // (a) an ABBREVIATION — it carries its own period.
  protects('see Zeph. 3:17 there', ['Zeph. 3:17']);
  protects('see Pt. 3:7 there', ['Pt. 3:7']);
  // (b) a VOLUME NUMBER — arabic, roman or ordinal.
  protects('read 2 Kgs. 2:11 aloud', ['2 Kgs. 2:11']);
  protects('See II Cor. 5:17 there.', ['II Cor. 5:17']);
  protects('See III John 1:4 there.', ['III John 1:4']);
  protects('See 1st John 1:9 there.', ['1st John 1:9']);
  // (c) a FULL CANONICAL BOOK NAME.
  protects('Genesis 3:15 is quoted.', ['Genesis 3:15']);
  protects('Revelation 21:4 says so.', ['Revelation 21:4']);
  protects('Qoheleth 3:1 says so.', ['Qoheleth 3:1']);
  // (d) TWO OR THREE LETTERS with no period at all — weak evidence, admitted
  // because refusing it left every dotless abbreviation unreadable.
  protects('Ps 23:1 without a period.', ['Ps 23:1']);
  protects('Jn 3:16 is the famous one.', ['Jn 3:16']);
  protects('Rev 21:4 says so.', ['Rev 21:4']);
  protects('Mt 5:3 is the sermon.', ['Mt 5:3']);
  // …and FOUR letters is where it stops. Every longer dotless word keeps main's
  // own reading, which the table below pins one by one.
  assert.deepStrictEqual(detected('Then 9:45 he arrived.'), []);
  assert.deepStrictEqual(detected('Odds 5:2 against.'), []);
  assert.deepStrictEqual(detected('Case 5:12 was filed.'), []);
});

/**
 * EVIDENCE (d), and the two things that make it affordable.
 *
 * A dotless "Ps 23:1" is the same shape as "Map 2:1", so on its own it proves
 * nothing. It is admitted because refusing it left every dotless abbreviation
 * UNREADABLE: the model's "Psalm twenty three, verse one" was refused
 * WORDS_DROPPED, since that relaxation is scoped to detected spans, and the
 * digits reached the narrator — a regression from this app's own behaviour in
 * exactly the domain the branch exists for.
 *
 * What pays for it is the validator's claim test, which is asserted in
 * tools/test-tts-number-normalizer.js: a reading that names a canonical book is
 * held to the chapter-and-verse pause, and one that does not is accepted as the
 * prose it is. So the SAME detection serves "Jn 3:16" → "John three, verse
 * sixteen" and "Map 2:1" → "Map two one".
 *
 * THE COST, asserted here rather than described: a 2-3 letter token in front of
 * a c:v is protected, so the book-less rule no longer reads it and the reading
 * depends on the model. "Bus 47:15" is the measured example.
 */
test('scripture: (d) admits the dotless abbreviation, and what that costs', () => {
  // The four the abbreviation table used to read, back inside the pass.
  protects('Ps 23:1 without a period.', ['Ps 23:1']);
  protects('Jn 3:16 is the famous one.', ['Jn 3:16']);
  protects('Rev 21:4 says so.', ['Rev 21:4']);
  protects('Mt 5:3 is the sermon.', ['Mt 5:3']);
  // The same shape that is NOT a book comes with them. `protects` already
  // asserts the text is unchanged, which IS the cost: main read "Bus 47:15" as
  // "Bus forty seven fifteen" by rule, and now the model reads it instead.
  protects('Map 2:1 scale.', ['Map 2:1']);
  protects('Bus 47:15 leaves hourly.', ['Bus 47:15']);
  protects('Bach BWV 3:7 hmm.', ['BWV 3:7']);
  // A MONTH is still refused whether or not it prints its period — Owen's
  // must-NOT list, and the one word-level exception the detector keeps.
  assert.deepStrictEqual(detected('Jan 3:7 was the date.'), []);
  assert.deepStrictEqual(detected('Sep 4:9 was the date.'), []);
  // …and so is the other grammatical slot: a short word that POINTS at a number
  // instead of naming a thing. These keep main's reading exactly.
  detectsNothing('See 20:6 there.', 'See 20:6 there.');
  detectsNothing('In 20:16 he says', 'In twenty sixteen he says');
});

test('scripture: the list tail is bounded by what a verse could be', () => {
  // MEASURED, adversarial review 2026-09-05: the swallow loop had one guard and
  // took an ordinary number with it, and a swallowed number is a number no rule
  // can read any more.
  assert.deepStrictEqual(detected('Quoting Rom. 8:28, 250 members left.'), ['Rom. 8:28']);
  assert.strictEqual(spoken('Quoting Rom. 8:28, 250 members left.'),
    'Quoting Rom. 8:28, two hundred fifty members left.');
  assert.deepStrictEqual(detected('Isa. 5:20 and 1,000 copies went out.'), ['Isa. 5:20']);
  assert.strictEqual(spoken('Isa. 5:20 and 1,000 copies went out.'),
    'Isa. 5:20 and one thousand copies went out.');
  // A 4-digit tail was already refused, and still is.
  assert.deepStrictEqual(detected('See Ps. 23:1; 1914 was the year.'), ['Ps. 23:1']);
  // The bound is the highest verse there is — Psalm 119:176 — so a real list of
  // verses is untouched by it.
  protects('Ps. 119:97, 101, 176 are cited.', ['Ps. 119:97, 101, 176']);
});

test('must-NOT: a book name AFTER the digits is no evidence at all', () => {
  // "at 3:16 John left" must not become a reference. It keeps the book-LESS
  // reading — plain numbers, no scripture pause — which is what it read before
  // n6 and what a clock would read too.
  detectsNothing('at 3:16 John left', 'at three sixteen John left');
});

test('must-NOT: a reference carrying a meridiem is a clock', () => {
  detectsNothing('meet at 2:00 p.m. sharp', 'meet at two p.m. sharp');
  // Even with a capitalized word in front of it: a verse is never followed by a
  // meridiem, whatever stands before the digits. The clock rule takes the first
  // (hours one to twelve); the second is past the hours it knows, so the
  // book-less rule reads it — "fifteen thirty", which is what a twenty-four-hour
  // time says. Neither is DETECTED, which is the assertion.
  detectsNothing('Luke 2:30 p.m. oddity', 'Luke two thirty p.m. oddity');
  detectsNothing('Luke 15:30 p.m. oddity', 'Luke fifteen thirty p.m. oddity');
});

test('must-NOT: a multi-word book keeps its extra words outside the span', () => {
  // "Song of Songs 2:1" is detected on its last token, which is all detection
  // needs — nothing rewrites "Song of", and the model is shown the whole block.
  protects('Song of Songs 2:1 says', ['Songs 2:1']);
  protects('Philemon 1:4 says', ['Philemon 1:4']);
});

test('scripture: a BOOK-LESS reference is read only where the two readings coincide', () => {
  // No book, so the pass does not know whether these are verses or a clock. At a
  // verse of ten or more it does not need to — "6:59" is "six fifty nine" either
  // way — and under ten it does, so those are left for the model. UNCHANGED from
  // n5, and deliberately not given the scripture comma.
  reads('The meeting ran to 5:45', 'The meeting ran to five forty five');
  reads('It was 6:59 p.m. exactly', 'It was six fifty nine p.m. exactly');
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
  assert.deepStrictEqual(claims('at 2:00 p.m. and again at 3:15 p.m.').map((c) => c[0]),
    ['clock', 'clock']);
  // A clock range stays whole for the model.
  untouched('open 9:00-5:00 daily');
});

/**
 * THE BOOK TABLE, WHERE IT NOW LIVES — as evidence, never as a rule.
 *
 * `tools/fixtures/scripture-readings.json` is ninety-nine references: the
 * sixty-six books in the abbreviations a publisher prints, the deuterocanon, the
 * shapes (ranges, lists, "ff.", chapter-only), and the readings measured off the
 * deathstalker corpus. The model is judged against the READINGS by the
 * Ollama-gated probe in tools/test-tts-number-normalizer.js.
 *
 * What is answerable HERE, offline, is the half that is this file's: every one
 * of those references must be DETECTED, and detected whole. A book the detector
 * misses is a book the model is never asked about, and its digits are narrated.
 */
test('scripture: every reference in the evidence set is detected, whole', () => {
  const evidence = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'scripture-readings.json'), 'utf8'));
  assert.ok(evidence.cases.length >= 90, `${evidence.cases.length} cases`);
  for (const c of evidence.cases) {
    assert.deepStrictEqual(detected(c.in), [c.find], c.id);
    assert.strictEqual(spoken(c.in), c.in, `${c.id}: a rule rewrote a protected reference`);
    assert.ok(Array.isArray(c.accept) && c.accept.length > 0, `${c.id}: no reading declared`);
  }
});

test('scripture: a clock RANGE is left whole, never half-read', () => {
  untouched('from 5:30-6:00 today');
  // Two separate times, both past the coincidence point, are just two times.
  reads('between 9:15 and 10:45 he waited',
    'between nine fifteen and ten forty five he waited');
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
  // No scripture reference in this line on purpose: a reference is PROTECTED
  // under n6, so it produces no rewrite to have an offset. The offsets under
  // test are the ones rules actually make.
  const text = 'On 23 March 1933 he read 250 pages and paid $5.50 for it.';
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
