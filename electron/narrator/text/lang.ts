/**
 * The language tables prep reads. English is the only row: another language's table is refused
 * by name, and that is what leaves a non-English book without TOC titles.
 */

export const DEFAULT_LANGUAGE_CODE = 'eng';
export const DEFAULT_OUTPUT_FORMAT = 'm4b';
export const DEFAULT_FINE_TUNED = 'internal';

/**
 * Single characters only. The table's one longer key, `...`, could never fire: it was applied as a
 * character class, so an ellipsis reaches the packer as printed. En dash, em dash and the two
 * parentheses carry the book-exact overrides.
 */
export const PUNCTUATION_SWITCH: ReadonlyMap<string, string> = new Map([
  ['«', '"'], ['»', '"'], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"], ['„', '"'],
  ['–', '-'], ['_', ' '], ['‗', ' '], ['¯', ' '], ['ˍ', ' '], ['﹍', ' '], ['﹎', ' '],
  ['﹏', ' '], ['＿', ' '], ['‽', '?'], ['⁉', '?!'], ['‼', '!!'], ['⁈', '?!'], ['⁇', '??'],
  ['﹖', '?'], ['﹗', '!'], ['۔', '.'], ['॥', '.'], ['。', '.'], ['።', '.'], ['།', '.'],
  ['፡', ':'], ['፤', ';'], ['।', '.'], ['•', '.'], ['›', ''], ['#', '-'], ['†', '-'],
  ['¶', '-'], ['—', ' - '],
]);

/** Each of these becomes a space. */
export const CHARS_REMOVE = /[\\|©®™*` ]/g;

export const EMOJI_RUN = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{1FA70}-\u{1FAFF}\u{2480}-\u{2BEF}\u{1F018}-\u{1F270}\u{1F650}-\u{1F67F}\u{1F700}-\u{1F77F}]+/gu;

export class UnsupportedLanguage extends Error {}

export function languageScript(lang: string): string {
  if (lang === 'eng') return 'latin';
  throw new UnsupportedLanguage(
    `narrator's text layer carries language tables for ['eng'] only, not '${lang}'. Orpheus is `
    + 'English-only by design; route this language to another engine (ebook2audiobook + XTTS).');
}
