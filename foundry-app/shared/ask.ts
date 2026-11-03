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
import type { AskConversation } from './ask-conversations';
import type { AskStackInput } from './ask-history';
import type { AskChainStep } from './ask-presets';
import type { BookOp, Replayed } from './ops';

/** One block as the person sees it when they ask: live, after every pending op. */
export interface AskBlock {
  readonly id: string;
  /** The block's source text, inline markers and all — what a `text` op would carry. */
  readonly text: string;
  /** The engine's category, `Text`, `Section-header`, … */
  readonly category: string;
  /** Index into `AskView.chapters`; -1 before the first chapter. */
  readonly chapter: number;
  /**
   * A note's links: where its number is printed, by block and character —
   * `BookRow.refs` as the replay left them. Absent on a block that is no note
   * or whose number nothing in the body carries.
   */
  readonly refs?: readonly AskRef[];
}

/** One reference number in a block's text: which block, and which characters. */
export interface AskRef {
  readonly block: string;
  readonly at: number;
  readonly len: number;
}

/** A number in the body no note carries — `BookLooseMarker`. */
export interface AskLooseNumber extends AskRef {
  /** The number the page printed. */
  readonly printed: number;
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
  /**
   * THE ROWS THE PERSON STRUCK, in reading order — hidden from the ordinary
   * read, and readable on purpose (`read only:"struck"`) so a block removed by
   * mistake can be proposed back (Owen, 2026-11-02).
   */
  readonly struckBlocks: readonly AskBlock[];
  /**
   * THE APPARATUS THAT DID NOT JOIN UP (`BookLoose`, as the replay left it):
   * numbers in the body no note carries, and notes nothing points at — what a
   * `link_footnote` call has to see to be any use.
   */
  readonly loose: {
    readonly numbers: readonly AskLooseNumber[];
    readonly notes: readonly string[];
  };
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
  /**
   * WHICH CONVERSATION THIS QUESTION CONTINUES, by id — or null to start a new
   * one (the panel's "+"). Main opens the run with that conversation's note, or
   * with its last question and answer when it has none.
   */
  readonly conversation: string | null;
  /**
   * THE BOOK'S EDITS, for the `history` and `revert` tools — the pane's file,
   * every op it replays, and its redo pile (`BookStack.askStack`). Absent when
   * the pane could not give it; the two tools then say so by name.
   */
  readonly stack?: AskStackInput;
}

/**
 * What a retyping does to the division above its block: a chapter starts there,
 * under this title, or the one that starts there is taken away.
 */
export type AskChapterChange =
  | { readonly start: true; readonly title: string }
  | { readonly start: false };

