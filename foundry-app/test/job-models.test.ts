import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * A JOB'S MODEL DROPDOWN (Owen, 2026-10-25): *"put the option the user can pick
 * in a dropdown on the modal that configures the job"*; *"cloud accounts should
 * be listed as an option in every model dropdown if its available … bookforge
 * should use the last used model as the default"*; *"keep it at 27b as the max
 * right now"*. The rule (shared/job-models.ts), the request helper, the
 * remembered value, and the door that reads one server's two lists.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-job-models-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
const rule = await import('../shared/job-models');
const offer = await import('../shared/job-model-offer');
const settings = await import('../electron/app-settings');
const registry = await import('../electron/crucible-registry');
const models = await import('../electron/crucible-models');
afterEach(() => mock.restore());
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

type Local = Parameters<typeof rule.jobModelChoices>[1][number];
const local = (id: string, paramsB: number, more: Partial<Local> = {}): Local => ({
  id, paramsB, installed: true, loadable: true, backendSupported: true,
  verbs: ['clean', 'generate', 'translate'], modalities: ['text'], ...more,
});

test('the list is AUTOMATIC, then local chat models at or under 27B biggest first, then cloud', () => {
  const list = rule.jobModelChoices('pc', [
    local('qwen3.5-9b', 9),
    local('qwen3.8-27b-4bit', 27),
    local('qwen3.5-4b', 4),
    local('qwen3-32b', 32),                                  // over the ceiling
    local('qwen3.5-2b-uninstalled', 2, { installed: false }),
    local('qwen3.5-unloadable', 3, { loadable: false }),
    local('qwen-mlx-only', 3, { backendSupported: false }),
    local('dots-ocr', 3, { verbs: ['pages'], modalities: ['text', 'image'] }), // not a chat model
    local('qwen3-embed', 8, { verbs: ['embed'] }),
    local('old-server-row', 7, { verbs: null }),              // a server before verbs: says nothing
    local('voice-only', 1, { modalities: ['audio'] }),
  ], {
    models: [{ id: 'anthropic/claude-sonnet-5-5', upstream: 'anthropic' }, { id: 'openai/gpt-5', upstream: 'openai' }],
    upstreams: { anthropic: { stale: false, error: null }, openai: { stale: false, error: null } },
  }, null);
  expect(list.server).toBe('pc');
  expect(list.choices.map((c) => [c.kind, c.value])).toEqual([
    ['automatic', ''],
    ['local', 'qwen3.8-27b-4bit'],
    ['local', 'qwen3.5-9b'],
    ['local', 'qwen3.5-4b'],
    ['cloud', 'anthropic/claude-sonnet-5-5'],
    ['cloud', 'openai/gpt-5'],
  ]);
  expect(list.choices[0]!.label).toContain('27B');
  expect(list.choices[4]!.label).toBe('Claude: claude-sonnet-5-5');
  expect(list.choices[4]!.detail).toBe('Billed to the anthropic account set up on pc.');
  expect(list.choices[5]!.label).toBe('OpenAI: gpt-5');
  expect(list.cloudNote).toBeNull();
});

test('a vendor that did not answer is a note, and its last list is still offered', () => {
  const list = rule.jobModelChoices('pc', [local('qwen3.5-9b', 9)], {
    models: [{ id: 'anthropic/claude-sonnet-5-5', upstream: 'anthropic' }],
    upstreams: { anthropic: { stale: true, error: { code: 'upstream_unreachable', message: 'anthropic did not answer' } } },
  }, null);
  expect(list.choices.some((c) => c.value === 'anthropic/claude-sonnet-5-5')).toBe(true);
  expect(list.cloudNote).toBe("Claude's list is from earlier (anthropic did not answer).");
});

test('an unreadable upstream list keeps the local rows and says why there are no cloud ones', () => {
  const list = rule.jobModelChoices('pc', [local('qwen3.5-9b', 9)], null, 'GET /v1/openai/models answered 404');
  expect(list.choices.map((c) => c.kind)).toEqual(['automatic', 'local']);
  expect(list.cloudNote).toBe('The cloud models pc can forward to could not be read: GET /v1/openai/models answered 404.');
});

