#!/usr/bin/env node
/**
 * HOW MANY CANDIDATES A CORRECTION OFFERS — the voice's ladder, never a literal.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-correct-sentences-takes.js
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `correct-sentences-bridge.ts` pinned `const takes = params.takes ?? 3`. That
 * number was chosen when every take was take 0 at a different sampling
 * TEMPERATURE, so any count was expressible. It is not any more:
 *
 *  · A Crucible `tts` render has no per-request sampling channel at all — the
 *    re-roll REFUSES a caller that hands it temperatures — so the spread the
 *    literal was sized for never crosses.
 *  · narrator does not sample unseeded. It seeds chunk i in the take's own lane,
 *    `seed + index + TAKE_SEED_STRIDE * take` (crucible `docs/PHASE3-TTS.md` §2,
 *    "THE SEED HALF", measured 2026-09-15 after two take-0 renders came back
 *    byte-identical). So three candidates all at take 0 are three copies of one
 *    reading, and only the RUNG moves the draw.
 *  · A `take` past the end of the ladder is refused `unknown_take` and never
 *    clamped. Shipped manifests declare two rungs per fine-tune, so a default
 *    of three candidates asks for rung 3 on a two-rung voice and is refused.
 *
 * The number a voice can offer IS its ladder length minus one — take 0 is the
 * reading already in the book — and that number is the server's, in
 * `VoiceInfo.takes`.
 *
 * ── What this pins ─────────────────────────────────────────────────────────
 *
 *  1. `crucibleVoiceLadder` reads the rung count off the server's own voice row
 *     and reports the venue it decided, so the caller names the same server.
 *  2. A two-rung voice offers ONE candidate; a four-rung voice offers THREE.
 *  3. A row that states no ladder is REFUSED by name, never defaulted to 3.
 *  4. No `?? 3` literal survives in the bridge, and neither does the claim that
 *     the remote takes "vary by unseeded sampling" — a source pin, because the
 *     sentence is what a person reads in the audition window.
 *
 * No GPU, no narrator, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, crucibleHost,
} = require('./fake-crucible.js');

const LADDER = path.join(REPO, 'dist', 'electron', 'crucible', 'voice-ladder.js');
if (!fs.existsSync(LADDER)) {
  console.log('SKIP: dist/electron/crucible/voice-ladder.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

installElectronStub('bf-correct-takes-');

const ladder = require(LADDER);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/** The `pace` block every voice row carries. Shape from the SDK's readVoicePace(). */
const FAKE_PACE = {
  pace_chars_per_sec: 17.28,
  max_chars_per_sec: 22.46,
  min_chars_per_sec: 13.29,
  target_chars: null,
  safe_min_chars: 400,
  safe_max_chars: 800,
};

/** One `GET /v1/voices` row, with the ladder length the check is about. */
function voiceRow(id, takes) {
  return {
    id, display: id, kind: 'checkpoint', language: 'en', narrator_engine: 'higgs-v3',
    backend_supported: true, installed: true, resident: false, loadable: true, reason: null,
    revision: 'rev1', fingerprint: `${id}@rev1`, memory_bytes_estimate: 1,
    estimate_basis: 'declared', max_chars: 800, sample_rate: 24000, takes,
    needs_reference: false,
    pace: FAKE_PACE,
  };
}

function startFake(rows) {
  return startFakeCrucible(async (req, res, ctx) => {
    if (ctx.url.pathname === '/v1/voices' && req.method === 'GET') {
      ctx.state.voicesAsked = (ctx.state.voicesAsked || 0) + 1;
      ctx.send(res, 200, rows);
      return true;
    }
    return false;
  });
}

