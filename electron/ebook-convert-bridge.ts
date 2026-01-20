/**
 * Ebook Convert Bridge - Calibre ebook-convert CLI integration
 *
 * Converts various ebook formats to EPUB using Calibre's ebook-convert tool.
 * If Calibre is not installed, conversion is silently skipped.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import { app } from 'electron';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionResult {
  success: boolean;
  outputPath?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supported Formats
// ─────────────────────────────────────────────────────────────────────────────

// Formats that ebook-convert can convert to EPUB
const CONVERTIBLE_EXTENSIONS = new Set([
  '.azw3',
  '.azw',
  '.mobi',
  '.kfx',
  '.prc',
  '.fb2',
  '.lit',
  '.pdb',
  '.docx',
  '.rtf',
  '.txt',
  '.html',
  '.htm',
  '.cbz',
  '.cbr',
  '.odt',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Path Detection
// ─────────────────────────────────────────────────────────────────────────────

// Common locations for ebook-convert
const EBOOK_CONVERT_PATHS = [
  // macOS Calibre.app
  '/Applications/calibre.app/Contents/MacOS/ebook-convert',
  // macOS Homebrew
  '/opt/homebrew/bin/ebook-convert',
  '/usr/local/bin/ebook-convert',
  // Linux
  '/usr/bin/ebook-convert',
  // Windows (common install paths)
  'C:\\Program Files\\Calibre2\\ebook-convert.exe',
  'C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe',
];

let cachedEbookConvertPath: string | null | undefined = undefined;

/**
 * Find the ebook-convert executable
 */
async function findEbookConvert(): Promise<string | null> {
  // Return cached result if we've already searched
  if (cachedEbookConvertPath !== undefined) {
    return cachedEbookConvertPath;
  }

  // Check common paths
  for (const checkPath of EBOOK_CONVERT_PATHS) {
    try {
      await fs.access(checkPath, fs.constants.X_OK);
      cachedEbookConvertPath = checkPath;
      console.log('[EbookConvert] Found at:', checkPath);
      return checkPath;
    } catch {
      // Not found at this path, continue
    }
  }

  // Try PATH lookup via 'which' on Unix or 'where' on Windows
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await runCommand(cmd, ['ebook-convert']);
    if (result.success && result.output) {
      const foundPath = result.output.trim().split('\n')[0];
      cachedEbookConvertPath = foundPath;
      console.log('[EbookConvert] Found in PATH:', foundPath);
      return foundPath;
    }
  } catch {
    // Not in PATH
  }

  console.log('[EbookConvert] Not found - conversion disabled');
  cachedEbookConvertPath = null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  success: boolean;
  output: string;
  error: string;
  code: number | null;
}

function runCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr,
        code
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: '',
        error: err.message,
        code: null
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if ebook-convert is available
 */
export async function isAvailable(): Promise<boolean> {
  const ebookConvertPath = await findEbookConvert();
  return ebookConvertPath !== null;
}

/**
 * Check if a file extension is convertible to EPUB
 */
export function isConvertibleFormat(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return CONVERTIBLE_EXTENSIONS.has(ext);
}

/**
 * Check if a file is already EPUB or PDF (natively supported)
 */
export function isNativeFormat(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.epub' || ext === '.pdf';
}

/**
 * Get the list of all supported extensions (native + convertible)
 */
export function getSupportedExtensions(): string[] {
  return ['.epub', '.pdf', ...Array.from(CONVERTIBLE_EXTENSIONS)];
}

/**
 * Convert an ebook to EPUB format
 *
 * @param inputPath - Path to the source ebook
 * @param outputDir - Directory to save the converted EPUB (optional, defaults to same dir as input)
 * @returns Conversion result with output path or error
 */
export async function convertToEpub(
  inputPath: string,
  outputDir?: string
): Promise<ConversionResult> {
  const ebookConvertPath = await findEbookConvert();

  if (!ebookConvertPath) {
    return {
      success: false,
      error: 'ebook-convert not found. Install Calibre to enable format conversion.'
    };
  }

  const ext = path.extname(inputPath).toLowerCase();

  if (!CONVERTIBLE_EXTENSIONS.has(ext)) {
    return {
      success: false,
      error: `Unsupported format: ${ext}`
    };
  }

  // Determine output path
  const inputBasename = path.basename(inputPath, ext);
  const targetDir = outputDir || path.dirname(inputPath);
  const outputPath = path.join(targetDir, `${inputBasename}.epub`);

  // Check if output already exists
  try {
    await fs.access(outputPath);
    console.log('[EbookConvert] EPUB already exists:', outputPath);
    return { success: true, outputPath };
  } catch {
    // File doesn't exist, proceed with conversion
  }

  console.log('[EbookConvert] Converting:', inputPath);
  console.log('[EbookConvert] Output:', outputPath);

  // Run ebook-convert
  const args = [inputPath, outputPath];
  const result = await runCommand(ebookConvertPath, args);

  if (result.success) {
    console.log('[EbookConvert] Conversion successful');
    return { success: true, outputPath };
  } else {
    console.error('[EbookConvert] Conversion failed:', result.error);
    return {
      success: false,
      error: result.error || `Conversion failed with code ${result.code}`
    };
  }
}

/**
 * Convert an ebook to EPUB and save in the BookForge library
 *
 * @param inputPath - Path to the source ebook
 * @returns Conversion result with output path in library
 */
export async function convertToLibrary(inputPath: string): Promise<ConversionResult> {
  const documentsPath = app.getPath('documents');
  const libraryDir = path.join(documentsPath, 'BookForge', 'converted');

  // Ensure converted directory exists
  await fs.mkdir(libraryDir, { recursive: true });

  return convertToEpub(inputPath, libraryDir);
}

// ─────────────────────────────────────────────────────────────────────────────
// Export singleton-style interface
// ─────────────────────────────────────────────────────────────────────────────

export const ebookConvertBridge = {
  isAvailable,
  isConvertibleFormat,
  isNativeFormat,
  getSupportedExtensions,
  convertToEpub,
  convertToLibrary
};
