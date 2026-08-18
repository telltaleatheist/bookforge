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
 * saved settings, a voice list and what RVC is installed, and gives back a field
 * description; it is handed a bag of `unknown`s and gives back proved answers. So
 * every refusal below is reachable from a hand-built object rather than by running
 * two applications and clearing a text box.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - THE DIALOG CARRIES THE NARRATION MODAL'S CONTROL SET (Owen, 2026-08-16),
 *    assembly section included — and NOT a workers box, because worker count is
 *    deprecated and a run always uses one.
 *  - THE FORM IS NOT THE SAME SHAPE ON EVERY MACHINE. An engine with no sampling
 *    caps is asked no temperature; a machine with no RVC models is offered no
 *    enhancement. Which questions were asked travels WITH the fields, because
 *    reading the answers depends on it.
 *  - NOTHING IS INVENTED. Foundry validates none of what it hands back and says
 *    so; a missing voice, a device this app cannot use and an emptied number box
 *    are all refusals here, because the alternative is nine hours of GPU spent at
 *    a setting nobody chose.
 *  - AN EMPTY NUMBER ARRIVES OMITTED, not as NaN. That is the contract's stated
 *    rule for the control, so the absent case is the one a user actually
 *    produces, and it must not read as the saved value.
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

/** No voice-conversion environment at all — the commonest machine. */
const NO_RVC = { envInstalled: false, models: [] };
/** The environment and two models, which is what makes the select appear. */
const RVC = {
  envInstalled: true,
  models: [
    { id: 'rvc-voice-sigma', name: 'Sigma' },
    { id: 'rvc-voice-owen', name: 'Owen Morgan' },
  ],
};

const fieldNamed = (fields, key) => fields.find((f) => f.key === key);

/** The offer an Orpheus machine with no RVC gets. */
const orpheusOffer = (over = {}, rvc = NO_RVC) =>
  form.narrateFormOffer(VOICES, form.readNarrateSavedSettings(saved(over)), rvc);

/** The offer an XTTS machine gets — the one engine with sampling controls. */
const xttsOffer = (over = {}, rvc = NO_RVC) => orpheusOffer({ ttsEngine: 'xtts', ...over }, rvc);

/** A complete, valid answer bag for the Orpheus form (no sampling trio). */
function orpheusAnswers(over = {}) {
  return {
    narrate: true,
    assemble: true,
    voice: 'leah',
    device: 'auto',
    speed: 1,
    finalDenoise: false,
    applyDeRing: false,
    ...over,
  };
}

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

