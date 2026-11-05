/**
 * position-sync.follow — carrying a position across: following between documents, and showing it on the sheet, the book or the table.
 */
import { effect } from '@angular/core';
import { positionPicture, positionView } from '@owen/foundry-core/shared/ledger';
import { fold } from '@owen/foundry-core/shared/original';
import { normalise, OpenDocumentsService, type Tab } from './documents.service';
import { LedgerService } from './ledger.service';
import { ShownPicture, PositionMove } from './position-sync.model';
import type { PositionSyncService } from './position-sync.service';

/**
 * Re-ask main which document each open project's position resolves to, and put
 * it on screen if the answer moved.
 *
 * ONE SWEEP AT A TIME. Two announces in quick succession — a rendering lands and
 * a catalogue is rewritten — would otherwise interleave two walks over the same
 * projects, each acting on the other's answer.
 *
 * ANY ANSWER IS DROPPED IF THE POSITION MOVED WHILE IT WAS IN FLIGHT, by
 * identity against `showing` exactly as `showPosition` does it: a click that
 * lands mid-sweep is newer than anything this was asking about.
 */
export async function followDocuments(this: PositionSyncService): Promise<void> {
  if (this.following) return;
  this.following = true;
  try {
    const asked = new Set<string>();
    for (const tab of this.documents.tabs()) {
      const dir = this.documents.projectDirOf(tab);
      if (dir === null) continue;
      const key = fold(dir);
      if (asked.has(key)) continue;
      asked.add(key);
      const now = this.showing.get(key);
      // Nothing has painted this project yet; the position effect baselines it
      // and this has nothing to compare against until it does.
      if (now === undefined) continue;
      const target = await this.ledger.documentAt(dir);
      if (this.showing.get(key) !== now) continue;
      const was = this.documentShown().get(key);
      this.rememberShown(key, target);
      if (was === undefined || was === target) continue;
      await this.showPosition({ key, dir, was: now, now }, target);
    }
  } finally {
    this.following = false;
  }
}

/**
 * What this project OUGHT to be showing, or null while nothing has read its
 * history.
 *
 * The view and the string it compares by are made together and never apart: a
 * caller holding one without the other would either compare pictures it cannot
 * act on or act on a picture it cannot compare.
 */
export function pictureIn(this: PositionSyncService, projectDir: string | null): ShownPicture | null {
  const history = this.ledger.historyFor(projectDir);
  if (history === null) return null;
  const view = positionView(history.ledger);
  return { view, picture: positionPicture(view) };
}

/**
 * Make the viewer show this project's position — the DOCUMENT first, and then
 * what is drawn over it.
 *
 * ── What a click used to be worth, and what the user said about it ──────────
 *
 * `b61bfab` made a pointer move drive the block editor's mode and which
 * corrections are drawn, and left the file underneath both of them exactly where
 * it was: `Tab.path` is fixed when a document is opened from the library and
 * nothing else ever moved it. So a project holding the scan and the reprint
 * made from its reading showed one of them however many rows were clicked —
 * *"switching between steps doesnt switch between the original pdf and the
 * rendered facsimile like i expected"* — and when there was nothing this could
 * change it put a sentence on the strip instead, which is the half the user was
 * angrier about: *"i wanted the document to show. instead of showing the
 * document, it gave me an error saying it couldnt show the document… it should be
 * showing me document"*.
 *
 * ── The ruling this is built to ─────────────────────────────────────────────
 *
 * CLICKING A ROW IS AN INSTRUCTION TO LOOK AT THAT STEP, and the app satisfies it
 * rather than explaining why it cannot. In order: swap the viewer to the step's
 * document; if that document is open but not the one shown, show it; if it is
 * not open at all, open it. Nothing here reports a state it could have fixed,
 * which is why this function no longer has a sentence to say.
 */
