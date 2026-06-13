#!/usr/bin/env node
/**
 * Stage packaging resources for electron-builder.
 *
 * Populates resources/ with the two bundled-runtime pieces the packaged app
 * ships (both consumed by electron/e2a-env-bootstrap.ts at first run):
 *
 *   resources/e2a-env.tar.gz   conda-pack'd Python env for this platform,
 *                              from packaging/artifacts/e2a-env-<platform>.tar.gz
 *   resources/e2a/             snapshot of the e2a checkout: all code + assets
 *                              + voices; models only with --models (the
 *                              offline-first build). Working dirs (tmp/,
 *                              ebooks/, models without --models) are excluded —
 *                              the bootstrap recreates them in the writable
 *                              runtime copy.
 *
 * Copies use APFS/ReFS clone-on-write where available, so staging is fast and
 * costs no extra disk on the same volume.
 *
 * Usage:
 *   node packaging/stage-resources.js [--e2a <path>] [--models]
 *
 * e2a source resolution: --e2a > EBOOK2AUDIOBOOK_PATH > ~/Projects/ebook2audiobook-latest
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(repoRoot, 'resources');

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const includeModels = args.includes('--models');
const e2aFlagIdx = args.indexOf('--e2a');
const e2aSource =
  (e2aFlagIdx !== -1 && args[e2aFlagIdx + 1]) ||
  process.env.EBOOK2AUDIOBOOK_PATH ||
  path.join(os.homedir(), 'Projects', 'ebook2audiobook-latest');

// ── Platform → tarball name ──────────────────────────────────────────────────

function platformTag() {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'macos-x64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  throw new Error(`Unsupported build platform: ${platform}-${arch}`);
}

const tarballSource = path.join(repoRoot, 'packaging', 'artifacts', `e2a-env-${platformTag()}.tar.gz`);

// ── Validate inputs (fail loud, no silent fallbacks) ─────────────────────────

if (!fs.existsSync(tarballSource)) {
  console.error(
    `[stage-resources] Missing env tarball: ${tarballSource}\n` +
    `Pack it first:\n` +
    `  conda run -n base conda-pack -n ebook2audiobook -o ${tarballSource} --n-threads -1`
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(e2aSource, 'app.py')) || !fs.existsSync(path.join(e2aSource, 'lib'))) {
  console.error(
    `[stage-resources] "${e2aSource}" does not look like an ebook2audiobook checkout ` +
    `(no app.py / lib). Pass --e2a <path> or set EBOOK2AUDIOBOOK_PATH.`
  );
  process.exit(1);
}

// ── Snapshot exclusions ──────────────────────────────────────────────────────

// Top-level entries never shipped: user/session data, build leftovers, repo
// plumbing. models is conditional on --models; voices always ships (XTTS
// reference wavs live there).
const EXCLUDE_TOP = new Set([
  'tmp', 'ebooks', 'audiobooks',
  '.git', '.github', '.dockerignore', 'Dockerfile', 'docker-compose.yml',
  'podman-compose.yml', 'dockerfiles', 'Notebooks',
  'ebook2audiobook.egg-info', 'python_env', 'orpheus_env',
]);
if (!includeModels) EXCLUDE_TOP.add('models');

// Excluded anywhere in the tree.
const EXCLUDE_ANY = new Set(['__pycache__', '.DS_Store']);

// On Windows, fs.cpSync invokes the `filter` callback with `src` paths carrying
// the \\?\ extended-length (namespaced) prefix (it resolves through
// path.toNamespacedPath internally), while e2aSource has no such prefix. Without
// normalizing, path.relative() returns the whole namespaced path instead of a
// clean "models"/"tmp" segment, so parts[0] never matches EXCLUDE_TOP and EVERY
// exclusion silently misses — shipping the entire working tree (models/, env
// dirs, tmp/, .git/ — ~48 GB). Strip the prefix from both sides before compare.
function stripNamespacePrefix(p) {
  return p.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
}
const e2aBase = stripNamespacePrefix(path.resolve(e2aSource));

// ── Stage ────────────────────────────────────────────────────────────────────

const CLONE = fs.constants.COPYFILE_FICLONE;

console.log(`[stage-resources] e2a source:  ${e2aSource}`);
console.log(`[stage-resources] env tarball: ${tarballSource}`);
console.log(`[stage-resources] models:      ${includeModels ? 'INCLUDED (offline build)' : 'excluded'}`);

fs.mkdirSync(resourcesDir, { recursive: true });

// Env tarball
const tarballDest = path.join(resourcesDir, 'e2a-env.tar.gz');
fs.rmSync(tarballDest, { force: true });
fs.copyFileSync(tarballSource, tarballDest, CLONE);
console.log(`[stage-resources] staged ${path.relative(repoRoot, tarballDest)} (${(fs.statSync(tarballDest).size / 1e9).toFixed(2)} GB)`);

// e2a snapshot — always rebuilt from scratch so deletions in the source
// propagate (a stale snapshot must never ship).
const snapshotDest = path.join(resourcesDir, 'e2a');
fs.rmSync(snapshotDest, { recursive: true, force: true });
fs.cpSync(e2aSource, snapshotDest, {
  recursive: true,
  mode: CLONE,
  filter: (src) => {
    const rel = path.relative(e2aBase, stripNamespacePrefix(src));
    if (!rel) return true;
    const parts = rel.split(path.sep);
    if (EXCLUDE_TOP.has(parts[0])) return false;
    return !parts.some((p) => EXCLUDE_ANY.has(p));
  },
});

// Stamp: identifies the snapshot so the app knows when to refresh its runtime
// copy. Git rev + dirty flag when available, mtime otherwise.
let stamp;
try {
  const rev = execSync('git rev-parse --short HEAD', { cwd: e2aSource, encoding: 'utf8' }).trim();
  const dirty = execSync('git status --porcelain', { cwd: e2aSource, encoding: 'utf8' }).trim() ? '-dirty' : '';
  stamp = `${rev}${dirty}`;
} catch {
  stamp = `mtime-${Math.floor(fs.statSync(e2aSource).mtimeMs)}`;
}
stamp += includeModels ? '+models' : '';
fs.writeFileSync(
  path.join(snapshotDest, '.bookforge-e2a-snapshot.json'),
  JSON.stringify({ stamp, stagedFrom: e2aSource, models: includeModels }, null, 2)
);

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}
console.log(`[stage-resources] staged resources/e2a (${(dirSize(snapshotDest) / 1e6).toFixed(0)} MB), stamp: ${stamp}`);
console.log('[stage-resources] done');
