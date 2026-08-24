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
 *
 * ── And since narrate-from-any-step, three more ─────────────────────────────
 *
 *  - A STEP IS ANSWERED WITH ITS OWN FILE OR WITH NONE. Never with another
 *    step's, and never with "the only one there is" — that is an audiobook of
 *    words the user was not standing on, delivered an hour of GPU later, and it
 *    is the one wrong answer nothing downstream could notice.
 *  - "I DO NOT KNOW" IS NOT A MATCH. Every export filed before Foundry announced
 *    the step, and every export the tray sweep found, carries no `stepId`. Those
 *    records ask for an export rather than claiming the press, which costs one
 *    re-export and buys a library that heals itself as it is used.
 *  - THE AUTO-EXPORT ARM BELONGS TO STEPS ALONE. A press that named a file is
 *    still refused when the name is not there — the identity law does not grow a
 *    second chance.
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

/**
 * One export, as `foundrySource` records it.
 *
 * `stepId` is OMITTED rather than nulled when it is not given, because that is
 * what an old record looks like on disk — every export filed before Foundry
 * announced the step, and every export the tray sweep found. The fixtures below
 * that pass two arguments are therefore not shorthand: they are the pre-`stepId`
 * library, and the cases built on them are the compatibility cases.
 */
const ex = (id, fileName, stepId) => (
  stepId === undefined ? { id, fileName } : { id, fileName, stepId });

const ONE = [ex('v-1', 'Working Towards the Fuhrer (en).epub')];
const TWO = [
  ex('v-1', 'Working Towards the Fuhrer (en).epub'),
  ex('v-2', 'Working Towards the Fuhrer (de).epub'),
];

/** The id an export row's press sends, per foundry's `exportNodeId`. */
const pressed = (file) => `export:final/${file}`;

/** A ledger step id: randomUUID, no colon. */
const STEP = '7c1e0b4a-2f65-4a1e-9a3b-15d0c4e8f2aa';
/** A second one, for the step nothing in the library came from. */
const OTHER_STEP = 'b0f24d17-88ac-4d3e-8f01-6a9e2c33bb47';

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

// ── The door: which of the three answers a press gets ───────────────────────
//
// `resolveNarrationTarget` is what the invoke path actually asks, and it exists
// because Owen ruled that a step can be narrated: "if they arent doing it from
// an epub then we export the epub automatically and then run the task they
// assigned." So there is a third answer beside "this variant" and "no" — and it
// is the one the cases below are mostly about, because it is the answer that
// costs a re-export when it is wrong in one direction and narrates the wrong
// words when it is wrong in the other.

/** The exports of a library where each file knows the step it came from. */
const STAMPED = [
  ex('v-1', 'Working Towards the Fuhrer (en).epub', STEP),
  ex('v-2', 'Working Towards the Fuhrer (de).epub', OTHER_STEP),
];

test('a step id that exactly one export was cast from resolves that export', () => {
  assert.deepStrictEqual(
    target.resolveNarrationTarget(STEP, STAMPED, PROJECT),
    { kind: 'variant', variantId: 'v-1' });
});

test('the other step among the same two resolves the other export', () => {
  // Both directions, for the reason the named cases test both: "it happened to
  // pick the right one" and "it picks the first one" are indistinguishable from
  // one assertion.
  assert.deepStrictEqual(
    target.resolveNarrationTarget(OTHER_STEP, STAMPED, PROJECT),
    { kind: 'variant', variantId: 'v-2' });
});

test('a step nothing was cast from asks for an export rather than refusing', () => {
  const unknown = 'e5b1c9d0-4a77-4d61-9c22-0f8e4b1a6d33';
  assert.deepStrictEqual(
    target.resolveNarrationTarget(unknown, STAMPED, PROJECT),
    { kind: 'export-from-step', stepId: unknown });
});

test('a step is never answered with another step\'s file, even when it is the only one', () => {
  // The failure this forbids, and the whole reason the step arm does not fall
  // through to uniqueness: narrating the one export in the tray would hand back
  // an audiobook of words the user was not standing on.
  const only = [ex('v-1', 'Working Towards the Fuhrer (en).epub', OTHER_STEP)];
  assert.deepStrictEqual(
    target.resolveNarrationTarget(STEP, only, PROJECT),
    { kind: 'export-from-step', stepId: STEP });
});

