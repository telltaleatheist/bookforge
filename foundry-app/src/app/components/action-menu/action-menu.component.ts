import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { exportNodeId, type HostOperationOffer } from '@shared/host-ops';
/*
 * THE POSSIBILITY PREDICATES, shared with the dialogs that refuse and with the
 * tree that offers — see shared/stages.ts. This menu held the original of three
 * of them and they were copied into two dialogs; they are one function each now,
 * so a button here and a refusal there cannot come to different answers about
 * what a stage can do.
 */
import {
  canExportFrom, canReadPages, canSimplifyFrom, canTranslateFrom, hasEpubExport,
} from '@shared/stages';
import { fold } from '@shared/original';

import { hosted } from '../../core/foundry';
import { HostOpsService } from '../../core/host-ops.service';
import { LedgerService } from '../../core/ledger.service';
import { NoticeService } from '../../core/notice.service';
import { ProjectsService } from '../../core/projects.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';

/**
 * THE ACTION MENU — an ordered list of everything this app can be asked to do,
 * at the foot of the library sidebar.
 *
 * ── It has been in three places, and the third is the user's ────────────────
 *
 * IT BEGAN AS A COLUMN DOWN THE LEFT, 88 pixels wide for the whole session,
 * beside a 220-pixel document list: 308 pixels of chrome before a page of a book
 * began. It moved to a ROW ALONG THE BOTTOM, which gave all of that width back
 * to the pages and cost about 60 pixels of height instead — the iPhone control
 * bar's arrangement, tools in reach and out of the way of the document.
 *
 * OWEN MOVED IT AGAIN (2026-08-17 22:30): *"lets move the nav rail buttons to
 * the left side, pinned to the bottom of the tree sidebar. the tree can be
 * pinned to the top, and if it extends past available space… the user can scroll
 * down to see more of the tree."* The row along the bottom had stopped being
 * free: the library tree it sat beneath had grown twice in a day — exports under
 * their steps, host nodes under the exports — and a full-width dock and a
 * widening sidebar were spending the same screen. Inside the sidebar the buttons
 * cost NO height at all, because the panel was already that tall and that wide.
 *
 * WHAT THE MOVE COST is the centring: the tools used to be balanced on the
 * window's own midline by a three-column grid. In 384 pixels they wrapped into
 * rows instead — and that wrapping lasted a night.
 *
 * ── AND THEN IT STOPPED BEING A RAIL AT ALL ────────────────────────────────
 *
 * Owen, on seeing the wrapped cluster (2026-08-18 01:05): *"instead of
 * clustering the buttons on the bottom left like that, lets make an ordered list
 * of actions for the user. no longer a nav rail, now its an action menu. [icon]
 * [action], one after another."*
 *
 * THAT IS A NAMING RULING AS MUCH AS A LAYOUT ONE, which is why this file is
 * `action-menu.component.ts` and the class is `ActionMenuComponent`. A rail is a
 * strip of modes you flick between; a dock is a shelf of things kept in reach; an
 * ACTION MENU is a list of things you can do, read top to bottom. The last of
 * those is what this has actually been since the tools stopped being modes — the
 * word had simply not caught up with the thing, and this codebase names things
 * what they are.
 *
 * WHAT WRAPPING WAS FOR SURVIVES AS A SMALLER RULE. Rows wrapped because the
 * panel's width had already changed twice and a fixed column count would break
 * on the third; a full-width row cannot break at any width at all, so the same
 * worry is answered by `width: 100%` and an ellipsis instead of by a layout mode.
 *
 * ── THE ORDER, WHICH IS THE POINT OF CALLING IT ORDERED ────────────────────
 *
 * Three groups, divided by rules, and the middle one is the pipeline in the
 * order it runs:
 *
 *   NAVIGATION — Home, Documents. Neither makes anything; they are where you go
 *   and what you look at, so they sit above the rule rather than inside the list
 *   of acts. Putting Home first is unchanged and still right: it is the way back.
 *
 *   THE PIPELINE — Read the pages, Translate, Simplify, Export, Metadata, then
 *   whatever the host contributes. This is the book's own life in sequence: the
 *   pages are read, the words are worked on, the finished thing is filed, and the
 *   audio is made from that. EXPORT MOVED DOWN in this wave — it used to sit
 *   directly after OCR, from the days when reading and generating were two halves
 *   of one button — and it belongs after the acts that change the words, because
 *   exporting before translating is exporting the wrong book. METADATA IS LAST OF
 *   OURS because it is a record ABOUT the book rather than a step in making one;
 *   it is here rather than beside Settings because what it edits is the book's own
 *   claim about itself, which is the book's business and not the app's.
 *
 *   AND SETTINGS, BELOW A RULE OF ITS OWN — unchanged, for the reason it always
 *   had: it is not a tool, it is where you go when the tools are not the answer.
 *
 * ICON BESIDE LABEL, WHICH IS THE RULING SPELLED OUT: *"[icon] [action], one
 * after another."* The words were always there — they used to sit UNDER the glyph
 * in a 76-pixel column, because a horizontal dock had width to spend and no
 * height — and a full-width row has the opposite shape, so they moved to the side
 * of the icon where a list reads them. Icons alone were never an option: this
 * app's acts are not the four everybody already knows, and a glyph for Simplify
 * would teach nobody anything. The one place the labels DO go is `compact` — the
 * sidebar collapsed to a 30-pixel stub — where there is no width to draw a word in
 * and the title attribute is all there is.
 *
 * THE LABELS THEMSELVES ARE UNCHANGED, deliberately. The ruling is about the
 * arrangement and the component's name; renaming "OCR" to "Read the pages" to
 * match the tree's own act would be a second opinion nobody asked for, and the
 * word on this row has been the word for months.
 *
 * HOME IS THE FIRST ITEM and it is not a route: it is "no tab is active", so
 * pressing it puts the documents down without closing them and pressing a tab
 * picks one back up. A Home that closed your tabs would be a Home nobody presses.
 */
