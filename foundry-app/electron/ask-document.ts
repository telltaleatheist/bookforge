/**
 * ASK THE DOCUMENT — the tool loop, run in main against a Crucible.
 *
 * Owen, 2026-10-29: *"lets build in the logic for asking questions about the
 * document and giving it the ability to mark things."* The person types a
 * request in the inspector's Ask section; the renderer sends the book as they
 * see it (`AskView`); a model works through it with the tools in
 * electron/ask-tools.ts, round after round, until it stops calling them and
 * writes a summary. The marks come back as a list. NOTHING HERE WRITES THE BOOK:
 * the pending stack is the renderer's (book-view.component.ts owns it and its
 * sidecar), so the renderer lands the marks as one undo.
 *
 * It is the experiment in `tools/ask-document/` made a feature, and the lessons
 * measured there are kept on purpose:
 *
 *   * THE SYSTEM PROMPT'S STRATEGY — survey, rules, dry_run, check the leftovers
 *     — is the one that found 1,112 of 1,113 strikes. It is kept nearly word for
 *     word; `revise` is the one tool it gained.
 *   * THE HISTORY IS FITTED TO THE MODEL'S WINDOW before every request
 *     ({@link fitter}), and a request that cannot fit is refused by name. A
 *     local model has about 26k tokens; Claude has 200k. UNLIKE the experiment
 *     it is cut in chunks rather than trimmed every round, so the prompt's
 *     start stays cacheable ({@link HISTORY_HIGH}).
 *   * A REPLY CUT OFF AT max_tokens WITH NO CALL IS NOT AN ANSWER — it ran out
 *     mid-thought — so it is nudged and the run goes on.
 *   * WEATHER IS RETRIED, MISCONFIGURATION IS NAMED. An unreachable server, a
 *     429 or a 5xx gets four tries with a growing wait; any other
 *     refusal is the request being wrong and is said in the server's own words.
 *
 * A FOLLOW-UP STARTS FROM A NOTE (Owen, 2026-11-01). When the summary is
 * written, one more request on the same held session asks the model for a note
 * to itself ({@link takeNote}); it is kept with the book ({@link AskThread}) and
 * the next question opens with it, framed as leads to check
 * ({@link threadOpening}). The rounds themselves are never carried over.
 *
 * ── WHICH MACHINE AND WHICH MODEL ─────────────────────────────────────────
 *
 * The model is the Ask section's dropdown (`JobModelKind` `ask`, the same list
 * every job dialog offers), read from the top-ranked Crucible — so the run goes
 * there too (`topRankedCrucible`). A LOCAL model is held for the whole run by a
 * queue session (`openSession`, the same one a placement opens): forty rounds
 * are forty chats, and without it another client's load could evict the model
 * between any two of them. AUTOMATIC opens that session at this app's ceiling
 * and lets the server name the model. A CLOUD model (`anthropic/…`) is forwarded
 * by the server on its account and holds nothing, exactly as a placement's
 * upstream route holds nothing.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import type { CrucibleClient } from '@crucible/client';
import {
  crucibleTransport,
  DROPPED_NOTE,
  HISTORY_HIGH,
  HISTORY_LOW,
  fitter,
  logTo,
  openCrucibleTarget,
  runLoop,
  takeNote as noteOf,
  type CrucibleTarget,
  type Finished,
  type RetryPolicy,
  type ToolSource,
  type Transport,
} from '@owen/tool-loop';

import { askToolbox, clip, roundSaid, tallySaid, type AskSaid, type AskToolbox } from './ask-tools';
import { AskHistory } from '../shared/ask-history';
import {
  continuationOf,
  isConversation,
  migrateConversations,
  newestFirst,
  runsOf,
  titleOf,
  type AskConversation,
} from '../shared/ask-conversations';
import { writeAtomically } from './atomic';
import { openSession } from './crucible-dispatch';
import { isWeather, topRankedCrucible } from './crucible-models';
import { clientFor, crucibleServerNamed, resolveEngine } from './crucible-registry';
import { bookAtPosition, opsDir } from './projects';
import { JOB_MODEL_CEILING_B } from '../shared/job-models';
import type { AskHighlight, AskMark, AskProgress, AskRequest, AskResult, AskSession, AskThread } from '../shared/ask';

/**
 * Rounds of tool calls, stated in the prompt the way the experiment states it.
 * Eighty since Owen's runs began reaching forty (2026-11-02); the history is cut
 * in chunks ({@link fitter}), so a long run's requests stay inside the window,
 * and a run that still reaches the limit offers "Keep going" on its thread.
 */
