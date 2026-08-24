/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Foundry's export trays, reconciled with BookForge's versions pages
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Owen, 2026-08-17: "if theres an exported doc in the foundry window, it should
 * show in the versions window too."
 *
 * That is a statement about FILES, and the live announcement is a statement
 * about EVENTS — Foundry calls `onExport` the instant something lands in a
 * project's `final/`, and BookForge files it (`recordFoundryExportLanding`,
 * electron/main.ts). An event happens once. The two came apart in two ways:
 *
 *  - Everything exported before the exports-as-versions pipeline existed. Those
 *    files are in their trays and always were; there was nothing on this side to
 *    catch them when they landed, and a landing is not replayed.
 *  - A missed live landing — an export made while the host was mid-crash, or one
 *    whose handler failed against a manifest that was momentarily unreadable.
 *    `onExport` fires once and never mentions it again.
 *
 * So this module treats the TRAY as the truth and the manifest as the record of
 * it, and brings the second up to the first. It is a RECONCILE and not a watch:
 * nothing here polls, and the live announcement remains how an export the user
 * just made appears within the second. This is only what runs when nobody was
 * listening.
 *
 * ── Why it is a module and not another function in main.ts ─────────────────
 *
 * The live landing lives in main.ts because it is wiring: it exists to be handed
 * to `mountFoundry` and it reads the library root, the window list and the
 * manifest mapping to decide WHICH BOOK an announcement is about. The reconcile
 * needs none of that host context — given a projects root it is pure file and
 * manifest work — and being separable is what lets `tools/test-foundry-landing.js`
 * run it against a real temp library, which a function inside the Electron entry
 * point could never be.
 *
 * What DOES belong to both lives here too (`fileFoundryExportAsVersion`,
 * `FOUNDRY_EXPORT_KINDS`), imported by main.ts rather than restated there. A
 * sweep carrying its own copy of the filing act would drift from the live path
 * the first time either was touched, and the drift would surface as versions
 * that nest correctly when exported and at top level when swept.
 *
 * `foundryExports` — the retired legacy list — is not read, not migrated and not
 * written. The files are the truth; that list was a second copy of it.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Dirent } from 'fs';

import * as manifestService from './manifest-service';
import { addFoundryOutputVariant, sameFoundryExportFile } from './library-actions';
import type { FoundryMintMetadata } from './manifest-types';

/**
 * THE KINDS THE VERSIONS PAGE HOLDS — the single list, read twice.
 *
 * The live announcement carries `ExportLanding.kind`, which names the conversion
 * Foundry was asked for; the sweep has no announcement and must read the same
 * fact off the file's extension. Those are two questions with one answer, and
 * they agree only because both consult this array instead of each spelling the
 * set out. Foundry names its output `<something>.<kind>` — the tray file for an
 * `epub` conversion is an `.epub` (job-queue.ts writes `path.basename(outputPath)`
 * as the landing's title and the kind alongside it) — which is what makes the
 * extension a faithful stand-in for the kind rather than a guess at it.
 */
export const FOUNDRY_EXPORT_KINDS: readonly string[] = ['epub', 'txt', 'pdf'];

/**
 * ONE FILING PER FILE AT A TIME — the lane a landing waits its turn in.
 *
 * ── The race this closes, which arrived with the auto-export ────────────────
 *
 * `addFoundryOutputVariant` decides whether a landing REPLACES an existing
 * version or adds a new one by reading the manifest, and it reads it OUTSIDE the
 * lock its later write takes. That was harmless while the callers were a live
 * announcement and a startup sweep, because no two of those ever described the
 * same file at the same moment.
 *
 * Owen's narrate-from-any-step ruling makes them do exactly that. A step press
 * with no export behind it asks Foundry to make one, and Foundry announces the
 * landing to `onExport` a beat before it answers the caller with it — so the
 * announcement's filing and the narration's filing are two calls about one file,
 * in flight together, both finding no existing version and both adding one. The
 * user would get two identical rows on the versions page and a narration reading
 * whichever won.
 *
 * ── Why a lane rather than a wider lock ────────────────────────────────────
 *
 * The thing that must not interleave is the read-decide-write about ONE FILE, so
 * that is what is serialized: two exports of two books still file at once, and a
 * sweep of a twelve-file tray is unaffected because it was already sequential.
 * A lock around the whole act would have made the sweep wait on the announcement
 * of a book it is not touching, for no fact it protects.
 *
 * A FAILED FILING DOES NOT POISON THE LANE. The next caller waits for the
 * previous one to SETTLE and then does its own work regardless of how that one
 * ended — a landing that could not be recorded is a reason to say so, never a
 * reason to refuse the next landing of the same file.
 */
