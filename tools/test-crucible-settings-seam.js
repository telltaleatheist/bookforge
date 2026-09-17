/**
 * THE ENGINE SETTINGS DOOR, DRIVEN THROUGH THE REAL SDK AGAINST A FAKE SERVER.
 *
 * crucible `docs/PHASE15-HOST.md` §3.1, §3.2, §3.3, §3.8 and §5.2.
 *
 * ── WHAT THIS SUITE USED TO BE, AND WHAT IT IS NOW ─────────────────────────
 *
 * It was the keeper of a dated seam. `electron/crucible/settings-wire.ts`
 * spoke four SDK methods and one SDK field that the pinned
 * `vendor/crucible-client-0.6.0.tgz` did not have, and this file's first check
 * asserted that it still did not — so that the day the SDK grew them, the
 * failure would be the instruction to delete the seam rather than a regression
 * to be puzzled over. The SDK grew them, the check went red, the seam is gone,
 * and that check went with it: it had one job and it did it.
 *
 * What is left is the door itself, and every call below now goes through the
 * real `CrucibleClient` — `settings()`, `putSettings()`, `testUpstream()`,
 * `capability()` — projected onto this app's IPC shapes by
 * `electron/crucible/engine-settings.ts`. The fake on the other end speaks the
 * wire in the SERVER's own spelling, so what these checks exercise is the
 * SDK's parser and this app's projection meeting over real bytes on a real
 * socket.
 *
 * ── SECTION 4'S TRIPWIRE HAS EXPIRED, AND THAT IS WHAT IT WAS FOR ─────────
 *
 * PHASE15 §3.3 says a capability document in which NO row carries `route`
 * comes from a server that predates the field and reads as all-local. The
 * vendored SDK refused that document instead, which Foundry measured against
 * Owen's live server; BookForge did not work around it — a client that caught
 * the refusal and read "local" out of it would be a second opinion about a
 * document the SDK owns — so the WRONG behaviour was pinned, counted, and
 * carried the instruction to invert the check when the fix landed.
 *
 * It landed with the 0.6.0 re-pack (BookForge `1a1fb892`). The check is
 * inverted: a routeless document now reads as every class local, and the
 * route record the read fills says local too. Because the defect was never
 * worked around, INVERTING THE CHECK WAS THE WHOLE FIX — no BookForge code
 * changed, only a header paragraph in `engine-settings.ts` that called the
 * refusal live.
 *
 * The pairing-file checks that used to sit here have their own suite
 * (`test-crucible-pairing-file.js`): `electron/crucible/pairing-file.ts` did
 * not go with the seam, and a file that outlives the thing it was filed under
 * needs its own keeper rather than a section in somebody else's.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, settingsRoutes,
  LLM_CLASSES, WSL_ONLY_CLASSES, WSL_ONLY_REASON,
} = require('./fake-crucible.js');

const DOOR = path.join(REPO, 'dist', 'electron', 'crucible', 'engine-settings.js');
if (!fs.existsSync(DOOR)) {
  console.log('SKIP: dist/electron/crucible/engine-settings.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

installElectronStub('bf-crucible-settings-seam-');

const seam = require(DOOR);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const { CrucibleClient } = require('@crucible/client');

/*
 * A FAKE IS NAMED THROUGH THE ONE FACTORY THE DOOR USES.
 *
 * All four calls build a client through `crucibleClientFor` — the settings
 * three, and since the phase-15 SDK the capability read as well, which used to
 * reach a server by its registry entry and its own `fetch`. `addServer`
 * refuses loopback URLs on purpose (the local server has one owner, its own
 * config.toml), so a fake is reached by patching that one function rather than
 * by weakening the registry, and every byte still crosses a real socket to the
 * real fake.
 */
