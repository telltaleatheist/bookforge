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
 */
import { quireFail } from '../errors';
import { QuireZipReader } from './zip-reader';
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
  private readonly zip: QuireZipReader;
  private opened = false;

  /** Spine documents in spine order, deduplicated the way EpubProcessor dedupes them. */
  spine: SpineDocument[] = [];
  spineWarnings: QuireSpineWarning[] = [];
  opfEntry = '';
  rootPath = '';

  constructor(readonly epubPath: string) {
    this.zip = new QuireZipReader(epubPath);
  }

  async open(): Promise<void> {
    this.zip.open();
    this.opened = true;

    const containerXml = await this.zip.readText('META-INF/container.xml');
    const rootfile = getAllTags(containerXml, 'rootfile')[0];
    const fullPath = rootfile?.attributes['full-path'];
    if (!fullPath) {
      quireFail('EPUB_NO_ROOTFILE', `${this.epubPath}: META-INF/container.xml names no rootfile`);
    }
    this.opfEntry = normalizeEntryName(fullPath);

    const opfXml = await this.zip.readText(this.opfEntry);
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
      quireFail('EPUB_EMPTY_SPINE', `${this.epubPath}: the OPF spine yielded no readable documents`);
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
      if (c && this.zip.hasEntry(join(c))) return join(c);
    }
    quireFail(
      'EPUB_HREF_UNRESOLVED',
      `${this.epubPath}: manifest href "${href}" matches no entry in the archive`,
    );
  }

  hasEntry(name: string): boolean {
    return this.zip.hasEntry(name);
  }

  async readEntry(name: string): Promise<Buffer> {
    if (!this.opened) quireFail('ARCHIVE_CLOSED', `${this.epubPath} is not open`);
    return this.zip.readEntry(name);
  }

  async readText(name: string): Promise<string> {
    return (await this.readEntry(name)).toString('utf8');
  }

  close(): void {
    if (this.opened) {
      this.zip.close();
      this.opened = false;
    }
  }
}
