/**
 * capture-geometry — a page's crop and cut, worked out: turning, seating and following quads, and which pages share a recipe.
 */
import type { CaptureLines, CapturePage, CapturePhoto, CapturePoint, CaptureQuad, CaptureRecipe, CaptureSplit, CaptureStanding } from '@owen/foundry-core/shared/types';
import { cutOf, halvesOf, isWholeFrameTurned, joinedQuad, splitFromFraction, turnedLike, turnQuad, turnsOf, WHOLE_FRAME } from '@owen/foundry-core/shared/capture';
import { namerFor, Skipped, Reach, Parity } from './capture-outcomes';

/**
 * ONE PHOTOGRAPH, TURNED — AND ITS SPLIT RE-SEATED WITH IT.
 *
 * ── A turn does not move a corner, but it does move a PAGE ─────────────────
 *
 * `turnQuad` permutes the corner assignment without moving any point, so the
 * crop stays on exactly the same part of the photograph however many times it
 * is turned. That is why turning each page's quad on its own LOOKS right.
 *
 * It is not right for a spread, and the measurement says so exactly. Turning
 * the two halves of a centre-split independently, against re-deriving them
 * from the turned sheet:
 *
 *   a quarter turn      the same, both ways
 *   a half turn         THE HALVES SWAP READING ORDER
 *   three quarters      THE HALVES SWAP READING ORDER
 *
 * Which is obvious once seen: turn a spread upside down and the page that was
 * on the left is on the right. The independent turn keeps the old order, so
 * the book silently gets two pages in the wrong sequence -- and it is
 * invisible on the table, because both cards are there and both look correct.
 *
 * So a photograph with a cut in it is turned by rebuilding the WHOLE sheet,
 * turning that, and asking `halvesOf` for the halves again. The split itself
 * is untouched: it is a segment in the photograph's own fraction space and a
 * turn moves nothing, so the cut is still across the same gutter.
 *
 * ── A TURN CLAIMS NOTHING, AND WAVE 26 REVERSED THAT ─────────────────────
 *
 * This used to write `byHand: true` on every page and route through `placed`,
 * so turning a photograph made it its own. The argument was that a later global
 * would otherwise silently undo a turn somebody had performed deliberately —
 * AND THAT ARGUMENT WAS FALSE ABOUT THE CROP. `wearing` takes the standing's
 * quad through `turnedLike` into whatever direction the photograph is already
 * facing, precisely so that a page stood upright keeps its orientation while
 * receiving the book's rectangle. A global crop has never been able to undo a
 * turn. The only act that could was the bulk turn, and that one is now the
 * *Global* tick's, which spares every photograph that is its own by rule.
 *
 * The cost of the false protection is what forced the reversal. Owen's own
 * opening move on a shoot is to turn twenty-five sideways spreads on the table,
 * before a single corner is placed — and under the old rule that claimed all
 * twenty-five, so the book's crop would then have reached NOBODY and every card
 * would have carried a mark nobody meant to set. A tick that reads "its own" on
 * a photograph whose only history is being stood the right way up is the surface
 * lying about what a person did.
 *
 * So a turn now leaves the mark EXACTLY AS IT FOUND IT, in both directions: it
 * does not claim a follower and it does not release a page somebody claimed.
 * Turning is orthogonal to whose lines these are, which is what it always was.
 * `turnWithTheBook` clears the marks it needs to clear itself (`following`),
 * where the clearing is part of what that act means.
 *
 * ── WHAT FOLLOWS A HALF, AND WHAT FOLLOWS AN INDEX ────────────────────────
 *
 * A strike is a decision about a PHYSICAL page -- "this one is a duplicate" --
 * so when the order swaps, the strike has to travel with the half rather than
 * stay on the seat. Each re-derived half is matched back to the turned quad it
 * equals, and carries that page's strike with it. Matching by GEOMETRY rather
 * than by a swap rule means this stays right if `halvesOf` ever orders a turn
 * differently than it does today.
 */
export function turned(photo: CapturePhoto, turns: number): CapturePhoto {
  const spin = (page: CapturePage, quad: CaptureQuad): CapturePage => ({ ...page, quad });

  if (photo.split === null || photo.pages.length !== 2) {
    return {
      ...photo,
      pages: photo.pages.map((page) => spin(page, turnQuad(page.quad, turns))),
    };
  }

  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const halves = halvesOf(turnQuad(whole, turns), photo.split);
  // Unreachable for a split this app can produce, and leaving the photograph
  // untouched is the only answer that cannot put a page in the wrong place.
  if (halves === null) return photo;

  const spun = photo.pages.map((page) => turnQuad(page.quad, turns));
  return {
    ...photo,
    pages: halves.map((quad, seat) => {
      const came = spun.findIndex((one) => sameQuad(one, quad));
      const from = photo.pages[came === -1 ? seat : came]!;
      return { ...spin(from, quad), id: `${photo.id}:${seat}` };
    }),
  };
}

/** Two quads, corner for corner. Fractions out of one turn, so exact is honest. */
export function sameQuad(a: CaptureQuad, b: CaptureQuad): boolean {
  return a.every((point, index) => point[0] === b[index]![0] && point[1] === b[index]![1]);
}

