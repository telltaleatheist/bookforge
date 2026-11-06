import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { exportNodeId, type HostOperationOffer } from '@owen/foundry-core/shared/host-ops';
/*
 * THE POSSIBILITY PREDICATES, shared with the dialogs that refuse and with the
 * tree that offers — see shared/stages.ts. This menu held the original of three
 * of them and they were copied into two dialogs; they are one function each now,
 * so a button here and a refusal there cannot come to different answers about
 * what a stage can do.
 */
import {
  canCleanFrom, canExportFrom, canReadPages, canSimplifyFrom,
  canTranslateFrom,
} from '@owen/foundry-core/shared/stages';
import { fold } from '@owen/foundry-core/shared/original';
import { hostActLit } from './action-menu.host-act';
import type { ActName } from '@owen/foundry-core/shared/types';

import { ActGatesService } from '../../core/act-gates.service';
import { hosted } from '../../core/foundry';
import { HostOpsService } from '../../core/host-ops.service';
import { LedgerService } from '../../core/ledger.service';
import { NoticeService } from '../../core/notice.service';
import { ProjectsService } from '../../core/projects.service';
import { isExportView, OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { UnappliedService } from '../../core/unapplied.service';
import * as acts from './action-menu.acts';
import * as gates_ from './action-menu.gates';

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
 * of the block — Home and Documents as small labelled buttons, Settings as an
 * icon square — and the acts are the grid below it. The rules
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
  templateUrl: './action-menu.component.html',
  styleUrl: './action-menu.component.scss',
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
  readonly projects = inject(ProjectsService);
  readonly ledger = inject(LedgerService);
  /**
   * THE OTHER HALF OF EVERY MAKE-TILE'S GATE — what this MACHINE can run.
   *
   * The predicates beside it (`canTranslate`, `canClean`, …) ask the LEDGER: is
   * there a book at this position for the act to be aimed at. They cannot ask
   * whether anything is SERVING the act, because that does not live in the
   * renderer — it is measured in main (electron/act-gates.ts) off the server
   * registry's capability reads, the settings file and the page reader's
   * directory.
   *
   * IT USED TO MEASURE THIS MACHINE as well — the hardware probe and Ollama's
   * library, for Owen's *"the tiles arent lit up until the models are present"*
   * and his rule that a translation on a processor *"should just be disabled"*
   * (docs/SLOTS.md §1). Both were about work that ran here, and none does:
   * 2026-09-15, *"if theres no connected crucible server then tiles should be
   * disabled."*
   *
   * BOTH HAVE TO SAY YES, and they are kept apart because they say different
   * things when they say no — a tile that greyed because no engine is connected
   * while its tooltip said "there is no book at this step" would be sending
   * somebody to open a book that was never the problem.
   */
  readonly gates = inject(ActGatesService);
  readonly hostOps = inject(HostOpsService);
  readonly notices = inject(NoticeService);
  /** The card before any of the four make-acts below runs past unapplied work. */
  readonly unapplied = inject(UnappliedService);
  readonly router = inject(Router);

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

  press(operationId: string, dir: string, nodeId: string): void { return acts.press.call(this, operationId, dir, nodeId); }

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
  readonly target = computed<string | null>(() => {
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
   *
   * ── AND IT READS THE PRESS NOW (Owen, 2026-11-06) ─────────────────────────
   *
   * The dock has refused a press from a scan since 2026-09-11, so a lit tile there
   * only ever led to a sentence. `hostActLit` greys it instead: a scan with no
   * text, and a read book standing on its scan row with no export, where clicking
   * the reading's row in the tree lights it.
   */
  protected readonly hostReady = computed<boolean>(() => {
    const dir = this.target();
    if (dir === null) return false;
    const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    return hostActLit(project, acts.hostActAim.call(this, dir));
  });

  protected runHostAct(operationId: string): Promise<void> { return acts.runHostAct.call(this, operationId); }

  hostActPressed(operationId: string): Promise<void> { return acts.hostActPressed.call(this, operationId); }

  protected home(): void { return acts.home.call(this); }

  protected convert(): void { return acts.convert.call(this); }

  protected ocrWaiting(): boolean { return gates_.ocrWaiting.call(this); }

  protected canExport(): boolean { return gates_.canExport.call(this); }

  protected machineLit(act: ActName): boolean { return gates_.machineLit.call(this, act); }

  protected ocrTitle(): string { return gates_.ocrTitle.call(this); }

  protected translateTitle(): string { return gates_.translateTitle.call(this); }

  protected simplifyTitle(): string { return gates_.simplifyTitle.call(this); }

  protected cleanTitle(): string { return gates_.cleanTitle.call(this); }

  protected analysisTitle(): string { return gates_.analysisTitle.call(this); }

  protected openExport(): Promise<void> { return acts.openExport.call(this); }

  protected canTranslate(): boolean { return gates_.canTranslate.call(this); }

  protected translate(): Promise<void> { return acts.translate.call(this); }

  protected canSimplify(): boolean { return gates_.canSimplify.call(this); }

  protected simplify(): Promise<void> { return acts.simplify.call(this); }

  protected canClean(): boolean { return gates_.canClean.call(this); }

  protected clean(): Promise<void> { return acts.clean.call(this); }

  protected canAnalyse(): boolean { return gates_.canAnalyse.call(this); }

  protected analyse(): void { return acts.analyse.call(this); }

  protected canEditMetadata(): boolean { return gates_.canEditMetadata.call(this); }

  protected metadata(): void { return acts.metadata.call(this); }
}

/**
 * ONE empty array for a menu with no host behind it — a fresh `[]` per call
 * would be a new identity on every repaint, and this is read inside a computed.
 */
const NO_ACTS: readonly HostOperationOffer[] = [];
