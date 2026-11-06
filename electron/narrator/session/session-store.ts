/**
 * Read and write `session-state.json`, and answer what is rendered and what is not. A port
 * of narrator's `session_store.py`, which step 8 deleted.
 *
 * `session-state.json` is written once, by prep. A worker's progress is the filesystem,
 * which `N.flac` files exist, never this file.
 *
 * The Python's `E2A_TMP_DIR` refusal and `NARRATOR_SESSIONS_ROOT` lookup do not come across:
 * a sessions root is a parameter here, and nothing in this process reads either variable.
 *
 * The readers are asynchronous because they run in the main process, and a book is up to tens
 * of thousands of stats on a network share: the Python did this in a child for that reason.
 */

import * as fs from 'fs';
import * as path from 'path';

import { renameWithRetry, unlinkWithRetry } from '../../fs-retry';
import { pyJsonDumps, pyRound1 } from '../py-compat';

export const SESSION_STATE_FILENAME = 'session-state.json';
const SENTENCES_SUBPATH = ['chapters', 'sentences'] as const;
/** First hit wins, so a stale `0.wav` beside a good `0.flac` is never consulted. */
const SENTENCE_EXTENSIONS = ['flac', 'wav', 'mp3'] as const;
/** Smaller does not count as rendered, which is what makes a half-written file re-render. */
const MIN_RENDERED_FILE_BYTES = 1024;
const STATE_VERSION = 2;
/** Stats in flight at once on one scan. */
const SCAN_CONCURRENCY = 32;

/** Every key prep writes, in its order. The goldens were produced by that writer. */
export const STATE_KEY_ORDER: readonly string[] = [
  'version', 'session_id', 'epub_path', 'source_epub_path', 'epub_content_hash', 'total_sentences',
  'total_chapters', 'chapters', 'chapter_sentences', 'language', 'language_iso1', 'voice', 'fine_tuned',
  'custom_model', 'custom_model_dir', 'orpheus_model_dir', 'orpheus_adapter_dir', 'orpheus_base_dir',
  'tts_engine', 'device', 'output_format', 'audiobooks_dir', 'created_at', 'updated_at', 'status',
  'metadata', 'session_dir', 'process_dir', 'chapters_dir', 'chapters_dir_sentences', 'epub_path_internal',
  'filename_noext', 'cover', 'final_name', 'chapter_titles', 'chapter_docs', 'chapter_titles_by_doc',
  'bookforge_metadata',
];

export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateError';
  }
}

type State = Record<string, unknown>;

const statOf = async (p: string): Promise<fs.Stats | null> => {
  try { return await fs.promises.stat(p); } catch { return null; }
};
const exists = async (p: string): Promise<boolean> => (await statOf(p)) !== null;
const isDirectory = async (p: string): Promise<boolean> => (await statOf(p))?.isDirectory() === true;

