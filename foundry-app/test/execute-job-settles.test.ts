/**
 * EVERY ENDING SETTLES — the regression test for the two ways a run could end
 * with the queue never saying it had, both measured on 2026-09-18.
 *
 * `settled()` is the ONE place in electron/job-queue.ts that releases a Crucible
 * lease, clears the wait ledger and tells `onJobSettled`. So a run that ends
 * without reaching it is not a missing notification: it is a card claimed by a
 * process that has finished with it, held by a heartbeat that goes on renewing a
 * two-minute lease for the life of this process, and an `exportEpubFromStep`
 * that never resolves.
 *
 * TWO ENDINGS WERE MISSING, one on each side of the success test:
 *
 *   A THROW. `executeJob`'s docstring says *"Nothing is thrown from here"* and
 *   nothing enforced it, while five unguarded awaits sit after the lease is
 *   recorded — the landings, and `runEngine` itself, whose `engineCommand()`
 *   throws by design when the app folder has no engine bundle. Both callers
 *   wrap it in `try/finally` with NO catch, so the row stayed `running` for ever
 *   and the pump's `void runInSlot(…)` turned it into an unhandled rejection too.
 *
 *   A READING THAT WORKED. The `read` landing ended on `return` where every
 *   other landing ends on `settled(next)` — see the comment at that line for the
 *   history of how the call went missing.
 *
 * The engine is mocked both ways and no child is ever spawned: what is under
 * test is which of this file's own endings reach `settled`, not what an engine
 * does.
 *
 * ── AND SETTLING IS NOT THE WHOLE OF AN ENDING ──────────────────────────────
 *
 * The two tests below the first two are the same throw measured one layer out.
 * `carry` moves the previous output aside the instant before it spawns, on the
 * invariant the rotation block states about itself — A RUN THAT PRODUCES NOTHING
 * LEAVES THE CATALOGUE EXACTLY AS IT WAS — and the put-back used to be written by
 * hand on the cancel arm and the engine-failed arm and nowhere else. So the throw
 * above, which settles the row correctly, left the book in
 * `generated/archived-<stamp>/` with nothing in `generated/` at all: the exact
 * state `restoreRotation`'s own essay was written to end, reached from the one
 * direction nobody had enumerated.
 *
 * These two are on real disk rather than on a spy, because "the catalogue is as
 * it was" is a claim about files and only files can answer it. The library is a
 * temp directory, the project is two files, and the engine is mocked as above.
 *
 * ── AND THE TWO AT THE BOTTOM ARE WHAT THAT WORK LEFT OPEN ──────────────────
 *
 * Both were reported by the run that wrote the four above and fixed on their
 * own, and each says its own mechanism where it stands: an archive folder named
 * after the CLOCK refuses a second rotation inside one millisecond, and the ✕ on
 * a row whose engine has exited settles an ending the landing is about to settle
 * again.
 */
import { afterEach, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import { promises as filesystem } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Job } from '../shared/types';

