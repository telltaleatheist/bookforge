import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S STRUCTURAL TOOLS (Owen, 2026-11-02): join a sentence broken by a picture,
 * split a heading run into its paragraph, rename a chapter, restore a block
 * struck by mistake, link a note to its number, and point at places. Each is
 * proved twice: as the tool the model calls, and as the ops it lands as and the
 * ops that take it back — replayed, so the words that come out are the proof.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-structure-'));
mock.module('electron', () => ({app:{getPath:()=>userData,getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));
const { askToolbox } = await import('../electron/ask-tools');
const { askRowStates, planLanding, planUndo, structureSaid, retypeSaid } = await import('../shared/ask');
const { replayOps } = await import('../shared/ops');
const { isAskMark } = await import('../electron/ask-document');
import type { AskMark, AskView } from '../shared/ask';
import type { BookOp } from '../shared/ops';
import type { BookRow } from '../shared/book';

const VIEW: AskView = {
  title: 'Pictures',
  struck: 2,
  chapters: [{ id: 'a-1', title: '1' }, { id: 'a-9', title: 'Two' }],
  blocks: [
    { id: 'a-1', text: 'CHAPTER ONE The rain began on a Tuesday.', category: 'Text', chapter: 0 },
    { id: 'a-2', text: 'The river rose and the town', category: 'Text', chapter: 0 },
    { id: 'a-3', text: '[Picture]', category: 'Picture', chapter: 0 },
    { id: 'a-4', text: 'Figure 3. The flooded square.', category: 'Caption', chapter: 0 },
    { id: 'a-5', text: 'watched it from the bridge,', category: 'Text', chapter: 0 },
    { id: 'a-6', text: 'until the bridge went too.', category: 'Text', chapter: 0 },
    { id: 'a-7', text: 'See the note.²', category: 'Text', chapter: 0 },
    { id: 'a-8', text: '² A note nothing points at.', category: 'Footnote', chapter: 0 },
    { id: 'a-9', text: 'Two', category: 'Section-header', chapter: 1 },
    { id: 'a-10', text: 'Morning came.', category: 'Text', chapter: 1 },
  ],
  struckBlocks: [
    { id: 'a-11', text: 'A paragraph struck by mistake.', category: 'Text', chapter: 1 },
    { id: 'a-12', text: 'A real running head', category: 'Page-header', chapter: 1 },
  ],
  loose: { numbers: [{ block: 'a-7', at: 13, len: 1, printed: 2 }], notes: ['a-8'] },
};

function box() {
  const b = askToolbox(VIEW);
  const run = (name: string, args: Record<string, unknown> = {}): string => b.call(name, JSON.stringify(args)).content;
  return { b, run };
}

/** The book the view came from, as rows, with the person's two strikes as ops. */
const BOX = { x1: 0, y1: 0, x2: 0, y2: 0 };
const ROWS: BookRow[] = [...VIEW.blocks, ...VIEW.struckBlocks].map((one) => ({
  id: one.id, category: one.category, text: one.text, page: 0, pages: [0], box: BOX, pageWidth: 0, pageHeight: 0,
  parts: [{ src: one.id, page: 0, chars: [0, one.text.length] }],
}) as BookRow);
const STRUCK: BookOp[] = [{ op: 'strike', id: 'a-11' }, { op: 'strike', id: 'a-12' }];
const CHAPTERS = VIEW.chapters.map((c) => ({ id: c.id, title: c.title }));

function replay(ops: readonly BookOp[]) {
  return replayOps(ROWS, [...STRUCK, ...ops], { markers: [], notes: [] }, CHAPTERS);
}
function states(ops: readonly BookOp[]) {
  const out = replay(ops);
  expect(out.missing).toEqual([]);
  return { out, rows: askRowStates(out.rows, out.chapters) };
}
const textOf = (ops: readonly BookOp[], id: string) => replay(ops).rows.find((r) => r.id === id)?.text;

test('a sentence broken by a picture: strike the picture and caption, join the halves', () => {
  const { b, run } = box();
  run('mark', { ids: ['a-3', 'a-4'], reason: 'picture' });
  expect(run('join', { id: 'a-5', reason: 'broken by a picture', dry_run: true }))
    .toContain('a-5 → a-2: The river rose and the town ⏐ watched it from the bridge,');
  expect(b.call('join', JSON.stringify({ id: 'a-5', reason: 'broken by a picture' })).said)
    .toEqual({ verb: 'joined', detail: 'a-5 → a-2 "broken by a picture"' });
  expect(run('read', { only: 'joined' })).toContain('a-5 [JOINED into a-2: broken by a picture]');
  expect(b.counts()).toMatchObject({ struck: 2, joined: 1 });

  const items = b.items();
  const landing = planLanding(items, states([]).rows, false);
  expect(landing.skipped).toEqual([]);
  expect(textOf(landing.ops, 'a-2')).toBe('The river rose and the town watched it from the bridge,');
  expect(replay(landing.ops).rows.some((r) => r.id === 'a-5')).toBe(false);

  // Taken back: the join is cut again where it was made, under new names.
  const joined = items.filter((i) => i.kind === 'join');
  const undo = planUndo(joined, states(landing.ops).rows, false);
  expect(undo.skipped).toEqual([]);
  const after = replay([...landing.ops, ...undo.ops]);
  expect(after.missing).toEqual([]);
  expect(after.rows.find((r) => r.id === 'a-2/1')!.text).toBe('The river rose and the town');
  expect(after.rows.find((r) => r.id === 'a-2/2')!.text).toBe('watched it from the bridge,');
});

test('a chain of joins composes, lands into the survivor, and comes apart last first', () => {
  const { b, run } = box();
  run('join', { id: 'a-5', into: 'a-2', reason: 'broken' });
  run('join', { id: 'a-6', reason: 'broken' }); // into a-5, itself joined into a-2
  const items = b.items().filter((i) => i.kind === 'join');
  expect(items.map((i) => (i.kind === 'join' ? i.into : ''))).toEqual(['a-2', 'a-5']);
  const landing = planLanding(items, states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'merge', id: 'a-5', into: 'a-2' }, { op: 'merge', id: 'a-6', into: 'a-2' }]);
  expect(textOf(landing.ops, 'a-2')).toBe('The river rose and the town watched it from the bridge, until the bridge went too.');

  const undo = planUndo(items, states(landing.ops).rows, false);
  expect(undo.skipped).toEqual([]);
  const after = replay([...landing.ops, ...undo.ops]);
  expect(after.missing).toEqual([]);
  expect(after.rows.filter((r) => r.id.startsWith('a-2')).map((r) => r.text)).toEqual([
    'The river rose and the town', 'watched it from the bridge,', 'until the bridge went too.',
  ]);

  // Only the first of the chain, while the second still holds: refused by name.
  const partial = planUndo([items[0]!], states(landing.ops).rows, false);
  expect(partial.skipped[0]!.why).toContain('more was joined after it');
});

