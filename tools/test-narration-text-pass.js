#!/usr/bin/env node
/**
 * test-narration-text-pass.js — the narration text cleanup, over a real book on
 * disk, with a scripted model.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-text-pass.js
 *
 * What this proves, and why each one is here:
 *
 *  - the THREE STAGES run in order, on the same book: the printed ellipsis and
 *    the curly quotes are canonical, and the numbers the rules and the model
 *    read are words;
 *  - the pass is TEXT ONLY. Every element the book had is still there, in the
 *    same document, in the same order — the invariant `registerLedgerPass` and
 *    `verifyNarrationCarry` both check, and the one that keeps a user's narration
 *    strikes pointing at the paragraphs they were made against;
 *  - the STAMP is written, and `narrationTextGate` reads it — missing, stale and
 *    current are three different answers with three different sentences;
 *  - a span that would have to cross an `<em>` is REFUSED and recorded, never
 *    flattened;
 *  - the book is never edited in place, and the pass refuses to try.
 *
 * Everything is written to a temp directory; nothing here touches the library,
 * and no model is loaded.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'narration-text-pass.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-narration-text-'));
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

const {
  ZipWriter, readNarrationNumberTargets, readNarrationTextStamp,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));
const pass = require(path.join(DIST, 'electron', 'narration-text-pass.js'));
const norm = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));
const punct = require(path.join(DIST, 'electron', 'tts-punctuation.js'));

const PROMPT = fs.readFileSync(
  path.join(REPO, 'electron', 'prompts', 'tts-number-normalize.txt'), 'utf8').trim();

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A book with one of everything this pass has to get right
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:narration-text</dc:identifier>
<dc:title>The Long Year</dc:title>
<dc:language>en</dc:language>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc"><ol>
<li><a href="chapter-01.xhtml">The Long Year</a></li>
</ol></nav>
</body>
</html>`;

/**
 * The chapter.
 *
 *  - a SPACED ELLIPSIS and CURLY QUOTES, the whole reason the punctuation stage
 *    exists (Mutineer's Moon prints ". . ." 173 times);
 *  - a NON-BREAKING SPACE inside "Mr. Smith", which is what a carefully set
 *    EPUB prints;
 *  - a scripture reference the RULES read, and a bare four-digit year only the
 *    model can judge;
 *  - an ellipsis SPLIT BY AN `<em>`, which cannot be canonicalized without
 *    flattening the element and must be refused;
 *  - a `data-bf-cat="caption"` element, which this pass canonicalizes like any
 *    other text and must NEVER remove — the cut owns that decision, later, on
 *    the other file.
 */
const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>One</title></head>
<body>
<h2 data-bf-cat="chapter">The Long Year</h2>
<p data-bf-cat="text">“You mean . . . ?” “Precisely, Commander.”</p>
<p data-bf-cat="text">Mr. Smith read Col. 3:19-4:1 and then 250 members left in 1934.</p>
<p data-bf-cat="text">He paused… then went on, and it wasn’t his to give.</p>
<p data-bf-cat="text">A dot .<em> </em>. . split by markup.</p>
<p data-bf-cat="text">A dash a<em>-</em>-b split by markup.</p>
<pre data-bf-cat="text">def f(x):
    return  x   # two spaces, and they are the author's
