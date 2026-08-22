/**
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A FOUNDRY PROJECT BECOMES A BOOK OF OURS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There are two doors, and this module is both of them so that they cannot come
 * to disagree about what the answer looks like on disk.
 *
 *  - FIRST CONTACT, the live one. The user presses "Import via Foundry" on a
 *    book that has no project yet, the bare window opens, they hand Foundry the
 *    book's own file, and Foundry announces the key it minted
 *    (`ImportLanding` → `onImport`, wired in electron/main.ts). That is
 *    `recordFoundryImportLanding` below.
 *
 *  - ADOPTION, the manual one. A Foundry project ALREADY EXISTS and BookForge
 *    has never seen it: it is in standalone Foundry's own library
 *    (`%APPDATA%/Foundry/app-settings.json` → `libraryDir/projects`), or it is
 *    an orphan sitting in our own hosted root that no book's manifest maps.
 *    There was no announcement, there is no book, and the thread the live path
 *    pulls on — "which of our books is this file inside?" — has nothing on the
 *    other end. `adoptFoundryProject` is that door: it MINTS the book from the
 *    project's own archived original and then joins the two.
 *
 * ── Why the live path moved in here ─────────────────────────────────────────
 *
 * Adoption must produce EXACTLY the state first contact produces — a book, an
 * archive variant, and `manifest.foundryProject { dir, sourceVariantId }` — and
 * two functions writing that mapping is two functions that drift. So the act
 * itself is `recordFoundryProjectMapping`, written once and called by both, and
 * the difference between the doors is reduced to the one thing that genuinely
 * differs: how the BOOK is found. The live path finds it (the file the user
 * opened is inside one of ours); adoption makes it.
 *
 * It is the same argument `fileFoundryExportAsVersion` makes one module over in
 * electron/foundry-export-sweep.ts, and for the same reason: a sweep carrying
 * its own copy of the filing act would drift from the live path the first time
 * either was touched.
 *
 * ── Why a module and not more of main.ts ────────────────────────────────────
 *
 * Everything here is file and manifest work over roots it is HANDED. It never
 * asks where the library is, never reaches for `app`, and never broadcasts —
 * the caller passes the roots in and is told what changed, exactly as the export
 * sweep is arranged. That is what lets `tools/test-foundry-adopt.js` run the
 * whole of adoption against a real temp library, which a function inside the
 * Electron entry point never could.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

import * as manifestService from './manifest-service';
import { importEpubProject } from './import-epub-project';
import { FOUNDRY_EXPORT_KINDS, sweepFoundryExportTrays } from './foundry-export-sweep';
import { normalizeFsPath } from './path-utils';
import { renameOntoDestination } from './processing-passes';
import { samePath } from '../shared/document/same-path';
// The wire shapes, declared in shared/ because the renderer draws them and
// cannot import out of electron/. See the header of that file.
import type {
  AdoptResult,
  AdoptableFoundryProject,
  AdoptableListing,
  BlockedFoundryProject,
  FoundryRefreshResult,
  FoundryStandaloneSource,
} from '../shared/foundry/adopt-types';

export type {
  AdoptResult,
  AdoptableFoundryProject,
  AdoptableListing,
  BlockedFoundryProject,
  FoundryRefreshResult,
  FoundryStandaloneSource,
};

// ─────────────────────────────────────────────────────────────────────────────
// The shared vocabulary: paths, claims, and the mapping act
// ─────────────────────────────────────────────────────────────────────────────

/** Is `child` inside `parent`? Windows-safe: normalized, and case-insensitively. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeFsPath(parent), normalizeFsPath(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Are these two absolute paths the same file, once both are resolved?
 *
 * A manifest path can be NFD (macOS-written) while the disk entry is NFC, and
 * `..` in a caller's string must not decide which version a mapping names.
 */
function sameResolvedPath(a: string, b: string): boolean {
  return samePath(path.resolve(normalizeFsPath(a)), path.resolve(normalizeFsPath(b)));
}

/** A landing's project KEY — the folder name under `<library>/foundry/projects/`. */
export function foundryLandingKey(projectDir: string): string {
  return path.basename(normalizeFsPath(projectDir));
}

/**
 * Every BookForge book, with the Foundry project key it claims.
 *
 * ONE PASS OVER THE LIBRARY PER QUESTION. `listProjects` reads each manifest
 * exactly once, concurrently — so matching a landing, listing what is adoptable,
 * and finding a narration target each cost one library sweep rather than one
 * manifest read per project. Deliberately NOT cached: an import that just landed
 * changed a manifest this instant, and a cache would answer with the library as
 * it stood before the thing being asked about.
 */
export async function foundryProjectClaims(): Promise<
  { dir: string; key: string | null; sourceVariantId?: string }[]
> {
  const listed = await manifestService.listProjects();
  if (!listed.success || !listed.projects) {
    throw new Error(
      `the library could not be listed: ${listed.error || 'no reason given'}`);
  }
  return listed.projects.map((m) => ({
    dir: manifestService.getProjectPath(m.projectId),
    key: m.foundryProject?.dir ?? null,
    // Carried so a re-import can tell "the same mapping again" from "the same
    // project, a different source version" without a second manifest read.
    sourceVariantId: m.foundryProject?.sourceVariantId,
  }));
}

/** What `recordFoundryProjectMapping` did, for the caller that reports it. */
export interface FoundryMappingResult {
  /** False when the manifest already said exactly this; nothing was written. */
  changed: boolean;
  /** The version the project was opened from, or null when none was matched. */
  sourceVariantId: string | null;
  /** The key this book pointed at before, when the mapping MOVED. */
  previousKey: string | null;
}

/**
 * JOIN ONE BOOK TO ONE FOUNDRY PROJECT — the act both doors perform.
 *
 * By the time either caller reaches this the hard part is done: the book is
 * known, the key is known, and `originalPath` names the file that became the
 * project. What is left is the part that must not be written twice — work out
 * WHICH VERSION of the book that file is, and record the pair.
 *
 * ── `originalPath` may be null, and null is an answer ───────────────────────
 *
 * THIS IS THE ONLY MOMENT THE SOURCE VERSION CAN BE KNOWN. Foundry names the
 * file that was imported; an export landing names a file in `final/` whose name
 * Foundry chose, with no way back to the version it came from. So the match is
 * made here, against this book's own variant list, and recorded — never inferred
 * later from an export's contents.
 *
 * When the file matches no version of ours the answer is `null` and it is STORED
 * as null: a user can import a stray file into a book's Foundry project, and an
 * export from it derives from no version we hold. Such exports render at top
 * level rather than being attached to whichever version happened to sort first.
 * A caller that cannot name the original at all passes null for the same reason
 * and gets the same honest outcome.
 *
 * THROWS when the write fails. The live path catches and logs (an announcement
 * must not become an exception inside Foundry's callback); adoption lets it
 * surface as a refusal the user reads.
 */
export async function recordFoundryProjectMapping(
  bookDir: string,
  key: string,
  originalPath: string | null,
): Promise<FoundryMappingResult> {
  const projectId = path.basename(bookDir);

  let sourceVariantId: string | null = null;
  let previousKey: string | null = null;
  let previousSource: string | undefined;

  const got = await manifestService.getManifest(projectId);
  if (!got.manifest) {
    throw new Error(
      `${projectId} could not be read (${got.error || 'no reason given'}), so it cannot be joined `
      + `to Foundry project "${key}". Nothing was changed.`);
  }
  previousKey = got.manifest.foundryProject?.dir ?? null;
  previousSource = got.manifest.foundryProject?.sourceVariantId;

  if (originalPath !== null) {
    const projectDir = manifestService.getProjectPath(projectId);
    const match = manifestService.getVariants(got.manifest).variants.find((v) =>
      sameResolvedPath(
        normalizeFsPath(path.join(projectDir, ...v.path.split('/'))),
        originalPath));
    sourceVariantId = match?.id ?? null;
  }

  // Nothing to write when the manifest already says exactly this about BOTH
  // halves. The source is compared too: the same project can be re-imported from
  // a different version of the book, and that is precisely the change the live
  // announcement exists to record.
  if (previousKey === key && previousSource === (sourceVariantId ?? undefined)) {
    return { changed: false, sourceVariantId, previousKey };
  }

  await manifestService.setFoundryProject(bookDir, key, sourceVariantId);
  return { changed: true, sourceVariantId, previousKey };
}

