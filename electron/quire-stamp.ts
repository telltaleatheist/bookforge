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
 * ── Where the stamps go ───────────────────────────────────────────────────
 *
 * Into markup, never into the book. {@link stampEpubForQuire} writes a whole
 * stamped COPY of a book and is what a harness uses, because a harness wants a
 * file it can open twice and compare. The app does not: it holds the stamped
 * documents in memory and hands them to `Quire.openDocument(book, { sources })`,
 * so the book on disk is read for its pictures and stylesheets and nothing is
 * duplicated. Both routes go through {@link stampWalkedDocuments}, so a document
 * stamped either way is stamped identically, and both verify what they produced
 * before anything is allowed to use it.
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
  EpubProcessor,
  parseXhtmlBody, collectExportUnits, collectImageElements, normalizeZipEntryName,
  unitTextContent,
  type MarkupUnit,
} from './epub-processor';
import { openEpubSource, removeEpubContainer, rewriteEpubEntries } from './epub-container';
import {
  narrationElementKey, narrationFingerprint, narrationImageElementKey,
  type NarrationDocumentShape, type NarrationElementKey,
} from '../shared/vlm/narration-deletions';
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
  only?: ReadonlySet<string>,
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
      // `only` narrows the walk to some of the book's documents. Sound because
      // an element's key is `<zip entry>#<index within that entry>`: the index
      // restarts at every document and the picture ordinals with it, so what a
      // document's elements are called is a function of that document alone and
      // of nothing before or after it. Skipping documents therefore changes no
      // key of the ones that are walked. Absent, the whole spine is walked, which
      // is what every caller that mints identity for the WHOLE book must do.
      if (only !== undefined && !only.has(entryName)) continue;

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
          unit: {
            file: entryName, key, tag: c.tag, el: c.el,
            imageOnly: c.imageOnly, normText: c.normText,
          },
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
 * The book's enumeration, reduced to what a strike key depends on.
 *
 * The projection a pass compares before and after itself
 * (`narrationCarryRefusal`). Deliberately built from the SAME walk the keys are
 * minted by, and deliberately without the DOM: the comparison is about which
 * keys exist and what they were minted from, and holding two whole parsed books
 * to answer that would cost hundreds of megabytes on a real one.
 */
export async function narrationDocumentShapes(
  epubPath: string,
  whatFor: string,
): Promise<NarrationDocumentShape[]> {
  const walked = await enumerateNarrationElements(epubPath, whatFor);
  return walked.map(({ file, entries }) => ({
    file,
    keys: entries.map((entry) => entry.key),
    tags: entries.map((entry) => entry.tag),
  }));
}

/**
 * What every TEXT element of the book says, as a strike would remember it.
 *
 * One entry per unit key that has any text at all. Pictures and documents are
 * absent by construction — a picture says nothing and a zip entry name cannot
 * shift — which is the same rule `NarrationDeletions.fingerprints` states.
 *
 * Used to fingerprint new strikes and to re-fingerprint carried ones after a
 * pass. The map is for the WHOLE book because the caller does not know, until
 * it is inside the manifest's lock, which keys the record holds.
 */
