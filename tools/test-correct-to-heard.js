#!/usr/bin/env node
/**
 * THE CUE SAYS WHAT THE READER SAID — shared/sentence-align/correct-to-heard.ts
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-correct-to-heard.js
 *
 * The real Alloy of Law cases from the first live run, plus the ASR errors that must NOT change the book.
 */
'use strict';
const assert = require('assert');
const { correctToHeard } = require('../dist/shared/sentence-align/correct-to-heard.js');

let passed = 0; const failed = [];
function check(name, fn) { try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { failed.push(name); console.log(`  FAIL ${name}\n       ${e.message}`); } }
const words = (s) => s.split(/\s+/);

check('an edition difference: the reader\'s words replace the book\'s, punctuation kept', () => {
  const r = correctToHeard('Lessie, held with a garrote around her neck.', words('Lesci held with a gun to her head'));
  assert.strictEqual(r.text, 'Lessie, held with a gun to her head.');
});
check('a dropped clause is removed', () => {
  const r = correctToHeard('Waxillium raised an eyebrow as Wayne stepped forward.', words('Wayne stepped forward'));
  assert.strictEqual(r.text, 'Wayne stepped forward.');
});
check('a misread-and-correction is kept as the reader said it', () => {
  const r = correctToHeard('The large-caliber steel-jacketed bullet hit the balcony.',
    words('The large caliber copper jacketed lead steel jacketed bullet hit the balcony'));
  assert.strictEqual(r.text, 'The large-caliber copper jacketed lead steel-jacketed bullet hit the balcony.');
});
check('ASR near-miss spellings keep the book (proper nouns, "shuddering")', () => {
  const r = correctToHeard('Elend watched the chandeliers shattering above Vin.', words('Ellen watched the chandeliers shuddering above Vin'));
  assert.strictEqual(r.text, 'Elend watched the chandeliers shattering above Vin.'); assert.strictEqual(r.changed, false);
});
check('compounds either way keep the book\'s form', () => {
  assert.strictEqual(correctToHeard('No electric lights here; just good, warmth-giving hearths.', words('No electric lights here just good warmthgiving hearths')).changed, false);
  assert.strictEqual(correctToHeard('Perhaps the steel bubble had held.', words('Perhaps the steel bubblehead held')).changed, false);
});
check('an unchanged reading is returned exactly', () => {
  const t = '“No,” Wax thought, stepping back.';
  const r = correctToHeard(t, words('No Wax thought stepping back')); assert.strictEqual(r.text, t); assert.strictEqual(r.changed, false);
});
check('a cue that barely matches is left alone (more likely misplaced than reworded)', () => {
  const r = correctToHeard('The mists curled around the silent keep tonight.', words('he ran down the street toward the canal and shouted'));
  assert.strictEqual(r.changed, false); assert.ok(r.agreement < 0.3);
});

