import { Injectable, effect, inject, signal, untracked } from '@angular/core';

import { positionPicture, positionView, type PositionView } from '@owen/foundry-core/shared/ledger';
import { fold } from '@owen/foundry-core/shared/original';

import { normalise, OpenDocumentsService, pathIsProject, type Tab } from './documents.service';
import { LedgerService } from './ledger.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { StageService } from './stage.service';
import { api } from './foundry';
import { ShownPicture, PositionMove } from './position-sync.model';
import * as follow from './position-sync.follow';

@Injectable({ providedIn: 'root' })
export class PositionSyncService {
  readonly documents = inject(OpenDocumentsService);
  readonly stage = inject(StageService);
  readonly notices = inject(NoticeService);
  readonly projects = inject(ProjectsService);

  /**
   * The step ledger, read for the POSITION — which step each project is standing
   * on, and what document that resolves to.
   *
   * It was also read for a gate: may this document be corrected right now? That
   * question had an answer while there were two curations to write into and
   * standing on a save decided which one a gesture reached. Standing on any step
   * is a replay of that chain now (docs/RENDERER.md §3), editing from an old one
   * branches, and there is nothing to diverge — so the gate is gone and this is
   * the position and nothing else.
   *
   * The dependency runs ONE WAY. `LedgerService` knows about projects and the
   * confirm card and nothing about documents; everything this side wants to
   * happen to the viewer after a step changed is arranged here.
   */
  readonly ledger = inject(LedgerService);

