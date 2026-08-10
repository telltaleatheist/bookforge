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
 * ── AND, since 2026-08-09, a PASS OVER THE BOOK ─────────────────────────────
 *
 * This used to say that nothing here edits a book: the narration copy was a
 * second file, and the official book was never rewritten to take a marker out.
 * Owen asked the question that ended that — "if the user opens the working file
 * and footnote reference numbers were removed, will it show the change in the
 * epub? will it show that the numbers are actually gone? i.e. does it actually
 * edit the text? we need a way to edit the text directly" — so there is now a
 * third caller, `stripFootnoteReferencesFromBook` (electron/epub-processor.ts),
 * which rewrites the WORKING COPY in place and records itself in that book's
 * ledger so it can be taken back.
 *
 * The ARCHIVE original and the book `foundry vlm-convert` cast are still never
 * written to. The pass edits the copy, exactly as every other pass does.
 *
 * All THREE callers must agree, and they do by sharing this rule rather than
 * restating it. Note that running the strip over already-stripped text is a
 * no-op by construction — nothing matches, `removed` is 0 and the string comes
 * back identical — which is what lets the narration writer keep its own strip
 * unconditionally: a book that has been through the pass narrates the same
 * either way, and a book that has not is still cut clean.
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
 *
 * ── THE ONE SURVIVOR ON KILLING AMERICA, AND WHY IT STAYS ───────────────────
 *
 * Measured 2026-08-09 over the whole book, both files: 324 `<sup>` elements, 321
 * stripped, and exactly one left in the narration copy —
 *
 *   ch04:  "…it would be invited to become the 28<sup>th</sup> state…"
 *
 * That is an ORDINAL SUFFIX, not a note reference, and the rule is doing the
 * right thing by keeping it. Widening the rule cannot reach it honestly: it
 * holds no digit at all, so "digits plus punctuation" does not match it, and
 * "any `<sup>`" would turn the sentence into "the 28 state" — a narrator reading
 * "the twenty-eight state". A "sup wrapping a noteref anchor" rule would not
 * reach it either (there is no anchor), and would not be an improvement anywhere
 * else on this book: the anchor-wrapped markers are already caught by the text
 * rule, and the bare form has no anchor to recognize.
 *
 * The other two survivors of the rule are `<sup>st</sup>` (ch04, ch08) and both
 * are the same construction — ch08's sits inside a footnote paragraph the user
 * struck, so it left the copy with the note that held it rather than with the
 * strip. There is nothing here for the rule to do differently.
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
