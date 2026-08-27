/**
 * THE CATEGORIES A BOOK CAN BE READ AGAINST — the checklist, in one place.
 *
 * ── Where these come from, and why the app keeps a copy at all ──────────────
 *
 * The ORIGIN is `src/analyze/plan.ts` — `HYPOTHESES` and `UNTUNED_BOOK_CATEGORIES`,
 * in the order `builtInCategories()` returns them, which is the order a default
 * run plans them and therefore the order the report's header lists them in. That
 * file is the engine's, compiled into the `foundry` binary; `app/shared` is
 * compiled by the electron program and by the renderer, and neither can reach
 * into it. So this is a MIRROR, on exactly the terms `shared/languages.ts` is a
 * mirror of the engine's language table: the two grow together, and the day one
 * of them gains an entry the other is a line behind.
 *
 * WHAT THE MIRROR IS ALLOWED TO CARRY IS THE NAME AND NOTHING ELSE. The
 * hypotheses, the propositions, the capture floors and the whole measured axis
 * stay on the engine's side, where they were calibrated and where they are
 * argued. A checklist needs an id to send and a phrase to draw beside a checkbox;
 * copying a stance hypothesis into a renderer would put a prompt in a window and
 * invite the next person to edit it there.
 *
 * A NAME THIS BUILD DOES NOT KNOW IS STILL LEGIBLE. The panel groups findings by
 * the category the report names, and a report made by a newer engine can carry
 * one this list has never heard of — so `analysisCategoryName` falls back to the
 * id said aloud rather than refusing to draw the row. That is not a fallback in
 * the forbidden sense: nothing is guessed and nothing is substituted, the id is
 * simply printed as itself.
 *
 * ── `misinformation` IS NOT HERE, AND ITS ABSENCE IS MEASURED ───────────────
 *
 * The engine refuses to rank it and says why (`MISINFORMATION_EXCLUSION`,
 * src/analyze/plan.ts): every stance hypothesis for it degenerates to "the author
 * makes a factual assertion", and whether an assertion is FALSE is world
 * knowledge an entailment model does not have. briefcase measured the cost —
 * 169 of 205 candidates and 19 of 20 verified false positives were that one
 * category. So it is not on the checklist, because a checkbox whose only possible
 * outcome is a line in the log saying the category was skipped is a checkbox that
 * teaches somebody the feature is broken.
 */

/** One category, as the checklist draws it and as the report names it. */
export interface AnalysisCategory {
  /** The engine's own id — what travels on the wire and what a report row says. */
  id: string;
  /** What the checkbox says. The reader's words, not the hypothesis's. */
  name: string;
  /**
   * THE HUE THIS CATEGORY IS KNOWN BY IN THE PANEL — 0–359, and a NAME rather
   * than a temperature.
   *
   * Owen, 2026-08-25: *"maybe each category has its own color or something."*
   * The panel's cards are a flat sequence in the book's own order now, so the
   * thing that used to be a group heading has to be carried by the card itself,
   * and a colour rail down its left edge is the app's existing idiom for exactly
   * that (the block chrome's `.gutter.rail`).
   *
   * ── WHY THE ASSIGNMENT IS DELIBERATELY ARBITRARY ──────────────────────────
   *
   * Nothing here is warm because it is worse. docs/ANALYSIS.md §1 rules that
   * there is NO SEVERITY — the flagged passage IS the finding — and a hue table
   * that ran cool-to-hot would smuggle a severity back in through the paint,
   * where nothing measured one. So the hue is an IDENTITY TOKEN: stable per
   * category, distinct from its neighbours, and meaningless as a scale. The
   * twelve values below are drawn from a hand-checked wheel whose smallest gap
   * is 24° (large gaps through the greens, where hue discrimination is worst),
   * and they are dealt out with a stride so that two categories ADJACENT IN THE
   * LEGEND are never adjacent on the wheel — the legend is the one place a
   * person reads the dots as a set.
   *
   * ── AND THE PAPER NEVER SEES IT ────────────────────────────────────────────
   *
   * The book view keeps its single `--ink-hit` and will go on keeping it. That
   * is the confetti ruling (book-view.component.ts, the class docblock and
   * `Piece.hit`; docs/ANALYSIS.md §8 — *"the page must not turn into
   * confetti"*), and it is not softened by this table: a page carrying four
   * categories in four inks is a page nobody can read, and the category has a
   * name and a colour beside it in the panel, where there is room for both. A
   * NUMBER is exported rather than a colour string for the same reason — the
   * hue is a fact about the category, the colour it becomes is a decision about
   * one surface's ground, and that decision belongs to the panel.
   */
  hue: number;
  /**
   * True where the hypotheses behind it were calibrated against reference
   * material, false for the ones that are first drafts.
   *
   * IT IS DRAWN, and quietly. docs/ANALYSIS.md §5 rules that an untuned category
   * may produce too many candidates or too few and that the report says which
   * ones they are; the dialog says it before the run rather than only afterwards,
   * because the person deciding whether to spend an hour is the person who wants
   * to know which half of the checklist has been measured.
   */
  tuned: boolean;
}

