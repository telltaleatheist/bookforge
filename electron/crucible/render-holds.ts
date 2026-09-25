/**
 * A RENDER'S FILES, KEPT ON THE SERVER FOR THE ALIGN — Crucible 1.0.38.
 *
 * Owen, 2026-09-25: *"keep all working files on the crucible side until the
 * chain is complete. then remove them."*
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The render writes every chunk's FLAC on the server and this side downloads
 * all of them. The align then needs the same FLACs on the same server, and
 * uploaded all 2,510 of Shift's back again: 2.5 minutes of a silent row, and
 * ~1.25 GB up to the machine that had just made them (server timeline,
 * 2026-09-25). A Crucible job's input may NAME an earlier job's artifact
 * (`{artifact: {job_id, name}}`), which is hard-linked into the new job and
 * never crosses the wire.
 *
 * ── THE THREE PARTS, AND WHO OWNS EACH ─────────────────────────────────────
 *
 * 1. HOLD. The server reaps a job once every artifact has been fetched — which
 *    the render does as each chunk lands — so the render asks for a hold the
 *    moment the job exists (`holdRenderAtSubmit`), before its first download.
 * 2. RECORD. `<processDir>/crucible-renders/<jobId>.json` says which server and
 *    job made each chunk, and the SIZE of the FLAC that landed. The record is
 *    the hold's owner on this side: it travels with the session to the project
 *    share (the publish copies the whole tree, add-never-remove), and a resume
 *    that renders the missing chunks writes a second record beside the first.
 * 3. RELEASE. The align is the last consumer of the render's audio, so a
 *    finished align releases every hold its session records and removes the
 *    records (`releaseRenderHolds`). The server's own collector takes any hold
 *    nothing released at seven days — the reconciler for a record that was lost.
 *
 * ── A REFERENCE IS USED ONLY WHERE IT IS PROVABLY THE SAME BYTES ───────────
 *
 * A chunk is sent by name only when (a) its record names THIS server, (b) the
 * FLAC on disk is the size the render landed — a step that rewrote it (an RVC
 * pass, a denoise, a re-render) changed it, and the server's copy is then the
 * wrong audio — and (c) the server answers a hold on that job RIGHT NOW with the
 * chunk in its artifact list. Anything else is uploaded exactly as before. That
 * is not a fallback: uploading is the one correct way to give a server bytes it
 * does not have, and a server older than 1.0.38 has no hold at all.
 */

import * as fs from 'fs';
import * as path from 'path';

import { CrucibleRefused, type CrucibleClient } from '@crucible/client';

import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';

/** Where a session keeps its render-hold records. */
export const RENDER_HOLDS_DIR = 'crucible-renders';

export interface RenderHoldRecord {
  readonly server: string;
  readonly jobId: string;
  /** When this side wrote it (ISO-8601): the newer record wins a tie on size. */
  readonly recordedAt: string;
  /** Chunk index → byte size of the `<index>.flac` this job landed. */
  readonly chunks: Readonly<Record<string, number>>;
}

/** `<processDir>` for a render's `<processDir>/chapters/sentences`. */
export function processDirOfSentencesDir(sentencesDir: string): string {
  return path.resolve(sentencesDir, '..', '..');
}

function recordPath(processDir: string, jobId: string): string {
  return path.join(processDir, RENDER_HOLDS_DIR, `${jobId}.json`);
}

/**
 * Write (or extend) this job's record. An attach to the same job adds to the
 * chunks already recorded rather than replacing them.
 */
