/**
 * The two questions the sheet's structure gestures ask of the FLOW, answered
 * without a DOM, a signal or a component around them.
 *
 * ── Why they are here and not in the pane ───────────────────────────────────
 *
 * Both of them are decisions about which rows sit beside which, and both of them
 * are the difference between a gesture that mints an honest op and one that mints
 * an op the replay will put in `missing`. A guard that cannot be exercised on its
 * own is a guard nobody checks, so these are plain functions over plain rows —
 * the pane calls them, and a script can too.
 *
 * ── THE SHELF IS NOT IN THE FLOW, which is the replay's own rule ────────────
 *
 * A shelved row sits in the file at its reading-order position wearing a sentence
 * about why it is out of the book (docs/BOOK-FILE.md §5), and the sheet does not
 * draw one at all. So both functions below step over them: two paragraphs with a
 * suppressed running head between them are two paragraphs the reader sees
 * touching, and a gesture that refused them would be refusing on the strength of
 * something invisible.
 */

import type { BookSeam } from '@shared/book';
import type { ReplayedRow } from '@shared/ops';

/** Two blocks in reading order, which is the order a join has to happen in. */
export interface FlowPair {
  /** The one nearer the front of the book. A merge keeps this one's name. */
  earlier: string;
  /** The one after it. A merge consumes this one. */
  later: string;
}

/**
 * The two ids in reading order when nothing in the flow stands between them, and
 * null otherwise.
 *
 * ── A NOTE BETWEEN THEM MEANS THEY ARE NOT NEIGHBOURS ───────────────────────
 *
 * The shelf is skipped and everything UNSTRUCK counts, footnote rows included,
 * and that is deliberate rather than an oversight about how books are printed. A
 * note row IS in the document — the sheet draws it, the edition sets it at the
 * foot of the page — so two paragraphs with the page's apparatus between them are
 * two paragraphs with something between them. The replay would perform that merge
 * happily and the person would get a paragraph whose words come from either side
 * of a note they never looked at, which is why the honest place to refuse is
 * before the op is minted rather than after.
 *
 * ── A STRUCK ROW BETWEEN THEM DOES NOT COUNT (user ruling, 2026-08-24) ──────
 *
 * *"there are some cases where they were split by an image or something but that
 * image has been removed."* A struck row is cancelled — the edition leaves it out
 * — so two paragraphs with only cancelled rows between them are two paragraphs
 * the READER sees touching, and the join is exactly the repair the strike set up.
 * Refusing it on the strength of a block the person already cancelled would make
 * the strike a wall. The struck row itself is untouched by the join: the replay
 * removes only the absorbed block, so the cancelled image caption goes on sitting
 * in the flow, drawn struck, after the paragraph that now flows past it.
 *
 * The two NAMED blocks are exempt from the skip: a person may join a struck
 * block itself (the survivor's own state wins at replay, which is `merge`'s
 * documented rule), and a scan that skipped a named block would report the pair
 * as strangers while standing on one of them.
 *
 * The seam gesture is not held to any of this and does not go through here: a
 * seam's two halves are the two sides of a page turn, and the notes at the foot
 * of the earlier page sit between them by construction (`BookSeam`). The engine
 * put that pair in the header having read both pages; this function is for a pair
 * a person assembled by clicking, which is a claim nobody has checked.
 */
export function flowNeighbours(
  rows: readonly ReplayedRow[],
  one: string,
  other: string,
): FlowPair | null {
  if (one === other) return null;
  let seen: string | null = null;
  for (const row of rows) {
    const named = row.id === one || row.id === other;
    if (!named && (row.shelf !== undefined || row.struck === true)) continue;
    if (seen !== null) {
      // The very next row that counts, or somebody's paragraph is in the way.
      return named ? { earlier: seen, later: row.id } : null;
    }
    if (named) seen = row.id;
  }
  return null;
}

/**
 * The seams that can still be drawn: the block a turn opens with → the block it
 * ends the page before.
 *
 * KEYED BY `before` BECAUSE THAT IS WHERE THE GHOST HANGS. `BookSeam.before` is
 * the row the page AFTER the turn opens with, so the `··· join ···` control sits
 * above it and the value here is the block it would be joined onto — which is the
 * op's `into`, the earlier of the two, the one that keeps its name.
 *
 * ── A seam draws only while both of its blocks are in the flow ──────────────
 *
 * The header's list is a fact about the READING and the ops restructure the book
 * over the top of it, so a seam whose halves a chain has already joined, split or
 * consumed is an offer nobody can accept: clicking it would mint a merge naming a
 * block this book no longer holds, and the replay would file it in `missing` where
 * no gesture can clear it. This is the simplest rule that is honest — both blocks
 * present, and the ghost goes when either is not — and it does not try to be
 * clever about the halves of a split, which are two new names the reading never
 * knew and which the person can always join by hand.
 */
