/**
 * A port of CPython 3.11.15's `html.parser.HTMLParser` with `convert_charrefs=False`, the
 * one way BeautifulSoup drives it. Prep's markup has always come out of libxml2's
 * serializer first, so this parser is not a general reader of the web: the only named
 * references it can meet are the four the serializer writes.
 *
 * The expressions are CPython's, character for character. Its `str.strip` and JavaScript's
 * `trim` disagree, so `pyStrip` stands in.
 */

import { pyStrip } from '../../py-compat';

export interface HtmlEvents {
  startTag(tag: string, attrs: Array<[string, string | null]>): void;
  startEndTag(tag: string, attrs: Array<[string, string | null]>): void;
  endTag(tag: string): void;
  data(text: string): void;
  charRef(name: string): void;
  entityRef(name: string): void;
  comment(text: string): void;
  decl(text: string): void;
  pi(text: string): void;
  unknownDecl(text: string): void;
}

const INTERESTING_NORMAL = /[&<]/g;
const INCOMPLETE = /&[a-zA-Z#]/y;
const ENTITY_REF = /&([a-zA-Z][-.a-zA-Z0-9]*)[^a-zA-Z0-9]/y;
const CHAR_REF = /&#(?:[0-9]+|[xX][0-9a-fA-F]+)[^0-9a-fA-F]/y;
const START_TAG_OPEN = /<[a-zA-Z]/y;
const END_TAG_OPEN = /<\/[a-zA-Z]/y;
const COMMENT_CLOSE = /--!?>/g;
const COMMENT_ABRUPT_CLOSE = /-?>/y;
const TAG_FIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTR_FIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATE_TAG_END = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;

const CDATA_CONTENT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const RCDATA_CONTENT = new Set(['textarea', 'title']);

function matchAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** `html.unescape`, for what the serializer can put in an attribute. */
export function unescapeAttribute(value: string): string {
  return value.replace(/&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const code = parseInt(ref.slice(hex ? 2 : 1).replace(/;$/, ''), hex ? 16 : 10);
      return String.fromCodePoint(code);
    }
    switch (ref) {
      case 'amp;': return '&';
      case 'lt;': return '<';
      case 'gt;': return '>';
      case 'quot;': return '"';
      default: throw new Error(`The serializer does not write this reference in an attribute: ${whole}`);
    }
  });
}

export class HtmlParser {
  private raw = '';
  private interesting = INTERESTING_NORMAL;
  private cdataElem: string | null = null;

  constructor(private readonly events: HtmlEvents) {}

  /** `feed` then `close`, which is all BeautifulSoup ever does with one. */
  parse(markup: string): void {
    this.raw = markup;
    this.goAhead(false);
    this.goAhead(true);
  }

  private setCdataMode(elem: string, escapable: boolean): void {
    this.cdataElem = elem.toLowerCase();
    if (this.cdataElem === 'plaintext') {
      this.interesting = /$(?![\s\S])/g;
    } else {
      const name = this.cdataElem.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      this.interesting = new RegExp(`${escapable ? '&|' : ''}</${name}(?=[\\t\\n\\r\\f />])`, 'gi');
    }
  }

  private clearCdataMode(): void {
    this.interesting = INTERESTING_NORMAL;
    this.cdataElem = null;
  }

  private goAhead(end: boolean): void {
    const raw = this.raw;
    const n = raw.length;
    const on = this.events;
    let i = 0;
    while (i < n) {
      this.interesting.lastIndex = i;
      const found = this.interesting.exec(raw);
      let j: number;
      if (found) {
        j = found.index;
      } else {
        if (this.cdataElem) break;
        j = n;
      }
      if (i < j) on.data(raw.slice(i, j));
      i = j;
      if (i === n) break;
      if (raw.startsWith('<', i)) {
        let k: number;
        if (matchAt(START_TAG_OPEN, raw, i)) k = this.parseStartTag(i);
        else if (raw.startsWith('</', i)) k = this.parseEndTag(i);
        else if (raw.startsWith('<!--', i)) k = this.parseComment(i);
        else if (raw.startsWith('<?', i)) k = this.parsePi(i);
        else if (raw.startsWith('<!', i)) k = this.parseHtmlDeclaration(i);
        else if (i + 1 < n || end) {
          on.data('<');
          k = i + 1;
        } else break;
        if (k < 0) {
          if (!end) break;
          if (matchAt(START_TAG_OPEN, raw, i)) {
            // An unfinished start tag is dropped.
          } else if (raw.startsWith('</', i)) {
            if (i + 2 === n) on.data('</');
            else if (!matchAt(END_TAG_OPEN, raw, i)) on.comment(raw.slice(i + 2));
          } else if (raw.startsWith('<!--', i)) {
            let stop = n;
            for (const suffix of ['--!', '--', '-']) {
              if (raw.endsWith(suffix) && n - suffix.length >= i + 4) {
                stop -= suffix.length;
                break;
              }
            }
            on.comment(raw.slice(i + 4, stop));
          } else if (raw.startsWith('<![CDATA[', i)) {
            on.unknownDecl(raw.slice(i + 3));
          } else if (raw.slice(i, i + 9).toLowerCase() === '<!doctype') {
            on.decl(raw.slice(i + 2));
          } else if (raw.startsWith('<!', i)) {
            on.comment(raw.slice(i + 2));
          } else if (raw.startsWith('<?', i)) {
            on.pi(raw.slice(i + 2));
          } else {
            throw new Error('we should not get here!');
          }
          k = n;
        }
        i = k;
      } else if (raw.startsWith('&#', i)) {
        const match = matchAt(CHAR_REF, raw, i);
        if (match) {
          on.charRef(match[0].slice(2, -1));
          let k = i + match[0].length;
          if (raw[k - 1] !== ';') k -= 1;
          i = k;
          continue;
        }
        if (raw.indexOf(';', i) >= 0) {
          on.data(raw.slice(i, i + 2));
          i += 2;
        }
        break;
      } else if (raw.startsWith('&', i)) {
        const match = matchAt(ENTITY_REF, raw, i);
        if (match) {
          on.entityRef(match[1]);
          let k = i + match[0].length;
          if (raw[k - 1] !== ';') k -= 1;
          i = k;
          continue;
        }
        const partial = matchAt(INCOMPLETE, raw, i);
        if (partial) {
          if (end && partial[0] === raw.slice(i)) i += 1;
          break;
        } else if (i + 1 < n) {
          on.data('&');
          i += 1;
        } else break;
      } else {
        throw new Error('interesting.search() lied');
      }
    }
    if (end && i < n) {
      on.data(raw.slice(i, n));
      i = n;
    }
    this.raw = raw.slice(i);
  }

