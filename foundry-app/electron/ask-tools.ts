/**
 * ASK THE DOCUMENT'S TOOLS — what the model can do to the book, and the marks it
 * leaves.
 *
 * Ported from `tools/ask-document/ask-document.ts`, the experiment that measured
 * the loop (Claude Sonnet 5.5 found 1,112 of 1,113 intended strikes on a real
 * book at 0.98 precision, in about 38 rounds). The six tools are its six, kept
 * the same so what was measured is what ships; `revise` is new, for a request
 * that wants words changed rather than blocks removed.
 *
 * ── PURE, AND THAT IS WHY IT IS ITS OWN FILE ───────────────────────────────
 *
 * Nothing here reads a file or a network. It is handed the view the person was
 * looking at (`AskView`) and answers tool calls against it, so a keeper drives
 * every selector and every refusal without a model, and the loop
 * (electron/ask-document.ts) owns only the conversation.
 *
 * ── A TOOL'S REFUSAL IS A RESULT, NOT A FAILURE ────────────────────────────
 *
 * Every `run` throws a sentence when the call cannot be carried out — an id that
 * is not live, a `find` that occurs twice — and the loop sends that sentence
 * back as the tool's result. The model reads it and corrects itself, which is
 * what it did in the experiment; ending the run over one bad selector would
 * throw away thirty rounds of good ones.
 *
 * ── ONE MARK PER BLOCK ─────────────────────────────────────────────────────
 *
 * A block is either marked for removal or revised, never both: a strike and a
 * revision of one paragraph would be two decisions about a block only one of
 * which can be seen. A strike supersedes a revision (the words are moot once the
 * block goes) and says so; a revision of a block marked for removal is refused,
 * because the model has to unmark it first to mean it.
 *
 * A RETYPING SITS BESIDE EITHER (Owen, 2026-11-01: *"if something is marked as a
 * footnote but its really a chapter title, it has the tools it needs to correct
 * that?"*). `recategorize` changes what KIND of block a block is, and may start or
 * take away the chapter division above it; a block can be retyped and revised at
 * once, since a heading read as a footnote often carries a stray number too. A
 * strike drops the retyping, for the strike's own reason: the block goes.
 */
import type { AskBlock, AskChapterChange, AskHighlight, AskMark, AskView } from '../shared/ask';
import { PDF_BLOCK_CATEGORIES } from '../shared/categories';
import { opIds, type AskHistory } from '../shared/ask-history';

/** Every kind a block can be given, in the engine's spelling. */
const CATEGORIES: readonly string[] = PDF_BLOCK_CATEGORIES.map((c) => c.id);
/** The kinds a chapter may be started at: a heading, which is what a chapter's first block is. */
const HEADINGS: ReadonlySet<string> = new Set(['Title', 'Section-header']);

/**
 * WHAT ONE CALL DID, for the person watching the run (Owen, 2026-11-02: the
 * working lines read *"read, read, read, read, etc"*). A verb and what it did it
 * to — `read` / `ch 12 (e-400–e-460)` — so a round of ten reads can say the verb
 * once (`roundSaid`). Worded HERE, by the tool that knows its own arguments and
 * result, and nowhere else; the loop only joins them.
 */
export interface AskSaid {
  readonly verb: string;
  readonly detail: string;
}

/** A call's answer: what the model reads, and what the person is shown. */
export interface AskToolResult {
  readonly content: string;
  readonly said: AskSaid;
}

/** One tool as the chat sends it, and its handler. */
export interface AskTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  run(args: Record<string, unknown>): AskToolResult;
  /** What a call was aimed at, said without running it — the phrase a refusal is shown under. */
  aim(args: Record<string, unknown>): AskSaid;
}

type Mark = { kind: 'strike'; reason: string } | { kind: 'text'; reason: string; after: string };
type Retype = { reason: string; to: string; chapter: AskChapterChange | null };

/** How many of each the run holds. */
export interface AskCounts {
  readonly struck: number;
  readonly revised: number;
  readonly retyped: number;
  readonly joined: number;
  readonly split: number;
  readonly restored: number;
  readonly linked: number;
  readonly reverted: number;
  readonly highlighted: number;
}

/** The tools, and the marks they keep. */
export interface AskToolbox {
  readonly tools: readonly AskTool[];
  /**
   * Run one call as the model sent it — its name and its arguments' JSON. A
   * refusal is an answer (see the head of this file): its sentence goes back to
   * the model, and the person is shown the call's aim and "refused".
   */
  call(name: string, args: string | null | undefined): AskToolResult;
  /** Every mark, in reading order. */
  items(): AskMark[];
  /** How many of each kind of change the run holds, and how many places it pointed at. */
  counts(): AskCounts;
  /** The places the model pointed at, in order. */
  highlights(): AskHighlight[];
  /**
   * THE WORK SO FAR, as the loop sends it at the end of every request: each
   * reason, marked or revised, its count and a few examples (marks_summary's
   * own answer), under the totals. Old rounds are dropped from the history in
   * chunks, and this is what keeps the model knowing what it has done.
   */
  state(): string;
}

/** The flat, clipped text a result line shows. */
export function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

/** How many details one verb shows in a round before "+N more". */
const SAID_PER_VERB = 3;
/** The longest a round's line runs, tally aside. */
const SAID_MAX = 220;

/**
 * A ROUND'S CALLS AS ONE LINE: each verb once, in the order it was first used,
 * with up to three of its details and a count of the rest —
 * `read ch 3 (e-1–e-40), ch 4 (e-41–e-80), ch 7 (e-200–e-239) +7 more; search "Caption" → 14`.
 */
export function roundSaid(said: readonly AskSaid[]): string {
  if (said.length === 0) return 'no tool calls';
  const groups = new Map<string, string[]>();
  for (const s of said) {
    const held = groups.get(s.verb);
    if (held === undefined) groups.set(s.verb, [s.detail]);
    else held.push(s.detail);
  }
  const parts = [...groups.entries()].map(([verb, details]) => {
    const shown = details.filter((d) => d.length > 0);
    const more = shown.length > SAID_PER_VERB ? ` +${shown.length - SAID_PER_VERB} more` : '';
    const list = shown.slice(0, SAID_PER_VERB).join(', ');
    // A verb with nothing to add (outline, twice) says how many times.
    const times = shown.length === 0 && details.length > 1 ? ` ×${details.length}` : '';
    return `${verb}${list.length > 0 ? ` ${list}` : ''}${more}${times}`;
  });
  return clip(parts.join('; '), SAID_MAX);
}

/** The running tally after a round: only what there is, or that there is nothing yet. */
export function tallySaid(counts: Partial<AskCounts> & { struck: number; revised: number; retyped: number }): string {
  const said: [number | undefined, string][] = [
    [counts.struck, 'marked'], [counts.revised, 'revised'], [counts.retyped, 'retyped'],
    [counts.joined, 'joined'], [counts.split, 'split'], [counts.restored, 'restored'],
    [counts.linked, 'linked'], [counts.reverted, 'reverted'], [counts.highlighted, 'pointed at'],
  ];
  const parts = said.filter(([n]) => n !== undefined && n > 0).map(([n, word]) => `${n} ${word}`);
  return parts.length === 0 ? 'nothing marked yet' : parts.join(', ');
}

/** A reason or a pattern as a round's line quotes it. */
function quoted(value: unknown, n = 32): string {
  return typeof value === 'string' && value.trim().length > 0 ? `"${clip(value.trim(), n)}"` : '';
}

/** Words joined with single spaces, empty ones left out. */
function words(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join(' ');
}

/** Which blocks a selector's arguments name, said briefly: `e-12, e-40`, `/Fig\./`, `e-1–e-9`, `in ch 4`. */
function selectorSaid(a: Record<string, unknown>): string {
  const inChapter = a['chapter'] === undefined ? '' : `in ch ${String(a['chapter'])}`;
  if (Array.isArray(a['ids'])) {
    const ids = a['ids'].filter((id): id is string => typeof id === 'string');
    return words(ids.length <= 2 ? ids.join(', ') : `${ids[0]}…${ids.at(-1)} (${ids.length})`, inChapter);
  }
  if (typeof a['pattern'] === 'string') return words(`/${clip(a['pattern'], 24)}/`, inChapter);
  const range = a['range'];
  if (typeof range === 'object' && range !== null) {
    const r = range as Record<string, unknown>;
    return `${String(r['from'])}–${String(r['to'])}`;
  }
  const span = a['span'];
  if (typeof span === 'object' && span !== null) {
    const s = span as Record<string, unknown>;
    return words(`from /${clip(String(s['start']), 16)}/`, inChapter);
  }
  return inChapter;
}

interface Live extends AskBlock {
  readonly index: number;
}

/** A join the model proposed: this block goes into `into`, the earlier block it continues. */
type Join = { reason: string; into: string };
/** A split the model proposed: where, the trimmed halves, and each half's new kind. */
type Split = { reason: string; at: number; first: string; second: string; firstCategory: string | null; secondCategory: string | null };
/** A link the model proposed: this note's number is printed in `block`, at these characters. */
type Link = { reason: string; note: string; block: string; at: number; len: number };
/** An earlier edit the model proposed taking back: the edit as a mark, and every block it names. */
type Revert = { reason: string; said: string; original: AskMark; ids: readonly string[] };

/**
 * `history` is the book's edits (shared/ask-history.ts), or null when the pane
 * sent none — a run started by something that is not the book pane, or a test
 * about the other tools. The two history tools say so by name.
 */
