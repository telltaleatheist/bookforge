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
 *  - a heading is never sent, so it cannot fail, and a group whose WHOLE text is
 *    a title page's three short lines is kept verbatim without a call;
 *  - a short block is NOT excluded on its own. `"No," she said.` is its own <p>
 *    in fiction and has to be simplified alongside the paragraph it answers, so
 *    it rides inside its group and the send decision is made per GROUP;
 *  - a group is a whole number of consecutive blocks, never a character budget
 *    cut through one, and never spans a heading;
 *  - an answer whose ids do not match what was sent is REJECTED WHOLE — no
 *    partial credit, no repaired alignment. That guess is the class of bug this
 *    path exists to remove;
 *  - one bad block costs one block, not the three around it;
 *  - the writer replaces text in place, so element identity (`data-bf-uid`),
 *    headings and inline markup on untouched blocks all survive by construction,
 *    and a count disagreement THROWS rather than writing as many as happen to
 *    fit. (The XML serializer respells `"` as `&quot;` on the way out — the same
 *    XML said differently; there is a test for exactly that, so the difference
 *    stays a known one rather than a surprise.)
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
  MAX_BLOCKS_PER_GROUP,
  GROUP_CHAR_CAP,
  MIN_GROUP_SEND_CHARS,
  GATE_MIN_INPUT_CHARS,
  SIMPLIFY_BLOCK_NUM_PREDICT_FLOOR,
  isSimplifyHeadingBlock,
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

test('headings are the ONE categorical exclusion', () => {
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.strictEqual(isSimplifyHeadingBlock(block(prose(900), tag)), true, tag);
  }
  for (const tag of ['p', 'li', 'blockquote', 'figcaption']) {
    assert.strictEqual(isSimplifyHeadingBlock(block('x', tag)), false, tag);
  }
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

test('a SHORT block rides along inside its group — it does NOT break the run', () => {
  // The revision that matters: a line of dialogue is its own <p>, and it must be
  // simplified WITH the paragraph it answers, not stranded and skipped.
  const blocks = [
    block(prose(200, 'a')),
    block('"No," she said.'),
    block(prose(200, 'b')),
  ];
  const groups = groupSimplifyBlocks(blocks);
  assert.strictEqual(groups.length, 1, 'one group, not three');
  assert.deepStrictEqual(groups[0].blocks.map(b => b.index), [0, 1, 2]);
  assert.strictEqual(groups[0].send, true);
});

test('a whole exchange of short dialogue lines packs into ONE group', () => {
  const lines = [
    '"No," she said, and would not look at him.',
    '"Then say what you mean."',
    '"Why not ask her yourself?"',
    'He shrugged, and said nothing at all.',
    '"Because she lies," he said.',
  ];
  const groups = groupSimplifyBlocks(lines.map(t => block(t)));
  assert.strictEqual(groups.length, 1, 'five <p> elements, one call');
  assert.deepStrictEqual(groups[0].blocks.map(b => b.text), lines);
  assert.strictEqual(groups[0].send, true, 'together they clear MIN_GROUP_SEND_CHARS');
  // Each line on its own would have been well under the threshold.
  for (const line of lines) assert.ok(line.length < MIN_GROUP_SEND_CHARS);
});

test('groups cap at MAX_BLOCKS_PER_GROUP blocks', () => {
  assert.strictEqual(MAX_BLOCKS_PER_GROUP, 8);
  const blocks = Array.from({ length: 17 }, (_, i) => block(prose(100, String.fromCharCode(97 + i))));
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.length), [8, 8, 1]);
  assert.deepStrictEqual(groups[2].blocks.map(b => b.index), [16]);
});

test('groups cap at GROUP_CHAR_CAP characters', () => {
  assert.strictEqual(GROUP_CHAR_CAP, 4000);
  // 2500 + 2500 would be 5000 — over the cap, so they cannot share a group.
  const blocks = [block(prose(2500, 'a')), block(prose(2500, 'b')), block(prose(300, 'c'))];
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.map(b => b.index)), [[0], [1, 2]]);
  assert.deepStrictEqual(groups.map(g => g.chars), [2500, 2800]);
});

test('a block bigger than the cap forms a group ALONE — blocks are never split', () => {
  const blocks = [block(prose(120, 'a')), block(prose(9000, 'b')), block(prose(120, 'c'))];
  const groups = groupSimplifyBlocks(blocks);
  assert.deepStrictEqual(groups.map(g => g.blocks.map(b => b.index)), [[0], [1], [2]]);
  assert.strictEqual(groups[1].blocks[0].text.length, 9000, 'the oversized block travels whole');
});

