/**
 * Keeper for the narration glossary — `electron/narration-glossary.ts`.
 *
 *   node tools/test-narration-glossary.js
 *
 * The book's pronunciation guide: each printed form's MEANINGS decided once from
 * sentences across the book, each OCCURRENCE placed in one of them, and every
 * placed occurrence read at its spot (Owen, 2026-10-03: "we need a way to know if
 * it's an instance of "esp" the mental ability or "esp." meaning especially").
 * What this holds it to, with no server and no GPU (lister, asker and placer
 * injected):
 *
 *  - one form, two meanings, one book: every spot gets its own meaning's reading,
 *    and a period stays or goes by the meaning and the sentence's end;
 *  - a re-run asks and places NOTHING — the guide is kept as it stands, and a
 *    cleanup decides only what it lacks (a new spot); only FROM ZERO drops it all,
 *    a person's decisions included (Owen, 2026-10-03);
 *  - occurrences placed in NO meaning are a meaning the samples missed: the
 *    meanings are asked again with those sentences, once, and placed again;
 *  - an unsure placing, an unusable reading or an unreadable answer leaves the
 *    spot as printed, for the sentence pass, exactly as before the glossary;
 *  - a person's meanings and a person's placings are never redone, short of from zero;
 *  - the review (`pronunciation-review.ts`): a reading changed, a form or a spot
 *    left to the narrator, is what the next cleanup is handed; a stale save is refused;
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
const review = require(path.join(REPO, 'dist', 'electron', 'pronunciation-review.js'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 5).join('\n       ') : err}`);
  }
}

/** An occurrence as Foundry names it. */
function occ(at, nth, printed, sentence, endsSentence = false) {
  return { at, nth, printed, sentence, inSentence: sentence.indexOf(printed), endsSentence };
}

const WOLF = {
  key: 'Wolf IV', kind: 'roman', count: 2, printed: { 'Wolf IV': 2 },
  samples: [{ parts: 'e-5', sentence: 'The pinnace circled the planet Wolf IV.' }],
  occurrences: [
    occ('e-5', 0, 'Wolf IV', 'The pinnace circled the planet Wolf IV.', true),
    occ('e-491', 0, 'Wolf IV', 'Never a dull moment on Wolf IV, said Hunter.'),
  ],
};
// One book, two meanings: the psychic sense and the abbreviation for especially.
const ESP = {
  key: 'esp', kind: 'abbreviation', count: 4, printed: { esp: 2, 'esp.': 2 },
  samples: [
    { parts: 'e-344', sentence: 'Her esp kept failing her.' },
    { parts: 'e-586', sentence: 'She touched the sphere with her esp.' },
    { parts: 'e-700', sentence: 'The cold was hard, esp. at night.' },
  ],
  occurrences: [
    occ('e-344', 0, 'esp', 'Her esp kept failing her.'),
    occ('e-586', 0, 'esp.', 'She touched the sphere with her esp.', true),
    occ('e-700', 0, 'esp.', 'The cold was hard, esp. at night.'),
    occ('e-900', 0, 'esp', 'Use your esp now.'),
  ],
};
const NO = {
  key: 'no', kind: 'abbreviation', count: 1, printed: { no: 1 },
  samples: [{ parts: 'e-9', sentence: 'There was no answer.' }],
  occurrences: [occ('e-9', 0, 'no', 'There was no answer.')],
};
const BOOK = [WOLF, ESP, NO];

const MEANINGS = {
  'Wolf IV': { decision: 'reading', senses: [{ meaning: 'a planet', reading: 'Wolf Four', periodIsPart: false }], why: 'orbited, landed on' },
  esp: {
    decision: 'reading',
    senses: [
      { meaning: 'ESP, the psychic sense', reading: 'ESP', periodIsPart: false },
      { meaning: 'esp., short for especially', reading: 'especially', periodIsPart: true },
    ],
    why: 'a mental power, and an abbreviation',
  },
  no: { decision: 'as-printed', senses: [], why: 'the ordinary word' },
};

