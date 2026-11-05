/**
 * book-view.load — bringing a book into the sheet, and waiting for one still being made.
 */
import { unwritten } from '@owen/foundry-core/shared/ops';
import { api } from '../../core/foundry';
import type { BookViewComponent } from './book-view.component';

/**
 * Ask main for the book at this project's position.
 *
 * MAIN MAY HAVE TO MAKE IT FIRST, which is why this can take seconds on a
 * project nothing has reflowed yet, and why the sheet says `Opening the book…`
 * rather than showing a spinner (RENDERER-DESIGN.md §5: no spinners on paper).
 *
 * A REFUSAL IS RENDERED VERBATIM. Main composes the sentence — it is the side
 * that knows whether this book has never been read, whether the engine refused
 * the reflow, or whether the file is in a format this build does not know — and
 * paraphrasing it here would be this pane guessing at a fact it does not have.
 * The `catch` is for the door refusing outright (a directory that is not a
 * project), which is a thing to see rather than a thing to swallow.
 */
export async function load(this: BookViewComponent, projectDir: string): Promise<void> {
  if (api === null) return;
  this.asked += 1;
  const ticket = this.asked;
  this.loading.set(true);
  this.problem.set(null);
  this.book.set(null);
  // A BOOK OPENS ON THE BENCH, ALWAYS — see `mode`. This is the whole of "not
  // persisted": there is nowhere it is written down and here is where a reload
  // puts it back.
  this.mode.set('workbench');
  // AND WITH ONE COLUMN — `alignment`'s own ruling, for `mode`'s reason. A pane
  // pointed at another step is a pane that may not be standing under a
  // translation at all, and two columns for a book with no source is a state
  // this surface must never be able to construct.
  this.alignment.set('alone');
  this.twinned.set(null);
  this.chosen.set(new Set());
  this.editingId.set(null);
  this.renaming.set(null);
  // A half-typed insert is about a block of the book being replaced, and its
  // anchor id may name a block of the NEXT book too (every reading mints
  // b1-1), so carrying it would offer the phantom above a stranger.
  this.inserting.set(null);
  this.menu.set(null);
  // Both cards, for one reason: they are about a paragraph in the book being
  // replaced, and there is no honest way to carry either into another one.
  this.dismissCards();
  /*
   * THE STACK GOES WITH THE LOAD, and it is said out loud when it held anything.
   *
   * A reload happens for two reasons and the stack must not survive either. One
   * is an Apply, where it has just been written down and the same ops are about
   * to arrive on the chain — clearing is the whole point. The other is a pointer
   * move: somebody clicked another row in Steps, and ops made against the book
   * at the row they left are a delta against a state they are no longer in. The
   * ruling is that unapplied changes are scrapped rather than carried
   * (docs/RENDERER.md §3), and carrying them here would apply somebody's strikes
   * to a document they made no decision about.
   *
   * SILENCE WOULD BE THE FAILURE. A stack that vanished with no sentence is
   * indistinguishable from a stack that was applied, so the notice strip says
   * what happened — the same strip every other "that did not do what you may
   * have expected" in this window uses.
   */
  const scrapped = this.landed ? 0 : this.waiting();
  this.landed = false;
  if (scrapped > 0) {
    this.notices.notice.set(
      scrapped === 1
        ? 'The change waiting on the book was not applied, so moving to another step let it go.'
        : `The ${scrapped} changes waiting on the book were not applied, so moving to another step `
          + 'let them go.',
    );
  }
  try {
    /*
     * THREE DOORS ONTO ONE SHEET, and which one is asked is decided here.
     *
     * A COMPARED STEP goes first, because it is the narrowest: `atStep` names a
     * row of this project's own history and `book:load-at` replays the chain to
     * it. It is tested before `viewing()` even though it turns `viewing()` on —
     * an export view is a FILE and a compared step is a POSITION in a project,
     * and the two reach entirely different books.
     *
     * AN EXPORT VIEW is a finished file exploded read-only; the position is
     * everything else, which is every ordinary open of this viewer.
     */
    const at = this.atStep();
    const loaded = at !== null
      ? await api.book.loadAt(projectDir, at)
      : this.viewing()
        ? await api.book.view(projectDir)
        : await api.book.load(projectDir);
    if (ticket !== this.asked) return;
    if (loaded.ok) {
      this.book.set(loaded);
      // The finished-book projection is the only honest register for a
      // finished file; `show` refuses to leave it while viewing.
      if (this.viewing()) this.mode.set('edition');
      /*
       * ── THE STACK HYDRATES FROM THE TIP ─────────────────────────────────
       *
       * Standing on an edit step nothing has been made from, the step's own
       * ops ARE the stack: undo pops back through what was already applied,
       * and Apply records whatever the list has become — longer, shorter, or
       * reordered — by rewriting the step (user ruling, 2026-08-16). What was
       * recorded at this load is kept beside it (`landedOps`), because "is
       * there anything to apply" stopped being "is the stack non-empty" and
       * became "does the stack differ from the disk".
       */
      const tip = loaded.tip ?? [];
      this.landedOps.set(tip);
      this.pending.set([...tip]);
      this.undone.set([]);
      /*
       * ── THE PARKED STACK COMES BACK, when it is still about this book ────
       *
       * The last incarnation of this pane may have left unwritten work with
       * the tab (see the destroy hook). It still applies only if nothing
       * moved while it was parked: the tab's revision is bumped by every
       * position change, and the recorded tip must read back as what the
       * stack grew out of. When it applies, the RESTORED lists replace the
       * hydration above wholesale — including `landedOps`, because
       * `waiting()` counts past a shared prefix by identity, and the parked
       * pending's untouched head is the PARKED landed's objects, not this
       * load's re-parsed ones. When it does not, the loss is said out loud;
       * silence here would be indistinguishable from a successful return.
       */
      const parked = this.stacks.claimBookStack(this.tab().id);
      let restored = false;
      let letGo = false;
      if (parked !== null) {
        const same = parked.revision === this.tab().revision
          && JSON.stringify(parked.landed) === JSON.stringify(tip);
        if (same) {
          this.landedOps.set(parked.landed);
          this.pending.set([...parked.pending]);
          this.undone.set([...parked.undone]);
          restored = true;
        } else if (unwritten(parked.landed, parked.pending) > 0) {
          const lost = unwritten(parked.landed, parked.pending);
          letGo = true;
          this.notices.notice.set(
            lost === 1
              ? 'The change waiting on this book was let go — the book here changed while you '
                + 'were looking at another tab.'
              : `The ${lost} changes waiting on this book were let go — the book here changed `
                + 'while you were looking at another tab.',
          );
        }
      }
      /*
       * ── AND THE SIDECAR, WHICH IS THE COPY THAT OUTLIVES THIS WINDOW ─────
       *
       * The parked stack above survives a glance at another tab; this survives
       * everything else — a close, a crash, a window somebody's host closed
       * without asking (user report, 2026-08-21, and Owen's reversal of "closing
       * without applying scraps it" the next day). It is asked for only when
       * nothing has already answered for this stack, which is what keeps the two
       * from arguing: the parked copy is at least as fresh, because parking
       * flushes to this very file on its way past.
       *
       * A LOSS THIS PANE HAS JUST ANNOUNCED CLEARS IT INSTEAD. Moving to another
       * step scraps the stack by a ruling that has not been reversed — ops are a
       * delta against the step they were made on, and carrying them would apply
       * somebody's strikes to a document they made no decision about — and the
       * notice above or the one at the top of this function has just said so.
       * Leaving the file behind after that would hold work the person has been
       * told is gone, until the next gesture silently overwrote it, which is the
       * one shape this whole feature exists to make impossible.
       *
       * A REFUSAL IS RENDERED VERBATIM and the file stays where it is. Main
       * composes it — it is the side that knows which step and which reading the
       * held stack was made against — and the commonest refusal is the useful
       * one: the work is held at ANOTHER step, and standing back on that step is
       * how somebody picks it up — so the file is LEFT WHERE IT IS on a refusal,
       * because standing back on that step has to find it there.
       *
       * NOT FOR AN EXPORT VIEW OR A COMPARED COLUMN, and the guard is
       * `viewing()` because it is the one that answers both. Neither is a
       * POSITION: the first is a file exploded read-only out of `final/` and the
       * second is a frozen row, neither has a stack, and `pendingRead` is asked
       * of a project directory — handing it an EPUB's path would be a refusal
       * about a question nobody asked.
       */
      if (this.viewing() || restored) {
        // Nothing to do. A restored stack is already answered for, and the file
        // and the parked copy are the same stack.
      } else if (letGo || scrapped > 0) {
        await this.stacks.discardPending(projectDir);
      } else {
        /*
         * ITS OWN `try`, so a sidecar that will not read cannot blank the book.
         * The outer catch turns a rejection into `problem`, which is the empty
         * sheet with a sentence on it — the right answer for a book that could
         * not be loaded and quite the wrong one for a recovery that could not
         * be offered, because the book itself is fine and is already drawn.
         */
        try {
          const held = await api.book.pendingRead(projectDir);
          if (ticket !== this.asked) return;
          if (!held.ok) {
            this.notices.notice.set(held.reason);
          } else if (held.stack !== null) {
            const back = [...tip.slice(0, held.stack.kept), ...held.stack.tail];
            this.pending.set(back);
            this.undone.set([...held.stack.undone]);
            const many = unwritten(tip, back);
            if (many > 0) {
              this.notices.notice.set(
                many === 1
                  ? 'One change you had not applied was put back on the page. Apply it to record '
                    + 'it as a step.'
                  : `${many} changes you had not applied were put back on the page. Apply them to `
                    + 'record them as a step.',
              );
            }
          }
        } catch (err) {
          this.notices.notice.set(err instanceof Error ? err.message : String(err));
        }
      }
      // Whatever branch above settled the stacks, the journal mirrors them —
      // ops as markers, corrections gone with the session they belonged to.
      this.resetJournal();
    } else {
      this.landedOps.set([]);
      this.pending.set([]);
      this.undone.set([]);
      this.resetJournal();
      this.problem.set(loaded.reason);
    }
  } catch (err) {
    if (ticket !== this.asked) return;
    this.problem.set(err instanceof Error ? err.message : String(err));
  } finally {
    if (ticket === this.asked) this.loading.set(false);
  }
}

/**
 * How many decisions stand between the paper and the disk — the tray's count,
 * the closing question's count, and the scrap notice's.
 *
 * NOT `pending().length` any more: the stack begins as a copy of the tip's
 * recorded ops, so its length counts history. What is waiting is the
 * DIFFERENCE — gestures made since the last Apply, plus applied ops undone
 * since it — measured past the shared prefix, because an undo below the
 * boundary is as much a thing to record as a new strike above it.
 */
export function waiting(this: BookViewComponent): number {
  return unwritten(this.landedOps(), this.pending());
}