const filingLanes = new Map<string, Promise<unknown>>();

/**
 * FILE ONE EXPORT AS A VERSION OF ONE BOOK — the act every door performs.
 *
 * Three callers reach this: the live announcement (`recordFoundryExportLanding`,
 * electron/main.ts), the narration that made its own export (the same file's
 * `registerFoundryExportLanding`), and the sweep below. By the time any of them
 * calls it the hard part is done — the book is known, the key is known, the kind
 * is admitted — and what is left is the part that must not be written three
 * times: read the parent from the mapping, hand the file to
 * `addFoundryOutputVariant`, and say what happened.
 *
 * `landedAt` is passed rather than taken; see `addFoundryOutputVariant`. The
 * live path says now (Foundry has just told us), the sweep says the file's mtime
 * (the file has been sitting there, and its mtime is the only witness left to
 * when it appeared).
 *
 * `stepId` is the same kind of fact and is passed for the same reason: the
 * announcement carries it, and a sweep — which reads a directory and not an
 * announcement — has nothing to pass and says so by passing nothing. See
 * `FoundryVariantSource.stepId`.
 *
 * DELIBERATELY DOES NOT BROADCAST. The live path tells the windows about the one
 * landing it just made; the sweep tells them once per project, after landing
 * however many files that project's tray held. Broadcasting per file would make
 * a sweep of a twelve-file tray redraw every open versions page twelve times, so
 * the choice belongs to the caller and is stated at both of them.
 *
 * ANSWERS WITH THE VERSION'S ID, or null when nothing was filed. It used to
 * answer whether — enough for the sweep, which only needs to know if it has
 * anything to announce — and the narration door needs the version itself, since
 * the file it is about to read is that row's file. Deriving it a second time
 * from (key, fileName) at the caller would be a second answer to "which row is
 * this landing", and the two would differ the first time either was touched.
 */
export function fileFoundryExportAsVersion(
  bookDir: string,
  projectKey: string,
  filePath: string,
  title: string,
  landedAt: string,
  stepId?: string,
  metadata?: FoundryMintMetadata,
): Promise<string | null> {
  /*
   * The lane is per (book, file), matched the way the re-export branch matches:
   * the key exactly, the name case-insensitively (`sameFoundryExportFile`).
   *
   * `|` joins them because it is the one character none of the three can hold —
   * a Windows path, a project folder name and a file name are all forbidden it —
   * so two different triples can never collapse into one lane the way they could
   * under a separator that is legal inside a name.
   */
  const lane = `${bookDir}|${projectKey}|${path.basename(filePath).toLowerCase()}`;
  const ahead = filingLanes.get(lane);
  const mine = (ahead === undefined ? Promise.resolve() : ahead.then(() => undefined, () => undefined))
    .then(() => fileOneFoundryExport(bookDir, projectKey, filePath, title, landedAt, stepId, metadata));
  filingLanes.set(lane, mine);
  // Cleared only by the call that is still the last one in the lane, so a
  // landing queued behind this one is never orphaned by this one finishing.
  void mine.then(() => undefined, () => undefined).then(() => {
    if (filingLanes.get(lane) === mine) filingLanes.delete(lane);
  });
  return mine;
}