export async function showPosition(this: PositionSyncService, move: PositionMove, resolved?: string | null): Promise<void> {
  const view = move.now.view;
  /*
   * ASKED OF MAIN, EVERY MOVE, AND NEVER COMPOSED HERE. A project's layers are
   * main's bookkeeping — which folder holds the live copy, which of two readings
   * a reprint belongs to — and a renderer that spelled `working/<stem>.pdf` for
   * itself would be a second opinion that goes wrong exactly where it is dearest:
   * a branch read answering with the original reading's file. Main also admits
   * the answer to the viewer's allow-list on the way out, which this side cannot
   * do for itself. Null is the ordinary "this position names no document of its
   * own" and means keep the one we have.
   */
  const target = resolved !== undefined ? resolved : await this.ledger.documentAt(move.dir);
  /*
   * AND THE ANSWER IS DROPPED IF THE USER HAS MOVED AGAIN. Somebody clicking
   * down a history four rows deep issues four of these, and main answers them in
   * whatever order the disk feels like — so without this the viewer could settle
   * on the document of a row nobody is standing on any more, and stay there until
   * the next click. `showing` already holds the newest picture (the effect writes
   * it synchronously before starting any of this), so identity against it is the
   * whole test. It is `LedgerService`'s ticket, in the one other place that asks
   * main a question a later question can invalidate.
   */
  if (this.showing.get(move.key) !== move.now) return;
  /*
   * WHAT THE VIEWER IS NOW POINTED AT, remembered here because this is the one
   * place that knows it. `followDocuments` compares against it to notice a
   * document that changed under a position that did not move; recording it
   * anywhere else would be recording an intention rather than what happened.
   */
  this.rememberShown(move.key, target);
  /*
   * ── A READ ROW SHOWS THE BOOK, AND THAT IS THE SEAM MOVING AGAIN ──────────
   *
   * `documentAtPosition` answers a read row with the EPUB cast from its reading,
   * and every word of its own comment about why is still true — right up to the
   * ruling this wave is built on: *"we arent supposed to be rendering the book as
   * an epub… the user isnt reading a book on foundry, they're editing the
   * contents of a book"* (docs/RENDERER.md §0). The cast was the flowing document
   * while there was nothing else that flowed. There is now: the book file, drawn
   * as blocks on a proof sheet, which is the surface every op in R3 and after is
   * written against.
   *
   * SO A READ ROW OPENS THE BOOK TAB AND NOT THE CAST, and it is EITHER/OR
   * rather than both — one project, one viewer, one thing on screen. A row that
   * opened the sheet and then let `showDocument` put the EPUB beside it would be
   * two tabs for one instruction, and the second of them would be the surface
   * this wave exists to replace.
   *
   * CURATE AND TRANSLATE ROWS COME HERE TOO, AS OF R6b, and that sentence used
   * to say the opposite: they were left alone while their surfaces still struck
   * and relabelled through machinery the book had none of yet. It has all of it
   * now, and the surfaces they used are gone — a save's decisions are re-keyed
   * onto block ids and replayed like any other step's, and a translation's words
   * are in the derived book its landing wrote. Neither row has a document of its
   * own any more, because the per-step casts that were those documents are
   * deleted (docs/RENDERER.md §7). The test is `view.sheet` and it is asked in
   * one place, so there is no second door to drift from this one.
   *
   * AN EDIT ROW SHOWS THE BOOK TOO, and it is the same seam one action further
   * along. An `edit` step retains a file of ops against the book file's blocks
   * (docs/RENDERER.md §3) — there is no document of its own to point a viewer
   * at, and what it is ABOUT is the proof sheet — so it goes where a read row
   * goes and the sheet replays the chain up to it.
   *
   * AND AN IMPORTED EPUB'S ORIGIN ROW OPENS IT AS WELL, which is the third door
   * onto the same surface. A project that arrived as an EPUB has no read step and
   * will never have one — a bank models pages and an EPUB has none, so its book
   * is exploded straight out of the container (docs/RENDERER.md §6, the
   * refinement paragraph) — and the import is therefore the row that book
   * belongs to. Without this the click lands in `showDocument` and opens the
   * archived EPUB in the iframe reader, which is the surface the whole wave
   * exists to replace.
   *
   * THE TEST ITSELF LIVES IN `positionView`. It was spelled here and again,
   * differently, at the split door that used to sit beside it — two doors onto
   * one surface that disagreed about who may come through, which is a bug with
   * no symptom until somebody uses the second one. That second door went with
   * the columns; `sheet` is the one answer to "is the picture at this position
   * the proof sheet", asked in the module that already owns every other question
   * about a position.
   */
  /*
   * ── AND A MINT ROW SHOWS ITS PDF, LIKE EVERY OTHER IMPORT (Wave 41) ──────
   *
   * A third branch stood here — `view.pages` routing to `app-pages-view` —
   * because a minted book was a FOLDER of page images and the mint wrote no
   * container. It was Owen's Wave 34 answer to the click that did nothing:
   * *"when i do finalize, it creates 'this book' in the worktree. correct. but
   * when i click it, i expected it to take me to a pdf-like layout (even if we
   * havent assembled into a pdf officially yet) where i can scroll through each
   * page as it would look in a pdf."*
   *
   * The parenthesis is now spent: the mint assembles the PDF (`recordMint`,
   * electron/projects.ts), `documentOfStep` answers with it, and the row falls
   * to `showDocument` — which opens it in pdf.js. That is the sentence above
   * with the hedge removed, and it costs this function a branch instead of
   * buying it one.
   */
  /*
   * ── AND THE CAPTURE ROW SHOWS THE LIGHT TABLE, SAID OUT LOUD AT LAST ─────
   *
   * *"Standing on the capture step always shows the light table; standing on
   * the minted step shows the PDF."* (docs/CAPTURE.md, the surface section.)
   * The first half of that was true BY ACCIDENT until this wave: a capture row
   * names no document, so it fell to `showDocument`'s empty branch, which
   * reveals whichever of the project's tabs happens to be first — and a capture
   * project had exactly one tab, so the accident was indistinguishable from the
   * rule.
   *
   * It has two now. Leaving the promise resting on tab order would mean that
   * clicking *The photographs* showed you the pages you minted whenever the
   * table's tab had been closed and reopened, which is the door back to the
   * corners quietly going missing — the one thing docs/CAPTURE.md's own reword
   * was written to prevent.
   *
   * ASKED OF THE ACTION DIRECTLY rather than through a fourth field on
   * `positionView`, and the difference from `pages` beside it is the whole
   * argument: THAT test is `import` with a parent, which is a fact nobody reads
   * off a call site correctly, and it is asked by two layers that must agree.
   * This one is one word, asked in one place, and reads as what it means.
   */
  const swapped = view.sheet
    ? this.showBook(move)
    : view.step?.action === 'capture'
      ? this.showTable(move)
      : await this.showDocument(move, target);
  /*
   * AND NOTHING IS DONE TO THE SCAN'S PAGES, which is where a loop used to be.
   *
   * It turned the block editor on and off from `view.outlines` and re-read the
   * bank whenever the reading moved. That editor is deleted (docs/RENDERER.md
   * §7, A1): a scan is a photograph and this app shows it, so a pointer move
   * changes which DOCUMENT the viewer holds — done above — and nothing about how
   * it is drawn. `swapped` is still the answer this function owes its caller.
   */
  void swapped;
}

