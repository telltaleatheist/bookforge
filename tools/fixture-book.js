/**
 * fixture-book — reading and placing a BOOK in a test, whichever container it is.
 *
 * Every suite here used to say the same three things in its own words:
 * `crypto.createHash('sha256').update(fs.readFileSync(book))` for its identity,
 * `new ZipReader(book)` for one of its documents, and `fs.copyFileSync(built,
 * book)` to put a fixture where the project expects its book. All three are
 * "a book is one file", and the working copy is now `source/<stem>.working/` —
 * a folder of the book's parts — so all three throw `EISDIR` at once.
 *
 * The replacements are not new logic: they are the app's OWN seam
 * (electron/epub-container.ts) and the app's own identity
 * (`bookDigest`, electron/sidecar-binding.ts), which is the point. A suite that
 * hashed a fixture its own way would be proving something about the test rather
 * than about the book the app is going to read.
 *
 * Deliberately NOT here: building an EPUB. Each suite's fixture book is part of
 * what it is testing — a book with a printed contents page, a book with a plate,
 * a book whose chapter is one paragraph — and those builders stay where the
 * tests that mean them are.
 */
'use strict';

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const {
  createEpubSink,
  epubContainerKindAt,
  openEpubSource,
  removeEpubContainer,
} = require(path.join(DIST, 'electron', 'epub-container.js'));
const { bookDigest } = require(path.join(DIST, 'electron', 'sidecar-binding.js'));

/** The book's identity AS RECORDED — self-describing (shared/book-digest.ts). */
async function bookDigestOf(bookPath) {
  return (await bookDigest(bookPath)).digest;
}

/** Every entry name of a book, in the order the seam reports them. */
async function bookEntryNames(bookPath) {
  const source = await openEpubSource(bookPath);
  try {
    return source.getEntries();
  } finally {
    source.close();
  }
}

/** One entry's bytes. */
async function bookEntryBytes(bookPath, name) {
  const source = await openEpubSource(bookPath);
  try {
    return await source.readEntry(name);
  } finally {
    source.close();
  }
}

/** One entry, as text. */
async function bookEntryText(bookPath, name) {
  return (await bookEntryBytes(bookPath, name)).toString('utf8');
}

/**
 * Put the book at `fromPath` at `toPath`, as `kind` — the fixture equivalent of
 * a mint. `fromPath` is usually a freshly built EPUB archive and `toPath` is
 * usually a project's working copy, which is a folder of the book's parts.
 *
 * Whatever was at `toPath` goes first: a fixture that landed on half of a
 * previous book would be a book neither test wrote.
 */
async function placeBook(fromPath, toPath, kind = 'directory') {
  await removeEpubContainer(toPath);
  const source = await openEpubSource(fromPath);
  try {
    const sink = await createEpubSink(toPath, kind);
    for (const name of source.getEntries()) {
      if (name.endsWith('/')) continue;
      sink.addFile(name, await source.readEntry(name), name !== 'mimetype');
    }
    source.close();
    await sink.write(toPath);
  } finally {
    source.close();
  }
}

/**
 * Rewrite ONE entry of a book in place, leaving every other entry untouched.
 *
 * The gesture the exploded working copy exists for, and the one a test needs to
 * make a book "change underneath" a record that was stamped against it.
 */
async function replaceBookEntry(bookPath, name, contents) {
  const kind = await epubContainerKindAt(bookPath);
  if (kind === null) throw new Error(`fixture-book: there is no book at ${bookPath}`);
  const entries = new Map();
  const source = await openEpubSource(bookPath);
  try {
    for (const entry of source.getEntries()) {
      entries.set(entry, await source.readEntry(entry));
    }
  } finally {
    source.close();
  }
  if (!entries.has(name)) {
    throw new Error(`fixture-book: ${bookPath} has no entry called ${name}`);
  }
  entries.set(name, Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8'));
  const sink = await createEpubSink(bookPath, kind);
  for (const [entry, data] of entries) sink.addFile(entry, data, entry !== 'mimetype');
  await sink.write(bookPath);
}

module.exports = {
  bookDigestOf,
  bookEntryBytes,
  bookEntryNames,
  bookEntryText,
  placeBook,
  replaceBookEntry,
};