/** Place by the sentence: the psychic sense unless the sentence is about the cold. */
const PLACINGS = (form, senses, occurrences) => occurrences.map((o) => {
  if (form.key === 'Wolf IV') return { choice: 's0', confidence: 0.97 };
  return /cold/.test(o.sentence) ? { choice: 's1', confidence: 0.93 } : { choice: 's0', confidence: 0.95 };
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'));
  const readings = path.join(dir, 'readings');
  fs.mkdirSync(readings);
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ key: 'book-1', title: 'The Book' }));
  return {
    dir,
    request: { kind: 'clean', inputPath: path.join(dir, 'book.epub'), recordsPath: path.join(readings, 'book-1.clean.records.jsonl') },
    glossaryFile: path.join(readings, 'book-1.narration-glossary.json'),
    readingsFile: path.join(readings, 'book-1.narration-glossary.readings.json'),
  };
}

function run(where, forms, { meanings = MEANINGS, placings = PLACINGS, asked = [], placed = [], fromZero = false } = {}) {
  return glossary.ensureNarrationGlossary({
    fromZero,
    source: { files: glossary.glossaryPathsFor(where.request), list: async () => ({ format: 'printed-forms/v1', source: 'book.jsonl', forms }) },
    server: 'test-crucible',
    signal: new AbortController().signal,
    report: () => {},
    model: 'test-27b',
    ask: async (form, secondLook, focus) => {
      if (focus !== null) {
        // A meaning's own reading: the sense of that name, alone.
        asked.push([form.key, 'focus']);
        // Every meaning the test knows for this form, whichever round named it.
        const rounds = typeof meanings === 'function'
          ? [meanings(form, null), meanings(form, { sentences: [], meanings: [] })]
          : [meanings[form.key]];
        const all = [...rounds.flatMap((r) => r.senses), ...(MEANINGS[form.key]?.senses ?? [])];
        const alone = all.find((s) => s.meaning === focus);
        return { decision: 'reading', senses: alone === undefined ? [] : [alone], why: `alone: ${form.count}` };
      }
      asked.push([form.key, secondLook === null ? 0 : secondLook.sentences.length]);
      return typeof meanings === 'function' ? meanings(form, secondLook) : meanings[form.key];
    },
    place: async (form, senses, occurrences) => {
      placed.push([form.key, occurrences.length]);
      return placings(form, senses, occurrences);
    },
  });
}

const guide = (where) => JSON.parse(fs.readFileSync(where.readingsFile, 'utf8')).readings;
/** The spots the guide READ — a kept spot (replace = find) is said as printed, and protected. */
const read = (where) => guide(where).filter((r) => r.replace !== r.find);
const kept = (where) => guide(where).filter((r) => r.replace === r.find);
const entries = (where) => JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8')).entries;

