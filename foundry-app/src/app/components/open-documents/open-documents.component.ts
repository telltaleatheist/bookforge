import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { typeLabel } from '@owen/foundry-core/shared/documents';
import { CHAINABLE_FROM, PRODUCES_OF, exportNodeId, exportOfNodeId } from '@owen/foundry-core/shared/host-ops';
/*
 * WHAT IS POSSIBLE FROM A STAGE — one function per act, shared with the dock's
 * buttons and with the dialogs' own refusals (shared/stages.ts). The footer is
 * drawn by the same tests the acts refuse by, which is Owen's ruling made
 * structural rather than repeated.
 */
import {
  canCleanFrom, canExportFrom, canReadPages, canSimplifyFrom, canTranslateFrom,
  hostActPositionFrom,
} from '@owen/foundry-core/shared/stages';
import type { HostNodeAction, HostOperationState } from '@owen/foundry-core/shared/host-ops';
import { languageNameFor } from '@owen/foundry-core/shared/languages';
import { isTextPass, mintedFromPhotographs } from '@owen/foundry-core/shared/ledger';
import { pendingStepOf } from '@owen/foundry-core/shared/pending';
import type {
  HostNode,
  HostNodeProgress,
  Job,
  LedgerParams,
  LedgerStep,
  MakeAct,
  NodeOutput,
  ProjectDocumentKind,
  ProjectSummary,
} from '@owen/foundry-core/shared/types';