/** The `<hash>` subdirectory holding the state file, first in sorted order, or null. */
export async function findProcessDir(sessionDir: string): Promise<string | null> {
  if (!(await isDirectory(sessionDir))) return null;
  // Code-point order, as Python's sorted() on str, not locale order.
  for (const name of (await fs.promises.readdir(sessionDir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const candidate = path.join(sessionDir, name);
    if (await isDirectory(candidate) && await exists(path.join(candidate, SESSION_STATE_FILENAME))) return candidate;
  }
  return null;
}

/** A state that exists and cannot be parsed refuses: reading it as absent would restart over its audio. */
export async function readStateFile(file: string): Promise<State> {
  let state: unknown;
  try {
    state = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    throw new SessionStateError(`Session state exists at ${file} but could not be read/parsed (${(err as Error).message}). Refusing to treat it as "no session" - that would silently restart over the existing session. Fix or delete the file to proceed.`);
  }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new SessionStateError(`${file} does not contain a JSON object.`);
  }
  return state as State;
}

/** Overwrites the stored dirs with the ones actually walked: stored paths are another machine's. */
export async function loadSessionStateFrom(sessionDir: string): Promise<State | null> {
  const processDir = await findProcessDir(sessionDir);
  if (processDir === null) return null;
  const state = await readStateFile(path.join(processDir, SESSION_STATE_FILENAME));
  state['process_dir'] = processDir;
  state['session_dir'] = sessionDir;
  return state;
}

export async function loadStateFromProcessDir(processDir: string): Promise<State> {
  const file = path.join(processDir, SESSION_STATE_FILENAME);
  if (!(await exists(file))) throw new SessionStateError(`No ${SESSION_STATE_FILENAME} in ${processDir}`);
  const state = await readStateFile(file);
  state['process_dir'] = processDir;
  state['session_dir'] = path.dirname(processDir);
  return state;
}

/** `sessionDir` may be the `ebook-<uuid>` dir or the `<hash>` dir below it. */
export async function resolveProcessDir(sessionDir: string): Promise<string> {
  if (await exists(path.join(sessionDir, SESSION_STATE_FILENAME))) return sessionDir;
  const found = await findProcessDir(sessionDir);
  if (found === null) throw new SessionStateError(`No ${SESSION_STATE_FILENAME} in ${sessionDir} or any of its subdirectories.`);
  return found;
}

export function requireV2(state: State, where: string): void {
  const version = state['version'] ?? null;
  if (version !== STATE_VERSION) throw new SessionStateError(`${where}: session state version is ${String(version)}, expected ${STATE_VERSION}.`);
}

/** A precedence, not a fallback: the stored path may name a machine that is not this one. */
export function sentencesDirFor(state: State, override?: string | null): string {
  if (override) return override;
  const stored = state['chapters_dir_sentences'];
  if (typeof stored === 'string' && stored !== '') return stored;
  return path.join(state['process_dir'] as string, ...SENTENCES_SUBPATH);
}

/** Known keys in prep's order; anything else after, so another writer's fields survive. */
export function orderState(state: State): State {
  const ordered: State = {};
  for (const key of STATE_KEY_ORDER) if (key in state) ordered[key] = state[key];
  for (const [key, value] of Object.entries(state)) if (!(key in ordered)) ordered[key] = value;
  return ordered;
}

/** Atomic: a temp file in the same folder, then a rename. LF, and non-ASCII kept literal. */
export async function saveSessionState(processDir: string, state: State): Promise<string> {
  if (!(await isDirectory(processDir))) throw new SessionStateError(`Not a directory: ${processDir}`);
  const file = path.join(processDir, SESSION_STATE_FILENAME);
  const temp = path.join(processDir, `.session-state-${process.pid}-${Date.now()}.json`);
  try {
    const handle = await fs.promises.open(temp, 'wx');
    try {
      await handle.writeFile(pyJsonDumps(orderState(state)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file);
  } catch (err) {
    if (await exists(temp)) await unlinkWithRetry(temp);
    throw err;
  }
  return file;
}

export interface SentenceScan {
  completed: number[];
  missing: number[];
  completed_count: number;
  missing_count: number;
  progress_percent: number;
}

export async function scanCompletedSentences(sentencesDir: string, totalSentences: number, minFileSize = MIN_RENDERED_FILE_BYTES): Promise<SentenceScan> {
  const rendered = new Array<boolean>(Math.max(totalSentences, 0)).fill(false);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < totalSentences) {
      const i = next;
      next += 1;
      for (const ext of SENTENCE_EXTENSIONS) {
        const stat = await statOf(path.join(sentencesDir, `${i}.${ext}`));
        if (stat !== null && stat.size >= minFileSize) {
          rendered[i] = true;
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  const completed: number[] = [];
  const missing: number[] = [];
  rendered.forEach((done, i) => (done ? completed : missing).push(i));
  return {
    completed,
    missing,
    completed_count: completed.length,
    missing_count: missing.length,
    progress_percent: totalSentences > 0 ? pyRound1((completed.length / totalSentences) * 100) : 0,
  };
}

export function calculateMissingRanges(missingIndices: readonly number[]): Array<{ start: number; end: number; count: number }> {
  if (missingIndices.length === 0) return [];
  const sorted = [...missingIndices].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number; count: number }> = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push({ start, end, count: end - start + 1 });
      start = sorted[i];
      end = sorted[i];
    }
  }
  ranges.push({ start, end, count: end - start + 1 });
  return ranges;
}

/** Every `ebook-*` session under `root` with a missing sentence. Unsorted, as the Python. */
export async function listResumableSessions(root: string): Promise<Array<Record<string, unknown>>> {
  const resumable: Array<Record<string, unknown>> = [];
  if (!(await exists(root))) return resumable;
  for (const name of await fs.promises.readdir(root)) {
    if (!name.startsWith('ebook-')) continue;
    const sessionDir = path.join(root, name);
    if (!(await isDirectory(sessionDir))) continue;
    const state = await loadSessionStateFrom(sessionDir);
    if (state === null) continue;
    const sentencesDir = path.join(state['process_dir'] as string, ...SENTENCES_SUBPATH);
    if (!(await exists(sentencesDir))) continue;
    const scan = await scanCompletedSentences(sentencesDir, state['total_sentences'] as number);
    if (scan.missing_count > 0) {
      const metadata = (state['metadata'] ?? {}) as State;
      resumable.push({
        session_id: state['session_id'],
        session_dir: sessionDir,
        title: 'title' in metadata ? metadata['title'] : 'Unknown',
        total_sentences: state['total_sentences'],
        completed_sentences: scan.completed_count,
        missing_sentences: scan.missing_count,
        progress_percent: scan.progress_percent,
        created_at: state['created_at'] ?? null,
        language: state['language'] ?? null,
        voice: state['voice'] ?? null,
      });
    }
  }
  return resumable;
}

/** Always compatible; only warns. */
export function checkResumeCompatibility(state: State, voice?: string | null, ttsEngine?: string | null): { compatible: true; warnings: string[] } {
  const warnings: string[] = [];
  const savedVoice = state['voice'];
  if (savedVoice && voice && savedVoice !== voice) warnings.push(`Voice changed from '${String(savedVoice)}' to '${voice}'`);
  const savedEngine = state['tts_engine'];
  if (savedEngine && ttsEngine && savedEngine !== ttsEngine) warnings.push(`TTS engine changed from '${String(savedEngine)}' to '${ttsEngine}'`);
  return { compatible: true, warnings };
}

/** How far a session got. Every key is read by `checkResumeStatus`, so none may be renamed. */
export async function resumeSession(sessionPath: string, root: string | null, voice?: string | null, ttsEngine?: string | null): Promise<Record<string, unknown>> {
  if (!sessionPath) return { success: false, error: 'No session path provided' };
  let sessionDir = sessionPath;
  if (!path.isAbsolute(sessionPath)) {
    if (root === null) throw new SessionStateError('A session id needs a sessions root to resolve under, and none was given.');
    sessionDir = path.join(root, sessionPath.startsWith('ebook-') ? sessionPath : `ebook-${sessionPath}`);
  }
  if (!(await exists(sessionDir))) return { success: false, error: `Session directory not found: ${sessionDir}` };
  const state = await loadSessionStateFrom(sessionDir);
  if (state === null) return { success: false, error: 'No session-state.json found' };

  const compat = checkResumeCompatibility(state, voice, ttsEngine);
  for (const warning of compat.warnings) console.log(`Warning: ${warning}`);

  const sentencesDir = path.join(state['process_dir'] as string, ...SENTENCES_SUBPATH);
  if (!(await exists(sentencesDir))) return { success: false, error: `Sentences directory not found: ${sentencesDir}` };
  const scan = await scanCompletedSentences(sentencesDir, state['total_sentences'] as number);
  if (scan.missing_count === 0) {
    return {
      success: true,
      complete: true,
      message: 'All sentences already complete - ready for assembly',
      session_id: state['session_id'],
      session_dir: sessionDir,
      process_dir: state['process_dir'],
    };
  }
  return {
    success: true,
    complete: false,
    session_id: state['session_id'],
    session_dir: sessionDir,
    process_dir: state['process_dir'],
    chapters_dir: path.join(state['process_dir'] as string, 'chapters'),
    chapters_dir_sentences: sentencesDir,
    total_sentences: state['total_sentences'],
    total_chapters: state['total_chapters'],
    completed_sentences: scan.completed_count,
    missing_sentences: scan.missing_count,
    missing_indices: scan.missing,
    missing_ranges: calculateMissingRanges(scan.missing),
    progress_percent: scan.progress_percent,
    chapters: state['chapters'] ?? [],
    metadata: state['metadata'] ?? {},
    warnings: compat.warnings,
  };
}
