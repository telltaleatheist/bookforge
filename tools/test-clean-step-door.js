/**
 * Tests for the headless Clean text door — `cli/clean-step.js`, the hosted
 * Foundry window's press with no window.
 *
 *   node tools/test-clean-step-door.js
 *
 * Three things are worth a test here, and they are the three ways this can be
 * wrong without anybody noticing until a benchmark has been mis-timed.
 *
 * THE ARGV, because the whole point of the door is that it spawns what the press
 * spawns. It is asked of Foundry's own `argsFor` — the function `executeJob`
 * uses — so a test that passed against a copy of the command line would be a test
 * of the copy. `--concurrency` and `--keep-model` are the two flags this wave
 * added, and both must be ABSENT when nobody said them: absent is the engine's own
 * default (4 blocks in flight; weights released at the end), and a default spelled
 * on this side would be a second place it lives.
 *
 * THE RESOLUTION, because "which project, standing where, with which model" is
 * every decision the door makes before it spawns anything. Driven end to end as a
 * subprocess `--dry-run` over a COPY of a real Foundry project in a temp library,
 * so the plan, the records path and the step id are the real ones.
 *
 * THE MODEL, because a door that quietly took `defaultLlmModel` would run the
 * cleanup on a 27b at a fifth of the rate. Unsaid, it is `cleanTextModel` out of
 * app-settings.json — the same setting the dialog seeds itself from.
 *
 * Nothing here loads a model, spawns the engine, or writes to the real library.
 */
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'cli', 'electron-stub.js');
const DOOR = path.join(REPO, 'cli', 'clean-step.js');