mock.module('electron', () => ({
  app: {
    getPath: (name: string) => path.join(os.tmpdir(), 'foundry-execute-job-settles-test', name),
    getName: () => 'Foundry',
    getVersion: () => 'test',
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

/** The temp libraries the rotation tests below built, swept when each ends. */
const libraries: string[] = [];

afterEach(async () => {
  mock.restore();
  // The clock too: one test below freezes it to put two rotations in one
  // millisecond, and a frozen clock left behind would be every later test's.
  setSystemTime();
  while (libraries.length > 0) {
    const library = libraries.pop();
    if (library !== undefined) await fsp.rm(library, { recursive: true, force: true });
  }
});

/**
 * A reading placed on a Crucible, holding a lease — the shape the defect needs.
 * The bank is outside every project, so the landing's own `landReadProducts`
 * says so in the terminal and touches no disk (`projectDirOf` answers null).
 */
const BANK = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'outside-any-project.jsonl');
const SCAN = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'outside-any-project.pdf');
/** A rendering outside every project too, so nothing is rotated aside for it. */
const BOOK = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'outside-any-project.epub');

function placedWithALease(release: () => Promise<void>): void {
  spyOn(dispatch, 'placeJob').mockResolvedValue({
    verdict: 'go',
    placement: {
      ...dispatch.UNPLACED,
      endpoint: 'http://127.0.0.1:9/openai',
      model: 'dots-ocr',
      lease: { id: 'held-for-this-run', release },
    },
  });
}

/**
 * THE ROW, OUT OF THE TYPED OUTCOME `runJob` ANSWERS WITH (PK6).
 *
 * `done`, `failed` and `cancelled` all carry the settled row; `wait` carries no
 * row at all, because nothing ran — so a wait arriving in a test about endings is
 * the test's own premise failing and is raised by name rather than read as
 * `undefined.state`.
 */
async function ran(...asked: Parameters<typeof queue.runJob>): Promise<Job> {
  const outcome = await queue.runJob(...asked);
  if (outcome.outcome === 'wait') {
    throw new Error(`this run was never placed: ${outcome.busyLine}`);
  }
  return outcome.row;
}

/**
 * THE BOOK A RENDERING READS, ANSWERED WITHOUT A LEDGER (PK6).
 *
 * Since the identify/materialise split the run makes its own derived book at the
 * spawn (`materializeAtSpawn` → `materializeExport`), which needs a project with a
 * finished reading in it. Every test in this file is about what happens AROUND
 * that — the settle, the rotation, the one ending — and its fixture is a file in
 * the temp directory outside any project at all. So the materialise is answered
 * here, with the book the test wrote itself, which is exactly what the real one
 * would have handed back.
 */
function materialising(bookPath?: string): void {
  spyOn(workspace, 'materializeExport').mockResolvedValue(
    bookPath === undefined ? {} : { bookPath },
  );
}

/** Every ending this test heard, in the order it heard them. */
function listening(): { endings: Job[]; stop: () => void } {
  const endings: Job[] = [];
  const stop = queue.onJobSettled((row) => { endings.push(row); });
  return { endings, stop };
}

test('a run that throws after its placement fails the row, settles it once, and gives the lease back', async () => {
  const release = mock(async () => {});
  placedWithALease(release);
  // `engineCommand()`'s own refusal, which is what an app folder with no engine
  // bundle actually raises out of `runEngine` — a throw, not a failed exit.
  spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('no engine: engine/foundry-engine.cjs does not exist');
  });
  const { endings, stop } = listening();
  try {
    const row = await ran({
      kind: 'read', inputPath: SCAN, readingsPath: BANK, stepId: 'throws-after-placement',
    });
    expect(row.state).toBe('failed');
    expect(row.error).toBe('no engine: engine/foundry-engine.cjs does not exist');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'failed']]);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

test('a reading whose landing succeeds settles, so its lease and its waiter are not held for ever', async () => {
  const release = mock(async () => {});
  placedWithALease(release);
  spyOn(engine, 'runEngine').mockReturnValue({
    done: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    cancel: () => {},
  });
  // The catalogue write is somebody else's unit; what this test is about is the
  // line after it.
  spyOn(projects, 'recordReading').mockResolvedValue(undefined);
  const { endings, stop } = listening();
  try {
    const row = await ran({
      kind: 'read', inputPath: SCAN, readingsPath: BANK, stepId: 'landing-that-worked',
    });
    expect(row.state).toBe('done');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'done']]);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});

/**
 * A PROJECT WITH ONE RENDERING ALREADY IN IT — the state a rotation is about.
 *
 * The library is a fresh temp directory per test and `readAppSettings` is bent to
 * point at it, because `projectDirOf` resolves against `<libraryDir>/projects`
 * and a job whose output lands outside every project never rotates at all — which
 * would make both tests below pass for the wrong reason.
 */
async function projectHoldingAPreviousBook(): Promise<{
  output: string;
  generated: string;
}> {
  const library = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-rotation-putback-'));
  // Swept after the test, because a mkdtemp per run would otherwise leave one
  // library per test per suite run in the OS temp directory for ever.
  libraries.push(library);
  const dir = path.join(library, 'projects', 'rotation-keeper-0badc0de');
  const generated = path.join(dir, 'generated');
  await fsp.mkdir(generated, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      key: 'rotation-keeper-0badc0de',
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
  const output = path.join(generated, 'keeper.epub');
  await fsp.writeFile(output, 'the rendering that was already there', 'utf8');
  const real = appSettings.readAppSettings();
  spyOn(appSettings, 'readAppSettings').mockReturnValue({ ...real, libraryDir: library });
  return { output, generated };
}

/** The `archived-<stamp>` folders a rotation leaves behind, if any. */
async function archivesIn(generated: string): Promise<string[]> {
  return (await fsp.readdir(generated)).filter((name) => name.startsWith('archived-'));
}

test('a run that throws after rotating the previous output puts the rotation back', async () => {
  const { output, generated } = await projectHoldingAPreviousBook();
  placedWithALease(async () => {});
  materialising();
  // The same refusal as the first test: an app folder with no engine bundle,
  // which throws out of `runEngine` — one statement after the rotation.
  spyOn(engine, 'runEngine').mockImplementation(() => {
    throw new Error('no engine: engine/foundry-engine.cjs does not exist');
  });
  const { endings, stop } = listening();
  try {
    const row = await ran({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    expect(row.state).toBe('failed');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'failed']]);
    // THE WHOLE POINT: the book is where it was, and no archive folder was left
    // standing for a run that wrote nothing.
    expect(await fsp.readFile(output, 'utf8')).toBe('the rendering that was already there');
    expect(await archivesIn(generated)).toEqual([]);
  } finally {
    stop();
  }
});

