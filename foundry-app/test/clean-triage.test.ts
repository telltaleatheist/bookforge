/**
 * THE CLEANUP'S TRIAGE, APP SIDE — the command line, the class, the progress
 * line, the chain, and the book it is handed.
 *
 * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
 * snap and then we bring snap down and load the full normal cleaning logic."* The
 * engine half is `foundry clean-triage` and `clean-text --triage` (test/clean/
 * triage.test.ts at the repo root); this file is what the app owes it:
 *
 *   * `argsFor` spells `clean-triage` against the placement's ENGINE address and
 *     model and refuses by name when there is no placement — and the cleanup's
 *     own line carries `--triage` exactly when its request does.
 *   * A triage is `decide` work, placed on a slot like every act that meets a
 *     model.
 *   * `clean-triage: n/m` is a count, its phase is `triage`, and its two summary
 *     lines are not counts.
 *   * STANDALONE, THE CLEANUP WAITS BEHIND ITS TRIAGE through the pump's one chain
 *     gate — released on its own it does not start — and goes when its triage is
 *     lost. A deferred cleanup defers its triage on the same promise.
 *   * A triage's spawn materialises the cleanup's book and never takes the export
 *     path, rotates nothing, and lands no step.
 *
 * No engine is spawned and no server is dialled: the placement and the engine are
 * spied, and the standalone chain runs against an empty registry, which refuses
 * every placement by name — exactly the ending the cascade needs to be seen.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CleanRequest, CleanTriageRequest, Job } from '../shared/types';

const SCRATCH = path.join(os.tmpdir(), 'foundry-clean-triage-test');

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

const dispatch = await import('../electron/crucible-dispatch');
const engine = await import('../electron/engine');
const workspace = await import('../electron/workspace');
const appSettings = await import('../electron/app-settings');
const projects = await import('../electron/projects');
const queue = await import('../electron/job-queue');

const libraries: string[] = [];

afterEach(async () => {
  mock.restore();
  while (libraries.length > 0) {
    const library = libraries.pop();
    if (library !== undefined) await fsp.rm(library, { recursive: true, force: true });
  }
});

/** A placement on a Crucible's `decide` class, leased — what the triage is spawned under. */
const PLACED: import('../electron/crucible-dispatch').Placement = {
  ...dispatch.UNPLACED,
  endpoint: 'http://127.0.0.1:7100/openai',
  origin: 'http://127.0.0.1:7100',
  model: 'qwen3.5-0.8b',
  door: 'openai',
  // The chat door's admission. It must NOT reach the triage's line.
  concurrency: 2,
};

const BOOK = path.join(SCRATCH, 'derived', 'the.book.jsonl');
const RECORDS = path.join(SCRATCH, 'readings', 'keeper.clean.records.jsonl');
const VERDICTS = path.join(SCRATCH, 'readings', 'keeper.clean.triage.json');

// ─────────────────────────────────────────────────────────────────────────────
// The command lines
// ─────────────────────────────────────────────────────────────────────────────

test('argsFor spells clean-triage against the engine address and model the placement chose', () => {
  const request: CleanTriageRequest = {
    kind: 'clean-triage', inputPath: path.join(SCRATCH, 'keeper.epub'), outputPath: VERDICTS,
    bookPath: BOOK, at: null,
  };
  expect(queue.argsFor(request, {}, PLACED)).toEqual([
    'clean-triage',
    '--book', BOOK,
    '--out', VERDICTS,
    '--endpoint', 'http://127.0.0.1:7100',
    '--model', 'qwen3.5-0.8b',
  ]);
  // The request's own depth is the only one that reaches the line.
  expect(queue.argsFor({ ...request, concurrency: 3 }, {}, PLACED).slice(-2))
    .toEqual(['--concurrency', '3']);
});

test('argsFor refuses a triage nothing placed, by name, rather than pointing it at nothing', () => {
  const request: CleanTriageRequest = {
    kind: 'clean-triage', inputPath: path.join(SCRATCH, 'keeper.epub'), outputPath: VERDICTS,
    bookPath: BOOK,
  };
  expect(() => queue.argsFor(request)).toThrow(/not placed on a Crucible server/);
  // And a triage that reached its command line without a book is refused by
  // `bookOf`'s sentence, like every other model pass.
  expect(() => queue.argsFor({ ...request, bookPath: undefined }, {}, PLACED))
    .toThrow(/was never made/);
});

