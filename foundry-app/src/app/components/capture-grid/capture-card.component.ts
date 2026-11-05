import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { outputSizeFor, turnsOf } from '@owen/foundry-core/shared/capture';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';

import type { FractionQuad } from '@owen/foundry-core/browser/geometry';
import { toPixels } from '@owen/foundry-core/browser/geometry';
import type { Rectifier } from '@owen/foundry-core/browser/rectify';

/**
 * HOW BIG THE CARD'S OWN COPY OF THE REGISTERED PAGE IS, in device pixels.
 *
 * A card is about two hundred CSS pixels wide on this table, so this is a
 * comfortable two-times for a retina window and stops there. It is also the
 * ceiling that keeps the projection affordable at fifty cards: the source is a
 * 640 px thumbnail, so drawing bigger than this would be enlarging a picture
 * that has no more detail in it — cost with nothing on the other side of it.
 */
const CARD_PIXELS = 420;

/**
 * ONE PAGE ON THE LIGHT TABLE.
 *
 * A thumbnail, what it is called, and whether it has been struck. It holds no
 * state and reaches nothing: the grid owns the order and the service owns the
 * recipe, so a card is a picture with two things it can say — "open me" and
 * "strike me".
 *
 * ── IT DRAWS THE CROP, BECAUSE OTHERWISE NOTHING SHOWS ─────────────────────
 *
 * The card used to be the raw thumbnail and nothing else, so a photograph that
 * had been turned and cropped looked identical to one nobody had touched. Owen
 * ran apply-to-all across twenty-five photographs, it worked, and he reported
 * it as "didnt work... there was no indicator" -- which is the correct reading
 * of a grid that shows the same picture before and after.
 *
 * So the quad is drawn over the thumbnail: the outline of the page that will be
 * minted, and a mark on the corner that becomes its TOP-LEFT. The mark is what
 * makes a turn visible at all -- a quarter turn permutes the corner assignment
 * without moving any of them, so the outline alone is identical before and
 * after and only the mark moves.
 *
 * It is an overlay in the thumbnail's own fraction space (viewBox 0 0 1 1),
 * exactly as the editor's handles are, so nothing here measures pixels and the
 * card can be any size.
 *
 * ── A STRUCK CARD STAYS ON THE TABLE ────────────────────────────────────────
 *
 * docs/CAPTURE.md: a struck page "stays visible on the grid the way struck rows
 * stay visible on the workbench, and is excluded from the mint". So striking is
 * drawn rather than subtracted — the card dims and says so, and the person can
 * see the retake they rejected sitting next to the one they kept. A card that
 * vanished would leave a hole in the spread order that nothing explains, and
 * unstriking would be a thing you could only do by remembering it was there.
 *
 * ── AND FROM APPLY ONWARD IT DRAWS THE PAGE, NOT THE PHOTOGRAPH ────────────
 *
 * Wave 25's Apply is a COMMITMENT POINT: no pixels are cut — that happens once,
 * at Finish — but every surface starts drawing the rectified projection, which
 * is what makes *Reopen* free and what makes the split pass legible. A gutter
 * placed once fits the whole book only because the pages are square and
 * registered by then, and a table still showing twenty-five hand-held
 * photographs would be arguing with the pass it is in.
 *
 * SO THE OUTLINE STOPS BEING THE INDICATOR AND BECOMES THE PICTURE. In the crop
 * pass the card is the whole frame with the page drawn over it, because the
 * thing being decided is WHERE the page is. In the split pass the frame is
 * settled and irrelevant, so the card is the page itself — the shot's edges are
 * gone, and both halves of a cut spread are two real pages side by side rather
 * than two copies of one photograph with different outlines on them.
 *
 * ── ONE CONTEXT FOR THE WHOLE TABLE, HANDED IN ─────────────────────────────
 *
 * `rectify.ts` argues it at length and it is the reason the `Rectifier` arrives
 * as an INPUT rather than being built here: browsers cap live WebGL contexts in
 * the low tens and drop the oldest silently, so a rectifier per card would mean
 * fifty contexts for this shoot and blank cards from about the twentieth. The
 * grid owns exactly one and every card borrows it.
 *
 * ── DRAWN ONCE PER RECIPE CHANGE, NOT ONCE PER FRAME ───────────────────────
 *
 * The effect below depends on `quad()`, and a signal input compares by
 * identity: the service rebuilds card objects on every recipe change but hands
 * an untouched photograph's page the SAME quad array, so a corner moved on
 * photograph 7 redraws card 7 and nothing else. The canvas keeps its pixels
 * between runs, which is the whole of the cache — there is no bitmap to
 * invalidate because the bitmap IS the canvas, and the only thing that can make
 * it stale is the value the effect is watching.
 *
 * The texture source is the card's own 640 px thumbnail, already in the page and
 * already decoded — the same trick the editor plays with its <img>. Rectifying
 * the working copy would mean decoding a 12 MP PNG per card to fill a box two
 * hundred pixels wide.
 */
