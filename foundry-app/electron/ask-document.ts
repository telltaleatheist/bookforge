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
 *     429 or a 5xx gets {@link ATTEMPTS} tries with a growing wait; any other
 *     refusal is the request being wrong and is said in the server's own words.
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

import {
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  type ChatMessage,
  type ChatTool,
  type ChatToolCall,
  type CrucibleClient,
} from '@crucible/client';

import { askToolbox, clip, type AskToolbox } from './ask-tools';
import { writeAtomically } from './atomic';
import { openSession, type HeldSession } from './crucible-dispatch';
import { topRankedCrucible } from './crucible-models';
import { clientFor, crucibleServerNamed, resolveEngine } from './crucible-registry';
import { bookAtPosition, opsDir } from './projects';
import { JOB_MODEL_CEILING_B } from '../shared/job-models';
import type { AskMark, AskProgress, AskRequest, AskResult, AskSession } from '../shared/ask';

/** Rounds of tool calls, stated in the prompt the way the experiment states it. */
export const ASK_MAX_ROUNDS = 40;

/**
 * THE HISTORY IS CUT IN CHUNKS, NEVER ROUND BY ROUND (Owen, 2026-10-29).
 *
 * It grows until it holds HISTORY_HIGH rounds, then is cut back to the most
 * recent HISTORY_LOW in one step: whole rounds, a call leaving with its results.
 * Between two cuts every request begins with exactly the bytes the one before it
 * did, plus one more round, so Claude's prompt cache and vLLM's prefix cache
 * keep hitting. The experiment's loop trimmed old results every round, which
 * changed the prompt's start on every request and paid for the whole history
 * again each time.
 *
 * What the dropped rounds did is not lost: the tools hold every mark, and each
 * request ends with the current state of the work ({@link AskToolbox.state}).
 */
export const HISTORY_HIGH = 20;
export const HISTORY_LOW = 10;

/** Tokens per reply: the experiment's 8000, or a quarter of a small window. */
const MAX_REPLY_TOKENS = 8000;

/**
 * CLAUDE'S WINDOW. Crucible's upstream listing states no window for a forwarded
 * model, and every Claude model the anthropic account serves takes 200k; a model
 * that takes less answers with a 400 naming its own limit, which is said by name.
 */
const CLAUDE_WINDOW = 200_000;

/** Tries for one chat against weather, and the first wait (doubled each time). */
const ATTEMPTS = 4;
const FIRST_WAIT_MS = 5_000;

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

/** Where a run is pointed: the client, the model id, its window, and the hold. */
interface Target {
  server: string;
  client: CrucibleClient;
  model: string;
  local: boolean;
  /** Tokens, or null when nothing states it (a non-Claude upstream). */
  window: number | null;
  session: HeldSession | null;
}

async function target(request: AskRequest, say: (status: string) => void, signal: AbortSignal): Promise<Target> {
  const name = request.server !== null && request.server.length > 0 ? request.server : topRankedCrucible();
  const entry = crucibleServerNamed(name);
  if (entry === null) {
    throw new Error(`"${name}" is not a registered Crucible server. It may have been renamed or removed; pick a model again.`);
  }
  // The registered address may be an orchestrator; a session and a chat are
  // engine work, so the hop is followed once (crucible-dispatch.ts says why).
  const engine = (await resolveEngine(entry)).entry;
  const client = clientFor(engine);
  const chosen = request.model;

  if (chosen.includes('/')) {
    // Forwarded on the server's upstream account: nothing on the card to hold.
    return {
      server: entry.name,
      client,
      model: chosen,
      local: false,
      window: chosen.startsWith('anthropic/') ? CLAUDE_WINDOW : null,
      session: null,
    };
  }

  say(chosen.length === 0
    ? `Asking ${entry.name} for its turn and its own model (up to ${JOB_MODEL_CEILING_B}B)…`
    : `Asking ${entry.name} for its turn and loading ${chosen}…`);
  const session = await openSession(
    engine,
    chosen.length === 0 ? { maxParamsB: JOB_MODEL_CEILING_B } : { model: chosen },
    ACT,
    entry.name,
    say,
    signal,
  );
  try {
    const model = chosen.length > 0 ? chosen : session.model;
    if (model === null) {
      throw new Error(`${entry.name} opened its turn for Automatic and did not say which model it chose.`);
    }
    const info = (await client.models()).find((m) => m.id === model);
    if (info === undefined) {
      throw new Error(`${entry.name} opened its turn with ${model} and then did not list it, so its window is not known.`);
    }
    return {
      server: entry.name,
      client,
      model,
      local: true,
      // The window in force; while a model is not resident the server states
      // only the window it would load it at, which is the same number by intent.
      window: info.maxModelLen ?? info.contextDefault,
      session,
    };
  } catch (err) {
    await session.release();
    throw err;
  }
}

