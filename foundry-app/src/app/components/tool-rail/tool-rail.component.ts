import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { hosted } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * The dock — Home, the tools, and the gear, along the BOTTOM of the window.
 *
 * IT USED TO BE A COLUMN DOWN THE LEFT, 88 pixels wide for the whole session,
 * beside a 220-pixel document list: 308 pixels of chrome before a page of a book
 * began. Horizontal, it costs about 60 pixels of height and gives all of that
 * width back to the pages, which is the thing this window exists to show. The
 * model is an iPhone control bar or the Mac dock — the tools live along the
 * bottom edge, in reach, out of the way of the document.
 *
 * ICON OVER LABEL SURVIVED THE MOVE, deliberately. Icons alone are a rail you
 * have to hover to read, and this app's tools are not the four everybody already
 * knows: "Select" is a curation mode nobody has met before, and a glyph would
 * teach nobody anything.
 *
 * HOME IS THE FIRST ITEM and it is not a route: it is "no tab is active", so
 * pressing it puts the documents down without closing them and pressing a tab
 * picks one back up. A Home that closed your tabs would be a Home nobody presses.
 */
@Component({
  selector: 'app-tool-rail',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="rail">
      <div class="rail-brand" title="Foundry">⬙</div>

      <div class="rail-tools">
        <!-- Hosted, the host's book list is the library and Home is the one
             surface that would list the same books from the other side — so the
             door to it goes, not just the page behind it. -->
        @if (!hosted()) {
          <button
            class="rail-item"
            [class.active]="tabs.activeId() === null"
            title="Home"
            (click)="home()"
          >
            <span class="rail-icon">⌂</span>
            <span class="rail-label">Home</span>
          </button>
        }

        <!-- The document list. Disabled with nothing open rather than hidden,
             on this rail's usual principle — and because with nothing open the
             panel is not on screen anyway, so a button that toggled a hidden
             thing would be a button with no visible effect. -->
        <button
          class="rail-item"
          [class.active]="documentsUp()"
          [disabled]="tabs.tabs().length === 0"
          title="Show or hide the open documents (Ctrl+B)"
          (click)="ui.toggleDocuments()"
        >
          <span class="rail-icon">☰</span>
          <span class="rail-label">Documents</span>
        </button>

        <!--
          THE TWO HALVES OF WHAT USED TO BE ONE BUTTON, side by side and in the
          order they happen. OCR reads the pages and costs hours; Export turns
          what was read into a document you can take away, and costs nothing.
          They were one item called "OCR / Convert" while they were one job, and
          separating them on the dock is most of what teaches the difference.

          OCR LIGHTS UP when the book in front of you has never been read — the
          same accent this rail uses for "this is active", used here for "this is
          the step you are waiting on". It is the one place in the dock that
          points at what to do next rather than at what is currently on.
        -->
        <button
          class="rail-item"
          [class.active]="ui.ocrOpen()"
          [class.waiting]="ocrWaiting()"
          [title]="ocrWaiting()
            ? 'These pages have not been read yet — this is the step everything else needs'
            : 'Read this book\\'s pages with the vision model'"
          (click)="convert()"
        >
          <span class="rail-icon">⌦</span>
          <span class="rail-label">OCR</span>
        </button>

        <!--
          EXPORT, WHICH THIS SLOT USED TO CALL GENERATE. Same place, same glyph,
          same dialog reworked: what changed is what comes out the other end. A
          generate wrote a file into the working directories and left it there
          among the steps; an export is the finished article, filed under the
          project and never the base for anything else (docs/WORKBENCH.md §3).
          The glyph stays because it was always right for this — one document
          coming off another — and moving it would cost every user who has
          learned where the button is, for nothing.
        -->
        <button
          class="rail-item"
          [class.active]="ui.exportOpen()"
          [disabled]="!canExport()"
          title="Make the finished book: an EPUB, plain text, or the pages reprinted as real type"
          (click)="openExport()"
        >
          <span class="rail-icon">⎘</span>
          <span class="rail-label">Export</span>
        </button>

        <!-- Translate. Disabled rather than hidden away from a book, on this
             dock's usual principle: a translation is a thing you do to a book
             Foundry cast, and somebody standing on the scan should be able to
             see that the tool exists and is not applicable from there. -->
        <button
          class="rail-item"
          [class.active]="ui.translateOpen()"
          [disabled]="!canTranslate()"
          title="Translate this book into another language"
          (click)="translate()"
        >
          <span class="rail-icon">⇄</span>
          <span class="rail-label">Translate</span>
        </button>

        <!-- Simplify, beside Translate because it is the same act aimed at the
             same book: the model says every paragraph again, checked block by
             block, landing as a step of its own. What differs is the destination
             — a reader rather than a language — which is why it is a second
             button and not a checkbox inside the first. -->
        <button
          class="rail-item"
          [class.active]="ui.simplifyOpen()"
          [disabled]="!canSimplify()"
          title="Say this book again in its own language: plainer, more natural, or for a learner"
          (click)="simplify()"
        >
          <span class="rail-icon">≈</span>
          <span class="rail-label">Simplify</span>
        </button>

        <!-- Metadata. Enabled standing on the scan as well as on the book,
             unlike everything else here that needs a book to have been cast: a
             scan has an Info dictionary and correcting it is exactly as useful
             as correcting a package. Which of the two it edits is the
             position's answer, not the pane's. It does NOT rename any file —
             see the dialog for why that is a decision rather than an
             omission. -->
        <button
          class="rail-item"
          [class.active]="ui.metadataOpen()"
          [disabled]="!canEditMetadata()"
          title="The title, author and language this document claims for itself"
          (click)="metadata()"
        >
          <span class="rail-icon">ⓘ</span>
          <span class="rail-label">Metadata</span>
        </button>

        <!--
          ── THREE ITEMS ARE NOT ON THIS DOCK, AND ALL THREE ARE DELETED NOW ──

          SELECT outlined the blocks of a cast EPUB in an iframe; BLOCKS put the
          same surface over a photograph of the pages; EDIT HTML opened a textarea
          over one chapter of a derived document. Each was withdrawn from the dock
          before its machinery went, on the inspector's own rule — withdraw the
          control the moment the thing it does is withdrawn, rather than leaving it
          on screen to invite a gesture and refuse it — and R6c is where the
          machinery followed (docs/RENDERER.md §7).

          WHAT REPLACED ALL THREE IS THE BOOK. Editing happens on the proof sheet,
          against block ids, recorded as ops in the ledger; the PDF produces the
          facsimile and stops (§0 A1). There is no mode to switch on, which is why
          there is no button here to switch it.
        -->
        <!-- The PDF is an output FORMAT inside a dialog rather than a rail
             button of its own: the rail names TOOLS, and picking between an
             EPUB, plain text and a reprint of the pages is one decision about
             one act, made where the rest of that act is described. -->
      </div>

      <div class="rail-foot">
        <a
          class="rail-item"
          routerLink="/settings"
          routerLinkActive="active"
          title="Settings"
        >
          <span class="rail-icon">⚙</span>
          <span class="rail-label">Settings</span>
        </a>
      </div>
    </nav>
  `,
  styles: [`
    /*
      A ROW ALONG THE BOTTOM. The height is a token (--rail-h, styles.scss)
      rather than a number written here, because the queue shelf floats over the
      window at z-index 900 and has to sit ABOVE this dock rather than on top of
      its right-hand end — the shelf reads the same token to lift itself, and two
      hand-kept numbers would drift into a pill covering the Settings button.
    */
    /*
      THE TOOLS ARE CENTRED ON THE WINDOW, not on the space left over beside
      Settings — and that distinction is the whole reason this is a grid and no
      longer a flex row with the tools packed left.

      Centring inside the remaining space would put the group off-centre by half
      the Settings slot's width, which is invisible on a narrow window and
      obvious on a wide one against a centred page. A 1fr / tools / 1fr grid
      gives the brand and the Settings foot columns that SHARE the leftover
      equally, so whatever those two weigh the middle column's centre is the
      window's centre.

      The middle track is minmax(0, auto) rather than a bare auto: auto alone
      cannot shrink below its content, so a window too narrow for the tools
      would push the grid wider than the dock instead of letting the tools
      scroll. With a floor of 0 the track shrinks, .rail-tools scrolls inside
      it, and the group is start-aligned exactly when it no longer fits —
      centring an overflowing row would scroll its FIRST item off the left edge,
      which is worse than a row that begins at the left.

      The side tracks keep grid's automatic minimum (their own content), so the
      Settings item is never clipped by the balancing.
    */
    .rail {
      flex: 0 0 auto;
      width: 100%;
      height: var(--rail-h);
      display: grid;
      grid-template-columns: 1fr minmax(0, auto) 1fr;
      align-items: center;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      padding: 0 10px;
      z-index: 40;
    }

    .rail-brand {
      justify-self: start;
      font-size: 20px;
      color: var(--accent);
      padding: 0 12px 0 4px;
    }

    /* The tools scroll sideways rather than shrinking: a narrow window must not
       squeeze seven labels into unreadable stubs, and the dock is the one place
       every mode in this app is named. */
    .rail-tools {
      display: flex; flex-direction: row; align-items: center;
      gap: 4px; min-width: 0;
      overflow-x: auto; overflow-y: hidden;
    }
    /* Settings stays parked at the right-hand end, divider and all. It is not
       a tool — it is where you go when the tools are not the answer. */
    .rail-foot {
      display: flex; flex-direction: row; align-items: center;
      justify-self: end;
      border-left: 1px solid var(--border-subtle);
      padding-left: 8px; margin-left: 8px;
    }

    .rail-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      flex: 0 0 auto;
      width: 76px;
      padding: 6px 4px;
      background: transparent;
      border: none;
      border-radius: var(--radius);
      color: var(--text-secondary);
      cursor: pointer;
      text-decoration: none;
      transition: background-color 150ms ease, color 150ms ease;
    }
    .rail-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rail-item:disabled { opacity: 0.35; cursor: default; }
    .rail-item:disabled:hover { background: transparent; color: var(--text-secondary); }
    .rail-item.active {
      background: var(--accent-soft);
      color: var(--accent);
    }

    /*
      WAITING, which is not the same as ACTIVE and must not look identical.
      Active means "this panel is open right now"; waiting means "this is the
      step your book needs next". The SAME accent — this app has one word for
      attention, and inventing a second colour for a second kind of it is how a
      palette stops meaning anything — but drawn as an outline rather than a
      fill, so a dock showing both still says which is which. It pulses once as
      it arrives and then holds: a permanently animating dock is a dock people
      learn to look away from.
    */
    .rail-item.waiting:not(.active) {
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
      animation: notice 900ms cubic-bezier(0, 0, 0.2, 1) 1;
    }
    @keyframes notice {
      0% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 var(--accent-soft); }
      60% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 7px transparent; }
      100% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 transparent; }
    }
    .rail-item.active .rail-icon { transform: scale(1.1); }

    .rail-icon { font-size: 19px; line-height: 1; transition: transform 150ms ease; }
    .rail-label {
      font-size: 10px; font-weight: 500; line-height: 1.2;
      text-transform: uppercase; letter-spacing: 0.02em;
      text-align: center; opacity: 0.85;
    }
  `],
})
export class ToolRailComponent {
  protected readonly hosted = hosted;
  protected readonly ui = inject(UiService);
  protected readonly tabs = inject(TabsService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);
  private readonly router = inject(Router);

  /** Lit when the panel is actually on screen, which needs both halves of it. */
  protected readonly documentsUp = computed(() =>
    this.ui.documentsShown() && this.tabs.tabs().length > 0);

  protected home(): void {
    void this.router.navigateByUrl('/');
    // The dock's Home is leaving on purpose: the held project lets go, so an
    // empty workspace shows the library rather than the room just left.
    this.tabs.releaseProject();
    this.tabs.goHome();
  }

  /**
   * Reading the pages is a thing you do to the document in front of you, so
   * opening the dialog from Settings takes you back to the documents first.
   */
  protected convert(): void {
    void this.router.navigateByUrl('/');
    this.ui.openOcr();
  }

  /**
   * THE STEP THIS BOOK IS WAITING ON, lit on the dock.
   *
   * True for a project with no completed reading. Everything else in this app is
   * built on that bank — the block editor, every rendering, the chapter detection
   * — so a book whose pages have not been read is a book where exactly one thing
   * is worth pressing, and the dock says which.
   *
   * THE KIND OF THE FOCUSED TAB IS NO LONGER ASKED, and nothing is lost by it: a
   * project that still needs reading has no book to be looking at, so the test was
   * answering a question the project record had already settled. What it did do
   * was make the light a fact about a PANE rather than about the book, which is
   * the keying docs/WORKBENCH.md §6c retired.
   *
   * From the project RECORD (`ProjectSummary.reading`, derived once by main when
   * the library was listed), never from probing the disk here: this method runs
   * on every repaint of the dock.
   */
  protected ocrWaiting(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null) return false;
    return this.projects.projectFor(tab.path)?.reading.needed === true;
  }

  /**
   * Export needs a PROJECT in front of you, and not a particular file type.
   *
   * IT USED TO BE `kind === 'pdf'`, which was true while the only thing anybody
   * stood on was the scan. It is false now: standing on the reading shows the
   * flowing book, and that document is exactly the one somebody wants an EPUB
   * of. Asking about the KIND of file in the pane was always asking the wrong
   * question — what can be exported is a fact about the project behind the
   * document (docs/DERIVED-BOOK.md §7, "anything that threads 'this is a PDF'
   * through the renderer is building the wrong thing").
   *
   * SO THE TEST IS THE READING, off the project record main derived once when it
   * listed the library — the same signal the OCR light reads, so the dock cannot
   * say "read this" and "export this" about one book at the same time. There is
   * nothing to export before a reading lands: every format this app makes is
   * arithmetic over that bank.
   *
   * ── AND THE RULING HAS A SECOND CASE: A BOOK THAT ARRIVED AS A BOOK ─────────
   *
   * "Nothing to export before a reading lands" was written about a scan, where it
   * is the whole truth, and it dead-bolted this door for every project imported
   * from an EPUB — books that are FINISHED, whose chapters and figures and
   * footnotes are all on the disk already. There is no bank under one and there
   * never will be: its book is exploded out of the archived container rather than
   * read off photographs (`bookAtPosition`, electron/projects.ts), so `done` is
   * false about a book with nothing left to do. The rule is what it always meant —
   * there is nothing to export until the blocks exist — and the blocks arrive by
   * one of two roads. `arrivedAsBook` is the other one, asked of the same project
   * record so that this and the dialog cannot disagree.
   *
   * AND IT STAYS LIVE FOR A DOCUMENT WHOSE PROJECT THIS WINDOW HAS NOT LISTED —
   * the pre-import window, where a dead button explains nothing and the plan
   * call's own refusal names the case precisely (the book nobody has read; the
   * reading that was interrupted). The dialog puts that sentence on screen. A
   * shut door explains itself, which is this rail's rule everywhere else.
   *
   * ── AND IT IS DEAD ON THE IMPORT ROW ────────────────────────────────────────
   *
   * The reading is necessary and is no longer sufficient. Standing on the import
   * is standing BEFORE the reading everything is arithmetic over — the user has
   * deliberately stepped back to the untouched scan — and an export from there
   * would quietly make the book they had just stepped away from
   * (docs/WORKBENCH.md §6c: "Translate on … the import row = disabled. Same rule
   * for Export and Metadata"). The dialog says the same thing in a sentence for
   * whoever arrives by the menu instead of by this button.
   *
   * EXCEPT WHERE THE IMPORT ROW IS THE BOOK. That refusal is about stepping BACK
   * PAST a reading to the untouched scan, and a project that arrived as a book has
   * no such step to step past: its ledger holds the import and nothing else, and
   * `bookAtPosition`'s own EPUB branch reads exactly that position — `reading ===
   * null` beside an EPUB archive — as the instruction to explode the container.
   * The row a scan project is standing BEFORE its book on is the row an EPUB
   * project's book IS, so applying one sentence to both would shut the only
   * position such a project can ever occupy.
   *
   * A HISTORY THIS WINDOW HAS NOT READ ANSWERS NULL, AND NULL IS NOT THE IMPORT.
   * The button stays live and main's own refusal is the backstop, on this rail's
   * standing preference for a door that opens onto an explanation over one that is
   * shut on a guess.
   */
  protected canExport(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return true;
    const arrived = this.projects.arrivedAsBook(project);
    if (!project.reading.done && !arrived) return false;
    return arrived || this.ledger.standingIn(project.dir)?.action !== 'import';
  }

  protected openExport(): void {
    void this.router.navigateByUrl('/');
    this.ui.openExport();
  }

  /**
   * Enabled where the project HAS a book, on the same test the dialog itself
   * applies — which is `canExport`'s test, because the two buttons ask the same
   * question of the same ledger.
   *
   * IT USED TO TEST THE POSITION'S SHOWN DOCUMENT FOR `.epub`, which was the
   * truth while every book was a cast EPUB in a pane and became its opposite at
   * the pivot: a read or edit position is drawn natively on the proof sheet and
   * shows NO document (`documentAtPosition` answers null), so the button was
   * gray exactly where the book is — the user's own report, standing on their
   * applied edits. What a translation consumes now is the POSITION'S book,
   * materialised by main with every op replayed in (`planTranslation`), so the
   * gate is "a book exists here": the reading landed, or the book arrived as
   * one — and not the import row, where the user has deliberately stepped back
   * to the untouched scan, except where the import IS the book.
   *
   * A LOOSE FILE ANSWERS FALSE, unlike Export's benefit of the doubt: what this
   * app translates is a position read off a ledger, and a file with no ledger
   * behind it has none.
   */
  protected canTranslate(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return false;
    const arrived = this.projects.arrivedAsBook(project);
    if (!project.reading.done && !arrived) return false;
    return arrived || this.ledger.standingIn(project.dir)?.action !== 'import';
  }

  protected translate(): void {
    void this.router.navigateByUrl('/');
    this.ui.openTranslate();
  }

  /**
   * The two doors open onto one fact — the project has a book at its position —
   * so this asks the question by asking the button beside it, rather than by
   * keeping a second copy of a test that has already gone stale once.
   */
  protected canSimplify(): boolean {
    return this.canTranslate();
  }

  protected simplify(): void {
    void this.router.navigateByUrl('/');
    this.ui.openSimplify();
  }

  /**
   * A document — either kind. Metadata is the one tool here that a SCAN has as
   * much use for as a book: a PDF's Info dictionary is the same six facts under
   * a different spelling, and a scan whose Title is the filename it was
   * downloaded under is the ordinary case.
   *
   * ── AND IT IS DEAD ON THE IMPORT ROW, WHICH IS THE RULE IT ALREADY CITED ───
   *
   * `canExport` above records the ruling in full — docs/WORKBENCH.md §6c, "Same
   * rule for Export and Metadata" — and this button was the half of it that was
   * never built: it keyed off the focused TAB, so standing on the import (having
   * deliberately stepped back to the untouched scan) still offered a dialog whose
   * Save is refused by main, in a sentence about a folder, one click later.
   * `archive/` is written once and never again, and the honest surface for that is
   * a shut door rather than a form that fills in and then declines.
   *
   * IT IS THE EXPORT SHAPE, LINE FOR LINE, including the reading test: a metadata
   * step is replayed onto what materialisation makes, and in a project with
   * nothing read there is nothing yet to make. A loose file keeps tab keying,
   * having no ledger to key off instead, and a history this window has not read
   * answers null — which is not the import, so the button stays live and main's
   * own refusal is the backstop.
   *
   * ── AND IT IS THE PDF ALONE NOW, WHICH IS A NARROWING WORTH NAMING ─────────
   *
   * The EPUB half of this reached `meta:read-epub`, which resolved an open book's
   * WORKING TREE — and the tree, the reader over it and the tab kind that held it
   * are deleted (docs/RENDERER.md §7). A book's own metadata still belongs in the
   * ledger as a metadata step; what it does not have any more is a door on this
   * dock, because the surface that named the document it would write into is
   * gone. Named here rather than left as a silently dead button.
   */
  protected canEditMetadata(): boolean {
    const tab = this.tabs.activeDocument();
    if (tab === null) return false;
    if (tab.kind !== 'pdf') return false;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return true;
    if (!project.reading.done) return false;
    return this.ledger.standingIn(project.dir)?.action !== 'import';
  }

  protected metadata(): void {
    void this.router.navigateByUrl('/');
    this.ui.openMetadata();
  }
}
