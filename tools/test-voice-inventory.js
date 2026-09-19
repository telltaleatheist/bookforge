#!/usr/bin/env node
/**
 * test-voice-inventory.js — silence is not an answer.
 *
 * `electron/crucible/voice-inventory.ts` replaces a question BookForge had been
 * asking the wrong machine. `higgsVoiceUnavailableReason` is titled *"why this
 * voice cannot render on THIS MACHINE"*, and on Owen's PC this machine is an
 * orchestrator that renders nothing — so the picker greyed out voices the engine
 * could speak and offered voices it could not.
 *
 * The half that MUST NOT REGRESS SILENTLY is the routing one. Owen's rule
 * (2026-09-15) is that a voice only one server serves LOCKS the venue to that
 * server. So if an unreachable Mac counted as "the Mac does not have this
 * voice", a voice BOTH machines serve would present as 3090-only the moment the
 * Mac slept — and the lock would pin a book to the PC with nobody choosing it.
 * A wrong answer here reroutes work while every screen looks healthy, which is
 * the exact failure shape (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`) this project
 * lost a day to.
 *
 * Every server here is SCRIPTED — no tailnet, no tokens, no Crucible. That is
 * possible because `readVoiceInventory` takes its server set and its client
 * factory as parameters, the same discipline `Routing` states about itself.
 *
 * Build first: `npx tsc -p tsconfig.electron.json`.
 * Run:  node tools/test-voice-inventory.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const inv = require(path.join(REPO, 'dist', 'electron', 'crucible', 'voice-inventory.js'));
const sdk = require('@crucible/client');

let ran = 0;
const pending = [];
function check(name, fn) {
  ran += 1;
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`ok   ${name}`),
    (err) => {
      console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
      process.exitCode = 1;
    },
  ));
}

/** A voice row as a server would send it. */
function voice(id, { display = id, loadable = true, reason = null, needsReference = false } = {}) {
  return { id, display, loadable, reason, needsReference };
}

/**
 * A transport failure in the SDK's own type — the one refusal kind the
 * inventory answers in its OWN words rather than the render's. A plain Error is
 * a DIFFERENT case and has its own check below.
 */
function unreachable(message) {
  return new sdk.CrucibleUnreachable('http://scripted:7100', message);
}

/** A scripted server set: `{ name: rows | Error | 'disabled' }`, in order. */
function scripted(spec) {
  const ranked = Object.keys(spec).map((name) => ({ name, enabled: spec[name] !== 'disabled' }));
  const clientFor = (name) => ({
    voices: async () => {
      const rows = spec[name];
      if (rows instanceof Error) throw rows;
      return rows;
    },
  });
  return inv.readVoiceInventory(ranked, clientFor);
}

const BOTH = { '3090 Ti': [voice('deathstalker'), voice('mistborn')], 'M1 Ultra': [voice('deathstalker'), voice('mistborn')] };

// ── The rule that protects routing ──────────────────────────────────────────

check('an unreachable server is NOT read as a server without the voice', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('deathstalker')],
    'M1 Ultra': unreachable('connect ECONNREFUSED 192.0.2.79:7100'),
  });
  const placed = inv.placeVoices(inventory);
  const ds = placed.find((p) => p.id === 'deathstalker');
  assert.deepStrictEqual(ds.servedBy, ['3090 Ti'],
    'only answering servers are in the set — that part is right');
  assert.strictEqual(inventory.complete, false,
    'and THIS is what stops the caller reading that one-server set as a lock');
  const mac = inventory.servers.find((s) => s.server === 'M1 Ultra');
  assert.strictEqual(mac.state, 'unreachable');
  // The reason does NOT open with the server's name: its one reader draws
  // `{{ m.server }} — {{ m.why }}`, so a name in the reason prints twice
  // (voice-inventory.ts, "IT DOES NOT SAY THE NAME", b398c253). The name is
  // the row's own `server` field — this check used to assert the opposite.
  assert.ok(!/M1 Ultra/.test(mac.reason),
    'the reason must not repeat the name the modal already draws beside it: ' + mac.reason);
});

check('a down server is described by the INVENTORY, never in the render\'s words', async () => {
  /*
   * The defect, 2026-09-18. This row is drawn by the narration modal's
   * `voiceServersMissing` list — a picker, open before any book has been sent
   * anywhere — and it carried `describeCrucibleRefusal`'s render sentence:
   * "A render is not retried here - start the server and queue the book again,
   * or pick another one." Nothing was rendering, nothing had been retried, and
   * Owen read it as a render that had failed.
   *
   * What the sentence must say instead is the consequence AT THIS MOMENT: no
   * voices from that machine, and no book goes there until it answers.
   */
  const inventory = await scripted({
    '3090 Ti': [voice('deathstalker')],
    'M1 Ultra': unreachable('connect ECONNREFUSED 192.0.2.79:7100'),
  });
  const mac = inventory.servers.find((s) => s.server === 'M1 Ultra');
  assert.strictEqual(mac.state, 'unreachable');
  assert.ok(!/A render is not retried/.test(mac.reason),
    'the render\'s sentence must not be read out by a picker: ' + mac.reason);
  assert.ok(!/queue the book again/.test(mac.reason),
    'nor its instruction, which is about a book that has not been queued yet: ' + mac.reason);
  assert.strictEqual(mac.server, 'M1 Ultra', 'the row names the machine; the reason does not repeat it');
  assert.ok(!/M1 Ultra/.test(mac.reason), 'the reason must not repeat the name (see the check above)');
  assert.match(mac.reason, /ECONNREFUSED 192\.0\.2\.79:7100/,
    "and still carries the transport's own detail, which is the only actionable half");
  assert.match(mac.reason, /not answering/, 'and says what is actually true of it');
});

