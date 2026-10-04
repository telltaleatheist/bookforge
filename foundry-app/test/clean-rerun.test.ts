/**
 * A CLEANUP PRESSED AGAIN CLEANS AGAIN (Owen, 2026-10-03).
 *
 * *"if we have a completed cleanup step, and it goes back through cleanup again,
 * it should just do cleanup again. it should never use a completed stage as a
 * justification to skip it. it should only ever pick up where it left off if it
 * isnt completed yet."*
 *
 * What `translationTarget` owes that:
 *   * a cleanup that replaces a LANDED cleanup writes a file of its own, named for
 *     this press, so it starts with no answers — and still replaces the step;
 *   * a first cleanup keeps the plain name;
 *   * translate is unchanged: a re-translation re-asks only what changed.
 */
import { expect, test } from 'bun:test';

import { translationTarget, type ProjectLedger } from '../shared/ledger';

const KEY = 'hellworld-f430e6ab';
const EDIT = '5edfe7a7-da61-4828-94fd-95699a1c162e';
const MINTED = '9b1f3c2a-0000-4000-8000-000000000001';

function ledger(steps: ProjectLedger['steps']): ProjectLedger {
  return { steps, position: steps[steps.length - 1]!.id } as ProjectLedger;
}

const base = [
  { id: 'f3d6ad39', parent: null, action: 'import', payload: 'archive/book.epub', retention: 'irreplaceable', createdAt: 1, label: 'The book you imported' },
  { id: EDIT, parent: 'f3d6ad39', action: 'edit', payload: 'ops/5edfe7a7.jsonl', retention: 'irreplaceable', createdAt: 2, label: 'Applied changes (34)' },
] as ProjectLedger['steps'];

test('a first cleanup keeps the plain records name', () => {
  const target = translationTarget(ledger(base), { action: 'clean', parent: EDIT, key: KEY }, MINTED);
  expect(target).toEqual({ stepId: MINTED, records: `readings/${KEY}.clean.records.jsonl`, replaces: null });
});

test('a cleanup that replaces a finished one starts its own file, and still replaces the step', () => {
  const landed = {
    id: 'e4a5929d', parent: EDIT, action: 'clean', payload: `readings/${KEY}.clean.records.jsonl`,
    retention: 'expensive', createdAt: 3, label: 'Cleaned for narration',
  } as ProjectLedger['steps'][number];
  const target = translationTarget(ledger([...base, landed]), { action: 'clean', parent: EDIT, key: KEY }, MINTED);
  expect(target.stepId).toBe('e4a5929d');
  expect(target.replaces?.id).toBe('e4a5929d');
  // Not the finished step's file — every block would be found answered and nothing asked.
  expect(target.records).toBe(`readings/${KEY}.clean.9b1f3c2a.records.jsonl`);
  // Another press is another file.
  const again = translationTarget(ledger([...base, landed]), { action: 'clean', parent: EDIT, key: KEY },
    '7c4e1d00-0000-4000-8000-000000000002');
  expect(again.records).toBe(`readings/${KEY}.clean.7c4e1d00.records.jsonl`);
});

test('a re-translation still aims at its own records, re-asking only what changed', () => {
  const landed = {
    id: 'aa11bb22', parent: EDIT, action: 'translate', payload: `readings/${KEY}.de.records.jsonl`,
    retention: 'expensive', createdAt: 3, label: 'Translated into German', params: { language: 'de' },
  } as ProjectLedger['steps'][number];
  const target = translationTarget(ledger([...base, landed]), { action: 'translate', parent: EDIT, key: KEY, language: 'de' }, MINTED);
  expect(target.replaces?.id).toBe('aa11bb22');
  expect(target.records).toBe(`readings/${KEY}.de.records.jsonl`);
});
