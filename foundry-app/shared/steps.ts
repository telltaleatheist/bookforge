import {
  WHY_IMPORTED,
  WHY_MODEL_PASS,
  type ProjectDocumentKind,
  type ProjectGenerated,
  type ProjectStep,
  type ProjectTypeRecord,
} from './types';

/**
 * shared/steps — the v1 → v2 catalogue transform, and nothing else.
 *
 * IT LIVES HERE SO IT CAN BE TESTED. `electron/projects.ts` imports `app` from
 * electron at module scope, which means importing anything out of it starts an
 * Electron runtime — so the one piece of this app most worth covering, a data
 * migration that rewrites everybody's library, was the one piece nothing could
 * reach. It is a pure function of two arguments; it does not need a harness, it
 * needed to be importable.
 *
 * PURE, and deliberately so: no `fs`, no `path`, no clock, no logging. It maps a
 * catalogue to a catalogue. Everything that has to look at the disk — whether a
 * file a row names is still there, whether a working copy exists that no row
 * claims — is `summarise`'s job and stays there, because those answers change
 * between one call and the next and a migration's must not.
 */

/**
 * What a step is called when nobody wrote it down.
 *
 * THE RETROFIT'S HONEST ANSWER. A v1 catalogue recorded a file and a role and
 * never recorded what had been DONE, and the rotated copies in
 * `generated/archived-<stamp>/` are not in the catalogue at all — only on disk.
 * So a migrated chain can say what each file IS and roughly when, and cannot say
 * what was applied to produce it. Inventing a history to fill that in would be
 * this app writing fiction into somebody's project.
 */
export const EARLIER_VERSION = 'An earlier version';

/** What each kind of finished run is called in a chain a person reads. */
export const STEP_LABELS = {
  cast: 'Cast from the scan',
  imported: 'The book you imported',
  searchable: 'Reprinted as real text',
  translation: 'Translated',
  text: 'Written out as plain text',
} as const;

/** The `archive` entry a v1 catalogue carried, as much of it as this needs. */
export interface ArchiveRecord {
  file: string;
  kind: 'pdf' | 'epub';
}

/**
 * A v1 catalogue's `generated` list, read as the type chains it was describing.
 *
 * The roles carried enough to reconstruct WHICH TYPE each file belonged to and
 * roughly what it was, which is the part worth keeping:
 *
 *   `imported`/`cast` → the EPUB's origin       `searchable` → a step on the PDF
 *   `translation`     → a step on the EPUB      `text`       → the text's origin
 *
 * And the PDF's origin is the archive, which v1 recorded separately — the
 * generalisation this whole model turns on is that `archive/` was the PDF's
 * origin all along and simply had no name for what it was.
 *
 * A TRANSLATION IS A STEP AND NOT A ROW, which is the substantive change this
 * transform makes rather than merely records. v1 listed a translated book beside
 * the book it was translated from, as two documents with two names; the user's
 * account is one EPUB that is now English. So it joins the EPUB's chain, and
 * `summarise` shows the chain's last step — which is the translation.
 */
export function migrateToSteps(
  generated: readonly ProjectGenerated[],
  archive: ArchiveRecord | null,
  layers: { archive: string; generated: string } = { archive: 'archive', generated: 'generated' },
): ProjectTypeRecord[] {
  const chains = new Map<ProjectDocumentKind, ProjectStep[]>();
  const push = (kind: ProjectDocumentKind, step: ProjectStep): void => {
    chains.set(kind, [...(chains.get(kind) ?? []), step]);
  };

  if (archive !== null) {
    push(archive.kind, {
      file: `${layers.archive}/${archive.file}`,
      label: archive.kind === 'pdf' ? 'The scan you imported' : 'The book you imported',
      appliedAt: 0,
      kind: 'origin',
      retention: 'irreplaceable',
      why: WHY_IMPORTED,
    });
  }

  // Oldest first, so a chain reads in the order it happened. A v1 catalogue's
  // order was insertion order, which a rotation could disturb.
  for (const row of [...generated].sort((a, b) => a.madeAt - b.madeAt)) {
    const file = `${layers.generated}/${row.file}`;
    const common = {
      file,
      appliedAt: row.madeAt,
      // Every role a v1 catalogue could carry was the product of a model pass:
      // the engine reads the book to cast it, to reprint it, to translate it and
      // to write it out as text.
      retention: 'expensive',
      why: WHY_MODEL_PASS,
    } as const;

    switch (row.role) {
      case 'imported':
        push('epub', { ...common, label: STEP_LABELS.imported, kind: 'origin',
          retention: 'irreplaceable', why: WHY_IMPORTED });
        break;
      case 'cast':
        push('epub', { ...common, label: STEP_LABELS.cast, kind: 'origin' });
        break;
      case 'translation':
        push('epub', { ...common, label: STEP_LABELS.translation, kind: 'translate' });
        break;
      case 'searchable':
        push('pdf', { ...common, label: STEP_LABELS.searchable, kind: 'convert' });
        break;
      case 'text':
        push('txt', { ...common, label: STEP_LABELS.text, kind: 'origin' });
        break;
    }
  }

  return [...chains].map(([kind, steps]) => ({ kind, steps }));
}

/**
 * One step out of a stored catalogue, validated.
 *
 * UNKNOWN RETENTION READS AS `expensive`, and that is a change of mind worth
 * recording. It first defaulted to the cheap end, on the reasoning that this app
 * has no argument for keeping what it cannot justify. That is right about disk
 * and wrong about risk: the cheap end means "throw it away and make it again",
 * and a step whose provenance nobody wrote down is exactly the one where nobody
 * can promise it CAN be made again. The middle state keeps the file without
 * claiming it is irreplaceable, which is the honest answer to "we do not know".
 */
export function readStep(value: unknown): ProjectStep | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const file = row['file'];
  const kind = row['kind'];
  if (typeof file !== 'string') return null;
  if (kind !== 'origin' && kind !== 'convert' && kind !== 'translate' && kind !== 'edit') return null;
  const retention = row['retention'];
  return {
    file,
    kind,
    label: typeof row['label'] === 'string' ? row['label'] : EARLIER_VERSION,
    appliedAt: typeof row['appliedAt'] === 'number' ? row['appliedAt'] : 0,
    retention: retention === 'irreplaceable' || retention === 'regenerable' || retention === 'expensive'
      ? retention
      : 'expensive',
    why: typeof row['why'] === 'string' ? row['why'] : '',
  };
}

/** The type records out of a stored catalogue — v2's own shape, validated. */
export function readTypeRecords(value: unknown): ProjectTypeRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ProjectTypeRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    if (kind !== 'epub' && kind !== 'pdf' && kind !== 'txt') continue;
    const steps = Array.isArray(record['steps'])
      ? record['steps'].map(readStep).filter((step): step is ProjectStep => step !== null)
      : [];
    // A type with no steps is not a type this project has. Dropping it here is
    // what keeps "the chain is never empty" true for every reader downstream.
    if (steps.length > 0) records.push({ kind, steps });
  }
  return records;
}
