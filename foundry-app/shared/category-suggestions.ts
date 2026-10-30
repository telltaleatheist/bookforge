/**
 * SUGGEST CATEGORIES FROM THE BOOK — the excerpts, the prompt and the answer's
 * shape, in one place both sides of the wire can read.
 *
 * Owen, 2026-10-30: *"we might have an ask window where it skims through the
 * book and suggests categories based on the subject matter. then we can pick
 * from the categories or add more like we do now … if it looks at this book in
 * tandem with my existing categories, i would hope that it would conclude that
 * we're looking for things that are very unusual — mistreating children, strict
 * father morality, etc."* And: *"we could send it excerpts. it doesnt have to see
 * the whole thing to get an idea about what the book is about."*
 *
 * ── ONE CALL OVER EXCERPTS, NOT A WALK OF THE BOOK ─────────────────────────
 *
 * The question is what the book is ABOUT and which of its claims this reader
 * would want flagged, not where every instance of them is — the analysis run
 * answers that afterwards, over every sentence. Evenly spaced excerpts and the
 * chapter list say what a book is about, and they fit one window of the 27B,
 * so the whole feature is one chat.
 *
 * ── THE EXISTING CATEGORIES ARE THE BRIEF ──────────────────────────────────
 *
 * They are sent as the statement of taste, not as a list to extend: a reader
 * whose list is hate, christian nationalism, conspiracy and false prophecy is
 * not asking a parenting manual for "parenting advice", and the prompt says that
 * a topic is not a category. They are also what a suggestion must not repeat.
 *
 * ── A SUGGESTION IS A DRAFT IN THE SHAPE THE DIALOG SAVES ──────────────────
 *
 * Name and description, the two fields of `CustomAnalysisCategory`, written to
 * the rule the add form states: the first sentence is a claim (the ranker reads
 * only that, `customOptionText` in src/analyze/plan.ts), and what follows says
 * what counts (the verifier reads the whole). Nothing is saved here. A person
 * presses Add on a suggestion and it goes through `analysis:write-categories`
 * exactly as a typed one does, slugged and capped by main.
 */
import {
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
} from './analysis-categories';

/** What the dialog asks main for. */
export interface SuggestCategoriesRequest {
  /** The book, as the dialog names it: the original document's path. */
  inputPath: string;
  /** A registered Crucible server's name; empty is the top-ranked one. */
  server: string;
  /** A model id; empty is Automatic, as every job dropdown means it. */
  model: string;
}

/** One proposed category. */
export interface SuggestedCategory {
  name: string;
  description: string;
  /** Why this reader would want it, in a sentence. */
  why: string;
  /** A line from the excerpts it would catch. */
  quote: string;
}

export interface SuggestCategoriesResult {
  server: string;
  model: string;
  /** What the model took the reader to be looking for, in a sentence or two. */
  theme: string;
  suggestions: SuggestedCategory[];
  /** How much of the book it was shown. */
  excerpts: number;
  chars: number;
  seconds: number;
}

/** A category the reader already has, as the brief states it. */
export interface BriefCategory {
  id: string;
  name: string;
  /** The gloss for a built-in, the saved description for the reader's own. */
  says: string;
}

/** The parts of a book row the excerpt picker reads. */
export interface ExcerptRow {
  id: string;
  category: string;
  text: string;
}

/** The parts of a chapter marker it reads. */
export interface ExcerptChapter {
  id: string;
  title: string;
}

export interface Excerpt {
  chapter: string | null;
  text: string;
}

/** How many excerpts, at most. Enough to cross a book; few enough to each be a passage. */
export const SUGGEST_EXCERPTS = 16;

/** The most book a request carries, in characters (about 9k tokens). */
export const SUGGEST_MAX_CHARS = 32_000;

/** Below this there is not enough book to say what it is about. */
export const SUGGEST_MIN_CHARS = 6_000;

/** Tokens for the answer: a theme and six suggestions is well under this. */
export const SUGGEST_REPLY_TOKENS = 2_500;

/** Proposals asked for. */
export const SUGGEST_MAX = 6;

/** Chapters that are apparatus rather than the book. */
const APPARATUS = /^(cover|title( page)?|copyright|contents|table of contents|dedication|also by.*|about the author|index)$/i;

/** Body rows: the categories that carry the author's prose. */
const PROSE = new Set(['Text', 'List-item']);

/** Shorter than this, a row is a heading or a scrap set as text. */
const MIN_ROW = 120;

/**
 * THE EXCERPTS — evenly spaced passages of the book's own prose.
 *
 * Front matter by chapter title is skipped, and so is anything shorter than a
 * sentence or two, so a sample cannot land on a copyright line. Each excerpt
 * starts at an evenly spaced body row and runs on through the rows after it
 * until it holds its share of the budget, cut back to the last full sentence.
 * The chapter it sits in rides with it, because "Chapter 5: The Rod" is half of
 * what a passage from it is about.
 */
