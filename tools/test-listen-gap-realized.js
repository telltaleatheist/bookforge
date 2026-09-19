#!/usr/bin/env node
/**
 * THE PLAYER REALIZES THE GAP, AND IT IS THE BOOK'S OWN NUMBER.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-listen-gap-realized.js
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 *
 * Listen paced at half the book's default and ignored the voice's inject
 * entirely, because three different places owned one silence:
 *
 *   narrator      appended a flat `STREAM_GAP_SEC` = 0.30 s to every streamed
 *                 row (`serve/worker.py`), an env nobody else set;
 *   the players   added `PARAGRAPH_GAP_SECONDS` = 0.50 s at the end of a block,
 *                 declared identically in `extension/src/offscreen.ts`,
 *                 `electron/reader-audio-store.ts` and the Bookshelf reader —
 *                 three copies calling each other "mirrors";
 *   the book      assembled the same sentences at `gaps.json`'s 0.60 s, or at
 *                 the voice's MEASURED inject (`chunkGap.injectS`, 0.62 s on
 *                 sigma) — which no Listen surface ever saw.
 *
 * Owen ruled on 2026-09-18: *"yes, it paces like the book... maybe the browser
 * extension should handle the gaps for itself"*, on top of the earlier *"whoever
 * assembles them owns the gap"*. On a stream there is no assembler but the
 * player, so narrator states the gap it classified (`text/gaps.classify_gap`,
 * the same call that writes `gaps.json`) and the player inserts exactly that.
 *
 * ── What is pinned here, and where each half runs ───────────────────────────
 *
 *   §0  (retired 2026-09-19: the vendored `@crucible/client` 1.0.5 shapes
 *       `gapSec` onto `done` itself; the two shims that carried it are gone)
 *   §1  `shared/listen-client/crucible-rows.ts` — the gap comes off the SDK's
 *       `done` frame onto the row result, and a row that spoke without one is
 *       refused BY NAME rather than paced by a default.
 *   §2  `shared/listen-client/session-policy.ts` — it rides the scheduler's
 *       `done` event, and a generator that returns a success without it fails
 *       that row instead of the scheduler inventing a pause.
 *   §3  `electron/reader-audio-store.ts` — the served WAV grows by EXACTLY the
 *       stated gap per row, `settle` adds nothing of its own, and a gap that is
 *       not a number is thrown by name.
 *   §4  THE BOUNDARY MATH, in both players' real source: the gap lands INSIDE
 *       the row's boundary, so `sentenceAt` maps a time inside it to the row
 *       that just spoke and a seek to the next row lands on its first sample.
 *       The two `Session` classes are lifted out of `extension/src/offscreen.ts`
 *       and `projects/bookshelf/.../reader-playback.service.ts` and RUN, because
 *       a boundary that drifts by a gap per row is a highlight that walks away
 *       from the voice and nothing throws when it does.
 *
 * THE FOURTH PLAYER IS NOT HERE, and that is a limit rather than an omission.
 * The Play tab's `src/app/.../audio-player.service.ts` schedules `AudioBuffer`s
 * on a Web Audio context, which node has none of; its half of the rule is held
 * by the compiler (`markSentenceDone` takes the gap and refuses a non-number)
 * and by `tools/test-listen-text-one-source.js`, which is where every player is
 * checked for a pause constant of its own.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
const EXT = path.join(REPO, 'extension');

let failures = 0;
/** Every check is awaited: three of them drive a promise, and a rejection
 *  nobody awaited would be an unhandled warning rather than a red keeper. */
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

