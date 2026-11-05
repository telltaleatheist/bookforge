import {
  ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal,
} from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { isPdfName } from '@owen/foundry-core/shared/capture';

import { InspectorComponent } from './components/inspector/inspector.component';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { ExportDialogComponent } from './components/export-dialog/export-dialog.component';
import { HostOpDialogComponent } from './components/host-op-dialog/host-op-dialog.component';
import { HostStatusComponent } from './components/host-status/host-status.component';
import { OcrDialogComponent } from './components/ocr-dialog/ocr-dialog.component';
import { OpenDocumentsComponent } from './components/open-documents/open-documents.component';
import { MetadataDialogComponent } from './components/metadata-dialog/metadata-dialog.component';
import { MintMetaDialogComponent } from './components/mint-meta-dialog/mint-meta-dialog.component';
import { SimplifyDialogComponent } from './components/simplify-dialog/simplify-dialog.component';
import { CleanDialogComponent } from './components/clean-dialog/clean-dialog.component';
import { AskReviewDialogComponent } from './components/ask-review-dialog/ask-review-dialog.component';
import { AskPresetsDialogComponent } from './components/ask-presets-dialog/ask-presets-dialog.component';
import { AnalysisDialogComponent } from './components/analysis-dialog/analysis-dialog.component';
import { TranslateDialogComponent } from './components/translate-dialog/translate-dialog.component';
import { CaptureNewDialogComponent } from './components/capture-new-dialog/capture-new-dialog.component';
import { CaptureProgressComponent } from './components/capture-progress/capture-progress.component';
import { SetupWizardComponent } from './components/setup-wizard/setup-wizard.component';
import { QueueBarComponent } from './components/queue-bar/queue-bar.component';
import { ToastTrayComponent } from './components/toast-tray/toast-tray.component';
import { BookStacksService } from './core/book-stacks.service';
import { CaptureService } from './core/capture.service';
import { OpenDocumentsService, pathIsProject } from './core/documents.service';
import { ConfirmService } from './core/confirm.service';
import { IntakeWorkspaceService, isWorkspaceImage } from './core/intake-workspace.service';
import { NoticeService } from './core/notice.service';
import { onHostNotice } from './core/bookforge-window';
import { PdfPagesService } from './core/pdf-pages.service';
import { PositionSyncService } from './core/position-sync.service';
import { ProjectsService } from './core/projects.service';
import { StageService } from './core/stage.service';
import { UiService } from './core/ui.service';
import { UnappliedService } from './core/unapplied.service';
import { api } from './core/foundry';
import * as dropping_ from './app.drop';
import * as keys from './app.keys';

