#!/usr/bin/env node
/**
 * Tests for electron/foundry-host-queue.ts — BookForge's queue, as the hosted
 * Foundry window sees it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-host-queue.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Owen's ruling of 2026-08-18 moved scheduling across a seam: a press inside the
 * hosted Foundry window mints a row HERE and runs through this engine. The seam
 * was designed over the switchboard with Foundry's agent, and in the course of
 * one evening FIVE defects were found in it by reading — none by a test, on any
 * of three machines. Four of the five live in the behaviour below.
 *
 * That is the argument for this file. Reading found them once; nothing was
 * holding them found.
 *
 *  - THE ROW IS MINTED SYNCHRONOUSLY AND NOTHING STARTS ON THAT STACK. Foundry's
 *    shelf requires the row back immediately ("pressing Add cannot leave a moment
 *    where nothing has appeared"), and our enqueue ends `changed(); pump();`
 *    inline — so without the deferred pump a step could begin executing inside
 *    the call, re-entering Foundry from inside its own enqueue.
 *  - THE DEDUPE CAME WITH THE SCHEDULING. Foundry's own enqueue refused a second
 *    row writing one output; once a press routes here that guard exists only if
 *    this side keeps it, and it would otherwise have been a hole nobody owned.
 *  - A PROJECT THAT LOSES ITS LAST ROW IS TOLD, ONCE. Their shelf mirrors one
 *    global list and replaces what it is told; silence leaves stale rows on it
 *    for the life of the window.
 *  - DRAIN IS ASKED AFTER THE PUMP HAS DECIDED. Asked on `changed()` it reads the
 *    trough between one step settling and the next starting, and Foundry's
 *    keep-warm default of 0 turns that into an immediate teardown — making a
 *    batch of N reads pay N model reloads.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-host-queue.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const engine = require(path.join(DIST, 'queue-engine.js'));
const host = require(path.join(DIST, 'foundry-host-queue.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-hostq-'));

/*
 * Armed ONCE, exactly as main does after the mount. The two listeners live on the
 * engine for the life of the process, so every test below shares them — which is
 * why each test uses its OWN project directory: the falling-edge bookkeeping is
 * keyed by project, and reusing one path would let one test's teardown be read as
 * another's news.
 */
host.watchFoundryQueue();

let passed = 0;
const failures = [];
const skipped = [];
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/**
 * A real foundry binary on this machine, or null.
 *
 * `FOUNDRY_CLI_PATH` first — a developer's own build wins, which is the bridge's
 * own rule — then the two places a dev checkout compiles one
 * (`electron/foundry-dev-cli.ts`'s candidates, spelled the BUILD's way: the
 * bun target is `windows` and Windows binaries carry `.exe`, while
 * `process.platform` says `win32`).
 */
function realFoundry() {
  const name = process.platform === 'win32'
    ? `foundry-windows-${process.arch}.exe`
    : `foundry-${process.platform}-${process.arch}`;
  const candidates = [
    process.env.FOUNDRY_CLI_PATH,
    path.join('/Volumes/Callisto/Projects/foundry', 'dist', name),
    path.join(os.homedir(), 'Projects', 'foundry', 'dist', name),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 12) => { for (let i = 0; i < n; i++) await wait(0); };

/** A `foundry-job` module whose run the test resolves by hand. */
function jobModule() {
  const runs = [];
  const mod = {
    type: 'foundry-job',
    consumes: null,
    produces: 'none',
    resource: (config) => (config.request.kind === 'read' ? 'gpu' : 'cpu'),
    stopIsResumable: true,
    runs,
    run(ctx) {
      const rec = { ctx, resolve: null, reject: null };
      rec.promise = new Promise((res, rej) => {
        rec.resolve = () => res({ kind: 'none' });
        rec.reject = rej;
      });
      runs.push(rec);
      return rec.promise;
    },
    cancel() { /* the signal is the cancel */ },
  };
  return mod;
}

async function fresh(name) {
  // A project nobody else in this file has used. The two listeners armed above
  // live for the whole process and their falling-edge bookkeeping is keyed by
  // project, so reusing a path would let one test's teardown read as another's
  // news. Every test calls fresh() first, so every PROJ below is its own.
  projectSeq += 1;
  PROJ = `Z:\bookforge\foundry\projects\Book-${projectSeq}`;
  engine.clearStepModules();
  const mod = jobModule();
  engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir });
  return mod;
}

