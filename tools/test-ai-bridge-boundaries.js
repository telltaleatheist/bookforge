#!/usr/bin/env node
/**
 * THREE THINGS THE CLEANUP JOB GETS WRONG AT ITS OWN SEAMS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-ai-bridge-boundaries.js
 *
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * `cleanupEpubRun` is one long function, and the three defects below all live at
 * a JOIN inside it — a place where two things the job produced separately are
 * put back together, or where one fact is recorded on the strength of another.
 * Each is invisible in the normal case and each reaches output:
 *
 * 1. THE CHAPTER BOUNDARY. `saveChapterBoundary` wrote the output EPUB and then
 *    wrote the resume checkpoint UNCONDITIONALLY — the save's `catch` only
 *    logged, and execution fell through to `saveCheckpoint`. The checkpoint's
 *    `completedChapters` is read on resume as "already in the output EPUB": a
 *    chapter named there is `continue`d past and never cleaned again. So a save
 *    that threw (the output EPUB open in the Versions tab, a full disk, a
 *    refused Windows rename) followed by an interrupted run produced a finished
 *    book with an UNCLEANED chapter in it, reported `success: true`, and the
 *    model time spent on that chapter was gone. Within one session it self-heals
 *    — the chapter stays in `modifiedChapters`, so the final save retries it —
 *    which is exactly why nobody saw it. The parallel path next door has always
 *    had this right: it records the chapter only inside the try.
 *
 * 2. THE SPLIT CHUNK. Three sites split a chunk at `findBestBreakPoint` and glue
 *    the two cleaned halves back with `cleanedFirst + cleanedSecond`.
 *    `findBestBreakPoint` cuts just PAST a paragraph break, so `firstHalf` ends
 *    with the blank line — but both halves come back through `extractAnswer`,
 *    which ends `text.trim()`. The join therefore deleted the book's own
 *    paragraph break, and with it the space after the full stop, so the rebuilt
 *    chapter ran two paragraphs together and TTS read the join as one sentence.
 *    `splitProseIntoChunks` rejoins with an explicit `'\n\n'`; these did not.
 *
 * 3. THE ABORT LISTENER. `crucibleChatOnce` chains the JOB's abort signal — one
 *    per cleanup run — onto its own per-call controller, with `{ once: true }`.
 *    `once` removes the listener when it FIRES, which on a job that finishes
 *    normally never happens, while the function is called once per chunk plus
 *    once per retry, split half and re-roll. A 2,000-chunk book ended with 2,000
 *    listeners on one signal, each pinning a closure and an AbortController. The
 *    author knew: `cleanupEpubRun` raised the signal's max-listener count to 200
 *    to silence the warning, which treated the warning and not the leak — and
 *    200 is well under one book's chunk count anyway.
 *
 * No model and no server are involved. The two joins are exported functions
 * driven directly; the listener is counted on a real `AbortSignal` with
 * `events.getEventListeners`, and the calls are made against a server name that
 * is not registered so the registry refuses before any socket is opened — the
 * listener is attached before that refusal, so the count is exactly the question
 * this asks.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEventListeners } = require('events');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'ai-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-ai-boundaries-'));
// An empty registry, so the Crucible door below refuses by name rather than
// reaching a server somebody happens to be running.
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

// ai-bridge statically requires 'electron' for the power blocker; the CLI's own
// shim answers it, so the module under test loads exactly as it does headless.
require('../cli/electron-stub.js');

// It also loads its prompt files on import and calls a missing one FATAL, which
// `npm run build:electron` copies into dist and a bare `npx tsc` does not. Put
// them there — the same copy the build makes.
const PROMPTS = path.join(DIST, 'electron', 'prompts');
if (!fs.existsSync(PROMPTS)) {
  fs.cpSync(path.join(REPO, 'electron', 'prompts'), PROMPTS, { recursive: true });
}

const {
  persistChapterBoundary,
  joinSplitHalves,
  crucibleChatOnce,
  findBestBreakPoint,
} = require(path.join(DIST, 'electron', 'ai-bridge.js'));

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
}

/** Run `fn` with console.error captured, so a deliberate failure is not noise. */
async function quietly(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), errors: lines };
  } finally {
    console.error = real;
  }
}

