import { expect, test } from 'bun:test';

/*
 * ASK READS THE BOOK'S HISTORY (Owen, 2026-11-02): every edit, newest first —
 * saved, unsaved and undone — with who made it; and any of them proposed back
 * as a reviewed change whose inverse is the review card's own undo. And the
 * unlink op, which a link's undo needed and Foundry did not have.
 */
const { AskHistory } = await import('../shared/ask-history');
const { askToolbox } = await import('../electron/ask-tools');
const { askViewOf, askRowStates, planLanding, planUndo } = await import('../shared/ask');
const { replayOps, parseOpsFile, formatOpsFile } = await import('../shared/ops');
import type { AskSession } from '../shared/ask';
import type { AskStackInput } from '../shared/ask-history';
import type { BookOp } from '../shared/ops';
import type { BookRow } from '../shared/book';

const BOX = { x1: 0, y1: 0, x2: 0, y2: 0 };
const row = (id: string, category: string, text: string, extra: Partial<BookRow> = {}): BookRow => ({
  id, category, text, page: 0, pages: [0], box: BOX, pageWidth: 0, pageHeight: 0,
  parts: [{ src: id, page: 0, chars: [0, text.length] }], ...extra,
}) as BookRow;

const ROWS: BookRow[] = [
  row('h-1', 'Section-header', 'One'),
  row('h-2', 'Text', 'The rain began.'),
  row('h-3', 'Caption', 'Figure 1. A flood.'),
  row('h-4', 'Text', 'The river rose and the town'),
  row('h-5', 'Text', 'watched it from the bridge.'),
  row('h-6', 'Text', 'See the note.²'),
  row('h-7', 'Footnote', '² A note.'),
];
const LOOSE = { markers: [{ block: 'h-6', at: 13, len: 1, printed: 2 }], notes: ['h-7'] };
const CHAPTERS = [{ id: 'h-1', title: 'One' }];

const SESSION: AskSession = {
  id: 'run-1', at: '2026-11-02T00:00:00Z', request: 'remove the captions', server: 's', model: 'm', summary: '',
  items: [{ id: 'h-3', kind: 'strike', reason: 'caption', before: 'Figure 1. A flood.' }], skipped: 0, rounds: 1, seconds: 1,
};

function stack(over: Partial<AskStackInput> = {}): AskStackInput {
  return {
    rows: ROWS, loose: LOOSE, chapters: CHAPTERS,
    earlier: [{ op: 'strike', id: 'h-3' }],
    kept: [{ op: 'text', id: 'h-2', text: 'The rain began on a Tuesday.' }],
    tail: [{ op: 'merge', id: 'h-5', into: 'h-4' }, { op: 'link', note: 'h-7', block: 'h-6', at: 13, len: 1 }],
    undone: [{ op: 'strike', id: 'h-1' }],
    tailGroups: ['joining the broken sentence', null],
    ...over,
  };
}

function replayAll(input: AskStackInput, more: readonly BookOp[] = []) {
  return replayOps(input.rows, [...input.earlier, ...input.kept, ...input.tail, ...more], input.loose, input.chapters);
}

test('history lists undone, unsaved and saved edits newest first, in plain words, with who made each', () => {
  const history = new AskHistory(stack(), [SESSION]);
  const { entries, matched } = history.list({});
  expect(matched).toBe(5);
  expect(entries.map((e) => [e.handle, e.where, e.said])).toEqual([
    ['r0', 'undone', 'struck h-1'],
    ['c3', 'unsaved', 'linked note h-7 to its number in h-6'],
    ['c2', 'unsaved', 'joined h-5 into h-4'],
    ['c1', 'saved', 'revised h-2'],
    ['c0', 'saved', 'struck h-3'],
  ]);
  const byHandle = new Map(entries.map((e) => [e.handle, e]));
  expect(byHandle.get('c0')!.from).toBe('Ask ("remove the captions"): caption');
  expect(byHandle.get('c2')!.from).toBe('joining the broken sentence');
  expect(byHandle.get('c3')!.from).toBe('by hand or a panel');
  expect(byHandle.get('c1')!.text).toBe('The rain began. → The rain began on a Tuesday.');
  expect(byHandle.get('c2')!.text).toBe('watched it from the bridge.');
});