let projectSeq = 0;
let PROJ = '';
const readRequest = (key = 'k1', project = PROJ) => ({
  kind: 'read',
  inputPath: `${project}\\archive\\book.pdf`,
  readingsPath: `${project}\\readings\\${key}.jsonl`,
  language: 'en',
});

// ── Progress goes home the way it arrived ────────────────────────────────────

test('a row with no progress reports NULL, not an object full of blanks', async () => {
  await fresh('progress-null');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  const row = host.foundryHostQueue.enqueue(readRequest(), null, PROJ);
  assert.strictEqual(row.progress, null,
    'their shelf draws "not started" differently from "0 of 0"');
});

test('the engine\'s own LINE comes back on the row as a count, through the REAL step module', async () => {
  // The whole round trip, because the bug spanned two files: the step module
  // divided the counts into a percentage and dropped them, and the row builder
  // hardcoded them undefined. The suite's fake module cannot show that — it
  // never calls the seam — so this one case registers the real one.
  //
  // AND THE FAKE BELOW WAS ITSELF WRONG, which is why this case is worth more
  // than it looks: written on 2026-08-20 it called `onProgress({done, total})`,
  // a shape Foundry has never sent. It passed, because both sides of it were my
  // own belief. Foundry's declaration is `(line: string) => void` and always
  // was, so the fake now hands over the STRING their engine writes.
  await fresh('progress-counts');
  engine.clearStepModules();
  engine.registerStepModule(require(path.join(DIST, 'queue-steps', 'foundry-job.js')).foundryJobStep);

  let onProgress = null;
  host.setFoundrySeam({
    runJob: (_request, opts) => {
      onProgress = opts.onProgress;
      return new Promise(() => {}); // never settles; we only want the reporter
    },
    setQueueRows: null,
    drained: null,
  });

  // A RENDER rather than a read, kept as-is: this test is about PROGRESS, and a
  // render was the kind that arrived released back when the two differed.
  const row = host.foundryHostQueue.enqueue({
    kind: 'render',
    inputPath: `${PROJ}\\archive\\book.pdf`,
    outputPath: `${PROJ}\\final\\book.epub`,
  }, null, PROJ);
  engine.start();
  host.foundryHostQueue.start();
  await settle();

  assert.ok(onProgress, 'the real module called the seam and handed it a reporter');

  // A line that is NOT a count first: it becomes the note, and leaves the row
  // with no progress at all — which is a different statement from zero.
  onProgress('vlm-convert: page 12 SKIPPED — already in the bank');
  await settle();
  const [noted] = host.foundryHostQueue.rows(PROJ);
  assert.strictEqual(noted.progress, null, 'prose is not progress');
  assert.strictEqual(noted.note, 'vlm-convert: page 12 SKIPPED — already in the bank');

  onProgress('page 41/317: rendered');
  await settle();

  const [updated] = host.foundryHostQueue.rows(PROJ);
  assert.strictEqual(updated.progress.page, 41, 'their count went home, in their field');
  assert.strictEqual(updated.progress.total, 317);
  assert.strictEqual(updated.progress.phase, 'render', 'and it says which pass it counted');
  assert.strictEqual(updated.note, null, 'a count CLEARS the note — that is what makes it mean "since"');
  // And our own bar still derives from the same numbers.
  const step = engine.snapshot().jobs.flatMap((j) => j.steps).find((s) => s.id === row.id);
  assert.strictEqual(step.progress.percent, 13);
});

// ── The contract as FOUNDRY calls it ─────────────────────────────────────────
//
// Their job-queue sends host.enqueue(request, parentStep) — TWO arguments, the
// project derived from the request. This suite once called only our three-arg
// signature, which is how a row with projectDir undefined reached production
// and crashed every snapshot push after it (2026-08-19, first live routed
// enqueue). These cases test the derivation the wiring now performs.

