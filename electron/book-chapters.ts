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
 * ebook2audiobook takes its chapter titles from the book's own nav.xhtml,
 * matched to spine documents by identity. So "rename this chapter" is an edit to
 * two pieces of METADATA and to nothing a reader sees:
 *
 *   - the nav entry's link text, which is the title the audiobook is built with;
 *   - the chapter document's `<head><title>`, which is what every other reader
 *     (a phone, a validator, Calibre) shows for that document.
 *
 * The `<h1>`/`<h2>` in the body is deliberately left ALONE. A user retitling
 * "CHAPTER I" to "One: Nuremberg, October 1946" is naming the chapter, not
 * claiming the page said something it did not, and rewriting the print would put
 * the book and the scan it came from into disagreement with nothing recording
 * that it happened.
 *
 * ── Why there is no second store ────────────────────────────────────────────
 *
 * The title lives in the book and only in the book. Re-opening the project reads
 * the nav again and finds the new title there, so nothing in the manifest, the
 * project file or the picker has to remember a rename or be reconciled with one.
 * That is the same rule chapter titles already follow with a working document —
 * one authority, no mirror to drift (memory: chapter-title-single-authority) —
 * said for the book instead of for the PDF.
 *
 * ── The two records that DO have to move with it ────────────────────────────
 *
 * Rewriting the book changes its bytes, and two records are stamped with those
 * bytes:
 *
 *   - the narration deletions, which are positional keys stamped with the book's
 *     sha256 (shared/vlm/narration-deletions.ts). A retitle adds, removes and
 *     reorders NO element — it replaces the text inside one `<a>` and one
 *     `<title>`, both of which are outside every spine document's `<body>` unit
 *     list bar the nav's own — so every recorded key still names the element it
 *     named before, and the record is re-stamped rather than voided. Left alone
 *     it would read as stale on the next open and a user's strikes would be
 *     silently cleared by a rename that could not have invalidated one of them.
 *   - the narration copy, which is the book minus those strikes and carries a
 *     byte-identical copy of the same nav. It gets the same two edits and its
 *     `fromEpubSha256` moves with them, so "the copy is the book minus the
 *     strikes" stays true. A copy that was ALREADY cut from some other version
 *     of the book is not touched and is reported stale — it is stale, and it was
 *     stale before this ran.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { EpubProcessor, ZipReader, ZipWriter } from './epub-processor';
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
// Reading the book's navigation
// ─────────────────────────────────────────────────────────────────────────────

/** One `<a href>` of the table of contents, and where its text sits in the file. */
interface NavLink {
  /** The linked document's zip entry name, normalized. */
  file: string;
  /** The link's current text, with markup stripped and whitespace collapsed. */
  title: string;
  /** Byte-free string offsets of the link's INNER content, for a surgical edit. */
  innerStart: number;
  innerEnd: number;
}

/**
 * The book's table of contents, as links into spine documents.
 *
 * Scoped to `<nav epub:type="toc">` and refused when there is none. EPUB 3
 * REQUIRES that nav — it is the table of contents — and a navigation document
 * without one either is not one or belongs to a book this app did not write; in
 * either case guessing which of its `<nav>`s is the TOC would rename an entry in
 * the landmarks or the page list.
 */
function parseNavToc(navXhtml: string, navFile: string, bookName: string): NavLink[] {
  const navDir = navFile.includes('/') ? navFile.slice(0, navFile.lastIndexOf('/')) : '';

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

  const links: NavLink[] = [];
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
    const target = href[1].split('#')[0];
    if (target === '') continue;  // a pure fragment link — same reasoning as above
    const innerStart = tocInner.offset + m.index + m[0].indexOf('>') + 1;
    links.push({
      file: normalizeEntryName(navDir === '' ? target : `${navDir}/${decodeHref(target)}`),
      title: stripMarkup(m[2]),
      innerStart,
      innerEnd: innerStart + m[2].length,
    });
  }
  return links;
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

/** A nav link's text as a person reads it: tags dropped, entities resolved. */
function stripMarkup(inner: string): string {
  return inner
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text that is safe as an XML text node. */
function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The `<head><title>` of an XHTML document, and where its text sits. */
function findDocTitle(xhtml: string): { title: string; innerStart: number; innerEnd: number } | null {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(xhtml);
  if (head === null) return null;
  const headOffset = head.index + head[0].indexOf('>') + 1;
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head[1]);
  if (title === null) return null;
  const innerStart = headOffset + title.index + title[0].indexOf('>') + 1;
  return { title: stripMarkup(title[1]), innerStart, innerEnd: innerStart + title[1].length };
}