/**
 * THE ONE TEST EVERY SKIP READS: will the book move this photograph?
 *
 * ── Two states became one, and this is where the two are reconciled ────────
 *
 * Wave 24 had a photograph EITHER following the book OR holding its own, and
 * the second state was spelled as `byHand` on its pages. Wave 25 keeps that
 * meaning and adds a second way into it -- a person pressing *This page is
 * right* on a page they have not touched at all. Both answer the same question,
 * so they must not be two questions: every global act asks this one and nothing
 * else, or the dot on the card promises a skip some other rule does not make.
 *
 * ── THE EXPLICIT FIELD WINS, AND `false` IS NOW ONLY EVER READ ────────────
 *
 * Nothing writes `false` any more. `release` did — it cleared the mark and kept
 * the lines, so the derive had to be out-argued or the button would have done
 * nothing — and Wave 51 replaced that door with `matchTheOthers`, which gives up
 * the mark by CLEARING the provenance (`following`) rather than by writing an
 * answer beside it. Every act that hands a photograph back to the book now
 * leaves it saying nothing about itself, which is what a follower is.
 *
 * The read stays, and must: recipes written before this wave hold stored
 * `false`s, they mean exactly what they meant, and the validator carries them.
 *
 * The reverse case is handled at the WRITE and not here (see `placed`): a
 * placement DELETES the stored answer rather than writing a second `true`, so a
 * photograph handed back and then re-placed reads complete again through the
 * derive. One place holds that answer, and this is it.
 *
 * ── IT LIVES BESIDE THE RECIPE'S RULES RATHER THAN IN shared/ ─────────────
 *
 * `sameShape` and `halvesOf` are in shared/ because BOTH SIDES resolve them --
 * main mints from the same geometry the renderer draws. Nothing in main reads
 * `complete`: the mint prints every photograph's lines whatever this says, which
 * is the "left out of the stamp, never the mint" ruling made structural. A
 * predicate in shared/ would advertise a question main is supposed never to ask.
 */
export function isComplete(photo: CapturePhoto): boolean {
  if (photo.complete !== undefined) return photo.complete;
  return photo.pages.some((page) => page.byHand === true);
}

/**
 * A PHOTOGRAPH SOMEBODY HAS JUST PLACED A LINE ON -- with any stored answer
 * about completeness DELETED rather than overwritten.
 *
 * ── Why deleted, when writing `true` would read the same today ────────────
 *
 * Because the two disagree the moment anything else changes. `byHand` is
 * provenance and this field is a decision, and a placement is BOTH -- so the
 * honest record of a placement is the provenance alone, with the decision left
 * to the one rule that reads it. A `true` written here would be a second,
 * frozen copy of an answer `isComplete` already gives, and the first act to
 * clear the provenance without clearing the copy would leave a photograph the
 * book refuses to move for a reason nothing on disk can explain.
 *
 * The case that forces it is the released page: release stores `false`, the
 * page keeps its lines, and then somebody drags a corner on it. Written beside,
 * the stored `false` out-argues the hand that just moved the crop and the next
 * Apply overwrites work made ten seconds ago. Deleted, the derive answers, and
 * it answers `true` because a hand placed it -- which is the ruling.
 *
 * NOT called by the stamp. `wearing` deletes the same field for the mirror
 * reason and writes `byHand: false` with it, so a follower comes out of an
 * Apply saying nothing about itself at all.
 */
export function placed(photo: CapturePhoto): CapturePhoto {
  if (photo.complete === undefined) return photo;
  const next = { ...photo };
  delete next.complete;
  return next;
}