@Component({
  selector: 'app-capture-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-card.component.html',
  styleUrl: './capture-card.component.scss',
})
export class CaptureCardComponent {
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb = input.required<string>();
  /** What this page is called on the table — its number, and the photo behind it. */
  readonly label = input.required<string>();
  /** Struck pages stay on the table and stay out of the mint. */
  readonly struck = input.required<boolean>();
  /**
   * Whether this card is in the marquee's selection.
   *
   * DRAWN, NOT INFERRED FROM FOCUS. A selection of nine cards has one focused
   * element and nine chosen ones, and the person needs to see all nine before
   * they press Delete on the lot.
   */
  readonly chosen = input<boolean>(false);

  /**
   * THE BOOK HAS STOPPED MOVING THIS PHOTOGRAPH — one state, one dot.
   *
   * `isComplete` in the service is the one test behind it, and the same test
   * every global act makes before skipping a photograph, so the dot cannot
   * promise a skip that does not happen. It is true of a page somebody placed a
   * corner on with *Global* unticked AND of a page somebody unticked the box on
   * without moving anything: a placement and a claim are one population, which
   * is Wave 25's whole point and Wave 51's one control.
   *
   * It is not a freeze. Generating the book cuts every photograph's pixels,
   * complete or not; *Follow the book again* (right-click, on the grid) puts one
   * back in the flow and hands it the book's lines.
   */
  readonly complete = input<boolean>(false);

  /** The page this card will mint, in the thumbnail's own fraction space. */
  readonly quad = input.required<CaptureQuad>();
  /** The photograph's own pixels — see CaptureCard, which explains why. */
  readonly width = input.required<number>();
  readonly height = input.required<number>();

  /**
   * DRAW THE REGISTERED PAGE RATHER THAN THE PHOTOGRAPH — true from Apply on.
   *
   * The grid's, not this card's, because it is a fact about the BOOK's pass and
   * every card on the table flips together. See the class docblock.
   */
  readonly projected = input<boolean>(false);

  /**
   * The table's one WebGL context, borrowed for the length of a draw.
   *
   * Null when the grid has no pass to project or the window has no WebGL at
   * all, and a null here is simply the raw thumbnail — a card that cannot draw
   * the page draws the photograph, which is the state the crop pass is in
   * anyway and is never a blank rectangle.
   */
  readonly rectifier = input<Rectifier | null>(null);

  private readonly source = viewChild<ElementRef<HTMLImageElement>>('source');
  private readonly face = viewChild<ElementRef<HTMLCanvasElement>>('face');

  /**
   * A LOAD IS AN EVENT AND AN EFFECT CANNOT DEPEND ON ONE, so it is counted.
   *
   * The editor paid for this lesson in full (`capture-page-editor`, `draw`): an
   * <img> reports `complete === false` the instant its src is assigned and
   * `naturalWidth === 0` for a task after that, and the only signal that the
   * picture has actually arrived is the load event itself. A counter rather
   * than a boolean because a card whose src is replaced would otherwise have
   * nothing left to change.
   */
  protected readonly arrived = signal(0);
  /** Whether the face has pixels in it yet — the fade, and nothing else. */
  protected readonly drawn = signal(false);

  /** Whether this card is drawing the page. Both halves have to be true. */
  protected readonly projecting = computed<boolean>(
    () => this.projected() && this.rectifier() !== null,
  );

  /**
   * THE PAGE'S OWN PROPORTIONS, from the function the mint measures with.
   *
   * `outputSizeFor` is what decides how many pixels a rectified page gets, so
   * asking it here means the card's box and the minted page are the same
   * rectangle at two sizes. Measuring the quad's own spans instead would be a
   * second body of the same arithmetic, which is the shape this feature has
   * already paid for three times.
   */
  protected readonly page = computed(() =>
    outputSizeFor(toPixels(this.quad() as FractionQuad, {
      width: this.width(),
      height: this.height(),
    })));

  /**
   * The slot's aspect: the PHOTOGRAPH's while the frame is what is being
   * decided, and the PAGE's once it is settled.
   */
  protected readonly box = computed<string>(() =>
    (this.projecting() ? `${this.page().width / this.page().height}` : this.turned().box));