/**
 * One block the run marked. A strike, the words changed, or the KIND of block it
 * is changed (Owen, 2026-11-01: *"if something is marked as a footnote but its
 * really a chapter title, it has the tools it needs to correct that?"*).
 *
 * A RETYPING IS ITS OWN MARK, BESIDE A REVISION. A footnote that is really a
 * heading may also want its stray reference number taken out, and those are two
 * decisions the person can keep one of; so one block can carry a `text` mark and
 * a `category` mark at once, and `askMarkKey` is what tells the two apart.
 */
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
  }
  | {
    readonly id: string;
    readonly kind: 'category';
    readonly reason: string;
    /** The block's text when the run saw it. */
    readonly before: string;
    /** The category it had, and the one it is given — the engine's spelling. Equal when only the chapter changes. */
    readonly from: string;
    readonly to: string;
    /** The division above it, changed — or null to leave it as it was. */
    readonly chapter: AskChapterChange | null;
    /** The title of the chapter that started at the block when the run saw it, or null for none. */
    readonly chapterBefore: string | null;
  }
  | {
    /** The block that goes INTO `into` — the later one, whose id is consumed (`MergeOp`). */
    readonly id: string;
    readonly kind: 'join';
    readonly reason: string;
    /** This block's text when the run saw it. */
    readonly before: string;
    /** Its kind, so taking the join back can give the second half its kind again. */
    readonly category: string;
    /** The earlier block it continues, and that block's text when the run saw it. */
    readonly into: string;
    readonly intoBefore: string;
  }
  | {
    readonly id: string;
    readonly kind: 'split';
    readonly reason: string;
    readonly before: string;
    /** Its kind when the run saw it. */
    readonly from: string;
    /** Where the cut falls in `before` — the first character of the second half. */
    readonly at: number;
    /** The two halves' words, each trimmed at the cut. */
    readonly first: string;
    readonly second: string;
    /** The kind each half is given, or null to keep `from`. */
    readonly firstCategory: string | null;
    readonly secondCategory: string | null;
    /** The chapter that started at the block when the run saw it, which stays with the first half. */
    readonly chapterBefore: string | null;
  }
  | {
    /** A block the PERSON struck, proposed back. */
    readonly id: string;
    readonly kind: 'restore';
    readonly reason: string;
    readonly before: string;
  }
  | {
    /** The note. */
    readonly id: string;
    readonly kind: 'link';
    readonly reason: string;
    /** The note's text when the run saw it. */
    readonly before: string;
    /** Where its number is printed: the block, the characters, and that block's text then. */
    readonly block: string;
    readonly at: number;
    readonly len: number;
    readonly blockBefore: string;
  }
  | {
    /** The note one of whose numbers comes off it (`UnlinkOp`) — `link`'s other half. */
    readonly id: string;
    readonly kind: 'unlink';
    readonly reason: string;
    readonly before: string;
    readonly block: string;
    readonly at: number;
    readonly len: number;
    readonly blockBefore: string;
  }
  | {
    /**
     * AN EARLIER EDIT, TAKEN BACK (shared/ask-history.ts) — by anyone, Ask or
     * the person. `original` is that edit as the mark it would have been; this
     * lands as `planUndo` of it, and is undone as `planLanding` of it, so a
     * revert has no inverse of its own to get wrong.
     */
    readonly id: string;
    readonly kind: 'revert';
    readonly reason: string;
    readonly before: string;
    /** The history entry's handle, for the run that proposed it. */
    readonly handle: string;
    /** The original edit in plain words: "struck e-579". */
    readonly said: string;
    readonly original: AskMark;
  };

/**
 * A PLACE THE MODEL POINTS AT, which changes nothing (Owen, 2026-11-02): the
 * answer to "where is …", or the evidence behind a summary. Kept with the run
 * and drawn under it as a list the person can click to go there.
 */
export interface AskHighlight {
  readonly id: string;
  /** Exact words inside the block, or null for the whole block. */
  readonly quote: string | null;
  readonly note: string;
}

/** A mark's identity within a run: a block's retyping and its revision are two marks of one id. */
export function askMarkKey(item: AskMark): string {
  switch (item.kind) {
    case 'strike':
    case 'text': return `mark:${item.id}`;
    case 'category': return `type:${item.id}`;
    case 'link': return `link:${item.id}:${item.block}:${item.at}`;
    case 'unlink': return `unlink:${item.id}:${item.block}:${item.at}`;
    case 'revert': return `revert:${item.handle}`;
    default: return `${item.kind}:${item.id}`;
  }
}

/** "Footnote → Section-header, starts a chapter" — what a retyping does, in a line. */
export function retypeSaid(item: Extract<AskMark, { kind: 'category' }>): string {
  const parts: string[] = [];
  if (item.from !== item.to) parts.push(`${item.from} → ${item.to}`);
  if (item.chapter !== null) {
    if (!item.chapter.start) parts.push('no chapter starts here');
    else if (item.chapterBefore !== null) parts.push(`chapter "${item.chapterBefore}" renamed "${item.chapter.title}"`);
    else parts.push(`starts a chapter, "${item.chapter.title}"`);
  }
  return parts.join(', ');
}

