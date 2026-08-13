#!/usr/bin/env node
/**
 * Tests for the simplify BLOCK-GROUP pipeline — the pass that replaced 8,000-char
 * prose chunking for simplify-only.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-simplify-blocks.js
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * The chunk pipeline re-segmented the model's prose back onto elements with
 * heuristics, and it died on its own edges: a title-page line like "BLACK SUN"
 * became a chunk whose num_predict was `text.length * 2` — 18 tokens — while the
 * simplify prompt turns the model's in-band reasoning ON, so every heading-shaped
 * chunk was a guaranteed REASONING_OVERRUN. An absolute 10-fallback threshold
 * then aborted a 308-unit book at ~3% failures.
 *
 * The replacement makes the answer's SHAPE the thing that has to be right, and
 * everything asserted here is that shape holding:
 *
 *  - a heading and a two-word line are never sent, so they cannot fail;
 *  - a group is a whole number of consecutive blocks, never a character budget
 *    cut through one, and never spans a heading;
 *  - an answer whose ids do not match what was sent is REJECTED WHOLE — no
 *    partial credit, no repaired alignment. That guess is the class of bug this
 *    path exists to remove;
 *  - one bad block costs one block, not the three around it;
 *  - the writer replaces text in place, so element identity (`data-bf-uid`),
 *    heading bytes and inline markup on untouched blocks all survive by
 *    construction, and a count disagreement THROWS rather than writing as many
 *    as happen to fit.
 *
 * No model is involved: the one call is injected, so every ladder branch is
 * driven by a scripted answer.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'ai-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// ai-bridge statically requires 'electron' for the power blocker; the CLI's own
// shim answers it, so the module under test loads exactly as it does headless.
require('../cli/electron-stub.js');

// It also loads its prompt files on import and calls a missing one FATAL, which
// `npm run build:electron` copies into dist and a bare `npx tsc` does not.
const PROMPTS = path.join(DIST, 'electron', 'prompts');
if (!fs.existsSync(PROMPTS)) {
  fs.cpSync(path.join(REPO, 'electron', 'prompts'), PROMPTS, { recursive: true });
}

const {
  MIN_SIMPLIFY_BLOCK_CHARS,
  MAX_BLOCKS_PER_GROUP,
  GROUP_CHAR_CAP,
  SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR,
  isSendableSimplifyBlock,
  groupSimplifyBlocks,
  serializeBlocksForModel,
  parseBlockAnswer,
  judgeBlockRewrite,
  simplifyBlockNumPredict,
  simplifyBlockGroup,
  simplifyChapterBlocks,
  planChapterBlockGroups,
  newCleanupJobState,
  checkFallbackThreshold,
} = require(path.join(DIST, 'electron', 'ai-bridge.js'));
const {
  extractBlockTextsWithTags,
  replaceBlockTextsExact,
} = require(path.join(DIST, 'electron', 'epub-processor.js'));

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Exactly `n` characters of prose whose sentences are all DIFFERENT — a repeated
 * sentence would trip the repetition guard, which is a real check, not a fixture
 * artefact. Ends on a full stop so `.trim()` cannot shorten it.
 */
function prose(n, seed = 'a') {
  let out = '';
  let i = 0;
  while (out.length < n) {
    i++;
    out += `In the ${seed}${i} hour the travellers argued about the weather and the road ahead. `;
  }
  return out.slice(0, n - 1) + '.';
}

const block = (text, tagName = 'p') => ({ text, tagName, attrs: {} });

/** Wrap an answer body the way extractAnswer hands it over (tags already stripped). */
const answerOf = (...blocks) =>
  blocks.map(([id, text]) => `<block id="${id}">${text}</block>`).join('\n\n');

// ── 1. Grouping ─────────────────────────────────────────────────────────────

test('headings are never sendable, whatever their length', () => {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.strictEqual(isSendableSimplifyBlock(block(prose(900), tag)), false, tag);
  }
  assert.strictEqual(isSendableSimplifyBlock(block(prose(900), 'p')), true);
});

test('a block under MIN_SIMPLIFY_BLOCK_CHARS is never sent', () => {
  assert.strictEqual(MIN_SIMPLIFY_BLOCK_CHARS, 50);
  // "BLACK SUN" — the title-page line that used to become its own doomed chunk.
  assert.strictEqual(isSendableSimplifyBlock(block('BLACK SUN', 'p')), false);
  assert.strictEqual(isSendableSimplifyBlock(block('x'.repeat(49), 'p')), false);
  assert.strictEqual(isSendableSimplifyBlock(block('x'.repeat(50), 'p')), true);
});