/**
 * Put the position's document on screen, and answer whether the pages moved.
 *
 * ── Three ways to satisfy one instruction ───────────────────────────────────
 *
 * ALREADY THE DOCUMENT ON THAT TAB: reveal it, which is a no-op when it is the
 * one on screen and SHOWS IT when it is not. That second case is the exact state
 * the app used to describe back at the user — their book was open, nothing was
 * showing it, and they were told to go and click it in the list. Doing it for
 * them is the whole of the fix.
 *
 * A PDF THIS PROJECT ALREADY HAS A TAB FOR: the tab MOVES to the new file
 * (`OpenDocumentsService.followTo`). One document per project in the viewer is
 * what makes "the viewer shows the step" true; opening the scan beside the
 * reprint would leave two tabs with the same book's name in the list and neither
 * of them following the pointer.
 *
 * ANYTHING ELSE: opened, through the one door every open in this app goes
 * through. That covers a translation's EPUB, which is emphatically NOT swapped
 * into a PDF tab — a book is UNPACKED, and patching a path would leave a viewer
 * serving chapters out of a tree belonging to a different book — and it covers a
 * project whose document nobody has open. `adopt` refuses to make a second tab
 * for a file already open, so this cannot double up.
 *
 * ── Which tab follows the pointer, when the project has several ─────────────
 *
 * The one ON SCREEN first, then any at all — and ONLY of the kind the target
 * is. A person who has both the scan and the cast EPUB open has two tabs of one
 * project, and swapping the EPUB's tab to a PDF because they clicked a read row
 * would take away the book they were reading to answer a question about the
 * pages.
 *
 * ── AND A CHANGE OF KIND IS AN OPEN, NEVER A PATCH ──────────────────────────
 *
 * The position's document can change KIND under a click: the import row answers
 * the scan and the read and curate rows answer the book. Patching a path across
 * that boundary would leave a PDF viewer pointed at a book — or an unpacked
 * book's viewer serving chapters out of a tree belonging to a scan — so the two
 * documents stay TWO TABS, and clicking between the steps swaps which of them
 * the viewer holds. That is why the flat list has to be able to hold both faces
 * of one book at once: nothing threads "this is a PDF" through the renderer, the
 * seam is position → document → show it (DERIVED-BOOK §7), and keeping both tabs
 * is what lets the viewer show whichever face the position names without
 * throwing the other away.
 *
 * The same-kind swap SURVIVES for PDF↔PDF, and it is worth keeping for the one
 * thing it does that opening cannot: `app-pdf-view` keeps the page you were on
 * when the path under it moves, and a scan re-opened as a second tab would land
 * you back at page one of a five-hundred-page book.
 */