export async function narrationFingerprintsOfBook(
  epubPath: string,
  whatFor: string,
): Promise<Record<NarrationElementKey, string>> {
  const walked = await enumerateNarrationElements(epubPath, whatFor);
  const out: Record<NarrationElementKey, string> = {};
  for (const doc of walked) {
    for (const entry of doc.entries) {
      if (entry.kind !== 'text') continue;
      const print = narrationFingerprint(unitTextContent(entry.el));
      if (print !== null) out[entry.key] = print;
    }
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
  const walked = await enumerateNarrationElements(epubPath, whatFor);
  const {
    replacements, stamped, sharedElements, textUnitCount, imageElementCount,
  } = stampWalkedDocuments(walked, whatFor);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await rewriteEpubEntries({
    from: epubPath,
    to: outputPath,
    toKind: 'zip',
    build: async (source, sink) => {
      for (const entry of source.getEntries()) {
        const data = replacements.get(entry) ?? await source.readEntry(entry);
        // `mimetype` is stored, never deflated — the EPUB spec requires it.
        sink.addFile(entry, data, entry !== 'mimetype');
      }
    },
  });

  // ── The promise, kept or the file destroyed ───────────────────────────
  // Re-read what was written and confirm every key is on exactly one element of
  // the copy. A stamp that did not survive serialization would show up in quire
  // as an element with no page, which is the failure this package exists to make
  // impossible, so it is caught here where it can still be named.
  try {
    await verifyStampedDocuments(outputPath, stamped, whatFor);
  } catch (err) {
    await removeEpubContainer(outputPath);
    throw new Error(
      `${(err as Error).message} The stamped copy at ${outputPath} has been deleted.`);
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

/** What one pass of the stamper produced, before it is written anywhere. */
export interface StampedDocuments {
  /** Walked document → its XHTML with the keys on it, ready to replace the entry. */
  replacements: Map<string, Buffer>;
  stamped: StampedElement[];
  sharedElements: Array<{ keys: string[]; file: string; tag: string }>;
  textUnitCount: number;
  imageElementCount: number;
}

/**
 * Write each walked element's key onto the element, and serialize its document.
 *
 * The whole of the stamp, held apart from the zip it is written into, because
 * three callers need it over different sets of documents:
 * {@link stampEpubForQuire} over the book, {@link stampSpineDocuments} over the
 * handful an edit rewrote, and — exported for the viewer — a caller that has
 * ALREADY walked the book for its own reasons and would otherwise parse every
 * document a second time to stamp it. One description of the stamp, so a
 * re-stamped chapter cannot be stamped differently from the book it goes back
 * into.
 *
 * Note that this MUTATES the walked DOM: the key is set on the element the walk
 * returned, which is the whole reason identity here is correct by construction
 * rather than by agreement. A caller that goes on using the walk afterwards is
 * using a tree with `data-quire-id` on it.
 */
export function stampWalkedDocuments(
  walked: Array<{ file: string; docs: { doc: any; body: any }; entries: NarrationWalkEntry[] }>,
  whatFor: string,
): StampedDocuments {
  const { XMLSerializer } = require('@xmldom/xmldom');

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

  return { replacements, stamped, sharedElements, textUnitCount, imageElementCount };
}

/**
 * The stamped bytes of NAMED spine documents of a book, and nothing else.
 *
 * For a caller that has rewritten a few of a book's documents and holds a
 * stamped copy of the rest: it re-stamps just those, and the copy is rebuilt
 * around them. This is not a cheaper stamp, it is the SAME stamp over fewer
 * documents — `stampWalkedDocuments`, off the same walk, keyed by the same
 * `<zip entry>#<index>`, whose index restarts at every document (see the `only`
 * argument of {@link enumerateNarrationElements} for why that makes the
 * narrowing sound rather than merely convenient).
 *
 * Refuses when the book's spine does not contain one of the named entries: a
 * caller asking to re-stamp a document that is not in the reading order has
 * mistaken which file it rewrote, and stamping nothing for it would leave the
 * copy carrying the OLD bytes of a document the book has changed.
 */
export async function stampSpineDocuments(
  epubPath: string,
  entries: readonly string[],
  whatFor = path.basename(epubPath),
): Promise<{ documents: Map<string, Buffer>; stamped: StampedElement[] }> {
  const wanted = new Set(entries);
  const walked = await enumerateNarrationElements(epubPath, whatFor, wanted);
  const missing = [...wanted].filter((e) => !walked.some((w) => w.file === e));
  if (missing.length > 0) {
    throw new Error(
      `[quire-stamp] ${whatFor}: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not `
      + 'in this book\'s spine, so there is no document to stamp under that name. Nothing was '
      + 'stamped.',
    );
  }
  const { replacements, stamped } = stampWalkedDocuments(walked, whatFor);
  return { documents: replacements, stamped };
}

/**
 * Confirm a written copy carries every one of these keys, exactly once, in the
 * documents they belong to.
 *
 * Exported for {@link stampSpineDocuments}'s caller, which writes a copy whose
 * other documents were verified when THEY were stamped: passing only the
 * re-stamped elements checks exactly the documents whose bytes are new, and the
 * "no stamp any walk produced" half of the check stays exact because it is
 * asked per file.
 */
export async function verifyStampedDocuments(
  stampedEpubPath: string,
  expected: StampedElement[],
  whatFor: string,
): Promise<void> {
  const zipReader = await openEpubSource(stampedEpubPath);
  try {
    await verifyStamps(
      async (file) => (await zipReader.readEntry(file)).toString('utf8'), expected, whatFor);
  } finally {
    zipReader.close();
  }
}

/**
 * Confirm stamped bytes that were never written anywhere really carry every key,
 * exactly once.
 *
 * The same promise {@link stampEpubForQuire} keeps about the file it wrote, kept
 * about markup that is handed straight to quire instead. A stamp that did not
 * survive serialization is the failure this whole subsystem exists to make
 * impossible, and it is no less possible for the bytes having stayed in memory —
 * the serializer is the same serializer.
 */
export async function verifyStampedSources(
  documents: ReadonlyMap<string, Buffer>,
  expected: StampedElement[],
  whatFor: string,
): Promise<void> {
  return verifyStamps(async (file) => {
    const bytes = documents.get(file);
    if (bytes === undefined) {
      throw new Error(
        `[quire-stamp] ${whatFor}: ${file} carries stamped elements but the stamper produced no `
        + 'bytes for it, so there is nothing to check them against.',
      );
    }
    return bytes.toString('utf8');
  }, expected, whatFor);
}

/** Confirm the stamped markup really carries every key, exactly once. */
async function verifyStamps(
  readDocument: (file: string) => Promise<string>,
  expected: StampedElement[],
  whatFor: string,
): Promise<void> {
  const byFile = new Map<string, string[]>();
  for (const s of expected) {
    const list = byFile.get(s.file);
    if (list) list.push(s.key); else byFile.set(s.file, [s.key]);
  }

  for (const [file, keys] of byFile) {
    const xhtml = await readDocument(file);
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
        + `into ${file} — e.g. ${missing.slice(0, 5).join(', ')}. Nothing downstream may use a `
        + 'book whose identity is incomplete.',
      );
    }
    const extra = [...found].filter((id) => !keys.includes(id));
    if (extra.length > 0) {
      throw new Error(
        `[quire-stamp] ${whatFor}: ${file} carries ${extra.length} stamp(s) no walk produced `
        + `— e.g. ${extra.slice(0, 5).join(', ')}.`,
      );
    }
  }
}
