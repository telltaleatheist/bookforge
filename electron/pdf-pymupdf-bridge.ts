/**
 * PyMuPDF Bridge - PDF manipulation via Python subprocess
 *
 * This implementation calls Python with PyMuPDF for PDF operations.
 * Requires: python3 with pymupdf installed (pip install pymupdf)
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { PdfBridge, RedactionRegion, RedactionOptions, Bookmark } from './pdf-bridge';

const execAsync = promisify(exec);

export class PyMuPdfBridge implements PdfBridge {
  private pythonPath: string;
  private scriptPath: string;
  private available: boolean | null = null;

  constructor(pythonPath: string = 'python3') {
    this.pythonPath = pythonPath;
    // Script location: check multiple paths
    // - In dev: electron/pdf-redact.py (source)
    // - In prod: dist/electron/pdf-redact.py (copied during build)
    // - Packaged: resources/pdf-redact.py
    this.scriptPath = this.findScript();
  }

  private findScript(): string {
    const possiblePaths = [
      path.join(__dirname, 'pdf-redact.py'),                    // Same dir as compiled JS
      path.join(__dirname, '..', '..', 'electron', 'pdf-redact.py'), // Dev: dist/electron -> electron
      path.join(process.resourcesPath || '', 'pdf-redact.py'),  // Packaged Electron app
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Default to same directory
    return path.join(__dirname, 'pdf-redact.py');
  }

  getName(): string {
    return 'PyMuPDF (Python subprocess)';
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      // Check if Python is available
      await execAsync(`${this.pythonPath} --version`);

      // Check if pymupdf is installed
      await execAsync(`${this.pythonPath} -c "import pymupdf; print(pymupdf.version)"`);

      // Check if script exists
      if (!fs.existsSync(this.scriptPath)) {
        console.warn(`[PyMuPdfBridge] Script not found: ${this.scriptPath}`);
        this.available = false;
        return false;
      }

      this.available = true;
      return true;
    } catch (e) {
      console.warn('[PyMuPdfBridge] Not available:', e);
      this.available = false;
      return false;
    }
  }

  async redact(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void> {
    // Write regions to temp JSON file
    // Use /tmp on macOS instead of os.tmpdir() which returns /var/folders/...
    const tmpDir = process.platform === 'darwin' ? '/tmp' : os.tmpdir();
    const regionsPath = path.join(tmpDir, `bookforge-regions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    const regionsData = {
      regions: regions.map(r => ({
        page: r.page,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        isImage: r.isImage || false
      })),
      deletedPages: options?.deletedPages || [],
      bookmarks: options?.bookmarks || []
    };

    await fsPromises.writeFile(regionsPath, JSON.stringify(regionsData, null, 2));

    try {
      console.log(`[PyMuPdfBridge] Redacting ${regions.length} regions, ${options?.bookmarks?.length || 0} bookmarks from ${path.basename(inputPath)}`);

      const { stdout, stderr } = await execAsync(
        `"${this.pythonPath}" "${this.scriptPath}" "${inputPath}" "${outputPath}" "${regionsPath}"`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      if (stdout) console.log(`[PyMuPdfBridge] ${stdout.trim()}`);
      if (stderr) console.error(`[PyMuPdfBridge] stderr: ${stderr}`);

      // Verify output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error('Output PDF was not created');
      }

    } finally {
      // Clean up temp file
      try {
        await fsPromises.unlink(regionsPath);
      } catch (e) { /* ignore */ }
    }
  }

  async deletePages(
    inputPath: string,
    outputPath: string,
    pages: number[]
  ): Promise<void> {
    // Use redact with no regions, just deleted pages
    await this.redact(inputPath, outputPath, [], { deletedPages: pages });
  }
}

/**
 * Future: Binary bridge implementation
 * This could be a compiled version of the Python script or a different tool entirely
 */
export class BinaryPdfBridge implements PdfBridge {
  private binaryPath: string;
  private available: boolean | null = null;

  constructor(binaryPath?: string) {
    // Look for binary in common locations
    this.binaryPath = binaryPath || this.findBinary();
  }

  private findBinary(): string {
    const possiblePaths = [
      path.join(__dirname, 'pdf-redact'),           // Same directory
      path.join(__dirname, '..', 'bin', 'pdf-redact'), // ../bin/
      path.join(process.resourcesPath || '', 'bin', 'pdf-redact'), // Electron resources
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p) || fs.existsSync(p + '.exe')) {
        return fs.existsSync(p) ? p : p + '.exe';
      }
    }

    return 'pdf-redact'; // Fall back to PATH
  }

  getName(): string {
    return 'PDF Redact Binary';
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) {
      return this.available;
    }

    try {
      await execAsync(`"${this.binaryPath}" --version`);
      this.available = true;
      return true;
    } catch (e) {
      this.available = false;
      return false;
    }
  }

  async redact(
    inputPath: string,
    outputPath: string,
    regions: RedactionRegion[],
    options?: RedactionOptions
  ): Promise<void> {
    const tmpDir = os.tmpdir();
    const regionsPath = path.join(tmpDir, `bookforge-regions-${Date.now()}.json`);

    const regionsData = {
      regions: regions.map(r => ({
        page: r.page,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        isImage: r.isImage || false
      })),
      deletedPages: options?.deletedPages || []
    };

    await fsPromises.writeFile(regionsPath, JSON.stringify(regionsData, null, 2));

    try {
      const { stdout, stderr } = await execAsync(
        `"${this.binaryPath}" "${inputPath}" "${outputPath}" "${regionsPath}"`,
        { maxBuffer: 10 * 1024 * 1024 }
      );

      if (stdout) console.log(`[BinaryPdfBridge] ${stdout.trim()}`);
      if (stderr) console.error(`[BinaryPdfBridge] stderr: ${stderr}`);

    } finally {
      try {
        await fsPromises.unlink(regionsPath);
      } catch (e) { /* ignore */ }
    }
  }

  async deletePages(
    inputPath: string,
    outputPath: string,
    pages: number[]
  ): Promise<void> {
    await this.redact(inputPath, outputPath, [], { deletedPages: pages });
  }
}
