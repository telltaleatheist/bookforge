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
 * 2. A FINE-TUNE'S BAND, PACE AND CAP. They lived in electron/data/higgs-safe-bands.json, in both
 *    arms of electron/data/higgs-models.json, and on the server. Since 2026-09-28 (Owen: "single
 *    source of truth. that source should be where the models are served") the server is the only
 *    owner, and this keeper refuses the BookForge copies coming back.
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
    // Indented, because this suite is still running: only the behavioural half
    // stood down. A column-zero `SKIP:` is the runner's word for a whole suite
    // that verified nothing (tools/keeper-skip.js).
    console.log('  SKIP  narrator could not be imported by any python on this machine; the '
      + 'BEHAVIOURAL half did not run (the set comparison above did)');
    return;
  }
  const fromPython = JSON.parse(out.trim().split('\n').pop());
  const { foldCapsRun } = require(LISTEN_TEXT_JS);
  assert.deepStrictEqual(FIXTURES.map(foldCapsRun), fromPython,
    'narrator and Listen fold the same caps heading differently');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A FINE-TUNE'S BAND, PACE AND CAP: one owner, the server that serves it
// ═══════════════════════════════════════════════════════════════════════════
//
// Owen, 2026-09-28: "single source of truth. that source should be where the models are served."
// The band lived in five places; three redeploys in one day updated the overlay and not the
// catalog, the loader's consistency check threw, and the Narrate picker listed no voices. The
// voice's truth is its pinned revision's crucible-voice.toml, stated per server by GET /v1/voices
// (electron/crucible/voice-band.ts). These checks keep the BookForge copies from coming back.

/** What a fine-tune may no longer declare here, per arm. */
const SERVER_OWNED_ARM_FIELDS = ['maxChars', 'maxCharsSource', 'safeMinChars', 'safeMaxChars', 'targetChars'];

test('NO BookForge copy of a fine-tune\'s band, pace or cap', () => {
  assert.ok(!fs.existsSync(BANDS_JSON),
    'electron/data/higgs-safe-bands.json is back. A voice\'s band is its crucible-voice.toml\'s, '
    + 'stated by GET /v1/voices; a second copy here is how the picker went empty on 2026-09-28.');
  const catalog = readJson(CATALOG_JSON);
  const fineTunes = catalog.models.filter((m) => m.kind === 'checkpoint');
  assert.ok(fineTunes.length > 0, 'the catalog has no fine-tunes, so this guards nothing');
  for (const m of fineTunes) {
    assert.ok(!('pace' in m), m.id + ' declares a pace in higgs-models.json; the pace is the server\'s');
    for (const arm of ['served', 'mlx']) {
      const caps = (m.backends && m.backends[arm]) || {};
      for (const f of SERVER_OWNED_ARM_FIELDS) {
        assert.ok(!(f in caps), m.id + ' (' + arm + ') declares ' + f + ' in higgs-models.json; '
          + 'a fine-tune\'s cap and band are the server\'s, on GET /v1/voices');
      }
    }
  }
});

/**
 * Run `fn` against the loader with THE REPO's catalog staged into dist (the loader's only
 * seam), then put dist back exactly as it was.
 */
function withLoadedCatalog(fn) {
  const shipped = read(CATALOG_DIST);
  try {
    fs.writeFileSync(CATALOG_DIST, read(CATALOG_JSON), 'utf-8');
    delete require.cache[require.resolve(HIGGS_MODELS_JS)];
    return fn(require(HIGGS_MODELS_JS));
  } finally {
    fs.writeFileSync(CATALOG_DIST, shipped, 'utf-8');
    delete require.cache[require.resolve(HIGGS_MODELS_JS)];
  }
}

test('the shipped catalog loads with no overlay, and every fine-tune is still listed', () => {
  const catalog = readJson(CATALOG_JSON);
  withLoadedCatalog((higgs) => {
    const loaded = higgs.listHiggsModels().map((m) => m.id);
    for (const m of catalog.models.filter((x) => x.kind === 'checkpoint')) {
      assert.ok(loaded.includes(m.id), m.id + ' vanished from the catalog');
    }
  });
});

test('a fine-tune\'s voice document with no venue band is REFUSED by name, never packed to local numbers', () => {
  const catalog = readJson(CATALOG_JSON);
  const fineTune = catalog.models.find((m) => m.kind === 'checkpoint');
  withLoadedCatalog((higgs) => {
    const model = higgs.listHiggsModels().find((m) => m.id === fineTune.id);
    const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ofoo-'));
    assert.throws(
      () => higgs.higgsVoicesDocument(model, { arm: 'wsl', userDataDir, translatePath: (x) => x }),
      /no Crucible server has stated its cap, band and pace/,
      'a fine-tune document was written without the venue\'s numbers');
    // And with the venue's band, the document carries THOSE numbers, whole.
    const venueBand = { server: 'pc', voice: fineTune.id, maxChars: 800, ceilingChars: 700, floorChars: 400,
      targetChars: null, paceCharsPerSec: 16.14, maxCharsPerSec: 20.98, minCharsPerSec: 12.42 };
    const doc = higgs.higgsVoicesDocument(model, { arm: 'wsl', userDataDir, translatePath: (x) => x, venueBand });
    const entry = doc[fineTune.id];
    assert.deepStrictEqual(
      [entry.maxChars, entry.safeMinChars, entry.safeMaxChars, entry.paceCharsPerSec, entry.maxCharsPerSec, entry.minCharsPerSec],
      [800, 400, 700, 16.14, 20.98, 12.42],
      'the voice document is not the venue\'s numbers');
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
