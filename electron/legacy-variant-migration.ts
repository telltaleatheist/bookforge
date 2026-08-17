/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The old library's books, on the new library's versions page
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Owen's old library is 385 projects deep and is being copied wholesale into the
 * new root. The versions page in the new world draws the VARIANTS REGISTRY —
 * `getVariants()`, which starts from `manifest.variants`, synthesizes `arch:`
 * ebook rows from `archive[]` for a project that has no real variants yet, and
 * folds in `outputs.audiobook`. A survey of the old manifests found only 66 of
 * 378 readable ones carrying variants at all, and plenty of the rest carry
 * neither an `archive[]` list nor an `outputs.audiobook` — so their versions page
 * is empty while their `archive/`, `source/` and `output/` folders are full.
 *
 * The FILES are the truth and the manifest is the record of it. This module
 * brings the second up to the first, one project at a time. It is the same shape
 * as `foundry-export-sweep.ts` and for the same reason: a reconcile rather than
 * a watch, and a module rather than a function in main.ts, so that
 * `tools/test-legacy-migration.js` can run it against a real temp library —
 * which nothing inside the Electron entry point could ever be.
 *
 * ── Three generations of project, and what each one is ──────────────────────
 *
 *  1. RECENT. `archive/` holds everything — "Title. Author. (Year).epub/.pdf/.m4b"
 *     plus the m4b's co-located sidecars and sometimes a `.prebak` copy.
 *  2. CHAIN-ERA. `archive/` plus `source/` (`X.working.epub`, `X.tts.epub` — the
 *     working chain's own files) plus `output/` (the finished m4b and its
 *     sidecars, cleaned/exported EPUBs).
 *  3. ANCIENT. Some have NO `archive/` at all: `source/exported.epub` is the only
 *     copy of the book text, and `output/` holds the m4b.
 *
 * A version is a file the user can open, narrate, promote, rename and delete.
 * That is what decides what registers here and what does not:
 *
 *  - A BOOK OR A NARRATION REGISTERS. `.epub`/`.pdf` become ebook variants,
 *    `.m4b`/`.m4a` become audiobook variants, in all three folders.
 *    `source/exported.epub` registers because for generation 3 it IS the book,
 *    and for the other two it is a real second copy the user can open and read.
 *  - A WORKING-CHAIN FILE DOES NOT. `<stem>.working.epub`, `<stem>.tts.epub` and
 *    the exploded `<stem>.working/` folder are the chain's internal state —
 *    shared/document/book-families.ts names them, and `tools/migrate-working-copies.js`
 *    is what turned the third into a folder. They are reported as clutter and
 *    left alone.
 *  - A SIDECAR IS NOT A VERSION OF ITS OWN; it travels with its m4b. The rule is
 *    `archive-migration.ts`'s `siblingFiles` — everything named `<m4b>.…`, which
 *    is exactly where `sidecarPathsFor()` writes and where `bookshelf-server`'s
 *    `boundSidecars()` reads. Nothing has to be recorded for that to keep
 *    working, which is why a minted audiobook variant carries no `vttPath` —
 *    the same reason `registerAudiobookOutput` deliberately CLEARS one.
 *  - A BACKUP IS NOT A VERSION. `.prebak` / `.preadremoval-bak` copies are
 *    reported as clutter.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * IT NEVER INVENTS A MANIFEST. A project whose manifest will not parse is named
 * and stepped over. The eight of those in the old library are a data question,
 * not something a sweep may answer by writing a fresh manifest over whatever is
 * there.
 *
 * IT NEVER READS A SYNCTHING CONFLICT COPY AS TRUTH. `manifest.sync-conflict-*.json`
 * and `manifest.json.bak*` are counted and reported so Owen can clear them; they
 * are never opened.
 *
 * IT NEVER GUESSES `outputs.audiobook`. That record is the shelf's playable
 * pointer — `addVariant` sets it for a project's FIRST audiobook, and
 * `studio.service` keys "completed" off it — so writing it is a statement about
 * which narration IS the book's. A project with two unregistered m4bs has no
 * such answer on disk. Both become versions, which is what the versions page is
 * for; the shelf pointer is reported and left unset.
 *
 * IT NEVER TOUCHES AN EXISTING `primaryVariantId`, and seeds a missing one by
 * `addVariant`'s own rule. It never writes `ttsVariantId` at all — the mark is
 * the user's, and the reasoning on {@link ProjectManifest.ttsVariantId} applies
 * to a migration exactly as it applies to an export landing.
 *
 * IT NEVER WRITES WHEN IT HAS NOTHING TO ADD, so a project that is already
 * correct comes out byte-identical — which is also what makes a second `--apply`
 * a no-op rather than a churn of `modifiedAt` across 385 books.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import type { Dirent } from 'fs';

