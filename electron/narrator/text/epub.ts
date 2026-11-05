/**
 * Open an EPUB the way ebooklib 0.20 does, because the session's chapters, titles and refusals all come
 * from what it does. Its quirks stay: the reading order is the manifest filtered by the spine, a nav
 * without a `toc` is a crash, and a book missing one manifest file does not open.
 *
 * Nothing but the document being read is held in memory. Every other member streams through the
 * same checks that reading it would make, because the Python refused a book for a bad one.
 */

import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';

import {
  pyExtension, pyPosixDirname, pyPosixJoin, pyPosixNormpath, pyStrip, pyUnquote,
} from '../py-compat';
import {
  Libxml2, LxmlNode, attr, descendants, find, findAll, nsmap, textContent,
} from './html/lxml';
import { BadZipFile, NoSuchMember, ZipFile } from './html/zipfile';
import { EPUB_NATIVE, PDF_DERIVED, SourceKind, UnknownProvenance } from './paragraph-packer';

const NS = {
  EPUB_CONTAINER: 'urn:oasis:names:tc:opendocument:xmlns:container',
  OPF: 'http://www.idpf.org/2007/opf',
  DAISY: 'http://www.daisy.org/z3986/2005/ncx/',
  DC: 'http://purl.org/dc/elements/1.1/',
};
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/svg+xml'];
/** ebooklib's own cover page, which replaces an EpubCoverHtml's content the first time it is read. */
const COVER_TEMPLATE = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
 <head>
  <style>
    body { margin: 0em; padding: 0em; }
    img { max-width: 100%; max-height: 100%; }
  </style>
 </head>
 <body>
   <img src="" alt="" />
 </body>
</html>`, 'utf8');
const EXTENSION_TYPES: ReadonlyMap<string, ItemType> = new Map(Object.entries({
  '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.tiff': 'image', '.tif': 'image', '.png': 'image',
}) as Array<[string, ItemType]>);

export const PROVENANCE_CATEGORY_ATTR = 'data-bf-category';
export const CONVERSION_CATEGORY_ATTR = 'data-bf-cat';
const SOURCE_KIND_ENV = 'NARRATOR_SOURCE_KIND';
const METADATA_KEYS = [
  'title', 'creator', 'contributor', 'language', 'identifier', 'publisher', 'date', 'description',
  'subject', 'rights', 'format', 'type', 'coverage', 'relation', 'Source', 'Modified',
];

/** An --ebook prep will not read. Named, because it is an answer an operator can act on. */
export class UnsupportedInput extends Error {}

/** ebooklib's own `EpubException`, whose `str()` is its message's `repr()`. */
export class EpubException extends Error {
  constructor(message: string) {
    super(`'${message}'`);
  }
}

/** What Python raised where it had no named refusal: an `AttributeError`, a `TypeError`, an `IndexError`. */
export class EpubCrash extends Error {}

type ItemKind = 'item' | 'ncx' | 'smil' | 'html' | 'nav' | 'coverHtml' | 'image' | 'cover';
type ItemType = 'image' | 'cover' | 'document' | 'other';

export interface TocEntry {
  readonly title: string | null;
  readonly href: string;
}
/** A Link or a Section, or a Section with its children. */
export type TocNode = TocEntry | [TocEntry, TocNode[]];

export const pathMd5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex');

export async function acceptEpub(src: string): Promise<void> {
  const stat = await fsp.stat(src).catch(() => null);
  if (!stat || !stat.isFile()) throw new UnsupportedInput(`--ebook does not exist: ${src}`);
  if (stat.size === 0) throw new UnsupportedInput(`Input file is empty: ${src}`);
  const ext = path.extname(src).toLowerCase();
  if (ext !== '.epub') {
    throw new UnsupportedInput(
      `narrator's prep reads EPUB only, not '${ext}' (${src}). ebook2audiobook converted pdf/txt/image inputs `
      + "with Calibre; BookForge's Foundry produces an EPUB for every book, and running Calibre over an EPUB was "
      + 'measurably destructive (it split one 7-chapter book into 78 spine documents and rewrote the book\'s '
      + 'straight quotes). Convert this input in Foundry first.');
  }
}

