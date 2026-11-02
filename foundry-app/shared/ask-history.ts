/**
 * THE BOOK'S HISTORY, AS ASK READS IT — every edit, newest first, and the
 * inverse of any of them proposed as a mark (Owen, 2026-11-02: Ask should see
 * the book's do/undo history).
 *
 * The pane holds all of it (`BookStack.askStack`): the file's rows and the
 * earlier steps' ops it replays from, the tip step's ops still in effect, the
 * edits not yet applied, and the redo pile. Together the first three are the
 * CHAIN, in the order they were made; the redo pile is what undo took off it.
 *
 * ── ONE OWNER FOR "THE OPPOSITE OF AN EDIT" ─────────────────────────────────
 *
 * A history entry is turned into the mark it would have been had Ask made it
 * (`originalMark`, from the book just before and just after the edit), and its
 * inverse is then `planUndo` of that mark — the review card's own undo. So a
 * revert of a hand-made strike, of a join, of a link is the same decision with
 * the same refusals as undoing Ask's own, and there is no second inverse to
 * drift from the first.
 */
import { askMarkKey, askRowStates, planUndo, type AskMark, type AskRowState, type AskSession } from './ask';
import type { BookChapter, BookLoose, BookRow } from './book';
import { replayOps, type BookOp, type Replayed } from './ops';

/** What the pane hands over: the file and every op it replays, split where they live. */
export interface AskStackInput {
  readonly rows: readonly BookRow[];
  readonly loose: BookLoose;
  readonly chapters: readonly BookChapter[];
  /** The ops of the steps below the tip, in order — saved. */
  readonly earlier: readonly BookOp[];
  /** The tip step's ops still in effect — saved. */
  readonly kept: readonly BookOp[];
  /** Edits made since, not yet applied, in order. */
  readonly tail: readonly BookOp[];
  /** What undo took off the stack, newest last. */
  readonly undone: readonly BookOp[];
  /** For each op of `tail`, the name of the act it was part of ("removing the chapter …"), or null. */
  readonly tailGroups: readonly (string | null)[];
}

/** One edit, as the history tool lists it. */
export interface AskHistoryEntry {
  /** `c<n>` for the n-th op of the chain, `r<n>` for the n-th of the redo pile. Stable for a run. */
  readonly handle: string;
  readonly where: 'unsaved' | 'saved' | 'undone';
  readonly op: BookOp;
  /** The op in plain words: "struck e-579", "joined e-413 into e-412". */
  readonly said: string;
  /** The block's words just before the edit, clipped; for a revision, before → after. */
  readonly text: string;
  /** Who made it, where that is known: an Ask run and its reason, a named act, or nobody known. */
  readonly from: string;
  /** Every block id it names, for the id filter. */
  readonly ids: readonly string[];
}

/** The history over one pane's stack, replaying lazily: only the entries asked for are worked out. */
export class AskHistory {
  private readonly chain: readonly BookOp[];
  private readonly states = new Map<number, Replayed>();

  constructor(private readonly input: AskStackInput, private readonly sessions: readonly AskSession[]) {
    this.chain = [...input.earlier, ...input.kept, ...input.tail];
  }

  /** How many edits in all, the redo pile included. */
  size(): number {
    return this.chain.length + this.input.undone.length;
  }

  /** The book after the first `n` ops of the chain. */
  private stateAt(n: number): Replayed {
    let held = this.states.get(n);
    if (held === undefined) {
      held = replayOps(this.input.rows, this.chain.slice(0, n), this.input.loose, this.input.chapters);
      this.states.set(n, held);
    }
    return held;
  }

  /** The book as it is now. */
  now(): Replayed {
    return this.stateAt(this.chain.length);
  }

  /** Newest first: the redo pile (undone, newest last there), then the chain from its end. */
  private handles(): string[] {
    const out: string[] = [];
    for (let j = this.input.undone.length - 1; j >= 0; j -= 1) out.push(`r${j}`);
    for (let i = this.chain.length - 1; i >= 0; i -= 1) out.push(`c${i}`);
    return out;
  }

  /** The entries matching the filters, newest first, from `offset`, at most `count`; and how many matched. */
  list(filter: { id?: string; kind?: string; offset?: number; count?: number }): { entries: AskHistoryEntry[]; matched: number } {
    const offset = Math.max(0, filter.offset ?? 0);
    const count = Math.max(1, Math.min(60, filter.count ?? 25));
    const wanted = this.handles().filter((handle) => {
      const op = this.opOf(handle)!;
      if (filter.kind !== undefined && op.op !== filter.kind) return false;
      if (filter.id !== undefined && !opIds(op).includes(filter.id)) return false;
      return true;
    });
    return { entries: wanted.slice(offset, offset + count).map((handle) => this.entry(handle)!), matched: wanted.length };
  }