(async () => {
  await check('a two-rung voice offers ONE candidate, read off the server', async () => {
    const fake = await startFake([voiceRow('deathstalker', 2)]);
    const server = registerFake(fake.url);
    try {
      const read = await ladder.crucibleVoiceLadder({
        runVenue: { server, because: 'the session recorded it' },
        runVenueSource: 'session_state.json',
        host: crucibleHost(server),
        ttsEngine: 'higgs',
        voiceId: 'deathstalker',
      });
      assert.strictEqual(read.server, server, 'the venue it decided must come back with it');
      assert.strictEqual(read.voice, 'deathstalker');
      assert.strictEqual(read.rungs, 2);
      // The count a correction offers, which is what the bridge derives.
      assert.strictEqual(read.rungs - 1, 1,
        'a two-rung voice has exactly one rung above the reading already in the book');
      assert.strictEqual(fake.state.voicesAsked, 1, 'asked ONCE for the whole pass');
    } finally { await fake.close(); }
  });

  await check('a four-rung voice offers THREE', async () => {
    const fake = await startFake([voiceRow('mistborn', 4)]);
    const server = registerFake(fake.url);
    try {
      const read = await ladder.crucibleVoiceLadder({
        runVenue: { server, because: 'the session recorded it' },
        runVenueSource: 'session_state.json',
        host: crucibleHost(server),
        ttsEngine: 'higgs',
        voiceId: 'mistborn',
      });
      assert.strictEqual(read.rungs, 4);
      assert.strictEqual(read.rungs - 1, 3);
    } finally { await fake.close(); }
  });

  await check('a row with no ladder is refused by name, never defaulted', async () => {
    const fake = await startFake([voiceRow('deathstalker', 0)]);
    const server = registerFake(fake.url);
    try {
      await assert.rejects(
        () => ladder.crucibleVoiceLadder({
          runVenue: { server, because: 'the session recorded it' },
          runVenueSource: 'session_state.json',
          host: crucibleHost(server),
          ttsEngine: 'higgs',
          voiceId: 'deathstalker',
        }),
        (err) => {
          assert.strictEqual(err.code, 'crucible_voice_ladder_unreadable', err.message);
          return true;
        });
    } finally { await fake.close(); }
  });

  await check('a voice the server does not serve is refused, naming what it has', async () => {
    const fake = await startFake([voiceRow('owen', 2)]);
    const server = registerFake(fake.url);
    try {
      await assert.rejects(
        () => ladder.crucibleVoiceLadder({
          runVenue: { server, because: 'the session recorded it' },
          runVenueSource: 'session_state.json',
          host: crucibleHost(server),
          ttsEngine: 'higgs',
          voiceId: 'deathstalker',
        }),
        (err) => {
          assert.strictEqual(err.code, 'crucible_unknown_voice', err.message);
          assert.ok(err.message.includes('owen'), 'it must name what the server DOES serve');
          return true;
        });
    } finally { await fake.close(); }
  });

  // ── The bridge's own source: the literal and the stale premise ───────────

  const BRIDGE = fs.readFileSync(
    path.join(REPO, 'electron', 'correct-sentences-bridge.ts'), 'utf8');

  await check('the bridge derives the count and pins no literal', () => {
    assert.ok(!/params\.takes\s*\?\?\s*3/.test(BRIDGE),
      'correct-sentences-bridge.ts still pins `params.takes ?? 3`; the ladder owns the count');
    assert.ok(BRIDGE.includes('crucibleVoiceLadder'),
      'the bridge does not read the voice\'s ladder at all');
  });

  await check('the bridge no longer tells a person the takes are unseeded', () => {
    const unseeded = BRIDGE.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /unseeded/.test(line));
    assert.deepStrictEqual(unseeded, [],
      'correct-sentences-bridge.ts still says narrator\'s sampling is unseeded. It is not: '
      + 'narrator seeds chunk i in the take\'s own lane (`seed + index + TAKE_SEED_STRIDE * '
      + 'take`, crucible docs/PHASE3-TTS.md §2), so two candidates at one take are byte-'
      + `identical and only the RUNG moves the draw:\n  ${unseeded.map(([n, l]) => `${n}: ${l.trim()}`).join('\n  ')}`);
  });

  summary('correct sentences takes');
})();