test('a landing does not put its rotation back, because the product is filed', async () => {
  materialising();
  const { output, generated } = await projectHoldingAPreviousBook();
  placedWithALease(async () => {});
  // The engine writes where it was aimed, which is what makes this a landing
  // rather than the case above wearing a zero exit code.
  spyOn(engine, 'runEngine').mockImplementation(() => ({
    done: fsp.writeFile(output, 'the rendering this run made', 'utf8')
      .then(() => ({ code: 0, stdout: '', stderr: '' })),
    cancel: () => {},
  }));
  // The catalogue write is somebody else's unit, exactly as above.
  spyOn(projects, 'recordGenerated').mockResolvedValue(null);
  const restore = spyOn(projects, 'restoreRotation');
  const { endings, stop } = listening();
  try {
    const row = await ran({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    expect(row.state).toBe('done');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'done']]);
    expect(restore).toHaveBeenCalledTimes(0);
    // The new book stands and the old one is still in its archive folder.
    expect(await fsp.readFile(output, 'utf8')).toBe('the rendering this run made');
    expect(await archivesIn(generated)).toHaveLength(1);
  } finally {
    stop();
  }
});

/**
 * ── AND TWO ROTATIONS IN ONE INSTANT ARE TWO FOLDERS ────────────────────────
 *
 * The archive folder used to be named after the CLOCK alone, so two runs that
 * rotated inside one project in the same millisecond composed one name twice and
 * the second refused — before its engine started, with the previous output's own
 * sentence about mixing two runs' work into one folder. Nothing was lost, but a
 * job the person ordered simply did not happen, and which one lost the race was
 * the machine's speed rather than anything about the books.
 *
 * The clock is FROZEN here rather than raced, because "the same millisecond" is
 * the whole of the condition and a test that hoped for it would be a test that
 * passed on a slow morning.
 */
