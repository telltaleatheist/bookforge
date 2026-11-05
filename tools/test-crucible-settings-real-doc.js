#!/usr/bin/env node
/**
 * THE REAL SERVER'S SETTINGS DOCUMENT, which a fake once hid a broken wizard from.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-settings-real-doc.js
 *
 * `tools/fixtures/crucible-settings-real.json` is `GET /v1/settings` from a real 2.0.34
 * server, captured read-only with its identity scrubbed. Crucible retired the four text
 * classes on 2026-10-25, the fake went on routing them, and BookForge refused every real
 * server with "routes no clean" while every keeper passed. So this serves the captured
 * document itself, through the SDK's real parser, to the door the wizard and the AI page read.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, send,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const DOOR = path.join(REPO, 'dist', 'electron', 'crucible', 'engine-settings.js');
if (!fs.existsSync(DOOR)) {
  console.log(skipLine('dist/electron/crucible/engine-settings.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
installElectronStub('bf-settings-real-');
const settings = require(DOOR);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'crucible-settings-real.json'), 'utf8'));
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

async function main() {
  const fake = await startFakeCrucible(async (req, res, ctx) => {
    if (ctx.url.pathname === '/v1/settings' && req.method === 'GET') {
      send(res, 200, REAL);
      return true;
    }
    return false;
  });
  const server = registerFake(fake.url);

  await check('the fixture is what a current server sends: it routes generate, not the four', () => {
    assert.deepStrictEqual(Object.keys(REAL.routes), ['generate']);
  });
  await check('the door the wizard and AI page read accepts the real document', async () => {
    const doc = await settings.crucibleEngineSettings(server);
    assert.deepStrictEqual(Object.keys(doc.routes), ['generate']);
    assert.strictEqual(doc.routes.generate.route, 'local');
    assert.strictEqual(doc.routes.generate.model, REAL.routes.generate.model);
    assert.ok(Object.keys(doc.localModels.choices).includes('decide'));
    assert.strictEqual(doc.upstreams.anthropic.configured, true);
  });
  await check('the rest of the document is not lost in the projection', async () => {
    const doc = await settings.crucibleEngineSettings(server);
    assert.strictEqual(doc.desktopAllowanceBytes, REAL.desktop_allowance_bytes);
    assert.deepStrictEqual(Object.keys(doc.upstreams).sort(), Object.keys(REAL.upstreams).sort());
  });
  await fake.close();

  await check('the wizard draws the classes the server routes, not a list of its own', () => {
    const wizard = read('src/app/features/ai-setup/ai-setup-wizard.component.ts');
    assert.match(wizard, /Object\.keys\(this\.engineSettings\(\)\?\.routes \?\? \{\}\)/);
    assert.ok(!/CRUCIBLE_TEXT_ACT_NAMES/.test(wizard));
  });
  await check('no door requires a retired class of a server', () => {
    assert.ok(!/CRUCIBLE_TEXT_ACTS/.test(read('electron/crucible/engine-settings.ts')));
    assert.ok(!/CRUCIBLE_TEXT_ACT_NAMES/.test(read('shared/crucible/settings-wire.ts')));
    assert.ok(!/CRUCIBLE_TEXT_ACT_NAMES/.test(read('src/app/features/settings/components/ai-panel.component.ts')));
  });
  await check('the shared fake routes what a real server routes, so it cannot hide this again', () => {
    assert.deepStrictEqual(require('./fake-crucible').LLM_CLASSES, Object.keys(REAL.routes));
  });
  summary('test-crucible-settings-real-doc');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
