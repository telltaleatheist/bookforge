#!/usr/bin/env node
/**
 * One-command Windows packaging → NSIS installer.
 *
 * Wraps the whole win build so `npm run package:win-x64` just works. Produces the
 * NSIS installer in release/ ("BookForge Setup <ver>.exe") using the
 * `build.win.target: nsis` config in package.json.
 *
 * ── PHASE 6: IT NO LONGER RESOLVES AN ebook2audiobook CHECKOUT ──────────────
 *
 * It used to do two things before running the pipeline, and both were about a
 * payload that is gone (see packaging/stage-resources.js):
 *
 *   EBOOK2AUDIOBOOK_PATH   found a checkout by looking for `app.py` + `lib`, and
 *                          HARD-FAILED the build when it could not. Nothing is
 *                          staged from a checkout any more, so this made every
 *                          Windows build depend on a directory the installer
 *                          never carried.
 *   BOOKFORGE_SEED_PYTHON  derived `<e2a>/python_env/python.exe` to seed the
 *                          default XTTS voice. XTTS left on 2026-09-05 and the
 *                          seeding step went with it.
 *
 * The tools Python environment a packaged BookForge runs is downloaded from a
 * GitHub release on first run and unpacked into `<userData>/runtime/tools-env`
 * (electron/tools-env-bootstrap.ts). The installer ships no Python at all.
 */

const { execSync } = require('child_process');
const path = require('path');
const { guardPackageJson } = require('./pkg-guard');
const { guardVendoredFoundry } = require('./foundry-guard');

const repoRoot = path.resolve(__dirname, '..');

// electron-builder (the last pipeline step) can rewrite the source package.json
// in place (see pkg-guard.js).
guardVendoredFoundry('package-win');
guardPackageJson('package-win');

function fail(msg) {
  console.error(`\n[package-win] ${msg}\n`);
  process.exit(1);
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
// The final step builds the NSIS installer directly (build.win.target = nsis),
// replacing the former --dir + Inno Setup steps.
const steps = [
  'npm run download:mupdf',
  'npm run download:llama',
  'npm run stage:packaging:seed',
  'npm run build:electron',
  'npm run build:prod',
  // Auto-version (git commit count) via extraMetadata — no manual package.json bump.
  `npx electron-builder --win --x64 -c.extraMetadata.version=${require('./app-version').computeVersion()}`,
];

for (const cmd of steps) {
  console.log(`\n[package-win] $ ${cmd}`);
  try {
    execSync(cmd, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  } catch (err) {
    fail(`Step failed: ${cmd}\n${err.message}`);
  }
}

console.log('\n[package-win] Done — NSIS installer in release/ ("BookForge Setup *.exe").');
