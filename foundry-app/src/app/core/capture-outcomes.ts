/**
 * capture-outcomes — what the capture service reports: outcomes, costs, counts and the sentences that say them.
 */
import type { CaptureIntaken, CapturePhoto, CaptureRecipe } from '@owen/foundry-core/shared/types';
import { turned, isComplete, placed, standings, following, wearing } from './capture-geometry';

/** What "apply to all" is applying — the gesture, with what it needs to repeat. */
/** What an apply-to-all did, for a surface that has to acknowledge it. */
export interface ApplyOutcome {
  applied: number;
  skipped: number;
}

/**
 * WHAT AN APPLY WOULD COST, in the two populations the consequence line under
 * it has to name. See `CaptureService.applyCost`, which is its only reader.
 *
 * The two are DISJOINT by construction -- no photograph is counted twice --
 * which is what lets the sentence be read as an account of the book rather than
 * as two unrelated numbers.
 *
 * THEY STOPPED BEING EXHAUSTIVE AT WAVE 51b, and the gap is not a defect. A
 * photograph whose side of the book has no standing yet is in neither:
 * it is not going to take anything, and it is not being SPARED either, because
 * there is nothing to spare it from. Naming it under any of the three headings
 * would be a sentence blaming a shape or a hand for a crop nobody has placed.
 *
 * IT KEEPS THE NAME `StampCost` and the name is now a fossil: the stamp it was
 * written for is gone (W25-P3) and the table's Apply inherited the shape. The
 * rename is a service-side edit and nothing depends on the word, so it is said
 * here rather than done in passing by the package that deleted the press.
 */
export interface StampCost {
  /**
   * Photographs that will hold this crop afterwards.
   *
   * EVERY PHOTOGRAPH IS A CANDIDATE, because the Apply lands the BOOK'S crop
   * and belongs to no photograph -- including the one the standing was lifted
   * from, which takes it again exactly and harmlessly unless it has since been
   * completed. (A `stampCost` counted this from a SOURCE and had to include it
   * by hand; that count went with the press.)
   */
  takes: number;
  /**
   * Spared because the book has stopped moving them: `isComplete`, and the same
   * test the skip makes rather than a second walk that agrees with it today.
   *
   * It counted `byHand` until Wave 25, which is now provenance rather than the
   * rule -- a photograph completed by the say-so has no hand-set page on it and
   * is skipped all the same, so a count of hands would have promised a reach
   * the act does not have.
   */
  complete: number;
  /*
   * `shape` STOOD HERE -- spared because the same fractions are not the same
   * region on them -- until 2026-09-21, when the shape stopped being asked of
   * a global (`applyPopulations` has the ruling). The rail's third count and
   * its pip went with it.
   */
}

/** What the prepare rail counts. Facts about the recipe, said in numbers. */
export interface PrepareCounts {
  /** Photographs on the table, struck included -- the rail counts pictures. */
  photos: number;
  /** Photographs whose SHEET has been moved off the whole frame. */
  cropped: number;
  /**
   * Photographs carrying a hand-set page.
   *
   * PROVENANCE, NOT THE SKIP RULE, since Wave 25 — a photograph completed by
   * the say-so carries no `byHand` and is skipped all the same. The rail still
   * draws this one; the number it should be drawing is `complete` below, and
   * that swap belongs to the rail (W25-P2) rather than to the count.
   */
  byHand: number;
  /** Photographs the book will not move — the one population a global skips. */
  complete: number;
  /** Photographs cut into pages. */
  split: number;
  /** The pages those cuts produced, which is what makes the count worth saying. */
  pagesFromSplits: number;
}

/*
 * THE `ApplyToAll` UNION STOOD HERE AND HAS NOTHING LEFT TO NAME (Wave 51).
 *
 * W25-P3 deleted its stamp arm; this wave deleted the turn arm with the button
 * that emitted it. A union carrying one arm was worth spelling while a second
 * was plausibly coming; a union carrying none is a type describing a door that
 * is not there. `turnWithTheBook` is the surviving act and it takes the two
 * things it needs — a photograph and a number of quarters — like every other
 * per-photograph door in this service.
 */

