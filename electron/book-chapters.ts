/**
 * book-chapters — what the project's book calls each of its chapters, and the
 * two edits that change it.
 *
 * ── Two edits, because a book can be silent about a document ────────────────
 *
 * A RENAME replaces the text of an entry the book already carries. An ADD
 * inserts one for a spine document no table of contents names. They were one
 * operation for as long as the second did not exist, and the gap showed: Owen,
 * 2026-08-10, promoted a block to `chapter` in an unlisted document and was told
 * to "rename the chapter to give it one" — advice the rename then refused,
 * correctly, because there was no entry to replace. Adding the entry is a
 * different edit and is `addChapterToBookFile`; everything below about where the
 * title lives, which lists it lives in, and what moves with it is true of both.
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

import { EpubProcessor, type EpubStructure } from './epub-processor';
import {
  createEpubSink,
  openEpubSource,
  removeEpubContainer,
  stagedContainerKindFor,
  type EpubContainerKind,
  type EpubSource,
} from './epub-container';
import { moveIntoPlace } from './processing-passes';
import { bookDigest } from './sidecar-binding';
import * as manifestService from './manifest-service';
import { chapterOpeningRefusal } from '../shared/document/chapter-opening-report';
import { parseNarrationElementKey } from '../shared/vlm/narration-deletions';
import type {
  BookChapterAddResult,
  BookChapterRenameResult,
  BookChapterTitle,
  BookChapterTitles,
} from '../shared/vlm/chapter-titles';

export type {
  BookChapterAddResult, BookChapterRenameResult, BookChapterTitle, BookChapterTitles,
};

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * The suffix a staged book carries while it is between the edit and the move.
 *
 * NOT `.epub`. These names used to end in it, and the name was a claim the code
 * could not keep: a staged copy of a book is whatever container the book is —
 * the working copy becomes an exploded directory in phase 2c, and
 * `retitle-<sha>.epub` would then be a DIRECTORY called `.epub`. Nothing reads
 * these paths by extension (the container is stated at the sink and read off the
 * filesystem at the source), so the honest name costs nothing and stops the
 * next reader of this file believing a file is what it will find.
 */
const STAGED_SUFFIX = '.staged-book';

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