test('a heading terminates the run — a group never spans one', () => {
  const blocks = [
    block(prose(200, 'a')),
    block(prose(200, 'b')),
    block('Chapter Two', 'h2'),
    block(prose(200, 'c')),
  ];
  const groups = groupSimplifyBlocks(blocks);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups[0].blocks.map(b => b.index), [0, 1]);
  assert.deepStrictEqual(groups[1].blocks.map(b => b.index), [3]);
});

test('a short block terminates the run just as a heading does', () => {
  const blocks = [
    block(prose(200, 'a')),
    block('HEIL HITLER!'),       // too short to send, so it breaks the run
    block(prose(200, 'b')),
  ];
  const groups = groupSimplifyBlocks(blocks);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups[0].blocks.map(b => b.index), [0]);
  assert.deepStrictEqual(groups[1].blocks.map(b => b.index), [2]);
});

test('groups cap at MAX_BLOCKS_PER_GROUP blocks', () => {
  assert.strictEqual(MAX_BLOCKS_PER_GROUP, 3);
  const blocks = Array.from({ length: 7 }, (_, i) => block(prose(100, String.fromCharCode(97 + i))));
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.map(b => b.index)), [[0, 1, 2], [3, 4, 5], [6]]);
});

test('groups cap at GROUP_CHAR_CAP characters', () => {
  assert.strictEqual(GROUP_CHAR_CAP, 4000);
  // 2500 + 2500 would be 5000 — over the cap, so they cannot share a group.
  const blocks = [block(prose(2500, 'a')), block(prose(2500, 'b')), block(prose(300, 'c'))];
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.map(b => b.index)), [[0], [1, 2]]);
});

test('a block bigger than the cap forms a group ALONE — blocks are never split', () => {
  const blocks = [block(prose(120, 'a')), block(prose(9000, 'b')), block(prose(120, 'c'))];
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.map(b => b.index)), [[0], [1], [2]]);
  assert.strictEqual(groups[1].blocks[0].text.length, 9000, 'the oversized block travels whole');
});

test('a chapter of nothing but headings and stubs produces NO groups at all', () => {
  const groups = groupSimplifyBlocks([
    block('BLACK SUN', 'h1'),
    block('A Novel'),
    block('by Someone'),
  ]);
  assert.deepStrictEqual(groups, []);
});

// ── 2. Answer parsing ───────────────────────────────────────────────────────

test('happy path: ids in order come back in order, trimmed', () => {
  const got = parseBlockAnswer(answerOf([1, '\n  first  \n'], [2, 'second'], [3, 'third']), 3);
  assert.deepStrictEqual(got, ['first', 'second', 'third']);
});

test('ids out of order are reordered by id, not by position', () => {
  const got = parseBlockAnswer(answerOf([2, 'second'], [1, 'first']), 2);
  assert.deepStrictEqual(got, ['first', 'second']);
});

test('a missing id rejects the whole answer', () => {
  assert.throws(
    () => parseBlockAnswer(answerOf([1, 'first'], [3, 'third']), 3),
    /MALFORMED_BLOCK_ANSWER.*missing id 2/
  );
});

test('a duplicate id rejects the whole answer', () => {
  assert.throws(
    () => parseBlockAnswer(answerOf([1, 'first'], [1, 'again'], [2, 'second']), 2),
    /MALFORMED_BLOCK_ANSWER: duplicate block id 1/
  );
});

test('an id that was never sent rejects the whole answer', () => {
  assert.throws(
    () => parseBlockAnswer(answerOf([1, 'first'], [2, 'second'], [4, 'invented']), 2),
    /MALFORMED_BLOCK_ANSWER: block id 4 was never sent/
  );
});

test('prose outside the block tags rejects the whole answer', () => {
  assert.throws(
    () => parseBlockAnswer(`Here are your rewritten blocks:\n${answerOf([1, 'first'])}`, 1),
    /MALFORMED_BLOCK_ANSWER: non-whitespace text outside the block tags/
  );
  assert.throws(
    () => parseBlockAnswer(`${answerOf([1, 'first'])}\nLet me know if you want changes.`, 1),
    /MALFORMED_BLOCK_ANSWER: non-whitespace text after the last block tag/
  );
  assert.throws(
    () => parseBlockAnswer(`${answerOf([1, 'a'])}\nand then\n${answerOf([2, 'b'])}`, 2),
    /MALFORMED_BLOCK_ANSWER: non-whitespace text outside the block tags/
  );
});

