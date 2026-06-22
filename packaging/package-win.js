#!/usr/bin/env node
/**
 * One-command Windows packaging → NSIS installer.
 *
 * Wraps the whole win build so `npm run package:win-x64` just works: it resolves
 * the two environment inputs the staging step needs (the ebook2audiobook
 * checkout and the python used to seed the default voice), then runs the build
 * pipeline. Produces the NSIS installer in release/ ("BookForge Setup <ver>.exe")
 * using the `build.win.target: nsis` config in package.json.
 *
 * Env overrides (auto-detected when unset):
 *   EBOOK2AUDIOBOOK_PATH   the e2a checkout (default: sibling ../ebook2audiobook)
 *   BOOKFORGE_SEED_PYTHON  python that seeds the default voice
 *                          (default: <e2a>/python_env/python.exe, else conda run)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[package-win] ${msg}\n`);
  process.exit(1);
}

// ── Resolve the e2a checkout ────────────────────────────────────────────────
function resolveE2aPath() {
  const candidates = [
    process.env.EBOOK2AUDIOBOOK_PATH,
    path.resolve(repoRoot, '..', 'ebook2audiobook'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'app.py')) && fs.existsSync(path.join(c, 'lib'))) {
      return c;
    }
  }
  fail(
    `Could not find an ebook2audiobook checkout (looked for app.py + lib in:\n` +
    candidates.map((c) => `  - ${c}`).join('\n') +
    `\nSet EBOOK2AUDIOBOOK_PATH to your checkout and re-run.`
  );
}

// ── Resolve the python that seeds the default voice ─────────────────────────
function resolveSeedPython(e2aPath) {
  if (process.env.BOOKFORGE_SEED_PYTHON) return process.env.BOOKFORGE_SEED_PYTHON;

  const bundled = path.join(e2aPath, 'python_env', 'python.exe');
  if (fs.existsSync(bundled)) {
    // Quote only if the path contains spaces — stage-resources uses this value
    // verbatim as a command prefix (`<python> -m bookforge_ext...`).
    return bundled.includes(' ') ? `"${bundled}"` : bundled;
  }
  // Fall back to the stage script's own default (conda run -n ebook2audiobook).
  return null;
}

const e2aPath = resolveE2aPath();
const seedPython = resolveSeedPython(e2aPath);

const env = {
  ...process.env,
  EBOOK2AUDIOBOOK_PATH: e2aPath,
  ...(seedPython ? { BOOKFORGE_SEED_PYTHON: seedPython } : {}),
};

console.log('[package-win] EBOOK2AUDIOBOOK_PATH =', e2aPath);
console.log('[package-win] BOOKFORGE_SEED_PYTHON =', seedPython || '(default: conda run -n ebook2audiobook python)');

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
    execSync(cmd, { cwd: repoRoot, stdio: 'inherit', env });
  } catch (err) {
    fail(`Step failed: ${cmd}\n${err.message}`);
  }
}

console.log('\n[package-win] Done — NSIS installer in release/ ("BookForge Setup *.exe").');