/** `ImportLanding`, in the spelling the mount contract publishes. */
export interface FoundryImportLandingShape {
  readonly projectDir: string;
  readonly originalPath: string;
  readonly kind: string;
}

/**
 * FIRST CONTACT: an import inside the Foundry window minted a project. Learn
 * which of our books it belongs to, from the file the user opened.
 *
 * `originalPath` is the thread. The bare Import-via-Foundry window is opened
 * FROM a book of ours, the user then drops or opens that book's own file, and
 * that file lives inside its BookForge project — so a landing whose original is
 * under one of our project folders names that book and no other.
 *
 * THE ANNOUNCEMENT IS AUTHORITATIVE, including over a mapping already recorded:
 * Foundry has just told us which project this file is, and a stored key that
 * disagrees is a stale one. That overwrite is the healing path the re-import
 * re-fire exists for, so it is taken rather than refused — loudly, because a
 * mapping CHANGING is worth a line in the log where first contact is routine.
 *
 * NEVER THROWS. Foundry catches whatever this rejects with, so an import that
 * landed on disk must not become a failed job because the host mishandled the
 * news; every failure is named here rather than left to that catch.
 *
 * `onMappingChanged` is called with the book's directory when the mapping was
 * actually written — main.ts turns it into the `foundry-host:project-changed`
 * broadcast that flips the door's label from "Import via Foundry" to "Edit in
 * Foundry" without a reload. A callback and not a `broadcastToAllWindows`
 * import, because the announcing is the host's business and importing the window
 * list would drag Electron into a module whose whole point is that it can be run
 * without it.
 */
export async function recordFoundryImportLanding(
  landing: FoundryImportLandingShape,
  onMappingChanged: (bookDir: string) => void,
): Promise<void> {
  const key = foundryLandingKey(landing.projectDir);
  let claims: Awaited<ReturnType<typeof foundryProjectClaims>>;
  try {
    claims = await foundryProjectClaims();
  } catch (err) {
    console.error(
      `[foundry-host] Foundry imported ${landing.originalPath} as project "${key}", but `
      + `${(err as Error).message}. The mapping was not recorded; re-import to try again.`);
    return;
  }

  const owner = claims.find((c) => isInside(c.dir, landing.originalPath));
  if (owner === undefined) {
    // Legitimate: somebody imported a stray file inside the Foundry window. It is
    // a Foundry project with no BookForge book, which is a thing that may exist —
    // and which "Adopt a Foundry project" is the door for, later, if the user
    // decides they want a book made from it after all.
    console.log(
      `[foundry-host] Foundry imported ${landing.originalPath} as project "${key}". It is not a `
      + 'file of any book in this library, so no mapping was recorded. Studio → Add → Adopt a '
      + 'Foundry project will make a book from it if that is what was wanted.');
    return;
  }

  let recorded: FoundryMappingResult;
  try {
    recorded = await recordFoundryProjectMapping(owner.dir, key, landing.originalPath);
  } catch (err) {
    console.error(`[foundry-host] ${(err as Error).message}`);
    return;
  }
  if (!recorded.changed) return;

  const from = recorded.sourceVariantId === null
    ? 'no version of this book (exports from it land at top level)'
    : `version ${recorded.sourceVariantId}`;
  const changing = recorded.previousKey !== null && recorded.previousKey !== key;
  console.log(
    changing
      ? `[foundry-host] ${path.basename(owner.dir)} now points at Foundry project "${key}" `
        + `(it pointed at "${recorded.previousKey}"), opened from ${from}. Foundry's own `
        + 'announcement is the authority.'
      : `[foundry-host] ${path.basename(owner.dir)} is Foundry project "${key}", opened from ${from}.`);
  onMappingChanged(owner.dir);
}

// ─────────────────────────────────────────────────────────────────────────────
// What a Foundry project IS, from outside Foundry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SIGNATURE — the least this side must be able to read before it will treat
 * a folder as a Foundry project.
 *
 * Learned from the vendored `readManifest` and `readArchive`
 * (foundry-app/electron/projects.ts) and deliberately no stricter than they are:
 * a folder Foundry itself would open must be a folder this door accepts, or the
 * user is told their own project is not one.
 *
 *   <dir>/project.json          parses, is an object, `version` is 1 or 2
 *                               (Foundry reads exactly those two), and `key` is
 *                               a non-empty string
 *   project.json → archive      `{ file: string, kind: 'pdf' | 'epub' }`
 *   <dir>/archive/<file>        exists
 *
 * THE ARCHIVE IS REQUIRED HERE THOUGH FOUNDRY TOLERATES ITS ABSENCE, and that is
 * the one place this reader is narrower. Foundry can open a project whose import
 * is gone — it still has the work made from it. Adoption cannot: the whole act is
 * "make a BookForge book out of the file this project was made from", and
 * without that file there is nothing to make one out of. So it is checked, and
 * refused by name, rather than discovered as an ENOENT three steps later.
 *
 * NOTHING IS WRITTEN AND NOTHING IS MIGRATED. `project.json` belongs to Foundry;
 * this is a read of somebody else's catalogue.
 */
export interface FoundryProjectSignature {
  /** The project's own key, from its catalogue. Content-derived by Foundry. */
  key: string;
  /** The folder's name. Equal to `key` for every project Foundry minted. */
  folder: string;
  /** What to call it in a list — the catalogue's title, or its stem. */
  title: string;
  /** The imported original: `<dir>/archive/<archive.file>`, absolute, verified. */
  originalPath: string;
  /** `pdf` or `epub` — which kind of origin the project holds. */
  originalKind: 'pdf' | 'epub';
}

/**
 * Thrown by `readFoundryProjectSignature`; its message is shown to the user.
 *
 * `kind` exists for ONE caller. Adoption shows every refusal, because the user
 * pointed at that folder on purpose. Discovery walks somebody's whole library
 * and must tell "a folder with no project.json" — an ordinary folder, and not a
 * failed project — apart from "a project this side cannot read", which IS worth
 * a line under the list.
 */
export class NotAFoundryProjectError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-catalogue' | 'unreadable',
    /**
     * The same refusal in ONE clause, for the greyed row's tooltip.
     *
     * `message` is written for somebody who just pressed a button and is owed a
     * paragraph. The list is the other case: the project is drawn, greyed, and
     * the reason is a hover — so it has to fit on one line and must not repeat
     * what the row already shows. Both exist because they are answering
     * different questions, not because one is a summary of the other.
     *
     * Defaulted to `message` so a refusal added later is never silently
     * tooltip-less; it will simply be too long, which is visible.
     */
    readonly short: string = message,
  ) {
    super(message);
  }
}

/**
 * Read a folder as a Foundry project, or say in a sentence why it is not one.
 *
 * Every refusal names the folder, says what was expected, and ends by saying
 * that nothing was adopted — because this is reached from a button a user just
 * pressed, and a press that lands nowhere must explain itself where the press
 * was rather than in a log nobody opens.
 */