export const ASK_MAX_ROUNDS = 80;

/**
 * THE LOOP ITSELF IS `@owen/tool-loop` (vendor/owen-tool-loop-*.tgz), taken out
 * of this file on 2026-11-02 so Owen's other apps can run it with their own
 * tools. What stays here is everything about books: the tools and their state
 * (ask-tools.ts), the prompt, the note's wording, the conversations kept with
 * the book. The numbers it runs Ask with are stated here:
 *
 *   * THE HISTORY IS CUT IN CHUNKS, NEVER ROUND BY ROUND (Owen, 2026-10-29) —
 *     the module's `trim` policy: grow to HISTORY_HIGH rounds, cut back to the
 *     latest HISTORY_LOW in one step, so Claude's prompt cache and vLLM's prefix
 *     cache keep hitting. What dropped rounds did is not lost: the tools hold
 *     every mark, and each request ends with {@link AskToolbox.state}.
 *   * Tokens per reply: the experiment's 8000, or a quarter of a small window.
 *   * Weather gets four tries, waiting 5 s and doubling.
 */
export { DROPPED_NOTE, HISTORY_HIGH, HISTORY_LOW, fitter };
const MAX_REPLY_TOKENS = 8000;
const RETRY: RetryPolicy = { attempts: 4, firstWaitMs: 5_000, log: logTo('ask') };

/** What the act is shown as on the server — one lowercase word, Crucible's rule. */
const ACT = 'ask';

/** Runs in flight, by id. */
const runs = new Map<string, { projectDir: string; abort: AbortController }>();

/**
 * START A RUN, answered with its id at once; everything after is on `emit`.
 *
 * ONE RUN PER BOOK. Two at once would be two models marking one book against
 * the same view, and the second landing would be skipped item by item as the
 * first one's strikes moved every block under it.
 */
export function startAsk(request: AskRequest, emit: (frame: AskProgress) => void): string {
  if (typeof request.request !== 'string' || request.request.trim().length === 0) {
    throw new Error('Say what you want done to the book first.');
  }
  for (const run of runs.values()) {
    if (path.resolve(run.projectDir) === path.resolve(request.projectDir)) {
      throw new Error('This book already has a question running. Cancel it first, or wait for it to finish.');
    }
  }
  const runId = randomUUID();
  const abort = new AbortController();
  runs.set(runId, { projectDir: request.projectDir, abort });
  void runAsk(runId, request, abort.signal, emit)
    .then((result) => {
      emit({ runId, projectDir: request.projectDir, state: 'done', result });
    })
    .catch((err: unknown) => {
      if (abort.signal.aborted) {
        emit({
          runId,
          projectDir: request.projectDir,
          state: 'cancelled',
          message: 'Cancelled. Nothing the model marked was put on the book.',
        });
        return;
      }
      emit({
        runId,
        projectDir: request.projectDir,
        state: 'failed',
        message: `${err instanceof Error ? err.message : String(err)} Nothing was put on the book.`,
      });
    })
    .finally(() => { runs.delete(runId); });
  return runId;
}