</pre>
<p data-bf-cat="text" style="white-space: pre-wrap">  laid   out   by   hand  </p>
<p data-bf-cat="caption">Figure 7. The plate above, taken in 1936.</p>
</body>
</html>`;

async function buildBook(name, chapter = CHAPTER) {
  const zip = new ZipWriter();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(OPF, 'utf8'));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(NAV, 'utf8'));
  zip.addFile('OEBPS/chapter-01.xhtml', Buffer.from(chapter, 'utf8'));
  const out = path.join(ROOT, name);
  await zip.write(out);
  return out;
}

/** A model that answers a scripted edit list, and never dials anything. */
function scriptedRunner(answers = {}, model = 'fake:1b') {
  return {
    model,
    released: false,
    calls: [],
    pinContextTo() { /* nothing to size without a real window */ },
    async generate(input) {
      this.calls.push(input);
      for (const [needle, answer] of Object.entries(answers)) {
        if (input.includes(needle)) return answer;
      }
      return '{"edits": []}';
    },
    async release() { this.released = true; },
  };
}

let caseNumber = 0;
function optionsFor(epubPath, runner, name) {
  caseNumber++;
  const dir = path.join(ROOT, `case-${caseNumber}-${name}`);
  return {
    epubPath,
    outPath: path.join(dir, 'cleaned.epub'),
    cacheDir: path.join(dir, 'cache'),
    systemPrompt: PROMPT,
    model: runner.model,
    runner,
  };
}

/** Did the scripted model see a block starting with this text? */
function runnerSawText(result, prefix) {
  return result.receipt.numbers !== null
    && result.receipt.numbers.units.some((u) => u.text.trim().startsWith(prefix));
}

/** Every element of the book, by document, as the narration walk sees them. */
async function shapeOf(bookPath) {
  const targets = await readNarrationNumberTargets(bookPath);
  return targets.map((t) => `${t.file}#${t.kind}:${t.tag}`);
}

/** One target's text, by the text it starts with. */
async function textStartingWith(bookPath, prefix) {
  const targets = await readNarrationNumberTargets(bookPath);
  const hit = targets.find((t) => t.text.startsWith(prefix));
  assert.ok(hit !== undefined, `no text starting "${prefix}" in ${path.basename(bookPath)}`);
  return hit.text;
}

// ─────────────────────────────────────────────────────────────────────────────
// The spans stage 1 hands the writer
// ─────────────────────────────────────────────────────────────────────────────

test('punctuationSpans describes the change at offsets in the PRINTED text', () => {
  const before = 'He said “hi” then';
  const after = punct.canonicalizePunctuationText(before);
  const spans = pass.punctuationSpans(before, after);
  assert.deepStrictEqual(spans, [
    { at: 8, find: '“', replace: '"' },
    { at: 11, find: '”', replace: '"' },
  ]);
  // And they reconstruct the canonical text exactly, applied back to front.
  let text = before;
  for (const s of [...spans].sort((a, b) => b.at - a.at)) {
    assert.strictEqual(text.slice(s.at, s.at + s.find.length), s.find);
    text = text.slice(0, s.at) + s.replace + text.slice(s.at + s.find.length);
  }
  assert.strictEqual(text, after);
});

test('punctuationSpans groups a removal and the insertion beside it as ONE span', () => {
  // The typewriter dash is one replacement: two hyphens out, an em dash in.
  const before = 'He turned--slowly.';
  const spans = pass.punctuationSpans(before, punct.canonicalizePunctuationText(before));
  assert.deepStrictEqual(spans, [{ at: 9, find: '--', replace: punct.CANONICAL_DASH }]);
});

test('a spaced ellipsis decomposes into the spaces it drops, and rebuilds exactly', () => {
  // NOT one span, and that is what makes the cross-markup case survivable: the
  // canonicalization of ". . ." is two deletions with a period between them, so
  // each piece can sit in its own text node.
  const before = 'a . . . b';
  const after = punct.canonicalizePunctuationText(before);
  const spans = pass.punctuationSpans(before, after);
  assert.deepStrictEqual(spans, [
    { at: 3, find: ' ', replace: '' },
    { at: 5, find: ' ', replace: '' },
  ]);
  let text = before;
  for (const s of [...spans].sort((a, b) => b.at - a.at)) {
    text = text.slice(0, s.at) + s.replace + text.slice(s.at + s.find.length);
  }
  assert.strictEqual(text, after);
});

