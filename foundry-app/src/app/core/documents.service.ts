import { Injectable, effect, inject, signal } from '@angular/core';

import { unwritten } from '@shared/ops';
import { fold } from '@shared/original';
import type { JobKind } from '@shared/types';

import { BookStacksService } from './book-stacks.service';
import { LedgerService } from './ledger.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { QueueService } from './queue.service';
import { api, hosted } from './foundry';

/**
 * The open documents — the flat list, and the one place that knows which is
 * which.
 *
 * TABS ARE RENDERER STATE, on purpose. Main owns everything with a lifetime — a
 * conversion, an unpacked book's temp directory, the allow-list — but which of
 * them is open and in what order is a window's own business, and pushing that
 * through IPC would make a reload of the renderer able to disturb it.
 *
 * The one door in is `document:opened`. The menu, the dialog, a drop, a path on
 * argv and a conversion that just finished all reach main first (which decides
 * whether the file is openable at all) and arrive back here as that event. So
 * this service never has to decide whether a path is real, and there is exactly
 * one code path that creates a tab.
 *
 * ── This was `TabsService`, and this file is four fifths of what it did ──────
 *
 * `TabsService` was 2,752 lines and about fourteen injection sites, and unit 8c
 * (docs/PLAN.md §4) broke it along the seams it had grown rather than the ones it
 * was designed with. What stayed here is the LIST AND ITS LIFE: identity, naming,
 * the flags a document wears, the doors it is opened by and the questions it is
 * closed by. What left is what was never about a list — the notice sentence
 * (`NoticeService`), what is on screen (`StageService`), the ledger's opinion
 * about what ought to be (`PositionSyncService`) and the book viewers' undo
 * stacks (`BookStacksService`).
 *
 * THE DEPENDENCY RUNS ONE WAY and it is the whole point: Notice ← Documents ←
 * Stage ← PositionSync. This file may say a sentence and may ask a book viewer
 * what a close would scrap; it may not ask what is on screen, and does not need
 * to — see `show` below for the one place that looked like it did.
 *
 * ── ONE VIEWER, AND THE SECOND REVERSAL THIS CLASS CARRIED ──────────────────
 *
 * The class this came out of carried the record of the panes: one to five columns
 * side by side, and the reversal that brought each column's CHROME-STYLE STRIP
 * back with pin, drag-split and close. Both went on one ruling (2026-08-17):
 *
 *   *"i dont think we should have tabs in foundry. i think its making things a
 *   bit confusing. however, the user should be able to compare two steps
 *   sometimes. so i think the solution is to have a single viewer window/single
 *   tab, and if the user wants to compare two steps, theres a compare button
 *   they can click and then they can choose the step to compare."*
 *
 * THE TABS STAY IN ONE FLAT LIST, and now it is the only list there is. It was
 * already flat under the panes, on the rule that `patch()` — the one function
 * every edit, save and flag in this file goes through — must never have to search
 * a list of lists. What went with the columns is the second structure that held
 * ids INTO it; the order in the list is the library panel's, through `reorder`,
 * and nothing else records a sequence.
 *
 * A DOCUMENT HAS AT MOST ONE TAB, unchanged and load-bearing. Opening something
 * already open SHOWS it rather than putting a second viewer over one unpack —
 * the rule `adopt()` has always enforced for files.
 *
 * ── TWO KINDS, WHICH IS WHERE R6c LEFT IT ───────────────────────────────────
 *
 * There were four. `epub` was an unpacked book served to a sandboxed <iframe>
 * and `editor` was that book's markup in a textarea beside it, and both are
 * deleted with the editing world they belonged to (docs/RENDERER.md §7). What is
 * left is a document this app SHOWS and a book this app EDITS.
 */

/**
 * `book` IS THE ONE KIND THAT IS NOT A FILE.
 *
 * `pdf` is a document on disk — a scan or a facsimile, shown and never edited
 * (docs/RENDERER.md §0 A1). A `book` tab is the project's BOOK — the reflowed
 * blocks the renderer draws on the proof sheet (docs/RENDERER.md §5) — which does
 * not live in any one file the user opens: it is made from the bank at the
 * position, main decides which bank that is, and the renderer never learns where
 * it is kept. So the tab carries the PROJECT DIRECTORY in `path` and asks main
 * for the rows by naming it.
 *
 * That is why `projectDirOf` has a case for this kind and nothing else does: for
 * every other tab the project is the folder the file is IN, and for this one the
 * path IS the project.
 */
export type TabKind = 'pdf' | 'book';

