import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { joinedQuad, mintedPageIds, sameShape, turnedLike } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { ConfirmService } from '../../core/confirm.service';
import {
  type ApplyToAll,
  CaptureService,
  isComplete,
} from '../../core/capture.service';
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
/** How long the button says so. Long enough to read, short enough not to nag. */
const ACKNOWLEDGED_FOR_MS = 1600;

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
          (release)="releaseThese($event)"
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
          [complete]="photo.complete"
          [canMatch]="canMatch()"
          [bookCut]="bookCut()"
          [outOfTurn]="outOfTurn()"
          [photographs]="captures.prepare().photos"
          [marked]="captures.prepare().complete"
          [frames]="frames()"
          [here]="open()"
          [justApplied]="justApplied()"
          (turnBy)="captures.turnPhotos([photo.id], $event)"
          (clearCrop)="captures.clearCrop(photo.id)"
          (twoPagesChange)="setTwoPages(photo.id, $event)"
          (quadsChange)="setQuads(photo.id, $event)"
          (splitChange)="captures.setSplit(photo.id, $event)"
          (applyToAll)="turnTheRest(photo.id, $event)"
          (recordStanding)="record(photo.id, $event)"
          (applyStanding)="applyAll(photo.id, $event)"
          (rightNext)="sayRight(photo.id)"
          (release)="releaseThese([photo.id])"
          (followAgain)="followAgain(photo.id)"
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

  /**
   * WHICH PRESS IN THE MODAL JUST LANDED, for the button that was pressed.
   *
   * It is the parent's rather than the modal's because the state outlives the
   * click by a second and a half, and a component that walks from photograph to
   * photograph should not be holding a timer about the last one. Three acts can
   * light: the bulk turn, the record, and the say-so at the very end of the walk
   * where there is no next photograph to step to.
   */
  protected readonly justApplied = signal<'turn' | 'record' | 'stamp' | 'right' | null>(null);
  private applauseTimer: ReturnType<typeof setTimeout> | null = null;

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
    inject(DestroyRef).onDestroy(() => {
      if (this.applauseTimer !== null) clearTimeout(this.applauseTimer);
    });
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
    const crop = recipe?.book?.crop;
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
   * How many photographs the bulk-turn button would move, for the photograph
   * open right now. Asked of the service, which owns every rule about what a
   * gesture reaches.
   */
  protected readonly outOfTurn = computed<number>(() => {
    const id = this.open();
    return id === null ? 0 : this.captures.outOfTurnWith(id);
  });

  /*
   * A `cost` COMPUTED STOOD HERE and went with the press it costed.
   *
   * It asked `stampCost` what *Crop all* would do from the open photograph, for
   * the three-population sentence under that button. The modal's press is a
   * RECORD now: it reaches the book's standing and no photograph at all, so
   * there is no population to name and nothing for a count to be about. The
   * counting moved with the act -- `applyCost`, on the rail, under the Apply.
   */

  /** Whether this photograph has a book's crop it could be given back to. */
  protected readonly canMatch = computed<boolean>(() => {
    const id = this.open();
    return id !== null && this.captures.hasStanding(id);
  });

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
   */
  protected readonly hasCrop = computed<boolean>(
    () => this.captures.recipe()?.book?.crop !== undefined,
  );
  protected readonly hasCut = computed<boolean>(
    () => this.captures.recipe()?.book?.cut !== undefined,
  );

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
   * LET THE BOOK CHANGE THESE AGAIN — the right-click door's other end.
   *
   * One call per photograph, which is what the service asks for and costs
   * nothing: every writer here goes through the same debounced save, so nine
   * releases are nine edits and one write.
   *
   * NO CONFIRM, deliberately, where removal has one. Release destroys nothing —
   * the page keeps its crop, its cut and its turn, and the only thing that
   * changes is whether the next Apply is allowed to move it. The undo is to
   * place a corner or press *This page is right* again.
   */
  protected releaseThese(photoIds: readonly string[]): void {
    for (const id of photoIds) this.captures.release(id);
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

  protected setQuads(photoId: string, quads: readonly FractionQuad[]): void {
    this.captures.setQuads(photoId, quads as readonly CaptureQuad[]);
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
    if (on) this.captures.cutHere(photoId);
    else this.captures.clearSplit(photoId);
  }

  /**
   * TURN THE REST OF THE BOOK, and let the button say so for a moment.
   *
   * ── Tied to the ACT, not to the click ───────────────────────────────────────
   *
   * Owen: "If it did run then there should be an indication. Maybe have the
   * button change colors and say applied or something." His eyes are on the
   * button he pressed, three hundred pixels from the notice bar.
   *
   * It acknowledges only when something was actually applied. A turn where every
   * candidate was a different shape lights nothing, because a button flashing
   * "Turned" over a bar explaining that nothing was is a surface arguing with
   * itself. The sentence still carries the count and the reasons; the button
   * carries only the fact.
   *
   * ── THE OVERRIDE DIALOG THAT STOOD HERE IS GONE, and so is the stamp ───────
   *
   * This method used to open a three-answer question before the press: override
   * the pages you set yourself, leave them alone, or dismiss. It was the right
   * question asked on the wrong surface -- in the modal, about twenty-four
   * photographs a person cannot see, at the instant they were to be overwritten
   * -- and Wave 25 removed its SUBJECT rather than its wording. Complete
   * photographs are left out of every global; release is the deliberate press
   * that puts one back in the flow, reached from the card it is about or from
   * the modal's *Where it stands*. There is nothing left to ask.
   *
   * What survives is the turn, which never had a subject: it overwrites nobody's
   * corners, so it never raised the question.
   */
  protected turnTheRest(photoId: string, gesture: ApplyToAll): void {
    const outcome = this.captures.applyToAll(photoId, gesture);
    if (outcome.applied === 0) return;
    this.applaud('turn');
  }

  /**
   * THIS PHOTOGRAPH'S CROP OR CUT BECOMES THE BOOK'S — and nothing propagates.
   *
   * Which of the two is the BUTTON'S answer rather than a second reading of the
   * pass here. The modal drew one control with one label and knows which one it
   * drew; asking the service again would be two surfaces deciding independently
   * what a single press meant, which is exactly the shape Wave 24's
   * shape-shifting primary had.
   */
  protected record(photoId: string, which: 'crop' | 'cut'): void {
    if (which === 'cut') this.captures.recordCut(photoId);
    else this.captures.recordCrop(photoId);
    this.applaud('record');
  }

  /**
   * RECORD AND APPLY, ONE PRESS -- Owen's own friction (2026-08-22): the
   * record lived in the modal and the Apply on the rail, and nothing in the
   * modal said so. Two doors underneath, unchanged and in order: the record,
   * then the SAME Apply the rail presses, whose announce says what it touched.
   */
  protected applyAll(photoId: string, which: 'crop' | 'cut'): void {
    if (which === 'cut') {
      this.captures.recordCut(photoId);
      this.captures.applyCuts();
    } else {
      this.captures.recordCrop(photoId);
      this.captures.applyCrops();
    }
    this.applaud('stamp');
  }

  /**
   * *THIS PAGE IS RIGHT — NEXT*: complete this photograph, then step on.
   *
   * ── The acknowledgement is the STEP, except at the end of the walk ────────
   *
   * Ordinarily the picture changes, the strip's lit frame moves and a tick
   * appears on the one just left, which is three signals and needs no fourth --
   * and a button that lit up green would be lighting up on the page a person had
   * moved TO, about a decision they made about the page before it.
   *
   * On the last photograph there is nowhere to step, so the press would have no
   * visible outcome at all beyond a dot appearing in the strip. That is the one
   * case the button says so itself.
   */
  protected sayRight(photoId: string): void {
    this.captures.markComplete(photoId);
    if (this.walkIndex() < this.walk().length - 1) this.step(1);
    else this.applaud('right');
  }

  /**
   * FOLLOW THE BOOK AGAIN — take the book's crop now, and move with it after.
   *
   * ── ONE DOOR, AND THE SECOND HALF IS ALREADY INSIDE IT ────────────────────
   *
   * This looks like it should be *Match the others* followed by a release, and
   * it is not: `wearing` -- the one body that puts a standing on a photograph --
   * deletes the stored `complete` and clears every page's `byHand` as part of
   * the act, on the argument that a page which has just taken the book's crop is
   * a FOLLOWER BY CONSTRUCTION and a stored answer beside that could only
   * contradict it. So the press already leaves the photograph moving with the
   * book, and adding a release here would write an explicit `false` where the
   * derive gives the same answer for free -- "a release nobody pressed", in that
   * function's own words.
   *
   * Which is why the wording could be changed at all. Wave 24 called this *Match
   * the others* because there was no noun on the other side of it; there is one
   * now, and the label can say what a person watches happen.
   */
  protected followAgain(photoId: string): void {
    this.captures.matchTheOthers(photoId);
  }

  /** Light the button that was pressed, for long enough to read. */
  private applaud(what: 'turn' | 'record' | 'stamp' | 'right'): void {
    if (this.applauseTimer !== null) clearTimeout(this.applauseTimer);
    this.justApplied.set(what);
    this.applauseTimer = setTimeout(() => {
      this.justApplied.set(null);
      this.applauseTimer = null;
    }, ACKNOWLEDGED_FOR_MS);
  }

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
