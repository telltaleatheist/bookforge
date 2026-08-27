import type { ReplayedRow } from '@shared/ops';
import type { AnalysisFindingRow } from '@shared/types';

import { SENTENCE_REACH, quoteAround, type SweepQuote } from './sweep';

/**
 * THE ANALYSIS'S ARITHMETIC — a stored report, laid over the book on the paper.
 *
 * ── Why it is a module and not methods on the panel ─────────────────────────
 *
 * `sweep.ts` next door, deliberately and for the same three reasons. Everything
 * here is a pure function of a list of rows and a list of report rows; the panel
 * holds the sitting — which tier is pressed, which row the pointer is over — and
 * nothing else. Keeping the mapping out of the component is what makes the
 * unplaced rule readable as a rule rather than as a branch inside a template, and
 * it is what lets ONE answer feed two surfaces: the rows in the second column and
 * the lit runs on the paper are the same list, so they can never disagree about
 * which words are flagged.
 *
 * IT LIVES UNDER `core/` AND NOT UNDER `shared/`, on `sweep.ts`'s own argument.
 * Nothing in the main process maps a report onto rows: what crosses the boundary
 * is the report itself (`AnalysisReading`), whose shape is over there. A copy of
 * this in `shared/` would be compiled by the electron program for no consumer.
 *
 * ── THE ONE THING THIS CANNOT DO, SAID PLAINLY ──────────────────────────────
 *
 * A report's rows are `[start, end)` character offsets into a block's text AS THE
 * BOOK FILE THE RUN READ CARRIED IT (docs/ANALYSIS.md §6). The run reads the
 * position's book materialised at the moment the button was pressed, so at that
 * instant the offsets agree with the paper exactly. An op applied AFTERWARDS can
 * move them: retype a sentence in the middle of a flagged paragraph and every
 * offset after it shifts by the difference.
 *
 * NOTHING HERE CAN DETECT THAT IN GENERAL, and pretending otherwise would be
 * worse than admitting it. The report carries no quotation to compare against —
 * by design, because storing the words would be storing a second copy of the book
 * — so the only test available is whether the offsets still land INSIDE the row's
 * current text. A hit whose slice is empty or out of range is reported as
 * unplaced; a hit whose slice now covers different words is drawn, and it is
 * drawn over the wrong words. The sweep dodges this entirely by rescanning the
 * live text on every open; an analysis cannot, because rescanning would mean
 * re-running an hour of model time.
 *
 * WHAT MAKES THAT ACCEPTABLE RATHER THAN A DEFECT is what the report is for: it
 * is a reading of a book at a moment, filed under the step it was run against
 * (Owen's own model for it), and the honest response to having edited the book
 * since is to analyse again — which, because every answer in the file is keyed to
 * the question that produced it, costs only the paragraphs that changed.
 */

/** The quotation a row draws, cut at the span so the middle can be lit. */
export type AnalysisQuote = SweepQuote;

/** Which of the three buttons the panel is standing on. Exactly one, always. */
export type AnalysisTier = 'strict' | 'moderate' | 'loose';

/**
 * THE TIERS, AS NUMBERS — Owen's ruling (docs/ANALYSIS.md §2 and §8) in one table.
 *
 * *"it flags absolutely anything that could possibly match and then we have a
 * button that displays things that match strictly (only turn up a few options), a
 * moderate filter, or a very loose filter."*
 *
 * The run captured ONCE, at the widest calibrated net, so these are a slice over
 * stored numbers and nothing re-runs. 0.9 and 0.7 are briefcase's own measured
 * ladder: 0.7 is the calibrated default a plain briefcase run would have
 * produced, and 0.9 is the near-certain entailments — the few options.
 *
 * LOOSE HAS NO FLOOR HERE, and that is not an omission: the floor is the CAPTURE
 * floor, 0.2, applied by the run itself, so a score below the loosest tier is a
 * score nobody stored. What Loose adds instead is the skips — the passages the
 * verifier threw back — which is the half of the ruling that matters most: *"a
 * person hunting for 'almost everything' is owed the net's whole contents, told
 * honestly which fish the verifier threw back."*
 */
