import { Injectable, inject } from '@angular/core';
import { ElectronService } from '../../../core/services/electron.service';

/** Which editor a project opens in, and everything that editor needs. */
export type EditorRoute =
  | { kind: 'picker' }
  | { kind: 'epub-flow'; epubPath: string; excluded: string[] }
  | { kind: 'error'; message: string };

/**
 * EditorRouteService — decides which editor a project opens in.
 *
 * There are TWO places that host an editor: the Studio's Editor tab
 * (`EditorTabComponent`) and the standalone editor window
 * (`EditorWindowComponent`). They must agree. When the EPUB document-flow editor
 * was first added only the window learned about it, so opening a book from the
 * tab silently kept the old picker — the decision lives here now so that cannot
 * happen again.
 *
 * The choice keys on `manifest.source.type`, NOT the file extension of whatever
 * version is currently selected: a project imported from an EPUB stays an EPUB
 * project forever, even though every later stage works on exported.epub.
 */
@Injectable({ providedIn: 'root' })
export class EditorRouteService {
  private electron = inject(ElectronService);

  /** `projectDir` is the project folder — what the editors call bfpPath. */
  async resolve(projectDir: string): Promise<EditorRoute> {
    const projectId = this.projectIdOf(projectDir);
    const result = await this.electron.manifestGet(projectId);

    if (!result.success || !result.manifest) {
      // No silent default to the picker: which editor opens decides what the user
      // is even able to edit, so a project we cannot identify must say so.
      return {
        kind: 'error',
        message: `Could not read this project's manifest (${projectId}): ${result.error ?? 'unknown error'}`,
      };
    }

    const manifest = result.manifest;
    if (manifest.source?.type !== 'epub') return { kind: 'picker' };

    // The flow editor reads the PRISTINE archived original — the only copy that
    // still carries the publisher's markup. exported.epub is a derivative and
    // using it would defeat the whole point of the EPUB path.
    const original = (manifest.archive ?? []).find(
      (a: { role?: string; format?: string }) => a.role === 'original' && /epub/i.test(a.format ?? ''),
    );
    if (!original?.path) {
      return {
        kind: 'error',
        message: 'This EPUB project has no archived original, so its markup cannot be preserved. '
          + 'Re-import the book to rebuild the archive.',
      };
    }

    return {
      kind: 'epub-flow',
      epubPath: `${projectDir}/${original.path}`,
      excluded: manifest.source?.deletedBlockIds ?? [],
    };
  }

  /**
   * Write `source/exported.epub` as the original minus the excluded elements, and
   * remember the selection so reopening the editor restores it.
   */
  async applySelection(
    projectDir: string,
    epubPath: string,
    excludedIds: string[],
  ): Promise<{ success: boolean; epubPath?: string; error?: string }> {
    const outputPath = `${projectDir}/source/exported.epub`;
    const exported = await this.electron.exportEpubWithDeletedBlocks(epubPath, excludedIds, outputPath);
    if (!exported.success) return { success: false, error: exported.error };

    const saved = await this.electron.manifestUpdate({
      projectId: this.projectIdOf(projectDir),
      source: { deletedBlockIds: excludedIds },
    });
    if (!saved.success) {
      // The EPUB is on disk and correct; only the remembered selection failed.
      // Report that plainly rather than as a clean success.
      return { success: false, error: `Exported, but the selection could not be saved: ${saved.error}` };
    }

    return { success: true, epubPath: outputPath };
  }

  private projectIdOf(projectDir: string): string {
    return projectDir.split(/[\\/]/).filter(Boolean).pop()!;
  }
}
