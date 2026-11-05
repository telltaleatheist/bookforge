/**
 * What the model gets, and what no narrator reads aloud. A port of the leaf functions of
 * `narrator/text/paragraph_packer.py`.
 */

import { pyRegexCollapseSpace, pyStrip } from '../py-compat';
import { smlUnspokenPattern } from './sml';

/**
 * e2a's `chars_remove`, the one table both text paths share. Measured 2026-09-06: a VLM's
 * `<li>* Understanding which witch</li>` reached the model as `[item]* Understanding`, and the
 * asterisk was read as a stray syllable.
 */
export const CHARS_REMOVE = '\\|©®™*`\u00a0';

const UNSPOKEN_GLYPHS = new RegExp(`[${CHARS_REMOVE.replace(/[\\\]^-]/g, '\\$&')}]`, 'g');

/** Each glyph becomes a space, so `word*word` cannot fuse. The caller collapses. */
export function stripNarratorGlyphs(text: string | null | undefined): string {
  return (text ?? '').replace(UNSPOKEN_GLYPHS, ' ');
}

/** Markers stripped, whitespace collapsed: the same reading a cue and the engine prompt take. */
export function spoken(text: string): string {
  return pyStrip(pyRegexCollapseSpace(text.replace(smlUnspokenPattern(), '')));
}
