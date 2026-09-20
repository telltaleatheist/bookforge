/**
 * FOUNDRY AS A RUNNER — the five things PK6 moved, each measured where it moved.
 *
 * BookForge's 2026-09-20 bug hunt (docs/BUG-HUNT-2026-09-20.md §H) re-cut this
 * seam: when Foundry is hosted, BookForge's queue owns the whole lifecycle and
 * Foundry is *"given a DESCRIPTION of one act and a VENUE"*, which it plans,
 * places, spawns and answers with a typed OUTCOME. It stores nothing across
 * calls and decides nothing about when.
 *
 * Five claims follow from that, and each one closes a finding:
 *
 *   1. THE PRESS NAMES A ROW, NEVER A FILE (F1/F5). `identify*` composes the
 *      identity — the records file, the step, the stamp — and no path under
 *      `derived/`, because a derived book is unlinked at every settle and a
 *      request outlives its row's first attempt.
 *   2. THE SPAWN MAKES THE BOOK (F1). `materialize*` writes
 *      `derived/<uuid>.book.jsonl` when the run starts, out of the row the press
 *      pinned.
 *   3. A ROW THAT IS GONE IS A REFUSAL BY NAME, not a run against whatever is
 *      nearest.
 *   4. A BUSY CARD RETURNS `wait` IMMEDIATELY (Q4). No spin, no 30-second cap:
 *      the host parks its own row on its own clock, with the holder's sentence.
 *   5. `stopFoundry()` WAITS (P9). It answers the settle promise, so the host's
 *      45-second quit budget bounds something — including the DELETE that gives
 *      a Crucible lease back.
 *
 * ── Why this file is in `app/test/` ────────────────────────────────────────
 *
 * `hosted-shelf.test.ts` argues it in full: the repo's `test/` is compiled by the
 * ROOT tsconfig, and a test there importing `app/electron/*` drags the whole
 * main-process graph into a program built for the CLI.
 */
import { afterEach, beforeAll, expect, mock, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CleanRequest, RunPlacement } from '../shared/types';

const APP_DIR = path.dirname(import.meta.dir);

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-hosted-runner-test', name),
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
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  session: {},
  shell: {},
}));

type Queue = typeof import('../electron/job-queue');
type Workspace = typeof import('../electron/workspace');
type Dispatch = typeof import('../electron/crucible-dispatch');
type Engine = typeof import('../electron/engine');
type AppSettings = typeof import('../electron/app-settings');
type Mount = typeof import('../electron/mount');

let queue: Queue;
let workspace: Workspace;
let dispatch: Dispatch;
let engine: Engine;
let appSettings: AppSettings;
let mount: Mount;

beforeAll(async () => {
  queue = await import('../electron/job-queue');
  workspace = await import('../electron/workspace');
  dispatch = await import('../electron/crucible-dispatch');
  engine = await import('../electron/engine');
  appSettings = await import('../electron/app-settings');
  mount = await import('../electron/mount');
});

/** Every temp library a test built, swept when it ends. */
const libraries: string[] = [];

afterEach(async () => {
  mock.restore();
  while (libraries.length > 0) {
    const library = libraries.pop();
    if (library !== undefined) await fsp.rm(library, { recursive: true, force: true });
  }
});

/**
 * A PROJECT WITH A BOOK IN IT — the smallest thing a materialise can be about.
 *
 * `bookAtPosition` composes `readings/<key>.book.jsonl` and `ensureReadingBook`
 * hands it straight back when it is there, so a project with no reading STEP and
 * a book file on disk is a position whose chain is empty — which is exactly the
 * shape a first cleanup is pressed on.
 *
 * The input path is INSIDE the project, so `importDocument` recognises it as the
 * app's own and copies nothing (its first branch).
 */
