/**
 * Apple Vision OCR Plugin
 *
 * Uses Apple's VNRecognizeTextRequest via the ocrmac Python package.
 * macOS only - returns unavailable on other platforms.
 *
 * Performance: Uses a persistent Python subprocess in batch mode so that
 * heavy imports (ocrmac, PyObjC, Pillow) only happen once. Each OCR call
 * sends an image path via stdin and reads a JSON result from stdout.
 *
 * Install: pip install ocrmac Pillow
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

interface AppleVisionTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
}

interface AppleVisionOcrResult {
  text: string;
  confidence: number;
  textLines?: AppleVisionTextLine[];
  error?: string;
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

  // Persistent batch worker
  private worker: ChildProcess | null = null;
  private workerReader: readline.Interface | null = null;
  private workerReady = false;
  private workerLevel: string | null = null;
  private pendingResolve: ((result: AppleVisionOcrResult) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_TIMEOUT_MS = 30_000; // Kill worker after 30s idle

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-apple-vision.py');
  }

  async dispose(): Promise<void> {
    this.killWorker();
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

  // ─── Worker Management ─────────────────────────────────────────────────────

  /**
   * Ensure the persistent batch worker is running and ready.
   * Spawns python3 in --batch mode; waits for the {"ready": true} signal.
   */
  private ensureWorker(level: string): Promise<void> {
    // If worker exists with the same level, just reset idle timer
    if (this.worker && !this.worker.killed && this.workerReady && this.workerLevel === level) {
      this.resetIdleTimer();
      return Promise.resolve();
    }

    // Kill existing worker if level changed
    if (this.worker) {
      this.killWorker();
    }

    return new Promise((resolve, reject) => {
      const proc = spawn('python3', [
        this.scriptPath,
        '--batch',
        '--level', level,
      ], {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.worker = proc;
      this.workerLevel = level;
      this.workerReady = false;

      let stderr = '';
      proc.stderr!.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024) stderr = stderr.slice(-10 * 1024);
      });

      const rl = readline.createInterface({ input: proc.stdout!, terminal: false });
      this.workerReader = rl;

      // First line should be {"ready": true}
      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            this.workerReady = true;
            // Switch to normal line handler
            rl.removeListener('line', onFirstLine);
            rl.on('line', (resultLine) => this.onWorkerLine(resultLine));
            this.resetIdleTimer();
            resolve();
            return;
          }
        } catch { /* ignore parse errors */ }
        // If first line isn't ready signal, treat as error
        this.killWorker();
        reject(new Error(`Apple Vision worker failed to start: ${stderr || line}`));
      };

      rl.on('line', onFirstLine);

      proc.on('error', (err) => {
        this.workerReady = false;
        reject(new Error(`Failed to start Apple Vision worker: ${err.message}`));
      });

      proc.on('close', (code) => {
        this.workerReady = false;
        this.worker = null;
        this.workerReader = null;
        // Reject pending request if worker dies unexpectedly
        if (this.pendingReject) {
          this.pendingReject(new Error(`Apple Vision worker exited (code ${code}): ${stderr}`));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });
    });
  }

  /**
   * Send an image path to the worker and wait for the JSON result.
   */
  private sendToWorker(imagePath: string): Promise<AppleVisionOcrResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.workerReady) {
        reject(new Error('Apple Vision worker not ready'));
        return;
      }

      // Only one request at a time (sequential processing)
      if (this.pendingResolve) {
        reject(new Error('Apple Vision worker is busy'));
        return;
      }

      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.worker.stdin!.write(imagePath + '\n');
    });
  }

  /**
   * Handle a line of JSON output from the worker.
   */
  private onWorkerLine(line: string): void {
    if (!this.pendingResolve) return;

    const resolve = this.pendingResolve;
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;

    try {
      const result = JSON.parse(line) as AppleVisionOcrResult;
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
      console.log('[Apple Vision] Killing idle worker');
      this.killWorker();
    }, AppleVisionOcrPlugin.IDLE_TIMEOUT_MS);
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
    this.workerLevel = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  // ─── OCR Methods ───────────────────────────────────────────────────────────

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

      // Use persistent worker
      await this.ensureWorker(level);
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
  ): Promise<AppleVisionPageResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Apple Vision OCR not available');
    }

    const results: AppleVisionPageResult[] = [];
    const level = this.getSetting<string>('recognitionLevel') || 'accurate';

    // Ensure worker is up before loop
    await this.ensureWorker(level);

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

        const ocrResult = await this.sendToWorker(inputPath);

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