test('projectDirFromRequest derives the project the way Foundry itself would', () => {
  const root = path.join(SCRATCH, 'projects-root');
  const project = path.join(root, 'My_Book');
  const derived = host.projectDirFromRequest(root, {
    kind: 'read',
    inputPath: path.join(project, 'archive', 'book.pdf'),
    readingsPath: path.join(project, 'readings', 'k1.jsonl'),
  });
  assert.strictEqual(derived, project);

  // A rendering names its file via outputPath, which wins as the identity path.
  const rendered = host.projectDirFromRequest(root, {
    kind: 'render',
    inputPath: path.join(project, 'archive', 'book.pdf'),
    outputPath: path.join(root, 'Other_Book', 'final', 'book.epub'),
  });
  assert.strictEqual(rendered, path.join(root, 'Other_Book'));
});

test('a request naming nothing under the projects root is REFUSED, not filed under undefined', () => {
  const root = path.join(SCRATCH, 'projects-root');
  assert.throws(
    () => host.projectDirFromRequest(root, {
      kind: 'read',
      inputPath: 'C:\\somewhere\\else\\book.pdf',
    }),
    /cannot be filed under a project/,
    'undefined here is the crash this function exists to prevent');
});

test('a persisted row with no projectDir does not crash the shelf push', async () => {
  // The wound tonight's live run took: a step minted through the two-arg call
  // sat in the queue with projectDir undefined, and every queue:changed pass
  // died at fold(undefined). Such a row is now treated as not-a-Foundry-row —
  // it runs and settles in OUR queue; it just cannot be filed on their shelf.
  const mod = await fresh('no-projectdir');
  const pushes = [];
  host.setFoundrySeam({
    runJob: null,
    setQueueRows: (dir, rows) => pushes.push({ dir, rows }),
    drained: null,
  });

  engine.enqueue({
    title: 'poisoned',
    release: false,
    steps: [{
      type: 'foundry-job',
      label: 'Read the pages',
      config: { type: 'foundry-job', request: readRequest(), parentStep: null, label: 'Read' },
      sourceRef: { kind: 'none' },
    }],
  });
  // The enqueue's own changed() already ran the listener; reaching here at all
  // is the assertion that fold(undefined) no longer throws. rows() must agree.
  assert.deepStrictEqual(host.foundryHostQueue.rows(PROJ), [],
    'a row that names no project belongs to no project');
});

// ── The row comes back, and nothing has started ─────────────────────────────

test('enqueue returns the row SYNCHRONOUSLY and starts nothing on that stack', async () => {
  const mod = await fresh('sync');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest(), null, PROJ);
  // The row exists before any await — this is Foundry's whole requirement.
  assert.ok(row && typeof row.id === 'string', 'no row came back');
  assert.strictEqual(row.state, 'queued', 'a read must arrive ready to be claimed');
  assert.strictEqual(
    mod.runs.length, 0,
    'a step began executing inside enqueue — the pump was not deferred, and this '
    + 're-enters Foundry from inside its own enqueue call',
  );
  /*
   * AND THEN IT RUNS. This used to assert the opposite — that nothing ran after
   * the await either, because a read arrived held. Reads arrive released now
   * (see foundryHostQueue.enqueue), so the deferred pump has something to claim,
   * and asserting the run is what keeps this test honest about the deferral: a
   * pump that never fired at all would also have satisfied the old assertion.
   */
  await settle();
  assert.strictEqual(mod.runs.length, 1, 'the deferred pump never claimed the released read');
});

