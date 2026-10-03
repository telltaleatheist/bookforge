/**
 * Keeper for the narration glossary — `electron/narration-glossary.ts`.
 *
 *   node tools/test-narration-glossary.js
 *
 * The book's printed forms are decided ONCE, from sentences across the book,
 * and handed to the cleanup as fixed readings (Owen, 2026-10-03). What this
 * holds it to, with no server and no GPU (the lister and the asker injected):
 *
 *  - every form is asked once, and a re-run asks NOTHING — the cleanup behind a
 *    triage finds every decision made;
 *  - a form whose evidence changed is asked again; a PERSON's decision never is,
 *    and is never overwritten;
 *  - the readings file holds exactly the decided readings, with the right finds:
 *    the bare spelling where the book also prints one ("esp", so "her esp."
 *    keeps its stop), the dotted one where it does not ("ed.");
 *  - an answer that cannot be given to the book (a numeral's name dropped, a
 *    digit, the form again, unparseable) becomes "depends" — the sentence pass,
 *    exactly as before the glossary;
 *  - no readings, no file: the run is handed nothing.
 *
 * Runs against the compiled `dist/electron` (tsc -p tsconfig.electron.json).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
process.env.BOOKFORGE_USER_DATA = process.env.BOOKFORGE_USER_DATA
  || fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-userdata-'));
require(path.join(REPO, 'cli', 'electron-stub.js'));
const glossary = require(path.join(REPO, 'dist', 'electron', 'narration-glossary.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
  }
}

const HELLWORLD = [
  {
    key: 'Wolf IV', kind: 'roman', count: 14, printed: { 'Wolf IV': 14 },
    samples: [{ parts: 'e-5', sentence: 'The pinnace slowly circled the storm-shrouded planet Wolf IV.' }],
  },
  {
    key: 'esp', kind: 'abbreviation', count: 26, printed: { esp: 23, 'esp.': 3 },
    samples: [{ parts: 'e-586', sentence: 'DeChance gently touched the sphere with her esp.' }],
  },
  {
    key: 'no', kind: 'abbreviation', count: 213, printed: { no: 200, No: 13 },
    samples: [{ parts: 'e-9', sentence: 'There was no answer.' }],
  },
  {
    key: 'ed', kind: 'abbreviation', count: 7, printed: { 'ed.': 7 },
    samples: [{ parts: 'b9', sentence: 'Reprinted in The Letters, ed. John Smith.' }],
  },
];

const ANSWERS = {
  'Wolf IV': { decision: 'reading', reading: 'Wolf Four', why: 'a planet' },
  esp: { decision: 'reading', reading: 'ESP', why: 'a psychic sense' },
  no: { decision: 'as-printed', reading: '', why: 'the ordinary word' },
  ed: { decision: 'reading', reading: 'edited by', why: 'a citation' },
};

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'));
  const readings = path.join(dir, 'readings');
  fs.mkdirSync(readings);
  return {
    dir,
    request: { kind: 'clean', inputPath: path.join(dir, 'book.epub'), recordsPath: path.join(readings, 'book-1.clean.records.jsonl') },
    glossaryFile: path.join(readings, 'book-1.narration-glossary.json'),
    readingsFile: path.join(readings, 'book-1.narration-glossary.readings.json'),
  };
}

function run(where, forms, answers, asked) {
  return glossary.ensureNarrationGlossary({
    request: where.request,
    server: 'test-crucible',
    signal: new AbortController().signal,
    report: () => {},
    listForms: async () => ({ format: 'printed-forms/v1', source: 'book.jsonl', forms }),
    model: 'test-27b',
    ask: async (form) => {
      asked.push(form.key);
      return answers[form.key];
    },
  });
}

(async () => {
  console.log('narration glossary');

  await test('every form is asked once, and the readings are written with the right finds', async () => {
    const where = scratch();
    const asked = [];
    const out = await run(where, HELLWORLD, ANSWERS, asked);
    assert.deepStrictEqual(asked.sort(), ['Wolf IV', 'ed', 'esp', 'no']);
    assert.strictEqual(out.readingsPath, where.readingsFile);
    assert.deepStrictEqual(out, { readingsPath: where.readingsFile, forms: 4, asked: 4, readings: 3 });
    const handed = JSON.parse(fs.readFileSync(where.readingsFile, 'utf8'));
    assert.strictEqual(handed.format, 'fixed-readings/v1');
    assert.deepStrictEqual(handed.readings, [
      { find: 'Wolf IV', replace: 'Wolf Four' },
      // "esp" is also printed bare, so the bare spelling is the find and "esp." keeps its stop.
      { find: 'esp', replace: 'ESP' },
      // "ed." is only ever printed with its period, so the reading consumes it.
      { find: 'ed.', replace: 'edited by' },
    ]);
    const file = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8'));
    assert.strictEqual(file.format, 'narration-glossary/v1');
    assert.deepStrictEqual(file.entries.map((e) => e.key), ['Wolf IV', 'esp', 'no', 'ed'], 'the book\'s order');
    assert.ok(file.entries.every((e) => e.by === 'model' && e.model === 'test-27b' && typeof e.question === 'string'));
  });

  await test('a re-run asks nothing; changed evidence is asked again', async () => {
    const where = scratch();
    await run(where, HELLWORLD, ANSWERS, []);
    const again = [];
    const out = await run(where, HELLWORLD, ANSWERS, again);
    assert.deepStrictEqual(again, []);
    assert.strictEqual(out.asked, 0);
    assert.strictEqual(out.readings, 3);

    const edited = HELLWORLD.map((f) => (f.key === 'esp'
      ? { ...f, samples: [{ parts: 'e-1106', sentence: 'It seems we have come across an alien with very strong esp.' }] }
      : f));
    const third = [];
    await run(where, edited, ANSWERS, third);
    assert.deepStrictEqual(third, ['esp']);
  });

  await test('a person\'s decision is never asked again and never overwritten', async () => {
    const where = scratch();
    await run(where, HELLWORLD, ANSWERS, []);
    const file = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8'));
    const wolf = file.entries.find((e) => e.key === 'Wolf IV');
    Object.assign(wolf, { reading: 'Wolf the Fourth', by: 'person', why: 'the author says so' });
    delete wolf.question;
    // And a person's entry for a form the book no longer prints survives in the file.
    file.entries.push({ key: 'Rigel VII', kind: 'roman', count: 1, printed: { 'Rigel VII': 1 }, decision: 'reading',
      reading: 'Rigel Seven', why: 'mine', by: 'person', at: '2026-10-03T00:00:00.000Z' });
    fs.writeFileSync(where.glossaryFile, JSON.stringify(file));

    const asked = [];
    await run(where, HELLWORLD, { ...ANSWERS, 'Wolf IV': { decision: 'reading', reading: 'Wolf Four', why: 'x' } }, asked);
    assert.deepStrictEqual(asked, []);
    const after = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8'));
    assert.strictEqual(after.entries.find((e) => e.key === 'Wolf IV').reading, 'Wolf the Fourth');
    assert.ok(after.entries.some((e) => e.key === 'Rigel VII'), 'an orphaned person entry is kept in the file');
    const handed = JSON.parse(fs.readFileSync(where.readingsFile, 'utf8')).readings;
    assert.deepStrictEqual(handed.find((r) => r.find === 'Wolf IV'), { find: 'Wolf IV', replace: 'Wolf the Fourth' });
    assert.ok(!handed.some((r) => r.find === 'Rigel VII'), 'but it is not handed to a run with nothing to read');
  });

  await test('an answer the book cannot be given is left to each sentence', async () => {
    const where = scratch();
    const forms = [
      { key: 'Pius IX', kind: 'roman', count: 20, printed: { 'Pius IX': 20 }, samples: [{ parts: 'b1', sentence: 'Pius IX refused.' }] },
      { key: 'ca', kind: 'abbreviation', count: 1, printed: { 'ca.': 1 }, samples: [{ parts: 'b2', sentence: 'ca. 1850' }] },
      { key: 'Dr', kind: 'abbreviation', count: 13, printed: { Dr: 13 }, samples: [{ parts: 'b3', sentence: 'Dr Jones' }] },
      { key: 'SS', kind: 'caps', count: 7, printed: { SS: 7 }, samples: [{ parts: 'b4', sentence: 'The SS arrived.' }] },
      { key: 'v', kind: 'abbreviation', count: 1, printed: { v: 1 }, samples: [{ parts: 'b5', sentence: 'v' }] },
    ];
    const out = await run(where, forms, {
      'Pius IX': { decision: 'reading', reading: 'Pope the Ninth', why: 'a pope' },
      ca: { decision: 'reading', reading: 'circa 10', why: 'a date' },
      Dr: { decision: 'reading', reading: 'Dr', why: 'a title' },
      SS: { decision: 'reading', reading: '', why: 'nothing' },
      v: 'the answer was not JSON (oops)',
    }, []);
    assert.strictEqual(out.readings, 0);
    assert.strictEqual(out.readingsPath, null);
    assert.ok(!fs.existsSync(where.readingsFile), 'no readings, no file: the run is handed nothing');
    const entries = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8')).entries;
    assert.ok(entries.every((e) => e.decision === 'depends' && e.reading === ''));
    assert.match(entries.find((e) => e.key === 'Pius IX').why, /does not keep "Pius"/);
    assert.match(entries.find((e) => e.key === 'ca').why, /prints a digit/);
    assert.match(entries.find((e) => e.key === 'Dr').why, /is the form as printed/);
    assert.match(entries.find((e) => e.key === 'SS').why, /gave none/);
    assert.match(entries.find((e) => e.key === 'v').why, /not JSON/);
  });

  await test('the triage and its cleanup share one glossary', () => {
    const where = scratch();
    const clean = glossary.glossaryPathsFor(where.request);
    const triage = glossary.glossaryPathsFor({
      kind: 'clean-triage', inputPath: where.request.inputPath,
      outputPath: where.request.recordsPath.replace('.clean.records.jsonl', '.clean.triage.json'),
    });
    assert.deepStrictEqual(triage, clean);
    assert.throws(() => glossary.glossaryPathsFor({ kind: 'clean', inputPath: 'x' }), /names no records or verdicts file/);
  });

  await test('the prompt says the narrator is literal, and the question carries the evidence', () => {
    assert.match(glossary.GLOSSARY_SYSTEM, /says EXACTLY what is printed/);
    assert.match(glossary.GLOSSARY_SYSTEM, /A roman numeral is never "as-printed"/);
    assert.match(glossary.GLOSSARY_SYSTEM, /NOT expanded into its full name/);
    const q = glossary.questionFor(HELLWORLD[0]);
    assert.match(q, /The form: "Wolf IV" — printed 14 times/);
    assert.match(q, /storm-shrouded planet Wolf IV/);
    assert.notStrictEqual(glossary.questionDigest(HELLWORLD[0], 'a'), glossary.questionDigest(HELLWORLD[0], 'b'),
      'another model is another question');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
