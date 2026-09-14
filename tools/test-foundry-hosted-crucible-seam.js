#!/usr/bin/env node
/**
 * THE HOSTED FOUNDRY SEAM: WHAT THE VENDORED SUBTREE CAN DO, AND WHAT WE HAND IT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-hosted-crucible-seam.js
 *
 * ── Why this suite exists: a guard that outlived its reason ────────────────
 *
 * On 2026-09-13 the hosted queue step began refusing every Crucible text act by
 * name, because the vendored Foundry window spawned its engine with
 * `env: process.env` and took no overlay — so a credential and a per-run act
 * name had nowhere to go. That was true when it was written. Foundry then gave
 * `runEngine` an `extraEnv` argument (`f300fc6`), the 2026-09-14 re-vendor
 * brought it in at `e6d5424`, **and the refusal went on quoting the old line
 * for ten hours**, because a sentence in a comment cannot notice a change in
 * somebody else's file.
 *
 * That is the failure this suite is built against, and it is a whole CLASS of
 * failure with a vendored subtree: a fact with two owners and nothing comparing
 * them (crucible `docs/ARCHITECTURE.md` R1). So every claim BookForge's refusal
 * makes about `foundry-app/` is checked HERE, against the subtree's own source,
 * and the checks are written so that a re-vendor which changes the answer turns
 * this suite red with an instruction rather than leaving a stale refusal
 * standing.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *  1. **The engine spawn still takes a per-run environment.** A re-vendor that
 *     lost `extraEnv` would mean BookForge's own text acts reached a Crucible
 *     UNAUTHENTICATED (or worse, succeeded against a server that wanted no
 *     token while sending nothing it was configured to send).
 *  2. **The host seam still carries none.** `runJob(request, {parentStep,
 *     signal, onProgress})` is what BookForge calls, and the only thing that
 *     fills `extraEnv` is the vendored dispatcher's own placement.
 *  3. **The vendored copy still cannot resolve a hosted credential** — the
 *     tripwire. The moment `foundry-app/` is re-vendored at or past foundry
 *     `e096734`, `crucibleServers()` asks `FoundryHost.servers()` and the whole
 *     refusal below stops being true. This check fails THEN, saying what to do.
 *  4. **BookForge's refusal says the true thing** and no longer quotes the line
 *     that was fixed.
 *  5. **The registry BookForge hands over is the one every other door reads**,
 *     in priority order, disabled entries included, `local` present exactly
 *     when it resolves, refusals named rather than swallowed, and a call before
 *     the first reading refused by name instead of answered with an empty list.
 *
 * No GPU, no model, no network, no registry file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const HOST_REGISTRY = path.join(REPO, 'dist', 'electron', 'crucible', 'host-registry.js');

if (!fs.existsSync(HOST_REGISTRY)) {
  console.log('SKIP: dist/electron/crucible/host-registry.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-hosted-seam-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      throw new Error(`test electron stub: app.getPath('${name}') is not stubbed`);
    },
    getAppPath: () => REPO,
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const hostRegistry = require(HOST_REGISTRY);
const hostQueue = require(path.join(REPO, 'dist', 'electron', 'foundry-host-queue.js'));
const venue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-venue.js'));

const read = (...parts) => fs.readFileSync(path.join(REPO, ...parts), 'utf-8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('\nThe vendored subtree, read rather than remembered\n');

  // ── 1. The engine spawn takes a per-run environment ──────────────────────
  check('foundry-app/electron/engine.ts still takes `extraEnv` on runEngine', () => {
    const engine = read('foundry-app', 'electron', 'engine.ts');
    assert.ok(/export function runEngine\(/.test(engine),
      'runEngine is not exported from the vendored engine module any more');
    assert.ok(/extraEnv\?: Readonly<Record<string, string>>/.test(engine),
      'the vendored runEngine no longer declares an `extraEnv` parameter. BookForge\'s OWN text '
      + 'acts put the Crucible credential and the act name there (electron/crucible/text-acts.ts, '
      + 'reach `spawn`); without it they would reach the server unauthenticated. Do not re-vendor '
      + 'over this — ask Foundry.');
    assert.ok(/\{ \.\.\.process\.env, \.\.\.extraEnv \}/.test(engine),
      'the vendored runEngine no longer merges the overlay over the inherited environment, so a '
      + 'per-run credential either does not arrive or is written onto this process.');
  });

  // ── 2. The seam BookForge calls carries no environment ───────────────────
  check('the host seam `runJob` still carries no environment of its own', () => {
    const jobQueue = read('foundry-app', 'electron', 'job-queue.ts');
    const options = /interface RunOptions \{[\s\S]*?\n\}/.exec(jobQueue);
    assert.ok(options !== null, 'the vendored RunOptions could not be found to read');
    assert.ok(!/\benv\b\s*\??:/.test(options[0]),
      'the vendored `RunOptions` has grown an environment field. That is the channel BookForge\'s '
      + 'hosted step has been refusing for want of — read it, then decide whether the act is '
      + 'composed here (headerReach `spawn`) or by their dispatcher, and delete '
      + '`hostedCrucibleTextActNotVendored` accordingly.');
    assert.ok(/runEngine\(args, watch, placement\.env\)/.test(jobQueue),
      'the vendored spawn no longer feeds `placement.env` into runEngine, so what fills a hosted '
      + 'act\'s environment has changed. Re-read the dispatcher before trusting the refusal.');
  });

  // ── 3. THE TRIPWIRE: can the vendored copy resolve a hosted credential? ──
  check('the vendored registry still cannot resolve a credential hosted (the re-vendor tripwire)', () => {
    const registry = read('foundry-app', 'electron', 'crucible-registry.ts');
    const reads = /foundryHost\(\)\?\.servers/.test(registry);
    assert.ok(!reads,
      'THIS IS NOT A REGRESSION — IT IS THE THING WE HAVE BEEN WAITING FOR.\n'
      + '        foundry-app/ has been re-vendored at or past foundry e096734: the hosted window '
      + 'now reads BookForge\'s own server registry (FoundryHost.servers(), which '
      + 'electron/crucible/host-registry.ts already offers at the mount) and its dispatcher '
      + 'composes the endpoint, the model, the header map with X-Crucible-Act, the residency and '
      + 'the model lease for itself.\n'
      + '        So: delete `hostedCrucibleTextActNotVendored` and the '
      + '`hosted_placement_not_vendored` code, stop resolving a Crucible text engine in '
      + 'electron/queue-steps/foundry-job.ts (two composers of one credential is the defect this '
      + 'seam exists to avoid), and take NO lease on that path — theirs would be refused by '
      + 'Crucible as a second lease. Then delete this check.');
    assert.ok(/crucibleServerNamed/.test(registry),
      'the vendored registry no longer resolves a slot name to an entry at all; the whole '
      + 'placement contract has moved and every claim in this suite needs re-reading.');
  });

  // ── 4. BookForge's refusal says the true thing ───────────────────────────
  console.log('\nThe refusal BookForge makes\n');

  check('the refusal names the seam, not the line Foundry already fixed', () => {
    const sentence = hostQueue.hostedCrucibleTextActNotVendored('clean', 'mac');
    assert.ok(sentence.includes('runJob'), sentence);
    assert.ok(sentence.includes('e096734'),
      'the refusal does not name the commit a re-vendor must reach, which is the only thing it '
      + `waits on:\n${sentence}`);
    assert.ok(!/env: process\.env/.test(sentence),
      `the refusal still blames the spawn Foundry fixed at f300fc6:\n${sentence}`);
    assert.ok(sentence.includes('Nothing ran'), sentence);
    // A refusal with no way forward is what the no-band-aids rule is about.
    assert.ok(sentence.includes('CLI clean routes'), sentence);
    assert.ok(sentence.includes('local engines'), sentence);
  });

  check('nothing is keyed to a Foundry version for the hosted text act any more', () => {
    assert.strictEqual(hostQueue.FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT, undefined,
      'FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT is back. It was deleted on 2026-09-14 because it was a '
      + 'version number standing in for a property of the vendored subtree — which is exactly how '
      + 'the stale refusal survived. The subtree is read by this suite instead.');
    // The two floors that ARE about a released binary stay, and are not swept
    // away with it: an old `foundry` on the machine answers `clean-text` with a
    // usage dump, and that is a version question.
    assert.strictEqual(typeof hostQueue.FOUNDRY_VERSION_FOR_CLEAN_TEXT, 'string');
    assert.strictEqual(typeof hostQueue.FOUNDRY_VERSION_FOR_CLEAN_TEXT_EPUB, 'string');
  });

  await checkAsync('a hosted text act is refused by name before the server is asked anything', async () => {
    let asked = false;
    const host = {
      view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [], legacyLocalRender: false }),
      enabled: () => [],
      ping: async () => ({ outcome: 'ok', message: 'ok' }),
      server: () => { throw new Error('the registry was read after the reach said no'); },
      models: async () => { asked = true; return []; },
      loadModel: async () => { throw new Error('a hosted refusal must never load a model'); },
      modelFor: () => 'qwen3.5-9b',
    };
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('clean', 'mac', host, { headerReach: 'none' }),
      (err) => {
        assert.strictEqual(err.code, 'hosted_placement_not_vendored');
        assert.ok(err.message.startsWith('hosted_placement_not_vendored: '), err.message);
        return true;
      });
    assert.strictEqual(asked, false, 'the server was asked for its models after the reach said no');
  });

  // ── 5. The registry BookForge hands the hosted window ────────────────────
  console.log('\nThe one registry, handed over (Owen, 2026-09-14)\n');

  const TOKEN_LOCAL = 'crux_local_aaaa';
  const TOKEN_MAC = 'crux_mac_bbbb';

  /** The two reads a snapshot is composed from, scripted. */
  function reader(over) {
    return Object.assign({
      routing: () => ({
        ranked: [
          { name: 'local', enabled: true },
          { name: 'mac', enabled: false },
          { name: 'droplet', enabled: true },
        ],
        newJobsWaitFor: 'top-ranked',
        unknown: [],
        legacyLocalRender: false,
      }),
      server: (name) => ({
        name,
        url: name === 'local' ? 'http://127.0.0.1:7100' : `https://${name}.example:7100`,
        token: name === 'local' ? TOKEN_LOCAL : TOKEN_MAC,
        source: name === 'local' ? 'local' : 'registry',
      }),
    }, over);
  }

  check('a call before the first reading REFUSES by name — never an empty list', () => {
    hostRegistry.forgetHostCrucibleRegistrySnapshot();
    assert.throws(() => hostRegistry.hostCrucibleServers(), (err) => {
      assert.strictEqual(err.code, 'registry_snapshot_not_taken');
      // An empty array here is indistinguishable, in the hosted window, from
      // "this machine has no Crucible servers" — which would park every row on
      // a sentence nobody can act on.
      assert.ok(err.message.includes('before BookForge took a reading'), err.message);
      return true;
    });
  });

  check('the servers cross in PRIORITY ORDER, with the disabled one marked and kept', () => {
    const taken = hostRegistry.refreshHostCrucibleRegistry(reader());
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['local', 'mac', 'droplet']);
    assert.deepStrictEqual(taken.servers.map((row) => row.enabled), [true, false, true]);
    // Their reader treats a MISSING `enabled` as enabled; ours always states it.
    for (const row of taken.servers) assert.strictEqual(typeof row.enabled, 'boolean');
    assert.strictEqual(taken.localAbsent, null);
  });

  check('the token crosses and the URL is handed over exactly as the registry stores it', () => {
    const rows = hostRegistry.hostCrucibleServers();
    assert.strictEqual(rows[0].token, TOKEN_LOCAL);
    assert.strictEqual(rows[1].token, TOKEN_MAC);
    // No `/v1`, no `/openai`: the vendored dispatcher composes the OpenAI base
    // itself, and a transform here would be the second composer of one address.
    for (const row of rows) {
      assert.ok(!/\/v1$/.test(row.url), row.url);
      assert.ok(!/\/openai$/.test(row.url), row.url);
    }
    assert.strictEqual(rows[0].url, 'http://127.0.0.1:7100');
  });

  check('a log line of this registry carries names only — never a token or a URL', () => {
    const line = hostRegistry.describeHostCrucibleRegistry(
      hostRegistry.hostCrucibleRegistrySnapshot());
    assert.ok(line.includes('local'), line);
    assert.ok(line.includes('mac (off)'), line);
    assert.ok(!line.includes(TOKEN_LOCAL) && !line.includes(TOKEN_MAC), line);
    assert.ok(!line.includes('7100'), line);
  });

  check('`local` is simply absent when this machine has none, and the reason is kept', () => {
    const taken = hostRegistry.refreshHostCrucibleRegistry(reader({
      routing: () => ({
        ranked: [{ name: 'mac', enabled: true }],
        newJobsWaitFor: 'any',
        unknown: [],
        legacyLocalRender: false,
      }),
    }));
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['mac']);
    assert.notStrictEqual(taken.localAbsent, null);
    assert.strictEqual(taken.localAbsent.code, 'no_local_server');
  });

  check('a name that will not resolve is OMITTED and RECORDED, never handed over half-formed', () => {
    const { CrucibleRegistryError } = require(
      path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
    const taken = hostRegistry.refreshHostCrucibleRegistry(reader({
      server: (name) => {
        if (name === 'mac') {
          throw new CrucibleRegistryError('stale_local_entry', 'mac duplicates the local server');
        }
        return {
          name,
          url: `https://${name}.example:7100`,
          token: TOKEN_MAC,
          source: 'registry',
        };
      },
    }));
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['local', 'droplet']);
    assert.deepStrictEqual(taken.omitted.map((row) => `${row.name}:${row.code}`),
      ['mac:stale_local_entry']);
    // An entry with no token would fail at the press with a worse sentence than
    // this one, and their shape has no field to carry a refusal in.
    assert.ok(hostRegistry.describeHostCrucibleRegistry(taken).includes('omitted mac'),
      hostRegistry.describeHostCrucibleRegistry(taken));
  });

  check('a failure to read the RECORDS propagates — it is never an empty registry', () => {
    const boom = new Error('crucible-servers.json is not valid JSON');
    assert.throws(() => hostRegistry.refreshHostCrucibleRegistry(reader({
      routing: () => { throw boom; },
    })), (err) => err === boom);
    // And the previous reading still stands: a read that did not work does not
    // wipe the answer the window is using.
    assert.deepStrictEqual(
      hostRegistry.hostCrucibleServers().map((row) => row.name), ['local', 'droplet']);
  });

  check('the mount offers the seam, so the window can actually ask', () => {
    const main = read('electron', 'main.ts');
    assert.ok(/servers\?\(\): readonly HostCrucibleServer\[\];/.test(main),
      'FoundryHostRecord no longer declares `servers?()` — the hosted window would be told its '
      + 'host implements no registry.');
    assert.ok(/servers: \(\): readonly HostCrucibleServer\[\] => hostRegistry\.hostCrucibleServers\(\)/
      .test(main), 'the mount no longer passes `servers` to mountFoundry.');
    assert.ok(/refreshHostCrucibleRegistry\(\)/.test(main),
      'nothing takes the first reading at the mount, so the window would meet the '
      + '`registry_snapshot_not_taken` refusal on its first paint.');
  });

  check('every door that changes the list re-reads it for the window', () => {
    const main = read('electron', 'main.ts');
    const calls = main.match(/refreshHostedFoundryRegistry\(/g) || [];
    // SIX CALLS: the five writes (add, remove, re-rank, enable, forget) and the
    // panel's read, which is where a person presses Re-check on `local`. The
    // declaration is `= async (`, so it is not one of these. A count rather
    // than a list of names because what this pins is that no door was added
    // without one.
    assert.ok(calls.length >= 6,
      `only ${calls.length} calls to the refresh helper; `
      + 'a write door that does not re-read leaves the hosted window placing work on a server '
      + 'this app no longer has, or refusing one it does.');
  });

  console.log(`\n${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length > 0) for (const name of failures) console.error(`  - ${name}`);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* a temp dir */ }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