export class EpubItem {
  /** Replaces what the archive holds, once an EpubCoverHtml has been read. */
  private override: Buffer | null = null;

  constructor(
    private readonly book: EpubBook,
    readonly kind: ItemKind,
    readonly id: string,
    readonly fileName: string,
    private readonly member: string,
  ) {}

  /** The bytes as they sit in the book, which is `item.content`. */
  content(): Promise<Buffer> {
    return this.override ? Promise.resolve(this.override) : this.book.zip.read(this.member);
  }

  get type(): ItemType {
    if (this.kind === 'html' || this.kind === 'nav' || this.kind === 'coverHtml') return 'document';
    if (this.kind === 'image') return 'image';
    if (this.kind === 'cover') return 'cover';
    return EXTENSION_TYPES.get(pyExtension(this.fileName).toLowerCase()) ?? 'other';
  }

  /** `EpubHtml.get_body_content`. A document with no body at all is a crash, not an empty answer. */
  async bodyContent(): Promise<Buffer> {
    const content = await this.content();
    let body;
    try {
      body = this.book.libxml2.serializeBody(content);
    } catch {
      return Buffer.alloc(0);
    }
    if (body === null) throw new EpubCrash("object of type 'NoneType' has no len()");
    if (body.length === 0) return Buffer.alloc(0);
    const { tostring } = body;
    if (tostring.subarray(0, 6).toString('latin1') === '<body>') {
      return tostring.subarray(6, tostring.lastIndexOf('</body>'));
    }
    return tostring;
  }

  /**
   * Does `get_content()`, the document ebooklib rebuilds from its template, contain this text? It holds the
   * body's children and their tails. The body's own attributes and leading text do not survive it,
   * so they are cut here rather than searched. Comparing with the raw file would be a different question.
   */
  async regeneratedContains(needles: readonly string[]): Promise<boolean> {
    if (this.kind === 'coverHtml') this.override = COVER_TEMPLATE;
    const content = await this.content();
    let body;
    try {
      body = this.book.libxml2.serializeBody(content);
    } catch {
      return false;
    }
    if (body === null) return false;
    const text = body.tostring.toString('utf8');
    const openEnd = text.indexOf('>');
    const firstChild = text.indexOf('<', openEnd);
    const children = firstChild < 0 ? '' : text.slice(firstChild);
    return needles.some((needle) => children.includes(needle));
  }
}

export class EpubBook {
  readonly items: EpubItem[] = [];
  spine: Array<string | null> = [];
  toc: TocNode[] | TocEntry = [];
  metadata = new Map<string | null, Map<string | null, Array<string | null>>>();

  constructor(readonly zip: ZipFile, readonly libxml2: Libxml2) {}

  close(): Promise<void> {
    return this.zip.close();
  }

  getMetadata(name: string): Array<string | null> {
    const namespace = this.metadata.get(NS.DC);
    if (!namespace) throw new EpubCrash(`'${NS.DC}'`);
    return namespace.get(name) ?? [];
  }

  itemsOfType(type: ItemType): EpubItem[] {
    return this.items.filter((item) => item.type === type);
  }

  /** Manifest order filtered by the spine, NOT spine order. Every rendered book's chapter numbers rest on this. */
  spineDocuments(): EpubItem[] {
    const spine = new Set(this.spine);
    return this.itemsOfType('document').filter((item) => spine.has(item.id));
  }
}

const crash = (message: string): EpubCrash => new EpubCrash(message);
const none = (what: string): EpubCrash => crash(`'NoneType' object has no attribute '${what}'`);
const needHref = (value: string | null): string => {
  if (value === null) throw crash("argument of type 'NoneType' is not iterable");
  return value;
};

class Reader {
  private opfFile = '';
  private opfDir = '';
  private idHtml = 0;
  private idImage = 0;
  private idStatic = 0;

  constructor(private readonly book: EpubBook) {}

  private readFile(name: string): Promise<Buffer> {
    return this.book.zip.read(pyPosixNormpath(name));
  }

