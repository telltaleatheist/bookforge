/**
 * Path utilities for cross-platform filesystem correctness.
 *
 * macOS APFS returns filenames from readdir() in NFD (decomposed) form, so paths
 * constructed from those strings end up NFD. Windows NTFS is normalization-sensitive:
 * fs.access("NFD-path") with a folder stored as NFC returns ENOENT even though the
 * folder exists. macOS APFS is normalization-insensitive, which is why bugs like
 * this show up only on Windows.
 */

/**
 * NFC-normalize a filesystem path. Safe to call on all platforms and idempotent.
 * Apply at IPC boundaries and when reading paths/IDs from persisted JSON so that
 * subsequent fs.* calls on Windows can resolve the entry.
 */
export function normalizeFsPath(p: string): string {
  return p.normalize('NFC');
}

/**
 * ASCII-sanitize a human-readable filename (keeps spaces, commas, periods,
 * parentheses, hyphens) so it's safe and normalization-proof on every platform.
 * Strips diacritics (ü→u, é→e, ñ→n), maps German ß→ss, and drops any remaining
 * non-ASCII. Use for ON-DISK filenames; the file's EMBEDDED metadata (m4b tags,
 * epub author) keeps the correct Unicode — only the disk name is simplified.
 * Sidesteps the Windows NFD/NFC (Syncthing Mac↔Win) ENOENT class of bugs.
 */
export function toAsciiFilename(s: string): string {
  return s
    .replace(/ß/g, 'ss')          // ß → ss
    .replace(/ẞ/g, 'SS')          // ẞ → SS
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritical marks
    .replace(/[^\x20-\x7e]/g, '')      // drop anything still non-ASCII
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produce an ASCII-safe slug suitable for use as a folder name on all platforms.
 * - NFKD-decomposes so diacritics split from their base letter
 * - Strips combining marks (á → a, é → e, ñ → n)
 * - Replaces anything still non-ASCII with underscore
 * - Strips OS-unsafe chars and collapses underscores
 */
export function toAsciiSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[<>:"|?*'"''""/\\]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '');
}

/**
 * Collapse runs of 2+ consecutive dots in a filename BASE down to a single dot.
 *
 * Filenames are composed as "Title. Author. (Year)" where each segment prepends
 * its own ". " separator. When a segment legitimately ENDS in a period, that
 * separator produces a double dot. The canonical case is the "Last, First M."
 * author form — e.g. "Green, Simon R." (Simon R. Green) — which yields
 * "Deathstalker. Green, Simon R.. (2017)" (the "R.." is wrong). A title ending
 * in "." (e.g. "The End.") hits the same edge. A single "R." is preserved; only
 * runs of 2+ collapse.
 *
 * IMPORTANT: pass the BASE only (no extension) so the "." before "m4b"/"vtt" is
 * never touched — apply this before appending the extension.
 */
export function collapseFilenameDots(base: string): string {
  return base.replace(/\.{2,}/g, '.');
}
