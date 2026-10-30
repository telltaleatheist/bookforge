/**
 * SUGGEST CATEGORIES FROM THE BOOK — one chat, run in main.
 *
 * The Analysis dialog's "Suggest from this book" (Owen, 2026-10-30). The book at
 * the position is materialised exactly as an analysis would read it, evenly
 * spaced excerpts are taken from it, and the model the dialog names is asked —
 * with the reader's existing categories as the brief — what else this reader
 * would want flagged in it. shared/category-suggestions.ts holds the prompt and
 * says why it is shaped the way it is.
 *
 * NOTHING HERE SAVES A CATEGORY. The answer is a list for the dialog to offer;
 * a suggestion becomes a category only when somebody presses Add on it, through
 * `analysis:write-categories` like any typed one.
 *
 * WHERE AND ON WHAT: the dialog's server and model dropdowns, the analysis
 * job's own (`JobModelKind` `analysis`, the verifier's 27B by default), pointed
 * the way Ask points a run (`crucibleTarget`): a local model is loaded and held
 * by a session for the one chat, then released.
 *
 * Measured once on *To Train Up a Child* with the twelve original categories as
 * the brief (PC, qwen3.8-27b-4bit, 16 excerpts, 30k characters, 7.8k prompt
 * tokens): 58 s to load, 27 s to answer, and it proposed physical punishment,
 * children treated as less than human, absolute parental authority, pain as
 * love and ignoring a crying infant — three of the five written by hand for
 * that book, unprompted.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { chatWithin, crucibleTarget } from './ask-document';
import { readAppSettings } from './app-settings';
import { materializeBook } from './book';
import { projectDirOf } from './projects';
import { ANALYSIS_CATEGORIES } from '../shared/analysis-categories';
import { parseBookFile } from '../shared/book';
import {
  pickExcerpts,
  readSuggestions,
  suggestSystemPrompt,
  suggestUserPrompt,
  SUGGEST_MAX_CHARS,
  SUGGEST_MIN_CHARS,
  SUGGEST_REPLY_TOKENS,
  SUGGEST_SCHEMA,
  type BriefCategory,
  type SuggestCategoriesRequest,
  type SuggestCategoriesResult,
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

/** The one run in flight, so a second press waits for the first rather than loading twice. */
let running: AbortController | null = null;

export async function suggestCategories(
  source: string,
  request: SuggestCategoriesRequest & { title: string },
): Promise<SuggestCategoriesResult> {
  if (running !== null) throw new Error('Suggestions are already being worked out. Wait for them to arrive.');
  const dir = projectDirOf(path.resolve(source));
  if (dir === null) throw new Error(`${source} is not a book in the library, so there is nothing to read.`);
  const abort = new AbortController();
  running = abort;
  const t0 = Date.now();
  try {
    const made = await materializeBook(dir, null);
    if (!made.ok) throw new Error(made.reason);
    const book = parseBookFile(await fsp.readFile(made.path, 'utf8'));

    const brief: BriefCategory[] = [
      ...ANALYSIS_CATEGORIES.map((one) => ({ id: one.id, name: one.name, says: one.about })),
      ...readAppSettings().analysisCategories.map((one) => ({ id: one.id, name: one.name, says: one.description })),
    ];

    const to = await crucibleTarget(request.server, request.model, ACT, (status) => console.error(`[suggest] ${status}`), abort.signal);
    try {
      const room = to.window === null
        ? SUGGEST_MAX_CHARS
        : Math.floor((to.window - SUGGEST_REPLY_TOKENS - OVERHEAD_TOKENS) / TOKENS_PER_CHAR);
      const budget = Math.min(SUGGEST_MAX_CHARS, room);
      if (budget < SUGGEST_MIN_CHARS) {
        throw new Error(`${to.model} on ${to.server} has a ${to.window}-token window, too small to be shown enough of the book. Pick a model with a larger one.`);
      }
      const excerpts = pickExcerpts(book.rows, book.header.chapters, budget);
      if (excerpts.length === 0) throw new Error('This book has no body text to take excerpts from.');
      const chars = excerpts.reduce((n, one) => n + one.text.length, 0);

      const reply = await chatWithin(to, {
        model: to.model,
        messages: [
          { role: 'system', content: suggestSystemPrompt() },
          {
            role: 'user',
            content: suggestUserPrompt(request.title, brief, book.header.chapters.map((c) => c.title), excerpts),
          },
        ],
        maxTokens: SUGGEST_REPLY_TOKENS,
        temperature: 0.3,
        responseFormat: { type: 'json_schema', json_schema: { name: 'suggestions', schema: SUGGEST_SCHEMA, strict: true } },
        act: ACT,
        signal: abort.signal,
        ...(to.local ? { thinking: false } : {}),
      });
      if (reply.finishReason === 'length') {
        throw new Error(`${to.model} ran out of room before it finished its suggestions. Try again.`);
      }
      const { theme, suggestions } = readSuggestions(reply.content ?? '', brief);
      return {
        server: to.server,
        model: to.model,
        theme,
        suggestions,
        excerpts: excerpts.length,
        chars,
        seconds: Math.round((Date.now() - t0) / 1000),
      };
    } finally {
      await to.session?.release();
    }
  } finally {
    running = null;
  }
}
