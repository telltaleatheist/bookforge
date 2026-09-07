import { Injectable, computed, inject, signal } from '@angular/core';

import { positionOf } from '@shared/ledger';
import { fold } from '@shared/original';
import { admitPending, pendingStepOf, rowMinting, withPending } from '@shared/pending';
import type { Job, LedgerStep, ProjectLedger, StepRow } from '@shared/types';

import { ConfirmService } from './confirm.service';
import { api } from './foundry';
import { QueueService } from './queue.service';

/**
 * One project's history, as this window holds it.
 *
 * `rows` IS MAIN'S ANSWER AND IS NEVER RECOMPUTED HERE. The chronological order
 * and the quiet "from Read" annotation are the whole of this design's concession
 * to the tree, and a renderer deriving them would be a second implementation of
 * the one rule that decides whether the flat list is misleading about what was
 * made from what (`chronological`, shared/ledger.ts).
 */
export interface StepHistory {
  ledger: ProjectLedger;
  rows: StepRow[];
  /**
   * THE STEP THE BOOK ON THE SHELF CAME FROM, main's `LedgerView.current`,
   * carried rather than recomputed.
   *
   * It is the answer to "which of these rows is the book I have now", which two
   * mints make a real question: both say "The pages you minted", both are true
   * forever, and only one of them is what Home opens. Main walks the
   * catalogue's pdf chain to decide it, and a renderer that worked it out from
   * dates would be a second opinion about which book somebody is looking at --
   * wrong first on exactly the delete that makes the two answers differ.
   *
   * REQUIRED, so that adding it enumerated every place a history is built
   * rather than leaving one quietly without it.
   */
  current: string | null;
}

/** What this window knows about one project's history, including "it will not read". */
interface Holding {
  /**
   * The directory AS MAIN SPELLS IT, kept beside the folded key it is stored
   * under.
   *
   * The key is folded because on Windows one path arrives spelled three ways and
   * two spellings of one project would be two holdings. What must NOT be folded is
   * what goes back over IPC: main proves the directory is one of Home's projects
   * before it reads a byte, and handing it a lowercased path is handing it a path
   * that is a project on this filesystem and a stranger to a string comparison.
   */
  dir: string;
  history: StepHistory | null;
  /**
   * Main's own sentence for a catalogue that will not parse, drawn where the rows
   * would have been.
   *
   * KEPT RATHER THAN THROWN AWAY, because a Steps section that silently drew
   * nothing for a project whose ledger is malformed would be indistinguishable
   * from a project with no history — and one of those is a book somebody needs to
   * fix a file for.
   */
  problem: string | null;
}

/**
 * The step ledger, mirrored from main — the brain behind the Steps accordion.
 *
 * A MIRROR AND NOT A STORE, exactly as `ProjectsService` and `QueueService` are.
 * Main owns the manifest, composes the rows, proves the directory on all four
 * calls and unlinks the payloads a delete names; this class holds what main last
 * said and asks again whenever something announces that a project moved. Nothing
 * here edits a step.
 *
 * ── Why it is keyed by project rather than being one current ledger ──────────
 *
 * The window shows up to five panes and they are allowed to be five different
 * books. The accordion draws the FOCUSED document's project, but the block
 * editor's read-only gate is a question about whichever tab a gesture landed in —
 * so a single "current" ledger would answer the safety question about the wrong
 * project the moment somebody has two scans open, which is the one place in this
 * app where the wrong answer means an edit written where it was not wanted.
 *
 * ── And why refreshes come from `projects:changed` ───────────────────────────
 *
 * Every ledger write in main ends with `announceProjects()` — a pointer move, a
 * delete, a curation commit, a job landing and appending its step. That is
 * already the one way anything in this window hears that a project moved, and
 * `ProjectsService` is subscribed to it for the same reason. A second channel
 * would be a second thing to remember to fire.
 */