  private parseHtmlDeclaration(i: number): number {
    const raw = this.raw;
    if (raw.slice(i, i + 4) === '<!--') return this.parseComment(i);
    if (raw.slice(i, i + 9) === '<![CDATA[') {
      const j = raw.indexOf(']]>', i + 9);
      if (j < 0) return -1;
      this.events.unknownDecl(raw.slice(i + 3, j));
      return j + 3;
    }
    if (raw.slice(i, i + 9).toLowerCase() === '<!doctype') {
      const gt = raw.indexOf('>', i + 9);
      if (gt === -1) return -1;
      this.events.decl(raw.slice(i + 2, gt));
      return gt + 1;
    }
    if (raw.slice(i, i + 3) === '<![') {
      const j = raw.indexOf('>', i + 3);
      if (j < 0) return -1;
      if (raw[j - 1] === ']') this.events.unknownDecl(raw.slice(i + 3, j - 1));
      else this.events.comment(raw.slice(i + 2, j));
      return j + 1;
    }
    return this.parseBogusComment(i);
  }

  private parseComment(i: number): number {
    const raw = this.raw;
    COMMENT_CLOSE.lastIndex = i + 4;
    let match = COMMENT_CLOSE.exec(raw);
    if (!match) {
      match = matchAt(COMMENT_ABRUPT_CLOSE, raw, i + 4);
      if (!match) return -1;
    }
    this.events.comment(raw.slice(i + 4, match.index));
    return match.index + match[0].length;
  }

  private parseBogusComment(i: number): number {
    const pos = this.raw.indexOf('>', i + 2);
    if (pos === -1) return -1;
    this.events.comment(this.raw.slice(i + 2, pos));
    return pos + 1;
  }

  private parsePi(i: number): number {
    const j = this.raw.indexOf('>', i + 2);
    if (j < 0) return -1;
    this.events.pi(this.raw.slice(i + 2, j));
    return j + 1;
  }

  private parseStartTag(i: number): number {
    const raw = this.raw;
    const located = matchAt(LOCATE_TAG_END, raw, i + 1);
    if (!located) throw new Error('unexpected call to parse_starttag()');
    const endPos = i + 1 + located[0].length;
    if (raw[endPos - 1] !== '>') return -1;

    const attrs: Array<[string, string | null]> = [];
    const tagMatch = matchAt(TAG_FIND, raw, i + 1);
    if (!tagMatch) throw new Error('unexpected call to parse_starttag()');
    let k = i + 1 + tagMatch[0].length;
    const tag = tagMatch[1].toLowerCase();
    while (k < endPos) {
      const m = matchAt(ATTR_FIND, raw, k);
      if (!m) break;
      let value: string | null = m[3] ?? null;
      if (!m[2]) {
        value = null;
      } else if (value !== null && value.length > 0
        && ((value[0] === "'" && value[value.length - 1] === "'") || (value[0] === '"' && value[value.length - 1] === '"'))) {
        value = value.slice(1, -1);
      }
      if (value) value = unescapeAttribute(value);
      attrs.push([m[1].toLowerCase(), value]);
      k += m[0].length;
    }

    const end = pyStrip(raw.slice(k, endPos));
    if (end !== '>' && end !== '/>') {
      this.events.data(raw.slice(i, endPos));
      return endPos;
    }
    if (end.endsWith('/>')) {
      this.events.startEndTag(tag, attrs);
    } else {
      this.events.startTag(tag, attrs);
      if (CDATA_CONTENT.has(tag)) this.setCdataMode(tag, false);
      else if (RCDATA_CONTENT.has(tag)) this.setCdataMode(tag, true);
    }
    return endPos;
  }

  private parseEndTag(i: number): number {
    const raw = this.raw;
    if (raw.indexOf('>', i + 2) < 0) return -1;
    if (!matchAt(END_TAG_OPEN, raw, i)) {
      if (raw.slice(i + 2, i + 3) === '>') return i + 3;
      return this.parseBogusComment(i);
    }
    const located = matchAt(LOCATE_TAG_END, raw, i + 2);
    if (!located) throw new Error('unexpected call to parse_endtag');
    const j = i + 2 + located[0].length;
    if (raw[j - 1] !== '>') return -1;
    const tagMatch = matchAt(TAG_FIND, raw, i + 2);
    if (!tagMatch) throw new Error('unexpected call to parse_endtag');
    this.events.endTag(tagMatch[1].toLowerCase());
    this.clearCdataMode();
    return j;
  }
}
