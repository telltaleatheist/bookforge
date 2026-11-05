/**
 * documents-saving — a document's edits and its way back to disk.
 */
import { api } from './foundry';
import { Tab, baseName, suggestName } from './documents-tabs';
import type { OpenDocumentsService } from './documents.service';

/**
 * Something outside this service edited the document on disk.
 *
 * Today that is the Metadata dialog, which writes the package (or the working
 * PDF) through the engine rather than through any of the member writes above.
 * The flag it sets is the one that matters: the working copy has moved ahead
 * of whatever was last filed, so Save has work to do.
 *
 * NO REVISION BUMP, deliberately. Nothing in any chapter's markup moved, and
 * reloading the rendered viewer would cost the reader their place in order to
 * repaint a page that looks identical.
 */
export function noteDocumentEdited(this: OpenDocumentsService, id: string): void {
  this.patch(id, { modified: true });
}

// ── Saving ───────────────────────────────────────────────────────────────

/**
 * Ctrl/Cmd+S — which, for everything this app still opens, is Save As.
 *
 * NOTHING IN THIS APP EDITS A FILE ANY MORE. A book is not a file at all (see
 * `saveAs`), and a scan is a photograph the app only ever reads — so there is
 * no destination a silent re-save could write to that would carry anything the
 * previous copy did not. The one thing Ctrl+S can do is ask where, which is
 * exactly what Save As is; the branch that repacked a working tree over the
 * file it came from went with the working tree (docs/RENDERER.md §7).
 */
export async function save(this: OpenDocumentsService, id: string): Promise<void> {
  await this.saveAs(id);
}

/**
 * Ctrl/Cmd+Shift+S. Always the picker.
 *
 * A PDF saves as a COPY of the finished file: a conversion's output lives in
 * the workspace until this puts it somewhere the user chose, and that is the
 * whole difference between "foundry made me a PDF I can read" and "there is a
 * PDF I can read in a folder I know about". It is the only kind that saves at
 * all: the book is not a file, and Export is the door a finished copy of it
 * leaves by.
 */
export async function saveAs(this: OpenDocumentsService, id: string): Promise<void> {
  const tab = this.byId(id);
  if (!api || !tab) return;
  /*
   * THE BOOK IS NOT A FILE, so there is nothing for a picker to write. It is
   * made from the pages this project was read from and it is remade from them at
   * will; what a person actually wants from Save here is a finished copy, which
   * is Export — the door that renders the position through the whole ledger and
   * files the result. Said rather than silently ignored, because a chord that
   * does nothing reads as a broken app.
   */
  if (tab.kind === 'book') {
    this.notices.notice.set(
      `${tab.title} is the book itself, not a file — Export files a finished copy of it.`);
    return;
  }
  if (tab.kind === 'capture') {
    // Same shape, different sentence: there is no book here yet to export, and
    // the thing a person would want saved does not exist until they mint it.
    this.notices.notice.set(
      `${tab.title} is a table of photographs, not a file — Mint makes the pages, and they `
      + 'are saved into the project as they are made.');
    return;
  }
  /*
   * A THIRD BRANCH STOOD HERE for a `pages` tab (Wave 41's gravestone), saying
   * that the pages were a folder rather than a file and that the container a
   * Save would have produced was not built yet. It is built: the mint writes
   * it, so a minted book reaches the ordinary Save below and copies out as the
   * PDF it is.
   */
  try {
    const destination = await api.documentSaveCopy(
      tab.path, suggestName(baseName(tab.path), '.pdf'));
    if (destination === null) return;
    this.patch(tab.id, { unsaved: false, savedPath: destination });
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/**
 * SAVE A COPY OF A FINISHED EXPORT — Ctrl+S over an export view.
 *
 * The user's own reading of the chord (2026-08-16). The tab's file is finished
 * and already filed in the project's tray; "save" over it can only mean "put a
 * copy where I choose", which is the export door's dialog. Both chords say it,
 * because Save and Save As collapse to one meaning over a file this app will
 * never rewrite.
 *
 * IT IS A DOOR OF ITS OWN SINCE THE SPLIT because the branch that chose it —
 * "is the document in front of me an export view?" — is a question about what
 * is ON SCREEN, and that moved to `StageService`. The saving is still this
 * file's, so the stage asks and this answers.
 */
export async function saveExportCopy(this: OpenDocumentsService, tab: Tab): Promise<void> {
  await api?.saveExport(tab.path).catch((err: unknown) => {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  });
}
