import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { PDF_BLOCK_CATEGORIES, pdfCategoryColour, pdfCategoryLabel } from '@shared/categories';
import type { BookLoad, BookRow } from '@shared/book';
import { PageGlanceComponent } from './page-glance.component';
// The reader's words for the three rewrites, and the only copy of them: the
// dialog's cards, the queue's row and this pane's sentences all print the same
// table, so a mode cannot be one thing in the history and another on a tooltip.
import { REWRITE_LABELS } from '@shared/ledger';
// The model's inline dialect, mirrored from the emitter's — see `cut`.
import { INLINE_DROPPED, INLINE_ITALIC, INLINE_STRONG, inlineEmphasis } from '@shared/inline';
import { replayOps, struckNotes, unwritten, type BookOp, type ReplayedRow } from '@shared/ops';

import { api } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { ComparePickerComponent } from '../compare/compare-picker.component';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { type Tab } from '../../core/documents.service';
import { NoticeService } from '../../core/notice.service';
import { editionFlow, editionPieces } from './edition';
import { chapterOrder, flowNeighbours, seamJoins, sharedAnchor } from './flow';
import { readTable, type TableRow } from './table';

/**
 * THE BOOK — a proof sheet on a dark workbench, and the one surface this app
 * will edit.
 *
 * ── What this is, and what it replaces ──────────────────────────────────────
 *
 * *"we arent supposed to be rendering the book as an epub. it's supposed to be
 * rendered as an html page… the user isnt reading a book on foundry, they're
 * editing the contents of a book."* (docs/RENDERER.md §0.) The cast EPUB in an
 * iframe was the flowing document while nothing else flowed; what flows now is
 * the BOOK FILE — one row per block, ids minted, hyphens fused, page turns
 * joined — read over IPC and drawn as Angular DOM. No iframe, no sandbox, no
 * postMessage, no injected script, and no book unzipped anywhere.
 *
 * ── WHAT IS ON SCREEN IS A PURE FUNCTION, AND THAT IS THE WHOLE DESIGN ──────
 *
 * `view()` is `replayOps(rows, [...chain, ...pending])` and nothing else. There
 * is no incremental mutation anywhere in this file: a strike does not reach into
 * a row and set a flag, it PUSHES AN OP and the whole book is folded again. That
 * is affordable because the fold is one pass over an array this component is
 * already holding, and it is worth having at any price, because the alternative —
 * a stack of ops beside a set of rows somebody edited to match — is two accounts
 * of one book, which is the four-places-per-strike failure this wave exists to
 * end (docs/RENDERER.md §1).
 *
 * The CHAIN is what main read off the edit steps on the path from the position
 * (`BookLoad.ops`); PENDING is the LIFO stack of what has been done since. Undo
 * pops, redo re-pushes, Apply writes the stack down as a step and clears it — at
 * which point the pointer moves, the pane reloads, and the very same ops come
 * back on the chain.
 *
 * CLOSING WITHOUT APPLY USED TO SCRAP THE STACK (docs/RENDERER.md §3), and Owen
 * reversed that on 2026-08-22 after a project lost real work to it. Every gesture
 * below now also writes the difference to the project's sidecar on a debounce
 * (`remember`, and `BookStacksService` at the other end), and `load` puts it back
 * at the same step. The closing question stays and stops being a warning: it is
 * the offer to RECORD the work as a step, which matters because everything made
 * from this book is built from the recorded steps.
 *
 * ── THE GESTURES, and which op each of them mints ───────────────────────────
 *
 * Delete over a selection strikes and restores; a double-click puts a caret in a
 * block and a blur commits its words; the margin chip's list relabels. The
 * structure gestures landed with the replay that performs them: the seam's
 * `··· join ···` ghost IS the merge now, Enter at the caret cuts a paragraph in
 * two, Ctrl+J joins two blocks a person picked, and a double-click on a chapter
 * chip renames the division in place. The panels in the shell mint the rest —
 * link, restore-furniture and the four other chapter verbs — onto this same
 * stack, through the registry (`BookStack`, core/book-stacks.service.ts).
 *
 * TWO GESTURES ARE DEFERRED OUT LOUD and their ops exist regardless: dragging a
 * block to repair reading order (`move`) and dragging a chapter rule to another
 * block (`chapter` with `move`). Both are drop targets, autoscroll and a lift —
 * real UI machinery — and both are named where they would hang, below.
 *
 * ── The undo chord is ROUTED here, never listened for ───────────────────────
 *
 * Ctrl+Z is a menu accelerator main swallows, and the renderer decides which of
 * its three undos a chord meant (`MenuAction`, shared/api.ts). `BookStacksService.replay`
 * is where that decision lives; this component registers a `BookStack` with it and
 * adds no key listener of its own, because two answers to one keypress is how a
 * text field and a book both take something back.
 *
 * ── The selection is this component's and nothing else's ────────────────────
 *
 * It is not a fact about the book, it is in no undo stack, nothing on disk
 * records it and a reload starts with nothing selected — the same ruling the
 * frame selection has always had — a set of block ids and the category they
 * share, held by the surface that draws them. It
 * lives here rather than in the service because nothing outside this pane can
 * act on it yet; the day the inspector can, it moves up, and moving it before
 * then would be a wire with nothing on either end.
 *
 * ── Virtualization, and why there is no library in it ───────────────────────
 *
 * A four-hundred-page book is thousands of blocks. `content-visibility: auto`
 * with `contain-intrinsic-size` is the browser skipping the layout and paint of
 * everything off screen, natively, with the real DOM still there for scrolling
 * to, jumping to and hit-testing against — which is the whole of what a virtual
 * scroller buys and none of what it costs (a fixed item height, a scrolling
 * viewport of its own, and a dependency). This is Chromium and the feature is not
 * in question here.
 *
 * IT IS ON A WRAPPER INSIDE EACH BLOCK AND NOT ON THE BLOCK, which looks like a
 * detail and is not: `content-visibility` brings PAINT CONTAINMENT with it, and
 * paint containment clips a box's descendants to its own bounds. Every mark this
 * design puts in a gutter is outside the text column by construction, so a
 * contained block host would clip away every rail, chip, ghost and flag on the
 * page. The host carries the chrome, the wrapper carries the words and the
 * containment, and neither interferes with the other.
 *
 * ── Every mark on the page is RENDERER-DESIGN.md's ──────────────────────────
 *
 * That file is law for the appearance and nothing below invents anything visual:
 * the tokens are copied from its §1, the paper from §2, the block chrome from §3,
 * the structure marks from §4, the two quiet states from §5 and the motion rules
 * from §6. The category inks come from `shared/categories.ts` — the ONE table —
 * and are used only as rails, tints and chips at the alphas that file's own
 * header insists on, so the page never turns into confetti.
 *
 * ── The text is TEXT ────────────────────────────────────────────────────────
 *
 * Every word a block carries reaches the DOM through interpolation. Nothing here
 * touches `innerHTML`, not on the model's output and not on anybody else's: a
 * book is ultimately somebody else's words arriving through a model's answer, and
 * the one thing this app will not do is hand them to a parser that can execute.
 * The reference numbers are the only structure drawn INTO a block's text, and
 * they are drawn from OFFSETS the engine resolved (`BookRef`), never by matching
 * digits — the same digits appear five times on a page of a book with fifty notes
 * in it.
 *
 * ── TWO REGISTERS, ONE TOGGLE ───────────────────────────────────────────────
 *
 * *"Workbench — the working view. Paper + gutters + chrome. Edition — the export
 * preview. The same replay with ALL chrome removed and the export stylesheet
 * applied."* (docs/RENDERER-DESIGN.md §0.) The edition is a PROJECTION of the
 * very list the bench is drawing — one more pure function over `lines()`, no
 * second replay, no IPC and no engine, which is what makes it *"a toggle, not a
 * build"* (docs/RENDERER.md §5). What moves lives in `./edition`; what is merely
 * left out is a selector under the one host class, at the bottom of the styles.
 *
 * IT IS READ-ONLY AND EVERY EDIT GESTURE FLIPS IT BACK — §5's own sentence — and
 * the mode is deliberately NOT REMEMBERED anywhere: `mode` below says why.
 */

/** A reference number inside a block's text — bound to its note, or to nothing. */
interface Marker {
  at: number;
  len: number;
  /** The note row this number belongs to, or null when NOTHING carries it. */
  note: string | null;
  /**
   * True when the note this number belongs to is struck.
   *
   * DERIVED, AND NEVER AN OP OF ITS OWN. *"if i delete footnotes, it removes
   * their corresponding reference numbers."* (docs/RENDERER.md §0, ruling 9.) The
   * number belongs to the note, so striking the note strikes its numbers and
   * restoring it brings them back — computed from the replayed rows (§2), which
   * is one set lookup per marker because the replay already answers which notes
   * are struck (`struckNotes`).
   */
  struck: boolean;
}

/** One run of a block's text: words, or a reference number drawn as an element. */
interface Piece {
  text: string;
  marker: Marker | null;
  /**
   * The model's emphasis over this run — `**bold**` and `*italic*`, decided by
   * `inlineEmphasis` (shared/inline) and drawn as the effect rather than as the
   * characters. See `cut` for the whole argument; the short of it is that the
   * markers stay in the bank because ops index into it by character offset, and
   * a display surface is the only place they may be interpreted.
   */
  strong: boolean;
  italic: boolean;
}

/** One block, with everything the sheet has to know to draw it. */
interface Line {
  row: ReplayedRow;
  /** The words, cut at the reference numbers the engine resolved. */
  pieces: Piece[];
  /** The category ink, from the one table. Rails, tints and chips only. */
  colour: string;
  /** What the margin chip says when this block is selected. */
  label: string;
  /** The category's size as a ratio of the body's — measured, or the base sheet's. */
  size: number;
  /** Which note of its page this is, counted from one, or null for anything else. */
  ordinal: number | null;
  /**
   * The block this one jumps to when it is clicked — for a note, the first place
   * its number was printed. Null for everything else, which is most of the book.
   */
  jump: string | null;
  /** The page ghost for the right gutter, where a new source page begins here. */
  ghost: number | null;
  /** The chapter this block starts, drawn as a rule above it. Null in the edition. */
  chapter: string | null;
  /**
   * The chapter title drawn as a HEADING above this block — the edition's mark
   * where `chapter` is the bench's, and null in every workbench line.
   *
   * They are two fields rather than one read two ways because they are not the
   * same fact: the bench draws a rule and a chip at every division, and the
   * edition draws a heading only where the block below is not already one
   * (`EditionPlace.heading`, ./edition). One field would have to be asked which
   * mode it was about before it could be read.
   */
  heading: string | null;
  /** True where a division opens — the air the cast's new document makes. */
  opens: boolean;
  /**
   * The block this one would be joined onto, when an unjoined page turn falls
   * immediately above it — or null, which is almost every block in the book.
   *
   * IT IS THE OP'S `into` AND NOT A FLAG. The ghost between the two paragraphs
   * is the join (RENDERER-DESIGN.md §4: *"Click = the join op"*), so the thing
   * the ghost needs is the name of the block that keeps its own — the earlier of
   * the two, `BookSeam.after` — and carrying it here is what lets the control be
   * a control rather than a report. `seamJoins` decides which seams still have
   * both of their halves in the flow.
   */
  seamInto: string | null;
  /** Indented like a printed paragraph — not the first of the book, not after a heading. */
  indent: boolean;
  /**
   * The grid, for a `Table` block and for nothing else — §18c.
   *
   * Null on every other category, and null on a Table whose markup this app
   * REFUSED to read, which is the visible failure rather than a blank block:
   * the template prints the model's string as prose and says why, exactly as
   * this block was drawn before it had a case of its own. See ./table for the
   * allowlist and for what happens to what it rejects.
   */
  table: TableRow[] | null;
  /** The hairline above the first note of a page's group of them. */
  opensNotes: boolean;
  /** What is unlinked about this block, for the amber flag in the right gutter. */
  flag: string | null;
}

/**
 * The base sheet's own ratios, for a category this book gave the engine too
 * little to measure.
 *
 * THIS IS A DOCUMENTED RULE AND NOT A FALLBACK, and the difference is worth being
 * exact about. `typography.ts` derives a size for five categories and writes
 * NOTHING for one with fewer than four samples under it, because a median of two
 * boxes is a coin toss between two boxes. What stands in that silence is the
 * static stylesheet every cast book in this app has always been set in
 * (`STYLESHEET_BASE`, src/vlm/dots-book.ts) — so these five numbers are a
 * transcription of the engine's own sheet rather than a guess made here, and a
 * book with nothing measured about it is set exactly as the engine would set it.
 */
const BASE_RATIO: Readonly<Record<string, number>> = {
  Footnote: 0.85,
  Caption: 0.9,
  Quote: 0.95,
  Title: 1.5,
  'Section-header': 1.15,
};

/** How far the pointer travels before a press on a block becomes a marquee. */
const DRAG_SLOP = 4;

/** The tint pulse on a block a marker jumped to — RENDERER-DESIGN.md §4. */
const PULSE_MS = 600;

/**
 * The jump's glide: the time constant of the chase (each frame closes
 * `1 - e^(-dt/τ)` of what remains, so ~95% of the distance is travelled in 3τ —
 * about three-quarters of a second of visible motion), and the bound that snaps
 * whatever is left and ends it, because a chase over a live layout must end even
 * if something keeps nudging the target. See `land`.
 */
const GLIDE_TAU_MS = 220;
const GLIDE_MAX_MS = 1500;

/**
 * The narrowest bench two sheets can breathe in, in rem — the lead's own number.
 *
 * Below it the aligned view is UNAVAILABLE rather than cramped: two columns of
 * book at less than this are two columns of six words a line, which is not a
 * proof sheet, it is a pair of ransom notes. The refusal says the window is too
 * narrow, which is a thing a person can act on in one gesture.
 */
const ALIGNED_MIN_REM = 68;

/**
 * How long a column keeps the wheel when no `scrollend` ever arrives.
 *
 * ── This is a documented rule and not a fallback ────────────────────────────
 *
 * The scroll lock is re-entrant by nature — scrolling A moves B, and B's own
 * scroll event would move A back — so exactly one column is DRIVING at a time and
 * the other's events are ignored while it is. `scrollend` is what hands the wheel
 * back, and it is the honest signal: it fires when a hand, a wheel or a smooth
 * scroll has actually finished. This is the release valve for the one case that
 * signal cannot cover: a column that took the wheel WITHOUT SCROLLING — the sync
 * when the pair opens, which drives the source column from a live column that
 * never moved — emits no `scrollend`, because nothing scrolled. A wheel nobody
 * ever hands back is a pane where the other column can never be scrolled again.
 */
const SCROLL_SETTLE_MS = 400;

/*
 * ── The glance ──────────────────────────────────────────────────────────────
 *
 * GRAVESTONE — `GLANCE_REST_MS`, 180 ms, Wave 23's pointer-rest delay, removed
 * in Wave 30 along with the hover it measured.
 *
 * NOTHING ABOUT THE ARGUMENT WAS WRONG, and it is written down here so nobody
 * re-derives it as new: FOR A HOVER TRIGGER, rest beats enter. A pane of prose
 * is a thing people sweep a pointer across on the way somewhere else, and a
 * card that opened on every crossing would flash a dozen times down one page,
 * each flash costing a PDF page render. The delay was also what made the
 * NO-PAPER sentence bearable — a sentence that appears when somebody stopped
 * and waited to find out, rather than one that strobes past a reader.
 *
 * WHAT WENT IS THE HOVER, NOT THE REASONING. The card now answers a CLICK, and
 * a click cannot be swept through: there is exactly one per gesture, it is
 * already the gesture that selects the block, and there is nothing left for a
 * delay to protect against. So the timer is DELETED rather than set to zero —
 * a zero-length rest is a hover trigger wearing a constant's clothes, and the
 * next reader would have had to prove that before touching it.
 */

/** The least the card may sit from the top of the paper. */
const GLANCE_GAP = 12;
/**
 * The air either side of the card when it stands OUTSIDE the paper — between
 * the sheet's edge and the card, and between the card and the pane's own edge.
 *
 * Both, and the same number for both, because what it buys is the same thing in
 * both places: the card has to read as a separate object sitting in the bench's
 * dead space, and a card flush against the paper reads as part of it while a
 * card flush against the pane reads as clipped.
 */
const GLANCE_MARGIN = 12;

