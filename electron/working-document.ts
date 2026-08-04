/**
 * working-document — reading the state a stage left IN the working PDF.
 *
 * The document pipeline's rule (docs/DOCUMENT_PIPELINE.md): every stage is
 * document-in → document-out, and "which stage has run" is a fact about the
 * document rather than a status in a JSON file beside it. This module is the
 * read half of that on BookForge's side — the typed reader for the two things
 * foundry writes into a working PDF:
 *
 *   • the catalog marker `/Foundry` — the document CLASS (`scanned` decides
 *     whether an OCR-repair model is pointed at somebody's book) and the
 *     `/SourceSHA256` of the ORIGINAL, which is the identity everything binds to.
 *   • the block layer — one `/Square` annotation per block, carrying its
 *     category, its place in reading order, its text, and whether it is deleted.
 *
 * It is a mirror of foundry's `src/pdf/document.ts` and `src/pdf/annotations.ts`,
 * re-declared rather than imported because the two programs ship separately —
 * but re-declared UNDER A VERSION CHECK, exactly as `foundry-bridge` does for the
 * run artifacts. A marker version this build does not know is refused by name; it
 * is never read for the fields it happens to recognize.
 *
 * ── Why @cantoo/pdf-lib and not pdf.js ──────────────────────────────────────
 *
 * pdf.js is this app's renderer, and it stays that. But its `getAnnotations()`
 * parses against a fixed key whitelist and SILENTLY DROPS custom dictionary
 * keys, so every `/FoundryCategory` in the file would come back as nothing at
 * all — a book that reads as "no blocks yet" rather than as an error. The
 * spike (DOCUMENT_PIPELINE.md §Curation) settled on `@cantoo/pdf-lib`, pinned
 * ≥ 2.8.1, as the one PDF object library in BOTH repos, so the annotations
 * foundry writes and the annotations BookForge reads are parsed by the same code.
 *
 * ── Geometry ────────────────────────────────────────────────────────────────
 *
 * Rects come back in PDF USER SPACE, verbatim, together with the page's crop
 * box. They are deliberately NOT converted to the picker's top-left pixel frame
 * here: that conversion carries the crop-box origin (a trimmed scanner margin is
 * the common case) and belongs with the code that paints, not with the code that
 * reads. See foundry's `src/pdf/frame.ts` for the conversion this app's picker
 * will mirror.
 */

import * as fs from 'fs';

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from '@cantoo/pdf-lib';

import type {
  BlockAnnotation,
  DocumentClass,
  DocumentPage,
} from '../shared/document/pipeline-types';

// The wire shapes are declared once, in `shared/document/pipeline-types.ts`, and
// carried under this module's own names because that is what its callers already
// say. Re-exported rather than re-declared: a second copy of a shape that
// crosses the IPC boundary is a shape that drifts without breaking a build.
export type { DocumentClass };
export type WorkingBlockAnnotation = BlockAnnotation;
export type WorkingDocumentPage = DocumentPage;

/** The marker format version this build reads. Mirrors foundry's MARKER_VERSION. */
export const FOUNDRY_MARKER_VERSION = 1;

const DOCUMENT_CLASSES: readonly DocumentClass[] = ['scanned', 'text'];

export interface FoundryMarker {
  version: number;
  documentClass: DocumentClass;
  /** tessdata code for a scan, the document's own `/Lang` for a text PDF, or null. */
  language: string | null;
  /** The pixel frame the block geometry was measured in. */
  dpi: number;
  /** sha256 of the ORIGINAL this working document was cast from. */
  sourceSha256: string;
  /** The foundry build that cast it. */
  producer: string;
}

/**
 * Everything the working document says about itself.
 *
 * `bytes` is the file's length, which is also the byte offset of the LAST stage
 * boundary — every stage after the cast appends and nothing moves, so the end of
 * the file is where the most recent stage finished (foundry's
 * `src/pdf/document.ts`, `appendUpdate`).
 */
export interface WorkingDocumentState {
  path: string;
  bytes: number;
  marker: FoundryMarker;
  pages: WorkingDocumentPage[];
  /** Blocks carrying `/FoundryCategory`, deleted ones included. */
  blockCount: number;
  /** Of those, the ones flagged `/FoundryDeleted`. */
  deletedBlockCount: number;
}

export class WorkingDocumentError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'WorkingDocumentError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys — the same names foundry writes
// ─────────────────────────────────────────────────────────────────────────────

const K_FOUNDRY = PDFName.of('Foundry');
const K_VERSION = PDFName.of('Version');
const K_CLASS = PDFName.of('Class');
const K_LANG = PDFName.of('Lang');
const K_DPI = PDFName.of('Dpi');
const K_SOURCE = PDFName.of('SourceSHA256');
const K_PRODUCER = PDFName.of('Producer');

const K_PAGE_DELETED = PDFName.of('FoundryPageDeleted');
const K_CATEGORY = PDFName.of('FoundryCategory');
const K_SEQ = PDFName.of('FoundrySeq');
const K_MERGED = PDFName.of('FoundryMerged');
const K_DELETED = PDFName.of('FoundryDeleted');
const K_NM = PDFName.of('NM');
const K_RECT = PDFName.of('Rect');
const K_CONTENTS = PDFName.of('Contents');

