#!/usr/bin/env node
/**
 * test-crucible-retire-reserved-name.js — the one-time move of `local` out of
 * this machine's records, and the four ways it refuses instead.
 *
 * ── What is being pinned ───────────────────────────────────────────────────
 *
 * Owen's ruling of 2026-09-15 deleted the reserved Crucible server name
 * `local`. Four records under `<userData>` could still name it, all written by
 * the app itself:
 *
 *   crucible-servers.json    the registry — where the entry must GO
 *   crucible-routing.json    `order` / `disabled`, the operator's rank
 *   crucible-upstreams.json  one learned fact per server name
 *   queue-engine.json        `waitFor`, `waitForResolved`, a step's `venue`
 *
 * A row left naming it would refuse `unknown_server` for ever, so the move is
 * LOSSLESS OR NOT MADE AT ALL: every reference is rewritten in one pass, or
 * nothing is written and the refusal names which record still holds the word.
 * Sections 2 and 3 are that half — they assert the FILES ARE BYTE-UNCHANGED
 * after each refusal, because "refused" and "half-applied" look the same from
 * a log line.
 *
 * Drives the COMPILED `dist/electron/crucible/retire-reserved-name.js` over a
 * temp directory with a scripted discovery, so nothing here reads this
 * machine's real records or spawns a WSL guest.
 *
 * Run:  node tools/test-crucible-retire-reserved-name.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist', 'electron', 'crucible');
const retire = require(path.join(DIST, 'retire-reserved-name.js'));
const discovery = require(path.join(DIST, 'discovery.js'));

let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

function refuses(fn, code) {
  let caught = null;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a refusal, got none');
  assert.strictEqual(caught.name, 'RetireReservedNameError', `${caught.name}: ${caught.message}`);
  assert.strictEqual(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-retire-'));

/** The Crucible discovery finds on this machine, in the shape door 1 answers. */
const HERE = {
  name: 'crucible@owens-pc-wsl',
  url: 'http://127.0.0.1:7100',
  token: 'here-secret-JXn0',
  configPath: 'C:\\Users\\t\\AppData\\Local\\Crucible\\pairing',
  via: 'pairing',
};

/**
 * OWEN'S OWN RECORDS, AS THEY WERE ON 2026-09-15 — read off his `<userData>`
 * before the change and reproduced here verbatim in shape.
 *
 * `crucible-routing.json` carried `legacyLocalRender`, which `routing.ts`
 * strips on read; it is here so the migration is exercised against a record
 * with a key it knows nothing about, which it must carry through untouched.
 */
function owensRecords(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify({
    servers: [{
      name: 'mac',
      url: 'http://owens-mac-studio.hs.owenmorgan.com:7100',
      token: 'mac-secret-KCK0',
      added: '2026-09-13T01:08:17.845Z',
    }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'crucible-routing.json'), JSON.stringify({
    order: ['local', 'mac'], disabled: [], newJobsWaitFor: 'top-ranked', legacyLocalRender: false,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'crucible-upstreams.json'), JSON.stringify({
    upstreams: { local: false, mac: false },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'queue-engine.json'), JSON.stringify({
    version: 3,
    running: true,
    jobs: [
      {
        id: 'job_mu332m6u_22150b01',
        waitFor: 'local',
        waitForResolved: 'local',
        steps: [{ id: 'step_a', type: 'tts-conversion', status: 'done', venue: 'local' }],
      },
      {
        id: 'job_other',
        waitFor: 'mac',
        waitForResolved: 'mac',
        steps: [{ id: 'step_b', type: 'tts-conversion', status: 'queued', venue: 'mac' }],
      },
    ],
    savedAt: '2026-09-15T16:03:00.000Z',
  }, null, 2));
  return dir;
}

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).map(
  (name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')],
));

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE MOVE — every reference, in one pass
// ─────────────────────────────────────────────────────────────────────────────

check("Owen's real records: `local` becomes the engine's own name, everywhere at once", () => {
  const dir = owensRecords(path.join(root, 'owen'));
  const report = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });

  assert.deepStrictEqual(report.found.sort(),
    ['crucible-routing.json', 'crucible-upstreams.json', 'queue-engine.json']);
  assert.strictEqual(report.becameName, 'crucible@owens-pc-wsl');
  assert.strictEqual(report.registered, true);

  // The registry gained ONE row, with the token discovery holds and nothing else.
  const registry = readJson(dir, 'crucible-servers.json');
  assert.deepStrictEqual(registry.servers.map((r) => r.name), ['mac', 'crucible@owens-pc-wsl']);
  const added = registry.servers[1];
  assert.strictEqual(added.url, 'http://127.0.0.1:7100');
  assert.strictEqual(added.token, 'here-secret-JXn0');
  assert.ok(typeof added.added === 'string' && added.added.endsWith('Z'), added.added);
  // The row that was already there is untouched, token included.
  assert.strictEqual(registry.servers[0].token, 'mac-secret-KCK0');

  // The rank record keeps its ORDER and its unknown key, with the name swapped.
  const routing = readJson(dir, 'crucible-routing.json');
  assert.deepStrictEqual(routing.order, ['crucible@owens-pc-wsl', 'mac']);
  assert.deepStrictEqual(routing.disabled, []);
  assert.strictEqual(routing.newJobsWaitFor, 'top-ranked');
  assert.strictEqual(routing.legacyLocalRender, false, 'a key this code knows nothing about is carried, not dropped');

  // The learned fact moves with the name; the other engine's is untouched.
  assert.deepStrictEqual(readJson(dir, 'crucible-upstreams.json'),
    { upstreams: { mac: false, 'crucible@owens-pc-wsl': false } });

  // The queue: the job's two fields and its step's venue, and nothing else.
  const queue = readJson(dir, 'queue-engine.json');
  assert.strictEqual(queue.jobs[0].waitFor, 'crucible@owens-pc-wsl');
  assert.strictEqual(queue.jobs[0].waitForResolved, 'crucible@owens-pc-wsl');
  assert.strictEqual(queue.jobs[0].steps[0].venue, 'crucible@owens-pc-wsl');
  assert.strictEqual(queue.jobs[0].steps[0].status, 'done', 'a finished step keeps everything else');
  assert.deepStrictEqual(queue.jobs[1], {
    id: 'job_other',
    waitFor: 'mac',
    waitForResolved: 'mac',
    steps: [{ id: 'step_b', type: 'tts-conversion', status: 'queued', venue: 'mac' }],
  });
  assert.strictEqual(queue.version, 3);
  assert.strictEqual(queue.running, true);

  // NOTHING ANYWHERE STILL SAYS IT.
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.strictEqual(/"local"/.test(text), false, `${name} still names the retired server`);
  }
});