async function fileOneFoundryExport(
  bookDir: string,
  projectKey: string,
  filePath: string,
  title: string,
  landedAt: string,
  stepId: string | undefined,
  /**
   * The mint's declaration of who the book is, when the landing carried one.
   * The sweep never passes it — a directory does not say who a book is any more
   * than it says which step cast it — so a swept file's version inherits the
   * project's metadata exactly as every landing did before the field existed.
   */
  metadata: FoundryMintMetadata | undefined,
): Promise<string | null> {
  // WHICH VERSION this export derives from, from the mapping the import wrote.
  // Read here rather than remembered: the user can re-import a different version
  // into the same Foundry project between two exports, and the parent is
  // whatever the mapping says at the moment the file is filed. Null when the
  // mapping records none — the row then renders at top level rather than under a
  // version this code picked for it.
  let parentVariantId: string | null = null;
  try {
    const ref = await manifestService.readFoundryProjectRef(bookDir);
    parentVariantId = ref?.sourceVariantId ?? null;
  } catch (err) {
    // The mapping is how this export got here at all, so failing to re-read it
    // is worth saying — but it costs the NESTING, not the version. The export is
    // still filed; it simply sits at top level.
    console.error(
      `[foundry-host] "${title}" is being filed for ${path.basename(bookDir)}, but which `
      + `version it derives from could not be read: ${(err as Error).message}. It lands as a `
      + 'top-level version.');
  }

  const landed = await addFoundryOutputVariant(
    path.basename(bookDir),
    filePath,
    {
      projectKey,
      fileName: path.basename(filePath),
      parentVariantId,
      landedAt,
      ...(stepId === undefined ? {} : { stepId }),
    },
    title,
    metadata,
  );
  if (!landed.success) {
    console.error(
      `[foundry-host] "${title}" could not be added to ${path.basename(bookDir)} as a `
      + `version: ${landed.error}. The file is where Foundry left it; nothing lists it.`);
    return null;
  }
  console.log(
    `[foundry-host] "${title}" ${landed.replaced ? 're-exported over' : 'landed as'} a `
    + `version of ${path.basename(bookDir)} (output/, variant ${landed.variantId}).`);
  // A success with no id is a shape `addFoundryOutputVariant` does not produce
  // and could only mean the two sides had come apart about what filing returns.
  if (landed.variantId === undefined) {
    throw new Error(
      `"${title}" was filed as a version of ${path.basename(bookDir)} without an id, so nothing `
      + 'can point at the row it made.');
  }
  return landed.variantId;
}

/**
 * WHAT FOUNDRY'S CATALOGUE SAYS ABOUT A PROJECT'S TRAY — file name to the step
 * it was cast from, as one lookup the sweep asks per file.
 *
 * Foundry's `project.json` carries a `final[]` row for every export it filed
 * (`ProjectFinal`: `file`, `kind`, `madeAt`, `stepId`), and `stepId` there is the
 * very value the live announcement carries — one `madeFrom` variable feeds both
 * on Foundry's side, so reading it here cannot disagree with the landing the
 * sweep is standing in for.
 *
 * A catalogue that cannot be read, or a row without a step, answers undefined
 * for that file — the defined "I do not know" of `FoundryVariantSource.stepId` —
 * and the file still lands. Missing entirely is silent (a project whose foundry
 * data has not synced has no tray either, and the tray's own ENOENT already
 * covers it); unreadable or unparseable is said once, because a catalogue that
 * is THERE and broken is worth a line.
 *
 * The match is `sameFoundryExportFile` — the same (case-insensitive) comparison
 * every other "is this that file" in the landing path uses.
 */
async function foundryCatalogueSteps(
  foundryProjectDir: string,
): Promise<(fileName: string) => string | undefined> {
  const cataloguePath = path.join(foundryProjectDir, 'project.json');
  let rows: { file: string; stepId: string }[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(cataloguePath, 'utf-8')) as {
      final?: { file?: unknown; stepId?: unknown }[];
    };
    rows = (Array.isArray(parsed.final) ? parsed.final : [])
      .filter((f): f is { file: string; stepId: string } =>
        typeof f === 'object' && f !== null
        && typeof f.file === 'string' && typeof f.stepId === 'string');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[foundry-host] Foundry's catalogue ${cataloguePath} could not be read `
        + `(${(err as Error).message}); exports swept from this tray land without the step they `
        + 'were cast from.');
    }
  }
  return (fileName) => rows.find((r) => sameFoundryExportFile(r.file, fileName))?.stepId;
}

/** What a sweep did, for the caller that logs it and for the tests that pin it. */
export interface FoundrySweepResult {
  /** Books whose tray was read at all — i.e. those with a `foundryProject` mapping. */
  booksVisited: number;
  /** Files that became versions in this sweep. Zero is the normal outcome. */
  landed: number;
  /** Things named and stepped over: an unlistable tray, a file that would not file. */
  refused: number;
}