const TIER_FLOOR: Readonly<Record<AnalysisTier, number>> = {
  strict: 0.9,
  moderate: 0.7,
  loose: 0,
};

/** One block's share of one finding — where on the paper it is, and what it says. */
export interface AnalysisSpan {
  /** The block, by the name every op and every reveal is keyed to. */
  id: string;
  /**
   * The page this block started on — an ESTIMATE and never an address
   * (`BookRow.page`), which is why the chip wears the ≈ the sheet's own ghosts
   * wear. Zero on a book exploded out of an EPUB, and the chip is not drawn.
   */
  page: number;
  /** Half-open, into the block's replayed text. */
  start: number;
  end: number;
  /** The characters themselves, as the row carries them now. */
  text: string;
  /** The block is struck: drawn ghosted, and never lit on the paper. */
  struck: boolean;
}

/** One finding: one candidate passage, however many blocks it touches. */
export interface AnalysisHit {
  /**
   * THE NAME A ROW IS TRACKED BY, minted here rather than derived at the row.
   * `${id}#${start}` of the FIRST span, which docs/ANALYSIS.md §8 names as the
   * hit key: two passages cannot begin at the same character of the same block,
   * so this identifies one finding and no other. A field rather than a template
   * expression because the list has no cap on it and a string composed per row
   * per repaint is the one piece of work the mapping can hand it for free.
   */
  key: string;
  /** The report's own ordinal for this passage — shared by every row it wrote. */
  hit: number;
  /** The primary category: the strongest one the verifier flagged. */
  category: string;
  /** The other categories flagged on this passage, strongest first. */
  also: readonly string[];
  /** The primary category's own score. The tiers slice on this. */
  score: number;
  /** The verifier's answer. A skip is drawn ghosted, under Loose only. */
  verdict: 'flag' | 'skip';
  /** Every block this passage touches, in reading order. */
  spans: readonly AnalysisSpan[];
  /** The sentence around the first span, for the row's ordinary state. */
  quote: AnalysisQuote;
  /**
   * Every block of this finding is already struck.
   *
   * Listed rather than dropped, on the sweep's rule for its own ghosted rows: a
   * person reading a report wants to know that the passage it flagged is one they
   * have already cancelled, which is a different fact from its absence.
   */
  struck: boolean;
}

/** A report laid over the book: what landed, and what could not be placed. */
export interface AnalysisPlacement {
  hits: readonly AnalysisHit[];
  /**
   * ONE SENTENCE PER FINDING THIS BOOK HAS NOWHERE TO PUT — never a refusal to
   * draw the panel.
   *
   * `BookLoad.unplaced`'s precedent exactly, and its argument transfers word for
   * word: the report IS readable, what it is missing is a handful of passages out
   * of somebody's hour, and refusing to open a panel over that would be worse
   * than saying which ones they were. The sentence names the block, because that
   * is where a person would go and look.
   *
   * Two things produce one: a block the report names that this book no longer
   * holds (a re-read mints new ids; a merge consumes a block), and offsets that
   * no longer land inside the row's current text. See this module's header for
   * what it CANNOT catch — offsets that still land, on different words.
   */
  unplaced: readonly string[];
}

const NO_HITS: readonly AnalysisHit[] = [];
const NO_SENTENCES: readonly string[] = [];

