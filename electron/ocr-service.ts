import tesseract from 'node-tesseract-ocr';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

export interface OcrResult {
  text: string;
  confidence: number;
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
   * Perform OCR on an image file
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
   * Perform OCR on a base64 encoded image
   */
  async recognizeBase64(base64Data: string): Promise<OcrResult> {
    // Remove data URL prefix if present
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');

    // Write to temp file
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `ocr_${Date.now()}.png`);

    try {
      fs.writeFileSync(tempFile, Buffer.from(base64Clean, 'base64'));
      const result = await this.recognizeFile(tempFile);
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
   * Detect skew angle from base64 image
   */
  async detectSkewBase64(base64Data: string): Promise<DeskewResult> {
    const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');

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
