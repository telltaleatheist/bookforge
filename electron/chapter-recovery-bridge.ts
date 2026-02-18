/**
 * Chapter Recovery Bridge
 *
 * Handles detecting chapters from EPUB + VTT and injecting them into M4B files.
 *
 * Flow:
 * 1. Parse EPUB nav.xhtml to get chapter titles and order
 * 2. Get opening text of each chapter from EPUB content
 * 3. Parse VTT file to build a text-to-timestamp index
 * 4. Match chapter opening text to VTT timestamps
 * 5. Generate ffmpeg chapter metadata and remux M4B
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as cheerio from 'cheerio';

const MAX_STDERR_BYTES = 10 * 1024;
function appendCapped(buf: string, chunk: string): string {
  buf += chunk;
  if (buf.length > MAX_STDERR_BYTES) buf = buf.slice(-MAX_STDERR_BYTES);
  return buf;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ChapterMatch {
  id: string;
  title: string;
  epubOrder: number;
  detectedTimestamp: string | null;
  detectedSeconds: number | null;
  confidence: 'high' | 'medium' | 'low' | 'manual' | 'not_found';
  manualTimestamp: string | null;
  openingText: string;
}

export interface VttCue {
  startTime: number;  // seconds
  endTime: number;
  text: string;
}

export interface ChapterToApply {
  title: string;
  timestamp: string;  // HH:MM:SS format
}

// ─────────────────────────────────────────────────────────────────────────────
// VTT Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a VTT file into cues with timestamps
 */
export async function parseVttFile(vttPath: string): Promise<VttCue[]> {
  const content = await fs.readFile(vttPath, 'utf-8');
  const lines = content.split('\n');
  const cues: VttCue[] = [];

  let i = 0;
  // Skip WEBVTT header
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line: "00:00:00.000 --> 00:00:05.000"
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim());
      const startTime = parseVttTimestamp(startStr);
      const endTime = parseVttTimestamp(endStr);

      // Collect text lines until empty line or next timestamp
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].includes('-->')) {
        // Skip cue identifiers (numbers)
        if (!/^\d+$/.test(lines[i].trim())) {
          textLines.push(lines[i].trim());
        }
        i++;
      }

      if (textLines.length > 0) {
        cues.push({
          startTime,
          endTime,
          text: textLines.join(' ')
        });
      }
    } else {
      i++;
    }
  }

  return cues;
}

/**
 * Parse VTT timestamp "HH:MM:SS.mmm" to seconds
 */
function parseVttTimestamp(timestamp: string): number {
  // Handle both "HH:MM:SS.mmm" and "MM:SS.mmm" formats
  const parts = timestamp.split(':');
  let hours = 0, mins = 0, secs = 0;

  if (parts.length === 3) {
    hours = parseInt(parts[0]);
    mins = parseInt(parts[1]);
    secs = parseFloat(parts[2]);
  } else if (parts.length === 2) {
    mins = parseInt(parts[0]);
    secs = parseFloat(parts[1]);
  }

  return hours * 3600 + mins * 60 + secs;
}

/**
 * Build a searchable index from VTT cues
 * Returns array of { text, startTime } sorted by time
 */