/** Stop a run. A run that has already ended is nothing to cancel, and says nothing. */
export function cancelAsk(runId: string): void {
  runs.get(runId)?.abort.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a run is pointed: the client, the model id, its window, and the hold.
 * Category suggestions (electron/suggest-categories.ts) point one chat the same
 * way, which is why this and {@link isWeather} are exported.
 */
export type Target = CrucibleTarget<CrucibleClient>;

/**
 * THE SERVER AND MODEL A DROPDOWN NAMED, made ready: a local model loaded and
 * held by a session the caller releases, a forwarded one passed through.
 * `act` is what the server shows the work as. The registry and the engine hop
 * are this app's; making the model ready is the module's, holding the session
 * through this app's own `openSession`, so one thing here holds every turn on a
 * card.
 */
export async function crucibleTarget(
  server: string | null,
  chosen: string,
  act: string,
  say: (status: string) => void,
  signal: AbortSignal,
): Promise<Target> {
  const name = server !== null && server.length > 0 ? server : topRankedCrucible();
  const entry = crucibleServerNamed(name);
  if (entry === null) {
    throw new Error(`"${name}" is not a registered Crucible server. It may have been renamed or removed; pick a model again.`);
  }
  // The registered address may be an orchestrator; a session and a chat are
  // engine work, so the hop is followed once (crucible-dispatch.ts says why).
  const engine = (await resolveEngine(entry)).entry;
  return openCrucibleTarget({
    client: clientFor(engine),
    server: entry.name,
    chosen,
    act,
    ceilingB: JOB_MODEL_CEILING_B,
    say,
    signal,
    openSession: (pick, said, stop) => openSession(engine, pick, act, entry.name, said, stop),
  });
}

/** Ask's chats through the module: its act, this app's own rule for weather. */
function transportOf(to: Target): Transport {
  return crucibleTransport(to, { act: ACT, isWeather });
}

export type { Finished };

/** The three counts the progress frame has always carried, which the panel's older lines still read. */
function threeCounts(box: AskToolbox): { struck: number; revised: number; retyped: number } {
  const { struck, revised, retyped } = box.counts();
  return { struck, revised, retyped };
}

async function runAsk(
  runId: string,
  request: AskRequest,
  signal: AbortSignal,
  emit: (frame: AskProgress) => void,
): Promise<AskResult> {
  const t0 = Date.now();
  // Read before the model is loaded, like the thread: a book whose kept runs cannot be read says so now.
  const sessions = await readAskSessions(request.projectDir);
  const history = request.stack === undefined ? null : new AskHistory(request.stack, sessions);
  const box = askToolbox(request.view, history);
  let round = 0;
  let says: string | null = null;
  const say = (status: string): void => {
    emit({
      runId,
      projectDir: request.projectDir,
      state: 'running',
      status,
      round,
      maxRounds: ASK_MAX_ROUNDS,
      says,
      ...threeCounts(box),
      tally: tallySaid(box.counts()),
    });
  };

  say('Starting…');
  // Read before the model is loaded: a conversation that cannot be read is said now, not after minutes of work.
  const ops = await opsOf(request.projectDir);
  const conversation = request.conversation === null ? null : await conversationNamedIn(ops, request.conversation);
  const to = await crucibleTarget(request.server, request.model, ACT, say, signal);
  try {
    const opening = conversation === null
      ? request.request
      : continuationOf(conversation, runsOf(conversation, sessions), request.request) ?? request.request;
    const summary = await loop(to, opening, box, signal, (r, prose, status) => {
      round = r;
      if (prose !== null) says = clip(prose, 300);
      say(status);
    });
    const kept = await keepConversation(ops, conversation, request.request, await takeNote(to, summary, box, signal, say));
    return {
      server: to.server,
      model: to.model,
      summary: summary.text,
      items: box.items(),
      highlights: box.highlights(),
      rounds: summary.rounds,
      hitLimit: summary.hitLimit,
      seconds: Math.round((Date.now() - t0) / 1000),
      ...kept,
    };
  } finally {
    await to.session?.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The thread a follow-up starts from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens for the note on a local model, whose thinking is off. A forwarded Claude
 * is given the run's own budget instead: it thinks by default, and that thinking
 * is paid out of the same `max_tokens`.
 */
export const NOTE_MAX_TOKENS = 2000;

/** What the model is asked, after its summary, so a follow-up has something to start from. */
export const NOTE_ASK = `The person may ask a follow-up question about this book. Write a working note for yourself to start from then; the person will not see it. Plain text, at most about 300 words:
- what the person has asked so far, every question;
- what you found, with block ids;
- what you marked, revised, retyped, joined, split, restored, linked or reverted (by history handle), and under which reasons, and the places you pointed at;
- what you searched for or checked and ruled out;
- what is still open or waiting on the person's decision.
If you started from an earlier note, carry forward what still matters from it. Call no tools.`;

/**
 * THE FIRST MESSAGE OF A FOLLOW-UP ON AN OLD THREAD — kept for the thread file's
 * own keepers; a conversation opens with `continuationOf` (shared), which is
 * this for a conversation with a note. It sits where the person's request sits
 * on a first question, so the fitter keeps it through every cut ({@link fitter}).
 */
export function threadOpening(thread: AskThread, request: string): string {
  return `This question continues an earlier conversation about this book. Below is the working note you wrote for yourself at the end of it. Treat it as leads to check, not facts: since then the person may have kept or undone your marks, or edited the book, and the book your tools read is the book as it stands now. Blocks they removed are hidden from you, so a block the note names may be gone. Confirm with a read or a search before you act on anything in it; you need not survey again what it already tells you.

Your note, after ${thread.turns} ${thread.turns === 1 ? 'question' : 'questions'}:
<note>
${thread.note}
</note>

The person now says:
${request}`;
}

/** The note, or why there is none. */
type Noted = { note: string } | { problem: string };

/**
 * ONE MORE SHORT REQUEST, on the session the run still holds: the conversation
 * as the loop left it, with the note asked for in the last message. The tools go
 * with it, because a history holding tool calls is refused without them; any
 * call in the answer is dropped. Weather is retried by the module; what
 * still fails ends the thread, and the run's marks land regardless.
 */
export async function takeNote(
  to: Target,
  finished: Finished,
  box: AskToolbox,
  signal: AbortSignal,
  say: (status: string) => void,
): Promise<Noted> {
  say('Writing a note so you can ask a follow-up…');
  const noted = await noteOf(transportOf(to), finished, {
    signal,
    state: box.state(),
    ask: NOTE_ASK,
    maxTokens: NOTE_MAX_TOKENS,
    retry: RETRY,
  });
  if ('failed' in noted) {
    return { problem: `The model's note for a follow-up could not be had (${noted.failed}), so your next question starts fresh.` };
  }
  if ('empty' in noted) {
    return { problem: `${to.model} wrote no note for a follow-up, so your next question starts fresh.` };
  }
  return { note: noted.note };
}

/**
 * THE CONVERSATION, KEPT — made when the question started one, its count and
 * time moved on, and its note the one just written, or null when there is
 * none: a note one question behind would be read as if it were current, and
 * with none the next question continues from this run's question and answer.
 * None of it can fail the run: its marks are the work, and a conversation is
 * only where the next question starts.
 */
export async function keepConversation(
  ops: string,
  before: AskConversation | null,
  request: string,
  noted: Noted,
): Promise<{ conversation: AskConversation; noteProblem: string | null }> {
  const at = new Date().toISOString();
  const conversation: AskConversation = {
    ...(before ?? { id: randomUUID(), title: titleOf(request), createdAt: at }),
    updatedAt: at,
    turns: (before?.turns ?? 0) + 1,
    note: 'note' in noted ? noted.note : null,
  } as AskConversation;
  try {
    await updateConversationsIn(ops, (all) => [...all.filter((one) => one.id !== conversation.id), conversation]);
    return { conversation, noteProblem: 'note' in noted ? null : noted.problem };
  } catch (err) {
    return {
      conversation,
      noteProblem: `This conversation could not be kept with the book (${err instanceof Error ? err.message : String(err)}), so it may be missing from the list after a reload.`,
    };
  }
}

function systemPrompt(maxRounds: number): string {
  return `You help a person edit a book they are turning into an audiobook. The book is a list of blocks (paragraphs, headings, captions, and so on), each with an id like e-123. Blocks the person already removed are hidden from you.

Your job: carry out the person's request by MARKING blocks for removal, by REVISING the words of a block with exact substitutions, by RETYPING a block whose kind was read wrong (a chapter heading read as a footnote, a quotation read as body text), by JOINING a block onto the one it continues, by SPLITTING a block read as two things, by RENAMING a chapter, by RESTORING a block the person removed by mistake, or by LINKING a footnote to its number — each with a short reason. You never change the book yourself; the person reviews all of these grouped by reason and decides. They are kept by the tools, not by you; use marks_summary or read with only:"marked", "revised", "retyped", "joined" or "split" to see them.

Work the way a careful editor would with a long book:
1. Survey: outline, then read a sample of the start and of a few chapters to learn how the book is built — what recurs, what is body text, what is apparatus.
2. Turn what you find into rules. Search to see how far a pattern reaches and what it would catch by mistake. Use mark with dry_run first, then mark.
3. Use exact ids for one-off judgment calls. To change words rather than remove a block, use revise on that block, quoting the exact text to replace. To make the same change in many blocks (a leading number on every paragraph, a recurring stray mark), use revise_pattern with dry_run first, and tighten the pattern until the examples show only what should change. Each block's kind is shown in brackets ([Footnote], [Section-header]; no tag is Text). To change a kind, use recategorize, by id or with category_is and a pattern (dry_run first); with starts_chapter:true it also starts a chapter at a heading. A heading and a chapter start are separate: say starts_chapter only when the book really divides there; rename_chapter gives an existing chapter a new title.
   Prose broken in two by a picture or a caption: mark the picture and the caption for removal first, then join the block after them onto the block before them (join, dry_run first to see the seam). A heading run into the paragraph after it, or two paragraphs read as one: split at the exact words the second part begins with, giving a half its kind (first_category:"Section-header").
   Blocks the person removed are hidden; read only:"struck" shows them, and restore proposes one back when it was removed by mistake. read only:"unlinked" shows footnotes nothing points at and numbers no note carries; link_footnote binds one to the other.
   When the person asks where something is, or to show the evidence for what you say, use highlight: it changes nothing and lets the person click through to each place.
   The book's edits are in history, newest first, with who made them (the person, an earlier Ask run and its reason, or a panel). When the person says something was wrongly removed or changed, or asks what happened to a block, read history (filter by the block's id) before anything else; to take an edit back, use revert with its handle — it is proposed for review like everything else, and never pops the person's undo stack.
4. Check your work: read with only:"unmarked" through each chapter's non-body regions, and spot-check what you marked, so nothing is missed and nothing wrongly caught. Unmark mistakes.
5. When you are done, stop calling tools and write a short summary for the person: what you changed under each reason and anything you were unsure of. If the person only asked a question, answer it in that summary (highlighting the places it rests on) and mark nothing.

Old rounds are removed from this conversation from time to time to save space, so do not rely on re-reading old results; call the tool again if you need it. The last message of every request states your work so far. You have at most ${maxRounds} rounds of tool calls.`;
}

/**
 * THE ROUNDS, run by the module's loop with Ask's numbers, Ask's prompt and the
 * book's tools. Ends when the model stops calling tools (its last prose is the
 * summary), or at the round limit, where one last request asks only for the
 * summary and any tool call in its answer is dropped. Each round's line says
 * what its calls did (ask-tools.ts `roundSaid`) and the tally after them.
 */
export async function loop(
  to: Target,
  opening: string,
  box: AskToolbox,
  signal: AbortSignal,
  progress: (round: number, prose: string | null, status: string) => void,
): Promise<Finished> {
  return runLoop<AskSaid>({
    transport: transportOf(to),
    tools: toolsOf(box),
    system: systemPrompt(ASK_MAX_ROUNDS),
    opening,
    signal,
    maxRounds: ASK_MAX_ROUNDS,
    maxReplyTokens: MAX_REPLY_TOKENS,
    state: () => box.state(),
    retry: RETRY,
    onProgress: (p) => progress(p.round, p.prose, p.status),
    words: { round: (round, said) => `Round ${round + 1}: ${roundSaid(said)} · ${tallySaid(box.counts())}` },
  });
}

/** The book's tools as the module's source: their specs, and a call by name with the model's own JSON. */
function toolsOf(box: AskToolbox): ToolSource<AskSaid> {
  const specs = box.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  return {
    specs: () => specs,
    call: (name, args) => box.call(name, args),
  };
}

/** True for what a wait can end — one rule, kept beside the model listing that also retries on it. */
export { isWeather };

// ─────────────────────────────────────────────────────────────────────────────
// The sessions, kept in the project
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `<project>/ops/ask-sessions.jsonl` — one line per run that landed, oldest
 * first. In `ops/` because it is what the review card reads after a reload,
 * the same substance as the pending sidecar beside it; no step names it and no
 * replay reads it. Written whole through `writeAtomically`, whose rename retries
 * the transient refusals a NAS share makes, so a reader finds the old file or
 * the new one and never half of either.
 */
async function sessionsFile(projectDir: string): Promise<string> {
  const at = await bookAtPosition(projectDir);
  return path.join(opsDir(at.dir), 'ask-sessions.jsonl');
}

export async function readAskSessions(projectDir: string): Promise<AskSession[]> {
  return readSessionsAt(await sessionsFile(projectDir));
}

/** The sessions file, read by its path. */
export async function readSessionsAt(file: string): Promise<AskSession[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return text.split('\n').filter((l) => l.trim().length > 0).map((l, i) => {
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      throw new Error(`Line ${i + 1} of ${file} is not JSON, so the earlier Ask runs cannot be read.`);
    }
    if (!isSession(value)) throw new Error(`Line ${i + 1} of ${file} is not an Ask run this build can read.`);
    return value;
  });
}

export async function saveAskSession(projectDir: string, session: AskSession): Promise<void> {
  if (!isSession(session)) throw new Error('That Ask run is not one this build can keep.');
  const file = await sessionsFile(projectDir);
  let held = '';
  try {
    held = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const joined = held.length === 0 || held.endsWith('\n') ? held : `${held}\n`;
  await writeAtomically(file, Buffer.from(`${joined}${JSON.stringify(session)}\n`, 'utf8'));
}

/** A kept mark this build can read: every kind, the older strike and revision included. */
export function isAskMark(value: unknown): value is AskMark {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['id'] !== 'string' || typeof m['reason'] !== 'string' || typeof m['before'] !== 'string') return false;
  if (m['kind'] === 'strike') return true;
  if (m['kind'] === 'category') {
    const chapter = m['chapter'];
    const chapterOk = chapter === null || (typeof chapter === 'object' && chapter !== undefined
      && ((chapter as Record<string, unknown>)['start'] === false
        || ((chapter as Record<string, unknown>)['start'] === true
          && typeof (chapter as Record<string, unknown>)['title'] === 'string')));
    return typeof m['from'] === 'string' && typeof m['to'] === 'string' && chapterOk
      && (m['chapterBefore'] === null || typeof m['chapterBefore'] === 'string');
  }
  const str = (k: string): boolean => typeof m[k] === 'string';
  const num = (k: string): boolean => typeof m[k] === 'number' && Number.isInteger(m[k]) && (m[k] as number) >= 0;
  const kindOrNull = (k: string): boolean => m[k] === null || typeof m[k] === 'string';
  switch (m['kind']) {
    case 'text': return str('after');
    case 'join': return str('category') && str('into') && str('intoBefore');
    case 'split': return str('from') && num('at') && str('first') && str('second')
      && kindOrNull('firstCategory') && kindOrNull('secondCategory') && kindOrNull('chapterBefore');
    case 'restore': return true;
    case 'link':
    case 'unlink': return str('block') && num('at') && num('len') && str('blockBefore');
    case 'revert': return str('handle') && str('said')
      && isAskMark(m['original']) && (m['original'] as Record<string, unknown>)['kind'] !== 'revert';
    default: return false;
  }
}

function isChainStep(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c['chain'] === 'string' && typeof c['step'] === 'string'
    && typeof c['index'] === 'number' && typeof c['of'] === 'number';
}

function isHighlight(value: unknown): value is AskHighlight {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return typeof h['id'] === 'string' && (h['quote'] === null || typeof h['quote'] === 'string') && typeof h['note'] === 'string';
}

function isSession(value: unknown): value is AskSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s['id'] === 'string' && typeof s['at'] === 'string' && typeof s['request'] === 'string'
    && typeof s['server'] === 'string' && typeof s['model'] === 'string' && typeof s['summary'] === 'string'
    && Array.isArray(s['items']) && s['items'].every(isAskMark)
    // Both absent on a run kept before they existed.
    && (s['highlights'] === undefined || (Array.isArray(s['highlights']) && s['highlights'].every(isHighlight)))
    && (s['hitLimit'] === undefined || typeof s['hitLimit'] === 'boolean')
    && (s['chain'] === undefined || isChainStep(s['chain']))
    && (s['conversation'] === undefined || typeof s['conversation'] === 'string')
    && (s['preset'] === undefined || typeof s['preset'] === 'string')
    && typeof s['skipped'] === 'number' && typeof s['rounds'] === 'number' && typeof s['seconds'] === 'number';
}

/**
 * The book's ops directory, where its sessions, its old thread and its
 * conversations are kept. Everything below works on that directory, so a
 * keeper drives it without a whole project; the doors name the project.
 */
async function opsOf(projectDir: string): Promise<string> {
  return opsDir((await bookAtPosition(projectDir)).dir);
}

/**
 * `ops/ask-thread.json` — the book's ONE thread, before conversations. Read
 * once, by the migration (`readConversationsIn`), and removed after it.
 * `ops/ask-conversations.json` — the book's conversations
 * (shared/ask-conversations.ts), beside the sessions and for their reason: about
 * the book's edits, named by no step, read by no replay. Written whole through
 * `writeAtomically`.
 */
const THREAD_FILE = 'ask-thread.json';
const CONVERSATIONS_FILE = 'ask-conversations.json';
const SESSIONS_FILE = 'ask-sessions.jsonl';

export async function readAskConversations(projectDir: string): Promise<AskConversation[]> {
  return readConversationsIn(await opsOf(projectDir));
}

/**
 * THE BOOK'S CONVERSATIONS, newest first. The first read of a book kept
 * before conversations migrates its runs and its one thread
 * (`migrateConversations`), writes the result, and only then removes the old
 * thread file — so an interruption leaves the old thread to migrate again.
 */
export async function readConversationsIn(ops: string): Promise<AskConversation[]> {
  const file = path.join(ops, CONVERSATIONS_FILE);
  let text: string | null;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    text = null;
  }
  if (text === null) {
    const thread = await readThreadAt(path.join(ops, THREAD_FILE));
    const migrated = migrateConversations(thread, await readSessionsAt(path.join(ops, SESSIONS_FILE)));
    if (migrated.length > 0 || thread !== null) {
      await writeConversations(file, migrated);
      await fsp.rm(path.join(ops, THREAD_FILE), { force: true });
    }
    return newestFirst(migrated);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON, so this book's Ask conversations cannot be read.`);
  }
  const body = value as { format?: unknown; conversations?: unknown };
  if (typeof value !== 'object' || value === null || body.format !== 'ask-conversations/v1'
    || !Array.isArray(body.conversations) || !body.conversations.every(isConversation)) {
    throw new Error(`${file} is not a list of Ask conversations this build can read.`);
  }
  return newestFirst(body.conversations as AskConversation[]);
}

