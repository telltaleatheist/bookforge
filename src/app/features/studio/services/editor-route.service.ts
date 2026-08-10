import { Injectable, inject } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

/** Which file the picker opens, and everything the hosts need to render it. */
export type EditorRoute =
  | { kind: 'picker'; epubArchivePath: string | null }
  | { kind: 'error'; message: string };

/**
 * EditorRouteService — decides what the editor opens.
 *
 * Every project opens in the PdfPicker; the only decision left here is WHICH
 * FILE it points at. An EPUB project points at its archived ORIGINAL
 * (`archive/<Book>.epub`), never at a rebuilt copy: edits are applied to the
 * original's own markup at export time, so a previously exported epub would be
 * the wrong baseline — its markup has already been rewritten once.
 * `epubArchivePath` carries that file; it is null for PDF projects and loose
 * files, where the picker derives its own source.
 *
 * POINTS AT, and as of 2026-08-09 no longer LANDS ON. The archive original is a
 * file nothing may write to, so the picker swaps in the working copy minted from
 * it before anything is displayed (`shared/document/artifact-open.ts`) — Owen:
 * "if they open an archive epub, it just opens a new working copy seamlessly."
 * The baseline rule above survives that intact rather than being worked around
 * by it: the copy is minted as the original's exact bytes, so it IS the
 * original's markup, and it is the one file in the project a pass or a strike is
 * allowed to rewrite.
 *
 * The standalone editor window (`EditorWindowComponent`) is the one host of
 * the editor. (A Studio-embedded `EditorTabComponent` used to be the second —
 * it was deleted Aug 3 2026 after months with no importer; it also bound the
 * project's primary document over any requested version, so re-mounting it
 * would reopen the wrong-file bug fixed that day.) The decision still lives
 * here rather than in the component so any future second host inherits it.
 *
 * The input may be EITHER a project directory or a plain file: the editor is
 * opened both ways (`editor:open-window-with-bfp` passes a directory,
 * `editor:open-window` passes a file). The renderer cannot stat, so it does not
 * try to tell them apart — `classifyEditorSource` does that in the main process
 * and hands back absolute, platform-correct paths.
 *
 * NO PATH ARITHMETIC HAPPENS HERE, deliberately. Manifest entries are relative
 * and slash-separated ("archive/Book.epub"); joining them with template strings
 * produces mixed separators on Windows and does not survive the move to macOS.
 * Every path in an EditorRoute arrives already resolved.
 */
@Injectable({ providedIn: 'root' })
export class EditorRouteService {
  private electron = inject(ElectronService);

  /** `target` is whatever the editor was pointed at — a project folder or a file. */
  async resolve(target: string): Promise<EditorRoute> {
    const info = await this.electron.classifyEditorSource(target);

    if (!info.success) {
      // No silent default to the picker: which file opens decides what the user
      // is even able to edit, so a path we cannot identify must say so.
      return { kind: 'error', message: `Could not open "${target}": ${info.error ?? 'unknown error'}` };
    }

    // A loose file with no owning project keeps the picker's own source
    // derivation — there is no archive to point it at.
    if (info.kind !== 'project') return { kind: 'picker', epubArchivePath: null };

    if (info.sourceType !== 'epub') return { kind: 'picker', epubArchivePath: null };

    if (!info.archiveEpubPath) {
      return {
        kind: 'error',
        message: 'This EPUB project has no archived original, so its markup cannot be preserved. '
          + 'Re-import the book to rebuild the archive.',
      };
    }

    return { kind: 'picker', epubArchivePath: info.archiveEpubPath };
  }
}