/** A message with the round it belongs to, for trimming. The round is never sent. */
type Held = { message: ChatMessage; round?: number };

async function runAsk(
  runId: string,
  request: AskRequest,
  signal: AbortSignal,
  emit: (frame: AskProgress) => void,
): Promise<AskResult> {
  const t0 = Date.now();
  const box = askToolbox(request.view);
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
      ...box.counts(),
    });
  };

  say('Starting…');
  const to = await target(request, say, signal);
  try {
    const summary = await loop(to, request, box, signal, (r, prose, status) => {
      round = r;
      if (prose !== null) says = clip(prose, 300);
      say(status);
    });
    return {
      server: to.server,
      model: to.model,
      summary: summary.text,
      items: box.items(),
      rounds: summary.rounds,
      seconds: Math.round((Date.now() - t0) / 1000),
    };
  } finally {
    await to.session?.release();
  }
}

function systemPrompt(maxRounds: number): string {
  return `You help a person edit a book they are turning into an audiobook. The book is a list of blocks (paragraphs, headings, captions, and so on), each with an id like e-123. Blocks the person already removed are hidden from you.

Your job: carry out the person's request by MARKING blocks for removal, each with a short reason, or by REVISING the words of a block with exact substitutions, each with a short reason. You never change the book yourself; the person reviews your marks and revisions grouped by reason and decides. Marks and revisions are kept by the tools, not by you; use marks_summary or read with only:"marked" or only:"revised" to see them.

Work the way a careful editor would with a long book:
1. Survey: outline, then read a sample of the start and of a few chapters to learn how the book is built — what recurs, what is body text, what is apparatus.
2. Turn what you find into rules. Search to see how far a pattern reaches and what it would catch by mistake. Use mark with dry_run first, then mark.
3. Use exact ids for one-off judgment calls. To change words rather than remove a block, use revise on that block, quoting the exact text to replace.
4. Check your work: read with only:"unmarked" through each chapter's non-body regions, and spot-check what you marked, so nothing is missed and nothing wrongly caught. Unmark mistakes.
5. When you are done, stop calling tools and write a short summary for the person: what you marked or revised under each reason and anything you were unsure of. If the person only asked a question, answer it in that summary and mark nothing.

Old rounds are removed from this conversation from time to time to save space, so do not rely on re-reading old results; call the tool again if you need it. The last message of every request states the marks and revisions so far. You have at most ${maxRounds} rounds of tool calls.`;
}

/**
 * THE ROUNDS. Ends when the model stops calling tools (its last prose is the
 * summary), or at the round limit, where one last request asks only for the
 * summary and any tool call in its answer is dropped.
 */
