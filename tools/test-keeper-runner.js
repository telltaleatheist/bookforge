#!/usr/bin/env node
/**
 * test-keeper-runner — A KEEPER FOR THE KEEPERS.
 *
 *   node tools/test-keeper-runner.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The 2026-09-13 census established that a guard nobody runs cannot go red
 * (crucible/docs/ARCHITECTURE.md R2), and `run-keepers.js` grew its own list
 * guard so that no `tools/test-*.js` could be left out of the list again. That
 * closed one door and not the other: a guard that is LISTED and runs can still
 * be dark, and two of them were on 2026-09-18.
 *
 *  · `test-foundry-clean-text-vendor` refused to verify anything at all,
 *    because the binary on this machine prints `foundry 2.0.2 (e03943a+dirty)`
 *    and the reading of that line stopped at the `+`. It names its commit; the
 *    keeper said it named none.
 *  · `test-quire` skipped by name on the one machine that owns its fixture,
 *    because the only way to point it at the book was an environment variable
 *    nothing sets.
 *  · And the runner itself printed `FAIL test-foundry-clean-text-vendor
 *    Node.js v20.19.5` — the last line of node's crash dump — so the row that
 *    should have said which of these it was said nothing at all.
 *
 * Every one of those is a READING: of a version line, of a machine's recorded
 * library, of a failed suite's output. So this file drives the readings, on
 * captured output and over a library root of its own, with no foundry binary,
 * no shared library and no GPU.
 *
 * WHAT IS DELIBERATELY NOT HERE: the runner's loop. Running the runner from
 * inside a suite the runner runs is a fork bomb with a nice name. The loop is
 * exercised every time anybody runs it; the readings were not exercised by
 * anything at all, which is the difference this file is about.
 */
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

/*
 * A USERDATA OF OUR OWN, ARMED BEFORE ANYTHING IS REQUIRED.
 *
 * `cli/electron-stub.js` resolves `BOOKFORGE_USER_DATA` once, at require time,
 * and `ka-fixture` reaches it through that shim. Setting this afterwards would
 * drive the derivation over Owen's real records — his library root, his
 * settings, his Crucible tokens — which is exactly the kind of test that looks
 * green on one machine.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-keeper-runner-'));
process.env.BOOKFORGE_USER_DATA = path.join(SCRATCH, 'userData');
fs.mkdirSync(process.env.BOOKFORGE_USER_DATA, { recursive: true });
delete process.env.BOOKFORGE_KA_EPUB;

const runner = require(path.join(__dirname, 'run-keepers.js'));
const vendor = require(path.join(__dirname, 'test-foundry-clean-text-vendor.js'));
const kaFixture = require(path.join(__dirname, 'ka-fixture.js'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err && err.message ? err.message : String(err)).split('\n')[0]}`);
  }
}

/**
 * The output a suite really produces, captured rather than imagined. Every
 * fixture below is the stdout+stderr of a process this file starts, for the
 * reason the runner's own header gives about pinned facts: a crash dump I typed
 * out by hand is a description of node's formatting from memory, and the thing
 * under test is a reading of node's formatting.
 */