test('a text that is already canonical produces no spans at all', () => {
  const text = 'He said "hi" then... and left.';
  assert.deepStrictEqual(pass.punctuationSpans(text, punct.canonicalizePunctuationText(text)), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole pass
// ─────────────────────────────────────────────────────────────────────────────

test('the three stages run, in order, over one book', async () => {
  const book = await buildBook('three-stages.epub');
  const runner = scriptedRunner({
    'left in 1934': '{"edits": [{"find": "1934", "replace": "nineteen thirty-four"}]}',
  });
  const result = await pass.runNarrationTextPass(optionsFor(book, runner, 'three-stages'));

  // 1. punctuation
  assert.strictEqual(
    await textStartingWith(result.outPath, '"You mean'),
    '"You mean ... ?" "Precisely, Commander."');
  assert.strictEqual(
    await textStartingWith(result.outPath, 'He paused'),
    'He paused... then went on, and it wasn\'t his to give.');
  // 2. the rules, and 3. the model, on the SAME paragraph — and the NBSP that
  // stood between "Mr." and "Smith" is an ordinary space by the time they read it.
  assert.strictEqual(
    await textStartingWith(result.outPath, 'Mr. Smith'),
    'Mr. Smith read Colossians three nineteen through four one and then two hundred fifty '
    + 'members left in nineteen thirty-four.');

  assert.ok(runner.released, 'the model\'s VRAM is given back before the pass returns');
});

test('the book is TEXT ONLY — every element survives, in place', async () => {
  const book = await buildBook('text-only.epub');
  const before = await shapeOf(book);
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'text-only'));
  assert.deepStrictEqual(await shapeOf(result.outPath), before);
});

test('a CAPTION keeps its place and its stamp — the cut owns that decision', async () => {
  const book = await buildBook('caption.epub');
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'caption'));
  const targets = await readNarrationNumberTargets(result.outPath);
  const caption = targets.find((t) => t.statedCategory === 'caption');
  assert.ok(caption !== undefined, 'the caption is still in the book');
  // Its punctuation IS canonicalized (it is text like any other); its DIGITS are
  // not, because `selectNumberTargets` leaves captions to the cut.
  assert.ok(caption.text.includes('1936'), caption.text);
});

test('a span that would cross an <em> is REFUSED and recorded, never flattened', async () => {
  const book = await buildBook('spans-markup.epub');
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'spans-markup'));
  // The markup refusal, apart from the preformatted ones (which have a test of
  // their own): this book carries exactly one span that crosses a text node.
  const refused = result.receipt.punctuation.refused
    .filter((r) => r.reason.includes('text-node boundary'));
  assert.strictEqual(refused.length, 1, JSON.stringify(refused));
  assert.strictEqual(refused[0].find, '--');
  assert.strictEqual(refused[0].replace, punct.CANONICAL_DASH);
  // The book still prints what it printed there: the refusal costs the canonical
  // form, never the text.
  assert.strictEqual(
    await textStartingWith(result.outPath, 'A dash'), 'A dash a--b split by markup.');
  // And the ellipsis whose spaces sat either side of an <em> IS canonicalized,
  // because it decomposes into per-node deletions — see punctuationSpans.
  assert.strictEqual(
    await textStartingWith(result.outPath, 'A dot'), 'A dot ... split by markup.');
});

test('the receipt names the rules that fired and the versions that ran', async () => {
  const book = await buildBook('receipt.epub');
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'receipt'));
  const r = result.receipt;
  assert.strictEqual(r.normalizerVersion, norm.NORMALIZER_VERSION);
  assert.strictEqual(r.punctuationSpec, punct.PUNCTUATION_SPEC_VERSION);
  assert.strictEqual(r.model, 'fake:1b');
  assert.ok(r.changed);
  assert.ok(r.punctuation.counts.quote > 0, JSON.stringify(r.punctuation.counts));
  assert.ok(r.punctuation.counts['ellipsis-run'] > 0, JSON.stringify(r.punctuation.counts));
  assert.ok(r.punctuation.counts['space-variant'] > 0, JSON.stringify(r.punctuation.counts));
  assert.ok(r.numbers !== null && r.numbers.appliedSpans > 0);
  assert.ok(fs.existsSync(r.numbersRecordPath), r.numbersRecordPath);
});

test('the pass STAMPS the book, and the gate reads it', async () => {
  const book = await buildBook('stamp.epub');
  assert.strictEqual(await readNarrationTextStamp(book), null);
  assert.strictEqual((await pass.narrationTextGate(book)).state, 'missing');

  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'stamp'));
  const stamp = await readNarrationTextStamp(result.outPath);
  assert.strictEqual(stamp.normalizerVersion, norm.NORMALIZER_VERSION);
  assert.strictEqual(stamp.punctuationSpec, punct.PUNCTUATION_SPEC_VERSION);
  assert.strictEqual(stamp.model, 'fake:1b');
  assert.ok(Date.parse(stamp.at) > 0, stamp.at);

  const gate = await pass.narrationTextGate(result.outPath);
  assert.strictEqual(gate.ok, true);
  assert.strictEqual(gate.stamp.normalizerVersion, norm.NORMALIZER_VERSION);
});