/**
 * THE BOOK'S LINES ON EVERY FOLLOWER — the ONE walk three acts share.
 *
 * ── Why it is one body ────────────────────────────────────────────────────
 *
 * `applyCrops`, `applyCuts` and `leadTheBook` all ask the same three questions
 * in the same order — has somebody taken it for their own, and does the wearing
 * resolve — and they had three answers written out
 * separately the moment the third one existed. That is the drift shape this
 * file has already paid for by name (Wave 18: *"I had written the correct rule
 * once and the wrong rule twice, three functions apart"*), and it matters more
 * here than it ever did: the live propagation and the Finalize that backstops
 * it MUST land identically, or the button is a second opinion about work a
 * person watched happen.
 *
 * `wear` is the only difference between the callers, and it is a function
 * because the two acts genuinely differ: one dresses a photograph in the whole
 * standing, the other only re-cuts the sheet it already has. Null from it is
 * always "this cannot be done to this photograph" and always means leave it
 * alone — a corner made into a page is the failure both refusals guard.
 *
 * ── THE CALLER ANSWERS PER PHOTOGRAPH, WHICH IS WAVE 51b's ONE CHANGE ─────
 *
 * `reach` is asked of each photograph and of the SIDE OF THE BOOK it falls on,
 * and it answers with the frame that photograph would be measured against and
 * the wearing it would take — or null, meaning this act does not reach it at
 * all. Three things needed that and none of them could be said with one frame
 * and one wearing: a scoped gesture reaching only the odd pages, a finalize
 * landing two different crops in one walk, and a side that has no standing yet
 * and must be left alone rather than dressed in the other side's.
 *
 * NULL IS NOT A SKIP. The skip list is what a global LEFT ALONE and has to
 * explain — a hand it will not overrule — and "you asked
 * for the odd pages" is not something a sentence has to apologise for. Counting
 * it would report "Finalized 13 photographs. Left alone: 12 — those are
 * complete", about twelve pages nobody claimed.
 *
 * ── `lead` IS THE ONE PHOTOGRAPH A MARK DOES NOT SPARE ────────────────────
 *
 * The photograph a gesture happened on, when that gesture was the book's. It is
 * dressed even if it was marked, and it is handed to `wear` as a FOLLOWER
 * (`following`) so the mark is given up rather than argued with: a gesture made
 * with *Global* on, on a page you had taken for your own, IS the act of handing
 * it back. Null — every other caller — spares everything complete, as every
 * global here always has. (Keeping the lead in reach when the scope points at
 * the other side of the book is the CALLER's business, and `leadTheBook` says
 * why it does.)
 *
 * The skips are named through `namerFor`, by position or by filename, never by
 * a sha. Callers that speak (the two Finalizes) read the list; the live one
 * ignores it, because a notice bar rewritten on every corner let go of is a
 * notice bar nobody reads.
 */
export function dressed(
  recipe: CaptureRecipe,
  reach: (photo: CapturePhoto, parity: Parity) => Reach | null,
  lead: string | null = null,
): { photos: CapturePhoto[]; applied: number; skipped: Skipped[] } {
  const name = namerFor(recipe);
  const parities = paritiesOf(recipe);
  const skipped: Skipped[] = [];
  let applied = 0;
  const photos = recipe.photos.map((photo) => {
    const leading = photo.id === lead;
    // 'odd' for a photograph the arrangement does not name -- unreachable, since
    // `paritiesOf` sweeps the whole list, and the first side is the one a book
    // of one photograph is on.
    const asked = reach(photo, parities.get(photo.id) ?? 'odd');
    if (asked === null) return photo;
    if (!leading && isComplete(photo)) {
      skipped.push({ name: name(photo), why: 'complete' });
      return photo;
    }
    const worn = asked.wear(leading ? following(photo) : photo, leading);
    if (worn === null) return photo;
    applied += 1;
    return worn;
  });
  return { photos, applied, skipped };
}

/**
 * EVERY PHOTOGRAPH'S SIDE OF THE BOOK, read off the ARRANGEMENT.
 *
 * ── By photograph, and by the order on the table ──────────────────────────
 *
 * The 1st, 3rd, 5th … PHOTOGRAPH is odd. Not the 1st, 3rd, 5th page: a spread
 * already holds a left page and a right page, so page parity would split one
 * picture across both sides of the book and ask a single frame to wear two
 * crops. The case the sides exist for is a one-page-per-photograph shoot, where
 * the two readings agree — see `CaptureStanding`.
 *
 * FIRST APPEARANCE IN `order`, which is the same rule the walk, the mint and
 * `namerFor` all use: the arrangement is what the person is looking at, and
 * after a drag `recipe.photos` is intake sequence and a different book. Which
 * also means a drag can move a photograph from one side to the other, exactly as
 * it moves its page number — that is what it means for the sides to be a fact
 * about the arrangement rather than a mark on a picture.
 *
 * A photograph the arrangement never names still gets a side, continuing the
 * count, so nothing falls out of the book for being unplaced.
 */
export function paritiesOf(recipe: CaptureRecipe): ReadonlyMap<string, Parity> {
  const sides = new Map<string, Parity>();
  const side = (): Parity => (sides.size % 2 === 0 ? 'odd' : 'even');
  for (const pageId of recipe.order) {
    const owner = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (owner !== undefined && !sides.has(owner.id)) sides.set(owner.id, side());
  }
  for (const photo of recipe.photos) if (!sides.has(photo.id)) sides.set(photo.id, side());
  return sides;
}

/** One photograph's side, for the callers that need a single answer. */
export function parityOf(recipe: CaptureRecipe, photoId: string): Parity {
  return paritiesOf(recipe).get(photoId) ?? 'odd';
}

/**
 * THE LINES A PHOTOGRAPH ON THIS SIDE WEARS — ITS SIDE'S, OR THE BOOK'S OWN.
 *
 * The ONE resolution, and every act that asks what the book has to say about a
 * photograph asks it here: the two Finalizes, the live propagation, *Follow the
 * book again*, the cut the *Two pages* tick offers, the ghost under the outline
 * and the rail's counts. Written twice it would be two answers within the hour.
 *
 * A SIDE'S BLOCK IS TAKEN WHOLE. A block holding a crop and no cut means "these
 * pages are single sheets", not "inherit the book's cut" — see
 * `CaptureStanding` for why a merge cannot say both. An empty block (which
 * nothing writes and the validator drops) falls back rather than resolving to
 * nothing, because a key meaning nothing should not be able to take a crop away
 * from a page.
 */
