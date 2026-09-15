#!/usr/bin/env node
/**
 * A SENTENCE RE-ROLL ON SOMEBODY ELSE'S CARD, AND THE ONE KNOB THAT CANNOT GO.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-reroll.js
 *
 * `electron/crucible/reroll.ts` re-renders exactly the indices a person picked
 * in Correct Sentences as a Crucible `tts` job, landing `take<k>/<index>.flac`
 * where the local narrator worker lands them. Against a FAKE Crucible this pins:
 *
 *  1. THE REFUSAL THAT MATTERS: the local path spreads its takes across sampling
 *     temperatures and a `tts` render has NO sampling channel, so a caller that
 *     hands them over is refused BY NAME. Sending the job without them and
 *     calling it the same pass is the silent substitution this exists to stop.
 *  2. One job per take, each carrying EVERY named index (a denominator, unlike
 *     streaming), at take 0 — the rung the engine climbs itself.
 *  3. `take<k>/<index>.flac` under the local naming, with its provenance beside
 *     it, and the chunk TEXT on the wire because a Crucible has no session to
 *     read `chapter_sentences` out of.
 *  4. The guard verdict of every chunk reaches the ledger, keyed per take —
 *     three takes of one sentence are three renders, not three chunks.
 *  5. Every refusal by name and none retried: an empty chunk list, a chunk with
 *     no text, a non-Higgs engine, a voice the server does not serve,
 *     `server_busy` with the holder's line — and NO local re-roll instead.
 *  6. The venue door: the legacy switch re-rolls on the local narrator and says
 *     so; the run's venue beats the routing record; a caller naming a different
 *     server is refused.
 *
 * No GPU, no narrator, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer,
  crucibleHost, legacyHost,
} = require('./fake-crucible');

const REROLL = path.join(REPO, 'dist', 'electron', 'crucible', 'reroll.js');
if (!fs.existsSync(REROLL)) {
  console.log('SKIP: dist/electron/crucible/reroll.js is not built — run npx tsc -p tsconfig.electron.json');
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-reroll-');
const reroll = require(REROLL);
const render = require(path.join(REPO, 'dist', 'electron', 'crucible', 'render.js'));
const ledger = require(path.join(REPO, 'dist', 'electron', 'chunk-guard-ledger.js'));
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

function voiceRow(id) {
  return {
    id, display: id, kind: 'checkpoint', language: 'en', narrator_engine: 'higgs-v3',
    backend_supported: true, installed: true, resident: false, loadable: true, reason: null,
    revision: 'rev1', fingerprint: `${id}@rev1`, memory_bytes_estimate: 1,
    estimate_basis: 'declared', max_chars: 800, sample_rate: 24000, takes: 1,
    // A checkpoint's voice is in its weights: loading one WITH a clip is
    // `reference_not_allowed`. The field is required on every row since the
    // 0.6.0 SDK (PHASE3-TTS.md §5's amendment) and the SDK refuses the whole
    // document by name without it, so it is stated rather than omitted.
    needs_reference: false,
    pace: FAKE_PACE,
  };
}

/** A real `GuardPlan.verdict()` object, shaped from PHASE6-REMOTE-RENDER.md §3. */
function verdictObject(word) {
  return {
    verdict: word,
    clean: word === 'clean',
    parts: 1,
    band: { max_chars_per_sec: 22.46, min_chars_per_sec: 13.29, reference: 17.28, observed: 4, warm: false },
    takes: word === 'clean' ? [] : [{ index: 0, action: word, chars: 120, seconds: 7.1 }],
  };
}

