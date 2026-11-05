/**
 * A parsed document as lxml presents it, which is what ebooklib reads. libxml2 builds the tree; this
 * is the part of lxml's API over it that the EPUB reader uses, with lxml's own semantics: `text` stops at
 * the first node that is not text, a comment is a child, and `find` looks only at direct children.
 */

export interface LxmlNode {
  readonly kind: 'element' | 'comment' | 'pi' | 'entity';
  /** `{uri}local` for an element in a namespace. Empty on anything but an element. */
  readonly tag: string;
  readonly prefix: string | null;
  /** The namespace declarations on this element itself. */
  readonly nsDecls: ReadonlyArray<readonly [string | null, string]>;
  /** In document order, with names as lxml spells them. */
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  readonly text: string | null;
  readonly tail: string | null;
  readonly children: readonly LxmlNode[];
  parent: LxmlNode | null;
}

export function linkParents(node: LxmlNode): LxmlNode {
  for (const child of node.children) {
    child.parent = node;
    linkParents(child);
  }
  return node;
}

export function attr(node: LxmlNode, name: string): string | null {
  for (const [key, value] of node.attrs) if (key === name) return value;
  return null;
}

export const find = (node: LxmlNode, tag: string): LxmlNode | null =>
  node.children.find((child) => child.kind === 'element' && child.tag === tag) ?? null;

export const findAll = (node: LxmlNode, tag: string): LxmlNode[] =>
  node.children.filter((child) => child.kind === 'element' && child.tag === tag);

/** `element.nsmap`: the declarations in scope, nearest first. */
export function nsmap(node: LxmlNode): Map<string | null, string> {
  const map = new Map<string | null, string>();
  for (let at: LxmlNode | null = node; at !== null; at = at.parent) {
    for (const [prefix, uri] of at.nsDecls) if (!map.has(prefix)) map.set(prefix, uri);
  }
  return map;
}

export function* descendants(node: LxmlNode): Generator<LxmlNode> {
  for (const child of node.children) {
    yield child;
    yield* descendants(child);
  }
}

/** XPath's `string()`: a comment is its own text, an element is the text under it and never a comment's. */
export function textContent(node: LxmlNode): string {
  if (node.kind !== 'element') return node.text ?? '';
  let out = node.text ?? '';
  for (const child of node.children) {
    if (child.kind === 'element') out += textContent(child);
    out += child.tail ?? '';
  }
  return out;
}

/** What one document's body serialized to. */
export interface SerializedBody {
  /** `etree.tostring(body, pretty_print=True, encoding='utf-8', xml_declaration=False)`. */
  readonly tostring: Buffer;
  /** `len(body)`: elements, comments, processing instructions and entity references. */
  readonly length: number;
}

/**
 * libxml2's surface, as lxml calls it. The parse methods throw when lxml would, so a caller's
 * `try` answers the same questions ebooklib's does.
 */
export interface Libxml2 {
  /** `etree.parse(bytes, XMLParser(recover=True, resolve_entities=False))`'s root. */
  parseXml(content: Buffer): LxmlNode;
  /** `html.document_fromstring(bytes, HTMLParser(encoding='utf-8'))`. */
  parseHtml(content: Buffer): LxmlNode;
  /** The same parse, then the body. Null when the document has none. */
  serializeBody(content: Buffer): SerializedBody | null;
}
