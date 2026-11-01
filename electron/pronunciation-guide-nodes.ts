/**
 * EVERY PRONUNCIATION GUIDE ON DISK, AS A MINI ROW ON FOUNDRY'S TREE (Owen,
 * 2026-11-01: *"we can view the guide by having a miniature line item in the work
 * tree maybe"*), hung under the step it was built from.
 *
 * The queue's own guide row only lives while the guide's run is in the queue; once
 * the run was cleared the guide vanished from the tree, and a guide a cleanup built
 * inside itself was never on it. So the rows are read from the guide files
 * (`readings/<key>.<step>.narration-glossary.json`) instead, and merged into every
 * push (`setDiskGuideNodes`, foundry-host-nodes.ts). A guide whose step is no longer
 * in the book's ledger draws nothing: a row needs a parent to hang from.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HostNode } from './foundry-host-nodes';
import { readGlossary, type GlossaryEntry } from './narration-glossary';
import { appliedStepOf, ledgerStepsOf } from './pronunciation-applied';
import { GUIDE_OPERATION_ID } from './pronunciation-offer';

/** The node id of a step's guide row: not a queue row of ours (`decodeNodeId` reads it as none). */
export const GUIDE_NODE_PREFIX = 'bf-guide';

export function guideNodeId(step: string): string {
  return `${GUIDE_NODE_PREFIX}:${step}`;
}

/** The step a guide row's id names, or null when the id is not a guide row's. */
export function stepOfGuideNode(nodeId: string): string | null {
  return nodeId.startsWith(`${GUIDE_NODE_PREFIX}:`) ? nodeId.slice(GUIDE_NODE_PREFIX.length + 1) : null;
}

/** Below this the guide's placing of a spot is unsure — the review window's own line. */
const UNSURE = 0.6;

/**
 * DOES A WORD NEED A LOOK — the review window's rule (pronunciation-review.component.ts
 * `needsLook`) on the stored entry: a word the guide reads differently with a place
 * left to the cleanup, or any place it was unsure of.
 */
export function entryNeedsLook(entry: GlossaryEntry): boolean {
  if (entry.decision === 'as-printed' && entry.senses.length === 0) return false;
  const reads = entry.decision === 'reading';
  return entry.occurrences.some((o) => {
    const toCleaner = o.sense === null || entry.senses[o.sense]?.problem !== undefined;
    const unsure = o.sense !== null && o.p !== null && o.p < UNSURE;
    return (reads && toCleaner) || unsure;
  });
}

/** One project's guide rows. */
export async function guideNodesOf(projectDir: string): Promise<HostNode[]> {
  const readings = path.join(projectDir, 'readings');
  const manifest = path.join(projectDir, 'project.json');
  if (!fs.existsSync(readings) || !fs.existsSync(manifest)) return [];
  const key = (JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, '')) as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${manifest} names no project key, so its pronunciation guides cannot be told apart.`);
  }
  const ledger = new Set(ledgerStepsOf(projectDir).map((s) => s.id));
  const prefix = `${key}.`;
  const suffix = '.narration-glossary.json';
  const nodes: HostNode[] = [];
  for (const name of await fs.promises.readdir(readings)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const step = name.slice(prefix.length, -suffix.length);
    if (step.length === 0 || step.includes('.') || !ledger.has(step)) continue;
    const glossary = readGlossary(path.join(readings, name), key);
    const words = glossary.entries.length;
    const needs = glossary.entries.filter(entryNeedsLook).length;
    const applied = appliedStepOf(projectDir, step);
    nodes.push({
      id: guideNodeId(step),
      parentStepId: step,
      title: `Pronunciation guide · ${words} ${words === 1 ? 'word' : 'words'}${needs > 0 ? ` · ${needs} need a look` : ''}`,
      detail: applied === null ? 'Not applied to the text yet' : `Applied as “${applied.label}”`,
      kind: 'guide',
      state: 'done',
      // A click opens the guide window (main.ts's bookforge.guide reads the step out of this row's id).
      opens: GUIDE_OPERATION_ID,
    });
  }
  return nodes;
}