test('the default is the last value used when the list still offers it, else AUTOMATIC', () => {
  const list = rule.jobModelChoices('pc', [local('qwen3.5-9b', 9)], {
    models: [{ id: 'anthropic/claude-sonnet-5-5', upstream: 'anthropic' }], upstreams: {},
  }, null);
  expect(rule.defaultJobModel(list, 'qwen3.5-9b')).toBe('qwen3.5-9b');
  expect(rule.defaultJobModel(list, 'anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
  expect(rule.defaultJobModel(list, '')).toBe('');
  expect(rule.defaultJobModel(list, 'qwen3.8-27b-4bit')).toBe(''); // chosen on another server
  expect(rule.defaultJobModel(list, undefined)).toBe('');
});

test('a dialog-built request carries chosenModel only when one was chosen', () => {
  const base = { kind: 'translate' as const, to: 'de' } as { kind: 'translate'; to: string; chosenModel?: string };
  expect('chosenModel' in offer.withChosenModel(base, '')).toBe(false);
  expect(offer.withChosenModel(base, 'qwen3.5-9b').chosenModel).toBe('qwen3.5-9b');
  expect(offer.withChosenModel(base, 'anthropic/claude-sonnet-5-5').chosenModel).toBe('anthropic/claude-sonnet-5-5');
  // AUTOMATIC over a request that somehow already carries one takes it off.
  expect('chosenModel' in offer.withChosenModel({ ...base, chosenModel: 'x' }, '')).toBe(false);
  expect('chosenModel' in base).toBe(false); // the caller's object is untouched
});

test('the last model per kind round-trips through the settings file, Automatic included', () => {
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({ someoneElsesKey: 1 }));
  expect(settings.readAppSettings().lastJobModels).toEqual({});
  settings.writeAppSettings({ lastJobModels: { clean: '', translate: 'anthropic/claude-sonnet-5-5' } });
  expect(settings.readAppSettings().lastJobModels).toEqual({ clean: '', translate: 'anthropic/claude-sonnet-5-5' });
  const raw = JSON.parse(fs.readFileSync(path.join(userData, 'app-settings.json'), 'utf8'));
  expect(raw.someoneElsesKey).toBe(1);
  // A kind this build does not know, and a value that is not an id, are not kept.
  fs.writeFileSync(path.join(userData, 'app-settings.json'), JSON.stringify({
    lastJobModels: { clean: 'qwen3.5-9b', narrate: 'x', translate: 7, simplify: null, analysis: 'y'.repeat(201) },
  }));
  expect(settings.readAppSettings().lastJobModels).toEqual({ clean: 'qwen3.5-9b' });
  // rememberJobModel writes one kind and leaves the others.
  models.rememberJobModel('simplify', '');
  expect(settings.readAppSettings().lastJobModels).toEqual({ clean: 'qwen3.5-9b', simplify: '' });
});

/*
 * THE DOOR, against a fake Crucible on loopback — READ-ONLY GETs only.
 */
function fixture(options: { upstream?: 'ok' | 'missing' } = {}) {
  const revision = 'a'.repeat(40);
  const row = (id: string, params: number, more: Record<string, unknown> = {}) => ({
    id, family: 'fixture', params_b: params, revision, fingerprint: `${id}@${revision}`, modalities: ['text'],
    backend_supported: true, installed: true, weights_of: null, resident: false, loadable: true,
    memory_bytes_estimate: 1, context_default: 8192, max_model_len: 8192, form: null, form_reason: null, forms: null,
    verbs: ['generate'], ...more,
  });
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
    const p = new URL(req.url).pathname; paths.push(`${req.method} ${p}`);
    if (req.method !== 'GET') return Response.json({ error: { code: 'fixture_read_only', message: p } }, { status: 500 });
    if (p === '/v1/info') return Response.json({server:{name:'fixture',version:'2.0.31',api_version:1},features:['queue.sessions','queue.calls','queue.jobs','events'],host:{platform:'linux',arch:'x86_64',backend:'cuda-linux',gpu:{vendor:'nvidia',name:'fake',vram_bytes:24e9}},role:'engine',managed_by:null,job_types:['load-model','unload-model'],capabilities:[],pages_engine:{engine:'llama-cpp',installed:true,detail:'fixture',request:{model:'dots-ocr',dpi:200,max_pixels:11289600,max_tokens:8192,temperature:0,prompt:'fixture',dialect:'dots-json',concurrency:1,truncated_finish_reason:'length'}}});
    if (p === '/v1/models') return Response.json([row('qwen3.5-9b', 9), row('qwen3.8-27b-4bit', 27), row('qwen3-32b', 32)]);
    if (p === '/v1/openai/models') {
      if (options.upstream === 'missing') return Response.json({ error: { code: 'not_found', message: 'no such route' } }, { status: 404 });
      return Response.json({ object: 'list', data: [
        { id: 'qwen3.8-27b-4bit', object: 'model' },
        { id: 'anthropic/claude-sonnet-5-5', object: 'model', upstream: 'anthropic', routed_for: [], listed: true, facts: null },
      ], upstreams: { anthropic: { listed_at: '2026-10-25T00:00:00Z', stale: false, error: null } } });
    }
    return Response.json({ error: { code: 'fixture_unhandled', message: p } }, { status: 500 });
  } });
  const entry = { name: `fixture-${server.port}`, url: `http://127.0.0.1:${server.port}`, token: 'fixture-token', enabled: true };
  registry.forgetEngineTargets();
  spyOn(registry, 'crucibleServerNamed').mockImplementation((name: string) => (name === entry.name ? entry : null));
  spyOn(registry, 'slotAvailability').mockReturnValue({ slots: [{ kind: 'cloud', name: 'my-claude' }, { kind: 'crucible', name: entry.name, url: entry.url }], refusal: null } as never);
  return { entry, paths, close: () => server.stop(true) };
}

