import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { mintedPageIds } from '@shared/capture';
import type { CaptureQuad, CaptureSplit } from '@shared/types';

import { CaptureMintService } from '../../core/capture-mint.service';
import { ConfirmService } from '../../core/confirm.service';
import { type ApplyToAll, CaptureService, type StampCost } from '../../core/capture.service';
import type { Tab } from '../../core/documents.service';
import { CaptureEditorModalComponent } from '../capture-editor/capture-editor-modal.component';
import type { FractionQuad } from '../capture-editor/geometry';
import { CaptureGridComponent } from '../capture-grid/capture-grid.component';
import { CaptureRailComponent } from '../capture-rail/capture-rail.component';
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
          [descending]="captures.descending()"
          [arranged]="captures.arranged()"
          (reorder)="captures.reorder($event)"
          (open)="openPage($event)"
          (strike)="captures.toggleStrike($event)"
          (reverse)="captures.reverse()"
          (dropped)="captures.intake(tab().path, $event)"
        (remove)="void confirmRemoval($event)"
          (turn)="captures.turnPhotos($event.photos, $event.turns)"
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
      [ready]="captures.readyToMint()"
      [minted]="minted()"
      [progress]="mint.progress()"
      [diverged]="captures.diverged()"
      (open)="openTool()"
      (tick)="captures.tick($event)"
      (mint)="void startMint()"
      (stop)="mint.cancel()"
    />

    @if (open() !== null) {
      @if (opened(); as photo) {
        <app-capture-editor-modal
          [label]="photo.label"
          [source]="captures.url(photo.workingCopy)"
          [dimensions]="photo.dimensions"
          [quads]="photo.quads"
          [split]="photo.split"
          [hasPrevious]="walkIndex() > 0"
          [hasNext]="walkIndex() < walk().length - 1"
          [name]="photo.name"
          [cost]="cost()"
          [canMatch]="canMatch()"
          [bookCut]="bookCut()"
          [outOfTurn]="outOfTurn()"
          [handSetHere]="photo.handSet"
          [justApplied]="justApplied()"
          (turnBy)="captures.turnPhotos([photo.id], $event)"
          (clearCrop)="captures.clearCrop(photo.id)"
          (twoPagesChange)="setTwoPages(photo.id, $event)"
          (quadsChange)="setQuads(photo.id, $event)"
          (splitChange)="captures.setSplit(photo.id, $event)"
          (applyToAll)="void applyToAll(photo.id, $event)"
          (matchTheOthers)="captures.matchTheOthers(photo.id)"
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

  /** Which apply-to-all just landed, for the button that was pressed. */
  protected readonly justApplied = signal<ApplyToAll['kind'] | null>(null);
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
      handSet: photo.pages.some((page) => page.byHand === true),
    };
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
   * A `handSet` COUNT STOOD HERE and asked the wrong question.
   *
   * It counted every hand-set photograph in the project, and the override
   * dialog was gated on it -- so the dialog appeared whenever ANYTHING was
   * hand-set, including the source itself and photographs of other shapes that
   * a stamp skips for a reason this dialog cannot change. What the surface
   * actually needs is the population a given press would spare, which is
   * `StampCost.byHand` and comes from the same walk the stamp makes.
   */

  /** The ticks, or an empty answer while nothing is loaded. */
  protected readonly prepared = computed(() => this.captures.recipe()?.prepared ?? {});

  /**
   * WHETHER THIS PROJECT HAS A BOOK YET, which changes one word on the mint
   * button and nothing else.
   *
   * Asked of the CATALOGUE rather than of the recipe, because the recipe cannot
   * know: a mint writes pages and a ledger step and leaves the recipe
   * byte-identical, which is the property that lets a person keep editing after
   * one.
   *
   * IT USED TO ASK `documents.length > 0` AND THAT ANSWER IS NOW ALWAYS FALSE.
   * A mint files no document row -- a folder of page images is not a file type
   * anything can open, so it is not in the catalogue's document list at all
   * (`documentArchive`, electron/projects.ts). Left as it was, the button would
   * have said "Finish the pages" forever, including to somebody looking at a
   * book they had already made: a feature un-shipping itself with nothing on
   * screen to say so.
   *
   * `pages` IS THE SAME QUESTION ASKED OF THE FIELD THAT MOVED. It is set and
   * cleared in the same manifest write as the mint step and its discard, so it
   * cannot disagree with the history the light table is showing.
   *
   * NOT the same question as the divergence sentence, which asks whether the
   * book on the shelf was made from THIS arrangement -- that one is main's
   * single resolution and lands with it.
   */
  protected readonly minted = computed<boolean>(() => {
    const project = this.projects.projectFor(this.tab().path);
    return project !== null && project.pages;
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

  /**
   * WHAT *CROP ALL* WOULD COST from the photograph that is open — the three
   * populations the consequence line names. Asked of the service, which owns
   * every rule about what a gesture reaches.
   */
  protected readonly cost = computed<StampCost>(() => {
    const id = this.open();
    return id === null ? { takes: 0, byHand: 0, shape: 0 } : this.captures.stampCost(id);
  });

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
   * Run an apply-to-all and let the button say so for a moment.
   *
   * ── Tied to the ACT, not to the click ───────────────────────────────────────
   *
   * Owen: "If it did run then there should be an indication. Maybe have the
   * button change colors and say applied or something." His eyes are on the
   * button he pressed, three hundred pixels from the notice bar.
   *
   * It acknowledges only when something was actually applied. An apply where
   * every candidate was skipped -- a crop from the odd landscape frame, say --
   * lights nothing, because a button flashing "Applied" over a bar explaining
   * that nothing was is a surface arguing with itself. The sentence still
   * carries the count and the reasons; the button carries only the fact.
   */
  /**
   * APPLY TO ALL MEANS ALL -- and asks first, once, at the only moment it is a
   * real question.
   *
   * Owen: "apply to the ones i did by hand, give me a modal that asks if i want
   * to override hand-picked settings or something." The checkbox this replaces
   * asked EVERY time about a situation that usually does not exist, which is
   * how a control teaches people to stop reading it.
   *
   * NO HAND-SET PAGES, NO QUESTION. The question only exists when its subject
   * does, and a turn never raises it -- a bulk turn overwrites nobody's crop.
   *
   * THREE ANSWERS AND NOT TWO. Override, leave those alone, or dismiss and
   * nothing happens at all -- Owen's ruling on the close, and the ordinary rule
   * that closing a question cancels it. The dismissal key is deliberately NOT
   * one of the choices, so no button on the card can produce it.
   */
  protected async applyToAll(photoId: string, gesture: ApplyToAll): Promise<void> {
    let asked = gesture;
    /*
     * ASKED OF THE PHOTOGRAPHS THIS PRESS WOULD ACTUALLY SPARE, which is the
     * same population the consequence line under the button has just named.
     * It used to be asked whenever ANY photograph in the project was hand-set,
     * source and other shapes included -- see `handSetNames`.
     */
    if (gesture.kind === 'stamp' && this.cost().byHand > 0) {
      const names = this.captures.handSetNames(photoId);
      const many = names.length !== 1;
      const reach = this.cost().takes + this.cost().byHand;
      const answer = await this.confirm.put({
        title: many
          ? `Override the ${names.length} pages you set yourself?`
          : 'Override the page you set yourself?',
        message: '',
        detail: [
          many ? `You placed these ${names.length} by hand: ${names.join(' · ')}`
            : `You placed ${names[0]} by hand.`,
          `Applying to all ${reach} photographs gives ${many ? 'them' : 'it'} these `
            + 'corners instead of the ones you placed. The way each page sits is left alone '
            + '— turning is never overwritten.',
        ],
        choices: [
          { key: 'spare', label: many ? `Leave those ${names.length} alone` : 'Leave it alone' },
          { key: 'override', label: `Override all ${reach}` },
        ],
        preferred: 'spare',
        dismissed: 'cancel',
        checkbox: null,
      });
      if (answer.key === 'cancel') return;
      asked = { kind: 'stamp', includeHandSet: answer.key === 'override' };
    }
    const outcome = this.captures.applyToAll(photoId, asked);
    if (outcome.applied === 0) return;
    if (this.applauseTimer !== null) clearTimeout(this.applauseTimer);
    this.justApplied.set(asked.kind);
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