/** How a book says what it contains: every list it navigates by, and its order. */
interface BookNavigation {
  tocs: TocDocument[];
  /**
   * Every spine document, as zip entry names, in reading order.
   *
   * The book's own answer to "which documents does this contain, and in what
   * order" — which is what an INSERT has to be measured against, because a new
   * table-of-contents entry belongs where the document it names sits in the
   * reading order and nowhere else.
   */
  spine: string[];
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
  const tocInner = navTocRegion(navXhtml, navFile, bookName);

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

/** A region of a file, and where it starts, so offsets inside it are the file's. */
interface FileRegion {
  text: string;
  offset: number;
}

/**
 * The inside of the navigation document's `<nav epub:type="toc">`, and where it
 * begins in the file.
 *
 * Scoped to that one nav and refused when there is none. EPUB 3 REQUIRES it —
 * it IS the table of contents — and a navigation document without one either is
 * not one or belongs to a book this app did not write; in either case guessing
 * which of its `<nav>`s is the TOC would edit the landmarks or the page list.
 *
 * Read by both the parse and the insert, so "where the table of contents is" has
 * one answer: an insert that found the list somewhere the parse did not read
 * would put a chapter where nothing can see it.
 */
function navTocRegion(navXhtml: string, navFile: string, bookName: string): FileRegion {
  const tocOpen = /<nav\b([^>]*)>/gi;
  for (let m = tocOpen.exec(navXhtml); m !== null; m = tocOpen.exec(navXhtml)) {
    if (!/epub:type\s*=\s*["'][^"']*\btoc\b/i.test(m[1])) continue;
    const start = m.index + m[0].length;
    const end = navXhtml.indexOf('</nav>', start);
    if (end < 0) {
      throw new Error(
        `${bookName}: its navigation document opens a table of contents that is never closed `
        + `(no </nav> after the <nav epub:type="toc">). The file is not well-formed, so nothing `
        + 'was written.'
      );
    }
    return { text: navXhtml.slice(start, end), offset: start };
  }
  throw new Error(
    `${bookName}: its navigation document (${navFile}) declares no table of contents — there is `
    + 'no <nav epub:type="toc"> in it — so there is no chapter list to edit. An EPUB 3 book '
    + 'is required to have one; this book was written by something that did not write it.'
  );
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
  const map = ncxNavMapRegion(ncxXml, ncxFile, bookName);
  const mapStart = map.offset;
  const mapEnd = map.offset + map.text.length;

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

/**
 * The inside of the NCX's `<navMap>`, and where it begins in the file.
 *
 * Scoped to the navMap for the same reason the nav parse is scoped to
 * `epub:type="toc"`: an NCX may also carry a `pageList` and a `navList`, whose
 * labels are page numbers and lists of figures, not chapter names. Read by both
 * the parse and the insert, so the two cannot disagree about where the book's
 * chapters are written down.
 */
function ncxNavMapRegion(ncxXml: string, ncxFile: string, bookName: string): FileRegion {
  const mapOpen = new RegExp(`<${ncxTag('navMap')}\\b[^>]*>`, 'i').exec(ncxXml);
  if (mapOpen === null) {
    throw new Error(
      `${bookName}: its NCX table of contents (${ncxFile}) has no <navMap>, so it names no chapter `
      + 'and there is nothing to edit in it. An NCX is required to have one; this book carries a '
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
      + 'The file is not well-formed, so nothing was written.'
    );
  }
  return { text: ncxXml.slice(mapStart, closed.index), offset: mapStart };
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
async function readNavigation(bookPath: string): Promise<BookNavigation> {
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

    // The reading order, taken off the same list `walkEpubElements` walks — the
    // spine as the OPF declares it, minus any itemref whose media type is not a
    // document, and a document listed twice counted once. Anything else here
    // would be a second opinion about what this book's documents are, and the
    // insert's position is measured in it.
    const spine: string[] = [];
    const seen = new Set<string>();
    for (const chapter of structure.chapters) {
      const entry = normalizeEntryName(processor.resolvePath(chapter.href));
      if (seen.has(entry)) continue;
      seen.add(entry);
      spine.push(entry);
    }

    return { tocs, spine };
  } finally {
    processor.close();
  }
}

/** Just the lists, for the callers that have no question about the spine. */
async function readTocs(bookPath: string): Promise<TocDocument[]> {
  return (await readNavigation(bookPath)).tocs;
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
  const { tocs, spine } = await readNavigation(bookPath);

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

  // Every document the book READS but does not NAME. Taken from the spine and
  // not from the manifest, because the manifest also declares the nav document,
  // the stylesheets and the plates — none of which is a chapter that could be
  // given a name — while the spine is exactly the list of things a reader turns
  // through.
  const listed = new Set<string>();
  for (const toc of tocs) for (const entry of toc.entries) listed.add(entry.file);
  const unlistedDocuments = spine.filter((file) => !listed.has(file));

  return { bookPath, tocFiles: tocs.map((t) => t.file), chapters, unlistedDocuments };
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

  const zipReader = await openEpubSource(inputPath);
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
    await writeBookWithReplacements(
      zipReader, outputPath, replacements, await stagedContainerKindFor(inputPath));
  } finally {
    zipReader.close();
  }
}

/**
 * The book copied entry for entry, with the named entries' bytes swapped.
 *
 * Every OTHER entry is carried across untouched — the print, the `data-bf-cat`
 * stamps, the plates, the whitespace foundry laid out — which is what keeps the
 * aligner's unit list, the narration keys taken off it and any diff a person
 * runs describing the same book.
 */
async function writeBookWithReplacements(
  zipReader: EpubSource,
  outputPath: string,
  replacements: ReadonlyMap<string, Buffer>,
  /**
   * The container the staged result is written as. It is the container of the
   * BOOK this result replaces, measured — `stagedContainerKindFor` — because the
   * staging name (`retitle-<sha>.epub`, in a temp directory) says nothing true
   * about what is inside it, and `moveIntoPlace` lands whatever this wrote onto
   * a working copy that is a folder of its parts.
   */
  outputKind: EpubContainerKind,
): Promise<void> {
  const zipWriter = await createEpubSink(outputPath, outputKind);
  for (const entry of zipReader.getEntries()) {
    const replaced = replacements.get(entry);
    const data = replaced === undefined ? await zipReader.readEntry(entry) : replaced;
    // `mimetype` is stored, never deflated — the EPUB spec requires it, and a
    // compressed one makes the book unopenable in strict readers.
    zipWriter.addFile(entry, data, entry !== 'mimetype');
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await zipWriter.write(outputPath);
}

/** One file's ranges replaced with the new title, back to front so offsets hold. */
function applyEdits(
  source: string,
  edits: readonly TitleEdit[],
  bookName: string,
  file: string,
  title: string,
): string {
  return applySplices(source, edits.map((edit) => ({
    start: edit.start,
    end: edit.end,
    expect: edit.expect,
    where: edit.where,
    text: edit.open + escapeXmlText(title) + edit.close,
  })), bookName, file);
}

/** One range of one file, and the exact text written over it. */
interface FileSplice {
  start: number;
  /** Equal to `start` for a pure insertion, which replaces nothing. */
  end: number;
  /** The bytes expected there, so an offset that has slipped is caught, not written. */
  expect: string;
  /** How this place is named in a refusal. */
  where: string;
  /** What goes there, already escaped for the markup it lands in. */
  text: string;
}

/**
 * One file's splices applied back to front, so every offset still means what the
 * parse measured.
 *
 * Both guards are the point rather than defensive noise. `expect` catches an
 * offset measured against bytes the file no longer has, which would otherwise
 * write a title into the middle of a tag; the overlap check catches two edits
 * landing inside each other, which is real in a book whose printed contents page
 * IS its navigation document — that file takes an entry's edit and its own
 * `<head><title>`'s in the same pass.
 */
function applySplices(
  source: string,
  splices: readonly FileSplice[],
  bookName: string,
  file: string,
): string {
  const ordered = splices.slice().sort((a, b) => b.start - a.start);
  let out = source;
  let previousStart = source.length;
  for (const splice of ordered) {
    if (source.slice(splice.start, splice.end) !== splice.expect) {
      throw new Error(
        `${bookName}: ${splice.where} is not where it was read from — ${file} says `
        + `"${source.slice(splice.start, splice.end)}" where the parse found "${splice.expect}". The `
        + 'file changed between being read and being rewritten; nothing was written.'
      );
    }
    if (splice.end > previousStart) {
      throw new Error(
        `${bookName}: ${splice.where} overlaps another edit being made to ${file}, so one `
        + 'would land inside the other. Nothing was written.'
      );
    }
    previousStart = splice.start;
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
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

// ─────────────────────────────────────────────────────────────────────────────
// The add
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One table of contents' top-level items, and where a first item would go.
 *
 * TOP-LEVEL because a table of contents nests — a part heading holds the
 * chapters under it — and a new chapter is a chapter of the BOOK, not of
 * whichever part happens to precede it in the file. An entry is placed after the
 * whole subtree its predecessor belongs to, which is what `items` measures.
 */
interface TocListShape {
  /** Inside the list's own container: where an item goes when there are none. */
  innerStart: number;
  /** The top-level items, in document order, each as [start, end) of the whole item. */
  items: Array<{ start: number; end: number }>;
}

/**
 * The items of one nesting list, at depth zero only.
 *
 * Read by scanning open and close tags and counting depth, for the reason
 * `parseNcxNavMap` gives about navPoints: matching `<li>…</li>` non-greedily
 * swallows the first nested item inside its parent's match and loses a whole
 * level of the list without saying so.
 */
function topLevelItems(
  inner: FileRegion,
  tag: string,
  bookName: string,
  file: string,
): Array<{ start: number; end: number }> {
  const token = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi');
  const items: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  for (let m = token.exec(inner.text); m !== null; m = token.exec(inner.text)) {
    const at = inner.offset + m.index;
    if (m[1] === '/') {
      depth--;
      if (depth < 0) {
        throw new Error(
          `${bookName}: ${file} closes a <${tag}> that was never opened, so its table of contents `
          + 'cannot be read as a list and nothing was written.'
        );
      }
      if (depth === 0) { items.push({ start, end: at + m[0].length }); start = -1; }
    } else if (m[2] === '/') {
      if (depth === 0) items.push({ start: at, end: at + m[0].length });
    } else {
      if (depth === 0) start = at;
      depth++;
    }
  }
  if (depth !== 0) {
    throw new Error(
      `${bookName}: ${file} leaves ${depth} <${tag}> element(s) unclosed in its table of contents. `
      + 'The file is not well-formed, so nothing was written.'
    );
  }
  return items;
}

/** The EPUB 3 navigation document's own chapter list, as a shape to insert into. */
function navListShape(
  navXhtml: string,
  navFile: string,
  bookName: string,
): TocListShape {
  const toc = navTocRegion(navXhtml, navFile, bookName);
  const open = /<ol\b([^>]*?)(\/?)>/i.exec(toc.text);
  if (open === null) {
    throw new Error(
      `${bookName}: the table of contents in ${navFile} contains no <ol>, so it has no list for a `
      + 'chapter to be added to. EPUB 3 requires the nav\'s entries to be an ordered list; nothing '
      + 'was written.'
    );
  }
  if (open[2] === '/') {
    throw new Error(
      `${bookName}: the table of contents in ${navFile} is a self-closed <ol/> with no list inside `
      + 'it, so it names no chapter and there is nowhere to put one. Nothing was written.'
    );
  }
  const listInner: FileRegion = (() => {
    const start = open.index + open[0].length;
    // The matching close, by depth: a nested `<ol>` under a part heading is
    // ordinary, and the first `</ol>` in the file would close the wrong one.
    const token = /<(\/?)ol\b[^>]*?(\/?)>/gi;
    token.lastIndex = start;
    let depth = 1;
    for (let m = token.exec(toc.text); m !== null; m = token.exec(toc.text)) {
      if (m[2] === '/') continue;
      depth += m[1] === '/' ? -1 : 1;
      if (depth === 0) {
        return { text: toc.text.slice(start, m.index), offset: toc.offset + start };
      }
    }
    throw new Error(
      `${bookName}: the table of contents in ${navFile} opens an <ol> that is never closed. The `
      + 'file is not well-formed, so nothing was written.'
    );
  })();

  return {
    innerStart: listInner.offset,
    items: topLevelItems(listInner, 'li', bookName, navFile),
  };
}

/** The NCX's navMap, as a shape to insert into. */
function ncxListShape(ncxXml: string, ncxFile: string, bookName: string): TocListShape {
  const map = ncxNavMapRegion(ncxXml, ncxFile, bookName);
  return {
    innerStart: map.offset,
    items: topLevelItems(map, ncxTag('navPoint'), bookName, ncxFile),
  };
}

/**
 * Where a new entry goes in one table of contents, in SPINE ORDER.
 *
 * The last entry the list already carries whose document is read BEFORE the new
 * one, and then the whole top-level item that entry belongs to — so a chapter
 * added after the last chapter of "Part One" lands after Part One and not inside
 * it. No such entry means the new chapter is read before everything the list
 * names, which is the front of the list.
 *
 * Entries naming a document outside the spine — a linked appendix the reading
 * order does not include — are skipped rather than guessed at: there is no
 * position in the reading order to compare them by.
 */
function insertionPoint(
  toc: TocDocument,
  shape: TocListShape,
  spineIndex: ReadonlyMap<string, number>,
  newIndex: number,
  bookName: string,
): { at: number; after: { start: number; end: number } | null } {
  let anchor: TocEntry | null = null;
  for (const entry of toc.entries) {
    const index = spineIndex.get(entry.file);
    if (index === undefined) continue;
    if (index < newIndex) anchor = entry;
  }
  if (anchor === null) {
    const first = shape.items[0];
    return { at: first === undefined ? shape.innerStart : first.start, after: null };
  }

  const holder = shape.items.find(
    (item) => anchor!.innerStart >= item.start && anchor!.innerStart < item.end);
  if (holder === undefined) {
    throw new Error(
      `${bookName}: ${anchor.where} sits outside the list its ${tocDescription(toc)} is written as, `
      + 'so there is no item for a new chapter to be placed after. Nothing was written.'
    );
  }
  return { at: holder.end, after: holder };
}

/** The whitespace a line begins with, or null when this offset is mid-line. */
function lineIndentBefore(source: string, offset: number): string | null {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const gap = source.slice(lineStart, offset);
  return /^[ \t]*$/.test(gap) ? gap : null;
}

/**
 * The new entry's markup with the surrounding document's own line breaks.
 *
 * A book whose entries each own a line gets one more line, indented as its
 * neighbours are; a book that writes its whole list on one line gets one more
 * item on that line. Neither is a preference — a table of contents rewritten
 * into a shape its author did not use shows up as a whole-file diff in a book
 * that is also an alignment baseline.
 */
function laidOutEntry(
  source: string,
  point: { at: number; after: { start: number; end: number } | null },
  markup: string,
): string {
  const anchorStart = point.after === null
    // Inserting first: the item the new one will push down is the one to match.
    ? point.at
    : point.after.start;
  const indent = lineIndentBefore(source, anchorStart);
  if (indent === null) return markup;
  return point.after === null ? `${markup}\n${indent}` : `\n${indent}${markup}`;
}

/**
 * The chapter's path as this table of contents has to write it — relative to
 * the list's own file, and percent-encoded where a literal character could not
 * survive an XML attribute.
 *
 * Percent-encoding rather than `&amp;`, because the hrefs are read back by
 * `resolveTocTarget` off the raw markup and it resolves a percent escape (a book
 * Calibre wrote is full of them) but not an entity. An entry the book's own
 * reader could not follow back to its document is the one thing this may not
 * write.
 */
function hrefFromTocTo(tocFile: string, target: string): string {
  const tocDir = tocFile.includes('/') ? tocFile.slice(0, tocFile.lastIndexOf('/')).split('/') : [];
  const parts = target.split('/');
  let shared = 0;
  while (shared < tocDir.length && shared < parts.length - 1 && tocDir[shared] === parts[shared]) {
    shared++;
  }
  const up = new Array(tocDir.length - shared).fill('..');
  const relative = [...up, ...parts.slice(shared)].join('/');
  return relative.replace(/[%&<>"'#]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** One navPoint's `playOrder`, as the value and the range a renumber replaces. */
interface PlayOrderAttribute {
  start: number;
  end: number;
  raw: string;
  value: number;
  where: string;
  /** Where the navPoint's own open tag begins, which is what "after" is measured by. */
  tagStart: number;
}

/**
 * Every navPoint's `playOrder`, in document order — or none, for an NCX that
 * states no reading order at all.
 *
 * Both are ordinary and the third case is not: an NCX where SOME navPoints carry
 * a playOrder and others do not, or where one is not a number, states a reading
 * order it cannot complete. Inserting into it would either leave two navPoints
 * claiming the same position or silently invent one, so it is refused by name.
 */
function playOrders(ncxXml: string, ncxFile: string, bookName: string): PlayOrderAttribute[] {
  const map = ncxNavMapRegion(ncxXml, ncxFile, bookName);
  const pointOpen = new RegExp(`<${ncxTag('navPoint')}\\b([^>]*)>`, 'gi');
  const found: PlayOrderAttribute[] = [];
  let points = 0;
  for (let m = pointOpen.exec(map.text); m !== null; m = pointOpen.exec(map.text)) {
    points++;
    const tagStart = map.offset + m.index;
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(m[1]);
    const where = `${id === null ? `navPoint ${points}` : `navPoint "${id[1]}"`} of ${ncxFile}`;
    const attr = /\bplayOrder\s*=\s*["']([^"']*)["']/i.exec(m[1]);
    if (attr === null) continue;
    // The value's offset in the FILE: the tag, then where the attribute list
    // begins inside it (`<navPoint` + attrs + `>`), then where the quoted value
    // begins inside the attribute.
    const valueStart = tagStart
      + (m[0].length - m[1].length - 1)
      + attr.index
      + (attr[0].length - attr[1].length - 1);
    const value = /^\d+$/.test(attr[1]) ? Number(attr[1]) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error(
        `${bookName}: ${where} carries playOrder="${attr[1]}", which is not a number, so the `
        + 'reading order after a new chapter cannot be renumbered. Nothing was written.'
      );
    }
    found.push({ start: valueStart, end: valueStart + attr[1].length, raw: attr[1], value, where, tagStart });
  }
  if (found.length !== 0 && found.length !== points) {
    throw new Error(
      `${bookName}: ${ncxFile} states a playOrder on ${found.length} of its ${points} navPoints and `
      + 'leaves the rest without one, so the reading order it declares is incomplete and a new '
      + 'chapter cannot be numbered into it. Nothing was written.'
    );
  }
  return found;
}

/** An id nothing in this file already carries. */
function freeNavPointId(ncxXml: string): string {
  const taken = new Set<string>();
  const idAttr = /\bid\s*=\s*["']([^"']*)["']/gi;
  for (let m = idAttr.exec(ncxXml); m !== null; m = idAttr.exec(ncxXml)) taken.add(m[1]);
  for (let n = 1; ; n++) {
    const candidate = `bf-chapter-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** What one table of contents has to have written into it for the chapter to be listed. */
interface TocInsertPlan {
  toc: TocDocument;
  splices: FileSplice[];
  /** The position the new entry will occupy in this list's own entries. */
  entryIndex: number;
}

/**
 * List one document in one table of contents, said as splices into its file.
 *
 * The entry is BUILT rather than copied from a neighbour: a neighbour's markup
 * carries its own `id`, its own classes and, in an NCX, its own place in the
 * reading order, and an entry that inherited any of them would be a second
 * element claiming to be the first.
 */
function planTocInsert(
  source: string,
  toc: TocDocument,
  shape: TocListShape,
  spineIndex: ReadonlyMap<string, number>,
  newIndex: number,
  chapterFile: string,
  title: string,
  bookName: string,
): TocInsertPlan {
  const point = insertionPoint(toc, shape, spineIndex, newIndex, bookName);
  const href = hrefFromTocTo(toc.file, chapterFile);
  const splices: FileSplice[] = [];

  let markup: string;
  if (toc.kind === 'nav') {
    markup = `<li><a href="${href}">${escapeXmlText(title)}</a></li>`;
  } else {
    const orders = playOrders(source, toc.file, bookName);
    const following = orders.filter((order) => order.tagStart >= point.at);
    const numbered = orders.length === 0
      ? ''
      : ` playOrder="${following.length === 0
        ? Math.max(...orders.map((o) => o.value)) + 1
        : following[0].value}"`;
    for (const order of following) {
      splices.push({
        start: order.start,
        end: order.end,
        expect: order.raw,
        where: `the playOrder of ${order.where}`,
        text: String(order.value + 1),
      });
    }
    markup = `<navPoint id="${freeNavPointId(source)}"${numbered}>`
      + `<navLabel><text>${escapeXmlText(title)}</text></navLabel>`
      + `<content src="${href}"/></navPoint>`;
  }

  splices.push({
    start: point.at,
    end: point.at,
    expect: '',
    where: `the new entry for ${chapterFile} in ${toc.file}`,
    text: laidOutEntry(source, point, markup),
  });

  return {
    toc,
    splices,
    entryIndex: toc.entries.filter((entry) => entry.innerStart < point.at).length,
  };
}

/**
 * List one spine document of one book file in every table of contents it
 * carries, staged to `outputPath` with the input untouched.
 *
 * ── Why an add and not a rename with an empty "before" ──────────────────────
 *
 * A rename replaces the text of an entry the book already has, and it refuses a
 * document no table of contents lists — correctly, because there is nothing
 * there to replace. That refusal was also a dead end: promoting a block to
 * `chapter` in an unlisted document told the user "Rename the chapter to give it
 * one", and the rename then refused for the same reason it always had. This is
 * the operation that advice was describing, and it is a different edit: markup
 * is INSERTED, in spine order, into every list the book navigates by.
 *
 * ── What is not done ───────────────────────────────────────────────────────
 *
 * The table of contents is not regenerated and no second store is written. The
 * book states what it contains; this adds one line to that statement and leaves
 * every other byte — including every other entry, character for character —
 * exactly as the book had it, which the verification below proves before the
 * output is allowed to exist.
 */
export async function addChapterToBookFile(
  inputPath: string,
  outputPath: string,
  file: string,
  rawTitle: string,
): Promise<{ rewrittenTocs: string[]; rewrittenEntries: string[] }> {
  const bookName = path.basename(inputPath);
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (title.length === 0) {
    throw new Error(
      'A chapter title cannot be empty. A chapter with no name is one the audiobook announces as '
      + 'silence and a reader cannot navigate to; to say a heading is not a chapter opening, '
      + 'relabel the block instead.'
    );
  }

  const chapterFile = normalizeEntryName(file);
  const { tocs, spine } = await readNavigation(inputPath);

  const newIndex = spine.indexOf(chapterFile);
  if (newIndex < 0) {
    throw new Error(
      `${bookName} does not read ${chapterFile} — it is not in the book's spine, so it is not a `
      + 'document a reader ever reaches and listing it in the table of contents would name a '
      + `chapter nobody can turn to. The book reads ${spine.length} document(s). Nothing was `
      + 'written.'
    );
  }

  const already = tocs.filter((toc) => toc.entries.some((entry) => entry.file === chapterFile));
  if (already.length > 0) {
    const named = already
      .map((toc) => {
        const entry = toc.entries.find((e) => e.file === chapterFile)!;
        return `${tocDescription(toc)} already calls it "${entry.title}"`;
      })
      .join(', and ');
    throw new Error(
      `${bookName}: ${named}. A document the book already lists is renamed, not added — the add `
      + 'would give it a second entry and a reader would find the same chapter twice. Rename the '
      + 'chapter instead. Nothing was written.'
    );
  }

  const spineIndex = new Map(spine.map((entry, index) => [entry, index]));
  const plans: TocInsertPlan[] = [];
  const splicesByFile = new Map<string, FileSplice[]>();
  const addSplice = (target: string, splice: FileSplice): void => {
    const existing = splicesByFile.get(target);
    if (existing === undefined) splicesByFile.set(target, [splice]); else existing.push(splice);
  };

  const zipReader = await openEpubSource(inputPath);
  try {
    const sources = new Map<string, string>();
    const sourceOf = async (target: string): Promise<string> => {
      const held = sources.get(target);
      if (held !== undefined) return held;
      const text = (await zipReader.readEntry(target)).toString('utf8');
      sources.set(target, text);
      return text;
    };

    for (const toc of tocs) {
      const source = await sourceOf(toc.file);
      const shape = toc.kind === 'nav'
        ? navListShape(source, toc.file, bookName)
        : ncxListShape(source, toc.file, bookName);
      const plan = planTocInsert(
        source, toc, shape, spineIndex, newIndex, chapterFile, title, bookName);
      plans.push(plan);
      for (const splice of plan.splices) addSplice(toc.file, splice);
    }

    // The chapter document's own `<head><title>`, on exactly the terms a rename
    // writes it on: the name lives in more than one place, and a book that took
    // the entry and not the title would say two different things about the same
    // chapter. A document with no `<head><title>` at all is refused here for the
    // same reason it is refused there, rather than having a `<head>` invented
    // for it.
    const chapterXhtml = await sourceOf(chapterFile);
    const docTitle = findDocTitle(chapterXhtml);
    if (docTitle === null) {
      throw new Error(
        `${bookName}: ${chapterFile} has no <head><title> to name. The chapter's name lives in more `
        + 'than one place and this book is missing one of them, so nothing was written — listing '
        + 'half of it would leave the book saying two different things.'
      );
    }
    addSplice(chapterFile, {
      start: docTitle.innerStart,
      end: docTitle.innerEnd,
      expect: chapterXhtml.slice(docTitle.innerStart, docTitle.innerEnd),
      where: `the <head><title> of ${chapterFile}`,
      text: docTitle.open + escapeXmlText(title) + docTitle.close,
    });

    const replacements = new Map<string, Buffer>();
    for (const [target, splices] of splicesByFile) {
      replacements.set(
        target,
        Buffer.from(applySplices(await sourceOf(target), splices, bookName, target), 'utf8'),
      );
    }
    await writeBookWithReplacements(
      zipReader, outputPath, replacements, await stagedContainerKindFor(inputPath));
  } finally {
    zipReader.close();
  }

  await verifyChapterAdded(inputPath, outputPath, tocs, plans, chapterFile, title);

  return {
    rewrittenTocs: tocs.map((toc) => toc.file),
    rewrittenEntries: [...splicesByFile.keys()],
  };
}

/**
 * Read the book that was just written and check it says what it was asked to.
 *
 * The insert is a string splice into markup this module parsed itself, and the
 * one failure it cannot detect from the inside is having put the entry somewhere
 * that parses as a different list, or having disturbed a neighbour. So the
 * output is parsed as a book — the same parse the picker and the audiobook will
 * use — and compared entry for entry with the input. A book that fails is
 * DELETED rather than left on disk: a staged copy that reached `moveIntoPlace`
 * would become the working copy, and a table of contents nobody checked is what
 * the audiobook is built from.
 */
async function verifyChapterAdded(
  inputPath: string,
  outputPath: string,
  before: readonly TocDocument[],
  plans: readonly TocInsertPlan[],
  chapterFile: string,
  title: string,
): Promise<void> {
  const bookName = path.basename(inputPath);
  const refuse = async (sentence: string): Promise<never> => {
    await removeEpubContainer(outputPath);
    throw new Error(`${bookName}: ${sentence} Nothing was written.`);
  };

  let after: TocDocument[];
  try {
    after = await readTocs(outputPath);
  } catch (err) {
    return refuse(
      `the book written with ${chapterFile} listed cannot be read back as a book `
      + `(${(err as Error).message}).`);
  }

  for (const plan of plans) {
    const rewritten = after.find((toc) => toc.file === plan.toc.file);
    if (rewritten === undefined) {
      return refuse(`${plan.toc.file} is not a table of contents of the book that was written.`);
    }
    const expected = plan.toc.entries.slice();
    const listed = rewritten.entries[plan.entryIndex];
    if (listed === undefined || listed.file !== chapterFile || listed.fragment !== ''
      || listed.title !== title) {
      return refuse(
        `${tocDescription(plan.toc)} was to name ${chapterFile} "${title}" as entry `
        + `${plan.entryIndex + 1} of ${expected.length + 1}, and it now says `
        + `${listed === undefined
          ? 'nothing at that position'
          : `${listed.file} — "${listed.title}"`}.`);
    }
    const others = rewritten.entries.filter((_entry, index) => index !== plan.entryIndex);
    if (others.length !== expected.length) {
      return refuse(
        `${tocDescription(plan.toc)} listed ${expected.length} chapter(s) and now lists `
        + `${rewritten.entries.length}, which is not one more.`);
    }
    for (let i = 0; i < expected.length; i++) {
      if (others[i].file === expected[i].file && others[i].title === expected[i].title
        && others[i].fragment === expected[i].fragment) continue;
      return refuse(
        `${tocDescription(plan.toc)} listed "${expected[i].title}" (${expected[i].file}) and now `
        + `lists "${others[i].title}" (${others[i].file}) in its place — the insert moved a `
        + 'chapter that was already there.');
    }
  }

  // The lists the book did NOT gain an entry in, unchanged: a book carrying a
  // nav and an NCX has both edited, and one of them silently missing the entry
  // is exactly the disagreement this module exists to prevent.
  for (const toc of after) {
    if (plans.some((plan) => plan.toc.file === toc.file)) continue;
    return refuse(`${tocDescription(toc)} appeared in the book that was written and was not edited.`);
  }
  if (after.length !== before.length) {
    return refuse(
      `the book listed ${before.length} table(s) of contents and the one that was written lists `
      + `${after.length}.`);
  }
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

  const book = await manifestService.bookForAct(projectDir, familyId);
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
  const { digest: before, hex: beforeHex } = await bookDigest(book.absPath);
  const narration = await manifestService.readNarrationEpub(projectDir, familyId);

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  // Named from the HEX, not from the recorded digest: an exploded book's digest
  // carries an algorithm tag, and slicing that would give every book in the
  // project the same staging name (shared/book-digest.ts, `bookDigestHex`).
  const staged = path.join(STAGING_DIR, `retitle-${beforeHex.slice(0, 16)}${STAGED_SUFFIX}`);
  const renamed = await renameChapterInBookFile(book.absPath, staged, chapterFile, title);
  await moveIntoPlace(staged, book.absPath);

  const { digest: after } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  // ── ONE transaction: the touch, the re-stamp and the edit-log entry ────────
  //
  // These used to be two separate manifest writes with an await between them,
  // and an interrupt in that gap left the book renamed while the strike record
  // still carried the PREVIOUS book's digest — a void record, which is the state
  // that makes `nameChapterOpenings` refuse and, before MP-C2 was demoted, made
  // the project unopenable. The strikes still name the same elements (see this
  // file's header for the proof), so they are re-stamped rather than migrated; a
  // record that was ALREADY about some other version is left exactly as it is,
  // because re-stamping it would forge agreement with a book it was never made
  // against.
  const renameRecord = await manifestService.recordChapterRename(projectDir, {
    kind: 'rename-chapter',
    at,
    file: chapterFile,
    titleBefore: renamed.previousTitle,
    titleAfter: title,
    fromSha256: before,
    toSha256: after,
  }, familyId);
  if (renameRecord.alreadyVoid) {
    console.warn(
      `[book-chapters] ${path.basename(projectDir)}: ${chapterFile} was renamed, but the narration `
      + 'strikes recorded against this book were already stamped with a different one, so they were '
      + 'left as they are.'
    );
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
        const stagedCopy = path.join(STAGING_DIR, `retitle-tts-${beforeHex.slice(0, 16)}${STAGED_SUFFIX}`);
        await rewriteChapterTitle(
          narration.absPath, stagedCopy, copyHits, chapterFile, title);
        // FILE first, then the record — deliberately the other way round from
        // the book above, and the difference is what an interrupt costs. Here
        // the record only says which book the copy was cut FROM: written first,
        // an interrupt would leave it claiming the copy already carries a title
        // the copy does not have, and narration would read a stale name as
        // current. Written second, the interrupt leaves the copy correct and the
        // record reading `already-stale`, which Export TTS copy fixes by cutting
        // it again. Nothing is lost either way; only one of them can lie.
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
    // The chapter document is in the list because its `<head><title>` was
    // refilled, even though a `<head>` has no pages. A caller that re-derives a
    // stamped copy from these entries needs every entry whose BYTES moved, and
    // the one that only re-lays-out spine documents can tell which is which.
    rewrittenEntries: [...new Set([...renamed.rewrittenTocs, chapterFile])],
  };
}

/**
 * List one spine document of the project's book as a chapter, in the book.
 *
 * ── The gesture this completes ─────────────────────────────────────────────
 *
 * Owen, 2026-08-10, on promoting a block to `chapter` in a document the contents
 * did not list: the app answered "…is not listed under a name in this book's
 * table of contents… Rename the chapter to give it one", and the rename then
 * refused, because a rename replaces an entry and there was none. This is the
 * missing half. The book's table of contents stays the single authority — no
 * second store, no regeneration — and the operation that was missing from it is
 * INSERTING an entry.
 *
 * ── Why the naming pass runs INSIDE this ───────────────────────────────────
 *
 * Unlike a rename, which runs it in the IPC handler, an add is not finished
 * until the page follows. A renamed chapter already had a name and already had
 * an opening printing one; a chapter that has just been LISTED had neither, and
 * a book left with a fresh contents entry and an opening still printing the
 * scan's heading is a half-done act. So the pass is part of the operation, and
 * both callers — the Chapter tab's add and the relabel-to-chapter flow — get the
 * whole of it from one call. That is also what a headless run needs: one door,
 * the same door the app goes through.
 *
 * ── The one shape that is refused ──────────────────────────────────────────
 *
 * A table of contents that is ITSELF a spine document (a printed contents page
 * that is also the nav) gains an ELEMENT when an entry is inserted, so every
 * narration key after it in that document would name something else. Nothing can
 * carry those strikes across an insert, so a strike naming such a document
 * refuses the add before a byte is written rather than re-stamping a record
 * whose positions moved.
 *
 * `familyId` says which chain's book is being listed in. Absent is the ordinary
 * case, a project with a single chain; a project with several refuses rather
 * than guessing which table of contents to edit.
 */
export async function addBookChapter(
  projectDir: string,
  file: string,
  rawTitle: string,
  familyId?: string,
): Promise<BookChapterAddResult> {
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (title.length === 0) {
    throw new Error(
      'A chapter title cannot be empty. A chapter with no name is one the audiobook announces as '
      + 'silence and a reader cannot navigate to; to say a heading is not a chapter opening, '
      + 'relabel the block instead.'
    );
  }

  const book = await manifestService.bookForAct(projectDir, familyId);
  if (!book) {
    throw new Error(
      `${path.basename(projectDir)} has no book EPUB recorded (manifest outputs.epub), so there is `
      + 'no table of contents to list a chapter in. Convert the PDF to an EPUB first.'
    );
  }
  if (!fs.existsSync(book.absPath)) {
    throw new Error(
      `${path.basename(projectDir)}'s manifest records its book as ${book.relPath}, but there is no `
      + `file at ${book.absPath}. Nothing was written.`
    );
  }

  const chapterFile = normalizeEntryName(file);

  // The book as it stands, measured BEFORE the rewrite: it is what says whether
  // the records stamped with it were describing this book a moment ago.
  const { digest: before, hex: beforeHex } = await bookDigest(book.absPath);
  const narration = await manifestService.readNarrationEpub(projectDir, familyId);

  // ── The strikes an insert would move, asked before anything is written ────
  //
  // See this function's header. Only a table of contents that is itself read as
  // a document can move a narration key, and only a record actually stamped with
  // THIS book has positions in it to move — a record about some other version
  // names elements of a file nobody has, and is left to `recordChapterAdd` to
  // report as void rather than being made the reason an add is refused.
  const { tocs, spine } = await readNavigation(book.absPath);
  const readAsDocuments = new Set(spine);
  const movedDocuments = tocs.map((toc) => toc.file).filter((toc) => readAsDocuments.has(toc));
  if (movedDocuments.length > 0) {
    const recorded = await manifestService.readNarrationDeletions(projectDir, familyId);
    if (recorded !== null && recorded.epubSha256 === before) {
      const moved = recorded.elements.filter(
        (key) => movedDocuments.includes(parseNarrationElementKey(key).file));
      if (moved.length > 0) {
        throw new Error(
          `${chapterFile} was not listed in ${path.basename(book.absPath)}'s table of contents, `
          + `because ${movedDocuments.join(' and ')} is both a table of contents and a document `
          + `this book reads, and ${moved.length} narration strike(s) name elements in it `
          + `(${moved.slice(0, 3).join(', ')}). Inserting an entry adds an element to that `
          + 'document, and every strike after it would name a different paragraph. Take those '
          + 'strikes back first, or export the narration copy and strike in that.'
        );
      }
    }
  }

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  // Named from the HEX — see `renameBookChapter` above.
  const staged = path.join(STAGING_DIR, `add-chapter-${beforeHex.slice(0, 16)}${STAGED_SUFFIX}`);
  const added = await addChapterToBookFile(book.absPath, staged, chapterFile, title);
  await moveIntoPlace(staged, book.absPath);

  const { digest: after } = await bookDigest(book.absPath);
  const at = new Date().toISOString();

  // ── ONE transaction: the touch, the re-stamp and the edit-log entry ───────
  //
  // The same single transaction a rename makes, for the same reason: two writes
  // with an await between them leave a window where the book carries the new
  // entry and the strike record still carries the previous book's digest — a
  // void record, which is the state that makes the naming pass refuse.
  const record = await manifestService.recordChapterAdd(projectDir, {
    kind: 'add-chapter',
    at,
    file: chapterFile,
    title,
    tocFiles: added.rewrittenTocs,
    fromSha256: before,
    toSha256: after,
  }, familyId);
  if (record.alreadyVoid) {
    console.warn(
      `[book-chapters] ${path.basename(projectDir)}: ${chapterFile} was listed as "${title}", but `
      + 'the narration strikes recorded against this book were already stamped with a different '
      + 'one, so they were left as they are.'
    );
  }

  let narrationCopy: BookChapterAddResult['narrationCopy'] = 'none';
  if (narration !== null && fs.existsSync(narration.absPath)) {
    const manifest = await manifestService.readNarrationEpubRecord(projectDir, familyId);
    if (manifest !== null && manifest.fromEpubSha256 === before) {
      // The copy carries byte-identical tables of contents and the same spine
      // documents, so the same insert lands in the same place. Its own parse is
      // run against ITS bytes rather than reusing the book's offsets: the copy
      // has had elements removed and `<sup>` markers stripped, so an offset
      // measured in the book would point somewhere else entirely in the copy.
      const copy = await readNavigation(narration.absPath);
      if (!copy.spine.includes(chapterFile)) {
        // ── Two reasons this document is not in the copy, and only one is a bug ──
        //
        // A document the strikes EMPTIED is removed from the narration copy on
        // purpose — file, OPF entry and table-of-contents entry together — so it
        // being absent here is the pruning working, not the two files coming
        // apart. The record says which documents went (`removedDocuments`), so
        // the two cases are distinguished by asking it rather than by guessing
        // from the absence, which looks identical either way.
        if ((manifest.removedDocuments ?? []).includes(chapterFile)) {
          narrationCopy = 'chapter-pruned';
        } else {
          throw new Error(
            `The book now lists ${chapterFile}, but ${path.basename(narration.absPath)} — the `
            + 'narration copy cut from it — does not read that document at all. The two files have '
            + 'come apart; export the narration copy again.'
          );
        }
      } else if (copy.tocs.some((toc) => toc.entries.some((e) => e.file === chapterFile))) {
        throw new Error(
          `The book now lists ${chapterFile}, but ${path.basename(narration.absPath)} — the `
          + 'narration copy, cut from a book that did NOT list it — already names it in its own '
          + 'table of contents. The two files have come apart; export the narration copy again.'
        );
      } else {
        const stagedCopy = path.join(STAGING_DIR, `add-chapter-tts-${beforeHex.slice(0, 16)}${STAGED_SUFFIX}`);
        await addChapterToBookFile(narration.absPath, stagedCopy, chapterFile, title);
        // FILE first, then the record — deliberately the other way round from
        // the book above, and the difference is what an interrupt costs. Here
        // the record only says which book the copy was cut FROM: written first,
        // an interrupt would leave it claiming the copy already lists a chapter
        // the copy does not list. Written second, the interrupt leaves the copy
        // correct and the record reading `already-stale`, which Export TTS copy
        // fixes by cutting it again. Nothing is lost either way; only one of
        // them can lie.
        await moveIntoPlace(stagedCopy, narration.absPath);
        await manifestService.registerNarrationEpub(projectDir, {
          ...manifest,
          modifiedAt: at,
          // Still the same cut of the same book — the chapter it gained a name
          // for is one the copy also gained — so the record follows the book's
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

  // ── The print follows the name ────────────────────────────────────────────
  //
  // The chapter has a stored name now, so the pass that writes each chapter's
  // name into its opening has something to write for the first time. Imported
  // here rather than at the top because narration-export reads this module's
  // `readChapterTitlesOfBook`, and two modules importing each other at load time
  // is a cycle; the pass is only ever needed once this has run.
  const rewrittenEntries = new Set(added.rewrittenEntries);
  let openingsNamed = 0;
  let openingUnnamed: string | null = null;
  try {
    const { nameChapterOpenings } = await import('./narration-export.js');
    const summary = await nameChapterOpenings(projectDir, familyId);
    openingsNamed = summary.edited;
    openingUnnamed = chapterOpeningRefusal(summary, chapterFile);
    for (const edit of summary.named) rewrittenEntries.add(edit.file);
  } catch (err) {
    throw new Error(
      `${chapterFile} is now listed as "${title}" in the book's table of contents, but the pass `
      + 'that writes each chapter\'s name into its opening could not run afterwards, so the page '
      + `still prints what it printed: ${(err as Error).message}`
    );
  }

  return {
    file: chapterFile,
    title,
    bookSha256: after,
    rewrittenTocs: added.rewrittenTocs,
    rewrittenEntries: [...rewrittenEntries],
    narrationCopy,
    openingsNamed,
    openingUnnamed,
  };
}