export function pickExcerpts(
  rows: readonly ExcerptRow[],
  chapters: readonly ExcerptChapter[],
  budgetChars: number,
  count: number = SUGGEST_EXCERPTS,
): Excerpt[] {
  const chapterAt = new Map(chapters.map((c) => [c.id, c.title]));
  const body: { text: string; chapter: string | null }[] = [];
  let chapter: string | null = null;
  for (const row of rows) {
    if (chapterAt.has(row.id)) chapter = chapterAt.get(row.id) ?? null;
    if (chapter !== null && APPARATUS.test(chapter.trim())) continue;
    if (!PROSE.has(row.category)) continue;
    const text = plain(row.text);
    if (text.length < MIN_ROW) continue;
    body.push({ text, chapter });
  }
  if (body.length === 0) return [];

  const n = Math.min(count, body.length);
  const share = Math.floor(budgetChars / n);
  const out: Excerpt[] = [];
  for (let k = 0; k < n; k += 1) {
    const start = Math.floor((k * body.length) / n);
    const end = k + 1 < n ? Math.floor(((k + 1) * body.length) / n) : body.length;
    let text = '';
    for (let i = start; i < end && text.length < share; i += 1) {
      text = text.length === 0 ? body[i]!.text : `${text}\n${body[i]!.text}`;
    }
    out.push({ chapter: body[start]!.chapter, text: toSentence(text, share) });
  }
  return out;
}

/** Markdown emphasis off; the model reads words. */
function plain(text: string): string {
  return text.replace(/\*\*|__/g, '').replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2').replace(/\s+/g, ' ').trim();
}

/** At most `max` characters, ending on a sentence where one ends in the last third. */
function toSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('.” '));
  return stop > max * 0.66 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

/** The instructions. The reader's categories and the book follow in the user turn. */
export function suggestSystemPrompt(): string {
  return `You help a reader decide what to look for in a book.

The reader runs an analysis that checks every sentence of a book for passages where the AUTHOR states, endorses or instructs a particular kind of claim. Each kind is a category. The reader's existing categories are listed below; taken together they show what this reader looks for.

Read the excerpts from the new book. Work out what the book is about and which of its claims this reader would want flagged, in the same spirit as the existing categories. Then propose new categories for this book that the existing ones do not already cover.

Rules:
- Propose between 1 and ${SUGGEST_MAX} categories, and only ones the excerpts actually show the author holding. Each needs a short exact quote from the excerpts as evidence.
- Match the spirit of the existing list: claims that are extreme, harmful, cruel, demeaning, authoritarian, pseudoscientific or far outside the mainstream. An ordinary subject of the book is not a category: "parenting advice" or "the Bible" is a topic, not a claim.
- Do not propose a category that an existing one already covers, even under another name.
- name: two to five words, sentence case, saying what is flagged.
- description: the FIRST sentence is the claim, written so it could match a sentence in any book, never naming this book, its author or its people, and at most 140 characters. Begin it with a verb such as "Says", "Tells", "Argues", "Claims" or "Compares". Then one or two sentences saying what counts, for example "An approving story counts as endorsement." At most ${CUSTOM_CATEGORY_DESCRIPTION_MAX - 100} characters in all.
- why: one sentence on why this reader would want it, given their existing categories.
- theme: first, in one or two sentences, what you take this reader to be looking for in this book.

Answer with JSON only.`;
}

/** The user turn: the reader's categories, then the book. */
export function suggestUserPrompt(
  title: string,
  existing: readonly BriefCategory[],
  chapters: readonly string[],
  excerpts: readonly Excerpt[],
): string {
  const brief = existing.map((one) => `- ${one.name}: ${one.says}`).join('\n');
  const contents = chapters.filter((t) => !APPARATUS.test(t.trim())).join('; ');
  const passages = excerpts
    .map((one, i) => `[${i + 1}]${one.chapter === null ? '' : ` (${one.chapter})`}\n${one.text}`)
    .join('\n\n');
  return `The reader's existing categories:\n${brief}\n\nThe book: ${title}\n${contents.length > 0 ? `Chapters: ${contents}\n` : ''}\nExcerpts, evenly spaced through the book:\n\n${passages}`;
}

/** The answer's shape, for the engine's grammar. */
export const SUGGEST_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    theme: { type: 'string' },
    suggestions: {
      type: 'array',
      maxItems: SUGGEST_MAX,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          why: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['name', 'description', 'why', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['theme', 'suggestions'],
  additionalProperties: false,
};

/**
 * THE ANSWER, READ — or refused by name when it is not one.
 *
 * A suggestion that would collide with a category the reader has is dropped
 * rather than offered: pressing Add on it could only be refused. Over-long
 * fields are cut to the caps the add form enforces, so what is offered is what
 * the form would accept.
 */
export function readSuggestions(
  content: string,
  existing: readonly BriefCategory[],
): { theme: string; suggestions: SuggestedCategory[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('The model did not answer in JSON, so there are no suggestions to show.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('The model answered with something that is not a list of suggestions.');
  const o = parsed as Record<string, unknown>;
  const theme = typeof o['theme'] === 'string' ? o['theme'].trim() : '';
  const list = Array.isArray(o['suggestions']) ? o['suggestions'] : [];
  const taken = new Set(existing.map((one) => one.id));
  const takenNames = new Set(existing.map((one) => one.name.toLowerCase()));
  const suggestions: SuggestedCategory[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    const field = (k: string): string => (typeof s[k] === 'string' ? (s[k] as string).replace(/\s+/g, ' ').trim() : '');
    const name = field('name').slice(0, CUSTOM_CATEGORY_NAME_MAX).trim();
    const description = field('description').slice(0, CUSTOM_CATEGORY_DESCRIPTION_MAX).trim();
    const id = customCategoryId(name);
    if (name.length === 0 || description.length === 0 || id.length === 0) continue;
    if (taken.has(id) || takenNames.has(name.toLowerCase())) continue;
    taken.add(id);
    suggestions.push({ name, description, why: field('why'), quote: field('quote') });
  }
  return { theme, suggestions };
}