test('whitespace between and around the tags is fine', () => {
  const got = parseBlockAnswer(`\n\n  ${answerOf([1, 'a'], [2, 'b'])}  \n\n`, 2);
  assert.deepStrictEqual(got, ['a', 'b']);
});

test('a merged answer (one block for two inputs) is rejected, never stretched', () => {
  assert.throws(() => parseBlockAnswer(answerOf([1, 'both paragraphs at once']), 2), /MALFORMED_BLOCK_ANSWER/);
});

test('serialization is 1-based within the call, whatever the chapter indices', () => {
  const payload = serializeBlocksForModel(['alpha', 'beta']);
  assert.match(payload, /<block id="1">\nalpha\n<\/block>/);
  assert.match(payload, /<block id="2">\nbeta\n<\/block>/);
  // What is serialized must parse back: the two halves of the contract agree.
  assert.deepStrictEqual(parseBlockAnswer(payload, 2), ['alpha', 'beta']);
});

// ── 3. Per-block verdicts and the num_predict floor ─────────────────────────

test('[SKIP] keeps the original and is NOT a failure', () => {
  const v = judgeBlockRewrite(prose(300), '[SKIP]');
  assert.strictEqual(v.accept, false);
  assert.strictEqual(v.reason, 'skip-marker');
});

test('under 40% of the input is catastrophic loss — rejected', () => {
  const original = prose(1000);
  assert.strictEqual(judgeBlockRewrite(original, prose(399)).reason, 'acceptance-gate');
  assert.strictEqual(judgeBlockRewrite(original, prose(401)).accept, true);
});

test('a repetition loop is rejected even though it is LONGER than the input', () => {
  const original = prose(400);
  const loop = ('The room was very quiet indeed that evening. ').repeat(12);
  assert.ok(loop.length > original.length);
  assert.strictEqual(judgeBlockRewrite(original, loop).reason, 'repetition');
});

test('num_predict floors at 4096 and scales past it', () => {
  assert.strictEqual(SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR, 4096);
  // The starvation case: a tiny payload used to budget text.length * 2 tokens.
  assert.strictEqual(simplifyBlockNumPredict('BLACK SUN'), 4096);
  assert.strictEqual(simplifyBlockNumPredict('x'.repeat(3000)), 6000);
});

// ── 4. The group ladder ─────────────────────────────────────────────────────

/** Records every payload a run sent, so "did it degrade?" is observable. */
function scriptedCall(answers) {
  const sent = [];
  const call = async (payload, numPredict) => {
    sent.push({ payload, numPredict });
    const next = answers.shift();
    if (next === undefined) throw new Error('scriptedCall: ran out of scripted answers');
    if (next instanceof Error) throw next;
    return next;
  };
  call.sent = sent;
  return call;
}

const groupOf = (...texts) => ({ blocks: texts.map((text, i) => ({ index: i, text })) });

test('a clean group answer rewrites all three blocks and costs nothing', async () => {
  const g = groupOf(prose(300, 'a'), prose(300, 'b'), prose(300, 'c'));
  const call = scriptedCall([answerOf([1, prose(280, 'x')], [2, prose(280, 'y')], [3, prose(280, 'z')])]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 9 });

  assert.strictEqual(call.sent.length, 1, 'one call for the whole group');
  assert.deepStrictEqual(out, [prose(280, 'x'), prose(280, 'y'), prose(280, 'z')]);
  assert.deepStrictEqual(state.skippedChunks, []);
  assert.strictEqual(state.truncatedFallbackCount + state.errorFallbackCount, 0);
});

test('ONE short block in a group of three costs one block, not the group', async () => {
  const g = groupOf(prose(1000, 'a'), prose(1000, 'b'), prose(1000, 'c'));
  const call = scriptedCall([
    answerOf([1, prose(900, 'x')], [2, 'gone.'], [3, prose(900, 'z')]),
  ]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 4, totalChunks: 9 });

  assert.strictEqual(out[0], prose(900, 'x'), 'block 1 took its rewrite');
  assert.strictEqual(out[1], prose(1000, 'b'), 'block 2 kept its ORIGINAL');
  assert.strictEqual(out[2], prose(900, 'z'), 'block 3 took its rewrite');
  assert.strictEqual(state.truncatedFallbackCount, 1, 'exactly one fallback');
  assert.strictEqual(state.skippedChunks.length, 1);
  assert.deepStrictEqual(
    {
      reason: state.skippedChunks[0].reason,
      chunkIndex: state.skippedChunks[0].chunkIndex,
      overall: state.skippedChunks[0].overallChunkNumber,
      total: state.skippedChunks[0].totalChunks,
      text: state.skippedChunks[0].text,
      ai: state.skippedChunks[0].aiResponse,
    },
    { reason: 'acceptance-gate', chunkIndex: 1, overall: 4, total: 9, text: prose(1000, 'b'), ai: 'gone.' },
    'the record names the BLOCK, inside the group\'s job-wide number'
  );
});

