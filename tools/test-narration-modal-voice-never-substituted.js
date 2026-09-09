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

check('an engine switch drops a voice that does not belong', () => {
  // WAS "an engine switch AND A PRESET both drop...", asserting that
  // `applyPreset` called dropVoiceUnlessItBelongs(preset.ttsEngine). That line
  // is gone on purpose (2026-09-09): a preset no longer sets the engine, so it
  // has no engine to validate a voice against. The engine switch is now the
  // only thing that clears a voice, and it still refuses rather than
  // substitutes — which is what this file exists to protect.
  assert.ok(/selectEngine\(id: TTSEngine\): void \{[\s\S]*?this\.dropVoiceUnlessItBelongs\(id\);/.test(src));
  assert.ok(/private dropVoiceUnlessItBelongs\(engine: TTSEngine\): void \{[\s\S]*?this\.voice\.set\(''\);/.test(src));
});

check('a preset sets the CONVERSION only — never the engine, voice, device or speed', () => {
  // THE 2026-09-09 BUG, pinned. Every shipped preset named `orpheus`, so
  // applying one moved a Higgs run onto Orpheus silently — both engines ship a
  // voice called `deathstalker`, so the voice label did not change and no
  // refusal fired. Owen: "the preset is designed to change RVC settings,
  // nothing else." A whole book (step_mtuiyir4) rendered on the wrong engine.
  const body = src.slice(src.indexOf('applyPreset(id: string): void {'));
  const end = body.indexOf('\n  }');
  assert.ok(end > 0, 'applyPreset body not found');
  const apply = body.slice(0, end);
  for (const forbidden of ['this.engine.set(', 'this.voice.set(',
                           'this.device.set(', 'this.speed.set(']) {
    assert.ok(!apply.includes(forbidden),
      `applyPreset writes ${forbidden} — a preset is conversion settings only`);
  }
  // ...and it still applies the conversion it is for.
  assert.ok(apply.includes('this.onRvcToggled(preset.rvcEnhancementEnabled);'));
  assert.ok(apply.includes('this.rvcVoiceId.set(preset.rvcEnhancementVoiceId);'));

  // The shipped presets must not carry an engine or voice either: a reader that
  // starts obeying those fields again re-opens the bug.
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'core',
    'services', 'settings.service.ts'), 'utf-8');
  const builtins = settingsSrc.slice(
    settingsSrc.indexOf('BUILTIN_PIPELINE_PRESETS: PipelinePreset[] = ['));
  const listEnd = builtins.indexOf('\n];');
  assert.ok(listEnd > 0, 'BUILTIN_PIPELINE_PRESETS not found');
  const list = builtins.slice(0, listEnd);
  for (const dead of ['ttsEngine:', 'ttsVoice:', 'ttsSpeed:', 'ttsDevice:']) {
    assert.ok(!list.includes(dead),
      `a builtin preset still declares ${dead} — nothing reads it, and it is `
      + 'what moved a Higgs run onto Orpheus');
  }
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
