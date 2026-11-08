import { Injectable, effect, inject, signal } from '@angular/core';

import { fold } from '@owen/foundry-core/shared/original';
import type { JobKind } from '@owen/foundry-core/shared/types';

import { BookStacksService } from './book-stacks.service';
import { LedgerService } from './ledger.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { QueueService } from './queue.service';
import { api, hosted } from './foundry';
import { TabKind, pathIsProject, Tab, OPENS_ITSELF } from './documents-tabs';
export type { TabKind, Tab } from './documents-tabs';
export { pathIsProject, isExportView, normalise } from './documents-tabs';
import * as opening from './documents-opening';
import * as closing from './documents-closing';
import * as saving from './documents-saving';

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
  readonly projects = inject(ProjectsService);
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
  readonly ledger = inject(LedgerService);
  readonly notices = inject(NoticeService);
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
  readonly stacks = inject(BookStacksService);

  readonly all = signal<Tab[]>([]);

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
  readonly expectUnsaved = new Set<string>();

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
    api?.onDocumentNotice((sentence) => { this.notices.notice.set(sentence); });

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
    /*
     * ONE QUESTION, ONE ANSWER, AND THE BRANCH THAT USED TO BE HERE WAS A BUG.
     *
     * ── Owen's report ─────────────────────────────────────────────────────────
     *
     * *"when i export an epub and then click on it in foundry, the narrate
     * button disappears, but a narrate button appears inside the epub's worktree
     * item. i dont care if theres a narrate button on the epub in the worktree
     * but the narrate button should not disappear if the user clicks epub.
     * thats the exact opposite behavior of what it should be."*
     *
     * ── Why it disappeared, which is not where anybody was looking ───────────
     *
     * This used to ask `pathIsProject` first and, for a book tab, look the path
     * up as a project DIRECTORY by exact match. That is true of the tab
     * `bookTabIn` makes, whose path IS a project. IT IS FALSE OF THE ONE
     * `openExportView` MAKES: that is also `kind: 'book'`, and its path is an
     * EPUB FILE in `final/`. So the exact-directory lookup found nothing, this
     * returned null, and `ActionMenu.hostReady` — which asks only whether the
     * project can run a host act — had no project to ask about.
     *
     * So it was never Narrate that vanished. EVERY host act vanished at once,
     * because the window had stopped being able to say which book was in front
     * of it. The tree's export row kept its button because that path asks what
     * the ROW produces (`produces: 'export'`) and never comes through here,
     * which is exactly the inversion Owen described: the button left the place
     * that had lost the project and stayed in the place that had not.
     *
     * ── The fix is a deletion, and it is provably not a change ───────────────
     *
     * `projectFor` already answers both shapes in one comparison — it tests
     * `target === dir || target.startsWith(dir + '/')`, and its own docblock
     * argues the equality case at length ("THE DIRECTORY ITSELF IS IN ITS OWN
     * PROJECT"), added when the proof sheet hit this same class from the other
     * side. So the branch was asking a narrower version of a question the
     * fallback already answered correctly, and removing it gives the identical
     * answer for every tab whose path IS a project and a right answer for the
     * one whose path is not.
     *
     * ── What is still true, and is somebody else's to fix ───────────────────
     *
     * `pathIsProject` STILL CLAIMS THAT EVERY BOOK TAB'S PATH IS A DIRECTORY,
     * and that claim is false for an export view. It is not repaired here
     * because it is a type predicate seven other sites narrow on, and this
     * defect needed one of them corrected rather than seven audited at speed.
     * The honest discriminator is already on the tab: `viewOnly` is set in
     * exactly one place, `openExportView`, and means precisely "this book tab is
     * a finished file rather than a project".
     */
    return this.projects.projectFor(tab.path)?.dir ?? null;
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
  nameFor(filePath: string): string {
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
    return pathIsProject(tab) ? this.projectTitleOf(tab.path) : this.nameFor(tab.path);
  }

  /**
   * The title of the project AT this directory, or the folder said aloud.
   *
   * The fallback is `nameFor`'s own last resort rather than a second one: a
   * directory no project claims is a book that has left the library while a tab
   * was open, and the honest thing to say about it is whatever its folder is
   * called.
   */
  projectTitleOf(dir: string): string {
    const key = fold(dir);
    const project = this.projects.items().find((one) => fold(one.dir) === key) ?? null;
    return project === null || project.problem !== null || project.title.length === 0
      ? this.nameFor(dir)
      : project.title;
  }

  openViaDialog(): Promise<void> { return opening.openViaDialog.call(this); }

  openDropped(file: File): Promise<void> { return opening.openDropped.call(this, file); }

  openFromList(filePath: string, managed?: Parameters<typeof opening.openFromList>[1]): Promise<void> { return opening.openFromList.call(this, filePath, managed); }

  openProject(projectDir: string, originalPath: string | null, managed?: Parameters<typeof opening.openProject>[2]): Promise<void> { return opening.openProject.call(this, projectDir, originalPath, managed); }

  openFile(filePath: string, managed?: Parameters<typeof opening.openFile>[1]): Promise<void> { return opening.openFile.call(this, filePath, managed); }

  private openFinished(filePath: string, kind: JobKind): void { return opening.openFinished.call(this, filePath, kind); }

  openExportView(path: string, title: string): void { return opening.openExportView.call(this, path, title); }

  bookTabIn(projectDir: string): string { return opening.bookTabIn.call(this, projectDir); }

  captureTabIn(projectDir: string): string { return opening.captureTabIn.call(this, projectDir); }

  private adopt(absolutePath: string): void { return opening.adopt.call(this, absolutePath); }

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
  readonly awaitingBooks = new Set<string>();

  awaitBook(filePath: string): void { return opening.awaitBook.call(this, filePath); }

  openAwaitedBooks(): void { return opening.openAwaitedBooks.call(this); }

  private relocate(from: string, to: string): void { return closing.relocate.call(this, from, to); }

  blankTab(kind: TabKind, path: string, title: string): Tab {
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

  followTo(tabId: string, filePath: string, madeByUs: boolean): void { return closing.followTo.call(this, tabId, filePath, madeByUs); }

  closeShowing(files: readonly string[]): Promise<void> { return closing.closeShowing.call(this, files); }

  letGo(): Promise<boolean> { return closing.letGo.call(this); }

  questionBefore(id: string, accountedFor?: ReadonlySet<string>): Promise<'go' | 'stay'> { return closing.questionBefore.call(this, id, accountedFor); }

  private otherTabsIn(doomed: Tab, accountedFor: ReadonlySet<string>): number { return closing.otherTabsIn.call(this, doomed, accountedFor); }

  close(id: string, ask?: Parameters<typeof closing.close>[1]): Promise<void> { return closing.close.call(this, id, ask); }

  leaveIfHostedAndEmpty(): void { return closing.leaveIfHostedAndEmpty.call(this); }

  // ── The PDF viewer's two view modes ──────────────────────────────────────

  toggleLayerView(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, layerView: !tab.layerView } : tab)));
  }

  toggleThumbnails(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, thumbnails: !tab.thumbnails } : tab)));
  }

  noteDocumentEdited(id: string): void { return saving.noteDocumentEdited.call(this, id); }

  save(id: string): Promise<void> { return saving.save.call(this, id); }

  saveAs(id: string): Promise<void> { return saving.saveAs.call(this, id); }

  saveExportCopy(tab: Tab): Promise<void> { return saving.saveExportCopy.call(this, tab); }

  patch(id: string, changes: Partial<Tab>): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
}