async function writeConversations(file: string, conversations: readonly AskConversation[]): Promise<void> {
  if (!conversations.every(isConversation)) throw new Error('Those Ask conversations are not ones this build can keep.');
  await writeAtomically(file, Buffer.from(`${JSON.stringify({ format: 'ask-conversations/v1', conversations }, null, 2)}\n`, 'utf8'));
}

/** Read, change, write whole. One run per book at a time, so main is the only writer. */
export async function updateConversationsIn(
  ops: string,
  change: (all: readonly AskConversation[]) => readonly AskConversation[],
): Promise<AskConversation[]> {
  const next = newestFirst(change(await readConversationsIn(ops)));
  await writeConversations(path.join(ops, CONVERSATIONS_FILE), next);
  return next;
}

/** One conversation by id, or the refusal: it was deleted while the panel still showed it. */
export async function conversationNamedIn(ops: string, id: string): Promise<AskConversation> {
  const found = (await readConversationsIn(ops)).find((one) => one.id === id);
  if (found === undefined) {
    throw new Error('That conversation is no longer kept with this book (it was deleted), so it cannot be continued. Press + to start a new one.');
  }
  return found;
}

/** Delete a conversation: its note and its place in the list. Its runs' edits stay on the book. */
export async function deleteAskConversation(projectDir: string, id: string): Promise<AskConversation[]> {
  return updateConversationsIn(await opsOf(projectDir), (all) => all.filter((one) => one.id !== id));
}