async function run() {
  // ── 1. A CHAPTER IS ONLY FINISHED IF ITS BYTES LANDED ────────────────────

  await check('a failed EPUB save records no chapter boundary', async () => {
    const order = [];
    const { value: saved, errors } = await quietly(() => persistChapterBoundary({
      chapterNumber: 12,
      saveEpub: async () => {
        order.push('save');
        const locked = new Error('EBUSY: resource busy or locked, rename');
        throw locked;
      },
      onSaved: () => order.push('freed'),
      recordBoundary: async () => order.push('checkpoint'),
    }));
    // The checkpoint first: it is the fact that outlives the process, and the
    // one a resume reads.
    assert.ok(!order.includes('checkpoint'),
      'the checkpoint was written after a save that threw, so a resume will skip a '
      + `chapter that is not in the output EPUB: ${order.join(' → ')}`);
    assert.ok(!order.includes('freed'),
      `the chapter was evicted from memory although its bytes never landed: ${order.join(' → ')}`);
    assert.strictEqual(saved, false, 'a save that threw was reported as saved');
    assert.ok(errors.some((line) => line.includes('Failed to save after chapter 12')),
      `the save failure was not logged by name: ${JSON.stringify(errors)}`);
  });

  await check('a chapter that saved is freed and then recorded, in that order', async () => {
    const order = [];
    const saved = await persistChapterBoundary({
      chapterNumber: 3,
      saveEpub: async () => { order.push('save'); },
      onSaved: () => order.push('freed'),
      recordBoundary: async () => order.push('checkpoint'),
    });
    assert.strictEqual(saved, true, 'a save that returned was reported as failed');
    assert.deepStrictEqual(order, ['save', 'freed', 'checkpoint'],
      `the boundary did not persist in the order the resume contract needs: ${order.join(' → ')}`);
  });

  // ── 2. A SPLIT CHUNK REJOINS ON THE BOOK'S OWN WHITESPACE ────────────────

  await check('the two halves of a split chunk keep the paragraph break between them', () => {
    // The real shape: `findBestBreakPoint` prefers a paragraph break and returns
    // the index just PAST it, so the blank line is the tail of the first half.
    const text = 'Chapter twelve began badly.\n\nThe first words of paragraph thirteen followed.';
    const midpoint = findBestBreakPoint(text, Math.floor(text.length / 2), 0);
    const firstHalf = text.substring(0, midpoint);
    const secondHalf = text.substring(midpoint);
    assert.ok(/\n\n$/.test(firstHalf),
      `the fixture does not exercise the paragraph case (midpoint ${midpoint}): ${JSON.stringify(firstHalf)}`);
    // What `extractAnswer` returns: each half trimmed.
    const rejoined = joinSplitHalves(firstHalf, secondHalf, firstHalf.trim(), secondHalf.trim());
    assert.strictEqual(rejoined, text,
      'the rejoined halves are not the book: the split consumed the paragraph break and the '
      + `join did not put it back:\n${JSON.stringify(rejoined)}`);
  });

  await check('a split at a sentence boundary keeps the space after the full stop', () => {
    const first = 'She stopped at the door. ';
    const second = 'Nobody answered it.';
    const rejoined = joinSplitHalves(first, second, first.trim(), second.trim());
    assert.strictEqual(rejoined, first + second,
      `the space after the full stop is gone, so TTS reads the join as one run:\n${JSON.stringify(rejoined)}`);
  });

  await check('a split through a word rejoins with nothing, exactly as it was', () => {
    // Whatever whitespace the original had at the cut is what goes back — none
    // here, so the separator is not invented.
    const rejoined = joinSplitHalves('unbe', 'lievable', 'unbe', 'lievable');
    assert.strictEqual(rejoined, 'unbelievable',
      `a separator was invented at a cut that had none:\n${JSON.stringify(rejoined)}`);
  });

  // ── 3. THE JOB'S SIGNAL DOES NOT COLLECT A LISTENER PER CHUNK ────────────

  await check('crucibleChatOnce leaves no listener on the job signal', async () => {
    const job = new AbortController();
    assert.strictEqual(getEventListeners(job.signal, 'abort').length, 0,
      'the fixture signal already had listeners');

    const CALLS = 25;
    for (let i = 0; i < CALLS; i++) {
      await assert.rejects(
        crucibleChatOnce({
          server: 'no-such-server-for-this-keeper',
          model: 'no-such-model',
          act: 'clean',
          system: 'x',
          user: 'y',
          temperature: 0.1,
          maxTokens: 16,
          sizeChars: 1,
          signal: job.signal,
        }),
        /no crucible server named/,
        'the fixture reached something other than the registry refusal');
    }

    const left = getEventListeners(job.signal, 'abort').length;
    assert.strictEqual(left, 0,
      `${left} abort listeners of ${CALLS} calls are still on the JOB's signal. The signal lives `
      + 'for the whole cleanup run, so a 2,000-chunk book pins 2,000 closures and 2,000 '
      + 'AbortControllers on it; `{ once: true }` releases a listener only when it FIRES.');
  });

  await check('a cancelled job still reaches the in-flight request', async () => {
    // The listener is REMOVED when the call ends, not neutered while it runs:
    // the parent's abort must still abort the request in flight.
    const job = new AbortController();
    const seen = [];
    const call = crucibleChatOnce({
      server: 'no-such-server-for-this-keeper',
      model: 'no-such-model',
      act: 'clean',
      system: 'x',
      user: 'y',
      temperature: 0.1,
      maxTokens: 16,
      sizeChars: 1,
      signal: job.signal,
    });
    seen.push(getEventListeners(job.signal, 'abort').length);
    await assert.rejects(call, /no crucible server named/);
    assert.strictEqual(seen[0], 1,
      `the parent signal was chained ${seen[0]} times while the call was in flight — a cancel `
      + 'would not reach it');
  });

  for (const [status, name, detail] of results) {
    console.log(`${status === 'ok' ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  }
  const passed = results.filter(([s]) => s === 'ok').length;
  console.log(`\n${passed}/${results.length} passed`);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
