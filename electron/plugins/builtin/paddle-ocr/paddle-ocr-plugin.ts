/**
 * PaddleOCR Plugin
 *
 * Cross-platform OCR using PaddlePaddle's PaddleOCR.
 * Supports text recognition and layout detection via PP-DocLayout.
 *
 * Architecture: Spawns a fresh Python process per image. PaddlePaddle's C++
 * runtime has threading stability issues as a long-running process on macOS
 * ARM64, so process-per-image gives us crash isolation at the cost of ~4s
 * model loading overhead per page (negligible when OCR itself takes ~20s).
 *
 * Install: pip install paddleocr paddlepaddle
 */

import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { IpcMainInvokeEvent } from 'electron';
import {
  BasePlugin,
  PluginManifest,
  PluginIpcHandler,
  ToolAvailability,
  PluginProgress,
} from '../../plugin-types';
import { getPluginRegistry } from '../../plugin-registry';

interface PaddleTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
}

interface PaddleLayoutBlock {
  bbox: [number, number, number, number];
  polygon: number[][];
  label: string;
  confidence: number;
  position: number;
  text?: string;
}

interface PaddleOcrResult {
  text: string;
  confidence: number;
  textLines?: PaddleTextLine[];
  layoutBlocks?: PaddleLayoutBlock[];
  error?: string;
}

interface PaddlePageResult {
  page: number;
  text: string;
  textLines: PaddleTextLine[];
  layoutBlocks?: PaddleLayoutBlock[];
}

