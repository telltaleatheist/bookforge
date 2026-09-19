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
 *  1. THE REFUSAL THAT MATTERS: the local path spread its takes across sampling
 *     temperatures and a `tts` render has NO sampling channel, so a caller that
 *     hands them over is refused BY NAME. Sending the job without them and
 *     calling it the same pass is the silent substitution this exists to stop.
 *  2. **N CANDIDATES ARE N RUNGS, AND THE FIRST IS RUNG 1.** One job per
 *     candidate, each carrying EVERY named index (a denominator, unlike
 *     streaming), each at its OWN rung: 3 candidates submit takes 1, 2, 3 —
 *     distinct, and never 0. Until 2026-09-18 every one of them went out at
 *     take 0 on the premise that "narrator's sampling is unseeded"; the premise
 *     was false (`HiggsConfig.seed` defaults to 1234, `_seed_for` is
 *     `seed + index`, and only `in_take_lane` moves the draw), so a person who
 *     asked for three alternative readings got three copies of the one they had
 *     rejected. This case is what would have caught it.
 *  3. A pass that asks for more candidates than the voice's ladder has rungs
 *     above 0 is REFUSED BY NAME with BOTH numbers, before a single submit —
 *     never clamped to the top rung, never quietly rendered fewer times, and
 *     never cycled back down onto a rung another candidate already used (one
 *     rung is one seed lane, so that pair would be byte-identical again).
 *  4. `take<k>/<index>.flac` under the local naming — the directory keeps
 *     counting CANDIDATES, not rungs — with its provenance beside it, and the
 *     chunk TEXT on the wire because a Crucible has no session to read
 *     `chapter_sentences` out of.
 *  5. The guard verdict of every chunk reaches the ledger, keyed per candidate —
 *     three candidates of one sentence are three renders, not three chunks.
 *  6. Every refusal by name and none retried: an empty chunk list, a chunk with
 *     no text, a non-Higgs engine, a voice the server does not serve,
 *     `server_busy` with the holder's line — and NO local re-roll instead.
 *  7. The venue door: the legacy switch re-rolls on the local narrator and says
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
  crucibleHost, noServerHost,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const REROLL = path.join(REPO, 'dist', 'electron', 'crucible', 'reroll.js');
