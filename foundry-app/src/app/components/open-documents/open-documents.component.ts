import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { qualify, typeLabel } from '@shared/documents';
import type { LedgerStep, ProjectDocumentKind, ProjectSummary } from '@shared/types';

import { api } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { TabsService, type Tab } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * The LIBRARY, down the left — one provenance tree per open book.
 *
 * ── It was a documents list, and that was one selector too many ──────────────
 *
 * *"i feel like the available documents (on the left sidebar) and the steps
 * (right sidebar) are confusing. i could have a document open, the epub, but
 * have the pdf import step selected, and id never know that i just ran translate
 * against the original pdf rather than the generated epub because i had the
 * wrong step selected, since the right document was open."*
 *
 * The diagnosis was two selectors pretending to be one: this panel picked a
 * FILE, the inspector's Steps section picked a POSITION, and the actions keyed
 * off a mixture of both. So the two are merged here, into the shape the user
 * asked for — *"maybe we merge them and top level things get arrows that expand
 * down. steps applied to [x] document. the original document can be the root
 * since thats where it all started"* — and the Steps section left the inspector
 * for good. docs/WORKBENCH.md §6c is the ruling; this file is the half of it
 * that draws.
 *
 * ── The ledger was always a tree; this stops hiding it ───────────────────────
 *
 * Every step records the step it was made FROM (`LedgerStep.parent`), and
 * shared/types.ts:2385 says out loud that the flat chronological list was that
 * tree with the indentation taken off. The flattening was the right call for a
 * 260px accordion that had to say "what have I done to this book" in one
 * column; it is the wrong call for a navigator, because the one question a
 * navigator has to answer is "what was this made FROM" — which is exactly the
 * fact the flattening threw away. So: the import is the root, the reading hangs
 * under it, curation saves hang under the reading, and a translation is a new
 * book that nests and grows saves of its own.
 *
 * NOTHING IS RE-DERIVED FROM A FILE HERE. The parent chain is the ledger's own
 * (`LedgerService.historyFor`); the exports are `listProjects`' own; the labels
 * are the ones main wrote when the step was made. This component owns the
 * indentation and nothing else about the shape.
 *
 * ── The rows that died with the flattening ───────────────────────────────────
 *
 * THE PER-PROJECT DOCUMENT ROWS ARE GONE — the "PDF" row, the "EPUB" row, the
 * available-but-not-open rows, the missing ones. They were a second inventory of
 * the same project alongside the steps, listed one-per-type, and every one of
 * them was reachable as a POSITION instead: the scan is the import row, the
 * flowing book is the reading, a translation is its own step. Two lists of one
 * thing is how somebody translates the scan while looking at the book.
 *
 * AND "EPUB" DIED WITH THEM as a name for a working document. *"im thinking we
 * shouldnt call the working files 'epub' until we export."* The evolving thing
 * you read, curate and translate is **the Book**; the word EPUB now appears in
 * exactly two places in this app — the export modal's card, and an export row's
 * label — and it means "finished". `typeLabel` survives because it still names
 * FILES: a loose tab from outside the library, and a copy somebody opened by
 * hand out of a project folder.
 *
 * ── What still hangs off a root, and why ─────────────────────────────────────
 *
 * EXPORTS ARE CHILDREN OF THE ROOT, at the same indent as the Book, with no
 * expand arrow and nothing ever under them. *"it wont go into the working files
 * as a step because it isnt the base for new steps. its a terminal step."* They
 * are not top-level: with three books open, exports floating at the root of the
 * panel would have lost their parentage, and "Facsimile PDF · 14 Aug" names a
 * product and a day, not a book. Named by product and date, never by filename,
 * because that is the pair of facts that tells two of them apart.
 *
 * THE FACSIMILE IS THERE BESIDE THEM, and it is the one terminal row nobody asked
 * for: a reading makes it the moment it lands, because the pages as they were
 * printed are half of what a bank is for (docs/RENDERER.md §0 A3). It is drawn
 * exactly as an export is — a leaf under the book, no arrow, opens a PDF — because
 * from the panel's side the two are the same statement: this was made, and nothing
 * is made from it.
 *
 * AN HTML FACE hangs off the root too. It is a face of a document rather than a
 * step, so it has no place in the parent chain; it is still a tab somebody has
 * open and a tab nobody can close is worse than a tab in an odd place.
 *
 * "A COPY YOU OPENED" IS NOW A NARROWER THING, and better for it. It used to be
 * every open file the catalogue did not list; now the catalogue's OWN files are
 * spoken for by the tree — a step is what the scan and the Book are — so this
 * row is left meaning exactly what it says: something inside the project folder
 * that the project does not claim. An archived copy, a file reached by hand.
 *
 * AND A STEP'S OWN RENDERING IS NOT ONE OF THOSE, which took a second reading of
 * "the catalogue's own files" to get right — a per-step cast is uncatalogued on
 * purpose, so for a while a translation drew both its step and a loose row
 * calling the cast an EPUB somebody had opened. `ProjectSummary.renderings` is
 * the missing half of the sentence; see the set it feeds, below.
 *
 * ── A STEP NODE IS NOT A TAB, and does not wear a tab's marks ────────────────
 *
 * No ✕ — the root is the single exception, and what its ✕ closes is the BOOK
 * rather than the step, which is the next section — no middle-click close, no
 * column badge, no accent bar for "on screen".
 * A step is a POSITION — clicking it moves where the project stands and the
 * panes follow — and the panel's statement about it is `.current`, one row in
 * the tree drawn in the accent. Marking step rows as "showing in column 3" as
 * well would put the second selector straight back: *"Tabs are windows onto the
 * selection, never a second selector"* (§6c). The rows that ARE tabs — exports,
 * HTML faces, copies, loose files — keep every one of those marks, because for
 * them the mark is the truth.
 *
 * ── The three ✕, and the header they came from ───────────────────────────────
 *
 * THE ROW'S ✕ STILL DELETES, on an export and on a copy inside a project, behind
 * the app's one confirmation. Outside a project it still CLOSES: a file opened
 * from elsewhere is not main's to erase and `documents:delete` refuses it.
 *
 * THE ROOT'S ✕ CLOSES THE BOOK, and it is the one place a node row wears one.
 * The group header that used to carry this went when the import root took its
 * place, and closing a book went with it into the right-click (§6c: *"Right-click
 * the import root → Close project"*). The menu is still exactly where that lives
 * — this button calls the same action through the same path, so there is one
 * close-book in this file and not two. What the menu could not be is FINDABLE: a
 * right-click is a gesture with nothing on screen to suggest it, so for anyone
 * who was not told, the only way out of a book was to close its documents one at
 * a time and hope the tree went with them.
 *
 * The rule it bends is worth stating so it is not read as a licence. What a step
 * row must never carry is a ✕ meaning "delete this step and everything made from
 * it" — that is the panel's most expensive ambiguity and it stays behind the
 * menu, with main's accounting of the cost. This is not that button: it closes
 * tabs, it writes nothing and destroys nothing, and the book is one click from
 * coming back off Home's shelf. So it wears the ordinary ✕ and not the danger
 * one, and it says "Close book" in words on hover, where the glyph alone would be
 * asking the reader to guess which of the two meanings it has.
 *
 * MIDDLE-CLICK STAYS CLOSE on every row that is a tab, unchanged. It is the
 * gesture people bring from every other application, and it cannot destroy
 * anything. It is NOT given the book as well: a root carries no tab, and a
 * middle-click that shut five documents at once would be this app's largest
 * gesture on its least deliberate input.
 *
 * ── Collapse is a session, not a setting ─────────────────────────────────────
 *
 * Every node starts expanded, and a collapse lives in this component and dies
 * with the window. A persisted collapse would be a book that opens with its own
 * history hidden, for a reason the reader took three sessions ago and has no
 * memory of; a tree five rows deep is not a thing anybody needs saved.
 *
 * ── Dragging ─────────────────────────────────────────────────────────────────
 *
 * A row dragged WITHIN this list reorders the loose files — the only place a
 * document's order still exists. Rows inside a project cannot be reordered:
 * their order is the ledger's and the catalogue's, and a line drawn above one
 * would promise a move the next redraw undoes. A row dragged onto the workspace
 * lands in a column (the workspace owns that half of the gesture). Step rows are
 * not draggable at all: there is no tab to carry.
 *
 * Native HTML5 drag and drop, with the same custom MIME the strips used, and the
 * window's own file-drop veil still tells the two apart by looking for `Files`
 * in the payload (see App). `dataTransfer.types` is the only part of a drag
 * readable before the drop, which is what that test is for and why the id itself
 * can only be read when the drop happens.
 */
@Component({
  selector: 'app-open-documents',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      PUT AWAY, THE PANEL IS A STUB AND NOT NOTHING. The button that collapses it
      has to be the button that brings it back, and it has to be in the same
      place — the top-left corner of the window — or collapsing the list is a
      gesture with no visible way out except a keyboard chord and a dock item
      nobody knows are there. Thirty pixels is the price.
    -->
    @if (!ui.documentsShown()) {
      <div class="stub">
        <button class="collapse" title="Show the library (Ctrl+B)" (click)="ui.toggleDocuments()">»</button>
      </div>
    } @else {
    <div class="panel">
      <header class="head">
        <button class="collapse" title="Hide the library (Ctrl+B)" (click)="ui.toggleDocuments()">«</button>
        <!-- "Open documents" was the name of a list of files. This is the books
             themselves and everything that has been done to them, which is a
             library — and Final Cut's word for the same shelf, which is where
             the whole arrangement comes from (docs/WORKBENCH.md §6c). -->
        <span class="label">Library</span>
        <span class="count">{{ tabs.tabs().length }}</span>
      </header>

      <!--
        The list itself is the drop target for "put it at the end", the way the
        empty end of a strip was. Its rows handle the insertion points.
      -->
      <div
        class="list"
        [class.landing]="landing()"
        (dragover)="onListOver($event)"
        (dragleave)="onLeave()"
        (drop)="onDrop($event, null)"
      >
        @for (group of groups(); track group.key) {
          <!--
            role=group with the book's name on it, so the tree inside is
            announced as belonging to something rather than as a run of
            unrelated rows. There is no header element any more: the first row
            IS the book — its import, the thing it all started from.
          -->
          <div class="group" role="group" [attr.aria-label]="'Book: ' + group.title">
            @for (row of group.rows; track row.key) {
              <ng-container [ngTemplateOutlet]="line" [ngTemplateOutletContext]="{ $implicit: row }" />
            }
          </div>
        }

        @for (row of loose(); track row.key) {
          <ng-container [ngTemplateOutlet]="line" [ngTemplateOutletContext]="{ $implicit: row }" />
        }
      </div>

      <!--
        ONE ROW TEMPLATE FOR ALL FOUR KINDS, because a step, an export, an open
        file and a loose one are the same drawn line with different gestures
        behind it, and four copies of this markup would drift the first time a
        mark was added to one of them. What differs is carried on the row.
      -->
      <ng-template #line let-row>
        <div
          class="row"
          [style.padding-left.px]="10 + row.depth * 14"
          [class.node]="row.kind === 'root' || row.kind === 'step'"
          [class.root]="row.kind === 'root'"
          [class.current]="row.current"
          [class.stale]="row.stale"
          [class.inert]="row.tab === null && row.openable === false"
          [class.on]="row.column !== null"
          [class.focused]="row.focused"
          [class.available]="row.kind === 'export' && row.tab === null"
          [class.before]="before() === row.key"
          [title]="row.tooltip"
          [attr.draggable]="row.tab !== null"
          (click)="pickRow(row)"
          (auxclick)="onAux($event, row.tab)"
          (contextmenu)="onMenu($event, row)"
          (dragstart)="onDragStart($event, row.tab)"
          (dragend)="onDragEnd()"
          (dragover)="onRowOver($event, row)"
          (drop)="onDrop($event, row)"
        >
          <!--
            THE ARROW IS A SLOT EVEN WHEN THERE IS NO ARROW. A twist that
            appeared and disappeared would shift every name in the panel
            sideways by nine pixels depending on whether the book above had been
            translated. An export never gets one — it is terminal, and an arrow
            on it would promise something under it.
          -->
          @if (row.expanded !== null) {
            <button
              class="twist"
              [attr.aria-expanded]="row.expanded"
              [title]="row.expanded ? 'Collapse' : 'Expand'"
              (click)="toggle($event, row)"
            >{{ row.expanded ? '▾' : '▸' }}</button>
          } @else {
            <span class="twist"></span>
          }
          <span class="kind">{{ row.glyph }}</span>
          <span class="name">{{ row.title }}</span>
          <!--
            TWO marks, because they are two different things to fix. The dot is
            "this book is not in a folder of yours"; the pencil is "the copy
            that is in one is older than this". A row can wear both.
          -->
          @if (row.tab?.unsaved) {
            <span class="dot" title="Not saved anywhere you chose">●</span>
          }
          @if (row.tab?.modified) {
            <span class="pencil" title="Edited since it was last saved">✎</span>
          }
          <!-- WHEN, for the rows that are a moment in a book's history. -->
          @if (row.tally) {
            <span class="tally">{{ row.tally }}</span>
          }
          <!--
            WHICH column it is in, and only once there are two. With one column
            open the number is the only number it could be, and a badge that
            always says 1 is a badge that teaches people to stop reading it.

            NEVER ON A STEP ROW: a step is a position and not a tab, and a
            column number on one would be the second selector this tree exists
            to abolish.
          -->
          @if (row.column !== null && multi()) {
            <span class="column" [title]="'Showing in column ' + row.column">{{ row.column }}</span>
          }
          <!--
            ONE GLYPH, THREE JOBS, AND EVERY ONE OF THEM SAID IN WORDS ON HOVER.
            The root's closes the BOOK; a file's inside a project DELETES it; a
            file's from outside one CLOSES it, because a file opened from
            elsewhere is not this app's to erase. Three meanings on one shape is
            only safe while the tooltip is what a person actually reads, so none
            of these buttons is ever drawn without one.

            NONE, ON A STEP. Deleting a step is not deleting a file — it takes
            everything made from it — and that lives behind the right-click,
            with main's own accounting of what it costs.
          -->
          @if (row.kind === 'root') {
            <!--
              THE BOOK'S OWN ✕, and the only one on a node row. It closes this
              book's tabs and nothing else — no file, no step, no confirmation of
              its own beyond the ordinary close question a document with
              uncommitted work still asks. So it wears the plain ✕ rather than the
              danger one, and it calls the same action the right-click's Close
              book calls, through the same path: two doors onto one gesture must
              not become two implementations of it.
            -->
            <button
              class="x"
              (click)="closeBook($event, row)"
              title="Close book"
              aria-label="Close book"
            >✕</button>
          } @else if (row.kind === 'export' || (row.kind === 'document' && row.dir !== null)) {
            <button
              class="x danger"
              (click)="remove($event, row)"
              [title]="'Delete the ' + row.title + ' — permanently, from this book'"
              [attr.aria-label]="'Delete the ' + row.title"
            >✕</button>
          } @else if (row.kind === 'document' && row.tab !== null) {
            <button
              class="x"
              (click)="close($event, row.tab)"
              title="Close this document — it was opened from outside Foundry's library, so this app does not delete it"
              [attr.aria-label]="'Close ' + row.title"
            >✕</button>
          }
        </div>
      </ng-template>

      <!--
        THE MENU IS OURS, not Electron's. There is no context-menu idiom in this
        app to follow, and the native one would be the same mistake the native
        confirmation was: the OS's rectangle over a window whose every other
        surface is drawn here. It is also the only kind that can be built without
        a second IPC round trip per row.

        FOUR MENUS IN ONE CARD, because a row's kind decides entirely what can be
        done to it: a book can be closed, a step can be split out or deleted, an
        export and a copy can be revealed or erased. Offering all of them and
        greying most would be a card whose shape says nothing about what it is
        over.

        A full-window scrim under it, so the next click anywhere dismisses it
        exactly once and cannot also land on whatever was underneath.
      -->
      @if (menu(); as open) {
        <div class="menu-scrim" (click)="menu.set(null)" (contextmenu)="menu.set(null)"></div>
        <div
          class="menu"
          role="menu"
          [attr.aria-label]="'Actions for ' + open.row.title"
          [style.left.px]="open.x"
          [style.top.px]="open.y"
          (keydown.escape)="menu.set(null)"
        >
          @if (open.row.kind === 'root') {
            <!--
              GOING HOME. Closes every tab this book has open, through the
              ordinary close, so a document with uncommitted work still gets its
              one question. Nothing on disk; the book is one click from coming
              back, on Home's own shelf.
            -->
            <button role="menuitem" (click)="fromMenu(open.row, 'close-project')">Close book</button>
            <button role="menuitem" (click)="fromMenu(open.row, 'reveal')">Show in file manager</button>
          } @else if (open.row.kind === 'step') {
            <!--
              *"they can right-click a different step and click open, and itll
              split the screens between the one they just opened and the one they
              already had open."* The ordinary click already stands there and
              shows the document; what the menu adds is the arrangement —
              beside, rather than instead.
            -->
            <button role="menuitem" (click)="fromMenu(open.row, 'split')">Open in split</button>
            <button class="danger" role="menuitem" (click)="fromMenu(open.row, 'discard')">Delete this step…</button>
          } @else {
            <button role="menuitem" (click)="fromMenu(open.row, 'reveal')">Show in file manager</button>
            @if (open.row.kind === 'export') {
              @if (open.row.path.toLowerCase().endsWith('.epub')) {
                <button role="menuitem" (click)="fromMenu(open.row, 'view')">Open</button>
              }
              <!-- The same door the finished shelf row presses — an OS save
                   dialog over a copy, so the export reaches the hand from
                   either surface it is met on. -->
              <button role="menuitem" (click)="fromMenu(open.row, 'save-copy')">Save a copy…</button>
            }
            @if (open.row.tab !== null) {
              <button role="menuitem" (click)="fromMenu(open.row, 'close')">Close</button>
            }
            @if (open.row.dir !== null) {
              <button class="danger" role="menuitem" (click)="fromMenu(open.row, 'delete')">Delete…</button>
            }
          }
        </div>
      }
    </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: 220px;
      min-width: 220px;
      height: 100%;
    }
    /* Collapsed, the HOST narrows to the stub's width, because the shell's flex
       row measures the host and not the panel inside it — a stub drawn inside a
       220px host would be 30 pixels of button beside 190 of nothing. The class
       is put on by the shell (see App's template) rather than by a host binding
       here, so the element carrying it is invalidated by the same change
       detection pass that reads the flag. */
    :host(.shut) { width: 30px; min-width: 30px; }

    .stub {
      display: flex;
      justify-content: center;
      height: 100%;
      padding-top: 8px;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
    }

    /*
      THE TOP-LEFT CORNER OF THE WINDOW, in both states: shown, it is the first
      thing in the panel's own header; collapsed, it is the only thing in the
      stub. A collapse button that moves when you press it is a button people
      press once.
    */
    .collapse {
      flex: 0 0 auto;
      width: 20px; height: 20px;
      padding: 0;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 12px; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .collapse:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* The rail's own surface and border, so the two read as one left edge with a
       divider in it rather than as two panels of different materials. */
    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 8px 5px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
    /* Where a dragged row would land, when it is past the last one. */
    .list.landing { background: var(--accent-faint); }

    .row {
      display: flex;
      align-items: center;
      gap: 6px;
      /* The left padding is the DEPTH and is bound per row; only the other three
         sides are settled here. */
      padding: 6px 8px;
      color: var(--text-secondary);
      font-size: 12px;
      cursor: default;
      user-select: none;
      /* The accent bar lives here, so a row that is not on screen still holds
         the 2px and nothing shifts sideways when it arrives in a column. */
      box-shadow: inset 2px 0 0 0 transparent;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1),
                  box-shadow 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* Each book is a run; the space between two of them is what says where one
       ends. Heavier chrome would make the panel read as several lists. */
    .group { margin-bottom: 6px; }

    /*
      THE ROOT IS THE BOOK. It is a row like every other — clickable, and what it
      shows is the original import — so it is not given a header's uppercase
      shouting; it is given the weight a title has among its own contents.
    */
    .row.root .name { color: var(--text-primary); font-weight: 600; }

    /*
      THE STANDING ROW, in the same accent and the same faint wash the inspector
      marks its current category with. One word for "this is the one you are on"
      across the whole app; inventing a second is how a palette stops meaning
      anything. This is the panel's ONLY statement about selection — see the
      class docblock on why a step row wears no on-screen marks.
    */
    .row.node.current { background: var(--accent-faint); }
    .row.node.current .name { color: var(--accent); font-weight: 500; }

    /*
      A STALE STEP IS DIMMED AND STILL CLICKABLE, which was the ruling. Its
      payload is a true record of what was made — a translation of a bank that
      has since been re-read still holds the blocks it translated — so it opens,
      it renders, and only its currency is in question. The reason is on hover,
      where an explanation nobody needs stays out of the way of a list.
    */
    .row.stale .name, .row.stale .tally, .row.stale .kind { opacity: 0.55; }

    /*
      PLAIN TEXT HAS NO TAB IN THIS APP, and the row says so by not lighting up.
      It is still listed, because it is a thing the user made and a thing they can
      reveal or delete; what it does not do is pretend a click will open it.
    */
    .row.inert { color: var(--text-tertiary); opacity: 0.65; }
    .row.inert:hover { background: transparent; color: var(--text-tertiary); }

    /*
      AN EXPORT NOBODY HAS OPENED — dimmed and nothing else. The list's language
      for "on screen" is the accent bar (.on / .focused), so the honest opposite
      is simply not having it.
    */
    .row.available { color: var(--text-tertiary); }
    .row.available:hover { color: var(--text-primary); }

    /*
      ON SCREEN SOMEWHERE, and in the FOCUSED column, are two different facts
      and get two different strengths: the rail, the menu and Ctrl+S all act on
      the focused one, so which it is has to be visible without being loud.
    */
    .row.on { color: var(--text-primary); box-shadow: inset 2px 0 0 0 var(--border-strong); }
    .row.on.focused {
      background: var(--accent-faint);
      box-shadow: inset 2px 0 0 0 var(--accent);
    }

    /*
      The insertion point: a line along the edge the dragged row would land on.
      Spelled out against the on-screen selectors as well, because they set the
      same property at a higher specificity — without this the line would be
      invisible on exactly the rows a person is most likely to be dragging.
    */
    .row.before,
    .row.on.before,
    .row.on.focused.before { box-shadow: inset 0 2px 0 0 var(--accent); }

    /*
      THE ARROW, AND THE SPACE WHERE AN ARROW WOULD BE. Both are 9px wide so the
      names in one book line up whether or not a node has anything under it.
    */
    .twist {
      flex: 0 0 auto;
      width: 9px; height: 14px;
      padding: 0; margin: 0;
      background: transparent; border: none;
      color: var(--text-tertiary); font-size: 9px; line-height: 14px;
      text-align: left;
    }
    button.twist { cursor: pointer; }
    button.twist:hover { color: var(--text-primary); }

    .kind { flex: 0 0 auto; opacity: 0.6; font-size: 11px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dot { flex: 0 0 auto; color: var(--accent); font-size: 9px; line-height: 1; }
    .pencil { flex: 0 0 auto; color: var(--warn); font-size: 11px; line-height: 1; }
    .tally {
      flex: 0 0 auto;
      color: var(--text-tertiary); font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .column {
      flex: 0 0 auto;
      min-width: 12px;
      color: var(--text-tertiary);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    /*
      Hidden until the row is under the pointer or the button is keyboard-focused.
      Visibility rather than display, so the row's width does not change when it
      appears and the title does not re-truncate under the mouse.
    */
    .x {
      flex: 0 0 auto;
      visibility: hidden;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 2px 3px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover .x, .x:focus-visible { visibility: visible; }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* The button that ends something wears the error colour on hover, and only
       on hover — the same rule Home's delete follows. A permanently red control
       on every row of a document list reads as a warning about the documents. */
    .x.danger:hover { background: var(--error-soft); color: var(--error); }

    /* Above the panel and below the dialogs; the scrim is what makes the next
       click dismiss it exactly once. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 180px;
      padding: 4px;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu button {
      display: block; width: 100%;
      padding: 6px 10px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px; text-align: left; cursor: pointer;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
    .menu button.danger:hover { background: var(--error-soft); color: var(--error); }
  `],
})
export class OpenDocumentsComponent {
  protected readonly tabs = inject(TabsService);
  protected readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);
  /** Public to the template AND to the host binding above, which is a template too. */
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  constructor() {
    /*
     * RE-READ THE LIBRARY WHEN THE OPEN SET CHANGES, and only then.
     *
     * The two things that put a document into a project are opening one (which
     * imports it) and a conversion landing (which the queue announces by opening
     * the result). Both end as a change to the paths in this list, so watching
     * the paths catches both without this component knowing anything about
     * either. Nothing here reads `projects.items()`, so refreshing cannot
     * re-trigger the effect that asked for it.
     */
    effect(() => {
      this.tabs.tabs().map((tab) => tab.path).join('\u0000');
      void this.projects.refresh();
    });

    /*
     * THE HISTORY OF EVERY OPEN BOOK, ASKED FOR ONCE.
     *
     * Until this panel drew trees, the only surfaces that needed a ledger were
     * the inspector — which asks for the FOCUSED document's project — and the
     * block editor, which asks when the mode comes up (`loadBlockView`,
     * tabs.service.ts). Neither of those covers this one: five books can be open
     * with one focused, and the four unfocused ones would have drawn a root with
     * nothing under it until somebody clicked into them. So the library asks for
     * its own, for every book it is about to draw.
     *
     * `ensure` IS IDEMPOTENT AND SILENT BY CONTRACT (LedgerService) — a project
     * already held or already in flight is a no-op — which is what makes it safe
     * from an effect that re-runs whenever a tab opens. It also reads no signal
     * this effect writes: `openProjects` is composed from the tabs and the
     * catalogue, never from the held ledgers, so nothing here can chase its own
     * tail.
     */
    effect(() => {
      for (const project of this.openProjects()) this.ledger.ensure(project.dir);
    });
  }

  /** The row a drop would land in front of, and whether the end of the list is the target. */
  protected readonly before = signal<string | null>(null);
  protected readonly landing = signal(false);
  /** The open context menu: which row it is about, and where it was asked for. */
  protected readonly menu = signal<{ row: Row; x: number; y: number } | null>(null);

  /**
   * The nodes somebody has folded shut, by row key.
   *
   * COLLAPSED RATHER THAN EXPANDED, so a step that appears while you are looking
   * at the tree appears OPEN — a new save arriving folded under its reading
   * would be the panel hiding the thing that just happened. Session-only: see
   * the class docblock.
   */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly multi = computed(() => this.tabs.panes().length > 1);

  /**
   * The books this panel is about: a project is OPEN while one of its documents
   * is, which is the existing ruling and unchanged (docs/WORKBENCH.md §6c,
   * "Going home"). Closed books live on Home's shelf, not in the library.
   *
   * SEPARATE FROM `groups()` because the ensure effect above must not read a
   * ledger to decide which ledgers to ask for. This is composed from the open
   * tabs and main's catalogue and nothing else.
   */
  private readonly openProjects = computed<readonly ProjectSummary[]>(() => {
    const paths = this.tabs.tabs().map((tab) => tab.path);
    // The held project draws even with no tab open: closing the last document
    // keeps the window in the project, and this tree is the door back into it
    // (`TabsService.heldProject`). One project, not a history — the hold is
    // where you ARE, not where you have been.
    const held = this.tabs.heldProject();
    return this.projects.items().filter((project) => project.problem === null
      && (paths.some((path) => inProject(path, project.dir))
        || (held !== null && inProject(held, project.dir))));
  });

  /**
   * Every open tab as a drawable row, with its editor tucked under it.
   *
   * The column number is the pane's INDEX, which is what Ctrl+1…5 counts and
   * what a person reads off the screen left to right — not the pane's id, which
   * is an implementation detail that survives a reorder.
   */
  protected readonly rows = computed<Row[]>(() => {
    const tabs = this.tabs.tabs();
    const panes = this.tabs.panes();
    const focusedPaneId = this.tabs.focusedPaneId();
    const out: Row[] = [];
    const emit = (tab: Tab, indent: boolean): void => {
      /*
       * THE COLUMN A DOCUMENT IS SHOWING IN, and showing is the word: with the
       * strips back a tab can be in a column's stack without being the one on
       * screen, and the accent bar here has always meant "you are looking at
       * this". A tab waiting in a strip is drawn as an ordinary row — its strip
       * already says where it is, and marking it on screen as well would be two
       * surfaces disagreeing about what "on screen" means.
       */
      const at = panes.findIndex((pane) => pane.activeTabId === tab.id);
      out.push({
        ...blank,
        key: tab.id,
        kind: 'document',
        tab,
        path: tab.path,
        title: tab.title,
        glyph: glyphFor(tab),
        tooltip: this.tooltip(tab),
        depth: indent ? 1 : 0,
        column: at < 0 ? null : at + 1,
        focused: at >= 0 && panes[at]!.id === focusedPaneId,
      });
    };
    for (const tab of tabs) emit(tab, false);
    return out;
  });

  /**
   * ONE TREE PER OPEN BOOK — the panel, flattened for drawing.
   *
   * ── Why it is flattened here rather than drawn recursively ──────────────────
   *
   * A recursive template would need a component or a self-referencing
   * ng-template per level, and every gesture on a row — the drop insertion
   * point, the menu, the middle-click — is written against a flat list of keys.
   * Flattening at the source keeps ONE row template, one `track`, and one place
   * that decides what is visible: a collapsed node simply does not emit its
   * children, which is also what makes collapse cost nothing.
   *
   * ── What is claimed, and what is left over ──────────────────────────────────
   *
   * The catalogue's own files — the scan, the cast Book, a translation — are
   * SPOKEN FOR BY THE TREE and are not drawn a second time as tabs. That is the
   * whole point of the merge: the step is the document. Their tabs are still
   * counted in `tabIds`, because closing the book has to close them and the
   * loose list must not pick them up as strays from nowhere.
   *
   * What is genuinely left over — an HTML face, a copy somebody opened out of an
   * archive folder — hangs off the root, because that is where it is on disk and
   * a row nobody can close is worse than a row in an odd place.
   */
  protected readonly groups = computed<Group[]>(() => {
    const open = this.rows();
    const collapsed = this.collapsed();
    const out: Group[] = [];

    for (const project of this.openProjects()) {
      const mine = open.filter((row) => inProject(row.path, project.dir));
      if (mine.length === 0) continue;

      const history = this.ledger.historyFor(project.dir);
      const problem = this.ledger.problemFor(project.dir);
      const standing = this.ledger.standingIn(project.dir)?.id ?? null;

      /*
       * THE PARENT CHAIN, INDEXED ONCE. `ProjectLedger.steps` is in creation
       * order and `parseLedger` refuses a file where it is not, so the children
       * of any node come out in the order they were made without a sort — which
       * matters, because a sort here would be this component holding a second
       * opinion about the shape of somebody's history.
       */
      const steps = history?.ledger.steps ?? [];
      const kids = new Map<string, LedgerStep[]>();
      let origin: LedgerStep | null = null;
      for (const step of steps) {
        if (step.parent === null) {
          origin ??= step;
          continue;
        }
        const already = kids.get(step.parent);
        if (already === undefined) kids.set(step.parent, [step]);
        else already.push(step);
      }

      /*
       * A STEP THE CHAIN DOES NOT REACH IS STILL DRAWN, hanging off the root.
       *
       * The ledger's rule is one parentless step and every other parent present
       * (`LedgerStep.parent`, shared/types.ts), and `parseLedger` holds it — so
       * this is a branch that should never run. It exists because the failure it
       * prevents is the worst one a navigator has: a step that is in the file, is
       * standing in the position, and is on nobody's screen, so it cannot be
       * clicked, split or deleted. The flat list could not have this bug; a tree
       * can, and it costs one filter not to.
       */
      const ids = new Set(steps.map((step) => step.id));
      const stranded = steps.filter((step) => step !== origin
        && (step.parent === null || !ids.has(step.parent)));

      /*
       * THE TERMINAL FILES — the exports, children of the root, at the Book's
       * own indent and with no arrow.
       *
       * Main sends them newest first with a PROJECT-RELATIVE path
       * (`ProjectSummary.exports`), which is this codebase's oldest house rule
       * reaching the nav: a project holds `archive/Book.pdf`, `working/Book.pdf`
       * and `final/Book.pdf` at once, so nothing may ever be matched or joined
       * by its last segment. The path is rebuilt against the project's own
       * directory — in the project's own separator, so a Windows tooltip does
       * not read half in slashes — and it is never on screen as a name.
       *
       * An export whose file has gone is not listed at all: main drops those
       * before it sends the list, because `final/` is the user's own tray and a
       * row that opens nothing is worse than no row.
       */
      const claimed = new Set<string>();
      const terminals: Row[] = [];
      for (const made of project.exports) {
        const path = joinIn(project.dir, made.file);
        const label = exportLabel(made.kind);
        const already = mine.find((row) => fold(row.path) === fold(path)) ?? null;
        if (already !== null) claimed.add(already.key);
        terminals.push({
          ...blank,
          key: `${project.key}:final:${made.file}`,
          kind: 'export',
          tab: already?.tab ?? null,
          path,
          title: label,
          tally: whenOn(made.madeAt),
          glyph: made.kind === 'epub' ? '▤' : made.kind === 'pdf' ? '▦' : '≡',
          tooltip: made.kind === 'txt'
            ? `Show this ${label} in the file manager\nExported `
              + `${new Date(made.madeAt).toLocaleString()}\nRight-click to save a copy.\n${path}`
            : `Open this ${label}\nExported ${new Date(made.madeAt).toLocaleString()}\n`
              + `Right-click or Ctrl+S in its tab to save a copy.\n${path}`,
          depth: 1,
          dir: project.dir,
          // A finished thing this app made, so it wears the dot when it is opened:
          // it lives in the library and nowhere the user filed it themselves.
          managed: true,
          /*
           * ONLY THE REPRINT OPENS. An export is a FINISHED product and this app
           * has exactly one viewer left for a file — pdf.js — so a PDF export
           * opens and an EPUB does not: the iframe reader that used to show one
           * is deleted (docs/RENDERER.md §7), and pointing pdf.js at a zip would
           * be a pane with "This PDF would not open" on it. The row stays, wearing
           * its date and its Reveal, because an export the app made and then would
           * not admit to is worse than one it will not open.
           */
          openable: made.kind === 'pdf',
          column: already?.column ?? null,
          focused: already?.focused ?? false,
        });
      }

      /*
       * AND THE FACSIMILES, WHICH ARE TERMINAL FOR THE SAME REASON THE EXPORTS
       * ARE — *"from the bank, pdf facsimile can be generated. that's a terminal
       * item"* (docs/RENDERER.md §0 A3).
       *
       * A reading has two documents in it: the Book, which is the read step's row
       * up in the tree and the thing everything downstream is made from, and the
       * page-for-page record, which nothing is ever made from. So it is a leaf
       * beside the exports rather than a step of its own — no arrow, no position,
       * and clicking it opens the PDF exactly as clicking an export opens one.
       *
       * AND IT IS ONLY EVER HERE BECAUSE SOMEBODY ASKED FOR IT. A reading used to
       * leave one of these in `generated/` on its own, back when a re-read could
       * take the previous pass's answers with it and a reprint on the disk was the
       * only thing about a reading that could not be invalidated. Banks are kept
       * now, so a project reads without gaining a row here and the row appears
       * when a person makes the reprint. Which is also why the list can be empty
       * for a fully read book and that is the ordinary state, not a hole.
       *
       * DRAWN UNDER THE IMPORT, at the Book's own indent, because that is where
       * the ruling puts it and because the alternative is worse than it looks: a
       * facsimile hung under the READ step would be a child of a row that is
       * itself a position, so folding the reading away would hide a terminal file,
       * and a project with two readings would draw two rows that look like
       * versions of one document rather than the records of two different passes.
       *
       * CALLED "FACSIMILE" AND NOT "FACSIMILE PDF", which is the export's word.
       * The two rows can appear together — somebody who exports a facsimile after
       * one has been made has both — and the distinction they need is that one is
       * a copy they filed and one is the record this book keeps of its own
       * reading. The tooltip says which in words; the label carries the difference
       * a person scanning a tree can use, and neither of them is a filename.
       *
       * Main sends only the ones that are ON DISK (`ProjectSummary.facsimiles`),
       * project-relative, newest reading last — the same rules the exports above
       * arrive under, for the same reasons.
       */
      for (const made of project.facsimiles) {
        const path = joinIn(project.dir, made.file);
        const already = mine.find((row) => fold(row.path) === fold(path)) ?? null;
        if (already !== null) claimed.add(already.key);
        terminals.push({
          ...blank,
          key: `${project.key}:facsimile:${made.file}`,
          // A FILE ROW AND NOT A FIFTH KIND. Everything the row does — open on
          // click, wear the column badge, offer a delete behind the danger ✕ — is
          // what this kind already means, and a `RowKind` per product would be
          // four template branches to say one thing.
          kind: 'export',
          tab: already?.tab ?? null,
          path,
          title: 'Facsimile',
          tally: whenOn(made.madeAt),
          glyph: '▦',
          tooltip: 'Open this facsimile\nThe pages of this book as they were '
            + 'printed, reprinted as real text from what the reading found. Nothing '
            + `is made from it.\n${path}`,
          depth: 1,
          dir: project.dir,
          managed: true,
          openable: true,
          column: already?.column ?? null,
          focused: already?.focused ?? false,
        });
      }

      /*
       * THE TABS THE TREE DOES NOT SPEAK FOR.
       *
       * An HTML face first, because it shares its book's path exactly and would
       * otherwise be swallowed by the catalogue test one line below — one file,
       * two tabs, and the one that is a separate document is the one that would
       * have gone missing.
       *
       * AND IT IS CALLED "HTML" HERE AND NOWHERE ELSE. Its tab is titled
       * "<book> — HTML", which is right in the loose list where nothing else
       * names the book; inside a book's own tree the root above has already said
       * it, so repeating it is two thirds of a row spent on what the reader can
       * already see.
       */
      /*
       * WHAT THE TREE ALREADY SPEAKS FOR — the catalogue, AND the books the steps
       * cast for themselves.
       *
       * The catalogue alone was wrong and the way it was wrong was visible:
       * *"under that - 'epub - a copy you open…' is this the OCR record/OCR bank?
       * … the naming scheme is wrong, the organizing is wrong, the user should
       * never see 'epub'… it's deceptive."* A per-step cast is not catalogued on
       * purpose (`ProjectSummary.renderings` holds the whole argument), so
       * standing on a translation — which opens its cast — produced a row down
       * here saying somebody had opened a file by hand, named by its container
       * format, one line under the step that had actually made it.
       *
       * So the set is both, joined against the project's own directory in the
       * project's own separator, whole path against whole path. `renderings`
       * arrives project-relative for the same reason `exports` does, which is
       * this codebase's oldest house rule: a project holds `archive/Book.pdf`,
       * `working/Book.pdf` and `generated/Book.pdf` at once and nothing may ever
       * be matched by its last segment.
       */
      const catalogue = new Set(project.documents.map((document) => fold(document.path)));
      const extras: Row[] = [];
      for (const row of mine) {
        if (claimed.has(row.key)) continue;
        /*
         * THE BOOK IS THE READ STEP, and the read step is already a row up
         * there — the one called "Book", which is what standing on it opens
         * (`showBook`, core/tabs.service.ts). It cannot be claimed by the
         * catalogue test below because it is not a file in the catalogue: its
         * path is the PROJECT's own directory, which is the whole of how a tab
         * for something that is not a file names what it is about. Without this
         * it would fall through to the loose row at the bottom of the tree,
         * announcing itself as a copy the reader went and opened by hand — the
         * exact confusion the merge of steps and documents exists to end.
         */
        if (row.tab?.kind === 'book') {
          claimed.add(row.key);
          continue;
        }
        // A step already names this document. See the docblock: the merge is the
        // whole point, and drawing it again as a file is the confusion §6c is
        // about.
        if (catalogue.has(fold(row.path))) {
          claimed.add(row.key);
          continue;
        }
        /*
         * IT SAYS WHAT MAKES IT DIFFERENT, which is that the project does not
         * claim it. Its tab is titled after the book, and under a root already
         * reading the book's name that would be a row saying nothing at all. The
         * old answer was the filename, which is the one thing this list is not
         * allowed to fall back to; the honest answer is that this is a copy the
         * reader went and opened themselves, with the path one hover away.
         */
        const said = row.tab === null ? row.title : typeLabel(row.tab.kind);
        extras.push({
          ...row,
          title: qualify(said, null, 'a copy you opened'),
          depth: 1,
          dir: project.dir,
        });
        claimed.add(row.key);
      }

      // ── The tree itself, root first ──────────────────────────────────────
      const rootKey = `${project.key}:root`;
      const rootKids = origin === null
        ? stranded
        : [...kids.get(origin.id) ?? [], ...stranded];
      const rootHasChildren = rootKids.length + terminals.length + extras.length > 0;
      const rootOpen = !collapsed.has(rootKey);
      const rows: Row[] = [{
        ...blank,
        key: rootKey,
        kind: 'root',
        // The project's directory, because Show in file manager on a book means
        // the book's folder — and because the root names a book, not a file.
        path: project.dir,
        title: project.title,
        glyph: origin === null ? '▦' : glyphForPayload(origin.payload),
        tally: origin === null ? null : whenOn(origin.createdAt),
        tooltip: this.rootTitle(project, origin, problem),
        depth: 0,
        dir: project.dir,
        step: origin,
        current: origin !== null && origin.id === standing,
        stale: origin?.stale === true,
        expanded: rootHasChildren ? rootOpen : null,
      }];

      if (rootOpen) {
        const walk = (step: LedgerStep, depth: number): void => {
          const under = kids.get(step.id) ?? [];
          const key = `${project.key}:step:${step.id}`;
          const shown = !collapsed.has(key);
          rows.push({
            ...blank,
            key,
            kind: 'step',
            path: project.dir,
            // THE READING IS "THE BOOK" AND NOT ITS LABEL, because that is what
            // the row IS: the flowing document you read, curate and translate.
            // Everything else says what main wrote when the step was made.
            title: step.action === 'read' ? 'Book' : step.label,
            glyph: glyphForStep(step),
            tally: whenOn(step.createdAt),
            tooltip: stepTitle(step, standing),
            depth,
            dir: project.dir,
            step,
            current: step.id === standing,
            stale: step.stale === true,
            expanded: under.length === 0 ? null : shown,
          });
          if (shown) for (const kid of under) walk(kid, depth + 1);
        };
        for (const step of rootKids) walk(step, 1);
        rows.push(...terminals, ...extras);
      }

      out.push({
        key: project.key,
        title: project.title,
        dir: project.dir,
        rows,
        /*
         * EVERY TAB IN THE BOOK, AND NOT EVERY TAB IN THE ROWS. The tree draws
         * fewer rows than the project has open documents — the scan and the
         * Book are steps now — so a close-the-book that walked the drawn rows
         * would leave open exactly the two tabs the reader most wanted shut.
         * This is also what keeps the loose list from picking them up.
         */
        tabIds: mine.map((row) => row.tab?.id).filter((id): id is string => id !== undefined),
      });
    }
    return out;
  });

  /**
   * Everything open that no book claimed — a file opened from anywhere else.
   *
   * BY TAB AND NOT ONLY BY KEY. A tree row carries a key of its own and most of
   * a book's tabs are not drawn as rows at all, so the tab ids a group holds are
   * the only complete account of what it has spoken for.
   */
  protected readonly loose = computed<Row[]>(() => {
    const groups = this.groups();
    const keys = new Set(groups.flatMap((group) => group.rows.map((row) => row.key)));
    const taken = new Set(groups.flatMap((group) => group.tabIds));
    return this.rows().filter((row) => !keys.has(row.key)
      && !(row.tab !== null && taken.has(row.tab.id)));
  });

  /**
   * A document is not a route. The router still owns Settings, so clicking a row
   * from the settings screen navigates back to the workspace first — the
   * document is what a row means, and it cannot be shown on a page that is not
   * showing documents.
   */
  protected pick(tab: Tab): void {
    void this.router.navigateByUrl('/');
    this.tabs.reveal(tab.id, true);
  }

  /**
   * A click on any kind of row.
   *
   * A STEP MOVES THE POSITION and everything else follows: main resolves what
   * that step shows and the panes are told (`ledger:go` → `showPosition`). It
   * costs nothing, asks nothing and throws nothing away — the promise every
   * history panel makes by looking like one, now made by the navigator itself.
   *
   * A FILE ROW puts a document in front of you: revealing it if it is open,
   * opening it if it is not, and doing nothing at all for a file this app has no
   * tab for. The first two are deliberately the same gesture — from the user's
   * side both rows say "put this in front of me", and whether that costs a tab
   * or merely a focus change is bookkeeping, not their question.
   *
   * ── AND IT REPLACES WHAT THE COLUMN WAS SHOWING ─────────────────────────────
   *
   * *"clicking another file will automatically close the one i was looking at and
   * open the one i just clicked, unless i pin the file by right-clicking the
   * chrome-style tab at the top."* This panel is the list that ruling is about,
   * so the `replace` flag is passed HERE and nowhere else. A drop, a finished job
   * and a step's own document all join the strip instead, because none of them is
   * a person saying "that one instead of this one".
   */
  protected pickRow(row: Row): void {
    if (row.kind === 'root' || row.kind === 'step') {
      void this.stand(row);
      return;
    }
    if (row.tab !== null) {
      this.pick(row.tab);
      return;
    }
    if (row.openable !== true) {
      /*
       * A ROW THIS APP HAS NO TAB FOR STILL ANSWERS THE CLICK. An EPUB or txt
       * export used to eat the press — no viewer, so nothing happened — and a
       * person who just exported clicked it expecting to be taken to the file
       * (user report, 2026-08-16). "Put this in front of me" for a finished
       * file with no tab means the file manager: the same reveal the context
       * menu offers, promoted to the click, because a dead left-click teaches
       * people the row is furniture.
       */
      if (row.kind === 'export') {
        /*
         * The click model is the user's (2026-08-16): an exported BOOK opens in
         * a tab — the proof sheet locked to the Final version over the file
         * itself — and Ctrl+S there saves a copy. Plain text still reveals: it
         * has no book inside it to show.
         */
        if (row.path.toLowerCase().endsWith('.epub')) {
          this.tabs.openExportView(row.path, row.title);
        } else {
          void api?.reveal(row.path);
        }
      }
      return;
    }
    void this.router.navigateByUrl('/');
    void this.tabs.openFromList(row.path, row.managed === true);
  }

  /**
   * Stand on the step this row names — the gesture that used to live on a Steps
   * row in the inspector (docs/WORKBENCH.md §6c: the section moved here whole).
   *
   * FREE, INSTANT AND UNCONFIRMED — one line of the manifest, no job, no
   * rendering, no question asked.
   *
   * The row already being current is not a no-op worth guarding: main answers
   * with the same ledger and the panel repaints to the same thing, and a click
   * that did nothing is cheaper than a branch that has to be kept true.
   */
  private async stand(row: Row): Promise<void> {
    if (row.dir === null || row.step === null) return;
    // A position is a thing to LOOK at, so the workspace has to be on screen for
    // it to mean anything — the same reason a document row navigates.
    void this.router.navigateByUrl('/');
    try {
      await this.ledger.go(row.dir, row.step.id);
    } catch (err) {
      // Main's words. It refuses an id this project does not hold, which means
      // the two sides are looking at different ledgers — not something to smooth
      // over.
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Fold a node shut, or open it. The click must not also stand on the row. */
  protected toggle(event: MouseEvent, row: Row): void {
    event.stopPropagation();
    this.collapsed.update((shut) => {
      const next = new Set(shut);
      if (!next.delete(row.key)) next.add(row.key);
      return next;
    });
  }

  /**
   * Close every tab this book has open. Nothing on disk.
   *
   * *"Right-click the import root → Close project."* Through the ORDINARY close,
   * one tab at a time, so a document holding uncommitted work still gets its one
   * question and a "keep" leaves it where it was. With the last of them gone the
   * book leaves the library and the workspace shows its empty state — home.
   *
   * A COPY OF THE LIST FIRST, because closing mutates the very group this is
   * iterating: `groups()` is a computed over the tabs, so reading it inside the
   * loop would be reading a list that is being emptied underneath.
   */
  protected closeProject(group: Group): void {
    for (const id of [...group.tabIds]) void this.tabs.close(id);
  }

  /**
   * The visible door onto that — the ✕ that appears on a root row under the
   * pointer. Same gesture as the right-click's Close book, and deliberately the
   * same CALL: it goes through the menu's own dispatch rather than looking a
   * group up for itself, because finding the book from a root row is the part
   * that can quietly be got wrong (the row's path is the project's directory,
   * matched case-folded), and a second copy of that is a second thing to keep
   * true. `fromMenu` closing a menu that is not open costs a signal write.
   *
   * `stopPropagation` because the click would otherwise land on the row as well
   * and stand the project on its import — moving the position of a book on its
   * way out of the library.
   */
  protected closeBook(event: MouseEvent, row: Row): void {
    event.stopPropagation();
    this.fromMenu(row, 'close-project');
  }

  /**
   * Delete the document this row names — the file, its catalogue row, and its
   * project if it turns out to be the original.
   *
   * Every branch of that is main's to decide and the modal's to ask; this hands
   * over a path and says whatever comes back.
   */
  protected async remove(event: MouseEvent, row: Row): Promise<void> {
    // Without this the click also lands on the row and opens the document that
    // is about to be deleted.
    event.stopPropagation();
    try {
      const said = await this.projects.removeDocument(row.path, () => {
        /*
         * CLOSED AFTER THE QUESTION AND BEFORE THE DELETE, which is why it is a
         * callback rather than two lines around the call. Closing first would
         * shut a document the user is about to decline to delete; closing after
         * would mean unlinking a file this window still has open — on Windows
         * the working copy is locked and the delete fails halfway. Main cannot
         * do it: tabs are the renderer's, and main's own reader is only told
         * about EPUBs.
         */
        // Without asking: see `TabsService.close`. The delete's own card is the
        // question, and it has already been answered yes. RETURNED rather than
        // voided, so the delete waits for this window to let go of the file.
        if (row.tab === null) return undefined;
        return this.tabs.close(row.tab.id, false);
      });
      if (said !== null) this.tabs.notice.set(said);
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * "Open in split" — stand on that step, and put what it shows in a column of
   * its own beside what is already there. Moved here from the inspector's Steps
   * section with its reasoning intact (docs/WORKBENCH.md §6c).
   *
   * ── Two acts that have to arrive as one ─────────────────────────────────────
   *
   * WHAT A STEP SHOWS IS NOT KNOWN HERE. Main resolves it (`ledger:document-at`)
   * and only for the position the project is standing ON, so there is no way to
   * ask "what would that row show" without moving there first. So the intention
   * is left with `TabsService` before the pointer moves, and the answer — which
   * arrives asynchronously, inside the effect that watches the position — picks
   * it up and opens into a new column instead of into the one in front.
   *
   * THE ROW ALREADY BEING CURRENT IS THE CASE THAT NEEDS SAYING. `go` on the
   * position you are on produces the same ledger and the same picture, so nothing
   * moves and nothing would ever consume that intention — the menu would appear
   * to do nothing and then split the NEXT step somebody clicked. So that row asks
   * the service to do it outright, and the flag is dropped rather than left lying
   * for a move it was not set for.
   */
  private async openInSplit(row: Row): Promise<void> {
    if (row.dir === null || row.step === null) return;
    if (row.current) {
      await this.tabs.splitAtPosition(row.dir);
      return;
    }
    this.tabs.splitNextIn(row.dir);
    try {
      await this.ledger.go(row.dir, row.step.id);
    } catch (err) {
      this.tabs.forgetSplitIn(row.dir);
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Delete this step. Main says what it costs, the app's own card asks, main
   * does it. Moved here from the inspector's Steps ✕ (docs/WORKBENCH.md §6c),
   * where it was a button on the row; it is behind the right-click now because a
   * step row wears no ✕ — the visible ✕ in this panel closes or deletes a FILE,
   * and one glyph meaning "and everything made from this" as well would be the
   * most expensive ambiguity in the panel.
   *
   * Never offered on the root: deleting the import is deleting the book, and
   * main refuses it by name anyway. A cancel is silence; a refusal is main's
   * sentence, as written.
   */
  private async discard(row: Row): Promise<void> {
    if (row.dir === null || row.step === null) return;
    try {
      /*
       * THE BOOKS THIS IS ABOUT TO ERASE ARE CLOSED FIRST, between the confirm
       * and the delete — the document delete's shape and its reason. Main
       * refuses to unlink a working tree this window is still reading (it cannot
       * be done on Windows and would leave half an unpacked book behind), so
       * without this, deleting a translation whose book is open would meet a
       * refusal one line after the user said yes. Main cannot do it: tabs are
       * the renderer's.
       */
      await this.ledger.remove(row.dir, row.step.id, (files) => this.tabs.closeShowing(files));
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Right-click: whatever this kind of row can be asked to do. */
  protected onMenu(event: MouseEvent, row: Row): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ row, x: event.clientX, y: event.clientY });
  }

  protected fromMenu(row: Row, action: MenuAction): void {
    this.menu.set(null);
    switch (action) {
      case 'reveal':
        void api?.reveal(row.path);
        return;
      case 'save-copy':
        void api?.saveExport(row.path).catch((err: unknown) => {
          this.tabs.notice.set(err instanceof Error ? err.message : String(err));
        });
        return;
      case 'view':
        this.tabs.openExportView(row.path, row.title);
        return;
      case 'close':
        if (row.tab !== null) void this.tabs.close(row.tab.id);
        return;
      case 'close-project': {
        const group = this.groups().find((one) => fold(one.dir) === fold(row.path));
        if (group !== undefined) this.closeProject(group);
        return;
      }
      case 'split':
        void this.openInSplit(row);
        return;
      case 'discard':
        void this.discard(row);
        return;
      case 'delete':
        void this.remove(new MouseEvent('click'), row);
    }
  }

  protected close(event: MouseEvent, tab: Tab | null): void {
    if (tab === null) return;
    // Without this the click also lands on the row and reveals what is about to
    // be closed, which flashes the document on screen for one frame.
    event.stopPropagation();
    void this.tabs.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
  protected onAux(event: MouseEvent, tab: Tab | null): void {
    if (tab === null || event.button !== 1) return;
    event.preventDefault();
    void this.tabs.close(tab.id);
  }

  // ── Dragging a row ───────────────────────────────────────────────────────

  protected onDragStart(event: DragEvent, tab: Tab | null): void {
    // A step row has no tab to carry, and the workspace's drop handler is
    // written against a tab id. Standing on the step is what puts it on screen.
    if (tab === null) {
      event.preventDefault();
      return;
    }
    // The id travels in a type of our own. Nothing else in the app reads it,
    // and the window-wide file drop looks for `Files` — so the two kinds of
    // drag over this window can never be confused for one another.
    event.dataTransfer?.setData(DOCUMENT_MIME, tab.id);
    // `text/plain` as well, because a drag with no standard type is refused
    // outright by some platforms before a drop can happen at all.
    event.dataTransfer?.setData('text/plain', tab.title);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    // The workspace shields its panes while this is on: a rendered chapter is an
    // <iframe>, and a drag over one is delivered to the frame rather than to the
    // pane the user is aiming at. See TabsService.draggingDocument.
    this.tabs.draggingDocument.set(true);
  }

  protected onDragEnd(): void {
    this.before.set(null);
    this.landing.set(false);
    this.tabs.draggingDocument.set(false);
  }

  /**
   * Over a row: the drop lands before it or after it, by which half the pointer
   * is in — the rule every list of this shape uses, and the only one that lets a
   * row be put at the very end of a list that fills the panel.
   */
  protected onRowOver(event: DragEvent, row: Row): void {
    if (!this.carriesDocument(event)) return;
    event.preventDefault();
    event.stopPropagation();
    /*
     * A ROW INSIDE A BOOK IS NOT AN INSERTION POINT. Its order is the ledger's
     * and the catalogue's, so a line drawn above it would promise a move the
     * redraw undoes a frame later. `none` rather than `move` says so with the
     * cursor, before the drop — the refusal in `onDrop` is the sentence for
     * somebody who tried anyway.
     */
    if (row.dir !== null) {
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
      this.before.set(null);
      this.landing.set(false);
      return;
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const target = this.landingFor(event, row);
    this.before.set(target);
    this.landing.set(target === null);
  }

  protected onListOver(event: DragEvent): void {
    if (!this.carriesDocument(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.before.set(null);
    this.landing.set(true);
  }

  protected onLeave(): void {
    this.before.set(null);
    this.landing.set(false);
  }

  /**
   * A drop inside the list is a reorder.
   *
   * AN EDITOR CANNOT BE REORDERED, and the refusal is said rather than swallowed:
   * its row is drawn under the book it belongs to whatever the flat list says, so
   * moving it would change a number nobody can see and leave the row exactly
   * where it was — a gesture that appears to work and does not.
   *
   * A DOCUMENT IN A BOOK CANNOT EITHER, and for the same reason one step out.
   * Its position is the ledger's and the catalogue's, and that order is redrawn
   * from the project on every change, so a reorder would be undone before the
   * pointer was lifted. The gesture that IS available is the one that goes
   * somewhere else: dragging it onto the workspace still puts it in a column,
   * because the workspace reads the same drag and nothing here refuses that half.
   */
  protected onDrop(event: DragEvent, row: Row | null): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Where it lands was worked out on the way in, and is READ BEFORE the drag
    // state is cleared — clearing first would drop every row at the end of the
    // list and quietly undo the insertion point the user was just shown.
    const target = this.before() ?? (row === null || row.dir !== null ? null : this.landingFor(event, row));
    const onto = row;
    this.onDragEnd();
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const moving = this.tabs.byId(id);
    if (moving === null) return;
    if ((onto !== null && onto.dir !== null) || this.inBook(moving.id)) {
      this.tabs.notice.set(
        'Documents in a book are listed in the order it holds them, so they cannot be reordered '
        + 'here. Drag one onto a column to open it there.',
      );
      return;
    }
    // No navigation: a reorder is bookkeeping about the list, not a request to
    // look at something, so it leaves a person on Settings where they were.
    this.tabs.reorder(id, target);
  }

  /** Is this open tab one of a book's, rather than a loose file? */
  private inBook(id: string): boolean {
    return this.groups().some((group) => group.tabIds.includes(id));
  }

  /**
   * Which row a drop over this one lands in front of — by the half the pointer
   * is in, over the LOOSE list.
   *
   * The loose rows are the only ones a reorder can touch (see `onDrop`), so they
   * are the only ones this has to index into: a drop over a book's row is
   * refused before it gets here.
   */
  private landingFor(event: DragEvent, row: Row): string | null {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (event.clientY <= box.top + box.height / 2) return row.key;
    const list = this.loose();
    const at = list.findIndex((other) => other.key === row.key);
    return list[at + 1]?.key ?? null;
  }

  /**
   * Whether this drag is one of ours.
   *
   * `types` is readable during a drag; the DATA is not, by design, which is why
   * the id can only be read on drop. A file drag has `Files` here and is left
   * alone for the window's own handler to open.
   */
  private carriesDocument(event: DragEvent): boolean {
    return event.dataTransfer?.types.includes(DOCUMENT_MIME) === true;
  }

  /**
   * What the root says on hover: the book, where it lives, and the one gesture
   * that is only in the menu.
   *
   * MAIN'S REFUSAL RIDES HERE when the ledger will not parse. It used to be
   * printed where the Steps rows would have been; with that section gone the
   * inspector's standing strip says it in full, and this is the second place the
   * same sentence reaches the same person — beside the book it is about, rather
   * than only beside whatever document happens to be focused.
   */
  private rootTitle(project: ProjectSummary, origin: LedgerStep | null, problem: string | null): string {
    const lines = [project.title, project.dir];
    if (problem !== null) lines.push(problem);
    else if (origin === null) lines.push('Reading this book’s history…');
    else lines.push('Click to stand on the original — everything else was made from it.');
    lines.push('Right-click to close this book.');
    return lines.join('\n');
  }

  /**
   * What a file row says when you rest on it — the whole of what a document's
   * flags mean, in the one place there is room to spell it out.
   *
   * THE FILE IS STILL HERE, and that is deliberate rather than a leftover:
   * "which copy is this, actually" is a real question, asked rarely, and a hover
   * is the right price for a rare question. It is one of exactly two places in
   * this app where a path is still shown to a person; the other is the OS save
   * dialog, where the thing being named really is a file.
   */
  protected tooltip(tab: Tab): string {
    const lines = [tab.path];
    if (tab.savedPath !== null) lines.push(`Saved to ${tab.savedPath}`);
    if (tab.unsaved) lines.push("In Foundry's library workspace only — Ctrl+S files it somewhere.");
    if (tab.modified) lines.push('Edited since that copy was written — Ctrl+S brings it up to date.');
    return lines.join('\n');
  }
}

/** What a right-click can offer, across the four kinds of row. */
type MenuAction = 'reveal' | 'save-copy' | 'view' | 'close' | 'delete' | 'close-project' | 'split' | 'discard';

/**
 * One drawn line of the library.
 *
 * FOUR KINDS, ONE SHAPE. A `root` and a `step` are POSITIONS — clicking one
 * moves where the book stands — and carry a `step`; an `export` and a
 * `document` are FILES and carry a tab when something has opened them. The
 * template draws them all and the gestures fork on `kind`, which is the one
 * fact that decides everything else about a row.
 */
interface Row {
  /** Unique in the list: a tab id, or the book's key and what the row names. */
  key: string;
  kind: RowKind;
  /** The open tab, for the rows that are files. Always null on a position. */
  tab: Tab | null;
  /** A file for the rows that are files; the book's own directory for a position. */
  path: string;
  title: string;
  glyph: string;
  tooltip: string;
  /** How far in the tree. 0 for a root and for a loose file. */
  depth: number;
  /** The book this row belongs to. Null for a loose file, and only for that. */
  dir: string | null;
  /** The step a root or a step row names, when the history has arrived. */
  step: LedgerStep | null;
  /** The date on the right, for a row that is a moment in a book's history. */
  tally: string | null;
  /** True on the one row the book is standing on. */
  current: boolean;
  /** True for a step made from something that has been replaced since. */
  stale: boolean;
  /** Null when the row can never have children; otherwise whether it is open. */
  expanded: boolean | null;
  /** File rows only: false for a missing file and for `.txt`. */
  openable?: boolean;
  /** File rows only: whether the tab it opens wears the unsaved dot. */
  managed?: boolean;
  /** 1…5 while it is on screen, counted left to right. Null when it is not. */
  column: number | null;
  /** True when that column is the focused one. */
  focused: boolean;
}

type RowKind = 'root' | 'step' | 'export' | 'document';

/**
 * The fields every row has and most rows do not set.
 *
 * ONE DEFAULT AND NOT FOUR LITERALS: a row is built in five places here, and
 * without this each of them would have to remember to say `stale: false` — which
 * they would, until somebody added a field, and then exactly one of them would
 * be missing it and exactly one kind of row would draw wrong.
 */
const blank = {
  tab: null,
  step: null,
  tally: null,
  depth: 0,
  dir: null,
  current: false,
  stale: false,
  expanded: null,
  column: null,
  focused: false,
} satisfies Partial<Row>;

/** One book, and the tree drawn for it. */
interface Group {
  key: string;
  title: string;
  dir: string;
  rows: Row[];
  /** Every tab open inside this book — what Close book closes. */
  tabIds: string[];
}

function glyphFor(tab: Tab): string {
  // The book wears the reading's own mark, because the book IS the reading — the
  // same glyph `glyphForStep` gives the row that opens it, one line above it in
  // this tree.
  return tab.kind === 'book' ? '▤' : '▦';
}

/**
 * Is this open document inside this project — or IS it this project?
 *
 * THE SECOND HALF IS THE BOOK TAB, and it is the one tab in this app whose path
 * is a directory rather than a file (`TabKind`, core/tabs.service.ts). Every
 * other row here is a file somewhere under the project, so the prefix test with
 * the separator appended is the whole rule — and the separator is what stops
 * `Kershaw-a1b2c3d4` from claiming the documents of `Kershaw-a1b2c3d4-notes`
 * sitting beside it, which is why it cannot simply be dropped.
 */
function inProject(filePath: string, dir: string): boolean {
  const root = fold(dir);
  const target = fold(filePath);
  return target === root || target.startsWith(`${root}/`);
}

/**
 * The root's glyph, from the import's own payload.
 *
 * BY EXTENSION AND NOT BY NAME. The house rule forbids matching a basename
 * across directories; reading the last few characters of `archive/Book.pdf` to
 * decide between two shapes is not matching anything, and it is the only fact
 * about the original this panel needs.
 */
function glyphForPayload(payload: string): string {
  const dot = payload.lastIndexOf('.');
  const ext = dot < 0 ? '' : payload.slice(dot + 1).toLowerCase();
  return ext === 'epub' ? '▤' : ext === 'txt' ? '≡' : '▦';
}

/**
 * What a step LOOKS like in the tree — the action, at a glance.
 *
 * The reading wears the book's own mark because the reading IS the book; a save
 * wears the pencil the app uses everywhere for "edited"; a translation wears the
 * two ways it goes; a metadata edit wears the mark of a note about a thing rather
 * than a change to it, which is what a record of the title is. Nothing here is
 * load-bearing: the name beside it says the same thing in words, and the glyph is
 * what makes a tree of twenty rows scannable.
 */
function glyphForStep(step: LedgerStep): string {
  if (step.action === 'read') return '▤';
  if (step.action === 'curate') return '✎';
  if (step.action === 'translate') return '⇄';
  if (step.action === 'metadata') return 'ⓘ';
  return '▦';
}

/**
 * What a step row says on hover — including the STALE REASON, which is the whole
 * of why a dimmed row is dimmed.
 *
 * A step goes stale when something it was made from was replaced under it: the
 * blocks a curation named by `(page, order)` mean different blocks after a
 * re-read, and a translation of those blocks was a translation of paragraphs
 * that have moved. It is a display state and not a deletion — the payload is
 * still a true record of what was made, so the row still opens and still
 * renders. Saying that on hover is what keeps a dimmed row from reading as a
 * broken one.
 */
function stepTitle(step: LedgerStep, standing: string | null): string {
  const full = new Date(step.createdAt).toLocaleString();
  if (step.stale === true) {
    return `${step.label} — ${full}. What this was made from has been replaced since, so it `
      + 'describes an earlier pass over the pages. It still opens, exactly as it was recorded.';
  }
  if (step.id === standing) {
    return `${step.label} — ${full}. You are standing here: this is what the panes show and `
      + 'what the next thing you do is made from.';
  }
  return `${step.label} — ${full}. Click to stand here. Nothing after it is thrown away.`;
}

/**
 * What an export IS, in the words the export modal offered it in.
 *
 * THE PRODUCT AND NOT THE FORMAT, and certainly not the file: somebody chose
 * "Facsimile PDF" in a dialog and the row that turns up afterwards has to be
 * recognisably the thing they chose. A `pdf` under `final/` is never anything
 * else in this app — a real-text reprint is a `generated/` rendering and a step's
 * document, not an export — so the word is not a guess.
 *
 * AND IT IS THE ONLY PLACE IN THIS PANEL THE WORD "EPUB" APPEARS. The working
 * document is the Book; EPUB means finished (docs/WORKBENCH.md §6c, Naming).
 */
function exportLabel(kind: ProjectDocumentKind): string {
  if (kind === 'epub') return 'EPUB';
  if (kind === 'txt') return 'Plain text';
  return 'Facsimile PDF';
}

/**
 * WHEN, in as few characters as a row can spare — the Steps section's rule, for
 * the Steps section's reason, now applied to every row in the tree.
 *
 * The year is dropped for anything from this one, which is nearly everything
 * anybody looks at, and kept for the rest: two rows both reading "14 Aug" would
 * be this panel quietly claiming they happened together.
 */
function whenOn(at: number): string {
  const on = new Date(at);
  const sameYear = on.getFullYear() === new Date().getFullYear();
  return on.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A project-relative path against its project, in the project's own separator.
 *
 * Main sends `final/<name>.epub` with forward slashes whatever the platform, and
 * a Windows path spelled half one way and half the other opens perfectly well
 * and reads like a bug in the one place it is shown — the tooltip. So the joined
 * halves are made to agree rather than left to.
 */
function joinIn(dir: string, relative: string): string {
  return dir.includes('\\')
    ? `${dir.replace(/[\\/]+$/, '')}\\${relative.replace(/\//g, '\\')}`
    : `${dir.replace(/\/+$/, '')}/${relative}`;
}

/** One spelling for a path, so Windows' three become one. */
function fold(target: string): string {
  return target.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * Ours, so a document drag and a file drag can never be mistaken for each other.
 *
 * The same type the tab strips used, kept deliberately: the workspace reads it
 * on the other end of the same gesture, and App's file-drop veil is written
 * against the fact that our drags do not carry `Files`.
 */
export const DOCUMENT_MIME = 'application/x-foundry-tab';