test('the gate says MISSING and STALE differently, and names the pass', async () => {
  const book = await buildBook('gate.epub');
  const missing = await pass.narrationTextGate(book);
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.state, 'missing');
  assert.ok(missing.reason.includes('Narration text cleanup'), missing.reason);

  // A book stamped by an OLDER pass: written by hand, because the only way to
  // get one otherwise is to check out last week's build.
  const { writeNarrationTextStamp } = require(path.join(DIST, 'electron', 'epub-processor.js'));
  const old = path.join(ROOT, 'gate-stale.epub');
  await writeNarrationTextStamp(book, old, {
    normalizerVersion: 'n1', punctuationSpec: 's0', model: 'fake:1b',
    at: new Date().toISOString(), punctuationRefused: 0,
  });
  const stale = await pass.narrationTextGate(old);
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.state, 'stale');
  assert.ok(stale.reason.includes('n1/s0'), stale.reason);
  assert.ok(stale.reason.includes('again'), stale.reason);
});

test('a second run over the SAME book produces the same text', async () => {
  const book = await buildBook('idempotent.epub');
  const answer = '{"edits": [{"find": "1934", "replace": "nineteen thirty-four"}]}';
  const first = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner({ 'left in 1934': answer }), 'idem-1'));
  // Run it again over the CLEANED book: the punctuation is canonical, the
  // numbers are words, and the pass has nothing left to do.
  const second = await pass.runNarrationTextPass(
    optionsFor(first.outPath, scriptedRunner({ 'left in 1934': answer }), 'idem-2'));
  assert.strictEqual(
    await textStartingWith(second.outPath, 'Mr. Smith'),
    await textStartingWith(first.outPath, 'Mr. Smith'));
  assert.strictEqual(second.receipt.punctuation.spansApplied, 0);
  assert.strictEqual(second.receipt.changed, false);
});

test('PREFORMATTED text is refused, never flattened', async () => {
  const book = await buildBook('preformatted.epub');
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'preformatted'));

  // The author's own spacing survives, character for character.
  const code = await textStartingWith(result.outPath, 'def f(x)');
  assert.ok(code.includes('    return  x'), JSON.stringify(code));
  const styled = await textStartingWith(result.outPath, '  laid');
  assert.strictEqual(styled, '  laid   out   by   hand  ');

  // And the pass SAYS it did not touch them.
  const refused = result.receipt.punctuation.refused;
  assert.strictEqual(refused.filter((r) => r.reason.includes('preserves its own whitespace'))
    .length, 2, JSON.stringify(refused.map((r) => r.reason)));

  // The number stage leaves them alone too: a code listing is not prose.
  assert.ok(!runnerSawText(result, 'def f(x)'), 'the listing was not sent to the model');
});

test('a punctuation INSERTION is absorbed, never thrown on', () => {
  // The two strings the adversarial review reproduced: a soft hyphen, curly
  // quotes, an NBSP and a trailing space are enough for diffChars to choose an
  // alignment that emits a pure insertion.
  for (const printed of ['a\u00adb \u201cc\u201d\u00a0d ', '\u201c\u201d\u00a0a ']) {
    const canonical = punct.canonicalizePunctuationText(printed);
    const spans = pass.punctuationSpans(printed, canonical);
    assert.ok(spans.every((s) => s.find !== ''), 'no span has an empty find');
    let text = printed;
    for (const s of [...spans].sort((a, b) => b.at - a.at)) {
      assert.strictEqual(text.slice(s.at, s.at + s.find.length), s.find);
      text = text.slice(0, s.at) + s.replace + text.slice(s.at + s.find.length);
    }
    assert.strictEqual(text, canonical, JSON.stringify(printed));
  }
});