export function linesFor(standing: CaptureStanding | undefined, parity: Parity): CaptureLines | undefined {
  const own = standing?.[parity];
  if (own !== undefined && (own.crop !== undefined || own.cut !== undefined)) return own;
  return linesOf(standing);
}

/**
 * THE BOOK'S OWN LINES, or nothing when it has none of its own.
 *
 * A standing carrying only sides is a real state — place the odd pages' crop
 * first and the book itself has said nothing yet — and it must answer NOTHING
 * here rather than an empty object, so a photograph on a side that has not been
 * set is left alone instead of dressed in a crop that does not exist.
 */
export function linesOf(standing: CaptureStanding | undefined): CaptureLines | undefined {
  if (standing === undefined) return undefined;
  if (standing.crop === undefined && standing.cut === undefined) return undefined;
  return standing;
}

/**
 * EVERY STANDING A BOOK HOLDS — its own and its sides', each of them saying
 * something.
 *
 * For the questions that are about the book rather than about a photograph: is
 * there a crop anywhere to finalize, is there a cut anywhere to land, is this
 * standing empty enough to be written as silence.
 */
export function standings(standing: CaptureStanding | undefined): readonly CaptureLines[] {
  const all: CaptureLines[] = [];
  const own = linesOf(standing);
  if (own !== undefined) all.push(own);
  if (standing?.odd !== undefined) all.push(standing.odd);
  if (standing?.even !== undefined) all.push(standing.even);
  return all;
}

/**
 * ONE BLOCK OF LINES WITH ITS CUT SET, OR TAKEN AWAY.
 *
 * `undefined` DELETES rather than writing a key, because absent is what a book
 * of single pages looks like everywhere else in this file and the validator
 * writes silence for it either way.
 *
 * IT MUTATES, and every caller hands it a copy it has just made. That is the
 * only shape that reads honestly beside `delete book.cut` two lines above it;
 * a version that returned a new object would be doing the same thing while
 * looking like it was doing something safer.
 */
export function withCut<T extends CaptureLines>(lines: T, cut: CaptureSplit | undefined): T {
  if (cut === undefined) delete lines.cut;
  else lines.cut = cut;
  return lines;
}

/**
 * THIS PHOTOGRAPH, MOVING WITH THE BOOK AGAIN — the mark given up, the lines
 * left exactly where they are.
 *
 * It is `wearing`'s bookkeeping without `wearing`'s geometry, and it exists
 * because three acts need the bookkeeping alone: re-ticking *Global*, the
 * right-click hand-back on a book that has no standing yet, and the lead of a
 * `dressed` walk on its way into `wear`. Both halves are required and neither
 * is enough: the stored answer goes (a `false` left here would be a release
 * nobody pressed) AND every page's `byHand` goes with it, or the derive in
 * `isComplete` would go on answering "complete" from the provenance.
 */
export function following(photo: CapturePhoto): CapturePhoto {
  const next = { ...photo };
  delete next.complete;
  return { ...next, pages: photo.pages.map((page) => ({ ...page, byHand: false })) };
}

/**
 * ONE PHOTOGRAPH BACK TO NO CROP AT ALL, FACING THE WAY IT NOW FACES.
 *
 * `WHOLE_FRAME` turned to the sheet's own orientation, which is the whole of
 * what "back to original, but keep the turns" means: a turn moves no corner, so
 * a turned whole frame is still no crop (`isWholeFrameTurned` is the reading of
 * exactly this) while a bare `WHOLE_FRAME` would silently un-turn twenty-five
 * sideways spreads. See `CaptureService.resetAll` for why that is the ruling.
 *
 * A CUT SURVIVES ITS CROP, which is `clearCrop`'s ruling applied to the book:
 * the halves are re-derived from the turned whole frame and the gutter stays
 * exactly where it was put. A cut that will not resolve against the whole frame
 * is left alone — there is no page to re-derive, and inventing one is the only
 * worse answer.
 */
export function uncropped(photo: CapturePhoto): CapturePhoto {
  const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const whole = turnQuad(WHOLE_FRAME, turnsOf(sheet));
  const halves = photo.split === null ? null : halvesOf(whole, photo.split);
  if (photo.split !== null && halves === null) return following(photo);
  const quads: readonly CaptureQuad[] = halves ?? [whole];
  const next = { ...photo };
  delete next.complete;
  return {
    ...next,
    pages: quads.map((quad, seat) => ({
      id: `${photo.id}:${seat}`,
      quad,
      struck: photo.pages[seat]?.struck ?? false,
      byHand: false,
    })),
  };
}

/**
 * ONE PHOTOGRAPH PUT BACK TOGETHER — `clearSplit`'s body, for the acts that
 * need it on every photograph at once.
 *
 * The rejoined page keeps the crop the halves were describing, because
 * `joinedQuad` is the same body the editor draws from and `cutWith` re-cuts
 * from. A STRIKE ON EITHER HALF STRIKES THE PAGE: rejoining cannot keep half a
 * strike, and dropping it would quietly restore a page somebody had rejected.
 *
 * It comes back a FOLLOWER, which is what separates it from `clearSplit` —
 * that one is a person's own act on one photograph and marks it; this is the
 * book's, from `resetAll` and from a global rejoin, and marks nobody.
 */