  constructor() {
    /**
     * THE POINTER MOVED, SO THE VIEWER SHOWS THE STEP THE USER IS STANDING ON.
     *
     * ── What clicking a row used to do, which was very nearly nothing ────────
     *
     * `docs/STEP-LEDGER.md` has promised since the day the ledger was designed
     * that the position decides what the viewers show, and this effect used to
     * keep about a third of that promise. It re-read the CURATION and left the
     * blocks under it exactly where they were, which is correct only while both
     * rows are about one reading: move between two readings and the viewer went on
     * drawing the first reading's boxes with the second reading's corrections over
     * them, silently, with nothing on screen admitting the swap. And it was
     * guarded on the viewer already being in the block editor, so for a scan nobody
     * had pressed Blocks on — and for the import row, where the honest picture is
     * no outlines at all — a click on a row in somebody's own history did
     * literally nothing. That is what a user with a two-step project saw: they
     * clicked the import, they clicked the read, and the app sat there.
     *
     * ── What it does now: make the viewer match the answer ───────────────────
     *
     * `positionView` (shared/ledger.ts) says what the picture at the position IS —
     * which reading's bank, which corrections over it, whether there are outlines
     * at all — and this effect's whole job is to make the viewer, where it is
     * pointed at that project, agree with it. Nothing here re-derives any of
     * that; the day a read row comes to mean a reflowed HTML document rather than
     * a scan with boxes on it (docs/DERIVED-BOOK.md §6 phase B), the answer
     * changes shape and this loop does not.
     *
     * A MOVE THAT CHANGES THE BANK RELOADS; A MOVE THAT CHANGES ONLY THE
     * CORRECTIONS DOES NOT. Re-reading a bank is a spawn of the engine and a
     * re-measure of five hundred pages, and putting that behind the one gesture in
     * this app that is meant to be free is the exact ceremony a history panel
     * promises it does not have. So a save and the reading it was made from — two
     * rows, one bank — cost one small file read between them, and only a genuinely
     * different reading pays for the blocks. `positionPicture` is what makes that
     * distinction; the step id would have been wrong in both directions.
     *
     * ── Keyed by PROJECT, and the first sighting is a baseline ───────────────
     *
     * By project because the position is a fact about a book rather than about a
     * viewer of one. It stays keyed that way with a single viewer because the
     * memory it holds is per BOOK: five books can be open with one on screen, and
     * the four that are not still have a position this window has to remember
     * having painted.
     *
     * THE FIRST SIGHTING RECORDS, AND MOVES NOTHING EXCEPT ONTO THE SHEET.
     * Opening a document must not be read as a move: a pointer move is a
     * DIFFERENCE from what this window was last showing, and a project it has
     * never seen has no difference to be. The entry is dropped again when the last
     * tab of that project closes, so a reopen baselines afresh rather than
     * inheriting a picture from a session nobody is in any more.
     *
     * BUT A SHEET POSITION IS NOT A DIFFERENCE — IT IS THE PICTURE. See
     * `openTheSheet` below for the complaint, and for why the exception is exactly
     * the sheet and nothing wider.
     */
    effect(() => {
      const moves: PositionMove[] = [];
      const open = new Set<string>();
      for (const tab of this.documents.tabs()) {
        const dir = this.documents.projectDirOf(tab);
        if (dir === null) continue;
        const key = fold(dir);
        if (open.has(key)) continue;
        open.add(key);
        const now = this.pictureIn(dir);
        // Nobody has read this project's history yet, so there is no position to
        // obey. It arrives as its own change and is baselined then.
        if (now === null) continue;
        const was = this.showing.get(key) ?? null;
        if (was !== null && was.picture === now.picture) continue;
        moves.push({ key, dir, was, now });
      }
      /*
       * WHERE THE DOCUMENT WOULD GO IS NO LONGER READ HERE, and its absence is
       * the ruling rather than an oversight. This used to track which columns
       * were open, so that a move with nowhere to be shown could put a sentence
       * on the notice strip and then re-ask once a column appeared. There is no
       * such state any more, and with one viewer there cannot be: clicking a row
       * is an instruction to LOOK at that step, so a document that is open is
       * shown and a document that is not open is opened. The app does the thing
       * instead of explaining why it cannot.
       */
      untracked(() => {
        for (const key of [...this.showing.keys()]) {
          if (!open.has(key)) {
            this.showing.delete(key);
            // The resolved document goes with the picture it belonged to, for the
            // same reason: a reopen baselines afresh rather than measuring against
            // what a session nobody is in was showing.
            this.forgetShown(key);
          }
        }
        for (const move of moves) {
          this.showing.set(move.key, move.now);
          if (move.was === null) {
            /*
             * THE FIRST SIGHTING STILL MOVES NOTHING, AND IT NO LONGER LEAVES THE
             * DOCUMENT UNKNOWN.
             *
             * It used to `continue` outright, which was right while the resolved
             * document was bookkeeping for `followDocuments` alone. It is not any
             * more: the rail and the dialogs ask what document the position is
             * showing before they decide what a button does (docs/WORKBENCH.md
             * §6c), and a project met a moment ago answered "I do not know" —
             * which is how Translate came to sit dead over a book that was
             * plainly on screen. Nothing here is put on screen by asking; it
             * records what the position resolves to, exactly as the sweep does on
             * every announce, so that the first question a button asks has an
             * answer.
             */
            void this.baselineShown(move.dir, move.key);
            this.openTheSheet(move);
            continue;
          }
          void this.showPosition(move);
        }
      });
    });

    /**
     * THE POSITION DID NOT MOVE AND THE DOCUMENT UNDER IT DID.
     *
     * ── Why the picture above cannot see this by itself ────────────────────────
     *
     * `positionPicture` (shared/ledger.ts) is composed of the reading, the
     * corrections and — for a row that shows its own payload — the row: the three
     * things the LEDGER knows that decide what is on screen. Which file a read row
     * actually resolves to is not one of them, and cannot be: it is main's
     * bookkeeping, answered over IPC (`ledger:document-at`), and the effect above
     * is synchronous. So a project standing still while its document changes
     * underneath is invisible to that key by construction.
     *
     * And it changed, on the path this app cared most about, for as long as a
     * position could resolve to one document and then to another: main answered a
     * read row that came back as the scan by casting the book, so seconds later
     * the same position resolved to an EPUB with nothing in the ledger having
     * moved. There are no casts now (docs/RENDERER.md §7) and a read row is drawn
     * on the sheet, so that particular swap cannot happen — but the effect stays,
     * because the reason it was built is the complaint it was built for: *"i
     * wanted the document to show."*
     *
     * ── An effect of its own, on the delete effect's precedent ─────────────────
     *
     * The same shape as "a step was deleted, so the viewer reads its state again":
     * a fact the position cannot express, on a trigger of its own, acting only
     * where something actually CHANGED. `projects.items()` is that trigger — main
     * announces the projects whenever a catalogue does anything, which includes
     * the landing that files a cast — and the acting is `showPosition`, the one
     * door that puts a position's document on screen.
     *
     * IT ASKS MAIN AND NEVER GUESSES. Reading the catalogue here to work out
     * whether a cast has appeared would be a second opinion about a resolution
     * that is deliberately main's alone (`showPosition` says why at length), and
     * it would be wrong in exactly the place it is dearest — a branch read, a
     * rotated cast. One IPC per open project per announce, and announces are
     * landings and imports rather than keystrokes.
     *
     * THE FIRST ANSWER FOR A PROJECT IS A BASELINE AND MOVES NOTHING, which is
     * the position effect's own first-sighting rule said about the document
     * instead of the picture: a window that has just met a project has no
     * difference to act on.
     *
     * ── IT USED TO OPEN THE AWAITED BOOKS FIRST, AND NOW THAT IS NEXT DOOR ─────
     *
     * One effect on `projects:changed` did two things in order: open every EPUB
     * whose project had finally arrived, then sweep for documents that had moved.
     * The first half is a tab factory and stayed with `OpenDocumentsService`,
     * which registers its effect in its own constructor. THE ORDER IS PRESERVED
     * BY CONSTRUCTION rather than by luck: this class injects that one, a field
     * initialiser runs before its own constructor body, and Angular runs effects
     * in registration order — so a book that arrives on the same announce is in
     * the list before this sweep walks it, exactly as when the two were one
     * function.
     */
    effect(() => {
      this.projects.items();
      untracked(() => {
        void this.followDocuments();
      });
    });
  }