check('running it again does nothing at all — it is idempotent, not repeatable', () => {
  const dir = owensRecords(path.join(root, 'twice'));
  retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  const after = snapshot(dir);
  const second = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  assert.deepStrictEqual(second.found, []);
  assert.strictEqual(second.becameName, null);
  assert.deepStrictEqual(snapshot(dir), after, 'the second run wrote nothing');
});

check('a machine with nothing to migrate is silent and writes nothing', () => {
  const dir = path.join(root, 'clean');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crucible-routing.json'), JSON.stringify({
    order: ['mac'], disabled: [], newJobsWaitFor: 'any',
  }));
  const before = snapshot(dir);
  const report = retire.retireReservedLocalName({
    userData: dir,
    discover: () => { throw new Error('discovery must not be asked when nothing names it'); },
  });
  assert.deepStrictEqual(report.found, []);
  assert.deepStrictEqual(snapshot(dir), before);
});

check('a crash between the registry write and the rest is FINISHED by the next run', () => {
  // The order is registry first, then the records that point into it — so the
  // state a crash leaves is "registered, but the records still say local", and
  // that is exactly what this run is handed.
  const dir = owensRecords(path.join(root, 'crash'));
  const registry = readJson(dir, 'crucible-servers.json');
  registry.servers.push({
    name: 'crucible@owens-pc-wsl', url: 'http://127.0.0.1:7100', token: 'here-secret-JXn0',
    added: '2026-09-15T20:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify(registry, null, 2));

  const report = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  assert.strictEqual(report.becameName, 'crucible@owens-pc-wsl');
  assert.strictEqual(report.registered, false, 'it was already registered; no second row');
  assert.deepStrictEqual(readJson(dir, 'crucible-servers.json').servers.map((r) => r.name),
    ['mac', 'crucible@owens-pc-wsl']);
  assert.deepStrictEqual(readJson(dir, 'crucible-routing.json').order,
    ['crucible@owens-pc-wsl', 'mac']);
});

check('an entry that ALREADY has that address wins the name, whatever it is called', () => {
  const dir = owensRecords(path.join(root, 'named'));
  const registry = readJson(dir, 'crucible-servers.json');
  registry.servers.push({
    name: '3090 Ti', url: 'http://127.0.0.1:7100/', token: 'here-secret-JXn0',
    added: '2026-09-15T20:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify(registry, null, 2));

  const report = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  assert.strictEqual(report.becameName, '3090 Ti', 'the operator got there first');
  assert.strictEqual(report.registered, false, 'one machine, one row');
  assert.deepStrictEqual(readJson(dir, 'crucible-routing.json').order, ['3090 Ti', 'mac']);
  assert.strictEqual(readJson(dir, 'queue-engine.json').jobs[0].waitFor, '3090 Ti');
});

check('a server GENUINELY called `local` is left entirely alone', () => {
  // The name is free text now, so somebody may have typed it. Reserving it in
  // the other direction would be the same defect upside down.
  const dir = owensRecords(path.join(root, 'genuine'));
  const registry = readJson(dir, 'crucible-servers.json');
  registry.servers.push({
    name: 'local', url: 'http://192.168.68.9:7100', token: 'other-secret-QQQ1',
    added: '2026-09-14T00:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify(registry, null, 2));
  const before = snapshot(dir);

  const report = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  assert.deepStrictEqual(report.found, []);
  assert.deepStrictEqual(snapshot(dir), before, 'their rows point at their server, and stay pointing at it');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REFUSALS — by name, having written nothing
// ─────────────────────────────────────────────────────────────────────────────

check('no Crucible here any more: REFUSED BY NAME, and every file is byte-identical', () => {
  const dir = owensRecords(path.join(root, 'gone'));
  const before = snapshot(dir);
  const err = refuses(() => retire.retireReservedLocalName({
    userData: dir,
    discover: () => {
      throw new discovery.CrucibleDiscoveryError('no_local_config', 'no Crucible on this computer: /x/config.toml is not here');
    },
  }), 'reserved_name_unresolved');
  assert.ok(err.message.includes('crucible-routing.json'), err.message);
  assert.ok(err.message.includes('queue-engine.json'), err.message);
  assert.ok(err.message.includes('no_local_config'), 'the reason travels verbatim');
  assert.ok(err.message.includes('Nothing has been changed'), err.message);
  assert.deepStrictEqual(snapshot(dir), before);
});

check('the engine calls itself something unusable: REFUSED BY NAME, nothing written', () => {
  const dir = owensRecords(path.join(root, 'unusable'));
  const before = snapshot(dir);
  const err = refuses(() => retire.retireReservedLocalName({
    userData: dir,
    discover: () => ({ ...HERE, name: 'crucible:7100' }),
  }), 'reserved_name_unusable');
  assert.ok(err.message.includes('crucible:7100'), err.message);
  assert.ok(err.message.includes('invalid_name'), 'the registry\'s own code travels');
  assert.deepStrictEqual(snapshot(dir), before);
});

check('that name is already a DIFFERENT machine: REFUSED BY NAME, nothing written', () => {
  const dir = owensRecords(path.join(root, 'taken'));
  const registry = readJson(dir, 'crucible-servers.json');
  registry.servers.push({
    name: 'crucible@owens-pc-wsl', url: 'http://192.168.68.9:7100', token: 'other-secret-QQQ1',
    added: '2026-09-14T00:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'crucible-servers.json'), JSON.stringify(registry, null, 2));
  const before = snapshot(dir);

  const err = refuses(() => retire.retireReservedLocalName({ userData: dir, discover: () => HERE }),
    'reserved_name_taken');
  assert.ok(err.message.includes('http://192.168.68.9:7100'), err.message);
  assert.deepStrictEqual(snapshot(dir), before);
});

check('a record that will not parse is REFUSED, never stepped over', () => {
  const dir = owensRecords(path.join(root, 'corrupt'));
  fs.writeFileSync(path.join(dir, 'crucible-upstreams.json'), '{ not json');
  const before = snapshot(dir);
  const err = refuses(() => retire.retireReservedLocalName({ userData: dir, discover: () => HERE }),
    'reserved_name_record_unreadable');
  assert.ok(err.message.includes('crucible-upstreams.json'), err.message);
  assert.deepStrictEqual(snapshot(dir), before,
    'a migration that could not read one record must not half-apply the others');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE LOG LINE — names only, never a token
// ─────────────────────────────────────────────────────────────────────────────

check('describeRetirement names the records and the new name, and no credential', () => {
  const dir = owensRecords(path.join(root, 'words'));
  const report = retire.retireReservedLocalName({ userData: dir, discover: () => HERE });
  const line = retire.describeRetirement(report);
  assert.ok(line.includes('crucible@owens-pc-wsl'), line);
  assert.ok(line.includes('queue-engine.json'), line);
  assert.strictEqual(line.includes('here-secret'), false, 'a token must never reach a log');
  assert.strictEqual(line.includes('****'), false, 'and there is no reason to put even a mask there');
  const quiet = retire.describeRetirement({ found: [], becameName: null, registered: false, rewrote: [] });
  assert.ok(quiet.includes('nothing to do'), quiet);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${ran} checks, ${process.exitCode ? 'FAILING' : 'all passing'}`);
