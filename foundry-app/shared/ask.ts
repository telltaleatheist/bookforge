/**
 * ASK THE DOCUMENT — the wire shapes, and the two plans that turn a run's marks
 * into ops and back again.
 *
 * Owen, 2026-10-29: *"lets build in the logic for asking questions about the
 * document and giving it the ability to mark things. when its done
 * striking/changing/whatever, there should be a button on the sidebar we can
 * click thatll open a modal and show us what it did, and give us the option to
 * undo its strikes/changes."*
 *
 * A person types a request; a model works through the book with tools
 * (electron/ask-tools.ts) and MARKS blocks — a strike, or an exact revision of
 * the words — each with a short reason. Main never touches the book: the marks
 * come back as a list, the renderer lands them on the pane's own stack as ONE
 * undo, and the review card takes any of them back.
 *
 * ── WHY THE PLANS LIVE HERE AND ARE PURE ────────────────────────────────────
 *
 * Both are decisions about text with one right answer: "is this block still
 * what the run saw" and "which op says the opposite". The renderer is their only
 * caller, but a keeper drives every branch of them without a pane, which is the
 * whole of why they are not methods on a component.
 *
 * ── WHY A MARK CARRIES THE TEXT IT WAS MADE AGAINST ─────────────────────────
 *
 * Both plans refuse to act on a block that has moved since. A strike landed over
 * a paragraph somebody retyped while the model was still working would cancel
 * words nobody showed it; an undo that wrote a revision's `before` over a block
 * the person has edited since would put back text they had taken out. So every
 * mark records `before` (and a revision its `after`), and a block that no longer
 * matches is SKIPPED with a sentence, never forced.
 *
 * REASONS ARE NOT ON THE OPS. `parseOpsFile` drops fields it does not know, so a
 * reason on a strike would be gone the first time the stack was read back. The
 * session record (`AskSession`, kept in `<project>/ops/ask-sessions.jsonl`) is
 * where a reason lives.
 */
import type { BookOp } from './ops';

/** One block as the person sees it when they ask: live, after every pending op. */
export interface AskBlock {
  readonly id: string;
  /** The block's source text, inline markers and all — what a `text` op would carry. */
  readonly text: string;
  /** The engine's category, `Text`, `Section-header`, … */
  readonly category: string;
  /** Index into `AskView.chapters`; -1 before the first chapter. */
  readonly chapter: number;
}

/**
 * THE BOOK THE MODEL WORKS ON — the view in front of the person when they
 * pressed Ask. Struck and shelved rows are not in it: the model edits what the
 * person can see, and a strike of a block already struck would be a decision
 * about nothing.
 */
export interface AskView {
  readonly title: string;
  readonly blocks: readonly AskBlock[];
  readonly chapters: readonly { readonly id: string; readonly title: string }[];
  /** How many rows the person had already struck (hidden from the model, counted for it). */
  readonly struck: number;
}

/** What `ask:start` is handed. */
export interface AskRequest {
  /** The project, which is the book tab's path. */
  readonly projectDir: string;
  /** The person's words. */
  readonly request: string;
  /**
   * The server, by its registry name, or null for the top-ranked one — the same
   * server the model dropdown read its list from (`jobModelOffer`).
   */
  readonly server: string | null;
  /** The dropdown's value: `''` is Automatic, `<upstream>/<id>` a cloud model, else a local id. */
  readonly model: string;
  readonly view: AskView;
}

/** One block the run marked. A strike, or the words changed. */
export type AskMark =
  | {
    readonly id: string;
    readonly kind: 'strike';
    readonly reason: string;
    /** The block's text when the run saw it. */
    readonly before: string;
  }
  | {
    readonly id: string;
    readonly kind: 'text';
    readonly reason: string;
    readonly before: string;
    readonly after: string;
  };

/** What a finished run hands back. */
export interface AskResult {
  readonly server: string;
  /** The model id the run was answered by. */
  readonly model: string;
  /** The model's own last words — its summary for the person. Empty when it wrote none. */
  readonly summary: string;
  /** In reading order. */
  readonly items: readonly AskMark[];
  readonly rounds: number;
  readonly seconds: number;
}

/**
 * ONE FRAME ON `ask:progress`. A run is started by an invoke that answers with
 * its id at once, and everything after arrives here — a run is minutes of a
 * model's work, and an invoke held that long is one the renderer cannot even be
 * told about (the pull door's argument, electron/crucible-models.ts).
 */
export type AskProgress =
  | {
    readonly runId: string;
    readonly projectDir: string;
    readonly state: 'running';
    /** A sentence: waiting for the server, loading the model, round 4 of 40. */
    readonly status: string;
    readonly round: number;
    readonly maxRounds: number;
    /** The model's short prose this round, clipped; null when it only called tools. */
    readonly says: string | null;
    readonly struck: number;
    readonly revised: number;
  }
  | {
    readonly runId: string;
    readonly projectDir: string;
    readonly state: 'done';
    readonly result: AskResult;
  }
  | {
    readonly runId: string;
    readonly projectDir: string;
    readonly state: 'failed' | 'cancelled';
    /** Why, in a sentence a person can act on. For a cancel, what was let go. */
    readonly message: string;
  };

