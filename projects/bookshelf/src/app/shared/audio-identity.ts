/**
 * What makes two audiobook rows THE SAME BOOK on the shelf.
 *
 * The shelf fans `/api/books` across every enabled server and collapses the
 * result, so one book mirrored on the PC and on titan draws one card. The
 * collapsing key can't be the absolute path (the same file has a different one
 * on each server) — it has to be the part of the path that is identical
 * everywhere.
 *
 * ── The bug this fixes ───────────────────────────────────────────────────────
 *
 * That key used to be the bare filename. But e2a names every assembly after the
 * AUTHOR, not the book:
 *
 *     projects/Dust_-_Hugh_Howey_(2013)/output/Assembly._Hugh_Howey.m4b
 *     projects/Shift_-_Hugh_Howey_(2013)/output/Assembly._Hugh_Howey.m4b
 *
 * Two different books, one identity — so the second one was silently dropped
 * from the shelf and could not be played, downloaded or resumed. Owen's live
 * library had two such pairs (Hugh Howey's Shift lost to Dust; Star Gods lost
 * to One People, One Nation, One Faith, both filed under `Assembly._Unknown`).
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 *     <projectId>/<filename>
 *
 * The project folder is what actually distinguishes those two books, and it is
 * identical across mirrors of one library, so cross-server collapsing still
 * works exactly as before. Verified unique across all 191 audio paths in the
 * live library.
 *
 * The STORE segment between them (`output/` vs `archive/`) is deliberately left
 * out: "Add to archive" moves a book from one to the other, and a move must
 * never rename a book — that is the same rule the server-side variant anchor
 * exists to enforce (see electron/bookshelf-identity.ts).
 *
 * A phone-imported book has no project folder; its ref is already a unique
 * `local:<uuid>`, so the whole ref is the identity.
 *
 * ── One definition, on purpose ───────────────────────────────────────────────
 *
 * The shelf's dedup + "downloaded" badge, the offline store's cache lookup and
 * the player's recency stamp must agree character for character or a download
 * strands and the Recent sort misses. They used to hold three hand-copied
 * versions of this expression. They now all call this.
 */
export function audioIdentity(downloadPath: string): string {
  const segs = downloadPath.split(/[/\\]/).filter(Boolean);
  // …/<projectId>/<output|archive>/<filename>
  const projectId = segs[segs.length - 3];
  const filename = segs[segs.length - 1];
  // No project folder above it (a `local:<uuid>` import, or a path too shallow
  // to name a project) — the ref itself is the only identity there is.
  return (projectId ? `${projectId}/${filename}` : downloadPath).toLowerCase();
}