/** Rename a conversation. */
export async function renameAskConversation(projectDir: string, id: string, title: string): Promise<AskConversation[]> {
  const named = titleOf(title);
  if (named.length === 0) throw new Error('A conversation needs a title.');
  return updateConversationsIn(await opsOf(projectDir), (all) => all.map((one) => (one.id === id ? { ...one, title: named } : one)));
}

export async function readThreadAt(file: string): Promise<AskThread | null> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON, so the old Ask thread cannot be carried into a conversation.`);
  }
  if (!isThread(value)) {
    throw new Error(`${file} is not an Ask thread this build can read, so it cannot be carried into a conversation.`);
  }
  return value;
}

export async function writeThreadAt(file: string, thread: AskThread): Promise<void> {
  if (!isThread(thread)) throw new Error('That Ask thread is not one this build can keep.');
  await writeAtomically(file, Buffer.from(`${JSON.stringify(thread, null, 2)}\n`, 'utf8'));
}

function isThread(value: unknown): value is AskThread {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return t['format'] === 'ask-thread/v1' && typeof t['first'] === 'string' && typeof t['at'] === 'string'
    && typeof t['note'] === 'string' && t['note'].length > 0
    && typeof t['turns'] === 'number' && Number.isInteger(t['turns']) && t['turns'] >= 1;
}