export function writeRenderHoldRecord(
  processDir: string,
  server: string,
  jobId: string,
  chunks: Readonly<Record<string, number>>,
): void {
  const file = recordPath(processDir, jobId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let earlier: Record<string, number> = {};
  if (fs.existsSync(file)) {
    const prior = JSON.parse(fs.readFileSync(file, 'utf-8')) as RenderHoldRecord;
    earlier = { ...prior.chunks };
  }
  const record: RenderHoldRecord = {
    server, jobId, recordedAt: new Date().toISOString(), chunks: { ...earlier, ...chunks },
  };
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf-8');
  fs.renameSync(tmp, file);
}

/** Every record this session holds, oldest first. */
export function readRenderHoldRecords(processDir: string): RenderHoldRecord[] {
  const dir = path.join(processDir, RENDER_HOLDS_DIR);
  if (!fs.existsSync(dir)) return [];
  const records: RenderHoldRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as RenderHoldRecord;
    if (typeof parsed.server !== 'string' || typeof parsed.jobId !== 'string'
      || typeof parsed.chunks !== 'object' || parsed.chunks === null) {
      throw new Error(`${path.join(dir, name)} is not a render-hold record (server, jobId, chunks)`);
    }
    records.push(parsed);
  }
  return records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/**
 * Ask the server to keep this render's files, the moment the job exists.
 * Returns whether it will. A server that cannot (older than 1.0.38, or any
 * refusal) is said once in the log and the render goes on: nothing depends on
 * the hold but the align's upload, which then happens as it always did.
 */
export async function holdRenderAtSubmit(
  client: CrucibleClient,
  server: string,
  jobId: string,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const hold = await client.holdArtifacts(jobId);
    log(`crucible "${server}" holds render ${jobId}'s files for the align (${hold.status})`);
    return true;
  } catch (err) {
    log(`crucible "${server}" will not hold render ${jobId}'s files, so the align will upload `
      + `them: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** A chunk the align will send, as `sessionAlignChunks` found it on disk. */
export interface AlignChunkOnDisk {
  readonly index: number;
  readonly audioPath: string;
  readonly size: number;
}

export interface AlignInputPlan {
  /** `<index>.flac` → the local path to upload, or the render's artifact. */
  readonly inputs: Record<string, string | { readonly artifact: { readonly jobId: string; readonly name: string } }>;
  /** How many chunks go by name. */
  readonly referenced: number;
  /** How many go up as bytes. */
  readonly uploaded: number;
}

/** Every chunk as a path: what the align sends when the server holds none of them. */
export function uploadEveryChunk(chunks: readonly AlignChunkOnDisk[]): AlignInputPlan {
  const inputs: AlignInputPlan['inputs'] = {};
  for (const c of chunks) inputs[`${c.index}.flac`] = c.audioPath;
  return { inputs, referenced: 0, uploaded: chunks.length };
}

/**
 * Which chunks this server already holds, byte for byte, and which go up.
 * The hold asked here is also the liveness check: it answers with the job's
 * artifacts as they are NOW.
 */
export async function planAlignInputs(
  client: CrucibleClient,
  server: string,
  processDir: string,
  chunks: readonly AlignChunkOnDisk[],
  log: (line: string) => void,
): Promise<AlignInputPlan> {
  const records = readRenderHoldRecords(processDir).filter((r) => r.server === server);
  if (records.length === 0) return uploadEveryChunk(chunks);

  // Newest record first, so a chunk re-rendered by a resume is cited from the
  // job that made the bytes now on disk.
  const newestFirst = [...records].reverse();
  const live = new Map<string, Set<string>>();
  for (const r of newestFirst) {
    try {
      const hold = await client.holdArtifacts(r.jobId);
      live.set(r.jobId, new Set(hold.artifacts));
    } catch (err) {
      log(`crucible "${server}" no longer holds render ${r.jobId}; its chunks go up as files `
        + `(${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const inputs: AlignInputPlan['inputs'] = {};
  let referenced = 0;
  for (const c of chunks) {
    const name = `${c.index}.flac`;
    const from = newestFirst.find((r) => r.chunks[String(c.index)] === c.size && live.get(r.jobId)?.has(name));
    if (from === undefined) {
      inputs[name] = c.audioPath;
    } else {
      inputs[name] = { artifact: { jobId: from.jobId, name } };
      referenced += 1;
    }
  }
  log(`${referenced} of ${chunks.length} chunk(s) are already on crucible "${server}" from the render; `
    + `${chunks.length - referenced} go up as files`);
  return { inputs, referenced, uploaded: chunks.length - referenced };
}

/**
 * The chain is done with the render's files: release every hold this session
 * records, on whichever server made it, and remove each record whose release
 * was answered. A release that fails is weather — the record stays for the
 * next align to release, and the server collects the job at seven days anyway.
 */
export async function releaseRenderHolds(
  processDir: string,
  log: (line: string) => void,
): Promise<void> {
  for (const r of readRenderHoldRecords(processDir)) {
    try {
      const client = await crucibleClientFor(r.server, CRUCIBLE_CLIENT_NAME);
      await client.releaseArtifacts(r.jobId);
      fs.rmSync(recordPath(processDir, r.jobId), { force: true });
      log(`released render ${r.jobId}'s files on crucible "${r.server}"`);
    } catch (err) {
      // A job the server no longer has (collected, or a server rebuilt) has
      // nothing left to release: the record's work is done.
      if (err instanceof CrucibleRefused && err.status === 404) {
        fs.rmSync(recordPath(processDir, r.jobId), { force: true });
        log(`render ${r.jobId} is already gone from crucible "${r.server}" (${err.code})`);
        continue;
      }
      log(`could not release render ${r.jobId}'s files on crucible "${r.server}"; the record is kept `
        + `and the server collects them at its retention window: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
