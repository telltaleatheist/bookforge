/**
 * THE HOSTED SHELF DRAWS ONE ROW PER JOB — the regression test for the night one
 * Clean text drew two identical grayed cards.
 *
 * ── Why this file is in `app/test/` and not in `test/` ─────────────────────
 *
 * The repo's suite lives in `test/`, which the ROOT tsconfig compiles. A test
 * there that imports `app/electron/*` drags the whole main-process graph into a
 * program built for the CLI — different `noUnusedLocals`, different module
 * resolution — and reports a dozen errors in files that are green under the
 * config they are actually built with. `app/` is compiled by
 * `app/tsconfig.electron.json`, whose `include` is `electron/**` and `shared/**`
 * only, so a test beside them here is run by `bun test` (which scans the repo)
 * and typechecked by neither program, which is the honest trade: the gates keep
 * measuring what they were written to measure.
 *
 * ── The electron mock ──────────────────────────────────────────────────────
 *
 * `job-queue` reaches `app.getPath` through half of main, and `electron` outside
 * an Electron process is a path string rather than a module. The mock is the
 * smallest surface that lets the graph load; nothing under test touches it.
 *
 * The reading server needs none: a pump that finds nothing to do declares drain,
 * and `noteQueueIdle` answers immediately unless this process OWNS a server
 * (electron/vllm-server.ts) — which a test never does.
 */
import { beforeAll, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CleanRequest, GenerateRequest, Job } from '../shared/types';

const APP_DIR = path.dirname(import.meta.dir);

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-hosted-shelf-test', name),
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
type Host = typeof import('../electron/host');

let queue: Queue;
let host: Host;

beforeAll(async () => {
  // Imported after the mock is registered, and dynamically for that reason
  // alone: a static import would be hoisted above it.
  queue = await import('../electron/job-queue');
  host = await import('../electron/host');
});

const PROJECT = path.join(os.tmpdir(), 'foundry-hosted-shelf-test', 'projects', 'Twain-a1b2');

/** A host's own row for a text pass, exactly as `setHostQueueRows` receives it. */
function hostRow(id: string, mints: string): Job {
  return {
    id,
    inputPath: path.join(PROJECT, 'book.epub'),
    outputPath: path.join(PROJECT, 'records', `${mints}.json`),
    kind: 'clean',
    state: 'running',
    progress: { done: 4, total: 100 },
    title: 'Cleaned for narration',
    mints,
    parentStep: 'step-simplify',
    createdAt: Date.now(),
  };
}

/** The request the host hands back through the seam when its pump chooses that row. */
function cleanRequest(mints: string): CleanRequest {
  return {
    kind: 'clean',
    inputPath: path.join(PROJECT, 'book.epub'),
    recordsPath: path.join(PROJECT, 'records', `${mints}.json`),
    stampPath: path.join(PROJECT, 'records', `${mints}.stamp.json`),
    model: 'qwen3:8b',
    ollama: 'http://127.0.0.1:11434',
    stepId: mints,
  };
}

/**
 * ONE CLEAN TEXT, ONE CARD. The host's pump calls `runJob`, which mints a row of
 * its own for the host's row — same kind, same `mints`, same parent — and the
 * hosted shelf must publish the host's row alone. Both were published between
 * 2026-09-08 and 2026-09-11, and the tree drew a grayed card for each: two
 * "Cleaned for narration" siblings under one step, both running, both 4%.
 *
 * THE SIGNAL IS ALREADY ABORTED, which is how the row is inspected without an
 * engine: `runJob` mints, publishes, sees the abort and settles the row
 * `cancelled` without spawning anything. The publication under test is the one
 * from the mint — the exact list the versions tree walked.
 */
test('hosted: the row runJob mints is not drawn beside the host row it stands for', async () => {
  host.recordHost({
    libraryDir: PROJECT,
    onExport: () => {},
    hostQueue: {
      enqueue: () => { throw new Error('nothing in this test routes'); },
    },
  });
  const theirs = hostRow('host-row-1', 'step-clean-1');
  queue.setHostQueueRows(PROJECT, [theirs]);

  const published: Job[][] = [];
  let ourList: Job[] = [];
  queue.onQueueChanged((rows) => {
    if (published.length === 0) ourList = queue.listJobs();
    published.push(rows);
  });

  await queue.runJob(cleanRequest('step-clean-1'), {
    parentStep: 'step-simplify',
    signal: AbortSignal.abort(),
  });

  expect(published.length).toBeGreaterThan(0);
  for (const shelf of published) {
    expect(shelf.filter((row) => row.mints === 'step-clean-1').map((row) => row.id))
      .toEqual(['host-row-1']);
  }
  expect(queue.shelfJobs().filter((row) => row.mints === 'step-clean-1').map((row) => row.id))
    .toEqual(['host-row-1']);

  /*
   * AND THE TWIN IS REAL WORK THE WHOLE TIME. `listJobs` is what `foundryBusy`,
   * the delete guards and `shutdown` read, and a row hidden from them would be an
   * engine running inside a folder the app would say was safe to erase. Only what
   * is DRAWN changed.
   */
  expect(ourList.filter((row) => row.mints === 'step-clean-1')).toHaveLength(1);
  expect(ourList.some((row) => row.id === 'host-row-1')).toBe(false);
});

/**
 * AND THE DEFERRED EXPORT IS STILL DRAWN — the row 2026-09-08 was written for.
 *
 * An export the host orders through `exportEpubFromStep` enqueues on Foundry's
 * own queue and never reaches the host's `enqueue`, so NOTHING over there stands
 * for it: it is nobody's twin, and hiding it would put it back where it spent
 * that day — invisible in both windows and reachable by no gesture. It waits
 * behind the host's running clean (`after`), which is why nothing spawns here.
 */
test('hosted: an export ordered through the seam has no host twin and stays drawn', () => {
  const theirs = hostRow('host-row-2', 'step-clean-2');
  queue.setHostQueueRows(PROJECT, [theirs]);

  const request: GenerateRequest = {
    kind: 'epub',
    inputPath: path.join(PROJECT, 'book.epub'),
    outputPath: path.join(PROJECT, 'final', 'Twain — narration.epub'),
    readingsPath: path.join(PROJECT, 'readings.jsonl'),
    export: true,
    deferred: { from: 'step-clean-2' },
  };
  const ours = queue.enqueueHere(request, 'step-simplify');

  expect(ours.after).toBe('host-row-2');
  const shelf = queue.shelfJobs();
  expect(shelf.some((row) => row.id === ours.id)).toBe(true);
  expect(shelf.some((row) => row.id === 'host-row-2')).toBe(true);

  queue.remove(ours.id);
});
