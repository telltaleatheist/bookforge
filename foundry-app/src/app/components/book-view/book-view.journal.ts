/**
 * book-view.journal — the pending edit stack: pushing ops, undo and redo, and applying or discarding the stack.
 */
import { afterNextRender, effect, signal } from '@angular/core';
import { unwritten, type BookOp } from '@owen/foundry-core/shared/ops';
import type { AskStackInput } from '@owen/foundry-core/shared/ask-history';
import { api } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { Gesture, WordsGesture, OP_GESTURE } from './book-view.model';
import type { BookViewComponent } from './book-view.component';

// ───────────────────────────────────────────────────────────────────────────
// The stack: push, pop, and write it down
// ───────────────────────────────────────────────────────────────────────────

/**
 * One decision, onto the stack.
 *
 * THE REDO PILE IS DROPPED BY ANY NEW GESTURE, which is what every undo stack
 * in every program does and is the only coherent rule: the pile is a list of
 * things that were true of a document that has just changed under them, and
 * offering to re-apply a strike over a paragraph somebody has since retyped
 * would put an op back into a book it was never about.
 */
export function push(this: BookViewComponent, ...ops: readonly BookOp[]): void {
  this.pushOps(ops, null);
}

/** Several ops as ONE gesture on the undo stack, described as `what`. */
/**
 * THE STACK AS ASK'S HISTORY READS IT. `pending` begins as the tip's own ops
 * (`landedOps`) by identity, so the shared head is what is saved and still in
 * effect and the rest is unsaved. The journal is walked from its end against
 * that unsaved tail so each op carries the act it was pushed as — "removing
 * the chapter …" — where it was one; a single gesture, or an op recovered
 * from the sidecar, carries none.
 */
export function askStack(this: BookViewComponent): AskStackInput | null {
  const book = this.book();
  if (book === null) return null;
  const landed = this.landedOps();
  const pending = this.pending();
  let shared = 0;
  while (shared < landed.length && shared < pending.length && landed[shared] === pending[shared]) shared += 1;
  const tail = pending.slice(shared);
  const groups: (string | null)[] = tail.map(() => null);
  let at = tail.length;
  for (const gesture of [...this.did()].reverse()) {
    if (at <= 0) break;
    if (gesture.kind === 'op') at -= 1;
    else if (gesture.kind === 'ops') {
      for (let n = 0; n < gesture.count && at > 0; n += 1) groups[--at] = gesture.what;
    }
  }
  return {
    rows: book.rows,
    loose: book.loose,
    chapters: book.chapters,
    earlier: book.ops,
    kept: pending.slice(0, shared),
    tail,
    undone: this.undone(),
    tailGroups: groups,
  };
}

export function pushAsOne(this: BookViewComponent, what: string, ops: readonly BookOp[]): void {
  this.pushOps(ops, what);
}

export function pushOps(this: BookViewComponent, ops: readonly BookOp[], grouped: string | null): void {
  if (ops.length === 0) return;
  /*
   * AN EXPORT VIEW TAKES NO DECISIONS, and the panels are the one door that
   * can still reach this line (the paper's own gestures are all behind the
   * edition guards). The sentence says where editing lives rather than the
   * push vanishing — a click that does nothing silently is the failure this
   * app keeps refusing to ship.
   */
  if (this.viewing()) {
    this.notices.notice.set(
      'This tab shows a finished export. To change the book, open it from its step in the tree '
      + 'and export again.',
    );
    return;
  }
  /*
   * AND ANY DECISION AT ALL PUTS THE PANE BACK ON THE BENCH.
   *
   * Nothing on the paper can reach this line while the edition is on — every
   * gesture up there is guarded — so what this is actually about is THE
   * PANELS. Notes, Furniture review and Chapters live in the shell, they keep
   * drawing the workbench's truth while the preview is up (they are workshop
   * tools, RENDERER-DESIGN.md §5), and each of them pushes onto this very list.
   * A strike minted from a panel would otherwise land on a page that does not
   * draw strikes: the row would simply vanish, with no cancel mark anywhere
   * saying a person had done that.
   *
   * ONE RULE FOR EVERY DOOR, stated once, here, rather than at each panel:
   * a change to the book is made where changes are visible. Setting the signal
   * to what it already holds is nothing (`signal` compares), so this costs the
   * ordinary case exactly nothing.
   */
  this.mode.set('workbench');
  this.pending.update((held) => [...held, ...ops]);
  this.undone.set([]);
  // One marker per op, so the journal's order matches the stack's — and the
  // redo pile of BOTH kinds goes, for the rule at the top of this docblock.
  this.did.update((held) => [
    ...held,
    ...(grouped !== null && ops.length > 1
      ? [{ kind: 'ops', count: ops.length, what: grouped } satisfies Gesture]
      : ops.map((): Gesture => OP_GESTURE)),
  ]);
  this.rewound.set([]);
  this.remember();
}