test('the door reads the pinned server, offers its rows, and opens on the last value used', async () => {
  const f = fixture();
  try {
    spyOn(settings, 'readAppSettings').mockReturnValue({ lastJobModels: { translate: 'anthropic/claude-sonnet-5-5' } } as never);
    const answer = await models.jobModelOffer('translate', f.entry.name);
    expect(answer.list.server).toBe(f.entry.name);
    expect(answer.list.choices.map((c) => c.value)).toEqual(['', 'qwen3.8-27b-4bit', 'qwen3.5-9b', 'anthropic/claude-sonnet-5-5']);
    expect(answer.preselected).toBe('anthropic/claude-sonnet-5-5');
    expect(f.paths.every((p) => p.startsWith('GET '))).toBe(true);
  } finally { f.close(); }
});

test('with no pin the door asks the top-ranked CRUCIBLE slot, never a cloud slot', async () => {
  const f = fixture();
  try {
    spyOn(settings, 'readAppSettings').mockReturnValue({ lastJobModels: {} } as never);
    const answer = await models.jobModelOffer('clean', null);
    expect(answer.list.server).toBe(f.entry.name);
    expect(answer.preselected).toBe('');
  } finally { f.close(); }
});

test('a server too old for the upstream list still offers its own models, with the reason', async () => {
  const f = fixture({ upstream: 'missing' });
  try {
    spyOn(settings, 'readAppSettings').mockReturnValue({ lastJobModels: {} } as never);
    const answer = await models.jobModelOffer('simplify', f.entry.name);
    expect(answer.list.choices.map((c) => c.kind)).toEqual(['automatic', 'local', 'local']);
    expect(answer.list.cloudNote).toContain('could not be read');
    expect(answer.list.cloudNote).toContain('no such route');
  } finally { f.close(); }
});

test('a server that cannot be reached is an error by name, not an empty list', async () => {
  const f = fixture();
  const url = f.entry.url;
  f.close();
  spyOn(registry, 'crucibleServerNamed').mockReturnValue({ ...f.entry, url } as never);
  spyOn(settings, 'readAppSettings').mockReturnValue({ lastJobModels: {} } as never);
  registry.forgetEngineTargets();
  await expect(models.jobModelOffer('analysis', f.entry.name)).rejects.toThrow();
  spyOn(registry, 'crucibleServerNamed').mockReturnValue(null);
  await expect(models.jobModelOffer('analysis', 'gone')).rejects.toThrow('"gone" is not a registered engine');
});
