#!/usr/bin/env node
/**
 * The streaming-teardown keeper: a client that walks away must not leave a file
 * descriptor behind.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bookshelf-stream-teardown.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `stream.pipe(res)` unhooks the source when the destination closes but does NOT
 * destroy it, so an aborted download leaves a paused fs.ReadStream holding an open
 * handle until garbage collection happens to reach it. On 2026-08-29 one browser
 * tab, opened on an audiobook once and then closed, kept a read handle on an m4b
 * living on an SMB share for hours; the lease that handle carried made the server
 * refuse to rename the file, and an assembly's atomic promote failed with EPERM
 * until BookForge was quit outright. Nothing about that was visible from the app.
 *
 * Two claims are asserted here, and only the second is about the analysis pin:
 *
 *   TEARDOWN   Every streaming route destroys its read stream when the response
 *              closes — completed or aborted, pinned or plain. Asserted by
 *              wrapping fs.createReadStream before the server is loaded, so the
 *              streams the handlers open are the exact objects inspected.
 *
 *   FD IDLE    A pinned analysis session releases its descriptor and its private
 *              snapshot once no request has been in flight for the idle window,
 *              while the TOKEN stays redeemable so a returning player re-pins
 *              transparently instead of losing its analysis.
 *
 * It drives the REAL compiled server over a real socket, because the leak lives in
 * what happens to a socket that dies mid-body — which no direct handler call has.
 */
'use strict';
require('../cli/electron-stub.js'); // the compiled modules require('electron')

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