  constructor() {
    effect(() => {
      // Read first, unconditionally: an effect that returns early past a signal
      // never depends on it, and this one has to re-run when the picture lands.
      const projecting = this.projecting();
      const rectifier = this.rectifier();
      const quad = this.quad();
      const image = this.source()?.nativeElement;
      const target = this.face()?.nativeElement;
      this.arrived();

      if (!projecting) {
        // Back in the crop pass: the canvas is gone with the @if, so the fade
        // has to be rearmed or the next projection would appear without one.
        this.drawn.set(false);
        return;
      }
      if (rectifier === null || image === undefined || target === undefined) return;
      // BOTH checks, and the editor's docblock says why: `complete` is the one
      // that refuses a STALE picture, `naturalWidth` the one that refuses a
      // broken one.
      if (!image.complete || image.naturalWidth === 0) return;

      /*
       * THE OUTPUT IS A CARD, NOT A PAGE. The mint asks for every pixel the
       * quad can justify; this asks for as many as a card two hundred wide can
       * show, off a source that is a 640 px thumbnail to begin with. Same
       * shader, same corners, same picture — a smaller rectangle.
       */
      const { width, height } = this.page();
      const scale = Math.min(1, CARD_PIXELS / Math.max(width, height));
      const outWidth = Math.max(1, Math.round(width * scale));
      const outHeight = Math.max(1, Math.round(height * scale));

      try {
        const drawn = rectifier.rectify(
          image,
          // In the THUMBNAIL's pixels: the quad is fractions of the frame, and
          // the frame in hand here is the 640 px copy rather than the working
          // one. Handing it the working copy's dimensions would sample twenty
          // times off the edge of the picture and clamp to a smear.
          toPixels(quad as FractionQuad, {
            width: image.naturalWidth,
            height: image.naturalHeight,
          }),
          outWidth,
          outHeight,
        );
        target.width = outWidth;
        target.height = outHeight;
        // Copied out at once: the rectifier owns ONE canvas and the next card
        // on the table overwrites it before this frame is over.
        target.getContext('2d')?.drawImage(drawn.canvas, 0, 0);
        this.drawn.set(true);
      } catch {
        /*
         * Four corners that do not enclose a page — `homography` throws rather
         * than drawing a degenerate smear, and it is right to. The card keeps
         * whatever it last had and stays quiet: a light table is not the
         * surface to report a geometry fault on, and the editor draws the same
         * corners large enough to see what is wrong with them.
         */
      }
    });
  }

  /**
   * HOW TO DRAW THIS CARD SO IT SITS THE WAY THE PAGE WILL PRINT.
   *
   * `turnsOf` is the shared body the stamp and the bulk turn both read, so the
   * table cannot disagree with the mint about which way round a page is.
   *
   * The slot takes the PRINTED aspect -- swapped on a quarter or three-quarter
   * turn -- and the element inside is laid out at the photograph's own aspect,
   * so that rotating it lands exactly on the slot. Percentages rather than
   * pixels: the grid sizes its columns and this has to follow whatever it
   * decides.
   */
  protected readonly turned = computed(() => {
    const turns = turnsOf(this.quad());
    const sideways = turns % 2 === 1;
    const box = sideways ? this.height() / this.width() : this.width() / this.height();
    return {
      box: `${box}`,
      width: sideways ? `${100 / box}%` : '100%',
      height: sideways ? `${100 * box}%` : '100%',
      spin: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
    };
  });

  protected readonly outline = computed(() =>
    this.quad().map(([x, y]) => `${x},${y}`).join(' '),
  );
  /** The quad's FIRST corner — the minted page's top-left. See the docblock. */
  protected readonly corner = computed(() => this.quad()[0]);

  /**
   * A CLICK NOW CHOOSES, AND A DOUBLE-CLICK OPENS.
   *
   * Wave 21: "single click SELECTS (marquee, reorder, delete); DOUBLE-CLICK or
   * Enter with one selected OPENS THE EDITOR". A single click used to open, so
   * on a shoot of fifty-two cards the only way to select one was to sweep a
   * band across it and stop -- selecting one card meant drawing a rectangle.
   *
   * The event goes with it because the MODIFIERS are the grid's business:
   * plain click replaces the selection, ctrl or meta toggles one card, shift
   * takes the run. The card knows it was clicked; it does not know what else is
   * chosen, and it should not have to.
   */
  readonly choose = output<MouseEvent>();
  readonly open = output<void>();
  readonly strike = output<void>();

  /**
   * Enter opens THIS card, rather than falling through to the grid.
   *
   * The default action of Enter on a button is a synthetic click, which under
   * the new rule means CHOOSE -- so without preventDefault the key that is
   * supposed to open would select instead. And the grid also listens for Enter
   * on the window, for the case where the sweep left focus on the table rather
   * than on a card; stopping propagation is what keeps those two from both
   * answering the same keystroke with two different ideas of which card is
   * meant, which is the focused-versus-chosen mismatch in miniature.
   */
  protected activate(event: KeyboardEvent): void {
    // (keydown) and not (keydown.enter): the pseudo-event hands the template an
    // Event rather than a KeyboardEvent, so the key has to be read here anyway.
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    this.open.emit();
  }
}
