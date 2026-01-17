import tesseract from 'node-tesseract-ocr';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
}

export interface OcrParagraph {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
  lineCount: number;
  blockNum: number;  // Tesseract block number
  parNum: number;    // Paragraph number within block
}

export interface OcrResult {
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];  // Individual lines with bounding boxes
  paragraphs?: OcrParagraph[];  // Paragraphs grouped by Tesseract's layout analysis
}

export interface DeskewResult {
  angle: number;  // Rotation angle in degrees (negative = clockwise correction needed)
  confidence: number;
}

export interface OcrServiceConfig {
  lang?: string;  // Language code (default: 'eng')
  tesseractPath?: string;  // Path to tesseract binary (auto-detected if not provided)
}

/**
 * OCR Service - Provides OCR and deskew detection using Tesseract
 */
export class OcrService {
  private config: tesseract.Config;

  constructor(options: OcrServiceConfig = {}) {
    this.config = {
      lang: options.lang || 'eng',
      oem: 1,  // LSTM OCR Engine
      psm: 3,  // Fully automatic page segmentation
    };

    // Set tesseract path if provided or try to find it
    if (options.tesseractPath) {
      this.config.binary = options.tesseractPath;
    } else {
      // Try common locations
      const possiblePaths = [
        '/opt/homebrew/bin/tesseract',  // macOS ARM
        '/usr/local/bin/tesseract',      // macOS Intel
        '/usr/bin/tesseract',            // Linux
        'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',  // Windows
      ];

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.config.binary = p;
          break;
        }
      }
    }
  }

  /**
   * Perform OCR on an image file (plain text only)
   */
  async recognizeFile(imagePath: string): Promise<OcrResult> {
    try {
      const text = await tesseract.recognize(imagePath, this.config);
      return {
        text: text.trim(),
        confidence: 0  // node-tesseract-ocr doesn't return confidence directly
      };
    } catch (err) {
      console.error('OCR failed:', err);
      throw new Error(`OCR failed: ${(err as Error).message}`);
    }
  }

  /**
   * Perform OCR on an image file with bounding boxes
   * Uses Tesseract's TSV output format to get line-level positions
   */
  async recognizeFileWithBounds(imagePath: string): Promise<OcrResult> {
    const { execSync } = require('child_process');
    const binary = this.config.binary || 'tesseract';
    const lang = this.config.lang || 'eng';

    try {
      // Run tesseract with TSV output to get bounding boxes
      // TSV columns: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
      const cmd = `"${binary}" "${imagePath}" stdout -l ${lang} --oem 1 --psm 3 tsv`;
      console.log('[OCR] Running:', cmd);

      const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

      console.log('[OCR] TSV output lines:', output.split('\n').length);
      console.log('[OCR] First 500 chars:', output.substring(0, 500));

      const result = this.parseTsvOutput(output);
      console.log('[OCR] Parsed result - textLines:', result.textLines?.length, 'text length:', result.text.length);

      return result;
    } catch (err) {
      console.error('OCR with bounds failed:', err);
      throw new Error(`OCR failed: ${(err as Error).message}`);
    }
  }

  /**
   * Parse Tesseract TSV output into text lines AND paragraphs with bounding boxes.
   * Uses Tesseract's native layout analysis (block_num, par_num) for paragraph grouping.
   */
  private parseTsvOutput(tsvOutput: string): OcrResult {
    const lines = tsvOutput.split('\n');
    if (lines.length < 2) {
      return { text: '', confidence: 0, textLines: [], paragraphs: [] };
    }

    // Skip header line
    const dataLines = lines.slice(1).filter(line => line.trim());

    // Group words by line AND by paragraph
    // lineKey groups words into lines, parKey groups lines into paragraphs
    interface WordData { text: string; conf: number; left: number; top: number; width: number; height: number }
    interface LineData { words: WordData[]; lineNum: string }

    const lineMap = new Map<string, LineData>();
    const parMap = new Map<string, { lines: Map<string, LineData>; blockNum: number; parNum: number }>();

    for (const line of dataLines) {
      const cols = line.split('\t');
      if (cols.length < 12) continue;

      const level = parseInt(cols[0], 10);
      const pageNum = cols[1];
      const blockNum = parseInt(cols[2], 10);
      const parNum = parseInt(cols[3], 10);
      const lineNum = cols[4];
      const left = parseInt(cols[6], 10);
      const top = parseInt(cols[7], 10);
      const width = parseInt(cols[8], 10);
      const height = parseInt(cols[9], 10);
      const conf = parseInt(cols[10], 10);
      const text = cols[11] || '';

      // Only process word-level entries (level 5) with actual text
      if (level !== 5 || !text.trim()) continue;

      const lineKey = `${pageNum}_${blockNum}_${parNum}_${lineNum}`;
      const parKey = `${pageNum}_${blockNum}_${parNum}`;

      // Initialize paragraph entry if needed
      if (!parMap.has(parKey)) {
        parMap.set(parKey, { lines: new Map(), blockNum, parNum });
      }

      // Initialize line entry if needed (both in lineMap and parMap)
      if (!lineMap.has(lineKey)) {
        const lineData: LineData = { words: [], lineNum };
        lineMap.set(lineKey, lineData);
        parMap.get(parKey)!.lines.set(lineKey, lineData);
      }

      lineMap.get(lineKey)!.words.push({ text, conf, left, top, width, height });
    }

    // Build text lines from grouped words
    const textLines: OcrTextLine[] = [];
    let fullText = '';
    let totalConf = 0;

    // Sort lines by their position (top coordinate) to maintain reading order
    const sortedLineKeys = Array.from(lineMap.keys()).sort((a, b) => {
      const aLine = lineMap.get(a)!;
      const bLine = lineMap.get(b)!;
      const aTop = Math.min(...aLine.words.map(w => w.top));
      const bTop = Math.min(...bLine.words.map(w => w.top));
      return aTop - bTop;
    });

    for (const lineKey of sortedLineKeys) {
      const lineData = lineMap.get(lineKey)!;
      if (lineData.words.length === 0) continue;

      // Calculate bounding box for the entire line
      let minLeft = Infinity;
      let minTop = Infinity;
      let maxRight = 0;
      let maxBottom = 0;
      let lineText = '';
      let lineConfSum = 0;

      // Sort words by left position
      lineData.words.sort((a, b) => a.left - b.left);

      for (const word of lineData.words) {
        minLeft = Math.min(minLeft, word.left);
        minTop = Math.min(minTop, word.top);
        maxRight = Math.max(maxRight, word.left + word.width);
        maxBottom = Math.max(maxBottom, word.top + word.height);
        lineText += (lineText ? ' ' : '') + word.text;
        if (word.conf >= 0) {
          lineConfSum += word.conf;
        }
      }

      const avgLineConf = lineData.words.length > 0 ? lineConfSum / lineData.words.length : 0;
      totalConf += avgLineConf;

      textLines.push({
        text: lineText,
        confidence: avgLineConf / 100,
        bbox: [minLeft, minTop, maxRight, maxBottom]
      });

      fullText += (fullText ? '\n' : '') + lineText;
    }

    // Build paragraphs from grouped lines (using Tesseract's native paragraph detection)
    const paragraphs: OcrParagraph[] = [];

    // Sort paragraphs by position
    const sortedParKeys = Array.from(parMap.keys()).sort((a, b) => {
      const aPar = parMap.get(a)!;
      const bPar = parMap.get(b)!;
      // Get min top from all words in all lines of this paragraph
      let aTop = Infinity, bTop = Infinity;
      for (const [, lineData] of aPar.lines) {
        for (const word of lineData.words) {
          aTop = Math.min(aTop, word.top);
        }
      }
      for (const [, lineData] of bPar.lines) {
        for (const word of lineData.words) {
          bTop = Math.min(bTop, word.top);
        }
      }
      return aTop - bTop;
    });

    for (const parKey of sortedParKeys) {
      const parData = parMap.get(parKey)!;
      if (parData.lines.size === 0) continue;

      // Calculate bounding box and text for the entire paragraph
      let minLeft = Infinity;
      let minTop = Infinity;
      let maxRight = 0;
      let maxBottom = 0;
      let parConfSum = 0;
      let wordCount = 0;
      const lineTexts: string[] = [];

      // Sort lines within paragraph by vertical position
      const sortedLines = Array.from(parData.lines.values()).sort((a, b) => {
        const aTop = Math.min(...a.words.map(w => w.top));
        const bTop = Math.min(...b.words.map(w => w.top));
        return aTop - bTop;
      });

      for (const lineData of sortedLines) {
        let lineText = '';
        lineData.words.sort((a, b) => a.left - b.left);

        for (const word of lineData.words) {
          minLeft = Math.min(minLeft, word.left);
          minTop = Math.min(minTop, word.top);
          maxRight = Math.max(maxRight, word.left + word.width);
          maxBottom = Math.max(maxBottom, word.top + word.height);
          lineText += (lineText ? ' ' : '') + word.text;
          if (word.conf >= 0) {
            parConfSum += word.conf;
            wordCount++;
          }
        }

        if (lineText) {
          lineTexts.push(lineText);
        }
      }

      if (lineTexts.length === 0) continue;

      // Join lines with space (paragraph text should flow)
      const parText = lineTexts.join(' ');
      const avgConf = wordCount > 0 ? parConfSum / wordCount / 100 : 0;

      paragraphs.push({
        text: parText,
        confidence: avgConf,
        bbox: [minLeft, minTop, maxRight, maxBottom],
        lineCount: lineTexts.length,
        blockNum: parData.blockNum,
        parNum: parData.parNum
      });
    }

    const avgConfidence = textLines.length > 0 ? totalConf / textLines.length / 100 : 0;

    console.log(`[OCR] Parsed: ${textLines.length} lines, ${paragraphs.length} paragraphs`);

    return {
      text: fullText,
      confidence: avgConfidence,
      textLines,
      paragraphs
    };
  }

  /**
   * Perform OCR on an image (supports data URLs, base64, or bookforge-page:// file paths)
   * Returns text lines with bounding boxes
   */
  async recognizeBase64(imageData: string): Promise<OcrResult> {
    // Handle bookforge-page:// URLs - these are direct file paths
    if (imageData.startsWith('bookforge-page://')) {
      const filePath = imageData.substring(17); // Remove 'bookforge-page://' prefix
      if (fs.existsSync(filePath)) {
        return this.recognizeFileWithBounds(filePath);
      }
      throw new Error(`Image file not found: ${filePath}`);
    }

    // Handle file:// URLs
    if (imageData.startsWith('file://')) {
      const filePath = imageData.substring(7);
      if (fs.existsSync(filePath)) {
        return this.recognizeFileWithBounds(filePath);
      }
      throw new Error(`Image file not found: ${filePath}`);
    }

    // Handle data URLs and raw base64
    const base64Clean = imageData.replace(/^data:image\/\w+;base64,/, '');

    // Write to temp file
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `ocr_${Date.now()}.png`);

    try {
      fs.writeFileSync(tempFile, Buffer.from(base64Clean, 'base64'));
      const result = await this.recognizeFileWithBounds(tempFile);
      return result;
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  /**
   * Detect skew angle of an image using Tesseract's OSD (Orientation and Script Detection)
   * Returns the angle needed to deskew the image
   */
  async detectSkew(imagePath: string): Promise<DeskewResult> {
    try {
      // Use psm 0 for orientation and script detection only
      const osdConfig: tesseract.Config = {
        ...this.config,
        psm: 0,  // OSD only
      };

      const output = await tesseract.recognize(imagePath, osdConfig);

      // Parse the OSD output for rotation angle
      // Tesseract outputs something like: "Rotate: 0\nOrientation in degrees: 0\n..."
      const rotateMatch = output.match(/Rotate:\s*(\d+)/);
      const orientationMatch = output.match(/Orientation in degrees:\s*([\d.]+)/);
      const confidenceMatch = output.match(/Orientation confidence:\s*([\d.]+)/);

      const angle = orientationMatch ? parseFloat(orientationMatch[1]) : 0;
      const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0;

      return { angle, confidence };
    } catch (err) {
      console.error('Skew detection failed:', err);
      // Return 0 angle on failure
      return { angle: 0, confidence: 0 };
    }
  }

  /**
   * Detect skew angle from image (supports data URLs, base64, or bookforge-page:// file paths)
   */
  async detectSkewBase64(imageData: string): Promise<DeskewResult> {
    // Handle bookforge-page:// URLs - these are direct file paths
    if (imageData.startsWith('bookforge-page://')) {
      const filePath = imageData.substring(17);
      if (fs.existsSync(filePath)) {
        return this.detectSkew(filePath);
      }
      throw new Error(`Image file not found: ${filePath}`);
    }

    // Handle file:// URLs
    if (imageData.startsWith('file://')) {
      const filePath = imageData.substring(7);
      if (fs.existsSync(filePath)) {
        return this.detectSkew(filePath);
      }
      throw new Error(`Image file not found: ${filePath}`);
    }

    // Handle data URLs and raw base64
    const base64Clean = imageData.replace(/^data:image\/\w+;base64,/, '');

    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `skew_${Date.now()}.png`);

    try {
      fs.writeFileSync(tempFile, Buffer.from(base64Clean, 'base64'));
      return await this.detectSkew(tempFile);
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  }

  /**
   * Get list of available languages
   */
  async getAvailableLanguages(): Promise<string[]> {
    try {
      const { execSync } = require('child_process');
      const binary = this.config.binary || 'tesseract';
      const output = execSync(`${binary} --list-langs`, { encoding: 'utf-8' });
      const lines = output.split('\n').filter((line: string) => line.trim() && !line.includes(':'));
      return lines;
    } catch {
      return ['eng'];  // Default fallback
    }
  }

  /**
   * Check if Tesseract is available
   */
  isAvailable(): boolean {
    try {
      const { execSync } = require('child_process');
      const binary = this.config.binary || 'tesseract';
      execSync(`${binary} --version`, { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Tesseract version
   */
  getVersion(): string | null {
    try {
      const { execSync } = require('child_process');
      const binary = this.config.binary || 'tesseract';
      const output = execSync(`${binary} --version`, { encoding: 'utf-8' });
      const match = output.match(/tesseract\s+([\d.]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
}

// Singleton instance
let ocrServiceInstance: OcrService | null = null;

export function getOcrService(): OcrService {
  if (!ocrServiceInstance) {
    ocrServiceInstance = new OcrService();
  }
  return ocrServiceInstance;
}
