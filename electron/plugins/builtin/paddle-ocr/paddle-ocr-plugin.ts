/**
 * PaddleOCR Plugin
 *
 * Cross-platform OCR using PaddlePaddle's PaddleOCR.
 * Supports text recognition and layout detection via PP-DocLayout.
 *
 * Performance: Uses a persistent Python subprocess in batch mode so that
 * heavy imports (paddleocr, paddlepaddle, model loading) only happen once.
 *
 * Install: pip install paddleocr paddlepaddle
 */

import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
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

/**
 * Key for a worker: version + language + layout flag.
 * If settings change, we kill the old worker and spawn a new one.
 */
interface WorkerKey {
  ocrVersion: string;
  language: string;
  withLayout: boolean;
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

  // Persistent batch worker
  private worker: ChildProcess | null = null;
  private workerReader: readline.Interface | null = null;
  private workerReady = false;
  private workerKey: WorkerKey | null = null;
  private pendingResolve: ((result: PaddleOcrResult) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_TIMEOUT_MS = 60_000; // Kill worker after 60s idle (PaddleOCR is heavier)

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-paddleocr.py');
  }

  async dispose(): Promise<void> {
    this.killWorker();
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

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
      const result = await this.recognizeImage(imageData, true);
      return { success: true, data: result.layoutBlocks || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Worker Management ─────────────────────────────────────────────────────

  private ensureWorker(key: WorkerKey): Promise<void> {
    // Reuse existing worker if key matches
    if (this.worker && !this.worker.killed && this.workerReady && this.workerKeyMatches(key)) {
      this.resetIdleTimer();
      return Promise.resolve();
    }

    // Kill existing worker if settings changed
    if (this.worker) {
      this.killWorker();
    }

    return new Promise((resolve, reject) => {
      const args = [
        this.scriptPath,
        '--batch',
        '--version', key.ocrVersion,
        '--language', key.language,
      ];
      if (key.withLayout) {
        args.push('--layout');
      }

      const proc = spawn('python3', args, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.worker = proc;
      this.workerKey = { ...key };
      this.workerReady = false;

      let stderr = '';
      proc.stderr!.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024) stderr = stderr.slice(-10 * 1024);
      });

      const rl = readline.createInterface({ input: proc.stdout!, terminal: false });
      this.workerReader = rl;

      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            this.workerReady = true;
            rl.removeListener('line', onFirstLine);
            rl.on('line', (resultLine) => this.onWorkerLine(resultLine));
            this.resetIdleTimer();
            resolve();
            return;
          }
        } catch { /* ignore */ }
        this.killWorker();
        reject(new Error(`PaddleOCR worker failed to start: ${stderr || line}`));
      };

      rl.on('line', onFirstLine);

      proc.on('error', (err) => {
        this.workerReady = false;
        reject(new Error(`Failed to start PaddleOCR worker: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.workerReady = false;
        this.worker = null;
        this.workerReader = null;
        if (this.pendingReject) {
          this.pendingReject(new Error(`PaddleOCR worker exited (code ${code}): ${stderr}`));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });
    });
  }

  private workerKeyMatches(key: WorkerKey): boolean {
    if (!this.workerKey) return false;
    return (
      this.workerKey.ocrVersion === key.ocrVersion &&
      this.workerKey.language === key.language &&
      this.workerKey.withLayout === key.withLayout
    );
  }

  private sendToWorker(imagePath: string): Promise<PaddleOcrResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.workerReady) {
        reject(new Error('PaddleOCR worker not ready'));
        return;
      }

      if (this.pendingResolve) {
        reject(new Error('PaddleOCR worker is busy'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.worker.stdin!.write(imagePath + '\n');
    });
  }

  private onWorkerLine(line: string): void {
    if (!this.pendingResolve) return;

    const resolve = this.pendingResolve;
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;

    try {
      const result = JSON.parse(line) as PaddleOcrResult;
      if (result.error) {
        reject?.(new Error(result.error));
      } else {
        resolve(result);
      }
    } catch (err) {
      reject?.(new Error(`Failed to parse worker output: ${line}`));
    }

    this.resetIdleTimer();
  }

  private resetIdleTimer(): void {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
    }
    this.workerIdleTimer = setTimeout(() => {
      console.log('[PaddleOCR] Killing idle worker');
      this.killWorker();
    }, PaddleOcrPlugin.IDLE_TIMEOUT_MS);
  }

  private killWorker(): void {
    if (this.workerIdleTimer) {
      clearTimeout(this.workerIdleTimer);
      this.workerIdleTimer = null;
    }
    if (this.workerReader) {
      this.workerReader.close();
      this.workerReader = null;
    }
    if (this.worker && !this.worker.killed) {
      this.worker.stdin!.end();
      this.worker.kill();
    }
    this.worker = null;
    this.workerReady = false;
    this.workerKey = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  // ─── OCR Methods ───────────────────────────────────────────────────────────

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

      await this.ensureWorker({ ocrVersion, language, withLayout });
      return await this.sendToWorker(inputPath);
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

    await this.ensureWorker({ ocrVersion, language, withLayout: false });

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

        const ocrResult = await this.sendToWorker(inputPath);

        results.push({
          page: pageNum,
          text: ocrResult.text,
          textLines: ocrResult.textLines || [],
          layoutBlocks: ocrResult.layoutBlocks,
        });

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
