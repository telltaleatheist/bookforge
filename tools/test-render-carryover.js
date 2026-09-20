#!/usr/bin/env node
/**
 * CONTINUE FINISHES THE BOOK; IT DOES NOT START IT AGAIN.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-render-carryover.js
 *
 * The finding (Owen, 2026-09-20): *"the continue button on rendered sentences is
 * supposed to continue the render where it left off. finish the unrendered
 * sentences, keeping the ones that are done. it doesnt do that right now. it
 * starts over."*
 *
 * The resume road was never broken — it stopped being TAKEN. Every narration has
 * had a `prepare` row since 2026-09-19, `tts-conversion`'s cached-session resume
 * is gated on there being no prepare row in front of it (correctly: the chunks a
 * render is about are the ones its own parent packed), and so a Continue packed a
 * brand-new empty session and read the book from the beginning. The carry-over
 * therefore belongs to prep, and `electron/render-carryover.ts` owns it.
 *
 * What is pinned here is the rule and the act, because the failure mode on the
 * other side of the rule is the worse one: a rendered chunk is audio filed under
 * an INDEX, so carrying one into a run whose chunk #412 is different text would
 * put the wrong words at the wrong minute of the book and nothing downstream
 * could ever notice. Identical pack, identical voice, or nothing — and either
 * way, a sentence saying which.
 *
 * Real filesystem, temp dirs only. No bridge, no python, no network, no GPU.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'render-carryover.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
const {
  carryOverIntoSession,
  carryOverRefusal,
  countRenderedChunks,
  readSessionPackFacts,
  seedRenderedChunks,
  RESUME_MIN_BYTES,
} = require(path.join(DIST, 'render-carryover.js'));

let failures = 0;
const check = (name, fn) => {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.then(
      () => console.log(`  ok   ${name}`),
      (err) => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); });
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
  return Promise.resolve();
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-carryover-'));
const audio = (n) => Buffer.alloc(n, 7);

/** A session on disk, e2a-shaped: ebook-<id>/<hash>/{session-state.json,chapters/sentences}. */
function makeSession(root, name, opts) {
  const sessionDir = path.join(root, name);
  const processDir = path.join(sessionDir, 'abc123hash');
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');
  fs.mkdirSync(sentencesDir, { recursive: true });
  if (opts.state !== null) {
    fs.writeFileSync(path.join(processDir, 'session-state.json'), JSON.stringify({
      total_sentences: opts.chunks.length,
      // narrator writes one list per chapter; the readers flatten it.
      chapter_sentences: [opts.chunks.slice(0, 2), opts.chunks.slice(2)],
      tts_engine: opts.engine ?? 'higgs-v3',
      higgs_voice: opts.voice ?? 'mistborn',
      language: 'eng',
      language_iso1: opts.language ?? 'en',
    }, null, 2));
  }
  for (const [index, bytes] of Object.entries(opts.rendered ?? {})) {
    fs.writeFileSync(path.join(sentencesDir, `${index}.flac`), audio(bytes));
  }
  return { sessionDir, processDir, sentencesDir };
}

const FOUR = ['[heading]One.', 'Two two two.', 'Three three.', 'Four four four.'];