/**
 * THE REPORT, LAID OVER THE BOOK AS IT NOW STANDS.
 *
 * ── What is mapped, and the two rows that are not ───────────────────────────
 *
 * The rows are `view().rows` — the recorded chain and the pending stack already
 * replayed in, on whichever pass the workbench stands. A SHELVED ROW IS SKIPPED,
 * which is `scan`'s own refinement of the same rule one file over: a shelved
 * block is in the file and not in the flow, so it is not on the paper, `reveal`
 * cannot travel to it, and no edition ever emits it. A finding about one is a
 * finding about text nobody can see.
 *
 * A STRUCK ROW IS KEPT AND GHOSTED rather than skipped, which is the other half
 * of the same distinction: a struck block is still on the paper, drawn cancelled,
 * and somebody who ordered an analysis wants to see that the passage it found is
 * one they have already taken out.
 *
 * ── The grouping is the whole of it ─────────────────────────────────────────
 *
 * A passage that crosses a paragraph break writes one row per block, sharing the
 * report's `hit` ordinal (docs/ANALYSIS.md §6). They are ONE finding: one row on
 * the panel, one travel, one lit stretch across two blocks. Grouping by `hit` is
 * what makes that true, and it is why nothing here reads a row in isolation.
 *
 * ── AND THE ORDER IS THE BOOK'S, NOT THE REPORT'S ───────────────────────────
 *
 * The engine verifies in DESCENDING window score, deliberately, so that a run
 * interrupted an hour in has already finished the findings most worth trusting —
 * and it writes them in the order the verdicts landed. That is the right order
 * for a file being appended to and the wrong one for a list somebody reads beside
 * a book, where the only order that means anything is the book's own. So the hits
 * come back in reading order, which is the order of the rows they were placed on.
 */
