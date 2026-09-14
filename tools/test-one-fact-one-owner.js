#!/usr/bin/env node
/**
 * TWO FACTS THAT HAVE TWO COPIES, AND THE COMPARISON NEITHER HAD.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-one-fact-one-owner.js
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `crucible/docs/ARCHITECTURE.md`, the audit of 2026-09-13:
 *
 *   > Almost every defect found is one fact with two owners and nothing
 *   > comparing them. ... None of these is hard. Every one is invisible until
 *   > it reaches output.
 *
 * R1 says a copy that must exist is DERIVED AND CHECKED, never authored twice.
 * This file is the check for the two copies found on 2026-09-13, both of which
 * had already reached output:
 *
 * 1. THE ACRONYM LIST — `python/narrator/text/caps_acronyms.json`, which calls
 *    itself "THE ONE ACRONYM LIST, read by THREE code paths so they can never
 *    drift". Two of the three read DIFFERENT SUBSETS of it. narrator's caps fold
 *    keeps `lettered | spokenAsWord` as printed (paragraph_packer.py
 *    `_load_caps_acronyms`); Listen's mirror of that fold consulted `lettered`
 *    ALONE, so every one of the fifteen `spokenAsWord` entries was title-cased
 *    on the Listen path and kept in the book path — "Nasa" through the
 *    extension, "NASA" in the m4b, from one JSON file and one stated rule.
 *
 *    Four lines under the comment forbidding a second copy there was also a
 *    hard-coded `KEEP_AS_PRINTED = new Set(['WWI', 'WWII'])` — a band-aid over
 *    the missing union, and one that only half worked: narrator has no such set,
 *    its vowel test sees the `I`, and "WWII" was folded to **"Wwii" in the
 *    audiobook**. Both tokens are in the JSON now and the private set is gone.
 *
 * 2. THE SAFE CHUNK BAND — `electron/data/higgs-safe-bands.json` (the overlay a
 *    person edits) and `backends.<arm>.safeMinChars/safeMaxChars` in
 *    `electron/data/higgs-models.json` (the block that keeps the evidence note).
 *    `applySafeBands` merged the first over the second SILENTLY, so `thirdreich`
 *    kept describing 600-1000 for four days after the ladder measured 500-700 —
 *    a range whose own note records 12.5% and 18.8% early stops — and that text
 *    is what Crucible's voice manifest was written from. Nothing rendered wrong,
 *    which is exactly why nobody saw it.
 *
 * ── What each half asserts, and why that shape ──────────────────────────────
 *
 * For the acronym list the interesting failure is not "a set has the wrong
 * members" but "a READER consults a different subset". So this computes BOTH
 * folds' keep-sets from the JSON and asserts they are equal, and pins the
 * expression each reader uses to derive its set — change either side to a
 * different subset and it goes red. It also refuses a second hard-coded acronym
 * set in `shared/listen-text/normalize.ts` by scanning the source, because that is the shape the
 * band-aid took, and finally folds the same fixtures through BOTH
 * implementations when a Python interpreter can be found.
 *
 * For the band, the two files are compared directly — NOT through the loader,
 * which merges them and would agree with itself — and the loader's new refusal
 * is driven through the real catalog file, the only seam it has.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const LISTEN_TEXT_JS = path.join(REPO, 'dist', 'shared', 'listen-text', 'normalize.js');
const HIGGS_MODELS_JS = path.join(DIST, 'higgs-models.js');
for (const m of [LISTEN_TEXT_JS, HIGGS_MODELS_JS]) {
  if (!fs.existsSync(m)) {
    console.error('Compile first: npx tsc -p tsconfig.electron.json');
    process.exit(1);
  }
}
require(path.join(REPO, 'cli', 'electron-stub.js'));

const ACRONYMS_JSON = path.join(REPO, 'python', 'narrator', 'text', 'caps_acronyms.json');
const PACKER_PY = path.join(REPO, 'python', 'narrator', 'text', 'paragraph_packer.py');
const LISTEN_TEXT_TS = path.join(REPO, 'shared', 'listen-text', 'normalize.ts');
const BANDS_JSON = path.join(REPO, 'electron', 'data', 'higgs-safe-bands.json');
const CATALOG_JSON = path.join(REPO, 'electron', 'data', 'higgs-models.json');
/** The loader reads the DIST copy, which is the only seam it has (see the header). */
const CATALOG_DIST = path.join(DIST, 'data', 'higgs-models.json');

