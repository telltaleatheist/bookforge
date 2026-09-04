#!/usr/bin/env node
/**
 * Tests for the TTS number-normalization pass — the numbers in a narration copy,
 * read as the words a narrator says.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-tts-number-normalizer.js
 *
 * ── What is worth defending here ────────────────────────────────────────────
 *
 * EVERY REFUSAL, because a model is doing the reading and the refusals are the
 * only thing standing between it and the book. A model that drops a word, leaves
 * a digit in, reads a citation code out loud, or edits a span it cannot locate
 * must be stopped by CODE and not by hoping the prompt held — and the same is
 * true of the deterministic expander when the two disagree about a shape the
 * expander actually knows.
 *
 * THE MARKUP, because e2a now depends on the narration copy's structure: `<li>`
 * items are their own chunks, headings are chapter titles, `data-bf-cat` says
 * what a block is. An edit is applied to TEXT NODES, and one that would have to
 * cross an `<em>` is refused rather than flattening the element to get at it.
 *
 * THE CONTENTS PAGE, because e2a matches a body heading against the TOC titles
 * it was handed and the m4b's chapter names come from that same list. A heading
 * and its nav entry must end up saying ONE string or the chapter titles come
 * apart.
 *
 * THE CACHE PATH, because the whole reason the copy is content-addressed is that
 * a resubmitted render must prep against the identical file.
 *
 * ── The model is INJECTED. Nothing here calls Ollama ────────────────────────
 *
 * Every test drives the pass with a scripted `generate`, so the whole state
 * space is reachable with no GPU and no model loaded.
 *
 *   --live <model>
 *
 * runs the REAL Ollama path over the measured derailment fixture and prints an
 * agreement table (what the model proposed, what the validator did with it).
 * It loads a model and takes the GPU — run it deliberately, never in the keeper
 * sweep. Example:
 *
 *   node tools/test-tts-number-normalizer.js --live qwen3.5:9b
 *
 * Everything is written to a temp directory; nothing here touches the library.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'tts-number-normalizer.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-numbers-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const { ZipWriter, readNarrationNumberTargets } =
  require(path.join(DIST, 'electron', 'epub-processor.js'));
const { openEpubSource } = require(path.join(DIST, 'electron', 'epub-container.js'));
const norm = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));

/**
 * The prompt, read from SOURCE rather than from dist.
 *
 * `npm run build:electron` copies electron/prompts into dist as a separate step,
 * so a bare `tsc` — which is what the keeper runner requires and all these tests
 * need — leaves dist without it. Reading the source file is the same bytes and
 * one fewer thing for a suite to be wrong about.
 */
const PROMPT = fs.readFileSync(
  path.join(REPO, 'electron', 'prompts', 'tts-number-normalize.txt'), 'utf8').trim();

// ── The measured fixture: the real texts that derailed the 08-30 date probe ──
//
// Read when it is present; skipped by name when it is not, because it lives on
// E: with the training campaigns and a checkout on another machine has no E:.
const FIXTURE_PATH = path.join(
  'E:', String.fromCharCode(92), 'training', '_campaigns', '2026-09-01-cod-full-rebuild',
  'fixtures', 'number-normalization', 'fixture_texts.json');
const FIXTURES = fs.existsSync(FIXTURE_PATH)
  ? JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'))
  : null;
const fixtureText = (id) => {
  const hit = FIXTURES.find((f) => f.id === id);
  assert.ok(hit, `fixture ${id} is not in fixture_texts.json`);
  return hit.text;
};

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A book, built the way foundry's vlm-convert emitter writes one
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:numbers</dc:identifier>
<dc:title>The 1933 Book</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="c1"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><ol>
<li><a href="chapter-01.xhtml">Chapter 3: The Long Year</a></li>
</ol></nav>
</body>
</html>`;

const NCX = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head/><docTitle><text>The 1933 Book</text></docTitle>
<navMap>
<navPoint id="n1" playOrder="1">
<navLabel><text>Chapter 3: The Long Year</text></navLabel>
<content src="chapter-01.xhtml"/>
</navPoint>
</navMap>
</ncx>`;

/**
 * The chapter. Every shape this pass has to get right is in here on purpose:
 * a HEADING with a number that the contents page repeats; a paragraph with a
 * date; a `<li>` list (e2a chunks those separately, so the markup must survive);
 * a number split by an `<em>` (the SPANS_MARKUP case); a `data-bf-cat` stamp
 * that has to still be on the element afterwards; and a caption, which the cut
 * owns and this pass must never touch.
 *
 * The dated paragraph carries THREE shapes on purpose since the deterministic
 * pre-pass landed (2026-09-02): a date and a money amount the RULES read, and a
 * bare four-digit quantity ("1200 members") that only the model can judge — so
 * the paragraph still reaches the model, and one unit exercises both halves.
 */
const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Three</title></head>
<body>
<h2 data-bf-page="1" data-bf-cat="chapter">Chapter 3: The Long Year</h2>
<p data-bf-page="1" data-bf-cat="text">On 23 March 1933 the Reichstag passed the Enabling Act, and 1200 members watched the pamphlet sell for $5.50.</p>
<p data-bf-page="1" data-bf-cat="text">A paragraph with no numbers in it at all, long enough to be an ordinary unit.</p>
<ul data-bf-page="2" data-bf-cat="list-item">
<li>A printer is represented by an attorney in 1934.</li>
<li>A blacksmith buys supplies from a firm in 1935.</li>
</ul>
<p data-bf-page="2" data-bf-cat="text">He was born in <em>19</em>44 and never said so.</p>
<p data-bf-page="3" data-bf-cat="caption">Figure 7. The plate above, taken in 1936.</p>
</body>
</html>`;

/**
 * A LONG chapter — twenty numbered paragraphs, so the >10% parse-failure gate
 * has a denominator big enough for one failure to sit under it and two to sit
 * over it. On the five-passage book above, ANY single failure trips the gate,
 * which cannot tell "a model that is broken" from "a model that had one bad
 * paragraph" — the distinction this book exists to draw.
 */
const LONG_CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Long</title></head>
<body>
${Array.from({ length: 20 }, (unused, i) =>
  `<p data-bf-cat="text">Paragraph ${i + 1}: on 2 March 19${(10 + i)} the council met and adjourned.</p>`
).join('\n')}
</body>
</html>`;

