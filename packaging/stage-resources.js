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
// --seed: barebones build — bundle ONLY the default voice (ScarlettJohansson)
// + stanza, not the full 26 GB models/. Every other voice downloads on demand.
const seedModels = args.includes('--seed') && !includeModels;
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

// Excluded anywhere in the tree. __bark = BARK engine voice presets (BookForge
// is XTTS/Orpheus — never BARK); __sessions = voice-conversion scratch. Neither
// belongs in a fresh install.
const EXCLUDE_ANY = new Set(['__pycache__', '.DS_Store', '__bark', '__sessions']);

// Seed build: voice-clip languages to ship (ISO 639-3 dir names). English holds
// all curated + library voices; the rest cover common language-learning pairs.
// Override with BOOKFORGE_SEED_VOICE_LANGS="eng,deu,spa,…".
const SEED_VOICE_LANGS = new Set(
  (process.env.BOOKFORGE_SEED_VOICE_LANGS ||
    'eng,deu,spa,fra,ita,por,nld,rus,jpn,kor,zho,ara,hin,pol,tur,ukr')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

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

// Recursively remove a directory, robust against ExFAT (the build volume): Node's
// rimraf intermittently throws ENOTEMPTY rmdir'ing dirs with thousands of small
// files. Retry, then fall back to the OS rm which handles ExFAT reliably.
function robustRmDir(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    return;
  } catch (err) {
    console.warn(`[stage-resources] rmSync failed (${err.code}); trying OS rm: ${dir}`);
  }
  try {
    if (process.platform === 'win32') {
      execSync(`rmdir /s /q "${dir}"`, { stdio: 'ignore', shell: 'cmd.exe' });
    } else {
      execSync(`rm -rf "${dir}"`, { stdio: 'ignore' });
    }
    if (!fs.existsSync(dir)) return;
  } catch { /* fall through to rename-aside */ }
  // Last resort (ExFAT + accented Unicode dir names that unlink can't match):
  // rename the dir out of the way so the build proceeds. The orphan is gitignored
  // build junk; a later run sweeps leftover .e2a-stuck-* best-effort.
  const aside = `${dir}.stuck-${process.pid}`;
  fs.renameSync(dir, aside);
  console.warn(`[stage-resources] could not delete; renamed aside: ${aside}`);
}

console.log(`[stage-resources] e2a source:  ${e2aSource}`);
console.log(`[stage-resources] env tarball: ${tarballSource}`);
console.log(`[stage-resources] models:      ${includeModels ? 'INCLUDED (offline build)' : seedModels ? 'SEED (default voice + stanza only)' : 'excluded'}`);

fs.mkdirSync(resourcesDir, { recursive: true });

// Env tarball
const tarballDest = path.join(resourcesDir, 'e2a-env.tar.gz');
fs.rmSync(tarballDest, { force: true });
fs.copyFileSync(tarballSource, tarballDest, CLONE);
console.log(`[stage-resources] staged ${path.relative(repoRoot, tarballDest)} (${(fs.statSync(tarballDest).size / 1e9).toFixed(2)} GB)`);

