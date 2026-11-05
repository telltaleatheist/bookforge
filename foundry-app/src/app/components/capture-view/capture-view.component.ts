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

import { joinedQuad, mintedPageIds, turnedLike } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { ConfirmService } from '../../core/confirm.service';
import { CaptureService, isComplete } from '../../core/capture.service';
import { NoticeService } from '../../core/notice.service';
import type { Tab } from '../../core/documents.service';
import {
  CaptureEditorModalComponent,
  type EditorFrame,
} from '../capture-editor/capture-editor-modal.component';
import type { FractionQuad } from '@owen/foundry-core/browser/geometry';
import { CaptureGridComponent } from '../capture-grid/capture-grid.component';
import { CaptureRailComponent, type Population } from '../capture-rail/capture-rail.component';
import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { alike } from './capture-view.alike';
import * as tools from './capture-view.tools';

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
  templateUrl: './capture-view.component.html',
  styleUrl: './capture-view.component.scss',
})
export class CaptureViewComponent {
  protected readonly captures = inject(CaptureService);
  readonly notices = inject(NoticeService);
  protected readonly mint = inject(CaptureMintService);
  readonly confirm = inject(ConfirmService);
  private readonly projects = inject(ProjectsService);
  readonly ledger = inject(LedgerService);

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
    if (photo === undefined) return null;
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
    return { follow: pagesOf(members.takes), complete: pagesOf(members.complete) };
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

  protected confirmRemoval(photoIds: readonly string[]): Promise<void> { return tools.confirmRemoval.call(this, photoIds); }

  protected openTool(): void { return tools.openTool.call(this); }

  protected openPage(pageId: string): void { return tools.openPage.call(this, pageId); }

  protected setQuads(photoId: string, quads: readonly FractionQuad[]): void { return tools.setQuads.call(this, photoId, quads); }

  protected settle(photoId: string): void { return tools.settle.call(this, photoId); }

  lead(photoId: string): void { return tools.lead.call(this, photoId); }

  protected turnThis(photoId: string, turns: number): void { return tools.turnThis.call(this, photoId, turns); }

  protected clearCropHere(photoId: string): void { return tools.clearCropHere.call(this, photoId); }

  protected confirmReset(): Promise<void> { return tools.confirmReset.call(this); }

  protected confirmFollowAll(): Promise<void> { return tools.confirmFollowAll.call(this); }

  protected setTwoPages(photoId: string, on: boolean): void { return tools.setTwoPages.call(this, photoId, on); }

  protected startMint(): Promise<void> { return tools.startMint.call(this); }
}