const tests = [];
let passed = 0, failed = 0;
const test = (name, fn) => tests.push({ name, fn });

const read = (p) => fs.readFileSync(p, 'utf-8');
const readJson = (p) => JSON.parse(read(p));

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE ACRONYM LIST: two folds, one keep-set
// ═══════════════════════════════════════════════════════════════════════════

const acronyms = readJson(ACRONYMS_JSON);

test('BOTH FOLDS KEEP THE SAME SET, computed from the one JSON', () => {
  // narrator's side by its own formula (pinned by the next test), Listen's from
  // the compiled module. This is the assertion the drift of 2026-09-06 to
  // 2026-09-13 would have failed on the day it was written.
  const narratorKeeps = [...new Set([...acronyms.lettered, ...acronyms.spokenAsWord])].sort();
  const { CAPS_ACRONYMS } = require(LISTEN_TEXT_JS);
  assert.deepStrictEqual([...CAPS_ACRONYMS].sort(), narratorKeeps,
    'shared/listen-text/normalize.ts and python/narrator/text/paragraph_packer.py keep DIFFERENT sets of '
    + 'caps tokens as printed. They are mirrors of one rule over one file: a token kept by one '
    + 'and title-cased by the other is the same heading read two ways.');
});

test('narrator derives that set as lettered UNION spokenAsWord, and says so', () => {
  // The previous test trusts this formula; here it is, read from the Python.
  // A narrator changed to consult one category fails HERE rather than silently
  // making the comparison above compare Listen to itself.
  const py = read(PACKER_PY);
  assert.ok(
    /return\s+frozenset\(document\['lettered'\]\)\s*\|\s*frozenset\(document\['spokenAsWord'\]\)/
      .test(py),
    "_load_caps_acronyms no longer returns frozenset(lettered) | frozenset(spokenAsWord). If "
    + 'narrator now keeps a different subset, this file\'s comparison is meaningless until the '
    + 'new rule is written here.');
  assert.ok(/CAPS_ACRONYMS\s*=\s*_load_caps_acronyms\(\)/.test(py),
    'paragraph_packer no longer builds CAPS_ACRONYMS from the shared JSON loader');
  assert.ok(/letters\.upper\(\) in CAPS_ACRONYMS/.test(py),
    "_is_acronym no longer tests the shared set");
});

test('Listen derives it from the JSON too, and consults nothing else', () => {
  const ts = read(LISTEN_TEXT_TS);
  assert.ok(/export const CAPS_ACRONYMS[^=]*=\s*new Set\(\[\s*\.\.\.capsAcronymCategory\('lettered'\),\s*\.\.\.capsAcronymCategory\('spokenAsWord'\),\s*\]\)/.test(ts),
    'CAPS_ACRONYMS in normalize.ts is no longer the union of the two JSON categories');
  assert.ok(/return CAPS_ACRONYMS\.has\(upper\) \|\| !VOWEL\.test\(upper\)/.test(ts),
    "foldCapsRun's keep test no longer reads CAPS_ACRONYMS — narrator's `_is_acronym` is "
    + '`in CAPS_ACRONYMS or no vowel`, and the mirror must be the same two clauses');
});