export async function showDocument(this: PositionSyncService, move: PositionMove, target: string | null): Promise<boolean> {
  const mine = this.documents.tabs().filter((tab) => {
    const dir = this.documents.projectDirOf(tab);
    return dir !== null && fold(dir) === move.key;
  });
  if (target === null) {
    /*
     * NOTHING TO SWAP TO, AND STILL SOMETHING TO DO. A position with no document
     * of its own — a project with no reading yet, a payload since swept — is
     * still a row somebody clicked, so if none of this book's tabs is the one on
     * screen, one of them is put there. The instruction was "show me this step";
     * the honest answer is this book, where they can see it.
     */
    const first = mine[0];
    if (first === undefined) return false;
    if (mine.some((tab) => tab.id === this.stage.active())) return false;
    this.stage.reveal(first.id);
    return false;
  }

  const key = normalise(target);
  const already = mine.find((tab) => normalise(tab.path) === key);
  if (already !== undefined) {
    this.stage.reveal(already.id);
    return false;
  }

  /*
   * WHETHER FOUNDRY MADE THIS FILE, ASKED OF THE CATALOGUE RATHER THAN ASSUMED.
   * It is what the Chrome dot and the closing question are about: "no copy of
   * this exists anywhere you chose". True of a reprint and a translation; false
   * of the untouched original in `archive/`, which is in this app precisely
   * BECAUSE the user still has their own. Home draws one row per file type and
   * the archive is the layer it never draws, so a path the listing does not name
   * is the original — and false is the right answer for exactly that.
   */
  const madeByUs = this.projects.projectFor(target)?.documents
    .some((row) => normalise(row.path) === key && row.managed) === true;

  /*
   * AN EPUB IS NOT A DOCUMENT THIS APP SHOWS, and this is the one position that
   * can still name one: a translate step from before records, whose payload is
   * the book its run wrote. There is no viewer for it — the iframe reader is
   * deleted (docs/RENDERER.md §7) and pointing pdf.js at a zip would be a viewer
   * with "This PDF would not open" in it. So the row is honest instead: the file
   * is there, Reveal opens it, and the viewer keeps what it had.
   */
  if (key.endsWith('.epub')) {
    this.notices.notice.set(
      'That step is an EPUB written before Foundry kept translations as records, and Foundry no '
      + 'longer opens books as files — it edits the book itself. Reveal it from the library to '
      + 'read it, or translate again from the step it was made from.',
    );
    return false;
  }
  const follower = this.followerAmong(mine);
  if (follower === null) {
    await this.documents.openFile(target, madeByUs);
    return true;
  }
  this.documents.followTo(follower.id, target, madeByUs);
  this.stage.reveal(follower.id);
  return true;
}

