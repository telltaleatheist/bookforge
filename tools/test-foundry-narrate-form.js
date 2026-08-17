#!/usr/bin/env node
/**
 * Tests for electron/foundry-narrate-form.ts — the questions Narrate asks in
 * Foundry's window, and the reading of what comes back.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-narrate-form.js
 *
 * ── Why this is testable at all ─────────────────────────────────────────────
 *
 * Because both halves are pure decisions about values. The module imports
 * nothing from Electron, touches no disk and knows no queue: it is handed the
 * saved settings and a voice list and gives back a field description, and it is
 * handed a bag of `unknown`s and gives back three proved answers. So every
 * refusal below is reachable from a hand-built object rather than by running two
 * applications and clearing a text box.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - NOTHING IS INVENTED. Foundry validates none of what it hands back and says
 *    so; a missing voice, a device this app cannot use and an emptied Workers
 *    box are all refusals here, because the alternative is nine hours of GPU
 *    spent at a setting nobody chose.
 *  - AN EMPTY NUMBER ARRIVES OMITTED, not as NaN. That is the contract's stated
 *    rule for the control, so the absent case is the one a user actually
 *    produces, and it must not read as "1".
 *  - A SAVED SETTING THAT IS NOT THERE IS NOT A SHIPPED DEFAULT. The renderer's
 *    own accessor merges over one; this deliberately does not, and the refusal
 *    names the door that sets it.
 *  - THE VOICE DEFAULT IS ONLY SEEDED WHEN IT IS STILL INSTALLED, so the dialog
 *    never opens showing a chosen voice this machine cannot render.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-narrate-form.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const form = require(path.join(DIST, 'foundry-narrate-form.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A settings blob exactly as `SettingsService` writes `pipelineDefaults`. */
function saved(over = {}) {
  return {
    cleanupProvider: 'ollama', cleanupModel: '',
    ttsEngine: 'orpheus',
    ttsDevice: 'auto',
    ttsVoice: 'leah',
    ttsSpeed: 1,
    ttsTemperature: 0.6,
    ttsTopP: 0.9,
    generateVideo: false,
    ttsRepetitionPenalty: 1.1,
    rvcEnhancementEnabled: false,
    rvcEnhancementVoiceId: '',
    rvcEnhancementIndexRate: 0.5,
    rvcEnhancementProtectRate: 0.5,
    rvcEnhancementNSemitones: 0,
    ...over,
  };
}

const VOICES = [
  { value: 'leah', label: 'Leah (Female, American)' },
  { value: 'zac', label: 'Zac (Male, American)' },
];

const fieldNamed = (fields, key) => fields.find((f) => f.key === key);

// ── The saved settings ──────────────────────────────────────────────────────

test('a whole saved record reads back as the run\'s settings', () => {
  const read = form.readNarrateSavedSettings(saved());
  assert.strictEqual(read.ttsEngine, 'orpheus');
  assert.strictEqual(read.ttsVoice, 'leah');
  assert.strictEqual(read.ttsRepetitionPenalty, 1.1);
  assert.strictEqual(read.rvcEnhancementEnabled, false);
});

test('nothing saved at all is a refusal that names the door that saves it', () => {
  assert.throws(() => form.readNarrateSavedSettings(null), /Settings → Pipeline Defaults/);
  assert.throws(() => form.readNarrateSavedSettings(undefined), /Settings → Pipeline Defaults/);
});

test('a missing setting is refused BY NAME, never filled from the shipped default', () => {
  // `getPipelineDefaults()` on the renderer's side merges over
  // DEFAULT_PIPELINE_DEFAULTS, whose voice is 'ScarlettJohansson'. Reading a
  // blob with no voice must NOT quietly become that: an audiobook rendered in a
  // stock voice sounds finished and is wrong.
  const blob = saved();
  delete blob.ttsVoice;
  assert.throws(() => form.readNarrateSavedSettings(blob), /saved narration setting for the voice/);

  const noSpeed = saved();
  delete noSpeed.ttsSpeed;
  assert.throws(() => form.readNarrateSavedSettings(noSpeed), /the reading speed/);

  assert.throws(
    () => form.readNarrateSavedSettings(saved({ ttsEngine: '  ' })),
    /the TTS engine/);
});

