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

/*
 * `--keep-model` IS NOT SPELLED ANYWHERE IN THE VENDORED APP, and this asks the
 * SOURCE rather than one composed line.
 *
 * The history, because the shape of this check is the whole of what was learned.
 * Foundry `646e8a1` (v1.3.0) retired the flag with the Ollama dialect and left
 * `if (request.keepModel === true) args.push('--keep-model')` standing in
 * `job-queue.ts`. This side found it by grepping the copy, reported it, and for
 * one vendor pinned it as a HAZARD — a test asserting the bad line was still
 * there, so that the day it went the message would say so. `81fdc30` is that
 * day: the push and `CleanRequest.keepModel` are both gone, the pin can never
 * fire again, and a pin that can never fire is noise pretending to be a guard.
 *
 * What replaces it is the question the pin was standing in for: can any request
 * this app can build reach the engine with a flag the engine refuses by name?
 * A `argsFor({keepModel: true})` call would answer only about a field that no
 * longer exists in the type — trivially true, and blind to the same mistake made
 * with a different spelling on a different act's line. The grep is not: it holds
 * the whole vendored `argsFor` and every line around it, and it fails the next
 * time a refresh brings the string back on ANY command.
 *
 * ── `--server` LEFT THIS LIST ON 2026-09-14, and it is a RULING, not a fix ──
 *
 * The `e6d5424` re-vendor made this test red on `electron/job-queue.ts ->
 * --server`, and the honest answer was not to make the list longer or the regex
 * cleverer: THE FLAG IS NOT RETIRED ANY MORE. Foundry's `527b0db` brought the
 * Ollama door back beside the OpenAI one and `76444fb` added Anthropic as a
 * third, so `--server` is a live flag on every text act — `src/commands.ts` at
 * `e6d5424` parses it (`--server takes <openai|ollama|anthropic>, not "..."`),
 * defaults it to `openai`, and prints it in every usage line. The vendored
 * `argsFor` composing `['--server', 'ollama']` and `['--server', 'anthropic']`
 * is therefore CORRECT, and a guard that failed on it was asserting a fact that
 * had expired.
 *
 * WHAT IT MEANS NOW IS NOT WHAT IT MEANT THEN, which is why this needed a read
 * rather than a delete. The `--server` that `646e8a1` retired was a picker
 * between "which kind of server does this machine talk to" (`vllm` vs
 * `ollama`), and it was retired because the answer became "one door, always".
 * The `--server` that came back names a WIRE DIALECT — three genuinely
 * different request shapes behind one act — which is the declared-never-sniffed
 * rule from Foundry's own commit message. Same six characters, a different
 * question.
 *
 * `--keep-model` and `--ollama` STAY, verified rather than assumed: at
 * `e6d5424` neither appears in the engine's `src/` as anything but prose
 * explaining its own retirement (`model-server.ts:353`, `ollama.ts:144`,
 * `run.ts:1430`, `commands.ts:687`). The `--keep-model` half of the assertion
 * below — the field, and the plain-run line — is untouched.
 */
