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
const { guardVendoredFoundry } = require('./foundry-guard');

const builderArgs = process.argv.slice(2);
const isMac = process.platform === 'darwin';
const MAX_ATTEMPTS = 3;

// Resolve the electron-builder binary explicitly so this script works when run
// directly (`node packaging/build-dmg.js`) — outside `npm run`, node_modules/.bin
// isn't on PATH, so a bare `electron-builder` is "command not found".
const EB = (() => {
  const local = path.join(__dirname, '..', 'node_modules', '.bin', 'electron-builder');
  return fs.existsSync(local) ? JSON.stringify(local) : 'electron-builder';
})();

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

// Signing + notarization + the APFS relocation they require add a LOT of time
// (codesign over the whole bundle + a multi-minute Apple notary `--wait`). Keep
// the DEFAULT build fast + unsigned + in-place (the old ~3-min behavior); only
// sign and notarize for RELEASE builds (BOOKFORGE_RELEASE=1, set by
// package:mac:signed, which publish:mac:signed runs) so friends get a notarized DMG
// without slowing daily iteration.
const RELEASE = isMac && process.env.BOOKFORGE_RELEASE === '1';
let signArg = '';
if (isMac && !RELEASE) {
  signArg = '-c.mac.identity=null';   // disable signing → fast local iteration
  console.log('[build-dmg] FAST unsigned build (run `npm run package:mac:signed` to sign + notarize).');
}

let notarizeArg = '';
if (RELEASE) {
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
    console.log(`[build-dmg] RELEASE: signing AND notarizing (${credSource} creds, notarytool --wait ~10-15 min).`);
  } else {
    console.log('[build-dmg] RELEASE requested but signing only — NO notarize creds in env or keychain.');
    console.log(`[build-dmg]   store once: security add-generic-password -a <apple-id> -s ${KEYCHAIN_SERVICE} -U -w <app-specific-pw>`);
  }
}

// The build lands in the project's own release/ dir. It used to be relocated to
// an APFS scratch dir under $HOME when Callisto was ExFAT — that filesystem
// shunts extended attributes into AppleDouble `._name` companion files, which
// corrupts the app/framework code seal (codesign "succeeds", the notary rejects
// it). Callisto is APFS as of Aug 2026, so the relocation was removed and the
// signed DMG is built in place.

guardVendoredFoundry('build-dmg');

// SAFETY: electron-builder can rewrite the SOURCE package.json in place (see
// pkg-guard.js — shared with the Windows scripts, which run the same risk).
guardPackageJson('build-dmg');

// The retry loop exists for transient hdiutil hiccups on FAST local builds. On a
// RELEASE build a failure is almost always a notary REJECTION, and retrying means
// a full rebuild + re-sign + re-upload + another multi-minute Apple wait per
// attempt (this burned 3 notary submissions in one night before being capped).
// Fail fast instead so the notary log can be read and the real problem fixed.
const ATTEMPTS = RELEASE ? 1 : MAX_ATTEMPTS;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  detachStaleImages();
  try {
    execSync(`${EB} ${builderArgs.join(' ')} ${versionArg} ${notarizeArg} ${signArg}`.replace(/\s+/g, ' ').trim(), { stdio: 'inherit' });
    process.exit(0);
  } catch {
    if (attempt === ATTEMPTS) {
      console.error(`\n[build-dmg] electron-builder failed after ${ATTEMPTS} attempt(s).`);
      if (RELEASE) {
        console.error('[build-dmg] RELEASE build — no retry. If Apple rejected notarization, read the log:');
        console.error('[build-dmg]   xcrun notarytool log <submission-id> --apple-id <id> --team-id N7V7AT6CZ9 --password <asp>');
      }
      process.exit(1);
    }
    console.warn(`\n[build-dmg] attempt ${attempt}/${MAX_ATTEMPTS} failed (often a transient hdiutil resize) — detaching stale images and retrying…`);
  }
}
