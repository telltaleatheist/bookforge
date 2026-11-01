import { expect, test } from 'bun:test';

/*
 * ASK THE DOCUMENT (Owen, 2026-10-29): *"giving it the ability to mark things …
 * the modal should show a list of all the strikes so i can pick which to keep
 * and which not to keep."* The pure halves: the tools a model works the book
 * with (electron/ask-tools.ts), and the two plans that turn its marks into ops
 * and back (shared/ask.ts).
 */
const { askToolbox, applyEdits } = await import('../electron/ask-tools');
const { askMarkKey, groupByReason, planLanding, planUndo, retypeSaid } = await import('../shared/ask');
import type { AskMark, AskRowState, AskView } from '../shared/ask';

const VIEW: AskView = {
  title: 'A Test Book',
  struck: 2,
  chapters: [{ id: 'e-1', title: 'One' }, { id: 'e-5', title: 'Two' }],
  blocks: [
    { id: 'e-1', text: 'Chapter One', category: 'Section-header', chapter: 0 },
    { id: 'e-2', text: 'The cat sat on the mat. The cat slept.', category: 'Text', chapter: 0 },
    { id: 'e-3', text: 'Study questions', category: 'Section-header', chapter: 0 },
    { id: 'e-4', text: '1. Why did the cat sit?', category: 'Text', chapter: 0 },
    { id: 'e-5', text: 'Chapter Two', category: 'Section-header', chapter: 1 },
    { id: 'e-6', text: 'It rained for twenty days.', category: 'Text', chapter: 1 },
    { id: 'e-7', text: 'Study questions', category: 'Section-header', chapter: 1 },
    { id: 'e-8', text: '1. How long did it rain?', category: 'Text', chapter: 1 },
    { id: 'e-9', text: '2. Who noticed?', category: 'Text', chapter: 1 },
  ],
};

function tools() {
  const box = askToolbox(VIEW);
  const run = (name: string, args: Record<string, unknown> = {}): string => {
    const tool = box.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.run(args);
  };
  return { box, run };
}

test('the nine tools are offered, each with a schema', () => {
  const { box } = tools();
  expect(box.tools.map((t) => t.name)).toEqual(['outline', 'read', 'search', 'mark', 'revise', 'revise_pattern', 'recategorize', 'unmark', 'marks_summary']);
  for (const t of box.tools) expect((t.parameters as { type: string }).type).toBe('object');
});

test('outline counts live blocks, what the person struck, and each chapter', () => {
  const { run } = tools();
  const said = run('outline');
  expect(said).toContain('9 live blocks, 2 already struck by the person');
  expect(said).toContain('ch0 "One" first=e-1 blocks=4 marked=0');
  expect(said).toContain('ch1 "Two" first=e-5 blocks=5 marked=0');
});

test('a span selects each start and what follows it, up to the next chapter', () => {
  const { box, run } = tools();
  const said = run('mark', { span: { start: '^Study questions$', until: '^Chapter' }, reason: 'study question', dry_run: true });
  expect(said).toContain('WOULD MARK 5 blocks');
  expect(box.items()).toEqual([]); // a dry run marks nothing
  run('mark', { span: { start: '^Study questions$', until: '^Chapter' }, reason: 'study question' });
  expect(box.items().map((m) => m.id)).toEqual(['e-3', 'e-4', 'e-7', 'e-8', 'e-9']);
  expect(box.counts()).toEqual({ struck: 5, revised: 0, retyped: 0 });
});

test('a pattern can be held to one chapter, and a range is inclusive', () => {
  const { box, run } = tools();
  run('mark', { pattern: '^\\d+\\.', chapter: 1, reason: 'question' });
  expect(box.items().map((m) => m.id)).toEqual(['e-8', 'e-9']);
  run('mark', { range: { from: 'e-3', to: 'e-4' }, reason: 'apparatus' });
  expect(box.items().map((m) => [m.id, m.reason])).toEqual([
    ['e-3', 'apparatus'], ['e-4', 'apparatus'], ['e-8', 'question'], ['e-9', 'question'],
  ]);
});

