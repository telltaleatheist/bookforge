/**
 * A NEW OUTPUT FILE NEVER REPLACES AN EXISTING ONE.
 *
 * Owen's ruling (2026-09-03, after the Mutineer's Moon render): the system does
 * not delete audiobooks. A finished m4b is filed BESIDE whatever is already in
 * the folder; if the name it wanted is taken, it takes a numbered one instead.
 * Deleting is the user's act, done on the files directly.
 *
 * Why this is a module and not a line at each call site: the promotion in
 * reassembly-bridge used to SWEEP every .m4b/.vtt/.mp4 out of the output folder
 * before filing a new render ("the audiobook it replaces was made from
 * sentences that no longer exist"), and that sweep deleted two professionally
 * read recordings that happened to live in output/ (Shift and Dust,
 * 2026-08-23, recovered from titan's recycle bin) — see memory
 * audiobook-manifest-registration-gap. The inline TTS path had its own
 * overwrite: e2a writes into the output folder under a name derived from the
 * book, and a second run under the same name simply replaced the first. Both
 * doors now resolve their names HERE, and neither unlinks anything.
 *
 * The suffix is ` (2)`, ` (3)`, … before the extension — the convention every
 * desktop file manager uses for the same situation, so a person looking at the
 * folder reads it without being told.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * A stem under which NONE of `exts` exists in `dir`: the stem itself when it is
 * free for every extension, else the first `stem (n)` (n >= 2) that is.
 *
 * Checked across every extension at once so a run's files keep ONE stem: an
 * audiobook and its transcript/video are found by stem, and `Book (2).m4b`
 * beside `Book.vtt` would pair the new audio with the old transcript.
 * Extensions carry their dot (`.m4b`), matching `path.extname`.
 */
export function uniqueOutputStem(dir: string, stem: string, exts: readonly string[]): string {
  const taken = (candidate: string): boolean =>
    exts.some((ext) => fs.existsSync(path.join(dir, `${candidate}${ext}`)));
  if (!taken(stem)) return stem;
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken(candidate)) return candidate;
  }
}

/**
 * `filePath` itself when nothing is there, else the same name with the first
 * free ` (n)` suffix before its extension.
 */
export function uniqueOutputPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  return path.join(dir, `${uniqueOutputStem(dir, stem, [ext])}${ext}`);
}