@Component({
  selector: 'app-action-menu',
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Reflected onto the host so the compact rules can be written as `:host(...)`
  // — the element the sidebar lays out is this one, so the class belongs on it.
  host: { '[class.compact]': 'compact()' },
  template: `
    <nav class="menu" aria-label="Actions">
      <!--
        NAVIGATION, ABOVE THE RULE. Neither of these makes anything: Home is
        where you go and Documents is what you look at. The rule under them is
        what turns the rest of this into a LIST OF ACTS rather than a pile of
        buttons — see the class docblock for the order and why it is that order.

        THE BRAND WENT WITH THE WRAP. A ⬙ at the top of this block was the
        window's own mark at the left end of a full-width dock; in a panel whose
        head already says LIBRARY it was a second title for one column, and in a
        list of actions it is a row that is not one.
      -->
      <div class="menu-nav">
        <!-- Hosted, the host's book list is the library and Home is the one
             surface that would list the same books from the other side — so the
             door to it goes, not just the page behind it. -->
        @if (!hosted()) {
          <button
            class="menu-item"
            [class.active]="stage.active() === null"
            title="Home"
            (click)="home()"
          >
            <span class="menu-icon">⌂</span>
            <span class="menu-label">Home</span>
          </button>
        }

        <!-- The document list. Disabled with nothing open rather than hidden,
             on this menu's usual principle — and because with nothing open the
             panel is not on screen anyway, so a button that toggled a hidden
             thing would be a button with no visible effect. -->
        <button
          class="menu-item"
          [class.active]="documentsUp()"
          [disabled]="documents.tabs().length === 0"
          title="Show or hide the open documents (Ctrl+B)"
          (click)="ui.toggleDocuments()"
        >
          <span class="menu-icon">☰</span>
          <span class="menu-label">Documents</span>
        </button>
      </div>

      <!-- THE PIPELINE, IN THE ORDER IT RUNS. Read the pages, then the acts
           that change the words, then the finished file, then the record about
           it — and last whatever the host contributes, because audio is made
           from the export the row above produces. -->
      <div class="menu-acts">
        <!--
          THE TWO HALVES OF WHAT USED TO BE ONE BUTTON, side by side and in the
          order they happen. OCR reads the pages and costs hours; Export turns
          what was read into a document you can take away, and costs nothing.
          They were one item called "OCR / Convert" while they were one job, and
          separating them into two rows is most of what teaches the difference.

          OCR LIGHTS UP when the book in front of you has never been read — the
          same accent this menu uses for "this is active", used here for "this is
          the step you are waiting on". It is the one row in this menu that
          points at what to do next rather than at what is currently on.
        -->
        <button
          class="menu-item"
          [class.active]="ui.ocrOpen()"
          [class.waiting]="ocrWaiting()"
          [title]="ocrWaiting()
            ? 'These pages have not been read yet — this is the step everything else needs'
            : 'Read this book\\'s pages with the vision model'"
          (click)="convert()"
        >
          <span class="menu-icon">⌦</span>
          <span class="menu-label">OCR</span>
        </button>

        <!-- Translate. Disabled rather than hidden away from a book, on this
             menu's usual principle: a translation is a thing you do to a book
             Foundry cast, and somebody standing on the scan should be able to
             see that the tool exists and is not applicable from there. -->
        <button
          class="menu-item"
          [class.active]="ui.translateOpen()"
          [disabled]="!canTranslate()"
          title="Translate this book into another language"
          (click)="translate()"
        >
          <span class="menu-icon">⇄</span>
          <span class="menu-label">Translate</span>
        </button>

        <!-- Simplify, beside Translate because it is the same act aimed at the
             same book: the model says every paragraph again, checked block by
             block, landing as a step of its own. What differs is the destination
             — a reader rather than a language — which is why it is a second
             button and not a checkbox inside the first. -->
        <button
          class="menu-item"
          [class.active]="ui.simplifyOpen()"
          [disabled]="!canSimplify()"
          title="Say this book again in its own language: plainer, more natural, or for a learner"
          (click)="simplify()"
        >
          <span class="menu-icon">≈</span>
          <span class="menu-label">Simplify</span>
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
          class="menu-item"
          [class.active]="ui.exportOpen()"
          [disabled]="!canExport()"
          title="Make the finished book: an EPUB, plain text, or the pages reprinted as real type"
          (click)="openExport()"
        >
          <span class="menu-icon">⎘</span>
          <span class="menu-label">Export</span>
        </button>

        <!-- Metadata. Enabled standing on the scan as well as on the book,
             unlike everything else here that needs a book to have been cast: a
             scan has an Info dictionary and correcting it is exactly as useful
             as correcting a package. Which of the two it edits is the
             position's answer, not the pane's. It does NOT rename any file —
             see the dialog for why that is a decision rather than an
             omission. -->
        <button
          class="menu-item"
          [class.active]="ui.metadataOpen()"
          [disabled]="!canEditMetadata()"
          title="The title, author and language this document claims for itself"
          (click)="metadata()"
        >
          <span class="menu-icon">ⓘ</span>
          <span class="menu-label">Metadata</span>
        </button>

        <!--
          ── THREE ACTS ARE NOT IN THIS MENU, AND ALL THREE ARE DELETED NOW ──

          SELECT outlined the blocks of a cast EPUB in an iframe; BLOCKS put the
          same surface over a photograph of the pages; EDIT HTML opened a textarea
          over one chapter of a derived document. Each was withdrawn from the menu
          before its machinery went, on the inspector's own rule — withdraw the
          control the moment the thing it does is withdrawn, rather than leaving it
          on screen to invite a gesture and refuse it — and R6c is where the
          machinery followed (docs/RENDERER.md §7).

          WHAT REPLACED ALL THREE IS THE BOOK. Editing happens on the proof sheet,
          against block ids, recorded as ops in the ledger; the PDF produces the
          facsimile and stops (§0 A1). There is no mode to switch on, which is why
          there is no row here to switch it.
        -->
        <!-- The PDF is an output FORMAT inside a dialog rather than a row
             of its own: this menu names ACTS, and picking between an
             EPUB, plain text and a reprint of the pages is one decision about
             one act, made where the rest of that act is described. -->

        <!--
          ── AND THE HOST'S OWN ACTS, WHEN THERE IS A HOST ────────────────────

          *"Owen wants the dialog in the Foundry window, like translate/simplify
          — and a narrate button on the nav rail besides."* (BookForge →
          Foundry, 2026-08-18.) These sit at the end of the acts because they
          are the end of the pipeline: everything above makes the words, and
          this makes something out of them.

          NOT ONE STRING HERE NAMES AN ACT. The label, the hover and the icon
          all come off the offer the host registered — this app has never
          contained the word "narrate" and does not start now. The amber is the
          menu's existing tint for the host's work, the same one the tree draws
          audio cards in.

          STANDALONE THIS LOOP RUNS ZERO TIMES: no host, no operations,
          \`hostActs()\` is empty, and the menu is exactly this app's own acts. There is no
          \`hosted()\` branch here because there does not need to be one — the
          emptiness is the guard.
        -->
        <!--
          GRAYED WHEN THE STAGE CANNOT RUN IT, exactly like Translate and
          Simplify — Owen's ruling (2026-08-17 21:45): *"if the step the user
          has selected cant run tts then its grayed out."* \`hostReady\` is the
          same predicate the press itself refuses by (\`hasEpubExport\`,
          shared/stages.ts), so the gray and the sentence cannot disagree; the
          title says what would make it light up, because a disabled control
          that keeps its enabled hover is a control that explains nothing.
        -->
        @for (act of hostActs(); track act.id) {
          <button
            class="menu-item audio"
            [class.active]="ui.hostOpOpen()?.operationId === act.id"
            [disabled]="!hostReady()"
            [title]="hostReady()
              ? act.label + ' — handled by the app Foundry is running inside'
              : act.label + ' — export the book first; this act reads the finished EPUB'"
            (click)="runHostAct(act.id)"
          >
            <span class="menu-icon">♪</span>
            <span class="menu-label">{{ act.label }}</span>
          </button>
        }
      </div>

      <div class="menu-foot">
        <a
          class="menu-item"
          routerLink="/settings"
          routerLinkActive="active"
          title="Settings"
        >
          <span class="menu-icon">⚙</span>
          <span class="menu-label">Settings</span>
        </a>
      </div>
    </nav>
  `,
  styles: [`
    /*
      ── A LIST AT THE FOOT OF THE SIDEBAR ───────────────────────────────────

      *"[icon] [action], one after another."* (Owen, 2026-08-18 01:05.) Every
      number below follows from that one sentence, and what it replaced is worth
      recording because it was two layouts in two days: a three-column grid that
      centred the tools on the WINDOW while the dock ran along the bottom, and
      then a wrap that packed them into rows once the dock moved into a
      384-pixel panel.

      FULL-WIDTH ROWS ANSWER THE WRAP'S OWN WORRY BETTER THAN THE WRAP DID. That
      layout existed because the panel's width had already changed twice and a
      fixed column count would break on the third; a row that is
      \`width: 100%\` has no column count to break, and a label that
      outgrows its row ellipses instead of reflowing the block. So the thing the
      wrap was defending is defended by a simpler rule.

      NO HEIGHT TOKEN. \`--rail-h\` existed so the queue shelf's floating pill
      could lift itself over a dock along the bottom edge; there is no dock along
      the bottom edge, so the pill has nothing to clear and this block takes the
      height its rows need.
    */
    .menu {
      flex: 0 0 auto;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      padding: 8px 6px;
    }

    /*
      THREE GROUPS, TWO RULES. Navigation, then the pipeline, then Settings —
      the class docblock carries the order and its reasons. The rules are what
      make this an ORDERED list rather than eight buttons in a column: without
      them the eye reads one run of equals and the sequence says nothing.
    */
    .menu-nav, .menu-acts, .menu-foot {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .menu-acts {
      border-top: 1px solid var(--border-subtle);
      padding-top: 6px;
    }
    /* Settings keeps the divider it has always had, for the reason it has always
       had it: it is not a tool, it is where you go when the tools are not the
       answer. */
    .menu-foot {
      border-top: 1px solid var(--border-subtle);
      padding-top: 6px;
    }

    /*
      THE ROW. Icon then words, left to right, the whole width of the panel —
      which is the ruling drawn. It was a 76-pixel COLUMN (glyph above label,
      centred) for as long as this lived in a horizontal dock, where width was
      the scarce thing and height was free; a vertical list has that the other
      way round, so the label moved to the side of the icon where a list reads
      it and the row took the width it was being given anyway.
    */
    .menu-item {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 7px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius);
      color: var(--text-secondary);
      cursor: pointer;
      text-align: left;
      text-decoration: none;
      transition: background-color 150ms ease, color 150ms ease;
    }

    /*
      THE HOST'S OWN COLOUR, the same amber the tree tints audio cards with, so
      that an act belonging to another application reads as one at a glance
      wherever it appears. Only the icon takes it: a whole row in the host's
      colour would compete with the accent this menu uses for "active".
    */
    .menu-item.audio .menu-icon { color: var(--audio); }

    /*
      ── COMPACT: THE MENU AT THIRTY PIXELS ───────────────────────────────────

      The panel collapses to a stub and the acts go with it rather than
      disappearing — putting the library away must not put Settings away. What
      fits in 30 pixels is the icon and nothing else, so the labels go and the
      rows narrow to the glyph. THE STUB WAS ALREADY AN ACTION MENU: one icon
      per row, one after another, which is the ruling at a width that cannot
      hold the words. The title attribute is on every row (it always was), so
      they are one hover away — the same trade the panel's own collapse makes.
    */
    :host(.compact) .menu { padding: 6px 2px; gap: 4px; }
    :host(.compact) .menu-nav,
    :host(.compact) .menu-acts,
    :host(.compact) .menu-foot { align-items: center; }
    :host(.compact) .menu-acts,
    :host(.compact) .menu-foot { padding-top: 4px; }
    :host(.compact) .menu-item { width: 26px; padding: 5px 0; justify-content: center; gap: 0; }
    :host(.compact) .menu-label { display: none; }
    .menu-item:hover { background: var(--bg-hover); color: var(--text-primary); }
    .menu-item:disabled { opacity: 0.35; cursor: default; }
    .menu-item:disabled:hover { background: transparent; color: var(--text-secondary); }
    .menu-item.active {
      background: var(--accent-soft);
      color: var(--accent);
    }

    /*
      WAITING, which is not the same as ACTIVE and must not look identical.
      Active means "this panel is open right now"; waiting means "this is the
      step your book needs next". The SAME accent — this app has one word for
      attention, and inventing a second colour for a second kind of it is how a
      palette stops meaning anything — but drawn as an outline rather than a
      fill, so a menu showing both still says which is which. It pulses once as
      it arrives and then holds: a permanently animating menu is a menu people
      learn to look away from.
    */
    .menu-item.waiting:not(.active) {
      color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
      animation: notice 900ms cubic-bezier(0, 0, 0.2, 1) 1;
    }
    @keyframes notice {
      0% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 var(--accent-soft); }
      60% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 7px transparent; }
      100% { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 0 transparent; }
    }
    .menu-item.active .menu-icon { transform: scale(1.1); }

    /* A fixed box so every label in the list starts at the same x — a column of
       words that stepped left and right with the glyph widths would read as a
       ragged list rather than an ordered one. */
    .menu-icon {
      flex: 0 0 20px;
      text-align: center;
      font-size: 18px; line-height: 1;
      transition: transform 150ms ease;
    }
    /*
      THE ACTION'S NAME, IN WORDS AND IN SENTENCE CASE. It was 10px uppercase and
      centred under a glyph, which is what a label does when it is a caption; in a
      row it is the thing being read, so it takes the size and the alignment of
      something being read. It ellipses rather than wrapping: a two-line row in a
      list of one-line rows breaks the rhythm that makes the order legible.
    */
    .menu-label {
      flex: 1; min-width: 0;
      font-size: 12px; font-weight: 500; line-height: 1.3;
      letter-spacing: 0.01em;
      text-align: left;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `],
})
export class ActionMenuComponent {
  /**
   * DRAWN AT THE WIDTH OF A STUB — icons alone, one column.
   *
   * Set by the sidebar when the library is collapsed. It is an input rather than
   * this component reading `UiService.documentsShown` for itself, because what it
   * describes is the SPACE THIS COMPONENT HAS BEEN GIVEN and not a fact about the
   * app: the day something else hosts this menu in a narrow place, it says so the
   * same way rather than teaching this class a second thing to check.
   */
  readonly compact = input(false);