export function askToolbox(view: AskView, history: AskHistory | null = null): AskToolbox {
  const live: Live[] = view.blocks.map((b, index) => ({ ...b, index }));
  const byId = new Map(live.map((b) => [b.id, b]));
  /** The blocks the person struck, readable on purpose and proposed back by `restore`. */
  const gone: Live[] = view.struckBlocks.map((b, index) => ({ ...b, index }));
  const goneById = new Map(gone.map((b) => [b.id, b]));
  const marks = new Map<string, Mark>();
  const retypes = new Map<string, Retype>();
  /** By the block that goes; a chain (A ← B ← C) is B → A and C → B. */
  const joins = new Map<string, Join>();
  const splits = new Map<string, Split>();
  const restores = new Map<string, string>();
  const links: Link[] = [];
  const highlights: AskHighlight[] = [];
  /** By history handle, in the order proposed. */
  const reverts = new Map<string, Revert>();
  /** The chapter that starts at each block, by its title, as the person saw it. */
  const startsAt = new Map(view.chapters.map((c) => [c.id, c.title]));
  const looseNotes = new Set(view.loose.notes);

  const chapterTitle = (i: number): string => {
    if (i < 0) return '(before the first chapter)';
    const chapter = view.chapters[i];
    if (chapter === undefined) throw new Error(`there is no chapter ${i}`);
    return chapter.title;
  };

  /** The block's words as the model now sees them: its revision, or what the person saw. */
  const textOf = (b: Live): string => {
    const mark = marks.get(b.id);
    return mark?.kind === 'text' ? mark.after : b.text;
  };
  const struckMark = (b: Live): boolean => marks.get(b.id)?.kind === 'strike';
  const revisedMark = (b: Live): boolean => marks.get(b.id)?.kind === 'text';
  const retypedMark = (b: Live): boolean => retypes.has(b.id);
  const joinedMark = (b: Live): boolean => joins.has(b.id);
  const splitMark = (b: Live): boolean => splits.has(b.id);
  /** Something else is joined into it. */
  const joinedIntoMark = (b: Live): boolean => [...joins.values()].some((j) => j.into === b.id);
  /** In a join or a split, either end — the blocks whose words the other tools leave alone. */
  const structured = (b: Live): boolean => joinedMark(b) || joinedIntoMark(b) || splitMark(b);
  /** The block's kind as the model now sees it: its retyping, or what the person saw. */
  const categoryOf = (b: Live): string => retypes.get(b.id)?.to ?? b.category;
  /** A note whose number nothing carries, or that has a link proposed. */
  const linksOf = (id: string): Link[] => links.filter((l) => l.note === id);
  const unlinked = (b: Live): boolean => (looseNotes.has(b.id) && linksOf(b.id).length === 0)
    || view.loose.numbers.some((n) => n.block === b.id);

  function chapterSaid(change: AskChapterChange | null): string {
    if (change === null) return '';
    return change.start ? `; starts chapter "${change.title}"` : '; no chapter starts here';
  }

  /** What the apparatus says about a block: its note links, a loose note, the loose numbers in it. */
  function apparatusSaid(b: Live): string {
    const out: string[] = [];
    if (b.category === 'Footnote') {
      const refs = b.refs ?? [];
      if (refs.length > 0) out.push(`[its number is in ${[...new Set(refs.map((r) => r.block))].join(', ')}]`);
      else if (looseNotes.has(b.id)) out.push('[UNLINKED NOTE]');
    }
    for (const l of linksOf(b.id)) out.push(`[LINKED to "${textAt(l)}" in ${l.block}: ${l.reason}]`);
    for (const n of view.loose.numbers.filter((one) => one.block === b.id)) {
      out.push(`[LOOSE NUMBER "${b.text.slice(n.at, n.at + n.len)}" at ${n.at}]`);
    }
    return out.length === 0 ? '' : ` ${out.join(' ')}`;
  }

  function textAt(l: Link): string {
    const block = byId.get(l.block);
    return block === undefined ? '?' : block.text.slice(l.at, l.at + l.len);
  }

  function line(b: Live, n = 200): string {
    const mark = marks.get(b.id);
    const said = mark === undefined
      ? ''
      : mark.kind === 'strike' ? ` [MARKED: ${mark.reason}]` : ` [REVISED: ${mark.reason}]`;
    const retype = retypes.get(b.id);
    const head = retype !== undefined
      ? ` [RETYPED ${b.category} → ${retype.to}${chapterSaid(retype.chapter)}: ${retype.reason}]`
      : b.category === 'Text' ? '' : ` [${b.category}]`;
    const join = joins.get(b.id);
    const joined = join === undefined ? '' : ` [JOINED into ${join.into}: ${join.reason}]`;
    const split = splits.get(b.id);
    const cut = split === undefined ? ''
      : ` [SPLIT before "${clip(split.second, 30)}"${split.firstCategory !== null || split.secondCategory !== null
        ? ` (${split.firstCategory ?? b.category} | ${split.secondCategory ?? b.category})` : ''}: ${split.reason}]`;
    return `${b.id}${head}${said}${joined}${cut}${apparatusSaid(b)} ${clip(textOf(b), n)}`;
  }

  function goneLine(b: Live, n = 200): string {
    const kind = b.category === 'Text' ? '' : ` [${b.category}]`;
    const back = restores.get(b.id);
    return `${b.id} [STRUCK]${kind}${back === undefined ? '' : ` [RESTORE: ${back}]`} ${clip(b.text, n)}`;
  }

  function regex(pattern: unknown, flags: unknown): RegExp {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('pattern must be a non-empty regular expression string');
    }
    // g and y make test() stateful across blocks, which would skip matches.
    const f = typeof flags === 'string' ? flags.replace(/[gy]/g, '') : '';
    try {
      return new RegExp(pattern, f);
    } catch (err) {
      throw new Error(`that pattern will not compile: ${(err as Error).message}`);
    }
  }

  function filtered(only: unknown): (b: Live) => boolean {
    if (only === undefined || only === 'all') return () => true;
    if (only === 'unmarked') return (b) => !struckMark(b);
    if (only === 'marked') return struckMark;
    if (only === 'revised') return revisedMark;
    if (only === 'retyped') return retypedMark;
    if (only === 'joined') return (b) => joinedMark(b) || joinedIntoMark(b);
    if (only === 'split') return splitMark;
    if (only === 'unlinked') return unlinked;
    if (only === 'struck') throw new Error('only:"struck" is for read, which lists the blocks the person struck');
    throw new Error('only must be "all", "unmarked", "marked", "revised", "retyped", "joined", "split", "unlinked" or (for read) "struck"');
  }

  function position(ref: unknown): number {
    if (ref === undefined) return 0;
    if (typeof ref === 'number') return Math.max(0, Math.min(live.length - 1, Math.floor(ref)));
    if (typeof ref === 'string') {
      const b = byId.get(ref);
      if (b === undefined) throw new Error(`there is no live block ${ref} (it may be struck already, or not exist)`);
      return b.index;
    }
    throw new Error('a block reference must be a block id');
  }

  /** The live block an id names, or the refusal that says why not. */
  function liveBlock(id: unknown, field = 'id'): Live {
    if (typeof id !== 'string') throw new Error(`${field} must be a block id`);
    const b = byId.get(id);
    if (b === undefined) {
      throw new Error(goneById.has(id)
        ? `${id} was struck by the person; read only:"struck" to see such blocks, and restore to propose one back`
        : `there is no live block ${id}`);
    }
    return b;
  }

  /** The blocks a selector names: exactly one of ids, pattern, span, range. */
  function select(a: Record<string, unknown>): Live[] {
    const given = ['ids', 'pattern', 'span', 'range'].filter((k) => a[k] !== undefined);
    if (given.length !== 1) {
      throw new Error(`give exactly one of ids, pattern, span, range (got ${given.join(', ') || 'none'})`);
    }
    const inChapter = a['chapter'] === undefined ? () => true : (b: Live) => b.chapter === Number(a['chapter']);
    if (a['ids'] !== undefined) {
      const ids = a['ids'];
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        throw new Error('ids must be an array of block ids');
      }
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) throw new Error(`not live blocks: ${missing.slice(0, 10).join(', ')}`);
      return [...new Map(ids.map((id) => [id, byId.get(id)!])).values()];
    }
    if (a['pattern'] !== undefined) {
      const re = regex(a['pattern'], a['flags']);
      return live.filter((b) => inChapter(b) && re.test(textOf(b)));
    }
    if (a['range'] !== undefined) {
      const range = a['range'] as Record<string, unknown>;
      if (typeof range !== 'object' || range === null) throw new Error('range must be {from, to}');
      const from = position(range['from']);
      const to = position(range['to']);
      if (to < from) throw new Error('range.to is before range.from');
      return live.slice(from, to + 1);
    }
    // A span: each block matching `start`, and the blocks after it up to (not
    // including) the next block matching `until`, the next start, or the next chapter.
    const span = a['span'] as Record<string, unknown>;
    if (typeof span !== 'object' || span === null) throw new Error('span must be {start, until}');
    const start = regex(span['start'], span['flags']);
    const until = regex(span['until'], span['flags']);
    const includeStart = span['include_start'] !== false;
    const out: Live[] = [];
    for (let i = 0; i < live.length; i += 1) {
      const b = live[i]!;
      if (!inChapter(b) || !start.test(textOf(b))) continue;
      if (includeStart) out.push(b);
      for (let j = i + 1; j < live.length; j += 1) {
        const next = live[j]!;
        if (next.chapter !== b.chapter || until.test(textOf(next)) || start.test(textOf(next))) break;
        out.push(next);
      }
    }
    return [...new Map(out.map((b) => [b.id, b])).values()];
  }

  function examples(blocks: readonly Live[], n: number): string {
    if (blocks.length <= n) return blocks.map((b) => line(b, 160)).join('\n');
    const step = blocks.length / n;
    return Array.from({ length: n }, (_, i) => blocks[Math.floor(i * step)]!).map((b) => line(b, 160)).join('\n');
  }

  function perChapter(blocks: readonly Live[]): string {
    const counts = new Map<number, number>();
    for (const b of blocks) counts.set(b.chapter, (counts.get(b.chapter) ?? 0) + 1);
    return [...counts.entries()].map(([c, n]) => `ch${c}:${n}`).join(' ');
  }

  function counts(): AskCounts {
    let struck = 0;
    let revised = 0;
    for (const mark of marks.values()) {
      if (mark.kind === 'strike') struck += 1;
      else revised += 1;
    }
    return {
      struck, revised, retyped: retypes.size, joined: joins.size, split: splits.size,
      restored: restores.size, linked: links.length, reverted: reverts.size, highlighted: highlights.length,
    };
  }

  function totals(): string {
    return `Total: ${tallySaid(counts())}.`;
  }

  /** A category the engine knows, or a refusal listing the ones it does. */
  function categoryArg(value: unknown, field: string): string {
    if (typeof value !== 'string' || !CATEGORIES.includes(value)) {
      throw new Error(`${field} must be one of ${CATEGORIES.join(', ')} (exactly as spelled)${typeof value === 'string' ? `; "${value}" is not` : ''}`);
    }
    return value;
  }

  /** A heading's words as a chapter title: its markers and its line breaks taken out. */
  function titleOf(b: Live): string {
    const title = textOf(b).replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
    if (title.length === 0) throw new Error(`${b.id} has no words to title a chapter with; give chapter_title`);
    return title;
  }

  function reasonOf(a: Record<string, unknown>): string {
    const reason = a['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('reason is required');
    return reason.trim();
  }

  /** The live block before `b` in reading order that is not marked for removal, or null. */
  function previousKept(b: Live): Live | null {
    for (let i = b.index - 1; i >= 0; i -= 1) {
      const before = live[i]!;
      if (!struckMark(before)) return before;
    }
    return null;
  }

  /** "…the end of one⏐the start of the other…" — a join's seam, for a dry run. */
  function seam(into: Live, b: Live): string {
    const head = textOf(into);
    const tail = textOf(b);
    return `${head.length > 70 ? `…${head.slice(-70)}` : head} ⏐ ${tail.length > 70 ? `${tail.slice(0, 70)}…` : tail}`;
  }

  const selectorProps = {
    ids: { type: 'array', items: { type: 'string' }, description: 'Exact block ids.' },
    pattern: { type: 'string', description: 'A JavaScript regular expression tested against each block\'s text.' },
    flags: { type: 'string', description: 'Regex flags for pattern, e.g. "i".' },
    span: {
      type: 'object',
      description: 'Each block matching start, plus the blocks after it until (not including) the next block matching until, the next block matching start, or the next chapter.',
      properties: { start: { type: 'string' }, until: { type: 'string' }, flags: { type: 'string' }, include_start: { type: 'boolean' } },
      required: ['start', 'until'],
    },
    range: {
      type: 'object',
      description: 'Every live block from one id to another, inclusive.',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    chapter: { type: 'integer', description: 'Limit pattern or span to this chapter number (from outline).' },
  };
  const onlyProp = { type: 'string', enum: ['all', 'unmarked', 'marked', 'revised', 'retyped', 'joined', 'split', 'unlinked'] };
  const categoryIsProp = {
    type: 'string',
    enum: [...CATEGORIES],
    description: 'Only blocks that are currently this kind (the [Kind] read and search show; no tag is Text).',
  };
  /** The note a mark's or a retyping's tool leaves when it skipped blocks in a join or a split. */
  const structuredSkip = (n: number): string => (n > 0
    ? ` ${n} joined or split, skipped; unmark the join or split first to change them.` : '');

  const tools: AskTool[] = [
    {
      name: 'outline',
      description: 'The book\'s chapters: number, title, first block id, how many live blocks and how many are marked, revised or retyped, and how much apparatus is unlinked. Start here.',
      parameters: { type: 'object', properties: {} },
      run() {
        const rows = view.chapters.map((c, i) => {
          const blocks = live.filter((b) => b.chapter === i);
          const struck = gone.filter((b) => b.chapter === i).length;
          if (blocks.length === 0) return `ch${i} "${c.title}" — already removed`;
          const revised = blocks.filter(revisedMark).length;
          const retyped = blocks.filter(retypedMark).length;
          const loose = blocks.filter(unlinked).length;
          return `ch${i} "${c.title}" first=${blocks[0]!.id} blocks=${blocks.length} marked=${blocks.filter(struckMark).length}`
            + (revised > 0 ? ` revised=${revised}` : '') + (retyped > 0 ? ` retyped=${retyped}` : '')
            + (struck > 0 ? ` struck-by-person=${struck}` : '') + (loose > 0 ? ` unlinked=${loose}` : '');
        });
        const before = live.filter((b) => b.chapter === -1).length;
        const content = [
          `"${view.title}": ${live.length} live blocks, ${view.struck} already struck by the person (hidden; read only:"struck" to see them). ${totals()}`,
          view.loose.numbers.length + view.loose.notes.length > 0
            ? `Apparatus not joined up: ${view.loose.numbers.length} numbers in the text no note carries, ${view.loose.notes.length} notes nothing points at (read only:"unlinked").`
            : '',
          before ? `${before} blocks before the first chapter.` : '',
          ...rows,
        ].filter(Boolean).join('\n');
        return { content, said: { verb: 'outline', detail: '' } };
      },
      aim: () => ({ verb: 'outline', detail: '' }),
    },
    {
      name: 'read',
      description: 'Read blocks in order from a block id, one per line: id, mark if any, text (clipped unless full). Use only:"unmarked" to review what is left, only:"struck" to read the blocks the person removed, only:"unlinked" for notes and numbers that did not join up.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Block id to start at (default: the first block).' },
          count: { type: 'integer', description: 'How many blocks, at most 80 (default 40).' },
          full: { type: 'boolean', description: 'Whole text instead of the first 200 characters.' },
          only: { ...onlyProp, enum: [...onlyProp.enum, 'struck'] },
          chapter: { type: 'integer', description: 'Read this chapter from its start instead of from.' },
        },
      },
      run(a) {
        const count = Math.min(80, Math.max(1, Number(a['count'] ?? 40)));
        const struckOnly = a['only'] === 'struck';
        const list = struckOnly ? gone : live;
        const keep = struckOnly ? () => true : filtered(a['only']);
        let i: number;
        if (a['chapter'] !== undefined) {
          i = list.findIndex((b) => b.chapter === Number(a['chapter']));
          if (i < 0) throw new Error(`chapter ${String(a['chapter'])} has no ${struckOnly ? 'struck' : 'live'} blocks`);
        } else if (struckOnly && a['from'] !== undefined) {
          const from = goneById.get(String(a['from']));
          if (from === undefined) throw new Error(`${String(a['from'])} is not a block the person struck`);
          i = from.index;
        } else {
          i = struckOnly ? 0 : position(a['from']);
        }
        const out: string[] = [];
        const read: Live[] = [];
        let lastChapter = -2;
        for (; i < list.length && out.length < count; i += 1) {
          const b = list[i]!;
          if (!keep(b)) continue;
          if (b.chapter !== lastChapter) {
            out.push(`— ch${b.chapter} "${chapterTitle(b.chapter)}" —`);
            lastChapter = b.chapter;
          }
          out.push(struckOnly ? goneLine(b, a['full'] === true ? 2000 : 200) : line(b, a['full'] === true ? 2000 : 200));
          read.push(b);
        }
        out.push(i < list.length ? `(next: ${list[i]!.id})` : struckOnly ? '(end of the struck blocks)' : '(end of book)');
        const first = read[0];
        const last = read.at(-1);
        const which = first === undefined ? 'nothing'
          : first === last ? `(${first.id})` : `(${first.id}–${last!.id})`;
        return { content: out.join('\n'), said: { verb: 'read', detail: words(this.aim(a).detail, which) } };
      },
      aim(a) {
        const only = typeof a['only'] === 'string' && a['only'] !== 'all' ? a['only'] : '';
        const where = a['chapter'] !== undefined ? `ch ${String(a['chapter'])}`
          : typeof a['from'] === 'string' ? `from ${a['from']}` : 'from the start';
        return { verb: 'read', detail: only.length > 0 ? `${only} in ${where}` : where };
      },
    },
    {
      name: 'search',
      description: 'Find live blocks whose text matches a regular expression: the count, where they fall by chapter, and spread-out examples.',
      parameters: {
        type: 'object',
        properties: {
          pattern: selectorProps.pattern,
          flags: selectorProps.flags,
          chapter: selectorProps.chapter,
          only: onlyProp,
          category_is: categoryIsProp,
          show: { type: 'integer', description: 'How many examples, at most 30 (default 10).' },
        },
        required: ['pattern'],
      },
      run(a) {
        const re = regex(a['pattern'], a['flags']);
        const keep = filtered(a['only']);
        const kind = a['category_is'] === undefined ? null : categoryArg(a['category_is'], 'category_is');
        const hits = live.filter((b) => keep(b) && (kind === null || categoryOf(b) === kind)
          && (a['chapter'] === undefined || b.chapter === Number(a['chapter'])) && re.test(textOf(b)));
        const show = Math.min(30, Math.max(1, Number(a['show'] ?? 10)));
        return {
          content: `${hits.length} matches (${hits.filter(struckMark).length} already marked). By chapter: ${perChapter(hits) || 'none'}\n${examples(hits, show)}`,
          said: { verb: 'search', detail: `${this.aim(a).detail} → ${hits.length}` },
        };
      },
      aim(a) {
        const only = typeof a['only'] === 'string' && a['only'] !== 'all' ? a['only'] : '';
        const kind = typeof a['category_is'] === 'string' ? `[${a['category_is']}]` : '';
        const where = a['chapter'] === undefined ? '' : `in ch ${String(a['chapter'])}`;
        return { verb: 'search', detail: words(quoted(a['pattern'], 28), only, kind, where) };
      },
    },
    {
      name: 'mark',
      description: 'Mark blocks for removal, with a short reason the person will review them under. Give exactly one selector. Use dry_run:true first to see what a selector catches. Blocks in a join or a split are skipped.',
      parameters: {
        type: 'object',
        properties: {
          ...selectorProps,
          reason: { type: 'string', description: 'Short label, e.g. "study question". Blocks are grouped by it for review.' },
          dry_run: { type: 'boolean' },
        },
        required: ['reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const blocks = select(a);
        const inStructure = blocks.filter(structured).length;
        const fresh = blocks.filter((b) => !struckMark(b) && !structured(b));
        const revised = fresh.filter(revisedMark).length;
        const retyped = fresh.filter(retypedMark).length;
        const summary = `${blocks.length} blocks (${blocks.filter(struckMark).length} already marked). By chapter: ${perChapter(blocks) || 'none'}`;
        if (a['dry_run'] === true) {
          return {
            content: `WOULD MARK ${summary}${revised > 0 ? `; ${revised} of them are revised, and marking drops the revision` : ''}`
              + `${retyped > 0 ? `; ${retyped} of them are retyped, and marking drops the retyping` : ''}${structuredSkip(inStructure)}\n${examples(blocks, 12)}`,
            said: { verb: 'dry run:', detail: words(`${fresh.length} would be marked`, quoted(reason)) },
          };
        }
        for (const b of fresh) {
          marks.set(b.id, { kind: 'strike', reason });
          retypes.delete(b.id);
        }
        return {
          content: `MARKED ${fresh.length} new as "${reason}". ${summary}.`
            + (revised > 0 ? ` ${revised} had been revised; the revision is dropped, since the block goes.` : '')
            + (retyped > 0 ? ` ${retyped} had been retyped; the retyping is dropped, since the block goes.` : '')
            + structuredSkip(inStructure)
            + ` ${totals()}`,
          said: { verb: 'marked', detail: words(String(fresh.length), quoted(reason)) },
        };
      },
      aim: (a) => ({ verb: 'mark', detail: words(selectorSaid(a), quoted(a['reason'])) }),
    },
    {
      name: 'revise',
      description: 'Change words inside ONE block by exact substitution, with a short reason the person will review it under. Each edit replaces the text find with replace; find must occur in the block\'s current text exactly once, or give occurrence (1 = first) to say which. Edits apply in order, and either all of a call\'s edits apply or none do. Use mark, not revise, to remove a whole block. A block in a join or a split cannot be revised. A block with no words (a heading that was printed as a picture, an empty Title) has nothing to find: give text instead of edits to write its words.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The block to change.' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string', description: 'Exact text in the block, character for character.' },
                replace: { type: 'string', description: 'What it becomes; empty deletes it.' },
                occurrence: { type: 'integer', description: 'Which occurrence of find, 1 for the first. Needed only when find occurs more than once.' },
              },
              required: ['find', 'replace'],
            },
          },
          text: { type: 'string', description: 'The words for a block that has none, instead of edits. Refused on a block that already has words.' },
          reason: { type: 'string', description: 'Short label, e.g. "spelled-out number". Changes are grouped by it for review.' },
          dry_run: { type: 'boolean' },
        },
        required: ['id', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const b = liveBlock(a['id']);
        const id = b.id;
        if (struckMark(b)) {
          throw new Error(`${id} is marked for removal; unmark it first if it should stay and be changed`);
        }
        if (structured(b)) throw new Error(`${id} is in a join or a split; unmark that first to change its words`);
        const before = textOf(b);
        /*
         * AN EMPTY BLOCK IS WRITTEN WHOLE (Owen, 2026-11-04). "For the Soul of the
         * People" printed two chapter headings as pictures; the model retyped each
         * empty picture as a Title, named the chapter, and then could not give the
         * Title its words, because every edit must FIND text and there was none.
         * `text` is for exactly that block and no other: on a block with words it
         * would be a whole-paragraph rewrite with nothing for the review to diff
         * against, which is what `edits` exists to prevent.
         */
        let after: string;
        if (a['text'] !== undefined) {
          if (a['edits'] !== undefined) throw new Error('give edits or text, not both');
          if (typeof a['text'] !== 'string') throw new Error('text must be a string');
          if (before.trim().length > 0) {
            throw new Error(`${id} already has words; change them with edits ({find, replace}), not text`);
          }
          after = a['text'];
        } else {
          const edits = a['edits'];
          if (!Array.isArray(edits) || edits.length === 0) {
            throw new Error(before.trim().length === 0
              ? `${id} has no words to find; give text to write them`
              : 'edits must be a non-empty array of {find, replace}');
          }
          after = applyEdits(before, edits, id);
        }
        if (after.trim().length === 0) {
          throw new Error(`that would leave ${id} empty; use mark to remove a block`);
        }
        if (a['dry_run'] === true) {
          return {
            content: `WOULD REVISE ${id}:\n- ${clip(before, 400)}\n+ ${clip(after, 400)}`,
            said: { verb: 'dry run:', detail: words(`${id} would change`, quoted(reason)) },
          };
        }
        if (after === b.text) {
          marks.delete(id);
          return {
            content: `${id} is back to its original text, so it is no longer revised. ${totals()}`,
            said: { verb: 'revised', detail: `${id} back to its original` },
          };
        }
        marks.set(id, { kind: 'text', reason, after });
        return {
          content: `REVISED ${id} as "${reason}":\n- ${clip(before, 300)}\n+ ${clip(after, 300)}\n${totals()}`,
          said: { verb: 'revised', detail: words(id, quoted(reason)) },
        };
      },
      aim: (a) => ({ verb: 'revise', detail: words(typeof a['id'] === 'string' ? a['id'] : '', quoted(a['reason'])) }),
    },
    /*
     * ── THE SAME CHANGE ACROSS MANY BLOCKS (Owen, 2026-10-30) ───────────────
     *
     * *"can we remove the numbers from the start of each of the paragraphs?
     * jehovahs witnesses number their paragraphs."* A book numbers six hundred
     * paragraphs, and `revise` is one block per call, so a whole-book change
     * ran out of rounds before it ran out of paragraphs. This is `mark`'s
     * pattern form for words: one regex substitution over every block a
     * selector names, dry run first, each change landing as a revision the
     * person reviews under the reason — so the caution (a real "10" opening a
     * sentence) is in the pattern and in the review, not in six hundred calls.
     */
    {
      name: 'revise_pattern',
      description: 'Change words in MANY blocks at once by regular-expression substitution, with a short reason the person will review the changes under. find is a JavaScript regular expression applied to each block\'s current text; replace is its replacement ($1, $2 … refer to groups; empty deletes the match). Only the first match in each block is replaced unless find_flags contains "g". Give a selector (ids, pattern, span or range, optionally chapter) to limit which blocks; with none, every live block where find matches. Blocks marked for removal, or in a join or a split, are skipped, and a change that would leave a block empty is refused for that block. ALWAYS use dry_run:true first: it reports how many blocks would change and shows spread-out before/after examples, so you can tighten find until it catches only what it should. Use revise for one-off changes.',
      parameters: {
        type: 'object',
        properties: {
          ...selectorProps,
          find: { type: 'string', description: 'A JavaScript regular expression for the text to change, e.g. ^\\d{1,3}\\s+ for a number at the very start of a block.' },
          find_flags: { type: 'string', description: 'Flags for find, e.g. "g" for every match in a block, "i" for case-insensitive.' },
          replace: { type: 'string', description: 'What each match becomes; empty deletes it.' },
          reason: { type: 'string', description: 'Short label, e.g. "paragraph number". Changes are grouped by it for review.' },
          dry_run: { type: 'boolean' },
        },
        required: ['find', 'replace', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        if (typeof a['find'] !== 'string' || a['find'].length === 0) throw new Error('find must be a non-empty regular expression string');
        if (typeof a['replace'] !== 'string') throw new Error('replace must be a string (empty deletes)');
        const flags = typeof a['find_flags'] === 'string' ? a['find_flags'].replace(/y/g, '') : '';
        let find: RegExp;
        try {
          find = new RegExp(a['find'], flags);
        } catch (err) {
          throw new Error(`find will not compile: ${(err as Error).message}`);
        }
        const probe = regex(a['find'], flags);
        const selected = ['ids', 'pattern', 'span', 'range'].some((k) => a[k] !== undefined)
          ? select(a)
          : live.filter((b) => a['chapter'] === undefined || b.chapter === Number(a['chapter']));
        const changes: { b: Live; before: string; after: string }[] = [];
        let emptied = 0;
        let inStructure = 0;
        for (const b of selected) {
          if (struckMark(b)) continue;
          const before = textOf(b);
          if (!probe.test(before)) continue;
          if (structured(b)) { inStructure += 1; continue; }
          find.lastIndex = 0;
          const after = before.replace(find, a['replace']);
          if (after === before) continue;
          if (after.trim().length === 0) { emptied += 1; continue; }
          changes.push({ b, before, after });
        }
        const show = (n: number): string => {
          const step = Math.max(1, changes.length / n);
          const picked = changes.length <= n ? changes : Array.from({ length: n }, (_, i) => changes[Math.floor(i * step)]!);
          return picked.map((c) => `${c.b.id}\n  - ${clip(c.before, 140)}\n  + ${clip(c.after, 140)}`).join('\n');
        };
        const where = `By chapter: ${perChapter(changes.map((c) => c.b)) || 'none'}`;
        const refused = (emptied > 0 ? ` ${emptied} block(s) skipped because the change would leave them empty (use mark to remove a block).` : '')
          + structuredSkip(inStructure);
        const pattern = `/${clip(a['find'], 24)}/`;
        if (a['dry_run'] === true) {
          return {
            content: `WOULD REVISE ${changes.length} blocks. ${where}.${refused}\n${show(12)}`,
            said: { verb: 'dry run:', detail: words(`${changes.length} would change`, pattern, quoted(reason)) },
          };
        }
        for (const c of changes) {
          if (c.after === c.b.text) marks.delete(c.b.id);
          else marks.set(c.b.id, { kind: 'text', reason, after: c.after });
        }
        return {
          content: `REVISED ${changes.length} blocks as "${reason}". ${where}.${refused}\n${show(6)}\n${totals()}`,
          said: { verb: 'revised', detail: words(String(changes.length), pattern, quoted(reason)) },
        };
      },
      aim: (a) => ({
        verb: 'revise',
        detail: words(typeof a['find'] === 'string' ? `/${clip(a['find'], 24)}/` : '', quoted(a['reason'])),
      }),
    },
    /*
     * ── WHAT KIND OF BLOCK IT IS (Owen, 2026-11-01) ─────────────────────────
     *
     * *"if something is marked as a footnote but its really a chapter title, it
     * has the tools it needs to correct that?"* It had not: read showed the
     * [Footnote] and nothing could change it. This is `mark`'s shape for the
     * block's kind — one id, or a selector, narrowed by the kind a block is now,
     * dry run first — and, for a heading, the division above it, since a title
     * and a chapter start are two things in this book.
     */
    {
      name: 'recategorize',
      description: `Change what KIND of block blocks are (a heading read as a footnote, a quotation read as body text), with a short reason the person will review the changes under. Kinds, exactly as spelled: ${CATEGORIES.join(', ')}. Give id for one block, or a selector (ids, pattern, span or range, optionally chapter), and/or category_is to take only blocks that are currently that kind; category_is alone takes every block of that kind. starts_chapter:true also starts a chapter at each block (only when the new kind is Title or Section-header), titled with the block's words unless chapter_title is given (one block only); starts_chapter:false takes away a chapter that starts at the block. A heading does not start a chapter unless you say so. Blocks marked for removal, joined away or split are skipped. ALWAYS use dry_run:true first when you use a selector or category_is.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'One block to change.' },
          ...selectorProps,
          category_is: categoryIsProp,
          category: { type: 'string', enum: [...CATEGORIES], description: 'The kind the blocks become.' },
          starts_chapter: { type: 'boolean', description: 'true: a chapter starts at each block. false: no chapter starts there. Omit to leave the chapters as they are.' },
          chapter_title: { type: 'string', description: 'The chapter\'s title, when one block starts a chapter and its own words are not the title.' },
          reason: { type: 'string', description: 'Short label, e.g. "chapter heading read as a footnote". Changes are grouped by it for review.' },
          dry_run: { type: 'boolean' },
        },
        required: ['category', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const to = categoryArg(a['category'], 'category');
        const kind = a['category_is'] === undefined ? null : categoryArg(a['category_is'], 'category_is');
        const selected = ['ids', 'pattern', 'span', 'range'].some((k) => a[k] !== undefined);
        let blocks: Live[];
        if (a['id'] !== undefined) {
          if (selected) throw new Error('give id or a selector (ids, pattern, span, range), not both');
          blocks = [liveBlock(a['id'])];
        } else if (selected) {
          blocks = select(a);
        } else if (kind !== null) {
          blocks = live.filter((b) => a['chapter'] === undefined || b.chapter === Number(a['chapter']));
        } else {
          throw new Error('give id, a selector (ids, pattern, span, range) or category_is to say which blocks');
        }
        if (kind !== null) blocks = blocks.filter((b) => categoryOf(b) === kind);

        const starts = a['starts_chapter'];
        if (starts !== undefined && typeof starts !== 'boolean') throw new Error('starts_chapter must be true or false');
        if (starts === true && !HEADINGS.has(to)) {
          throw new Error(`a chapter starts at a heading; give category Title or Section-header to start one, not ${to}`);
        }
        const named = a['chapter_title'];
        if (named !== undefined) {
          if (starts !== true) throw new Error('chapter_title goes with starts_chapter:true');
          if (typeof named !== 'string' || named.trim().length === 0) throw new Error('chapter_title must be the title\'s words');
          if (blocks.length !== 1) throw new Error(`chapter_title names one chapter, and this call takes ${blocks.length} blocks; let each be titled by its own words, or retype them one at a time`);
        }

        const skippedStruck = blocks.filter(struckMark).length;
        const skippedStructure = blocks.filter((b) => !struckMark(b) && (joinedMark(b) || splitMark(b))).length;
        const changes: { b: Live; retype: Retype }[] = [];
        let unchanged = 0;
        for (const b of blocks) {
          if (struckMark(b) || joinedMark(b) || splitMark(b)) continue;
          const had = startsAt.get(b.id) ?? null;
          let chapter: AskChapterChange | null = null;
          if (starts === true) {
            const title = typeof named === 'string' ? named.replace(/\s+/g, ' ').trim() : titleOf(b);
            if (had !== title) chapter = { start: true, title };
          } else if (starts === false && had !== null) {
            chapter = { start: false };
          }
          if (to === b.category && chapter === null) {
            unchanged += 1;
            if (a['dry_run'] !== true) retypes.delete(b.id);
            continue;
          }
          changes.push({ b, retype: { reason, to, chapter } });
        }
        const where = `By chapter: ${perChapter(changes.map((c) => c.b)) || 'none'}`;
        const notes = (skippedStruck > 0 ? ` ${skippedStruck} marked for removal, skipped.` : '')
          + structuredSkip(skippedStructure)
          + (unchanged > 0 ? ` ${unchanged} already ${to}${starts === undefined ? '' : ' with the chapter as asked'}, left as they are.` : '');
        const show = (n: number): string => {
          const step = Math.max(1, changes.length / n);
          const picked = changes.length <= n ? changes : Array.from({ length: n }, (_, i) => changes[Math.floor(i * step)]!);
          return picked.map((c) => `${c.b.id} [${categoryOf(c.b)} → ${c.retype.to}${chapterSaid(c.retype.chapter)}] ${clip(textOf(c.b), 140)}`).join('\n');
        };
        const chapters = changes.filter((c) => c.retype.chapter?.start === true).length;
        const toSaid = words(`→ ${to}`, chapters > 0 ? `(${chapters} start chapters)` : '', quoted(reason));
        if (a['dry_run'] === true) {
          return {
            content: `WOULD RETYPE ${changes.length} blocks. ${where}.${notes}\n${show(12)}`,
            said: { verb: 'dry run:', detail: `${changes.length} would be retyped ${toSaid}` },
          };
        }
        for (const c of changes) retypes.set(c.b.id, c.retype);
        return {
          content: `RETYPED ${changes.length} blocks as "${reason}". ${where}.${notes}\n${show(6)}\n${totals()}`,
          said: { verb: 'retyped', detail: `${changes.length} ${toSaid}` },
        };
      },
      aim: (a) => ({
        verb: 'retype',
        detail: words(
          typeof a['id'] === 'string' ? a['id'] : selectorSaid(a),
          typeof a['category_is'] === 'string' ? `[${a['category_is']}]` : '',
          typeof a['category'] === 'string' ? `→ ${a['category']}` : '',
        ),
      }),
    },
    /*
     * ── A CHAPTER'S NAME (Owen, 2026-11-02) ──────────────────────────────────
     *
     * Retitling a division is a `chapter set` on a block one already starts at,
     * which is exactly a retyping that keeps the kind — so it is kept as one, and
     * reviewed and undone as one ("chapter "2" renamed "Chapter Two"").
     */
    {
      name: 'rename_chapter',
      description: 'Give a chapter a new title, with a short reason. Name the chapter by its number from outline, or by the id of the block it starts at. Only a chapter that already starts there can be renamed; to start one, use recategorize with starts_chapter:true.',
      parameters: {
        type: 'object',
        properties: {
          chapter: { type: 'integer', description: 'The chapter number, from outline.' },
          id: { type: 'string', description: 'Or: the block the chapter starts at.' },
          title: { type: 'string', description: 'The new title.' },
          reason: { type: 'string', description: 'Short label, e.g. "chapter number only".' },
        },
        required: ['title', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const title = typeof a['title'] === 'string' ? a['title'].replace(/\s+/g, ' ').trim() : '';
        if (title.length === 0) throw new Error('title must be the new title\'s words');
        let at: string;
        if (a['chapter'] !== undefined) {
          const chapter = view.chapters[Number(a['chapter'])];
          if (chapter === undefined) throw new Error(`there is no chapter ${String(a['chapter'])}; outline lists them`);
          at = chapter.id;
        } else if (typeof a['id'] === 'string') {
          at = a['id'];
        } else {
          throw new Error('give chapter (its number) or id (the block it starts at)');
        }
        const b = liveBlock(at);
        if (struckMark(b)) throw new Error(`${b.id} is marked for removal; a chapter cannot start at a block that goes`);
        const pending = retypes.get(b.id);
        const had = pending?.chapter?.start === true ? pending.chapter.title : startsAt.get(b.id) ?? null;
        if (had === null || pending?.chapter?.start === false) {
          throw new Error(`no chapter starts at ${b.id}; use recategorize with starts_chapter:true to start one`);
        }
        const to = pending?.to ?? b.category;
        if (title === (startsAt.get(b.id) ?? null) && to === b.category) retypes.delete(b.id);
        else retypes.set(b.id, { reason: pending?.reason ?? reason, to, chapter: { start: true, title } });
        return {
          content: `RENAMED the chapter at ${b.id}: "${had}" → "${title}". ${totals()}`,
          said: { verb: 'renamed', detail: `"${clip(had, 24)}" → "${clip(title, 24)}"` },
        };
      },
      aim: (a) => ({
        verb: 'rename',
        detail: words(a['chapter'] !== undefined ? `ch ${String(a['chapter'])}` : typeof a['id'] === 'string' ? a['id'] : '', quoted(a['title'])),
      }),
    },
    /*
     * ── PROSE BROKEN BY A PICTURE (Owen, 2026-11-02) ─────────────────────────
     *
     * *"there are some cases where a sentence was split in half by a picture
     * and its accompanying caption ... remove them ... and then join blocks to
     * the one above them so the sentences continue."* The model could strike
     * the picture and the caption and had nothing to put the two halves of the
     * sentence back together with. This is the seam gesture (`MergeOp`): the
     * later block goes into the earlier one, which keeps its name, with one
     * space between — the replay's join, not a revision that copies words.
     */
    {
      name: 'join',
      description: 'Join a block onto the block it continues, so a paragraph broken in two (by a picture, a caption or a page turn) reads as one, with a short reason. The block goes INTO the previous block that is not marked for removal, unless into names an earlier block of the same chapter; the joined words get one space between them. Mark the picture and caption for removal first. A chain is fine: join C to B and B to A. A block that starts a chapter, a footnote, or a block revised or split cannot be joined. Use dry_run:true to see the seam.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The block that continues the one before it.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Or several, each joined to the block before it.' },
          into: { type: 'string', description: 'The earlier block to join it to (default: the previous block not marked for removal). Only with id.' },
          reason: { type: 'string', description: 'Short label, e.g. "sentence broken by a picture".' },
          dry_run: { type: 'boolean' },
        },
        required: ['reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        if ((a['id'] === undefined) === (a['ids'] === undefined)) throw new Error('give id or ids');
        if (a['ids'] !== undefined && a['into'] !== undefined) throw new Error('into goes with one id; with ids each block joins the one before it');
        const ids: unknown[] = a['id'] !== undefined ? [a['id']] : Array.isArray(a['ids']) ? a['ids'] : [];
        if (ids.length === 0) throw new Error('ids must be a non-empty array of block ids');
        const blocks = ids.map((id) => liveBlock(id)).sort((x, y) => x.index - y.index);
        const planned: { b: Live; into: Live }[] = [];
        for (const b of blocks) {
          let into: Live;
          if (a['into'] !== undefined) {
            into = liveBlock(a['into'], 'into');
            if (into.index >= b.index) throw new Error(`${into.id} comes after ${b.id}; a block joins an EARLIER block`);
          } else {
            const before = previousKept(b);
            if (before === null) throw new Error(`${b.id} is the first block left in the book, so there is nothing before it to join`);
            into = before;
          }
          if (into.chapter !== b.chapter) {
            throw new Error(`${b.id} is in ch ${b.chapter} and ${into.id} in ch ${into.chapter}; a join never crosses a chapter`);
          }
          if (startsAt.has(b.id) || retypes.get(b.id)?.chapter?.start === true) {
            throw new Error(`a chapter starts at ${b.id}; take the chapter away first if it really continues ${into.id}`);
          }
          for (const one of [b, into]) {
            if (struckMark(one)) throw new Error(`${one.id} is marked for removal; unmark it first to join it`);
            if (categoryOf(one) === 'Footnote') throw new Error(`${one.id} is a footnote, and a note is never joined to anything`);
            if (revisedMark(one)) throw new Error(`${one.id} is revised; a block is joined with its own words, so unmark the revision first`);
            if (splitMark(one)) throw new Error(`${one.id} is split; unmark the split first`);
          }
          if (retypedMark(b)) throw new Error(`${b.id} is retyped, and a block joined away keeps none of its kind; unmark the retyping first`);
          planned.push({ b, into });
        }
        const show = planned.map((p) => `${p.b.id} → ${p.into.id}: ${seam(p.into, p.b)}`).join('\n');
        if (a['dry_run'] === true) {
          return {
            content: `WOULD JOIN ${planned.length}:\n${show}`,
            said: { verb: 'dry run:', detail: words(`${planned.length} would be joined`, quoted(reason)) },
          };
        }
        for (const p of planned) joins.set(p.b.id, { reason, into: p.into.id });
        return {
          content: `JOINED ${planned.length} as "${reason}":\n${show}\n${totals()}`,
          said: {
            verb: 'joined',
            detail: words(planned.length === 1 ? `${planned[0]!.b.id} → ${planned[0]!.into.id}` : String(planned.length), quoted(reason)),
          },
        };
      },
      aim: (a) => ({
        verb: 'join',
        detail: words(typeof a['id'] === 'string' ? a['id'] : Array.isArray(a['ids']) ? `${a['ids'].length} blocks` : '', quoted(a['reason'])),
      }),
    },
    /*
     * ── TWO BLOCKS READ AS ONE (Owen, 2026-11-02) ────────────────────────────
     *
     * A heading run into the paragraph after it, two paragraphs the reader
     * missed the break between. The cut is the replay's (`SplitOp`), at the
     * first character of an exact quote, and each half may be given its kind —
     * a split-off heading as a Section-header is one decision, reviewed as one.
     */
    {
      name: 'split',
      description: 'Cut one block in two where the second part begins, with a short reason: a heading run into the paragraph after it, or two paragraphs read as one. at_quote is the exact text the SECOND half starts with (give occurrence if it occurs more than once). Each half is trimmed at the cut. first_category and second_category give a half a new kind (e.g. first_category:"Section-header" for a heading split off the top). Footnotes cannot be split. Use dry_run:true first.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The block to cut.' },
          at_quote: { type: 'string', description: 'Exact text the second half begins with.' },
          occurrence: { type: 'integer', description: 'Which occurrence of at_quote, 1 for the first. Needed only when it occurs more than once.' },
          first_category: { type: 'string', enum: [...CATEGORIES], description: 'The first half\'s new kind, if it changes.' },
          second_category: { type: 'string', enum: [...CATEGORIES], description: 'The second half\'s new kind, if it changes.' },
          reason: { type: 'string', description: 'Short label, e.g. "heading run into the text".' },
          dry_run: { type: 'boolean' },
        },
        required: ['id', 'at_quote', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const b = liveBlock(a['id']);
        if (struckMark(b) || revisedMark(b) || retypedMark(b) || joinedMark(b) || joinedIntoMark(b) || splitMark(b)) {
          throw new Error(`${b.id} already carries a mark, revision, retyping, join or split; unmark it first to cut it`);
        }
        if (b.category === 'Footnote') throw new Error(`${b.id} is a footnote, and a note is never cut in two`);
        const at = locate(b.text, a['at_quote'], a['occurrence'], b.id, 'at_quote');
        const first = b.text.slice(0, at).trimEnd();
        const second = b.text.slice(at).trimStart();
        if (first.length === 0 || second.length === 0) throw new Error('the cut must leave words on both sides');
        const firstCategory = a['first_category'] === undefined ? null : categoryArg(a['first_category'], 'first_category');
        const secondCategory = a['second_category'] === undefined ? null : categoryArg(a['second_category'], 'second_category');
        if (firstCategory === 'Footnote' || secondCategory === 'Footnote') throw new Error('a split never makes a footnote');
        const kinds = firstCategory !== null || secondCategory !== null
          ? ` (${firstCategory ?? b.category} | ${secondCategory ?? b.category})` : '';
        const show = `${b.id}${kinds}:\n  1: ${clip(first, 200)}\n  2: ${clip(second, 200)}`;
        if (a['dry_run'] === true) {
          return { content: `WOULD SPLIT ${show}`, said: { verb: 'dry run:', detail: words(`${b.id} would be split`, quoted(reason)) } };
        }
        splits.set(b.id, { reason, at, first, second, firstCategory, secondCategory });
        return {
          content: `SPLIT ${show}\nThe halves become ${b.id}/1 and ${b.id}/2 when the person keeps it. ${totals()}`,
          said: { verb: 'split', detail: words(b.id, quoted(reason)) },
        };
      },
      aim: (a) => ({ verb: 'split', detail: words(typeof a['id'] === 'string' ? a['id'] : '', quoted(a['reason'])) }),
    },
    /*
     * ── A BLOCK REMOVED BY MISTAKE (Owen, 2026-11-02) ────────────────────────
     *
     * The person's strikes were hidden from the model entirely, so it could
     * not see a paragraph struck with the picture beside it. `read
     * only:"struck"` shows them; this proposes one back (`RestoreOp`).
     */
    {
      name: 'restore',
      description: 'Propose bringing back blocks the PERSON removed (read only:"struck" to see them), with a short reason — for blocks removed by mistake. Give ids.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Ids of struck blocks.' },
          reason: { type: 'string', description: 'Short label, e.g. "body text struck with the caption".' },
        },
        required: ['ids', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const ids = a['ids'];
        if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
          throw new Error('ids must be a non-empty array of block ids');
        }
        const notStruck = ids.filter((id) => !goneById.has(id));
        if (notStruck.length > 0) {
          throw new Error(`not blocks the person struck: ${notStruck.slice(0, 10).join(', ')}; read only:"struck" lists them`);
        }
        for (const id of ids) restores.set(id, reason);
        return {
          content: `RESTORE proposed for ${ids.length} as "${reason}". ${totals()}`,
          said: { verb: 'restored', detail: words(String(ids.length), quoted(reason)) },
        };
      },
      aim: (a) => ({ verb: 'restore', detail: quoted(a['reason']) }),
    },
    /*
     * ── A NOTE AND ITS NUMBER (Owen, 2026-11-02) ─────────────────────────────
     *
     * The hand link (`LinkOp`): bind a note to the number printed for it, by
     * the characters of that number in the block. The replay refuses two
     * numbers on one run of characters; this refuses it first, by name.
     */
    {
      name: 'link_footnote',
      description: 'Bind a footnote to the number printed for it in another block, with a short reason. note is the footnote\'s id; block is where its number is printed; number is the exact characters of that number (e.g. "²" or "2"); occurrence says which, when they occur more than once in the block. read only:"unlinked" shows notes nothing points at and numbers no note carries.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The footnote block.' },
          block: { type: 'string', description: 'The block its number is printed in.' },
          number: { type: 'string', description: 'The exact characters of the number in that block.' },
          occurrence: { type: 'integer', description: 'Which occurrence of number, 1 for the first.' },
          reason: { type: 'string', description: 'Short label, e.g. "note number not linked".' },
        },
        required: ['note', 'block', 'number', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const note = liveBlock(a['note'], 'note');
        if (categoryOf(note) !== 'Footnote') throw new Error(`${note.id} is ${categoryOf(note)}, not a footnote`);
        if (struckMark(note)) throw new Error(`${note.id} is marked for removal`);
        const block = liveBlock(a['block'], 'block');
        if (block.id === note.id) throw new Error('a note\'s number is printed in another block');
        if (revisedMark(block) || structured(block)) {
          throw new Error(`${block.id} is revised, joined or split, so its characters are not where the book has them; unmark that first`);
        }
        const at = locate(block.text, a['number'], a['occurrence'], block.id, 'number');
        const len = (a['number'] as string).length;
        const overlaps = (x: { at: number; len: number }): boolean => at < x.at + x.len && x.at < at + len;
        for (const other of live) {
          for (const ref of other.refs ?? []) {
            if (ref.block === block.id && overlaps(ref)) {
              throw new Error(`those characters of ${block.id} are already the number of note ${other.id}`);
            }
          }
        }
        if (links.some((l) => l.block === block.id && overlaps(l))) {
          throw new Error(`those characters of ${block.id} already have a link proposed`);
        }
        links.push({ reason, note: note.id, block: block.id, at, len });
        return {
          content: `LINKED ${note.id} to "${a['number'] as string}" at ${at} in ${block.id}. ${totals()}`,
          said: { verb: 'linked', detail: `${note.id} → ${block.id}` },
        };
      },
      aim: (a) => ({ verb: 'link', detail: words(typeof a['note'] === 'string' ? a['note'] : '', typeof a['block'] === 'string' ? `→ ${a['block']}` : '') }),
    },
    /*
     * ── POINTING, WHICH CHANGES NOTHING (Owen, 2026-11-02) ───────────────────
     *
     * The answer to "where is …", or the evidence behind a summary, as places
     * the person can click to go to. Not a mark: nothing lands from it.
     */
    {
      name: 'highlight',
      description: 'Point the person at a place in the book, changing nothing: a block, and optionally the exact words in it, with a short note. Use it when the person asks where something is, or to show the evidence for what you say in your summary. The person sees a list of these and can click each to go there.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The block.' },
          quote: { type: 'string', description: 'Exact words inside the block to light; omit for the whole block.' },
          note: { type: 'string', description: 'What this place is, in a few words.' },
        },
        required: ['id', 'note'],
      },
      run(a) {
        const b = liveBlock(a['id']);
        const note = typeof a['note'] === 'string' ? a['note'].trim() : '';
        if (note.length === 0) throw new Error('note is required');
        let quote: string | null = null;
        if (a['quote'] !== undefined) {
          if (typeof a['quote'] !== 'string' || a['quote'].length === 0) throw new Error('quote must be exact words in the block');
          if (!b.text.includes(a['quote'])) throw new Error(`"${clip(a['quote'], 60)}" does not occur in ${b.id}'s text`);
          quote = a['quote'];
        }
        highlights.push({ id: b.id, quote, note });
        return {
          content: `HIGHLIGHTED ${b.id}${quote === null ? '' : ` "${clip(quote, 60)}"`}: ${note}. ${highlights.length} places so far.`,
          said: { verb: 'pointed at', detail: words(b.id, quoted(note)) },
        };
      },
      aim: (a) => ({ verb: 'point at', detail: typeof a['id'] === 'string' ? a['id'] : '' }),
    },
    /*
     * ── THE BOOK'S HISTORY (Owen, 2026-11-02) ────────────────────────────────
     *
     * Every edit, newest first — the person's, Ask's, a panel's — saved,
     * unsaved and undone; and any of them proposed back as a mark (`revert`),
     * whose inverse is the review card's own undo (shared/ask-history.ts).
     */
    {
      name: 'history',
      description: 'The book\'s edits, newest first: unsaved ones, saved ones back to the import, and ones the person undid (on the redo pile). Each has a handle (c12, r0), what it did in plain words, the block\'s words just before it, and who made it where known (an Ask run and its reason). Filter by id (edits naming that block) or kind (strike, restore, text, category, merge, split, chapter, link, unlink, insert, move). Page with offset and count. Use it when the person says something was wrongly removed or changed, or asks what happened to a block.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Only edits naming this block.' },
          kind: { type: 'string', description: 'Only edits of this kind (the op word).' },
          offset: { type: 'integer', description: 'Skip this many of the newest matches (default 0).' },
          count: { type: 'integer', description: 'How many, at most 60 (default 25).' },
        },
      },
      run(a) {
        if (history === null) throw new Error('this book\'s history was not sent with the question, so it cannot be read');
        const filter = {
          ...(typeof a['id'] === 'string' ? { id: a['id'] } : {}),
          ...(typeof a['kind'] === 'string' ? { kind: a['kind'] } : {}),
          ...(typeof a['offset'] === 'number' ? { offset: a['offset'] } : {}),
          ...(typeof a['count'] === 'number' ? { count: a['count'] } : {}),
        };
        const { entries, matched } = history.list(filter);
        const offset = filter.offset ?? 0;
        const lines = entries.map((e) => `${e.handle} [${e.where}] ${e.said}${e.text.length > 0 ? ` — "${e.text}"` : ''} (${e.from})`);
        const more = offset + entries.length < matched ? `\n(${matched - offset - entries.length} older; offset:${offset + entries.length} for the next page)` : '';
        return {
          content: `${matched} of ${history.size()} edits match.\n${lines.join('\n') || '(none)'}${more}`,
          said: { verb: 'read history', detail: words(String(matched), this.aim(a).detail) },
        };
      },
      aim: (a) => ({
        verb: 'read history',
        detail: words(typeof a['id'] === 'string' ? `of ${a['id']}` : '', typeof a['kind'] === 'string' ? `[${a['kind']}]` : ''),
      }),
    },
    {
      name: 'revert',
      description: 'Propose taking back earlier edits from history, by handle, with a short reason. Nothing is popped off the person\'s undo stack: each becomes a change the person reviews like any other ("undo: struck e-579"). An edit whose block has changed since in a way that makes the undo wrong is refused with the reason. Undone edits (r…) cannot be reverted. Use dry_run:true first.',
      parameters: {
        type: 'object',
        properties: {
          handles: { type: 'array', items: { type: 'string' }, description: 'History handles, e.g. ["c41", "c40"].' },
          reason: { type: 'string', description: 'Short label, e.g. "struck by mistake with the caption".' },
          dry_run: { type: 'boolean' },
        },
        required: ['handles', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        if (history === null) throw new Error('this book\'s history was not sent with the question, so nothing in it can be reverted');
        const handles = a['handles'];
        if (!Array.isArray(handles) || handles.length === 0 || !handles.every((h) => typeof h === 'string')) {
          throw new Error('handles must be a non-empty array of history handles');
        }
        const planned: { handle: string; revert: Revert }[] = [];
        for (const handle of new Set(handles as string[])) {
          if (reverts.has(handle)) throw new Error(`${handle} is already proposed; unmark it first to change its reason`);
          const original = history.revertable(handle, reason);
          const entry = history.entry(handle)!;
          const ids = opIds(entry.op);
          for (const id of ids) {
            const b = byId.get(id);
            if (b !== undefined && (marks.has(id) || retypes.has(id) || structured(b) || linksOf(id).length > 0)) {
              throw new Error(`${id} also carries a change from this run; unmark that first, so the two do not land on each other`);
            }
            if (restores.has(id)) throw new Error(`${id} also has a restore proposed in this run; unmark it first`);
          }
          for (const other of reverts.values()) {
            if (other.ids.some((id) => ids.includes(id))) throw new Error(`${handle} names a block another revert in this run names; revert one at a time`);
          }
          planned.push({ handle, revert: { reason, said: entry.said, original, ids } });
        }
        const show = planned.map((p) => `${p.handle}: undo ${p.revert.said}`).join('\n');
        if (a['dry_run'] === true) {
          return { content: `WOULD REVERT ${planned.length}:\n${show}`, said: { verb: 'dry run:', detail: words(`${planned.length} would be reverted`, quoted(reason)) } };
        }
        for (const p of planned) reverts.set(p.handle, p.revert);
        return {
          content: `REVERT proposed for ${planned.length} as "${reason}":\n${show}\n${totals()}`,
          said: { verb: 'reverted', detail: words(planned.length === 1 ? planned[0]!.handle : String(planned.length), quoted(reason)) },
        };
      },
      aim: (a) => ({ verb: 'revert', detail: words(Array.isArray(a['handles']) ? (a['handles'] as unknown[]).join(', ') : '', quoted(a['reason'])) }),
    },
    {
      name: 'unmark',
      description: 'Take marks, revisions, retypings, joins, splits, restores and links off: by selector, or every one with a given reason. A revised block goes back to its original text, a retyped one to its original kind and chapter.',
      parameters: {
        type: 'object',
        properties: {
          ...selectorProps,
          reason: { type: 'string', description: 'Unmark everything marked, revised, retyped, joined, split, restored or linked with exactly this reason.' },
        },
      },
      run(a) {
        const byReason = a['reason'] !== undefined && ['ids', 'pattern', 'span', 'range'].every((k) => a[k] === undefined);
        let n = 0;
        const dropLinks = (keep: (l: Link) => boolean): void => {
          for (let i = links.length - 1; i >= 0; i -= 1) {
            if (!keep(links[i]!)) { links.splice(i, 1); n += 1; }
          }
        };
        if (byReason) {
          const reason = a['reason'];
          for (const b of live) {
            if (marks.get(b.id)?.reason === reason && marks.delete(b.id)) n += 1;
            if (retypes.get(b.id)?.reason === reason && retypes.delete(b.id)) n += 1;
            if (joins.get(b.id)?.reason === reason && joins.delete(b.id)) n += 1;
            if (splits.get(b.id)?.reason === reason && splits.delete(b.id)) n += 1;
          }
          for (const [id, why] of [...restores]) if (why === reason && restores.delete(id)) n += 1;
          for (const [handle, r] of [...reverts]) if (r.reason === reason && reverts.delete(handle)) n += 1;
          dropLinks((l) => l.reason !== reason);
        } else {
          const ids = new Set<string>();
          // A struck block named by id is a restore to take back.
          if (Array.isArray(a['ids'])) {
            for (const id of a['ids']) {
              if (typeof id === 'string' && restores.delete(id)) n += 1;
            }
            const rest = a['ids'].filter((id) => typeof id === 'string' && byId.has(id));
            if (rest.length > 0) for (const b of select({ ...a, ids: rest })) ids.add(b.id);
          } else {
            for (const b of select(a)) ids.add(b.id);
          }
          for (const id of ids) {
            if (marks.delete(id)) n += 1;
            if (retypes.delete(id)) n += 1;
            if (joins.delete(id)) n += 1;
            if (splits.delete(id)) n += 1;
          }
          dropLinks((l) => !ids.has(l.note));
          for (const [handle, r] of [...reverts]) if (r.ids.some((id) => ids.has(id)) && reverts.delete(handle)) n += 1;
        }
        return {
          content: `Unmarked ${n}. ${totals()}`,
          said: { verb: 'unmarked', detail: words(String(n), byReason ? quoted(a['reason']) : selectorSaid(a)) },
        };
      },
      aim: (a) => ({ verb: 'unmark', detail: a['reason'] !== undefined ? quoted(a['reason']) : selectorSaid(a) }),
    },
    {
      name: 'marks_summary',
      description: 'Every reason used so far, whether it marks, revises, retypes, joins, splits, restores or links, how many blocks each holds, and examples.',
      parameters: { type: 'object', properties: {} },
      run() {
        type Kind = Mark['kind'] | 'category' | 'join' | 'split' | 'restore' | 'link';
        const groups = new Map<string, { kind: Kind; blocks: Live[] }>();
        const add = (kind: Kind, reason: string, b: Live): void => {
          const key = `${kind}\u0000${reason}`;
          const held = groups.get(key);
          if (held === undefined) groups.set(key, { kind, blocks: [b] });
          else held.blocks.push(b);
        };
        for (const b of live) {
          const mark = marks.get(b.id);
          if (mark !== undefined) add(mark.kind, mark.reason, b);
          const retype = retypes.get(b.id);
          if (retype !== undefined) add('category', retype.reason, b);
          const join = joins.get(b.id);
          if (join !== undefined) add('join', join.reason, b);
          const split = splits.get(b.id);
          if (split !== undefined) add('split', split.reason, b);
        }
        for (const l of links) add('link', l.reason, byId.get(l.note)!);
        const checked = { verb: 'checked its work', detail: '' };
        const said = { strike: 'marked', text: 'revised', category: 'retyped', join: 'joined', split: 'split', restore: 'restored', link: 'linked' } as const;
        const parts = [...groups.entries()].map(([key, g]) => {
          const reason = key.slice(key.indexOf('\u0000') + 1);
          return `"${reason}" (${said[g.kind]}): ${g.blocks.length}\n${examples(g.blocks, 3)}`;
        });
        const restoreReasons = new Map<string, Live[]>();
        for (const [id, why] of restores) {
          const held = restoreReasons.get(why);
          if (held === undefined) restoreReasons.set(why, [goneById.get(id)!]);
          else held.push(goneById.get(id)!);
        }
        for (const [why, blocks] of restoreReasons) {
          parts.push(`"${why}" (restored): ${blocks.length}\n${blocks.slice(0, 3).map((b) => goneLine(b, 160)).join('\n')}`);
        }
        const revertReasons = new Map<string, string[]>();
        for (const [handle, r] of reverts) revertReasons.set(r.reason, [...(revertReasons.get(r.reason) ?? []), `${handle}: undo ${r.said}`]);
        for (const [why, said] of revertReasons) parts.push(`"${why}" (reverted): ${said.length}\n${said.slice(0, 3).join('\n')}`);
        if (highlights.length > 0) {
          parts.push(`Places pointed at: ${highlights.length}\n${highlights.slice(-3).map((h) => `${h.id}: ${h.note}`).join('\n')}`);
        }
        if (parts.length === 0) return { content: 'Nothing marked, revised, retyped, joined, split, restored or linked yet.', said: checked };
        return { content: parts.join('\n\n'), said: checked };
      },
      aim: () => ({ verb: 'checked its work', detail: '' }),
    },
  ];

  return {
    tools,
    counts,
    call(name, args) {
      const tool = tools.find((t) => t.name === name);
      if (tool === undefined) {
        return {
          content: `couldn't run ${name}: there is no tool "${name}"; the tools are ${tools.map((t) => t.name).join(', ')}`,
          said: { verb: name, detail: 'is not a tool' },
        };
      }
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = args ? JSON.parse(args) : {};
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error('the arguments must be a JSON object');
        }
        parsed = value as Record<string, unknown>;
        return tool.run(parsed);
      } catch (err) {
        // A refusal is the tool's answer; the model reads it and corrects itself.
        const aim = tool.aim(parsed);
        return {
          content: `couldn't run ${name}: ${(err as Error).message}`,
          said: { verb: aim.verb, detail: words(aim.detail, 'refused') },
        };
      }
    },
    state() {
      const summary = tools.find((t) => t.name === 'marks_summary')!.run({}).content;
      return `[The work so far, as the tools hold it now. ${totals()}]\n${summary}`;
    },
    highlights: () => [...highlights],
    items() {
      const out: AskMark[] = [];
      for (const b of live) {
        const mark = marks.get(b.id);
        if (mark !== undefined) {
          out.push(mark.kind === 'strike'
            ? { id: b.id, kind: 'strike', reason: mark.reason, before: b.text }
            : { id: b.id, kind: 'text', reason: mark.reason, before: b.text, after: mark.after });
        }
        const retype = retypes.get(b.id);
        if (retype !== undefined) {
          out.push({
            id: b.id,
            kind: 'category',
            reason: retype.reason,
            before: b.text,
            from: b.category,
            to: retype.to,
            chapter: retype.chapter,
            chapterBefore: startsAt.get(b.id) ?? null,
          });
        }
        const split = splits.get(b.id);
        if (split !== undefined) {
          out.push({
            id: b.id,
            kind: 'split',
            reason: split.reason,
            before: b.text,
            from: b.category,
            at: split.at,
            first: split.first,
            second: split.second,
            firstCategory: split.firstCategory,
            secondCategory: split.secondCategory,
            chapterBefore: startsAt.get(b.id) ?? null,
          });
        }
        const join = joins.get(b.id);
        if (join !== undefined) {
          const into = byId.get(join.into)!;
          out.push({
            id: b.id,
            kind: 'join',
            reason: join.reason,
            before: b.text,
            category: b.category,
            into: into.id,
            intoBefore: into.text,
          });
        }
        for (const l of links.filter((one) => one.note === b.id)) {
          out.push({
            id: b.id,
            kind: 'link',
            reason: l.reason,
            before: b.text,
            block: l.block,
            at: l.at,
            len: l.len,
            blockBefore: byId.get(l.block)!.text,
          });
        }
      }
      for (const b of gone) {
        const why = restores.get(b.id);
        if (why !== undefined) out.push({ id: b.id, kind: 'restore', reason: why, before: b.text });
      }
      for (const [handle, r] of reverts) {
        out.push({ id: r.original.id, kind: 'revert', reason: r.reason, before: r.original.before, handle, said: r.said, original: r.original });
      }
      return out;
    },
  };
}

