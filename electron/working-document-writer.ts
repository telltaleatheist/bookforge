/**
 * working-document-writer — curation, written INTO the working document.
 *
 * The picker reads and writes the same annotations (docs/DOCUMENT_PIPELINE.md
 * §Curation). Deleting a block, merging two, relabelling one, retyping a
 * chapter's title: each of those is an edit to `<Original>.working.pdf`, landed
 * here as a PDF **incremental update** — bytes appended to the end, no byte
 * moved, the objects the edit replaces still present earlier in the file. A
 * 300 MB scan is never rewritten because somebody clicked a label.
 *
 * This is the write half of `working-document.ts`, and it is deliberately a
 * separate module: reading is something every stage does, and writing is
 * something only the picker does.
 *
 * ── The one pdf-lib rule that is easy to get wrong ──────────────────────────
 *
 * `saveIncremental` writes NEW objects on its own — their object number is past
 * the snapshot's high-water mark, so it can tell — and writes an EXISTING object
 * only when that object has been MARKED. Mutating an annotation dictionary and
 * saving without marking it produces a perfectly valid update that silently does
 * not contain the change: the file grows, the boundary moves, and the label is
 * the one it always was. foundry measured this and built `markChanged` around
 * it (foundry `src/pdf/document.ts`); every mutation below goes through `mark`
 * for the same reason, and `tools/test-working-document-writer.js` reopens the
 * file COLD after every edit rather than trusting the in-memory document.
 *
 * ── Failure discipline, mirrored from foundry ───────────────────────────────
 *
 * The append is built completely in memory first, so every error pdf-lib can
 * raise lands before the file is touched. The write itself is one positional
 * write at the old end followed by an fsync, and a write that throws or comes up
 * short truncates back to the length the file had — half an incremental update
 * is a corrupt PDF, and the point of the design is that one never exists.
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
  PDFObject,
  PDFRef,
  PDFString,
  type DocumentSnapshot,
} from '@cantoo/pdf-lib';

import { BLOCK_CATEGORY_IDS, blockCategoryColor } from '../shared/ocr/block-categories';

const K_PAGE_DELETED = PDFName.of('FoundryPageDeleted');
const K_CATEGORY = PDFName.of('FoundryCategory');
const K_SEQ = PDFName.of('FoundrySeq');
const K_MERGED = PDFName.of('FoundryMerged');
const K_DELETED = PDFName.of('FoundryDeleted');
const K_NM = PDFName.of('NM');
const K_T = PDFName.of('T');
const K_RECT = PDFName.of('Rect');
const K_CONTENTS = PDFName.of('Contents');
const K_COLOR = PDFName.of('C');
const K_ANNOTS = PDFName.of('Annots');

export class WorkingDocumentWriteError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'WorkingDocumentWriteError';
  }
}

/**
 * One curation edit.
 *
 * A block has ONE category field, so `relabel` is the whole of "what this block
 * is" and there is no second place for a selection or a colour to disagree with
 * it. `delete` is a FLAG rather than a removal, which is what makes `restore`
 * possible at all: the annotation stays, carrying its geometry and its text, and
 * reflow skips it.
 */
export type WorkingDocumentEdit =
  | { kind: 'relabel'; blockId: string; category: string }
  | { kind: 'retitle'; blockId: string; text: string }
  | { kind: 'delete'; blockId: string }
  | { kind: 'restore'; blockId: string }
  | { kind: 'delete-page'; page: number }
  | { kind: 'restore-page'; page: number }
  /**
   * "The system thinks it's two blocks but it isn't." The blocks collapse into
   * the earliest of them in reading order, which keeps its id, its category, its
   * page and its place in the book; the rest are removed from the page.
   */
  | { kind: 'merge'; blockIds: string[] };