function buildVttIndex(cues: VttCue[]): Array<{ text: string; startTime: number }> {
  // Combine consecutive cues into larger text blocks for better matching
  const blocks: Array<{ text: string; startTime: number }> = [];
  const windowSize = 5; // Combine 5 cues at a time

  for (let i = 0; i < cues.length; i++) {
    const windowCues = cues.slice(i, i + windowSize);
    const combinedText = windowCues.map(c => c.text).join(' ').toLowerCase();
    blocks.push({
      text: combinedText,
      startTime: cues[i].startTime
    });
  }

  return blocks;
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB Chapter Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract chapters from EPUB using the epub-processor
 */
export async function extractEpubChapters(epubPath: string): Promise<Array<{
  id: string;
  title: string;
  order: number;
  openingText: string;
}>> {
  const { EpubProcessor } = await import('./epub-processor.js');

  const processor = new EpubProcessor();
  await processor.open(epubPath);

  const structure = processor.getStructure();
  if (!structure) {
    processor.close();
    throw new Error('Failed to parse EPUB structure');
  }

  const chapters: Array<{
    id: string;
    title: string;
    order: number;
    openingText: string;
  }> = [];

  for (let i = 0; i < structure.chapters.length; i++) {
    const chapter = structure.chapters[i];

    // Get chapter text to extract opening
    let openingText = '';
    try {
      const fullText = await processor.getChapterText(chapter.id);
      if (fullText) {
        // Get first ~100 characters, clean up whitespace
        openingText = fullText
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 100);
      }
    } catch {
      // Ignore errors getting chapter text
    }

    chapters.push({
      id: chapter.id,
      title: chapter.title,
      order: i + 1,
      openingText
    });
  }

  processor.close();
  return chapters;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize text for matching (lowercase, remove punctuation, collapse whitespace)
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the best match for chapter opening text in VTT index
 */
function findChapterInVtt(
  openingText: string,
  vttIndex: Array<{ text: string; startTime: number }>
): { timestamp: number; confidence: 'high' | 'medium' | 'low' } | null {
  if (!openingText || openingText.length < 10) {
    return null;
  }

  const normalizedOpening = normalizeText(openingText);
  const searchWords = normalizedOpening.split(' ').filter(w => w.length > 3);

  if (searchWords.length === 0) {
    return null;
  }

  let bestMatch: { index: number; score: number } | null = null;

  for (let i = 0; i < vttIndex.length; i++) {
    const block = vttIndex[i];
    const normalizedBlock = normalizeText(block.text);

    // Count matching words
    let matchCount = 0;
    for (const word of searchWords) {
      if (normalizedBlock.includes(word)) {
        matchCount++;
      }
    }

    const score = matchCount / searchWords.length;

    if (score > 0.5 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { index: i, score };
    }
  }

  if (!bestMatch) {
    return null;
  }

  // Determine confidence based on match score
  let confidence: 'high' | 'medium' | 'low';
  if (bestMatch.score >= 0.8) {
    confidence = 'high';
  } else if (bestMatch.score >= 0.6) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    timestamp: vttIndex[bestMatch.index].startTime,
    confidence
  };
}

/**
 * Detect chapters by matching EPUB chapters to VTT timestamps
 */
export async function detectChapters(
  epubPath: string,
  vttPath: string
): Promise<{ success: boolean; chapters?: ChapterMatch[]; error?: string }> {
  try {
    // Parse EPUB chapters
    const epubChapters = await extractEpubChapters(epubPath);

    // Parse VTT and build index
    const vttCues = await parseVttFile(vttPath);
    const vttIndex = buildVttIndex(vttCues);

    // Match each chapter
    const chapters: ChapterMatch[] = [];

    for (const epubChapter of epubChapters) {
      const match = findChapterInVtt(epubChapter.openingText, vttIndex);

      chapters.push({
        id: epubChapter.id,
        title: epubChapter.title,
        epubOrder: epubChapter.order,
        detectedTimestamp: match ? formatSecondsToTimestamp(match.timestamp) : null,
        detectedSeconds: match ? match.timestamp : null,
        confidence: match ? match.confidence : 'not_found',
        manualTimestamp: null,
        openingText: epubChapter.openingText.slice(0, 50) + '...'
      });
    }

    return { success: true, chapters };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    };
  }
}

/**
 * Format seconds to HH:MM:SS timestamp
 */
function formatSecondsToTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Parse HH:MM:SS timestamp to milliseconds (for ffmpeg)
 */