/**
 * Every category the engine plans by default, in plan order.
 *
 * ── The two at the end are Owen's book categories ───────────────────────────
 *
 * *"jehovahs witness anti evolution material, christian nationalist books,
 * project 2025, etc."* Christian nationalism was already tuned in briefcase and
 * sits with the other nine. The other two have no calibrated hypothesis anywhere
 * and enter description-backed and saying so, which is why they carry
 * `tuned: false` and why the report names them in its `untuned` list. Tuning them
 * against reference books is follow-up work indexed in docs/PLAN.md.
 */
export const ANALYSIS_CATEGORIES: readonly AnalysisCategory[] = [
  { id: 'political-demonization', name: 'Political demonization', hue: 352, tuned: true },
  { id: 'hate', name: 'Hate', hue: 130, tuned: true },
  { id: 'conspiracy', name: 'Conspiracy', hue: 264, tuned: true },
  { id: 'dehumanization', name: 'Dehumanization', hue: 68, tuned: true },
  { id: 'violence', name: 'Violence', hue: 210, tuned: true },
  { id: 'false-prophecy', name: 'False prophecy', hue: 20, tuned: true },
  { id: 'christian-nationalism', name: 'Christian nationalism', hue: 158, tuned: true },
  { id: 'prosperity-gospel', name: 'Prosperity gospel', hue: 300, tuned: true },
  { id: 'extremism', name: 'Extremism', hue: 96, tuned: true },
  { id: 'political-violence', name: 'Political violence', hue: 236, tuned: true },
  { id: 'anti-evolution', name: 'Anti-evolution and science denial', hue: 44, tuned: false },
  { id: 'authoritarian-blueprint', name: 'Authoritarian blueprint', hue: 186, tuned: false },
];

/** Every id, for the checks that only need the set. */
export const ANALYSIS_CATEGORY_IDS: readonly string[] = ANALYSIS_CATEGORIES.map((one) => one.id);

/**
 * What to call a category on screen — the mirror's phrase, or the id said aloud.
 *
 * Hyphens become spaces and the first letter is capitalised, which is what makes
 * an unknown id from a newer engine read as words rather than as a token. Nothing
 * is guessed: `authoritarian-blueprint` would come back as "Authoritarian
 * blueprint" whether or not it were in the table, and the table exists for the
 * ones whose good phrase is not their id ("Anti-evolution and science denial").
 */
