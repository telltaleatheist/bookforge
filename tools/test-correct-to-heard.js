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
check('spot check 1/8: an abbreviation the reader expands stays the book\'s ("Lt." - no "Lieutenant." mid-sentence)', () => {
  const r = correctToHeard('Lt. Robin Huard from Engine 12 was next to him.', words('Lieutenant Robin Huard from Engine twelve was next to him'));
  assert.ok(r.text.startsWith('Lt. Robin Huard'), r.text);
  const s2 = correctToHeard('ferry the three of them to St. Stephen\'s.', words('ferry the three of them to Saint Stephen\'s'));
  assert.strictEqual(s2.text, 'ferry the three of them to St. Stephen\'s.');
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
  assert.ok(/verse/.test(r.text) && /Eph\./.test(r.text), r.text);
});
console.log(`\ncorrect-to-heard: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
