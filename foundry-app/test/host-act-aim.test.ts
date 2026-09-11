/**
 * WHAT THE DOCK'S HOST ACT NAMES — the regression test for the day Narrate on
 * the dock did nothing that Narrate on the grayed cleanup's card did.
 *
 * Kept beside `hosted-shelf.test.ts` for the reason its header gives: `shared/`
 * is compiled by `app/tsconfig.electron.json`, and a test here is run by
 * `bun test` without dragging the app graph into the root program.
 */
import { expect, test } from 'bun:test';

import { exportNodeId } from '../shared/host-ops';
import { hostActAimFrom } from '../shared/stages';
import type { LedgerStep, ProjectLedger } from '../shared/types';

const IMPORT_EPUB: LedgerStep = {
  id: 'import-1', parent: null, action: 'import', payload: 'archive/book.epub',
  retention: 'irreplaceable', createdAt: 1, label: 'The book you imported',
};
const IMPORT_PDF: LedgerStep = { ...IMPORT_EPUB, id: 'import-2', payload: 'archive/scan.pdf' };
const EDIT: LedgerStep = {
  id: 'edit-1', parent: IMPORT_EPUB.id, action: 'edit', payload: 'ops/edit-1.jsonl',
  retention: 'irreplaceable', createdAt: 2, label: 'Applied changes (137)',
};
const PROMISED_CLEAN: LedgerStep = {
  id: 'mint-clean', parent: EDIT.id, action: 'clean', payload: '',
  retention: 'irreplaceable', createdAt: 3, label: 'Cleaned for narration',
};
const EPUB_BOOK: ProjectLedger = { steps: [IMPORT_EPUB, EDIT], position: EDIT.id };
const SCAN: ProjectLedger = { steps: [IMPORT_PDF], position: IMPORT_PDF.id };

const NONE = { promised: null, finished: [], viewing: null, standing: EDIT, ledger: EPUB_BOOK };

test('the promise the window stands on wins over an export on screen and over the one in the tray', () => {
  expect(hostActAimFrom({
    ...NONE, promised: PROMISED_CLEAN, finished: ['old.epub'], viewing: 'old.epub',
  })).toEqual({ kind: 'node', nodeId: 'mint-clean' });
  expect(hostActAimFrom({ ...NONE, promised: PROMISED_CLEAN, finished: ['old.epub'] }))
    .toEqual({ kind: 'node', nodeId: 'mint-clean' });
});

test('with no promise, the finished export on screen is named, then the only one, and several is a refusal', () => {
  expect(hostActAimFrom({ ...NONE, finished: ['a.epub', 'b.epub'], viewing: 'b.epub' }))
    .toEqual({ kind: 'node', nodeId: exportNodeId('b.epub') });
  expect(hostActAimFrom({ ...NONE, finished: ['a.epub'] }))
    .toEqual({ kind: 'node', nodeId: exportNodeId('a.epub') });
  expect(hostActAimFrom({ ...NONE, finished: ['a.epub', 'b.epub'] }))
    .toEqual({ kind: 'refuse', why: 'several-exports' });
  // A tab showing a file that is not one of this book's finished exports is not "viewing".
  expect(hostActAimFrom({ ...NONE, finished: ['a.epub', 'b.epub'], viewing: 'elsewhere.epub' }))
    .toEqual({ kind: 'refuse', why: 'several-exports' });
});

test('a position names itself; no position is a refusal', () => {
  expect(hostActAimFrom(NONE)).toEqual({ kind: 'node', nodeId: 'edit-1' });
  expect(hostActAimFrom({ ...NONE, standing: null })).toEqual({ kind: 'refuse', why: 'no-position' });
});

test('an import row that IS the book (an EPUB) names itself, as the tree does; a scan is refused', () => {
  expect(hostActAimFrom({ ...NONE, standing: IMPORT_EPUB, ledger: EPUB_BOOK }))
    .toEqual({ kind: 'node', nodeId: 'import-1' });
  expect(hostActAimFrom({ ...NONE, standing: IMPORT_PDF, ledger: SCAN }))
    .toEqual({ kind: 'refuse', why: 'a-scan' });
  expect(hostActAimFrom({ ...NONE, standing: IMPORT_EPUB, ledger: null }))
    .toEqual({ kind: 'refuse', why: 'a-scan' });
});
