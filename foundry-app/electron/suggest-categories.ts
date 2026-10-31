/**
 * SUGGEST CATEGORIES FROM THE BOOK — one streamed chat, run in main.
 *
 * The Analysis dialog's "Suggest from this book" (Owen, 2026-10-30). The book at
 * the position is materialised exactly as an analysis would read it, evenly
 * spaced excerpts are taken from it, and the model the dialog names is asked —
 * with the reader's existing categories as the brief — what else this reader
 * would want flagged in it. shared/category-suggestions.ts holds the prompt and
 * says why it is shaped the way it is.
 *
 * ── A RUN, WITH A BAR AND A STOP ──────────────────────────────────────────
 *
 * Owen: *"if its using an ai model then it should come with a progress bar …
 * the user needs to know its doing something and hasnt frozen or broken, and
 * how long they have to wait roughly."* So it is Ask's shape: `start` answers
 * with an id at once and the run arrives as frames, one a second and one on
 * every event, each with a fraction and a rough time left. `cancel` aborts the
 * load or the stream and releases the session either way.
 *
 * ── EVERY SUGGESTION IS SAVED AS IT ARRIVES ───────────────────────────────
 *
 * *"list them as individual units with checkboxes and everything as soon as it
 * adds them."* The reply is streamed and every suggestion object is read out of
 * it the moment it closes (`readPartial`), admitted against what the reader
 * already has, and appended to their categories through `writeAppSettings` —
 * the clamp a typed category goes through. The dialog takes the stored list
 * from the frame and ticks what was added. Removing one is the ✕ every category
 * of theirs carries.
 *
 * WHERE AND ON WHAT: the dialog's server and model dropdowns, the analysis
 * job's own (`JobModelKind` `analysis`, the verifier's 27B by default), pointed
 * the way Ask points a run (`crucibleTarget`): a local model is loaded and held
 * by a session for the one chat, then released.
 *
 * Measured once on *To Train Up a Child* with the twelve original categories as
 * the brief (PC, qwen3.8-27b-4bit, 16 excerpts, 30k characters, 7.8k prompt
 * tokens): 58 s to load, 27 s to answer (867 tokens, about 4,000 characters),
 * and it proposed physical punishment, children treated as less than human,
 * absolute parental authority, pain as love and ignoring a crying infant —
 * three of the five written by hand for that book, unprompted.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { crucibleTarget, isWeather, type Target } from './ask-document';
import { readAppSettings, writeAppSettings } from './app-settings';
import { materializeBook } from './book';
import { projectDirOf } from './projects';
import { ANALYSIS_CATEGORIES } from '../shared/analysis-categories';
import { parseBookFile } from '../shared/book';
import {
  admitSuggestion,
  pickExcerpts,
  readPartial,
  suggestSystemPrompt,
  suggestUserPrompt,
  SUGGEST_HINT_MAX,
  SUGGEST_MAX_CHARS,
  SUGGEST_MIN_CHARS,
  SUGGEST_REPLY_TOKENS,
  SUGGEST_SCHEMA,
  type BriefCategory,
  type SuggestCategoriesRequest,
  type SuggestProgress,
} from '../shared/category-suggestions';

/** What the server shows the work as. */
const ACT = 'suggest';

/**
 * Tokens per character, cautious. Measured 0.22 on the test above (English
 * prose); 0.3 leaves room for a book that tokenises worse.
 */
const TOKENS_PER_CHAR = 0.3;

/** The instructions and the brief, in tokens, beside the excerpts. */
const OVERHEAD_TOKENS = 1_500;

/** The estimates, from the one measured run: a cold 27B load, its prefill, its reply. */
const LOAD_S = 60;
const READ_S = 6;
const REPLY_CHARS = 4_000;
const FIRST_RATE_CHARS_S = 130;

/** How the bar is shared between waiting for the model and the model writing. */
const LOAD_SHARE = 0.5;
const READ_SHARE = 0.05;

/** Tries for the stream against weather, before its first character. */
const ATTEMPTS = 3;

/** Runs in flight. One at a time: a second would load a second model for the same answer. */
const runs = new Map<string, AbortController>();

