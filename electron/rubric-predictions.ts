/**
 * Rubric predictions as project state — the write half of headless Detect, and
 * the error report that comes back out after a human corrects it.
 *
 * The app's in-picker Detect mode is deliberately PREVIEW ONLY: predictions live
 * in a signal, paint through `categoryOverride`, and are dropped on close. That is
 * right for "what would the model say", and wrong for the labelling loop, which
 * needs the predictions to still be there tomorrow so a human can walk the book
 * correcting them. So this module persists a run.
 *
 * THE POINT IS THE DIFF, not the predictions. A prediction that a human then
 * corrects is a labelled training example *and* a measurement of where the model
 * fails. Both are lost if predictions and corrections end up in the same field —
 * so the run is snapshotted immutably in `editor.rubricPredictions` and the
 * corrections land where they always land, in `editor.categoryCorrections`.
 * `buildRubricErrorReport` reads the two and subtracts.
 *
 * Two invariants, both learned the hard way elsewhere in this codebase:
 *
 *   1. HAND LABELS ARE INVIOLABLE. A block already in `categoryCorrections` is
 *      never repainted, matching the aligner-import path. Detect is allowed to
 *      fill in what nobody has judged; it is not allowed to argue with a human.
 *   2. PREDICTIONS MUST MATCH THE BLOCK SET THEY WERE MADE AGAINST. Block ids
 *      embed `Math.random()`, so a re-OCR mints new ones and every prediction
 *      keyed to the old ones is silently meaningless. A run whose ids are not in
 *      the manifest is refused rather than partially applied.
 */

import * as path from 'path';
import type { ProjectManifest } from './manifest-types';
import { getManifest, getManifestPath, modifyManifest, setLibraryBasePath } from './manifest-service';
import type { TextBlock } from '../shared/ocr/text-block';
import { BLOCK_CATEGORIES } from '../shared/ocr/block-categories';

const LEGAL = new Set(BLOCK_CATEGORIES.map(c => c.id));

/** One persisted Detect run. Immutable once written; a re-run replaces it whole. */
export interface RubricPredictionRun {
  /** The served model id. Its version segment picked the prompt, so it is evidence. */
  model: string;
  /** Prompt format actually used (1 | 2 | 3), from `rubricVersionFor()`. */
  promptVersion: number;
  ranAt: string;
  /** Predictions keyed by block id. Only legal classes; the encoder drops the rest. */
  predictions: Record<string, string>;
  /** Blocks the model returned no usable line for — kept, because a silent gap reads as agreement. */
  unpredicted: string[];
  /**
   * `category_id` as it stood BEFORE this run, per block it changed. The heuristic's
   * answer is the model's `guess` feature and a fallback if a run turns out bad, and
   * re-running post-processing to recover it would mint new ids.
   */
  replaced: Record<string, string>;
  counts: Record<string, number>;
  pages: number;
  blocks: number;
}

/** A project located without needing the source PDF (Detect re-uses stored blocks). */
interface ProjectRef {
  projectDir: string;
  projectId: string;
  libraryRoot: string;
  manifestPath: string;
}

/**
 * `<library>/projects/<id>` — the id IS the folder name and the library is two
 * levels up, which is the same assumption `resolveOcrProjectTarget` makes. No sha
 * check here: Detect never touches geometry, it only labels blocks that are
 * already in this manifest, and the id match in `persist` is the real guard.
 */
export function resolveProjectRef(projectDir: string): ProjectRef {
  const dir = path.resolve(projectDir);
  const projectId = path.basename(dir);
  const libraryRoot = path.resolve(dir, '..', '..');
  setLibraryBasePath(libraryRoot);
  return { projectDir: dir, projectId, libraryRoot, manifestPath: getManifestPath(projectId) };
}

function editorOf(manifest: ProjectManifest): Record<string, any> {
  return (manifest.editor ?? {}) as Record<string, any>;
}

