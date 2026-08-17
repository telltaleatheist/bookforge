/**
 * recents — the documents Home offers you back.
 *
 * In the APP's own userData (`<userData>/recents.json`), never in the engine's
 * `settings.json`. That file's schema belongs to foundry (src/backend/settings.ts)
 * and electron/settings.ts goes to some trouble to preserve keys it does not
 * recognise; adding a UI list to it would make the app a writer of a schema it
 * does not own, and would put a hundred-line array in front of the three fields
 * an operator opens that file to check.
 *
 * The list is a CACHE OF NAMES, not a store. Nothing here holds the only copy of
 * anything: an entry whose file has since been deleted is shown as missing and
 * can be dismissed, because a recents list that silently drops rows leaves a
 * person hunting for a book that "was there yesterday".
 */
import { promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';

import { readJson } from '../shared/json';
import type { RecentDocument, RecentKind } from '../shared/types';

/** How many are kept. Home shows a column of them; past twenty it is an archive. */
const LIMIT = 20;

function recentsFile(): string {
  return path.join(app.getPath('userData'), 'recents.json');
}

let cache: RecentDocument[] | null = null;

/**
 * Read the file once per launch and hold it.
 *
 * SYNCHRONOUS, and only here: this is called from the first `recents:list`,
 * which the Home screen awaits before it can paint. An unreadable or malformed
 * file starts an empty list rather than throwing — a recents list is a
 * convenience, and an app that will not open because a convenience file has a
 * stray comma in it is a worse app.
 */
function load(): RecentDocument[] {
  if (cache !== null) return cache;
  try {
    const parsed: unknown = readJson(readFileSync(recentsFile(), 'utf8'));
    cache = Array.isArray(parsed) ? parsed.filter(isRecent) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function isRecent(value: unknown): value is RecentDocument {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row['path'] === 'string'
    && (row['kind'] === 'pdf' || row['kind'] === 'epub')
    && typeof row['title'] === 'string'
    && typeof row['openedAt'] === 'number'
    && typeof row['managed'] === 'boolean';
}

function persist(items: RecentDocument[]): void {
  const file = recentsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

/**
 * The list, newest first, each row saying whether its file is still there.
 *
 * `missing` is measured on every read rather than recorded: a book on a drive
 * that is not plugged in right now is missing this minute and present the next,
 * and a flag written into the file would be wrong in both directions.
 */
export async function listRecents(): Promise<RecentDocument[]> {
  const items = load();
  return Promise.all(items.map(async (item) => {
    try {
      await fsp.access(item.path);
      return { ...item, missing: false };
    } catch {
      return { ...item, missing: true };
    }
  }));
}

/**
 * Record an open. Same path twice is one row, moved to the front with a new time.
 *
 * `managed` distinguishes a book still living in the workspace from one the user
 * has a copy of somewhere they chose. Home says so, because "open" means
 * something different for the two: one is a file you can hand to a Kindle, and
 * one is a file that exists only because this app has not been asked to throw it
 * away yet.
 */
export function rememberRecent(
  filePath: string,
  kind: RecentKind,
  title: string,
  managed: boolean,
): RecentDocument[] {
  const resolved = path.resolve(filePath);
  const items = load().filter((item) => !samePath(item.path, resolved));
  items.unshift({ path: resolved, kind, title, openedAt: Date.now(), managed });
  cache = items.slice(0, LIMIT);
  persist(cache);
  return cache;
}

/**
 * When this exact file was last opened, or null if it never was.
 *
 * For the PROJECT list, which sorts by "last touched" and has no clock of its
 * own: a project's folder mtime moves for reasons nobody did on purpose (an
 * output rotated, a manifest rewritten), and `createdAt` never moves at all.
 * SYNCHRONOUS and off the in-memory cache — this is called once per document in
 * a listing that Home awaits, and a stat per row would be a stat per row.
 */
export function openedAtFor(filePath: string): number | null {
  const resolved = path.resolve(filePath);
  return load().find((item) => samePath(item.path, resolved))?.openedAt ?? null;
}

export function forgetRecent(filePath: string): RecentDocument[] {
  const resolved = path.resolve(filePath);
  cache = load().filter((item) => !samePath(item.path, resolved));
  persist(cache);
  return cache;
}

/**
 * Forget every row that points anywhere inside `dir`.
 *
 * The one caller is a project being DELETED (electron/ipc.ts, `projects:delete`),
 * and it exists because this list is keyed by FILE and a project is a folder full
 * of them: the scan in `working/`, the cast book in `generated/`, whatever was
 * filed into `final/`. Forgetting them one at a time would mean main enumerating
 * a directory it has just erased.
 *
 * Leaving them would not merely be untidy. `openedAtFor` reads this list to date
 * the project rows Home sorts by, and the app would go on offering — and would
 * keep a last-opened time for — a book whose bytes it destroyed a second ago. A
 * missing row here costs nothing: this was never a store, and the file it named
 * is gone for a reason the user chose.
 *
 * PREFIX MATCH on the folded path, with the separator appended, so
 * `…/projects/Kershaw-a1b2c3d4` cannot swallow `…/projects/Kershaw-a1b2c3d4-notes`
 * — a sibling project whose key happens to start with this one's.
 */
export function forgetRecentsUnder(dir: string): RecentDocument[] {
  const root = `${fold(path.resolve(dir))}/`;
  cache = load().filter((item) => !fold(item.path).startsWith(root));
  persist(cache);
  return cache;
}

export function clearRecents(): RecentDocument[] {
  cache = [];
  persist(cache);
  return cache;
}

/**
 * Windows paths differ by case and by separator and are the same file.
 *
 * Case-folded EVERYWHERE, including on Linux where it is wrong in principle: a
 * recents list that shows one book twice is a worse outcome than one that
 * refuses to show two books whose names differ only in case, and nobody has the
 * second pair.
 */
function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** One spelling of a path, for comparing two of them. See `samePath`. */
function fold(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}
