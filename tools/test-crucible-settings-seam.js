/**
 * THE ENGINE'S SETTINGS DOCUMENT, AND THE DAY THIS SEAM IS DELETED.
 *
 * crucible `docs/PHASE15-HOST.md` §3.1, §3.2, §3.3, §3.6, §3.8 and §5.1/§5.2.
 *
 * ── CHECK 1 IS THE POINT OF THE WHOLE FILE ─────────────────────────────────
 *
 * `electron/crucible/settings-wire.ts` and `electron/crucible/pairing-file.ts`
 * stand in for four SDK methods and one SDK field that do not exist in the
 * pinned `vendor/crucible-client-0.6.0.tgz`. The first check asserts they still
 * do not. **When it goes red, nothing has regressed** — the SDK landed, and the
 * failure is the instruction to delete the seam and point the callers at
 * `CrucibleClient`. A stopgap whose expiry is written in a comment is a stopgap
 * that outlives its reason; this one has a test.
 *
 * Everything after it is the seam doing its job against a fake server that
 * speaks the wire in the SERVER's own spelling.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, settingsRoutes,
  LLM_CLASSES, WSL_ONLY_CLASSES, WSL_ONLY_REASON,
} = require('./fake-crucible.js');

const SEAM = path.join(REPO, 'dist', 'electron', 'crucible', 'settings-wire.js');
if (!fs.existsSync(SEAM)) {
  console.log('SKIP: dist/electron/crucible/settings-wire.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

installElectronStub('bf-crucible-settings-seam-');

const seam = require(SEAM);
const pairingFile = require(path.join(REPO, 'dist', 'electron', 'crucible', 'pairing-file.js'));
const local = require(path.join(REPO, 'dist', 'electron', 'crucible', 'local.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));

const realGetServer = servers.getServer;
const fakesByName = new Map();
servers.getServer = function getServerWithFakes(name) {
  const fake = fakesByName.get(name);
  if (!fake) return realGetServer(name);
  return { name, url: fake.url, token: 'test-token-abcd', source: 'registry' };
};
let registered = 0;
function nameFake(url) {
  const name = `fake${registered += 1}`;
  fakesByName.set(name, { url });
  return name;
}

const { check, summary } = makeChecker();

/** Run `fn`, expect it to throw, and hand back the error. */
async function refuses(fn, code) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught !== null, `expected a refusal with code ${code}, nothing was thrown`);
  assert.strictEqual(caught.code, code, `expected ${code}, got ${caught.code}: ${caught.message}`);
  return caught;
}