/**
 * The journal, re-derived from the stacks — for every moment the stacks are
 * REPLACED rather than grown: a load's hydration (every branch of it), a
 * discard, a parked stack coming back. Ops become markers; corrections have
 * no entries to rebuild, which is the session-scoped half of the journal's
 * own docblock.
 */
export function resetJournal(this: BookViewComponent): void {
  this.did.set(this.pending().map((): Gesture => OP_GESTURE));
  this.rewound.set(this.undone().map((): Gesture => OP_GESTURE));
}

/**
 * THE STACK, TOWARDS THE DISK — called by every gesture that changes it.
 *
 * ── Three callers and not an effect, deliberately ───────────────────────────
 *
 * `push`, `undo` and `redo` are the whole of what a person can do to this list;
 * `load` and `apply` are the other two writers and neither of them is a change
 * somebody made — one is the disk arriving and the other is the disk being
 * written — so both say what they mean for themselves. An effect over
 * `pending()` would have been shorter and would have fired DURING a load, while
 * the old book's stack was still standing and the new book's had not been
 * hydrated yet, writing one book's decisions into another book's sidecar.
 *
 * WHAT IS SENT IS THE DIFFERENCE, not the list: `kept` is how much of the tip's
 * recorded ops the working list still begins with, and the tail is what was made
 * since (`PendingStack`, shared/ops.ts — its comment has the identity argument
 * for why a faithful `{landed, pending}` could not survive the round trip).
 *
 * AN EXPORT VIEW REMEMBERS NOTHING. It has no position, no stack and no project
 * pointer to be a delta against; the guard is the same one `push` states.
 *
 * ── ONE SIDECAR PER PROJECT, AND THE ONE CASE THAT COSTS ───────────────────
 *
 * The file is `ops/pending.jsonl` — one per project, because there is one book
 * pane per project and one pointer for it to be standing on. That makes exactly
 * one sequence lossy, and it is named here rather than discovered: work held at
 * step A, the pointer moved to step B by some other route (the tree, another
 * window, a reopened app), and then a gesture made at B. The read at B refuses
 * the held stack OUT LOUD and says where it is — *"stand on the step you made
 * them at to pick them up"* — and the first gesture afterwards writes over it.
 * So it is announced rather than silent, and the announcement comes before the
 * overwrite rather than after. Closing it completely would mean a file per step
 * (`pending.<id8>.jsonl`), which is a different design with orphans of its own
 * — no step names those files, so no sweep would ever take them — and it is not
 * what this fix was asked for.
 */
export function remember(this: BookViewComponent): void {
  if (this.viewing()) return;
  const landed = this.landedOps();
  const held = this.pending();
  let kept = 0;
  while (kept < landed.length && kept < held.length && landed[kept] === held[kept]) kept += 1;
  this.stacks.rememberPending(this.tab().path, {
    kept,
    tail: held.slice(kept),
    undone: this.undone(),
  });
}

/**
 * Ctrl+Z, routed from `BookStacksService.replay`. Pops one op; never touches a disk.
 *
 * ── THE CHORD FLIPS TO THE BENCH FIRST, AND THAT WAS A CHOICE ──────────────
 *
 * The stack is mode-independent — it is a list of ops and the edition is a
 * projection — so a chord COULD be performed where it was pressed. It is not,
 * because most of what an undo does is invisible in a preview: taking back a
 * text edit, a relabel or a chapter rename changes a page the edition draws
 * exactly as it drew it before, and taking back a strike makes a paragraph
 * appear out of nowhere with nothing on the page saying it was ever cancelled.
 * An undo somebody cannot see the result of is an undo they press twice.
 *
 * So it lands where its marks are, which is also the rule `push` states for
 * every other decision on this book: one answer for taking something back and
 * for doing it in the first place.
 */