export function startSuggest(asked: SuggestCategoriesRequest, source: string, emit: (frame: SuggestProgress) => void): string {
  // The note is the window's free text: kept a string and kept short here, whatever was sent.
  const request = { ...asked, hint: typeof asked.hint === 'string' ? asked.hint.trim().slice(0, SUGGEST_HINT_MAX) : '' };
  if (runs.size > 0) throw new Error('Suggestions are already being worked out. Stop them first, or wait for them to arrive.');
  const dir = projectDirOf(path.resolve(source));
  if (dir === null) throw new Error(`${source} is not a book in the library, so there is nothing to read.`);
  const runId = randomUUID();
  const abort = new AbortController();
  runs.set(runId, abort);
  void runSuggest(runId, dir, request, abort.signal, emit)
    .catch((err: unknown) => {
      const cancelled = abort.signal.aborted;
      emit({
        runId,
        state: cancelled ? 'cancelled' : 'failed',
        phase: 'writing',
        status: cancelled ? 'Stopped.' : 'Failed.',
        fraction: 0,
        etaS: null,
        theme: null,
        added: [],
        mine: null,
        message: cancelled
          ? 'Stopped. Any suggestion that had already arrived is kept in your categories.'
          : (err instanceof Error ? err.message : String(err)),
      });
    })
    .finally(() => { runs.delete(runId); });
  return runId;
}

export function cancelSuggest(runId: string): void {
  runs.get(runId)?.abort();
}

