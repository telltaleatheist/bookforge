#!/usr/bin/env node
/**
 * A TEXT JOB'S OWN MODEL DROPDOWN, FROM THE LIST TO THE RUN (Owen, 2026-10-25).
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-job-model-choices.js
 *
 * Verbatim: *"put the option the user can pick in a dropdown on the modal that
 * configures the job"*; *"cloud accounts should be listed as an option in every
 * model dropdown if its available, just like 27b or 9b or anything else.
 * however, bookforge should use the last used model as the default"*; *"keep it
 * at 27b as the max right now"*.
 *
 * Four links, each of which fails quietly when broken — a dropdown that offers
 * a 32B, a cloud row nobody can tell is billed, a choice that never reaches the
 * run so the server's own pick runs instead:
 *
 *  1. THE LIST — `jobModelChoices` / `defaultJobModel` (shared/crucible/job-models.ts):
 *     AUTOMATIC first, local chat models at or under 27B biggest first, then the
 *     cloud rows; the default is the last value used while the list still offers it.
 *  2. THE DOOR — `readJobModelChoices` (electron/crucible/job-models-door.ts)
 *     against a fake Crucible speaking the 2.0.31 wire: an unreadable cloud list
 *     is a note, not a failure; a dead socket is retried inside a budget; a
 *     server that never answers is named. Plus the IPC channel, pinned on source.
 *  3. THE QUEUE ROW — `providerConfigOf` puts a translation's / analysis's
 *     `chosenModel` on `crucible.model` (only when non-empty), and every step
 *     module's `chosenModel` hook reads its own field.
 *  4. THE CLEANUP — `cleanTextEpub({chosenModel})` hands the choice to
 *     `resolveCrucibleTextEngine`: a chosen model is the one proved resident and
 *     the server is NOT asked to size one; AUTOMATIC asks it.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no registry but its own.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
  jobModelRoutes, modelInfoRow, upstreamModelRow, settingsRoutes, ENGINE_INFO_FIELDS,
} = require('./fake-crucible.js');
const { skipLine } = require('./keeper-skip.js');

const DIST = path.join(REPO, 'dist');
const DOOR = path.join(DIST, 'electron', 'crucible', 'job-models-door.js');
if (!fs.existsSync(DOOR)) {
  console.log(skipLine('dist/electron/crucible/job-models-door.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const { work } = installElectronStub('bf-job-models-');
const rule = require(path.join(DIST, 'shared', 'crucible', 'job-models.js'));
const door = require(DOOR);
const servers = require(path.join(DIST, 'electron', 'crucible', 'servers.js'));
const aiProvider = require(path.join(DIST, 'electron', 'queue-steps', 'ai-provider.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

const LOCAL = [
  { id: 'qwen3.8-27b-4bit', paramsB: 27, installed: true, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['text'] },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['text'] },
  { id: 'qwen3-32b', paramsB: 32, installed: true, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['text'] },
  { id: 'qwen3.5-4b', paramsB: 4, installed: false, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['text'] },
  { id: 'qwen3-embed', paramsB: 0.6, installed: true, loadable: true, backendSupported: true, verbs: ['embed'], modalities: ['text'] },
  { id: 'dots-ocr', paramsB: 3, installed: true, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['image'] },
  { id: 'mlx-only-14b', paramsB: 14, installed: true, loadable: true, backendSupported: false, verbs: ['generate'], modalities: ['text'] },
];
const CLOUD = {
  models: [{ id: 'anthropic/claude-sonnet-5-5', upstream: 'anthropic' }, { id: 'openai/gpt-6', upstream: 'openai' }],
  upstreams: { anthropic: { stale: false, error: null }, openai: { stale: false, error: null } },
};

async function main() {
  // ── 1. THE LIST ────────────────────────────────────────────────────────────

  await check('AUTOMATIC first, then local chat models at or under 27B biggest first, then cloud', () => {
    const list = rule.jobModelChoices('pc', LOCAL, CLOUD, null);
    assert.strictEqual(list.server, 'pc');
    assert.deepStrictEqual(list.choices.map((c) => [c.kind, c.value]), [
      ['automatic', ''],
      ['local', 'qwen3.8-27b-4bit'],
      ['local', 'qwen3.5-9b'],
      ['cloud', 'anthropic/claude-sonnet-5-5'],
      ['cloud', 'openai/gpt-6'],
    ], 'the 32B (over the ceiling), the uninstalled 4B, the embedder, the image-only reader and '
      + 'the model this backend cannot run must all be left out');
    assert.strictEqual(list.cloudNote, null);
  });

  await check('a cloud row says whose account it is billed to', () => {
    const list = rule.jobModelChoices('pc', LOCAL, CLOUD, null);
    const claude = list.choices.find((c) => c.value === 'anthropic/claude-sonnet-5-5');
    assert.strictEqual(claude.label, 'Claude: claude-sonnet-5-5');
    assert.match(claude.detail, /Billed to the anthropic account set up on pc/);
  });

  await check('no cloud list: the local rows stay, and the note says why there are no cloud ones', () => {
    const list = rule.jobModelChoices('pc', LOCAL, null, 'HTTP 404: /v1/openai/models');
    assert.ok(list.choices.every((c) => c.kind !== 'cloud'));
    assert.ok(list.choices.some((c) => c.value === 'qwen3.5-9b'));
    assert.match(list.cloudNote, /could not be read: HTTP 404/);
  });

  await check('a vendor that did not answer is a stale note naming it', () => {
    const list = rule.jobModelChoices('pc', LOCAL, {
      models: CLOUD.models,
      upstreams: { anthropic: { stale: true, error: { code: 'upstream_unreachable', message: 'timed out' } } },
    }, null);
    assert.match(list.cloudNote, /Claude's list is from earlier \(timed out\)/);
  });

  await check('the default is the last value used while the list still offers it, else AUTOMATIC', () => {
    const list = rule.jobModelChoices('pc', LOCAL, CLOUD, null);
    assert.strictEqual(rule.defaultJobModel(list, 'anthropic/claude-sonnet-5-5'), 'anthropic/claude-sonnet-5-5');
    assert.strictEqual(rule.defaultJobModel(list, 'qwen3.5-9b'), 'qwen3.5-9b');
    assert.strictEqual(rule.defaultJobModel(list, ''), '', 'AUTOMATIC chosen last time is kept');
    assert.strictEqual(rule.defaultJobModel(list, 'qwen3-32b'), '', 'a model not on THIS list is not the default');
    assert.strictEqual(rule.defaultJobModel(list, undefined), '', 'first run is AUTOMATIC, never a cloud row');
  });

  // ── 2. THE DOOR ────────────────────────────────────────────────────────────

  const routes = jobModelRoutes({
    models: [
      modelInfoRow('qwen3.5-9b', { params_b: 9 }),
      modelInfoRow('qwen3.8-27b-4bit', { params_b: 27 }),
      modelInfoRow('qwen3-32b', { params_b: 32 }),
    ],
    upstreamRows: [upstreamModelRow('anthropic/claude-sonnet-5-5', 'anthropic', { routed_for: ['clean'] })],
    upstreams: { anthropic: { listed_at: '2026-10-25T20:00:00Z', stale: false, error: null } },
  });
  const fake = await startFakeCrucible((req, res, ctx) => routes.handle(req, res, ctx));
  const name = registerFake(fake.url);
  const pauses = [];
  const host = () => Object.assign(door.processJobModelsHost(), {
    pause: async (ms) => { pauses.push(ms); },
    decideServer: async () => name,
  });

  await check('the door reads both lists off the 2.0.31 wire and hands back the rule\'s list', async () => {
    const list = await door.readJobModelChoices(name, host());
    assert.strictEqual(list.server, name);
    assert.deepStrictEqual(list.choices.map((c) => c.value),
      ['', 'qwen3.8-27b-4bit', 'qwen3.5-9b', 'anthropic/claude-sonnet-5-5'],
      'the resident row of /v1/openai/models (no upstream) must not become a cloud row');
    assert.strictEqual(list.cloudNote, null);
  });

  await check('null names the server the venue rule picks, and the list says which one', async () => {
    const list = await door.readJobModelChoices(null, host());
    assert.strictEqual(list.server, name);
  });

  await check('an empty server name is refused rather than read as "pick one"', async () => {
    await assert.rejects(() => door.readJobModelChoices('  ', host()), /crucible_server_not_named/);
  });

  await check('an unknown server is misconfiguration: refused at once, never retried', async () => {
    pauses.length = 0;
    await assert.rejects(() => door.readJobModelChoices('nobody-registered-this', host()),
      /nobody-registered-this/);
    assert.deepStrictEqual(pauses, [], 'a misconfiguration was retried as if it were weather');
  });

  const noCloudRoutes = jobModelRoutes({ models: [modelInfoRow('qwen3.5-9b')], noUpstreamDoor: true });
  const noCloud = await startFakeCrucible((req, res, ctx) => noCloudRoutes.handle(req, res, ctx));
  const noCloudName = registerFake(noCloud.url);

  await check('a cloud list that cannot be read is a note on a list that still offers the local rows', async () => {
    const list = await door.readJobModelChoices(noCloudName, host());
    assert.deepStrictEqual(list.choices.map((c) => c.value), ['', 'qwen3.5-9b']);
    assert.match(list.cloudNote, /could not be read/);
  });

  const flakyRoutes = jobModelRoutes({ models: [modelInfoRow('qwen3.5-9b')] });
  const flaky = await startFakeCrucible((req, res, ctx) => flakyRoutes.handle(req, res, ctx), {
    faults: { resetAfterBytes: [{ match: { method: 'GET', path: '/v1/models' }, afterBytes: 0, times: 1 }] },
  });
  const flakyName = registerFake(flaky.url);

  await check('a socket that died under the models read is retried inside the budget', async () => {
    pauses.length = 0;
    const list = await door.readJobModelChoices(flakyName, host());
    assert.ok(list.choices.some((c) => c.value === 'qwen3.5-9b'));
    const reads = flaky.state.requests.filter((r) => r.path === '/v1/models').length;
    assert.ok(reads >= 2, `the models door was read ${reads} time(s); the blip was not retried`);
  });

  const gone = await startFakeCrucible(() => false);
  const goneName = registerFake(gone.url);
  await gone.close();

  await check('a server that never answers is named, after the whole budget', async () => {
    pauses.length = 0;
    await assert.rejects(() => door.readJobModelChoices(goneName, host()), (err) => {
      assert.match(err.message, new RegExp(`crucible "${goneName}" did not answer GET /v1/models after `
        + `${door.JOB_MODELS_READ_ATTEMPTS} tries`));
      return true;
    });
    assert.deepStrictEqual(pauses, [500, 1500], 'the waits between tries were not the stated budget');
  });

  await check('SOURCE PIN: one channel, from main through the preload to the renderer service', () => {
    const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf8');
    const preload = fs.readFileSync(path.join(REPO, 'electron', 'preload.ts'), 'utf8');
    const service = fs.readFileSync(path.join(REPO, 'src', 'app', 'core', 'services', 'electron.service.ts'), 'utf8');
    assert.match(main, /ipcMain\.handle\('bookforge:crucible-job-models'[\s\S]{0,200}readJobModelChoices\(name\)/);
    assert.match(preload, /jobModels: \(name: string \| null\) => ipcRenderer\.invoke\('bookforge:crucible-job-models', name\)/);
    assert.match(service, /electron\.crucible\.jobModels\(name\)/);
  });

  // ── 3. THE QUEUE ROW ───────────────────────────────────────────────────────

  await check('providerConfigOf puts a chosen model on crucible.model, and nothing for AUTOMATIC', () => {
    const chose = aiProvider.providerConfigOf(
      { aiProvider: 'crucible', aiModel: '', chosenModel: ' anthropic/claude-sonnet-5-5 ' }, 'translate', 'pc');
    assert.deepStrictEqual(chose.crucible, { server: 'pc', act: 'translate', model: 'anthropic/claude-sonnet-5-5' });
    for (const config of [
      { aiProvider: 'crucible', aiModel: '' },                       // a row from before the field
      { aiProvider: 'crucible', aiModel: '', chosenModel: '' },      // AUTOMATIC
      { aiProvider: 'crucible', aiModel: '', chosenModel: '   ' },
    ]) {
      const block = aiProvider.providerConfigOf(config, 'analysis', 'pc').crucible;
      assert.deepStrictEqual(block, { server: 'pc', act: 'analysis' },
        `${JSON.stringify(config)} put a model on the block: ${JSON.stringify(block)}`);
    }
  });

  await check('each step module\'s chosenModel hook reads its own field, and only that', () => {
    const translation = require(path.join(DIST, 'electron', 'queue-steps', 'translation.js')).translationStep;
    const analysis = require(path.join(DIST, 'electron', 'queue-steps', 'book-analysis.js')).bookAnalysisStep;
    const pass = require(path.join(DIST, 'electron', 'queue-steps', 'pass.js'));
    const foundry = require(path.join(DIST, 'electron', 'queue-steps', 'foundry-job.js')).foundryJobStep;
    assert.strictEqual(translation.chosenModel({ chosenModel: 'qwen3.5-9b' }), 'qwen3.5-9b');
    assert.strictEqual(translation.chosenModel({}), null);
    assert.strictEqual(analysis.chosenModel({ chosenModel: ' openai/gpt-6 ' }), 'openai/gpt-6');
    assert.strictEqual(analysis.chosenModel({ chosenModel: '' }), null);
    assert.strictEqual(pass.narrationTextStep.chosenModel({ kind: 'narration-text', chosenModel: 'qwen3.5-9b' }), 'qwen3.5-9b');
    assert.strictEqual(pass.simplifyStep.chosenModel({ kind: 'simplify', chosenModel: 'qwen3.5-9b' }), null,
      'a simplify pass names its model on its own params, not on chosenModel');
    assert.strictEqual(foundry.chosenModel({ request: { kind: 'clean', chosenModel: 'qwen3.5-9b' } }), 'qwen3.5-9b');
    assert.strictEqual(foundry.chosenModel({ request: { kind: 'clean' } }), null);
    assert.strictEqual(foundry.chosenModel({}), null, 'a hook must not throw on a row with no request');
  });

  // ── 4. THE CLEANUP ─────────────────────────────────────────────────────────

  const cleanText = require(path.join(DIST, 'electron', 'narration-clean-text.js'));
  const sizing = settingsRoutes({});
  // Nothing resident: every cleanup below is refused at the residency check,
  // BEFORE anything is spawned, and the refusal names the model it was to run.
  const cleanRoutes = jobModelRoutes({
    models: [modelInfoRow('qwen3.5-9b'), modelInfoRow('qwen3.8-27b-4bit', { params_b: 27 })],
  });
  const venue = await startFakeCrucible(async (req, res, ctx) => {
    if (ctx.url.pathname === '/v1/info' && req.method === 'GET') {
      ctx.send(res, 200, {
        ...ENGINE_INFO_FIELDS,
        server: { name: 'job-models-fake', version: '2.0.31', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux',
          gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 25757220864 } },
        job_types: ['llm'], capabilities: [{ job_type: 'llm', models: [] }],
        role: 'engine', managed_by: null,
      });
      return true;
    }
    if (await cleanRoutes.handle(req, res, ctx)) return true;
    return sizing.handle(req, res, ctx);
  });
  const venueName = registerFake(venue.url);
  const epubPath = path.join(work, 'in.epub');
  fs.writeFileSync(epubPath, 'not read: the refusal comes first');

  await check('a CHOSEN cleanup model is the one proved resident, and the server is not asked to size one', async () => {
    const before = sizing.settings.resolves.length;
    await assert.rejects(() => cleanText.cleanTextEpub({
      epubPath, outPath: path.join(work, 'out-chosen.epub'), crucibleServer: venueName,
      chosenModel: 'qwen3.5-9b',
    }), /crucible_model_not_resident[\s\S]*"qwen3\.5-9b"/);
    assert.strictEqual(sizing.settings.resolves.length, before,
      'GET /v1/resolve was asked although the job had chosen its model');
  });

  await check('an AUTOMATIC cleanup asks the server for the biggest up to 27B, and runs that', async () => {
    const before = sizing.settings.resolves.length;
    await assert.rejects(() => cleanText.cleanTextEpub({
      epubPath, outPath: path.join(work, 'out-auto.epub'), crucibleServer: venueName,
    }), /crucible_model_not_resident[\s\S]*"qwen3\.8-27b-4bit"/);
    assert.strictEqual(sizing.settings.resolves.length, before + 1);
    assert.strictEqual(Number(sizing.settings.resolves[before].max_params_b), 27);
  });

  await check('SOURCE PIN: the narration-text pass hands its row\'s chosenModel to cleanTextEpub', () => {
    const passes = fs.readFileSync(path.join(REPO, 'electron', 'processing-passes.ts'), 'utf8');
    assert.match(passes, /cleanTextEpub\(\{[\s\S]{0,900}\{ chosenModel: config\.chosenModel \}/);
  });

  await Promise.all([fake.close(), noCloud.close(), flaky.close(), venue.close()]);
  summary('job model choices');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