async function buildBook(name, chapter = CHAPTER, opf = OPF) {
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(NCX, 'utf8'));
  zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(chapter, 'utf8'));
  const out = path.join(ROOT, name);
  await zip.write(out);
  return out;
}

/** One entry of a written book, as text. */
async function entryText(bookPath, entry) {
  const source = await openEpubSource(bookPath);
  try {
    return (await source.readEntry(entry)).toString('utf8');
  } finally {
    source.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The scripted model
// ─────────────────────────────────────────────────────────────────────────────

/** The TARGET block of a built input — what the model is allowed to edit. */
const TARGET_HEAD = 'TARGET (edit ONLY this):\n';
function targetOf(input) {
  const start = input.indexOf(TARGET_HEAD);
  const end = input.indexOf('\n\nNEXT (context only');
  return input.slice(start + TARGET_HEAD.length, end);
}

/**
 * A runner that answers from a table keyed by a substring of the TARGET.
 *
 * Matched against the TARGET BLOCK ALONE, never the whole input: the context
 * paragraphs are in there too, and a table keyed on the raw input would answer
 * a heading with its neighbour's edits — which is a real model failure worth
 * testing deliberately (see the NOT_FOUND cases), not one to trip over here.
 *
 * `answers` maps a distinctive substring → the raw answer string the model would
 * have produced (JSON, prose-wrapped JSON, garbage — whatever the case needs). A
 * target matching nothing gets an empty edit list, which is the model saying
 * "nothing to convert here".
 */
function scriptedRunner(answers, options = {}) {
  const calls = [];
  return {
    model: options.model ?? 'fake:1b',
    released: false,
    calls,
    pinned: null,
    pinContextTo(systemPrompt, longest) { this.pinned = { systemPrompt, longest }; },
    async generate(input) {
      calls.push(input);
      if (options.throws) throw new Error(options.throws);
      const target = targetOf(input);
      for (const [needle, answer] of Object.entries(answers)) {
        if (target.includes(needle)) return answer;
      }
      return '{"edits": []}';
    },
    async release() { this.released = true; },
  };
}

const editsJson = (...pairs) =>
  `<answer>{"edits": ${JSON.stringify(pairs.map(([find, replace]) => ({ find, replace })))}}</answer>`;

/** The dispositions of the edits proposed for the target that says `needle`. */
const statusesFor = (record, needle) =>
  record.units.find((u) => u.text.includes(needle)).edits.map((e) => e.status);

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

test('selection takes every text with a digit, and nothing else', async () => {
  const book = await buildBook('select.epub');
  const targets = await readNarrationNumberTargets(book);
  const selected = norm.selectNumberTargets(targets);
  const texts = selected.map((t) => t.text.replace(/\s+/g, ' ').trim());

  assert.ok(texts.some((t) => t.startsWith('On 23 March 1933')), 'the dated paragraph');
  assert.ok(!texts.some((t) => t.startsWith('A paragraph with no numbers')),
    'a digit-free paragraph never goes near the model');
});

test('selection KEEPS headings and the contents entries that repeat them', async () => {
  const book = await buildBook('select-headings.epub');
  const selected = norm.selectNumberTargets(await readNarrationNumberTargets(book));
  const kinds = {};
  for (const t of selected) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;

  assert.ok(selected.some((t) => t.tag === 'h2' && t.text.includes('Chapter 3')),
    'the heading itself is selected (Owen, 2026-09-02)');
  assert.strictEqual(kinds.nav, 1, 'the nav anchor');
  assert.strictEqual(kinds.ncx, 1, 'the NCX label');
  assert.strictEqual(kinds['opf-title'], 1, 'the book title, which is spoken too');
});

test('selection leaves a CAPTION alone — the cut owns that decision', async () => {
  const book = await buildBook('select-caption.epub');
  const selected = norm.selectNumberTargets(await readNarrationNumberTargets(book));
  assert.ok(!selected.some((t) => t.text.includes('Figure 7')),
    'a stamped caption is never normalized into speakable words');
});

test('a heading is recognized by its tag AND by the conversion stamp', () => {
  assert.ok(norm.isHeadingTarget({ tag: 'h3', statedCategory: null }));
  assert.ok(norm.isHeadingTarget({ tag: 'p', statedCategory: 'chapter' }));
  assert.ok(norm.isHeadingTarget({ tag: 'p', statedCategory: 'section-header' }));
  assert.ok(!norm.isHeadingTarget({ tag: 'p', statedCategory: 'text' }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation — one test per disposition
// ─────────────────────────────────────────────────────────────────────────────

/** Validate against a target held in ONE text node (the ordinary case). */
const check = (target, edits) => norm.validateNumberEdits(target, [target.length], edits);
const only = (target, find, replace) => check(target, [{ find, replace }]).records[0].status;

test('NOOP — an empty find, or a find identical to its replacement', () => {
  assert.strictEqual(only('He was 7 years old.', '', 'seven'), 'NOOP');
  assert.strictEqual(only('He was 7 years old.', '7', '7'), 'NOOP');
});

test('NOT_FOUND — the find is not verbatim in the target, and there is no ladder', () => {
  assert.strictEqual(only('On 23 March 1933 he spoke.', '23 March 1934', 'x'), 'NOT_FOUND');
  // Whitespace-tolerant matching is DELIBERATELY absent: a number has to be
  // located exactly or not at all.
  assert.strictEqual(only('On 23  March 1933 he spoke.', '23 March 1933', 'x'), 'NOT_FOUND');
});

test('AMBIGUOUS_FIND — the same span twice, so which one was meant is unknown', () => {
  assert.strictEqual(
    only('In 1933 and again in 1933.', '1933', 'nineteen thirty-three'), 'AMBIGUOUS_FIND');
});

test('NO_DIGIT_IN_FIND — prose tidying cannot ride in on a number edit', () => {
  assert.strictEqual(
    only('The Reichstag passed the Act in 1933.', 'Reichstag', 'parliament'), 'NO_DIGIT_IN_FIND');
});

test('DIGIT_IN_REPLACE — a conversion that did not happen', () => {
  assert.strictEqual(only('He was born in 1944.', '1944', '19 forty-four'), 'DIGIT_IN_REPLACE');
});

test('REPLACE_NOT_WORDS — a replacement that is not plain spoken words', () => {
  assert.strictEqual(only('It cost $5.', '$5', 'five dollars ($)'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost $5.', '$5', 'five/five dollars'), 'REPLACE_NOT_WORDS');
  // What IS allowed: letters, spaces, hyphens, commas, apostrophes, periods.
  assert.strictEqual(
    only("June 12, 1933 came.", 'June 12, 1933', "June twelfth, nineteen thirty-three"),
    'APPLIED');
});

test('WORDS_DROPPED — the model may convert numbers, never rename the prose', () => {
  assert.strictEqual(
    only('It fell 37.4 per cent that year.', '37.4 per cent',
      'thirty-seven point four percent'),
    'WORDS_DROPPED', 'the book prints "per cent" and the copy has to keep saying it');
  assert.strictEqual(
    only('On 12 February 1933 he wrote.', '12 February 1933',
      'March twelfth, nineteen thirty-three'),
    'WORDS_DROPPED', 'a month may not be renamed');
  assert.strictEqual(
    only('It was $1.5 million.', '$1.5 million', 'one point five million dollars'), 'APPLIED');
});

test('CITATION_CODE — a slash between digits, in the find or against its edge', () => {
  assert.strictEqual(
    only('Document II 9/34, p. 23.', '9/34', 'nine thirty-four'), 'CITATION_CODE');
  assert.strictEqual(
    only('Cited as 298/38 in the file.', '298', 'two hundred ninety-eight'), 'CITATION_CODE');
  assert.strictEqual(
    only('Cited as 298/38 in the file.', '38', 'thirty-eight'), 'CITATION_CODE');
});

test('CITATION_CODE — a page abbreviation immediately before the number', () => {
  for (const lead of ['p.', 'pp.', 'vol.', 'no.', 'nos.', 'ibid.', 'cf.', 'fol.']) {
    assert.strictEqual(
      only(`See ${lead} 23 for the rest.`, '23', 'twenty-three'), 'CITATION_CODE', lead);
  }
});

test('CITATION_CODE — an area code beside a phone number', () => {
  // The record's own case: 9b proposed "(405)" → "(four zero five)", and until
  // 2026-09-02 only the punctuation guard stopped it. Now that a replacement may
  // carry the parentheses its find had, the phone shape is what refuses it.
  assert.strictEqual(
    only('Reach them at (405) 235-5396 today.', '(405)', '(four zero five)'), 'CITATION_CODE');
  assert.strictEqual(
    only('Reach them at (405) 235-5396 today.', '235-5396', 'two three five five three nine six'),
    'CITATION_CODE');
});

test('CITATION_CODE — a roman-numeral token beside it, but never a bare "I"', () => {
  assert.strictEqual(only('Document II 9 was filed.', '9', 'nine'), 'CITATION_CODE');
  assert.strictEqual(only('Volume XIV 9 was filed.', '9', 'nine'), 'CITATION_CODE');
  // "I" is a pronoun and single letters are initials — refusing on those would
  // refuse ordinary prose, which is the false negative that costs more.
  assert.strictEqual(only('I 9 times asked.', '9', 'nine'), 'APPLIED');
});

/**
 * THE ORACLE CROSS-CHECK IS GONE, and this is what replaced it.
 *
 * Until 2026-09-02 a `ORACLE_DISAGREE` disposition let number-expansion.ts
 * overrule the model on five shapes it read unambiguously: currency, percent,
 * ordinals, decades and comma-grouped thousands. All five are now RULES — the
 * model is never shown them at all, so there is nothing left for the cross-check
 * to disagree with, and a dead branch would only be a rule set nobody runs. What
 * the check was defending is defended better here: the reading is not compared
 * to the model's, it IS the reading.
 */
test('the five shapes the oracle used to guard are read by RULES now', () => {
  const { applyNumberRules } = require(path.join(DIST, 'electron', 'tts-number-rules.js'));
  const reads = (text) => applyNumberRules(text, [text.length]).text;
  assert.strictEqual(reads('It cost $5.50.'), 'It cost five dollars and fifty cents.');
  assert.strictEqual(reads('It was 50% done.'), 'It was fifty percent done.');
  assert.strictEqual(reads('The 7th of them.'), 'The seventh of them.');
  assert.strictEqual(reads('In the 1930s it grew.'), 'In the nineteen thirties it grew.');
  assert.strictEqual(reads('Some 3,450 came.'), 'Some three thousand four hundred fifty came.');
  // And the shape the oracle got WRONG — its rule let the scale word win over
  // the decimal and dropped the .5 — is read correctly by the money rule.
  assert.strictEqual(reads('It was $1.5 million.'), 'It was one point five million dollars.');
});

test('the shapes the rules DECLINE are exactly what still reaches the model', () => {
  // A bare four-digit quantity is the ambiguity the model exists for.
  assert.strictEqual(only('By spring 1200 workers were on the line.',
    '1200 workers', 'twelve hundred workers'), 'APPLIED');
  assert.strictEqual(only('It ran 1914-1918 without a break.',
    '1914-1918', 'nineteen fourteen to nineteen eighteen'), 'APPLIED');
});

test('AMBIGUOUS_FIND is DIGIT-BOUNDED — "1." is not found inside "11."', () => {
  // The measured failure: fifty list markers thrown away on 2026-09-02 because
  // `indexOf` matched the "1." inside "11." and called the edit ambiguous.
  assert.strictEqual(only('11. Amulet', '1.', 'one.'), 'NOT_FOUND',
    'the only occurrence sits inside another number, so there is none');
  assert.strictEqual(only('1. Amulet and 11. Charm', '1.', 'one.'), 'APPLIED',
    'the real marker is found, and the one inside "11." is not a second one');
  assert.strictEqual(only('1. Amulet and 1. Charm', '1.', 'one.'), 'AMBIGUOUS_FIND',
    'two real occurrences are still ambiguous');
  // And the same boundary the other way: the "19" inside "1944" is not a second
  // occurrence, so the real one is found instead of being called ambiguous.
  const { accepted } = check('In 1944 he was 19.', [{ find: '19', replace: 'nineteen' }]);
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].at, 'In 1944 he was '.length, 'the standalone 19, not 1944\'s');
});

test('REPLACE_NOT_WORDS allows the punctuation the FIND itself carried', () => {
  // Five applied edits were refused on 2026-09-02 for carrying the em dash and
  // the parentheses the book printed.
  assert.strictEqual(
    only('1. Halloween—October 31 is the first.', '1. Halloween—October 31',
      'one. Halloween—October thirty-first'), 'APPLIED');
  assert.strictEqual(
    only('The number was (405) that year.', '(405)', '(four zero five)'), 'APPLIED');
  assert.strictEqual(
    only('Chapter 3: The Long Year', 'Chapter 3', 'Chapter Three'), 'APPLIED');
  // What is still refused is a digit, a currency sign, a slash, markup.
  assert.strictEqual(only('It cost $5.', '$5', 'five dollars ($)'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost $5.', '$5', 'five/five dollars'), 'REPLACE_NOT_WORDS');
  assert.strictEqual(only('It cost 5 marks.', '5 marks', '<em>five</em> marks'),
    'REPLACE_NOT_WORDS');
});

test('PUNCTUATION_SPOKEN — the model may not narrate the name of a mark', () => {
  // Forty applied edits on 2026-09-02 said "hyphen" or "colon" out loud.
  assert.strictEqual(
    only('Deuteronomy 7:25–26 says so.', '7:25–26', 'seven twenty-five hyphen twenty-six'),
    'PUNCTUATION_SPOKEN');
  assert.strictEqual(
    only('Exodus 22:18 says so.', '22:18', 'twenty-two colon eighteen'), 'PUNCTUATION_SPOKEN');
  assert.strictEqual(
    only('Cited as 9-34 there.', '9-34', 'nine dash thirty-four'), 'PUNCTUATION_SPOKEN');
  // Counted, not merely detected: a book that discusses a hyphen keeps saying so.
  assert.strictEqual(
    only('The 3 hyphen rule applied.', '3 hyphen', 'three hyphen'), 'APPLIED');
});

test('NUMBER_DROPPED — every run of digits must come out as a number word', () => {
  // The n2 acceptance run (2026-09-02): "20:6" came back as "twenty", the verse
  // silently gone, and no other check could see it.
  assert.strictEqual(only('See 20:6 there.', '20:6', 'twenty'), 'NUMBER_DROPPED');
  assert.strictEqual(only('See 20:6 there.', '20:6', 'twenty six'), 'APPLIED');
  assert.strictEqual(only('In 1985 it began.', '1985', 'nineteen eighty-five'), 'APPLIED');
  assert.strictEqual(only('Verses 28:7-8 say so.', '28:7-8', 'twenty-eight seven through eight'), 'APPLIED');
  assert.strictEqual(only('Box 001 here.', '001', 'zero zero one'), 'APPLIED');
  // A year range read by half has the right NUMBER of words for the wrong reason:
  // a run of three or more digits is never one English word.
  assert.strictEqual(only('From 1914-1918 it ran.', '1914-1918', 'nineteen fourteen'), 'NUMBER_DROPPED');
  assert.strictEqual(only('From 1914-1918 it ran.', '1914-1918', 'nineteen fourteen to nineteen eighteen'), 'APPLIED');
  assert.strictEqual(only('It left at 10:05.', '10:05', 'ten oh five'), 'APPLIED');
  assert.strictEqual(only('Pi is 3.14 here.', '3.14', 'three point one four'), 'APPLIED');
  assert.strictEqual(only('In 1900 it began.', '1900', 'nineteen hundred'), 'APPLIED');
});

test('LIST_MARKER_PERIOD — a list marker keeps its period', () => {
  assert.strictEqual(only('1. Amulet', '1.', 'one'), 'LIST_MARKER_PERIOD');
  assert.strictEqual(only('1. Amulet', '1.', 'one.'), 'APPLIED');
});

test('SPANS_MARKUP — an edit that would have to cross an <em>', () => {
  // "He was born in 19" + "44" + " and never said so." — three text nodes.
  const target = 'He was born in 1944 and never said so.';
  const segments = ['He was born in '.length, '19'.length, '44 and never said so.'.length];
  const { records, accepted } = norm.validateNumberEdits(target, segments,
    [{ find: '1944', replace: 'nineteen forty-four' }]);
  assert.strictEqual(records[0].status, 'SPANS_MARKUP');
  assert.strictEqual(accepted.length, 0, 'nothing is applied, and the digits stand');
});

test('OVERLAPS_APPLIED — the model returning a span and a span inside it', () => {
  const target = 'On June 12, 1933 he spoke.';
  const { records } = check(target, [
    { find: 'June 12, 1933', replace: 'June twelfth, nineteen thirty-three' },
    { find: '1933', replace: 'nineteen thirty-three' },
  ]);
  assert.deepStrictEqual(records.map((r) => r.status), ['APPLIED', 'OVERLAPS_APPLIED']);
});

test('a rejected edit leaves the ORIGINAL digits, and every one is recorded', () => {
  const target = 'It fell 37.4 per cent in 1933.';
  const { accepted, records } = check(target, [
    { find: '37.4 per cent', replace: 'thirty-seven point four percent' },
    { find: '1933', replace: 'nineteen thirty-three' },
  ]);
  assert.deepStrictEqual(records.map((r) => r.status), ['WORDS_DROPPED', 'APPLIED']);
  assert.strictEqual(accepted.length, 1, 'only the good one');
  assert.strictEqual(accepted[0].at, target.indexOf('1933'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The measured derailment fixture
// ─────────────────────────────────────────────────────────────────────────────

test('fixture date10 (endnote apparatus) yields NO applied edits', () => {
  if (FIXTURES === null) { console.log('   (fixture_texts.json not on this machine)'); return; }
  const target = fixtureText('date10');
  // Every digit in it is archive apparatus. The prompt teaches the model to
  // leave them; this proves the VALIDATOR stops them if it does not.
  const { accepted, records } = check(target, [
    { find: '298/38', replace: 'two ninety-eight thirty-eight' },
    { find: '3659/42', replace: 'thirty-six fifty-nine forty-two' },
  ]);
  assert.strictEqual(accepted.length, 0);
  assert.deepStrictEqual(records.map((r) => r.status), ['CITATION_CODE', 'CITATION_CODE']);
});

test('fixture run209 (a citation string) yields NO applied edits', () => {
  if (FIXTURES === null) { console.log('   (fixture_texts.json not on this machine)'); return; }
  const target = fixtureText('run209');
  const { accepted, records } = check(target, [{ find: '9/34', replace: 'nine thirty-four' }]);
  assert.strictEqual(accepted.length, 0);
  assert.strictEqual(records[0].status, 'CITATION_CODE');
});

test('fixture date04 — the two real numbers in it read correctly', () => {
  if (FIXTURES === null) { console.log('   (fixture_texts.json not on this machine)'); return; }
  const target = fixtureText('date04');
  const { records } = check(target, [
    { find: '3,450', replace: 'three thousand four hundred fifty' },
    { find: '3,450', replace: 'thirty-four fifty' },
  ]);
  // The first is the narrator's own measured reading (README, 2026-09-01); the
  // second is a plausible-sounding drift, refused for reaching into the span the
  // first one already took. (In the live pass neither reaches the model at all —
  // the grouped-integer rule reads "3,450" before it is ever asked.)
  assert.deepStrictEqual(records.map((r) => r.status), ['APPLIED', 'OVERLAPS_APPLIED']);
});

test('fixture date11 — an archive file number is not converted', () => {
  if (FIXTURES === null) { console.log('   (fixture_texts.json not on this machine)'); return; }
  const target = fixtureText('date11');
  // "AfW HH, 260488, Bl. twenty nine" — six digits that are a file reference.
  //
  // Until n5 this was the PROMPT's job alone: no citation rule caught a bare
  // integer after an archive sigil, the validator let the edit through, and the
  // test recorded that boundary honestly. `isArchiveSigil` closed it (the
  // orpheus-finetune side's "Ask 2") — "HH" is a two-character all-caps token
  // standing immediately in front of the number, so the guard now answers
  // CITATION_CODE and the file reference is left exactly as the archive prints
  // it, whatever the model proposes.
  assert.strictEqual(only(target, '260488', 'two hundred sixty thousand four hundred eighty-eight'),
    'CITATION_CODE');
});

test('fixtures with no digits are never selected at all', () => {
  if (FIXTURES === null) { console.log('   (fixture_texts.json not on this machine)'); return; }
  for (const id of ['date00', 'date03', 'date07', 'date09', 'run893']) {
    const text = fixtureText(id);
    assert.ok(!/[0-9]/.test(text), `${id} carries no digit`);
    assert.strictEqual(
      norm.selectNumberTargets([{ text, statedCategory: null }]).length, 0, id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole pass, over a real book
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One test's options, with a cache directory OF ITS OWN.
 *
 * Every book here is built from the same chapter, so every book has the same
 * sha — which is the content-addressing working exactly as designed and would
 * make each test reuse the previous one's copy. The cache is deliberately
 * exercised by the two tests that mean to (they share a directory on purpose);
 * everywhere else it is per-test.
 */
let cacheDirs = 0;
const passOptions = (runner, extra = {}) => ({
  systemPrompt: PROMPT,
  outDir: path.join(ROOT, `cuts-${cacheDirs++}`),
  ...extra,
});


/**
 * The EPUB driver, with the two facts every caller of it owes.
 *
 * `inputSha16` is the copy's name and `copy` is what the write does besides
 * the rewrites — both stated, never defaulted, since the narration TEXT pass
 * became the other caller and wants the opposite of the cut on every one of
 * them (electron/tts-number-normalizer.ts, `NarrationCopyShape`). These are
 * the CUT's answers, because that is what this suite is about.
 */
const bookPass = async (book, runner, extra = {}) => norm.normalizeNarrationNumbers(
  book, runner, {
    ...passOptions(runner, extra),
    inputSha16: await norm.epubContentAddress(book),
    copy: { excludeCaptions: true, excludeFootnotes: true, stripSupMarkers: true },
  });

/** A cache directory two runs SHARE, so reuse can be measured. */
const sharedCache = (name) => path.join(ROOT, `shared-${name}`);

test('the pass rewrites TEXT NODES and leaves every tag where it was', async () => {
  const book = await buildBook('apply.epub');
  const runner = scriptedRunner({
    // The date and the money are the RULES' now, and the model is shown the text
    // with them already read — so the one thing left to answer is the quantity.
    'members watched': editsJson(['1200 members', 'twelve hundred members']),
    // Both <li> items are ONE export unit (the <ul>), so they arrive in one
    // request and come back in one edit list — which is exactly what has to
    // survive being applied to two different text nodes.
    'A printer is represented': editsJson(
      ['1934', 'nineteen thirty-four'], ['1935', 'nineteen thirty-five']),
  });
  const out = await bookPass(book, runner);
  assert.ok(out !== null);

  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(chapter.includes('March twenty-third, nineteen thirty-three'), 'the date landed');
  assert.ok(chapter.includes('five dollars and fifty cents'), 'the money landed');
  assert.ok(chapter.includes('twelve hundred members'), 'and so did the model\'s own edit');
  // The model was never shown the digits the rules had already read.
  const asked = runner.calls.map(targetOf).find((t) => t.includes('members watched'));
  assert.ok(!asked.includes('23 March 1933') && !asked.includes('$5.50'),
    `the rule-applied text is what went out: ${asked}`);
  // The structure e2a depends on, still there.
  assert.ok(chapter.includes('<li>'), 'the list items are still list items');
  assert.ok(chapter.includes('nineteen thirty-four'), 'inside the first <li>');
  assert.ok(chapter.includes('nineteen thirty-five'), 'inside the second <li>');
  assert.ok(chapter.includes('data-bf-cat="chapter"'), 'the conversion stamp survived');
  assert.ok(chapter.includes('<em>19</em>'), 'the <em> is untouched — the edit was refused');
  // The caption never went near the model. It is not in the copy either — the
  // normalizer writes through the SAME door with the same exclusions as the cut,
  // so a book that reached this pass uncut still loses its captions here rather
  // than having them normalized into fluent speech.
  assert.ok(!runner.calls.some((c) => targetOf(c).includes('Figure 7')),
    'the caption was never offered to the model');
  assert.ok(!chapter.includes('Figure 7'), 'and it is not in the narration copy');
  assert.ok(runner.released, 'the model was released before the pass returned');
});

test('the pass VERIFIES the rewrite landed, against the written file', async () => {
  const book = await buildBook('verify.epub');
  const runner = scriptedRunner({
    'members watched': editsJson(['1200 members', 'twelve hundred members']),
  });
  const out = await bookPass(book, runner);
  // `writeNarrationEpub` re-reads the copy and walks it before this returns; a
  // rewrite that did not land destroys the file rather than shipping it. The
  // proof it ran is the count it reports, measured on disk.
  assert.strictEqual(out.record.appliedSpans, 3, 'the date, the money and the quantity');
  const record = JSON.parse(fs.readFileSync(out.recordPath, 'utf8'));
  assert.strictEqual(record.appliedSpans, 3);
  // And the record says which half of the pass did which.
  assert.strictEqual(record.appliedByRules, 2);
  assert.strictEqual(record.appliedByModel, 1);
  assert.strictEqual(record.appliedByRules + record.appliedByModel, record.appliedSpans);
});

test('a span across an <em> is refused and RECORDED, never flattened', async () => {
  const book = await buildBook('spans.epub');
  const runner = scriptedRunner({
    'He was born in': editsJson(['1944', 'nineteen forty-four']),
  });
  const out = await bookPass(book, runner);
  const statuses = statusesFor(out.record, 'He was born in');
  assert.deepStrictEqual(statuses, ['SPANS_MARKUP']);
  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(chapter.includes('<em>19</em>44'), 'the digits stand, and so does the markup');
});

test('the heading and its contents entries end up saying ONE string', async () => {
  const book = await buildBook('toc.epub');
  const runner = scriptedRunner({
    'Chapter 3: The Long Year': editsJson(['Chapter 3', 'Chapter Three']),
  });
  const out = await bookPass(book, runner);

  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  const nav = await entryText(out.epubPath, 'OEBPS/nav.xhtml');
  const ncx = await entryText(out.epubPath, 'OEBPS/toc.ncx');
  assert.ok(chapter.includes('Chapter Three: The Long Year'), 'the body heading');
  assert.ok(nav.includes('Chapter Three: The Long Year'), 'the nav anchor');
  assert.ok(ncx.includes('Chapter Three: The Long Year'), 'the NCX label');

  // And the entries were NOT asked separately — they took the heading's edits.
  const shared = out.record.units.filter((u) => u.status === 'SHARED_WITH_HEADING');
  assert.strictEqual(shared.length, 2, 'the nav anchor and the NCX label');
  assert.ok(!runner.calls.some((c) => c.includes('TARGET (edit ONLY this):\nChapter 3: The Long Year\n\nNEXT (context only, never edit this):\n(none)')
    && c.includes('PREVIOUS (context only, never edit this):\n(none)')),
    'the contents entries cost no extra request');
});

test('the OPF title is normalized too — it is spoken', async () => {
  const book = await buildBook('title.epub');
  const runner = scriptedRunner({
    'The 1933 Book': editsJson(['1933', 'nineteen thirty-three']),
  });
  const out = await bookPass(book, runner);
  const opf = await entryText(out.epubPath, 'OEBPS/content.opf');
  assert.ok(opf.includes('The nineteen thirty-three Book'));
});

test('a book that prints no digits comes back UNTOUCHED, with no model call', async () => {
  const plain = CHAPTER.replace(/\d/g, '').replace('Figure . The plate above, taken in .', 'A plate.');
  const opf = OPF.replace('The 1933 Book', 'The Book');
  const nav = 'x';  // unused; the nav below is replaced wholesale
  const book = await buildBook('plain.epub', plain, opf);
  // The nav still prints "Chapter 3", so rebuild the book without it.
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV.replace('Chapter 3', 'Chapter Three'), 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(NCX.replace(/1933|Chapter 3/g, 'Chapter Three'), 'utf8'));
  zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(plain.replace('Chapter : The Long Year', 'Chapter Three: The Long Year'), 'utf8'));
  const digitless = path.join(ROOT, 'digitless.epub');
  await zip.write(digitless);
  assert.ok(nav === 'x');

  const runner = scriptedRunner({});
  const out = await bookPass(digitless, runner);
  assert.strictEqual(out, null, 'the pass reports nothing to do');
  assert.strictEqual(runner.calls.length, 0, 'and the model was never loaded');
});

test('the cache path is the same for the same input, version and model', async () => {
  const a = norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:9b');
  const b = norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:9b');
  assert.strictEqual(a.epubPath, b.epubPath);
  assert.ok(a.epubPath.endsWith(`.${norm.NORMALIZER_VERSION}.qwen3.5-9b.norm.tts.epub`));
  assert.strictEqual(a.recordPath, a.epubPath.replace(/\.epub$/, '.edits.json'));
  // A different model, or a different input, is a different file.
  assert.notStrictEqual(
    a.epubPath, norm.normalizedCopyPaths('/out', 'abc1234567890def', 'qwen3.5:27b').epubPath);
  assert.notStrictEqual(
    a.epubPath, norm.normalizedCopyPaths('/out', 'ffff1234567890de', 'qwen3.5:9b').epubPath);
});

test('a copy already on disk is REUSED, without calling the model', async () => {
  const book = await buildBook('cache.epub');
  const answers = { 'On 23 March 1933': editsJson(['$5.50', 'five dollars and fifty cents']) };
  const dir = sharedCache('reuse');
  const first = scriptedRunner(answers);
  const one = await bookPass(book, first, { outDir: dir });
  assert.ok(first.calls.length > 0);

  const second = scriptedRunner(answers);
  const two = await bookPass(book, second, { outDir: dir });
  assert.strictEqual(two.epubPath, one.epubPath, 'the same path');
  assert.strictEqual(two.reused, true);
  assert.strictEqual(second.calls.length, 0, 'and not one request went out');
});

test('a copy whose RECORD is missing is re-made — the record is part of it', async () => {
  const book = await buildBook('cache-halved.epub');
  const answers = { 'On 23 March 1933': editsJson(['$5.50', 'five dollars and fifty cents']) };
  const dir = sharedCache('halved');
  const first = scriptedRunner(answers);
  const one = await bookPass(book, first, { outDir: dir });
  fs.unlinkSync(one.recordPath);

  const second = scriptedRunner(answers);
  const two = await bookPass(book, second, { outDir: dir });
  assert.strictEqual(two.reused, false);
  assert.ok(second.calls.length > 0);
  assert.ok(fs.existsSync(two.recordPath));
});

test('more than 10% of passages failing to parse FAILS the job, by name', async () => {
  const book = await buildBook('parse-fail.epub');
  const runner = scriptedRunner({}, {});
  // Every answer is garbage: no JSON object anywhere in it.
  runner.generate = async (input) => { runner.calls.push(input); return 'I cannot help with that.'; };
  await assert.rejects(
    bookPass(book, runner),
    (err) => {
      assert.ok(err.message.includes('fake:1b'), 'the model is named');
      assert.ok(/failed to produce a usable edit list for \d+ of \d+/.test(err.message),
        'and so is the count');
      return true;
    });
  assert.ok(runner.released, 'the model is still released on the way out');
});

test('one bad answer among many is recorded UNIT_PARSE_FAIL, and the book stands', async () => {
  const book = await buildBook('one-bad.epub', LONG_CHAPTER);
  const runner = scriptedRunner({});
  let seen = 0;
  runner.generate = async (input) => {
    runner.calls.push(input);
    // ONE passage of twenty-two, which is under the 10% bar. It is asked twice:
    // a parse failure is content-correlated and gets exactly one re-roll at the
    // same settings, because a second identical answer is the model's answer.
    if (targetOf(input).includes('Paragraph 4:')) { seen++; return 'not json at all'; }
    return '{"edits": []}';
  };
  const out = await bookPass(book, runner);
  assert.strictEqual(seen, 2, 'a parse failure is retried exactly once');
  const failed = out.record.units.filter((u) => u.status === 'UNIT_PARSE_FAIL');
  assert.strictEqual(failed.length, 1);
  assert.ok(failed[0].rawAnswer.includes('not json'), 'the raw answer is kept for diagnosis');
  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  // The rules had already read the date — that is not the model's to lose — and
  // what the model would have been asked about keeps its digits.
  assert.ok(chapter.includes('Paragraph 4: on March second, nineteen thirteen'),
    'the deterministic reading stands even when the answer would not parse');
});

test('an unreachable model THROWS, naming the model tag', async () => {
  const book = await buildBook('unreachable.epub');
  const runner = scriptedRunner({}, { throws: 'connect ECONNREFUSED 127.0.0.1:11434' });
  await assert.rejects(
    bookPass(book, runner),
    (err) => {
      assert.ok(err.message.includes('fake:1b'), `names the model: ${err.message}`);
      assert.ok(err.message.includes('ECONNREFUSED'), 'and says what happened');
      return true;
    });
});

test('a transport failure is retried ONCE, then the pass carries on', async () => {
  const book = await buildBook('flaky.epub');
  const runner = scriptedRunner({});
  let firstCall = true;
  runner.generate = async (input) => {
    runner.calls.push(input);
    if (firstCall) { firstCall = false; throw new Error('fetch failed'); }
    return input.includes('On 23 March 1933')
      ? editsJson(['$5.50', 'five dollars and fifty cents'])
      : '{"edits": []}';
  };
  const out = await bookPass(book, runner);
  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(chapter.includes('five dollars and fifty cents'));
});

test('progress is counted over the passages that are actually ASKED', async () => {
  const book = await buildBook('progress.epub');
  const runner = scriptedRunner({});
  const ticks = [];
  const out = await bookPass(book, runner,
    { onProgress: (done, total, label) => ticks.push({ done, total, label }) });
  assert.ok(out !== null);
  assert.ok(ticks.length > 1);
  assert.strictEqual(ticks[0].label, 'Normalizing numbers');
  assert.strictEqual(ticks[ticks.length - 1].label, 'Releasing model');
  assert.strictEqual(ticks[ticks.length - 1].done, ticks[ticks.length - 1].total);
  // The contents entries take the heading's edits and cost no request, so they
  // are not in the count the bar divides by.
  assert.strictEqual(ticks[0].total, runner.calls.length,
    'the total is the number of requests that will be made');
});

test('the record names every proposed edit and its disposition', async () => {
  const book = await buildBook('record.epub');
  const runner = scriptedRunner({
    'members watched': editsJson(
      ['1200 members', 'twelve hundred members'],
      // A span the RULES already read: the model does not get a second opinion.
      ['five dollars and fifty cents', 'five fifty'],
      ['Reichstag', 'parliament']),
  });
  const out = await bookPass(book, runner);
  const record = JSON.parse(fs.readFileSync(out.recordPath, 'utf8'));
  assert.strictEqual(record.normalizerVersion, norm.NORMALIZER_VERSION);
  assert.strictEqual(record.model, 'fake:1b');
  assert.strictEqual(record.inputSha16.length, 16);
  const unit = record.units.find((u) => u.text.includes('On 23 March 1933'));
  // The rules' own edits lead the trail, each naming the rule that read it.
  assert.deepStrictEqual(unit.edits.map((e) => e.status),
    ['APPLIED_RULE', 'APPLIED_RULE', 'APPLIED', 'NO_DIGIT_IN_FIND', 'NO_DIGIT_IN_FIND']);
  assert.deepStrictEqual(unit.edits.slice(0, 2).map((e) => [e.detail, e.find]),
    [['date', '23 March 1933'], ['money', '$5.50']]);
  assert.strictEqual(unit.status, 'ANSWERED');
  assert.strictEqual(
    (record.dispositions.APPLIED ?? 0) + (record.dispositions.APPLIED_RULE ?? 0),
    out.record.appliedSpans);
});

test('a passage the RULES finished is never sent to the model', async () => {
  // The <li> list is the only unit of this book whose digits the rules decline
  // (bare four-digit years), so pointing the rules at a rules-only chapter is
  // the cleanest way to watch a unit skip the model entirely.
  const chapter = CHAPTER.replace(
    'and 1200 members watched the pamphlet sell for $5.50',
    'and the pamphlet sold for $5.50');
  const book = await buildBook('rules-only.epub', chapter);
  const runner = scriptedRunner({});
  const out = await bookPass(book, runner);

  const unit = out.record.units.find((u) => u.text.includes('On 23 March 1933'));
  assert.strictEqual(unit.status, 'RULES_ONLY');
  assert.deepStrictEqual(unit.edits.map((e) => e.status), ['APPLIED_RULE', 'APPLIED_RULE']);
  assert.ok(!runner.calls.some((c) => targetOf(c).includes('the Reichstag')),
    'the paragraph cost no request at all');
  assert.strictEqual(out.record.targetsAsked, runner.calls.length,
    'and the asked count is the number of requests that were made');

  const written = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(written.includes('On March twenty-third, nineteen thirty-three the Reichstag'));
  assert.ok(written.includes('sold for five dollars and fifty cents'));
});

test('a model edit is mapped back past the rules\' own length changes', async () => {
  const book = await buildBook('mapback.epub');
  const runner = scriptedRunner({
    'members watched': editsJson(['1200 members', 'twelve hundred members']),
  });
  const out = await bookPass(book, runner);
  const unit = out.record.units.find((u) => u.text.includes('On 23 March 1933'));
  // "23 March 1933" grew by twenty-odd characters before the model's own span,
  // so an unmapped offset would splice "twelve hundred members" into the middle
  // of a word — and `writeNarrationEpub` would have destroyed the output.
  assert.deepStrictEqual(unit.edits.map((e) => e.status),
    ['APPLIED_RULE', 'APPLIED_RULE', 'APPLIED']);
  const chapter = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(chapter.includes(
    'On March twenty-third, nineteen thirty-three the Reichstag passed the Enabling Act, '
    + 'and twelve hundred members watched the pamphlet sell for five dollars and fifty cents.'),
    chapter);
});

test('a rule refusal is RECORDED, and the span is left for nobody', async () => {
  // The money amount split by an <em>: the rules cannot have it, and no later
  // rule may take the "50" out of the wreckage either.
  const chapter = CHAPTER.replace(
    'sell for $5.50.', 'sell for $5.<em>5</em>0.');
  const book = await buildBook('rule-refused.epub', chapter);
  const runner = scriptedRunner({});
  const out = await bookPass(book, runner);
  const unit = out.record.units.find((u) => u.text.includes('On 23 March 1933'));
  const refusal = unit.edits.find((e) => e.status === 'SPANS_MARKUP');
  assert.ok(refusal !== undefined, JSON.stringify(unit.edits));
  assert.strictEqual(refusal.find, '$5.50');
  assert.ok(refusal.detail.includes('money rule'), refusal.detail);
  const written = await entryText(out.epubPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(written.includes('$5.<em>5</em>0'), 'the digits and the markup both stand');
});

test('the context window is pinned ONCE, to the longest request', async () => {
  const book = await buildBook('pin.epub');
  const runner = scriptedRunner({});
  await bookPass(book, runner);
  assert.ok(runner.pinned !== null, 'the runner was given a chance to size itself');
  assert.strictEqual(runner.pinned.systemPrompt, PROMPT);
  for (const call of runner.calls) {
    assert.ok(call.length <= runner.pinned.longest.length, 'nothing sent exceeds it');
  }
});

test('the model input labels the context and forbids editing it', async () => {
  const input = norm.buildNormalizerInput('TARGET TEXT 1933', 'BEFORE', null);
  assert.ok(input.includes('PREVIOUS (context only, never edit this):\nBEFORE'));
  assert.ok(input.includes('TARGET (edit ONLY this):\nTARGET TEXT 1933'));
  assert.ok(input.includes('NEXT (context only, never edit this):\n(none)'),
    'an absent neighbour says so, rather than being left blank');
});

// ─────────────────────────────────────────────────────────────────────────────
// The LIVE probe — the reviewer runs this, deliberately, when the GPU is free
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send every measured fixture text through the REAL model and print what the
 * validator did with each answer.
 *
 * This loads a model and takes the card. It is never part of the suite above and
 * never part of the keeper sweep — it exists so a reviewer can measure a
 * candidate model against the texts that derailed the 08-30 probe before
 * changing `ttsNumberNormalizerModel`.
 */
async function live(model) {
  if (FIXTURES === null) {
    console.error(`No fixture_texts.json at ${FIXTURE_PATH} — the live probe has nothing to read.`);
    process.exit(1);
  }
  const { loadNumberNormalizePrompt } = require(path.join(DIST, 'electron', 'ai-bridge.js'));
  const { createOllamaNormalizerRunner } =
    require(path.join(DIST, 'electron', 'tts-number-normalizer-runner.js'));
  const prompt = await loadNumberNormalizePrompt();
  const runner = createOllamaNormalizerRunner(model);
  const longest = FIXTURES.map((f) => norm.buildNormalizerInput(f.text, null, null))
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  runner.pinContextTo(prompt, longest);

  console.log(`\nLIVE: ${model} over ${FIXTURES.length} measured texts\n`);
  const tally = {};
  try {
    for (const fixture of FIXTURES) {
      if (!/[0-9]/.test(fixture.text)) {
        console.log(`${fixture.id.padEnd(8)} (no digits — never selected)`);
        continue;
      }
      const answer = await runner.generate(
        norm.buildNormalizerInput(fixture.text, null, null), prompt);
      const { firstJsonObject } = require(path.join(DIST, 'electron', 'ai-cleanup-prepass.js'));
      const objText = firstJsonObject(answer);
      if (objText === null) {
        console.log(`${fixture.id.padEnd(8)} UNIT_PARSE_FAIL  ${answer.slice(0, 90)}`);
        tally.UNIT_PARSE_FAIL = (tally.UNIT_PARSE_FAIL ?? 0) + 1;
        continue;
      }
      const parsed = JSON.parse(objText);
      const { records } = norm.validateNumberEdits(
        fixture.text, [fixture.text.length], parsed.edits ?? []);
      if (records.length === 0) console.log(`${fixture.id.padEnd(8)} (no edits proposed)`);
      for (const r of records) {
        tally[r.status] = (tally[r.status] ?? 0) + 1;
        console.log(`${fixture.id.padEnd(8)} ${r.status.padEnd(18)} `
          + `"${r.find}" -> "${r.replace}"${r.detail ? `  [${r.detail}]` : ''}`);
      }
    }
  } finally {
    await runner.release();
  }
  console.log(`\nDispositions: ${JSON.stringify(tally)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  const liveAt = process.argv.indexOf('--live');
  if (liveAt >= 0) {
    const model = process.argv[liveAt + 1];
    if (!model) {
      console.error('--live needs a model tag, e.g. --live qwen3.5:9b');
      process.exit(1);
    }
    await live(model);
    return;
  }

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`FAIL  ${name}`);
      console.log(`      ${err && err.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`\n${f.name}\n${f.err && f.err.stack}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