test('a [SKIP] block keeps its original and costs no counter', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'));
  const call = scriptedCall([answerOf([1, prose(380, 'x')], [2, '[SKIP]'])]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 1 });

  assert.strictEqual(out[1], prose(400, 'b'));
  assert.deepStrictEqual(state.skippedChunks, []);
  assert.strictEqual(state.truncatedFallbackCount + state.errorFallbackCount, 0);
});

test('a malformed group answer degrades to singles — it is NOT re-rolled as a group', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'), prose(400, 'c'));
  const call = scriptedCall([
    answerOf([1, 'only one block came back']),        // malformed for a group of 3
    answerOf([1, prose(380, 'x')]),
    answerOf([1, prose(380, 'y')]),
    answerOf([1, prose(380, 'z')]),
  ]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 2, totalChunks: 5 });

  assert.strictEqual(call.sent.length, 4, 'one group call, then one call per block');
  for (let i = 1; i < 4; i++) {
    assert.strictEqual((call.sent[i].payload.match(/<block id=/g) || []).length, 1, 'each degraded call carries ONE block');
  }
  assert.deepStrictEqual(out, [prose(380, 'x'), prose(380, 'y'), prose(380, 'z')]);
  assert.deepStrictEqual(state.skippedChunks, [], 'the degrade rescued every block');
});

test('a group REASONING_OVERRUN degrades to singles', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'));
  const call = scriptedCall([
    new Error("REASONING_OVERRUN: model 'cogito:14b' emitted an unterminated <think> block"),
    answerOf([1, prose(380, 'x')]),
    answerOf([1, prose(380, 'y')]),
  ]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 1 });

  assert.strictEqual(call.sent.length, 3);
  assert.deepStrictEqual(out, [prose(380, 'x'), prose(380, 'y')]);
});

test('a single-block call that overruns keeps that block, once, with its reason', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'));
  const call = scriptedCall([
    new Error('REASONING_OVERRUN: no answer produced'),   // the group
    new Error('REASONING_OVERRUN: no answer produced'),   // block 1 alone
    answerOf([1, prose(380, 'y')]),                       // block 2 alone
  ]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 7, totalChunks: 7 });

  assert.strictEqual(out[0], prose(400, 'a'), 'the overrun block kept its original');
  assert.strictEqual(out[1], prose(380, 'y'));
  assert.strictEqual(state.errorFallbackCount, 1, 'ONE increment for ONE failed block');
  assert.strictEqual(state.skippedChunks.length, 1);
  assert.strictEqual(state.skippedChunks[0].reason, 'reasoning-overrun');
  assert.strictEqual(state.skippedChunks[0].chunkIndex, 0);
});

test('a group of ONE goes straight to the single call — no wasted group attempt', async () => {
  const g = groupOf(prose(5000, 'a'));
  const call = scriptedCall([answerOf([1, prose(4000, 'x')])]);
  const state = newCleanupJobState();
  const out = await simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 1 });
  assert.strictEqual(call.sent.length, 1);
  assert.deepStrictEqual(out, [prose(4000, 'x')]);
});

test('a dead-account error stops the job — it is never absorbed as a fallback', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'));
  const call = scriptedCall([new Error('Your credit balance is too low')]);
  const state = newCleanupJobState();
  await assert.rejects(
    () => simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 1 }),
    /credit balance/
  );
  assert.strictEqual(call.sent.length, 1, 'no degrade, no per-block retries');
  assert.deepStrictEqual(state.skippedChunks, []);
});

test('cancellation propagates out of the singles loop', async () => {
  const g = groupOf(prose(400, 'a'), prose(400, 'b'));
  const call = scriptedCall([new Error('MALFORMED'), new Error('Job cancelled')]);
  const state = newCleanupJobState();
  await assert.rejects(
    () => simplifyBlockGroup(g, call, state, { chapterTitle: 'One', overallChunkNumber: 1, totalChunks: 1 }),
    /Job cancelled/
  );
});