/*
 * A local `WHOLE` CONSTANT AND ITS DOCBLOCK STOOD HERE, orphaned: the function
 * they belonged to had already moved to shared/capture.ts as `isWholeFrame`,
 * and only the constant and the comment describing the departed function were
 * left. Swept while the file was open.
 */

/**
 * WHAT A GLOBAL DID, in one sentence — and it ALWAYS says something.
 *
 * The verb is the caller's, because "applied to 25" makes somebody work out
 * what was applied; they pressed a button that said what it would do, and the
 * sentence should say it happened. Silence was the old defect: an act that
 * worked perfectly said nothing at all, and the grid draws raw thumbnails, so
 * twenty-five turned photographs look exactly like twenty-five untouched ones.
 * *"didnt work... maybe it takes a while but there was no indicator"* is the
 * correct reading of a surface that reports only its own refusals.
 */
export function announce(did: string, applied: number, skipped: readonly Skipped[]): string {
  const count = applied === 1 ? '1 photograph' : `${applied} photographs`;
  return skipped.length === 0
    ? `${did} ${count}.`
    : `${did} ${count}. Left alone: ${leftAlone(skipped)}.`;
}

/**
 * WHAT THE OVERRIDE DID — how many were handed back, and how many of those had
 * nothing to take.
 *
 * `announce` cannot say this, and the difference is not a wording preference.
 * Its shape is *"N were changed. Left alone: …"*, and here NOTHING is left
 * alone: every marked photograph gives up its mark, the ones the book has no
 * lines for included. Listing those under *Left alone* would tell somebody a
 * page is still theirs at the exact moment it stopped being.
 *
 * SO THE SECOND CLAUSE IS ABOUT LINES, NOT ABOUT MARKS. "Kept the lines they
 * had" is the true half — the crop on those photographs did not move — and the
 * marks are covered by the first clause, which speaks for all of them.
 *
 * No names here, where the Applies name their skips. The population is the
 * rail's *N a different shape*, pressable, at all times; and unlike a skip,
 * this one is not a refusal a person has to go and correct — it is the book
 * having nothing to offer that side yet, which the next gesture fixes.
 */
export function handedBack(gave: number, applied: number): string {
  const count = gave === 1 ? 'One photograph is' : `${gave} photographs are`;
  const kept = gave - applied;
  if (kept === 0) return `${count} following the book again.`;
  const held = kept === 1
    ? 'One of them kept the lines it had'
    : `${kept} of them kept the lines they had`;
  return `${count} following the book again. ${held} — the book has nothing their side and `
    + 'shape can wear yet.';
}

/**
 * WHAT TO CALL A PHOTOGRAPH IN A SENTENCE — by position, never by file.
 *
 * The skip sentences used to print `photo.file`, which is
 * `originals/<sha>.heic` — content-addressed, because the recipe does not keep
 * the name a photograph arrived under. Owen ran apply-to-all, it worked on
 * twenty-five photographs and skipped the landscape frame exactly as ruled, and
 * the only thing the surface told him was a hex digest. He read the whole act as
 * broken.
 *
 * A person cannot act on a sha. They CAN act on "Photograph 27", because that is
 * what the grid counts and what the editor's own readout says, so the two
 * surfaces agree on how a photograph is referred to. Position is taken from the
 * ARRANGEMENT — first appearance in the order — for the same reason the editor's
 * walk is.
 *
 * THE NAME IT ARRIVED UNDER IS PREFERRED where there is one. `CapturePhoto.name`
 * is OPTIONAL and must stay so: a recipe written before that field cannot be
 * migrated, because the copy is named by hash and the source path was never
 * recorded. Owen's project is one of those, so position is not a fallback for
 * tidiness — it is the only thing the oldest recipes can say.
 *
 * ONE BODY FOR EVERY GLOBAL. The stamp, the crop pass's Apply and the split
 * pass's Apply all name the photographs they left alone, and three sentences
 * about the same photograph must not call it three things.
 */