export function place(
  rows: readonly ReplayedRow[],
  findings: readonly AnalysisFindingRow[],
): AnalysisPlacement {
  if (findings.length === 0) return { hits: NO_HITS, unplaced: NO_SENTENCES };

  /*
   * THE ROWS, BY ID AND BY POSITION, in one pass. The map answers "does this
   * book still hold that block"; the index answers "where in the book is it",
   * which is what puts the finished list in reading order without a second walk
   * and without any list here holding an opinion about how a book is ordered.
   */
  const byId = new Map<string, { row: ReplayedRow; at: number }>();
  /*
   * THE SHELVED ONES ARE REMEMBERED SEPARATELY, and the reason is a sentence
   * rather than a lookup. A shelved row is skipped above and is therefore
   * indistinguishable from a row this book does not hold — and those are two
   * different facts a person can act on. "The block is gone" means the pages were
   * read again; "the block is furniture" means somebody shelved a running head
   * the analysis had found something in, and the Furniture panel is where it is.
   * Saying the first about the second would send them looking for a block that is
   * exactly where they put it.
   */
  const shelved = new Set<string>();
  rows.forEach((row, at) => {
    if (row.shelf !== undefined) {
      shelved.add(row.id);
      return;
    }
    byId.set(row.id, { row, at });
  });

  const grouped = new Map<number, AnalysisFindingRow[]>();
  for (const finding of findings) {
    const held = grouped.get(finding.hit);
    if (held === undefined) grouped.set(finding.hit, [finding]);
    else held.push(finding);
  }

  const unplaced: string[] = [];
  const placed: { at: number; hit: AnalysisHit }[] = [];

  for (const [ordinal, group] of grouped) {
    /*
     * IN THE BOOK'S ORDER WITHIN THE FINDING TOO, and by the row's position
     * rather than by the report's. A passage's rows are written in whatever order
     * the engine walked its blocks; what the panel quotes and what `reveal`
     * travels to is the FIRST of them on the page.
     */
    const spans: { at: number; span: AnalysisSpan; row: ReplayedRow }[] = [];
    let lost: string | null = null;
    for (const row of group) {
      const found = byId.get(row.id);
      if (found === undefined) {
        lost ??= shelved.has(row.id)
          ? `A passage was found in a block that has since been shelved as furniture (${row.id}).`
          : `A passage was found in a block this book no longer has (${row.id}).`;
        continue;
      }
      const text = found.row.text;
      /*
       * THE ONLY TEST THERE IS, and the module header says why there is no
       * better one: the offsets have to land inside the string, and the slice
       * they name has to be something rather than nothing. A `start` past the end
       * of an edited block, an `end` beyond it, or a range that has collapsed to
       * zero characters are each a hit this book cannot draw.
       */
      if (row.start < 0 || row.end > text.length || row.end <= row.start) {
        lost ??= `A passage no longer fits inside its block (${row.id}) — it has been edited since `
          + 'this analysis ran.';
        continue;
      }
      spans.push({
        at: found.at,
        row: found.row,
        span: {
          id: row.id,
          page: found.row.page,
          start: row.start,
          end: row.end,
          text: text.slice(row.start, row.end),
          struck: found.row.struck === true,
        },
      });
    }

    /*
     * A FINDING IS PLACED OR IT IS NOT, and a partly-placed one is not.
     *
     * If any block of a passage came loose, the passage as a whole is reported
     * rather than drawn from whichever halves survived: a quotation showing two
     * of a passage's three paragraphs, with nothing on the row saying so, is the
     * panel lying about what the verifier actually read. The sentence names the
     * block that failed, which is where a person would go and look.
     */
    if (lost !== null || spans.length === 0) {
      unplaced.push(lost ?? `A passage was found in blocks this book no longer has (hit ${ordinal}).`);
      continue;
    }
    spans.sort((a, b) => (a.at === b.at ? a.span.start - b.span.start : a.at - b.at));
    const first = spans[0]!;
    /*
     * THE PRIMARY CATEGORY AND THE SCORE COME OFF THE FIRST ROW, and every row of
     * a passage carries the same pair — the engine writes one finding per block
     * with the window's own category, `also` and score repeated (docs/ANALYSIS.md
     * §6). Reading them from the first placed row rather than from the first
     * REPORTED one is deliberate: if the report's leading block came loose, the
     * facts about the passage are still true and are still on every other row.
     */
    const lead = group.find((row) => row.id === first.span.id) ?? group[0]!;
    placed.push({
      at: first.at,
      hit: {
        key: `${first.span.id}#${first.span.start}`,
        hit: ordinal,
        category: lead.category,
        also: lead.also,
        score: lead.score,
        verdict: lead.verdict,
        spans: spans.map((one) => one.span),
        quote: quoteAround(first.row.text, first.span.start, first.span.end, SENTENCE_REACH),
        struck: spans.every((one) => one.span.struck),
      },
    });
  }

  placed.sort((a, b) => (a.at === b.at
    ? a.hit.spans[0]!.start - b.hit.spans[0]!.start
    : a.at - b.at));
  return {
    hits: placed.length === 0 ? NO_HITS : placed.map((one) => one.hit),
    unplaced: unplaced.length === 0 ? NO_SENTENCES : unplaced,
  };
}

/**
 * THE TIER FILTER — a pure function of (findings, tier), and nothing re-runs.
 *
 * *"it should light up/highlight text that matches the categories… a button that
 * displays things that match strictly, a moderate filter, or a very loose
 * filter."* (Owen, 2026-08-25.) The report is the same file under every button:
 * the run captured once at the widest net and the strictness lives here, which is
 * why changing your mind costs a click rather than an hour (docs/ANALYSIS.md §2).
 *
 *   STRICT     the verifier flagged it AND the score is 0.9 or better.
 *   MODERATE   the verifier flagged it AND the score is 0.7 or better —
 *              briefcase's calibrated default, the set a plain run would produce.
 *   LOOSE      everything the net caught, verdict included: the flags AND the
 *              skips, down to the run's own capture floor.
 *
 * A SKIP IS NEVER IN THE FIRST TWO, and it is not a matter of its score. The
 * verifier's answer is the whole of what distinguishes "the author asserts this"
 * from "the author is quoting somebody who asserts this", and a passage it threw
 * back is not a finding at either strictness — it is the net's contents, shown
 * under Loose, ghosted and labelled as the rejection it is.
 */
