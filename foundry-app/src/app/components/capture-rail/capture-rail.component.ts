import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { CapturePrepared } from '@owen/foundry-core/shared/types';

import type { PrepareCounts, StampCost } from '../../core/capture.service';

/** The three verbs, which are also the three keys of `CapturePrepared`. */
export type PrepareVerb = keyof CapturePrepared;

/**
 * WHICH POPULATION A PRESSED COUNT ASKS FOR.
 *
 * The same three the Apply's consequence line names, because they are the same
 * three photographs: a number on this rail and the cards it lights have to be
 * one answer or the count is a claim nobody can check.
 */
export type Population = 'follow' | 'complete';

/** What a task row draws. Composed here so the template stays a list. */
interface Task {
  verb: PrepareVerb;
  glyph: string;
  words: string;
  /** The derivation, or null where there is nothing honest to derive. */
  state: string | null;
  ticked: boolean;
}

/**
 * PREPARE THIS BOOK — the light table's right-hand rail, and the answer to the
 * evening that produced it.
 *
 * ── Why a rail at all ───────────────────────────────────────────────────────
 *
 * Owen minted before he had turned the pages, and said so: *"i minted but didnt
 * have an opportunity to rotate the pages"*. Nothing had gone wrong with the
 * data — a mint is a snapshot of the recipe rather than its funeral — but the
 * surface had offered the LAST ACT FIRST. Mint sat in the footer of the table
 * from the moment the photographs landed, and the three things you are supposed
 * to do before it lived inside a modal you had to know to open.
 *
 * So the three verbs come out of the modal and stand in a list, with the act at
 * the bottom of them. The rail is the whole of the fix; the gate below is what
 * stops it being advice.
 *
 * ── AND SINCE WAVE 25 THE LIST IS AN ORDER, NOT A SET ──────────────────────
 *
 * *"maybe my goal should be to crop the pages so theyre positioned right, then
 * it moves to the page splitting after cropping is done. if cropping is done,
 * page splits will almost certainly be lined up already."*
 *
 * The rail draws the sequence — Crop, Split, Finish — because that IS the
 * insight: once the crops are applied every page is a squared, registered
 * rectangle, so one gutter placed once falls in nearly the same fractional
 * place on all of them. The well-aligned shoot needs no ceremony BY
 * CONSTRUCTION rather than by a mode switch, and each pass has one kind of
 * handle on its stage, which answers the scope question before it is asked.
 *
 * The row that used to say "any order" says "crop first", and that is the whole
 * change of instruction.
 *
 * ── THE TICK IS THE PERSON SPEAKING, AND THE STATUS IS NOT ─────────────────
 *
 * Each row carries a live status read from the recipe and a tick the person
 * sets, and they are different kinds of thing on purpose: THE DERIVATION NEVER
 * CLEARS A TICK. Nothing here decides that a step is finished.
 *
 * That is not deference for its own sake. A shoot with no spreads must be
 * tickable on "split spreads" without lying, and no rule can know the pages are
 * turned right — one photograph in the acceptance shoot is a magazine
 * advertisement, portrait, the same shape as the volume, and a derived
 * turned-done would be confidently wrong exactly where wrongness is most
 * expensive.
 *
 * TURN PAGES CARRIES NO STATUS AT ALL, which is a ruling and not an omission. A
 * count of turns performed IS derivable and was withdrawn: a count needs a
 * denominator and a denominator asserts a target. The correct final state of
 * this shoot is twenty-five spreads turned and at least two photographs left
 * alone, so "25 of 27 turned" would read as two still to do and quietly ask him
 * to break two pages that are already right. A progress count without a true
 * denominator is a lie with a number in it.
 *
 * ── THREE TICKS ON TWO STEPS, AND WHICH FOLDS WHERE ────────────────────────
 *
 * `CapturePrepared` still has exactly three keys and Finish still gates on all
 * three; what changed is where they are drawn. Turn and Crop fold under the
 * Crop step, on the contract's own ruling — *"turn belongs to the crop pass;
 * orienting the shot is part of deciding its rectangle"* — and Split stands
 * under the Split step alone.
 *
 * They are NOT derived from the passes and the passes do not tick them. An
 * Apply is the book moving; a tick is a person saying they have looked, and
 * Wave 21c's whole argument for the tick was that a derivation cannot know
 * that. So a person may apply the crops without ticking Crop, and Finish will
 * still be locked, and that is the gate doing its job rather than a defect.
 *
 * ── THE FINALIZE CARRIES THE CONSEQUENCE, AND IT IS NOW A REPORT ───────────
 *
 * Wave 24 put the sentence under *Crop all* in the modal, because that press
 * both recorded the book's crop and copied it onto twenty-four other pictures.
 * Wave 25 split those in two: the modal RECORDED and the table APPLIED, per the
 * rule that a control on the rail speaks for the book. Wave 51 removed the
 * record and made the propagation LIVE — a gesture made with *Global* ticked
 * reaches every follower as the hand opens — so the button below is a
 * commitment point plus a safety net, and the sentence above it describes a
 * state the book is already in rather than one a press is about to produce.
 *
 * The counts stay the service's `applyCost` — one walk, shared by the sentence
 * and the act, so they cannot disagree.
 *
 * ── AND THE COUNTS ARE PRESSABLE, WHICH CLOSES WAVE 24's DEFERRAL ──────────
 *
 * Wave 24 shipped the mark and said out loud what it had not shipped: *"the
 * rail's 'N by hand' count is not clickable … the mark is built and is the half
 * that matters, but finding them from the rail's number still means scanning."*
 * Pressing a count selects exactly those cards and scrolls to the first. It is
 * a number that can prove itself.
 */
