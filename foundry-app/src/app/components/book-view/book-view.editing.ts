/**
 * book-view.editing — editing the book's text and structure: corrections, categories, joins, splits and chapter names.
 */
import { afterNextRender, signal } from '@angular/core';
import { type BookOp } from '@owen/foundry-core/shared/ops';
import { api } from '../../core/foundry';
import { flowNeighbours } from '@owen/foundry-core/shared/flow';
import { caretOffsetIn, cut } from './book-view.lines';
import type { BookViewComponent } from './book-view.component';

/**
 * Double-click puts the caret in the block.
 *
 * THE BLOCK ITSELF BECOMES THE EDITOR and the marker cuts go away for the
 * duration, because what is being edited is the SOURCE STRING — the superscript
 * digits and the `*markers*` are characters in it (docs/RENDERER.md §2), and an
 * editor that hid them would be an editor somebody could not put a reference
 * number back into. The cut pieces come back the moment it commits, re-derived
 * against the new words.
 *
 * A SHELVED ROW IS NOT EDITABLE HERE because it is not drawn here; a struck one
 * is, deliberately — striking is a state and not a removal, and correcting a
 * paragraph you have cancelled is an ordinary thing to do on the way to
 * restoring it.
 */
export function edit(this: BookViewComponent, event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const block = target === null ? null : target.closest('.block');
  const id = block === null ? null : block.getAttribute('data-id');
  this.beginEditing(id);
}

/**
 * Enter the editor on a named block — the shared destination of the two
 * doors that open it: a double-click on the block, and the right-click
 * menu's Edit. Two doors because a double-click has other meanings nearby
 * (the chapter chip renames, a note's first click raises the peek card),
 * and a person whose double-click landed on one of those needs a door that
 * cannot be misread.
 */