check('an AUTH refusal keeps the shared sentence — a token is broken for every door', async () => {
  // Only the unreachable kind gets the inventory's own words. A bad token, a
  // version mismatch or an address that is not a crucible are misconfigurations
  // the operator must fix before ANY door works, so there is nothing
  // picker-specific to add and a second wording would be a second thing to keep
  // in step with the SDK.
  const bad = new sdk.CrucibleAuthError('http://scripted:7100', 401, 'bad token');
  const inventory = await scripted({ '3090 Ti': [voice('deathstalker')], 'M1 Ultra': bad });
  const mac = inventory.servers.find((s) => s.server === 'M1 Ultra');
  assert.strictEqual(mac.state, 'unreachable');
  assert.match(mac.reason, /refused the token/,
    'the SDK vocabulary, unchanged, naming the repair: ' + mac.reason);
});

check('a NON-Crucible exception is rethrown, not filed as the server being down', async () => {
  // `describeCrucibleRefusal` returns anything that is not one of the SDK's
  // types UNCHANGED, on the stated grounds that "an unexpected exception is not
  // a refusal and dressing it as one loses where it came from". Recording our
  // own bug as "M1 Ultra - unreachable" would put it in front of the operator
  // wearing the Mac's name, which is the wrong cause named confidently.
  const boom = new TypeError('voices is not a function');
  await assert.rejects(
    scripted({ '3090 Ti': [voice('deathstalker')], 'M1 Ultra': boom }),
    (err) => err === boom,
    'the original error, with its stack, and not a tidied sentence',
  );
});

check('a section only LOCKS when another server could have taken the work', async () => {
  const one = await scripted({ '3090 Ti': [voice('deathstalker')] });
  const [solo] = inv.sectionVoices(one, inv.placeVoices(one));
  assert.strictEqual(solo.locks, false,
    'a one-server setup constrains nothing — a lock warning there warns about no alternative');

  const two = await scripted({ '3090 Ti': [voice('deathstalker')], 'M1 Ultra': [voice('mistborn')] });
  const sections = inv.sectionVoices(two, inv.placeVoices(two));
  assert.ok(sections.every((s) => s.locks), 'with two machines, each single-server voice pins the venue');
});

check('"Every server" counts the ones that ANSWERED, never the registered ones', async () => {
  const partial = await scripted({
    '3090 Ti': [voice('deathstalker')],
    'M1 Ultra': [voice('deathstalker')],
    droplet: unreachable('timeout'),
  });
  const [shared] = inv.sectionVoices(partial, inv.placeVoices(partial));
  assert.deepStrictEqual(shared.servers, ['3090 Ti', 'M1 Ultra']);
  assert.strictEqual(shared.label, 'Every server',
    'true of the machines that spoke');
  assert.strictEqual(partial.complete, false,
    'and the caller is told the claim is about a partial set — the label alone would mislead');
});

// ── Three states, because they send a person three places ───────────────────

check('a disabled server is reported but never asked', async () => {
  let asked = 0;
  const ranked = [{ name: '3090 Ti', enabled: true }, { name: 'M1 Ultra', enabled: false }];
  const inventory = await inv.readVoiceInventory(ranked, (name) => ({
    voices: async () => { asked += 1; return name === '3090 Ti' ? [voice('deathstalker')] : []; },
  }));
  assert.strictEqual(asked, 1, 'the operator already said it is off; a round trip proves nothing');
  const mac = inventory.servers.find((s) => s.server === 'M1 Ultra');
  assert.strictEqual(mac.state, 'disabled');
  assert.strictEqual(inventory.complete, false, 'its voices are still unknown');
});

check('"has it but cannot load it" is kept apart from "has never heard of it"', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('deathstalker')],
    'M1 Ultra': [voice('deathstalker', { loadable: false, reason: 'weights not pulled' })],
  });
  const ds = inv.placeVoices(inventory).find((p) => p.id === 'deathstalker');
  assert.deepStrictEqual(ds.servedBy, ['3090 Ti']);
  assert.deepStrictEqual(ds.blocked, [{ server: 'M1 Ultra', reason: 'weights not pulled' }],
    'a download the operator can do in a minute must not read as a catalog difference');
});

