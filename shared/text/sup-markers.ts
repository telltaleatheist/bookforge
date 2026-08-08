/**
 * What makes a `<sup>` a footnote REFERENCE — one rule, two callers.
 *
 * TTS text extraction (epub-processor) drops these markers on its way to plain
 * text, and `writeNarrationEpub` removes them from the narration copy as it
 * writes it. Both have to agree exactly: a marker the narration copy leaves
 * behind the extractor would have dropped anyway, and a marker the narration
 * copy removes that the extractor would have KEPT is text the narrator was
 * supposed to read, gone.
 *
 * NEITHER OF THEM EDITS A BOOK. The narration copy is a second file; the
 * official book — the archive original, or what `foundry vlm-convert` wrote — is
 * never rewritten to take a marker out. That is why this is an option on the
 * WRITE of a derived file rather than a pass over the book.
 *
 * ── THE RULE, AND WHAT IT COSTS ─────────────────────────────────────────────
 *
 * Digits-only is the discriminator. `<sup>th</sup>` / `<sup>st</sup>` (ordinals)
 * and any lettered superscript are KEPT. Ranges and lists ("1,2", "3-5") are
 * still note references, so they go too. A scientific exponent (`<sup>2</sup>`)
 * is also dropped — accepted, because the alternative was a spurious spoken "2".
 *
 * Measured on the sup's TEXT, not on its raw contents, because publishers write
 * the reference two ways and BOTH are endnote markers:
 *
 *   bare           <sup class="calibre11">55</sup>              (Evans, Third Reich in Power)
 *   anchor-wrapped <sup><a href="#fn-9" id="fn_9">9</a></sup>   (Killing America, Himmler)
 *
 * A pattern requiring digits IMMEDIATELY inside the tag only ever catches the
 * first. Across 180 archived originals the anchor-wrapped form is the more
 * common of the two by a wide margin — The Third Reich at War is 2093
 * anchor-wrapped to 1 bare, which is how its markers reached the text, got
 * spoken, and taught a fine-tuned voice that junk means end-of-utterance.
 */

/** Matches one `<sup>…</sup>` element, with its inner markup captured. */
export const SUP_ELEMENT_PATTERN = /<sup\b[^>]*>([\s\S]*?)<\/sup>/gi;

/**
 * Is this the TEXT of a footnote-reference superscript?
 *
 * Takes the sup's text content — tags already stripped, trimmed. Must contain a
 * digit, and may contain nothing but digits, whitespace and the separators a
 * range or list of note numbers uses.
 */
export function isFootnoteMarkerSupText(text: string): boolean {
  return /^[\s\d,;–—-]+$/.test(text) && /\d/.test(text);
}

/** The text content of a sup's inner markup, as the rule measures it. */
export function supInnerText(inner: string): string {
  return inner.replace(/<[^>]+>/g, '').trim();
}

/**
 * Remove every footnote-reference superscript from a fragment of XHTML, and say
 * how many went.
 *
 * String work rather than a DOM edit, deliberately: the surrounding markup is
 * the publisher's and must come out of this byte for byte. A parse-and-reserialize
 * of a whole book normalizes entities, attribute quoting and self-closing tags
 * across thousands of elements nobody asked to touch, and every one of those is
 * a difference a reader can hit.
 */
export function stripFootnoteMarkerSups(xhtml: string): { text: string; removed: number } {
  let removed = 0;
  const text = xhtml.replace(SUP_ELEMENT_PATTERN, (whole: string, inner: string) => {
    if (!isFootnoteMarkerSupText(supInnerText(inner))) return whole;
    removed++;
    return '';
  });
  return { text, removed };
}