import { api, hosted } from '../../core/foundry';
import { ConfirmService } from '../../core/confirm.service';
import { HostOpsService } from '../../core/host-ops.service';
import { IntakeWorkspaceService, type WorkspaceImage } from '../../core/intake-workspace.service';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { OpenDocumentsService, pathIsProject, type Tab } from '../../core/documents.service';
import { NoticeService } from '../../core/notice.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { UnappliedService } from '../../core/unapplied.service';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { MenuAction, Act, Row, blank, Group } from './open-documents.model';
import { inProject, iconForTab, fold } from './open-documents.words';
import * as grouping from './open-documents.groups';
import * as acting from './open-documents.acts';
import * as picking from './open-documents.picking';
import * as closing from './open-documents.closing';
import * as dragging from './open-documents.dragging';

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
  imports: [NgTemplateOutlet, ActionMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './open-documents.component.html',
  styleUrl: './open-documents.component.scss',
})
export class OpenDocumentsComponent {
  protected readonly documents = inject(OpenDocumentsService);
  readonly stage = inject(StageService);
  readonly notices = inject(NoticeService);
  protected readonly projects = inject(ProjectsService);
  readonly ledger = inject(LedgerService);
  /**
   * The host's contributions — empty and silent standalone, which is why nothing
   * in this class asks whether the app is hosted (`HostOpsService`).
   */
  readonly hostOps = inject(HostOpsService);
  /** Public to the template AND to the host binding above, which is a template too. */
  protected readonly ui = inject(UiService);
  /** The card before a footer act runs past unapplied work — see `run`. */
  readonly unapplied = inject(UnappliedService);
  readonly router = inject(Router);
  /**
   * The intake workspace — loose images waiting to be told which book they are.
   *
   * IT IS DRAWN HERE BECAUSE THIS IS WHERE THE BOOKS ARE. Owen's word for what
   * this panel is doing is "accordions", and the workspace is one of them: the
   * pile that has not become a book yet, sitting above the ones that have. A
   * surface of its own would have been a second library on a screen whose whole
   * redesign was about having one.
   */
  protected readonly workspace = inject(IntakeWorkspaceService);
  /** The card asked before the workspace is cleared — see `shutWorkspace`. */
  readonly confirm = inject(ConfirmService);

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
    /*
     * HOW THE PICKED CARD'S HOST ACTS STAND THERE (`HostOperationState`) — asked
     * once per card picked, and again when the host revises what it offers. The
     * answer is keyed by the node it was asked about, so a slow answer for a card
     * somebody has since left is never drawn on the one they moved to.
     */
    effect(() => {
      this.hostOps.offersFor('book');
      const row = this.pickedRow();
      const nodeId = row === null || row.dir === null ? null : this.nodeIdFor(row);
      if (row === null || row.dir === null || nodeId === null) return;
      const key = `${row.dir}\u0000${nodeId}`;
      void this.hostOps.stateAt(row.dir, nodeId).then((states) => {
        this.hostStates.set({ key, states });
      }).catch((err: unknown) => {
        this.notices.notice.set(err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** The picked card's row, or null. */
  private readonly pickedRow = computed(() => {
    const key = this.picked();
    if (key === null) return null;
    return this.groups().flatMap((group) => group.rows).find((one) => one.key === key) ?? null;
  });

  /** The last answer from `host-ops:state`, and the node it is about (`dir` + NUL + node id). */
  readonly hostStates = signal<{ key: string; states: Record<string, HostOperationState> } | null>(null);

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
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  // ── The accordions, and the workspace inside one of them ───────────────────

  /**
   * The BOOKS somebody has folded away, by group key.
   *
   * SHUT RATHER THAN OPEN, exactly as `collapsed` above is, and for the same
   * reason said one level up: a book that opens while you are looking at the
   * library must appear OPEN. A set of "which are expanded" would make every
   * newly opened book arrive folded, so the act of opening a book would hide it.
   *
   * A SECOND SET RATHER THAN A MEMBER OF THE FIRST, because the two fold
   * different things: `collapsed` is keyed by ROW key and hides a node's
   * children inside a tree, and this is keyed by GROUP key and hides the whole
   * tree. One set holding both would work until two keys collided, and the
   * failure would be a book that folds when you fold a step.
   *
   * Session-only, like everything else in this panel's view state.
   */
  protected readonly shutBooks = signal<ReadonlySet<string>>(new Set());

  /** Whether the workspace accordion is open. It arrives open: see `foldBook`. */
  protected readonly workspaceOpen = signal(true);

  /**
   * The images somebody has selected in the workspace, by id.
   *
   * IN THE COMPONENT AND NOT IN THE SERVICE. What is selected is a fact about a
   * surface — it dies with the panel and means nothing to anybody else — where
   * the images themselves outlive every redraw and are what the create acts on.
   * Putting the selection in the service would be the same merge of two
   * different lifetimes that made this panel two selectors in the first place.
   */
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());

  /**
   * Where a Shift-range starts from: the last image clicked WITHOUT Shift.
   *
   * A range needs two ends and the platform only gives one; every list of this
   * shape keeps the other. Null until somebody has clicked once, which is why a
   * Shift-click with no anchor behaves as a plain click rather than selecting
   * from the top — the top is not somewhere the person put anything.
   */
  shotAnchor: string | null = null;

  /** Where the workspace's own context menu is, or null. */
  protected readonly shotMenu = signal<{ x: number; y: number } | null>(null);

  /**
   * The images this browser could not draw — see the card's own comment.
   *
   * IT IS NEVER EMPTIED, and it does not need to be: an id here is a folded
   * path, and a file that would not decode a moment ago is the same file with
   * the same path. It empties itself when the workspace does, because the ids
   * that could be in it are the ids of images that are no longer on the table.
   */
  protected readonly undrawable = signal<ReadonlySet<string>>(new Set());

  protected cannotDraw(id: string): void {
    this.undrawable.update((broken) => {
      if (broken.has(id)) return broken;
      const next = new Set(broken);
      next.add(id);
      return next;
    });
  }

  /**
   * The books this panel is about: a project is OPEN while one of its documents
   * is, which is the existing ruling and unchanged (docs/WORKBENCH.md §6c,
   * "Going home"). Closed books live on Home's shelf, not in the library.
   *
   * SEPARATE FROM `groups()` because the ensure effect above must not read a
   * ledger to decide which ledgers to ask for. This is composed from the open
   * tabs and main's catalogue and nothing else.
   */
  readonly openProjects = computed<readonly ProjectSummary[]>(() => {
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

  protected readonly groups = grouping.groups.call(this);

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

  protected readonly acts = acting.acts.call(this);

  protected pick(tab: Tab): void { return picking.pick.call(this, tab); }

  protected pickRow(row: Row): void { return picking.pickRow.call(this, row); }

  protected run(event: MouseEvent, row: Row, act: Act): Promise<void> { return acting.run.call(this, event, row, act); }

  pressed(row: Row, act: Act): Promise<void> { return acting.pressed.call(this, row, act); }

  nodeIdFor(row: Row): string | null { return acting.nodeIdFor.call(this, row); }

  protected act(event: MouseEvent, row: Row, action: HostNodeAction): Promise<void> { return acting.act.call(this, event, row, action); }

  protected canAct(row: Row): boolean { return acting.canAct.call(this, row); }

  stand(row: Row, asked?: Parameters<typeof picking.stand>[1]): Promise<boolean> { return picking.stand.call(this, row, asked); }

  protected toggle(event: MouseEvent, row: Row): void { return picking.toggle.call(this, event, row); }

  protected closeProject(group: Group): void { return closing.closeProject.call(this, group); }

  protected foldBook(key: string): void { return picking.foldBook.call(this, key); }

  protected pickShot(event: MouseEvent, shot: WorkspaceImage): void { return picking.pickShot.call(this, event, shot); }

  protected onShotMenu(event: MouseEvent, shot: WorkspaceImage): void { return picking.onShotMenu.call(this, event, shot); }

  protected createFromChosen(): void { return picking.createFromChosen.call(this); }

  protected shutWorkspace(): Promise<void> { return closing.shutWorkspace.call(this); }

  protected closeBook(event: MouseEvent, row: Row): void { return closing.closeBook.call(this, event, row); }

  protected remove(event: MouseEvent, row: Row): Promise<void> { return closing.remove.call(this, event, row); }

  discard(row: Row): Promise<void> { return closing.discard.call(this, row); }

  protected onMenu(event: MouseEvent, row: Row): void { return closing.onMenu.call(this, event, row); }

  protected fromMenu(row: Row, action: MenuAction): void { return closing.fromMenu.call(this, row, action); }

  protected close(event: MouseEvent, tab: Tab | null): void { return closing.close.call(this, event, tab); }

  protected onAux(event: MouseEvent, tab: Tab | null): void { return closing.onAux.call(this, event, tab); }

  protected onDragStart(event: DragEvent, tab: Tab | null): void { return dragging.onDragStart.call(this, event, tab); }

  protected onDragEnd(): void { return dragging.onDragEnd.call(this); }

  protected onRowOver(event: DragEvent, row: Row): void { return dragging.onRowOver.call(this, event, row); }

  protected onListOver(event: DragEvent): void { return dragging.onListOver.call(this, event); }

  protected onLeave(): void { return dragging.onLeave.call(this); }

  protected onDrop(event: DragEvent, row: Row | null): void { return dragging.onDrop.call(this, event, row); }

  inBook(id: string): boolean { return dragging.inBook.call(this, id); }

  landingFor(event: DragEvent, row: Row): string | null { return dragging.landingFor.call(this, event, row); }

  carriesDocument(event: DragEvent): boolean { return dragging.carriesDocument.call(this, event); }

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
  rootTitle(project: ProjectSummary, origin: LedgerStep | null, problem: string | null): string {
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
