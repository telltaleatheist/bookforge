import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { pdfCategoryLabel } from '@shared/categories';
import type { Replayed } from '@shared/ops';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';

/**
 * The inspector — what the focused book IS, down the right-hand side.
 *
 * Final Cut Pro's inspector is the reference and the shape is deliberate: a
 * column of accordion sections, all open by default, each scrolling INSIDE
 * ITSELF. One long scroll for the whole panel would mean a book with sixty
 * chapters pushes the category rows off the bottom of the screen, and the
 * category rows are the half a curator uses every few seconds.
 *
 * IT IS IN THE SHELL AND NOT IN THE PANE, which is the change that pays for
 * itself. The chapter list used to be a 260px column inside each book's own
 * viewer, so five open books were five copies of the same furniture eating 1300
 * pixels of a window whose whole job is showing pages. There is one of it now and it
 * follows the FOCUSED document — the same thing the rail, Ctrl+S and the menu
 * mean by "what I am working on" (`StageService.activeDocument`).
 *
 * ── WHAT IT KNOWS, WHICH IS ONE PANE'S OWN REPLAY ────────────────────────────
 *
 * The book pane registers itself with the service as a `BookStack`, and every row
 * drawn here is read out of that pane's replay while every button pushes an op
 * onto that pane's stack. This component holds no copy of the book, no list of
 * ops and no idea where any of it is kept — which is what lets the panels live in
 * the shell (RENDERER-DESIGN.md §5) while undo, redo and Apply go on meaning one
 * thing.
 *
 * IT USED TO ASK AN IFRAME. The rendered chapter was a sandboxed frame with an
 * opaque origin, so everything about the page arrived as posted messages and
 * everything done to it went back the same way. That whole channel is deleted
 * (docs/RENDERER.md §7), and with it this panel's Category section, its Contents
 * section and its word-correction box: the surfaces those addressed are gone, and
 * what is left is the three panels the proof sheet owns.
 */