test('two rotations in one project in one instant both land, because the folder is named after the run', async () => {
  materialising();
  const { output, generated } = await projectHoldingAPreviousBook();
  const text = path.join(generated, 'keeper.txt');
  await fsp.writeFile(text, 'the text emission that was already there', 'utf8');
  setSystemTime(new Date('2026-09-18T19:42:04.512Z'));
  placedWithALease(async () => {});
  // The catalogue write is somebody else's unit; what this test is about is the
  // folder the rotation one line above it made.
  spyOn(projects, 'recordGenerated').mockResolvedValue(null);
  /** The engine writes where this run was aimed, which is what makes it a landing. */
  const aimedAt = (file: string, wrote: string): void => {
    spyOn(engine, 'runEngine').mockImplementation(() => ({
      done: fsp.writeFile(file, wrote, 'utf8').then(() => ({ code: 0, stdout: '', stderr: '' })),
      cancel: () => {},
    }));
  };
  const { endings, stop } = listening();
  try {
    aimedAt(output, 'the rendering this run made');
    const first = await ran({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    aimedAt(text, 'the text this run made');
    const second = await ran({
      kind: 'txt', inputPath: SCAN, outputPath: text, readingsPath: BANK,
    });
    // THE WHOLE POINT: the second run is not refused by the first run's folder.
    expect([first.state, second.state]).toEqual(['done', 'done']);
    expect(second.error).toBeUndefined();
    expect(endings.map((one) => one.state)).toEqual(['done', 'done']);
    // Two rotations, two folders, and each previous book is in its own.
    const archives = await archivesIn(generated);
    expect(archives).toHaveLength(2);
    const moved = await Promise.all(archives.map(async (name) => {
      const inside = await fsp.readdir(path.join(generated, name));
      return inside.join(',');
    }));
    expect(moved.sort()).toEqual(['keeper.epub', 'keeper.txt']);
    expect(await fsp.readFile(output, 'utf8')).toBe('the rendering this run made');
    expect(await fsp.readFile(text, 'utf8')).toBe('the text this run made');
  } finally {
    stop();
  }
});

/**
 * ── AND ONE RUN PUBLISHES ONE ENDING, WHOEVER PRESSES WHAT ──────────────────
 *
 * The ✕ on a `running` row with no live child of its own settles it `cancelled`,
 * which is right for the minutes a job spends waiting for the reading server and
 * was wrong for the window that opens the statement after the engine exits:
 * `wires.release()` gives the child up, and the row stays `running` across the
 * removal of the intermediate and of the derived book — two real disk operations
 * — before the landing writes `done` onto it.
 *
 * A ✕ pressed in there settled the row `cancelled`, swept the derived book and
 * told every listener; the landing then wrote `done` over it and settled it a
 * SECOND time. Two endings for one run, which is exactly what `onJobSettled`
 * promises never happens — `exportEpubFromStep` resolves on the first and
 * rejects on the second — and the cancel's cascade cancels the chain behind a
 * job whose product is on disk.
 *
 * The press is made from inside the derived book's own removal, because that is
 * the await the window is made of; hoping to hit it from a timer would be a test
 * that passed on a slow morning.
 */
test('a ✕ that arrives while the landing is in flight is refused, so one ending is published', async () => {
  const release = mock(async () => {});
  placedWithALease(release);
  /*
   * IN A PROJECT, BECAUSE SINCE PK6 A BOOK IS ONLY MADE FOR A RUN THAT IS IN ONE.
   * The materialise is still answered by the fixture below — this test is about
   * the sweep's own await and not about a replay — but a request outside every
   * project materialises nothing at all, and a run with no derived book has no
   * `rm` for the ✕ to arrive inside of.
   */
  const { output } = await projectHoldingAPreviousBook();
  // The book this run compiles, materialised for it and swept the moment the
  // engine is done with it — `sweepDerivedBook`, which is where the ✕ lands.
  const derived = path.join(os.tmpdir(), 'foundry-execute-job-settles-test', 'derived-book.jsonl');
  await fsp.mkdir(path.dirname(derived), { recursive: true });
  await fsp.writeFile(derived, 'the position this run was compiled from', 'utf8');
  // MADE AT THE SPAWN SINCE PK6, which is what puts it on the request at all —
  // and therefore what `sweepDerivedBook` unlinks, which is the await this whole
  // test presses its ✕ inside of.
  materialising(derived);
  spyOn(engine, 'runEngine').mockReturnValue({
    done: Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    cancel: () => {},
  });
  const pressed: string[] = [];
  /*
   * `electron/job-queue.ts` reaches the filesystem through `fs.promises` rather
   * than through `node:fs/promises`, and the two are different objects — a spy
   * on the wrong one is a test that never runs its own body.
   */
  const reallyRm = filesystem.rm;
  spyOn(filesystem, 'rm').mockImplementation(async (target, options) => {
    // ONCE, on the run's OWN sweep of it. `cancelHere` sweeps the same derived
    // book itself, so an unguarded press would fire again from inside the very
    // cancel this is measuring.
    if (String(target) === derived && pressed.length === 0) {
      // The row as the shelf sees it at this instant: still running, with no
      // child of its own — which is the state the ✕ acts on.
      const running = queue.listJobs().filter((row) => row.state === 'running');
      expect(running).toHaveLength(1);
      pressed.push(running[0]!.id);
      queue.cancelHere(running[0]!.id);
    }
    await reallyRm(target, options);
  });
  const { endings, stop } = listening();
  try {
    const row = await ran({
      kind: 'epub', inputPath: SCAN, outputPath: output, readingsPath: BANK,
    });
    // The ✕ was pressed on this row, mid-landing, and the ending that was
    // published is still the run's own — once, with the lease given back once.
    expect(pressed).toEqual([row.id]);
    expect(row.state).toBe('done');
    expect(endings.map((one) => [one.id, one.state])).toEqual([[row.id, 'done']]);
    expect(release).toHaveBeenCalledTimes(1);
  } finally {
    stop();
  }
});
