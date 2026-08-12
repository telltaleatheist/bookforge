/**
 * Which edits to a book's markup cannot possibly move a page.
 *
 * ── Why the question is worth asking ────────────────────────────────────────
 *
 * Labelling a block says what it IS: `data-bf-user-cat` on one element, written
 * into the working copy because a category the book does not answer with is an
 * invisible overlay (see `electron/book-categories.ts`). One attribute, on one
 * element, in one document.
 *
 * The document's bytes changed, so quire has to be told. Until now the only way
 * to tell it was `relayoutDocument`, which measures the whole chapter again in a
 * real browser — up to four seconds on a long one. To change a data attribute.
 *
 * The pages did not move. They COULD not have moved: an attribute no rule
 * selects on is not a layout input. This module is where that is decided, and
 * decided by proof rather than by assertion — because the cost of being wrong is
 * a book whose page numbers are quietly one line out.
 *
 * ── What the proof is ───────────────────────────────────────────────────────
 *
 * Two halves, and neither is enough alone.
 *
 *  1. **Nothing else changed.** Strip every `data-bf-*` attribute from both
 *     documents and the bytes must be identical. Not "the text is the same", not
 *     "the tags are the same" — identical, so there is nothing to argue about.
 *     {@link layoutNeutralRewrite} answers this.
 *  2. **Nothing selects on them.** An attribute a stylesheet matches IS a layout
 *     input, whatever it is called, and `p[data-bf-user-cat="chapter"] { page-
 *     break-before: always }` would be a perfectly ordinary thing for a book to
 *     carry if a book had ever been through a tool that wrote one. quire checks
 *     its own injected CSS and the document's inline `<style>` blocks; the
 *     book's EXTERNAL stylesheets are the caller's to check
 *     ({@link stylesheetsMentioning}), because quire serves them without ever
 *     parsing them.
 *
 * Fail either half and the answer is "lay it out again", which is what always
 * happened and is never wrong — only slow.
 *
 * ── Why `data-bf-*` and not a list ──────────────────────────────────────────
 *
 * The prefix is BookForge's own namespace: `data-bf-user-cat`,
 * `data-bf-category`, `data-bf-group`, `data-bf-blocks`, `data-bf-uid`. Naming
 * the prefix rather than the members means an attribute added later is covered
 * the day it is added, and the two halves of the proof still hold for it —
 * whereas a hard-coded list would silently fall back to "not neutral" and cost a
 * relayout nobody could explain. The set that ACTUALLY differed is reported, so
 * the CSS check is asked about real attributes rather than a namespace.
 */

/** The namespace every attribute BookForge writes into a book's markup lives in. */
export const BOOKFORGE_ATTRIBUTE_PREFIX = 'data-bf-';

/**
 * Every `data-bf-*` attribute name in a serialized document.
 *
 * A string scan of the bytes, not a DOM walk, for the reason the comparison
 * below gives: what matters is the bytes, and a re-serialization of a re-parse
 * is a different thing that happens to usually agree.
 */
export function bookforgeAttributeNames(xhtml: string): Set<string> {
  const found = new Set<string>();
  const re = new RegExp(`\\s(${BOOKFORGE_ATTRIBUTE_PREFIX}[A-Za-z0-9_-]+)="`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xhtml)) !== null) found.add(m[1]);
  return found;
}

/** The same markup with those attributes taken out. */
export function stripBookforgeAttributes(xhtml: string, names: Iterable<string>): string {
  let out = xhtml;
  for (const name of names) {
    out = out.replace(new RegExp(`\\s${name}="[^"]*"`, 'g'), '');
  }
  return out;
}

/** What a rewrite turned out to be. */
export interface LayoutNeutralVerdict {
  /** True when the ONLY difference is the value or presence of `data-bf-*` attributes. */
  neutral: boolean;
  /**
   * Every `data-bf-*` attribute name appearing in either document.
   *
   * A superset of the ones that actually changed, and deliberately so: it is
   * what the stylesheet check is asked about, and asking about more attributes
   * than moved can only make that check stricter.
   */
  attributes: string[];
  /** Why it is not neutral, or null when it is. Names the first divergence. */
  reason: string | null;
}

/**
 * Did this rewrite of a spine document change anything but BookForge's own
 * attributes?
 *
 * `before` and `after` must both be the STAMPED form of the document — the same
 * walk, the same `data-quire-id` keys — or the stamps themselves will read as a
 * difference. That is not a limitation to work around: a rewrite that changed
 * the stamps changed the element enumeration, which is a change of what the
 * book's blocks ARE, and is never neutral.
 */
export function layoutNeutralRewrite(
  before: string,
  after: string,
  what: string,
): LayoutNeutralVerdict {
  const attributes = [
    ...new Set([...bookforgeAttributeNames(before), ...bookforgeAttributeNames(after)]),
  ].sort();
  if (attributes.length === 0) {
    return {
      neutral: false,
      attributes,
      reason:
        `${what} carries no ${BOOKFORGE_ATTRIBUTE_PREFIX}* attribute at all, so whatever changed `
        + 'in it is not one of them.',
    };
  }

  const strippedBefore = stripBookforgeAttributes(before, attributes);
  const strippedAfter = stripBookforgeAttributes(after, attributes);
  if (strippedBefore === strippedAfter) {
    return { neutral: true, attributes, reason: null };
  }

  let at = 0;
  while (
    at < strippedBefore.length && at < strippedAfter.length
    && strippedBefore[at] === strippedAfter[at]
  ) at++;
  return {
    neutral: false,
    attributes,
    reason:
      `${what} differs from what is laid out by more than its ${BOOKFORGE_ATTRIBUTE_PREFIX}* `
      + `attributes — with those removed the two part company at character ${at}: `
      + `…${strippedBefore.slice(Math.max(0, at - 60), at + 60)}… became `
      + `…${strippedAfter.slice(Math.max(0, at - 60), at + 60)}….`,
  };
}

/**
 * Which of these stylesheets mention any of these attribute names.
 *
 * Substring, not a CSS parse, and that is the right instrument: the question is
 * "could a rule possibly select on this", and a name that does not appear in the
 * bytes cannot be selected on by anything. A name that DOES appear may be in a
 * comment and harmless — in which case the answer is one relayout, which is what
 * used to happen every time anyway.
 */
export function stylesheetsMentioning(
  stylesheets: ReadonlyMap<string, string>,
  attributes: readonly string[],
): Array<{ entry: string; attribute: string }> {
  const hits: Array<{ entry: string; attribute: string }> = [];
  for (const [entry, css] of stylesheets) {
    for (const attribute of attributes) {
      if (css.includes(attribute)) hits.push({ entry, attribute });
    }
  }
  return hits;
}
