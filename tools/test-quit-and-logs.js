#!/usr/bin/env node
/**
 * THE WAY OUT, THE WAY IN, AND THE EVIDENCE EITHER LEAVES BEHIND.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-quit-and-logs.js
 *
 * Four findings from the 2026-09-20 bug hunt whose rules are pure enough to
 * state here:
 *
 *  P1 — `electron:dev` ran `concurrently` with no `--kill-others`, so a normal
 *       ⌘Q ended Electron and left `ng serve` holding port 4250; the next
 *       launch died on it (seed failure S8).
 *  P4 — the audiobook job log captured `getLibraryRoot()` before the persisted
 *       root was restored, so a month of sessions went to
 *       `~/Documents/BookForge/logs` while the library's own `logs/` stops at
 *       2026-08-17.
 *  P5 — the Foundry CLI wrote to no file at all. `foundry.log` exists now, and
 *       every hosted run goes through one door that tees to it.
 *  P11 — `whenReady` had no `.catch`, so a throw before `createWindow()` left a
 *       windowless main process on darwin with no way out but a kill — and a
 *       kill skips `before-quit`, which is how a Crucible render is left
 *       holding a card for an app that no longer exists.
 *  Q4 — a hosted Foundry act refused by a HOLDER (Crucible `409 leased`) failed
 *       the row instead of parking it (Contract 2).
 *  PK11 — a keeper that `require`d the built queue engine wrote INVENTED
 *       failures into this machine's real `bookforge.log`, because the logger
 *       opened its file on the first line anybody wrote. It opens on `init()`
 *       now, which only the app calls.
 *  PK7 — and the correction to the round-2 list: `initWorkerLog(libraryPath)`
 *       was filed as P4's twin, but it never read that parameter in its life.
 *       `worker-output.log` is machine-local like every other streamed log, and
 *       must stay that way; the signature that said otherwise is gone.
 *
 * No electron, no network, no GPU.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
for (const built of ['startup-failure.js', 'audiobook-logger.js', 'rolling-logger.js']) {
  if (!fs.existsSync(path.join(DIST, built))) {
    console.log(skipLine(`dist/electron/${built} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}

let passed = 0;
const failures = [];
const queued = [];
const it = (name, run) => queued.push(async () => {
  try {
    await run();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 · the dev script stops everything it started
// ─────────────────────────────────────────────────────────────────────────────

it('P1: both dev scripts kill their siblings, with SIGTERM', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
  const dev = Object.entries(pkg.scripts)
    .filter(([, body]) => typeof body === 'string' && body.includes('concurrently'));
  assert.ok(dev.length >= 2, `both dev scripts must be found: ${dev.map(([k]) => k).join(', ')}`);
  for (const [name, body] of dev) {
    assert.ok(body.includes('--kill-others'),
      `${name}: concurrently 8's killOthers defaults to [], so a clean Electron exit leaves `
      + '`ng serve` holding port 4250 and the NEXT launch dies on it');
    assert.ok(body.includes('--kill-signal SIGTERM'),
      `${name}: SIGTERM, so ng serve gets to shut its watchers down rather than being SIGKILLed`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P11 · a startup that threw still draws something
// ─────────────────────────────────────────────────────────────────────────────

const startupFailure = require(path.join(DIST, 'startup-failure.js'));

it('P11: the failure names the STEP, not just the error', () => {
  const line = startupFailure.startupFailureLine('starting the queue', 'Unexpected token }');
  assert.ok(line.includes('starting the queue'),
    `"Unexpected token }" alone is not a report anybody can act on: ${line}`);
  assert.ok(line.includes('Unexpected token }'), line);
});

it('P11: an error with no message still says something', () => {
  const line = startupFailure.startupFailureLine('loading the plugins', '   ');
  assert.ok(line.includes('no reason given'), line);
  assert.ok(line.includes('loading the plugins'), line);
});

it('P11: the page escapes the message it is reporting', () => {
  const html = startupFailure.startupFailureHtml(
    'opening the window', '<script>alert(1)</script> at C:\\a & "b"');
  assert.ok(!html.includes('<script>'),
    'the message is an arbitrary Error.message — a thrown string holding markup must not '
    + `rewrite the page reporting it: ${html}`);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('&amp;') && html.includes('&quot;'), html);
  assert.ok(html.includes('opening the window'), html);
  // It must survive being made into a data: URL, which is how main loads it.
  assert.ok(decodeURIComponent(encodeURIComponent(html)) === html);
});

// ─────────────────────────────────────────────────────────────────────────────
// P5 · the Foundry CLI has a log
// ─────────────────────────────────────────────────────────────────────────────

it('P5: there is a foundry logger, and it is opened and closed with the rest', () => {
  const rolling = require(path.join(DIST, 'rolling-logger.js'));
  assert.strictEqual(typeof rolling.getFoundryLogger, 'function');
  const logPath = rolling.getFoundryLogger().getLogPath();
  assert.ok(/foundry\.log$/.test(logPath),
    `the hosted CLI's words go in a file of their own: ${logPath}`);
  assert.notStrictEqual(logPath, rolling.getMainLogger().getLogPath(),
    'bookforge.log is a STARTUP log and ends at the last startup line — that is the finding');

  const source = fs.readFileSync(path.join(REPO, 'electron', 'rolling-logger.ts'), 'utf-8');
  for (const fn of ['initializeLoggers', 'closeLoggers']) {
    const body = source.slice(source.indexOf(`export async function ${fn}`));
    assert.ok(body.slice(0, 400).includes('oundryLogger'),
      `${fn} must include the foundry log, or it is opened lazily and never flushed on quit`);
  }
});

it('P5: every hosted Foundry run goes through the ONE door that tees', () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'foundry-host-queue.ts'), 'utf-8');
  assert.ok(src.includes('getFoundryLogger'),
    'the tee lives in foundryRunner() — the single door — so no caller has to remember it');
  const job = fs.readFileSync(path.join(REPO, 'electron', 'queue-steps', 'foundry-job.ts'), 'utf-8');
  assert.ok(job.includes('foundryRunner()'),
    'and the step module still reaches the runner through that door');
});

// ─────────────────────────────────────────────────────────────────────────────
// Q4 · a Foundry row refused by a holder PARKS
// ─────────────────────────────────────────────────────────────────────────────

it('Q4: a Foundry row carrying a busyLine parks; one without it fails', () => {
  const hostQueue = require(path.join(DIST, 'foundry-host-queue.js'));
  const runtime = require(path.join(DIST, 'queue-steps', 'runtime.js'));

  const held = hostQueue.foundryRowFailure(
    { state: 'failed', error: 'Crucible refused the lease', busyLine: 'crucible@the-mac is rendering' },
    'Clean text');
  assert.strictEqual(runtime.busyLineOf(held), 'crucible@the-mac is rendering',
    'THE FINDING: Foundry takes its own Crucible lease, so a 409 crosses this seam as prose — '
    + 'and reddened a row in Needs you over a card that was merely held');
  assert.strictEqual(held.name, 'StepParked');

  const broke = hostQueue.foundryRowFailure({ state: 'failed', error: 'model not found' }, 'Clean text');
  assert.strictEqual(runtime.busyLineOf(broke), undefined,
    'a row that BROKE is still a failure a person must read');
  assert.strictEqual(broke.message, 'model not found', "and it wears Foundry's own sentence");

  const mute = hostQueue.foundryRowFailure({ state: 'failed' }, 'Clean text');
  assert.ok(/Clean text failed/.test(mute.message),
    `an engine that said nothing gets this side's label, and only then: ${mute.message}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 · the audiobook job log follows the library
// ─────────────────────────────────────────────────────────────────────────────

it('P4: registering the resolver touches NOTHING on the library', async () => {
  const logger = require(path.join(DIST, 'audiobook-logger.js'));
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-log-lazy-')), 'library');
  logger.useLibraryRoot(() => root);
  await logger.initializeLogger(root);
  assert.ok(!fs.existsSync(root),
    'P11 coupling: this runs before createWindow() and the library is an SMB volume — a mkdir '
    + 'here turns a wedged mount into a launch with no window. The first WRITE creates it.');
});

it('P4: the log lands under whichever library is current when it writes', async () => {
  const logger = require(path.join(DIST, 'audiobook-logger.js'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-log-move-'));
  const before = path.join(work, 'documents-default');
  const after = path.join(work, 'the-real-library');

  // Startup order, exactly: the root is the DEFAULT when the logger is wired.
  let current = before;
  logger.useLibraryRoot(() => current);
  await logger.initializeLogger(current);

  await logger.log('INFO', 'system', 'while the default root was current');
  const day = new Date().toISOString().split('T')[0];
  assert.ok(fs.existsSync(path.join(before, 'logs', `audiobook-${day}.log`)));

  // …and now the persisted root is restored, hundreds of lines later.
  current = after;
  await logger.log('INFO', 'system', 'after the library root was restored');

  const moved = path.join(after, 'logs', `audiobook-${day}.log`);
  assert.ok(fs.existsSync(moved),
    'THE FINDING (P4): the library\'s own logs/ ends 2026-08-17 because this path was captured '
    + 'once, before the root was restored, and the re-init door stopped being taken');
  assert.ok(fs.readFileSync(moved, 'utf-8').includes('after the library root was restored'));
  assert.ok(!fs.readFileSync(moved, 'utf-8').includes('while the default root'),
    'and nothing is re-written backwards: each line lands where the library was at the time');
});

// ─────────────────────────────────────────────────────────────────────────────
// PK7 · the worker log, and the signature that lied about it
// ─────────────────────────────────────────────────────────────────────────────

/*
 * NOT OPENED HERE, ON PURPOSE. `initWorkerLog` truncates the real
 * `worker-output.log` on this machine, so a keeper that called it would destroy
 * the evidence from the run somebody is debugging. The rule is structural and
 * is checked structurally.
 */

