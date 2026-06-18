#!/usr/bin/env node
/**
 * publish-release.js — turn a built code bundle into a published release.
 *
 * It updates `releases.json` (the authoritative launcher/code/components data that the catalog
 * indexer merges into manifest.json) from the sidecar emitted by build-code-bundle.js, then
 * prints the exact commands to (1) upload the artifact to GitHub Releases and (2) deploy
 * releases.json + regenerate manifest.json on the server.
 *
 * DRY-RUN by default — it writes releases.json locally and prints the publish plan, but does NOT
 * upload or deploy (both are outward-facing). Pass --publish to actually run the GitHub upload
 * (requires the `gh` CLI). Server deploy is always printed (it needs your Triton ssh access).
 *
 * Usage (code bundle — "BookForge proper"):
 *   node packaging/publish-release.js [--version X.Y.Z] [--repo owner/name] [--tag code] [--publish]
 *   Prereq: node packaging/build-code-bundle.js --version X.Y.Z   (produces the sidecar + tar.gz)
 *
 * Usage (managed binary — ffmpeg, yt-dlp, … OUR server-hosted, watched binaries):
 *   node packaging/publish-release.js --component ffmpeg --comp-version 7.0.2 \
 *        --comp-file path/to/ffmpeg-darwin-arm64.tar.gz --platform darwin-arm64 \
 *        [--requires-app ">=0.1.0"] [--publish]
 *   Run once per platform; each call merges into that component's platforms map (others preserved).
 *   Re-running with a new file/version is how you "replace a binary on the server" — it recomputes
 *   the sha256 and bumps the manifest, so clients detect and pull the update.
 *
 * NOT for HuggingFace models (voices/whisper/stanza) — those are upstream, never our releases.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUNDLES_DIR = path.join(ROOT, 'release', 'code-bundles');
// Local copy of releases.json, versioned in the repo. Deploy this to the indexer's
// MIRROR_DOCROOT/releases.json on the server (the indexer reads it to build manifest.json).
const RELEASES_PATH = path.join(ROOT, 'tools', 'catalog-indexer', 'releases.json');

// Where the indexer expects releases.json + writes manifest.json (Triton docroot).
const SERVER_DOCROOT = '/home/owenmorgan/web/owenmorgan.com/public_html/bookforge';

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

function fail(msg) {
  console.error(`\n[publish] ERROR: ${msg}\n`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadReleases(pkgVersion) {
  let releases = { launcher: { version: pkgVersion, platforms: {} }, code: {}, components: [] };
  if (fs.existsSync(RELEASES_PATH)) {
    try {
      releases = JSON.parse(fs.readFileSync(RELEASES_PATH, 'utf8'));
    } catch {
      fail(`existing ${path.relative(ROOT, RELEASES_PATH)} is not valid JSON`);
    }
  }
  if (!Array.isArray(releases.components)) releases.components = [];
  return releases;
}

function saveReleases(releases) {
  fs.mkdirSync(path.dirname(RELEASES_PATH), { recursive: true });
  fs.writeFileSync(RELEASES_PATH, JSON.stringify(releases, null, 2) + '\n');
}

function printDeploy() {
  console.log('\n[publish] deploy on the server (Triton) to refresh manifest.json:');
  console.log(`  scp ${path.relative(ROOT, RELEASES_PATH)} triton:${SERVER_DOCROOT}/releases.json`);
  // The cron indexer lives in ~/bookforge-catalog (run.sh entrypoint). If build_catalog.py itself
  // changed, also: scp tools/catalog-indexer/build_catalog.py triton:~/bookforge-catalog/
  console.log(`  ssh triton 'cd ~/bookforge-catalog && CATALOG_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ) python3 build_catalog.py'`);
}

// Publish (or replace) one of OUR managed binaries (ffmpeg, yt-dlp, …).
function publishComponent() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const id = arg('--component', '');
  const compVersion = arg('--comp-version', '');
  const file = arg('--comp-file', '');
  const platform = arg('--platform', ''); // e.g. darwin-arm64; empty = platform-agnostic
  const requiresApp = arg('--requires-app', '');
  const repo = arg('--repo', process.env.BOOKFORGE_GH_REPO || 'telltaleatheist/bookforge');
  const tag = arg('--tag', 'components');
  const publish = has('--publish');

  if (!id || !compVersion || !file) {
    fail('component publish needs --component <id> --comp-version <X> --comp-file <archive>');
  }
  if (!fs.existsSync(file)) fail(`--comp-file not found: ${file}`);

  const base = path.basename(file);
  const artifact = {
    url: `https://github.com/${repo}/releases/download/${tag}/${base}`,
    sha256: sha256(file),
    bytes: fs.statSync(file).size,
  };

  const releases = loadReleases(pkg.version);
  let entry = releases.components.find((c) => c.id === id);
  if (!entry) {
    entry = { id, version: compVersion };
    releases.components.push(entry);
  }
  entry.version = compVersion;
  if (requiresApp) entry.requiresApp = requiresApp;
  if (platform) {
    // Per-platform binary: merge into platforms map (preserve other platforms).
    if (entry.artifact) delete entry.artifact;
    entry.platforms = entry.platforms || {};
    entry.platforms[platform] = artifact;
  } else {
    if (entry.platforms) delete entry.platforms;
    entry.artifact = artifact;
  }
  saveReleases(releases);

  console.log(`[publish] ${path.relative(ROOT, RELEASES_PATH)} → component "${id}" ${compVersion}${platform ? ` [${platform}]` : ''}`);
  console.log(`          url:    ${artifact.url}`);
  console.log(`          sha256: ${artifact.sha256}`);

  const ghArgs = ['release', 'upload', tag, file, '--clobber', '--repo', repo];
  if (publish) {
    console.log(`\n[publish] uploading binary to GitHub release "${tag}"…`);
    try {
      execFileSync('gh', ghArgs, { stdio: 'inherit' });
    } catch (err) {
      fail(`gh upload failed (${err.message}). Create the release once with:\n  gh release create ${tag} --repo ${repo} --title "Managed binaries" --notes "ffmpeg, yt-dlp, etc."`);
    }
    console.log('[publish] binary uploaded.');
  } else {
    console.log('\n[publish] DRY-RUN — would upload binary:');
    console.log(`  gh ${ghArgs.join(' ')}`);
    console.log(`  (one-time, if the release tag doesn't exist:)`);
    console.log(`  gh release create ${tag} --repo ${repo} --title "Managed binaries" --notes "ffmpeg, yt-dlp, etc."`);
  }
  printDeploy();
  if (!publish) console.log('\n[publish] dry-run complete. Re-run with --publish to upload to GitHub.\n');
}

// Publish (or replace) the one-time starter library (a finished sample project).
function publishStarter() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const name = arg('--starter-name', 'the-mysterious-stranger');
  const repo = arg('--repo', process.env.BOOKFORGE_GH_REPO || 'telltaleatheist/bookforge');
  const tag = arg('--tag', 'assets'); // single GitHub release that holds all hosted assets
  const publish = has('--publish');

  const sidecarPath = path.join(ROOT, 'release', 'starter-library', `starter-${name}.json`);
  if (!fs.existsSync(sidecarPath)) {
    fail(`no sidecar at ${path.relative(ROOT, sidecarPath)} — run "node packaging/build-starter-library.js --name ${name}" first`);
  }
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const tarPath = path.join(ROOT, 'release', 'starter-library', sidecar.file);
  const url = `https://github.com/${repo}/releases/download/${tag}/${sidecar.file}`;

  const releases = loadReleases(pkg.version);
  releases.starter = {
    slug: sidecar.slug,
    name: sidecar.name,
    url,
    sha256: sidecar.sha256,
    bytes: sidecar.bytes,
  };
  saveReleases(releases);
  console.log(`[publish] updated ${path.relative(ROOT, RELEASES_PATH)} → starter "${sidecar.slug}"`);
  console.log(`          url:    ${url}`);
  console.log(`          sha256: ${sidecar.sha256}`);
  console.log(`          bytes:  ${sidecar.bytes.toLocaleString()}`);

  const ghArgs = ['release', 'upload', tag, tarPath, '--clobber', '--repo', repo];
  if (publish && fs.existsSync(tarPath)) {
    console.log(`\n[publish] uploading starter to GitHub release "${tag}"…`);
    try {
      execFileSync('gh', ghArgs, { stdio: 'inherit' });
    } catch (err) {
      fail(`gh upload failed (${err.message}). Create the release once with:\n  gh release create ${tag} --repo ${repo} --title "Starter library" --notes "Finished sample project"`);
    }
    console.log('[publish] starter uploaded.');
  } else {
    console.log('\n[publish] DRY-RUN — would upload starter (or it was uploaded by hand):');
    console.log(`  gh ${ghArgs.join(' ')}`);
    if (!fs.existsSync(tarPath)) console.log(`  (local tarball ${path.relative(ROOT, tarPath)} not present — release.json updated from sidecar only)`);
  }
  printDeploy();
  if (!publish) console.log('\n[publish] dry-run complete. Re-run with --publish to upload to GitHub.\n');
}

function main() {
  if (has('--component')) return publishComponent();
  if (has('--starter')) return publishStarter();

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = arg('--version', pkg.version);
  const repo = arg('--repo', process.env.BOOKFORGE_GH_REPO || 'telltaleatheist/bookforge');
  const tag = arg('--tag', 'code'); // a rolling GitHub release that holds code-bundle assets
  const publish = has('--publish');

  const sidecarPath = path.join(BUNDLES_DIR, `code-${version}.json`);
  if (!fs.existsSync(sidecarPath)) {
    fail(`no sidecar at ${path.relative(ROOT, sidecarPath)} — run "node packaging/build-code-bundle.js --version ${version}" first`);
  }
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  const tarPath = path.join(BUNDLES_DIR, sidecar.file);
  if (!fs.existsSync(tarPath)) fail(`artifact missing: ${path.relative(ROOT, tarPath)}`);

  const url = `https://github.com/${repo}/releases/download/${tag}/${sidecar.file}`;

  // Merge into releases.json, PRESERVING launcher + components (only `code` changes here).
  const releases = loadReleases(pkg.version);
  releases.code = {
    version: sidecar.version,
    url,
    sha256: sidecar.sha256,
    bytes: sidecar.bytes,
    minLauncher: sidecar.minLauncher,
  };
  saveReleases(releases);
  console.log(`[publish] updated ${path.relative(ROOT, RELEASES_PATH)} → code ${version}`);
  console.log(`          url:    ${url}`);
  console.log(`          sha256: ${sidecar.sha256}`);

  // ── Step 1: upload artifact to GitHub Releases ──
  const ghArgs = ['release', 'upload', tag, tarPath, '--clobber', '--repo', repo];
  if (publish) {
    console.log(`\n[publish] uploading to GitHub release "${tag}"…`);
    try {
      execFileSync('gh', ghArgs, { stdio: 'inherit' });
    } catch (err) {
      fail(
        `gh upload failed (${err.message}). Is the gh CLI installed + authed, and does ` +
          `release "${tag}" exist? Create it once with:\n  gh release create ${tag} --repo ${repo} --title "Code bundles" --notes "Rolling code-bundle assets"`
      );
    }
    console.log('[publish] artifact uploaded.');
  } else {
    console.log('\n[publish] DRY-RUN — would upload artifact:');
    console.log(`  gh ${ghArgs.join(' ')}`);
    console.log(`  (one-time, if the release tag doesn't exist yet:)`);
    console.log(`  gh release create ${tag} --repo ${repo} --title "Code bundles" --notes "Rolling code-bundle assets"`);
  }

  // ── Step 2: deploy releases.json + regenerate manifest.json on the server (always printed) ──
  printDeploy();
  console.log('\n  (the indexer merges releases.json + upstream voices/languages → manifest.json,');
  console.log('   served at https://owenmorgan.com/bookforge/manifest.json)\n');

  if (!publish) console.log('[publish] dry-run complete. Re-run with --publish to upload to GitHub.\n');
}

main();