// e2a snapshot — always rebuilt from scratch so deletions in the source
// propagate (a stale snapshot must never ship).
const snapshotDest = path.join(resourcesDir, 'e2a');
robustRmDir(snapshotDest);
fs.cpSync(e2aSource, snapshotDest, {
  recursive: true,
  mode: CLONE,
  filter: (src) => {
    const rel = path.relative(e2aBase, stripNamespacePrefix(src));
    if (!rel) return true;
    const parts = rel.split(path.sep);
    if (EXCLUDE_TOP.has(parts[0])) return false;
    if (parts.some((p) => EXCLUDE_ANY.has(p))) return false;
    // Never ship symlinks: cpSync turns e2a's relative launcher symlinks
    // (uninstall.sh → uninstall.command) into ABSOLUTE links into the dev tree,
    // which then crash the first-run runtime copy (EINVAL) and leak dev paths.
    try { if (fs.lstatSync(src).isSymbolicLink()) return false; } catch { /* ignore */ }
    // Seed build: ship only common-language voice clips. e2a carries 1,100+
    // language dirs — bloat, and some have accented names that ExFAT (the build
    // volume) can't reliably delete on the next rebuild. English holds every
    // curated + library voice; LL target voices are generated by conversion.
    if (seedModels && parts[0] === 'voices') {
      // Drop voice paths with non-ASCII names: a few exotic library voices
      // (e.g. "EugenioMataracı") have accented names that ExFAT can't delete on
      // the next rebuild (Unicode normalization mismatch).
      if (/[^\x00-\x7f]/.test(rel)) return false;
      if (parts.length >= 2) {
        const seg = parts[1];
        const isLangDir = !seg.includes('.'); // dirs have no extension; keep root files
        if (isLangDir && !SEED_VOICE_LANGS.has(seg)) return false;
      }
    }
    return true;
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
stamp += includeModels ? '+models' : seedModels ? '+seed' : '';
fs.writeFileSync(
  path.join(snapshotDest, '.bookforge-e2a-snapshot.json'),
  JSON.stringify({ stamp, stagedFrom: e2aSource, models: includeModels, seed: seedModels }, null, 2)
);

// ── Seed: bundle only the default voice + stanza (the barebones build) ─────────
//
// The bulk copy above already excluded models/ (EXCLUDE_TOP) but kept voices/
// (the small reference clips every downloadable voice needs). Here we add back a
// curated slice of models/: the ScarlettJohansson checkpoint and stanza. Every
// other voice/model downloads on demand into the app's data folder at runtime.
if (seedModels) {
  // Build the voice checkpoint in a PERSISTENT staging cache (idempotent — a
  // second build is instant), then clone-on-write it into the snapshot. The
  // helper writes the exact HF-cache layout the XTTS engine reads.
  const seedPyCmd = process.env.BOOKFORGE_SEED_PYTHON || 'conda run -n ebook2audiobook python';
  const seedCache = path.join(repoRoot, 'packaging', '.seed-cache');
  const ttsDest = path.join(snapshotDest, 'models', 'tts');
  fs.mkdirSync(seedCache, { recursive: true });
  fs.mkdirSync(ttsDest, { recursive: true });

  console.log(`[stage-resources] seeding default voice (ScarlettJohansson) via: ${seedPyCmd}`);
  execSync(
    `${seedPyCmd} -m bookforge_ext.download_model --engine xtts --preset ScarlettJohansson --cache-dir "${seedCache}"`,
    { cwd: e2aSource, stdio: 'inherit' }
  );
  for (const entry of fs.readdirSync(seedCache)) {
    // verbatimSymlinks: keep the HF cache's relative blob symlinks intact (else
    // they'd dereference into full copies).
    fs.cpSync(path.join(seedCache, entry), path.join(ttsDest, entry), {
      recursive: true, verbatimSymlinks: true, mode: CLONE,
    });
  }

  // Stanza sentence-segmentation models for the seed languages. Defaults to the
  // common language-learning set (English, German, Spanish) so those work
  // offline out of the box; override with BOOKFORGE_SEED_STANZA="en,de,fr,…".
  // NOTE: stanza loads with REUSE_RESOURCES (no auto-download), so a language not
  // bundled here will NOT silently fetch — it must be added to this list and be
  // present in the source models/stanza dir at stage time.
  const seedLangs = (process.env.BOOKFORGE_SEED_STANZA || 'en,de,es')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const stanzaSrc = path.join(e2aSource, 'models', 'stanza');
  const stanzaDest = path.join(snapshotDest, 'models', 'stanza');
  if (fs.existsSync(stanzaSrc)) {
    fs.mkdirSync(stanzaDest, { recursive: true });
    const resJson = path.join(stanzaSrc, 'resources.json');
    if (fs.existsSync(resJson)) fs.copyFileSync(resJson, path.join(stanzaDest, 'resources.json'), CLONE);
    for (const lang of seedLangs) {
      const s = path.join(stanzaSrc, lang);
      if (fs.existsSync(s)) {
        fs.cpSync(s, path.join(stanzaDest, lang), { recursive: true, mode: CLONE });
        console.log(`[stage-resources] seeded stanza/${lang}`);
      } else {
        console.warn(`[stage-resources] stanza/${lang} not found in source — skipped`);
      }
    }
  }
}

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
