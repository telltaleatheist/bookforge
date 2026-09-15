#!/usr/bin/env node
/**
 * ONE LISTEN TEXT PATH, BUNDLED TWICE — byte for byte.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-text-one-source.js
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Phase 16 (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0) made the browser extension a
 * Crucible client of its own. It no longer sends a paragraph to BookForge and
 * gets rows back; it normalizes, segments and packs the text ITSELF. So the
 * same three functions now run in two programs compiled by two different
 * toolchains — tsc into `dist/shared/listen-text/`, esbuild into
 * `extension/dist/offscreen.js` — out of one directory.
 *
 * The failure mode is not a crash. It is an extension that splits a paragraph
 * one character differently from the app: a partly-cached block is resumed BY
 * INDEX into the row list, so one row's audio ends up under another row's text,
 * and the listener hears a sentence twice or not at all. Nothing throws, no
 * test goes red, and the audio is fine everywhere else.
 *
 * So this compares the FUNCTION BODIES the two builds actually contain. Not
 * "both import from shared/" — a paste into `offscreen.ts` would still import
 * from shared/ and still be the second copy that wins.
 *
 * ── And the one number the shared file could not import ─────────────────────
 *
 * `CRUCIBLE_STREAM_IN_FLIGHT` is the local narrator pool's `STREAM_RAMP_WIDTH`
 * — the narrowest width measured to beat speech rate — and the shared file
 * cannot import it, because `electron/orpheus-worker-pool.ts` is the narrator
 * pool and would drag Electron into a browser bundle. Section 3 compares them
 * rather than trusting the comment that says they are the same.
 */
'use strict';
const fs = require('fs');
const path = require('path');
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
if (!fs.existsSync(path.join(EXT, 'node_modules'))) {
  console.log('SKIP: extension/node_modules is missing — run `npm install --prefix extension`');
  return;
}

// ── The extension bundle ────────────────────────────────────────────────────
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
const compiled = ['segment.js', 'normalize.js', 'chunks.js']
  .map((f) => fs.readFileSync(path.join(DIST_SHARED, f), 'utf-8'))
  .join('\n');

/**
 * Every `function <name>(…) { … }` in `source`, brace-matched, as source text.
 *
 * Brace matching rather than a regex, because these bodies contain `}` inside
 * strings and regular expressions and a lazy match stops at the first one.
 * String and regex literals are skipped so a brace inside one cannot unbalance
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

/** Line endings and nothing else: tsc and esbuild disagree about \r\n. */
const norm = (s) => s.replace(/\r\n/g, '\n');

// ── 1. The bodies are identical, and there is exactly one of each ───────────
//
// `speakableListenText` is the whole normalizer's entry point; `splitForTts`
// and `capSegment` are the segmentation; `packListenChunks` is the row packer.
// Between them they decide every byte of every row, and a resumed block indexes
// into what they produce.

const PINNED = [
  'speakableListenText',
  'splitForTts',
  'capSegment',
  'splitIntoSentences',
  'packListenChunks',
  'foldCapsRun',
  'stripUnspokenGlyphs',
];

for (const name of PINNED) {
  check(`${name} is one implementation, byte for byte in both builds`, () => {
    const mine = bodiesOf(compiled, name);
    const theirs = bodiesOf(bundle, name);
    if (mine.length !== 1) {
      throw new Error(`dist/shared/listen-text holds ${mine.length} definitions of ${name}; `
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
        `${name} differs between dist/shared/listen-text and the extension bundle. The two `
        + 'programs would split a paragraph differently, and a resumed block is spliced BY '
        + 'INDEX into that split — so one row\'s audio would play under another row\'s text.\n'
        + `  app:       ${norm(mine[0]).slice(0, 160)}\n`
        + `  extension: ${norm(theirs[0]).slice(0, 160)}`);
    }
  });
}

// ── 2. The extension reaches the shared directory, and copies nothing ───────

check('the extension imports the Listen text path from shared/, not from a copy', () => {
  const src = fs.readFileSync(path.join(EXT, 'src', 'offscreen.ts'), 'utf-8');
  if (!/from '\.\.\/\.\.\/shared\/listen-text\//.test(src)) {
    throw new Error('extension/src/offscreen.ts no longer imports shared/listen-text/');
  }
  if (!/from '\.\.\/\.\.\/shared\/listen-client\//.test(src)) {
    throw new Error('extension/src/offscreen.ts no longer imports shared/listen-client/');
  }
});

check('no extension source declares its own segmenter or packer', () => {
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

// ── 3. The read-ahead depth the shared file could not import ────────────────

check('CRUCIBLE_STREAM_IN_FLIGHT is still the local pool\'s STREAM_RAMP_WIDTH', () => {
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

console.log(failures === 0 ? '\nOne source, two bundles, no drift.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
