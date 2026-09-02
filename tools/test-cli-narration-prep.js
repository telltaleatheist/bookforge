#!/usr/bin/env node
/**
 * Tests for the narration door as the CLI drives it — the prep step Owen asked
 * for on 2026-09-02: *"make sure the bookforge cli has a cleanup step
 * independent of the tts step, so the user can run one and then the other."*
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-cli-narration-prep.js
 *
 * ── What is worth defending here ────────────────────────────────────────────
 *
 * THAT THERE IS ONE DOOR. `prepareNarrationInput` is what the app's queue calls
 * and what the CLI calls; a CLI running a prep of its own could not catch the
 * app's bugs, which is the entire reason Owen wanted it exposed. So the tests
 * drive the EXPORT, not a copy of its logic.
 *
 * THAT THERE IS ONE LOOP. A book's paragraph and a text file's block are the
 * same question, and `askAboutEach` is the one function that asks it. The proof
 * below is behavioural rather than structural: the same prose, once as a block
 * and once as a paragraph, through the same scripted model, has to come back
 * with the SAME dispositions, the SAME retry count and the SAME progress labels.
 * Two implementations that agreed today would not stay agreed.
 *
 * THAT A TEXT INPUT IS PREPPED AT ALL. `--tts --text` and `--tts --input
 * passage.txt` are how a voice is auditioned, and e2a has no number transform of
 * its own any more — so a `.txt` that skipped this pass would audition a voice
 * on raw digits and call it the shipped pipeline.
 *
 * ── The model is INJECTED. Nothing here calls Ollama ────────────────────────
 *
 * Every test drives the pass with a scripted `generate`, including the ones that
 * go through the bridge's door, so the whole state space is reachable with no
 * GPU and no model loaded. Everything is written to a temp directory; nothing
 * here touches the library, the app's userData or the real e2a scratch.
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
// This suite loads the WHOLE bridge, because the door it tests IS on it — and the
// door is the app's own code path all the way down: the component system reads
// dist/electron/data at import time, and `loadNumberNormalizePrompt` reads
// dist/electron/prompts. `tsc` copies neither. Say which step is missing rather
// than failing inside a catalog loader or an ENOENT four frames down.
for (const [dir, file] of [['data', 'rvc-voice-assets.json'],
  ['prompts', 'tts-number-normalize.txt']]) {
  if (fs.existsSync(path.join(DIST, 'electron', dir, file))) continue;
  console.error(
    `dist/electron/${dir}/${file} is missing — this suite drives the real door, which reads it.\n`
    + '  npx tsc -p tsconfig.electron.json \\\n'
    + '    && npx shx cp -r electron/prompts dist/electron/ \\\n'
    + '    && npx shx cp -r electron/data dist/electron/');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-cli-prep-'));
// Set BEFORE anything from dist is loaded: managed-bins resolves its userData
// root at import time and refuses to guess one.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

// The same shim `node --require ./cli/electron-stub.js` installs for the real
// CLI — the bridge statically requires 'electron'. Loading it here is what makes
// this suite drive the ACTUAL exported door rather than a stand-in.
require(path.join(REPO, 'cli', 'electron-stub.js'));

const norm = require(path.join(DIST, 'electron', 'tts-number-normalizer.js'));
const { ZipWriter } = require(path.join(DIST, 'electron', 'epub-processor.js'));
const { openEpubSource } = require(path.join(DIST, 'electron', 'epub-container.js'));
const e2aPaths = require(path.join(DIST, 'electron', 'e2a-paths.js'));

// Every copy the door writes lands under <scratch>/narration-cuts. Pointed at
// the temp root so a keeper run never writes into the machine's real e2a tmp —
// and so the reuse assertions below are about THIS run's files.
const SCRATCH = path.join(ROOT, 'scratch');
e2aPaths.setE2aScratchDir(SCRATCH);
const CUTS = path.join(SCRATCH, 'narration-cuts');

const bridge = require(path.join(DIST, 'electron', 'parallel-tts-bridge.js'));

/**
 * The prompt, read from SOURCE rather than from dist — `npm run build:electron`
 * copies electron/prompts as a separate step, and the keeper runner requires
 * only a bare `tsc`.
 */
