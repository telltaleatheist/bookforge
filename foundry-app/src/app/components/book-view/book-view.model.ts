/**
 * book-view.model — the shapes and constants the book sheet is drawn from.
 */
import { computed, effect, signal } from '@angular/core';
import { analysisCategoryHue } from '@owen/foundry-core/shared/analysis-categories';
import type { BookLoad } from '@owen/foundry-core/shared/book';
import { inlineEmphasis } from '@owen/foundry-core/shared/inline';
import { replayOps, struckNotes, type ReplayedRow } from '@owen/foundry-core/shared/ops';
import { type ChangeRange } from '@owen/foundry-core/shared/word-diff';
import { api } from '../../core/foundry';
import { ChangesService } from '../../core/changes.service';
import type { LitRange } from '@owen/foundry-core/shared/analysis';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { seamJoins } from '@owen/foundry-core/shared/flow';
import { type TableRow } from '@owen/foundry-core/shared/table';
import { cut } from './book-view.lines';

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
export interface Marker {
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
export interface Piece {
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
  /**
   * WHETHER AN ANALYSIS LIT THESE CHARACTERS, and how brightly.
   *
   * `null` on every run of every book with no report open over it, which is
   * nearly all of them — and `'lit'` where a finding covers the run. (A second
   * value, `'ghost'`, drew the passages the verifier rejected under the loosest
   * tier; the tiers went on 2026-09-25 and a report holds the flags alone.)
   *
   * IT SAYS THAT IT IS LIT AND NOT WHICH COLOUR — `hitInk` below is the colour,
   * which is about the CATEGORY.
   *
   * ── AND THE COMPARISON'S TWO INKS RIDE THE SAME FIELD (2026-09-08) ─────────
   *
   * `'removed'` is a stretch of the OLDER column's words that the newer step
   * dropped; `'added'` is a stretch of the NEWER column's words the older step
   * did not have (`ChangesService`, docs/COMPARE-CHANGES.md). They are values of
   * `hit` and not a fifth field because they are the same KIND of fact — "these
   * characters are lit, and this is how" — drawn by the same walk closing runs
   * at the same boundaries; a second field would be a second cursor in `cut()`
   * comparing a second thing at every character for a light that can never be
   * on at the same time as the first (the stage holds ONE second column, so an
   * analysis and a comparison are never both open). Where both somehow cover a
   * character the analysis wins, and `hitInk`/`hitDeep`/`hitKey` are null on a
   * change run: the change inks are two tokens, not twelve, and the stylesheet
   * knows them by class.
   */
  hit: 'lit' | 'added' | 'removed' | null;
  /**
   * THE TINT THIS RUN IS WASHED IN — the category's own colour, or null where the
   * run is not lit.
   *
   * ── THE ONE-INK RULING WAS OVERRULED, AND BY THE RIGHT PERSON ─────────────
   *
   * This field used not to exist, and the comment where it would have been argued
   * at length that it must not: docs/ANALYSIS.md §8's *"the page must not turn
   * into confetti"*, plus this sheet's own header about the block inks being
   * rails, tints and chips only. Owen, 2026-08-25, reading the reworked panel
   * against the paper: *"maybe make the text's highlighted color the same color
   * as the analysis block."*
   *
   * THAT IS THE OVERRIDING WORD AND IT IS ALSO THE BETTER ANSWER. The confetti
   * argument was about a page speaking a code with no key — eleven category
   * colours down a margin that a reader has to memorise. This is not that: the
   * legend sits two inches away in the panel, every card wears the same hue on
   * its rail, and a report names three or four categories rather than twelve. The
   * tint and the card are ONE FACT DRAWN TWICE rather than two facts competing,
   * which is the exact thing `shared/categories.ts`'s header says a colour has to
   * be to be worth having ("the whole point of colouring them is that the two
   * agree").
   *
   * WHAT SURVIVES INTACT IS THE ALPHA DISCIPLINE, which is where the real hazard
   * always was: *"applied as an outline and a tint, never as text colour: this is
   * a book, and recolouring its words makes it unreadable."* The words stay black
   * on cream and only the wash behind them changes colour — see `tintOf`, which
   * is where the paper's own lightness and alpha are decided, separately from the
   * panel's, off the same hue.
   */
  hitInk: string | null;
  /**
   * THE DEEP END OF THE PULSE — `deepTintOf`'s tone for the same category, or
   * null where the run is not lit. It rides the run as a custom property so the
   * selection animation can breathe between the two tones of ONE hue; see the
   * `.run.hit.on` styles for the ruling that put it here.
   */
  hitDeep: string | null;
  /**
   * WHICH FINDING LIT THIS RUN, by the panel's own hit key — null everywhere the
   * run is not lit.
   *
   * Owen, 2026-08-25: *"as i scroll/click highlighted text, it should jump to
   * that spot in the analysis."* This is what makes the first half of that
   * possible: the key rides the run into the DOM as an attribute, and the press
   * that already reads `data-id` and `data-note` off whatever it landed on reads
   * this the same way (`press`). No listener per run, no map from pixels back to
   * offsets, and nothing on this component that could go stale — the attribute is
   * drawn from the same computed the highlight is.
   *
   * IT IS A SECOND FIELD AND NOT A WIDENING OF `hit` ABOVE, because `hit` is what
   * the paper DRAWS and this is what the paper POINTS AT. The confetti ruling is
   * about the first and is untouched by the second: a page with four categories
   * on it is still one ink, and the category is named in the panel where there is
   * room for words. What changed is that the words can now be got to.
   */
  hitKey: string | null;
}

/** One block, with everything the sheet has to know to draw it. */
export interface Line {
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
  /**
   * The FIRST finding lighting this block, by hit key — null for every block no
   * open analysis touches, which is nearly all of them, nearly always.
   *
   * It is on the block as well as on the runs, and the two answer two different
   * questions. The run's key answers *"which finding did that click mean"*. This
   * one answers *"which finding is the reader looking at"* — the scroll half of
   * Owen's sentence — and it has to be on the BLOCK because of the one measured
   * fact `followAnalysis` is written around: the runs live inside the
   * `content-visibility: auto` wrapper, so a run that is off screen has no box at
   * all and its rect reads as a zero rectangle at the viewport's origin. A block
   * always has a box (the containment is on the wrapper inside it, never on the
   * host — see the class docblock), so the block is the thing whose position can
   * be asked for and believed.
   */
  hitKey: string | null;
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
export const BASE_RATIO: Readonly<Record<string, number>> = {
  Footnote: 0.85,
  Caption: 0.9,
  Quote: 0.95,
  Title: 1.5,
  'Section-header': 1.15,
};

/** How far the pointer travels before a press on a block becomes a marquee. */
export const DRAG_SLOP = 4;

/** The tint pulse on a block a marker jumped to — RENDERER-DESIGN.md §4. */
export const PULSE_MS = 600;

/**
 * The jump's glide: the time constant of the chase (each frame closes
 * `1 - e^(-dt/τ)` of what remains, so ~95% of the distance is travelled in 3τ —
 * about three-quarters of a second of visible motion), and the bound that snaps
 * whatever is left and ends it, because a chase over a live layout must end even
 * if something keeps nudging the target. See `land`.
 */
export const GLIDE_TAU_MS = 220;

export const GLIDE_MAX_MS = 1500;

/**
 * The narrowest bench two sheets can breathe in, in rem — the lead's own number.
 *
 * Below it the aligned view is UNAVAILABLE rather than cramped: two columns of
 * book at less than this are two columns of six words a line, which is not a
 * proof sheet, it is a pair of ransom notes. The refusal says the window is too
 * narrow, which is a thing a person can act on in one gesture.
 */
export const ALIGNED_MIN_REM = 68;

/**
 * The paper's measure in each view, in rem — where it opens and how narrow a
 * drag on its edge may take it.
 *
 * THE FLOORS ARE THE OLD CAPS (Owen, 2026-09-22: resize so *"i can make them
 * wider if i want"*). The drag exists to give a wide window's gray back to the
 * words, not to make the ransom notes `ALIGNED_MIN_REM` refuses. The aligned
 * pair OPENS wider than its floor because the floor is what drew the complaint.
 * No ceiling here: the ceiling is the pane, and `measure` asks the pane.
 */
export const MEASURE_REM = {
  alone: { opens: 46, floor: 46 },
  aligned: { opens: 44, floor: 38 },
} as const;

/** How near the paper's edge, in px either side of it, the pointer takes hold. */
export const MEASURE_GRIP_PX = 6;

/**
 * Where the two measures are kept between sessions. A view preference of this
 * one reader on this one machine — not the book's, not the project's — so it is
 * the browser's own storage and nothing main has to know about.
 */
export const MEASURE_KEY = 'foundry.book-view.measure';

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
export const SCROLL_SETTLE_MS = 400;

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
 *
 * AND THEN THE CARD ITSELF WENT (2026-08-23): the glance retired into the
 * docked original panel (./original-panel — the gravestone at its old mount
 * carries the succession). `GLANCE_GAP` and `GLANCE_MARGIN`, the card's
 * placement air, went with the placement they were the air of.
 */

/**
 * One thing the person did on this pane, in the order they did it — the undo
 * journal's alphabet. An `op` entry is a MARKER for the newest op then on
 * `pending` (the op itself stays there, where Apply and the sidecar read it);
 * a `words` entry is a corrected paragraph on a translated position, which is
 * a records write and never an op. The journal exists because Ctrl+Z has to
 * walk back through both in the order they happened — see `did`.
 */
export type Gesture =
  | { kind: 'op' }
  /**
   * SEVERAL OPS THAT ARE ONE ACT — "Remove all" on a chapter is its marker and
   * every block under it, and one Ctrl+Z takes the whole of it back. `what` is
   * the sentence the undo notice says about it.
   */
  | { kind: 'ops'; count: number; what: string }
  | { kind: 'words'; id: string; before: string; after: string };

export type WordsGesture = Extract<Gesture, { kind: 'words' }>;

/** The one marker every op entry is — nothing reads an op entry's identity. */
export const OP_GESTURE: Gesture = { kind: 'op' };

/** No report open over this book, which is nearly every book, nearly always. */
export const NO_LIT: readonly LitRange[] = [];

/** No comparison open, or this block unchanged by it — the same near-always. */
export const NO_CHANGES: readonly ChangeRange[] = [];

export const NO_CHANGE_MAP: ReadonlyMap<string, readonly ChangeRange[]> = new Map();

/** No pair drawn, no source, no book — three ways of having nothing to align. */
export const NO_ALIGNED_DIFF: {
  removed: ReadonlyMap<string, readonly ChangeRange[]>;
  added: ReadonlyMap<string, readonly ChangeRange[]>;
} = { removed: NO_CHANGE_MAP, added: NO_CHANGE_MAP };

/**
 * THE PAPER'S TINT FOR A CATEGORY — the panel's hue, mixed for cream.
 *
 * Owen, 2026-08-25: *"maybe make the text's highlighted color the same color as
 * the analysis block."* One HUE SOURCE and two treatments, which is the only
 * arrangement that can keep the promise: `analysisCategoryHue`
 * (shared/analysis-categories.ts) is the single table, the panel turns a hue into
 * a colour for a charcoal ground and this turns the same hue into a wash for a
 * cream one. A shared colour STRING would have had to be legible on both, which
 * nothing is; a shared hue is legible on both by construction, because the
 * lightness and the alpha are where the ground actually gets accommodated.
 *
 * ── IT IS A PALE STROKE, AND OWEN SAID SO TWICE ────────────────────────────
 *
 * *"The text shouldn't be a different color, just a light highlight color
 * difference."* Two instructions in one sentence and both are obeyed here and
 * only here:
 *
 *   * NOTHING TOUCHES `color`. There is no glyph-colour rule for a hit run
 *     anywhere on this sheet and there is not going to be one — that is
 *     `shared/categories.ts`'s own alpha rule (*"applied as an outline and a
 *     tint, never as text colour: this is a book, and recolouring its words makes
 *     it unreadable"*) and Owen's sentence is the same rule said again about this
 *     mark. This function returns a BACKGROUND and the template binds it to
 *     `background`.
 *   * IT IS LIGHT. 75% saturation at 68% lightness is a pastel, not a pigment,
 *     and 32% alpha over the sheet's cream lands it as a pale marker stroke —
 *     hued enough to match its card across the room, faint enough that the words
 *     stay black-on-warm and a paragraph carrying three findings is still a
 *     paragraph somebody can read. The first cut of this used a mid-tone (62/52
 *     at 22%, which was `--ink-hit`'s own recipe with the hue swapped in) and
 *     Owen sent it back for exactly the reason the numbers moved: a mid-tone at
 *     low alpha reads as a coloured patch, and a pastel at moderate alpha reads
 *     as a highlighter.
 *
 * MEMOISED, because `cut()` asks per run per repaint and a report names three or
 * four categories: the map is a handful of entries for the life of the window and
 * saves composing the same string a thousand times down a four-hundred-page book.
 */
export const TINTS = new Map<string, string>();

export function tintOf(category: string): string {
  const held = TINTS.get(category);
  if (held !== undefined) return held;
  const made = `hsl(${analysisCategoryHue(category)} 75% 68% / 0.32)`;
  TINTS.set(category, made);
  return made;
}

/**
 * The same hue, breathed IN — the deep end of the selected passage's pulse.
 *
 * Owen's second ruling on the emphasis (2026-08-25, over a screenshot): *"its
 * just blinking an ugly outline. can we make it actually pulse darker and
 * lighter for that particular shade?"* So the ring is gone and the emphasis is
 * the wash itself, travelling between `tintOf`'s resting tone and this one —
 * same hue, lower lightness, more of it. The glyphs stay black throughout;
 * only the marker stroke behind them deepens, which keeps the one discipline
 * every ruling here has preserved.
 */
export function deepTintOf(category: string): string {
  const at = `${category}#deep`;
  const held = TINTS.get(at);
  if (held !== undefined) return held;
  const made = `hsl(${analysisCategoryHue(category)} 70% 58% / 0.52)`;
  TINTS.set(at, made);
  return made;
}