export function seamJoins(
  rows: readonly ReplayedRow[],
  seams: readonly BookSeam[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (seams.length === 0) return out;
  const inFlow = new Set<string>();
  for (const row of rows) {
    if (row.shelf === undefined) inFlow.add(row.id);
  }
  for (const seam of seams) {
    if (!inFlow.has(seam.before) || !inFlow.has(seam.after)) continue;
    out.set(seam.before, seam.after);
  }
  return out;
}

/**
 * WHERE THE OTHER COLUMN SHOULD BE PUT — the aligned view's anchor, resolved.
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * The pane has found the topmost block not cut off at the top of the column a
 * hand is scrolling (`anchor`, an index into that column's ids in reading order),
 * and it has the set of ids the OTHER column holds. What it needs back is the row
 * both columns can be lined up on.
 *
 * ── NEAREST PRECEDING IS THE RULE, AND IT IS NOT A FALLBACK ─────────────────
 *
 * Two book files of one book do not hold identical lists of ids, and the two ways
 * they differ are both ordinary rather than exceptional: a block struck under the
 * translation is absent from the derived book, and a cut applied under it mints
 * `b2-3/1` and `b2-3/2`, names the source never had. The ruling for this view
 * (R5d's brief, written down here because a rule that lives only in a message is a
 * rule the next reader mistakes for a shortcut) is the LAST SHARED ROW AT OR ABOVE
 * the anchor.
 *
 * It is not a guess at where the missing row would have been. It is the one thing
 * still true of both columns — that they are somewhere past that paragraph — and
 * it is STABLE, because scrolling either column back the other way picks the same
 * shared row and puts the pair back exactly where it was. A rule that reached
 * FORWARD instead would answer differently depending on which column was driving,
 * and the two columns would walk apart a row at a time.
 *
 * NULL IS THE HONEST ANSWER FOR A BOOK WITH NOTHING SHARED ABOVE — the top of a
 * translation whose first paragraphs were all struck. Nothing is moved, which
 * leaves both columns where their reader put them.
 */
export function sharedAnchor(
  ids: readonly string[],
  anchor: number,
  twins: ReadonlySet<string>,
): number | null {
  for (let at = Math.min(anchor, ids.length - 1); at >= 0; at -= 1) {
    const id = ids[at];
    if (id !== undefined && twins.has(id)) return at;
  }
  return null;
}

/**
 * THE BOOK IN THE BENCH'S ORDER — every chapter's prose, then that chapter's
 * notes, then the next chapter.
 *
 * ── The ruling this serves (user, 2026-08-16) ───────────────────────────────
 *
 * The apparatus reads at the end of its chapter, ON THE WORKBENCH TOO — not
 * only in the edition and the export. The bench used to draw each page's notes
 * where the printer set them, which is faithful to the scan and wrong for the
 * document being edited: the page is not a unit of this book any more
 * (docs/RENDERER.md §0, ruling 3 — pages are kept and not trusted), and a
 * paragraph interrupted every few hundred words by the foot of a page nobody
 * is looking at is the scan's layout leaking into the edit. So the one
 * reordering the edition performs (`editionFlow`, ./edition) is performed for
 * the bench as well, by this function, with one difference that is the whole
 * reason it exists beside `editionFlow` rather than replacing it: NOTHING IS
 * DROPPED. The bench draws struck rows cancelled — struck is a state of the
 * document, not of a mode — so this is a pure REORDER over every row it is
 * handed, and the edition keeps its own projection, which also filters.
 *
 * The shelf is not special-cased here for `linesOf`'s reason: the caller's
 * line-builder already skips shelved rows, and a reorder that also filtered
 * would be two functions deciding one question.
 */
export function chapterOrder<T>(
  rows: readonly T[],
  of: (row: T) => { category: string; opens: boolean },
): T[] {
  const out: T[] = [];
  let body: T[] = [];
  let notes: T[] = [];
  const close = (): void => {
    out.push(...body, ...notes);
    body = [];
    notes = [];
  };
  for (const row of rows) {
    const read = of(row);
    if (read.opens) close();
    if (read.category === 'Footnote') notes.push(row);
    else body.push(row);
  }
  close();
  return out;
}