  protected readonly hosted = hosted;
  protected readonly ui = inject(UiService);
  protected readonly documents = inject(OpenDocumentsService);
  protected readonly stage = inject(StageService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);
  private readonly hostOps = inject(HostOpsService);
  private readonly notices = inject(NoticeService);
  private readonly router = inject(Router);

  /** Lit when the panel is actually on screen, which needs both halves of it. */
  protected readonly documentsUp = computed(() =>
    this.ui.documentsShown() && this.documents.tabs().length > 0);

  /**
   * THE HOST'S ACTS THAT BELONG ON THE DOCK — the ones with a form, that
   * consume the book.
   *
   * ── Two filters, and each earns its place ───────────────────────────────────
   *
   * `appliesTo: 'book'` because the menu aims at THE BOOK IN FRONT OF YOU, and
   * that is the only currency this menu can name — an act consuming AUDIO is about
   * a particular narration, which is a row in the tree and not a thing this menu
   * has a way to point at. `offeredFrom` is the same function the tree's footer
   * asks, so the two surfaces cannot come to different answers about what may be
   * offered from a book.
   *
   * A `form` because an act WITHOUT one runs the instant it is pressed, and a
   * menu row that started an hours-long job on a single click — with no
   * dialog, no confirmation and no statement of what it would run against —
   * is the one gesture in this menu that could not be taken back. The tree's
   * footer is where a formless act is pressed, beside the row it names.
   *
   * EMPTY STANDALONE, which is the whole of the guard: nobody registered
   * anything, so this is `[]` and the loop that draws it runs zero times.
   */
  protected readonly hostActs = computed(() => {
    if (this.target() === null) return NO_ACTS;
    /*
     * BOTH SPELLINGS OF "ACTS ON THE FINISHED BOOK" REACH THE DOCK, and that is
     * not a hedge — it is what this button already aims at. The menu resolves its
     * target to the project's EXPORT (per 9a/9b: the export's own step where the
     * catalogue recorded one), so an act declaring `export` is precisely on
     * subject here, and an act still declaring `book` — which is every host that
     * has not re-vendored since the member was added — must keep reaching the
     * button it reached yesterday. The tree is where the two spellings genuinely
     * separate, because there a `book` op belongs on the steps and an `export` op
     * belongs on the `final/` rows.
     */
    return [...this.hostOps.offersFor('book'), ...this.hostOps.offersFor('export')]
      .filter((offer) => offer.form !== undefined);
  });