@Component({
  selector: 'app-capture-rail',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-rail.component.html',
  styleUrl: './capture-rail.component.scss',
})
export class CaptureRailComponent {
  readonly counts = input.required<PrepareCounts>();
  readonly prepared = input.required<CapturePrepared>();
  /** Pages a mint would produce — struck ones already left out. */
  readonly mintable = input.required<number>();
  /** Every verb ticked. The service owns the rule; this only draws it. */
  /** True once this project has a minted book, which changes one word. */
  readonly minted = input(false);
  readonly progress = input<{ done: number; total: number } | null>(null);
  /** The shelf's book was made from an older arrangement than the one on screen. */
  readonly diverged = input(false);

  /**
   * WHICH PASS THE BOOK IS IN — the service's word, drawn and never decided.
   *
   * There is no 'crop' on disk; absent IS the crop pass, and `Reopen` returns
   * the recipe to it. The rail asks the service rather than remembering,
   * because the pass is a fact about the project and this component is redrawn
   * against whatever project the tab is pointing at.
   */
  readonly pass = input.required<'crop' | 'split'>();

  /** Whether the book has a crop yet — what decides if there is an act at all. */
  readonly standing = input(false);
  /** Whether the book has a cut yet — the same question for the split pass. */
  readonly bookCut = input(false);

  /**
   * THE BOOK'S LINES ARE SPLIT BY SIDE — odd pages one way, even pages another.
   *
   * It changes the WORDS and never the numbers. "22 take the book's crop and
   * cut" is a sentence about one crop and one cut; once the two sides have their
   * own, those twenty-two are taking two different rectangles and perhaps only
   * half of them a cut, so the sentence names the sides instead of promising a
   * single answer it no longer has. The counts beside it stay exact either way —
   * they are resolved per photograph in the service, against the standing that
   * photograph would actually be given.
   */
  readonly sided = input(false);

  /**
   * WHAT AN APPLY WOULD COST — the service's three populations, unaltered.
   *
   * Never recomputed here, and that is the rule the consequence line lives or
   * dies by: the sentence under the button and the walk the stamp makes are ONE
   * count, so a person who reads "22 take the book's crop" and then watches
   * twenty-two cards move has been told the truth by construction rather than
   * by two pieces of arithmetic that happen to agree today.
   */
  readonly cost = input.required<StampCost>();

  readonly open = output<PrepareVerb>();
  readonly tick = output<PrepareVerb>();
  readonly mint = output<void>();
  readonly stop = output<void>();
  /**
   * FINALIZE PAGE CROPS — close the pass, and land the standing on any straggler.
   *
   * The names on the wire are still `applyCrops`/`applyCuts` because the service
   * doors are, and the doors are where the rename would have to start; the
   * BUTTONS say Finalize, which is what a person is doing. Said here rather than
   * quietly left, so the next reader knows the two words are one act.
   */
  readonly applyCrops = output<void>();
  /** The same act, for the cut. */
  readonly applyCuts = output<void>();
  /** Back to the corners. Costs nothing, destroys nothing. */
  readonly reopen = output<void>();
  /** Light these cards on the table — a count proving itself. */
  readonly select = output<Population>();

