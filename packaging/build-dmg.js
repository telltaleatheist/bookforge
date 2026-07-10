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
const { computeVersion } = require('./app-version');
const { guardPackageJson } = require('./pkg-guard');

const builderArgs = process.argv.slice(2);
const isMac = process.platform === 'darwin';
const MAX_ATTEMPTS = 3;

const RELEASE_DIR = path.resolve(__dirname, '..', 'release');
// Auto-derived (git commit count) so no manual package.json bump is needed — the
// .app is built at this version via electron-builder's extraMetadata.version, and
// the dmg is named for it.
const CURRENT_VERSION = computeVersion();

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

// Override the .app version with the auto-derived one WITHOUT mutating package.json
// (electron-builder bakes extraMetadata into the packaged app.asar's package.json,
// so app.getVersion() returns this at runtime).
const versionArg = `-c.extraMetadata.version=${CURRENT_VERSION}`;
console.log(`[build-dmg] building at auto-version ${CURRENT_VERSION} (no manual bump needed)`);

// Signing is always on (electron-builder auto-discovers the Developer ID
// Application cert in the keychain — team N7V7AT6CZ9). Notarization is GATED on
// credentials so credential-less local iteration stays fast (a signed-but-not-
// notarized DMG still runs on this Mac; notarytool adds a few minutes and needs
// Apple creds). Set APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD (an app-specific
// password from appleid.apple.com) to notarize for public distribution.
const APPLE_TEAM_ID = 'N7V7AT6CZ9';
const KEYCHAIN_SERVICE = 'BOOKFORGE_NOTARIZE_ASP';
// Pull the app-specific password (+ its Apple ID) from the macOS login keychain
// so notarization needs no env vars — stored once via:
//   security add-generic-password -a <apple-id> -s BOOKFORGE_NOTARIZE_ASP -U -w <pw>
function keychainNotarizeCreds() {
  try {
    const pw = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8' }).trim();
    if (!pw) return null;
    let acct = '';
    try {
      const meta = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE],
        { encoding: 'utf8' });
      const m = meta.match(/"acct"<blob>="([^"]*)"/);
      if (m) acct = m[1];
    } catch { /* account is optional — env/default can supply it */ }
    return { pw, acct };
  } catch { return null; }  // no keychain item (or locked) — fall through to signing-only
}

let notarizeArg = '';
if (isMac) {
  let appleId = process.env.APPLE_ID || '';
  let asp = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD || '';
  let credSource = 'env';
  if (!asp) {
    const kc = keychainNotarizeCreds();
    if (kc) { asp = kc.pw; appleId = appleId || kc.acct; credSource = 'keychain'; }
  }
  if (asp && appleId) {
    // electron-builder's notarize reads these from the child env.
    process.env.APPLE_ID = appleId;
    process.env.APPLE_APP_SPECIFIC_PASSWORD = asp;
    process.env.APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || APPLE_TEAM_ID;
    notarizeArg = `-c.mac.notarize.teamId=${APPLE_TEAM_ID}`;
    console.log(`[build-dmg] signing AND notarizing (${credSource} creds, notarytool ~a few min).`);
  } else {
    console.log('[build-dmg] signing only — NOT notarizing (no creds in env or keychain).');
    console.log(`[build-dmg]   store once: security add-generic-password -a <apple-id> -s ${KEYCHAIN_SERVICE} -U -w <app-specific-pw>`);
  }
}

// SAFETY: electron-builder can rewrite the SOURCE package.json in place (see
// pkg-guard.js — shared with the Windows scripts, which run the same risk).
guardPackageJson('build-dmg');

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  detachStaleImages();
  try {
    execSync(`electron-builder ${builderArgs.join(' ')} ${versionArg} ${notarizeArg}`.trim(), { stdio: 'inherit' });
    process.exit(0);
  } catch {
    if (attempt === MAX_ATTEMPTS) {
      console.error(`\n[build-dmg] electron-builder failed after ${MAX_ATTEMPTS} attempts.`);
      process.exit(1);
    }
    console.warn(`\n[build-dmg] attempt ${attempt}/${MAX_ATTEMPTS} failed (often a transient hdiutil resize) — detaching stale images and retrying…`);
  }
}