@Component({
  selector: 'app-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (projectDir() !== null || sheet() !== null) {
      <div class="panel">
        <!-- ── Standing on ──────────────────────────────────────────────── -->
        <!--
          THE RUNNING ORDER IS FIXED AND THIS IS THE TOP OF IT: the standing
          strip, then the book's divisions, then Notes, then Furniture review.
          Sections that have nothing to say are still absent; what is fixed is
          that a section never overtakes another one.

          THE PANEL IS FURNITURE AND FURNITURE DOES NOT WALK. Almost everything
          here is conditional, and when the order was "whatever the guards happen
          to admit" the same section sat in a different place depending on what
          was focused and whether a block was picked — so every glance began by
          re-finding it. Keep new sections BELOW these.

          ── STEPS USED TO BE THIS SLOT, AND IT HAS LEFT THE PANEL ─────────────

          It was an accordion of every step in the project, first in the running
          order for the reasons above: the most nearly always-present thing here,
          and the only one belonging to the BOOK rather than to whatever pane was
          in front. That is exactly why it had to go. Two selectors were
          pretending to be one — the left panel picked a file, this section
          picked a position — and the user found the seam: *"i could have a
          document open, the epub, but have the pdf import step selected, and id
          never know that i just ran translate against the original pdf rather
          than the generated epub."* The steps are the LIBRARY now, drawn as the
          tree they always were, one selector on the left
          (docs/WORKBENCH.md §6c; open-documents.component.ts holds the whole of
          the reasoning and the rows).

          WHAT STAYED IS WHAT WAS NEVER A SELECTOR: the one line saying where
          this book is standing. This side is the inspector in the Final Cut
          sense — details and actions for the selected thing, never a competing
          selection.

          A STRIP AND NOT AN ACCORDION, because there is one line in it. An
          accordion header over a single row would be furniture wrapped around
          furniture, and it must not take a share of the panel's height the way
          \`.accordion\` does — the sections below it need every pixel.
        -->
        @if (projectDir() !== null) {
          <section class="standing">
            <div class="strip">
              <span class="label">Standing on</span>
              <span class="name" [title]="standingTitle()">{{ standingName() }}</span>
            </div>

            <!-- Main's own sentence about a ledger it would not read. It used to
                 be drawn where the step rows were; with the rows gone this is
                 where it lands, because "nowhere" with no account of why would
                 be the panel refusing to say what it knows. -->
            @if (stepsProblem(); as reason) {
              <p class="applying">{{ reason }}</p>
            }

            <!--
              APPLY IS NOT ON THIS STRIP. It was, while the block editor's live
              curation was a thing to freeze — a button here, a sentence under it
              counting the blocks no save held. There is one editing surface now
              (docs/RENDERER.md §7) and its Apply is on the paper, beside the
              changes it applies, where the count is the stack's own.
            -->
          </section>
        }

        <!--
          ── THE PROOF SHEET'S THREE PANELS ──────────────────────────────────

          Chapters, Notes and Furniture review, drawn for a book pane and for
          nothing else (RENDERER-DESIGN.md §5: the panels live in the app shell
          and keep its dark style — the paper vocabulary stays on the paper). They
          are sections of THIS panel rather than chrome of their own, in the
          accordion this panel has always used.

          THE RUNNING ORDER IS THE PANEL'S: divisions first, then the two that
          are new.

          EVERY ROW IS READ OUT OF THE PANE'S OWN REPLAY and every button pushes
          onto the viewer's own stack (\`BookStack\`, core/book-stacks.service.ts). This
          component holds no copy of the book, no list of ops and no idea where
          any of it is kept: undo, redo and Apply take a decision made here back
          exactly as they take one made on the paper, because there is one stack.
        -->
        @if (sheet(); as pane) {
          <section class="accordion" [class.shut]="!chaptersOpen()">
            <button class="head" (click)="chaptersOpen.set(!chaptersOpen())">
              <span class="twist">{{ chaptersOpen() ? '▾' : '▸' }}</span>
              <span class="label">Chapters</span>
              <!--
                THE COUNT IS DIVISIONS AND ONLY DIVISIONS. The header says
                Chapters, so the number beside it answers "how many does this
                book divide into" — the headings listed below are the shape
                INSIDE those, and adding them in would make a count of two
                different things that agrees with neither.
              -->
              <span class="count">{{ sheetChapters().length }}</span>
            </button>
            @if (chaptersOpen()) {
              <div class="body">
                <!--
                  WHOSE LIST THIS IS, said before anything is clicked — the same
                  sentence the scan's section says, because it is the same rule:
                  the first chapter op takes the list over and "Use Foundry's" is
                  the op that hands it back. It is a fact about the chain,
                  recomputed every replay, so it cannot drift.

                  IT NAMES THE DOT because the list below it stopped being one
                  kind of row. "These are your chapters" over an outline that
                  also holds headings would be a caption misidentifying half of
                  what is under it; naming the mark makes the sentence point at
                  the rows it is actually about, and pays for the dot at the same
                  time by saying once what it means. BLUE-dotted, in full: the
                  paper's chapter rule is the green DOTTED line, so "the dotted
                  rows" alone would name the panel's mark in the instrument's
                  own word.
                -->
                <p class="hint">
                  @if (pane.chaptersOwned()) {
                    The blue-dotted rows are your chapters. The book divides here and nowhere else.
                  } @else {
                    The blue-dotted rows are the chapters Foundry found. Change any of them and
                    the list becomes yours — from then on the book divides exactly where it says.
                  }
                </p>
                <ul>
                  <!--
                    THE SENTENCE COMES FIRST WHEN THERE ARE NO DIVISIONS, not
                    last. It used to be the list's empty state and could sit at
                    the bottom because nothing else was ever in the list; now a
                    book with headings and no divisions has rows, and "this book
                    does not divide" printed UNDER them would read as a caption
                    on the rows above it and contradict them. Above, it is what
                    it has always been: the answer about DIVISIONS, with the
                    headings that are not divisions indented below it.
                  -->
                  @if (sheetChapters().length === 0) {
                    <li class="none">This book does not divide: it reads as one run of prose.</li>
                  }
                  @for (row of sheetOutline(); track row.id) {
                    <li class="entry" [class.division]="row.kind === 'chapter'"
                        [class.section]="row.kind === 'section'">
                      @if (renamingHref() === row.id && row.kind === 'chapter') {
                        <input
                          #renameBox
                          class="rename"
                          [value]="renameText()"
                          (input)="renameText.set(renameBox.value)"
                          (keydown.enter)="commitSheetRename(row.id)"
                          (keydown.escape)="cancelRename()"
                          (blur)="cancelRename()"
                          [attr.aria-label]="'Rename ' + row.title"
                        >
                      } @else if (row.kind === 'chapter') {
                        <button
                          class="chapter"
                          [title]="row.title"
                          (click)="pane.reveal(row.id)"
                          (dblclick)="startSheetRename(row)"
                        >
                          <span class="ch-title">{{ row.title }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </button>
                        <button class="pencil" title="Rename" (click)="startSheetRename(row)">✎</button>
                        <button
                          class="pencil"
                          title="Take the division away — the block stays, the rule goes"
                          (click)="dropSheetChapter(row.id)"
                        >✕</button>
                      } @else {
                        <!--
                          A HEADING ROW GOES TO THE HEADING AND DOES NOTHING
                          ELSE. No pencil and no ✕, because neither op exists
                          here: renaming a heading is editing the words of a
                          block, and taking one away is striking that block —
                          both of them things done to the paper, on the paper,
                          where the words are. This section pushes the
                          DIVISIONS' ops and no others, so the only gesture a
                          heading row can honestly offer is "show me".
                        -->
                        <button
                          class="chapter"
                          [title]="row.title"
                          (click)="pane.reveal(row.id)"
                        >
                          <span class="ch-title">{{ row.title }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </button>
                      }
                    </li>
                  }
                </ul>
                <div class="acts">
                  <!--
                    "HERE" IS THE BLOCK PICKED ON THE PAPER, which is the one thing
                    the panel cannot say for itself and the one thing it reads off
                    the pane. Setting a division is the panel's gesture for that
                    reason: the chip on the sheet renames what is already there,
                    and creating one needs a block somebody has pointed at.
                  -->
                  <button
                    class="act"
                    [disabled]="!canDivide()"
                    [title]="divideTitle()"
                    (click)="makeSheetChapter()"
                  >Chapter starts here</button>
                  <button
                    class="act"
                    [disabled]="!pane.chaptersOwned()"
                    title="Throw this list away and let Foundry work the chapters out again"
                    (click)="resetSheetChapters()"
                  >Use Foundry's</button>
                </div>
              </div>
            }
          </section>

          <!--
            ── Notes — every note, and both directions of the one flag ─────────

            The apparatus, listed in reading order, with the two LINKING flags the
            app still keeps (docs/RENDERER.md §0, ruling 7): a number in the body
            that no note carries, and a note nothing in the body points at. The
            first of those is the only list in this panel that is not a list of
            rows — a loose marker is characters inside a block — and it sits at the
            top because it is the half a person has to act on.

            LINKING IS TWO CLICKS AND NO DRAG. Click the number, then click the
            note it belongs to; the second click is the op. A drag between two
            lists in a 260px column is a gesture that needs autoscroll to reach
            most of its targets, and this needs none.
          -->
          <section class="accordion" [class.shut]="!notesOpen()">
            <button class="head" (click)="notesOpen.set(!notesOpen())">
              <span class="twist">{{ notesOpen() ? '▾' : '▸' }}</span>
              <span class="label">Notes</span>
              <span class="count">{{ notes().length }}</span>
              <!--
                THE FLAG COUNT IS ITS OWN BADGE and it is only there when it is
                nonzero — §5's *"Flag counts in --ink-flag when nonzero"*, read as
                a count OF flags rather than as the notes count wearing a colour.
                Both directions are in it, because they are one flag seen from
                either end and a person opening the section finds them separated.
              -->
              @if (unlinked(); as flagged) {
                <span
                  class="count flagged"
                  title="Reference numbers with no note, and notes nothing points at"
                >{{ flagged }} unlinked</span>
              }
            </button>
            @if (notesOpen()) {
              <div class="body">
                <p class="hint">
                  @if (linkingRow() !== null) {
                    Now click the note this number belongs to. Click the number again to
                    leave it unbound.
                  } @else if (looseMarkers().length > 0) {
                    The numbers above carry nothing yet. Click one, then click its note.
                  } @else {
                    Every note in the book, in reading order. Click one to go to it.
                  }
                </p>
                @if (looseMarkers().length > 0) {
                  <ul>
                    @for (row of looseMarkers(); track row.key) {
                      <li class="entry flagged">
                        <button
                          class="chapter"
                          [class.active]="linking() === row.key"
                          [title]="'No note carries this number, printed in ' + row.words"
                          (click)="startLink(row)"
                        >
                          <span class="ord flag">{{ row.printed }}</span>
                          <span class="ch-title">{{ row.words }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                }
                <ul>
                  @for (row of notes(); track row.id) {
                    <li class="entry" [class.flagged]="row.orphan">
                      <button
                        class="chapter"
                        [title]="row.orphan
                          ? 'Nothing in the book carries this note'
                          : row.words"
                        (click)="tapNote(row)"
                      >
                        <span class="ord" [class.flag]="row.orphan">{{ row.ordinal }}</span>
                        <span class="ch-title">{{ row.words }}</span>
                        <span class="ch-at">≈ {{ row.page }}</span>
                      </button>
                    </li>
                  }
                  @if (notes().length === 0) {
                    <li class="none">Nothing at the foot of a page in this book.</li>
                  }
                </ul>
              </div>
            }
          </section>

          <!--
            ── Furniture review — the shelf, made visible ──────────────────────

            *"nothing the model answered is silently gone"* (docs/BOOK-FILE.md §5).
            The reflow takes running heads, folios and page furniture out of the
            flow and keeps them as rows at their reading-order positions wearing a
            sentence of evidence; until now that sentence was a log line nobody
            could act on. Each of them is a row here with its own why under it and
            one verb beside it, and restoring one puts it back exactly where it was
            printed — the position is not a guess, which is why the op has none to
            make.
          -->
          <section class="accordion" [class.shut]="!furnitureOpen()">
            <button class="head" (click)="furnitureOpen.set(!furnitureOpen())">
              <span class="twist">{{ furnitureOpen() ? '▾' : '▸' }}</span>
              <span class="label">Furniture</span>
              <span class="count">{{ furniture().length }}</span>
            </button>
            @if (furnitureOpen()) {
              <div class="body">
                <p class="hint">
                  What the reflow took out of the book — running heads and the page's own
                  furniture. Nothing is lost: restore one and it goes back where it was
                  printed.
                </p>
                <ul>
                  @for (row of furniture(); track row.id) {
                    <li class="entry shelved">
                      <div class="shelf">
                        <div class="shelf-line">
                          <span class="ord">{{ row.label }}</span>
                          <span class="ch-title">{{ row.words }}</span>
                          <span class="ch-at">≈ {{ row.page }}</span>
                        </div>
                        <p class="shelf-why">{{ row.why }}</p>
                      </div>
                      <button
                        class="pencil"
                        title="Put this row back in the book"
                        (click)="restoreShelved(row.id)"
                      >↺</button>
                    </li>
                  }
                  @if (furniture().length === 0) {
                    <li class="none">The reflow took nothing out of this book.</li>
                  }
                </ul>
              </div>
            }
          </section>
        }

        <!--
          EVERYTHING THIS PANEL SAYS ABOUT THE DOCUMENT, which needs one. The
          sections below are about a book that is open and readable or a scan
          being corrected; the standing strip, above, is about the BOOK, and a
          scan that has never been in block view has one of those and none of
          these. Which is the whole reason the strip sits outside this block
          rather than inside it — it must hold the top of the panel in states
          where nothing down here draws at all. The block closes at the brace
          marked "end of the document's sections", which is the last thing in the
          panel.
        -->
        <!--
          THERE IS NO CONTEXT MENU IN THIS PANEL ANY MORE. It held one item —
          "Open in split" on a step row — which was the second half of the user's
          rule about opening steps: *"they can right-click a different step and
          click open, and itll split the screens between the one they just opened
          and the one they already had open."* Step rows live in the library now,
          and so does the menu, beside "Delete this step…" which used to be a ✕ on
          the row (docs/WORKBENCH.md §6c). One context-menu idiom in this app, and
          it is drawn where the rows it is about are.
        -->
      </div>
    }
  `,
  styles: [`
    /*
      THE ONE PAPER TOKEN THE SHELL BORROWS. RENDERER-DESIGN.md §5 keeps the
      panels in the app's dark style and asks for exactly one thing from the
      sheet's palette: *"Flag counts in --ink-flag when nonzero."* It is copied
      from §1 verbatim rather than approximated with the app's warning colour,
      because the amber a person learns in the book's right-hand gutter and the
      amber on the Notes count are one statement — something here needs a
      decision — and two ambers would be two statements.
    */
    :host {
      --ink-flag: #b98a1c;

      /*
        THE DIVISION MARK, AND IT IS DELIBERATELY OUTSIDE THE PAPER'S PALETTE.
        The sheet already owns a green for structure (\`--ink-chapter\`, spruce)
        and it is the INSTRUMENT's ink: it draws the rule across the page and
        the chip that sets it, on the surface where a chapter is made. This dot
        is panel chrome answering a different question — which of these rows are
        divisions and which are headings inside them — and wearing the paper's
        green for it would have the two surfaces claiming each other's
        vocabulary, so that a person who learned green-means-a-division-is-being-
        set on the page reads it here as a thing they could act on.

        BLUE, AND NOT THE SHEET'S BLUE EITHER. The paper has an archival blue
        (\`--ink-select\`, #3b6ea5) and it means SELECTED there; the app's own
        palette (styles.scss) has no blue at all — its accent is cyan, which is
        this window's word for "active". So this is a literal, stated once,
        chosen to sit quietly on the dark panel: steel, legible at six pixels,
        and claimed by nothing else in either vocabulary.
      */
      --mark-division: #5a83b0;

      display: block;
      width: 260px;
      min-width: 260px;
      height: 100%;
    }

    /* The documents panel's surface, mirrored: the two side panels are siblings
       and the window should read as one frame around the pages, not as three
       materials meeting. */
    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-elevated);
      border-left: 1px solid var(--border-default);
    }

    /*
      THE SECTIONS SHARE THE HEIGHT AND EACH SCROLLS ITSELF. \`flex: 1 1 0\` with
      \`min-height: 0\` is what makes that true — without the minimum a flex item
      refuses to shrink below its content and the last section's rows fall off
      the bottom of the panel with no scrollbar anywhere. A shut section takes
      only its header row.
    */
    .accordion {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border-subtle);
    }
    .accordion.shut { flex: 0 0 auto; }

    .head {
      display: flex; align-items: baseline; gap: 8px;
      width: 100%;
      padding: 10px 12px 8px;
      background: transparent; border: none;
      text-align: left; cursor: pointer;
    }
    .head:hover { background: var(--bg-hover); }
    .twist { color: var(--text-tertiary); font-size: 9px; }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 6px; }

    .about { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 8px; }
    .book-title {
      font-family: var(--font-display); font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .book-author { font-size: 11px; color: var(--text-tertiary); }

    ul { list-style: none; margin: 0; padding: 0; }

    .entry { display: flex; align-items: center; }
    .pencil {
      flex-shrink: 0;
      visibility: hidden;
      margin-right: 6px;
      padding: 2px 5px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 11px; cursor: pointer;
    }
    .entry:hover .pencil { visibility: visible; }
    .pencil:hover { color: var(--text-primary); background: var(--bg-hover); }
    .rename {
      flex: 1;
      min-width: 0;
      margin: 2px 8px 2px 0;
      padding: 4px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--accent);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .rename:focus { outline: none; box-shadow: var(--focus-ring); }

    .chapter {
      display: block;
      flex: 1;
      min-width: 0;
      margin: 0 6px;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chapter:hover { background: var(--bg-hover); color: var(--text-primary); }
    .chapter.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 500;
    }

    /*
      THE SPACE IS RESERVED, so the rows under a hint never move.

      Every one of these paragraphs says a DIFFERENT SENTENCE depending on the
      state it is about — "4:2 is selected" against the three-line legend of the
      colours, "these are your chapters" against the longer sentence about
      chapters Foundry only proposed. The sentences are different lengths, so
      left to size themselves they grew and shrank as the user clicked and the
      whole list slid up and down underneath: the panel rearranging itself in
      answer to a click on the book, which is the one thing this column must
      never do.

      FOUR LINES, sized to the LONGEST sentence in the panel — the unconfirmed
      chapters one — rather than to each section's own, because one height for
      every hint is a rule that holds when somebody adds a section, and a
      per-section height is a measurement that rots the first time a sentence is
      reworded. The cost is some quiet space under the short ones, which is what
      buying a still panel costs. A sentence longer than this will start the
      movement again: measure before you write one.
    */
    .hint {
      margin: 0 0 6px;
      padding: 0 12px;
      min-height: calc(4 * 1.4em);
      box-sizing: content-box;
      font-size: 11px; line-height: 1.4;
      color: var(--text-tertiary);
    }

    /* ── The chapter rows ──────────────────────────────────────────────── */

    /* A chapter row is two lines of unequal weight: the name somebody will read
       in the contents, and the page it opens on, which is only ever a check. */
    .chapter { display: flex; align-items: baseline; gap: 6px; }
    .ch-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ch-at {
      flex: 0 0 auto;
      color: var(--text-tertiary); font-size: 10px;
      font-variant-numeric: tabular-nums;
    }

    /*
      A CHAPTER WHOSE BLOCK IS NOT IN THIS RENDERING. The engine skips it rather
      than refusing the run — a page taken out with --skip-pages, or a block
      struck since — so the app must not refuse it either. It is DRAWN AND
      DIMMED: a row that vanished would take somebody's chapter name with it, and
      a row that looked ordinary would promise a division the book will not have.
    */
    .entry.missing .ch-title { text-decoration: line-through; }
    .entry.missing { opacity: 0.5; }

    /*
      ── The outline's two levels ──────────────────────────────────────────

      THE DOT IS THE ROW'S OWN, drawn as a flex item of the button (\`.chapter\`
      is already \`display: flex\`, so the \`::before\` takes the row's 6px gap
      without a second number being written down anywhere). Centred rather than
      on the baseline: an empty box's baseline is its bottom edge, which would
      hang the dot below the type it belongs to.

      A HEADING ROW GETS THE SAME BOX, EMPTY. The dot is the only thing this
      panel says with colour, so the two levels must not ALSO differ by four
      pixels of accident: both rows measure their text from the same origin, and
      the indent below is then the whole of the difference in position — a real
      16px step instead of the near-miss you get by indenting one level past a
      gutter the other does not have.

      SCOPED TO THIS SECTION'S ROWS. Notes, loose markers and shelved rows are
      \`.entry\` with a \`.chapter\` button too, and none of them is a division.
    */
    .entry.division > .chapter::before,
    .entry.section > .chapter::before {
      content: '';
      flex: 0 0 auto;
      align-self: center;
      width: 6px; height: 6px;
      border-radius: 50%;
    }
    .entry.division > .chapter::before { background: var(--mark-division); }
    .entry.section { padding-left: 1rem; }

    .none {
      padding: 4px 12px 8px;
      color: var(--text-tertiary); font-size: 11px; font-style: italic;
    }

    /* ── The proof sheet's three sections ──────────────────────────────────── */

    /*
      THE COUNT GOES AMBER WHEN SOMETHING IN THE SECTION NEEDS A DECISION, and it
      is still the same quiet badge — §5 asks for a colour, not for a second kind
      of badge, and this app does not put numbers in red circles.
    */
    .count.flagged { color: var(--ink-flag); }

    /*
      THE ORDINAL, or the kind of thing a shelved row is. It is the leading mark
      of a row the way the sienna ordinal is the leading mark of a note in the
      book's gutter, and it holds a fixed width so that twenty rows read as a
      column rather than as twenty different indents.
    */
    .ord {
      flex: 0 0 auto;
      min-width: 1.6em;
      color: var(--text-tertiary);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .ord.flag { color: var(--ink-flag); }

    /*
      A ROW WITH A FLAG ON IT — dotted, in the amber, exactly as the marker and
      the note wear it on the paper. Underline rather than a background, because
      a list where the interesting rows are tinted becomes a list nobody can read
      the ordinary rows in.
    */
    .entry.flagged .ch-title {
      text-decoration: underline dotted var(--ink-flag);
      text-underline-offset: 0.2em;
    }

    /* The armed loose marker wears \`.chapter.active\`, which is already the panel's
       word for "this is the row you are on" — one vocabulary, stated once above. */

    /* A shelved row is two lines — what it is and where, then the evidence. */
    .entry.shelved { align-items: flex-start; }
    .shelf { flex: 1; min-width: 0; margin: 0 6px; padding: 6px 10px; }
    .shelf-line { display: flex; align-items: baseline; gap: 6px; }
    .shelf-line .ch-title { color: var(--text-secondary); font-size: 12px; }
    .shelf-why {
      margin: 2px 0 0;
      color: var(--text-tertiary);
      font-size: 10px; line-height: 1.4;
    }
    .entry.shelved .pencil { margin-top: 6px; }

    .acts { display: flex; gap: 6px; padding: 8px 12px 4px; }
    /*
      The sentence under Apply changes. NOT a hint and deliberately not given
      that class's four-line reserve: a hint is a section's standing description
      and holds its height whatever happens, while this line and the button above
      it are one thing that appears together and goes away together. Reserving
      space for it would leave a hole under the button in the ordinary state,
      which is the state where nothing is waiting to be applied.
    */
    .applying {
      margin: 0 0 6px;
      padding: 0 12px;
      font-size: 11px; line-height: 1.4;
      color: var(--text-tertiary);
    }
    .act {
      flex: 1;
      padding: 5px 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-primary); font-size: 11px;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .act:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .act:disabled { opacity: 0.4; cursor: default; }
    /*
     * ARMED — the button holding a mode open. It wears the chapter line's own
     * green, because it is the same statement in two places: the dotted line is
     * green, the button that places one is green while it is waiting, and the
     * cursor over the book is a crosshair. Three signs of one mode, which is
     * what a mode with no window of its own needs to not be invisible.
     */
    .act.armed, .act.armed:hover:not(:disabled) {
      background: #2f7d4f; border-color: #2f7d4f; color: #fff;
    }

    /* ── The one thing at the top that is not a section ────────────────── */

    /*
      THE STANDING STRIP — the new fixed top of the panel, where the Steps
      accordion used to be.

      \`flex: 0 0 auto\` is the whole difference from a section: it takes the
      height of its own contents and never a share of the column, because it is
      one line and a button that comes and goes, and giving it \`flex: 1 1 0\`
      would hand a third of the panel to a sentence.
    */
    .standing {
      flex: 0 0 auto;
      border-bottom: 1px solid var(--border-subtle);
    }
    /*
      THE LABEL AND THE NAME ON ONE LINE, in the accordion headers' own
      typography, so the top of the panel reads as furniture of the same make —
      without the twist, because there is nothing to open.
    */
    .strip {
      display: flex; align-items: baseline; gap: 8px;
      padding: 10px 12px 8px;
    }
    .strip .label {
      flex: 0 0 auto;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    /*
      THE STANDING STEP, IN THE ACCENT — the same word for "this is the one you
      are on" that the library's current row uses, so the two panels are visibly
      saying one thing about one position rather than two things about two.
    */
    .strip .name {
      flex: 1; min-width: 0;
      color: var(--accent); font-size: 12px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  `],
})
export class InspectorComponent {
  protected readonly stage = inject(StageService);
  private readonly stacks = inject(BookStacksService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);


