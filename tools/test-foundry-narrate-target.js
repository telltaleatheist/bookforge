#!/usr/bin/env node
/**
 * Tests for electron/foundry-narrate-target.ts — which exported EPUB a
 * narration reads.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-foundry-narrate-target.js
 *
 * ── Why this keeper exists at all ───────────────────────────────────────────
 *
 * Because its most important branches CANNOT BE REACHED BY USING THE APP. Every
 * project in the library today has zero or one exported EPUB, so the two-EPUB
 * cases — the ones the whole `export:` contract was added for — are unreachable
 * by hand until somebody exports a second one, at which point the wrong answer
 * would arrive silently and an hour of GPU later. Before foundry e8396b4 the
 * choice ignored the node id entirely and a two-EPUB project refused for
 * ambiguity even when the tree named one of them; that was true for weeks and
 * nothing failed, because nobody had two.
 *
 * So these are hand-built arrays, and that is the point.
 *
 * ── What is worth defending ─────────────────────────────────────────────────
 *
 *  - A NAMED PRESS NAMES THE ANSWER (Owen's identity law). Two exports and an
 *    `export:` id resolves the one named, with no uniqueness question asked.
 *  - A NAME THIS LIBRARY HAS NO VERSION FOR IS A REFUSAL, listing what it does
 *    have — never a silent fall back to "the only one" or "the first one".
 *  - A STEP-SHAPED ID STILL RESOLVES BY UNIQUENESS, because it carried no file.
 *    Two exports and no name is a refusal, not a coin flip.
 *  - ZERO EXPORTS WINS OVER A NAMED FILE. The order matters: the useful sentence
 *    is "export the book first", not "there is no file called that".
 *  - THE MATCH IS ON THE BASENAME, since the id carries a project-relative path
 *    (`final/Book.epub`) and the manifest records the filed name (`Book.epub`).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'foundry-narrate-target.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const target = require(path.join(DIST, 'foundry-narrate-target.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

const PROJECT = 'Working_Towards_the_Fuhrer_-_Ian_Kershaw_(1993)';

/** One export, as `foundrySource.fileName` records it. */
const ex = (id, fileName) => ({ id, fileName });

const ONE = [ex('v-1', 'Working Towards the Fuhrer (en).epub')];
const TWO = [
  ex('v-1', 'Working Towards the Fuhrer (en).epub'),
  ex('v-2', 'Working Towards the Fuhrer (de).epub'),
];

/** The id an export row's press sends, per foundry's `exportNodeId`. */
const pressed = (file) => `export:final/${file}`;

/** A ledger step id: randomUUID, no colon. */
const STEP = '7c1e0b4a-2f65-4a1e-9a3b-15d0c4e8f2aa';

// ── exportFileOfNodeId ──────────────────────────────────────────────────────

test('an export: id yields the project-relative file it names', () => {
  assert.strictEqual(
    target.exportFileOfNodeId('export:final/Book.epub'), 'final/Book.epub');
});

test('a step-shaped id names no file', () => {
  assert.strictEqual(target.exportFileOfNodeId(STEP), null);
});

test('one of OUR node ids names no file, so the prefixes cannot collide', () => {
  // `bf-node:<jobId>:<stepId>` — foundry-host-nodes.ts mints these, and foundry
  // reserved `export:` on the socket precisely so the two can never be confused.
  assert.strictEqual(target.exportFileOfNodeId('bf-node:job-1:step-1'), null);
});

test('a bare export: with nothing after it names no file, rather than one called ""', () => {
  assert.strictEqual(target.exportFileOfNodeId('export:'), null);
});

// ── The choice ──────────────────────────────────────────────────────────────

test('a named file among TWO resolves that one, with no uniqueness question', () => {
  assert.strictEqual(
    target.chooseNarrationExport(
      pressed('Working Towards the Fuhrer (de).epub'), TWO, PROJECT),
    'v-2');
});

test('the other named file among the same two resolves the other one', () => {
  // Both directions, because "it happened to pick the right one" and "it picks
  // the first one" look identical when you only ever test one of them.
  assert.strictEqual(
    target.chooseNarrationExport(
      pressed('Working Towards the Fuhrer (en).epub'), TWO, PROJECT),
    'v-1');
});

test('the match is on the BASENAME, not the project-relative path', () => {
  // The id carries `final/<name>`; the manifest records `<name>`.
  assert.strictEqual(
    target.chooseNarrationExport(
      'export:some/deeper/place/Working Towards the Fuhrer (en).epub', TWO, PROJECT),
    'v-1');
});

test('a named file the version list lacks refuses, naming BOTH sides', () => {
  assert.throws(
    () => target.chooseNarrationExport(pressed('A Book Nobody Exported.epub'), TWO, PROJECT),
    (err) => {
      assert.match(err.message, /named "final\/A Book Nobody Exported\.epub"/);
      // What it DOES have, so the user can see the mismatch rather than guess.
      assert.match(err.message, /Working Towards the Fuhrer \(en\)\.epub/);
      assert.match(err.message, /Working Towards the Fuhrer \(de\)\.epub/);
      assert.match(err.message, new RegExp(PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
});

test('a named file absent from a ONE-export project refuses too, never falling back to the only one', () => {
  // The failure this forbids: "there is exactly one, so they must have meant it."
  assert.throws(
    () => target.chooseNarrationExport(pressed('Not This One.epub'), ONE, PROJECT),
    /has no exported EPUB filed/);
});

test('a step-shaped id with ONE export resolves it', () => {
  assert.strictEqual(target.chooseNarrationExport(STEP, ONE, PROJECT), 'v-1');
});

test('a step-shaped id with TWO exports refuses rather than choosing', () => {
  assert.throws(
    () => target.chooseNarrationExport(STEP, TWO, PROJECT),
    (err) => {
      assert.match(err.message, /has exported 2 EPUBs/);
      assert.match(err.message, /does not say which one it is/);
      return true;
    });
});

test('a bare export: behaves as step-shaped — one resolves, two refuse', () => {
  assert.strictEqual(target.chooseNarrationExport('export:', ONE, PROJECT), 'v-1');
  assert.throws(
    () => target.chooseNarrationExport('export:', TWO, PROJECT), /has exported 2 EPUBs/);
});

test('zero exports refuses with the export-first sentence, whatever the id is', () => {
  for (const id of [STEP, pressed('Anything At All.epub'), 'export:']) {
    assert.throws(
      () => target.chooseNarrationExport(id, [], PROJECT),
      (err) => {
        assert.match(err.message, /has no exported EPUB from this project/);
        assert.match(err.message, /Export the book from Foundry first/);
        return true;
      },
      `id ${id} should refuse with the export-first sentence`);
    }
});

test('zero exports BEATS a named file — the order of the two refusals is load-bearing', () => {
  // "The press named X and there is no X" is true here but useless: it sends the
  // user hunting for a file when what they need is to export the book once.
  assert.throws(
    () => target.chooseNarrationExport(pressed('Whatever.epub'), [], PROJECT),
    (err) => {
      assert.match(err.message, /has no exported EPUB from this project/);
      assert.doesNotMatch(err.message, /The press named/);
      return true;
    });
});

test('the project id appears in the refusals, since it is the folder the user goes looking at', () => {
  assert.throws(
    () => target.chooseNarrationExport(STEP, [], PROJECT),
    new RegExp(PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  console.log(`\nfoundry-narrate-target: ${passed} test(s) passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