/**
 * The shell: the LIBRARY SIDEBAR on the left — the tree above, the tool dock
 * pinned to its foot — whatever route is open in the middle, and the inspector
 * on the right, with the queue chip in the top row, its panel hanging under
 * that over the page, and the dialogs over everything.
 *
 * AND, ABOVE ALL OF THAT, A ROW THAT IS USUALLY NOT THERE. The host status chip
 * is the one surface in this window's chrome that belongs to the application
 * Foundry is mounted inside: it says what that application is doing, in that
 * application's own words, and it is drawn at all only while somebody is
 * pushing one (`HostStatusComponent`). Standalone the row has no height, no
 * padding and no element — the chip's own host is display:none — so the window
 * this app opens for itself is unchanged in every pixel.
 *
 * THE DOCK HAS BEEN IN THREE PLACES AND IS IN THE SIDEBAR NOW. It began as an
 * 88-pixel column on the left beside a 220-pixel document list — 308 pixels of a
 * window whose whole job is showing pages, furniture before a book began — and
 * moved to a row along the bottom, where it cost about 58 pixels of height that
 * no page needed. Owen moved it a second time (2026-08-17 22:30): *"lets move
 * the nav rail buttons to the left side, pinned to the bottom of the tree
 * sidebar. the tree can be pinned to the top, and if it extends past available
 * space… the user can scroll down to see more of the tree."*
 *
 * SO THE WINDOW IS ONE ROW AGAIN and the buttons cost no height at all: they sit
 * under a tree that was already there, in a panel that was already that wide.
 * What the bottom row bought — a dock as wide as the window — is also what it
 * cost, because the tree beside it kept growing and the two were spending the
 * same screen. The z-index ladder is untouched by either move (viewer < queue 900 <
 * dialogs 1200): the action menu is inside a flex column now and overlaps
 * nothing. The rung once belonged to a pill docked in the bottom-right corner;
 * it belongs to the queue bar and its dropdown now (Wave 43), unchanged in height.
 * (There was a rung at 30 for the workspace's drag SHIELD, a sheet of glass over
 * every pane so a book could be dropped onto an <iframe>; it went with the panes
 * — docs/PLAN.md §4, unit 8b.)
 *
 * BOTH SIDE PANELS ARE IN THE SHELL AND NOT IN THE WORKSPACE PAGE, because
 * neither is a fact about a route: the lists stay up on Settings, and clicking a
 * row there navigates back to the workspace on its way to showing the document.
 * The documents panel is hidden outright while nothing is open, so Home keeps
 * the whole window it has always had rather than opening beside 220 pixels of an
 * empty list. It collapses to a 30-pixel stub whose only content is the button
 * in the window's top-left corner — the same toggle Ctrl+B and the action
 * menu's Documents row press, so the panel has three ways in and the button is never
 * the one that hides itself. The inspector is up whenever the focused document
 * is an unpacked book, which is the only state it has anything to say in.
 *
 * The DROP TARGET is the whole window rather than the viewer, because a person
 * dropping a book at the app is not aiming at a rectangle — and because with an
 * <iframe> filling the centre, the PDF plugin would eat a drop aimed there.
 *
 * ── The keyboard ─────────────────────────────────────────────────────────────
 *
 * Ctrl/Cmd+S, Ctrl/Cmd+W and Ctrl/Cmd+B are MENU items (electron/main.ts) and
 * arrive here as `menu:action`: a menu accelerator and a keydown listener for the
 * same chord both fire, and only the menu is discoverable. The documents panel is
 * there because a panel you have hidden leaves nothing on screen to bring it back
 * except the rail. Ctrl/Cmd+Tab is handled here because a menu item labelled
 * "Next tab" is noise, and Escape because a dialog that will not dismiss on
 * Escape is a dialog people learn to avoid opening.
 *
 * CTRL+\ AND CTRL+1…5 ARE NOT HERE ANY MORE. The first was View → Split right —
 * on the menu precisely because a single-column workspace had nothing on screen
 * saying a second column was possible — and the second focused one of the five.
 * Both addressed columns, and there are none: one viewer, one document (ruling
 * 2026-08-17, quoted in full in `StageService`'s header).
 */
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet, OpenDocumentsComponent, InspectorComponent,
    QueueBarComponent, ToastTrayComponent,
    OcrDialogComponent, ExportDialogComponent, TranslateDialogComponent,
    SimplifyDialogComponent, CleanDialogComponent,
    MetadataDialogComponent, MintMetaDialogComponent, AskReviewDialogComponent, AskPresetsDialogComponent,
    AnalysisDialogComponent,
    ConfirmDialogComponent, HostOpDialogComponent, HostStatusComponent,
    CaptureNewDialogComponent, CaptureProgressComponent, SetupWizardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly documents = inject(OpenDocumentsService);
  readonly captures = inject(CaptureService);
  /**
   * The intake workspace — where a dropped IMAGE goes when no light table is in
   * front of it. Injected here because the drop seam is here: this is the one
   * handler that sees every file the window is given, and sorting them is a
   * decision about the drop rather than about any surface.
   */
  readonly shelf = inject(IntakeWorkspaceService);
  /**
   * The rasterizer that turns a dropped PDF into a pile of pages, and the card
   * that asks which of the two things a dropped PDF means. Both are here for the
   * shelf's reason one line up: this handler is the one place that sees the
   * whole drop, and "is this a book to open or a book to take apart" is a
   * question about the GESTURE, not about any surface.
   */
  readonly pdfPages = inject(PdfPagesService);
  readonly confirm = inject(ConfirmService);
  readonly stage = inject(StageService);
  private readonly notices = inject(NoticeService);
  readonly stacks = inject(BookStacksService);
  /**
   * THE POSITION SYNC IS INJECTED AND NEVER CALLED, and that is the point.
   *
   * `PositionSyncService` is three effects and a focus mirror: the pointer moving
   * and the viewer following, a project met for the first time opening on the
   * picture its position names, and a document that changed under a position that
   * did not move. Nothing reads it — the two surfaces that ask `documentShownFor`
   * inject it themselves — so with `providedIn: 'root'` it would simply never be
   * CONSTRUCTED, its effects would never register, and every one of those
   * promises would stop being kept with nothing on screen to say so.
   *
   * The shell is where that instantiation belongs: it is the one component that
   * exists for the whole life of the window, and before unit 8c the same guarantee
   * came for free because all of this lived in the class App injected for its
   * other members (docs/PLAN.md §4).
   */
  readonly positions = inject(PositionSyncService);
  /**
   * The library, read for one question: has this app imported the document in
   * front of the user? A scan with a project behind it has a history worth a
   * panel; one dropped from a folder of somebody's own has nothing at all.
   */
  private readonly projects = inject(ProjectsService);
  protected readonly ui = inject(UiService);
  /** The card before File→Export runs past unapplied work — see `onMenuAction`. */
  private readonly unapplied = inject(UnappliedService);
  private readonly router = inject(Router);

  /*
   * `documentsUp` STOOD HERE AND IS DELETED, which is the sixth ruling's one
   * structural consequence.
   *
   * It answered "is there anything to list", and the panel was drawn only when
   * it was true: an empty list was 220 pixels of nothing taken off Home, which
   * is the one screen in this app that wants the window. Every word of that was
   * right while the panel held a list and nothing else.
   *
   * THE PANEL HOLDS THE APP'S TOOLS NOW. Home, Documents, Read, Export,
   * Translate, Simplify, Metadata and Settings are pinned to its bottom (Owen,
   * 2026-08-17 22:30), so a sidebar that removed itself when nothing was open
   * would remove the only route to Settings from the screen the app STARTS on.
   * An empty tree above a full dock is not nothing, so the gate had nothing left
   * to protect and the panel is permanent chrome.
   *
   * WHAT THE USER CAN STILL DO IS COLLAPSE IT, which is `documentsShown` and is
   * unchanged — and the stub it collapses to keeps the tools, icon-only, for the
   * same reason this gate went.
   */

  /**
   * The inspector is up when there is something to inspect.
   *
   * THE BOOK, ALWAYS — and this is the line R6c owed. The panel's surviving
   * halves are the proof sheet's: Chapters, Notes, Furniture, the standing strip
   * (docs/RENDERER.md §5). Every one of them is about a `book` tab, and this gate
   * admitted `pdf` and `epub` and not `book` — so the panels R4 landed were drawn
   * for a tab kind that could never be focused while they were on screen. The two
   * kinds it did admit are the two that died: an EPUB in the iframe reader, and a
   * scan in block view.
   *
   * AND BESIDE ANY DOCUMENT THIS APP HAS IMPORTED, which is the Steps section's
   * doing. A project's HISTORY is something to inspect about a scan nobody has
   * done anything to: what was imported, what has been read, what was saved and
   * what each of those was made from. It is also the panel where somebody steps
   * back to an earlier state, and hiding that behind a mode would be the app
   * hiding the one thing that explains why their book looks as it does.
   *
   * A PDF DROPPED FROM OUTSIDE THE LIBRARY still gets nothing, which is the old
   * rule's promise kept: no project, no history, no accordions, and 260 pixels of
   * window that Home wanted.
   */
  protected readonly inspectorUp = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    // A light table is a project's own surface exactly as a book is: it has a
    // history, it has steps, and the 260 pixels are what the person came for.
    if (pathIsProject(tab)) return true;
    const project = this.projects.projectFor(tab.path);
    return project !== null && project.problem === null;
  });

  protected readonly dropping = signal(false);
  dragDepth = 0;

  /**
   * Ask main whether there is anything to offer, wait out the wizard if one is
   * open, then ask the person — and say what came of it.
   *
   * THE RESULT IS ALWAYS SPOKEN, both halves. A start that worked is the only
   * confirmation that the tiles are about to light; a start that has not
   * answered yet is not a failure and says so in main's own words. Silence after
   * pressing a button is the thing this whole evening has been removing.
   */
  private async offerToStartCrucible(): Promise<void> {
    if (!api) return;
    /*
     * ASKED OF MAIN, not read off `ui.setupOpen()`. That signal is set by the
     * wizard's own bootstrap, which is a promise racing this constructor — so
     * reading it here would answer "closed" on exactly the run where the wizard
     * is about to open. `setup.state()` is the fact the wizard itself decides
     * from, and asking the same question of the same door cannot lose the race.
     */
    const [inHost, setup] = await Promise.all([api.hosted(), api.setup.state()]);
    if (inHost || !setup.completed) return;
    if (await api.crucible.offerStart() !== 'start') return;
    this.notices.notice.set('Starting Crucible…');
    const result = await api.crucible.startCrucible();
    this.notices.notice.set(result.detail);
  }

  constructor() {
    // What BookForge says about work it did for this window, e.g. a narration queued.
    onHostNotice((text) => this.notices.notice.set(text));

    // The File menu's Settings item. Main cannot route; it can only say where.
    api?.onNavigate((route) => { void this.router.navigateByUrl(route); });

    /*
     * ── CRUCIBLE IS HERE AND IS NOT RUNNING. OFFER TO START IT. ─────────────
     *
     * Owen, 2026-09-15 (relayed through BookForge): *"the foundry app should ask
     * if they want to start crucible."* Standalone only, and that is enforced in
     * MAIN rather than here — `crucible:offer-start` answers `later` outright
     * when the window is hosted, when an engine is already answering, and when
     * there is none installed, so three startups out of four draw nothing and
     * this call costs one ping.
     *
     * NOT ON A FIRST RUN, AND NOT DEFERRED UNTIL AFTER ONE EITHER. The wizard is
     * not in `UiService.dialogs` (its own header says why: it is a flow, not a
     * question), so a confirm card would happily open on top of it — and
     * somebody meeting this app for the first time would be asked about a
     * program they have not been introduced to yet, over the screen that was
     * about to introduce it. **The wizard's own engine step is where that person
     * is served**, and it serves them better than a yes/no card: it shows the
     * card, what it can do, and the doors. So a run that opens the wizard skips
     * this entirely rather than queueing behind it.
     */
    void this.offerToStartCrucible();

    /*
     * The hosted door onto a book. A press of Edit-in-Foundry in the host
     * resolves the project in main (`openFoundryWindow`, electron/mount.ts) and
     * pushes exactly what a click on Home's own row carries — so consuming it
     * IS that click, made by the same method, landing on the same step the
     * ledger says the book is standing on. Standalone, nothing sends this.
     */
    api?.onProjectOpen((project) => {
      void this.documents.openProject(project.dir, project.originalPath, project.managed);
    });

    /*
     * Export / Close tab / Documents. Every one of them acts on renderer state —
     * the document on screen, the panel — so main asks rather than does. (Split
     * right was the fourth, and it went with the columns: docs/PLAN.md §4, unit
     * 8b, and `StageService`'s own header for the ruling.)
     *
     * `export` IS FIRST, AND THE ORDER IS NOT COSMETIC. This chain ends in a
     * fall-through to `closeActive`, which is a reasonable default for exactly as
     * long as every action main sends is named above it. Main's File menu started
     * sending `export` on Ctrl+S the day Save became the export modal's job
     * (docs/WORKBENCH.md §4, Unit E), the name landed here unrecognised, and the
     * chord that has meant "keep this" in every application anybody has ever used
     * silently CLOSED THE DOCUMENT instead. A fall-through that can turn a new
     * verb into a destructive one is a shape worth naming: anything main learns to
     * say gets a branch here before it is taught to say it.
     */
    api?.onMenuAction((action) => {
      /*
       * THE MENU'S EXPORT ASKS THE SAME QUESTION THE RAIL'S DOES — the card about
       * work nobody applied (`UnappliedService`). It is asked HERE, at the third
       * door onto the same dialog, rather than inside `UiService.openExport`
       * where one line would have covered all three: that service would have to
       * inject the gate, the gate reaches the stacks and the stacks reach the
       * confirm card, and the confirm card injects `UiService` — a dependency
       * cycle Angular would refuse at startup. Three call sites and no cycle is
       * the honest trade, and this comment is the reason it is not tidier.
       */
      if (action === 'export') {
        void this.unapplied.clearedHere('export').then((ok) => { if (ok) this.ui.openExport(); });
      }
      else if (action === 'save') void this.stage.saveActive();
      else if (action === 'save-as') void this.stage.saveActiveAs();
      else if (action === 'toggle-documents') this.toggleDocuments();
      else if (action === 'undo') this.undo(false);
      else if (action === 'redo') this.undo(true);
      else void this.stage.closeActive();
    });

    /*
     * THE WINDOW IS GOING, AND THE DOCUMENTS IN IT HAVE NOT BEEN ASKED.
     *
     * Quit and the window's ✕ used to bypass per-tab closing entirely — the window
     * was destroyed and the tabs went with it — which was harmless while the only
     * thing at stake was a copy of a file, and is not now that closing a scan is
     * the event that ends its session-scoped undo history. Main raises the question
     * here rather than answering it itself because what is OPEN is renderer state:
     * main knows which files were ever opened, not which ones are in a pane now.
     *
     * ANSWERED EXACTLY ONCE, whatever happens. A window that failed to reply would
     * be a window that can never be quit, so the failure path answers yes: the
     * corrections are on disk either way, and refusing to let somebody close their
     * app because this code threw would be the larger of the two failures.
     */
    api?.onWindowClosing(() => {
      void this.documents.letGo()
        .catch(() => true)
        .then((go) => api?.letWindowClose(go));
    });

    // The window says which document is open. The OS window list is the one
    // place a person looks when three of these are running against three books.
    //
    // The DOCUMENT rather than the active tab: an HTML editor is a face of its
    // book and carries neither its name nor its flags, so a window titled
    // "Bleak House — HTML" with no dot on it would be lying twice about a book
    // that has unsaved edits.
    effect(() => {
      const tab = this.stage.activeDocument();
      if (tab === null) {
        document.title = 'Foundry';
        return;
      }
      // One bullet for either kind of "not filed away yet". The window list is a
      // glance, not a status report; the document list and its tooltip say which.
      const mark = tab.unsaved || tab.modified ? ' •' : '';
      document.title = `${tab.title}${mark} — Foundry`;
    });
  }

  /**
   * Ctrl+B, from the menu.
   *
   * The rail's own button is DISABLED with nothing open, but an accelerator
   * cannot grey itself out against renderer state — so the one way this cannot
   * do anything arrives as a sentence rather than as a keypress that appears to
   * have been swallowed.
   */
  private toggleDocuments(): void {
    if (this.documents.tabs().length === 0) {
      this.notices.notice.set('There are no open documents to list — the panel appears with the first one.');
      return;
    }
    this.ui.toggleDocuments();
  }

  undo(redo: boolean): void { return keys.undo.call(this, redo); }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent): void { return keys.onKeyDown.call(this, event); }

  @HostListener('window:dragenter', ['$event'])
  protected onDragEnter(event: DragEvent): void { return dropping_.onDragEnter.call(this, event); }

  @HostListener('window:dragover', ['$event'])
  protected onDragOver(event: DragEvent): void { return dropping_.onDragOver.call(this, event); }

  @HostListener('window:dragleave', ['$event'])
  protected onDragLeave(event: DragEvent): void { return dropping_.onDragLeave.call(this, event); }

  /**
   * WHAT A DROP WOULD MEAN RIGHT NOW, said on the veil before it happens.
   *
   * The veil promised "Drop a PDF to open it" whatever was on screen, which
   * was true until a light table could be on screen and is a lie the moment one
   * is. It is the same sentence `onDrop` acts on, read off the same tab, so
   * the two cannot drift into promising one thing and doing another.
   *
   * AND IT NAMES BOTH DOORS NOW, because a drop on the ordinary window has two
   * meanings since Wave 38: a document opens, and an IMAGE goes to the intake
   * workspace. The veil promising only the first over a window that will do
   * either would be the same lie in a smaller font. Hosted there is no
   * workspace, so hosted the veil says what it always said.
   */
  protected readonly dropSays = computed(() => {
    /*
     * A LIGHT TABLE TAKES A PDF TOO NOW, and the veil says so — the same
     * sentence `onDrop` acts on, off the same tab, so the two cannot drift.
     * "Photographs" alone was true until `CaptureService.intake` learned to
     * explode a scan, and a person holding one over the table would have read a
     * promise that did not include what they were holding.
     */
    if (this.intaking() !== null) return 'Drop photographs to add them, or a PDF to take apart';
    return this.shelf.available()
      ? 'Drop a PDF to open or take apart, or photographs to make a book from'
      : 'Drop a PDF to open it';
  });

  /**
   * The capture project a dropped file would go INTO, or null for the document
   * door.
   *
   * ── Why this is at the window and not in the grid ──────────────────────────
   *
   * The grid HAS a drop strip, and it was not enough: it is a strip down one
   * side, so a drop anywhere else on the light table — the table itself, the
   * empty state, the header — fell past it to this handler and was offered to
   * the document admission, which answered "IMG_0238.HEIC is not something
   * Foundry opens". That is what Owen saw in the first minutes of the
   * acceptance run.
   *
   * The fix is not a bigger rectangle. This handler exists precisely because
   * "dropping a book at the app is not aiming at a rectangle" (the docblock
   * above), and photographs deserve the same: WITH A CAPTURE PROJECT IN FRONT,
   * a file dropped anywhere in the window means intake. The strip stays, so the
   * gesture still has somewhere obvious to aim if somebody wants to.
   *
   * Read from the FRONT TAB rather than from the router or a mode flag, because
   * the front tab is the thing a person believes they are dropping onto — and
   * it is the same fact `dropSays` puts on the veil.
   */
  readonly intaking = computed(() => {
    const tab = this.stage.activeDocument();
    return tab !== null && tab.kind === 'capture' ? tab : null;
  });

  @HostListener('window:drop', ['$event'])
  protected onDrop(event: DragEvent): void { return dropping_.onDrop.call(this, event); }

  sortPdfs(pdfs: readonly File[]): Promise<void> { return dropping_.sortPdfs.call(this, pdfs); }
}
