#!/usr/bin/env node
/**
 * Run electron-builder with a detach-and-retry around the macOS DMG step.
 *
 * On macOS, `hdiutil resize` intermittently fails with
 *   "Resource temporarily unavailable (35)"
 * — typically right after the heavy stage:packaging:seed I/O, or when a previous
 * BookForge / temp disk image is still attached (e.g. you double-clicked the last
 * DMG, or a prior failed run left its temp `0.dmg` mounted). A plain retry after
 * detaching the stale images succeeds, so wrap the builder here instead of letting
 * `package:mac` die on a transient hdiutil hiccup.
 *
 * Usage: node packaging/build-dmg.js --mac        (args pass through to electron-builder)
 */
const { execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const builderArgs = process.argv.slice(2);
const isMac = process.platform === 'darwin';
const MAX_ATTEMPTS = 3;

const RELEASE_DIR = path.resolve(__dirname, '..', 'release');
const CURRENT_VERSION = require('../package.json').version;

/**
 * Remove release artifacts (dmg, blockmap, AppleDouble ._ sidecars) from versions OTHER than the
 * one we're about to build. electron-builder names each dmg BookForge-<version>-arch.dmg, so a bump
 * leaves the previous version's dmg sitting in release/ — and double-clicking the wrong (stale) one
 * is an easy way to "install" an old build over a new one. Keep only the current version so the
 * newest dmg is the only BookForge dmg in the folder.
 */
function cleanStaleReleases() {
  let entries;
  try { entries = fs.readdirSync(RELEASE_DIR); } catch { return; } // no release/ yet — nothing to clean
  const removed = [];
  for (const name of entries) {
    // Match BookForge-<x.y.z>-... and the macOS ._ AppleDouble sidecar of the same.
    const m = name.match(/^\._?BookForge-(\d+\.\d+\.\d+)-/) || name.match(/^BookForge-(\d+\.\d+\.\d+)-/);
    if (!m || m[1] === CURRENT_VERSION) continue;
    try {
      fs.rmSync(path.join(RELEASE_DIR, name), { recursive: true, force: true });
      removed.push(name);
    } catch { /* best-effort */ }
  }
  if (removed.length) {
    console.log(`[build-dmg] cleaned ${removed.length} stale release artifact(s) (keeping ${CURRENT_VERSION}):`);
    for (const r of removed) console.log(`  - ${r}`);
  }
}

/** Detach any attached BookForge/temp build disk images so hdiutil has room. */
function detachStaleImages() {
  if (!isMac) return;
  let info = '';
  try { info = execSync('hdiutil info', { encoding: 'utf8' }); } catch { return; }
  let imagePath = '';
  for (const line of info.split('\n')) {
    const pm = line.match(/^image-path\s*:\s*(.*)$/);
    if (pm) { imagePath = pm[1]; continue; }
    const dm = line.match(/^(\/dev\/disk\d+)\b/);
    // Only our build artifacts — never the Time Machine sparsebundle etc.
    if (dm && /(BookForgeApp|t-[A-Za-z0-9]+\/0\.dmg)/.test(imagePath)) {
      try { execFileSync('hdiutil', ['detach', dm[1], '-force'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  }
  // Eject any mounted "BookForge …" volume (a previously-opened DMG).
  try {
    for (const v of execSync('ls /Volumes', { encoding: 'utf8' }).split('\n')) {
      if (/^BookForge /.test(v.trim())) {
        try { execFileSync('hdiutil', ['detach', `/Volumes/${v.trim()}`, '-force'], { stdio: 'ignore' }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

cleanStaleReleases();

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  detachStaleImages();
  try {
    execSync(`electron-builder ${builderArgs.join(' ')}`, { stdio: 'inherit' });
    process.exit(0);
  } catch {
    if (attempt === MAX_ATTEMPTS) {
      console.error(`\n[build-dmg] electron-builder failed after ${MAX_ATTEMPTS} attempts.`);
      process.exit(1);
    }
    console.warn(`\n[build-dmg] attempt ${attempt}/${MAX_ATTEMPTS} failed (often a transient hdiutil resize) — detaching stale images and retrying…`);
  }
}
