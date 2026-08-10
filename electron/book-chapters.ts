/**
 * book-chapters — what the project's book calls each of its chapters, and the
 * one edit that changes it.
 *
 * ── Why the title is not the print ──────────────────────────────────────────
 *
 * A book `foundry vlm-convert` writes is one XHTML document per chapter, each
 * listed once in the EPUB 3 navigation document, and each carrying its own
 * `<title>` in its `<head>`. The heading INSIDE the document is the print — the
 * words that were on the page — and the audiobook pipeline never reads it:
 * ebook2audiobook takes its chapter titles from the book's own table of
 * contents, matched to spine documents by identity. So "rename this chapter" is
 * an edit to METADATA and to nothing a reader sees:
 *
 *   - the table-of-contents entry's text, which is the title the audiobook is
 *     built with;
 *   - the chapter document's `<head><title>`, which is what every other reader
 *     (a phone, a validator, Calibre) shows for that document.
 *
 * The `<h1>`/`<h2>` in the body is deliberately left ALONE. A user retitling
 * "CHAPTER I" to "One: Nuremberg, October 1946" is naming the chapter, not
 * claiming the page said something it did not, and rewriting the print would put
 * the book and the scan it came from into disagreement with nothing recording
 * that it happened.
 *
 * ── Both dialects, and why not one of them ──────────────────────────────────
 *
 * A book states its chapters' names in an EPUB 3 navigation document
 * (`<nav epub:type="toc">`), in an EPUB 2 NCX (`toc.ncx`, `navMap/navPoint`), or
 * in BOTH — all three are ordinary. `foundry vlm-convert` writes the first;
 * publisher EPUBs a user imports are very often the second (Killing America,
 * measured: a 2.0 package with an NCX and a `<guide>` and no nav document at
 * all) and EPUB 3 books commonly ship the NCX as well, for readers that predate
 * the nav.
 *
 * This used to REFUSE any book carrying an NCX, on the grounds that renaming one
 * table of contents leaves the other saying something else and which one a
 * reader believes is then a property of the reader. That reasoning was right and
 * the remedy was wrong: it made every EPUB 2 book unrenameable — a user renamed
 * sixteen chapters of Killing America and the renames went nowhere near the
 * book — and it protected nothing, because a book with one stale table of
 * contents is exactly what you get by not being able to edit either. A rename
 * now lands in EVERY table of contents the book carries, so the two cannot come
 * apart in the first place.
 *
 * ── Why there is no second store ────────────────────────────────────────────
 *
 * The title lives in the book and only in the book. Re-opening the project reads
 * the table of contents again and finds the new title there, so nothing in the
 * manifest, the project file or the picker has to remember a rename or be
 * reconciled with one. That is the same rule chapter titles already follow with
 * a working document — one authority, no mirror to drift (memory:
 * chapter-title-single-authority) — said for the book instead of for the PDF.
 *
 * ── The two records that DO have to move with it ────────────────────────────
 *
 * Rewriting the book changes its bytes, and two records are stamped with those
 * bytes:
 *
 *   - the narration deletions, which are positional keys stamped with the book's
 *     sha256 (shared/vlm/narration-deletions.ts). A retitle adds, removes and
 *     reorders NO element — it replaces the text inside one entry per table of
 *     contents and one `<title>`, all of which are outside every spine
 *     document's `<body>` unit list bar the nav's own — so every recorded key
 *     still names the element it named before, and the record is re-stamped
 *     rather than voided. Left alone it would read as stale on the next open and
 *     a user's strikes would be silently cleared by a rename that could not have
 *     invalidated one of them.
 *   - the narration copy, which is the book minus those strikes and carries a
 *     byte-identical copy of the same tables of contents. It gets the same edits
 *     and its `fromEpubSha256` moves with them, so "the copy is the book minus
 *     the strikes" stays true. A copy that was ALREADY cut from some other
 *     version of the book is not touched and is reported stale — it is stale, and
 *     it was stale before this ran.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EpubProcessor, ZipReader, ZipWriter, type EpubStructure } from './epub-processor';
import { moveIntoPlace } from './processing-passes';
import { sha256File } from './sidecar-binding';
import * as manifestService from './manifest-service';
import type {
  BookChapterRenameResult,
  BookChapterTitle,
  BookChapterTitles,
} from '../shared/vlm/chapter-titles';

export type { BookChapterRenameResult, BookChapterTitle, BookChapterTitles };

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

// ─────────────────────────────────────────────────────────────────────────────
// Reading the book's tables of contents
// ─────────────────────────────────────────────────────────────────────────────

/** Which dialect a table of contents is written in. */
type TocKind = 'nav' | 'ncx';

