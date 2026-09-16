#!/usr/bin/env node
/**
 * THERE IS NO SWITCH THAT RENDERS ON THIS MACHINE, AND NO ARM BEHIND ONE.
 *
 *   node tools/test-no-legacy-venue-doors.js
 *
 * Owen, 2026-09-15: *"Get rid of legacy logic. We've completely rebuilt the
 * system, we don't need legacy code hanging around."*
 *
 * `routing.legacyLocalRender` was the ONE switch that sent a render to a local
 * narrator spawn and the four text acts to a local text server, and every GPU
 * door in `electron/crucible/` carried a matching `legacyLocal` arm beside its
 * Crucible one. All of it is deleted (docs/LEGACY-REMOVAL.md). What is left is
 * "a Crucible server, or a named refusal" — and this file is what stops the
 * second arm growing back.
 *
 * ── WHY A GREP IS THE RIGHT TEST HERE ──────────────────────────────────────
 *
 * The shape of `test-no-e2a-doors.js`, `test-no-cloud-doors.js` and
 * `test-no-enhance-doors.js`, for their reason: a deletion this size comes back
 * ONE HELPER AT A TIME. Somebody adds a `legacyLocal` option "just for the
 * offline case", somebody else reads a boolean off the routing record, and a
 * year later the app has two ways to render and no one place that says which
 * one ran. Every door is pinned BY NAME, so its return is a red test naming the
 * thing rather than a review nobody ran.
 *
 * ── AND HALF OF THIS FILE IS NOT ABOUT ABSENCE ─────────────────────────────
 *
 * Two things that LOOK like this layer must survive it, and a grep-and-delete
 * pass aimed at the word "legacy" would take both:
 *
 *  1. **`epub-align`.** `generate-sentences` with `method: 'epub-align'` still
 *     spawns locally and still charges the one in-app GPU bench row. It is
 *     UNMIGRATED, not legacy: Crucible has no `align-longform` job type
 *     (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §B7, UNRULED). Delete its row and the
 *     step charges a set with no slots, `slotsOf` answers 0, and the scheduler
 *     never launches it with nothing to explain why.
 *  2. **The retired venue's NAME.** A queue file on disk can still say
 *     `waitForResolved: "legacy-local-narrator"`. That row must HOLD, by name —
 *     re-deciding it would move a half-rendered book onto a different card,
 *     which is what PHASE7-LANES §4.3 forbids. So the string survives as
 *     `RETIRED_LOCAL_NARRATOR_VENUE`, recognised and never honoured.
 *
 * A test that only forbids is a test that invites the wrong fix.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { installElectronStub } = require('./fake-crucible.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
// The compiled modules below reach `electron.app.getPath('userData')` at load.
installElectronStub('bf-no-legacy-venue-');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/**
 * Every TS source under `electron/`, `shared/` and `src/`, with comments
 * stripped.
 *
 * Comments go for the reason the other doors-tests give: the history is written
 * down on purpose — several files explain what the deleted thing DID — and a
 * test that fails on its own explanation teaches people to delete explanations.
 * NB no `$` on the line-comment pattern: this repo is `core.autocrlf=true`, a
 * split on '\n' leaves '\r', and `.` will not cross a carriage return.
 */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'foundry-app') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const code = raw
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          // Angular templates carry their arguments in HTML comments, which are
          // prose exactly as a /* */ block is. `settings.component.ts` explains
          // in one what the deleted switch used to gate.
          .replace(/<!--[\s\S]*?-->/g, ' ')
          .split('\n').map((l) => l.replace(/\/\/.*/, '')).join('\n');
        out.push({ file: path.relative(REPO, p).replace(/\\/g, '/'), code });
      }
    }
  };
  walk(path.join(REPO, 'electron'));
  walk(path.join(REPO, 'shared'));
  walk(path.join(REPO, 'src'));
  return out;
}

const FILES = sources();

/** Which files still contain `needle`, as repo-relative paths. */
function hits(needle) {
  return FILES.filter((f) => f.code.includes(needle)).map((f) => f.file);
}

console.log('BookForge has no legacy local-render venue');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The switch
// ─────────────────────────────────────────────────────────────────────────────

check('`legacyLocalRender` is not a field, a parameter or a setting anywhere', () => {
  /*
   * The ONE name the whole layer hung off. It is allowed to appear in PROSE —
   * several files explain what it used to mean — which is why comments are
   * stripped above.
   *
   * And ONE FILE may name it in code, only to throw it away: `routing.ts` reads
   * the key off an old record so it can be STRIPPED and said once. That is the
   * migration, and it is the reason a machine that used the switch still starts.
   */
  const found = hits('legacyLocalRender').filter((f) => f !== 'electron/crucible/routing.ts');
  assert.deepStrictEqual(found, [],
    'the legacy local-render switch is back in CODE (not just prose) in: '
    + `${found.join(', ')}. It ran renders and text passes on this machine instead of on a `
    + 'Crucible server; the spawn layer behind it is gone, so a boolean here would turn on '
    + 'nothing and lie about it.');
  const routing = FILES.find((f) => f.file === 'electron/crucible/routing.ts');
  assert.ok(/noteRetiredLegacySwitch/.test(routing.code),
    'routing.ts names the key somewhere other than the function that retires it');
  assert.ok(!/legacyLocalRender\s*[:?]/.test(routing.code),
    'routing.ts declares legacyLocalRender as a FIELD again — it may only read the key off an '
    + 'old record in order to drop it.');
});