test('join refuses a chapter boundary, a footnote, a revised block and the first block', () => {
  const { run } = box();
  expect(run('join', { id: 'a-9', reason: 'x' })).toContain('never crosses a chapter');
  expect(run('join', { id: 'a-8', reason: 'x' })).toContain('is a footnote');
  expect(run('join', { id: 'a-1', reason: 'x' })).toContain('nothing before it');
  run('revise', { id: 'a-6', edits: [{ find: 'too', replace: 'as well' }], reason: 'w' });
  expect(run('join', { id: 'a-6', reason: 'x' })).toContain('is revised');
  expect(run('join', { id: 'a-5', into: 'a-6', reason: 'x' })).toContain('a block joins an EARLIER block');
  expect(run('mark', { ids: ['a-6'], reason: 'y' })).toContain('MARKED 1');
});

test('a landing skips a join whose blocks changed while the model worked', () => {
  const { b, run } = box();
  run('join', { id: 'a-6', reason: 'broken' });
  const plan = planLanding(b.items(), states([{ op: 'text', id: 'a-5', text: 'edited' }]).rows, false);
  expect(plan.ops).toEqual([]);
  expect(plan.skipped[0]!.why).toContain('the block it continues (a-5) was changed');
});

test('a heading run into its paragraph is split off and given its kind, and joined back on undo', () => {
  const { b, run } = box();
  expect(run('split', { id: 'a-1', at_quote: 'The rain', first_category: 'Section-header', reason: 'heading run in', dry_run: true }))
    .toContain('1: CHAPTER ONE');
  run('split', { id: 'a-1', at_quote: 'The rain', first_category: 'Section-header', reason: 'heading run in' });
  const item = b.items().find((i) => i.kind === 'split')!;
  expect(structureSaid(item as Extract<AskMark, { kind: 'split' }>)).toBe('split before "The rain began on a Tuesday." (Section-header | Text)');
  const landing = planLanding([item], states([]).rows, false);
  const out = states(landing.ops);
  expect(out.out.rows.find((r) => r.id === 'a-1/1')).toMatchObject({ text: 'CHAPTER ONE', category: 'Section-header' });
  expect(out.out.rows.find((r) => r.id === 'a-1/2')).toMatchObject({ text: 'The rain began on a Tuesday.', category: 'Text' });
  // The chapter that started at the block stays with its first half.
  expect(out.out.chapters[0]).toMatchObject({ id: 'a-1/1', title: '1' });

  const undo = planUndo([item], out.rows, false);
  const back = replay([...landing.ops, ...undo.ops]);
  expect(back.missing).toEqual([]);
  expect(back.rows.find((r) => r.id === 'a-1/1')).toMatchObject({ text: VIEW.blocks[0]!.text, category: 'Text' });
  expect(run('split', { id: 'a-8', at_quote: 'A note', reason: 'x' })).toContain('a note is never cut in two');
  expect(run('split', { id: 'a-10', at_quote: 'nowhere', reason: 'x' })).toContain('does not occur');
});

