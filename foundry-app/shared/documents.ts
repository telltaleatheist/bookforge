import type {
  ConversionKind,
  ProjectDocument,
  ProjectGeneratedRole,
  ProjectStep,
} from './types';

/**
 * Which role a conversion of each kind produces — the one mapping, shared.
 *
 * `electron/projects.ts` writes these into `project.json` when a job lands, and
 * the OCR dialog reads them to work out whether the source somebody picked is
 * the very file their run would write over. Two copies of this table would let
 * the renderer's warning disagree with the catalogue's own record of what a run
 * produces, which is the failure the warning exists to prevent.
 */
export const GENERATED_ROLE_FOR: Readonly<Record<ConversionKind, ProjectGeneratedRole>> = {
  epub: 'cast',
  pdf: 'searchable',
  txt: 'text',
};

/**
 * What a document IS, in two or three words — because its NAME does not say.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * A project's scan and the real-text PDF made from it have the SAME FILENAME.
 * `working/Kershaw-1993.pdf` is the scan the user imported;
 * `generated/Kershaw-1993.pdf` is the reprint made from it. They differ only in
 * the directory, which is this app's bookkeeping and something the user is
 * deliberately never shown. So everywhere a document was drawn by its basename —
 * the OCR dialog's source picker, the nav's rows — those two were one string,
 * and picking the wrong one earned a refusal after the whole form was filled in.
 *
 * It went unnoticed because it could not happen until this session: the reprint
 * used to REPLACE the scan as the project's live PDF, so there was only ever one
 * of them. Giving it a row of its own is what made the collision reachable.
 *
 * ── The wording ─────────────────────────────────────────────────────────────
 *
 * The same words Home already puts on its tags, so the two surfaces agree and
 * somebody who has read one row can read the other. `archive` is "original"
 * rather than "the scan" because a project started from an EPUB has an original
 * that was never scanned — and because `originalOf` calls it that, which is the
 * word the delete card uses when it explains what taking it would cost.
 */
export function typeLabel(kind: ProjectDocument['kind']): string {
  switch (kind) {
    case 'pdf': return 'PDF';
    case 'epub': return 'EPUB';
    case 'txt': return 'text';
    default: return '';
  }
}

/**
 * A document named so it cannot be confused with its own siblings.
 *
 * `Kershaw-1993.pdf · original` against `Kershaw-1993.pdf · real text`. The
 * middle dot rather than brackets because the shelf and the OCR dialog already
 * separate a thing from its qualifier that way, and a list of parentheses reads
 * as a list of asides.
 *
 * A FILE OUTSIDE ANY PROJECT HAS NO ROLE, and falls back to the folder it is in
 * — which is what actually distinguishes two files of the same name reached from
 * two directories, and is the only thing available that does.
 */
export function qualify(label: string, kind: ProjectDocument['kind'] | null, folder: string): string {
  const said = kind === null ? folder : typeLabel(kind);
  return said.length > 0 ? `${label} · ${said}` : label;
}

/**
 * A filename stem said aloud: the dashes and underscores become spaces.
 *
 * `Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993` is a STEM — a string built to
 * survive filesystems, not to be read — and Home was printing it as the name of
 * a book. This is only the fallback voice: a project whose real title has been
 * seen (`dc:title` from a cast EPUB, the PDF's own metadata at import) keeps
 * that title untouched, and this never runs on it. The dots stay, because
 * `Kershaw Ian. 1993` still reads as a citation while `Kershaw Ian 1993`
 * reads as three loose words.
 */
