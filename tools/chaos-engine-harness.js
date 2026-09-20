/**
 * THE REAL QUEUE ENGINE, HEADLESS, WITH EVERY SEAM IT TALKS THROUGH INJECTED.
 *
 * `tools/test-chaos-book.js` is the keeper; this is the rig it stands on. It is
 * `test-queue-admission.js`'s harness (`fakeModule`, `fakeHost`, `fakeLeaseSeam`,
 * `fresh`, `enqueueSent`, `settle`, `jobOf`) carried here rather than imported,
 * because that file is a keeper — it runs its checks on require — and a fault
 * suite that loaded it would run somebody else's twelve hundred lines first.
 * What is shared is the SHAPE, deliberately: two suites driving the same engine
 * through the same seams should look the same, and a scenario written here can
 * be read by anyone who has read that one.
 *
 * What it adds is the chaos suite's own equipment:
 *
 *  - an `electron` stub installed BEFORE the engine graph is loaded, so the
 *    in-flight ledger, the server registry and the routing record all land in
 *    one temp userData and no scenario touches the real one;
 *  - `endStateOf(jobId)` — every step's status, error and park sentence in one
 *    object, which is what a FAILING scenario prints;
 *  - `waitUntil(fn)` — a clock a scenario drives instead of sleeping, so a park
 *    with a 40 ms cool-off is observed rather than guessed at;
 *  - `roundTrip()` — persist, configure again over the same directory, and hand
 *    back what came out, which is the "the queue survives a restart" assertion
 *    every scenario owes.
 *
 * Not a keeper itself: `run-keepers.js` runs only the `test-*` names it lists.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

/*
 * ── THE ELECTRON STUB, BEFORE ANY OF THE GRAPH IS LOADED ───────────────────
 *
 * Half the modules under `queue-steps/` import `electron` at module scope and
 * resolve their files through `app.getPath('userData')` at CALL time. One temp
 * directory per run: the in-flight ledger this suite writes is a REAL file,
 * because "the ledger is empty at the end" is one of the things under test.
 *
 * Every `getPath` name answers — a subdirectory named after it — rather than
 * the two the other fakes stub, because a chaos suite loads more of the graph
 * than a door keeper does and a throw from `getPath('logs')` would read as a
 * defect in the code under test.
 */
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chaos-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      const dir = path.join(WORK, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    getName: () => 'BookForge',
    getVersion: () => 'chaos',
    getAppPath: () => REPO,
    isPackaged: false,
    on: () => {},
    whenReady: async () => {},
    quit: () => {},
  },
  BrowserWindow: class { static getAllWindows() { return []; } isDestroyed() { return true; } },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  dialog: {},
  net: {},
  protocol: {},
  session: {},
  shell: {},
};

const realLoad = Module._load;
Module._load = function chaosLoad(request, ...rest) {
  if (request === 'electron') return electronStub;
  return realLoad.call(this, request, ...rest);
};

function built(rel) {
  return fs.existsSync(path.join(DIST, rel));
}

const engine = require(path.join(DIST, 'queue-engine.js'));
const routes = require(path.join(DIST, 'crucible', 'routes.js'));
const ledger = require(path.join(DIST, 'crucible', 'in-flight-ledger.js'));

const SCRATCH = path.join(WORK, 'state');
fs.mkdirSync(SCRATCH, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Let the scheduler's promise chain — the prober AND the reserve — settle.
 * Microtask turns, not a sleep: nothing here depends on wall-clock time.
 */
const settle = async (n = 40) => { for (let i = 0; i < n; i += 1) await wait(0); };

/**
 * Drive the clock until `fn()` is true, or give up and say what was true
 * instead. A scenario about a PARK is a scenario about time passing, and a
 * fixed sleep either makes the suite slow or makes it flaky.
 */
async function waitUntil(what, fn, { timeoutMs = 4000, everyMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await settle(4);
    let answer;
    try { answer = fn(); } catch { answer = false; }
    if (answer) return answer;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    }
    await wait(everyMs);
  }
}