const PROMPT = fs.readFileSync(
  path.join(REPO, 'electron', 'prompts', 'tts-number-normalize.txt'), 'utf8').trim();

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// The scripted model — same shape as tools/test-tts-number-normalizer.js
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_HEAD = 'TARGET (edit ONLY this):\n';
function targetOf(input) {
  const start = input.indexOf(TARGET_HEAD);
  const end = input.indexOf('\n\nNEXT (context only');
  return input.slice(start + TARGET_HEAD.length, end);
}

/** A runner that answers from a table keyed by a substring of the TARGET block. */
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

let outDirs = 0;
const textOptions = (source, extra = {}) => ({
  systemPrompt: PROMPT,
  outDir: path.join(ROOT, `blocks-${outDirs++}`),
  source,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

test('blocks are the paragraphs, split on blank lines and nothing else', () => {
  assert.deepStrictEqual(norm.splitTextBlocks('one\ntwo\n\nthree\n'), ['one\ntwo', 'three']);
  // Windows line endings, and a run of blank lines, are the same two blocks.
  assert.deepStrictEqual(norm.splitTextBlocks('one\r\n\r\n\r\n  \r\ntwo\r\n'), ['one', 'two']);
  assert.deepStrictEqual(norm.splitTextBlocks('   \n\n  \n'), [], 'nothing but whitespace is no blocks');
});

// ─────────────────────────────────────────────────────────────────────────────
// The text-block pass, end to end
// ─────────────────────────────────────────────────────────────────────────────

// Each digit-bearing block carries a shape the RULES read (a date, a money
// amount) AND a bare four-digit quantity only the model can judge — so both
// halves of the pass run over the same three blocks.
const BLOCKS = [
  'On 23 March 1933 the Reichstag passed the Enabling Act, and 1200 members watched.',
  'A block with no numbers in it at all, long enough to be an ordinary paragraph.',
  'The pamphlet cost $5.50 and sold out by noon, all 1500 copies of it.',
];

test('the numbers in a text block are read as words, and the file is written', async () => {
  const runner = scriptedRunner({
    'the Reichstag': editsJson(['1200 members', 'twelve hundred members']),
    'The pamphlet cost': editsJson(['1500 copies', 'fifteen hundred copies']),
  });
  const out = await norm.normalizeTextBlocks(BLOCKS, runner, textOptions('passage.txt'));
  assert.ok(out !== null);
  assert.strictEqual(out.reused, false);
  assert.strictEqual(out.record.appliedSpans, 4, 'two by rules, two by the model');
  assert.strictEqual(out.record.appliedByRules, 2);
  assert.strictEqual(out.record.appliedByModel, 2);

  const text = fs.readFileSync(out.textPath, 'utf8');
  assert.ok(text.includes('On March twenty-third, nineteen thirty-three the Reichstag'), 'the date');
  assert.ok(text.includes('cost five dollars and fifty cents and sold out'), 'the money');
  assert.ok(text.includes('twelve hundred members') && text.includes('fifteen hundred copies'),
    'and the two the model was left to judge');
  assert.ok(text.includes('A block with no numbers in it at all'),
    'the digit-free block is carried through verbatim');
  assert.strictEqual(norm.splitTextBlocks(text).length, BLOCKS.length,
    'the same blocks, in the same order');
  assert.ok(runner.released, 'the model was released before the pass returned');
  assert.strictEqual(runner.calls.length, 2, 'only the two blocks with digits were asked about');
  assert.ok(out.textPath.endsWith('.norm.tts.txt'));
});

test('a refused edit leaves the printed digits, and the record names the refusal', async () => {
  const runner = scriptedRunner({
    // "Reichstag -> parliament" is prose tidying wearing a number edit's clothes,
    // and dropping "copies" renames the thing being counted.
    'the Reichstag': editsJson(['Reichstag', 'parliament']),
    'The pamphlet cost': editsJson(['1500 copies', 'fifteen hundred']),
  });
  const out = await norm.normalizeTextBlocks(BLOCKS, runner, textOptions('refusals.txt'));
  assert.strictEqual(out.record.appliedSpans, 2, 'the two by rule, and nothing the model said');
  assert.strictEqual(out.record.appliedByModel, 0);
  assert.deepStrictEqual(out.record.dispositions,
    { APPLIED_RULE: 2, NO_DIGIT_IN_FIND: 1, WORDS_DROPPED: 1 });

  const text = fs.readFileSync(out.textPath, 'utf8');
  assert.ok(text.includes('the Reichstag passed'), 'the prose was not renamed');
  assert.ok(text.includes('all 1500 copies'), 'and the refused digits stand');

  const record = JSON.parse(fs.readFileSync(out.recordPath, 'utf8'));
  const money = record.units.find((u) => u.text.includes('The pamphlet cost'));
  assert.strictEqual(money.kind, 'text-block');
  assert.strictEqual(money.file, 'refusals.txt');
  assert.deepStrictEqual(money.edits.map((e) => [e.status, e.detail]),
    [['APPLIED_RULE', 'money'], ['WORDS_DROPPED', undefined]],
    'the rule that read it is named, and so is the refusal');
});

test('a text with no digits comes back untouched, with no model call', async () => {
  const runner = scriptedRunner({});
  const out = await norm.normalizeTextBlocks(
    ['Nothing here but words.', 'And more of them.'], runner, textOptions('plain.txt'));
  assert.strictEqual(out, null, 'the pass reports nothing to do');
  assert.strictEqual(runner.calls.length, 0, 'and the model was never loaded');
});

test('a copy already on disk is REUSED, without calling the model', async () => {
  const answers = { 'The pamphlet cost': editsJson(['1500 copies', 'fifteen hundred copies']) };
  const outDir = path.join(ROOT, 'blocks-shared');
  const first = scriptedRunner(answers);
  const one = await norm.normalizeTextBlocks(BLOCKS, first, textOptions('reuse.txt', { outDir }));
  assert.ok(first.calls.length > 0);

  const second = scriptedRunner(answers);
  const two = await norm.normalizeTextBlocks(BLOCKS, second, textOptions('reuse.txt', { outDir }));
  assert.strictEqual(two.textPath, one.textPath, 'the same path');
  assert.strictEqual(two.reused, true);
  assert.strictEqual(second.calls.length, 0, 'and not one request went out');

  // Content-addressed on the BLOCKS: change a word and it is a different copy.
  const third = scriptedRunner(answers);
  const other = await norm.normalizeTextBlocks(
    [...BLOCKS.slice(0, 2), 'The pamphlet cost $5.50 and sold out by dusk, all 1500 copies of it.'],
    third, textOptions('reuse.txt', { outDir }));
  assert.notStrictEqual(other.textPath, one.textPath);
  assert.strictEqual(other.reused, false);
});

test('a record whose copy is missing its record is re-made — both halves or neither', async () => {
  const answers = { 'The pamphlet cost': editsJson(['1500 copies', 'fifteen hundred copies']) };
  const outDir = path.join(ROOT, 'blocks-halved');
  const first = scriptedRunner(answers);
  const one = await norm.normalizeTextBlocks(BLOCKS, first, textOptions('halved.txt', { outDir }));
  fs.unlinkSync(one.recordPath);

  const second = scriptedRunner(answers);
  const two = await norm.normalizeTextBlocks(BLOCKS, second, textOptions('halved.txt', { outDir }));
  assert.strictEqual(two.reused, false);
  assert.ok(second.calls.length > 0);
  assert.ok(fs.existsSync(two.recordPath));
});

test('an unreachable model THROWS, naming the model tag', async () => {
  const runner = scriptedRunner({}, { throws: 'connect ECONNREFUSED 127.0.0.1:11434' });
  await assert.rejects(
    norm.normalizeTextBlocks(BLOCKS, runner, textOptions('unreachable.txt')),
    (err) => {
      assert.ok(err.message.includes('fake:1b'), `names the model: ${err.message}`);
      assert.ok(err.message.includes('ECONNREFUSED'), 'and says what happened');
      return true;
    });
  assert.ok(runner.released, 'and the VRAM is given back on the way out');
});

test('a model that cannot answer in JSON fails the run, by name', async () => {
  // Twelve blocks so the >10% parse-failure share has a denominator; every answer
  // is garbage, which is a model this pass cannot use rather than a hard text.
  const blocks = Array.from({ length: 12 }, (unused, i) =>
    `Block ${i + 1}: on 2 March 19${10 + i} the council met and adjourned.`);
  const runner = scriptedRunner({});
  runner.generate = async (input) => { runner.calls.push(input); return 'I cannot help with that.'; };
  await assert.rejects(
    norm.normalizeTextBlocks(blocks, runner, textOptions('garbage.txt')),
    (err) => {
      assert.ok(err.message.includes('fake:1b'), 'the model is named');
      assert.ok(/failed to produce a usable edit list for \d+ of \d+/.test(err.message));
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE loop: a block and a paragraph are the same question
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

/** A book with NO digits anywhere but the one paragraph under test, so the pass
 *  asks exactly one question — the same one the text path asks. */
const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:sha256:cli-prep</dc:identifier>
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

const CHAPTER = (paragraph, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>One</title></head>
<body>
<h2 data-bf-cat="chapter">The Long Year</h2>
<p data-bf-cat="text">${paragraph}</p>
${extra}
</body>
</html>`;

async function buildBook(name, chapter) {
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

async function entryText(bookPath, entry) {
  const source = await openEpubSource(bookPath);
  try {
    return (await source.readEntry(entry)).toString('utf8');
  } finally {
    source.close();
  }
}

/** The one paragraph both paths are given, word for word. */
const SHARED_PARAGRAPH =
  'On 23 March 1933 the Reichstag met, 1200 members watched, and the pamphlet cost $5.50.';

/**
 * A runner that fails the FIRST request with a transport error and then answers
 * — one applied edit, one reaching into the span that edit took, one with no
 * digit in it.
 *
 * All three of those behaviours live in `askAboutEach`: the transport retry, the
 * validation wall, the release. If the two entry points had loops of their own,
 * this is where they would differ.
 */
function loopProbeRunner() {
  const runner = scriptedRunner({});
  let failed = false;
  runner.generate = async (input) => {
    runner.calls.push(input);
    if (!failed) { failed = true; throw new Error('fetch failed'); }
    return editsJson(
      ['1200 members', 'twelve hundred members'],
      ['1200', 'twelve hundred'],
      ['Reichstag', 'parliament']);
  };
  return runner;
}

test('a block and a paragraph go through the SAME loop, and answer the same', async () => {
  const blockRunner = loopProbeRunner();
  const blockTicks = [];
  const fromText = await norm.normalizeTextBlocks([SHARED_PARAGRAPH], blockRunner,
    textOptions('shared.txt', { onProgress: (done, total, label) => blockTicks.push({ done, total, label }) }));

  const book = await buildBook('shared.epub', CHAPTER(SHARED_PARAGRAPH));
  const bookRunner = loopProbeRunner();
  const bookTicks = [];
  const fromBook = await norm.normalizeNarrationNumbers(book, bookRunner, {
    systemPrompt: PROMPT,
    outDir: path.join(ROOT, 'shared-book'),
    onProgress: (done, total, label) => bookTicks.push({ done, total, label }),
  });

  // The dispositions are the loop's own product: the same text, the same model,
  // the same answers in the same order.
  const blockUnit = fromText.record.units[0];
  const bookUnit = fromBook.record.units.find((u) => u.text.includes('the Reichstag met'));
  assert.deepStrictEqual(blockUnit.edits, bookUnit.edits);
  assert.deepStrictEqual(blockUnit.edits.map((e) => e.status),
    ['APPLIED_RULE', 'APPLIED_RULE', 'APPLIED', 'OVERLAPS_APPLIED', 'NO_DIGIT_IN_FIND'],
    'the two rule edits lead the trail, then the model\'s three answers');
  assert.strictEqual(blockUnit.status, bookUnit.status);

  // The retry rule is the loop's too: one transport failure, one re-roll, two calls.
  assert.strictEqual(blockRunner.calls.length, 2);
  assert.strictEqual(bookRunner.calls.length, blockRunner.calls.length);

  // And so are the progress ticks and the release.
  assert.deepStrictEqual(blockTicks, bookTicks);
  assert.strictEqual(blockTicks[blockTicks.length - 1].label, 'Releasing model');
  assert.ok(blockRunner.released && bookRunner.released);

  // Same words out of both, in their own formats.
  const said = 'On March twenty-third, nineteen thirty-three the Reichstag met, twelve '
    + 'hundred members watched, and the pamphlet cost five dollars and fifty cents.';
  assert.ok(fs.readFileSync(fromText.textPath, 'utf8').includes(said));
  assert.ok((await entryText(fromBook.epubPath, 'OEBPS/chapter-01.xhtml')).includes(said));
});

// ─────────────────────────────────────────────────────────────────────────────
// The door the CLI actually calls
// ─────────────────────────────────────────────────────────────────────────────

test('the door export exists on the compiled bridge', () => {
  assert.strictEqual(typeof bridge.prepareNarrationInput, 'function',
    'the CLI adapters require this by name and say so when it is missing');
});

test('the door routes a .txt to the block pass — no cut, a .txt out', async () => {
  const input = path.join(ROOT, 'door.txt');
  fs.writeFileSync(input, `${SHARED_PARAGRAPH}\n\nA second block with no numbers.\n`, 'utf8');
  const runner = scriptedRunner({
    'the Reichstag met': editsJson(['1200 members', 'twelve hundred members']),
  });
  const prep = await bridge.prepareNarrationInput(input, 'test-txt', {
    skipAssembly: true, numberRunner: runner,
  });

  assert.ok(prep.inputPath.endsWith('.norm.tts.txt'), `a text copy: ${prep.inputPath}`);
  assert.strictEqual(path.dirname(prep.inputPath), CUTS,
    'written beside the book cuts, in the e2a scratch');
  assert.strictEqual(prep.appliedSpans, 3, 'the date and money by rule, the quantity by model');
  assert.strictEqual(prep.appliedByRules, 2);
  assert.strictEqual(prep.appliedByModel, 1);
  assert.strictEqual(prep.model, 'fake:1b');
  assert.strictEqual(prep.reused, false);
  assert.ok(prep.recordPath.endsWith('.edits.json'));
  assert.ok(fs.readFileSync(prep.inputPath, 'utf8').includes('March twenty-third'));
});

test('the door routes an .epub through the CUT and then the numbers', async () => {
  const book = await buildBook('door.epub', CHAPTER(
    SHARED_PARAGRAPH, '<p data-bf-cat="caption">Figure 7. The plate above.</p>'));
  const runner = scriptedRunner({
    'the Reichstag met': editsJson(['1200 members', 'twelve hundred members']),
  });
  const prep = await bridge.prepareNarrationInput(book, 'test-epub', {
    skipAssembly: true, numberRunner: runner,
  });

  assert.ok(prep.inputPath.endsWith('.norm.tts.epub'), `a book copy: ${prep.inputPath}`);
  assert.strictEqual(path.dirname(prep.inputPath), CUTS);
  const chapter = await entryText(prep.inputPath, 'OEBPS/chapter-01.xhtml');
  assert.ok(chapter.includes('March twenty-third, nineteen thirty-three'), 'the numbers ran');
  assert.ok(!chapter.includes('Figure 7'), 'and the caption was cut — which a .txt has none of');
  assert.ok(!runner.calls.some((c) => targetOf(c).includes('Figure 7')),
    'the caption was never offered to the model either');
});

test('the door reuses a copy on a second run, and says so', async () => {
  const input = path.join(ROOT, 'door-reuse.txt');
  fs.writeFileSync(input, `${SHARED_PARAGRAPH}\n`, 'utf8');
  const answers = {
    'the Reichstag met': editsJson(['1200 members', 'twelve hundred members']),
  };
  const first = scriptedRunner(answers);
  const one = await bridge.prepareNarrationInput(input, 'test-reuse-1', {
    skipAssembly: true, numberRunner: first,
  });
  const second = scriptedRunner(answers);
  const two = await bridge.prepareNarrationInput(input, 'test-reuse-2', {
    skipAssembly: true, numberRunner: second,
  });

  assert.strictEqual(two.inputPath, one.inputPath, 'the render reads the identical file');
  assert.strictEqual(two.reused, true, 'which is what the one line reports as "copy reused: yes"');
  assert.strictEqual(second.calls.length, 0, 'and the model was not asked again');
});

test('a digit-free input passes through untouched, with nothing written', async () => {
  const input = path.join(ROOT, 'door-plain.txt');
  fs.writeFileSync(input, 'Nothing here but words.\n\nAnd more of them.\n', 'utf8');
  const runner = scriptedRunner({});
  const prep = await bridge.prepareNarrationInput(input, 'test-plain', {
    skipAssembly: true, numberRunner: runner,
  });
  assert.strictEqual(prep.inputPath, input, 'the same file, same bytes');
  assert.strictEqual(prep.recordPath, null, 'which is what the one line reports as a pass-through');
  assert.strictEqual(prep.appliedSpans, 0);
  assert.deepStrictEqual(prep.dispositions, {});
  assert.strictEqual(runner.calls.length, 0);
});

test('a format the door cannot read is REFUSED by name, never skipped', async () => {
  const input = path.join(ROOT, 'door-unknown.pdf');
  fs.writeFileSync(input, '%PDF-1.4\n', 'utf8');
  await assert.rejects(
    bridge.prepareNarrationInput(input, 'test-unknown', { skipAssembly: true }),
    (err) => {
      assert.ok(err.message.includes('.pdf'), `names the format: ${err.message}`);
      assert.ok(err.message.includes('.epub') && err.message.includes('.txt'),
        'and says what it does read');
      return true;
    });
});

test('an unreachable model fails the DOOR too — no falling back to raw digits', async () => {
  const input = path.join(ROOT, 'door-unreachable.txt');
  // Content no earlier test prepped: the door's cache is shared across this whole
  // suite (one scratch dir, as it is on a machine), so reusing a prepped passage
  // here would answer out of the cache and never reach the model at all.
  // And a shape the RULES cannot finish (a bare four-digit quantity), or the pass
  // would settle it deterministically and never reach the model at all.
  fs.writeFileSync(input,
    'The council met on 4 July 1776 and 1300 delegates adjourned at dusk.\n', 'utf8');
  const runner = scriptedRunner({}, { throws: 'connect ECONNREFUSED 127.0.0.1:11434' });
  await assert.rejects(
    bridge.prepareNarrationInput(input, 'test-door-down', {
      skipAssembly: true, numberRunner: runner,
    }),
    (err) => {
      assert.ok(err.message.includes('fake:1b'), `names the model: ${err.message}`);
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The CLI wiring around the door
// ─────────────────────────────────────────────────────────────────────────────

test('the render adapters call the door before renderRangeHeadless, not instead of it', () => {
  for (const adapter of ['orpheus-batch-render.js', 'orpheus-audiobook-render.js']) {
    const source = fs.readFileSync(path.join(REPO, 'cli', adapter), 'utf8');
    assert.ok(source.includes("require('./narration-prep-step.js')"),
      `${adapter} calls the shared prep step`);
    assert.ok(source.includes('runNarrationPrep(bridge,'), `${adapter} runs it`);
    assert.ok(source.includes('renderRangeHeadless(prepared.inputPath'),
      `${adapter} hands the PREPARED path to the renderer`);
    assert.ok(!source.includes('normalizeNarrationNumbers') && !source.includes('normalizeTextBlocks'),
      `${adapter} reimplements no part of the door`);
  }
});

test('--prep is a registered command with a handler and an adapter', () => {
  const py = fs.readFileSync(path.join(REPO, 'cli', 'bookforge-tts.py'), 'utf8');
  assert.ok(/COMMANDS = \{[\s\S]*"prep": cmd_prep,/.test(py), 'registered');
  assert.ok(py.includes('def cmd_prep(args):'), 'and has its handler');
  assert.ok(py.includes('NARRATION_PREP = REPO_ROOT / "cli" / "narration-prep.js"'));
  assert.ok(fs.existsSync(path.join(REPO, 'cli', 'narration-prep.js')), 'the adapter exists');
  // The two "cleanup" commands stay distinct by name in the help text.
  assert.ok(py.includes('NOT --ai-cleanup'), 'and says which cleanup it is not');
});

test('both --prep and --audiobook resolve a project book through the SAME ladder', () => {
  for (const adapter of ['narration-prep.js', 'orpheus-audiobook-render.js']) {
    const source = fs.readFileSync(path.join(REPO, 'cli', adapter), 'utf8');
    assert.ok(source.includes("require('./resolve-project-epub.js')"),
      `${adapter} shares the resolver rather than copying the ladder`);
  }
  const { resolveInputEpub } = require(path.join(REPO, 'cli', 'resolve-project-epub.js'));
  const projectDir = path.join(ROOT, 'project');
  fs.mkdirSync(path.join(projectDir, 'source'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'stages', '01-cleanup'), { recursive: true });
  assert.strictEqual(resolveInputEpub(projectDir), null, 'a project with no book resolves to none');
  fs.writeFileSync(path.join(projectDir, 'source', 'original.epub'), 'x');
  assert.ok(resolveInputEpub(projectDir).endsWith(path.join('source', 'original.epub')));
  fs.writeFileSync(path.join(projectDir, 'stages', '01-cleanup', 'cleaned.epub'), 'x');
  assert.ok(resolveInputEpub(projectDir).endsWith(path.join('01-cleanup', 'cleaned.epub')),
    'the newest derivation wins, which is what the app calls "Latest"');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
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