export class PaddleOcrPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    id: 'paddle-ocr',
    name: 'PaddleOCR',
    version: '1.0.0',
    description: 'Cross-platform OCR with layout detection using PaddleOCR',
    capabilities: ['ocr'],
    settingsSchema: [
      {
        key: 'ocrVersion',
        type: 'select',
        label: 'OCR Version',
        description: 'PaddleOCR model version to use',
        default: 'PP-OCRv4',
        options: [
          { value: 'PP-OCRv5', label: 'PP-OCRv5 (Latest)' },
          { value: 'PP-OCRv4', label: 'PP-OCRv4 (Stable)' },
          { value: 'PP-OCRv3', label: 'PP-OCRv3' },
        ],
      },
      {
        key: 'language',
        type: 'select',
        label: 'Language',
        description: 'Primary OCR language',
        default: 'en',
        options: [
          { value: 'en', label: 'English' },
          { value: 'ch', label: 'Chinese' },
          { value: 'german', label: 'German' },
          { value: 'french', label: 'French' },
          { value: 'japan', label: 'Japanese' },
          { value: 'korean', label: 'Korean' },
        ],
      },
    ],
  };

  private cachedAvailability: ToolAvailability | null = null;
  private scriptPath: string;
  private venvPython: string | null = null;

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-paddleocr.py');
  }

  async dispose(): Promise<void> {
    // No persistent state to clean up
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    // Find the venv Python first
    this.venvPython = this.findVenvPython();

    try {
      let pipOutput: string;
      if (this.venvPython) {
        // Use venv's pip to check for paddleocr
        pipOutput = await this.execAsync(`"${this.venvPython}" -m pip show paddleocr`, 10000);
      } else {
        // Fall back to system pip
        const pipCmd = process.platform === 'win32'
          ? 'pip show paddleocr'
          : 'pip show paddleocr 2>/dev/null || pip3 show paddleocr 2>/dev/null';
        pipOutput = await this.execAsync(pipCmd, 10000);
      }
      const versionMatch = pipOutput.match(/Version:\s*(\S+)/);
      const version = versionMatch ? versionMatch[1] : 'installed';

      this.cachedAvailability = {
        available: true,
        version,
        path: this.scriptPath,
      };
    } catch {
      this.cachedAvailability = {
        available: false,
        error: 'paddleocr package not found',
        installInstructions: 'Install with: pip install paddleocr paddlepaddle (in a dedicated venv at ~/.paddleocr-venv)',
      };
    }

    return this.cachedAvailability;
  }

  getIpcHandlers(): PluginIpcHandler[] {
    return [
      {
        channel: 'recognize',
        handler: async (event, ...args) => this.handleRecognize(event, args[0] as string),
      },
      {
        channel: 'recognize-with-layout',
        handler: async (event, ...args) => this.handleRecognizeWithLayout(event, args[0] as string),
      },
      {
        channel: 'recognize-batch',
        handler: async (event, ...args) => this.handleRecognizeBatch(event, args[0] as string[], args[1] as number[]),
      },
      {
        channel: 'detect-layout',
        handler: async (event, ...args) => this.handleDetectLayout(event, args[0] as string),
      },
    ];
  }

  private async handleRecognize(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: PaddleOcrResult; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData, false);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleRecognizeWithLayout(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: PaddleOcrResult; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData, true);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleRecognizeBatch(
    _event: IpcMainInvokeEvent,
    images: string[],
    pageNumbers: number[]
  ): Promise<{ success: boolean; data?: PaddlePageResult[]; error?: string }> {
    try {
      const results = await this.recognizeBatch(images, pageNumbers);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleDetectLayout(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: PaddleLayoutBlock[]; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData, true);
      return { success: true, data: result.layoutBlocks || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── OCR Methods ───────────────────────────────────────────────────────────

  /**
   * Spawn a fresh Python process for a single image.
   * Each invocation loads PaddleOCR, processes the image, and exits.
   * This gives us crash isolation — a segfault in PaddlePaddle's C++ layer
   * only kills that one page, not the whole batch.
   */
  private runSingleImage(imagePath: string, withLayout: boolean): Promise<PaddleOcrResult> {
    return new Promise((resolve, reject) => {
      const ocrVersion = this.getSetting<string>('ocrVersion') || 'PP-OCRv4';
      const language = this.getSetting<string>('language') || 'en';

      const args = [
        this.scriptPath,
        '--image', imagePath,
        '--version', ocrVersion,
        '--language', language,
      ];
      if (withLayout) {
        args.push('--layout');
      }

      const pythonCmd = this.venvPython || 'python3';
      const proc = spawn(pythonCmd, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout!.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr!.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024) stderr = stderr.slice(-10 * 1024);
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start PaddleOCR: ${err.message}`));
      });

      proc.on('close', (code, signal) => {
        if (signal) {
          reject(new Error(`PaddleOCR crashed (${signal})`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`PaddleOCR exited with code ${code}: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim()) as PaddleOcrResult;
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve(result);
          }
        } catch {
          reject(new Error(`Failed to parse PaddleOCR output: ${stdout.slice(0, 200)}`));
        }
      });
    });
  }

  private async recognizeImage(imageData: string, withLayout: boolean): Promise<PaddleOcrResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'PaddleOCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddle-ocr-'));
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      inputPath = this.resolveInputPath(imageData, tempDir);
      needsCleanupInput = inputPath.startsWith(tempDir);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      return await this.runSingleImage(inputPath, withLayout);
    } finally {
      if (needsCleanupInput) {
        this.cleanupTempDir(tempDir);
      } else {
        try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
      }
    }
  }

  private async recognizeBatch(
    images: string[],
    pageNumbers: number[]
  ): Promise<PaddlePageResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'PaddleOCR not available');
    }

    const results: PaddlePageResult[] = [];

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const pageNum = pageNumbers[i];
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paddle-ocr-'));

      try {
        const inputPath = this.resolveInputPath(imageData, tempDir);

        if (!fs.existsSync(inputPath)) {
          console.warn(`[PaddleOCR] Input not found for page ${pageNum}, skipping`);
          continue;
        }

        try {
          const ocrResult = await this.runSingleImage(inputPath, false);
          results.push({
            page: pageNum,
            text: ocrResult.text,
            textLines: ocrResult.textLines || [],
            layoutBlocks: ocrResult.layoutBlocks,
          });
        } catch (err) {
          // Process crashed on this page — log and continue with next page
          console.error(`[PaddleOCR] Failed on page ${pageNum}: ${(err as Error).message}`);
        }

        const progress: PluginProgress = {
          pluginId: this.manifest.id,
          operation: 'recognize-batch',
          current: i + 1,
          total: images.length,
          percentage: Math.round(((i + 1) / images.length) * 100),
          message: `Processing page ${i + 1} of ${images.length}`,
        };
        getPluginRegistry().emitProgress(progress);
      } finally {
        this.cleanupTempDir(tempDir);
      }
    }

    return results;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private resolveInputPath(imageData: string, tempDir: string): string {
    if (imageData.startsWith('bookforge-page://')) {
      let filePath = imageData.replace('bookforge-page://', '');
      // Only prepend '/' for Unix paths — Windows paths already start with a drive letter
      if (!filePath.startsWith('/') && !filePath.match(/^[A-Za-z]:/)) {
        filePath = '/' + filePath;
      }
      return filePath;
    } else if (imageData.startsWith('file://')) {
      let filePath = imageData.replace('file://', '');
      // Strip leading slash before Windows drive letter (file:///C:/... → C:/...)
      if (filePath.match(/^\/[A-Za-z]:/)) {
        filePath = filePath.slice(1);
      }
      return filePath;
    } else if (imageData.startsWith('/') || imageData.match(/^[A-Za-z]:\\/)) {
      return imageData;
    } else if (imageData.startsWith('data:')) {
      const inputPath = path.join(tempDir, 'input.png');
      const imageBuffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(inputPath, imageBuffer);
      return inputPath;
    } else {
      const inputPath = path.join(tempDir, 'input.png');
      const imageBuffer = Buffer.from(imageData, 'base64');
      fs.writeFileSync(inputPath, imageBuffer);
      return inputPath;
    }
  }

  private cleanupTempDir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Find the dedicated PaddleOCR venv Python.
   * PaddlePaddle cannot coexist with PyTorch in the same Python environment
   * on Windows (conflicting CUDA DLLs and pybind11 types), so we use a
   * dedicated venv at ~/.paddleocr-venv.
   */
  private findVenvPython(): string | null {
    const homeDir = os.homedir();
    const venvName = '.paddleocr-venv';

    const candidates = process.platform === 'win32'
      ? [
          path.join(homeDir, venvName, 'Scripts', 'python.exe'),
        ]
      : [
          path.join(homeDir, venvName, 'bin', 'python'),
          path.join(homeDir, venvName, 'bin', 'python3'),
        ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private execAsync(cmd: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { encoding: 'utf-8', timeout }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }
}
