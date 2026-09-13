#!/usr/bin/env node
/**
 * A WORKING COPY IS A BOOK, AND THE NARRATION TEXT DOORS MUST SAY SO.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-cli-narration-text-gate.js
 *
 * ── The defect this pins (2026-09-13) ───────────────────────────────────────
 *
 * `cli/narration-text-step.js` opened with
 *
 *     if (path.extname(resolved).toLowerCase() !== '.epub') { … return { ran: false }; }
 *
 * and called everything that failed it "a plain-text audition". A project's
 * working copy is an EXPLODED DIRECTORY named `<stem>.working` — 45 of them in
 * the live library against ZERO `.working.epub` zips — so that test answered
 * "not a book" for every book the app is built to edit, and the step returned
 * quietly, having done nothing, on every project.
 *
 * Two silent consequences, both at the microphone:
 *
 *   - the book carried no current stamp, so `prepareNarrationInput` took its
 *     `cleanup: 'unstamped'` branch and the voice read "1933" as digits;
 *   - nothing re-cut the narration copy, and the user's STRIKES live only in
 *     that copy (`ensureNarrationEpub` → `<stem>.tts.epub`), reached through
 *     `recutNarrationCopy` on the PROJECT PASS route. `prepareNarrationInput`'s
 *     own cut passes an empty deletions list. So struck-out passages were read
 *     aloud.
 *
 * The naming rule has one owner — `shared/document/book-path.ts` — and this
 * suite exists to keep both CLI doors on it.
 *
 * ── Why this can fail ───────────────────────────────────────────────────────
 *
 * Every row below drives the REAL `runNarrationTextStep` over a REAL fixture on
 * disk and reads the outcome, and the last two rows re-run the OLD extension
 * test over the same fixtures to prove it gives the wrong answer. A row that
 * could only pass would be no guard at all.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

if (!fs.existsSync(path.join(DIST, 'shared', 'document', 'book-path.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

const { isBookPath } = require(path.join(DIST, 'shared/document/book-path.js'));

/*
 * THE ENGINE DOOR IS STUBBED, AND ONLY THE ENGINE DOOR.
 *
 * `runNarrationTextStep` requires `dist/electron/narration-clean-text.js` only
 * AFTER its gate, so a stub in the module cache lets a row observe that the gate
 * let a path through without spawning foundry, loading a model or touching the
 * GPU. Everything before the stub — the gate itself — is the shipped code.
 */
const doorPath = require.resolve(path.join(DIST, 'electron/narration-clean-text.js'));
let gateReached = false;
require.cache[doorPath] = {
  id: doorPath,
  filename: doorPath,
  loaded: true,
  exports: {
    async narrationTextGate() {
      gateReached = true;
      return {
        ok: true,
        stamp: { normalizerVersion: 'n6', punctuationSpec: 'p3', model: 'keeper' },
      };
    },
    cleanTextStampSidecar: (p) => `${p}.stamp.json`,
    cleanTextReceiptPath: (p) => `${p}.receipt.json`,
    async cleanTextEpub() { throw new Error('no row here should reach the engine'); },
  },
};