export function tiered(hits: readonly AnalysisHit[], tier: AnalysisTier): readonly AnalysisHit[] {
  if (tier === 'loose') return hits;
  const floor = TIER_FLOOR[tier];
  const kept = hits.filter((one) => one.verdict === 'flag' && one.score >= floor);
  return kept.length === 0 ? NO_HITS : kept;
}

/**
 * THE WIDENED QUOTATION DIED HERE (2026-08-25), and the gravestone is the point.
 *
 * `widen(rows, hit)` handed the panel a four-times-longer quotation to float in a
 * hover glance. Owen killed the glance with the rest of the panel's repetition:
 * *"the tool tips are just repeating whats already on screen - unnecessary."* The
 * glance was the one tooltip on that surface that did NOT merely repeat — it
 * showed more — and it went anyway, because the rework gives its job to something
 * better. Clicking a card now travels to the passage on the paper AND the paper
 * scrolls the panel back, so the fuller passage is not a rectangle that appears
 * under the pointer for as long as the hand holds still: it is the book, in the
 * column beside the list, with the words lit in place. A hover preview of a
 * paragraph you are one click from reading is a worse copy of the reading.
 *
 * `sweep.widen` is untouched and is still the sweep's — that card is a modal over
 * the page and has no book beside it to travel to, which is the difference.
 */

/** One stretch of a block's text that the paper draws lit. */
export interface LitRange {
  start: number;
  end: number;
  /**
   * WHICH FINDING THIS STRETCH BELONGS TO — the first one covering it, by hit
   * key, so the paper can say which card a click on these words means.
   *
   * Owen, 2026-08-25: *"as i scroll/click highlighted text, it should jump to
   * that spot in the analysis."* The paper's runs had no idea which finding they
   * were drawn for — merging (below) deliberately threw that away, because what a
   * CHARACTER needs to know is only whether it is lit — so the key rides the
   * merged range instead, where it costs one string per run rather than one per
   * character and changes nothing about how the ink is decided.
   *
   * THE FIRST COVERING FINDING AND NOT "THE STRONGEST", and the reason is that
   * there is no strongest: docs/ANALYSIS.md §1 rules that there is no severity,
   * so a stretch two findings share has no ranking to break the tie with. What it
   * does have is an ORDER — the hits arrive in the book's own reading order — and
   * the first of them is the card nearest the top of the panel, which is the one
   * a person clicking those words is most likely looking at. Both cards are one
   * scroll apart in a list that is in the book's order; picking the earlier is a
   * rule, not a guess.
   */
  key: string;
  /**
   * THE CATEGORY THAT STRETCH IS FLAGGED UNDER — the same finding's, so the
   * paper can tint it the colour its card wears.
   *
   * ── THE ONE-INK RULING WAS OVERRULED, 2026-08-25, AND BY THE RIGHT PERSON ──
   *
   * docs/ANALYSIS.md §8 said *"the page must not turn into confetti"* and this
   * module said it twice. Owen, reading the reworked panel against the paper:
   * *"maybe make the text's highlighted color the same color as the analysis
   * block."* That is the overriding word, and it is a better answer than the one
   * it replaces — the confetti fear was about a page speaking a code nobody can
   * decode, and the legend beside the page is exactly the decoder that was
   * missing when the ruling was made. A tint that AGREES with the card two inches
   * away is one fact drawn twice, not two facts competing.
   *
   * WHAT SURVIVES OF THE OLD RULING IS THE ALPHA DISCIPLINE, which is where the
   * real risk always was (`shared/categories.ts`'s header: *"applied as an
   * outline and a tint, never as text colour: this is a book, and recolouring its
   * words makes it unreadable"*). The words stay black on cream; what changes is
   * the wash behind them.
   *
   * It rides the merged range beside the key, and it needs no separate
   * agreement test when runs join: a key names one finding and a finding has one
   * primary category, so two neighbours agreeing about the key agree about this.
   */
  category: string;
  /**
   * False where every finding covering this stretch is a verdict the verifier
   * REJECTED — drawn as the ghosted variant, the same shown-but-inert treatment a
   * struck row gets. True where at least one flagged finding covers it.
   *
   * ANY FLAG WINS OVER EVERY SKIP, and that is the only reading that is not a
   * lie: a stretch a flagged passage covers IS flagged, whatever else also
   * happens to overlap it, and drawing it ghosted because a rejected passage
   * shares two of its words would understate the strongest thing said about it.
   */
  solid: boolean;
}