test('EVERY kind arrives RELEASED — routing across the seam IS the commitment', async () => {
  await fresh('release');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const read = host.foundryHostQueue.enqueue(readRequest(), null, PROJ);
  const render = host.foundryHostQueue.enqueue({
    kind: 'epub',
    inputPath: `${PROJ}\\archive\\book.pdf`,
    outputPath: `${PROJ}\\final\\book.epub`,
    readingsPath: `${PROJ}\\readings\\k1.jsonl`,
  }, null, PROJ);

  /*
   * A READ USED TO ARRIVE HELD, and this test asserted it. Foundry's reasoning
   * was that hours of GPU must never be spent by the act of configuring them,
   * which is right in THEIR pane, where Add and Start are two gestures a step
   * apart in one window.
   *
   * It does not survive the crossing. Sending work into this queue is itself the
   * commitment (Owen, 2026-08-21: "if it makes it to the bookforge queue, it
   * means its ready to run"), so the hold asked a second time for a decision
   * already made — and a held step is invisible to the pump by construction (it
   * only ever claims `queued`). The result was a VLM read sitting on an idle
   * card behind a finished TTS job, waiting on a gesture that had happened.
   */
  assert.strictEqual(read.state, 'queued', 'a read must arrive ready to be claimed');
  assert.strictEqual(render.state, 'queued', 'a rendering must arrive ready to be claimed');
});

// ── The dedupe that moved across the seam ───────────────────────────────────

test('a second press for the same product returns the EXISTING row', async () => {
  await fresh('dedupe');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const first = host.foundryHostQueue.enqueue(readRequest('same'), null, PROJ);
  const second = host.foundryHostQueue.enqueue(readRequest('same'), null, PROJ);
  assert.strictEqual(
    second.id, first.id,
    'two rows now write one bank: the second run overwrites the first while the '
    + 'first is still reading, and the file on disk ends up neither',
  );
  assert.strictEqual(host.foundryHostQueue.rows(PROJ).length, 1, 'the shelf shows two rows for one file');
});

test('the dedupe folds the path — one Windows file spelled two ways is one row', async () => {
  await fresh('dedupe-fold');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const a = host.foundryHostQueue.enqueue(readRequest('Cased'), null, PROJ);
  const shouted = readRequest('Cased');
  shouted.readingsPath = shouted.readingsPath.toUpperCase().replace(/\\/g, '/');
  const b = host.foundryHostQueue.enqueue(shouted, null, PROJ);
  assert.strictEqual(b.id, a.id, 'a dedupe comparing spellings lets through the collision it exists to prevent');
});

// ── The three text passes (foundry 9f4ee4e) ─────────────────────────────────
//
// A simplify used to arrive as `kind: 'translate'` wearing a `rewrite`, and a
// narration cleanup did not exist. Owen's ruling of 2026-09-05 split them into
// three kinds on the wire, and their handoff calls the re-vendor REQUIRED rather
// than recommended for exactly this: a simplify sends the new kind from the
// moment the snapshot lands, whether or not this side learned the word.

/** A text pass as the hosted window sends one. Its product is its RECORDS file. */
const textPass = (kind, key = 't1', project = PROJ) => ({
  kind,
  inputPath: `${project}\\archive\\book.epub`,
  bookPath: `${project}\\readings\\bank.book.jsonl`,
  recordsPath: `${project}\\records\\${key}.records.jsonl`,
  ...(kind === 'clean' ? { stampPath: `${project}\\records\\${key}.stamp.json` } : {}),
  ...(kind === 'simplify' ? { rewrite: 'natural', to: 'en', from: 'en' } : {}),
  ...(kind === 'translate' ? { to: 'de', from: 'en' } : {}),
});

test('a text pass is identified by its RECORDS file — a clean names no outputPath at all', async () => {
  await fresh('textpass-product');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const first = host.foundryHostQueue.enqueue(textPass('clean', 'same'), null, PROJ);
  const second = host.foundryHostQueue.enqueue(textPass('clean', 'same'), null, PROJ);
  assert.strictEqual(
    second.id, first.id,
    'a clean has no outputPath, so reading one would give every clean an empty identity and '
    + 'dedupe it against nothing: two rows writing one records file, which is the collision '
    + 'the dedupe exists to prevent',
  );
  const other = host.foundryHostQueue.enqueue(textPass('clean', 'different'), null, PROJ);
  assert.notStrictEqual(other.id, first.id, 'two different records files are two honest rows');
});