async function loop(
  to: Target,
  request: AskRequest,
  box: AskToolbox,
  signal: AbortSignal,
  progress: (round: number, prose: string | null, status: string) => void,
): Promise<{ text: string; rounds: number }> {
  const tools: ChatTool[] = box.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const maxTokens = to.window === null ? MAX_REPLY_TOKENS : Math.min(MAX_REPLY_TOKENS, Math.floor(to.window / 4));
  const fit = fitter(to.window, maxTokens, JSON.stringify(tools).length);
  const history: Held[] = [
    { message: { role: 'system', content: systemPrompt(ASK_MAX_ROUNDS) } },
    { message: { role: 'user', content: request.request } },
  ];
  let summary = '';

  for (let round = 0; ; round += 1) {
    signal.throwIfAborted();
    const final = round >= ASK_MAX_ROUNDS;
    progress(round, null, final
      ? `Round ${round}: asking ${to.model} for its summary…`
      : `Round ${round + 1} of ${ASK_MAX_ROUNDS}: waiting for ${to.model}…`);
    const { wired, chars } = fit.wire(history, round, box.state());
    const reply = await chatWithin(to, {
      model: to.model,
      messages: wired,
      maxTokens,
      tools,
      /*
       * 'auto' EVEN ON THE LAST ROUND. Crucible refuses a tool_choice a
       * forwarded model does not take (`UpstreamModelFacts.toolChoice`), and a
       * refusal there would throw away forty rounds of marks for a summary. The
       * last results already say no more calls can be made, and any call made
       * anyway is dropped below.
       */
      toolChoice: 'auto',
      act: ACT,
      signal,
      // Thinking is the chat template's switch on a local model, sent as
      // chat_template_kwargs by the SDK; a forwarded Claude does not reason
      // unless asked, so the switch there is the absence of the field
      // (src/translate/transport.ts, takesThinkField, says the same).
      ...(to.local ? { thinking: false } : {}),
    });
    if (reply.usage?.promptTokens) fit.measured(reply.usage.promptTokens, chars);
    const calls: readonly ChatToolCall[] = final ? [] : reply.toolCalls;
    history.push({
      message: { role: 'assistant', content: reply.content, ...(calls.length > 0 ? { toolCalls: calls } : {}) },
      round,
    });
    if (reply.content !== null && reply.content.trim().length > 0) summary = reply.content.trim();
    const { struck, revised } = box.counts();
    progress(round, reply.content, `Round ${round + 1}: ${calls.length === 0 ? 'no tool calls' : calls.map((c) => c.function.name).join(', ')} · ${struck} marked${revised > 0 ? `, ${revised} revised` : ''}`);

    if (calls.length === 0) {
      if (final) return { text: summary, rounds: round + 1 };
      if (reply.finishReason === 'length') {
        // Ran out mid-thought: not the model's answer. Asked to act.
        history.push({
          message: {
            role: 'user',
            content: `Your last reply hit the ${maxTokens}-token limit before it called a tool. Keep your reasoning to a few sentences and make the next tool call now.`,
          },
          round,
        });
        continue;
      }
      return { text: summary, rounds: round + 1 };
    }

    for (const call of calls) {
      const tool = box.tools.find((t) => t.name === call.function.name);
      let content: string;
      try {
        if (tool === undefined) {
          throw new Error(`there is no tool "${call.function.name}"; the tools are ${box.tools.map((t) => t.name).join(', ')}`);
        }
        const parsed: unknown = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('the arguments must be a JSON object');
        }
        content = tool.run(parsed as Record<string, unknown>);
      } catch (err) {
        // A refusal is the tool's answer; the model reads it and corrects itself.
        content = `couldn't run ${call.function.name}: ${(err as Error).message}`;
      }
      if (round + 1 >= ASK_MAX_ROUNDS) content += '\n\nNo more tool calls can be made. Write your summary for the person now.';
      history.push({ message: { role: 'tool', toolCallId: call.id, content }, round });
    }
  }
}

/**
 * THE HISTORY, FITTED TO THE WINDOW — in chunks ({@link HISTORY_HIGH}).
 *
 * STATEFUL, because a cut is a fact about the run: once old rounds are gone they
 * stay gone, so the next request starts with the same bytes this one did. `cut`
 * is the first round still sent; everything before it is one short note on the
 * person's turn, which changes only at a cut.
 *
 * `state` is the work so far, rebuilt by the caller every round and sent as the
 * LAST message. It is never put in `history`, so old copies cannot pile up, and
 * it sits after everything that is cached, so it never moves the prefix.
 *
 * THE WINDOW IS STILL THE HARD LIMIT. The size is estimated from characters at
 * the ratio the last request measured (a cautious 0.4 until one has). When a
 * request does not fit, the history is cut back to HISTORY_LOW, then one round
 * at a time down to the last round, and a request that does not fit even then
 * is refused by name. With no stated window (a non-Claude upstream) only the
 * chunking applies, and the vendor's own 400 names its limit if it is outgrown.
 */
