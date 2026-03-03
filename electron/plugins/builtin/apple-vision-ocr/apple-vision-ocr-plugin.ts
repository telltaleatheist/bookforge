/**
 * Apple Vision OCR Plugin
 *
 * Uses Apple's VNRecognizeTextRequest via the ocrmac Python package.
 * macOS only - returns unavailable on other platforms.
 *
 * Install: pip install ocrmac Pillow
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

interface AppleVisionTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
}

interface AppleVisionOcrResult {
  text: string;
  confidence: number;
  textLines?: AppleVisionTextLine[];
}

interface AppleVisionPageResult {
  page: number;
  text: string;
  textLines: AppleVisionTextLine[];
}

export class AppleVisionOcrPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    id: 'apple-vision-ocr',
    name: 'Apple Vision',
    version: '1.0.0',
    description: 'Fast, high-quality OCR using Apple Vision framework (macOS only)',
    capabilities: ['ocr'],
    settingsSchema: [
      {
        key: 'recognitionLevel',
        type: 'select',
        label: 'Recognition Level',
        description: 'Fast is quicker but less accurate. Accurate is slower but more precise.',
        default: 'accurate',
        options: [
          { value: 'accurate', label: 'Accurate' },
          { value: 'fast', label: 'Fast' },
        ],
      },
    ],
  };

  private cachedAvailability: ToolAvailability | null = null;
  private scriptPath: string;

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-apple-vision.py');
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    // macOS only
    if (process.platform !== 'darwin') {
      this.cachedAvailability = {
        available: false,
        error: 'Apple Vision is only available on macOS',
      };
      return this.cachedAvailability;
    }

    // Check if ocrmac is installed
    try {
      const pipCmd = 'pip show ocrmac 2>/dev/null || pip3 show ocrmac 2>/dev/null';
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
        error: 'ocrmac package not found',
        installInstructions: 'Install with: pip install ocrmac Pillow',
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
        channel: 'recognize-batch',
        handler: async (event, ...args) => this.handleRecognizeBatch(event, args[0] as string[], args[1] as number[]),
      },
    ];
  }

  private async handleRecognize(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: AppleVisionOcrResult; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async handleRecognizeBatch(
    _event: IpcMainInvokeEvent,
    images: string[],
    pageNumbers: number[]
  ): Promise<{ success: boolean; data?: AppleVisionPageResult[]; error?: string }> {
    try {
      const results = await this.recognizeBatch(images, pageNumbers);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  private async recognizeImage(imageData: string): Promise<AppleVisionOcrResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Apple Vision OCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-vision-'));
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      inputPath = this.resolveInputPath(imageData, tempDir);
      needsCleanupInput = inputPath.startsWith(tempDir);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      const level = this.getSetting<string>('recognitionLevel') || 'accurate';
      return await this.runAppleVisionOcr(inputPath, level);
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
  ): Promise<AppleVisionPageResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Apple Vision OCR not available');
    }

    const results: AppleVisionPageResult[] = [];
    const level = this.getSetting<string>('recognitionLevel') || 'accurate';

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const pageNum = pageNumbers[i];
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-vision-'));

      try {
        const inputPath = this.resolveInputPath(imageData, tempDir);

        if (!fs.existsSync(inputPath)) {
          console.warn(`[Apple Vision] Input not found for page ${pageNum}, skipping`);
          continue;
        }

        const ocrResult = await this.runAppleVisionOcr(inputPath, level);

        results.push({
          page: pageNum,
          text: ocrResult.text,
          textLines: ocrResult.textLines || [],
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

  private async runAppleVisionOcr(inputPath: string, level: string): Promise<AppleVisionOcrResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--image', inputPath,
        '--level', level,
      ];

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
          reject(new Error(`Apple Vision OCR failed (exit ${code}): ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim()) as AppleVisionOcrResult;
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse Apple Vision output: ${(err as Error).message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Apple Vision OCR: ${err.message}`));
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
