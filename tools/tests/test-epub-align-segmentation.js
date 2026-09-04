/**
 * Segmentation + heading-classification tests for the epub-align path.
 *
 *   node --require ./cli/electron-stub.js tools/tests/test-epub-align-segmentation.js
 *
 * Every case here is a review finding that shipped once. The classifier's label is
 * load-bearing — a corpus cutter that drops `NOTE heading` cues drops whatever it
 * gets wrong — so the false-positive cases matter as much as the true ones.
 */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { splitSentences } = require(path.join(ROOT, 'dist/electron/whisperx-align-bridge.js'));
const { HEADING_MARKER } = require(path.join(ROOT, 'dist/electron/epub-processor.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
/** Segment one block in isolation (blocks are blank-line separated). */
function one(block) { return splitSentences(block, true); }
function kindsOf(text) { return splitSentences(text, true).map((s) => `${s.kind[0]}:${s.text}`); }

console.log('\nF1 — a numeric/roman heading block must still produce a cue');
{
  // The filter `s.length > 1 && /[A-Za-z]/` in the sentence splitter binned the bare
  // forms, so `<p class="cn">1</p>` got no cue and its spoken chapter number fell
  // into the tail of the previous prose cue.
  //
  // N2: the PUNCTUATED forms were still broken after that fix, because the
  // classifier tested terminal punctuation BEFORE numbering — which made the `[.)]`
  // tail in the numbering pattern dead code. "1." and "12." were dropped entirely
  // and "IV." came out as prose, and `<p class="cn">1.</p>` is at least as common
  // in the wild as the bare "1".
  for (const n of ['1', '7', '12', 'I', 'IV', 'XVII',
                   '1.', '12.', '7 .', '1,', 'I.', 'IV.', '3)', 'xvii.']) {
    const r = one(n);
    check(`"${n}" -> one heading cue`, r.length === 1 && r[0].kind === 'heading' && r[0].text === n,
      JSON.stringify(r));
  }
  const r = kindsOf('Part I\n\n1\n\nWilliam McKinley, Ohioan\n\nIt is generally believed by strangers.');
  check('the McKinley opening splits into 3 headings + 1 prose',
    r.length === 4 && r.slice(0, 3).every((s) => s.startsWith('h:')) && r[3].startsWith('p:'),
    JSON.stringify(r));
}

console.log('\nF2 — <h1>-<h6> headings are tagged even though the extractor punctuates them');
{
  // extractTextFromXhtml appends a period to headings for the TTS read, which made
  // the no-terminal-punctuation rule score every marked-up EPUB at zero headings.
  const r = one(`${HEADING_MARKER}Chapter One.`);
  check('marked h1 with the appended period is a heading',
    r.length === 1 && r[0].kind === 'heading', JSON.stringify(r));
  check('the marker never reaches the cue text', r.length === 1 && !r[0].text.includes(HEADING_MARKER),
    JSON.stringify(r));
  const r2 = one(`${HEADING_MARKER}the quick brown fox jumped over it.`);
  check('a marked heading is trusted even when it looks like prose',
    r2.length === 1 && r2[0].kind === 'heading', JSON.stringify(r2));
  const r3 = splitSentences(`${HEADING_MARKER}Chapter One.\n\nIt began.`, true);
  check('a marked heading does not swallow the following block',
    r3.length === 2 && r3[0].kind === 'heading' && r3[1].kind === 'prose', JSON.stringify(r3));
  // --no-paragraph-split must not leak the transport marker into cue text
  const r4 = splitSentences(`${HEADING_MARKER}Chapter One. It began.`, false);
  check('marker stripped in --no-paragraph-split mode',
    r4.every((s) => !s.text.includes(HEADING_MARKER)), JSON.stringify(r4));
}

console.log('\nN3 — English words made of roman letters must NOT read as numerals');
{
  // `[ivxlcdm]{1,7}` matched all of these, tagging them heading (= droppable).
  const words = ['did', 'dim', 'lid', 'mid', 'mix', 'mild', 'mill', 'civil', 'vivid',
                 'ill', 'id', 'dill', 'DID', 'MIX', 'CIVIL', 'Mix', 'Did'];
  for (const w of words) {
    const r = one(w);
    check(`"${w}" is not a numeral`, r.length >= 1 && r.every((s) => s.kind === 'prose'),
      JSON.stringify(r));
  }
  // ...while real numerals still are. MIX is a valid numeral (1009); the value cap
  // is what excludes it, and it also keeps every plausible chapter number.
  for (const n of ['ii', 'III', 'ix', 'XL', 'xcix', 'C']) {
    check(`"${n}" is still a numeral`, one(n)[0].kind === 'heading', JSON.stringify(one(n)));
  }
  check('a numeral above the chapter-number cap is not a heading', one('MMXXIV')[0].kind === 'prose');
}

console.log('\nN1 — --no-paragraph-split must restore pre-branch behaviour, not beat it');
{
  // markHeadings used to CONSUME </h1-6>, which disabled the period-append and made
  // --no-paragraph-split WORSE than the pre-branch path: with no period and no block
  // split, the heading fused with the following sentence.
  const { EpubProcessor } = require(path.join(ROOT, 'dist/electron/epub-processor.js'));
  const xhtml = '<html><body><h1>Chapter One</h1><p>It was a dark night.</p></body></html>';
  const extract = (mark) => new EpubProcessor()['extractTextFromXhtml'](xhtml, false, mark);

  const marked = extract(true);
  check('the period-append still fires under markHeadings', /Chapter One\./.test(marked),
    JSON.stringify(marked));
  check('the heading is still marked', marked.includes(HEADING_MARKER), JSON.stringify(marked));

  const flat = splitSentences(marked, false).map((s) => s.text);
  check('--no-paragraph-split yields TWO sentences, not one fused run',
    flat.length === 2 && /^Chapter One\.$/.test(flat[0]) && /^It was a dark night\.$/.test(flat[1]),
    JSON.stringify(flat));
  check('no marker leaks into --no-paragraph-split output',
    flat.every((t) => !t.includes(HEADING_MARKER)), JSON.stringify(flat));

  // and unmarked extraction is byte-identical to what it always produced
  check('markHeadings=false leaves the extractor output unchanged',
    extract(false) === 'Chapter One.\n\nIt was a dark night.', JSON.stringify(extract(false)));

  // paragraph-aware still tags it
  const aware = splitSentences(marked, true);
  check('paragraph-aware still tags the h1 as heading',
    aware.length === 2 && aware[0].kind === 'heading' && aware[1].kind === 'prose',
    JSON.stringify(aware));
}

console.log('\nF4 — short unpunctuated PROSE must NOT be tagged heading');
{
  const notHeadings = [
    'Yes', 'Bread', 'No', 'He said-', 'The rules are:', 'Buy the bread',
    'she turned away', 'Wait', 'and then it stopped', 'a small brown dog',
    'Then he left', 'I know', 'Not this time',
  ];
  for (const t of notHeadings) {
    const r = one(t);
    check(`"${t}" is prose`, r.length >= 1 && r.every((s) => s.kind === 'prose'),
      JSON.stringify(r));
  }
}

console.log('\nF4 — real headings must still BE tagged');
{
  const headings = [
    'Part I', 'Ohio Born and Molded', 'William McKinley, Ohioan',
    'The Ohio Guide (WPA)', 'DRUMS TO DYNAMOS ALONG THE OHIO',
    'Surprisingly Modern McKinley', 'Chapter 3', 'Appendix B', 'Notes',
    'Senator Robert La Follette, Memoirs', 'MCKINLEY AND THE CIVIL WAR',
  ];
  for (const t of headings) {
    const r = one(t);
    check(`"${t}" is a heading`, r.length === 1 && r[0].kind === 'heading', JSON.stringify(r));
  }
}

console.log('\nGeneral invariants');
{
  const prose = 'It is generally believed by strangers that the most interesting part of Ohio.';
  check('an ordinary sentence is prose', one(prose)[0].kind === 'prose');
  const long = Array(20).fill('word').join(' ');
  check('a long unpunctuated run is prose (over the word cap)', one(long)[0].kind === 'prose');
  check('empty input yields nothing', splitSentences('', true).length === 0);
  check('--no-paragraph-split tags nothing as heading',
    splitSentences('Part I\n\nOhio Born and Molded', false).every((s) => s.kind === 'prose'));
  const multi = splitSentences('One. Two. Three.', true);
  check('a prose block still splits on punctuation', multi.length === 3, JSON.stringify(multi));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
