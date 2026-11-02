import { Injectable, computed, inject, signal } from '@angular/core';

import {
  askRowStates,
  askViewOf,
  planLanding,
  planUndo,
  type AskHighlight,
  type AskMark,
  type AskPlan,
  type AskProgress,
  type AskRowState,
  type AskSession,
  type AskSkip,
  type AskThread,
} from '@shared/ask';
import type { Replayed } from '@shared/ops';
import { AskChain, DEFAULT_CHECKED, askPresetsOrDefaults, type AskChainStep, type AskPreset, type AskPresetsKept, type AskStepEnd } from '@shared/ask-presets';

import { BookStacksService, type BookStack } from './book-stacks.service';
import { NoticeService } from './notice.service';
import type { Tab } from './documents.service';
import { api } from './foundry';

/**
 * ASK THE DOCUMENT, on this side of the wall — one run per book, and what it
 * came to.
 *
 * ── WHY A SERVICE AND NOT THE PANEL ────────────────────────────────────────
 *
 * A run is minutes of a model's work, and the inspector section that started it
 * is destroyed every time the person glances at another tab. The run's state
 * belongs to the BOOK (its project directory), so it is held here, keyed by
 * project, and the panel only draws it. The frames arrive on `ask:progress`
 * whichever panel is mounted.
 *
 * ── THE LANDING IS HERE, AND IT IS THE PANE'S OWN DOORS ────────────────────
 *
 * Main hands back marks, never ops it has written: the pending stack is the
 * pane's (book-view.component.ts owns it and its sidecar). So when a run is
 * done this plans the marks against the book AS IT STANDS NOW (`planLanding`:
 * a block the person changed while the model worked is theirs and is skipped),
 * and lands them through the same two doors every outside surface takes —
 * `pushGroup` for the ops, as ONE undo, and `correct` for the words of a
 * translated pass, one at a time, which is that door's own rule.
 *
 * THE SESSION IS WRITTEN AFTER THE LANDING, holding only what landed, so the
 * review card never offers to undo something that was never done.
 *
 * THE THREAD IS MAIN'S. Main reads the book's note when a run starts and writes
 * the next one when it ends (electron/ask-document.ts, `AskThread`); this only
 * holds the copy the panel draws, and ends the thread on "New question".
 */
@Injectable({ providedIn: 'root' })
export class AskService {
  private readonly stacks = inject(BookStacksService);
  private readonly notices = inject(NoticeService);

  /** Each book's run, by project directory. A book with no entry has never been asked here. */
  readonly runs = signal<ReadonlyMap<string, AskRunState>>(new Map());
  /** Each book's latest kept session, by project directory; null is "read, and there is none". */
  readonly latest = signal<ReadonlyMap<string, AskSession | null>>(new Map());
  /**
   * Each book's kept sessions, oldest first: the conversation the panel draws.
   * The model does not read them. What it carries from one question to the next
   * is only its own note (`threads`), and only until "New question" — Owen's
   * earlier *"one request per chat window, so the previous request's context
   * doesnt leak"* still holds across a New question, which is the window's edge.
   */
  readonly history = signal<ReadonlyMap<string, readonly AskSession[]>>(new Map());

  /** Each book's live thread, by project directory; null is "read, and there is none". */
  readonly threads = signal<ReadonlyMap<string, AskThread | null>>(new Map());

  /**
   * "New question" — by project, the time before which the thread is not drawn.
   * The sessions stay in the project, and the review card still reads the
   * latest one; what is removed is the model's note, so it forgets.
   */
  readonly clearedAt = signal<ReadonlyMap<string, number>>(new Map());