test('a simplify and a translate over one book are TWO rows — different records, different acts', async () => {
  await fresh('textpass-siblings');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  const simplify = host.foundryHostQueue.enqueue(textPass('simplify', 'plain'), null, PROJ);
  const translate = host.foundryHostQueue.enqueue(textPass('translate', 'de'), null, PROJ);
  assert.notStrictEqual(simplify.id, translate.id);
});

test('the row says which ACT it is, because three of them are about one book', async () => {
  await fresh('textpass-label');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });

  const titleOf = (kind, key) =>
    host.foundryHostQueue.enqueue(textPass(kind, key), null, PROJ).title;

  // "Clean text" is Owen's own word, said the same in all three places a person
  // meets it (2026-09-05): Foundry's tile, its queue row, and — as "Cleaned for
  // narration" — the step in the history. A fourth spelling here would be this
  // side renaming an act it does not own.
  assert.match(titleOf('clean', 'c'), /^Clean text — book\.epub$/);
  assert.match(titleOf('simplify', 's'), /^Simplify — book\.epub$/);
  assert.match(titleOf('translate', 't'), /^Translate — book\.epub$/);
});

test('a STORED translate row carrying a rewrite is still read as the simplify it is', async () => {
  // A queue.json written before the split holds `kind: 'translate'` rows with a
  // `rewrite` on them. Reading a stored row for what it says is not a fallback;
  // calling every one of them a translation is what this sniff was added to end
  // (Owen, 2026-08-29).
  await fresh('textpass-legacy');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  const legacy = { ...textPass('translate', 'legacy'), rewrite: 'natural' };
  assert.match(
    host.foundryHostQueue.enqueue(legacy, null, PROJ).title,
    /^Simplify — book\.epub$/,
  );
});

test('the engine that has no clean-text is refused BY NAME, and nothing runs', () => {
  // The gate is checked in the step module, not at `enqueue`: that door is
  // synchronous by contract ("pressing Add cannot leave a moment where nothing
  // has appeared") and asking a binary its version is a spawn. So the row is
  // minted and refuses the instant its turn comes — before Foundry is asked to
  // spawn anything and before a model is loaded.
  const { foundryVersionAtLeast } = require(path.join(DIST, '..', 'shared', 'vlm', 'readings-bank.js'));
  assert.strictEqual(foundryVersionAtLeast('1.0.2', host.FOUNDRY_VERSION_FOR_CLEAN_TEXT), false);
  assert.strictEqual(foundryVersionAtLeast('1.1.0', host.FOUNDRY_VERSION_FOR_CLEAN_TEXT), true);
  assert.strictEqual(foundryVersionAtLeast('1.2.0', host.FOUNDRY_VERSION_FOR_CLEAN_TEXT), true);

  const said = host.foundryTooOldForCleanText('1.0.2');
  assert.ok(said.includes('1.0.2'), 'the refusal must name what IS installed');
  assert.ok(said.includes(host.FOUNDRY_VERSION_FOR_CLEAN_TEXT), 'and the version the command arrived in');
  assert.match(said, /Settings → Add-ons/, 'and where to fix it');
  assert.match(said, /Nothing was cleaned/, 'and that nothing ran — the readings-flag refusal\'s shape');
});

