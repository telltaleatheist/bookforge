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
        const fixed = mergeXhtmlParagraphs(original);
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
