/**
 * clean/light-gate — the gate with a light touch (Owen, 2026-09-25).
 *
 * *"lets rebuild the gate to have a very light touch. something thatll only
 * reject the things that it should, and preferably never reject a legitimate
 * change."*
 *
 * ── WHAT IT WAS BUILT FROM ──────────────────────────────────────────────────
 *
 * Five gate-OFF runs (Working Towards the Führer ×4, Pursuit of Power ×1,
 * qwen3.5-9b, 2026-09-24/25) applied every edit the model proposed. Read one by
 * one, the model's mistakes were of ONE shape: it changed a word that is already
 * spoken as printed — "Führer" → "Fuehrer", "Hitler" → "H i t l e r", 'idea' →
 * idea, "Marxist-Leninist" → "Marxist Leninist", "Movement" → "movement",
 * "decade" → "ten year period" — or it invented words between two it left alone
 * ("Franz Joseph" → "Franz the Second Joseph", "Hans Frank" → "Hans the Frank").
 * And the old gate's wrong refusals were all readings of tokens it did not know:
 * "Vol. 23", "ii. 207", "eds", "edn", "chs. 8-9", "fol. 15", "St Paul's".
 *
 * ── SO ONE RULE, WITH ITS PARTS ─────────────────────────────────────────────
 *
 * A token is PRINTED-FORM when a narrator does not read it as printed: it holds
 * a digit, a period (an abbreviation, an initial), a run of two or more
 * capitals, a roman numeral after a ruler's name or a part word, a bracket, an
 * ampersand, a line-break hyphen; or it is a known period-less abbreviation
 * ("St", "eds", "edn"). A PLAIN token is everything else.
 *
 *   1. Every plain token of the find comes back in the reading EXACTLY — same
 *      letters, accents, case, quotes, hyphens and punctuation — and in order.
 *   2. Words the reading adds sit next to a printed-form token it changed; none
 *      is inserted between two plain tokens it kept.
 *   3. The reading prints no digit the find did not already print verbatim.
 *
 * Three shapes are recognised whole before that: a spaced hyphen or dash made an
 * em dash, an editor's square brackets dropped, and a word the page broke
 * ("fini sh", "Verlag- sanstalt") joined. And a whole bracketed insertion of a
 * few words may be removed outright.
 *
 * WHAT IT DOES NOT JUDGE: whether a number reading is RIGHT ("153–6" → "…one
 * hundred six" passes), whether an abbreviation's expansion is the right one
 * ("et al." → "et cetera" passes). Those are the model's to get right, from the
 * prompt's examples. The gate refuses only an edit that changes what is already
 * spoken as printed, which is never legitimate.
 */

import { isRomanContext } from './tts-spoken-forms.js';

/** Abbreviations a book prints WITHOUT a period (British style), lower-cased. */
const PERIODLESS_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'st', 'dr', 'mr', 'mrs', 'ms', 'mt', 'sr', 'jr', 'rev', 'col', 'gen', 'capt', 'lt', 'prof',
  'eds', 'edn', 'edns', 'ed', 'vol', 'vols', 'no', 'nos', 'pp', 'ch', 'chs', 'fol', 'fols',
  'ff', 'cf', 'ibid', 'etc', 'vs', 'trans', 'transl', 'repr', 'nr', 'n', 'nn',
  'p', 'c', 'ca', 'al', 'approx', 'esp', 'suppl', 'ser', 'sec', 'art', 'fig', 'figs', 'pl',
  'hon', 'gov', 'sen', 'rep', 'maj', 'sgt', 'adm', 'ave', 'rd', 'co', 'inc', 'ltd', 'bros',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const DIGIT = /\d/;

/** The token with its outer punctuation (quotes, brackets, commas…) set aside. */
function core(token: string): string {
  return token.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&.]+$/gu, '');
}