test('rename_chapter retitles a chapter that starts there, and only one that does', () => {
  const { b, run } = box();
  expect(run('rename_chapter', { chapter: 0, title: 'Chapter One', reason: 'number only' })).toContain('"1" → "Chapter One"');
  expect(run('rename_chapter', { id: 'a-2', title: 'Nope', reason: 'x' })).toContain('no chapter starts at a-2');
  const item = b.items().find((i) => i.kind === 'category')!;
  expect(retypeSaid(item as Extract<AskMark, { kind: 'category' }>)).toBe('chapter "1" renamed "Chapter One"');
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'chapter', set: 'a-1', title: 'Chapter One' }]);
  const undo = planUndo([item], states(landing.ops).rows, false);
  expect(undo.ops).toEqual([{ op: 'chapter', set: 'a-1', title: '1' }]);
});

test('the person\'s strikes are readable, and restore proposes one back; undo strikes it again', () => {
  const { b, run } = box();
  expect(run('read', { only: 'struck' })).toContain('a-11 [STRUCK] A paragraph struck by mistake.');
  expect(run('restore', { ids: ['a-10'], reason: 'x' })).toContain('not blocks the person struck');
  run('restore', { ids: ['a-11'], reason: 'struck with the caption' });
  expect(run('read', { only: 'struck' })).toContain('a-11 [STRUCK] [RESTORE: struck with the caption]');
  const item = b.items().find((i) => i.kind === 'restore')!;
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'restore', id: 'a-11' }]);
  expect(planUndo([item], states(landing.ops).rows, false).ops).toEqual([{ op: 'strike', id: 'a-11' }]);
  run('unmark', { ids: ['a-11'] });
  expect(b.counts().restored).toBe(0);
});

test('link_footnote binds a loose note to its loose number, and its undo is an unlink', () => {
  const { b, run } = box();
  expect(run('read', { only: 'unlinked' })).toContain('a-8 [Footnote] [UNLINKED NOTE]');
  expect(run('read', { only: 'unlinked' })).toContain('a-7 [LOOSE NUMBER "²" at 13]');
  expect(run('link_footnote', { note: 'a-7', block: 'a-7', number: '²', reason: 'x' })).toContain('not a footnote');
  run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'unlinked note' });
  expect(run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'again' })).toContain('already have a link proposed');
  const item = b.items().find((i) => i.kind === 'link')!;
  expect(item).toMatchObject({ block: 'a-7', at: 13, len: 1 });
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'link', note: 'a-8', block: 'a-7', at: 13, len: 1 }]);
  const linked = replayOps(ROWS, [...STRUCK, ...landing.ops], { markers: [{ block: 'a-7', at: 13, len: 1, printed: 2 }], notes: ['a-8'] }, CHAPTERS);
  expect(linked.rows.find((r) => r.id === 'a-8')!.refs).toEqual([{ block: 'a-7', at: 13, len: 1 }]);
  expect(linked.loose).toEqual({ markers: [], notes: [] });
  expect(planUndo([item], states(landing.ops).rows, false).ops).toEqual([{ op: 'unlink', note: 'a-8', block: 'a-7', at: 13, len: 1 }]);
});

test('highlight points at a block or exact words in it, and changes nothing', () => {
  const { b, run } = box();
  expect(run('highlight', { id: 'a-6', quote: 'the bridge', note: 'the bridge goes' })).toContain('1 places so far');
  expect(run('highlight', { id: 'a-6', quote: 'not here', note: 'x' })).toContain('does not occur');
  run('highlight', { id: 'a-9', note: 'chapter two' });
  expect(b.highlights()).toEqual([
    { id: 'a-6', quote: 'the bridge', note: 'the bridge goes' },
    { id: 'a-9', quote: null, note: 'chapter two' },
  ]);
  expect(b.items()).toEqual([]);
  expect(b.call('highlight', JSON.stringify({ id: 'a-9', note: 'x' })).said).toEqual({ verb: 'pointed at', detail: 'a-9 "x"' });
});

test('every new mark is one a saved run can be read back with', () => {
  const { b, run } = box();
  run('mark', { ids: ['a-3', 'a-4'], reason: 'picture' });
  run('join', { id: 'a-5', reason: 'broken' });
  run('split', { id: 'a-1', at_quote: 'The rain', reason: 'heading' });
  run('restore', { ids: ['a-11'], reason: 'mistake' });
  run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'link' });
  const items = b.items();
  expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['strike', 'join', 'split', 'restore', 'link']));
  for (const item of JSON.parse(JSON.stringify(items)) as unknown[]) expect(isAskMark(item)).toBe(true);
  expect(isAskMark({ id: 'x', kind: 'join', reason: 'r', before: 'b' })).toBe(false);
});