export function rejoined(photo: CapturePhoto): CapturePhoto {
  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const next = { ...photo };
  delete next.complete;
  return {
    ...next,
    split: null,
    pages: [{
      id: `${photo.id}:0`,
      quad: whole,
      struck: photo.pages.some((page) => page.struck),
      byHand: false,
    }],
  };
}

/**
 * HOW FAR THE BOOK'S LINE MAY BE MOVED to reach a page's own fold, as a
 * fraction of the frame.
 *
 * ── It is a reach, not a search ─────────────────────────────────────────────
 *
 * Eight percent is about a centimetre of a spread, which is comfortably more
 * than the fold wanders across a scanned book -- MEASURED on the fragebogen
 * scan, the detected fold runs from 0.475 to 0.538 of the frame across 271
 * spreads, so every one of them is inside eight percent of the middle. It is
 * far enough to be useful on every page of that book and near enough that it
 * cannot reach the edge of a text block, which is the thing a gutter detector
 * mistakes a fold for and sits a good fifteen percent out.
 *
 * WHY THERE IS A LIMIT AT ALL, when the detector already refuses to guess: the
 * two judgements are about different things. `gutterOf` decides whether it can
 * see a fold; this decides whether the fold it saw is the one the book's line
 * is about. A deliberate unequal cut -- a narrow column, an inset, a foldout
 * leaf placed by hand and handed to the book -- must not be dragged onto a
 * shadow ten percent away just because there is a shadow there.
 */
export const GUTTER_REACH = 0.08;

/**
 * THE BOOK'S LINE, MOVED ONTO THIS PAGE'S OWN FOLD -- or handed straight back.
 *
 * ── Owen's ask, and why the answer lives HERE and not in the standing ───────
 *
 * *"is there any way we could detect a book gutter and try to place page splits
 * roughly where the gutter is, which might be different on each page?"*
 * (2026-09-21). The second half is the whole design problem: THE BOOK'S CUT IS
 * ONE LINE AND THE FOLD IS PER PAGE. Those cannot both live in the standing --
 * a standing holds one cut, and the moment it held 272 it would stop being the
 * thing every other rule in this file reasons about ("is this page following
 * the book" has no answer against a standing that is a list).
 *
 * So the standing keeps its one line and the line is adjusted AT THE LANDING,
 * where the page it is landing on is in hand. A person still places one gutter
 * and the book still follows it; each page just lands it a few pixels off the
 * place the arithmetic would have put it, on the shadow it can see. Nothing in
 * the recipe records that adjustment as a decision: the pages carry the quads
 * they always carried, `photo.split` carries the line as landed, and the
 * standing is untouched. Re-apply the same standing and every page seats the
 * same way again, because the seating is a function of the page's own pixels.
 *
 * ── THREE QUESTIONS, ALL OF WHICH CAN SAY NO ───────────────────────────────
 *
 * Has this photograph been measured and did the measurement see anything: an
 * absent gutter is an old recipe and a null one is a page with no visible fold,
 * and both mean there is nothing to seat onto.
 *
 * Does the line even run the way the fold does. A `CaptureGutter` is an axis in
 * FRAME coordinates, so the comparison is made in frame coordinates too -- the
 * seated endpoints' own directions -- and NOT from `cutOf`'s `halves`, which is
 * a reading in the PAGE's orientation. Those agree on an unturned sheet and
 * disagree on a turned one: turn a sideways spread upright and its labels
 * rotate, so the same horizontal cut across the picture reads 'side-by-side'
 * (left page then right page, which is what it makes) while the fold it follows
 * is still the frame's 'y'. Comparing the two readings would seat correctly on
 * a landscape book and silently never on a turned one.
 *
 * And is the fold the same fold the line is about -- `GUTTER_REACH`, above.
 *
 * ── THE CONVERSION IS EXACT ON A RECTANGLE AND NEAR ENOUGH ON A SCAN ───────
 *
 * The fold is a fraction of the FRAME and `splitFromFraction` wants a fraction
 * along the SHEET's edge, so the fraction is re-measured against the two edges
 * the cut will run between and averaged. That is exact for a sheet whose edges
 * are square to the frame and approximate for one that leans, because a leaning
 * fold does not meet the top and bottom edges at the same fraction of each. A
 * flatbed scan is square to a fraction of a degree, which is why this is
 * allowed to be an approximation: the error is smaller than the width of the
 * shadow being aimed at. A spread photographed by hand under a lamp leans, and
 * on that book this puts the line NEAR the fold rather than on it -- which is
 * the same thing the middle does today, and better.
 *
 * ── AND IT WALKS WHICHEVER PAIR OF EDGES THE FOLD RUNS BETWEEN ─────────────
 *
 * `splitFromFraction` always cuts between corner 0→1 and corner 3→2, which is a
 * vertical line on an upright sheet and a horizontal one on a sheet whose
 * labels have been turned a quarter. Turning the LABELS by a quarter here walks
 * the other pair instead, so one body places a fold running either way without
 * knowing which way the photograph is facing. `turnQuad` moves no corner (see
 * its docblock): the sheet handed to `splitFromFraction` is the same four
 * points, and the two endpoints that come back sit on real edges of it.
 */