async function projectWithABook(): Promise<{ library: string; dir: string; input: string }> {
  const library = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-hosted-runner-'));
  libraries.push(library);
  const key = 'runner-book-0badc0de';
  const dir = path.join(library, 'projects', key);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'generated'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      key,
      title: 'The Runner',
      stem: 'runner',
      createdAt: 0,
      archive: null,
      documents: [],
      working: { files: [] },
      final: [],
      reading: null,
    }),
    'utf8',
  );
  /*
   * THE RECEIPT THE BOOK IS A HASH OF. `openBookAtPosition` re-hashes the bank and
   * refuses a book whose foundation has moved, so the fixture writes the bank and
   * takes its own sha — the same sixteen characters the reflow would have written.
   */
  const bank = path.join(dir, 'readings', `${key}.jsonl`);
  await fsp.writeFile(bank, '{"page":1,"blocks":[]}\n', 'utf8');
  const bankSha = createHash('sha256').update(await fsp.readFile(bank)).digest('hex').slice(0, 16);
  const header = {
    book: 3,
    engine: 'foundry-test',
    language: 'en',
    source: { pages: 1, unreadable: [], bankSha },
    chapters: [],
    typography: null,
    seams: [],
    loose: { markers: [], notes: [] },
  };
  const text = 'The committee met on the first floor and adjourned before noon.';
  const rows = [{
    id: 'b1-1',
    category: 'Text',
    text,
    page: 1,
    pages: [1],
    box: { x1: 0, y1: 0, x2: 100, y2: 10 },
    pageWidth: 612,
    pageHeight: 792,
    parts: [{ src: 'p1-1', page: 1, chars: [0, text.length] }],
  }];
  fs.writeFileSync(
    path.join(dir, 'readings', `${key}.book.jsonl`),
    `${[JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`,
  );
  const input = path.join(dir, 'generated', 'runner.epub');
  await fsp.writeFile(input, 'not read by anything in this test', 'utf8');
  const real = appSettings.readAppSettings();
  spyOn(appSettings, 'readAppSettings').mockReturnValue({ ...real, libraryDir: library });
  return { library, dir, input };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2. The press names a row; the spawn makes the book
// ─────────────────────────────────────────────────────────────────────────────

test('identify names the records and the row, and no path under derived/', async () => {
  const { input } = await projectWithABook();
  const plan = await workspace.identifyCleanup(input);

  // WHAT IT MAKES: the answers file and the receipt beside it, both composed
  // from the project's own catalogue. Both are identity — the tree draws a card
  // for the step, and the dedupe compares the records path.
  expect(plan.recordsPath).toContain(`${path.sep}readings${path.sep}`);
  expect(plan.stampPath).toBeDefined();
  expect(plan.stepId).toMatch(/[0-9a-f-]{36}/);

  // WHAT IT DOES NOT MAKE, which is the whole of PK6: no book, no seed, no
  // generation — and nothing anywhere in the plan naming `derived/`.
  expect(plan.bookPath).toBeUndefined();
  expect(plan.seedRecords).toBeUndefined();
  expect(plan.generation).toBeUndefined();
  expect(JSON.stringify(plan)).not.toContain('derived');

  // AND THE ROW IS PINNED. This project has no steps, so `null` is the honest
  // answer and it is STATED — `materializeBook`'s own default, said out loud so
  // that "there was no row" and "nobody said" cannot look the same.
  expect(plan.at).toBe(null);
});

test('materialise writes derived/<uuid>.book.jsonl, and only when the run starts', async () => {
  const { input } = await projectWithABook();
  const before = await workspace.identifyCleanup(input);
  const plan = await workspace.materializeCleanup(input, null, before.stepId);

  expect(plan.bookPath).toBeDefined();
  expect(plan.bookPath!).toMatch(/derived.+\.book\.jsonl$/);
  expect(fs.existsSync(plan.bookPath!)).toBe(true);

  // THE IDENTITY IS THE PRESS'S, unchanged: the step id was handed back in, so
  // the second asking mints nothing new and the file, the row and the card on
  // the tree go on agreeing about which cleanup this is.
  expect(plan.stepId).toBe(before.stepId);
  expect(plan.recordsPath).toBe(before.recordsPath);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. A row that is gone is a refusal by name
// ─────────────────────────────────────────────────────────────────────────────

test('a request whose row never landed fails by name, and spawns nothing', async () => {
  const { input, dir } = await projectWithABook();
  const identified = await workspace.identifyCleanup(input);
  const spawned = spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('a run with no book must never reach the engine');
  });
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: { ...dispatch.UNPLACED, endpoint: 'http://127.0.0.1:9/openai', model: 'qwen' },
  });

  const request: CleanRequest = {
    kind: 'clean',
    inputPath: input,
    recordsPath: identified.recordsPath,
    stampPath: identified.stampPath!,
    stepId: identified.stepId,
    model: 'qwen',
    ollama: 'http://127.0.0.1:1',
    // THE ROW THIS WAS MADE FROM, and this ledger has never held it — a step
    // removed between the press and the spawn, or a chain the host ran out of
    // order. The old shape could not even ask the question: it carried a PATH.
    at: 'a-step-this-project-never-had',
  };
  const outcome = await queue.runJob(request);

  expect(outcome.outcome).toBe('failed');
  expect(outcome.outcome === 'failed' && outcome.error)
    .toContain('never landed');
  expect(spawned).not.toHaveBeenCalled();
  // AND NOTHING WAS WRITTEN FOR IT. A refusal leaves the project as it found it.
  expect(fs.existsSync(path.join(dir, 'derived'))).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. A busy card returns immediately
// ─────────────────────────────────────────────────────────────────────────────

