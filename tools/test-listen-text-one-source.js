#!/usr/bin/env node
/**
 * ONE LISTEN TEXT PATH, BUNDLED TWICE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-text-one-source.js
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0) made the browser extension a
 * Crucible client of its own. It no longer sends a paragraph to BookForge and
 * gets rows back; it normalizes, segments and packs the text ITSELF. So the
 * same three stages now run in two programs compiled by two different
 * toolchains — tsc into `dist/shared/listen-text/`, esbuild into
 * `extension/dist/offscreen.js` — out of one directory.
 *
 * The failure mode is not a crash. It is an extension that splits a paragraph
 * one character differently from the app: a partly-cached block is resumed BY
 * INDEX into the row list, so one row's audio ends up under another row's text,
 * and the listener hears a sentence twice or not at all. Nothing throws, no
 * test goes red, and the audio is fine everywhere else.
 *
 * ── WHY THIS IS NOT A BYTE COMPARISON AGAINST THE tsc BUILD ─────────────────
 *
 * It was, for one draft, and the plan asked for exactly that: "a keeper pins
 * the two bundles' function bodies byte-equal". **It cannot be done, and the
 * first version of this file was a guard that could never go green.** MEASURED
 * 2026-09-14, comparing `dist/shared/listen-text/*.js` with
 * `extension/dist/offscreen.js`, every difference cosmetic and none semantic:
 *
 *   - tsc keeps comments; esbuild strips them.
 *   - tsc emits CommonJS, so a cross-module call is
 *     `(0, tts_punctuation_js_1.canonicalizePunctuationText)(collapsed)` and an
 *     own-module constant is `exports.CAPS_ACRONYMS`; esbuild inlines both to
 *     the bare name.
 *   - tsc writes `'single'` quotes, esbuild `"double"`.
 *   - esbuild folds `'a' + 'b'` into one literal and re-wraps lines.
 *   - esbuild lowers `/\p{L}/u` to `new RegExp("\\p{L}", "u")` for the target.
 *
 * AND ONE MORE, MEASURED 2026-09-14 and NOT in that list because it is not
 * cosmetic in the same way: **a LOCAL binding is renamed when some other module
 * in the shipped graph declares the same name at the top level.** esbuild
 * suffixes the collision — `foldCapsRun`'s own `let run = 0` became `let run2 =
 * 0` in `offscreen.js` the day `extension/src/clips.ts` was added with a
 * top-level `function run(store, request)`. Reproduced exactly by bundling
 * `shared/listen-text/index.ts` beside a stub that declares `function run()`.
 *
 * So the premise below — "both are esbuild over the same source at the same
 * target, so they cannot legitimately differ" — is FALSE for a local
 * identifier, and this check will fail on a name collision that changes no
 * behaviour at all (§2 stays green, which is the tell). It is left asserting
 * byte-equality anyway, because the cheap answer is to rename the colliding
 * TOP-LEVEL symbol in the extension's own source, and because licensing
 * `X` ≡ `X<digits>` here would also license a genuine paste that happened to
 * be numbered. If that trade stops being worth it, the fix is a token-wise
 * comparison that allows a shipped `X<digits>` only where the harness has `X`
 * at the same position — not a looser string compare.
 *
 * Normalising all of that away would leave a comparison so lossy it proved
 * nothing. So the claim is split into the two halves that ARE true, and
 * together they are stronger than the one that was not:
 *
 *   §1  The harness IS the extension's code. A second esbuild bundle of
 *       `shared/listen-text/index.ts`, at the extension's own target, matches
 *       the real `offscreen.js` BYTE FOR BYTE per function — both sides are
 *       esbuild, so the only licensed difference is the one indent level the
 *       IIFE wrapper adds, and that is removed by dedenting rather than by
 *       ignoring whitespace.
 *   §2  The extension's code and the app's code COMPUTE THE SAME THING. A
 *       corpus goes through both builds' whole three-stage pipeline —
 *       normalize, split, pack — and every row must match. This is what the
 *       byte comparison was a proxy for, and it is the thing that actually
 *       fails when a paragraph splits two ways.
 *
 * §3-§5 keep the textual guards that a behaviour test cannot make: exactly one
 * definition of each function in the shipped bundle, no copy in the
 * extension's own source, and the one number the shared file could not import.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'extension');
const DIST_SHARED = path.join(REPO, 'dist', 'shared', 'listen-text');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

console.log('one listen-text path, bundled twice');

// ── Preconditions, named rather than guessed at ─────────────────────────────

if (!fs.existsSync(DIST_SHARED)) {
  console.log('SKIP: dist/shared/listen-text is not built — run `npx tsc -p tsconfig.electron.json`');
  return;
}
if (!fs.existsSync(path.join(EXT, 'node_modules', 'esbuild'))) {
  console.log('SKIP: extension/node_modules is missing — run `npm install --prefix extension`');
  return;
}

/** The extension's own bundler settings, so both builds below are ONE build. */
const ESBUILD_TARGET = 'chrome116';