test('the cleanup line carries --triage exactly when its request does', () => {
  const clean: CleanRequest = {
    kind: 'clean', inputPath: path.join(SCRATCH, 'keeper.epub'), bookPath: BOOK,
    recordsPath: RECORDS, stampPath: RECORDS.replace('.records.jsonl', '.stamp.json'),
    model: 'unused', ollama: 'unused', stepId: 'step-clean',
  };
  const plain = queue.argsFor(clean, {}, PLACED);
  expect(plain).not.toContain('--triage');
  const triaged = queue.argsFor({ ...clean, triagePath: VERDICTS }, {}, PLACED);
  expect(triaged.slice(-2)).toEqual(['--triage', VERDICTS]);
  // Nothing else about the line moved.
  expect(triaged.slice(0, -2)).toEqual(plain);
});

// ─────────────────────────────────────────────────────────────────────────────
// The class and the progress line
// ─────────────────────────────────────────────────────────────────────────────

test('a triage is decide work, and it is placed on a slot', () => {
  expect(dispatch.capabilityClassOf('clean-triage')).toBe('decide');
  expect(dispatch.placesOnASlot('clean-triage')).toBe(true);
  // The cleanup behind it is still clean work — two classes, two models.
  expect(dispatch.capabilityClassOf('clean')).toBe('clean');
});

test('clean-triage: n/m is a triage count, and its summary lines are not counts', () => {
  expect(engine.parseProgressLine('clean-triage: 412/2081'))
    .toEqual({ phase: 'triage', page: 412, total: 2081 });
  expect(engine.parseProgressLine(
    'clean-triage: 2081 position(s) in 90 group(s), asked of qwen3.5-0.8b at http://h:7100/v1/decide',
  )).toBeNull();
  expect(engine.parseProgressLine(
    'clean-triage: 312 of 2081 position(s) need cleaning; 1769 kept',
  )).toBeNull();
  // The cleanup's own line is still the cleanup's.
  expect(engine.parseProgressLine('clean-text: 3/4')).toEqual({ phase: 'clean', page: 3, total: 4 });
});

// ─────────────────────────────────────────────────────────────────────────────
// The chain, standalone
// ─────────────────────────────────────────────────────────────────────────────

function cleanRequest(tag: string, extra: Partial<CleanRequest> = {}): CleanRequest {
  const records = path.join(SCRATCH, 'readings', `${tag}.clean.records.jsonl`);
  return {
    kind: 'clean',
    inputPath: path.join(SCRATCH, `${tag}.epub`),
    recordsPath: records,
    stampPath: records.replace('.records.jsonl', '.stamp.json'),
    model: 'unused',
    ollama: 'unused',
    stepId: `step-${tag}`,
    at: null,
    ...extra,
  };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function row(id: string): Job | undefined {
  return queue.listJobs().find((job) => job.id === id);
}

test('standalone, the cleanup waits behind its triage and goes when the triage is lost', async () => {
  const { triage, clean } = queue.enqueueTriagedCleanup(cleanRequest('chain'), null);
  expect(triage).not.toBeNull();
  const check = triage!;
  expect(check.kind).toBe('clean-triage');
  expect(check.state).toBe('held');
  expect(check.title).toBe('Clean text — triage');
  expect(check.mints).toBeUndefined();
  // The verdicts are named from the records, beside them.
  expect(check.outputPath).toBe(path.join(SCRATCH, 'readings', 'chain.clean.triage.json'));
  expect(clean.kind).toBe('clean');
  expect(clean.after).toBe(check.id);

  // A second press is the same two rows, not two more.
  const again = queue.enqueueTriagedCleanup(cleanRequest('chain'), null);
  expect(again.clean.id).toBe(clean.id);
  expect(again.triage?.id).toBe(check.id);

  // THE GATE: released on its own, the cleanup does not start while its triage
  // is held. With no gate the pump would pick it and the empty registry would
  // fail it at placement within a tick.
  expect(queue.release(clean.id)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(row(clean.id)?.state).toBe('queued');

  // The triage goes, and cannot be placed (no engine is registered): it fails
  // by name, and the cleanup behind it is taken with it.
  expect(queue.release(check.id)).toBe(true);
  await until(() => row(check.id)?.state === 'failed', 'the triage to fail');
  await until(() => row(clean.id) === undefined, 'the cleanup to be cascaded away');
});

test('a cleanup pressed on a promise defers its triage on that promise and waits behind the triage', () => {
  // The promising row: an ordinary cleanup that will land step-promised.
  const promising = queue.enqueueTextPass(cleanRequest('promised', { stepId: 'step-promised' }), null);
  expect(promising.mints).toBe('step-promised');

  const deferred = cleanRequest('under-promise', {
    at: undefined,
    deferred: { from: 'step-promised' },
  });
  delete deferred.at;
  const { triage, clean } = queue.enqueueTriagedCleanup(deferred, null);
  // promise → triage → cleanup: one parent each.
  expect(triage?.after).toBe(promising.id);
  expect(clean.after).toBe(triage!.id);
});

test('a cleanup already queued without a triage is the answer, and no triage is minted', () => {
  const plain = queue.enqueueTextPass(cleanRequest('plain'), null);
  const before = queue.listJobs().length;
  const { triage, clean } = queue.enqueueTriagedCleanup(cleanRequest('plain'), null);
  expect(clean.id).toBe(plain.id);
  expect(triage).toBeNull();
  expect(queue.listJobs()).toHaveLength(before);
});

// ─────────────────────────────────────────────────────────────────────────────
// The spawn: the cleanup's book, not the export path
// ─────────────────────────────────────────────────────────────────────────────

/** A project the materialise can find, in a library of its own. */
async function aProject(): Promise<{ dir: string; verdicts: string }> {
  const library = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-clean-triage-lib-'));
  libraries.push(library);
  const dir = path.join(library, 'projects', 'triage-keeper-0badc0de');
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      key: 'triage-keeper-0badc0de',
      title: 'The Keeper',
      stem: 'keeper',
      createdAt: 0,
      archive: null,
      documents: [],
      working: { files: [] },
      final: [],
      reading: null,
    }),
    'utf8',
  );
  const real = appSettings.readAppSettings();
  spyOn(appSettings, 'readAppSettings').mockReturnValue({ ...real, libraryDir: library });
  return { dir, verdicts: path.join(dir, 'readings', 'keeper.clean.triage.json') };
}