export interface WorkingDocumentWriteResult {
  /** The file's length after the append — the next boundary, if a stage records one. */
  bytes: number;
  /** How many bytes this update added. */
  appended: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text strings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ALWAYS hex (UTF-16BE), never `PDFString.of` — foundry's `src/pdf/strings.ts`
 * measured what the alternative costs. pdf-lib's literal string truncates every
 * character to one byte: an em dash becomes 0x14, a ligature becomes 0x01, and a
 * character whose low byte lands on `(`, `)` or `\` terminates the string and
 * corrupts every object after it. On foundry's first real run that silently lost
 * twenty of thirty-nine annotations from a file that parsed cleanly. The payload
 * here is a BOOK, and a chapter title a user retyped is exactly where the curly
 * quotes are.
 */
function textString(value: string): PDFHexString {
  return PDFHexString.fromText(value);
}

function decodeTextString(value: unknown): string | null {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return null;
}

/** `#3b82f6` → the three 0..1 components a `/C` array wants. */
function colourComponents(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// ─────────────────────────────────────────────────────────────────────────────
// The document, opened for an append
// ─────────────────────────────────────────────────────────────────────────────

/** One block annotation, located: the dict to mutate and what marks it. */
interface LocatedBlock {
  id: string;
  page: number;
  seq: number;
  dict: PDFDict;
  /** Marking THIS is what puts the mutated dict into the update. */
  mark: PDFObject | PDFRef;
  /** The page's `/Annots`, for a merge that has to remove entries. */
  annots: PDFArray;
  /** Marking THIS is what puts a changed `/Annots` into the update. */
  annotsMark: PDFObject | PDFRef;
  pageDict: PDFDict;
}

class WorkingDocumentEditor {
  private constructor(
    readonly file: string,
    private readonly doc: PDFDocument,
    private readonly snapshot: DocumentSnapshot,
    private readonly baseLength: number,
    private readonly blocks: Map<string, LocatedBlock>,
    private readonly pages: PDFDict[],
  ) {}

  static async open(file: string): Promise<WorkingDocumentEditor> {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (err) {
      throw new WorkingDocumentWriteError(
        file,
        `could not be read — ${(err as Error).message}. Curation edits the working document the Get `
        + 'Text stage casts; if it is not there, that stage has not run for this book.'
      );
    }
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(new Uint8Array(bytes), {
        forIncrementalUpdate: true,
        // The Info dictionary is the document's, not ours. Letting pdf-lib stamp
        // a ModDate on every save would put a change in every update whether or
        // not the edit changed anything.
        updateMetadata: false,
      });
    } catch (err) {
      throw new WorkingDocumentWriteError(
        file,
        `could not be parsed as a PDF — ${(err as Error).message}`
      );
    }

    const snapshot = doc.takeSnapshot();
    const pages = doc.getPages().map((p) => p.node);
    const blocks = new Map<string, LocatedBlock>();
    for (let index = 0; index < pages.length; index++) {
      const pageDict = pages[index];
      const located = locateAnnots(doc, pageDict);
      if (!located) continue;
      const { annots, mark: annotsMark } = located;
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        const dict = annots.lookup(i);
        if (!(dict instanceof PDFDict) || dict.get(K_CATEGORY) === undefined) continue;
        const id = decodeTextString(dict.lookup(K_NM));
        if (id === null) {
          throw new WorkingDocumentWriteError(
            file,
            `page ${index + 1}: a block annotation has no /NM, which is where the block id lives. `
            + 'Re-run the Blocks stage against this document.'
          );
        }
        if (blocks.has(id)) {
          throw new WorkingDocumentWriteError(
            file,
            `two block annotations claim the id ${id}. Block ids are keys, and an edit naming one of `
            + 'them would land on whichever was read second. Re-run the Blocks stage.'
          );
        }
        const seq = dict.lookup(K_SEQ);
        if (!(seq instanceof PDFNumber)) {
          throw new WorkingDocumentWriteError(
            file,
            `page ${index + 1}: block ${id} has no /FoundrySeq, so its place in the book's reading `
            + 'order is unknown. Re-run the Blocks stage.'
          );
        }
        blocks.set(id, {
          id,
          page: index,
          seq: seq.asNumber(),
          dict,
          // An annotation reached through a reference is its own object and is
          // marked as one. A direct dictionary inside the array has no object
          // number of its own, so the array is what carries it into the update.
          mark: entry instanceof PDFRef ? entry : annotsMark,
          annots,
          annotsMark,
          pageDict,
        });
      }
    }
    return new WorkingDocumentEditor(file, doc, snapshot, bytes.length, blocks, pages);
  }

  private mark(target: PDFObject | PDFRef): void {
    if (target instanceof PDFRef) this.snapshot.markRefForSave(target);
    else this.snapshot.markObjForSave(target);
  }

  private require(blockId: string): LocatedBlock {
    const block = this.blocks.get(blockId);
    if (!block) {
      throw new WorkingDocumentWriteError(
        this.file,
        `there is no block ${blockId} in this document, so the edit naming it has nothing to apply `
        + 'to. The picker and the document have drifted apart — reload the book.'
      );
    }
    return block;
  }