// ── The shipped bundle ──────────────────────────────────────────────────────
//
// Built here rather than read off disk: `extension/dist` is gitignored and may
// be stale or absent, and a keeper that reads yesterday's bundle proves nothing
// about today's source. `--dist` so no local token is baked into it.

const build = spawnSync(process.execPath, [path.join(EXT, 'build.mjs'), '--dist'],
  { cwd: EXT, encoding: 'utf-8', timeout: 300000 });
if (build.status !== 0) {
  console.log('  FAIL  the extension bundles\n        '
    + `${build.stdout || ''}${build.stderr || ''}`.trim().split('\n').join('\n        '));
  console.log('\n1 check(s) FAILED.');
  process.exitCode = 1;
  return;
}
console.log('  ok    the extension bundles');
const bundle = fs.readFileSync(path.join(EXT, 'dist', 'offscreen.js'), 'utf-8');

// ── The harness: the same source, the same bundler, loadable from node ──────

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-listen-text-'));
const harnessFile = path.join(scratch, 'harness.cjs');
const harnessBuild = spawnSync(process.execPath, ['-e', `
const esbuild = require(${JSON.stringify(path.join(EXT, 'node_modules', 'esbuild'))});
esbuild.buildSync({
  entryPoints: [${JSON.stringify(path.join(REPO, 'shared', 'listen-text', 'index.ts'))}],
  bundle: true,
  format: 'cjs',
  target: ${JSON.stringify(ESBUILD_TARGET)},
  outfile: ${JSON.stringify(harnessFile)},
  logLevel: 'warning',
});
`], { cwd: EXT, encoding: 'utf-8', timeout: 300000 });
if (harnessBuild.status !== 0) {
  console.log('  FAIL  the shared listen-text bundles for node\n        '
    + `${harnessBuild.stdout || ''}${harnessBuild.stderr || ''}`.trim().split('\n').join('\n        '));
  console.log('\n1 check(s) FAILED.');
  process.exitCode = 1;
  return;
}
const harness = fs.readFileSync(harnessFile, 'utf-8');

/**
 * Every `function <name>(…) { … }` in `source`, brace-matched, as source text.
 *
 * Brace matching rather than a regex, because these bodies contain `}` inside
 * strings and regular expressions and a lazy match stops at the first one.
 * String and comment spans are skipped so a brace inside one cannot unbalance
 * the count.
 */
function bodiesOf(source, name) {
  const found = [];
  const head = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
  let m;
  while ((m = head.exec(source)) !== null) {
    const open = source.indexOf('{', head.lastIndex);
    if (open < 0) continue;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (c === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i) + 1; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    found.push(source.slice(open, i + 1));
  }
  return found;
}

/**
 * The one licensed difference between two esbuild outputs of the same source:
 * the IIFE wrapper indents its whole body one level deeper than the CJS one.
 *
 * Removed by taking off the CONSTANT base indent — the amount the closing brace
 * carries — rather than by trimming each line, so RELATIVE indentation survives
 * and a multi-line template literal's leading spaces are still compared.
 */
function dedent(body) {
  const lines = body.split('\n');
  let base = Infinity;
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    base = Math.min(base, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(base) || base === 0) return body;
  return lines.map((line, i) => (i === 0 ? line : line.slice(base))).join('\n');
}

/** Line endings, which the two writers disagree about on Windows. */
const norm = (s) => dedent(s.replace(/\r\n/g, '\n'));

/**
 * The functions that decide every byte of every row. `speakableListenText` is
 * the normalizer's entry point, `splitForTts` / `capSegment` /
 * `splitIntoSentences` are the segmentation, `packListenChunks` is the packer,
 * and a resumed block indexes into what they produce between them.
 */