test('history filters by block and by kind, and pages', () => {
  const history = new AskHistory(stack(), []);
  expect(history.list({ id: 'h-4' }).entries.map((e) => e.handle)).toEqual(['c2']);
  expect(history.list({ kind: 'strike' }).entries.map((e) => e.handle)).toEqual(['r0', 'c0']);
  const page = history.list({ offset: 1, count: 2 });
  expect(page.entries.map((e) => e.handle)).toEqual(['c3', 'c2']);
  const box = askToolbox(askViewOf(history.now(), 'B'), history);
  const said = box.call('history', JSON.stringify({ count: 2 }));
  expect(said.content).toContain('5 of 5 edits match.');
  expect(said.content).toContain('(3 older; offset:2 for the next page)');
  expect(said.said).toEqual({ verb: 'read history', detail: '5' });
  expect(askToolbox(askViewOf(history.now(), 'B')).call('history', '{}').content).toContain('history was not sent');
});

test('a revert lands as the inverse and is undone as the original, for a strike, a revision and a link', () => {
  const input = stack();
  const history = new AskHistory(input, [SESSION]);
  const box = askToolbox(askViewOf(history.now(), 'B'), history);
  expect(box.call('revert', JSON.stringify({ handles: ['c0', 'c1', 'c3'], reason: 'mistake', dry_run: true })).content)
    .toContain('c0: undo struck h-3');
  box.call('revert', JSON.stringify({ handles: ['c0', 'c1', 'c3'], reason: 'mistake' }));
  expect(box.counts().reverted).toBe(3);
  const items = box.items();
  expect(items.map((i) => i.kind)).toEqual(['revert', 'revert', 'revert']);

  const landing = planLanding(items, history.rowStatesNow(), false);
  expect(landing.skipped).toEqual([]);
  expect(landing.ops).toEqual([
    { op: 'restore', id: 'h-3' },
    { op: 'text', id: 'h-2', text: 'The rain began.' },
    { op: 'unlink', note: 'h-7', block: 'h-6', at: 13, len: 1 },
  ]);
  const after = replayAll(input, landing.ops);
  expect(after.missing).toEqual([]);
  expect(after.rows.find((r) => r.id === 'h-3')!.struck).toBeUndefined();
  expect(after.rows.find((r) => r.id === 'h-7')!.refs).toBeUndefined();

  const undo = planUndo(items, askRowStates(after.rows, after.chapters), false);
  expect(undo.skipped).toEqual([]);
  expect(undo.ops).toEqual([
    { op: 'strike', id: 'h-3' },
    { op: 'text', id: 'h-2', text: 'The rain began on a Tuesday.' },
    { op: 'link', note: 'h-7', block: 'h-6', at: 13, len: 1 },
  ]);
});

test('reverting a join is the split-based undo, and the words come back under new names', () => {
  const input = stack();
  const history = new AskHistory(input, []);
  const box = askToolbox(askViewOf(history.now(), 'B'), history);
  box.call('revert', JSON.stringify({ handles: ['c2'], reason: 'not one sentence' }));
  const landing = planLanding(box.items(), history.rowStatesNow(), false);
  const after = replayAll(input, landing.ops);
  expect(after.missing).toEqual([]);
  expect(after.rows.find((r) => r.id === 'h-4/1')!.text).toBe('The river rose and the town');
  expect(after.rows.find((r) => r.id === 'h-4/2')!.text).toBe('watched it from the bridge.');
});

