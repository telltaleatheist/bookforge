/**
 * session-authorship.ts — the book's title / author / year, written INTO the
 * narrator session before any door that builds the session manifest is opened.
 *
 * ── Why this is its own module, and why it runs before ALIGN ────────────────
 *
 * narrator's `session_v1.build_manifest` refuses a session with no author
 * (`bookforge_metadata.author`, else `metadata.creator`): the author is part of
 * the output filename and the m4b's artist tag, and a guess there is a wrong
 * name on a book. Every narrator door that reads the session builds that
 * manifest FIRST — `narrator align` as much as the assembly — so the author has
 * to be in `session-state.json` before either is spawned.
 *
 * It was only ever written before ASSEMBLY (an inline block in
 * `startReassembly`, and the Edit-metadata IPC). The align step, which the
 * narration chain runs BEFORE assembly, dropped the metadata its own queue row
 * carried and spawned narrator against whatever the EPUB said — and a foundry-
 * exported EPUB says nothing: it writes `dc:title` and no `dc:creator`, so prep
 * recorded `creator: null`, align refused on its first line, and the chain
 * reported "the forced alignment did not finish" over a session whose author the
 * app had known all along (Owen, 2026-09-07, Mutineers' Moon: the queue's align
 * row carried author "David Weber"; the session carried `creator: null`).
 *
 * ONE writer now, called by both doors. The mapping is the one assembly used:
 * `metadata.title` / `metadata.creator` / `metadata.published` (the ISO date
 * the year-recovery reads), mirrored into `bookforge_metadata` — narrator's
 * precedence reads `bookforge_metadata` first. Only PROVIDED fields are written;
 * a field the caller does not have leaves the session's own value alone.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SessionAuthorship {
  title?: string;
  author?: string;
  year?: string;
  description?: string;
}

/** The session-state file narrator reads (hyphenated; the underscore twin is the app's). */
export function narratorSessionStatePath(processDir: string): string {
  return path.join(processDir, 'session-state.json');
}

/**
 * Write the provided authorship into the session. Returns what the session now
 * says, or null when there was nothing to write (no session file, or no field
 * provided). Throws on an unreadable or unwritable file — a session that
 * cannot be seeded is a session narrator will refuse by name a moment later,
 * and the refusal should carry THIS reason, not that one.
 */
export function seedSessionAuthorship(
  processDir: string,
  meta: SessionAuthorship,
): { title?: string; creator?: string; year?: string } | null {
  const statePath = narratorSessionStatePath(processDir);
  if (!fs.existsSync(statePath)) return null;
  if (!meta.title && !meta.author && !meta.year && !meta.description) return null;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, any>;
  if (!state.metadata || typeof state.metadata !== 'object') state.metadata = {};
  if (!state.bookforge_metadata || typeof state.bookforge_metadata !== 'object') state.bookforge_metadata = {};
  if (meta.title) {
    state.metadata.title = meta.title;
    state.bookforge_metadata.title = meta.title;
  }
  if (meta.author) {
    state.metadata.creator = meta.author;
    state.bookforge_metadata.author = meta.author;
  }
  if (meta.year) {
    // narrator recovers a year from `published` when nothing names one directly.
    state.metadata.published = `${meta.year}-01-01T00:00:00.000Z`;
    state.bookforge_metadata.year = meta.year;
  }
  if (meta.description) state.metadata.description = meta.description;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  return {
    title: state.metadata.title,
    creator: state.metadata.creator,
    year: state.bookforge_metadata.year,
  };
}