/** Is a lone I, V or X a numeral here — after a ruler's name or a part word? */
function romanHere(tokens: readonly string[], i: number): boolean {
  const bare = core(tokens[i]!).replace(/'s$|’s$/, '');
  if (!/^[IVXLCDM]+$/.test(bare)) return false;
  if (bare.length >= 2) return true;
  return isRomanContext(tokens.slice(0, i).join(' '), tokens.slice(i + 1).join(' '));
}

/** Does this token print something a narrator does not read as printed? */
export function isPrintedForm(tokens: readonly string[], i: number): boolean {
  const token = tokens[i]!;
  const bare = core(token);
  if (DIGIT.test(token)) return true;
  if (/[[\]()&]/.test(token)) return true;
  if (/[¹²³⁴⁵⁶⁷⁸⁹⁰]/.test(token)) return true;
  // A PERIOD marks an abbreviation only where it is one: inside the token
  // ("e.g."), after a single letter (an initial, "H."), after a known
  // abbreviation ("Dr.", "ed.", "Vol.", below) or a small roman numeral ("ii.").
  // A sentence's last word ("Führer.") keeps its period and is still a word.
  const beforePeriod = bare.replace(/\.$/, '');
  if (beforePeriod.includes('.')) return true;                                    // e.g. · U.S.
  if (bare.endsWith('.') && /^\p{L}$/u.test(beforePeriod)) return true;           // H. · F.
  if (/^[ivxlcdm]+(?:[-–][ivxlcdm]+)?$/.test(beforePeriod)) return true;          // ii. · vii-xi
  // A word the page GARBLED ("帮pers"): Latin mixed with another script.
  if (/\p{Script=Han}|\p{Script=Cyrillic}|\p{Script=Greek}/u.test(bare)
    && /\p{Script=Latin}/u.test(bare)) return true;
  if (/^\p{Lu}{2,}(?:['’]s)?$/u.test(bare)) return true;        // FBI · SS · KERSHAW
  if (romanHere(tokens, i)) return true;                        // Alexander I · Part IV
  if (/-$/.test(token)) return true;                            // "Verlag-" at a line break
  if (PERIODLESS_ABBREVIATIONS.has(beforePeriod.toLowerCase())) return true;
  return false;
}

/** Any of the three whole shapes that need no word-by-word proof. */
function wholeShape(find: string, replace: string): string | null {
  // A spaced hyphen or en dash used as a dash, made an em dash — also where the
  // span starts or ends at the dash ("– intentionally" → "—intentionally").
  const dashed = find.replace(/(^|\s)[-–](\s|$)/g, '—');
  if (dashed !== find && dashed === replace.replace(/\s*—\s*/g, '—')) return 'dash';
  // An editor's square brackets dropped, every word kept.
  if (/\[[^\]]*\]/.test(find) && find.replace(/\[([^\]]*)\]/g, '$1') === replace) return 'interpolation';
  // A whole bracketed insertion of a few words removed.
  const trimmed = find.trim();
  if (replace.trim() === '' && /^[[(][^[\]()]*[\])]$/.test(trimmed)
    && trimmed.split(/\s+/).length <= 4) {
    return 'apparatus';
  }
  return null;
}

/**
 * Why the light gate refuses this edit, or null. `find` is verbatim in the
 * target, so its tokens are the book's.
 */
export function lightGateRefusal(find: string, replace: string): string | null {
  if (wholeShape(find, replace) !== null) return null;

  // 3. No digit the find did not print.
  const findTokens = find.split(/\s+/).filter(Boolean);
  const replaceTokens = replace.split(/\s+/).filter(Boolean);
  for (const token of replaceTokens) {
    if (DIGIT.test(token) && !findTokens.includes(token)) {
      return `the reading prints "${token}": a reading is words, and a digit left in it is still a digit`;
    }
  }

  // Join what the page broke: consecutive find tokens that the reading prints as
  // one ("fini sh" → "finish", "Verlag- sanstalt" → "Verlagsanstalt") count as
  // one printed-form token.
  const units: { text: string; printed: boolean }[] = [];
  for (let i = 0; i < findTokens.length; i++) {
    let joined = false;
    for (let span = 2; span <= 3 && i + span <= findTokens.length; span++) {
      const glued = findTokens.slice(i, i + span).map((t, k) => (k < span - 1 ? t.replace(/-$/, '') : t)).join('');
      if (replaceTokens.includes(glued) && glued.length > 2) {
        units.push({ text: glued, printed: false });
        i += span - 1;
        joined = true;
        break;
      }
    }
    if (!joined) units.push({ text: findTokens[i]!, printed: isPrintedForm(findTokens, i) });
  }

  // 1 and 2. Walk the reading, matching every plain unit in order, exactly.
  let r = 0;
  let lastWasChanged = false;           // nothing is added before the first kept word
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]!;
    if (unit.printed) {
      // A printed-form token: its reading is whatever words run up to the next
      // plain unit. Nothing to prove here but that the next plain unit follows.
      lastWasChanged = true;
      const nextPlain = units.slice(u + 1).find((x) => !x.printed);
      if (nextPlain === undefined) return null;
      const at = replaceTokens.indexOf(nextPlain.text, r);
      if (at < 0) {
        return `"${nextPlain.text}" is already spoken as printed, and the reading changed or dropped it`;
      }
      r = at;
      continue;
    }
    // A plain unit must be the very next reading token, unless the previous unit
    // was one the reading changed (whose words may run on until here).
    const at = replaceTokens.indexOf(unit.text, r);
    if (at < 0) {
      return `"${unit.text}" is already spoken as printed, and the reading changed or dropped it`;
    }
    if (at !== r && !lastWasChanged) {
      return `the reading adds "${replaceTokens.slice(r, at).join(' ')}" beside "${unit.text}", `
        + 'which it did not change; words may be added only where a printed form is being read';
    }
    r = at + 1;
    lastWasChanged = false;
  }
  if (r < replaceTokens.length && !lastWasChanged) {
    return `the reading adds "${replaceTokens.slice(r).join(' ')}" after words it did not change`;
  }
  return null;
}
