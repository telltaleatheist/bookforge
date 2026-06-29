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

import { ZipReader, StreamingZipWriter } from './epub-processor';

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

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Join lines with hyphenation handling.
 * "excep-" + "tional" → "exceptional"
 */
function joinMultipleLines(lines: string[]): string {
  if (lines.length === 0) return '';
  if (lines.length === 1) return lines[0];

  let result = lines[0];
  for (let i = 1; i < lines.length; i++) {
    const prevText = stripTags(result);
    const nextText = stripTags(lines[i]);
    if (prevText.endsWith('-') && nextText.length > 0 &&
        nextText[0] === nextText[0].toLowerCase() && nextText[0] !== nextText[0].toUpperCase()) {
      // Dehyphenate: strip trailing hyphen and join without space
      result = result.replace(/-(\s*(<[^>]+>\s*)*)$/, '$1') + lines[i];
    } else {
      result += ' ' + lines[i];
    }
  }
  return result;
}

/**
 * Merge fragmented <p> tags in XHTML content.
 * Any <p> whose text doesn't end with terminal punctuation is merged
 * with the next <p>.
 */
export function mergeXhtmlParagraphs(xhtml: string): string {
  const bodyMatch = xhtml.match(/(<body[^>]*>)([\s\S]*?)(<\/body>)/);
  if (!bodyMatch) return xhtml;

  const beforeBody = xhtml.substring(0, bodyMatch.index! + bodyMatch[1].length);
  const bodyContent = bodyMatch[2];
  const afterBody = xhtml.substring(bodyMatch.index! + bodyMatch[1].length + bodyMatch[2].length);

  // Parse elements from body
  const elementRegex = /<(h[1-6]|p)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
  const elements: { tag: string; attrs: string; inner: string }[] = [];
  let m: RegExpExecArray | null;

  while ((m = elementRegex.exec(bodyContent)) !== null) {
    const tag = m[1];
    const attrs = m[2] || '';
    const openLen = `<${tag}${attrs}>`.length;
    const closeLen = `</${tag}>`.length;
    const inner = m[0].substring(openLen, m[0].length - closeLen);
    elements.push({ tag, attrs, inner });
  }

  if (elements.length === 0) return xhtml;

  // Check if any <p> tags need merging
  const needsMerge = elements.some(el =>
    el.tag === 'p' && stripTags(el.inner).trim() && !endsWithTerminalPunctuation(stripTags(el.inner))
  );
  if (!needsMerge) return xhtml;

  // Rebuild with merged paragraphs
  const output: string[] = [];
  let pBuffer: string[] = [];

  for (const el of elements) {
    if (el.tag.startsWith('h')) {
      // Flush paragraph buffer before heading
      if (pBuffer.length > 0) {
        output.push(`<p>${joinMultipleLines(pBuffer)}</p>`);
        pBuffer = [];
      }
      output.push(`<${el.tag}${el.attrs}>${el.inner}</${el.tag}>`);
      continue;
    }

    // <p> tag
    const text = stripTags(el.inner).trim();
    if (!text) continue;

    pBuffer.push(el.inner.trim());

    if (endsWithTerminalPunctuation(text)) {
      output.push(`<p>${joinMultipleLines(pBuffer)}</p>`);
      pBuffer = [];
    }
  }

  // Flush remaining (last paragraph may not end with punctuation)
  if (pBuffer.length > 0) {
    output.push(`<p>${joinMultipleLines(pBuffer)}</p>`);
  }

  return beforeBody + '\n' + output.join('\n') + '\n' + afterBody;
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
  const reader = new ZipReader(epubPath);
  await reader.open();

  const entries = reader.getEntries();
  const entryData = new Map<string, Buffer>();
  let fixedCount = 0;

  for (const name of entries) {
    const data = await reader.readEntry(name);

    if (name.endsWith('.xhtml') || name.endsWith('.html') || name.endsWith('.htm')) {
      const lowerName = name.toLowerCase();
      if (!lowerName.includes('nav') && !lowerName.includes('toc')) {
        const original = data.toString('utf-8');
        // 1) Merge fragmented <p> tags, then 2) punctuate run-on headings/datelines.
        const fixed = addHeadingPunctuation(mergeXhtmlParagraphs(original));
        if (fixed !== original) {
          entryData.set(name, Buffer.from(fixed, 'utf-8'));
          fixedCount++;
          continue;
        }
      }
    }

    entryData.set(name, data);
  }

  reader.close();

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