@Injectable({ providedIn: 'root' })
export class LedgerService {
  private readonly confirm = inject(ConfirmService);
  /**
   * The queue, read for ONE question: which promises is this window standing among?
   *
   * ── Why a mirror of the ledger reads a mirror of the queue ─────────────────
   *
   * Owen, 2026-09-07: *"if i queue cleanup, i want a grayed out step to appear where
   * the item will be when it finishes … i should be able to run jobs against the
   * grayed out row."* A promised step is a POSITION — the tiles answer for it, the
   * dialogs plan under it, the tree draws its children beneath it — and this class
   * is where every surface in the window asks what the position is. Putting the
   * promise anywhere else would have meant twenty callers of `standingIn` learning
   * about a second kind of standing, and nineteen of them getting it right.
   *
   * IT IS STILL A MIRROR AND STILL STORES NOTHING. The queue rows are the record
   * (shared/pending.ts holds that argument in full); this composes them into the
   * shape a position question wants and keeps one signal of its own — WHICH promise
   * the person clicked, which is a fact about a press and exists nowhere else.
   *
   * `QueueService` DEPENDS ON NOTHING, so the arrow does not run back: it is a
   * signal set from `queue:changed` and a handful of computeds over it.
   */
  private readonly queue = inject(QueueService);

  /**
   * THE PROMISE THIS WINDOW IS STANDING ON, as the person asked for it.
   *
   * SESSION-ONLY, ONE AT A TIME, AND CLEARED BY STANDING ANYWHERE REAL — see `go`,
   * which drops it, and `standing` below, which validates it. The project rides
   * with the id on `StageService.second`'s reasoning exactly: an id alone cannot say
   * whether the wish is still about the book in front of the person.
   */
  private readonly aim = signal<{ projectDir: string; stepId: string } | null>(null);

  /**
   * THE PROMISE, VALIDATED — null unless a live queue row is still going to land it.
   *
   * ── Three clearing rules, none of which anybody has to remember ────────────
   *
   * THE ROW LANDED. `rowMinting` answers only for a row that is still going to land
   * something, so the moment the cleanup finishes this is null — and the ordinary
   * position takes over, standing on that very step, because a text pass moves the
   * pointer onto itself (`RETAINED_BESIDE_YOU`). The aim is discharged by being
   * kept: the person does not move, the row under them merely becomes real.
   *
   * THE ROW LEFT THE QUEUE. Owen's cascade — the card goes from the tree in the same
   * repaint, and this answers null rather than leaving the dialogs aimed at a step
   * nothing will ever make.
   *
   * THE PERSON STOOD SOMEWHERE ELSE. `go` clears it, because standing on a real row
   * is the gesture that means "not there any more".
   *
   * IT IS A COMPUTED FOR `StageService.secondColumn`'s REASON: a signal somebody has
   * to clear has three call sites to keep true, and derived state has none.
   */
  private readonly promise = computed<{ projectDir: string; step: LedgerStep; row: Job } | null>(() => {
    const wish = this.aim();
    if (wish === null) return null;
    const row = rowMinting(this.queue.jobs(), wish.stepId);
    if (row === null) return null;
    const step = pendingStepOf(row);
    return step === null ? null : { projectDir: wish.projectDir, step, row };
  });

  /**
   * Stand on a promise — the tree's press on a grayed card.
   *
   * NOTHING IS SENT TO MAIN, which is the whole difference from `go`. Main refuses
   * `ledger:go` to a step that does not exist and is right to: the pointer names a
   * row of a file, and a promise is not in the file. So the standing splits for as
   * long as the promise lasts — the LEDGER goes on pointing at the last real row,
   * and this window aims one step further down.
   *
   * AND THE DOCUMENT PANE DOES NOT MOVE. There is no book at a promised step —
   * nothing has made one — so there is nothing to show, and clearing the pane would
   * take away the page somebody was reading as the price of clicking a card. The
   * viewer keeps whatever it had; the tree's card is where the selection shows.
   */
  standOnPromise(projectDir: string, stepId: string): void {
    this.aim.set({ projectDir, stepId });
  }