/**
 * EVERY EXPORT SITTING IN A TRAY, ON THE VERSIONS PAGE.
 *
 * `projectsRoot` is `<library>/foundry/projects` and is PASSED IN rather than
 * derived: main.ts owns that derivation (`foundryProjectsDir()`, off a library
 * root the user can move mid-session), and a second copy of it here is how the
 * two would come to reconcile different folders. It is also what lets a test
 * point the sweep at a temp library.
 *
 * `onProjectChanged` is called once per project that gained anything, with that
 * book's project directory, at the moment its tray finishes. main.ts turns that
 * into the same `foundry-host:versions-changed` broadcast the live landing
 * sends. It is a callback and not a `broadcastToAllWindows` import because the
 * announcing is the host's business and importing the window list would drag
 * Electron into a module whose whole point is that it can be run without it.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * IT NEVER REPLACES. A file already carried by a variant's `foundrySource` is
 * SKIPPED — not handed to `addFoundryOutputVariant` to let its re-export branch
 * decide — because that branch overwrites the variant's bytes and re-stamps its
 * `landedAt`. Re-export is a thing the USER did; a sweep must be invisible to a
 * library that is already correct, and one that replaced would silently churn
 * every export on every startup and reorder the shelf's "newest export" behind
 * it. The skip predicate is `sameFoundryExportFile` — the very comparison that
 * branch matches on, imported rather than restated, so the two can never
 * disagree about what "already landed" means.
 *
 * IT NEVER INVENTS A MAPPING. Only books with a `foundryProject` are visited; a
 * tray under a key no book claims is left entirely alone, because guessing its
 * owner is the thing `recordFoundryImportLanding` exists to avoid.
 *
 * ── One bad file must not cost the rest ────────────────────────────────────
 *
 * Every refusal below names the thing it refused and CONTINUES: an unlistable
 * tray costs that book, an unreadable entry costs that file, and a key claimed
 * by two books costs those books. A sweep that aborted at the first problem
 * would leave a library half-reconciled and say so nowhere.
 */
