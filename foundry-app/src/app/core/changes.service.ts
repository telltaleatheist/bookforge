import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { positionOf } from '@shared/ledger';
import type { ReplayedRow } from '@shared/ops';
import { NO_DIFF, wordDiff, type ChangeRange, type WordDiff } from '@shared/word-diff';

import { LedgerService } from './ledger.service';
import { StageService } from './stage.service';

/**
 * WHAT CHANGED BETWEEN THE TWO COLUMNS — the diff both sheets draw from.
 *
 * ── The ask ────────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-08: *"I want to be able to compare what changed side-by-side in
 * ai cleanup. It should highlight the changes on each side, like in analysis, so
 * I can see what it was before and what it is now. Maybe on hover it shows the
 * original. Something like that. Same with simplify. It should show the changes.
 * Probably via a stored diff that runs while the job runs."*
 *
 * The compare column already IS the side-by-side (`CompareColumnComponent`): one
 * step of the book, read-only, beside the live one, and a text pass keeps its
 * block ids, so the two columns' rows line up by `row.id`. What was missing is
 * the light: this service says, for every block whose words differ between the
 * two sides, which characters of the OLDER side are gone and which characters of
 * the NEWER side are new — and each sheet reads its own half and draws it as
 * runs, exactly as it draws an analysis (docs/COMPARE-CHANGES.md).
 *
 * ── Why it is a service, on `AnalysisViewService`'s own argument ───────────
 *
 * Because the answer reaches TWO surfaces and they must never disagree. The
 * older sheet strikes what went and the newer sheet washes what came, and the
 * two are halves of ONE alignment per block: a removal drawn on the left with no
 * addition on the right is a diff that lied to somebody. So there is one pair
 * of row lists, one ordering decision and one diff per block, here, and both
 * sheets read computeds off them.
 *
 * ── Computed on demand, not stored — and Owen's guess, answered ────────────
 *
 * *"Probably via a stored diff that runs while the job runs"* was a guess at
 * mechanism, and it is the wrong one for three reasons that are each enough:
 *
 *   * ANY PAIR OF STEPS. A stored diff exists only for the pair a job happened to
 *     have in hand — a cleanup against its parent. A person comparing a cleanup
 *     against the edit step two rows earlier, or a simplification against a
 *     translation, or the position with its own pending stack against the
 *     recorded row, gets a highlight here for free, because the diff is of
 *     whatever two lists the columns are actually showing.
 *   * IT CANNOT GO STALE. The live side's rows include the unapplied stack; an
 *     edit made a moment ago is in the diff a moment later. A file written at
 *     landing would be a second account of the book that nothing keeps in step.
 *   * NO ENGINE RELEASE. The engine's text passes stay as they are; this is a
 *     pure function in `shared/` run by the renderer.
 *
 * And it is cheap: a block is a paragraph, the alignment is a tiny table, and
 * `changes` below diffs only the blocks whose strings differ — nearly none, on
 * a book of thousands. The same function could run at landing later and be kept
 * beside the step, if a stored diff is ever wanted for something the columns
 * are not; nothing here would have to change to read it.
 *
 * ── The parties write their rows in; nothing here loads anything ───────────
 *
 * Each book view that is a PARTY to the comparison publishes its own replayed
 * rows here — the live pane into `live`, the compare column's pane into
 * `compared` — from an effect on its own `view()`, and takes them back out when
 * it stops being one. The rows are the sheets' OWN (the recorded chain and the
 * pending stack already replayed), which is what makes the highlight agree with
 * the paper in front of the person, including the strike they made a moment ago.
 * `AnalysisViewService` reaches the live rows through the stack registry; the
 * compare column registers no stack (deliberately — see its docblock), so the
 * publication runs the other way, from the pane to here.
 */
@Injectable({ providedIn: 'root' })
export class ChangesService {
  private readonly stage = inject(StageService);
  private readonly ledger = inject(LedgerService);

  /** The live column's replayed rows, while a comparison is open — the live pane writes this. */
  readonly live = signal<readonly ReplayedRow[] | null>(null);

  /** The compare column's replayed rows — its pane writes this. */
  readonly compared = signal<readonly ReplayedRow[] | null>(null);

  /**
   * THE HEAD'S TOGGLE — the light, on or off, without leaving the comparison.
   *
   * Session state and not persisted, on the analysis tier's ruling: a comparison
   * is set up for the question being asked right now, and the light is part of
   * how it is being read rather than a fact about the book. It opens ON because
   * the changes are the whole reason Owen asked for the column.
   */
  readonly enabled = signal(true);

