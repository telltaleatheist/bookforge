/**
 * Surya OCR Plugin
 *
 * Integrates Surya OCR (https://github.com/VikParuchuri/surya) via a
 * persistent Python subprocess. Models are loaded once at startup (~30s),
 * then each page takes ~2s instead of reloading models every time.
 *
 * Install: pip install surya-ocr
 */

import { spawn, exec, ChildProcess } from 'child_process';
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

interface SuryaTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
}

// Layout detection categories from surya_layout
export type SuryaLayoutLabel =
  | 'Caption'
  | 'Footnote'
  | 'Formula'
  | 'ListItem'
  | 'PageFooter'
  | 'PageHeader'
  | 'Picture'
  | 'Figure'
  | 'SectionHeader'
  | 'Table'
  | 'Form'
  | 'TableOfContents'
  | 'Handwriting'
  | 'Text'
  | 'TextInlineMath'
  | 'Title';

interface SuryaLayoutBlock {
  bbox: [number, number, number, number];
  polygon: number[][];
  label: SuryaLayoutLabel;
  confidence: number;
  position: number;
  text?: string;
}

interface SuryaOcrResult {
  text: string;
  confidence: number;
  textLines?: SuryaTextLine[];
  layoutBlocks?: SuryaLayoutBlock[];
  error?: string;
}

interface SuryaPageResult {
  page: number;
  text: string;
  textLines: SuryaTextLine[];
  layoutBlocks?: SuryaLayoutBlock[];
}

export class SuryaOcrPlugin extends BasePlugin {
  readonly manifest: PluginManifest = {
    id: 'surya-ocr',
    name: 'Surya OCR',
    version: '1.0.0',
    description: 'High-quality OCR with layout detection using Surya',
    capabilities: ['ocr'],
    settingsSchema: [
      {
        key: 'languages',
        type: 'string',
        label: 'Languages',
        description: 'Comma-separated language codes (e.g., en,fr,de)',
        default: 'en',
      },
    ],
  };

  private cachedAvailability: ToolAvailability | null = null;
  private scriptPath: string;
  private venvPython: string | null = null;