export function namerFor(recipe: CaptureRecipe): (photo: CapturePhoto) => string {
  const position = new Map<string, number>();
  for (const pageId of recipe.order) {
    const owner = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (owner !== undefined && !position.has(owner.id)) position.set(owner.id, position.size + 1);
  }
  return (photo) => photo.name ?? `Photograph ${position.get(photo.id) ?? '?'}`;
}

/**
 * The photographs a stamp would not touch, said once per reason.
 *
 * Grouped rather than listed, because the reason belongs to the GROUP and
 * repeating it per name is how a sentence stops being read: three hand-set
 * photographs produced the same eight words three times over. The order is the
 * order the reasons were first met, so the sentence follows the arrangement
 * rather than an alphabet nobody chose.
 */
export function leftAlone(skipped: readonly Skipped[]): string {
  const groups: { why: Skipped['why']; names: string[] }[] = [];
  for (const one of skipped) {
    const group = groups.find((each) => each.why === one.why);
    if (group === undefined) groups.push({ why: one.why, names: [one.name] });
    else group.names.push(one.name);
  }
  return groups
    .map(({ names }) => {
      const many = names.length !== 1;
      /*
       * "COMPLETE" AND NOT "SET BY HAND", since Wave 25 -- and the wording had
       * to move with the test. A page completed by the say-so has nothing
       * hand-set on it at all, so the old sentence would have told somebody
       * they had placed corners they never touched, about the one page they
       * had deliberately left alone.
       */
      const because = `${many ? 'those are' : 'that one is'} complete`;
      return `${names.join(', ')} — ${because}`;
    })
    .join('; ');
}

/**
 * ONE PHOTOGRAPH A GLOBAL DID NOT TOUCH, and the reason it gives.
 *
 * The reason is kept rather than a finished sentence so `leftAlone` can GROUP
 * them: a list of strings forces the reason to be repeated once per name, and
 * three complete photographs produced the same eight words three times over.
 * ONE reason since 2026-09-21, when "a different shape" stopped being asked
 * (see `applyPopulations`). The field stays: a second reason needs a sentence
 * before it needs a field, and the sentence is already grouped by this.
 */
export interface Skipped {
  name: string;
  why: 'complete';
}

/** Quiet before a write. Long enough that a drag is one save, short enough to be invisible. */
export const SAVE_AFTER_MS = 400;

/**
 * The order with any newly-cut pages folded in beside the page they came from.
 *
 * ── IT USED TO PUT THEM ALL AT THE BACK OF THE BOOK ─────────────────────────
 *
 * The docblock promised this and the code did not do it, and the gap is one
 * assumption: it recognised a new page by the OLD PAGE'S ID HAVING VANISHED.
 * An unsplit photograph's only page is `<photoId>:0` and a split one's pages
 * are `:0` and `:1`, so the old id never vanishes -- the cut ADDS `:1` and
 * leaves `:0` exactly where it was. The "a split replaced it" branch below
 * therefore never ran for a split, and every new right-hand page fell through
 * to the sweep at the end.
 *
 * Measured on four photographs split in one act: A:0 B:0 C:0 D:0 became
 * A:0 B:0 C:0 D:0 A:1 B:1 C:1 D:1 -- every left page, then every right page.
 * A whole book of versos followed by a whole book of rectos, in the minted PDF
 * and nowhere else, because the light table draws the same cards either way and
 * the number in the footer is the same fifty-four.
 *
 * AND THE SINGLE GESTURE IS THE QUIETER ONE (P1, channel seq 138): split ONE
 * spread on a shoot of twenty-five and A:0 B:0 becomes A:0 B:0 A:1 -- one page
 * adrift at the back of an otherwise perfect book. That is the version somebody
 * reaches for first, and the version that survives a reading of the grid.
 *
 * It has been live for as long as splitting has, and it survived because
 * nothing had split a real shoot yet: Owen's recipe holds twenty-five
 * photographs and no splits at all.
 *
 * ── THE RULE, AND WHY IT IS NOT SIMPLY "KEEP A PHOTOGRAPH'S PAGES TOGETHER" ─
 *
 * A page that the arrangement ALREADY NAMES keeps its own slot, and only a page
 * the arrangement has never heard of is folded in beside its sibling. That
 * distinction is the whole of it: somebody who has dragged the two halves of a
 * spread apart on purpose has an order that says so, and a rule that gathered
 * each photograph's pages together would quietly undo it on the next stamp.
 */