  private requirePage(page: number): PDFDict {
    if (!Number.isInteger(page) || page < 0 || page >= this.pages.length) {
      throw new WorkingDocumentWriteError(
        this.file,
        `page ${page + 1} was edited and this document has ${this.pages.length} pages.`
      );
    }
    return this.pages[page];
  }

  apply(edit: WorkingDocumentEdit): void {
    switch (edit.kind) {
      case 'relabel': return this.relabel(edit.blockId, edit.category);
      case 'retitle': return this.retitle(edit.blockId, edit.text);
      case 'delete': return this.setDeleted(edit.blockId, true);
      case 'restore': return this.setDeleted(edit.blockId, false);
      case 'delete-page': return this.setPageDeleted(edit.page, true);
      case 'restore-page': return this.setPageDeleted(edit.page, false);
      case 'merge': return this.merge(edit.blockIds);
    }
  }

  /**
   * The block's one category field, and the two things that display it.
   *
   * `/C` and `/T` are not a second source of truth — they are how a reader that
   * knows nothing about `/FoundryCategory` draws and lists the box. Leaving them
   * stale would make a block relabelled in the picker open in Acrobat in its old
   * colour, under its old name.
   */
  private relabel(blockId: string, category: string): void {
    if (!BLOCK_CATEGORY_IDS.includes(category)) {
      throw new WorkingDocumentWriteError(
        this.file,
        `"${category}" is not a block category. The categories are ${BLOCK_CATEGORY_IDS.join(', ')} `
        + '(shared/ocr/block-categories.ts, the one palette).'
      );
    }
    const block = this.require(blockId);
    block.dict.set(K_CATEGORY, PDFName.of(category));
    block.dict.set(K_COLOR, this.doc.context.obj(colourComponents(blockCategoryColor(category))));
    block.dict.set(K_T, textString(`${blockId} ${category}`));
    this.mark(block.mark);
  }

  /** `/Contents` is the block's text, and for a chapter block it IS the title. */
  private retitle(blockId: string, text: string): void {
    const block = this.require(blockId);
    block.dict.set(K_CONTENTS, textString(text));
    this.mark(block.mark);
  }

  private setDeleted(blockId: string, deleted: boolean): void {
    const block = this.require(blockId);
    if (deleted) block.dict.set(K_DELETED, PDFBool.True);
    else block.dict.delete(K_DELETED);
    this.mark(block.mark);
  }

  private setPageDeleted(page: number, deleted: boolean): void {
    const pageDict = this.requirePage(page);
    if (deleted) pageDict.set(K_PAGE_DELETED, PDFBool.True);
    else pageDict.delete(K_PAGE_DELETED);
    this.mark(pageDict);
  }

