/**
 * A HOST ACT CAN SAY HOW IT STANDS AT A NODE (Owen, 2026-11-02): a cleanup that
 * built and used the pronunciation guide went on offering "Pronunciation guide"
 * on the step it made — *"that should already be done as part of that line
 * item."* The label is one per operation; whether it is done is per node, and
 * only the host knows, so an operation may register `stateAt` and the offer
 * says `stateful` (`host-ops:state`, electron/host-ops.ts).
 */
import { expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({
  app: { getPath: (name: string) => path.join(os.tmpdir(), 'foundry-host-op-state-test', name), on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  nativeImage: {},
  net: {},
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  screen: {},
  session: {},
  shell: {},
}));

const { hostOperationOffers, hostOperationStates, recordHostOperations } = await import('../electron/host-ops');

test('only an act that registered a state is stateful, and the function never crosses', () => {
  recordHostOperations([
    { id: 'h.guide', label: 'Pronunciation guide', kind: 'guide', appliesTo: 'book', invoke: () => {},
      stateAt: () => ({ done: true, label: 'Pronunciation guide ✓' }) },
    { id: 'h.narrate', label: 'Narrate', kind: 'narrate', appliesTo: 'book', invoke: () => {} },
  ]);
  const offers = hostOperationOffers();
  expect(offers.find((o) => o.id === 'h.guide')?.stateful).toBe(true);
  expect('stateful' in offers.find((o) => o.id === 'h.narrate')!).toBe(false);
  expect(offers.some((o) => 'stateAt' in o)).toBe(false);
});

test('states are keyed by operation, a null answer is left out, and the node is what is asked about', async () => {
  const asked: string[] = [];
  recordHostOperations([
    { id: 'h.guide', label: 'Pronunciation guide', kind: 'guide', appliesTo: 'book', invoke: () => {},
      stateAt: async (dir, node) => {
        asked.push(`${dir}|${node}`);
        return node === 'cleaned' ? { done: true, label: 'Pronunciation guide ✓', detail: 'Made with the guide on “Applied changes”' } : null;
      } },
  ]);
  expect(await hostOperationStates('/book', 'cleaned')).toEqual({
    'h.guide': { done: true, label: 'Pronunciation guide ✓', detail: 'Made with the guide on “Applied changes”' },
  });
  expect(await hostOperationStates('/book', 'import')).toEqual({});
  expect(asked).toEqual(['/book|cleaned', '/book|import']);
});

test('a host that throws is said on that tile, not swallowed, and the other acts still answer', async () => {
  recordHostOperations([
    { id: 'h.bad', label: 'Guide', kind: 'guide', appliesTo: 'book', invoke: () => {},
      stateAt: () => { throw new Error('the manifest is unreadable'); } },
    { id: 'h.ok', label: 'Other', kind: 'guide', appliesTo: 'book', invoke: () => {},
      stateAt: () => ({ done: true }) },
  ]);
  const states = await hostOperationStates('/book', 'x');
  expect(states['h.bad']?.detail).toContain('the manifest is unreadable');
  expect(states['h.bad']?.done).toBeUndefined();
  expect(states['h.ok']).toEqual({ done: true });
});