if (!fs.existsSync(REROLL)) {
  console.log(skipLine('dist/electron/crucible/reroll.js is not built — run npx tsc -p tsconfig.electron.json'));
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

/**
 * `takes` is the LADDER'S LENGTH — rungs `0 .. takes - 1` — and the SDK reads it
 * with `num(entry, 'takes')`, so a row without it fails the whole document.
 *
 * FOUR here, not the two every shipped voice manifest declares today, because
 * the happy path asks for three candidates and three candidates need rungs 1, 2
 * and 3 to exist. `shortLadder()` below is the real catalog's shape and is what
 * pins the refusal.
 */
function voiceRow(id, takes = 4) {
  return {
    id, display: id, kind: 'checkpoint', language: 'en', narrator_engine: 'higgs-v3',
    backend_supported: true, installed: true, resident: false, loadable: true, reason: null,
    revision: 'rev1', fingerprint: `${id}@rev1`, memory_bytes_estimate: 1,
    estimate_basis: 'declared', max_chars: 800, sample_rate: 24000, takes,
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
 *   'run'           both voices served, four-rung ladders; every chunk renders
 *                   with a guard verdict
 *   'short-ladder'  both voices served with the TWO rungs every shipped
 *                   manifest declares (`[[voice.takes]]`: the boson default and
 *                   the one measured alternative at 0.7)
 *   'no-voice'      `/v1/voices` serves a different voice only
 *   'busy'          the submit is 409 server_busy
 */
function startFake(behaviour) {
  const rungs = behaviour === 'short-ladder' ? 2 : 4;
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/voices' && req.method === 'GET') {
      state.voicesAsked = (state.voicesAsked || 0) + 1;
      send(res, 200, behaviour === 'no-voice'
        ? [voiceRow('owen')]
        : [voiceRow('mistborn', rungs), voiceRow('deathstalker', rungs)]);
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
      // A real server refuses a rung its manifest does not declare
      // (`unknown_take`) and NEVER clamps, so the fake does the same — that is
      // what makes "the client asked before it submitted" a testable claim
      // rather than a comment.
      if (!Number.isInteger(body.params.take) || body.params.take < 0 || body.params.take >= rungs) {
        send(res, 400, { error: { code: 'unknown_take', message:
          `voice '${body.model}' has no take ${body.params.take}; it declares ${rungs} take(s), `
          + `0 to ${rungs - 1}`,
        } });
        return true;
      }
      const id = ctx.newJobId();
      state.jobs.set(id, { chunks: body.params.chunks, voice: body.model, take: body.params.take });
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
          chars_per_sec: chunk.text.length / 7.1, tokens: null, capped: null, take: j.take,
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
        artifacts: names, rendered: names.length, failed: [], take: j.take, sample_rate: 24000,
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
        && /0\.4, 0\.8, 1/.test(err.message),
    );
  });
  await check('the refusal names the alternative — the LADDER, which is what replaced the spread', async () => {
    let caught = null;
    try {
      await reroll.runCrucibleReroll({
        server: 'never', renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn',
        language: 'en', chunks: CHUNKS, targetDir: freshScratch(), takeTemperatures: [0.6],
      });
    } catch (err) { caught = err; }
    assert.ok(/take ladder/.test(caught.message), caught.message);
    assert.ok(/rung k \+ 1/.test(caught.message), caught.message);
    // The old message offered "N jobs at take 0, genuinely different because
    // narrator's sampling is unseeded". It is seeded (`seed + index`), so that
    // sentence promised a spread it could not deliver and must not come back.
    assert.ok(!/unseeded/.test(caught.message), caught.message);
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
  await check('one job per candidate, each carrying EVERY named index', () => {
    assert.strictEqual(fake.state.submitted.length, 3);
    for (const body of fake.state.submitted) {
      assert.strictEqual(body.type, 'tts');
      assert.strictEqual(body.model, 'mistborn', 'for tts the model IS the voice');
      assert.strictEqual(body.params.language, 'en');
      assert.deepStrictEqual(body.params.chunks.map((c) => c.index), [41, 42]);
      assert.deepStrictEqual(body.inputs, {}, 'a render uploads nothing');
    }
  });
  await check('THE FIX: 3 candidates go out at takes 1, 2, 3 — distinct rungs, and none is 0', () => {
    const asked = fake.state.submitted.map((b) => b.params.take);
    assert.deepStrictEqual(asked, [1, 2, 3],
      'candidate k renders at rung k + 1; three jobs at take 0 are three copies of the reading '
      + 'the person just rejected (seed = 1234 + index, moved only by in_take_lane)');
    assert.strictEqual(new Set(asked).size, 3, 'no two candidates share a rung, i.e. a seed lane');
    assert.ok(!asked.includes(0), 'rung 0 is the draw the rejected take was already rendered at');
  });
  await check('the rung rides on the outcome, beside the candidate it produced', () => {
    assert.deepStrictEqual(outcome.takes.map((t) => [t.take, t.rung]), [[0, 1], [1, 2], [2, 3]]);
  });
  await check('the chunk TEXT crosses — a Crucible has no session to read chapter_sentences out of', () => {
    assert.strictEqual(fake.state.submitted[0].params.chunks[0].text, '[heading]Chapter Eight.[/heading]');
    assert.strictEqual(fake.state.submitted[0].params.chunks[1].text, 'He had been walking for some time.');
  });
  await check('the server was asked whether it serves the voice ONCE for the whole pass', () => {
    assert.strictEqual(fake.state.voicesAsked, 1);
  });
  await check('take<k>/ still counts CANDIDATES, not rungs — it is what the bridge collects', () => {
    // Candidate 0 lives in take0/ and was rendered at rung 1. The directory
    // name is the audition order a person sees; the rung is provenance.
    assert.deepStrictEqual(
      fs.readdirSync(targetDir).sort(), ['take0', 'take1', 'take2'],
      'a rung-named directory here would silently re-order the audition list',
    );
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
  await check('the log says which rungs were climbed, so a listener can read the audition', () => {
    assert.ok(log.some((l) => /rungs 1-3 of mistborn's 4-rung ladder/.test(l)), log.join('\n'));
    for (const rung of [1, 2, 3]) {
      assert.ok(log.some((l) => new RegExp(`at take rung ${rung} of 4`).test(l)), log.join('\n'));
    }
  });
}

/**
 * THE LADDER IS SHORT AND ITS END IS A REFUSAL.
 *
 * Every shipped `crucible/voices/*.toml` declares TWO rungs — take 0, the boson
 * default, and take 1 at temperature 0.7 with the measurement that chose it — so
 * a two-rung voice has exactly ONE rung a candidate may use. Correct Sentences
 * asks for three by default, and that is refused here, by name, with both
 * numbers, before a single job is submitted: not clamped to rung 1 three times
 * (one rung is one seed lane, so those three would be byte-identical), not
 * quietly rendered once, and not sent for the server to refuse `unknown_take` on
 * the second job after the first has already run.
 */
async function ladderTooShort() {
  const fake = await startFake('short-ladder');
  const server = registerFake(fake.url);
  const targetDir = freshScratch();
  let caught = null;
  try {
    await reroll.runCrucibleReroll({
      server, renderId: 'sess-short', ttsEngine: 'higgs', voiceId: 'mistborn',
      language: 'en', chunks: CHUNKS, targetDir, takes: 3,
    });
  } catch (err) { caught = err; } finally { await fake.close(); }
  await check('3 candidates against a two-rung ladder is refused BY NAME, naming both numbers', () => {
    assert.ok(caught !== null, 'it must not have quietly succeeded');
    assert.strictEqual(caught.code, 'crucible_reroll_ladder_too_short', caught.message);
    assert.ok(/3 candidate\(s\)/.test(caught.message), caught.message);
    assert.ok(/2 rung\(s\)/.test(caught.message), caught.message);
    assert.ok(/only 1 above rung 0/.test(caught.message), caught.message);
  });
  await check('and it is refused BEFORE anything is submitted or any take dir filled', () => {
    assert.strictEqual(fake.state.submitted.length, 0, 'nothing partial ran first');
    assert.strictEqual(fake.state.voicesAsked, 1, 'the ladder came off the voice row already read');
    assert.deepStrictEqual(fs.readdirSync(targetDir), []);
  });

  // The rung that DOES exist still works: one candidate on a two-rung ladder is
  // rung 1, the measured alternative, which is the whole point of the ruling.
  const ok = await startFake('short-ladder');
  const okServer = registerFake(ok.url);
  const okDir = freshScratch();
  let outcome;
  try {
    outcome = await reroll.runCrucibleReroll({
      server: okServer, renderId: 'sess-short-ok', ttsEngine: 'higgs', voiceId: 'mistborn',
      language: 'en', chunks: CHUNKS, targetDir: okDir, takes: 1,
    });
  } finally { await ok.close(); }
  await check('one candidate on a two-rung ladder is rung 1 — the measured alternative', () => {
    assert.deepStrictEqual(ok.state.submitted.map((b) => b.params.take), [1]);
    assert.strictEqual(outcome.takes[0].rung, 1);
    assert.strictEqual(outcome.takes[0].dir, path.join(okDir, 'take0'));
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
    /*
     * THE LOCAL NARRATOR ARM IS GONE — and it was the one that could spread the
     * per-take temperatures. What replaced that spread is not a sampling
     * channel (the "owed" one at ROLLOUT_PLAN B4 was answered the other way):
     * it is the voice's take ladder, climbed a rung per candidate. This case
     * used to pin the legacy switch reaching `regenerateSentenceIndices`; that
     * switch and the spawn behind it are deleted (docs/LEGACY-REMOVAL.md), so
     * with nothing to place the pass on the door REFUSES BY NAME and re-rolls
     * nothing here.
     */
    const targetDir = freshScratch();
    let caught = null;
    try {
      await reroll.rerollAtVenue({
        host: noServerHost(),
        renderId: 'sess-1', ttsEngine: 'higgs', voiceId: 'mistborn', language: 'en',
        chunks: CHUNKS, targetDir, takes: 3,
      });
    } catch (err) { caught = err; }
    await check('with nothing enabled the door refuses by name and re-rolls nothing here', () => {
      assert.ok(caught !== null, 'it must not have quietly succeeded');
      assert.strictEqual(caught.code, 'no_enabled_server', caught.message);
      assert.ok(!fs.existsSync(path.join(targetDir, 'take0')), 'nothing re-rolled locally instead');
    });
    await check('the reroll door takes no local callback at all', () => {
      const srcTs = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'reroll.ts'), 'utf-8');
      assert.ok(!/legacyLocal/.test(srcTs),
        'a `legacyLocal` option is a fallback wearing an option\'s hat');
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const targetDir = freshScratch();
    const localCalls = 0;
    let outcome;
    try {
      outcome = await reroll.rerollAtVenue({
        host: crucibleHost(server),
        renderId: 'sess-2', ttsEngine: 'higgs', voiceId: 'deathstalker', language: 'en',
        chunks: CHUNKS, targetDir, takes: 1,
      });
    } finally {
      await fake.close();
    }
    await check('a routed server re-rolls on the Crucible, never the local spawn', () => {
      assert.strictEqual(localCalls, 0);
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server, origin: 'decided here', because: 'the first enabled server that answered' });
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
      }),
      (err) => err.code === 'run_venue_disagrees',
    );
    await check('a caller naming a server the run did not go to is refused by name', () => {});
  }
}

(async () => {
  await theRefusalThatMatters();
  await happyPath();
  await ladderTooShort();
  await refusals();
  await venueDoor();
  summary('test-crucible-reroll');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
