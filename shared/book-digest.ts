/**
 * book-digest — what a book's recorded identity STRING means.
 *
 * A book's identity is a digest, and every record that survives a restart holds
 * one: `NarrationDeletions.epubSha256`, `NarrationEpubOutput.fromEpubSha256`,
 * every `BookEdit`'s `fromSha256`/`toSha256`. Until now there was one way to
 * compute it — stream the `.working.epub`'s bytes through SHA-256 — so a stored
 * digest needed to say nothing about itself and a comparison was `===`.
 *
 * The working copy is becoming an exploded DIRECTORY (`source/<base>.working/`,
 * docs: the exploded-working-copy spec), and a directory has no bytes of its own
 * to hash. Its identity is computed over its CONTENT instead —
 * `epubTreeSha256`, electron/sidecar-binding.ts. So from the migration onward
 * there are TWO algorithms, and the same unchanged book has a different digest
 * under each.
 *
 * ── The problem this module exists to prevent ───────────────────────────────
 *
 * The migration unpacks a zip into a directory and verifies it entry for entry.
 * Not one character of the book changes. But every record stamped before it
 * holds the ZIP digest, and every reading after it computes the TREE digest, so
 * every `recorded === current` in the app goes false at once. Those comparisons
 * are not idle: they decide whether an evening of narration strikes still
 * describes the book, whether the TTS copy is re-cut, whether a chapter rename
 * carries onto the narration copy. Read as "the book changed" they tell the user
 * something false about work they did.
 *
 * ── The shape, and why it is this one ───────────────────────────────────────
 *
 * The digest is SELF-DESCRIBING — the algorithm lives in the value:
 *
 *     4f2b…c1        the file algorithm: SHA-256 over the archive's bytes
 *     bookforge-epub-tree-v1:4f2b…c1   the tree algorithm
 *
 * The file form is BARE, exactly the 64 hex characters that are already written
 * into ~43 projects' manifests. That is the point: no record on disk has to be
 * rewritten to be understood, no reader needs a migration to keep working, and
 * every digest this app computes today is byte-for-byte the value it computed
 * yesterday. A tagged form for the file algorithm would have been tidier and
 * would have made this a data migration instead of an addition.
 *
 * The tag is INSIDE the value rather than in a sibling field for the same
 * reason: a sibling field would have to be added to six record types and every
 * writer of them, and a record written before the field existed would have no
 * answer — which is exactly the "absent means…" guess this app does not make.
 * A bare 64-hex value has an answer, and it is not a default: it is what the
 * file algorithm's output has always looked like.
 *
 * ── Two functions, and the difference between them is the point ─────────────
 *
 *  - `bookDigestAlgorithm` is STRICT and throws. It is for values this app
 *    produced and must understand — the answer "I don't know what this is" is
 *    a bug worth stopping for.
 *  - `bookDigestAlgorithmChange` is TOTAL and never throws. It is for values
 *    read off disk in a message path, and it answers only when it can PROVE the
 *    two were computed differently. A value it cannot classify gets null, which
 *    leaves the caller's existing sentence standing — it is not a guess that the
 *    algorithms match, it is a refusal to claim they differ without evidence.
 *
 * Pure string handling, no `fs` — `shared/` so the strict classifier and the
 * sentence are defined once for the main process, the renderer and the tools.
 */

/** SHA-256 over an archive file's bytes. Recorded BARE — see the header. */
export const EPUB_FILE_DIGEST_ALGORITHM = 'sha256-file' as const;

/**
 * SHA-256 over an exploded EPUB's canonical content listing
 * (`epubTreeSha256`, electron/sidecar-binding.ts). Recorded TAGGED.
 */
export const EPUB_TREE_DIGEST_ALGORITHM = 'bookforge-epub-tree-v1' as const;

export type BookDigestAlgorithm =
  | typeof EPUB_FILE_DIGEST_ALGORITHM
  | typeof EPUB_TREE_DIGEST_ALGORITHM;