  /**
   * WHICH SIDE IS BEFORE — decided from the ledger, never from which column is
   * which.
   *
   * The compare column is not always the older step: a person standing on an
   * edit row can compare it with the cleanup made FROM it, and then the live side
   * is the before. The ledger's `steps` array is chronological by invariant
   * (`chronological`, shared/ledger.ts: *"THE ARRAY'S ORDER IS TAKEN AS THE
   * CHRONOLOGY"*), so the compared step's index against the position's index is
   * the whole test. Equal indices — comparing the position with its own recorded
   * row — put the live side AFTER, because the only thing that can differ then is
   * the unapplied stack, and the stack is newer than the disk.
   *
   * NULL while there is no comparison, no ledger yet, or no position: nothing is
   * diffed against nothing, and the sheets draw no light.
   */
  readonly order = computed<'liveIsAfter' | 'comparedIsAfter' | null>(() => {
    const where = this.stage.compare();
    if (where === null) return null;
    const history = this.ledger.historyFor(where.projectDir);
    if (history === null) return null;
    const steps = history.ledger.steps;
    const standing = positionOf(history.ledger);
    if (standing === null) return null;
    const comparedAt = steps.findIndex((step) => step.id === where.stepId);
    const positionAt = steps.findIndex((step) => step.id === standing.id);
    if (comparedAt < 0 || positionAt < 0) return null;
    return comparedAt <= positionAt ? 'liveIsAfter' : 'comparedIsAfter';
  });

  /**
   * THE DIFF PER BLOCK, keyed by id — only the blocks that differ.
   *
   * ── What is compared and what is skipped ───────────────────────────────────
   *
   * A block is diffed only where BOTH sides hold it, both sides FLOW it (a
   * shelved row is a block the book does not contain — docs/RENDERER.md §5 — and
   * neither sheet draws one), and neither side has STRUCK it. The strike rule is
   * `litRanges`'s (core/analysis.ts): a struck block is drawn cancelled, and a
   * light painted over the cancel would be two marks arguing about one
   * paragraph. Blocks only one side holds — a split's new half, a join's absent
   * one — are structural changes the columns already show by their absence, and
   * are not a diff of words.
   *
   * STRING INEQUALITY FIRST. Nearly every block of a compared pair is identical
   * and costs one comparison; only the rest are aligned.
   *
   * ── Memoised per block on the pair of strings ──────────────────────────────
   *
   * The live side's rows are re-replayed on every gesture (a strike, an undo),
   * and the list that arrives is a new array every time. Without a memo, one
   * keystroke on the live sheet would re-align every changed paragraph in the
   * book. The memo is keyed by id and checked against BOTH strings, so an edit
   * to one block re-diffs that block and nothing else — and it is rebuilt from
   * this pass's ids only, so a block that has left the book leaves the memo with
   * it. It is emptied outright when the comparison ends (the effect below).
   */
  /**
   * The memo behind `changes` — see its docblock. A CACHE and not state: the
   * computed rebuilds it on every pass from that pass's own ids, so it can never
   * answer for a block the columns do not both hold, and the effect below empties
   * it when the comparison ends.
   */
  private memo = new Map<string, Memo>();

  readonly changes = computed<ReadonlyMap<string, WordDiff>>(() => {
    if (!this.enabled()) return NO_CHANGES;
    const order = this.order();
    const live = this.live();
    const compared = this.compared();
    if (order === null || live === null || compared === null) return NO_CHANGES;
    const before = order === 'liveIsAfter' ? compared : live;
    const after = order === 'liveIsAfter' ? live : compared;

    const older = new Map<string, ReplayedRow>();
    for (const row of before) {
      if (row.shelf === undefined && row.struck !== true) older.set(row.id, row);
    }
    const out = new Map<string, WordDiff>();
    const kept = new Map<string, Memo>();
    for (const row of after) {
      if (row.shelf !== undefined || row.struck === true) continue;
      const was = older.get(row.id);
      if (was === undefined || was.text === row.text) continue;
      const held = this.memo.get(row.id);
      const diff = held !== undefined && held.before === was.text && held.after === row.text
        ? held.diff
        : wordDiff(was.text, row.text);
      kept.set(row.id, { before: was.text, after: row.text, diff });
      if (diff !== NO_DIFF) out.set(row.id, diff);
    }
    this.memo = kept;
    return out.size === 0 ? NO_CHANGES : out;
  });

  /**
   * THE LIVE SHEET'S HALF — removals when it is the older side, additions when
   * it is the newer. Empty whenever there is nothing to draw.
   *
   * The ranges are sorted and non-overlapping by construction (`wordDiff` emits
   * them in the block's order and merges neighbours), which is the contract
   * `cut()` walks them under: one cursor, one comparison per character.
   */
  readonly liveRanges = computed<ReadonlyMap<string, readonly ChangeRange[]>>(
    () => this.half(this.order() === 'liveIsAfter' ? 'added' : 'removed'),
  );

