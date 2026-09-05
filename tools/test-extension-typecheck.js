#!/usr/bin/env node
/**
 * THE EXTENSION TYPECHECKS.
 *
 *   node tools/test-extension-typecheck.js
 *
 * ── Why this needs a keeper of its own ──────────────────────────────────────
 *
 * `extension/build.mjs` is esbuild-only. esbuild ERASES types without checking
 * them, so a type that is used and never imported produces a green build and a
 * working bundle — and nothing in `tools/run-keepers.js`, `ng build` or either
 * `tsc -p` project covers `extension/src`.
 *
 * That is not hypothetical: `1ebcaac9` shipped `EngineInfo` used in
 * `popup.ts` and `offscreen.ts` and imported in neither. Every gate was green.
 * It is the extension-side twin of the "`ng build` won't catch it" hazard the
 * Angular keepers exist for.
 *
 * ── It REQUIRES extension/node_modules, and does not pretend otherwise ──────
 *
 * `extension/` has its own small install (esbuild + @types/chrome, 7 packages),
 * separate from the root's. Without it `tsc` cannot resolve the `chrome` types
 * named in `compilerOptions.types` and STOPS: it emits TS2688 and checks no source
 * file at all.
 *
 * MEASURED, not assumed — and the first draft of this keeper got it wrong. It
 * tolerated TS2688 on the theory that every file was still checked, so it passed
 * with `EngineInfo`'s import deliberately deleted. A keeper that green-lights the
 * exact bug it was written for is worse than no keeper, so the tolerance is gone:
 * absent deps is a loud failure naming the one command that fixes it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'extension');

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

console.log('extension/ typecheck');

if (!fs.existsSync(path.join(EXT, 'tsconfig.json'))) {
  console.log('  FAIL  extension/tsconfig.json is missing');
  process.exitCode = 1;
  return;
}

const depsInstalled = fs.existsSync(path.join(EXT, 'node_modules'));

check('extension/node_modules is installed', () => {
  if (!depsInstalled) {
    throw new Error(
      'extension/ has its own install (esbuild + @types/chrome) and it is missing, '
      + 'so `tsc` stops at the unresolvable chrome type library and checks NO source '
      + 'file. Run: npm install --prefix extension');
  }
});

if (depsInstalled) {
  const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '--noEmit'],
    { cwd: EXT, encoding: 'utf-8', timeout: 300000, shell: process.platform === 'win32' });

  const output = `${run.stdout || ''}${run.stderr || ''}`;
  // Diagnostics are `path(line,col): error TSxxxx: …`; continuation lines are
  // indented. Only the headline lines are counted.
  const errors = output.split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /error TS\d+:/.test(l) && !/^\s/.test(l));

  check('no type errors in extension/src', () => {
    if (errors.length > 0) {
      throw new Error(`${errors.length} type error(s):\n  ${errors.slice(0, 12).join('\n  ')}`);
    }
  });
}

console.log(failures === 0 ? '\nExtension typecheck clean.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