export function storedBlocks(manifest: ProjectManifest): TextBlock[] {
  const blocks = editorOf(manifest)['ocrBlocks'];
  return Array.isArray(blocks) ? blocks as TextBlock[] : [];
}

export function storedCorrections(manifest: ProjectManifest): Record<string, string> {
  const c = editorOf(manifest)['categoryCorrections'];
  if (!c) return {};
  // The picker persists this as entry pairs; a manifest written by another path
  // may hold a plain object. Accept both rather than silently reading zero labels.
  if (Array.isArray(c)) return Object.fromEntries(c as Array<[string, string]>);
  return c as Record<string, string>;
}

/** Read a project's blocks without taking the write lock. */
export async function readProjectBlocks(
  ref: ProjectRef,
): Promise<{ manifest: ProjectManifest; blocks: TextBlock[]; corrections: Record<string, string> }> {
  const manifest = await getManifest(ref.projectId);
  if (!manifest) throw new Error(`no manifest at ${ref.manifestPath}`);
  const blocks = storedBlocks(manifest);
  if (blocks.length === 0) {
    throw new Error(
      `${ref.manifestPath} has no editor.ocrBlocks — there is nothing to classify.\n` +
      `  OCR it first:  node --require cli/electron-stub.js cli/ocr-pdf.js <pdf> --project ${ref.projectDir}`);
  }
  return { manifest, blocks, corrections: storedCorrections(manifest) };
}

/**
 * Write a run into the manifest and paint `category_id` from it.
 *
 * Painting `category_id` rather than adding a parallel "predicted" field is
 * deliberate: the viewer colours by `category_id` (`categoryCorrections` only
 * picks an opacity), so anything else arrives invisible and a finished run looks
 * like one that never started. `replaced` keeps the displaced values.
 */
