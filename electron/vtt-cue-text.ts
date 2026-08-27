/**
 * Reading the inline markup e2a writes into a WebVTT cue (2026-08-27).
 *
 * e2a marks a section heading's cue by wrapping the WHOLE payload in WebVTT's
 * own bold tag — `<b>Chapter Eight.</b>` — so a transcript can show a header
 * the way the page did. Every reader of a cue therefore has to agree on two
 * things: the tags are never text (nothing may print `<b>` to a human), and the
 * wrapping is a fact about the cue worth carrying, not noise to be discarded.
 *
 * There are four independent VTT parsers in the main process, so the rule lives
 * here once rather than four times. The renderer and the bookshelf web app are
 * separate build units and keep their own copy of this same contract, in their
 * own vtt-parser.service.ts.
 *
 * A transcript written before this change carries no tags at all: `text` then
 * comes back exactly as it went in and `heading` is false, so nothing migrates
 * and no old m4b reads differently.
 */

/**
 * Any inline WebVTT tag: `<b>`, `</b>`, `<i>`, `<v Speaker>`, `<c.class>`.
 * Timestamp tags (`<00:00:01.000>`) begin with a digit and are deliberately
 * left alone — they are not markup around the words.
 */
const VTT_INLINE_TAG = /<\/?[a-zA-Z][^>]*>/g;

/** The whole payload wrapped in ONE bold span — what e2a writes for a heading. */
const VTT_BOLD_WRAPPED = /^<b>([\s\S]*)<\/b>$/i;

export interface VttCueText {
  /** Display text, every inline tag removed. Never contains markup. */
  text: string;
  /** True when the entire payload was bold-wrapped, i.e. e2a marked a heading. */
  heading: boolean;
}

/**
 * Split a raw cue payload into the text a human may see and the heading fact.
 */
export function readVttCueText(raw: string): VttCueText {
  const trimmed = raw.trim();
  const wrapped = VTT_BOLD_WRAPPED.exec(trimmed);
  // Only a payload that is ENTIRELY one bold span counts as a heading. A cue
  // that merely contains a tag somewhere ("<b>a</b> and <b>b</b>") is prose
  // with markup in it: strip the tags and treat it as ordinary text.
  const heading = wrapped !== null && !/[<>]/.test(wrapped[1]);
  return { text: trimmed.replace(VTT_INLINE_TAG, ''), heading };
}

/** The display text alone, for readers that have no use for the heading fact. */
export function stripVttCueTags(raw: string): string {
  return readVttCueText(raw).text;
}