test('the STAMP says how much the pass could not reach', async () => {
  const book = await buildBook('stamp-refused.epub');
  const result = await pass.runNarrationTextPass(
    optionsFor(book, scriptedRunner(), 'stamp-refused'));
  const stamp = await readNarrationTextStamp(result.outPath);
  assert.strictEqual(stamp.punctuationRefused, result.receipt.punctuation.refused.length);
  assert.ok(stamp.punctuationRefused > 0, 'this book has spans the stage cannot reach');
  const gate = await pass.narrationTextGate(result.outPath);
  assert.strictEqual(gate.stamp.punctuationRefused, stamp.punctuationRefused);
});

test('a stamp this build cannot read is STALE, not an exception', async () => {
  const book = await buildBook('stamp-broken.epub');
  const broken = path.join(ROOT, 'stamp-broken.stamped.epub');
  const { writeNarrationTextStamp } = require(path.join(DIST, 'electron', 'epub-processor.js'));
  await writeNarrationTextStamp(book, broken, {
    normalizerVersion: norm.NORMALIZER_VERSION,
    punctuationSpec: punct.PUNCTUATION_SPEC_VERSION,
    model: 'fake:1b',
    at: new Date().toISOString(),
    // The field a build before this one did not write.
    punctuationRefused: undefined,
  });
  const gate = await pass.narrationTextGate(broken);
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.state, 'stale');
  assert.ok(gate.reason.includes('cannot read'), gate.reason);
  assert.ok(gate.reason.includes('Narration text cleanup'), gate.reason);
});

test('the pass REFUSES to write over the book it is reading', async () => {
  const book = await buildBook('in-place.epub');
  const options = optionsFor(book, scriptedRunner(), 'in-place');
  options.outPath = book;
  await assert.rejects(
    () => pass.runNarrationTextPass(options),
    (err) => /write its result over the book it is reading/.test(err.message));
});

test('the input book is never touched', async () => {
  const book = await buildBook('untouched.epub');
  const before = fs.readFileSync(book);
  await pass.runNarrationTextPass(optionsFor(book, scriptedRunner(), 'untouched'));
  assert.ok(before.equals(fs.readFileSync(book)), 'the book this pass read is unchanged');
});

// ─────────────────────────────────────────────────────────────────────────────
// EVERY BLOCK goes to the model — Owen, 2026-09-04
// ─────────────────────────────────────────────────────────────────────────────

test('a block with no digit in it is asked about too', async () => {
  const book = await buildBook('every-block.epub');
  const runner = scriptedRunner();
  await pass.runNarrationTextPass(optionsFor(book, runner, 'every-block'));

  // The paragraph that prints no digit at all — invisible to a digit test, and
  // exactly the paragraph an abbreviation or an acronym would be in.
  assert.ok(runner.calls.some((c) => c.includes('He paused')), 'the digit-free block was asked');
  // And the CAPTION was not: narrating a caption is the cut's decision, not this
  // pass's, and that exclusion is by category and holds in both modes.
  assert.ok(!runner.calls.some((c) => c.includes('Figure 7')), 'the caption was not');
});

test('a TEXT edit — an abbreviation — is applied and recorded with its class', async () => {
  const book = await buildBook('text-edit.epub');
  const runner = scriptedRunner({
    'Mr. Smith': '{"edits": [{"find": "Mr. Smith", "replace": "Mister Smith"}]}',
  });
  const result = await pass.runNarrationTextPass(optionsFor(book, runner, 'text-edit'));
  assert.ok(
    (await textStartingWith(result.outPath, 'Mister Smith')).startsWith('Mister Smith read'));
  assert.strictEqual(result.receipt.numbers.appliedByClass.abbreviation, 1,
    JSON.stringify(result.receipt.numbers.appliedByClass));
});

// ─────────────────────────────────────────────────────────────────────────────
// What stands in for a lexical anchor on a text edit
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── the text-edit invariants ──');

/** Validate one proposed edit against a block, under the narration policy. */
function verdictOf(target, find, replace, policy = norm.EVERY_CLASS) {
  const { records } = norm.validateNumberEdits(
    target, [target.length], [{ find, replace }], [], policy);
  return records[0];
}