export async function persistRubricPredictions(
  ref: ProjectRef,
  run: Omit<RubricPredictionRun, 'replaced' | 'counts' | 'blocks'>,
): Promise<{ manifestPath: string; applied: number; skippedHandLabelled: number }> {
  const ids = Object.keys(run.predictions);
  if (ids.length === 0) {
    throw new Error('refusing to store 0 predictions — that is a failed run, not a result');
  }
  const illegal = [...new Set(Object.values(run.predictions))].filter(c => !LEGAL.has(c));
  if (illegal.length) {
    throw new Error(`refusing to store predictions with classes outside the contract: ${illegal.join(', ')}`);
  }

  let applied = 0;
  let skippedHandLabelled = 0;

  const result = await modifyManifest(ref.projectId, (manifest) => {
    const blocks = storedBlocks(manifest);
    if (blocks.length === 0) throw new Error('manifest lost its ocrBlocks between read and write');

    const byId = new Map(blocks.map(b => [b.id, b]));
    const unknown = ids.filter(id => !byId.has(id));
    if (unknown.length) {
      throw new Error(
        `${unknown.length} of ${ids.length} predicted block ids are not in this manifest ` +
        `(e.g. ${unknown.slice(0, 3).join(', ')}).\n` +
        `  Block ids are minted per OCR run, so this run was made against a DIFFERENT\n` +
        `  OCR pass than the one stored here. Re-run detect against the current blocks.`);
    }

    const corrections = storedCorrections(manifest);
    const replaced: Record<string, string> = {};
    const counts: Record<string, number> = {};

    for (const [id, cat] of Object.entries(run.predictions)) {
      if (corrections[id] !== undefined) { skippedHandLabelled++; continue; }
      const block = byId.get(id)!;
      if (block.category_id !== cat) replaced[id] = block.category_id;
      block.category_id = cat;
      counts[cat] = (counts[cat] ?? 0) + 1;
      applied++;
    }

    const editor = editorOf(manifest);
    editor['ocrBlocks'] = blocks;
    editor['rubricPredictions'] = {
      ...run, replaced, counts, blocks: applied,
    } satisfies RubricPredictionRun;
    manifest.editor = editor as ProjectManifest['editor'];
  });

  if (!result.success) throw new Error(`failed to write ${ref.manifestPath}: ${result.error}`);
  return {
    manifestPath: result.manifestPath ?? ref.manifestPath,
    applied,
    skippedHandLabelled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface RubricErrorReport {
  model: string;
  promptVersion: number;
  ranAt: string;
  predicted: number;
  unpredicted: number;
  /** Blocks a human corrected AND the model had predicted — the measurable set. */
  judged: number;
  /** Of those, how many the human changed. Every one is a model error. */
  wrong: number;
  /** Corrected to the same class the model chose — an explicit confirmation. */
  confirmed: number;
  /** `predicted -> actual -> n`, most-costly confusions first when flattened. */
  confusion: Array<{ predicted: string; actual: string; n: number }>;
  /** Per predicted class: how often a human overruled it. */
  byPredicted: Array<{ category: string; predicted: number; judged: number; wrong: number }>;
  /** Classes a human assigned that the model never predicted anywhere in the book. */
  neverPredicted: string[];
  /** Pages carrying at least one correction — the review-coverage denominator. */
  pagesWithCorrections: number;
  pagesTotal: number;
}

/**
 * Diff a stored run against the human corrections made since.
 *
 * WHAT THIS CANNOT TELL YOU, stated because the opposite is the tempting reading:
 * a block with no correction is EITHER a block the model got right OR a block
 * nobody looked at. Nothing records which pages were reviewed, so "accuracy" over
 * the whole book is not computable from this data — only the *error* structure is,
 * over the blocks a human actually touched. That structure is the useful part
 * anyway: it says which confusions dominate, which is what picks the next books.
 */
export function buildRubricErrorReport(manifest: ProjectManifest): RubricErrorReport {
  const editor = editorOf(manifest);
  const run = editor['rubricPredictions'] as RubricPredictionRun | undefined;
  if (!run) throw new Error('this project has no stored rubric run — run rubric-detect first');

  const blocks = storedBlocks(manifest);
  const pageOf = new Map(blocks.map(b => [b.id, b.page]));
  const corrections = storedCorrections(manifest);

  const confusion = new Map<string, number>();
  const perPred = new Map<string, { predicted: number; judged: number; wrong: number }>();
  const bump = (c: string) => {
    if (!perPred.has(c)) perPred.set(c, { predicted: 0, judged: 0, wrong: 0 });
    return perPred.get(c)!;
  };
  for (const cat of Object.values(run.predictions)) bump(cat).predicted++;

  let judged = 0, wrong = 0, confirmed = 0;
  const correctedPages = new Set<number>();
  for (const [id, actual] of Object.entries(corrections)) {
    const pg = pageOf.get(id);
    if (pg !== undefined) correctedPages.add(pg);
    const predicted = run.predictions[id];
    if (predicted === undefined) continue;      // model had no opinion; not a measurable error
    judged++;
    bump(predicted).judged++;
    if (predicted === actual) { confirmed++; continue; }
    wrong++;
    bump(predicted).wrong++;
    const key = `${predicted} ${actual}`;
    confusion.set(key, (confusion.get(key) ?? 0) + 1);
  }

  const predictedClasses = new Set(Object.values(run.predictions));
  const neverPredicted = [...new Set(Object.values(corrections))]
    .filter(c => !predictedClasses.has(c))
    .sort();

  return {
    model: run.model,
    promptVersion: run.promptVersion,
    ranAt: run.ranAt,
    predicted: Object.keys(run.predictions).length,
    unpredicted: run.unpredicted.length,
    judged, wrong, confirmed,
    confusion: [...confusion.entries()]
      .map(([k, n]) => { const [predicted, actual] = k.split(' '); return { predicted, actual, n }; })
      .sort((a, b) => b.n - a.n),
    byPredicted: [...perPred.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.wrong - a.wrong || b.predicted - a.predicted),
    neverPredicted,
    pagesWithCorrections: correctedPages.size,
    pagesTotal: new Set(blocks.map(b => b.page)).size,
  };
}