const PINNED = [
  'speakableListenText',
  'expandBibleReferences',
  'splitForTts',
  'capSegment',
  'splitIntoSentences',
  'normalizeAbbreviations',
  'packListenChunks',
  'foldCapsRun',
  'stripUnspokenGlyphs',
];

// ═══════════════════════════════════════════════════════════════════════════
// 1. The harness IS the extension's code
// ═══════════════════════════════════════════════════════════════════════════

for (const name of PINNED) {
  check(`${name}: the harness is the shipped bundle's own code, byte for byte`, () => {
    const mine = bodiesOf(harness, name);
    const theirs = bodiesOf(bundle, name);
    if (mine.length !== 1) {
      throw new Error(`the harness bundle holds ${mine.length} definitions of ${name}; `
        + 'there must be exactly one');
    }
    if (theirs.length === 0) {
      throw new Error(`the extension bundle contains no ${name}. Either the offscreen document `
        + 'stopped using shared/listen-text — in which case it has grown its own copy of the '
        + 'Listen text path — or this pin names a function that was renamed.');
    }
    if (theirs.length > 1) {
      throw new Error(`the extension bundle contains ${theirs.length} definitions of ${name}. `
        + 'A second one is a paste, and a paste is how the two splits drift.');
    }
    if (norm(mine[0]) !== norm(theirs[0])) {
      throw new Error(
        `${name} differs between the harness and the shipped bundle. Both are esbuild over the `
        + 'same source at the same target, so they cannot legitimately differ — section 2 below '
        + 'is therefore testing code the extension does not ship.\n'
        + `  harness: ${norm(mine[0]).slice(0, 160)}\n`
        + `  shipped: ${norm(theirs[0]).slice(0, 160)}`);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Both builds compute the same rows
// ═══════════════════════════════════════════════════════════════════════════

const ext = require(harnessFile);
const app = {
  ...require(path.join(DIST_SHARED, 'segment.js')),
  ...require(path.join(DIST_SHARED, 'normalize.js')),
  ...require(path.join(DIST_SHARED, 'chunks.js')),
};

/**
 * Text shaped like the pages this actually reads, chosen one rule per row:
 * the number rules, the printed ellipsis and curly quotes, a caps heading, the
 * acronyms the fold must keep, web decoration and a soft hyphen, money and
 * percents and page ranges, a sentence long enough to force `capSegment`, a
 * one-word heading, a tail scrap short enough to hit the starvation floor, the
 * two empty cases — and a CITATION-DENSE row, because a scripture book name is
 * now expanded before the rules run (bible-books.ts) and an expansion that
 * happened in one bundle and not the other would change where the sentence
 * splits, which is exactly the silent defect this file exists for.
 */
const CORPUS = [
  'Project 2025 was published in 2023. It runs to 920 pages.',
  '"You mean . . . ?" "Precisely, Commander: 5:30 p.m., 12 March 1914."',
  'DOES GOD HOLD CHILDREN RESPONSIBLE — the FBI, NASA and the U.S. say no.',
  '• A bullet ★ and an arrow → and an emoji \u{1F642} walk into a bar­.',
  'He paid $1,234.56 (about 23%) on the 3rd of April, 1st edition, pp. 44-51.',
  `${'A'.repeat(40)}, ${'B'.repeat(400)}; ${'C'.repeat(300)}. Short one.`,
  'INTRODUCTION.',
  'WWII and WWI and TPUSA and ADHD reached 1,000,000 readers in the 1980s.',
  'One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. Ok.',
  'He read 1 Pet. 3:7, then Rom. 5:17, Ps. 63:6, Col. 3:19-4:1 and II Cor. 5:17. '
  + 'My ex. called; Rev. King and Col. Sanders and Phil. and Dan. and Tim. were late, '
  + 'and Ch. 3:7 of the manual says Widescreen 16:9 at 5:30-6:00.',
  '',
  '   ',
];

/** A narrow band, a wide one, and one below the opener — the packer's three arms. */
const BANDS = [
  { openerChars: 300, minChars: null, maxChars: 800 },
  { openerChars: 300, minChars: 400, maxChars: 1100 },
  { openerChars: 300, minChars: null, maxChars: 250 },
];

check('the normalizer produces identical text in both builds', () => {
  for (const text of CORPUS) {
    assert.strictEqual(ext.speakableListenText(text), app.speakableListenText(text),
      `speakableListenText differs on ${JSON.stringify(text.slice(0, 60))}`);
  }
});

check('the whole pipeline produces identical ROWS in both builds', () => {
  for (const text of CORPUS) {
    for (const band of BANDS) {
      const mine = app.packListenChunks(
        app.splitForTts(app.speakableListenText(text), 'en', band.maxChars), band);
      const theirs = ext.packListenChunks(
        ext.splitForTts(ext.speakableListenText(text), 'en', band.maxChars), band);
      assert.deepStrictEqual(theirs, mine,
        'the app and the extension would split this block differently, and a resumed block is '
        + 'spliced BY INDEX into that split — so one row\'s audio would play under another '
        + `row's text.\n  text: ${JSON.stringify(text.slice(0, 60))}\n  band: ${band.maxChars}`);
    }
  }
});

check('the acronym keep-set is the same set in both builds', () => {
  assert.deepStrictEqual([...ext.CAPS_ACRONYMS].sort(), [...app.CAPS_ACRONYMS].sort());
  assert.deepStrictEqual([...ext.LETTERED_ACRONYMS].sort(), [...app.LETTERED_ACRONYMS].sort());
});

check('both builds refuse a voice that declares no chunk length, by name', () => {
  // The refusal is load-bearing: the extension packs to the SERVER's maxChars,
  // and a voice with none must stop the read rather than be packed to a number
  // from somewhere else. Both builds have to refuse, or the extension would
  // read a block the app would not.
  for (const [where, build] of [['app', app], ['extension', ext]]) {
    assert.throws(() => build.listenBandFromCaps('deathstalker', {}),
      /declares no chunk length/, `the ${where} build does not refuse a capless voice`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The extension reaches the shared directory, and copies nothing
// ═══════════════════════════════════════════════════════════════════════════

check('the extension imports the Listen text path from shared/, not from a copy', () => {
  const src = fs.readFileSync(path.join(EXT, 'src', 'offscreen.ts'), 'utf-8');
  if (!/from '\.\.\/\.\.\/shared\/listen-text\//.test(src)) {
    throw new Error('extension/src/offscreen.ts no longer imports shared/listen-text/');
  }
  if (!/from '\.\.\/\.\.\/shared\/listen-client\//.test(src)) {
    throw new Error('extension/src/offscreen.ts no longer imports shared/listen-client/');
  }
});

check('no extension source declares its own segmenter, normalizer or packer', () => {
  const offenders = [];
  for (const file of fs.readdirSync(path.join(EXT, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(EXT, 'src', file), 'utf-8');
    for (const name of PINNED) {
      if (new RegExp(`function\\s+${name}\\s*\\(`).test(src)) offenders.push(`${file}:${name}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`the extension declares its own: ${offenders.join(', ')}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The read-ahead depth the shared file could not import
// ═══════════════════════════════════════════════════════════════════════════

check("CRUCIBLE_STREAM_IN_FLIGHT is still the local pool's STREAM_RAMP_WIDTH", () => {
  const { CRUCIBLE_STREAM_IN_FLIGHT } =
    require(path.join(REPO, 'dist', 'shared', 'listen-client', 'crucible-rows.js'));
  const poolSrc = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  const m = poolSrc.match(/export const STREAM_RAMP_WIDTH\s*=\s*(\d+)/);
  if (!m) {
    throw new Error('STREAM_RAMP_WIDTH has moved or been renamed in electron/orpheus-worker-pool.ts');
  }
  if (CRUCIBLE_STREAM_IN_FLIGHT !== Number(m[1])) {
    throw new Error(
      `the Crucible read-ahead depth is ${CRUCIBLE_STREAM_IN_FLIGHT} and the local pool's ramp is `
      + `${m[1]}. They are one measured number — the narrowest width that beats speech rate — and `
      + 'the shared file restates it because it cannot import the narrator pool into a browser '
      + 'bundle. If the measurement changed, change both; if it did not, this is drift.');
  }
});

fs.rmSync(scratch, { recursive: true, force: true });

console.log(failures === 0 ? '\nOne source, two bundles, no drift.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