export async function readFoundryProjectSignature(
  dir: string,
): Promise<FoundryProjectSignature> {
  const folder = path.basename(normalizeFsPath(dir));
  const catalogue = path.join(dir, 'project.json');

  let text: string;
  try {
    text = await fs.readFile(catalogue, 'utf-8');
  } catch {
    throw new NotAFoundryProjectError(
      `${dir} is not a Foundry project — there is no project.json in it, so nothing says which `
      + 'book that folder is. Nothing was adopted.', 'no-catalogue');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new NotAFoundryProjectError(
      `${catalogue} is not JSON (${(err as Error).message}), so it cannot be read as a Foundry `
      + 'catalogue. Nothing was adopted.', 'unreadable',
      'Its project.json is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NotAFoundryProjectError(
      `${catalogue} is not an object, so it is not a project catalogue. Nothing was adopted.`,
      'unreadable',
      'Its project.json is not a catalogue.');
  }
  const row = parsed as Record<string, unknown>;

  // Foundry reads versions 1 and 2 and refuses everything else by name. A shape
  // this side does not know is one whose archive field it cannot trust either.
  if (row['version'] !== 1 && row['version'] !== 2) {
    throw new NotAFoundryProjectError(
      `${catalogue} is version ${String(row['version'])}, and Foundry catalogues of versions 1 `
      + 'and 2 are the ones BookForge knows how to read. Nothing was adopted.', 'unreadable',
      `Catalogue version ${String(row['version'])} — BookForge reads 1 and 2.`);
  }

  const key = row['key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new NotAFoundryProjectError(
      `${catalogue} names no key, so nothing says which book that folder is. Nothing was adopted.`,
      'unreadable',
      'Its catalogue names no key.');
  }

  const archive = row['archive'];
  const archiveRow = typeof archive === 'object' && archive !== null
    ? archive as Record<string, unknown>
    : null;
  const file = archiveRow?.['file'];
  const kind = archiveRow?.['kind'];
  if (typeof file !== 'string' || file.length === 0 || (kind !== 'pdf' && kind !== 'epub')) {
    throw new NotAFoundryProjectError(
      `The Foundry project "${key}" records no imported original — its catalogue's archive names `
      + 'no file. Adoption makes a BookForge book out of the file a project was made from, and '
      + 'there is no such file here. Nothing was adopted.', 'unreadable',
      'No imported original — its catalogue records no file to make a book from.');
  }

  const originalPath = path.join(dir, 'archive', file);
  try {
    if (!(await fs.stat(originalPath)).isFile()) throw new Error('not a file');
  } catch {
    throw new NotAFoundryProjectError(
      `The Foundry project "${key}" says its original is archive/${file}, and there is no file `
      + `at ${originalPath}. The book it was made from cannot be adopted without it. Nothing was `
      + 'adopted.', 'unreadable',
      `Its original, archive/${file}, is missing.`);
  }

  // Foundry's own rule, mirrored rather than improved on: the title where the
  // catalogue has one, the stem where it does not, the key when it has neither.
  const stem = typeof row['stem'] === 'string' && row['stem'].length > 0 ? row['stem'] : key;
  const rawTitle = row['title'];
  const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : stem;

  return { key, folder, title, originalPath, originalKind: kind };
}

/** Has this project anything in its export tray the versions page would hold? */
async function hasExports(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(dir, 'final'));
  } catch {
    // No tray is the ordinary answer for a project nobody has exported from.
    return false;
  }
  return entries.some((name) =>
    FOUNDRY_EXPORT_KINDS.includes(path.extname(name).slice(1).toLowerCase()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery — what is there to adopt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where STANDALONE Foundry keeps its projects, or null when it is not installed.
 *
 * `foundryUserDataDir` is `%APPDATA%/Foundry` — Foundry's own userData folder,
 * where `app-settings.json` lives (foundry-app/electron/app-settings.ts). It is
 * PASSED IN rather than derived from `app.getPath('appData')` for this module's
 * standing reason: a test must be able to point it at a temp folder, and
 * deriving it here would make that impossible.
 *
 * NO SETTINGS FILE MEANS NO STANDALONE INSTALL, and that is not an error — the
 * ordinary machine has BookForge and no separate Foundry, and this half of the
 * list is simply empty there.
 *
 * A settings file that names no usable `libraryDir` means FOUNDRY AT ITS
 * DEFAULTS, which is `~/Documents/Foundry` — the answer `defaultLibraryDir()`
 * gives on that machine. That is not a fallback papering over a missing value:
 * the question is which folder Foundry ITSELF would read, and for a settings
 * file with the key absent or non-absolute, `clampLibraryDir` says exactly this.
 * Mirroring it is the only way to look where the user's projects actually are.
 */
export async function standaloneFoundryProjectsRoot(
  foundryUserDataDir: string,
  homeDir: string = os.homedir(),
): Promise<string | null> {
  const settings = path.join(foundryUserDataDir, 'app-settings.json');
  let text: string;
  try {
    text = await fs.readFile(settings, 'utf-8');
  } catch {
    return null;
  }

  let libraryDir = path.join(homeDir, 'Documents', 'Foundry');
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const named = (parsed as Record<string, unknown>)['libraryDir'];
      if (typeof named === 'string' && named.trim().length > 0 && path.isAbsolute(named.trim())) {
        libraryDir = path.normalize(named.trim());
      }
    }
  } catch (err) {
    // Foundry itself reads an unparsable file as its defaults. Said aloud once,
    // because a library the user cannot find is worth a line in the log.
    console.error(
      `[foundry-adopt] ${settings} could not be read (${(err as Error).message}), so standalone `
      + `Foundry's projects are being looked for where it keeps them by default.`);
  }
  return path.join(libraryDir, 'projects');
}

/**
 * EVERY FOUNDRY PROJECT NO BOOK OF OURS CLAIMS, from both places one can hide.
 *
 * Both roots are PASSED IN, for the reason every root in this module is: main.ts
 * owns the derivations (`foundryProjectsDir()` off a library root the user can
 * move mid-session, and `standaloneFoundryProjectsRoot` off Electron's appData),
 * and a second copy of either here is how the door would come to list a folder
 * adoption would not write to.
 *
 * `standaloneProjectsRoot` may be null — that is "no standalone Foundry on this
 * machine", and it costs that half of the list rather than the whole call.
 *
 * ── The filter ──────────────────────────────────────────────────────────────
 *
 * A project is adoptable when NO book's `manifest.foundryProject.dir` equals its
 * key. That is the same one-to-one the export sweep and the live landing both
 * work from — a project belongs to exactly one book — read here in the same one
 * pass over the library.
 *
 * ── The dedupe ──────────────────────────────────────────────────────────────
 *
 * A standalone project that was ALREADY COPIED into the hosted root but never
 * mapped appears in both halves under one key. The HOSTED one wins, because that
 * is the copy adoption would work on and the copy whose exports would land.
 */
export async function listAdoptableFoundryProjects(
  hostedProjectsRoot: string,
  standaloneProjectsRoot: string | null,
): Promise<AdoptableListing> {
  const claims = await foundryProjectClaims();
  const claimed = new Set(
    claims.map((c) => c.key).filter((k): k is string => k !== null));

  const refusals: string[] = [];
  const byKey = new Map<string, AdoptableFoundryProject>();
  // Same dedupe rule as `byKey`, for the same reason: hosted is walked second
  // and overwrites the standalone row for a key found in both.
  const blockedByKey = new Map<string, BlockedFoundryProject>();

  // Hosted SECOND so it overwrites the standalone entry for the same key — see
  // the dedupe note above.
  const roots: { root: string; origin: 'standalone' | 'hosted' }[] = [];
  if (standaloneProjectsRoot !== null) {
    roots.push({ root: standaloneProjectsRoot, origin: 'standalone' });
  }
  roots.push({ root: hostedProjectsRoot, origin: 'hosted' });

  for (const { root, origin } of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      // A root that does not exist is a real and common answer: a library with
      // no Foundry project has no `foundry/projects`, and a machine with no
      // standalone Foundry has no library. Neither is worth a refusal line.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      refusals.push(
        `${root} could not be listed (${(err as Error).message}), so any Foundry projects in it `
        + 'are not offered.');
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // A dot-folder is never a project key: Foundry's keys are
      // `<slug>-<8 hex>`, and `copyProjectInto` stages its copy under
      // `.adopting-…` precisely so a copy caught mid-flight cannot be mistaken
      // for a project — by this list or by anything else.
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(root, entry.name);

      let signature: FoundryProjectSignature;
      try {
        signature = await readFoundryProjectSignature(dir);
      } catch (err) {
        if (!(err instanceof NotAFoundryProjectError)) throw err;
        // A folder with no project.json is SILENT — it is somebody's folder,
        // not a project that failed. One that HAS a catalogue this side cannot
        // read is DRAWN, greyed, with the short reason on hover: the user is
        // looking for a project they know is there, and a row they can see and
        // point at answers that better than a paragraph under a list the
        // project is absent from (Owen's ruling, 2026-08-22).
        if (err.kind === 'unreadable' && !claimed.has(entry.name)) {
          blockedByKey.set(entry.name, {
            key: entry.name,
            dir,
            origin,
            reason: err.short,
            modifiedAt: await catalogueDate(dir),
          });
        }
        continue;
      }

      // The FOLDER's name is the key a mapping records — `foundryLandingKey` is
      // a basename and nothing else — so that, and not the catalogue's own
      // `key`, is what the claim check must compare. They agree for every
      // project Foundry minted; a folder somebody renamed is claimed under the
      // name it has now.
      if (claimed.has(entry.name)) continue;

      // Read a moment ago, so a failure here means it went away underneath us.
      // Drawn greyed rather than explained, same as any other reason it cannot
      // be taken — a row the user can see beats a sentence about one they cannot.
      const modifiedAt = await catalogueDate(dir);
      if (modifiedAt === null) {
        blockedByKey.set(entry.name, {
          key: entry.name,
          dir,
          origin,
          reason: 'Its catalogue could not be read just now.',
          modifiedAt: null,
        });
        continue;
      }

      byKey.set(entry.name, {
        title: signature.title,
        key: entry.name,
        dir,
        origin,
        modifiedAt,
        hasExports: await hasExports(dir),
        originalKind: signature.originalKind,
      });
    }
  }

  const projects = [...byKey.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  // A key that is adoptable somewhere wins outright. The two maps are filled
  // from two roots, so the same key can be a readable project in one and a
  // broken one in the other; offering it AND greying it in the same list is the
  // one outcome that would read as a bug rather than as an answer.
  const blocked = [...blockedByKey.values()]
    .filter((b) => !byKey.has(b.key))
    .sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));

  return { projects, blocked, refusals };
}