// ── Which Foundry build to ask ──────────────────────────────────────────────
// The vendored one is what the app executes and is therefore the one that
// matters; a vendored build older than this wave has no `argsFor`, and the
// checkout's own dist is then said out loud rather than substituted silently.
const VENDORED = path.join(REPO, 'foundry-app', 'dist');
const CHECKOUT = path.resolve(REPO, '..', 'foundry', 'app', 'dist');
function foundryDist() {
  for (const dir of [VENDORED, CHECKOUT]) {
    const jq = path.join(dir, 'electron', 'job-queue.js');
    if (!fs.existsSync(jq)) continue;
    if (typeof require(jq).argsFor === 'function') {
      if (dir !== VENDORED) {
        console.log(`  note: ${VENDORED} has no argsFor yet — testing against ${dir}.`);
      }
      return dir;
    }
  }
  console.error(
    'No Foundry build here exports `argsFor` from electron/job-queue.js — neither the vendored\n'
    + `${VENDORED} nor ${CHECKOUT}. Build the foundry app (npm run build:electron there) and\n`
    + 're-vendor it; the door refuses to compose an argv of its own and so does this test.');
  process.exit(1);
}
const FOUNDRY_DIST = foundryDist();
const { argsFor } = require(path.join(FOUNDRY_DIST, 'electron', 'job-queue.js'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-clean-door-'));
let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The command line, out of Foundry's own composer
// ─────────────────────────────────────────────────────────────────────────────

const BASE = {
  kind: 'clean',
  inputPath: '/lib/foundry/projects/p/working/book.pdf',
  bookPath: '/tmp/foundry/abc.book.jsonl',
  recordsPath: '/lib/foundry/projects/p/readings/p.clean.records.jsonl',
  stampPath: '/lib/foundry/projects/p/readings/p.clean.stamp.json',
  model: 'qwen3.5:9b-q8_0',
  ollama: 'http://localhost:11434',
  stepId: 'step-1',
};
const pairOf = (argv, flag) => (argv.indexOf(flag) < 0 ? null : argv[argv.indexOf(flag) + 1]);

test('the base line is the clean-text command the press spawns', () => {
  const argv = argsFor({ ...BASE });
  assert.strictEqual(argv[0], 'clean-text');
  assert.strictEqual(pairOf(argv, '--book'), BASE.bookPath);
  assert.strictEqual(pairOf(argv, '--records'), BASE.recordsPath);
  assert.strictEqual(pairOf(argv, '--stamp'), BASE.stampPath);
  assert.strictEqual(pairOf(argv, '--model'), BASE.model);
  assert.strictEqual(pairOf(argv, '--endpoint'), BASE.ollama);
});

test('--concurrency 8 rides across the seam onto the line', () => {
  assert.strictEqual(pairOf(argsFor({ ...BASE, concurrency: 8 }), '--concurrency'), '8');
});

test('no concurrency said means no flag at all — the engine keeps its own default', () => {
  assert.ok(!argsFor({ ...BASE }).includes('--concurrency'));
});

test('a concurrency that is not a whole number of blocks is not passed on', () => {
  for (const bad of [0, -2, 2.5, '8', null]) {
    assert.ok(!argsFor({ ...BASE, concurrency: bad }).includes('--concurrency'), String(bad));
  }
});

test('the model is released unless --keep-model says the machine is shared', () => {
  assert.ok(!argsFor({ ...BASE }).includes('--keep-model'));
  assert.ok(!argsFor({ ...BASE, keepModel: false }).includes('--keep-model'));
  assert.ok(argsFor({ ...BASE, keepModel: true }).includes('--keep-model'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The door itself, over a copy of a real project
// ─────────────────────────────────────────────────────────────────────────────

/** The library this machine is configured with, and a Foundry project inside it. */
function fixtureProject() {
  const cfg = path.join(require(STUB).USER_DATA, 'library-root.json');
  if (!fs.existsSync(cfg)) return null;
  const { libraryRoot } = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const projects = path.join(libraryRoot || '', 'foundry', 'projects');
  if (!fs.existsSync(projects)) return null;
  for (const key of fs.readdirSync(projects)) {
    const dir = path.join(projects, key);
    const manifest = path.join(dir, 'project.json');
    if (!fs.existsSync(manifest)) continue;
    const ledger = JSON.parse(fs.readFileSync(manifest, 'utf8')).ledger;
    // A project standing on its import offers no cleanup, and neither does the
    // dialog — so it is no fixture for this.
    const steps = ledger?.steps ?? [];
    if (steps.length > 1) return { libraryRoot, key, dir };
  }
  return null;
}

const fixture = fixtureProject();
if (fixture === null) {
  console.log('  skip: no Foundry project in this machine\'s library to copy — the resolution half\n'
    + '        of this test needs one real project, and it is not synthesised (a hand-made\n'
    + '        ledger would be a test of the fixture).');
} else {
  const lib = path.join(ROOT, 'library');
  const copied = path.join(lib, 'foundry', 'projects', fixture.key);
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.cpSync(fixture.dir, copied, { recursive: true });

  const dryRun = (extra) => execFileSync(
    process.execPath,
    ['--require', STUB, DOOR, '--foundry-project', copied, '--library', lib,
      '--foundry-dist', FOUNDRY_DIST, '--dry-run', ...extra],
    {
      cwd: REPO,
      encoding: 'utf8',
      /*
       * NOTHING IS NAMED FOR IT. `FOUNDRY_BIN` and `FOUNDRY_CLI_PATH` are both
       * cleared so the door does its own resolution — the prime, then
       * `resolveFoundryPath` — which is the thing the engine assertion below is
       * about. It spawns `--version` and nothing else.
       */
      env: (() => {
        const env = { ...process.env };
        delete env.FOUNDRY_BIN;
        delete env.FOUNDRY_CLI_PATH;
        return env;
      })(),
    },
  );

  test('the dry run resolves the project and prints the clean-text argv', () => {
    const out = dryRun(['--model', 'qwen3.5:9b-mlx-bf16', '--concurrency', '8']);
    const spawn = out.split('\n').find((line) => line.startsWith('[clean] spawn'));
    assert.ok(spawn, `no spawn line in:\n${out}`);
    for (const flag of ['clean-text', '--book', '--records', '--stamp', '--model', '--endpoint']) {
      assert.ok(spawn.includes(flag), `${flag} missing from: ${spawn}`);
    }
    assert.ok(spawn.includes('--concurrency 8'), `--concurrency 8 missing from: ${spawn}`);
    assert.ok(spawn.includes('--model qwen3.5:9b-mlx-bf16'), spawn);
    assert.ok(out.includes('DRY RUN'), 'the run did not say it spawned nothing');
    assert.ok(/position\s+\S+\s+\S+/.test(out), 'the position was not printed');
  });

  test('the model is released by default, and --keep-model is the opt-in', () => {
    const plain = dryRun([]);
    assert.ok(!plain.includes('--keep-model'), 'a plain run put --keep-model on the line');
    assert.ok(plain.includes('the weights are released'), plain);
    const kept = dryRun(['--keep-model']);
    const spawn = kept.split('\n').find((line) => line.startsWith('[clean] spawn'));
    assert.ok(spawn.includes('--keep-model'), spawn);
  });

  test('no --model said means app-settings cleanTextModel, never defaultLlmModel', () => {
    const settingsFile = path.join(require(STUB).USER_DATA, 'app-settings.json');
    const raw = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    /*
     * ASKED UNDER THE SHIM, because `readAppSettings` reads
     * `app.getPath('userData')` and plain node has no `app` — it would answer with
     * the declared default and this test would pass against a setting nobody has.
     */
    const stored = execFileSync(
      process.execPath,
      ['--require', STUB, '-e',
        `process.stdout.write(require(${JSON.stringify(path.join(FOUNDRY_DIST, 'electron', 'app-settings.js'))}).readAppSettings().cleanTextModel)`],
      { encoding: 'utf8' },
    ).trim();
    const out = dryRun([]);
    assert.ok(
      out.includes(`[clean] model            ${stored} (app-settings cleanTextModel)`),
      `expected the stored ${stored}; got:\n${out.split('\n').filter((l) => l.includes('model')).join('\n')}`,
    );
    if (typeof raw.defaultLlmModel === 'string' && raw.defaultLlmModel !== stored) {
      assert.ok(!out.includes(`--model ${raw.defaultLlmModel} `), 'the door reached for defaultLlmModel');
    }
  });

  test('the engine is the dev binary the app primes, not the installed component', () => {
    /*
     * THE TRAP THIS EXISTS FOR: the installed component on a developer's machine
     * is whatever release was last downloaded — here a foundry 1.0.2 from August
     * with no `--concurrency` — and a door that resolved to it would compose a
     * line the binary cannot run and only say so an hour into a benchmark. A CLI
     * run is a dev run, so it primes `FOUNDRY_CLI_PATH` exactly as `main.ts` does
     * under `isDev` before `resolveFoundryPath()` is asked.
     */
    const name = process.platform === 'win32'
      ? `foundry-windows-${process.arch}.exe`
      : `foundry-${process.platform}-${process.arch}`;
    const dev = [
      path.join('/Volumes/Callisto/Projects/foundry', 'dist', name),
      path.join(os.homedir(), 'Projects', 'foundry', 'dist', name),
    ].find((candidate) => fs.existsSync(candidate));
    if (dev === undefined) {
      console.log('       (no locally-built foundry on this machine — the prime has nothing to find)');
      return;
    }
    const out = dryRun([]);
    const engine = out.split('\n').find((line) => line.startsWith('[clean] engine  '));
    assert.ok(engine, `no engine line in:\n${out}`);
    assert.ok(engine.includes(dev), `expected the dev binary ${dev}; got: ${engine}`);
    // And it says which release answered, because a path cannot say that.
    assert.ok(/\[clean\] engine version\s+foundry \d+\.\d+\.\d+/.test(out),
      `the engine version was not named:\n${out}`);
  });

  test('a concurrency that is not a whole number is refused by name', () => {
    let said = '';
    try { dryRun(['--concurrency', '0']); }
    catch (err) { said = `${err.stdout || ''}${err.stderr || ''}`; }
    assert.ok(said.includes('not a whole number'), `expected a refusal; got: ${said}`);
  });
}

fs.rmSync(ROOT, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nclean-step door: all good');
