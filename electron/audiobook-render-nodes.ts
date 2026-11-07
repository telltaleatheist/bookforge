/**
 * EVERY FINISHED AUDIOBOOK, AS A ROW ON FOUNDRY'S TREE, under the node it was rendered
 * from (Owen, 2026-11-07: *"add the rendered book as a line item in the worktree on
 * foundry/bookforge, so the user can see that an audiobook was rendered from a
 * specific item. we dont need to be able to do anything with it from bookforge's
 * foundry window, necessarily, but it should probably be listed"*).
 *
 * ── Why a record, and where it lives ────────────────────────────────────────
 *
 * A run's rows are drawn from the queue (foundry-host-nodes.ts) and leave with it, so
 * once the run is cleared nothing said an audiobook had been made there. The parent is
 * known only while the run exists: the press stamps the node it was made on onto the
 * run's audio steps (`treeParent`, shared/queue/narration-run.ts). So when the assembly
 * finishes, that node and the file are written down here, in the Foundry project, beside
 * the pronunciation guides: `readings/<key>.audiobooks.json`. Foundry's own project.json
 * never records one of our rows.
 *
 * ONE ROW PER NODE: the record is keyed by the node, so a re-render of the same item
 * replaces its row. A record whose m4b is no longer on disk draws nothing, and neither
 * does one whose node the tree no longer has (Foundry hangs a row nowhere then).
 *
 * A RENDER WITH NO RECORDED PARENT GETS NO ROW. Every audiobook assembled before this
 * existed, and every run started from BookForge's own pages, carries no `treeParent`;
 * which item such a file was made from is not written anywhere, and a guess by file
 * name is exactly the attachment Owen's identity law refuses.
 *
 * The m4b is recorded LIBRARY-RELATIVE, so the row survives the library root moving.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { HostNode } from './foundry-host-nodes';
import { renameWithRetry } from './fs-retry';

export const AUDIOBOOK_RECORD_FORMAT = 'bookforge-audiobooks/v1';

/** The node id of an audiobook's row: not a queue row of ours (`decodeNodeId` reads it as none). */
export const AUDIOBOOK_NODE_PREFIX = 'bf-audiobook';

export interface AudiobookRender {
  /** The m4b, relative to the library root, forward slashes. */
  m4b: string;
  /** The voice it was read in, as the run named it, or null when the run named none. */
  voice: string | null;
  /** When the assembly finished (ISO). */
  finishedAt: string;
  /** The queue run and step that made it. */
  jobId: string;
  stepId: string;
}

interface AudiobookRecordFile {
  format: typeof AUDIOBOOK_RECORD_FORMAT;
  /** Node id (a ledger step, or `export:<file>`) → the audiobook last rendered from it. */
  renders: Record<string, AudiobookRender>;
}

/** The record's path in one Foundry project, keyed like its guides. */
export function audiobookRecordPath(projectDir: string): string {
  const manifest = path.join(projectDir, 'project.json');
  const key = (JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, '')) as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`${manifest} names no project key, so its audiobook record cannot be named.`);
  }
  return path.join(projectDir, 'readings', `${key}.audiobooks.json`);
}

function readRecord(file: string): AudiobookRecordFile {
  if (!fs.existsSync(file)) return { format: AUDIOBOOK_RECORD_FORMAT, renders: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AudiobookRecordFile>;
  if (parsed.format !== AUDIOBOOK_RECORD_FORMAT || typeof parsed.renders !== 'object' || parsed.renders === null) {
    throw new Error(`${file} is not a ${AUDIOBOOK_RECORD_FORMAT} record.`);
  }
  return parsed as AudiobookRecordFile;
}

/** Writes per project, one after another: two assemblies of one book may finish together. */
const writing = new Map<string, Promise<void>>();

/**
 * Write down one finished audiobook under the node it was rendered from, replacing the
 * one rendered there before. `m4bAbsPath` must be inside `libraryRoot`: a file outside
 * the library has no spelling that survives the library moving, and is refused by name.
 */
export function recordAudiobookRender(
  projectDir: string,
  parentStepId: string,
  m4bAbsPath: string,
  libraryRoot: string,
  render: Omit<AudiobookRender, 'm4b'>,
): Promise<void> {
  const rel = path.relative(path.resolve(libraryRoot), path.resolve(m4bAbsPath));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return Promise.reject(new Error(
      `The audiobook ${m4bAbsPath} is not inside the library (${libraryRoot}), so its row on the tree `
      + 'could not be written down.'));
  }
  const prior = writing.get(projectDir) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(async () => {
    const file = audiobookRecordPath(projectDir);
    const record = readRecord(file);
    record.renders[parentStepId] = { m4b: rel.split(path.sep).join('/'), ...render };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const partial = `${file}.partial`;
    fs.writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await renameWithRetry(partial, file);
  });
  writing.set(projectDir, next);
  return next;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "7 Nov 2026", in this machine's time. */
export function renderDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`An audiobook record's finishedAt is not a date: ${iso}`);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** One project's audiobook rows: one per node, for the files still on disk. */
export function audiobookNodesOf(projectDir: string, libraryRoot: string): HostNode[] {
  if (!fs.existsSync(path.join(projectDir, 'project.json'))) return [];
  const record = readRecord(audiobookRecordPath(projectDir));
  const nodes: HostNode[] = [];
  for (const [parentStepId, render] of Object.entries(record.renders)) {
    const file = path.join(libraryRoot, ...render.m4b.split('/'));
    if (!fs.existsSync(file)) continue;
    nodes.push({
      id: `${AUDIOBOOK_NODE_PREFIX}:${parentStepId}`,
      parentStepId,
      title: render.voice === null ? 'Audiobook' : `Audiobook · ${render.voice}`,
      detail: `finished · ${path.basename(file)} · ${renderDate(render.finishedAt)}`,
      kind: 'narrate',
      state: 'done',
    });
  }
  return nodes;
}
