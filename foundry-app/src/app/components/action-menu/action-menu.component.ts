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
  canExportFrom, canReadPages, canRunHostActFrom, canSimplifyFrom, canTranslateFrom,
} from '@shared/stages';
import { standsOnAnArrival } from '@shared/ledger';
import { fold } from '@shared/original';

import { BookStacksService } from '../../core/book-stacks.service';
import { hosted } from '../../core/foundry';
import { HostOpsService } from '../../core/host-ops.service';
import { LedgerService } from '../../core/ledger.service';
import { NoticeService } from '../../core/notice.service';
import { ProjectsService } from '../../core/projects.service';
import { isExportView, OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { UnappliedService } from '../../core/unapplied.service';

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
 * Three groups, divided by rules:
 *
 *   NAVIGATION — Home, Documents. Neither makes anything; they are where you go
 *   and what you look at, so they sit above the rule rather than inside the list
 *   of acts. Putting Home first is unchanged and still right: it is the way back.
 *
 *   THE ACTS — Read the pages, Translate, Simplify, whatever the host
 *   contributes, Export, Metadata. Read is first because nothing else is
 *   possible before the pages have been; Export is after everything that changes
 *   the words, because exporting before translating is exporting the wrong book;
 *   and METADATA IS LAST because it is a record ABOUT the book rather than a step
 *   in making one — it is here rather than beside Settings because what it edits
 *   is the book's own claim about itself, which is the book's business and not
 *   the app's.
 *
 *   AND SETTINGS, BELOW A RULE OF ITS OWN — unchanged, for the reason it always
 *   had: it is not a tool, it is where you go when the tools are not the answer.
 *
 * ── THE HOST'S ACTS MOVED UP, AND RUN ORDER IS NO LONGER THE WHOLE ARGUMENT ─
 *
 * This block used to argue itself entirely from the pipeline: the acts stood in
 * the order the book is made, so the host's audio work — which is made FROM the
 * export — stood last of the acts, after Export and Metadata. Owen moved it
 * (2026-08-18): *"there should be a narration button in the options sidebar
 * menu, right next to translate and simplify. it makes sense for it to be
 * there."*
 *
 * SO THE ORDER IS RUN ORDER WHERE THAT IS STILL WHAT SOMEBODY IS READING, and
 * Owen's grouping where it is not. A menu is not a sequence being stepped
 * through; it is a list being searched, and what a person searching it holds in
 * mind is what the act is AIMED AT. Translate, Simplify and a narration all take
 * the book in front of you and make another version of it. Export files what is
 * already there and Metadata edits a claim about it — different asks, and the
 * three that are alike now sit together. Run order still decides everything
 * else, and nothing about how these rows behave changed with their position.
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
 * ── AND THE FOURTH ARRANGEMENT IS A TILE GRID (2026-08-22) ─────────────────
 *
 * Four directions were drawn and put in front of Owen, who chose one and said
 * why in the same breath: *"i think the tile grid is best - b - but narrate
 * wont be present in foundry, of course. only in bookforge."*
 *
 * WHAT IT DISPLACED IS THE FULL-WIDTH ROW, and the row's own argument is worth
 * keeping because it was right about what it was answering. A list of rows was
 * what *"[icon] [action], one after another"* asks for literally, and it made
 * the order unmissable — but nine of them stacked in a 384-pixel panel ate the
 * bottom third of the sidebar, and the sidebar's other job is the tree. A grid
 * of three spends the panel's WIDTH, which the rows were leaving empty: the
 * same six acts come down from nine rows to two lines of tiles, and the tree
 * gets the height back. This is the same trade the very first layout made in
 * the other direction, and it is being made the other way because the panel is
 * now wide and short of height rather than narrow and full of it.
 *
 * THE ORDERED-LIST RULING SURVIVES AS READING ORDER. *"an ordered list of
 * actions"* was never about the geometry of a column; it was about the SEQUENCE
 * being legible, and a grid read left to right and top to bottom is an ordered
 * list with the line breaks in different places. Every ordering decision below —
 * Read first, Export after the acts that change the words, Metadata last, the
 * host's acts sitting with Translate and Simplify — is untouched, and the tiles
 * are laid out in exactly that sequence.
 *
 * THE THREE GROUPS BECAME TWO SHAPES. Navigation is a SLIM STRIP along the top
 * of the block — Home and Documents as small labelled buttons, the light table
 * and Settings as icon squares — and the acts are the grid below it. The rules
 * that used to divide three groups are gone because the shapes now do that
 * work: a 30-pixel strip of buttons and a field of 58-pixel tiles cannot be
 * misread as one run of equals, which is the only thing the rules were for.
 *
 * AND THE UNICODE GLYPHS WENT WITH THE ROWS (⌂ ☰ ▣ ⌦ ⇄ ≈ ⎘ ⓘ ♪). They were
 * chosen when the icon was a 20-pixel box beside a word doing the real work; a
 * tile makes the mark the largest thing on it, and a font glyph is whatever the
 * platform happens to have — a different weight and a different SIZE on every
 * machine. The library's own symbol sheet had already learned this and drawn
 * stroke icons for the same acts; this menu now draws from that sheet rather
 * than keeping a second, typographic opinion about what Translate looks like.
 * Three marks it needed and the tree never did — Home, the document list and
 * Settings — were added there, in the sheet's own line weight.
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
        NAVIGATION, AS ONE SLIM STRIP. Nothing here makes anything: Home is
        where you go, Documents is what you look at, the light table is a place
        and Settings is where you go when the tools are not the answer. What
        used to separate them from the acts was a rule across the block; what
        separates them now is that they are a 30-pixel strip above a field of
        58-pixel tiles, which is a louder division than a one-pixel line and
        costs no height at all. See the class docblock for the order.

        THE BRAND WENT WITH THE WRAP. A ⬙ at the top of this block was the
        window's own mark at the left end of a full-width dock; in a panel whose
        head already says LIBRARY it was a second title for one column, and in a
        list of actions it is a row that is not one.
      -->
      <div class="menu-nav">
        <!-- Hosted, the host's book list is the library and Home is the one
             surface that would list the same books from the other side — so the
             door to it goes, not just the page behind it. The strip closes up
             around the gap, because the two that follow are flexible and the
             two after them are fixed squares. -->
        @if (!hosted()) {
          <button
            class="menu-item"
            [class.active]="stage.active() === null"
            title="Home"
            (click)="home()"
          >
            <svg class="menu-icon" aria-hidden="true"><use href="#ft-home" /></svg>
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
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-list" /></svg>
          <span class="menu-label">Documents</span>
        </button>

        <!--
          THE WAY BACK TO THE PHOTOGRAPHS, and it is ON THE NAVIGATION STRIP on
          purpose.

          A mint is a SNAPSHOT of the recipe rather than its funeral: the bank
          and the recipe survive it, and until Wave 21b there was simply no
          surface that reached them again. Owen minted, found he had not turned
          the pages, and there was no door -- Home opens the PDF once an
          original exists, which is correct and was the whole trap.

          IT LIVES HERE RATHER THAN ON HOME ITSELF because the door belongs
          where the person is standing when they want it, which is looking at
          the book; Home stays a single door onto a project. And it sits with
          Home and Documents rather than among the acts because THE LIGHT TABLE
          IS A PLACE. Mint is an act and is deferred from this menu for exactly
          that reason -- a control naming somewhere you can go is a different
          kind of entry from one that performs something.

          HIDDEN, NOT DISABLED, WHICH BREAKS THIS MENU'S USUAL RULE. Translate
          and Simplify stay visible and gray on a book they cannot run on,
          because they are tools that might apply to it later. A project that
          did not arrive as photographs has none and never will, so a permanent
          gray tile would be furniture rather than an education. Asked of the
          summary's own capture field, never inferred from an empty document
          list -- that field exists because emptiness is ALSO what a broken
          project looks like (types.ts says so at length).

          A SQUARE WITH NO WORDS, unlike Home and Documents beside it, and that
          is a length decision rather than a rank one. "Edit the photographs" is
          three words and the strip has room for two labels; a quarter of the
          strip holding an ellipsis would say less than the mark does. The
          sentence it always had is on the hover, where it always was.
        -->
        @if (photographs(); as dir) {
          <button
            class="menu-item square"
            [class.active]="atTheTable()"
            aria-label="Edit the photographs"
            title="The photographs this book was made from, and the crops and turns still to set"
            (click)="editPhotographs(dir)"
          >
            <svg class="menu-icon" aria-hidden="true"><use href="#ft-capture" /></svg>
          </button>
        }

        <!--
          SETTINGS, AT THE END OF THE STRIP, AND THE RULE UNDER IT IS GONE.

          It had a divider of its own for as long as this was a column, for a
          reason that has not changed at all: IT IS NOT A TOOL. It is where you
          go when the tools are not the answer, and a menu that let it sit among
          the acts would be inviting somebody looking for Export to read past it.

          WHAT CARRIES THAT NOW IS POSITION RATHER THAN A LINE. Settings is on
          the navigation strip — with Home and the light table, the things that
          take you somewhere rather than make something — and it is the LAST
          thing on it, at the far end from Home, which is where a settings
          control has sat in every window anybody has ever used. It is not in
          the field of tiles at all: a different shape, in a different group, on
          the other side of the block from the acts is a louder statement of
          "this is a different kind of thing" than one pixel of --border-subtle
          ever was.
        -->
        <a
          class="menu-item square"
          routerLink="/settings"
          routerLinkActive="active"
          aria-label="Settings"
          title="Settings"
        >
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-gear" /></svg>
        </a>
      </div>

      <!-- THE ACTS. Read the pages, then everything that makes another version
           of the book — Translate, Simplify, and whatever the host contributes,
           which is where Owen put it — then the finished file, then the record
           about it. See the class docblock for the order and what displaced the
           run-order argument that used to settle all of it.

           THREE ACROSS, AND THE ORDER IS THE READING ORDER. The sequence below
           is the one it has always been; what changed on 2026-08-22 is that the
           line breaks fall every third item instead of every first. Nothing is
           positioned by hand — the grid takes them in document order, so the
           only place the order is written down is here, once. -->
      <div class="menu-acts">
        <!--
          THE TWO HALVES OF WHAT USED TO BE ONE BUTTON, side by side and in the
          order they happen. OCR reads the pages and costs hours; Export turns
          what was read into a document you can take away, and costs nothing.
          They were one item called "OCR / Convert" while they were one job, and
          separating them into two tiles is most of what teaches the difference.

          OCR LIGHTS UP when the book in front of you has never been read — the
          same accent this menu uses for "this is active", used here for "this is
          the step you are waiting on". It is the one tile in this menu that
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
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-scan" /></svg>
          <span class="menu-label">OCR</span>
        </button>

        <!--
          THE SWEEP, AND IT SITS HERE BECAUSE OF WHAT IT ACTS ON.

          Everything below this tile derives a NEW thing from where you stand — a
          translation, a simplification, the host's own act, an export, a record.
          This one changes the book you are already looking at: it finds a pattern
          across its blocks and stages cut-or-keep verdicts as ordinary pending
          edits, which is the curation step between reading the pages and making
          anything out of them. Run order, which is the menu's own rule wherever it
          is still the truth.

          IT DOES NOT NAVIGATE HOME, unlike the four acts under it, and that is a
          ruling rather than an omission (docs/SWEEP.md §3). Those four are ABOUT
          the position and can be ordered from anywhere; this one is about a BOOK
          PANE that is open and drawing — it reads that pane's replay and pushes
          onto that pane's stack. Sending somebody to the workspace first would be
          this menu opening a document in order to have something to act on, which
          is a gesture nobody asked for arriving through one they did. The cost is
          named in the title instead: pressed from Settings there is no book pane,
          so the tile is gray and says what would light it up.
        -->
        <button
          class="menu-item"
          [class.active]="ui.sweepOpen()"
          [disabled]="!canSweep()"
          [title]="canSweep()
            ? 'Find a pattern across the book — parentheses, brackets, or your own — and cut or '
              + 'keep each match'
            : 'Open a book to sweep it — this works on the pages in front of you'"
          (click)="sweep()"
        >
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-sweep" /></svg>
          <span class="menu-label">Sweep</span>
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
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-globe" /></svg>
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
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-spark" /></svg>
          <span class="menu-label">Simplify</span>
        </button>

        <!--
          ANALYSIS, BESIDE TRANSLATE AND SIMPLIFY because it is the same shape of
          act aimed at the same book: the model reads every sentence and lands a
          step of its own. What differs is that this one makes no new state of the
          book at all -- it makes a REPORT about it, drawn in a column beside the
          paper (docs/ANALYSIS.md §8), which is why the tile opens a dialog and
          the result opens a panel.

          GRAYED HOSTED, and it is the only tile here whose gate mentions the host
          for a reason other than a missing surface. A hosted window's queue is the
          host's, it takes the two request shapes its vendored snapshot declares,
          and an analysis is a third -- so ordering one there could only start an
          hour of GPU with no row anybody in either window can see. The door
          refuses the same way (\`queue:enqueue-analysis\`, electron/ipc.ts); this is
          the half a person meets before they press.
        -->
        <button
          class="menu-item"
          [class.active]="ui.analysisOpen()"
          [disabled]="!canAnalyse()"
          [title]="hosted()
            ? 'Analysis runs in Foundry itself — open this book there to read it against the categories'
            : 'Read this book against the categories and list what it finds beside the page'"
          (click)="analyse()"
        >
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-glass" /></svg>
          <span class="menu-label">Analysis</span>
        </button>

        <!--
          ── AND THE HOST'S OWN ACTS, RIGHT HERE, WHICH IS OWEN'S PLACEMENT ───

          *"there should be a narration button in the options sidebar menu,
          right next to translate and simplify. it makes sense for it to be
          there."* (Owen, 2026-08-18.)

          THIS DISPLACES AN ARGUMENT THIS FILE USED TO MAKE, and the old one is
          worth stating so the new one is read as a decision rather than a
          drift. These rows sat LAST among the acts, on run order: everything
          above makes the words and this makes something out of them, so the
          audio came after the export it was made from. That is true of the
          PIPELINE and it turned out not to be true of the MENU. A person
          reading a list of things they can do is not stepping through a
          sequence — they are looking for the act they came for — and the acts
          that belong together in that reading are the ones aimed at the same
          thing. Translate, Simplify and a narration all take the book in front
          of you and make another version of it; Export files what is there and
          Metadata edits a record about it. Owen put the host's acts with the
          three they are like, and that is the order this menu keeps.

          RUN ORDER SURVIVES WHERE IT IS STILL THE TRUTH: read the pages first,
          the acts that make another version next, the finished file after them,
          the record about it last. What moved is one group, from the end of the
          list to the middle of it, because that is where somebody looks for it.

          NOT ONE STRING HERE NAMES AN ACT. The label and the hover both come off
          the offer the host registered — this app has never contained the word
          "narrate" and does not start now, Owen's own sentence notwithstanding.
          The amber is the menu's existing tint for the host's work, the same one
          the tree draws audio cards in.

          ONE MARK FOR ALL OF THEM, WHICH IS WHAT THE GLYPH DID TOO. Every host
          act wore a single ♪ here while the icons were type, and it wears a
          single stroke mark now: the tree can afford to tell a narrate from an
          enhance from an assemble because it is drawing the RESULTS, one card
          per run, and a menu is drawing the DOOR. What a person needs off this
          tile is "this belongs to the other application", which the amber and
          the mark say together, and the label underneath says the rest.

          STANDALONE THIS LOOP RUNS ZERO TIMES: no host, no operations,
          \`hostActs()\` is empty, and the menu is exactly this app's own acts. There is no
          \`hosted()\` branch here because there does not need to be one — the
          emptiness is the guard, and this position costs a standalone window
          nothing at all.
        -->
        <!--
          GRAYED WHEN THE STAGE CANNOT RUN IT, exactly like Translate and
          Simplify — Owen's ruling (2026-08-17 21:45): *"if the step the user
          has selected cant run tts then its grayed out."* \`hostReady\` is the
          same predicate the press itself refuses by
          (\`canRunHostActFrom\`, shared/stages.ts), so the gray and the
          sentence cannot disagree; the title says what would make it light up,
          because a disabled control that keeps its enabled hover is a control
          that explains nothing.

          WHAT THE GRAY MEANS HAS NARROWED TWICE, and it is now as small as it
          can honestly be. It began as "nothing has been exported yet", which
          shut the button on books whose words were all there, and Owen's second
          ruling — *"i dont think its intuitive to know you have to create an
          epub before you can narrate"* — replaced it with "there is no book at
          this stage": the unread scan AND the import row. The import row went
          too (2026-08-18, *"it should be available pretty much anywhere the
          user clicks"*), because that refusal is about acts that DERIVE a new
          thing from where you stand and a host act derives nothing — it names
          provenance and names what to export, and the import row's book is the
          reading's book. So the gray means ONE thing now: THIS BOOK HAS NO
          BOOK, which is a scan nobody has read. The export these acts consume is
          made for them when there is none, and the press sends the reading's
          step when it is ordered from the row above it (\`hostActPositionFrom\`).

          THE UNREAD SCAN STAYS GREY ON PURPOSE. There is no bank, so there is
          nothing to mint an EPUB from and nothing for the host to consume — and
          Read is already the act offered on that stage, which is the same
          ruling's other half rather than a gap in this one.
        -->
        @for (act of hostActs(); track act.id) {
          <button
            class="menu-item audio"
            [class.active]="ui.hostOpOpen()?.operationId === act.id"
            [disabled]="!hostReady()"
            [title]="hostReady()
              ? act.label + ' — handled by the app Foundry is running inside'
              : act.label + ' — this book’s pages have not been read yet, and this act is '
                + 'made from the words in them'"
            (click)="runHostAct(act.id)"
          >
            <svg class="menu-icon" aria-hidden="true"><use href="#ft-wave" /></svg>
            <span class="menu-label">{{ act.label }}</span>
          </button>
        }

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
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-out" /></svg>
          <span class="menu-label">Export</span>
        </button>

        <!-- Metadata. Enabled standing on the scan as well as on the book,
             unlike everything else here that needs a book to have been cast: a
             scan has an Info dictionary and correcting it is exactly as useful
             as correcting a package. Which SCAN it edits is the position's
             answer, not the pane's; a finished export is the exception and is
             the tab's own, because an export is not a position — see
             canEditMetadata below. It does NOT rename any file — see the
             dialog for why that is a decision rather than an omission. -->
        <button
          class="menu-item"
          [class.active]="ui.metadataOpen()"
          [disabled]="!canEditMetadata()"
          title="The title, author and language this document claims for itself"
          (click)="metadata()"
        >
          <svg class="menu-icon" aria-hidden="true"><use href="#ft-tag" /></svg>
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
          there is no tile here to switch it.
        -->
        <!-- The PDF is an output FORMAT inside a dialog rather than a tile
             of its own: this menu names ACTS, and picking between an
             EPUB, plain text and a reprint of the pages is one decision about
             one act, made where the rest of that act is described. -->
      </div>
    </nav>
  `,
  styles: [`
    /*
      ── A STRIP AND A GRID AT THE FOOT OF THE SIDEBAR ───────────────────────

      *"i think the tile grid is best - b"* (Owen, 2026-08-22), chosen off four
      drawings, and every number below is measured from the one he picked.

      WHAT IT REPLACED WAS A COLUMN OF FULL-WIDTH ROWS, and that column deserves
      its epitaph because it was right about the thing it was defending. It came
      from *"[icon] [action], one after another"* (2026-08-18 01:05), and it
      made the ORDER unmissable and the labels unambiguous; a row that is
      \`width: 100%\` also has no column count to break when the panel is
      resized, which is what the wrapped cluster before it kept getting wrong.
      What it was wrong about was HEIGHT. Nine rows at thirty pixels each took
      the bottom third of a 384-pixel panel whose other job is a tree that grows
      all day — and the width it was spending on ellipsised labels was width the
      tree could not use anyway.

      SO THE TRADE IS MADE THE OTHER WAY ROUND, in a panel that is now wide and
      short of height rather than narrow and full of it: three tiles across, two
      lines, and the same six acts in a little over a hundred pixels. The order
      is untouched — left to right, top to bottom, which is what an ordered list
      is when the line breaks move.

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
      gap: 10px;
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      padding: 10px;
    }

    /*
      TWO SHAPES, AND NO RULES BETWEEN THEM ANY MORE. There used to be a hairline
      under navigation and another above Settings, because a column of eight
      identical rows reads as one run of equals and the grouping had to be drawn
      on. It does not have to be drawn on now: a strip of thirty-pixel buttons
      above a field of fifty-eight-pixel tiles IS the division, said in the one
      language a layout has. Two hairlines that repeated it would be the same
      sentence twice.

      \`minmax(0, 1fr)\` and not \`1fr\`, which is the difference between a
      long host label ellipsising inside its tile and the same label shoving the
      third column off the edge of the panel: a grid track's automatic minimum is
      its content, and a host we do not control writes these labels.
    */
    .menu-nav {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    .menu-acts {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      min-width: 0;
    }

    /*
      THE TILE. Mark over word, centred, in a bordered box of its own — which is
      the third shape this control has had and a return to the first. It was
      exactly this (a 76-pixel column, glyph above label) while the menu ran
      along the bottom of the window, then a full-width row for the four days it
      was a list, and it is a tile again because the panel's scarce dimension
      changed back.

      A BOX RATHER THAN A BARE ROW, which is the real change and not the
      proportions. A row in a list is delimited by the rows above and below it;
      a tile has nothing beside it but a gap, so it has to carry its own edge or
      it is a floating icon. The chrome is the app's own button chrome —
      --bg-input on --border-default — because that is what every other pressable
      thing in this window wears, and the one thing this menu must not do is
      invent a fourth kind of button.

      FIFTY-EIGHT PIXELS is the mockup's height and it is not arbitrary: a
      16-pixel mark, an 11-pixel label, five of gap between them and enough air
      above and below that the pair reads as one object rather than as two
      things that happened to land in the same box.
    */
    .menu-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 0;
      height: 58px;
      padding: 0 4px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius);
      color: var(--text-secondary);
      cursor: pointer;
      text-align: center;
      text-decoration: none;
      transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease;
    }

    /*
      THE STRIP'S BUTTONS ARE THE SAME TILE LYING DOWN — same chrome, same
      states, a third of the height, mark beside word instead of above it. That
      is deliberate rather than economical: Home and Documents are pressable in
      exactly the way Export is, and a navigation strip drawn in some other
      idiom would be teaching a distinction that is not there. What separates
      them from the acts is the SIZE and the position, which is the whole
      argument for the shape.

      THE TWO WITH WORDS SHARE THE ROW AND THE TWO WITHOUT TAKE A SQUARE. Home
      and Documents flex, so hosted — where Home is not drawn at all — Documents
      simply takes the width Home is not using and nothing is left hanging.
    */
    .menu-nav .menu-item {
      flex: 1 1 0;
      flex-direction: row;
      gap: 6px;
      height: 30px;
      padding: 0 8px;
    }
    .menu-nav .menu-item.square { flex: 0 0 34px; padding: 0; }
    .menu-nav .menu-icon { width: 14px; height: 14px; }

    /*
      THE HOST'S OWN COLOUR, the same amber the tree tints audio cards with, so
      that an act belonging to another application reads as one at a glance
      wherever it appears. Only the mark takes it: a whole tile in the host's
      colour would compete with the accent this menu uses for "active".
    */
    .menu-item.audio .menu-icon { color: var(--audio); }

    /*
      THE STATES, AND THEY ARE WRITTEN AGAINST THE APP'S GLOBAL BUTTON RULES
      RATHER THAN AROUND THEM. \`button:hover\` in styles.scss swaps the
      background for --bg-hover, which is a translucent white meant to lift a
      TRANSPARENT control and which would push an opaque --bg-input tile darker
      instead. So the hover here names its own background, and the lift is
      carried by the border and the text as much as by the fill.
    */
    .menu-item:hover {
      background: var(--bg-active);
      border-color: var(--border-strong);
      color: var(--text-primary);
    }
    .menu-item:disabled { opacity: 0.35; cursor: default; }
    .menu-item:disabled:hover {
      background: var(--bg-input);
      border-color: var(--border-default);
      color: var(--text-secondary);
    }
    /*
      ACTIVE IS A FILL — the dialog is open, the documents are up, the light
      table is what you are looking at. The border goes transparent so the whole
      tile reads as one washed shape rather than as a bordered box that happens
      to be tinted; the background paints under it either way, which is what
      makes that legal.
    */
    .menu-item.active {
      background: var(--accent-soft);
      border-color: transparent;
      color: var(--accent);
    }

    /*
      WAITING, which is not the same as ACTIVE and must not look identical.
      Active means "this panel is open right now"; waiting means "this is the
      step your book needs next". The SAME accent — this app has one word for
      attention, and inventing a second colour for a second kind of it is how a
      palette stops meaning anything — but drawn as a RING on a fainter wash
      rather than as a fill, so a menu showing both still says which is which.
      The ring used to be an inset shadow because the row had no border to
      colour; the tile has one, so the ring is simply the tile's own edge in the
      accent, which is a cleaner statement of the same thing.

      IT PULSES ONCE AS IT ARRIVES AND THEN HOLDS: a permanently animating menu
      is a menu people learn to look away from. The animation is a spreading
      outer shadow now rather than a shadow list carrying the ring along with it,
      because the ring is the border and no longer needs restating in every
      keyframe.
    */
    .menu-item.waiting:not(.active) {
      background: var(--accent-faint);
      border-color: var(--accent);
      color: var(--accent);
      animation: notice 900ms cubic-bezier(0, 0, 0.2, 1) 1;
    }
    /* And it still answers a hover, which it would not otherwise: the waiting
       rule outranks the plain hover, so without this the one tile the menu is
       pointing at would be the one tile that went dead under the cursor. */
    .menu-item.waiting:not(.active):hover { background: var(--accent-soft); }
    @keyframes notice {
      0% { box-shadow: 0 0 0 0 var(--accent-soft); }
      60% { box-shadow: 0 0 0 7px transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }
    .menu-item.active .menu-icon { transform: scale(1.1); }

    /*
      THE MARK, AND IT IS A STROKE ICON NOW RATHER THAN A CHARACTER. Sixteen
      pixels square on the tiles and fourteen on the strip, drawn from the
      library's symbol sheet — see the class docblock for why the typographic
      glyphs (⌂ ☰ ▣ ⌦ ⇄ ≈ ⎘ ⓘ ♪) could not survive being made the largest thing
      in the control. \`currentColor\` throughout, so every state above tints
      the mark by tinting the tile, and the amber above is the one exception.
    */
    .menu-icon {
      flex: 0 0 auto;
      width: 16px; height: 16px;
      transition: transform 150ms ease;
    }
    /*
      THE ACTION'S NAME, UNDER THE MARK AND IN SENTENCE CASE. Eleven pixels
      because it is a caption again rather than the thing being read — the mark
      carries the recognition on a tile, which is exactly the trade a full-width
      row could not make. It ellipses rather than wrapping: a two-line label
      would push the pair off the tile's vertical centre and break the rhythm of
      a grid, which is the same argument the row made about its own rhythm.
    */
    .menu-label {
      min-width: 0; max-width: 100%;
      font-size: 11px; font-weight: 500; line-height: 1.2;
      letter-spacing: 0.01em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /*
      ── COMPACT: THE MENU AT THIRTY PIXELS ───────────────────────────────────

      The panel collapses to a stub and the acts go with it rather than
      disappearing — putting the library away must not put Settings away. A
      three-column grid of 58-pixel tiles cannot be drawn in 30 pixels of width
      at all, so THE STUB KEEPS THE COLUMN OF ICONS IT HAS ALWAYS HAD: one mark
      per row, one after another, which is the ordered list at a width that
      cannot hold the words. The title attribute is on every one of them (it
      always was), so they are one hover away — the same trade the panel's own
      collapse makes.

      AND THE CHROME COMES OFF WITH THE WORDS. A bordered box round a 26-pixel
      mark in a 30-pixel stub is a border touching both edges of the column; the
      tile's edge exists to separate it from the tiles beside it, and in a single
      file with nothing beside it there is nothing to separate. The states keep
      their fills, because those are saying something the shape is not.

      THIS BLOCK COMES LAST ON PURPOSE. \`:host(.compact) .menu-item\` and
      \`.menu-nav .menu-item\` are the same specificity, so source order is what
      decides them, and compact has to be the one that wins.
    */
    :host(.compact) .menu { padding: 6px 2px; gap: 4px; }
    :host(.compact) .menu-nav,
    :host(.compact) .menu-acts {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    :host(.compact) .menu-item,
    :host(.compact) .menu-nav .menu-item {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      padding: 0;
      gap: 0;
      background: transparent;
      border-color: transparent;
      border-radius: var(--radius-md);
    }
    :host(.compact) .menu-item:hover {
      background: var(--bg-hover);
      border-color: transparent;
    }
    :host(.compact) .menu-item.active { background: var(--accent-soft); }
    :host(.compact) .menu-item.waiting:not(.active) {
      background: var(--accent-faint);
      border-color: var(--accent);
    }
    :host(.compact) .menu-label { display: none; }
    :host(.compact) .menu-icon,
    :host(.compact) .menu-nav .menu-icon { width: 16px; height: 16px; }
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
  /**
   * THE REGISTRY OF OPEN BOOK VIEWERS, for the one tile that acts on a PANE
   * rather than on a step — see `canSweep`. It is the same door the inspector's
   * three book panels take, and this menu, like them, holds no copy of the book.
   */
  private readonly stacks = inject(BookStacksService);
  private readonly hostOps = inject(HostOpsService);
  private readonly notices = inject(NoticeService);
  /** The card before any of the four make-acts below runs past unapplied work. */
  private readonly unapplied = inject(UnappliedService);
  private readonly router = inject(Router);

  /** Lit when the panel is actually on screen, which needs both halves of it. */
  protected readonly documentsUp = computed(() =>
    this.ui.documentsShown() && this.documents.tabs().length > 0);

  /**
   * THE HOST'S ACTS THAT BELONG ON THE DOCK — the ones that consume the book.
   *
   * `appliesTo: 'book'` because the menu aims at THE BOOK IN FRONT OF YOU, and
   * that is the only currency this menu can name — an act consuming AUDIO is about
   * a particular narration, which is a row in the tree and not a thing this menu
   * has a way to point at. `offeredFrom` is the same function the tree's footer
   * asks, so the two surfaces cannot come to different answers about what may be
   * offered from a book.
   *
   * A `form` FILTER STOOD HERE AND IS GONE. It reasoned that an act without a
   * form runs the instant it is pressed, so a menu tile starting an hours-long
   * job on one click could not be taken back. That reasoning read "formless" as
   * "fire-and-forget", and the contract says the opposite
   * (`HostOperationOffer.form`, shared/host-ops.ts): a formless offer is the
   * host asking its questions in ITS OWN WINDOW — the press is a LAUNCHER, it
   * opens a dialog somewhere else and starts nothing at all. BookForge's
   * narrate is moving exactly there (Owen, 2026-08-26: Foundry is for text
   * changes, not audio changes), and a filter kept for the old reading would
   * have made that act silently vanish from this menu while the tree footer
   * went on offering it — two surfaces disagreeing about what may be pressed,
   * which is the thing `offeredFrom` exists to prevent.
   *
   * EMPTY STANDALONE, which is the whole of the guard: nobody registered
   * anything, so this is `[]` and the loop that draws it runs zero times.
   */
  protected readonly hostActs = computed(() => {
    if (this.target() === null) return NO_ACTS;
    /*
     * BOTH SPELLINGS OF "ACTS ON THE FINISHED BOOK" REACH THE DOCK, and after
     * this wave they reach it aiming at two different things. An act consuming
     * the BOOK is pressed against the step somebody is standing on — the menu's
     * own subject, and the case Owen's ruling is about; an act consuming only the
     * EXPORT is pressed against the project's one finished EPUB, exactly as it
     * has been. `runHostAct` is where that fork is taken and argued.
     *
     * DEDUPED BY ID, because a host declaring BOTH currencies on one act — which
     * is what this wave makes possible and what a narrate should now say — is
     * answered by both calls, and one operation must not draw two identical tiles
     * in a grid of things you can do.
     */
    const both = [...this.hostOps.offersFor('book'), ...this.hostOps.offersFor('export')];
    return both.filter((offer, at) => both.findIndex((one) => one.id === offer.id) === at);
  });

  /**
   * THE PRESS ITSELF, aimed and ready — the one fork the tree footer already
   * takes (`open-documents`, the `act.form` branch), taken here through the
   * same two doors so the two surfaces cannot mean different things by one
   * offer. An offer WITH a form opens the host's questions in our card, on the
   * workspace where the card lives; a FORMLESS offer is invoked immediately —
   * the host raises its own window and asks there, so there is nothing to
   * navigate to on this side and nothing irreversible in the click. Errors are
   * a sentence on the strip, this menu's own habit.
   */
  private press(operationId: string, dir: string, nodeId: string): void {
    if (this.hostOps.offer(operationId)?.form !== undefined) {
      void this.router.navigateByUrl('/');
      this.ui.openHostOp({ operationId, projectDir: dir, nodeId });
      return;
    }
    void this.hostOps.invoke(operationId, dir, nodeId).catch((err: unknown) => {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    });
  }

  /**
   * WHICH PROJECT A MENU ACT IS ABOUT — the book in front of you, as a folder.
   *
   * It is the same resolution every act on this menu makes, kept as one computed
   * because the host's acts ask it three times over (whether to draw them at all,
   * whether they are possible from here, and what to send with the press) and
   * three readings of "which book am I looking at" in one component is how two of
   * them come to disagree.
   *
   * WHAT IT DOES NOT DECIDE ANY MORE is what the press NAMES. That was this
   * computed's whole docblock — the project's one exported EPUB, refusing where
   * there were two — and it is `runHostAct`'s business now, because the answer
   * depends on what the act says it consumes: a step for an act that takes the
   * book, that same one-export-or-refuse for an act that takes only the file.
   *
   * NULL MEANS THE BUTTONS ARE NOT DRAWN AT ALL, which is only the case with no
   * book in front of you. A book at a stage the acts cannot run from draws them
   * GRAYED instead — present and disabled like Translate and Simplify, with the
   * title saying what would light them up. See `hostReady`.
   */
  private readonly target = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    return this.documents.projectDirOf(tab);
  });

  /**
   * WHETHER THE HOST'S ACTS CAN BE RUN FROM WHERE THE PERSON IS STANDING — this
   * menu's gray.
   *
   * ── It moved off the export tray, and that is Owen's ruling ────────────────
   *
   * It was `hasEpubExport`: no finished EPUB, no press. *"i dont think its
   * intuitive to know you have to create an epub before you can narrate. i think
   * we should make any of the steps possible to narrate. if they arent doing it
   * from an epub then we export the epub automatically and then run the task they
   * assigned."* So the question is what CAN BE MADE rather than what the project
   * happens to have lying in `final/`, and the answer is `canRunHostActFrom`
   * (shared/stages.ts).
   *
   * ── And it stopped asking about the position at all ───────────────────────
   *
   * It used to be `hasBookAt` by another name, greying wherever the Export
   * button beside it greys — which included the import row, and which is what
   * Owen was hitting when he said the button *"is disappearing and disabling
   * seemingly at random."* Clicking the top row of a book is an ordinary thing
   * to do. The import refusal belongs to acts that DERIVE from the position, a
   * host act derives nothing from it, and the whole argument is written down at
   * the predicate rather than repeated here.
   *
   * SO THIS IS A FACT ABOUT THE BOOK, and there is no step in it — the predicate
   * takes none. What the position still decides is what the PRESS names, which
   * is `runHostAct`'s business and is the reason the two are separate questions
   * (`hostActPositionFrom`).
   *
   * The finer refusals — a voice the host does not have, a queue that will not
   * take the work — stay at press time and with the host, because a catalogue row
   * cannot know them.
   */
  protected readonly hostReady = computed<boolean>(() => {
    const dir = this.target();
    if (dir === null) return false;
    const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    return canRunHostActFrom(project);
  });

  /**
   * Press one: work out what this act is aimed at, then open the host's questions
   * in our card.
   *
   * ── TWO KINDS OF ACT REACH THIS BUTTON, AND THEY AIM AT DIFFERENT THINGS ───
   *
   * AN ACT THAT CONSUMES THE BOOK aims at the STEP the person is standing on —
   * the same id the tree row for that step would send, which is the whole of why
   * it can be pressed from here at all. What it does with a step that has no
   * export behind it is the host's business: it asks Foundry to make one
   * (`exportEpubFromStep`, electron/mount.ts) and then runs the work, which is
   * Owen's ruling and the reason this branch exists.
   *
   * THE POSITION IS NO LONGER RESOLVED AT ALL FROM THIS MENU (Owen's ruling,
   * 2026-08-24, inside the branch): a finished EPUB is named by file whenever
   * one exists, and a position parked on an arrival gets a sentence instead of
   * the old `hostActPositionFrom` hop onto the reading — the hop that cast and
   * narrated the German text of a book whose English export was on screen. The
   * mapping itself survives in shared/stages.ts for the TREE's row presses,
   * where the row pressed says which lineage was meant.
   *
   * AN ACT THAT CONSUMES ONLY THE FINISHED FILE keeps every refusal it had. It
   * has said it reads an export and nothing else, so a press has to name one, and
   * a book with none — or with two, which this menu cannot choose between — is a
   * sentence rather than a guess. That is unchanged behaviour for a host that has
   * not moved its act onto the book.
   *
   * WHICH KIND THIS IS, ASKED THROUGH THE ONE RULE. `offersFor('book')` is
   * `offeredFrom` (shared/host-ops.ts), the same function the tree gates on, so a
   * declaration that reaches the tree's step rows and a declaration that takes
   * this branch cannot come apart.
   *
   * EVERY REFUSAL IS A SENTENCE ON THE STRIP, which is this menu's own habit for
   * a button that cannot grey itself out against a fact this deep in the model.
   */
  protected async runHostAct(operationId: string): Promise<void> {
    const dir = this.target();
    if (dir === null) return;
    /*
     * AND THE SAME QUESTION THE THREE DIALOGS ABOVE ASK, for the same reason and
     * one seam further out. A host act that consumes the book asks Foundry to
     * EXPORT the step it names (`exportEpubFromStep`, electron/mount.ts) and then
     * works on that file — so an act ordered over a pane holding unapplied changes
     * spends somebody else's queue on a book without them, and the result lands
     * in the tree looking exactly like the one they meant.
     *
     * AIMED BY `target()`, NOT BY THE ACTIVE DOCUMENT. This menu can be pressed
     * over a project it is holding rather than the one on screen, and the gate has
     * to look at the book the act will actually be made from.
     *
     * ASKED BEFORE ANY OF THE REFUSALS BELOW, deliberately: those are about
     * whether the act can be aimed at all, and a person who has just answered
     * "apply them and continue" should have their changes recorded even if the
     * aim then turns out to be impossible. The alternative — refuse first, ask
     * second — would make the answer depend on the order two unrelated facts
     * happen to be checked in.
     */
    if (!await this.unapplied.cleared(dir, 'host')) return;
    if (this.hostOps.offersFor('book').some((offer) => offer.id === operationId)) {
      /*
       * ── THE PRESS NAMES A FILE, AND NEVER A RESOLUTION — Owen's ruling ──────
       *
       * (2026-08-24): *"yes, it should name the file im actually exporting.
       * not generically."* The ruling has a body count. This branch used to
       * speak THE POSITION for any act declaring the book currency — and the
       * position is wherever the pointer happens to be parked, which on
       * evangelische-kirche was the mint: `hostActPositionFrom` mapped that
       * arrival to the newest READ, the read is the GERMAN scan, the host
       * auto-cast a German EPUB and narrated it, twice, while Owen sat looking
       * at the English export he had just forged. The dock is a coarse
       * surface; it must hand the host a CONCRETE file whenever one exists.
       *
       * So, in order of how much the press can honestly know:
       *  - THE EXPORT BEING VIEWED, when the focused tab is one of this
       *    project's finished EPUBs — the strongest possible reading of
       *    "the file im actually exporting".
       *  - THE ONE FINISHED EPUB, when the tray holds exactly one.
       *  - A SENTENCE for several unviewed — the same pick-in-the-tree answer
       *    the file-consuming branch below has always given.
       *  - With NO export at all, the make-one path survives — that is Owen's
       *    own earlier ruling ("i dont think its intuitive to know you have to
       *    create an epub before you can narrate") — but only from a position
       *    that names ITSELF. A position parked on an ARRIVAL no longer maps
       *    silently to the reading (the exact hop that chose German): it gets
       *    a sentence, because a press from the scan's row is a press from
       *    nowhere in particular about a book with more than one possible
       *    text.
       */
      const held = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
      const finished = (held?.exports ?? []).filter((made) => made.kind === 'epub');
      if (finished.length > 0) {
        const tab = this.stage.activeDocument();
        const viewing = tab !== null && tab.kind === 'book' && isExportView(tab)
          ? finished.find((made) => fold(tab.path) === fold(`${dir}/final/${made.file}`)) ?? null
          : null;
        const target = viewing ?? (finished.length === 1 ? finished[0]! : null);
        if (target === null) {
          this.notices.notice.set(
            'This book has more than one finished export, so which one this should work from is '
            + 'not obvious from here. Open the one you mean, or start it from its row in the '
            + 'library tree.',
          );
          return;
        }
        this.press(operationId, dir, exportNodeId(target.file));
        return;
      }
      const standing = this.ledger.standingIn(dir);
      if (standing === null) {
        /*
         * NO POSITION TO NAME. `standingIn` answers null while a project's
         * history is still in flight — `hasBookAt` deliberately reads that
         * silence as "not the import" so the button is not greyed on a guess —
         * and a press in that window has nothing to send. Saying so is the honest
         * answer; sending the root would be a fabricated provenance, and the host
         * echoes this id into every row it pushes back.
         */
        this.notices.notice.set(
          'This book’s history has not finished loading in this window, so there is no step to '
          + 'run this from yet. Give it a moment and press again.',
        );
        return;
      }
      if (standsOnAnArrival(standing)) {
        this.notices.notice.set(
          'This book is standing on its scan, and there is no finished export to name — so '
          + 'running this from here would be a guess about which text you mean. Export the book '
          + 'first, or press the act on the step you mean in the library tree.',
        );
        return;
      }
      this.press(operationId, dir, standing.id);
      return;
    }
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
      /*
       * AND THIS IS REACHABLE AGAIN, which it was not while the gray was
       * `hasEpubExport`. The button now greys on what the STAGE can do, so an act
       * that consumes only the finished file can be pressed over a book that has
       * none — and the honest answer is the sentence, because an act that did not
       * say it consumes the book is an act this menu must not make an export for
       * on its own initiative.
       */
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
    this.press(operationId, dir, exportNodeId(target.file));
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

  /**
   * ASKED ABOUT UNAPPLIED WORK FIRST, and this is the shape all three of these
   * openers share.
   *
   * An export is arithmetic over the RECORDED STEPS, so a book pane holding
   * changes nobody applied would have quietly produced the book without them
   * (`UnappliedService` — Owen's own report, 2026-08-21). The card is raised
   * BEFORE the dialog rather than at its Add press because none of these three
   * dialogs has a source picker: each computes its `source()` from the active
   * document's project, so the book this gate looks at is the book the card will
   * act on for the whole life of it, and settling the question first beats
   * settling it after somebody has picked a language and a model.
   *
   * THE NAVIGATION HAPPENS FIRST EITHER WAY. A press from Settings means "go and
   * do this to the document", and a person who then answers Cancel is a person
   * back among their documents rather than one stranded on a settings page.
   */
  protected async openExport(): Promise<void> {
    void this.router.navigateByUrl('/');
    if (!await this.unapplied.clearedHere('export')) return;
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

  protected async translate(): Promise<void> {
    void this.router.navigateByUrl('/');
    if (!await this.unapplied.clearedHere('translate')) return;
    this.ui.openTranslate();
  }

  /**
   * LIT WHERE THERE IS A BOOK PANE TO SWEEP, which is a different question from
   * every other predicate in this class.
   *
   * The four around it ask the LEDGER — is there a book at this position, is this
   * the import row, has the reading landed — because each of them orders work
   * against a step. This one asks whether a viewer is REGISTERED: the sweep reads
   * `BookStack.view()` and pushes onto `BookStack.push()`, both of which are a
   * live component's own signals, so "a book exists at this position" is not the
   * fact it needs. A book whose pane is still opening has no stack yet and
   * honestly answers no.
   *
   * A VIEW-ONLY TAB ANSWERS NO TOO, and the dialog says the same thing in a
   * sentence for whoever gets there another way. An export view has no position
   * and no stack to be a delta against; the viewer's own `push` refuses one, and a
   * card that closed and announced a hundred and forty cuts on top of that refusal
   * would be the app lying about what it had done.
   */
  protected canSweep(): boolean {
    const tab = this.stage.activeDocument();
    if (tab === null || tab.kind !== 'book' || tab.viewOnly === true) return false;
    return this.stacks.bookStackFor(tab.id) !== null;
  }

  /**
   * NO `clearedHere` IN FRONT OF THIS ONE, and it is the only make-shaped tile
   * here without it.
   *
   * The guard protects acts that CONSUME the ledger or MOVE the position — acts
   * that would otherwise run against a book missing the pending ops the person is
   * looking at. The sweep stages more of those ops onto the same pane at the same
   * position and consumes nothing; a card asking somebody to apply their edits
   * before making more edits of the same kind would be a card that has misread its
   * own act (docs/SWEEP.md §1).
   */
  protected sweep(): void {
    this.ui.openSweep();
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

  protected async simplify(): Promise<void> {
    void this.router.navigateByUrl('/');
    if (!await this.unapplied.clearedHere('simplify')) return;
    this.ui.openSimplify();
  }

  /**
   * LIT WHERE A TRANSLATION WOULD BE, AND NEVER HOSTED.
   *
   * The first half asks the same predicate the two tiles above it ask, and that
   * is not borrowing — it is Owen's own rule that the offer and the possibility
   * are one fact. An analysis reads exactly what a translation reads (the
   * position's materialised book file, every op replayed in), so "is there a book
   * at this position" has one answer and one function.
   *
   * The second half is this tile's own, and it is a refusal rather than a
   * capability: a hosted window's queue belongs to the host, whose vendored copy
   * of the API declares two request shapes and not this third one. A row it cannot
   * label, lane or spell a command line for is worse than no row, and Foundry's
   * own queue is invisible in a hosted window — so the act is not offered there.
   * It reaches BookForge by the normal re-vendor (docs/ANALYSIS.md §9).
   */
  protected canAnalyse(): boolean {
    if (hosted()) return false;
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    const project = this.projects.projectFor(tab.path);
    return canTranslateFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
  }

  /**
   * NO `clearedHere` IN FRONT OF THIS ONE, which puts it with the sweep rather
   * than with Translate and Simplify.
   *
   * The guard protects acts that CONSUME a rendering or MOVE the position — acts
   * that would otherwise run against a book missing the pending ops somebody is
   * looking at. This one reads the position's book file, with every pending edit
   * already replayed into it by main, and writes a report beside it: it consumes
   * no rendering and the pointer does not follow the landing
   * (\`RETAINED_BESIDE_YOU\`). docs/ANALYSIS.md §7 decides this explicitly, on the
   * sweep's own rule.
   */
  protected analyse(): void {
    void this.router.navigateByUrl('/');
    this.ui.openAnalysis();
  }

  /**
   * THE CAPTURE PROJECT THE PERSON IS STANDING IN, or null -- and null is what
   * hides the row rather than graying it (see the template).
   *
   * `projectFor` answers for BOTH tabs that can be open here without a second
   * reading: a minted PDF is a file inside the project directory, and the light
   * table's own tab holds that directory as its path, which `projectFor`
   * matches by equality on purpose (its docblock names the proof sheet as the
   * case that taught it). So one call covers "looking at the book" and "already
   * at the table", and the second is what `atTheTable` then lights.
   */
  protected readonly photographs = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    return project !== null && project.capture ? project.dir : null;
  });

  /** Lit while the table IS what is open, the way Home lights with nothing open. */
  protected readonly atTheTable = computed<boolean>(
    () => this.stage.activeDocument()?.kind === 'capture');

  /**
   * Opens the table, or returns to the one already open.
   *
   * `captureTabIn` is idempotent by construction -- it hands back the existing
   * tab for a project that already has one rather than making a second, which
   * matters more here than on Home: this row is reachable FROM the table, so
   * without that the door out of the room would put a second copy of the room
   * beside it. The navigate is the neighbours' habit, for the case where this
   * menu is drawn over a route that is not the workspace.
   */
  protected editPhotographs(dir: string): void {
    void this.router.navigateByUrl('/');
    this.documents.show(this.documents.captureTabIn(dir));
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
   * ── AND THE EPUB HALF IS BACK, AIMED SOMEWHERE ELSE ────────────────────────
   *
   * This was the PDF alone for a while, and the reason it was written down here:
   * the EPUB half reached `meta:read-epub`, which resolved an open book's WORKING
   * TREE, and the tree, the reader over it and the tab kind that held it are
   * deleted (docs/RENDERER.md §7). The half that was missing was never the dialog
   * — the form has drawn six `dc:` boxes the whole time — it was a DOCUMENT for it
   * to be about.
   *
   * A FINISHED EXPORT IS ONE. `openExportView` puts a book tab over a file in
   * `<project>/final/`, which is a real container with a real package in it, and
   * `viewOnly` is the app's own word for "this book tab is a finished file rather
   * than a position" (core/documents.service.ts). So the door is open exactly
   * there and nowhere else: not over a project's book tab, which is blocks out of a
   * bank and has no package to read, and not over anything the user imported.
   *
   * ── THE TWO TESTS BELOW ARE ABOUT THE PDF AND ARE NOT ASKED OF AN EXPORT ───
   *
   * The reading test asks whether there is anything to make yet; an export EXISTS,
   * so the question is already answered by the file being there. The import test
   * exists because a PDF tab's path can BE the untouched original in `archive/`,
   * and an export's path is two segments deep under `final/` — a different folder
   * by construction, whatever step the person happens to be standing on. Applying
   * either to a book would shut a door for a reason that is not about it.
   */
  protected canEditMetadata(): boolean {
    const tab = this.stage.activeDocument();
    if (tab === null) return false;
    if (tab.kind === 'book') return isExportView(tab);
    if (tab.kind !== 'pdf') return false;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return true;
    if (!project.reading.done) return false;
    return this.ledger.standingIn(project.dir)?.action !== 'import';
  }

  protected metadata(): void {
    /*
     * AN EPUB EXPORT GETS THE MINT DIALOG — Owen's ruling (2026-08-24): the
     * tile over a finished book opens the same card the mint asked with, and
     * Save stamps the very file on screen. The PDF keeps the older dialog,
     * whose Info-dictionary fields are a different document's different
     * questions.
     */
    const tab = this.stage.activeDocument();
    if (tab !== null && tab.kind === 'book' && isExportView(tab)) {
      const project = this.projects.projectFor(tab.path);
      if (project !== null) {
        void this.router.navigateByUrl('/');
        this.ui.openMintMeta({
          mode: 'edit',
          projectDir: project.dir,
          path: tab.path,
          file: tab.path.split(/[\\/]/).pop() ?? tab.path,
        });
        return;
      }
    }
    void this.router.navigateByUrl('/');
    this.ui.openMetadata();
  }
}

/**
 * ONE empty array for a menu with no host behind it — a fresh `[]` per call
 * would be a new identity on every repaint, and this is read inside a computed.
 */
const NO_ACTS: readonly HostOperationOffer[] = [];
