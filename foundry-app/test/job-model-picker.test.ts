import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S SERVER AND MODEL PICKER (Owen, 2026-11-02): the model list is the chosen
 * server's own — a model the Mac has not got never appears with the Mac chosen;
 * a change of server keeps the model only where the new one offers it; the last
 * server and model are remembered; and a server that does not answer is weather,
 * retried inside a budget and then said in the box, not thrown.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-picker-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const sdk = await import('@crucible/client');

const model = (id: string, paramsB: number) => ({
  id, paramsB, installed: true, loadable: true, backendSupported: true, verbs: ['generate'], modalities: ['text'],
});
/** What each registered server answers, by name; a thrower is a server that does not answer. */
const SERVERS: Record<string, { local: () => unknown[]; cloud: unknown }> = {
  'crucible@pc': {
    local: () => [model('qwen3.8-27b-4bit', 27), model('qwen3.5-9b', 9)],
    cloud: { models: [{ id: 'anthropic/claude-sonnet-5-5', upstream: 'anthropic' }], upstreams: {} },
  },
  'crucible@mac': { local: () => [model('qwen3.5-9b', 9)], cloud: { models: [], upstreams: {} } },
  'crucible@gone': { local: () => { throw new sdk.CrucibleUnreachable('http://gone', 'connect ECONNREFUSED'); }, cloud: { models: [], upstreams: {} } },
};
let calls = 0;
const registry = await import('../electron/crucible-registry');
const spies: { mockRestore(): void }[] = [];
// Spied, not module-mocked: a module mock outlives this file in a shared bun process.
beforeEach(() => {
  spies.push(spyOn(registry, 'crucibleServerNamed').mockImplementation(
    ((name: string) => (name in SERVERS ? { name, url: 'http://x', token: '', enabled: true } : null)) as never));
  spies.push(spyOn(registry, 'engineClientFor').mockImplementation((async (entry: { name: string }) => ({
    models: async () => { calls += 1; return SERVERS[entry.name]!.local(); },
    upstreamModels: async () => SERVERS[entry.name]!.cloud,
  })) as never));
  spies.push(spyOn(registry, 'slotAvailability').mockImplementation(
    (() => ({ refusal: null, slots: [{ kind: 'crucible', name: 'crucible@pc' }] })) as never));
});
afterEach(() => { while (spies.length > 0) spies.pop()!.mockRestore(); });

const models = await import('../electron/crucible-models');
const { choiceOnServer, AUTOMATIC_JOB_MODEL } = await import('../shared/job-models');
const settings = await import('../electron/app-settings');

test('each server lists only its own models, Automatic first, API rows only where it has them', async () => {
  const pc = await models.jobModelOffer('ask', 'crucible@pc');
  const mac = await models.jobModelOffer('ask', 'crucible@mac');
  expect(pc.unreachable).toBeNull();
  expect(pc.list.choices.map((c) => c.value)).toEqual(['', 'qwen3.8-27b-4bit', 'qwen3.5-9b', 'anthropic/claude-sonnet-5-5']);
  expect(mac.list.choices.map((c) => c.value)).toEqual(['', 'qwen3.5-9b']);
  expect(mac.list.server).toBe('crucible@mac');
});

test('changing server keeps the model where the new server has it, and is Automatic where it has not', async () => {
  const pc = (await models.jobModelOffer('ask', 'crucible@pc')).list;
  const mac = (await models.jobModelOffer('ask', 'crucible@mac')).list;
  expect(choiceOnServer(mac, 'qwen3.8-27b-4bit')).toBe(AUTOMATIC_JOB_MODEL);
  expect(choiceOnServer(mac, 'anthropic/claude-sonnet-5-5')).toBe(AUTOMATIC_JOB_MODEL);
  expect(choiceOnServer(mac, 'qwen3.5-9b')).toBe('qwen3.5-9b');
  expect(choiceOnServer(pc, 'qwen3.5-9b')).toBe('qwen3.5-9b');
});

test('the last server and model are remembered, and the picker opens on them', async () => {
  models.rememberJobModel('ask', 'qwen3.5-9b', 'crucible@mac');
  expect(settings.readAppSettings().lastJobServers).toEqual({ ask: 'crucible@mac' });
  const opened = await models.jobModelOffer('ask', null);
  expect(opened.list.server).toBe('crucible@mac');
  expect(opened.preselected).toBe('qwen3.5-9b');
  // A remember with no server leaves the server as it was.
  models.rememberJobModel('ask', '');
  expect(settings.readAppSettings().lastJobServers).toEqual({ ask: 'crucible@mac' });
});

test('a server that does not answer is retried inside the budget, then said in the answer, not thrown', async () => {
  calls = 0;
  const offer = await models.jobModelOffer('ask', 'crucible@gone');
  expect(calls).toBe(3);
  expect(offer.list.choices).toEqual([]);
  expect(offer.unreachable).toContain('crucible@gone did not answer');
  // Misconfiguration still refuses by name.
  await expect(models.jobModelOffer('ask', 'crucible@nobody')).rejects.toThrow('is not a registered engine');
});
