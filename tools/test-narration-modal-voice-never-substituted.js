#!/usr/bin/env node
'use strict';
/**
 * The narration modal never chooses a voice on the user's behalf.
 *
 * Owen's Mac render of Working Towards the Fuhrer (2026-09-06) went out in the
 * base model's own speaker because `selectEngine` replaced a voice that did not
 * belong to the new engine with `available[0]` — and the Higgs catalog's first
 * entry is "default", a real, renderable voice, so nothing refused. This keeper
 * reads the component source and fails if any code path assigns an element of
 * a voice list to the voice signal, or if the engine switch / preset paths
 * stopped clearing a voice that does not belong, or if the submit check
 * stopped refusing the empty and the foreign voice by name.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const file = path.join(__dirname, '..', 'src', 'app', 'features', 'studio', 'components',
  'narration-modal', 'narration-modal.component.ts');
const src = fs.readFileSync(file, 'utf8');
let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  ok    ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

check('no code path assigns a list element to the voice signal', () => {
  const bad = /this\.voice\.set\(\s*(?:first|available\[0\]|listed\[0\]|options\[0\])/;
  assert.ok(!bad.test(src), 'the voice signal is assigned from a list element');
  assert.ok(!/const first = available\[0\]/.test(src), 'the `available[0]` substitution is back');
});

check('an engine switch and a preset both drop a voice that does not belong', () => {
  assert.ok(/selectEngine\(id: TTSEngine\): void \{[\s\S]*?this\.dropVoiceUnlessItBelongs\(id\);/.test(src));
  assert.ok(/applyPreset\(id: string\): void \{[\s\S]*?this\.dropVoiceUnlessItBelongs\(preset\.ttsEngine\);/.test(src));
  assert.ok(/private dropVoiceUnlessItBelongs\(engine: TTSEngine\): void \{[\s\S]*?this\.voice\.set\(''\);/.test(src));
});

check('the submit check refuses an empty voice and a foreign voice by name', () => {
  assert.ok(src.includes('voice is chosen. Pick one on the Reading tab.'));
  assert.ok(src.includes('is not a ${engineName} voice on this machine'));
});

check('the picker shows a placeholder rather than a substituted choice', () => {
  assert.ok(/placeholder="Choose a voice"/.test(src));
});

if (failed) { console.log(`\n${failed} check(s) FAILED.`); process.exitCode = 1; }
else console.log('\nnarration-modal voice: never substituted.');