  private opOf(handle: string): BookOp | null {
    const n = Number(handle.slice(1));
    if (!Number.isInteger(n) || n < 0) return null;
    if (handle.startsWith('c')) return this.chain[n] ?? null;
    if (handle.startsWith('r')) return this.input.undone[n] ?? null;
    return null;
  }

  /** One entry by its handle, or null for a handle this history has not got. */
  entry(handle: string): AskHistoryEntry | null {
    const op = this.opOf(handle);
    if (op === null) return null;
    const undone = handle.startsWith('r');
    const n = Number(handle.slice(1));
    // An undone op was taken off the end; the book it would apply to is the book now.
    const before = undone ? this.now() : this.stateAt(n);
    const savedLength = this.input.earlier.length + this.input.kept.length;
    const where = undone ? 'undone' : n < savedLength ? 'saved' : 'unsaved';
    const group = !undone && n >= savedLength ? this.input.tailGroups[n - savedLength] ?? null : null;
    return {
      handle,
      where,
      op,
      said: opSaid(op, before),
      text: textSaid(op, before),
      from: fromSaid(op, this.sessions, group),
      ids: opIds(op),
    };
  }

  /**
   * THE MARK AN EDIT WOULD HAVE BEEN, had Ask made it — read off the book just
   * before and just after it. Its inverse is `planUndo`'s. Throws a sentence
   * for an edit this program has no inverse for, or one already undone.
   */
  originalMark(handle: string, reason: string): AskMark {
    const op = this.opOf(handle);
    if (op === null) throw new Error(`there is no history entry ${handle}`);
    if (handle.startsWith('r')) {
      throw new Error(`${handle} is already undone (it is on the redo pile); the book's own redo puts it back`);
    }
    const n = Number(handle.slice(1));
    const before = rowsOf(this.stateAt(n));
    const row = (id: string) => before.get(id);
    const need = (id: string) => {
      const found = row(id);
      if (found === undefined) throw new Error(`${id} was not in the book when ${handle} was made, so there is nothing to put back`);
      return found;
    };
    switch (op.op) {
      case 'strike': return { id: op.id, kind: 'strike', reason, before: need(op.id).text };
      case 'restore': return { id: op.id, kind: 'restore', reason, before: need(op.id).text };
      case 'text': return { id: op.id, kind: 'text', reason, before: need(op.id).text, after: op.text };
      case 'category': {
        const was = need(op.id);
        return { id: op.id, kind: 'category', reason, before: was.text, from: was.category, to: op.category, chapter: null, chapterBefore: was.chapter };
      }
      case 'merge': {
        const eaten = need(op.id);
        const into = need(op.into);
        return { id: op.id, kind: 'join', reason, before: eaten.text, category: eaten.category, into: op.into, intoBefore: into.text };
      }
      case 'split': {
        const was = need(op.id);
        return {
          id: op.id, kind: 'split', reason, before: was.text, from: was.category, at: op.at,
          first: was.text.slice(0, op.at), second: was.text.slice(op.at),
          firstCategory: null, secondCategory: null, chapterBefore: was.chapter,
        };
      }
      case 'link': {
        const block = need(op.block);
        return { id: op.note, kind: 'link', reason, before: need(op.note).text, block: op.block, at: op.at, len: op.len, blockBefore: block.text };
      }
      case 'unlink': {
        const block = need(op.block);
        return { id: op.note, kind: 'unlink', reason, before: need(op.note).text, block: op.block, at: op.at, len: op.len, blockBefore: block.text };
      }
      case 'chapter': {
        if ('set' in op || 'rename' in op) {
          const id = 'set' in op ? op.set : op.rename;
          const was = need(id);
          return { id, kind: 'category', reason, before: was.text, from: was.category, to: was.category, chapter: { start: true, title: op.title }, chapterBefore: was.chapter };
        }
        if ('remove' in op) {
          const was = need(op.remove);
          return { id: op.remove, kind: 'category', reason, before: was.text, from: was.category, to: was.category, chapter: { start: false }, chapterBefore: was.chapter };
        }
        throw new Error(`${handle} ${'move' in op ? 'moved a chapter marker' : 'gave the chapters back to the reading'}, which Ask cannot propose undoing; the book's own undo can`);
      }
      default:
        throw new Error(`${handle} is ${opSaid(op, this.stateAt(n))}, which Ask cannot propose undoing; the book's own undo can`);
    }
  }

  /**
   * A REVERT, CHECKED AGAINST THE BOOK NOW — the original mark if its inverse
   * would land, or the sentence saying why it would be wrong (`planUndo`'s
   * own: the block changed since, was struck since, was joined to more since).
   */
  revertable(handle: string, reason: string): AskMark {
    const original = this.originalMark(handle, reason);
    const now = this.now();
    const plan = planUndo([original], askRowStates(now.rows, now.chapters), false);
    const skip = plan.skipped[0];
    if (skip !== undefined) throw new Error(`${handle} cannot be undone now: ${skip.why}`);
    return original;
  }