import * as manifestService from './manifest-service';
import { sha256File } from './library-actions';
import type { ProjectManifest, ProjectVariant, VariantMetadata } from './manifest-types';

// ─────────────────────────────────────────────────────────────────────────────
// What a file is
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EXTENSION IS KIND, in all three folders — the same move
 * `sweepFoundryExportTrays` makes when it has no announcement to read the kind
 * off, and for the same reason: the extension is a faithful stand-in rather than
 * a guess at one.
 *
 * The audio list is deliberately NOT `library-actions`' `VARIANT_AUDIO_EXT`.
 * That one is the IMPORT list — mp3, wav, flac, everything ffmpeg will normalize
 * INTO an m4b — and it is right there because the user is handing the app a file
 * from outside. Inside a project the only audio that exists is what the pipeline
 * or an import already produced, and that is an `.m4b` (or the rare `.m4a`). A
 * `.wav` under `output/` is a render fragment, so admitting the import list here
 * would turn scratch into versions.
 */
const EBOOK_EXT: readonly string[] = ['.epub', '.pdf'];
const AUDIO_EXT: readonly string[] = ['.m4b', '.m4a'];

/** The folders a project keeps books in. Scanned TOP LEVEL ONLY — a chapter
 *  directory, a sentence cache and an exploded working copy are all folders, and
 *  none of them holds a version. */
const BOOK_FOLDERS: readonly string[] = ['archive', 'source', 'output'];

/**
 * A working chain's own files, by the names shared/document/book-families.ts
 * gives them: `<stem>.working.epub` is the copy the user edits, `<stem>.tts.epub`
 * the narration cut, `<stem>.working/` that same working copy after
 * tools/migrate-working-copies.js unpacked it into a folder.
 */
const CHAIN_FILE = /\.(working|tts)\.epub$/i;
const CHAIN_DIR = /\.working$/i;

/** `X.m4b.prebak`, `X.prebak.m4b`, `.preadremoval-bak` either way round — the
 *  copies made before a re-tag or an ad removal. Clutter, never a version. */
const BACKUP_NAME = /(^|\.)(prebak|preadremoval-bak)(\.|$)/i;

/** Manifest copies that are not the manifest: Syncthing's conflict files and
 *  hand-made `.bak`s. Counted, reported, NEVER opened. */
const STRAY_MANIFEST = /^manifest\.(sync-conflict-.*\.json|json\.bak.*)$/i;

/** The path comparison `getVariants` itself uses to decide two records name one
 *  file — slashes and case folded, a leading `./` dropped. Imported in spirit
 *  rather than in code because it is a three-line local there. */
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// The report — the deliverable, and what the tests pin
// ─────────────────────────────────────────────────────────────────────────────

/** A file that became — or, in a dry run, would become — a version. */
export interface MintedVariant {
  /** Project-relative, forward slashes: exactly what goes in the manifest. */
  relPath: string;
  kind: 'ebook' | 'audiobook';
  format: string;
  /** An m4b's co-located sidecars, project-relative. They travel by NAME, not by
   *  record; listed only so the report can say the transcript came with it. */
  sidecars: string[];
  /** The record itself, minted in full during the dry run — same uuid, same
   *  hash, same `addedAt` — so the report Owen reviews IS the thing `--apply`
   *  writes rather than a description of it. */
  variant: ProjectVariant;
}

/** A file that was looked at and left alone, and why. */
export interface SkippedFile {
  relPath: string;
  reason:
    | 'already-a-version'      // a variant already names this path
    | 'same-bytes'             // a variant already carries this content hash
    | 'chain-artifact'         // <stem>.working.epub, .tts.epub, .working/
    | 'sidecar'                // <m4b>.vtt / .sidecars.json / .cover.* — travels with its m4b
    | 'backup'                 // .prebak / .preadremoval-bak
    | 'not-a-book'             // an extension this module does not claim to know
    | 'folder';                // a directory that is not an exploded working copy
  /** Which variant, for an already-listed file; which m4b, for a sidecar. */
  detail?: string;
}

