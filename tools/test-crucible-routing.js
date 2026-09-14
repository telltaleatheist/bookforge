#!/usr/bin/env node
/**
 * test-crucible-routing.js — rank is the list's order, and nothing is pruned silently.
 *
 * Drives the COMPILED `dist/electron/crucible/routing.js` (build first:
 * `npx tsc -p tsconfig.electron.json`) over a temp record file and a SCRIPTED
 * server set, so nothing here reads `<userData>`, the real registry or a WSL
 * guest. Every refusal is exercised by its `code`, because a caller acts on the
 * code and a reader acts on the message.
 *
 * What it pins, all of it from crucible docs/PHASE7-LANES.md section 4.2.2:
 *   • the list's order IS the rank — no rank numbers anywhere
 *   • a newly added server lands at the BOTTOM
 *   • `local` participates by name
 *   • an order naming a server that no longer exists is REPORTED, never pruned
 *   • "New jobs wait for: top-ranked | any" is one setting with two values
 *   • rankedServers / topRankedServer / defaultWaitFor refuse when nothing is enabled
 *   • the LEGACY local-narrator switch: one owner, absent = off, never a fallback
 *   • WHERE a render's generation step runs (electron/crucible/generation-venue.ts),
 *     driven over a scripted host — no record on disk, no registry, no network
 *
 * Run:  node tools/test-crucible-routing.js
 */
