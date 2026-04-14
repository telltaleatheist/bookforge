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
 * Produce an ASCII-safe slug suitable for use as a folder name on all platforms.
 * - NFKD-decomposes so diacritics split from their base letter
 * - Strips combining marks (á → a, é → e, ñ → n)
 * - Replaces anything still non-ASCII with underscore
 * - Strips OS-unsafe chars and collapses underscores
 */
export function toAsciiSlug(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[<>:"|?*'"''""/\\]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_\s]+|[_\s]+$/g, '');
}