  /**
   * What main last said was at each project's position — this window's memory of
   * the DOCUMENT, beside `showing`'s memory of the picture.
   *
   * Not a field on `ShownPicture`, and that is on purpose: the view and the string
   * it compares by are made together and never apart (see `pictureIn`), and this
   * one arrives hundreds of milliseconds later over IPC. A picture carrying a
   * field that is empty at the moment it is compared would be an invitation to
   * compare it.
   *
   * ── A SIGNAL, BECAUSE THE DIALOGS READ IT ────────────────────────────────────
   *
   * It was a plain `Map`: bookkeeping for `followDocuments`, written and read in
   * one file, and nothing on screen depended on it. There is one selection now
   * (docs/WORKBENCH.md §6c) — "every action keys off the position, never the open
   * tab" — so Translate, Export and Metadata all ask what document the position is
   * showing, and a `Map` cannot tell a template that the answer moved. A dialog
   * standing open while a job casts the book, or while the user clicks a row in
   * the library behind it, would go on describing the document from before.
   *
   * The map inside is replaced rather than mutated on every write, which is what
   * makes the signal's equality check mean anything at all.
   */
  readonly documentShown = signal<ReadonlyMap<string, string | null>>(new Map());

  /**
   * The document this project's viewer is pointed at, for a surface that acts on
   * the position rather than on whatever tab happens to be shown.
   *
   * NULL IS THREE STATES AND THEY ARE DELIBERATELY ONE HERE: nothing has read this
   * project's history yet, the position names no document of its own, or there is
   * no project. Every caller wants the same thing from all three — fall back to
   * what it can see for itself — and a surface that told them apart would be a
   * surface with three empty states for one absence.
   */
  documentShownFor(projectDir: string | null): string | null {
    if (projectDir === null) return null;
    return this.documentShown().get(fold(projectDir)) ?? null;
  }

  /** Main's latest answer about this project's position, kept where it is read. */
  rememberShown(key: string, target: string | null): void {
    this.documentShown.update((map) => new Map(map).set(key, target));
  }