/**
 * WHERE EXACT WORDS FALL IN A BLOCK — the first character of `quote`, or of its
 * `occurrence`th time. `applyEdits`' rule for a find: a quote that occurs twice
 * is refused unless the call says which.
 */
function locate(text: string, quote: unknown, occurrence: unknown, id: string, field: string): number {
  if (typeof quote !== 'string' || quote.length === 0) throw new Error(`${field} must be exact text in ${id}`);
  const at: number[] = [];
  for (let from = text.indexOf(quote); from !== -1; from = text.indexOf(quote, from + quote.length)) at.push(from);
  if (at.length === 0) throw new Error(`"${clip(quote, 80)}" does not occur in ${id}'s text`);
  if (occurrence === undefined) {
    if (at.length > 1) throw new Error(`"${clip(quote, 80)}" occurs ${at.length} times in ${id}; give occurrence (1 to ${at.length}) to say which`);
    return at[0]!;
  }
  if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > at.length) {
    throw new Error(`occurrence must be a whole number from 1 to ${at.length}`);
  }
  return at[occurrence - 1]!;
}

/**
 * THE SUBSTITUTIONS OF ONE `revise` CALL, all or none.
 *
 * Applied in order, each against the text the previous one left — the way a
 * person reads "change X, then change Y" — and a refusal anywhere refuses the
 * call whole, so a revision is never half of what the model asked for.
 *
 * A `find` that occurs more than once is refused unless `occurrence` says which:
 * "the" in a paragraph is ten places, and guessing the first would be an edit
 * nobody chose. Occurrences are counted without overlap, left to right.
 */