export function undo(this: BookViewComponent): void {
  const journal = this.did();
  const last = journal[journal.length - 1];
  if (last === undefined) return;
  this.mode.set('workbench');
  /*
   * A CORRECTED PARAGRAPH IS TAKEN BACK BY CORRECTING IT BACK — the journal's
   * whole argument, at the one place the two kinds of gesture part ways. It is
   * async (a records round trip) and the journal entries move only after main
   * says yes, so a refusal leaves everything standing exactly as it was, with
   * main's sentence on the notice strip.
   */
  if (last.kind === 'words') {
    void this.replayWords(last, 'undo');
    return;
  }
  const held = this.pending();
  if (last.kind === 'ops') {
    // The group comes off whole. `undone` is a stack read from its end, so the
    // ops go onto it last-first, exactly as one undo per op would have left it.
    if (held.length < last.count) return;
    const popped = held.slice(held.length - last.count);
    this.did.set(journal.slice(0, -1));
    this.rewound.update((taken) => [...taken, last]);
    this.pending.set(held.slice(0, held.length - last.count));
    this.undone.update((taken) => [...taken, ...[...popped].reverse()]);
    this.remember();
    this.replayedFeedback(popped[0]!, 'undo', last.what);
    return;
  }
  const popped = held[held.length - 1];
  if (popped === undefined) return;
  this.did.set(journal.slice(0, -1));
  this.rewound.update((taken) => [...taken, last]);
  this.pending.set(held.slice(0, -1));
  this.undone.update((taken) => [...taken, popped]);
  // Taking a change back is a change to what is waiting. A sidecar that only
  // ever grew would hold decisions the person has taken off the page.
  this.remember();
  this.replayedFeedback(popped, 'undo');
}

/** Ctrl+Shift+Z / Ctrl+Y. Puts the last-undone gesture back where it was. */
export function redo(this: BookViewComponent): void {
  const pile = this.rewound();
  const last = pile[pile.length - 1];
  if (last === undefined) return;
  this.mode.set('workbench');
  if (last.kind === 'words') {
    void this.replayWords(last, 'redo');
    return;
  }
  const taken = this.undone();
  if (last.kind === 'ops') {
    if (taken.length < last.count) return;
    const back = taken.slice(taken.length - last.count).reverse();
    this.rewound.set(pile.slice(0, -1));
    this.did.update((held) => [...held, last]);
    this.undone.set(taken.slice(0, taken.length - last.count));
    this.pending.update((held) => [...held, ...back]);
    this.remember();
    this.replayedFeedback(back[0]!, 'redo', last.what);
    return;
  }
  const op = taken[taken.length - 1];
  if (op === undefined) return;
  this.rewound.set(pile.slice(0, -1));
  this.did.update((held) => [...held, last]);
  this.undone.set(taken.slice(0, -1));
  this.pending.update((held) => [...held, op]);
  this.remember();
  this.replayedFeedback(op, 'redo');
}

/**
 * One corrected paragraph, walked back or forward — through the same
 * `correct` door the edit went through, so the records file stays the one
 * truth and this walk is itself on the record.
 *
 * THE ENTRY MOVES BY IDENTITY, NOT BY POSITION: the round trip takes a
 * moment, and a gesture made while it is in flight has already grown the
 * journal past where this entry sat. `correct`'s own one-in-flight guard
 * makes a second CHORD during the trip a refusal with a sentence, so the
 * identity search is belt to that braces.
 */
export async function replayWords(this: BookViewComponent, entry: WordsGesture, direction: 'undo' | 'redo'): Promise<void> {
  const target = direction === 'undo' ? entry.before : entry.after;
  const ok = await this.correct(entry.id, target, false);
  if (!ok) return;
  const drop = (held: readonly Gesture[]): readonly Gesture[] => {
    const at = held.lastIndexOf(entry);
    return at < 0 ? held : [...held.slice(0, at), ...held.slice(at + 1)];
  };
  if (direction === 'undo') {
    this.did.update(drop);
    this.rewound.update((held) => [...held, entry]);
    this.notices.notice.set(
      'Took back the corrected paragraph — its earlier words are recorded again.');
  } else {
    this.rewound.update(drop);
    this.did.update((held) => [...held, entry]);
    this.notices.notice.set('Put back the corrected paragraph.');
  }
  afterNextRender(() => { this.land(entry.id); }, { injector: this.injector });
}