  /** Turn and Crop, which are both about deciding the rectangle. */
  protected readonly cropTasks = computed<readonly Task[]>(() => {
    const counts = this.counts();
    const prepared = this.prepared();
    return [
      {
        verb: 'turned',
        glyph: '↻',
        words: 'Turn pages',
        // Nothing derived, and the class docblock carries the whole reason.
        state: null,
        ticked: prepared.turned === true,
      },
      {
        verb: 'cropped',
        glyph: '⌗',
        words: 'Place the crop',
        state: cropState(counts),
        ticked: prepared.cropped === true,
      },
    ];
  });

  /** Split, alone, under the pass it belongs to. */
  protected readonly splitTasks = computed<readonly Task[]>(() => {
    const counts = this.counts();
    return [{
      verb: 'split' as const,
      glyph: '∥',
      words: 'Split spreads',
      state: splitState(counts),
      ticked: this.prepared().split === true,
    }];
  });

  /** What the Crop step says about itself, which depends on where the book is. */
  protected readonly cropStep = computed<string>(() =>
    (this.pass() === 'split'
      ? 'Applied — the table shows the cropped pages'
      : 'Square every page against the book’s crop'));

  /**
   * And the Split step.
   *
   * In the crop pass it says WHY it is waiting rather than simply going dim,
   * because the reason is the whole argument for the order: a registered page
   * puts the gutter in the same fractional place on all of them, so one line
   * placed once fits the book.
   *
   * IN THE SPLIT PASS IT DOES NOT REPEAT THE COUNT. It did in the first build
   * and the walk caught it: the step's line and the *Split spreads* row
   * underneath it both read "25 spreads split into 50 pages", eight millimetres
   * apart. The derived count belongs to the task row, where the tick beside it
   * is the thing it is evidence for; the step line says what the pass is FOR.
   */
  protected readonly splitStep = computed<string>(() =>
    (this.pass() === 'crop'
      ? 'After the crops — one line then fits them all'
      : 'Put one line down the gutter and let the book take it'));

  /**
   * THE CONSEQUENCE LINE FOR *APPLY CROPS* — every population it touches.
   *
   * Three short sentences at most and each earns its place: who TAKES it, which
   * is the act's own number; who is SPARED for being complete, which is Owen's
   * standing ruling made visible and which, left unsaid, would read as a
   * failure to move; and who is spared for being a different SHAPE, which the
   * notice bar reports afterwards and which is worth knowing before.
   *
   * THE CUT IS NAMED WHENEVER THERE IS ONE, which is Wave 24's ruling holding:
   * a standing carries a crop AND a cut, so a button labelled Crop can cut
   * twenty-two photographs in two, and one button plus an honest sentence beat
   * a second button that appears and disappears.
   */
  protected readonly cropCost = computed<string>(() => {
    const { takes, complete } = this.cost();
    const cut = this.bookCut();
    const said: string[] = [];
    /*
     * WHEN THE SIDES DIFFER, THE SENTENCE NAMES THE SIDES (Wave 51b).
     *
     * "and cut, two pages each" is a promise about ONE cut, and a book whose odd
     * pages are spreads and whose even ones are single sheets would have it told
     * about the wrong half. The count is still exact — the service resolves each
     * photograph against the standing it will actually be given — so what has to
     * change is the claim about what they are all taking, not the number taking
     * it.
     */
    if (takes === 0) said.push('Nothing is free to take the book’s crop.');
    else if (this.sided()) {
      said.push(takes === 1
        ? 'One takes the lines its side of the book is set to.'
        : `${takes} take the lines their side of the book is set to.`);
    } else if (takes === 1) {
      said.push(cut
        ? 'One takes the book’s crop and cut, in two pages.'
        : 'One takes the book’s crop.');
    } else {
      said.push(cut
        ? `${takes} take the book’s crop and cut, two pages each.`
        : `${takes} take the book’s crop.`);
    }
    said.push(...spared(complete));
    return said.join(' ');
  });