/**
 * A step module whose run the scenario resolves by hand.
 *
 * `throws` is the fault: a function of the attempt number returning an ERROR to
 * reject with (the real refusal a door minted, wherever a scenario can get one)
 * or null to let the run stand and be resolved by hand. `autoResolve` finishes
 * a run the moment it starts, which is what every step a scenario is not
 * interested in should do.
 */
function fakeModule(type, opts = {}) {
  const runs = [];
  let attempt = 0;
  const mod = {
    type,
    consumes: opts.consumes === undefined ? null : opts.consumes,
    produces: opts.produces || 'epub',
    resource: opts.resource || (() => 'gpu'),
    stopIsResumable: opts.stopIsResumable === true,
    runs,
    /** How many times `run` has been entered — retries included. */
    get attempts() { return attempt; },
    run(ctx) {
      attempt += 1;
      const n = attempt;
      const record = { ctx, job: ctx.job, step: ctx.step, attempt: n, settled: false };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = (out) => {
          record.settled = true;
          resolve(out || { kind: mod.produces, path: `/out/${ctx.stepId}` });
        };
        record.reject = (err) => { record.settled = true; reject(err); };
      });
      runs.push(record);
      if (opts.onRun) opts.onRun(record, n);
      const fault = opts.throws ? opts.throws(n, ctx) : null;
      if (fault instanceof Error) {
        // On a later turn, so the step is `running` first — which is the state
        // `gpuHoldOf` and the venue rules are asked about.
        setTimeout(() => record.reject(fault), 0);
      } else if (opts.autoResolve !== false && !opts.hold) {
        setTimeout(() => record.resolve(opts.output), 0);
      }
      return record.promise;
    },
    cancel() { if (opts.onCancel) opts.onCancel(); },
  };
  if (opts.travels !== false) mod.machines = () => 'any';
  if (opts.leases === true) {
    mod.leasesModel = () => true;
    if (opts.act !== null) mod.crucibleClass = () => opts.act || 'clean';
  }
  return mod;
}

/** The routing record and the prober, scripted. See `test-queue-admission.js`. */
function fakeHost(initial) {
  const state = {
    ranked: initial.ranked || [],
    defaultWaitFor: initial.defaultWaitFor === undefined ? null : initial.defaultWaitFor,
    reach: initial.reach || {},
    asked: [],
  };
  state.host = {
    routing: () => ({ ranked: state.ranked.map((row) => ({ ...row })) }),
    defaultWaitFor: () => state.defaultWaitFor,
    async reach(name) {
      state.asked.push(name);
      const answer = state.reach[name];
      if (answer === undefined) return { reachable: false, detail: `Nothing answered at ${name}.` };
      return answer.reachable
        ? { reachable: true, busy: answer.busy === undefined ? null : answer.busy }
        : { reachable: false, detail: answer.detail };
    },
  };
  return state;
}

/** The lease seam, scripted, recording what admission asked of it and when. */
function fakeLeaseSeam(opts = {}) {
  const seam = {
    reserves: [],
    closed: [],
    scopes: [],
    held: new Map(),
    pending: [],
  };
  seam.host = {
    withRowScope(row, fn) { seam.scopes.push(row); return fn(); },
    async reserveRow(row, where) {
      seam.reserves.push({ row, ...where });
      const subject = { server: where.server, act: where.act };
      if (opts.holdOpen === true) {
        return new Promise((resolve, reject) => {
          seam.pending.push({
            row,
            grant: () => { seam.held.set(row, subject); resolve(); },
            refuse: (err) => reject(err),
          });
        });
      }
      const answer = opts.answer === undefined ? null : opts.answer({ row, ...where });
      if (answer instanceof Error) throw answer;
      seam.held.set(row, subject);
      return undefined;
    },
    async closeRow(row) { seam.closed.push(row); seam.held.delete(row); },
    leaseHeld(row) { return seam.held.get(row) || null; },
  };
  return seam;
}

/** A refusal in the shape the scheduler's one rule reads: `busyLine`. */
function refusedBusy(line) {
  return Object.assign(new Error(`crucible refused: ${line}`), { busyLine: line });
}

/** A refusal in Contract 1's shape: transport, and the sentence the row shows. */
function refusedTransient(line) {
  return Object.assign(new Error(line), { transient: true, transientLine: line });
}

