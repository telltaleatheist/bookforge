import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { typeLabel } from '@shared/documents';
import { CHAINABLE_FROM, PRODUCES_OF, exportNodeId, exportOfNodeId } from '@shared/host-ops';
/*
 * WHAT IS POSSIBLE FROM A STAGE — one function per act, shared with the dock's
 * buttons and with the dialogs' own refusals (shared/stages.ts). The footer is
 * drawn by the same tests the acts refuse by, which is Owen's ruling made
 * structural rather than repeated.
 */
import {
  canExportFrom, canReadPages, canSimplifyFrom, canTranslateFrom,
} from '@shared/stages';
import type { HostNodeAction } from '@shared/host-ops';
import { languageNameFor } from '@shared/languages';
import type {
  HostNode,
  HostNodeProgress,
  LedgerParams,
  LedgerStep,
  NodeOutput,
  ProjectDocumentKind,
  ProjectSummary,
} from '@shared/types';

import { api } from '../../core/foundry';
import { HostOpsService } from '../../core/host-ops.service';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { OpenDocumentsService, type Tab } from '../../core/documents.service';
import { NoticeService } from '../../core/notice.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { ToolRailComponent } from '../tool-rail/tool-rail.component';

/**
 * The LIBRARY, down the left — one provenance tree per open book, and since the
 * pipeline redesign the place a book's next act is ordered from.
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
 * shared/types.ts says out loud that the flat chronological list was that tree
 * with the indentation taken off. The flattening was the right call for a 260px
 * accordion that had to say "what have I done to this book" in one column; it is
 * the wrong call for a navigator, because the one question a navigator has to
 * answer is "what was this made FROM" — which is exactly the fact the flattening
 * threw away. So: the import is the root, the reading hangs under it, curation
 * saves hang under the reading, and a translation is a new book that nests and
 * grows saves of its own.
 *
 * NOTHING IS RE-DERIVED FROM A FILE HERE. The parent chain is the ledger's own
 * (`LedgerService.historyFor`); the exports are `listProjects`' own; the facts
 * are the ones main wrote when the step was made. This component owns the
 * DRAWING and nothing else about the shape.
 *
 * ══ THE REDESIGN (2026-08-17): CARDS ON A DRAWN SPINE ════════════════════════
 *
 * *"not intuitive or descriptive enough"* — the user, about the indented row
 * list this used to be, in the ruling that turned this panel into the PIPELINE
 * COMPOSER. Three things changed and none of them is the click model.
 *
 * 1. GEOMETRY. A row was `[arrow][glyph][name][date]` at `10 + depth × 14`
 *    pixels of padding, and the indentation was the only thing saying what came
 *    from what — a relationship the eye has to reconstruct by comparing left
 *    edges four rows apart. Now every node is a CARD to the right of a state dot
 *    sitting on a drawn lineage line: the line is the ancestry, the dot is the
 *    state, the card is the thing. Branches curve off the parent's line with a
 *    rounded elbow into a lane of their own.
 *
 * 2. LANGUAGE. A row said "Translated (de)" because that is the label main
 *    stamped on the step. A card says "Translated into German" and, underneath,
 *    "from **Applied changes**" — the same two facts a person actually asks for,
 *    in a sentence rather than in a notation. THE STORED LABEL IS UNTOUCHED:
 *    `LedgerStep.label` is the record of what this app called the act when it
 *    happened and rewriting somebody's history to tidy our own naming is exactly
 *    what `labelFor` refuses to do. These sentences are DERIVED, from the action
 *    and the params the step already carries, and the stored label is still what
 *    the tooltip says.
 *
 * 3. THE SPINE GOES DASHED PAST WHAT EXISTS. Solid line, filled dot: this
 *    happened. Dashed line, hollow dot: this is the plan. That grammar is what
 *    makes a queued act drawable at all — and a queued act is drawable because a
 *    host can now contribute one (below).
 *
 * WHAT DID NOT CHANGE, and must not: a click on a node MOVES THE POSITION and is
 * not a tab; exports are terminal children of the root at the Book's own indent;
 * a step row wears no ✕; the group is one book and the first row is its import;
 * the collapse is a session and not a setting. The redesign changes geometry and
 * language, not what a gesture means.
 *
 * ── The "from here" footer, which is the second door onto the dock's acts ────
 *
 * A selected card grows a footer offering the acts applicable FROM THAT NODE:
 * Translate, Simplify, Export — the same dialogs the dock opens, opened the same
 * way, after standing on the node the footer belongs to. The dock stays exactly
 * where it is. This is not a second implementation of those acts and must never
 * become one: every button here calls the same `UiService` opener the dock's
 * button calls, and the aiming is what it has always been — the dialogs act on
 * the POSITION, so standing first is the whole of "aimed at this node".
 *
 * WHY A FOOTER RATHER THAN A MENU. The right-click menu is still there and still
 * carries the destructive acts (delete, reveal). What the
 * footer carries is the MAKING acts, and those are the ones a person has to be
 * able to SEE from the node they are standing on — a right-click is a gesture
 * with nothing on screen to suggest it, which is the same argument that put a ✕
 * on the root when Close book was menu-only.
 *
 * ── AND THE HOST'S OWN WORK, WHEN THERE IS A HOST ───────────────────────────
 *
 * Hosted, BookForge contributes operations (Narrate, Enhance, Assemble) and
 * pushes NODES for the work it is doing (electron/host-ops.ts, shared/host-ops.ts
 * — the whole design lives there). This panel draws those nodes as children of
 * the ledger step they were ordered from, in the same card grammar, with the
 * host's own words: a queued one is a dashed card, a running one carries a live
 * bar, a failed one wears the error colour and the host's sentence.
 *
 * THEY ARE NOT STEPS AND THIS FILE MUST NOT TREAT THEM AS ANY. A host node has
 * no `LedgerStep`, so it cannot be stood on, split, deleted or dragged; what it
 * CAN be is selected, and its footer offers the host's acts that apply to what
 * it produces — even while it is queued, which is the point: *"they can chain the
 * next op onto a pending node's future output"*. Standalone, no operations are
 * registered and no nodes are ever pushed, so every one of these branches is
 * dead code that costs one empty array.
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
 * because that is the pair of facts that tells two of them apart. A terminal card
 * says so in words under its title — nothing is made from it — and it is the one
 * card with no lineage line under its name, because the tray does not record
 * which position an export was made at and this panel will not guess one.
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
 * rather than the step, which is the next section — no middle-click close and no
 * accent bar for "on screen".
 * A step is a POSITION — clicking it moves where the project stands and the
 * viewer follows — and the panel's statement about it is `.standing`, one card in
 * the tree drawn in the accent. Marking step cards as "this is what is on screen"
 * as well would put the second selector straight back: *"Tabs are windows onto
 * the selection, never a second selector"* (§6c). The rows that ARE tabs — exports,
 * HTML faces, copies, loose files — keep every one of those marks, because for
 * them the mark is the truth.
 *
 * SELECTED AND STANDING ARE TWO DIFFERENT FACTS and the redesign needs both.
 * Standing is where the BOOK is, one card per open book, and it is what the
 * panes show. Selected is the one card in the whole panel whose footer is open —
 * panel-wide, because two footers offering acts on two different books would be
 * two answers to "what happens if I press Translate". Clicking a node does both;
 * clicking a HOST node selects without standing, because there is no position to
 * move to.
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
 * card must never carry is a ✕ meaning "delete this step and everything made from
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
 * would promise a move the next redraw undoes. Step and host cards are not
 * draggable at all: there is no tab to carry.
 *
 * A DRAG OUT OF THIS LIST NO LONGER MEANS ANYTHING, and that is the single-viewer
 * ruling (docs/PLAN.md §4, unit 8b). A row dropped on the workspace used to land
 * in a column — the middle of a pane to show it there, an edge band to split one
 * off — and the workspace owned that half of the gesture, including the sheet of
 * glass it had to lay over every pane so that a drop could reach an <iframe> at
 * all. There is one viewer, so the only place a drop could land is the place a
 * CLICK already lands, and this list's click has always meant "put this in front
 * of me".
 *
 * Native HTML5 drag and drop, with the custom MIME kept for the reorder that
 * survives, and the window's own file-drop veil still tells the two apart by
 * looking for `Files` in the payload (see App). `dataTransfer.types` is the only
 * part of a drag readable before the drop, which is what that test is for and
 * why the id itself can only be read when the drop happens.
 */