export function orderFor(photos: readonly CapturePhoto[], previous: readonly string[]): string[] {
  const known = new Set(previous);
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (!placed.has(id)) { order.push(id); placed.add(id); }
  };

  for (const id of previous) {
    const owner = photos.find((one) => one.pages.some((page) => page.id === id))
      // The page itself is gone — a stamp can now take a photograph from two
      // pages back down to one — so its photograph is found by the id it was
      // built from, and its remaining pages take the slot.
      ?? photos.find((one) => id.startsWith(`${one.id}:`));
    if (owner === undefined) continue;

    if (owner.pages.some((page) => page.id === id)) place(id);
    for (const page of owner.pages) if (!known.has(page.id)) place(page.id);
  }

  // Whole photographs the arrangement has never seen — an intake since the last
  // save — go on the end, which is where new photographs belong.
  for (const photo of photos) for (const page of photo.pages) place(page.id);
  return order;
}

/**
 * Whether a sequence never moves against `direction`. TIES COUNT AS SORTED,
 * which is the whole reason this is not a comparison of two arrays.
 */
export function runsWith(values: readonly string[], direction: 1 | -1): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) * direction > 0) return false;
  }
  return true;
}

/**
 * What an intake DID, in one sentence a person can act on.
 *
 * Main answers with more than the recipe on purpose (`CaptureIntaken`): a drop
 * containing a screenshot and four photographs this project already holds
 * otherwise looks exactly like a clean import of nothing, and the person is left
 * counting cards to work out what happened to their afternoon. Every clause here
 * exists because its absence is silence.
 *
 * The refusals carry MAIN'S OWN WORDING rather than a rephrasing — it is the
 * side that knows why, and ".txt is not a photograph this stage reads yet" is
 * already a sentence. Two are shown and the rest counted, because a notice bar
 * holding twenty reasons is a notice bar nobody reads.
 */
export function reportOn(intaken: CaptureIntaken, unreadable: number): string {
  const said: string[] = [];
  said.push(intaken.added === 1 ? 'One photograph added.' : `${intaken.added} photographs added.`);
  if (intaken.duplicates.length > 0) {
    said.push(
      `${intaken.duplicates.length} already in this project (${intaken.duplicates.slice(0, 2).join(', ')}`
      + `${intaken.duplicates.length > 2 ? ', …' : ''}) — copied once, not twice.`,
    );
  }
  for (const { file, why } of intaken.refused.slice(0, 2)) said.push(`${file}: ${why}`);
  if (intaken.refused.length > 2) said.push(`${intaken.refused.length - 2} more refused.`);
  if (unreadable > 0) {
    said.push(`${unreadable} could not be read from where they were dragged from.`);
  }
  return said.join(' ');
}

/**
 * WHAT ONE PHOTOGRAPH IS IN FOR, in a walk that may be landing two standings:
 * the wearing it would take, or null from the caller when the act does not
 * reach it at all.
 *
 * It carried the standing's FRAME beside the wearing until 2026-09-21, as
 * `sameShape`'s other half; the shape is no longer asked (see
 * `applyPopulations`), so the frame went with the question.
 */
export interface Reach {
  /** The wearing; `leading` is true for the photograph the gesture was made on. */
  wear: (photo: CapturePhoto, leading: boolean) => CapturePhoto | null;
}

/** Which side of the book a photograph falls on. 1st, 3rd, 5th … are odd. */
export type Parity = 'odd' | 'even';

/**
 * WHICH PAGES A GLOBAL GESTURE SPEAKS FOR — the scope control, as a word.
 *
 * `'all'` is the book, which is what every gesture meant before Wave 51b and
 * what most shoots want forever. The other two are Owen's recto/verso case.
 */
export type CaptureScope = 'all' | Parity;
