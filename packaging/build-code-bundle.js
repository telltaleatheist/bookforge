#!/usr/bin/env node
/**
 * build-code-bundle.js — package "BookForge proper" as a swappable, signing-free code bundle.
 *
 * Output: release/code-bundles/code-<version>.tar.gz  (+ a code-<version>.json sidecar)
 *
 * The bundle is PURE FIRST-PARTY JS — no node_modules, no native .node. Native + third-party
 * deps resolve from the launcher at runtime (see prototype/launcher-split + manifest-types.ts).
 * That's what keeps a code update tiny and free of any ABI concern.
 *
 * Layout inside the bundle mirrors the current app, so the self-locating code (codeRoot =
 * __dirname/../../) finds everything exactly as it does today:
 *
 *   <bundle-root>/
 *     dist/electron/...        compiled main + preload + prompts + bookshelf-ui + scripts
 *     dist/renderer/browser/   Angular renderer
 *     bookforge-icon.png
 *     version.json             { version }   (read by the launcher / boot-OK marker logic)
 *
 * Prereq: dist/ must be freshly built (npm run build:electron && npm run build:prod).
 *
 * Usage:
 *   node packaging/build-code-bundle.js [--version X.Y.Z] [--min-launcher >=1.0.0]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { computeVersion } = require('./app-version');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'release', 'code-bundles');
const ICON = path.join(ROOT, 'bookforge-icon.png');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fail(msg) {
  console.error(`\n[build-code-bundle] ERROR: ${msg}\n`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  // Default to the auto-derived version (git commit count) so the published bundle
  // matches the .app built by build-dmg.js and never needs a manual package.json
  // bump. An explicit --version still overrides (e.g. to re-cut a specific build).
  const version = arg('--version', computeVersion());
  const minLauncher = arg('--min-launcher', '>=1.0.0');

  // Validate the build is present and complete — no silent partial bundles.
  const requiredEntries = [
    path.join(DIST, 'electron', 'main.js'),
    path.join(DIST, 'electron', 'preload.js'),
    path.join(DIST, 'renderer', 'browser', 'index.html'),
  ];
  for (const entry of requiredEntries) {
    if (!fs.existsSync(entry)) {
      fail(`missing ${path.relative(ROOT, entry)} — run "npm run build:electron && npm run build:prod" first`);
    }
  }
  if (!fs.existsSync(ICON)) fail(`missing ${path.relative(ROOT, ICON)}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Stage the bundle in a clean temp dir so the archive has a stable, node_modules-free layout.
  const stageRoot = path.join(OUT_DIR, `.stage-${version}`);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageRoot, 'dist'), { recursive: true });

  // Copy dist/electron and dist/renderer, dropping any .ts sources / node_modules that
  // might have leaked in. The bundle is JS + assets only.
  const skip = (src) => {
    const base = path.basename(src);
    return base === 'node_modules' || src.endsWith('.ts') || src.endsWith('.map');
  };
  fs.cpSync(path.join(DIST, 'electron'), path.join(stageRoot, 'dist', 'electron'), {
    recursive: true,
    filter: (src) => !skip(src),
  });
  fs.cpSync(path.join(DIST, 'renderer'), path.join(stageRoot, 'dist', 'renderer'), {
    recursive: true,
    filter: (src) => !skip(src),
  });
  fs.copyFileSync(ICON, path.join(stageRoot, 'bookforge-icon.png'));
  fs.writeFileSync(
    path.join(stageRoot, 'version.json'),
    JSON.stringify({ version, builtBy: 'build-code-bundle' }, null, 2)
  );

  // Guard: no node_modules and no native binaries should have made it in.
  const leaked = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') leaked.push(path.relative(stageRoot, p));
        else walk(p);
      } else if (e.name.endsWith('.node')) {
        leaked.push(path.relative(stageRoot, p));
      }
    }
  })(stageRoot);
  if (leaked.length) {
    fail(`bundle is not pure-JS — found:\n  ${leaked.join('\n  ')}`);
  }

  // Archive (tar.gz — created with the `tar` CLI present on macOS/Windows/Linux; the launcher's
  // downloadAndExtract() already handles .tar.gz). `-C` keeps paths bundle-root-relative.
  // On Windows, pin to the OS-bundled bsdtar (%SystemRoot%\System32\tar.exe): a GNU tar earlier
  // on PATH (e.g. Git for Windows' usr\bin\tar) treats the "C:\…" archive path as a remote "C"
  // host and aborts ("Cannot connect to C:"). bsdtar handles drive-letter paths natively.
  const tarBin =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  const outFile = path.join(OUT_DIR, `code-${version}.tar.gz`);
  fs.rmSync(outFile, { force: true });
  execFileSync(tarBin, ['-czf', outFile, '-C', stageRoot, '.'], { stdio: 'inherit' });
  fs.rmSync(stageRoot, { recursive: true, force: true });

  const bytes = fs.statSync(outFile).size;
  const hash = sha256(outFile);

  // Sidecar consumed by the publish step to patch manifest.json's `code` entry. URL is filled in
  // at publish time (depends on where the artifact is uploaded — GitHub Releases).
  const sidecar = {
    version,
    file: path.basename(outFile),
    sha256: hash,
    bytes,
    minLauncher,
    url: null,
  };
  fs.writeFileSync(path.join(OUT_DIR, `code-${version}.json`), JSON.stringify(sidecar, null, 2));

  console.log('\n[build-code-bundle] done');
  console.log(`  file:        ${path.relative(ROOT, outFile)}`);
  console.log(`  version:     ${version}`);
  console.log(`  bytes:       ${bytes.toLocaleString()}`);
  console.log(`  sha256:      ${hash}`);
  console.log(`  minLauncher: ${minLauncher}`);
  console.log('\n  manifest.code (url filled at publish):');
  console.log(
    JSON.stringify(
      { version, url: '<github-release-url>', sha256: hash, bytes, minLauncher },
      null,
      2
    )
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')
  );
}

main();