@Component({
  selector: 'app-open-documents',
  imports: [NgTemplateOutlet, ToolRailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      PUT AWAY, THE PANEL IS A STUB AND NOT NOTHING. The button that collapses it
      has to be the button that brings it back, and it has to be in the same
      place — the top-left corner of the window — or collapsing the list is a
      gesture with no visible way out except a keyboard chord and a dock item
      nobody knows are there. Thirty pixels is the price.
    -->
    <!--
      ── THE SIDEBAR IS THE TREE AND THE TOOLS, IN THAT ORDER ────────────────
      *"lets move the nav rail buttons to the left side, pinned to the bottom of
      the tree sidebar. the tree can be pinned to the top, and if it extends past
      available space… the user can scroll down to see more of the tree."*
      (Owen, 2026-08-17 22:30.) The dock had a row of the window to itself along
      the bottom; it has this panel's foot instead, and the height it used to
      cost goes back to the page.

      THE DOCK IS OUTSIDE THE COLLAPSE BRANCH ON PURPOSE. Put away, this panel
      is a 30-pixel stub — and if the tools went away with the tree, collapsing
      the library would take Settings, Home and every other act off the screen
      with it. So the stub keeps them, icon-only, at the width it has.
    -->
    @if (!ui.documentsShown()) {
      <div class="stub">
        <button class="collapse" title="Show the library (Ctrl+B)" (click)="ui.toggleDocuments()">»</button>
      </div>
    } @else {
    <div class="panel">
      <!--
        THE ICONS, DEFINED ONCE AND USED BY REFERENCE.

        Stroke icons in a symbol sheet rather than the typographic glyphs this
        panel used to draw (▤ ▦ ✎ ⇄). Those were chosen when a row was twelve
        pixels of text and they were honest about it; in a card with a tinted
        square to put a mark in, a font glyph is whatever the platform happens to
        have — ⇄ is a different weight on every machine and ⓘ is a different SIZE
        — and the one thing a set of marks has to be is a set.

        INLINE AND NOT A FILE, because the renderer's CSP is "default-src 'self'"
        with no fetching of anything, and because an svg use against a symbol in
        the same document is the one form that costs no request at all. The ids
        carry an "ft-" prefix: they are global to the document, and hosted, this
        page is Foundry's own — but the habit is cheap and the collision is not.
      -->
      <svg class="sheet" aria-hidden="true" focusable="false">
        <defs>
          <symbol id="ft-check" viewBox="0 0 24 24">
            <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="3.4"
                  stroke-linecap="round" stroke-linejoin="round" />
          </symbol>
          <symbol id="ft-cross" viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="3.2"
                  stroke-linecap="round" />
          </symbol>
          <symbol id="ft-scan" viewBox="0 0 24 24">
            <path d="M7 3h8l4 4v14H7z M15 3v4h4 M10 12h6 M10 16h6" fill="none" stroke="currentColor"
                  stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
          </symbol>
          <symbol id="ft-book" viewBox="0 0 24 24">
            <path d="M4 4.5h6a2.5 2.5 0 012.5 2.5v13a2 2 0 00-2-2H4z M20 4.5h-6A2.5 2.5 0 0011.5 7v13a2 2 0 012-2H20z"
                  fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          </symbol>
          <symbol id="ft-pen" viewBox="0 0 24 24">
            <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z M14 6l3 3" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
          </symbol>
          <symbol id="ft-globe" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M3.5 12h17 M12 3.5c3 2.6 3 14.4 0 17 M12 3.5c-3 2.6-3 14.4 0 17" fill="none"
                  stroke="currentColor" stroke-width="1.6" />
          </symbol>
          <symbol id="ft-spark" viewBox="0 0 24 24">
            <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 15.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"
                  fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
          </symbol>
          <symbol id="ft-tag" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 11v6 M12 7.4v.2" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" />
          </symbol>
          <symbol id="ft-out" viewBox="0 0 24 24">
            <path d="M12 15V4 M8 8l4-4 4 4 M5 15v4h14v-4" fill="none" stroke="currentColor"
                  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </symbol>
          <symbol id="ft-page" viewBox="0 0 24 24">
            <path d="M6 3h8l4 4v14H6z M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linejoin="round" />
          </symbol>
          <symbol id="ft-mic" viewBox="0 0 24 24">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" />
            <path d="M5.5 11.5a6.5 6.5 0 0013 0 M12 18v3.5" fill="none" stroke="currentColor"
                  stroke-width="1.8" stroke-linecap="round" />
          </symbol>
          <symbol id="ft-wave" viewBox="0 0 24 24">
            <path d="M3 12h2.5 M8 5.5v13 M12 8.5v7 M16 4.5v15 M20.5 10v4" fill="none"
                  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </symbol>
          <symbol id="ft-disc" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8" />
            <circle cx="12" cy="12" r="2.6" fill="currentColor" />
          </symbol>
        </defs>
      </svg>

      <header class="head">
        <button class="collapse" title="Hide the library (Ctrl+B)" (click)="ui.toggleDocuments()">«</button>
        <!-- "Open documents" was the name of a list of files. This is the books
             themselves and everything that has been done to them, which is a
             library — and Final Cut's word for the same shelf, which is where
             the whole arrangement comes from (docs/WORKBENCH.md §6c). -->
        <span class="label">Library</span>
        <span class="count">{{ documents.tabs().length }}</span>
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
            unrelated cards. There is no header element any more: the first card
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
        ONE CARD TEMPLATE FOR ALL FIVE KINDS, because a step, a host's job, an
        export, an open file and a loose one are the same drawn card with
        different gestures behind it, and five copies of this markup would drift
        the first time a mark was added to one of them. What differs is carried
        on the row.
      -->
      <ng-template #line let-row>
        <div
          class="step"
          [class.node]="row.kind === 'root' || row.kind === 'step'"
          (click)="pickRow(row)"
          (auxclick)="onAux($event, row.tab)"
          (contextmenu)="onMenu($event, row)"
          [attr.draggable]="row.tab !== null"
          (dragstart)="onDragStart($event, row.tab)"
          (dragend)="onDragEnd()"
          (dragover)="onRowOver($event, row)"
          (drop)="onDrop($event, row)"
        >
          <!--
            THE ANCESTRY, ONE SLOT PER LEVEL. Each lane is the width of one
            indent and draws its ancestor's line where that ancestor still has
            something below it — which is what makes a deep branch legible: the
            line running past a translation's own saves is the BOOK's line, on
            its way down to the next thing made from the book.

            The elbow lives in the LAST lane, on the first card of an indented
            run, and curves out of the parent's line into this card's dot. Every
            sibling after it joins the lane's own vertical instead, which is why
            a branch reads as one lane rather than as a row of hooks.
          -->
          @for (lane of row.lanes; track $index) {
            <span class="lane">
              @if (lane.line) { <span class="thread" [class.dashed]="lane.dashed"></span> }
              @if (lane.elbow) { <span class="elbow" [class.dashed]="row.planned"></span> }
            </span>
          }

          <span class="rail">
            @if (row.up) { <span class="thread up" [class.dashed]="row.planned"></span> }
            <!--
              THE STATE DOT — the whole state grammar in eighteen pixels. Solid
              accent with a check: this exists. A ring with a pulsing core: it is
              happening. Hollow and dashed: it is the plan. Solid error with a
              cross: it was tried and it failed. The card repeats the same fact
              in words; the dot is what makes a column of ten of them scannable.
            -->
            <span [class]="'dot ' + row.dot">
              @if (row.dot === 'done') {
                <svg class="mark" aria-hidden="true"><use href="#ft-check" /></svg>
              } @else if (row.dot === 'failed') {
                <svg class="mark" aria-hidden="true"><use href="#ft-cross" /></svg>
              } @else if (row.dot === 'source') {
                <svg class="mark" aria-hidden="true"><use [attr.href]="'#' + row.icon" /></svg>
              }
            </span>
            @if (row.down) { <span class="thread down" [class.dashed]="row.downDashed"></span> }
          </span>

          <div
            class="card"
            [class.root]="row.kind === 'root'"
            [class.standing]="row.current"
            [class.selected]="row.key === picked()"
            [class.stale]="row.stale"
            [class.inert]="row.tab === null && row.openable === false"
            [class.on]="row.focused"
            [class.available]="row.kind === 'export' && row.tab === null"
            [class.before]="before() === row.key"
            [class.pending]="row.dot === 'queued'"
            [class.running]="row.dot === 'running'"
            [class.failed]="row.dot === 'failed'"
            [title]="row.tooltip"
          >
            <div class="row1">
              <span class="kind" [class.text-op]="row.tint === 'text'" [class.audio-op]="row.tint === 'audio'">
                <svg aria-hidden="true"><use [attr.href]="'#' + row.icon" /></svg>
              </span>
              <div class="words">
                <div class="name">
                  {{ row.title }}
                  <!-- The one animation on a card, and it is only ever on audio
                       work that is actually running: three bars, because a
                       narration is the only thing in this app that takes an hour
                       and has nothing to show for itself until it is done. -->
                  @if (row.dot === 'running' && row.tint === 'audio') {
                    <span class="meter" aria-hidden="true"><i></i><i></i><i></i></span>
                  }
                </div>
                <!--
                  THE LINEAGE, IN WORDS. "from **Applied changes**" — the fact
                  the indentation used to imply and the eye had to reconstruct.
                  A card with nothing honest to claim (an export, whose position
                  the tray does not record; the import, which came from outside)
                  says what it IS instead, and never invents a parent.
                -->
                <div class="from">
                  @if (row.from !== null) {
                    @if (row.fact !== null) { <span>{{ row.fact }} · </span> }
                    <span>from </span><b>{{ row.from }}</b>
                  } @else if (row.said !== null) {
                    <span>{{ row.said }}</span>
                  }
                </div>
              </div>
              <!-- WHEN, or what the host says about it: the same slot, because
                   both answer "where is this up to". -->
              @if (row.state !== null) {
                <span class="state">{{ row.state }}</span>
              }
              <!--
                THE ARROW IS A SLOT EVEN WHEN THERE IS NO ARROW. A twist that
                appeared and disappeared would shift the ✕ beside it sideways
                depending on whether the book above had been translated. An
                export never gets one — it is terminal, and an arrow on it would
                promise something under it.
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
              <!--
                TWO marks, because they are two different things to fix. The dot
                is "this book is not in a folder of yours"; the pencil is "the
                copy that is in one is older than this". A card can wear both.
              -->
              @if (row.tab?.unsaved) {
                <span class="mark-dot" title="Not saved anywhere you chose">●</span>
              }
              @if (row.tab?.modified) {
                <span class="pencil" title="Edited since it was last saved">✎</span>
              }
              <!--
                A COLUMN BADGE USED TO SIT HERE — the number of the column this
                document was showing in, drawn only once two were open, because a
                badge that always says 1 is a badge that teaches people to stop
                reading it. There is one viewer now, so "which column" has no
                answer worth drawing; what remains is the accent bar (.on /
                .focused), which says the one thing a person still asks: is this
                the document I am looking at.
              -->
              <!--
                ONE GLYPH, THREE JOBS, AND EVERY ONE OF THEM SAID IN WORDS ON
                HOVER. The root's closes the BOOK; a file's inside a project
                DELETES it; a file's from outside one CLOSES it, because a file
                opened from elsewhere is not this app's to erase. Three meanings
                on one shape is only safe while the tooltip is what a person
                actually reads, so none of these buttons is ever drawn without
                one.

                NONE, ON A STEP OR ON A HOST'S OWN CARD. Deleting a step takes
                everything made from it and lives behind the right-click with
                main's accounting of the cost; a host's node is not this app's to
                cancel at all — the queue that owns it is somewhere else.
              -->
              @if (row.kind === 'root') {
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

            <!-- HOW FAR ALONG, in the host's own counting. Drawn only while the
                 host is counting: a bar sitting at zero for an hour says less
                 than the state word does. -->
            @if (row.progress !== null) {
              <div class="progress">
                <div class="pbar"><i [style.width.%]="row.progress.percent"></i></div>
                <div class="pmeta">
                  <span class="doing">{{ row.progress.message }}</span>
                  <span>{{ row.progress.eta }}</span>
                </div>
              </div>
            }
            <!-- A FAILURE GETS A LINE OF ITS OWN, because it is a sentence and
                 the state slot is a word. The words are the host's, verbatim. -->
            @if (row.why !== null) {
              <div class="why">{{ row.why }}</div>
            }

            <!--
              "FROM HERE" — the acts this node can be the start of.

              Inside the card and only on the selected one, which is the whole
              idea: the question a person is asking when they click a step is
              "what can I do from this", and the answer belongs where they asked
              it rather than on a dock — which, even now that the dock is at
              the foot of this same panel, says nothing about which node it
              would act on. The dock still works and
              still means the same thing; this is a second door onto the same
              acts, aimed by the same mechanism (the position) at the node whose
              footer it is.
            -->
            @if (row.key === picked() && acts().length > 0) {
              <div class="ops">
                <!--
                  "FROM HERE" IS TRUE OF A POSITION AND NOT OF AN EXPORT.
                  Owen: *"it shouldnt say 'from here' next to it. just make it
                  a button that can be pressed."* The label earns its place on a
                  step, where several acts are offered and the words say what
                  they have in common — things are made FROM that row. An export
                  row has ONE act, and a label introducing a list of one is
                  chrome explaining a button that explains itself.
                -->
                @if (row.kind === 'root' || row.kind === 'step') {
                  <span class="lbl">from here</span>
                }
                @for (act of acts(); track act.id) {
                  <button
                    class="op"
                    [class.audio-op]="act.audio"
                    [title]="act.hint"
                    (click)="run($event, row, act)"
                  >
                    <svg aria-hidden="true"><use [attr.href]="'#' + act.icon" /></svg>{{ act.label }}
                  </button>
                }
              </div>
            }

            <!--
              ── A FAILED CARD OFFERS THE WAY OUT INSTEAD ──────────────────────

              Owen's screenshot: a failed narrate still offering "from here:
              Enhance / Assemble" — acts that chain onto audio the run never
              produced — and no way to retry it or make it go away without
              leaving for the other application's window. \`acts()\` refuses
              the first half (\`CHAINABLE_FROM\`); this is the second.

              ALWAYS ON A FAILED CARD, not only on the selected one. The "from
              here" footer unrolls on selection because it is an OFFER and five
              open footers would be five sets of buttons aimed at five books;
              this is the exit from a state, and a person looking at a red card
              is already asking how to get rid of it. Hiding that behind a click
              would be one more gesture between somebody and the tidy-up.

              DRAWN ONLY WHERE SOMEBODY IS LISTENING — see \`canAct\`. A host
              that contributed operations without \`onNodeAction\` gets neither
              button rather than two that refuse.
            -->
            @if (canAct(row)) {
              <div class="ops recovery">
                <button class="op" title="Run this again" (click)="act($event, row, 'retry')">
                  Retry
                </button>
                <button class="op" title="Take this row away" (click)="act($event, row, 'dismiss')">
                  Dismiss
                </button>
              </div>
            }
          </div>
        </div>
      </ng-template>

      <!--
        THE MENU IS OURS, not Electron's. There is no context-menu idiom in this
        app to follow, and the native one would be the same mistake the native
        confirmation was: the OS's rectangle over a window whose every other
        surface is drawn here. It is also the only kind that can be built without
        a second IPC round trip per row.

        FOUR MENUS IN ONE CARD, because a row's kind decides entirely what can be
        done to it: a book can be closed, a step can be deleted, an
        export and a copy can be revealed or erased. Offering all of them and
        greying most would be a card whose shape says nothing about what it is
        over. A HOST'S NODE HAS NO MENU AT ALL — none of these four acts is
        Foundry's to perform on somebody else's job.

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
              "OPEN IN SPLIT" WAS THE FIRST ITEM HERE — *"they can right-click a
              different step and click open, and itll split the screens between
              the one they just opened and the one they already had open."* It
              went with the columns (docs/PLAN.md §4, unit 8b): the ordinary
              click already stands on the step and shows what it shows, and what
              the menu added was the ARRANGEMENT, which there is no longer a
              window shape to arrange. The user's own reading of the same need is
              a Compare button on the viewer that picks a step to put beside the
              live one (unit 8d) — a door on the surface being compared, rather
              than a right-click nothing on screen suggests.
            -->
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

    <!-- Pinned to the foot in both states; compact (icons alone, one column)
         while the panel is a stub, because a 76px label cannot draw in 30px of
         width and a truncated one would be worse than the icon by itself. -->
    <app-tool-rail [compact]="!ui.documentsShown()" />
  `,
  styles: [`
    /*
      WIDER THAN IT WAS, TWICE OVER.

      220px held an indented line of text. The card redesign needed more — a card
      holds a sentence, a lineage line under it and a state on the right, and at
      220 the titles this panel writes ("Translated into German") ellipsed into
      "Translated int…", which is the old notation with worse manners — so it went
      to 288, the width that fits the longest ordinary title at 12.5px with the
      dot column and one level of indent.

      346 IS THE USER ASKING FOR ROOM RATHER THAN A MEASUREMENT: *"lets make the
      library list on the left side nav bigger. it only takes up a sliver right
      now. lets expand its width by about 20% of what it is now to make a bit more
      room for the tree by default"* (2026-08-17). 288 was the FLOOR under which
      a card stops reading, and a floor is not a default — a tree four levels deep
      spends 72 of those pixels on lanes before a word of a title. So the number
      was 288 plus the fifth the user asked for.

      384 IS THE SAME PERSON ASKING AGAIN, HOURS LATER, FOR THE SAME REASON:
      *"the tree is getting bigger and requires a bit more space"* (2026-08-17
      22:30). And it had: exports moved under their provenance step and host
      nodes moved under the exports, so the deepest ordinary book went from three
      levels of indent to five — 90 pixels of lane before a title, on cards that
      now also carry a footer of buttons and, at the bottom of this same panel, a
      dock that used to have a row of the window to itself. TWICE-WIDENED IS
      WORTH NAMING AS SUCH rather than quietly re-deriving: this panel is the
      app's navigator, it has grown what it draws twice, and both numbers came
      from the person using it. It is still put away with one click on the corner
      button, which is what keeps a widening cheap.
    */
    :host {
      display: flex;
      flex-direction: column;
      width: 384px;
      min-width: 384px;
      height: 100%;
    }
    /*
      THE TREE TAKES WHAT IS LEFT AND THE DOCK KEEPS ITS OWN HEIGHT — which is
      the whole of "pinned to the top… the user can scroll down to see more".
      \`min-height: 0\` is what makes the scrolling happen INSIDE the panel
      rather than pushing the dock off the bottom of the window: a flex item does
      not shrink below its content without it, and the tree's content is
      unbounded.
    */
    .panel, .stub { flex: 1; min-height: 0; }
    app-tool-rail { flex: 0 0 auto; }
    /* Collapsed, the HOST narrows to the stub's width, because the shell's flex
       row measures the host and not the panel inside it — a stub drawn inside a
       384px host would be 30 pixels of button beside 354 of nothing. The class
       is put on by the shell (see App's template) rather than by a host binding
       here, so the element carrying it is invalidated by the same change
       detection pass that reads the flag. */
    :host(.shut) { width: 30px; min-width: 30px; }
    /* The stub is a column too, so its one button sits at the top and the
       compact dock keeps the foot. */
    .stub { display: flex; flex-direction: column; }

    .stub {
      align-items: center;
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

    /*
      THE PANEL DROPPED A LAYER so the cards could have one. It used to be
      --bg-elevated because it was a rail of text against the workspace; now the
      cards are the elevated things and a card on a surface of its own colour is
      an invisible card. Base underneath, elevated on top, the divider unchanged.
    */
    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-base);
      border-right: 1px solid var(--border-default);
    }

    /* Present so the symbols resolve; never drawn. Not display:none — a hidden
       subtree still defines its <defs>, but zero-sized is the form every icon
       sheet uses and the one browsers agree about. */
    .sheet { position: absolute; width: 0; height: 0; overflow: hidden; }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 8px 5px;
      background: var(--bg-sunken);
      border-bottom: 1px solid var(--border-subtle);
    }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 12px 16px; }
    /* Where a dragged row would land, when it is past the last one. */
    .list.landing { background: var(--accent-faint); }

    /* Each book is a run; the space between two of them is what says where one
       ends. Heavier chrome would make the panel read as several lists. */
    .group { margin-bottom: 14px; }

    /*
      ── THE DRAWN LINEAGE ─────────────────────────────────────────────────────

      A row is [one lane per ancestor][the rail][the card], and every number
      below is one of three: the LANE is 18px (one indent), the RAIL is 26px, and
      the vertical thread sits at 12px inside whichever of them it belongs to, so
      an ancestor's line and its own rail's line are the same line at the same x.
      The 10px gap under a card is bridged by the thread's negative bottom —
      without that the spine would be a dotted column of segments.
    */
    .step { display: flex; position: relative; margin-bottom: 10px; }
    .lane { position: relative; flex: 0 0 18px; }
    .rail { position: relative; flex: 0 0 26px; }

    .thread { position: absolute; left: 12px; width: 2px; background: var(--border-default); }
    .lane .thread { top: 0; bottom: -10px; }
    /* 22px is the dot's centre: 8px of card padding plus half of the 26px icon
       square, which is what the dot is vertically aligned to. */
    .rail .thread.up { top: 0; height: 22px; }
    .rail .thread.down { top: 22px; bottom: -10px; }
    /*
      SOLID IS WHAT EXISTS, DASHED IS THE PLAN — the grammar the whole panel now
      reads by, and the reason a queued act can be drawn at all. Border rather
      than background, because a dashed background does not exist.
    */
    .thread.dashed { width: 0; background: none; border-left: 2px dashed var(--border-default); }

    /* The curve out of a parent's line into an indented lane. Drawn in the last
       lane so it starts on the PARENT's thread, and ending under the dot, which
       is painted over it. */
    .elbow {
      position: absolute; left: 12px; top: 0;
      width: 14px; height: 22px;
      border-left: 2px solid var(--border-default);
      border-bottom: 2px solid var(--border-default);
      border-bottom-left-radius: 10px;
    }
    .elbow.dashed { border-style: dashed; }

    .dot {
      position: absolute; left: 5px; top: 14px;
      width: 16px; height: 16px;
      border-radius: 50%;
      display: grid; place-items: center;
      z-index: 2;
    }
    .dot .mark { width: 9px; height: 9px; }
    /* The origin: a filled neutral disc wearing the mark of what arrived. It is
       not "done" — nothing was run to make it — and it is not pending either. */
    .dot.source { background: var(--border-strong); color: var(--bg-base); }
    .dot.done { background: var(--accent-strong); color: var(--text-inverse); }
    .dot.running { background: var(--bg-base); border: 2px solid var(--accent); }
    .dot.running::after {
      content: '';
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--accent);
      animation: node-pulse 1.4s ease-in-out infinite;
    }
    .dot.queued { background: var(--bg-base); border: 2px dashed var(--text-muted); }
    .dot.failed { background: var(--error); color: var(--bg-base); }
    /* A file — an export, a facsimile, a copy somebody opened. Small and hollow:
       it is on the tree because it belongs to the book, not because it is a
       moment in its history. */
    .dot.file {
      width: 8px; height: 8px;
      left: 9px; top: 18px;
      background: var(--border-strong);
    }
    @keyframes node-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.75); }
      50% { opacity: 1; transform: scale(1); }
    }

    /*
      ── THE CARD ──────────────────────────────────────────────────────────────
    */
    .card {
      flex: 1; min-width: 0;
      position: relative;
      padding: 8px 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: default;
      user-select: none;
      transition: border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .card:hover { border-color: var(--border-strong); }

    .row1 { display: flex; align-items: center; gap: 8px; }
    .kind {
      flex: 0 0 auto;
      width: 26px; height: 26px;
      display: grid; place-items: center;
      border-radius: var(--radius-md);
      background: var(--bg-input);
      color: var(--text-secondary);
    }
    .kind svg { width: 14px; height: 14px; }
    /*
      TWO TINTS AND ONE MEANING EACH. The accent is this app's word for its own
      work — reading, editing, translating, exporting. Amber is the HOST's:
      narration, enhancement, assembly. A person looking at a branch can see
      where the words stop and the audio starts without reading a title.
    */
    .kind.text-op { background: var(--accent-faint); color: var(--accent); }
    .kind.audio-op { background: var(--audio-soft); color: var(--audio); }

    .words { flex: 1; min-width: 0; }
    .name {
      font-size: 12.5px; font-weight: 600; line-height: 1.35;
      color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .from {
      font-size: 10.5px; line-height: 1.35;
      color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .from b { color: var(--text-secondary); font-weight: 500; }

    .state {
      flex: 0 0 auto;
      max-width: 88px;
      color: var(--text-tertiary); font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      text-align: right;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /*
      THE ROOT IS THE BOOK. Its title is the book's name — the one thing this
      panel must never stop saying, since the group header that used to say it is
      gone — and what KIND of thing it started as goes on the lineage line
      underneath, where every other card keeps its second fact.
    */
    .card.root .name { font-size: 13px; }

    /*
      THE STANDING CARD, in the same accent and the same faint wash the inspector
      marks its current category with. One word for "this is the one the book is
      on" across the whole app; inventing a second is how a palette stops meaning
      anything. It is NOT the same statement the ring below makes — see the
      class docblock on standing against selected.
    */
    .card.standing { background: var(--accent-faint); }
    .card.standing .name { color: var(--accent); }

    /*
      THE SELECTED CARD — the one whose "from here" footer is open. A ring rather
      than a wash, so a card that is both standing and selected (the ordinary
      case, since clicking stands) reads as one thing with two marks rather than
      as two competing highlights.
    */
    .card.selected {
      border-color: var(--accent-strong);
      box-shadow: 0 0 0 1px var(--accent-strong), 0 6px 18px -8px rgba(6, 182, 212, 0.5);
    }

    /*
      A STALE STEP IS DIMMED AND STILL CLICKABLE, which was the ruling. Its
      payload is a true record of what was made — a translation of a bank that
      has since been re-read still holds the blocks it translated — so it opens,
      it renders, and only its currency is in question. The reason is on hover,
      where an explanation nobody needs stays out of the way of a list.
    */
    .card.stale .name, .card.stale .from, .card.stale .state, .card.stale .kind { opacity: 0.55; }

    /*
      PLAIN TEXT HAS NO TAB IN THIS APP, and the card says so by not lighting up.
      It is still listed, because it is a thing the user made and a thing they can
      reveal or delete; what it does not do is pretend a click will open it.
    */
    .card.inert { opacity: 0.65; }
    .card.inert:hover { border-color: var(--border-default); }

    /*
      AN EXPORT NOBODY HAS OPENED — dimmed and nothing else. The list's language
      for "on screen" is the accent bar (.on), so the honest opposite is simply
      not having it.
    */
    .card.available .name { color: var(--text-secondary); }
    .card.available:hover .name { color: var(--text-primary); }

    /*
      THE DOCUMENT YOU ARE LOOKING AT — one mark, where there were two.

      "On screen somewhere" and "in the FOCUSED column" were two different facts
      and got two different strengths, because the rail, the menu and Ctrl+S all
      acted on the focused column and which it was had to be visible without
      being loud. One viewer makes them one fact, so the card takes the STRONGER
      of the two marks: the accent bar and the faint wash, which is what a person
      was reading anyway when they wanted to know where a chord would land.
    */
    .card.on {
      background: var(--accent-faint);
      box-shadow: inset 2px 0 0 0 var(--accent);
    }
    .card.on .name { color: var(--text-primary); }

    /*
      The insertion point: a line along the edge the dragged row would land on.
      Spelled out against the on-screen selector as well, because it sets the
      same property at a higher specificity — without this the line would be
      invisible on exactly the cards a person is most likely to be dragging.
    */
    .card.before,
    .card.on.before { box-shadow: inset 0 2px 0 0 var(--accent); }

    /*
      ── THE THREE HOST STATES ─────────────────────────────────────────────────

      PENDING is drawn as an outline of a card rather than a card: no fill, a
      dashed border, an untinted mark. *"a queued step should look grayed out"* —
      and the reason it is an outline and not a grey fill is that the fill is what
      the eye reads as "this is a thing"; a plan is the shape of one.
    */
    .card.pending { background: transparent; border-style: dashed; }
    .card.pending .name { color: var(--text-secondary); font-weight: 500; }
    .card.pending .kind { background: transparent; border: 1px dashed var(--border-default); color: var(--text-tertiary); }
    .card.running { border-color: var(--accent-soft); }
    .card.failed { border-color: rgba(248, 113, 113, 0.45); background: var(--error-soft); }
    .card.failed .state { color: var(--error); }

    .progress { margin-top: 8px; }
    .pbar { height: 4px; border-radius: 2px; background: var(--bg-input); overflow: hidden; }
    .pbar i {
      display: block; height: 100%; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent-strong), var(--accent));
    }
    .pmeta {
      display: flex; justify-content: space-between; gap: 8px;
      margin-top: 4px;
      font-size: 10.5px; color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .pmeta .doing {
      color: var(--text-secondary);
      min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .why { margin-top: 6px; font-size: 10.5px; line-height: 1.4; color: var(--error); }

    .meter { display: inline-flex; align-items: flex-end; gap: 2px; height: 9px; margin-left: 6px; }
    .meter i {
      width: 2px; border-radius: 1px;
      background: var(--audio);
      animation: node-eq 1s ease-in-out infinite;
    }
    .meter i:nth-child(1) { height: 55%; animation-delay: -0.2s; }
    .meter i:nth-child(2) { height: 100%; animation-delay: -0.55s; }
    .meter i:nth-child(3) { height: 40%; animation-delay: -0.8s; }
    @keyframes node-eq {
      0%, 100% { transform: scaleY(0.4); }
      50% { transform: scaleY(1); }
    }

    /*
      SOMEBODY WHO HAS ASKED FOR LESS MOTION GETS THE SAME TWO FACTS, HELD STILL.
      The pulsing core stays a core and the meter stays three bars — both of them
      say "running" by existing at all, and the animation was only ever the
      emphasis. Nothing else in this panel moves.
    */
    @media (prefers-reduced-motion: reduce) {
      .dot.running::after { animation: none; opacity: 1; transform: none; }
      .meter i { animation: none; }
    }

    /*
      ── "FROM HERE" ───────────────────────────────────────────────────────────

      Bled to the card's own edges (the negative margins) so it reads as a
      drawer inside the card rather than as a second card in a stack, and washed
      in the accent so that it is legible as an offer rather than as more of the
      description above it.
    */
    .ops {
      display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
      margin: 8px -10px -8px;
      padding: 7px 10px 8px;
      background: var(--accent-faint);
      border-top: 1px solid var(--accent-soft);
      border-radius: 0 0 calc(var(--radius) - 1px) calc(var(--radius) - 1px);
    }
    .ops .lbl {
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--accent);
      margin-right: 2px;
    }
    .op {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 8px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 11.5px;
      cursor: pointer;
    }
    .op svg { width: 12px; height: 12px; }
    /*
      THE RECOVERY PAIR wears the failure's own colour rather than the accent
      wash the offer footer has: it is not an offer, it is what is left when the
      work did not happen, and a red-bordered card whose only controls looked
      like invitations would be two moods in one place.
    */
    .ops.recovery { background: var(--error-soft); border-top-color: rgba(248, 113, 113, 0.35); }
    .ops.recovery .op:hover { color: var(--error); border-color: rgba(248, 113, 113, 0.55); }
    .op:hover { color: var(--text-primary); border-color: var(--accent-strong); }
    /* The host's acts wear the host's colour, here as well as on the cards they
       make, so pressing one is visibly ordering a different KIND of work. */
    .op.audio-op { color: var(--audio); border-color: rgba(240, 168, 96, 0.35); }
    .op.audio-op:hover { color: var(--audio-bright); border-color: var(--audio); }

    /*
      THE ARROW, AND THE SPACE WHERE AN ARROW WOULD BE. Both are 10px wide so the
      marks to their right line up whether or not a node has anything under it.
    */
    .twist {
      flex: 0 0 auto;
      width: 10px; height: 14px;
      padding: 0; margin: 0;
      background: transparent; border: none;
      color: var(--text-tertiary); font-size: 9px; line-height: 14px;
      text-align: left;
    }
    button.twist { cursor: pointer; }
    button.twist:hover { color: var(--text-primary); }

    .mark-dot { flex: 0 0 auto; color: var(--accent); font-size: 9px; line-height: 1; }
    .pencil { flex: 0 0 auto; color: var(--warn); font-size: 11px; line-height: 1; }

    /*
      Hidden until the card is under the pointer or the button is keyboard-focused.
      Visibility rather than display, so the card's width does not change when it
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
    .card:hover .x, .x:focus-visible { visibility: visible; }
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
  protected readonly documents = inject(OpenDocumentsService);
  private readonly stage = inject(StageService);
  private readonly notices = inject(NoticeService);
  protected readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);
  /**
   * The host's contributions — empty and silent standalone, which is why nothing
   * in this class asks whether the app is hosted (`HostOpsService`).
   */
  private readonly hostOps = inject(HostOpsService);
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
      this.documents.tabs().map((tab) => tab.path).join('\u0000');
      void this.projects.refresh();
    });

    /*
     * THE HISTORY OF EVERY OPEN BOOK, ASKED FOR ONCE — and, in the same pass,
     * whatever the host is making in it.
     *
     * Until this panel drew trees, the only surfaces that needed a ledger were
     * the inspector — which asks for the FOCUSED document's project — and the
     * block editor, which asks when the mode comes up (`loadBlockView`,
     * position-sync.service.ts). Neither of those covers this one: five books can be open
     * with one focused, and the four unfocused ones would have drawn a root with
     * nothing under it until somebody clicked into them. So the library asks for
     * its own, for every book it is about to draw.
     *
     * BOTH `ensure` CALLS ARE IDEMPOTENT AND SILENT BY CONTRACT (LedgerService,
     * HostOpsService) — a project already held or already in flight is a no-op —
     * which is what makes them safe from an effect that re-runs whenever a tab
     * opens. They also read no signal this effect writes: `openProjects` is
     * composed from the tabs and the catalogue, never from the held ledgers or
     * the host's rows, so nothing here can chase its own tail.
     */
    effect(() => {
      for (const project of this.openProjects()) {
        this.ledger.ensure(project.dir);
        this.hostOps.ensure(project.dir);
      }
    });
  }

  /** The row a drop would land in front of, and whether the end of the list is the target. */
  protected readonly before = signal<string | null>(null);
  protected readonly landing = signal(false);
  /** The open context menu: which row it is about, and where it was asked for. */
  protected readonly menu = signal<{ row: Row; x: number; y: number } | null>(null);

  /**
   * The one card in the whole panel whose "from here" footer is open.
   *
   * ── Panel-wide rather than per book, and why that is the safe direction ─────
   *
   * `current` is per project — five open books have five standing positions —
   * and hanging the footer off THAT would put five sets of Translate buttons on
   * screen at once, each aimed at a different book. Every one of them opens the
   * same dialog, which acts on the POSITION, so five identical-looking buttons
   * would do five different things. One selection, set by the click that already
   * moves the position, is the only shape where what is offered and what would
   * happen are the same statement.
   *
   * NULL UNTIL SOMEBODY CLICKS, deliberately: a panel that opened with a footer
   * already unrolled would be offering acts nobody asked for, on whichever book
   * happened to be first.
   */
  protected readonly picked = signal<string | null>(null);

  /**
   * The nodes somebody has folded shut, by row key.
   *
   * COLLAPSED RATHER THAN EXPANDED, so a step that appears while you are looking
   * at the tree appears OPEN — a new save arriving folded under its reading
   * would be the panel hiding the thing that just happened. Session-only: see
   * the class docblock.
   */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());

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
    const paths = this.documents.tabs().map((tab) => tab.path);
    // The held project draws even with no tab open: closing the last document
    // keeps the window in the project, and this tree is the door back into it
    // (`StageService.heldProject`). One project, not a history — the hold is
    // where you ARE, not where you have been.
    const held = this.stage.heldProject();
    return this.projects.items().filter((project) => project.problem === null
      && (paths.some((path) => inProject(path, project.dir))
        || (held !== null && inProject(held, project.dir))));
  });

  /**
   * Every open tab as a drawable row.
   *
   * ON SCREEN IS ONE BOOLEAN NOW. It used to be two facts drawn at two
   * strengths — which COLUMN a document was showing in, and whether that column
   * was the focused one — because the rail, the menu and Ctrl+S all acted on the
   * focused column and which it was had to be visible. With one viewer there is
   * one document in front of the person and every one of those acts means it, so
   * `focused` is simply "this is the one on screen" and the card's `.on.focused`
   * pair collapses onto it.
   */
  protected readonly rows = computed<Row[]>(() => {
    const tabs = this.documents.tabs();
    const on = this.stage.active();
    const out: Row[] = [];
    const emit = (tab: Tab, indent: boolean): void => {
      out.push({
        ...blank,
        key: tab.id,
        kind: 'document',
        tab,
        path: tab.path,
        title: tab.title,
        icon: iconForTab(tab),
        dot: 'file',
        tooltip: this.tooltip(tab),
        depth: indent ? 1 : 0,
        focused: tab.id === on,
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
   * Flattening at the source keeps ONE card template, one `track`, and one place
   * that decides what is visible: a collapsed node simply does not emit its
   * children, which is also what makes collapse cost nothing.
   *
   * IT IS ALSO WHAT MAKES THE SPINE DRAWABLE. The lineage is a per-row set of
   * lane flags computed in one backward pass over the finished list
   * (`drawLineage`), and a backward pass needs a list. A nested template would
   * have to ask each level whether anything below it continues, which is the
   * same question asked once per level instead of once per book.
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
       * WHETHER THERE IS A BOOK IN THIS PROJECT AT ALL, asked once per book and
       * spent on every card in it.
       *
       * It decides `produces`, which decides what the "from here" footer may
       * offer — and it is the DOCK'S OWN TEST, deliberately (`canTranslate`,
       * tool-rail.component.ts): the reading landed, or the book arrived as one,
       * and never the import row where somebody has stepped back to the
       * untouched scan. Two surfaces offering the same act must agree about when
       * it is available, and the way they agree is by asking the same question
       * of the same project record.
       */
      const arrivedAsBook = this.projects.arrivedAsBook(project);
      const hasBook = project.reading.done || arrivedAsBook;

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
       * WHAT THE HOST IS MAKING IN THIS BOOK, indexed by the ledger step each
       * node hangs under.
       *
       * A HOST NODE IS NOT IN `steps` AND NEVER WILL BE. This is a second index
       * beside the ledger's, read from a mirror of somebody else's queue, and it
       * is joined onto the tree at exactly one place: the walk below emits a
       * step's host nodes after the step's own children. Standalone the map is
       * empty and the walk emits nothing extra.
       */
      const hosted = new Map<string, HostNode[]>();
      for (const node of this.hostOps.nodesFor(project.dir)) {
        const already = hosted.get(node.parentStepId);
        if (already === undefined) hosted.set(node.parentStepId, [node]);
        else already.push(node);
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
       * THE TERMINAL FILES — the exports, each drawn under the STEP IT WAS MADE
       * FROM, and under the book itself only where nothing recorded one.
       *
       * ── "RECORDS WHAT WAS MADE, NEVER THE POSITION" IS OVERRULED ───────────
       *
       * This block used to hang every export off the ROOT, at the Book's own
       * indent, on a doctrine written into three comments here: the tray records
       * what was made and not where it was made from; an export card draws NO
       * lineage line because the tray does not record a position and this panel
       * will not guess one. The doctrine was true when it was written — `final[]`
       * held a file, a kind and a date and genuinely could not say more.
       *
       * IT IS FALSE NOW BECAUSE THE CATALOGUE LEARNED. Wave 9 put `stepId` on
       * every export row precisely so the provenance could stop being guessed,
       * and Owen looked at the result and ruled (2026-08-17 22:30): *"the epub
       * should be a child of 'applied changes'. right now it looks like it's a
       * child of 'the book'."* An export IS made from a position; the tree knows
       * which; drawing it anywhere else is the panel withholding a fact it holds.
       *
       * SO THE LINEAGE IS DRAWN, and the sentence under the card changed with it
       * — a narration is made from an export now, so *"nothing is made from it"*
       * was two rulings out of date.
       *
       * A NULL `madeFrom` KEEPS THE OLD HOME, and that is where the old doctrine
       * survives as a fallback rather than as a rule: catalogues written before
       * `stepId` existed have exports whose provenance genuinely is unknown, and
       * the honest place for a file whose parent nobody recorded is under the
       * book it belongs to. See `orphanExports` below, which is where that is
       * decided.
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
          /*
           * THE PRODUCT, AS THE DIALOG NAMED IT — a noun where a step's card
           * carries a past tense, on the same precedent the root and the reading
           * follow: what a person wants off a terminal card is the thing, not
           * the act. It is also what every other surface in this file spells its
           * sentences out of (the delete's tooltip, the tab an EPUB opens into),
           * so it stays exactly the word it has always been.
           */
          title: label,
          /*
           * WHAT IT IS, AND WHAT IS MADE FROM IT — both changed with the
           * ruling. The card used to say *"a finished file — nothing is made
           * from it"* and drew no lineage, because the tray recorded no
           * position and this panel would not invent one. It records one now
           * (`ProjectFinal.stepId`), the card is drawn under it, and a
           * narration IS made from this file — so the old sentence was wrong
           * twice over in one line.
           *
           * `from` IS LEFT TO THE PARENT-NAMING PASS BELOW, which spells the
           * step's own title the way every other child of a step does.
           */
          said: 'the finished file — audio work is made from this',
          state: whenOn(made.madeAt),
          icon: 'ft-out',
          dot: 'file',
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
           * be a pane with "This PDF would not open" on it. The card stays, wearing
           * its date and its Reveal, because an export the app made and then would
           * not admit to is worse than one it will not open.
           */
          openable: made.kind === 'pdf',
          focused: already?.focused ?? false,
          /*
           * ── THE EXPORT ROW IS WHERE NARRATION BELONGS, AND NOW IT OFFERS IT ──
           *
           * *"In the tree, 'The book' and 'Applied changes (52)' offer
           * translate/simplify/narrate/etc., but the exported-EPUB row offers
           * nothing. The export row is the single most correct place for
           * `narrate` — it IS the file narration consumes."* (BookForge →
           * Foundry, 2026-08-18.)
           *
           * IT PRODUCES AN `export`, WHICH IS ITS OWN CURRENCY as of Wave 10 —
           * and the change from `'book'` is Owen's ruling landing in one word.
           * Saying `book` here put every `appliesTo: 'book'` act on this row AND
           * on every ledger step, so Narrate appeared on "Applied changes" where
           * it could only refuse: *"The only options that exist are the ones that
           * are possible for that stage."* A ledger step produces the WORDS; this
           * row is the finished FILE of them; an act that reads a file declares
           * `export` and lands here alone (`NodeOutput`, shared/types.ts).
           *
           * What it does NOT get is Foundry's own acts — see `acts`, where they
           * are gated on the row being a POSITION. An export is terminal in this
           * app's own pipeline and a source in the host's, and this field is the
           * only place those two facts meet.
           *
           * AND ONLY THE EPUB ROW SAYS IT. What an `export` act consumes today
           * is the finished BOOK file; a plain-text export or a reprint
           * offering one would be a button whose only possible outcome is the
           * host's refusal — the exact shape the ruling forbids. The day a
           * host registers an act that consumes a facsimile, this is the one
           * line that learns kinds.
           */
          produces: made.kind === 'epub' ? 'export' : null,
          // Its provenance, where the catalogue recorded one (`ProjectFinal.stepId`).
          madeFrom: made.stepId ?? null,
          /*
           * THE ID A PRESS ON THIS ROW HANDS THE HOST — `export:<file>`, minted
           * from the catalogue's own spelling of the file and from nothing about
           * this render (`exportNodeId`, shared/host-ops.ts, which carries the
           * whole argument). It is what makes a narration come back wearing this
           * row as its parent instead of the step the export was made from,
           * which is Owen's third ruling.
           */
          nodeId: exportNodeId(made.file),
        });
      }

      /*
       * AND THE FACSIMILES, WHICH ARE TERMINAL FOR THE SAME REASON THE EXPORTS
       * ARE — *"from the bank, pdf facsimile can be generated. that's a terminal
       * item"* (docs/RENDERER.md §0 A3).
       *
       * A reading has two documents in it: the Book, which is the read step's card
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
       * facsimile hung under the READ step would be a child of a card that is
       * itself a position, so folding the reading away would hide a terminal file,
       * and a project with two readings would draw two cards that look like
       * versions of one document rather than the records of two different passes.
       *
       * CALLED "FACSIMILE" AND NOT "FACSIMILE PDF", which is the export's word.
       * The two cards can appear together — somebody who exports a facsimile
       * after one has been made has both — and the distinction they need is that
       * one is a copy they filed and one is the record this book keeps of its own
       * reading. The line underneath says which in words; the title carries the
       * difference a person scanning a tree can use, and neither of them is a
       * filename.
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
          // click, wear the on-screen bar, offer a delete behind the danger ✕ — is
          // what this kind already means, and a `RowKind` per product would be
          // four template branches to say one thing.
          kind: 'export',
          tab: already?.tab ?? null,
          path,
          title: 'Facsimile',
          said: 'the pages as they were printed — nothing is made from it',
          state: whenOn(made.madeAt),
          icon: 'ft-page',
          dot: 'file',
          tooltip: 'Open this facsimile\nThe pages of this book as they were '
            + 'printed, reprinted as real text from what the reading found. Nothing '
            + `is made from it.\n${path}`,
          depth: 1,
          dir: project.dir,
          managed: true,
          openable: true,
          focused: already?.focused ?? false,
        });
      }

      /*
       * THE TABS THE TREE DOES NOT SPEAK FOR — the catalogue, AND the books the
       * steps cast for themselves.
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
         * THE BOOK IS THE READ STEP, and the read step is already a card up
         * there — the one called "The book", which is what standing on it opens
         * (`showBook`, core/position-sync.service.ts). It cannot be claimed by the
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
         * reading the book's name that would be a card saying nothing at all. The
         * old answer was the filename, which is the one thing this list is not
         * allowed to fall back to; the honest answer is that this is a copy the
         * reader went and opened themselves, with the path one hover away.
         */
        const named = row.tab === null ? '' : typeLabel(row.tab.kind);
        extras.push({
          ...row,
          title: named.length > 0 ? named : row.title,
          said: 'a copy you opened',
          depth: 1,
          dir: project.dir,
        });
        claimed.add(row.key);
      }

      /*
       * ── THE EXPORTS, INDEXED BY THE STEP THEY WERE MADE FROM ───────────────
       *
       * Owen's fourth ruling (2026-08-17 22:30). `madeFrom` has been on the row
       * since Wave 9 and was drawn nowhere; this is the index that puts it on
       * screen. A row whose provenance names a step in THIS project's ledger is
       * emitted by the walk, as that step's own child; everything else falls to
       * `orphanExports` and keeps the home the tray doctrine gave it.
       *
       * NAMING A STEP THIS PROJECT DOES NOT HOLD COUNTS AS ORPHANED, which is
       * not defensive: a delete can take the step an export was made from while
       * the file itself stays in `final/` (the tray is the user's and is never
       * swept by a step delete), so this is the ordinary end state of deleting a
       * reading somebody had already exported from.
       */
      const exportsByStep = new Map<string, Row[]>();
      const orphanExports: Row[] = [];
      for (const row of terminals) {
        const parent = row.madeFrom;
        if (parent === null || !ids.has(parent)) {
          orphanExports.push(row);
          continue;
        }
        const already = exportsByStep.get(parent);
        if (already === undefined) exportsByStep.set(parent, [row]);
        else already.push(row);
      }

      /*
       * AND THE HOST NODES AN EXPORT ROW OWNS — the ghost narrations, indexed by
       * the export id they came back wearing.
       *
       * The host echoes the invoke's nodeId into `parentStepId` verbatim, so a
       * narration ordered from an export row arrives with `export:<file>` in the
       * field the ledger's own children are indexed by. `hosted` above cannot
       * hold them: its keys are step ids, and a lookup there would never match.
       * Reading them out by the same spelling the press minted is the whole of
       * the join (`exportNodeId` / `exportOfNodeId`, shared/host-ops.ts).
       *
       * A NODE WHOSE PARENT NAMES AN EXPORT THIS PROJECT NO LONGER HAS draws
       * nowhere, which is `setHostNodes`' own documented posture for a parent the
       * tree cannot find — Foundry does not refuse a push, it simply has nowhere
       * to hang it.
       */
      const hostedOnExports = new Map<string, HostNode[]>();
      for (const node of this.hostOps.nodesFor(project.dir)) {
        if (exportOfNodeId(node.parentStepId) === null) continue;
        const already = hostedOnExports.get(node.parentStepId);
        if (already === undefined) hostedOnExports.set(node.parentStepId, [node]);
        else already.push(node);
      }

      /**
       * Draw one export row and whatever the host is making from it.
       *
       * ── An export has children now, which is the composition of two rulings ─
       *
       * Ruling three puts the narrations under the export; ruling four puts the
       * export under its step. Together the tree reads Book → … → Applied
       * changes → EPUB export → the narration — which is the pipeline in the
       * order it happened, and is what Owen was describing when he said the epub
       * looked like a child of the book.
       *
       * SO IT GROWS AN ARROW, and only when it has something under it. `expanded`
       * has been null on every export since the row existed — *"an export never
       * gets one; it is terminal, and an arrow on it would promise something
       * under it"* — and that sentence is now true only of an export nobody has
       * made anything from. The promise is kept either way: an arrow appears
       * exactly when there is something to reveal.
       */
      const emitExport = (row: Row, depth: number): void => {
        const jobs = row.nodeId === null ? [] : hostedOnExports.get(row.nodeId) ?? [];
        const shown = !collapsed.has(row.key);
        rows.push({
          ...row,
          depth,
          expanded: jobs.length === 0 ? null : shown,
        });
        if (!shown) return;
        /*
         * THE GHOST SAYS WHICH FILE IT IS BEING MADE FROM, which is the export's
         * own card title ("EPUB"). Before the ruling these rows hung under a
         * STEP and named it; hanging under the file and naming nothing would
         * have been a lineage line drawn and then left blank.
         */
        for (const node of jobs) rows.push(hostRow(project, node, row.title, depth + 1));
      };

      // ── The tree itself, root first ──────────────────────────────────────
      const rootKey = `${project.key}:root`;
      const rootKids = origin === null
        ? stranded
        : [...kids.get(origin.id) ?? [], ...stranded];
      const rootHostNodes = origin === null ? [] : hosted.get(origin.id) ?? [];
      /*
       * THE ORPHANS RATHER THAN EVERY TERMINAL, now that most exports are drawn
       * deeper: a book whose only export hangs under a step still has children
       * (that step is one), so the count is only wrong in the direction that
       * would matter if a project's ENTIRE contents were exports with parents —
       * which cannot happen, because a step with an export under it is itself a
       * child of the root.
       */
      const rootHasChildren =
        rootKids.length + rootHostNodes.length + orphanExports.length + extras.length > 0;
      const rootOpen = !collapsed.has(rootKey);
      const rows: Row[] = [{
        ...blank,
        key: rootKey,
        kind: 'root',
        // The project's directory, because Show in file manager on a book means
        // the book's folder — and because the root names a book, not a file.
        path: project.dir,
        // THE BOOK'S OWN NAME, and it is the one title in this panel that is not
        // a sentence about an act. The group header that used to carry it is
        // gone; what the import IS goes on the line underneath, where every
        // other card keeps its second fact.
        title: project.title,
        said: origin === null ? 'reading this book’s history…' : arrivalSentence(origin.payload),
        state: origin === null ? null : whenOn(origin.createdAt),
        icon: origin === null ? 'ft-scan' : iconForArrival(origin.payload),
        dot: 'source',
        tooltip: this.rootTitle(project, origin, problem),
        depth: 0,
        dir: project.dir,
        step: origin,
        // The import is a position like any other, so acting from it is offered
        // on exactly the terms the dock offers it on: only where the import IS
        // the book (a project that arrived as one), never where it is the scan
        // somebody has stepped back to.
        produces: hasBook && arrivedAsBook ? 'book' : null,
        current: origin !== null && origin.id === standing,
        stale: origin?.stale === true,
        expanded: rootHasChildren ? rootOpen : null,
      }];

      if (rootOpen) {
        const walk = (step: LedgerStep, depth: number): void => {
          const under = kids.get(step.id) ?? [];
          const jobs = hosted.get(step.id) ?? [];
          const key = `${project.key}:step:${step.id}`;
          const shown = !collapsed.has(key);
          rows.push({
            ...blank,
            key,
            kind: 'step',
            path: project.dir,
            // A SENTENCE, DERIVED — never `step.label`, which is the record of
            // what this app called the act at the time and is what the tooltip
            // still says. See `titleForStep`.
            title: titleForStep(step),
            fact: factForStep(step),
            from: parentTitleOf(step, steps, project.title),
            state: whenOn(step.createdAt),
            icon: iconForStep(step),
            tint: 'text',
            dot: 'done',
            tooltip: stepTitle(step, standing),
            depth,
            dir: project.dir,
            step,
            produces: hasBook && (arrivedAsBook || step.action !== 'import') ? 'book' : null,
            current: step.id === standing,
            stale: step.stale === true,
            expanded: under.length + jobs.length === 0 ? null : shown,
          });
          if (!shown) return;
          for (const kid of under) walk(kid, depth + 1);
          /*
           * THE FILES MADE FROM THIS STEP, between its ledger children and the
           * host's work — see the index above for the ruling. Before the steps'
           * own children would have put an export above a translation made from
           * the same row; after the host's nodes would have put a finished file
           * below the work being made from it. Between them is the order the
           * pipeline actually runs in.
           */
          for (const made of exportsByStep.get(step.id) ?? []) emitExport(made, depth + 1);
          /*
           * THE HOST'S OWN WORK, AFTER THE STEPS MADE FROM THE SAME PLACE.
           *
           * Last rather than first, and it is the honest order: the ledger's
           * children are things that HAVE happened to the words, and a host node
           * is most often the thing that has not happened yet. A queued
           * narration drawn above a finished translation would put the plan
           * above the record.
           */
          for (const node of jobs) {
            rows.push(hostRow(project, node, parentNameOf(project, step), depth + 1));
          }
        };
        for (const step of rootKids) walk(step, 1);
        for (const node of rootHostNodes) {
          rows.push(hostRow(project, node, parentNameOf(project, origin), 1));
        }
        /*
         * AND THE EXPORTS NOBODY RECORDED A PARENT FOR, at the Book's own indent
         * — the home every export had before the ruling, kept for exactly the
         * rows that still have nothing better to say. A catalogue written before
         * `ProjectFinal.stepId` existed has files whose provenance is genuinely
         * unknown, and inventing one for them would be the guess the old tray
         * doctrine was right to refuse.
         */
        for (const made of orphanExports) emitExport(made, 1);
        rows.push(...extras);
      }

      out.push({
        key: project.key,
        title: project.title,
        dir: project.dir,
        rows: drawLineage(rows),
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
   *
   * NO SPINE ON THESE, which is the one place the drawn lineage is deliberately
   * withheld: two files opened from two folders are not related, and a line
   * joining them would be the panel asserting an ancestry that does not exist.
   * They keep `lanes: []` and no threads, straight out of `blank`.
   */
  protected readonly loose = computed<Row[]>(() => {
    const groups = this.groups();
    const keys = new Set(groups.flatMap((group) => group.rows.map((row) => row.key)));
    const taken = new Set(groups.flatMap((group) => group.tabIds));
    return this.rows().filter((row) => !keys.has(row.key)
      && !(row.tab !== null && taken.has(row.tab.id)));
  });

  /**
   * WHAT CAN BE DONE FROM THE SELECTED CARD — the "from here" footer's contents.
   *
   * ── ONLY THE POSSIBLE IS OFFERED, which is the whole of Owen's ruling ───────
   *
   *   *"just put 'export EPUB' as the only option on things that aren't capable
   *   of narration or whatever. The only options that exist are the ones that
   *   are possible for that stage."* (2026-08-17 20:30, via the bridge.)
   *
   * A BUTTON WHOSE ONLY POSSIBLE OUTCOME IS A REFUSAL IS NOT DRAWN. What he had
   * hit was the host's Narrate on a step that had nothing exported, but the same
   * complaint was true of this app's own three: an unread scan's import row is a
   * stage where Translate, Simplify and Export can each only refuse, and the
   * footer drew all three anyway — or, where `produces` had already gone null,
   * drew NOTHING and left a stage with one obvious next act looking like a dead
   * end.
   *
   * ── Each act is gated on the predicate the act itself refuses by ────────────
   *
   * `shared/stages.ts` holds one function per act — `canReadPages`,
   * `canTranslateFrom`, `canSimplifyFrom`, `canExportFrom` — and the dock's
   * buttons, the dialogs' own refusals and this footer all read the same one. The
   * point is not tidiness: it is that a button here and a sentence in a card
   * cannot come to different answers about what a stage can do, which is exactly
   * the failure the ruling names.
   *
   * ASKED ABOUT THE ROW, NOT ABOUT THE POSITION. Pressing an act in this footer
   * STANDS on the row first and then opens the dialog (`run`), so the honest
   * question for a card is "would this be possible if I were standing here" —
   * the same predicate with the row's own step in it. The dock asks the identical
   * function about the step the book is actually standing on.
   *
   * ── And the host's acts are still gated by what the node produces ───────────
   *
   * `Row.produces` is the currency (`NodeOutput`): the words of a book, a
   * finished export, or a host's audio. The host declares what each of its
   * operations consumes and `offeredFrom` is one comparison — which is what stops
   * Assemble appearing on a chapter of text, and, since Wave 10, what stops an
   * act that reads a finished FILE appearing on a ledger step.
   *
   * COMPUTED FOR THE SELECTED CARD ONLY, because that is the only card that
   * draws it: this reads `picked()`, so it is recomputed when the selection
   * moves and not once per row per repaint.
   */
  protected readonly acts = computed<readonly Act[]>(() => {
    const key = this.picked();
    if (key === null) return NO_ACTS;
    const row = this.groups().flatMap((group) => group.rows).find((one) => one.key === key) ?? null;
    if (row === null || row.dir === null) return NO_ACTS;
    const dir = row.dir;
    const out: Act[] = [];
    /*
     * FOUNDRY'S OWN ACTS ARE OFFERED FROM A POSITION — a root or a step, never an
     * export row and never a host's node. An export is terminal in this app's own
     * pipeline (*"it wont go into the working files as a step because it isnt the
     * base for new steps"*), and offering Translate there would be offering to
     * make a new book out of a finished file by standing somewhere the card
     * cannot stand.
     *
     * IT NO LONGER TESTS `produces`, and that is Wave 10 landing. `produces` is a
     * fact about what the HOST may chain onto; whether THIS app can act is a
     * different question with four different answers, and conflating them is what
     * made an unread scan's import row offer three impossible acts (or, once
     * `produces` went null there, offer nothing at all — including the one act
     * that WAS possible).
     */
    if (row.kind === 'root' || row.kind === 'step') {
      const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
      /*
       * THE STEP THIS CARD IS, which is what the predicates are asked about — see
       * the docblock: pressing stands here first, so the question is what would be
       * possible from this row.
       */
      const at = row.step;
      /*
       * READ COMES FIRST BECAUSE IT COMES FIRST. On a scan nobody has read, this
       * is the only possible act and everything else is waiting on it — which is
       * exactly the stage Owen was looking at when he ruled. The dock has always
       * said the same thing by lighting its OCR button; this is that sentence
       * said where the person is actually standing.
       *
       * IT DISAPPEARS THE MOMENT A BANK LANDS. `canReadPages` is main's own
       * `reading.needed`, false for a project that arrived as an EPUB (no pages
       * to read) and false once a reading is done — so this is not a permanent
       * fixture of the root, it is the one act a book still owes.
       */
      if (canReadPages(project)) {
        out.push({
          id: 'read', label: 'Read the pages', icon: 'ft-scan', audio: false, host: null,
          form: false,
          hint: 'Read this book\u2019s pages with the vision model \u2014 everything else is made from it',
        });
      }
      /*
       * AND THE THREE THAT CONSUME THE WORDS, each on its own predicate. They
       * agree today (all three are `hasBookAt`) and are asked separately anyway,
       * because they are three acts with three dialogs and a shared name is what
       * lets one of them grow a condition later without the other two silently
       * inheriting it.
       *
       * METADATA IS DELIBERATELY NOT HERE, unchanged: it is a record ABOUT the
       * position rather than a thing made FROM it — the pointer does not even
       * move for it (`StepAction`) — so "from here" is the wrong sentence for it,
       * and the dock keeps it.
       */
      if (canTranslateFrom(project, at)) {
        out.push({ id: 'translate', label: 'Translate', icon: 'ft-globe', audio: false, host: null,
          form: false, hint: 'Translate what this node holds into another language' });
      }
      if (canSimplifyFrom(project, at)) {
        out.push({ id: 'simplify', label: 'Simplify', icon: 'ft-spark', audio: false, host: null,
          form: false,
          hint: 'Say this again in its own language: plainer, more natural, or for a learner' });
      }
      if (canExportFrom(project, at)) {
        out.push({ id: 'export', label: 'Export', icon: 'ft-out', audio: false, host: null,
          form: false, hint: 'Make the finished book from this node' });
      }
    }
    /*
     * A ROW THAT PRODUCES NOTHING HAS NO HOST ACTS, which is where the old
     * `produces === null` guard at the top of this function went. It could not
     * stay there: it would have refused the whole footer for exactly the stage
     * this wave exists to give an offer to.
     */
    if (row.produces === null) return out;
    /*
     * AND NOTHING CHAINS OFF A NODE THAT FAILED.
     *
     * *"Owen's screenshot of a FAILED narrate node: the card still offers 'FROM
     * HERE: Enhance / Assemble' — ops that chain onto the audio the step never
     * produced."* `produces` on a host node is a PROMISE (it is what makes a
     * queued run chainable at all), and a failure is the promise broken while the
     * row goes on making it. `CHAINABLE_FROM` is the table that says so, in
     * shared/host-ops.ts where the offer rule lives.
     *
     * ONLY HOST NODES ARE ASKED. A ledger step cannot be in a failed state — a
     * step exists because something landed — so this is a question about the one
     * kind of row that carries somebody else's queue state.
     */
    if (row.node !== null && !CHAINABLE_FROM[row.node.state]) return out;
    for (const offer of this.hostOps.offersFor(row.produces)) {
      out.push({
        id: `host:${offer.id}`,
        label: offer.label,
        icon: iconForHostKind(offer.kind),
        audio: true,
        host: offer.id,
        form: offer.form !== undefined,
        hint: `${offer.label} — handled by the app Foundry is running inside`,
      });
    }
    return out;
  });

  /**
   * A document is not a route. The router still owns Settings, so clicking a row
   * from the settings screen navigates back to the workspace first — the
   * document is what a row means, and it cannot be shown on a page that is not
   * showing documents.
   */
  protected pick(tab: Tab): void {
    void this.router.navigateByUrl('/');
    this.stage.reveal(tab.id);
  }

  /**
   * A click on any kind of card.
   *
   * A STEP MOVES THE POSITION and everything else follows: main resolves what
   * that step shows and the panes are told (`ledger:go` → `showPosition`). It
   * costs nothing, asks nothing and throws nothing away — the promise every
   * history panel makes by looking like one, now made by the navigator itself.
   *
   * A HOST NODE MOVES NOTHING. There is no position to go to — it is somebody
   * else's job, and the ledger has never heard of it — so the click does the one
   * half that still means something: it selects the card, which opens its "from
   * here" footer. That is what makes a QUEUED node chainable, which was the
   * ruling: the user can order the next act against an artifact that does not
   * exist yet, and the host is handed the pending node's id to hang it on.
   *
   * A FILE ROW puts a document in front of you: revealing it if it is open,
   * opening it if it is not, and doing nothing at all for a file this app has no
   * tab for. The first two are deliberately the same gesture — from the user's
   * side both cards say "put this in front of me", and whether that costs a tab
   * or merely a focus change is bookkeeping, not their question.
   *
   * ── AND IT REPLACES WHAT THE VIEWER WAS SHOWING ─────────────────────────────
   *
   * *"clicking another file will automatically close the one i was looking at and
   * open the one i just clicked, unless i pin the file by right-clicking the
   * chrome-style tab at the top."* This panel is the list that ruling is about,
   * and it used to be the only caller that passed a `replace` flag — everything
   * else (a drop, a finished job, a step's own document) joined the column's
   * strip instead, because none of them is a person saying "that one instead of
   * this one". With one viewer, replacing what is on screen is the only thing any
   * of them can do, so the flag is gone and the rule is the app's. What went with
   * it is the exception the sentence names: there is no pin, because there is no
   * strip for a pin to protect a place in.
   */
  protected pickRow(row: Row): void {
    if (row.kind === 'host') {
      this.picked.set(row.key);
      return;
    }
    if (row.kind === 'root' || row.kind === 'step') {
      this.picked.set(row.key);
      void this.stand(row);
      return;
    }
    /*
     * AN EXPORT ROW TAKES THE SELECTION NOW; every other file row still clears
     * it.
     *
     * The clearing covered every file on the argument that "nothing is ever
     * made from an export" — true for as long as only this app's own acts
     * existed, and FALSE since `export` became a currency (Wave 10): a
     * narration is made from an export, the offer correctly lands on this
     * row, and the selection is the only gesture that unrolls the footer the
     * offer lives in. Owen hit the gap within minutes of the member landing —
     * *"theres no narration step available to press under the epub i
     * generated"* — because the rule was right and no click could reach it.
     * The press still does everything it did (open the proof sheet, reveal
     * the file); the selection rides along, exactly the pairing a step's
     * click has always had. A COPY still clears: nothing is made from one,
     * which is the old sentence still true of the rows it still covers.
     */
    this.picked.set(row.kind === 'export' ? row.key : null);
    if (row.tab !== null) {
      this.pick(row.tab);
      return;
    }
    if (row.openable !== true) {
      /*
       * A CARD THIS APP HAS NO TAB FOR STILL ANSWERS THE CLICK. An EPUB or txt
       * export used to eat the press — no viewer, so nothing happened — and a
       * person who just exported clicked it expecting to be taken to the file
       * (user report, 2026-08-16). "Put this in front of me" for a finished
       * file with no tab means the file manager: the same reveal the context
       * menu offers, promoted to the click, because a dead left-click teaches
       * people the card is furniture.
       */
      if (row.kind === 'export') {
        /*
         * The click model is the user's (2026-08-16): an exported BOOK opens in
         * a tab — the proof sheet locked to the Final version over the file
         * itself — and Ctrl+S there saves a copy. Plain text still reveals: it
         * has no book inside it to show.
         */
        if (row.path.toLowerCase().endsWith('.epub')) {
          this.documents.openExportView(row.path, row.title);
        } else {
          void api?.reveal(row.path);
        }
      }
      return;
    }
    void this.router.navigateByUrl('/');
    void this.documents.openFromList(row.path, row.managed === true);
  }

  /**
   * Press one of the acts in a card's footer.
   *
   * ── Foundry's own three: STAND, THEN OPEN THE DOCK'S OWN DIALOG ─────────────
   *
   * The dialogs act on the POSITION — that is how aiming has always worked in
   * this app, and it is why there is no second targeting mechanism here. So the
   * footer's Translate stands on its own card first and then opens exactly the
   * dialog the dock opens. The stand is very nearly always a no-op (clicking the
   * card is what opened the footer, and clicking a node stands on it), and it is
   * made anyway because "very nearly always" is not a thing to leave a dialog's
   * aim resting on.
   *
   * ── The host's: NAME THE NODE, AND ASK ITS QUESTIONS IN THIS WINDOW ────────
   *
   * Nothing is stood on. Main hands the host the project and the id of the node
   * the footer belongs to — a ledger step id, one of the host's own node ids when
   * the act was chained onto work that has not finished, or the step an EXPORT
   * was made from — and the host takes it from there, into its own queue. What
   * comes back is either nothing or a rejection, and a rejection is the host's
   * sentence: it goes on the notice strip verbatim, because a button that appears
   * to do nothing is the one outcome this socket must not have.
   *
   * ── AND THE MODAL IS OURS NOW, WHERE THE ACT HAS ONE ───────────────────────
   *
   * *"Owen wants the dialog in the Foundry window, like translate/simplify."* An
   * operation that declared a `form` opens `app-host-op-dialog` — Foundry's own
   * card, drawn from the host's fields, invoking on Start. One that declared none
   * invokes on this click exactly as every operation did before, which is the
   * compatibility promise stated where it is kept.
   */
  protected run(event: MouseEvent, row: Row, act: Act): void {
    // Without this the click also lands on the card, which for a step would
    // re-stand it and for a host node would do nothing — but both of them would
    // fire while a dialog was opening over the top.
    event.stopPropagation();
    if (act.host !== null) {
      if (row.dir === null) return;
      const nodeId = this.nodeIdFor(row);
      if (nodeId === null) return;
      if (act.form) {
        this.ui.openHostOp({ operationId: act.host, projectDir: row.dir, nodeId });
        return;
      }
      void this.hostOps.invoke(act.host, row.dir, nodeId).catch((err: unknown) => {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    void this.stand(row).then(() => {
      void this.router.navigateByUrl('/');
      if (act.id === 'read') this.ui.openOcr();
      else if (act.id === 'translate') this.ui.openTranslate();
      else if (act.id === 'simplify') this.ui.openSimplify();
      else this.ui.openExport();
    });
  }

  /**
   * THE MOST PRECISE NODE ID THIS ROW CAN HONESTLY NAME.
   *
   * ── Three answers, in order of how much they know ──────────────────────────
   *
   * A HOST NODE names itself: the host minted the id, so chaining onto work that
   * has not finished is expressed by handing the id straight back.
   *
   * A POSITION names its step. That is what "from here" has always sent, and the
   * host resolves it against whatever mapping it keeps.
   *
   * AN EXPORT names THE STEP IT WAS MADE FROM (`Row.madeFrom`), which is the
   * whole point of 9a: *"narrate on a step should mean 'the export made from this
   * step's state'."* With the provenance recorded, invoking from an export row
   * gives the host a precise target for free.
   *
   * ── AND THE FALLBACK, WHICH IS DELIBERATELY NOT A GUESS ────────────────────
   *
   * An export written before `ProjectFinal.stepId` existed has no provenance, and
   * this sends THE STEP THE BOOK IS STANDING ON. That is not a claim that the
   * export came from there — it did not necessarily — it is the id that pressing
   * the act on the tree a moment earlier would have sent, which is exactly the
   * input the host's own fallback was written against: *"absent stepId = today's
   * behavior (unique-export-or-refuse)."* Sending nothing would take the feature
   * away from every book exported before this wave; sending the root would be a
   * fabricated provenance. Sending the position is honest about being a fallback
   * and preserves the behaviour the letter asked to preserve.
   *
   * NULL WHEN THERE IS NOTHING AT ALL, and the caller draws no button rather than
   * one that cannot say what it would act on.
   */
  private nodeIdFor(row: Row): string | null {
    if (row.node !== null) return row.node.id;
    if (row.step !== null) return row.step.id;
    /*
     * AN EXPORT ROW NAMES ITSELF, and this line is Owen's third ruling.
     *
     * It used to answer `madeFrom` — the STEP the export was made from — which
     * was the most precise thing it could say before the row had a name of its
     * own, and which is exactly why the ghost rows landed on "Applied changes":
     * the host echoes the invoke's nodeId into every node it pushes back, so a
     * press that said "the step" produced narrations parented on the step. The
     * row has a name now (`exportNodeId`), so the press says the export and the
     * work comes back hanging under it.
     *
     * `madeFrom` STAYS BELOW AS THE FALLBACK, for a row that somehow has no
     * name — which cannot happen for an export today and costs one line to
     * survive if a future row kind grows a provenance without one.
     */
    if (row.nodeId !== null) return row.nodeId;
    if (row.madeFrom !== null) return row.madeFrom;
    if (row.dir === null) return null;
    return this.ledger.standingIn(row.dir)?.id ?? null;
  }

  /**
   * RETRY OR DISMISS A HOST NODE THAT FAILED — the pair a failed card wears
   * instead of a "from here" footer.
   *
   * *"Failed nodes want `Retry` and `Dismiss` instead."* Foundry does neither
   * itself: it tells the host, and the row re-runs or leaves on the next push of
   * that project's nodes, which is how every other fact about a host node
   * arrives. The rejection is said on the strip, where this panel says everything
   * a host refused.
   */
  protected async act(event: MouseEvent, row: Row, action: HostNodeAction): Promise<void> {
    event.stopPropagation();
    if (row.dir === null || row.node === null) return;
    try {
      await this.hostOps.nodeAction(row.dir, row.node.id, action);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Whether this card draws Retry and Dismiss.
   *
   * BOTH HALVES, AND THE SECOND IS THE ONE THAT MATTERS. A failed node is the
   * only place they belong; a host that never registered `onNodeAction` is the
   * case where drawing them would produce a button that refuses — *"a button that
   * silently does nothing is the socket's one forbidden outcome"* — so the probe
   * rides on the mount-time offers answer and is asked here.
   */
  protected canAct(row: Row): boolean {
    return row.node !== null && row.node.state === 'failed' && this.hostOps.takesNodeActions();
  }

  /**
   * Stand on the step this card names — the gesture that used to live on a Steps
   * row in the inspector (docs/WORKBENCH.md §6c: the section moved here whole).
   *
   * FREE, INSTANT AND UNCONFIRMED — one line of the manifest, no job, no
   * rendering, no question asked.
   *
   * The card already being current is not a no-op worth guarding: main answers
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
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Fold a node shut, or open it. The click must not also stand on the card. */
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
    for (const id of [...group.tabIds]) void this.documents.close(id);
  }

  /**
   * The visible door onto that — the ✕ that appears on a root card under the
   * pointer. Same gesture as the right-click's Close book, and deliberately the
   * same CALL: it goes through the menu's own dispatch rather than looking a
   * group up for itself, because finding the book from a root row is the part
   * that can quietly be got wrong (the row's path is the project's directory,
   * matched case-folded), and a second copy of that is a second thing to keep
   * true. `fromMenu` closing a menu that is not open costs a signal write.
   *
   * `stopPropagation` because the click would otherwise land on the card as well
   * and stand the project on its import — moving the position of a book on its
   * way out of the library.
   */
  protected closeBook(event: MouseEvent, row: Row): void {
    event.stopPropagation();
    this.fromMenu(row, 'close-project');
  }

  /**
   * Delete the document this card names — the file, its catalogue row, and its
   * project if it turns out to be the original.
   *
   * Every branch of that is main's to decide and the modal's to ask; this hands
   * over a path and says whatever comes back.
   */
  protected async remove(event: MouseEvent, row: Row): Promise<void> {
    // Without this the click also lands on the card and opens the document that
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
        // Without asking: see `OpenDocumentsService.close`. The delete's own card is the
        // question, and it has already been answered yes. RETURNED rather than
        // voided, so the delete waits for this window to let go of the file.
        if (row.tab === null) return undefined;
        return this.documents.close(row.tab.id, false);
      });
      if (said !== null) this.notices.notice.set(said);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /*
   * `openInSplit` LIVED HERE — the right-click's "Open in split", moved in from
   * the inspector's Steps section and built as two acts arriving as one: leave an
   * intention with the tabs service, move the pointer, and let the answer main sends
   * back (which only arrives asynchronously, inside the effect that watches the
   * position) open into a NEW COLUMN instead of into the one in front. There was
   * a second door for the card you were already standing on, because `go` on your
   * own position moves nothing and the intention would have been inherited by the
   * next step somebody clicked.
   *
   * All of it is gone with the columns (docs/PLAN.md §4, unit 8b). The need it
   * served comes back as Compare on the viewer (unit 8d), and the awkward part —
   * "what does that step even show?" — is answered there by main the same way,
   * without an intention having to survive a round trip.
   */

  /**
   * Delete this step. Main says what it costs, the app's own card asks, main
   * does it. Moved here from the inspector's Steps ✕ (docs/WORKBENCH.md §6c),
   * where it was a button on the row; it is behind the right-click now because a
   * step card wears no ✕ — the visible ✕ in this panel closes or deletes a FILE,
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
      await this.ledger.remove(row.dir, row.step.id, (files) => this.documents.closeShowing(files));
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Right-click: whatever this kind of card can be asked to do.
   *
   * NOTHING, ON A HOST'S NODE. Delete, reveal and close are all acts on
   * something Foundry owns; a job in another application's queue is none of
   * those, and a menu that opened with nothing safe in it would be worse than no
   * menu. The default browser menu is suppressed either way, so a right-click
   * there is simply nothing.
   */
  protected onMenu(event: MouseEvent, row: Row): void {
    event.preventDefault();
    event.stopPropagation();
    if (row.kind === 'host') return;
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
          this.notices.notice.set(err instanceof Error ? err.message : String(err));
        });
        return;
      case 'view':
        this.documents.openExportView(row.path, row.title);
        return;
      case 'close':
        if (row.tab !== null) void this.documents.close(row.tab.id);
        return;
      case 'close-project': {
        const group = this.groups().find((one) => fold(one.dir) === fold(row.path));
        if (group !== undefined) this.closeProject(group);
        return;
      }
      case 'discard':
        void this.discard(row);
        return;
      case 'delete':
        void this.remove(new MouseEvent('click'), row);
    }
  }

  protected close(event: MouseEvent, tab: Tab | null): void {
    if (tab === null) return;
    // Without this the click also lands on the card and reveals what is about to
    // be closed, which flashes the document on screen for one frame.
    event.stopPropagation();
    void this.documents.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag scroll is not a close. */
  protected onAux(event: MouseEvent, tab: Tab | null): void {
    if (tab === null || event.button !== 1) return;
    event.preventDefault();
    void this.documents.close(tab.id);
  }

  // ── Dragging a row ───────────────────────────────────────────────────────

  protected onDragStart(event: DragEvent, tab: Tab | null): void {
    // A step or host card has no tab to carry, and the drop handler below is
    // written against a tab id. Standing on the step is what puts it on screen;
    // a host's job has nothing to put anywhere.
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
    /*
     * IT USED TO RAISE A SHIELD OVER THE WORKSPACE — a `draggingDocument`
     * signal on the old tabs service, a transparent sheet over every pane,
     * because a rendered
     * chapter is an <iframe> and a drag over one is delivered to the frame rather
     * than to the pane the user is aiming at. The drop it existed for (a row onto
     * a column) has nowhere to land now that there is one viewer, so the shield
     * and the signal that raised it are both gone (docs/PLAN.md §4, unit 8b) and
     * nothing in this app ever has a sheet of glass over it. What is left of this
     * drag is entirely inside this panel: the loose files' reorder.
     */
  }

  protected onDragEnd(): void {
    this.before.set(null);
    this.landing.set(false);
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
     * A CARD INSIDE A BOOK IS NOT AN INSERTION POINT. Its order is the ledger's
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
   * pointer was lifted. The refusal used to end by naming the gesture that WAS
   * available — dragging it onto the workspace to open it in a column — and with
   * one viewer that gesture is a click, which is what the sentence says now.
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
    const moving = this.documents.byId(id);
    if (moving === null) return;
    if ((onto !== null && onto.dir !== null) || this.inBook(moving.id)) {
      this.notices.notice.set(
        'Documents in a book are listed in the order it holds them, so they cannot be reordered '
        + 'here. Click one to open it.',
      );
      return;
    }
    // No navigation: a reorder is bookkeeping about the list, not a request to
    // look at something, so it leaves a person on Settings where they were.
    this.documents.reorder(id, target);
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
   * are the only ones this has to index into: a drop over a book's card is
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
   * What a file card says when you rest on it — the whole of what a document's
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

/** What a right-click can offer, across the four kinds of row that have one. */
type MenuAction = 'reveal' | 'save-copy' | 'view' | 'close' | 'delete' | 'close-project' | 'discard';

/**
 * ONE ACT OFFERED IN A CARD'S FOOTER — ours or the host's, drawn identically and
 * dispatched differently.
 *
 * `host` IS THE DISCRIMINANT and it is a string rather than a boolean because it
 * is also the thing `run` needs: null means one of Foundry's own three, in which
 * case `id` names which dialog to open; anything else is the host's operation id,
 * which is exactly what `host-ops:invoke` takes.
 */
interface Act {
  /** Unique in the footer. Foundry's are `translate`/`simplify`/`export`. */
  id: string;
  label: string;
  /** A symbol in the sheet at the top of the template. */
  icon: string;
  /** Drawn in the host's amber rather than in the accent. */
  audio: boolean;
  /** The host operation to invoke, or null for one of this app's own acts. */
  host: string | null;
  /**
   * True when the host declared a `form` for it, so pressing opens Foundry's own
   * dialog instead of running immediately (`HostOperationOffer.form`). Always
   * false for this app's own three, which have dialogs of their own.
   */
  form: boolean;
  /** The hover sentence — the only place a footer button explains itself. */
  hint: string;
}

const NO_ACTS: readonly Act[] = [];

/** One ancestor's lane, in the row's own drawn lineage. See `drawLineage`. */
interface Lane {
  /** Whether that ancestor still has something below this row to reach. */
  line: boolean;
  /** Dashed when what it reaches down to has not happened yet. */
  dashed: boolean;
  /** True in the LAST lane of the first card of an indented run. */
  elbow: boolean;
}

/**
 * One drawn card of the library.
 *
 * FIVE KINDS, ONE SHAPE. A `root` and a `step` are POSITIONS — clicking one
 * moves where the book stands — and carry a `step`; an `export` and a `document`
 * are FILES and carry a tab when something has opened them; a `host` is a job in
 * somebody else's queue and carries a `node`. The template draws them all and
 * the gestures fork on `kind`, which is the one fact that decides everything
 * else about a card.
 */
interface Row {
  /** Unique in the list: a tab id, or the book's key and what the row names. */
  key: string;
  kind: RowKind;
  /** The open tab, for the rows that are files. Always null on a position. */
  tab: Tab | null;
  /** A file for the rows that are files; the book's own directory for a position. */
  path: string;
  /**
   * The card's first line — a SENTENCE about what happened, derived from the
   * action and its params, never `LedgerStep.label` (see `titleForStep`).
   */
  title: string;
  /**
   * The parent's title, for the lineage line: "from **Applied changes**". Null
   * where there is no honest parent to name — the import, an export, a loose
   * file — and those say `said` instead.
   */
  from: string | null;
  /** One extra fact in front of the lineage: "41 edits", "312 pages". */
  fact: string | null;
  /** What this IS, for a card with no lineage to claim. */
  said: string | null;
  /** The right-hand slot: a date, or the host's own word about where it is up to. */
  state: string | null;
  /** A symbol id from the sheet at the top of the template. */
  icon: string;
  /** Which tint the icon square wears: this app's accent, the host's amber, or neither. */
  tint: 'plain' | 'text' | 'audio';
  /** Which state the dot draws. See the dot's styles. */
  dot: DotState;
  /** A running host node's live counting, or null. */
  progress: HostNodeProgress | null;
  /** A failed host node's sentence, drawn on a line of its own. */
  why: string | null;
  tooltip: string;
  /** How far in the tree. 0 for a root and for a loose file. */
  depth: number;
  /** The book this row belongs to. Null for a loose file, and only for that. */
  dir: string | null;
  /** The step a root or a step card names, when the history has arrived. */
  step: LedgerStep | null;
  /**
   * THE STEP AN EXPORT WAS MADE FROM — its provenance, and not its position.
   *
   * ── Why it is not `step` above ──────────────────────────────────────────────
   *
   * `step` is the row's OWN position: a thing you can stand on, delete, and act
   * from, and every gesture in this panel that reads it means exactly that. An
   * export has no position — it is terminal, *"it wont go into the working files
   * as a step because it isnt the base for new steps"* — but it does have a
   * PROVENANCE, which is the row of the ledger whose state it replayed. Two
   * different facts; putting them in one field would make a right-click on an
   * export offer to delete the step that produced it.
   *
   * NULL FOR EVERY EXPORT WRITTEN BEFORE `ProjectFinal.stepId` EXISTED, which is
   * an unknown provenance rather than none — see `run` for what the invoke sends
   * in that case.
   */
  madeFrom: string | null;
  /**
   * WHAT A PRESS ON THIS ROW NAMES ITSELF AS, when the row is a thing a host
   * act can be ordered from and is not a ledger step.
   *
   * Today that is export rows alone (`exportNodeId`). A step names itself by its
   * own id and a host node by the host's, both of which `nodeIdFor` reads
   * directly off the row — this field exists for the one kind of row whose
   * identity is a catalogue file rather than a record with an id.
   */
  nodeId: string | null;
  /** The host's own row, for `kind === 'host'`. Null everywhere else. */
  node: HostNode | null;
  /**
   * WHAT CAN BE MADE FROM HERE — the whole gate on the "from here" footer.
   * Null means nothing can: a terminal file, a loose one, or a position with no
   * book behind it yet.
   */
  produces: NodeOutput | null;
  /** True on the one card the book is standing on. */
  current: boolean;
  /** True for a step made from something that has been replaced since. */
  stale: boolean;
  /** True for a node that has not happened yet: dashed line, hollow dot. */
  planned: boolean;
  /** Null when the card can never have children; otherwise whether it is open. */
  expanded: boolean | null;
  /** File rows only: false for a missing file and for `.txt`. */
  openable?: boolean;
  /** File rows only: whether the tab it opens wears the unsaved dot. */
  managed?: boolean;
  /**
   * True while this is the document IN THE VIEWER.
   *
   * It had a `column` beside it — 1…5, counted left to right, null when the
   * document was in none — and the two together were how the panel said "on
   * screen somewhere" and "on screen where a chord will land". One viewer makes
   * them one fact (docs/PLAN.md §4, unit 8b).
   */
  focused: boolean;
  // ── The drawn lineage, filled in by `drawLineage` once the group is whole ──
  /** One per ancestor level, outermost first. */
  lanes: readonly Lane[];
  /** Whether this card's own lane comes down from above into its dot. */
  up: boolean;
  /** Whether it continues below — to a sibling, or into a child's elbow. */
  down: boolean;
  /** Dashed when the thing that segment reaches has not happened yet. */
  downDashed: boolean;
}

type RowKind = 'root' | 'step' | 'export' | 'document' | 'host';

type DotState = 'source' | 'done' | 'running' | 'queued' | 'failed' | 'file';

/**
 * The fields every row has and most rows do not set.
 *
 * ONE DEFAULT AND NOT SIX LITERALS: a row is built in six places here, and
 * without this each of them would have to remember to say `stale: false` — which
 * they would, until somebody added a field, and then exactly one of them would
 * be missing it and exactly one kind of row would draw wrong.
 *
 * THE LINEAGE DEFAULTS TO NOTHING DRAWN, which is what the loose list wants: it
 * never goes through `drawLineage`, so a file opened from somewhere else gets a
 * card with a plain dot and no thread, and no relationship is asserted between
 * two of them.
 */
const blank = {
  tab: null,
  step: null,
  node: null,
  from: null,
  fact: null,
  said: null,
  state: null,
  icon: 'ft-page',
  tint: 'plain',
  dot: 'file',
  progress: null,
  why: null,
  produces: null,
  madeFrom: null,
  nodeId: null,
  depth: 0,
  dir: null,
  current: false,
  stale: false,
  planned: false,
  expanded: null,
  focused: false,
  lanes: [],
  up: false,
  down: false,
  downDashed: false,
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

/**
 * ONE ROW FOR ONE THING THE HOST IS MAKING.
 *
 * Everything on it is the host's except the lineage line, which is Foundry's:
 * the host names a parent step and this composes "from **The book**" out of that
 * step's own title, in the same words every other card uses. A host writing its
 * own lineage sentence would be a second voice in a panel whose whole redesign
 * was about having one.
 *
 * THE STATE SLOT AND THE SENTENCE ARE THE SAME FIELD, spent differently. A
 * host's `detail` is a short piece of news while it is short news ("queued · 2nd
 * in line") and a sentence when it is a failure — so it goes to the right of the
 * title in the first case and onto a line of its own in the second, where there
 * is room to read it. Running, the slot shows the percentage instead, because a
 * number that changes is what the eye goes to and the message is already on the
 * progress line underneath.
 */
/**
 * One of the host's own rows.
 *
 * `parentName` IS RESOLVED BY THE CALLER RATHER THAN A STEP RESOLVED HERE, and
 * the change is Owen's third ruling arriving: a narration can now hang under an
 * EXPORT ROW, which is not a `LedgerStep` and never will be. Asking for the
 * words rather than for the record is what lets one function draw a ghost under
 * a step, under the import, and under a finished file — see `parentNameOf` for
 * the step half, which is the sentence this function used to compose itself.
 */
function hostRow(project: ProjectSummary, node: HostNode, parentName: string | null, depth: number): Row {
  const failed = node.state === 'failed';
  const running = node.state === 'running';
  return {
    ...blank,
    key: `${project.key}:host:${node.id}`,
    kind: 'host',
    path: project.dir,
    title: node.title,
    // The parent named the same way a ledger child names it — and a node hung
    // off the IMPORT says the book's own name, because that is what the root's
    // card says and a lineage line has to point at something the reader can see.
    from: parentName,
    // A card with a lineage line does not also say what it is: the line already
    // said where it came from, and the host's own sentence rides in `state`.
    said: parentName === null ? node.detail : null,
    state: running && node.progress !== undefined
      ? `${Math.round(node.progress.percent)}%`
      : failed ? 'failed' : node.detail,
    why: failed ? node.detail : null,
    progress: running && node.progress !== undefined ? node.progress : null,
    icon: iconForHostKind(node.kind),
    tint: 'audio',
    // The four host states ARE four of the dot's six, spelled the same way on
    // purpose: the grammar in the mockup and the grammar in the contract are one
    // vocabulary, so this is a pass-through rather than a mapping table that
    // could disagree with either.
    dot: node.state,
    tooltip: `${node.title}\n${node.detail}\n`
      + 'Made by the app Foundry is running inside — it is not a step in this book’s history.',
    depth,
    dir: project.dir,
    node,
    // WHAT IT WILL PRODUCE, not what it has produced — which is exactly what
    // makes a queued node chainable: the host's next act is offered against an
    // artifact that does not exist yet.
    produces: PRODUCES_OF[node.kind],
    planned: node.state === 'queued',
    expanded: null,
  };
}

/**
 * What a ghost hung under a LEDGER row calls its parent.
 *
 * A node hung off the IMPORT says the book's own name, because that is what the
 * root's card says and a lineage line has to point at something the reader can
 * see; every other step says its own derived title. Lifted out of `hostRow` when
 * that function stopped being able to assume its parent was a step at all.
 */
function parentNameOf(project: ProjectSummary, step: LedgerStep | null): string | null {
  if (step === null) return null;
  return step.parent === null ? project.title : titleForStep(step);
}

/**
 * THE DRAWN LINEAGE, in one backward pass over a book's finished row list.
 *
 * ── What has to be decided, per row ─────────────────────────────────────────
 *
 * Three things, and all three are questions about what comes AFTER the row: does
 * this card's own lane continue below it (a sibling, or a child's elbow to feed);
 * which ANCESTOR lanes are still running past it on their way to something of
 * their own; and is the thing any of those reach down to a plan rather than a
 * fact, which is what decides solid against dashed.
 *
 * Backwards is the only direction those are cheap in. `nextAt[d]` holds the
 * nearest row below at depth `d` that is still reachable — reachable meaning no
 * row shallower than `d` sits between, because a shallower row ENDS every lane
 * deeper than itself. Walking up, each row reads that array for its answer and
 * then rewrites it: everything deeper than this row is now cut off, and this row
 * is now the nearest thing at its own depth.
 *
 * ── Why the rows are mutated rather than rebuilt ────────────────────────────
 *
 * Every row here was built moments ago inside the same computed — six object
 * literals, none of them shared with anything and none of them escaping until
 * this returns — so a copy would be a second allocation per row to protect a
 * value nobody else has seen yet.
 */
function drawLineage(rows: Row[]): Row[] {
  const nextAt: (Row | null)[] = [];
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at]!;
    const below = rows[at + 1] ?? null;
    const hasChild = below !== null && below.depth > row.depth;
    const sibling = nextAt[row.depth] ?? null;

    /*
     * THE ANCESTORS' LANES, outermost first. A lane is drawn where that ancestor
     * still has a sibling of its own waiting below — which is what makes a
     * translation's saves legible as being inside the translation while the
     * book's own line runs past them to the next thing made from the book.
     */
    const lanes: Lane[] = [];
    for (let level = 0; level < row.depth; level += 1) {
      const carries = nextAt[level] ?? null;
      lanes.push({
        line: carries !== null,
        dashed: carries?.planned === true,
        // The elbow belongs to the first card of an indented run and to no
        // other: every sibling after it joins the lane's own vertical instead.
        elbow: level === row.depth - 1 && (at === 0 || rows[at - 1]!.depth < row.depth),
      });
    }
    row.lanes = lanes;
    row.up = row.depth > 0 && !(lanes[row.depth - 1]?.elbow ?? false);
    /*
     * DOWN IS FED BY WHICHEVER COMES FIRST — a child's elbow hangs off this
     * card's own lane, and so does a sibling, so the segment is drawn if either
     * exists. Its dash follows the one it actually reaches: a running narration
     * with a queued assemble under it draws a dashed line down to it, which is
     * the whole "solid is what exists, dashed is the plan" grammar in one row.
     */
    const reaches = hasChild ? below : sibling;
    row.down = reaches !== null;
    row.downDashed = reaches?.planned === true;

    for (let deeper = row.depth + 1; deeper < nextAt.length; deeper += 1) nextAt[deeper] = null;
    nextAt[row.depth] = row;
  }
  return rows;
}

/**
 * Is this open document inside this project — or IS it this project?
 *
 * THE SECOND HALF IS THE BOOK TAB, and it is the one tab in this app whose path
 * is a directory rather than a file (`TabKind`, core/documents.service.ts). Every
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
 * WHAT THE BOOK ARRIVED AS, on the root card's second line.
 *
 * BY EXTENSION AND NOT BY NAME. The house rule forbids matching a basename
 * across directories; reading the last few characters of `archive/Book.pdf` to
 * decide between three sentences is not matching anything, and it is the only
 * fact about the original this panel needs.
 *
 * IT IS ALSO WHY THE ROOT KEEPS THE BOOK'S NAME AS ITS TITLE. The design mockup
 * put "The scan" on this card and the book's name in a header above the tree;
 * this panel has no header — the group's own ruling removed it when the import
 * root took its place — so the two facts swap slots. The name is the title,
 * because it is the one thing that must never leave the panel; what it arrived
 * as is the sentence underneath.
 */
function arrivalSentence(payload: string): string {
  const ext = extensionOf(payload);
  if (ext === 'epub') return 'the book it all started from';
  if (ext === 'txt') return 'the text it all started from';
  return 'the scan it all started from';
}

function iconForArrival(payload: string): string {
  const ext = extensionOf(payload);
  return ext === 'epub' ? 'ft-book' : ext === 'txt' ? 'ft-page' : 'ft-scan';
}

function extensionOf(payload: string): string {
  const dot = payload.lastIndexOf('.');
  return dot < 0 ? '' : payload.slice(dot + 1).toLowerCase();
}

function iconForTab(tab: Tab): string {
  // The book wears the reading's own mark, because the book IS the reading — the
  // same symbol `iconForStep` gives the card that opens it.
  return tab.kind === 'book' ? 'ft-book' : 'ft-page';
}

/**
 * WHAT A STEP LOOKS LIKE — the action, at a glance.
 *
 * The reading wears the book's own mark because the reading IS the book; a save
 * wears the pen this app uses everywhere for "edited"; a translation wears the
 * globe and a rewrite the spark, which is the same pair the "from here" footer
 * puts on Translate and Simplify, so the button and the card it makes are
 * recognisably one act. Nothing here is load-bearing: the title beside it says
 * the same thing in words, and the icon is what makes a tree of twenty cards
 * scannable.
 */
function iconForStep(step: LedgerStep): string {
  if (step.action === 'read') return 'ft-book';
  if (step.action === 'curate' || step.action === 'edit') return 'ft-pen';
  if (step.action === 'translate') return step.params?.rewrite === undefined ? 'ft-globe' : 'ft-spark';
  if (step.action === 'metadata') return 'ft-tag';
  return 'ft-scan';
}

/** The host's three acts, and the marks they wear on cards and on buttons alike. */
function iconForHostKind(kind: HostNode['kind']): string {
  if (kind === 'narrate') return 'ft-mic';
  if (kind === 'enhance') return 'ft-wave';
  return 'ft-disc';
}

/**
 * WHAT HAPPENED, AS A SENTENCE — the card's title.
 *
 * ── Derived here, and the stored label left exactly where it is ─────────────
 *
 * `LedgerStep.label` is what this app called the act at the moment it happened,
 * and `labelFor` refuses to rewrite one afterwards for a reason that has not
 * changed: *"rewriting a person's history to tidy the app's own naming would be
 * editing the record of what happened to their book"*. So nothing here touches
 * it — the tooltip still says it, verbatim, and a project that has been through
 * three of this app's vocabularies still holds three spellings.
 *
 * What a CARD needs is a different thing: a sentence a person recognises as the
 * act they ordered. "Translated (de)" is a notation — correct, and unreadable to
 * anybody who has not learned that `de` is German. So the card composes from the
 * two things the step already carries, its `action` and its `params`, and every
 * word of it is honest to what was recorded: the language name is the one the
 * dialog itself offered (`languageNameFor`, the same table `LANGUAGE_CHOICES`
 * is built from), and the rewrite phrase is the one the Simplify dialog printed
 * over the card that was pressed.
 *
 * A PARAM NOBODY WROTE DOWN SHORTENS THE SENTENCE RATHER THAN INVENTING ONE. An
 * old translation with no `language` says "Translated", because that is all the
 * ledger knows and a guess would be this panel making something up about a book.
 */
function titleForStep(step: LedgerStep): string {
  switch (step.action) {
    case 'import':
      return 'The original';
    /*
     * THE READING IS THE BOOK, which is the ruling this title has always kept:
     * *"we shouldnt call the working files 'epub' until we export"* — the thing
     * a reading makes is the Book, and standing on this card is what opens it.
     * It is a noun where the others are past tenses, on the mockup's own
     * precedent ("The scan"), because what a person wants from this card is the
     * artifact and not the act.
     */
    case 'read':
      return 'The book';
    case 'curate':
    case 'edit':
      return 'Applied changes';
    case 'metadata':
      return metadataSentence(step.params);
    default:
      return translateSentence(step.params);
  }
}

/**
 * "Translated into German", "Simplified into plain terms".
 *
 * A REWRITE NEVER NAMES A LANGUAGE, and that is the shape of the act rather than
 * a shortening: it happens IN the book's own language, so both ends are the same
 * tag and "Simplified into plain terms (de)" would spend the card's one line on
 * the half of the sentence that is not the answer. Which of the three modes it
 * was IS the answer, and it is what the row says. (A project holding a German
 * rewrite and an English one tells them apart by the branch they hang on, which
 * is the thing the drawn lineage now makes visible.)
 */
function translateSentence(params: LedgerParams | undefined): string {
  const rewrite = params?.rewrite;
  if (rewrite !== undefined) return REWRITTEN_AS[rewrite];
  const into = params?.language ?? '';
  return into.length === 0 ? 'Translated' : `Translated into ${languageNameFor(into)}`;
}

/**
 * The three rewrites, as sentences.
 *
 * THE SAME WORDS THE DIALOG PRINTED. `REWRITE_LABELS` (shared/ledger.ts) holds
 * "plain terms", "natural voice" and "easy language" — the reader's phrases,
 * chosen once so that a row is recognisable as the card somebody pressed — and
 * these are those phrases with a verb in front. Two tables rather than one
 * composed string because "Simplified into natural voice" is not English and the
 * middle one has to say it differently.
 */
const REWRITTEN_AS: Readonly<Record<NonNullable<LedgerParams['rewrite']>, string>> = {
  dejargon: 'Simplified into plain terms',
  destiffen: 'Said again in a natural voice',
  learner: 'Rewritten in easy language',
};

/**
 * "Set the title and author" — a metadata step, in words.
 *
 * THE FIELDS AND NOT THE VALUES, which is the line `LedgerParams.fields` is
 * drawn on and this inherits without restating the argument: what was actually
 * written is the step's payload, and a card is not a place to keep a second copy
 * of it. Past a few names the list stops being scannable and the plain sentence
 * is the honest answer — the same threshold `labelFor` uses, for the same
 * reason.
 */
function metadataSentence(params: LedgerParams | undefined): string {
  const said = params?.fields ?? [];
  if (said.length === 0 || said.length > 3) return 'Set the book’s own record';
  const printed = said.length === 1
    ? said[0]!
    : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]!}`;
  return printed.length > 34 ? 'Set the book’s own record' : `Set the ${printed}`;
}

/**
 * The extra fact in front of the lineage line: "41 edits · from **The scan**".
 *
 * ONLY WHERE THE STEP ALREADY COUNTED IT. These are `params` the run wrote down
 * for its own row's sentence and nothing else (`LedgerParams.pages`, `.ops`,
 * `.amendments`), so a step from before they were recorded simply has no prefix
 * — which is the correct outcome, and the reason none of this is derived by
 * opening a file.
 */
function factForStep(step: LedgerStep): string | null {
  const params = step.params;
  if (step.action === 'read') {
    return params?.pages === undefined || params.pages <= 0 ? null : `${params.pages} pages`;
  }
  if (step.action === 'edit') {
    return params?.ops === undefined || params.ops <= 0 ? null : `${params.ops} edits`;
  }
  if (step.action === 'curate') {
    return params?.amendments === undefined || params.amendments <= 0
      ? null
      : `${params.amendments} changes`;
  }
  return null;
}

/**
 * THE PARENT, BY NAME — the second half of every lineage line.
 *
 * Composed from the parent STEP rather than from the row above, because the row
 * above is a fact about the drawing and the parent is a fact about the book: a
 * translation made from an edit two branches away has a row above it that is
 * neither. The one node with no step behind it is the import, whose card is the
 * book's own name — so a child of the root names the BOOK, which is exactly what
 * a person would say out loud.
 */
function parentTitleOf(step: LedgerStep, steps: readonly LedgerStep[], bookTitle: string): string | null {
  if (step.parent === null) return null;
  const parent = steps.find((one) => one.id === step.parent) ?? null;
  if (parent === null) return null;
  return parent.parent === null ? bookTitle : titleForStep(parent);
}

/**
 * What an export IS, in the words the export modal offered it in.
 *
 * THE PRODUCT AND NOT THE FORMAT, and certainly not the file: somebody chose
 * "Facsimile PDF" in a dialog and the card that turns up afterwards has to be
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
 * What a step card says on hover — including the STORED LABEL, which is the
 * record, and the STALE REASON, which is the whole of why a dimmed card is
 * dimmed.
 *
 * A step goes stale when something it was made from was replaced under it: the
 * blocks a curation named by `(page, order)` mean different blocks after a
 * re-read, and a translation of those blocks was a translation of paragraphs
 * that have moved. It is a display state and not a deletion — the payload is
 * still a true record of what was made, so the card still opens and still
 * renders. Saying that on hover is what keeps a dimmed card from reading as a
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
 * WHEN, in as few characters as a card can spare — the Steps section's rule, for
 * the Steps section's reason, now applied to every card in the tree.
 *
 * The year is dropped for anything from this one, which is nearly everything
 * anybody looks at, and kept for the rest: two cards both reading "14 Aug" would
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
 * Ours, so a row drag and a file drag can never be mistaken for each other.
 *
 * NOT EXPORTED ANY MORE, and the export is what it lost rather than the type.
 * The workspace read it on the other end of the same gesture — a row dragged out
 * of this list and dropped on a column — and there are no columns
 * (docs/PLAN.md §4, unit 8b), so both ends of every drag that carries this are
 * now in this file: the loose files' reorder, and nothing else. The string itself
 * is unchanged because App's file-drop veil is still written against the fact
 * that our drags do not carry `Files`, and a renamed type would be a second thing
 * to keep true for no gain.
 */
const DOCUMENT_MIME = 'application/x-foundry-tab';