export interface Tab {
  id: string;
  kind: TabKind;
  /**
   * The file this tab is showing. For a conversion that has not been saved
   * anywhere, that is the copy in the managed workspace — and it stays that even
   * after Save As, because the saved file is a byte-for-byte copy and re-opening
   * it would throw away an unpack for nothing.
   *
   * FOR A `book` TAB THIS IS THE PROJECT DIRECTORY and not a file at all — see
   * `TabKind`. Everything that treats a path as bytes to open is gated on the
   * kind, and the two prefix tests that group a project's tabs together accept
   * the directory itself for exactly this one.
   */
  path: string;
  /**
   * WHAT THIS DOCUMENT IS CALLED, which is never its filename.
   *
   * A stem is built to survive a filesystem — `Working-Towards-The-Fuhrer.-
   * Kershaw-Ian.-1993` — and this app used to put that on the viewer, in the
   * window's own title bar and in the list down the left. It is the name of a
   * file, not of a book, and the two surfaces that showed it disagreed with the
   * one that did not: Home has always said "Working Towards the Führer".
   *
   * So it is the BOOK's name — the project's title where a project claims this
   * file, the book's own `dc:title` once it has been unpacked — and only where
   * neither exists does it fall back to the file, said aloud (`spokenName`).
   * The filename itself survives in the row's tooltip and in the save dialog,
   * which are the two places somebody is asking about a file rather than about
   * a book.
   */
  title: string;
  /**
   * True once something CHOSE this title, rather than it being derived from
   * whatever the document happens to be called on disk.
   *
   * IT REPLACES A STRING COMPARISON, and the comparison was the fragile part. The
   * rule has always been "never clobber a title somebody chose" — a book's
   * `dc:title` must survive the file moving between folders — and it used to be
   * enforced by testing whether the title still EQUALLED the basename, which
   * quietly stops working the moment the derived name is anything other than the
   * basename. Written down as a flag, the rule is the same rule and cannot be
   * broken by improving the fallback.
   */
  named: boolean;
  /**
   * The Chrome dot. True while no copy of this book exists anywhere the user
   * chose — it lives in the library workspace and nowhere else.
   *
   * DISTINCT FROM `modified`, and the distinction is the whole point. This one
   * is about a book nobody has filed; that one is about a filed copy that has
   * fallen behind. A tab can be either, both, or neither.
   *
   * IT IS DRAWN AND NOT ASKED ABOUT. The closing question used to fire on this
   * flag, which is true from birth for every book opened out of a project, so it
   * interrupted people who had lost nothing; the user ruled it out ("only pop up
   * a confirmation alert if changes have been made") and `questionBefore` says
   * the rest. A dot in the corner of a card is the right weight for "this lives
   * in the library and nowhere else" — a modal is not.
   */
  unsaved: boolean;
  /**
   * Edited since the copy at `savedPath` was written.
   *
   * The app DOES edit documents now (the chapter editor), so "nothing in this
   * app modifies a document" is no longer true and this flag is what replaced
   * it. It never means the edits are at risk: every keystroke that lands is
   * written through to the workspace copy before this is set.
   */
  modified: boolean;
  /**
   * Where Save/Save As put it, once it has been anywhere. Seeded with the file
   * itself for a book opened from the user's own disk — that file is already a
   * copy they chose, and Save should update it rather than ask.
   */
  savedPath: string | null;
  /**
   * True while the PDF viewer is showing the text layer beside the page.
   *
   * On the TAB rather than in the component, for the same reason `thumbnails`
   * is: only the shown tab's viewer is in the DOM, so a component that held
   * this would forget it the moment the user looked at something else. A view
   * mode that resets itself when you glance away is a view mode you stop using.
   */
  layerView: boolean;
  /**
   * A BOOK TAB THAT SHOWS A FINISHED EXPORT, read-only — the proof sheet locked
   * to the Final version register over an exploded copy of the file. Its path
   * is the EPUB itself, not a project directory, and nothing about it is a
   * position: no stack, no Apply, and Ctrl+S saves a copy of the export.
   */
  viewOnly?: boolean;
  /** True while the PDF viewer's thumbnail strip is up. ON by default — it sits
   *  along the bottom where it costs little, and Owen wants the pages in reach. */
  thumbnails: boolean;
  /**
   * Bumped on every flush that reached disk.
   *
   * It is what makes the viewer re-read a document whose PATH did not change: a
   * rendering replaces the project's PDF at the same name, and a viewer with no
   * reason to believe the bytes moved would go on showing the old ones. The
   * pdf.js viewer watches path AND revision for exactly that.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

/**
 * The job kinds that become a tab when they finish.
 *
 * A set rather than a chain of comparisons because the list has grown twice
 * now, and each time the test lived inline it was one `||` away from a kind
 * that finishes and is never seen. What is NOT here is deliberate: `txt` has no
 * tab to open into, `env-install` made no document at all, and `read` made no
 * document EITHER — its product is the bank, which is not a thing anybody looks
 * at. What you look at is what you generate from it, and generating is one of
 * the two kinds above, which is exactly why they open themselves: somebody
 * asks for an EPUB precisely because they want to read it.
 *
 * `translate` left this set when its product became a records file. Its
 * `.jsonl` is a bank's kind of thing — nobody reads it — and opening it here
 * produced a refusal notice per finished translation. The translated BOOK
 * still arrives in front of the person, by the other door: the position moves
 * onto the translate row, the viewer follows through `showPosition`
 * (`PositionSyncService`), and the cast that renders it carries `forStep`,
 * which the auto-open effect already skips.
 */
const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['pdf']);

