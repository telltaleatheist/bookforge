/**
 * The part of BeautifulSoup 4.15.0 prep uses, over `html.parser`: its tree rules (no
 * implied tags, an end tag pops to its most recent opener, void names close themselves)
 * and the walks prep makes over the result.
 *
 * Every string is a `NavigableString` in the Python's eyes, comments too, but `get_text`
 * only reads the kinds a tag is interested in. `kind` keeps those apart.
 */

import { pyStrip } from '../../py-compat';
import { HtmlParser } from './html-parser';

export type StringKind =
  | 'string' | 'cdata' | 'comment' | 'doctype' | 'declaration' | 'pi'
  | 'stylesheet' | 'script' | 'template' | 'rubyText' | 'rubyParen';

const STRING_CONTAINERS: ReadonlyMap<string, StringKind> = new Map<string, StringKind>([
  ['rt', 'rubyText'],
  ['rp', 'rubyParen'],
  ['style', 'stylesheet'],
  ['script', 'script'],
  ['template', 'template'],
]);
const EMPTY_ELEMENTS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'image', 'img',
  'input', 'isindex', 'keygen', 'link', 'menuitem', 'meta', 'nextid', 'param', 'source', 'spacer', 'track', 'wbr',
]);
const PRESERVE_WHITESPACE = new Set(['pre', 'textarea']);
// Nothing at all counts: an empty comment comes out as one space, as in the Python.
const ASCII_SPACES_ONLY = /^[ \n\t\f\r]*$/;
const ROOT_NAME = '[document]';

export class SoupString {
  parent: SoupTag | null = null;
  constructor(readonly kind: StringKind, readonly value: string) {}

  /** `.parents`, nearest first, ending at the document. */
  *parents(): Generator<SoupTag> {
    for (let at = this.parent; at !== null; at = at.parent) yield at;
  }
}

export type SoupNode = SoupTag | SoupString;

export class SoupTag {
  readonly contents: SoupNode[] = [];
  parent: SoupTag | null = null;

  constructor(readonly name: string, readonly attrs: ReadonlyMap<string, string>) {}

  get(name: string): string | undefined {
    return this.attrs.get(name);
  }

  /** Document order, depth first, not including this tag. */
  *descendants(): Generator<SoupNode> {
    for (const child of this.contents) {
      yield child;
      if (child instanceof SoupTag) yield* child.descendants();
    }
  }

  *tags(): Generator<SoupTag> {
    for (const node of this.descendants()) if (node instanceof SoupTag) yield node;
  }

  find(name: string): SoupTag | null {
    for (const tag of this.tags()) if (tag.name === name) return tag;
    return null;
  }

  findAll(names: string | readonly string[]): SoupTag[] {
    const wanted = typeof names === 'string' ? [names] : names;
    const found: SoupTag[] = [];
    for (const tag of this.tags()) if (wanted.includes(tag.name)) found.push(tag);
    return found;
  }

  /** `find_all(string=True)`: every string below, of any kind. */
  allStrings(): SoupString[] {
    const found: SoupString[] = [];
    for (const node of this.descendants()) if (node instanceof SoupString) found.push(node);
    return found;
  }

  /** `get_text`. A tag that holds a special kind of string reads only that kind. */
  getText(options: { strip?: boolean; separator?: string } = {}): string {
    const own = STRING_CONTAINERS.get(this.name);
    const parts: string[] = [];
    for (const node of this.descendants()) {
      if (!(node instanceof SoupString)) continue;
      if (own ? node.kind !== own : node.kind !== 'string' && node.kind !== 'cdata') continue;
      const text = options.strip ? pyStrip(node.value) : node.value;
      if (text.length === 0) continue;
      parts.push(text);
    }
    return parts.join(options.separator ?? '');
  }

  /** Removes this tag from its parent. Prep never reads a removed tag again. */
  decompose(): void {
    if (!this.parent) return;
    this.parent.contents.splice(this.parent.contents.indexOf(this), 1);
    this.parent = null;
  }
}