  /** The compare column's half, on the same terms. */
  readonly comparedRanges = computed<ReadonlyMap<string, readonly ChangeRange[]>>(
    () => this.half(this.order() === 'comparedIsAfter' ? 'added' : 'removed'),
  );

  private half(kind: ChangeRange['kind']): ReadonlyMap<string, readonly ChangeRange[]> {
    const changes = this.changes();
    if (changes.size === 0) return NO_RANGES;
    const out = new Map<string, readonly ChangeRange[]>();
    for (const [id, diff] of changes) {
      const ranges = kind === 'added' ? diff.added : diff.removed;
      if (ranges.length > 0) out.set(id, ranges);
    }
    return out;
  }

  /**
   * True once both sheets have said what they hold — the head's chip draws
   * nothing before this, because "no changes" over a column still loading would
   * be a claim about a book nobody has read yet.
   */
  readonly ready = computed<boolean>(
    () => this.order() !== null && this.live() !== null && this.compared() !== null,
  );

  /**
   * THE CHANGED BLOCKS, IN THE BOOK'S ORDER — the newer side's order, which is
   * the order the ↑↓ walk. `changes` is a Map insertion-ordered by that same
   * walk over `after`, so this is its keys and nothing has to be sorted.
   */
  readonly changedIds = computed<readonly string[]>(() => [...this.changes().keys()]);

  /** How many blocks differ — the head's chip. */
  readonly changedBlocks = computed<number>(() => this.changes().size);

  /**
   * THE BLOCK BOTH SHEETS SHOULD BRING INTO VIEW — an event, stamped.
   *
   * `AnalysisViewService.pointedAt`'s shape and for its reason: pressing ↓ onto
   * the same block twice must still scroll both columns back to it, which a
   * signal holding a bare id cannot say, because writing the same value is no
   * change at all. Each party watches this in an effect and calls its own
   * `scrollTo` — the compare column's pane registers no stack, so there is no
   * `BookStack.reveal` to reach it by, and a door both panes already own is
   * simpler than building one for the pane that has none.
   */
  readonly reveal = signal<{ id: string; tick: number } | null>(null);

  /** The counter behind `reveal`. Never read; it exists to be different. */
  private ticks = 0;

  /**
   * THE BLOCK THE ↑↓ ARE STANDING ON, or null before the first press.
   *
   * By id and not by index, so a live edit that changes which blocks differ
   * moves the walk with the block rather than onto a stranger at the same
   * ordinal. A block that has stopped differing is simply no longer found, and
   * the next press starts from the top — which is the honest answer, since the
   * thing being stood on has gone.
   */
  readonly at = signal<string | null>(null);

  /**
   * Walk to the next (or previous) changed block and ask both sheets to show it.
   * Wraps, so ↓ at the last change is the first — a list of forty changes is
   * read in a loop, not to a wall.
   */
  step(direction: 1 | -1): void {
    const ids = this.changedIds();
    if (ids.length === 0) return;
    const held = this.at();
    const from = held === null ? -1 : ids.indexOf(held);
    const next = from < 0
      ? (direction === 1 ? 0 : ids.length - 1)
      : (from + direction + ids.length) % ids.length;
    const id = ids[next]!;
    this.at.set(id);
    this.ticks += 1;
    this.reveal.set({ id, tick: this.ticks });
  }

  constructor() {
    /*
     * EVERYTHING GOES WHEN THE COMPARISON DOES. The parties clear their own
     * side when they stop being parties (each pane's effect), and this is the
     * backstop that cannot depend on a pane's lifecycle: `compare` is a computed
     * with the three clearing rules in it — the document closed, the project
     * changed, the step deleted — and any of them ending the comparison ends the
     * diff, the memo, the walk and the toggle's memory in one place.
     *
     * THE TOGGLE RESETS TO ON, deliberately: switching the light off is a way
     * of reading THIS comparison, and the next one opens the way every one does.
     */
    effect(() => {
      if (this.stage.compare() !== null) return;
      untracked(() => {
        this.live.set(null);
        this.compared.set(null);
        this.memo = new Map();
        this.reveal.set(null);
        this.at.set(null);
        this.enabled.set(true);
      });
    });
  }
}

interface Memo {
  before: string;
  after: string;
  diff: WordDiff;
}

/** No comparison open, or nothing differs — the answer for nearly every repaint. */
const NO_CHANGES: ReadonlyMap<string, WordDiff> = new Map();
const NO_RANGES: ReadonlyMap<string, readonly ChangeRange[]> = new Map();
