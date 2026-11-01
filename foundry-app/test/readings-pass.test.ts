/**
 * THE HOST'S TWO NEW SEAMS ON A CLEANUP (2026-11-01).
 *
 *   * A readings-only pass (`CleanRequest.readingsOnly`) is spelled
 *     `clean-text --readings-only` with its readings and nothing that needs a
 *     server, is refused with no readings, and is titled in the host's words.
 *   * Its name is its identity: a readings pass and a cleanup made from one step
 *     are two rows, and the param survives a read of the ledger.
 *   * The host's section on the Clean text card is null with no host, and a host
 *     that names a starting choice it does not offer is refused by name.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CleanRequest } from '../shared/types';

const SCRATCH = path.join(os.tmpdir(), 'foundry-readings-pass-test');

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(SCRATCH, name),
    getName: () => 'Foundry',
    getVersion: () => '0.0.0-test',
    getAppPath: () => path.dirname(import.meta.dir),
    isPackaged: false,
    on: () => {},
    whenReady: async () => {},
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  nativeImage: {},
  net: {},
  protocol: {},
  session: {},
  shell: {},
}));

const queue = await import('../electron/job-queue');
const host = await import('../electron/host');
const ledger = await import('../shared/ledger');

afterEach(() => {
  mock.restore();
});

const BOOK = path.join(SCRATCH, 'derived', 'the.book.jsonl');
const RECORDS = path.join(SCRATCH, 'readings', 'keeper.clean.records.jsonl');
const STAMP = path.join(SCRATCH, 'readings', 'keeper.clean.stamp.json');
const READINGS = path.join(SCRATCH, 'readings', 'keeper.readings.json');

const PASS: CleanRequest = {
  kind: 'clean', inputPath: path.join(SCRATCH, 'keeper.epub'), bookPath: BOOK,
  recordsPath: RECORDS, stampPath: STAMP, model: 'm', ollama: 'http://x', at: null,
  readingsOnly: { label: 'Pronunciation applied' }, fixedReadings: READINGS,
};

test('a readings-only pass is spelled with its readings and nothing that needs a server', () => {
  // No placement at all: the pass asks nobody.
  expect(queue.argsFor(PASS)).toEqual([
    'clean-text', '--readings-only',
    '--book', BOOK,
    '--records', RECORDS,
    '--stamp', STAMP,
    '--fixed-readings', READINGS,
  ]);
  expect(queue.argsFor({ ...PASS, generation: 'g1' }).slice(-2)).toEqual(['--generation', 'g1']);
  const { fixedReadings: _gone, ...bare } = PASS;
  expect(() => queue.argsFor(bare)).toThrow(/no readings to write in/);
});

test('its name is part of which step it is, and survives a read of the ledger', () => {
  expect(ledger.translatedInto(undefined, undefined, 'Pronunciation applied')).toEqual({ readings: 'Pronunciation applied' });
  expect(ledger.translatedInto(undefined, undefined)).toEqual({});
  expect(ledger.PARAMS_OF.clean).toEqual(['readings']);
});

test('the host section is null with no host, and a starting choice it does not offer is refused', async () => {
  const ask = { kind: 'clean' as const, projectDir: SCRATCH, at: 's1', deferredFrom: null };
  expect(await host.hostPassOffer(ask)).toBeNull();
  host.recordHost({ libraryDir: SCRATCH, onExport: () => {} } as never);
  expect(await host.hostPassOffer(ask)).toBeNull();
  const offer = {
    label: 'L', note: 'N', chosen: 'use',
    choices: [{ id: 'use', label: 'Use it', detail: 'd', queues: [] }],
  };
  let seen: unknown = null;
  host.recordHost({ libraryDir: SCRATCH, onExport: () => {}, passOffer: async (a: unknown) => { seen = a; return offer; } } as never);
  expect(await host.hostPassOffer(ask)).toEqual(offer);
  expect(seen).toEqual(ask);
  host.recordHost({ libraryDir: SCRATCH, onExport: () => {}, passOffer: async () => ({ ...offer, chosen: 'nope' }) } as never);
  await expect(host.hostPassOffer(ask)).rejects.toThrow(/not one of its choices/);
  host.recordHost({ libraryDir: SCRATCH, onExport: () => {}, passOffer: async () => { throw new Error('boom'); } } as never);
  await expect(host.hostPassOffer(ask)).rejects.toThrow(/could not say what it has for this pass: boom/);
});
