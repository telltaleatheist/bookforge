import {
  ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal,
} from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';

import { InspectorComponent } from './components/inspector/inspector.component';
import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { ExportDialogComponent } from './components/export-dialog/export-dialog.component';
import { OcrDialogComponent } from './components/ocr-dialog/ocr-dialog.component';
import { OpenDocumentsComponent } from './components/open-documents/open-documents.component';
import { MetadataDialogComponent } from './components/metadata-dialog/metadata-dialog.component';
import { SimplifyDialogComponent } from './components/simplify-dialog/simplify-dialog.component';
import { TranslateDialogComponent } from './components/translate-dialog/translate-dialog.component';
import { QueueShelfComponent } from './components/queue-shelf/queue-shelf.component';
import { ToolRailComponent } from './components/tool-rail/tool-rail.component';
import { BookStacksService } from './core/book-stacks.service';
import { OpenDocumentsService } from './core/documents.service';
import { NoticeService } from './core/notice.service';
import { PositionSyncService } from './core/position-sync.service';
import { ProjectsService } from './core/projects.service';
import { StageService } from './core/stage.service';
import { UiService } from './core/ui.service';
import { api } from './core/foundry';

/**
 * The shell: the open-documents panel on the left, whatever route is open in the
 * middle, the inspector on the right, and the tool dock along the BOTTOM — with
 * the queue shelf floating over all of it and the dialogs over everything.
 *
 * THE DOCK MOVED OFF THE LEFT EDGE. It was an 88-pixel column beside a
 * 220-pixel document list, so 308 pixels of a window whose whole job is showing
 * pages were furniture before a book began. Along the bottom it costs about 58
 * pixels of height, which no page needs, and the width goes back to the
 * documents. The z-index ladder is untouched by the move (viewer < rail 40 <
 * shelf 900 < dialogs 1200): the dock is a flex row rather than a floating bar,
 * so it overlaps nothing, and the one thing that DID overlap it — the shelf's
 * pill, fixed at the bottom right — lifts itself by the dock's own height token.
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
 * in the window's top-left corner — the same toggle Ctrl+B and the dock's
 * Documents item press, so the panel has three ways in and the button is never
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
    RouterOutlet, ToolRailComponent, OpenDocumentsComponent, InspectorComponent,
    QueueShelfComponent, OcrDialogComponent, ExportDialogComponent, TranslateDialogComponent,
    SimplifyDialogComponent, MetadataDialogComponent,
    ConfirmDialogComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="shell">
      <div class="body">
        @if (documentsUp()) {
          <!-- Collapsed, it is a 30px stub holding the button that brings it
               back. The class is set HERE, on the element the shell's flex row
               measures, so the width change and the flag are one pass. -->
          <app-open-documents [class.shut]="!ui.documentsShown()" />
        }
        <main class="main"><router-outlet /></main>
        @if (inspectorUp()) {
          <app-inspector />
        }
      </div>
      <app-tool-rail />
      <app-queue-shelf />

      @if (ui.ocrOpen()) {
        <app-ocr-dialog />
      }

      @if (ui.exportOpen()) {
        <app-export-dialog />
      }

      @if (ui.translateOpen()) {
        <app-translate-dialog />
      }

      @if (ui.simplifyOpen()) {
        <app-simplify-dialog />
      }

      @if (ui.metadataOpen()) {
        <app-metadata-dialog />
      }

      <!-- Always mounted, unlike the three above: it owns its own visibility
           because the service that settles its promise has to be able to close
           it from anywhere, including from another dialog opening. -->
      <app-confirm-dialog />

      @if (dropping()) {
        <div class="drop-veil"><span>Drop a PDF to open it</span></div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    /* A column now: the documents and the dock. \`min-height: 0\` on the row is
       what stops a long chapter list pushing the dock off the bottom of the
       window — a flex item does not shrink below its content without it. */
    .shell { display: flex; flex-direction: column; height: 100%; }
    .body { display: flex; flex: 1; min-height: 0; }
    .main { flex: 1; min-width: 0; height: 100%; overflow: hidden; }

    .drop-veil {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-overlay);
      backdrop-filter: blur(4px);
      border: 2px dashed var(--accent);
      color: var(--text-primary);
      font-family: var(--font-display);
      font-size: 16px;
      font-weight: 600;
      pointer-events: none;
    }
  `],
})
export class App {
  private readonly documents = inject(OpenDocumentsService);
  private readonly stage = inject(StageService);
  private readonly notices = inject(NoticeService);
  private readonly stacks = inject(BookStacksService);
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
  private readonly positions = inject(PositionSyncService);
  /**
   * The library, read for one question: has this app imported the document in
   * front of the user? A scan with a project behind it has a history worth a
   * panel; one dropped from a folder of somebody's own has nothing at all.
   */
  private readonly projects = inject(ProjectsService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  /**
   * The panel is in the DOM when there is something to list, and nothing else.
   *
   * It used to also test `documentsShown`, which is now the panel's own business:
   * put away, it draws a 30-pixel stub holding the collapse button, so the button
   * that brings it back is where the button that put it away was. What this still
   * decides is the empty case — an empty list is 220 pixels of nothing taken off
   * Home, which is the one screen in this app that wants the window, and there is
   * nothing to collapse to a stub either. It comes back by itself with the first
   * document, and `documentsShown` remembers what the user chose across that.
   */
  // The panel stays up for a project the window is still IN, tabs or none —
  // its tree is the door back to every step, and hiding the door with the
  // last tab would strand the empty workspace it was closed into.
  protected readonly documentsUp = computed(
    () => this.documents.tabs().length > 0 || this.stage.heldProject() !== null);

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
    if (tab.kind === 'book') return true;
    const project = this.projects.projectFor(tab.path);
    return project !== null && project.problem === null;
  });

  protected readonly dropping = signal(false);
  private dragDepth = 0;

  constructor() {
    // The File menu's Settings item. Main cannot route; it can only say where.
    api?.onNavigate((route) => { void this.router.navigateByUrl(route); });

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
      if (action === 'export') this.ui.openExport();
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

  /**
   * Ctrl/Cmd+Z, and the one decision that has to be made out here.
   *
   * THERE ARE TWO UNDOS IN THIS WINDOW and the chord means whichever one the
   * caret is in. A text box — a rename input in the inspector, a settings field,
   * a paragraph being retyped on the sheet — has the browser's own history and
   * expects to keep it; that is what `role: 'undo'` used to give it, and taking it
   * away so the book could have the chord would have made typing worse to make
   * editing better. So a text field gets `execCommand`, which is exactly what the
   * role menu did, and everything else goes to the book viewer's stack. (There
   * were three while a chapter could be typed into an iframe this window could not
   * see a caret in; that frame is deleted — docs/RENDERER.md §7.)
   *
   * `execCommand` is deprecated and there is no replacement for programmatic
   * undo of a text field. It is what the platform still implements, and the
   * alternative is a chord that does nothing in a textarea.
   *
   * THE DOCUMENT IS RESOLVED HERE AND HANDED DOWN. `BookStacksService` sits at
   * the bottom of the service chain (docs/PLAN.md §4, unit 8c) and knows about a
   * map keyed by tab id and nothing else; "what is in front of the user" is the
   * stage's question. So the chord's raiser asks the stage and passes the answer,
   * which is the same shape the routing always had — it is only that the two
   * halves now live in the two services that own them. Null is legitimate and
   * gets its own sentence: the chord arrived over Home.
   */
  private undo(redo: boolean): void {
    const focused = document.activeElement;
    const editable = focused instanceof HTMLInputElement
      || focused instanceof HTMLTextAreaElement
      || (focused instanceof HTMLElement && focused.isContentEditable);
    if (editable) {
      document.execCommand(redo ? 'redo' : 'undo');
      return;
    }
    const tab = this.stage.activeDocument();
    void (redo ? this.stacks.redo(tab) : this.stacks.undo(tab));
  }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.ui.ocrOpen()) {
      event.preventDefault();
      this.ui.closeOcr();
      return;
    }
    if (event.key === 'Escape' && this.ui.exportOpen()) {
      event.preventDefault();
      this.ui.closeExport();
      return;
    }
    if (event.key === 'Escape' && this.ui.translateOpen()) {
      event.preventDefault();
      this.ui.closeTranslate();
      return;
    }
    if (event.key === 'Escape' && this.ui.simplifyOpen()) {
      event.preventDefault();
      this.ui.closeSimplify();
      return;
    }
    if (event.key === 'Escape' && this.ui.metadataOpen()) {
      event.preventDefault();
      this.ui.closeMetadata();
      return;
    }
    /*
     * Ctrl+Tab. `event.key` is 'Tab' with ctrlKey, and preventDefault is what
     * stops the browser moving focus through the rail's buttons instead. It
     * cycles the flat list of open documents, which is the only list there is —
     * Ctrl+1…5 went with the columns it was addressing (docs/PLAN.md §4, 8b).
     *
     * TWO HALVES, HERE, because stepping to the next document is the same
     * statement as clicking its row and the position has to follow. The mirror
     * (`standForTab`) is in `PositionSyncService`, which sits ABOVE the stage in
     * the dependency chain, so the stage answers with the id it landed on and the
     * gesture's own handler does the second half. It is exactly what the
     * workspace's pointerdown already does for the other gesture that means
     * "this one".
     */
    if (event.key === 'Tab' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const next = this.stage.nextTab();
      if (next !== null) void this.positions.standForTab(next);
    }
  }

  /**
   * A FILE drag, and only a file drag.
   *
   * A row dragged inside the library — the loose files' reorder — uses the same
   * platform mechanism, and without this test the veil ("Drop a PDF to open it")
   * would slap itself over the whole window the moment one was picked up.
   * `types` is the only part of a drag payload readable before the drop, which
   * is exactly what it is for.
   */
  @HostListener('window:dragenter', ['$event'])
  protected onDragEnter(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.dropping.set(true);
  }

  @HostListener('window:dragover', ['$event'])
  protected onDragOver(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    // Without this the browser navigates the window to the dropped file, which
    // replaces the whole app with a PDF and no way back.
    event.preventDefault();
  }

  @HostListener('window:dragleave', ['$event'])
  protected onDragLeave(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.dropping.set(false);
  }

  @HostListener('window:drop', ['$event'])
  protected onDrop(event: DragEvent): void {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.dropping.set(false);
    // Every file, not just the first: a drop of three books is three tabs, which
    // is the whole reason there are tabs.
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      void this.documents.openDropped(file);
    }
  }
}

/** Whether a drag is carrying files from outside the app, rather than a library row. */
function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}