'use strict';
require('../cli/electron-stub.js');

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist', 'electron', 'crucible');
const routing = require(path.join(DIST, 'routing.js'));
const venue = require(path.join(DIST, 'generation-venue.js'));

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
  assert.ok(caught instanceof routing.CrucibleRoutingError, `expected CrucibleRoutingError, got ${caught.name}: ${caught.message}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-routing-'));
let seq = 0;
/** A store over its own empty file, so each check starts from "no preference yet". */
function fresh(contents) {
  seq += 1;
  const file = path.join(tmp, `routing-${seq}.json`);
  if (contents !== undefined) fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return { store: new routing.Routing(file), file };
}

const KNOWN = ['local', 'mac', 'droplet'];
const names = (view) => view.ranked.map((row) => row.name);
const enabled = (view) => view.ranked.filter((row) => row.enabled).map((row) => row.name);

// ── The default record ───────────────────────────────────────────────────────

check('no file yet is the DEFAULT record, not a refusal: every server ranked in the order given, all enabled', () => {
  const { store, file } = fresh();
  const view = store.view(KNOWN);
  assert.deepStrictEqual(names(view), KNOWN);
  assert.deepStrictEqual(enabled(view), KNOWN);
  assert.strictEqual(view.newJobsWaitFor, 'top-ranked');
  assert.deepStrictEqual(view.unknown, []);
  assert.strictEqual(fs.existsSync(file), false, 'reading must not write a record nobody asked for');
});

check('with no servers at all the view is empty and says so by having nothing, not by inventing one', () => {
  const { store } = fresh();
  assert.deepStrictEqual(store.view([]), {
    ranked: [], newJobsWaitFor: 'top-ranked', unknown: [], legacyLocalRender: false,
  });
});

// ── Rank is the order ────────────────────────────────────────────────────────

check('setOrder writes the whole list and the view reads it back in that order', () => {
  const { store, file } = fresh();
  const view = store.setOrder(['mac', 'local', 'droplet'], KNOWN);
  assert.deepStrictEqual(names(view), ['mac', 'local', 'droplet']);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(onDisk.order, ['mac', 'local', 'droplet']);
  // The list IS the rank: the record holds names in an order and nothing else.
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ['disabled', 'legacyLocalRender', 'newJobsWaitFor', 'order']);
  assert.ok(onDisk.order.every((entry) => typeof entry === 'string'), 'an order entry is a name, not a {name, rank}');
});

check('a NEWLY ADDED server lands at the BOTTOM, never silently promoted over the one rows default to', () => {
  const { store } = fresh();
  store.setOrder(['mac', 'local'], ['local', 'mac']);
  // A droplet added at midnight is not thereby better than the 3090 Ti.
  const view = store.view(['local', 'mac', 'droplet']);
  assert.deepStrictEqual(names(view), ['mac', 'local', 'droplet']);
  assert.strictEqual(store.top(['local', 'mac', 'droplet']).name, 'mac');
});

check('local participates by NAME: it ranks, it disables, and it can be anywhere in the list', () => {
  const { store } = fresh();
  assert.strictEqual(store.top(KNOWN).name, 'local');
  store.setOrder(['droplet', 'mac', 'local'], KNOWN);
  assert.strictEqual(store.top(KNOWN).name, 'droplet');
  const view = store.setEnabled('local', false, KNOWN);
  assert.deepStrictEqual(enabled(view), ['droplet', 'mac']);
  assert.deepStrictEqual(names(view), ['droplet', 'mac', 'local'], 'disabled is not removed from the list');
});

check('a re-rank is the WHOLE list: an omitted server, an unknown name and a repeat are each refused by code', () => {
  const { store } = fresh();
  const missing = refuses(() => store.setOrder(['mac', 'local'], KNOWN), 'incomplete_order');
  assert.ok(missing.message.includes('droplet'), missing.message);
  const unknown = refuses(() => store.setOrder(['local', 'mac', 'droplet', 'titan'], KNOWN), 'unknown_server');
  assert.ok(unknown.message.includes('titan') && unknown.message.includes('known: local, mac, droplet'), unknown.message);
  refuses(() => store.setOrder(['local', 'local', 'mac', 'droplet'], KNOWN), 'duplicate_in_order');
  assert.deepStrictEqual(names(store.view(KNOWN)), KNOWN, 'a refused re-rank changed nothing');
});

// ── Enablement ───────────────────────────────────────────────────────────────

check('the enable switch is standing state about hardware: off, then on again, and it persists', () => {
  const { store, file } = fresh();
  assert.deepStrictEqual(enabled(store.setEnabled('mac', false, KNOWN)), ['local', 'droplet']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).disabled, ['mac']);
  assert.deepStrictEqual(enabled(store.setEnabled('mac', false, KNOWN)), ['local', 'droplet'], 'disabling twice is once');
  assert.deepStrictEqual(enabled(store.setEnabled('mac', true, KNOWN)), KNOWN);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).disabled, []);
});

check('enabling a name that is not a server is refused by name, never recorded', () => {
  const { store } = fresh();
  const err = refuses(() => store.setEnabled('titan', false, KNOWN), 'unknown_server');
  assert.ok(err.message.includes('titan'), err.message);
});

// ── "New jobs wait for" ──────────────────────────────────────────────────────

check('New jobs wait for: top-ranked | any — one setting, two values, and nothing else', () => {
  const { store, file } = fresh();
  assert.strictEqual(store.setNewJobsWaitFor('any', KNOWN).newJobsWaitFor, 'any');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).newJobsWaitFor, 'any');
  assert.strictEqual(store.waitForNewJob(KNOWN), 'any');
  assert.strictEqual(store.setNewJobsWaitFor('top-ranked', KNOWN).newJobsWaitFor, 'top-ranked');
  assert.strictEqual(store.waitForNewJob(KNOWN), 'local', 'top-ranked writes the NAME, which the row then shows');
  refuses(() => store.setNewJobsWaitFor('mac', KNOWN), 'invalid_wait_for');
  refuses(() => store.setNewJobsWaitFor('', KNOWN), 'invalid_wait_for');
});

check('the default follows the drag: re-rank, and a new row waits for the new top', () => {
  const { store } = fresh();
  assert.strictEqual(store.waitForNewJob(KNOWN), 'local');
  store.setOrder(['mac', 'droplet', 'local'], KNOWN);
  assert.strictEqual(store.waitForNewJob(KNOWN), 'mac');
  store.setEnabled('mac', false, KNOWN);
  assert.strictEqual(store.waitForNewJob(KNOWN), 'droplet', 'a disabled server is not a candidate for the default');
});

// ── Nothing enabled: a refusal, never an empty answer ────────────────────────

check('every server disabled: ranked/top/waitFor refuse by name and the message says which case it is', () => {
  const { store } = fresh();
  for (const name of KNOWN) store.setEnabled(name, false, KNOWN);
  const err = refuses(() => store.ranked(KNOWN), 'no_enabled_server');
  assert.ok(err.message.includes('every Crucible server is disabled') && err.message.includes('local, mac, droplet'), err.message);
  refuses(() => store.top(KNOWN), 'no_enabled_server');
  refuses(() => store.waitForNewJob(KNOWN), 'no_enabled_server');
});

check('no servers at all is a DIFFERENT sentence from all of them disabled', () => {
  const { store } = fresh();
  const err = refuses(() => store.ranked([]), 'no_enabled_server');
  assert.ok(err.message.includes('this machine has none'), err.message);
  refuses(() => store.waitForNewJob([]), 'no_enabled_server');
});

check('`any` still refuses when nothing is enabled — a row that can only hold says so when it is queued', () => {
  const { store } = fresh();
  store.setNewJobsWaitFor('any', KNOWN);
  for (const name of KNOWN) store.setEnabled(name, false, KNOWN);
  refuses(() => store.waitForNewJob(KNOWN), 'no_enabled_server');
});

// ── A name the registry no longer has: REPORTED, never pruned ────────────────

check('an order naming a removed server reports it BY NAME and keeps it, so its rank survives a re-add', () => {
  const { store, file } = fresh();
  store.setOrder(['droplet', 'local', 'mac'], KNOWN);
  store.setEnabled('droplet', false, KNOWN);
  // The droplet is destroyed; the registry loses it.
  const nowKnown = ['local', 'mac'];
  const view = store.view(nowKnown);
  assert.deepStrictEqual(names(view), ['local', 'mac'], 'a server that is gone is not drawn as a server');
  assert.deepStrictEqual(view.unknown, ['droplet']);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).order.includes('droplet'), 'the record is NOT pruned behind the operator');
});

check('a re-rank while a stale name is in the record keeps that name, at the end', () => {
  const { store, file } = fresh({ order: ['droplet', 'local', 'mac'], disabled: [], newJobsWaitFor: 'top-ranked' });
  const view = store.setOrder(['mac', 'local'], ['local', 'mac']);
  assert.deepStrictEqual(names(view), ['mac', 'local']);
  assert.deepStrictEqual(view.unknown, ['droplet']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).order, ['mac', 'local', 'droplet']);
});

check('forget is the door for a name nothing answers to — and it refuses a name that IS a server', () => {
  const { store, file } = fresh({ order: ['droplet', 'local'], disabled: ['droplet'], newJobsWaitFor: 'top-ranked' });
  const err = refuses(() => store.forget('local', ['local', 'mac']), 'server_is_known');
  assert.ok(err.message.includes('Disable it'), err.message);
  const view = store.forget('droplet', ['local', 'mac']);
  assert.deepStrictEqual(view.unknown, []);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(onDisk.order, ['local']);
  assert.deepStrictEqual(onDisk.disabled, []);
});

// ── The record is a record ───────────────────────────────────────────────────

check('a corrupt record is refused by code and left exactly as it was — never replaced', () => {
  for (const bad of ['{ not json', JSON.stringify({ order: 'local', disabled: [], newJobsWaitFor: 'any' }),
    JSON.stringify({ order: ['local', 7], disabled: [], newJobsWaitFor: 'any' }),
    JSON.stringify({ order: [], disabled: [], newJobsWaitFor: 'whatever' }),
    JSON.stringify({ order: [], disabled: [] })]) {
    const { store, file } = fresh(bad);
    refuses(() => store.view(KNOWN), 'corrupt_routing');
    refuses(() => store.setEnabled('mac', false, KNOWN), 'corrupt_routing');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), bad, 'the corrupt file is untouched');
  }
});

check('the record round-trips through a second store over the same file', () => {
  const { store, file } = fresh();
  store.setOrder(['mac', 'droplet', 'local'], KNOWN);
  store.setEnabled('droplet', false, KNOWN);
  store.setNewJobsWaitFor('any', KNOWN);
  const reopened = new routing.Routing(file);
  assert.deepStrictEqual(reopened.read(), {
    order: ['mac', 'droplet', 'local'], disabled: ['droplet'], newJobsWaitFor: 'any', legacyLocalRender: false,
  });
  assert.deepStrictEqual(enabled(reopened.view(KNOWN)), ['mac', 'local']);
});

check('the module-level doors exist for the queue that will use them', () => {
  for (const door of ['readRouting', 'setRoutingOrder', 'setServerEnabled', 'setNewJobsWaitFor',
    'setLegacyLocalRender', 'forgetRoutingName', 'rankedServers', 'topRankedServer', 'defaultWaitFor',
    'knownServers', 'routingPath']) {
    assert.strictEqual(typeof routing[door], 'function', `${door} is missing`);
  }
});

// ── The legacy local narrator: one switch, and absent means off ──────────────

check('the legacy local-render switch defaults OFF, persists, and is one boolean', () => {
  const { store, file } = fresh();
  assert.strictEqual(store.view(KNOWN).legacyLocalRender, false, 'no record = the server path');
  assert.strictEqual(store.setLegacyLocalRender(true, KNOWN).legacyLocalRender, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).legacyLocalRender, true);
  assert.strictEqual(store.setLegacyLocalRender(false, KNOWN).legacyLocalRender, false);
  refuses(() => store.setLegacyLocalRender('yes', KNOWN), 'invalid_legacy_local_render');
});

check('a record written before the switch existed reads as OFF; a non-boolean is corrupt', () => {
  // Absent is a MIGRATION, not a fallback: every record on disk today has no
  // such key, and `false` is the behaviour those records described.
  const before = fresh({ order: ['mac'], disabled: [], newJobsWaitFor: 'any' });
  assert.strictEqual(before.store.view(KNOWN).legacyLocalRender, false);
  const bad = fresh({ order: [], disabled: [], newJobsWaitFor: 'any', legacyLocalRender: 'true' });
  refuses(() => bad.store.view(KNOWN), 'corrupt_routing');
});

// ── WHERE a render's generation step runs ────────────────────────────────────
//
// electron/crucible/generation-venue.ts, driven over a scripted host: no record
// on disk, no registry, no network. Its four answers are PHASE7-LANES.md
// §4.2.1's, and its two refusals are why nothing renders on this machine by
// accident.

const RANKED = [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }];

/** A VenueHost with the defaults every check starts from, overridable per check. */
function venueHost(over) {
  const view = {
    ranked: RANKED,
    unknown: [],
    newJobsWaitFor: 'top-ranked',
    legacyLocalRender: false,
    ...(over && over.view ? over.view : {}),
  };
  return {
    view: () => view,
    enabled: () => {
      const on = view.ranked.filter((row) => row.enabled);
      if (on.length === 0) {
        // routing's OWN refusal, which is what the real host throws.
        throw new routing.CrucibleRoutingError('no_enabled_server', 'every Crucible server is disabled');
      }
      return on;
    },
    ping: (over && over.ping) || (async () => ({ outcome: 'ok', serverName: 'x', apiVersion: 1 })),
  };
}

async function acheck(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    console.log(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    process.exitCode = 1;
  }
}

async function rejects(fn, ErrorType, code) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught, 'expected a refusal, got none');
  assert.ok(caught instanceof ErrorType, `expected ${ErrorType.name}, got ${caught.name}: ${caught.message}`);
  assert.strictEqual(caught.code, code, `expected code ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

const decide = (settings, host) => venue.decideWhereGenerationRuns(settings, host);

(async () => {
  await acheck('the CALLER\'s server wins over everything, including the legacy switch', async () => {
    const host = venueHost({ view: { legacyLocalRender: true, newJobsWaitFor: 'any' } });
    assert.deepStrictEqual(await decide({ crucible: { server: ' mac ' } }, host),
      { where: 'crucible', server: 'mac', because: 'the caller named it' });
  });

  await acheck('settings.crucible present and empty is refused by name — never a local render', async () => {
    for (const bad of [{ server: '' }, { server: '   ' }]) {
      await rejects(() => decide({ crucible: bad }, venueHost()),
        venue.CrucibleVenueError, 'crucible_server_not_named');
    }
  });

  await acheck('no caller, switch off, top-ranked: the top of the ENABLED list, unpinged', async () => {
    let pinged = 0;
    const host = venueHost({ ping: async () => { pinged += 1; return { outcome: 'unreachable', message: 'no' }; } });
    assert.deepStrictEqual(await decide(undefined, host),
      { where: 'crucible', server: 'local', because: 'the top-ranked server' });
    assert.strictEqual(pinged, 0, 'naming a machine is an instruction: it is waited for, not probed');
  });

  await acheck('top-ranked skips a DISABLED server rather than sending work to it', async () => {
    const host = venueHost({ view: { ranked: [{ name: 'local', enabled: false }, { name: 'mac', enabled: true }] } });
    assert.strictEqual((await decide(undefined, host)).server, 'mac');
  });

  await acheck('any: the first enabled server whose ping answers, in RANK order', async () => {
    const tried = [];
    const host = venueHost({
      view: { newJobsWaitFor: 'any' },
      ping: async (name) => {
        tried.push(name);
        return name === 'mac'
          ? { outcome: 'ok', serverName: 'm', apiVersion: 1 }
          : { outcome: 'unreachable', message: 'nothing answered' };
      },
    });
    assert.deepStrictEqual(await decide(undefined, host),
      { where: 'crucible', server: 'mac', because: 'any: the first that answered' });
    assert.deepStrictEqual(tried, ['local', 'mac'], 'rank order, and it stops at the first that answers');
  });

  await acheck('any with nothing reachable REFUSES, naming every server it tried and what each said', async () => {
    const host = venueHost({
      view: { newJobsWaitFor: 'any' },
      ping: async (name) => ({ outcome: 'unreachable', message: `nothing answered at ${name}` }),
    });
    const err = await rejects(() => decide(undefined, host), venue.CrucibleVenueError, 'no_reachable_server');
    assert.ok(/local \(unreachable/.test(err.message) && /mac \(unreachable/.test(err.message), err.message);
    assert.ok(/local narrator/.test(err.message), 'the refusal names the switch that would run it here');
  });

  await acheck('nothing enabled: routing\'s OWN refusal, by code, in both wait-for modes', async () => {
    for (const waitFor of ['top-ranked', 'any']) {
      const host = venueHost({ view: { newJobsWaitFor: waitFor, ranked: [{ name: 'mac', enabled: false }] } });
      await rejects(() => decide(undefined, host), routing.CrucibleRoutingError, 'no_enabled_server');
    }
  });

  await acheck('the legacy switch is the ONLY way a render reaches the local narrator', async () => {
    const on = venueHost({ view: { legacyLocalRender: true } });
    assert.deepStrictEqual(await decide(undefined, on),
      { where: 'legacy-local-narrator', because: 'the legacy local-render switch is on' });
    // …and with it off, an unplaceable render throws instead of going local.
    const off = venueHost({ view: { newJobsWaitFor: 'any' }, ping: async () => ({ outcome: 'refused', message: 'no' }) });
    await rejects(() => decide(undefined, off), venue.CrucibleVenueError, 'no_reachable_server');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ran} checks, ${process.exitCode ? 'FAILING' : 'all passing'}`);
})();