const HEX64 = /^[a-f0-9]{64}$/;
const TREE_PREFIX = `${EPUB_TREE_DIGEST_ALGORITHM}:`;

/** How a digest of `algorithm` with these 64 hex characters is written down. */
export function formatBookDigest(algorithm: BookDigestAlgorithm, hex: string): string {
  if (!HEX64.test(hex)) {
    throw new Error(
      `"${hex}" is not a SHA-256 digest (64 lower-case hex characters), so it cannot be recorded as `
      + `a ${algorithm} book identity.`
    );
  }
  return algorithm === EPUB_TREE_DIGEST_ALGORITHM ? `${TREE_PREFIX}${hex}` : hex;
}

/**
 * Which algorithm computed this digest. THROWS on anything else.
 *
 * Strict on purpose: a caller reaching for this is holding a value it believes
 * this app wrote, and a digest that parses as neither is a corrupt record or a
 * newer build's format. Either way the honest move is to say so by name rather
 * than to pick one and carry on.
 */
export function bookDigestAlgorithm(digest: string): BookDigestAlgorithm {
  if (HEX64.test(digest)) return EPUB_FILE_DIGEST_ALGORITHM;
  if (digest.startsWith(TREE_PREFIX) && HEX64.test(digest.slice(TREE_PREFIX.length))) {
    return EPUB_TREE_DIGEST_ALGORITHM;
  }
  throw new Error(
    `"${digest}" is not a book identity this build understands. A book's identity is either 64 hex `
    + `characters (SHA-256 of an archived book's bytes) or "${TREE_PREFIX}" followed by 64 hex `
    + 'characters (SHA-256 of an exploded book\'s contents).'
  );
}

/**
 * The 64 hex characters inside a digest, tag stripped.
 *
 * For the places a digest is used as a NAME rather than as an identity — the
 * staged filenames every book edit writes (`retitle-<hex[:16]>.epub`). Slicing
 * the recorded form would give every exploded book the same first 16 characters
 * (`bookforge-epub-t`) and collide two books' staging files in one directory.
 */
export function bookDigestHex(digest: string): string {
  const algorithm = bookDigestAlgorithm(digest);
  return algorithm === EPUB_TREE_DIGEST_ALGORITHM ? digest.slice(TREE_PREFIX.length) : digest;
}

/**
 * The sentence for two digests computed by DIFFERENT algorithms, or null.
 *
 * Total — it never throws, and it answers only on proof. Both values must
 * classify, and they must classify differently; anything else is null, meaning
 * "there is no evidence of an algorithm change here", which leaves the caller's
 * own "these do not match" sentence exactly as it was.
 *
 * The sentence says the thing the user needs and nothing else: the book did not
 * change, the way it is measured did. Callers append what they are about to do
 * about it, the same contract `narrationDeletionsStaleReason` follows.
 */
export function bookDigestAlgorithmChange(recorded: string, current: string): string | null {
  let was: BookDigestAlgorithm;
  let now: BookDigestAlgorithm;
  try {
    was = bookDigestAlgorithm(recorded);
    now = bookDigestAlgorithm(current);
  } catch {
    return null;
  }
  if (was === now) return null;
  return was === EPUB_FILE_DIGEST_ALGORITHM
    ? 'This record was stamped when this book was stored as a single archived file, and it is now '
      + 'stored as a folder of its parts, so its identity is measured a different way. The book '
      + 'itself was not changed — it was unpacked, and every part was checked against the archive '
      + 'before the archive was removed — but the old stamp and the new measurement are not the '
      + 'same kind of value and cannot be compared.'
    : 'This record was stamped when this book was stored as a folder of its parts, and it is now '
      + 'stored as a single archived file, so its identity is measured a different way. The book '
      + 'itself was not changed by that, but the old stamp and the new measurement are not the same '
      + 'kind of value and cannot be compared.';
}