test('records that predate stepId ask for an export — unknown is never read as a match', () => {
  // The pre-`stepId` library, exactly as it sits on disk today: one EPUB, filed
  // before Foundry announced the step. It cannot say where it came from, so it
  // does not answer, and the book is exported once. After that landing the
  // record knows its step and the next press resolves instantly.
  assert.deepStrictEqual(
    target.resolveNarrationTarget(STEP, ONE, PROJECT),
    { kind: 'export-from-step', stepId: STEP });
  assert.deepStrictEqual(
    target.resolveNarrationTarget(STEP, TWO, PROJECT),
    { kind: 'export-from-step', stepId: STEP });
});

test('a project with no exports at all asks for one, rather than saying "export it first"', () => {
  // The export-first refusal is still right for a press that NAMED a file (below);
  // it is exactly wrong for a step press, which is a person asking for the file
  // to be made.
  assert.deepStrictEqual(
    target.resolveNarrationTarget(STEP, [], PROJECT),
    { kind: 'export-from-step', stepId: STEP });
});

test('two exports from ONE step refuse in the uniqueness rule\'s own words', () => {
  // A re-export under a name the book's metadata changed leaves two rows with
  // one provenance. Which was meant is the question a nameless press has always
  // asked, so it is asked of these two and not answered a second way.
  const bothFromOneStep = [
    ex('v-1', 'Working Towards the Fuhrer (en).epub', STEP),
    ex('v-2', 'Working Towards the Fuhrer (1993).epub', STEP),
  ];
  assert.throws(
    () => target.resolveNarrationTarget(STEP, bothFromOneStep, PROJECT),
    (err) => {
      assert.match(err.message, /has exported 2 EPUBs/);
      assert.match(err.message, /does not say which one it is/);
      return true;
    });
});

test('a named press goes through the door unchanged, identity law and all', () => {
  assert.deepStrictEqual(
    target.resolveNarrationTarget(
      pressed('Working Towards the Fuhrer (de).epub'), TWO, PROJECT),
    { kind: 'variant', variantId: 'v-2' });
  // And the stamps play no part in it: a press that names a file names the answer.
  assert.deepStrictEqual(
    target.resolveNarrationTarget(
      pressed('Working Towards the Fuhrer (en).epub'), STAMPED, PROJECT),
    { kind: 'variant', variantId: 'v-1' });
});

test('a named press is still REFUSED rather than exported, however wrong the name', () => {
  // The auto-export arm belongs to steps alone. A press on an export row that
  // this library has no version for is a mismatch to say out loud — exporting
  // something in its place would answer a question nobody asked.
  assert.throws(
    () => target.resolveNarrationTarget(pressed('A Book Nobody Exported.epub'), TWO, PROJECT),
    /has no exported EPUB filed/);
  assert.throws(
    () => target.resolveNarrationTarget(pressed('Anything.epub'), [], PROJECT),
    /has no exported EPUB from this project/);
});

// ── Kept snapshots beside live exports (Owen's Keep-then-Narrate, 2026-08-24) ─

test('a KEPT export with no live twin answers a named press — Keep must not hide the file', () => {
  const kept = [{ id: 'v-kept', fileName: 'evangelische kirche (en).epub', kept: true }];
  assert.deepStrictEqual(
    target.resolveNarrationTarget(pressed('evangelische kirche (en).epub'), kept, PROJECT),
    { kind: 'variant', variantId: 'v-kept' });
});

test('a kept snapshot stands aside for the live export of the same file', () => {
  // Keep, then re-export: the kept file is never overwritten, so the fresh
  // landing is a second row under the same tray name. The press is on the
  // tray's CURRENT bytes — the live export answers, silently-oldest does not.
  const pair = [
    { id: 'v-kept', fileName: 'Book (en).epub', kept: true, stepId: 'step-x' },
    { id: 'v-live', fileName: 'Book (en).epub', stepId: 'step-x' },
  ];
  assert.deepStrictEqual(
    target.resolveNarrationTarget(pressed('Book (en).epub'), pair, PROJECT),
    { kind: 'variant', variantId: 'v-live' });
  // The step arm sees the same shadowing: both rows carry step-x, and the
  // press means the current bytes there too.
  assert.deepStrictEqual(
    target.resolveNarrationTarget('step-x', pair, PROJECT),
    { kind: 'variant', variantId: 'v-live' });
  // Different names never shadow each other.
  assert.strictEqual(target.dedupeNarrationExports([
    { id: 'a', fileName: 'one.epub', kept: true },
    { id: 'b', fileName: 'two.epub' },
  ]).length, 2);
});