/**
 * The PDF tab that follows the pointer: the one on screen, then any at all.
 *
 * It used to be three preferences deep (the focused column's, then any column's,
 * then any tab); the middle one was about which documents happened to be
 * arranged on screen, and with one viewer it collapses into the first.
 */
export function followerAmong(this: PositionSyncService, mine: readonly Tab[]): Tab | null {
  const pdfs = mine.filter((tab) => tab.kind === 'pdf');
  if (pdfs.length === 0) return null;
  const on = this.stage.active();
  return pdfs.find((tab) => tab.id === on) ?? pdfs[0]!;
}

/**
 * A PROJECT MET FOR THE FIRST TIME OPENS ON THE PICTURE ITS POSITION NAMES,
 * where that picture is the SHEET.
 *
 * ── The complaint ───────────────────────────────────────────────────────────
 *
 * *"when i open a file, it has the latest changes selected (applied changes,
 * simplify, whatever i did last) but it has the original file opened in the main
 * tab. i have to click to the original file and back to the applied changes to
 * get it to pull up the current system. it should start on the latest change,
 * not on the original file."*
 *
 * Two selectors, one of them right. The rail reads the ledger the moment the
 * history lands and highlights the tip correctly; the viewer holds whatever file
 * the open gesture named, which for every door in this app is the project's
 * ORIGINAL. Nothing reconciled them, because the first-sighting rule above
 * (correctly) refuses to read "a tab appeared" as a pointer move — so the viewer
 * sat on the import while the rail said Applied changes, and the two clicks the
 * user describes are them driving the position effect by hand to make it act.
 *
 * ── Why the sheet is the whole of the exception ─────────────────────────────
 *
 * Because the sheet is not a DOCUMENT the position resolves to — it is the
 * picture the position IS. `showDocument`'s cases all swap or open a file, which
 * on a first sighting would mean an open gesture that named a file answering with
 * a different one; the hosted "open THIS file" door (electron/mount.ts) is
 * exactly that gesture, and it is entitled to land where it was pointed. The
 * sheet takes nothing away: the original's tab is still open, still listed in
 * the library, still one click off. So the correction ADDS the surface the
 * position names and never removes the one that was asked for.
 *
 * `positionView.sheet` is the same test `showPosition` asks (read, edit, curate,
 * translate, and an EPUB's own import row), asked in the same place, so there is
 * no second opinion about which rows have a sheet.
 *
 * ── It is `openProject`'s patch, generalised ────────────────────────────────
 *
 * Home's row click carried this correction on its own — the one door with a
 * project directory in hand — which is why opening a book from the library had
 * always been right and opening the same book by dropping it, by File→Open, by a
 * click in the library panel or by the host's deep link had not. Every one of
 * those funnels through a tab in a project, which is what this effect keys on, so
 * moving the rule here is what makes the guarantee the app's rather than one
 * caller's.
 */
export function openTheSheet(this: PositionSyncService, move: PositionMove): void {
  if (move.now.view.sheet) {
    this.showBook(move);
    return;
  }
  /*
   * A SECOND ARM STOOD HERE (Wave 41's gravestone) opening a minted project's
   * PAGES, because a capture project had no document to open and every door
   * into one therefore showed the LIGHT TABLE — right for a project being
   * photographed and wrong for one whose pointer is on a book it had already
   * made. Somebody who minted yesterday, quit, and reopened would have been put
   * in front of the photographs with the row they were standing on highlighted
   * in the tree beside them.
   *
   * A minted project has an original now, so `openProject` (home.component.ts)
   * takes the ordinary door and lands on the position like any other book, and
   * `showPosition` above puts the right thing on screen. The correction is made
   * one layer up, where it is made for every project.
   */
}