  /**
   * Let go of the promise — a press on any card that is not one.
   *
   * CALLED RATHER THAN DERIVED, unlike the three rules above, because this one is
   * not a fact about the world: the promise is still live and still drawn, and what
   * changed is that the person is looking at something else. Only a press knows.
   */
  releasePromise(): void {
    this.aim.set(null);
  }

  /** Keyed by the folded directory, because on Windows one path arrives spelled three ways. */
  private readonly held = signal<ReadonlyMap<string, Holding>>(new Map());

  /**
   * The read this holding is waiting on, per directory — a ticket, so a slow
   * answer cannot overwrite a fast one that was asked LATER.
   *
   * ── The race this exists for, which is not hypothetical ─────────────────────
   *
   * A delete asks main to read again, and main's own `projects:changed` — fired by
   * that same delete — asks for a read too. Two calls, two round trips, and no
   * promise about which resolves first. Without a ticket the older answer is
   * allowed to land last, and the older answer is the one composed BEFORE the
   * delete: the accordion would settle showing rows for steps whose payloads have
   * just been unlinked, and it would stay that way until something else happened
   * to the project. Only the newest question's answer is ever painted.
   *
   * It doubles as the "has anybody asked at all" flag `ensure` needs, so a
   * component calling it from a repaint does not make a call per frame.
   */
  private readonly issued = new Map<string, number>();

  /**
   * A delete that took payload files off the disk, announced to whoever is
   * drawing them.
   *
   * ── Why a delete is announced and a pointer move is not ─────────────────────
   *
   * Moving the pointer is FREE: no job, no rendering, no file written. Everything
   * on screen that depends on it — the current row, the read-only gate, what a
   * Generate would say it is rendering — is derived from the ledger signal above,
   * so it repaints for nothing the instant the answer lands. Re-reading the
   * readings bank on every click would turn the one gesture in this app that is
   * genuinely instant into a spawn of the engine, which is exactly the ceremony
   * a history panel promises you it does not have.
   *
   * A DELETE IS THE OTHER THING ENTIRELY. It unlinks payloads, and an open block
   * editor is drawing a bank that may have just stopped existing. So this bumps,
   * `PositionSyncService` hears it, and the viewer showing that project reads its state
   * again — which is where they find out, with main's own sentence, that there is
   * nothing behind them any more.
   */
  readonly payloadsDestroyed = signal<{ dir: string; seq: number } | null>(null);
  private destroyedSeq = 0;

  constructor() {
    // The one channel. Main announces after its write is on the disk, so by the
    // time this asks, the answer is the state a reader would see.
    api?.projects.onChanged(() => { void this.refreshAll(); });
  }

  /**
   * This project's history, or null while nothing has read it yet.
   *
   * A GETTER OVER A SIGNAL and not a signal per project: the map is one signal, so
   * a component reading it inside a `computed` is subscribed to any change to any
   * project — which is what an accordion following the focused document actually
   * wants, and is a handful of entries rather than a per-book graph of them.
   */
  historyFor(projectDir: string | null): StepHistory | null {
    return this.holdingFor(projectDir)?.history ?? null;
  }

  /** Main's sentence for a ledger it would not read, or null. */
  problemFor(projectDir: string | null): string | null {
    return this.holdingFor(projectDir)?.problem ?? null;
  }