  /**
   * Both sections start OPEN, which is what Owen asked for and what an inspector
   * is for: a panel whose sections you have to open before it says anything is a
   * panel that says nothing. They are still collapsible, because sixty chapters
   * and eleven categories do not both fit on a laptop.
   */
  protected readonly chaptersOpen = signal(true);
  /** The proof sheet's two other sections. Open by default, for the reason above. */
  protected readonly notesOpen = signal(true);
  protected readonly furnitureOpen = signal(true);

  /** Which chapter row is being renamed, and the text in its box. */
  protected readonly renamingHref = signal<string | null>(null);
  protected readonly renameText = signal('');

  private readonly renameBox = viewChild<ElementRef<HTMLInputElement>>('renameBox');

  // ── The proof sheet's panels: Chapters, Notes, Furniture review ──────────
  //
  // Three sections about one book, and none of them holds any of it. The book
  // pane registers itself with the service as a `BookStack`; what this half of
  // the component does is read that pane's own replay and push ops onto that
  // pane's own stack. Nothing here is persisted, nothing here goes over IPC, and
  // there is no second account of the document anywhere in it — which is the
  // whole of why the panels can live in the shell (RENDERER-DESIGN.md §5) while
  // the ops go on living in the pane that draws them.

  /** The book pane in front, or null for every other kind of document. */
  protected readonly sheet = computed<BookStack | null>(() => {
    const tab = this.stage.activeDocument();
    return tab === null || tab.kind !== 'book' ? null : this.stacks.bookStackFor(tab.id);
  });