/**
 * SAY WHAT THE CHORD JUST DID, AND SHOW WHERE IT DID IT.
 *
 * ── The defect this answers (Owen, 2026-08-23) ──────────────────────────────
 *
 * *"i notice ctrl+z and shift+ctrl+z dont really do much of anything."* They
 * did exactly what they were built to do — pop one op, put one back — in
 * perfect silence, usually about a block somewhere off screen. A sweep lands
 * forty strikes in one sitting; one Ctrl+Z takes back ONE of them, four
 * chapters below the viewport, and from the chair nothing whatsoever happened.
 * An undo nobody can see is indistinguishable from an undo that is broken,
 * which is `BookStacksService.replay`'s own standard for the refusals — this
 * extends it to the successes.
 *
 * So every pop says a sentence naming the change and the count still waiting,
 * and the sheet glides to the block it happened to and pulses it — `land`, the
 * same landing every panel jump already makes. After the next render, because
 * the replay has to put the block back (an undone merge, a redone insert)
 * before there is anything to scroll to; `land` answers a block that is not
 * there by doing nothing, which is right for the one op with no block at all
 * (a chapter reset).
 */
export function replayedFeedback(this: BookViewComponent, op: BookOp, direction: 'undo' | 'redo', what?: string): void {
  const left = this.waiting();
  const tail = left === 0
    ? ' — nothing is waiting now'
    : left === 1 ? ' — 1 change is still waiting' : ` — ${left} changes are still waiting`;
  this.notices.notice.set(
    `${direction === 'undo' ? 'Took back' : 'Put back'} ${what ?? this.describeOp(op)}${tail}.`,
  );
  const target = this.opAnchor(op, direction);
  if (target === null) return;
  afterNextRender(() => { this.land(target); }, { injector: this.injector });
}

/** One op, named in words a sentence can carry. */
export function describeOp(this: BookViewComponent, op: BookOp): string {
  switch (op.op) {
    case 'strike': return 'striking a block';
    case 'restore': return 'restoring a block';
    case 'text': return 'a text edit';
    case 'category': return `calling a block ${op.category}`;
    case 'merge': return 'joining two blocks';
    case 'split': return 'cutting a block in two';
    case 'move': return 'moving a block';
    case 'insert': return 'adding a block';
    case 'link': return 'binding a reference number';
    case 'unlink': return 'unbinding a reference number';
    case 'restore-furniture': return 'putting a shelved row back';
    case 'chapter':
      if ('set' in op) return 'placing a chapter marker';
      if ('remove' in op) return 'removing a chapter marker';
      if ('rename' in op) return 'renaming a chapter';
      if ('move' in op) return 'moving a chapter marker';
      return 'giving the chapters back to the reading';
  }
}

/**
 * The block the landing should centre — WHICH EXISTS AFTER the replay, which
 * is why the direction matters: an undone insert leaves only its anchor, a
 * redone split leaves only its halves, a redone merge leaves only the
 * survivor. Null for the one decision that is about no block (chapter reset),
 * and for anything whose target the replay then cannot find, `land` itself
 * answers with stillness.
 */
export function opAnchor(this: BookViewComponent, op: BookOp, direction: 'undo' | 'redo'): string | null {
  switch (op.op) {
    case 'insert':
      return direction === 'undo' ? (op.before ?? op.after ?? null) : op.id;
    case 'merge':
      return direction === 'undo' ? op.id : op.into;
    case 'split':
      return direction === 'undo' ? op.id : `${op.id}/1`;
    case 'link':
    case 'unlink':
      return op.block;
    case 'chapter':
      if ('set' in op) return op.set;
      if ('remove' in op) return op.remove;
      if ('rename' in op) return op.rename;
      if ('move' in op) return direction === 'undo' ? op.move : op.to;
      return null;
    default:
      return op.id;
  }
}

/** What the button says. The count is IN the label, on `labelFor`'s rule. */
export function applyLabel(this: BookViewComponent): string {
  const many = this.waiting();
  return many === 1 ? 'Apply 1 change' : `Apply ${many} changes`;
}

