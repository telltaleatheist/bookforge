/**
 * WHAT A NARRATE PRESS HANDS TO THE DIALOG — the launcher's payload.
 *
 * ── Why it is a shared declaration and not three copies ─────────────────────
 *
 * Three processes touch it. Main resolves which of a project's exported EPUBs a
 * Foundry press meant (electron/foundry-narrate-target.ts), reads the book's
 * metadata, and sends this; preload passes it across the bridge; the renderer's
 * dialog opens on it. A payload declared at each stop is one that drifts the day
 * it gains a field, and the field that goes missing is the one nobody notices
 * until an audiobook comes back filed against the wrong version.
 *
 * ── It is COMPLETE by construction, and that is the point ───────────────────
 *
 * Owen's identity law: "the tts pipeline knows exactly which file its working
 * with because the user came to the tts page FROM the button on that document."
 * Nothing here is optional in the sense of "look it up if absent" — the sender
 * knows all of it, and a receiver that could fill a gap would be a receiver that
 * could file a run against whichever version it reached first. The two fields
 * that can be EMPTY say what empty means where they are declared.
 */

export interface NarrateTarget {
  /** The EPUB this run reads — absolute, and the file the press was made on. */
  readonly epubPath: string;
  /** The manifest variant id of the version that file is. */
  readonly variantId: string;
  /** The BookForge project directory, absolute. */
  readonly projectDir: string;
  readonly title: string;
  readonly author: string;
  /** '' when the book states none — passed through as absent, never invented. */
  readonly year: string;
  /** ABSOLUTE, or '' for a book with no cover. Absolute because that is the
   *  shape the assembler writes into the M4B and the shape the queue tray draws
   *  its thumbnail from; the manifest's own library-relative spelling is joined
   *  to the library root by whoever builds this. */
  readonly coverPath: string;
  /** The M4B's filename, from the project's own record. */
  readonly outputFilename: string;
  /**
   * An article rather than a book.
   *
   * Not cosmetic: an article's jobs carry `projectDir` where a book's carry
   * `bfpPath`, and those are what the bridges resolve a session and an output
   * folder from.
   */
  readonly isArticle: boolean;
}
