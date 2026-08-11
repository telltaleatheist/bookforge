/**
 * EPUB Paragraph Merger
 *
 * Fixes fragmented paragraphs in EPUB files. When a PDF is exported to EPUB,
 * each text block (often a single line) becomes its own <p> tag. This causes
 * TTS engines to insert long pauses mid-sentence.
 *
 * The heuristic: any <p> that doesn't end with terminal punctuation (.?!)
 * gets merged with the next <p>. This ensures paragraph breaks only occur
 * at sentence boundaries.
 */

import { StreamingZipWriter, parseXhtmlBody } from './epub-processor';
import { openEpubSource } from './epub-container';

// ─────────────────────────────────────────────────────────────────────────────
// Core algorithm
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if text ends with terminal punctuation.
 * Handles HTML entities like &quot; &#039; &#x201d; etc.
 */
function endsWithTerminalPunctuation(text: string): boolean {
  const decoded = text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x201[cd];/g, '"')
    .replace(/&#x2019;/g, '\u2019')
    .replace(/&#x2018;/g, '\u2018')
    .trimEnd();

  return /[.?!]["'\u201d\u2019)\]]*$/.test(decoded);
}

// ─────────────────────────────────────────────────────────────────────────────
// The merge, over a real parse
//
// ── The bug this was (found 2026-08-10, fixed here) ─────────────────────────
//
// This function used to collect `<h1-6>` and `<p>` out of the body WITH A REGEX
// and then rebuild the body from ONLY what it had collected. Everything else in
// the body — every `<div>`, `<blockquote>`, `<li>`, `<figure>`, and every `<img>`
// that was not inside a paragraph — was SILENTLY DELETED, and a `<p>` nested
// inside a container was torn out of it and promoted to a top-level paragraph.
// The merged paragraphs it emitted were bare `<p>` with no attributes, so
// `data-bf-cat`, `data-bf-user-cat`, `data-bf-page` and the reflow provenance
// went too. It runs unconditionally over the AI-cleanup output
// (electron/ai-bridge.ts), so every simplified book paid for both.
//
// It is now a DOM edit. Consecutive `<p>` siblings are merged into the first of
// the run — which keeps its own attributes, per the same rule the cleanup
// rebuild states — and every other node in the document is left exactly where it
// is. Nothing is removed but the emptied `<p>` shells the merge consumed.
//
// ── The attribute rule, same as the rebuild's ───────────────────────────────
//
// A merged paragraph keeps the FIRST source's attributes. The paragraphs merged
// INTO it cease to exist, so their identities go with them rather than surviving
// onto an element that is not them.
//
// ── Idempotence ─────────────────────────────────────────────────────────────
//
// A document with no run to merge is returned as the SAME STRING, byte for byte.
// The parse/serialize round trip is confined to documents that actually change,
// because `mergeEpubParagraphs` rewrites the zip entry whenever the string
// differs and a book whose every document was re-serialized for nothing is a
// book whose analysis cache and narration stamp were voided for nothing.
// ─────────────────────────────────────────────────────────────────────────────

/** Text of a node as rendered, for the terminal-punctuation test. */
function domText(node: any): string {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';
  if (!node.childNodes) return '';
  let text = '';
  for (let i = 0; i < node.childNodes.length; i++) text += domText(node.childNodes[i]);
  return text;
}

const isElement = (n: any): boolean => n && n.nodeType === 1;
const tagOf = (n: any): string => (isElement(n) ? (n.tagName || '').toLowerCase() : '');
const isParagraph = (n: any): boolean => tagOf(n) === 'p';
/** A text node holding nothing but whitespace — layout, not content. */
const isBlankText = (n: any): boolean =>
  n && (n.nodeType === 3 || n.nodeType === 4) && (n.nodeValue || '').trim().length === 0;

/** The last text node inside an element, in document order, or null. */
function lastTextNode(node: any): any {
  if (node.nodeType === 3 || node.nodeType === 4) return node;
  if (!node.childNodes) return null;
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const found = lastTextNode(node.childNodes[i]);
    if (found) return found;
  }
  return null;
}

/**
 * Append `next`'s children onto `first`, joining the two texts the way
 * `joinMultipleLines` used to: a trailing hyphen before a lowercase word is a
 * word broken across lines and the two halves are rejoined, otherwise a single
 * space goes between. Inline markup travels with the nodes, verbatim.
 */
function absorbParagraph(doc: any, first: any, next: any): void {
  const tail = lastTextNode(first);
  const nextText = domText(next).trim();
  const dehyphenate =
    tail !== null
    && /-\s*$/.test(tail.data ?? tail.nodeValue ?? '')
    && nextText.length > 0
    && nextText[0] === nextText[0].toLowerCase()
    && nextText[0] !== nextText[0].toUpperCase();

  if (dehyphenate) {
    // `data` and not `nodeValue`: xmldom serializes a text node out of `data`,
    // and assigning only `nodeValue` leaves the hyphen in the output.
    const joined = (tail.data ?? tail.nodeValue ?? '').replace(/-\s*$/, '');
    tail.data = joined;
    tail.nodeValue = joined;
  } else {
    first.appendChild(doc.createTextNode(' '));
  }

  while (next.firstChild) first.appendChild(next.firstChild);
  next.parentNode.removeChild(next);
}

/**
 * Merge the runs of consecutive `<p>` siblings under one parent. Recurses, so a
 * paragraph nested in a `<div>` or `<section>` merges with its own siblings and
 * with nothing outside its container.
 *
 * Returns true when anything was merged.
 */
function mergeParagraphsUnder(doc: any, parent: any): boolean {
  let merged = false;

  // Recurse first: the child list is about to be edited, so take a snapshot.
  const children: any[] = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) children.push(n);
  for (const child of children) {
    if (isElement(child) && !isParagraph(child)) {
      if (mergeParagraphsUnder(doc, child)) merged = true;
    }
  }

  // A run is a maximal stretch of `<p>` siblings, with whitespace between them
  // ignored. Any other element ends the run — a heading, a picture, a quote and
  // a list are all reasons two paragraphs are not one paragraph.
  let run: any[] = [];
  const flush = (): void => {
    if (run.length < 2) { run = []; return; }
    const first = run[0];
    for (let i = 1; i < run.length; i++) absorbParagraph(doc, first, run[i]);
    merged = true;
    run = [];
  };

  for (const child of children) {
    if (isBlankText(child)) continue;              // layout whitespace: transparent
    if (!isParagraph(child)) { flush(); continue; }

    const text = domText(child).trim();
    // An empty `<p>` is a spacer, not a sentence. It is neither merged nor
    // removed — deleting it would be the content loss this rewrite exists to
    // end — and it does not break the run around it.
    if (text.length === 0) continue;

    if (run.length === 0) {
      // A paragraph that already ends in a full stop starts no run.
      if (endsWithTerminalPunctuation(text)) continue;
      run.push(child);
      continue;
    }
    run.push(child);
    if (endsWithTerminalPunctuation(text)) flush();
  }
  flush();

  return merged;
}