/**
 * APPLY — the stack, landed as a step.
 *
 * ── What happens afterwards, and why nothing here does it ───────────────────
 *
 * Main writes the ops file, lands an `edit` step as a child of the position and
 * moves the pointer onto it (`applyBookOps`, electron/book.ts). Adopting the
 * answer is all this does: `LedgerService.adopt` paints the history main handed
 * back, the position effect in `PositionSyncService` notices a picture it has not shown
 * (`positionPicture` carries the edit chain for exactly this), and that bumps
 * this tab's revision — which reloads the book with the ops on its CHAIN and
 * clears the stack on the way. Clearing it here as well would be this component
 * doing by hand the thing the round trip proves, and would put the unedited book
 * on screen for the turns in between (see `landed`, which is what carries the
 * one fact across that gap).
 *
 * A REFUSAL LEAVES THE STACK EXACTLY WHERE IT IS, with main's sentence on the
 * notice strip. The changes are still on the paper in front of the person, which
 * is the only honest state for a write that did not happen — and the closing
 * question, which can call this, needs the false answer to keep the tab open.
 */
export async function apply(this: BookViewComponent): Promise<boolean> {
  if (api === null || this.waiting() === 0 || this.applying()) return false;
  // A block still live when Apply is pressed has words in it nobody has
  // recorded yet. Committing first is what makes "apply what is on screen"
  // true rather than "apply what was on screen before you started typing".
  this.commitEditing();
  const ops = this.pending();
  this.applying.set(true);
  try {
    /*
     * ── AMEND THE TIP, OR LAND A STEP — the consolidation ruling ────────────
     *
     * Standing on an edit step nothing has been made from (`landedOps`
     * non-empty means the load found one), Apply rewrites that step to the
     * list as it now stands; the pointer never moves, no reload fires, and
     * the stack simply becomes the recorded state — undo still reaches back
     * through all of it. Everywhere else, Apply lands a new step exactly as
     * it always has, the pointer follows, and the reload's hydration is what
     * makes the NEXT Apply an amendment.
     *
     * An amendment can also RECORD ONLY REMOVALS: undo below the applied
     * boundary leaves pending shorter than landed, `waiting()` counts it,
     * and the rewrite is how the removal reaches the disk.
     */
    const amending = this.landedOps().length > 0;
    const history = amending
      ? await api.book.amend(this.tab().path, ops)
      : await api.book.apply(this.tab().path, ops);
    if (amending) {
      this.landedOps.set(ops);
    } else {
      this.landed = true;
    }
    /*
     * ── THE SIDECAR GOES, AND IT GOES BEFORE THE RELOAD ────────────────────
     *
     * These decisions are a step now, so the held copy is a duplicate — and a
     * duplicate that would be offered back as a recovery on the next open, as a
     * delta against a book that already has it. Awaited rather than fired,
     * because the very next thing that happens is `ledger.adopt` → a pointer
     * move → a reload, and that reload ASKS FOR THIS FILE; a clear still in
     * flight would race it.
     *
     * ONE OF THE TWO SANCTIONED SCRAPS (`discardPending` names both). It is
     * safe here in a way it is nowhere else: main has already answered, so the
     * work is on disk in the one place that outlives everything.
     */
    await this.stacks.discardPending(this.tab().path);
    this.ledger.adopt(this.tab().path, history);
    return true;
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    this.applying.set(false);
  }
}