test('an all-tiny group under MIN_GROUP_SEND_CHARS is NOT sent', () => {
  assert.strictEqual(MIN_GROUP_SEND_CHARS, 120);
  // A title page: the exact shape whose per-line chunks used to die one by one.
  const groups = groupSimplifyBlocks([
    block('BLACK SUN', 'h1'),
    block('A Novel'),
    block('by Someone'),
  ]);
  assert.strictEqual(groups.length, 1, 'the two lines still form a group');
  assert.deepStrictEqual(groups[0].blocks.map(b => b.index), [1, 2]);
  assert.strictEqual(groups[0].send, false, 'but it is never sent');
});

test('a tiny orphan block stranded between two headings is NOT sent', () => {
  const groups = groupSimplifyBlocks([
    block('PART ONE', 'h1'),
    block('1914'),
    block('The Gathering Storm', 'h2'),
  ]);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(groups[0].blocks.map(b => b.index), [1]);
  assert.strictEqual(groups[0].send, false);
});

test('planChapterBlockGroups separates every group from the WORK', () => {
  const xhtml = `<html><body>
    <h1>BLACK SUN</h1><p>A Novel</p>
    <h2>One</h2><p>${prose(400, 'a')}</p>
    </body></html>`;
  const plan = planChapterBlockGroups(xhtml);
  assert.strictEqual(plan.groups.length, 2, 'both runs are groups');
  assert.strictEqual(plan.sendable.length, 1, 'only one is work');
  assert.strictEqual(plan.sendable[0].blocks[0].index, 3);
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

test('a block under GATE_MIN_INPUT_CHARS is not length-gated at all', () => {
  assert.strictEqual(GATE_MIN_INPUT_CHARS, 50);
  // 40% of `"No," she said.` is six characters — a threshold that measures
  // nothing, and would reject a perfectly good three-word rewrite.
  assert.strictEqual(judgeBlockRewrite('"No," she said.', '"No."').accept, true);
  assert.strictEqual(judgeBlockRewrite('x'.repeat(49), 'ab').accept, true);
  // One character over, and the gate applies again.
  assert.strictEqual(judgeBlockRewrite('x'.repeat(50), 'ab').reason, 'acceptance-gate');
});

test('an empty SHORT block keeps the original and costs nothing', () => {
  assert.strictEqual(judgeBlockRewrite('"No," she said.', '').reason, 'empty');
  assert.strictEqual(judgeBlockRewrite('"No," she said.', '   \n ').reason, 'empty');
});

test('an empty LONG block is the most complete loss there is — it counts', () => {
  assert.strictEqual(judgeBlockRewrite(prose(1000), '').reason, 'acceptance-gate');
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

const groupOf = (...texts) => {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return { blocks: texts.map((text, i) => ({ index: i, text })), chars, send: chars >= MIN_GROUP_SEND_CHARS };
};

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

/**
 * A chapter shaped like the ones that broke: a title page whose only body line is
 * two words, a heading mid-chapter, a line of dialogue between two paragraphs,
 * and inline markup to lose or keep. Block indices 0-7.
 */
const CHAPTER = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>
<p data-bf-uid="u-p1">A Novel</p>
<h2 data-bf-uid="u-h2">One</h2>
<p data-bf-uid="u-p2" data-bf-cat="body">${prose(150, 'a')}</p>
<p data-bf-uid="u-p3">"No," she said.</p>
<p data-bf-uid="u-p4" data-bf-cat="body">A <em>very</em> emphatic paragraph that is comfortably long enough to be sent.</p>
<h2 data-bf-uid="u-h3">Two</h2>
<p data-bf-uid="u-p5" data-bf-user-cat="body">${prose(150, 'b')}</p>
</body></html>`;

const ALL_UIDS = ['u-h1', 'u-p1', 'u-h2', 'u-p2', 'u-p3', 'u-p4', 'u-h3', 'u-p5'];
const nulls = () => new Array(8).fill(null);

/**
 * The chapter as this writer serializes it, with nothing written. Not quite the
 * input string: cheerio's XML serializer respells `"` inside text as `&quot;`.
 * That is the same XML said differently — it parses back to identical text — so
 * "the pass wrote nothing" is asserted against THIS, and the fact that it parses
 * back identical is asserted on its own below.
 */
const CHAPTER_SERIALIZED = replaceBlockTextsExact(CHAPTER, nulls());

test('replaceBlockTextsExact writes in place: uids, classes and headings survive', () => {
  const blocks = extractBlockTextsWithTags(CHAPTER);
  assert.strictEqual(blocks.length, 8);
  const texts = nulls();
  texts[3] = 'REWRITTEN THREE';
  texts[7] = 'REWRITTEN SEVEN';
  const out = replaceBlockTextsExact(CHAPTER, texts);

  assert.ok(out.includes('<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>'), 'the heading is byte-identical');
  assert.ok(out.includes('<p data-bf-uid="u-p2" data-bf-cat="body">REWRITTEN THREE</p>'), 'rewrite kept every attribute');
  assert.ok(out.includes('data-bf-user-cat="body">REWRITTEN SEVEN</p>'), 'the user category survived');
  for (const uid of ALL_UIDS) {
    assert.ok(out.includes(`data-bf-uid="${uid}"`), `${uid} still identifies its element`);
  }
});

test('a null entry is NOT WRITING — inline markup survives it', () => {
  const out = replaceBlockTextsExact(CHAPTER, nulls());
  assert.ok(out.includes('A <em>very</em> emphatic paragraph'), 'the <em> is untouched');
  assert.strictEqual(out, replaceBlockTextsExact(out, nulls()), 'and it is idempotent');
});

test('writing nothing loses nothing: same elements, attributes and TEXT', () => {
  // The serializer respells `"` as `&quot;`; what must not change is what the
  // document MEANS, which is what every downstream reader actually sees.
  const before = extractBlockTextsWithTags(CHAPTER);
  const after = extractBlockTextsWithTags(CHAPTER_SERIALIZED);
  assert.deepStrictEqual(after, before, 'every block, tag, attribute and text is identical');
  assert.ok(CHAPTER.includes('"No," she said.'));
  assert.ok(CHAPTER_SERIALIZED.includes('&quot;No,&quot; she said.'), 'respelt, not rewritten');
  assert.strictEqual(after[4].text, '"No," she said.', 'and it parses back to the same characters');
});

test('a rewrite flattens inline markup in ITS block only', () => {
  const texts = nulls();
  texts[5] = 'Plain now.';
  const out = replaceBlockTextsExact(CHAPTER, texts);
  assert.ok(!out.includes('<em>'), 'the rewritten block lost its <em> (as the old rebuild did to every block)');
  assert.ok(out.includes('<p data-bf-uid="u-p4" data-bf-cat="body">Plain now.</p>'));
});

test('the writer escapes text rather than injecting markup', () => {
  const texts = nulls();
  texts[3] = 'a < b & c';
  assert.ok(replaceBlockTextsExact(CHAPTER, texts).includes('a &lt; b &amp; c'));
});

test('a count mismatch THROWS with both counts — it never writes as many as fit', () => {
  assert.throws(
    () => replaceBlockTextsExact(CHAPTER, [null, 'one', null]),
    /block count mismatch — document has 8 non-empty block elements, caller supplied 3/
  );
  assert.throws(() => replaceBlockTextsExact(CHAPTER, new Array(9).fill(null)), /supplied 9/);
});

// ── 7. End to end over a chapter ────────────────────────────────────────────

/** Rewrites long enough to clear the gate on the fixture's 150-char paragraphs. */
const R2 = 'The first paragraph again, rewritten so that a child can follow every word of it.';
const R3 = '"No."';
const R4 = 'A very emphatic paragraph, rewritten just as plainly as the one before it was.';
const R5 = 'The last paragraph, rewritten to be shorter but still complete enough to keep.';

test('a whole chapter: headings byte-identical, uids intact, rewrites in place', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  assert.deepStrictEqual(
    plan.blocks.map(b => b.tagName),
    ['h1', 'p', 'h2', 'p', 'p', 'p', 'h2', 'p'],
    'the block list is the chapter in document order'
  );
  // "A Novel" is a run of its own between two headings, and too short to send.
  // The dialogue line rides along with the paragraphs either side of it.
  assert.deepStrictEqual(plan.groups.map(g => g.blocks.map(b => b.index)), [[1], [3, 4, 5], [7]]);
  assert.deepStrictEqual(plan.groups.map(g => g.send), [false, true, true]);
  assert.deepStrictEqual(plan.sendable.map(g => g.blocks.map(b => b.index)), [[3, 4, 5], [7]]);

  const call = scriptedCall([
    answerOf([1, R2], [2, R3], [3, R4]),
    answerOf([1, R5]),
  ]);
  const state = newCleanupJobState();
  const seen = [];

  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER,
    plan,
    groups: plan.sendable,
    chapterTitle: 'BLACK SUN',
    call,
    state,
    firstGroupNumber: 1,
    totalGroupsInJob: 2,
    beforeGroup: (n, chars) => seen.push(`start ${n} (${chars} chars)`),
    afterGroup: (n) => seen.push(`done ${n}`),
  });

  assert.deepStrictEqual(seen, [
    `start 1 (${plan.sendable[0].chars} chars)`,
    'done 1',
    `start 2 (${plan.sendable[1].chars} chars)`,
    'done 2',
  ], 'progress fires once before and once after each SENT group, in job-wide numbering');

  // Headings and the unsent title line come out untouched, byte for byte.
  assert.ok(out.includes('<h1 data-bf-uid="u-h1" class="chapter-title">BLACK SUN</h1>'));
  assert.ok(out.includes('<h2 data-bf-uid="u-h2">One</h2>'));
  assert.ok(out.includes('<h2 data-bf-uid="u-h3">Two</h2>'));
  assert.ok(out.includes('<p data-bf-uid="u-p1">A Novel</p>'), 'the unsent group was never written');
  // Element enumeration is unchanged — same count, same uids, same order.
  const after = extractBlockTextsWithTags(out);
  assert.strictEqual(after.length, plan.blocks.length);
  assert.deepStrictEqual(after.map(b => b.attrs['data-bf-uid']), ALL_UIDS);
  assert.deepStrictEqual(after.map(b => b.tagName), ['h1', 'p', 'h2', 'p', 'p', 'p', 'h2', 'p']);
  // And the rewrites landed on their own elements — the short one included.
  assert.strictEqual(after[3].text, R2);
  assert.strictEqual(after[4].text, R3, 'the dialogue line was simplified WITH its context');
  assert.strictEqual(after[5].text, R4);
  assert.strictEqual(after[7].text, R5);
  assert.deepStrictEqual(state.skippedChunks, []);
});

test('a chapter whose model gives nothing usable comes back UNWRITTEN', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  const call = scriptedCall([
    new Error('REASONING_OVERRUN: no answer'),   // group 1 (3 blocks)
    new Error('REASONING_OVERRUN: no answer'),   // …then each of its blocks alone
    new Error('REASONING_OVERRUN: no answer'),
    new Error('REASONING_OVERRUN: no answer'),
    new Error('REASONING_OVERRUN: no answer'),   // group 2 is a single: one call
  ]);
  const state = newCleanupJobState();
  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER, plan, groups: plan.sendable, chapterTitle: 'BLACK SUN',
    call, state, firstGroupNumber: 1, totalGroupsInJob: 2,
  });

  assert.strictEqual(out, CHAPTER_SERIALIZED, 'nothing was written, so nothing changed');
  assert.strictEqual(call.sent.length, 5);
  assert.strictEqual(state.errorFallbackCount, 4, 'one per failed BLOCK');
  assert.deepStrictEqual(state.skippedChunks.map(s => s.chunkIndex), [3, 4, 5, 7], 'recorded by block index');
});

