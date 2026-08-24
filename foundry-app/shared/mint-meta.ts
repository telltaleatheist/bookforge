/**
 * mint-meta — who a book says it is, at the moment a file is minted from it.
 *
 * ── The ruling this module serves ───────────────────────────────────────────
 *
 * Owen, 2026-08-24, after a German narration of an English book: *"just tell
 * foundry to design this modal and make sure it has the options that bookforge
 * contains"* — and, on the build: *"it should work when the user mints a new
 * epub OR when theyre hovering on an epub and click the metadata tile."* The
 * fields, the author shapes and the FILENAME CONVENTION below are BookForge's
 * own (src/app/features/audiobook/components/metadata-editor and
 * electron/manifest-service.ts, mirrored function for function), because a
 * file that crosses from Foundry's tray into BookForge's shelf must say the
 * same name in both worlds or the join between them frays exactly where a
 * person is least able to see it.
 *
 * ── PURE, IN shared/, AND WHY THAT PLACEMENT IS LOAD-BEARING ────────────────
 *
 * The dialog previews the filename per keystroke; main writes the real one at
 * the mint; the landing announces it to a host. Three readers of "what is this
 * file called" is exactly the situation this codebase refuses to serve with
 * two implementations, so the convention lives here where both processes
 * import it and neither can drift.
 */

/** One author, as BookForge's editor holds them. */
export interface MintContributor {
  first: string;
  last: string;
}

/**
 * The metadata a mint declares — the project-level record the modal edits and
 * every EPUB minted from the project inherits.
 *
 * `language` is the PLAIN PRIMARY SUBTAG (en, de, fr…), never a full BCP-47
 * tag: BookForge's selects and its narration pipeline key on the two-letter
 * form, and a `de-DE` arriving where `de` is expected is the same class of
 * quiet wrong-language mismatch the whole mint-metadata wave exists to end
 * (their amendment, 2026-08-24, accepted before the freeze).
 *
 * `coverPath` is project-relative and RECORDED, not yet embedded — embedding
 * rides the deferred packageVlmEpub cover wave (docs/PLAN.md), and a field
 * that exists now is what lets the modal collect the fact before the writer
 * can honour it.
 */
export interface MintMeta {
  title: string;
  subtitle?: string;
  contributors: MintContributor[];
  year?: string;
  language?: string;
  coverPath?: string;
}

/**
 * The languages the select offers — BookForge's own eight, in its order.
 * The project's detected language is offered by the dialog even when it is
 * not in this table; the table is the menu, not a validator.
 */
export const MINT_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
];

/**
 * One author as a filename — and as an OPF `file-as` — says it: "Last, First",
 * or whichever half exists alone. BookForge's formatOne, verbatim; exported
 * because the metadata stamp writes the same spelling per creator.
 */
export function contributorFileAs(author: MintContributor): string {
  if (author.last && author.first) return `${author.last}, ${author.first}`;
  return author.last || author.first;
}
const fileAsOne = contributorFileAs;

/**
 * The authors segment of a filename — BookForge's formatAuthorsForFilename:
 * one author is "Last, First"; TWO are joined with "and"; THREE OR MORE are
 * the first author "et al." Empty when nobody is named.
 */
export function authorsForFilename(contributors: readonly MintContributor[]): string {
  const named = contributors.filter((one) => one.first || one.last);
  if (named.length === 0) return '';
  if (named.length === 1) return fileAsOne(named[0]!);
  if (named.length === 2) return `${fileAsOne(named[0]!)} and ${fileAsOne(named[1]!)}`;
  return `${fileAsOne(named[0]!)} et al.`;
}

/**
 * The combined display string — "First Last, First Last" — BookForge's
 * syncAuthorToFormData, for every surface that wants the authors as one line.
 */
export function authorsDisplay(contributors: readonly MintContributor[]): string {
  return contributors
    .map((one) => [one.first, one.last].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
}

/**
 * A run of periods collapsed to one — BookForge's collapseFilenameDots, for
 * the one case its own history names: a "Last, First M." author ("Green,
 * Simon R.") whose trailing period collides with the ". (Year)" separator and
 * reads "R.. (Year)". Applied to the BASE only, before the extension, so the
 * dot before the extension is never touched.
 */
export function collapseFilenameDots(base: string): string {
  return base.replace(/\.{2,}/g, '.');
}

/**
 * THE NAME A MINT GENERATES — BookForge's convention, exactly:
 *
 *   `Title[ - Subtitle]. Authors. (Year).ext`
 *
 * Year at the END; each segment owns its own leading ". " so absent parts
 * never double the periods; double dots collapsed in the base; whitespace
 * runs collapsed. The title falls back to 'Untitled' because a filename with
 * nothing in front of the first period is a file nobody can find again.
 *
 * This is the DISPLAY/EMBEDDED spelling — real Unicode. The on-disk name is
 * this run through `asciiFilename`, and only the on-disk name: the file's own
 * metadata keeps the diacritics the filesystem cannot be trusted with.
 */
export function generatedFilename(meta: MintMeta, ext: string): string {
  let base = (meta.title || 'Untitled').trim();
  if (meta.subtitle?.trim()) base += ` - ${meta.subtitle.trim()}`;
  const authors = authorsForFilename(meta.contributors);
  if (authors) base += `. ${authors}`;
  if (meta.year?.trim()) base += `. (${meta.year.trim()})`;
  base = collapseFilenameDots(base);
  const suffix = ext.replace(/^\./, '');
  return `${base}.${suffix}`.replace(/\s+/g, ' ').trim();
}

/** Characters no filesystem across the three platforms will take. */
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;

/**
 * The on-disk spelling of a generated name: diacritics stripped (NFD, marks
 * removed), ß→ss, unsafe characters to underscores — BookForge's
 * toAsciiFilename posture, so a name minted here survives every filesystem
 * and every sync client without a second spelling appearing. The EMBEDDED
 * metadata keeps the real characters; only the filename is simplified.
 */
export function asciiFilename(name: string): string {
  return name
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An author STRING read into contributors — for seeding the modal from a
 * scan's Info dictionary or an old record that predates the array.
 *
 * THE COMMA RULE IS OWEN'S (2026-08-16) AND IT IS ABSOLUTE: a comma means the
 * string is ALREADY "Last, First" — read it that way and never re-invert it.
 * Treating a comma'd name as first-last inverted it a second time, and
 * "Bailey, Gene" shipped as the filename "Gene, Bailey," once. Without a
 * comma the string is "First … Last" and the last word is the surname.
 */
export function contributorsFromString(author: string): MintContributor[] {
  const said = author.trim();
  if (said.length === 0) return [];
  if (said.includes(',')) {
    const parts = said.split(',').map((one) => one.trim()).filter(Boolean);
    return [{ first: parts.slice(1).join(' '), last: parts[0] ?? '' }];
  }
  const words = said.split(/\s+/);
  if (words.length === 1) return [{ first: words[0]!, last: '' }];
  return [{ first: words.slice(0, -1).join(' '), last: words[words.length - 1]! }];
}

/** A meta with anybody home — what decides whether a seed is worth keeping. */
export function metaSaysAnything(meta: MintMeta): boolean {
  return meta.title.trim().length > 0
    || (meta.subtitle?.trim().length ?? 0) > 0
    || meta.contributors.some((one) => one.first || one.last)
    || (meta.year?.trim().length ?? 0) > 0;
}
