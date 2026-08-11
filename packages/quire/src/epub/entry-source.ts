/**
 * What a book has to be, for quire to read it.
 *
 * A book reaches quire as a set of named entries — `mimetype`,
 * `META-INF/container.xml`, `EPUB/text/c0001.xhtml` — and everything above this
 * line (the spine walk, the pagination shells, the `quire://` handler) is
 * written against those names and nothing else. Whether the names come out of a
 * ZIP central directory or off a filesystem is a detail of the container, and
 * this interface is where that detail stops.
 *
 * The entry names are the SAME strings either way. That is the whole contract:
 * BookForge's element keys are built on them, a cached page map is keyed by
 * them, and a book that is exploded to a directory and re-zipped must not become
 * a different book on the way. Hence the normalization rule below, which the
 * directory implementation has to do work to honour and the zip one gets for
 * free.
 */

/** Which kind of container a book was opened from. Named in every refusal. */
export type QuireEntrySourceKind = 'zip' | 'directory';

export interface QuireEntrySource {
  /** The path the caller named the book by — the file, or the directory root. */
  readonly sourcePath: string;

  /** The container this source reads. Reported so the two are never confused. */
  readonly kind: QuireEntrySourceKind;

  /**
   * The source in a phrase, for error messages: "the EPUB archive C:\book.epub",
   * "the exploded EPUB directory C:\book.working".
   */
  describe(): string;

  /**
   * Read the entry index. Must be called before anything else; the index is
   * taken once, here, exactly as a ZIP's central directory is — so a book does
   * not change what it contains while it is being paginated.
   */
  open(): void;

  /** Release whatever `open` acquired. Idempotent. */
  close(): void;

  /** Is `name` one of this book's entries? Never throws — a bad name is `false`. */
  hasEntry(name: string): boolean;

  /**
   * Every entry, as forward-slash names relative to the book's root:
   * `EPUB/text/c0001.xhtml`, never `EPUB\text\c0001.xhtml`.
   *
   * A directory is not an entry. The directory source lists files only; a ZIP
   * lists what its central directory holds, and a ZIP MAY carry zero-length
   * `EPUB/`-style directory entries that an exploded copy of the same book
   * cannot reproduce. No EPUB BookForge writes carries them, but a publisher's
   * might — so anything comparing the two sets entry for entry has to say what
   * it does about those rather than assume there are none.
   */
  entryNames(): string[];

  /** The entry's bytes. A name this book does not have is a refusal, not empty. */
  readEntry(name: string): Promise<Buffer>;

  /** The entry's bytes as UTF-8. */
  readText(name: string): Promise<string>;
}