test('NO SECOND HARD-CODED ACRONYM SET in shared/listen-text/normalize.ts', () => {
  // `KEEP_AS_PRINTED = new Set(['WWI', 'WWII'])` sat four lines under the comment
  // that forbids exactly this. The JSON is the place; a private list is how one
  // reader stops moving with the other.
  const ts = read(LISTEN_TEXT_TS);
  const literalSets = [...ts.matchAll(/new Set\(\s*\[\s*(['"])/g)];
  assert.deepStrictEqual(literalSets.map((m) => m.index), [],
    'normalize.ts builds a Set from string literals again. Caps tokens belong in '
    + 'python/narrator/text/caps_acronyms.json, where narrator reads them too — a set written '
    + 'here moves on its own, which is how WWII reached a book as "Wwii".');
});

test('the categories mean what the readers do with them', () => {
  // `lettered` is the half Listen SPELLS, so a token that must never be spelled
  // (WWII -> "W W I I") belongs in `spokenAsWord` whatever its pronunciation.
  // This is the reason the WWI/WWII entries are where they are; see the JSON's
  // _spokenAsWordNote.
  const { LETTERED_ACRONYMS, CAPS_ACRONYMS } = require(LISTEN_TEXT_JS);
  assert.deepStrictEqual([...LETTERED_ACRONYMS].sort(), [...acronyms.lettered].sort(),
    'LETTERED_ACRONYMS drifted from caps_acronyms.json `lettered` — it is the SPELLING half and '
    + 'it must stay exactly that half');
  for (const token of ['WWI', 'WWII']) {
    assert.ok(!LETTERED_ACRONYMS.has(token),
      `${token} is on the lettered list, which is what Listen spells: it would be read "`
      + `${[...token].join(' ')}"`);
    assert.ok(CAPS_ACRONYMS.has(token), `${token} is no longer kept as printed by the caps fold`);
  }
});

test('the fold keeps BOTH categories and still folds the words around them', () => {
  const { foldCapsRun } = require(LISTEN_TEXT_JS);
  // one lettered, one spoken-as-word, one of the 2026-09-13 additions, and
  // ordinary shouted words that must fold.
  assert.strictEqual(foldCapsRun('THE FBI AND NASA OPENED THE WWII FILES'),
    'The FBI And NASA Opened The WWII Files');
  assert.strictEqual(foldCapsRun('COVID CHANGED EVERYTHING'), 'COVID Changed Everything');
  // A vowelless token needs no entry — the rule covers it on both sides.
  assert.strictEqual(foldCapsRun('CNN REPORTED THE NEWS'), 'CNN Reported The News');
  // ...and `IT` really is on the lettered list (information technology), which is
  // why a one-word English shout can survive the fold. Stated, not incidental.
  assert.strictEqual(foldCapsRun('CNN REPORTED IT'), 'CNN Reported IT');
});

test('the two implementations fold the same fixtures identically', () => {
  // The strongest form of the check: not "the sets match" but "the two folds
  // agree on text". Needs a Python that can import narrator; skips BY NAME when
  // there is none, because the set comparison above does not.
  const FIXTURES = [
    'THE FBI AND NASA OPENED THE WWII FILES',
    'DOES GOD HOLD CHILDREN RESPONSIBLE?',
    'COVID CHANGED EVERYTHING',
    'INTRODUCTION.',
    'THE NATO GESTAPO INTERPOL UNESCO FILES',
    '"WHY NOT," she said.',
    'I went home.',
    'CNN REPORTED IT',
    'WWI AND WWII',
  ];
  const py = 'import json,sys\n'
    + 'sys.path.insert(0, ".")\n'
    + 'from narrator.text.paragraph_packer import fold_caps_run\n'
    + `print(json.dumps([fold_caps_run(t) for t in ${JSON.stringify(FIXTURES)}]))\n`;
  const attempts = [
    ['python', ['-c', py]],
    ['python3', ['-c', py]],
    ['conda', ['run', '-n', 'narrator-mlx', 'python', '-c', py]],
  ];
  let out = null;
  for (const [bin, args] of attempts) {
    try {
      out = execFileSync(bin, args, { cwd: path.join(REPO, 'python'), encoding: 'utf8' });
      break;
    } catch { /* try the next interpreter */ }
  }
  if (out === null) {
    console.log('SKIP  narrator could not be imported by any python on this machine; the '
      + 'BEHAVIOURAL half did not run (the set comparison above did)');
    return;
  }
  const fromPython = JSON.parse(out.trim().split('\n').pop());
  const { foldCapsRun } = require(LISTEN_TEXT_JS);
  assert.deepStrictEqual(FIXTURES.map(foldCapsRun), fromPython,
    'narrator and Listen fold the same caps heading differently');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE SAFE BAND: the overlay and the catalog state one band
// ═══════════════════════════════════════════════════════════════════════════
//
// Crucible already carries `scripts/check-voice-bands.py`, which compares ITS
// manifests to this overlay. This is the BookForge-side half that was missing:
// the overlay against the catalog it silently overrode.

/** The band the overlay states for `(voice, arm)`, or null when it states none. */
function overlayBand(entry, arm) {
  const per = entry[arm];
  const min = (per && typeof per.min === 'number') ? per.min : entry.min;
  const max = (per && typeof per.max === 'number') ? per.max : entry.max;
  return (typeof min === 'number' && typeof max === 'number') ? { min, max } : null;
}

test('EVERY voice: the catalog band and the overlay band are the same numbers', () => {
  const bands = readJson(BANDS_JSON);
  const catalog = readJson(CATALOG_JSON);
  let compared = 0;
  for (const model of catalog.models) {
    const entry = bands[model.id];
    if (!entry || typeof entry !== 'object') continue;
    for (const arm of ['served', 'mlx']) {
      const caps = model.backends && model.backends[arm];
      if (!caps) continue;
      const band = overlayBand(entry, arm);
      if (!band) continue;
      for (const [field, want] of [['safeMinChars', band.min], ['safeMaxChars', band.max]]) {
        const declared = caps[field];
        if (declared === undefined || declared === null) continue;
        compared++;
        assert.strictEqual(declared, want,
          `higgs-models.json says ${model.id} (${arm}) ${field} ${declared}; `
          + `higgs-safe-bands.json says ${want}. The overlay wins at runtime, so a disagreement `
          + 'changes NO behaviour and is invisible — which is how thirdreich advertised the '
          + '600-1000 band for four days after it was measured at 500-700 (12.5% and 18.8% '
          + 'early stops in the two rungs that range adds). Correct the catalog pair, or delete '
          + 'it and let the overlay stand alone.');
      }
    }
  }
  assert.ok(compared >= 8,
    `only ${compared} band numbers were compared; the two files no longer overlap, so this `
    + 'keeper is guarding nothing');
});

/**
 * Run `fn` against the loader, with THE REPO's two data files staged into dist
 * and `mutate` applied to the catalog first — then put dist back exactly as it
 * was.
 *
 * Through the real files, because that is the loader's only seam (the same
 * mechanism `tools/test-higgs-engine.js` uses). STAGING THE REPO COPIES is what
 * keeps these two tests about the LOADER: `dist/electron/data` is refreshed by
 * `build:electron`, not by `tsc`, so reading whatever is there would make a
 * checkout with a stale dist fail a band check for a build reason.
 */
function withLoadedCatalog(mutate, fn) {
  const staged = [[CATALOG_JSON, CATALOG_DIST], [BANDS_JSON, path.join(DIST, 'data', 'higgs-safe-bands.json')]];
  const shipped = staged.map(([, dest]) => read(dest));
  const catalog = readJson(CATALOG_JSON);
  mutate(catalog);
  try {
    fs.writeFileSync(CATALOG_DIST, JSON.stringify(catalog, null, 2), 'utf-8');
    fs.writeFileSync(staged[1][1], read(BANDS_JSON), 'utf-8');
    delete require.cache[require.resolve(HIGGS_MODELS_JS)];
    return fn(require(HIGGS_MODELS_JS), catalog);
  } finally {
    staged.forEach(([, dest], i) => fs.writeFileSync(dest, shipped[i], 'utf-8'));
    delete require.cache[require.resolve(HIGGS_MODELS_JS)];
  }
}

test('the loader REFUSES a disagreement instead of overwriting it', () => {
  // A catalog band moved off the overlay's used to be swallowed; now it names
  // both files and both numbers. This is the mutation test for the fix.
  const bands = readJson(BANDS_JSON);
  withLoadedCatalog((catalog) => {
    const target = catalog.models.find((m) => bands[m.id] && m.backends
      && m.backends.served && typeof m.backends.served.safeMaxChars === 'number');
    assert.ok(target, 'no overlay-named voice declares a served safeMaxChars to mutate');
    target.backends.served.safeMaxChars += 100;
  }, (higgs) => {
    assert.throws(() => higgs.listHiggsModels(),
      /declares safeMaxChars \d+ in electron\/data\/higgs-models\.json and \d+ as 'max' in electron\/data\/higgs-safe-bands\.json/,
      'applySafeBands went back to overwriting a disagreeing catalog band in silence');
  });
});

test('the shipped data loads clean, and a voice the overlay does not name keeps its band', () => {
  // The overlay is additive and removable, and that must stay true: refusing a
  // disagreement is not the same as requiring an overlay entry. This also loads
  // the repo's real catalog unmutated, so a shipped disagreement fails here too.
  const bands = readJson(BANDS_JSON);
  withLoadedCatalog(() => {}, (higgs, catalog) => {
    const loaded = higgs.listHiggsModels();
    const unnamed = catalog.models.filter((m) => !bands[m.id]
      && m.backends && m.backends.served
      && typeof m.backends.served.safeMaxChars === 'number');
    for (const m of unnamed) {
      const got = loaded.find((x) => x.id === m.id);
      assert.ok(got, `${m.id} vanished from the catalog`);
      assert.strictEqual(got.backends.served.safeMaxChars, m.backends.served.safeMaxChars,
        `${m.id} is not in the overlay, so its catalog band must travel unchanged`);
    }
  });
});

// ── run ─────────────────────────────────────────────────────────────────────

for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}
console.log(`one-fact-one-owner: ${passed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