function outputOf(script) {
  const file = path.join(SCRATCH, `emit-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, script, 'utf8');
  try {
    return { ok: true, out: execFileSync(process.execPath, [file], { encoding: 'utf-8', stdio: 'pipe' }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

// ── Defect C: a failed suite's row says what failed ─────────────────────────

console.log('the runner reads a failure that was THROWN, not reported');

const thrown = outputOf(
  'throw new Error("the binary reports \\"foundry 2.0.2 (e03943a+dirty)\\" and names no commit");');

check('a suite that throws is not summarised as its node version', () => {
  assert.strictEqual(thrown.ok, false, 'the fixture must actually have failed');
  assert.match(thrown.out, /Node\.js v/,
    'the fixture must be a real crash dump — that trailing line is the defect\'s whole shape');
  const detail = runner.failureDetail(thrown.out);
  assert.ok(detail.length > 0,
    'the runner found nothing to print about a suite that threw, so the row is contentless');
  assert.match(detail[0], /Error: the binary reports/,
    `the first detail line must name the error: ${JSON.stringify(detail[0])}`);
  assert.ok(!/Node\.js v/.test(detail.join('\n')),
    'the node version banner is not a reason and must not be the detail');
});

const asserted = outputOf(
  'require("assert").strictEqual(1, 2, "the pinned sha and the shipped sha disagree");');

check('an AssertionError is read as the first detail line', () => {
  assert.strictEqual(asserted.ok, false);
  const detail = runner.failureDetail(asserted.out);
  assert.ok(detail.length > 0, 'an AssertionError left the row with nothing to say');
  assert.match(detail[0], /AssertionError/, `${JSON.stringify(detail[0])}`);
  assert.match(detail[0], /the pinned sha and the shipped sha disagree/,
    'the assertion\'s own message is the sentence a person needs');
});

const reported = outputOf(
  'console.log("  ok    a thing that works");\n'
  + 'console.log("FAIL  a thing that does not");\n'
  + 'console.log("      because the two shas differ");\n'
  + 'console.log("33/35 passed");\n'
  + 'process.exitCode = 1;\n');

check('a suite that REPORTS its own failures still prints exactly those lines', () => {
  // The shape that already worked, pinned so that widening the reading for the
  // shape above cannot quietly swallow it.
  assert.strictEqual(reported.ok, false);
  const detail = runner.failureDetail(reported.out);
  assert.deepStrictEqual(
    detail.map((l) => l.trim()),
    ['FAIL  a thing that does not', 'because the two shas differ'],
    'a reporting suite\'s FAIL line and its indented reason are the whole detail',
  );
  assert.strictEqual(runner.tallyOf(reported.out), '33/35 passed',
    'and the row keeps its count, which says how much of the suite did run');
});

const spoken = outputOf(
  'console.log("No Foundry build here exports `argsFor` from electron/job-queue.js.");\n'
  + 'process.exitCode = 1;\n');

check('a suite that refuses IN PROSE keeps its sentence', () => {
  // test-clean-step-door's shape — no FAIL line, no throw, one paragraph
  // saying which two builds it looked for. Reading only the two shapes above
  // would have replaced a useful sentence with an apology.
  assert.strictEqual(spoken.ok, false);
  assert.deepStrictEqual(
    runner.failureDetail(spoken.out),
    ['No Foundry build here exports `argsFor` from electron/job-queue.js.'],
  );
});

check('a suite that never printed a count has no tally to report', () => {
  assert.strictEqual(runner.tallyOf(thrown.out), null,
    'the last line of a crash dump is not a tally, and calling it one is how '
    + '"FAIL <name> Node.js v20.19.5" happened');
});

// ── The shell that cannot start a child ─────────────────────────────────────

console.log('a shell that refuses to start the child is not a red test');

/*
 * MEASURED, not imagined: `node tools/test-cli-flags.js` under this session's
 * Git Bash on 2026-09-18 printed every one of its 25 ok lines, then exited 3
 * with that single line on stderr and no tally. Under PowerShell the same
 * command passes 25/25. The suite is fine; the shell would not let it start a
 * grandchild in a job object.
 */
const shellRefused = outputOf(
  'console.log("  ok    a flag that is refused by name");\n'
  + 'process.stderr.write("AssignProcessToJobObject: (87) The parameter is incorrect.\\n");\n'
  + 'process.exit(3);\n');

check('the job-object refusal is named as a shell problem, with the remedy', () => {
  assert.strictEqual(shellRefused.ok, false);
  const said = runner.shellRefusalOf(shellRefused.out);
  assert.ok(said !== null, 'the runner read Windows\' refusal as a failing assertion');
  assert.match(said, /PowerShell/, `the row must say where it does run: ${said}`);
  assert.match(said, /AssignProcessToJobObject/, `and quote what Windows said: ${said}`);
});

check('an ordinary failure is NOT excused as a shell problem', () => {
  assert.strictEqual(runner.shellRefusalOf(asserted.out), null,
    'a real AssertionError was written off as "not runnable here" — the excuse must name '
    + 'Windows\' own error and nothing else');
  assert.strictEqual(runner.shellRefusalOf(reported.out), null);
});

// ── Defect A: the version line, in the three shapes it comes in ─────────────

console.log('a foundry --version line names its commit, dirty or not');

check('a release build names the sha', () => {
  assert.deepStrictEqual(
    vendor.parseFoundryVersion('foundry 2.0.2 (e03943a)'),
    { sha: 'e03943a', dirty: false },
  );
});

check('a DIRTY release build names the same sha, and says it is dirty', () => {
  // The defect: `+dirty` is appended by foundry's release script when the tree
  // it built from had uncommitted changes. The sha is still the sha — the
  // caution belongs in the pass line, not in a refusal to verify anything.
  assert.deepStrictEqual(
    vendor.parseFoundryVersion('foundry 2.0.2 (e03943a+dirty)'),
    { sha: 'e03943a', dirty: true },
  );
});

check('a build that names no commit is still "cannot verify"', () => {
  // `bun run src/cli.ts` prints no parenthesis at all, and a parenthesis that
  // is not a sha is not a sha. Both must stay null: falling back to the
  // checkout's HEAD is the hazard the whole anchor exists to remove.
  assert.strictEqual(vendor.parseFoundryVersion('foundry 2.0.2'), null);
  assert.strictEqual(vendor.parseFoundryVersion('foundry 2.0.2 (none)'), null);
});

// ── Defect B: the fixture is derived, not declared ──────────────────────────

console.log('test-quire finds its book on a machine that has it');

function writeLibraryRoot(root) {
  fs.writeFileSync(
    path.join(process.env.BOOKFORGE_USER_DATA, 'library-root.json'),
    JSON.stringify({ libraryRoot: root }), 'utf8');
}

check('with no recorded library root there is a REASON, never a guess', () => {
  const at = path.join(process.env.BOOKFORGE_USER_DATA, 'library-root.json');
  if (fs.existsSync(at)) fs.rmSync(at);
  const answer = kaFixture.killingAmericaEpub();
  assert.strictEqual(answer.book, undefined, 'a machine with no library must not produce a path');
  assert.match(answer.reason, /library-root\.json/, answer.reason);
  assert.match(answer.reason, /BOOKFORGE_KA_EPUB/,
    'and the reason must say how to point it at one anyway');
});

check('the derivation is the APP\'s layout — projects/<id>/archive/<file>', () => {
  const fake = path.join(SCRATCH, 'fake-library');
  const composed = kaFixture.epubPathIn(fake);
  assert.strictEqual(
    composed,
    path.join(fake, 'projects', kaFixture.KA_PROJECT_ID, 'archive', kaFixture.KA_FILENAME),
    'the address must come out of getAbsolutePath, which is what the app itself walks',
  );
});

check('a recorded library that HOLDS the book answers with it', () => {
  const fake = path.join(SCRATCH, 'library-with-book');
  const book = path.join(fake, 'projects', kaFixture.KA_PROJECT_ID, 'archive', kaFixture.KA_FILENAME);
  fs.mkdirSync(path.dirname(book), { recursive: true });
  fs.writeFileSync(book, 'PK\u0003\u0004not really an epub', 'utf8');
  writeLibraryRoot(fake);
  const answer = kaFixture.killingAmericaEpub();
  assert.strictEqual(answer.book, book, answer.reason);
});

check('a recorded library that does NOT hold it skips by name, saying where it looked', () => {
  const fake = path.join(SCRATCH, 'library-without-book');
  fs.mkdirSync(fake, { recursive: true });
  writeLibraryRoot(fake);
  const answer = kaFixture.killingAmericaEpub();
  assert.strictEqual(answer.book, undefined);
  assert.ok(answer.reason.includes(fake), `the reason must name the library it read: ${answer.reason}`);
  assert.ok(answer.reason.includes(kaFixture.KA_FILENAME), answer.reason);
});

check('BOOKFORGE_KA_EPUB still overrides, and a bad one is refused rather than ignored', () => {
  const elsewhere = path.join(SCRATCH, 'elsewhere.epub');
  fs.writeFileSync(elsewhere, 'PK\u0003\u0004', 'utf8');
  writeLibraryRoot(path.join(SCRATCH, 'library-with-book'));
  process.env.BOOKFORGE_KA_EPUB = elsewhere;
  try {
    assert.strictEqual(kaFixture.killingAmericaEpub().book, elsewhere,
      'the override must win over the recorded library — that is what it is for');
    process.env.BOOKFORGE_KA_EPUB = path.join(SCRATCH, 'no-such-book.epub');
    const answer = kaFixture.killingAmericaEpub();
    assert.strictEqual(answer.book, undefined,
      'an override naming nothing must NOT quietly fall through to the recorded library: two '
      + 'people have named the book and this cannot tell which of them meant it');
    assert.match(answer.reason, /BOOKFORGE_KA_EPUB/, answer.reason);
  } finally {
    delete process.env.BOOKFORGE_KA_EPUB;
  }
});

check('test-quire asks this module rather than reading the variable itself', () => {
  // A SOURCE PIN, and the reason it is worth one: the derivation only ends the
  // skip if the suite consults it. A copy of the env-var read left behind in
  // test-quire.js would pass every check above and skip every run.
  const quire = fs.readFileSync(path.join(__dirname, 'test-quire.js'), 'utf8');
  assert.match(quire, /require\(.*ka-fixture/,
    'test-quire.js does not consult tools/ka-fixture.js, so it still skips on the machine that '
    + 'owns the book');
  assert.ok(!/process\.env\.BOOKFORGE_KA_EPUB/.test(quire),
    'test-quire.js still reads BOOKFORGE_KA_EPUB directly — one fact, one owner, and the owner '
    + 'is ka-fixture.js');
});

// ── Defect C\'s family: a source pin must not depend on line endings ────────

console.log('a keeper that reads SOURCE reads it the same in every checkout');

check('test-stream-engine-availability normalises line endings before matching', () => {
  /*
   * Measured 2026-09-18: `electron/streaming-engine.ts` is LF in the main
   * checkout and CRLF in every fresh worktree (core.autocrlf=true), and the
   * file's source regexes are anchored on `\n}\n`. So the same commit's guard
   * was green in one directory and red in another, which is a guard reporting
   * on the checkout rather than on the code.
   */
  const suite = fs.readFileSync(path.join(__dirname, 'test-stream-engine-availability.js'), 'utf8');
  assert.match(suite, /replace\(\/\\r\\n\/g, '\\n'\)/,
    'the source it pins is read verbatim, so a CRLF checkout fails anchors written with \\n');
});

console.log('');
if (failures.length === 0) {
  console.log(`keeper-runner: ${passed}/${passed} passed`);
} else {
  console.log(`keeper-runner: ${passed}/${passed + failures.length} passed`);
  for (const f of failures) {
    console.log(`\nFAIL  ${f.name}`);
    console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
  }
  process.exitCode = 1;
}
