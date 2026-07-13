/**
 * Shared filename helpers for the renderer.
 *
 * Mirrors electron/path-utils.ts (the two packages compile separately and do not
 * cross-import). Keep the behavior in sync.
 */

/**
 * Collapse runs of 2+ consecutive dots in a filename BASE down to a single dot.
 *
 * Output filenames are composed as "Title. Author. (Year)" where each segment
 * prepends its own ". " separator. When a segment legitimately ENDS in a period,
 * that separator produces a double dot. The canonical case is the "Last, First M."
 * author form — e.g. "Green, Simon R." (Simon R. Green) — which yields
 * "Deathstalker. Green, Simon R.. (2017)" (the "R.." is wrong). A title ending in
 * "." (e.g. "The End.") hits the same edge. A single "R." is preserved; only runs
 * of 2+ collapse.
 *
 * IMPORTANT: pass the BASE only (no extension) so the "." before "m4b"/"vtt" is
 * never touched — apply this before appending the extension.
 */
export function collapseFilenameDots(base: string): string {
  return base.replace(/\.{2,}/g, '.');
}
