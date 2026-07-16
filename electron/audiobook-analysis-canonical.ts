import * as crypto from 'crypto';

export interface AudiobookAnalysisCue {
  index: number;
  startTime: number;
  endTime: number;
  startMs: number;
  endMs: number;
  text: string;
}

export function normalizeAudiobookCueText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ');
}

function timestampToMs(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (minutes > 59 || seconds > 59) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
}

/** Parse the exact cue shape used for transcript identity. Malformed timing or
 * empty cues are rejected instead of being silently discarded. */
export function parseAudiobookVttStrict(content: string): AudiobookAnalysisCue[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t]|\n|$)/.test(normalized)) {
    throw new Error('Authoritative transcript is not a WEBVTT document');
  }
  const blocks = normalized.split(/\n{2,}/);
  const cues: AudiobookAnalysisCue[] = [];
  for (const [blockIndex, rawBlock] of blocks.entries()) {
    const block = rawBlock.trim();
    if (!block || (blockIndex === 0 && /^WEBVTT(?:[ \t\n]|$)/.test(block))
      || /^NOTE(?:[ \t\n]|$)/.test(block)) continue;
    const lines = block.split('\n');
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0) {
      if (/^STYLE(?:[ \t\n]|$)/.test(block) || /^REGION(?:[ \t\n]|$)/.test(block)) continue;
      throw new Error('WebVTT block has no timing line');
    }
    const timing = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex].trim());
    if (!timing) throw new Error(`Invalid WebVTT timing line: ${lines[timingIndex]}`);
    const startMs = timestampToMs(timing[1]);
    const endMs = timestampToMs(timing[2]);
    if (endMs <= startMs) throw new Error(`WebVTT cue end must be after start: ${lines[timingIndex]}`);
    const text = lines.slice(timingIndex + 1).join('\n').trim();
    if (!text) throw new Error(`WebVTT cue at ${timing[1]} has no text`);
    cues.push({
      index: cues.length,
      startTime: startMs / 1000,
      endTime: endMs / 1000,
      startMs,
      endMs,
      text,
    });
  }
  if (cues.length === 0) throw new Error('Authoritative transcript contains no cues');
  return cues;
}

export function canonicalizeAudiobookCues(cues: AudiobookAnalysisCue[]): string {
  const canonical = cues.map((cue, index) => {
    if (cue.index !== index || !Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs)) {
      throw new Error(`Transcript cue identity is invalid at index ${index}`);
    }
    if (cue.endMs <= cue.startMs) throw new Error(`Transcript cue ${index} has invalid timing`);
    return { index, startMs: cue.startMs, endMs: cue.endMs, text: normalizeAudiobookCueText(cue.text) };
  });
  return JSON.stringify(canonical);
}

export function digestAudiobookCues(cues: AudiobookAnalysisCue[]): string {
  return crypto.createHash('sha256').update(canonicalizeAudiobookCues(cues), 'utf8').digest('hex');
}