/** An absolute path found inside the manifest. */
export interface AbsolutePathFinding {
  /** Where it sits, e.g. `outputs.audiobook.path`, `variants[2].metadata.coverPath`. */
  field: string;
  value: string;
  /** Under the old library root, so its equivalent in the new one is computable. */
  underOldRoot: boolean;
  /** What it would become — project- or library-relative — or null where this
   *  module will not say (an unknown field, another project's folder, a path
   *  outside the old root entirely). */
  wouldBecome: string | null;
  /** The new-world file `wouldBecome` names was there. Only then is it rewritten. */
  targetExists: boolean;
  /** Rewritten by THIS run. False in a dry run and for every report-only finding. */
  fixed: boolean;
}

export interface ProjectVariantReport {
  projectId: string;
  outcome: 'unreadable' | 'clean' | 'reported-only' | 'migrated';
  /** Present when `outcome` is 'unreadable' — the reason, in the reader's words. */
  refusal?: string;
  minted: MintedVariant[];
  skipped: SkippedFile[];
  /** `manifest.sync-conflict-*.json`, `manifest.json.bak*`, `.prebak` copies. */
  clutter: string[];
  absolutes: AbsolutePathFinding[];
  /** The id seeded into an empty `primaryVariantId`, or null when left alone. */
  primarySeeded: string | null;
  /** Things a PERSON has to decide. Never acted on. */
  notes: string[];
  /** True when this run actually wrote the manifest. */
  written: boolean;
}

export interface LegacySweepTotals {
  visited: number;
  clean: number;
  migrated: number;
  reportedOnly: number;
  unreadable: number;
  /** Variants minted — or, in a dry run, that would be — summed over projects. */
  variants: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Absolute paths left over from the old library root
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE MANIFEST IS WALKED, NOT FIELD-LISTED.
 *
 * The fields the live code resolves as paths number thirty-one, spread over
 * seven nesting levels: `outputs.audiobook.{path,vttPath,sentencePairsPath}`,
 * the same three under every `outputs.bilingualAudiobooks[pair]`,
 * `outputs.generatedEpub.path`, the legacy `outputs.{epub,ttsEpub}.path` and
 * their per-family twins, `…epub.appliedPasses[].diff`,
 * `…epub.ledger[].{dir,snapshot,receipt}` and the `pass.diff` nested inside each
 * ledger entry, `families[].source.path`, `variants[].{path,vttPath}`,
 * `archive[].path`, `audiobookAnalyses[*].reportPath`,
 * `pipeline.cleanup.outputPath`, and the three `coverPath`s.
 *
 * A hand-written list of those is a list that was already wrong once —
 * `NFC_PATH_KEYS` in manifest-service.ts covers seven of them and misses `diff`,
 * `dir`, `snapshot`, `receipt`, `reportPath` and `outputPath` — and would be
 * wrong again for a manifest generation nobody here remembers. So every string
 * in the file is examined and the ones that ARE absolute paths are reported,
 * whatever field they turned up in. Missing one is the failure that matters;
 * naming one too many costs a line in a report Owen reads.
 *
 * REWRITING is the opposite and is deliberately narrow: it happens only for keys
 * whose base this module can STATE, and only when the file it would name is
 * provably there.
 */
const PROJECT_RELATIVE_KEYS = new Set([
  // Resolved by joining onto the project directory — `variant:list`'s
  // `resolveRel`, `manifest-service`'s private `toAbs`, `archive-migration`'s
  // `relToAbs`, `audiobook-analysis-protocol`'s `resolveWithinProject`.
  'path', 'vttPath', 'sentencePairsPath', 'reportPath', 'outputPath',
  'diff', 'dir', 'snapshot', 'receipt',
]);

/**
 * `coverPath` is the one measured from the LIBRARY, not the project:
 * `saveImageToMedia` returns `media/<hash>.jpg` and every reader joins it onto
 * `getLibraryBasePath()` — library-actions' m4b tagging, bookshelf-server's
 * cover route, the browse grid. Treating it like the others would rewrite it to
 * a path under the project that has never existed.
 */
const LIBRARY_RELATIVE_KEYS = new Set(['coverPath']);

/**
 * `foundryExports[].path` is spelled `path` and is nonetheless LIBRARY-relative
 * (`foundry/projects/<key>/final/<file>`), so the key alone would classify it
 * wrongly. It is retired and its writer refuses an absolute value outright, so
 * one should never turn up — but "should never" is not a reason to let the one
 * exception be silently mis-rebased if it does.
 */
const LIBRARY_RELATIVE_TRAILS = [/^foundryExports\[\d+\]$/];

/** Windows drive-letter, UNC, or POSIX-absolute — each with a separator, so a
 *  bare "C:" or an ordinary sentence is never mistaken for a path. */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/(?!\/))[^\r\n]*$/;