/** One entry of a table of contents: a document, and the text that names it. */
interface TocEntry {
  /** The named document's zip entry name, normalized. */
  file: string;
  /** What the entry points at INSIDE that document — '' when it points at the document. */
  fragment: string;
  /** The entry as a person can find it in the file, for a refusal to name. */
  where: string;
  /** The name as a person reads it: markup dropped, entities resolved. */
  title: string;
  /** The naming text exactly as it is written, which is what the splice replaces. */
  raw: string;
  /** String offsets of `raw` in the file the entry lives in. */
  innerStart: number;
  innerEnd: number;
}

/** One of the book's tables of contents, as entries into its documents. */
interface TocDocument {
  kind: TocKind;
  /** The zip entry name of the file the entries' offsets are measured in. */
  file: string;
  entries: TocEntry[];
}

/** How a table of contents is spoken about in a refusal. */
function tocDescription(toc: TocDocument): string {
  return toc.kind === 'nav'
    ? `its EPUB 3 navigation document (${toc.file})`
    : `its NCX table of contents (${toc.file})`;
}

/**
 * The book's table of contents, as links into its documents.
 *
 * Scoped to `<nav epub:type="toc">` and refused when there is none. EPUB 3
 * REQUIRES that nav — it is the table of contents — and a navigation document
 * without one either is not one or belongs to a book this app did not write; in
 * either case guessing which of its `<nav>`s is the TOC would rename an entry in
 * the landmarks or the page list.
 */
