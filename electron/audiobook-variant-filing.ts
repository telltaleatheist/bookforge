/**
 * A SECOND AUDIOBOOK OF THE SAME BOOK — where it is filed, and what it is called.
 *
 * ── The thing this exists to stop ───────────────────────────────────────────
 *
 * Every assembly in this app funnelled into ONE slot. `registerAudiobookOutput`
 * overwrites `manifest.outputs.audiobook`, and the promotion that preceded it
 * used to DELETE every .m4b, .vtt and .mp4 in the project's output folder before
 * moving the new files in. (The sweep is gone as of 2026-09-03 — no promotion
 * deletes or replaces a file any more, and a taken name gets a ` (2)` suffix; see
 * electron/output-naming.ts. The RECORD-level problem below is what this module
 * still answers.) That was right for the run it was written for: a narration
 * assembles the sentences it just rendered, and the audiobook it replaces was
 * made from sentences that no longer exist.
 *
 * It is wrong when the run rendered nothing. Converting a project's cached
 * sentences through a different RVC voice makes an ALTERNATIVE to the audiobook
 * the book already has — both are readings of the same rendered sentences — and
 * the old behaviour would spend forty minutes of GPU producing the alternative
 * and delete the original on the way to filing it. Owen's ruling (2026-08-26):
 * that run produces a NEW version, visible in the versions menu and deletable
 * there.
 *
 * ── The id is the VOICE, and that is the whole design ───────────────────────
 *
 * `rvc:<voiceId>`, following the `bilingual:<pair>` precedent already in
 * `getVariants`. A stable, derived id means RE-RUNNING THE SAME VOICE UPDATES
 * THAT VERSION — one file overwritten, one record refreshed — while a different
 * voice mints a separate one beside it. A UUID (what `variant:add` uses for an
 * imported file) would be right for files the user hands us, which are unrelated
 * to each other; it is wrong here, where running the same conversion twice would
 * accumulate a copy per attempt and the versions list would fill with takes.
 *
 * ── Why the file lives in output/ with the rest ─────────────────────────────
 *
 * Because it is assembled output, and "Delete output" is meant to reach it. A
 * variant under `output/` is dropped from the manifest by
 * `forgetOutputFolderRecords` when the user empties that folder — which is the
 * correct behaviour for a record whose file that gesture just deleted, and the
 * same fate the base audiobook meets. `archive/` is where files the USER gave us
 * live and is immutable; a render this app made does not belong there unless the
 * user promotes it.
 */

import * as path from 'path';
import * as fs from 'fs';

import * as manifestService from './manifest-service';
import { getRvcVoiceById } from './rvc-models';
import type { ProjectVariant } from './manifest-types';

/** The variant id an RVC re-render of this project's sentences is filed under. */
export function rvcVariantId(voiceId: string): string {
  return `rvc:${voiceId}`;
}

/**
 * Characters Windows will not put in a file name, replaced — the same rule the
 * assembler's own rename applies, so a voice label with a colon in it cannot
 * produce a path that fails to open on one platform and works on another.
 */
