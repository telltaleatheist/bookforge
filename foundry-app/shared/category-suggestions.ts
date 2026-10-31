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
 * what counts (the verifier reads the whole). Main saves each one into the
 * reader's categories the moment it closes in the stream, through the clamp a
 * typed one goes through (electron/suggest-categories.ts); the dialog lights
 * it, and the pencil and ✕ every category of theirs carries change or remove it.
 */
import {
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
  type CustomAnalysisCategory,
} from './analysis-categories';

/** What the dialog asks main for. */
export interface SuggestCategoriesRequest {
  /** The book, as the dialog names it: the original document's path. */
  inputPath: string;
  /** What the book is called, as the dialog shows it. */
  title: string;
  /** A registered Crucible server's name; empty is the top-ranked one. */
  server: string;
  /** A model id; empty is Automatic, as every job dropdown means it. */
  model: string;
  /**
   * WHAT THE READER EXPECTS IN THIS BOOK, in their words, or empty (Owen,
   * 2026-10-30: *"if i run it on the jehovahs witnesses anti evolution book, i
   * would tell it to look for any anti evolution pseudoscience"*). It is the
   * strongest guide the prompt carries, and it also picks some of the
   * excerpts ({@link pickExcerpts}). At most {@link SUGGEST_HINT_MAX} characters.
   */
  hint: string;
}

/** How long the reader's note may be. A sentence or two, not a brief. */
export const SUGGEST_HINT_MAX = 400;

/** One proposed category. */
export interface SuggestedCategory {
  name: string;
  description: string;
  /** Why this reader would want it, in a sentence. */
  why: string;
  /** A line from the excerpts it would catch. */
  quote: string;
}

/**
 * ONE FRAME OF A RUN, on `analysis:suggest-progress`.
 *
 * Every suggestion is SAVED AS IT ARRIVES (Owen, 2026-10-30: *"list them as
 * individual units … as soon as it adds them"*), by main, through the same
 * clamp a typed category goes through; `mine` is the stored list after the
 * last save, which the dialog takes as it takes any write's answer, and
 * `added` names the ids this run made so the dialog can tick them.
 *
 * `fraction` and `etaS` are estimates, said as such: loading is timed against
 * a measured minute, writing against the reply's measured length and the rate
 * the model is actually writing at.
 */
export interface SuggestProgress {
  runId: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  phase: 'loading' | 'reading' | 'writing';
  /** A sentence about what is happening now. */
  status: string;
  fraction: number;
  /** Seconds left, roughly; null once there is nothing left to wait for. */
  etaS: number | null;
  theme: string | null;
  added: string[];
  mine: CustomAnalysisCategory[] | null;
  /** On `failed` and `cancelled`. */
  message?: string;
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
 *
 * WITH A NOTE FROM THE READER, some of the excerpts start where the note's
 * words are thickest instead ({@link SUGGEST_FOCUS} of them): a claim the
 * reader expects may live in three chapters out of twenty, and even spacing
 * alone would sample past it. The rest stay evenly spaced, so the model still
 * sees what the whole book is about.
 */
export function pickExcerpts(
  rows: readonly ExcerptRow[],
  chapters: readonly ExcerptChapter[],
  budgetChars: number,
  hint: string = '',
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
  const terms = hintTerms(hint);
  const focused = terms.length === 0 ? [] : body
    .map((row, i) => ({ i, score: scoreRow(row.text, terms) }))
    .filter((one) => one.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((one) => one.i);
  const starts = new Set<number>();
  for (const i of focused) {
    if (starts.size >= Math.min(SUGGEST_FOCUS, n)) break;
    starts.add(i);
  }
  const even = n - starts.size;
  for (let k = 0; k < even; k += 1) {
    let at = Math.floor((k * body.length) / even);
    while (starts.has(at) && at + 1 < body.length) at += 1;
    starts.add(at);
  }
  const ordered = [...starts].sort((a, b) => a - b);
  const out: Excerpt[] = [];
  for (const [k, start] of ordered.entries()) {
    const end = k + 1 < ordered.length ? ordered[k + 1]! : body.length;
    let text = '';
    for (let i = start; i < end && text.length < share; i += 1) {
      text = text.length === 0 ? body[i]!.text : `${text}\n${body[i]!.text}`;
    }
    out.push({ chapter: body[start]!.chapter, text: toSentence(text, share) });
  }
  return out;
}

/** Excerpts that follow the reader's note, when there is one. */
export const SUGGEST_FOCUS = 6;

const STOP = new Set(['about', 'above', 'after', 'again', 'also', 'anything', 'book', 'books', 'claims', 'could', 'every',
  'from', 'have', 'into', 'like', 'look', 'looking', 'more', 'other', 'should', 'some', 'such', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'what', 'when', 'where', 'which', 'with', 'would', 'your']);

/** The note's content words, cut to six-letter stems so "evolutionists" meets "evolution". */
function hintTerms(hint: string): string[] {
  const words = hint.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)))];
}