function parseTimestampToMs(timestamp: string): number {
  const parts = timestamp.split(':');
  let hours = 0, mins = 0, secs = 0;

  if (parts.length === 3) {
    hours = parseInt(parts[0]);
    mins = parseInt(parts[1]);
    secs = parseInt(parts[2]);
  } else if (parts.length === 2) {
    mins = parseInt(parts[0]);
    secs = parseInt(parts[1]);
  }

  return (hours * 3600 + mins * 60 + secs) * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// M4B Chapter Injection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply chapters to M4B file using ffmpeg
 */
export async function applyChaptersToM4b(
  m4bPath: string,
  chapters: ChapterToApply[]
): Promise<{ success: boolean; outputPath?: string; chaptersApplied?: number; error?: string }> {
  try {
    // Validate input
    if (!chapters || chapters.length === 0) {
      return { success: false, error: 'No chapters to apply' };
    }

    // Check if m4b exists
    await fs.access(m4bPath);

    // Create chapter metadata file
    const metadataPath = m4bPath.replace('.m4b', '_chapters.txt');
    const outputPath = m4bPath.replace('.m4b', '_chaptered.m4b');

    // Build ffmpeg metadata format
    // https://ffmpeg.org/ffmpeg-formats.html#Metadata-1
    let metadata = ';FFMETADATA1\n';

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      const startMs = parseTimestampToMs(chapter.timestamp);

      // End time is start of next chapter, or we'll let ffmpeg figure it out
      const endMs = i < chapters.length - 1
        ? parseTimestampToMs(chapters[i + 1].timestamp)
        : startMs + 3600000; // Default 1 hour if last chapter

      metadata += '\n[CHAPTER]\n';
      metadata += `TIMEBASE=1/1000\n`;
      metadata += `START=${startMs}\n`;
      metadata += `END=${endMs}\n`;
      metadata += `title=${chapter.title.replace(/[=\n\r]/g, ' ')}\n`;
    }

    await fs.writeFile(metadataPath, metadata, 'utf-8');

    // Run ffmpeg to add chapters
    // ffmpeg -i input.m4b -i chapters.txt -map_metadata 1 -codec copy output.m4b
    return new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',  // Overwrite output
        '-i', m4bPath,
        '-i', metadataPath,
        '-map', '0',  // Use all streams from input
        '-map_metadata', '1',  // Use metadata from chapters file
        '-codec', 'copy',  // Don't re-encode
        outputPath
      ]);

      let stderr = '';

      ffmpeg.stderr.on('data', (data) => {
        stderr = appendCapped(stderr, data.toString());
      });

      ffmpeg.on('close', async (code) => {
        // Clean up metadata file
        try {
          await fs.unlink(metadataPath);
        } catch {
          // Ignore cleanup errors
        }

        if (code === 0) {
          // Replace original with chaptered version
          try {
            const backupPath = m4bPath.replace('.m4b', '_backup.m4b');
            await fs.rename(m4bPath, backupPath);
            await fs.rename(outputPath, m4bPath);
            // Remove backup after successful replacement
            await fs.unlink(backupPath);

            resolve({
              success: true,
              outputPath: m4bPath,
              chaptersApplied: chapters.length
            });
          } catch (err) {
            resolve({
              success: false,
              error: `Failed to replace original file: ${err}`
            });
          }
        } else {
          resolve({
            success: false,
            error: `ffmpeg failed with code ${code}: ${stderr.slice(-500)}`
          });
        }
      });

      ffmpeg.on('error', (err) => {
        resolve({
          success: false,
          error: `Failed to run ffmpeg: ${err.message}`
        });
      });
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error'
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC Setup
// ─────────────────────────────────────────────────────────────────────────────

export function setupChapterRecoveryHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('chapter-recovery:detect-chapters', async (
    _event,
    epubPath: string,
    vttPath: string
  ) => {
    return detectChapters(epubPath, vttPath);
  });

  ipcMain.handle('chapter-recovery:apply-chapters', async (
    _event,
    m4bPath: string,
    chapters: ChapterToApply[]
  ) => {
    return applyChaptersToM4b(m4bPath, chapters);
  });
}
