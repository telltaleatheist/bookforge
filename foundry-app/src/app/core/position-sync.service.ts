import { Injectable, effect, inject, signal, untracked } from '@angular/core';

import { positionPicture, positionView, type PositionView } from '@shared/ledger';
import { fold } from '@shared/original';

import { normalise, OpenDocumentsService, type Tab } from './documents.service';
import { LedgerService } from './ledger.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { StageService } from './stage.service';
import { api } from './foundry';

/**
 * THE LEDGER AND THE VIEWER, KEPT SAYING THE SAME THING.
 *
 * ── One selection, and this is the machinery under it ───────────────────────
 *
 * The app had two selectors pretending to be one. The library selected a FILE,
 * the ledger selected a STEP, and the actions keyed off a mixture — so the user's
 * own report: *"i could have a document open, the epub, but have the pdf import
 * step selected, and id never know that i just ran translate against the original
 * pdf rather than the generated epub because i had the wrong step selected, since
 * the right document was open."* docs/WORKBENCH.md §6c is the ruling; this file
 * is the whole of the mechanism, in both directions.
 *
 * DOWNWARD (the position decides what is shown): three effects and the chain
 * under `showPosition`. A pointer move, a project met for the first time, or a
 * document that changed under a position that did not move — each ends with the
 * viewer holding what the ledger says it should.
 *
 * UPWARD (looking at a document stands on it): `standForTab`, the focus mirror,
 * called by the gestures that put a document in front of somebody.
 *
 * ── Why it is a service, and why nothing depends on it ──────────────────────
 *
 * It came out of `TabsService` with unit 8c (docs/PLAN.md §4) and it is the top
 * of the chain: Notice ← Documents ← Stage ← **PositionSync**. It reads the
 * ledger and the catalogue, it asks the documents service to make and move tabs,
 * and it asks the stage to show them. NOTHING READS IT BACK except the two
 * surfaces that ask `documentShownFor` — the dialogs, which want the position's
 * document rather than whatever tab happens to be up.
 *
 * IT IS ALL EFFECTS, WHICH MEANS IT MUST BE INJECTED TO EXIST. An
 * `@Injectable` nobody injects is never constructed, and three effects that never
 * register are three promises this app makes and silently stops keeping. `App`
 * injects it for exactly that reason and for no other — see the note there.
 */

/**
 * The picture one project is showing in the viewer, and the string that decides
 * whether it has moved.
 *
 * BOTH TOGETHER, never one without the other. The view is what a repaint acts on
 * and the string is what a repaint is decided by, and they are made in one call
 * (`pictureIn`) so that no surface can compare by one answer and act on another.
 */
interface ShownPicture {
  view: PositionView;
  picture: string;
}

/** One project whose position has moved since this window last painted it. */
interface PositionMove {
  /** The project directory, folded — the key `showing` is kept under. */
  key: string;
  /**
   * The same directory AS MAIN SPELLS IT, kept beside the folded key.
   *
   * The key is folded because on Windows one path arrives spelled three ways and
   * two spellings of one project would be two entries. What must NOT be folded is
   * what goes back over IPC: main proves the directory is one of Home's projects
   * before it reads a byte, and a lowercased path is a project on this filesystem
   * and a stranger to a string comparison. (`LedgerService.Holding` keeps both for
   * the identical reason.)
   */
  dir: string;
  /** What the viewer was showing, or null for a project this window has just met. */
  was: ShownPicture | null;
  now: ShownPicture;
}

@Injectable({ providedIn: 'root' })
export class PositionSyncService {
  private readonly documents = inject(OpenDocumentsService);
  private readonly stage = inject(StageService);
  private readonly notices = inject(NoticeService);
  private readonly projects = inject(ProjectsService);

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
  private readonly ledger = inject(LedgerService);

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
  private readonly documentShown = signal<ReadonlyMap<string, string | null>>(new Map());

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
  private rememberShown(key: string, target: string | null): void {
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
    if (subject.kind === 'book') return;
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
  private following = false;

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
  private async followDocuments(): Promise<void> {
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
   * The picture each project was last given to the viewer, keyed by the folded
   * directory — this window's memory of where every open book was standing.
   */
  private readonly showing = new Map<string, ShownPicture>();

  /**
   * What this project OUGHT to be showing, or null while nothing has read its
   * history.
   *
   * The view and the string it compares by are made together and never apart: a
   * caller holding one without the other would either compare pictures it cannot
   * act on or act on a picture it cannot compare.
   */
  private pictureIn(projectDir: string | null): ShownPicture | null {
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
  private async showPosition(
    move: PositionMove,
    /**
     * The answer, when the caller already has it — `followDocuments` asks main
     * which document is at the position in order to notice that it MOVED, and
     * asking again here would be a second round trip for the same fact and a
     * second chance to get a different one.
     */
    resolved?: string | null,
  ): Promise<void> {
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
    const onTheSheet = view.sheet;
    const swapped = onTheSheet
      ? this.showBook(move)
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
  private async showDocument(move: PositionMove, target: string | null): Promise<boolean> {
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
  private followerAmong(mine: readonly Tab[]): Tab | null {
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
  private openTheSheet(move: PositionMove): void {
    if (!move.now.view.sheet) return;
    this.showBook(move);
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
  private showBook(move: PositionMove): boolean {
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
}