const { runNarrationTextStep } = require(path.join(REPO, 'cli/narration-text-step.js'));

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok    ${name}`))
    .catch((err) => {
      failures++;
      console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
    });
}

/** Run the step with console.log captured, so the row can read what it SAID. */
async function runCapturing(inputPath) {
  const said = [];
  const realLog = console.log;
  console.log = (...a) => { said.push(a.join(' ')); };
  try {
    const result = await runNarrationTextStep(inputPath, {});
    return { result, said: said.join('\n'), threw: null };
  } catch (err) {
    return { result: null, said: said.join('\n'), threw: err };
  } finally {
    console.log = realLog;
  }
}

/**
 * The gate this file REPLACED, kept here so the rows above can be shown to
 * disagree with it. If they ever stop disagreeing, they are not testing the fix.
 */
function theOldExtensionGate(p) {
  return path.extname(p).toLowerCase() === '.epub';
}

/** A source file with its comments removed, so a scan reads code and not prose. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-narration-gate-'));
const STEM = 'Nuremberg. Persico, Joseph E. (1994)';
const WORKING_DIR = path.join(SCRATCH, `${STEM}.working`);
const WORKING_ZIP = path.join(SCRATCH, `${STEM}.working.epub`);
const AUDITION_TXT = path.join(SCRATCH, 'passage.txt');
fs.mkdirSync(WORKING_DIR, { recursive: true });
fs.writeFileSync(WORKING_ZIP, 'PK');
fs.writeFileSync(AUDITION_TXT, 'a passage');

async function main() {
  console.log('the CLI text step asks isBookPath, not extname');

  await check('the shared rule calls an exploded <stem>.working a book', () => {
    assert.strictEqual(isBookPath(WORKING_DIR), true,
      'shared/document/book-path.ts stopped calling a working copy a book — everything '
      + 'below is measured against this');
  });

  await check('a .txt audition is refused as "not a book", exactly as before', async () => {
    gateReached = false;
    const { result, said, threw } = await runCapturing(AUDITION_TXT);
    assert.strictEqual(threw, null, `a .txt threw: ${threw && threw.message}`);
    assert.strictEqual(result.ran, false, 'a .txt must still be a no-op');
    assert.match(said, /is not a book/, `the no-op did not say why: ${said}`);
    assert.strictEqual(gateReached, false, 'a .txt reached the engine door');
  });

  await check('a `.working.epub` zip REACHES the stamp gate (it is a book)', async () => {
    gateReached = false;
    const { result, said, threw } = await runCapturing(WORKING_ZIP);
    assert.strictEqual(threw, null, `a working zip threw: ${threw && threw.message}`);
    assert.strictEqual(gateReached, true,
      'a `<stem>.working.epub` never reached the stamp gate — the name gate rejected a book');
    assert.strictEqual(result.ran, false, 'the stub reports a current stamp, so nothing runs');
    assert.match(said, /already carries a current stamp/, said);
  });

  await check('an exploded `<stem>.working` is REFUSED BY NAME, never skipped', async () => {
    // THE REGRESSION, exactly: this used to return `{ ran: false }` and print
    // "is not an EPUB". Silence here is the defect; a refusal naming the project
    // door is the fix, because the pass that CAN clean a tree is the project's.
    gateReached = false;
    const { result, threw } = await runCapturing(WORKING_DIR);
    assert.ok(threw !== null,
      'an exploded working copy was accepted as a no-op — the render behind it narrates '
      + 'digits as printed and reads every struck-out passage aloud');
    assert.strictEqual(result, null);
    assert.match(threw.message, /working copy/i, threw.message);
    assert.match(threw.message, /--narration-text --project/, threw.message);
    assert.strictEqual(gateReached, false, 'the tree reached the engine door, which cannot read one');
  });

  console.log('and the extension test cannot come back');

  await check('MUTATION: the old extname gate gives the WRONG answer for a working copy', () => {
    assert.strictEqual(theOldExtensionGate(WORKING_DIR), false,
      'the old gate now accepts a `.working` directory, so the rows above prove nothing');
    assert.strictEqual(isBookPath(WORKING_DIR), true);
    // Which is the whole point: two rules, two answers, and the silent one won.
  });

  await check('no extension comparison survives on the step\'s gate path', () => {
    // CODE, NOT PROSE. This file's own header QUOTES the gate it replaced, and a
    // scan that could not tell the two apart would forbid the explanation rather
    // than the defect — the same trap `tools/test-cli-parity.js` calls out.
    const source = codeOnly(fs.readFileSync(path.join(REPO, 'cli/narration-text-step.js'), 'utf8'));
    assert.ok(source.includes("require('../dist/shared/document/book-path.js')"),
      'cli/narration-text-step.js loads the ONE naming rule');
    assert.ok(source.includes('isBookPath(resolved)'), 'and asks it about the input');
    // The staging name still uses `path.basename(resolved, '.epub')`, which is
    // reached only for a zip; what must never return is a `path.extname(...)`
    // COMPARED against an epub-ish literal, which is the gate shape.
    const extnameTest = /path\.extname\([^)]*\)(?:\.toLowerCase\(\))?\s*(?:!==|===|!=|==)\s*['"]\.?epub['"]/;
    // MUTATION: the scan can see the very line it forbids. Without this the row
    // above passes for any file, including one that never had a gate at all.
    assert.ok(extnameTest.test("if (path.extname(resolved).toLowerCase() !== '.epub') {"),
      'the scan cannot recognize the gate it exists to forbid');
    assert.ok(!extnameTest.test(source),
      'an extension test is back on this file — a `<stem>.working` directory is a book and '
      + 'this is how it stopped being one');
  });

  await check('the render adapter routes a PROJECT through the project pass', () => {
    // The other half of the same defect: the bare-file step cannot re-cut a
    // narration copy, so a project render taking it reads struck-out passages
    // aloud even once the gate is right.
    const adapter = fs.readFileSync(path.join(REPO, 'cli/orpheus-audiobook-render.js'), 'utf8');
    assert.ok(adapter.includes("require('./processing-pass-step.js')"),
      'cli/orpheus-audiobook-render.js loads the project-pass door');
    assert.ok(/runProjectPass\(\s*\n?\s*projectDir, \{ kind: 'narration-text' \}/.test(adapter),
      'and runs the narration-text pass on the project');
    assert.ok(adapter.includes('bookIsOnTheProjectsChain('),
      'routing on whether the book is the project\'s own, asked of the manifest');
    assert.ok(adapter.includes('pass.narrationInputPath ?? pass.outputPath'),
      'and narrates the pass\'s own artifact, the same expression queue-steps/pass.ts uses');
  });

  await check('and the pass it calls really does re-cut the narration copy', () => {
    // Verified rather than assumed: the strike-preserving route is
    // runProcessingPass → runNarrationTextPass → recutNarrationCopy →
    // ensureNarrationEpub, on BOTH exits of the pass (the one that did work and
    // the one that found nothing to do).
    const passes = fs.readFileSync(path.join(REPO, 'electron/processing-passes.ts'), 'utf8');
    assert.ok(passes.includes('async function recutNarrationCopy('), 'the re-cut exists');
    assert.ok(passes.includes('ensureNarrationEpub(config.projectDir'),
      'and it is the cut that carries the strikes');
    const calls = passes.match(/recutNarrationCopy\(config, /g) ?? [];
    assert.ok(calls.length >= 2,
      `runNarrationTextPass must re-cut on BOTH exits; found ${calls.length} call(s)`);
    const step = fs.readFileSync(path.join(REPO, 'cli/narration-text-step.js'), 'utf8');
    assert.ok(!step.includes('ensureNarrationEpub'),
      'the bare-file step does NOT re-cut, which is why a project may not take it');
  });

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(failures === 0
    ? '\nAll narration-text gate checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
