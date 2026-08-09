/**
 * Stamping a book so quire can report its identity back.
 *
 * ── Why the caller stamps ──────────────────────────────────────────────────
 *
 * quire does not mint ids. It takes documents that already carry
 * `data-quire-id` and answers "which page did that id land on". That is
 * deliberate, and it is the whole reason the package can be trusted.
 *
 * BookForge's element keys — `<file>#<index>` for text units, `<file>#img<N>`
 * for pictures — are produced by `collectExportUnits` and `collectImageElements`
 * in `epub-processor.ts`. The narration writer, `writeNarrationEpub`, walks the
 * book with those SAME two functions in that SAME order to decide what a strike
 * removes. If quire invented its own numbering, there would be two enumerations
 * of one book, and every deletion bug that came from geometry-guessed identity
 * would come back wearing a different hat.
 *
 * So this file does not describe the enumeration. It CALLS it — the same
 * functions, in the same order, with the same per-document dedupe — and writes
 * the resulting key onto the very element the walk returned. Identity is then
 * correct by construction rather than by agreement, and a future edit that makes
 * the two disagree cannot do it quietly: `testIdentity` in `tools/test-quire.js`
 * compares the stamps against a reference walk, and `stampEpubForQuire` verifies
 * the file it wrote before it lets anyone have it.
 *
 * ── The one extension to quire's contract ─────────────────────────────────
 *
 * One element can be BOTH a text unit and an image element — a bare `<img>`
 * directly under `<body>` is collected by both walks and so carries two keys.
 * `data-quire-id` therefore holds a `|`-separated list, and quire emits one
 * block per id. A key containing a `|` would make that list ambiguous, so it is
 * rejected rather than escaped.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  EpubProcessor, ZipReader, ZipWriter,
  parseXhtmlBody, collectExportUnits, collectImageElements, normalizeZipEntryName,
  type MarkupUnit,
} from './epub-processor';
import { narrationElementKey, narrationImageElementKey } from '../shared/vlm/narration-deletions';
import { QUIRE_ID_ATTRIBUTE, QUIRE_ID_SEPARATOR } from '../packages/quire/src/types';

/**
 * One element this walk found: the key BookForge knows it by, the node itself,
 * and — for a text unit — the `ExportUnit` the walk produced it from.
 *
 * The unit is carried rather than re-derived because everything downstream that
 * wants to know what KIND of thing an element is (its markup category, whether
 * it is image-only) already has the answer here, and a second walk to ask again
 * would be a second enumeration of one book — the exact thing this file exists
 * to prevent. `undefined` on a picture, which no unit walk produced.
 */
export interface NarrationWalkEntry {
  key: string;
  el: any;
  kind: 'text' | 'image';
  tag: string;
  unit?: MarkupUnit;
}

/** One stamped element: the key BookForge knows it by, and what kind of thing it is. */
export interface StampedElement {
  key: string;
  file: string;
  kind: 'text' | 'image';
  tag: string;
}

export interface QuireStampResult {
  /** Where the stamped book was written. */
  outputPath: string;
  /** Spine documents walked, deduped, in spine order. */
  documents: string[];
  /** Every key stamped, in enumeration order — text units then pictures, per document. */
  stamped: StampedElement[];
  textUnitCount: number;
  imageElementCount: number;
  /**
   * Elements that carry more than one key because both walks collected them.
   * Named rather than counted, because a surprise here means one of the two
   * enumerations has moved.
   */
  sharedElements: Array<{ keys: string[]; file: string; tag: string }>;
}

/**
 * The reference walk: exactly what `writeNarrationEpub` enumerates, in its order.
 *
 * Kept as its own function so the stamper and the identity test call ONE
 * description of the enumeration rather than two copies of it.
 */
export async function enumerateNarrationElements(
  epubPath: string,
  whatFor: string,
): Promise<Array<{ file: string; docs: { doc: any; body: any }; entries: NarrationWalkEntry[] }>> {
  const processor = new EpubProcessor();
  const out: Array<{ file: string; docs: { doc: any; body: any }; entries: NarrationWalkEntry[] }> = [];
  const seen = new Set<string>();
  try {
    const structure = await processor.open(epubPath);
    for (const chapter of structure.chapters) {
      const entryName = normalizeZipEntryName(processor.resolvePath(chapter.href));
      // A spine document listed twice is ONE file — the narration writer's rule.
      if (seen.has(entryName)) continue;
      seen.add(entryName);

      const xhtml = await processor.readFile(entryName);
      const { doc, body } = parseXhtmlBody(xhtml, entryName);
      const entries: NarrationWalkEntry[] = [];

      let indexInFile = 0;
      for (const c of collectExportUnits(doc, body, entryName)) {
        const key = narrationElementKey(entryName, indexInFile++);
        entries.push({
          key,
          el: c.el,
          kind: 'text',
          tag: String(c.el.tagName || '').toLowerCase(),
          // The walk already knows everything the markup classifier asks, so it
          // is carried rather than re-derived from a second walk of the book.
          unit: { file: entryName, key, tag: c.tag, el: c.el, imageOnly: c.imageOnly },
        });
      }
      // AFTER the unit walk, because that walk MOVES stray runs into synthesized
      // wrappers and the picture ordinals must be read off the tree the
      // narration writer will walk.
      collectImageElements(body).forEach((el, ordinal) => {
        entries.push({
          key: narrationImageElementKey(entryName, ordinal),
          el,
          kind: 'image',
          tag: String(el.tagName || '').toLowerCase(),
        });
      });

      out.push({ file: entryName, docs: { doc, body }, entries });
    }
  } finally {
    processor.close();
  }
  return out;
}

