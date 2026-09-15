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
const { execFile, execFileSync } = require('child_process');
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

const { startFakeCrucible, settingsRoutes } = require('./fake-crucible.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-clean-door-'));
let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
}

/**
 * The same runner for a check that has to AWAIT.
 *
 * The project half below drives the door as a SUBPROCESS against a fake
 * Crucible running in this process, and `execFileSync` would hold the event
 * loop shut so the fake could never answer. So that half is asynchronous —
 * see `dryRun`.
 */
async function atest(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
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

/**
 * WHAT THE FAKE CRUCIBLE SERVES FOR THE `clean` CLASS.
 *
 * `settingsRoutes`' own default for that class, said here because the door's
 * model is now READ FROM THE SERVER and every model assertion below is about
 * this id rather than about anything in app-settings.
 */
const FAKE_CLEAN_MODEL = 'qwen3.5-9b';

/** One `GET /v1/models` row in the shape the SDK's `readModelInfo` requires. */
function modelRow(id, resident) {
  return {
    id, family: 'qwen3.5', params_b: 9, revision: 'abc1234', fingerprint: `${id}@abc1234`,
    modalities: ['text'], backend_supported: true, installed: true, resident,
    loadable: true, reason: null, memory_bytes_estimate: 19000000000,
    context_default: 32768, max_model_len: 32768,
  };
}

const fixture = fixtureProject();

async function projectHalf() {
  if (fixture === null) {
    console.log('  skip: no Foundry project in this machine\'s library to copy — the resolution half\n'
      + '        of this test needs one real project, and it is not synthesised (a hand-made\n'
      + '        ledger would be a test of the fixture).');
    return;
  }
  const lib = path.join(ROOT, 'library');
  const copied = path.join(lib, 'foundry', 'projects', fixture.key);
  fs.mkdirSync(path.dirname(copied), { recursive: true });
  fs.cpSync(fixture.dir, copied, { recursive: true });

  /*
   * ── THE VENUE THIS HALF OF THE SUITE RUNS AT ──────────────────────────────
   *
   * Since rollout item 2.6 the clean act asks WHERE it runs before it composes
   * anything. Until 2026-09-15 that question had two answers and these tests
   * took the second: a routing record with `legacyLocalRender: true`, which ran
   * the act against the LOCAL text engines. That switch and the whole local arm
   * are DELETED (docs/LEGACY-REMOVAL.md), so there is exactly one answer left —
   * a Crucible server — and a door with nowhere to send the act refuses by name
   * before it composes anything.
   *
   * These tests are not about the venue; they are about the ARGV, the
   * resolution, the retired flags and the engine binary. So they are pointed at
   * A FAKE CRUCIBLE OF THEIR OWN rather than at whatever server this machine
   * happens to have: a real one would make them pass or fail on somebody else's
   * resident model. The fake answers `GET /v1/capability` (through
   * `settingsRoutes`, the same door `tools/test-crucible-settings-seam.js`
   * drives) and `GET /v1/models` with the clean class's model RESIDENT, which
   * is the state `resolveCrucibleTextEngine` requires and never creates.
   *
   * Pinned with a userData OF ITS OWN (`$BOOKFORGE_USER_DATA`, honoured by the
   * shim), carrying that fake's registry entry and a routing record that ranks
   * it first. Owen's real record, registry and tokens are neither read nor
   * written. `app-settings.json` IS copied across, because the endpoint and
   * concurrency lines still read it.
   *
   * The composition itself is covered without a project by
   * `tools/test-crucible-text-acts.js`; what is added here is that the whole
   * door, end to end over a real project, reaches it.
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
  /*
   * THE FAKE, AND HOW THE DOOR IS TOLD ABOUT IT — the PAIRING FILE, which is
   * the contract's own first way to find the server on this machine (crucible
   * `docs/PHASE15-HOST.md` §3.6, §5.1: *"No typing."*).
   *
   * NOT the registry, deliberately: `addServer` and `ServerRegistry.get` both
   * refuse a loopback URL by name (`stale_local_entry`) because the local
   * server has one owner and a copied token goes stale the moment
   * `crucible init --force` runs. A keeper that wrote such an entry anyway
   * would be testing against a shape the app refuses. The pairing file is where
   * a loopback address BELONGS, it is read with no WSL and no `wsl.exe` spawn,
   * and `$CRUCIBLE_HOME` points it at a directory of ours — so this suite
   * neither reads nor needs whatever Crucible is actually running on this box.
   */
  const door = settingsRoutes({});
  const fake = await startFakeCrucible(async (req, res, ctx) => {
    if (ctx.url.pathname === '/v1/models' && req.method === 'GET') {
      // A BARE ARRAY — `models()` asks `asArray(body, 'models')` of the body
      // itself, not of a `models` key, and a wrapped answer is refused by name.
      ctx.send(res, 200, [modelRow(FAKE_CLEAN_MODEL, true)]);
      return true;
    }
    /*
     * `GET /v1/info`, BECAUSE THE ENDPOINT IS THE ENGINE'S AND NOT THE
     * REGISTERED ADDRESS (crucible PHASE17 §6, `crucible/engine-resolve.ts`).
     * A registered address can be an ORCHESTRATOR — zero job types, one engine
     * managed — and a chat sent to one ends in `job_type_not_served`. This fake
     * IS the engine, which is what `role: engine` says.
     */
    if (ctx.url.pathname === '/v1/info' && req.method === 'GET') {
      ctx.send(res, 200, {
        server: { name: 'clean-step-fake', version: '0.6.0', api_version: 1 },
        host: {
          platform: 'linux', arch: 'x86_64', backend: 'cuda-linux',
          gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 25757220864 },
        },
        job_types: ['llm'],
        capabilities: [{ job_type: 'llm', models: [] }],
        role: 'engine',
        managed_by: null,
      });
      return true;
    }
    return door.handle(req, res, ctx);
  });
  /** The reserved name for the server on this machine — what the pairing file names. */
  const FAKE_SERVER = 'local';
  const crucibleHome = path.join(ROOT, 'crucible-home');
  fs.mkdirSync(crucibleHome, { recursive: true });
  const { port } = new URL(fake.url);
  fs.writeFileSync(
    path.join(crucibleHome, 'pairing'),
    `crucible://clean-door-fake@127.0.0.1:${port}/#test-token-abcd\n`,
    'utf8');
  const routingFile = path.join(doorUserData, 'crucible-routing.json');
  fs.writeFileSync(
    routingFile,
    JSON.stringify({ order: [FAKE_SERVER], disabled: [], newJobsWaitFor: 'top-ranked' }),
    'utf8');

  const doorEnv = () => {
    /*
     * NOTHING IS NAMED FOR IT. `FOUNDRY_BIN` and `FOUNDRY_CLI_PATH` are both
     * cleared so the door does its own resolution — the prime, then
     * `resolveFoundryPath` — which is the thing the engine assertion below is
     * about. It spawns `--version` and nothing else.
     */
    const env = {
      ...process.env,
      BOOKFORGE_USER_DATA: doorUserData,
      CRUCIBLE_HOME: crucibleHome,
    };
    delete env.FOUNDRY_BIN;
    delete env.FOUNDRY_CLI_PATH;
    return env;
  };

  /**
   * One `--dry-run` of the door, as a subprocess.
   *
   * ASYNCHRONOUS, and that is load-bearing: the fake Crucible the door dials
   * lives in THIS process, so `execFileSync` would hold the event loop shut and
   * the door would time out against a server that is running and cannot answer.
   *
   * Resolves with stdout on exit 0; rejects with an Error carrying `stdout` and
   * `stderr` otherwise, which is the shape `refusalOf` reads.
   */
  const dryRun = (extra) => new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--require', STUB, DOOR, '--foundry-project', copied, '--library', lib,
        '--foundry-dist', FOUNDRY_DIST, '--dry-run', ...extra],
      { cwd: REPO, encoding: 'utf8', env: doorEnv(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err === null) return resolve(stdout);
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      },
    );
  });

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

  const refusalOf = async (extra) => {
    try {
      const out = await dryRun(extra);
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

  await atest('the dry run resolves the project and prints the clean-text argv', async () => {
    const out = await dryRun(['--concurrency', '8']);
    const spawn = out.split('\n').find((line) => line.startsWith('[clean] spawn'));
    assert.ok(spawn, `no spawn line in:\n${out}`);
    for (const flag of ['clean-text', '--book', '--records', '--stamp', '--model', '--endpoint']) {
      assert.ok(spawn.includes(flag), `${flag} missing from: ${spawn}`);
    }
    assert.ok(spawn.includes('--concurrency 8'), `--concurrency 8 missing from: ${spawn}`);
    assert.ok(spawn.includes(`--model ${FAKE_CLEAN_MODEL}`), spawn);
    assert.ok(out.includes('DRY RUN'), 'the run did not say it spawned nothing');
    assert.ok(/position\s+\S+\s+\S+/.test(out), 'the position was not printed');
  });

  await atest('--keep-model and --ollama are refused BY NAME, and never dropped', async () => {
    const plain = await dryRun([]);
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
      const refused = await refusalOf(argv);
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

  /*
   * ── THE MODEL IS THE SERVER'S, AND APP-SETTINGS NEVER REACHES THE LINE ────
   *
   * This check replaces TWO that answered a question the door no longer asks:
   * *"no --model said means app-settings cleanTextModel, never
   * defaultLlmModel"*, and *"under vLLM a --model that is not the profile's
   * served name is REFUSED by name"*. Both were about the LOCAL text-engine
   * arm — `textServerRoute`, `profileForKind`, `servedModelForRequest` — which
   * is deleted with the rest of the legacy layer (docs/LEGACY-REMOVAL.md).
   *
   * What replaces them is the rule that took over from them, crucible
   * `docs/PHASE15-HOST.md` §5.3: *"The cleanup/OCR/translation/simplify/analysis
   * doors send `capability.selected` as the model to the registry's server and
   * nothing else."* The model on the line is the one THIS SERVER named for the
   * `clean` class, read from its own `GET /v1/capability`.
   *
   * The half of the old check that still matters is kept verbatim in spirit: a
   * model out of app-settings must NOT reach the line. Owen, 2026-09-08 —
   * *"verify that when i run translate/simplify in foundry, they will correctly
   * use the 27b model in vllm and not the 9b"*. The failure mode is the same
   * one (a cleanup recorded against a model that did not do it); only the owner
   * of the answer has changed, from this machine's settings to the machine that
   * will run it.
   */
  await atest('the model is the SERVER\'s capability choice, never app-settings', async () => {
    const settingsFile = path.join(require(STUB).USER_DATA, 'app-settings.json');
    const raw = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
    /*
     * ASKED UNDER THE SHIM, because `readAppSettings` reads
     * `app.getPath('userData')` and plain node has no `app` — it would answer with
     * the declared default and this test would pass against a setting nobody has.
     */
    const stored = storedSettings();
    const out = await dryRun([]);

    assert.ok(out.includes(`--model ${FAKE_CLEAN_MODEL}`),
      `the server's own choice for the clean class must be ON the line:\n${out}`);
    assert.ok(!/--model\s+["']?\s*(?:$|["'])/m.test(out), 'never an empty --model');
    assertDeclaredDialect(spawnLine(out));
    // And the venue is named before anything is composed, so a reader can tell
    // WHICH machine's capability record answered.
    assert.ok(/\[clean\] venue\s+crucible "/.test(out), `no venue line in:\n${out}`);

    /*
     * NEITHER APP-SETTINGS KEY MAY APPEAR. Both are still read by this door for
     * other things (the endpoint on a non-Crucible line, the dialog's seed), so
     * "the file is not read" would be the wrong assertion — what must be true is
     * that neither value becomes the model.
     */
    for (const [key, value] of [
      ['cleanTextModel', stored.cleanTextModel],
      ['defaultLlmModel', raw.defaultLlmModel],
    ]) {
      if (typeof value !== 'string' || value === '' || value === FAKE_CLEAN_MODEL) continue;
      assert.ok(!out.includes(`--model ${value}`),
        `the door reached for app-settings ${key} (${value}) instead of the server's choice`);
    }
  });

  await atest('the engine is the dev binary the app primes, not the installed component', async () => {
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
    const out = await dryRun([]);
    const engine = out.split('\n').find((line) => line.startsWith('[clean] engine  '));
    assert.ok(engine, `no engine line in:\n${out}`);
    assert.ok(engine.includes(dev), `expected the dev binary ${dev}; got: ${engine}`);
    // And it says which release answered, because a path cannot say that.
    assert.ok(/\[clean\] engine version\s+foundry \d+\.\d+\.\d+/.test(out),
      `the engine version was not named:\n${out}`);
  });

  await atest('a concurrency that is not a whole number is refused by name', async () => {
    const said = await refusalOf(['--concurrency', '0']);
    assert.ok(said.includes('not a whole number'), `expected a refusal; got: ${said}`);
  });

  /*
   * ── NAMING THE VENUE ─────────────────────────────────────────────────────
   *
   * `--crucible-server` sets the same field the app sets from a queue row, so
   * the two doors cannot disagree about where an act ran. It is the CLI's half
   * of the gate; the composition itself is `tools/test-crucible-text-acts.js`.
   *
   * It used to be the ONE test in this suite that reached a Crucible, because
   * the other seven ran on the legacy local engines. They all reach one now, so
   * what is left for this to prove is that the FLAG is honoured — the run goes
   * to the server it names — and that the credential never reaches a command
   * line.
   */
  await atest('--crucible-server names the venue, and the dry run composes the Crucible line',
    async () => {
      let said = '';
      try { said = await dryRun(['--crucible-server', FAKE_SERVER]); }
      catch (err) { said = `${err.stdout || ''}${err.stderr || ''}`; }
      assert.ok(said.includes('[clean] venue'), `no venue line in:\n${said}`);
      assert.ok(new RegExp(`\\[clean\\] venue\\s+crucible "${FAKE_SERVER}"`).test(said), said);
      // The base an OpenAI client is given, and the act named truthfully.
      assert.ok(/\[clean\] endpoint\s+http.*\/openai$/m.test(said),
        `the endpoint is not the OpenAI base:\n${said}`);
      assert.ok(said.includes('act clean'), said);
      // The credential is masked wherever it is shown, and never on the line.
      assert.ok(/headers .*Bearer \*\*\*\*/.test(said), said);
      const line = said.split('\n').find((l) => l.startsWith('[clean] spawn'));
      assert.ok(line !== undefined, `the named venue composed no command line:\n${said}`);
      assert.ok(!line.includes('FOUNDRY_ENDPOINT_HEADERS'), line);
      assert.ok(!/Bearer [A-Za-z0-9_.-]{8}/.test(line),
        `a bearer token reached the composed command line:\n${line}`);
    });

  /*
   * ── AND WITH NO SERVER THERE IS NOWHERE LEFT TO FALL TO ──────────────────
   *
   * The check this replaces turned the legacy switch ON and asserted the act
   * ran against the local engines. That arm is DELETED
   * (docs/LEGACY-REMOVAL.md), so the state it described is now the one that
   * must REFUSE: with every server disabled the door says `no_enabled_server`
   * by name, composes nothing, and starts no engine. A stale
   * `legacyLocalRender: true` left on the record cannot re-open it — the key is
   * read, reported once and dropped (`electron/crucible/routing.ts`).
   */
  await atest('with nothing enabled the act is refused by name, and no line is composed',
    async () => {
      const good = fs.readFileSync(routingFile, 'utf8');
      fs.writeFileSync(routingFile, JSON.stringify({
        order: [FAKE_SERVER],
        disabled: [FAKE_SERVER],
        newJobsWaitFor: 'top-ranked',
        // The retired key, still on disk exactly as an old record carries it.
        legacyLocalRender: true,
      }), 'utf8');
      try {
        const said = await refusalOf([]);
        assert.ok(/no_enabled_server|every Crucible server is disabled/.test(said),
          `expected the routing record's own refusal; got:\n${said}`);
        assert.ok(!said.includes('[clean] spawn'),
          `a refused act still composed a command line:\n${said}`);
      } finally {
        fs.writeFileSync(routingFile, good, 'utf8');
      }
    });

  await fake.close();
}

projectHalf()
  .catch((err) => {
    failures += 1;
    console.error(`  FAIL (the project half could not run)\n       ${err && err.stack ? err.stack : err}`);
  })
  .then(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    if (failures > 0) { console.error(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nclean-step door: all good');
  });