async function main() {
  console.log('the player realizes the gap narrator classified');

  if (!fs.existsSync(path.join(DIST, 'shared', 'listen-client', 'crucible-rows.js'))) {
    console.log(skipLine('dist is not built — run `npx tsc -p tsconfig.electron.json`'));
    return;
  }
  if (!fs.existsSync(path.join(EXT, 'node_modules', 'esbuild'))) {
    console.log(skipLine('extension/node_modules is missing — run `npm install --prefix extension`'));
    return;
  }

  const { CrucibleRowSession } = require(path.join(DIST, 'shared', 'listen-client', 'crucible-rows.js'));
  const { ListenSessions } = require(path.join(DIST, 'shared', 'listen-client', 'session-policy.js'));
  const store = require(path.join(DIST, 'electron', 'reader-audio-store.js'));

  /** A Crucible session that yields the frames a test hands it, then ends. */
  function fakeSession(frames) {
    return {
      sessionId: 's1',
      voice: 'deathstalker',
      fingerprint: 'deathstalker@1',
      sampleRate: 24000,
      backend: 'vllm-omni',
      say: async () => undefined,
      cancel: async () => 'already_finished',
      cancelAll: async () => 0,
      close: async () => undefined,
      [Symbol.asyncIterator]: async function* iterate() { for (const f of frames) yield f; },
    };
  }

  const DONE = {
    kind: 'done', id: 'r1', done: true, seconds: 1.0, chars: 20, charsPerSec: 20,
    capped: null, cancelled: false, gapSec: 0.62,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. The row layer: off the frame, onto the result — or refused
  // ═══════════════════════════════════════════════════════════════════════════

  await check("a row's result carries the gap the server stated", async () => {
    const rows = new CrucibleRowSession(fakeSession([
      { kind: 'audio', id: 'r1', seq: 0, pcm: new Int16Array([1, 2, 3]), seconds: 1.0 },
      DONE,
    ]));
    const said = rows.say('A sentence of prose.', { id: 'r1' });
    void rows.run();
    const result = await said;
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(result.gapSec, 0.62,
      'the voice\'s measured inject did not survive the row layer');
  });

  await check('a row that spoke without a gap is refused by name', async () => {
    const rows = new CrucibleRowSession(fakeSession([
      { kind: 'audio', id: 'r1', seq: 0, pcm: new Int16Array([1, 2, 3]), seconds: 1.0 },
      { ...DONE, gapSec: null },
    ]));
    const said = rows.say('A sentence of prose.', { id: 'r1' });
    void rows.run();
    const result = await said;
    assert.strictEqual(result.success, false,
      'a row with no gap was delivered as a success; the player would pace it by a guess');
    assert.match(result.error, /gap/i);
  });

  await check('a CANCELLED row is allowed to have no gap', async () => {
    // null means "this row delivered no complete audio", which is the one honest
    // reading of an absent pause. It must not be confused with the refusal above.
    const rows = new CrucibleRowSession(fakeSession([{ ...DONE, cancelled: true, gapSec: null }]));
    const said = rows.say('A sentence of prose.', { id: 'r1' });
    void rows.run();
    const result = await said;
    assert.strictEqual(result.success, false);
    assert.match(result.error, /cancelled/);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. The scheduler: it rides `done`, and a success without it fails the row
  // ═══════════════════════════════════════════════════════════════════════════

  /** Drive one row through the policy and return the events its sink saw. */
  function runPolicy(result) {
    return new Promise((resolve) => {
      const events = [];
      const sessions = new ListenSessions({
        isReady: () => true,
        concurrency: () => ({ cap: 1, batching: true }),
        rampWidth: () => 1,
        generate: async () => result,
      }, () => {}, () => {});
      sessions.start(['One row.'], 0, {}, 'req-1', (event) => {
        events.push(event);
        if (event.kind === 'complete' || event.kind === 'cancelled') resolve(events);
      });
    });
  }

  await check("the scheduler's `done` carries the gap", async () => {
    const events = await runPolicy({
      success: true, gapSec: 0.62,
      audio: { data: 'AAAA', duration: 1.0, sampleRate: 24000 },
    });
    const done = events.find((e) => e.kind === 'done');
    assert.ok(done, `no done event: ${JSON.stringify(events)}`);
    assert.strictEqual(done.gapSec, 0.62);
  });

  await check('a generated row with no gap fails instead of being paced by a default', async () => {
    const events = await runPolicy({
      success: true,
      audio: { data: 'AAAA', duration: 1.0, sampleRate: 24000 },
    });
    assert.ok(!events.some((e) => e.kind === 'done'),
      'a row with no gap was delivered to the player anyway');
    const failed = events.find((e) => e.kind === 'failed');
    assert.ok(failed, `no failed event: ${JSON.stringify(events)}`);
    assert.match(failed.error, /pause/);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. The served WAV: exactly the stated gap, per row, and nothing at settle
  // ═══════════════════════════════════════════════════════════════════════════

  const BYTES_PER_SECOND = 24000 * 2;
  const WAV_HEADER = 44;

  await check('the audio store inserts exactly the gap each row stated', () => {
    const key = store.makeKey('reader-1', 'req-1');
    store.begin(key);
    store.feed(key, Buffer.alloc(BYTES_PER_SECOND), 24000);   // 1.0 s of row 0
    store.gap(key, 0.62);
    store.feed(key, Buffer.alloc(BYTES_PER_SECOND), 24000);   // 1.0 s of row 1
    store.gap(key, 2.5);                                      // an explicit [pause:2.5]
    store.settle(key, true);
    const wav = store.wav(key);
    const expected = WAV_HEADER + Math.floor((1.0 + 0.62 + 1.0 + 2.5) * BYTES_PER_SECOND);
    assert.strictEqual(wav.length, expected,
      `the block is ${(wav.length - WAV_HEADER) / BYTES_PER_SECOND}s and the rows plus their `
      + `stated gaps are ${(expected - WAV_HEADER) / BYTES_PER_SECOND}s`);
    store.drop(key);
  });

  await check('settling a block appends no silence of its own', () => {
    // The pause after a block IS its last row's gap. A second one here was the
    // old per-block PARAGRAPH_GAP_SECONDS, and it is what made the app and the
    // audiobook pace the same paragraph differently.
    const key = store.makeKey('reader-1', 'req-2');
    store.begin(key);
    store.feed(key, Buffer.alloc(BYTES_PER_SECOND), 24000);
    store.settle(key, true);
    assert.strictEqual(store.wav(key).length, WAV_HEADER + BYTES_PER_SECOND);
    store.drop(key);
  });

  await check('a gap that is not a number is refused by name', () => {
    const key = store.makeKey('reader-1', 'req-3');
    store.begin(key);
    store.feed(key, Buffer.alloc(BYTES_PER_SECOND), 24000);
    // Matched on the REASON, not on the word "gap": a store that has no `gap`
    // function at all throws a TypeError mentioning it too, and this check has
    // to be red on the version that has not been fixed yet.
    assert.throws(() => store.gap(key, undefined), /no default to fall back to/);
    store.drop(key);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. The boundary math, run out of both players' own source
  // ═══════════════════════════════════════════════════════════════════════════

  const esbuild = require(path.join(EXT, 'node_modules', 'esbuild'));

  /**
   * The `Session` class as that player really declares it, compiled and loaded.
   *
   * Lifted by text because neither player exports it: `offscreen.ts` is a browser
   * document that builds an `<audio>` element at import, and the Bookshelf one is
   * an Angular service. The class itself depends on nothing but
   * `BYTES_PER_SECOND`, which is supplied here at the rate both files declare.
   *
   * NEWLINES ARE NORMALIZED FIRST. A worktree checkout on Windows lands CRLF, and
   * a matcher anchored on "\n}" then finds nothing and silently pins an empty
   * class — the failure `test-stream-engine-availability` already has.
   */
  function sessionClassFrom(file) {
    const src = fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
    const start = src.indexOf('\nclass Session {');
    if (start < 0) throw new Error(`no top-level 'class Session {' in ${path.basename(file)}`);
    const end = src.indexOf('\n}\n', start);
    if (end < 0) throw new Error(`'class Session' in ${path.basename(file)} never closes at column 0`);
    const declaration = src.slice(start + 1, end + 3);
    const js = esbuild.transformSync(
      `const BYTES_PER_SECOND = ${BYTES_PER_SECOND};\n${declaration}\nmodule.exports = Session;`,
      { loader: 'ts', format: 'cjs', target: 'node18' },
    ).code;
    const module_ = { exports: {} };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', js)(module_, module_.exports);
    return module_.exports;
  }

  const PLAYERS = [
    ['the extension', path.join(EXT, 'src', 'offscreen.ts')],
    ['the Bookshelf reader', path.join(
      REPO, 'projects', 'bookshelf', 'src', 'app', 'reader', 'reader-playback.service.ts')],
  ];

  for (const [who, file] of PLAYERS) {
    await check(`${who} inserts the gap INSIDE the row's boundary`, () => {
      const Session = sessionClassFrom(file);
      const s = new Session('req-1');
      s.initSlots(['Row zero.', 'Row one.']);
      s.addChunk(0, 0, new Uint8Array(BYTES_PER_SECOND));      // 1.0 s
      s.markDone(0, 0.62);
      s.addChunk(1, 0, new Uint8Array(BYTES_PER_SECOND));      // 1.0 s
      s.markDone(1, 0.62);
      s.drain();

      assert.strictEqual(s.seconds, 1.0 + 0.62 + 1.0 + 0.62,
        'the block is not its rows plus the gaps they stated');
      // Row 1 begins AFTER row 0's pause, so a seek to it starts on speech.
      assert.strictEqual(s.boundaries[1] / BYTES_PER_SECOND, 1.62);
      // And a playhead inside row 0's pause is still row 0 — it is the silence
      // that sentence ends with, not the start of the next one.
      assert.strictEqual(s.sentenceAt(1.0), 0, 'the gap after row 0 highlighted row 1');
      assert.strictEqual(s.sentenceAt(1.61), 0, 'the gap after row 0 highlighted row 1');
      assert.strictEqual(s.sentenceAt(1.62), 1, 'row 1 did not start at its own first sample');
    });

    await check(`${who} refuses a row that retired without a gap`, () => {
      const Session = sessionClassFrom(file);
      const s = new Session('req-1');
      s.initSlots(['Row zero.']);
      s.addChunk(0, 0, new Uint8Array(BYTES_PER_SECOND));
      assert.throws(() => s.markDone(0, undefined), /gap/i,
        'the player accepted a row with no gap and would pace it by a guess');
    });

    await check(`${who} gives a longer-classified row its longer pause`, () => {
      // Nothing in the player knows WHY a row's gap differs — an explicit
      // [pause:X] is the only thing that still moves `classify_gap`'s answer —
      // and that is the point: the number is narrator's, per row, and this side
      // has no tier table of its own to disagree with.
      const Session = sessionClassFrom(file);
      const s = new Session('req-1');
      s.initSlots(['A beat follows this.', 'And this one is ordinary.']);
      s.addChunk(0, 0, new Uint8Array(BYTES_PER_SECOND));
      s.markDone(0, 2.5);
      s.addChunk(1, 0, new Uint8Array(BYTES_PER_SECOND));
      s.markDone(1, 0.62);
      s.drain();
      assert.strictEqual(s.boundaries[1] / BYTES_PER_SECOND, 3.5);
      assert.strictEqual(s.seconds, 1.0 + 2.5 + 1.0 + 0.62);
    });
  }

  console.log(failures === 0
    ? '\nOne gap, one owner, realized where the rows are joined.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
