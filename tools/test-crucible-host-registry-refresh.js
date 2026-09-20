#!/usr/bin/env node
/**
 * THE HOSTED FOUNDRY'S VIEW OF THIS MACHINE'S SERVERS IS REFRESHED WHERE THE
 * RECORD IS WRITTEN — bug hunt C10, 2026-09-20.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-host-registry-refresh.js
 *
 * `host-registry.ts`'s own header says the snapshot is derived *"at every write
 * that can change the list (add, remove, re-rank, enable/disable, forget)"*. It
 * was not. `refreshHostCrucibleRegistry` was called from ten IPC handlers and
 * startup, while the SCHEDULER is told by `announceCrucibleRecordChanged()`
 * INSIDE `servers.addServer` / `removeServer` / `routing.setServerEnabled` /
 * `setRoutingOrder` / `forgetRoutingName` — deliberately there, so a non-IPC
 * writer could not forget. Auto-connect, the pairing flow and the CLI are all
 * non-IPC writers. So the hosted snapshot had exactly the failure mode
 * `servers.ts` was refactored to remove: a fact nobody told it about.
 *
 *  1. An announce takes a NEW READING. One rule, one place — subscribing beside
 *     the announce rather than adding a call at each of the places that might
 *     change it.
 *  2. It is ARMED ON IMPORT, so `main.ts` needs no wiring to remember. A
 *     registration a caller has to remember is a registration a later refactor
 *     drops, which is the defect above.
 *  3. A READ THAT THROWS LEAVES THE PREVIOUS SNAPSHOT STANDING, and says so —
 *     an empty list would be "you have no servers" for "I could not read
 *     yours", and it would park every hosted row on a sentence nobody can act
 *     on.
 *  4. Arming twice REPLACES rather than doubles.
 *
 * No server, no network, no GPU: the two reads a snapshot is made of are
 * injected.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { REPO, installElectronStub, makeChecker } = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const BUILT = path.join(REPO, 'dist', 'electron', 'crucible', 'host-registry.js');
if (!fs.existsSync(BUILT)) {
  console.log(skipLine('dist/electron/crucible/host-registry.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

installElectronStub('bf-host-registry-');
const hostRegistry = require(BUILT);
const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
const { check, summary } = makeChecker();

/** The two reads, as a keeper controls them. */
function reader(state) {
  return {
    routing: () => {
      if (state.throws) throw new Error('corrupt_registry: crucible-servers.json does not parse');
      return { ranked: state.ranked, newJobsWaitFor: 'top-ranked', unknown: [] };
    },
    server: (name) => ({ name, url: `http://${name}.example:7444`, token: `token-${name}` }),
  };
}

const queued = [];
const it = (name, fn) => queued.push(() => check(name, fn));

it('an announce takes a new reading — the write does not have to remember', () => {
  const state = { ranked: [{ name: 'the-mac', enabled: true }], throws: false };
  const disarm = hostRegistry.armHostCrucibleRegistryRefresh(reader(state));
  try {
    routes.announceCrucibleRecordChanged();
    assert.deepStrictEqual(
      hostRegistry.hostCrucibleServers().map((row) => `${row.name}:${row.enabled}`),
      ['the-mac:true']);

    // What `servers.addServer` / `routing.setServerEnabled` do on the same line
    // they write the record: the snapshot must move with them.
    state.ranked = [
      { name: 'the-mac', enabled: false },
      { name: 'the-pc', enabled: true },
    ];
    routes.announceCrucibleRecordChanged();
    assert.deepStrictEqual(
      hostRegistry.hostCrucibleServers().map((row) => `${row.name}:${row.enabled}`),
      ['the-mac:false', 'the-pc:true'],
      'priority order, disabled included and MARKED — their reader filters, so ours must not');
  } finally {
    disarm();
  }
});

it('it is armed ON IMPORT, so main.ts has no line to forget', () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'host-registry.ts'), 'utf-8');
  assert.ok(/^armHostCrucibleRegistryRefresh\(\);$/m.test(src),
    'the module subscribes itself at module scope');
  assert.ok(/onCrucibleRecordChanged/.test(src),
    'through the same hook the scheduler and the bench use');
});

it('a read that throws leaves the PREVIOUS snapshot standing, and is not silent', () => {
  const state = { ranked: [{ name: 'the-mac', enabled: true }], throws: false };
  const disarm = hostRegistry.armHostCrucibleRegistryRefresh(reader(state));
  const said = [];
  const realLog = console.log;
  console.log = (...args) => said.push(args.join(' '));
  try {
    routes.announceCrucibleRecordChanged();
    state.throws = true;
    routes.announceCrucibleRecordChanged();
  } finally {
    console.log = realLog;
    disarm();
  }
  assert.deepStrictEqual(hostRegistry.hostCrucibleServers().map((row) => row.name), ['the-mac'],
    'an empty list would be "you have no servers" for "I could not read yours"');
  assert.ok(said.some((line) => /corrupt_registry/.test(line)), said.join(' | '));
});

it('arming twice replaces rather than doubles', () => {
  let reads = 0;
  const counting = () => {
    const base = reader({ ranked: [], throws: false });
    return { routing: () => { reads += 1; return base.routing(); }, server: base.server };
  };
  hostRegistry.armHostCrucibleRegistryRefresh(counting());
  const disarm = hostRegistry.armHostCrucibleRegistryRefresh(counting());
  try {
    routes.announceCrucibleRecordChanged();
    assert.strictEqual(reads, 1, 'one subscription, not two file reads per announce');
  } finally {
    disarm();
  }
});

(async () => {
  for (const run of queued) await run();
  summary('crucible hosted-registry refresh');
})();