test('a selector must be exactly one, and ids must be live', () => {
  const { run } = tools();
  expect(() => run('mark', { reason: 'x' })).toThrow(/exactly one of ids, pattern, span, range \(got none\)/);
  expect(() => run('mark', { ids: ['e-1'], pattern: 'x', reason: 'x' })).toThrow(/got ids, pattern/);
  expect(() => run('mark', { ids: ['e-404'], reason: 'x' })).toThrow(/not live blocks: e-404/);
  expect(() => run('mark', { ids: ['e-1'] })).toThrow(/reason is required/);
  expect(() => run('search', { pattern: '(' })).toThrow(/will not compile/);
});

test('unmark by selector or by reason, and read can show only what is left', () => {
  const { box, run } = tools();
  run('mark', { ids: ['e-3', 'e-4'], reason: 'a' });
  run('mark', { ids: ['e-7'], reason: 'b' });
  expect(run('unmark', { reason: 'a' })).toContain('Unmarked 2');
  expect(box.items().map((m) => m.id)).toEqual(['e-7']);
  const left = run('read', { only: 'unmarked', count: 80 });
  expect(left).not.toContain('e-7');
  expect(left).toContain('e-8');
  expect(run('read', { only: 'marked' })).toContain('e-7 [Section-header] [MARKED: b]');
  run('unmark', { ids: ['e-7'] });
  expect(box.items()).toEqual([]);
});

test('revise substitutes exactly, and the mark keeps before and after', () => {
  const { box, run } = tools();
  run('revise', { id: 'e-6', edits: [{ find: 'twenty', replace: '20' }], reason: 'number' });
  expect(box.items()).toEqual([
    { id: 'e-6', kind: 'text', reason: 'number', before: 'It rained for twenty days.', after: 'It rained for 20 days.' },
  ]);
  // Later tools see the revised words.
  expect(run('search', { pattern: '20 days' })).toContain('1 matches');
  expect(run('read', { only: 'revised' })).toContain('e-6 [REVISED: number] It rained for 20 days.');
});

test('revise_pattern changes many blocks at once, dry run first, and skips what it should', () => {
  // A Watchtower-style book: a paragraph number before the prose, and one
  // paragraph whose prose itself opens with a number.
  const view: AskView = {
    title: 'Numbered', struck: 0, chapters: [{ id: 'p-1', title: 'One' }],
    blocks: [
      { id: 'p-1', text: '1 The earth is old, they say.', category: 'Text', chapter: 0 },
      { id: 'p-2', text: '2 “Who made it?” we ask.', category: 'Text', chapter: 0 },
      { id: 'p-3', text: '10 million years is a guess.', category: 'Text', chapter: 0 },
      { id: 'p-4', text: '3 ', category: 'Text', chapter: 0 },
      { id: 'p-5', text: 'No number here.', category: 'Text', chapter: 0 },
    ],
  };
  const box = askToolbox(view);
  const run = (name: string, args: Record<string, unknown>): string => box.tools.find((x) => x.name === name)!.run(args);
  const find = '^\\d{1,3}\\s+(?=[A-Z“])';
  const dry = run('revise_pattern', { find, replace: '', reason: 'paragraph number', dry_run: true });
  expect(dry).toContain('WOULD REVISE 2 blocks');
  expect(box.items()).toEqual([]);
  // A change that would empty a block is refused for that block, by name.
  expect(run('revise_pattern', { find: '^\\d+\\s*$', replace: '', reason: 'x', dry_run: true }))
    .toContain('WOULD REVISE 0 blocks. By chapter: none. 1 block(s) skipped because the change would leave them empty');
  run('revise_pattern', { find, replace: '', reason: 'paragraph number' });
  expect(box.items()).toEqual([
    { id: 'p-1', kind: 'text', reason: 'paragraph number', before: '1 The earth is old, they say.', after: 'The earth is old, they say.' },
    { id: 'p-2', kind: 'text', reason: 'paragraph number', before: '2 “Who made it?” we ask.', after: '“Who made it?” we ask.' },
  ]);
  // A block marked for removal is not revised.
  run('mark', { ids: ['p-3'], reason: 'gone' });
  expect(run('revise_pattern', { find: '^10', replace: 'Ten', reason: 'x', dry_run: true })).toContain('WOULD REVISE 0 blocks');
});