  /** This project has no tabs left; its answer goes with them. */
  private forgetShown(key: string): void {
    this.documentShown.update((map) => {
      if (!map.has(key)) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }

  /**
   * THE FOCUS MIRROR: a document the user has just focused moves the position onto
   * the step that document IS.
   *
   * ── THE GUARD, WHICH IS THE WHOLE OF THE CARE HERE ──────────────────────────
   *
   * A document that is ALREADY the one the position is showing moves nothing. A
   * book resolves to the NEWEST step of its chain — the only step you can act from
   * — so without this, somebody standing on an older save and clicking into the
   * viewer to read it would be silently walked forward to the newest one, and the
   * next thing they exported would be a book they had deliberately stepped back
   * from. Standing still is not a gesture.
   *
   * ── Only user gestures reach this ───────────────────────────────────────────
   *
   * A pointerdown in the viewer and Ctrl+Tab, and nothing else. (It used to be
   * four gestures: a strip's own click and Ctrl+1…5 went with the columns.) It is
   * emphatically NOT inside `StageService.reveal`, because `showPosition` reaches
   * that on its way to satisfying a click on a library row: a mirror there would
   * answer main's own answer with a question about it, and a position that had
   * just been moved to an older step would move itself back the instant the viewer
   * obeyed.
   *
   * BOTH GESTURES CALL IT FROM OUTSIDE, which is the split's own shape rather
   * than an accident: this service sits above the stage, so the stage cannot
   * reach it. The workspace's pointerdown already called it directly; Ctrl+Tab
   * now does the same, taking the id `StageService.nextTab` answers with.
   *
   * A LOOSE FILE HAS NO LEDGER AND NO POSITION, so it is a no-op — its actions go
   * on taking the file, which is the ruling for loose rows everywhere.
   *
   * FIRE AND FORGET, AND A FAILURE IS NEVER IN THE WAY. Focus has already happened
   * by the time this is called; a refusal from main (a catalogue that will not
   * parse) belongs on the notice strip, not in front of a person who was trying to
   * look at a document.
   */
  async standForTab(tabId: string): Promise<void> {
    if (!api) return;
    const tab = this.documents.byId(tabId);
    if (tab === null) return;
    const subject = tab;
    /*
     * THE BOOK MOVES NOTHING, because it cannot disagree with the pointer. This
     * mirror exists so that the viewer and the position can never describe two
     * different things — it answers "which step is this FILE" — and the book tab
     * is not a file: it is put on screen BY a read row and shows whatever reading
     * that row is about (`showBook`). Asking main which step it belongs to would
     * be asking about a directory, and the honest answer for a directory is
     * nothing. A book open under a project standing on a curate or translate row
     * is showing that chain's own reading, which is the same book — so there is
     * nothing to correct there either.
     */
    // Neither directory kind has a reading position for main to be asked about.
    // A book tab shows whatever reading put it there; a capture tab shows
    // photographs, which no step has read yet and none may ever read.
    if (pathIsProject(subject)) return;
    const dir = this.documents.projectDirOf(subject);
    if (dir === null) return;
    const key = fold(dir);
    const known = this.documentShown().get(key);
    /*
     * THE FIRST FOCUS IN A PROJECT ASKS, RATHER THAN ASSUMING THE GUARD CANNOT
     * ANSWER — and this is the case the guard would otherwise miss entirely.
     *
     * Nothing writes `documentShown` for a project until the position MOVES
     * (`showPosition`) or main announces (`followDocuments`), so a project opened
     * from Home and clicked into straight away has no memory of what it is
     * showing. Treating that silence as "not the same document" is exactly the
     * yank this guard exists to prevent: somebody who left the pointer on an
     * older save, reopened the book and clicked into the page would be walked
     * forward to the newest step by the act of looking at it.
     *
     * One extra round trip, once per project per session, for the same question
     * `followDocuments` asks on every announce — and the answer is kept, because
     * it is the same fact those two record.
     */
    const shown = known !== undefined ? known : await this.rememberedShown(dir, key);
    if (shown !== null && fold(shown) === fold(subject.path)) return;
    try {
      /*
       * `adopt` AND NOT A SECOND READ. Main hands back the ledger AND the rows it
       * composed for it — the same whole answer `go` returns, for the same reason
       * — and `LedgerService.adopt` is the door already built for a history that
       * arrived from somewhere other than that class. A `refresh` here would be a
       * second round trip describing a moment later than the one that was acted
       * on, which is the failure `go`'s own comment is about.
       */
      this.ledger.adopt(dir, await api.ledger.standFor(dir, subject.path));
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * What main says is at this project's position, asked once and kept.
   *
   * The answer is null for every refusal (`LedgerService.documentAt` says why),
   * and null here means "no document of its own" — which the guard reads as "not
   * the one in front of me", so the mirror goes ahead and lets main decide. That
   * is the right way round: main is the side that knows, and a renderer guessing
   * at a catalogue it could not read is how somebody ends up standing somewhere
   * they did not ask to be.
   */
  private async rememberedShown(projectDir: string, key: string): Promise<string | null> {
    const at = await this.ledger.documentAt(projectDir);
    this.rememberShown(key, at);
    return at;
  }

  /**
   * A project this window has just met, asked once what its position is showing.
   *
   * IT NEVER OVERWRITES AN ANSWER THAT IS ALREADY IN HAND. A first sighting and a
   * gesture can both fire in the same frame — the pointerdown that opened the
   * project's tab is one of them — and this is the older question of the two, so
   * landing last must not replace a newer answer with a staler one.
   */
  private async baselineShown(projectDir: string, key: string): Promise<void> {
    if (this.documentShown().has(key)) return;
    const at = await this.ledger.documentAt(projectDir);
    if (this.documentShown().has(key)) return;
    this.rememberShown(key, at);
  }

  /** True while a sweep is in flight, so two announces do not walk it twice. */
  following = false;

  private followDocuments(): Promise<void> { return follow.followDocuments.call(this); }

  /**
   * The picture each project was last given to the viewer, keyed by the folded
   * directory — this window's memory of where every open book was standing.
   */
  readonly showing = new Map<string, ShownPicture>();

  private pictureIn(projectDir: string | null): ShownPicture | null { return follow.pictureIn.call(this, projectDir); }

  showPosition(move: PositionMove, resolved?: string | null): Promise<void> { return follow.showPosition.call(this, move, resolved); }

  showDocument(move: PositionMove, target: string | null): Promise<boolean> { return follow.showDocument.call(this, move, target); }

  followerAmong(mine: readonly Tab[]): Tab | null { return follow.followerAmong.call(this, mine); }

  private openTheSheet(move: PositionMove): void { return follow.openTheSheet.call(this, move); }

  showBook(move: PositionMove): boolean { return follow.showBook.call(this, move); }

  showTable(move: PositionMove): boolean { return follow.showTable.call(this, move); }
}
