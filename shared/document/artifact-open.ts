/**
 * artifact-open — a user opens their book, and lands on the file they can edit.
 *
 * ── The failure this exists to end (Owen, 2026-08-09) ───────────────────────
 *
 * "instead of prompting the user to open the working copy, lets just open the
 * working copy… the user wont open the indented documents. theyll open the
 * original version — the archive epub created by the vlm. but it will ACTUALLY
 * open the working copy with the changes applied."
 *
 * Every door into a project pointed at an archive-grade file. `EditorRouteService`
 * hands an EPUB project its `archive/<Book>.epub`, the versions page's generated
 * row hands over the cast book, and both landed the user on a read-only page
 * behind a banner offering to take them one click further to the only file they
 * can actually work on. The banner was correct and it was still a wall: nobody
 * opens a book in order to be told where their book is.
 *
 * ── What this decides, and what it deliberately does not ────────────────────
 *
 * One question: the window is about to display `asked` for this project — is
 * that the file it should display? Three answers, and they are the whole of it.
 *
 * It is PURE — paths in, a plan out, no fs and no manifest — because the two
 * surfaces that ask it are a renderer that cannot stat and a test that has no
 * project. Which paths a project HAS is main's answer (`projects:export-info`),
 * asked once and passed in; this never derives an artifact's identity from its
 * name. That rule is why the picker can tell the archive original from the cast
 * book from the working copy at all: the manifest is where those names are
 * settled, and a second derivation here is how two surfaces come to disagree
 * about one file.
 */

import { samePath } from './same-path';
import { viewedArtifactOf } from './rail-tasks';

/** What the window should do about the file it was about to show. */
export type ArtifactOpenPlan =
  /**
   * Show the file that was asked for. The ordinary answer, and the answer for
   * every file this does not recognise as one of the project's three named
   * artifacts — a narration copy being previewed, a variant EPUB, a stage
   * output. Only the archive-grade books are redirected; nothing else is.
   */
  | { readonly kind: 'as-asked' }
  /**
   * Show the project's working copy instead, minting it if it is not there.
   *
   * The file asked for is archive-grade — the original the user handed us, or
   * the book cast from their pages — and nothing may write to either. The
   * caller ENSURES the copy rather than assuming one exists, and a project that
   * cannot be given one must fail loudly by name: quietly showing the read-only
   * file after promising to open the editable one is the exact silence this
   * whole module exists to remove.
   */
  | { readonly kind: 'working-copy' };
  // A third kind, `offer-conversion`, lived here until 2026-08-10: an unread
  // PDF's open ALSO raised the convert-to-EPUB flow. Retired — asking for a
  // file and being answered with a job read as "PDFs cannot be opened", and
  // conversion has its own doors. An open is an open.

/**
 * What a project HAS, as main answers for it. Every field is a path main
 * resolved from the manifest, or null when the project has no such file.
 */
export interface ArtifactOpenRequest {
  /** The file the window was about to display, absolute. */
  readonly asked: string;
  /**
   * `manifest.archive` role:original — the file the user handed us, in whatever
   * format they handed it over in. Null when the project records none, which is
   * a real state (an imported audiobook has no document original).
   */
  readonly archiveOriginal: string | null;
  /** `outputs.generatedEpub` — the book a page reader cast from the pages. */
  readonly generatedEpub: string | null;
  /** `outputs.epub` — the one editable file, when the project already has one. */
  readonly workingCopy: string | null;
}

/**
 * Where this open should land.
 *
 * The working copy is compared FIRST, and the order is load-bearing rather than
 * incidental: a project migrated by `ensureGeneratedEpub` had its working copy
 * adopted as the source of its generated book, and if those two records ever
 * came to name one file, a redirect that asked "is this the cast book" first
 * would send the user away from the file they were already on and into a mint
 * of it.
 */
export function planArtifactOpen(request: ArtifactOpenRequest): ArtifactOpenPlan {
  const { asked, archiveOriginal, generatedEpub, workingCopy } = request;

  // Already the editable file. Nothing to redirect to but itself.
  if (workingCopy !== null && samePath(asked, workingCopy)) return { kind: 'as-asked' };

  // The cast book, which is archive-grade as of 2026-08-09 and which every
  // working copy of a PDF-origin project is minted from.
  if (generatedEpub !== null && samePath(asked, generatedEpub)) return { kind: 'working-copy' };

  if (archiveOriginal !== null && samePath(asked, archiveOriginal)) {
    // The user handed us a book. It is copied, and the copy is what opens.
    if (viewedArtifactOf(asked) === 'book') return { kind: 'working-copy' };

    // The user handed us pages, and pages OPEN — with or without a book behind
    // them. This used to answer `offer-conversion` for a project with no book
    // yet, which raised the conversion modal over the open; asking for a file
    // and being answered with a job reads as "PDFs cannot be opened" (Owen,
    // 2026-08-10: "i would like to be able to scan through them"). Conversion
    // keeps its own doors — the Process button and the picker's banner — and
    // an open is an open.
    return { kind: 'as-asked' };
  }

  return { kind: 'as-asked' };
}
