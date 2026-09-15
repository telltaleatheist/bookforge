#!/usr/bin/env node
/**
 * THE FOUR TEXT ACTS ON SOMEBODY ELSE'S CARD, AND THE SIX WAYS IT LIES QUIETLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-text-acts.js
 *
 * Rollout item 2.6: `clean`, `translate`, `simplify` and `analysis` stop being
 * work BookForge's own llama-server does and become work a Crucible does — the
 * foundry engine spawned with `--endpoint <server>/v1/openai`, `--model <a
 * Crucible id>` and the header map in its environment.
 *
 * Every check here is a thing that would otherwise be found on a real book with
 * a real card, and most of them would be found as SILENCE rather than as an
 * error:
 *
 *  1. **The act is named truthfully, and the four are distinct.** Owen,
 *     2026-09-13: *"they can't lie to the user and say a translate job is
 *     running when it's actually a simplify job."* A simplify run must never
 *     send `X-Crucible-Act: translate` — and Crucible refuses an act name it
 *     does not know, so the four spellings are checked against crucible's OWN
 *     `capability.py` rather than against this repo's memory of it.
 *  2. **The token is in the ENVIRONMENT and NOWHERE else.** Not on the argv, not
 *     in anything printed. A command line is the most copied thing a program
 *     has (crucible `docs/PHASE7-LANES.md` §7.1(B)).
 *  3. **The endpoint is the OpenAI door, composed and not guessed.**
 *  4. **A model that is not resident refuses BEFORE any spawn.** A cleanup never
 *     loads a model on somebody's card; the refusal names the act, the server
 *     and the id.
 *  5. **A 409 holds with the HOLDER's name**, rather than failing the book or
 *     running it somewhere else.
 *  6. **The legacy switch routes to the local engines and says so by name** —
 *     one switch for renders and text passes both.
 *  7. **A caller that cannot give the engine process an environment is
 *     REFUSED.** The credential and the per-run act name travel there, so
 *     the app's hosted queue step — somebody else's spawn, reached through a
 *     seam that carries no environment — gets a named no rather than a run
 *     that reaches the server unauthenticated, or one whose act name is
 *     another act's. WHAT that refusal waits on is pinned against the
 *     vendored subtree by `tools/test-foundry-hosted-crucible-seam.js`; only
 *     the behaviour is pinned here.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no registry but its own.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const VENUE = path.join(REPO, 'dist', 'electron', 'crucible', 'text-venue.js');

if (!fs.existsSync(VENUE)) {
  console.log('SKIP: dist/electron/crucible/text-venue.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// A userData of our own, and an electron that answers for it
// ─────────────────────────────────────────────────────────────────────────────

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-text-'));
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
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const venue = require(VENUE);
const acts = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-acts.js'));
const cleanText = require(path.join(REPO, 'dist', 'electron', 'narration-clean-text.js'));
const wire = require(path.join(REPO, 'dist', 'shared', 'crucible', 'settings-wire.js'));

let passed = 0;
const failures = [];
async function check(name, fn) {
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

const TOKEN = 'crux_secret_token_abcd';

/**
 * A host that answers from a script, so every branch is reachable with no
 * registry, no routing record and no network. The real one is
 * `processTextVenueHost()`; this is the same interface, which is why that
 * interface exists.
 */
/**
 * A `CapabilityRecord` in the SDK's camelCase shape, which is what the client
 * hands a caller — the host seam is typed against the SDK, not the wire.
 */
function capabilityRecord(rows) {
  return {
    backendKind: 'cuda-linux',
    totalBytes: 25_769_803_776,
    desktopAllowanceBytes: 2_147_483_648,
    classes: rows.map((r) => ({
      capability: r.capability,
      enabled: r.enabled,
      selected: r.selected,
      reason: r.reason || (r.enabled ? 'selected' : 'the smallest candidate does not fit'),
      shortfallBytes: r.shortfallBytes || 0,
    })),
  };
}

