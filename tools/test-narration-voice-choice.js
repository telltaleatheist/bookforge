#!/usr/bin/env node
/**
 * A VOICE THE PICKER OFFERS IS A VOICE THE VALIDATOR ACCEPTS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-voice-choice.js
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * The narration modal drew its dropdown from the SERVERS' picker — one
 * `GET /v1/voices` per enabled Crucible server, asked on every open — and then
 * validated the chosen voice against the flat LOCAL catalog. Two lists, two
 * authorities, and a user could see the gap from either side:
 *
 *   - a voice a server serves that this box's catalog does not list was OFFERED
 *     and then refused, *"is not a Higgs voice on this machine"* — a sentence
 *     about a machine that was never going to render it;
 *   - a voice the PICKER marks unavailable (the 3090 has it, the weights are
 *     not pulled) was judged by the CATALOG's `unavailable`, which knows only
 *     about this disk, so the refusal sent the operator to the wrong machine.
 *
 * `shared/tts/voice-choice.ts` makes the offer once and both halves read it.
 * This suite drives that module directly — it is pure, no Angular, no IPC — and
 * asserts the PROPERTY rather than the wording: offered ⇒ accepted, and a
 * refusal carries the words of whoever refused.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'shared', 'tts', 'voice-choice.js');
if (!fs.existsSync(MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const vc = require(MOD);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

/** A picker answer, as `narrationVoicePicker` builds it. */
function picker(sections, { missing = [], complete = true, engines = ['higgs'] } = {}) {
  return { sections, engines, missing, complete, askedAt: new Date().toISOString() };
}
const pv = (value, { label = value, unavailable = null, servers = ['3090 Ti'] } = {}) =>
  ({ value, label, servers, unavailable });
const section = (label, voices, { locks = false, servers = ['3090 Ti'] } = {}) =>
  ({ label, servers, locks, voices });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Offered ⇒ accepted. The whole point of the module.
// ─────────────────────────────────────────────────────────────────────────────
console.log('the servers answered');

check('a voice the picker offers is ACCEPTED even when the local catalog lacks it', () => {
  /*
   * THE EXACT DEFECT. `mistborn` is served by the 3090 and is not in this
   * machine's shipped catalog (the catalog below holds only `deathstalker`).
   * Before the one-list rule this was drawn in the dropdown and then refused
   * with "is not a Higgs voice on this machine".
   */
  const offer = vc.voiceOffer(
    picker([section('3090 Ti', [pv('mistborn'), pv('deathstalker')])]),
    [{ value: 'deathstalker', label: 'Deathstalker' }],
  );
  assert.strictEqual(offer.source, 'servers');
  assert.ok(vc.offerCarries(offer, 'mistborn'), 'the offer does not carry the voice it drew');
  assert.strictEqual(vc.refuseVoiceChoice(offer, 'mistborn', 'Higgs'), null,
    'a voice the dropdown offered was refused');
});

check('every voice in every section is accepted — no section is validated away', () => {
  const offer = vc.voiceOffer(picker([
    section('Every server', [pv('deathstalker'), pv('default')], { servers: ['3090 Ti', 'M1 Ultra'] }),
    section('M1 Ultra', [pv('mistborn')], { locks: true, servers: ['M1 Ultra'] }),
  ]), []);
  for (const v of ['deathstalker', 'default', 'mistborn']) {
    assert.strictEqual(vc.refuseVoiceChoice(offer, v, 'Higgs'), null, `${v} was refused`);
  }
});

check('a voice the picker marks unavailable is refused IN THE PICKER\'S WORDS', () => {
  /*
   * The server's sentence, not the catalog's. "pull the weights on the 3090"
   * and "no reference clip on this machine" send a person to two different
   * places, and the catalog only ever knows the second.
   */
  const offer = vc.voiceOffer(picker([
    section('3090 Ti', [pv('mistborn', {
      label: 'Mistborn',
      unavailable: '3090 Ti: the weights are not pulled. Pull them on that host.',
    })]),
  ]), [{ value: 'mistborn', label: 'Mistborn', unavailable: 'no reference clip on this machine' }]);
  const why = vc.refuseVoiceChoice(offer, 'mistborn', 'Higgs');
  assert.ok(why, 'an unavailable voice was accepted');
  assert.match(why, /3090 Ti/, 'the refusal does not name the machine that refused');
  assert.match(why, /weights are not pulled/, "the refusal is not the server's sentence");
  assert.ok(!/reference clip/.test(why),
    "the CATALOG's reason was used for a voice the servers answered about");
});