test('the vendored app spells no flag the engine retired, on any line', () => {
  const vendored = path.join(REPO, 'foundry-app');
  // `--server` is NOT here any more; see the ruling in the docblock above.
  const retired = ['--keep-model', '--ollama'];
  const offenders = [];
  for (const rel of ['electron/job-queue.ts', 'shared/types.ts']) {
    const source = fs.readFileSync(path.join(vendored, rel), 'utf8');
    for (const flag of retired) {
      /*
       * THE FLAG AS A QUOTED STRING LITERAL, which is what reaches an argv —
       * and the quote characters are `'` and `"` ONLY, deliberately. A backtick
       * around a flag in those files is MARKDOWN IN A DOCBLOCK, and both files
       * are full of it precisely because they explain the retirement: an earlier
       * draft of this check included the backtick and failed on eight comments
       * saying the flag is gone. Matching prose would make the keeper unrunnable
       * the moment anybody documented the thing it guards.
       */
      if (new RegExp(`['"]${flag}['"]`).test(source)) offenders.push(`${rel} -> ${flag}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'the vendored app composes a flag foundry 646e8a1 (v1.3.0) refuses by name, so a request '
    + 'crossing the seam would die at the engine\'s argument parser before a block was read');
  // And the field itself is gone from the request shape, so nothing can ask.
  assert.ok(!/keepModel/.test(fs.readFileSync(path.join(vendored, 'shared/types.ts'), 'utf8')),
    'CleanRequest still declares keepModel, which is a door onto a flag that no longer exists');
  assert.ok(!argsFor({ ...BASE }).includes('--keep-model'));
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

  /*
   * ── THE VENUE THIS HALF OF THE SUITE IS ABOUT ─────────────────────────────
   *
   * Since rollout item 2.6 the clean act asks WHERE it runs before it composes
   * anything: the routing record's Crucible server, or the local engines. The
   * six tests below are about the LOCAL line — the app-settings endpoint, the
   * served-model assertion, the retired flags — so they pin that venue rather
   * than inheriting whatever this machine's record happens to say, which would
   * make them pass or fail on a setting that has nothing to do with them.
   *
   * Pinned with a userData OF ITS OWN (`$BOOKFORGE_USER_DATA`, honoured by the
   * shim), carrying a routing record with the legacy switch on. Owen's real
   * record, registry and tokens are neither read nor written. `app-settings.json`
   * IS copied across, because "whichever the machine is on" is exactly what the
   * model tests below assert and `storedSettings()` reads the real file.
   *
   * The Crucible venue gets its own test at the end, and the composition itself
   * is covered without a project by `tools/test-crucible-text-acts.js`.
   */
  const doorUserData = path.join(ROOT, 'userData');
  fs.mkdirSync(doorUserData, { recursive: true });
  for (const name of ['app-settings.json', 'tool-paths.json']) {
    /*
     * `app-settings.json` because "whichever the machine is on" is what the
     * model tests assert, and `tool-paths.json` because the reserved server
     * `local` is read out of the WSL guest this app is configured with — an
     * empty userData has no distro, and the venue test below would then be
     * measuring the fixture rather than the door.
     */
    const real = path.join(require(STUB).USER_DATA, name);
    if (fs.existsSync(real)) fs.copyFileSync(real, path.join(doorUserData, name));
  }
  /*
   * NO PER-ACT MODEL RECORD IS SEEDED ANY MORE (2026-09-14).
   *
   * `<userData>/crucible-models.json` used to be written here so the venue
   * test below walked PAST a "no model chosen" refusal. That record is
   * deleted: `GET /v1/capability` on the chosen server owns the act-to-model
   * mapping, because `crucible install` probed the card to make it. There is
   * nothing for a fixture to seed — the answer is the server's, and whichever
   * way it goes the seam refuses BY NAME before any spawn, which is the only
   * thing this suite asserts about it.
   */
  const writeRouting = (legacyLocalRender) => fs.writeFileSync(
    path.join(doorUserData, 'crucible-routing.json'),
    JSON.stringify({ order: [], disabled: [], newJobsWaitFor: 'top-ranked', legacyLocalRender }),
    'utf8');
  writeRouting(true);

  const doorEnv = () => {
    /*
     * NOTHING IS NAMED FOR IT. `FOUNDRY_BIN` and `FOUNDRY_CLI_PATH` are both
     * cleared so the door does its own resolution — the prime, then
     * `resolveFoundryPath` — which is the thing the engine assertion below is
     * about. It spawns `--version` and nothing else.
     */
    const env = { ...process.env, BOOKFORGE_USER_DATA: doorUserData };
    delete env.FOUNDRY_BIN;
    delete env.FOUNDRY_CLI_PATH;
    return env;
  };

  const dryRun = (extra) => execFileSync(
    process.execPath,
    ['--require', STUB, DOOR, '--foundry-project', copied, '--library', lib,
      '--foundry-dist', FOUNDRY_DIST, '--dry-run', ...extra],
    { cwd: REPO, encoding: 'utf8', env: doorEnv() },
  );

  /**
   * The same line, EXPECTED TO FAIL, with the refusal returned as text.
   *
   * `dryRun` throws on a non-zero exit and swallows the message into an Error,
   * which is the wrong shape for the one thing a refusal has to be tested on:
   * WHAT IT SAID. A run that unexpectedly SUCCEEDS is the failure here and is
   * reported as one, rather than being read as an empty refusal that passes
   * every `includes` on an empty string.
   */
  /**
   * THE COMPOSED COMMAND LINE, and only it.
   *
   * The whole dry run is asked about elsewhere, but "no retired flag is written"
   * is a question about the ARGV and nothing else — the door's own log legitimately
   * says the words `--server` and `--keep-model` while explaining that they are
   * retired, and a test that read the log would fail on the sentence that proves
   * the fix.
   */
  const spawnLine = (out) => {
    const line = out.split('\n').find((l) => l.startsWith('[clean] spawn'));
    assert.ok(line !== undefined, `the dry run printed no spawn line:\n${out}`);
    return line;
  };

  const refusalOf = (extra) => {
    try {
      const out = dryRun(extra);
      assert.fail(`${extra.join(' ')} was accepted and composed a run:\n${out}`);
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err;
      return `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`;
    }
    return '';
  };

  /**
   * What this machine's app-settings say, asked UNDER THE SHIM.
   *
   * `readAppSettings` reads `app.getPath('userData')` and plain node has no `app`
   * — it would answer with the declared defaults and every assertion below would
   * be about a setting nobody has.
   */
  const storedSettings = () => JSON.parse(execFileSync(
    process.execPath,
    ['--require', STUB, '-e',
      `const s = require(${JSON.stringify(path.join(FOUNDRY_DIST, 'electron', 'app-settings.js'))}).readAppSettings();`
      + `process.stdout.write(JSON.stringify({ llmServer: s.llmServer, cleanTextModel: s.cleanTextModel, vllmModel: s.vllmModel }))`],
    { encoding: 'utf8' },
  ).trim());

  /**
   * A model this machine will accept on `--model`.
   *
   * Under vLLM that is THE PROFILE'S SERVED NAME and nothing else: the door asserts
   * it (Owen, 2026-09-08 — "verify that when i run translate/simplify in foundry,
   * they will correctly use the 27b model in vllm and not the 9b"), and a tag from
   * the ollama world is refused by name. Under ollama any tag is a tag.
   */
  const acceptableModel = () => (storedSettings().llmServer === 'vllm'
    ? require(path.join(REPO, 'dist', 'electron', 'text-server.js')).profileForKind('clean').servedName
    : 'qwen3.5:9b-mlx-bf16');

  test('the dry run resolves the project and prints the clean-text argv', () => {
    const model = acceptableModel();
    const out = dryRun(['--model', model, '--concurrency', '8']);
    const spawn = out.split('\n').find((line) => line.startsWith('[clean] spawn'));
    assert.ok(spawn, `no spawn line in:\n${out}`);
    for (const flag of ['clean-text', '--book', '--records', '--stamp', '--model', '--endpoint']) {
      assert.ok(spawn.includes(flag), `${flag} missing from: ${spawn}`);
    }
    assert.ok(spawn.includes('--concurrency 8'), `--concurrency 8 missing from: ${spawn}`);
    assert.ok(spawn.includes(`--model ${model}`), spawn);
    assert.ok(out.includes('DRY RUN'), 'the run did not say it spawned nothing');
    assert.ok(/position\s+\S+\s+\S+/.test(out), 'the position was not printed');
  });

  test('under vLLM a --model that is not the profile\'s served name is REFUSED by name', () => {
    /*
     * THE FIRST OF THE TWO BELTS. Foundry proves the served id itself by asking
     * /v1/models — but only when the request NAMED a model, and `vllmModel` is
     * empty by default, which is exactly the case where a translation against a
     * 9B server would run and be recorded as a translation. So the host names it
     * first, and refuses anything else BEFORE a model is loaded.
     */
    if (storedSettings().llmServer !== 'vllm') {
      console.log('       skipped by name — this machine is set to ollama, where any tag is a tag.');
      return;
    }
    let out = '';
    try {
      dryRun(['--model', 'qwen3.5:9b-q8_0']);
      assert.fail('the door accepted a model this machine\'s profile does not serve');
    } catch (err) {
      out = `${err.stdout || ''}${err.stderr || ''}`;
    }
    assert.ok(/qwen3\.5:9b-q8_0/.test(out), out);
    assert.ok(/Qwen3\.5-9B-bf16/.test(out), out);
    assert.ok(/nothing was started/i.test(out), out);
  });

  test('--keep-model and --ollama are refused BY NAME, and never dropped', () => {
    const plain = dryRun([]);
    assert.ok(!plain.includes('--keep-model'), 'a plain run put --keep-model on the line');
    assert.ok(!plain.includes('--ollama'), 'a plain run put --ollama on the line');
    /*
     * A DROP IS THE ONE ANSWER THAT MUST NOT PASS. `--ollama http://elsewhere`
     * quietly ignored would run the job against the machine app-settings names
     * while the caller believed it went somewhere else, which is exactly what
     * the no-fallbacks rule is about. Both refusals must name the flag AND the
     * commit that retired it, so a reader can tell a decision from a parser
     * accident.
     */
    for (const argv of [['--keep-model'], ['--ollama', 'http://elsewhere:11434']]) {
      const refused = refusalOf(argv);
      assert.ok(refused.includes(argv[0]), `the refusal must name ${argv[0]}:
${refused}`);
      assert.ok(refused.includes('646e8a1'),
        `the refusal must name the commit that retired ${argv[0]}:
${refused}`);
      assert.ok(!refused.includes('[clean] spawn'),
        `${argv[0]} reached a composed command line instead of being refused:
${refused}`);
    }
  });

  /*
   * WHAT `--server` ON THE LINE HAS TO SATISFY NOW, replacing "it must not be
   * there at all" (2026-09-14, the `e6d5424` re-vendor).
   *
   * Both assertions this stands in for said `foundry 646e8a1 refuses --server;
   * nothing may write it`. That stopped being true: `527b0db` brought the
   * Ollama door back beside OpenAI and `76444fb` added Anthropic, so `--server`
   * names a WIRE DIALECT and the engine's own usage line spells
   * `[--server <openai|ollama|anthropic>]`. The vendored `argsFor` writes it,
   * correctly, and `cli/clean-step.js` composes through that same vendored
   * function by the standing "the CLI mirrors the app's code path" rule — so
   * the flag now appears on a line this keeper reads.
   *
   * Deleting the assertion would have cost the thing it was really protecting:
   * that this side never sends a dialect the engine cannot parse. So it asks
   * that instead — present or absent is the composer's business, but a value,
   * when there is one, must be one of the three the engine declares, and the
   * retired kinds (`vllm`, and the bare `--server` with nothing after it) are
   * refused by name. `vllm` is called out separately because it is the exact
   * word `646e8a1` deleted, and a settings row still holding it is the way it
   * would come back.
   */
  const DECLARED_DIALECTS = ['openai', 'ollama', 'anthropic'];
  function assertDeclaredDialect(line) {
    const said = /--server(?:\s+(\S+))?/.exec(line);
    if (said === null) return;
    const value = said[1];
    assert.ok(value !== undefined,
      `--server was written with nothing after it, which the engine refuses:\n${line}`);
    assert.ok(DECLARED_DIALECTS.includes(value),
      `--server ${value} is not one of the three dialects foundry e6d5424 declares `
      + `(${DECLARED_DIALECTS.join('|')}). "vllm" in particular is the kind 646e8a1 deleted; `
      + `the engine refuses it by name before a block is read:\n${line}`);
  }

  test('no --model said means app-settings cleanTextModel, never defaultLlmModel', () => {
    const settingsFile = path.join(require(STUB).USER_DATA, 'app-settings.json');
    const raw = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    /*
     * ASKED UNDER THE SHIM, because `readAppSettings` reads
     * `app.getPath('userData')` and plain node has no `app` — it would answer with
     * the declared default and this test would pass against a setting nobody has.
     */
    const stored = storedSettings();
    const out = dryRun([]);
    /*
     * WHICH PAIR THE MACHINE IS SET TO decides the line (foundry 19f5e70,
     * 2026-09-08): under `llmServer: 'vllm'` the model is THE TEXT-SERVER
     * PROFILE'S SERVED NAME — `vllmModel` is empty by default, meaning "whatever
     * the server serves", and the host fills that in from the profile it is about
     * to start rather than leaving the engine to find out (Owen, 2026-09-08:
     * "verify that ... they will correctly use the 27b model in vllm and not the
     * 9b"). Under ollama it is `cleanTextModel`, as it always was. This keeper
     * reads the REAL settings file, so it asserts whichever the machine is on.
     */
    if (stored.llmServer === 'vllm') {
      const served = require(path.join(REPO, 'dist', 'electron', 'text-server.js'))
        .profileForKind('clean').servedName;
      const modelLine = out.split('\n').find((l) => l.startsWith('[clean] model  '));
      assert.ok(modelLine && modelLine.includes('(text-server profile '),
        `expected the profile line; got:\n${modelLine}`);
      assert.ok(modelLine.includes(served), `expected ${served}; got: ${modelLine}`);
      assert.ok(out.includes(`--model ${served}`),
        'the served model the host is about to start must be ON the line');
      assert.ok(!/--model\s+["']?\s*(?:$|["'])/m.test(out), 'never an empty --model');
      assertDeclaredDialect(spawnLine(out));
      assert.ok(out.includes('(app-settings vllmUrl, chosen by llmServer)'),
        `the endpoint line must name the key it came from:
${out}`);
      // And WHOSE server the endpoint is, said before anything is started.
      assert.ok(/\[clean\] text server/.test(out), `the text-server route must be printed:\n${out}`);
    } else {
      assert.ok(
        out.includes(`[clean] model            ${stored.cleanTextModel} (app-settings cleanTextModel)`),
        `expected the stored ${stored.cleanTextModel}; got:\n${out.split('\n').filter((l) => l.includes('model')).join('\n')}`,
      );
      assertDeclaredDialect(spawnLine(out));
    }
    if (typeof raw.defaultLlmModel === 'string' && raw.defaultLlmModel !== stored.cleanTextModel) {
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

  /*
   * ── THE OTHER VENUE ───────────────────────────────────────────────────────
   *
   * `--crucible-server` sets the same field the app sets from a queue row, and
   * on an engine that cannot address a Crucible the act is refused BY NAME
   * before anything is composed — not 404ed an hour in, and never dropped
   * quietly onto llama-server. This is the CLI's half of the gate; the
   * composition itself is `tools/test-crucible-text-acts.js`.
   *
   * The switch is turned off for this one and back on after, because the two
   * venues are two states of one record and a test that left it changed would
   * be the next test's fixture.
   */
  test('--crucible-server names the venue, and the dry run composes the Crucible line', () => {
    writeRouting(false);
    let said = '';
    try { said = dryRun(['--crucible-server', 'local']); }
    catch (err) { said = `${err.stdout || ''}${err.stderr || ''}`; }
    finally { writeRouting(true); }
    /*
     * A MACHINE WITHOUT A LOCAL CRUCIBLE IS A NAMED STATE, not a failure of
     * this test: `local` is read from the server's own config.toml (through
     * WSL on Windows), and a box that has none says so. Skipped by name
     * rather than passed quietly, exactly as the fixture is above.
     */
    if (/no_local_config|no WSL distro|no crucible server named/.test(said)) {
      console.log('       (no local Crucible on this machine — the venue half is skipped)');
      return;
    }
    /*
     * A model not chosen or not resident is ALSO a pass for this test: both
     * are the seam refusing by name, before any spawn, which is what the
     * flag exists to reach. What must never happen is the run composing a
     * line against the LOCAL endpoint while the flag named a server.
     */
    if (/crucible_text_model_not_set|crucible_model_not_resident|crucible_unknown_model/.test(said)) {
      assert.ok(!said.includes('[clean] spawn'),
        `a refused Crucible act still composed a command line:\n${said}`);
      return;
    }
    /*
     * ── A THIRD NAMED STATE, AND IT IS A KNOWN SDK DEFECT ─────────────────
     *
     * This is the one check in this suite that asks the REAL `local` server
     * (everything else is a dry run or a fake), so on Owen's PC it meets the
     * live WSL Crucible — which is PRE-PHASE-15 and answers
     * `GET /v1/capability` with no `route` on any row.
     *
     * crucible `docs/PHASE15-HOST.md` §3.3 (`eb59f7b`) says a document like
     * that means "this server predates the field, and every class IS local".
     * The vendored SDK's `readCapabilityRow` instead REQUIRES the field and
     * throws — a defect the Crucible side confirmed on 2026-09-14 after
     * Foundry measured the same thing, and which is being fixed. BookForge
     * does not work around it (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §0d), so the
     * act is refused by name before anything is composed.
     *
     * Which is exactly what this check exists to establish: **what must never
     * happen is the run composing a line against the LOCAL endpoint while the
     * flag named a server.** A refusal satisfies that, so it is recognised
     * here rather than failing the suite over somebody else's bug — and it is
     * NOT quiet: it prints, and the tripwire that will actually fire when the
     * SDK is fixed lives in `tools/test-crucible-settings-seam.js` §4.
     *
     * DELETE THIS BRANCH when that tripwire goes red and is inverted.
     */
    if (/has no field "route"|settings_document_unreadable/.test(said)) {
      console.log('       (the live local engine is pre-phase-15 and the vendored SDK refuses '
        + 'its capability document — known, being fixed, see CRUCIBLE_ROLLOUT_PLAN 0d)');
      assert.ok(!said.includes('[clean] spawn'),
        `a refused Crucible act still composed a command line:\n${said}`);
      return;
    }
    assert.ok(said.includes('[clean] venue'), `no venue line in:\n${said}`);
    assert.ok(/\[clean\] venue\s+crucible "local"/.test(said), said);
    // The base an OpenAI client is given, and the act named truthfully.
    assert.ok(/\[clean\] endpoint\s+http.*\/openai$/m.test(said),
      `the endpoint is not the OpenAI base:\n${said}`);
    assert.ok(said.includes('act clean'), said);
    // The credential is masked wherever it is shown, and never on the line.
    assert.ok(/headers .*Bearer \*\*\*\*/.test(said), said);
    const spawnLine = said.split('\n').find((l) => l.startsWith('[clean] spawn'));
    if (spawnLine) {
      assert.ok(!spawnLine.includes('FOUNDRY_ENDPOINT_HEADERS'), spawnLine);
      assert.ok(!/Bearer [A-Za-z0-9_.-]{8}/.test(spawnLine),
        `a bearer token reached the composed command line:\n${spawnLine}`);
    }
  });
}

fs.rmSync(ROOT, { recursive: true, force: true });
if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nclean-step door: all good');
