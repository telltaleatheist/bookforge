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

console.log(`\ncorrect-to-heard: ${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
