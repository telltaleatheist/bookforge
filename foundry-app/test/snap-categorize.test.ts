/**
 * THE CATEGORIZE TILE'S PURE HALF — what snap is shown, and what its answers
 * become (shared/snap-categorize.ts). No model and no server: the answers are
 * written here the way snap's `/v1/decide` returns them.
 */
import { describe, expect, test } from 'bun:test';

import { formatOpsFile, parseOpsFile } from '../shared/ops';
import {
  blockLine, bookHeader, buildWindows, decide, estimateTokens, isAsked, runTitle,
  windowState, type SnapChoiceAnswer, type SnapRow,
} from '../shared/snap-categorize';

const answer = (choice: string, confidence = 0.95, labelMass = 0.99): SnapChoiceAnswer => ({
  choice, confidence, label_mass: labelMass, probabilities: { [choice]: confidence },
});

const rows: SnapRow[] = [
  { id: 'e-1', category: 'Picture', text: 'Cover' },
  { id: 'e-2', category: 'Text', text: '1' },
  { id: 'e-3', category: 'Text', text: 'KILLING AMERICA' },
  { id: 'e-4', category: 'Text', text: 'It began on a Tuesday.' },
  { id: 'e-5', category: 'Text', text: 'The Long Road' },
  { id: 'e-6', category: 'Text', text: 'Nobody expected the rain.' },
];

describe('decide — what an answer does to a block', () => {
  test('a confident different answer changes the category; the same answer changes nothing', () => {
    const d = decide(rows, new Map([
      ['e-4', answer('Text')],
      ['e-5', answer('Section-header')],
    ]), []);
    expect(d.categoryOps).toEqual([{ op: 'category', id: 'e-5', category: 'Section-header' }]);
    expect(d.report.map((r) => [r.id, r.outcome])).toEqual([['e-4', 'same'], ['e-5', 'changed']]);
  });

  test('an unsure answer, or one whose letters held little of the probability, leaves the block alone', () => {
    const d = decide(rows, new Map([
      ['e-4', answer('Quote', 0.4)],
      ['e-6', answer('Footnote', 0.9, 0.5)],
    ]), []);
    expect(d.categoryOps).toEqual([]);
    expect(d.report.map((r) => r.outcome)).toEqual(['low-confidence', 'low-label-mass']);
  });

  test('a run of chapter-heading rows gets ONE chapter marker, at its first row, titled from the run', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')],
      ['e-3', answer('Title')],
    ]), []);
    expect(d.chapterOps).toEqual([{ op: 'chapter', set: 'e-2', title: '1: KILLING AMERICA' }]);
  });

  test('no marker where the book already has a chapter at the heading or just above it', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')], ['e-3', answer('Title')],
      ['e-5', answer('Title')],
    ]), [{ id: 'e-1', title: 'Chapter 1' }, { id: 'e-5', title: 'The Long Road' }]);
    expect(d.chapterOps).toEqual([]);
  });

  test('chapters are only ever ADDED: a publisher chapter the model reads as body text is kept', () => {
    const d = decide(rows, new Map([['e-4', answer('Text')]]), [{ id: 'e-4', title: 'Odd entry' }]);
    expect(d.chapterOps.every((op) => 'set' in op)).toBe(true);
    expect(d.chapterOps).toEqual([]);
  });

  test('the ops it produces are ones the ops file itself accepts (the Apply door re-parses them)', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')], ['e-3', answer('Title')], ['e-5', answer('Section-header')],
    ]), []);
    const ops = [...d.categoryOps, ...d.chapterOps];
    expect(parseOpsFile(formatOpsFile(ops))).toEqual(ops);
  });
});

describe('what snap is shown', () => {
  test('pictures, tables, formulas and empty blocks are not asked about', () => {
    expect(rows.filter(isAsked).map((r) => r.id)).toEqual(['e-2', 'e-3', 'e-4', 'e-5', 'e-6']);
    expect(isAsked({ id: 'x', category: 'Text', text: '   ' })).toBe(false);
  });

  test('the header carries the contents as a hint, and says so when there are none', () => {
    expect(bookHeader('B', [{ id: 'e-2', title: '1: Killing America' }])).toContain('- 1: Killing America');
    expect(bookHeader('B', [])).toContain('none');
  });

  test('a book that fits is one window — "the whole book"', () => {
    const windows = buildWindows(rows, new Set(), 50, 100_000);
    expect(windows).toEqual([{ start: 0, end: rows.length }]);
    expect(windowState('H', rows, windows[0]!, 0, 1)).toContain('the whole book');
  });

  test('a longer book is cut into windows that cover every row once, in order', () => {
    const many: SnapRow[] = Array.from({ length: 200 }, (_, i) => ({ id: `e-${i}`, category: 'Text', text: 'word '.repeat(40) }));
    const per = estimateTokens(blockLine(many[0]!)) + 1;
    const windows = buildWindows(many, new Set(), 10, 10 + per * 30);
    expect(windows[0]).toEqual({ start: 0, end: 30 });
    expect(windows.map((w) => w.end - w.start).reduce((a, b) => a + b, 0)).toBe(200);
    for (let i = 1; i < windows.length; i += 1) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
  });

  test('a full window ends at a chapter start past its middle rather than mid-chapter', () => {
    const many: SnapRow[] = Array.from({ length: 100 }, (_, i) => ({ id: `e-${i}`, category: 'Text', text: 'word '.repeat(40) }));
    const per = estimateTokens(blockLine(many[0]!)) + 1;
    const windows = buildWindows(many, new Set(['e-22']), 10, 10 + per * 30);
    expect(windows[0]).toEqual({ start: 0, end: 22 });
  });

  test('a window too small for the header is refused by name', () => {
    expect(() => buildWindows(rows, new Set(), 500, 400)).toThrow(/cannot even hold/);
  });
});

describe('runTitle', () => {
  test('a number line joins the title with a colon, the navigation\'s own shape', () => {
    expect(runTitle(['1', 'KILLING AMERICA'])).toBe('1: KILLING AMERICA');
    expect(runTitle(['Chapter XII', 'The End'])).toBe('Chapter XII: The End');
    expect(runTitle(['Preface'])).toBe('Preface');
    expect(runTitle(['The Long', 'Road'])).toBe('The Long Road');
  });
});