  async load(): Promise<void> {
    this.loadContainer(await this.readFile('META-INF/container.xml'));
    let opf: Buffer;
    try {
      opf = await this.readFile(this.opfFile);
    } catch (err) {
      if (err instanceof NoSuchMember) throw new EpubException('Can not find container file');
      throw err;
    }
    const root = this.book.libxml2.parseXml(opf);
    this.loadMetadata(root);
    const nav = await this.loadManifest(root);
    await this.loadSpine(root, nav);
    if (nav) {
      const content = await nav.content();
      const base = pyPosixDirname(nav.fileName);
      this.book.toc = this.parseNavToc(content, base);
      this.parseNavPages(content, base);
    }
  }

  private loadContainer(content: Buffer): void {
    const tree = this.book.libxml2.parseXml(content);
    const rootfile = `{${NS.EPUB_CONTAINER}}rootfile`;
    for (const node of descendants(tree)) {
      if (node.kind === 'element' && node.tag === rootfile && attr(node, 'media-type') === 'application/oebps-package+xml') {
        const fullPath = attr(node, 'full-path');
        if (fullPath === null) throw crash('expected str, bytes or os.PathLike object, not NoneType');
        this.opfFile = fullPath;
        this.opfDir = pyPosixDirname(fullPath);
      }
    }
  }

  private loadMetadata(root: LxmlNode): void {
    const metadata = find(root, `{${NS.OPF}}metadata`);
    if (!metadata) throw none('nsmap');
    const scope = nsmap(metadata);
    const defaultNs = scope.get(null) ?? '';
    const out = this.book.metadata;
    for (const uri of scope.values()) out.set(uri, new Map());
    const add = (ns: string | null, tag: string | null, value: string | null): void => {
      let names = out.get(ns);
      if (!names) { names = new Map(); out.set(ns, names); }
      const values = names.get(tag) ?? [];
      values.push(value);
      names.set(tag, values);
    };
    for (const t of metadata.children) {
      if (t.kind === 'comment') continue;
      if (t.kind !== 'element') throw crash("'builtin_function_or_method' object has no attribute 'rfind'");
      if (t.tag === `${defaultNs}meta`) {
        let name = attr(t, 'name');
        let prefix: string | null = null;
        if (name && name.includes(':')) {
          const colon = name.indexOf(':');
          prefix = name.slice(0, colon);
          name = name.slice(colon + 1);
        }
        const inScope = nsmap(t);
        add(inScope.has(prefix) ? inScope.get(prefix) as string : prefix, name, t.text);
      } else {
        const inScope = nsmap(t);
        if (!inScope.has(t.prefix)) throw crash(t.prefix === null ? 'None' : `'${t.prefix}'`);
        add(inScope.get(t.prefix) as string, t.tag.slice(t.tag.lastIndexOf('}') + 1), t.text);
      }
    }
    this.book.getMetadata('title');
  }

  private assignId(kind: ItemKind, id: string | null): string {
    if (id) return id;
    if (kind === 'html' || kind === 'nav' || kind === 'coverHtml') return `chapter_${this.idHtml++}`;
    if (kind === 'image') return `image_${this.idImage++}`;
    return `static_${this.idStatic++}`;
  }

