/**
 * A STEP THE PRONUNCIATION GUIDE WAS APPLIED AS — Foundry's readings-only pass
 * (4ae272b), filed under APPLIED_LABEL ("Pronunciation adjusted", or "(n)" for a
 * later sibling) as a child of the guide's step.
 *
 * Owen, 2026-11-01, agreeing the shape: the guide is applied as its own step, and
 * *"cleanup keeps respecting it"*. A cleanup made from an applied step therefore does
 * not build a guide over the applied text — the words are already said — and is handed
 * every place the apply wrote as a KEPT spot (`{find: replace, replace, at, nth}`), so
 * the sentence pass protects "U S M C" exactly as it protected the guide's reading of
 * "USMC" in a cleanup of the step above. Foundry's applied record names each place in
 * the WRITTEN block (`nthAfter`), which is what makes that possible.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APPLIED_LABEL, appliedLabelFor, appliedLabelNumber } from '../shared/pronunciation-guide';

interface LedgerStepRow {
  id: string;
  parent?: string;
  label?: string;
  payload?: string;
  params?: { readings?: unknown };
}

/** The project's ledger steps, as far as the guide needs them. */
export function ledgerStepsOf(projectDir: string): LedgerStepRow[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8').replace(/^﻿/, '')) as {
    ledger?: { steps?: LedgerStepRow[] };
  };
  return manifest.ledger?.steps ?? [];
}

/** Every child of `at` an Apply of its guide landed as, first to latest. */
export function appliedStepsOf(projectDir: string, at: string): { id: string; label: string; n: number; children: number }[] {
  const steps = ledgerStepsOf(projectDir);
  return steps
    .filter((s) => s.parent === at && appliedLabelNumber(s.params?.readings) !== null)
    .map((s) => ({
      id: s.id,
      label: s.label ?? String(s.params!.readings),
      n: appliedLabelNumber(s.params!.readings)!,
      children: steps.filter((c) => c.parent === s.id).length,
    }))
    .sort((a, b) => a.n - b.n);
}

/** The LATEST child of `at` an Apply of its guide landed as, or null. */
export function appliedStepOf(projectDir: string, at: string): { id: string; label: string } | null {
  const all = appliedStepsOf(projectDir, at);
  const latest = all[all.length - 1];
  return latest === undefined ? null : { id: latest.id, label: latest.label };
}

/**
 * THE LABEL THE NEXT APPLY OF `at`'S GUIDE LANDS UNDER (shared/pronunciation-guide.ts
 * `APPLIED_LABEL`): the latest adjusted step's own, so it is REPLACED, while nothing
 * hangs under it; the next number once something does, so the branch built on it
 * stays exactly as it was. A step with no ledger (the queue keepers' books) has none.
 */
export function nextAppliedLabel(projectDir: string, at: string): string {
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return APPLIED_LABEL;
  const all = appliedStepsOf(projectDir, at);
  const latest = all[all.length - 1];
  if (latest === undefined) return APPLIED_LABEL;
  return latest.children === 0 ? appliedLabelFor(latest.n) : appliedLabelFor(latest.n + 1);
}

/**
 * Step `stepId`, when it IS an applied step: the step its guide belongs to, and its
 * applied record — `<records minus .jsonl>.applied.json` (Foundry's
 * `appliedReadingsPathFor`, src/clean/apply-readings.ts, which this app cannot import:
 * the engine is a bundle). Null for any other step.
 */
export function appliedStepInfo(projectDir: string, stepId: string): { from: string; record: string } | null {
  // No manifest is no ledger, and a step of no ledger was applied from nothing (the queue keepers' books are such).
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return null;
  const step = ledgerStepsOf(projectDir).find((s) => s.id === stepId);
  if (step === undefined || appliedLabelNumber(step.params?.readings) === null) return null;
  if (typeof step.payload !== 'string' || step.payload.length === 0 || typeof step.parent !== 'string') {
    throw new Error(`Step ${stepId} was applied from a pronunciation guide but names no records or no parent, `
      + 'so the places it wrote cannot be found.');
  }
  const records = path.resolve(projectDir, step.payload);
  return { from: step.parent, record: `${records.replace(/\.jsonl$/i, '')}.applied.json` };
}

/**
 * THE APPLIED PLACES, AS KEPT SPOTS for a cleanup of the applied step: written beside
 * the record as a fixed-readings/v1 file, and its path. A place Foundry could not name
 * as a whole token run in the written block (`nthAfter` null) has no spot to keep.
 */
export async function keptReadingsOfApplied(record: string): Promise<{ path: string; places: number }> {
  if (!fs.existsSync(record)) {
    throw new Error(`The applied step's record (${record}) is missing, so its places cannot be protected from the `
      + 'cleanup. Apply the guide again from the step above.');
  }
  const body = JSON.parse(fs.readFileSync(record, 'utf8')) as {
    format?: unknown; applied?: { at?: unknown; replace?: unknown; nthAfter?: unknown }[];
  };
  if (body.format !== 'applied-readings/v1' || !Array.isArray(body.applied)) {
    throw new Error(`${record} is not an applied-readings/v1 record, so this app cannot read what was applied.`);
  }
  const readings = body.applied
    .filter((a) => typeof a.at === 'string' && typeof a.replace === 'string' && typeof a.nthAfter === 'number')
    .map((a) => ({ find: a.replace as string, replace: a.replace as string, at: a.at as string, nth: a.nthAfter as number }));
  const out = record.replace(/\.applied\.json$/i, '.applied.kept.json');
  fs.writeFileSync(`${out}.partial`, `${JSON.stringify({ format: 'fixed-readings/v1', readings }, null, 2)}\n`, 'utf8');
  const { renameWithRetry } = await import('./fs-retry.js');
  await renameWithRetry(`${out}.partial`, out);
  return { path: out, places: readings.length };
}