@Component({
  selector: 'app-book-view',
  imports: [NgTemplateOutlet, ComparePickerComponent, PageGlanceComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      THE WORDS OF ONE BLOCK, in one template used by every category, because the
      only thing that differs between a paragraph and a caption is the element
      around them. Each run is an ELEMENT — including the plain ones — so that the
      whitespace between them in this file is whitespace-only and is dropped:
      text nodes interleaved with spans would each pick up the indentation of the
      line they are written on, and the book would come out with a space in front
      of every note number.
    -->
    <!--
      \`plain\` IS THE CONTEXT ASKING FOR THE DEMOTED NUMBER, and it is a parameter
      rather than a reading of \`edition()\` because there are two sheets now that
      want it and only one of them is a mode. The edition demotes a marker because
      the link is a reader's apparatus and a page is not a reader; the SOURCE
      column demotes it because the left sheet is context — no coupling, no jump,
      no amber (RENDERER-DESIGN.md §5: chrome only on the live column). One
      template, asked which it is, instead of two that must be kept saying the
      same thing about a superscript.
    -->
    <!--
      \`bold\` AND \`italic\` ARE THE MODEL'S OWN EMPHASIS, DRAWN AS THE EFFECT —
      §18b. The vision model writes \`**bold**\` and \`*italic*\` into a block's
      text and the emitter has always turned those into \`<strong>\` and \`<em>\`;
      this sheet drew the asterisks. It now draws what they mean.

      THE MARKERS ARE STILL IN THE FILE and always will be: the ops index into
      block text by character offset, so removing four characters upstream would
      move every offset after them and misplace an already-curated project's
      strikes. The cut is made in \`cut()\`, which is where that argument is
      written out; here there is only a class.

      A CLASS AND NOT A \`<strong>\`/\`<em>\` ELEMENT, deliberately: every run in
      this template is already an element for the whitespace reason above, and
      wrapping some of them in a second one would be three more branches to keep
      saying the same thing — on a workbench whose whole job is to show a person
      what the export will look like, where the effect IS the information.
    -->
    <ng-template #words let-line let-plain="plain">
      @for (piece of line.pieces; track $index) {
        @if (piece.marker; as marker) {
          @if (plain) {
            <!--
              THE REF, DEMOTED — *"struck elements absent, refs demoted"*
              (docs/RENDERER.md §5). In the cast a matched marker is
              \`<a class="noteref" epub:type="noteref" href="#fnN"><sup>n</sup></a>\`
              and an unmatched one falls through to the inline pass's own plain
              \`<sup>n</sup>\`; the edition draws that plain superscript for every
              number it has. NO JUMP, NO COUPLING, NO AMBER: the link is the
              apparatus of a reader, and this is the page, not a reader.
            -->
            <sup
              class="ref"
              [class.bold]="piece.strong"
              [class.italic]="piece.italic"
            >{{ piece.text }}</sup>
          } @else {
            <span
              class="marker"
              [attr.data-note]="marker.note"
              [class.unlinked]="marker.note === null"
              [class.struck]="marker.struck"
              [class.lit]="marker.note !== null && lit() === marker.note"
              [class.bold]="piece.strong"
              [class.italic]="piece.italic"
              (pointerenter)="light(marker.note)"
              (pointerleave)="light(null)"
            >{{ piece.text }}</span>
          }
        } @else {
          <span
            class="run"
            [class.bold]="piece.strong"
            [class.italic]="piece.italic"
          >{{ piece.text }}</span>
        }
      }
    </ng-template>

    <!--
      THE WORDS AS THE BOOK SETS THEM — one block's prose, in the element its
      category asks for.

      IT IS A TEMPLATE BECAUSE THERE ARE TWO SHEETS NOW. The live column draws it
      under the whole of §3's chrome and the SOURCE column draws it under none, and
      the one thing that must not differ between them is the typography: a caption
      set in italics on the right and roman on the left would be two books rather
      than one book twice, and the scroll lock would be locking rows of different
      heights together. So the element, the measured size and the marker cuts are
      decided once, here, and what the two columns disagree about is only what is
      drawn AROUND this.
    -->
    <ng-template #prose let-line let-plain="plain">
      @switch (line.row.category) {
        @case ('Title') {
          <h1 [style.font-size.em]="line.size">
            <ng-container
              *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
            ></ng-container>
          </h1>
        }
        @case ('Section-header') {
          <h2 [style.font-size.em]="line.size">
            <ng-container
              *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
            ></ng-container>
          </h2>
        }
        @case ('Quote') {
          <blockquote>
            <p [style.font-size.em]="line.size">
              <ng-container
                *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
              ></ng-container>
            </p>
          </blockquote>
        }
        @case ('Caption') {
          <p class="caption" [style.font-size.em]="line.size">
            <ng-container
              *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
            ></ng-container>
          </p>
        }
        @case ('Footnote') {
          <p class="note" [style.font-size.em]="line.size">
            <ng-container
              *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
            ></ng-container>
          </p>
        }
        @case ('Picture') {
          <!--
            THE PLATE IS THE ENGINE'S OWN CROP, cut once beside the bank when the
            book was made (docs/BOOK-FILE.md §6) and served through the
            allow-listed book host — the row names it, main resolves it, and this
            pane composes a URL and nothing else. The empty frame remains the
            honest state of a book none were cut for (no PDF at reflow): it
            reserves the space a plate takes and names the page it came from, so a
            book with plates reads as a book with plates rather than as a
            paragraph gone missing. The alt is empty because the caption below IS
            the description, and a reader hearing it twice was told nothing the
            second time.
          -->
          <figure>
            @if (plate(line.row); as src) {
              <img class="plate-img" [src]="src" alt="" draggable="false">
            } @else if (!edition()) {
              <!--
                AND THE EMPTY FRAME IS THE BENCH'S. It is a dashed rule and a page
                number — an instrument mark saying "a plate belongs here and this
                book was reflowed without the PDF to cut it from". The edition is
                the finished book, the finished book has the plate, and drawing a
                dashed box in its place would put a mark on the page that the
                export will never write. What is left is the gap the missing plate
                actually is.

                THE SOURCE COLUMN KEEPS IT, which looks like an exception to
                "chrome only on the live column" and is not: this frame is the
                SPACE the picture occupies, and a context column that closed the
                gap would stand a row taller than its twin all the way down the
                page — which the scroll lock would then have to argue with.
              -->
              <div class="plate"><span class="plate-page">≈ {{ line.row.page }}</span></div>
            }
            @if (line.row.text.trim().length > 0) {
              <figcaption [style.font-size.em]="line.size">
                <ng-container
                  *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
                ></ng-container>
              </figcaption>
            }
          </figure>
        }
        @case ('Table') {
          <!--
            §18c — THE GRID, DRAWN. A Table block's text is the model's own HTML
            and the export has always written a real table out of it
            (\`checkTableHtml\`, src/vlm/dots.ts); the bench set it as a paragraph
            and a person proofing their book saw angle brackets. It now draws.

            NOT ONE CHARACTER OF THE MODEL'S STRING BECOMES MARKUP. \`readTable\`
            (./table) reads the fragment into rows, cells and two clamped
            integers, and every one of those crosses into this template as an
            interpolation Angular escapes. There is no \`innerHTML\` here and
            there must never be one: the string arrived from a language model
            over a socket, and that we asked for it is not a provenance.

            THIS IS NOT THE GRID EDITOR, which stays deferred out loud. Nothing
            below is clickable and nothing below writes an op — the block goes on
            being selected, struck and curated by the chrome around it, because
            all of that is about the BLOCK and this is only what is inside it.
          -->
          @if (line.table; as grid) {
            <!--
              The wrapper scrolls, and it is the whole reason there is one: a
              nine-column table in a book set to a reading measure is wider than
              the paper, and a page that scrolls sideways as a whole would take
              the margins, the gutters and every mark in them along with it.
            -->
            <div class="tablewrap">
              <table [style.font-size.em]="line.size">
                @for (row of grid; track $index) {
                  <tr [class.head]="row.head">
                    @for (cell of row.cells; track $index) {
                      @if (cell.header) {
                        <th
                          [attr.colspan]="cell.colspan"
                          [attr.rowspan]="cell.rowspan"
                        >{{ cell.text }}</th>
                      } @else {
                        <td
                          [attr.colspan]="cell.colspan"
                          [attr.rowspan]="cell.rowspan"
                        >{{ cell.text }}</td>
                      }
                    }
                  </tr>
                }
              </table>
            </div>
          } @else {
            <!--
              THE REFUSAL, AND IT IS VISIBLE. A fragment with no rows this app
              will read is printed as what it is — the model's own string, set as
              prose, exactly as this block was drawn before it had a case. A
              sanitiser whose rejection is a blank space would take a paragraph
              of somebody's book off the page with nothing said about it.

              The sentence beside it is BENCH CHROME and not part of the book, so
              it is absent from the edition for the same reason the page ghosts
              and the amber flags are: the edition is what the export will be,
              and the export writes the model's fragment whatever this app made
              of it.
            -->
            @if (!plain) {
              <p class="table-refused">
                This block is a table, and its markup could not be read as one. The words
                are printed below as they arrived.
              </p>
            }
            <p class="para set-off" [style.font-size.em]="line.size">
              <ng-container
                *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
              ></ng-container>
            </p>
          }
        }
        @default {
          <!--
            Text, and — with a class and nothing else — a formula and a list
            item. Their own shapes are later waves; rendering what the model
            read, plainly, is not a placeholder for that, it is what the words
            are. TABLE HAS ITS OWN CASE NOW (§18c, above) and is no longer one
            of the categories this paragraph stands in for.
          -->
          <p
            class="para"
            [class.indent]="line.indent"
            [class.set-off]="line.row.category !== 'Text'"
            [style.font-size.em]="line.size"
          >
            <ng-container
              *ngTemplateOutlet="words; context: { $implicit: line, plain: plain }"
            ></ng-container>
          </p>
        }
      }
    </ng-template>

    <!--
      ── §5 THE ALIGNED TRANSLATION VIEW — two columns, one book, twice ────────

      *"Two scroll-locked columns over two book files with the same ids."*
      (docs/RENDERER.md §5.) The SOURCE is on the left and the TRANSLATION on the
      right, which is the order the work went in and the order a proof is read in.
      The right-hand column IS the pane — every gesture, every mark, the stack, the
      trays — untouched; the left is READ-ONLY CONTEXT and carries no chrome at
      all, because there is nothing on that sheet a person can decide (source edits
      stand ABOVE the translation, where changing the words changes the question
      the records answered).

      THE PAIR IS ALWAYS THIS ELEMENT, with one child or two. A wrapper that only
      existed while two columns did would mean the bench's own box changed shape
      when the toggle was pressed, and everything measured against it — the sticky
      trays, the marquee's coordinates — would be measuring a different thing
      depending on a mode.
    -->
    <!--
      THE TWO REGISTERS — *"a two-segment control … \`Workbench | Edition\`,
      styled like the app's existing acts"* (RENDERER-DESIGN.md §5).

      ABOVE THE SCROLLER AND NOT IN IT, which reverses where this control
      stood and is the user's own ruling (2026-08-17): the head used to open
      the sheet's column and stick to the scrollport's top edge, and a stuck
      tray is a tray the words pass UNDER — *"the workspace/final version
      buttons at the top cover the file when i scroll down."* So the register
      stands in a row of the host's own column above the pair, the book
      scrolls in the box below it, and nothing the sheet says can arrive
      beneath these buttons because they are not over the sheet at all. The
      BOTTOM tray keeps its sticky edge: Apply is a verb somebody reaches for
      mid-page, and it should ride the scroll; the head is a REGISTER — a
      fact about the page rather than a verb on it — and a fact can hold
      still.

      A GROUP OF TWO BUTTONS AND NOT A CHECKBOX. \`aria-pressed\` on each says
      which one is in force in the one vocabulary a screen reader already has
      for a segmented control, and buttons are reachable, pressable and
      focusable from a keyboard with nothing added.
    -->
    <!--
      AN EXPORT VIEW HAS NO HEAD AT ALL: one register, no pair, no verbs —
      a control whose every segment is refused is furniture explaining
      itself, and the absence says "this is the finished file" better. A
      problem and a load still in flight have none either, now that the head
      stands outside the sheet's own column: a register over a bench holding
      only a sentence would be a claim about a book that is not there.
    -->
    @if (!problem() && !loading()) {
      <div class="tray head" [style.display]="viewing() ? 'none' : null">
        <!--
          ── APPLY, WHERE THE PERSON IS ALREADY LOOKING ───────────────────────

          *"and maybe there should be another apply changes button somewhere
          obvious. the button on the side of the workbench works but it isnt
          obvious"* (Owen, 2026-08-22). The tray at the foot of the bench is
          right where it is and it stays — a verb you reach for mid-page should
          ride the scroll — but it is one small button in a corner of a wide
          bench, in the same weight as Undo beside it, and a person with three
          changes on the page and an export to run did not find it.

          THIS IS THE HEAD ROW, WHICH IS A ROW OF FACTS, AND A VERB IS NOT ONE.
          That objection is the head's own (see the register's comment below) and
          it is answered rather than ignored: this button is not furniture that
          sits here explaining itself. It EXISTS ONLY WHILE THERE IS SOMETHING TO
          APPLY, which makes it the same kind of thing as the rest of the row —
          a fact about this page, stated as the one press that changes it — and
          absent the rest of the time, on the house's absent-not-disabled rule.
          The tray's button is the opposite and deliberately so: it is DISABLED
          at zero, so the affordance can be learnt before there is anything to
          press it with. Learn it there; be caught by it here.

          THE ACCENT IS THE POINT and it is spent once. Nothing else on this
          surface is filled with it — the registers are the shell's greys, the
          paper has its own inks — so the one accent-filled thing in the pane is
          the one press that is waiting on somebody.

          IT DRAWS IN THE EDITION TOO, unlike the foot tray (which the mode makes
          \`inert\`). The argument there is that the tray is the bench's
          furniture and the edition has none; the argument here is stronger the
          other way. Looking at the finished book is exactly when somebody
          discovers a change they meant to record, and a stack is
          mode-independent — the edition is a projection of the same ops — so
          the press means the same thing from either register.

          THE COUNT IS THE TRAY'S OWN LABEL, not a second spelling of it. One
          function, one wording, two places it is drawn; the card that main
          composes says "Apply changes" without a number because its own title
          carries the count, and that is the seam's copy rather than this one's.
        -->
        @if (waiting() > 0) {
          <button
            type="button"
            class="act now"
            [disabled]="applying()"
            title="Record every change on this page as one row in Steps"
            (click)="apply()"
          >{{ applying() ? 'Applying…' : applyLabel() }}</button>
        }
        <!--
          COMPARE SITS IN THE HEAD ROW, beside the registers, because this row is
          already the answer to "what am I looking at, and how" — and a second
          step beside this one is one more answer to that. It is drawn only where
          this viewer is the LIVE one: the head is hidden entirely while
          \`viewing()\` (an export view, and a compare column), so the control
          cannot appear inside the very column it opens.
        -->
        <app-compare-picker />
        <div class="segments" role="group" aria-label="How this book is shown">
          <button
            type="button"
            class="act segment"
            [class.on]="!edition()"
            [attr.aria-pressed]="!edition()"
            (click)="show('workbench')"
          >Workbench</button>
          <button
            type="button"
            class="act segment"
            [class.on]="edition()"
            [attr.aria-pressed]="edition()"
            (click)="show('edition')"
          >Final version</button>
        </div>
        <!--
          AND THE SECOND CONTROL, WHICH IS NOT A THIRD SEGMENT.

          \`Workbench | Edition\` is the REGISTER — what kind of thing this page
          is — and Aligned is not a third kind of page: it composes with the
          workbench (chrome on the live column, the source beside it) and is
          meaningless against the edition, which is the finished book and has one
          column. A third segment would have said the three were alternatives and
          put "the finished book, with a working column beside it" on the list of
          things a person could ask for.

          IT IS ONLY THERE ON A TRANSLATED POSITION. There is no source to set
          beside a book in its own language, and a control that was permanently
          dimmed on every ordinary book would be furniture nobody could ever use.

          REFUSED RATHER THAN DISABLED. \`aria-disabled\` and not \`disabled\`,
          because a control that cannot be reached cannot say why it cannot be
          used: the title is for a pointer that pauses, and a PRESS puts the same
          sentence on the window's notice strip, where the rest of this app says
          what it would not do.
        -->
        @if (translation() !== null) {
          <div class="segments" role="group" [attr.aria-label]="'Where the source of this ' + pass() + ' is shown'">
            <button
              type="button"
              class="act segment"
              [class.on]="!aligned()"
              [attr.aria-pressed]="!aligned()"
              (click)="align('alone')"
            >Alone</button>
            <button
              type="button"
              class="act segment"
              [class.on]="aligned()"
              [attr.aria-pressed]="aligned()"
              [attr.aria-disabled]="alignRefusal() !== null ? 'true' : null"
              [attr.title]="alignRefusal()"
              (click)="align('aligned')"
            >Aligned</button>
          </div>
        }
      </div>
    }
    <div class="pair" [class.aligned]="aligned()">
      @if (aligned()) {
        <!--
          ITS OWN SCROLLER, which is the whole mechanism: two scrollable boxes are
          what there is to lock together.

          AND NO \`(scroll)\` BINDING ON IT, deliberately — the listeners are put on
          the HOST in the capture phase instead, and the constructor says why: an
          Angular event binding marks this view dirty every time it fires, and a
          scroll fires every frame of every drag of every book, aligned or not.
        -->
        <div class="context">
          @if (sourceProblem(); as reason) {
            <div class="sheet context-sheet"><p class="failure">{{ reason }}</p></div>
          } @else {
            <!--
              THE TITLE SAYS WHERE SOURCE EDITS LIVE, and it is the only thing this
              sheet says about itself. A double-click here reaches no handler —
              there is none bound on this sheet — so the sheet does not refuse the
              gesture, it simply is not one of the surfaces that takes it, and the
              sentence names the step where those words ARE editable.
            -->
            <div
              class="sheet context-sheet"
              [attr.title]="sourceTitle()"
            >
              @for (line of sourceLines(); track line.row.id) {
                @if (line.opensNotes) { <div class="notes-rule"></div> }
                <div
                  class="block"
                  [attr.data-id]="line.row.id"
                  [style.color]="line.colour"
                  [class.twin]="twinned() === line.row.id"
                  (pointerenter)="twin(line.row.id)"
                  (pointerleave)="twin(null)"
                >
                  <div class="body">
                    <ng-container
                      *ngTemplateOutlet="prose; context: { $implicit: line, plain: true }"
                    ></ng-container>
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }
    <div class="bench" [class.edition]="edition()">
      @if (problem(); as reason) {
        <div class="sheet"><p class="failure">{{ reason }}</p></div>
      } @else if (loading()) {
        <div class="sheet"><p class="waiting">Opening the book…</p></div>
      } @else {
        <!--
          WHAT AN OLD SAVE COULD NOT SAY ABOUT THIS BOOK — one line per decision,
          and nothing at all in the ordinary case. See \`unplaced\` for why this is
          on the paper rather than on the notice strip, and why it is a list of
          sentences rather than a count.
        -->
        @if (unplaced().length > 0) {
          <div class="sheet unplaced">
            <p class="lede">
              This row was saved before Foundry recorded changes against blocks, and most of what
              it decided is on the page. These could not be placed:
            </p>
            <ul>
              @for (said of unplaced(); track said) { <li>{{ said }}</li> }
            </ul>
          </div>
        }
        <!--
          \`tabindex="-1"\` so the sheet can HOLD focus without being a tab stop.
          The Delete key has to reach a selection that a marquee made over empty
          paper, and a marquee focuses nothing; a press on the paper puts focus
          here instead, and a press on a block focuses the block, whose keydown
          bubbles to this handler anyway. One listener, both routes, and no
          second tab stop in front of the book.
        -->
        <div
          class="sheet"
          tabindex="-1"
          (pointerdown)="press($event)"
          (pointermove)="drag($event)"
          (pointerup)="release($event)"
          (pointercancel)="release($event)"
          (dblclick)="edit($event)"
          (keydown.delete)="cancel($event)"
          (keydown.backspace)="cancel($event)"
          (keydown.escape)="dismissCards()"
          (keydown.control.j)="joinChosen($event)"
          (keydown.meta.j)="joinChosen($event)"
        >
          <!--
            THE OPS THAT LANDED ON NOTHING — reported, never guessed at
            (docs/RENDERER.md §3), on the paper's top edge where the reader meets
            it before the book. MUTED AND NOT AMBER: the flags in the gutters are
            amber because each of them is a decision somebody has to make, and
            this is not one. It is a fact about the history of this book — a
            change recorded against a paragraph that a later reading of the pages
            no longer has — and there is nothing here to do.
          -->
          <!--
            AND NOT IN THE EDITION. It is a report about this book's HISTORY —
            changes recorded against paragraphs a later reading no longer has —
            which makes it the most instrument-shaped mark on the sheet, and the
            export writes nothing like it. The facts do not go away with the
            register: one press of Workbench and the strip is back.
          -->
          @if (!edition() && (stranded() > 0 || refused().length > 0)) {
            <div class="stranded">
              @if (stranded(); as many) {
                <p>
                  {{ many }} recorded {{ many === 1 ? 'change names a block' : 'changes name blocks' }}
                  this book no longer has, so {{ many === 1 ? 'it was' : 'they were' }} left out.
                </p>
              }
              <!--
                AND THE ONES THAT NAMED BLOCKS THIS BOOK HOLDS. A cut that would
                leave one half empty, a second reference number on words another
                already claims, a division asked to move from above a block that
                has none: the replay refuses those on their merits and says why in
                its own sentence (\`MissingOp.why\`). Saying "this book has no block
                called that" about one would be a lie, and paraphrasing the replay
                here would be a second account of a refusal that already has one.
              -->
              @for (said of refused(); track $index) {
                <p>{{ said }}</p>
              }
            </div>
          }
          @for (line of sheetLines(); track line.row.id) {
            <!--
              The seam sits FIRST in a line's group of marks so that in the DOM
              it is the next sibling of the block ABOVE it — which is what lets
              a hover on either neighbour reveal it with two CSS selectors and
              no state. A chapter rule and a seam on one block cannot honestly
              co-occur (the reflow never leaves a seam onto a chapter opening),
              so the ordering costs nothing.
            -->
            @if (line.seamInto; as into) {
              <!--
                THE GHOST IS THE JOIN (RENDERER-DESIGN.md §4). A button because it
                is one, which is also what makes it reachable from a keyboard —
                and \`pointerdown\` is stopped for the margin chip's reason: a press
                on the sheet takes pointer capture, and a captured pointer
                retargets the click that follows to the sheet, where it would
                arrive with no idea which seam it had been.
              -->
              <div class="seam">
                <button
                  type="button"
                  class="seam-word"
                  aria-label="Join these two paragraphs — the page turn between them was left unjoined"
                  (pointerdown)="$event.stopPropagation()"
                  (click)="join(line.row.id, into)"
                >··· join ···</button>
              </div>
            }
            @if (line.chapter; as title) {
              <div class="chapter">
                <div class="chapter-head">
                  @if (renaming() === line.row.id) {
                    <!--
                      *"Double-click the chip to rename in place"* — §4, and the chip
                      itself is the field, exactly as the block itself is the editor
                      one level down. \`plaintext-only\` for the same reason: a title
                      is characters, and a rich contenteditable would let a paste
                      bring markup into one.
                    -->
                    <span
                      class="chapter-chip naming"
                      contenteditable="plaintext-only"
                      (pointerdown)="$event.stopPropagation()"
                      (blur)="commitChapter(line.row.id, title, $event)"
                      (keydown.enter)="commitChapter(line.row.id, title, $event)"
                      (keydown.escape)="abandonChapter(title, $event)"
                    >{{ title }}</span>
                  } @else {
                    <!--
                      Drag to move the division (§4: the rule lifts, the candidate
                      seams glow, the drop settles it) — pointer-captured on the
                      chip, engaged past the same slop that separates a click from
                      a marquee, so the double-click rename underneath survives.
                    -->
                    <span
                      class="chapter-chip"
                      [class.grabbed]="draggingRule()?.id === line.row.id"
                      (pointerdown)="grabRule($event, line.row.id)"
                      (pointermove)="dragRule($event)"
                      (pointerup)="dropRule($event)"
                      (pointercancel)="dropRule($event)"
                      (dblclick)="rename(line.row.id, $event)"
                    >{{ title }}</span>
                    <!--
                      THE MARKER'S OWN ✕ — *"the green dotted line can have an X
                      next to the text"* (user ruling, 2026-08-17). Removing a
                      division used to live only in the Chapters panel, which made
                      the one place a person SEES the rule the one place they could
                      not take it away. Revealed on hover of the rule rather than
                      always drawn, because the paper's marks stay quiet until the
                      hand is near them — and the space is held either way, so
                      nothing shifts under the pointer. \`pointerdown\` is stopped
                      for the chip's own reason: a press on the sheet takes pointer
                      capture, and a captured pointer retargets the click that
                      follows to the sheet, where it would arrive with no idea
                      which rule it had been about.
                    -->
                    <button
                      type="button"
                      class="chapter-x"
                      aria-label="Remove this chapter marker — the text stays; the division goes"
                      title="Remove this chapter marker"
                      (pointerdown)="$event.stopPropagation()"
                      (click)="dropChapter(line.row.id)"
                    >✕</button>
                  }
                </div>
              </div>
            }
            <!--
              THE DIVISION, AS THE FINISHED BOOK SETS IT. The cast writes a
              chapter opening as the block that was already there wearing the
              chapter attribute — an \`h1\` for a Title, an \`h2\` for a
              Section-header — so a heading is drawn HERE only where the block
              below is not itself one and the division would otherwise have
              nothing on the page saying its name (\`EditionPlace.heading\`,
              ./edition). \`h1\` because that is the tag the cast gives a chapter
              opener in the ordinary case.
            -->
            @if (line.heading; as title) {
              <h1 class="division" [style.font-size.em]="headingSize()">{{ title }}</h1>
            }
            @if (line.opensNotes) { <div class="notes-rule"></div> }
            <!--
              THERE IS NO \`animate.leave\` HERE, AND ITS ABSENCE IS THE RULING.
              The only thing that ever takes rows out of this list is the
              register flip, and the flip takes out every struck block at once —
              four hundred of them on a working book, because a working book is
              what four hundred strikes look like. A leave binding is not free
              per element: to know when a node may go, the framework reads that
              node's own animations and computed style, one at a time, against a
              sheet whose bodies are under \`content-visibility: auto\`. §6
              carries the measurement and the arithmetic. The flip's motion is
              §5's crossfade on the sheet itself; the blocks are simply not in
              the list on the next frame, which is what a still would show.
            -->
            <div
              class="block"
              tabindex="0"
              [attr.data-id]="line.row.id"
              [attr.data-jump]="line.jump"
              [style.color]="line.colour"
              [class.opens]="line.opens"
              [class.selected]="chosen().has(line.row.id)"
              [class.struck]="line.row.struck === true"
              [class.editing]="editingId() === line.row.id"
              [class.lit]="lit() === line.row.id"
              [class.pulse]="pulse() === line.row.id"
              [class.spanned]="spans(line)"
              [class.twin]="twinned() === line.row.id"
              [class.drop-target]="draggingRule()?.over === line.row.id"
              (pointerenter)="lightRow(line)"
              (pointerleave)="dim()"
              (contextmenu)="blockMenu($event, line)"
            >
              <span class="gutter rail"></span>
              @if (!edition() && chosen().has(line.row.id)) {
                <!--
                  THE CHIP IS THE CATEGORY'S DOOR. It already names the category
                  of the block it sits beside, so it is the one place in the
                  margin where "and this is what it could be instead" belongs.
                  IT OPENS A LIST rather than cycling: a chip that cycled would
                  be undiscoverable — nothing about it says there are eleven
                  answers behind it — and every misclick would mutate the
                  document. A button because it is one, which is also what makes
                  it reachable from a keyboard.
                -->
                <button
                  type="button"
                  class="gutter chip"
                  [attr.aria-label]="'Category of this block: ' + line.label"
                  (pointerdown)="$event.stopPropagation()"
                  (click)="openCategories($event, line.row.id)"
                >{{ line.label }}</button>
              }
              @if (line.ordinal !== null) {
                <span class="gutter ordinal">{{ line.ordinal }}</span>
              }
              @if (line.ghost !== null) {
                <span
                  class="gutter ghost"
                  (pointerenter)="haunt(line.ghost)"
                  (pointerleave)="haunt(null)"
                >≈ {{ line.ghost }}</span>
              }
              @if (line.flag; as said) {
                <span class="gutter flag"><span class="pill">{{ said }}</span></span>
              }

              <div class="body">
                <!--
                  THE BLOCK ITSELF IS THE EDITOR (RENDERER-DESIGN.md §3): a caret
                  in the words, a spruce rail and tint, no box and no textarea.
                  \`plaintext-only\` because what is being edited is the model's
                  SOURCE STRING — \`*italics*\` and superscript digits included
                  (docs/RENDERER.md §2) — and a rich contenteditable would let a
                  paste bring markup into a field whose whole content is meant to
                  be characters. The marker cuts are gone for the duration and
                  come back when the edit commits, which is the honest picture:
                  while you are editing there are no resolved offsets, because
                  the offsets are what the edit invalidates.
                -->
                @if (editingId() === line.row.id) {
                  <p
                    class="para editor"
                    contenteditable="plaintext-only"
                    [class.indent]="line.indent"
                    [style.font-size.em]="line.size"
                    (blur)="commit(line.row.id, $event)"
                    (keydown.enter)="split(line.row.id, $event)"
                    (keydown.escape)="revert(line.row.text, $event)"
                  >{{ line.row.text }}</p>
                } @else {
                  <ng-container
                    *ngTemplateOutlet="prose; context: { $implicit: line, plain: edition() }"
                  ></ng-container>
                }
              </div>
            </div>
          }
          @if (marquee(); as box) {
            <div
              class="marquee"
              [style.left.px]="box.left"
              [style.top.px]="box.top"
              [style.width.px]="box.width"
              [style.height.px]="box.height"
            ></div>
          }
          <!--
            THE PEEK CARD — the other half of an apparatus, brought to the hand
            instead of the hand being dragged to it. Clicking a reference number
            or a note used to scroll the sheet to the counterpart; the ruling is
            that the scrollbar is the reader's and a click must not move it. So
            the counterpart appears ON a card beside the click, joined to it by
            a short sienna leader, and the one deliberate way to travel remains:
            the card's own "Go there", which is the old jump, asked for by name.
            Anchored in sheet coordinates, so it rides the scroll like any ink.
          -->
          @if (peeked(); as card) {
            <svg
              class="peek-line"
              [style.left.px]="card.line.left"
              [style.top.px]="card.line.top"
              [attr.width]="card.line.width"
              [attr.height]="card.line.height"
            >
              <circle [attr.cx]="card.line.x1" [attr.cy]="card.line.y1" r="2.5"></circle>
              <line
                [attr.x1]="card.line.x1" [attr.y1]="card.line.y1"
                [attr.x2]="card.line.x2" [attr.y2]="card.line.y2"
              ></line>
            </svg>
            <aside
              class="peek"
              [style.left.px]="card.x"
              [style.top.px]="card.y"
              (pointerdown)="$event.stopPropagation()"
            >
              <div class="peek-head">
                <span class="peek-what">{{ card.label }} · ≈ {{ card.page }}</span>
                <button type="button" class="peek-go" (click)="travel(card.target)">Go there</button>
              </div>
              <!--
                THE CARD SETS THE COUNTERPART THE WAY THE PAGE SETS IT, emphasis
                included. It draws the same \`pieces\` the sheet does, so the
                asterisks are already gone from them; leaving the classes off
                here would show a note in roman on the card and in italics eight
                lines down, which is one book disagreeing with itself about a
                title.
              -->
              <p class="peek-words" [class.struck-words]="card.struck">
                @for (piece of card.pieces; track $index) {
                  @if (piece.marker; as marker) {
                    <span
                      class="marker plain"
                      [class.hot]="marker.note === peekFrom()"
                      [class.bold]="piece.strong"
                      [class.italic]="piece.italic"
                    >{{ piece.text }}</span>
                  } @else {
                    <span
                      class="run"
                      [class.bold]="piece.strong"
                      [class.italic]="piece.italic"
                    >{{ piece.text }}</span>
                  }
                }
              </p>
            </aside>
          }
          <!--
            THE ORIGINAL PAGE, BESIDE THE BLOCK THAT WAS CLICKED. *"i want to
            hover over a block and see that page of the original beside it"*
            asked for the card; *"it should only appear when a block is actually
            clicked"* decided the gesture. Placed here, beside the note peek,
            because the two are the same idiom on the same paper — and kept as
            separate state because they are still different questions: a peek
            answers "what does the other half of this apparatus say", a glance
            answers "what did this paragraph look like on the printed page".
            Both may be open at once and neither has an opinion about the other.
            See ./page-glance.

            IT IS MOUNTED ONCE AND TOLD TO SHOW NOTHING, never put up and taken
            down, and that is not a style preference — it is the difference
            between the card the component's header describes and the one that
            was running. This was \`@if (glanceAt())\`, so the component was
            DESTROYED every time the card went away, and with it the pdf.js
            worker it promises to build "once and keep", the open document, and
            the twelve-page bitmap cache that is supposed to make the second
            glance at a page free. MEASURED: a walk of ten glances down one book
            built TEN workers and terminated none, and every glance re-read the
            whole scan over IPC and re-parsed it — 0.7-1.0s each, a cost that
            never fell because nothing survived to make it fall. The component
            draws nothing when its row is null and hides itself, so this can
            simply stay.

            AND THE MOUNT IS WHAT MAKES THE CARD MEASURABLE: the placement is
            decided against this card's REAL WIDTH and HEIGHT, read off this
            element, rather than against numbers this file keeps about sizes
            declared in another one. \`#glance\` is that reading.

            THE TWO INLINE COORDINATES ARE VIEWPORT COORDINATES — the host is
            \`position: fixed\` (Owen's ruling, 2026-08-22; ./page-glance and
            \`placeGlance\` carry the argument), so the card stands in the
            workbench's gray beside the paper and holds still on screen through
            any scroll of the bench, with no scroll listener anywhere.
          -->
          <app-page-glance
            #glance
            [style.top.px]="glanceAt() ?? 0"
            [style.left.px]="glanceLeft()"
            [original]="original()"
            [row]="glanced()"
          />
        </div>
        <!--
          APPLY — the stack, written down. ON THE BENCH AND NOT ON THE PAPER,
          which is the design law working rather than a placement preference:
          chrome lives in the paper's gutters and backgrounds, and a button is
          neither. It is the app's own \`.act\` in the app's own dark tokens, in
          the corner of the workbench, because that is where this app puts a verb.

          THE COUNT IS IN THE LABEL rather than beside it, on \`labelFor\`'s rule
          for a step row: "Apply" alone does not say whether it is about to record
          one strike or forty. DISABLED AT ZERO rather than hidden, so the
          affordance is somewhere a person can learn it is there before they have
          anything to press it with.
        -->
        <!--
          AND IN THE EDITION IT IS \`inert\`. The tray is the bench's furniture and
          the edition has none of it, but a button faded to nothing is still a tab
          stop and still takes a press — so the mode does not hide it, it takes it
          out of the document. Apply is not gone, it is one press of Workbench
          away, and the head that gets you there is the only thing on the bench
          that stays.
        -->
        <div
          class="tray"
          [style.display]="viewing() ? 'none' : null"
          [attr.inert]="edition() ? '' : null"
        >
          @if (waiting() > 0) {
            <button type="button" class="act ghost" (click)="undo()">Undo</button>
          }
          <button
            type="button"
            class="act"
            [disabled]="waiting() === 0 || applying()"
            (click)="apply()"
          >{{ applying() ? 'Applying…' : applyLabel() }}</button>
        </div>
      }
      <!--
        The category list — the app's own small menu, scrim and all
        (open-documents' \`.menu\`, which is where this vocabulary is settled). It
        is the SHELL's dark style and not the paper's, deliberately:
        RENDERER-DESIGN.md §5 keeps the paper vocabulary on the paper, and an
        overlay floating above the sheet is not part of it.
      -->
      @if (menu(); as open) {
        <div class="menu-scrim" (click)="menu.set(null)" (contextmenu)="menu.set(null)"></div>
        <div
          class="menu"
          role="menu"
          aria-label="What kind of block this is"
          [style.left.px]="open.x"
          [style.top.px]="open.y"
          (keydown.escape)="menu.set(null)"
        >
          @for (candidate of categories; track candidate.id) {
            <button
              role="menuitem"
              [class.current]="candidate.id === open.category"
              (click)="relabel(open.id, candidate.id)"
            >
              <span class="swatch" [style.background]="candidate.colour"></span>{{ candidate.label }}
            </button>
          }
        </div>
      }
      <!--
        THE BLOCK'S OWN MENU — right-click, the same small-menu vocabulary as
        the category list above it. Two verbs about the whole CATEGORY of the
        block under the pointer, because that is the book-wide gesture a
        right-click reaches for (user ruling, 2026-08-16: select all the
        footnotes, so they can go together). Select feeds the ordinary loop —
        rails and chips come up, Delete strikes; Strike is the same destination
        in one press. Both counts are in the labels, on the Apply button's rule:
        a verb about forty rows says forty before it is pressed.
      -->
      @if (context(); as open) {
        <div class="menu-scrim" (click)="context.set(null)" (contextmenu)="context.set(null)"></div>
        <div
          class="menu"
          role="menu"
          aria-label="About every block of this kind"
          [style.left.px]="open.x"
          [style.top.px]="open.y"
          (keydown.escape)="context.set(null)"
        >
          <!--
            The one verb about THIS block rather than its kind: the same editor
            the double-click opens, offered where a double-click has neighbours
            that mean other things (the chip renames, a note's click peeks).
          -->
          <button role="menuitem" (click)="editFromMenu()">
            <span class="swatch" [style.background]="open.colour"></span>
            Edit this block
          </button>
          <!--
            *"right-click a block and hit 'add chapter marker', and itll add a
            chapter break above that block"* (user ruling, 2026-08-17). The
            second block-scoped verb, beside Edit — the panel's "chapter starts
            here" button said the same thing about a block picked on the paper,
            and this is that verb offered where the block already is, without
            the trip through a selection. The swatch wears the chapter ink
            rather than the category's, because the verb is about the green
            world of divisions and not about what kind of block this is.
          -->
          @if (!open.chapter) {
            <button role="menuitem" (click)="chapterFromMenu()">
              <span class="swatch" style="background: var(--ink-chapter)"></span>
              Add a chapter marker above this block
            </button>
          }
          <button role="menuitem" (click)="selectSimilar()">
            <span class="swatch" [style.background]="open.colour"></span>
            Select {{ open.ids.length === 1 ? 'the 1' : 'all ' + open.ids.length }} {{ open.plural }}
          </button>
          @if (open.unstruck.length > 0) {
            <button role="menuitem" (click)="strikeSimilar()">
              <span class="swatch" [style.background]="open.colour"></span>
              Strike {{ open.unstruck.length === 1 ? 'the 1' : 'all ' + open.unstruck.length }} {{ open.plural }}
            </button>
          }
        </div>
      }
    </div>
    </div>
  `,
  styles: [`
    /* ── §1 Tokens. Copied from RENDERER-DESIGN.md, and nothing else in this
       file is a colour. The app shell keeps its own dark variables; these are
       the paper's, declared once on the surface's host. ─────────────────── */
    :host {
      --bench:        var(--bg-base, #191817);

      --paper:        #f6f1e7;
      --paper-high:   #fbf8f1;
      --ink:          #211d16;
      --ink-muted:    #6f6659;
      --ink-faint:    #a99f8f;

      --ink-select:   #3b6ea5;
      --ink-strike:   #a23b2a;
      --ink-chapter:  #2f7d4f;
      --ink-note:     #8a5a2b;
      --ink-flag:     #b98a1c;
      --ink-edit:     #2f7d4f;

      --gutter:       3.25rem;
      --rail-w:       3px;
      --radius:       3px;
      --shadow-paper: 0 1px 2px rgb(0 0 0 / .4), 0 12px 48px rgb(0 0 0 / .28);

      --ease:         cubic-bezier(.2, .7, .3, 1);
      --t-fast:       120ms;
      --t-med:        180ms;

      /* A COLUMN NOW: the head row first, the pair filling the rest. The
         bench ground is painted on the host itself because the head row is
         narrower than the pane — the strip either side of it would otherwise
         be the viewer's own darker sunken tone showing through a surface
         that is meant to read as one bench. */
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--bench);
      /*
       * WHAT LETS A BLOCK COLLAPSE FROM THE HEIGHT IT HAPPENS TO HAVE. §6 asks
       * that things which leave the document collapse, and a block's height is
       * \`auto\` — there is no number to animate from, and measuring one is the
       * FLIP machinery this surface has been told not to grow (see \`join\`).
       * \`interpolate-size\` is the browser doing that measurement itself, which
       * is why the collapse below is nine lines of CSS and no JavaScript. It is
       * inherited, so it is declared once here; nothing else on this sheet
       * animates a keyword, so it changes nothing that is already drawn.
       */
      interpolate-size: allow-keywords;
    }

    /* ── §2 The paper ─────────────────────────────────────────────────────── */

    /* The bench shows above and below the sheet so the paper reads as an object
       and not as a fill. Clipped horizontally rather than scrollable: a margin
       chip longer than its gutter is chrome, and chrome must never be able to
       give the page a second scrollbar. */
    .bench, .context {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden auto;
      padding-block: 3rem;
      background: var(--bench);
      scrollbar-width: thin;
      scrollbar-color: #3a3733 transparent;
      /* Equal halves of the pair, and zero basis so a long word in one column
         cannot widen it at the other's expense. Alone, one item at \`flex: 1\` is
         the whole width, which is what the bench has always been. */
      flex: 1 1 0;
      min-width: 0;
    }
    .bench::-webkit-scrollbar, .context::-webkit-scrollbar { width: 8px; }
    .bench::-webkit-scrollbar-track, .context::-webkit-scrollbar-track { background: transparent; }
    .bench::-webkit-scrollbar-thumb, .context::-webkit-scrollbar-thumb {
      background: #3a3733;
      border-radius: 4px;
    }

    .sheet {
      position: relative;
      width: min(46rem, 92%);
      margin: 0 auto;
      padding: 4.5rem var(--gutter) 6rem;
      border-radius: 2px;
      background: var(--paper);
      box-shadow: var(--shadow-paper);

      font-family: 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif;
      /* --zoom is the loupe — Ctrl+wheel, set natively on the host — and it
         multiplies the type rather than transforming the box, so every
         em-derived measure on the paper scales with the words as one thing. */
      font-size: calc(1.05rem * var(--zoom, 1));
      line-height: 1.62;
      color: var(--ink);
      text-rendering: optimizeLegibility;
      /* The archival blue at reading strength — the browser's washed default
         made a selection something to squint at (user report, 2026-08-16). */
      &::selection, & *::selection {
        background: color-mix(in srgb, var(--ink-select) 30%, transparent);
      }
      /* A drag over the sheet is the marquee (§3). A native text selection left
         behind by one would be a second highlight nothing on screen explains, so
         the browser's own is off — copying a block's words is a gesture this
         surface does not offer yet. */
      user-select: none;
      /* §5 — the crossfade into the edition. The GUTTERS are what actually
         travels: the paper's 3.25rem of instrument margin closes to the export's
         own \`body { margin: 0 5%; }\` and the leading opens from the bench's 1.62
         to the cast sheet's 1.5, both over \`--t-med\`, both back again. Neither
         property ever changes for any other reason, so this transition costs
         nothing on a book nobody is previewing. */
      transition:
        padding var(--t-med) var(--ease),
        line-height var(--t-med) var(--ease);
    }

    .sheet:focus { outline: none; }

    /* ── §5 The pair ──────────────────────────────────────────────────────── */

    .pair { display: flex; width: 100%; flex: 1 1 0; min-height: 0; }
    /*
     * *"Both sheets narrow to fit: min(38rem, 46%) each."* — the lead's measure,
     * written here against the COLUMN because that is the box a sheet is centred
     * in: each column is half the pair, so 92% of one is 46% of the bench, and the
     * two spellings are the same width. What is left over is bench, on both sides
     * of both sheets, which is the gap between them.
     */
    .pair.aligned .sheet, .pair.aligned .tray { width: min(38rem, 92%); }
    /*
     * THE CONTEXT SHEET IS THE PAPER WITHOUT THE INSTRUMENT. Same ground, same
     * serif, same measured sizes — it has to be, or the two columns would set the
     * same book in two typefaces and the scroll lock would be tying rows of
     * different heights together — and none of §3's chrome, because there is
     * nothing on this sheet to decide. The gutters close to the paper's own
     * margin: with no rails, chips, ordinals, ghosts or flags to hang in them,
     * 3.25rem of instrument margin either side would be air with nothing in it.
     */
    .context-sheet {
      padding-inline: 2rem;
      /* A caret cannot land here — there is no editor on this sheet — but a
         person reading the source will want to take a sentence out of it, and
         nothing on this column drags a marquee for the selection to fight with. */
      user-select: text;
    }

    .waiting, .failure { margin: 0; text-indent: 0; color: var(--ink-muted); }
    .waiting { text-align: center; }
    /*
      The unplaced strip sits above the paper as a sheet of its own, in the
      muted register the sheet already uses for what the app is telling you
      about the book rather than what the book says.
    */
    .unplaced { margin-bottom: 0.75rem; }
    .unplaced .lede { margin: 0 0 0.4rem; text-indent: 0; color: var(--ink-muted); }
    .unplaced ul { margin: 0; padding-left: 1.1rem; color: var(--ink-muted); }
    .unplaced li { text-indent: 0; }

    /* A fact about the chain, not a decision to make — so it is \`--ink-muted\`
       and not the amber the gutter flags wear. It sits above the first block,
       inside the paper's own top padding, and it takes its own height because
       it is only ever there when it has something to say. */
    .stranded {
      margin: -2rem 0 2rem;
      color: var(--ink-muted);
      font-size: 0.8rem;
      font-style: italic;
    }
    .stranded p { margin: 0 0 0.4em; text-indent: 0; }
    .stranded p:last-child { margin-bottom: 0; }

    /* ── §3 Block chrome. The text column NEVER reflows from any of it: rails
       and chips are absolute in the gutters, tints are backgrounds that bleed
       past the text and back. ─────────────────────────────────────────────── */

    /* The chrome host. It is exactly as wide as the text column, so every
       gutter offset below is measured from the words rather than from a box
       that has already been pushed about. */
    .block { position: relative; outline: none; }

    /* The words, the tint, and the containment — see the class docblock for why
       the last of those cannot live on the host. */
    .body {
      margin-inline: -0.9rem;
      padding-inline: 0.9rem;
      border-radius: var(--radius);
      content-visibility: auto;
      contain-intrinsic-size: auto 4rem;
      transition: background var(--t-fast) var(--ease);
    }

    /* The category ink rides on the block's own \`color\` so that every mark below
       can be a \`currentColor\` mix and no second palette is stated anywhere. It
       reaches .body too, which is what makes the tints category-coloured — and
       the WORDS are put straight back to the book's ink one level in, because a
       book with recoloured text is unreadable, which is the rule categories.ts
       closes with. */
    .body > * { color: var(--ink); }

    .block:hover .body { background: color-mix(in srgb, currentColor 5%, transparent); }
    /*
     * §5 — THE TWIN, which is the hover tint reaching across the gap.
     *
     * *"Hovering a block in either column lights the SAME id in the other."* It is
     * the hover state and NOT the note coupling's sienna one level down: what is
     * being said is "this paragraph and that paragraph are the same paragraph",
     * which is exactly what a hover already says about one block. A second colour
     * would have made the pairing look like a decision somebody had to make.
     * Selection and the lit note both beat it, by order, because both of those ARE
     * decisions.
     */
    .block.twin .body { background: color-mix(in srgb, currentColor 5%, transparent); }
    .block.selected .body { background: color-mix(in srgb, currentColor 16%, transparent); }
    .block.lit .body, .block.pulse .body {
      background: color-mix(in srgb, var(--ink-note) 18%, transparent);
    }

    .gutter { position: absolute; pointer-events: none; }

    .rail {
      top: 0.15em;
      bottom: 0.15em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      width: var(--rail-w);
      border-radius: var(--rail-w);
      background: currentColor;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .block:hover .rail { opacity: 0.6; }
    .block.selected .rail { opacity: 1; }
    /* The one place page provenance is visible, and deliberately a whisper. */
    .block.spanned .rail { opacity: 1; background: var(--ink-faint); }

    /* ── §3 Struck: the proofreader's cancel ──────────────────────────────── */

    /*
     * THE MARK ITSELF, STATED ONCE. Two thin diagonals in the iron red at 50%,
     * which is the whole of the X. It is a custom property rather than two
     * literals because there are now TWO CARRIERS for it — the paint behind a
     * block of prose and the paint over a plate, for the reason the next two
     * docblocks argue — and two hand-copied gradients are two marks that drift
     * the first time somebody adjusts the weight of one of them. Nothing about
     * the ink moved: this is the same declaration that used to sit inline in
     * \`.block.struck .body\`, character for character.
     */
    .block {
      --strike-x:
        linear-gradient(to bottom right,
          transparent calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% + 1px),
          transparent calc(50% + 1px)),
        linear-gradient(to top right,
          transparent calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% - 1px),
          color-mix(in srgb, var(--ink-strike) 50%, transparent) calc(50% + 1px),
          transparent calc(50% + 1px));
    }

    /*
     * COPIED FROM RENDERER-DESIGN.md §3 AND NOT REINTERPRETED. Line-through in
     * the iron red at 55%, the whole block at .45, and the X drawn as two thin
     * diagonal linear-gradients in the same ink at 50% with \`mix-blend-mode:
     * multiply\` — which is what makes the mark sit ON the paper like ink rather
     * than float over it as a graphic. It is on \`.body\`, whose background box
     * already bleeds into the gutters, so the X crosses the block edge to edge
     * with no element added and no layout moved.
     *
     * THE MARK SHOWS ALWAYS. Struck is a state of the document and not of a mode
     * (landed rule), so there is no toggle anywhere that hides it — what leaves
     * the mark out is the EDITION, which is a projection and not a view of this
     * one.
     *
     * A BACKGROUND IS STILL RIGHT HERE AND IS WRONG ONE RULE DOWN, which is the
     * whole of the Picture defect and is worth stating on the rule that is
     * correct rather than only on the one that had to change. Glyphs cover a few
     * percent of the box they sit in, so paint behind prose reads as ink UNDER
     * the words, which is exactly what a proofreader's stroke is; and it costs no
     * element, no stacking context and no layout. A plate covers all of its box,
     * so the same paint is simply behind an opaque object and cannot be seen.
     * Prose does not move onto an overlay to keep the two consistent — the
     * consistency that matters is the MARK, and that is now one declaration.
     */
    .block.struck .body {
      opacity: 0.45;
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--ink-strike) 55%, transparent);
      background-image: var(--strike-x);
      background-repeat: no-repeat;
      mix-blend-mode: multiply;
      /* On strike the X fades and scales in; on restore it lifts. Scaling the
         BACKGROUND rather than the box is what keeps the promise that no chrome
         ever moves the text: the words stay exactly where they are while the
         mark grows across them. */
      background-size: 100% 100%;
      transition:
        opacity var(--t-med) var(--ease),
        background-size var(--t-med) var(--ease);
    }
    .block:not(.struck) .body { background-size: 0% 0%; }

    /*
     * ── §3 THE SAME MARK, OVER A PLATE ─────────────────────────────────────
     *
     * A struck Picture used to change state in every way except the one that
     * says struck. The plate dimmed to .45 and the caption took the line-through
     * — both of those are on \`.body\` and both land — while the X, which is
     * PAINT, sat behind an opaque image and was invisible. The user's words for
     * it were that it "kind of" happens in the background, which is an exact
     * description of a background.
     *
     * SO THE PICTURE, AND ONLY THE PICTURE, GETS THE MARK AS INK OVER THE PLATE.
     * \`figure\` is the Picture case's own element and appears nowhere else in
     * this template, so the selector needs no class plumbed through the switch
     * and no \`:has()\` to find one — the element IS the condition. It covers the
     * figure rather than the body so that the mark is the size of the thing it
     * cancels: a crop narrower than the column would otherwise take an X sized to
     * the column with two thirds of it crossing empty paper.
     *
     * AND THE BODY'S OWN PAINT IS TURNED OFF UNDER A FIGURE, which is the half of
     * this that is easy to miss. Left on, a picture would carry TWO marks — one
     * sized to the body showing in the margins either side of a narrow plate, and
     * one sized to the figure — and where no plate was ever cut, the dashed empty
     * frame is transparent, so both would be fully visible, at two sizes, crossing
     * each other. One block, one X.
     *
     * ── The three things carried across from the rule above ────────────────
     *
     * (1) THE ANIMATION IS ON \`background-size\`, and it needs BOTH halves of the
     * pair or the mark pops into existence instead of growing across. So the
     * pseudo-element exists at all times and is 0%×0% when the block is not
     * struck, exactly as \`.body\` is — a pseudo-element that only existed under
     * \`.struck\` would have nothing to transition from and nothing to lift on
     * restore.
     *
     * (2) \`mix-blend-mode\` MAKES THIS AN ISOLATED THING, and the isolation is
     * already where it needs to be. A blended element blends with the backdrop of
     * the nearest ancestor that forms a group, and \`.body\` forms one twice over
     * — \`content-visibility: auto\` implies paint containment, and a struck body
     * is at \`opacity: .45\`. So the multiply happens against the PLATE and the
     * body's own tint, then the whole composite fades to 45% over the paper. The
     * mark reads as ink on the picture rather than as a decal over the sheet,
     * which is the same sentence RENDERER-DESIGN §3 wrote about prose.
     *
     * The honest cost of multiply is that it darkens and cannot lighten, so
     * across a region of a plate that is already near black the X approaches
     * invisibility. That is accepted rather than worked around: the alternative
     * is a normal-blend stroke, which reads as a sticker laid on the photograph
     * on every ordinary plate to buy back the rare one, and the two halves that
     * always land — the dim and the struck caption — carry the state there. THE
     * DARK THEME IS NOT A FACTOR AND IT IS WORTH SAYING WHY: the sheet's palette
     * is fixed light (§1 declares \`--paper\` and \`--ink-strike\` as constants and
     * this file has no \`prefers-color-scheme\` in it); the only token that follows
     * the shell's theme is \`--bench\`, the ground BEHIND the paper, and no mark
     * ever blends against it.
     *
     * (3) REDUCED MOTION covers selectors by name down at the bottom of this
     * sheet, and a new selector is not in that list until it is put there. It is.
     *
     * \`pointer-events: none\` because every gesture on this surface — hover,
     * select, the context menu — is bound on the block, and an overlay that ate
     * them would make a struck picture the one block nobody can restore.
     */
    figure::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image: var(--strike-x);
      background-repeat: no-repeat;
      background-size: 0% 0%;
      mix-blend-mode: multiply;
      transition: background-size var(--t-med) var(--ease);
    }
    .block.struck figure::after { background-size: 100% 100%; }
    .block.struck .body:has(figure) { background-image: none; }

    /* ── §3 Editing: the block IS the editor ─────────────────────────────── */

    /* Spruce, at 7%, with the rail in the same ink — growth, not warning. No
       box, no visible textarea, and no border anywhere: the only sign that this
       paragraph is live is that it is tinted and there is a caret in it. */
    .block.editing .body,
    .block.editing:hover .body { background: color-mix(in srgb, var(--ink-edit) 7%, transparent); }
    .block.editing .rail { opacity: 1; background: var(--ink-edit); }
    /* The one place the sheet's own \`user-select: none\` is lifted, because a
       caret with no selection is an editor nobody can correct a word in. */
    .editor {
      white-space: pre-wrap;
      user-select: text;
      outline: none;
      caret-color: var(--ink-edit);
    }

    .chip {
      top: 0;
      left: 0;
      transform: translateX(calc(-100% - 0.5rem));
      padding: 0.1rem 0.45rem;
      border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      font-size: 10px;
      font-weight: 600;
      font-variant: small-caps;
      letter-spacing: 0.06em;
      white-space: nowrap;
      /* It is a button now, so it undoes the four things a button brings with it
         and takes back the pointer \`.gutter\` turns off. Everything else about it
         — the ink, the hairline, the ground, the small caps — is §3's chip
         unchanged, because it IS §3's chip: what it gained is a click. */
      font-family: inherit;
      color: inherit;
      line-height: inherit;
      cursor: pointer;
      pointer-events: auto;
    }
    .chip:hover { background: var(--paper); border-color: color-mix(in srgb, currentColor 70%, transparent); }
    .chip:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }

    /* §4 — the sienna ordinal beside a note, in the left gutter. */
    .ordinal {
      top: 0.15em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      width: calc(var(--gutter) - 1.8rem);
      text-align: right;
      color: var(--ink-note);
      font-size: 10px;
      line-height: 1.8;
    }

    /* §4 — page ghosts, right gutter. The ≈ is the design: pages are estimates
       and the type says so. */
    .ghost {
      top: 0.15em;
      left: calc(100% + 0.6rem);
      color: color-mix(in srgb, var(--ink-muted) 65%, transparent);
      font-size: 10px;
      font-style: italic;
      line-height: 1.8;
      white-space: nowrap;
      pointer-events: auto;
    }

    /* §4 — the amber flag: a dot until it is asked, a pill naming the problem
       once the pointer arrives. */
    .flag {
      top: 0.45em;
      left: calc(100% + 0.7rem);
      pointer-events: auto;
    }
    .flag::before {
      content: '';
      display: block;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--ink-flag);
    }
    .flag .pill {
      position: absolute;
      top: -0.4em;
      left: 1rem;
      display: block;
      width: max-content;
      max-width: 11rem;
      padding: 0.15rem 0.5rem;
      border: 1px solid color-mix(in srgb, var(--ink-flag) 45%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      color: var(--ink-flag);
      font-size: 10px;
      line-height: 1.5;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .flag:hover .pill { opacity: 1; }

    /* The one permitted outline, keyboard only. */
    .block:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }

    .marquee {
      position: absolute;
      z-index: 2;
      border: 1px solid color-mix(in srgb, var(--ink-select) 55%, transparent);
      background: color-mix(in srgb, var(--ink-select) 12%, transparent);
      pointer-events: none;
    }

    /* ── §4 The peek card — the other half of an apparatus, beside the hand.
       A small sheet of the brighter paper joined to the click by a sienna
       leader; it rides the scroll (sheet coordinates) and never moves it. ── */
    .peek-line { position: absolute; z-index: 3; pointer-events: none; overflow: visible; }
    .peek-line circle { fill: var(--ink-note); }
    .peek-line line {
      stroke: color-mix(in srgb, var(--ink-note) 55%, transparent);
      stroke-width: 1.5;
    }
    .peek {
      position: absolute;
      z-index: 4;
      width: 22rem;
      max-height: 16rem;
      overflow-y: auto;
      padding: 0.6rem 0.85rem 0.7rem;
      border: 1px solid color-mix(in srgb, var(--ink-note) 30%, transparent);
      border-left: 3px solid color-mix(in srgb, var(--ink-note) 65%, transparent);
      border-radius: var(--radius);
      background: var(--paper-high);
      box-shadow: 0 2px 6px rgb(0 0 0 / .18), 0 8px 28px rgb(0 0 0 / .12);
      font-size: 0.85em;
      line-height: 1.5;
      scrollbar-width: thin;
    }
    .peek-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.6rem;
      margin-bottom: 0.35rem;
    }
    .peek-what {
      color: var(--ink-note);
      font-size: 10px;
      font-weight: 600;
      font-variant: small-caps;
      letter-spacing: 0.06em;
    }
    .peek-go {
      border: 0;
      padding: 0;
      background: none;
      color: var(--ink-select);
      font: inherit;
      font-size: 10px;
      cursor: pointer;
    }
    .peek-go:hover { text-decoration: underline; }
    .peek-words { margin: 0; color: var(--ink); }
    .peek-words .marker.plain { color: var(--ink-note); }
    .peek-words .marker.hot {
      background: color-mix(in srgb, var(--ink-note) 35%, transparent);
      border-radius: 0.45em;
    }
    /* The card is honest about a struck counterpart: cancelled there, cancelled here. */
    .peek-words.struck-words {
      opacity: 0.55;
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--ink-strike) 55%, transparent);
    }

    /* ── §2/§4 The type itself ────────────────────────────────────────────── */

    h1, h2 { margin: 1.4em 0 0.8em; line-height: 1.2; font-weight: 600; }
    p { margin: 0; text-indent: 0; }
    .para.indent { text-indent: 1.4em; }
    .para.set-off { text-indent: 0; }
    .caption { margin: 0.4em 0 1em; font-style: italic; text-align: center; }
    blockquote { margin: 0.8em 2.2em; }
    .note { margin-bottom: 0.35em; }

    /* \`relative\` for one reason and it is not layout: it is the containing block
       for the strike mark a struck picture wears, which §3 argues at length. A
       figure has no positioned descendant of its own, so nothing else moves. */
    figure { position: relative; margin: 1em 0; text-align: center; }
    figcaption { margin-top: 0.4em; font-style: italic; }
    .plate {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 8rem;
      border: 1px dashed var(--ink-faint);
      border-radius: var(--radius);
    }
    .plate-page { color: var(--ink-muted); font-size: 10px; font-style: italic; }
    .plate-img { display: block; max-width: 100%; margin: 0 auto; border-radius: var(--radius); }

    /*
     * ── §18c THE GRID, WITH NO RULES DRAWN ──────────────────────────────────
     *
     * NO BORDERS AT ALL — Owen's ruling (2026-08-22, on the Julius Streicher
     * TOC): *"a table generated by dots looks ridiculous with borders."* The
     * model writes a Table block for anything tabular it meets, and what it
     * meets in real books is contents pages, indexes and date lists — set type
     * in columns, which no printer ever ruled. Hairlines made those read as a
     * spreadsheet. Alignment and spacing are what say "table" now, which is
     * how the books themselves say it. The engine's two sheets zero their
     * borders in the same commit, so the bench and the export agree.
     *
     * THE WRAPPER IS THE ONLY THING THAT SCROLLS. A wide table must not widen
     * the paper, because the paper's width is the measure the whole book is set
     * to and the gutters, rails and margin chips are positioned against it.
     */
    .tablewrap { max-width: 100%; margin: 1em 0; overflow-x: auto; }
    table { border-collapse: collapse; margin: 0 auto; }
    td, th {
      padding: 0.28em 0.6em;
      border: none;
      text-align: left;
      vertical-align: top;
    }
    th { font-weight: 600; }
    /*
     * THE REFUSAL SAYS ITSELF IN THE APP'S OWN AMBER, the ink this sheet already
     * uses for "something about this block did not resolve" (\`.flag\`). It is on
     * the paper rather than in a gutter because it is about the words directly
     * under it, and it is deliberately a full sentence: a person who sees a wall
     * of angle brackets should be told that this app looked at them and could
     * not make a table of them, not left to wonder whether it tried.
     */
    .table-refused {
      margin: 0 0 0.5em;
      color: var(--ink-flag);
      font-size: 11px;
      font-style: italic;
      line-height: 1.5;
    }

    /* §4 — an unjoined page turn, drawn where it falls: between the two
       paragraphs, centered, hairline rules either side, and INVISIBLE until
       either neighbour is hovered — the seam is an offer, not a decoration,
       and a page of prose with four permanent captions in it would read as
       damaged. The two selectors below are the two neighbours: the block
       above is the seam's previous sibling, the block below its next. */
    .seam {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0.35rem 0;
      color: var(--ink-muted);
      font-size: 10px;
      font-variant: small-caps;
      letter-spacing: 0.08em;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .seam::before, .seam::after { content: ''; flex: 1; border-top: 1px solid var(--ink-faint); }
    /* It is a button now, so it undoes the things a button brings with it and
       keeps every mark §4 gives the ghost. What it gained is the join. */
    .seam-word {
      padding: 0;
      background: transparent;
      border: none;
      color: inherit;
      font: inherit;
      font-variant: inherit;
      letter-spacing: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    .seam-word:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }
    .block:hover + .seam, .seam:has(+ .block:hover) { opacity: 0.85; }
    /* Reached from the keyboard, the ghost has to be visible to be pressed. */
    .seam:focus-within { opacity: 0.85; }

    /* §4 — a short hairline above the first note of a page's group of them. */
    .notes-rule { width: 4rem; margin: 1.2em 0 0.5em; border-top: 1px solid var(--ink-faint); }

    /* §4 — the chapter rule, carrying its chip. */
    .chapter {
      position: relative;
      margin: 2rem 0 1.25rem;
      border-top: 2px dashed color-mix(in srgb, var(--ink-chapter) 65%, transparent);
    }
    /* The chip and its ✕ ride the rule together: the group carries the
       absolute anchoring the chip used to carry alone, so the ✕ sits beside
       the title wherever the title ends without arithmetic about its width. */
    .chapter-head {
      position: absolute;
      top: -0.8em;
      left: calc(var(--gutter) * -1 + 0.9rem);
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .chapter-chip {
      padding: 0.1rem 0.45rem;
      border: 1px solid color-mix(in srgb, var(--ink-chapter) 45%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      color: var(--ink-chapter);
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      cursor: default;
    }
    /* Being renamed: the same chip with a caret in it and the spruce ground the
       editing block wears one level down. No box and no field — the chip IS the
       field, which is §4's own instruction for this gesture. */
    .chapter-chip.naming {
      background: color-mix(in srgb, var(--ink-edit) 12%, var(--paper-high));
      outline: none;
      caret-color: var(--ink-edit);
      cursor: text;
      user-select: text;
    }
    /* §4 — the rule lifted: the chip in the hand, and the seam it would settle
       into glowing spruce under the pointer. The glow is drawn at the head of
       the block the division would land ABOVE, reaching into the gutters the
       way the rule itself does, and it can only appear where the drop would be
       honoured — never on a block already carrying a division. */
    .chapter-chip.grabbed {
      cursor: grabbing;
      box-shadow: 0 1px 3px rgb(0 0 0 / .25);
      touch-action: none;
    }
    /* The marker's ✕ — quiet until the hand is near the rule, and the space
       held either way so nothing shifts under the pointer on its way to it. */
    .chapter-x {
      padding: 0 0.32rem;
      border: 1px solid color-mix(in srgb, var(--ink-chapter) 45%, transparent);
      border-radius: 999px;
      background: var(--paper-high);
      color: var(--ink-chapter);
      font-size: 10px;
      line-height: 1.5;
      cursor: pointer;
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .chapter:hover .chapter-x, .chapter-x:focus-visible { opacity: 1; }
    .chapter-x:hover { background: color-mix(in srgb, var(--ink-chapter) 12%, var(--paper-high)); }
    .chapter-x:focus-visible { outline: 2px solid var(--ink-select); outline-offset: 2px; }
    .block.drop-target::before {
      content: '';
      position: absolute;
      top: -0.35rem;
      left: -0.9rem;
      right: -0.9rem;
      height: 2px;
      background: color-mix(in srgb, var(--ink-chapter) 35%, transparent);
    }

    /*
     * ── §18b — THE MODEL'S EMPHASIS, SET AS TYPE ─────────────────────────────
     *
     * \`**bold**\` and \`*italic*\` arrive as characters in the block's text and
     * are drawn as the effect (\`cut()\` says why they stay in the file). These
     * two rules are the whole of the treatment, and they are deliberately the
     * PLAINEST possible statement of it: the serif this page is set in has a
     * real bold and a real italic, and asking for anything more here — a tint, a
     * weight of our own choosing — would be the workbench inventing typography
     * the export is not going to use. The finished book gets \`<strong>\` and
     * \`<em>\` from the emitter and lets the reading system set them; the bench
     * says the same thing in the same two words.
     *
     * The selectors are bare so that they land wherever a run does: in the
     * prose, in a caption, in a heading, on a reference number that fell inside
     * an emphasised phrase, and on the peek card, which sets its counterpart
     * with the same pieces.
     */
    .bold { font-weight: 700; }
    .italic { font-style: italic; }

    /* §4 — a reference number is a real element, not a superscript in a string. */
    .marker {
      padding: 0 .18em;
      border-radius: .45em;
      color: var(--ink-note);
      font-size: 0.75em;
      line-height: 0;
      vertical-align: super;
      cursor: default;
      transition: background var(--t-fast) var(--ease);
    }
    .marker:hover { box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--ink-note) 55%, transparent); }
    .marker.lit { background: color-mix(in srgb, var(--ink-note) 30%, transparent); }
    .marker.unlinked {
      color: var(--ink-flag);
      text-decoration: underline dotted var(--ink-flag);
      text-underline-offset: 0.2em;
    }
    /*
     * §4 — "Deleting a note strikes its markers with it — derived, animated
     * together." The number goes with the note because it BELONGS to the note,
     * and it is cancelled in the same iron red the block wears rather than
     * removed, for the same reason the block is: struck is a state, and the
     * reader has to be able to see what they took out.
     */
    .marker.struck {
      opacity: 0.45;
      text-decoration: line-through;
      text-decoration-color: color-mix(in srgb, var(--ink-strike) 55%, transparent);
      transition: opacity var(--t-med) var(--ease);
    }

    /* ── The one verb on this surface, on the bench beside the paper ──────── */

    .tray {
      position: sticky;
      z-index: 3;
      bottom: 0;
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      width: min(46rem, 92%);
      margin: 0 auto;
      padding: 0.75rem 0;
      pointer-events: none;
    }
    /* The app's own act, in the app's own dark tokens — the shell's language,
       because a button is the shell's furniture and not the paper's. */
    .act {
      padding: 5px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-family: inherit;
      font-size: 11px;
      white-space: nowrap;
      cursor: pointer;
      pointer-events: auto;
    }
    .act:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .act:disabled { opacity: 0.4; cursor: default; }
    .act.ghost { background: transparent; color: var(--text-secondary); }

    /* ── The obvious Apply, at the head of the pane ────────────────────────
       The app's own filled-accent verb (the capture editor's \`.btn.primary\`
       is where that pairing is settled: accent ground, inverse ink, 600) at
       this row's size rather than that column's. \`margin-right: auto\` puts
       it at the LEFT end of a row whose other children are flushed right —
       the verb and the facts do not sit in one cluster, and nothing has to be
       re-ordered in the template to say so.

       NO :disabled RULE OF ITS OWN. It is drawn only while there is something
       to apply, so the only moment it can be disabled is the second an Apply
       is in flight, and \`.act:disabled\`'s fade already says that. */
    .act.now {
      margin-right: auto;
      background: var(--accent);
      border-color: var(--accent);
      color: var(--text-inverse);
      font-weight: 600;
    }
    .act.now:hover:not(:disabled) {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }

    /* ── §5 The register, at the head of the column the tray closes ────────── */

    /* The tray's measure without the tray's stickiness: the head stands
       OUTSIDE the scroller now (the template's own comment carries the
       ruling), a row of the host's column above the pair, so \`position\`
       goes back to static and the paper below cannot pass under it.
       \`.tray.head\`, not \`.head\`: the un-sticking must win by SPECIFICITY,
       not by being typed after \`.tray\` -- source order is not a place to
       keep an intention. */
    .tray.head { position: static; flex: 0 0 auto; padding: 0.75rem 0; }

    /* Two acts made one control: the seam between them is a shared hairline
       (the second pulled back a pixel onto the first's border) and only the
       outer corners are rounded, so the pair reads as one segmented thing
       rather than as two buttons that happen to be adjacent. */
    .segments { display: flex; pointer-events: auto; }
    .segment { border-radius: 0; }
    .segment:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
    .segment:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; margin-left: -1px; }
    /* The one in force wears the app's own "this is live" ground — \`.act\`'s
       hover state, held — and the other stands back in the secondary ink. No new
       colour is stated: both are the shell's tokens, which is what keeps this
       control the shell's furniture. */
    .segment:not(.on) { background: transparent; color: var(--text-secondary); }
    .segment.on { z-index: 1; background: var(--bg-hover); border-color: var(--border-strong); }
    .segment:focus-visible { z-index: 1; outline: 2px solid var(--ink-select); outline-offset: 2px; }
    /* Refused, not disabled — see the control's own comment in the template. It
       wears \`.act:disabled\`'s own fade and keeps the pointer, because pressing it
       is how the sentence gets said out loud. */
    .segment[aria-disabled='true'] { opacity: 0.4; }

    /* The app's small menu, copied from open-documents — one vocabulary for
       one kind of thing, and the scrim is what makes the next click dismiss it
       exactly once. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 180px;
      max-height: 60vh;
      overflow: hidden auto;
      padding: 4px;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-family: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
    .menu button.current { color: var(--text-primary); }
    /* The swatch is what settles the two close pairs — see shared/categories.ts,
       which is the ONE table these colours come from. */
    .swatch { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 2px; }

    /* ── §0/§5 THE EDITION — the export's own sheet, transcribed ──────────────
     *
     * The numbers below are \`STYLESHEET_BASE\` and \`dotsStylesheet\`
     * (src/vlm/dots-book.ts), copied rather than imported, on the \`BASE_RATIO\`
     * precedent at the top of this file: the app and the engine are two programs
     * and the app's mirror of the engine lives in \`shared/\`, so a stylesheet the
     * engine writes into an EPUB is transcribed here with its source named.
     *
     *   body       { margin: 0 5%; line-height: 1.5; }
     *   p          { margin: 0 0 0.4em; text-indent: 1.4em; }
     *   sup        { font-size: 0.75em; line-height: 0; vertical-align: super; }
     *   .footnotes { font-size: 0.85em; margin-top: 2em; }
     *   .footnotes .footnote { text-indent: 0; margin-bottom: 0.5em; }
     *
     * TWO THINGS THE CAST'S SHEET DOES NOT SAY are left where the paper already
     * had them. It names NO FONT FAMILY anywhere — *"still no point sizes and
     * still no font families"* — because in a reader the family is the reader's;
     * on a screen it has to be something, and the something is §2's serif stack,
     * which is the book's voice in this app. And the per-category SIZES are not
     * here because they are already on the blocks: \`line.size\` is the measured
     * ratio, and \`dotsStylesheet\` writes those very ratios into the cast.
     *
     * These rules sit LAST so that the ones they must beat — the hover tint, the
     * selected rail — are beaten on specificity AND on order, and neither of
     * those two things has to be true on its own.
     */
    .bench.edition .sheet {
      /* The cast's own margin is 0 5%, and the first draft of this sheet took
         it — which read as the preview NARROWING against the bench for no
         reason a reader could see (user ruling, 2026-08-16: the preview keeps
         the workbench's measure). The gutters hold; what says "finished" is
         everything else: the chrome gone, the leading, the collected notes. */
      line-height: 1.5;
      /* The marquee is what turned the browser's own selection off (§3), and
         there is no marquee here. A preview somebody can take a sentence out of
         is a preview doing its job. */
      user-select: text;
    }
    /* Every tint the bench paints is a state of an instrument: hover, selection,
       the note that is lit, the block a jump landed on. */
    .bench.edition .block .body { background: transparent; }
    .bench.edition .block .rail { opacity: 0; }
    .bench.edition .para { margin-bottom: 0.4em; }
    .bench.edition .note { margin-bottom: 0.5em; }
    /* The cast opens the apparatus with a bare \`<hr/>\` across the column under
       \`.footnotes { margin-top: 2em; }\` — not §4's 4rem hairline, which is a
       page-group's mark on the bench. */
    .bench.edition .notes-rule { width: 100%; margin: 2em 0 0.5em; }
    /* The break a new chapter makes. The cast writes no page-break rule and does
       not need one — each chapter is its own document in the spine, and a reader
       turns the page because the file ended. This sheet never ends, and the
       first translation of that boundary was air alone: 3.5rem of it. Air only
       says "break" when you can see both sides of it at once, and a chapter that
       happens to open mid-viewport opens with no announcement whatever. So the
       edition prints the device paper has always used for the same problem — a
       short centred rule, neutral, sitting in the middle of the air rather than
       on top of the words. \`--ink-faint\` is the paper's own hairline, the one
       §4 gives the notes rule and the page seam; the chapter rule's green is an
       instrument's mark and has no business on a finished book. */
    .bench.edition .block.opens { margin-top: 3.5rem; }
    .bench.edition .block.opens::before {
      content: '';
      position: absolute;
      top: -1.75rem;
      left: 50%;
      width: 4.5rem;
      transform: translateX(-50%);
      border-top: 1px solid var(--ink-faint);
    }
    .bench.edition .division { margin-top: 3.5rem; }
    /* Where the division draws its own \`h1\`, the heading IS the announcement and
       the block below it is just the chapter starting — so the air closes and
       the rule goes with it, exactly as the margin rule beside it already did. */
    .bench.edition .division + .block.opens { margin-top: 0; }
    .bench.edition .division + .block.opens::before { content: none; }
    /* \`sup\`, verbatim — and it is the same rule \`.marker\` already wears, because
       §4 built the bench's marker out of the cast's superscript to begin with. */
    .ref { font-size: 0.75em; line-height: 0; vertical-align: super; }

    /* ── §6 Motion. The states must read perfectly as stills. ─────────────── */

    /*
     * THE STRUCK BLOCKS DO NOT COLLAPSE, AND THIS IS WHERE THAT WAS SETTLED.
     * *"struck blocks collapse (height animates to 0)"* — §5 — and *"things
     * that leave the document collapse"* — §6 — and the collapse is gone,
     * because of what it cost to ask for it.
     *
     * The rule was a keyframe on a class the framework hands each leaving
     * element, which reads as free and is not. To know when a node may finally
     * go, the leave machinery interrogates that node — its running animations,
     * its computed style — one node at a time, interleaved with the class it
     * has just written to it. That is a forced style pass per departure. And
     * nothing removes struck rows but the register flip, which removes ALL of
     * them: four hundred forced passes in one repaint, over a sheet whose
     * bodies are under \`content-visibility: auto\` and must be laid out again to
     * answer at all. Measured in isolation it was 150× a plain removal; on the
     * real book it froze the flip for something near half a minute. Reduced
     * motion buys none of it back — \`animation: none\` is still a style the pass
     * has to stop and read.
     *
     * So the flip's motion is the motion §5 already pays for: the crossfade on
     * the sheet, where the gutters close to the cast's margin and the leading
     * opens to 1.5, both over \`--t-med\`. That is one element's transition
     * whatever the book's length, and underneath it the struck blocks are
     * simply not in the list on the next frame — which is the state the still
     * has to read as, and the state it reads as.
     *
     * A merge and a cut are unchanged: they never had an animation to wait for,
     * and \`join\` says why the words carry their own result.
     */

    @media (prefers-reduced-motion: reduce) {
      /* BY NAME, WHICH IS WHY A NEW SELECTOR HAS TO BE ADDED HERE RATHER THAN
         INHERITING THE INTENT. \`figure::after\` is the struck picture's mark and
         is the newest of them; it is listed once, on the rule that declares the
         transition, so both of its states are covered. */
      .body, .rail, .marker, .flag .pill, .seam, .sheet,
      .block.struck .body, .marker.struck, figure::after { transition-duration: 0ms; }
    }
  `],
})
export class BookViewComponent {
  readonly tab = input.required<Tab>();
  /**
   * THE STEP THIS VIEWER IS LOCKED TO, or null for the ordinary case — the
   * position.
   *
   * Compare's one wire into this component (docs/PLAN.md §4, unit 8d). Set, it
   * changes exactly three things and nothing else: the book is read through
   * `book:load-at` for the named row instead of `book:load` for the pointer,
   * `viewing()` goes true so the whole read-only projection the export view has
   * used for months applies, and no stack is registered — see each of the three.
   *
   * IT IS AN INPUT AND NOT A FLAG ON THE TAB, because a compare column's tab is
   * synthetic (`CompareColumnComponent`) and `Tab` is the shape of a document the
   * window HAS OPEN. Putting a step id on it would make every real tab carry a
   * field that is meaningless for it, and would invite something in the documents
   * service to start meaning something by it.
   */
  readonly atStep = input<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly stacks = inject(BookStacksService);
  private readonly notices = inject(NoticeService);
  private readonly ledger = inject(LedgerService);
  /** For `afterNextRender` from an event handler — see `edit`. */
  private readonly injector = inject(Injector);

  private readonly book = signal<BookLoad | null>(null);
  protected readonly loading = signal(true);
  protected readonly problem = signal<string | null>(null);

  /**
   * WHAT AN OLD SAVE ON THIS PATH DECIDED AND THIS BOOK HAS NOWHERE TO PUT.
   *
   * Empty for every project made under the op grammar. A `curate` step froze its
   * decisions in the coordinates the bank uses, and they are re-keyed onto block
   * ids when the book is opened; the handful that cannot be placed come back as
   * sentences (`BookLoad.unplaced`). They are drawn ON THE PAPER rather than
   * pushed to the notice strip, because the strip is for what a gesture would not
   * do and this is a standing fact about the book in front of the person — it is
   * true for as long as they stand on that row, and a strip that said it once
   * would have said it to somebody who was still reading the title.
   */
  protected readonly unplaced = computed<readonly string[]>(() => this.book()?.unplaced ?? []);

  /** The blocks the user has picked. Purely visual, and purely this pane's. */
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  /** The note whose apparatus is under the pointer — it and its markers light together. */
  protected readonly lit = signal<string | null>(null);
  /**
   * ── The glance: the original's page, beside the block that was clicked ─────
   *
   * `glanced` is the ROW and `glanceAt`/`glanceLeft` are where its card goes,
   * kept apart deliberately: the card re-renders a PDF page when the row
   * changes and only MOVES when the place changes, so a single signal holding
   * both would make every reposition a re-render. ./page-glance's one effect
   * reads the first and not the others, which is what that split is for — and
   * it is what makes the resize recompute below free.
   *
   * ALL THREE GO NULL ON DISMISSAL AND THE CARD STAYS MOUNTED. A null row is
   * how this pane says "show nothing" — see the mount above for what putting
   * the card up and taking it down cost, and why saving a re-render meant
   * nothing while the whole component was being rebuilt between glances.
   *
   * `glanceLeft` IS THE SIDE OF THE PAPER THE CARD STANDS ON: a number of
   * sheet-pixels when it fits in the bench beside the paper, null when it does
   * not and the card falls back to the right margin it has always used. See
   * `beside` for the arithmetic and the mount for how one property does both.
   */
  protected readonly glanced = signal<BookRow | null>(null);
  protected readonly glanceAt = signal<number | null>(null);
  protected readonly glanceLeft = signal<number | null>(null);
  /**
   * The card itself, for its WIDTH and for the paper it is a child of.
   *
   * MEASURED AND NEVER MIRRORED, which is the one lesson Wave 23 paid for twice.
   * The card's width is declared once, in rem, in the file that draws it; the
   * first attempt at placing it beside a block kept a `px` copy of that width
   * over here, the app's root font is 13px, so the copy said 256 about a box
   * that renders at 195 — and the card landed on the paragraph being read. A
   * reading of the element cannot disagree with the element.
   *
   * `read: ElementRef` IS THE FIX FOR A CARD THAT NEVER APPEARED AT ALL.
   * `#glance` stands on a COMPONENT, and a query on a component ref answers
   * with the component instance unless told to read the element — the generic
   * on this line is a type assertion the runtime never sees, so without the
   * option `nativeElement` was undefined, every placement failed its first
   * test, and `aimGlance`'s "a card that cannot be placed is not shown" rule
   * dismissed the card on every click of every session. The gates cannot catch
   * it: it typechecks perfectly, and only a hand on a block finds the silence.
   */
  private readonly glanceCard = viewChild('glance', { read: ElementRef<HTMLElement> });
  /**
   * THE SCAN THIS BOOK WAS READ OFF, or null for a book with no paper behind it.
   * Read straight off the load rather than resolved here — `BookLoad.originalPath`
   * carries the whole argument for what null means and why it means it twice.
   */
  protected readonly original = computed<string | null>(() => this.book()?.originalPath ?? null);
  /*
   * A SECOND SIGNAL STOOD HERE (Wave 41's gravestone) for `originalPages`, the
   * folder of photographed pages a captured book was read off. A captured book's
   * original IS a PDF now, so `original` above answers for it and the glance
   * card's pdf face draws the page — which is what the second field was holding
   * a place for and never got.
   */
  /** The block a jump landed on, tinted for `PULSE_MS`. */
  protected readonly pulse = signal<string | null>(null);
  /** The source page a hovered ghost names, hairlining every block it spans. */
  protected readonly ghosted = signal<number | null>(null);
  /** The rectangle being dragged, in the sheet's own coordinates. */
  protected readonly marquee =
    signal<{ left: number; top: number; width: number; height: number } | null>(null);

  /**
   * THE STACK — everything decided since the last Apply, oldest first.
   *
   * A LIFO the app works out of (docs/RENDERER.md §0, ruling 5). Undo pops the
   * last one onto `undone`; redo puts it back; Apply writes the whole list as a
   * step and empties both.
   *
   * IT USED TO BE "IN MEMORY AND NOWHERE ELSE", and closing scrapped it. That
   * ruling was reversed on 2026-08-22 after a real project lost real work to it:
   * every gesture below also hands the difference to `rememberPending`, which
   * writes it to the project's sidecar on a debounce, and `load` puts it back. The
   * list is still the only thing anything DRAWS from and still the only thing undo
   * touches — the sidecar is a copy that catches the window falling over, not a
   * second account of the book.
   *
   * IT IS A SIGNAL BECAUSE THE VIEW IS A FUNCTION OF IT. Every gesture on this
   * surface ends as a push here, and the sheet is `replayOps` over the chain and
   * this list — so a push repaints the book and there is no second place where a
   * change is also applied by hand.
   */
  protected readonly pending = signal<readonly BookOp[]>([]);

  /**
   * The tip step's ops as the last load (or the last Apply) recorded them — the
   * disk's side of `waiting()`'s comparison. Empty when the position has no
   * amendable tip, which makes the old arithmetic fall out: nothing landed, so
   * everything pending is waiting.
   */
  private readonly landedOps = signal<readonly BookOp[]>([]);
  /** What undo has taken off the stack, newest last. Cleared by any new gesture. */
  private readonly undone = signal<readonly BookOp[]>([]);
  /** True while `book:apply` is in flight, so the button cannot be pressed twice. */
  protected readonly applying = signal(false);

  /** The block being retyped, or null. Exactly one at a time, by construction. */
  protected readonly editingId = signal<string | null>(null);

  /**
   * The block whose chapter chip is being renamed, or null.
   *
   * A SECOND SIGNAL AND NOT A MODE OF THE FIRST. `editingId` is a caret in the
   * BOOK's words and this is a caret in a division's name; they are two different
   * things being typed into, they commit through different doors and Enter means
   * something different in each (a cut, and a name). One signal serving both would
   * be a state that has to be asked what it is about before it can be read.
   */
  protected readonly renaming = signal<string | null>(null);

  /** The category list, open over a block's chip. */
  protected readonly menu = signal<{ id: string; category: string; x: number; y: number } | null>(null);

  /** The categories the chip's list offers — the ONE table, in the engine's order. */
  protected readonly categories = PDF_BLOCK_CATEGORIES;

  /**
   * WHICH OF THE TWO REGISTERS IS ON SCREEN — the bench, or the edition.
   *
   * ── IT IS NOT REMEMBERED, AND THAT IS THE RULING ────────────────────────────
   *
   * Nothing writes this down: not the project file, not the window's layout, not
   * a step. Opening a book opens it on the bench, and so does moving to another
   * step, because a preview is a GLANCE and not a state of the project — the
   * person went to look at what the export will do and then came back to work. A
   * mode that survived a reload would mean somebody could open a book they have
   * decisions waiting on and be handed a page with no gutters, no chips and no
   * Apply, with nothing on screen saying why. `load` puts it back for exactly
   * that reason.
   *
   * IT IS ALSO NOT AN OP AND NOT IN THE UNDO STACK, on the selection's own rule:
   * it is a fact about this pane and about nothing in the book.
   */
  protected readonly mode = signal<'workbench' | 'edition'>('workbench');
  /** Read all over the template and the guards — the mode, asked as a question. */
  protected readonly edition = computed(() => this.mode() === 'edition');

  /**
   * A TAB THAT SHOWS A FINISHED EXPORT — the sheet locked to the Final version
   * register over an exploded copy of the file (user ruling, 2026-08-16:
   * left-click opens it, Ctrl+S saves a copy). Nothing about it is a position:
   * no stack, no Apply, no register toggle, and every door that would edit
   * says where editing lives instead.
   */
  protected readonly viewing = computed(() =>
    this.tab().viewOnly === true || this.atStep() !== null);

  /**
   * WHETHER THE SOURCE STANDS BESIDE THE TRANSLATION — the second control, and
   * the one that is not a register.
   *
   * NOT REMEMBERED, on `mode`'s ruling and for its reason: a book opens with one
   * column and so does moving to another step, because two columns are a way of
   * READING this book rather than a fact about it. `load` puts it back.
   *
   * WHAT IS ON SCREEN IS `aligned()` BELOW AND NOT THIS. This is what the person
   * asked for; that is what the pane can honestly give them, which also depends on
   * there being a source to show, room to show it in, and a register that has two
   * columns to give. The template reads only the second, so the segment that looks
   * pressed and the sheet that is drawn cannot come apart.
   */
  private readonly alignment = signal<'alone' | 'aligned'>('alone');

  /** The translation this position stands under, or null — main's own walk. */
  protected readonly translation = computed(() => this.book()?.translation ?? null);

  /**
   * WHAT THAT PASS IS CALLED — "translation" or "simplification", the one noun
   * every sentence about the pair uses.
   *
   * A simplify is a translate step carrying a mode (shared/types.ts,
   * `RewriteMode`), which is what let this pane draw the aligned view for one
   * without being told about it — and is exactly why the copy was wrong: three
   * sentences said "translation" to somebody who had pressed Simplify, and being
   * told your own act was a different act is worse than being told nothing.
   *
   * READ ONLY WHERE THERE IS A PASS. Every string built from this is drawn under
   * `translation() !== null`, so the null case is not a state anything says out
   * loud; it is a computed nobody reads on a book in its own language.
   */
  protected readonly pass = computed<'translation' | 'simplification'>(() =>
    this.translation()?.rewrite === undefined ? 'translation' : 'simplification');

  /**
   * The pane's own width and the root's font size, in pixels, measured.
   *
   * NEITHER IS ASSUMED. The width comes from a `ResizeObserver` on this host —
   * the pane is a pane in a window with panels either side of it, so the window's
   * width is not this surface's width and never was — and the rem comes from the
   * document's own computed style. Both start at zero, which reads as "not
   * measured yet" and makes the aligned view unavailable until the first frame
   * has been through: an availability answered before anything has been laid out
   * would be an answer about nothing.
   */
  private readonly wide = signal(0);
  private readonly rem = signal(0);

  /** True when two sheets fit — `ALIGNED_MIN_REM`, against the measured pane. */
  private readonly roomy = computed(() => {
    const rem = this.rem();
    return rem > 0 && this.wide() >= ALIGNED_MIN_REM * rem;
  });

  /**
   * Why the aligned view cannot be had right now, or null when it can.
   *
   * ONE SENTENCE, TWO DOORS: the pointer that pauses on the segment gets it as a
   * title, and a press gets it on the window's notice strip. The control is only
   * on screen at all where there IS a translation, so "this book is not a
   * translation" is not one of the answers here — it is the absence of the
   * control, which is the plainest statement of it available.
   */
  protected readonly alignRefusal = computed<string | null>(() => {
    if (this.edition()) {
      return 'The final version is the finished book, and a finished book has one column. Press Workbench '
        + 'and the source can stand beside these words.';
    }
    if (!this.roomy()) {
      return 'There is not room here for two columns of book. Widen the window and the source can '
        + `stand beside the ${this.pass()}.`;
    }
    return null;
  });

  /**
   * THE AGREED ANSWER — two columns, or one.
   *
   * Derived rather than stored, so that narrowing the window takes the second
   * column away and widening it brings the same one back without a state anywhere
   * that has to be corrected on the way. Switching to the edition is the one
   * transition that changes what was ASKED FOR (`show` puts the alignment back to
   * alone), because the edition is not a place a person was reading a pair in.
   */
  protected readonly aligned = computed(() =>
    this.alignment() === 'aligned'
    && this.translation() !== null
    && this.roomy()
    && !this.edition());

  /**
   * The id under the pointer in EITHER column, lighting its twin in the other.
   *
   * A signal of its own and not a mode of `lit`. `lit` is a NOTE and its printed
   * numbers — one fact about apparatus, drawn in the sienna the apparatus wears —
   * and this is one block and the same block on the other sheet. Two questions,
   * two answers, and a marker hover must not tint a paragraph across the gap.
   */
  protected readonly twinned = signal<string | null>(null);

  /** True while a correction is in flight — one paragraph at a time, per gesture. */
  private correcting = false;

  /**
   * Which load is the current one.
   *
   * A pane can be pointed at another project before the first answer arrives —
   * and a book file that has to be MADE first takes seconds. Without the ticket
   * the slower of two answers would land last and put one project's blocks under
   * another project's name.
   */
  private asked = 0;

  /**
   * The pointer gesture in flight: where it started, and on what.
   *
   * WHAT WAS UNDER THE PRESS IS RECORDED HERE AND ACTED ON AT `release`, and
   * there is not a `(click)` binding anywhere on this sheet. The marquee takes
   * POINTER CAPTURE so that a drag survives leaving the paper, and a captured
   * pointer retargets the compatibility mouse events with it — so a `click` on a
   * note marker would arrive at the sheet with no idea which marker it had been.
   * One gesture, decided in one place, from what the press actually landed on.
   */
  private pressed: {
    x: number;
    y: number;
    /** The block the press landed in, or null for the paper between them. */
    id: string | null;
    /**
     * THE ANCHOR, IN SHEET COORDINATES — where on the PAPER the press landed,
     * not where on the screen. The first marquee stored only client coordinates,
     * and a wheel-scroll mid-drag moved the paper under a screen point that
     * stayed put: the rectangle's origin drifted with the scroll and everything
     * scrolled past fell out of the sweep (user report, 2026-08-16). Pinned to
     * the sheet, the origin is the paragraph the hand started at, wherever the
     * scrollbar has since taken it.
     */
    sheetX: number;
    sheetY: number;
    /** The pointer's last known place, so a scroll can re-run the sweep. */
    lastX: number;
    lastY: number;
    /** The sheet the marquee is being drawn on, for the scroll re-sweep. */
    sheet: HTMLElement | null;
    /** True when it landed on a reference number rather than on words. */
    onMarker: boolean;
    /** The note that number belongs to, or null when nothing carries it. */
    note: string | null;
    /** Where this block jumps to when it is clicked — a note's first marker. */
    jump: string | null;
    extend: boolean;
    /** Alt was down: the press asks for every block of this one's category. */
    similar: boolean;
    base: ReadonlySet<string>;
    dragging: boolean;
  } | null = null;

  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  /** The jump's glide in flight, or null — so a second jump replaces the first. */
  private gliding: number | null = null;

  /**
   * THE PEEK — which counterpart is on the card, and where the card sits.
   *
   * Raw geometry in SHEET coordinates, decided once at the click (`peekAt`) so
   * the card and its leader ride the scroll like any other ink on the paper —
   * the whole point of the card is that the scrollbar is the reader's and a
   * click must not move it. `from` is the NOTE the pair belongs to, whichever
   * half was clicked, so the card can light that note's own number inside the
   * paragraph it shows. Cleared by any press on the paper, by Escape, by a mode
   * change and by travel — a card is a glance, not a state of the pane.
   */
  protected readonly peek = signal<{
    target: string;
    from: string | null;
    x: number;
    y: number;
    line: { left: number; top: number; width: number; height: number;
      x1: number; y1: number; x2: number; y2: number };
  } | null>(null);

  /**
   * True between a successful Apply and the reload it causes — the one thing
   * that tells the two reasons for a reload apart.
   *
   * ── Why the stack is NOT cleared the instant main answers ──────────────────
   *
   * Because the answer is not the reload. Main lands the step and moves the
   * pointer; the history is adopted, the position effect notices, the tab's
   * revision moves and `load` runs — three turns later, in Angular's own time.
   * Clearing the ops on the answer would leave the sheet drawing the OLD chain
   * with an empty stack over it for those three turns, which is the book without
   * the changes somebody just applied: a flash of the unedited document, at the
   * exact moment they are looking for confirmation that it worked. So the stack
   * stands until the chain that replaces it has arrived.
   *
   * Which leaves `load` unable to tell "these were just written down" from "you
   * stepped away and let them go", and both clear the same list. This is the
   * difference, held for one round trip and spent by the first load that sees it.
   * A boolean rather than the ids, because the question is which of two things
   * happened and not which ops were involved.
   */
  private landed = false;

  constructor() {
    effect(() => {
      const dir = this.tab().path;
      /*
       * AND THE REVISION, which is what makes a pointer move reach this pane. The
       * tab's path is the PROJECT directory and never changes; what changes when
       * somebody clicks a row in Steps is which book `book:load` would answer with
       * — a different reading, or the same reading with a different chain of
       * applied changes over it. `PositionSyncService.showBook` bumps this on a genuine
       * position move and on nothing else, which is what keeps clicking the row you
       * are already standing on free.
       */
      this.tab().revision;
      /*
       * AND THE COMPARED STEP, which is the same fact one door along. A compare
       * column's tab never moves — its path is the project and its revision is
       * frozen at zero — so `atStep` is the only thing that says which book this
       * instance is about, and picking a second row without leaving compare mode
       * has to reach the load. Reading it HERE rather than only inside `load` is
       * what makes that true of the component rather than of the way its host
       * happens to be written: the compare column does destroy and rebuild this
       * viewer between steps today, and a correctness that depends on somebody
       * else's re-render is a correctness that ends the day they optimise it.
       */
      this.atStep();
      // Untracked, because the load writes the signals this component draws from,
      // and an effect that reads its own writes is a loop waiting for a disk.
      untracked(() => void this.load(dir));
    });

    /*
     * THE STACK, ANNOUNCED — see `BookStack` (core/book-stacks.service.ts) for the whole
     * argument. Four things outside this pane need it now: the undo chord, which
     * main swallows as a menu accelerator and the window routes; the closing
     * question, asked once per tab about everything closing costs; and the Notes,
     * Furniture and Chapters panels, which are drawn in the shell out of the very
     * replay the paper draws and push their ops onto this very list.
     *
     * WHAT CROSSES IS THIS PANE'S OWN SIGNALS, called rather than copied. A panel
     * reading `view()` inside a computed depends on the same graph the sheet does,
     * so the panel and the paper cannot come to different conclusions about what
     * this book says — there is nothing to keep in step, because there is only one
     * of it.
     */
    /*
     * ── MORE THAN ONE BLOCK CHOSEN PUTS THE CARD DOWN ─────────────────────────
     *
     * *"if multiple blocks are selected, it should not show at all."* `release`
     * already refuses to SUMMON the card from a selection-building click, and
     * this is the backstop for every other door into a many-block selection: the
     * marquee (which sets `chosen` on the way and never reaches `release`'s
     * branches), a split that hands back both halves, a join, a panel reaching in
     * through the stack. There are a dozen writers of `chosen` and there will be
     * more; there is one reader of it here.
     *
     * IT CLEARS RATHER THAN MASKS, and that asymmetry is the ruling and not an
     * oversight. A computed that hid the card while the count was high would
     * bring it back the moment the count fell — so undoing a marquee would
     * resurrect a card aimed at a paragraph the reader clicked ten gestures ago,
     * out of nowhere, with nothing having been clicked. The card answers a click.
     * Only a click puts it up.
     */
    effect(() => {
      const many = this.chosen().size > 1;
      untracked(() => { if (many) this.dismissGlance(); });
    });

    const stacks = this.stacks;
    const stack: BookStack = {
      pending: () => this.waiting(),
      canUndo: () => this.pending().length > 0,
      canRedo: () => this.undone().length > 0,
      undo: () => this.undo(),
      redo: () => this.redo(),
      apply: () => this.apply(),
      discard: () => this.discardStack(),
      view: () => this.view(),
      selected: () => this.chosen(),
      chaptersOwned: () => this.chaptersOwned(),
      push: (ops) => this.push(...ops),
      /*
       * THE TRANSLATED PASS'S TWO MEMBERS, AND THEY ARE THE PANE'S OWN.
       *
       * `correct` is the private method the double-click editor commits through,
       * handed out rather than reimplemented: the one-in-flight guard, the load
       * ticket and the book refresh are all inside it, and the sweep landing
       * fifty corrections in a row must obey exactly the rules one hand-typed
       * paragraph obeys. `translated` is the question that decides which of the
       * two doors an outside surface should be taking in the first place.
       */
      translated: () => this.translation() !== null,
      correct: (id, text) => this.correct(id, text),
      reveal: (id) => this.scrollTo(id),
    };
    /*
     * IN AN EFFECT AND NOT ON THIS LINE, because a required input has no value
     * until the first change detection and the constructor runs before it. The
     * effect also happens to make the registration correct rather than merely
     * legal: a pane pointed at another tab lets go of the first id before it
     * claims the second, so no stack is ever answered for by a pane that has
     * stopped being about it.
     */
    let registered: string | null = null;
    effect(() => {
      const id = this.tab().id;
      /*
       * A COMPARED COLUMN REGISTERS NOTHING. The registry answers "which book
       * viewer is in this tab" for the undo chord and the closing question, and a
       * compare column is neither: it has no tab in the list to be closed, and
       * Ctrl+Z means the document in front of the person, which is the OTHER
       * column. Registering under a synthetic id would put an entry in the map
       * that nothing can reach and that a future reader would have to work out is
       * unreachable.
       */
      if (this.atStep() !== null) return;
      untracked(() => {
        if (registered === id) return;
        if (registered !== null) stacks.releaseBookStack(registered);
        stacks.registerBookStack(id, stack);
        registered = id;
      });
    });
    const destroy = inject(DestroyRef);
    destroy.onDestroy(() => {
      if (registered !== null) stacks.releaseBookStack(registered);
      /*
       * UNWRITTEN WORK RIDES THE TAB, NOT THE COMPONENT. This pane dies every
       * time its pane shows another tab — a glance at the scan — and the stack
       * used to die with it (user report, 2026-08-16). Anything not yet on
       * disk (a differing stack, or a redo pile that could put ops back) is
       * parked with the tab and claimed by the next incarnation; `load` decides
       * whether it still applies. Nothing is parked when everything is
       * recorded, so the map stays the size of the abandoned work.
       */
      /*
       * AND NOT AFTER AN APPLY THAT HAS NOT COME BACK YET. `landed` is true
       * between a successful `book:apply` and the reload it causes (see its own
       * comment), and in that gap the stack still LOOKS unwritten: the ops are
       * still on `pending` and `landedOps` is still empty, because clearing
       * either one early would flash the unedited book. Closing the tab in that
       * gap — which is exactly what the closing card's Apply does — used to leave
       * a parked entry for a tab that no longer exists, which was a harmless leak
       * in a map. It stopped being harmless when parking began flushing to the
       * sidecar: the file would come back holding decisions main had just
       * recorded as a step, and the next open would offer them again as a delta
       * against a book that already has them.
       */
      if (registered !== null && !this.landed
        && (this.waiting() > 0 || this.undone().length > 0)) {
        stacks.parkBookStack(registered, {
          revision: this.tab().revision,
          landed: this.landedOps(),
          pending: this.pending(),
          undone: this.undone(),
        });
      }
    });

    /*
     * ── HOW WIDE THIS PANE IS, MEASURED, BECAUSE NOTHING ELSE KNOWS ───────────
     *
     * The aligned view is unavailable below a bench two sheets cannot breathe in
     * (`ALIGNED_MIN_REM`), and the only honest source for that number is this
     * element: the window holds a left nav, an inspector and a tab strip, every
     * one of which can be opened and shut, so a media query on the window would
     * answer for a width this surface never had. A `ResizeObserver` is one
     * observer for the life of the pane and it fires when the pane's box changes
     * for ANY of those reasons.
     *
     * The rem is read once, here, rather than per resize: it is the document's
     * font size and nothing in this app changes it while a window is open. Zero
     * until this runs, which is what makes the toggle refuse rather than guess
     * before anything has been laid out.
     */
    afterNextRender(() => {
      const root = getComputedStyle(document.documentElement).fontSize;
      const rem = Number.parseFloat(root);
      if (Number.isFinite(rem) && rem > 0) this.rem.set(rem);
      const watch = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box !== undefined) this.wide.set(box.width);
        /*
         * AND THE GLANCE IS RE-PLACED HERE RATHER THAN ON `window:resize`, for
         * the same reason this observer exists at all: the dead space beside the
         * paper is a fact about THIS PANE, and it changes when the left nav or
         * the inspector opens without the window moving a pixel. A card that
         * fitted outside the paper and no longer does has to come back in, and a
         * window listener would have watched the wrong box.
         *
         * Nothing happens when no card is up, which is nearly always — and when
         * one is, only the two placement signals are written. The ROW is
         * untouched, so ./page-glance's one effect does not run and no page is
         * re-rendered by dragging a window edge.
         */
        const at = untracked(() => this.glanced());
        if (at !== null) this.placeGlance(at.id);
      });
      watch.observe(this.host.nativeElement);
      destroy.onDestroy(() => watch.disconnect());
    });

    /*
     * ── THE SCROLL LOCK'S LISTENERS, AND WHY THEY ARE NOT TEMPLATE BINDINGS ───
     *
     * An Angular event binding marks this view dirty every time it fires, and this
     * app is zoneless — so a `(scroll)` on the bench would put a change-detection
     * pass behind every frame of every drag of every book, on a sheet whose DOM is
     * the whole four hundred pages (there is no virtual scroller here;
     * `content-visibility` skips the PAINT and leaves the nodes). The lock writes
     * no signal and draws nothing — it moves one element's `scrollTop` — so there
     * is nothing for a change-detection pass to do, and the honest way to say that
     * is to stay outside the machinery that schedules one.
     *
     * ON THE HOST, IN THE CAPTURE PHASE, because scroll events do not bubble: an
     * ancestor sees them on the way DOWN or not at all. One pair of listeners for
     * the life of the pane, rather than a pair that has to be added and removed
     * every time a toggle is pressed or a window is dragged narrower.
     *
     * WHICH COLUMN IT WAS IS THE ELEMENT'S OWN CLASS. Anything else in this pane
     * that scrolls — the category menu is the only one — is neither, and is left
     * alone rather than mistaken for a column.
     */
    const surface = this.host.nativeElement;
    const which = (event: Event): 'live' | 'source' | null => {
      const target = event.target as HTMLElement | null;
      if (target === null || target.classList === undefined) return null;
      if (target.classList.contains('bench')) return 'live';
      return target.classList.contains('context') ? 'source' : null;
    };
    const scrolled = (event: Event): void => {
      const column = which(event);
      if (column !== null) this.scrolled(column);
      /*
       * A WHEEL TURNS MID-MARQUEE and the pointer never moves, so no pointermove
       * fires and the sweep would freeze while the paper slides past it. The
       * scroll is the event that says the paper moved; the sweep re-runs with
       * the pointer where it last was, and the rectangle — anchored to the
       * PAPER, not the glass (`sweep`) — grows over everything scrolled past.
       */
      const held = this.pressed;
      if (held !== null && held.dragging && held.sheet !== null) {
        this.sweep(held.sheet, held.lastX, held.lastY);
      }
    };
    const settled = (event: Event): void => {
      const column = which(event);
      if (column !== null) this.settled(column);
    };
    /*
     * CTRL+WHEEL IS THE LOUPE (user ruling, 2026-08-16). It scales the paper's
     * own type through a custom property the stylesheet multiplies into the
     * sheet's font-size, so every em-derived measure — the measured ratios, the
     * gutter marks, the cards — scales with the words as one thing. Set
     * NATIVELY, no signal and no change-detection pass: zoom is presentation,
     * exactly like the scroll lock above, and this pane is zoneless. Clamped to
     * [0.6, 2.2]; the browser's own page-zoom stays on Ctrl+/- untouched.
     */
    let zoom = 1;
    const wheeled = (event: WheelEvent): void => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoom = Math.min(2.2, Math.max(0.6, zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)));
      surface.style.setProperty('--zoom', String(zoom));
    };
    surface.addEventListener('scroll', scrolled, { capture: true, passive: true });
    surface.addEventListener('scrollend', settled, { capture: true, passive: true });
    surface.addEventListener('wheel', wheeled, { passive: false });
    destroy.onDestroy(() => {
      surface.removeEventListener('scroll', scrolled, { capture: true });
      surface.removeEventListener('scrollend', settled, { capture: true });
      surface.removeEventListener('wheel', wheeled);
    });
  }

  /**
   * Ask main for the book at this project's position.
   *
   * MAIN MAY HAVE TO MAKE IT FIRST, which is why this can take seconds on a
   * project nothing has reflowed yet, and why the sheet says `Opening the book…`
   * rather than showing a spinner (RENDERER-DESIGN.md §5: no spinners on paper).
   *
   * A REFUSAL IS RENDERED VERBATIM. Main composes the sentence — it is the side
   * that knows whether this book has never been read, whether the engine refused
   * the reflow, or whether the file is in a format this build does not know — and
   * paraphrasing it here would be this pane guessing at a fact it does not have.
   * The `catch` is for the door refusing outright (a directory that is not a
   * project), which is a thing to see rather than a thing to swallow.
   */
  private async load(projectDir: string): Promise<void> {
    if (api === null) return;
    this.asked += 1;
    const ticket = this.asked;
    this.loading.set(true);
    this.problem.set(null);
    this.book.set(null);
    // A BOOK OPENS ON THE BENCH, ALWAYS — see `mode`. This is the whole of "not
    // persisted": there is nowhere it is written down and here is where a reload
    // puts it back.
    this.mode.set('workbench');
    // AND WITH ONE COLUMN — `alignment`'s own ruling, for `mode`'s reason. A pane
    // pointed at another step is a pane that may not be standing under a
    // translation at all, and two columns for a book with no source is a state
    // this surface must never be able to construct.
    this.alignment.set('alone');
    this.twinned.set(null);
    this.chosen.set(new Set());
    this.editingId.set(null);
    this.renaming.set(null);
    this.menu.set(null);
    // Both cards, for one reason: they are about a paragraph in the book being
    // replaced, and there is no honest way to carry either into another one.
    this.dismissCards();
    /*
     * THE STACK GOES WITH THE LOAD, and it is said out loud when it held anything.
     *
     * A reload happens for two reasons and the stack must not survive either. One
     * is an Apply, where it has just been written down and the same ops are about
     * to arrive on the chain — clearing is the whole point. The other is a pointer
     * move: somebody clicked another row in Steps, and ops made against the book
     * at the row they left are a delta against a state they are no longer in. The
     * ruling is that unapplied changes are scrapped rather than carried
     * (docs/RENDERER.md §3), and carrying them here would apply somebody's strikes
     * to a document they made no decision about.
     *
     * SILENCE WOULD BE THE FAILURE. A stack that vanished with no sentence is
     * indistinguishable from a stack that was applied, so the notice strip says
     * what happened — the same strip every other "that did not do what you may
     * have expected" in this window uses.
     */
    const scrapped = this.landed ? 0 : this.waiting();
    this.landed = false;
    if (scrapped > 0) {
      this.notices.notice.set(
        scrapped === 1
          ? 'The change waiting on the book was not applied, so moving to another step let it go.'
          : `The ${scrapped} changes waiting on the book were not applied, so moving to another step `
            + 'let them go.',
      );
    }
    try {
      /*
       * THREE DOORS ONTO ONE SHEET, and which one is asked is decided here.
       *
       * A COMPARED STEP goes first, because it is the narrowest: `atStep` names a
       * row of this project's own history and `book:load-at` replays the chain to
       * it. It is tested before `viewing()` even though it turns `viewing()` on —
       * an export view is a FILE and a compared step is a POSITION in a project,
       * and the two reach entirely different books.
       *
       * AN EXPORT VIEW is a finished file exploded read-only; the position is
       * everything else, which is every ordinary open of this viewer.
       */
      const at = this.atStep();
      const loaded = at !== null
        ? await api.book.loadAt(projectDir, at)
        : this.viewing()
          ? await api.book.view(projectDir)
          : await api.book.load(projectDir);
      if (ticket !== this.asked) return;
      if (loaded.ok) {
        this.book.set(loaded);
        // The finished-book projection is the only honest register for a
        // finished file; `show` refuses to leave it while viewing.
        if (this.viewing()) this.mode.set('edition');
        /*
         * ── THE STACK HYDRATES FROM THE TIP ─────────────────────────────────
         *
         * Standing on an edit step nothing has been made from, the step's own
         * ops ARE the stack: undo pops back through what was already applied,
         * and Apply records whatever the list has become — longer, shorter, or
         * reordered — by rewriting the step (user ruling, 2026-08-16). What was
         * recorded at this load is kept beside it (`landedOps`), because "is
         * there anything to apply" stopped being "is the stack non-empty" and
         * became "does the stack differ from the disk".
         */
        const tip = loaded.tip ?? [];
        this.landedOps.set(tip);
        this.pending.set([...tip]);
        this.undone.set([]);
        /*
         * ── THE PARKED STACK COMES BACK, when it is still about this book ────
         *
         * The last incarnation of this pane may have left unwritten work with
         * the tab (see the destroy hook). It still applies only if nothing
         * moved while it was parked: the tab's revision is bumped by every
         * position change, and the recorded tip must read back as what the
         * stack grew out of. When it applies, the RESTORED lists replace the
         * hydration above wholesale — including `landedOps`, because
         * `waiting()` counts past a shared prefix by identity, and the parked
         * pending's untouched head is the PARKED landed's objects, not this
         * load's re-parsed ones. When it does not, the loss is said out loud;
         * silence here would be indistinguishable from a successful return.
         */
        const parked = this.stacks.claimBookStack(this.tab().id);
        let restored = false;
        let letGo = false;
        if (parked !== null) {
          const same = parked.revision === this.tab().revision
            && JSON.stringify(parked.landed) === JSON.stringify(tip);
          if (same) {
            this.landedOps.set(parked.landed);
            this.pending.set([...parked.pending]);
            this.undone.set([...parked.undone]);
            restored = true;
          } else if (unwritten(parked.landed, parked.pending) > 0) {
            const lost = unwritten(parked.landed, parked.pending);
            letGo = true;
            this.notices.notice.set(
              lost === 1
                ? 'The change waiting on this book was let go — the book here changed while you '
                  + 'were looking at another tab.'
                : `The ${lost} changes waiting on this book were let go — the book here changed `
                  + 'while you were looking at another tab.',
            );
          }
        }
        /*
         * ── AND THE SIDECAR, WHICH IS THE COPY THAT OUTLIVES THIS WINDOW ─────
         *
         * The parked stack above survives a glance at another tab; this survives
         * everything else — a close, a crash, a window somebody's host closed
         * without asking (user report, 2026-08-21, and Owen's reversal of "closing
         * without applying scraps it" the next day). It is asked for only when
         * nothing has already answered for this stack, which is what keeps the two
         * from arguing: the parked copy is at least as fresh, because parking
         * flushes to this very file on its way past.
         *
         * A LOSS THIS PANE HAS JUST ANNOUNCED CLEARS IT INSTEAD. Moving to another
         * step scraps the stack by a ruling that has not been reversed — ops are a
         * delta against the step they were made on, and carrying them would apply
         * somebody's strikes to a document they made no decision about — and the
         * notice above or the one at the top of this function has just said so.
         * Leaving the file behind after that would hold work the person has been
         * told is gone, until the next gesture silently overwrote it, which is the
         * one shape this whole feature exists to make impossible.
         *
         * A REFUSAL IS RENDERED VERBATIM and the file stays where it is. Main
         * composes it — it is the side that knows which step and which reading the
         * held stack was made against — and the commonest refusal is the useful
         * one: the work is held at ANOTHER step, and standing back on that step is
         * how somebody picks it up — so the file is LEFT WHERE IT IS on a refusal,
         * because standing back on that step has to find it there.
         *
         * NOT FOR AN EXPORT VIEW OR A COMPARED COLUMN, and the guard is
         * `viewing()` because it is the one that answers both. Neither is a
         * POSITION: the first is a file exploded read-only out of `final/` and the
         * second is a frozen row, neither has a stack, and `pendingRead` is asked
         * of a project directory — handing it an EPUB's path would be a refusal
         * about a question nobody asked.
         */
        if (this.viewing() || restored) {
          // Nothing to do. A restored stack is already answered for, and the file
          // and the parked copy are the same stack.
        } else if (letGo || scrapped > 0) {
          await this.stacks.discardPending(projectDir);
        } else {
          /*
           * ITS OWN `try`, so a sidecar that will not read cannot blank the book.
           * The outer catch turns a rejection into `problem`, which is the empty
           * sheet with a sentence on it — the right answer for a book that could
           * not be loaded and quite the wrong one for a recovery that could not
           * be offered, because the book itself is fine and is already drawn.
           */
          try {
            const held = await api.book.pendingRead(projectDir);
            if (ticket !== this.asked) return;
            if (!held.ok) {
              this.notices.notice.set(held.reason);
            } else if (held.stack !== null) {
              const back = [...tip.slice(0, held.stack.kept), ...held.stack.tail];
              this.pending.set(back);
              this.undone.set([...held.stack.undone]);
              const many = unwritten(tip, back);
              if (many > 0) {
                this.notices.notice.set(
                  many === 1
                    ? 'One change you had not applied was put back on the page. Apply it to record '
                      + 'it as a step.'
                    : `${many} changes you had not applied were put back on the page. Apply them to `
                      + 'record them as a step.',
                );
              }
            }
          } catch (err) {
            this.notices.notice.set(err instanceof Error ? err.message : String(err));
          }
        }
      } else {
        this.landedOps.set([]);
        this.pending.set([]);
        this.undone.set([]);
        this.problem.set(loaded.reason);
      }
    } catch (err) {
      if (ticket !== this.asked) return;
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (ticket === this.asked) this.loading.set(false);
    }
  }

  /**
   * How many decisions stand between the paper and the disk — the tray's count,
   * the closing question's count, and the scrap notice's.
   *
   * NOT `pending().length` any more: the stack begins as a copy of the tip's
   * recorded ops, so its length counts history. What is waiting is the
   * DIFFERENCE — gestures made since the last Apply, plus applied ops undone
   * since it — measured past the shared prefix, because an undo below the
   * boundary is as much a thing to record as a new strike above it.
   */
  protected waiting(): number {
    return unwritten(this.landedOps(), this.pending());
  }

  /**
   * Every reference number in the book, gathered by the block it was PRINTED in.
   *
   * The file records them the other way round — a note carries the places its
   * number appears — because the note is what owns the link, and deleting one is
   * what removes its numbers (docs/RENDERER.md §2). Drawing wants the inverse,
   * taken once, rather than a search of every note in the book per block.
   */
  /**
   * THE BOOK AS IT NOW READS — the file, with the chain and the stack replayed.
   *
   * ONE REPLAY, NO INCREMENTAL MUTATION. Every gesture on this surface pushes an
   * op and this recomputes; nothing anywhere else edits a row to match. The two
   * lists are concatenated in the only order they can be — what is already
   * recorded, then what is waiting — because the stack is a delta against the
   * state the chain produces, and the fold is order-dependent by design (last op
   * wins, `replayOps`).
   *
   * IT CANNOT THROW IN PRACTICE and is not wrapped as though it could. The only
   * refusal `replayOps` makes is an op kind this build cannot perform, and both
   * sources are already proven: main refuses the whole load rather than hand over
   * a chain it could not read (electron/book.ts), and the stack is minted by the
   * four gestures below.
   */
  /*
   * THE HEADER'S CHAPTERS RIDE IN AS THE SEED, and drawing the header's list
   * instead would make every chapter op invisible. The engine's detected starts
   * are an INPUT to the replay now: a chain with no chapter op in it hands the
   * seed straight back, the first chapter op takes the list over for the rest of
   * the chain, and `reset` hands it back (`Replayed.chapters`). So the sheet draws
   * `view().chapters` — the ops' answer where there is one and the reading's
   * everywhere else — and there is no second place where a division is also
   * decided.
   */
  private readonly view = computed(() => {
    const book = this.book();
    if (book === null) return null;
    return replayOps(book.rows, [...book.ops, ...this.pending()], book.loose, book.chapters);
  });

  /**
   * How many recorded changes named blocks this book no longer has.
   *
   * THE ONES WITH NO `why`, which is the ordinary case: a bank read again mints
   * ids for blocks the model answered differently, so a chain from before can name
   * paragraphs that are genuinely not there. One sentence covers all of them and
   * they are counted rather than listed.
   */
  protected readonly stranded = computed(
    () => this.view()?.missing.filter((one) => one.why === undefined).length ?? 0);

  /**
   * And the ones the replay refused ON THEIR MERITS, each in the replay's own
   * words.
   *
   * These named blocks this book HOLDS and still could not be performed — a cut
   * that would leave one half empty, a reference number bound onto words another
   * already claims. There is no count that says any of that, so each carries its
   * sentence up whole rather than being tallied with the stale ones.
   */
  protected readonly refused = computed<string[]>(() =>
    (this.view()?.missing ?? []).flatMap((one) => (one.why === undefined ? [] : [one.why])));

  /**
   * True when the ops own the divisions rather than the reading — `interpret`'s
   * ownership rule, restated over the same two lists the replay reads.
   *
   * IT IS THE PANEL'S QUESTION AND NOT THE SHEET'S. The paper draws whichever
   * list is in force without caring whose it is; the Chapters panel has to say
   * whose the rows are and whether "Use Foundry's" has anything to hand back, and
   * a reset pushed over a seed already in force would be a row in somebody's
   * history recording a change that changed nothing.
   */
  private readonly chaptersOwned = computed(() => {
    const book = this.book();
    if (book === null) return false;
    let owned = false;
    for (const op of [...book.ops, ...this.pending()]) {
      if (op.op === 'chapter') owned = !('reset' in op);
    }
    return owned;
  });

  /** The notes whose numbers are cancelled with them — derived, never an op (§2). */
  private readonly struckNotes = computed<ReadonlySet<string>>(() => {
    const replayed = this.view();
    return replayed === null ? new Set<string>() : struckNotes(replayed.rows);
  });

  private readonly printed = computed<ReadonlyMap<string, Marker[]>>(() => {
    const replayed = this.view();
    const out = new Map<string, Marker[]>();
    if (replayed === null) return out;
    const cancelled = this.struckNotes();
    const add = (block: string, marker: Marker): void => {
      const already = out.get(block);
      if (already === undefined) out.set(block, [marker]);
      else already.push(marker);
    };
    for (const row of replayed.rows) {
      for (const ref of row.refs ?? []) {
        add(ref.block, { at: ref.at, len: ref.len, note: row.id, struck: cancelled.has(row.id) });
      }
    }
    for (const loose of replayed.loose.markers) {
      add(loose.block, { at: loose.at, len: loose.len, note: null, struck: false });
    }
    for (const markers of out.values()) markers.sort((one, other) => one.at - other.at);
    return out;
  });

  /**
   * The book as the sheet draws it — one Line per row, in reading order.
   *
   * EVERYTHING THAT DEPENDS ON THE ROW BEFORE IS DECIDED HERE, in one pass, and
   * not in the template: whether a paragraph is indented (the first of the book
   * and the first after a heading are not — print convention, §2), where a page
   * ghost belongs (only where the source page CHANGES), and which note opens a
   * page's group of them and so carries the hairline. A template asking those
   * questions per block would ask them again on every repaint.
   */
  protected readonly lines = computed<Line[]>(() => {
    const book = this.book();
    const replayed = this.view();
    if (book === null || replayed === null) return [];
    // THE REPLAY'S LIST AND NOT THE HEADER'S — see `view`. The header's is the
    // seed the replay was handed; what comes back is the seed where no chapter op
    // has spoken and the ops' own list where one has, already filtered to the
    // divisions that sit above a block this book still flows.
    const chapters = new Map(replayed.chapters.map((chapter) => [chapter.id, chapter.title] as const));
    // The REPLAYED record of what is unlinked, not the file's: a text edit is the
    // one gesture that can point a note at nothing or a number at no note, and
    // `replayOps` is what re-derives both for the blocks it touched.
    const orphans = new Set(replayed.loose.notes);
    /*
     * A seam is drawn above its `before` block and carries the id of the block it
     * would be joined onto, because the ghost IS the join now. Which of the
     * header's seams can still be drawn is a question about the book AS THE OPS
     * LEFT IT rather than about the reading — a chain that has already joined one
     * of these turns has taken one of its halves out of the book — so it is asked
     * of the replayed rows (`seamJoins`, ./flow).
     */
    const seams = seamJoins(replayed.rows, book.seams);
    /*
     * THE APPARATUS READS AT THE END OF ITS CHAPTER, on the bench as in the
     * edition and the export — the user's ruling, applied by `chapterOrder`
     * (./flow), which reorders and drops nothing. The rows are cut into spans
     * at the replay's own divisions, so the panel and the paper cannot disagree
     * about where a chapter starts.
     */
    const ordered = chapterOrder(replayed.rows, (row) => ({
      category: row.category,
      opens: chapters.has(row.id),
    }));
    return linesOf(ordered, {
      printed: this.printed(),
      size: (category) => sizeOf(book, category),
      chapters,
      seams,
      orphans,
      chrome: true,
    });
  });

  /**
   * THE LEFT-HAND COLUMN — the source this translation was made from, as lines.
   *
   * ── The same builder, with the instrument switched off ─────────────────────
   *
   * The rows come from main in one answer beside the translated ones
   * (`BookTranslation.source`), and they go through the identical pass the live
   * sheet's do — the same element per category, the same measured size, the same
   * `cut` at the same resolved offsets. That is not a convenience: two columns
   * whose typography was decided in two places would drift a line apart somewhere
   * in the middle of a four-hundred-page book, and the scroll lock would be tying
   * rows of different heights together and calling it aligned.
   *
   * WHAT IS SWITCHED OFF IS EVERYTHING A PERSON COULD ACT ON. No chapter rules or
   * chips, no ordinals, no page ghosts, no amber flags, no seam ghosts — *"chrome
   * only on the live column"*. `chrome: false` is what says so, once, rather than
   * six empty collections that would each have to be kept empty.
   *
   * THE MARKERS ARE STILL CUT, and only the source has any. A translated row
   * carries `refs: []` — nothing recovers where a note number falls inside a
   * sentence somebody else wrote (`translated`, shared/materialize.ts) — so the
   * numbers on the left are the apparatus as the page printed it, drawn demoted
   * (`plain`), with no jump and no coupling, because this sheet is not a reader.
   *
   * NOTHING IS STRUCK HERE, and nothing has to be made not to be: main
   * materialises these rows, and a materialised book has its struck rows already
   * absent (docs/RENDERER.md §4).
   */
  protected readonly sourceLines = computed<Line[]>(() => {
    const book = this.book();
    const source = book?.translation?.source ?? null;
    if (book === null || source === null || !source.ok) return [];
    /*
     * The markers, gathered by the block they were PRINTED in — `printed`'s own
     * inversion, over these rows. LOOSE ONES ARE NOT HERE and are not missing:
     * a stray number with no note under it is a FLAG, this column draws none, and
     * the header that records them is not carried across (rows only, see
     * `BookTranslation.source`). What that costs is one superscript on the left
     * left as ordinary characters in the words, which is what it is.
     */
    const printed = new Map<string, Marker[]>();
    for (const row of source.rows) {
      for (const ref of row.refs ?? []) {
        const already = printed.get(ref.block);
        const marker: Marker = { at: ref.at, len: ref.len, note: row.id, struck: false };
        if (already === undefined) printed.set(ref.block, [marker]);
        else already.push(marker);
      }
    }
    for (const markers of printed.values()) markers.sort((one, other) => one.at - other.at);
    /*
     * ORDERED WITH THE SAME DIVISIONS AS THE LIVE COLUMN, which is load-bearing
     * for the scroll lock: `sharedAnchor` assumes the two columns hold their
     * shared ids in the same order, and a left column still in page order beside
     * a right column in chapter order would anchor a reader onto the wrong
     * paragraph. The division ids are shared between the files by construction
     * (parent ids kept verbatim, docs/RENDERER.md §4).
     */
    const divisions = new Set((this.view()?.chapters ?? []).map((chapter) => chapter.id));
    const ordered = chapterOrder(source.rows, (row) => ({
      category: row.category,
      opens: divisions.has(row.id),
    }));
    return linesOf(ordered, {
      printed,
      // The parent's measurements, which are also this book's: a translation
      // carries its source's typography verbatim, because translating the words
      // did not change what size the type was set in on the page.
      size: (category) => sizeOf(book, category),
      chapters: new Map(),
      seams: new Map(),
      orphans: new Set(),
      chrome: false,
    });
  });

  /** The sentence saying why there is no source to set beside these words, or null. */
  protected readonly sourceProblem = computed<string | null>(() => {
    const source = this.book()?.translation?.source ?? null;
    return source === null || source.ok ? null : source.reason;
  });

  /**
   * What the context sheet says about itself — where source edits live.
   *
   * *"Source edits invalidate that block's records."* (docs/RENDERER.md §5.) That
   * is already true by construction and upstream of this pane: the translator's
   * cost cache is keyed on the masked SOURCE text, so changing a word above the
   * translation changes the question and a re-run answers it fresh. What this
   * sheet has to say is therefore not a refusal but a direction — the words are
   * editable, one step up, and this is where they were read from.
   *
   * AND IT NAMES THE ACT THAT WAS ORDERED. Every sentence here used to say
   * "translation" because a simplify IS a translate step and this pane could not
   * see the difference — so a person who had pressed Simplify hovered their own
   * source column and was told their book had been translated. `pass` is the noun,
   * off the step's own `rewrite` (`BookTranslation.rewrite`), and it is the same
   * field the rail's row is printed from.
   */
  protected readonly sourceTitle = computed<string>(() => {
    /*
     * A SIMPLIFY SAYS THE MODE AND NEVER SAYS A LANGUAGE, which is `labelFor`'s
     * own ruling about the same act (shared/ledger.ts): a rewrite happens IN the
     * book's own language, so the tag is not what tells one from another — the
     * three modes are, and the mode is what somebody who pressed Simplify is
     * looking at when they hover the column they wrote it from.
     */
    const rewrite = this.translation()?.rewrite;
    if (rewrite !== undefined) {
      return `The book this simplification — ${REWRITE_LABELS[rewrite]} — was made from. To change `
        + 'these words, stand on the step above the simplification and edit them there; simplifying '
        + 'again answers with the new ones.';
    }
    const language = this.book()?.translation?.language ?? '';
    return language.length === 0
      ? 'The book this translation was made from. To change these words, stand on the step above '
        + 'the translation and edit them there; translating again answers with the new ones.'
      : `The book this translation into ${language} was made from. To change these words, stand on `
        + 'the step above the translation and edit them there; translating again answers with the '
        + 'new ones.';
  });

  /**
   * THE SAME BOOK, PROJECTED THROUGH THE EXPORT'S RULES — the edition.
   *
   * ── One list, folded again, exactly like everything else here ───────────────
   *
   * This is `lines()` with a pure function over it and nothing more: no second
   * replay, no second load, no engine (docs/RENDERER.md §5 — *"a toggle, not a
   * build"*). Every field the bench uses to draw an instrument mark is put to
   * null on the way through, so the marks are not merely hidden by CSS — the
   * ordinals, page ghosts, amber flags, seam ghosts and division rules are not
   * in the DOM of an edition at all, which is the difference between a page with
   * its chrome turned down and a page that never had any.
   *
   * WHAT MOVES IS THE APPARATUS, and that decision is `editionFlow`'s
   * (./edition), where a script can exercise it. What is left out of the prose is
   * `editionPieces`'s: the reference numbers of notes that are not in this book.
   *
   * THE SIZES ARE NOT TOUCHED. `line.size` is already the measured ratio for its
   * category, and the measured ratios are the EXPORT'S — `dotsStylesheet` writes
   * the very same numbers into the cast's own sheet as `font-size: <ratio>em`
   * rules for `.footnotes`, `p.caption`, `blockquote p`, `h1` and `h2`
   * (src/vlm/dots-book.ts). There is nothing to convert; the bench was always
   * setting the book in the export's type.
   */
  private readonly editionLines = computed<Line[]>(() => editionFlow(
    this.lines(),
    (line) => ({
      category: line.row.category,
      chapter: line.chapter,
      struck: line.row.struck === true,
    }),
  ).map((place) => ({
    ...place.row,
    pieces: editionPieces(place.row.pieces),
    heading: place.heading,
    opens: place.opens,
    opensNotes: place.opensNotes,
    indent: place.indent,
    // The bench's marks, absent rather than quiet — see the docblock.
    chapter: null,
    ordinal: null,
    ghost: null,
    flag: null,
    seamInto: null,
    jump: null,
  })));

  /** The list on the paper: the bench's book, or the edition's. */
  protected readonly sheetLines = computed<Line[]>(
    () => (this.edition() ? this.editionLines() : this.lines()));

  /**
   * The size a division's own heading is set at, when the edition draws one.
   *
   * THE TITLE RATIO, because that is what the cast sets a chapter opening in: the
   * emitter writes the opener as `<h1 data-bf-cat="chapter">` and the sheet's own
   * `h1` rule is the measured `Title` size (or 1.5em, the base sheet's). A
   * division the Chapters panel put above a paragraph has no heading in the book
   * to take a size from, and this is the size the heading it is standing in for
   * would have had.
   */
  protected readonly headingSize = computed<number>(() => {
    const book = this.book();
    return book === null ? 1.5 : sizeOf(book, 'Title');
  });

  /**
   * The URL a Picture row's crop is served at, or null — for a row that names
   * no image (no PDF was given to the reflow) or a book main minted no door
   * for. Composed and never fetched: the allow-list behind the prefix is
   * main's (`bookFigureFile`), and a URL this pane got wrong is a 403 there.
   */
  protected plate(row: BookRow): string | null {
    const figures = this.book()?.figures ?? null;
    return figures !== null && row.image !== undefined
      ? figures + encodeURIComponent(row.image)
      : null;
  }

  /**
   * The register, chosen — the toggle's whole behaviour.
   *
   * A LIVE BLOCK IS PUT TO BED FIRST. The edition has no editor to blur later
   * and no caret to leave one in, so words somebody typed and did not commit
   * would go with the flip — and the flip is not a gesture about those words.
   * `commitEditing` runs while the bench is still on, so its own text op lands
   * the ordinary way (and `push` below finds the mode it expects).
   */
  protected show(register: 'workbench' | 'edition'): void {
    if (this.mode() === register) return;
    this.commitEditing();
    this.renaming.set(null);
    this.menu.set(null);
    /*
     * AND THE EDITION DROPS TO ONE COLUMN. The edition is the finished book, a
     * finished book has one column, and there is no such thing as a preview of a
     * translation WITH its source down the side — the export writes nothing like
     * it. It is put back rather than merely hidden, so that coming back to the
     * bench is the page somebody left and not a page that reassembles itself
     * around them.
     */
    if (register === 'edition') this.alignment.set('alone');
    // A card is a glance at the bench's book; neither register keeps one up.
    // The edition has no instrument at all, and the flip back is a fresh page.
    this.dismissCards();
    // An export view has one register: the file is finished, and a workbench
    // over it would draw instruments nothing here can honour.
    if (this.viewing()) return;
    this.mode.set(register);
  }

  /**
   * The source beside the translation, or not — the second control's whole
   * behaviour.
   *
   * A REFUSAL IS SAID OUT LOUD. The Aligned segment is `aria-disabled` and not
   * `disabled` precisely so that pressing it can reach here and put the reason on
   * the notice strip: a control that cannot be pressed cannot explain itself, and
   * a title alone is a sentence only a pointer that pauses ever reads.
   *
   * A LIVE BLOCK IS PUT TO BED FIRST, on `show`'s rule: both sheets change measure
   * when the pair opens or closes, and words somebody typed into a paragraph that
   * is about to reflow are not a thing to lose to a layout.
   */
  protected align(which: 'alone' | 'aligned'): void {
    if (which === 'aligned') {
      const refused = this.alignRefusal();
      if (refused !== null) {
        this.notices.notice.set(refused);
        return;
      }
    }
    if (this.alignment() === which) return;
    this.commitEditing();
    this.alignment.set(which);
    this.twinned.set(null);
    /*
     * AND THE COLUMNS ARE PUT IN STEP THE MOMENT THE SECOND ONE EXISTS. The
     * source arrives scrolled to its own top while the translation is wherever the
     * person had been reading, and two columns that do not agree on the first
     * frame are two columns somebody has to scroll to reconcile before the lock is
     * any use. The LIVE column drives, because that is the one they were reading.
     *
     * THROUGH `scrolled` AND NOT STRAIGHT INTO `lock`, so that the sync takes the
     * wheel like any other gesture: the source column is about to be moved, its own
     * scroll event is about to fire, and an unguarded one would drive the live
     * column back off the place this was called to put it.
     */
    if (which === 'aligned') {
      afterNextRender(() => this.scrolled('live'), { injector: this.injector });
    }
  }

  /**
   * Back to the bench, with a block picked out — the ending EVERY edit gesture
   * takes while the edition is on.
   *
   * *"Edition is read-only; any edit gesture flips back to Workbench with the
   * block focused."* (RENDERER-DESIGN.md §5.) THE FLIP IS THE ANSWER and the
   * gesture is not also performed: a double-click on a preview is somebody
   * reaching for the words, and putting a caret in them as well would have one
   * press both change the mode and start an edit in a mode they had not seen
   * yet. The second press does the thing, on the bench, where its marks are.
   *
   * FOCUS AFTER THE FRAME THAT DRAWS IT, for `edit`'s reason: the bench's list is
   * a different list and the element under the pointer belongs to the edition's.
   */
  private toBench(id: string | null): void {
    this.mode.set('workbench');
    if (id === null) return;
    this.chosen.set(new Set([id]));
    afterNextRender(() => {
      const block = this.host.nativeElement
        .querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
      block?.focus({ preventScroll: true });
    }, { injector: this.injector });
  }

  /** True while a hovered page ghost names a page this block sits on. */
  protected spans(line: Line): boolean {
    const page = this.ghosted();
    return page !== null && line.row.pages.includes(page);
  }

  /** Light a note and its markers together, or put them all out. */
  protected light(noteId: string | null): void {
    this.lit.set(noteId);
  }

  /**
   * A note row under the pointer lights its own markers. Anything else lights
   * nothing.
   *
   * THE GLANCE IS NO LONGER ARMED HERE, and that is Wave 30 in one line. This
   * used to start a 180 ms rest timer, because a hover trigger has to tell a
   * pointer that stopped from one that swept past. The trigger is a click now
   * (`release`), so a pointer crossing this block does exactly what it looks
   * like it does: it lights a note and nothing else.
   */
  protected lightRow(line: Line): void {
    this.lit.set(line.ordinal === null ? null : line.row.id);
    this.twin(line.row.id);
  }

  /**
   * Aim the card at a block — the row to draw, and where its card stands.
   *
   * CALLED FROM THE CLICK THAT ALREADY SELECTED THE BLOCK (`release`), and from
   * nowhere else. There is no second gesture here: the press-and-let-go that
   * makes a block THE selected block is the same press-and-let-go that puts its
   * printed page beside it, so a reader who wants the page does what they were
   * already doing to act on the paragraph.
   *
   * A ROW THE BOOK NO LONGER HAS DISMISSES rather than draws. `lines()` is the
   * book as replayed at this instant, and an id that is not in it is a block a
   * join or a cut has taken out from under the click — the same answer `peeked`
   * gives for the same reason.
   */
  private aimGlance(id: string): void {
    const line = this.lines().find((one) => one.row.id === id);
    if (line === undefined) {
      this.dismissGlance();
      return;
    }
    this.glanced.set(line.row);
    /*
     * A CARD THAT CANNOT BE PLACED IS NOT SHOWN AT ALL. With a fixed-position
     * host, "shown but unplaced" is a card at the viewport's whim — the exact
     * shape of surprise this pane does not do. Placement fails only when the
     * geometry is unreadable (a zero-width card mid-layout, a pane not found),
     * and the honest answer then is no card, not a card somewhere.
     */
    if (!this.placeGlance(id)) {
      this.dismissGlance();
      return;
    }
    /*
     * PLACED TWICE, AND THE SECOND READING IS THE TRUE HEIGHT. The line above
     * runs inside the click's own handler, before this row's content has
     * rendered — so the height it centres with is the idle sliver's, a box of
     * padding a few pixels tall, and the card would stand well below centre
     * (and off a short pane's bottom edge) once the page frame gave it its
     * real ~20rem. One frame later the frame's aspect ratio has sized the box
     * — the ratio is row data, not the render, so the layout does not wait on
     * pdf.js — and the same arithmetic lands on the true middle. The width
     * never changes between the two readings, so nothing visibly jumps
     * sideways; the guard keeps a stale frame from re-placing a card a faster
     * second click has already re-aimed or dismissed.
     */
    requestAnimationFrame(() => {
      if (this.glanced()?.id === id) this.placeGlance(id);
    });
  }

  /**
   * Where the card stands: FIXED viewport coordinates, in the workbench's gray
   * beside the paper.
   *
   * OWEN'S RULING (2026-08-22) OVERRULES THE INK ARGUMENT, and it is worth
   * keeping both halves on the record. The card was ink in the sheet's frame —
   * "it rides a scroll instead of being chased down one" — and what that
   * produced on a long book was a card parked at the very top, gone past the
   * first wheel turns: *"it sits on the top right of the document. the VERY
   * top right... if i scroll down too far it disappears. lots of empty space
   * to the right and it should scroll with the document so the user can see
   * it anywhere."* `position: fixed` (./page-glance's own host) is the design
   * both arguments wanted: the gray gutter, held still on screen through any
   * scroll, with NO scroll listener — viewport coordinates do not move when
   * the bench's inside does. Nothing here runs on scroll, still.
   *
   * THE ARITHMETIC: the preferred left is just past the paper's right edge
   * (`paper.right + GLANCE_MARGIN`), clamped so the card stays inside the
   * bench's CONTENT edge (`clientWidth`, not the border box — the 8px
   * scrollbar sits on the very edge the card would run into). On a bench too
   * narrow for the gutter — a laptop, or the aligned pair's half-width
   * columns — the clamp walks the card leftward over the paper's margin:
   * still fixed, still visible at any scroll, which is the half of the ruling
   * that outranks covering nothing. Vertically it centres in the pane, which
   * no longer depends on the clicked block at all: the card answers "what did
   * this page look like", and a stable place to look beats a card that jumps
   * to each click.
   *
   * `card.getBoundingClientRect()` and NOT constants — see ./page-glance for
   * what a mirrored constant cost; the reading works because the idle card is
   * hidden with `visibility`, not `display`. Re-placed on aim and by the
   * pane's existing ResizeObserver (the sidebar and inspector opening move
   * the bench without a window resize).
   */
  private placeGlance(id: string): boolean {
    const card = this.glanceCard()?.nativeElement;
    const sheet = card?.closest('.sheet');
    if (card === undefined || !(sheet instanceof HTMLElement)) return false;
    const block = sheet.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!(block instanceof HTMLElement)) return false;
    const pane = sheet.closest('.bench');
    if (!(pane instanceof HTMLElement)) return false;
    const paper = sheet.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    if (box.width <= 0) return false;
    const bench = pane.getBoundingClientRect();
    const inner = bench.left + pane.clientWidth;
    const left = Math.max(
      bench.left + GLANCE_MARGIN,
      Math.min(paper.right + GLANCE_MARGIN, inner - box.width - GLANCE_MARGIN),
    );
    const room = Math.max(GLANCE_GAP, (pane.clientHeight - box.height) / 2);
    this.glanceAt.set(bench.top + room);
    this.glanceLeft.set(left);
    return true;
  }

  /** The card goes. Safe to call when there is none. */
  private dismissGlance(): void {
    this.glanced.set(null);
    this.glanceAt.set(null);
    this.glanceLeft.set(null);
  }

  /**
   * Light the same block on the other sheet — the coupling, both directions.
   *
   * *"Hovering a block in either column lights the SAME id in the other."* It is
   * an id and not an element, so the two columns never have to find each other for
   * this: each draws the class where its own row's id matches, and a row the other
   * column does not have simply lights nothing, which is the honest picture of a
   * paragraph that the translation struck or a cut has since divided.
   *
   * NOTHING IS LIT WHILE THERE IS ONE COLUMN. The tint would be indistinguishable
   * from the hover it is made of, so it would be a class that changed nothing —
   * but it would also be a signal writing on every pointer move across a book that
   * has no use for it.
   */
  protected twin(id: string | null): void {
    this.twinned.set(this.aligned() ? id : null);
  }

  /**
   * The pointer left a block: the note goes out and its twin with it.
   *
   * AND THE GLANCE STAYS, which is the other half of making it a click. A card
   * somebody asked for does not leave because the hand moved — that was the
   * behaviour of a card the hand had put there without being asked. It goes when
   * it is dismissed: Escape, a click on no block, or another block's click
   * taking it.
   */
  protected dim(): void {
    this.lit.set(null);
    this.twinned.set(null);
  }

  protected haunt(page: number | null): void {
    this.ghosted.set(page);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The scroll lock — two columns, one place in the book
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ONE COLUMN DRIVES AT A TIME, and this is which.
   *
   * ── The loop this exists to break ──────────────────────────────────────────
   *
   * Scrolling A moves B. Moving B fires B's own scroll event. If that event moved
   * A, the two columns would push each other down the page for as long as the
   * arithmetic disagreed by a pixel — the classic two-way scroll loop, and it does
   * not merely jitter, it makes both columns unusable. So the column a HAND is on
   * takes the wheel, the other one's events are ignored for the duration, and the
   * wheel goes back when that hand stops (`scrollend`, or `SCROLL_SETTLE_MS` for
   * the one case that fires nothing).
   *
   * IT IS A FIELD AND NOT A SIGNAL. Nothing draws it, it changes many times a
   * second while a wheel is turning, and a signal would put a change-detection
   * pass behind every one of those.
   */
  private driving: 'live' | 'source' | null = null;
  private drivingTimer: ReturnType<typeof setTimeout> | null = null;

  /** A column was scrolled: it takes the wheel, and the other one follows. */
  private scrolled(which: 'live' | 'source'): void {
    if (!this.aligned()) return;
    // The passenger's own scroll, which this pane caused a moment ago. Ignored,
    // and that is the whole of the re-entrancy guard.
    if (this.driving !== null && this.driving !== which) return;
    this.driving = which;
    if (this.drivingTimer !== null) clearTimeout(this.drivingTimer);
    this.drivingTimer = setTimeout(() => {
      this.driving = null;
      this.drivingTimer = null;
    }, SCROLL_SETTLE_MS);
    this.lock(which);
  }

  /** `scrollend` on the driving column: the wheel goes back at once. */
  private settled(which: 'live' | 'source'): void {
    if (this.driving !== which) return;
    this.driving = null;
    if (this.drivingTimer !== null) {
      clearTimeout(this.drivingTimer);
      this.drivingTimer = null;
    }
  }

  /**
   * PUT THE OTHER COLUMN WHERE THIS ONE IS — the lock, by block id.
   *
   * ── What "the same place" means, and it is not a fraction ──────────────────
   *
   * *"Scrolling either column finds its topmost fully-visible block id and scrolls
   * the other column so its row of the SAME id sits at the same viewport offset."*
   * Not a proportion of the scroll height: a translation is a different length
   * from its source in every language anybody translates into, so tying the two
   * scrollbars together by percentage would put paragraph four hundred beside
   * paragraph four hundred and thirty and drift the whole way down the book. The
   * ids are the same on both sides by construction (docs/RENDERER.md §4 — *"parent
   * ids kept verbatim"*), so the id is the place.
   *
   * ── NEAREST PRECEDING IS A RULE HERE, NOT A FALLBACK ───────────────────────
   *
   * A row can be on one side and not the other, and both ways of it happening are
   * ordinary: a block struck under the translation is absent from the derived
   * book, and a cut applied under it mints ids (`b2-3/1`) the source never had. The
   * ruling (this wave's brief, and it is written down here because it is the kind
   * of decision that gets mistaken for a shortcut later) is the NEAREST PRECEDING
   * id present on both — the last shared paragraph at or above the one on screen.
   * It is not a guess at where the missing row would have been: it is the true
   * statement that both columns are somewhere after that paragraph, and it is
   * stable, because the same anchor is chosen whichever column is driving.
   *
   * A book with NO shared row above the anchor moves nothing at all, which is the
   * top of the book and needs no help.
   */
  private lock(driver: 'live' | 'source'): void {
    const host = this.host.nativeElement;
    const live = host.querySelector('.bench') as HTMLElement | null;
    const source = host.querySelector('.context') as HTMLElement | null;
    if (live === null || source === null) return;
    const from = driver === 'live' ? live : source;
    const to = driver === 'live' ? source : live;

    const fromBox = from.getBoundingClientRect();
    const rows = [...from.querySelectorAll('.block[data-id]')] as HTMLElement[];
    /*
     * THE TOPMOST ROW NOT CUT OFF AT THE TOP. A block whose first line is above
     * the fold is a block the reader is in the MIDDLE of, and putting its top edge
     * at the other column's top edge would scroll the passenger backwards past
     * words the driver can still see. The one under it is the first whole thing on
     * screen, which is what a person would point at if asked where they were.
     *
     * The half-pixel is the browser's own subpixel layout and not a tolerance
     * invented here: two boxes flush against each other can differ in the last
     * place of a fractional rectangle.
     *
     * IT IS A WALK FROM THE TOP AND IT IS AFFORDABLE, which is worth saying so
     * that nobody optimises it in the dark. The rects are read after the layout
     * the scroll already forced, so a four-hundred-page book costs a few thousand
     * property reads and no reflow — and it costs them only while two columns are
     * on screen, which is a mode somebody chose. A binary search would work (the
     * blocks are in document order in normal flow, so their tops only increase)
     * and it is not here because the walk is honest and the search is a claim
     * about the layout that nothing in this file could check.
     */
    const anchor = rows.findIndex((row) => row.getBoundingClientRect().top >= fromBox.top - 0.5);
    if (anchor < 0) return;

    const twins = new Map<string, HTMLElement>();
    for (const row of to.querySelectorAll('.block[data-id]')) {
      const id = row.getAttribute('data-id');
      if (id !== null) twins.set(id, row as HTMLElement);
    }

    // The rule itself is `sharedAnchor` (./flow) — pure, over two lists of ids,
    // where a script can exercise it. What is left here is the arithmetic, which
    // needs a laid-out document and can only be checked by looking at one.
    const shared = sharedAnchor(
      rows.map((row) => row.getAttribute('data-id') ?? ''),
      anchor,
      new Set(twins.keys()),
    );
    if (shared === null) return;
    const twin = twins.get(rows[shared]!.getAttribute('data-id')!);
    if (twin === undefined) return;
    /*
     * THE SHARED ROW'S OWN OFFSET, and not the anchor's. When the row on screen is
     * one the other column does not have, what is being lined up is the last
     * paragraph they both hold — so the offset that matters is where THAT
     * paragraph sits in the driving column, which is off the top of the screen by
     * however far the reader has come since. Using the anchor's offset would put a
     * paragraph the reader has already passed at the top of the other column.
     */
    const offset = rows[shared]!.getBoundingClientRect().top - fromBox.top;
    const moved = (twin.getBoundingClientRect().top - to.getBoundingClientRect().top) - offset;
    // A move of less than a pixel is the two columns already agreeing. Assigning
    // it anyway would fire a scroll event on the passenger for nothing, which costs
    // a frame and a guarded handler on every notch of a wheel.
    if (Math.abs(moved) >= 1) to.scrollTop += moved;
  }

  /**
   * The card, resolved against the book being drawn — the peek's geometry
   * joined with the target row's own pieces, label and state. Null while no
   * card is up OR when the chain has taken the target out of the book from
   * under an open card, which closes it by answering nothing.
   */
  protected readonly peeked = computed(() => {
    const peek = this.peek();
    if (peek === null) return null;
    const line = this.lines().find((one) => one.row.id === peek.target);
    if (line === undefined) return null;
    return {
      target: peek.target,
      label: line.label,
      page: line.row.pages[0] ?? line.row.page,
      pieces: line.pieces,
      struck: line.row.struck === true,
      x: peek.x,
      y: peek.y,
      line: peek.line,
    };
  });

  /** The note whose pair is on the card — the number the card lights. */
  protected peekFrom(): string | null {
    return this.peek()?.from ?? null;
  }

  /**
   * Open the card beside the click, or close it when the same counterpart is
   * asked for twice — the second click is the reader saying they are done.
   *
   * The geometry is decided here, once: the card stands to the RIGHT of the
   * click where the paper has room and to the left where it does not, and the
   * leader runs from the click point to the card's near top corner. All of it
   * in sheet coordinates — see `peek`.
   */
  private peekAt(
    sheet: HTMLElement,
    clientX: number,
    clientY: number,
    target: string,
    from: string | null,
  ): void {
    if (this.peek()?.target === target) {
      this.peek.set(null);
      return;
    }
    const box = sheet.getBoundingClientRect();
    const ax = clientX - box.left;
    const ay = clientY - box.top;
    const width = 352;
    const right = ax + 28;
    const x = right + width > box.width - 12 ? Math.max(12, ax - 28 - width) : right;
    const y = Math.max(12, ay - 14);
    const entryX = x > ax ? x : x + width;
    const entryY = y + 18;
    const left = Math.min(ax, entryX) - 4;
    const top = Math.min(ay, entryY) - 4;
    this.peek.set({
      target,
      from,
      x,
      y,
      line: {
        left,
        top,
        width: Math.abs(entryX - ax) + 8,
        height: Math.abs(entryY - ay) + 8,
        x1: ax - left,
        y1: ay - top,
        x2: entryX - left,
        y2: entryY - top,
      },
    });
  }

  /** The card's one deliberate journey: the old jump, asked for by name. */
  protected travel(id: string): void {
    this.peek.set(null);
    this.scrollTo(id);
  }

  /**
   * Escape puts down every card on the paper — the peek and the glance both.
   *
   * ONE KEY FOR BOTH, because from the reader's side there is one thing on
   * screen to be rid of and no way to tell which of two handlers they are
   * addressing. The peek is dismissed by clicking its own marker again and the
   * glance by clicking off every block, so the precise gestures still exist for
   * anybody who wants to keep one card and drop the other.
   */
  protected dismissCards(): void {
    this.peek.set(null);
    this.dismissGlance();
  }

  /**
   * Put a block in the middle of the sheet and tint it for `PULSE_MS`.
   *
   * The pulse is the whole point of the gesture: a jump that merely scrolled
   * would leave the reader looking at a page of prose with no sign of which line
   * of it they had been sent to.
   */
  private scrollTo(id: string): void {
    /*
     * A JUMP OUT OF A PANEL PUTS THE PANE BACK ON THE BENCH FIRST, which is the
     * same rule `push` states one level down and for the same reason: the panels
     * draw the WORKBENCH's book. A note the Notes panel is pointing at may be
     * struck — absent from the edition entirely — or may be sitting somewhere
     * else on the page, because the edition collects the apparatus at the end of
     * its chapter. Following that jump into the preview would land on nothing or
     * on the wrong thing, and doing nothing at all would be a click that reports
     * no answer.
     */
    if (this.edition() && !this.viewing()) {
      this.mode.set('workbench');
      afterNextRender(() => this.land(id), { injector: this.injector });
      return;
    }
    this.land(id);
  }

  /**
   * The scroll and the pulse, once the list under them is the bench's.
   *
   * ── A GLIDE THAT RE-AIMS EVERY FRAME, because the target MOVES ─────────────
   *
   * The sheet's bodies sit under `content-visibility: auto` with a 4rem
   * placeholder, so every block the viewport has never reached is ESTIMATED at
   * 4rem — a fraction of what a paragraph actually measures. Any scroll aimed
   * ONCE therefore aims at a fiction: as blocks near the destination render and
   * take their real heights, the target slides away from wherever the scroll was
   * told to go. One `scrollIntoView({smooth})` landed a chapter-four heading in
   * the middle of chapter two; an instant jump with an after-the-fact settle
   * still left the block half off the screen, because the placeholders around it
   * resolve on the frames AFTER the one the settle checked.
   *
   * So the correction is not a step after the motion — it IS the motion. Each
   * frame measures where the target's centre actually stands against the
   * bench's, and closes a time-constant fraction of that distance: an ease-out
   * glide of about three-quarters of a second that a reader can follow, whose
   * aim is refreshed on every frame, so the layout growing underneath it is
   * absorbed while it travels instead of discovered after it stops. The chase
   * ends when the centres agree, and the bound snaps the last of the distance
   * closed so a landing is centred even if the clock runs out first.
   *
   * THE SCROLLBAR STAYS THE READER'S. A wheel or a press on the sheet while the
   * glide is in flight cancels it — the app asked to move the page, the person
   * moved it instead, and the person wins. Reduced motion collapses the chase to
   * its endpoint: the same loop with the whole distance closed each frame, which
   * is an instant landing that still absorbs the late-resolving placeholders.
   */
  private land(id: string): void {
    const element = this.host.nativeElement.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    const bench = element?.closest('.bench, .context') as HTMLElement | null;
    if (element === null || bench === null) return;
    if (this.gliding !== null) cancelAnimationFrame(this.gliding);
    const centreDelta = (): number => {
      const box = element.getBoundingClientRect();
      const view = bench.getBoundingClientRect();
      return (box.top + box.height / 2) - (view.top + view.height / 2);
    };
    const abort = (): void => {
      if (this.gliding !== null) cancelAnimationFrame(this.gliding);
      this.gliding = null;
    };
    bench.addEventListener('wheel', abort, { once: true, passive: true });
    bench.addEventListener('pointerdown', abort, { once: true });
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const started = performance.now();
    let last = started;
    const step = (now: number): void => {
      const delta = centreDelta();
      const dt = now - last;
      last = now;
      const done = Math.abs(delta) < 0.5 || now - started > GLIDE_MAX_MS;
      bench.scrollTop += done || reduced ? delta : delta * (1 - Math.exp(-dt / GLIDE_TAU_MS));
      this.gliding = done && (reduced ? Math.abs(centreDelta()) < 0.5 : true)
        ? null
        : requestAnimationFrame(step);
    };
    this.gliding = requestAnimationFrame(step);
    if (this.pulseTimer !== null) clearTimeout(this.pulseTimer);
    this.pulse.set(id);
    this.pulseTimer = setTimeout(() => this.pulse.set(null), PULSE_MS);
  }

  /**
   * A press on the sheet — the start of a click OR of a marquee, and which of
   * them it was is decided by whether the pointer moves.
   *
   * ONE GESTURE FOR BOTH, because from the hand's side they are one: press,
   * maybe move, let go. Deciding at pointerdown would mean guessing, and the
   * guess would be wrong exactly where the blocks are — which is everywhere on
   * this sheet, since a paragraph fills the column and there is almost no empty
   * paper to start a rectangle in.
   */
  protected press(event: PointerEvent): void {
    if (event.button !== 0) return;
    /*
     * AND IN THE EDITION THERE IS NO GESTURE HERE AT ALL — not a flip, either.
     * A press is the start of a selection or of a marquee, and both of those are
     * chrome: there is no rail to raise, no chip to hang and no rectangle to
     * draw. It is not an EDIT gesture, so §5's "flips back to Workbench" is not
     * about it, and treating it as one would mean a preview nobody can click
     * anywhere on — including on the words they came to read. Standing aside
     * also leaves the browser's own selection alone, which the edition turns
     * back on.
     */
    if (this.edition()) return;
    const target = event.target as HTMLElement | null;
    const block = target === null ? null : target.closest('.block');
    /*
     * A PRESS INSIDE THE BLOCK BEING EDITED IS THE CARET'S, and nothing else's.
     * Selection and the marquee both take pointer capture, and a captured pointer
     * cannot place a caret or drag over a word — so while a block is live this
     * function stands aside for it entirely. Everywhere else on the sheet the
     * ordinary gestures still work, which is what makes a press on another
     * paragraph commit the edit (through the editor's own blur) and select that
     * paragraph in one movement.
     */
    const editing = this.editingId();
    if (editing !== null && block !== null && block.getAttribute('data-id') === editing) return;
    const marker = target === null ? null : target.closest('.marker');
    const sheet = event.currentTarget as HTMLElement;
    // The Delete key has to reach a marquee's selection, and a marquee focuses
    // nothing — see the sheet's own `tabindex` in the template.
    if (block === null) sheet.focus({ preventScroll: true });
    sheet.setPointerCapture(event.pointerId);
    const paper = sheet.getBoundingClientRect();
    this.pressed = {
      x: event.clientX,
      y: event.clientY,
      sheetX: event.clientX - paper.left,
      sheetY: event.clientY - paper.top,
      lastX: event.clientX,
      lastY: event.clientY,
      sheet,
      id: block === null ? null : block.getAttribute('data-id'),
      onMarker: marker !== null,
      note: marker === null ? null : marker.getAttribute('data-note'),
      jump: block === null ? null : block.getAttribute('data-jump'),
      extend: event.ctrlKey || event.metaKey || event.shiftKey,
      similar: event.altKey,
      base: this.chosen(),
      dragging: false,
    };
    // A new press anywhere on the paper closes an open card; the branches at
    // release may put a new one up. The card's own pointerdown never reaches
    // here (it stops propagation), so clicking ON the card holds it open.
    this.peek.set(null);
  }

  /**
   * A drag over the sheet is the marquee, and it is the ONLY thing a drag is.
   *
   * ── WHERE THE REORDER MODE WOULD HANG, AND WHY IT IS NOT HERE ──────────────
   *
   * `{ op: 'move', id, before }` is performed by the replay and nothing on this
   * surface mints it. The gesture docs/RENDERER.md §5 names is *"drag to reorder
   * in an explicit order-repair mode"*, and that is a second meaning for the one
   * gesture below: a mode to enter and leave, a lift under the pointer, a drop
   * indicator between two blocks, a hit test per block on every pointer move and
   * an autoscroll when the drag reaches the top or the bottom of a bench holding a
   * four-hundred-page book. That is real machinery, it is the same machinery a
   * draggable chapter rule needs (see `rename`), and the op exists without it —
   * so the two gestures are deferred together and out loud rather than half-built.
   *
   * WHAT STANDS IN THE MEANTIME IS NOTHING, deliberately. Reading order coming out
   * wrong is a reflow problem before it is an editing one, and a repair nobody can
   * reach is better than a repair that reorders a book on a slip of the hand.
   */
  protected drag(event: PointerEvent): void {
    const from = this.pressed;
    if (from === null) return;
    if (!from.dragging) {
      if (Math.abs(event.clientX - from.x) < DRAG_SLOP
        && Math.abs(event.clientY - from.y) < DRAG_SLOP) {
        return;
      }
      from.dragging = true;
    }
    from.lastX = event.clientX;
    from.lastY = event.clientY;
    this.sweep(event.currentTarget as HTMLElement, event.clientX, event.clientY);
  }

  /**
   * The marquee's rectangle and its catch, computed IN SHEET COORDINATES.
   *
   * The anchor corner is the paper's own point the press landed on (`sheetX`,
   * `sheetY` — see `pressed`), and the moving corner is the pointer converted
   * into the same frame at this instant. That is what makes the sweep survive a
   * wheel-scroll mid-drag: scrolling moves the paper, the anchor is a point ON
   * the paper, and everything the rectangle grows over on the way is caught —
   * which is the gesture's whole promise. The scroll listener re-runs this with
   * the pointer where it last was (`lastX`/`lastY`), because a wheel turns
   * without the pointer moving and no pointermove ever fires.
   */
  private sweep(sheet: HTMLElement, clientX: number, clientY: number): void {
    const from = this.pressed;
    if (from === null || !from.dragging) return;
    const paper = sheet.getBoundingClientRect();
    const px = clientX - paper.left;
    const py = clientY - paper.top;
    const left = Math.min(from.sheetX, px);
    const top = Math.min(from.sheetY, py);
    const right = Math.max(from.sheetX, px);
    const bottom = Math.max(from.sheetY, py);
    this.marquee.set({ left, top, width: right - left, height: bottom - top });
    const taken = new Set(from.extend ? from.base : []);
    for (const element of sheet.querySelectorAll('.block')) {
      const id = element.getAttribute('data-id');
      if (id === null) continue;
      const at = element.getBoundingClientRect();
      const blockTop = at.top - paper.top;
      const blockBottom = at.bottom - paper.top;
      const blockLeft = at.left - paper.left;
      const blockRight = at.right - paper.left;
      if (blockBottom >= top && blockTop <= bottom && blockRight >= left && blockLeft <= right) {
        taken.add(id);
      }
    }
    this.chosen.set(taken);
  }

  /** The end of it: a marquee keeps what it swept, a press takes one block. */
  protected release(event: PointerEvent): void {
    const from = this.pressed;
    this.pressed = null;
    this.marquee.set(null);
    const sheet = event.currentTarget as HTMLElement;
    if (sheet.hasPointerCapture(event.pointerId)) sheet.releasePointerCapture(event.pointerId);
    if (from === null || from.dragging) return;
    /*
     * A PRESS ON A REFERENCE NUMBER IS A PEEK AND NOTHING ELSE — not a selection
     * of the paragraph it happens to sit in. The two halves of an apparatus are
     * a pair, and the ruling is that reading the other half must not move the
     * scrollbar: the note appears on a card beside the number, joined by the
     * leader, and the card's own "Go there" is the deliberate journey. A number
     * nothing carries shows nothing; the amber pill in the margin has already
     * said why.
     */
    if (from.onMarker) {
      if (from.note !== null) this.peekAt(sheet, from.x, from.y, from.note, from.note);
      return;
    }
    if (from.id === null) {
      // A press on the paper itself, off every block: the ordinary "let go of
      // what I had", which is how a selection is dropped everywhere in this app.
      if (!from.extend) this.chosen.set(new Set());
      /*
       * AND THE CARD GOES WITH IT, extend or not. The glance answers a question
       * asked about ONE block, and a click that landed on no block is the plain
       * form of "I am done with that" — it is the same dismissal the peek takes
       * from `press`, one gesture up.
       */
      this.dismissGlance();
      return;
    }
    const id = from.id;
    /*
     * ALT+CLICK TAKES THE WHOLE CATEGORY — every block set as this one is, in
     * one selection, for the gesture "act on all the footnotes" (or captions, or
     * quotes) without sweeping a four-hundred-page book by hand. Alt rather than
     * double-click because double-click is the editor's (RENDERER-DESIGN.md §3:
     * the block itself is the editor), and a gesture that sometimes edited and
     * sometimes selected three hundred rows would be two meanings on one motion.
     */
    /*
     * ── WHICH CLICKS SUMMON THE GLANCE, AND WHICH ONLY PUT IT DOWN ────────────
     *
     * *"if multiple blocks are selected, it should not show at all."* A card
     * showing one page over a selection of forty is answering a question nobody
     * asked, and picking WHICH of the forty to show would be this surface
     * guessing.
     *
     * So the two selection-BUILDING clicks below — Alt for the whole category,
     * Ctrl/Shift for one more or one fewer — dismiss the card and never summon
     * it, even in the arithmetic where Ctrl happens to land back on a single
     * block. THE RULE IS ABOUT THE GESTURE, NOT THE COUNT: a click whose whole
     * meaning is "and this one too" is not a click that asked about a page. The
     * effect in the constructor is the backstop for every other way a selection
     * grows, and it is deliberately one-way — a selection falling back to one
     * block does NOT bring the card back, because the card answers a click and
     * nothing has been clicked.
     */
    if (from.similar) {
      const line = this.lines().find((one) => one.row.id === id);
      if (line !== undefined) {
        const category = line.row.category;
        this.chosen.set(new Set(
          this.lines()
            .filter((one) => one.row.category === category)
            .map((one) => one.row.id),
        ));
      }
      this.dismissGlance();
      return;
    }
    if (from.extend) {
      const taken = new Set(from.base);
      if (!taken.delete(id)) taken.add(id);
      this.chosen.set(taken);
      this.dismissGlance();
    } else {
      this.chosen.set(new Set([id]));
      /*
       * THE ONE CLICK THAT SUMMONS IT, and it is the click that was already
       * here. Nothing above this line changed: the same press-and-let-go on a
       * block still makes it THE selection. It now also aims the card, which is
       * why clicking the next paragraph re-aims rather than opening a second
       * one — there is one card because there is one selection.
       */
      this.aimGlance(id);
    }
    // A note peeks the other way: the paragraph its number is printed in comes
    // to the card, with that number lit inside it.
    if (from.jump !== null) this.peekAt(sheet, from.x, from.y, from.jump, id);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The stack: push, pop, and write it down
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * One decision, onto the stack.
   *
   * THE REDO PILE IS DROPPED BY ANY NEW GESTURE, which is what every undo stack
   * in every program does and is the only coherent rule: the pile is a list of
   * things that were true of a document that has just changed under them, and
   * offering to re-apply a strike over a paragraph somebody has since retyped
   * would put an op back into a book it was never about.
   */
  private push(...ops: readonly BookOp[]): void {
    if (ops.length === 0) return;
    /*
     * AN EXPORT VIEW TAKES NO DECISIONS, and the panels are the one door that
     * can still reach this line (the paper's own gestures are all behind the
     * edition guards). The sentence says where editing lives rather than the
     * push vanishing — a click that does nothing silently is the failure this
     * app keeps refusing to ship.
     */
    if (this.viewing()) {
      this.notices.notice.set(
        'This tab shows a finished export. To change the book, open it from its step in the tree '
        + 'and export again.',
      );
      return;
    }
    /*
     * AND ANY DECISION AT ALL PUTS THE PANE BACK ON THE BENCH.
     *
     * Nothing on the paper can reach this line while the edition is on — every
     * gesture up there is guarded — so what this is actually about is THE
     * PANELS. Notes, Furniture review and Chapters live in the shell, they keep
     * drawing the workbench's truth while the preview is up (they are workshop
     * tools, RENDERER-DESIGN.md §5), and each of them pushes onto this very list.
     * A strike minted from a panel would otherwise land on a page that does not
     * draw strikes: the row would simply vanish, with no cancel mark anywhere
     * saying a person had done that.
     *
     * ONE RULE FOR EVERY DOOR, stated once, here, rather than at each panel:
     * a change to the book is made where changes are visible. Setting the signal
     * to what it already holds is nothing (`signal` compares), so this costs the
     * ordinary case exactly nothing.
     */
    this.mode.set('workbench');
    this.pending.update((held) => [...held, ...ops]);
    this.undone.set([]);
    this.remember();
  }

  /**
   * THE STACK, TOWARDS THE DISK — called by every gesture that changes it.
   *
   * ── Three callers and not an effect, deliberately ───────────────────────────
   *
   * `push`, `undo` and `redo` are the whole of what a person can do to this list;
   * `load` and `apply` are the other two writers and neither of them is a change
   * somebody made — one is the disk arriving and the other is the disk being
   * written — so both say what they mean for themselves. An effect over
   * `pending()` would have been shorter and would have fired DURING a load, while
   * the old book's stack was still standing and the new book's had not been
   * hydrated yet, writing one book's decisions into another book's sidecar.
   *
   * WHAT IS SENT IS THE DIFFERENCE, not the list: `kept` is how much of the tip's
   * recorded ops the working list still begins with, and the tail is what was made
   * since (`PendingStack`, shared/ops.ts — its comment has the identity argument
   * for why a faithful `{landed, pending}` could not survive the round trip).
   *
   * AN EXPORT VIEW REMEMBERS NOTHING. It has no position, no stack and no project
   * pointer to be a delta against; the guard is the same one `push` states.
   *
   * ── ONE SIDECAR PER PROJECT, AND THE ONE CASE THAT COSTS ───────────────────
   *
   * The file is `ops/pending.jsonl` — one per project, because there is one book
   * pane per project and one pointer for it to be standing on. That makes exactly
   * one sequence lossy, and it is named here rather than discovered: work held at
   * step A, the pointer moved to step B by some other route (the tree, another
   * window, a reopened app), and then a gesture made at B. The read at B refuses
   * the held stack OUT LOUD and says where it is — *"stand on the step you made
   * them at to pick them up"* — and the first gesture afterwards writes over it.
   * So it is announced rather than silent, and the announcement comes before the
   * overwrite rather than after. Closing it completely would mean a file per step
   * (`pending.<id8>.jsonl`), which is a different design with orphans of its own
   * — no step names those files, so no sweep would ever take them — and it is not
   * what this fix was asked for.
   */
  private remember(): void {
    if (this.viewing()) return;
    const landed = this.landedOps();
    const held = this.pending();
    let kept = 0;
    while (kept < landed.length && kept < held.length && landed[kept] === held[kept]) kept += 1;
    this.stacks.rememberPending(this.tab().path, {
      kept,
      tail: held.slice(kept),
      undone: this.undone(),
    });
  }

  /**
   * Ctrl+Z, routed from `BookStacksService.replay`. Pops one op; never touches a disk.
   *
   * ── THE CHORD FLIPS TO THE BENCH FIRST, AND THAT WAS A CHOICE ──────────────
   *
   * The stack is mode-independent — it is a list of ops and the edition is a
   * projection — so a chord COULD be performed where it was pressed. It is not,
   * because most of what an undo does is invisible in a preview: taking back a
   * text edit, a relabel or a chapter rename changes a page the edition draws
   * exactly as it drew it before, and taking back a strike makes a paragraph
   * appear out of nowhere with nothing on the page saying it was ever cancelled.
   * An undo somebody cannot see the result of is an undo they press twice.
   *
   * So it lands where its marks are, which is also the rule `push` states for
   * every other decision on this book: one answer for taking something back and
   * for doing it in the first place.
   */
  protected undo(): void {
    const held = this.pending();
    const last = held[held.length - 1];
    if (last === undefined) return;
    this.mode.set('workbench');
    this.pending.set(held.slice(0, -1));
    this.undone.update((taken) => [...taken, last]);
    // Taking a change back is a change to what is waiting. A sidecar that only
    // ever grew would hold decisions the person has taken off the page.
    this.remember();
  }

  /** Ctrl+Shift+Z / Ctrl+Y. Puts the last-undone op back where it was. */
  protected redo(): void {
    const taken = this.undone();
    const last = taken[taken.length - 1];
    if (last === undefined) return;
    this.mode.set('workbench');
    this.undone.set(taken.slice(0, -1));
    this.pending.update((held) => [...held, last]);
    this.remember();
  }

  /** What the button says. The count is IN the label, on `labelFor`'s rule. */
  protected applyLabel(): string {
    const many = this.waiting();
    return many === 1 ? 'Apply 1 change' : `Apply ${many} changes`;
  }

  /**
   * APPLY — the stack, landed as a step.
   *
   * ── What happens afterwards, and why nothing here does it ───────────────────
   *
   * Main writes the ops file, lands an `edit` step as a child of the position and
   * moves the pointer onto it (`applyBookOps`, electron/book.ts). Adopting the
   * answer is all this does: `LedgerService.adopt` paints the history main handed
   * back, the position effect in `PositionSyncService` notices a picture it has not shown
   * (`positionPicture` carries the edit chain for exactly this), and that bumps
   * this tab's revision — which reloads the book with the ops on its CHAIN and
   * clears the stack on the way. Clearing it here as well would be this component
   * doing by hand the thing the round trip proves, and would put the unedited book
   * on screen for the turns in between (see `landed`, which is what carries the
   * one fact across that gap).
   *
   * A REFUSAL LEAVES THE STACK EXACTLY WHERE IT IS, with main's sentence on the
   * notice strip. The changes are still on the paper in front of the person, which
   * is the only honest state for a write that did not happen — and the closing
   * question, which can call this, needs the false answer to keep the tab open.
   */
  protected async apply(): Promise<boolean> {
    if (api === null || this.waiting() === 0 || this.applying()) return false;
    // A block still live when Apply is pressed has words in it nobody has
    // recorded yet. Committing first is what makes "apply what is on screen"
    // true rather than "apply what was on screen before you started typing".
    this.commitEditing();
    const ops = this.pending();
    this.applying.set(true);
    try {
      /*
       * ── AMEND THE TIP, OR LAND A STEP — the consolidation ruling ────────────
       *
       * Standing on an edit step nothing has been made from (`landedOps`
       * non-empty means the load found one), Apply rewrites that step to the
       * list as it now stands; the pointer never moves, no reload fires, and
       * the stack simply becomes the recorded state — undo still reaches back
       * through all of it. Everywhere else, Apply lands a new step exactly as
       * it always has, the pointer follows, and the reload's hydration is what
       * makes the NEXT Apply an amendment.
       *
       * An amendment can also RECORD ONLY REMOVALS: undo below the applied
       * boundary leaves pending shorter than landed, `waiting()` counts it,
       * and the rewrite is how the removal reaches the disk.
       */
      const amending = this.landedOps().length > 0;
      const history = amending
        ? await api.book.amend(this.tab().path, ops)
        : await api.book.apply(this.tab().path, ops);
      if (amending) {
        this.landedOps.set(ops);
      } else {
        this.landed = true;
      }
      /*
       * ── THE SIDECAR GOES, AND IT GOES BEFORE THE RELOAD ────────────────────
       *
       * These decisions are a step now, so the held copy is a duplicate — and a
       * duplicate that would be offered back as a recovery on the next open, as a
       * delta against a book that already has it. Awaited rather than fired,
       * because the very next thing that happens is `ledger.adopt` → a pointer
       * move → a reload, and that reload ASKS FOR THIS FILE; a clear still in
       * flight would race it.
       *
       * ONE OF THE TWO SANCTIONED SCRAPS (`discardPending` names both). It is
       * safe here in a way it is nowhere else: main has already answered, so the
       * work is on disk in the one place that outlives everything.
       */
      await this.stacks.discardPending(this.tab().path);
      this.ledger.adopt(this.tab().path, history);
      return true;
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.applying.set(false);
    }
  }

  /**
   * DISCARD — the stack taken off the page, on somebody's own say-so.
   *
   * ── Whose gesture this is, and what it is NOT ──────────────────────────────
   *
   * There is no button on this surface that calls it. The only caller is
   * `BookStacksService.discardUnapplied`, which is the Discard answer to the card
   * Owen's ruling put in front of every act (2026-08-22): *"if they hit discard,
   * it does whatever action they selected to the step theyre on after dropping
   * changes they made."* The pane is one of the three places that stack lives —
   * the parked copy and the project's sidecar are the other two — and the service
   * empties all three in one call, because "discarded" changes that come back on
   * the next gesture or the next open are not discarded.
   *
   * ── BACK TO THE RECORDED BOOK, NOT TO AN EMPTY ONE ─────────────────────────
   *
   * `pending` starts life as a COPY of the tip's own ops when the position is an
   * amendable edit step (see `load`), which is what makes `waiting()` a
   * difference rather than a length. So the way back is `landedOps` — put the
   * list where the disk has it — and that is the same arithmetic read the other
   * way round: after this, `unwritten(landed, pending)` is zero by construction,
   * for a tip with ops and for a position without one alike. Setting an empty
   * array instead would have thrown away applied history on an amendable step and
   * then offered the removal to the next Apply as a decision nobody made.
   *
   * ── THE LIVE EDITOR GOES WITH IT, UNCOMMITTED ──────────────────────────────
   *
   * `apply` commits the block being retyped first, because "apply what is on
   * screen" has to include the words under the caret. This does the opposite for
   * the same reason: those words are unapplied work too, and committing them here
   * would push a text op onto a stack one microtask before it is emptied — or,
   * worse, after. `editingId` is dropped rather than blurred, so the editor
   * element is torn out of the view and its `blur` handler never runs.
   *
   * ── AND IT DOES NOT WRITE THE SIDECAR ──────────────────────────────────────
   *
   * No `remember()` here, deliberately, and it is not an omission the next reader
   * should fix. The caller clears the file immediately afterwards — which also
   * cancels the debounced write this pane may already owe — so a `remember` would
   * be one write racing one delete over a stack nobody wants. The next real
   * gesture writes the honest state.
   */
  protected discardStack(): void {
    this.editingId.set(null);
    this.renaming.set(null);
    this.mode.set('workbench');
    this.pending.set([...this.landedOps()]);
    this.undone.set([]);
    // Both cards are about a paragraph whose marks may have just changed under
    // them — `load`'s own reason for putting them down.
    this.dismissCards();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The four gestures
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * DELETE STRIKES — and Delete again, over the same blocks, brings them back.
   *
   * *"if i click them and hit delete again, it should un-delete them."* One key,
   * both directions, decided by what is under it: a selection with anything
   * unstruck in it is a person saying "remove these", so the unstruck ones are
   * struck and the ones already cancelled are left alone (striking them twice
   * would be two ops for one state, and the second would be the op undo takes
   * back first). A selection where EVERY block is already struck is the only
   * reading of the gesture left, and it restores them.
   *
   * BACKSPACE TOO, because on a surface with no text field in focus the two keys
   * mean one thing to a hand, and a gesture that worked on one keyboard's Delete
   * and not on a laptop's is a gesture half the users do not have.
   *
   * NOT WHILE A BLOCK IS LIVE. Delete inside a caret is a character, and it
   * belongs to the editor.
   */
  protected cancel(event: Event): void {
    if (this.editingId() !== null) return;
    /*
     * A KEY PRESSED INTO ANY EDITABLE ON THE SHEET IS THAT EDITABLE'S. The
     * block editor is guarded above by its signal, and the chapter chip's
     * rename was not: its Backspace bubbled here, found the selection still
     * standing from before the double-click, and un-deleted a struck block
     * while the person was erasing letters of a title (user report,
     * 2026-08-16). The target's own word for itself is the general guard —
     * any contenteditable this sheet ever grows is covered the day it lands.
     */
    const target = event.target as HTMLElement | null;
    if (target !== null && target.isContentEditable) return;
    const chosen = this.chosen();
    if (chosen.size === 0) return;
    event.preventDefault();
    /*
     * AND IN THE EDITION IT ONLY FLIPS (§5). Delete is the plainest edit gesture
     * on this surface and the preview is read-only, so the press buys the mode it
     * needs rather than the strike it asked for — and the selection it would have
     * struck is still exactly what it was, drawn again with its rails and chips,
     * so pressing Delete once more does the thing. NOTHING IS FOCUSED because
     * nothing single was named: a Delete is about a selection, and the selection
     * is what comes back.
     */
    if (this.edition()) {
      this.mode.set('workbench');
      return;
    }
    const replayed = this.view();
    if (replayed === null) return;
    const struck = new Set(replayed.rows.filter((row) => row.struck === true).map((row) => row.id));
    const picked = replayed.rows.filter((row) => chosen.has(row.id));
    const unstruck = picked.filter((row) => !struck.has(row.id));
    this.push(...(unstruck.length > 0
      ? unstruck.map((row): BookOp => ({ op: 'strike', id: row.id }))
      : picked.map((row): BookOp => ({ op: 'restore', id: row.id }))));
  }

  /**
   * Double-click puts the caret in the block.
   *
   * THE BLOCK ITSELF BECOMES THE EDITOR and the marker cuts go away for the
   * duration, because what is being edited is the SOURCE STRING — the superscript
   * digits and the `*markers*` are characters in it (docs/RENDERER.md §2), and an
   * editor that hid them would be an editor somebody could not put a reference
   * number back into. The cut pieces come back the moment it commits, re-derived
   * against the new words.
   *
   * A SHELVED ROW IS NOT EDITABLE HERE because it is not drawn here; a struck one
   * is, deliberately — striking is a state and not a removal, and correcting a
   * paragraph you have cancelled is an ordinary thing to do on the way to
   * restoring it.
   */
  protected edit(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const block = target === null ? null : target.closest('.block');
    const id = block === null ? null : block.getAttribute('data-id');
    this.beginEditing(id);
  }

  /**
   * Enter the editor on a named block — the shared destination of the two
   * doors that open it: a double-click on the block, and the right-click
   * menu's Edit. Two doors because a double-click has other meanings nearby
   * (the chapter chip renames, a note's first click raises the peek card),
   * and a person whose double-click landed on one of those needs a door that
   * cannot be misread.
   */
  private beginEditing(id: string | null): void {
    if (id === null || id === this.editingId()) return;
    // §5's sentence, exactly: the block is named, so the block is what comes back
    // focused. See `toBench` for why the caret does not come with it.
    if (this.edition()) {
      this.toBench(id);
      return;
    }
    this.commitEditing();
    this.editingId.set(id);
    this.chosen.set(new Set([id]));
    /*
     * FOCUSED AFTER THE FRAME THAT DRAWS IT. The editor element does not exist
     * until the template has re-run for the new `editingId`, and this app is
     * ZONELESS — so "after change detection" is a thing only Angular can promise,
     * and a `setTimeout` or a microtask here would be a guess about the
     * scheduler's own ordering. `afterNextRender` is that promise, and it needs
     * the injector because this runs from an event handler rather than from a
     * construction context.
     *
     * THE CARET GOES TO THE END rather than selecting the paragraph. A
     * double-click that highlighted every word would make the next keystroke
     * delete the block, which is a gesture nobody asked for arriving through one
     * they did.
     */
    afterNextRender(() => {
      const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
      if (editor === null) return;
      editor.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, { injector: this.injector });
  }

  /**
   * Blur commits — the pair the app's other in-place editor already uses.
   *
   * The in-place editors this app has had all commit on Enter or blur and cancel
   * on Escape — three endings a person learns once. Two of the three are kept
   * verbatim here. ENTER IS THE THIRD AND IT DOES NOT COMMIT: it is the
   * SPLIT (docs/RENDERER.md §5), which commits the words as its own op on the way
   * past and then cuts them — see `split`, which is the only other place a `text`
   * op is minted and mints it for exactly this reason.
   *
   * ONE OP, AND ONLY IF THE STRING MOVED. A double-click that put a caret
   * somewhere and then went away has decided nothing, and a step recording it
   * would be a row in somebody's history about a paragraph they looked at.
   */
  protected commit(id: string, event: Event): void {
    if (this.editingId() !== id) return;
    const editor = event.target as HTMLElement;
    // `textContent` and not `innerText`: the second one is a rendering — it folds
    // whitespace and inserts breaks the layout implies — and what is being read
    // back is a source string that must survive a round trip unchanged.
    const said = editor.textContent ?? '';
    this.editingId.set(null);
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.text === said) return;
    /*
     * AND ON A TRANSLATED POSITION THE WORDS ARE NOT AN OP.
     *
     * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
     * §5.) The words of a translated block belong to the records file — the
     * translate step's own payload, and the truth every derived book of it is a
     * pure function of — so a `text` op here would put this sentence in the ops
     * chain while the records still held the machine's, and the next time anything
     * materialised this translation it would answer with the machine's. Two truths
     * about one paragraph, which is the failure `translationWorldOf` was built to
     * make impossible one surface over.
     *
     * Everything else this sheet can do to a translated block IS an op and stays
     * one: striking it, relabelling it, joining it, cutting it, putting a division
     * above it. Those are decisions about the book's STRUCTURE, and a translation
     * has the same structure as the book it came from.
     */
    if (this.translation() !== null) {
      void this.correct(id, said);
      return;
    }
    this.push({ op: 'text', id, text: said });
  }

  /**
   * ONE CORRECTED PARAGRAPH, RECORDED — the round trip, and what comes back.
   *
   * ── The order, which is main's and is not negotiable from here ─────────────
   *
   * Main appends the row to the records file, materialises the derived book again
   * from it, and answers with the whole book (`correctBookBlock`, electron/book.ts).
   * There is nothing for this side to apply: the corrected words arrive as ROWS,
   * which is the only shape that keeps one account of them.
   *
   * ── THE STACK SURVIVES, and that is the point of reloading rows and not the
   * pane ──────────────────────────────────────────────────────────────────────
   *
   * `load` scraps the stack because it is called when the POSITION moved and the
   * ops on it are a delta against a book somebody left. Nothing moved here: the
   * same position, the same chain, one block's text different underneath. Every op
   * waiting on the stack is keyed by block id and none of them names a row that
   * stopped existing, so they replay onto the new rows exactly as they were
   * replaying onto the old ones — which is what `view()` does on the next frame
   * without being asked.
   *
   * ── The refusal, and what the person sees ──────────────────────────────────
   *
   * Main rejects with a sentence (a book that is not a translation, a block the
   * file does not hold, a run writing the records right now) and it goes to the
   * notice strip, where the rest of this window says what it would not do. The
   * paragraph is already showing its recorded words again by then, because the
   * editor closed before this call and nothing pushed an op — so the sentence is
   * the only thing standing between the person and a correction that vanished, and
   * main's own words say so.
   */
  private async correct(id: string, text: string): Promise<boolean> {
    if (api === null) return false;
    /*
     * ONE AT A TIME, AND THE SECOND ONE IS TOLD SO. Two corrections in flight
     * would be two whole-file rewrites of one records file racing each other, and
     * the loser's paragraph would be gone with no sign of it anywhere. It is a
     * round trip of a moment, so this is a rare thing to meet — which is exactly
     * why it must not be met in silence: a paragraph that quietly reverted to the
     * machine's words is the failure this whole door exists to prevent.
     */
    if (this.correcting) {
      this.notices.notice.set(
        'The last corrected paragraph is still being written into this translation\'s records, so '
        + 'this one was not — it is showing its recorded words again. Make the edit once more.',
      );
      return false;
    }
    const ticket = this.asked;
    this.correcting = true;
    try {
      const answered = await api.book.correct(this.tab().path, id, text);
      // The pane was pointed somewhere else while this was in flight: the answer is
      // about a book that is no longer on screen. `load`'s own ticket, for its
      // reason.
      if (ticket !== this.asked) return false;
      if (answered.ok) {
        this.book.set(answered);
        return true;
      }
      // The correction landed and the book could not be read back — main's
      // sentence goes on the paper, which is where a book that cannot be drawn
      // says why (`load`).
      this.problem.set(answered.reason);
      return false;
    } catch (err) {
      if (ticket !== this.asked) return false;
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.correcting = false;
    }
  }

  /**
   * Escape reverts: the words go back and the blur that follows finds nothing
   * changed.
   *
   * NO FLAG AND NO SECOND PATH. Putting the source string back into the element
   * BEFORE letting go of focus means the commit above compares the text to
   * itself, decides nothing happened and pushes nothing — one ending, reached two
   * ways, rather than two endings that have to be kept agreeing with each other.
   */
  protected revert(text: string, event: Event): void {
    const editor = event.target as HTMLElement;
    editor.textContent = text;
    editor.blur();
  }

  /** The live block, put to bed — for Apply, and for opening another editor. */
  private commitEditing(): void {
    const id = this.editingId();
    if (id === null) return;
    const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
    if (editor === null) {
      this.editingId.set(null);
      return;
    }
    // Through the same ending a person's own blur takes, so there is one place
    // that decides whether a text op is owed.
    editor.blur();
  }

  /**
   * The margin chip's list of categories.
   *
   * FIXED-POSITIONED FROM THE CHIP'S OWN RECTANGLE, which is why the event is
   * needed rather than only the id: the menu is `position: fixed` (the app's own
   * `.menu`, so the scrim can be a full-window one) and the chip is inside a
   * scrolling bench, so the only honest anchor is where the chip is at the moment
   * it is pressed.
   */
  protected openCategories(event: MouseEvent, id: string): void {
    event.stopPropagation();
    const chip = event.currentTarget as HTMLElement;
    const box = chip.getBoundingClientRect();
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    this.menu.set({ id, category: row?.category ?? '', x: box.left, y: box.bottom + 4 });
  }

  /** One choice, one op — and nothing at all for choosing what it already is. */
  protected relabel(id: string, category: string): void {
    this.menu.set(null);
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.category === category) return;
    this.push({ op: 'category', id, category });
  }

  /**
   * The right-click menu: two verbs about every block of this one's kind.
   *
   * The lists are computed AT OPEN over the flowing lines the sheet is drawing,
   * so the counts in the labels are the counts the verbs will act on — a menu
   * that counted at click time could say a number the replay had since moved.
   * In the edition, and inside any editable, the browser keeps its own menu:
   * the preview offers no verbs, and a caret's right-click is the caret's.
   */
  protected readonly context = signal<{
    x: number;
    y: number;
    /** The block under the pointer — the menu's block-scoped verbs act on it. */
    id: string;
    /**
     * True when a division already starts at this block, so the menu does not
     * offer to add one that is already there. \`set\` would legally retitle it
     * (ChapterSetOp says so on purpose), but a menu item that RENAMES under a
     * label that says ADD is the kind of quiet lie the chip's own double-click
     * rename exists to make unnecessary.
     */
    chapter: boolean;
    colour: string;
    plural: string;
    ids: string[];
    unstruck: string[];
  } | null>(null);

  protected blockMenu(event: MouseEvent, line: Line): void {
    if (this.edition()) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && target.isContentEditable) return;
    event.preventDefault();
    event.stopPropagation();
    this.peek.set(null);
    const kin = this.lines().filter((one) => one.row.category === line.row.category);
    this.context.set({
      x: event.clientX,
      y: event.clientY,
      id: line.row.id,
      chapter: line.chapter !== null,
      colour: line.colour,
      // "Text" pluralises into nonsense; every other category reads naturally.
      plural: line.row.category === 'Text' ? 'text blocks' : `${line.label.toLowerCase()}s`,
      ids: kin.map((one) => one.row.id),
      unstruck: kin.filter((one) => one.row.struck !== true).map((one) => one.row.id),
    });
  }

  /** The menu's Edit: close the menu, open the same editor double-click does. */
  protected editFromMenu(): void {
    const open = this.context();
    this.context.set(null);
    if (open === null) return;
    this.beginEditing(open.id);
  }

  /**
   * The menu's "add a chapter marker": a division above the block, titled with
   * the block's own first line.
   *
   * THE SEED IS THE PANEL'S SEED, deliberately (`makeSheetChapter`,
   * inspector.component.ts): it is right far more often than any other guess,
   * it is exactly what the detection would have called it, and it is a starting
   * point rather than a rule — the chip is renameable the moment it appears.
   * One op, so Ctrl+Z takes the whole gesture back.
   */
  protected chapterFromMenu(): void {
    const open = this.context();
    this.context.set(null);
    if (open === null || open.chapter) return;
    const row = this.view()?.rows.find((one) => one.id === open.id);
    if (row === undefined) return;
    const words = row.text.split('\n')[0]?.trim() ?? '';
    this.push({ op: 'chapter', set: open.id, title: words.slice(0, 120) });
  }

  /**
   * The chip's ✕ — the division above this block, taken away where it is drawn.
   * The op the Chapters panel's remove has always pushed (`dropSheetChapter`),
   * said from the paper: the block stays, the rule goes, and undo brings it
   * back title and all because the title travels with the op it reverses.
   */
  protected dropChapter(id: string): void {
    this.push({ op: 'chapter', remove: id });
  }

  /** The selection becomes the category — rails up, chips up, Delete waiting. */
  protected selectSimilar(): void {
    const open = this.context();
    this.context.set(null);
    if (open === null) return;
    this.chosen.set(new Set(open.ids));
  }

  /**
   * The one-press destination: every unstruck block of the kind, cancelled.
   * One op per block, exactly what selecting them and pressing Delete would
   * push — so undo takes it back the same way, one gesture's worth at a time.
   */
  protected strikeSimilar(): void {
    const open = this.context();
    this.context.set(null);
    if (open === null) return;
    if (open.unstruck.length === 0) return;
    this.push(...open.unstruck.map((id): BookOp => ({ op: 'strike', id })));
    this.chosen.set(new Set(open.unstruck));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The structure gestures
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * THE SEAM, PRESSED — *"the report becomes a control"* (RENDERER-DESIGN.md §4).
   *
   * The block the later page opens with goes INTO the block the earlier page ends
   * at, which is the asymmetry the op is built around: the earlier of the two
   * keeps its name, because it is the one every marker, chapter and earlier op is
   * already keyed to (`MergeOp`). The seam then stops being drawn because one of
   * its halves is no longer in the flow — nothing hides it, it simply has nothing
   * left to hang on.
   *
   * THE MOTION IS THE DOM CHANGE AND NOTHING IS BUILT FOR IT. §4 asks that the
   * blocks slide together over `--t-med`; the sheet sets no vertical margins
   * between body blocks (print convention, §2), so what actually closes is the
   * seam's own line — and animating two paragraphs into one across a re-render
   * would take a FLIP measurement pass, which is machinery this surface has been
   * told not to grow. The join reads perfectly as a still, which is §6's own
   * standard for every state here.
   */
  protected join(before: string, into: string): void {
    // A block still live has words in it nobody has recorded; committing first is
    // what keeps the join a join rather than a join that eats an edit.
    this.commitEditing();
    this.push({ op: 'merge', id: before, into });
    this.chosen.set(new Set([into]));
  }

  /**
   * Ctrl+J — the same join, over two blocks somebody picked.
   *
   * ── The chord, chosen out loud ──────────────────────────────────────────────
   *
   * This app had no join key to inherit: nothing in the window binds a modifier
   * chord to anything, so there was no precedent to keep faith with and Ctrl+J is
   * a choice rather than a convention. It is the word-processor chord for exactly
   * this act, it is not a menu accelerator main swallows, and Cmd+J rides beside
   * it because a Mac hand does not reach for Ctrl.
   *
   * ── THE LATER BLOCK MERGES INTO THE EARLIER, always ─────────────────────────
   *
   * Reading order decides, not click order. A person picking two paragraphs has
   * said which two; they have not said which of them is the survivor, and the
   * grammar has an answer that does not depend on the order a hand happened to
   * click in (`MergeOp`, and `join` above).
   *
   * ── Refused with a sentence, three ways ─────────────────────────────────────
   *
   * Not two blocks; not neighbours in the flow; or one of them is a note. All
   * three go to the window's notice strip rather than being minted and left for
   * the replay to file in `missing`, because an op that lands there puts a line in
   * the margin the person cannot clear — and the third of them is the replay's own
   * refusal said before the fact rather than after it.
   */
  protected joinChosen(event: Event): void {
    // A caret owns every key while it is in the words, and a chapter name owns
    // them while it is being typed.
    if (this.editingId() !== null || this.renaming() !== null) return;
    event.preventDefault();
    // The third of the edit gestures a keyboard can still reach in the edition,
    // and it takes the same ending Delete does: the mode, not the join. The two
    // blocks somebody picked are still picked.
    if (this.edition()) {
      this.mode.set('workbench');
      return;
    }
    const replayed = this.view();
    if (replayed === null) return;
    const picked = [...this.chosen()];
    if (picked.length !== 2) {
      this.notices.notice.set(
        'Joining is a decision about two blocks: pick the paragraph that ends and the one that '
        + 'carries on from it, then press it again.',
      );
      return;
    }
    const pair = flowNeighbours(replayed.rows, picked[0]!, picked[1]!);
    if (pair === null) {
      this.notices.notice.set(
        'Those two blocks do not sit next to each other in the book, and joining them would put '
        + 'words from either side of whatever stands between them into one paragraph.',
      );
      return;
    }
    const held = new Map(replayed.rows.map((row) => [row.id, row] as const));
    const note = [pair.earlier, pair.later].some((id) => held.get(id)?.category === 'Footnote');
    if (note) {
      this.notices.notice.set(
        'A note is one piece of apparatus, printed whole at the foot of its page. Joining one to '
        + 'anything is not a repair this program offers.',
      );
      return;
    }
    this.push({ op: 'merge', id: pair.later, into: pair.earlier });
    this.chosen.set(new Set([pair.earlier]));
  }

  /**
   * ENTER AT THE CARET CUTS THE PARAGRAPH IN TWO — the gesture this surface has
   * owed since the in-place editor landed.
   *
   * ── Why the words are committed first, as their own op ──────────────────────
   *
   * `SplitOp.at` is an offset into the block's text AS THE OPS BEFORE IT LEFT IT.
   * Somebody who retyped half a sentence and then put the caret in the middle of
   * what they typed is asking for a cut in the NEW words, and a split pushed on
   * its own would be measured against the old ones — the same offset, a different
   * string, a cut in the wrong place. So the text op goes first when the string
   * moved, and the split's offset is an offset into exactly what that op wrote.
   *
   * ── The offset is measured against the SOURCE STRING ────────────────────────
   *
   * The editor edits the model's source string directly — no rendering, no marker
   * cuts, `plaintext-only` — so the characters in the element are the characters
   * in the op, and `caretOffsetIn` counts them the same way `textContent` does.
   *
   * ── AND A CUT AT EITHER END IS REFUSED HERE rather than minted ──────────────
   *
   * The replay refuses a cut that would leave one half with nothing in it, and it
   * refuses it into `missing`, where the person cannot clear it. Enter at the end
   * of a paragraph is the most ordinary keystroke in any editor, so it must not be
   * a way to put a permanent line in the margin: it is answered with a sentence
   * and no op at all.
   */
  protected split(id: string, event: Event): void {
    /*
     * ALWAYS PREVENTED, including on every refusal below. A block is prose and the
     * one thing Enter now means here is a cut, so a refused cut must not fall
     * through into `plaintext-only`'s own line break — which would leave a
     * character in the words as the trace of a gesture that did nothing.
     */
    event.preventDefault();
    if (this.editingId() !== id) return;
    const editor = event.target as HTMLElement;
    const said = editor.textContent ?? '';
    const at = caretOffsetIn(editor);
    if (at === null) {
      this.notices.notice.set(
        'A paragraph is cut where the caret is, and there are words selected rather than a caret '
        + 'in them. A cut cannot also delete what is highlighted.',
      );
      return;
    }
    if (at <= 0 || at >= said.length) {
      this.notices.notice.set(
        `The caret is at the very ${at <= 0 ? 'start' : 'end'} of this paragraph, and cutting there `
        + 'would leave one of the two halves with nothing in it.',
      );
      return;
    }
    const row = this.view()?.rows.find((candidate) => candidate.id === id);
    if (row === undefined) return;
    /*
     * THE EDITOR CLOSES BEFORE THE OPS GO ON, and it closes rather than moving:
     * the block being typed into is about to stop existing and its halves are two
     * names nobody has seen yet. `commit` guards on this signal, so the blur that
     * follows the element being taken out finds the edit already accounted for and
     * pushes nothing.
     */
    this.editingId.set(null);
    // The two halves, selected — the cut shown as two blocks rather than left for
    // the reader to find in a page of prose that looks much as it did.
    const halves = new Set([`${id}/1`, `${id}/2`]);
    /*
     * ── A CUT ON A TRANSLATED POSITION, WHERE THE WORDS MOVED TOO ─────────────
     *
     * The cut itself is an ordinary op — structure is structure in either language
     * — but the words this cut is measured against are the RECORDS' (see `commit`),
     * so the pair cannot be pushed together. The correction goes first and is
     * WAITED FOR, and the split follows only if it landed: `at` is an offset into
     * the string the person typed, so a split pushed over words the records still
     * hold would cut a different sentence at the same number.
     *
     * A correction that main refused takes the cut down with it, deliberately.
     * Half of this gesture is not a smaller version of it — it is a paragraph cut
     * in two at an offset nobody chose.
     */
    if (this.translation() !== null) {
      if (row.text === said) {
        this.push({ op: 'split', id, at });
        this.chosen.set(halves);
        return;
      }
      void this.correct(id, said).then((recorded) => {
        if (!recorded) return;
        this.push({ op: 'split', id, at });
        this.chosen.set(halves);
      });
      return;
    }
    const ops: BookOp[] = [];
    if (row.text !== said) ops.push({ op: 'text', id, text: said });
    ops.push({ op: 'split', id, at });
    this.push(...ops);
    this.chosen.set(halves);
  }

  /**
   * Double-click a chapter chip and type the division's name into it.
   *
   * *"Double-click the chip to rename in place"* — RENDERER-DESIGN.md §4, and it
   * is a RENAME rather than a set: the chip only exists where a division already
   * does, so there is nothing here to create. Setting a division at a block that
   * has none is the panel's gesture, because the block it would go above is the
   * one somebody has selected and that is a thing the panel can say.
   *
   * The rule is also DRAGGABLE now — `grabRule` and its family below — which
   * ends the deferral that used to be argued here (user ruling, 2026-08-16:
   * *drag the marker to where it belongs*). The panel's remove-then-set stays
   * as the keyboard-honest alternative.
   */
  protected rename(id: string, event: Event): void {
    event.stopPropagation();
    this.commitEditing();
    this.renaming.set(id);
    /*
     * FOCUSED AFTER THE FRAME THAT DRAWS IT, for `edit`'s reason exactly: the chip
     * that can take a caret does not exist until the template has re-run, and this
     * app is zoneless, so `afterNextRender` is the only honest promise about when
     * that has happened. THE WHOLE NAME IS SELECTED rather than the caret placed —
     * the inspector's own rename box does the same, and a title is short enough
     * that replacing it is the common case.
     */
    afterNextRender(() => {
      const chip = this.host.nativeElement.querySelector('.chapter-chip.naming') as HTMLElement | null;
      if (chip === null) return;
      chip.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(chip);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, { injector: this.injector });
  }

  /**
   * Enter or blur commits the name — the two endings the block editor already
   * taught this surface, and Escape below is the third.
   *
   * AN EMPTY NAME IS REFUSED, and it is the one place this component declines
   * something the grammar allows. The file format accepts a division with no words
   * over it on purpose — a rule across the page is a real typographic decision —
   * but a chip with nothing on it is a chip nobody can double-click again, so
   * agreeing to it here would be building the only edit on this sheet that cannot
   * be taken back by the gesture that made it. The sentence says the other door.
   */
  protected commitChapter(id: string, was: string, event: Event): void {
    event.preventDefault();
    if (this.renaming() !== id) return;
    const chip = event.target as HTMLElement;
    const said = (chip.textContent ?? '').trim();
    this.renaming.set(null);
    if (said === was) return;
    if (said.length === 0) {
      chip.textContent = was;
      this.notices.notice.set(
        'A chapter chip with no words on it could not be double-clicked again, so the division kept '
        + 'the name it had. Take the division away in the panel if the book should not divide there.',
      );
      return;
    }
    this.push({ op: 'chapter', rename: id, title: said });
  }

  /** Escape puts the name back, and the blur that follows finds nothing changed. */
  protected abandonChapter(was: string, event: Event): void {
    const chip = event.target as HTMLElement;
    chip.textContent = was;
    chip.blur();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Dragging a division — §4's rule lift, landed
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The division being carried: which one, where its hand is, and the block it
   * would land above right now. Null between drags, which is almost always.
   */
  protected readonly draggingRule = signal<{
    id: string;
    over: string | null;
    /** True once the pointer has cleared the slop — before that it is a click. */
    live: boolean;
    startY: number;
  } | null>(null);

  /**
   * A press on a chapter chip arms the drag without starting it.
   *
   * THE SAME SLOP AS THE MARQUEE separates the three things a chip press can
   * mean — a click (nothing), a double-click (the rename), a drag (the move) —
   * so a hand that only wanted to rename never sees the rule twitch. Pointer
   * capture on the chip itself, which is what lets the drag run the length of
   * the sheet without the sheet's own gestures waking.
   */
  protected grabRule(event: PointerEvent, id: string): void {
    event.stopPropagation();
    if (event.button !== 0) return;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    this.draggingRule.set({ id, over: null, live: false, startY: event.clientY });
  }

  /**
   * The carry: find the block whose head is nearest the pointer, and offer it.
   *
   * CANDIDATES ARE THE FLOWING BLOCKS THAT COULD HONESTLY TAKE A DIVISION — not
   * the one it already sits on, and not one already carrying its own, because
   * the replay would refuse both and a glow the drop cannot honour is a lie in
   * spruce. The hit test asks the DOM the same question the marquee asks
   * (`getBoundingClientRect` per block), which a drag's cadence affords.
   */
  protected dragRule(event: PointerEvent): void {
    const held = this.draggingRule();
    if (held === null) return;
    if (!held.live) {
      if (Math.abs(event.clientY - held.startY) < DRAG_SLOP) return;
    }
    const divisions = new Set((this.view()?.chapters ?? []).map((chapter) => chapter.id));
    let nearest: string | null = null;
    let distance = Number.POSITIVE_INFINITY;
    const sheet = this.host.nativeElement.querySelector('.bench .sheet');
    if (sheet === null) return;
    for (const element of sheet.querySelectorAll('.block[data-id]')) {
      const id = element.getAttribute('data-id');
      if (id === null || id === held.id || divisions.has(id)) continue;
      const gap = Math.abs(element.getBoundingClientRect().top - event.clientY);
      if (gap < distance) {
        distance = gap;
        nearest = id;
      }
    }
    this.draggingRule.set({ ...held, live: true, over: nearest });
  }

  /**
   * The drop: one `chapter move` op, or nothing where the hand never cleared
   * the slop or let go over no honest candidate. The rule settles into place
   * because the replay recomputes and the chip is drawn at its new block —
   * the state reads perfectly as a still, which is §6's own standard.
   */
  protected dropRule(event: PointerEvent): void {
    const held = this.draggingRule();
    this.draggingRule.set(null);
    if (held === null || !held.live) return;
    event.stopPropagation();
    if (held.over === null || held.over === held.id) return;
    this.push({ op: 'chapter', move: held.id, to: held.over });
  }
}

/**
 * How many characters into the editor's own text the caret is, or null when
 * there is no caret to measure — nothing focused here, or a RANGE rather than an
 * insertion point.
 *
 * COUNTED THE WAY `textContent` COUNTS. A `Range`'s own string is the data of the
 * text nodes it spans and nothing else, which is exactly what `textContent`
 * returns — so an offset measured here is an offset into the string `commit` reads
 * back, and the two cannot disagree about where character forty is. Walking the
 * child nodes by hand would be a second implementation of that arithmetic.
 *
 * A NON-COLLAPSED SELECTION IS NULL AND NOT ITS START. Enter with words
 * highlighted is a replace in every editor anybody has used, and a replace is not
 * a thing one op can say; answering "the caret is at the start of what you
 * highlighted" would perform a cut nobody asked for and leave the highlighted
 * words at the top of the second half.
 */
function caretOffsetIn(editor: HTMLElement): number | null {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

/**
 * ONE PASS OVER A LIST OF ROWS — the book as a sheet draws it, whichever sheet.
 *
 * EVERYTHING THAT DEPENDS ON THE ROW BEFORE IS DECIDED HERE, in one pass, and not
 * in the template: whether a paragraph is indented (the first of the book and the
 * first after a heading are not — print convention, RENDERER-DESIGN.md §2), where
 * a page ghost belongs (only where the source page CHANGES), and which note opens
 * a page's group of them and so carries the hairline. A template asking those
 * questions per block would ask them again on every repaint.
 *
 * ── `chrome` IS THE WHOLE OF WHAT THE TWO COLUMNS DISAGREE ABOUT ────────────
 *
 * *"Chrome only on the live column."* The context sheet in the aligned view is
 * the paper, the serif and the measured sizes with no instrument on it at all —
 * no rules, no chips, no ordinals, no ghosts, no flags — because there is nothing
 * on that sheet a person can decide. It is ONE parameter rather than six empty
 * collections passed in, because six empty collections are six things that have to
 * stay empty and one boolean is a statement.
 *
 * The marker cutting is NOT under it: numbers are characters of the words, not
 * marks in a gutter, and both columns cut at the offsets the engine resolved
 * (`cut`, below — the one implementation, on both sheets).
 */
function linesOf(
  rows: readonly ReplayedRow[],
  marks: {
    printed: ReadonlyMap<string, Marker[]>;
    size: (category: string) => number;
    chapters: ReadonlyMap<string, string>;
    seams: ReadonlyMap<string, string>;
    orphans: ReadonlySet<string>;
    chrome: boolean;
  },
): Line[] {
  const out: Line[] = [];
  let previous: BookRow | null = null;
  let onPage = -1;
  for (const row of rows) {
    /*
     * THE SHELF IS IN THE FILE AND NOT ON THE PAPER — §5 of the contract: a
     * shelved row is a block the model answered and the book does not contain
     * (page furniture, a suppressed running head), kept at its reading-order
     * position so that restoring one is an op with an obvious answer for where.
     * The Furniture Review panel is its surface (R4); the flow is not.
     */
    if (row.shelf !== undefined) continue;
    const page = row.pages[0] ?? row.page;
    const ghost = page === onPage ? null : page;
    onPage = page;
    const chapter = marks.chapters.get(row.id) ?? null;
    const heading = previous !== null
      && (previous.category === 'Title' || previous.category === 'Section-header');
    const markers = marks.printed.get(row.id) ?? [];
    out.push({
      row,
      pieces: cut(row.text, markers),
      /*
       * READ ONCE, HERE, AND NEVER FROM THE TEMPLATE. Parsing a fragment is a
       * `DOMParser` document per call, and a template expression is re-evaluated
       * on every change detection — so a table asked for its grid from the
       * template would build one document per row per keystroke. This pass runs
       * when the replayed rows change, which is when the answer can change.
       */
      table: row.category === 'Table' ? readTable(row.text) : null,
      colour: pdfCategoryColour(row.category),
      label: pdfCategoryLabel(row.category),
      size: marks.size(row.category),
      ordinal: marks.chrome && row.note !== undefined ? row.note + 1 : null,
      jump: marks.chrome ? row.refs?.[0]?.block ?? null : null,
      ghost: marks.chrome ? ghost : null,
      chapter,
      // The bench draws divisions as rules and never as headings, and it spends
      // no air on them — the rule is the break.
      heading: null,
      opens: false,
      seamInto: marks.seams.get(row.id) ?? null,
      indent: row.category === 'Text' && previous !== null && !heading && chapter === null,
      /*
       * The hairline stands above the first note of a CHAPTER's collected
       * apparatus now, not a page's: `chapterOrder` has already gathered each
       * chapter's notes into one contiguous run, so "the previous row is not a
       * note" is the whole of the test, and the page clause that used to cut a
       * rule between page-groups would draw rules inside one apparatus.
       */
      opensNotes: row.category === 'Footnote'
        && (previous === null || previous.category !== 'Footnote'),
      // Both directions of the one structural flag this app still keeps
      // (docs/RENDERER.md §0, ruling 7). A note nothing points at first: it is
      // the whole row's problem, where a stray number is one word's.
      flag: !marks.chrome
        ? null
        : marks.orphans.has(row.id)
          ? 'nothing in the book carries this note'
          : markers.some((marker) => marker.note === null)
            ? 'no note carries this number'
            : null,
    });
    previous = row;
  }
  return out;
}

/** The measured size for this category, or the engine's own base sheet's. */
function sizeOf(book: BookLoad, category: string): number {
  const measured = book.typography?.categories[category];
  if (measured !== undefined) return measured.ratio;
  return BASE_RATIO[category] ?? 1;
}

/**
 * One block's text, cut at the reference numbers printed in it AND at every
 * change of the model's emphasis.
 *
 * BY OFFSET AND NEVER BY SEARCHING FOR THE DIGITS — the engine resolved these
 * with the page in front of it, and a marker found by matching text lands on
 * whichever occurrence of "1" came first. The markers arrive sorted, inside the
 * text and non-overlapping, all three PROVEN by the parser (`parseBookFile`,
 * shared/book.ts) rather than assumed here, which is what lets this be one
 * forward walk with nothing to decide.
 *
 * ── §18b: THE EMPHASIS IS AN EFFECT HERE AND CHARACTERS EVERYWHERE ELSE ─────
 *
 * The vision model writes `**bold**` and `*italic*` into a block's text, and
 * until now every layer of this program treated them as prose: the emitter has
 * turned them into `<strong>` and `<em>` since it was written, but this sheet
 * drew four asterisks around the name of every person who blurbed the book. The
 * user's ruling was that the effect should reach both — *"the bank should
 * display it correctly, basically."*
 *
 * **THE BANK AND THE BOOK FILE DO NOT CHANGE, AND THIS IS WHERE SOMEBODY WILL
 * BE TEMPTED.** The obvious tidy-up is to strip the markers once, at reflow,
 * and be done with them. It would corrupt every project already curated.
 * Foundry's edit ops index into block text BY CHARACTER OFFSET — a split names
 * a cut at an offset, a delete names `from` and `len`, a `BookRef` carries an
 * offset into the block it points into (shared/ops.ts, whose own comment says a
 * text edit invalidates every ref offset into that block). Taking four
 * characters out of a block moves every offset after them by four, and a replay
 * would then land that project's strikes and splits four characters off, on a
 * file nobody edited, with nothing raised. So the markers stay in the text, and
 * INTERPRETATION HAPPENS ONLY WHERE TEXT IS DISPLAYED — here, and in the
 * emitter. There is no third place.
 *
 * Which is why this is one function and not a second pass afterwards: the
 * reference-number offsets and the emphasis codes are both offsets into the
 * SAME source string, so the two cuts are interleaved in one walk and can never
 * disagree about which characters they are talking about. A run of the words
 * ends wherever either of them says it does.
 *
 * WHAT THE EDITOR SEES IS UNTOUCHED. The block editor renders `line.row.text`
 * verbatim, on the standing ruling that what is being edited is the model's
 * SOURCE STRING — asterisks and superscript digits included — and the caret
 * arithmetic a split is made from (`caretOffsetIn`) counts that string and not
 * this one. An edit therefore still commits exactly the characters the bank
 * holds, and the effect comes back the moment the editor closes.
 */
function cut(text: string, markers: readonly Marker[]): Piece[] {
  const codes = inlineEmphasis(text);
  if (markers.length === 0 && codes === null) {
    return [{ text, marker: null, strong: false, italic: false }];
  }

  const pieces: Piece[] = [];
  /*
   * ONE CURSOR OVER THE CHARACTERS, and a run is closed whenever anything about
   * it changes. It is ONE walk and not a marker walk with an emphasis walk
   * after it, because two walks over one string are two chances to disagree
   * about where character forty is — and it costs nothing to avoid, since a run
   * is never anything but a SLICE of the source: a dropped character always
   * closes the run, so no run ever has to span a gap.
   *
   * A `null` code array is the ordinary block with no emphasis in it, which is
   * most of the book: every character is plain, nothing is dropped, and the walk
   * reduces to exactly the marker cuts it has always made.
   */
  let start = 0;
  let runStrong = false;
  let runItalic = false;
  let runMarker: Marker | null = null;
  const close = (end: number): void => {
    if (end > start) {
      pieces.push({
        text: text.slice(start, end), marker: runMarker, strong: runStrong, italic: runItalic,
      });
    }
    start = end;
  };

  /** Which marker covers this character, or null — the markers arrive sorted. */
  let next = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (next < markers.length && markers[next]!.at + markers[next]!.len <= i) next += 1;
    const over = markers[next];
    const marker = over !== undefined && over.at <= i ? over : null;
    const code = codes?.[i] ?? 0;
    /*
     * THE FOUR ASTERISKS OF A MATCHED PAIR ARE NOT ON THE PAGE. They are still
     * in the file, still counted by every offset, and simply not drawn — which
     * is the whole of what "interpret at display" means. An UNMATCHED asterisk
     * is never dropped (shared/inline's own argument), so a block that a strike
     * or a split cut mid-pair shows its markers as the characters they are
     * rather than swallowing the rest of the paragraph into a bold run.
     */
    if ((code & INLINE_DROPPED) !== 0) {
      close(i);
      start = i + 1;
      continue;
    }
    const strong = (code & INLINE_STRONG) !== 0;
    const italic = (code & INLINE_ITALIC) !== 0;
    if (marker !== runMarker || strong !== runStrong || italic !== runItalic) {
      close(i);
      runMarker = marker;
      runStrong = strong;
      runItalic = italic;
    }
  }
  close(text.length);
  return pieces;
}
