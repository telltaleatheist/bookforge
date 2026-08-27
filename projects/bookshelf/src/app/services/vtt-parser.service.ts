import { Injectable } from '@angular/core';

/** A single WebVTT cue. */
export interface VttCue {
  index: number;
  startTime: number; // seconds
  endTime: number;   // seconds
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
 * bold tag — `<b>Chapter Eight.</b>`. The tags are never text, and the wrapping
 * is a fact the player carries so it can render the header as a header.
 *
 * A transcript written before this change has no tags, so `text` comes back
 * exactly as it went in and `heading` is false. Nothing migrates.
 *
 * Ported verbatim from the desktop app's VttParserService, like parseVtt below,
 * so the web player reads a transcript identically.
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
      const { text, heading } = readVttCueText(lines.slice(timestampLineIndex + 1).join('\n'));

      if (text) {
        cues.push({ index: cueIndex++, startTime, endTime, text, heading });
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