/**
 * Write a copy of `epubPath` whose elements carry their BookForge keys as
 * `data-quire-id`, and verify it before returning.
 *
 * Everything that is not a walked spine document is copied through byte for
 * byte, `mimetype` included and stored uncompressed, so the copy is the same
 * book with stamps on it.
 */
export async function stampEpubForQuire(
  epubPath: string,
  outputPath: string,
  whatFor = path.basename(epubPath),
): Promise<QuireStampResult> {
  const { XMLSerializer } = require('@xmldom/xmldom');

  const walked = await enumerateNarrationElements(epubPath, whatFor);

  const stamped: StampedElement[] = [];
  const sharedElements: Array<{ keys: string[]; file: string; tag: string }> = [];
  const replacements = new Map<string, Buffer>();
  let textUnitCount = 0;
  let imageElementCount = 0;

  for (const { file, docs, entries } of walked) {
    const keysOnElement = new Map<any, string[]>();
    for (const entry of entries) {
      if (entry.key.includes(QUIRE_ID_SEPARATOR)) {
        throw new Error(
          `[quire-stamp] ${whatFor}: element key "${entry.key}" contains the id separator `
          + `"${QUIRE_ID_SEPARATOR}", which would make a shared element's stamp ambiguous. `
          + 'quire will not escape it — the key format has to change instead.',
        );
      }
      const existing = keysOnElement.get(entry.el);
      if (existing) existing.push(entry.key);
      else keysOnElement.set(entry.el, [entry.key]);

      stamped.push({ key: entry.key, file, kind: entry.kind, tag: entry.tag });
      if (entry.kind === 'text') textUnitCount++; else imageElementCount++;
    }

    for (const [el, keys] of keysOnElement) {
      el.setAttribute(QUIRE_ID_ATTRIBUTE, keys.join(QUIRE_ID_SEPARATOR));
      if (keys.length > 1) {
        sharedElements.push({ keys, file, tag: String(el.tagName || '').toLowerCase() });
      }
    }

    let serialized: string = new XMLSerializer().serializeToString(docs.doc);
    if (!serialized.startsWith('<?xml')) {
      serialized = `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
    }
    replacements.set(file, Buffer.from(serialized, 'utf8'));
  }

  const zipReader = new ZipReader(epubPath);
  try {
    await zipReader.open();
    const zipWriter = new ZipWriter();
    for (const entry of zipReader.getEntries()) {
      const data = replacements.get(entry) ?? await zipReader.readEntry(entry);
      // `mimetype` is stored, never deflated — the EPUB spec requires it.
      zipWriter.addFile(entry, data, entry !== 'mimetype');
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await zipWriter.write(outputPath);
  } finally {
    zipReader.close();
  }

  // ── The promise, kept or the file destroyed ───────────────────────────
  // Re-read what was written and confirm every key is on exactly one element of
  // the copy. A stamp that did not survive serialization would show up in quire
  // as an element with no page, which is the failure this package exists to make
  // impossible, so it is caught here where it can still be named.
  try {
    await verifyStamps(outputPath, stamped, whatFor);
  } catch (err) {
    await fs.rm(outputPath, { force: true });
    throw err;
  }

  return {
    outputPath,
    documents: walked.map((w) => w.file),
    stamped,
    textUnitCount,
    imageElementCount,
    sharedElements,
  };
}

/** Confirm the written copy really carries every key, exactly once. */
async function verifyStamps(
  stampedEpubPath: string,
  expected: StampedElement[],
  whatFor: string,
): Promise<void> {
  const byFile = new Map<string, string[]>();
  for (const s of expected) {
    const list = byFile.get(s.file);
    if (list) list.push(s.key); else byFile.set(s.file, [s.key]);
  }

  const zipReader = new ZipReader(stampedEpubPath);
  try {
    await zipReader.open();
    for (const [file, keys] of byFile) {
      const xhtml = (await zipReader.readEntry(file)).toString('utf8');
      const found = new Set<string>();
      const re = new RegExp(`${QUIRE_ID_ATTRIBUTE}="([^"]*)"`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(xhtml)) !== null) {
        for (const id of m[1].split(QUIRE_ID_SEPARATOR)) found.add(id);
      }
      const missing = keys.filter((k) => !found.has(k));
      if (missing.length > 0) {
        throw new Error(
          `[quire-stamp] ${whatFor}: ${missing.length} of ${keys.length} keys did not survive `
          + `into ${file} — e.g. ${missing.slice(0, 5).join(', ')}. The stamped copy has been `
          + 'deleted; nothing downstream may use a book whose identity is incomplete.',
        );
      }
      const extra = [...found].filter((id) => !keys.includes(id));
      if (extra.length > 0) {
        throw new Error(
          `[quire-stamp] ${whatFor}: ${file} carries ${extra.length} stamp(s) no walk produced `
          + `— e.g. ${extra.slice(0, 5).join(', ')}. The stamped copy has been deleted.`,
        );
      }
    }
  } finally {
    zipReader.close();
  }
}
