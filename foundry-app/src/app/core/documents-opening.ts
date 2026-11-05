/**
 * documents-opening — every way a document or a project comes to be open in a tab.
 */
import { effect } from '@angular/core';
import { fold } from '@owen/foundry-core/shared/original';
import type { JobKind } from '@owen/foundry-core/shared/types';
import { api } from './foundry';
import { pathIsProject, Tab, normalise } from './documents-tabs';
import type { OpenDocumentsService } from './documents.service';

// ── Opening ──────────────────────────────────────────────────────────────

/** The rail's and Home's Open button. The tab arrives on `document:opened`. */
export async function openViaDialog(this: OpenDocumentsService): Promise<void> {
  await api?.openDocumentDialog();
}

/**
 * A drop. Main decides whether the path is openable; a refusal is SAID rather
 * than ignored, because a file that lands in the window and does nothing is
 * indistinguishable from a broken app.
 */
export async function openDropped(this: OpenDocumentsService, file: File): Promise<void> {
  if (!api) return;
  const candidate = api.pathForFile(file);
  if (!candidate) return;
  const admitted = await api.openPath(candidate);
  if (admitted === null) {
    this.notices.notice.set(`${file.name} is not something Foundry opens — it reads PDFs and the EPUBs it casts.`);
  }
}

/**
 * The library's click on a row nothing has opened yet — including an EXPORT
 * row, which is a file in `final/` and opens like any other document.
 *
 * IT REPLACES WHAT IS ON SCREEN, which is what every door does now — the user's
 * rule about browsing (*"clicking another file will automatically close the one
 * i was looking at and open the one i just clicked"*) with its exception, the
 * pin, taken away by the single-viewer ruling. So there is no flag: this is
 * `openFile`, and it is kept as a name because the LIST is the thing the ruling
 * was about and a caller that reads as "the library's click" is worth having.
 *
 * NOTHING IS CLOSED BY IT EITHER. Replacing used to close the tab it displaced
 * — a strip that accumulated documents nobody asked for was the thing the rule
 * guarded against — and with one flat list there is nothing to accumulate. The
 * displaced document stays open, in the library, one click from coming back,
 * and closing it is still the ✕ that has always meant that.
 */
export async function openFromList(this: OpenDocumentsService, filePath: string, managed = false): Promise<void> {
  await this.openFile(filePath, managed);
}

/**
 * Open a PROJECT — Home's row click — which is a different gesture from
 * opening a file, because a project has a POSITION and the position decides
 * what belongs on screen.
 *
 * ── The complaint this answers ──────────────────────────────────────────────
 *
 * Opening a project put the ORIGINAL document in the viewer while the position
 * stood on the newest step — an edit row, whose picture is the proof sheet —
 * and the first-sighting rule (correctly) refuses to read "a tab appeared" as
 * a move, so nothing ever corrected it. The user had to click the import row
 * and then back down to their edits to see the book they left off in.
 *
 * ── Why the original still opens first ──────────────────────────────────────
 *
 * The `openPath` round trip is where main records the recent — the fact Home
 * orders its rows by — and the adopted tab is the project's document face,
 * grouped in the library where flipping to it is one click. So the original
 * opens exactly as it always has, and then, WHERE THE POSITION'S PICTURE IS THE
 * SHEET, the book goes on top: the same end state the user was building by
 * hand, in one click.
 *
 * THAT SECOND HALF IS NOT SPELLED HERE. It is `openTheSheet`
 * (`PositionSyncService`), on the position effect's first sighting, because
 * every other door into a project — a drop, File→Open, a click in the library,
 * the host's deep link — owed the same correction and none of them had a
 * project directory to write it against. What this method still owes is the
 * REFRESH: that effect has no picture to obey until somebody has read the
 * history, and a project opened from Home has usually never been seen by this
 * window's ledger mirror.
 *
 * A project standing on the import keeps today's behaviour: the position's
 * surface IS the document, and `view.sheet` is false there for a scan. An
 * imported EPUB's origin row answers sheet=true (positionView owns that test),
 * so such a project opens onto its book — the only surface it has.
 */
export async function openProject(this: OpenDocumentsService, projectDir: string, originalPath: string | null, managed = false): Promise<void> {
  /*
   * NO DOCUMENT MEANS THE LIGHT TABLE, which is the same answer Home's row
   * gives for the same project (`openProject`, home.component.ts). A captured
   * book has no catalogued document before its first mint and none after one
   * either, so a host's Edit-in-Foundry has to land somewhere — and the
   * surface the person was working on is the table.
   */
  if (originalPath === null) this.show(this.captureTabIn(projectDir));
  else await this.openFile(originalPath, managed);
  if (this.ledger.historyFor(projectDir) === null) await this.ledger.refresh(projectDir);
}