check('not loadable and no reason is refused as the protocol error it is', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('deathstalker', { loadable: false, reason: null })],
  });
  assert.throws(() => inv.placeVoices(inventory), /not loadable and gives no reason/,
    'a silent blocked voice is a person told no with no next step');
});

// ── The grouping Owen described ─────────────────────────────────────────────

check('voices group by the SET of machines that can render them', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('deathstalker'), voice('mistborn'), voice('owen')],
    'M1 Ultra': [voice('deathstalker'), voice('mistborn')],
  });
  const sections = inv.sectionVoices(inventory, inv.placeVoices(inventory));
  assert.strictEqual(sections.length, 2);
  assert.strictEqual(sections[0].label, 'Every server', 'widest set first — it costs no freedom');
  assert.deepStrictEqual(sections[0].voices.map((v) => v.id), ['deathstalker', 'mistborn']);
  assert.strictEqual(sections[0].locks, false);
  assert.strictEqual(sections[1].label, '3090 Ti');
  assert.deepStrictEqual(sections[1].voices.map((v) => v.id), ['owen']);
  assert.strictEqual(sections[1].locks, true, 'choosing it pins the venue');
});

check('a voice no machine can speak is not offered at all', async () => {
  const inventory = await scripted({ '3090 Ti': [], 'M1 Ultra': [] });
  assert.deepStrictEqual(inv.placeVoices(inventory), [],
    'a local catalog entry no engine has is a staging job, not an option');
  assert.strictEqual(inventory.complete, true, 'both machines answered; they answered "none"');
});

check('every server answering makes the inventory complete', async () => {
  const inventory = await scripted(BOTH);
  assert.strictEqual(inventory.complete, true);
  assert.ok(inv.sectionVoices(inventory, inv.placeVoices(inventory)).every((s) => !s.locks),
    'nothing is pinned when both machines serve everything');
});

// ── Zero-shot: the one case where this machine's disk IS the authority ───────
//
// Owen, 2026-09-15: "zero shot works effectively identically to fine tuned
// models. it sends it through the base and appends the reference clip that's
// already present on the crucible server." The first half is exact. The second
// is the design Crucible supports and nobody has finished: `voices/zeroshot.toml`
// is `clips = "from-request"` because the four wavs "are not published
// anywhere", so `crucibleVoiceLoadFor` does fs.readFileSync on THIS box and
// uploads them. Hence one server-side id standing in for four, and a local check
// that is correct rather than a leftover.

const CARRIED = [
  { id: 'zeroshot-deathstalker', display: 'Deathstalker (Zero-shot)', clipPresent: true, reason: null },
];

check('a carried voice is served by every machine that will TAKE a clip', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('zeroshot', { needsReference: true })],
    'M1 Ultra': [voice('zeroshot', { needsReference: true })],
  });
  const [ds] = inv.placeCarriedVoices(inventory, CARRIED);
  assert.deepStrictEqual(ds.servedBy, ['3090 Ti', 'M1 Ultra'],
    'the clip travels with the job, so any server that wants one can render it');
  assert.deepStrictEqual(ds.blocked, []);
});

check('no clip on this disk blocks it EVERYWHERE, blaming no machine', async () => {
  const inventory = await scripted({
    '3090 Ti': [voice('zeroshot', { needsReference: true })],
    'M1 Ultra': [voice('zeroshot', { needsReference: true })],
  });
  const absent = [{ ...CARRIED[0], clipPresent: false, reason: 'no clip at <userData>/runtime/higgs-models/refs/ds.wav' }];
  const [ds] = inv.placeCarriedVoices(inventory, absent);
  assert.deepStrictEqual(ds.servedBy, [],
    'and an empty set can never be mistaken for a lock');
  assert.deepStrictEqual(ds.blocked.map((b) => b.server), ['3090 Ti', 'M1 Ultra'],
    "the missing thing is this app's, not any server's — so every server says the same");
});

check('a server that holds its OWN clips stops being a taker', async () => {
  // Owen's design, arrived: the manifest publishes a clip list, `needsReference`
  // goes false, and uploading bytes would be refused as `reference_not_allowed`.
  // Then these become real server-side voices and `placeVoices` picks them up.
  const inventory = await scripted({ '3090 Ti': [voice('zeroshot', { needsReference: false })] });
  const [ds] = inv.placeCarriedVoices(inventory, CARRIED);
  assert.deepStrictEqual(ds.servedBy, [], 'no upload is offered to a server that would refuse it');
});

check('a missing clip with no reason is refused rather than shown blank', async () => {
  const inventory = await scripted({ '3090 Ti': [voice('zeroshot', { needsReference: true })] });
  const bad = [{ ...CARRIED[0], clipPresent: false, reason: null }];
  assert.throws(() => inv.placeCarriedVoices(inventory, bad), /no reason was given/);
});

Promise.all(pending).then(() => {
  console.log(`\nvoice inventory: ${ran} check(s), exit ${process.exitCode || 0}`);
});