/**
 * Read a PDF text string back, whichever encoding it is in.
 *
 * foundry always WRITES hex (UTF-16BE): pdf-lib's literal strings truncate every
 * character to one byte, which destroys a book's em dashes and ligatures and can
 * corrupt the object they sit in. Literal strings are accepted on the way in
 * because other people's tools write them — a reader that let a user retype a
 * heading will have written whatever it writes.
 */
function decodeTextString(value: unknown): string | null {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadDocument(file: string): Promise<{ doc: PDFDocument; bytes: number }> {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    throw new WorkingDocumentError(
      file,
      `could not be read — ${(err as Error).message}. A working document is cast from the archive `
      + 'original by the Get Text stage; if it is not there, that stage has not run for this book.'
    );
  }
  let doc: PDFDocument;
  try {
    // `updateMetadata: false` — the Info dictionary is the document's, not ours,
    // and a read must not be able to change the file it read.
    doc = await PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
  } catch (err) {
    throw new WorkingDocumentError(
      file,
      `could not be parsed as a PDF — ${(err as Error).message}`
    );
  }
  return { doc, bytes: bytes.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// The marker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `/Foundry` marker, or the error naming the stage that writes one.
 *
 * A PDF with no marker is not a working document — it is somebody's book — and
 * that difference decides whether a stage may write into it at all.
 */
export function readMarker(file: string, doc: PDFDocument): FoundryMarker {
  const dict = doc.catalog.lookup(K_FOUNDRY);
  if (!(dict instanceof PDFDict)) {
    throw new WorkingDocumentError(
      file,
      'carries no foundry marker, so it is not a working document. The Get Text stage casts one '
      + 'from the archive original; run it for this book.'
    );
  }
  const version = dict.lookup(K_VERSION);
  if (!(version instanceof PDFNumber) || version.asNumber() !== FOUNDRY_MARKER_VERSION) {
    throw new WorkingDocumentError(
      file,
      `declares foundry marker version ${version instanceof PDFNumber ? version.asNumber() : 'none'}, `
      + `and this build of BookForge reads version ${FOUNDRY_MARKER_VERSION}. The foundry binary and `
      + 'BookForge are out of step — upgrade one of them, then reset this book to before Get Text so '
      + 'the working document is re-cast. Do not hand-edit the version.'
    );
  }
  const cls = dict.lookup(K_CLASS);
  const className = cls instanceof PDFName ? cls.decodeText() : '';
  if (!(DOCUMENT_CLASSES as readonly string[]).includes(className)) {
    throw new WorkingDocumentError(
      file,
      `declares document class "${className}", and the classes are ${DOCUMENT_CLASSES.join(' and ')}. `
      + 'Reset this book to before Get Text so the working document is re-cast.'
    );
  }
  const dpi = dict.lookup(K_DPI);
  if (!(dpi instanceof PDFNumber)) {
    throw new WorkingDocumentError(
      file,
      'has a foundry marker with no /Dpi, so no geometry in it can be placed. Reset this book to '
      + 'before Get Text so the working document is re-cast.'
    );
  }
  const sourceSha256 = decodeTextString(dict.lookup(K_SOURCE));
  if (sourceSha256 === null || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new WorkingDocumentError(
      file,
      'has a foundry marker with no usable /SourceSHA256, so it cannot say which original it was '
      + 'cast from — and that hash is the identity the archive primary, the binding record and the '
      + "EPUB's own identifier are all built on. Reset this book to before Get Text."
    );
  }
  const producer = decodeTextString(dict.lookup(K_PRODUCER));
  if (producer === null) {
    throw new WorkingDocumentError(
      file,
      'has a foundry marker with no /Producer. Every cast records the build that made it; a marker '
      + 'without one was written by something other than foundry.'
    );
  }
  return {
    version: FOUNDRY_MARKER_VERSION,
    documentClass: className as DocumentClass,
    language: decodeTextString(dict.lookup(K_LANG)),
    dpi: dpi.asNumber(),
    sourceSha256,
    producer,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The block layer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `/Rect` is a pair of OPPOSITE CORNERS in either order — the spec says so, and
 * readers that let a user drag a box out produce the other order routinely.
 */
function normalizeRect(rect: [number, number, number, number]): [number, number, number, number] {
  const [x0, y0, x1, y1] = rect;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

function readOneAnnotation(
  file: string,
  annot: PDFDict,
  page: number
): WorkingBlockAnnotation {
  const where = `page ${page + 1}`;
  const category = annot.lookup(K_CATEGORY);
  // The category is checked for PRESENCE and shape here, not against a list:
  // `shared/ocr/block-categories.ts` is the one palette and the one taxonomy in
  // this app, and re-stating its members here would be a second copy of it.
  // A category this app does not know is a contract mismatch its own consumers
  // report, with the block id in hand.
  if (!(category instanceof PDFName)) {
    throw new WorkingDocumentError(
      file,
      `${where}: a block annotation has no /FoundryCategory name, so what the block IS is unknown. `
      + 'Re-run the Blocks stage against this document.'
    );
  }
  const seq = annot.lookup(K_SEQ);
  if (!(seq instanceof PDFNumber)) {
    throw new WorkingDocumentError(
      file,
      `${where}: a block annotation has no /FoundrySeq, so its place in the book's reading order is `
      + 'unknown. It was written by something other than foundry. Re-run the Blocks stage.'
    );
  }
  const id = decodeTextString(annot.lookup(K_NM));
  if (id === null) {
    throw new WorkingDocumentError(
      file,
      `${where}: a block annotation has no /NM, which is where the block id lives.`
    );
  }
  const rect = annot.lookup(K_RECT);
  if (!(rect instanceof PDFArray) || rect.size() !== 4) {
    throw new WorkingDocumentError(file, `${where}: block ${id} has no four-number /Rect`);
  }
  const numbers = [0, 1, 2, 3].map((i) => {
    const n = rect.lookup(i);
    if (!(n instanceof PDFNumber)) {
      throw new WorkingDocumentError(
        file,
        `${where}: block ${id} has a /Rect entry that is not a number`
      );
    }
    return n.asNumber();
  }) as [number, number, number, number];

  const merged = annot.lookup(K_MERGED);
  const mergedIds: string[] = [];
  if (merged instanceof PDFArray) {
    for (let i = 0; i < merged.size(); i++) {
      const member = decodeTextString(merged.lookup(i));
      if (member === null) {
        throw new WorkingDocumentError(
          file,
          `${where}: block ${id} has a /FoundryMerged entry that is not a string`
        );
      }
      mergedIds.push(member);
    }
  }

  return {
    id,
    page,
    seq: seq.asNumber(),
    category: category.decodeText(),
    rect: normalizeRect(numbers),
    // An annotation with no /Contents is a block with no text, which is a real
    // thing (an empty box a user drew). Distinguishing it from an unreadable
    // string would be a distinction with no consumer.
    text: decodeTextString(annot.lookup(K_CONTENTS)) ?? '',
    merged: mergedIds,
    deleted: annot.lookup(K_DELETED) === PDFBool.True,
  };
}

/** Is this dictionary one of ours? Everything foundry writes carries a category. */
function isBlockAnnotation(annot: PDFDict): boolean {
  return annot.lookup(K_CATEGORY) !== undefined;
}

function collectPages(doc: PDFDocument): WorkingDocumentPage[] {
  return doc.getPages().map((page, index) => {
    const box = page.getCropBox();
    return {
      index,
      cropBox: [box.x, box.y, box.x + box.width, box.y + box.height] as [number, number, number, number],
      deleted: page.node.lookup(K_PAGE_DELETED) === PDFBool.True,
    };
  });
}

function collectBlocks(file: string, doc: PDFDocument): WorkingBlockAnnotation[] {
  const out: WorkingBlockAnnotation[] = [];
  const pages = doc.getPages();
  for (let index = 0; index < pages.length; index++) {
    const raw = pages[index].node.Annots();
    if (!(raw instanceof PDFArray)) continue;
    for (let i = 0; i < raw.size(); i++) {
      const annot = raw.lookup(i);
      if (!(annot instanceof PDFDict) || !isBlockAnnotation(annot)) continue;
      out.push(readOneAnnotation(file, annot, index));
    }
  }

  // Reading order is what the book is assembled in, and there is no honest way
  // to pick between two blocks claiming the same place.
  const bySeq = new Map<number, string>();
  for (const block of out) {
    const prior = bySeq.get(block.seq);
    if (prior !== undefined) {
      throw new WorkingDocumentError(
        file,
        `blocks ${prior} and ${block.id} both claim reading position ${block.seq}. Re-run the Blocks `
        + 'stage against this document.'
      );
    }
    bySeq.set(block.seq, block.id);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The public reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the working document says about itself: its marker, its pages, and how
 * much of a block layer it carries.
 *
 * This is the whole of "which stages have run", short of the boundaries the
 * binding records — a document with a marker has been cast, and one with block
 * annotations has been through Blocks. Nothing is consulted but the file.
 */
export async function readWorkingDocumentState(file: string): Promise<WorkingDocumentState> {
  const { doc, bytes } = await loadDocument(file);
  const marker = readMarker(file, doc);
  const blocks = collectBlocks(file, doc);
  return {
    path: file,
    bytes,
    marker,
    pages: collectPages(doc),
    blockCount: blocks.length,
    deletedBlockCount: blocks.filter((b) => b.deleted).length,
  };
}

/** The block layer, in reading order. Throws when the document has no marker. */
export async function readWorkingDocumentBlocks(file: string): Promise<{
  marker: FoundryMarker;
  pages: WorkingDocumentPage[];
  blocks: WorkingBlockAnnotation[];
}> {
  const { doc } = await loadDocument(file);
  const marker = readMarker(file, doc);
  return { marker, pages: collectPages(doc), blocks: collectBlocks(file, doc) };
}
