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
 */
import type { AskBlock, AskMark, AskView } from '../shared/ask';

/** One tool as the chat sends it, and its handler. */
export interface AskTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  run(args: Record<string, unknown>): string;
}

type Mark = { kind: 'strike'; reason: string } | { kind: 'text'; reason: string; after: string };

/** The tools, and the marks they keep. */
export interface AskToolbox {
  readonly tools: readonly AskTool[];
  /** Every mark, in reading order. */
  items(): AskMark[];
  /** How many blocks are marked for removal, and how many revised. */
  counts(): { struck: number; revised: number };
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

interface Live extends AskBlock {
  readonly index: number;
}

export function askToolbox(view: AskView): AskToolbox {
  const live: Live[] = view.blocks.map((b, index) => ({ ...b, index }));
  const byId = new Map(live.map((b) => [b.id, b]));
  const marks = new Map<string, Mark>();

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

  function line(b: Live, n = 200): string {
    const mark = marks.get(b.id);
    const said = mark === undefined
      ? ''
      : mark.kind === 'strike' ? ` [MARKED: ${mark.reason}]` : ` [REVISED: ${mark.reason}]`;
    const head = b.category === 'Text' ? '' : ` [${b.category}]`;
    return `${b.id}${head}${said} ${clip(textOf(b), n)}`;
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
    throw new Error('only must be "all", "unmarked", "marked" or "revised"');
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

  function counts(): { struck: number; revised: number } {
    let struck = 0;
    let revised = 0;
    for (const mark of marks.values()) {
      if (mark.kind === 'strike') struck += 1;
      else revised += 1;
    }
    return { struck, revised };
  }

  function totals(): string {
    const { struck, revised } = counts();
    return `Total marked: ${struck}${revised > 0 ? `, revised: ${revised}` : ''}.`;
  }

  function reasonOf(a: Record<string, unknown>): string {
    const reason = a['reason'];
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('reason is required');
    return reason.trim();
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
  const onlyProp = { type: 'string', enum: ['all', 'unmarked', 'marked', 'revised'] };

  const tools: AskTool[] = [
    {
      name: 'outline',
      description: 'The book\'s chapters: number, title, first block id, how many live blocks and how many are marked or revised. Start here.',
      parameters: { type: 'object', properties: {} },
      run() {
        const rows = view.chapters.map((c, i) => {
          const blocks = live.filter((b) => b.chapter === i);
          if (blocks.length === 0) return `ch${i} "${c.title}" — already removed`;
          const revised = blocks.filter(revisedMark).length;
          return `ch${i} "${c.title}" first=${blocks[0]!.id} blocks=${blocks.length} marked=${blocks.filter(struckMark).length}`
            + (revised > 0 ? ` revised=${revised}` : '');
        });
        const before = live.filter((b) => b.chapter === -1).length;
        const { struck, revised } = counts();
        return [
          `"${view.title}": ${live.length} live blocks, ${view.struck} already struck by the person (hidden), ${struck} marked, ${revised} revised.`,
          before ? `${before} blocks before the first chapter.` : '',
          ...rows,
        ].filter(Boolean).join('\n');
      },
    },
    {
      name: 'read',
      description: 'Read blocks in order from a block id, one per line: id, mark if any, text (clipped unless full). Use only:"unmarked" to review what is left.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Block id to start at (default: the first block).' },
          count: { type: 'integer', description: 'How many blocks, at most 80 (default 40).' },
          full: { type: 'boolean', description: 'Whole text instead of the first 200 characters.' },
          only: onlyProp,
          chapter: { type: 'integer', description: 'Read this chapter from its start instead of from.' },
        },
      },
      run(a) {
        const count = Math.min(80, Math.max(1, Number(a['count'] ?? 40)));
        const keep = filtered(a['only']);
        let i = a['chapter'] !== undefined ? live.findIndex((b) => b.chapter === Number(a['chapter'])) : position(a['from']);
        if (i < 0) throw new Error(`chapter ${String(a['chapter'])} has no live blocks`);
        const out: string[] = [];
        let lastChapter = -2;
        for (; i < live.length && out.length < count; i += 1) {
          const b = live[i]!;
          if (!keep(b)) continue;
          if (b.chapter !== lastChapter) {
            out.push(`— ch${b.chapter} "${chapterTitle(b.chapter)}" —`);
            lastChapter = b.chapter;
          }
          out.push(line(b, a['full'] === true ? 2000 : 200));
        }
        out.push(i < live.length ? `(next: ${live[i]!.id})` : '(end of book)');
        return out.join('\n');
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
          show: { type: 'integer', description: 'How many examples, at most 30 (default 10).' },
        },
        required: ['pattern'],
      },
      run(a) {
        const re = regex(a['pattern'], a['flags']);
        const keep = filtered(a['only']);
        const hits = live.filter((b) => keep(b)
          && (a['chapter'] === undefined || b.chapter === Number(a['chapter'])) && re.test(textOf(b)));
        const show = Math.min(30, Math.max(1, Number(a['show'] ?? 10)));
        return `${hits.length} matches (${hits.filter(struckMark).length} already marked). By chapter: ${perChapter(hits) || 'none'}\n${examples(hits, show)}`;
      },
    },
    {
      name: 'mark',
      description: 'Mark blocks for removal, with a short reason the person will review them under. Give exactly one selector. Use dry_run:true first to see what a selector catches.',
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
        const fresh = blocks.filter((b) => !struckMark(b));
        const revised = fresh.filter(revisedMark).length;
        const summary = `${blocks.length} blocks (${blocks.length - fresh.length} already marked). By chapter: ${perChapter(blocks) || 'none'}`;
        if (a['dry_run'] === true) {
          return `WOULD MARK ${summary}${revised > 0 ? `; ${revised} of them are revised, and marking drops the revision` : ''}\n${examples(blocks, 12)}`;
        }
        for (const b of fresh) marks.set(b.id, { kind: 'strike', reason });
        return `MARKED ${fresh.length} new as "${reason}". ${summary}.`
          + (revised > 0 ? ` ${revised} had been revised; the revision is dropped, since the block goes.` : '')
          + ` ${totals()}`;
      },
    },
    {
      name: 'revise',
      description: 'Change words inside ONE block by exact substitution, with a short reason the person will review it under. Each edit replaces the text find with replace; find must occur in the block\'s current text exactly once, or give occurrence (1 = first) to say which. Edits apply in order, and either all of a call\'s edits apply or none do. Use mark, not revise, to remove a whole block.',
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
          reason: { type: 'string', description: 'Short label, e.g. "spelled-out number". Changes are grouped by it for review.' },
          dry_run: { type: 'boolean' },
        },
        required: ['id', 'edits', 'reason'],
      },
      run(a) {
        const reason = reasonOf(a);
        const id = a['id'];
        if (typeof id !== 'string') throw new Error('id must be a block id');
        const b = byId.get(id);
        if (b === undefined) throw new Error(`there is no live block ${id} (it may be struck already, or not exist)`);
        if (struckMark(b)) {
          throw new Error(`${id} is marked for removal; unmark it first if it should stay and be changed`);
        }
        const edits = a['edits'];
        if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array of {find, replace}');
        const before = textOf(b);
        const after = applyEdits(before, edits, id);
        if (after.trim().length === 0) {
          throw new Error(`that would leave ${id} empty; use mark to remove a block`);
        }
        if (a['dry_run'] === true) return `WOULD REVISE ${id}:\n- ${clip(before, 400)}\n+ ${clip(after, 400)}`;
        if (after === b.text) {
          marks.delete(id);
          return `${id} is back to its original text, so it is no longer revised. ${totals()}`;
        }
        marks.set(id, { kind: 'text', reason, after });
        return `REVISED ${id} as "${reason}":\n- ${clip(before, 300)}\n+ ${clip(after, 300)}\n${totals()}`;
      },
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
      description: 'Change words in MANY blocks at once by regular-expression substitution, with a short reason the person will review the changes under. find is a JavaScript regular expression applied to each block\'s current text; replace is its replacement ($1, $2 … refer to groups; empty deletes the match). Only the first match in each block is replaced unless find_flags contains "g". Give a selector (ids, pattern, span or range, optionally chapter) to limit which blocks; with none, every live block where find matches. Blocks marked for removal are skipped, and a change that would leave a block empty is refused for that block. ALWAYS use dry_run:true first: it reports how many blocks would change and shows spread-out before/after examples, so you can tighten find until it catches only what it should. Use revise for one-off changes.',
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
        for (const b of selected) {
          if (struckMark(b)) continue;
          const before = textOf(b);
          if (!probe.test(before)) continue;
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
        const refused = emptied > 0 ? ` ${emptied} block(s) skipped because the change would leave them empty (use mark to remove a block).` : '';
        if (a['dry_run'] === true) {
          return `WOULD REVISE ${changes.length} blocks. ${where}.${refused}\n${show(12)}`;
        }
        for (const c of changes) {
          if (c.after === c.b.text) marks.delete(c.b.id);
          else marks.set(c.b.id, { kind: 'text', reason, after: c.after });
        }
        return `REVISED ${changes.length} blocks as "${reason}". ${where}.${refused}\n${show(6)}\n${totals()}`;
      },
    },
    {
      name: 'unmark',
      description: 'Take marks and revisions off: by selector, or every block marked or revised with a given reason. A revised block goes back to its original text.',
      parameters: {
        type: 'object',
        properties: {
          ...selectorProps,
          reason: { type: 'string', description: 'Unmark every block marked or revised with exactly this reason.' },
        },
      },
      run(a) {
        const byReason = a['reason'] !== undefined && ['ids', 'pattern', 'span', 'range'].every((k) => a[k] === undefined);
        const blocks = byReason ? live.filter((b) => marks.get(b.id)?.reason === a['reason']) : select(a);
        let n = 0;
        for (const b of blocks) if (marks.delete(b.id)) n += 1;
        return `Unmarked ${n}. ${totals()}`;
      },
    },
    {
      name: 'marks_summary',
      description: 'Every reason used so far, whether it marks or revises, how many blocks each holds, and examples.',
      parameters: { type: 'object', properties: {} },
      run() {
        const groups = new Map<string, { kind: Mark['kind']; blocks: Live[] }>();
        for (const b of live) {
          const mark = marks.get(b.id);
          if (mark === undefined) continue;
          const key = `${mark.kind}\u0000${mark.reason}`;
          const held = groups.get(key);
          if (held === undefined) groups.set(key, { kind: mark.kind, blocks: [b] });
          else held.blocks.push(b);
        }
        if (groups.size === 0) return 'Nothing marked or revised yet.';
        return [...groups.entries()].map(([key, g]) => {
          const reason = key.slice(key.indexOf('\u0000') + 1);
          return `"${reason}" (${g.kind === 'strike' ? 'marked' : 'revised'}): ${g.blocks.length}\n${examples(g.blocks, 3)}`;
        }).join('\n\n');
      },
    },
  ];

  return {
    tools,
    counts,
    state() {
      const summary = tools.find((t) => t.name === 'marks_summary')!.run({});
      return `[The work so far, as the tools hold it now. ${totals()}]\n${summary}`;
    },
    items() {
      const out: AskMark[] = [];
      for (const b of live) {
        const mark = marks.get(b.id);
        if (mark === undefined) continue;
        out.push(mark.kind === 'strike'
          ? { id: b.id, kind: 'strike', reason: mark.reason, before: b.text }
          : { id: b.id, kind: 'text', reason: mark.reason, before: b.text, after: mark.after });
      }
      return out;
    },
  };
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
