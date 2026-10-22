/**
 * A FAILED ROW WEARS THE ENGINE'S SENTENCE, NOT ITS STDERR.
 *
 * 2026-10-22: a 968-page reading failed at its model check, and the row's error
 * was the whole stderr — 968 `page N/968: rendered` lines with the one sentence
 * that mattered at the bottom. `engineSentence` takes the closing
 * `foundry: …` block; the full stderr still goes to the console.
 */
import { expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-engine-sentence-test', name),
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
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  session: {},
  shell: {},
}));

const { engineSentence } = await import('../electron/job-queue');

const RENDERS = Array.from({ length: 968 }, (_, i) => `  page ${i + 1}/968: rendered`).join('\n');

test('a reading that failed after its renders shows only the closing sentence', () => {
  const stderr = 'vlm-read: dots-ocr (http://127.0.0.1:7100/openai/v1)\n'
    + `${RENDERS}\n`
    + 'foundry: http://127.0.0.1:7100/openai/v1 is not serving "dots-ocr". It is serving: (nothing).\n';
  expect(engineSentence(stderr)).toBe(
    'http://127.0.0.1:7100/openai/v1 is not serving "dots-ocr". It is serving: (nothing).',
  );
});

test('a sentence over several lines, and a stack behind it, are kept whole', () => {
  const stderr = `${RENDERS}\nfoundry: first line\nsecond line\n    at read (read.ts:1:1)\n`;
  expect(engineSentence(stderr)).toBe('first line\nsecond line\n    at read (read.ts:1:1)');
});

test('the LAST foundry: line is the closing one', () => {
  expect(engineSentence('foundry: early\nmore\nfoundry: the end\n')).toBe('the end');
});

test('a child that died without a sentence shows its last line', () => {
  expect(engineSentence(`${RENDERS}\nSegmentation fault\n\n`)).toBe('Segmentation fault');
});

test('an empty stderr is empty, so the caller says there was nothing', () => {
  expect(engineSentence('  \n')).toBe('');
});