/** How many of the terms a passage carries, each counted once, plus a little for repeats. */
function scoreRow(text: string, terms: readonly string[]): number {
  const words = text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? [];
  let distinct = 0;
  let hits = 0;
  for (const term of terms) {
    const n = words.filter((w) => w.startsWith(term)).length;
    if (n > 0) distinct += 1;
    hits += n;
  }
  return distinct * 10 + Math.min(hits, 9);
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
- If the reader says what they expect in this book, that note is your strongest guide: look hardest for it, and make your proposals serve it. Where an existing category already covers what the note names, propose narrower, more specific claims within it instead of repeating it. Still propose only what the excerpts show.
- theme: first, in one or two sentences, what you take this reader to be looking for in this book.

Answer with JSON only.`;
}

/** The user turn: the reader's categories, then the book. */
export function suggestUserPrompt(
  title: string,
  existing: readonly BriefCategory[],
  chapters: readonly string[],
  excerpts: readonly Excerpt[],
  hint: string = '',
): string {
  const note = hint.replace(/\s+/g, ' ').trim().slice(0, SUGGEST_HINT_MAX);
  const brief = existing.map((one) => `- ${one.name}: ${one.says}`).join('\n');
  const contents = chapters.filter((t) => !APPARATUS.test(t.trim())).join('; ');
  const passages = excerpts
    .map((one, i) => `[${i + 1}]${one.chapter === null ? '' : ` (${one.chapter})`}\n${one.text}`)
    .join('\n\n');
  const said = note.length > 0 ? `\n\nWhat the reader expects in this book, in their words: ${note}` : '';
  const how = note.length > 0
    ? "Excerpts, most evenly spaced through the book and some chosen because they touch the reader's note"
    : 'Excerpts, evenly spaced through the book';
  return `The reader's existing categories:\n${brief}${said}\n\nThe book: ${title}\n${contents.length > 0 ? `Chapters: ${contents}\n` : ''}\n${how}:\n\n${passages}`;
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
 * WHAT THE ANSWER HOLDS SO FAR — the theme once its string has closed, and every
 * suggestion object that has closed, read out of a reply still being written.
 *
 * The reply is schema-bound JSON (`SUGGEST_SCHEMA`), so a suggestion is complete
 * the moment its closing brace arrives; scanning for balanced braces outside
 * strings finds them without waiting for the whole answer. This is what lets a
 * suggestion land in the checklist as soon as the model has written it.
 */
export function readPartial(text: string): { theme: string | null; items: unknown[] } {
  let theme: string | null = null;
  const t = /"theme"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (t !== null) {
    try { theme = (JSON.parse(`"${t[1]}"`) as string).trim(); } catch { theme = null; }
  }
  const items: unknown[] = [];
  const at = /"suggestions"\s*:\s*\[/.exec(text);
  if (at === null) return { theme, items };
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = at.index + at[0].length; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { items.push(JSON.parse(text.slice(start, i + 1))); } catch { /* not closed after all */ }
        start = -1;
      }
    } else if (c === ']' && depth === 0) break;
  }
  return { theme, items };
}

/**
 * ONE SUGGESTION, ADMITTED — or null when it cannot become a category.
 *
 * One that would collide with a category the reader has (`taken`, ids and
 * lower-cased names) is dropped: saving it could only be refused. Over-long
 * fields are cut to the caps the add form enforces. An admitted one is added to
 * `taken`, so a model repeating itself is admitted once.
 */
export function admitSuggestion(item: unknown, taken: Set<string>): (SuggestedCategory & { id: string }) | null {
  if (typeof item !== 'object' || item === null) return null;
  const s = item as Record<string, unknown>;
  const field = (k: string): string => (typeof s[k] === 'string' ? (s[k] as string).replace(/\s+/g, ' ').trim() : '');
  const name = field('name').slice(0, CUSTOM_CATEGORY_NAME_MAX).trim();
  const description = field('description').slice(0, CUSTOM_CATEGORY_DESCRIPTION_MAX).trim();
  const id = customCategoryId(name);
  if (name.length === 0 || description.length === 0 || id.length === 0) return null;
  if (taken.has(id) || taken.has(name.toLowerCase())) return null;
  taken.add(id);
  taken.add(name.toLowerCase());
  return { id, name, description, why: field('why'), quote: field('quote') };
}
