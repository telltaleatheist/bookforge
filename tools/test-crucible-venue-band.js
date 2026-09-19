#!/usr/bin/env node
/**
 * THE CHUNK LENGTH BELONGS TO THE MACHINE THAT WILL SPEAK IT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-venue-band.js
 *
 * Owen sent a deathstalker book to the Mac's Crucible on 2026-09-15 and it came
 * back refused before a single second of audio: `chunk_too_long`, "2 chunk(s)
 * are longer than the 800-character cap for 'deathstalker' on mlx-darwin: index
 * 21 is 801, index 68 is 811". The book had been packed on THIS machine, from
 * THIS machine's catalog, and on Windows from the `served` arm's block — the
 * PC's numbers for a render on the Mac. `electron/crucible/stream.ts` had
 * carried the gap as a RULING OWED since the streaming door landed.
 *
 * `electron/crucible/voice-band.ts` is that ruling, and this is its keeper.
 * Phase 15's division: **the engine owns the voice's facts, the client owns the
 * chunking.** Before packing for a venue, read that venue's `GET /v1/voices`
 * row and pack to ITS numbers — ceiling `safe_max_chars` when stated, never
 * above `max_chars`; floor `safe_min_chars`; pace from the same row. The local
 * catalog is never consulted for the ceiling on a Crucible render.
 *
 * What is proved here, against a FAKE Crucible that states 800 while the local
 * catalog in the test states 900:
 *
 *  1. The band read off a row is the SERVER's, and the ceiling rule is
 *     `safe_max_chars` clamped to `max_chars` — a server advertising a safe
 *     ceiling above its own cap does not get to overrule the cap it enforces.
 *  2. A voice the venue does not advertise is refused BY NAME before anything is
 *     packed, and so is a row with no `max_chars` (which is what a host with no
 *     backend block for that voice sends).
 *  3. THE CLAMP: the server states no `target_chars` today, so the local
 *     catalog's target stands — clamped to the venue's ceiling. Local 900 +
 *     venue 800 = 800, never 900.
 *  4. The VOICE DOCUMENT prep hands narrator carries the venue's cap, band and
 *     pace and NOT the local catalog's 900, because that document is what
 *     `python/narrator/text/paragraph_packer.py` packs the book against.
 *  5. The Listen packer, given the venue's stated caps, produces no row over the
 *     venue's cap where the local 900 would have.
 *  6. A render whose chunks are over the venue's cap is refused HERE, by name,
 *     with nothing submitted — the same fact the server would have told us, told
 *     before the whole book crosses the wire.
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { skipLine } = require('./keeper-skip.js');

const REPO = path.resolve(__dirname, '..');
const BAND = path.join(REPO, 'dist', 'electron', 'crucible', 'voice-band.js');

if (!fs.existsSync(BAND)) {
  console.log(skipLine('dist/electron/crucible/voice-band.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

// A userData of our own, and an electron that answers for it — the same
// interception cli/electron-stub.js uses (see tools/test-crucible-render.js).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-venue-band-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const electronStub = {
  app: {
    getPath(name) {
      if (name === 'userData') return USER_DATA;
      if (name === 'temp') return os.tmpdir();
      throw new Error(`test electron stub: app.getPath('${name}') is not stubbed`);
    },
    getAppPath: () => REPO,
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

const band = require(BAND);
const render = require(path.join(REPO, 'dist', 'electron', 'crucible', 'render.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const higgs = require(path.join(REPO, 'dist', 'electron', 'higgs-models.js'));
const listen = require(path.join(REPO, 'dist', 'shared', 'listen-text', 'chunks.js'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake Crucible — the Mac's real answer of 2026-09-15, measured
//
// `deathstalker` on mlx-darwin: max_chars 800, and a pace block whose band is
// 600-800 with NO target. The numbers are Owen's live `GET /v1/voices`, not
// invented, because a fake that answered a looser shape would pass this suite
// and fail against the real server.
// ─────────────────────────────────────────────────────────────────────────────

const MAC_PACE = {
  pace_chars_per_sec: 16.64,
  max_chars_per_sec: 21.63,
  min_chars_per_sec: 12.8,
  target_chars: null,
  safe_min_chars: 600,
  safe_max_chars: 800,
};

function voiceRow(id, over) {
  return Object.assign({
    id,
    display: id,
    kind: 'checkpoint',
    language: 'en',
    narrator_engine: 'higgs-v3',
    backend_supported: true,
    installed: true,
    resident: false,
    loadable: true,
    reason: null,
    revision: 'abc1234',
    fingerprint: `${id}@abc1234`,
    memory_bytes_estimate: 19000000000,
    estimate_basis: 'declared',
    max_chars: 800,
    sample_rate: 24000,
    takes: 1,
    needs_reference: false,
    pace: MAC_PACE,
  }, over || {});
}

/** A fake that serves `rows` on /v1/voices and refuses every submit loudly. */
function startFakeCrucible(rows) {
  const state = { voicesAsked: 0, submitted: [] };
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    if (route === '/v1/voices' && req.method === 'GET') {
      state.voicesAsked += 1;
      return send(res, 200, rows);
    }
    if (route === '/v1/jobs' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        state.submitted.push(JSON.parse(raw));
        send(res, 200, { job_id: 'job-1' });
      });
      return undefined;
    }
    if (route === '/v1/ping') return send(res, 200, { crucible: true, api_version: 1 });
    return send(res, 404, { error: { code: 'not_found', message: route } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const { CrucibleClient } = require('@crucible/client');
const fakesByName = new Map();
const realCrucibleClientFor = servers.crucibleClientFor;
servers.crucibleClientFor = function crucibleClientForWithFakes(name, clientName) {
  const fake = fakesByName.get(name);
  if (!fake) return realCrucibleClientFor(name, clientName);
  return new CrucibleClient({ url: fake.url, token: fake.token, clientName });
};
let registered = 0;
function registerFake(url) {
  const name = `fake${++registered}`;
  fakesByName.set(name, { url, token: 'test-token-abcd' });
  return name;
}
function clientFor(url) {
  return new CrucibleClient({ url, token: 'test-token-abcd', clientName: 'bookforge' });
}

// ─────────────────────────────────────────────────────────────────────────────
// A LOCAL CATALOG THAT BELIEVES 900
//
// The shipped catalog says 800 on both arms today, so a test built on it could
// not tell "the venue's number" from "the same number twice". This voice states
// 900 everywhere a voice can — cap, safe ceiling and target — which is exactly
// the disagreement the ruling is about: the shape the catalog's own prose carried
// until 2026-09-15, when `_targetCharsNote` still read "MLX 900" (it is
// `_chunkLengthNote` now, and it says what the packer really reads).
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_900 = {
  id: 'deathstalker',
  label: 'Deathstalker (test copy that believes 900)',
  kind: 'checkpoint',
  engineVersion: 'v3',
  voice: { checkpoint: { wsl: '/home/telltale/higgs_v3_merged/ds_test_prod' } },
  backends: {
    served: {
      maxChars: 900,
      maxCharsSource: 'catalog',
      safeMinChars: 500,
      safeMaxChars: 900,
      targetChars: 900,
    },
  },
  // A LOCAL pace too, so the venue's three rates can be told from this one.
  pace: {
    median: 15.91, p05: 13.88, p99: 18.14, n: 222,
    method: 'the test catalog\'s own figure, so the venue\'s can be told from it',
    source: 'tools/test-crucible-venue-band.js',
    measuredOn: '2026-09-01',
  },
};

const VENUE_BAND = {
  server: 'mac',
  voice: 'deathstalker',
  maxChars: 800,
  safeMinChars: 600,
  safeMaxChars: 800,
  targetChars: null,
  paceCharsPerSec: 16.64,
  maxCharsPerSec: 21.63,
  minCharsPerSec: 12.8,
};

async function main() {
  console.log('crucible venue band — the engine owns the voice\'s facts\n');

  // ── 1. the band is the server's, and the ceiling is clamped to the cap ──────
  await check('the band read off a row is the SERVER\'s numbers, verbatim', async () => {
    const fake = await startFakeCrucible([voiceRow('deathstalker'), voiceRow('mistborn')]);
    try {
      const { band: b } = await band.crucibleVoiceBand(clientFor(fake.url), 'mac', 'deathstalker');
      assert.strictEqual(b.maxChars, 800, 'the cap is the row\'s max_chars');
      assert.strictEqual(b.safeMaxChars, 800);
      assert.strictEqual(b.safeMinChars, 600, 'the floor is the row\'s, not the catalog\'s 500');
      assert.strictEqual(b.targetChars, null, 'no server states a target on the wire today');
      assert.strictEqual(b.paceCharsPerSec, 16.64, 'the guard\'s pace comes from the same row');
      assert.strictEqual(fake.state.voicesAsked, 1, 'one GET /v1/voices, not one per chunk');
    } finally {
      await fake.close();
    }
  });

  await check('the packing ceiling is safe_max_chars, and NEVER above max_chars', () => {
    assert.strictEqual(band.venuePackingCeiling(VENUE_BAND), 800);
    // A row whose safe ceiling sits inside the cap: the band wins, because the
    // measured band is where the model reads best.
    assert.strictEqual(
      band.venuePackingCeiling({ ...VENUE_BAND, maxChars: 1000, safeMaxChars: 700 }), 700,
    );
    // A row that states none: the cap itself, which is the only number left.
    assert.strictEqual(
      band.venuePackingCeiling({ ...VENUE_BAND, safeMaxChars: null }), 800,
    );
    // A server contradicting itself does not get to overrule the number its own
    // render door enforces.
    assert.strictEqual(
      band.venuePackingCeiling({ ...VENUE_BAND, safeMaxChars: 1200 }), 800,
    );
  });

  // ── 2. refusals by name, before anything is packed ─────────────────────────
  await check('a voice the venue does not advertise is refused BY NAME', async () => {
    const fake = await startFakeCrucible([voiceRow('mistborn'), voiceRow('sigma')]);
    try {
      await assert.rejects(
        () => band.crucibleVoiceBand(clientFor(fake.url), 'mac', 'deathstalker'),
        (err) => {
          assert.strictEqual(err.code, 'crucible_unknown_voice');
          assert.ok(/mistborn, sigma/.test(err.message),
            'the refusal names what the server DOES have, so the fix is obvious');
          return true;
        },
      );
    } finally {
      await fake.close();
    }
  });

  await check('a row with no max_chars is refused BY NAME, never packed around', async () => {
    const fake = await startFakeCrucible([
      voiceRow('deathstalker', { max_chars: null, backend_supported: false, revision: null,
        fingerprint: null, memory_bytes_estimate: null, estimate_basis: null }),
    ]);
    try {
      await assert.rejects(
        () => band.crucibleVoiceBand(clientFor(fake.url), 'mac', 'deathstalker'),
        (err) => {
          assert.strictEqual(err.code, 'crucible_voice_states_no_cap');
          assert.ok(/backend does not support/.test(err.message),
            'a null cap is what a host with no backend block for that voice sends');
          return true;
        },
      );
    } finally {
      await fake.close();
    }
  });

  // ── 3. the clamp ───────────────────────────────────────────────────────────
  await check('THE CLAMP: local target 900 + venue ceiling 800 = 800', () => {
    assert.strictEqual(band.venuePackingTarget(VENUE_BAND, 900), 800,
      'the server stated no preference, so the local target stands — inside the venue\'s ceiling');
    assert.strictEqual(band.venuePackingTarget(VENUE_BAND, 600), 600,
      'a local target already inside the ceiling is left alone');
    assert.strictEqual(band.venuePackingTarget({ ...VENUE_BAND, targetChars: 640 }, 900), 640,
      'a server that DOES state a target states it, and the local one is not consulted');
    assert.strictEqual(band.venuePackingTarget(VENUE_BAND, null), null,
      'neither side states one: nothing is invented here, and the caller refuses by name');
  });

  // ── 4. the voice document prep packs against ───────────────────────────────
  await check('the VOICE DOCUMENT carries the venue\'s cap, band and pace — not the local 900', () => {
    const stated = band.statedBandForDocument(VENUE_BAND, LOCAL_900.backends.served.targetChars);
    const doc = higgs.higgsVoicesDocument(LOCAL_900, { arm: 'wsl', venueBand: stated });
    const entry = doc.deathstalker;
    assert.strictEqual(entry.maxChars, 800, 'the cap is the venue\'s, never the catalog\'s 900');
    assert.strictEqual(entry.safeMaxChars, 800, 'and so is the ceiling the packer packs to');
    assert.strictEqual(entry.safeMinChars, 600, 'and the floor it merges up to');
    assert.strictEqual(entry.targetChars, 800, 'the local 900 survives only as a CLAMPED target');
    assert.strictEqual(entry.paceCharsPerSec, 16.64,
      'the guard is centred on the pace the rendering machine measured');
    assert.strictEqual(entry.minCharsPerSec, 12.8);
    assert.ok(/crucible "mac"/.test(entry._venueNote || ''),
      'the document says WHOSE numbers these are, so a post-mortem can tell');
  });

  await check('with no venue the document is the local catalog\'s, unchanged', () => {
    const doc = higgs.higgsVoicesDocument(LOCAL_900, { arm: 'wsl' });
    assert.strictEqual(doc.deathstalker.maxChars, 900,
      'a LOCAL render is the local engine, and the catalog is how it was configured');
    assert.strictEqual(doc.deathstalker.safeMaxChars, 900);
  });

  // ── 5. what the Listen packer does with the two answers ────────────────────
  await check('no Listen row exceeds the venue\'s 800 where the local 900 would have', () => {
    // Enough sentences for the ramp (300 -> 600 -> ceiling) to reach the top and
    // stay there — a short block would be packed identically by both bands and
    // would prove nothing about which number was read.
    const units = [];
    for (let i = 0; i < 60; i++) {
      units.push(`This is sentence number ${i}, and it runs on for a good while yet so that `
        + 'the greedy fill has something to fill with.');
    }
    const venueRows = listen.packListenChunks(
      units, listen.listenBandFromCaps('deathstalker', { safeMinChars: 600, safeMaxChars: 800, maxChars: 800 }),
    );
    const localRows = listen.packListenChunks(
      units, listen.listenBandFromCaps('deathstalker', { safeMinChars: 500, safeMaxChars: 900, maxChars: 900 }),
    );
    for (const row of venueRows) {
      assert.ok(row.length <= 800, `a row of ${row.length} chars is over the venue's cap of 800`);
    }
    assert.ok(localRows.some((r) => r.length > 800),
      'the local catalog\'s 900 really would have packed over the venue\'s cap — otherwise '
      + 'this test proves nothing about which number was used');
  });

  // ── 6. the submit-time refusal ─────────────────────────────────────────────
  await check('a chunk over the venue\'s cap is refused HERE, with nothing submitted', async () => {
    const fake = await startFakeCrucible([voiceRow('deathstalker')]);
    const server = registerFake(fake.url);
    const sentencesDir = path.join(WORK, 'sentences');
    fs.mkdirSync(sentencesDir, { recursive: true });
    try {
      await assert.rejects(
        () => render.runCrucibleRender({
          server,
          renderId: 'venue-band-1',
          voice: 'deathstalker',
          language: 'en',
          chunks: [
            { index: 20, text: 'Short enough.' },
            // The two rows Owen's render was refused for, to the character.
            { index: 21, text: `[break]${'a'.repeat(794)}` },
            { index: 68, text: 'b'.repeat(811) },
          ],
          sentencesDir,
        }),
        (err) => {
          assert.strictEqual(err.code, 'crucible_chunk_over_venue_cap');
          assert.ok(/index 21 is 801, 68 is 811/.test(err.message),
            `the refusal names the chunks and their lengths: ${err.message}`);
          return true;
        },
      );
      assert.strictEqual(fake.state.submitted.length, 0,
        'nothing crosses the wire — the whole point of asking before submitting');
    } finally {
      await fake.close();
    }
  });

  await check('a book inside the venue\'s cap is submitted unchanged', async () => {
    const fake = await startFakeCrucible([voiceRow('deathstalker')]);
    const server = registerFake(fake.url);
    const sentencesDir = path.join(WORK, 'sentences-ok');
    fs.mkdirSync(sentencesDir, { recursive: true });
    const chunks = [
      { index: 0, text: `[break]${'a'.repeat(793)}` },
      { index: 1, text: 'b'.repeat(800) },
    ];
    try {
      // The fake answers the submit and then never streams events, so the render
      // is abandoned rather than awaited — what is under test is the door, and
      // the event stream has its own suite (tools/test-crucible-render.js).
      const running = render.runCrucibleRender({
        server, renderId: 'venue-band-2', voice: 'deathstalker', language: 'en',
        chunks, sentencesDir,
      });
      running.catch(() => {});
      const deadline = Date.now() + 5000;
      while (fake.state.submitted.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.strictEqual(fake.state.submitted.length, 1,
        'a chunk exactly AT the cap is inside it — the refusal is `>`, not `>=`');
      assert.deepStrictEqual(fake.state.submitted[0].params.chunks, chunks,
        'the chunks go up exactly as packed; nothing here re-splits or trims them');
    } finally {
      await fake.close();
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().then(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* the temp dir outlives us */ }
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
