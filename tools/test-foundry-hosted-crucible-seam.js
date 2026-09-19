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
 * ── THE TRIPWIRE FIRED, AND THIS SUITE TURNED OVER WITH IT (2026-09-15) ───
 *
 * Check 3 used to assert the vendored copy could NOT resolve a hosted
 * credential, and said, in its own failure message, that going red meant the
 * re-vendor had landed and the refusal should be deleted. That is what
 * happened: `foundry-app/` was re-vendored at foundry `4e0a4cb` (carrying
 * `e096734`), the refusal and the `none` reach are deleted, and the check is
 * now written the other way round — the hosted window READING BookForge's
 * registry is the load-bearing property, and losing it would drop every hosted
 * text act through to their Ollama door with no credential and no lease,
 * reporting success.
 *
 * ── What is pinned ────────────────────────────────────────────────────────
 *
 *  1. **The engine spawn still takes a per-run environment.** A re-vendor that
 *     lost `extraEnv` would mean a hosted act reached a Crucible
 *     UNAUTHENTICATED (or worse, succeeded against a server that wanted no
 *     token while sending nothing it was configured to send).
 *  2. **The host seam still carries no environment, and DOES carry `waitFor`.**
 *     The credential is the window's to compose; the MACHINE is BookForge's to
 *     name, and that name is matched exactly over there.
 *  3. **The vendored copy resolves a hosted credential** out of
 *     `FoundryHost.servers()` — the live wiring, not a tripwire any more.
 *  4. **BookForge composes nothing on that path** — no engine, no model, no
 *     endpoint, no lease, no local profile — and the refusal it does make (the
 *     server this machine will not offer that window) names the server, lists
 *     what IS offered, and says why it is refused here rather than handed over.
 *  5. **The registry BookForge hands over is the one every other door reads**,
 *     in priority order, disabled entries included, one kind of row wherever
 *     the machine is (Owen's ruling, 2026-09-15), refusals named rather than
 *     swallowed, and a call before the first reading refused by name instead
 *     of answered with an empty list.
 *
 * The SECOND tripwire, at the foot, is still a tripwire: it passes while the
 * vendored copy keeps its own cloud layer and goes red on the re-vendor that
 * carries foundry's PHASE15 §5.3 deletions.
 *
 * No GPU, no model, no network, no registry file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const HOST_REGISTRY = path.join(REPO, 'dist', 'electron', 'crucible', 'host-registry.js');

if (!fs.existsSync(HOST_REGISTRY)) {
  console.log(skipLine('dist/electron/crucible/host-registry.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
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

  // ── 2. The seam BookForge calls, and the one field it now depends on ─────
  check('the host seam `runJob` still carries no environment of its own', () => {
    const jobQueue = read('foundry-app', 'electron', 'job-queue.ts');
    const options = /interface RunOptions \{[\s\S]*?\n\}/.exec(jobQueue);
    assert.ok(options !== null, 'the vendored RunOptions could not be found to read');
    assert.ok(!/\benv\b\s*\??:/.test(options[0]),
      'the vendored `RunOptions` has grown an environment field. BookForge must NOT start using '
      + 'it: hosted, the credential is the window\'s to compose for its own spawn out of '
      + 'FoundryHost.servers(), and a second composer of one credential is the defect this seam '
      + 'exists to avoid. Read their dispatcher before changing anything here.');
    assert.ok(/runEngine\(args, watch, placement\.env\)/.test(jobQueue),
      'the vendored spawn no longer feeds `placement.env` into runEngine, so what fills a hosted '
      + 'act\'s environment has changed. Re-read the dispatcher.');
  });

  check('the host seam carries `waitFor`, which is the whole of what BookForge sends', () => {
    const jobQueue = read('foundry-app', 'electron', 'job-queue.ts');
    const options = /interface RunOptions \{[\s\S]*?\n\}/.exec(jobQueue);
    assert.ok(/waitFor\?: string;/.test(options[0]),
      'the vendored `RunOptions` no longer declares `waitFor`. That field IS BookForge\'s half of '
      + 'the hosted placement: the scheduler picks the machine and the name crosses here. Without '
      + 'it the window answers a choice made on BookForge\'s queue row with its OWN '
      + '`newJobsWaitFor` setting — which is the defect foundry f300fc6 added it to close.');
    // Taken verbatim and matched EXACTLY, which is why the step checks the name
    // against this app's registry snapshot before handing a row over: a name
    // that misses is a `wait`, and a detached runJob waits for ever.
    const dispatch = read('foundry-app', 'electron', 'crucible-dispatch.ts');
    assert.ok(/slotNamed\(slots, pinned\)/.test(dispatch),
      'the vendored dispatcher no longer resolves a pinned name against its slot list; re-read '
      + 'how a `waitFor` is matched before trusting the preflight in '
      + 'electron/queue-steps/foundry-job.ts.');
  });

  // ── 3. The vendored copy resolves a hosted credential — the live wiring ──
  check('the vendored registry reads BookForge\'s registry hosted (the placement this depends on)', () => {
    const registry = read('foundry-app', 'electron', 'crucible-registry.ts');
    assert.ok(/foundryHost\(\)\?\.servers/.test(registry),
      'THE HOSTED PLACEMENT IS GONE FROM THE VENDORED SUBTREE.\n'
      + '        This inverted on 2026-09-15: it used to be a TRIPWIRE waiting to go red on the '
      + 're-vendor that brought foundry e096734 in. That re-vendor happened, and this is now the '
      + 'load-bearing property — the hosted window reads BookForge\'s own server registry '
      + '(FoundryHost.servers(), offered at the mount by electron/crucible/host-registry.ts) and '
      + 'its dispatcher composes the endpoint, the model, the header map with X-Crucible-Act, the '
      + 'residency and the model lease from it.\n'
      + '        A re-vendor that lost this would make every hosted text act fall through '
      + '`placeJob` UNPLACED to their Ollama door — against `request.ollama`, with no credential '
      + 'and no lease, reporting success. Do not re-vendor over it: ask Foundry.');
    assert.ok(/crucibleServerNamed/.test(registry),
      'the vendored registry no longer resolves a slot name to an entry at all; the whole '
      + 'placement contract has moved and every claim in this suite needs re-reading.');
  });

  // ── 4. BookForge composes nothing, and refuses the one thing it can see ──
  console.log('\nWhat BookForge sends, and what it refuses\n');

  check('the refusal that waited on the re-vendor is GONE, not left standing green', () => {
    assert.strictEqual(hostQueue.hostedCrucibleTextActNotVendored, undefined,
      'hostedCrucibleTextActNotVendored is back. It said a hosted text act could be composed '
      + 'neither here nor in the vendored window, and foundry e096734 (vendored at 4e0a4cb) made '
      + 'that false. A refusal that outlives its reason is the exact failure this suite was built '
      + 'against — it happened once already, for ten hours.');
    const venueSrc = read('electron', 'crucible', 'text-venue.ts');
    assert.ok(!/'hosted_placement_not_vendored'/.test(venueSrc),
      'the hosted_placement_not_vendored code is back in text-venue.ts');
    assert.ok(!/\|\s*'none';/.test(venueSrc),
      'the `none` reach is back in EndpointHeaderReach. Its only caller was the hosted step, '
      + 'which composes nothing now.');
  });

  check('the hosted step composes NOTHING — no engine, no model, no endpoint, no lease', () => {
    /*
     * COMMENTS ARE STRIPPED FIRST, and that is not a loophole — it is the
     * difference between the property and the prose. What this pins is that the
     * step does not CALL these things; the block at the head of that file names
     * every one of them to say why it no longer does, and a check that could
     * not tell the two apart would force the next person to delete the
     * explanation in order to go green.
     */
    const step = read('electron', 'queue-steps', 'foundry-job.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/resolveCrucibleTextEngine/.test(step),
      'the hosted step resolves a Crucible text engine again. Two composers of one credential is '
      + 'the defect this seam exists to avoid: the vendored dispatcher composes the endpoint, the '
      + 'model and the header map out of the registry this app hands it.');
    assert.ok(!/withCrucibleTextActLease/.test(step),
      'the hosted step takes a Crucible lease. Crucible allows ONE per server and the vendored '
      + 'dispatcher already takes it (crucible-dispatch.ts, released in their settle), so this '
      + 'one would be refused 409 model_leased — by this app, to itself.');
    assert.ok(!/ensureTextServer|profileForKind|servedModelForRequest/.test(step),
      'the hosted step is choosing a LOCAL text-server profile again. The local text engines are '
      + 'deleted (docs/LEGACY-REMOVAL.md) and the model for a class is the SERVER\'s answer '
      + '(GET /v1/capability), not this machine\'s profile table.');
    assert.ok(/foundryRunner\(\)\(config\.request, \{/.test(step),
      'the hosted step is no longer handing the request across VERBATIM. Its `model` and `ollama` '
      + 'are Foundry\'s own composition and the placement overrides both; writing either here '
      + 'would be the second composer of one address.');
    assert.ok(/waitFor,/.test(step),
      'the hosted step no longer sends the machine. Without it the vendored window answers a '
      + 'choice made on BookForge\'s queue row with its own default.');
  });

  check('a placed hosted act goes through the OPENAI door, with the engine\'s own pool', () => {
    /*
     * ── CHECKED RATHER THAN ASSUMED, because it is invisible when it is wrong ─
     *
     * Owen's ruling of 2026-09-08 (*"lets build in vllm batching. ollama
     * batching doesnt work"*) gave the three text acts a pool of workers whose
     * in-flight requests vLLM packs into one batch — 12 on the OpenAI door, 4
     * on Ollama's, where this PC's `OLLAMA_NUM_PARALLEL=1` makes a pool
     * pointless. A seam that quietly produced one-request-at-a-time, or the
     * Ollama pool, would look entirely healthy and run several times slower,
     * which is the same failure shape as an MLX batch width of 1.
     *
     * TWO THINGS MAKE IT COME OUT RIGHT AND NEITHER IS OURS TO SET, so both are
     * read here rather than remembered:
     *
     *  1. A Crucible placement declares `door: 'openai'`, and `serverArgs`
     *     spells the OTHER two — so the engine picks its OpenAI default (12)
     *     for a placed act and its Ollama default (4) for an UNPLACED one.
     *     This is the second reason a hosted act must actually be placed:
     *     before the re-vendor every one of them fell through to the Ollama
     *     door and would have run the narrow pool.
     *  2. `--concurrency` is only on the line when the REQUEST names a number.
     *     BookForge's hosted request never does — it is Foundry's own,
     *     forwarded verbatim — so the engine's default stands. The number
     *     itself lives in the engine (`DEFAULT_TEXT_CONCURRENCY`), which is not
     *     vendored here, and must not be copied to this side.
     */
    const dispatch = read('foundry-app', 'electron', 'crucible-dispatch.ts');
    assert.ok(/door: 'openai',/.test(dispatch),
      'a Crucible placement no longer declares the openai door. If it came back as `ollama` the '
      + 'engine would use its NARROW pool (4, sized for a server whose parallelism is off) '
      + 'against a vLLM that batches — slower by several times and silent about it.');
    const jobQueue = read('foundry-app', 'electron', 'job-queue.ts');
    assert.ok(/case 'openai': return \[\];/.test(jobQueue),
      'the vendored `serverArgs` no longer treats openai as the unspelled default door.');
    assert.ok(/args\.push\('--concurrency', String\(request\.concurrency\)\);/.test(jobQueue),
      'the vendored spawn no longer forwards a request concurrency; re-read how the pool is '
      + 'sized before trusting anything above.');
    const step = read('electron', 'queue-steps', 'foundry-job.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/concurrency/.test(step),
      'the hosted step is setting a concurrency. The pool is the ENGINE\'s — 12 on the OpenAI '
      + 'door, deliberately deeper than the ~7 a server admits, because the rest queue in the '
      + 'server rather than thrashing the card. A number here would be a second copy of one that '
      + 'lives in foundry\'s src/translate/model-server.ts and is not vendored.');
  });

  check('the one refusal BookForge still makes names the server and lists what IS offered', () => {
    const sentence = hostQueue.hostedCrucibleServerNotOffered(
      'clean', 'mac', ['local', 'droplet'], 'that server is switched off.');
    assert.ok(sentence.includes('"mac"'), sentence);
    assert.ok(sentence.includes('that server is switched off.'), sentence);
    // A refusal with no way forward is what the no-band-aids rule is about.
    assert.ok(sentence.includes('local, droplet'),
      `it must list what the window IS being offered, so the fix is on the sentence:\n${sentence}`);
    assert.ok(sentence.includes('Nothing ran'), sentence);
    assert.ok(/Settings . Crucible Servers/.test(sentence), sentence);
    // It exists because the alternative over there is silence, not a failure.
    assert.ok(/parks the job for ever/.test(sentence),
      `it must say WHY this is refused here rather than handed over:\n${sentence}`);
    assert.ok(!/turn on|legacy switch|local engines/i.test(sentence),
      `it offers a route that no longer exists:\n${sentence}`);
    const empty = hostQueue.hostedCrucibleServerNotOffered('translate', 'mac', [], 'no entry.');
    assert.ok(empty.includes('no servers at all'),
      `an empty list must read as "none", not as an empty sentence:\n${empty}`);
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

  await checkAsync('the hosted step asks a Crucible server NOTHING — the window does the asking', async () => {
    /*
     * The old check here proved a hosted act was refused before any network.
     * The property that replaced it is stronger and is the same shape: this
     * side still makes no call to a Crucible for a hosted act — not because it
     * is refused, but because the whole placement is the vendored window's. The
     * only network in the path is `decideWhereTextActRuns`'s ping, and only on
     * `newJobsWaitFor: 'any'`.
     */
    let asked = false;
    const host = {
      view: () => ({
        ranked: [{ name: 'mac', enabled: true }],
        newJobsWaitFor: 'top-ranked',
        unknown: [],
        legacyLocalRender: false,
      }),
      enabled: () => [{ name: 'mac', enabled: true }],
      ping: async () => { asked = true; return { outcome: 'ok', message: 'ok' }; },
      server: () => { throw new Error('the hosted path must not read a credential'); },
      models: async () => { asked = true; return []; },
      loadModel: async () => { throw new Error('the hosted path must never load a model'); },
      capability: async () => { asked = true; return { classes: [] }; },
    };
    const decided = await venue.decideWhereTextActRuns(undefined, host);
    assert.deepStrictEqual(
      { where: decided.where, server: decided.server },
      { where: 'crucible', server: 'mac' });
    assert.strictEqual(asked, false,
      'deciding WHICH MACHINE asked a server something. On `top-ranked` naming a machine is an '
      + 'instruction, and the capability, the models and the credential are the vendored '
      + 'window\'s to read.');
  });

  // ── 5. The registry BookForge hands the hosted window ────────────────────
  console.log('\nThe one registry, handed over (Owen, 2026-09-14)\n');

  const TOKEN_HERE = 'crux_here_aaaa';
  const TOKEN_MAC = 'crux_mac_bbbb';

  /** The two reads a snapshot is composed from, scripted. */
  function reader(over) {
    return Object.assign({
      routing: () => ({
        ranked: [
          // A loopback engine is one row like any other now: no reserved
          // name, no badge, no separate source — see servers.ts.
          { name: '3090 Ti', enabled: true },
          { name: 'mac', enabled: false },
          { name: 'droplet', enabled: true },
        ],
        newJobsWaitFor: 'top-ranked',
        unknown: [],
      }),
      server: (name) => ({
        name,
        url: name === '3090 Ti' ? 'http://127.0.0.1:7100' : `https://${name}.example:7100`,
        token: name === '3090 Ti' ? TOKEN_HERE : TOKEN_MAC,
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
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['3090 Ti', 'mac', 'droplet']);
    assert.deepStrictEqual(taken.servers.map((row) => row.enabled), [true, false, true]);
    // Their reader treats a MISSING `enabled` as enabled; ours always states it.
    for (const row of taken.servers) assert.strictEqual(typeof row.enabled, 'boolean');
    // THERE IS NO SEPARATE ANSWER ABOUT THIS MACHINE any more: the snapshot
    // is the ranking and the registry, and nothing else.
    assert.strictEqual('localAbsent' in taken, false,
      'localAbsent is deleted; a field about "the local row" is how the reserved name comes back');
  });

  check('the token crosses and the URL is handed over exactly as the registry stores it', () => {
    const rows = hostRegistry.hostCrucibleServers();
    assert.strictEqual(rows[0].token, TOKEN_HERE);
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
    assert.ok(line.includes('3090 Ti'), line);
    assert.ok(line.includes('mac (off)'), line);
    assert.ok(!line.includes(TOKEN_HERE) && !line.includes(TOKEN_MAC), line);
    assert.ok(!line.includes('7100'), line);
  });

  check('a machine with one registered server hands over exactly that one', () => {
    const taken = hostRegistry.refreshHostCrucibleRegistry(reader({
      routing: () => ({
        ranked: [{ name: 'mac', enabled: true }],
        newJobsWaitFor: 'any',
        unknown: [],
      }),
    }));
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['mac']);
    assert.deepStrictEqual(taken.omitted, []);
  });

  check('a name that will not resolve is OMITTED and RECORDED, never handed over half-formed', () => {
    const { CrucibleRegistryError } = require(
      path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
    const taken = hostRegistry.refreshHostCrucibleRegistry(reader({
      server: (name) => {
        if (name === 'mac') {
          throw new CrucibleRegistryError('unknown_server', 'mac was removed a moment ago');
        }
        return { name, url: `https://${name}.example:7100`, token: TOKEN_MAC };
      },
    }));
    assert.deepStrictEqual(taken.servers.map((row) => row.name), ['3090 Ti', 'droplet']);
    assert.deepStrictEqual(taken.omitted.map((row) => `${row.name}:${row.code}`),
      ['mac:unknown_server']);
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
      hostRegistry.hostCrucibleServers().map((row) => row.name), ['3090 Ti', 'droplet']);
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

  // ── 6. THE HOP, DRIVEN WITH BOOKFORGE'S OWN REGISTRY ROWS ────────────────
  //
  // Foundry proved `resolveEngine` against this PC's real :7100 and :7101.
  // What they could NOT prove is the HOSTED case, because it does not exist
  // until this subtree is vendored — the entries their resolver sees hosted are
  // the ones `electron/crucible/host-registry.ts` composes, and nothing on
  // their side can produce one.
  //
  // So this section drives the VENDORED resolver for real — their compiled
  // module, the real SDK, the real `engineOf` — over a stubbed `globalThis.fetch`,
  // with entries of OUR shape. No network, no GPU, no registry file.
  //
  // It matters because of what BookForge hands over: a URL and a token this app
  // OWNS. If a person registers the tray (an orchestrator) rather than the
  // engine, every hosted text act depends on that hop being followed, once,
  // with our token.
  console.log('\nThe orchestrator hop, driven with the rows BookForge hands over\n');

  const hopRegistry = require(path.join(
    REPO, 'foundry-app', 'dist', 'electron', 'crucible-registry.js'));

  /** `GET /v1/info` for an ENGINE, in the shape the SDK's reader demands. */
  const engineInfo = (name) => ({
    role: 'engine',
    managed_by: null,
    server: { name, version: '0.6.0', api_version: 1 },
    host: {
      platform: 'linux',
      arch: 'x64',
      backend: 'cuda-linux',
      gpu: { vendor: 'nvidia', name: 'RTX 4090', vram_bytes: 25757220864 },
    },
    job_types: ['llm', 'load-model'],
    capabilities: [],
  });

  /** `GET /v1/info` for an ORCHESTRATOR, optionally naming an engine. */
  const trayInfo = (name, engineUrl) => ({
    ...engineInfo(name),
    role: 'orchestrator',
    engine: engineUrl === null
      ? null
      : { name: 'wsl-engine', url: engineUrl, backend: 'cuda-linux', owner: 'wsl-unit' },
  });

  /**
   * Answer `/v1/info` per host, recording every call and the token it carried.
   * Anything else 404s: a hop must not need a second door.
   */
  function serveInfo(byHost) {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      // The SDK builds a real `Headers`, not a plain object (client.js:
      // `headers.set('Authorization', ...)`), so it is read the one way that
      // works for either rather than indexed and silently found empty.
      const raw = (init && init.headers) || null;
      const auth = raw === null
        ? null
        : (typeof raw.get === 'function'
          ? raw.get('Authorization')
          : (raw.Authorization || raw.authorization || null));
      seen.push({ url: target, auth });
      const host = new URL(target).host;
      const doc = byHost[host];
      if (doc === undefined || !target.endsWith('/v1/info')) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(doc), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    return seen;
  }

  const TRAY = 'http://127.0.0.1:7100';
  const ENGINE = 'http://127.0.0.1:7101';
  const SECRET = 'crux_hosted_do_not_print';
  // One of ours, exactly as `hostCrucibleServers()` composes it: no `/v1`, no
  // `/openai`, `enabled` always stated.
  const ours = (url, token = SECRET) => ({ name: 'local', url, token, enabled: true });

  const realFetch = globalThis.fetch;

  await checkAsync('an entry that IS the engine resolves to itself — no hop, no second call', async () => {
    hopRegistry.forgetEngineTargets();
    const seen = serveInfo({ '127.0.0.1:7101': engineInfo('wsl-engine') });
    const target = await hopRegistry.resolveEngine(ours(ENGINE));
    assert.strictEqual(target.hop, null, 'a plain engine must not report a hop');
    assert.strictEqual(target.entry.url, ENGINE);
    assert.strictEqual(target.entry.token, SECRET, 'the token must survive untouched');
    assert.strictEqual(seen.length, 1,
      `a machine that is already the engine must cost ONE info() call, not two: ${seen.length}`);
  });

  await checkAsync('an ORCHESTRATOR resolves to its engine, with the SAME token', async () => {
    hopRegistry.forgetEngineTargets();
    const seen = serveInfo({
      '127.0.0.1:7100': trayInfo('tray', ENGINE),
      '127.0.0.1:7101': engineInfo('wsl-engine'),
    });
    const target = await hopRegistry.resolveEngine(ours(TRAY));
    assert.strictEqual(target.entry.url, ENGINE,
      'the placement would have gone to the orchestrator, which serves no model');
    assert.strictEqual(target.entry.token, SECRET,
      'PHASE17 §6: follow engine.url ONCE, with the SAME token');
    assert.strictEqual(target.entry.name, 'local',
      'the entry keeps OUR name — that is what the slot is called and what the row pinned');
    assert.notStrictEqual(target.hop, null);
    assert.strictEqual(target.hop.orchestratorUrl, TRAY);
    assert.strictEqual(target.hop.engineUrl, ENGINE);
    // BOTH documents are read, and the second is read BEFORE work is sent: that
    // is what makes "once, never a chain" enforced rather than assumed.
    assert.deepStrictEqual(seen.map((c) => new URL(c.url).port), ['7100', '7101']);
    for (const call of seen) {
      assert.ok(String(call.auth).includes(SECRET),
        'the hop dropped our credential — the engine would answer 401');
    }
  });

  await checkAsync('a CHAIN is refused, not followed — an orchestrator behind an orchestrator', async () => {
    hopRegistry.forgetEngineTargets();
    serveInfo({
      '127.0.0.1:7100': trayInfo('tray', ENGINE),
      '127.0.0.1:7101': trayInfo('second-tray', 'http://127.0.0.1:7102'),
    });
    await assert.rejects(() => hopRegistry.resolveEngine(ours(TRAY)), (err) => {
      assert.strictEqual(err.code, 'orchestrator_engine_is_not_an_engine',
        `a chain must be refused by name, not walked: ${err.message}`);
      assert.ok(!err.message.includes(SECRET), 'the refusal printed the bearer token');
      return true;
    });
  });

  await checkAsync('an orchestrator with NO engine is refused by name', async () => {
    hopRegistry.forgetEngineTargets();
    serveInfo({ '127.0.0.1:7100': trayInfo('tray', null) });
    await assert.rejects(() => hopRegistry.resolveEngine(ours(TRAY)), (err) => {
      assert.strictEqual(err.code, 'orchestrator_has_no_engine', err.message);
      assert.ok(!err.message.includes(SECRET), 'the refusal printed the bearer token');
      return true;
    });
  });

  await checkAsync('a token BookForge rotated is used, never the cached one', async () => {
    /*
     * THE ONE THAT WOULD BE OURS TO CAUSE. BookForge owns the registry, so a
     * token rotation happens on THIS side and the window must pick it up. Their
     * `hopKey` is name+url and deliberately not the token, so the cached hop
     * stays valid across a rotation — and `withToken` is what keeps the cached
     * URL while taking the secret from the entry in hand. If that ever
     * inverted, every hosted act after a rotation would 401 with nothing in the
     * log to explain it, because nothing here is logged.
     */
    hopRegistry.forgetEngineTargets();
    const seen = serveInfo({
      '127.0.0.1:7100': trayInfo('tray', ENGINE),
      '127.0.0.1:7101': engineInfo('wsl-engine'),
    });
    const first = await hopRegistry.resolveEngine(ours(TRAY));
    assert.strictEqual(first.entry.token, SECRET);
    const calls = seen.length;
    const rotated = await hopRegistry.resolveEngine(ours(TRAY, 'crux_rotated_bbbb'));
    assert.strictEqual(rotated.entry.url, ENGINE, 'the cached hop should still be used');
    assert.strictEqual(rotated.entry.token, 'crux_rotated_bbbb',
      'the CACHED token came back. A rotation on BookForge\'s side would 401 for ever.');
    assert.strictEqual(seen.length, calls,
      'a rotation re-walked the hop; the cache key must be name+url, not the token');
  });

  globalThis.fetch = realFetch;
  hopRegistry.forgetEngineTargets();

  check('the hosted PLACEMENT resolves the hop once, and the spawn uses that address', () => {
    const dispatch = read('foundry-app', 'electron', 'crucible-dispatch.ts');
    assert.ok(/const engine = \(await resolveEngine\(entry\)\)\.entry;/.test(dispatch),
      'placeOnCrucible no longer resolves the engine behind a registry entry. Hosted, the entry '
      + 'is BookForge\'s — if a person registered the tray rather than the engine, the act would '
      + 'be sent to a process that serves no model.');
    assert.ok(/const client = clientFor\(engine\);/.test(dispatch),
      'the placement builds its client from something other than the resolution, so the request '
      + 'and the spawn can end at two different processes — the exact pairing their comment says '
      + 'this ordering exists to prevent.');
  });

  check('a console and a pairing file do NOT follow the hop — the split, mirrored not contradicted', () => {
    /*
     * Their deliberate exception, and BookForge must not quietly disagree with
     * it: a PLACEMENT asks a machine to work and only an engine can, but a
     * CONSOLE is a person going to look at the process they named — and after
     * Phase 17 the orchestrator's console is the one carrying install, restart
     * and quit. Pinned here because the natural "fix" for somebody reading
     * `crucible:open` in isolation is to make it resolve like everything else.
     */
    const ipc = read('foundry-app', 'electron', 'ipc.ts');
    assert.ok(/ipcMain\.handle\('crucible:open'/.test(ipc),
      'the crucible:open channel is gone; re-read where a console address comes from.');
    // The handler is one line that delegates, so the claim is checked where the
    // address is actually composed.
    const ui = read('foundry-app', 'electron', 'crucible-ui.ts');
    const opener = /export function openCrucibleUi\(name: string\): void \{[\s\S]*?\n\}/.exec(ui);
    assert.ok(opener !== null, 'openCrucibleUi could not be found to read');
    assert.ok(!/resolveEngine/.test(opener[0]),
      'openCrucibleUi now follows the hop. A console is the process a person NAMED — and after '
      + 'Phase 17 the ORCHESTRATOR\'s console is the one carrying install, restart and quit, so '
      + 'resolving past it would take the operator to the machine with fewer buttons.');
    assert.ok(/const entry = crucibleServerNamed\(name\);/.test(opener[0]),
      'the console address is no longer composed from the registered entry itself.');
    const pairing = read('foundry-app', 'electron', 'crucible-pairing.ts');
    assert.ok(!/resolveEngine/.test(pairing),
      'the pairing-file door now follows the hop. A pairing file names the machine a person '
      + 'was handed; adopting it registers THAT address, and the hop is followed later, at the '
      + 'placement.');
    // BookForge has no console or pairing door on this seam, and must not grow
    // one that resolves differently from theirs.
    const step = read('electron', 'queue-steps', 'foundry-job.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/crucible:open|adoptPairingFile|resolveEngine/.test(step),
      'the hosted step has grown a console, a pairing adoption or its own hop resolution. All '
      + 'three belong to the window that owns the placement.');
  });

  check('a WAIT that time cannot fix is STANDING, so a pinned row fails instead of parking', () => {
    /*
     * ── THE DEFECT THIS SEAM FOUND, AND FOUNDRY'S FIX ────────────────────────
     *
     * BookForge's hosted step hands a job to a DETACHED `runJob`, which holds no
     * pump slot — so `placeRun`'s `for(;;)` retries a wait with a backoff and
     * the promise never settles. A row that neither fails nor finishes is worse
     * than either outcome.
     *
     * Foundry agreed it was theirs and split the wait arm: `standing` is
     * REQUIRED at every site, via explicit constructors rather than an optional
     * flag, so "nobody thought about it" and "this is transient" cannot be the
     * same value. A pinned slot that answers with a standing wait now REFUSES.
     *
     * What is still transient, deliberately, is a slot that is not in the list
     * at all — switched off, renamed, removed. Their argument is sound for
     * THEIR queue (a person is about to flip the switch back, and failing would
     * throw the row's place away) and fatal for a detached `runJob`. That gap
     * is exactly what BookForge's own preflight covers, which is why it is not
     * redundant with any of this.
     */
    const dispatch = read('foundry-app', 'electron', 'crucible-dispatch.ts');
    assert.ok(/function standingWait\(/.test(dispatch) && /function transientWait\(/.test(dispatch),
      'the standing/transient split is gone from the vendored dispatcher. Without it a hosted '
      + 'row pinned to a server that cannot do the work parks for ever.');
    assert.ok(/outcome\.verdict === 'wait' && outcome\.standing\s*\n?\s*\? \{ verdict: 'refuse'/
      .test(dispatch),
      'a pinned slot no longer turns a standing wait into a refusal, so a hosted row pinned to a '
      + 'server whose capability row is disabled would park rather than fail.');
    assert.ok(/return transientWait\(\s*`waiting for "\$\{pinned\}", which is switched off or no longer registered`/
      .test(dispatch),
      'the "switched off or no longer registered" wait changed. BookForge\'s preflight '
      + '(hostedCrucibleServerNotOffered) exists BECAUSE that one is transient and a detached '
      + 'runJob retries it for ever — re-read both before changing either.');
  });

  // ── 7. THE NAMING CONTRACT, END TO END, WITH NO NETWORK AND NO GPU ───────
  //
  // The one thing that can silently strand a hosted act is a NAME: BookForge's
  // step sends `waitFor`, and their `slotNamed` matches it against a slot list
  // derived from the registry this app handed over. Every other property of the
  // placement refuses out loud; a name that misses is a `wait`, and a detached
  // `runJob` retries a wait for ever.
  //
  // Both halves are pure functions over a list, so the WHOLE chain runs here:
  //
  //   hostCrucibleServers()          <- ours, the snapshot the window is handed
  //     -> recordHost({servers})     <- the mount seam, as main.ts wires it
  //     -> readRegistry()            <- theirs: cleanHostServers
  //     -> computeSlots() / slotsFrom
  //     -> slotNamed(slots, waitFor) <- theirs, exact and case-sensitive
  //
  // This is what makes the preflight in queue-steps/foundry-job.ts provable
  // rather than argued. It is checked at every re-vendor because their half of
  // it moves: `40aaa42` introduced `tidySlotName`, which COLLAPSES runs of
  // whitespace, and had it been applied to host entries a server named
  // `my  mac` would have become `my mac` over there — our preflight passing,
  // their lookup missing, the row parked for ever with nothing in any log.
  console.log('\nOur registry row -> their slot, by name\n');

  const foundryHostMod = require(path.join(
    REPO, 'foundry-app', 'dist', 'electron', 'host.js'));
  const foundrySlots = require(path.join(
    REPO, 'foundry-app', 'dist', 'shared', 'slots.js'));

  /** Wire our registry into their mount seam, exactly as `main.ts` does. */
  function handOverToTheWindow() {
    foundryHostMod.recordHost({
      servers: () => hostRegistry.hostCrucibleServers(),
    });
    return hopRegistry.computeSlots();
  }

  check('a BookForge row becomes a slot of exactly the name the step will send', () => {
    hostRegistry.refreshHostCrucibleRegistry(reader());
    const slots = handOverToTheWindow();
    /*
     * THE NAMES ARE TAKEN FROM THE SNAPSHOT, never written out here. They were
     * hardcoded once and it cost a red keeper within the hour: `24b7bf67`
     * deleted the reserved server name `local` (BookForge's mirror of foundry
     * `40aaa42`, "a local Crucible is an ordinary server") and this suite's
     * fixture became `3090 Ti`. The PROPERTY has nothing to do with what a
     * server is called — it is that whatever we hold, we can also find — so
     * naming one here only pinned the fixture.
     */
    const enabled = hostRegistry.hostCrucibleServers().filter((row) => row.enabled);
    assert.ok(enabled.length > 0, 'the scripted registry offers no enabled server to check');
    for (const row of enabled) {
      // `waitFor` is composed the way the step composes it: the row's own name,
      // trimmed. If these two ever disagree the row parks rather than failing.
      const waitFor = row.name.trim();
      const theirs = slots.map((s) => s.name).join(', ');
      assert.notStrictEqual(foundrySlots.slotNamed(slots, waitFor), null,
        `BookForge would send waitFor="${waitFor}" and the hosted window derives no slot by that `
        + `name (its slots: ${theirs}). This is the forever-park that `
        + 'hostedCrucibleServerNotOffered exists to prevent, and it means the two halves of the '
        + 'naming contract have drifted.');
    }
  });

  check('a DISABLED row is not a slot — which is why the preflight refuses it here', () => {
    // Their `slotsFrom` filters disabled entries out before a slot exists, so
    // "switched off" is indistinguishable from "not registered" over there.
    // BookForge still hands the row across (marked), and refuses at the step.
    const slots = handOverToTheWindow();
    const rows = hostRegistry.hostCrucibleServers();
    const off = rows.find((s) => !s.enabled);
    assert.ok(off !== undefined, 'the scripted registry no longer has a disabled row to check');
    assert.strictEqual(foundrySlots.slotNamed(slots, off.name), null,
      `"${off.name}" is switched off in BookForge's registry and the hosted window still derives a `
      + 'slot for it. The preflight and the placement would then disagree about whether that '
      + 'server is available.');
    // And the row DOES cross, marked — their derivation filters, so ours must
    // not, or nothing over there could say "that one is switched off".
    assert.strictEqual(off.enabled, false);
  });

  check('the name is carried through UNTIDIED — no collapse, no truncation, no case fold', () => {
    /*
     * The property `40aaa42` put at risk. Driven with names that would move if
     * any tidying were applied on the hosted path: a run of spaces, a mixed
     * case, and a name at the 48-character limit their writer now enforces.
     *
     * NOTE these names never go through their writer — a hosted registry is
     * read-only over there — so the writer's rules are not what governs here.
     * What governs is `cleanHostServers`, which trims and nothing else.
     */
    const awkward = 'My  Mac';
    const longName = 'x'.repeat(48);
    hostRegistry.refreshHostCrucibleRegistry({
      routing: () => ({
        ranked: [{ name: awkward, enabled: true }, { name: longName, enabled: true }],
        newJobsWaitFor: 'top-ranked',
        unknown: [],
        legacyLocalRender: false,
      }),
      server: (name) => ({
        name, url: 'https://example:7100', token: 'crux_test_aaaa', source: 'registry',
      }),
    });
    const slots = handOverToTheWindow();
    for (const name of [awkward, longName]) {
      assert.notStrictEqual(foundrySlots.slotNamed(slots, name), null,
        `"${name}" did not survive the crossing intact. Something on the hosted path is now `
        + 'tidying, collapsing or truncating a name — `tidySlotName` (foundry 40aaa42) does '
        + 'exactly that, and it must stay OFF `cleanHostServers`. BookForge would send the '
        + 'untidied name and the row would park for ever.');
    }
    // Restore the suite's own registry for anything after this.
    hostRegistry.refreshHostCrucibleRegistry(reader());
  });

  // ── THE SECOND TRIPWIRE: FOUNDRY'S PHASE15 5.3 DELETIONS ─────────────
  //
  // What their 5.3 deletes is the same list this app has already deleted, on
  // their side of the line: `cloud-providers.ts`, the cloud card, the
  // `ComputeSlotKind = 'cloud'` placement, and `FOUNDRY_ENDPOINT_HEADERS`
  // composed from an app-held key. An Anthropic key is the ENGINE's now
  // (PHASE15 section 0, which overruled the morning ruling that put it on
  // Foundry's card), and Foundry's card becomes a window onto the engine's
  // settings exactly as BookForge's has.
  //
  // These two checks are written the same way round as the first tripwire
  // was: they pass while the vendored copy still has its cloud layer, and go
  // RED the day it does not — which is the day their package L is reachable,
  // not the day something broke.
  //
  // THE FIRST TRIPWIRE HAS ALREADY FIRED AND BEEN ACTED ON (2026-09-15), so
  // this one's instructions no longer carry that work: the vendor at foundry
  // `1ce539a` brought in the hosted registry read and `RunOptions.waitFor`,
  // `hostedCrucibleTextActNotVendored`, the `hosted_placement_not_vendored`
  // code and the `none` reach are all deleted, and `slots?()` was never
  // offered by this app. What is left for the L re-vendor is the cloud half.
  check('the vendored copy still has its own cloud layer (the phase-15 re-vendor tripwire)', () => {
    const present = fs.existsSync(path.join(REPO, 'foundry-app', 'electron', 'cloud-providers.ts'));
    assert.ok(present,
      'THIS IS NOT A REGRESSION — IT IS THE SECOND THING WE HAVE BEEN WAITING FOR.\n'
      + '        foundry-app/electron/cloud-providers.ts is gone, so this subtree has been '
      + 're-vendored at or past foundry\'s PHASE15 section 5.3 (their package L).\n'
      + '        DO NOT go looking for the hosted-text-act work in this message: that was the '
      + 'FIRST tripwire, it fired on 2026-09-15, and it is DONE — the vendor at foundry '
      + '1ce539a carries the hosted registry read and RunOptions.waitFor, and '
      + '`hostedCrucibleTextActNotVendored`, the `hosted_placement_not_vendored` code and the '
      + '`none` reach are all deleted. `slots?()` was never offered by this app.\n'
      + '        What THIS one asks for is the cloud half alone: point their settings card at '
      + 'the engine\'s document the way Settings -> AI already does here, and re-read '
      + 'BookForge\'s own cloud lane (shared/queue/slot-sets.ts draws `<server>:cloud`) '
      + 'against whatever their dispatcher does instead.\n'
      + '        Then delete this check and the one below it.');
  });

  check('the vendored dispatcher still places on a cloud slot kind', () => {
    const dispatch = read('foundry-app', 'electron', 'crucible-dispatch.ts');
    assert.ok(/slot\.kind === 'cloud'/.test(dispatch),
      'the vendored dispatcher no longer knows a `cloud` slot kind. That is PHASE15 section 5.3 '
      + 'landing on their side: a class routed upstream is the ENGINE\'s business now, and the '
      + 'lane it takes is one per SERVER — BookForge draws `<server>:cloud` '
      + '(shared/queue/slot-sets.ts) and so do they. Re-read their placement before trusting '
      + 'anything this suite says about where a hosted act runs, and re-vendor.');
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
