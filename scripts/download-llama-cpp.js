#!/usr/bin/env node
/**
 * Download llama.cpp pre-built `llama-server` for the bundled local-LLM path
 * (WS2 AI Setup wizard → electron/llama-bridge.ts).
 *
 * llama.cpp is a standalone C++ inference engine: no Python, no CMake, no build
 * tools. We grab the official pre-built release binary for the HOST platform and
 * stage it (plus its runtime libs) into resources/bin/ — the same place
 * download-mupdf.js puts mutool. electron-builder's build.<os>.extraResources
 * then ships them.
 *
 * BookForge builds on the target platform (package:mac on a Mac, package:win on
 * Windows), so this keys off process.platform/arch like download-mupdf.js does.
 *
 * Staged layout (matches resolveBinary() in electron/llama-bridge.ts):
 *   macOS:   resources/bin/llama-server-<arch>   + *.dylib   (orig names)
 *   Windows: resources/bin/llama-server.exe      + *.dll     (CPU build)
 *
 * macOS dylibs keep their original leaf names (BookForge has no whisper, so no
 * name-collision dance like Briefcase): we copy them next to the binary and
 * rewrite its @rpath/<lib> load commands to @loader_path/<lib>, then ad-hoc
 * codesign so the modified Mach-O runs. The bridge ALSO sets DYLD_LIBRARY_PATH
 * to the binary dir, so loading is belt-and-suspenders.
 *
 * Windows ships the small CPU-only build (~20 MB) so the installer stays under
 * the single-file size cap and runs on every machine. The CUDA build (GPU
 * acceleration, ~570 MB) is a download-on-demand optional component gated on a
 * detected NVIDIA GPU — see electron/components/llama-cuda.ts.
 *
 * Usage: node scripts/download-llama-cpp.js [--force]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── Pins ─────────────────────────────────────────────────────────────────────

// llama.cpp release tag. Matches Briefcase's proven pin (its dylib set and
// runtime behavior are known-good against this bridge). KEEP IN SYNC with
// LLAMA_CPP_VERSION in electron/components/llama-cuda.ts (the optional GPU pack
// must come from the same release as the bundled CPU build).
const LLAMA_CPP_VERSION = 'b7482';

const REL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_VERSION}`;

const BIN_DIR = path.join(__dirname, '..', 'resources', 'bin');
const CACHE_DIR = path.join(__dirname, '..', '.llama-build');

const force = process.argv.includes('--force');

function log(msg) { console.log(`[llama] ${msg}`); }
function warn(msg) { console.warn(`[llama] ${msg}`); }

// ── Download (redirect-aware, with progress) ──────────────────────────────────

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let redirects = 0;

    const req = (currentUrl) => {
      const proto = currentUrl.startsWith('https') ? https : http;
      proto.get(currentUrl, { headers: { 'User-Agent': 'BookForge/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (++redirects > 10) { reject(new Error('Too many redirects')); return; }
          let loc = res.headers.location;
          if (loc.startsWith('/')) {
            const u = new URL(currentUrl);
            loc = `${u.protocol}//${u.host}${loc}`;
          }
          req(loc);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${currentUrl}`));
          return;
        }
        const total = parseInt(res.headers['content-length'], 10);
        let got = 0, lastPct = 0, lastLog = Date.now();
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total) {
            const pct = Math.floor((got / total) * 100);
            const now = Date.now();
            if (pct >= lastPct + 5 || (now - lastLog > 2000 && pct > lastPct)) {
              process.stdout.write(`\r[llama]   ${pct}% (${(got / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`);
              lastPct = pct; lastLog = now;
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); process.stdout.write('\r[llama]   100%                              \n'); resolve(); });
        file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
      }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    };
    req(url);
  });
}

// ── Extract (bsdtar handles both .tar.gz and .zip on macOS + Windows) ─────────

/**
 * The tar to invoke, shell-quoted. On Windows, pin to the OS-bundled bsdtar
 * (%SystemRoot%\System32\tar.exe) so a GNU tar earlier on PATH (e.g. Git for Windows')
 * can't misread the "C:\…" drive-letter paths or fail to read zips. Mirrors downloader.ts.
 */
function tarCmd() {
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return `"${sys}"`;
  }
  return 'tar';
}