/** The catalogue's mtime as ISO, or null when it cannot be read. */
async function catalogueDate(dir: string): Promise<string | null> {
  try {
    return (await fs.stat(path.join(dir, 'project.json'))).mtime.toISOString();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Adoption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADOPT ONE FOUNDRY PROJECT — make it a book of this library, exports and all.
 *
 * `sourceDir` is a Foundry project folder anywhere on this machine.
 * `hostedProjectsRoot` is `<library>/foundry/projects` — passed in, never
 * derived here.
 *
 * ── The order, and why it is this order ─────────────────────────────────────
 *
 *  1. READ THE SIGNATURE. Everything downstream needs the key and the original,
 *     and a folder that is not a project must be refused before anything is
 *     copied anywhere.
 *  2. IS IT ALREADY OURS? Asked by KEY, against the same one-to-one every other
 *     Foundry path works from. A project already mapped is not adopted again —
 *     its tray is reconciled and the door says so. Asked BEFORE the copy,
 *     because re-copying over a hosted project the user has since worked in is
 *     exactly the damage this function must not do.
 *  3. PUT IT WHERE THE HOST LOOKS. A project outside the hosted root is COPIED
 *     in, never moved: Owen's standalone library is not ours to empty, and the
 *     copy is the one the host will open, sweep and export from. Copied to a
 *     temp sibling and renamed into place, so a copy that dies half-way leaves
 *     nothing that looks like a project.
 *  4. MINT THE BOOK from the project's own archived original, through
 *     `importEpubProject` — the same function `audiobook:import-epub` calls, so
 *     an adopted book is indistinguishable from a dropped one. Its duplicate
 *     guard is a FEATURE here: a user who imported the PDF into BookForge and
 *     ALSO built a Foundry project from it gets the two joined rather than a
 *     second copy of their book.
 *  5. JOIN THEM through `recordFoundryProjectMapping` — the same act first
 *     contact performs.
 *  6. RECONCILE THE TRAY through the existing `sweepFoundryExportTrays`, so
 *     EPUBs already sitting in `final/` are on the versions page before the
 *     modal closes. The sweep visits books by their mapping, which step 5 has
 *     just written, and it never replaces — so a project adopted twice lands
 *     nothing the second time.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * IT NEVER OVERWRITES A PROJECT IN THE HOSTED ROOT. A different project already
 * under that name is refused by name; the SAME project (same catalogue key) is
 * left exactly as it is and adoption continues against it, which is what makes
 * adopting twice cost nothing.
 *
 * IT NEVER MOVES OR EDITS THE SOURCE. `sourceDir` is read and, at most, copied.
 * Standalone Foundry's library is somebody else's program's data.
 *
 * `onProjectChanged` is called with the BookForge project directory whenever
 * this book's mapping or versions changed — main.ts turns it into the same
 * `foundry-host:project-changed` / `foundry-host:versions-changed` broadcasts
 * the live paths send, so an open shelf or versions page updates identically
 * whichever door a book came through.
 */
export async function adoptFoundryProject(
  sourceDir: string,
  hostedProjectsRoot: string,
  onProjectChanged: (bookDir: string) => void,
): Promise<AdoptResult> {
  // ── 1. Is it a Foundry project at all? ──────────────────────────────────
  let signature: FoundryProjectSignature;
  try {
    signature = await readFoundryProjectSignature(sourceDir);
  } catch (err) {
    if (err instanceof NotAFoundryProjectError) {
      return { outcome: 'refused', reason: err.message };
    }
    throw err;
  }
  // THE FOLDER'S NAME, not the catalogue's key: a mapping records a basename
  // (`setFoundryProject` refuses anything else), and the hosted copy is made
  // under the name the source folder has.
  const key = signature.folder;

  // ── 2. Does a book already claim it? ────────────────────────────────────
  let claims: Awaited<ReturnType<typeof foundryProjectClaims>>;
  try {
    claims = await foundryProjectClaims();
  } catch (err) {
    return {
      outcome: 'refused',
      reason: `Foundry project "${key}" could not be adopted because ${(err as Error).message}. `
        + 'Nothing was copied and nothing was changed.',
    };
  }
  const existing = claims.filter((c) => c.key === key);
  if (existing.length > 1) {
    return {
      outcome: 'refused',
      reason: `${existing.length} books already claim Foundry project "${key}" — `
        + `${existing.map((c) => path.basename(c.dir)).join(', ')}. A project belongs to exactly `
        + 'one book, so nothing was adopted; fix the duplicate mapping first.',
    };
  }
  if (existing.length === 1) {
    const bookDir = existing[0]!.dir;

    // BRING THE COPY FORWARD FIRST, so the tray this reconciles is the CURRENT
    // one. Adoption used to be copy-once: a project adopted on Monday and worked
    // on in standalone Foundry on Tuesday stayed, in this library, exactly as it
    // was on Monday — and pressing adopt again said "already in this library"
    // and reconciled a tray four steps out of date. Owen paid for that on
    // Reinhold Krause (2026-08-22): adopted 04:53 with three steps, translated,
    // simplified and struck standalone until 07:24, re-imported, and the
    // three-step copy stood with nothing said about it.
    const freshness = await refreshHostedCopy(sourceDir, hostedProjectsRoot, key);
    const landed = await reconcile(hostedProjectsRoot, key, onProjectChanged);
    return {
      outcome: 'already-mapped',
      projectId: path.basename(bookDir),
      bookDir,
      key,
      exportsLanded: landed,
      message:
        `“${signature.title}” is already in this library as ${path.basename(bookDir)}, joined to `
        + `Foundry project "${key}". ${freshnessSentence(freshness)}`
        + (landed > 0
          ? ` ${landed} export${landed === 1 ? '' : 's'} from its tray ${landed === 1 ? 'was' : 'were'} added to its versions.`
          : ''),
    };
  }

  // ── 3. Put the project where the host looks ─────────────────────────────
  const hostedDir = path.join(hostedProjectsRoot, key);
  let copied = false;
  if (!isInside(hostedProjectsRoot, sourceDir)) {
    let occupantKey: string | null = null;
    try {
      occupantKey = (await readFoundryProjectSignature(hostedDir)).key;
    } catch {
      // Either nothing is there, or what is there is not a project. Told apart
      // below by whether the folder exists at all — a non-project folder under a
      // project's name is a collision just as much as a project is.
      let occupied = false;
      try { occupied = (await fs.stat(hostedDir)).isDirectory(); } catch { /* absent */ }
      if (occupied) {
        return {
          outcome: 'refused',
          reason: `${hostedDir} already exists and is not a readable Foundry project, so “`
            + `${signature.title}” cannot be copied in under that name. Nothing was copied and `
            + 'nothing was adopted; move or rename that folder first.',
        };
      }
    }

    if (occupantKey !== null && occupantKey !== signature.key) {
      return {
        outcome: 'refused',
        reason: `A different Foundry project already occupies ${hostedDir} (its catalogue is `
          + `"${occupantKey}", and this one is "${signature.key}"). Nothing was copied and nothing `
          + 'was adopted; rename one of them first.',
      };
    }

    if (occupantKey === null) {
      try {
        await copyProjectInto(sourceDir, hostedProjectsRoot, hostedDir);
        copied = true;
      } catch (err) {
        return {
          outcome: 'refused',
          reason: `“${signature.title}” could not be copied into ${hostedProjectsRoot}: `
            + `${(err as Error).message}. Nothing was adopted; the project is untouched where it `
            + 'is.',
        };
      }
    }
    // occupantKey === signature.key: the SAME project is already here, claimed
    // by no book. It used to be left exactly as it was, on the reasoning that
    // the hosted copy may hold work the source does not — true, and the reason
    // `refreshHostedCopy` declines when the hosted side is newer. What that
    // reasoning missed is the other direction: an orphan copy left from an
    // earlier adoption is routinely OLDER than the project that made it, and
    // leaving it meant minting a book from a stale original.
    if (occupantKey !== null) {
      const freshness = await refreshHostedCopy(sourceDir, hostedProjectsRoot, key);
      if (freshness.kind === 'failed') {
        return {
          outcome: 'refused',
          reason: `“${signature.title}” is already copied into ${hostedProjectsRoot}, and that copy `
            + `could not be brought up to date. ${freshnessSentence(freshness)} Nothing was `
            + 'adopted, and the project itself was not touched.',
        };
      }
    }
  }

  // The original, as it stands in the copy the host will use. Re-read rather
  // than carried over from the source: they are the same file, and the one that
  // matters is the one under the folder the mapping names.
  const hostedSignature = isInside(hostedProjectsRoot, sourceDir)
    ? signature
    : await readFoundryProjectSignature(hostedDir);

  // ── 4. Mint the book from the project's own original ────────────────────
  const imported = await importEpubProject(hostedSignature.originalPath, { projectType: 'book' });

  let bookDir: string;
  let projectId: string;
  let originalInBook: string | null;
  let minted: boolean;

  if (imported.success && imported.projectPath && imported.projectId && imported.epubPath) {
    bookDir = imported.projectPath;
    projectId = imported.projectId;
    originalInBook = imported.epubPath;
    minted = true;
  } else if (imported.duplicate && imported.existingProjectPath && imported.existingProjectId) {
    // The library ALREADY holds this exact file as a book, imported some other
    // way, and nothing joined it to Foundry. Joining the two is the whole point
    // of the door — a second copy of the same book would be the wrong answer to
    // a user who has one already.
    bookDir = imported.existingProjectPath;
    projectId = imported.existingProjectId;
    minted = false;
    originalInBook = await originalFileOf(projectId);
  } else {
    if (copied) await rollBack(hostedDir);
    return {
      outcome: 'refused',
      reason: `A book could not be made from ${hostedSignature.originalPath}: `
        + `${imported.error || 'no reason given'}. Nothing was adopted`
        + (copied ? '; the copy made under the library was removed.' : '.'),
    };
  }

  // ── 5. Join them ────────────────────────────────────────────────────────
  //
  // NOT if the book is already joined to a DIFFERENT project that still
  // exists. Two projects made from the same file mint the same book, so an
  // adopt of the second lands here with `imported.duplicate` — and writing the
  // new key would re-point the book away from a project that may hold the
  // user's work, silently, in an act the user read as "import". That is how
  // the Flashpoint accident became permanent (2026-08-17): adopting an empty
  // twin re-pointed the book off the project with the real ledger. A previous
  // project that is GONE is the healing case, and the re-point is taken.
  if (!minted) {
    const previousKey = await manifestService.readFoundryProject(bookDir);
    if (previousKey !== null && previousKey !== key) {
      let previousExists = false;
      try {
        previousExists = (await fs.stat(path.join(hostedProjectsRoot, previousKey))).isDirectory();
      } catch { /* gone — the healing case */ }
      if (previousExists) {
        if (copied) await rollBack(hostedDir);
        return {
          outcome: 'refused',
          reason: `${projectId} is already joined to Foundry project "${previousKey}", which is `
            + `still in this library's Foundry folder. Adopting "${key}" would re-point the book `
            + 'away from that project and whatever work is in it, so nothing was adopted. If '
            + `"${key}" is the project you mean, delete the book (or the old project folder) `
            + 'first, then adopt again.',
        };
      }
    }
  }
  let mapping: FoundryMappingResult;
  try {
    mapping = await recordFoundryProjectMapping(bookDir, key, originalInBook);
  } catch (err) {
    return {
      outcome: 'refused',
      reason: `${projectId} was ${minted ? 'created from' : 'matched to'} “${signature.title}”, `
        + `but it could not be recorded as Foundry project "${key}": ${(err as Error).message}. `
        + 'The book is in your library; press Adopt again to finish joining it.',
    };
  }
  if (mapping.changed) onProjectChanged(bookDir);

  console.log(
    `[foundry-adopt] ${projectId} ${minted ? 'was created from' : 'was already the book of'} `
    + `Foundry project "${key}" (${copied ? 'copied in from' : 'in place at'} ${sourceDir}), `
    + `opened from ${mapping.sourceVariantId === null ? 'no version of it' : `version ${mapping.sourceVariantId}`}.`);

  // ── 6. Land whatever is already in its tray ─────────────────────────────
  const exportsLanded = await reconcile(hostedProjectsRoot, key, onProjectChanged);

  return {
    outcome: 'adopted',
    projectId,
    bookDir,
    key,
    minted,
    copied,
    sourceVariantId: mapping.sourceVariantId,
    exportsLanded,
    message:
      (minted
        ? `“${signature.title}” was adopted from Foundry and added to your library.`
        : `“${signature.title}” was already in your library, and is now joined to its Foundry project.`)
      + (exportsLanded > 0
        ? ` ${exportsLanded} export${exportsLanded === 1 ? '' : 's'} from its tray `
          + `${exportsLanded === 1 ? 'is' : 'are'} on its versions page.`
        : ''),
  };
}

/**
 * The name of the file a book was imported FROM, absolute, or null.
 *
 * `role: 'original'` is the field `importEpubProject` writes for exactly this —
 * the pristine copy in `archive/` that IS the source. Null when the book has
 * none (an audiobook import, or a project that predates the field), and null is
 * carried honestly into the mapping: the source version is then "unknown", which
 * is the same answer the live path records for a stray import, and exports land
 * at top level rather than under a version this code picked.
 */
async function originalFileOf(projectId: string): Promise<string | null> {
  const got = await manifestService.getManifest(projectId);
  const entry = (got.manifest?.archive || []).find((a) => a.role === 'original');
  if (entry === undefined) return null;
  return path.join(manifestService.getProjectPath(projectId), ...entry.path.split('/'));
}

/**
 * Copy a whole project folder in, ATOMICALLY as far as the destination is
 * concerned: into a temp sibling first, then one rename.
 *
 * A recursive copy of a project with a readings bank in it is seconds of work
 * and can die in the middle of them. Copying straight to `<root>/<key>` would
 * leave a folder that every later pass — the sweep, this door's own collision
 * check — would read as a project and refuse to touch. The rename is within one
 * directory and therefore one volume, so it is the single instant at which the
 * project appears.
 *
 * THAT INSTANT CAN BE REFUSED, and it was: Owen's "star gods" adoption onto a
 * library on Z: (an SMB share to the NAS) died with
 * `EPERM: operation not permitted, rename '…/.adopting-star-gods-…' -> '…/star-gods-…'`
 * with NOTHING at the destination. Windows answers EPERM while any process holds
 * something in the tree open, and on a library the indexer walks and Defender
 * scans that is a coin toss measured in milliseconds — the same one
 * `renameOntoDestination` was written for. Measured on that share afterwards, with
 * this same 1.03 GiB project: copy-then-rename landed in 10 ms, so the refusal was
 * a hold rather than a no. This call site simply had no ladder, so one unlucky
 * instant surfaced as a failed adoption with a syscall for an explanation.
 *
 * So the landing goes through the ONE ladder this app has for it rather than a
 * second copy of the rule here. It is deliberately not `moveIntoPlace`: that
 * answers a refusal by copying BESIDE the destination first, which here would be a
 * second gigabyte written to the same directory the staging copy already sits in.
 * The staging sibling is already beside the destination — the ladder is the whole
 * of what this move needs, and a refusal that outlives it should be seen.
 */
async function copyProjectInto(
  sourceDir: string,
  hostedProjectsRoot: string,
  hostedDir: string,
): Promise<void> {
  await fs.mkdir(hostedProjectsRoot, { recursive: true });
  const staging = path.join(
    hostedProjectsRoot, `.adopting-${path.basename(hostedDir)}-${process.pid}-${Date.now()}`);
  try {
    await fs.cp(sourceDir, staging, { recursive: true });
    await renameOntoDestination(staging, hostedDir);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => { /* named below */ });
    throw err;
  }
  // So the copy carries the original's own timestamp rather than the moment it
  // was made — see `stampCopyFromSource`. A copy that is younger than its source
  // reads as "the hosted side has newer work", which it never does at this point.
  await stampCopyFromSource(sourceDir, hostedDir);
}

/**
 * What the hosted copy was, relative to the source, when adoption looked.
 *
 * `hosted-newer` is a real answer and not a failure: the hosted copy is the one
 * the hosted Foundry window edits, so it can legitimately be ahead. What it must
 * never be is silently overwritten.
 */
type CopyFreshness =
  | { kind: 'in-place' }
  | { kind: 'unreadable'; why: string }
  | { kind: 'current' }
  | { kind: 'restored'; filesCopied: number }
  | { kind: 'refreshed'; sourceAt: Date; hostedAt: Date; filesCopied: number; filesRemoved: number }
  | { kind: 'hosted-newer'; sourceAt: Date; hostedAt: Date }
  /**
   * `partial` is the price of mirroring instead of replacing wholesale: a
   * refresh that dies half-way has already written some files. It is SAID rather
   * than hidden, because the answer to it — press again — is different from the
   * answer to a refresh that never started.
   */
  | { kind: 'failed'; why: string; partial: boolean };

/** One sentence for the user about what happened to the copy. Never silence. */
function freshnessSentence(freshness: CopyFreshness): string {
  switch (freshness.kind) {
    case 'in-place':
      return 'It is already the copy this library uses, so there was nothing to bring across.';
    case 'restored':
      return `Its copy in this library was missing, and all `
        + `${countOfFiles(freshness.filesCopied)} of it ${freshness.filesCopied === 1 ? 'was' : 'were'} `
        + 'copied across again.';
    case 'unreadable':
      return `Its copy in this library could not be compared with the original (${freshness.why}), `
        + 'so nothing was brought across.';
    case 'current':
      return 'Its copy here was already up to date.';
    case 'refreshed':
      return `Its copy here was brought up to date: ${countOfFiles(freshness.filesCopied)} came `
        + `across from work done at ${stamp(freshness.sourceAt)}`
        + (freshness.filesRemoved > 0
          ? `, and ${countOfFiles(freshness.filesRemoved)} the original no longer has `
            + `${freshness.filesRemoved === 1 ? 'was' : 'were'} removed`
          : '')
        + `, replacing a copy that stood at ${stamp(freshness.hostedAt)}.`;
    case 'hosted-newer':
      return `Its copy here is NEWER than the original (${stamp(freshness.hostedAt)} against `
        + `${stamp(freshness.sourceAt)}), so it was left alone rather than overwritten with older `
        + 'work.';
    case 'failed':
      return `Its copy here could not be brought up to date (${freshness.why}), so it was left `
        + (freshness.partial
          ? 'part-way updated — press again to finish it; nothing that reached it is wrong, and '
            + 'its catalogue still reads as the older copy until the whole of it lands.'
          : 'exactly as it was.');
  }
}

/** "3 files" / "1 file" — used where a count is read mid-sentence. */
function countOfFiles(n: number): string {
  return `${n} file${n === 1 ? '' : 's'}`;
}

/**
 * Are these the same moment, as far as two filesystems can agree?
 *
 * Exact equality is the wrong test even though `stampCopyFromSource` writes the
 * source's own mtime onto the copy: the library lives on an SMB share here, and
 * a share is free to round what it stores. Two seconds is the coarsest
 * granularity in common use (FAT's), so anything inside it is the same write as
 * far as this question goes.
 *
 * WHAT THE WINDOW COSTS, chosen rather than inherited (bookforge-mac-2's note,
 * 2026-08-22): it also swallows a GENUINE hosted write that lands within two
 * seconds of the stamp — that project reads as `current` and a later refresh
 * would overwrite it. The trade is deliberate. Rounding is a property of the
 * filesystem and happens on every comparison; a hosted export landing inside the
 * two seconds between copying a project and stamping it is a race nobody has
 * hit. Narrowing the window would trade a certainty for a coincidence.
 */
function sameInstant(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= 2000;
}

/**
 * Give the copy the ORIGINAL's timestamp, so "has the source changed since we
 * copied it?" is answerable by comparing the two.
 *
 * WITHOUT THIS, A COPY IS ALWAYS NEWER THAN ITS ORIGINAL, and the comparison
 * above reports `hosted-newer` for every freshly-copied project — the resting
 * state of a copy misread as "the hosted window did work here". bookforge-mac-2
 * caught that within minutes of it landing, by running an adopt-then-re-adopt
 * through this module's own harness: the sentence refuted itself in its own
 * parentheses, claiming one side was newer while printing two identical
 * timestamps. `current` was unreachable in the same stroke, because the only way
 * to reach it was exact-millisecond equality between a file and its copy.
 *
 * Stamping costs no new state — no sidecar, no watermark, nothing for a sync to
 * carry or lose. The catalogue's mtime simply goes on meaning what it meant
 * before it was copied.
 *
 * Best-effort by design: a share that refuses `utimes` leaves the copy younger
 * than its source, which reads as `hosted-newer` — the direction that DECLINES
 * to overwrite. A failure here can cost a refresh; it cannot cost work.
 */
async function stampCopyFromSource(sourceDir: string, hostedDir: string): Promise<void> {
  try {
    const source = await fs.stat(path.join(sourceDir, 'project.json'));
    await fs.utimes(path.join(hostedDir, 'project.json'), source.atime, source.mtime);
  } catch (err) {
    console.warn(
      `[foundry-adopt] The copy of "${path.basename(hostedDir)}" could not be stamped with its `
      + `original's timestamp (${(err as Error).message}). It will read as newer than the original `
      + 'until something rewrites it, so a later adopt will decline to refresh it rather than '
      + 'refresh it wrongly.');
  }
}

/** Local wall-clock, to the minute — these are compared by a person, not a program. */
function stamp(at: Date): string {
  return at.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The one name the mirror below never touches on its own — it is landed LAST, by
 * hand, as the record that the rest of the refresh finished.
 */
const CATALOGUE = 'project.json';

/** What a mirror pass wrote and unwrote, counted for the sentence the user reads. */
interface MirrorTally {
  copied: number;
  removed: number;
}

/**
 * MAKE `destDir` MATCH `sourceDir`, touching only the files that differ.
 *
 * ── Why not simply replace the folder ───────────────────────────────────────
 *
 * Because Owen asked for the other thing, and he was right to: *"just the files
 * that would be affected by it"* (2026-08-22). A Foundry project is mostly the
 * imported original and its page images — "star gods" is 1.03 GiB — and the work
 * a reload is FOR is a catalogue and a handful of step documents. Copying the
 * whole gigabyte across an SMB share to bring forty kilobytes of it is the kind
 * of cost that makes a button nobody presses.
 *
 * ── What "differ" means here, and what it misses ────────────────────────────
 *
 * SIZE AND MODIFICATION TIME, not content. This is rsync’s quick check and it
 * carries rsync’s blind spot: a file rewritten to the same length within the
 * same `sameInstant` window as the copy it replaces reads as unchanged and is
 * not brought across. Hashing both sides would close that and would also read
 * every byte of the gigabyte this exists to avoid — the same cost as copying it,
 * for a case that needs an editor to write the same number of bytes in the same
 * second. The trade is deliberate; it is named here so nobody has to rediscover
 * it from a file that did not update.
 *
 * ── Why the timestamps are written rather than inherited ────────────────────
 *
 * `fs.copyFile` does not carry an mtime, and `fs.cp` carries one on win32 and
 * not on macOS (both measured 2026-08-22 — see `refreshHostedCopy`). Every file
 * this writes is stamped from its source explicitly, so the NEXT pass’s
 * comparison means the same thing on every platform. That is the lesson
 * `stampCopyFromSource` exists for, applied per file.
 *
 * ── What it deletes ─────────────────────────────────────────────────────────
 *
 * Anything in the copy the original no longer has. A mirror that only added
 * would leave a step the user deleted in Foundry standing in the copy forever,
 * and the copy is what the hosted window opens — so the deletion is the honest
 * half of "reload". It is bounded to this project’s folder and nothing above it.
 *
 * ── Not atomic, and that is survivable ──────────────────────────────────────
 *
 * The stage-and-rename this replaced could not leave a half-updated project;
 * this can. What makes it safe is the ORDER: `CATALOGUE` is excluded here and
 * landed last by the caller, so a pass that dies half-way leaves a copy whose
 * project.json still reads as older than the source. The next press mirrors
 * again, converges on what is left, and lands the catalogue. Idempotence is
 * doing the work atomicity used to.
 */
async function mirrorInto(
  sourceDir: string,
  destDir: string,
  tally: MirrorTally,
  skip: ReadonlySet<string>,
): Promise<void> {
  const sourceEntries = await fs.readdir(sourceDir, { withFileTypes: true });
  const destEntries = await fs.readdir(destDir, { withFileTypes: true });
  const inSource = new Set(sourceEntries.map((e) => e.name));

  for (const entry of destEntries) {
    if (skip.has(entry.name)) continue;
    if (inSource.has(entry.name)) continue;
    await fs.rm(path.join(destDir, entry.name), { recursive: true, force: true });
    tally.removed++;
  }

  for (const entry of sourceEntries) {
    if (skip.has(entry.name)) continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // A FILE may stand where a folder belongs — the two trees are only as
      // related as the last refresh left them.
      let clash = false;
      try { clash = !(await fs.stat(to)).isDirectory(); } catch { /* absent */ }
      if (clash) await fs.rm(to, { recursive: true, force: true });
      await fs.mkdir(to, { recursive: true });
      await mirrorInto(from, to, tally, NOTHING_HELD_BACK);
      continue;
    }

    if (!entry.isFile()) {
      // A symlink, or something a filesystem knows about that this walk does
      // not. Replaced wholesale rather than compared, because "unchanged" is
      // not defined for it here and guessing would be the wrong kind of clever.
      await fs.rm(to, { recursive: true, force: true });
      await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
      tally.copied++;
      continue;
    }

    const source = await fs.stat(from);
    let unchanged = false;
    let occupied = false;
    try {
      const dest = await fs.stat(to);
      occupied = true;
      unchanged = dest.isFile()
        && dest.size === source.size
        && sameInstant(dest.mtime, source.mtime);
    } catch { /* absent — it is copied below */ }
    if (unchanged) continue;
    if (occupied) await fs.rm(to, { recursive: true, force: true });
    await fs.copyFile(from, to);
    await fs.utimes(to, source.atime, source.mtime);
    tally.copied++;
  }
}

/** Passed to every recursive call: only the TOP level holds back the catalogue. */
const NOTHING_HELD_BACK: ReadonlySet<string> = new Set<string>();

/**
 * Bring the hosted copy forward to the source, when the source is the newer one.
 *
 * ── Why an mtime and not the ledger ─────────────────────────────────────────
 *
 * The catalogue's own mtime answers exactly the question being asked — "has the
 * original changed since we copied it?" — without this side learning to read
 * Foundry's ledger. Reading their step list to count steps would be a second,
 * worse copy of a shape they own and change.
 *
 * IT ONLY ANSWERS IT BECAUSE THE COPY IS STAMPED. `fs.cp` is not consistent
 * about carrying mtimes: measured 2026-08-22, win32 PRESERVES them exactly (0 ms
 * delta, on local disk and on the SMB library share alike) while macOS does NOT
 * (bookforge-mac-2, same day). A comparison resting on that would have been
 * right on one machine and wrong on the other — which is exactly what happened:
 * this shipped depending on non-preservation, was correct on macOS's behaviour
 * in one branch and on Windows's in another, and reported "your copy is NEWER"
 * for every untouched copy on the Mac. `stampCopyFromSource` removes the
 * dependence rather than picking a side.
 *
 * ── THE ONE THING THIS CANNOT SEE, said rather than hidden ──────────────────
 *
 * Two mtimes cannot detect DIVERGENCE. If both sides were worked on since the
 * copy, this reports whichever is later and refreshes or declines on that basis;
 * it cannot know the other side also moved. It is safe in the direction that
 * matters — hosted-newer never overwrites — but a source-newer refresh over a
 * hosted copy that was ALSO edited would take the hosted edits with it. The
 * hosted window and standalone Foundry editing the same project between two
 * adoptions is the case that would need a real three-way answer.
 *
 * ── HOSTED-NEWER IS DETECTABLE, WHICH WAS NOT OBVIOUS ───────────────────────
 *
 * It only means something if the hosted window actually rewrites the copy's
 * catalogue when it does work. It does, for the two kinds that matter, read out
 * of the vendored subtree at 644831a by bookforge-mac-2: an EXPORT writes the
 * captured step into the tray row (`foundry-app/electron/job-queue.ts`, the
 * `exporting` branch — "so that a host reading `project.json` afterwards learns
 * what a host listening at this instant learns from the announcement"), and a
 * GENERATED BOOK records its origin there too. So after the stamp, the ONLY way
 * `hostedAt` can exceed `sourceAt` is the hosted window having done something.
 *
 * NOT every kind of hosted work was enumerated. If some in-place edit lands
 * without touching `project.json`, that class is invisible here and falls under
 * the divergence limit above — Foundry owns that list. What is closed is the
 * case Owen hit.
 */
async function refreshHostedCopy(
  sourceDir: string,
  hostedProjectsRoot: string,
  key: string,
): Promise<CopyFreshness> {
  // The source IS the copy — an orphan already under the hosted root. There is
  // no second place for it to be brought forward from.
  if (isInside(hostedProjectsRoot, sourceDir)) return { kind: 'in-place' };

  const hostedDir = path.join(hostedProjectsRoot, key);
  let sourceAt: Date;
  let hostedAt: Date;
  try {
    sourceAt = (await fs.stat(path.join(sourceDir, 'project.json'))).mtime;
  } catch (err) {
    return { kind: 'unreadable', why: (err as Error).message };
  }
  try {
    hostedAt = (await fs.stat(path.join(hostedDir, CATALOGUE))).mtime;
  } catch {
    // THE COPY IS GONE. It used to be reported and left gone, which is the one
    // answer that helps nobody: the book’s mapping names a folder the hosted
    // window would open, and there is nothing there. The original is right here,
    // so it is copied across again in full — there is no partial copy to mirror
    // against.
    try {
      await copyProjectInto(sourceDir, hostedProjectsRoot, hostedDir);
    } catch (err) {
      return { kind: 'failed', why: (err as Error).message, partial: false };
    }
    return { kind: 'restored', filesCopied: await countFiles(hostedDir) };
  }

  if (sameInstant(hostedAt, sourceAt)) return { kind: 'current' };
  if (hostedAt > sourceAt) return { kind: 'hosted-newer', sourceAt, hostedAt };

  // MIRROR, THEN LAND THE CATALOGUE. This used to stage a whole second copy of
  // the project beside the old one and swap them with three renames — correct,
  // atomic, and a gigabyte of writes to carry across a catalogue and two step
  // documents. See `mirrorInto` for the trade that replaced it, and for why the
  // catalogue is held back to the end.
  const tally: MirrorTally = { copied: 0, removed: 0 };
  try {
    await mirrorInto(sourceDir, hostedDir, tally, HOLD_BACK_CATALOGUE);
    await fs.copyFile(path.join(sourceDir, CATALOGUE), path.join(hostedDir, CATALOGUE));
  } catch (err) {
    return {
      kind: 'failed',
      why: (err as Error).message,
      partial: tally.copied > 0 || tally.removed > 0,
    };
  }
  await stampCopyFromSource(sourceDir, hostedDir);
  return {
    kind: 'refreshed',
    sourceAt,
    hostedAt,
    // The catalogue is one of the files that came across, and a count the user
    // reads must not quietly omit the one file that is always in it.
    filesCopied: tally.copied + 1,
    filesRemoved: tally.removed,
  };
}

/** The top-level skip set: the catalogue lands by hand, last. See `mirrorInto`. */
const HOLD_BACK_CATALOGUE: ReadonlySet<string> = new Set([CATALOGUE]);

/**
 * How many files a tree holds. Only for the sentence a restore reports — the
 * mirror counts what it writes as it writes it, and a whole-folder copy has no
 * such tally to hand back.
 */
async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += await countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reload from Foundry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standalone project a book was adopted from, if standalone Foundry still
 * has one under that key.
 *
 * Null covers three different things on purpose — no standalone Foundry on this
 * machine, no folder under that key, no catalogue in it — because the caller
 * does exactly one thing with all three: it draws the Reload button disabled.
 * The act itself (`refreshAdoptedProject`) tells them apart in words, because a
 * press is owed a reason and a greyed button is not.
 */
export async function findStandaloneSource(
  standaloneProjectsRoot: string | null,
  key: string,
): Promise<FoundryStandaloneSource | null> {
  if (standaloneProjectsRoot === null) return null;
  const dir = path.join(standaloneProjectsRoot, key);
  const modifiedAt = await catalogueDate(dir);
  if (modifiedAt === null) return null;
  return { dir, modifiedAt };
}

/**
 * RELOAD ONE ALREADY-ADOPTED BOOK from the standalone project it came from.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * Adoption brings a project forward every time it is pressed — but a project a
 * book already claims is FILTERED OUT of the Adopt list
 * (`listAdoptableFoundryProjects`, "a project belongs to exactly one book"), so
 * after the first adoption there was no press to make. The refresh existed and
 * was unreachable except through the browse-for-a-folder fallback. Owen asked
 * for the button the day after the refresh landed: *"i think ill need a way to
 * pull in the latest changes from foundry if more work was done there"*.
 *
 * ── What it touches, and what it deliberately does not ──────────────────────
 *
 * THE HOSTED COPY, by mirror — only the files that differ (see `mirrorInto`).
 * Then the export trays, through the same sweep every other Foundry path uses,
 * so an EPUB exported in standalone since the last press is on the versions
 * page when this returns.
 *
 * IT DOES NOT RE-IMPORT THE BOOK. The book’s own `archive/` original is what it
 * was made from and is immutable; re-minting it would mean a second book or a
 * rewritten one, and neither is what "reload" means. It does not write the
 * mapping either — the mapping is why this call is possible at all.
 *
 * IT NEVER OVERWRITES NEWER HOSTED WORK. `refreshHostedCopy` declines when the
 * copy is ahead of the original, and that decline is reported as its own
 * outcome rather than as a failure — the user pressed a button and is owed the
 * difference between "there was nothing to bring" and "there was, and this side
 * would not take it".
 */
export async function refreshAdoptedProject(
  bookDir: string,
  hostedProjectsRoot: string,
  standaloneProjectsRoot: string | null,
  onProjectChanged: (bookDir: string) => void,
): Promise<FoundryRefreshResult> {
  const book = path.basename(bookDir);

  let key: string | null;
  try {
    key = await manifestService.readFoundryProject(bookDir);
  } catch (err) {
    return {
      outcome: 'refused',
      reason: `${book}’s manifest could not be read (${(err as Error).message}), so which Foundry `
        + 'project it belongs to is unknown. Nothing was changed.',
    };
  }
  if (key === null) {
    return {
      outcome: 'refused',
      reason: `${book} is not joined to a Foundry project, so there is nothing to reload it from. `
        + 'Nothing was changed.',
    };
  }

  if (standaloneProjectsRoot === null) {
    return {
      outcome: 'refused',
      reason: `There is no standalone Foundry on this machine — nothing names a library for it — `
        + `so Foundry project "${key}" has nowhere newer to be reloaded from. Work done in the `
        + 'Foundry window inside BookForge is already in this library. Nothing was changed.',
    };
  }
  const sourceDir = path.join(standaloneProjectsRoot, key);
  try {
    // Read for its refusals, not for its fields: a folder that is not a readable
    // project must be named as such BEFORE anything is mirrored out of it.
    await readFoundryProjectSignature(sourceDir);
  } catch (err) {
    if (!(err instanceof NotAFoundryProjectError)) throw err;
    if (err.kind === 'no-catalogue') {
      return {
        outcome: 'refused',
        reason: `Standalone Foundry has no project "${key}" at ${sourceDir}. This book’s project `
          + 'lives only inside BookForge, so there is nothing to reload from. Nothing was changed.',
      };
    }
    return { outcome: 'refused', reason: err.message };
  }

  const freshness = await refreshHostedCopy(sourceDir, hostedProjectsRoot, key);
  if (freshness.kind === 'failed' || freshness.kind === 'unreadable') {
    return {
      outcome: 'refused',
      reason: `Foundry project "${key}" could not be reloaded from ${sourceDir}. `
        + freshnessSentence(freshness),
    };
  }

  // The tray is swept whatever the copy did — an export can be sitting in a copy
  // that is otherwise current, if the last press landed the files and the sweep
  // did not run. It never replaces a version that already exists, so a press
  // that brings nothing across costs nothing here either.
  const exportsLanded = await reconcile(hostedProjectsRoot, key, onProjectChanged);
  // EVERY `Its` in a freshness sentence needs an antecedent, and inside adoption
  // it had one — the project had just been named in the sentence before. A
  // reload reports into a toast on the workspace, where nothing has been named
  // at all, so the subject is supplied here rather than by writing a second set
  // of sentences that would drift from the first.
  const said = `This book is Foundry project "${key}". ${freshnessSentence(freshness)}`;
  const landed = exportsLanded > 0
    ? ` ${exportsLanded} export${exportsLanded === 1 ? '' : 's'} `
      + `${exportsLanded === 1 ? 'is' : 'are'} now on its versions page.`
    : '';

  if (freshness.kind === 'hosted-newer') {
    return {
      outcome: 'declined',
      message: `${said}${landed}`,
      exportsLanded,
    };
  }
  if (freshness.kind === 'current' || freshness.kind === 'in-place') {
    return {
      outcome: 'current',
      message: `${said}${landed}`,
      exportsLanded,
    };
  }
  return {
    outcome: 'refreshed',
    message: `${said}${landed}`,
    filesCopied: freshness.filesCopied,
    filesRemoved: freshness.kind === 'restored' ? 0 : freshness.filesRemoved,
    exportsLanded,
  };
}

/** Undo a copy this call made, so a failed adoption can simply be retried. */
async function rollBack(hostedDir: string): Promise<void> {
  try {
    await fs.rm(hostedDir, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[foundry-adopt] The adoption failed and its copy at ${hostedDir} could not be removed `
      + `(${(err as Error).message}). Delete that folder before trying again.`);
  }
}

/**
 * Reconcile the trays and answer how many exports this ONE project's tray gave.
 *
 * The whole sweep is run rather than a private per-project walk, for this
 * module's standing reason: `sweepFoundryExportTrays` is where "an export in a
 * tray belongs on the versions page" is decided, and a second implementation of
 * it here would drift. It visits only books that have a mapping and never
 * replaces a version that already exists, so running it over the whole library
 * after one adoption is cheap and invisible everywhere else.
 */
async function reconcile(
  hostedProjectsRoot: string,
  key: string,
  onProjectChanged: (bookDir: string) => void,
): Promise<number> {
  try {
    const result = await sweepFoundryExportTrays(
      hostedProjectsRoot,
      `adopting Foundry project "${key}"`,
      onProjectChanged,
    );
    return result.landed;
  } catch (err) {
    console.error(
      `[foundry-adopt] Foundry project "${key}" was adopted, but its export tray could not be `
      + `reconciled: ${(err as Error).message}. The book is in your library; any exports already `
      + 'in its tray will land the next time the trays are swept.');
    return 0;
  }
}