export function fitter(window: number | null, maxTokens: number, toolChars: number): {
  wire(history: readonly Held[], round: number, state: string): { wired: ChatMessage[]; chars: number };
  measured(promptTokens: number, chars: number): void;
} {
  let tokensPerChar = 0.4;
  let cut = 0;
  const fits = (chars: number): boolean => window === null || chars * tokensPerChar + maxTokens <= window * 0.95;

  function compose(history: readonly Held[], from: number, state: string): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const h of history) {
      if (h.round !== undefined && h.round < from) continue;
      const m = h.message;
      if (h.round === undefined && m.role === 'user' && from > 0) {
        // Said on the person's turn, which is where the rounds were.
        out.push({ role: 'user', content: `${m.content}\n\n${DROPPED_NOTE}` });
      } else {
        out.push(m);
      }
    }
    out.push({ role: 'user', content: state });
    return out;
  }
  const size = (ms: readonly ChatMessage[]): number => JSON.stringify(ms).length + toolChars;

  return {
    wire(history, round, state) {
      // Rounds 0..round-1 are complete; `round` is the one being asked for.
      if (round - cut > HISTORY_HIGH) cut = round - HISTORY_LOW;
      for (;;) {
        const wired = compose(history, cut, state);
        const chars = size(wired);
        if (fits(chars)) return { wired, chars };
        if (cut >= round - 1) {
          throw new Error(
            `The conversation no longer fits the model's ${window}-token window, even with only its last round kept `
            + `(about ${Math.round(chars * tokensPerChar)} tokens plus ${maxTokens} for the reply). Pick a model with a larger window.`,
          );
        }
        cut = round - cut > HISTORY_LOW ? round - HISTORY_LOW : cut + 1;
      }
    },
    measured(promptTokens, chars) {
      if (chars > 0) tokensPerChar = promptTokens / chars;
    },
  };
}

/** Where dropped rounds were. */
export const DROPPED_NOTE = '[Earlier rounds were removed. The tools hold the work so far.]';

/** True for what a wait can end: a server that did not answer, a 429, a 5xx. */
export function isWeather(err: unknown): boolean {
  if (err instanceof CrucibleUnreachable) return true;
  if (err instanceof CrucibleServerError) return true;
  if (err instanceof CrucibleRefused) return err.status === 429 || err.status === 408;
  return false;
}

/** One chat, with weather retried inside {@link ATTEMPTS} and a growing wait. */
async function chatWithin(
  to: Target,
  options: Parameters<CrucibleClient['chat']>[0] & { signal: AbortSignal },
): ReturnType<CrucibleClient['chat']> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await to.client.chat(options);
    } catch (err) {
      if (options.signal.aborted) throw err;
      const said = err instanceof Error ? err.message : String(err);
      if (!isWeather(err)) {
        throw new Error(`${to.server} refused the request to ${to.model}: ${said}`);
      }
      if (attempt >= ATTEMPTS) {
        throw new Error(`${to.server} did not answer ${to.model} after ${ATTEMPTS} tries: ${said}`);
      }
      const wait = FIRST_WAIT_MS * 2 ** (attempt - 1);
      console.error(`[ask] ${to.server} / ${to.model}: ${said}; trying again in ${wait / 1000}s`);
      await sleep(wait, options.signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = (): void => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

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
  const file = await sessionsFile(projectDir);
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

function isMark(value: unknown): value is AskMark {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['id'] !== 'string' || typeof m['reason'] !== 'string' || typeof m['before'] !== 'string') return false;
  if (m['kind'] === 'strike') return true;
  return m['kind'] === 'text' && typeof m['after'] === 'string';
}

function isSession(value: unknown): value is AskSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s['id'] === 'string' && typeof s['at'] === 'string' && typeof s['request'] === 'string'
    && typeof s['server'] === 'string' && typeof s['model'] === 'string' && typeof s['summary'] === 'string'
    && Array.isArray(s['items']) && s['items'].every(isMark)
    && typeof s['skipped'] === 'number' && typeof s['rounds'] === 'number' && typeof s['seconds'] === 'number';
}