  /**
   * The step the window is standing on — THE PROMISE WHERE THERE IS ONE, and the
   * ledger's own pointer otherwise.
   *
   * ── Why the promise wins here, at the one function everything asks ─────────
   *
   * Because "what can be done from here" is asked of this by the tiles
   * (`canTranslateFrom` and its four siblings), by the four dialogs' own refusals,
   * by the metadata gate and by the tree's own selection highlight — and Owen's
   * ruling is that all of them must answer for the grayed card once it is clicked.
   * Returning the pointer instead would light the tiles for the step BELOW the
   * promise, which is the row the export would then be made from: the silent wrong
   * book this whole wave exists to prevent.
   *
   * A SYNTHETIC STEP IS SAFE FOR EVERY READER OF THIS, and that is measured rather
   * than assumed: the predicates read `action` and `parent` (shared/stages.ts), the
   * gates compare `action` against `'import'`, the tree compares `id`, and the
   * compare picker excludes it from a list of real rows — which it is not in, so it
   * offers all of them, which is right. Nothing reads `payload`, which is the one
   * field a promise cannot have.
   *
   * IT IS THE POSITION FOR EVERY PROJECT BUT THE ONE AIMED AT, so a window standing
   * on a promise in one book answers ordinarily about every other.
   */
  standingIn(projectDir: string | null): LedgerStep | null {
    const promise = this.promise();
    if (promise !== null && projectDir !== null && fold(promise.projectDir) === fold(projectDir)) {
      return promise.step;
    }
    const history = this.historyFor(projectDir);
    return history === null ? null : positionOf(history.ledger);
  }

  /**
   * THE ROW BEHIND THE PROMISE the window is standing on in this project, or null.
   *
   * What a HOST ACT has to name to chain onto (`HostInvokeContext.pendingRow` is
   * composed in main, but the tree needs the same fact to know it is ordering from a
   * promise at all), and what the "Runs after …" wording on a dimmed tile is spelled
   * from. Kept beside `standingIn` rather than folded into it because they are two
   * questions — where am I, and what am I waiting for — and `Standing`
   * (shared/pending.ts) argues why they must not be read apart.
   */
  promiseIn(projectDir: string | null): Job | null {
    const promise = this.promise();
    if (promise === null || projectDir === null) return null;
    return fold(promise.projectDir) === fold(projectDir) ? promise.row : null;
  }

  /**
   * WHAT A PLAN ORDERED IN THIS PROJECT SHOULD BE AIMED AT — the `from` argument of
   * the four plan doors, and undefined for the ordinary press.
   *
   * ── It is sent for a promise and for nothing else ──────────────────────────
   *
   * A press on a LANDED card already moves the pointer (`stand`, the tree), so the
   * position and the aim are the same row and a second mechanism saying so would be
   * a second thing that can disagree. Every press this app had before this wave
   * therefore reaches main exactly as it did, and `from` appears on the wire in one
   * shape only: the one where the pointer could not follow.
   */
  aimedAt(projectDir: string | null): string | undefined {
    return this.promiseIn(projectDir)?.mints;
  }

  /**
   * EVERY LIVE PROMISE ABOUT THIS BOOK, in queue order, with the orphans dropped —
   * the rows the tree draws grayed and the walks walk through.
   *
   * BY THE PRODUCT'S PATH, whole path against whole path with the separator
   * appended: this codebase's oldest house rule, and it matters because the queue is
   * one global list across every book on the machine.
   */
  promisesIn(projectDir: string | null): Job[] {
    const history = this.historyFor(projectDir);
    if (projectDir === null) return [];
    const root = fold(projectDir);
    const mine = this.queue.jobs().filter((job) => fold(job.outputPath).startsWith(`${root}/`));
    return admitPending(history?.ledger ?? null, mine);
  }

  /**
   * THE LEDGER WITH THIS BOOK'S PROMISES IN IT — what every `…InEffect` walk in the
   * renderer should be asked of.
   *
   * ── Why the composition and not an extra parameter on five walks ───────────
   *
   * `withPending` carries the argument (shared/pending.ts): the walks resolve a
   * parent by looking it up in `ledger.steps`, so a ledger that HOLDS the promises
   * makes every one of them answer through a promised chain with no signature
   * changed and no call site taught anything. The alternative was threading an
   * `extra` argument through five exported functions and their callers, which is
   * five chances to pass it in four places.
   *
   * WHAT IT FIXES ON THIS SIDE is small and sharp: the Export dialog asks whether a
   * translation is in effect, and the Translate dialog asks which language the
   * source is in. Standing on a promised cleanup, both walk THROUGH it to the
   * translation above and answer as they would once it lands — which is the same
   * answer main will give when it re-plans, and the point of composing the ledger in
   * one place on each side.
   *
   * NULL WHILE THE HISTORY IS IN FLIGHT, exactly as `historyFor` is: a promise
   * hanging off a ledger this window has not read is not drawn and not walked.
   */
  ledgerIn(projectDir: string | null): ProjectLedger | null {
    const history = this.historyFor(projectDir);
    if (history === null) return null;
    const steps = this.promisesIn(projectDir)
      .map(pendingStepOf)
      .filter((step): step is LedgerStep => step !== null);
    return withPending(history.ledger, steps);
  }