  /** The same sentence for the cut, which lands on the crops already there. */
  protected readonly cutCost = computed<string>(() => {
    const { takes, complete } = this.cost();
    const said: string[] = [];
    // In the split pass the count is of photographs whose side of the book has a
    // CUT to give them, so nobody in it is going to be left whole — which is
    // what lets the sentence keep saying "two pages each" beside a book whose
    // sides differ.
    if (takes === 0) said.push('Nothing is free to take the book’s cut.');
    else if (takes === 1) {
      said.push(this.sided()
        ? 'One is cut where its side of the book is cut, into two pages.'
        : 'One is cut where the book is cut, into two pages.');
    } else {
      said.push(this.sided()
        ? `${takes} are cut where their side of the book is cut, two pages each.`
        : `${takes} are cut where the book is cut, two pages each.`);
    }
    said.push(...spared(complete));
    // Every crop stays put, and it has to be said: the word "apply" has just
    // meant "take the book's corners" one step above this one.
    said.push('Every crop stays where it is.');
    return said.join(' ');
  });

  protected readonly pages = computed<string>(() => {
    const pages = this.mintable();
    return pages === 1 ? '1 page' : `${pages} pages`;
  });

  /**
   * WHAT THE LAST ACT PROMISES, IN THE PERSON'S OWN WORDS.
   *
   * Owen described the act he was looking for as "a finalize button that does
   * all the final splits/crops" -- and it was already here, called Mint,
   * offering to "Make the PDF from these pages". Two things were wrong with
   * that and neither was the button.
   *
   * MINT IS THE SYSTEM'S WORD. It is a good word inside the code, where a mint
   * is a specific event with a fingerprint and a step, and it is the wrong word
   * on a control: nobody arrives at a light table looking for a mint. The
   * vocabulary of an interface is signposting, so it uses the vocabulary of the
   * person reading it.
   *
   * AND "MAKE THE PDF" NAMED THE CONTAINER RATHER THAN THE WORK. Under Owen's
   * pages-not-PDF ruling (docs/CAPTURE.md) the product of this act is the
   * PAGES; a PDF is something somebody exports afterwards, on purpose. A button
   * that promised a PDF was promising the one part of this that was about to
   * stop being true.
   */
  protected readonly mintTitle = computed<string>(() => {
    if (this.mintable() === 0) return 'There are no pages to make yet';
    return this.minted()
      ? 'Make this book again, as a new one beside the last'
      : 'Cut, crop and turn every page as you have marked them';
  });
}

/**
 * WHO IS LEFT ALONE, AND WHY — the spared population, in the Apply's own words.
 *
 * One body for both passes, because both skip on the same test (`applyCost`
 * asks completeness, and since 2026-09-21 nothing else: "a different shape"
 * was the second population, and it went when Owen ruled that a global reaches
 * every page). Two sentences written twice would be two chances to describe
 * one walk differently.
 */
function spared(complete: number): string[] {
  const said: string[] = [];
  if (complete > 0) {
    said.push(complete === 1
      ? 'One is complete and keeps its own.'
      : `${complete} complete keep their own.`);
  }
  return said;
}

/**
 * "25 cropped · 3 complete", and the counts behind it are about SHEETS.
 *
 * A split photograph has no half that is the whole frame and a turned one fails
 * an exact frame test, so both would read as cropped under the obvious version
 * of this question — see `CaptureService.prepare`, which is where that is
 * handled and where it has to stay.
 *
 * THE SECOND NUMBER IS `complete` AND NOT `byHand`, which is the same change the
 * card's dot made: the rail and the table have to count one population, or a
 * person who presses the count and reads the dots is looking at two answers to
 * one question.
 */
function cropState(counts: PrepareCounts): string {
  if (counts.photos === 0) return 'no photographs yet';
  if (counts.cropped === 0) return 'nothing cropped yet';
  const cropped = `${counts.cropped} of ${counts.photos} cropped`;
  return counts.complete === 0 ? cropped : `${cropped} · ${counts.complete} complete`;
}

/**
 * "12 split into 24 pages".
 *
 * The page count is worth saying beside the photograph count because they are
 * the two numbers a spread changes, and the second is the one the mint uses.
 */
function splitState(counts: PrepareCounts): string {
  if (counts.photos === 0) return 'no photographs yet';
  if (counts.split === 0) return 'nothing split yet';
  const photographs = counts.split === 1 ? '1 spread' : `${counts.split} spreads`;
  return `${photographs} split into ${counts.pagesFromSplits} pages`;
}