test('the enhancement numbers are only required once the pass is on', () => {
  // Off: the four numbers beside it mean nothing, and a record that never
  // carried them is a complete answer.
  const off = saved();
  delete off.rvcEnhancementIndexRate;
  delete off.rvcEnhancementVoiceId;
  assert.strictEqual(form.readNarrateSavedSettings(off).rvcEnhancementEnabled, false);

  // On, with no model named: refused here rather than an hour into a GPU run.
  assert.throws(
    () => form.readNarrateSavedSettings(saved({ rvcEnhancementEnabled: true })),
    /the voice-conversion model/);

  const on = form.readNarrateSavedSettings(saved({
    rvcEnhancementEnabled: true,
    rvcEnhancementVoiceId: 'rvc-voice-sigma',
    rvcEnhancementNSemitones: -15,
  }));
  assert.strictEqual(on.rvcEnhancementVoiceId, 'rvc-voice-sigma');
  assert.strictEqual(on.rvcEnhancementNSemitones, -15);
});

// ── The form ────────────────────────────────────────────────────────────────

test('three questions, and the two Foundry needs bounds for carry them', () => {
  const fields = form.narrateFormFields(VOICES, form.readNarrateSavedSettings(saved()));
  assert.deepStrictEqual(fields.map((f) => f.key), ['voice', 'device', 'workers']);

  const device = fieldNamed(fields, 'device');
  assert.deepStrictEqual(device.options.map((o) => o.value), ['auto', 'gpu', 'cpu']);
  assert.strictEqual(device.default, 'auto');

  const workers = fieldNamed(fields, 'workers');
  assert.strictEqual(workers.kind, 'number');
  assert.strictEqual(workers.min, 1);
  assert.strictEqual(workers.max, form.NARRATE_MAX_WORKERS);
  assert.strictEqual(workers.default, 1);
});

test('the voice list is the one it was handed, in the order it was handed it', () => {
  const fields = form.narrateFormFields(VOICES, form.readNarrateSavedSettings(saved()));
  assert.deepStrictEqual(
    fieldNamed(fields, 'voice').options,
    [{ value: 'leah', label: 'Leah (Female, American)' },
      { value: 'zac', label: 'Zac (Male, American)' }]);
});

test('the saved voice seeds the picker only while it is still installed', () => {
  const installed = form.narrateFormFields(VOICES, form.readNarrateSavedSettings(saved()));
  assert.strictEqual(fieldNamed(installed, 'voice').default, 'leah');

  // The saved voice was uninstalled. The field carries NO default, so Foundry
  // seeds it with its first option — a voice that exists, which the person is
  // looking at before they press Start.
  const gone = form.narrateFormFields(
    VOICES, form.readNarrateSavedSettings(saved({ ttsVoice: 'someone-removed' })));
  assert.strictEqual('default' in fieldNamed(gone, 'voice'), false);
});

test('no installed voice is a refusal, not a picker with nothing in it', () => {
  assert.throws(
    () => form.narrateFormFields([], form.readNarrateSavedSettings(saved())),
    /No orpheus voice is installed/);
});

// ── The answers ─────────────────────────────────────────────────────────────

test('the three answers come back proved', () => {
  assert.deepStrictEqual(
    form.readNarrateAnswers({ voice: ' leah ', device: 'gpu', workers: 3 }),
    { voice: 'leah', device: 'gpu', workers: 3 });
});

test('a missing or empty voice is refused rather than chosen for the user', () => {
  assert.throws(() => form.readNarrateAnswers({ device: 'auto', workers: 1 }), /without a voice/);
  assert.throws(
    () => form.readNarrateAnswers({ voice: '   ', device: 'auto', workers: 1 }),
    /without a voice/);
});

test('a device this app cannot narrate on is named in the refusal', () => {
  assert.throws(
    () => form.readNarrateAnswers({ voice: 'leah', device: 'mps', workers: 1 }),
    /"mps" is not a device/);
  assert.throws(
    () => form.readNarrateAnswers({ voice: 'leah', workers: 1 }),
    /is not a device/);
});

test('an EMPTIED Workers box arrives omitted, and is refused rather than read as one', () => {
  // Foundry's stated rule for the control: a number the user cleared is left
  // OUT of `settings`, never sent as NaN. So this is the shape a real person
  // produces, and "1" would be this side answering a question it was asked.
  assert.throws(
    () => form.readNarrateAnswers({ voice: 'leah', device: 'auto' }),
    /Workers box empty/);
});

test('a worker count outside what the queue can run is refused with the range', () => {
  for (const workers of [0, 9, 2.5, '2']) {
    assert.throws(
      () => form.readNarrateAnswers({ voice: 'leah', device: 'auto', workers }),
      /number of narration workers/,
      `workers=${String(workers)} should be refused`);
  }
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  console.log(`\nfoundry-narrate-form: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