  /**
   * Collapse several blocks into the earliest of them in reading order.
   *
   * The lead keeps its id, its category, its page and its `/FoundrySeq`, because
   * a merged heading occupies the place its first piece did — that is what makes
   * the result assemble into the book where the user is looking at it. Its box
   * becomes the union, its text the pieces joined in reading order, and
   * `/FoundryMerged` records every id that went in, the lead's own included.
   * That is foundry's own shape for a merged display run
   * (`mergeDisplayCategories`, foundry src/pipeline/blocks-document.ts), so a
   * hand merge and a detected one are the same object.
   *
   * The members are REMOVED from the page's `/Annots`. An annotation nothing
   * references is not in the document's block layer, which is one of the three
   * ways the format says "not this" (foundry docs/DOCUMENT_MODES.md §Deletion).
   */
  private merge(blockIds: string[]): void {
    const unique = [...new Set(blockIds)];
    if (unique.length < 2) {
      throw new WorkingDocumentWriteError(
        this.file,
        `a merge needs at least two blocks and was given ${unique.length}. One block is already one `
        + 'block.'
      );
    }
    const members = unique.map((id) => this.require(id)).sort((a, b) => a.seq - b.seq);

    const page = members[0].page;
    for (const member of members) {
      if (member.page !== page) {
        throw new WorkingDocumentWriteError(
          this.file,
          `blocks ${members[0].id} (page ${page + 1}) and ${member.id} (page ${member.page + 1}) are `
          + 'on different pages. One annotation is on one page and has one box, so blocks that span '
          + 'a page break cannot be merged into it.'
        );
      }
    }

    const lead = members[0];
    const rects = members.map((m) => readRect(this.file, m));
    lead.dict.set(K_RECT, this.doc.context.obj([
      Math.min(...rects.map((r) => r[0])),
      Math.min(...rects.map((r) => r[1])),
      Math.max(...rects.map((r) => r[2])),
      Math.max(...rects.map((r) => r[3])),
    ]));
    // An annotation with no /Contents is a block with no text, which is a real
    // thing — an empty box somebody drew — so it contributes nothing rather than
    // erroring, and the join drops it.
    const text = members
      .map((m) => decodeTextString(m.dict.lookup(K_CONTENTS)) ?? '')
      .filter((t) => t.length > 0)
      .join(' ')
      .trim();
    lead.dict.set(K_CONTENTS, textString(text));
    lead.dict.set(K_MERGED, this.doc.context.obj(members.map((m) => textString(m.id))));
    this.mark(lead.mark);

    // Backwards: removal shifts the array under the walk.
    const doomed = new Set(members.slice(1).map((m) => m.id));
    const annots = lead.annots;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const id = decodeTextString(dict.lookup(K_NM));
      if (id !== null && doomed.has(id)) annots.remove(i);
    }
    this.mark(lead.annotsMark);
    for (const id of doomed) this.blocks.delete(id);
  }

  /**
   * Build the update, append it, fsync, and answer with the file's new length.
   *
   * An empty update is refused rather than written: a zero-byte append means the
   * edits changed nothing, and the honest answer to that is to say so, not to
   * move the end of the file so it looks like something happened.
   */
  async append(): Promise<WorkingDocumentWriteResult> {
    const diff = await this.doc.saveIncremental(this.snapshot);
    if (diff.length === 0) {
      throw new WorkingDocumentWriteError(
        this.file,
        'the update computed for these edits is empty — nothing in the document changed.'
      );
    }
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r+');
    } catch (err) {
      throw new WorkingDocumentWriteError(
        this.file,
        `could not be opened for writing — ${(err as Error).message}`
      );
    }
    try {
      const written = fs.writeSync(fd, diff, 0, diff.length, this.baseLength);
      if (written !== diff.length) {
        throw new WorkingDocumentWriteError(
          this.file,
          `only ${written} of ${diff.length} bytes of the update reached the file`
        );
      }
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      // Back to where the file was. A partial increment is a corrupt PDF, and
      // the document as it stood before these edits is the correct thing to
      // leave behind.
      try { fs.truncateSync(this.file, this.baseLength); } catch { /* the throw below is the news */ }
      throw err;
    }
    fs.closeSync(fd);
    return { bytes: this.baseLength + diff.length, appended: diff.length };
  }
}

function locateAnnots(
  doc: PDFDocument,
  page: PDFDict
): { annots: PDFArray; mark: PDFObject | PDFRef } | null {
  const existing = page.get(K_ANNOTS);
  if (existing instanceof PDFRef) {
    return { annots: doc.context.lookup(existing, PDFArray), mark: existing };
  }
  if (existing instanceof PDFArray) return { annots: existing, mark: page };
  return null;
}

function readRect(file: string, block: LocatedBlock): [number, number, number, number] {
  const rect = block.dict.lookup(K_RECT);
  if (!(rect instanceof PDFArray) || rect.size() !== 4) {
    throw new WorkingDocumentWriteError(file, `block ${block.id} has no four-number /Rect`);
  }
  const numbers = [0, 1, 2, 3].map((i) => {
    const n = rect.lookup(i);
    if (!(n instanceof PDFNumber)) {
      throw new WorkingDocumentWriteError(
        file,
        `block ${block.id} has a /Rect entry that is not a number`
      );
    }
    return n.asNumber();
  });
  const [x0, y0, x1, y1] = numbers;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/**
 * Apply a batch of curation edits as ONE incremental update.
 *
 * A batch rather than an edit at a time, and the batch is the unit on purpose:
 * each append carries a fresh cross-reference section and trailer, so a hundred
 * label clicks landed one at a time are a hundred of those. They are landed in
 * the order given — relabelling a block and then merging it into another is the
 * two things the user did, in that order.
 *
 * An empty batch is a caller bug rather than a no-op: it means a debounce fired
 * with nothing in it, and writing a boundary for it would be recording that
 * something happened.
 */
export async function applyWorkingDocumentEdits(
  file: string,
  edits: readonly WorkingDocumentEdit[]
): Promise<WorkingDocumentWriteResult> {
  if (edits.length === 0) {
    throw new WorkingDocumentWriteError(
      file,
      'no edits were given, and an empty update is not something to write into a document.'
    );
  }
  const editor = await WorkingDocumentEditor.open(file);
  for (const edit of edits) editor.apply(edit);
  return editor.append();
}