const NO_LIT: ReadonlyMap<string, readonly LitRange[]> = new Map();

/**
 * WHICH CHARACTERS OF WHICH BLOCKS THE PAPER LIGHTS — the same hits the panel
 * lists, turned into runs the book view can walk.
 *
 * ── One source of truth, two surfaces ───────────────────────────────────────
 *
 * The panel's rows and the paper's lit stretches come out of one `place()` and
 * one `tiered()`, and this is the last step of the second road. Nothing in the
 * book view decides what is flagged; it is handed ranges and draws them.
 *
 * ── Why the ranges are MERGED and not one per finding ───────────────────────
 *
 * Two findings can overlap in one block — two categories flagged on windows that
 * share a sentence is the ordinary case, not the exception. Handed both, the
 * book view's cursor walk would have to decide what "the covering finding" is at
 * a character two of them claim, and the honest answer is that the question is
 * not about findings at all: the paper draws ONE highlight ink (docs/ANALYSIS.md
 * §8 — *"the page must not turn into confetti"*), so what a character needs to
 * know is whether it is lit and whether the light is solid. Merging here answers
 * exactly that and leaves the walk with nothing to decide.
 *
 * A STRUCK BLOCK IS NEVER LIT. It is drawn cancelled and it is absent from every
 * edition; painting a highlight over the cancel would be two marks arguing about
 * one paragraph. The panel still lists the finding, ghosted, which is where that
 * fact belongs.
 */
export function litRanges(hits: readonly AnalysisHit[]): ReadonlyMap<string, readonly LitRange[]> {
  if (hits.length === 0) return NO_LIT;
  const raw = new Map<string, LitRange[]>();
  for (const hit of hits) {
    const solid = hit.verdict === 'flag';
    for (const span of hit.spans) {
      if (span.struck) continue;
      const held = raw.get(span.id);
      const one = {
        start: span.start,
        end: span.end,
        solid,
        key: hit.key,
        category: hit.category,
      };
      if (held === undefined) raw.set(span.id, [one]);
      else held.push(one);
    }
  }

  const out = new Map<string, readonly LitRange[]>();
  for (const [id, spans] of raw) {
    out.set(id, mergeLit(spans));
  }
  return out.size === 0 ? NO_LIT : out;
}

/**
 * OVERLAPPING SPANS, BECOME NON-OVERLAPPING RUNS — sorted, and adjacent runs of
 * one strength joined.
 *
 * A sweep line over every boundary either span mentions: between two consecutive
 * boundaries the covering set cannot change, so each segment has one answer to
 * "is anything covering this" and one to "is any of it solid". Segments nothing
 * covers are dropped and neighbours that agree are joined, which is what keeps
 * the walk in `cut()` closing a run only where the paper actually changes.
 *
 * THE KEY IS THE FIRST COVERING SPAN'S, and it joins `solid` as a thing two
 * neighbours must AGREE ABOUT before they merge — see `LitRange.key`. That makes
 * the runs slightly finer than they were: two findings that abut inside one block
 * used to become one run and are now two, which is one more `<span>` on one
 * paragraph and the price of a click knowing what it clicked.
 */
