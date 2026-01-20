#!/usr/bin/env node
/**
 * Download/build MuPDF binaries for BookForge
 *
 * - Windows: Downloads pre-built binary from mupdf.com
 * - macOS: Compiles from source (requires Xcode command line tools)
 *
 * Usage: node scripts/download-mupdf.js [--force]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createWriteStream, existsSync, mkdirSync, chmodSync } from 'fs';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MUPDF_VERSION = '1.27.0';
const RESOURCES_BIN = path.join(__dirname, '..', 'resources', 'bin');
const TEMP_DIR = path.join(__dirname, '..', '.mupdf-build');

const URLS = {
  windows: `https://mupdf.com/downloads/archive/mupdf-${MUPDF_VERSION}-windows.zip`,
  source: `https://mupdf.com/downloads/archive/mupdf-${MUPDF_VERSION}-source.tar.gz`
};

const force = process.argv.includes('--force');

function log(msg) {
  console.log(`[mupdf] ${msg}`);
}

function error(msg) {
  console.error(`[mupdf] ERROR: ${msg}`);
}

/**
 * Download a file with redirect support
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    log(`Downloading ${url}...`);

    const file = createWriteStream(destPath);

    const makeRequest = (currentUrl) => {
      const protocol = currentUrl.startsWith('https') ? https : http;

      protocol.get(currentUrl, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          log(`Redirecting to ${response.headers.location}`);
          makeRequest(response.headers.location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalSize > 0) {
            const pct = Math.round((downloaded / totalSize) * 100);
            process.stdout.write(`\r[mupdf] Downloaded ${pct}%`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(''); // newline after progress
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    makeRequest(url);
  });
}

/**
 * Extract tar.gz archive
 */
async function extractTarGz(archivePath, destDir) {
  log(`Extracting to ${destDir}...`);
  mkdirSync(destDir, { recursive: true });

  // Use system tar command
  await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`, {
    maxBuffer: 50 * 1024 * 1024
  });
}

/**
 * Extract zip archive (for Windows)
 */
async function extractZip(archivePath, destDir) {
  log(`Extracting to ${destDir}...`);
  mkdirSync(destDir, { recursive: true });

  // Use system unzip command
  await execAsync(`unzip -q -o "${archivePath}" -d "${destDir}"`, {
    maxBuffer: 50 * 1024 * 1024
  });
}

/**
 * Compile MuPDF from source for macOS
 */
async function compileMacOS(sourceDir, arch) {
  log(`Compiling MuPDF for macOS ${arch}...`);

  const makeArgs = [
    '-j4',  // Parallel build
    'HAVE_X11=no',
    'HAVE_GLUT=no',
    'HAVE_CURL=no',
    'USE_SYSTEM_LIBS=no',
    'build=release'
    // Build all targets (mutool is included)
  ];

  // Set architecture for cross-compilation
  if (arch === 'arm64') {
    makeArgs.push('XCFLAGS=-arch arm64', 'XLDFLAGS=-arch arm64');
  } else if (arch === 'x64') {
    makeArgs.push('XCFLAGS=-arch x86_64', 'XLDFLAGS=-arch x86_64');
  }

  return new Promise((resolve, reject) => {
    const make = spawn('make', makeArgs, {
      cwd: sourceDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    make.stdout.on('data', (data) => {
      output += data.toString();
      // Show progress dots
      process.stdout.write('.');
    });
    make.stderr.on('data', (data) => {
      output += data.toString();
    });

    make.on('close', (code) => {
      console.log(''); // newline after dots
      if (code === 0) {
        resolve();
      } else {
        error(`Make failed with code ${code}`);
        console.log(output.slice(-2000)); // Last 2000 chars of output
        reject(new Error(`Make failed with code ${code}`));
      }
    });
  });
}

/**
 * Setup for Windows
 */
async function setupWindows() {
  const binaryPath = path.join(RESOURCES_BIN, 'mutool.exe');

  if (existsSync(binaryPath) && !force) {
    log('mutool.exe already exists, skipping (use --force to re-download)');
    return;
  }

  mkdirSync(RESOURCES_BIN, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const zipPath = path.join(TEMP_DIR, 'mupdf-windows.zip');

  // Download
  await downloadFile(URLS.windows, zipPath);

  // Extract
  await extractZip(zipPath, TEMP_DIR);

  // Find and copy mutool.exe
  const extractedDir = path.join(TEMP_DIR, `mupdf-${MUPDF_VERSION}-windows`);
  const mutoolSrc = path.join(extractedDir, 'mutool.exe');

  if (!existsSync(mutoolSrc)) {
    throw new Error(`mutool.exe not found in extracted archive at ${mutoolSrc}`);
  }

  fs.copyFileSync(mutoolSrc, binaryPath);
  log(`Installed mutool.exe to ${binaryPath}`);

  // Cleanup
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

/**
 * Setup for macOS - compile from source
 */
async function setupMacOS() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binaryName = `mutool-${arch}`;
  const binaryPath = path.join(RESOURCES_BIN, binaryName);

  if (existsSync(binaryPath) && !force) {
    log(`${binaryName} already exists, skipping (use --force to rebuild)`);
    return;
  }

  // Check for Xcode command line tools
  try {
    await execAsync('xcode-select -p');
  } catch {
    error('Xcode command line tools not found. Install with: xcode-select --install');
    process.exit(1);
  }

  mkdirSync(RESOURCES_BIN, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const tarPath = path.join(TEMP_DIR, 'mupdf-source.tar.gz');

  // Download source
  await downloadFile(URLS.source, tarPath);

  // Extract
  await extractTarGz(tarPath, TEMP_DIR);

  const sourceDir = path.join(TEMP_DIR, `mupdf-${MUPDF_VERSION}-source`);

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory not found at ${sourceDir}`);
  }

  // Compile
  await compileMacOS(sourceDir, arch);

  // Find and copy mutool
  const mutoolSrc = path.join(sourceDir, 'build', 'release', 'mutool');

  if (!existsSync(mutoolSrc)) {
    throw new Error(`Compiled mutool not found at ${mutoolSrc}`);
  }

  fs.copyFileSync(mutoolSrc, binaryPath);
  chmodSync(binaryPath, 0o755);
  log(`Installed ${binaryName} to ${binaryPath}`);

  // Verify it works
  try {
    const { stdout } = await execAsync(`"${binaryPath}" -v`);
    log(`Verified: ${stdout.trim()}`);
  } catch (err) {
    error(`Binary verification failed: ${err.message}`);
  }

  // Cleanup
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

/**
 * Main entry point
 */
async function main() {
  log(`Setting up MuPDF ${MUPDF_VERSION} binaries...`);
  log(`Platform: ${process.platform}, Arch: ${process.arch}`);

  try {
    if (process.platform === 'win32') {
      await setupWindows();
    } else if (process.platform === 'darwin') {
      await setupMacOS();
    } else {
      error(`Unsupported platform: ${process.platform}`);
      error('You may need to compile MuPDF manually and place mutool in resources/bin/');
      process.exit(1);
    }

    log('MuPDF setup complete!');
  } catch (err) {
    error(`Setup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