export function seated(photo: CapturePhoto, sheet: CaptureQuad, split: CaptureSplit): CaptureSplit {
  const gutter = photo.gutter;
  if (gutter === undefined || gutter === null) return split;
  // Re-seated rather than trusted, for `cutOf`'s own reason: the stored
  // endpoints are a memory of where two handles were let go, and a crop dragged
  // since has left them floating off the edges they were riding. Null is a
  // segment that cuts a corner off, which is not a line to move.
  const cut = cutOf(sheet, split);
  if (cut === null) return split;
  const [fromX, fromY] = cut.a.point;
  const [toX, toY] = cut.b.point;
  // A line that runs down the frame cuts across the frame's x, which is the
  // fold axis 'x' means. See the docblock on why this is not `cut.halves`.
  const runs: 'x' | 'y' = Math.abs(toY - fromY) > Math.abs(toX - fromX) ? 'x' : 'y';
  if (runs !== gutter.axis) return split;

  const across = gutter.axis === 'x' ? 0 : 1;
  const crosses = (cut.a.point[across] + cut.b.point[across]) / 2;
  if (Math.abs(crosses - gutter.at) > GUTTER_REACH) return split;

  // The pair of edges the cut will run between: corner 0→1 and 3→2 of whichever
  // labelling of the sheet has them crossing the fold's axis.
  const walked = Math.abs(sheet[1][across] - sheet[0][across])
    >= Math.abs(sheet[3][across] - sheet[0][across])
    ? sheet
    : turnQuad(sheet, 1);
  const alongEdge = (from: CapturePoint, to: CapturePoint, fold: number): number | null => {
    const run = to[across] - from[across];
    // An edge that does not cross the fold's axis at all cannot say where along
    // it the fold is. Both of them, and there is no conversion to make.
    return Math.abs(run) < 1e-9 ? null : (fold - from[across]) / run;
  };
  /*
   * EACH EDGE TAKES THE FOLD AT ITS OWN END OF THE FRAME (rule 3). `ends` is
   * the fold at the frame's near edge and at its far edge along the other
   * axis; whichever of the sheet's two crossing edges sits nearer that end
   * takes that reading, so the seated line leans the way the scan does. A
   * measurement from an earlier rule has no ends and both edges take `at`.
   */
  const along = 1 - across;
  const ends = gutter.ends;
  const foldFor = (from: CapturePoint, to: CapturePoint, other: [CapturePoint, CapturePoint]): number => {
    if (ends === undefined) return gutter.at;
    const here = (from[along] + to[along]) / 2;
    const there = (other[0][along] + other[1][along]) / 2;
    return here <= there ? ends[0] : ends[1];
  };
  const first = alongEdge(walked[0], walked[1], foldFor(walked[0], walked[1], [walked[3], walked[2]]));
  const second = alongEdge(walked[3], walked[2], foldFor(walked[3], walked[2], [walked[0], walked[1]]));
  if (first === null && second === null) return split;
  const top = first ?? second!;
  const bottom = second ?? first!;
  // Outside the sheet entirely: the fold is on a part of the photograph this
  // crop threw away, and a clamped line on the edge of the page is worse than
  // the line that was already there.
  if (top < 0 || top > 1 || bottom < 0 || bottom > 1) return split;
  const point = (from: CapturePoint, to: CapturePoint, at: number): CapturePoint =>
    [from[0] + (to[0] - from[0]) * at, from[1] + (to[1] - from[1]) * at];
  return { a: point(walked[0], walked[1], top), b: point(walked[3], walked[2], bottom) };
}

/**
 * ONE PHOTOGRAPH, CUT AT A LINE -- the only body that turns a segment into two
 * pages of a book, and null when the segment cannot be one.
 *
 * ── ALWAYS FROM THE WHOLE PAGE ────────────────────────────────────────────
 *
 * `setSplit` used to record `split.x` and stop — so on the photograph somebody
 * was actually looking at, dragging the gutter stored a number and produced no
 * second page, while the stamp (which skipped the source) split every OTHER
 * photograph correctly. The one photo the gesture was performed on was the one
 * photo it did not act on.
 *
 * `joinedQuad` and not `pages[0]`, for the same reason the editor draws from
 * it: after the first drag `pages[0]` is the left half, and re-splitting that
 * would halve the page again on every adjustment. It is also what makes this
 * right for the split pass's Apply, where the same line lands on a photograph
 * that may already be cut somewhere else: the cut is always made against the
 * SHEET, so a second Apply moves the gutter rather than quartering the page.
 *
 * ── AND IT KEEPS THIS PHOTOGRAPH'S CROP, which is the whole of what makes
 *    the split pass a pass ─────────────────────────────────────────────────
 *
 * The book's crop landed at the crop-pass Apply and a complete photograph keeps
 * its own; neither is this line's business. So the sheet comes from the pages
 * as they are and only the gutter moves.
 *
 * ── Null, and why the callers must honour it ─────────────────────────────
 *
 * A segment resolving against this sheet to NEIGHBOURING edges cuts a corner
 * off — a triangle and a pentagon — and the mint rectifies four corners or
 * nothing. `seatSplit` cannot produce one from a pointer, so this is
 * unreachable from the editor and reachable from a hand-edited recipe; leaving
 * the photograph untouched is the only answer that cannot destroy a page. That
 * refusal-by-construction is why the seating lives in shared/ rather than in
 * the component: a gutter that DRAWS FINE AND REFUSES TO SAVE is this feature's
 * own precedent.
 *
 * `mine` is what the cut MEANS about this photograph -- see `cutHere`. A mark
 * the photograph ALREADY held survives either way, read from the whole
 * photograph rather than per page: a spread is two pages of one picture, and
 * half a protection reads as none.
 *
 * STRIKES SURVIVE A RE-CUT, by seat. Which half is a page is a decision about
 * the book, and moving the gutter is not taking it back.
 */
