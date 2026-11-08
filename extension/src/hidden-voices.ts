/**
 * VOICES THIS EXTENSION NEVER SHOWS (Owen, 2026-11-08). The Owen Morgan voices
 * are for his own audiobooks and videos; the reader is used on a livestream, and
 * a viewer who saw them in the picker would assume the videos are generated. So
 * they are left out of every list, and any status line that would name one says
 * "another voice" instead. The server still serves them to BookForge; only this
 * extension's view of them is withheld.
 */
const HIDDEN_VOICES: ReadonlySet<string> = new Set(['owen-audiobook', 'owen-youtube']);
const HIDDEN_VOICE_TEXT = /\bowen-(?:audiobook|youtube)\b|Owen Morgan(?:\s*\((?:YouTube|Audiobook)\))?/gi;

export function isHiddenVoice(id: string | null | undefined): boolean {
  return id !== null && id !== undefined && HIDDEN_VOICES.has(id);
}

/** A voice id as the UI may print it: a hidden one is "another voice". */
export function shownVoice(id: string | null): string | null {
  return isHiddenVoice(id) ? 'another voice' : id;
}

/** Any sentence with a hidden voice's id or name in it, with that name taken out. */
export function scrubHiddenVoices(text: string): string {
  return text.replace(HIDDEN_VOICE_TEXT, 'another voice');
}