test('a find that occurs twice needs an occurrence, which picks it', () => {
  const { box, run } = tools();
  expect(() => run('revise', { id: 'e-2', edits: [{ find: 'The cat', replace: 'A dog' }], reason: 'r' }))
    .toThrow(/occurs 2 times in e-2; give occurrence \(1 to 2\)/);
  run('revise', { id: 'e-2', edits: [{ find: 'The cat', replace: 'A dog', occurrence: 2 }], reason: 'r' });
  expect(box.items()[0]).toMatchObject({ after: 'The cat sat on the mat. A dog slept.' });
  expect(() => run('revise', { id: 'e-2', edits: [{ find: 'mat', replace: 'rug', occurrence: 3 }], reason: 'r' }))
    .toThrow(/occurrence must be a whole number from 1 to 1/);
});

test("a call's edits apply all or none, in order", () => {
  const { box, run } = tools();
  expect(() => run('revise', {
    id: 'e-2', edits: [{ find: 'sat', replace: 'lay' }, { find: 'absent', replace: 'x' }], reason: 'r',
  })).toThrow(/edit 2: "absent" does not occur in e-2's current text \(after the edits before it\); no edits were applied/);
  expect(box.items()).toEqual([]);
  // In order: the second edit sees the first one's result.
  expect(applyEdits('one two', [{ find: 'one', replace: 'three' }, { find: 'three two', replace: 'done' }], 'x')).toBe('done');
});

test('a revision back to the original is no revision, and an empty block is refused', () => {
  const { box, run } = tools();
  run('revise', { id: 'e-6', edits: [{ find: 'twenty', replace: '20' }], reason: 'n' });
  expect(run('revise', { id: 'e-6', edits: [{ find: '20', replace: 'twenty' }], reason: 'n' })).toContain('back to its original text');
  expect(box.items()).toEqual([]);
  expect(() => run('revise', { id: 'e-6', edits: [{ find: 'It rained for twenty days.', replace: '' }], reason: 'n' }))
    .toThrow(/would leave e-6 empty; use mark/);
});

test('a strike supersedes a revision, and a marked block cannot be revised', () => {
  const { box, run } = tools();
  run('revise', { id: 'e-6', edits: [{ find: 'twenty', replace: '20' }], reason: 'n' });
  expect(run('mark', { ids: ['e-6'], reason: 'gone' })).toContain('1 had been revised; the revision is dropped');
  expect(box.items()).toEqual([{ id: 'e-6', kind: 'strike', reason: 'gone', before: 'It rained for twenty days.' }]);
  expect(() => run('revise', { id: 'e-6', edits: [{ find: 'rained', replace: 'poured' }], reason: 'n' }))
    .toThrow(/marked for removal; unmark it first/);
});

// ── The plans ───────────────────────────────────────────────────────────────

const strike = (id: string, before: string, reason = 'r'): AskMark => ({ id, kind: 'strike', reason, before });
const revision = (id: string, before: string, after: string, reason = 'r'): AskMark => ({ id, kind: 'text', reason, before, after });
const rows = (entries: [string, string, boolean, string?, (string | null)?][]): Map<string, AskRowState> =>
  new Map(entries.map(([id, text, struck, category = 'Text', chapter = null]) => [id, { text, struck, category, chapter }]));

test('a landing strikes and rewrites what is still what the run saw', () => {
  const items = [strike('a', 'A'), revision('b', 'B', 'B2')];
  const plan = planLanding(items, rows([['a', 'A', false], ['b', 'B', false]]), false);
  expect(plan.ops).toEqual([{ op: 'strike', id: 'a' }, { op: 'text', id: 'b', text: 'B2' }]);
  expect(plan.corrections).toEqual([]);
  expect(plan.skipped).toEqual([]);
});

test('a landing on a translated pass records the words as corrections', () => {
  const plan = planLanding([strike('a', 'A'), revision('b', 'B', 'B2')], rows([['a', 'A', false], ['b', 'B', false]]), true);
  expect(plan.ops).toEqual([{ op: 'strike', id: 'a' }]);
  expect(plan.corrections).toEqual([{ id: 'b', text: 'B2' }]);
});

test('a landing skips a block the person changed while the model worked', () => {
  const items = [strike('a', 'A'), strike('b', 'B'), revision('c', 'C', 'C2'), strike('gone', 'G')];
  const plan = planLanding(items, rows([['a', 'A edited', false], ['b', 'B', true], ['c', 'C', false]]), false);
  expect(plan.ops).toEqual([{ op: 'text', id: 'c', text: 'C2' }]);
  expect(plan.skipped.map((s) => [s.item.id, s.why])).toEqual([
    ['a', 'its text was changed while the model worked'],
    ['b', 'it was struck while the model worked'],
    ['gone', 'it is no longer in the book'],
  ]);
});

test('an undo restores strikes and writes back the before text', () => {
  const items = [strike('a', 'A'), revision('b', 'B', 'B2')];
  const plan = planUndo(items, rows([['a', 'A', true], ['b', 'B2', false]]), false);
  expect(plan.ops).toEqual([{ op: 'restore', id: 'a' }, { op: 'text', id: 'b', text: 'B' }]);
  expect(plan.acted).toEqual(items);
  const translated = planUndo(items, rows([['a', 'A', true], ['b', 'B2', false]]), true);
  expect(translated.ops).toEqual([{ op: 'restore', id: 'a' }]);
  expect(translated.corrections).toEqual([{ id: 'b', text: 'B' }]);
});

test('an undo skips every block that changed since the run, and says why', () => {
  const items = [
    strike('unstruck', 'U'),
    strike('retyped', 'R'),
    revision('edited', 'E', 'E2'),
    revision('struck', 'S', 'S2'),
    strike('gone', 'G'),
  ];
  const plan = planUndo(items, rows([
    ['unstruck', 'U', false],
    ['retyped', 'R typed', true],
    ['edited', 'E3', false],
    ['struck', 'S2', true],
  ]), false);
  expect(plan.ops).toEqual([]);
  expect(plan.acted).toEqual([]);
  expect(plan.skipped.map((s) => [s.item.id, s.why])).toEqual([
    ['unstruck', 'it is not struck any more'],
    ['retyped', 'its text has changed since the run'],
    ['edited', 'its text has changed since the run'],
    ['struck', 'it has been struck since the run'],
    ['gone', 'it is no longer in the book'],
  ]);
});

test('marks group by reason in the order each reason first appears', () => {
  const groups = groupByReason([strike('a', 'A', 'x'), strike('b', 'B', 'y'), strike('c', 'C', 'x')]);
  expect(groups.map((g) => [g.reason, g.items.map((i) => i.id)])).toEqual([['x', ['a', 'c']], ['y', ['b']]]);
});

// ── Retyping (Owen, 2026-11-01: "if something is marked as a footnote but its
// really a chapter title, it has the tools it needs to correct that?") ────────

const RETYPE_VIEW: AskView = {
  title: 'A Footnoted Book',
  struck: 0,
  chapters: [{ id: 'e-1', title: 'One' }],
  blocks: [
    { id: 'e-1', text: 'ONE', category: 'Section-header', chapter: 0 },
    { id: 'e-2', text: 'Body text.', category: 'Text', chapter: 0 },
    { id: 'e-3', text: 'THE *SECOND* PART', category: 'Footnote', chapter: 0 },
    { id: 'e-4', text: '1 A real footnote.', category: 'Footnote', chapter: 0 },
    { id: 'e-5', text: 'THE THIRD PART', category: 'Footnote', chapter: 0 },
  ],
};

function retypeTools() {
  const box = askToolbox(RETYPE_VIEW);
  const run = (name: string, args: Record<string, unknown> = {}): string => box.tools.find((t) => t.name === name)!.run(args);
  return { box, run };
}

test('recategorize by pattern within a kind: dry run first, then headings that start chapters', () => {
  const { box, run } = retypeTools();
  const dry = run('recategorize', { category_is: 'Footnote', pattern: '^[A-Z* ]+$', category: 'Section-header', starts_chapter: true, reason: 'heading read as a footnote', dry_run: true });
  expect(dry).toContain('WOULD RETYPE 2 blocks');
  expect(dry).toContain('e-3 [Footnote → Section-header; starts chapter "THE SECOND PART"]');
  expect(box.items()).toEqual([]);
  run('recategorize', { category_is: 'Footnote', pattern: '^[A-Z* ]+$', category: 'Section-header', starts_chapter: true, reason: 'heading read as a footnote' });
  expect(box.counts()).toEqual({ struck: 0, revised: 0, retyped: 2 });
  expect(box.items()).toEqual([
    { id: 'e-3', kind: 'category', reason: 'heading read as a footnote', before: 'THE *SECOND* PART', from: 'Footnote', to: 'Section-header', chapter: { start: true, title: 'THE SECOND PART' }, chapterBefore: null },
    { id: 'e-5', kind: 'category', reason: 'heading read as a footnote', before: 'THE THIRD PART', from: 'Footnote', to: 'Section-header', chapter: { start: true, title: 'THE THIRD PART' }, chapterBefore: null },
  ]);
  // What read shows now, and that search narrows by the kind a block now is.
  expect(run('read', { from: 'e-3', count: 1 })).toContain('e-3 [RETYPED Footnote → Section-header; starts chapter "THE SECOND PART": heading read as a footnote]');
  expect(run('search', { pattern: '.', category_is: 'Footnote' })).toMatch(/^1 matches/);
  expect(run('marks_summary')).toContain('"heading read as a footnote" (retyped): 2');
});

test('recategorize refuses an unknown kind, a chapter at a non-heading, and one title for many blocks', () => {
  const { run } = retypeTools();
  expect(() => run('recategorize', { id: 'e-3', category: 'Heading', reason: 'r' })).toThrow(/category must be one of .*Section-header.*"Heading" is not/);
  expect(() => run('recategorize', { id: 'e-3', category: 'Text', starts_chapter: true, reason: 'r' })).toThrow(/a chapter starts at a heading/);
  expect(() => run('recategorize', { category_is: 'Footnote', category: 'Title', starts_chapter: true, chapter_title: 'X', reason: 'r' })).toThrow(/chapter_title names one chapter/);
  expect(() => run('recategorize', { category: 'Title', reason: 'r' })).toThrow(/give id, a selector/);
});

test('a retyping sits beside a revision, a strike drops it, and unmark takes it off', () => {
  const { box, run } = retypeTools();
  run('recategorize', { id: 'e-4', category: 'Text', reason: 'not a note' });
  run('revise', { id: 'e-4', edits: [{ find: '1 ', replace: '' }], reason: 'stray number' });
  expect(box.items().map((m) => [m.kind, m.id])).toEqual([['text', 'e-4'], ['category', 'e-4']]);
  expect(new Set(box.items().map(askMarkKey)).size).toBe(2);
  run('unmark', { reason: 'not a note' });
  expect(box.items().map((m) => m.kind)).toEqual(['text']);
  run('recategorize', { id: 'e-5', category: 'Title', reason: 'title' });
  expect(run('mark', { ids: ['e-5'], reason: 'gone' })).toContain('the retyping is dropped');
  expect(box.items().filter((m) => m.kind === 'category')).toEqual([]);
  run('recategorize', { id: 'e-5', category: 'Text', reason: 'r' });
  expect(box.counts().retyped).toBe(0); // a block marked for removal is skipped
  // Taking a chapter away is a retyping too, with the kind unchanged.
  run('recategorize', { id: 'e-1', category: 'Section-header', starts_chapter: false, reason: 'no division' });
  expect(box.items().find((m) => m.kind === 'category')).toEqual({
    id: 'e-1', kind: 'category', reason: 'no division', before: 'ONE', from: 'Section-header', to: 'Section-header', chapter: { start: false }, chapterBefore: 'One',
  });
});

const retype = (id: string, from: string, to: string, chapter: { start: true; title: string } | { start: false } | null, chapterBefore: string | null): AskMark =>
  ({ id, kind: 'category', reason: 'r', before: id.toUpperCase(), from, to, chapter, chapterBefore });

test('a retyping lands as a category op and a chapter op, and its undo is the opposite', () => {
  const start = retype('a', 'Footnote', 'Section-header', { start: true, title: 'A' }, null);
  const drop = retype('b', 'Section-header', 'Text', { start: false }, 'Old');
  const kindOnly = retype('c', 'Text', 'Quote', null, null);
  const landed = planLanding([start, drop, kindOnly], rows([['a', 'A', false, 'Footnote'], ['b', 'B', false, 'Section-header', 'Old'], ['c', 'C', false]]), true);
  expect(landed.ops).toEqual([
    { op: 'category', id: 'a', category: 'Section-header' },
    { op: 'chapter', set: 'a', title: 'A' },
    { op: 'category', id: 'b', category: 'Text' },
    { op: 'chapter', remove: 'b' },
    { op: 'category', id: 'c', category: 'Quote' },
  ]);
  expect(landed.corrections).toEqual([]); // a kind is shape: an op even on a translated pass
  const undone = planUndo([start, drop, kindOnly], rows([['a', 'A', false, 'Section-header', 'A'], ['b', 'B', false, 'Text'], ['c', 'C', false, 'Quote']]), false);
  expect(undone.ops).toEqual([
    { op: 'category', id: 'a', category: 'Footnote' },
    { op: 'chapter', remove: 'a' },
    { op: 'category', id: 'b', category: 'Section-header' },
    { op: 'chapter', set: 'b', title: 'Old' },
    { op: 'category', id: 'c', category: 'Text' },
  ]);
  expect(retypeSaid(start as Extract<AskMark, { kind: 'category' }>)).toBe('Footnote → Section-header, starts a chapter, "A"');
});

test('a retyping is skipped when the kind or the chapter moved under it', () => {
  const start = retype('a', 'Footnote', 'Section-header', { start: true, title: 'A' }, null);
  expect(planLanding([start], rows([['a', 'A', false, 'Text']]), false).skipped.map((s) => s.why))
    .toEqual(['its kind was changed while the model worked']);
  expect(planLanding([start], rows([['a', 'A', false, 'Footnote', 'Someone']]), false).skipped.map((s) => s.why))
    .toEqual(['the chapter at it was changed while the model worked']);
  expect(planUndo([start], rows([['a', 'A', false, 'Footnote', 'A']]), false).skipped.map((s) => s.why))
    .toEqual(['its kind has changed since the run']);
  expect(planUndo([start], rows([['a', 'A', false, 'Section-header', 'Renamed']]), false).skipped.map((s) => s.why))
    .toEqual(['the chapter at it has changed since the run']);
});
