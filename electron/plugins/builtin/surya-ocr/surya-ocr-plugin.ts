/**
 * Surya OCR Plugin
 *
 * Integrates Surya OCR (https://github.com/VikParuchuri/surya) as a subprocess.
 * Surya provides high-quality OCR with layout detection.
 *
 * Install: pip install surya-ocr
 * CLI: surya_ocr <input_path> --output_dir <output_dir>
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

interface SuryaTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
}

// Layout detection categories from surya_layout (actual output format)
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
  bbox: [number, number, number, number]; // [x1, y1, x2, y2]
  polygon: number[][]; // Rotated coordinates
  label: SuryaLayoutLabel;
  confidence: number;
  position: number; // Reading order
  text?: string; // Text content (filled in after OCR)
}

interface SuryaOcrResult {
  text: string;
  confidence: number;
  textLines?: SuryaTextLine[];  // Text lines with bounding boxes
  layoutBlocks?: SuryaLayoutBlock[]; // Semantic layout regions
  pages?: SuryaPageResult[];
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
        key: 'cliPath',
        type: 'path',
        label: 'Surya CLI Path',
        description: 'Path to surya_ocr command (leave empty for auto-detect)',
        default: '',
        placeholder: '/opt/homebrew/bin/surya_ocr',
      },
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

  async checkAvailability(): Promise<ToolAvailability> {
    // Use cached result if available (check once per session)
    if (this.cachedAvailability) {
      return this.cachedAvailability;
    }

    // Find the surya_ocr CLI
    const cliPath = this.findSuryaCli();

    if (!cliPath) {
      this.cachedAvailability = {
        available: false,
        error: 'surya_ocr command not found',
        installInstructions: 'Install with: pip install surya-ocr',
      };
      return this.cachedAvailability;
    }

    // Get version from pip if possible
    let version = 'installed';
    try {
      const pipCmd = process.platform === 'win32' ? 'pip show surya-ocr' : 'pip show surya-ocr 2>/dev/null || pip3 show surya-ocr 2>/dev/null';
      const pipOutput = execSync(pipCmd, { encoding: 'utf-8', timeout: 10000 });
      const versionMatch = pipOutput.match(/Version:\s*(\S+)/);
      if (versionMatch) {
        version = versionMatch[1];
      }
    } catch {
      // Ignore version lookup failure
    }

    this.cachedAvailability = {
      available: true,
      version,
      path: cliPath,
    };

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

  /**
   * OCR a single image
   */
  private async handleRecognize(
    _event: IpcMainInvokeEvent,
    imageData: string // base64 encoded image
  ): Promise<{ success: boolean; data?: SuryaOcrResult; error?: string }> {
    try {
      const result = await this.recognizeImage(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * OCR multiple images with progress reporting
   */
  private async handleRecognizeBatch(
    _event: IpcMainInvokeEvent,
    images: string[], // array of base64 encoded images
    pageNumbers: number[] // corresponding page numbers
  ): Promise<{ success: boolean; data?: SuryaPageResult[]; error?: string }> {
    try {
      const results = await this.recognizeBatch(images, pageNumbers);
      return { success: true, data: results };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * OCR with layout detection - runs both surya_layout and surya_ocr
   */
  private async handleRecognizeWithLayout(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: SuryaOcrResult; error?: string }> {
    try {
      const result = await this.recognizeWithLayout(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Layout detection only - returns semantic regions without OCR
   */
  private async handleDetectLayout(
    _event: IpcMainInvokeEvent,
    imageData: string
  ): Promise<{ success: boolean; data?: SuryaLayoutBlock[]; error?: string }> {
    try {
      const result = await this.detectLayout(imageData);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Recognize text in a single image
   * imageData can be:
   * - base64 data URL (data:image/png;base64,...)
   * - bookforge-page:// URL (bookforge-page:///path/to/file.png)
   * - file path (/path/to/file.png)
   */
  private async recognizeImage(imageData: string): Promise<SuryaOcrResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    // Create temp directory for output
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-'));
    const outputDir = path.join(tempDir, 'output');
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      fs.mkdirSync(outputDir, { recursive: true });

      // Handle different input formats
      if (imageData.startsWith('bookforge-page://')) {
        // Extract file path from custom protocol URL
        inputPath = imageData.replace('bookforge-page://', '');
        if (!inputPath.startsWith('/')) {
          inputPath = '/' + inputPath;
        }
      } else if (imageData.startsWith('file://')) {
        // Extract file path from file:// URL
        inputPath = imageData.replace('file://', '');
      } else if (imageData.startsWith('/') || imageData.match(/^[A-Za-z]:\\/)) {
        // Direct file path (Unix or Windows)
        inputPath = imageData;
      } else if (imageData.startsWith('data:')) {
        // Base64 data URL - write to temp file
        inputPath = path.join(tempDir, 'input.png');
        const imageBuffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(inputPath, imageBuffer);
        needsCleanupInput = true;
      } else {
        // Assume it's raw base64 data
        inputPath = path.join(tempDir, 'input.png');
        const imageBuffer = Buffer.from(imageData, 'base64');
        fs.writeFileSync(inputPath, imageBuffer);
        needsCleanupInput = true;
      }

      // Verify input file exists
      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      // Run Surya OCR
      const result = await this.runSuryaOcr(inputPath, outputDir);
      return result;
    } finally {
      // Cleanup temp files (but not the original input if it wasn't created by us)
      if (needsCleanupInput) {
        this.cleanupTempDir(tempDir);
      } else {
        // Just cleanup output dir
        this.cleanupTempDir(outputDir);
        try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Recognize text in multiple images with progress
   * Images can be file paths, URLs, or base64 data
   */
  private async recognizeBatch(
    images: string[],
    pageNumbers: number[]
  ): Promise<SuryaPageResult[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-batch-'));
    const inputDir = path.join(tempDir, 'input');
    const outputDir = path.join(tempDir, 'output');

    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });

      // Write/copy all images to temp directory
      for (let i = 0; i < images.length; i++) {
        const imageData = images[i];
        const pageNum = pageNumbers[i];
        const destPath = path.join(inputDir, `page_${String(pageNum).padStart(4, '0')}.png`);

        // Handle different input formats
        let sourcePath: string | null = null;

        if (imageData.startsWith('bookforge-page://')) {
          sourcePath = imageData.replace('bookforge-page://', '');
          if (!sourcePath.startsWith('/')) {
            sourcePath = '/' + sourcePath;
          }
        } else if (imageData.startsWith('file://')) {
          sourcePath = imageData.replace('file://', '');
        } else if (imageData.startsWith('/') || imageData.match(/^[A-Za-z]:\\/)) {
          sourcePath = imageData;
        }

        if (sourcePath && fs.existsSync(sourcePath)) {
          // Copy file directly
          fs.copyFileSync(sourcePath, destPath);
        } else {
          // Assume base64 data
          const base64Data = imageData.startsWith('data:')
            ? imageData.replace(/^data:image\/\w+;base64,/, '')
            : imageData;
          const imageBuffer = Buffer.from(base64Data, 'base64');
          fs.writeFileSync(destPath, imageBuffer);
        }
      }

      // Run Surya on the directory
      const results = await this.runSuryaOcrBatch(inputDir, outputDir, images.length);

      // Map results back to page numbers
      return results.map((result, index) => ({
        ...result,
        page: pageNumbers[index],
      }));
    } finally {
      this.cleanupTempDir(tempDir);
    }
  }

  /**
   * OCR with layout detection - runs both surya_layout and surya_ocr
   */
  private async recognizeWithLayout(imageData: string): Promise<SuryaOcrResult> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-layout-'));
    const ocrOutputDir = path.join(tempDir, 'ocr_output');
    const layoutOutputDir = path.join(tempDir, 'layout_output');
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      fs.mkdirSync(ocrOutputDir, { recursive: true });
      fs.mkdirSync(layoutOutputDir, { recursive: true });

      // Resolve input path (same logic as recognizeImage)
      inputPath = this.resolveInputPath(imageData, tempDir);
      needsCleanupInput = inputPath.startsWith(tempDir);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      // Run both layout detection and OCR in parallel
      const [layoutBlocks, ocrResult] = await Promise.all([
        this.runSuryaLayout(inputPath, layoutOutputDir),
        this.runSuryaOcr(inputPath, ocrOutputDir),
      ]);

      // Assign OCR text to layout blocks based on overlap
      const enrichedBlocks = this.assignTextToLayoutBlocks(layoutBlocks, ocrResult.textLines || []);

      return {
        ...ocrResult,
        layoutBlocks: enrichedBlocks,
      };
    } finally {
      if (needsCleanupInput) {
        this.cleanupTempDir(tempDir);
      } else {
        this.cleanupTempDir(ocrOutputDir);
        this.cleanupTempDir(layoutOutputDir);
        try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Layout detection only - returns semantic regions
   */
  private async detectLayout(imageData: string): Promise<SuryaLayoutBlock[]> {
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.error || 'Surya OCR not available');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surya-layout-'));
    const outputDir = path.join(tempDir, 'output');
    let inputPath: string;
    let needsCleanupInput = false;

    try {
      fs.mkdirSync(outputDir, { recursive: true });

      inputPath = this.resolveInputPath(imageData, tempDir);
      needsCleanupInput = inputPath.startsWith(tempDir);

      if (!fs.existsSync(inputPath)) {
        throw new Error(`Input image file not found: ${inputPath}`);
      }

      return await this.runSuryaLayout(inputPath, outputDir);
    } finally {
      if (needsCleanupInput) {
        this.cleanupTempDir(tempDir);
      } else {
        this.cleanupTempDir(outputDir);
        try { fs.rmdirSync(tempDir); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Resolve input path from various formats (base64, file://, bookforge-page://, etc.)
   */
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

  /**
   * Run surya_layout to detect semantic regions
   */
  private async runSuryaLayout(inputPath: string, outputDir: string): Promise<SuryaLayoutBlock[]> {
    const layoutPath = this.findSuryaLayoutCli();
    if (!layoutPath) {
      console.warn('[Surya] surya_layout CLI not found, skipping layout detection');
      return [];
    }

    return new Promise((resolve, reject) => {
      const args = [inputPath, '--output_dir', outputDir];

      const proc = spawn(layoutPath, args, {
        env: { ...process.env },
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr = appendCapped(stderr, data.toString());
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.warn(`[Surya] Layout detection failed: ${stderr}`);
          resolve([]); // Don't fail the whole operation
          return;
        }

        try {
          const blocks = this.parseLayoutOutput(outputDir);
          resolve(blocks);
        } catch (err) {
          console.warn('[Surya] Failed to parse layout output:', err);
          resolve([]);
        }
      });

      proc.on('error', (err) => {
        console.warn(`[Surya] Failed to start surya_layout: ${err.message}`);
        resolve([]);
      });
    });
  }

  /**
   * Parse surya_layout output JSON
   */
  private parseLayoutOutput(outputDir: string): SuryaLayoutBlock[] {
    // Find results.json (may be in subdirectory)
    let resultsPath = path.join(outputDir, 'results.json');

    if (!fs.existsSync(resultsPath)) {
      const items = fs.readdirSync(outputDir);
      for (const item of items) {
        const itemPath = path.join(outputDir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          const subResultsPath = path.join(itemPath, 'results.json');
          if (fs.existsSync(subResultsPath)) {
            resultsPath = subResultsPath;
            break;
          }
        }
      }
    }

    if (!fs.existsSync(resultsPath)) {
      return [];
    }

    const content = fs.readFileSync(resultsPath, 'utf-8');
    const data = JSON.parse(content);
    const blocks: SuryaLayoutBlock[] = [];

    // Handle different output formats
    const processPageData = (pageData: any) => {
      if (!pageData?.bboxes) return;

      for (const box of pageData.bboxes) {
        blocks.push({
          bbox: box.bbox as [number, number, number, number],
          polygon: box.polygon || [],
          label: box.label as SuryaLayoutLabel,
          confidence: box.confidence || 0.9,
          position: box.position || blocks.length,
        });
      }
    };

    if (Array.isArray(data)) {
      // Array of pages
      for (const page of data) {
        processPageData(page);
      }
    } else if (typeof data === 'object') {
      // Keyed by filename
      for (const [, pageDataRaw] of Object.entries(data)) {
        const pageArray = Array.isArray(pageDataRaw) ? pageDataRaw : [pageDataRaw];
        for (const page of pageArray) {
          processPageData(page);
        }
      }
    }

    // Sort by reading order
    blocks.sort((a, b) => a.position - b.position);

    return blocks;
  }

  /**
   * Assign OCR text to layout blocks based on bounding box overlap
   */
  private assignTextToLayoutBlocks(
    layoutBlocks: SuryaLayoutBlock[],
    textLines: SuryaTextLine[]
  ): SuryaLayoutBlock[] {
    if (layoutBlocks.length === 0 || textLines.length === 0) {
      return layoutBlocks;
    }

    return layoutBlocks.map(block => {
      // Find text lines that overlap with this layout block
      const overlappingLines = textLines.filter(line => {
        return this.boxesOverlap(block.bbox, line.bbox);
      });

      // Sort by vertical position then horizontal
      overlappingLines.sort((a, b) => {
        const yDiff = a.bbox[1] - b.bbox[1];
        if (Math.abs(yDiff) > 5) return yDiff;
        return a.bbox[0] - b.bbox[0];
      });

      const text = overlappingLines.map(l => l.text).join('\n');

      return {
        ...block,
        text: text || undefined,
      };
    });
  }

  /**
   * Check if two bounding boxes overlap
   */
  private boxesOverlap(
    a: [number, number, number, number],
    b: [number, number, number, number]
  ): boolean {
    // Check if boxes overlap (with some tolerance)
    const tolerance = 5;
    return !(
      a[2] < b[0] - tolerance ||  // a is left of b
      a[0] > b[2] + tolerance ||  // a is right of b
      a[3] < b[1] - tolerance ||  // a is above b
      a[1] > b[3] + tolerance     // a is below b
    );
  }

  /**
   * Find surya_layout CLI executable
   */
  private findSuryaLayoutCli(): string | null {
    const candidates =
      process.platform === 'win32'
        ? [
            'surya_layout',
            'surya_layout.exe',
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\Scripts\\surya_layout.exe`,
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\Scripts\\surya_layout.exe`,
          ]
        : [
            'surya_layout',
            '/opt/homebrew/bin/surya_layout',
            '/usr/local/bin/surya_layout',
            '/usr/bin/surya_layout',
            `${process.env.HOME}/.local/bin/surya_layout`,
            `${process.env.HOME}/Library/Python/3.11/bin/surya_layout`,
            `${process.env.HOME}/Library/Python/3.12/bin/surya_layout`,
          ];

    for (const candidate of candidates) {
      try {
        execSync(`"${candidate}" --help`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        return candidate;
      } catch {
        continue;
      }
    }

    // Try using 'which' or 'where'
    try {
      const whichCmd = process.platform === 'win32' ? 'where surya_layout' : 'which surya_layout';
      const result = execSync(whichCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) {
        return result.split('\n')[0];
      }
    } catch {
      // Not found
    }

    return null;
  }

  /**
   * Run Surya OCR on a single image
   */
  private async runSuryaOcr(inputPath: string, outputDir: string): Promise<SuryaOcrResult> {
    // Use surya_ocr CLI directly (more reliable than python -m)
    const suryaPath = this.findSuryaCli();
    if (!suryaPath) {
      throw new Error('surya_ocr CLI not found');
    }

    return new Promise((resolve, reject) => {
      const args = [
        inputPath,
        '--output_dir', outputDir,
      ];

      const proc = spawn(suryaPath, args, {
        env: { ...process.env },
      });

      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr = appendCapped(stderr, data.toString());
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Surya OCR failed: ${stderr}`));
          return;
        }

        // Parse output JSON
        try {
          const result = this.parseOcrOutput(outputDir);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Surya: ${err.message}`));
      });
    });
  }

  /**
   * Run Surya OCR on a batch of images
   */
  private async runSuryaOcrBatch(
    inputDir: string,
    outputDir: string,
    totalImages: number
  ): Promise<SuryaPageResult[]> {
    const suryaPath = this.findSuryaCli();
    if (!suryaPath) {
      throw new Error('surya_ocr CLI not found');
    }

    return new Promise((resolve, reject) => {
      const args = [
        inputDir,
        '--output_dir', outputDir,
      ];

      const proc = spawn(suryaPath, args, {
        env: { ...process.env },
      });

      let stderr = '';
      let processedCount = 0;

      proc.stderr.on('data', (data) => {
        const output = data.toString();
        stderr = appendCapped(stderr, output);

        // Parse progress from tqdm output (e.g., "Recognizing: 50%|████")
        const progressMatch = output.match(/(\d+)%\|/);
        if (progressMatch) {
          const percentage = parseInt(progressMatch[1], 10);
          processedCount = Math.floor((percentage / 100) * totalImages);

          const progress: PluginProgress = {
            pluginId: this.manifest.id,
            operation: 'recognize-batch',
            current: processedCount,
            total: totalImages,
            percentage,
            message: `Processing page ${processedCount} of ${totalImages}`,
          };

          getPluginRegistry().emitProgress(progress);
        }
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Surya OCR batch failed: ${stderr}`));
          return;
        }

        try {
          const results = this.parseBatchOutput(outputDir);
          resolve(results);
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to start Surya: ${err.message}`));
      });
    });
  }

  /**
   * Parse Surya OCR output JSON
   * Surya creates a subdirectory named after the input file (without extension)
   * and puts results.json inside that subdirectory
   */
  private parseOcrOutput(outputDir: string): SuryaOcrResult {
    // First, look for results.json directly in output dir
    let resultsPath = path.join(outputDir, 'results.json');

    if (!fs.existsSync(resultsPath)) {
      // Surya creates a subdirectory named after the input file
      // Look for subdirectories containing results.json
      const items = fs.readdirSync(outputDir);
      for (const item of items) {
        const itemPath = path.join(outputDir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          const subResultsPath = path.join(itemPath, 'results.json');
          if (fs.existsSync(subResultsPath)) {
            resultsPath = subResultsPath;
            break;
          }
        }
      }
    }

    if (!fs.existsSync(resultsPath)) {
      // Last resort: find any JSON file recursively
      const findJson = (dir: string): string | null => {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            const found = findJson(itemPath);
            if (found) return found;
          } else if (item.endsWith('.json')) {
            return itemPath;
          }
        }
        return null;
      };
      const found = findJson(outputDir);
      if (found) {
        resultsPath = found;
      } else {
        throw new Error('No OCR results found');
      }
    }

    return this.parseResultsJson(resultsPath);
  }

  /**
   * Parse batch OCR output
   * Surya creates a subdirectory named after the input directory
   */
  private parseBatchOutput(outputDir: string): SuryaPageResult[] {
    let resultsPath = path.join(outputDir, 'results.json');

    if (!fs.existsSync(resultsPath)) {
      // Look for results.json in subdirectories
      const items = fs.readdirSync(outputDir);
      for (const item of items) {
        const itemPath = path.join(outputDir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          const subResultsPath = path.join(itemPath, 'results.json');
          if (fs.existsSync(subResultsPath)) {
            resultsPath = subResultsPath;
            break;
          }
        }
      }
    }

    if (!fs.existsSync(resultsPath)) {
      throw new Error('No batch OCR results found');
    }

    const content = fs.readFileSync(resultsPath, 'utf-8');
    const data = JSON.parse(content);

    // Surya outputs an object with filename keys, values are arrays of page objects
    const results: SuryaPageResult[] = [];

    for (const [filename, pageDataRaw] of Object.entries(data)) {
      // Extract page number from filename (page_0001.png -> 1)
      const pageMatch = filename.match(/page_(\d+)/);
      const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 0;

      // pageDataRaw is an array of page objects
      const pageArray = Array.isArray(pageDataRaw) ? pageDataRaw : [pageDataRaw];

      for (const page of pageArray) {
        const textLines: SuryaTextLine[] = (page.text_lines || []).map((line: { text: string; confidence: number; bbox: number[] }) => ({
          text: line.text,
          confidence: line.confidence,
          bbox: line.bbox as [number, number, number, number],
        }));

        results.push({
          page: pageNum,
          text: textLines.map(l => l.text).join('\n'),
          textLines,
        });
      }
    }

    // Sort by page number
    results.sort((a, b) => a.page - b.page);

    return results;
  }

  /**
   * Parse a single results JSON file
   */
  private parseResultsJson(filePath: string): SuryaOcrResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // Collect all text lines from the results
    const allTextLines: SuryaTextLine[] = [];

    // Handle different Surya output formats
    if (Array.isArray(data)) {
      // Array of pages directly
      for (const page of data) {
        if (page.text_lines) {
          for (const line of page.text_lines) {
            allTextLines.push({
              text: line.text,
              confidence: line.confidence || 0.9,
              bbox: line.bbox as [number, number, number, number],
            });
          }
        }
      }
    } else if (typeof data === 'object') {
      // Keyed by filename, e.g. {"page-0": [{text_lines: [...]}]}
      const firstKey = Object.keys(data)[0];
      if (firstKey) {
        const pageData = data[firstKey];

        // pageData is an array of page objects
        if (Array.isArray(pageData)) {
          for (const page of pageData) {
            if (page.text_lines) {
              for (const line of page.text_lines) {
                allTextLines.push({
                  text: line.text,
                  confidence: line.confidence || 0.9,
                  bbox: line.bbox as [number, number, number, number],
                });
              }
            }
          }
        } else if (pageData?.text_lines) {
          // Or pageData might be an object with text_lines directly (older format)
          for (const line of pageData.text_lines) {
            allTextLines.push({
              text: line.text,
              confidence: line.confidence || 0.9,
              bbox: line.bbox as [number, number, number, number],
            });
          }
        }
      }
    }

    // Empty result is valid - page may have no text
    return {
      text: allTextLines.map(l => l.text).join('\n'),
      confidence: allTextLines.length > 0 ? 0.9 : 1.0,
      textLines: allTextLines,
    };
  }

  /**
   * Find surya_ocr CLI executable
   */
  private findSuryaCli(): string | null {
    // Check user-configured path first
    const configuredPath = this.getSetting<string>('cliPath');
    if (configuredPath) {
      try {
        execSync(`"${configuredPath}" --help`, { encoding: 'utf-8', timeout: 5000 });
        return configuredPath;
      } catch {
        // Configured path doesn't work, try auto-detect
      }
    }

    // Auto-detect common locations
    const candidates =
      process.platform === 'win32'
        ? [
            'surya_ocr',
            'surya_ocr.exe',
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\Scripts\\surya_ocr.exe`,
            `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\Scripts\\surya_ocr.exe`,
          ]
        : [
            'surya_ocr',
            '/opt/homebrew/bin/surya_ocr',
            '/usr/local/bin/surya_ocr',
            '/usr/bin/surya_ocr',
            `${process.env.HOME}/.local/bin/surya_ocr`,
            `${process.env.HOME}/Library/Python/3.11/bin/surya_ocr`,
            `${process.env.HOME}/Library/Python/3.12/bin/surya_ocr`,
          ];

    for (const candidate of candidates) {
      try {
        execSync(`"${candidate}" --help`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        return candidate;
      } catch {
        continue;
      }
    }

    // Try using 'which' or 'where' to find it
    try {
      const whichCmd = process.platform === 'win32' ? 'where surya_ocr' : 'which surya_ocr';
      const result = execSync(whichCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) {
        return result.split('\n')[0]; // Take first result on Windows
      }
    } catch {
      // Not found via which/where
    }

    return null;
  }

  /**
   * Clean up temp directory
   */
  private cleanupTempDir(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