  async newChat(projectDir: string): Promise<void> {
    this.clearedAt.update((held) => new Map(held).set(projectDir, Date.now()));
    if (!api) return;
    try {
      await api.ask.endThread(projectDir);
      this.setThread(projectDir, null);
    } catch (err) {
      this.notices.notice.set(`The model's note could not be removed, so your next question would still continue the old one: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Which tab each run was started from, so the landing finds its pane. */
  private readonly tabOf = new Map<string, string>();

  // ── The presets ────────────────────────────────────────────────────────────

  /** What the settings hold (undefined until read). */
  private readonly keptPresets = signal<AskPresetsKept | undefined>(undefined);
  /** The modal's list — what is kept, or the shipped defaults. Its order is the run order. */
  readonly presets = computed<readonly AskPreset[]>(() => askPresetsOrDefaults(this.keptPresets()?.presets ?? null));
  /** Which were checked when Send was last pressed, or the defaults. */
  readonly checkedPresets = computed<ReadonlySet<string>>(() => new Set(this.keptPresets()?.checked ?? DEFAULT_CHECKED));

  async loadPresets(): Promise<void> {
    if (!api || this.keptPresets() !== undefined) return;
    try {
      this.keptPresets.set(await api.ask.presets());
    } catch (err) {
      this.keptPresets.set({ presets: null, checked: null });
      this.notices.notice.set(`Ask's presets could not be read, so the defaults are shown: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Keep the list (null restores the defaults) and/or which are checked. */
  async savePresets(patch: { presets?: readonly AskPreset[] | null; checked?: readonly string[] }): Promise<void> {
    if (!api) return;
    try {
      this.keptPresets.set(await api.ask.savePresets({
        ...(patch.presets === undefined ? {} : { presets: patch.presets === null ? null : [...patch.presets] }),
        ...(patch.checked === undefined ? {} : { checked: [...patch.checked] }),
      }));
    } catch (err) {
      this.notices.notice.set(`Ask's presets could not be saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * WHAT THE PRESETS MODAL SENDS WITH — the Ask panel's model choice, whether it
   * is ready, whether a run is going, and the box's text ("Add preset" starts
   * from it). The panel keeps it current; the modal only reads it.
   */
  readonly presetContext = signal<{
    readonly server: string | null;
    readonly model: string;
    readonly ready: boolean;
    readonly busy: boolean;
    readonly draft: string;
  } | null>(null);

  // ── Running the checked presets ────────────────────────────────────────────

  /**
   * EACH BOOK'S DO ALL, while it runs — the sequence (`AskChain`, pure) and
   * what its next step needs to start: the tab, the server, the model. The
   * next step is started from `heard`, AFTER the step's marks have landed on
   * the pane, so it reads the book with them pending on it.
   */
  private readonly chainsByBook = new Map<string, { chain: AskChain; tab: Tab; server: string | null; model: string }>();
  /** "Presets: step 2 of 3 — Front & back matter", by book, while a chain runs. */
  readonly chainSaid = signal<ReadonlyMap<string, string>>(new Map());
  /** The sentence each book's last chain of presets ended on, until the next one starts. */
  readonly chainOver = signal<ReadonlyMap<string, string>>(new Map());

  /**
   * SEND FROM THE PRESETS MODAL: the checked presets, in the list's order, each
   * its own run on the book's thread. One is simply one run; two or more are a
   * chain, labelled in the panel and in review.
   */
  async runPresets(tab: Tab, pane: BookStack, steps: readonly AskPreset[], server: string | null, model: string): Promise<void> {
    if (steps.length === 0) return;
    if (steps.length === 1) {
      await this.start(tab, pane, steps[0]!.question, server, model);
      return;
    }
    const chain = new AskChain(`chain-${Date.now().toString(36)}`, steps);
    this.chainsByBook.set(tab.path, { chain, tab, server, model });
    this.chainOver.update((held) => { const next = new Map(held); next.delete(tab.path); return next; });
    const first = chain.current()!;
    this.sayChain(tab.path);
    await this.start(tab, pane, first.preset.question, server, model, first.step);
  }

  private sayChain(projectDir: string): void {
    const held = this.chainsByBook.get(projectDir);
    const said = held?.chain.said() ?? null;
    this.chainSaid.update((map) => {
      const next = new Map(map);
      if (said === null) next.delete(projectDir);
      else next.set(projectDir, said);
      return next;
    });
  }

  /** A step of the book's chain ended (after its landing): start the next, or close the chain with its sentence. */
  private async stepEnded(projectDir: string, end: AskStepEnd): Promise<void> {
    const held = this.chainsByBook.get(projectDir);
    if (held === undefined) return;
    const after = held.chain.ended(end);
    if ('over' in after) {
      this.chainsByBook.delete(projectDir);
      this.sayChain(projectDir);
      this.chainOver.update((map) => new Map(map).set(projectDir, after.over));
      return;
    }
    this.sayChain(projectDir);
    const pane = this.stacks.bookStackFor(held.tab.id);
    if (pane === null) {
      await this.stepEnded(projectDir, { state: 'failed', message: 'The book was closed, so the next step had nothing to work on.' });
      return;
    }
    await this.start(held.tab, pane, after.next.preset.question, held.server, held.model, after.next.step);
  }

  /**
   * THE PLACE THE PERSON CLICKED in a run's "Found N places" list — lit on its
   * book's paper (book-view's `hitLight`, the analysis light's own runs) until
   * another is clicked or the same one is clicked again. Keyed
   * `ask:<session>:<index>`, which is never an analysis finding's key.
   */
  readonly pointed = signal<{ readonly projectDir: string; readonly key: string; readonly highlight: AskHighlight } | null>(null);

  /** Light a place and bring it into view, or put it down when it is already lit. */
  point(tabId: string, projectDir: string, key: string, highlight: AskHighlight): void {
    const now = this.pointed();
    if (now !== null && now.key === key && now.projectDir === projectDir) {
      this.pointed.set(null);
      return;
    }
    this.pointed.set({ projectDir, key, highlight });
    this.stacks.bookStackFor(tabId)?.reveal(highlight.id);
  }

  constructor() {
    api?.ask.onProgress((frame) => { void this.heard(frame); });
  }

  runFor(projectDir: string): AskRunState | null {
    return this.runs().get(projectDir) ?? null;
  }

  /** The sessions, read from the project once per book and kept current after. */
  async loadLatest(projectDir: string): Promise<void> {
    if (!api || this.latest().has(projectDir)) return;
    try {
      const all = await api.ask.sessions(projectDir);
      this.history.update((held) => new Map(held).set(projectDir, all));
      this.setLatest(projectDir, all.at(-1) ?? null);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
    // Apart from the sessions: a thread that cannot be read says so, and the review list is still drawn.
    try {
      this.setThread(projectDir, await api.ask.thread(projectDir));
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** Ask. The view is the pane's own replay, read at this instant. */
  async start(tab: Tab, pane: BookStack, request: string, server: string | null, model: string, chain?: AskChainStep): Promise<void> {
    if (!api) return;
    // A book tab's path IS its project directory (`Tab.path`).
    const projectDir = tab.path;
    const book = pane.view();
    if (book === null) {
      this.setRun(projectDir, failed('The book is still opening; ask again once it is on the page.', request));
      if (chain !== undefined) await this.stepEnded(projectDir, { state: 'failed', message: 'the book was still opening.' });
      return;
    }
    const view = askViewOf(book, tab.title);
    this.setRun(projectDir, {
      phase: 'running', runId: null, request, status: 'Starting…', round: 0, maxRounds: 0,
      says: null, struck: 0, revised: 0, retyped: 0, tally: '', message: null, steps: [], startedAt: Date.now(),
      ...(chain === undefined ? {} : { chain }),
    });
    try {
      const runId = await api.ask.start({ projectDir, request, server, model, view });
      this.tabOf.set(runId, tab.id);
      const now = this.runFor(projectDir);
      if (now !== null && now.runId === null && now.phase === 'running') this.setRun(projectDir, { ...now, runId });
      await api.crucible.rememberJobModel('ask', model);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setRun(projectDir, failed(message, request));
      if (chain !== undefined) await this.stepEnded(projectDir, { state: 'failed', message });
    }
  }

  async cancel(projectDir: string): Promise<void> {
    // One Stop stops the whole chain: the running step, and every step after it.
    this.chainsByBook.get(projectDir)?.chain.cancel();
    const run = this.runFor(projectDir);
    if (!api || run === null || run.runId === null) return;
    await api.ask.cancel(run.runId);
  }

  private async heard(frame: AskProgress): Promise<void> {
    const run = this.runFor(frame.projectDir);
    // A frame for a run this window did not start (or has forgotten) is not drawn.
    if (run === null || (run.runId !== null && run.runId !== frame.runId)) return;
    if (frame.state === 'running') {
      this.setRun(frame.projectDir, {
        ...run, runId: frame.runId, status: frame.status, round: frame.round, maxRounds: frame.maxRounds,
        says: frame.says, struck: frame.struck, revised: frame.revised, retyped: frame.retyped, tally: frame.tally,
        steps: withStep(run.steps, frame, run.says),
      });
      return;
    }
    const tabId = this.tabOf.get(frame.runId);
    this.tabOf.delete(frame.runId);
    if (frame.state !== 'done') {
      this.setRun(frame.projectDir, { ...run, phase: frame.state, message: frame.message });
      if (run.chain !== undefined) await this.stepEnded(frame.projectDir, { state: frame.state, message: frame.message });
      return;
    }
    const pane = tabId === undefined ? null : this.stacks.bookStackFor(tabId);
    const book = pane?.view() ?? null;
    if (pane === null || book === null) {
      const message = 'The book was closed before the model finished, so nothing it marked was put on it.';
      this.setRun(frame.projectDir, { ...run, phase: 'failed', message });
      if (run.chain !== undefined) await this.stepEnded(frame.projectDir, { state: 'failed', message });
      return;
    }
    this.setRun(frame.projectDir, { ...run, phase: 'landing', status: 'Putting the changes on the book…' });
    const result = frame.result;
    const plan = planLanding(result.items, rowStates(book), pane.translated());
    const landed = await land(pane, plan, `Ask's ${saidChanges(plan.acted.length)} for "${clip(run.request, 60)}"`);
    const session: AskSession = {
      id: frame.runId,
      at: new Date().toISOString(),
      request: run.request,
      server: result.server,
      model: result.model,
      summary: result.summary,
      items: landed.acted,
      highlights: result.highlights,
      hitLimit: result.hitLimit,
      ...(run.chain === undefined ? {} : { chain: run.chain }),
      skipped: plan.skipped.length + landed.refused,
      rounds: result.rounds,
      seconds: result.seconds,
    };
    let kept: string | null = null;
    if (api) {
      try {
        await api.ask.saveSession(frame.projectDir, session);
      } catch (err) {
        kept = `The review list could not be kept for after a reload: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.setLatest(frame.projectDir, session);
    this.setThread(frame.projectDir, result.thread);
    this.history.update((held) => new Map(held).set(frame.projectDir, [...(held.get(frame.projectDir) ?? []), session]));
    const said = [
      landed.acted.length === 0
        ? 'The model marked nothing.'
        : `${saidChanges(landed.acted.length)} ${landed.acted.length === 1 ? 'is' : 'are'} waiting with your other edits; one undo takes ${landed.acted.length === 1 ? 'it' : 'them all'} back.`,
      skippedSentence(plan.skipped),
      landed.refused > 0 ? `${saidBlocks(landed.refused)} would not take the correction, and each one said why.` : '',
      result.highlights.length > 0
        ? `It pointed at ${result.highlights.length} ${result.highlights.length === 1 ? 'place' : 'places'}, listed under its reply.` : '',
      result.hitLimit ? `It stopped at its limit of ${result.rounds - 1} rounds before it finished; Keep going picks up where it left off.` : '',
      kept ?? '',
      result.threadProblem ?? '',
    ].filter((s) => s.length > 0).join(' ');
    this.setRun(frame.projectDir, { ...run, phase: 'done', message: said });
    // The marks are on the pane now, so the chain's next step reads them.
    if (run.chain !== undefined) await this.stepEnded(frame.projectDir, { state: 'done' });
  }

  /**
   * UNDO THE CHOSEN MARKS of the latest session — the review card's one verb.
   * Returns the sentence for the notice.
   */
  async undo(projectDir: string, pane: BookStack, items: readonly AskMark[]): Promise<string> {
    const book = pane.view();
    if (book === null) return 'The book is still opening; nothing was undone.';
    const plan = planUndo(items, rowStates(book), pane.translated());
    const landed = await land(pane, plan, `undoing ${saidChanges(plan.acted.length)} Ask made`);
    return [
      landed.acted.length === 0 ? 'Nothing was undone.' : `Undid ${saidChanges(landed.acted.length)}; they wait with your other edits.`,
      skippedSentence(plan.skipped),
      landed.refused > 0 ? `${saidBlocks(landed.refused)} would not take the correction, and each one said why.` : '',
    ].filter((s) => s.length > 0).join(' ');
  }

  private setRun(projectDir: string, state: AskRunState): void {
    this.runs.update((held) => new Map(held).set(projectDir, state));
  }

  private setThread(projectDir: string, thread: AskThread | null): void {
    this.threads.update((held) => new Map(held).set(projectDir, thread));
  }

  private setLatest(projectDir: string, session: AskSession | null): void {
    this.latest.update((held) => new Map(held).set(projectDir, session));
  }
}

/** One book's run as the panel draws it. */
export interface AskRunState {
  readonly phase: 'running' | 'landing' | 'done' | 'failed' | 'cancelled';
  /** Null between the press and main's answer. */
  readonly runId: string | null;
  readonly request: string;
  readonly status: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly says: string | null;
  readonly struck: number;
  readonly revised: number;
  readonly retyped: number;
  /** Everything the run holds so far, as a line — main's `tallySaid`. Empty before the first round. */
  readonly tally: string;
  /** The closing sentence: what landed, or why nothing did. */
  readonly message: string | null;
  /** What the model did, round by round, for the thread's "Working" line. */
  readonly steps: readonly AskStep[];
  /** When Send was pressed, for "worked for 3m 20s". */
  readonly startedAt: number;
  /** Which step of a chain of presets this run is. Absent on an ordinary question. */
  readonly chain?: AskChainStep;
}

/** One line of a run's working: what happened, and what the model said, if it said something new. */
export interface AskStep {
  readonly status: string;
  readonly says: string | null;
}

/**
 * A FRAME AS A STEP. Main sends two frames a round: "waiting for the model",
 * which is a wait and not a step, and the round's outcome (its tool calls and
 * the counts), which is. The model's prose is carried only when it changed,
 * because main repeats the last thing it said on every frame after.
 */
function withStep(steps: readonly AskStep[], frame: Extract<AskProgress, { state: 'running' }>, saidBefore: string | null): readonly AskStep[] {
  if (/waiting for|asking .* for its summary/i.test(frame.status)) return steps;
  const says = frame.says !== null && frame.says !== saidBefore ? frame.says : null;
  const last = steps.at(-1);
  if (last !== undefined && last.status === frame.status && says === null) return steps;
  return [...steps, { status: frame.status, says }];
}

function failed(message: string, request: string): AskRunState {
  return {
    phase: 'failed', runId: null, request, status: '', round: 0, maxRounds: 0,
    says: null, struck: 0, revised: 0, retyped: 0, tally: '', message, steps: [], startedAt: Date.now(),
  };
}

function rowStates(book: Replayed): ReadonlyMap<string, AskRowState> {
  return askRowStates(book.rows, book.chapters);
}

/**
 * A PLAN, LANDED: the corrections first, one at a time (the translated door's
 * rule: two in flight are two whole-file rewrites racing), then every op as one
 * gesture. A refused correction is counted out of what landed, never reported
 * as done.
 */
async function land(pane: BookStack, plan: AskPlan, what: string): Promise<{ acted: AskMark[]; refused: number }> {
  const refusedIds = new Set<string>();
  for (const one of plan.corrections) {
    if (!await pane.correct(one.id, one.text)) refusedIds.add(one.id);
  }
  if (plan.ops.length > 0) pane.pushGroup(what, plan.ops);
  const acted = plan.acted.filter((item) => !(item.kind === 'text' && refusedIds.has(item.id)));
  return { acted, refused: refusedIds.size };
}

function skippedSentence(skipped: readonly AskSkip[]): string {
  if (skipped.length === 0) return '';
  const whys = new Map<string, number>();
  for (const skip of skipped) whys.set(skip.why, (whys.get(skip.why) ?? 0) + 1);
  const said = [...whys.entries()].map(([why, n]) => `${n} because ${why}`).join(', ');
  return `${saidChanges(skipped.length)} ${skipped.length === 1 ? 'was' : 'were'} left alone, ${said}.`;
}

function saidChanges(many: number): string {
  return `${many} ${many === 1 ? 'change' : 'changes'}`;
}

function saidBlocks(many: number): string {
  return `${many} ${many === 1 ? 'block' : 'blocks'}`;
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}