  /** Every member is read in manifest order, so the first bad one refuses the book as it did. */
  private async loadManifest(root: LxmlNode): Promise<EpubItem | null> {
    const manifest = find(root, `{${NS.OPF}}manifest`);
    if (!manifest) throw crash("'NoneType' object is not iterable");
    let nav: EpubItem | null = null;
    for (const r of manifest.children) {
      if (r.kind !== 'element' || r.tag !== `{${NS.OPF}}item`) continue;
      let mediaType = attr(r, 'media-type');
      const propertiesText = attr(r, 'properties') ?? '';
      const properties = propertiesText ? propertiesText.split(' ') : [];
      if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
      const href = attr(r, 'href');
      const unquoted = (): string => pyUnquote(needHref(href));
      let kind: ItemKind;
      let id = attr(r, 'id');
      let fileName: string;
      let member: string;
      if (mediaType === 'application/xhtml+xml' && properties.includes('nav')) {
        // The one read that does not unquote its href. A percent-encoded nav does not open.
        kind = 'nav';
        fileName = unquoted();
        member = needHref(href);
      } else if (mediaType === 'application/xhtml+xml' && properties.includes('cover')) {
        kind = 'coverHtml';
        id = 'cover';
        fileName = 'cover.xhtml';
        member = unquoted();
      } else {
        fileName = unquoted();
        member = fileName;
        if (mediaType === 'application/x-dtbncx+xml') kind = 'ncx';
        else if (mediaType === 'application/smil+xml') kind = 'smil';
        else if (mediaType === 'application/xhtml+xml') kind = 'html';
        else if (mediaType !== null && IMAGE_MEDIA_TYPES.includes(mediaType)) kind = properties.includes('cover-image') ? 'cover' : 'image';
        else kind = 'item';
      }
      const resolved = pyPosixNormpath(pyPosixJoin(this.opfDir, member));
      await this.book.zip.verify(resolved);
      const item = new EpubItem(this.book, kind, this.assignId(kind, id), fileName, resolved);
      this.book.items.push(item);
      if (kind === 'nav' && !nav) nav = item;
    }
    return nav;
  }

  private async loadSpine(root: LxmlNode, nav: EpubItem | null): Promise<void> {
    const spine = find(root, `{${NS.OPF}}spine`);
    if (!spine) throw crash("'NoneType' object is not iterable");
    this.book.spine = spine.children.map((t) => attr(t, 'idref'));
    const toc = attr(spine, 'toc') ?? '';
    if (!toc || nav) return;
    const item = this.book.items.find((candidate) => candidate.id === toc);
    if (!item) throw none('get_name');
    let ncx: Buffer;
    try {
      ncx = await this.readFile(pyPosixJoin(this.opfDir, item.fileName));
    } catch (err) {
      if (err instanceof NoSuchMember) throw new EpubException('Can not find ncx file.');
      throw err;
    }
    this.book.toc = this.parseNcx(ncx);
  }

  private parseNcx(content: Buffer): TocNode[] | TocEntry {
    const root = this.book.libxml2.parseXml(content);
    const navMap = find(root, `{${NS.DAISY}}navMap`);
    if (!navMap) throw none('getchildren');
    const walk = (elems: LxmlNode, depth: number): TocNode | TocNode[] => {
      let label: string | null = '';
      let href = '';
      const children: TocNode[] = [];
      for (const a of elems.children) {
        if (a.kind !== 'element') continue;
        if (a.tag === `{${NS.DAISY}}navLabel`) {
          if (a.children.length === 0) throw crash('list index out of range');
          label = a.children[0].text;
        }
        if (a.tag === `{${NS.DAISY}}content`) href = attr(a, 'src') ?? '';
        if (a.tag === `{${NS.DAISY}}navPoint`) children.push(walk(a, depth + 1) as TocNode);
      }
      if (children.length > 0) return depth === 0 ? children : [{ title: label, href }, children];
      return { title: label, href };
    };
    return walk(navMap, 0) as TocNode[] | TocEntry;
  }

  private parseNavList(list: LxmlNode | null, base: string): TocNode[] {
    if (!list) throw none('findall');
    const items: TocNode[] = [];
    for (const node of findAll(list, 'li')) {
      const sublist = find(node, 'ol');
      const link = find(node, 'a');
      const href = link ? attr(link, 'href') : null;
      const resolved = (): string => pyPosixNormpath(pyPosixJoin(base, href as string));
      if (sublist) {
        const title = textContent(node.children[0]);
        const children = this.parseNavList(sublist, base);
        items.push([{ title, href: href ? resolved() : '' }, children]);
      } else if (link && href) {
        items.push({ title: textContent(link), href: resolved() });
      }
    }
    return items;
  }

  private navNodes(content: Buffer, type: string): LxmlNode[] {
    const root = this.book.libxml2.parseHtml(content);
    return [root, ...descendants(root)].filter((node) =>
      node.kind === 'element' && node.tag === 'nav' && node.attrs.some(([, value]) => value === type));
  }

