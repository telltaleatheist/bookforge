import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { turnsOf } from '@shared/capture';
import type { CaptureQuad } from '@shared/types';

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
      <span class="shot" [style.aspect-ratio]="turned().box">
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
      </span>
      <!--
        THE MARK, AND WHY IT IS A WORD RATHER THAN A DOT.

        "By hand" is the rail's exact phrase for the same photographs -- "25 of
        27 cropped · 2 by hand" -- so the table and the rail count the same thing
        in the same words, and a person who reads the rail's number has somewhere
        to go and look for it. A pip would have needed a legend, and a legend for
        one mark is a legend nobody reads.

        Inside the label line rather than over the picture: the photographs are
        the only bright thing on this table, and a badge sitting on one would be
        annotating the work by covering it.
      -->
      <span class="label">
        {{ label() }}
        @if (own()) {
          <span class="own" title="You placed this crop, so Crop all leaves it alone">· by hand</span>
        }
      </span>
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
    /* Coloured, because it is the one thing on the label line that is a STATUS
       rather than a name -- and quiet, because it is true of a handful of cards
       on a table of fifty and must not read as an alarm on each of them. */
    .own { color: var(--accent, #4c9aff); }

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
   * Whether somebody placed this photograph's crop themselves.
   *
   * See `CaptureCard.own` for why the table has to show it at all: the promise
   * is that a global never overwrites it, which means the card can sit out every
   * *Crop all* for the life of the project with nothing to say so.
   */
  readonly own = input<boolean>(false);

  /** The page this card will mint, in the thumbnail's own fraction space. */
  readonly quad = input.required<CaptureQuad>();
  /** The photograph's own pixels — see CaptureCard, which explains why. */
  readonly width = input.required<number>();
  readonly height = input.required<number>();

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