/**
 * No tabs at all — the default for `questionBefore`'s second argument.
 *
 * A shared frozen empty set rather than a `new Set()` per call: an ordinary close
 * asks about one tab and has nothing to carry, and allocating a set to say so on
 * every ✕ is a small thing done often.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

@Injectable({ providedIn: 'root' })
export class OpenDocumentsService {
  private readonly queue = inject(QueueService);
  /**
   * The library, read only to NAME things.
   *
   * Nothing about a tab's life depends on it — a document opens, unpacks, edits
   * and saves whether or not a project has claimed it — which is why this is the
   * one thing asked of it. The alternative was for every surface that draws a
   * document (the list, the viewer's toolbar, the window's title bar) to look the
   * project up for itself, and three lookups of one fact is three chances for
   * two of them to disagree about what a book is called, which is the exact
   * failure this whole arrangement exists to end.
   */
  private readonly projects = inject(ProjectsService);
  /**
   * The step ledger, read for exactly two things and no longer for the position.
   *
   * `openProject` asks whether this window has read a book's history yet (and
   * reads it if not, so the position effects have something to obey), and the
   * closing question hands back the history main returns when a parked stack is
   * applied on the way out. THE POSITION ITSELF LEFT WITH `PositionSyncService`:
   * which step a project stands on, and what document that resolves to, is that
   * service's whole subject and no longer this one's.
   */
  private readonly ledger = inject(LedgerService);
  private readonly notices = inject(NoticeService);
  /**
   * The book viewers' stacks — read by the closing question and by nothing else
   * here.
   *
   * IT IS THE ONE DEPENDENCY THAT LOOKS LIKE IT POINTS THE WRONG WAY and does
   * not: `BookStacksService` knows about a map keyed by tab id and about nothing
   * in this file, so the arrow runs Documents → BookStacks and stops. What the
   * question needs is a COUNT of what closing would scrap, which only the viewer
   * can answer, and a way to press Apply on the person's behalf.
   */
  private readonly stacks = inject(BookStacksService);

  private readonly all = signal<Tab[]>([]);

  /**
   * Every open document, in the order the list shows them.
   *
   * THE ORDER IS THIS LIST'S, and it is the only sequence in the window: there is
   * nowhere else a document sits in one, so `reorder` writes here and the panel
   * renders it straight.
   */
  readonly tabs = this.all.asReadonly();

  /**
   * THE DOCUMENT THIS WINDOW MOST RECENTLY PUT IN FRONT OF SOMEBODY, by id —
   * the raw pointer, and NOT the answer to "what is on screen".
   *
   * ── Why the pointer is here and its MEANING is one service up ───────────────
   *
   * The split (docs/PLAN.md §4, unit 8c) puts "what is on screen" in
   * `StageService`, which depends on this file. But every door in this file that
   * opens a document ends by putting it in front of the person — `adopt`,
   * `relocate`, `openFinished`, `openExportView`, `openAwaitedBooks` — and four
   * of those five are driven by an IPC callback or by an effect of this class,
   * so there is no caller to hoist the showing up to. A pointer that only the
   * stage could write would have meant this file announcing an intention for the
   * stage to act on, which is a wire with a delay in it where a signal write used
   * to be.
   *
   * So the RAW WRITE lives here, where the doors are, and the stage owns
   * everything that makes it mean something: whether the id is still open, what
   * tab it resolves to, what Home is, and the gestures that move it. `StageService.
   * active` is a computed over this and the list, which is what lets `close`
   * below simply drop a tab and never reach into the stage to tidy up after
   * itself — the pointer falls back to Home by construction the moment the list
   * stops holding what it names.
   *
   * IT IS DELIBERATELY NOT VALIDATED ON READ. A stale id — a document closed
   * while this still names it — is exactly the state the stage's computed is for,
   * and cleaning it up here would be this file answering a question it does not
   * have the standing to ask.
   */
  private readonly pointer = signal<string | null>(null);
  readonly showing = this.pointer.asReadonly();

  /** The tab whose chapter is being written right now, for the "Writing…" line. */
  readonly writingTo = signal<string | null>(null);

  /**
   * Paths that will arrive as UNSAVED tabs: a conversion's output, or a
   * workspace book re-opened from Home.
   *
   * A set consulted on the way in, rather than a flag on the open call, because
   * the open call and the tab's creation are on opposite sides of an IPC round
   * trip through main.
   */
  private readonly expectUnsaved = new Set<string>();

  /*
   * THERE WERE THREE MORE OF THESE AND THEY WENT WITH THE COLUMNS.
   *
   * `expectOwnPane`, `expectPane` and `expectReplace` rode the same round trip to
   * say where a path should land when it came back: in a column of its own, in a
   * NAMED column, or on top of what the focused one was showing. With one viewer
   * there is one answer to all three — the thing that just opened is the thing you
   * are looking at — so an intention that has to survive an IPC hop has nothing
   * left to carry. `expectUnsaved` stays because it is not about placement at all:
   * it is a fact about the FILE (nobody has filed a copy of this yet) that only
   * the caller knows and only the tab can hold.
   */

  /** Conversions already turned into a tab, so a queue push cannot open a second. */
  private readonly openedJobs = new Set<string>();

  /**
   * An open editor's "write what is in the box, now".
   *
   * Registered by the editor component, because the draft lives in its textarea
   * and nothing out here can see it. `close()` awaits it before it asks the user
   * anything: the debounce is 700 ms, and closing a tab inside that window used
   * to throw away the last sentence typed AND ask a question about a `modified`
   * flag that had not been set yet.
   */
  private readonly pendingFlush = new Map<string, () => Promise<void>>();

  private sequence = 0;

  constructor() {
    api?.onDocumentOpened((absolutePath) => { this.adopt(absolutePath); });
    api?.onDocumentRelocated(({ from, to }) => { this.relocate(from, to); });

    /**
     * A finished conversion opens itself.
     *
     * Watching the queue MIRROR rather than being told by whatever enqueued the
     * job: the job outlives the dialog that started it, outlives a trip to
     * Settings, and (because main owns the queue) outlives a reload of this
     * window. The only fact that matters is that a row reached `done`.
     *
     * EPUB and PDF both, because both have a tab to open into and looking at
     * the result is the next thing anybody does — a reprinted PDF is a claim
     * about every page of a book, and the claim is checked by eye. txt stays
     * shelf-only: there is no text tab, and the OS opens it from reveal.
     *
     * A TRANSLATION IS THE THIRD, and it is the one this matters most for: it
     * runs for hours, so the person who ordered it is not watching, and the
     * book appearing in front of them is how they find out it finished at all.
     *
     * IN THE VIEWER, which is where everything that opens now goes. It used to
     * be "in a pane of its OWN, beside the book it was made from" — the columns'
     * founding argument, applied to the one job that runs long enough to need it
     * — and with one viewer there is nowhere for a beside. Nothing is lost that
     * the user asked to keep: the book it was made from is still open in the
     * list, and reading the two against each other is Compare's job (docs/PLAN.md
     * §4, unit 8d) rather than a side effect of a job finishing.
     *
     * Jobs already finished when this window loaded are marked as seen without
     * opening: a reload should not reopen five books somebody closed.
     *
     * A SAVE'S OWN BOOK IS THE EXCEPTION, and it is the one job here nobody
     * ordered. Applying changes casts the book as of that save (`forStep`, the
     * per-save cast), which is a rendering the app made for itself so that
     * standing on an older save shows the book that save made — and it lands in
     * the middle of somebody correcting the next paragraph. Every other job in
     * this list is a thing a person pressed a button for and is waiting on; this
     * one would be a document arriving in front of work in progress, for one they
     * can already reach by clicking the row it belongs to.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if (!OPENS_ITSELF.has(job.kind) || job.forStep !== undefined || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openFinished(job.outputPath, job.kind);
      }
      if (jobs.length > 0) first = false;
    });

    /**
     * A DOCUMENT LEARNS ITS BOOK'S NAME LATE, and this is what tells it.
     *
     * A file opened from outside the library is imported in the background: the
     * tab exists before the project does, so at the moment it is made there is
     * nothing to ask and the name falls back to the file. The project arrives
     * some hundreds of milliseconds later as `projects:changed`, and without
     * this the tab would keep the fallback for the rest of the session — the
     * list on the left saying one thing about a book while Home said another,
     * which is the disagreement this is all for.
     *
     * ONLY WHERE NOBODY CHOSE A NAME. `named` is the whole guard: an unpacked
     * book's `dc:title` is a better answer than any project title and is never
     * overwritten by this.
     *
     * It converges in one pass and cannot loop: the patch below is the only
     * write, it happens only when the name actually moved, and the run it
     * triggers finds the same answer already in place.
     */
    effect(() => {
      this.projects.items();
      for (const tab of this.all()) {
        if (tab.named) continue;
        const want = this.titleFor(tab);
        if (want !== tab.title) this.patch(tab.id, { title: want });
      }
    });

    /**
     * AN AWAITED EPUB'S PROJECT HAS ARRIVED — open its book.
     *
     * ── It was half of one effect, and the halves went to different services ───
     *
     * `projects:changed` used to fire one effect that did two things in order:
     * open every awaited book, then re-ask main which document each open
     * project's position resolves to (`followDocuments`). The second half is the
     * ledger's business and left with `PositionSyncService`; this half is a tab
     * factory and stayed.
     *
     * THE ORDER BETWEEN THEM IS PRESERVED AND IT IS PRESERVED BY CONSTRUCTION,
     * not by luck. `PositionSyncService` injects this class, and a field
     * initialiser runs before its own constructor body, so this effect is always
     * registered first and Angular runs effects in registration order. A book
     * that arrives on the same announce is therefore in the list before the sweep
     * that walks it, exactly as it was when the two were one function.
     */
    effect(() => {
      this.projects.items();
      this.openAwaitedBooks();
    });
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  byId(id: string | null): Tab | null {
    if (id === null) return null;
    return this.all().find((tab) => tab.id === id) ?? null;
  }

  /**
   * PUT A DOCUMENT IN FRONT OF THE PERSON — or nothing at all, which is Home.
   *
   * THE RAW WRITE, and the only one. Inside this file the opening doors call it
   * because they are what "in front of the person" happens to; outside it,
   * `StageService.reveal` and `StageService.goHome` are the named gestures and
   * they are the only callers. Two doors onto one signal is a thing worth
   * justifying, and the justification is the whole comment on `pointer` above:
   * the write has to be reachable from the IPC callbacks and effects in this
   * file, and the MEANING has to live where "what is on screen" is decided.
   *
   * AN ID THIS WINDOW DOES NOT HOLD IS REFUSED rather than stored: every caller
   * is acting on something it has just looked up or just made, so a miss is a
   * race with a close, and recording it would put a lie in the pointer for the
   * stage to have to disbelieve.
   */
  show(tabId: string | null): void {
    if (tabId !== null && this.byId(tabId) === null) return;
    this.pointer.set(tabId);
  }

  /**
   * The project this document belongs to, or null for a file opened from elsewhere.
   *
   * A `book` TAB NAMES ITS PROJECT DIRECTLY (see `TabKind`), so it is answered
   * from the tab rather than looked up: `projectFor` asks which project a FILE is
   * inside, and a directory is not inside itself. Asked of the catalogue anyway,
   * so that a directory this window no longer has a project for answers null like
   * anything else — the alternative is a tab claiming to belong to a book that has
   * left the library.
   *
   * PUBLIC SINCE THE SPLIT: the stage asks it to work out which project the window
   * is holding, and the position sync asks it to group a project's tabs. Both are
   * questions about a TAB, which is why the answer stays here.
   */
  projectDirOf(tab: Tab): string | null {
    if (tab.kind !== 'book') return this.projects.projectFor(tab.path)?.dir ?? null;
    const key = fold(tab.path);
    return this.projects.items().find((project) => fold(project.dir) === key)?.dir ?? null;
  }

  // ── Naming ───────────────────────────────────────────────────────────────

  /**
   * What to call a document at this path — the book, and the file only as a last
   * resort.
   *
   * THE SAME STRING HOME SHOWS, and it is one call rather than a rule repeated
   * here precisely so that it cannot become a second opinion: see
   * `ProjectsService.nameFor`, which every surface that draws a document's name
   * goes through.
   */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  /**
   * What to call this TAB — one step above `nameFor`, which answers about a path.
   *
   * The two are the same question for every tab that is a file. A `book` tab is
   * not one (see `TabKind`): its path is the project's own directory, and
   * `nameFor` would answer with the folder said aloud — a slug with a hash on the
   * end — for the one document in this app whose name is never in doubt. It is
   * the project's title, which is what Home, the library and every other surface
   * already call this book.
   *
   * IT IS RE-DERIVED RATHER THAN FROZEN AT BIRTH, which is why this is a function
   * and not a flag: a metadata step can change a book's title while it is open,
   * and the naming effect above exists precisely so that every tab that did not
   * have a name CHOSEN for it follows.
   */
  private titleFor(tab: Tab): string {
    return tab.kind === 'book' ? this.projectTitleOf(tab.path) : this.nameFor(tab.path);
  }

  /**
   * The title of the project AT this directory, or the folder said aloud.
   *
   * The fallback is `nameFor`'s own last resort rather than a second one: a
   * directory no project claims is a book that has left the library while a tab
   * was open, and the honest thing to say about it is whatever its folder is
   * called.
   */
  private projectTitleOf(dir: string): string {
    const key = fold(dir);
    const project = this.projects.items().find((one) => fold(one.dir) === key) ?? null;
    return project === null || project.problem !== null || project.title.length === 0
      ? this.nameFor(dir)
      : project.title;
  }

  // ── Opening ──────────────────────────────────────────────────────────────

  /** The rail's and Home's Open button. The tab arrives on `document:opened`. */
  async openViaDialog(): Promise<void> {
    await api?.openDocumentDialog();
  }

  /**
   * A drop. Main decides whether the path is openable; a refusal is SAID rather
   * than ignored, because a file that lands in the window and does nothing is
   * indistinguishable from a broken app.
   */
  async openDropped(file: File): Promise<void> {
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
  async openFromList(filePath: string, managed = false): Promise<void> {
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
  async openProject(projectDir: string, originalPath: string, managed = false): Promise<void> {
    await this.openFile(originalPath, managed);
    if (this.ledger.historyFor(projectDir) === null) await this.ledger.refresh(projectDir);
  }

  /** Open a path this window already knows about: Home's list, the shelf's Open. */
  async openFile(filePath: string, managed = false): Promise<void> {
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
  private openFinished(filePath: string, kind: JobKind): void {
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
  openExportView(path: string, title: string): void {
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
  bookTabIn(projectDir: string): string {
    const key = fold(projectDir);
    const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
    if (already !== undefined) return already.id;
    const made = this.blankTab('book', projectDir, this.projectTitleOf(projectDir));
    this.all.update((tabs) => [...tabs, made]);
    return made.id;
  }

  /**
   * The single tab factory. Shows an existing tab for the same file rather
   * than opening a second — two tabs onto one book are two scroll positions
   * fighting over one document, and two viewers onto one unpack.
   */
  private adopt(absolutePath: string): void {
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

  /**
   * An EPUB is open somewhere in the library — show that project's BOOK.
   *
   * ── Why this waits rather than resolving ──────────────────────────────────
   *
   * A file dropped on the window is announced by main IMMEDIATELY and imported
   * behind that announcement, deliberately: keying a project is a full sha256 and
   * a window that sat still for it would read as an app that had missed the file.
   * So at the instant this is called there is very often no project yet, and the
   * question "which book is this" has no answer that could be composed here.
   *
   * IT IS A SET AND NOT A PROMISE, for the reason every other cross-cutting fact
   * in this file is a signal: the answer arrives as `projects:changed`, which is
   * an announcement to the whole window rather than the resolution of a call this
   * side made. The entry is dropped as soon as it is spent, and an import that
   * never lands leaves one path in a set — which is the cheapest possible way to
   * be wrong about a book nobody can open anyway.
   */
  private readonly awaitingBooks = new Set<string>();

  private awaitBook(filePath: string): void {
    this.awaitingBooks.add(normalise(filePath));
    this.openAwaitedBooks();
  }

  /** Every awaited EPUB whose project this window can now see. */
  private openAwaitedBooks(): void {
    for (const key of [...this.awaitingBooks]) {
      const dir = this.projects.projectFor(key)?.dir ?? null;
      if (dir === null) continue;
      this.awaitingBooks.delete(key);
      this.show(this.bookTabIn(dir));
    }
  }

  /**
   * The document this tab is showing has moved to the copy this app works on.
   *
   * ── What this fixes ─────────────────────────────────────────────────────────
   *
   * A file opened from outside the library is IMPORTED — copied into the
   * project's `archive/` untouched, and again into the live layer, which is what
   * "the PDF" means in every other sentence this app says. The tab kept the
   * outside path, because the import is deliberately not awaited and there was
   * nothing else to name at the moment the tab was made.
   *
   * Everything then asked the wrong question. `projectFor(tab.path)` answers
   * null for a path outside the library, so Generate said a book that had just
   * been read had not been read, the dock's waiting light stayed lit on a
   * finished project, the nav could not group the document under its own book,
   * and the block editor had no bank to fetch. One stale string, six broken
   * features, and nothing on screen to explain any of it.
   *
   * ── The same tab, never a second one ────────────────────────────────────────
   *
   * `adopt` would make a new tab for the new path, which is exactly the failure
   * this exists to prevent: two viewers onto one document, two scroll positions,
   * and the user watching their book apparently open twice. So this PATCHES —
   * the tab keeps its id, its ledger, its selection and its place in the list,
   * and only its idea of where the file is changes.
   *
   * A PDF viewer reloads by itself: `app-pdf-view` watches `tab.path` through a
   * computed and re-opens when the string changes, which is a repaint of the
   * same pages from the same bytes. A book does not reload at all — it is
   * already unpacked, and it is unpacked from the SAME project, because the
   * import is keyed by the file's content and both paths reach it.
   *
   * `savedPath` MOVES WITH IT WHEN IT NAMED THE FILE WE ARE LEAVING. It is a
   * grant — for a book opened from the user's own disk it names their file, and
   * Save updating the copy they chose is what they asked for by opening it — but
   * that stops being true the moment the tab stops showing that file. A Save
   * that repacked the working tree over a document on another drive, while every
   * label on screen said the library's copy, is the same invariant `meta:write-pdf`
   * broke: THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY. Main revokes the
   * matching grant in the same breath. Where `savedPath` names something else
   * entirely — a Save As the user made — it is left exactly alone.
   *
   * Silent when nothing matches — the tab was closed inside the import's own
   * round trip, which is a race with no consequence.
   */
  private relocate(from: string, to: string): void {
    const was = normalise(from);
    const now = normalise(to);
    if (was === now) return;
    const moving = this.all().find((tab) => normalise(tab.path) === was);
    if (!moving) {
      // No tab for it, which for an EPUB is the ordinary case: `adopt` made none
      // and is waiting for the project this move announces.
      if (this.awaitingBooks.has(was)) {
        this.awaitingBooks.delete(was);
        this.awaitBook(to);
      }
      return;
    }
    /*
     * THE DESTINATION IS ALREADY OPEN — one book reached two ways.
     *
     * Somebody opened the project's copy from Home and then dropped their own
     * file on the window (or the reverse). This used to give up and leave the
     * outside-path tab exactly where it was, which is the worst of the three
     * outcomes: that tab keeps every identity bug the relocation exists to fix,
     * and the user is looking at two tabs of one book with only one of them
     * working.
     *
     * ONE BOOK, ONE TAB. The outside tab closes and the one already on the
     * working copy is shown. Nothing is lost — they are the same bytes, and
     * the surviving tab is the one with a project behind it. `ask: false`
     * because there is no question here: this is not a document being put away,
     * it is two views of one document becoming one.
     */
    const already = this.all().find((tab) => normalise(tab.path) === now && tab.id !== moving.id);
    if (already) {
      void this.close(moving.id, false);
      this.show(already.id);
      return;
    }
    this.patch(moving.id, {
      path: to,
      /*
       * AND THE SAVE TARGET GOES WITH THE PATH. `savedPath` names the copy the
       * user chose, and for a book opened from their own disk that is their own
       * file — which is a deliberate design and stays right up until the moment
       * the tab stops showing that file. Keeping it here would mean Ctrl+S
       * repacking the working tree over a document on E:\\ while every label on
       * screen said the library's. Main revokes the matching write grant at the
       * same instant, so the two sides cannot disagree; clearing it here is what
       * makes Save fall through to Save As, which is the door that asks.
       */
      ...(moving.savedPath !== null && normalise(moving.savedPath) === was
        ? { savedPath: null, unsaved: true }
        : {}),
      /*
       * THE TITLE ONLY IF NOBODY HAS SET A BETTER ONE. A book's title becomes
       * its `dc:title` when it unpacks — "Working Towards the Führer" rather
       * than the name it arrived under — and overwriting that because the file
       * moved between folders would undo the one piece of naming this app does
       * on the user's behalf.
       *
       * RE-DERIVED RATHER THAN CARRIED, because this move is the exact moment
       * the answer changes: the file is going from a folder of the user's into
       * a project, so the name it should now be wearing is the project's, and
       * `nameFor` is where that is decided once for the whole app.
       */
      ...(moving.named ? {} : { title: this.nameFor(to) }),
    });
  }

  private blankTab(kind: TabKind, path: string, title: string): Tab {
    this.sequence += 1;
    return {
      id: `tab-${this.sequence}`,
      kind,
      path,
      title,
      named: false,
      unsaved: false,
      modified: false,
      savedPath: null,
      layerView: false,
      thumbnails: true,
      revision: 0,
      problem: null,
    };
  }

  /**
   * Move a document in the list — a row dragged onto another row.
   *
   * `beforeTabId` names the document it lands in front of; null means the end.
   * This is the ONLY place a document's order is decided, which is why it writes
   * the flat list — there is no second sequence anywhere in the window.
   */
  reorder(tabId: string, beforeTabId: string | null): void {
    if (tabId === beforeTabId) return;
    const tabs = this.all();
    const moving = tabs.find((tab) => tab.id === tabId);
    if (!moving) return;
    const without = tabs.filter((tab) => tab.id !== tabId);
    const at = beforeTabId === null ? -1 : without.findIndex((tab) => tab.id === beforeTabId);
    const index = at < 0 ? without.length : at;
    this.all.set([...without.slice(0, index), moving, ...without.slice(index)]);
  }

  // ── The two doors the position sync writes through ───────────────────────

  /**
   * MAKE THE VIEWER RE-READ WHAT IT IS ALREADY POINTED AT.
   *
   * The book's rows and its op chain come from one call to main keyed to the
   * POSITION, so a move between two steps of one reading changes what
   * `book:load` would answer while the tab's own path — the project directory —
   * does not move an inch. Without a bump the sheet would sit there showing the
   * book as of whatever row it last loaded, which is precisely the complaint the
   * position effect exists to answer: clicking a row in your own history and
   * watching the app do nothing.
   *
   * A NAMED DOOR RATHER THAN A PUBLIC `patch`, on `noteDocumentEdited`'s
   * precedent. `patch` is the one write every flag in this file goes through and
   * it stays private for that reason; what crosses the service boundary is a
   * VERB with its own reason, so that a reader of the call site learns why the
   * write happened rather than merely that a field moved.
   */
  bumpRevision(tabId: string): void {
    const tab = this.byId(tabId);
    if (tab === null) return;
    this.patch(tabId, { revision: tab.revision + 1 });
  }

  /**
   * THE TAB THAT FOLLOWS THE POINTER MOVES ONTO THE STEP'S FILE.
   *
   * One document per project in the viewer is what makes "the viewer shows the
   * step" true, and `app-pdf-view` watches `tab.path` and re-opens when the
   * string changes — so a swap between two PDFs of one project is this patch and
   * nothing else, and it keeps the page the reader was on where opening a second
   * tab would land them back at page one of five hundred.
   *
   * `madeByUs` IS THE CHROME DOT FOLLOWING THE FILE: the tab is about to stop
   * being about the copy Foundry made and start being about the user's own, or
   * the reverse. The caller asks the catalogue, because whether a path is managed
   * is the catalogue's answer and not this file's.
   */
  followTo(tabId: string, filePath: string, madeByUs: boolean): void {
    const tab = this.byId(tabId);
    if (tab === null) return;
    this.patch(tabId, {
      path: filePath,
      unsaved: madeByUs,
      /*
       * THE REVISION MOVES WITH THE PATH. It is what makes the viewer re-read
       * bytes it is already pointed at (see `openFinished`), and the two files
       * this swaps between can have the same name in two layers of one project —
       * so a viewer that compared only the string would faithfully conclude there
       * was nothing to do, which is the failure that whole comment is about.
       */
      revision: tab.revision + 1,
      /*
       * AND THE NAME ONLY IF NOBODY CHOSE ONE, which is `relocate`'s rule and its
       * reason: a book's `dc:title` outranks anything derived from a path, and
       * these files are all one book anyway — `nameFor` answers the project's
       * title for every layer of it.
       */
      ...(tab.named ? {} : { title: this.nameFor(filePath) }),
    });
  }

  // ── Closing ──────────────────────────────────────────────────────────────

  /**
   * Close every tab showing one of these files — the window letting go of what is
   * about to be erased.
   *
   * ── Why it is the paths and not a tab id ────────────────────────────────────
   *
   * A step delete names PAYLOADS, not tabs: main is destroying `generated/<book>
   * (en).epub` and knows nothing about which documents this window has open, and
   * only this side can close one. So the caller hands over the list main gave it
   * and this matches whole paths, folded — never a basename, because a project
   * holds `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once
   * and closing by last segment would shut the scan for a delete aimed at a
   * reprint.
   *
   * WITHOUT ASKING. Every caller has already put a confirm on screen naming
   * exactly these losses, and a second dialog about unsaved changes in a document
   * that is being destroyed is a question with no useful answer.
   *
   * A COPY OF THE LIST FIRST, because closing mutates the very signal this reads.
   */
  async closeShowing(files: readonly string[]): Promise<void> {
    const doomed = new Set(files.map((file) => fold(file)));
    const ids = this.all()
      .filter((tab) => doomed.has(fold(tab.path)))
      .map((tab) => tab.id);
    for (const id of ids) await this.close(id, false);
  }

  /**
   * The window is going — every open document gets the question first.
   *
   * ── Why quitting comes back to this class ───────────────────────────────────
   *
   * Quit used to skip closing altogether: the window was destroyed and the tabs
   * went with it, so nothing was asked about any of them. That was survivable
   * while the only thing at stake was a copy of a file the user had been warned
   * about, and it stopped being survivable the moment closing a scan became the
   * event that ends a session's undo history — quitting with four books open
   * converted "undoable" into "permanent" four times over, silently. Main cannot
   * ask on its own: it knows which files were ever opened, not which documents
   * are open now, and that is renderer state.
   *
   * THE SAME QUESTION, DOCUMENT BY DOCUMENT, and not a summary of all of them.
   * Every one of these losses is about a particular book — its corrections, its
   * save, its copy — and a dialog that pooled four books into one number would be
   * asking somebody to make four decisions with one button. `keep` on any of them
   * stops the quit where it stands: the person said they wanted that book, and
   * carrying on to ask about the next one would be the app negotiating.
   *
   * NOTHING IS CLOSED HERE. The tabs are asked about and left exactly as they are;
   * main destroys the window if the answer is yes. Closing them one by one first
   * would leave a cancelled quit with a window somebody had emptied on their way
   * to changing their mind.
   */
  async letGo(): Promise<boolean> {
    /*
     * THE TABS THIS SWEEP HAS ALREADY ACCOUNTED FOR, which is what makes the
     * corrections question fire exactly once for a project with two of them open.
     *
     * `questionBefore` skips the corrections when another open tab still reaches
     * the same project's decisions — see it for why. In a sweep that is every tab
     * of the project, so with nothing carried between iterations each tab would
     * point at the next as the one that still holds them and NOBODY would be
     * asked: the window would close on a project's uncommitted decisions in
     * silence, which is the exact failure this sweep exists to prevent. Carrying
     * the ones already passed makes the LAST tab of each project the one with
     * nothing left to point at, and it is the one that asks.
     */
    const accountedFor = new Set<string>();
    // A copy, because a save made from the dialog can repaint the list underneath
    // this loop, and an iteration over the live signal would be walking an array
    // that moved.
    for (const tab of [...this.all()]) {
      if (await this.questionBefore(tab.id, accountedFor) === 'stay') return false;
      accountedFor.add(tab.id);
    }
    return true;
  }

  /**
   * What this document has to say for itself before it goes, asked once — and
   * ONLY when something would actually be lost.
   *
   * ── THE QUESTION THAT WAS ASKED ABOUT NOTHING ───────────────────────────────
   *
   * This used to ask whenever a tab was `unsaved`, and `unsaved` means "no copy
   * of this exists anywhere you chose" — which is true FROM BIRTH of every book
   * this app opens out of a project, because the project IS where it lives. So
   * closing a tab somebody had done nothing but look at raised a dialog about a
   * loss that had not happened, and a warning that fires when nothing is at stake
   * is how a person learns to dismiss the one that matters. The user ruled on it
   * in a sentence: *"only pop up a confirmation alert if changes have been
   * made."*
   *
   * It is also a warning that outlived its workflow. It was written when Save put
   * a copy somewhere of the user's choosing and the app could reasonably say "you
   * have not done that yet"; saving is the export modal's job now
   * (docs/WORKBENCH.md §6), a project tab that closes loses track of nothing, and
   * Home still lists the book. The DOT stays — `Tab.unsaved` is a fact worth
   * drawing — but it is not a reason to stop somebody on their way out.
   *
   * ── ONE QUESTION FOR TWO LOSSES ─────────────────────────────────────────────
   *
   * A book's filed copy can be out of date, and a scan's corrections can have no
   * save to come back to. Main composes whichever of the two are true into one
   * card, because this codebase has already ruled that a closing document is
   * asked about once (`closeShowing`): a second dialog on top of the first is the
   * app arguing with an answer it already has.
   *
   * ── And the offer to keep the work is a button, not advice ─────────────────
   *
   * A dialog whose only route to keeping the work is *cancel, hunt for Apply,
   * close again* has made the user do the app's job, and the way that ends is
   * that they stop reading the box. So the answer can be "apply these changes,
   * then close" — and it goes through the viewer's own `apply`, the same path the
   * sheet's own button takes, rather than a second commit written for this
   * dialog. AN APPLY MAIN REFUSES LEAVES THE TAB OPEN: closing anyway would have
   * thrown away the very thing the answer asked to keep, and main's own sentence
   * is already in the notice strip saying why it would not land.
   */
  private async questionBefore(
    id: string,
    /**
     * Tabs this same operation has already dealt with — see `letGo`. Empty for
     * an ordinary close, which is dealing with exactly one.
     */
    accountedFor: ReadonlySet<string> = EMPTY_IDS,
  ): Promise<'go' | 'stay'> {
    const current = this.byId(id);
    if (current === null || !api) return 'go';
    /*
     * ── THE SCRAP-GUARD, AND IT IS THE ONE REAL LOSS THIS CARD EVER DESCRIBES ──
     *
     * The other thing this used to ask about — the block editor's uncommitted
     * CURATION — is gone with that editor, and it was never a loss: every strike
     * was already on disk and what ended was a way back. The book viewer's stack
     * is the opposite — in memory, the only copy, and scrapped by closing, which is
     * the ruling (docs/RENDERER.md §3: "Apply writes and clears; closing without
     * applying scraps it"). It is asked about PER TAB: a stack belongs to one
     * tab's book viewer and closing that tab is the moment it goes, whatever else
     * is open onto the same book.
     */
    const stack = current.kind === 'book' ? this.stacks.bookStackFor(current.id) : null;
    /*
     * A BOOK TAB THAT IS NOT THE ONE SHOWN HAS NO LIVE VIEWER AND STILL HAS A
     * STACK — the parked one (`BookStacksService`). Closing it from the library
     * while another document is up would otherwise skip this question entirely and
     * drop unwritten work with no sentence anywhere, which is the one loss this
     * card exists to prevent.
     *
     * READ AND NOT CLAIMED: the answer may be "keep", and a claim would have
     * destroyed the work the person just said they wanted.
     */
    const parked = stack === null && current.kind === 'book'
      ? this.stacks.parkedFor(current.id)
      : null;
    const edits = stack !== null && stack.pending() > 0
      ? stack.pending()
      : parked !== null && unwritten(parked.landed, parked.pending) > 0
        ? unwritten(parked.landed, parked.pending)
        : null;
    if (!current.modified && edits === null) return 'go';

    const answered = await api.confirmClose({
      title: current.title,
      modified: current.modified,
      savedPath: current.savedPath,
      edits,
    });
    if (answered === 'keep') return 'stay';
    /*
     * A REFUSAL LEAVES THE TAB OPEN: closing anyway would throw away the very
     * thing the answer asked to keep, and main's own sentence is already on the
     * notice strip saying why it would not land.
     */
    if (answered === 'save' && stack !== null) return await stack.apply() ? 'go' : 'stay';
    if (answered === 'save' && parked !== null) {
      /*
       * APPLYING A PARKED STACK NEEDS NO VIEWER: the doors are main's
       * (`book:amend` rewrites the tip the person was standing on;
       * `book:apply` lands a step), and the viewer was only ever the thing that
       * pressed them. Amend when the parked stack grew out of a recorded tip,
       * exactly as the viewer itself decides.
       */
      try {
        const history = parked.landed.length > 0
          ? await api.book.amend(current.path, parked.pending)
          : await api.book.apply(current.path, parked.pending);
        this.ledger.adopt(current.path, history);
        return 'go';
      } catch (err) {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
        return 'stay';
      }
    }
    return 'go';
  }

  /**
   * How many OTHER open tabs would still reach this document's project after it
   * goes — the count that decides whether the corrections question is owed.
   *
   * EDITORS DO NOT COUNT. An editor tab is a face of its book rather than a
   * document of its own, and closing the book closes it (`close`), so counting
   * one would be counting the tab that is going with this one.
   *
   * A DOCUMENT IN NO PROJECT HAS NO SIBLINGS: somebody's own PDF out of their
   * Downloads folder has no project, no curation and nothing to be the last way
   * back to. Zero is the honest answer and it is also the one that lets the
   * question be asked, which costs nothing — main answers null for it.
   */
  private otherTabsIn(doomed: Tab, accountedFor: ReadonlySet<string>): number {
    const dir = this.projectDirOf(doomed);
    if (dir === null) return 0;
    const key = fold(dir);
    return this.all().filter((tab) => {
      if (tab.id === doomed.id || accountedFor.has(tab.id)) return false;
      const own = this.projectDirOf(tab);
      return own !== null && fold(own) === key;
    }).length;
  }

  /**
   * Close a tab, asking first when it has something to lose.
   *
   * The question is `questionBefore` above, asked in the app's own card
   * (`ConfirmService`). THE BOOK IS NOT DELETED EITHER WAY (see
   * electron/workspace.ts) and neither are its corrections, so what closing costs
   * is a filed copy left behind and a state they can come back to, never the work
   * itself.
   *
   * `ask: false` FOR A CLOSE THAT IS PART OF A DELETE, and it is the difference
   * between one question and two. The question's whole subject is work the user
   * might want to keep — a copy to keep track of, corrections to keep a way back
   * to — and a document being deleted is one where all of that is false and the
   * offer to save it is an offer to write bytes into a file about to be
   * unlinked. The delete's own confirmation asked the only question there is; a
   * second card on top of it, asking about saving the thing they just told the
   * app to destroy, is the app arguing with an answer it already has.
   *
   * ── AND IT NEVER TOUCHES THE POINTER ────────────────────────────────────────
   *
   * Closing what is on screen goes to Home, and this method says nothing about
   * it. There used to be a line here that cleared the pointer when the closed tab
   * was the shown one; the split deleted it, because `StageService.active` is a
   * COMPUTED over this list and the pointer, so a document that leaves the list
   * takes the stage's answer with it by construction. That is the whole reason the
   * pointer is not validated on write: close is a fact about the LIST, and having
   * to remember to tidy up a second structure after it is exactly the kind of
   * bookkeeping that rots.
   */
  async close(id: string, ask = true): Promise<void> {
    if (!this.all().some((candidate) => candidate.id === id)) return;
    if (ask && await this.questionBefore(id) === 'stay') return;

    // The list is re-read AFTER the dialog: that box is modal to the window but
    // not to the app, and a conversion can finish and open a tab while it is up.
    const tabs = this.all();
    if (!tabs.some((candidate) => candidate.id === id)) return;

    // The parked stack goes with the tab — the closing question above already
    // asked about it, so this is the scrap the person chose.
    this.stacks.dropParked(id);
    this.all.set(tabs.filter((candidate) => candidate.id !== id));
    /*
     * NOTHING PER-TAB IS LEFT TO FORGET, and the emptiness is the wave landing.
     * A close used to drop five maps keyed by tab id — the frame's selection and
     * category tally, the persisted undo ledger, whether a block was being typed
     * in, and the translation world a word edit belonged to — and every one of
     * them served a surface that is deleted (docs/RENDERER.md §7). What a tab
     * still owns is its BookStack, and that is released by the viewer that
     * registered it (`releaseBookStack`), because the viewer is what knows the
     * stack has finished with the document rather than merely stopped being drawn.
     */
    this.leaveIfHostedAndEmpty();
  }

  /**
   * HOSTED, THE LAST DOCUMENT GOING TAKES THE WINDOW WITH IT.
   *
   * *"when I closed the tabs it brought me to the 'foundry home', which is a
   * project picker. It shouldn't bring me there. It should just close the window
   * if it runs out of tabs."* (User ruling, 2026-08-16.) Hosted, the books are
   * BookForge's and Home is a second answer to "what books do I have" — the same
   * rule that already takes the dock's Home button and Home's own recents away
   * (`hosted`, core/foundry.ts). The held bench above it is no better: it offers
   * a tree and a way back to a library this window is not the app for.
   *
   * STANDALONE NOTHING CHANGES, and that is not a concession — Home is where the
   * app legitimately begins, and the bench that keeps the project past its last
   * tab is last month's ruling about being thrown out of the room you were
   * working in (see `StageService.heldProject`).
   *
   * ASKED ONLY WHERE A CLOSE EMPTIED THE WINDOW, never from an effect on the
   * count. A hosted window has nothing open for the moment between loading and the
   * document it was opened for arriving (`openFoundryWindow`, electron/mount.ts),
   * and a watcher on "nothing open" would shut the window before the file got
   * there. Its one caller is a gesture — the last document closed — which is what
   * "runs out of tabs" means.
   *
   * IT IS THE ✕'S OWN PATH. `closeWindow` re-enters the window's close handler in
   * main, so the documents are asked what closing costs exactly as they always
   * are — an answer of yes, immediately, with nothing left open.
   */
  private leaveIfHostedAndEmpty(): void {
    if (!hosted() || this.all().length > 0) return;
    // `hosted()` is only ever true because main answered `app:hosted`, so there
    // is a bridge here by construction. The `?.` is this file's spelling for
    // reaching main, not a second opinion about whether one exists.
    void api?.closeWindow();
  }

  // ── The PDF viewer's two view modes ──────────────────────────────────────

  toggleLayerView(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, layerView: !tab.layerView } : tab)));
  }

  toggleThumbnails(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, thumbnails: !tab.thumbnails } : tab)));
  }

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
  noteDocumentEdited(id: string): void {
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
  async save(id: string): Promise<void> {
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
  async saveAs(id: string): Promise<void> {
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
  async saveExportCopy(tab: Tab): Promise<void> {
    await api?.saveExport(tab.path).catch((err: unknown) => {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    });
  }

  private patch(id: string, changes: Partial<Tab>): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
}

/*
 * FOUR HELPERS LIVED HERE AND THEY WERE ALL COLUMN ARITHMETIC: `equalise` (every
 * pane an equal share of the row), `addToStrip` (insert directly after the tab on
 * top, which is where a person expects the next thing to appear), `withoutTabs`
 * (closing falls back to the neighbour on the right, then the left) and
 * `crowdedTarget` (which of five columns a document that wanted one of its own has
 * to settle for). Every one of them answered a question the single viewer does not
 * ask — see this file's header for the ruling that stopped asking it.
 */

/**
 * Windows paths differ by case and separator and are the same file.
 *
 * EXPORTED FOR `PositionSyncService`, which compares a step's resolved document
 * against the paths of the tabs this file holds. One spelling of that comparison,
 * in the file that owns the paths — two copies of four characters is how two
 * services learn to disagree about whether `C:\A\b.pdf` and `c:/a/B.pdf` are one
 * document. (`fold` in @shared/original is the neighbouring rule and NOT the same
 * one: it also strips a trailing separator, which is right for a directory and
 * wrong for a file.)
 */
export function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * What the save dialog opens pre-filled with.
 *
 * THE FILE'S OWN NAME, AND THIS IS ONE OF THE TWO PLACES A FILENAME BELONGS.
 * Everywhere else in this window a document is called by its book — the viewer's
 * toolbar, the list on the left, the window's title bar — because a person
 * reading their library is thinking about books. A person in a save dialog is
 * thinking about a FILE: it is going into a folder of theirs, beside things they
 * named, and it has to be findable there by whatever their other copy of it is
 * called. It used to be fed the tab's title, which was the same string as the
 * basename for a PDF and quietly stopped being one the moment titles became the
 * book's.
 *
 * The characters removed are the ones Windows refuses outright; a name with a
 * colon in it is common (`Working Towards The Fuhrer: …`) and a save dialog that
 * opened pre-filled with an illegal name would fail on OK with a message from
 * the OS rather than from us.
 */
function suggestName(fileName: string, extension: '.epub' | '.pdf'): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.length > 0 ? cleaned : 'book';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