  /**
   * The book as that pane is drawing it — the file with the chain and the
   * unapplied stack replayed over it, and null while it is still opening.
   *
   * THE PENDING VIEW AND NOT THE FILE. A panel drawing what is on disk would
   * disagree with the paper the moment somebody struck a note, and the person
   * would be looking at two answers to one question with no way to tell which
   * was stale.
   */
  private readonly sheetView = computed<Replayed | null>(() => this.sheet()?.view() ?? null);

  /**
   * Where the book divides, in reading order — the replay's answer.
   *
   * ALREADY FILTERED TO WHAT IS DRAWABLE (`Replayed.chapters`), so a division
   * above a block a merge consumed is not in this list and there is no dimmed
   * row here of the kind the scan's section keeps. The two are different facts:
   * a scan's chapter names a banked answer this RENDERING may not show, and is
   * kept because the name is still in the file; this list is the file, so a
   * division that is not in it is a division that is not.
   */
  protected readonly sheetChapters = computed<SheetChapterRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const where = new Map(replayed.rows.map((row) => [row.id, row.pages[0] ?? row.page] as const));
    return replayed.chapters.map((one) => ({
      id: one.id,
      title: one.title,
      page: where.get(one.id) ?? 0,
    }));
  });

  /**
   * The same list with the book's HEADINGS in it — divisions at the top level,
   * every Section-header indented under the division it falls in.
   *
   * TWO LEVELS BECAUSE A BOOK HAS TWO. A division is where the book breaks; a
   * heading is where a part of it is announced. The panel listed only the first
   * of those, so a chapter with six headed sections in it looked exactly like a
   * chapter with none, and the one thing an outline is FOR — seeing the shape of
   * what you are working on — was the one thing it would not show.
   *
   * ONE WALK OF THE ROWS, and the order falls out of it. `Replayed.chapters` is
   * already filtered to divisions whose anchor is an unshelved row (ops.ts,
   * \`drawableChapters\`), so every division is met in this walk exactly where the
   * flow puts it and the nesting needs no second sort and no parent pointers:
   * reading order IS the outline.
   *
   * A ROW THAT IS BOTH IS THE CHAPTER. Divisions are routinely set on the very
   * heading block that opens them — the seed does it by construction — and
   * listing that block twice would have the panel say the book divides here and
   * also merely announces something here, about one block, in two rows sharing
   * one id.
   *
   * WHAT A SECTION ENTRY IS NOT: shelved, and not struck. The shelf is not the
   * book (the Furniture section is where those live and it says why each one
   * left). And an outline is where the book divides and what it will read as, so
   * a struck heading — in the document, drawn cancelled, absent from the edition
   * — is on its way out and has no business shaping the list of what is staying.
   *
   * A HEADING ABOVE THE FIRST DIVISION STILL LISTS, indented, under nothing.
   * Front matter has headings and no parent, and inventing a parent for them
   * would be the panel making up a division the book does not have.
   */
  protected readonly sheetOutline = computed<OutlineEntry[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const divisions = new Map(replayed.chapters.map((one) => [one.id, one.title] as const));
    const out: OutlineEntry[] = [];
    for (const row of replayed.rows) {
      const page = row.pages[0] ?? row.page;
      const division = divisions.get(row.id);
      if (division !== undefined) {
        out.push({ kind: 'chapter', id: row.id, title: division, page });
        continue;
      }
      if (row.category !== 'Section-header') continue;
      if (row.shelf !== undefined || row.struck === true) continue;
      out.push({ kind: 'section', id: row.id, title: headingWords(row.text), page });
    }
    return out;
  });

  /** Every note in the book, in reading order, each knowing whether anything points at it. */
  protected readonly notes = computed<NoteRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const orphans = new Set(replayed.loose.notes);
    const out: NoteRow[] = [];
    for (const row of replayed.rows) {
      // The shelf is not the book, and a note is never on it.
      if (row.shelf !== undefined || row.category !== 'Footnote') continue;
      out.push({
        id: row.id,
        // The engine counts a note's place on its page from zero and the page
        // prints it from one, which is the pane's own arithmetic for the sienna
        // ordinal in the gutter.
        ordinal: (row.note ?? 0) + 1,
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
        orphan: orphans.has(row.id),
      });
    }
    return out;
  });

  /**
   * The reference numbers in the body that no note carries.
   *
   * NOT ROWS. A loose marker is a run of characters inside a block — a block,
   * an offset and a length — so it is listed by the words it is printed in and
   * by the number the page shows, and its identity is the three coordinates
   * together. That key is what the linking state is held by, so a marker the
   * replay re-derives away while somebody is choosing simply stops being armed.
   */
  protected readonly looseMarkers = computed<LooseRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const held = new Map(replayed.rows.map((row) => [row.id, row] as const));
    const order = new Map(replayed.rows.map((row, at) => [row.id, at] as const));
    return [...replayed.loose.markers]
      .sort((one, other) =>
        (order.get(one.block) ?? 0) - (order.get(other.block) ?? 0) || one.at - other.at)
      .map((marker) => {
        const row = held.get(marker.block);
        return {
          key: `${marker.block}|${marker.at}|${marker.len}`,
          block: marker.block,
          at: marker.at,
          len: marker.len,
          printed: marker.printed,
          words: opening(row?.text ?? ''),
          page: row === undefined ? 0 : row.pages[0] ?? row.page,
        };
      });
  });

  /** Both directions of the one flag, counted for the badge. */
  protected readonly unlinked = computed<number>(() => {
    const replayed = this.sheetView();
    return replayed === null ? 0 : replayed.loose.markers.length + replayed.loose.notes.length;
  });

  /** Every row the reflow took out of the book, at its reading-order position. */
  protected readonly furniture = computed<ShelvedRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const out: ShelvedRow[] = [];
    for (const row of replayed.rows) {
      if (row.shelf === undefined) continue;
      out.push({
        id: row.id,
        label: pdfCategoryLabel(row.category),
        // Every shelved row carries one, by the file format's own rule; the
        // empty string is what a book written by something older would leave,
        // and an empty line is better than a sentence this panel invented.
        why: row.why ?? '',
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
      });
    }
    return out;
  });

  /**
   * The loose marker whose note the next click chooses, by key.
   *
   * A KEY AND NOT THE ROW. The rows are recomputed on every push, and a held
   * object would go on naming a marker the replay has since bound or re-derived
   * away — which is a link op minted against coordinates that have moved.
   */
  protected readonly linking = signal<string | null>(null);

  /** That marker, if it is still loose. Null the moment it stops being. */
  protected readonly linkingRow = computed<LooseRow | null>(() => {
    const key = this.linking();
    return key === null ? null : this.looseMarkers().find((row) => row.key === key) ?? null;
  });

  /** Arm a number for linking, or put it down again. */
  protected startLink(row: LooseRow): void {
    this.linking.set(this.linking() === row.key ? null : row.key);
  }

  /**
   * A note row, clicked — which means one of two things and says which in the
   * hint before it is clicked.
   *
   * With a number armed it is the LINK: the number in the body stops being a
   * number nothing carries and the note stops being a note nothing points at,
   * both from one decision, which is what `link` is for. With nothing armed it
   * is the jump — the pane's own scroll-and-pulse, so that clicking a note in a
   * list of eighty puts it in front of the reader on the paper.
   */
  protected tapNote(row: NoteRow): void {
    const pane = this.sheet();
    if (pane === null) return;
    const picked = this.linkingRow();
    if (picked === null) {
      pane.reveal(row.id);
      return;
    }
    this.linking.set(null);
    pane.push([{ op: 'link', block: picked.block, at: picked.at, len: picked.len, note: row.id }]);
  }

  /** Put a shelved row back in the book, where it was printed. */
  protected restoreShelved(id: string): void {
    this.sheet()?.push([{ op: 'restore-furniture', id }]);
  }

  /**
   * The one block picked on the paper, when exactly one is and it is in the flow.
   *
   * A DIVISION SITS ABOVE A BLOCK, so a shelved row cannot carry one — the
   * replay would refuse it into `missing`, where nothing can clear it, and a
   * button that mints such an op is a button that files a complaint against the
   * person who pressed it.
   */
  private readonly divideAt = computed(() => {
    const pane = this.sheet();
    const replayed = this.sheetView();
    if (pane === null || replayed === null) return null;
    const picked = [...pane.selected()];
    if (picked.length !== 1) return null;
    const row = replayed.rows.find((one) => one.id === picked[0]);
    return row === undefined || row.shelf !== undefined ? null : row;
  });

  protected canDivide(): boolean {
    const row = this.divideAt();
    return row !== null && !this.sheetChapters().some((one) => one.id === row.id);
  }

  protected divideTitle(): string {
    const row = this.divideAt();
    if (row === null) return 'Pick one block on the page first';
    return this.sheetChapters().some((one) => one.id === row.id)
      ? 'A chapter already starts at that block'
      : 'The book divides at this block, and the contents lists it';
  }

  /**
   * "Chapter starts here", over the block picked on the paper.
   *
   * SEEDED WITH THE BLOCK'S OWN FIRST LINE, which is what the scan's version of
   * this button does and for its reason: it is right far more often than any
   * other guess, it is exactly what the detection would have called it, and it is
   * a starting point rather than a rule — the row is renameable the moment it
   * appears, because the contents entry and the printed heading are two
   * statements and a book is allowed to disagree with itself about them.
   */
  protected makeSheetChapter(): void {
    const pane = this.sheet();
    const row = this.divideAt();
    if (pane === null || row === null || !this.canDivide()) return;
    const words = row.text.split('\n')[0]?.trim() ?? '';
    pane.push([{ op: 'chapter', set: row.id, title: words.slice(0, 120) }]);
  }

  protected startSheetRename(row: SheetChapterRow): void {
    this.renameText.set(row.title);
    this.renamingHref.set(row.id);
  }

  /** Escape, and blur. The box closes and the name is left as it was. */
  protected cancelRename(): void {
    this.renamingHref.set(null);
  }

  /**
   * Enter in the rename box. An empty or unchanged name is a cancel, which is
   * the box's own rule everywhere else in this panel — and here it also keeps
   * the paper's promise that a chapter chip always has something on it to
   * double-click.
   */
  protected commitSheetRename(id: string): void {
    const pane = this.sheet();
    const label = this.renameText().trim();
    const row = this.sheetChapters().find((one) => one.id === id);
    this.renamingHref.set(null);
    if (pane === null || label.length === 0 || label === row?.title) return;
    pane.push([{ op: 'chapter', rename: id, title: label }]);
  }

  /** The block stays; the rule goes. */
  protected dropSheetChapter(id: string): void {
    this.sheet()?.push([{ op: 'chapter', remove: id }]);
  }

  /**
   * The way back — one op, so Ctrl+Z brings the person's own list back.
   *
   * Only offered while the ops own the list, because a reset over a seed already
   * in force is a change that changes nothing and would still be a row in
   * somebody's history.
   */
  protected resetSheetChapters(): void {
    const pane = this.sheet();
    if (pane === null || !pane.chaptersOwned()) return;
    pane.push([{ op: 'chapter', reset: true }]);
  }

  // ── Standing on ──────────────────────────────────────────────────────────

  /**
   * The project the focused document belongs to, or null for a file opened from
   * somewhere this app has never imported.
   *
   * THE STRIP IS ABOUT THE BOOK AND NOT ABOUT THE TAB, which is why this is a
   * separate question from `subject()`. A book's position is the same position
   * whether you are looking at the scan, at the flowing book cast from it or at
   * one of its translations — they are all one project — and a strip that came
   * and went with the mode a pane happens to be in would be a position that
   * belongs to a viewer rather than to a book.
   */
  protected readonly projectDir = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    // A catalogue that will not parse has no history to draw and its refusal is
    // already on its row on Home. `ProjectsService` treats it as no project at
    // all for exactly this reason, and so does this.
    return project === null || project.problem !== null ? null : project.dir;
  });

  /** Main's sentence for a ledger it would not read, drawn under the strip. */
  protected readonly stepsProblem = computed<string | null>(() =>
    this.ledger.problemFor(this.projectDir()));

  /**
   * WHERE THIS BOOK IS STANDING, in one line.
   *
   * ── Why it says two things about a reading and one about everything else ────
   *
   * The library calls a read step "the Book", because in a tree of provenance
   * that is what the node IS — the flowing document you read, curate and
   * translate — and *"we shouldnt call the working files 'epub' until we
   * export"*. The step's own label says something else and something useful:
   * "Read (317 pages)", which is what was actually done and how much of it. A
   * strip that said only "Book" would leave somebody standing on one of two
   * readings with no way to tell which; one that said only "Read (317 pages)"
   * would name a row the panel beside it calls something different. So it says
   * both, in that order — the thing, then what was done to make it.
   *
   * THREE STATES THAT LOOK ALIKE AND ARE NOT: a ledger that refused to parse
   * (the sentence below the strip says which), a history still in flight, and a
   * book with a position. Saying "nowhere" while the answer is on its way would
   * be the panel asserting something it has not been told.
   */
  protected readonly standingName = computed<string>(() => {
    const dir = this.projectDir();
    if (dir === null) return '';
    if (this.ledger.problemFor(dir) !== null) return 'Nowhere';
    const step = this.ledger.standingIn(dir);
    if (step === null) return this.stepsRead() ? 'Nowhere' : 'Reading this book’s history…';
    return step.action === 'read' ? `Book · ${step.label}` : step.label;
  });

  /**
   * The strip on hover — the full timestamp, and where the rest of the story is.
   *
   * IT POINTS AT THE LIBRARY, because that is the panel that moves this. The
   * strip is a readout and deliberately not a control: one selector
   * (docs/WORKBENCH.md §6c), and it is on the left.
   */
  protected standingTitle(): string {
    const dir = this.projectDir();
    const step = dir === null ? null : this.ledger.standingIn(dir);
    if (step === null) return 'Where this book stands. Click a step in the library to move it.';
    return `${step.label} — ${new Date(step.createdAt).toLocaleString()}. This is what the panes `
      + 'show and what the next thing you do is made from. Click a step in the library to move it.';
  }

  /**
   * Whether this window has read this project's history at all.
   *
   * The strip above draws from it, and null there means "not read yet" rather
   * than "nowhere" — a panel that said a book was standing nowhere because an
   * IPC had not answered would be reporting its own latency as a fact about
   * somebody's project.
   */
  protected readonly stepsRead = computed(() =>
    this.ledger.historyFor(this.projectDir()) !== null);
}