it('PK7: ONE module decides where this machine\'s logs go', async () => {
  const rolling = require(path.join(DIST, 'rolling-logger.js'));
  assert.strictEqual(typeof rolling.machineLogDirectory, 'function',
    'the directory is a named export, not a private method copied by each caller');
  const dir = rolling.machineLogDirectory();
  assert.ok(path.isAbsolute(dir) && /BookForge/.test(dir), dir);
  // The class must ask the same owner, or `worker-output.log` and `tts.log`
  // could drift apart on a platform nobody re-tested.
  assert.strictEqual(path.dirname(rolling.getMainLogger().logPath), dir,
    'the rolling loggers resolve through machineLogDirectory() too');
});

it('PK7: the worker log is machine-local, and no library path can move it', async () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
  const body = src.slice(src.indexOf('function initWorkerLog'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);

  assert.ok(/function initWorkerLog\(\): void/.test(fn),
    'THE FINDING (PK7): it took a `libraryPath` it has never once read, and the bug hunt\'s '
    + 'round-2 list filed the worker log as a twin of P4 on the strength of that signature');
  assert.ok(/machineLogDirectory\(\)/.test(fn),
    'the directory comes from the one owner, not a third hand-rolled platform switch');
  assert.ok(!/Library', 'Logs'|APPDATA|\.local/.test(fn),
    'and that third copy is gone');
  assert.ok(!/library|Library root|getLibraryRoot/i.test(fn.replace(/'Library'/g, '')),
    'MACHINE-LOCAL BY RULE: the library is one Syncthing tree shared by two machines, every '
    + 'write to it must be atomic, and this is a WriteStream that truncates at start — two '
    + 'BookForges would clobber one file and the survivor would belong to neither');

  assert.ok(/initWorkerLog\(\);/.test(src.slice(src.indexOf('function writeWorkerLog'))),
    'and it opens on demand, so no startup order can send a worker\'s output nowhere');
});