async function runSuggest(
  runId: string,
  dir: string,
  request: SuggestCategoriesRequest,
  signal: AbortSignal,
  emit: (frame: SuggestProgress) => void,
): Promise<void> {
  const t0 = Date.now();
  let phase: SuggestProgress['phase'] = 'loading';
  let status = 'Reading the book…';
  let phaseAt = Date.now();
  /**
   * IN ANOTHER CLIENT'S LINE, which no estimate can time: the frame then says
   * the server's own sentence ("#2 in its line") and no time left. The SDK
   * says nothing when the line lets go, so the load that follows is not timed
   * either; the bar moves again once the model is ready to read. Measured
   * 2026-10-30: 295 s in line behind another client, then 26 s of writing.
   */
  let waiting = false;
  let got = 0;
  let firstCharAt: number | null = null;
  let theme: string | null = null;
  const added: string[] = [];
  let mine: SuggestProgress['mine'] = null;

  const estimate = (): { fraction: number; etaS: number | null } => {
    const inPhase = (Date.now() - phaseAt) / 1000;
    const rate = firstCharAt !== null && got > 200
      ? got / Math.max(0.5, (Date.now() - firstCharAt) / 1000)
      : FIRST_RATE_CHARS_S;
    const writeLeft = Math.max(0, REPLY_CHARS - got) / rate;
    if (phase === 'loading') {
      return {
        fraction: waiting ? 0 : LOAD_SHARE * Math.min(0.95, inPhase / LOAD_S),
        etaS: waiting ? null : Math.max(5, LOAD_S - inPhase) + READ_S + writeLeft,
      };
    }
    if (phase === 'reading') {
      return {
        fraction: LOAD_SHARE + READ_SHARE * Math.min(1, inPhase / READ_S),
        etaS: Math.max(1, READ_S - inPhase) + writeLeft,
      };
    }
    const share = 1 - LOAD_SHARE - READ_SHARE;
    return { fraction: LOAD_SHARE + READ_SHARE + share * Math.min(0.98, got / REPLY_CHARS), etaS: Math.max(1, writeLeft) };
  };
  const send = (state: SuggestProgress['state'] = 'running'): void => {
    const { fraction, etaS } = estimate();
    emit({
      runId,
      state,
      phase,
      status,
      fraction: state === 'done' ? 1 : fraction,
      etaS: state === 'done' || etaS === null ? null : Math.round(etaS),
      theme,
      added: [...added],
      mine,
    });
  };
  const enter = (next: SuggestProgress['phase'], said: string): void => {
    phase = next;
    status = said;
    phaseAt = Date.now();
    send();
  };
  const ticker = setInterval(() => send(), 1000);
  ticker.unref?.();

  let to: Target | null = null;
  try {
    send();
    const made = await materializeBook(dir, null);
    if (!made.ok) throw new Error(made.reason);
    const book = parseBookFile(await fsp.readFile(made.path, 'utf8'));
    signal.throwIfAborted();

    const brief: BriefCategory[] = [
      ...ANALYSIS_CATEGORIES.map((one) => ({ id: one.id, name: one.name, says: one.about })),
      ...readAppSettings().analysisCategories.map((one) => ({ id: one.id, name: one.name, says: one.description })),
    ];
    const taken = new Set<string>(brief.flatMap((one) => [one.id, one.name.toLowerCase()]));

    enter('loading', 'Asking for the model…');
    to = await crucibleTarget(request.server, request.model, ACT, (said) => {
      const inLine = said.startsWith('Waiting for');
      if (waiting && !inLine) phaseAt = Date.now();
      waiting = inLine;
      status = said;
      send();
    }, signal);
    const target = to;
    const room = target.window === null
      ? SUGGEST_MAX_CHARS
      : Math.floor((target.window - SUGGEST_REPLY_TOKENS - OVERHEAD_TOKENS) / TOKENS_PER_CHAR);
    const budget = Math.min(SUGGEST_MAX_CHARS, room);
    if (budget < SUGGEST_MIN_CHARS) {
      throw new Error(`${target.model} on ${target.server} has a ${target.window}-token window, too small to be shown enough of the book. Pick a model with a larger one.`);
    }
    const excerpts = pickExcerpts(book.rows, book.header.chapters, budget, request.hint);
    if (excerpts.length === 0) throw new Error('This book has no body text to take excerpts from.');

    enter('reading', `${target.model} is reading ${excerpts.length} excerpts…`);
    const options = {
      model: target.model,
      messages: [
        { role: 'system' as const, content: suggestSystemPrompt() },
        { role: 'user' as const, content: suggestUserPrompt(request.title, brief, book.header.chapters.map((c) => c.title), excerpts, request.hint) },
      ],
      maxTokens: SUGGEST_REPLY_TOKENS,
      temperature: 0.3,
      responseFormat: { type: 'json_schema' as const, json_schema: { name: 'suggestions', schema: SUGGEST_SCHEMA, strict: true } },
      act: ACT,
      signal,
      ...(target.local ? { thinking: false } : {}),
    };

    let text = '';
    let seen = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        for await (const delta of target.client.chatStream(options)) {
          if (firstCharAt === null) {
            firstCharAt = Date.now();
            enter('writing', `${target.model} is writing its suggestions…`);
          }
          text += delta;
          got = text.length;
          const partial = readPartial(text);
          if (partial.theme !== null) theme = partial.theme;
          for (const item of partial.items.slice(seen)) {
            const one = admitSuggestion(item, taken);
            if (one === null) continue;
            const stored = writeAppSettings({
              analysisCategories: [...readAppSettings().analysisCategories, { id: one.id, name: one.name, description: one.description }],
            }).analysisCategories;
            if (stored.some((c) => c.id === one.id)) {
              added.push(one.id);
              mine = stored;
              status = `Added “${one.name}”. ${target.model} is still writing…`;
              send();
            }
          }
          seen = partial.items.length;
        }
        break;
      } catch (err) {
        if (signal.aborted || firstCharAt !== null || !isWeather(err) || attempt >= ATTEMPTS) {
          if (signal.aborted) throw err;
          const said = err instanceof Error ? err.message : String(err);
          throw new Error(`${target.server} did not finish ${target.model}'s suggestions: ${said}`);
        }
        console.error(`[suggest] ${target.server} / ${target.model}: ${String(err)}; trying again`);
      }
    }
    const parsedWhole = (() => { try { JSON.parse(text); return true; } catch { return false; } })();
    if (!parsedWhole && added.length === 0) {
      throw new Error(`${target.model} stopped before it finished a suggestion. Try again.`);
    }
    status = added.length === 0
      ? `${target.model} found nothing your categories do not already cover.`
      : `Added ${added.length} suggestion${added.length === 1 ? '' : 's'} in ${Math.round((Date.now() - t0) / 1000)} s.`;
    send('done');
  } finally {
    clearInterval(ticker);
    await to?.session?.release();
  }
}