function scriptedHost(over) {
  return Object.assign({
    view: () => ({
      ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
      newJobsWaitFor: 'top-ranked',
      unknown: [],
    }),
    enabled: () => [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
    ping: async () => ({ outcome: 'ok', message: 'ok' }),
    server: (name) => ({ name, url: `http://127.0.0.1:7100`, token: TOKEN, source: 'local' }),
    models: async () => [
      { id: 'qwen3.5-9b', resident: true, loadable: true },
      { id: 'qwen3.8-27b-4bit', resident: true, loadable: true },
      { id: 'dots-ocr', resident: false, loadable: true },
    ],
    loadModel: async () => { throw new Error('loadModel must not be called unless loadFirst'); },
    // `capability` replaced `modelFor` on 2026-09-14: the per-class model is
    // `GET /v1/capability`'s answer, not a record this app keeps. The DECISION
    // is pure (`modelFromCapability`), which is why all three of its refusals
    // are drivable below with no server at all.
    capability: async () => capabilityRecord([
      { capability: 'clean', enabled: true, selected: 'qwen3.5-9b' },
      { capability: 'translate', enabled: true, selected: 'qwen3.8-27b-4bit' },
      { capability: 'simplify', enabled: true, selected: 'qwen3.8-27b-4bit' },
      { capability: 'analysis', enabled: true, selected: 'qwen3.8-27b-4bit' },
    ]),
  }, over || {});
}

async function main() {
  console.log('\nThe four text acts, and the credential that must not leak\n');

  // ── 1. The four acts, named as CRUCIBLE names them ─────────────────────────
  //
  // Read out of crucible's own capability.py when the checkout is here, rather
  // than trusted: a fifth class, or a renamed one, must surface as a failure in
  // this repo and not as a `400 unknown_act` in the middle of a book.
  await check('the four acts are crucible\'s own capability class names', () => {
    assert.deepStrictEqual(
      [...acts.CRUCIBLE_TEXT_ACTS], ['clean', 'translate', 'simplify', 'analysis']);
    assert.deepStrictEqual(
      [...wire.CRUCIBLE_TEXT_ACT_NAMES], [...acts.CRUCIBLE_TEXT_ACTS],
      'the renderer\'s spelling and the main process\'s must agree — one fact, two copies');

    const capability = path.join(
      path.dirname(REPO), 'crucible', 'crucible', 'capability.py');
    if (!fs.existsSync(capability)) {
      console.log('      (crucible checkout not here — the cross-repo half of this check is skipped)');
      return;
    }
    const source = fs.readFileSync(capability, 'utf8');
    for (const act of acts.CRUCIBLE_TEXT_ACTS) {
      assert.ok(
        new RegExp(`name="${act}"`).test(source),
        `crucible/capability.py has no capability class named "${act}" — if it was renamed, `
        + 'every request naming the old one is refused 400 unknown_act');
    }
  });

  // ── 2. The header map ──────────────────────────────────────────────────────
  await check('the header map carries the bearer, the api version and THIS act', () => {
    const map = acts.endpointHeaderMap(TOKEN, 'simplify');
    assert.strictEqual(map.Authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(map['X-Crucible-Api'], '1');
    assert.strictEqual(map['X-Crucible-Act'], 'simplify');
  });

  await check('a simplify NEVER says translate, and the four differ', () => {
    const said = acts.CRUCIBLE_TEXT_ACTS.map(
      (act) => acts.endpointHeaderMap(TOKEN, act)['X-Crucible-Act']);
    assert.deepStrictEqual(said, [...acts.CRUCIBLE_TEXT_ACTS]);
    assert.strictEqual(new Set(said).size, 4, 'two acts share a name on the wire');
  });

  await check('the masked render cannot print the token', () => {
    const shown = acts.maskEndpointHeaders(acts.endpointHeaderMap(TOKEN, 'clean'));
    assert.ok(!shown.includes(TOKEN), `the masked header map still contains the token: ${shown}`);
    assert.ok(shown.includes('****'), shown);
    assert.ok(shown.includes('"X-Crucible-Act":"clean"'), shown);
  });

  await check('an empty token is refused rather than sent as an empty bearer', () => {
    assert.throws(() => acts.endpointHeaderMap('', 'clean'), /crucible_empty_token/);
  });

  // ── 3. The endpoint ────────────────────────────────────────────────────────
  /*
   * THE BASE, AND THE ONE SEGMENT THAT WAS WRONG.
   *
   * An OpenAI client is handed a BASE and composes `<base>/v1/models`
   * itself (foundry's `normaliseVllmEndpoint`). Crucible `a97ef70` mounts
   * its OpenAI door at `/openai/v1/...` for exactly that, so the base is
   * `<url>/openai` — `<url>/v1/openai` produced `/v1/openai/v1/models` and
   * a 404 against a door that existed. Asserted through the path a client
   * actually requests, not just the base, because the base alone is what
   * looked right before.
   */
  await check('the base is what an OpenAI client composes the real path from', () => {
    assert.strictEqual(acts.CRUCIBLE_OPENAI_BASE_PATH, '/openai');
    assert.strictEqual(acts.crucibleChatBase('http://127.0.0.1:7100'),
      'http://127.0.0.1:7100/openai');
    assert.strictEqual(acts.crucibleChatBase('http://mac:7100/'),
      'http://mac:7100/openai');
    // What foundry then asks for, by its own rule: append /v1 unless the
    // last segment already is a version.
    const base = acts.crucibleChatBase('http://127.0.0.1:7100');
    const composed = /\/v\d+$/.test(base) ? base : `${base}/v1`;
    assert.strictEqual(composed, 'http://127.0.0.1:7100/openai/v1');
  });

  // ── 4. The composed answer, and what lands on the argv ─────────────────────
  let engine = null;
  await check('a resident model composes endpoint, model, act and the env overlay', async () => {
    engine = await venue.resolveCrucibleTextEngine(
      'clean', 'local', scriptedHost(), { headerReach: 'spawn' });
    assert.strictEqual(engine.endpoint, 'http://127.0.0.1:7100/openai');
    assert.strictEqual(engine.model, 'qwen3.5-9b');
    assert.strictEqual(engine.act, 'clean');
    assert.deepStrictEqual(Object.keys(engine.env), ['FOUNDRY_ENDPOINT_HEADERS']);
    const map = JSON.parse(engine.env.FOUNDRY_ENDPOINT_HEADERS);
    assert.strictEqual(map['X-Crucible-Act'], 'clean');
    assert.strictEqual(map.Authorization, `Bearer ${TOKEN}`);
  });

  await check('the spawn argv carries --endpoint and --model, and NOT the token', () => {
    const argv = cleanText.cleanTextArgs(
      'C:/books/in.epub', 'C:/books/out.epub',
      { model: 'qwen3.5:9b-q8_0', endpoint: 'http://localhost:11434', keepWarmMinutes: 0, source: 'x' },
      { endpoint: engine.endpoint, model: engine.model });
    const line = argv.join(' ');
    assert.ok(line.includes('--endpoint http://127.0.0.1:7100/openai'), line);
    assert.ok(line.includes('--model qwen3.5-9b'), line);
    assert.ok(!line.includes(TOKEN), `the token reached the command line: ${line}`);
    assert.ok(!/FOUNDRY_ENDPOINT_HEADERS/.test(line), line);
    // The local Ollama tag must not survive onto a Crucible line: a run named
    // against weights that did not do it is worse than a run that did not start.
    assert.ok(!line.includes('qwen3.5:9b-q8_0'), line);
    assert.ok(!line.includes('localhost:11434'), line);
  });

  await check('the token is in NOTHING a log can print', () => {
    const printable = [engine.maskedHeaders, engine.endpoint, engine.model, engine.act, engine.server];
    for (const value of printable) {
      assert.ok(!String(value).includes(TOKEN), `the token is in a printable field: ${value}`);
    }
  });

  // ── 5. Residency, checked by name BEFORE anything spawns ───────────────────
  await check('a model that is not resident refuses by name, and never loads it', async () => {
    let loaded = false;
    const host = scriptedHost({
      models: async () => [
        { id: 'qwen3.5-9b', resident: false, loadable: true },
        { id: 'qwen3.8-27b-4bit', resident: true, loadable: true },
      ],
      loadModel: async () => { loaded = true; },
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('clean', 'local', host, { headerReach: 'spawn' }),
      (err) => {
        assert.strictEqual(err.code, 'crucible_model_not_resident');
        assert.ok(err.message.includes('qwen3.5-9b'), err.message);
        assert.ok(err.message.includes('clean'), err.message);
        assert.ok(err.message.includes('local'), err.message);
        // It must say what IS resident: "nothing is resident" and "the wrong
        // one is" are different problems with different fixes.
        assert.ok(err.message.includes('qwen3.8-27b-4bit'), err.message);
        return true;
      });
    assert.strictEqual(loaded, false, 'a text act loaded a model on somebody\'s card');
  });

  await check('a model the server has never heard of refuses as UNKNOWN, not as absent', async () => {
    // The record and the model list DISAGREE on that server: capability names
    // an id `GET /v1/models` does not advertise. That is a fact about the
    // server, reported rather than worked around.
    const host = scriptedHost({
      capability: async () => capabilityRecord([
        { capability: 'translate', enabled: true, selected: 'llama9000' },
      ]),
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('translate', 'mac', host, { headerReach: 'spawn' }),
      (err) => {
        assert.strictEqual(err.code, 'crucible_unknown_model');
        assert.ok(err.message.includes('llama9000'), err.message);
        return true;
      });
  });

  /*
   * THE THREE WAYS A CAPABILITY RECORD CAN FAIL TO NAME A MODEL, and they are
   * three different pieces of news (2026-09-14). This replaced one check
   * against `crucible_text_model_not_set`, which was a refusal about a record
   * THIS APP kept; the record is deleted and the server owns the mapping,
   * because `crucible install` measured the card to make it.
   */
  await check('a class the server has never measured refuses `undecided`, not `off`', async () => {
    const host = scriptedHost({
      capability: async () => capabilityRecord([
        { capability: 'clean', enabled: true, selected: 'qwen3.5-9b' },
      ]),
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('analysis', 'local', host, { headerReach: 'spawn' }),
      (err) => {
        assert.strictEqual(err.code, 'crucible_capability_undecided');
        assert.ok(err.message.includes('analysis'), err.message);
        // "Undecided" is deliberately different news from "nothing": it says
        // the card has never been measured, and names what measures it.
        assert.ok(/capability --write/.test(err.message), err.message);
        return true;
      });
  });

  await check('a class the server turned OFF refuses with its own reason and shortfall', async () => {
    const host = scriptedHost({
      capability: async () => capabilityRecord([{
        capability: 'translate',
        enabled: false,
        selected: '',
        reason: 'the smallest candidate does not fit',
        shortfallBytes: 8_589_934_592,
      }]),
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('translate', 'local', host, { headerReach: 'spawn' }),
      (err) => {
        assert.strictEqual(err.code, 'crucible_capability_disabled');
        // The SERVER's own sentence, AND the number that turned the class off:
        // a reason is never load-bearing on its own (ARCHITECTURE.md R4).
        assert.ok(err.message.includes('the smallest candidate does not fit'), err.message);
        assert.ok(err.message.includes('8.0 GB'), err.message);
        return true;
      });
  });

  await check('a row that says enabled and names nothing is REPORTED, not repaired', async () => {
    const host = scriptedHost({
      capability: async () => capabilityRecord([
        { capability: 'simplify', enabled: true, selected: '' },
      ]),
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('simplify', 'local', host, { headerReach: 'spawn' }),
      (err) => {
        assert.strictEqual(err.code, 'crucible_capability_no_model');
        return true;
      });
  });

  await check('the explicit load door is called ONLY with loadFirst', async () => {
    const calls = [];
    const host = scriptedHost({ loadModel: async (s, m) => { calls.push([s, m]); } });
    await venue.resolveCrucibleTextEngine('simplify', 'mac', host, { headerReach: 'spawn' });
    assert.deepStrictEqual(calls, [], 'a plain run asked the server to load a model');
    await venue.resolveCrucibleTextEngine(
      'simplify', 'mac', host, { headerReach: 'spawn', loadFirst: true });
    assert.deepStrictEqual(calls, [['mac', 'qwen3.8-27b-4bit']]);
  });

  // ── 6. A 409 is a WAIT, and it names the holder ────────────────────────────
  await check('409 server_busy surfaces with the holder\'s busyLine', async () => {
    const { CrucibleBusy } = require(path.join(REPO, 'node_modules', '@crucible', 'client'));
    const busy = new CrucibleBusy(409, 'server_busy', 'one job at a time', {}, {
      holder: 'foundry',
      jobId: 'job-7',
      jobType: 'tts',
      model: 'mistborn',
      jobStatus: 'running',
      since: '2026-09-13T22:00:00Z',
      progress: 0.62,
      jobMessage: 'chunk 400/650',
    });
    const named = venue.describeTextActRefusal(busy, 'mac', 'simplify');
    assert.strictEqual(named.code, 'crucible_server_busy');
    assert.ok(typeof named.busyLine === 'string' && named.busyLine.length > 0, named.busyLine);
    assert.ok(named.busyLine.includes('foundry'), named.busyLine);
    assert.ok(named.message.includes('simplify'), named.message);
    assert.ok(named.message.includes('job-7'), named.message);
  });

  await check('engine_in_use surfaces as busy too, in the server\'s own words', () => {
    const { CrucibleRefused } = require(path.join(REPO, 'node_modules', '@crucible', 'client'));
    const held = new CrucibleRefused(
      409, 'engine_in_use', "the resident engine is held by 'listen'", {});
    const named = venue.describeTextActRefusal(held, 'local', 'clean');
    assert.strictEqual(named.code, 'crucible_server_busy');
    assert.ok(named.message.includes('listen'), named.message);
  });

  // ── 7. Who may run it at all: the reach into the spawn's environment ──────
  await check('a caller with NO reach into the environment is refused by name', async () => {
    let asked = false;
    const host = scriptedHost({ models: async () => { asked = true; return []; } });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('translate', 'mac', host, { headerReach: 'none' }),
      (err) => {
        assert.strictEqual(err.code, 'hosted_placement_not_vendored');
        // Named for the CAPABILITY it waits on, never for a version number:
        // the blocker is the state of the vendored subtree, and a floor that
        // went green on a release would be a guard passing without its
        // subject. REWRITTEN 2026-09-14: the sentence used to blame the
        // `env: process.env` in their engine spawn, which foundry had already
        // fixed (`f300fc6`) while this guard went on quoting it. The live gap
        // is that the job seam BookForge calls carries no environment and the
        // vendored dispatcher cannot compose one hosted;
        // `tools/test-foundry-hosted-crucible-seam.js` reads the subtree so
        // that cannot go stale unnoticed again.
        assert.ok(err.message.includes('runJob'), err.message);
        assert.ok(err.message.includes('e096734'), err.message);
        assert.ok(err.message.includes('FOUNDRY_ENDPOINT_HEADERS'), err.message);
        assert.ok(!err.message.includes('env: process.env'),
          'the refusal blames the spawn foundry fixed at f300fc6: ' + err.message);
        assert.ok(!/\b1\.3\.0\b/.test(err.message),
          `the refusal blames a version rather than the capability:\n${err.message}`);
        // And it says what DOES work: a refusal with no way forward is what
        // the no-band-aids rule is about.
        assert.ok(err.message.includes('CLI clean routes'), err.message);
        // What it says the HOSTED window can do INSTEAD changed on 2026-09-15:
        // the local text engines it used to fall to are deleted
        // (docs/LEGACY-REMOVAL.md), so the honest sentence is that it has no
        // other route until the re-vendor — not "turn the switch on".
        assert.ok(/no other route/.test(err.message), err.message);
        assert.ok(!/turn on|legacy switch/i.test(err.message),
          `it still offers a switch that no longer exists: ${err.message}`);
        return true;
      });
    assert.strictEqual(asked, false, 'the server was asked for its models after the reach said no');
  });

  await check('an own spawn and a single-purpose process may both run one', async () => {
    for (const headerReach of ['spawn', 'process']) {
      const composed = await venue.resolveCrucibleTextEngine(
        'translate', 'mac', scriptedHost(), { headerReach });
      assert.strictEqual(composed.model, 'qwen3.8-27b-4bit', headerReach);
      assert.strictEqual(composed.endpoint, 'http://127.0.0.1:7100/openai', headerReach);
      assert.strictEqual(
        JSON.parse(composed.env.FOUNDRY_ENDPOINT_HEADERS)['X-Crucible-Act'], 'translate');
    }
  });

  // ── 8. The venue: one record, no silent local run ──────────────────────────
  await check('the caller\'s named server wins, unconditionally', async () => {
    const where = await venue.decideWhereTextActRuns('mac', scriptedHost({
      view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }),
    }));
    assert.deepStrictEqual(where, { where: 'crucible', server: 'mac', because: 'the caller named it' });
  });

  await check('with nothing enabled there is NO local engine to fall to — it refuses by name',
    async () => {
      /*
       * THIS CHECK USED TO DRIVE THE LEGACY SWITCH and assert it reached the
       * local text engines. That switch and the llama-server arm behind it are
       * DELETED (docs/LEGACY-REMOVAL.md; ROLLOUT_PLAN §A2 names the local text
       * engines as part of that layer), so the branch it pinned is now the one
       * outcome that must be impossible: quietly starting llama-server would
       * take a card somebody else is using, clean a book with a model nobody
       * chose, and report success.
       */
      await assert.rejects(
        () => venue.decideWhereTextActRuns(undefined, scriptedHost({
          view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }),
          enabled: () => {
            // routing.ts's OWN refusal, which is what the real host throws.
            const err = new Error('no Crucible server is available to the queue');
            err.name = 'CrucibleRoutingError';
            err.code = 'no_enabled_server';
            throw err;
          },
        })),
        (err) => {
          assert.strictEqual(err.code, 'no_enabled_server');
          return true;
        });
      // And a record left over from that era cannot re-open the door: the key is
      // not read, so it has no effect on where a text act goes.
      const stale = await venue.decideWhereTextActRuns(undefined, scriptedHost({
        view: () => ({
          ranked: [{ name: 'local', enabled: true }],
          newJobsWaitFor: 'top-ranked',
          unknown: [],
          legacyLocalRender: true,
        }),
        enabled: () => [{ name: 'local', enabled: true }],
      }));
      assert.deepStrictEqual(stale,
        { where: 'crucible', server: 'local', because: 'the top-ranked server' },
        'a leftover legacyLocalRender changes nothing — it is not read');
    });

  await check('top-ranked is taken WITHOUT a ping — a named machine is an instruction', async () => {
    let pinged = 0;
    const where = await venue.decideWhereTextActRuns(undefined, scriptedHost({
      ping: async () => { pinged += 1; return { outcome: 'unreachable', message: 'no' }; },
    }));
    assert.deepStrictEqual(where,
      { where: 'crucible', server: 'local', because: 'the top-ranked server' });
    assert.strictEqual(pinged, 0);
  });

  await check('"any" takes the first that answers, in rank order', async () => {
    const where = await venue.decideWhereTextActRuns(undefined, scriptedHost({
      view: () => ({
        ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
        newJobsWaitFor: 'any',
        unknown: [],
      }),
      ping: async (name) => (name === 'mac'
        ? { outcome: 'ok', message: 'ok' }
        : { outcome: 'unreachable', message: 'nothing answered' }),
    }));
    assert.deepStrictEqual(where,
      { where: 'crucible', server: 'mac', because: 'any: the first that answered' });
  });

  await check('"any" with nothing reachable FAILS, naming each one tried', async () => {
    await assert.rejects(
      () => venue.decideWhereTextActRuns(undefined, scriptedHost({
        view: () => ({
          ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
          newJobsWaitFor: 'any',
          unknown: [],
        }),
        ping: async (name) => ({ outcome: 'unreachable', message: `${name} said nothing` }),
      })),
      (err) => {
        assert.strictEqual(err.code, 'no_reachable_server');
        assert.ok(err.message.includes('local'), err.message);
        assert.ok(err.message.includes('mac'), err.message);
        // NO FALLBACK: the refusal must say outright that there is nowhere else,
        // rather than leaving a reader to hunt for a switch that would run it here.
        assert.ok(err.message.includes('no local text engines to fall back to'), err.message);
        return true;
      });
  });

  await check('a caller that meant to name a server and did not is refused', async () => {
    await assert.rejects(
      () => venue.decideWhereTextActRuns('   ', scriptedHost()),
      (err) => {
        assert.strictEqual(err.code, 'crucible_server_not_named');
        return true;
      });
  });

  // ── 9. The LOCAL argv, which belongs to Foundry's own engine door ──────────
  //
  // Not the legacy text-act arm — that is gone. `runFoundry` still spawns an
  // engine for the acts Foundry itself drives, and this is that argv.
  await check('the LOCAL argv is exactly what it was — settings endpoint, tag, no --model on empty', () => {
    const settings = {
      model: 'qwen3.5:9b-q8_0', endpoint: 'http://localhost:11434', keepWarmMinutes: 0, source: 'x',
    };
    assert.deepStrictEqual(
      cleanText.cleanTextArgs('in.epub', 'out.epub', settings),
      ['clean-text', '--epub', 'in.epub', '--out', 'out.epub',
        '--endpoint', 'http://localhost:11434', '--model', 'qwen3.5:9b-q8_0']);
    assert.deepStrictEqual(
      cleanText.cleanTextArgs('in.epub', 'out.epub', { ...settings, model: '' }),
      ['clean-text', '--epub', 'in.epub', '--out', 'out.epub',
        '--endpoint', 'http://localhost:11434']);
  });

  // ── 10. The hosted credential window, and the one thing it must not do ─────
  await check('the process window sets the variable, then removes it', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    let insideValue = null;
    await acts.withProcessEndpointHeaders(engine.env, 'clean a book', async () => {
      insideValue = process.env.FOUNDRY_ENDPOINT_HEADERS;
    });
    assert.strictEqual(insideValue, engine.env.FOUNDRY_ENDPOINT_HEADERS);
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined,
      'the credential outlived the act it belonged to');
  });

  await check('a THROWN act still removes the variable', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    await assert.rejects(() => acts.withProcessEndpointHeaders(
      engine.env, 'clean a book', async () => { throw new Error('the engine died'); }));
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined);
  });

  await check('two acts cannot share the window — one would wear the other\'s act name', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    await acts.withProcessEndpointHeaders(engine.env, 'clean a book', async () => {
      await assert.rejects(
        () => acts.withProcessEndpointHeaders(
          acts.endpointHeadersEnv(TOKEN, 'simplify'), 'simplify another', async () => {}),
        /crucible_process_headers_busy[\s\S]*clean a book/);
    });
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined);
  });

  await check('stripEndpointHeaders removes the map and nothing else', () => {
    const env = { PATH: '/bin', FOUNDRY_ENDPOINT_HEADERS: '{"a":"b"}', FOUNDRY_BIN: 'x' };
    assert.deepStrictEqual(acts.stripEndpointHeaders(env), { PATH: '/bin', FOUNDRY_BIN: 'x' });
  });

  /*
   * ── 11. THE PER-ACT RECORD IS GONE, and so are its two checks ─────────────
   *
   * They drove `TextModels` over a temp file: a round-trip, a cleared entry
   * that did not become a default, an unknown act refused, and a corrupt file
   * REFUSED rather than replaced. All of it was correct about a record this
   * app no longer keeps — `<userData>/crucible-models.json` is deleted and
   * `GET /v1/capability` owns the act-to-model mapping, because `crucible
   * install` probed the card to make it (Owen's ruling with Foundry,
   * docs/CRUCIBLE_ROLLOUT_PLAN.md section 3).
   *
   * What replaced them is the three capability refusals above, which is the
   * same property in the place that now holds it: an act whose model nobody
   * has named fails BY NAME, before any spawn, and nothing invents an id.
   */

  // ── 12. A real request, so the header map is proved on the WIRE ────────────
  //
  // Everything above proves what BookForge composes. This proves a server
  // receiving it sees the three headers — because a map that is right in a
  // JSON blob and wrong on the wire is the defect a unit check cannot see.
  await check('the three headers arrive on a real request', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const map = acts.endpointHeaderMap(TOKEN, 'analysis');
      await new Promise((resolve, reject) => {
        const req = http.request(
          // The path foundry composes from the base this app hands it:
          // `<base>/v1/models` where base is `<url>/openai`.
          { host: '127.0.0.1', port, path: '/openai/v1/models', headers: map },
          (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end();
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(seen[0]['x-crucible-api'], '1');
    assert.strictEqual(seen[0]['x-crucible-act'], 'analysis');
  });

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(', ')}`);
  }
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