export function beginEditing(this: BookViewComponent, id: string | null): void {
  if (id === null || id === this.editingId()) return;
  // §5's sentence, exactly: the block is named, so the block is what comes back
  // focused. See `toBench` for why the caret does not come with it.
  if (this.edition()) {
    this.toBench(id);
    return;
  }
  this.commitEditing();
  this.editingId.set(id);
  this.chosen.set(new Set([id]));
  /*
   * FOCUSED AFTER THE FRAME THAT DRAWS IT. The editor element does not exist
   * until the template has re-run for the new `editingId`, and this app is
   * ZONELESS — so "after change detection" is a thing only Angular can promise,
   * and a `setTimeout` or a microtask here would be a guess about the
   * scheduler's own ordering. `afterNextRender` is that promise, and it needs
   * the injector because this runs from an event handler rather than from a
   * construction context.
   *
   * THE CARET GOES TO THE END rather than selecting the paragraph. A
   * double-click that highlighted every word would make the next keystroke
   * delete the block, which is a gesture nobody asked for arriving through one
   * they did.
   */
  afterNextRender(() => {
    const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
    if (editor === null) return;
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { injector: this.injector });
}

/**
 * Blur commits — the pair the app's other in-place editor already uses.
 *
 * The in-place editors this app has had all commit on Enter or blur and cancel
 * on Escape — three endings a person learns once. Two of the three are kept
 * verbatim here. ENTER IS THE THIRD AND IT DOES NOT COMMIT: it is the
 * SPLIT (docs/RENDERER.md §5), which commits the words as its own op on the way
 * past and then cuts them — see `split`, which is the only other place a `text`
 * op is minted and mints it for exactly this reason.
 *
 * ONE OP, AND ONLY IF THE STRING MOVED. A double-click that put a caret
 * somewhere and then went away has decided nothing, and a step recording it
 * would be a row in somebody's history about a paragraph they looked at.
 */
export function commit(this: BookViewComponent, id: string, event: Event): void {
  if (this.editingId() !== id) return;
  const editor = event.target as HTMLElement;
  // `textContent` and not `innerText`: the second one is a rendering — it folds
  // whitespace and inserts breaks the layout implies — and what is being read
  // back is a source string that must survive a round trip unchanged.
  const said = editor.textContent ?? '';
  this.editingId.set(null);
  const row = this.view()?.rows.find((candidate) => candidate.id === id);
  if (row === undefined || row.text === said) return;
  /*
   * AND ON A TRANSLATED POSITION THE WORDS ARE NOT AN OP.
   *
   * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
   * §5.) The words of a translated block belong to the records file — the
   * translate step's own payload, and the truth every derived book of it is a
   * pure function of — so a `text` op here would put this sentence in the ops
   * chain while the records still held the machine's, and the next time anything
   * materialised this translation it would answer with the machine's. Two truths
   * about one paragraph, which is the failure `translationWorldOf` was built to
   * make impossible one surface over.
   *
   * Everything else this sheet can do to a translated block IS an op and stays
   * one: striking it, relabelling it, joining it, cutting it, putting a division
   * above it. Those are decisions about the book's STRUCTURE, and a translation
   * has the same structure as the book it came from.
   */
  if (this.translation() !== null) {
    void this.correct(id, said);
    return;
  }
  this.push({ op: 'text', id, text: said });
}

/**
 * ONE CORRECTED PARAGRAPH, RECORDED — the round trip, and what comes back.
 *
 * ── The order, which is main's and is not negotiable from here ─────────────
 *
 * Main appends the row to the records file, materialises the derived book again
 * from it, and answers with the whole book (`correctBookBlock`, electron/book.ts).
 * There is nothing for this side to apply: the corrected words arrive as ROWS,
 * which is the only shape that keeps one account of them.
 *
 * ── THE STACK SURVIVES, and that is the point of reloading rows and not the
 * pane ──────────────────────────────────────────────────────────────────────
 *
 * `load` scraps the stack because it is called when the POSITION moved and the
 * ops on it are a delta against a book somebody left. Nothing moved here: the
 * same position, the same chain, one block's text different underneath. Every op
 * waiting on the stack is keyed by block id and none of them names a row that
 * stopped existing, so they replay onto the new rows exactly as they were
 * replaying onto the old ones — which is what `view()` does on the next frame
 * without being asked.
 *
 * ── The refusal, and what the person sees ──────────────────────────────────
 *
 * Main rejects with a sentence (a book that is not a translation, a block the
 * file does not hold, a run writing the records right now) and it goes to the
 * notice strip, where the rest of this window says what it would not do. The
 * paragraph is already showing its recorded words again by then, because the
 * editor closed before this call and nothing pushed an op — so the sentence is
 * the only thing standing between the person and a correction that vanished, and
 * main's own words say so.
 */
export async function correct(this: BookViewComponent, id: string, text: string, journal = true): Promise<boolean> {
  if (api === null) return false;
  // The words being replaced, read before anything moves — they are what an
  // undo of this correction has to put back.
  const before = this.view()?.rows.find((row) => row.id === id)?.text ?? null;
  /*
   * ONE AT A TIME, AND THE SECOND ONE IS TOLD SO. Two corrections in flight
   * would be two whole-file rewrites of one records file racing each other, and
   * the loser's paragraph would be gone with no sign of it anywhere. It is a
   * round trip of a moment, so this is a rare thing to meet — which is exactly
   * why it must not be met in silence: a paragraph that quietly reverted to the
   * machine's words is the failure this whole door exists to prevent.
   */
  if (this.correcting) {
    this.notices.notice.set(
      'The last corrected paragraph is still being written into this translation\'s records, so '
      + 'this one was not — it is showing its recorded words again. Make the edit once more.',
    );
    return false;
  }
  const ticket = this.asked;
  this.correcting = true;
  try {
    const answered = await api.book.correct(this.tab().path, id, text);
    // The pane was pointed somewhere else while this was in flight: the answer is
    // about a book that is no longer on screen. `load`'s own ticket, for its
    // reason.
    if (ticket !== this.asked) return false;
    if (answered.ok) {
      this.book.set(answered);
      /*
       * ONTO THE JOURNAL, so Ctrl+Z can walk back over it — the whole of the
       * repair for "changing the text inside a block definitely wasnt
       * undoing". Only a correction that CHANGED something: retyping a
       * paragraph to its own words decided nothing, and main has recorded
       * nothing new for an undo to reverse.
       */
      if (journal && before !== null && before !== text) {
        this.did.update((held) => [...held, { kind: 'words', id, before, after: text }]);
        this.rewound.set([]);
      }
      return true;
    }
    // The correction landed and the book could not be read back — main's
    // sentence goes on the paper, which is where a book that cannot be drawn
    // says why (`load`).
    this.problem.set(answered.reason);
    return false;
  } catch (err) {
    if (ticket !== this.asked) return false;
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    this.correcting = false;
  }
}

/**
 * Escape reverts: the words go back and the blur that follows finds nothing
 * changed.
 *
 * NO FLAG AND NO SECOND PATH. Putting the source string back into the element
 * BEFORE letting go of focus means the commit above compares the text to
 * itself, decides nothing happened and pushes nothing — one ending, reached two
 * ways, rather than two endings that have to be kept agreeing with each other.
 */
export function revert(this: BookViewComponent, text: string, event: Event): void {
  const editor = event.target as HTMLElement;
  editor.textContent = text;
  editor.blur();
}

/** The live block, put to bed — for Apply, and for opening another editor. */
export function commitEditing(this: BookViewComponent): void {
  const id = this.editingId();
  if (id === null) return;
  const editor = this.host.nativeElement.querySelector('.editor') as HTMLElement | null;
  if (editor === null) {
    this.editingId.set(null);
    return;
  }
  // Through the same ending a person's own blur takes, so there is one place
  // that decides whether a text op is owed.
  editor.blur();
}

/**
 * The margin chip's list of categories.
 *
 * FIXED-POSITIONED FROM THE CHIP'S OWN RECTANGLE, which is why the event is
 * needed rather than only the id: the menu is `position: fixed` (the app's own
 * `.menu`, so the scrim can be a full-window one) and the chip is inside a
 * scrolling bench, so the only honest anchor is where the chip is at the moment
 * it is pressed.
 */
export function openCategories(this: BookViewComponent, event: MouseEvent, id: string): void {
  event.stopPropagation();
  const chip = event.currentTarget as HTMLElement;
  const box = chip.getBoundingClientRect();
  const row = this.view()?.rows.find((candidate) => candidate.id === id);
  // A chip pressed inside a multi-selection speaks for the whole selection;
  // pressed anywhere else it speaks for its own block, exactly as ever.
  const chosen = this.chosen();
  const ids = chosen.has(id) && chosen.size > 1 ? [...chosen] : [id];
  this.menu.set({ ids, category: row?.category ?? '', x: box.left, y: box.bottom + 4 });
}

/**
 * One choice, one op PER BLOCK it changes — and nothing at all for a block
 * already wearing it. One `push`, so the whole gesture lands on the stack
 * together; the ops replay per id, which is what lets seven blocks become
 * Footnote in one press without a second grammar for "several".
 */
export function relabel(this: BookViewComponent, ids: readonly string[], category: string): void {
  this.menu.set(null);
  const rows = this.view()?.rows ?? [];
  const held = new Map(rows.map((row) => [row.id, row.category] as const));
  this.push(...ids
    .filter((id) => held.has(id) && held.get(id) !== category)
    .map((id): BookOp => ({ op: 'category', id, category })));
}

// ───────────────────────────────────────────────────────────────────────────
// The structure gestures
// ───────────────────────────────────────────────────────────────────────────

/**
 * THE SEAM, PRESSED — *"the report becomes a control"* (RENDERER-DESIGN.md §4).
 *
 * The block the later page opens with goes INTO the block the earlier page ends
 * at, which is the asymmetry the op is built around: the earlier of the two
 * keeps its name, because it is the one every marker, chapter and earlier op is
 * already keyed to (`MergeOp`). The seam then stops being drawn because one of
 * its halves is no longer in the flow — nothing hides it, it simply has nothing
 * left to hang on.
 *
 * THE MOTION IS THE DOM CHANGE AND NOTHING IS BUILT FOR IT. §4 asks that the
 * blocks slide together over `--t-med`; the sheet sets no vertical margins
 * between body blocks (print convention, §2), so what actually closes is the
 * seam's own line — and animating two paragraphs into one across a re-render
 * would take a FLIP measurement pass, which is machinery this surface has been
 * told not to grow. The join reads perfectly as a still, which is §6's own
 * standard for every state here.
 */
export function join(this: BookViewComponent, before: string, into: string): void {
  // A block still live has words in it nobody has recorded; committing first is
  // what keeps the join a join rather than a join that eats an edit.
  this.commitEditing();
  this.push({ op: 'merge', id: before, into });
  this.chosen.set(new Set([into]));
}

/**
 * Ctrl+J — the same join, over two blocks somebody picked.
 *
 * ── The chord, chosen out loud ──────────────────────────────────────────────
 *
 * This app had no join key to inherit: nothing in the window binds a modifier
 * chord to anything, so there was no precedent to keep faith with and Ctrl+J is
 * a choice rather than a convention. It is the word-processor chord for exactly
 * this act, it is not a menu accelerator main swallows, and Cmd+J rides beside
 * it because a Mac hand does not reach for Ctrl.
 *
 * ── THE LATER BLOCK MERGES INTO THE EARLIER, always ─────────────────────────
 *
 * Reading order decides, not click order. A person picking two paragraphs has
 * said which two; they have not said which of them is the survivor, and the
 * grammar has an answer that does not depend on the order a hand happened to
 * click in (`MergeOp`, and `join` above).
 *
 * ── Refused with a sentence, three ways ─────────────────────────────────────
 *
 * Not two blocks; not neighbours in the flow; or one of them is a note. All
 * three go to the window's notice strip rather than being minted and left for
 * the replay to file in `missing`, because an op that lands there puts a line in
 * the margin the person cannot clear — and the third of them is the replay's own
 * refusal said before the fact rather than after it.
 */
export function joinChosen(this: BookViewComponent, event: Event): void {
  // A caret owns every key while it is in the words, and a chapter name owns
  // them while it is being typed.
  if (this.editingId() !== null || this.renaming() !== null) return;
  event.preventDefault();
  // The third of the edit gestures a keyboard can still reach in the edition,
  // and it takes the same ending Delete does: the mode, not the join. The two
  // blocks somebody picked are still picked.
  if (this.edition()) {
    this.mode.set('workbench');
    return;
  }
  const replayed = this.view();
  if (replayed === null) return;
  const picked = [...this.chosen()];
  if (picked.length !== 2) {
    this.notices.notice.set(
      'Joining is a decision about two blocks: pick the paragraph that ends and the one that '
      + 'carries on from it, then press it again.',
    );
    return;
  }
  const pair = flowNeighbours(replayed.rows, picked[0]!, picked[1]!);
  if (pair === null) {
    this.notices.notice.set(
      'Those two blocks do not sit next to each other in the book, and joining them would put '
      + 'words from either side of whatever stands between them into one paragraph.',
    );
    return;
  }
  const held = new Map(replayed.rows.map((row) => [row.id, row] as const));
  const note = [pair.earlier, pair.later].some((id) => held.get(id)?.category === 'Footnote');
  if (note) {
    this.notices.notice.set(
      'A note is one piece of apparatus, printed whole at the foot of its page. Joining one to '
      + 'anything is not a repair this program offers.',
    );
    return;
  }
  this.push({ op: 'merge', id: pair.later, into: pair.earlier });
  this.chosen.set(new Set([pair.earlier]));
}

/**
 * ENTER AT THE CARET CUTS THE PARAGRAPH IN TWO — the gesture this surface has
 * owed since the in-place editor landed.
 *
 * ── Why the words are committed first, as their own op ──────────────────────
 *
 * `SplitOp.at` is an offset into the block's text AS THE OPS BEFORE IT LEFT IT.
 * Somebody who retyped half a sentence and then put the caret in the middle of
 * what they typed is asking for a cut in the NEW words, and a split pushed on
 * its own would be measured against the old ones — the same offset, a different
 * string, a cut in the wrong place. So the text op goes first when the string
 * moved, and the split's offset is an offset into exactly what that op wrote.
 *
 * ── The offset is measured against the SOURCE STRING ────────────────────────
 *
 * The editor edits the model's source string directly — no rendering, no marker
 * cuts, `plaintext-only` — so the characters in the element are the characters
 * in the op, and `caretOffsetIn` counts them the same way `textContent` does.
 *
 * ── AND A CUT AT EITHER END IS REFUSED HERE rather than minted ──────────────
 *
 * The replay refuses a cut that would leave one half with nothing in it, and it
 * refuses it into `missing`, where the person cannot clear it. Enter at the end
 * of a paragraph is the most ordinary keystroke in any editor, so it must not be
 * a way to put a permanent line in the margin: it is answered with a sentence
 * and no op at all.
 */
export function split(this: BookViewComponent, id: string, event: Event): void {
  /*
   * ALWAYS PREVENTED, including on every refusal below. A block is prose and the
   * one thing Enter now means here is a cut, so a refused cut must not fall
   * through into `plaintext-only`'s own line break — which would leave a
   * character in the words as the trace of a gesture that did nothing.
   */
  event.preventDefault();
  if (this.editingId() !== id) return;
  const editor = event.target as HTMLElement;
  const said = editor.textContent ?? '';
  const at = caretOffsetIn(editor);
  if (at === null) {
    this.notices.notice.set(
      'A paragraph is cut where the caret is, and there are words selected rather than a caret '
      + 'in them. A cut cannot also delete what is highlighted.',
    );
    return;
  }
  if (at <= 0 || at >= said.length) {
    this.notices.notice.set(
      `The caret is at the very ${at <= 0 ? 'start' : 'end'} of this paragraph, and cutting there `
      + 'would leave one of the two halves with nothing in it.',
    );
    return;
  }
  const row = this.view()?.rows.find((candidate) => candidate.id === id);
  if (row === undefined) return;
  /*
   * THE EDITOR CLOSES BEFORE THE OPS GO ON, and it closes rather than moving:
   * the block being typed into is about to stop existing and its halves are two
   * names nobody has seen yet. `commit` guards on this signal, so the blur that
   * follows the element being taken out finds the edit already accounted for and
   * pushes nothing.
   */
  this.editingId.set(null);
  // The two halves, selected — the cut shown as two blocks rather than left for
  // the reader to find in a page of prose that looks much as it did.
  const halves = new Set([`${id}/1`, `${id}/2`]);
  /*
   * ── A CUT ON A TRANSLATED POSITION, WHERE THE WORDS MOVED TOO ─────────────
   *
   * The cut itself is an ordinary op — structure is structure in either language
   * — but the words this cut is measured against are the RECORDS' (see `commit`),
   * so the pair cannot be pushed together. The correction goes first and is
   * WAITED FOR, and the split follows only if it landed: `at` is an offset into
   * the string the person typed, so a split pushed over words the records still
   * hold would cut a different sentence at the same number.
   *
   * A correction that main refused takes the cut down with it, deliberately.
   * Half of this gesture is not a smaller version of it — it is a paragraph cut
   * in two at an offset nobody chose.
   */
  if (this.translation() !== null) {
    if (row.text === said) {
      this.push({ op: 'split', id, at });
      this.chosen.set(halves);
      return;
    }
    void this.correct(id, said).then((recorded) => {
      if (!recorded) return;
      this.push({ op: 'split', id, at });
      this.chosen.set(halves);
    });
    return;
  }
  const ops: BookOp[] = [];
  if (row.text !== said) ops.push({ op: 'text', id, text: said });
  ops.push({ op: 'split', id, at });
  this.push(...ops);
  this.chosen.set(halves);
}

/**
 * Double-click a chapter chip and type the division's name into it.
 *
 * *"Double-click the chip to rename in place"* — RENDERER-DESIGN.md §4, and it
 * is a RENAME rather than a set: the chip only exists where a division already
 * does, so there is nothing here to create. Setting a division at a block that
 * has none is the panel's gesture, because the block it would go above is the
 * one somebody has selected and that is a thing the panel can say.
 *
 * The rule is also DRAGGABLE now — `grabRule` and its family below — which
 * ends the deferral that used to be argued here (user ruling, 2026-08-16:
 * *drag the marker to where it belongs*). The panel's remove-then-set stays
 * as the keyboard-honest alternative.
 */
export function rename(this: BookViewComponent, id: string, event: Event): void {
  event.stopPropagation();
  this.commitEditing();
  this.renaming.set(id);
  /*
   * FOCUSED AFTER THE FRAME THAT DRAWS IT, for `edit`'s reason exactly: the chip
   * that can take a caret does not exist until the template has re-run, and this
   * app is zoneless, so `afterNextRender` is the only honest promise about when
   * that has happened. THE WHOLE NAME IS SELECTED rather than the caret placed —
   * the inspector's own rename box does the same, and a title is short enough
   * that replacing it is the common case.
   */
  afterNextRender(() => {
    const chip = this.host.nativeElement.querySelector('.chapter-chip.naming') as HTMLElement | null;
    if (chip === null) return;
    chip.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(chip);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, { injector: this.injector });
}

/**
 * Enter or blur commits the name — the two endings the block editor already
 * taught this surface, and Escape below is the third.
 *
 * AN EMPTY NAME IS REFUSED, and it is the one place this component declines
 * something the grammar allows. The file format accepts a division with no words
 * over it on purpose — a rule across the page is a real typographic decision —
 * but a chip with nothing on it is a chip nobody can double-click again, so
 * agreeing to it here would be building the only edit on this sheet that cannot
 * be taken back by the gesture that made it. The sentence says the other door.
 */
export function commitChapter(this: BookViewComponent, id: string, was: string, event: Event): void {
  event.preventDefault();
  if (this.renaming() !== id) return;
  const chip = event.target as HTMLElement;
  const said = (chip.textContent ?? '').trim();
  this.renaming.set(null);
  if (said === was) return;
  if (said.length === 0) {
    chip.textContent = was;
    this.notices.notice.set(
      'A chapter chip with no words on it could not be double-clicked again, so the division kept '
      + 'the name it had. Take the division away in the panel if the book should not divide there.',
    );
    return;
  }
  this.push({ op: 'chapter', rename: id, title: said });
}

/** Escape puts the name back, and the blur that follows finds nothing changed. */
export function abandonChapter(this: BookViewComponent, was: string, event: Event): void {
  const chip = event.target as HTMLElement;
  chip.textContent = was;
  chip.blur();
}
