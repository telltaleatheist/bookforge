import { Injectable, inject } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

/** Which editor a project opens in, and everything that editor needs. */
export type EditorRoute =
  | { kind: 'picker' }
  | { kind: 'epub-flow'; projectDir: string; epubPath: string; excluded: string[] }
  | { kind: 'error'; message: string };

/**
 * EditorRouteService — decides which editor a document opens in.
 *
 * There are TWO places that host an editor: the Studio's Editor tab
 * (`EditorTabComponent`) and the standalone editor window
 * (`EditorWindowComponent`). They must agree. When the EPUB document-flow editor
 * was first added only the window learned about it, so opening a book from the
 * tab silently kept the old picker — the decision lives here now so that cannot
 * happen again.
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
      // No silent default to the picker: which editor opens decides what the user
      // is even able to edit, so a path we cannot identify must say so.
      return { kind: 'error', message: `Could not open "${target}": ${info.error ?? 'unknown error'}` };
    }

    // A loose file with no owning project keeps the picker. The flow editor's
    // whole purpose is writing source/exported.epub inside a project pipeline and
    // remembering the selection in a manifest, neither of which exists here.
    if (info.kind !== 'project') return { kind: 'picker' };

    if (info.sourceType !== 'epub') return { kind: 'picker' };

    if (!info.archiveEpubPath) {
      return {
        kind: 'error',
        message: 'This EPUB project has no archived original, so its markup cannot be preserved. '
          + 'Re-import the book to rebuild the archive.',
      };
    }

    return {
      kind: 'epub-flow',
      projectDir: info.projectDir!,
      epubPath: info.archiveEpubPath,
      excluded: info.deletedBlockIds ?? [],
    };
  }

  /**
   * Write `source/exported.epub` as the original minus the excluded elements and
   * remember the selection. Both halves happen in one main-process call so they
   * cannot half-apply.
   */
  applySelection(
    projectDir: string,
    epubPath: string,
    excludedIds: string[],
  ): Promise<{ success: boolean; epubPath?: string; error?: string }> {
    return this.electron.applyEpubFlowSelection(projectDir, epubPath, excludedIds);
  }
}