/**
 * The fake tts server. `behaviour`:
 *   'run'         both voices served; every chunk renders with a guard verdict
 *   'no-voice'    `/v1/voices` serves a different voice only
 *   'busy'        the submit is 409 server_busy
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/voices' && req.method === 'GET') {
      state.voicesAsked = (state.voicesAsked || 0) + 1;
      send(res, 200, behaviour === 'no-voice' ? [voiceRow('owen')] : [voiceRow('mistborn'), voiceRow('deathstalker')]);
      return true;
    }

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      if (behaviour === 'busy') {
        send(res, 409, { error: { code: 'server_busy', message: 'one at a time', details: {
          holder: 'foundry', job_id: 'j-held', type: 'tts', model: 'deathstalker', status: 'running',
          since: '2026-09-14T01:00:00Z', progress: 0.62, message: '640 of 1030 chunk(s) rendered',
        } } });
        return true;
      }
      const id = ctx.newJobId();
      state.jobs.set(id, { chunks: body.params.chunks, voice: body.model });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const j = state.jobs.get(decodeURIComponent(events[1]));
      assert.ok(j, `the fake was asked for events of an unknown job: ${events[1]}`);
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      const names = [];
      j.chunks.forEach((chunk, n) => {
        sse.frame('chunk', {
          index: chunk.index, seconds: 7.1, chars: chunk.text.length,
          chars_per_sec: chunk.text.length / 7.1, tokens: null, capped: null, take: 0,
          guard: verdictObject(n === 1 ? 'rerolled' : 'clean'),
        });
        const name = `${chunk.index}.flac`;
        names.push(name);
        sse.frame('artifact', { name });
        sse.frame('progress', {
          fraction: (n + 1) / j.chunks.length,
          message: `${n + 1} of ${j.chunks.length} chunk(s) rendered`,
          rendered: n + 1, failed: 0, total: j.chunks.length,
        });
      });
      sse.frame('done', {
        artifacts: names, rendered: names.length, failed: [], take: 0, sample_rate: 24000,
      });
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const j = state.jobs.get(decodeURIComponent(artifact[1]));
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, {
          server: { name: 'fake-crucible', version: '0.5.0' },
          backend: 'cuda-linux',
          job_type: 'tts',
          model: { id: j.voice, revision: 'rev1', fingerprint: `${j.voice}@rev1` },
          params: {},
          started: '2026-09-14T02:00:00Z',
          finished: '2026-09-14T02:04:00Z',
          artifact: name.replace(/\.provenance\.json$/, ''),
        });
        return true;
      }
      const bytes = Buffer.from(`fLaC-fake-${name}`);
      res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': bytes.length });
      res.end(bytes);
      return true;
    }
    return false;
  });
}

function freshScratch() {
  const dir = fs.mkdtempSync(path.join(work, 'candidates-'));
  return dir;
}

const CHUNKS = [
  { index: 41, text: '[heading]Chapter Eight.[/heading]' },
  { index: 42, text: 'He had been walking for some time.' },
];

async function theRefusalThatMatters() {
  await check('per-take sampling temperatures are REFUSED by name — the tts wire has no sampling channel', async () => {
    await assert.rejects(
      reroll.runCrucibleReroll({
        server: 'never', renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn',
        language: 'en', chunks: CHUNKS, targetDir: freshScratch(), takes: 3,
        takeTemperatures: [0.4, 0.8, 1.0],
      }),
      (err) => err.code === 'crucible_reroll_take_temperatures_unsupported'
        && /RULING OWED/.test(err.message)
        && /0\.4, 0\.8, 1/.test(err.message),
    );
  });
  await check('the refusal names the alternative, so the operator is not left guessing', async () => {
    let caught = null;
    try {
      await reroll.runCrucibleReroll({
        server: 'never', renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn',
        language: 'en', chunks: CHUNKS, targetDir: freshScratch(), takeTemperatures: [0.6],
      });
    } catch (err) { caught = err; }
    assert.ok(/local narrator/.test(caught.message), caught.message);
    assert.ok(/unseeded/.test(caught.message), caught.message);
  });
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const targetDir = freshScratch();
  const progress = [];
  const log = [];
  let outcome;
  try {
    outcome = await reroll.runCrucibleReroll({
      server, renderId: 'sess-abc', ttsEngine: 'higgs', voiceId: 'mistborn',
      language: 'en', chunks: CHUNKS, targetDir, takes: 3,
      onProgress: (p) => progress.push(p), onLog: (l) => log.push(l),
    });
  } finally {
    await fake.close();
  }
  await check('one job per take, each carrying EVERY named index, at take 0', () => {
    assert.strictEqual(fake.state.submitted.length, 3);
    for (const body of fake.state.submitted) {
      assert.strictEqual(body.type, 'tts');
      assert.strictEqual(body.model, 'mistborn', 'for tts the model IS the voice');
      assert.strictEqual(body.params.take, 0);
      assert.strictEqual(body.params.language, 'en');
      assert.deepStrictEqual(body.params.chunks.map((c) => c.index), [41, 42]);
      assert.deepStrictEqual(body.inputs, {}, 'a render uploads nothing');
    }
  });
  await check('the chunk TEXT crosses — a Crucible has no session to read chapter_sentences out of', () => {
    assert.strictEqual(fake.state.submitted[0].params.chunks[0].text, '[heading]Chapter Eight.[/heading]');
    assert.strictEqual(fake.state.submitted[0].params.chunks[1].text, 'He had been walking for some time.');
  });
  await check('the server was asked whether it serves the voice ONCE for the whole pass', () => {
    assert.strictEqual(fake.state.voicesAsked, 1);
  });
  await check('take<k>/<index>.flac lands under the local naming, with its provenance beside it', () => {
    for (const k of [0, 1, 2]) {
      for (const index of [41, 42]) {
        const file = path.join(targetDir, `take${k}`, `${index}.flac`);
        assert.ok(fs.existsSync(file), file);
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), `fLaC-fake-${index}.flac`);
        assert.ok(fs.existsSync(`${file}.provenance.json`));
      }
    }
    assert.strictEqual(outcome.written, 6);
    assert.strictEqual(outcome.takes.length, 3);
    assert.strictEqual(outcome.takes[1].dir, path.join(targetDir, 'take1'));
    assert.strictEqual(reroll.takeDirName(2), 'take2');
  });
  await check('every chunk\'s guard verdict reached the ledger, keyed PER TAKE', () => {
    for (const take of outcome.takes) {
      assert.strictEqual(take.guard.chunks, 2, `take ${take.take} recorded two chunks, not six`);
      assert.deepStrictEqual(take.guard.byVerdict, { clean: 1, rerolled: 1 });
      assert.strictEqual(take.guard.unknown, 0);
      assert.deepStrictEqual(take.guard.sources, ['crucible-chunk']);
    }
    // The summaries POP, so nothing is left behind for a later pass to add to.
    assert.strictEqual(ledger.summarizeChunkGuards('sess-abc#take0').chunks, 0);
    assert.strictEqual(ledger.summarizeChunkGuards('sess-abc').chunks, 0,
      'a re-roll never writes into the book render\'s own summary');
  });
  await check('the SERVER\'s fraction reaches the caller, with the take it belongs to', () => {
    assert.deepStrictEqual([...new Set(progress.map((p) => p.take))], [0, 1, 2]);
    assert.strictEqual(progress[progress.length - 1].fraction, 1);
    assert.strictEqual(progress[progress.length - 1].total, 6, 'indices × takes');
    assert.ok(log.some((l) => /2 sentence\(s\) × 3 take\(s\)/.test(l)), log.join('\n'));
  });
}

async function refusals() {
  const base = {
    server: 'never', renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn',
    language: 'en', chunks: CHUNKS,
  };
  await check('an empty chunk list, a chunk with no text and a bad index are each refused by name', async () => {
    await assert.rejects(reroll.runCrucibleReroll({ ...base, chunks: [], targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_no_chunks');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, chunks: [{ index: 3, text: '  ' }], targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_text_missing');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, chunks: [{ index: -1, text: 'x' }], targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_index_unreadable');
  });
  await check('a missing scratch root, an unnamed server, an unnamed language and a bad take count are refused', async () => {
    await assert.rejects(reroll.runCrucibleReroll({ ...base, targetDir: path.join(work, 'nope') }),
      (err) => err.code === 'crucible_reroll_target_missing');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, server: '', targetDir: freshScratch() }),
      (err) => err.code === 'crucible_server_not_named');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, language: '', targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_language_not_named');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, takes: 0, targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_takes_unreadable');
    await assert.rejects(reroll.runCrucibleReroll({ ...base, renderId: '', targetDir: freshScratch() }),
      (err) => err.code === 'crucible_reroll_not_identified');
  });
  await check('an Orpheus session is refused by name — every Crucible voice declares higgs-v3', async () => {
    await assert.rejects(
      reroll.runCrucibleReroll({ ...base, ttsEngine: 'orpheus', voiceId: 'mistborn', targetDir: freshScratch() }),
      (err) => err.code === 'crucible_engine_unsupported',
    );
  });

  for (const [behaviour, code, submits] of [['no-voice', 'crucible_unknown_voice', 0], ['busy', 'server_busy', 1]]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    const targetDir = freshScratch();
    let caught = null;
    try {
      await reroll.runCrucibleReroll({ ...base, server, targetDir, takes: 2 });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code}, ${submits} submit(s), nothing re-rolled here instead`, () => {
      assert.ok(caught instanceof render.CrucibleRenderRefused, `got ${caught}`);
      assert.strictEqual(caught.code, code);
      assert.strictEqual(fake.state.submitted.length, submits);
      const landed = fs.existsSync(path.join(targetDir, 'take0'))
        ? fs.readdirSync(path.join(targetDir, 'take0')) : [];
      assert.deepStrictEqual(landed, []);
      if (behaviour === 'busy') {
        assert.strictEqual(caught.busyLine, 'busy: foundry, tts deathstalker, 62% done — 640 of 1030 chunk(s) rendered');
      }
      if (behaviour === 'no-voice') assert.ok(/owen/.test(caught.message), 'names what it does serve');
    });
  }
}

async function venueDoor() {
  {
    let localCalls = 0;
    const log = [];
    const outcome = await reroll.rerollAtVenue({
      host: legacyHost(),
      renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn', language: 'en',
      chunks: CHUNKS, targetDir: freshScratch(), takes: 3,
      // The local arm is the one that CAN spread the temperatures; the door
      // carries them to it and they never reach the Crucible arm.
      takeTemperatures: [0.4, 0.8, 1.0],
      legacyLocal: async () => { localCalls += 1; },
      onLog: (l) => log.push(l),
    });
    await check('the legacy switch re-rolls on the local narrator and says so', () => {
      assert.strictEqual(localCalls, 1);
      assert.strictEqual(outcome.venue.where, 'legacy-local-narrator');
      assert.strictEqual(outcome.crucible, undefined);
      assert.ok(log.some((l) => /local narrator spawn/.test(l) && /decided here/.test(l)), log.join('\n'));
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const targetDir = freshScratch();
    let localCalls = 0;
    let outcome;
    try {
      outcome = await reroll.rerollAtVenue({
        host: crucibleHost(server),
        renderId: 'sess-2', ttsEngine: 'higgs', voiceId: 'deathstalker', language: 'en',
        chunks: CHUNKS, targetDir, takes: 1,
        legacyLocal: async () => { localCalls += 1; },
      });
    } finally {
      await fake.close();
    }
    await check('a routed server re-rolls on the Crucible, never the local spawn', () => {
      assert.strictEqual(localCalls, 0);
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server, origin: 'decided here', because: 'the top-ranked server' });
      assert.strictEqual(outcome.crucible.written, 2);
      assert.ok(fs.existsSync(path.join(targetDir, 'take0', '41.flac')));
    });
  }
  {
    // THE RUN'S VENUE WINS OVER THE ROUTING RECORD: the book rendered on one
    // machine; its corrections re-roll on the same one.
    const mine = await startFake('run');
    const other = await startFake('run');
    const mineName = registerFake(mine.url);
    const otherName = registerFake(other.url);
    const targetDir = freshScratch();
    let outcome;
    try {
      outcome = await reroll.rerollAtVenue({
        runVenue: { where: 'crucible', server: mineName }, runVenueSource: 'session_state.json',
        host: crucibleHost(otherName),
        renderId: 'sess-3', ttsEngine: 'higgs', voiceId: 'mistborn', language: 'en',
        chunks: CHUNKS, targetDir, takes: 1,
        legacyLocal: async () => { throw new Error('must not run locally'); },
      });
    } finally {
      await mine.close();
      await other.close();
    }
    await check('a book rendered on one server re-rolls there, not on the top-ranked other', () => {
      assert.strictEqual(mine.state.submitted.length, 1);
      assert.strictEqual(other.state.submitted.length, 0);
      assert.strictEqual(outcome.venue.origin, 'the run');
    });
  }
  {
    await assert.rejects(
      reroll.rerollAtVenue({
        runVenue: { where: 'crucible', server: 'mac' }, crucible: { server: 'local' },
        host: crucibleHost('local'),
        renderId: 'sess-4', ttsEngine: 'higgs', voiceId: 'mistborn', language: 'en',
        chunks: CHUNKS, targetDir: freshScratch(),
        legacyLocal: async () => { throw new Error('no'); },
      }),
      (err) => err.code === 'run_venue_disagrees',
    );
    await check('a caller naming a server the run did not go to is refused by name', () => {});
  }
}

(async () => {
  await theRefusalThatMatters();
  await happyPath();
  await refusals();
  await venueDoor();
  summary('test-crucible-reroll');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
