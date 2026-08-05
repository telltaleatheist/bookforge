/**
 * Are these two strings the same file?
 *
 * The document pipeline compares paths that have each been through a different
 * hand and come back spelled differently: main resolves with `path.resolve`
 * (backslashes on Windows), manifests record project-relative paths with forward
 * slashes, IPC payloads carry whatever the sender held, and the renderer never
 * does path arithmetic of its own. Two spellings of one file must not read as
 * two files — that is how a station lands on the wrong tab and how an event
 * about the project on screen gets ignored.
 *
 * Separator- and case-insensitive. Case-folding is what Windows and macOS
 * themselves do; on a case-sensitive filesystem it could in principle conflate
 * `Book.epub` with `book.epub` in one directory, and every caller here uses the
 * answer to pick a view rather than to authorize a write.
 *
 * NOT a path resolver. It compares what it is given, so both sides must already
 * be absolute (or both relative to the same place) — a comparison that quietly
 * resolved one side would be answering a question nobody asked.
 */
export function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b);
}

function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
