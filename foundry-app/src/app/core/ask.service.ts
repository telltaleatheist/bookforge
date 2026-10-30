import { Injectable, inject, signal } from '@angular/core';

import {
  planLanding,
  planUndo,
  type AskBlock,
  type AskMark,
  type AskPlan,
  type AskProgress,
  type AskRowState,
  type AskSession,
  type AskSkip,
  type AskView,
} from '@shared/ask';
import type { Replayed } from '@shared/ops';

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
   * Every request still starts the model fresh (Owen: *"one request per chat
   * window, so the previous request's context doesnt leak"*); the thread is for
   * the person, so what was asked and what came of it stay in front of them.
   */
  readonly history = signal<ReadonlyMap<string, readonly AskSession[]>>(new Map());

  /**
   * "New chat" — by project, the time before which the thread is not drawn.
   * Nothing is deleted: the sessions stay in the project, and the review card
   * still reads the latest one.
   */
  readonly clearedAt = signal<ReadonlyMap<string, number>>(new Map());

  newChat(projectDir: string): void {
    this.clearedAt.update((held) => new Map(held).set(projectDir, Date.now()));
  }

  /** Which tab each run was started from, so the landing finds its pane. */
  private readonly tabOf = new Map<string, string>();

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
  }

  /** Ask. The view is the pane's own replay, read at this instant. */
  async start(tab: Tab, pane: BookStack, request: string, server: string | null, model: string): Promise<void> {
    if (!api) return;
    // A book tab's path IS its project directory (`Tab.path`).
    const projectDir = tab.path;
    const book = pane.view();
    if (book === null) {
      this.setRun(projectDir, failed('The book is still opening; ask again once it is on the page.', request));
      return;
    }
    const view = askViewOf(book, tab.title);
    this.setRun(projectDir, {
      phase: 'running', runId: null, request, status: 'Starting…', round: 0, maxRounds: 0,
      says: null, struck: 0, revised: 0, message: null, steps: [], startedAt: Date.now(),
    });
    try {
      const runId = await api.ask.start({ projectDir, request, server, model, view });
      this.tabOf.set(runId, tab.id);
      const now = this.runFor(projectDir);
      if (now !== null && now.runId === null && now.phase === 'running') this.setRun(projectDir, { ...now, runId });
      await api.crucible.rememberJobModel('ask', model);
    } catch (err) {
      this.setRun(projectDir, failed(err instanceof Error ? err.message : String(err), request));
    }
  }

  async cancel(projectDir: string): Promise<void> {
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
        says: frame.says, struck: frame.struck, revised: frame.revised,
        steps: withStep(run.steps, frame, run.says),
      });
      return;
    }
    const tabId = this.tabOf.get(frame.runId);
    this.tabOf.delete(frame.runId);
    if (frame.state !== 'done') {
      this.setRun(frame.projectDir, { ...run, phase: frame.state, message: frame.message });
      return;
    }
    const pane = tabId === undefined ? null : this.stacks.bookStackFor(tabId);
    const book = pane?.view() ?? null;
    if (pane === null || book === null) {
      this.setRun(frame.projectDir, {
        ...run, phase: 'failed',
        message: 'The book was closed before the model finished, so nothing it marked was put on it.',
      });
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
    this.history.update((held) => new Map(held).set(frame.projectDir, [...(held.get(frame.projectDir) ?? []), session]));
    const said = [
      landed.acted.length === 0
        ? 'The model marked nothing.'
        : `${saidChanges(landed.acted.length)} ${landed.acted.length === 1 ? 'is' : 'are'} waiting with your other edits; one undo takes ${landed.acted.length === 1 ? 'it' : 'them all'} back.`,
      skippedSentence(plan.skipped),
      landed.refused > 0 ? `${saidBlocks(landed.refused)} would not take the correction, and each one said why.` : '',
      kept ?? '',
    ].filter((s) => s.length > 0).join(' ');
    this.setRun(frame.projectDir, { ...run, phase: 'done', message: said });
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
  /** The closing sentence: what landed, or why nothing did. */
  readonly message: string | null;
  /** What the model did, round by round, for the thread's "Working" line. */
  readonly steps: readonly AskStep[];
  /** When Send was pressed, for "worked for 3m 20s". */
  readonly startedAt: number;
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
    says: null, struck: 0, revised: 0, message, steps: [], startedAt: Date.now(),
  };
}

/**
 * THE BOOK AS THE PERSON SEES IT — the pane's replay with struck rows left out
 * and counted, and shelved rows left out entirely (they are not in the flow, so
 * not on the paper, and an edit of one would be about text nobody can see).
 */
export function askViewOf(book: Replayed, title: string): AskView {
  const starts = new Map(book.chapters.map((c, i) => [c.id, i]));
  const blocks: AskBlock[] = [];
  let chapter = -1;
  let struck = 0;
  for (const row of book.rows) {
    if (row.shelf !== undefined) continue;
    const at = starts.get(row.id);
    if (at !== undefined) chapter = at;
    if (row.struck === true) {
      struck += 1;
      continue;
    }
    blocks.push({ id: row.id, text: row.text, category: row.category, chapter });
  }
  return {
    title,
    blocks,
    chapters: book.chapters.map((c) => ({ id: c.id, title: c.title })),
    struck,
  };
}

function rowStates(book: Replayed): ReadonlyMap<string, AskRowState> {
  return new Map(book.rows.map((row) => [row.id, { text: row.text, struck: row.struck === true }]));
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
