/**
 * editor-state-store — the picker's working state, in its own file, with ONE
 * owner.
 *
 * ── Why it is not in the manifest any more ──────────────────────────────────
 *
 * `manifest.editor` holds document-scale working data: undo and redo stacks,
 * every OCR block of a scanned book, hand labels keyed by block id, crop
 * rectangles, text corrections. Measured across the live library on 2026-08-10
 * it was 146.6 MB of 148 MB of all manifest content — one project's manifest
 * alone was 26 MB — and `listProjects` reads and JSON-parses EVERY manifest on
 * every Studio load, every navigation and after every change broadcast. So the
 * catalog paid the price of the editor's scratch on every screen, and every
 * picker autosave rewrote (and re-synced, the library being a Syncthing volume)
 * megabytes to record a single hand label.
 *
 * The manifest is the CATALOG: what the project is, what it was made from, what
 * it has produced. Editor state is what one tool is doing to one document, so it
 * lives beside the manifest in `editor-state.json` and is read only by the code
 * that actually edits.
 *
 * ── Written compact, on purpose ─────────────────────────────────────────────
 *
 * No pretty-printing. Nothing reads this file by eye — it is block geometry and
 * id-keyed maps — and the indentation of a 20 MB OCR block list is megabytes of
 * spaces that get written and synced every save.
 *
 * ── The precedence rule, and why a crash cannot break it ────────────────────
 *
 * Two copies can exist while a library is being migrated, and there is exactly
 * one rule about which is real:
 *
 *   If manifest.json still carries `editor`, THAT copy is authoritative and is
 *   (re-)migrated the next time anything touches the project. Once the manifest
 *   lacks the key, the sidecar is the sole authority.
 *
 * They are NEVER merged. `migrateEditorState` writes the sidecar FIRST and only
 * then rewrites the manifest without the key, so the two states a crash can
 * leave behind are both correct under that rule: manifest-key-still-present
 * (whatever the sidecar holds is ignored and overwritten on the next contact) or
 * manifest-key-gone (the sidecar it was written from is complete, because it
 * landed before the manifest was rewritten).
 *
 * ── What this module refuses to do ──────────────────────────────────────────
 *
 * It never invents state. A project with neither file has `null` editor state —
 * that is a real answer, a project nobody has edited, not a missing value. A
 * malformed manifest or a malformed sidecar THROWS, per project, and is left
 * exactly as it is: no reader here is entitled to guess what a half-written
 * 20 MB JSON file was going to say.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ManifestEditorState } from './manifest-types.js';
import { atomicWriteFile } from './manifest-service.js';

/** The sidecar's name, beside manifest.json in the project directory. */
export const EDITOR_STATE_FILENAME = 'editor-state.json';

const MANIFEST_FILENAME = 'manifest.json';

/** Where a project's editor state lives. */
export function editorStatePath(projectDir: string): string {
  return path.join(projectDir, EDITOR_STATE_FILENAME);
}

function manifestPathOf(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILENAME);
}

/** Whether an editor-state object holds anything at all. */
function isNonEmpty(state: unknown): boolean {
  return state !== null && typeof state === 'object' && Object.keys(state as object).length > 0;
}

/**
 * The sidecar's contents, or null when the project has none.
 *
 * Does NOT consult the manifest — this is the raw file, and the precedence rule
 * is applied by the callers below that own it.
 */
function readSidecar(projectDir: string): ManifestEditorState | null {
  const file = editorStatePath(projectDir);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  // A parse failure is reported with the file's name: it is the whole of one
  // project's editing work, and silently reading it as "no state" would look
  // exactly like a reset nobody asked for.
  try {
    return JSON.parse(content) as ManifestEditorState;
  } catch (err) {
    throw new Error(
      `${file} is not readable as JSON (${(err as Error).message}), so this project's editor `
      + 'state cannot be read. It has NOT been changed.'
    );
  }
}

/**
 * Move a project's editor state out of manifest.json and into the sidecar.
 *
 * Returns whether there was anything to move. Idempotent: a project whose
 * manifest has no `editor` key is read once and left alone, which is what makes
 * it safe to call on contact from every reader.
 *
 * ── Raw read, raw atomic write ──────────────────────────────────────────────
 *
 * Deliberately not the typed manifest round-trip, for the reason
 * `resetEditorRecords` gives: the typed shape would normalize paths and drop the
 * untyped sub-fields under `editor` that neither manifest declaration admits —
 * which is most of what is being moved. A malformed manifest throws out of the
 * JSON.parse and is never overwritten with a guessed structure.
 */