  /**
   * WHAT A MENU ACT WOULD RUN AGAINST — the book's export target, per 9a/9b.
   *
   * ── The same rule the export row follows, reached from the menu ────────────
   *
   * The tree's export row knows its own provenance (`ProjectFinal.stepId`); the
   * menu has no row in hand, so it works out which export the book has. ONE
   * EXPORT IS THE ANSWER — its recorded step where there is one, and the position
   * as the documented fallback, exactly as `nodeIdFor` resolves it in the tree.
   *
   * TWO OR MORE AND THE MENU REFUSES rather than choosing. *"Today
   * narrate-from-any-node resolves to 'the project's one exported EPUB' and
   * refuses when there are two."* That refusal is the letter's own description of
   * today's behaviour and it is the right one here: a book exported at three
   * positions has three candidates and this menu cannot know which the person
   * means — the tree can, because they clicked a row. The sentence says so and
   * says where to go instead.
   *
   * NULL MEANS THE BUTTON IS NOT DRAWN AT ALL, which is only the case with no
   * book in front of you. A book with no EPUB export yet draws the button
   * GRAYED — that is Owen's ruling (2026-08-17 21:45) REVERSING what this
   * paragraph used to promise ("still draws the button and refuses in a
   * sentence on the press"): present and disabled like Translate and Simplify,
   * with the title carrying "export it first" so the way to light it up is
   * still said where the button is. See `hostReady`.
   */
  private readonly target = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    return this.documents.projectDirOf(tab);
  });

  /**
   * WHETHER THE HOST'S ACTS HAVE A FILE TO CONSUME — this menu's gray.
   *
   * `hasEpubExport` (shared/stages.ts) is the same predicate `runHostAct`
   * refuses by, which is that module's whole rule: the gray and the sentence
   * cannot come to different answers. The finer refusals — two candidate
   * exports, settings a host misses — stay at press time and with the host,
   * because a catalogue row cannot know them.
   */
  protected readonly hostReady = computed<boolean>(() => {
    const dir = this.target();
    if (dir === null) return false;
    const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    return hasEpubExport(project);
  });

  /**
   * Press one: work out the target, then open the host's questions in our card.
   *
   * EVERY REFUSAL IS A SENTENCE ON THE STRIP, which is this menu's own habit for
   * a button that cannot grey itself out against a fact this deep in the model.
   */
  protected runHostAct(operationId: string): void {
    const dir = this.target();
    if (dir === null) return;
    const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    /*
     * THE EPUBS, not the whole tray: what these acts consume is the finished
     * BOOK file, and counting a plain-text export here would refuse for
     * ambiguity between two files only one of which the act can read — or,
     * worse, aim the nodeId at the text file's own provenance. The same kind
     * test the row's `produces` and this menu's gray both make, made a third
     * time where the target is picked.
     */
    const exports = (project?.exports ?? []).filter((made) => made.kind === 'epub');
    if (exports.length === 0) {
      // Unreachable from the button now that it grays (`hostReady` is this
      // same predicate) — kept because a sentence behind a gate costs nothing
      // and a silent return behind a stale repaint would cost an evening.
      this.notices.notice.set(
        'There is nothing finished to work from yet — export this book first, and the act will '
        + 'have a file to consume.',
      );
      return;
    }
    if (exports.length > 1) {
      this.notices.notice.set(
        'This book has more than one finished export, so which one this should work from is not '
        + 'obvious from here. Pick the one you mean in the library tree and start it from there.',
      );
      return;
    }
    /*
     * ONE EXPORT, AND THE PRESS NAMES THAT EXPORT — the same id the tree's own
     * press on the same file would send (`exportNodeId`, shared/host-ops.ts).
     *
     * IT USED TO SEND THE EXPORT'S PROVENANCE STEP, falling back to the standing
     * one, and both are wrong for the same reason Owen's third ruling gives: the
     * host echoes this id into every node it pushes back, so a menu press that
     * named a STEP put the narration under that step in the tree while a tree
     * press on the very same file put it under the file. Two doors onto one act
     * that disagreed about where the result belongs is the shape this codebase
     * refuses everywhere else; this menu aims at the export, so it says the
     * export.
     *
     * NO FALLBACK IS NEEDED ANY MORE. The old one existed because a
     * pre-`stepId` catalogue had no provenance to send; the file's own name is
     * always available, so the one branch that could answer null is gone.
     */
    const target = exports[0];
    if (target === undefined) return;
    const nodeId = exportNodeId(target.file);
    void this.router.navigateByUrl('/');
    this.ui.openHostOp({ operationId, projectDir: dir, nodeId });
  }

  protected home(): void {
    void this.router.navigateByUrl('/');
    // This menu's Home is leaving on purpose: the held project lets go, so an
    // empty workspace shows the library rather than the room just left.
    this.stage.releaseProject();
    this.stage.goHome();
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
   * THE STEP THIS BOOK IS WAITING ON, lit in the menu.
   *
   * True for a project with no completed reading. Everything else in this app is
   * built on that bank — the block editor, every rendering, the chapter detection
   * — so a book whose pages have not been read is a book where exactly one thing
   * is worth pressing, and this menu says which.
   *
   * THE KIND OF THE FOCUSED TAB IS NO LONGER ASKED, and nothing is lost by it: a
   * project that still needs reading has no book to be looking at, so the test was
   * answering a question the project record had already settled. What it did do
   * was make the light a fact about a PANE rather than about the book, which is
   * the keying docs/WORKBENCH.md §6c retired.
   *
   * From the project RECORD (`ProjectSummary.reading`, derived once by main when
   * the library was listed), never from probing the disk here: this method runs
   * on every repaint of the menu.
   */
  protected ocrWaiting(): boolean {
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    return canReadPages(this.projects.projectFor(tab.path));
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
   * listed the library — the same signal the OCR light reads, so this menu cannot
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
   * shut door explains itself, which is this menu's rule everywhere else.
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
   * The button stays live and main's own refusal is the backstop, on this menu's
   * standing preference for a door that opens onto an explanation over one that is
   * shut on a guess.
   */
  protected canExport(): boolean {
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    return canExportFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
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
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    return canTranslateFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
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
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    return canSimplifyFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
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
   * menu, because the surface that named the document it would write into is
   * gone. Named here rather than left as a silently dead button.
   */
  protected canEditMetadata(): boolean {
    const tab = this.stage.activeDocument();
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

/**
 * ONE empty array for a menu with no host behind it — a fresh `[]` per call
 * would be a new identity on every repaint, and this is read inside a computed.
 */
const NO_ACTS: readonly HostOperationOffer[] = [];