test('a triage spawns on the cleanup book, never the export path, and lands no step', async () => {
  const { dir, verdicts } = await aProject();
  const release = mock(async () => {});
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: { ...PLACED, lease: { id: 'triage-lease', release } },
  });
  const made = spyOn(workspace, 'materializeCleanTriage').mockResolvedValue({ bookPath: BOOK });
  const exported = spyOn(workspace, 'materializeExport');
  const analysed = spyOn(workspace, 'materializeAnalysis');
  const rotated = spyOn(projects, 'rotateGenerated');
  const filed = spyOn(projects, 'rotateFinal');
  const stepped = spyOn(projects, 'recordTextPass');
  const reported = spyOn(projects, 'recordAnalysis');
  let spawned: string[] = [];
  spyOn(engine, 'runEngine').mockImplementation((args: string[]) => {
    spawned = args;
    return { done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), cancel: () => {} };
  });

  const outcome = await queue.runJob({
    kind: 'clean-triage', inputPath: path.join(dir, 'keeper.epub'), outputPath: verdicts, at: null,
  });
  expect(outcome.outcome).toBe('done');
  if (outcome.outcome !== 'done') return;
  expect(outcome.row.kind).toBe('clean-triage');
  expect(outcome.row.title).toBe('Clean text — triage');

  // THE BOOK: the cleanup's materialise, of the row the press pinned (null here).
  expect(made).toHaveBeenCalledTimes(1);
  expect(made.mock.calls[0]).toEqual([dir, null]);
  expect(exported).toHaveBeenCalledTimes(0);
  expect(analysed).toHaveBeenCalledTimes(0);
  // NOTHING ROTATED, NOTHING LANDED IN THE LEDGER.
  expect(rotated).toHaveBeenCalledTimes(0);
  expect(filed).toHaveBeenCalledTimes(0);
  expect(stepped).toHaveBeenCalledTimes(0);
  expect(reported).toHaveBeenCalledTimes(0);
  // The line the engine was handed, and the lease given back at the settle.
  expect(spawned).toEqual([
    'clean-triage', '--book', BOOK, '--out', verdicts,
    '--endpoint', 'http://127.0.0.1:7100', '--model', 'qwen3.5-0.8b',
  ]);
  expect(release).toHaveBeenCalledTimes(1);
});