// ─────────────────────────────────────────────────────────────────────────────
// PK11 · the machine's log belongs to the app, not to whoever required a module
// ─────────────────────────────────────────────────────────────────────────────

/*
 * THE FINDING. PK1 gave `settleStep` a `logFailure()` through `getMainLogger()`
 * — the queue's first lines in `bookforge.log`, and right. But `write()` opened
 * the file lazily, so when the queue keepers drove the real engine they wrote
 * fabricated failures ("[QUEUE] Book — Narrate failed: the model would not
 * load") into Owen's own log at 18:01Z, among the night's real ones.
 *
 * These checks CREATE NOTHING and write nothing. The first proves the guard on
 * a logger with a name nothing else uses; the second proves it where it
 * actually bit, by measuring the real `bookforge.log` across a write — which is
 * a no-op when the rule holds and is the evidence when it does not.
 */

it('PK11: a logger nobody opened writes no file', async () => {
  const rolling = require(path.join(DIST, 'rolling-logger.js'));
  const name = `keeper-never-opened-${process.pid}-${Date.now()}`;
  const logger = new rolling.RollingLogger({ name, consoleOutput: false });
  const logPath = logger.getLogPath();
  assert.strictEqual(path.dirname(logPath), rolling.machineLogDirectory(),
    'it is aimed at the real log directory — that is the whole hazard');
  logger.error('a failure this process invented', { book: 'not a real book' });
  logger.info('and a line about nothing');
  // The write path is async; give it every chance to misbehave.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!fs.existsSync(logPath),
    `a logger that was never init()ed must not create ${logPath}. init() is the app's own `
    + 'declaration that it IS the app, and no test process can make it by accident');
});