/**
 * Put the project's BOOK on screen — the proof sheet, not a file.
 *
 * ── One per project, forever ────────────────────────────────────────────────
 *
 * There is exactly one book in a project and one tab for it. Everything else
 * that opens something has to decide between a swap and a second tab, because
 * two paths can be two documents of one project; here there is nothing to
 * decide, because the tab does not name a file at all — it names the project,
 * and main answers with whatever the position's reading reflowed to. A book tab
 * that is already open is therefore already correct for any read row of that
 * project, and showing it is the whole of the work.
 *
 * IT SIMPLY BECOMES WHAT IS ON SCREEN. This used to have to work out WHICH
 * COLUMN the project was already being read in, so that a person reading two
 * books did not have this one arrive in the other one's column, and it used to
 * consume the "Open in split" intention on its way past. Both were arithmetic
 * about furniture; with one viewer the answer to "where does it go" is the only
 * place there is.
 *
 * ANSWERS FALSE, ALWAYS: the boolean its caller wants is "did the PAGES under
 * the block editor move", and nothing here points a PDF viewer anywhere.
 */
export function showBook(this: PositionSyncService, move: PositionMove): boolean {
  const id = this.documents.bookTabIn(move.dir);
  /*
   * AND IT RE-ASKS FOR THE BOOK, which showing alone does not do.
   *
   * *"Standing on any step = replay of that chain."* (docs/RENDERER.md §3.) The
   * sheet's rows and its op chain both come from one call to main, and that call
   * is keyed to the POSITION — so a move from a read row onto an edit row, or
   * between two edit rows of one reading, changes what `book:load` would answer
   * while the tab's own path (the project directory) does not move an inch.
   * Without a revision the sheet would sit there showing the book as of whatever
   * row it last loaded, which is precisely the complaint the position effect
   * exists to answer: clicking a row in your own history and watching the app do
   * nothing.
   *
   * ONLY ON A MOVE. This runs from `showPosition`, which the effect only reaches
   * when the picture genuinely changed (`positionPicture` carries the edit chain
   * for exactly this), so showing a tab or clicking the row you are already
   * standing on costs nothing.
   */
  this.documents.bumpRevision(id);
  this.stage.reveal(id);
  return false;
}

/*
 * ── GRAVESTONE: `showPages` (Wave 41) ─────────────────────────────────────
 *
 * `showBook` with one word changed: one tab per project, named by the
 * directory, contents re-asked whenever the pointer moved — over the folder of
 * rectified page images a mint had written rather than over the project's
 * blocks. The revision bump did more work here than it does for the book,
 * because a project can hold TWO mints and standing on either row is two
 * different books behind one tab path.
 *
 * A mint writes a PDF, so a minted row is a document row and `showDocument`
 * shows it — and the two-mints case it existed for is served by the same
 * machinery that serves a re-import: `documentOfStep` resolves the STEP's own
 * payload, so standing on the older mint opens the older mint's book.
 */

/**
 * Put the project's LIGHT TABLE on screen — the photographs and their recipe.
 *
 * NO REVISION BUMP, and that is the one line of difference from the two above
 * it. The book and the pages are both resolved AT THE POSITION, so a move
 * between two rows changes what main would answer while the tab's path stands
 * still — a re-ask is the only way the surface hears about it. A light table is
 * not: there is exactly one recipe in a capture project, `CaptureService` holds
 * it and writes it as gestures are made, and re-asking would throw away the
 * open photograph and the pass somebody was in the middle of to reload a
 * document that had not changed.
 *
 * ANSWERS FALSE for `showBook`'s reason — no PDF viewer is pointed anywhere.
 */
export function showTable(this: PositionSyncService, move: PositionMove): boolean {
  this.stage.reveal(this.documents.captureTabIn(move.dir));
  return false;
}
