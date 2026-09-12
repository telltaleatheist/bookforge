/**
 * WHERE THE THREE PARTS OF A CACHED SESSION ARE — said once, by a function.
 *
 * e2a writes a session as `ebook-<uuid>/` and, depending on its version and the
 * engine, either puts the render directly under it or one hash level down:
 *
 *   ebook-<uuid>/chapters/sentences            ← flat
 *   ebook-<uuid>/<content hash>/chapters/sentences  ← hashed (the ordinary shape)
 *
 * Three names come out of that and the queue's session-consuming steps want all
 * three: the `sessionDir` (the `ebook-` folder), the `processDir` (whatever holds
 * `chapters/` and `session-state.json` — what every bridge argument calls
 * processDir), and the `sentencesDir`.
 *
 * `cacheSessionToProject` used to work the shape out TWICE, in two near-identical
 * twenty-line blocks, and both of them answered only `sentencesDir` — which is
 * why `tts-conversion`'s artifact could name the sentences and not the session
 * that holds them, and why the assembly chained behind it on 2026-09-12 had to go
 * looking for a project to ask (see `projectDirForStep`). The probe is stated
 * here so that a caller can hand a step all three without deriving any of them by
 * string surgery on the others.
 *
 * The probe is on `chapters/sentences` and NOT on `session-state.json`,
 * deliberately: it is the same question the two blocks it replaces asked, so a
 * cache published by an older build answers it exactly as it did before.
 * `assertPublishableSession` is what refuses a session with no text, on the way
 * in, where the refusal can still save something.
 */
import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';

export interface CachedSessionLayout {
  /** The `ebook-<uuid>` directory itself. */
  readonly sessionDir: string;
  /** The directory holding `chapters/` — every bridge's `processDir`. */
  readonly processDir: string;
  /** `<processDir>/chapters/sentences`, verified to exist. */
  readonly sentencesDir: string;
}

async function sentencesUnder(processDir: string): Promise<string | null> {
  const candidate = path.join(processDir, 'chapters', 'sentences');
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * The layout of the session at `sessionDir`, or `null` when there is no
 * `chapters/sentences` under it or one level down — which is what "this is not a
 * cached session" looks like, and is never an error here: the two callers each
 * have their own thing to say about it.
 */
export async function findCachedSessionLayout(
  sessionDir: string,
): Promise<CachedSessionLayout | null> {
  const flat = await sentencesUnder(sessionDir);
  if (flat) return { sessionDir, processDir: sessionDir, sentencesDir: flat };

  let entries: Dirent[];
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const processDir = path.join(sessionDir, entry.name);
    const sentencesDir = await sentencesUnder(processDir);
    if (sentencesDir) return { sessionDir, processDir, sentencesDir };
  }
  return null;
}