function safeFileNamePart(text: string): string {
  return text.replace(/[<>:"/\\|?*]/g, '_').trim();
}

/**
 * WHAT THE SECOND AUDIOBOOK'S FILE IS CALLED — the book's own name with the
 * voice after it.
 *
 * Derived from the base name rather than invented, so the two versions sort
 * beside each other in a folder listing and a person looking at the disk can see
 * at a glance which book they are two readings of. The voice is what tells them
 * apart, which is the same fact the variant id carries.
 *
 * @param baseFilename the run's `metadata.outputFilename`, with or without .m4b
 */
export function rvcVariantOutputFilename(baseFilename: string, voiceLabel: string): string {
  const stem = baseFilename.replace(/\.m4b$/i, '');
  return `${safeFileNamePart(stem)} - ${safeFileNamePart(voiceLabel)}.m4b`;
}

/**
 * A variant's cover, in the shape a manifest stores: relative to the LIBRARY
 * root, forward slashes, e.g. `media/cover_ab12.png`.
 *
 * Null for no cover and for a cover outside the library — the second is not a
 * failure worth stopping an assembly over, but recording an absolute path from
 * this machine would make the record wrong the moment the library is opened on
 * another one, which is worse than a row with no thumbnail.
 */
function libraryRelativeCover(absoluteCover: string | undefined): string | null {
  if (!absoluteCover) return null;
  const base = manifestService.getLibraryBasePath();
  const rel = path.relative(base, absoluteCover);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** What one filing needs to know, resolved once before the assembly runs. */
export interface RvcVariantFiling {
  readonly voiceId: string;
  /** The voice's display name — the narrator tag, the descriptor, the filename. */
  readonly voiceLabel: string;
  readonly variantId: string;
  /** The M4B's basename, voice included. */
  readonly outputFilename: string;
}

/**
 * Resolve the filing, or REFUSE BY NAME.
 *
 * The two refusals are both "this run cannot say which version it is making",
 * and neither is survivable by guessing: an unnamed second audiobook would be
 * filed under an id nothing can tell from the next one, and a run with no base
 * filename has no name to derive one from. Both are raised BEFORE the assembly
 * starts, because the alternative is discovering it after the encode.
 */
export function resolveRvcVariantFiling(
  rvcVoiceId: string | undefined,
  baseFilename: string | undefined,
): RvcVariantFiling {
  if (!rvcVoiceId) {
    throw new Error(
      'This run is meant to file a new version of the audiobook, but it does not say which '
      + 'voice-conversion voice it was made with — and the voice is what tells the versions '
      + 'apart. Nothing was assembled.');
  }
  const voice = getRvcVoiceById(rvcVoiceId);
  if (!voice) {
    throw new Error(
      `The voice-conversion voice "${rvcVoiceId}" is not installed on this machine, so the new `
      + 'version of the audiobook could not be named after it. Install it under Settings → '
      + 'Add-ons, or start the run again with a voice this machine has.');
  }
  if (!baseFilename) {
    throw new Error(
      `This book has no audiobook filename recorded, so the ${voice.label} version could not be `
      + 'given one of its own. Set the audiobook filename on the book\'s page and try again.');
  }
  return {
    voiceId: rvcVoiceId,
    voiceLabel: voice.label,
    variantId: rvcVariantId(rvcVoiceId),
    outputFilename: rvcVariantOutputFilename(baseFilename, voice.label),
  };
}

/**
 * Record the finished file as a manifest variant, replacing this voice's
 * previous record if it has one.
 *
 * ── Modelled on `addVariant`, minus the parts that are about IMPORTING ──────
 *
 * `library-actions.ts`'s `addVariant` copies a file the user chose into the
 * project, hashes it to refuse a duplicate, and mints a UUID. None of that
 * applies: this file was made HERE and is already where it belongs, the id is
 * derived so a re-run is an update rather than a duplicate, and a
 * `sourceFileHash` would be the hash of a file that changes every time the same
 * conversion is run — which would make the dedup guard refuse the SECOND run of
 * one voice and allow the first run of a coincidentally identical one. The
 * persist idiom is the one every writer in this codebase uses.
 *
 * ── professionallyRead is set EXPLICITLY, and it has to be ──────────────────
 *
 * `getVariants` stamps every audiobook row it returns. Its rule for an id that
 * is neither `audiobook` nor `bilingual:*` is `v.professionallyRead ?? true` —
 * so a record that simply omitted the field would come back claiming a human
 * read this book aloud. It is a machine render and says so.
 */
export async function registerRvcAudiobookVariant(
  m4bAbsPath: string,
  filing: RvcVariantFiling,
  /**
   * `coverPath` is ABSOLUTE here — the shape the run carries, because that is
   * what the assembler writes into the M4B — and a variant record stores it
   * LIBRARY-RELATIVE. The conversion happens below, and a cover outside the
   * library is dropped rather than recorded as a path this library cannot
   * resolve on another machine.
   */
  metadata: { title?: string; author?: string; year?: string; coverPath?: string },
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const outputDir = path.dirname(m4bAbsPath);
  const projectDir = path.dirname(outputDir);
  const projectId = path.basename(projectDir);

  // The same guard `registerAudiobookOutput` applies: a file outside this
  // library's projects folder belongs to no manifest, and writing one for it
  // would invent a record for a book this library does not hold.
  if (path.resolve(manifestService.getProjectPath(projectId)) !== path.resolve(projectDir)) {
    return {
      success: false,
      skipped: true,
      error: `m4b not under library projects dir: ${m4bAbsPath}`,
    };
  }
  if (!fs.existsSync(m4bAbsPath)) {
    return { success: false, error: `The assembled audiobook is not at ${m4bAbsPath}.` };
  }

  const relPath = path
    .relative(projectDir, m4bAbsPath)
    .split(path.sep)
    .join('/');

  const libraryCoverPath = libraryRelativeCover(metadata.coverPath);

  const saved = await manifestService.modifyManifest(projectId, (mf) => {
    const current = manifestService.getVariants(mf);
    const record: ProjectVariant = {
      id: filing.variantId,
      kind: 'audiobook',
      format: 'm4b',
      path: relPath,
      // What the versions list shows beside the row. The voice IS the difference
      // between this reading and the book's other one.
      descriptor: filing.voiceLabel,
      metadata: {
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.author ? { author: metadata.author } : {}),
        ...(metadata.year ? { year: metadata.year } : {}),
        ...(libraryCoverPath === null ? {} : { coverPath: libraryCoverPath }),
        narrator: filing.voiceLabel,
      },
      addedAt: new Date().toISOString(),
      // See the docblock: absent would be read as `true` by getVariants.
      professionallyRead: false,
    };
    /*
     * The list `getVariants` returned already folds in the synthesized rows
     * (the base `audiobook`, the archive ebooks), and writing it back is what
     * every other writer in this codebase does — it is how those rows become
     * real records. This run's own row REPLACES the previous one for the same
     * voice rather than joining it, which is the whole point of a derived id.
     */
    mf.variants = [
      ...current.variants.filter((v) => v.id !== filing.variantId),
      record,
    ];
  });

  if (!saved.success) {
    return { success: false, error: saved.error };
  }
  return { success: true };
}
