import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S LOOP: the history is cut in CHUNKS (Owen, 2026-10-29) so the prompt's
 * start stays byte-identical between cuts and the caches keep hitting; the
 * window is still the hard limit; and only weather is retried.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-loop-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
const loop = await import('../electron/ask-document');
const sdk = await import('@crucible/client');
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

type Held = Parameters<ReturnType<typeof loop.fitter>['wire']>[0][number];
type Wired = ReturnType<ReturnType<typeof loop.fitter>['wire']>['wired'];

/** A history of `rounds` complete rounds, each one call and a result of `size` characters. */
function history(rounds: number, size: number): Held[] {
  const out: Held[] = [
    { message: { role: 'system', content: 'system' } },
    { message: { role: 'user', content: 'strike the study questions' } },
  ];
  for (let r = 0; r < rounds; r += 1) out.push(...roundOf(r, size));
  return out;
}
function roundOf(r: number, size: number): Held[] {
  return [
    { message: { role: 'assistant', content: `round ${r}`, toolCalls: [{ id: `c${r}`, type: 'function', function: { name: 'read', arguments: '{}' } }] }, round: r },
    { message: { role: 'tool', toolCallId: `c${r}`, content: 'x'.repeat(size) }, round: r },
  ];
}
const callsIn = (wired: Wired): string[] =>
  wired.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : []));

test(`the history grows to ${loop.HISTORY_HIGH} rounds and is then cut back to ${loop.HISTORY_LOW} in one step`, () => {
  const fit = loop.fitter(null, 8000, 100);
  const h = history(0, 50);
  let previous: Wired | null = null;
  const cuts: number[] = [];
  for (let round = 0; round < 45; round += 1) {
    const { wired } = fit.wire(h, round, `state ${round}`);
    // The state of the work is always the LAST message, and never stored.
    expect(wired.at(-1)).toEqual({ role: 'user', content: `state ${round}` });
    const sent = callsIn(wired).length;
    expect(sent).toBeLessThanOrEqual(loop.HISTORY_HIGH);
    if (previous !== null) {
      const before = previous.slice(0, -1);
      const now = wired.slice(0, before.length);
      if (JSON.stringify(now) === JSON.stringify(before)) {
        // No cut: this request starts with every byte the last one sent.
        expect(sent).toBe(callsIn(previous).length + 1);
      } else {
        cuts.push(round);
        expect(sent).toBe(loop.HISTORY_LOW);
      }
    }
    previous = wired;
    h.push(...roundOf(round, 50));
  }
  // The first cut comes when 21 complete rounds would be sent; after it the
  // history grows from 10 back past 20, so a cut every 11 rounds.
  const every = loop.HISTORY_HIGH - loop.HISTORY_LOW + 1;
  expect(cuts).toEqual([loop.HISTORY_HIGH + 1, loop.HISTORY_HIGH + 1 + every, loop.HISTORY_HIGH + 1 + 2 * every]);
});

test('a cut leaves one note on the person\'s turn and keeps each call with its result', () => {
  const fit = loop.fitter(null, 8000, 100);
  const { wired } = fit.wire(history(25, 50), 25, 'state');
  expect(wired[1]).toEqual({ role: 'user', content: `strike the study questions\n\n${loop.DROPPED_NOTE}` });
  expect(wired.filter((m) => typeof m.content === 'string' && m.content.includes(loop.DROPPED_NOTE))).toHaveLength(1);
  const calls = new Set(callsIn(wired));
  expect([...calls]).toEqual(Array.from({ length: loop.HISTORY_LOW }, (_, i) => `c${15 + i}`));
  for (const m of wired) if (m.role === 'tool') expect(calls.has(m.toolCallId)).toBe(true);
});

test('a window too small for the chunk cuts further, down to the last round', () => {
  // Each round is ~5k characters, ~2k tokens at the first guess: a 12k window holds a few.
  const fit = loop.fitter(12_000, 2000, 100);
  const { wired } = fit.wire(history(15, 5000), 15, 'state');
  const sent = callsIn(wired).length;
  expect(sent).toBeGreaterThan(0);
  expect(sent).toBeLessThan(loop.HISTORY_LOW);
  expect(callsIn(wired).at(-1)).toBe('c14');
});

test('a request that does not fit even with one round kept is refused by name', () => {
  const fit = loop.fitter(4_000, 2000, 100);
  const h = history(2, 100);
  h[0] = { message: { role: 'system', content: 's'.repeat(20_000) } };
  expect(() => fit.wire(h, 2, 'state')).toThrow(/no longer fits the model's 4000-token window/);
});

test('the measured ratio replaces the first guess', () => {
  const fit = loop.fitter(12_000, 2000, 100);
  fit.measured(1, 1_000_000); // a tiny ratio: the whole chunk now fits
  const { wired } = fit.wire(history(15, 5000), 15, 'state');
  expect(callsIn(wired)).toHaveLength(15);
});

test('weather is an unreachable server, a 5xx, a 429; any other refusal is not', () => {
  expect(loop.isWeather(new sdk.CrucibleUnreachable('http://x', 'down'))).toBe(true);
  expect(loop.isWeather(new sdk.CrucibleServerError(502, 'upstream_error', 'bad gateway', null))).toBe(true);
  expect(loop.isWeather(new sdk.CrucibleRefused(429, 'rate_limited', 'slow down', null))).toBe(true);
  expect(loop.isWeather(new sdk.CrucibleRefused(400, 'invalid_request', 'bad', null))).toBe(false);
  expect(loop.isWeather(new Error('anything else'))).toBe(false);
});