export async function migrateEditorState(projectDir: string): Promise<boolean> {
  const manifestPath = manifestPathOf(projectDir);
  let content: string;
  try {
    content = await fs.promises.readFile(manifestPath, 'utf-8');
  } catch (err) {
    // No manifest is no project. Nothing to migrate, and nothing to complain
    // about — callers reach here for directories that are not projects.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }

  const manifest = JSON.parse(content) as Record<string, unknown>;
  if (!('editor' in manifest)) return false;

  const editor = manifest.editor as ManifestEditorState;
  // Sidecar FIRST. See the precedence rule at the top of this file: the manifest
  // key is what says "the sidecar is not authoritative yet", so it may only be
  // removed once the sidecar it names is on disk.
  await writeEditorState(projectDir, editor ?? {});

  delete manifest.editor;
  // `modifiedAt` is NOT touched. Moving a file's contents is not an edit to the
  // project, and Studio sorts the shelf by that timestamp — stamping it here
  // would reorder a 378-book library into sweep order on one launch.
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2));
  return true;
}

/**
 * A project's editor state, or null when it has none.
 *
 * Migrates on contact, so a caller never has to know which of the two locations
 * a project is in — and so the library converts itself as it is used, rather
 * than only when the startup sweep gets to it.
 */
export async function readEditorState(projectDir: string): Promise<ManifestEditorState | null> {
  await migrateEditorState(projectDir);
  return readSidecar(projectDir);
}

/**
 * The same answer, WITHOUT migrating — a read that writes nothing.
 *
 * For callers that must not have a side effect on the project they are
 * inspecting: the layout census (electron/legacy-epub-layout.ts) reads a
 * project to decide whether it may be opened at all, and a PDF project it
 * declines to touch has to come out of that byte-identical. The precedence rule
 * is applied in place instead: the legacy manifest key wins while it is still
 * there.
 */
export async function peekEditorState(projectDir: string): Promise<ManifestEditorState | null> {
  let content: string | null;
  try {
    content = await fs.promises.readFile(manifestPathOf(projectDir), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    content = null;
  }
  if (content !== null) {
    const manifest = JSON.parse(content) as Record<string, unknown>;
    if ('editor' in manifest) return (manifest.editor as ManifestEditorState) ?? {};
  }
  return readSidecar(projectDir);
}

/**
 * `peekEditorState`, synchronously, for the plain-Node tools.
 *
 * cli/export-epub.js and tools/split-ocr-block.js read a project without being
 * the app. They call this rather than reaching into the manifest themselves, so
 * there is exactly one implementation of the precedence rule in the repo.
 */
export function peekEditorStateSync(projectDir: string): ManifestEditorState | null {
  const manifestPath = manifestPathOf(projectDir);
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    if ('editor' in manifest) return (manifest.editor as ManifestEditorState) ?? {};
  }
  return readSidecar(projectDir);
}

/**
 * Write a project's editor state synchronously, for the plain-Node tools.
 *
 * Same staging rule as `atomicWriteFile`: a temp beside the target so the
 * publishing rename is same-filesystem, because the library folder is
 * Syncthing-monitored and a partial file is a syncable event.
 */
export function writeEditorStateSync(projectDir: string, state: ManifestEditorState): void {
  const target = editorStatePath(projectDir);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, target);
}

/** Write a project's editor state, compact and atomically. */
export async function writeEditorState(
  projectDir: string,
  state: ManifestEditorState,
): Promise<void> {
  await atomicWriteFile(editorStatePath(projectDir), JSON.stringify(state));
}

/**
 * Read-modify-write a project's editor state.
 *
 * A project with no state yet is given `{}` to mutate — this is the write path,
 * so "there is nothing here" is the starting point of an edit rather than a
 * refusal. Readers that must NOT create a sidecar use `readEditorState` and
 * decide for themselves.
 */
export async function updateEditorState(
  projectDir: string,
  mutate: (state: ManifestEditorState) => ManifestEditorState | void,
): Promise<void> {
  const current = await readEditorState(projectDir) ?? {};
  const next = mutate(current) ?? current;
  await writeEditorState(projectDir, next);
}