/** Open a path this window already knows about: Home's list, the shelf's Open. */
export async function openFile(this: OpenDocumentsService, filePath: string, managed = false): Promise<void> {
  if (!api) return;
  const key = normalise(filePath);
  if (managed) this.expectUnsaved.add(key);
  const admitted = await api.openPath(filePath);
  if (admitted === null) {
    this.expectUnsaved.delete(key);
    // NAMED, NOT SPELLED OUT. A path in the notice is this app showing its own
    // bookkeeping to somebody who asked for a book — and the whole path was
    // never readable in one line of a notice anyway. The row that failed to
    // open still carries the path in its tooltip, which is where a person
    // debugging their own library goes looking.
    this.notices.notice.set(`${this.nameFor(filePath)} is no longer there.`);
  }
}

/**
 * A rendering's output: unsaved, and put in front of the person who ordered it.
 *
 * ── A NEW FILE UNDER AN OLD NAME ───────────────────────────────────────────
 *
 * Generating a real-text PDF appeared to do nothing at all. The run finished,
 * the shelf said so, and the page on screen did not change — because a
 * PDF-producing rendering REPLACES the project's live PDF at the same path
 * (`refreshLivePdf`), `adopt` finds a tab already on that path and merely
 * shows it, and `app-pdf-view` re-reads only when the path STRING changes.
 * Same name, new bytes, and every layer of the app faithfully concluded there
 * was nothing to do.
 *
 * So a document already open is SHOWN AND RELOADED. The revision bump is
 * this app's own idiom for exactly this — it is what makes an edited chapter
 * repaint in an <iframe> pointed at a URL it is already showing — and the PDF
 * viewer now watches it for the same reason.
 *
 * A document that is NOT open takes the ordinary path and opens fresh.
 *
 * ── AND IT SIMPLY BECOMES WHAT IS ON SCREEN ────────────────────────────────
 *
 * There used to be an argument here about WHERE it landed. A translation asked
 * for a column of its own, because it runs for hours and the whole point of it
 * appearing is that it can be read against the source; a reading's cast book
 * asked to join the column its project was already in, because it is another
 * face of the same book and a column nobody arranged is furniture in the way.
 * Both halves of that go with the columns: the finished thing is put in front of
 * the person who ordered it, and reading it against the source is Compare's job
 * (docs/PLAN.md §4, unit 8d) rather than the side effect of a job finishing.
 *
 * `kind` SURVIVES IN THE SIGNATURE AND IS NOT READ. It is what told the
 * translation from the rest, and it is left in place because the caller has it
 * and the set of kinds that open themselves is the thing most likely to want it
 * back — the alternative is a parameter deleted here and re-threaded there.
 */
export function openFinished(this: OpenDocumentsService, filePath: string, kind: JobKind): void {
  void kind;
  const key = normalise(filePath);
  const already = this.all().find((tab) => normalise(tab.path) === key);
  if (already) {
    this.show(already.id);
    this.patch(already.id, { revision: already.revision + 1, unsaved: true, savedPath: null });
    return;
  }
  void this.openFile(filePath, true);
}

/**
 * OPEN A FINISHED EXPORT IN A TAB — the proof sheet over the file itself.
 *
 * The click model is the user's (2026-08-16): left-click an export leaf opens
 * it, Ctrl+S saves a copy somewhere else, and the context menu carries the
 * rest. What the tab shows is the export EXPLODED — the same derivation an
 * imported EPUB gets — locked to the Final version register, because what the
 * file contains is a finished book and the finished-book projection is the
 * honest way to look at one. One tab per file, like every document.
 */
export function openExportView(this: OpenDocumentsService, path: string, title: string): void {
  const key = fold(path);
  const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
  if (already !== undefined) {
    this.show(already.id);
    return;
  }
  const made: Tab = { ...this.blankTab('book', path, title), viewOnly: true };
  this.all.update((tabs) => [...tabs, made]);
  this.show(made.id);
}

/**
 * This project's book tab, made if it has none yet. Never a second one.
 *
 * MADE HERE RATHER THAN THROUGH `openFile`, and that is not a shortcut past a
 * gate. Every other tab in this app is made by `adopt`, on main's own
 * `document:opened` announcement, because main is what decides whether a path
 * may be opened at all. There is no path here to decide about: the tab is the
 * PROJECT, its rows arrive over an IPC that admits nothing (`book.load`,
 * shared/api.ts), and a door answering "yes, you may open this directory" would
 * be a door granting access to a folder for being asked about it.
 *
 * PUBLIC SINCE THE SPLIT, because `PositionSyncService.showBook` is what asks
 * for it — a read row's picture IS this tab. It stays here rather than going
 * with its caller because it is a TAB FACTORY: it makes an id, names it from
 * the project catalogue and appends it to the flat list, which are three things
 * only this file does. It returns the id and shows nothing; the caller decides
 * that, exactly as it does for a tab that already existed.
 */
