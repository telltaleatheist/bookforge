import { Injectable } from '@angular/core';

/**
 * VTT Cue - Represents a single subtitle cue
 */
export interface VttCue {
  index: number;
  startTime: number;  // seconds
  endTime: number;    // seconds
  /** Display text, every inline tag removed. Never contains markup. */
  text: string;
  /** True when e2a bold-wrapped the whole payload, i.e. this cue is a heading. */
  heading: boolean;
}

/**
 * Any inline WebVTT tag: `<b>`, `</b>`, `<i>`, `<v Speaker>`, `<c.class>`.
 * Timestamp tags (`<00:00:01.000>`) begin with a digit and are left alone.
 */
const VTT_INLINE_TAG = /<\/?[a-zA-Z][^>]*>/g;

/** The whole payload wrapped in ONE bold span — what e2a writes for a heading. */
const VTT_BOLD_WRAPPED = /^<b>([\s\S]*)<\/b>$/i;

/**
 * Split a raw cue payload into the text a human may see and the heading fact
 * (2026-08-27).
 *
 * e2a marks a section heading by wrapping the WHOLE cue payload in WebVTT's own
 * bold tag — `<b>Chapter Eight.</b>` — so the transcript can show a header the
 * way the page did. Two rules follow, and every reader of a cue obeys them: the
 * tags are never text, and the wrapping is a fact worth carrying.
 *
 * A transcript written before this change has no tags, so `text` comes back
 * exactly as it went in and `heading` is false. Nothing migrates.
 *
 * The main process keeps this same contract in electron/vtt-cue-text.ts and the
 * bookshelf web app in its own vtt-parser.service.ts; they are separate build
 * units, which is the only reason there is more than one copy.
 */
export function readVttCueText(raw: string): { text: string; heading: boolean } {
  const trimmed = raw.trim();
  const wrapped = VTT_BOLD_WRAPPED.exec(trimmed);
  // Only a payload that is ENTIRELY one bold span counts as a heading. A cue
  // that merely contains a tag somewhere is prose with markup in it.
  const heading = wrapped !== null && !/[<>]/.test(wrapped[1]);
  return { text: trimmed.replace(VTT_INLINE_TAG, ''), heading };
}

/**
 * Simple WebVTT parser for audiobook sentence sync
 * Used by both bilingual articles and monolingual audiobooks
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

    // Split by double newline to get blocks (handle \r\n and \n line endings)
    const blocks = vttContent.split(/\r?\n\r?\n+/);

    let cueIndex = 0;
    for (const block of blocks) {
      const lines = block.trim().split(/\r?\n/);

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
      const { text, heading } = readVttCueText(textLines.join('\n'));

      if (text) {
        cues.push({
          index: cueIndex++,
          startTime,
          endTime,
          text,
          heading
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
   * Convert seconds to VTT timestamp format (HH:MM:SS.mmm)
   */
  secondsToTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = (seconds % 60).toFixed(3);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
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
   * Map VTT cue index to sentence pair index (for bilingual mode)
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