// ── Owen's spot check, 2026-09-26: every case below is a clip he listened to ──────────────────────────────────
check('spot check 1/8 + 2/6: an abbreviation becomes the SPOKEN word with no period ("Lieutenant Robin", "Saint Stephen\'s", "Matthew")', () => {
  const r = correctToHeard('Lt. Robin Huard from Engine 12 was next to him.', words('Lieutenant Robin Huard from Engine twelve was next to him'));
  assert.ok(r.text.startsWith('Lieutenant Robin Huard'), r.text);
  const s2 = correctToHeard('ferry the three of them to St. Stephen\'s.', words('ferry the three of them to Saint Stephen\'s'));
  assert.strictEqual(s2.text, 'ferry the three of them to Saint Stephen\'s.');
  const s3 = correctToHeard('went up into the hills (Matt. 14:23).', words('went up into the hills Matthew 14 verse 23'));
  assert.ok(/\(Matthew/.test(s3.text) && !/Matthew\./.test(s3.text), s3.text);
});
check('spot check 5: a NAME is never replaced by a mishearing ("Chantal" heard as "Gentile")', () => {
  const r = correctToHeard('Chantal leaned forward toward Skink.', words('Gentile leaned forward toward Skink'), { properNouns: new Set(['chantal', 'skink']) });
  assert.strictEqual(r.text, 'Chantal leaned forward toward Skink.');
  assert.strictEqual(r.changed, false);
});
check('spot check 15: numbers compare by value ("nine thousand" heard as "9000" keeps the book)', () => {
  const r = correctToHeard('firemen were dumping nine thousand gallons onto the building every minute.', words('firemen were dumping 9000 gallons onto the building every minute'));
  assert.strictEqual(r.text, 'firemen were dumping nine thousand gallons onto the building every minute.');
  assert.strictEqual(r.changed, false);
});
check('spot check 14: a sentence\'s first word, unheard, is kept ("If neither...")', () => {
  const r = correctToHeard('If neither explanation of the downturn seems sufficient, most voters had broader reasons.',
    words('neither explanation of the downturn seems sufficient most voters had broader reasons'));
  assert.ok(r.text.startsWith('If neither'), r.text);
});
check('a dropped opening CLAUSE (more than two words) still follows the reader', () => {
  const r = correctToHeard('Striking Box 1575 for a reported structure fire.', words('a reported structure fire'));
  assert.strictEqual(r.text, 'A reported structure fire.');
});
check('spot check 4/6: the reader\'s trailing words are inserted ("verse 21")', () => {
  const r = correctToHeard('Both were to be subordinate (Eph. 5:21).', words('Both were to be subordinate Ephesians 5 verse 21'));
  assert.ok(/verse/.test(r.text) && /\(Ephesians/.test(r.text), r.text);
});
// ── The second opinion (Owen 2026-09-27: "Have whisper large turbo or something run on the problematic spots") ──
check('round 2 #01: one model\'s mishearing ("to" -> "the") is vetoed by a second listen that hears the book', () => {
  const book = 'They kept moving, knowing that to stop was to concede defeat.';
  const r = correctToHeard(book, words('They kept moving knowing that the stop was to concede defeat'),
    { secondOpinion: words('They kept moving knowing that to stop was to concede defeat') });
  assert.strictEqual(r.text, book); assert.strictEqual(r.changed, false);
  assert.strictEqual(r.disputed.length, 1); assert.strictEqual(r.disputed[0].decision, 'book'); assert.ok(r.disputed[0].margin < 0);
});
check('round 2 #04: two models hearing DIFFERENT words both lose to the book ("is" -> "as" vs "is")', () => {
  const book = 'Jesus, the Lamb of God, is our Commander-in-Chief.';
  const r = correctToHeard(book, words('Jesus the Lamb of God as our commander in chief'),
    { secondOpinion: words('Jesus the Lamb of God is our commander in chief') });
  assert.ok(r.text.includes(', is our'), r.text);
});
check('an edit BOTH models make is applied (a real reader departure: "verse 21")', () => {
  const r = correctToHeard('Both were to be subordinate (Eph. 5:21).', words('Both were to be subordinate Ephesians 5 verse 21'),
    { secondOpinion: words('Both were to be subordinate Ephesians five verse twenty one') });
  assert.ok(/verse/.test(r.text) && /\(Ephesians/.test(r.text), r.text);
});
check('a dropped clause both models agree on is removed', () => {
  const r = correctToHeard('Waxillium raised an eyebrow as Wayne stepped forward.', words('Wayne stepped forward'),
    { secondOpinion: words('Wayne stepped forward') });
  assert.strictEqual(r.text, 'Wayne stepped forward.');
});
check('Owen\'s example: both models depart from the book but differently -> Qwen\'s version, whole ("the back of the book")', () => {
  const r = correctToHeard('Check table 21 for more information.', words('check the back of the book for more information'),
    { secondOpinion: words('check the back of a book for more information') });
  assert.strictEqual(r.text, 'Check the back of the book for more information.');
  assert.strictEqual(r.regions.length, 1); assert.strictEqual(r.regions[0].decision, 'qwen'); assert.ok(r.regions[0].margin > 0);
});
check('both models share a near-homophone the book lacks ("in" for "and") -> Qwen (a defensible ASR choice)', () => {
  const r = correctToHeard('the night and the alley throbbing', words('the night in the alley throbbing'),
    { secondOpinion: words('the night in the alley throbbing') });
  assert.strictEqual(r.text, 'the night in the alley throbbing');
});
check('the second listen hears nothing near either side (a tie) -> Qwen', () => {
  const r = correctToHeard('the brown gloop had eased the pain', words('the brown gloop eased the pain'),
    { secondOpinion: words('the brown gloop soothed the pain') });
  assert.strictEqual(r.regions[0].decision, 'qwen');
});
check('Owen: the book\'s names and unusual words are trusted ("Lukashenko", "fluttered")', () => {
  const r = correctToHeard('Mr. Lukashenko met them at the border.', words('Mister Lupavenko met them at the border'), { properNouns: new Set(['lukashenko']) });
  assert.ok(r.text.includes('Lukashenko'), r.text);
  const f = correctToHeard('LINDA MCGUIRK\'S EYES FLUTTERED OPEN IN THE DARK.', words('Linda McGuirk\'s eyes flooded open in the dark'), { rareWords: new Set(['fluttered']) });
  assert.ok(f.text.includes('FLUTTERED'), f.text);
});
check('the second-opinion test: a multi-word hyphenated compound is the book\'s word ("two-and-a-half-inch")', () => {
  const book = 'Lt. Robin Huard was next to him, manning a two-and-a-half-inch.';
  const r = correctToHeard(book, words('Lieutenant Robin Huard was next to him manning a two and a half inch'),
    { secondOpinion: words('Lieutenant Robin Heward was next to him, manning a 2 1\u20442 inch.') });
  assert.ok(r.text.includes('manning a two-and-a-half-inch'), r.text);
});
/*
 * DATES SAID THE OTHER WAY ROUND (2026-09-28, Owen's spot check via training-pc-1): Evans writes "1 December 1933", the
 * reader says "December first nineteen thirty-three", and the cue came back "December December 1933" - 1,039 cues
 * across the three Third Reich books. The same date in either order is one token; a reordered one follows the reader.
 */
check('a day-month date read month-first follows the reader, never a doubled month', () => {
  const r = correctToHeard('Then, on 1 December 1933, he appointed him to a cabinet post.',
    words('Then on December first nineteen thirty-three he appointed him to a cabinet post'));
  assert.strictEqual(r.text, 'Then, on December first nineteen thirty-three, he appointed him to a cabinet post.');
  const r2 = correctToHeard('The law was passed on 4 April 1933.', words('The law was passed on April fourth nineteen thirtythree'));
  assert.strictEqual(r2.text, 'The law was passed on April fourth nineteen thirtythree.');
  assert.ok(!/(\b\w+\b) \1/.test(r2.text), r2.text);
});
check('the real cue: a month is a NAME (capitalised mid-sentence), and a name used to "match" the heard day', () => {
  // tc cue 1053. With "december" among the book's proper nouns, "10"->"December" was a substitution and
  // "December"->"tenth" a protected name: "on December December 1918".
  const names = new Set(['december', 'berlin', 'friedrich', 'ebert']);
  const r = correctToHeard(
    'As the returning troops streamed into Berlin on 10 December 1918, the party leader Friedrich Ebert told them: ‘No enemy has overcome you!’',
    words('as the returning troops streamed into Berlin on December tenth nineteen eighteen the party leader Friedrich Ebert told them No enemy has overcome you'),
    { properNouns: names, secondOpinion: words('As the returning troops streamed into Berlin on December 10, 1918, the party leader Friedrich Ebert told them, No enemy has overcome you.') });
  assert.strictEqual(r.text, 'As the returning troops streamed into Berlin on December tenth nineteen eighteen, the party leader Friedrich Ebert told them: ‘No enemy has overcome you!’');
  const noYear = correctToHeard('Soon Brüning, who issued another emergency decree on 8 December requiring wages to be reduced.',
    words('Soon Bruning who issued another emergency decree on December eighth requiring wages to be reduced'), { properNouns: names });
  assert.ok(!/December December/.test(noYear.text), noYear.text);
});
check('the same date in the book\'s own order keeps the book, as numbers do', () => {
  const r = correctToHeard('Then, on 1 December 1933, he left.', words('Then on the first of December nineteen thirty three he left'));
  assert.strictEqual(r.text, 'Then, on 1 December 1933, he left.');
  assert.strictEqual(r.changed, false);
  const us = correctToHeard('It began on December 1, 1933.', words('It began on December first nineteen thirty-three'));
  assert.strictEqual(us.text, 'It began on December 1, 1933.');
});
check('a DIFFERENT date is the reader\'s, and a date is never a near-miss of another', () => {
  const r = correctToHeard('It began on 1 December 1933.', words('It began on December seventh nineteen thirty-three'));
  assert.strictEqual(r.text, 'It began on December seventh nineteen thirty-three.');
});
check('a spoken year pairs: "nineteen thirty-three" is 1933, so the book\'s digits stand', () => {
  const r = correctToHeard('By 1933 the party had won.', words('By nineteen thirty-three the party had won'));
  assert.strictEqual(r.text, 'By 1933 the party had won.');
  assert.strictEqual(r.changed, false);
});
/*
 * A HEARD WORD IS NEVER WRITTEN TWICE (2026-09-28, training-pc-1): about 25 doubled words across Deathstalker and
 * Mistborn, the same defect as the dates. A name "matched" any heard word for free, so wherever the book had a token
 * the reader did not voice ("&", an initial) the name slid onto the neighbouring heard word and the heard copy of the
 * name was inserted beside it. Every case below is a real cue, with the book-wide name set the pipeline builds.
 */
check('"Harper & Row" read "Harper and Row" is never "Harper Harper Row"', () => {
  const r = correctToHeard('I paid full tuition for a ten-minute interview with a representative from Harper & Row.',
    words('I paid full tuition for a tenminute interview with a representative from Harper and Row'),
    { properNouns: new Set(['harper', 'row']) });
  assert.strictEqual(r.text, 'I paid full tuition for a ten-minute interview with a representative from Harper and Row.');
});
check('a name beside a word the reader added is never doubled ("Peter Peter Drucker", "Libby Owens Libby-Owens-Ford")', () => {
  const r = correctToHeard('Peter Drucker said that people entering corporations now must understand that they may outlive these corporations.',
    words('Peter Drucker has said that people entering corporations now must understand that they may outlive these corporations'),
    { properNouns: new Set(['peter', 'drucker']) });
  assert.strictEqual(r.text, 'Peter Drucker has said that people entering corporations now must understand that they may outlive these corporations.');
  const l = correctToHeard('whose inventions and local company, Libby-Owens-Ford, revolutionized the glass business.',
    words('whose inventions and local company Libby Owens Ford revolutionized the glass business'),
    { properNouns: new Set(['libbyowensford']) });
  assert.ok(!/Libby Owens Libby/.test(l.text) && /Libby-Owens-Ford/.test(l.text), l.text);
});
check('an identical word wins a tie: "This book" read "This audiobook" is never "This This book"', () => {
  const r = correctToHeard('This book begins at that moment, the moment when it ended.', words('This audiobook begins at that moment the moment when it ended'));
  assert.ok(!/This This/.test(r.text), r.text);
});
check('a heard part of a hyphenated name is the name: "Reich Reich-Ranicki" is never written', () => {
  const r = correctToHeard('Every time he ventured out, Reich-Ranicki felt himself in danger.',
    words('Every time he ventured out Reich Riki felt himself in danger'), { properNouns: new Set(['reichranicki']) });
  assert.ok(!/Reich Reich/.test(r.text) && /Reich-Ranicki/.test(r.text), r.text);
});
check('a contraction either way: "I had" read "I\'d" is "I\'d", and "I\'ve" read "I have" is never "I I\'ve"', () => {
  assert.strictEqual(correctToHeard('I had never seen it before.', words("I'd never seen it before")).text, "I'd never seen it before.");
  const r = correctToHeard('Hitler replied: ‘In my life, I’ve always put my whole stake on the table.’',
    words('Hitler replied In my life I have always put my whole stake on the table'));
  assert.ok(!/\bI I/.test(r.text), r.text);
});
check('accents fold: "Mers-el-Kébir" read "Mers El Kebir" keeps the book\'s spelling', () => {
  const r = correctToHeard('British ships attacked the French naval base at Mers-el-Kébir, near Oran.',
    words('British ships attacked the French naval base at Mers El Kebir near Oran'));
  assert.strictEqual(r.text, 'British ships attacked the French naval base at Mers-el-Kébir, near Oran.');
});
check('the BOOK\'s own repetition is never touched ("Mama, Mama")', () => {
  const r = correctToHeard('‘Mama, Mama, what am I going to do?’', words('Mama Mama what am I going to do'));
  assert.strictEqual(r.text, '‘Mama, Mama, what am I going to do?’');
});
check('"may" and "march" as verbs are not dates', () => {
  const r = correctToHeard('The first may seem strange.', words('The first may seem strange'));
  assert.strictEqual(r.text, 'The first may seem strange.');
  assert.strictEqual(correctToHeard('In May twenty people came.', words('In May twenty people came')).changed, false);
});

console.log(`\ncorrect-to-heard: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
