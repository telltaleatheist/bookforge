import { expect, test } from 'bun:test';

/*
 * A NOTE RETYPED AS ANYTHING ELSE STOPS BEING A NOTE (Owen, 2026-11-01). In
 * Escape from Camp 14 the chapter number "2" (e-178) was read as a footnote and
 * bound to the lone "2"s in the table of contents (e-34) and a quote (e-1421);
 * retyped as a Title, it still opened the note card. The replay owns the rule.
 */
const { replayOps, struckNotes } = await import('../shared/ops');
import type { BookRow } from '../shared/book';

const BOX = { x1: 0, y1: 0, x2: 0, y2: 0 };
function row(id: string, category: string, text: string, extra: Partial<BookRow> = {}): BookRow {
  return {
    id, category, text, page: 0, pages: [0], box: BOX, pageWidth: 0, pageHeight: 0,
    parts: [{ src: id, page: 0, chars: [0, text.length] }],
    ...extra,
  } as BookRow;
}

const ROWS: BookRow[] = [
  row('e-34', 'Text', '2'),
  row('e-178', 'Footnote', '2', { note: 2, refs: [{ block: 'e-34', at: 0, len: 1 }, { block: 'e-1421', at: 0, len: 1 }] }),
  row('e-179', 'Text', 'The prose of chapter two.'),
  row('e-1421', 'Quote', '2'),
  row('e-2000', 'Footnote', '¹ A real note.', { note: 1, refs: [{ block: 'e-179', at: 3, len: 1 }] }),
];
const LOOSE = { markers: [], notes: [] };

test('a footnote retyped as a Title drops its note and refs, and its numbers come loose', () => {
  const out = replayOps(ROWS, [{ op: 'category', id: 'e-178', category: 'Title' }], LOOSE);
  const heading = out.rows.find((r) => r.id === 'e-178')!;
  expect(heading.category).toBe('Title');
  expect(heading.refs).toBeUndefined();
  expect(heading.note).toBeUndefined();
  expect(out.loose.markers).toEqual([
    { block: 'e-34', at: 0, len: 1, printed: 2 },
    { block: 'e-1421', at: 0, len: 1, printed: 2 },
  ]);
  // The other note is untouched, object and all.
  expect(out.rows.find((r) => r.id === 'e-2000')).toBe(ROWS[4]);
});

test('the same holds on the interpreting path, beside a structural op', () => {
  const out = replayOps(ROWS, [
    { op: 'category', id: 'e-178', category: 'Section-header' },
    { op: 'split', id: 'e-179', at: 4 },
  ], LOOSE);
  expect(out.rows.find((r) => r.id === 'e-178')!.refs).toBeUndefined();
  expect(out.loose.markers.map((m) => m.block)).toEqual(['e-34', 'e-1421']);
});

test('a retyped note leaves the loose notes, and is never a struck note', () => {
  const out = replayOps(ROWS, [
    { op: 'category', id: 'e-178', category: 'Title' },
    { op: 'strike', id: 'e-178' },
  ], { markers: [], notes: ['e-178'] });
  expect(out.loose.notes).toEqual([]);
  expect(struckNotes(out.rows).has('e-178')).toBe(false);
});

test('retyping it back to a Footnote brings the file\'s links back', () => {
  const out = replayOps(ROWS, [
    { op: 'category', id: 'e-178', category: 'Title' },
    { op: 'category', id: 'e-178', category: 'Footnote' },
  ], LOOSE);
  expect(out.rows.find((r) => r.id === 'e-178')!.refs).toEqual(ROWS[1]!.refs!);
  expect(out.loose.markers).toEqual([]);
});

test('a chain that retypes no note returns the replay as it was', () => {
  const out = replayOps(ROWS, [{ op: 'category', id: 'e-179', category: 'Quote' }], LOOSE);
  expect(out.loose).toEqual(LOOSE);
  expect(out.rows.find((r) => r.id === 'e-178')).toBe(ROWS[1]);
});