export function analysisCategoryName(id: string): string {
  const known = ANALYSIS_CATEGORIES.find((one) => one.id === id);
  if (known !== undefined) return known.name;
  const said = id.replace(/-/g, ' ').trim();
  return said.length === 0 ? id : said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * The hue a category is known by — the table's, or one derived from its id.
 *
 * ── THE FALLBACK IS A HASH, AND THAT IS THE WHOLE RULE ──────────────────────
 *
 * A category somebody added themselves has no row in the table above, and it is
 * never going to get one: the table is the mirror of the engine's built-ins. So
 * its colour is DERIVED FROM ITS NAME, by a 32-bit FNV-1a over the id folded
 * into the wheel. Three properties fall out of that and they are the three that
 * matter:
 *
 *   * It is STABLE. The same id is the same hue in this session, in tomorrow's,
 *     and on another machine, with nothing stored anywhere and nothing to
 *     migrate. A colour that had to be persisted would be a fourth field on a
 *     user's category that could go missing, and a colour ALLOCATED in order of
 *     appearance would repaint every custom category the day one was removed.
 *   * It needs to know nothing about what else is on screen. The legend is
 *     built per report, from whatever categories that report happens to name;
 *     a scheme that spaced colours against the current set would give one
 *     category two colours in two reports.
 *   * It can land near a built-in's hue, and that costs nothing that is worth
 *     paying to avoid. Every dot in the legend and every rail on a card has the
 *     category's NAME beside it — the colour is an aid to scanning a list, not
 *     the thing that identifies a finding — so a near-collision makes two rails
 *     look similar and leaves both cards correct. Reserving arcs against a set
 *     that changes per report would buy a guarantee at the price of stability,
 *     which is the property actually being used.
 *
 * A REPORT FROM A NEWER ENGINE gets the same treatment for the same reason, and
 * so does a report naming a custom category that has since been removed from the
 * user's list — the report carries its own category names (`AnalysisReading`),
 * and nothing here needs the category to still exist to draw it.
 */
export function analysisCategoryHue(id: string): number {
  // The hue values and this fallback are MIRRORED in src/analyze/plan.ts
  // (`categoryHue`), which stamps them into every report's `hues` header so
  // the artifact owns its colours on devices that carry neither table. A
  // change here that does not move there is two answers about one colour.
  const known = ANALYSIS_CATEGORIES.find((one) => one.id === id);
  if (known !== undefined) return known.hue;
  // FNV-1a, 32-bit, spelled out rather than imported: it is four lines, it is
  // the same four lines in every language, and a hash whose exact arithmetic
  // decides a colour is a thing to be able to read at the point of use.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * ONE CATEGORY A PERSON WROTE — the name they gave it and the sentence that IS
 * its hypothesis.
 *
 * Owen, 2026-08-25: *"maybe the user can add more categories - even
 * one-sentence descriptive ones."* Engine-side this is not a new door and not a
 * concession: `buildPlan` (src/analyze/plan.ts) has always accepted a
 * description-backed category and wrapped it into a hypothesis
 * (`describedHypothesis`), and the two built-ins Owen asked for by name —
 * anti-evolution, authoritarian-blueprint — came in through that very shape.
 * What was missing was a way to SAY one from the app.
 *
 * THE DESCRIPTION IS THE HYPOTHESIS SEED AND IS NOT DECORATION. It is wrapped
 * as *"The author's statement matches this description: …"* and scored against
 * every sentence in the book, which is why the dialog asks for a claim in a
 * sentence rather than a topic in a word — and why the report marks every one of
 * these untuned, because nothing has calibrated a sentence somebody typed this
 * afternoon.
 *
 * IT IS THE USER'S AND NOT ONE PROJECT'S, which is why it persists in
 * `app-settings.json` (electron/app-settings.ts) beside the library folder
 * rather than in a project directory. Somebody who has decided they care about a
 * claim cares about it in the next book too; per-run enablement is the dialog's
 * checklist, which is a different question asked each time.
 */
export interface CustomAnalysisCategory {
  /** Slugged from the name at the moment it was added. See `customCategoryId`. */
  id: string;
  /** What the checkbox and the legend say. */
  name: string;
  /** One sentence. The engine wraps it into this category's only hypothesis. */
  description: string;
}

/** How long a description may be. Long enough for a claim, short of an essay. */
export const CUSTOM_CATEGORY_DESCRIPTION_MAX = 240;

/** How long a name may be, so a legend chip stays a chip. */
export const CUSTOM_CATEGORY_NAME_MAX = 48;

/**
 * The id a typed name becomes — lower case, words joined by hyphens.
 *
 * IT IS THE ENGINE'S SPELLING because it is what the engine will be handed: the
 * built-in ids are all of this shape, a report row names a category by this
 * string, and `place()` keys the panel's grouping off it. Anything that is not a
 * letter or a digit collapses to one hyphen and the ends are trimmed, so
 * "Project 2025 / blueprint" is `project-2025-blueprint` — legible in a report
 * somebody opens in a text editor, and safe in the one place the app writes a
 * category name to disk (`<report>.categories.json`).
 *
 * An empty answer means the name was punctuation, and the caller refuses.
 */
export function customCategoryId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