/**
 * DISCARD — the stack taken off the page, on somebody's own say-so.
 *
 * ── Whose gesture this is, and what it is NOT ──────────────────────────────
 *
 * There is no button on this surface that calls it. The only caller is
 * `BookStacksService.discardUnapplied`, which is the Discard answer to the card
 * Owen's ruling put in front of every act (2026-08-22): *"if they hit discard,
 * it does whatever action they selected to the step theyre on after dropping
 * changes they made."* The pane is one of the three places that stack lives —
 * the parked copy and the project's sidecar are the other two — and the service
 * empties all three in one call, because "discarded" changes that come back on
 * the next gesture or the next open are not discarded.
 *
 * ── BACK TO THE RECORDED BOOK, NOT TO AN EMPTY ONE ─────────────────────────
 *
 * `pending` starts life as a COPY of the tip's own ops when the position is an
 * amendable edit step (see `load`), which is what makes `waiting()` a
 * difference rather than a length. So the way back is `landedOps` — put the
 * list where the disk has it — and that is the same arithmetic read the other
 * way round: after this, `unwritten(landed, pending)` is zero by construction,
 * for a tip with ops and for a position without one alike. Setting an empty
 * array instead would have thrown away applied history on an amendable step and
 * then offered the removal to the next Apply as a decision nobody made.
 *
 * ── THE LIVE EDITOR GOES WITH IT, UNCOMMITTED ──────────────────────────────
 *
 * `apply` commits the block being retyped first, because "apply what is on
 * screen" has to include the words under the caret. This does the opposite for
 * the same reason: those words are unapplied work too, and committing them here
 * would push a text op onto a stack one microtask before it is emptied — or,
 * worse, after. `editingId` is dropped rather than blurred, so the editor
 * element is torn out of the view and its `blur` handler never runs.
 *
 * ── AND IT DOES NOT WRITE THE SIDECAR ──────────────────────────────────────
 *
 * No `remember()` here, deliberately, and it is not an omission the next reader
 * should fix. The caller clears the file immediately afterwards — which also
 * cancels the debounced write this pane may already owe — so a `remember` would
 * be one write racing one delete over a stack nobody wants. The next real
 * gesture writes the honest state.
 */
export function discardStack(this: BookViewComponent): void {
  this.editingId.set(null);
  this.renaming.set(null);
  this.mode.set('workbench');
  this.pending.set([...this.landedOps()]);
  this.undone.set([]);
  this.resetJournal();
  // Both cards are about a paragraph whose marks may have just changed under
  // them — `load`'s own reason for putting them down.
  this.dismissCards();
}

// ───────────────────────────────────────────────────────────────────────────
// The four gestures
// ───────────────────────────────────────────────────────────────────────────

/**
 * DELETE STRIKES — and Delete again, over the same blocks, brings them back.
 *
 * *"if i click them and hit delete again, it should un-delete them."* One key,
 * both directions, decided by what is under it: a selection with anything
 * unstruck in it is a person saying "remove these", so the unstruck ones are
 * struck and the ones already cancelled are left alone (striking them twice
 * would be two ops for one state, and the second would be the op undo takes
 * back first). A selection where EVERY block is already struck is the only
 * reading of the gesture left, and it restores them.
 *
 * BACKSPACE TOO, because on a surface with no text field in focus the two keys
 * mean one thing to a hand, and a gesture that worked on one keyboard's Delete
 * and not on a laptop's is a gesture half the users do not have.
 *
 * NOT WHILE A BLOCK IS LIVE. Delete inside a caret is a character, and it
 * belongs to the editor.
 */
export function cancel(this: BookViewComponent, event: Event): void {
  if (this.editingId() !== null) return;
  /*
   * A KEY PRESSED INTO ANY EDITABLE ON THE SHEET IS THAT EDITABLE'S. The
   * block editor is guarded above by its signal, and the chapter chip's
   * rename was not: its Backspace bubbled here, found the selection still
   * standing from before the double-click, and un-deleted a struck block
   * while the person was erasing letters of a title (user report,
   * 2026-08-16). The target's own word for itself is the general guard —
   * any contenteditable this sheet ever grows is covered the day it lands.
   */
  const target = event.target as HTMLElement | null;
  if (target !== null && target.isContentEditable) return;
  const chosen = this.chosen();
  if (chosen.size === 0) return;
  event.preventDefault();
  /*
   * AND IN THE EDITION IT ONLY FLIPS (§5). Delete is the plainest edit gesture
   * on this surface and the preview is read-only, so the press buys the mode it
   * needs rather than the strike it asked for — and the selection it would have
   * struck is still exactly what it was, drawn again with its rails and chips,
   * so pressing Delete once more does the thing. NOTHING IS FOCUSED because
   * nothing single was named: a Delete is about a selection, and the selection
   * is what comes back.
   */
  if (this.edition()) {
    this.mode.set('workbench');
    return;
  }
  const replayed = this.view();
  if (replayed === null) return;
  const struck = new Set(replayed.rows.filter((row) => row.struck === true).map((row) => row.id));
  const picked = replayed.rows.filter((row) => chosen.has(row.id));
  const unstruck = picked.filter((row) => !struck.has(row.id));
  this.push(...(unstruck.length > 0
    ? unstruck.map((row): BookOp => ({ op: 'strike', id: row.id }))
    : picked.map((row): BookOp => ({ op: 'restore', id: row.id }))));
}