/**
 * Delete a project's editor state.
 *
 * A project that has none is not an error: this is called by the reset, whose
 * whole meaning is "there must be none afterwards".
 */
export async function deleteEditorState(projectDir: string): Promise<void> {
  try {
    await fs.promises.unlink(editorStatePath(projectDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Take the legacy `editor` key off a manifest THAT WAS JUST READ FROM DISK, and
 * preserve it in the sidecar first.
 *
 * The precedence rule turns on what is on disk, and this object IS what is on
 * disk — so its `editor` is the authoritative copy and moving it here is the
 * migration for that project. Used by the manifest write paths, which would
 * otherwise drop the key on the floor the first time anything unrelated (a
 * finished audiobook, a tag change) rewrites an unmigrated manifest.
 *
 * Returns whether it moved anything.
 */
export async function adoptLegacyEditorKey(
  projectDir: string,
  manifest: { editor?: ManifestEditorState },
): Promise<boolean> {
  if (!('editor' in manifest)) return false;
  const editor = manifest.editor;
  delete manifest.editor;
  await writeEditorState(projectDir, editor ?? {});
  return true;
}

/**
 * Take an `editor` key off a manifest ABOUT TO BE WRITTEN, without preserving it.
 *
 * The last line of defence on every manifest write: a renderer holding a
 * manifest object it fetched before the migration must not be able to put the
 * key back and re-bloat the file. The copy is DROPPED rather than adopted
 * because a renderer's object is not what is on disk and cannot be shown to be
 * newer than the sidecar — the write paths preserve the disk copy through
 * `adoptLegacyEditorKey` before reaching here.
 *
 * A non-empty drop is logged loudly: it means some caller still believes the
 * manifest is where editor state goes, and that is a bug to go and fix.
 */
export function stripEditorKey(
  manifest: { editor?: ManifestEditorState },
  writtenBy: string,
): boolean {
  if (!('editor' in manifest)) return false;
  const editor = manifest.editor;
  delete manifest.editor;
  if (isNonEmpty(editor)) {
    console.warn(
      `[editor-state-store] ${writtenBy} tried to write ${Object.keys(editor as object).length} `
      + 'editor field(s) into a manifest. Editor state lives in editor-state.json — the key was '
      + 'dropped, not written. Route this caller through editor-state-store.'
    );
  }
  return true;
}

/** What one sweep of a library came to. */
export interface EditorStateSweepResult {
  /** Project directories examined. */
  scanned: number;
  /** Of those, the ones whose manifest still carried `editor`. */
  migrated: number;
  /** Projects whose migration threw. Each is logged as it happens. */
  failed: number;
}

/**
 * Migrate every project under a library's `projects/` directory.
 *
 * ── Why a sweep exists at all ───────────────────────────────────────────────
 *
 * Migrate-on-contact alone would make `manifest:list` fast only for projects
 * somebody had opened since the change; a library of 378 books would stay slow
 * for months. The sweep does the whole library once, in the background, so the
 * list is fast on the second launch whatever the user opens.
 *
 * It is deliberately UNHURRIED and UNCONDITIONAL about failure: a modest number
 * of projects at a time so a spinning disk or a synced volume is not saturated
 * during startup, and any per-project error is logged by name and SKIPPED. One
 * unreadable manifest must not stop the other 377 from being migrated, and no
 * project is ever written a guessed structure to make the sweep succeed.
 */
export async function sweepEditorState(
  projectsDir: string,
  concurrency = 6,
): Promise<EditorStateSweepResult> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    // No projects directory means no library to sweep — the app has not been
    // pointed at one yet. Not a failure.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { scanned: 0, migrated: 0, failed: 0 };
    }
    throw err;
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(projectsDir, e.name));
  const result: EditorStateSweepResult = { scanned: 0, migrated: 0, failed: 0 };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= dirs.length) return;
      const dir = dirs[index];
      result.scanned++;
      try {
        if (await migrateEditorState(dir)) result.migrated++;
      } catch (err) {
        result.failed++;
        console.error(
          `[editor-state-store] ${path.basename(dir)}: could not move its editor state out of `
          + `manifest.json — ${(err as Error).message}. The project is UNCHANGED and will be `
          + 'retried the next time it is opened.'
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return result;
}