export function applyEdits(text: string, edits: readonly unknown[], id: string): string {
  let out = text;
  edits.forEach((raw, i) => {
    const n = i + 1;
    if (typeof raw !== 'object' || raw === null) throw new Error(`edit ${n} must be {find, replace}`);
    const edit = raw as Record<string, unknown>;
    const find = edit['find'];
    const replace = edit['replace'];
    if (typeof find !== 'string' || find.length === 0) throw new Error(`edit ${n}: find must be non-empty text`);
    if (typeof replace !== 'string') throw new Error(`edit ${n}: replace must be text (empty to delete)`);
    const at: number[] = [];
    for (let from = out.indexOf(find); from !== -1; from = out.indexOf(find, from + find.length)) at.push(from);
    if (at.length === 0) {
      throw new Error(`edit ${n}: "${clip(find, 80)}" does not occur in ${id}'s current text${i > 0 ? ' (after the edits before it)' : ''}; no edits were applied`);
    }
    const occurrence = edit['occurrence'];
    let pick: number;
    if (occurrence === undefined) {
      if (at.length > 1) {
        throw new Error(`edit ${n}: "${clip(find, 80)}" occurs ${at.length} times in ${id}; give occurrence (1 to ${at.length}) to say which; no edits were applied`);
      }
      pick = at[0]!;
    } else {
      if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > at.length) {
        throw new Error(`edit ${n}: occurrence must be a whole number from 1 to ${at.length}; no edits were applied`);
      }
      pick = at[occurrence - 1]!;
    }
    out = out.slice(0, pick) + replace + out.slice(pick + find.length);
  });
  return out;
}
