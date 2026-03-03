/**
 * PaddleOCR Plugin
 *
 * Cross-platform OCR using PaddlePaddle's PaddleOCR.
 * Supports text recognition and layout detection via PP-DocLayout.
 *
 * Install: pip install paddleocr paddlepaddle
 */

import { spawn, execSync } from 'child_process';
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

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

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

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-paddleocr.py');
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    // Check if paddleocr is installed
    try {
      const pipCmd = process.platform === 'win32'
        ? 'pip show paddleocr'
        : 'pip show paddleocr 2>/dev/null || pip3 show paddleocr 2>/dev/null';
      const pipOutput = execSync(pipCmd, { encoding: 'utf-8', timeout: 10000 });
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
        installInstructions: 'Install with: pip install paddleocr paddlepaddle',
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
      // Run with layout only - we'll extract just the layout blocks
      const result = await this.recognizeImage(imageData, true);
      return { success: true, data: result.layoutBlocks || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
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

      const ocrVersion = this.getSetting<string>('ocrVersion') || 'PP-OCRv4';
      const language = this.getSetting<string>('language') || 'en';

      return await this.runPaddleOcr(inputPath, ocrVersion, language, withLayout);
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
    const ocrVersion = this.getSetting<string>('ocrVersion') || 'PP-OCRv4';
    const language = this.getSetting<string>('language') || 'en';

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

        const ocrResult = await this.runPaddleOcr(inputPath, ocrVersion, language, false);

        results.push({
          page: pageNum,
          text: ocrResult.text,
          textLines: ocrResult.textLines || [],
          layoutBlocks: ocrResult.layoutBlocks,
        });

        // Report progress
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

  private async runPaddleOcr(
    inputPath: string,
    ocrVersion: string,
    language: string,
    withLayout: boolean
  ): Promise<PaddleOcrResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--image', inputPath,
        '--version', ocrVersion,
        '--language', language,
      ];

      if (withLayout) {
        args.push('--layout');
      }

      const proc = spawn('python3', args, {
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr = appendCapped(stderr, data.toString());
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`PaddleOCR failed (exit ${code}): ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim()) as PaddleOcrResult;
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse PaddleOCR output: ${(err as Error).message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start PaddleOCR: ${err.message}`));
      });
    });
  }

  private resolveInputPath(imageData: string, tempDir: string): string {
    if (imageData.startsWith('bookforge-page://')) {
      let filePath = imageData.replace('bookforge-page://', '');
      if (!filePath.startsWith('/')) {
        filePath = '/' + filePath;
      }
      return filePath;
    } else if (imageData.startsWith('file://')) {
      return imageData.replace('file://', '');
    } else if (imageData.startsWith('/') || imageData.match(/^[A-Za-z]:\\/)) {
      return imageData;
    } else if (imageData.startsWith('data:')) {
      const inputPath = path.join(tempDir, 'input.png');
      const imageBuffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(inputPath, imageBuffer);
      return inputPath;
    } else {
      // Assume raw base64
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
}