export function cutWith(photo: CapturePhoto, split: CaptureSplit, mine: boolean, seat = !mine): CapturePhoto | null {
  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  /*
   * THE BOOK'S LINE IS SEATED ON THIS PAGE'S FOLD; A HAND'S LINE IS NOT.
   *
   * `mine` already draws exactly this distinction and draws it for the mark, so
   * it draws it for the seating too rather than acquiring a second parameter
   * that would have to agree with it. `mine` is a hand on this photograph -- a
   * drag, or the tick inventing a line -- and where a hand let go is where the
   * line goes, full stop. `!mine` is the book's one line arriving from
   * somewhere else, and `seated` is what lets it arrive on the fold this page
   * actually has. See `seated` for why the adjustment lives at the landing.
   *
   * EXCEPT THAT A DRAG IS NEVER SEATED ON THE PAGE IT WAS MADE ON, whichever
   * way the tick is. With *Global* ticked `setSplit` passes `mine` false (the
   * gesture is the book's, so it must not mark the page), and the first
   * version of this seated the dragged line too -- it settled onto the shadow
   * instead of staying under the pointer, within `GUTTER_REACH`, and on the
   * release `leadTheBook` re-dressed the lead and seated it again. Coherent on
   * paper; on the stage it is a line that will not go where the hand puts it,
   * on the one page where the hand is the whole point, and it makes a
   * detector that is wrong on THIS page impossible to correct without first
   * unticking a box about every OTHER page. So `seat` is its own answer: a
   * hand's line stays where the hand let go, on that page; the followers seat
   * the same line on their own folds. The two questions -- whose line is it,
   * and does this page get to move it -- agree everywhere except under a
   * global drag, which is exactly where they needed to be two.
   */
  const line = seat ? seated(photo, whole, split) : split;
  const halves = halvesOf(whole, line);
  if (halves === null) return null;
  const [first, second] = halves;
  const kept = mine || photo.pages.some((page) => page.byHand === true);
  return {
    ...photo,
    split: line,
    pages: [
      { id: `${photo.id}:0`, quad: first, struck: photo.pages[0]?.struck ?? false, byHand: kept },
      { id: `${photo.id}:1`, quad: second, struck: photo.pages[1]?.struck ?? false, byHand: kept },
    ],
  };
}

/**
 * ONE PHOTOGRAPH'S CONFIGURATION, LIFTED INTO THE BOOK'S STANDING.
 *
 * ── The sheet, never the pages ────────────────────────────────────────────
 *
 * `joinedQuad` is the same body the editor draws from and `setSplit` re-cuts
 * from, so lifting a standing and wearing it are exact inverses rather than two
 * approximations that drift apart over a few adjustments. Storing the HALVES
 * instead would be storing a reading order, and a reading order is a fact about
 * the photograph it was taken from -- see `turned` above for the measurement
 * that makes that concrete.
 *
 * ── THE FRAME COMES WITH IT, because a crop is fractions of something ─────
 *
 * It was `sameShape`'s other half, the two numbers that stopped a portrait
 * crop resolving to a plausible, stretched region of a landscape frame. The
 * shape stopped being asked of a global on 2026-09-21 (`applyPopulations` has
 * the ruling); the frame is still recorded, because a file that says what its
 * fractions were drawn for costs nothing and reads honestly.
 */
export function standingOf(photo: CapturePhoto): CaptureLines {
  return {
    crop: {
      quad: joinedQuad(photo.pages.map((page) => page.quad), photo.split),
      width: photo.width,
      height: photo.height,
    },
    // A book of single pages has no cut, and an absent key says that better
    // than a null does -- the file stays silent about what nobody set.
    ...(photo.split === null ? {} : { cut: photo.split }),
  };
}