check('a voice NO server serves is refused, and the sentence names the servers', () => {
  const offer = vc.voiceOffer(picker([section('3090 Ti', [pv('deathstalker')])]), []);
  const why = vc.refuseVoiceChoice(offer, 'leah', 'Higgs');
  assert.ok(why, 'a voice nothing serves was accepted');
  assert.match(why, /leah/, 'the refusal does not name the voice');
  assert.match(why, /Crucible server/,
    'the refusal blames this machine for a render that happens on a server');
  assert.match(why, /never replaced/,
    'the refusal does not state the rule that the choice is not substituted');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. No servers answered — the catalog, said as the catalog
// ─────────────────────────────────────────────────────────────────────────────
console.log('nobody answered');

check('the catalog is the offer, and it says so', () => {
  const offer = vc.voiceOffer(null, [
    { value: 'deathstalker', label: 'Deathstalker' },
    { value: 'default', label: 'Default' },
  ]);
  assert.strictEqual(offer.source, 'catalog');
  assert.strictEqual(offer.sections.length, 1, 'the catalog invented sections it cannot know');
  assert.strictEqual(offer.sections[0].locks, false,
    'a list that cannot see a server claimed to lock a venue');
  assert.strictEqual(vc.refuseVoiceChoice(offer, 'deathstalker', 'Higgs'), null);
});

check("a catalog refusal names THIS MACHINE's catalog, not a server", () => {
  const offer = vc.voiceOffer(null, [{ value: 'deathstalker', label: 'Deathstalker' }]);
  const why = vc.refuseVoiceChoice(offer, 'mistborn', 'Higgs');
  assert.match(why, /catalog/, 'the catalog refusal does not say where it looked');
  assert.ok(!/Crucible server/.test(why),
    'the catalog spoke for servers it never asked');
});

check("a catalog voice with no clip is refused in the CATALOG's words", () => {
  const offer = vc.voiceOffer(null, [{
    value: 'zeroshot-deathstalker',
    label: 'Deathstalker (Zero-shot) — not installed yet',
    unavailable: 'no clip at <userData>/runtime/higgs-models/refs/ds.wav. Record one first.',
  }]);
  const why = vc.refuseVoiceChoice(offer, 'zeroshot-deathstalker', 'Higgs');
  assert.match(why, /no clip at/, 'the local reason was dropped');
  assert.ok(!/not installed yet/.test(why),
    'the label\'s own tail is restated a few words before the reason, twice');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The two silences, which must NOT refuse
// ─────────────────────────────────────────────────────────────────────────────
console.log('while the answer is still arriving');

check('an EMPTY offer refuses nothing — it is not evidence', () => {
  // The servers are asked on every open and the catalog loads asynchronously.
  // Refusing on "the list has nothing in it" would block the button for the
  // second the modal takes to fill, and would clear a perfectly good voice.
  assert.strictEqual(vc.refuseVoiceChoice(vc.voiceOffer(null, []), 'deathstalker', 'Higgs'), null);
  assert.strictEqual(vc.refuseVoiceChoice(vc.voiceOffer(picker([]), []), 'deathstalker', 'Higgs'), null);
});

check('NO voice at all is always refused, whoever is answering', () => {
  // `selectEngine` clears the voice on purpose rather than substituting one;
  // this is the sentence that says so. It must not depend on the list.
  for (const offer of [vc.voiceOffer(null, []), vc.voiceOffer(picker([section('3090 Ti', [pv('x')])]), [])]) {
    const why = vc.refuseVoiceChoice(offer, '', 'Higgs');
    assert.ok(why, 'an empty voice was accepted');
    assert.match(why, /Higgs/, 'the refusal does not name the engine');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The modal reads the ONE list — source-level, because it is a component
// ─────────────────────────────────────────────────────────────────────────────
console.log('the modal');

check('the dropdown and both validators read the same computed', () => {
  /*
   * SOURCE-LEVEL: an Angular component cannot be require()d under plain node.
   * What is pinned is the shape that made the bug possible — the modal drawing
   * from one list and asking another. `voicesFor` may appear exactly once, in
   * `offer`, which is where the catalog half of the offer comes from.
   */
  const src = fs.readFileSync(path.join(REPO, 'src', 'app', 'features', 'studio', 'components',
    'narration-modal', 'narration-modal.component.ts'), 'utf-8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const voicesFor = (code.match(/this\.voices\.voicesFor\(/g) || []).length;
  assert.strictEqual(voicesFor, 1,
    `the modal reads the flat catalog ${voicesFor} times; exactly one (inside \`offer\`) is right`);
  assert.ok(/voiceOffer\(this\.voices\.voicePicker\(\)/.test(code),
    'the modal does not build its offer from the servers\' picker');
  assert.ok(/refuseVoiceChoice\(this\.offer\(\)/.test(code),
    'the modal does not validate against the offer it drew');
  assert.ok(!/picker\.sections\.map/.test(code),
    'the dropdown reads the picker directly again, beside the offer');
});

console.log(
  failed === 0
    ? `\nALL OK  narration voice choice: ${passed} passed, 0 failed`
    : `\nFAILED  narration voice choice: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
