import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { joinedQuad, mintedPageIds, sameShape, turnedLike } from '@shared/capture';
import type { CaptureQuad } from '@shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { ConfirmService } from '../../core/confirm.service';
import { CaptureService, isComplete } from '../../core/capture.service';
import type { Tab } from '../../core/documents.service';
import {
  CaptureEditorModalComponent,
  type EditorFrame,
} from '../capture-editor/capture-editor-modal.component';
import type { FractionQuad } from '../capture-editor/geometry';
import { CaptureGridComponent } from '../capture-grid/capture-grid.component';
import { CaptureRailComponent, type Population } from '../capture-rail/capture-rail.component';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';

/**
 * THE LIGHT TABLE — a capture project's whole surface, and the viewer's third
 * branch.
 *
 * ── What this component is FOR, which is almost nothing ─────────────────────
 *
 * It owns one piece of state: WHICH PHOTOGRAPH IS OPEN. Everything else it
 * holds is somebody else's — the recipe is `CaptureService`'s, the cards are its
 * `cards` computed, the gestures are `CapturePageEditorComponent`'s, and the
 * rules about what a gesture MEANS are in `geometry.ts` and the service. This
 * file routes between two children and a service and does not decide anything
 * either of them could decide better.
 *
 * That is deliberate rather than modest. The editor is testable by pointing it
 * at any image with any quads precisely because it has never heard of a project,
 * and the grid can be handed a list of cards from anywhere. Putting the recipe
 * into either of them would have bought one less file and lost that.
 *
 * ── The tab is a DIRECTORY, and that is why the open lives in an effect ─────
 *
 * `Tab.path` here is the project directory (`pathIsProject`, documents.service),
 * so there is no file to load and nothing arrives through `document:opened`.
 * The recipe comes from `capture:recipe-load`, asked for whenever the tab
 * changes — an effect rather than a constructor call, because a tab input can
 * be re-pointed at another project without this component being rebuilt.
 *
 * ── ONE SERVICE FOR THE WHOLE APP, AND THAT IS A LIMIT WORTH KNOWING ────────
 *
 * `CaptureService` is `providedIn: 'root'` and holds ONE recipe, so two capture
 * projects open at once would share it and the second would evict the first.
 * Today that cannot happen: `captureTabIn` never makes a second tab for the same
 * project, and the workspace shows one document at a time. It WOULD happen the
 * day capture panes can be compared side by side, and the fix then is a service
 * instance per tab rather than a flag here. Written down because the failure —
 * two tables showing one recipe — would look like a redraw bug rather than a
 * scoping one.
 */
/*
 * `ACKNOWLEDGED_FOR_MS` STOOD HERE — how long a pressed button said "Applied ✓".
 *
 * It belonged to four presses in the modal and every one of them is gone
 * (Wave 51). What replaced them is the gesture itself, which acknowledges by
 * moving the picture, the cards behind it and the filmstrip below.
 */