function parseNavToc(
  navXhtml: string,
  navFile: string,
  bookName: string,
  documents: ReadonlySet<string>,
): TocEntry[] {
  const tocOpen = /<nav\b([^>]*)>/gi;
  let tocInner: { text: string; offset: number } | null = null;
  for (let m = tocOpen.exec(navXhtml); m !== null; m = tocOpen.exec(navXhtml)) {
    if (!/epub:type\s*=\s*["'][^"']*\btoc\b/i.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = navXhtml.indexOf('</nav>', start);
    if (end < 0) {
      throw new Error(
        `${bookName}: its navigation document opens a table of contents that is never closed `
        + `(no </nav> after the <nav epub:type="toc">). The file is not well-formed, so nothing `
        + 'was renamed.'
      );
    }
    tocInner = { text: navXhtml.slice(start, end), offset: start };
    break;
  }
  if (tocInner === null) {
    throw new Error(
      `${bookName}: its navigation document (${navFile}) declares no table of contents — there is `
      + 'no <nav epub:type="toc"> in it — so there is no chapter entry to rename. An EPUB 3 book '
      + 'is required to have one; this book was written by something that did not write it.'
    );
  }

  const entries: TocEntry[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = anchor.exec(tocInner.text); m !== null; m = anchor.exec(tocInner.text)) {
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(m[1]);
    if (href === null) {
      // A table-of-contents entry with no destination. Legal EPUB 3 — a heading
      // level that groups the entries under it ("Part Two") is written exactly
      // this way — and it names no document, so it is not a chapter this can
      // rename. Skipped, not refused.
      continue;
    }
    const where = `the entry <a href="${href[1]}"> of ${navFile}`;
    const target = resolveTocTarget(href[1], navFile, documents);
    if (target.kind === 'not-a-document') continue;
    if (target.kind === 'unlisted') {
      throw new Error(unlistedTargetSentence(bookName, where, href[1], target.tried));
    }
    const innerStart = tocInner.offset + m.index + m[0].indexOf('>') + 1;
    entries.push({
      file: target.file,
      fragment: target.fragment,
      where,
      title: stripMarkup(m[2]),
      raw: m[2],
      innerStart,
      innerEnd: innerStart + m[2].length,
    });
  }
  return entries;
}

/** An element name, with any namespace prefix a book chose to write it under. */
function ncxTag(name: string): string {
  return `(?:[A-Za-z_][\\w.\\-]*:)?${name}`;
}

/**
 * The NCX's `navMap`, as entries into the book's documents.
 *
 * ── Why the navPoints are not matched as blocks ─────────────────────────────
 *
 * An NCX nests: a navPoint that is a part heading contains the navPoints of the
 * chapters under it. Matching `<navPoint>…</navPoint>` non-greedily therefore
 * swallows the first child inside the parent's match and skips it entirely, so a
 * two-level table of contents would silently lose a level. Each navPoint is
 * instead read from its own open tag up to the NEXT navPoint's open tag, which
 * is exactly the region its own `navLabel` and `content` are in — the NCX
 * content model puts both before any child navPoint.
 *
 * Scoped to `navMap` for the same reason the nav parse is scoped to
 * `epub:type="toc"`: an NCX may also carry a `pageList` and `navList`, whose
 * labels are page numbers and lists of figures, not chapter names.
 */
function parseNcxNavMap(
  ncxXml: string,
  ncxFile: string,
  bookName: string,
  documents: ReadonlySet<string>,
): TocEntry[] {
  const mapOpen = new RegExp(`<${ncxTag('navMap')}\\b[^>]*>`, 'i').exec(ncxXml);
  if (mapOpen === null) {
    throw new Error(
      `${bookName}: its NCX table of contents (${ncxFile}) has no <navMap>, so it names no chapter `
      + 'and there is nothing to rename in it. An NCX is required to have one; this book carries a '
      + 'file that is not one.'
    );
  }
  const mapStart = mapOpen.index + mapOpen[0].length;
  const mapClose = new RegExp(`</${ncxTag('navMap')}\\s*>`, 'gi');
  mapClose.lastIndex = mapStart;
  const closed = mapClose.exec(ncxXml);
  if (closed === null) {
    throw new Error(
      `${bookName}: its NCX table of contents (${ncxFile}) opens a <navMap> that is never closed. `
      + 'The file is not well-formed, so nothing was renamed.'
    );
  }
  const mapEnd = closed.index;

  const opens: Array<{ attrs: string; tagStart: number; regionStart: number }> = [];
  const pointOpen = new RegExp(`<${ncxTag('navPoint')}\\b([^>]*)>`, 'gi');
  pointOpen.lastIndex = mapStart;
  for (let m = pointOpen.exec(ncxXml); m !== null && m.index < mapEnd; m = pointOpen.exec(ncxXml)) {
    opens.push({ attrs: m[1], tagStart: m.index, regionStart: m.index + m[0].length });
  }

  // `<navLabel …><text …>` and its inner text as two groups, so the inner text's
  // offset is the match's offset plus the first group's length — the whole of
  // what a surgical rewrite needs to know.
  const labelText = new RegExp(
    `(<${ncxTag('navLabel')}\\b[^>]*>[\\s\\S]*?<${ncxTag('text')}\\b[^>]*>)([\\s\\S]*?)`
    + `</${ncxTag('text')}\\s*>`,
    'i',
  );
  const contentSrc = new RegExp(`<${ncxTag('content')}\\b[^>]*\\bsrc\\s*=\\s*["']([^"']*)["']`, 'i');

  const entries: TocEntry[] = [];
  for (let i = 0; i < opens.length; i++) {
    const regionStart = opens[i].regionStart;
    const regionEnd = i + 1 < opens.length ? opens[i + 1].tagStart : mapEnd;
    const region = ncxXml.slice(regionStart, regionEnd);
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(opens[i].attrs);
    const where = `${id === null ? `navPoint ${i + 1}` : `navPoint "${id[1]}"`} of ${ncxFile}`;

    const src = contentSrc.exec(region);
    if (src === null) {
      // A navPoint with no `<content>` points nowhere. Real in books that use one
      // as a grouping heading, exactly as an EPUB 3 nav uses an `<a>`-less entry,
      // and it names no document — so it is not a chapter this can rename.
      continue;
    }
    const label = labelText.exec(region);
    if (label === null) {
      throw new Error(
        `${bookName}: ${where} points at ${src[1]} and carries no <navLabel><text>, so the book `
        + 'states no name for that chapter and there is none to replace. Nothing was renamed.'
      );
    }

    const target = resolveTocTarget(src[1], ncxFile, documents);
    if (target.kind === 'not-a-document') continue;
    if (target.kind === 'unlisted') {
      throw new Error(unlistedTargetSentence(bookName, where, src[1], target.tried));
    }
    const innerStart = regionStart + label.index + label[1].length;
    entries.push({
      file: target.file,
      fragment: target.fragment,
      where,
      title: stripMarkup(label[2]),
      raw: label[2],
      innerStart,
      innerEnd: innerStart + label[2].length,
    });
  }
  return entries;
}

/** What a table-of-contents entry points at, once the book has been asked. */
type TocTarget =
  /** A document of this book, and the part of it the entry names. */
  | { kind: 'document'; file: string; fragment: string }
  /** Somewhere that is not a document of this book: a bare fragment, a URL. */
  | { kind: 'not-a-document' }
  /** A path this book does not contain, with every reading that was tried. */
  | { kind: 'unlisted'; tried: string[] };

/** Schemes that name something outside the book, whatever the book contains. */
const EXTERNAL_HREF = /^(?:https?|mailto|ftp|tel|data):/i;

/**
 * Which document a table-of-contents entry names, answered by the BOOK.
 *
 * The href is resolved against the OPF manifest rather than parsed into a path,
 * because the two readings of a '#' are both real: it is a fragment separator
 * nearly always, and Calibre writes it into FILENAMES ("Book_#04_split_000.html"),
 * which is why `EpubProcessor.resolvePath` tries both. Asking the manifest which
 * reading is a document of this book settles it with the book's own evidence
 * instead of a rule that is wrong for one of the two.
 */
function resolveTocTarget(
  href: string,
  tocFile: string,
  documents: ReadonlySet<string>,
): TocTarget {
  if (EXTERNAL_HREF.test(href)) return { kind: 'not-a-document' };

  const readings: Array<{ path: string; fragment: string }> = [{ path: href, fragment: '' }];
  const hash = href.indexOf('#');
  if (hash >= 0) {
    readings.push({ path: href.slice(0, hash), fragment: href.slice(hash + 1) });
  }
  for (const reading of readings.slice()) {
    const decoded = decodeHref(reading.path);
    if (decoded !== reading.path) readings.push({ path: decoded, fragment: reading.fragment });
  }

  const tocDir = tocFile.includes('/') ? tocFile.slice(0, tocFile.lastIndexOf('/')) : '';
  const tried: string[] = [];
  for (const reading of readings) {
    if (reading.path === '') continue;  // a link into the table of contents itself
    const entry = normalizeEntryName(tocDir === '' ? reading.path : `${tocDir}/${reading.path}`);
    tried.push(entry);
    if (documents.has(entry)) {
      return { kind: 'document', file: entry, fragment: reading.fragment };
    }
  }
  if (tried.length === 0) return { kind: 'not-a-document' };
  return { kind: 'unlisted', tried };
}

function unlistedTargetSentence(
  bookName: string,
  where: string,
  href: string,
  tried: readonly string[],
): string {
  return (
    `${bookName}: ${where} points at "${href}", which is not in the book's manifest — `
    + `tried ${tried.join(', ')}. A table of contents naming a document the package does not `
    + 'declare is a malformed book: a reader following that entry finds nothing, and e2a would '
    + 'take a chapter title off it for a chapter that does not exist. Nothing was renamed.'
  );
}

/**
 * Every document the OPF declares, as zip entry names.
 *
 * The whole manifest and not just the spine: a table of contents may legally
 * name a document that is not in the reading order, and the question being asked
 * is "does this book contain the thing this entry points at", which the manifest
 * is the book's own answer to.
 */
function manifestDocuments(structure: EpubStructure): Set<string> {
  const opfDir = structure.opfPath.includes('/')
    ? structure.opfPath.slice(0, structure.opfPath.lastIndexOf('/'))
    : '';
  const documents = new Set<string>();
  for (const item of Object.values(structure.manifest)) {
    if (!item.href) continue;
    const href = decodeHref(item.href);
    documents.add(normalizeEntryName(opfDir === '' ? href : `${opfDir}/${href}`));
  }
  return documents;
}

/** Percent-decode an href, leaving one that is not percent-encoded alone. */
function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    // A '%' that is not an escape is a literal '%' in a filename. Real: Calibre
    // writes raw punctuation into hrefs, which is why `EpubProcessor.resolvePath`
    // tries the undecoded form too.
    return href;
  }
}

