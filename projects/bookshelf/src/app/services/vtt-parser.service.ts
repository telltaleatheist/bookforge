import { Injectable } from '@angular/core';

/** A single WebVTT cue. */
export interface VttCue {
  index: number;
  startTime: number; // seconds
  endTime: number;   // seconds
  text: string;
}

/**
 * Minimal WebVTT parser for sentence-synced audiobooks.
 * Ported verbatim from the desktop app's VttParserService so the web player
 * syncs text identically.
 */
@Injectable({ providedIn: 'root' })
export class VttParserService {
  parseVtt(vttContent: string): VttCue[] {
    const cues: VttCue[] = [];
    const blocks = vttContent.split(/\r?\n\r?\n+/);

    let cueIndex = 0;
    for (const block of blocks) {
      const lines = block.trim().split(/\r?\n/);
      if (lines.length === 0 || lines[0].startsWith('WEBVTT') || lines[0].startsWith('NOTE')) {
        continue;
      }

      let timestampLineIndex = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(' --> ')) {
          timestampLineIndex = i;
          break;
        }
      }
      if (timestampLineIndex === -1) continue;

      const [startStr, endStr] = lines[timestampLineIndex].split(' --> ');
      if (!startStr || !endStr) continue;

      const startTime = this.timeToSeconds(startStr.trim());
      const endTime = this.timeToSeconds(endStr.trim().split(' ')[0]);
      const text = lines.slice(timestampLineIndex + 1).join('\n').trim();

      if (text) {
        cues.push({ index: cueIndex++, startTime, endTime, text });
      }
    }
    return cues;
  }

  timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':');
    if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return 0;
  }

  /** Binary-search the cue active at `time`; returns -1 before the first cue. */
  findCueAtTime(cues: VttCue[], time: number): number {
    if (cues.length === 0) return -1;
    if (time < cues[0].startTime) return -1;
    if (time >= cues[cues.length - 1].endTime) return cues.length - 1;

    let left = 0;
    let right = cues.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cue = cues[mid];
      if (time >= cue.startTime && time < cue.endTime) return mid;
      if (time < cue.startTime) right = mid - 1;
      else left = mid + 1;
    }
    return Math.max(0, left - 1);
  }
}
