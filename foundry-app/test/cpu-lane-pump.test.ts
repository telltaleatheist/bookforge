/**
 * THE PUMP PICKS A ROW ONCE — the regression test for the two crashes of
 * 2026-09-11, when a CPU-lane export became startable and BookForge died of a JS
 * heap out of memory within the minute.
 *
 * `pump` chooses rows in a synchronous `for (;;)`; nothing it awaits runs inside
 * that loop. `runInSlot` claims a slot and — since Wave 56 — awaits
 * `materializeDeferred` before anything marked the row running, so the picker
 * saw the same queued row with the same free lane and chose it again, forever.
 * The GPU lane has one slot and could not spin; the CPU lane has two and did.
 *
 * Both halves of the repair are asserted: the row is published RUNNING exactly
 * once (marked before the first await), and only one row for the work exists
 * when it settles (the picker skips a row that already holds a slot). If the
 * loop ever spins again this test does not fail politely — it is the same
 * synchronous loop and will exhaust the runner — which is the honest signal for
 * a defect whose symptom is exactly that.
 *
 * The deferred request names a project that does not exist, so materialising it
 * awaits and then fails: the await is what the test needs, and a failed row is
 * what lets it observe the row settle without an engine.
 */
import { beforeAll, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import type { GenerateRequest, Job } from '../shared/types';

const APP_DIR = path.dirname(import.meta.dir);

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-cpu-lane-pump-test', name),
    getName: () => 'Foundry',
    getVersion: () => '0.0.0-test',
    getAppPath: () => APP_DIR,
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

type Queue = typeof import('../electron/job-queue');
let queue: Queue;

beforeAll(async () => {
  queue = await import('../electron/job-queue');
});

const PROJECT = path.join(os.tmpdir(), 'foundry-cpu-lane-pump-test', 'projects', 'Nowhere-0000');

test('a cpu-lane row whose start awaits is picked once, marked running once, and settles as one row', async () => {
  const request: GenerateRequest = {
    kind: 'epub',
    inputPath: path.join(PROJECT, 'book.epub'),
    outputPath: path.join(PROJECT, 'final', 'Nowhere.epub'),
    readingsPath: path.join(PROJECT, 'readings.jsonl'),
    export: true,
    deferred: { from: 'step-that-never-landed' },
  };
  // Every publication is kept whole and read back afterwards: `changed()` fires
  // synchronously inside `enqueueHere`, before the row's id is in hand here.
  const published: Job[][] = [];
  queue.onQueueChanged((rows) => { published.push(rows); });
  const job = queue.enqueueHere(request, null);
  expect(job.after).toBeUndefined();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const now = queue.listJobs().find((row) => row.id === job.id);
    if (now !== undefined && (now.state === 'failed' || now.state === 'done')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  queue.onQueueChanged(() => {});

  const seen = published
    .map((rows) => rows.find((row) => row.id === job.id)?.state)
    .filter((state): state is Job['state'] => state !== undefined);
  const rows = queue.listJobs().filter((row) => row.id === job.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('failed');
  expect(seen.filter((state) => state === 'running')).toHaveLength(1);
  // And once running it was never published queued again — the second pick
  // would have shown up as exactly that. (The settled publication is not
  // asserted: a hosted shelf does not draw a failed row of ours, and whether
  // another file in this run has recorded a host is not this test's business.)
  expect(seen.lastIndexOf('queued')).toBeLessThan(seen.indexOf('running'));
});
