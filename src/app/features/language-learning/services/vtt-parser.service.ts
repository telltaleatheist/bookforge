import { Injectable } from '@angular/core';

/**
 * VTT Cue - Represents a single subtitle cue
 */
export interface VttCue {
  index: number;
  startTime: number;  // seconds
  endTime: number;    // seconds
  text: string;
}

/**
 * Simple WebVTT parser for bilingual audiobook sync
 */
@Injectable({
  providedIn: 'root'
})
export class VttParserService {

  /**
   * Parse VTT content into an array of cues
   */
  parseVtt(vttContent: string): VttCue[] {
    const cues: VttCue[] = [];

    // Split by double newline to get blocks
    const blocks = vttContent.split(/\n\n+/);

    let cueIndex = 0;
    for (const block of blocks) {
      const lines = block.trim().split('\n');

      // Skip WEBVTT header and empty blocks
      if (lines.length === 0 || lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) {
        continue;
      }

      // Find the timestamp line (contains " --> ")
      let timestampLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(' --> ')) {
          timestampLineIndex = i;
          break;
        }
      }

      if (timestampLineIndex === -1) {
        continue; // No timestamp found in this block
      }

      const timestampLine = lines[timestampLineIndex];
      const [startStr, endStr] = timestampLine.split(' --> ');

      if (!startStr || !endStr) {
        continue;
      }

      const startTime = this.timeToSeconds(startStr.trim());
      const endTime = this.timeToSeconds(endStr.trim().split(' ')[0]); // Handle settings after timestamp

      // Text is everything after the timestamp line
      const textLines = lines.slice(timestampLineIndex + 1);
      const text = textLines.join('\n').trim();

      if (text) {
        cues.push({
          index: cueIndex++,
          startTime,
          endTime,
          text
        });
      }
    }

    return cues;
  }

  /**
   * Convert VTT timestamp to seconds
   * Handles formats: "00:00:00.000" or "00:00.000"
   */
  timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':');

    if (parts.length === 3) {
      // HH:MM:SS.mmm
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      // MM:SS.mmm
      const minutes = parseInt(parts[0], 10);
      const seconds = parseFloat(parts[1]);
      return minutes * 60 + seconds;
    }

    return 0;
  }

  /**
   * Find the cue index at a given time using binary search
   */
  findCueAtTime(cues: VttCue[], time: number): number {
    if (cues.length === 0) return -1;

    // Handle before first cue
    if (time < cues[0].startTime) return -1;

    // Handle after last cue
    if (time >= cues[cues.length - 1].endTime) return cues.length - 1;

    // Binary search
    let left = 0;
    let right = cues.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cue = cues[mid];

      if (time >= cue.startTime && time < cue.endTime) {
        return mid;
      } else if (time < cue.startTime) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    // If between cues, return the previous cue
    return Math.max(0, left - 1);
  }

  /**
   * Map VTT cue index to sentence pair index
   * Audio alternates: EN1, DE1, EN2, DE2, ...
   * So cue 0 -> pair 0 source, cue 1 -> pair 0 target, etc.
   */
  cueToSentencePair(cueIndex: number): { pairIndex: number; isSource: boolean } {
    return {
      pairIndex: Math.floor(cueIndex / 2),
      isSource: cueIndex % 2 === 0
    };
  }
}
