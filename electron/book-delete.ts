/**
 * book-delete — deleting a book deletes its Foundry project too, and forgets what was cached about both.
 *
 * Until 2026-11-08 a book delete was `manifestService.deleteProject`: the book's
 * folder under `projects/` went to the library's trash and nothing else moved.
 * A book imported through Foundry keeps the file the user imported, the working
 * copy and every edit made in the Foundry window in its Foundry project
 * (`<library>/foundry/projects/<key>`), and that stayed behind. Foundry's own
 * Home went on listing it, its recents kept their rows, and importing the same
 * file again landed on the same content-keyed folder with the old work still in
 * it. The confirmation had promised "the file you imported, your working copy
 * and every edit recorded against it".
 *
 * FOUNDRY FIRST, THROUGH FOUNDRY'S OWN DOOR (`deleteProjectFolder`), because it
 * is the half that can refuse: a job writing into the project, or a file some
 * other process holds open. A refusal is Foundry's sentence, and nothing has been
 * deleted when the person reads it. The book's own folder can only fail to MOVE,
 * and library-trash.ts finishes that delete behind a note rather than refusing.
 *
 * THE CACHES ARE THE DELETE'S TO CLEAR. `derivation-cache.json` and
 * `duration-cache.json` key facts by absolute path, and nothing ever removed an
 * entry for a file that had been deleted: the derivation cache only drops
 * entries when it outgrows its limit, and the duration cache never does. The
 * delete knows exactly which trees went, so it forgets what is under them. No
 * sweep: a sweep would be a second owner guessing what the first already knew.
 *
 * Studio's delete (`manifest:delete`) and the Bookshelf's (`DELETE /api/project`)
 * both come here. Main hands in the doors this needs at startup
 * (`setBookDeleteDoors`), which keeps this module free of the window, the mount
 * and the Bookshelf server, and lets tools/test-book-delete.js run it against a
 * real temp library.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as manifestService from './manifest-service';
import { forgetDerivedUnder } from './derivation-cache';

/** What a book delete needs from outside this module, handed in once by main. */
export interface BookDeleteDoors {
  /** `<library>/foundry/projects`, where a manifest's `foundryProject.dir` key lives. */
  foundryProjectsDir(): string;
  /** Foundry's own project delete (foundry-core `deleteProjectFolder`): its sentence on success, a throw on refusal. */
  deleteFoundryProject(dir: string): Promise<string>;
  /** Forget the Bookshelf's remembered durations for every file under these folders. */
  forgetDurationsUnder(dirs: readonly string[]): void;
}

let doors: BookDeleteDoors | null = null;

export function setBookDeleteDoors(handed: BookDeleteDoors): void {
  doors = handed;
}

function requireDoors(): BookDeleteDoors {
  if (doors === null) {
    throw new Error('A book was deleted before main handed book-delete its doors (setBookDeleteDoors in electron/main.ts).');
  }
  return doors;
}

/**
 * The book's Foundry project folder, or null when it has none.
 *
 * A book with no manifest (an article, an old project) has no Foundry project. A
 * manifest that will not parse is refused by name rather than read as "none":
 * deleting the book anyway is exactly how a Foundry project gets orphaned, and
 * the file is something a person can repair.
 */
async function foundryProjectOf(projectId: string): Promise<string | null> {
  if (!fs.existsSync(manifestService.getManifestPath(projectId))) return null;
  let key: string | null;
  try {
    key = await manifestService.readFoundryProject(manifestService.getProjectPath(projectId));
  } catch (err) {
    throw new Error(
      `${manifestService.getManifestPath(projectId)} could not be read (${(err as Error).message}), so `
      + 'which Foundry project belongs to this book is unknown. Nothing was deleted: deleting the '
      + 'book alone would leave its Foundry project behind. Repair or remove that file, then delete again.',
    );
  }
  return key === null ? null : path.join(requireDoors().foundryProjectsDir(), key);
}

/** What the confirmation says goes, beyond the book's own folder. */
export async function describeBookDelete(projectId: string): Promise<{ foundryDir: string | null }> {
  const dir = await foundryProjectOf(projectId);
  return { foundryDir: dir !== null && fs.existsSync(dir) ? dir : null };
}

/** Delete a book: its Foundry project first, then its own folder, then what was cached about either. */
export async function deleteBook(
  projectId: string,
): Promise<{ success: boolean; error?: string; note?: string }> {
  const handed = requireDoors();
  const projectDir = manifestService.getProjectPath(projectId);
  if (!fs.existsSync(projectDir)) {
    return { success: false, error: `Project not found: ${projectId}` };
  }
  let foundryDir: string | null;
  try {
    foundryDir = await foundryProjectOf(projectId);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  if (foundryDir !== null) {
    if (fs.existsSync(foundryDir)) {
      try {
        console.log(`[book-delete] ${await handed.deleteFoundryProject(foundryDir)}`);
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    } else {
      // The record names a project that is not there: nothing on that side to delete.
      console.log(`[book-delete] ${projectId}'s Foundry project ${foundryDir} is already gone.`);
    }
  }

  const discarded = await manifestService.deleteProject(projectId);
  if (!discarded.success) {
    return {
      success: false,
      error: foundryDir === null
        ? discarded.error
        : `Its Foundry project was deleted, but the book's own folder was not: ${discarded.error}`,
    };
  }

  const gone = foundryDir === null ? [projectDir] : [projectDir, foundryDir];
  for (const dir of gone) forgetDerivedUnder(dir);
  handed.forgetDurationsUnder(gone);
  return discarded;
}