// ── 5. Proportional fallback threshold ──────────────────────────────────────

test('the abort threshold lives on the job, and defaults to the old flat 10', () => {
  const state = newCleanupJobState();
  assert.strictEqual(state.maxFallbackCount, 10);
  state.errorFallbackCount = 9;
  checkFallbackThreshold(state);   // 9 < 10 — still running
  state.errorFallbackCount = 10;
  assert.throws(() => checkFallbackThreshold(state), /TOO_MANY_FALLBACKS: 10 .*threshold: 10/);
});

test('a raised threshold lets a big job survive what killed the 308-chunk run', () => {
  const state = newCleanupJobState();
  state.maxFallbackCount = Math.max(10, Math.ceil(308 * 0.05));   // 16
  state.errorFallbackCount = 10;
  checkFallbackThreshold(state);   // the old constant would have aborted here
  state.errorFallbackCount = 16;
  assert.throws(() => checkFallbackThreshold(state), /threshold: 16/);
});

// ── 6. The writer ───────────────────────────────────────────────────────────

const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>
<p data-bf-uid="u-p1" data-bf-cat="body">${prose(150, 'a')}</p>
<p data-bf-uid="u-p2" data-bf-cat="body">A <em>very</em> emphatic paragraph that is comfortably long enough to be sent.</p>
<p data-bf-uid="u-p3">HEIL HITLER!</p>
<p data-bf-uid="u-p4" data-bf-user-cat="body">${prose(150, 'b')}</p>
</body></html>`;

test('replaceBlockTextsExact writes in place: uids, classes and headings survive', () => {
  const blocks = extractBlockTextsWithTags(CHAPTER);
  assert.strictEqual(blocks.length, 5);
  const out = replaceBlockTextsExact(CHAPTER, [null, 'REWRITTEN ONE', null, null, 'REWRITTEN FOUR']);

  assert.ok(out.includes('<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>'), 'the heading is byte-identical');
  assert.ok(out.includes('<p data-bf-uid="u-p1" data-bf-cat="body">REWRITTEN ONE</p>'), 'rewrite kept every attribute');
  assert.ok(out.includes('data-bf-user-cat="body">REWRITTEN FOUR</p>'), 'the user category survived');
  for (const uid of ['u-h1', 'u-p1', 'u-p2', 'u-p3', 'u-p4']) {
    assert.ok(out.includes(`data-bf-uid="${uid}"`), `${uid} still identifies its element`);
  }
});

test('a null entry is NOT WRITING — inline markup survives it', () => {
  const out = replaceBlockTextsExact(CHAPTER, [null, null, null, null, null]);
  assert.ok(out.includes('A <em>very</em> emphatic paragraph'), 'the <em> is untouched');
  assert.strictEqual(out, replaceBlockTextsExact(CHAPTER, [null, null, null, null, null]), 'and it is stable');
});

test('a rewrite flattens inline markup in ITS block only', () => {
  const out = replaceBlockTextsExact(CHAPTER, [null, null, 'Plain now.', null, null]);
  assert.ok(!out.includes('<em>'), 'the rewritten block lost its <em> (as the old rebuild did to every block)');
  assert.ok(out.includes('<p data-bf-uid="u-p2" data-bf-cat="body">Plain now.</p>'));
});

test('the writer escapes text rather than injecting markup', () => {
  const out = replaceBlockTextsExact(CHAPTER, [null, 'a < b & c', null, null, null]);
  assert.ok(out.includes('a &lt; b &amp; c'));
});

test('a count mismatch THROWS with both counts — it never writes as many as fit', () => {
  assert.throws(
    () => replaceBlockTextsExact(CHAPTER, [null, 'one', null]),
    /block count mismatch — document has 5 non-empty block elements, caller supplied 3/
  );
  assert.throws(() => replaceBlockTextsExact(CHAPTER, new Array(6).fill(null)), /supplied 6/);
});

// ── 7. End to end over a chapter ────────────────────────────────────────────

test('a whole chapter: headings byte-identical, uids intact, rewrites in place', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  assert.deepStrictEqual(
    plan.blocks.map(b => b.tagName),
    ['h1', 'p', 'p', 'p', 'p'],
    'the block list is the chapter in document order'
  );
  // h1 (never sent) | p1+p2 | "HEIL HITLER!" (too short) | p4
  assert.deepStrictEqual(plan.groups.map(g => g.blocks.map(b => b.index)), [[1, 2], [4]]);

  const call = scriptedCall([
    answerOf([1, 'The first paragraph, rewritten so a child can follow it easily.'],
             [2, 'A very emphatic paragraph, rewritten just as plainly as the first one was.']),
    answerOf([1, 'The last paragraph, rewritten to be shorter but still complete enough.']),
  ]);
  const state = newCleanupJobState();
  const seen = [];

  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER,
    plan,
    groups: plan.groups,
    chapterTitle: 'BLACK SUN',
    call,
    state,
    firstGroupNumber: 1,
    totalGroupsInJob: 2,
    beforeGroup: (n, chars) => seen.push(`start ${n} (${chars} chars)`),
    afterGroup: (n) => seen.push(`done ${n}`),
  });

  assert.deepStrictEqual(seen, [
    `start 1 (${plan.blocks[1].text.length + plan.blocks[2].text.length} chars)`,
    'done 1',
    `start 2 (${plan.blocks[4].text.length} chars)`,
    'done 2',
  ], 'progress fires once before and once after each group, in job-wide numbering');

  // The heading and the stub were never sent, so they come out untouched.
  assert.ok(out.includes('<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>'));
  assert.ok(out.includes('<p data-bf-uid="u-p3">HEIL HITLER!</p>'));
  // Element enumeration is unchanged — same count, same uids, same order.
  const after = extractBlockTextsWithTags(out);
  assert.strictEqual(after.length, plan.blocks.length);
  assert.deepStrictEqual(after.map(b => b.attrs['data-bf-uid']), ['u-h1', 'u-p1', 'u-p2', 'u-p3', 'u-p4']);
  assert.deepStrictEqual(after.map(b => b.tagName), ['h1', 'p', 'p', 'p', 'p']);
  // And the rewrites landed on their own elements.
  assert.strictEqual(after[1].text, 'The first paragraph, rewritten so a child can follow it easily.');
  assert.strictEqual(after[2].text, 'A very emphatic paragraph, rewritten just as plainly as the first one was.');
  assert.strictEqual(after[4].text, 'The last paragraph, rewritten to be shorter but still complete enough.');
  assert.deepStrictEqual(state.skippedChunks, []);
});

test('a chapter whose model gives nothing usable comes back BYTE-IDENTICAL', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  const call = scriptedCall([
    new Error('REASONING_OVERRUN: no answer'),   // group 1
    new Error('REASONING_OVERRUN: no answer'),   // block 1 alone
    new Error('REASONING_OVERRUN: no answer'),   // block 2 alone
    new Error('REASONING_OVERRUN: no answer'),   // group 2 (a single, so one call)
  ]);
  const state = newCleanupJobState();
  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER, plan, groups: plan.groups, chapterTitle: 'BLACK SUN',
    call, state, firstGroupNumber: 1, totalGroupsInJob: 2,
  });

  assert.strictEqual(out, CHAPTER, 'nothing was written, so nothing changed');
  assert.strictEqual(state.errorFallbackCount, 3, 'one per failed BLOCK');
  assert.deepStrictEqual(state.skippedChunks.map(s => s.chunkIndex), [1, 2, 4], 'recorded by block index');
});

test('groups test mode cut off leave their blocks untouched, not "processed"', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  const call = scriptedCall([answerOf([1, 'Rewritten one, and comfortably long enough to clear the acceptance gate.'],
                                      [2, 'Rewritten two, also comfortably long enough to clear the gate.'])]);
  const state = newCleanupJobState();
  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER, plan,
    groups: plan.groups.slice(0, 1),   // testModeChunks = 1
    chapterTitle: 'BLACK SUN', call, state, firstGroupNumber: 1, totalGroupsInJob: 1,
  });
  const after = extractBlockTextsWithTags(out);
  assert.strictEqual(after[1].text, 'Rewritten one, and comfortably long enough to clear the acceptance gate.');
  assert.strictEqual(after[4].text, plan.blocks[4].text, 'the untouched group kept its original text');
  assert.strictEqual(call.sent.length, 1);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (e) {
      failures.push({ name, e });
      console.log(`FAIL  ${name}`);
      console.log(`      ${e && e.message}`);
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failing:`);
    for (const f of failures) console.error(`  - ${f.name}\n${f.e && f.e.stack}`);
    process.exit(1);
  }
})();