/** `value` with `root` stripped, or null when it does not lie under it.
 *  Boundary-aware: `E:/Shared/BookForgeOld` is not under `E:/Shared/BookForge`. */
function underRoot(value: string, root: string): string | null {
  const v = value.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!v.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
  return v.slice(r.length + 1);
}

/** Walk every string in a manifest, handing each one its dotted field trail. */
function walkStrings(
  node: unknown,
  trail: string,
  visit: (holder: Record<string, unknown>, key: string, trail: string, value: string) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkStrings(item, `${trail}[${i}]`, visit));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const field = trail ? `${trail}.${key}` : key;
    if (value && typeof value === 'object') { walkStrings(value, field, visit); continue; }
    if (typeof value === 'string') visit(obj, key, field, value);
  }
}

/**
 * Every absolute path in the manifest, with the rewrite this module is willing
 * to make for it — and `null` wherever it is not willing to make one.
 *
 * PURE: nothing is mutated here. The rewrite is `applyAbsolutePathFixes`, which
 * has to run twice against two different reads of the same file — see the note
 * where it is called.
 *
 * A path under the old root whose file did NOT come across is left exactly as it
 * is. That is deliberate: a manifest naming a file on `E:\Shared\BookForge` is at
 * least a truthful record of where that file was, while one naming a relative
 * path with nothing on it is a lie the app reports as a missing version.
 */