export async function sweepFoundryExportTrays(
  projectsRoot: string,
  occasion: string,
  onProjectChanged: (bookDir: string) => void,
): Promise<FoundrySweepResult> {
  const result: FoundrySweepResult = { booksVisited: 0, landed: 0, refused: 0 };

  const listed = await manifestService.listProjects();
  if (!listed.success || !listed.projects) {
    // THROWN, not swallowed into a zero result. A library that cannot be listed
    // is not a library with nothing to reconcile, and the two must not look the
    // same to a caller. main.ts names it in one line and carries on booting.
    throw new Error(
      `the library could not be listed: ${listed.error || 'no reason given'}`);
  }

  /*
   * Grouped by key so a key claimed by two books is refused ONCE, by name, in
   * the same terms the live landing refuses it: a Foundry project belongs to
   * exactly one book, so two claims is a corrupted library rather than an
   * ambiguity to resolve, and picking one would file a version under whichever
   * book happened to sort first.
   *
   * The landed-export names are taken from the manifests THIS PASS already read
   * — `listProjects` returns whole manifests — so knowing what a book already
   * lists costs a map over an array in memory rather than a second read per
   * project.
   */
  const byKey = new Map<string, {
    dir: string;
    landed: { projectKey: string; fileName: string }[];
  }[]>();
  for (const manifest of listed.projects) {
    const key = manifest.foundryProject?.dir;
    if (key === undefined) continue;
    const claim = {
      dir: manifestService.getProjectPath(manifest.projectId),
      /*
       * BOTH SPELLINGS OF "THIS BOOK ALREADY HAS THAT FILE".
       *
       * `foundrySource` is an export on loan; `promotedFrom` is one the user
       * KEPT, moved into archive/ as one of the book's own. Reading only the
       * first is the bug Owen hit on 2026-08-19: promotion deletes
       * `foundrySource`, so the tray file stopped matching anything, and this
       * sweep landed it a second time into the position he had just cleared.
       *
       * A promoted file is the strongest possible "already landed" — the user
       * went out of their way to say it is theirs — so it belongs in this set
       * ahead of, not instead of, the on-loan case.
       */
      landed: manifestService.getVariants(manifest).variants
        .map((v) => v.foundrySource ?? v.promotedFrom)
        .filter((src): src is NonNullable<typeof src> => !!src)
        .map((src) => ({ projectKey: src.projectKey, fileName: src.fileName })),
    };
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, [claim]);
    else seen.push(claim);
  }

  for (const [key, books] of byKey) {
    if (books.length > 1) {
      console.error(
        `[foundry-host] Foundry project "${key}" is claimed by ${books.length} books — `
        + `${books.map((b) => path.basename(b.dir)).join(', ')}. Its export tray was NOT `
        + 'reconciled; a project belongs to exactly one book, so fix the duplicate mapping first.');
      result.refused++;
      continue;
    }
    const book = books[0]!;
    const tray = path.join(projectsRoot, key, 'final');

    let entries: Dirent[];
    /*
     * WHICH STEP EACH TRAY FILE WAS CAST FROM, read from Foundry's own catalogue.
     *
     * A directory does not say which point in a book's history each file came
     * from, and for a long time this sweep passed no step because of it — at the
     * documented cost of one re-export the first time somebody pressed Narrate
     * on the step behind a swept file. But Foundry's catalogue DOES say
     * (`ProjectFinal.stepId`, their project.json `final[]`), and the 2026-08-24
     * incident showed the cost is not always one re-export: a swept export that
     * cannot name its step can never match a step press, so the press goes to
     * the auto-export arm instead — which, handed a step from the wrong side of
     * a translation, cast and narrated the GERMAN of a book whose English was
     * sitting right there. So the catalogue is read, once per tray.
     *
     * An unreadable catalogue, or a file it does not list, still lands the file
     * WITHOUT a step — absence keeps meaning "I do not know", exactly as
     * `FoundryVariantSource.stepId` defines it — because the file's existence is
     * witnessed by the directory and its provenance merely unwitnessed.
     */
    const stepOfTrayFile = await foundryCatalogueSteps(path.join(projectsRoot, key));
    try {
      entries = await fs.readdir(tray, { withFileTypes: true });
    } catch (err) {
      // NO TRAY IS A REAL ANSWER, and the common one: a book opened in Foundry
      // but never exported from has no `final/`, and neither does a library
      // whose foundry data has not synced to this machine yet. Nothing to
      // reconcile is not a failure to reconcile — and a line for each would be a
      // line per book on every startup, which is how a log stops being read.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.error(
        `[foundry-host] ${path.basename(book.dir)} claims Foundry project "${key}", but its `
        + `export tray ${tray} could not be listed: ${(err as Error).message}. Any exports in it `
        + 'are not on the versions page.');
      result.refused++;
      continue;
    }
    result.booksVisited++;

    let landedHere = 0;
    for (const entry of entries) {
      // Directories and whatever else a tray holds are not exports. Silent: the
      // tray is Foundry's folder and its other contents are its business.
      if (!entry.isFile()) continue;
      // The extension IS the kind, read through the one list the live
      // announcement's admission check reads. Silent for the same reason.
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (!FOUNDRY_EXPORT_KINDS.includes(ext)) continue;
      // Already a version of this book, by the identity the landing path mints
      // and the re-export branch matches on: (projectKey, fileName) — the key
      // exactly, the file name case-insensitively.
      if (book.landed.some((l) =>
        l.projectKey === key && sameFoundryExportFile(l.fileName, entry.name))) continue;

      const abs = path.join(tray, entry.name);
      try {
        // MTIME, NOT NOW. The record says when the export appeared, and for a
        // file nobody announced that is the only witness left. A now() here
        // would re-date the whole library to whichever morning it was first
        // swept — and `landedAt` orders the shelf's "newest export", so every
        // book's Process button would follow the sweep instead of the user.
        const landedAt = (await fs.stat(abs)).mtime.toISOString();
        // THE TITLE IS THE FILE'S OWN NAME, which is exactly what Foundry puts
        // in `ExportLanding.title` (`path.basename(outputPath)`, job-queue.ts).
        // A swept row and an announced row are therefore named the same thing,
        // and the user cannot tell which door a version came through.
        //
        // The step comes from Foundry's catalogue, read above — undefined when
        // the catalogue does not know this file, which files the version exactly
        // as the pre-catalogue sweep always did.
        const stepId = stepOfTrayFile(entry.name);
        if (await fileFoundryExportAsVersion(book.dir, key, abs, entry.name, landedAt, stepId) !== null) {
          landedHere++;
        } else {
          result.refused++;
        }
      } catch (err) {
        console.error(
          `[foundry-host] ${abs} is an export of ${path.basename(book.dir)} that is not on its `
          + `versions page, and it could not be filed: ${(err as Error).message}. The rest of the `
          + 'tray is still being reconciled.');
        result.refused++;
      }
    }

    if (landedHere > 0) {
      result.landed += landedHere;
      console.log(
        `[foundry-host] Reconciled ${landedHere} export${landedHere === 1 ? '' : 's'} from `
        + `Foundry project "${key}" onto ${path.basename(book.dir)} (${occasion}).`);
      // Per PROJECT, not per file — see `fileFoundryExportAsVersion`.
      onProjectChanged(book.dir);
    }
  }

  return result;
}
