/**
 * The book as an archive: which entries exist, and which of them are the spine
 * documents, in spine order.
 *
 * The spine walk here is intentionally the SAME rule as
 * `EpubProcessor.parseOpf` + `resolvePath` + `normalizeZipEntryName` in
 * `electron/epub-processor.ts`, because that is the walk BookForge's stamper and
 * `writeNarrationEpub` use. If the two ever diverge, the divergence does not
 * hide: quire would find stamps in documents it never walked (or walk documents
 * with no stamps), and every stamp it never saw is reported as unplaced. That is
 * the guarantee — a silent disagreement is impossible.
 *
 * The walk reads the book through a {@link QuireEntrySource}, so it is the same
 * walk whether the book is a zipped `.epub` or an exploded working directory.
 * Which container a book came out of is a fact about the container and never a
 * fact about the book.
 */
import * as fsSync from 'fs';
import { quireFail } from '../errors';
import { QuireZipReader } from './zip-reader';
import { QuireDirectoryReader } from './directory-reader';
import type { QuireEntrySource, QuireEntrySourceKind } from './entry-source';
import type { QuireSpineWarning } from '../types';

/** Content types EpubProcessor accepts as spine documents. Kept identical on purpose. */
const VALID_MEDIA_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'text/x-oeb1-document',
  'application/x-dtbook+xml',
]);

interface RawTag { name: string; attributes: Record<string, string>; }

/** Minimal tag scanner — the OPF is read for structure, never rendered. */
function getAllTags(xml: string, tagName: string): RawTag[] {
  const out: RawTag[] = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)/?>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[1])) !== null) {
      const key = a[1] ?? a[3];
      const val = a[2] ?? a[4];
      attrs[key] = val;
    }
    out.push({ name: tagName, attributes: attrs });
  }
  return out;
}