test('a clean-text count reaches the row in THEIR shape, through the REAL step module', async () => {
  /*
   * A `clean` row asks the installed binary its version before it runs, so this
   * case needs a real foundry — the gate above is what makes that true, and
   * stubbing it out here would test a step module this app does not have.
   * SKIPPED BY NAME on a machine without one rather than passed quietly.
   */
  const binary = realFoundry();
  if (binary === null) {
    skipped.push('a clean-text count reaches the row in THEIR shape — no foundry binary on this machine');
    return;
  }
  process.env.FOUNDRY_CLI_PATH = binary;
  await fresh('textpass-progress');
  engine.clearStepModules();
  engine.registerStepModule(require(path.join(DIST, 'queue-steps', 'foundry-job.js')).foundryJobStep);

  let onProgress = null;
  host.setFoundrySeam({
    runJob: (_request, opts) => new Promise((resolve) => {
      onProgress = opts.onProgress;
      setTimeout(() => resolve({ state: 'done' }), 0);
    }),
    setQueueRows: null,
    drained: null,
  });
  engine.start();
  const row = host.foundryHostQueue.enqueue(textPass('clean', 'prog'), null, PROJ);
  engine.start({ stepId: row.id });
  // The gate SPAWNS the binary to ask its version, so this waits on a real child
  // rather than on microtasks. A fixed `settle()` here read the step before the
  // spawn had returned and reported "never reached the seam" for a step that was
  // working — which is the version of this test that would have been committed.
  for (let i = 0; i < 200 && onProgress === null; i++) await wait(25);
  assert.ok(
    onProgress !== null,
    'the step never reached the seam — the ≥' + host.FOUNDRY_VERSION_FOR_CLEAN_TEXT
    + ' gate refused ' + binary + ', or the spawn failed',
  );
  onProgress('clean-text: 412/2081');
  await settle();
  const [after] = host.foundryHostQueue.rows(PROJ);
  assert.deepStrictEqual(
    after.progress, { page: 412, total: 2081, phase: 'clean' },
    'their shelf interpolates page and total off this object; a phase it does not carry is a bar '
    + 'that changed units mid-run',
  );
});

test('a FINISHED read does not block a fresh press — that is a person asking again', async () => {
  const mod = await fresh('dedupe-terminal');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const first = host.foundryHostQueue.enqueue(readRequest('again'), null, PROJ);
  engine.start({ stepId: first.id });
  await settle();
  assert.strictEqual(mod.runs.length, 1, 'the released read did not run');
  mod.runs[0].resolve();
  await settle();

  const second = host.foundryHostQueue.enqueue(readRequest('again'), null, PROJ);
  assert.notStrictEqual(second.id, first.id, 'a finished row is history, not a lock on ever doing it again');
});

// ── What Foundry's shelf is told ────────────────────────────────────────────

test('rows() is per project and carries the request\'s own identity', async () => {
  await fresh('rows');
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  const other = 'Z:\\bookforge\\foundry\\projects\\Other-Book-def456';

  host.foundryHostQueue.enqueue(readRequest('a'), null, PROJ);
  host.foundryHostQueue.enqueue(readRequest('b', other), null, other);

  const mine = host.foundryHostQueue.rows(PROJ);
  assert.strictEqual(mine.length, 1, 'rows() leaked another project\'s work');
  assert.strictEqual(mine[0].kind, 'read');
  assert.ok(mine[0].outputPath.endsWith('a.jsonl'), 'a read\'s identity is the BANK it fills');
  assert.strictEqual(host.foundryHostQueue.rows(other).length, 1);
});