// ── Instrument fs BEFORE the server is required ─────────────────────────────
//
// The handlers call fsSync.createReadStream at request time, so patching the
// shared 'fs' module here catches every stream they open, whatever the route.
const opened = [];
const realCreateReadStream = fs.createReadStream;
fs.createReadStream = function patched(...args) {
  const stream = realCreateReadStream.apply(fs, args);
  opened.push(stream);
  return stream;
};

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const SERVER_MOD = path.join(DIST, 'bookshelf-server.js');
if (!fs.existsSync(SERVER_MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { bookshelfServer } = require(SERVER_MOD);
const { setLibraryBasePath } = require(path.join(DIST, 'manifest-service.js'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.stack ? e.stack : e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a condition, polling, so a passing run costs no wall clock. */
async function until(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Start a GET, read the first chunk, then destroy the socket — a browser tab
 * closing mid-download. Resolves once the server has seen the socket die.
 */
function abortMidTransfer(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      res.once('data', () => {
        req.destroy();
        // Give the server's 'close' handler a turn before the assertion runs.
        setTimeout(resolve, 50);
      });
      res.on('error', () => {});
    });
    req.on('error', (err) => {
      // ECONNRESET is our own destroy() coming back; anything else is real.
      if (err.code === 'ECONNRESET') return;
      reject(err);
    });
    setTimeout(() => { req.destroy(); reject(new Error('no body ever arrived')); }, 10000);
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-stream-teardown-'));
const LIBRARY = path.join(TMP, 'library');
const STATE = path.join(TMP, 'state');

(async () => {
  fs.mkdirSync(path.join(LIBRARY, 'projects'), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });

  // Big enough that a single first chunk cannot finish it — otherwise "aborted"
  // and "completed" would be the same test.
  const AUDIO = path.join(LIBRARY, 'fixture.m4b');
  const AUDIO_BYTES = crypto.randomBytes(8 * 1024 * 1024);
  fs.writeFileSync(AUDIO, AUDIO_BYTES);

  setLibraryBasePath(LIBRARY);

  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  await bookshelfServer.start({ port, userDataPath: STATE, mode: 'standalone' });

  await check('the production idle window is minutes, not hours', async () => {
    // The six-hour window is the bug this file exists for: it is what let a
    // closed tab hold a library file open until the app was quit.
    const idle = bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS;
    assert.strictEqual(typeof idle, 'number');
    assert.ok(idle <= 1000 * 60 * 5, `pinned descriptors idle for ${idle}ms — that is not prompt`);
    assert.ok(idle >= 1000 * 30, `${idle}ms would re-pin under a live player's own request gaps`);
    // The token must OUTLIVE the descriptor, or a paused player loses its analysis
    // instead of quietly re-pinning.
    assert.ok(bookshelfServer.ANALYSIS_STREAM_SESSION_TTL > idle,
      'a token that dies with its descriptor cannot be redeemed by a returning player');
  });

  await check('an aborted /api/audio transfer strands no descriptor', async () => {
    opened.length = 0;
    await abortMidTransfer(port, `/api/audio?path=${encodeURIComponent(AUDIO)}`);
    assert.strictEqual(opened.length, 1, 'the handler did not open exactly one read stream');
    await until(() => opened[0].destroyed, 2000, 'the aborted audio stream to be destroyed');
    assert.strictEqual(opened[0].fd, null, 'the stream was destroyed but its descriptor stayed open');
  });

  await check('an aborted Range read strands no descriptor either', async () => {
    opened.length = 0;
    await abortMidTransfer(port, `/api/audio?path=${encodeURIComponent(AUDIO)}`,
      { Range: `bytes=0-${AUDIO_BYTES.length - 1}` });
    assert.strictEqual(opened.length, 1);
    await until(() => opened[0].destroyed, 2000, 'the aborted range stream to be destroyed');
    assert.strictEqual(opened[0].fd, null);
  });

  await check('an aborted /api/download strands no descriptor', async () => {
    opened.length = 0;
    await abortMidTransfer(port, `/api/download?path=${encodeURIComponent(AUDIO)}`);
    assert.strictEqual(opened.length, 1);
    await until(() => opened[0].destroyed, 2000, 'the aborted download stream to be destroyed');
    assert.strictEqual(opened[0].fd, null);
  });

  await check('a COMPLETED transfer closes its descriptor and serves every byte', async () => {
    opened.length = 0;
    const res = await fetch(`${BASE}/api/audio?path=${encodeURIComponent(AUDIO)}`);
    assert.strictEqual(res.status, 200);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(AUDIO_BYTES), 'teardown must not truncate a healthy transfer');
    assert.strictEqual(opened.length, 1);
    await until(() => opened[0].destroyed, 2000, 'the finished stream to be destroyed');
    assert.strictEqual(opened[0].fd, null);
  });

  await check('a completed Range read still answers 206 with the right bytes', async () => {
    const res = await fetch(`${BASE}/api/audio?path=${encodeURIComponent(AUDIO)}`, {
      headers: { Range: 'bytes=100-199' },
    });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes 100-199/${AUDIO_BYTES.length}`);
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(AUDIO_BYTES.subarray(100, 200)));
  });

  // ── The pinned session's descriptor lifecycle ──────────────────────────────
  //
  // Minting a token through /api/audiobook-analysis would need a whole verified
  // project on disk; the session table is the seam under test, so the token is
  // minted directly and the idle window shortened for this run only. The
  // production default is asserted separately above.
  await check('a pinned session releases its descriptor when idle, and re-pins on return', async () => {
    const realIdle = bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS;
    bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS = 200;
    try {
      const sha = crypto.createHash('sha256').update(AUDIO_BYTES).digest('hex');
      const token = bookshelfServer.issueAnalysisStreamSession(
        AUDIO, sha, AUDIO_BYTES.length, 'WEBVTT\n\n');
      const sessions = bookshelfServer.analysisStreamSessions;
      assert.ok(sessions.get(token), 'the token was not registered');

      const url = `${BASE}/api/audio?path=${encodeURIComponent(AUDIO)}&analysisToken=${token}`;
      const first = await fetch(url, { headers: { Range: 'bytes=0-63' } });
      assert.strictEqual(first.status, 206, 'a pinned range read must still be served');
      assert.ok(Buffer.from(await first.arrayBuffer()).equals(AUDIO_BYTES.subarray(0, 64)));

      const session = sessions.get(token);
      assert.ok(session.handle, 'the request did not pin a descriptor');
      const snapshotDir = path.dirname(session.snapshotPath);
      assert.ok(fs.existsSync(snapshotDir), 'the pinned snapshot was never written');

      // Nothing in flight → the countdown runs out and the descriptor goes.
      await until(() => !sessions.get(token).handle, 3000, 'the idle descriptor to be released');
      assert.strictEqual(sessions.get(token).snapshotPath, undefined);
      assert.ok(!fs.existsSync(snapshotDir), 'the snapshot outlived the descriptor that held it');
      assert.ok(sessions.get(token), 'the TOKEN must survive its descriptor');

      // A player that comes back is served transparently — same token, same bytes.
      const second = await fetch(url, { headers: { Range: 'bytes=64-127' } });
      assert.strictEqual(second.status, 206, 'a returning player was refused instead of re-pinned');
      assert.ok(Buffer.from(await second.arrayBuffer()).equals(AUDIO_BYTES.subarray(64, 128)));
      assert.ok(sessions.get(token).handle, 'the return did not re-pin');

      await until(() => !sessions.get(token).handle, 3000, 'the re-pinned descriptor to be released');
    } finally {
      bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS = realIdle;
    }
  });

  await check('an aborted PINNED transfer releases its own descriptor immediately', async () => {
    const realIdle = bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS;
    bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS = 200;
    try {
      const sha = crypto.createHash('sha256').update(AUDIO_BYTES).digest('hex');
      const token = bookshelfServer.issueAnalysisStreamSession(
        AUDIO, sha, AUDIO_BYTES.length, 'WEBVTT\n\n');
      opened.length = 0;
      await abortMidTransfer(port, `/api/audio?path=${encodeURIComponent(AUDIO)}&analysisToken=${token}`);
      // The pin itself hashes the snapshot through a read stream, so the request's
      // own stream is the last one opened.
      const streamed = opened[opened.length - 1];
      await until(() => streamed.destroyed, 2000, 'the aborted pinned stream to be destroyed');
      assert.strictEqual(streamed.fd, null, 'the aborted pinned read left its descriptor open');

      const session = bookshelfServer.analysisStreamSessions.get(token);
      assert.strictEqual(session.activeStreams, 0, 'the abort was never counted off');
      // The session's own anchor must NOT have gone with the request's descriptor.
      assert.ok(session.handle, 'one aborted request tore down the whole session');
      await until(() => !bookshelfServer.analysisStreamSessions.get(token).handle, 3000,
        'the session to release its anchor after the abort');
    } finally {
      bookshelfServer.ANALYSIS_STREAM_FD_IDLE_MS = realIdle;
    }
  });

  await bookshelfServer.stop();

  fs.createReadStream = realCreateReadStream;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${failed === 0 ? 'ok' : 'FAILED'}  bookshelf stream teardown: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`FAILED  bookshelf stream teardown: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