/** "joined to e-412", "split before "It was…"" — what a structural mark does, in a line, for the review card. */
export function structureSaid(item: Extract<AskMark, { kind: 'join' | 'split' | 'restore' | 'link' | 'unlink' | 'revert' }>): string {
  switch (item.kind) {
    case 'join': return `joined to ${item.into}`;
    case 'split': {
      const kinds = item.firstCategory !== null || item.secondCategory !== null
        ? ` (${item.firstCategory ?? item.from} | ${item.secondCategory ?? item.from})` : '';
      return `split before "${item.second.length > 40 ? `${item.second.slice(0, 40)}…` : item.second}"${kinds}`;
    }
    case 'restore': return 'restore';
    case 'link': return `linked to its number in ${item.block}`;
    case 'unlink': return `unlinked from its number in ${item.block}`;
    case 'revert': return `undo: ${item.said}`;
  }
}

/** What a finished run hands back. */
export interface AskResult {
  readonly server: string;
  /** The model id the run was answered by. */
  readonly model: string;
  /** The model's own last words — its summary for the person. Empty when it wrote none. */
  readonly summary: string;
  /** In reading order. */
  readonly items: readonly AskMark[];
  /** The places it pointed at, in the order it pointed. */
  readonly highlights: readonly AskHighlight[];
  readonly rounds: number;
  /** True when the run ended at the round limit rather than by finishing — what offers "Keep going". */
  readonly hitLimit: boolean;
  readonly seconds: number;
  /**
   * The conversation this run belongs to, as written to the book after it — a
   * new one when the question started one. Its `note` is null when the model's
   * note could not be had, and `noteProblem` says why; the next question then
   * continues from this run's question and answer.
   */
  readonly conversation: AskConversation;
  readonly noteProblem: string | null;
}

/**
 * THE THREAD — what a follow-up question starts from. One per book, kept in
 * `<project>/ops/ask-thread.json`, until "New question" ends it.
 *
 * Owen, 2026-11-01: *"maybe when it finishes its first run, it 'compacts' by
 * summarizing what it found, and then i can ask more questions about the same
 * subject if i want?"* So when a run finishes, the model writes one more short
 * message, for ITSELF rather than for the person: what was asked, what it found
 * (by block id), what it marked, what it searched and ruled out, what is still
 * open. The next question starts from that note and the book as it stands —
 * never from the rounds, which would not fit and are not needed. Each follow-up
 * rewrites the note, so a long thread does not grow.
 *
 * THE NOTE IS LEADS, NOT FACTS. The person may have undone marks since, or
 * edited the book, and a wrong line in a note would otherwise repeat in every
 * answer after it; the follow-up is told to check what it relies on.
 */
export interface AskThread {
  readonly format: 'ask-thread/v1';
  /** The question that started the thread, which is what the panel names it by. */
  readonly first: string;
  /** How many questions it holds, the first one included. */
  readonly turns: number;
  /** When the note was last written, ISO 8601. */
  readonly at: string;
  /** The model's working note, in its own words. */
  readonly note: string;
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
    readonly retyped: number;
    /** The whole tally as a line — "3 marked, 2 joined" (ask-tools.ts `tallySaid`). */
    readonly tally: string;
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
  /** The places it pointed at. Absent on a run kept before highlights existed. */
  readonly highlights?: readonly AskHighlight[];
  /** True when the run stopped at the round limit. Absent on a run kept before it was recorded. */
  readonly hitLimit?: boolean;
  /** Which step of a run of presets this run was. Absent on an ordinary question. */
  readonly chain?: AskChainStep;
  /** The conversation it belongs to. Absent on a run kept before conversations (`AskConversation.legacyRuns`). */
  readonly conversation?: string;
  /** How many marks were not landed because their block had changed during the run. */
  readonly skipped: number;
  readonly rounds: number;
  readonly seconds: number;
}

/**
 * THE BOOK AS THE PERSON SEES IT — the pane's replay, live rows to work on and
 * struck rows kept apart (readable on purpose), shelved rows left out entirely
 * (they are not in the flow, so not on the paper, and an edit of one would be
 * about text nobody can see).
 *
 * THE PANE'S REPLAY INCLUDES ITS PENDING STACK, which is what lets a run of presets'
 * later step see the earlier steps' marks: each step's landing is pushed onto
 * that stack before the next step reads this.
 */