function dereferenceCharRef(name: string): string {
  const hex = name[0] === 'x' || name[0] === 'X';
  const digits = hex ? name.slice(1) : name;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) {
    throw new Error(`The serializer does not write this reference: &#${name};`);
  }
  const code = parseInt(digits, hex ? 16 : 10);
  if (code >= 128 && code <= 159) throw new Error(`The serializer does not write this reference: &#${name};`);
  return String.fromCodePoint(code);
}

const NAMED_REFERENCES: ReadonlyMap<string, string> = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"']]);

/** `BeautifulSoup(markup, 'html.parser')`. The returned tag is the document. */
export function parseSoup(markup: string): SoupTag {
  const root = new SoupTag(ROOT_NAME, new Map());
  const stack: SoupTag[] = [root];
  const openCounts = new Map<string, number>();
  const preserving: SoupTag[] = [];
  const containers: SoupTag[] = [];
  const alreadyClosed: string[] = [];
  let pending: string[] = [];

  const current = (): SoupTag => stack[stack.length - 1];
  const append = (node: SoupNode): void => {
    node.parent = current();
    current().contents.push(node);
  };

  const endData = (kind: StringKind = 'string'): void => {
    if (pending.length === 0) return;
    let text = pending.join('');
    pending = [];
    if (preserving.length === 0 && ASCII_SPACES_ONLY.test(text)) {
      text = text.includes('\n') ? '\n' : ' ';
    }
    const top = containers[containers.length - 1];
    append(new SoupString(kind === 'string' && top ? STRING_CONTAINERS.get(top.name) as StringKind : kind, text));
  };

  const popTag = (): void => {
    const tag = stack.pop() as SoupTag;
    openCounts.set(tag.name, (openCounts.get(tag.name) ?? 0) - 1);
    if (preserving[preserving.length - 1] === tag) preserving.pop();
    if (containers[containers.length - 1] === tag) containers.pop();
  };

  const closeTag = (name: string): void => {
    endData();
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (!openCounts.get(name)) break;
      const isTarget = stack[i].name === name;
      popTag();
      if (isTarget) break;
    }
  };

  const openTag = (name: string, attrs: Array<[string, string | null]>): SoupTag => {
    endData();
    const map = new Map<string, string>();
    for (const [key, value] of attrs) map.set(key, value ?? '');
    const tag = new SoupTag(name, map);
    append(tag);
    stack.push(tag);
    openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
    if (PRESERVE_WHITESPACE.has(name)) preserving.push(tag);
    if (STRING_CONTAINERS.has(name)) containers.push(tag);
    return tag;
  };

  const parser = new HtmlParser({
    startTag(tag, attrs) {
      openTag(tag, attrs);
      if (EMPTY_ELEMENTS.has(tag)) {
        closeTag(tag);
        alreadyClosed.push(tag);
      }
    },
    startEndTag(tag, attrs) {
      openTag(tag, attrs);
      closeTag(tag);
    },
    endTag(tag) {
      const at = alreadyClosed.indexOf(tag);
      if (at >= 0) alreadyClosed.splice(at, 1);
      else closeTag(tag);
    },
    data(text) {
      pending.push(text);
    },
    charRef(name) {
      pending.push(dereferenceCharRef(name));
    },
    entityRef(name) {
      const text = NAMED_REFERENCES.get(name);
      if (text === undefined) throw new Error(`The serializer does not write this reference: &${name};`);
      pending.push(text);
    },
    comment(text) {
      endData();
      pending.push(text);
      endData('comment');
    },
    decl(text) {
      endData();
      pending.push(text.slice('DOCTYPE '.length));
      endData('doctype');
    },
    pi(text) {
      endData();
      pending.push(text);
      endData('pi');
    },
    unknownDecl(text) {
      endData();
      if (text.toUpperCase().startsWith('CDATA[')) {
        pending.push(text.slice('CDATA['.length));
        endData('cdata');
      } else {
        pending.push(text);
        endData('declaration');
      }
    },
  });
  parser.parse(markup);
  endData();
  while (stack.length > 1) popTag();
  return root;
}