test('groups test mode cut off leave their blocks untouched, not "processed"', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  const call = scriptedCall([answerOf([1, R2], [2, R3], [3, R4])]);
  const state = newCleanupJobState();
  const out = await simplifyChapterBlocks({
    xhtml: CHAPTER, plan,
    groups: plan.sendable.slice(0, 1),   // testModeChunks = 1
    chapterTitle: 'BLACK SUN', call, state, firstGroupNumber: 1, totalGroupsInJob: 1,
  });
  const after = extractBlockTextsWithTags(out);
  assert.strictEqual(after[3].text, R2);
  assert.strictEqual(after[7].text, plan.blocks[7].text, 'the group the limit cut off kept its original text');
  assert.strictEqual(call.sent.length, 1);
});

test('handing simplifyChapterBlocks an UNSENDABLE group is refused, not quietly sent', async () => {
  const plan = planChapterBlockGroups(CHAPTER);
  const state = newCleanupJobState();
  await assert.rejects(
    () => simplifyChapterBlocks({
      xhtml: CHAPTER, plan, groups: plan.groups,   // includes the "A Novel" run
      chapterTitle: 'BLACK SUN', call: scriptedCall([]), state,
      firstGroupNumber: 1, totalGroupsInJob: 3,
    }),
    /was handed an unsendable group \(7 chars, under 120\)/
  );
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
