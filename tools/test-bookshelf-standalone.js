#!/usr/bin/env node
/**
 * The standalone-mode keeper: what a library-only mirror serves, and what it refuses.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bookshelf-standalone.js
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `mode: 'standalone'` exists so the NAS can serve the library when BookForge is
 * down on both machines. Two contracts hold that up, and both are invisible when
 * they break:
 *
 *   THE GATE     Every capability an engine-less mirror cannot serve answers 501
 *                with a `capability` field, so a client can DISABLE the control
 *                and say why. If a route quietly slips out of the gate, the mirror
 *                starts trying to render audio it cannot render, and the symptom
 *                is a spinner that never resolves. If a route wrongly joins it,
 *                the app itself loses a feature — which is why the app-mode half
 *                below asserts the gate is silent there.
 *
 *   THE LIBRARY  Everything a mirror IS for keeps working: the shelf, range-
 *                streamed audio, and reader state written under the library share
 *                (that is what lets two servers converge without a primary).
 *
 * It drives the REAL compiled server over a real socket — no route table is
 * inspected, no handler is called directly — because the gate is registration-
 * order-sensitive and only HTTP proves it.
 */
'use strict';
require('../cli/electron-stub.js'); // the compiled modules require('electron')

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const SERVER_MOD = path.join(DIST, 'bookshelf-server.js');
if (!fs.existsSync(SERVER_MOD)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const { bookshelfServer, BOOKSHELF_CAPABILITIES, STANDALONE_CAPABILITIES } = require(SERVER_MOD);
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
    console.log(`      ${e && e.message ? e.message : e}`);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-standalone-'));
const LIBRARY = path.join(TMP, 'library');
const STATE = path.join(TMP, 'state');

/** A port nothing else holds: bind 0, read what the OS gave, hand it back. */
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
 * The routes a mirror must refuse, and the capability each must name. This list
 * IS the contract — a new engine-backed route that isn't here is the bug this
 * test is meant to catch, so keep it in step with setupRoutes().
 */
const GATED = [
  ['POST', '/api/render/start', 'render'],
  ['GET', '/api/render/status', 'render'],
  ['GET', '/api/render/sentence', 'render'],
  ['POST', '/api/render/playhead', 'render'],
  ['GET', '/api/reader/audio', 'render'],
  ['GET', '/api/tts/voices', 'render'],
  ['POST', '/api/tts/warm', 'render'],
  ['GET', '/api/project/reader', 'render'],
  ['POST', '/api/reader/ingest', 'ingest'],
  ['POST', '/api/edit/ingest-pdf', 'ingest'],
  ['GET', '/api/edit/page', 'ingest'],
  ['POST', '/api/edit/finalize', 'edit'],
  ['GET', '/api/queue', 'queue'],
  ['POST', '/api/queue/start', 'queue'],
  ['POST', '/api/queue/pause', 'queue'],
  ['DELETE', '/api/project', 'mutate'],
  ['POST', '/api/ebooks/reclassify', 'mutate'],
];

(async () => {
  fs.mkdirSync(path.join(LIBRARY, 'projects'), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  // A small "audiobook" for the range test. streamAudio serves bytes; it never
  // decodes, so the extension is the only thing that has to be real.
  const AUDIO = path.join(LIBRARY, 'fixture.mp3');
  const AUDIO_BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  fs.writeFileSync(AUDIO, AUDIO_BYTES);

  setLibraryBasePath(LIBRARY);

  // ── Standalone: a library-only mirror ──────────────────────────────────────
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  await bookshelfServer.start({ port, userDataPath: STATE, mode: 'standalone' });

  await check('health reports the reduced capability set', async () => {
    const body = await (await fetch(`${BASE}/api/health`)).json();
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.name, 'health must still name the serving machine');
    assert.deepStrictEqual(body.capabilities, [...STANDALONE_CAPABILITIES]);
    for (const cap of ['render', 'ingest', 'edit', 'queue', 'mutate']) {
      assert.ok(!body.capabilities.includes(cap),
        `a mirror must not advertise '${cap}' — a client would leave that control live`);
    }
  });

  for (const [method, route, capability] of GATED) {
    await check(`${method} ${route} refuses with 501 (${capability})`, async () => {
      const res = await fetch(`${BASE}${route}`, { method });
      assert.strictEqual(res.status, 501, `${route} answered ${res.status}, not 501`);
      const body = await res.json();
      assert.strictEqual(body.capability, capability,
        `${route} must name its capability so the client knows which control to disable`);
      assert.match(body.error, /library-only mirror/);
    });
  }

  await check('the reader TTS socket refuses the upgrade with the same 501', async () => {
    const raw = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(
          'GET /api/reader/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n'
          + 'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
          + 'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      let buf = '';
      s.on('data', (d) => { buf += d; });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('the upgrade was neither answered nor closed')); }, 5000);
    });
    assert.match(raw, /^HTTP\/1\.1 501 /, 'a dropped socket cannot be told from a broken server');
    assert.match(raw, /"capability":"render"/);
  });

  await check('an unknown /api route is still a JSON 404, not a gate refusal', async () => {
    const res = await fetch(`${BASE}/api/not-a-route`);
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await res.json()).error, 'Not found');
  });

  await check('the shelf still lists the library', async () => {
    const res = await fetch(`${BASE}/api/books`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray((await res.json()).books), '/api/books must answer with a books array');
  });

  await check('audio is range-streamed', async () => {
    const whole = await fetch(`${BASE}/api/audio?path=${encodeURIComponent(AUDIO)}`);
    assert.strictEqual(whole.status, 200);
    assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual(Buffer.from(await whole.arrayBuffer()).toString(), AUDIO_BYTES.toString());

    const part = await fetch(`${BASE}/api/audio?path=${encodeURIComponent(AUDIO)}`, {
      headers: { Range: 'bytes=4-9' },
    });
    assert.strictEqual(part.status, 206, 'a mirror that cannot answer a Range cannot be seeked');
    assert.strictEqual(part.headers.get('content-range'), `bytes 4-9/${AUDIO_BYTES.length}`);
    assert.strictEqual(Buffer.from(await part.arrayBuffer()).toString(), AUDIO_BYTES.subarray(4, 10).toString());
  });

  await check('a reader can sign up and their position lands under <library>/.bookshelf/', async () => {
    const created = await fetch(`${BASE}/api/readers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Mirror Tester', pin: '1234' }),
    });
    assert.strictEqual(created.status, 200, 'reader profiles are the mirror\'s job, not the app\'s');
    const { token } = await created.json();
    assert.ok(token, 'sign-up must issue a token');

    const saved = await fetch(`${BASE}/api/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify({ bookPath: AUDIO, kind: 'time', value: 123.5 }),
    });
    assert.strictEqual(saved.status, 200);

    // The state lives ON the library share — that is what lets this server and
    // the app's converge with neither one primary. Per-device files, merged on
    // read, under .bookshelf/books/<bookId>/<device>.json.
    const booksRoot = path.join(LIBRARY, '.bookshelf', 'books');
    assert.ok(fs.existsSync(booksRoot), `nothing was written under ${booksRoot}`);
    const written = fs.readdirSync(booksRoot)
      .flatMap((d) => fs.readdirSync(path.join(booksRoot, d)).map((f) => path.join(booksRoot, d, f)))
      .filter((f) => f.endsWith('.json'));
    assert.ok(written.length > 0, 'the position was accepted but no per-device file appeared');
    const store = JSON.parse(fs.readFileSync(written[0], 'utf-8'));
    const rec = Object.values(store)[0];
    assert.strictEqual(rec.position.value, 123.5);

    const read = await fetch(
      `${BASE}/api/position?bookPath=${encodeURIComponent(AUDIO)}`,
      { headers: { 'X-Reader-Token': token } });
    assert.strictEqual((await read.json()).value, 123.5, 'a written position must read back');
  });

  await bookshelfServer.stop();

  // ── App mode: the gate must be completely silent ───────────────────────────
  //
  // Same singleton, restarted without a mode. These routes may well fail for
  // other reasons in a bare test process (no reader token, no queue) — the only
  // claim here is that NOTHING is refused BY THE GATE.
  const appPort = await freePort();
  const APP = `http://127.0.0.1:${appPort}`;
  await bookshelfServer.start({ port: appPort, userDataPath: STATE });

  await check('app mode advertises every capability', async () => {
    const body = await (await fetch(`${APP}/api/health`)).json();
    assert.deepStrictEqual(body.capabilities, [...BOOKSHELF_CAPABILITIES]);
  });

  for (const [method, route] of GATED) {
    await check(`${method} ${route} is not gated in app mode`, async () => {
      const res = await fetch(`${APP}${route}`, { method });
      if (res.status !== 501) return; // any other status is the handler's own business
      const body = await res.json().catch(() => ({}));
      assert.ok(!body.capability,
        `${route} answered the standalone gate's 501 in APP mode — the app just lost that feature`);
    });
  }

  await bookshelfServer.stop();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${failed === 0 ? 'ok' : 'FAILED'}  bookshelf standalone: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`FAILED  bookshelf standalone: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
