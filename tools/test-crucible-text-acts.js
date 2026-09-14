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
const textModels = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-models.js'));
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
function scriptedHost(over) {
  return Object.assign({
    view: () => ({
      ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
      newJobsWaitFor: 'top-ranked',
      unknown: [],
      legacyLocalRender: false,
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
    modelFor: (act) => (act === 'clean' ? 'qwen3.5-9b' : 'qwen3.8-27b-4bit'),
    // The floor is on a version that does not exist yet (see
    // FOUNDRY_VERSION_FOR_CRUCIBLE_TEXT), so every happy-path check has to say
    // it is running an engine that carries both fixes. That is the point of the
    // gate, and check 7 drives the other side of it.
    engineVersion: async () => '9.9.9',
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
  await check('the endpoint is the server\'s own OpenAI door', () => {
    assert.strictEqual(acts.crucibleChatBase('http://127.0.0.1:7100'),
      'http://127.0.0.1:7100/v1/openai');
    assert.strictEqual(acts.crucibleChatBase('http://mac:7100/'),
      'http://mac:7100/v1/openai');
  });

  // ── 4. The composed answer, and what lands on the argv ─────────────────────
  let engine = null;
  await check('a resident model composes endpoint, model, act and the env overlay', async () => {
    engine = await venue.resolveCrucibleTextEngine('clean', 'local', scriptedHost());
    assert.strictEqual(engine.endpoint, 'http://127.0.0.1:7100/v1/openai');
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
    assert.ok(line.includes('--endpoint http://127.0.0.1:7100/v1/openai'), line);
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
      () => venue.resolveCrucibleTextEngine('clean', 'local', host),
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
    const host = scriptedHost({ modelFor: () => 'llama9000' });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('translate', 'mac', host),
      (err) => {
        assert.strictEqual(err.code, 'crucible_unknown_model');
        assert.ok(err.message.includes('llama9000'), err.message);
        return true;
      });
  });

  await check('an act with no model chosen refuses by name and asks for the picker', async () => {
    const host = scriptedHost({
      modelFor: (act) => textModels.textModelFor(act),  // the real record: empty here
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('analysis', 'local', host),
      (err) => {
        assert.strictEqual(err.code, 'crucible_text_model_not_set');
        assert.ok(err.message.includes('analysis'), err.message);
        assert.ok(/Settings . AI . Crucible/.test(err.message), err.message);
        return true;
      });
  });

  await check('the explicit load door is called ONLY with loadFirst', async () => {
    const calls = [];
    const host = scriptedHost({ loadModel: async (s, m) => { calls.push([s, m]); } });
    await venue.resolveCrucibleTextEngine('simplify', 'mac', host);
    assert.deepStrictEqual(calls, [], 'a plain run asked the server to load a model');
    await venue.resolveCrucibleTextEngine('simplify', 'mac', host, { loadFirst: true });
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

  // ── 7. The engine gate, which is why nothing runs tonight ──────────────────
  await check('an engine that cannot address a Crucible refuses before any spawn', async () => {
    let asked = false;
    const host = scriptedHost({
      engineVersion: async () => '1.3.0',
      models: async () => { asked = true; return []; },
    });
    await assert.rejects(
      () => venue.resolveCrucibleTextEngine('translate', 'mac', host),
      (err) => {
        assert.strictEqual(err.code, 'foundry_engine_cannot_reach_crucible');
        assert.ok(err.message.includes('1.3.0'), err.message);
        assert.ok(err.message.includes('normaliseVllmEndpoint'), err.message);
        assert.ok(err.message.includes('FOUNDRY_ENDPOINT_HEADERS'), err.message);
        // The one switch, named where a person meets the refusal.
        assert.ok(err.message.includes('local engines'), err.message);
        return true;
      });
    assert.strictEqual(asked, false, 'the server was asked for its models after the gate said no');
  });

  // ── 8. The venue: one record, one switch, no silent local run ──────────────
  await check('the caller\'s named server wins, unconditionally', async () => {
    const where = await venue.decideWhereTextActRuns('mac', scriptedHost({
      view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [], legacyLocalRender: true }),
    }));
    assert.deepStrictEqual(where, { where: 'crucible', server: 'mac', because: 'the caller named it' });
  });

  await check('the legacy switch routes to the LOCAL ENGINES and says which', async () => {
    const where = await venue.decideWhereTextActRuns(undefined, scriptedHost({
      view: () => ({
        ranked: [{ name: 'local', enabled: true }],
        newJobsWaitFor: 'top-ranked',
        unknown: [],
        legacyLocalRender: true,
      }),
    }));
    assert.strictEqual(where.where, 'legacy-local-engines');
    assert.strictEqual(where.because, 'the legacy local-engine switch is on');
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
        legacyLocalRender: false,
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
          legacyLocalRender: false,
        }),
        ping: async (name) => ({ outcome: 'unreachable', message: `${name} said nothing` }),
      })),
      (err) => {
        assert.strictEqual(err.code, 'no_reachable_server');
        assert.ok(err.message.includes('local'), err.message);
        assert.ok(err.message.includes('mac'), err.message);
        // NO FALLBACK: the refusal must not read as "so it ran here".
        assert.ok(err.message.includes('local engines'), err.message);
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

  // ── 9. The local path is untouched when the switch is on ───────────────────
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
  await check('the hosted window sets the variable, then removes it', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    let insideValue = null;
    await acts.withHostedEndpointHeaders(engine.env, 'clean a book', async () => {
      insideValue = process.env.FOUNDRY_ENDPOINT_HEADERS;
    });
    assert.strictEqual(insideValue, engine.env.FOUNDRY_ENDPOINT_HEADERS);
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined,
      'the credential outlived the act it belonged to');
  });

  await check('a THROWN act still removes the variable', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    await assert.rejects(() => acts.withHostedEndpointHeaders(
      engine.env, 'clean a book', async () => { throw new Error('the engine died'); }));
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined);
  });

  await check('two acts cannot share the window — one would wear the other\'s act name', async () => {
    delete process.env.FOUNDRY_ENDPOINT_HEADERS;
    await acts.withHostedEndpointHeaders(engine.env, 'clean a book', async () => {
      await assert.rejects(
        () => acts.withHostedEndpointHeaders(
          acts.endpointHeadersEnv(TOKEN, 'simplify'), 'simplify another', async () => {}),
        /crucible_hosted_headers_busy[\s\S]*clean a book/);
    });
    assert.strictEqual(process.env.FOUNDRY_ENDPOINT_HEADERS, undefined);
  });

  await check('stripEndpointHeaders removes the map and nothing else', () => {
    const env = { PATH: '/bin', FOUNDRY_ENDPOINT_HEADERS: '{"a":"b"}', FOUNDRY_BIN: 'x' };
    assert.deepStrictEqual(acts.stripEndpointHeaders(env), { PATH: '/bin', FOUNDRY_BIN: 'x' });
  });

  // ── 11. The record: one act, one id, and no invented default ───────────────
  await check('the per-act record round-trips, and refuses an act it does not know', () => {
    const file = path.join(WORK, 'models.json');
    const store = new textModels.TextModels(file);
    assert.deepStrictEqual(store.read(), {});
    store.set('clean', 'qwen3.5-9b');
    store.set('translate', 'qwen3.8-27b-4bit');
    assert.deepStrictEqual(store.read(), { clean: 'qwen3.5-9b', translate: 'qwen3.8-27b-4bit' });
    assert.strictEqual(store.require('clean'), 'qwen3.5-9b');
    // Cleared, not defaulted.
    store.set('clean', '');
    assert.deepStrictEqual(store.read(), { translate: 'qwen3.8-27b-4bit' });
    assert.throws(() => store.require('clean'), (err) => {
      assert.strictEqual(err.code, 'crucible_text_model_not_set');
      return true;
    });
    assert.throws(() => store.set('rewrite', 'x'), (err) => {
      assert.strictEqual(err.code, 'unknown_act');
      return true;
    });
  });

  await check('a corrupt record is REFUSED, never replaced', () => {
    const file = path.join(WORK, 'broken.json');
    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const store = new textModels.TextModels(file);
    assert.throws(() => store.read(), (err) => {
      assert.strictEqual(err.code, 'corrupt_text_models');
      return true;
    });
    // And the file is still there, byte for byte: a record of somebody's
    // choices is not something this app starts over on.
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ this is not json');
  });

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
          { host: '127.0.0.1', port, path: '/v1/openai/models', headers: map },
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