  private parseNavToc(content: Buffer, base: string): TocNode[] {
    const nodes = this.navNodes(content, 'toc');
    if (nodes.length === 0) throw crash('list index out of range');
    return this.parseNavList(find(nodes[0], 'ol'), base);
  }

  /** The page list is not used, but reading it could refuse the book. */
  private parseNavPages(content: Buffer, base: string): void {
    const nodes = this.navNodes(content, 'page-list');
    if (nodes.length === 0) return;
    for (const page of this.parseNavList(find(nodes[0], 'ol'), base)) {
      if (Array.isArray(page)) throw crash("'tuple' object has no attribute 'href'");
    }
  }
}

/**
 * `epub.read_epub(path, {'ignore_ncx': True})`. `BadZipFile` and `LargeZipFile` become ebooklib's
 * `EpubException`; everything else leaves as it came.
 */
export async function readEpub(file: string, libxml2: Libxml2): Promise<EpubBook> {
  let zip: ZipFile;
  try {
    zip = await ZipFile.open(file);
  } catch (err) {
    if (err instanceof BadZipFile) throw new EpubException('Bad Zip file');
    throw err;
  }
  const book = new EpubBook(zip, libxml2);
  try {
    await new Reader(book).load();
  } catch (err) {
    await zip.close();
    throw err;
  }
  return book;
}

/** Depth first, in document order. A Section counts as an entry, and so does each child under it. */
export function flattenToc(nodes: TocNode[] | TocEntry, log: (line: string) => void): TocEntry[] {
  if (!Array.isArray(nodes)) {
    log("flatten_toc() error: 'Link' object is not iterable");
    return [];
  }
  const out: TocEntry[] = [];
  for (const node of nodes) {
    if (Array.isArray(node)) {
      const [section, children] = node;
      out.push(section);
      out.push(...flattenToc(children, log));
    } else {
      out.push(node);
    }
  }
  return out;
}

/** The form a TOC href and a spine document's name are compared in. Null when there is nothing to compare. */
export function normalizeDocKey(href: string | null | undefined): string | null {
  if (!href) return null;
  let s = pyStrip(String(href).split('#')[0]);
  if (!s) return null;
  s = pyUnquote(s).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '');
  return s.toLowerCase() || null;
}

/** Every template key, overwritten by the LAST value found, with the title falling to the file name. */
export function readMetadata(book: EpubBook, filenameNoExt: string): Record<string, string | null> {
  const metadata: Record<string, string | null> = {};
  for (const key of METADATA_KEYS) {
    const values = book.getMetadata(key);
    metadata[key] = values.length > 0 ? values[values.length - 1] : null;
  }
  metadata['title'] = metadata['title'] ? metadata['title'] : filenameNoExt.replace(/_/g, ' ');
  return metadata;
}

export function sourceKindFromEnv(): SourceKind | null {
  const value = pyStrip(process.env[SOURCE_KIND_ENV] ?? '');
  if (!value) return null;
  if (value !== EPUB_NATIVE && value !== PDF_DERIVED) {
    throw new UnknownProvenance(`${SOURCE_KIND_ENV}='${value}' is not one of '${EPUB_NATIVE}' / '${PDF_DERIVED}'`);
  }
  return value;
}

/** Foundry stamps these in the XHTML and never in the OPF. A book without one is a publisher's, not an unknown. */
export async function detectSourceKind(book: EpubBook): Promise<SourceKind> {
  const needles = [PROVENANCE_CATEGORY_ATTR, `${CONVERSION_CATEGORY_ATTR}="`];
  for (const item of book.spineDocuments()) {
    if (await item.regeneratedContains(needles)) return PDF_DERIVED;
  }
  return EPUB_NATIVE;
}

export async function resolveSourceKind(book: EpubBook, log: (line: string) => void): Promise<SourceKind> {
  const override = sourceKindFromEnv();
  if (override) {
    log(`[provenance] ${SOURCE_KIND_ENV}=${override} (explicit override)`);
    return override;
  }
  const kind = await detectSourceKind(book);
  log(`[provenance] ${kind} (read from the book: ${PROVENANCE_CATEGORY_ATTR} / ${CONVERSION_CATEGORY_ATTR})`);
  return kind;
}
