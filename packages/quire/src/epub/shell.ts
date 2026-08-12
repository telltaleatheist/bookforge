/**
 * The document the renderer actually loads.
 *
 * It is the book's own markup, at the book's own address, with exactly three
 * changes — each of which is a stated part of the contract rather than a
 * convenience:
 *
 *  1. Every `<script>` is removed, every `on*` handler attribute is removed, and
 *     every `javascript:` URL is removed. The page's CSP already refuses to
 *     execute any of it; this is the second, independent mechanism, applied
 *     before the bytes ever leave the main process. A book that carries script
 *     is not rejected — it is served without it.
 *  2. A CSP `<meta>` is inserted as the first child of `<head>`, matching the
 *     CSP header the protocol handler sets.
 *  3. The strategy's layout CSS is appended as the LAST child of `<head>`, so it
 *     wins over the book's stylesheets on the handful of properties it sets and
 *     loses to them on everything else.
 *
 * Serving it at the document's own `quire://<session>/<entry>` address is what
 * makes every relative URL in the book — its stylesheet, its figures, its fonts
 * — resolve exactly as the book wrote it, with no rewriting and nothing to get
 * wrong.
 */
import { quireFail } from '../errors';
import { quireCspMeta } from '../host/protocol';

/** Attributes that run script when something happens. Removed wholesale. */
const EVENT_ATTR = /^on/i;

export interface ShellResult {
  /** The XHTML to serve at the document's own address. */
  xhtml: string;
  /** What was taken out, so the caller can say so rather than discover it. */
  removed: { scripts: number; handlers: number; javascriptUrls: number };
}

/**
 * @param sourceXhtml the spine document exactly as it sits in the archive
 * @param entry       its zip entry name, for error messages
 * @param layoutCss   the strategy's page-box CSS
 */
export function buildPaginationShell(
  sourceXhtml: string,
  entry: string,
  layoutCss: string,
): ShellResult {
  // Same parser the rest of BookForge reads EPUB documents with, so a document
  // that round-trips through the narration writer round-trips through here.
  const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: () => { /* xmldom warns about things browsers accept; not our business */ },
      error: (m: string) => errors.push(m),
      fatalError: (m: string) => errors.push(m),
    },
  }).parseFromString(sourceXhtml, 'application/xhtml+xml');

  if (!doc || !doc.documentElement) {
    // The parser can decline without reporting anything — whitespace-only,
    // NUL-padded and declaration-only inputs all come back with no document
    // element and an EMPTY errors list. Measured 2026-08-12: a torn zip read
    // produced exactly that, and the error blamed the XHTML with no evidence
    // to say otherwise. So the refusal DESCRIBES THE INPUT: its length and
    // its first bytes, which is the difference between "the book is broken"
    // and "the reader was handed nothing".
    quireFail(
      'DOCUMENT_UNPARSEABLE',
      `${entry} could not be parsed as XHTML${errors.length ? `: ${errors[0]}` : ''}`
      + ` — the source is ${sourceXhtml.length} character(s)`
      + (sourceXhtml.length > 0
        ? ` beginning ${JSON.stringify(sourceXhtml.slice(0, 60))}`
        : ''),
    );
  }

  const removed = { scripts: 0, handlers: 0, javascriptUrls: 0 };

  // ── 1. Take the script out ────────────────────────────────────────────
  const scripts = Array.from(doc.getElementsByTagName('script')) as any[];
  for (const s of scripts) {
    if (s.parentNode) { s.parentNode.removeChild(s); removed.scripts++; }
  }

  const walk = (node: any): void => {
    if (node.nodeType === 1) {
      const attrs = node.attributes;
      const doomed: string[] = [];
      for (let i = 0; i < attrs.length; i++) {
        const name: string = attrs[i].name;
        const value: string = attrs[i].value ?? '';
        if (EVENT_ATTR.test(name)) { doomed.push(name); continue; }
        if (/^\s*javascript\s*:/i.test(value)) { doomed.push(name); removed.javascriptUrls++; }
      }
      for (const name of doomed) {
        if (EVENT_ATTR.test(name)) removed.handlers++;
        node.removeAttribute(name);
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(doc.documentElement);

  // ── 2 & 3. The head ───────────────────────────────────────────────────
  const heads = doc.getElementsByTagName('head');
  let head: any = heads.length > 0 ? heads[0] : null;
  if (!head) {
    // A spine document with no <head> is legal-ish and browsers synthesise one,
    // but quire needs a real place to put the CSP and the layout CSS, and a
    // synthesised one would not be in the bytes it serves.
    head = doc.createElement('head');
    const root = doc.documentElement;
    root.insertBefore(head, root.firstChild);
  }

  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', quireCspMeta());
  head.insertBefore(meta, head.firstChild);

  const style = doc.createElement('style');
  style.setAttribute('type', 'text/css');
  style.setAttribute('data-quire', 'layout');
  style.appendChild(doc.createTextNode(layoutCss));
  head.appendChild(style);

  let xhtml: string = new XMLSerializer().serializeToString(doc);
  if (!xhtml.startsWith('<?xml')) {
    xhtml = `<?xml version="1.0" encoding="utf-8"?>\n${xhtml}`;
  }
  return { xhtml, removed };
}