/**
 * ONE PHOTOGRAPH WEARING THE BOOK'S CROP AND CUT -- the only body that applies a
 * standing, and it is deliberately the only one.
 *
 * ── Two callers, and they must not be two rules ──────────────────────────
 *
 * The stamp dresses every same-shaped photograph in it, and *Match the others*
 * dresses one. Written twice, "what it means to take the book's crop" would have
 * two answers on the day it was defined -- which is the defect `outputSizeFor`,
 * `sameShape` and `splitFromFraction` were each moved into `shared/` to prevent,
 * and each of those had two bodies within hours.
 *
 * ── IT KEEPS THE TURN AND COPIES THE CROP, which is Owen's ruling ─────────
 *
 * `turnedLike` moves no corner: it relabels which corner prints top-left, taking
 * that label from the photograph being dressed. So a page somebody turned
 * upright stays upright while receiving the book's crop exactly, to the last
 * decimal, because there is no arithmetic here to be wrong by a pixel.
 *
 * ── AND IT CUTS THE SHEET RATHER THAN CARRYING TWO HALVES ────────────────
 *
 * Which is what makes it right for a spread facing the other way. Turn a spread
 * upside down and the page that was on the left is on the right; halves carried
 * across keep their old order and the book silently gets two pages in the wrong
 * sequence. Re-deriving them from the turned sheet re-orders them into reading
 * order for free, because the corner order IS the orientation.
 *
 * ── What null means ──────────────────────────────────────────────────────
 *
 * No crop in the standing -- nothing to wear -- or a cut that resolves against
 * this sheet to neighbouring edges, which cuts a corner off and is a shape the
 * mint cannot print. Both are answered by leaving the photograph alone, because
 * the alternative is inventing a page.
 *
 * STRIKES BELONG TO THE PHOTOGRAPH, NOT TO THE CONFIGURATION, so they stay on
 * the seat they were on. A page struck for being a blurred retake is still a
 * blurred retake after somebody changes its crop.
 */
export function wearing(photo: CapturePhoto, standing: CaptureLines, seat = true): CapturePhoto | null {
  const crop = standing.crop;
  if (crop === undefined) return null;
  /*
   * THE WAY THIS PHOTOGRAPH ALREADY SITS, read before its pages are replaced.
   * Any of its pages would answer the same -- both halves of a spread carry the
   * sheet's turn -- and a photograph that somehow had none keeps the standing's
   * own orientation rather than inventing an answer.
   */
  const facing = photo.pages[0]?.quad;
  const sheet = facing === undefined ? crop.quad : turnedLike(crop.quad, facing);
  /*
   * AND THE STANDING'S CUT IS SEATED ON THIS PAGE'S FOLD, for `cutWith`'s
   * reason and by the same body.
   *
   * A wearing is always the book's lines arriving on a photograph -- there is
   * no `mine` here to ask, because there is no such thing as wearing your own
   * standing -- so the cut is always a candidate for seating. It matters more
   * here than anywhere: this is the crop pass's Apply, the walk that lands one
   * line on every spread in the book at once, and it is the press Owen was
   * looking at when he asked for the fold to be found per page.
   *
   * THE SHEET IS THE ONE IT WILL BE CUT AGAINST, turn and all, so the seating
   * and the cutting cannot disagree about which edges the line runs between.
   *
   * `seat` is false for one photograph only: the LEAD of a global gesture,
   * being re-dressed on the release in the standing its own hand just wrote.
   * Its line is where the hand let go -- `cutWith` argues why that page, of
   * all pages, must not be moved by the detector.
   */
  const cut = standing.cut === undefined ? null : (seat ? seated(photo, sheet, standing.cut) : standing.cut);
  const halves = cut === null ? null : halvesOf(sheet, cut);
  if (cut !== null && halves === null) return null;
  const quads: readonly CaptureQuad[] = halves ?? [sheet];
  /*
   * A PHOTOGRAPH WEARING THE STANDING SAYS NOTHING ABOUT ITSELF -- the stored
   * answer goes, in both directions, and `byHand: false` goes with it.
   *
   * It is `placed`'s rule from the other side. A page that has just taken the
   * book's crop is a FOLLOWER by construction, so the derive gives the right
   * answer and a stored one could only ever contradict it: a `true` left here
   * would exclude a photograph from the next Apply for a decision the Apply has
   * just overwritten, and a `false` would be a release nobody pressed, kept
   * beside pages that already say the same thing.
   *
   * That covers *Match the others* as well, which is the release and the Apply
   * in one press: the page gives up its own lines, so it gives up the answer it
   * held about them.
   */
  const worn = { ...photo };
  delete worn.complete;
  return {
    ...worn,
    split: cut,
    pages: quads.map((quad, seat) => ({
      id: `${photo.id}:${seat}`,
      quad,
      struck: photo.pages[seat]?.struck ?? false,
      /*
       * THE GLOBAL CLEARS THE MARK, ruled at channel seq 129. Left standing, the
       * first stamp would mark every page hand-set and the second would skip
       * every one -- a feature that works exactly once per project.
       *
       * It is equally right on the *Match the others* path, and for a clearer
       * reason there: a page that has just taken the book's crop is not a page
       * somebody set by hand. That is the whole content of the press.
       */
      byHand: false,
    })),
  };
}
