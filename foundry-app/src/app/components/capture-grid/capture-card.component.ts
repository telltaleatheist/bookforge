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

import { outputSizeFor, turnsOf } from '@shared/capture';
import type { CaptureQuad } from '@shared/types';

import type { FractionQuad } from '../capture-editor/geometry';
import { toPixels } from '../capture-editor/geometry';
import type { Rectifier } from '../capture-editor/rectify';

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
  template: `
    <button
      type="button"
      class="page"
      [class.struck]="struck()"
      [class.chosen]="chosen()"
      (click)="choose.emit($event)"
      (dblclick)="open.emit()"
      (keydown)="activate($event)"
    >
      <!--
        \`loading="lazy"\` because a shoot is dozens of these and the grid scrolls:
        the thumbnails below the fold are fetched when they are approached rather
        than all at once on open. They are 640 px JPEGs served through the
        capture door, so each is a small read (docs/CAPTURE.md, thumbnails).
      -->
      <!--
        THE CARD DRAWS THE PHOTOGRAPH THE WAY ROUND IT WILL PRINT.

        Owen turned twenty-five spreads upright, went back to the table, and the
        table looked exactly as it had -- so he reported that the turn had not
        stuck. It had: every one of them is turned in the file. The only sign
        the grid gave was the dot below, four hundredths of a card wide, and
        that dot had been added the LAST time he reported this same class.

        THE PICTURE AND ITS OUTLINE TURN AS ONE ELEMENT, which is not a
        convenience. The crop is drawn in the thumbnail's own fraction space, so
        anything that turns one without the other puts a sideways crop over a
        correctly turned photograph -- worse than no indicator, because it reads
        as a bug in the crop rather than as an absence.
      -->
      <span class="shot" [class.registered]="projecting()" [style.aspect-ratio]="box()">
        @if (projecting()) {
          <!--
            THE REGISTERED PAGE. The <img> is still here and still lazy — it is
            the TEXTURE, so it has to load, and \`loading="lazy"\` is what keeps a
            table of fifty from fetching fifty thumbnails at once. It is
            invisible rather than absent, because \`display: none\` would be a
            picture the browser never decodes and a canvas that never gets
            anything to draw.
          -->
          <img
            #source
            class="source"
            [src]="thumb()"
            [alt]="label()"
            loading="lazy"
            draggable="false"
            (load)="arrived.set(arrived() + 1)"
          />
          <canvas #face class="face" [class.drawn]="drawn()"></canvas>
        } @else {
          <span
            class="spun"
            [style.width]="turned().width"
            [style.height]="turned().height"
            [style.transform]="turned().spin"
          >
            <img [src]="thumb()" [alt]="label()" loading="lazy" draggable="false" />
            <svg class="crop" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              <polygon [attr.points]="outline()" />
              <!--
                The corner that becomes the minted page's top-left. KEPT even now
                that the card turns, because it is what makes the turn checkable:
                after the draw this dot sits at the card's top-left on every card,
                which is what it MEANS. Anywhere else and the two halves have
                disagreed.
              -->
              <circle [attr.cx]="corner()[0]" [attr.cy]="corner()[1]" r="0.04" />
            </svg>
          </span>
        }
        <!--
          THE COMPLETE MARK, AND WHY IT IS NOW A DOT WHERE WAVE 24 ARGUED FOR A
          WORD.

          The word was right while the rail said "2 by hand" and the card had to
          echo the rail's exact phrase to be findable at all — the objection to a
          pip was that a pip needs a legend. Wave 25 supplies the legend and
          makes it a control: the rail's population counts are PRESSABLE, and
          pressing "3 complete" lights exactly these cards on the table. A mark
          you can ask the surface to find for you does not need a caption on
          every card.

          ONE DOT, ONE MEANING, which is the whole reason the mark changed hands
          from \`byHand\` to \`isComplete\`: the book stops moving this photograph.
          Not "you dragged this one" and not "this one is frozen" — every global
          act skips it, Finish never does, and release puts it back in the flow.

          Top-LEFT, because the strike control owns the top-right corner. Over
          the picture rather than in the label line, and that is a reversal too:
          at fifty registered pages the label line is where you read a number,
          and the corner is where the eye sweeps.
        -->
        @if (complete()) {
          <span class="mark" title="Complete — the book leaves this one alone. Right-click to release it.">✓</span>
        }
      </span>
      <span class="label">{{ label() }}</span>
    </button>

    <button
      type="button"
      class="strike"
      [title]="struck() ? 'Put this page back in the book' : 'Leave this page out of the book'"
      (click)="strike.emit()"
    >{{ struck() ? '↺' : '⌦' }}</button>
  `,
  styles: [`
    :host { position: relative; display: block; }

    .page {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 100%;
      padding: 6px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md, 6px);
      background: var(--bg-raised);
      cursor: pointer;
      text-align: left;
    }
    .page:hover { border-color: var(--border-default); background: var(--bg-hover); }
    /*
     * CHOSEN IS A BORDER AND A WASH, not a tint over the picture. The
     * photographs are the only bright thing on this table and a selection that
     * dimmed or coloured them would be selecting by damaging what somebody is
     * trying to look at.
     */
    .page.chosen {
      border-color: var(--accent);
      background: var(--accent-faint);
    }
    .page.chosen:hover { background: var(--accent-soft); }

    /*
     * The picture and its overlay share one box, so the SVG's fraction space
     * is the thumbnail's own.
     *
     * ── width:100% IS THE WHOLE CARD, AND IT IS NOT A TIDY-UP ────────────
     *
     * Owen dropped twenty-seven photographs and got twenty-seven cards that
     * were nothing but their labels. Every upstream explanation was measured
     * and killed: the recipe carried 3024x4032 on all twenty-seven, the door
     * served, the JPEG decoded (naturalWidth 480), and aspect-ratio
     * computed to a VALID ratio rather than NaN. The box collapsed anyway --
     * and it collapsed to ZERO IN BOTH AXES, which is the fact that names the
     * cause. A ratio box that had merely lost its height would still have been
     * as wide as the card.
     *
     * This is a flex item in a column, so its width was coming from stretch
     * and its height from the ratio. But it has NO IN-FLOW CHILDREN -- the .spun span
     * is absolute -- so its content-based main size is zero, and a flex item
     * that resolves a cross size from its own aspect ratio does not then take
     * the stretch. Zero times the ratio is zero, and nothing underneath it
     * disagreed.
     *
     * THE WHOLE MECHANISM IS ONE PAIR OF NUMBERS, measured in the running app
     * with the defect put back underneath the fix:
     *
     *   getComputedStyle(.shot).width    0px  broken     295.333px  fixed
     *   getComputedStyle(.shot).aspectRatio   "1.33333 / 1" IN BOTH
     *
     * The ratio was never wrong. The USED WIDTH was zero, and a ratio times
     * zero is zero in both axes -- which is why every hypothesis that went
     * looking for a bad number found only good ones.
     *
     * So the width is STATED instead of inherited from an alignment. The card
     * is the containing block and the picture is as wide as the card, which is
     * what the design says out loud anyway; the ratio then resolves the height
     * from a width that is definite before it is asked for.
     *
     * WHY NO min-height FLOOR HERE: a floor was drafted for this bug and
     * would have been the wrong repair. A zero-WIDE box with a floor under its
     * height is still a box with no picture in it -- it would have turned a
     * card that is honestly broken into a card that looks deliberately empty.
     * The floor was for a missing NUMBER; this was a missing CONSTRAINT.
     *
     * AND WHY NO TEST GUARDS THIS: three separate harnesses reproduced this
     * component's markup and CSS with these exact numbers and all three drew
     * the card correctly, because each put the grid in normal flow where the
     * width is definite for a different reason. The defect lives in the
     * resolution, not the computation, and only the assembled app has it.
     */
    .shot { position: relative; display: block; width: 100%; overflow: hidden; }
    /*
     * A registered page has a ground of its own, because it is a PAGE now: the
     * shot's edges are gone, so there is nothing left to explain the dark
     * surround a raw photograph brings with it. It is also what the card shows
     * for the moment between the thumbnail arriving and the rectify landing.
     */
    .shot.registered { background: var(--bg-sunken); }
    /* The texture, not the picture -- see the template. */
    .source { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
    /*
     * The face fades in rather than appearing, for one honest reason: it is
     * drawn a frame or two after the thumbnail loads, and a hard swap at that
     * distance reads as a flicker in the card rather than as a picture arriving.
     */
    .face {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      display: block;
      opacity: 0;
      transition: opacity 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    .face.drawn { opacity: 1; }

    /*
     * The complete dot: a tick in a filled disc, in the OK colour the rail's
     * own ticks use, so the mark on the card and the tick in the rail read as
     * one vocabulary. Small and cornered -- it annotates the page without
     * covering any of it, which is the objection the label-line word was
     * answering and which a nine-pixel disc answers too.
     */
    .mark {
      position: absolute;
      top: 5px; left: 5px;
      z-index: 2;
      width: 13px; height: 13px;
      border-radius: 99px;
      background: var(--ok, #4ade80);
      border: 1.5px solid var(--bg-raised);
      display: grid; place-items: center;
      font-size: 8px; line-height: 1;
      color: var(--bg-base);
    }
    .page.struck .mark { opacity: 0.5; }
    /*
     * Sized so that AFTER the rotation it fills the slot: a quarter turn swaps
     * the visual box, so the element is laid out at the photograph's own aspect
     * and the slot is laid out at the printed one. Centred on the slot, because
     * a rotation about a corner would swing the picture out of it.
     */
    .spun {
      position: absolute; top: 50%; left: 50%;
      transform-origin: center;
    }
    /*
     * THE SIZING LIVES HERE AND NOWHERE ELSE, which is a cascade fact and not a
     * preference. the .page img rule below is the same specificity and comes LATER, so
     * a width or a height set there would win over this one -- and its
     * its height:auto did, which would have left the picture at its natural
     * aspect inside a box laid out for the rotated one. The image would not have
     * filled the slot and the crop would not have sat on the photograph.
     *
     * That defect was invisible to twenty assertions about the transform,
     * because a model of CSS has no cascade in it.
     */
    .spun img { width: 100%; height: 100%; }
    .crop {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .crop polygon {
      fill: none;
      stroke: var(--accent, #4c9aff);
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .crop circle { fill: var(--accent, #4c9aff); }
    /* A struck page's crop goes quiet with the rest of the card rather than
       staying bright over a dimmed picture. */
    .page.struck .crop { opacity: 0.35; }

    /* Every card image is inside .spun now, which sizes it -- see the note
       there for why the sizing must not also be written here. */
    .page img {
      display: block;
      background: var(--bg-sunken);
    }

    /*
      Struck is DIMMED AND CROSSED, not hidden — see the class docblock. Opacity
      alone would read as "still loading", so the label carries a line through it
      as well: two signals, because this one is a decision the person made and
      has to be able to see they made.
    */
    .page.struck { opacity: 0.45; }
    .page.struck .label { text-decoration: line-through; }

    .label {
      font-size: 11px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .strike {
      position: absolute;
      top: 10px;
      right: 10px;
      padding: 2px 5px;
      border: none;
      border-radius: var(--radius-sm, 4px);
      background: var(--bg-raised);
      color: var(--text-tertiary);
      cursor: pointer;
      opacity: 0;
      transition: opacity 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    /*
      The strike appears on hover OR focus. Focus matters as much as hover here:
      without it the control is unreachable from the keyboard, which would make
      striking a page a mouse-only act.
    */
    :host:hover .strike, .strike:focus-visible { opacity: 1; }
    .strike:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
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
