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
const os = require('node:os');
const { computeVersion } = require('./app-version');
const { guardPackageJson } = require('./pkg-guard');

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
// sign and notarize for RELEASE builds (BOOKFORGE_RELEASE=1, set by publish:mac)
// so friends get a notarized DMG without slowing daily iteration.
const RELEASE = isMac && process.env.BOOKFORGE_RELEASE === '1';
let signArg = '';
if (isMac && !RELEASE) {
  signArg = '-c.mac.identity=null';   // disable signing → fast local iteration
  console.log('[build-dmg] FAST unsigned build (run `npm run publish:mac` or set BOOKFORGE_RELEASE=1 to sign + notarize).');
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

// macOS codesign/notarization is only reliable on native volumes (APFS/HFS+).
// The Callisto build volume is ExFAT, which can't store extended attributes
// inline — it shunts them into AppleDouble `._name` companion files. That
// corrupts the app/framework code seal, so codesign "succeeds" but the notary
// rejects it ("The signature of the binary is invalid" on the main binary +
// Electron Framework). (ExFAT DOES support symlinks here, so that's not it.)
// Detect the AppleDouble behavior directly, and when present assemble + sign +
// DMG on an APFS dir, copying the finished DMG back to release/ so the publish
// flow is unchanged.
function shuntsXattrsToAppleDouble(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `.xattrprobe-${process.pid}`);
  const dbl = path.join(dir, `._.xattrprobe-${process.pid}`);
  try {
    fs.writeFileSync(f, 'x');
    execFileSync('xattr', ['-w', 'com.apple.bookforge.probe', 'v', f]);
    return fs.existsSync(dbl);  // a `._` companion => non-native FS
  } catch { return false; }     // xattr unavailable — assume native, don't relocate
  finally { for (const p of [f, dbl]) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } } }
}
// Transient APFS scratch for the signed build (overwritten each run). The
// finished DMG is copied back to release/ on the project volume, so this is
// invisible plumbing — the project itself never moves off Callisto.
// Only relocate for RELEASE (signed) builds — an unsigned in-place build doesn't
// care about the FS, and relocating would cost an extra multi-GB copy for nothing.
const NATIVE_OUT = (RELEASE && shuntsXattrsToAppleDouble(RELEASE_DIR))
  ? path.join(os.homedir(), 'Projects', 'BookForge-builds', 'release')
  : RELEASE_DIR;
let outputArg = '';
if (NATIVE_OUT !== RELEASE_DIR) {
  fs.mkdirSync(NATIVE_OUT, { recursive: true });
  outputArg = `-c.directories.output=${NATIVE_OUT}`;
  console.log(`[build-dmg] release/ is on a non-native FS (ExFAT) that breaks codesign — building on APFS at ${NATIVE_OUT}, copying the DMG back to release/ after.`);
}

// SAFETY: electron-builder can rewrite the SOURCE package.json in place (see
// pkg-guard.js — shared with the Windows scripts, which run the same risk).
guardPackageJson('build-dmg');

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  detachStaleImages();
  try {
    execSync(`${EB} ${builderArgs.join(' ')} ${versionArg} ${notarizeArg} ${outputArg} ${signArg}`.replace(/\s+/g, ' ').trim(), { stdio: 'inherit' });
    if (NATIVE_OUT !== RELEASE_DIR) {
      fs.mkdirSync(RELEASE_DIR, { recursive: true });
      let copied = 0;
      for (const f of fs.readdirSync(NATIVE_OUT)) {
        if (/\.(dmg|blockmap)$/i.test(f) || /\.ya?ml$/i.test(f)) {
          fs.copyFileSync(path.join(NATIVE_OUT, f), path.join(RELEASE_DIR, f));
          copied++;
        }
      }
      console.log(`[build-dmg] copied ${copied} artifact(s) from ${NATIVE_OUT} -> ${RELEASE_DIR}`);
    }
    process.exit(0);
  } catch {
    if (attempt === MAX_ATTEMPTS) {
      console.error(`\n[build-dmg] electron-builder failed after ${MAX_ATTEMPTS} attempts.`);
      process.exit(1);
    }
    console.warn(`\n[build-dmg] attempt ${attempt}/${MAX_ATTEMPTS} failed (often a transient hdiutil resize) — detaching stale images and retrying…`);
  }
}