  // Persistent batch worker
  private worker: ChildProcess | null = null;
  private workerReader: readline.Interface | null = null;
  private workerReady = false;
  private workerStarted = false;
  private pendingResolve: ((result: SuryaOcrResult) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly IDLE_TIMEOUT_MS = 120_000; // 2 min idle (Surya models are large)

  constructor() {
    super();
    this.scriptPath = path.join(__dirname, 'ocr-surya.py');
  }

  async dispose(): Promise<void> {
    this.killWorker();
  }

  async checkAvailability(): Promise<ToolAvailability> {
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    // Find the venv Python first
    this.venvPython = this.findVenvPython();

    try {
      let pipCmd: string;
      if (this.venvPython) {
        pipCmd = `"${this.venvPython}" -m pip show surya-ocr`;
      } else if (process.platform === 'win32') {
        pipCmd = 'pip show surya-ocr';
      } else {
        pipCmd = 'pip show surya-ocr 2>/dev/null || pip3 show surya-ocr 2>/dev/null';
      }
      const pipOutput = await this.execAsync(pipCmd, 10000);
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
        error: 'surya-ocr package not found',
        installInstructions: 'Install with: pip install surya-ocr',
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
  ): Promise<{ success: boolean; data?: SuryaOcrResult; error?: string }> {
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
  ): Promise<{ success: boolean; data?: SuryaOcrResult; error?: string }> {
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
  ): Promise<{ success: boolean; data?: SuryaPageResult[]; error?: string }> {
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
  ): Promise<{ success: boolean; data?: SuryaLayoutBlock[]; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData, true);
      return { success: true, data: result.layoutBlocks || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // ─── Worker Management ─────────────────────────────────────────────────────

  private ensureWorker(): Promise<void> {
    // Reuse existing worker if alive
    if (this.worker && !this.worker.killed && this.workerReady && this.workerStarted) {
      this.resetIdleTimer();
      return Promise.resolve();
    }

    // Kill existing worker if dead/broken
    if (this.worker) {
      this.killWorker();
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const pythonCmd = this.venvPython || (process.platform === 'win32' ? 'python' : 'python3');
      const args = [
        this.scriptPath,
        '--batch',
        '--layout',  // Always load layout model — avoids worker restarts
      ];

      const proc = spawn(pythonCmd, args, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.worker = proc;
      this.workerStarted = false;
      this.workerReady = false;

      let stderr = '';
      proc.stderr!.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > 10 * 1024) stderr = stderr.slice(-10 * 1024);
      });

      const rl = readline.createInterface({ input: proc.stdout!, terminal: false });
      this.workerReader = rl;

      // Wait for the {"ready": true} signal
      const onFirstLine = (line: string) => {
        try {
          const msg = JSON.parse(line);
          if (msg.ready) {
            this.workerReady = true;
            this.workerStarted = true;
            settled = true;
            rl.removeListener('line', onFirstLine);
            rl.on('line', (resultLine) => this.onWorkerLine(resultLine));
            this.resetIdleTimer();
            resolve();
            return;
          }
        } catch { /* ignore */ }
        settled = true;
        this.killWorker();
        reject(new Error(`Surya worker failed to start: ${stderr || line}`));
      };

      rl.on('line', onFirstLine);

      proc.on('error', (err) => {
        this.workerReady = false;
        if (!settled) { settled = true; reject(new Error(`Failed to start Surya worker: ${err.message}`)); }
      });

      proc.on('close', (code) => {
        console.log(`[Surya] Worker exited (code ${code})`);
        this.workerReady = false;
        this.worker = null;
        this.workerReader = null;
        // Reject startup promise if still pending
        if (!settled) { settled = true; reject(new Error(`Surya worker exited during startup (code ${code}): ${stderr}`)); }
        // Reject in-flight sendToWorker request
        if (this.pendingReject) {
          this.pendingReject(new Error(`Surya worker exited (code ${code}): ${stderr}`));
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      });
    });
  }

  private sendToWorker(imagePath: string): Promise<SuryaOcrResult> {
    return new Promise((resolve, reject) => {
      if (!this.worker || !this.workerReady) {
        reject(new Error('Surya worker not ready'));
        return;
      }

      if (this.pendingResolve) {
        reject(new Error('Surya worker is busy'));
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
      const result = JSON.parse(line) as SuryaOcrResult;
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
      console.log('[Surya] Killing idle worker');
      this.killWorker();
    }, SuryaOcrPlugin.IDLE_TIMEOUT_MS);
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
    this.workerStarted = false;
    this.pendingResolve = null;
    this.pendingReject = null;
  }

  // ─── OCR Methods ───────────────────────────────────────────────────────────

  private async recognizeImage(imageData: string, _withLayout?: boolean): Promise<SuryaOcrResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-'));
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      inputPath = this.resolveInputPath(imageData, tempDir);
      needsCleanupInput = inputPath.startsWith(tempDir);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      await this.ensureWorker();
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
  ): Promise<SuryaPageResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    const results: SuryaPageResult[] = [];

    await this.ensureWorker();

    for (let i = 0; i < images.length; i++) {
      const imageData = images[i];
      const pageNum = pageNumbers[i];
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-'));

      try {
        const inputPath = this.resolveInputPath(imageData, tempDir);

        if (!fs.existsSync(inputPath)) {
          console.warn(`[Surya] Input not found for page ${pageNum}, skipping`);
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

  /**
   * Find the dedicated Surya venv Python.
   * Surya 0.15+ requires torch >= 2.7.0 which conflicts with Orpheus/vLLM
   * (needs torch 2.5.1+cu121), so we use a dedicated venv at ~/.surya-venv.
   */
  private findVenvPython(): string | null {
    const homeDir = os.homedir();
    const venvName = '.surya-venv';

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

  private cleanupTempDir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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
