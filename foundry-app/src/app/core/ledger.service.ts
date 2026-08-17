import { Injectable, inject, signal } from '@angular/core';

import { positionOf } from '@shared/ledger';
import { fold } from '@shared/original';
import type { LedgerStep, ProjectLedger, StepRow } from '@shared/types';

import { ConfirmService } from './confirm.service';
import { api } from './foundry';

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
   * `TabsService` hears it, and the panes showing that project read their state
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

  /** The step the pointer stands on, for a surface that wants to name it. */
  standingIn(projectDir: string | null): LedgerStep | null {
    const history = this.historyFor(projectDir);
    return history === null ? null : positionOf(history.ledger);
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
      this.put(key, { dir: projectDir, history: { ledger: view.ledger, rows: view.rows }, problem: null });
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
   * curation commit, which `TabsService` makes because it is the side holding the
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