export function askViewOf(book: Replayed, title: string): AskView {
  const starts = new Map(book.chapters.map((c, i) => [c.id, i]));
  const blocks: AskBlock[] = [];
  const struckBlocks: AskBlock[] = [];
  let chapter = -1;
  for (const row of book.rows) {
    if (row.shelf !== undefined) continue;
    const at = starts.get(row.id);
    if (at !== undefined) chapter = at;
    const block: AskBlock = {
      id: row.id, text: row.text, category: row.category, chapter,
      ...(row.refs === undefined || row.refs.length === 0 ? {} : { refs: row.refs.map((r) => ({ block: r.block, at: r.at, len: r.len })) }),
    };
    if (row.struck === true) struckBlocks.push(block);
    else blocks.push(block);
  }
  return {
    title,
    blocks,
    chapters: book.chapters.map((c) => ({ id: c.id, title: c.title })),
    struck: struckBlocks.length,
    struckBlocks,
    loose: {
      numbers: book.loose.markers.map((m) => ({ block: m.block, at: m.at, len: m.len, printed: m.printed })),
      notes: [...book.loose.notes],
    },
  };
}

/**
 * WHAT THE REVIEW CARD SHOWS for a book's latest run — that run, or, when it
 * was a step of a run of presets, every step of that chain together, each step's
 * reasons labelled with the step's name ("Front & back matter — copyright
 * page"), so the four runs are reviewed as the one press they were.
 *
 * `keyOf` is a row's identity across the steps: two steps may each have a mark
 * on one block (a retyping in Chapters, a strike in Front & back matter), and
 * `askMarkKey` alone would make them one row.
 */
export interface AskReview {
  readonly request: string;
  readonly model: string;
  readonly items: readonly AskMark[];
  readonly skipped: number;
  readonly groups: readonly AskGroup[];
  keyOf(item: AskMark): string;
}

export function reviewOf(sessions: readonly AskSession[], latest: AskSession): AskReview {
  const steps = latest.chain === undefined
    ? [latest]
    : sessions.filter((one) => one.chain?.chain === latest.chain!.chain)
      .sort((a, b) => a.chain!.index - b.chain!.index);
  const keys = new Map<AskMark, string>();
  steps.forEach((one, n) => { for (const item of one.items) keys.set(item, `${n}:${askMarkKey(item)}`); });
  return {
    request: latest.chain === undefined ? latest.request : `Presets: ${steps.map((one) => one.chain!.step).join(', ')}`,
    model: latest.model,
    items: steps.flatMap((one) => one.items),
    skipped: steps.reduce((sum, one) => sum + one.skipped, 0),
    groups: steps.flatMap((one) => groupByReason(one.items).map((g) => (one.chain === undefined
      ? g
      : { reason: `${one.chain.step} — ${g.reason}`, items: g.items }))),
    keyOf: (item) => keys.get(item) ?? askMarkKey(item),
  };
}

/** The current state of one block, as a plan reads it off the pane's replay. */
export interface AskRowState {
  readonly text: string;
  readonly struck: boolean;
  readonly category: string;
  /** The title of the chapter that starts at this block, or null for none. */
  readonly chapter: string | null;
}

/** Each row's state, off the pane's replay: its text, strike, category and the chapter starting at it. */
export function askRowStates(
  rows: readonly { readonly id: string; readonly text: string; readonly struck?: boolean; readonly category: string }[],
  chapters: readonly { readonly id: string; readonly title: string }[],
): ReadonlyMap<string, AskRowState> {
  const starts = new Map(chapters.map((c) => [c.id, c.title]));
  return new Map(rows.map((row) => [row.id, {
    text: row.text,
    struck: row.struck === true,
    category: row.category,
    chapter: starts.get(row.id) ?? null,
  }]));
}