test('classifyEdit names the class from the span, never from the model', () => {
  assert.strictEqual(norm.classifyEdit('1934'), 'number');
  assert.strictEqual(norm.classifyEdit('Dr. Kempner'), 'abbreviation');
  assert.strictEqual(norm.classifyEdit('FBI'), 'all-caps');
  assert.strictEqual(norm.classifyEdit(' (see the note)'), 'bracketed');
  // A WHOLE bracketed insertion is a bracket first, even with a number in it —
  // which is a fact about the RECEIPT. What invariants it has to satisfy is
  // asked directly (does it print a digit; is it a removal).
  assert.strictEqual(norm.classifyEdit(' (see p. 12)'), 'bracketed');
  assert.strictEqual(norm.classifyEdit('cost (1934) and'), 'number');
  assert.strictEqual(norm.classifyEdit('waited - and'), 'spaced-hyphen');
  assert.strictEqual(norm.classifyEdit('Henry VIII'), 'roman');
  assert.strictEqual(norm.classifyEdit('he SAID so'), 'all-caps');
  assert.strictEqual(norm.classifyEdit('a quiet phrase'), 'other');
});

test('a text edit is REFUSED outright by the number pass, as it always was', () => {
  const record = verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith', norm.NUMBERS_ONLY);
  assert.strictEqual(record.status, 'NO_DIGIT_IN_FIND');
});

test('a text edit is accepted by the narration policy', () => {
  const record = verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith');
  assert.strictEqual(record.status, 'APPLIED');
  assert.strictEqual(record.editClass, 'abbreviation');
});

test('a DELETION is only ever a bracketed insertion', () => {
  assert.strictEqual(
    verdictOf('He said (see p. 12) so.', ' (see p. 12)', '').status, 'APPLIED');
  assert.strictEqual(
    verdictOf('He said the thing so.', 'the thing ', '').status, 'EMPTY_REPLACE');
});

test('a find long enough to be a clause is refused', () => {
  const target = `${'word '.repeat(60)}end.`;
  const find = target.slice(0, 205);
  assert.strictEqual(verdictOf(target, find, 'a short reading').status, 'EDIT_TOO_LONG');
});

test('a replacement no reading justifies is refused', () => {
  const record = verdictOf('He said FBI there.', 'FBI', 'F B I '.repeat(20));
  assert.strictEqual(record.status, 'REPLACE_TOO_LONG');
});

/** N distinct all-letter tokens, so every slice of the block is unique. */
function uniqueWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String.fromCharCode(97 + Math.floor(i / 26) % 26)
      + String.fromCharCode(97 + (i % 26)) + 'ord');
  }
  return out;
}

/** N distinct all-letter tokens, so every slice of the block is unique. */
function uniqueWords(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(String.fromCharCode(97 + Math.floor(i / 26) % 26)
      + String.fromCharCode(97 + (i % 26)) + 'ord');
  }
  return out;
}

/** A block of `n` "Dr. <word>" spans — every one a legitimate class-2 edit. */
function doctorBlock(n) {
  return `${uniqueWords(n).map((w) => `Dr. ${w}`).join(', ')}.`;
}

test('a block whose text edits would rewrite a quarter of it is stopped', () => {
  // Every edit here is a real abbreviation reading — the one-token law has no
  // objection to any of them — so what stops the flood is the CHARACTER budget
  // and nothing else, which is what this is here to prove.
  const words = uniqueWords(40);
  const target = doctorBlock(40);
  const budget = Math.max(60, Math.floor(target.length * 0.25));
  const edits = words.map((w) => ({ find: `Dr. ${w}`, replace: `Doctor ${w}` }));
  const { records } = norm.validateNumberEdits(
    target, [target.length], edits, [], norm.EVERY_CLASS);
  const applied = records.filter((r) => r.status === 'APPLIED');
  assert.ok(applied.length > 0, 'the honest readings are taken');
  const stopped = records.find((r) => r.status === 'BLOCK_BUDGET');
  assert.ok(stopped !== undefined, JSON.stringify(records.map((r) => r.status)));
  assert.ok(stopped.detail.includes('25%'), stopped.detail);
  // And it stopped where the budget said it would: each reading spends the
  // longer of its two sides, which is "Doctor <word>" at eleven characters.
  assert.ok(applied.length * 11 <= budget + 11, `${applied.length} applied for a ${budget} budget`);
});