(async () => {
  console.log('narration glossary');

  await test('one form, two meanings: every spot reads its own, and a period stays or goes by meaning', async () => {
    const where = scratch();
    const asked = [];
    const placed = [];
    const out = await run(where, BOOK, { asked, placed });
    assert.deepStrictEqual(asked.filter((a) => a[1] !== 'focus').map((a) => a[0]).sort(), ['Wolf IV', 'esp', 'no']);
    // A form of two meanings has each meaning's reading asked alone, with its own sentences.
    assert.deepStrictEqual(asked.filter((a) => a[1] === 'focus'), [['esp', 'focus'], ['esp', 'focus']]);
    // "no" is as printed: nothing to place.
    assert.deepStrictEqual(placed.map((p) => p[0]).sort(), ['Wolf IV', 'esp']);
    assert.deepStrictEqual(read(where), [
      { find: 'Wolf IV', replace: 'Wolf Four', at: 'e-5', nth: 0 },
      { find: 'Wolf IV', replace: 'Wolf Four', at: 'e-491', nth: 0 },
      { find: 'esp', replace: 'ESP', at: 'e-344', nth: 0 },
      // The psychic sense's period can only be the sentence's: it stays.
      { find: 'esp.', replace: 'ESP.', at: 'e-586', nth: 0 },
      // The abbreviation's period is its own, mid-sentence: the reading consumes it.
      { find: 'esp.', replace: 'especially', at: 'e-700', nth: 0 },
      { find: 'esp', replace: 'ESP', at: 'e-900', nth: 0 },
    ]);
    // "no", decided as printed outright, is KEPT at its spot, so the sentence pass cannot rewrite it.
    assert.deepStrictEqual(kept(where), [{ find: 'no', replace: 'no', at: 'e-9', nth: 0 }]);
    assert.deepStrictEqual(out, { readingsPath: where.readingsFile, forms: 3, asked: 5, placed: 6, readings: 7, unplaced: 0 });
    const esp = entries(where).find((e) => e.key === 'esp');
    assert.deepStrictEqual(esp.occurrences.map((o) => o.sense), [0, 0, 1, 0]);
    assert.strictEqual(entries(where)[0].key, 'Wolf IV', 'the book\'s order');
  });

  await test('a re-run asks and places nothing; a new occurrence is placed alone, nothing re-asked', async () => {
    const where = scratch();
    await run(where, BOOK);
    const asked = [];
    const placed = [];
    const out = await run(where, BOOK, { asked, placed });
    assert.deepStrictEqual([asked, placed], [[], []]);
    assert.strictEqual(out.readings, 7);

    const grown = BOOK.map((f) => (f.key === 'Wolf IV'
      ? { ...f, count: 3, occurrences: [...f.occurrences, occ('e-1200', 0, 'Wolf IV', 'They left Wolf IV behind.')] }
      : f));
    const asked2 = [];
    const placed2 = [];
    await run(where, grown, { asked: asked2, placed: placed2 });
    assert.deepStrictEqual(asked2, []);
    // Only the spot the guide has not placed: the two it placed stand.
    assert.deepStrictEqual(placed2, [['Wolf IV', 1]]);
    assert.strictEqual(read(where).filter((r) => r.find === 'Wolf IV').length, 3);
  });

  await test('occurrences that fit no meaning are asked about again, once, as evidence', async () => {
    const where = scratch();
    const asked = [];
    // First the model sees only the psychic sense; the door then finds the cold sentence fits none.
    const meanings = (form, secondLook) => {
      if (form.key !== 'esp') return MEANINGS[form.key];
      return secondLook === null
        ? { decision: 'reading', senses: [MEANINGS.esp.senses[0]], why: 'a mental power' }
        : MEANINGS.esp;
    };
    const placings = (form, senses, occurrences) => occurrences.map((o) => {
      if (form.key !== 'esp') return { choice: 's0', confidence: 0.97 };
      if (!/cold/.test(o.sentence)) return { choice: 's0', confidence: 0.95 };
      return senses.length === 1 ? { choice: 'none', confidence: 0.9 } : { choice: 's1', confidence: 0.9 };
    });
    await run(where, BOOK, { meanings, placings, asked });
    assert.deepStrictEqual(asked.filter((a) => a[0] === 'esp' && a[1] !== 'focus'), [['esp', 0], ['esp', 1]],
      'asked once, then again with the one sentence that fitted nothing');
    assert.ok(guide(where).some((r) => r.at === 'e-700' && r.replace === 'especially'));
    // The second look tells the model what it said and what fitted none of it.
    const q = glossary.questionFor(ESP, { sentences: ['The cold was hard, esp. at night.'], meanings: [MEANINGS.esp.senses[0]] });
    assert.match(q, /gave these senses:\n- ESP, the psychic sense \(said "ESP"\)/);
    assert.match(q, /fit NONE of them:\n1\. The cold was hard, esp\. at night\./);
  });

  await test('a form decided as printed is placed too, and a stray second meaning is found', async () => {
    const where = scratch();
    const no = {
      key: 'no', kind: 'abbreviation', count: 3, printed: { no: 2, 'No.': 1 },
      samples: [{ parts: 'b1', sentence: 'There was no answer.' }],
      occurrences: [
        occ('b1', 0, 'no', 'There was no answer.'),
        occ('b2', 0, 'no', 'He had no choice.'),
        occ('b3', 0, 'No.', 'See the file, No. 12, in the archive.'),
      ],
    };
    const word = { meaning: 'the word no', kind: 'word', reading: '', periodIsPart: false };
    const number = { meaning: 'No., short for number', kind: 'abbreviation', reading: 'Number', periodIsPart: true };
    const asked = [];
    const out = await run(where, [no], {
      asked,
      meanings: (form, secondLook) => (secondLook === null
        ? { decision: 'as-printed', senses: [word], why: 'the word' }
        : { decision: 'reading', senses: [word, number], why: 'and a citation number' }),
      placings: (form, senses, occurrences) => occurrences.map((o) => (/No\. 12/.test(o.sentence)
        ? { choice: senses.length > 1 ? 's1' : 'none', confidence: 0.95 }
        : { choice: 's0', confidence: 0.95 })),
    });
    assert.deepStrictEqual(asked.filter((a) => a[1] !== 'focus'), [['no', 0], ['no', 1]]);
    assert.deepStrictEqual(read(where), [{ find: 'No.', replace: 'Number', at: 'b3', nth: 0 }]);
    // The word "no" is placed in its as-printed meaning: kept, and protected.
    assert.deepStrictEqual(kept(where).map((r) => r.at), ['b1', 'b2']);
    assert.strictEqual(out.readings, 3);
  });

  await test('an unsure placing, an unusable reading and an unreadable answer leave spots as printed', async () => {
    const where = scratch();
    const pius = {
      key: 'Pius IX', kind: 'roman', count: 1, printed: { 'Pius IX': 1 },
      samples: [{ parts: 'b1', sentence: 'Pius IX refused.' }], occurrences: [occ('b1', 0, 'Pius IX', 'Pius IX refused.')],
    };
    const v = {
      key: 'v', kind: 'abbreviation', count: 1, printed: { v: 1 },
      samples: [{ parts: 'b2', sentence: 'v' }], occurrences: [occ('b2', 0, 'v', 'v')],
    };
    const out = await run(where, [WOLF, pius, v], {
      meanings: {
        'Wolf IV': MEANINGS['Wolf IV'],
        'Pius IX': { decision: 'reading', senses: [{ meaning: 'a pope', reading: 'Pope the Ninth', periodIsPart: false }], why: 'a pope' },
        v: 'the answer was not JSON (oops)',
      },
      // Unsure about the second Wolf IV.
      placings: (form, senses, occurrences) => occurrences.map((o) => ({ choice: 's0', confidence: o.at === 'e-491' ? 0.3 : 0.9 })),
    });
    // One reading: the unsure Wolf IV is still Wolf Four — there was nothing to choose between.
    assert.deepStrictEqual(read(where), [
      { find: 'Wolf IV', replace: 'Wolf Four', at: 'e-5', nth: 0 },
      { find: 'Wolf IV', replace: 'Wolf Four', at: 'e-491', nth: 0 },
    ]);
    assert.strictEqual(out.unplaced, 1, 'Pius IX, placed in a meaning whose reading is unusable, goes to its sentence');
    assert.ok(!guide(where).some((r) => r.find === 'Pius IX'), 'and is not protected');
    const byKey = Object.fromEntries(entries(where).map((e) => [e.key, e]));
    assert.match(byKey['Pius IX'].senses[0].problem, /does not keep "Pius"/);
    assert.strictEqual(byKey.v.decision, 'as-printed');
    assert.match(byKey.v.why, /not JSON/);
  });

  await test('a person\'s meanings and a person\'s placing are never redone', async () => {
    const where = scratch();
    await run(where, BOOK);
    const file = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8'));
    const wolf = file.entries.find((e) => e.key === 'Wolf IV');
    Object.assign(wolf, { by: 'person', senses: [{ meaning: 'the dynasty\'s world', reading: 'Wolf the Fourth', periodIsPart: false }] });
    delete wolf.question;
    const esp = file.entries.find((e) => e.key === 'esp');
    Object.assign(esp.occurrences[3], { sense: 1, byPerson: true, p: null });
    fs.writeFileSync(where.glossaryFile, JSON.stringify(file));

    const asked = [];
    const placed = [];
    await run(where, BOOK, { asked, placed });
    assert.deepStrictEqual(asked, [], 'no meanings were asked again');
    // Their meaning keeps the spots placed in it: nothing is placed again.
    assert.deepStrictEqual(placed, []);
    assert.ok(guide(where).every((r) => r.find !== 'Wolf IV' || r.replace === 'Wolf the Fourth'));
    assert.deepStrictEqual(guide(where).find((r) => r.at === 'e-900'), { find: 'esp', replace: 'especially', at: 'e-900', nth: 0 });
  });

  await test('nothing read differently is still kept and protected; and the first build\'s file is started afresh', async () => {
    const where = scratch();
    fs.writeFileSync(where.glossaryFile, JSON.stringify({ format: 'narration-glossary/v1', book: 'book-1', entries: [{ key: 'no', by: 'model' }] }));
    const out = await run(where, [NO]);
    assert.strictEqual(out.readingsPath, where.readingsFile);
    assert.deepStrictEqual(read(where), []);
    assert.deepStrictEqual(kept(where), [{ find: 'no', replace: 'no', at: 'e-9', nth: 0 }]);
    // A book that prints no form at all is handed nothing.
    const empty = scratch();
    assert.strictEqual((await run(empty, [])).readingsPath, null);
    assert.ok(!fs.existsSync(empty.readingsFile));
    assert.strictEqual(JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8')).format, 'narration-glossary/v2');

    fs.writeFileSync(where.glossaryFile, JSON.stringify({ format: 'narration-glossary/v1', book: 'book-1', entries: [{ key: 'no', by: 'person' }] }));
    await assert.rejects(run(where, [NO]), /holding a person's decisions/);
  });

  await test('a cleanup keeps the guide; only from zero drops it, a person\'s decisions included', async () => {
    const where = scratch();
    await run(where, BOOK);
    // Make one decision a person's.
    const file = JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8'));
    Object.assign(file.entries.find((e) => e.key === 'no'), { by: 'person' });
    fs.writeFileSync(where.glossaryFile, JSON.stringify(file));

    const again = [];
    await run(where, BOOK, { asked: again });
    assert.deepStrictEqual(again, [], 'a cleanup (or a guide step not from zero) asks nothing the guide decides');

    const fresh = [];
    await run(where, BOOK, { asked: fresh, fromZero: true });
    assert.deepStrictEqual(fresh.filter((a) => a[1] !== 'focus').map((a) => a[0]).sort(), ['Wolf IV', 'esp', 'no'],
      'from zero asks about every form again, the one a person decided included');
    assert.ok(entries(where).every((e) => e.by === 'model'));
    assert.match(JSON.parse(fs.readFileSync(where.glossaryFile, 'utf8')).built, /^\d{4}-/);
  });

  await test('a spot the book no longer lists as a form leaves the guide; its decision stays', async () => {
    const where = scratch();
    await run(where, BOOK);
    const fewer = BOOK.map((f) => (f.key === 'esp' ? { ...f, count: 2, occurrences: f.occurrences.slice(0, 2) } : f));
    const asked = [];
    await run(where, fewer, { asked });
    assert.deepStrictEqual(asked, []);
    const esp = entries(where).find((e) => e.key === 'esp');
    assert.deepStrictEqual(esp.occurrences.map((o) => o.at), ['e-344', 'e-586']);
    assert.strictEqual(esp.senses.length, 2, 'the meanings are the guide\'s still');
  });

  await test('the guide of a project is found by its key, as a cleanup\'s records name it', () => {
    const where = scratch();
    assert.deepStrictEqual(glossary.guidePathsOfProject(where.dir), glossary.glossaryPathsFor(where.request));
    assert.strictEqual(glossary.hasGuide(glossary.guidePathsOfProject(where.dir)), false);
  });

  await test('the review: what a person changes is what the next cleanup is handed', async () => {
    const where = scratch();
    await run(where, BOOK);
    const shown = review.readGuideReview(where.dir, null);
    assert.strictEqual(shown.title, 'The Book');
    const wolf = shown.forms.find((f) => f.key === 'Wolf IV');
    assert.strictEqual(wolf.spots[1].sentence, 'Never a dull moment on Wolf IV, said Hunter.', 'each spot carries its sentence');

    const edit = (f) => ({ key: f.key, kind: f.kind, decision: f.decision, senses: f.senses.map((s) => ({ ...s })),
      spots: f.spots.map((o) => ({ at: o.at, nth: o.nth, printed: o.printed, sense: o.sense })) });
    const forms = shown.forms.map(edit);
    // A reading changed; one spot left to the narrator; a whole form left to the narrator.
    forms.find((f) => f.key === 'Wolf IV').senses[0].reading = 'Wolf Quatre';
    const esp = forms.find((f) => f.key === 'esp');
    esp.senses.push({ meaning: 'As printed — left to the narrator', reading: '', periodIsPart: false });
    esp.spots.find((o) => o.at === 'e-900').sense = esp.senses.length - 1;
    Object.assign(forms.find((f) => f.key === 'no'), { decision: 'as-printed', senses: [], spots: [] });

    const out = review.saveGuideReview({ projectDir: where.dir, version: shown.version, forms });
    // "no" was already as printed with no meanings: leaving it to the narrator changes nothing.
    assert.deepStrictEqual(out, { forms: 2, spots: 1 });
    assert.throws(() => review.saveGuideReview({ projectDir: where.dir, version: shown.version, forms }),
      /changed while you were reviewing/, 'a review of a guide that changed underneath is refused');

    const asked = [];
    const placed = [];
    await run(where, BOOK, { asked, placed });
    assert.deepStrictEqual([asked, placed], [[], []], 'the cleanup decides nothing the review decided');
    assert.ok(read(where).filter((r) => r.find === 'Wolf IV').every((r) => r.replace === 'Wolf Quatre'));
    assert.deepStrictEqual(guide(where).find((r) => r.at === 'e-900'), { find: 'esp', replace: 'esp', at: 'e-900', nth: 0 },
      'left to the narrator: kept, and protected');
    assert.deepStrictEqual(kept(where).filter((r) => r.find === 'no'), [{ find: 'no', replace: 'no', at: 'e-9', nth: 0 }]);
    const byKey = Object.fromEntries(entries(where).map((e) => [e.key, e]));
    assert.strictEqual(byKey['Wolf IV'].by, 'person');
    assert.strictEqual(byKey.esp.occurrences.find((o) => o.at === 'e-900').byPerson, true);
  });

  await test('an acronym is said as printed, never expanded or re-cased (Owen: esp is said essp)', () => {
    const form = { ...ESP };
    const expanded = { meaning: 'the psychic sense', kind: 'acronym', reading: 'extrasensory perception', periodIsPart: true };
    assert.deepStrictEqual(glossary.acronymRead(form, expanded), { ...expanded, reading: '', periodIsPart: false });
    const nasa = { ...form, key: 'NASA', kind: 'caps', printed: { NASA: 3 } };
    assert.strictEqual(glossary.acronymRead(nasa, { ...expanded, reading: 'NASA' }).reading, '', 'already capitals: as printed');
    const especially = { meaning: 'especially', kind: 'abbreviation', reading: 'especially', periodIsPart: true };
    assert.deepStrictEqual(glossary.acronymRead(form, especially), especially, 'an abbreviation keeps the reading the model gave');
    // Capitals are never expanded; read as their letters they are as printed; a shouted word is its word.
    const ceo = { key: 'CEO', kind: 'caps', count: 1, printed: { CEO: 1 }, samples: [], occurrences: [] };
    assert.match(glossary.senseProblem(ceo, { meaning: 'chief', kind: 'abbreviation', reading: 'Chief Executive Officer', periodIsPart: false }),
      /never expanded/);
    assert.strictEqual(glossary.acronymRead({ ...ceo, key: 'DC', printed: { DC: 1 } }, { meaning: 'x', kind: 'abbreviation', reading: 'D C', periodIsPart: false }).reading, '');
    assert.strictEqual(glossary.senseProblem({ ...ceo, key: 'THE', printed: { THE: 2 } }, { meaning: 'the', kind: 'word', reading: 'the', periodIsPart: false }), null);
    // The answer must say what each meaning is.
    assert.match(glossary.parseAnswer(JSON.stringify({ decision: 'reading', senses: [{ meaning: 'x', reading: 'y', periodIsPart: false }], why: '' })),
      /four fields/);
    assert.deepStrictEqual(glossary.parseAnswer(JSON.stringify({
      decision: 'reading', senses: [{ meaning: 'ESP', kind: 'acronym', reading: '', periodIsPart: false }], why: 'w',
    })).senses[0].kind, 'acronym');
  });

  await test('meanings said alike pool their weight; a numeral read without its name gets it back', () => {
    const saint = { meaning: 'a saint', kind: 'abbreviation', reading: 'Saint', periodIsPart: true };
    const city = { meaning: 'in St Petersburg', kind: 'abbreviation', reading: 'Saint', periodIsPart: true };
    const split = { choice: 's0', confidence: 0.48, probabilities: { s0: 0.48, s1: 0.47, none: 0.05 } };
    assert.strictEqual(glossary.placeAnswer([saint, city], split), 0, 'two meanings said "Saint" are one choice');
    const street = { meaning: 'Street', kind: 'abbreviation', reading: 'Street', periodIsPart: true };
    assert.strictEqual(glossary.placeAnswer([saint, street], split), null, 'two readings are two choices');
    assert.strictEqual(glossary.placeAnswer([saint], { choice: 'none', confidence: 0.6, probabilities: { s0: 0.4, none: 0.6 } }), null);
    // One way of saying it, and the door unsure rather than sure it is something else: that way.
    assert.strictEqual(glossary.placeAnswer([saint], { choice: 's0', confidence: 0.4, probabilities: { s0: 0.4, none: 0.35 } }), 0);
    const leopold = { key: 'Leopold II', kind: 'roman', count: 9, printed: { 'Leopold II': 9 }, samples: [], occurrences: [] };
    assert.strictEqual(glossary.acronymRead(leopold, { meaning: 'king', kind: 'numeral', reading: 'the Second', periodIsPart: false }).reading,
      'Leopold the Second');
  });

  await test('the spot replace, the marked sentence and the shared paths', () => {
    const esp = { meaning: 'ESP', reading: 'ESP', periodIsPart: false };
    const especially = { meaning: 'especially', reading: 'especially', periodIsPart: true };
    assert.strictEqual(glossary.spotReplace({ printed: 'esp', endsSentence: false }, esp), 'ESP');
    assert.strictEqual(glossary.spotReplace({ printed: 'esp.', endsSentence: true }, esp), 'ESP.');
    assert.strictEqual(glossary.spotReplace({ printed: 'esp.', endsSentence: false }, esp), 'ESP.');
    assert.strictEqual(glossary.spotReplace({ printed: 'esp.', endsSentence: false }, especially), 'especially');
    assert.strictEqual(glossary.spotReplace({ printed: 'esp.', endsSentence: true }, especially), 'especially.');
    assert.strictEqual(glossary.placingItem(occ('b', 0, 'esp', 'Her esp failed.')), 'Sentence: Her esp failed.');
    const twice = { at: 'b', nth: 1, printed: 'esp', sentence: 'my esp and your esp', inSentence: 16, endsSentence: true };
    assert.strictEqual(glossary.placingItem(twice), 'Sentence: my esp and your esp\n(Asked about the second "esp" in it.)');
    assert.deepStrictEqual(glossary.placingOptions([{ meaning: 'ESP', reading: 'ESP', periodIsPart: false }]),
      { s0: 'ESP', none: 'something else' });

    const where = scratch();
    const triage = glossary.glossaryPathsFor({
      kind: 'clean-triage', inputPath: where.request.inputPath,
      outputPath: where.request.recordsPath.replace('.clean.records.jsonl', '.clean.triage.json'),
    });
    assert.deepStrictEqual(triage, glossary.glossaryPathsFor(where.request));
    assert.match(glossary.GLOSSARY_SYSTEM, /HOW THE AUTHOR PRINTED IT IS THE SIGNAL/);
    assert.match(glossary.GLOSSARY_SYSTEM, /"No\." for number \(said "Number"\) and "no" the word/);
    // The test books' own forms are not the prompt's examples, so a measurement still measures the model.
    assert.doesNotMatch(glossary.GLOSSARY_SYSTEM, /\besp\b|Wolf/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
