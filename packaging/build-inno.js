#!/usr/bin/env node
/**
 * Compile the BookForge Windows installer with Inno Setup.
 *
 * Wraps an already-built electron-builder `win-unpacked` tree (produced by
 * `electron-builder --win --x64 --dir`) into a single installer .exe. We use
 * Inno instead of NSIS because the bundled offline payload is ~6 GB and NSIS
 * has a hard 2 GB limit that silently truncates the installer.
 *
 * Resolves ISCC.exe across the common install locations (winget installs it
 * per-user under LOCALAPPDATA). Override with ISCC_PATH if needed.
 *
 * Usage: node packaging/build-inno.js [--compression lzma2/fast|none|...] [--spanning]
 *   --spanning   re-enable disk spanning (Setup.exe + .bin slices) for the big
 *                offline build; default is a single-file installer.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

function resolveIscc() {
  const candidates = [
    process.env.ISCC_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const iscc = resolveIscc();
  if (!iscc) {
    console.error('[inno] ISCC.exe not found. Install Inno Setup 6.3+:');
    console.error('[inno]   winget install JRSoftware.InnoSetup');
    console.error('[inno] or set ISCC_PATH to its full path.');
    process.exit(1);
  }

  const sourceDir = path.join(root, 'release', 'win-unpacked');
  const outputDir = path.join(root, 'release');
  let iconFile = path.join(root, 'release', '.icon-ico', 'icon.ico');
  const iss = path.join(__dirname, 'inno', 'bookforge.iss');
  const compression = arg('compression', 'lzma2/max');

  if (!fs.existsSync(sourceDir)) {
    console.error(`[inno] win-unpacked not found at ${sourceDir}`);
    console.error('[inno] Build it first: electron-builder --win --x64 --dir');
    process.exit(1);
  }
  if (!fs.existsSync(iconFile)) {
    // electron-builder regenerates .icon-ico on every build; fall back to the
    // exe's own icon (Inno requires a valid .ico for SetupIconFile, so only
    // override the define when we have one).
    console.warn(`[inno] generated icon not found at ${iconFile}; using Inno default`);
    iconFile = null;
  }

  const spanning = process.argv.includes('--spanning');
  const size = dirSizeGB(sourceDir);
  console.log(`[inno] ISCC:       ${iscc}`);
  console.log(`[inno] source:     ${sourceDir} (${size} GB)`);
  console.log(`[inno] output:     ${outputDir}\\BookForge-Setup-${pkg.version}.exe`);
  console.log(`[inno] compression:${compression}`);
  console.log(`[inno] layout:     ${spanning ? 'disk spanning (.exe + .bin slices)' : 'single file'}`);

  // Inno caps a single Setup.exe at ~4.2 GB. The seed payload is mostly the
  // already-compressed env tarball, so the compressed installer lands near the
  // raw size — warn before ISCC fails late on a multi-GB compile.
  if (!spanning && parseFloat(size) > 4.2) {
    console.warn(
      `[inno] WARNING: source is ${size} GB raw — a single-file installer may exceed Inno's ~4.2 GB cap.\n` +
      `[inno]          Re-run with --spanning (offline build) if the compile fails.`
    );
  }

  const defines = [
    `/DAppVersion=${pkg.version}`,
    `/DSourceDir=${sourceDir}`,
    `/DOutputDir=${outputDir}`,
    `/DCompressionMethod=${compression}`,
    `/DEnableSpanning=${spanning ? 'yes' : 'no'}`,
  ];
  if (iconFile) defines.push(`/DIconFile=${iconFile}`);

  execFileSync(iscc, [iss, ...defines], { stdio: 'inherit' });
  console.log('[inno] installer built.');
}

function dirSizeGB(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { try { bytes += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  }
  return (bytes / 1e9).toFixed(2);
}

main();