test('a project that loses its last row is pushed an EMPTY list, exactly once', async () => {
  const mod = await fresh('empty-edge');
  const pushes = [];
  host.setFoundrySeam({
    runJob: null,
    setQueueRows: (dir, rows) => pushes.push({ dir, n: rows.length }),
    drained: null,
  });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('edge'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();
  await host.foundryHostQueue.clearFinished();
  await settle();

  const empties = pushes.filter((p) => p.n === 0);
  assert.ok(
    empties.length >= 1,
    'the shelf mirrors one global list and REPLACES what it is told; with no empty '
    + 'push it keeps this project\'s stale rows for the life of the window',
  );
  assert.strictEqual(empties.length, 1, 'emptiness is news once — repeating it is a heartbeat');
});

test('clearFinished sweeps FOUNDRY rows only — not the narration history next door', async () => {
  const mod = await fresh('clear');
  // A second module standing in for BookForge's own work.
  engine.registerStepModule({
    type: 'tts-conversion', consumes: null, produces: 'audio-session',
    resource: () => 'gpu', run: () => Promise.resolve({ kind: 'audio-session' }), cancel() {},
  });
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const tts = engine.enqueue({
    title: 'A narration', release: true,
    steps: [{ type: 'tts-conversion', label: 'TTS', config: {}, sourceRef: { kind: 'epub', path: '/b.epub' } }],
  });
  await settle();

  const row = host.foundryHostQueue.enqueue(readRequest('sweep'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();

  await host.foundryHostQueue.clearFinished();
  const left = engine.snapshot().jobs.map((j) => j.id);
  assert.ok(left.includes(tts.id), 'a press on Foundry\'s shelf swept a finished narration in another window');
  assert.strictEqual(host.foundryHostQueue.rows(PROJ).length, 0, 'the Foundry row was not swept');
});

// ── The drain signal ────────────────────────────────────────────────────────

test('drain is NOT said in the trough between one read ending and the next starting', async () => {
  const mod = await fresh('drain-batch');
  let drains = 0;
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: () => { drains += 1; } });
  engine.start();

  const a = host.foundryHostQueue.enqueue(readRequest('a'), null, PROJ);
  const b = host.foundryHostQueue.enqueue(readRequest('b'), null, PROJ);
  engine.start();               // release both — the batch gesture
  await settle();
  assert.strictEqual(mod.runs.length, 1, 'one GPU, one read at a time');

  mod.runs[0].resolve();        // A ends; B is queued and about to be launched
  await settle();

  assert.strictEqual(
    drains, 0,
    'drain was said between two reads. Foundry\'s keepServerWarmMinutes defaults to 0, '
    + 'so that is an immediate stopServer and B pays a full model reload — N reads, N starts',
  );
  assert.strictEqual(mod.runs.length, 2, 'B did not start');

  mod.runs[1].resolve();
  await settle();
  assert.strictEqual(drains, 1, 'the queue emptied of Foundry work and nobody said so');
  assert.ok(a.id !== b.id);
});

test('drain IS said when the queue keeps running non-Foundry work', async () => {
  const mod = await fresh('drain-mixed');
  let drains = 0;
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: () => { drains += 1; } });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('solo'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle();
  mod.runs[0].resolve();
  await settle();

  assert.strictEqual(
    drains, 1,
    'with no Foundry step running, the reading server must be told — otherwise it holds '
    + 'twenty gigabytes of VRAM against whatever the card is doing next',
  );
  await settle();
  assert.strictEqual(drains, 1, 'drain repeated without any Foundry work having run in between');
});

// ── The runner ──────────────────────────────────────────────────────────────

test('with no runJob the row FAILS WITH A SENTENCE — it does not fall back to Foundry', async () => {
  engine.clearStepModules();
  const real = require(path.join(DIST, 'queue-steps', 'foundry-job.js'));
  engine.registerStepModule(real.foundryJobStep);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  projectSeq += 1;
  PROJ = `Z:\bookforge\foundry\projects\Book-${projectSeq}`;
  const dir = path.join(SCRATCH, 'no-runner');
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({ stateDir: dir });
  host.setFoundrySeam({ runJob: null, setQueueRows: null, drained: null });
  engine.start();

  const row = host.foundryHostQueue.enqueue(readRequest('norunner'), null, PROJ);
  engine.start({ stepId: row.id });
  await settle(40);

  const step = engine.snapshot().jobs.flatMap((j) => j.steps).find((s) => s.id === row.id);
  assert.strictEqual(step.status, 'failed', 'a row with nothing to run it must fail, not sit or succeed');
  assert.match(
    step.error, /queue seam|runJob/i,
    'the refusal must name the missing seam; a silent skip is the fallback the ruling removed',
  );
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      failures.push({ name: t.name, err });
    }
  }
  try { await engine.shutdown(); } catch { /* nothing running */ }
  fs.rmSync(SCRATCH, { recursive: true, force: true });

  for (const f of failures) {
    console.error(`FAIL  ${f.name}\n      ${f.err && f.err.message}`);
  }
  for (const s of skipped) console.log(`SKIP  ${s}`);
  console.log(`foundry-host-queue: ${passed}/${tests.length} passed`);
  process.exit(failures.length === 0 ? 1 - 1 : 1);
})();