(async () => {
  console.log('render-carryover');

  // ── The rule, pure ───────────────────────────────────────────────────────
  const facts = (over) => Object.assign({
    totalChunks: 4, chunkTexts: FOUR.slice(), engine: 'higgs-v3', voice: 'mistborn', language: 'en',
  }, over);

  await check('an identical pack in the same voice carries', () => {
    assert.strictEqual(carryOverRefusal(facts(), facts()), null);
  });
  await check('a different voice refuses, naming both', () => {
    const why = carryOverRefusal(facts(), facts({ voice: 'deathstalker' }));
    assert.match(why, /mistborn/);
    assert.match(why, /deathstalker/);
    assert.match(why, /two voices/);
  });
  await check('a different engine refuses', () => {
    assert.match(carryOverRefusal(facts(), facts({ engine: 'orpheus' })), /orpheus/);
  });
  await check('a different language refuses', () => {
    assert.match(carryOverRefusal(facts(), facts({ language: 'de' })), /\bde\b/);
  });
  await check('a different chunk count refuses, naming both counts', () => {
    const why = carryOverRefusal(
      facts(), facts({ totalChunks: 5, chunkTexts: FOUR.concat(['Five.']) }));
    assert.match(why, /5 chunks/);
    assert.match(why, /packed into 4/);
  });
  await check('changed text refuses, naming the chunk', () => {
    const edited = FOUR.slice();
    edited[2] = 'Three three three.';
    const why = carryOverRefusal(facts(), facts({ chunkTexts: edited }));
    assert.match(why, /text has changed/);
    assert.match(why, /chunk 2 of 4/);
  });

  // ── Reading a session's facts ────────────────────────────────────────────
  await check('the facts come off session-state.json, flattened', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'facts-'));
    const s = makeSession(root, 'ebook-1', { chunks: FOUR });
    const read = await readSessionPackFacts(s.processDir);
    assert.strictEqual(read.totalChunks, 4);
    assert.deepStrictEqual(read.chunkTexts, FOUR);
    assert.strictEqual(read.voice, 'mistborn');
  });
  await check('an unreadable state throws, naming the file', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'nostate-'));
    const s = makeSession(root, 'ebook-1', { chunks: FOUR, state: null });
    await assert.rejects(() => readSessionPackFacts(s.processDir), /session-state\.json/);
  });

  // ── The seed ─────────────────────────────────────────────────────────────
  await check('the seed copies whole chunks, and only those', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'seed-'));
    const from = makeSession(root, 'ebook-from', {
      chunks: FOUR,
      rendered: { 0: 4096, 1: RESUME_MIN_BYTES, 3: 4096, 9: 4096 },
    });
    const to = makeSession(root, 'ebook-to', { chunks: FOUR, rendered: { 3: 2048 } });
    fs.writeFileSync(path.join(to.sentencesDir, '3.flac'), audio(2048));
    const n = await seedRenderedChunks(from.sentencesDir, to.sentencesDir, 4);
    assert.strictEqual(n, 1, 'only chunk 0: 1 is truncated, 3 exists already, 9 is out of range');
    assert.ok(fs.existsSync(path.join(to.sentencesDir, '0.flac')));
    assert.ok(!fs.existsSync(path.join(to.sentencesDir, '1.flac')), 'a truncated chunk re-renders');
    assert.ok(!fs.existsSync(path.join(to.sentencesDir, '9.flac')), 'out of range');
    assert.strictEqual(fs.statSync(path.join(to.sentencesDir, '3.flac')).size, 2048,
      "this run's own file is never overwritten");
  });
  await check('the count agrees with the seed about what is rendered', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'count-'));
    const s = makeSession(root, 'ebook-1', {
      chunks: FOUR, rendered: { 0: 4096, 1: 512, 2: 4096, 7: 4096 },
    });
    assert.strictEqual(await countRenderedChunks(s.sentencesDir, 4), 2);
    assert.strictEqual(await countRenderedChunks(path.join(root, 'nope'), 4), 0);
  });

  // ── The act ──────────────────────────────────────────────────────────────
  await check('a matching part-finished render is carried into the fresh session', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'act-'));
    const cache = makeSession(root, 'ebook-cached', {
      chunks: FOUR, rendered: { 0: 4096, 1: 4096, 2: 4096 },
    });
    const fresh = makeSession(root, 'ebook-fresh', { chunks: FOUR });
    const out = await carryOverIntoSession({
      cachedSessionDir: cache.sessionDir,
      freshProcessDir: fresh.processDir,
      freshSentencesDir: fresh.sentencesDir,
      totalChunks: 4,
    });
    assert.strictEqual(out.carried, 3);
    assert.match(out.line, /3 of 4 chunks were already rendered and are kept/);
    assert.strictEqual(await countRenderedChunks(fresh.sentencesDir, 4), 3,
      'the render now owes exactly one chunk');
  });
  await check('a re-voiced book carries nothing, and says why', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'voice-'));
    const cache = makeSession(root, 'ebook-cached', {
      chunks: FOUR, voice: 'mistborn', rendered: { 0: 4096, 1: 4096 },
    });
    const fresh = makeSession(root, 'ebook-fresh', { chunks: FOUR, voice: 'deathstalker' });
    const out = await carryOverIntoSession({
      cachedSessionDir: cache.sessionDir,
      freshProcessDir: fresh.processDir,
      freshSentencesDir: fresh.sentencesDir,
      totalChunks: 4,
    });
    assert.strictEqual(out.carried, 0);
    assert.match(out.line, /two voices/);
    assert.match(out.line, /read from the beginning/);
    assert.strictEqual(await countRenderedChunks(fresh.sentencesDir, 4), 0);
  });
  await check('an edited book carries nothing, and names the chunk', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'edit-'));
    const edited = FOUR.slice();
    edited[1] = 'Two two two, revised.';
    const cache = makeSession(root, 'ebook-cached', {
      chunks: FOUR, rendered: { 0: 4096, 1: 4096 },
    });
    const fresh = makeSession(root, 'ebook-fresh', { chunks: edited });
    const out = await carryOverIntoSession({
      cachedSessionDir: cache.sessionDir,
      freshProcessDir: fresh.processDir,
      freshSentencesDir: fresh.sentencesDir,
      totalChunks: 4,
    });
    assert.strictEqual(out.carried, 0);
    assert.match(out.line, /chunk 1 of 4/);
  });
  await check('a cache that cannot be compared is a sentence, not a throw', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'broken-'));
    const cache = makeSession(root, 'ebook-cached', {
      chunks: FOUR, state: null, rendered: { 0: 4096 },
    });
    const fresh = makeSession(root, 'ebook-fresh', { chunks: FOUR });
    const out = await carryOverIntoSession({
      cachedSessionDir: cache.sessionDir,
      freshProcessDir: fresh.processDir,
      freshSentencesDir: fresh.sentencesDir,
      totalChunks: 4,
    });
    assert.strictEqual(out.carried, 0);
    assert.match(out.line, /could not be compared/);
  });
  await check('a cache with no sentences dir is a sentence, not a throw', async () => {
    const root = fs.mkdtempSync(path.join(tmpRoot, 'empty-'));
    const cacheDir = path.join(root, 'ebook-cached');
    fs.mkdirSync(cacheDir, { recursive: true });
    const fresh = makeSession(root, 'ebook-fresh', { chunks: FOUR });
    const out = await carryOverIntoSession({
      cachedSessionDir: cacheDir,
      freshProcessDir: fresh.processDir,
      freshSentencesDir: fresh.sentencesDir,
      totalChunks: 4,
    });
    assert.strictEqual(out.carried, 0);
    assert.match(out.line, /no chapters\/sentences/);
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
})();