async function withFake(behaviour, fn) {
  const door = settingsRoutes(behaviour);
  const fake = await startFakeCrucible((req, res, ctx) => door.handle(req, res, ctx));
  const name = nameFake(fake.url);
  try {
    await fn({ name, door, fake });
  } finally {
    await fake.close();
  }
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. The expiry
  // ───────────────────────────────────────────────────────────────────────────

  await check('THE SEAM IS STILL NEEDED — @crucible/client has none of the five names', () => {
    const sdkDir = path.join(REPO, 'node_modules', '@crucible', 'client', 'dist', 'esm');
    const clientTypes = fs.readFileSync(path.join(sdkDir, 'client.d.ts'), 'utf-8');
    const indexTypes = fs.readFileSync(path.join(sdkDir, 'index.d.ts'), 'utf-8');
    const types = fs.readFileSync(path.join(sdkDir, 'types.d.ts'), 'utf-8');

    const landed = [];
    for (const name of seam.SDK_SETTINGS_NAMES_AWAITED) {
      // A method on the client, or a bare export from the index. Either is the
      // SDK having grown the name; both spellings are checked because §3.8
      // gives three methods and one free function.
      if (new RegExp(`^\\s{4}${name}\\(`, 'm').test(clientTypes)) landed.push(`CrucibleClient.${name}()`);
      if (new RegExp(`\\b${name}\\b`).test(indexTypes)) landed.push(`index.d.ts exports ${name}`);
    }
    // `CapabilityRow.route` is the fifth: the SDK's own parser drops unknown
    // fields, so the day it declares one is the day `crucibleCapabilityWithRoutes`
    // stops being the only way to read it.
    const row = /export interface CapabilityRow \{[\s\S]*?\n\}/.exec(types);
    assert.ok(row !== null, 'the SDK no longer declares CapabilityRow at all — read it before deleting anything');
    if (/\broute\b/.test(row[0])) landed.push('CapabilityRow.route');

    assert.strictEqual(landed.length, 0,
      'THIS IS NOT A REGRESSION — IT IS THE THING THIS SEAM WAS WAITING FOR.\n'
      + `        @crucible/client now has: ${landed.join(', ')}.\n`
      + '        Do this, in one commit:\n'
      + '          1. delete electron/crucible/settings-wire.ts and pairing-file.ts;\n'
      + '          2. point crucibleEngineSettings / putCrucibleEngineSettings /\n'
      + '             testCrucibleUpstream / readCruciblePairingFile at CrucibleClient\n'
      + '             (servers.ts crucibleClientFor is the one factory);\n'
      + '          3. delete crucibleCapabilityWithRoutes and use client.capability(),\n'
      + '             which now keeps `route`;\n'
      + '          4. delete this check and keep the rest of this file pointed at the SDK.');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. The pairing file (§3.6, §5.1)
  // ───────────────────────────────────────────────────────────────────────────

  const hostWith = (over) => Object.assign({
    platform: 'linux', env: {}, homedir: '/home/t', readFile: () => null,
  }, over);

  await check('the pairing file is where PHASE15 3.6 pins it, on each platform', () => {
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'linux' })),
      path.join('/home/t', '.crucible', 'pairing'));
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'darwin' })),
      path.join('/home/t', '.crucible', 'pairing'));
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({
        platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' },
      })),
      path.join('C:\\Users\\t\\AppData\\Local', 'Crucible', 'pairing'));
  });

  await check('$CRUCIBLE_HOME overrides on every platform; an empty one does not', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      assert.strictEqual(
        pairingFile.cruciblePairingFilePath(hostWith({
          platform, env: { CRUCIBLE_HOME: '/srv/cru', LOCALAPPDATA: 'C:\\L' },
        })),
        path.join('/srv/cru', 'pairing'), platform);
    }
    assert.strictEqual(
      pairingFile.cruciblePairingFilePath(hostWith({ env: { CRUCIBLE_HOME: '' } })),
      path.join('/home/t', '.crucible', 'pairing'));
  });

  await check('Windows with no LOCALAPPDATA is refused by name, never assembled from a username', () => {
    let caught = null;
    try {
      pairingFile.cruciblePairingFilePath(hostWith({ platform: 'win32', env: {} }));
    } catch (err) { caught = err; }
    assert.ok(caught !== null, 'a path was produced out of nothing');
    assert.strictEqual(caught.code, 'no_local_app_data');
  });

  await check('no file is null — a FACT, not a throw and not a retry', () => {
    assert.strictEqual(pairingFile.readCruciblePairingFile(hostWith({})), null);
  });

  await check('a connect code is read and parsed by the SDK parser, with its file named', () => {
    const line = 'crucible://crucible%40owens-pc@127.0.0.1:7100/#tok-abcdefghij\n';
    const got = pairingFile.readCruciblePairingFile(hostWith({ readFile: () => line }));
    assert.strictEqual(got.pairing.name, 'crucible@owens-pc');
    assert.strictEqual(got.pairing.url, 'http://127.0.0.1:7100');
    assert.strictEqual(got.pairing.token, 'tok-abcdefghij');
    assert.strictEqual(got.file, path.join('/home/t', '.crucible', 'pairing'));
  });

  await check('an empty or malformed pairing file is NOT read as "no engine"', () => {
    let caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => '  \n' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_empty');
    caught = null;
    try { pairingFile.readCruciblePairingFile(hostWith({ readFile: () => 'http://127.0.0.1:7100' })); } catch (e) { caught = e; }
    assert.strictEqual(caught && caught.code, 'pairing_file_invalid');
    assert.ok(caught.message.includes('pairing'), 'the refusal names the file');
    assert.ok(!caught.message.includes('tok-'), 'a refusal never carries a token');
  });

  await check('readLocalServer asks the pairing file FIRST, and does not touch WSL when it answers', () => {
    const line = 'crucible://crucible%40owens-pc-wsl@127.0.0.1:7100/#tok-abcdefghij\n';
    const got = local.readLocalServer({
      platform: 'win32',
      env: {},
      homedir: 'C:\\Users\\t',
      wslDistro: 'crucible',
      pairing: hostWith({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, readFile: () => line }),
      runWsl: () => { throw new Error('the WSL door was opened although a connect code was there'); },
    });
    assert.strictEqual(got.via, 'pairing');
    assert.strictEqual(got.name, 'crucible@owens-pc-wsl');
    assert.strictEqual(got.url, 'http://127.0.0.1:7100');
    assert.strictEqual(got.token, 'tok-abcdefghij');
    assert.strictEqual(got.configPath, path.join('C:\\L', 'Crucible', 'pairing'));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Reading the document (§3.1)
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({
    routes: { translate: 'anthropic/claude-sonnet-5' },
    upstreams: { anthropic: { key: 'sk-ant-secret-k3A9' }, ollama: { url: 'http://192.168.68.20:11434' } },
  }, async ({ name, door }) => {
    await check('GET /v1/settings comes back as the document, in the client\'s spelling', async () => {
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(door.settings.reads, 1);
      assert.deepStrictEqual(Object.keys(doc.routes).sort(), LLM_CLASSES.slice().sort());
      assert.deepStrictEqual(doc.routes.translate, { route: 'upstream', model: 'anthropic/claude-sonnet-5' });
      assert.deepStrictEqual(doc.routes.clean, { route: 'local', model: 'qwen3.5-9b' });
      assert.deepStrictEqual(doc.routes.analysis, { route: 'local', model: null });
      assert.strictEqual(doc.desktopAllowanceBytes, 3221225472);
      assert.strictEqual(doc.backendKind, 'cuda-linux');
    });

    await check('a key never crosses — only `configured` and four characters', async () => {
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.upstreams.anthropic.configured, true);
      assert.strictEqual(doc.upstreams.anthropic.keyHint, 'k3A9');
      assert.strictEqual(doc.upstreams.openai.configured, false);
      assert.strictEqual(doc.upstreams.openai.keyHint, null);
      assert.strictEqual(doc.upstreams.ollama.configured, true);
      assert.strictEqual(doc.upstreams.ollama.url, 'http://192.168.68.20:11434');
      assert.ok(!JSON.stringify(doc).includes('sk-ant-secret'), 'the key reached the client');
      for (const served of door.settings.served) {
        assert.ok(!served.includes('sk-ant-secret'), `the server served a key: ${served.slice(0, 80)}`);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Writing through (§3.2, §5.2)
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({}, async ({ name, door }) => {
    await check('ONE PUT configures the upstream AND sets the route, and the answer is re-read', async () => {
      const after = await seam.putCrucibleEngineSettings(name, {
        upstreams: { anthropic: { key: 'sk-ant-0000-wxyz' } },
        routes: { translate: 'anthropic/claude-sonnet-5', simplify: 'anthropic/claude-sonnet-5' },
      });
      assert.strictEqual(door.settings.puts.length, 1);
      assert.deepStrictEqual(door.settings.puts[0].routes,
        { translate: 'anthropic/claude-sonnet-5', simplify: 'anthropic/claude-sonnet-5' });
      // The answer is the WHOLE document after the write — never the patch
      // echoed back, which is what a window would otherwise have to assume.
      assert.strictEqual(after.routes.translate.route, 'upstream');
      assert.strictEqual(after.routes.simplify.model, 'anthropic/claude-sonnet-5');
      assert.strictEqual(after.routes.clean.route, 'local');
      assert.strictEqual(after.upstreams.anthropic.keyHint, 'wxyz');
    });

    await check('routing to an upstream with no key is refused BY NAME with the field', async () => {
      const err = await refuses(
        () => seam.putCrucibleEngineSettings(name, { routes: { clean: 'openai/gpt-5' } }),
        'route_upstream_unconfigured');
      assert.deepStrictEqual(err.details, { field: 'routes.clean' });
    });

    await check('a route that is not an upstream model id, and a class that cannot route', async () => {
      await refuses(() => seam.putCrucibleEngineSettings(name, { routes: { clean: 'qwen3.5-9b' } }), 'route_bad_model');
      await refuses(() => seam.putCrucibleEngineSettings(name, { routes: { tts: 'anthropic/x' } }), 'route_not_routable');
    });

    await check('"local" is a route back, and the document says so', async () => {
      const after = await seam.putCrucibleEngineSettings(name, { routes: { translate: 'local' } });
      assert.deepStrictEqual(after.routes.translate, { route: 'local', model: null });
    });

    await check('an empty patch is refused here rather than read as a successful save', async () => {
      const before = door.settings.puts.length;
      await refuses(() => seam.putCrucibleEngineSettings(name, {}), 'settings_refused');
      assert.strictEqual(door.settings.puts.length, before, 'an empty patch reached the server');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Test before Save (§3.2, §5.2)
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({}, async ({ name, door }) => {
    await check('a key is TESTED without being stored — the list is the upstream\'s own', async () => {
      const got = await seam.testCrucibleUpstream(name, 'anthropic', { key: 'sk-ant-try-this' });
      assert.deepStrictEqual(got.models, ['model-a', 'model-b', 'model-c']);
      assert.deepStrictEqual(door.settings.tests[0], { name: 'anthropic', body: { key: 'sk-ant-try-this' } });
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.upstreams.anthropic.configured, false,
        'a TEST stored the key — then Test-before-Save is a wording, not a fact');
    });

    await check('testing an unconfigured upstream with no probe is refused by name', async () => {
      await refuses(() => seam.testCrucibleUpstream(name, 'openai', {}), 'upstream_unconfigured');
    });
  });

  await withFake({
    refuseTest: () => ({ status: 401, code: 'upstream_rejected', message: 'that key was rejected', details: null }),
  }, async ({ name }) => {
    await check('the upstream\'s own refusal reaches the caller with its own code', async () => {
      const err = await refuses(() => seam.testCrucibleUpstream(name, 'anthropic', { key: 'nope' }), 'upstream_rejected');
      assert.ok(err.message.includes('that key was rejected'), err.message);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Capability keeps its route (§3.3) — the field the SDK's parser drops
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({ routes: { simplify: 'openai/gpt-5' }, upstreams: { openai: { key: 'sk-1234' } } },
    async ({ name }) => {
      await check('every capability row carries a route, and an upstream row says so', async () => {
        const record = await seam.crucibleCapabilityWithRoutes(name);
        const simplify = record.classes.find((c) => c.capability === 'simplify');
        assert.strictEqual(simplify.route, 'upstream');
        assert.strictEqual(simplify.selected, 'openai/gpt-5');
        assert.strictEqual(simplify.enabled, true);
        const clean = record.classes.find((c) => c.capability === 'clean');
        assert.strictEqual(clean.route, 'local');
        assert.strictEqual(clean.selected, 'qwen3.5-9b');
      });
    });

  await withFake({ omitRoute: true }, async ({ name }) => {
    await check('a row with NO route is refused, never assumed local', async () => {
      const err = await refuses(() => seam.crucibleCapabilityWithRoutes(name), 'settings_document_unreadable');
      assert.ok(err.message.includes('route'), err.message);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. llama-windows: Windows IS a backend (AMENDED 2026-09-14, crucible 56cfe37)
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({ backendKind: 'llama-windows' }, async ({ name }) => {
    await check('a llama-windows engine serves the llm classes and pages, and says so', async () => {
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.backendKind, 'llama-windows');
      const record = await seam.crucibleCapabilityWithRoutes(name);
      assert.strictEqual(record.classes.find((c) => c.capability === 'clean').enabled, true);
      assert.strictEqual(record.classes.find((c) => c.capability === 'pages').enabled, true);
    });

    await check('the five WSL-only classes answer false with ONE sentence, shared', async () => {
      const record = await seam.crucibleCapabilityWithRoutes(name);
      const rows = WSL_ONLY_CLASSES.map((c) => record.classes.find((r) => r.capability === c));
      for (const row of rows) {
        assert.ok(row !== undefined, 'a WSL-only class is missing from the record');
        assert.strictEqual(row.enabled, false);
        assert.strictEqual(row.route, 'local');
        assert.strictEqual(row.reason, WSL_ONLY_REASON);
      }
      // One sentence for all five is the whole point (§3.3): it is what lets a
      // screen say it once instead of five times.
      assert.strictEqual(new Set(rows.map((r) => r.reason)).size, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Servers that cannot answer
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({ noSettingsDoor: true }, async ({ name }) => {
    await check('a server with no settings door is named, not read as an empty document', async () => {
      const err = await refuses(() => seam.crucibleEngineSettings(name), 'settings_door_absent');
      assert.ok(err.message.includes('predates'), err.message);
    });
  });

  await check('a server that is not there is settings_unreachable, not a blank screen', async () => {
    fakesByName.set('gone', { url: 'http://127.0.0.1:1' });
    await refuses(() => seam.crucibleEngineSettings('gone'), 'settings_unreachable');
  });

  summary('crucible settings seam');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