@Component({
  selector: 'app-capture-view',
  imports: [CaptureGridComponent, CaptureEditorModalComponent, CaptureRailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      THE OPEN PHOTOGRAPH LEAVING THE RECIPE USED TO STRAND THIS SCREEN.
      There was an @else here drawing "That photograph is no longer in this
      project" as a bare paragraph between the table and the mint footer --
      with no way to dismiss it, because the open id stayed set and the modal that
      owns Escape was the thing that had gone. And the table below it was DEAF,
      since it stops answering the keyboard while something is open over it.
      Closing is the whole of the right answer; the table reappearing says the
      photograph is gone better than a sentence about it would.
    -->
    <div class="table">
      <!--
        THE TABLE IS ALWAYS DRAWN NOW. The editor used to REPLACE it, so leaving
        meant a button called "All photographs" and coming back meant finding
        your card again. It is a modal since Wave 21, and a modal is something
        you open rather than somewhere you go.
      -->
      <app-capture-grid
          [active]="open() === null"
          [cards]="captures.cards()"
          [arranged]="captures.arranged()"
          [projecting]="captures.pass() === 'split'"
          (reorder)="captures.reorder($event)"
          (open)="openPage($event)"
          (strike)="captures.toggleStrike($event)"
          (sortBy)="captures.sortBy($event.key, $event.descending)"
          (dropped)="captures.intake(tab().path, $event)"
        (remove)="void confirmRemoval($event)"
          (turn)="captures.turnPhotos($event.photos, $event.turns)"
          (follow)="followThese($event)"
      />
    </div>

    <!--
      THE RAIL, AND WHY THE MINT MOVED INTO IT.

      Mint used to sit in a footer under the table, which is where Owen found it
      before he had turned a single page: the surface offered the LAST ACT
      FIRST, and the three things you do before it were inside a modal you had
      to know to open. The rail puts the three verbs in front of the act and the
      act at the foot of them, and the gate is what makes that an order rather
      than a suggestion.
    -->
    <app-capture-rail
      [counts]="captures.prepare()"
      [prepared]="prepared()"
      [mintable]="mintable()"
      [minted]="minted()"
      [progress]="mint.progress()"
      [diverged]="captures.diverged()"
      [pass]="captures.pass()"
      [standing]="hasCrop()"
      [bookCut]="hasCut()"
      [sided]="captures.sided()"
      [cost]="captures.applyCost()"
      (open)="openTool()"
      (tick)="captures.tick($event)"
      (mint)="void startMint()"
      (stop)="mint.cancel()"
      (applyCrops)="captures.applyCrops()"
      (applyCuts)="captures.applyCuts()"
      (reopen)="captures.reopen()"
      (select)="showPopulation($event)"
    />

    @if (open() !== null) {
      @if (opened(); as photo) {
        <app-capture-editor-modal
          [label]="photo.label"
          [source]="captures.url(photo.workingCopy)"
          [dimensions]="photo.dimensions"
          [quads]="photo.quads"
          [split]="photo.split"
          [pass]="captures.pass()"
          [ghost]="ghost()"
          [hasPrevious]="walkIndex() > 0"
          [hasNext]="walkIndex() < walk().length - 1"
          [name]="photo.name"
          [global]="global()"
          [scope]="captures.scope()"
          [own]="photo.complete"
          [theirOwn]="captures.prepare().complete"
          [bookCut]="bookCut()"
          [frames]="frames()"
          [here]="open()"
          (turnBy)="turnThis(photo.id, $event)"
          (clearCrop)="clearCropHere(photo.id)"
          (twoPagesChange)="setTwoPages(photo.id, $event)"
          (quadsChange)="setQuads(photo.id, $event)"
          (splitChange)="captures.setSplit(photo.id, $event, !global())"
          (settled)="settle(photo.id)"
          (globalChange)="captures.setGlobal($event)"
          (scopeChange)="captures.setScope($event)"
          (resetAll)="void confirmReset()"
          (followAll)="void confirmFollowAll()"
          (jump)="open.set($event)"
          (step)="step($event)"
          (close)="open.set(null)"
        />
      }
    }

  `,
  styles: `
    /*
     * A ROW SINCE WAVE 21b, AND IT USED TO BE A COLUMN. The column existed to
     * stack the mint footer under the table; the mint is at the foot of the
     * rail now, so what is left is two things side by side and no wrapper is
     * needed to say so.
     */
    :host {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      height: 100%;
      min-height: 0;
    }

    /* The rail sizes itself; the table takes what is left, which is why the
       photographs get wider on a wider window and the rail does not. */
    .table {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }

    /*
     * THE FOOTER'S RULES ARE GONE WITH THE FOOTER (Wave 21b) -- .bar, .grow,
     * .which, .mint, .count, .progress, .quiet and .act all styled a strip
     * under the table that the prepare rail replaced. They are not moved here
     * in spirit; the rail declares its own, because of the lesson the deleted
     * block existed to record:
     *
     * ANGULAR COMPONENT STYLES ARE SCOPED, so a button in a new component
     * inherits nothing from the grid, the editor or any dialog. This file once
     * shipped four buttons with no rules at all -- one of them MINT THE PAGES --
     * rendering native white, the same defect Owen found in the new-project
     * modal, which had carried confirm-dialog's class names and none of its
     * rules. Any component that grows a button grows the rules for it in the
     * same file, and capture-rail.component.ts does.
     */
  `,
})
export class CaptureViewComponent {
  protected readonly captures = inject(CaptureService);
  protected readonly mint = inject(CaptureMintService);
  private readonly confirm = inject(ConfirmService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  readonly tab = input.required<Tab>();

  /** The photograph on the editor, by photo id, or null for the whole table. */
  protected readonly open = signal<string | null>(null);

  /*
   * A `justApplied` SIGNAL AND ITS TIMER STOOD HERE (Wave 51).
   *
   * They lit whichever modal button had just been pressed, for a second and a
   * half, because those presses had their effect somewhere a person could not
   * see. The presses are gone and so is the problem: propagation happens under
   * the hand, on the picture, the cards and the strip at once.
   */

  /**
   * THE PHOTOGRAPHS IN THE ARRANGEMENT'S OWN SEQUENCE, for prev/next.
   *
   * ── It walks PHOTOGRAPHS and the readout says PAGES ─────────────────────────
   *
   * Owen asked to "go from one page to the next", and the honest mapping is not
   * one to one: the editor edits a PHOTOGRAPH, and after a split one photograph
   * carries two pages. Walking the order page by page would show the same
   * picture twice in a row and call it two different numbers, which is worse
   * than either count on its own.
   *
   * So the step is a photograph and the label carries both facts -- "Photograph
   * 5 of 27, pages 9-10 of 54". The page numbers are what he will count in the
   * finished book; the photograph number is what is on the screen in front of
   * him. Neither number has to be inferred from the other.
   *
   * ── In the ORDER, not in `photos` ──────────────────────────────────────────
   *
   * The order is the arrangement, and the arrangement is what the grid draws and
   * the mint walks. Stepping through `recipe.photos` would be intake sequence,
   * which after any drag is a different book. First appearance decides a
   * photograph's place, so a split whose halves have been dragged apart still
   * has one position rather than two.
   *
   * ── STRUCK PAGES ARE INCLUDED, DELIBERATELY ────────────────────────────────
   *
   * A photograph whose pages are all struck stays in the walk. Skipping it would
   * make it unreachable from the editor -- which is exactly where somebody would
   * go to check whether they struck the right one, or to look at it before
   * putting it back. It is the grid that shows a strike; the editor should not
   * be the surface that hides it.
   */
  protected readonly walk = computed(() => {
    const recipe = this.captures.recipe();
    if (recipe === null) return [];
    const seen: string[] = [];
    for (const pageId of recipe.order) {
      const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
      if (photo !== undefined && !seen.includes(photo.id)) seen.push(photo.id);
    }
    return seen;
  });

  protected readonly walkIndex = computed(() => {
    const id = this.open();
    return id === null ? -1 : this.walk().indexOf(id);
  });

  constructor() {
    /*
     * If the open photograph leaves the recipe, close. It is only reachable
     * through a hand-edited file today, and it is written as a rule rather than
     * a screen because the failure it prevents is a stuck one: nothing else on
     * this surface can clear `open` once the modal is not there to be closed.
     */
    effect(() => {
      if (this.open() !== null && this.opened() === null) this.open.set(null);
    });
    effect(() => {
      const directory = this.tab().path;
      // Back to the table whenever the project changes: an id from one recipe
      // means nothing in another, and the "no longer in this project" branch is
      // for a photograph that genuinely went, not for a tab that moved.
      this.open.set(null);
      void this.captures.open(directory);
    });
  }

  /**
   * Everything the editor needs about the open photograph, or null if it went.
   *
   * The quads are handed over as the recipe holds them — fractions — because
   * that is the unit the editor works in end to end (`geometry.ts`); the pixels
   * only exist inside the shader and inside the mint's page list.
   */
  protected readonly opened = computed(() => {
    const id = this.open();
    const recipe = this.captures.recipe();
    if (id === null || recipe === null) return null;
    const photo = recipe.photos.find((one) => one.id === id);
    if (photo === undefined) return null;
    const at = this.walk().indexOf(photo.id);
    // Where this photograph's pages fall in the finished book, asked of the
    // ONE function that decides what the book is. This used to walk the order
    // and skip the struck here -- one of THREE bodies of that rule, the other
    // two being the footer thirty lines below and mintBegin across the bridge.
    // All three agreed, because all three were written from the same sentence,
    // which is exactly what outputSizeFor and sameShape did before they were
    // lifted. Caught by P1 before any of them drifted, which is the first time
    // in this feature that shape has been found early rather than late.
    const kept = mintedPageIds(recipe);
    const mine = photo.pages.filter((page) => !page.struck).map((page) => kept.indexOf(page.id) + 1);
    const pages = mine.length === 0
      ? 'struck'
      : mine.length === 1
        ? `page ${mine[0]} of ${kept.length}`
        : `pages ${mine[0]}-${mine[mine.length - 1]} of ${kept.length}`;
    return {
      id: photo.id,
      label: `Photograph ${at + 1} of ${this.walk().length} · ${pages}`,
      name: photo.name ?? null,
      workingCopy: photo.workingCopy,
      dimensions: { width: photo.width, height: photo.height },
      quads: photo.pages.map((page) => page.quad) as readonly FractionQuad[],
      // The segment itself. The interim seam that measured it back into a
      // fraction for the old editor is gone with the editor that needed one.
      split: photo.split,
      /*
       * THE ONE TEST, ASKED OF THE SERVICE. It used to be `handSet` -- "does any
       * page of this carry byHand" -- which is provenance and was the skip rule
       * only until Wave 25. A photograph completed by the say-so has no
       * fingerprint on any corner and is skipped by every global all the same,
       * so a second reading here would have told the person one thing while the
       * Apply did another.
       */
      complete: isComplete(photo),
    };
  });

  /**
   * THE BOOK ALONG THE MODAL'S FOOT — every photograph, in the walk's order.
   *
   * Photographs and not cards, because the strip is the WALK and the walk steps
   * through pictures: a cut spread is two cards on the table and one stop in
   * here, and a strip that drew it twice would say the book is longer than the
   * arrows can reach.
   *
   * The thumbnail is the same 640 px file the cards use, already served by the
   * capture door, so a strip of fifty costs the browser what one table costs.
   */
  protected readonly frames = computed<readonly EditorFrame[]>(() => {
    const recipe = this.captures.recipe();
    if (recipe === null) return [];
    const frames: EditorFrame[] = [];
    for (const id of this.walk()) {
      const photo = recipe.photos.find((one) => one.id === id);
      if (photo === undefined) continue;
      frames.push({
        id,
        thumb: this.captures.url(photo.thumb),
        // The same fallback the skip sentences use: a position, never a sha.
        label: photo.name ?? `Photograph ${frames.length + 1}`,
        complete: isComplete(photo),
      });
    }
    return frames;
  });

  /**
   * THE BOOK'S CROP, IN THE OPEN PHOTOGRAPH'S TERMS — the ghost under its own.
   *
   * ── Why it is composed here and not in the editor ────────────────────────
   *
   * Three of the four decisions are about the RECIPE, and the editor holds none:
   * whether there is a standing at all, whether it was drawn for a frame of this
   * shape, and which way round this photograph is sitting. `turnedLike` is the
   * relabelling `wearing` does for the same reason -- the standing carries the
   * turn of the page it was lifted from, and a ghost drawn without it would lie
   * about a photograph somebody had turned upright.
   *
   * ── AND IT IS ABSENT WHEN IT WOULD SIT EXACTLY UNDER THE OUTLINE ─────────
   *
   * Which is the common case: every following photograph holds the standing
   * exactly, so a dashed line would be drawn on top of a solid one on most of
   * the book, for no information at all. The mark exists to make a DEVIATION
   * visible, so it is drawn only where there is one.
   *
   * Null through the whole split pass, where the frame is settled and the stage
   * is drawing the page rather than the photograph.
   */
  protected readonly ghost = computed<CaptureQuad | null>(() => {
    if (this.captures.pass() === 'split') return null;
    const id = this.open();
    const recipe = this.captures.recipe();
    // THIS PHOTOGRAPH'S SIDE OF THE BOOK, since Wave 51b: on a recto/verso shoot
    // the book has two crops, and drawing the other side's under this outline
    // would mark a deviation from a rectangle this page was never going to be
    // given.
    const crop = id === null ? undefined : this.captures.standingFor(id)?.crop;
    if (id === null || recipe === null || crop === undefined) return null;
    const photo = recipe.photos.find((one) => one.id === id);
    if (photo === undefined || !sameShape(crop, photo)) return null;
    const facing = photo.pages[0]?.quad;
    if (facing === undefined) return null;
    const book = turnedLike(crop.quad, facing);
    const own = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
    return alike(book, own) ? null : book;
  });

  /**
   * How many pages a mint would write.
   *
   * NOT "as the mint does" any more -- it is the mint's own function. The
   * footer promises this number, the readout above promises a position within
   * it, and mintBegin decides what actually gets printed; a person who crops for
   * an hour, reads "of 54" and then counts the PDF is owed all three being the
   * same arithmetic rather than the same intention.
   */
  /*
   * A `handSet` COUNT STOOD HERE, then a `cost`, and both went with the question
   * they were asked for.
   *
   * The count gated an override dialog on "is anything in this project hand-set"
   * -- which fired whenever ANYTHING was, including the source itself and
   * photographs of other shapes that a stamp skips for a reason no answer could
   * change. Wave 24 narrowed it to the population a press would actually spare.
   * Wave 25 deleted the press, the dialog and the question together: complete
   * photographs are left out of every global, and release is the door for a
   * person who wants one back in the flow.
   */

  /** The ticks, or an empty answer while nothing is loaded. */
  /**
   * SAID OR EVIDENT — the rail's ticks show the person's word OR'd with what
   * the work itself proves (Owen, 2026-08-22: \`"it should auto-check the one
   * i already worked on"\`). Nothing ever clears a said tick; see
   * \`CaptureService.evident\` for the half of the old ruling that survives.
   */
  protected readonly prepared = computed(() => {
    const said = this.captures.recipe()?.prepared ?? {};
    const evident = this.captures.evident();
    return {
      turned: said.turned === true || evident.turned,
      cropped: said.cropped === true || evident.cropped,
      split: said.split === true || evident.split,
    };
  });

  /**
   * WHETHER THIS PROJECT HAS A BOOK YET, which changes one word on the mint
   * button and nothing else.
   *
   * Asked of the CATALOGUE rather than of the recipe, because the recipe cannot
   * know: a mint writes pages and a ledger step and leaves the recipe
   * byte-identical, which is the property that lets a person keep editing after
   * one.
   *
   * IT ASKS `originalOf` AGAIN, which is where this question started and where
   * Wave 41 put it back. For two days a mint filed NO document row -- a folder
   * of page images is not a file type anything can open -- so `originalOf`
   * answered null over a finished book and the button would have said "Finish
   * the pages" forever, including to somebody looking at a book they had already
   * made. A summary field called `pages` stood in for it.
   *
   * A mint catalogues its PDF now (`catalogueMint`, electron/projects.ts), so
   * the original is there to be found and the stand-in is gone. One question,
   * asked of the catalogue, in the words every other surface uses.
   *
   * NOT the same question as the divergence sentence, which asks whether the
   * book on the shelf was made from THIS arrangement -- that one is main's
   * single resolution and lands with it.
   */
  protected readonly minted = computed<boolean>(() => {
    const project = this.projects.projectFor(this.tab().path);
    return project !== null && this.projects.originalOf(project) !== null;
  });

  /**
   * WHOSE HAND IS ON THE HANDLES — the Global tick, and it is the SERVICE'S.
   *
   * ── It used to be derived from the open photograph, and Wave 51b stopped ──
   *
   * `!isComplete` of whatever was in front of you: an honest reading of a state,
   * and a box that ticked itself back on at every step. Owen's second half of an
   * evening is one pass through fifty pages nudging each one, so that box had to
   * be unticked fifty times and any one he forgot moved the whole book.
   *
   * It is a MODE now, owned by the service, flipped only by a click — see
   * `CaptureService.global`. This surface reads it and passes it down, and the
   * one thing it still decides is what a gesture MEANS while the mode is off
   * (`setQuads`, below): that hand is the page's own.
   */
  protected readonly global = this.captures.global;

  /*
   * A `cost` COMPUTED STOOD HERE and went with the press it costed.
   *
   * It asked `stampCost` what *Crop all* would do from the open photograph, for
   * the three-population sentence under that button. The modal's press is a
   * RECORD now: it reaches the book's standing and no photograph at all, so
   * there is no population to name and nothing for a count to be about. The
   * counting moved with the act -- `applyCost`, on the rail, under the Apply.
   */

  /** The cut the tick would use, or null when only the middle is available. */
  protected readonly bookCut = computed(() => {
    const id = this.open();
    return id === null ? null : this.captures.bookCutFor(id);
  });

  protected readonly mintable = computed(() => {
    const recipe = this.captures.recipe();
    return recipe === null ? 0 : mintedPageIds(recipe).length;
  });

  /**
   * Whether the book has a crop, and whether it has a cut.
   *
   * The rail draws an Apply only where one would do something, so these are the
   * two facts that decide whether a control exists at all. They are asked of
   * the recipe rather than derived from a count, because zero photographs able
   * to take the standing and NO STANDING AT ALL are different states with
   * different sentences: one says "everything is complete already", the other
   * says "go and set one".
   *
   * ANY OF THE STANDINGS, since Wave 51b — the book's own or either side's. A
   * project whose odd pages have a crop and whose book has none has something to
   * finalize, and a rail that drew no button would be hiding an act that works.
   */
  protected readonly hasCrop = this.captures.anyCrop;
  protected readonly hasCut = this.captures.anyCut;

  /** The table, for the one thing a parent has to ask it to do. See below. */
  private readonly grid = viewChild(CaptureGridComponent);

  /**
   * WHICH CARDS EACH OF THE RAIL'S THREE COUNTS IS ABOUT.
   *
   * The membership is the service's (`applyPopulations` — one walk, whose
   * lengths ARE `applyCost`), so the sentence under the button and the cards a
   * press lights cannot disagree. What this computed adds is only the
   * translation the table needs: PAGE ids, in the table's own order, because
   * that is what a selection is made of — a spread is two cards on one
   * photograph and selecting the photograph means lighting both.
   *
   * (The membership door was routed in by the lead at P2's landing, on P2's own
   * recommendation — the second walk that stood here carried its invariant in a
   * comment, which is a promise, not an enforcement.)
   *
   * EMPTY UNTIL THE BOOK HAS A CROP, because with no standing there are no
   * populations: `applyCost` returns zeros in that state and the rail draws no
   * counts to press.
   */
  private readonly populations = computed<Record<Population, readonly string[]>>(() => {
    const members = this.captures.applyPopulations();
    const pagesOf = (photos: readonly string[]): readonly string[] => {
      const wanted = new Set(photos);
      return this.captures.cards().filter((card) => wanted.has(card.photoId)).map((card) => card.id);
    };
    return { follow: pagesOf(members.takes), complete: pagesOf(members.complete), shape: pagesOf(members.shape) };
  });

  /**
   * A COUNT ON THE RAIL WAS PRESSED: show me those ones.
   *
   * Wave 24 deferred this out loud and named what it would take -- "a selection
   * input on the grid, whose `chosen` is private today, plus scroll-into-view
   * to be worth having". The grid grew a `showOnly` door for it; this is the
   * only thing on this surface that reaches into a child rather than handing it
   * an input, and the door's own docblock argues why a selection REQUEST cannot
   * honestly be state.
   */
  protected showPopulation(which: Population): void {
    this.grid()?.showOnly(this.populations()[which]);
  }

  /**
   * FOLLOW THE BOOK AGAIN — the right-click door's other end.
   *
   * One call per photograph, which is what the service asks for and costs
   * nothing: every writer here goes through the same debounced save, so nine
   * hand-backs are nine edits and one write.
   *
   * ── IT TAKES THE BOOK'S LINES NOW, WHERE RELEASE USED TO WAIT ────────────
   *
   * The old door cleared the mark and left the picture exactly as it was; the
   * next Apply was what moved it. That gap made sense while propagation was a
   * button somebody pressed later. With it live there is nothing to wait for,
   * and a page that gave up its mark and kept lines the book does not have would
   * be a follower that does not follow until some unrelated act corrects it. So
   * the press hands the lines over as well — `matchTheOthers`, which is the same
   * door re-ticking *Global* in the modal opens.
   *
   * NO CONFIRM, deliberately, where removal has one. Nothing is destroyed that
   * is not immediately visible: the cards under the menu redraw, and moving a
   * corner takes the photograph straight back.
   */
  protected followThese(photoIds: readonly string[]): void {
    for (const id of photoIds) this.captures.matchTheOthers(id);
  }

  /**
   * One photograph along the arrangement, clamped at both ends.
   *
   * Clamped rather than wrapping: fifty-four crops is a long sitting, and an
   * arrow that silently returns to the first photograph after the last would
   * make somebody redo work they had already done without noticing they had
   * gone round.
   */
  protected step(by: number): void {
    const order = this.walk();
    const at = this.walkIndex();
    if (at < 0) return;
    const next = order[Math.min(order.length - 1, Math.max(0, at + by))];
    if (next !== undefined) this.open.set(next);
  }

  /*
   * THE ARROWS USED TO BE ANSWERED HERE TOO, AND THAT MEANT TWICE.
   *
   * This component kept a window:keydown for ArrowLeft/ArrowRight, guarded on
   * "something is open" -- which is exactly when the modal is mounted, and the
   * modal answers the same two keys on the same window. Both listeners fire for
   * one press and both call step(), so every arrow moved TWO photographs and
   * the walk skipped every other picture on the way through the shoot.
   *
   * Window listeners do not nest, so this was not fixable by stopping
   * propagation in the modal: they are siblings on one target, not a chain.
   * The fix is ownership -- the surface the keys belong to is the one they are
   * about, and that is the modal.
   */

  /**
   * Ask before removing, then remove.
   *
   * ── The question names what CANNOT be undone, and what is not lost ──────────
   *
   * Removal deletes the bank copy as well as the derived files, which sounds
   * worse than it is and has to be SAID rather than softened: the originals in
   * a capture project are copies, and the files the person dragged in are still
   * wherever they dragged them from. A confirm that hid that would be asking
   * somebody to be frightened of the wrong thing; one that omitted the deletion
   * would be hiding the real cost.
   *
   * ── IT TAKES PHOTOGRAPHS, ALREADY FOLDED ────────────────────────────────────
   *
   * This used to fold page ids to photographs itself, which was correct and was
   * the SECOND place doing it -- the grid's context menu counted raw pages and
   * called them photographs, so on a split shoot the menu offered to delete 52
   * and this asked about 27. The fold moved into the grid, where the menu can
   * see it, and this takes what that offered. One fold, one number, one act.
   */
  protected async confirmRemoval(photoIds: readonly string[]): Promise<void> {
    if (photoIds.length === 0) return;
    const many = photoIds.length !== 1;
    const agreed = await this.confirm.ask({
      message: many
        ? `Remove ${photoIds.length} photographs from this project?`
        : 'Remove this photograph from this project?',
      detail: [
        many
          ? 'Their pages leave the book, and the copies this project made of them are deleted.'
          : 'Its pages leave the book, and the copies this project made of it are deleted.',
        'The files you dragged in are untouched, wherever you dragged them from.',
      ],
      confirm: many ? `Remove ${photoIds.length}` : 'Remove',
    });
    if (agreed) await this.captures.remove(photoIds);
  }

  /**
   * A rail row: open the editor where the work is.
   *
   * ── The verb is no longer carried, and the row still means something ──────
   *
   * It used to set a TOOL the modal opened on, because Turn, Crop and Split were
   * three modes in there. The modes are gone (Wave 24) -- every control is on
   * screen at once -- so the three rows open the same room, and what each one
   * still says is "start a pass through the book thinking about this".
   *
   * IT DOES NOT MOVE SOMEBODY WHO IS ALREADY IN THE ROOM, which matters more now
   * than it did: with no tool to change, taking a person back to photograph 1
   * would be the only thing the press did.
   */
  protected openTool(): void {
    if (this.open() !== null) return;
    const first = this.walk()[0];
    if (first !== undefined) this.open.set(first);
  }

  /** A card was clicked: the editor opens on the PHOTOGRAPH that page is on. */

  protected openPage(pageId: string): void {
    const recipe = this.captures.recipe();
    if (recipe === null) return;
    /*
     * A card is a PAGE and the editor edits a PHOTOGRAPH, which is not a
     * mismatch: both halves of a split are corners on one picture, and an editor
     * showing one half of a spread could not draw the split line that made it.
     */
    const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (photo !== undefined) this.open.set(photo.id);
  }

  /**
   * The corners moved. WHOSE CORNERS is the tick's answer, not this file's.
   *
   * `mine` is false while *Global* is ticked, so a drag that is the book's does
   * not mark the photograph as somebody's own — which would opt it out of the
   * standing it is in the middle of authoring. The propagation itself waits for
   * `settle` below: this runs per pointermove.
   */
  protected setQuads(photoId: string, quads: readonly FractionQuad[]): void {
    this.captures.setQuads(photoId, quads as readonly CaptureQuad[], !this.global());
  }

  /**
   * A GESTURE ENDED AND THE BOOK WAS FOLLOWING IT — hand the lines over.
   *
   * ── Why this is the moment, and not every pointermove ────────────────────
   *
   * The drag writes the recipe continuously, because the recipe is what the
   * screen draws. Dressing every follower is a walk over the whole book that
   * re-derives halves and rebuilds the arrangement, and doing it sixty times a
   * second would be twenty-five photographs re-cut for each pixel of travel.
   * Once, when the hand opens, is the same outcome for a fraction of the work —
   * and it is also the honest reading of the gesture: what a person meant is
   * where they let go.
   *
   * WHICH PASS DECIDES WHAT IS LIFTED. The crop pass hands over the sheet and
   * the cut together (a standing carries both); the split pass hands over the
   * cut alone, because by then the crops are committed and this photograph may
   * not be speaking for them.
   */
  protected settle(photoId: string): void {
    if (this.global()) this.lead(photoId);
  }

  /**
   * THE BOOK ADOPTS THIS PHOTOGRAPH'S LINES — one call, one place to get the
   * pass right.
   *
   * The callers used to read `global()` BEFORE their act and carry the answer,
   * because the tick was derived from the photograph and the act itself could
   * mark it — clearing a crop and rejoining a spread both do — so re-asking
   * afterwards found the box already off and dropped the propagation the person
   * was watching for. The mode cannot move under an act (Wave 51b), so the
   * dance is gone; the reads are left where they are because reading a mode
   * once at the top of a method is still the clearer sentence.
   *
   * WHICH SIDE OF THE BOOK it speaks for is the service's too, taken from the
   * scope beside the tick. It is not passed down for the reason the mode is not:
   * this file would only be carrying it from one signal to one door.
   */
  private lead(photoId: string): void {
    this.captures.leadTheBook(photoId, this.captures.pass() === 'split' ? 'cut' : 'crop');
  }

  /** Turn this photograph, or the whole book with it. The tick decides. */
  protected turnThis(photoId: string, turns: number): void {
    if (this.global()) this.captures.turnWithTheBook(photoId, turns);
    else this.captures.turnPhotos([photoId], turns);
  }

  /** Take the crop off this photograph, and off the followers if it leads. */
  protected clearCropHere(photoId: string): void {
    const leading = this.global();
    this.captures.clearCrop(photoId);
    if (leading) this.lead(photoId);
  }

  /*
   * `setGlobal` STOOD HERE AND THE TICK NO LONGER TOUCHES A PHOTOGRAPH.
   *
   * It ran the two halves of Wave 51's checkbox: ticked, the book adopted this
   * page's lines; unticked, `markComplete` took the page out of the book's
   * hands. Both are gone with the derived box (`global` above).
   *
   * The tick arms the MODE and moves nothing — `captures.setGlobal`, straight
   * from the template, because there is nothing left for this file to decide.
   * What each half did survives in the gesture: with the mode on, a drag on a
   * page that was its own hands it back AND leads the book (`leadTheBook`, whose
   * lead is always dressed); with the mode off, a drag marks the page its own
   * (`setQuads`, `mine`). Re-ticking now moves nothing until the next gesture,
   * which is the whole point of a mode — a box that re-dressed the book on being
   * ticked could not be ticked in preparation for anything.
   */

  /**
   * PUT THE WHOLE BOOK BACK, having asked first.
   *
   * ── The one confirmed global in this stage, and the question says why ─────
   *
   * Every other act here spares a photograph somebody placed by hand. This one
   * reaches them, which is the whole reason it exists — the evening where the
   * assumption that a hand-placed crop is correct is the thing that went wrong —
   * and a reach like that has to be asked for rather than discovered. The detail
   * names what SURVIVES as well as what goes, on `confirmRemoval`'s rule: a
   * person should be frightened of the right thing and no more.
   */
  protected async confirmReset(): Promise<void> {
    const splitting = this.captures.pass() === 'split';
    const agreed = await this.confirm.ask({
      message: splitting
        ? 'Put every page in this book back together?'
        : 'Give every photograph in this book the whole frame back?',
      detail: splitting
        ? [
            'Every spread is rejoined into one page and the book\'s cut is cleared — including '
            + 'the ones you cut yourself.',
            'Every crop stays exactly where it is, and nothing is deleted: the photographs are '
            + 'all still here.',
          ]
        : [
            'Every crop is cleared and so is the book\'s own — including the pages you placed '
            + 'yourself.',
            'The turns stay, and nothing is deleted: the photographs are all still here.',
          ],
      confirm: splitting ? 'Rejoin them all' : 'Reset them all',
    });
    if (agreed) this.captures.resetAll(splitting ? 'cut' : 'crop');
  }

  /**
   * GIVE EVERY PAGE SOMEBODY SET THEMSELVES BACK TO THE BOOK, having asked.
   *
   * ── Owen's ruling, and why the confirm is not optional ────────────────────
   *
   * *"if the page was individually edited, it's exempt from the global
   * settings, unless the user specifically overrides all individual settings to
   * revert to global."* The exemption holds everywhere in this stage; this is
   * the override, and it is the second act in the whole feature that overrules a
   * hand. `followThese` above needs no question because it reaches the
   * photographs somebody has just selected and one drag takes any of them back.
   * This one reaches a population the person cannot see from inside the modal,
   * and the lines it replaces were placed one at a time over an evening.
   *
   * ── THE COUNT IS THE QUESTION ─────────────────────────────────────────────
   *
   * "Some pages will change" is the shape of question people press through.
   * *Seven photographs you set yourself* is a number somebody can weigh against
   * what they remember doing — and it is `prepare().complete`, the same
   * derivation as the dots on the cards and the button's own presence, so the
   * dialog cannot promise a reach the act does not have.
   *
   * ── AND IT NAMES WHAT SURVIVES ────────────────────────────────────────────
   *
   * `confirmRemoval`'s rule: a person should be frightened of the right thing
   * and no more. What survives here is everything the neighbouring Reset would
   * destroy — the book's own lines, and every original — so the detail says so
   * rather than leaving two adjacent destructive acts to be told apart by their
   * labels.
   */
  protected async confirmFollowAll(): Promise<void> {
    const splitting = this.captures.pass() === 'split';
    const mine = this.captures.prepare().complete;
    // Unreachable while the button is drawn only where there is somebody to
    // hand back, and cheap insurance against a dialog that promises nothing.
    if (mine === 0) return;
    const many = mine !== 1;
    const who = many ? `${mine} photographs` : 'One photograph';
    const their = many ? 'their' : 'its';
    const agreed = await this.confirm.ask({
      message: 'Give every page you set yourself back to the book?',
      detail: splitting
        ? [
            `${who} you set yourself will take the book's cut again — the line ${their} side of `
            + 'the book is set to.',
            'The cuts you placed go, and the marks go with them: every global from here reaches '
            + 'those pages. Crops stay, because this pass does not move a corner.',
            'The book\'s own lines do not change and nothing goes back to the original — Reset '
            + 'every split is the act that does that.',
            'A page whose side of the book has no cut to give it, or whose frame is a different '
            + 'shape, keeps the lines it has and gives up its mark all the same.',
          ]
        : [
            `${who} you set yourself will take the book's lines again — the crop and cut ${their} `
            + 'side of the book is set to.',
            'The lines you placed on them go, and the marks go with them: every global from here '
            + 'reaches those pages.',
            'The book\'s own lines do not change and nothing goes back to the original — Reset '
            + 'every crop is the act that does that.',
            'A page whose side of the book has nothing to give it, or whose frame is a different '
            + 'shape, keeps the lines it has and gives up its mark all the same.',
          ],
      confirm: 'Give them all back',
    });
    if (agreed) this.captures.followAllAgain();
  }

  /**
   * The Two-pages tick, both ways.
   *
   * Routed through ONE method rather than two template expressions, because the
   * two directions are one control: a template that wired the cut and forgot the
   * rejoin would give a tick that goes one way and sticks, and nothing about the
   * markup would look wrong.
   */
  protected setTwoPages(photoId: string, on: boolean): void {
    /*
     * READ BEFORE THE ACT, because both branches can mark the photograph: a cut
     * placed down the middle (with no book's cut to take) is a placement, and a
     * rejoin always is. Re-asking afterwards would find the tick off and drop
     * the propagation — and worse, would leave the box unticking itself under a
     * hand that had only said "this one is a spread too".
     */
    const leading = this.global();
    if (on) this.captures.cutHere(photoId);
    else this.captures.clearSplit(photoId);
    if (leading) this.lead(photoId);
  }

  /*
   * FIVE MODAL PRESSES WERE ANSWERED HERE AND ALL FIVE ARE GONE (Wave 51).
   *
   * `turnTheRest` (the bulk turn), `record` and `applyAll` (the book's standing,
   * written and written-then-applied), `sayRight` (the say-so) and `followAgain`
   * (take the book's crop and follow it again), plus the `applaud` that lit each
   * of them for a second and a half.
   *
   * Everything they did survives, reached from the state rather than from a row
   * of buttons: `turnWithTheBook`, `leadTheBook` and `matchTheOthers`, all three
   * driven by the Global tick or by the gesture it governs. The say-so is the
   * tick unticked — it said "this one is mine" and then STEPPED, which is the
   * one thing a person claiming a page is usually not about to do.
   */

  /**
   * Mint, and then let both surfaces that name the current book catch up.
   *
   * THE SHELF MOVES HERE AND NOWHERE ELSE, so this is the one place that has to
   * ask again. The rail's sentence reads the recipe's arrangement against the
   * one the shelf's book was minted from, and the step list marks WHICH ROW is
   * that book -- both of them main's single resolution, and both of them stale
   * the instant a mint lands until somebody asks.
   *
   * Only on success. A cancelled or failed mint moved no shelf, and re-reading
   * after one would be two round trips to learn that nothing changed.
   */
  protected async startMint(): Promise<void> {
    /*
     * THE DISK IS WHAT GETS MINTED, so it has to be current before the press.
     * `mintBegin` reads the recipe from the file rather than taking it over the
     * bridge, and the save is debounced -- so without this, a corner moved or a
     * page turned in the last four hundred milliseconds is missing from the PDF
     * and from the arrangement recorded beside it, which means nothing on the
     * surface would ever say so.
     */
    await this.captures.flush();
    const step = await this.mint.mint(this.tab().path);
    if (step === null) return;
    await this.captures.refreshMintedFrom();
    await this.ledger.refresh(this.tab().path);
  }
}

/**
 * WHETHER TWO QUADS ARE THE SAME RECTANGLE, to within the arithmetic that made
 * them.
 *
 * For the ghost, and for nothing else: a photograph that took the book's crop
 * holds it EXACTLY, because `wearing` relabels corners rather than recomputing
 * them -- but a photograph that took it, was turned, and was turned back has
 * been through `turnedLike` twice and can differ in the last bits of a double.
 * An exact comparison would draw a dashed line under a solid one on a page
 * nobody had touched, which is the noise this test exists to keep off the
 * screen.
 *
 * The tolerance is a hundred-thousandth of the frame -- three orders of
 * magnitude under the pixel it would take to see, and eleven orders above the
 * float noise `slideSplit` measured at 5.6e-17.
 */
function alike(a: CaptureQuad, b: CaptureQuad): boolean {
  return a.every((point, index) => {
    const other = b[index];
    return other !== undefined
      && Math.abs(point[0] - other[0]) < 1e-5
      && Math.abs(point[1] - other[1]) < 1e-5;
  });
}
