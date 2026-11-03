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

/**
 * ── WHICH GUIDE AN ADJUSTED STEP CAME FROM ─────────────────────────────────────
 *
 * Owen, 2026-11-02: the guide and the cleanup run as one step — the guide is built
 * on the step being cleaned, the cleanup protects its places without writing them,
 * and the guide is applied LAST, as "Pronunciation adjusted" under the CLEANED step,
 * so deleting that leaf takes the corrections out and leaves the cleanup alone. So
 * an adjusted step's parent is no longer always the step its guide belongs to: the
 * guide on A lands under A's cleanup.
 *
 * Each adjusted step this app queues is therefore written down with its guide's step
 * in `readings/<key>.pronunciation-adjusted.json`. One that is not written down is
 * from before (or from the guide's own Apply on its own step), and its guide is its
 * parent's — which is what every adjusted step was until this.
 */
const ADJUSTED_FORMAT = 'pronunciation-adjusted/v1';

/**
 * `guides`: adjusted step → the step whose guide it applied. `cleaned`: cleanup step →
 * the step whose guide that cleanup read (protected or written in) — so pressing the
 * guide on a cleaned step opens the guide its text was made with, not an empty one
 * offering to build another (Owen, 2026-11-02: *"pronunciation guide is one of the
 * buttons it shows. but that should already be done as part of that line item"*).
 * `cleaned` is absent from records written before it.
 */
interface AdjustedRecord { format: typeof ADJUSTED_FORMAT; guides: Record<string, string>; cleaned?: Record<string, string> }

function adjustedRecordPath(projectDir: string): string {
  const manifest = path.join(projectDir, 'project.json');
  const key = (JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, '')) as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${manifest} names no project key, so there is no telling where its adjusted steps are written down.`);
  }
  return path.join(projectDir, 'readings', `${key}.pronunciation-adjusted.json`);
}

function adjustedRecord(projectDir: string): AdjustedRecord {
  const file = adjustedRecordPath(projectDir);
  if (!fs.existsSync(file)) return { format: ADJUSTED_FORMAT, guides: {} };
  const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AdjustedRecord>;
  if (body.format !== ADJUSTED_FORMAT || typeof body.guides !== 'object' || body.guides === null
    || (body.cleaned !== undefined && (typeof body.cleaned !== 'object' || body.cleaned === null))) {
    throw new Error(`${file} is not a ${ADJUSTED_FORMAT} record, so which guide each adjusted step came from cannot be read.`);
  }
  return { format: ADJUSTED_FORMAT, guides: body.guides, ...(body.cleaned === undefined ? {} : { cleaned: body.cleaned }) };
}

function adjustedGuides(projectDir: string): Record<string, string> {
  return adjustedRecord(projectDir).guides;
}

async function writeAdjustedRecord(projectDir: string, body: AdjustedRecord): Promise<void> {
  const file = adjustedRecordPath(projectDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.partial`, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  const { renameWithRetry } = await import('./fs-retry.js');
  await renameWithRetry(`${file}.partial`, file);
}

/** Write down that adjusted step `stepId` is the guide on step `guide`, applied. */
export async function recordAdjusted(projectDir: string, stepId: string, guide: string): Promise<void> {
  const held = adjustedRecord(projectDir);
  await writeAdjustedRecord(projectDir, { ...held, guides: { ...held.guides, [stepId]: guide } });
}

/** Write down that cleanup step `stepId` read the guide on step `guide`. */
export async function recordCleanedWith(projectDir: string, stepId: string, guide: string): Promise<void> {
  // A book with no manifest has no ledger to open a guide from (the queue keepers' books are such).
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return;
  const held = adjustedRecord(projectDir);
  if (held.cleaned?.[stepId] === guide) return;
  await writeAdjustedRecord(projectDir, { ...held, cleaned: { ...(held.cleaned ?? {}), [stepId]: guide } });
}

/**
 * THE GUIDE STEP `step`'S TEXT WAS MADE WITH, from what was written down, or null:
 * an adjusted step's guide (recorded, or its parent's for one from before the
 * record), or the guide a cleanup read. Greyed steps count — both are written down
 * when the work is queued, before it lands. A step with no ledger has none.
 */
export function guideTextMadeWith(projectDir: string, step: string): string | null {
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return null;
  const record = adjustedRecord(projectDir);
  const recorded = record.guides[step] ?? record.cleaned?.[step];
  if (recorded !== undefined) return recorded;
  const row = ledgerStepsOf(projectDir).find((s) => s.id === step);
  if (row !== undefined && typeof row.parent === 'string' && appliedLabelNumber(row.params?.readings) !== null) {
    return row.parent;
  }
  return null;
}

interface AppliedRow { id: string; label: string; parent: string; guide: string; n: number; children: number }

/** Every adjusted step in the ledger, with the guide each came from. */
function appliedRows(projectDir: string): AppliedRow[] {
  const steps = ledgerStepsOf(projectDir);
  const guides = adjustedGuides(projectDir);
  return steps
    .filter((s) => typeof s.parent === 'string' && appliedLabelNumber(s.params?.readings) !== null)
    .map((s) => ({
      id: s.id,
      label: s.label ?? String(s.params!.readings),
      parent: s.parent!,
      guide: guides[s.id] ?? s.parent!,
      n: appliedLabelNumber(s.params!.readings)!,
      children: steps.filter((c) => c.parent === s.id).length,
    }));
}

/** Every step the guide on `at` landed as — under `at`, or under its cleanup — first to latest. */
export function appliedStepsOf(projectDir: string, at: string): AppliedRow[] {
  return appliedRows(projectDir).filter((row) => row.guide === at).sort((a, b) => a.n - b.n);
}

/** The LATEST step the guide on `at` landed as, and the step it hangs under, or null. */
export function appliedStepOf(projectDir: string, at: string): { id: string; label: string; parent: string } | null {
  const all = appliedStepsOf(projectDir, at);
  const latest = all[all.length - 1];
  return latest === undefined ? null : { id: latest.id, label: latest.label, parent: latest.parent };
}

/**
 * THE LABEL THE NEXT ADJUSTED STEP UNDER `parent` LANDS AS, for the guide on step
 * `guide` (shared/pronunciation-guide.ts `APPLIED_LABEL`). Labels are a question about
 * SIBLINGS, since a label is which step it is under its parent: the latest adjusted
 * step there keeps its label, so it is REPLACED, when it is this guide's and nothing
 * hangs under it; otherwise the next number, so the branch built on it — or another
 * guide's corrections beside it — stays exactly as it was. A step with no ledger (the
 * queue keepers' books) has none.
 */
export function nextAppliedLabel(projectDir: string, parent: string, guide: string = parent): string {
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return APPLIED_LABEL;
  const siblings = appliedRows(projectDir).filter((row) => row.parent === parent).sort((a, b) => a.n - b.n);
  const latest = siblings[siblings.length - 1];
  if (latest === undefined) return APPLIED_LABEL;
  return latest.children === 0 && latest.guide === guide ? appliedLabelFor(latest.n) : appliedLabelFor(latest.n + 1);
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