export function bookTabIn(this: OpenDocumentsService, projectDir: string): string {
  const key = fold(projectDir);
  const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
  if (already !== undefined) return already.id;
  const made = this.blankTab('book', projectDir, this.projectTitleOf(projectDir));
  this.all.update((tabs) => [...tabs, made]);
  return made.id;
}

/**
 * This project's LIGHT TABLE tab, made if it has none yet. Never a second one.
 *
 * `bookTabIn` one flight up with one word changed, and deliberately not
 * generalised with it: the two differ in what they are FOR, and a shared
 * factory taking a kind would be a function whose two callers share only the
 * three lines that any tab factory has. What they do share — that the path is
 * a project directory — is `pathIsProject`, which is the part worth naming.
 *
 * Made here rather than through `openFile` for the same reason a book tab is:
 * there is no path for main to decide about. The recipe arrives over
 * `capture:recipe-load`, which admits nothing, and a door answering "yes, you
 * may open this directory" would be a door granting access to a folder for
 * being asked about it.
 */
export function captureTabIn(this: OpenDocumentsService, projectDir: string): string {
  const key = fold(projectDir);
  const already = this.all().find((tab) => tab.kind === 'capture' && fold(tab.path) === key);
  if (already !== undefined) return already.id;
  const made = this.blankTab('capture', projectDir, this.projectTitleOf(projectDir));
  this.all.update((tabs) => [...tabs, made]);
  return made.id;
}

/*
 * ── GRAVESTONE: `pagesTabIn` (Wave 41) ─────────────────────────────────────
 *
 * This project's PAGE VIEW tab, made if it had none. It existed for Owen's
 * *"i expected it to take me to a pdf-like layout (even if we havent assembled
 * into a pdf officially yet) where i can scroll through each page as it would
 * look in a pdf"*, and it was one tab per project with the POSITION deciding
 * which mint's pages it drew — the book tab's shape, over pictures.
 *
 * The mint assembles the PDF now, so a minted row opens through `openFile`
 * like any other document and lands in a `pdf` tab. The light table keeps its
 * own tab (`captureTabIn`, above) because the photographs stay editable after a
 * mint — that is what makes a re-mint possible at all.
 */

/**
 * The single tab factory. Shows an existing tab for the same file rather
 * than opening a second — two tabs onto one book are two scroll positions
 * fighting over one document, and two viewers onto one unpack.
 */
export function adopt(this: OpenDocumentsService, absolutePath: string): void {
  const key = normalise(absolutePath);
  /*
   * DRAINED BEFORE THE EPUB BRANCH AND NOT AT THE POINT OF USE, which is the
   * only reason this line is up here: that branch returns without making a tab,
   * and an expectation left in the set by a path that never takes one is an
   * entry nothing will ever clear. (It had three siblings saying where the tab
   * should land; those went with the columns.)
   */
  const unsaved = this.expectUnsaved.delete(key);
  const existing = this.all().find((tab) => normalise(tab.path) === key);
  if (existing) {
    this.show(existing.id);
    return;
  }

  /*
   * ── AN EPUB OPENS AS A BOOK, NOT AS A FILE ────────────────────────────────
   *
   * It used to become an `epub` tab: main unpacked it into a working tree and
   * served the chapters to an iframe. Both are deleted (docs/RENDERER.md §7),
   * and what replaced them is the thing the container was always standing in
   * for — an imported EPUB explodes into the BOOK FILE (§6, R6a), and the book
   * is what the proof sheet draws.
   *
   * SO NO TAB IS MADE HERE. Main has already started the import (`openDocument`,
   * electron/documents.ts) and `awaitBook` opens the project's sheet the moment
   * there is a project to open it for — which is usually a moment later, and is
   * immediate for an EPUB already in the library.
   */
  if (key.endsWith('.epub')) {
    this.awaitBook(absolutePath);
    return;
  }
  const tab = this.blankTab('pdf', absolutePath, this.nameFor(absolutePath));
  tab.unsaved = unsaved;
  this.all.update((tabs) => [...tabs, tab]);
  // A NEW DOCUMENT IS THE ONE YOU ARE LOOKING AT, which is the whole of what
  // `place` used to work out across five columns and three expectation sets.
  this.show(tab.id);
}

export function awaitBook(this: OpenDocumentsService, filePath: string): void {
  this.awaitingBooks.add(normalise(filePath));
  this.openAwaitedBooks();
}

/** Every awaited EPUB whose project this window can now see. */
export function openAwaitedBooks(this: OpenDocumentsService): void {
  for (const key of [...this.awaitingBooks]) {
    const dir = this.projects.projectFor(key)?.dir ?? null;
    if (dir === null) continue;
    this.awaitingBooks.delete(key);
    this.show(this.bookTabIn(dir));
  }
}