function mergeLit(spans: readonly LitRange[]): LitRange[] {
  const edges = new Set<number>();
  for (const span of spans) {
    edges.add(span.start);
    edges.add(span.end);
  }
  const points = [...edges].sort((a, b) => a - b);
  const out: LitRange[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    let solid = false;
    let owner: LitRange | null = null;
    for (const span of spans) {
      if (span.start <= from && span.end >= to) {
        if (span.solid) solid = true;
        // The spans arrive in the hits' own order, which is the book's, so the
        // first one to claim this segment is the earliest finding covering it.
        owner ??= span;
      }
    }
    if (owner === null) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.end === from && last.solid === solid && last.key === owner.key) {
      last.end = to;
    } else {
      out.push({ start: from, end: to, solid, key: owner.key, category: owner.category });
    }
  }
  return out;
}

/** One row of the panel's legend: a category present in this report, and how much. */
export interface AnalysisLegendEntry {
  category: string;
  /** How many findings the tier lets through carry this as their primary. */
  count: number;
}

/**
 * THE LEGEND — every category the visible findings name, counted.
 *
 * ── What replaced the grouping, and why ─────────────────────────────────────
 *
 * The panel used to be sections: a category heading, then its findings, then the
 * next heading. Owen, 2026-08-25: *"lets rework it a bit so each item is in its
 * own block, in the order in which it appears."* Reading order is the only order
 * a list beside a book can be in — a reader scrolling page 90 wants the card for
 * page 90, and a grouped list scatters that page's findings down five sections —
 * so the grouping is gone and what it carried is here instead: the category names
 * and their counts, in one header, each one a switch.
 *
 * IT IS COUNTED OVER THE TIER'S FINDINGS AND NOT OVER THE WHOLE REPORT, because
 * the number beside a switch has to mean "this many cards below" — a legend
 * saying 14 over a list holding 3 would be counting a set the buttons above it
 * have already excluded.
 *
 * AND IT IS COUNTED BEFORE THE CATEGORY FILTER ITSELF (see `onlyCategories`), so
 * that switching one off leaves its own count legible. A row whose count went to
 * zero the moment you pressed it would be a switch that erased the label telling
 * you what pressing it again would bring back.
 *
 * IN THE ORDER THE CATEGORIES FIRST APPEAR IN THE BOOK, which is the order the
 * hits arrive in and therefore needs no comparator. The alternative considered
 * was strongest-first, and it is the wrong order for the same reason the hits
 * themselves are in reading order: a list beside a book is read against the book,
 * and a row that jumps to the top because one passage in it scored well moves
 * under the reader between one tier and the next.
 */
export function legendOf(hits: readonly AnalysisHit[]): readonly AnalysisLegendEntry[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1);
  }
  return [...counts].map(([category, count]) => ({ category, count }));
}

/**
 * The findings whose category is not switched off — the legend's own filter.
 *
 * This is the clause docs/ANALYSIS.md §8 promised and Unit AN-2 deferred out loud
 * (*"a panel filter lights one category at a time when asked"*, deviation 5 in
 * the PLAN.md row). It is a SET OF THE HIDDEN rather than a set of the shown, and
 * that is the difference between a filter and a mode: everything is on until
 * somebody turns something off, a report that grows a category it has never seen
 * shows it, and there is no state that could mean "nothing selected, so nothing
 * is drawn" — the failure a shown-set makes possible on its first empty.
 *
 * ONLY THE PRIMARY CATEGORY IS TESTED, never `also`. A finding's primary is what
 * its card says, what its rail is coloured by and what the legend counted it
 * under; hiding "hate" and keeping a card whose rail is hate-coloured because it
 * ALSO matched something else would be the filter disagreeing with the paint.
 */
export function onlyCategories(
  hits: readonly AnalysisHit[],
  hidden: ReadonlySet<string>,
): readonly AnalysisHit[] {
  if (hidden.size === 0) return hits;
  const kept = hits.filter((one) => !hidden.has(one.category));
  return kept.length === 0 ? NO_HITS : kept;
}