test('the budget has a FLOOR, so a heading\'s only edit is not refused', () => {
  // A quarter of "Dr. Smith waited." is four characters; without the floor the
  // one honest reading in it would be refused for being too big for its block.
  assert.strictEqual(verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith').status,
    'APPLIED');
});

test('the budget has a FLOOR, so a heading\'s only edit is not refused', () => {
  // A quarter of "Dr. Smith waited." is four characters; without the floor the
  // one honest reading in it would be refused for being too big for its block.
  assert.strictEqual(verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith').status,
    'APPLIED');
});

test('a block that proposes a rewrite\'s worth of edits is stopped', () => {
  // A block long enough that the CHARACTER budget affords all forty readings —
  // so the per-block CAP is the only thing that can stop the flood.
  const words = uniqueWords(40);
  const target = `${doctorBlock(40)} ${uniqueWords(400).slice(40).join(' ')}.`;
  const edits = words.map((w) => ({ find: `Dr. ${w}`, replace: `Doctor ${w}` }));
  const { records } = norm.validateNumberEdits(
    target, [target.length], edits, [], norm.EVERY_CLASS);
  const applied = records.filter((r) => r.status === 'APPLIED').length;
  assert.strictEqual(applied, 24, `${applied} applied — the cap is 24`);
  assert.ok(records.some((r) => r.status === 'TOO_MANY_EDITS'), 'the cap fired');
});

/**
 * THE ONE-TOKEN LAW, and the table the adversarial review of 2026-09-04 built
 * to show it was needed.
 *
 * Owen's ruling: for a non-number class the replacement must repeat every word
 * of the find, in order, EXCEPT the single token the class is about. Before it,
 * every row below was APPLIED — measured, not supposed — because the caps bound
 * SIZE and nothing bound MEANING.
 */
const CHAMBERLAIN = 'Neville Chamberlain returned from Munich with a piece of paper in his '
  + 'hand, and the man who had waited all afternoon on the tarmac was not convinced by any of '
  + 'it. The crowds cheered anyway. He did not believe the guarantee would hold, and he had '
  + 'already decided otherwise.';

test('the review\'s adversarial table — every row is refused, by name', () => {
  const rows = [
    ['A1 paraphrase', 'the man who had waited', 'the waiting man', 'NOT_A_CLASS'],
    ['A2 negation', 'was not convinced by any of it', 'was convinced by all of it', 'NOT_A_CLASS'],
    ['A3 name swap', 'Neville Chamberlain', 'Winston Churchill', 'NOT_A_CLASS'],
    ['A4 prose in brackets', 'the guarantee would hold', '', 'EMPTY_REPLACE'],
    ['A5a word swap', 'cheered', 'jeered', 'NOT_A_CLASS'],
    ['A5b negation', 'did not believe', 'believed', 'NOT_A_CLASS'],
    ['A5c negation', 'already decided', 'not yet decided', 'NOT_A_CLASS'],
    ['A6 OCR correction', 'tarmac', 'terrace', 'NOT_A_CLASS'],
    ['B1 prose deleted', 'The crowds cheered anyway. ', '', 'EMPTY_REPLACE'],
  ];
  for (const [name, find, replace, want] of rows) {
    assert.strictEqual(verdictOf(CHAMBERLAIN, find, replace).status, want, name);
  }
});

test('a whole heading, and a whole sentence, are not readings', () => {
  assert.strictEqual(
    verdictOf('The Coming of the War', 'The Coming of the War', 'How the War Arrived').status,
    'NOT_A_CLASS');
  const sentence = 'She had loved him once, and the memory of it was the only thing she still '
    + 'owned';
  assert.strictEqual(
    verdictOf(sentence, sentence,
      'She had hated him always, and the forgetting of it was the one thing she never owned')
      .status,
    'NOT_A_CLASS');
});

test('a bracketed insertion is apparatus only while it is SHORT', () => {
  assert.strictEqual(
    verdictOf('He said (see page twelve) so.', ' (see page twelve)', '').status, 'APPLIED');
  assert.strictEqual(verdictOf('It was [sic] there', '[sic] ', '').status, 'APPLIED');
  const clause = 'He said (though not by the men who signed it) so.';
  const refused = verdictOf(clause, ' (though not by the men who signed it)', '');
  assert.strictEqual(refused.status, 'EMPTY_REPLACE');
  assert.ok(refused.detail.includes('clause of the book'), refused.detail);
});