export async function scanAbsolutePaths(
  manifest: ProjectManifest,
  projectDir: string,
  libraryRoot: string,
  oldLibraryRoot: string,
): Promise<AbsolutePathFinding[]> {
  const projectId = path.basename(projectDir);
  const mine = new RegExp(
    `^projects/${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'i');

  const found: AbsolutePathFinding[] = [];
  const pending: { finding: AbsolutePathFinding; target: string }[] = [];

  walkStrings(manifest, '', (_holder, key, field, value) => {
    if (!ABSOLUTE_PATH.test(value)) return;
    const rest = underRoot(value, oldLibraryRoot);
    const finding: AbsolutePathFinding = {
      field, value, underOldRoot: rest !== null,
      wouldBecome: null, targetExists: false, fixed: false,
    };
    found.push(finding);
    if (rest === null) return;

    // WHICH BASE this field is measured from. An unknown key stays report-only:
    // a rewrite has to know what the remainder is relative TO, and guessing is
    // how a library-relative cover path ends up pointing inside a project.
    const holderTrail = field.slice(0, field.length - key.length - 1);
    const libraryRelative = LIBRARY_RELATIVE_KEYS.has(key)
      || LIBRARY_RELATIVE_TRAILS.some((t) => t.test(holderTrail));
    if (libraryRelative) {
      finding.wouldBecome = rest;
      pending.push({ finding, target: path.join(libraryRoot, ...rest.split('/')) });
      return;
    }
    if (!PROJECT_RELATIVE_KEYS.has(key)) return;
    // Only a path inside THIS project can become project-relative. One naming a
    // different project's folder is a cross-project reference, and is reported
    // rather than bent into a path this project does not own.
    if (!mine.test(rest)) return;
    const rel = rest.replace(mine, '');
    finding.wouldBecome = rel;
    pending.push({ finding, target: path.join(projectDir, ...rel.split('/')) });
  });

  for (const { finding, target } of pending) {
    try { finding.targetExists = (await fs.stat(target)).isFile(); } catch { /* not there */ }
  }
  return found;
}

/**
 * The rewrite half, applied to a manifest in memory.
 *
 * It decides NOTHING: it puts back the answers `scanAbsolutePaths` already
 * reached and verified, matching on the field trail AND the value so a string
 * that changed under it is left alone. It does not set `fixed` — that flag means
 * "this run wrote it to disk", and only the caller that got a successful save
 * back can say so.
 */
export function applyAbsolutePathFixes(
  manifest: ProjectManifest,
  findings: AbsolutePathFinding[],
): void {
  const fixable = findings.filter((f) => f.wouldBecome !== null && f.targetExists);
  if (fixable.length === 0) return;
  walkStrings(manifest, '', (holder, key, field, value) => {
    const fix = fixable.find((f) => f.field === field && f.value === value);
    if (fix) holder[key] = fix.wouldBecome;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// One project
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  relPath: string;
  absPath: string;
  kind: 'ebook' | 'audiobook';
  format: string;
  /** Set for files whose own name says nothing about the book — see below. */
  descriptor?: string;
  sidecars: string[];
  mtime: string;
}

/**
 * Read one book folder and sort what is in it into candidates, skips and clutter.
 *
 * `descriptor` is the file's own basename for anything OUTSIDE `archive/`, and
 * absent for anything in it. That mirrors the two doors this module stands
 * between. `addVariant` gives an archive copy no descriptor because it RENAMED
 * the file to "Title. Author. (Year).epub" on the way in — the name already says
 * which version it is. `addFoundryOutputVariant` puts the incoming file's own
 * name in `descriptor` because its copy in `output/` was renamed too, and the
 * original name is the only thing telling one row from another.
 * `source/exported.epub`, `output/cleaned.epub` and an `output/` m4b are exactly
 * that case: without the descriptor the versions page shows three rows all
 * called "Title", and the user cannot tell which is which.
 */
async function readBookFolder(
  projectDir: string,
  folder: string,
  report: ProjectVariantReport,
): Promise<Candidate[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(projectDir, folder), { withFileTypes: true });
  } catch (err) {
    // A MISSING FOLDER IS THE ORDINARY STATE, not a failure: generation 1 has no
    // `source/`, generation 3 has no `archive/`. Anything else is worth a line.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    report.notes.push(`${folder}/ could not be listed: ${(err as Error).message}`);
    return [];
  }

  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  /* The m4b/m4a basenames actually present, so `<m4b>.…` is recognized as a
   * sidecar of a file that is really HERE rather than of a name that merely
   * looks like one. Same predicate as archive-migration's `siblingFiles`. */
  const audioBases = names.filter((n) => AUDIO_EXT.includes(path.extname(n).toLowerCase()));
  const sidecarOwner = (name: string): string | undefined =>
    audioBases.find((base) => name !== base && name.startsWith(base + '.'));

  const candidates: Candidate[] = [];
  for (const entry of entries) {
    const rel = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (CHAIN_DIR.test(entry.name)) {
        report.skipped.push({ relPath: rel, reason: 'chain-artifact', detail: 'unpacked working copy' });
      } else {
        report.skipped.push({ relPath: rel, reason: 'folder' });
      }
      continue;
    }
    if (!entry.isFile()) continue;

    if (STRAY_MANIFEST.test(entry.name)) { report.clutter.push(rel); continue; }
    if (BACKUP_NAME.test(entry.name)) {
      report.skipped.push({ relPath: rel, reason: 'backup' });
      report.clutter.push(rel);
      continue;
    }
    if (CHAIN_FILE.test(entry.name)) {
      report.skipped.push({ relPath: rel, reason: 'chain-artifact' });
      continue;
    }
    const owner = sidecarOwner(entry.name);
    if (owner !== undefined) {
      report.skipped.push({ relPath: rel, reason: 'sidecar', detail: `${folder}/${owner}` });
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    const kind = EBOOK_EXT.includes(ext) ? 'ebook' : AUDIO_EXT.includes(ext) ? 'audiobook' : null;
    if (kind === null) {
      // REPORTED, NEVER GUESSED AT. `source/cover.png` lands here, and so does
      // anything a generation this module has not met left behind.
      report.skipped.push({ relPath: rel, reason: 'not-a-book' });
      continue;
    }

    const abs = path.join(projectDir, folder, entry.name);
    candidates.push({
      relPath: rel,
      absPath: abs,
      kind,
      format: ext.slice(1),
      descriptor: folder === 'archive' ? undefined : entry.name,
      // The files that TRAVEL with this m4b — `siblingFiles`' predicate, minus
      // the backups. `X.m4b.prebak` matches the same `X.m4b.` prefix a sidecar
      // does and is not one: it is a whole second copy of the audiobook from
      // before a re-tag, and calling it a sidecar would have the report claim
      // the transcript set includes a 300 MB file.
      sidecars: kind === 'audiobook'
        ? names.filter((n) =>
            n !== entry.name && n.startsWith(entry.name + '.') && !BACKUP_NAME.test(n))
            .map((n) => `${folder}/${n}`)
        : [],
      // THE FILE'S MTIME, NOT NOW — `sweepFoundryExportTrays` states the reason
      // at length. `addedAt` orders the versions page, and a now() here would
      // re-date 385 books to whichever morning the migration was run.
      mtime: (await fs.stat(abs)).mtime.toISOString(),
    });
  }
  return candidates;
}

/**
 * Register everything real in one project, or say what it would register.
 *
 * `apply: false` — the default at every door — opens nothing for writing. The
 * records it reports are the records `apply: true` writes: the same uuid is
 * minted, the same hash taken, the same mtime read. That is what makes the dry
 * run a review of the migration rather than a description of it.
 */
export async function migrateProjectVariants(
  projectDir: string,
  opts: { apply: boolean; libraryRoot: string; oldLibraryRoot: string },
): Promise<ProjectVariantReport> {
  const projectId = path.basename(projectDir);
  const report: ProjectVariantReport = {
    projectId, outcome: 'clean', minted: [], skipped: [], clutter: [],
    absolutes: [], primarySeeded: null, notes: [], written: false,
  };

  // The manifest is addressed by projectId through the library base path, so a
  // directory that is not under THIS library would silently be read as some
  // other project of the same name. `registerAudiobookOutput` refuses the same
  // mismatch for the same reason; this is that guard, said here.
  if (path.resolve(manifestService.getProjectPath(projectId)) !== path.resolve(projectDir)) {
    report.outcome = 'unreadable';
    report.refusal = `${projectDir} is not under the library this sweep was pointed at `
      + `(${manifestService.getProjectsPath()}).`;
    return report;
  }

  // Stray manifests FIRST, before anything is read: that a project has a
  // Syncthing conflict copy is worth knowing even when the migration then
  // refuses the project outright.
  try {
    for (const name of await fs.readdir(projectDir)) {
      if (STRAY_MANIFEST.test(name)) report.clutter.push(name);
    }
  } catch (err) {
    report.outcome = 'unreadable';
    report.refusal = `${projectDir} could not be listed: ${(err as Error).message}`;
    return report;
  }

  const got = await manifestService.getManifest(projectId);
  if (!got.success || !got.manifest) {
    // NAMED AND STEPPED OVER. `getManifest` hands back the JSON parser's own
    // message, which says which byte it gave up at — the thing a person fixing
    // eight of these needs. Nothing is written, and no manifest is invented.
    report.outcome = 'unreadable';
    report.refusal = got.error || 'the manifest could not be read';
    return report;
  }
  const manifest = got.manifest;

  /*
   * THE PATHS ARE REPAIRED BEFORE ANYTHING IS PLANNED, on this in-memory copy,
   * in a dry run exactly as in an apply.
   *
   * A record naming `E:\Shared\BookForge\projects\X\output\book.m4b` names a
   * file that IS here, one folder down. Repointing it is what turns "an m4b
   * nothing lists" into "an m4b `outputs.audiobook` already lists" — and if the
   * plan were made against the unrepaired copy, `getVariants` would fold that
   * record at its absolute path, the file would not match it, and this would
   * mint a SECOND row for the same m4b: two versions of one narration, one of
   * them pointing at a drive that is not there.
   *
   * Nothing is saved by this. The write is `modifyManifest` below, and a dry run
   * simply never reaches it — which is the whole reason the repair happens on a
   * copy rather than being deferred to the write.
   */
  report.absolutes = await scanAbsolutePaths(
    manifest, projectDir, opts.libraryRoot, opts.oldLibraryRoot);
  applyAbsolutePathFixes(manifest, report.absolutes);
  const fixable = report.absolutes.filter((a) => a.wouldBecome !== null && a.targetExists);

  const candidates: Candidate[] = [];
  for (const folder of BOOK_FOLDERS) {
    candidates.push(...await readBookFolder(projectDir, folder, report));
  }

  /*
   * WHAT THE VERSIONS PAGE ALREADY SHOWS — the app's own answer, not a reading
   * of `manifest.variants`. `getVariants` synthesizes `arch:` rows from
   * `archive[]` for a project with no real variants and folds `outputs.audiobook`
   * in, so a file it already covers is one the user can already SEE, and minting
   * a second row for it would double every generation-1 project.
   */
  const current = manifestService.getVariants(manifest);
  const byHash = new Map<string, string>();
  for (const v of current.variants) if (v.sourceFileHash) byHash.set(v.sourceFileHash, v.path);

  const meta = manifest.metadata;
  const audioMeta = manifestService.effectiveAudiobookMetadata(meta);

  const minted: MintedVariant[] = [];
  for (const c of candidates) {
    const already = current.variants.find((v) => norm(v.path) === norm(c.relPath));
    if (already) {
      report.skipped.push({ relPath: c.relPath, reason: 'already-a-version', detail: already.id });
      continue;
    }
    const hash = await sha256File(c.absPath);
    const twin = byHash.get(hash);
    if (twin !== undefined) {
      // `addVariant` refuses a file whose bytes are already a version of this
      // book — "That file is already a version of this book." The same refusal,
      // reported rather than thrown: two copies of one file under two names is a
      // duplicate for the user to resolve, not two editions.
      report.skipped.push({ relPath: c.relPath, reason: 'same-bytes', detail: twin });
      continue;
    }

    /*
     * METADATA COMES FROM THE MANIFEST, exactly as `addFoundryOutputVariant`
     * takes it: "a version of a book we ALREADY know, so the project's own
     * metadata names it". The audiobook branch reads it through
     * `effectiveAudiobookMetadata` for the reason `addVariant`'s audio branch
     * does — `metadata.audiobook` holds the per-format overrides that were
     * embedded in the m4b's own tags, and a row ignoring them would disagree
     * with the file it plays.
     */
    const metadata: VariantMetadata = c.kind === 'audiobook'
      ? {
          title: audioMeta.title, author: audioMeta.author, year: audioMeta.year,
          language: meta.language, narrator: audioMeta.narrator, series: audioMeta.series,
          seriesPosition: audioMeta.seriesPosition, description: audioMeta.description,
          coverPath: audioMeta.coverPath,
        }
      : {
          title: meta.title, author: meta.author, year: meta.year,
          language: meta.language, coverPath: meta.coverPath,
        };

    const variant: ProjectVariant = {
      id: crypto.randomUUID(),
      kind: c.kind,
      format: c.format,
      path: c.relPath,
      ...(c.descriptor === undefined ? {} : { descriptor: c.descriptor }),
      metadata,
      sourceFileHash: hash,
      addedAt: c.mtime,
      /*
       * THE APP'S OWN RESOLUTION, not a default and not a guess. `getVariants`
       * answers "was this professionally read?" for the `outputs.audiobook` row
       * with `ab.professionallyRead ?? (manifest.source?.type === 'audiobook')`,
       * and `archive-migration.ts` selects professional uploads by that same
       * test. Leaving the field off instead would hand every migrated m4b to
       * `v.professionallyRead ?? true` — the branch written for `variant:add`,
       * where a human uploaded the file — and file three hundred TTS renders
       * under "professionally narrated". That is precisely the mislabelling the
       * comment on `getNarrationFlags` was written about.
       */
      ...(c.kind === 'audiobook'
        ? { professionallyRead: manifest.source?.type === 'audiobook' }
        : {}),
    };
    byHash.set(hash, c.relPath);
    minted.push({
      relPath: c.relPath, kind: c.kind, format: c.format, sidecars: c.sidecars, variant,
    });
  }
  report.minted = minted;

  // THE SHELF POINTER IS NOT THIS MODULE'S TO SET — see the header. Reported so
  // that a person can.
  const audiobooksNow = [
    ...current.variants.filter((v) => v.kind === 'audiobook'),
    ...minted.filter((m) => m.kind === 'audiobook'),
  ];
  if (!manifest.outputs?.audiobook?.path && audiobooksNow.length > 0) {
    report.notes.push(
      `${audiobooksNow.length} audiobook${audiobooksNow.length === 1 ? '' : 's'} and no `
      + 'outputs.audiobook — the versions page lists them; the shelf\'s playable pointer is '
      + 'left unset, because which narration IS the book\'s is not on disk to read.');
  }

  if (minted.length === 0 && fixable.length === 0) {
    // NOTHING TO WRITE. Whether that is worth a paragraph in the report is a
    // different question from whether it is worth a manifest write, and the two
    // are separated here so a clean library prints short.
    const hasFindings = report.clutter.length > 0
      || report.notes.length > 0
      || report.absolutes.length > 0
      || report.skipped.some((s) => s.reason === 'not-a-book' || s.reason === 'chain-artifact');
    report.outcome = hasFindings ? 'reported-only' : 'clean';
    return report;
  }

  report.outcome = 'migrated';
  if (!opts.apply) return report;

  const saved = await manifestService.modifyManifest(projectId, (mf) => {
    // The SAME repair, on the copy `modifyManifest` re-read under the project
    // lock — the one that is actually about to be written. It has to happen
    // again here (the copy planned against is a different read, and edits to it
    // are thrown away) and it has to happen FIRST, in the same order as above,
    // so `getVariants` folds the repaired records and this appends to the set
    // the plan was made against rather than a differently-derived one.
    applyAbsolutePathFixes(mf, report.absolutes);
    const cur = manifestService.getVariants(mf);
    /*
     * `mf.variants = cur.variants` is what every mutation in library-actions.ts
     * opens with, and it is load-bearing: it PERSISTS the rows `getVariants` was
     * synthesizing from `archive[]` and `outputs.audiobook`, so the project stops
     * deriving its versions on every read and starts holding them. Doing it here
     * too is what makes a second run see exactly the set this one did.
     */
    mf.variants = [...cur.variants, ...minted.map((m) => m.variant)];
    if (!mf.primaryVariantId) {
      /*
       * `addVariant`'s rule — `cur.primaryVariantId ?? <the new one>` — with the
       * fallback taken from `getVariants` over the FINISHED list rather than
       * from whichever row was minted first. Same stated precedence ("prefer the
       * original ebook, else the first ebook, else the first variant"), applied
       * to everything the project now has: `minted[0]` would make a project
       * whose folder happened to list the m4b first call its audiobook the
       * book's identity, and the primary IS the book's identity.
       */
      const seeded = cur.primaryVariantId ?? manifestService.getVariants(mf).primaryVariantId;
      if (seeded !== undefined) { mf.primaryVariantId = seeded; report.primarySeeded = seeded; }
    }
  });
  if (!saved?.success) {
    report.outcome = 'unreadable';
    report.refusal = `the manifest could not be written: ${saved?.error || 'no reason given'}`;
    return report;
  }
  // `fixed` means "this run wrote it", so it is stamped only now — after the
  // save came back successful, and never in a dry run.
  for (const a of fixable) a.fixed = true;
  report.written = true;
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// The library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every project under a library root, in name order.
 *
 * `listProjects` is deliberately NOT used: it parses every manifest and silently
 * drops the ones that will not parse, and the eight unreadable manifests are
 * among the things this sweep exists to NAME. The folder listing is the truth
 * about which projects there are; whether each has a readable manifest is this
 * sweep's finding, not its filter.
 */
export async function listProjectDirs(libraryRoot: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(libraryRoot, 'projects'), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(libraryRoot, 'projects', e.name))
    .sort();
}

/**
 * The sweep: every project, reported, and — only under `apply` — written.
 *
 * `onProject` is called with each report as it finishes, so the caller can print
 * a running log rather than hold 385 reports and print them at the end. A
 * callback for the reason `sweepFoundryExportTrays` takes one: the printing is
 * the tool's business, and a module that did its own could not be tested against
 * its own return value.
 *
 * ONE BAD PROJECT MUST NOT COST THE REST. tools/migrate-working-copies.js stops
 * at the first refusal, and is right to: it MOVES a book's only copy, so a
 * systematic fault would otherwise be discovered forty-three times. This only
 * ever APPENDS records, so a project that cannot be read is a line in the report
 * and the sweep goes on — the whole point being one complete picture of 385
 * projects rather than the first problem in them.
 */
export async function sweepLegacyVariants(
  libraryRoot: string,
  opts: {
    apply: boolean;
    oldLibraryRoot: string;
    /**
     * ONE project, by id — a real narrowing of the sweep and not a filter on its
     * printing. The two are not the same thing under `--apply`: a run that swept
     * 385 projects while showing one would have written 384 manifests nobody
     * looked at, which is the opposite of what asking for one project means.
     */
    only?: string;
    onProject?: (report: ProjectVariantReport) => void;
  },
): Promise<{ totals: LegacySweepTotals; reports: ProjectVariantReport[] }> {
  manifestService.setLibraryBasePath(libraryRoot);

  const dirs = (await listProjectDirs(libraryRoot))
    .filter((d) => opts.only === undefined || path.basename(d) === opts.only);

  const totals: LegacySweepTotals = {
    visited: 0, clean: 0, migrated: 0, reportedOnly: 0, unreadable: 0, variants: 0,
  };
  const reports: ProjectVariantReport[] = [];

  for (const projectDir of dirs) {
    let report: ProjectVariantReport;
    try {
      report = await migrateProjectVariants(projectDir, {
        apply: opts.apply, libraryRoot, oldLibraryRoot: opts.oldLibraryRoot,
      });
    } catch (err) {
      report = {
        projectId: path.basename(projectDir), outcome: 'unreadable',
        refusal: (err as Error).message, minted: [], skipped: [], clutter: [],
        absolutes: [], primarySeeded: null, notes: [], written: false,
      };
    }
    totals.visited++;
    totals.variants += report.minted.length;
    if (report.outcome === 'clean') totals.clean++;
    else if (report.outcome === 'migrated') totals.migrated++;
    else if (report.outcome === 'reported-only') totals.reportedOnly++;
    else totals.unreadable++;
    reports.push(report);
    opts.onProject?.(report);
  }

  return { totals, reports };
}