test('a revert is refused by name when the block changed since, when it is undone already, and for what has no inverse', () => {
  // Struck, then restored by hand: undoing the strike would be undoing nothing.
  const restored = new AskHistory(stack({ tail: [{ op: 'restore', id: 'h-3' }], tailGroups: [null] }), []);
  const box = askToolbox(askViewOf(restored.now(), 'B'), restored);
  expect(box.call('revert', JSON.stringify({ handles: ['c0'], reason: 'x' })).content)
    .toContain('c0 cannot be undone now: it is not struck any more');
  // Revised, then revised again: the first revision's words are not there to take back.
  const twice = new AskHistory(stack({ tail: [{ op: 'text', id: 'h-2', text: 'Rain.' }], tailGroups: [null] }), []);
  expect(() => twice.revertable('c1', 'x')).toThrow('its text has changed since the run');
  const history = new AskHistory(stack(), []);
  expect(() => history.revertable('r0', 'x')).toThrow('already undone');
  const moved = new AskHistory(stack({ tail: [{ op: 'move', id: 'h-6', before: 'h-2' }], tailGroups: [null] }), []);
  expect(() => moved.revertable('c2', 'x')).toThrow('Ask cannot propose undoing');
  // A block that also carries a change from this run is not reverted on top of it.
  const both = askToolbox(askViewOf(history.now(), 'B'), history);
  both.call('mark', JSON.stringify({ ids: ['h-2'], reason: 'y' }));
  expect(both.call('revert', JSON.stringify({ handles: ['c1'], reason: 'x' })).content).toContain('also carries a change from this run');
});

test('unlink takes one number off a note: the number comes loose, and the note does when it has none left', () => {
  const linked = replayOps(ROWS, [{ op: 'link', note: 'h-7', block: 'h-6', at: 13, len: 1 }], LOOSE, CHAPTERS);
  expect(linked.loose).toEqual({ markers: [], notes: [] });
  const out = replayOps(ROWS, [
    { op: 'link', note: 'h-7', block: 'h-6', at: 13, len: 1 },
    { op: 'unlink', note: 'h-7', block: 'h-6', at: 13, len: 1 },
  ], LOOSE, CHAPTERS);
  expect(out.missing).toEqual([]);
  expect(out.rows.find((r) => r.id === 'h-7')!.refs).toBeUndefined();
  expect(out.loose.markers).toEqual([{ block: 'h-6', at: 13, len: 1, printed: 2 }]);
  expect(out.loose.notes).toEqual(['h-7']);
  // A number the note does not carry is refused by name.
  const none = replayOps(ROWS, [{ op: 'unlink', note: 'h-7', block: 'h-6', at: 0, len: 1 }], LOOSE, CHAPTERS);
  expect(none.missing[0]!.why).toContain('carries no reference number at those characters');
  // It survives the ops file both ways.
  const op: BookOp = { op: 'unlink', note: 'h-7', block: 'h-6', at: 13, len: 1 };
  expect(parseOpsFile(formatOpsFile([op]))).toEqual([op]);
  expect(() => parseOpsFile('{"op":"unlink","note":"h-7","at":1,"len":1}\n')).toThrow('without naming both');
});

test('Ask\'s own link is now undone by an unlink in review', () => {
  const view = askViewOf(replayOps(ROWS, [], LOOSE, CHAPTERS), 'B');
  const box = askToolbox(view);
  box.call('link_footnote', JSON.stringify({ note: 'h-7', block: 'h-6', number: '²', reason: 'link' }));
  const items = box.items();
  const landed = planLanding(items, askRowStates(ROWS.map((r) => ({ ...r })), CHAPTERS), false);
  const after = replayOps(ROWS, landed.ops, LOOSE, CHAPTERS);
  const undo = planUndo(items, askRowStates(after.rows, after.chapters), false);
  expect(undo.skipped).toEqual([]);
  expect(undo.ops).toEqual([{ op: 'unlink', note: 'h-7', block: 'h-6', at: 13, len: 1 }]);
});