function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = tarCmd();
  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    execSync(`${tar} -xzf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
  } else {
    // bsdtar (the default `tar` on macOS and Windows 10+) extracts zips.
    try {
      execSync(`${tar} -xf "${archivePath}" -C "${destDir}"`, { stdio: 'pipe' });
    } catch {
      // Fallback to unzip where available (Linux/macOS dev hosts).
      execSync(`unzip -q -o "${archivePath}" -d "${destDir}"`, { stdio: 'pipe' });
    }
  }
}

function findFile(dir, predicate) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      const found = findFile(full, predicate);
      if (found) return found;
    } else if (predicate(entry)) {
      return full;
    }
  }
  return null;
}

function isValidBinary(p, minSize = 100 * 1024) {
  return fs.existsSync(p) && fs.statSync(p).size >= minSize;
}

async function fetchAndCache(assetName) {
  const url = `${REL}/${assetName}`;
  const cached = path.join(CACHE_DIR, assetName);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 100 * 1024) {
    log(`using cached ${assetName}`);
  } else {
    log(`downloading ${assetName}`);
    log(`  ${url}`);
    await downloadFile(url, cached);
  }
  const extractDir = path.join(CACHE_DIR, assetName.replace(/\.(tar\.gz|tgz|zip)$/, ''));
  fs.rmSync(extractDir, { recursive: true, force: true });
  extract(cached, extractDir);
  return extractDir;
}

// ── macOS ─────────────────────────────────────────────────────────────────────

function macFixLoaderPaths(machoPath, dylibDir) {
  // Rewrite every @rpath/<leaf> load command to @loader_path/<leaf> when we have
  // that dylib staged next to the binary. Generic (reads otool) rather than
  // guessing names.
  let deps;
  try {
    deps = execSync(`otool -L "${machoPath}"`, { encoding: 'utf8' })
      .split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  } catch { return; }
  for (const dep of deps) {
    if (!dep.startsWith('@rpath/')) continue;
    const leaf = path.basename(dep);
    if (!fs.existsSync(path.join(dylibDir, leaf))) continue;
    try {
      execSync(`install_name_tool -change "${dep}" "@loader_path/${leaf}" "${machoPath}"`, { stdio: 'pipe' });
    } catch { /* dep may already be rewritten */ }
  }
  // Belt-and-suspenders: any unresolved @rpath/* also resolves from the dir.
  try { execSync(`install_name_tool -add_rpath "@loader_path" "${machoPath}"`, { stdio: 'pipe' }); }
  catch { /* rpath may already exist */ }
}

function codesignAdhoc(p) {
  try { execSync(`codesign --force --sign - "${p}"`, { stdio: 'pipe' }); }
  catch (err) { warn(`codesign warning for ${path.basename(p)}: ${err.message}`); }
}

async function setupMacOS() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binaryName = `llama-server-${arch}`;
  const destBinary = path.join(BIN_DIR, binaryName);

  if (isValidBinary(destBinary) && !force) {
    log(`${binaryName} already staged (use --force to refresh)`);
    return;
  }

  const extractDir = await fetchAndCache(`llama-${LLAMA_CPP_VERSION}-bin-macos-${arch}.tar.gz`);
  const serverSrc = findFile(extractDir, (f) => f === 'llama-server');
  if (!serverSrc) throw new Error('llama-server not found in macOS archive');

  const srcBinDir = path.dirname(serverSrc);
  const searchDirs = [srcBinDir, path.join(srcBinDir, '..', 'lib')].filter((d) => fs.existsSync(d));

  // Copy the binary.
  fs.copyFileSync(serverSrc, destBinary);
  fs.chmodSync(destBinary, 0o755);

  // Copy ALL dylibs found alongside the binary (original leaf names).
  const dylibs = [];
  for (const dir of searchDirs) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.dylib')) {
        const dest = path.join(BIN_DIR, f);
        fs.copyFileSync(path.join(dir, f), dest);
        fs.chmodSync(dest, 0o755);
        if (!dylibs.includes(f)) dylibs.push(f);
      }
    }
  }
  log(`staged ${binaryName} + ${dylibs.length} dylibs`);

  // Fix load commands: dylib ids first, then inter-dylib + binary references.
  for (const lib of dylibs) {
    const libPath = path.join(BIN_DIR, lib);
    try { execSync(`install_name_tool -id "@loader_path/${lib}" "${libPath}"`, { stdio: 'pipe' }); }
    catch { /* may already be set */ }
  }
  for (const lib of dylibs) macFixLoaderPaths(path.join(BIN_DIR, lib), BIN_DIR);
  macFixLoaderPaths(destBinary, BIN_DIR);

  // Ad-hoc re-sign everything we mutated (required on arm64).
  for (const lib of dylibs) codesignAdhoc(path.join(BIN_DIR, lib));
  codesignAdhoc(destBinary);

  // Verify it runs from the staged location.
  try {
    const out = execSync(`"${destBinary}" --version 2>&1`, {
      encoding: 'utf8', env: { ...process.env, DYLD_LIBRARY_PATH: BIN_DIR },
    });
    log(`verified: ${out.trim().split('\n')[0]}`);
  } catch (err) {
    throw new Error(`Staged llama-server failed to run: ${err.message}\n${(err.stdout || '') + (err.stderr || '')}`);
  }
}

// ── Windows ────────────────────────────────────────────────────────────────────

// Visual C++ runtime DLLs the binaries need on a clean system. Redistributable;
// copied from System32 on the (Windows) build host.
const VCRUNTIME_DLLS = ['MSVCP140.dll', 'MSVCP140_CODECVT_IDS.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll'];

function copyAllDlls(srcDir, label) {
  let n = 0;
  for (const f of fs.readdirSync(srcDir)) {
    if (f.toLowerCase().endsWith('.dll')) {
      fs.copyFileSync(path.join(srcDir, f), path.join(BIN_DIR, f));
      n++;
    }
  }
  log(`copied ${n} DLLs from ${label}`);
}

async function setupWindows() {
  if (process.arch !== 'x64') throw new Error(`Unsupported Windows arch: ${process.arch} (only x64 is built)`);
  const destBinary = path.join(BIN_DIR, 'llama-server.exe');

  if (isValidBinary(destBinary) && !force) {
    log('llama-server.exe already staged (use --force to refresh)');
    return;
  }

  // CPU-only build (~20 MB). The CUDA build is a download-on-demand component
  // (electron/components/llama-cuda.ts), so the installer ships only this.
  const cpuDir = await fetchAndCache(`llama-${LLAMA_CPP_VERSION}-bin-win-cpu-x64.zip`);
  const serverSrc = findFile(cpuDir, (f) => f.toLowerCase() === 'llama-server.exe');
  if (!serverSrc) throw new Error('llama-server.exe not found in Windows CPU archive');
  const cpuBinDir = path.dirname(serverSrc);

  fs.copyFileSync(serverSrc, destBinary);
  log('staged llama-server.exe (CPU build)');
  copyAllDlls(cpuBinDir, 'llama CPU build');

  // VC++ runtime (only obtainable from a Windows host's System32).
  if (process.platform === 'win32') {
    for (const dll of VCRUNTIME_DLLS) {
      const dest = path.join(BIN_DIR, dll);
      if (fs.existsSync(dest)) continue;
      const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', dll);
      if (fs.existsSync(sys)) { fs.copyFileSync(sys, dest); log(`copied ${dll} from System32`); }
      else warn(`${dll} not found — target may need the VC++ 2015-2022 Redistributable`);
    }
  } else {
    warn('cross-building Windows from a non-Windows host: VC++ runtime DLLs not bundled.');
    warn('Run this on a Windows host, or ensure the target has the VC++ 2015-2022 Redistributable.');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log(`llama.cpp ${LLAMA_CPP_VERSION} — platform ${process.platform} (${process.arch})`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (process.platform === 'darwin') {
    await setupMacOS();
  } else if (process.platform === 'win32') {
    await setupWindows();
  } else {
    warn(`Linux not bundled yet — skipping (local-LLM path unavailable on this build).`);
    return;
  }

  log('done. Staged into resources/bin/:');
  for (const f of fs.readdirSync(BIN_DIR)) {
    if (/^llama-server/.test(f) || f.endsWith('.dylib') || f.endsWith('.dll')) {
      log(`  ${f} (${(fs.statSync(path.join(BIN_DIR, f)).size / 1e6).toFixed(1)} MB)`);
    }
  }
}

// Exit explicitly on success — download/extract child handles can keep the event
// loop alive and stall the package build's && chain (same fix as download-mupdf).
main().then(() => process.exit(0)).catch((err) => {
  console.error(`\n[llama] FAILED: ${err.message}\n`);
  process.exit(1);
});