/**
 * ONE RUN, AS KEPT IN THE PROJECT — one JSON line of `ops/ask-sessions.jsonl`.
 *
 * WRITTEN AFTER THE LANDING, with only what landed: an item skipped because its
 * block moved during the run was never on the stack, and a review card offering
 * to undo it would be offering to undo nothing.
 */
export interface AskSession {
  /** The run's id. */
  readonly id: string;
  /** When it finished, ISO 8601. */
  readonly at: string;
  readonly request: string;
  readonly server: string;
  readonly model: string;
  readonly summary: string;
  /** What landed on the stack, in reading order. */
  readonly items: readonly AskMark[];
  /** How many marks were not landed because their block had changed during the run. */
  readonly skipped: number;
  readonly rounds: number;
  readonly seconds: number;
}

/** The current state of one block, as a plan reads it off the pane's replay. */
export interface AskRowState {
  readonly text: string;
  readonly struck: boolean;
}

/** A mark a plan would not act on, and why — the second half of a sentence. */
export interface AskSkip {
  readonly item: AskMark;
  readonly why: string;
}

/**
 * WHAT A PLAN COMES TO: the ops for the stack, the corrections a translated
 * pass records instead of `text` ops (book-stacks.service.ts, `translated`),
 * the marks it acted on, and the ones it skipped.
 */
export interface AskPlan {
  readonly ops: readonly BookOp[];
  readonly corrections: readonly { readonly id: string; readonly text: string }[];
  readonly acted: readonly AskMark[];
  readonly skipped: readonly AskSkip[];
}

/**
 * THE RUN'S MARKS, AS OPS — against the book as it stands NOW.
 *
 * A mark is landed only when its block is still exactly what the run saw: in
 * the book, not struck, and the same text. Anything else is something the
 * person did while the model was working, and theirs wins.
 */
export function planLanding(
  items: readonly AskMark[],
  rows: ReadonlyMap<string, AskRowState>,
  translated: boolean,
): AskPlan {
  const ops: BookOp[] = [];
  const corrections: { id: string; text: string }[] = [];
  const acted: AskMark[] = [];
  const skipped: AskSkip[] = [];
  for (const item of items) {
    const row = rows.get(item.id);
    if (row === undefined) {
      skipped.push({ item, why: 'it is no longer in the book' });
      continue;
    }
    if (row.struck) {
      skipped.push({ item, why: 'it was struck while the model worked' });
      continue;
    }
    if (row.text !== item.before) {
      skipped.push({ item, why: 'its text was changed while the model worked' });
      continue;
    }
    if (item.kind === 'strike') ops.push({ op: 'strike', id: item.id });
    else if (translated) corrections.push({ id: item.id, text: item.after });
    else ops.push({ op: 'text', id: item.id, text: item.after });
    acted.push(item);
  }
  return { ops, corrections, acted, skipped };
}

/**
 * THE OPPOSITE OF THE CHOSEN MARKS — `restore` for a strike, the `before` text
 * for a revision (a correction on a translated pass).
 *
 * A mark is taken back only when its block is still what the run left: a strike
 * still struck over the same words, a revision still reading its `after`. A
 * block somebody has changed since is SKIPPED: writing `before` over it would
 * undo their edit as well as the model's, and restoring a block they unstruck
 * and retyped would be a restore of nothing.
 */
export function planUndo(
  items: readonly AskMark[],
  rows: ReadonlyMap<string, AskRowState>,
  translated: boolean,
): AskPlan {
  const ops: BookOp[] = [];
  const corrections: { id: string; text: string }[] = [];
  const acted: AskMark[] = [];
  const skipped: AskSkip[] = [];
  for (const item of items) {
    const row = rows.get(item.id);
    if (row === undefined) {
      skipped.push({ item, why: 'it is no longer in the book' });
      continue;
    }
    if (item.kind === 'strike') {
      if (!row.struck) {
        skipped.push({ item, why: 'it is not struck any more' });
        continue;
      }
      if (row.text !== item.before) {
        skipped.push({ item, why: 'its text has changed since the run' });
        continue;
      }
      ops.push({ op: 'restore', id: item.id });
    } else {
      if (row.struck) {
        skipped.push({ item, why: 'it has been struck since the run' });
        continue;
      }
      if (row.text !== item.after) {
        skipped.push({ item, why: 'its text has changed since the run' });
        continue;
      }
      if (translated) corrections.push({ id: item.id, text: item.before });
      else ops.push({ op: 'text', id: item.id, text: item.before });
    }
    acted.push(item);
  }
  return { ops, corrections, acted, skipped };
}

/** One reason and its marks, for the review card's groups. */
export interface AskGroup {
  readonly reason: string;
  readonly items: readonly AskMark[];
}

/**
 * THE MARKS BY REASON, in the order each reason first appears in the book. The
 * reason is the model's own label and the person reviews under it — "study
 * question: 214" is one decision, not 214.
 */
export function groupByReason(items: readonly AskMark[]): readonly AskGroup[] {
  const groups = new Map<string, AskMark[]>();
  for (const item of items) {
    const held = groups.get(item.reason);
    if (held === undefined) groups.set(item.reason, [item]);
    else held.push(item);
  }
  return [...groups.entries()].map(([reason, marks]) => ({ reason, items: marks }));
}