it('PK11: and the real bookforge.log is untouched by one', async () => {
  const rolling = require(path.join(DIST, 'rolling-logger.js'));
  const logPath = rolling.getMainLogger().getLogPath();
  assert.ok(/bookforge\.log$/.test(logPath), logPath);
  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : null;

  rolling.getMainLogger().error(
    '[QUEUE] a book that does not exist — Narrate failed: a reason this keeper invented');
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = fs.existsSync(logPath) ? fs.statSync(logPath).size : null;
  assert.strictEqual(after, before,
    `THE FINDING: a keeper's invented failure grew ${logPath} by ${after - before} bytes. A log `
    + 'somebody debugs at 9am cannot contain a test\'s fabrications');
});

it('PK11: the rule is in the code, not in this file — write() has no lazy open', () => {
  const src = fs.readFileSync(path.join(REPO, 'electron', 'rolling-logger.ts'), 'utf-8');
  const write = src.slice(src.indexOf('private async write('));
  const body = write.slice(0, write.indexOf('\n  }\n') + 5);
  assert.ok(!/await this\.init\(\)/.test(body),
    'the lazy open IS the defect: any process that requires a built module could write into '
    + 'this machine\'s log directory');
  assert.ok(/toConsole/.test(body),
    'a dropped line goes to the console, where whoever is running the harness is looking — '
    + 'it is not swallowed');
  // And the one caller that opens a log of its own still says so out loud.
  const textServer = fs.readFileSync(path.join(REPO, 'electron', 'text-server.ts'), 'utf-8');
  assert.ok(/fileLog\.init\(\)/.test(textServer),
    'text-server.ts builds its own RollingLogger and never called init(); with no lazy open it '
    + 'has to declare itself, or `text-server.log` would silently stop existing');
});

(async () => {
  console.log('quit, startup and the evidence they leave behind');
  for (const run of queued) await run();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