test('the enhancement MODEL is only required once the saved pass is on', () => {
  // Off: the model name means nothing, and a record that never carried it is a
  // complete answer.
  const off = saved();
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

test('the enhancement RATES are required even with the saved pass off', () => {
  // The dialog can turn the pass ON for a machine whose Settings has it off, and
  // the rates are not asked anywhere — so reading an absent index rate as zero
  // would re-render the whole audiobook at a setting nobody typed.
  for (const key of [
    'rvcEnhancementIndexRate', 'rvcEnhancementProtectRate', 'rvcEnhancementNSemitones',
  ]) {
    const blob = saved();
    delete blob[key];
    assert.throws(
      () => form.readNarrateSavedSettings(blob),
      /voice-conversion/,
      `${key} should be refused by name`);
  }
});

// ── The form ────────────────────────────────────────────────────────────────

test('an engine with no sampling caps is asked no sampling numbers — but IS asked speed', () => {
  // Orpheus fixes its sampling inside the engine class, so temperature/top-p/
  // repetition are three boxes that would change nothing about the audio. Speed
  // is NOT in that group: the narration modal draws its speed slider outside the
  // Advanced gate, for every engine, and this dialog matches it.
  const { fields, asked } = orpheusOffer();
  assert.deepStrictEqual(fields.map((f) => f.key), [
    'narrate', 'assemble', 'voice', 'device', 'speed', 'finalDenoise', 'applyDeRing',
  ]);
  assert.deepStrictEqual(asked, {
    temperature: false, topP: false, repetitionPenalty: false, enhancementModelIds: null,
  });
});

test('an engine WITH sampling caps is asked all three, after speed', () => {
  const { fields, asked } = xttsOffer();
  assert.deepStrictEqual(fields.map((f) => f.key), [
    'narrate', 'assemble', 'voice', 'device',
    'speed', 'temperature', 'topP', 'repetitionPenalty',
    'finalDenoise', 'applyDeRing',
  ]);
  assert.deepStrictEqual(asked, {
    temperature: true, topP: true, repetitionPenalty: true, enhancementModelIds: null,
  });
});

test('the workers question is gone — a run always uses one', () => {
  // Owen, 2026-08-16: worker count is deprecated. Not a hidden field, not a
  // field with max 1: absent.
  assert.strictEqual(fieldNamed(xttsOffer({}, RVC).fields, 'workers'), undefined);
  assert.strictEqual(fieldNamed(orpheusOffer().fields, 'workers'), undefined);
  assert.strictEqual(form.NARRATE_MAX_WORKERS, undefined);
});

test('the two toggles that say what the run does are both drawn ON', () => {
  const { fields } = orpheusOffer();
  const narrate = fieldNamed(fields, 'narrate');
  assert.strictEqual(narrate.kind, 'toggle');
  assert.strictEqual(narrate.label, 'Read the book aloud');
  assert.strictEqual(narrate.default, true);

  const assemble = fieldNamed(fields, 'assemble');
  assert.strictEqual(assemble.label, 'Assemble the audiobook');
  assert.strictEqual(assemble.default, true);
});

test('the assembly passes are drawn OFF, as the modal\'s checkboxes start', () => {
  const { fields } = orpheusOffer();
  const denoise = fieldNamed(fields, 'finalDenoise');
  assert.strictEqual(denoise.kind, 'toggle');
  assert.strictEqual(denoise.label, 'Denoise the finished audio');
  assert.strictEqual(denoise.default, false);

  const dering = fieldNamed(fields, 'applyDeRing');
  assert.strictEqual(dering.label, 'Remove ringing');
  assert.strictEqual(dering.default, false);
});

test('every number carries the modal slider\'s own bounds and the saved value', () => {
  const { fields } = xttsOffer();
  const expected = {
    speed: { min: 0.5, max: 2, default: 1 },
    temperature: { min: 0.1, max: 1.0, default: 0.6 },
    topP: { min: 0.1, max: 1.0, default: 0.9 },
    repetitionPenalty: { min: 1, max: 10, default: 1.1 },
  };
  for (const [key, want] of Object.entries(expected)) {
    const field = fieldNamed(fields, key);
    assert.strictEqual(field.kind, 'number', `${key} should be a number`);
    assert.strictEqual(field.min, want.min, `${key} min`);
    assert.strictEqual(field.max, want.max, `${key} max`);
    assert.strictEqual(field.default, want.default, `${key} default`);
  }
});

test('the device picker offers three, defaulted to Auto', () => {
  const device = fieldNamed(orpheusOffer().fields, 'device');
  assert.deepStrictEqual(device.options.map((o) => o.value), ['auto', 'gpu', 'cpu']);
  assert.strictEqual(device.default, 'auto');
});

test('the voice list is the one it was handed, in the order it was handed it', () => {
  assert.deepStrictEqual(
    fieldNamed(orpheusOffer().fields, 'voice').options,
    [{ value: 'leah', label: 'Leah (Female, American)' },
      { value: 'zac', label: 'Zac (Male, American)' }]);
});

test('the saved voice seeds the picker only while it is still installed', () => {
  assert.strictEqual(fieldNamed(orpheusOffer().fields, 'voice').default, 'leah');

  // The saved voice was uninstalled. The field carries NO default, so Foundry
  // seeds it with its first option — a voice that exists, which the person is
  // looking at before they press Start.
  const gone = orpheusOffer({ ttsVoice: 'someone-removed' });
  assert.strictEqual('default' in fieldNamed(gone.fields, 'voice'), false);
});

test('no installed voice is a refusal, not a picker with nothing in it', () => {
  assert.throws(
    () => form.narrateFormOffer([], form.readNarrateSavedSettings(saved()), NO_RVC),
    /No orpheus voice is installed/);
});

test('a saved engine this build does not have is refused, not looked up anyway', () => {
  assert.throws(
    () => orpheusOffer({ ttsEngine: 'bark' }),
    /"bark" as the TTS engine/);
});

// ── The enhancement select ──────────────────────────────────────────────────

test('the enhancement select needs BOTH the environment and a model', () => {
  assert.strictEqual(fieldNamed(orpheusOffer({}, NO_RVC).fields, 'enhancement'), undefined);
  // Models with no environment behind them are not an offer: the run would fail
  // an hour in, inside the step.
  assert.strictEqual(
    fieldNamed(orpheusOffer({}, { envInstalled: false, models: RVC.models }).fields, 'enhancement'),
    undefined);
  // An environment with nothing to render through is a select with one option
  // that means "no".
  assert.strictEqual(
    fieldNamed(orpheusOffer({}, { envInstalled: true, models: [] }).fields, 'enhancement'),
    undefined);
});

test('the select puts None first and then the installed models, by id', () => {
  const { fields, asked } = orpheusOffer({}, RVC);
  const enhancement = fieldNamed(fields, 'enhancement');
  assert.strictEqual(enhancement.kind, 'select');
  assert.strictEqual(enhancement.label, 'Re-render through an RVC voice');
  assert.deepStrictEqual(enhancement.options, [
    { value: 'none', label: 'None' },
    { value: 'rvc-voice-sigma', label: 'Sigma' },
    { value: 'rvc-voice-owen', label: 'Owen Morgan' },
  ]);
  assert.deepStrictEqual(asked.enhancementModelIds, ['rvc-voice-sigma', 'rvc-voice-owen']);
  // Last field, as it is the last control of the modal's assembly section.
  assert.strictEqual(fields[fields.length - 1].key, 'enhancement');
});

test('the select starts on the saved model only when the pass is on AND it is installed', () => {
  const on = orpheusOffer(
    { rvcEnhancementEnabled: true, rvcEnhancementVoiceId: 'rvc-voice-owen' }, RVC);
  assert.strictEqual(fieldNamed(on.fields, 'enhancement').default, 'rvc-voice-owen');

  // Saved pass off: the model may still be named in the blob, and it is not what
  // this run should start on.
  const off = orpheusOffer({ rvcEnhancementVoiceId: 'rvc-voice-owen' }, RVC);
  assert.strictEqual(fieldNamed(off.fields, 'enhancement').default, 'none');

  // Saved pass on, model uninstalled since: a default naming it would be a
  // chosen option this machine cannot render.
  const gone = orpheusOffer(
    { rvcEnhancementEnabled: true, rvcEnhancementVoiceId: 'rvc-voice-vanished' }, RVC);
  assert.strictEqual(fieldNamed(gone.fields, 'enhancement').default, 'none');
});

// ── The answers ─────────────────────────────────────────────────────────────

test('a full XTTS dialog comes back proved, every value the user\'s', () => {
  const { asked } = xttsOffer();
  const read = form.readNarrateAnswers(
    {
      narrate: true, assemble: true, voice: ' leah ', device: 'gpu',
      speed: 1.25, temperature: 0.8, topP: 0.5, repetitionPenalty: 3,
      finalDenoise: true, applyDeRing: true,
    },
    asked,
    form.readNarrateSavedSettings(saved({ ttsEngine: 'xtts' })));
  assert.deepStrictEqual(read, {
    narrate: true, assemble: true, voice: 'leah', device: 'gpu',
    speed: 1.25, temperature: 0.8, topP: 0.5, repetitionPenalty: 3,
    finalDenoise: true, applyDeRing: true, rvcVoiceId: null,
  });
});

test('a sampling number the form did not ask comes from the saved settings', () => {
  // NOT a fallback: Orpheus has no such control, was never asked, and the saved
  // record is the only source that run has for a number the config must carry.
  const { asked } = orpheusOffer();
  const read = form.readNarrateAnswers(
    orpheusAnswers({ speed: 1.75 }), asked, form.readNarrateSavedSettings(saved()));
  assert.strictEqual(read.temperature, 0.6);
  assert.strictEqual(read.topP, 0.9);
  assert.strictEqual(read.repetitionPenalty, 1.1);
  // Speed IS asked of every engine, so it is the dialog's answer and not the
  // saved 1 — which happens to differ here, on purpose.
  assert.strictEqual(read.speed, 1.75);
});

test('both toggles off is refused: there would be nothing to queue', () => {
  const { asked } = orpheusOffer();
  assert.throws(
    () => form.readNarrateAnswers(
      orpheusAnswers({ narrate: false, assemble: false }),
      asked, form.readNarrateSavedSettings(saved())),
    /nothing to queue/);
});

test('a toggle that came back as anything but a boolean is refused by its label', () => {
  const { asked } = orpheusOffer();
  const settings = form.readNarrateSavedSettings(saved());
  for (const [key, label] of Object.entries({
    narrate: 'Read the book aloud',
    assemble: 'Assemble the audiobook',
    finalDenoise: 'Denoise the finished audio',
    applyDeRing: 'Remove ringing',
  })) {
    const bag = orpheusAnswers();
    delete bag[key];
    assert.throws(
      () => form.readNarrateAnswers(bag, asked, settings),
      new RegExp(label),
      `${key} should be refused by name`);
  }
});

test('a missing or empty voice is refused rather than chosen for the user', () => {
  const { asked } = orpheusOffer();
  const settings = form.readNarrateSavedSettings(saved());
  const noVoice = orpheusAnswers();
  delete noVoice.voice;
  assert.throws(() => form.readNarrateAnswers(noVoice, asked, settings), /without a voice/);
  assert.throws(
    () => form.readNarrateAnswers(orpheusAnswers({ voice: '   ' }), asked, settings),
    /without a voice/);
});

test('a device this app cannot narrate on is named in the refusal', () => {
  const { asked } = orpheusOffer();
  const settings = form.readNarrateSavedSettings(saved());
  assert.throws(
    () => form.readNarrateAnswers(orpheusAnswers({ device: 'mps' }), asked, settings),
    /"mps" is not a device/);
  const noDevice = orpheusAnswers();
  delete noDevice.device;
  assert.throws(() => form.readNarrateAnswers(noDevice, asked, settings), /is not a device/);
});

test('an EMPTIED number box arrives omitted, and is refused rather than read as the saved one', () => {
  // Foundry's stated rule for the control: a number the user cleared is left OUT
  // of `settings`, never sent as NaN. So this is the shape a real person
  // produces, and the saved value would be this side answering a question it had
  // just asked.
  const { asked } = xttsOffer();
  const settings = form.readNarrateSavedSettings(saved({ ttsEngine: 'xtts' }));
  const full = {
    narrate: true, assemble: true, voice: 'leah', device: 'auto',
    speed: 1, temperature: 0.6, topP: 0.9, repetitionPenalty: 1.1,
    finalDenoise: false, applyDeRing: false,
  };
  for (const [key, label] of Object.entries({
    speed: 'Speed', temperature: 'Temperature',
    topP: 'Top P', repetitionPenalty: 'Repetition penalty',
  })) {
    const bag = { ...full };
    delete bag[key];
    assert.throws(
      () => form.readNarrateAnswers(bag, asked, settings),
      new RegExp(`${label} box empty`),
      `${key} should be refused by name`);
  }
});

test('a number outside the range its box was drawn with is refused WITH the range', () => {
  const { asked } = xttsOffer();
  const settings = form.readNarrateSavedSettings(saved({ ttsEngine: 'xtts' }));
  const full = {
    narrate: true, assemble: true, voice: 'leah', device: 'auto',
    speed: 1, temperature: 0.6, topP: 0.9, repetitionPenalty: 1.1,
    finalDenoise: false, applyDeRing: false,
  };
  const outOfRange = {
    speed: [0.4, 2.1, '1', NaN],
    temperature: [0, 1.5],
    topP: [0.05, 1.01],
    repetitionPenalty: [0.9, 11],
  };
  for (const [key, values] of Object.entries(outOfRange)) {
    for (const value of values) {
      assert.throws(
        () => form.readNarrateAnswers({ ...full, [key]: value }, asked, settings),
        /press Start again/,
        `${key}=${String(value)} should be refused`);
    }
  }
});

test('a sampling number the form did NOT ask is ignored, not proved', () => {
  // An Orpheus dialog has no temperature box, so a temperature in the bag is
  // something Foundry did not collect from a control — reading it would let a
  // stale answer decide a run whose engine ignores it anyway.
  const { asked } = orpheusOffer();
  const read = form.readNarrateAnswers(
    orpheusAnswers({ temperature: 99 }), asked, form.readNarrateSavedSettings(saved()));
  assert.strictEqual(read.temperature, 0.6);
});

test('enhancement: None means no pass, a model means that model', () => {
  const { asked } = orpheusOffer({}, RVC);
  const settings = form.readNarrateSavedSettings(saved());
  assert.strictEqual(
    form.readNarrateAnswers(orpheusAnswers({ enhancement: 'none' }), asked, settings).rvcVoiceId,
    null);
  assert.strictEqual(
    form.readNarrateAnswers(
      orpheusAnswers({ enhancement: 'rvc-voice-owen' }), asked, settings).rvcVoiceId,
    'rvc-voice-owen');
});

test('enhancement: a model that was never offered is refused, not passed along', () => {
  const { asked } = orpheusOffer({}, RVC);
  const settings = form.readNarrateSavedSettings(saved());
  for (const chosen of ['rvc-voice-vanished', '', 7, undefined]) {
    assert.throws(
      () => form.readNarrateAnswers(orpheusAnswers({ enhancement: chosen }), asked, settings),
      /voice-conversion models this machine has installed/,
      `enhancement=${String(chosen)} should be refused`);
  }
});

test('enhancement: a form that never asked leaves the pass off, whatever came back', () => {
  const { asked } = orpheusOffer({}, NO_RVC);
  const settings = form.readNarrateSavedSettings(saved({
    rvcEnhancementEnabled: true, rvcEnhancementVoiceId: 'rvc-voice-sigma',
  }));
  // Neither the stale answer nor the SAVED enhancement turns it on: this machine
  // has no environment to run it in, so the offer never carried the question.
  assert.strictEqual(
    form.readNarrateAnswers(
      orpheusAnswers({ enhancement: 'rvc-voice-sigma' }), asked, settings).rvcVoiceId,
    null);
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