/**
 * A fresh engine over a fresh state directory. Returns the directory, which is
 * what `roundTrip` configures over a second time.
 */
async function fresh(name, mods, host, seam, configureExtra = {}) {
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setGpuLockProbe(() => null);
  engine.setGpuHolderProbe(() => null);
  engine.setCrucibleRoutingHost(host === null ? null : host.host);
  engine.setCrucibleLeaseHost(seam === null ? null : seam.host);
  routes.forgetCrucibleRoutes();
  for (const row of (host === null ? [] : host.ranked)) {
    routes.noteCrucibleRoutes(row.name, { clean: 'local', translate: 'local', simplify: 'local' });
  }
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  await engine.configure({
    stateDir: dir, admissionRecheckMs: 40, heldJobRecheckMs: 40, reachSweepMs: 0, ...configureExtra,
  });
  return dir;
}

function jobOf(jobId) {
  return engine.snapshot().jobs.find((j) => j.id === jobId);
}

function stepOf(jobId, index) {
  return jobOf(jobId).steps[index];
}

function enqueueSent(spec) {
  const job = engine.enqueue(spec);
  if (job.pending === true) engine.sendToQueue(job.id);
  return job;
}

/**
 * EVERY STEP'S END STATE IN ONE OBJECT — what a failing scenario prints, and
 * what its assertions read. A status alone is not enough to tell a park from a
 * stall: the park SENTENCE is the difference between "waiting for the mac" and
 * a row sitting in the queue for no stated reason.
 */
function endStateOf(jobId) {
  const job = jobOf(jobId);
  if (job === undefined) return { missing: jobId };
  return {
    job: job.id,
    title: job.title,
    waitFor: job.waitFor,
    waitForResolved: job.waitForResolved,
    steps: job.steps.map((s) => ({
      id: s.id,
      type: s.type,
      label: s.label,
      status: s.status,
      error: s.error,
      lastError: s.lastError,
      wasInterrupted: s.wasInterrupted,
      hold: s.progress ? s.progress.admissionHold : undefined,
      venue: s.venue,
    })),
  };
}

/** Persist, configure again over the same directory, and hand back what loaded. */
async function roundTrip(dir, mods, host, seam) {
  await engine.persist();
  const before = engine.snapshot().jobs.map((j) => ({
    id: j.id,
    steps: j.steps.map((s) => ({ id: s.id, status: s.status })),
  }));
  engine.clearStepModules();
  for (const mod of mods) engine.registerStepModule(mod);
  engine.setCrucibleRoutingHost(host === null ? null : host.host);
  engine.setCrucibleLeaseHost(seam === null ? null : seam.host);
  await engine.configure({
    stateDir: dir, admissionRecheckMs: 40, heldJobRecheckMs: 40, reachSweepMs: 0,
  });
  const after = engine.snapshot().jobs.map((j) => ({
    id: j.id,
    steps: j.steps.map((s) => ({ id: s.id, status: s.status })),
  }));
  return { before, after };
}

/**
 * Stop everything this engine is running and forget it, between scenarios —
 * INCLUDING the in-flight ledger, which is ONE FILE in one userData and would
 * otherwise carry a row a scenario deliberately left behind into the next
 * scenario's assertion. Returns what it had to clear, so the runner can say a
 * leak belonged to the scenario that made it.
 */
async function quiesce() {
  try { engine.pause(); } catch { /* never configured */ }
  for (const id of engine.runningStepIds()) {
    try { await engine.cancel({ stepId: id }); } catch { /* it is going away */ }
  }
  await settle(10);
  const left = ledger.readInFlightLedger();
  for (const row of left) {
    try { ledger.settleInFlight(row.server, row.jobId); } catch { /* it is going away */ }
  }
  return left;
}

module.exports = {
  REPO, DIST, WORK, USER_DATA, SCRATCH, built,
  engine, routes, ledger,
  wait, settle, waitUntil,
  fakeModule, fakeHost, fakeLeaseSeam, refusedBusy, refusedTransient,
  fresh, jobOf, stepOf, enqueueSent, endStateOf, roundTrip, quiesce,
};
