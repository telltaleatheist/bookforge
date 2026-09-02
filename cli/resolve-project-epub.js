/**
 * resolve-project-epub.js — which of a project's EPUBs a narration job reads.
 *
 * The app's TTS door offers "Latest", and this is what Latest means: the newest
 * derivation of the book that exists, translated first and the original last.
 * Lifted out of orpheus-audiobook-render.js when `--prep` needed the SAME
 * answer — a second copy of this ladder in the prep adapter would be a second
 * place for the order to be wrong, and the whole point of `--prep` is that a
 * later `--audiobook` on the same project preps the identical file and reuses
 * the copy on disk.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** Best-available input EPUB — mirrors the app's TTS "Latest" resolution
 *  (translated > simplified/cleaned > exported > original). First existing wins. */
function resolveInputEpub(projectDir) {
  const candidates = [
    'stages/02-translate/translated.epub',
    'stages/01-cleanup/simplified.epub',
    'stages/01-cleanup/cleaned.epub',
    'source/exported.epub',
    'source/original.epub',
  ];
  for (const rel of candidates) {
    const p = path.join(projectDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { resolveInputEpub };