test('each class may change its OWN token, and only that one', () => {
  const ok = [
    ['abbreviation', 'Dr. Smith waited.', 'Dr. Smith', 'Doctor Smith'],
    ['dotted abbreviation', 'the plan, e.g. the map, held', 'e.g.', 'for example'],
    ['all-caps', 'the FBI agent', 'FBI', 'F B I'],
    ['roman', 'Henry VIII reigned', 'Henry VIII', 'Henry the Eighth'],
    ['emphasis, a case change', 'he never SAID so', 'never SAID so', 'never said so'],
    ['spaced hyphen, punctuation only', 'the man - who waited', 'man - who', 'man\u2014who'],
  ];
  for (const [name, target, find, replace] of ok) {
    assert.strictEqual(verdictOf(target, find, replace).status, 'APPLIED', name);
  }
  // And the neighbouring words may not move.
  assert.strictEqual(
    verdictOf('Dr. Smith waited.', 'Dr. Smith', 'Doctor Jones').status, 'WORDS_DROPPED');
  assert.strictEqual(
    verdictOf('the man - who waited', 'man - who', 'fellow\u2014who').status, 'WORDS_DROPPED');
});

test('the em dash is the ONE character this pass may invent, and only from a hyphen', () => {
  // The class the adversarial review found could never produce an accepted edit:
  // SPOKEN_BASE holds no U+2014 and spokenWords admits only what the find had.
  assert.strictEqual(
    verdictOf('the man - who waited', 'man - who', 'man\u2014who').status, 'APPLIED');
  // A find with no hyphen has no dash to have come from.
  assert.strictEqual(
    verdictOf('the FBI agent', 'FBI', 'F\u2014B\u2014I').status, 'REPLACE_NOT_WORDS');
  // And a NUMBER edit can never invent one, hyphen or no hyphen.
  assert.strictEqual(
    verdictOf('from 1914-1918 it ran', '1914-1918', 'nineteen fourteen\u2014nineteen eighteen')
      .status,
    'REPLACE_NOT_WORDS');
});

test('a number reading may not invent a clause either', () => {
  // Measured by the review: every number invariant passed and the sentence was
  // inverted. WORDS_ADDED is what sees it.
  const inverted = verdictOf('The 12 men who refused were shot',
    'The 12 men who refused were shot',
    'The twelve men who refused were spared, and the men who shot');
  assert.strictEqual(inverted.status, 'WORDS_ADDED');
  assert.ok(inverted.detail.includes('joining word'), inverted.detail);
  // While the readings a conversion legitimately needs still fit.
  for (const [find, replace] of [
    ['1200 workers', 'twelve hundred workers'],
    ['1914-1918', 'nineteen fourteen to nineteen eighteen'],
    ['$5.50', 'five dollars and fifty cents'],
    ['June 12, 1933', 'June twelfth, nineteen thirty-three'],
  ]) {
    assert.strictEqual(verdictOf(`x ${find} y`, find, replace).status, 'APPLIED',
      `${find} -> ${replace}`);
  }
});

test('the number invariants are untouched for a digit-bearing find', () => {
  assert.strictEqual(
    verdictOf('Leviticus 20:6 forbids', '20:6', 'twenty').status, 'NUMBER_DROPPED');
  assert.strictEqual(
    verdictOf('in 1934 he left', '1934', 'nineteen 34').status, 'DIGIT_IN_REPLACE');
  assert.strictEqual(
    verdictOf('on 12 June 1933', '12 June 1933', 'the twelfth, nineteen thirty-three').status,
    'WORDS_DROPPED');
});

test('an edit may not reach into a span the RULES already read', () => {
  const target = 'He read Dr. Smith there, page twenty three.';
  const { records } = norm.validateNumberEdits(
    target, [target.length], [{ find: 'Dr. Smith', replace: 'Doctor Smith' }],
    [{ at: 8, end: 17 }], norm.EVERY_CLASS);
  assert.strictEqual(records[0].status, 'OVERLAPS_APPLIED');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures.length === 0 ? 0 : 1);
})();
