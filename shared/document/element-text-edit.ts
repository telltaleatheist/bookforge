/**
 * Turning "the user retyped this paragraph" into "these characters, here".
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * A block on screen shows an element's text the way a reader sees it: runs of
 * whitespace collapsed to one space, the ends trimmed. The MARKUP holds
 * something else — newlines and indentation from whoever pretty-printed the
 * file, and inline elements the text runs through:
 *
 *     <p>He wrote to <em>Bethge</em> from Tegel,\n     in November.</p>
 *
 * The reader sees `He wrote to Bethge from Tegel, in November.` and fixes
 * `November` to `December`. Replacing the element's content with the corrected
 * sentence would be the easy thing to do and it would silently destroy the
 * `<em>`, the line breaks, and any footnote marker the paragraph carried.
 *
 * ── What this does instead ──────────────────────────────────────────────────
 *
 * It works out the SMALLEST change: the common prefix and the common suffix of
 * what the reader saw and what they typed are, by definition, untouched, so only
 * the span between them is an edit. That span is then translated back into
 * offsets in the raw markup text, where it can be applied to one text node and
 * leave every byte of markup around it alone.
 *
 * Fixing one word touches one word. Deleting a trailing sentence deletes a
 * trailing sentence. Retyping the whole paragraph — which the anchoring cannot
 * narrow — is caught by the caller when the span turns out to cross an inline
 * element, and refused by name rather than applied destructively.
 *
 * ── Why collapsed text is the currency ─────────────────────────────────────
 *
 * Because it is what the user edited. The alternative — showing raw markup text
 * in the editor, indentation and all — makes the round trip exact at the cost of
 * asking a reader to edit whitespace they never wrote. The index built by
 * {@link collapseWithIndex} makes the collapsed form exact anyway: every
 * character in it remembers where it came from.
 *
 * The collapse rule is `electron/epub-processor.ts`'s `collapsedUnitText`, not a
 * second description of it — a different rule would put every offset out.
 */

/** Collapsed text, and where each of its characters came from in the raw. */
export interface CollapsedText {
  /** `raw` with whitespace runs collapsed to one space and the ends trimmed. */
  text: string;
  /** `rawOffset[i]` is the index in `raw` that `text[i]` was taken from. */
  rawOffset: number[];
}

/**
 * Collapse whitespace exactly as `collapsedUnitText` does, remembering where
 * every surviving character came from.
 *
 * A collapsed space records the offset of the FIRST character of the whitespace
 * run it stands for, so a span that starts at that space starts at the whole
 * run — which is what makes replacing "b" in "a b c" leave the space before it
 * alone and consume the space after it exactly once.
 */
export function collapseWithIndex(raw: string): CollapsedText {
  const chars: string[] = [];
  const rawOffset: number[] = [];
  let inWhitespace = false;
  for (let at = 0; at < raw.length; at++) {
    const ch = raw[at];
    if (/\s/.test(ch)) {
      if (!inWhitespace) {
        inWhitespace = true;
        chars.push(' ');
        rawOffset.push(at);
      }
      continue;
    }
    inWhitespace = false;
    chars.push(ch);
    rawOffset.push(at);
  }
  // `.trim()`: a leading or trailing collapsed space is dropped, index and all.
  let from = 0;
  let to = chars.length;
  while (from < to && chars[from] === ' ') from++;
  while (to > from && chars[to - 1] === ' ') to--;
  return { text: chars.slice(from, to).join(''), rawOffset: rawOffset.slice(from, to) };
}

/** A change to make to the raw text: replace `[start, end)` with `replacement`. */
export interface TextSplice {
  start: number;
  end: number;
  replacement: string;
}

/**
 * The smallest change to `raw` that makes its collapsed text read `wanted`.
 *
 * `null` when the element already reads that way — the same idempotence the
 * category writer keeps, and for the same reason: the book's bytes stamp the
 * narration strikes and key the page map, so rewriting them to say what they
 * already said invalidates both for nothing.
 *
 * `wanted` is compared AS COLLAPSED, because a reader who typed two spaces did
 * not mean two spaces in a book that renders one. What comes back is in raw
 * offsets, so applying it is a splice into the markup and nothing else.
 */
export function spliceForCollapsedText(raw: string, wanted: string): TextSplice | null {
  const { text: was, rawOffset } = collapseWithIndex(raw);
  const now = collapseWithIndex(wanted).text;
  if (was === now) return null;

  let prefix = 0;
  while (prefix < was.length && prefix < now.length && was[prefix] === now[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < was.length - prefix
    && suffix < now.length - prefix
    && was[was.length - 1 - suffix] === now[now.length - 1 - suffix]
  ) suffix++;

  /**
   * Where collapsed index `i` sits in the raw string.
   *
   * `i === was.length` is the end of the collapsed text, which in raw terms is
   * one past the last surviving character — NOT the end of `raw`, because
   * trailing whitespace was trimmed and belongs to nobody. Appending there puts
   * the new words before that whitespace, which is where a reader means them.
   */
  const rawAt = (i: number): number => {
    if (was.length === 0) return raw.length;
    return i < was.length ? rawOffset[i] : rawOffset[was.length - 1] + 1;
  };

  return {
    start: rawAt(prefix),
    end: rawAt(was.length - suffix),
    replacement: now.slice(prefix, now.length - suffix),
  };
}
