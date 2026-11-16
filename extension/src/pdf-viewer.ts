/**
 * pdf-viewer — the reader view for a PDF: `pdf.html?src=<url>`.
 *
 * Chrome's own PDF viewer runs in a frame no extension can script, so a PDF
 * cannot be read where it opened. The popup sends the tab here instead. This
 * page fetches the file (with the user's cookies — host permission for its
 * origin is asked for first), reads it with mupdf.js and the app's own block
 * rules (`./pdf-text.ts`), and lays it out as plain HTML: headings, paragraphs,
 * quotations and captions. Running heads, folios and reference numbers are
 * left out; footnotes are shown small in an `<aside>`, which the content
 * script never reads.
 *
 * Then it loads `content.js` — the same script every web page gets — so
 * hovering, click-to-start, the selection control, highlighting and the bar
 * all work here unchanged.
 *
 * A scanned PDF has no text to read. It is said so, by name, rather than shown
 * as an empty page.
 */

import type * as Mupdf from 'mupdf';
import { joinLines, readDocument, type ReadDocument, type Segment, type ViewBlock } from './pdf-text';

const statusEl = document.getElementById('status') as HTMLDivElement;
const barEl = document.getElementById('progress') as HTMLDivElement;
const fillEl = document.getElementById('progressFill') as HTMLDivElement;
const articleEl = document.getElementById('book') as HTMLElement;
const originalEl = document.getElementById('original') as HTMLAnchorElement;

function say(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = false;
}

function sourceUrl(): string | null {
  const src = new URLSearchParams(location.search).get('src');
  if (!src) return null;
  try {
    const u = new URL(src);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.href : null;
  } catch {
    return null;
  }
}

function fileNameOf(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.pdf$/i, '') || 'PDF';
  } catch {
    return 'PDF';
  }
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (err) {
    if (url.startsWith('file:')) {
      throw new Error('Chrome would not let the extension open this file. Turn on "Allow access to file URLs" '
        + 'for BookForge Reader in chrome://extensions, then reload this page.');
    }
    throw new Error(`Could not download the PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`Could not download the PDF: the server answered ${res.status} ${res.statusText}`.trim());
  return res.arrayBuffer();
}

async function loadMupdf(): Promise<typeof Mupdf> {
  // mupdf.js is an ES module with top-level await and its own .wasm beside it;
  // it ships as files in the package (build.mjs copies them) and is imported at
  // run time rather than bundled.
  return import(chrome.runtime.getURL('mupdf/mupdf.js')) as Promise<typeof Mupdf>;
}

function appendSegments(el: HTMLElement, segments: Segment[]): void {
  for (const s of segments) {
    if (s.sup) {
      const sup = document.createElement('sup');
      sup.textContent = s.text.trim();
      el.appendChild(sup);
    } else {
      el.appendChild(document.createTextNode(s.text));
    }
  }
}

const TAG: Record<Exclude<ViewBlock['role'], 'omit'>, string> = {
  title: 'h1',
  heading: 'h2',
  subheading: 'h3',
  body: 'p',
  quote: 'blockquote',
  caption: 'figcaption',
  note: 'aside',
};

function render(doc: ReadDocument): number {
  document.title = doc.title;
  articleEl.textContent = '';
  const h = document.createElement('h1');
  h.className = 'doc-title';
  h.textContent = doc.title;
  articleEl.appendChild(h);

  let page = -1;
  let shown = 0;
  for (const b of doc.blocks) {
    if (b.role === 'omit') continue;
    if (b.page !== page) {
      page = b.page;
      const mark = document.createElement('div');
      mark.className = 'page-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = `page ${page + 1}`;
      articleEl.appendChild(mark);
    }
    const el = document.createElement(TAG[b.role]);
    el.dataset.bfCat = b.category;
    el.dataset.bfPage = String(b.page + 1);
    appendSegments(el, joinLines(b.lines, doc.attestation));
    articleEl.appendChild(el);
    if (b.role !== 'note') shown++;
  }
  return shown;
}

function loadContentScript(): void {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'content.css';
  document.head.appendChild(link);
  const script = document.createElement('script');
  script.src = 'content.js';
  document.body.appendChild(script);
}

async function main(): Promise<void> {
  const url = sourceUrl();
  if (!url) {
    say('No PDF to open. Use "Open PDF in reader view" from the BookForge Reader popup on a PDF tab.', true);
    return;
  }
  originalEl.href = url;
  originalEl.hidden = false;
  document.title = fileNameOf(url);

  say('Downloading…');
  const bytes = await fetchBytes(url);

  say('Loading the PDF reader…');
  const mupdf = await loadMupdf();
  let doc: Mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  } catch (err) {
    throw new Error(`This file could not be opened as a PDF: ${err instanceof Error ? err.message : String(err)}`);
  }

  barEl.hidden = false;
  let read: ReadDocument;
  try {
    read = await readDocument(doc, fileNameOf(url), (done, total) => {
      say(`Reading page ${done} of ${total}…`);
      fillEl.style.width = `${Math.round((done / total) * 100)}%`;
    });
  } finally {
    doc.destroy();
    barEl.hidden = true;
  }

  const shown = render(read);
  if (shown === 0) {
    say(`No text found in ${read.pageCount} page${read.pageCount === 1 ? '' : 's'}. `
      + 'This looks like a scanned PDF: its pages are pictures, with no text layer to read aloud.', true);
    return;
  }
  statusEl.hidden = true;
  loadContentScript();
}

main().catch((err: unknown) => say(err instanceof Error ? err.message : String(err), true));