/**
 * Merge fragmented `<p>` tags in XHTML content. Any `<p>` whose text doesn't end
 * with terminal punctuation is merged with the `<p>` that follows it.
 *
 * Returns the input string UNCHANGED when there is nothing to merge.
 *
 * `whatFor` names the document in the one message this can print.
 */
export function mergeXhtmlParagraphs(xhtml: string, whatFor = 'a document'): string {
  if (!/<body[\s>]/i.test(xhtml)) return xhtml;

  let doc: any;
  let body: any;
  try {
    ({ doc, body } = parseXhtmlBody(xhtml, `the paragraph merge of ${whatFor}`));
  } catch (err) {
    // A document that will not parse is a document this pass must not rewrite:
    // the merge is a readability repair, and mangling markup nobody could read
    // is worse than leaving the pauses in. It is SAID, by name, rather than
    // swallowed — a book with a document in this state has a real problem, and
    // this is the only place that notices.
    console.warn(
      `[PARAGRAPH-MERGER] ${whatFor} was left exactly as it is: its markup will not parse `
      + `(${(err as Error).message}). Any run-on paragraphs in it stay run-on.`
    );
    return xhtml;
  }

  if (!mergeParagraphsUnder(doc, body)) return xhtml;

  const { XMLSerializer } = require('@xmldom/xmldom');
  let serialized: string = new XMLSerializer().serializeToString(doc);
  if (!serialized.startsWith('<?xml')) {
    serialized = `<?xml version="1.0" encoding="utf-8"?>\n${serialized}`;
  }
  return serialized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Heading / dateline punctuation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chapters often open with heading material crammed into the first <p> with no
 * punctuation: an ALL-CAPS section title and/or a place-and-date line that runs
 * straight into the first sentence of prose (e.g.
 * "A BRUSH WITH DEATH Saint-Hubert, Belgium, December 22, 1944 The German army…").
 * TTS reads the whole thing as one run-on sentence.
 *
 * This pass inserts a period at the two high-confidence boundaries — after a
 * leading ALL-CAPS title run, and after a leading dateline's year — so each unit
 * becomes its own spoken sentence. It is deliberately conservative; fuzzier cases
 * are left to the AI cleanup prompt.
 */

const MONTH_NAMES = new Set([
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]);

/** A token whose letters are all uppercase (single letters like "A"/"I" count). */
function isAllCapsWord(tok: string): boolean {
  const letters = tok.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return false; // pure number/punctuation → not a caps word
  return letters === letters.toUpperCase();
}

function endsWithSentencePunct(tok: string): boolean {
  return /[.?!]$/.test(tok);
}

/**
 * Insert sentence-ending periods at the start of a paragraph's text where a
 * heading/title or dateline butts up against the following unit. Returns the
 * input unchanged unless a boundary is found.
 */
export function splitLeadingHeadings(inner: string): string {
  // Only handle plain leading text — skip paragraphs that open with inline markup.
  if (/^\s*</.test(inner)) return inner;
  const raw = inner.trim();
  if (!raw) return inner;

  const tokens = raw.split(/\s+/);
  let changed = false;

  // (A) Leading ALL-CAPS title run (≥2 caps words).
  let run = 0;
  while (run < tokens.length && isAllCapsWord(tokens[run])) run++;
  if (run >= 2 && !endsWithSentencePunct(tokens[run - 1])) {
    if (run === tokens.length) {
      // Whole paragraph is an unpunctuated all-caps heading.
      tokens[run - 1] += '.';
      changed = true;
    } else if (/^[A-Z]/.test(tokens[run])) {
      // Title runs directly into the next unit (dateline or prose, incl. "I").
      tokens[run - 1] += '.';
      changed = true;
    }
  }

  // (B) Leading dateline ending in a year or year-range, then prose. Covers:
  //   "Saint-Hubert, Belgium, December 22, 1944 The German army…"
  //   "Namur, May 1940 Before dawn…"   "Ohio, 1913-1938 Sister Ursula…"
  // A year is treated as a dateline only when it is the LEADING unit: the token
  // before it is a month or ends with a comma, and everything before it is
  // place/month/day material. This rejects mid-sentence dates such as
  // "In December 1941 Japan attacked" or "By the end of 1942, it was…".
  const startIdx = run >= 2 ? run : 0;
  const scanLimit = Math.min(tokens.length, startIdx + 10);
  for (let i = startIdx; i < scanLimit; i++) {
    const yearMatch = tokens[i].match(/^(\d{4}(?:-\d{4})?)[.,;:]?$/);
    if (!yearMatch) continue;
    if (i === startIdx) break; // a bare leading year is prose, not a dateline

    // Every token before the year must be place / month / day material.
    let monthPos = -1;
    let datelineOk = true;
    for (let k = startIdx; k < i; k++) {
      const w = tokens[k].replace(/[.,;:]+$/, '').toLowerCase();
      if (MONTH_NAMES.has(w)) { if (monthPos === -1) monthPos = k; continue; }
      const placeish = /^[A-Z]/.test(tokens[k]) || w === 'and';
      if (!placeish && !/^\d{1,2}$/.test(w)) { datelineOk = false; break; }
    }
    if (!datelineOk) break;

    // The place list must end with a comma immediately before the date core
    // (the month if present, otherwise the year). This is what separates a real
    // dateline ("Namur, May 1940 …") from a mid-sentence date ("In December 1941 …").
    const anchor = monthPos !== -1 ? monthPos : i;
    if (anchor !== startIdx && !tokens[anchor - 1].endsWith(',')) break;

    const next = tokens[i + 1];
    // Prose start = any uppercase-initial word ("The", "I", "Before"…).
    if (next && /^[A-Z]/.test(next) && !endsWithSentencePunct(tokens[i])) {
      tokens[i] = yearMatch[1] + '.';
      changed = true;
    }
    break;
  }

  return changed ? tokens.join(' ') : inner;
}

/**
 * Apply splitLeadingHeadings() to every <p> in an XHTML document.
 */
export function addHeadingPunctuation(xhtml: string): string {
  return xhtml.replace(/(<p(?:\s[^>]*)?>)([\s\S]*?)(<\/p>)/g, (full, open: string, innerHtml: string, close: string) => {
    const out = splitLeadingHeadings(innerHtml);
    return out === innerHtml ? full : open + out + close;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EPUB-level operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge fragmented paragraphs in an EPUB file (in-place).
 * Opens the EPUB, fixes all XHTML chapter files, writes back.
 * Returns the number of chapters that were fixed.
 */
export async function mergeEpubParagraphs(epubPath: string): Promise<number> {
  const entryData = new Map<string, Buffer>();
  let fixedCount = 0;

  // Read the whole book and RELEASE it before anything is written back over it:
  // `StreamingZipWriter.finalize` renames a complete archive onto `epubPath`,
  // and Windows refuses that rename while a reader still holds the target. This
  // is the ZIP's constraint, kept where the ZIP writer is — the shared seam does
  // not carry it (see `rewriteEpubEntries`).
  //
  // The writer stays a StreamingZipWriter rather than an `EpubSink`: it exists
  // so a fifty-megabyte book is not held twice in memory, and the seam's sink
  // buffers every entry. Phase 2c gives the tree that property for free (an
  // unchanged entry is never read into a write at all).
  const reader = await openEpubSource(epubPath);
  try {
    for (const name of reader.getEntries()) {
      const data = await reader.readEntry(name);

      if (name.endsWith('.xhtml') || name.endsWith('.html') || name.endsWith('.htm')) {
        const lowerName = name.toLowerCase();
        if (!lowerName.includes('nav') && !lowerName.includes('toc')) {
          const original = data.toString('utf-8');
          // 1) Merge fragmented <p> tags, then 2) punctuate run-on headings/datelines.
          const fixed = addHeadingPunctuation(mergeXhtmlParagraphs(original, name));
          if (fixed !== original) {
            entryData.set(name, Buffer.from(fixed, 'utf-8'));
            fixedCount++;
            continue;
          }
        }
      }

      entryData.set(name, data);
    }
  } finally {
    reader.close();
  }

  if (fixedCount > 0) {
    const writer = new StreamingZipWriter();
    await writer.open();

    for (const [name, data] of entryData) {
      const compress = name !== 'mimetype';
      await writer.addFile(name, data, compress);
    }

    await writer.finalize(epubPath);
    console.log(`[PARAGRAPH-MERGER] Fixed ${fixedCount} chapters in ${epubPath}`);
  }

  return fixedCount;
}