/** Resolve "." and ".." segments in a zip entry name. Mirrors normalizeZipEntryName. */
export function normalizeEntryName(name: string): string {
  const parts: string[] = [];
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

export interface SpineDocument {
  /** Normalized zip entry name — the string BookForge's element keys are built on. */
  entry: string;
  /** Position in the OPF spine. */
  order: number;
}

export class QuireArchive {
  private readonly source: QuireEntrySource;
  private opened = false;

  /** Spine documents in spine order, deduplicated the way EpubProcessor dedupes them. */
  spine: SpineDocument[] = [];
  spineWarnings: QuireSpineWarning[] = [];
  opfEntry = '';
  rootPath = '';

  /**
   * The one-argument form is the ZIPPED form, and always has been: a caller who
   * writes `new QuireArchive(p)` gets a `.epub` file read as a ZIP, whatever `p`
   * happens to be on disk. A book that is an exploded directory is only ever
   * reached by asking for one — {@link QuireArchive.fromDirectory} — or by
   * handing this constructor the source outright. Nothing here sniffs the path.
   */
  constructor(readonly epubPath: string, source?: QuireEntrySource) {
    this.source = source === undefined ? new QuireZipReader(epubPath) : source;
  }

  /** A zipped `.epub`. The same thing `new QuireArchive(p)` builds, said out loud. */
  static fromZip(epubPath: string): QuireArchive {
    return new QuireArchive(epubPath, new QuireZipReader(epubPath));
  }

  /** A book exploded into a directory, its files at their archive-relative paths. */
  static fromDirectory(directoryPath: string): QuireArchive {
    return new QuireArchive(directoryPath, new QuireDirectoryReader(directoryPath));
  }

  /**
   * A book at a path the caller has already decided is a book, opened as
   * whichever container is actually there.
   *
   * This is the ONE place quire looks at the filesystem to choose, and it looks
   * at exactly one thing — is it a directory — on a path it was handed as a book
   * location. It does not guess from an extension, and it does not look around
   * for a book near the path it was given: a path that cannot be examined is a
   * refusal naming the path, not a search.
   */
  static fromBookPath(bookPath: string): QuireArchive {
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(bookPath);
    } catch (err) {
      quireFail(
        'BOOK_PATH_UNREADABLE',
        `${bookPath} cannot be examined, so quire cannot tell whether the book is a zipped EPUB `
        + `or an exploded directory: ${(err as Error).message}`,
      );
    }
    return stat.isDirectory() ? QuireArchive.fromDirectory(bookPath) : QuireArchive.fromZip(bookPath);
  }

  /** Which container this book was opened from. Worth reporting beside any refusal. */
  get sourceKind(): QuireEntrySourceKind {
    return this.source.kind;
  }

  async open(): Promise<void> {
    this.source.open();
    this.opened = true;

    const containerXml = await this.source.readText('META-INF/container.xml');
    const rootfile = getAllTags(containerXml, 'rootfile')[0];
    const fullPath = rootfile?.attributes['full-path'];
    if (!fullPath) {
      quireFail('EPUB_NO_ROOTFILE',
        `${this.source.describe()}: META-INF/container.xml names no rootfile`);
    }
    this.opfEntry = normalizeEntryName(fullPath);

    const opfXml = await this.source.readText(this.opfEntry);
    const slash = this.opfEntry.lastIndexOf('/');
    this.rootPath = slash === -1 ? '' : this.opfEntry.slice(0, slash);

    const manifest = new Map<string, { href: string; mediaType: string }>();
    for (const item of getAllTags(opfXml, 'item')) {
      const id = item.attributes['id'];
      if (!id) continue;
      manifest.set(id, {
        href: item.attributes['href'] ?? '',
        mediaType: item.attributes['media-type'] ?? '',
      });
    }

    const seen = new Set<string>();
    let order = 0;
    for (const itemref of getAllTags(opfXml, 'itemref')) {
      const idref = itemref.attributes['idref'];
      if (!idref) {
        this.spineWarnings.push({ idref: '(missing)', reason: 'the itemref carries no idref attribute' });
        continue;
      }
      const item = manifest.get(idref);
      if (!item) {
        this.spineWarnings.push({ idref, reason: 'no manifest item matches this idref' });
        continue;
      }
      if (!VALID_MEDIA_TYPES.has(item.mediaType)) {
        this.spineWarnings.push({
          idref,
          reason: `unrecognized media-type "${item.mediaType}"${item.href ? ` (href: ${item.href})` : ''}`,
        });
        continue;
      }
      const entry = normalizeEntryName(this.resolveHref(item.href));
      // A spine document listed twice is ONE file — the same rule the narration
      // writer applies, so the two enumerations line up file for file.
      if (seen.has(entry)) continue;
      seen.add(entry);
      this.spine.push({ entry, order: order++ });
    }

    if (this.spine.length === 0) {
      quireFail('EPUB_EMPTY_SPINE',
        `${this.source.describe()}: the OPF spine yielded no readable documents`);
    }
  }

  /** href → zip entry name. Mirrors EpubProcessor.resolvePath, including its candidates. */
  private resolveHref(href: string): string {
    const join = (p: string) => (this.rootPath ? `${this.rootPath}/${p}` : p);
    const candidates = [href, href.split('#')[0]];
    for (const c of candidates.slice()) {
      try {
        const decoded = decodeURIComponent(c);
        if (decoded !== c) candidates.push(decoded);
      } catch { /* malformed percent-escape — not a URL-encoded href */ }
    }
    for (const c of candidates) {
      if (c && this.source.hasEntry(join(c))) return join(c);
    }
    quireFail(
      'EPUB_HREF_UNRESOLVED',
      `manifest href "${href}" matches no entry in ${this.source.describe()}`,
    );
  }

  hasEntry(name: string): boolean {
    return this.source.hasEntry(name);
  }

  /** Every entry of the book, by name. The same strings whichever container it is. */
  entryNames(): string[] {
    return this.source.entryNames();
  }

  async readEntry(name: string): Promise<Buffer> {
    if (!this.opened) quireFail('ARCHIVE_CLOSED', `${this.source.describe()} is not open`);
    return this.source.readEntry(name);
  }

  async readText(name: string): Promise<string> {
    return (await this.readEntry(name)).toString('utf8');
  }

  close(): void {
    if (this.opened) {
      this.source.close();
      this.opened = false;
    }
  }
}