test('two KEPT versions under one name refuse by name — neither is the tray\'s current bytes', () => {
  const twins = [
    { id: 'v-kept-1', fileName: 'Book (en).epub', kept: true },
    { id: 'v-kept-2', fileName: 'Book (en).epub', kept: true },
  ];
  assert.throws(
    () => target.resolveNarrationTarget(pressed('Book (en).epub'), twins, PROJECT),
    /2 kept versions filed under "Book \(en\)\.epub"/);
});

// ── The translation guard on the auto-export arm ───────────────────────────
//
// The 2026-08-24 incident's ledger, in miniature: a German scan read, edited,
// translated to English, edited again. A press upstream of the translation is
// the parked-position accident and must be refused by name; a press on or after
// it is the ordinary case and must pass.

/** The incident's chain: capture → import → read(de) → edit → translate(en) → edit. */
const LEDGER = [
  { id: 'cap', parent: null, action: 'capture', label: 'Photographs' },
  { id: 'imp', parent: 'cap', action: 'import', label: 'The pages you minted' },
  { id: 'read', parent: 'imp', action: 'read', label: 'Read (168 pages)', language: 'de' },
  { id: 'ed1', parent: 'read', action: 'edit', label: 'Applied changes (12)' },
  { id: 'tr', parent: 'ed1', action: 'translate', label: 'Translated (en)', language: 'en' },
  { id: 'ed2', parent: 'tr', action: 'edit', label: 'Applied changes (777)' },
];

test('a press upstream of the translation is the incident, and is named', () => {
  const verdict = target.stepPressTranslationCheck('read', LEDGER);
  assert.strictEqual(verdict.kind, 'leaves-out-translations');
  assert.deepStrictEqual(verdict.languages, ['en']);
  assert.strictEqual(verdict.pressedLabel, 'Read (168 pages)',
    'the refusal says which step was pressed, in its own name');
  // The edit BETWEEN read and translate is upstream too — same accident.
  assert.strictEqual(target.stepPressTranslationCheck('ed1', LEDGER).kind,
    'leaves-out-translations');
});

test('a press on or after the translation passes', () => {
  assert.deepStrictEqual(target.stepPressTranslationCheck('tr', LEDGER), { kind: 'ok' });
  assert.deepStrictEqual(target.stepPressTranslationCheck('ed2', LEDGER), { kind: 'ok' });
});

test('a book with no translations has nothing to protect', () => {
  const untranslated = LEDGER.filter((s) => s.action !== 'translate')
    .map((s) => s.id === 'ed2' ? { ...s, parent: 'ed1' } : s);
  assert.deepStrictEqual(target.stepPressTranslationCheck('read', untranslated), { kind: 'ok' });
});

test('an unknown step is not judged here — Foundry refuses it by name', () => {
  assert.deepStrictEqual(target.stepPressTranslationCheck('no-such-step', LEDGER),
    { kind: 'unknown-step' });
  assert.deepStrictEqual(target.stepPressTranslationCheck('read', []),
    { kind: 'unknown-step' });
});

test('a sibling branch\'s translation is not something this press left out', () => {
  // The ledger is a tree. A second language abandoned on another branch must not
  // refuse a press standing on its own translated line.
  const branched = [...LEDGER,
    { id: 'tr-fr', parent: 'ed1', action: 'translate', label: 'Translated (fr)', language: 'fr' }];
  assert.deepStrictEqual(target.stepPressTranslationCheck('ed2', branched), { kind: 'ok' });
  // But a press upstream of BOTH still refuses, naming both languages.
  const verdict = target.stepPressTranslationCheck('read', branched);
  assert.strictEqual(verdict.kind, 'leaves-out-translations');
  assert.deepStrictEqual(verdict.languages, ['en', 'fr']);
});

test('a translate step that recorded no language still refuses', () => {
  // It is the STEP being left out that matters, not our ability to name it.
  const unnamed = LEDGER.map((s) => {
    if (s.id !== 'tr') return s;
    const { language, ...rest } = s;
    return rest;
  });
  const verdict = target.stepPressTranslationCheck('read', unnamed);
  assert.strictEqual(verdict.kind, 'leaves-out-translations');
  assert.deepStrictEqual(verdict.languages, []);
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