test('a placement wait comes back at once, typed, with the holder\'s own line', async () => {
  const { input } = await projectWithABook();
  const identified = await workspace.identifyCleanup(input);
  const spawned = spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('a run that never placed must never spawn');
  });
  let asked = 0;
  spyOn(dispatch, 'placeJob').mockImplementation(async () => {
    asked += 1;
    return { verdict: 'wait', reason: '"the Mac" is leased by crucible-cli until 12:04', standing: false };
  });

  const started = Date.now();
  const outcome = await queue.runJob({
    kind: 'clean',
    inputPath: input,
    recordsPath: identified.recordsPath,
    stampPath: identified.stampPath!,
    stepId: identified.stepId,
    model: 'qwen',
    ollama: 'http://127.0.0.1:1',
    at: identified.at ?? null,
  }, { venue: { server: 'the Mac' } });

  expect(outcome.outcome).toBe('wait');
  expect(outcome.outcome === 'wait' && outcome.busyLine).toContain('leased');
  expect(outcome.outcome === 'wait' && outcome.standing).toBe(false);
  // ONE ASKING. The 30-second spin this replaced would have re-asked here.
  expect(asked).toBe(1);
  // AND IT CAME BACK NOW. The first backoff was three seconds, so anything under
  // a second is proof the loop is gone rather than merely quick.
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(spawned).not.toHaveBeenCalled();
  // A WAIT LEAVES NO ROW BEHIND: nothing ran, nothing was spent, and the host
  // will ask again when the card is free. Asked by the step this press promised,
  // because the queue's list is module state and other tests in this file have
  // rows of their own in it.
  expect(queue.listJobs().filter((row) => row.mints === identified.stepId)).toHaveLength(0);
});

test('the placement is announced once, before the spawn, with the venue and the lease', async () => {
  const { input } = await projectWithABook();
  const identified = await workspace.identifyCleanup(input);
  const placements: RunPlacement[] = [];
  let spawnedAfter = -1;
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: {
      ...dispatch.UNPLACED,
      slot: { name: 'the Mac', kind: 'crucible' } as never,
      endpoint: 'http://127.0.0.1:9/openai',
      model: 'qwen3',
      concurrency: 4,
      lease: { id: 'lease-7', release: async () => {} },
    },
  });
  spyOn(engine, 'runEngine').mockImplementation(() => {
    spawnedAfter = placements.length;
    return { done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), cancel: () => {} };
  });

  await queue.runJob({
    kind: 'clean',
    inputPath: input,
    recordsPath: identified.recordsPath,
    stampPath: identified.stampPath!,
    stepId: identified.stepId,
    model: 'qwen3',
    ollama: 'http://127.0.0.1:1',
    at: identified.at ?? null,
  }, { venue: { server: 'the Mac' }, onPlaced: (one) => { placements.push(one); } });

  expect(placements).toHaveLength(1);
  expect(placements[0]).toEqual({
    server: 'the Mac', model: 'qwen3', leaseId: 'lease-7', concurrency: 4,
  });
  // BEFORE THE SPAWN, which is the whole point: a record written after the child
  // exists can be missed by the kill it is for (BookForge's P8).
  expect(spawnedAfter).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The quit waits
// ─────────────────────────────────────────────────────────────────────────────

test('stopFoundry waits for the run to settle and for the lease to be given back', async () => {
  const { input } = await projectWithABook();
  const identified = await workspace.identifyCleanup(input);
  let released = false;
  let finish!: () => void;
  const engineIsDone = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    finish = () => { resolve({ code: 0, stdout: '', stderr: '' }); };
  });
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: {
      ...dispatch.UNPLACED,
      endpoint: 'http://127.0.0.1:9/openai',
      model: 'qwen3',
      lease: {
        id: 'lease-9',
        release: async () => {
          await new Promise((resolve) => { setTimeout(resolve, 10); });
          released = true;
        },
      },
    },
  });
  spyOn(engine, 'runEngine').mockReturnValue({ done: engineIsDone, cancel: () => finish() });

  const run = queue.runJob({
    kind: 'clean',
    inputPath: input,
    recordsPath: identified.recordsPath,
    stampPath: identified.stampPath!,
    stepId: identified.stepId,
    model: 'qwen3',
    ollama: 'http://127.0.0.1:1',
    at: identified.at ?? null,
  });
  // The run is alive: the engine's promise has not resolved.
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  expect(released).toBe(false);

  const stopped = mount.stopFoundry();
  finish();
  await stopped;
  /*
   * THE WHOLE OF P9. `stopFoundry` used to answer `Promise.resolve()`, so the
   * host's 45-second budget bounded nothing and the app exited while the DELETE
   * that releases the card was still a continuation nobody held.
   */
  expect(released).toBe(true);
  await run;
});