interface SheetChapterRow {
  /** The block the division sits above — the id every chapter op is keyed to. */
  id: string;
  title: string;
  /** The source page it opens on, drawn with the ≈ the book's own ghosts wear. */
  page: number;
}

/**
 * One row of the two-level outline: a division, or a heading inside one.
 *
 * IT EXTENDS THE CHAPTER ROW rather than being a union of two shapes, because
 * the two rows carry the same three facts and differ only in what may be DONE to
 * them — which the template asks about by name, once, where it draws the
 * buttons. A union would buy a narrowing the template does not need and would
 * cost this file a second declaration of id, title and page.
 */
interface OutlineEntry extends SheetChapterRow {
  kind: 'chapter' | 'section';
}

/**
 * A heading's words, for a row in the outline.
 *
 * THE EMPHASIS MARKS COME OFF. A heading's text arrives in the model's spelling
 * and \`*Interlude*\` is the source saying "set this in italics", not a book
 * called *Interlude* with the asterisks printed. Elsewhere in this panel the
 * markup rides along (\`opening\`, which lists what the book SAYS); an outline
 * entry is a NAME, held next to chapter titles that carry none, and a column of
 * names where half wear punctuation the printer never set reads as a fault in
 * the book.
 */
function headingWords(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

/** One drawn row of the Notes section — a note at the foot of a page. */
interface NoteRow {
  id: string;
  /** Which note of its page this is, counted from one. */
  ordinal: number;
  words: string;
  page: number;
  /** True when nothing in the body points at it — one of the two linking flags. */
  orphan: boolean;
}

/** One drawn row of the numbers in the body that no note carries. */
interface LooseRow {
  /** Block, offset and length together — the only identity a marker has. */
  key: string;
  block: string;
  at: number;
  len: number;
  /** The number the page printed, which is what a person matches a note by. */
  printed: number;
  /** The opening of the block it is printed in, so the row can be found. */
  words: string;
  page: number;
}

/** One drawn row of the Furniture review — a row the reflow took out of the book. */
interface ShelvedRow {
  id: string;
  /** What kind of block the model said it was. */
  label: string;
  /** The reflow's own sentence of evidence for taking it out. */
  why: string;
  words: string;
  page: number;
}

/**
 * The opening of a block's words, for a row in a 260px column.
 *
 * WHITESPACE COLLAPSED AND CUT ON A CHARACTER COUNT, not on a word boundary: a
 * row is one line with an ellipsis at the end of it either way, and hunting for
 * the last space before the limit would make the cut depend on how long the
 * words happen to be. The source string's own markup rides along, because the
 * panel is a list of what the book SAYS and the book says it in the model's
 * spelling.
 */
function opening(text: string, many = 64): string {
  const said = text.replace(/\s+/g, ' ').trim();
  return said.length <= many ? said : `${said.slice(0, many).trimEnd()}…`;
}

/** One drawn row of the Category section. */
interface CategoryRow {
  id: string;
  label: string;
  colour: string;
  note: string;
  /** How many of them this chapter holds, or null while nobody has counted. */
  total: number | null;
  /** How many of those are already marked to be cut. */
  struck: number;
}