/** The chapter a retyping leaves at its block: its own change, or what was there. */
function chapterAfter(item: Extract<AskMark, { kind: 'category' }>): string | null {
  if (item.chapter === null) return item.chapterBefore;
  return item.chapter.start ? item.chapter.title : null;
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
  /**
   * WHERE EACH JOINED BLOCK WENT, for a chain (A ← B ← C). The model joins C to
   * B, and B is consumed by the time C's merge replays, so C goes into whatever
   * B went into — the survivor of the chain.
   */
  const wentInto = new Map<string, string>();
  const survivor = (id: string): string => {
    let at = id;
    while (wentInto.has(at)) at = wentInto.get(at)!;
    return at;
  };
  for (const item of items) {
    if (item.kind === 'revert') {
      const back = planUndo([item.original], rows, translated);
      if (back.skipped.length > 0) {
        skipped.push({ item, why: back.skipped[0]!.why });
        continue;
      }
      ops.push(...back.ops);
      corrections.push(...back.corrections);
      acted.push(item);
      continue;
    }
    const row = rows.get(item.id);
    if (row === undefined) {
      skipped.push({ item, why: 'it is no longer in the book' });
      continue;
    }
    if (item.kind === 'restore') {
      if (!row.struck) {
        skipped.push({ item, why: 'it was restored while the model worked' });
        continue;
      }
      if (row.text !== item.before) {
        skipped.push({ item, why: 'its text was changed while the model worked' });
        continue;
      }
      ops.push({ op: 'restore', id: item.id });
      acted.push(item);
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
    if (item.kind === 'category') {
      if (row.category !== item.from) {
        skipped.push({ item, why: 'its kind was changed while the model worked' });
        continue;
      }
      if (row.chapter !== item.chapterBefore) {
        skipped.push({ item, why: 'the chapter at it was changed while the model worked' });
        continue;
      }
      ops.push(...retypeOps(item.id, item.from, item.to, item.chapterBefore, chapterAfter(item)));
      acted.push(item);
      continue;
    }
    if (item.kind === 'join') {
      const into = rows.get(item.into);
      if (into === undefined || into.struck || into.text !== item.intoBefore) {
        skipped.push({ item, why: `the block it continues (${item.into}) was changed while the model worked` });
        continue;
      }
      if (row.chapter !== null) {
        skipped.push({ item, why: 'a chapter was started at it while the model worked' });
        continue;
      }
      const target = survivor(item.into);
      ops.push({ op: 'merge', id: item.id, into: target });
      wentInto.set(item.id, target);
      acted.push(item);
      continue;
    }
    if (item.kind === 'split') {
      if (row.category !== item.from) {
        skipped.push({ item, why: 'its kind was changed while the model worked' });
        continue;
      }
      ops.push(...splitOps(item, row.chapter));
      acted.push(item);
      continue;
    }
    if (item.kind === 'link' || item.kind === 'unlink') {
      const block = rows.get(item.block);
      if (block === undefined || block.text !== item.blockBefore) {
        skipped.push({ item, why: `the block its number is printed in (${item.block}) was changed while the model worked` });
        continue;
      }
      ops.push({ op: item.kind, note: item.id, block: item.block, at: item.at, len: item.len });
      acted.push(item);
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
 * A SPLIT, AS OPS: the cut, each half's words trimmed at it (the replay cuts at a
 * character and keeps whatever space was there), each half's new kind, and the
 * block's chapter carried to the first half — a division keyed to the parent's
 * id is not drawn once the parent is gone (`drawableChapters`).
 */
function splitOps(item: Extract<AskMark, { kind: 'split' }>, chapter: string | null): BookOp[] {
  const one = `${item.id}/1`;
  const two = `${item.id}/2`;
  const ops: BookOp[] = [{ op: 'split', id: item.id, at: item.at }];
  if (item.before.slice(0, item.at) !== item.first) ops.push({ op: 'text', id: one, text: item.first });
  if (item.before.slice(item.at) !== item.second) ops.push({ op: 'text', id: two, text: item.second });
  if (item.firstCategory !== null && item.firstCategory !== item.from) ops.push({ op: 'category', id: one, category: item.firstCategory });
  if (item.secondCategory !== null && item.secondCategory !== item.from) ops.push({ op: 'category', id: two, category: item.secondCategory });
  if (chapter !== null) ops.push({ op: 'chapter', set: one, title: chapter });
  return ops;
}

/**
 * THE OPPOSITE OF THE CHOSEN MARKS — `restore` for a strike, the `before` text
 * for a revision (a correction on a translated pass), the old kind and the old
 * division for a retyping (always ops: a category is shape, not words), a strike
 * for a restore, and for the two structural marks the other structural op:
 * a join is cut again where it was joined, a split joined again.
 *
 * A mark is taken back only when its block is still what the run left: a strike
 * still struck over the same words, a revision still reading its `after`. A
 * block somebody has changed since is SKIPPED: writing `before` over it would
 * undo their edit as well as the model's, and restoring a block they unstruck
 * and retyped would be a restore of nothing.
 *
 * ── A JOIN OR A SPLIT TAKEN BACK COMES BACK UNDER NEW NAMES ─────────────────
 *
 * The grammar has no un-merge: the replay mints `<id>/1` and `<id>/2` for every
 * cut, so a join undone is two blocks named after the one that survived it, and
 * a split undone is one block named after its first half. The words, the kinds
 * and the chapter come back exactly; the ids do not, and the review card says
 * so. Undone joins are worked LAST FIRST, over a simulation of the names each
 * cut leaves, so a chain (A ← B ← C) taken back whole cuts C off, then B.
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
  const now = new Map(rows);
  const joins = items.filter((item): item is Extract<AskMark, { kind: 'join' }> => item.kind === 'join');
  /** Where each join in the chosen set went, to follow a chain to its survivor. */
  const joinedInto = new Map(joins.map((item) => [item.id, item.into]));
  for (const item of [...items.filter((one) => one.kind !== 'join'), ...joins.reverse()]) {
    if (item.kind === 'revert') {
      // Taking a revert back is making the original edit again, on its own checks.
      const again = planLanding([item.original], now, translated);
      if (again.skipped.length > 0) {
        skipped.push({ item, why: again.skipped[0]!.why });
        continue;
      }
      ops.push(...again.ops);
      corrections.push(...again.corrections);
      acted.push(item);
      continue;
    }
    if (item.kind === 'join') {
      const plan = unjoin(item, now, joinedInto);
      if (typeof plan === 'string') {
        skipped.push({ item, why: plan });
        continue;
      }
      ops.push(...plan);
      acted.push(item);
      continue;
    }
    if (item.kind === 'split') {
      const one = now.get(`${item.id}/1`);
      const two = now.get(`${item.id}/2`);
      if (one === undefined || two === undefined) {
        skipped.push({ item, why: 'its two halves are no longer both in the book' });
        continue;
      }
      if (one.struck || two.struck) {
        skipped.push({ item, why: 'one of its halves has been struck since the run' });
        continue;
      }
      if (one.text !== item.first || two.text !== item.second) {
        skipped.push({ item, why: 'the words of its halves have changed since the run' });
        continue;
      }
      if (one.category === 'Footnote' || two.category === 'Footnote') {
        skipped.push({ item, why: 'one of its halves is a footnote now, and a note is never joined' });
        continue;
      }
      ops.push({ op: 'merge', id: `${item.id}/2`, into: `${item.id}/1` });
      if (`${item.first} ${item.second}` !== item.before) ops.push({ op: 'text', id: `${item.id}/1`, text: item.before });
      if (one.category !== item.from) ops.push({ op: 'category', id: `${item.id}/1`, category: item.from });
      acted.push(item);
      continue;
    }
    const row = now.get(item.id);
    if (row === undefined) {
      skipped.push({ item, why: 'it is no longer in the book' });
      continue;
    }
    if (item.kind === 'link' || item.kind === 'unlink') {
      const block = now.get(item.block);
      if (block === undefined || block.text !== item.blockBefore) {
        skipped.push({ item, why: `the block its number is printed in (${item.block}) has changed since the run` });
        continue;
      }
      ops.push({ op: item.kind === 'link' ? 'unlink' : 'link', note: item.id, block: item.block, at: item.at, len: item.len });
      acted.push(item);
      continue;
    }
    if (item.kind === 'restore') {
      if (row.struck) {
        skipped.push({ item, why: 'it has been struck again since the run' });
        continue;
      }
      if (row.text !== item.before) {
        skipped.push({ item, why: 'its text has changed since the run' });
        continue;
      }
      ops.push({ op: 'strike', id: item.id });
    } else if (item.kind === 'strike') {
      if (!row.struck) {
        skipped.push({ item, why: 'it is not struck any more' });
        continue;
      }
      if (row.text !== item.before) {
        skipped.push({ item, why: 'its text has changed since the run' });
        continue;
      }
      ops.push({ op: 'restore', id: item.id });
    } else if (item.kind === 'category') {
      if (row.struck) {
        skipped.push({ item, why: 'it has been struck since the run' });
        continue;
      }
      if (row.category !== item.to) {
        skipped.push({ item, why: 'its kind has changed since the run' });
        continue;
      }
      if (row.chapter !== chapterAfter(item)) {
        skipped.push({ item, why: 'the chapter at it has changed since the run' });
        continue;
      }
      ops.push(...retypeOps(item.id, item.to, item.from, chapterAfter(item), item.chapterBefore));
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

/**
 * ONE JOIN, CUT AGAIN — or why not. The block it went into is found by following
 * the chain (a join into a block that was itself joined lives in that one's
 * survivor) and then down the first halves earlier cuts left (`<id>/1`). Its
 * words must END with this block's words after the one space the merge put
 * there, and what comes before them must end with the words it was joined to;
 * anything else is a block that has been edited, or joined to more since.
 * `now` is updated with the halves, for the next join of a chain.
 */
function unjoin(
  item: Extract<AskMark, { kind: 'join' }>,
  now: Map<string, AskRowState>,
  joinedInto: ReadonlyMap<string, string>,
): BookOp[] | string {
  let at = item.into;
  const seen = new Set<string>();
  while (!now.has(at) && joinedInto.has(at) && !seen.has(at)) {
    seen.add(at);
    at = joinedInto.get(at)!;
  }
  while (!now.has(at) && now.has(`${at}/1`)) at = `${at}/1`;
  const row = now.get(at);
  if (row === undefined) return `the block it was joined to (${item.into}) is no longer in the book`;
  if (row.struck) return 'the joined block has been struck since the run';
  const cut = row.text.length - item.before.length - 1;
  if (cut < 0 || row.text.slice(cut + 1) !== item.before || row.text[cut] !== ' ') {
    return 'the joined block does not end with its words any more — it was edited, or more was joined after it; take those back first';
  }
  const first = row.text.slice(0, cut);
  if (!first.endsWith(item.intoBefore)) return 'the words it was joined to have changed since the run';
  const one = `${at}/1`;
  const two = `${at}/2`;
  const ops: BookOp[] = [
    { op: 'split', id: at, at: cut },
    { op: 'text', id: two, text: item.before },
  ];
  if (item.category !== row.category) ops.push({ op: 'category', id: two, category: item.category });
  if (row.chapter !== null) ops.push({ op: 'chapter', set: one, title: row.chapter });
  now.delete(at);
  now.set(one, { ...row, text: first });
  now.set(two, { text: item.before, struck: false, category: item.category, chapter: null });
  return ops;
}

/**
 * THE OPS THAT TAKE ONE BLOCK FROM ONE KIND AND CHAPTER TO ANOTHER — the landing
 * and the undo are this with the two sides swapped. A `chapter set` retitles a
 * division already there, so it is the op for both "start one" and "put its old
 * title back"; only taking a division away is `remove`.
 */
function retypeOps(
  id: string,
  fromCategory: string,
  toCategory: string,
  fromChapter: string | null,
  toChapter: string | null,
): BookOp[] {
  const ops: BookOp[] = [];
  if (fromCategory !== toCategory) ops.push({ op: 'category', id, category: toCategory });
  if (fromChapter !== toChapter) {
    ops.push(toChapter === null ? { op: 'chapter', remove: id } : { op: 'chapter', set: id, title: toChapter });
  }
  return ops;
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