  /** The book now as the plans read it. */
  rowStatesNow(): ReadonlyMap<string, AskRowState> {
    const now = this.now();
    return askRowStates(now.rows, now.chapters);
  }
}

/** Each row's state off a replay, by id. */
function rowsOf(book: Replayed): ReadonlyMap<string, AskRowState> {
  return askRowStates(book.rows, book.chapters);
}

/** Every block an op names. */
export function opIds(op: BookOp): string[] {
  switch (op.op) {
    case 'merge': return [op.id, op.into];
    case 'move': return [op.id, op.before];
    case 'insert': return [op.id, ...(op.before === undefined ? [] : [op.before]), ...(op.after === undefined ? [] : [op.after])];
    case 'link':
    case 'unlink': return [op.note, op.block];
    case 'chapter':
      if ('set' in op) return [op.set];
      if ('remove' in op) return [op.remove];
      if ('rename' in op) return [op.rename];
      if ('move' in op) return [op.move, op.to];
      return [];
    default: return [op.id];
  }
}

/** An op in plain words, read against the book just before it. */
export function opSaid(op: BookOp, before: Replayed): string {
  const row = (id: string) => before.rows.find((one) => one.id === id);
  switch (op.op) {
    case 'strike': return `struck ${op.id}`;
    case 'restore': return `restored ${op.id}`;
    case 'text': return `revised ${op.id}`;
    case 'category': return `retyped ${op.id} ${row(op.id)?.category ?? '?'} → ${op.category}`;
    case 'merge': return `joined ${op.id} into ${op.into}`;
    case 'split': return `split ${op.id} at character ${op.at}`;
    case 'move': return `moved ${op.id} before ${op.before}`;
    case 'insert': return `added ${op.id} ${op.before !== undefined ? `before ${op.before}` : `after ${op.after ?? '?'}`}`;
    case 'link': return `linked note ${op.note} to its number in ${op.block}`;
    case 'unlink': return `unlinked note ${op.note} from its number in ${op.block}`;
    case 'restore-furniture': return `put shelved row ${op.id} back`;
    case 'chapter':
      if ('set' in op) return `started a chapter "${op.title}" at ${op.set}`;
      if ('remove' in op) return `took away the chapter at ${op.remove}`;
      if ('rename' in op) return `renamed the chapter at ${op.rename} "${op.title}"`;
      if ('move' in op) return `moved the chapter at ${op.move} to ${op.to}`;
      return 'gave the chapters back to the reading';
  }
}

function clipped(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

/** The words the edit was about, as they were just before it; a revision shows before → after. */
function textSaid(op: BookOp, before: Replayed): string {
  const id = opIds(op)[0];
  const row = id === undefined ? undefined : before.rows.find((one) => one.id === id);
  if (row === undefined) return '';
  if (op.op === 'text') return `${clipped(row.text, 70)} → ${clipped(op.text, 70)}`;
  return clipped(row.text, 100);
}

/**
 * WHO MADE IT: an Ask run whose kept marks include this very edit (by its
 * block and what it did), and that run's reason; else the act it was pushed
 * as, where the pane remembers one; else nobody this program can name.
 */
function fromSaid(op: BookOp, sessions: readonly AskSession[], group: string | null): string {
  for (let s = sessions.length - 1; s >= 0; s -= 1) {
    const session = sessions[s]!;
    const item = session.items.find((one) => markMade(one, op));
    if (item !== undefined) {
      const asked = session.chain === undefined ? clipped(session.request, 50) : session.chain.step;
      return `Ask ("${asked}"): ${item.reason}`;
    }
  }
  if (group !== null) return group;
  return 'by hand or a panel';
}

/** Whether an Ask mark is what landed as this op. */
function markMade(item: AskMark, op: BookOp): boolean {
  switch (op.op) {
    case 'strike': return item.kind === 'strike' && item.id === op.id;
    case 'restore': return item.kind === 'restore' && item.id === op.id;
    case 'text': return item.kind === 'text' && item.id === op.id && item.after === op.text;
    case 'category': return item.kind === 'category' && item.id === op.id && item.to === op.category;
    case 'merge': return item.kind === 'join' && item.id === op.id;
    case 'split': return item.kind === 'split' && item.id === op.id;
    case 'link': return item.kind === 'link' && item.id === op.note && item.block === op.block && item.at === op.at;
    case 'unlink': return item.kind === 'unlink' && item.id === op.note && item.block === op.block && item.at === op.at;
    case 'chapter':
      if ('set' in op) return item.kind === 'category' && item.id === op.set && item.chapter?.start === true && item.chapter.title === op.title;
      if ('remove' in op) return item.kind === 'category' && item.id === op.remove && item.chapter?.start === false;
      return false;
    default: return false;
  }
}

/** A revert's row identity, beside `askMarkKey`'s. */
export function revertKey(handle: string, original: AskMark): string {
  return `revert:${handle}:${askMarkKey(original)}`;
}