export function spokenStem(stem: string): string {
  return stem.replace(/[-_]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * A FILE said aloud — the last thing a document can be called when nothing has
 * a better name for it.
 *
 * THE EXTENSION GOES WITH THE FOLDERS. `.pdf` is the same class of fact as
 * `working/`: it is how a filesystem tells two of this app's copies apart, and a
 * person reading a list of their own books does not need to be told that the PDF
 * is a PDF — the row beside it already says so, in the app's own word for it.
 * What is left is the stem, and `spokenStem` is what makes a stem readable.
 *
 * IT IS THE LAST RESORT AND NOT THE RULE. A document inside a project is named
 * by the project (`ProjectSummary.title`, which is the book's own `dc:title`
 * where anything has read one); this is for the file somebody dropped on the
 * window that no project has claimed yet, and for the one they opened from a
 * folder of their own that never will be. Those have no book behind them, so the
 * name on the disk is the only name there is — and it should at least be said
 * rather than spelled.
 */
export function spokenName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  const stem = base.replace(/\.[^.]+$/, '');
  return spokenStem(stem.length > 0 ? stem : base);
}

/**
 * As much of a step as naming a row needs. `ProjectDocument` satisfies it.
 *
 * A STRUCTURAL SHAPE rather than the whole document, because the function below
 * is the one piece of this file that has to be exercised against a project with
 * an awkward set of rows in it, and building four complete `ProjectDocument`s to
 * ask what three of them are called is a test about the wrong thing.
 */
export interface NamedDocument {
  kind: ProjectDocument['kind'];
  /** Oldest first, as `summarise` sorts them. The last one is what is live. */
  steps: readonly Pick<ProjectStep, 'kind' | 'label'>[];
}

/**
 * What each of a project's rows is CALLED, in the app's own words — one name per
 * document, in the order they were handed over.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * The nav drew these rows by FILENAME. A project's documents all share one stem
 * by construction (`ProjectManifest.stem` — "the base filename every document in
 * this project shares"), so under a header that already said the book's name the
 * list read:
 *
 *   Working Towards The Fuhrer. Kershaw, Ian. (1993)
 *     Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993.pdf
 *     Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993.epub
 *
 * — the same string three times, twice in a spelling built to survive a
 * filesystem rather than to be read, with the one fact a person actually wanted
 * hiding in the last four characters. The header names the BOOK; a row's job is
 * to say which of its faces this one is, and that is `typeLabel`.
 *
 * ── Why the qualifier is never the filename ─────────────────────────────────
 *
 * A row's identity is its KIND and there is at most one of each in a project
 * (`ProjectDocument`), so "PDF" and "EPUB" cannot collide — but this does not
 * lean on that, because falling back to the filename the moment the invariant
 * bends is exactly how the old spelling would come back. Where two rows would
 * read the same, BOTH say what was last done to them: the step's own label is
 * the one field in a project's bookkeeping written to be read
 * (`ProjectStep.label`), and it differs precisely because the files do.
 *
 * A TRANSLATION SAYS SO WITHOUT WAITING FOR A COLLISION. A book that is now in
 * Hungarian is the EPUB — one row, one chain, the translation being its latest
 * step — and a person opening a project three months later has no way to know
 * that from the word "EPUB". The step label carries the language
 * (`shared/ledger.ts`), so the row reads "EPUB · Translated (Hungarian)" and the
 * question is answered before it is asked.
 */
export function documentNames(documents: readonly NamedDocument[]): string[] {
  const twins = new Map<string, number>();
  for (const document of documents) {
    const said = typeLabel(document.kind).toLowerCase();
    twins.set(said, (twins.get(said) ?? 0) + 1);
  }
  return documents.map((document) => {
    const said = typeLabel(document.kind);
    const latest = document.steps[document.steps.length - 1];
    if (latest === undefined) return said;
    const distinguish = latest.kind === 'translate'
      || (twins.get(said.toLowerCase()) ?? 0) > 1;
    return distinguish ? qualify(said, null, latest.label) : said;
  });
}

/**
 * The one sentence for "this run would read and write the same file".
 *
 * MAIN REFUSES AND THE RENDERER WARNS, and they say the same thing because they
 * say it from here. `workspace.ts` throws this after the plan has resolved a
 * path — the guard that actually matters, since a renderer's check is a
 * courtesy — and the OCR dialog shows it the moment the source is picked, which
 * is the moment it becomes knowable. Two hand-written versions of one sentence
 * drift, and the pair that drifts here would have main refusing something the
 * dialog had just said was fine.
 */
export function selfOverwriteMessage(file: string): string {
  return `That document IS this project's ${file}, so this run would have to read and replace the `
    + 'same file. Run it on the original instead, or ask for a different format or language.';
}
