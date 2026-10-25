/**
 * WHAT "REMOVE ALL" ON A CHAPTER STRIKES (Owen, 2026-10-25): the chapter's
 * opening block and every block after it up to the next division — its notes
 * included, nothing of the next chapter, nothing shelved, nothing already struck.
 */
import { expect, test } from 'bun:test';

import { chapterSpan } from '../src/app/components/book-view/flow';

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, category: 'Text', text: id, ...extra }) as never;

const rows = [
  row('intro'), row('c1'), row('c1-a'), row('c1-note', { category: 'Footnote' }),
  row('notes'), row('n1'), row('n2', { struck: true }), row('n3', { shelf: { why: 'running head' } }), row('n4'),
];
const opens = new Set(['c1', 'notes']);

test('a chapter is its opening block and every block up to the next division', () => {
  expect(chapterSpan(rows, opens, 'c1')).toEqual(['c1', 'c1-a', 'c1-note']);
});

test('the last chapter runs to the end, skipping shelved and already-struck blocks', () => {
  expect(chapterSpan(rows, opens, 'notes')).toEqual(['notes', 'n1', 'n4']);
});

test('an id that opens no chapter holds nothing', () => {
  expect(chapterSpan(rows, opens, 'c1-a')).toEqual([]);
});