const realClientFor = servers.crucibleClientFor;
const fakesByName = new Map();
servers.crucibleClientFor = function crucibleClientForWithFakes(name, clientName) {
  const fake = fakesByName.get(name);
  if (!fake) return realClientFor(name, clientName);
  return new CrucibleClient({ url: fake.url, token: 'test-token-abcd', clientName });
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
  // 1. Reading the document (§3.1)
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // MODEL ASSIGNMENT (`local_models` / `local_model_choices`), and its vintage
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Owen's Ollama ruling (2026-09-16) puts every Crucible configuration in the
  // apps, model assignment included. The engine computes what may serve each
  // capability class; this app draws it and writes a choice back.

  await withFake({}, async ({ name }) => {
    await check('both maps come through, and a null selection is a decision not an absence', async () => {
      const doc = await seam.crucibleEngineSettings(name);
      assert.ok(doc.localModels !== null, 'a server that sent both maps read as a vintage');
      assert.strictEqual(doc.localModels.selected.clean, 'qwen3.5-9b');
      // NOT undefined, and not dropped: null is "the engine decides".
      assert.ok('analysis' in doc.localModels.selected, 'a null selection was dropped');
      assert.strictEqual(doc.localModels.selected.analysis, null);
      const rows = doc.localModels.choices.clean;
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(rows[0], {
        id: 'qwen3.5-9b', memoryBytesEstimate: 20950548480, fits: true, installed: true,
      });
      assert.strictEqual(rows[1].fits, false);
    });
  });

  await withFake({ localModels: 'absent' }, async ({ name }) => {
    await check('a server older than model assignment reads as a VINTAGE, not as a refusal', async () => {
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.localModels, null,
        'neither map present must read as "this server predates model assignment"');
      // The rest of the document is still readable: a vintage disables one
      // panel, it does not make the server unreadable.
      assert.strictEqual(doc.backendKind, 'cuda-linux');
      assert.strictEqual(doc.routes.clean.route, 'local');
    });
  });

  for (const shape of ['selected-only', 'choices-only']) {
    await withFake({ localModels: shape }, async ({ name }) => {
      await check(`a PARTIAL document (${shape}) is refused by name, never read as either`, async () => {
        const err = await refuses(
          () => seam.crucibleEngineSettings(name),
          'settings_document_unreadable',
        );
        assert.match(err.message, /sends NEITHER/,
          'the refusal must say what a vintage looks like, so the two are told apart');
      });
    });
  }

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
      assert.strictEqual(doc.upstreams.anthropic.keyHint, '\u2026k3A9',
        'the hint is rendered verbatim, leading ellipsis and all');
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
  // 2. Writing through (§3.2, §5.2)
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
      assert.strictEqual(after.upstreams.anthropic.keyHint, '\u2026wxyz');
    });

    await check('routing to an upstream with no key is refused BY NAME with the field', async () => {
      const err = await refuses(
        () => seam.putCrucibleEngineSettings(name, { routes: { clean: 'openai/gpt-5' } }),
        'route_upstream_unconfigured');
      // A DOTTED PATH naming the control the refusal is about (crucible
      // c5482ff), so a panel can put the sentence beside the field rather
      // than at the top of the page.
      assert.deepStrictEqual(err.details, { field: 'upstreams.openai.key' });
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
  // 3. Test before Save (§3.2, §5.2)
  // ───────────────────────────────────────────────────────────────────────────

  await withFake({}, async ({ name, door }) => {
    await check('a key is TESTED without being stored — the list is the upstream\'s own', async () => {
      const got = await seam.testCrucibleUpstream(name, 'anthropic', { key: 'sk-ant-try-this' });
      assert.strictEqual(got.ok, true);
      assert.deepStrictEqual(got.models, ['model-a', 'model-b', 'model-c']);
      assert.deepStrictEqual(door.settings.tests[0], { name: 'anthropic', body: { key: 'sk-ant-try-this' } });
      const doc = await seam.crucibleEngineSettings(name);
      assert.strictEqual(doc.upstreams.anthropic.configured, false,
        'a TEST stored the key — then Test-before-Save is a wording, not a fact');
    });

    await check('a test ANSWERS its refusal rather than throwing it', async () => {
      // §3.8's shape, matched so the vendored `testUpstream()` is a drop-in:
      // "that key was rejected" is the ordinary outcome of pressing Test and
      // belongs beside the field, not in a catch block.
      const got = await seam.testCrucibleUpstream(name, 'openai', {});
      assert.strictEqual(got.ok, false);
      assert.strictEqual(got.refusal.code, 'upstream_unconfigured');
    });
  });

  await withFake({
    refuseTest: () => ({ status: 401, code: 'upstream_rejected', message: 'that key was rejected', details: null }),
  }, async ({ name }) => {
    await check('the upstream\'s own refusal reaches the caller with its own code', async () => {
      const got = await seam.testCrucibleUpstream(name, 'anthropic', { key: 'nope' });
      assert.strictEqual(got.ok, false);
      assert.strictEqual(got.refusal.code, 'upstream_rejected');
      assert.ok(got.refusal.message.includes('that key was rejected'), got.refusal.message);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Capability and its route (§3.3) — read by the SDK, recorded by us
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
    await check('a document where NO row has a route is a PRE-PHASE-15 server: every class is local', async () => {
      /*
       * THE TRIPWIRE THAT USED TO BE HERE HAS EXPIRED, AND THIS IS WHAT IT
       * BECAME (inverted 2026-09-14, against the re-vendored 0.6.0 SDK).
       *
       * crucible `eb59f7b` / PHASE15 §3.3 settle the reading for both apps: a
       * document in which NO row carries `route` comes from a server that
       * predates the field, and every class on such a server IS local — "a
       * fact the document states, not a default the client fills … BookForge's
       * helper and Foundry's package K alike". Owen's live WSL server answers
       * exactly that way until the phase-15 branch is deployed onto it.
       *
       * Until tonight the vendored SDK refused that document instead, and this
       * check PINNED the defect rather than working around it — reading
       * "local" out of a refusal would have put a second opinion about the
       * document beside the SDK's, which is the two-owners defect the whole
       * seam was deleted to end (ARCHITECTURE.md R1). The SDK now makes all
       * three readings itself (`readCapabilityRow`: no row has it ⇒ `local`;
       * SOME rows have it ⇒ refuse, naming the row; a value that is neither ⇒
       * refuse, naming the value), so the reading is where it always belonged
       * and this is a plain agreement check.
       *
       * NOTHING IN `electron/crucible/engine-settings.ts` CHANGED FOR THIS,
       * and that is the point of having refused to work around it: there was
       * no workaround to delete. Only its header paragraph, which called the
       * refusal a live defect, is brought up to date.
       */
      const record = await seam.crucibleCapabilityWithRoutes(name);
      assert.ok(record.classes.length > 0, 'a pre-phase-15 document still lists its classes');
      for (const row of record.classes) {
        assert.strictEqual(row.route, 'local',
          `${row.capability} reads route ${JSON.stringify(row.route)} on a document where no row `
          + 'carries one. §3.3: every class on such a server IS local.');
      }
      // And the route RECORD the read fills says local too — the queue's
      // `[cloud]` lane asks that record synchronously, so a pre-phase-15
      // server must not leave it saying `unknown` about a class it listed.
      const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
      for (const row of record.classes) {
        assert.strictEqual(routes.crucibleRouteOf(name, row.capability), 'local',
          `the route record says ${row.capability} is `
          + `${routes.crucibleRouteOf(name, row.capability)} on a pre-phase-15 server`);
      }
    });
  });

  await withFake({ routeMissingFor: 'simplify' }, async ({ name }) => {
    await check('SOME rows with a route and one without is refused, naming the row', async () => {
      /*
       * THE SDK MAKES THIS REFUSAL, so BookForge no longer names it
       * `capability_route_missing`: a second reader minting a nicer code for a
       * document the SDK already refused is the two-owners defect wearing a
       * label. What crossed with the old name was the CLASS — "simplify" — and
       * what crosses now is the row's INDEX and the field path, which is the
       * SDK's own way of naming a row and is still a name a person can act on.
       */
      const err = await refuses(() => seam.crucibleCapabilityWithRoutes(name), 'settings_document_unreadable');
      assert.ok(err.message.includes('classes[2]'), err.message);
      assert.ok(err.message.includes('route'), err.message);
    });
  });

  await withFake({ badRouteFor: 'translate' }, async ({ name }) => {
    await check('a route that is neither local nor upstream is refused, naming the value', async () => {
      // Also the SDK's now (`oneOf`), and it keeps the thing that matters most
      // in this one: the VALUE it would have had to guess the meaning of.
      const err = await refuses(() => seam.crucibleCapabilityWithRoutes(name), 'settings_document_unreadable');
      assert.ok(err.message.includes('classes[1]'), err.message);
      assert.ok(err.message.includes('somewhere-else'), err.message);
    });
  });

  await withFake({ routes: { clean: 'anthropic/claude-x' }, upstreams: { anthropic: { key: 'sk-1234' } } },
    async ({ name }) => {
      await check('the route record is filled by the READ, so the scheduler can ask synchronously', async () => {
        const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
        routes.forgetCrucibleRoutes(name);
        assert.strictEqual(routes.crucibleRouteOf(name, 'clean'), 'unknown',
          'an engine nobody has read is `unknown`, never assumed local');
        await seam.crucibleCapabilityWithRoutes(name);
        assert.strictEqual(routes.crucibleRouteOf(name, 'clean'), 'upstream');
        assert.strictEqual(routes.crucibleRouteOf(name, 'translate'), 'local');
        assert.strictEqual(routes.crucibleRouteOf(name, 'nonsense'), 'unknown',
          'a class the engine did not mention is unknown, not local');
      });

      await check('a settings WRITE records the routes out of its own answer, with no second read', async () => {
        const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
        await seam.crucibleCapabilityWithRoutes(name);
        assert.strictEqual(routes.crucibleRouteOf(name, 'clean'), 'upstream');
        await seam.putCrucibleEngineSettings(name, { routes: { clean: 'local' } });
        assert.strictEqual(routes.crucibleRouteOf(name, 'clean'), 'local',
          'the write-through path is what invalidates the record — a caller cannot forget');
      });
    });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. llama-windows: Windows IS a backend (AMENDED 2026-09-14, crucible 56cfe37)
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
  // 6. Servers that cannot answer
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

await check('removing a server forgets its routes; disabling one does not', () => {
    /*
     * A record about a server that is no longer registered is a record about
     * nothing — and if the same NAME comes back for a different machine, it
     * would be answered from for one pump before coordination corrects it,
     * which is a row placed on a lane nobody chose. The record has no expiry
     * on purpose (age is not what makes a route wrong), so the removal is what
     * clears it.
     */
    const routes = require(path.join(REPO, 'dist', 'electron', 'crucible', 'routes.js'));
    routes.forgetCrucibleRoutes();
    routes.noteCrucibleRoutes('doomed', { clean: 'upstream' });
    routes.noteCrucibleRoutes('kept', { clean: 'upstream' });
    assert.deepStrictEqual(routes.crucibleRoutesKnownFor(), ['doomed', 'kept']);
    routes.forgetCrucibleRoutes('doomed');
    assert.deepStrictEqual(routes.crucibleRoutesKnownFor(), ['kept']);
    assert.strictEqual(routes.crucibleRouteOf('doomed', 'clean'), 'unknown');
    assert.strictEqual(routes.crucibleRouteOf('kept', 'clean'), 'upstream');

    // And `removeServer` is the door that calls it — source-read, because the
    // registry write itself needs a real userData and is exercised elsewhere.
    const servers = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'servers.ts'), 'utf-8');
    const fn = servers.indexOf('export function removeServer');
    assert.ok(fn > 0, 'removeServer moved');
    const body = servers.slice(fn, servers.indexOf(String.fromCharCode(10) + '}', fn));
    assert.ok(body.includes('forgetCrucibleRoutes(name)'),
      'removing a server leaves its routes behind for the scheduler to answer from');
  });

    summary('crucible settings seam');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