/**
 * Open the book and read its navigation document, or refuse naming what is
 * missing.
 *
 * The NCX check is a refusal and not a second rewrite on purpose. A book that
 * carries the legacy EPUB 2 table of contents as well as the EPUB 3 one has the
 * same chapter named in two places, and renaming one of them would leave a book
 * whose two tables of contents disagree — which reader wins is then a property
 * of the reader. `foundry vlm-convert` writes no NCX at all, so this refusal
 * cannot fire on a converted book; it fires on somebody else's EPUB, where it is
 * the honest answer.
 */
async function readNav(bookPath: string): Promise<{ navFile: string; navXhtml: string; links: NavLink[] }> {
  const bookName = path.basename(bookPath);
  const processor = new EpubProcessor();
  try {
    const structure = await processor.open(bookPath);
    if (structure.ncxPath) {
      throw new Error(
        `${bookName} carries a legacy NCX table of contents (${structure.ncxPath}) as well as its `
        + 'EPUB 3 navigation, and this app will not rename a chapter in only one of them — the two '
        + 'would then disagree, and which one a reader believes is a property of the reader.'
      );
    }
    if (!structure.navPath) {
      throw new Error(
        `${bookName} declares no navigation document, so it has no table of contents and no chapter `
        + 'titles to change. Only a book with an EPUB 3 nav can be retitled here — that nav is what '
        + 'the audiobook takes its chapter names from.'
      );
    }
    const navFile = normalizeEntryName(structure.navPath);
    const navXhtml = await processor.readFile(navFile);
    return { navFile, navXhtml, links: parseNavToc(navXhtml, navFile, bookName) };
  } finally {
    processor.close();
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
 */
export async function readBookChapterTitles(projectDir: string): Promise<BookChapterTitles | null> {
  const book = await manifestService.readExportEpub(projectDir);
  if (!book || !fs.existsSync(book.absPath)) return null;

  const { navFile, links } = await readNav(book.absPath);

  // The `<head><title>` of each listed document, read from the document itself.
  // Reported beside the nav title because the two are written together and a
  // book where they have drifted apart is worth being able to see.
  const processor = new EpubProcessor();
  const chapters: BookChapterTitle[] = [];
  try {
    await processor.open(book.absPath);
    for (const link of links) {
      const xhtml = await processor.readFile(link.file);
      const docTitle = findDocTitle(xhtml);
      chapters.push({
        file: link.file,
        navTitle: link.title,
        // A document with no <head><title> at all states no title of its own.
        // Real for hand-written and third-party markup — the element is optional
        // in practice even though XHTML requires it — so it is reported as the
        // empty string it is, and `renameBookChapter` refuses to write into a
        // document that has none rather than inventing a head for it.
        docTitle: docTitle === null ? '' : docTitle.title,
      });
    }
  } finally {
    processor.close();
  }

  return { bookPath: book.absPath, navFile, chapters };
}

// ─────────────────────────────────────────────────────────────────────────────
// The rename
// ─────────────────────────────────────────────────────────────────────────────

/** Replace the text between two offsets — the whole of how a title is written. */
function spliceText(source: string, start: number, end: number, text: string): string {
  return source.slice(0, start) + escapeXmlText(text) + source.slice(end);
}

/**
 * The book with one chapter's nav entry and `<title>` rewritten, staged and then
 * moved onto the recorded path.
 *
 * The two edits are STRING SPLICES at offsets the parse already found, not a DOM
 * round trip. That is the point: every other byte of the book — the print, the
 * `data-bf-cat` stamps, the cropped figures, the whitespace foundry laid out —
 * comes through untouched, so the aligner's unit list, the narration keys taken
 * off it, and any diff a person runs against this file all still describe the
 * same book.
 */
async function rewriteChapterTitle(
  inputPath: string,
  outputPath: string,
  navFile: string,
  navLink: NavLink,
  chapterFile: string,
  title: string,
): Promise<void> {
  const replacements = new Map<string, Buffer>();

  const zipReader = new ZipReader(inputPath);
  await zipReader.open();
  try {
    const navXhtml = (await zipReader.readEntry(navFile)).toString('utf8');
    replacements.set(
      navFile,
      Buffer.from(spliceText(navXhtml, navLink.innerStart, navLink.innerEnd, title), 'utf8'),
    );

    const chapterXhtml = (await zipReader.readEntry(chapterFile)).toString('utf8');
    const docTitle = findDocTitle(chapterXhtml);
    if (docTitle === null) {
      throw new Error(
        `${path.basename(inputPath)}: ${chapterFile} has no <head><title> to rename. The chapter's `
        + 'name lives in two places and this book only has one of them, so nothing was written — '
        + 'renaming half of it would leave the book saying two different things.'
      );
    }
    replacements.set(
      chapterFile,
      Buffer.from(spliceText(chapterXhtml, docTitle.innerStart, docTitle.innerEnd, title), 'utf8'),
    );

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

/**
 * Rename one chapter of the project's book, in the book.
 *
 * `file` is the chapter document's zip entry name — the same identity a
 * narration strike is recorded under (`<zip entry>#<index>`), which is how the
 * picker knows which chapter a block on screen belongs to without ever having to
 * work it out from a page number. Every refusal names what was missing: a
 * project with no book, a document the table of contents does not list, an empty
 * title.
 */
export async function renameBookChapter(
  projectDir: string,
  file: string,
  rawTitle: string,
): Promise<BookChapterRenameResult> {
  const title = rawTitle.trim();
  if (title.length === 0) {
    throw new Error(
      'A chapter title cannot be empty. A chapter with no name is one the audiobook announces as '
      + 'silence and a reader cannot navigate to; to say a heading is not a chapter opening, '
      + 'relabel the block instead.'
    );
  }

  const book = await manifestService.readExportEpub(projectDir);
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
  const { navFile, links } = await readNav(book.absPath);
  const link = links.find((l) => l.file === chapterFile);
  if (link === undefined) {
    throw new Error(
      `${path.basename(book.absPath)}'s table of contents does not list ${chapterFile}, so that `
      + 'document is not a chapter of this book and has no title to change. The book lists '
      + `${links.length} chapter(s).`
    );
  }

  // The book as it stands, measured BEFORE the rewrite: it is what says whether
  // the records stamped with it were describing this book a moment ago.
  const { sha256: before } = await sha256File(book.absPath);
  const recorded = await manifestService.readNarrationDeletions(projectDir);
  const narration = await manifestService.readNarrationEpub(projectDir);

  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const staged = path.join(STAGING_DIR, `retitle-${before.slice(0, 16)}.epub`);
  await rewriteChapterTitle(book.absPath, staged, navFile, link, chapterFile, title);
  await moveIntoPlace(staged, book.absPath);

  const { sha256: after } = await sha256File(book.absPath);
  const at = new Date().toISOString();
  await manifestService.touchBookEpub(projectDir, at);

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
    });
  }

  let narrationCopy: BookChapterRenameResult['narrationCopy'] = 'none';
  if (narration !== null && fs.existsSync(narration.absPath)) {
    const manifest = await manifestService.readNarrationEpubRecord(projectDir);
    if (manifest !== null && manifest.fromEpubSha256 === before) {
      // The copy carries a byte-identical nav and the same chapter documents, so
      // the same two splices land in the same two places. Its own parse is run
      // against ITS bytes rather than reusing the book's offsets: the copy has
      // had elements removed and `<sup>` markers stripped, so an offset measured
      // in the book would point somewhere else entirely in the copy.
      const copyNav = await readNav(narration.absPath);
      const copyLink = copyNav.links.find((l) => l.file === chapterFile);
      if (copyLink === undefined) {
        throw new Error(
          `The book was renamed, but ${path.basename(narration.absPath)} — the narration copy cut `
          + `from it — does not list ${chapterFile} in its table of contents. The two files have `
          + 'come apart; export the narration copy again.'
        );
      }
      const stagedCopy = path.join(STAGING_DIR, `retitle-tts-${before.slice(0, 16)}.epub`);
      await rewriteChapterTitle(
        narration.absPath, stagedCopy, copyNav.navFile, copyLink, chapterFile, title);
      await moveIntoPlace(stagedCopy, narration.absPath);
      await manifestService.registerNarrationEpub(projectDir, {
        ...manifest,
        modifiedAt: at,
        // It is still the same cut of the same book — only the chapter's name has
        // moved, in both files at once — so the record follows the book's new sha
        // rather than declaring the copy stale over an edit it also received.
        fromEpubSha256: after,
      });
      narrationCopy = 'updated';
    } else {
      narrationCopy = 'already-stale';
    }
  }

  return {
    file: chapterFile,
    title,
    previousTitle: link.title,
    bookSha256: after,
    narrationCopy,
  };
}