  /*
   * `lockIn` STOOD HERE and is deleted with the thing it guarded.
   *
   * It answered whether the block editor had to be read-only, because standing on
   * a frozen save meant an edit would land in the LIVE curation instead and the
   * person would be correcting a book they were not looking at. There are no two
   * curations to diverge any more: standing on any step is a replay of that chain
   * (docs/RENDERER.md §3), editing from an old step branches, and there is
   * therefore nothing to guard.
   */

  /**
   * Read this project's history if nobody has yet — the call every surface makes
   * before it draws.
   *
   * IDEMPOTENT AND SILENT. It runs from a repaint (the accordion following the
   * focused document, the block editor opening), so it must be safe to call on
   * every frame: a directory already held or already in flight is a no-op, and a
   * refusal is kept as the holding's `problem` rather than thrown at a template.
   */
  ensure(projectDir: string | null): void {
    if (projectDir === null || this.issued.has(fold(projectDir))) return;
    void this.refresh(projectDir);
  }

  /** Ask main again. The answer replaces whatever was here, refusal included. */
  async refresh(projectDir: string): Promise<void> {
    if (!api) return;
    const key = fold(projectDir);
    const ticket = (this.issued.get(key) ?? 0) + 1;
    this.issued.set(key, ticket);
    try {
      const view = await api.ledger.read(projectDir);
      if (this.issued.get(key) !== ticket) return;
      /*
       * NULL MEANS THE PROJECT IS GONE, and gone is not a problem to display —
       * there is no row on Home to agree with and no tabs left to draw it (a
       * delete refuses while any are open). The holding leaves entirely, ticket
       * included, so the next `projects:changed` does not ask main about a
       * directory that stopped existing. Without this, a deleted project's
       * holding survived here forever and every announce for the rest of the
       * session re-asked its ledger — an ENOENT in the console each time, timed
       * exactly when a person is watching one because they just deleted a book.
       */
      if (view === null) {
        this.issued.delete(key);
        const held = new Map(this.held());
        held.delete(key);
        this.held.set(held);
        return;
      }
      this.put(key, {
        dir: projectDir,
        history: { ledger: view.ledger, rows: view.rows, current: view.current },
        problem: null,
      });
    } catch (err) {
      if (this.issued.get(key) !== ticket) return;
      // Main's words, kept as main wrote them. The accordion prints this where the
      // rows would have been — the same refusal that is already on the project's
      // row on Home, reaching the same person a second way.
      this.put(key, {
        dir: projectDir,
        history: null,
        problem: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stand on a different step — the click on a row.
   *
   * FREE, INSTANT AND UNCONFIRMED, which is the promise a history panel makes by
   * looking like one. One line of the manifest; no job, no rendering, no
   * confirmation and no spinner.
   *
   * THE WHOLE ANSWER IS PAINTED AND NOTHING IS ASKED AGAIN. Main hands back the
   * ledger AND the rows it composed for it, which is what makes this one round
   * trip: the rows are main's to compose (`chronological`), and a renderer that
   * had only the ledger would have to ask a second time and paint an answer
   * describing a catalogue a moment later than the one it acted on.
   *
   * A refusal throws with main's sentence: the caller clicked a row this app drew,
   * so an id main does not hold means the two are looking at different ledgers,
   * and standing somewhere plausible instead would show somebody a book they did
   * not ask for.
   */
  async go(projectDir: string, stepId: string): Promise<void> {
    if (!api) return;
    /*
     * AND IT LETS GO OF THE PROMISE, because standing on a real row is the gesture
     * that means "not there any more". Before the await rather than after: the
     * pointer is what this window is about to be standing on, and leaving the aim up
     * for a round trip would mean the tiles answering for the promise while the
     * position moved out from under them.
     */
    this.releasePromise();
    this.paint(projectDir, await api.ledger.go(projectDir, stepId));
  }

  /**
   * Which document belongs on screen at this project's position — main's answer,
   * passed through and never derived.
   *
   * ── Why this is not composed from the ledger this class already holds ───────
   *
   * Because the ledger says `readings/<key>.jsonl` and `generated/<book> (en).epub`
   * — project-RELATIVE payloads — and turning one of those into a file a viewer can
   * open means knowing which layer a project keeps its live copy of a thing in, and
   * which of two readings a reprint came from. Those are facts about a folder, main
   * owns the folder, and a renderer that composed them would be a second opinion
   * that goes wrong exactly where it is most expensive: a branch read answering
   * with the original reading's file.
   *
   * NOT HELD, NOT CACHED, NOT A SIGNAL. Everything else here is a mirror of the
   * catalogue because several surfaces read it on every repaint; this is asked once
   * per pointer move by the one surface that acts on it, and a copy kept between
   * moves would be a path that has since been rotated aside.
   *
   * NULL FOR EVERY REFUSAL. A catalogue that will not parse is already a sentence
   * on the project's row on Home and in the accordion; a pointer move is not the
   * place to say it a third time, and there is nothing useful the caller could do
   * with the news anyway.
   */
  async documentAt(projectDir: string): Promise<string | null> {
    if (!api) return null;
    return await api.ledger.documentAt(projectDir).catch(() => null);
  }

  /**
   * The ✕ on a row: ask main what it costs, ask the user in the app's own card,
   * then do it.
   *
   * THREE STEPS AND MAIN OWNS TWO OF THEM — the shape `ProjectsService.remove`
   * established and for its reason. `describeDelete` composes the facts AND proves
   * the delete is allowed, so a card is never put on screen for something that
   * would be refused a click later; the card is ours because a question about a
   * book should look like it came from the program the book is in; `delete` proves
   * it again and destroys the payloads.
   *
   * Resolves true when it ran, false for a cancel — a cancel is silence. A refusal
   * throws with main's own sentence, which the caller shows as written.
   */
  async remove(
    projectDir: string,
    stepId: string,
    /**
     * Let go of the books this delete is about to erase — the document delete's
     * shape, and its reason (`ProjectsService.removeDocument`).
     *
     * BETWEEN THE YES AND THE DELETE, which is why it is a callback rather than
     * two lines around this call. Closing first would shut a book the user is
     * about to decline to delete; closing after would hand main a working tree
     * this window still has files open in, and on Windows the remove fails part
     * way and leaves half an unpacked book behind. Main refuses that case by name
     * — this is what keeps the refusal from being the ordinary outcome of saying
     * yes.
     */
    closeThem?: (files: readonly string[]) => void | Promise<void>,
  ): Promise<boolean> {
    if (!api) return false;
    const deletion = await api.ledger.describeDelete(projectDir, stepId);
    const casualties = deletion.casualties;
    const named = casualties.map((one) => `“${one.label}”`).join(', ');
    const answered = await this.confirm.ask({
      message: casualties.length > 1
        ? `Delete “${deletion.label}” and everything made from it?`
        : `Delete “${deletion.label}”?`,
      detail: [
        // THE CASCADE IS NAMED BEFORE THE COSTS, because the number is the
        // surprise. Somebody deleting a reading is deleting the translations made
        // from it, and the only version of that which is not a shock is the one
        // where they read the list first.
        ...(casualties.length > 1
          ? [`This takes ${casualties.length} steps with it, because each of them was made from `
            + `another: ${named}.`]
          : []),
        // Main's sentences, verbatim and in creation order. Every one of them says
        // what THIS loss is in the retention rule's own terms — user labour that no
        // run remakes, or a payload that costs a paid run to get back — because an
        // "Are you sure?" over a list of four teaches somebody to click through the
        // one that was about their curation.
        ...casualties.map((one) => one.cost),
        // WHAT GOES WITH THEM, when anything does. A payload does not travel
        // alone — a translation's EPUB has a working copy unpacked from it and an
        // undo history written against that — and all of it is swept, so all of it
        // is named here first. Main composes the sentence, because main is the
        // only side that knows what is actually on the disk.
        ...(deletion.belongings === null ? [] : [deletion.belongings]),
        'It really deletes: nothing is moved aside and there is no copy anywhere else.',
      ],
      confirm: casualties.length > 1 ? `Delete these ${casualties.length} steps` : 'Delete this step',
    });
    if (!answered) return false;
    // AWAITED, or the callback does not do the job it exists for: closing a tab
    // flushes a pending edit and tells main to let go of the unpack, both of which
    // take a turn of the loop, and a fire-and-forget close would hand the delete a
    // window that has not finished letting go.
    await closeThem?.(deletion.files);
    /*
     * PAINTED FROM THE ANSWER, because the answer is the whole answer: main hands
     * back the ledger AND the rows it composed for what is left. This used to ask
     * again, and had to — a delete CHANGES THE SHAPE of the list, and rows are
     * main's to compose, so the answer's ledger against the rows this window was
     * holding would have drawn rows for steps that no longer exist, complete with
     * ✕ buttons for them.
     */
    this.paint(projectDir, await api.ledger.delete(projectDir, stepId));
    this.destroyedSeq += 1;
    this.payloadsDestroyed.set({ dir: projectDir, seq: this.destroyedSeq });
    return true;
  }

  /**
   * A history that arrived from somewhere other than this class — the answer to a
   * curation commit, which the renderer makes because it is the side holding the
   * document's path.
   *
   * ONE ANSWER, PAINTED WHOLE. It used to paint and then re-read, because a commit
   * mints a step and the ROWS are main's to compose, so the ledger alone would
   * have left the accordion a turn behind its own new row. Main now hands back
   * both, and the gesture and what is on screen are the same statement.
   */
  adopt(projectDir: string, history: StepHistory): void {
    this.paint(projectDir, history);
  }

  // ── Keeping the map ──────────────────────────────────────────────────────

  private holdingFor(projectDir: string | null): Holding | null {
    return projectDir === null ? null : this.held().get(fold(projectDir)) ?? null;
  }

  /**
   * Main's answer to something this window just did, put where the accordion
   * reads it.
   *
   * IT REPLACES A `problem` TOO. A holding that was a refusal a moment ago and has
   * just answered a `go` or a commit is a project this window can read after all —
   * leaving the sentence up beside a list that is demonstrably being served would
   * be the accordion arguing with itself.
   *
   * The unfolded directory is kept as main spells it, which is what every call
   * back to main is made with. The argument is already that spelling: every caller
   * has it from the project summary main sent.
   */
  private paint(projectDir: string, history: StepHistory): void {
    const key = fold(projectDir);
    this.put(key, { dir: this.held().get(key)?.dir ?? projectDir, history, problem: null });
  }

  private put(key: string, holding: Holding): void {
    this.held.update((map) => new Map(map).set(key, holding));
  }

  /**
   * Everything this window is holding, asked again.
   *
   * ONLY WHAT IS ALREADY HELD, never a walk of the library: this fires whenever
   * any project in the app changes, and reading the history of every book on the
   * disk because one of them moved would be a directory walk per landed job.
   */
  private async refreshAll(): Promise<void> {
    await Promise.all([...this.held().values()].map((holding) => this.refresh(holding.dir)));
  }
}