check('the setter, the IPC channel and the preload bridge are all gone', () => {
  for (const [needle, what] of [
    ['setLegacyLocalRender', 'the routing setter and its renderer/preload bridges'],
    ['crucible:set-legacy-local-render', 'the IPC channel main handled it on'],
    ['invalid_legacy_local_render', 'the validation code for a value that is no longer read'],
  ]) {
    const found = hits(needle);
    assert.deepStrictEqual(found, [], `${needle} is back — ${what} — in ${found.join(', ')}`);
  }
});

check('the routing record on disk has exactly three keys, and the view has three fields', () => {
  const { Routing } = require(path.join(DIST, 'electron', 'crucible', 'routing.js'));
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bf-no-legacy-'));
  const file = path.join(dir, 'crucible-routing.json');
  const store = new Routing(file);
  const record = store.read();
  assert.deepStrictEqual(Object.keys(record).sort(), ['disabled', 'newJobsWaitFor', 'order'],
    'the default record grew a field');
  store.setNewJobsWaitFor('any', ['local']);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8'))).sort(),
    ['disabled', 'newJobsWaitFor', 'order'], 'a written record grew a field');
  assert.deepStrictEqual(Object.keys(store.view(['local'])).sort(),
    ['newJobsWaitFor', 'ranked', 'unknown'],
    'the view grew a field — and a field on the view is a control on the settings page');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('a record that still carries the switch is READ, is not corrupt, and is not rewritten', () => {
  /*
   * THE ONE BEHAVIOUR AN OPERATOR ACTUALLY MEETS. Every machine that used the
   * switch has `"legacyLocalRender": true` on disk right now. Refusing the
   * record would brick startup over a setting that no longer has a meaning;
   * honouring it would render on a card nobody chose; rewriting it would erase
   * the evidence of what they had asked for. So: read, stripped, left alone.
   */
  const { Routing } = require(path.join(DIST, 'electron', 'crucible', 'routing.js'));
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bf-no-legacy-old-'));
  const file = path.join(dir, 'crucible-routing.json');
  const onDisk = {
    order: ['local', 'mac'], disabled: ['mac'], newJobsWaitFor: 'any', legacyLocalRender: true,
  };
  fs.writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf-8');
  const before = fs.readFileSync(file, 'utf-8');

  const store = new Routing(file);
  const record = store.read();
  assert.deepStrictEqual(Object.keys(record).sort(), ['disabled', 'newJobsWaitFor', 'order'],
    'the retired key reached the record');
  assert.deepStrictEqual(record.order, ['local', 'mac'], 'the rest of the record survived');
  assert.strictEqual(record.newJobsWaitFor, 'any');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before,
    'reading rewrote the operator\'s file');
  assert.strictEqual(store.view(['local', 'mac']).legacyLocalRender, undefined,
    'the view still answers about a switch that does not exist');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The venue arms
// ─────────────────────────────────────────────────────────────────────────────

check('no venue union has a second arm, in any of its five spellings', () => {
  for (const [needle, what] of [
    ["where: 'legacy-local-narrator'", 'the render / step / pages / VLM venue'],
    ["where: 'legacy-local-engines'", 'the text-act venue'],
    ["kind: 'legacy-local'", "the queue's wait-for verdict"],
  ]) {
    const found = hits(needle);
    assert.deepStrictEqual(found, [],
      `${what} has a local arm again (${needle}) in ${found.join(', ')}. The union having ONE `
      + 'member is what makes "there is no local venue" checkable rather than remembered.');
  }
});

check('every venue decision answers `crucible` and nothing else', () => {
  const gen = require(path.join(DIST, 'electron', 'crucible', 'generation-venue.js'));
  const text = require(path.join(DIST, 'electron', 'crucible', 'text-venue.js'));
  const named = { view: () => { throw new Error('the record must not be read'); },
    enabled: () => { throw new Error('the record must not be read'); },
    ping: async () => { throw new Error('nothing should be pinged'); } };
  return Promise.all([
    gen.decideWhereGenerationRuns({ crucible: { server: 'mac' } }, named),
    text.decideWhereTextActRuns('mac', named),
  ]).then(([a, b]) => {
    assert.strictEqual(a.where, 'crucible');
    assert.strictEqual(b.where, 'crucible');
  });
});

check('no Crucible door takes a local callback', () => {
  /*
   * `legacyLocal` was the OPTION each door carried beside its Crucible arm, and
   * an option is where a fallback hides: a door that accepts one will be handed
   * one. Named across the whole tree rather than per file, because the next one
   * will be written in a module these four do not list.
   */
  const found = hits('legacyLocal:');
  assert.deepStrictEqual(found, [],
    `a legacyLocal arm is back in ${found.join(', ')}. Every GPU door has ONE arm: it runs on `
    + 'the chosen Crucible server, or the venue decision refuses by name.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. What must SURVIVE the deletion
// ─────────────────────────────────────────────────────────────────────────────

check('the retired venue is still NAMEABLE, so an old queue row can be told what happened', () => {
  const waitFor = require(path.join(DIST, 'shared', 'queue', 'wait-for.js'));
  assert.strictEqual(waitFor.RETIRED_LOCAL_NARRATOR_VENUE, 'legacy-local-narrator',
    'the string a queue file on disk still carries');
  assert.match(waitFor.waitForLabel('legacy-local-narrator'), /retired/i,
    'a picker showing that row needs something true to print');
  const verdict = waitFor.decideWaitFor({
    waitFor: 'mac',
    resolved: waitFor.RETIRED_LOCAL_NARRATOR_VENUE,
    ranked: [{ name: 'mac', enabled: true }],
    // The queue's GPU dial, on `any`: an ASSIGNED row never consults it anyway
    // (a running job ignores the dial), and this check is about the retirement.
    dial: waitFor.GPU_DIAL_ANY,
    state: () => ({ kind: 'ready' }),
    gpuSlotTaken: () => null,
  });
  assert.strictEqual(verdict.kind, 'hold',
    'a row assigned to the deleted narrator was RE-DECIDED. §4.3: a job finishes on the '
    + 'machine it started on, so it holds and the operator queues it again — it is never '
    + 'quietly moved to another card.');
  assert.match(verdict.sentence, /no longer exists/);
});

check('the in-app GPU bench row survives, named for its ONE remaining tenant', () => {
  /*
   * `epub-align` is UNMIGRATED, not legacy (ROLLOUT_PLAN §B7, UNRULED). Deleting
   * the row with the narrator would leave that step charging a set with no
   * slots — `slotsOf` answers 0 — and the scheduler would never launch it.
   */
  const slots = require(path.join(DIST, 'shared', 'queue', 'slot-sets.js'));
  assert.strictEqual(slots.LONGFORM_ALIGN_SET, 'local-longform-align');
  assert.strictEqual(typeof slots.longformAlignCharged, 'function');
  const drawn = slots.slotSets({
    rankedServers: [{ name: 'mac', enabled: true }], upstreams: { mac: 'none' }, roles: { mac: 'engine' },
    occupied: [], alignerCharged: true, serversOnThisMachine: [],
  });
  const row = drawn.find((s) => s.id === slots.LONGFORM_ALIGN_SET);
  assert.ok(row !== undefined, 'a charged epub-align draws no row, so it can never be launched');
  assert.strictEqual(row.gpu, 1, 'it is one card');
  assert.ok(!/legacy|narrator/i.test(row.label),
    `the row still calls itself "${row.label}". Its one tenant is an ALIGNER; a bench row that `
    + 'names a tenant that no longer exists tells an operator the wrong thing about their wait.');
});

check('the local long-form aligner itself is still here — it is unmigrated, not legacy', () => {
  for (const rel of ['electron/whisperx-align-bridge.ts', 'electron/scripts/align_audiobook.py']) {
    assert.ok(fs.existsSync(path.join(REPO, rel.split('/').join(path.sep))),
      `${rel} is gone. Crucible has no align-longform job type (ROLLOUT_PLAN §B7 is a RULING, `
      + 'not a build), so deleting this deletes the feature with no replacement.');
  }
  assert.ok(hits("'epub-align'").length > 0,
    'nothing names the epub-align method any more — the whole-audiobook forced alignment went '
    + 'out with the legacy layer, and it was not part of it.');
});

check('Orpheus is RETIRED from the Listen picker, not dropped — an old record still reads', () => {
  const se = require(path.join(DIST, 'electron', 'streaming-engine.js'));
  assert.match(se.streamEngineLabel('orpheus'), /retired/i,
    'a tts-engine.json naming orpheus has nothing true to display. Narration retired it the '
    + 'same way (shared/tts/engine-caps.ts) — a retired id stays NAMEABLE.');
  assert.deepStrictEqual(se.getAvailableEngines().map((e) => e.id), ['higgs'],
    'the picker offers an engine nothing can run, or has lost the one it can');
});

console.log(`\nno legacy venue doors: ${failures === 0 ? 'all clear' : `${failures} failing`}`);
process.exit(failures === 0 ? 0 : 1);