/** Resolve "." and ".." segments in a zip entry name — the aligner's own rule. */
function normalizeEntryName(name: string): string {
  const parts: string[] = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

/** A table-of-contents entry's text as a person reads it: tags dropped, entities resolved. */
function stripMarkup(inner: string): string {
  return inner
    .replace(/<[^>]*>/g, '')
    // Numeric character references, which publisher NCXs use where a nav
    // document would carry the character itself — Killing America writes
    // "The Fa&#x00E7;ade", and a title shown with the escape still in it is a
    // title the user would "correct" by hand into the book.
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => codePointText(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => codePointText(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A code point as text, or the empty string for one no character has. */
function codePointText(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

/** Text that is safe as an XML text node. */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A document's own `<title>`, and the edit that would replace it. */
interface DocTitle {
  title: string;
  innerStart: number;
  innerEnd: number;
  /** Written before the new name, for a title element that has to be rebuilt. */
  open: string;
  /** Written after it. */
  close: string;
}

/**
 * The `<head><title>` of an XHTML document, and where its text sits.
 *
 * `<title/>` is the second form and not a missing title: a publisher EPUB whose
 * documents came out of a typesetting pipeline writes the element self-closed
 * and empty (Killing America, every chapter), and that is a head which names the
 * document and names it nothing. There is no text node to splice into, so the
 * RANGE is the whole element and the replacement rebuilds it around the new name
 * — attributes and all, because `xml:lang` on a title is meaningful.
 */
function findDocTitle(xhtml: string): DocTitle | null {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(xhtml);
  if (head === null) return null;
  const headOffset = head.index + head[0].indexOf('>') + 1;

  const paired = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head[1]);
  if (paired !== null) {
    const innerStart = headOffset + paired.index + paired[0].indexOf('>') + 1;
    return {
      title: stripMarkup(paired[1]),
      innerStart,
      innerEnd: innerStart + paired[1].length,
      open: '',
      close: '',
    };
  }

  const selfClosed = /<title\b([^>]*?)\/>/i.exec(head[1]);
  if (selfClosed === null) return null;
  const start = headOffset + selfClosed.index;
  return {
    title: '',
    innerStart: start,
    innerEnd: start + selfClosed[0].length,
    open: `<title${selfClosed[1]}>`,
    close: '</title>',
  };
}

/**
 * Open the book and read every table of contents it carries, or refuse naming
 * what is missing.
 *
 * Both are read when the book has both, in the order a reader prefers them: the
 * EPUB 3 nav is what a modern reader and e2a navigate by, the NCX is the same
 * list said again for readers that predate it. Which one is present is decided
 * by the OPF — `properties="nav"` and `media-type="application/x-dtbncx+xml"` —
 * and never by a filename, because "toc.ncx" and "nav.xhtml" are conventions a
 * book is free not to follow.
 */
async function readTocs(bookPath: string): Promise<TocDocument[]> {
  const bookName = path.basename(bookPath);
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(bookPath);
    const documents = manifestDocuments(structure);
    const tocs: TocDocument[] = [];

    if (structure.navPath) {
      const file = normalizeEntryName(structure.navPath);
      const navXhtml = await processor.readFile(file);
      tocs.push({ kind: 'nav', file, entries: parseNavToc(navXhtml, file, bookName, documents) });
    }
    if (structure.ncxPath) {
      const file = normalizeEntryName(structure.ncxPath);
      const ncxXml = await processor.readFile(file);
      tocs.push({ kind: 'ncx', file, entries: parseNcxNavMap(ncxXml, file, bookName, documents) });
    }

    if (tocs.length === 0) {
      throw new Error(
        `${bookName} declares no table of contents — no EPUB 3 navigation document and no NCX — so `
        + 'it has no chapter titles to change. The table of contents is what the audiobook takes '
        + 'its chapter names from, and this book states none.'
      );
    }
    return tocs;
  } finally {
    processor.close();
  }
}

/**
 * Where one document is NAMED, once per table of contents the book carries.
 *
 * ── The one thing that cannot be answered ───────────────────────────────────
 *
 * A chapter is addressed here by its DOCUMENT (`<zip entry>`, the first half of
 * a narration strike's key), and a table of contents may name the same document
 * more than once — a long chapter with a link to each of its sections is written
 * exactly that way. The entry that names the document ITSELF (no fragment) is
 * the one that identity belongs to, and it is taken. When there is no such entry
 * and more than one fragment entry, the document's name is genuinely written in
 * several places and nothing here can say which one the user meant: renaming the
 * first would silently retitle a section, so it refuses and names them.
 */
function entriesForDocument(
  tocs: readonly TocDocument[],
  chapterFile: string,
  bookName: string,
): Array<{ toc: TocDocument; entry: TocEntry }> {
  const hits: Array<{ toc: TocDocument; entry: TocEntry }> = [];
  for (const toc of tocs) {
    const matches = toc.entries.filter((e) => e.file === chapterFile);
    if (matches.length === 0) continue;

    const whole = matches.filter((e) => e.fragment === '');
    if (whole.length === 1) { hits.push({ toc, entry: whole[0] }); continue; }
    if (whole.length === 0 && matches.length === 1) { hits.push({ toc, entry: matches[0] }); continue; }

    throw new Error(
      `${bookName}: ${tocDescription(toc)} names ${chapterFile} in ${matches.length} places `
      + `(${matches.map((e) => `${e.where} — "${e.title}"`).join('; ')}), and a chapter is `
      + 'renamed here by its document, so which of them is the chapter\'s name cannot be told '
      + 'apart from which of them is a section within it. Nothing was renamed.'
    );
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the titles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one book calls each of its chapters.
 *
 * One row per DOCUMENT, in the order the book's first table of contents lists
 * them, with any document only the second names appended. The row's title is the
 * first table of contents' — the EPUB 3 nav where there is one, which is what a
 * reader and e2a navigate by — and a document named twice within one list is one
 * row, because the caller's question is "what is this document called" and it
 * has one answer or the rename refuses to guess between them.
 */
export async function readChapterTitlesOfBook(bookPath: string): Promise<BookChapterTitles> {
  const tocs = await readTocs(bookPath);

  // The `<head><title>` of each listed document, read from the document itself.
  // Reported beside the table-of-contents title because the two are written
  // together and a book where they have drifted apart is worth being able to see.
  const processor = new EpubProcessor();
  const chapters: BookChapterTitle[] = [];
  const seen = new Set<string>();
  try {
    await processor.open(bookPath);
    for (const toc of tocs) {
      for (const entry of toc.entries) {
        if (seen.has(entry.file)) continue;
        seen.add(entry.file);
        const xhtml = await readListedDocument(processor, entry, bookPath);
        const docTitle = findDocTitle(xhtml);
        chapters.push({
          file: entry.file,
          navTitle: entry.title,
          // A document with no <head><title> at all states no title of its own.
          // Real for hand-written and third-party markup — the element is optional
          // in practice even though XHTML requires it — so it is reported as the
          // empty string it is, and `renameBookChapter` refuses to write into a
          // document that has none rather than inventing a head for it.
          docTitle: docTitle === null ? '' : docTitle.title,
        });
      }
    }
  } finally {
    processor.close();
  }

  return { bookPath, tocFiles: tocs.map((t) => t.file), chapters };
}

/**
 * A document the table of contents lists, read out of the zip.
 *
 * The manifest declares it, so a zip that does not contain it is a book whose
 * package and whose archive disagree — said here with both halves of that
 * sentence, because the reader's own "Entry not found" names neither the entry
 * that led to it nor the book.
 */
async function readListedDocument(
  processor: EpubProcessor,
  entry: TocEntry,
  bookPath: string,
): Promise<string> {
  try {
    return await processor.readFile(entry.file);
  } catch (err) {
    throw new Error(
      `${path.basename(bookPath)}: ${entry.where} names ${entry.file}, which the OPF declares and `
      + `the archive does not contain (${(err as Error).message}).`
    );
  }
}

/**
 * What the project's book calls each of its chapters — or null when the project
 * has no book on disk.
 *
 * Null rather than an empty list, and rather than a throw: a project whose PDF
 * has never been converted genuinely has no book, which is the state most
 * projects are in for most of their life, and it is the reason the picker asks
 * this for every project it opens. A project that HAS a book and cannot be read
 * throws, because that is a fault.
 *
 * `familyId` chooses which chain's book to read. Left out, a project with one
 * chain needs no choosing; a project with several refuses rather than picking
 * one for the caller.
 */
export async function readBookChapterTitles(
  projectDir: string,
  familyId?: string,
): Promise<BookChapterTitles | null> {
  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book || !fs.existsSync(book.absPath)) return null;
  return readChapterTitlesOfBook(book.absPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// The rename
// ─────────────────────────────────────────────────────────────────────────────

/** One text range of one file, and what is written over it. */
interface TitleEdit {
  start: number;
  end: number;
  /** The bytes expected there, so an offset that has slipped is caught, not written. */
  expect: string;
  /** How this place is named in a refusal. */
  where: string;
  /** Markup written around the new name, for an element being rebuilt rather than refilled. */
  open: string;
  close: string;
}

/**
 * The book with one chapter's every table-of-contents entry and its document's
 * `<title>` rewritten, staged and then moved onto the recorded path.
 *
 * The edits are STRING SPLICES at offsets the parse already found, not a DOM
 * round trip. That is the point: every other byte of the book — the print, the
 * `data-bf-cat` stamps, the cropped figures, the whitespace foundry laid out —
 * comes through untouched, so the aligner's unit list, the narration keys taken
 * off it, and any diff a person runs against this file all still describe the
 * same book.
 *
 * The edits are collected PER FILE before any of them is applied, because two of
 * them can land in the same file: a book whose printed contents page is also its
 * navigation document names itself, and rewriting the file twice from its
 * original bytes would keep only the second edit.
 */
async function rewriteChapterTitle(
  inputPath: string,
  outputPath: string,
  hits: ReadonlyArray<{ toc: TocDocument; entry: TocEntry }>,
  chapterFile: string,
  title: string,
): Promise<void> {
  const edits = new Map<string, TitleEdit[]>();
  const addEdit = (file: string, edit: TitleEdit): void => {
    const existing = edits.get(file);
    if (existing === undefined) edits.set(file, [edit]);
    else existing.push(edit);
  };

  for (const hit of hits) {
    addEdit(hit.toc.file, {
      start: hit.entry.innerStart,
      end: hit.entry.innerEnd,
      expect: hit.entry.raw,
      where: hit.entry.where,
      open: '',
      close: '',
    });
  }

  const zipReader = new ZipReader(inputPath);
  await zipReader.open();
  try {
    const chapterXhtml = (await zipReader.readEntry(chapterFile)).toString('utf8');
    const docTitle = findDocTitle(chapterXhtml);
    if (docTitle === null) {
      throw new Error(
        `${path.basename(inputPath)}: ${chapterFile} has no <head><title> to rename. The chapter's `
        + 'name lives in more than one place and this book is missing one of them, so nothing was '
        + 'written — renaming half of it would leave the book saying two different things.'
      );
    }
    addEdit(chapterFile, {
      start: docTitle.innerStart,
      end: docTitle.innerEnd,
      expect: chapterXhtml.slice(docTitle.innerStart, docTitle.innerEnd),
      where: `the <head><title> of ${chapterFile}`,
      open: docTitle.open,
      close: docTitle.close,
    });

    const replacements = new Map<string, Buffer>();
    for (const [file, list] of edits) {
      const source = file === chapterFile
        ? chapterXhtml
        : (await zipReader.readEntry(file)).toString('utf8');
      replacements.set(
        file,
        Buffer.from(applyEdits(source, list, path.basename(inputPath), file, title), 'utf8'),
      );
    }

    const zipWriter = new ZipWriter();
    for (const entry of zipReader.getEntries()) {
      const replaced = replacements.get(entry);
      const data = replaced === undefined ? await zipReader.readEntry(entry) : replaced;
      // `mimetype` is stored, never deflated — the EPUB spec requires it, and a
      // compressed one makes the book unopenable in strict readers.
      zipWriter.addFile(entry, data, entry !== 'mimetype');
    }
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await zipWriter.write(outputPath);
  } finally {
    zipReader.close();
  }
}

/** One file's ranges replaced with the new title, back to front so offsets hold. */
function applyEdits(
  source: string,
  edits: readonly TitleEdit[],
  bookName: string,
  file: string,
  title: string,
): string {
  const ordered = edits.slice().sort((a, b) => b.start - a.start);
  let out = source;
  let previousStart = source.length;
  for (const edit of ordered) {
    if (source.slice(edit.start, edit.end) !== edit.expect) {
      throw new Error(
        `${bookName}: ${edit.where} is not where it was read from — ${file} says `
        + `"${source.slice(edit.start, edit.end)}" where the parse found "${edit.expect}". The `
        + 'file changed between being read and being rewritten; nothing was written.'
      );
    }
    if (edit.end > previousStart) {
      throw new Error(
        `${bookName}: ${edit.where} overlaps another name being rewritten in ${file}, so one `
        + 'rewrite would land inside the other. Nothing was written.'
      );
    }
    previousStart = edit.start;
    out = out.slice(0, edit.start) + edit.open + escapeXmlText(title) + edit.close + out.slice(edit.end);
  }
  return out;
}

/**
 * Rename one chapter of one book file, in every table of contents it carries.
 *
 * Split out from `renameBookChapter` because it is the whole of the edit and
 * says nothing about a project: the book is read, the entries that name the
 * document are found, and the result is written to `outputPath` with the input
 * untouched. The project's records — which file is the book, what is stamped
 * with its bytes — are `renameBookChapter`'s subject and this one's caller's.
 */
export async function renameChapterInBookFile(
  inputPath: string,
  outputPath: string,
  file: string,
  title: string,
): Promise<{ previousTitle: string; rewrittenTocs: string[] }> {
  const chapterFile = normalizeEntryName(file);
  const bookName = path.basename(inputPath);
  const tocs = await readTocs(inputPath);
  const hits = entriesForDocument(tocs, chapterFile, bookName);
  if (hits.length === 0) {
    throw new Error(
      `${bookName}'s table of contents does not list ${chapterFile}, so that document is not a `
      + 'chapter of this book and has no title to change. The book lists '
      + `${tocs.map((t) => `${t.entries.length} chapter(s) in ${t.file}`).join(' and ')}.`
    );
  }
  await rewriteChapterTitle(inputPath, outputPath, hits, chapterFile, title);
  return {
    // The first table of contents' name for it. Where a book's two lists already
    // disagreed about this chapter, this rename is what ends the disagreement,
    // and the nav's is the one a reader was seeing.
    previousTitle: hits[0].entry.title,
    rewrittenTocs: hits.map((h) => h.toc.file),
  };
}

/**
 * Rename one chapter of the project's book, in the book.
 *
 * `file` is the chapter document's zip entry name — the same identity a
 * narration strike is recorded under (`<zip entry>#<index>`), which is how the
 * picker knows which chapter a block on screen belongs to without ever having to
 * work it out from a page number. Every refusal names what was missing: a
 * project with no book, a document the table of contents does not list, an empty
 * title.
 *
 * `familyId` says which chain's book is being renamed. Absent is the ordinary
 * case, a project with a single chain; a project with several refuses rather
 * than guessing which table of contents to edit.
 */
export async function renameBookChapter(
  projectDir: string,
  file: string,
  rawTitle: string,
  familyId?: string,
): Promise<BookChapterRenameResult> {
  const title = rawTitle.trim();
  if (title.length === 0) {
    throw new Error(
      'A chapter title cannot be empty. A chapter with no name is one the audiobook announces as '
      + 'silence and a reader cannot navigate to; to say a heading is not a chapter opening, '
      + 'relabel the block instead.'
    );
  }

  const book = await manifestService.readExportEpub(projectDir, familyId);
  if (!book) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB recorded (manifest outputs.epub), so there is `
      + 'no table of contents to rename a chapter in. Convert the PDF to an EPUB first.'
    );
  }
  if (!fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s manifest records its book as ${book.relPath}, but there is no `
      + `file at ${book.absPath}. Nothing was renamed.`
    );
  }

  const chapterFile = normalizeEntryName(file);

  // The book as it stands, measured BEFORE the rewrite: it is what says whether
  // the records stamped with it were describing this book a moment ago.
  const { sha256: before } = await sha256File(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
  const narration = await manifestService.readNarrationEpub(projectDir, familyId);

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `retitle-${before.slice(0, 16)}.epub`);
  const renamed = await renameChapterInBookFile(book.absPath, staged, chapterFile, title);
  await moveIntoPlace(staged, book.absPath);

  const { sha256: after } = await sha256File(book.absPath);
  const at = new Date().toISOString();
  await manifestService.touchBookEpub(projectDir, at, familyId);

  // The strikes still name the same elements — see this file's header for the
  // proof — so they are re-stamped rather than left to read as stale. A record
  // that was ALREADY about some other version of the book is left exactly as it
  // is: it is void, and re-stamping it here would forge agreement with a book it
  // was never made against.
  if (recorded !== null && recorded.epubSha256 === before) {
    await manifestService.writeNarrationDeletions(projectDir, {
      ...recorded,
      epubSha256: after,
      updatedAt: at,
    }, familyId);
  }

  let narrationCopy: BookChapterRenameResult['narrationCopy'] = 'none';
  if (narration !== null && fs.existsSync(narration.absPath)) {
    const manifest = await manifestService.readNarrationEpubRecord(projectDir, familyId);
    if (manifest !== null && manifest.fromEpubSha256 === before) {
      // The copy carries byte-identical tables of contents and the same chapter
      // documents, so the same edits land in the same places. Its own parse is
      // run against ITS bytes rather than reusing the book's offsets: the copy
      // has had elements removed and `<sup>` markers stripped, so an offset
      // measured in the book would point somewhere else entirely in the copy.
      const copyTocs = await readTocs(narration.absPath);
      const copyHits = entriesForDocument(
        copyTocs, chapterFile, path.basename(narration.absPath));
      if (copyHits.length === 0) {
        // ── Two reasons this document is not in the copy, and only one is a bug ──
        //
        // A document the strikes EMPTIED is removed from the narration copy on
        // purpose — file, OPF entry and table-of-contents entry together — so it
        // being absent here is the pruning working, not the two files coming
        // apart. The record says which documents went (`removedDocuments`), so
        // the two cases are distinguished by asking it rather than by guessing
        // from the absence, which looks identical either way.
        //
        // Renaming a chapter that is not IN the narration copy is not a failure
        // at all: the book keeps the new title, and the copy has nothing to
        // carry it on. Reported as `pruned` so the caller can say that instead
        // of a sentence about corruption.
        if ((manifest.removedDocuments ?? []).includes(chapterFile)) {
          narrationCopy = 'chapter-pruned';
        } else {
          throw new Error(
            `The book was renamed, but ${path.basename(narration.absPath)} — the narration copy cut `
            + `from it — does not list ${chapterFile} in its table of contents. The two files have `
            + 'come apart; export the narration copy again.'
          );
        }
      } else {
        const stagedCopy = path.join(STAGING_DIR, `retitle-tts-${before.slice(0, 16)}.epub`);
        await rewriteChapterTitle(
          narration.absPath, stagedCopy, copyHits, chapterFile, title);
        await moveIntoPlace(stagedCopy, narration.absPath);
        await manifestService.registerNarrationEpub(projectDir, {
          ...manifest,
          modifiedAt: at,
          // It is still the same cut of the same book — only the chapter's name
          // has moved, in both files at once — so the record follows the book's
          // new sha rather than declaring the copy stale over an edit it also
          // received.
          fromEpubSha256: after,
        }, familyId);
        narrationCopy = 'updated';
      }
    } else {
      narrationCopy = 'already-stale';
    }
  }

  return {
    file: chapterFile,
    title,
    previousTitle: renamed.previousTitle,
    bookSha256: after,
    narrationCopy,
    rewrittenTocs: renamed.rewrittenTocs,
  };
}
