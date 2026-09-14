#!/usr/bin/env node
/**
 * THE ONE JOB HELPER EVERY CRUCIBLE DOOR SHARES, AND EVERY WAY IT ANSWERS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-job.js
 *
 * `electron/crucible/job.ts` is the conversation every job type has with a
 * Crucible — upload, submit, follow the events, land the artifacts — written
 * once so `asr.ts`, `align.ts` and (later) `render.ts` only say WHAT they
 * want. Against a FAKE Crucible speaking the real routes, this pins:
 *
 *  1. Inputs cross the wire as uploads — the bytes and the names — and the
 *     submit names each one by its blob id, with the type, model and params
 *     exactly as given.
 *  2. The SERVER's fraction reaches the caller, `warming` lines too, in order,
 *     with the job type's own extra keys carried verbatim; a kind this SDK
 *     does not model (`cue`) still reaches `onEvent`.
 *  3. Artifacts land in the caller's directory with their provenance sidecar
 *     beside them, or in memory from `done`'s authoritative list.
 *  4. Every refusal is BY NAME and none is retried: `server_busy` with the
 *     holder's line, a 4xx by the server's own code, a 401, an unreachable
 *     server, a protocol violation — and a job that ran and FAILED is its own
 *     class, as is one that ended cancelled.
 *  5. A cancel reaches the server as DELETE and the stream runs on to
 *     `cancelled`; what landed before it stays on disk (R6). A signal that was
 *     already aborted submits nothing.
 *  6. `attachTo` uploads nothing, submits nothing, and asks for events after
 *     the id it already had.
 *  7. A missing input file and a missing artifacts directory are refused
 *     before a byte crosses.
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
} = require('./fake-crucible');

const JOB = path.join(REPO, 'dist', 'electron', 'crucible', 'job.js');
if (!fs.existsSync(JOB)) {
  console.log('SKIP: dist/electron/crucible/job.js is not built — run npx tsc -p tsconfig.electron.json');
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-job-');
const job = require(JOB);
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/**
 * The fake's `echo`-like job type: `behaviour` decides what a submit does.
 *   'run'      queued, warming, progress ×2 (with extra), cue, artifact ×N, done
 *   'busy'     409 server_busy naming the holder
 *   'disabled' 409 job_type_disabled
 *   'auth'     401
 *   'failed'   runs, then ends `failed`
 *   'cancel'   one artifact, then holds until DELETE, then `cancelled`
 *   'malformed' a done frame the SDK cannot read
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      if (behaviour === 'busy') {
        send(res, 409, { error: { code: 'server_busy', message: 'one job at a time, and it is not yours', details: {
          holder: 'foundry', job_id: 'j-held', type: 'tts', model: 'deathstalker', status: 'running',
          since: '2026-09-14T01:00:00Z', progress: 0.62, message: '640 of 1030 chunk(s) rendered',
        } } });
        return true;
      }
      if (behaviour === 'disabled') {
        send(res, 409, { error: { code: 'job_type_disabled', message: 'asr is off: [jobs] enable_asr = false' } });
        return true;
      }
      if (behaviour === 'auth') {
        send(res, 401, { error: { code: 'bad_token', message: 'that is not this server\'s token' } });
        return true;
      }
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const id = decodeURIComponent(events[1]);
      const entry = state.jobs.get(id);
      assert.ok(entry, `events asked for an unknown job ${id}`);
      const sse = sseWriter(req, res);
      const names = Object.keys(entry.body.inputs).map((n) => `${n}.out`);
      sse.frame('queued', { position: null });
      sse.frame('warming', { message: 'loading the model' });
      sse.frame('progress', { fraction: 0, message: 'starting', stage: 'decoding', processed_s: 0, total_s: 100 });
      sse.frame('cue', { index: 7, items: [{ text: 'hi', start: 0.1, end: 0.4 }] });
      if (behaviour === 'failed') {
        sse.frame('failed', { error: { code: 'asr_window_failed', message: '1 of 3 window(s) failed: window 1 (900s): boom' } });
        sse.end();
        return true;
      }
      if (behaviour === 'malformed') {
        sse.frame('done', { neither: 'artifacts nor resident' });
        sse.end();
        return true;
      }
      const upTo = behaviour === 'cancel' ? 1 : names.length;
      for (let n = 0; n < upTo; n++) sse.frame('artifact', { name: names[n] });
      sse.frame('progress', { fraction: 0.5, message: 'halfway', stage: 'transcribing', processed_s: 50, total_s: 100 });
      if (behaviour === 'cancel') {
        const wait = setInterval(() => {
          if (state.cancelled.length === 0) return;
          clearInterval(wait);
          sse.frame('cancelled', { status: 'cancelled' });
          sse.end();
        }, 10);
        req.on('close', () => clearInterval(wait));
        return true;
      }
      sse.frame('progress', { fraction: 1, message: 'done', stage: 'transcribing', processed_s: 100, total_s: 100 });
      sse.frame('done', { artifacts: names, extra_fact: 42 });
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const id = decodeURIComponent(artifact[1]);
      const name = decodeURIComponent(artifact[2]);
      const entry = state.jobs.get(id);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, provenanceFor(name.replace(/\.provenance\.json$/, ''), entry.body.type, entry.body.model ?? null));
        return true;
      }
      const bytes = Buffer.from(`artifact:${name}`);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
      res.end(bytes);
      return true;
    }
    return false;
  });
}

function freshDir(label) {
  const dir = path.join(work, `${label}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const inputDir = freshDir('inputs');
  const audio = path.join(inputDir, 'book.m4b');
  fs.writeFileSync(audio, Buffer.from('m4b-bytes-of-a-book'));
  const outDir = freshDir('artifacts');
  const progress = [];
  const events = [];
  let started = null;
  let outcome;
  try {
    outcome = await job.runCrucibleJob({
      server, type: 'asr', model: 'faster-whisper-large-v3',
      params: { language: 'en', vad_filter: true, word_timestamps: true },
      inputs: { 'book.m4b': audio, 'notes.txt': Buffer.from('inline bytes') },
      artifactsTo: outDir,
      onProgress: (p) => progress.push(p),
      onEvent: (e) => events.push(e),
      onStarted: (s) => { started = s; },
    });
  } finally {
    await fake.close();
  }

  await check('every input is uploaded, bytes and name intact, and the submit names each blob', () => {
    assert.strictEqual(fake.state.uploads.length, 2);
    const byName = new Map(fake.state.uploads.map((u) => [u.filename, u]));
    assert.strictEqual(byName.get('book.m4b').bytes.toString(), 'm4b-bytes-of-a-book', 'the file\'s bytes crossed');
    assert.strictEqual(byName.get('notes.txt').bytes.toString(), 'inline bytes', 'the inline bytes crossed');
    assert.strictEqual(fake.state.submitted.length, 1);
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'asr');
    assert.strictEqual(body.model, 'faster-whisper-large-v3');
    assert.deepStrictEqual(body.params, { language: 'en', vad_filter: true, word_timestamps: true });
    assert.deepStrictEqual(body.inputs, {
      'book.m4b': { blob_id: byName.get('book.m4b').blobId },
      'notes.txt': { blob_id: byName.get('notes.txt').blobId },
    });
  });

  await check('the SERVER\'s fraction and its extra keys reach the caller, warming included, in order', () => {
    assert.deepStrictEqual(progress.map((p) => p.kind), ['warming', 'progress', 'progress', 'progress']);
    assert.strictEqual(progress[0].message, 'loading the model');
    assert.deepStrictEqual(progress.slice(1).map((p) => p.fraction), [0, 0.5, 1]);
    assert.deepStrictEqual(progress[1].extra, { stage: 'decoding', processed_s: 0, total_s: 100 },
      'the job type\'s own keys are carried verbatim, server spelling');
  });

  await check('a kind this SDK does not model (cue) still reaches onEvent, named', () => {
    const cue = events.find((e) => e.event === 'unknown');
    assert.ok(cue, 'the cue frame was dropped');
    assert.strictEqual(cue.kind, 'cue');
    assert.deepStrictEqual(cue.data, { index: 7, items: [{ text: 'hi', start: 0.1, end: 0.4 }] });
  });

  await check('artifacts land in the directory with their provenance sidecar beside them', () => {
    assert.strictEqual(outcome.artifacts.where, 'disk');
    for (const name of ['book.m4b.out', 'notes.txt.out']) {
      const file = path.join(outDir, name);
      assert.strictEqual(fs.readFileSync(file).toString(), `artifact:${name}`);
      assert.ok(fs.existsSync(`${file}.provenance.json`), `${name} has no sidecar`);
      const written = outcome.artifacts.files.get(name);
      assert.strictEqual(written.path, file);
      assert.strictEqual(written.provenance.model.fingerprint, 'faster-whisper-large-v3@abc1234');
    }
  });

  await check('the done frame\'s extra keys, the job id and the last event id are handed back', () => {
    assert.strictEqual(outcome.jobId, 'job-1');
    // Uploads run four at a time, so the submit's input keys land in completion
    // order and the fake's artifact list follows them; the SET is what matters.
    assert.deepStrictEqual([...outcome.done.artifacts].sort(), ['book.m4b.out', 'notes.txt.out']);
    assert.deepStrictEqual(outcome.done.extra, { extra_fact: 42 });
    assert.strictEqual(outcome.lastEventId, 9, 'the fake sent nine frames');
    assert.ok(started && started.jobId === 'job-1' && typeof started.cancel === 'function');
  });
}

async function memoryArtifacts() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  let outcome;
  try {
    outcome = await job.runCrucibleJob({
      server, type: 'echo', params: {}, inputs: { 'a.bin': Buffer.from('aaa') },
    });
  } finally {
    await fake.close();
  }
  await check('without artifactsTo the artifacts are fetched into memory from done\'s list', () => {
    assert.strictEqual(outcome.artifacts.where, 'memory');
    assert.strictEqual(Buffer.from(outcome.artifacts.bytes.get('a.bin.out')).toString('utf-8'), 'artifact:a.bin.out');
    assert.strictEqual(fake.state.submitted[0].model, undefined, 'a type with no model sends none');
  });
}

async function refusals() {
  for (const [behaviour, expectCode, expectBusy] of [
    ['busy', 'server_busy', true],
    ['disabled', 'job_type_disabled', false],
    ['auth', 'bad_token', false],
  ]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    let caught = null;
    try {
      await job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: { 'x': Buffer.from('x') } });
    } catch (err) {
      caught = err;
    } finally {
      await fake.close();
    }
    await check(`${behaviour}: refused by name as ${expectCode}, once, never retried`, () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `expected CrucibleJobRefused, got ${caught}`);
      assert.strictEqual(caught.code, expectCode);
      assert.strictEqual(caught.server, server);
      assert.strictEqual(fake.state.submitted.length, 1, 'exactly one submit attempted');
      if (expectBusy) {
        // The SDK's own line, verbatim — the holder, the job, the progress and its latest message.
        assert.strictEqual(caught.busyLine,
          'busy: foundry, tts deathstalker, 62% done — 640 of 1030 chunk(s) rendered');
        assert.ok(/foundry/.test(caught.message), 'the holder is named in the sentence');
      } else {
        assert.strictEqual(caught.busyLine, undefined, 'busyLine is present ONLY on server_busy');
      }
    });
  }

  {
    const fake = await startFake('failed');
    const server = registerFake(fake.url);
    let caught = null;
    try {
      await job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: { 'x': Buffer.from('x') } });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check('a job that ran and ended `failed` is CrucibleJobFailed, with the server\'s code and job id', () => {
      assert.ok(caught instanceof job.CrucibleJobFailed, `got ${caught}`);
      assert.strictEqual(caught.code, 'asr_window_failed');
      assert.strictEqual(caught.jobId, 'job-1');
      assert.ok(/window 1 \(900s\): boom/.test(caught.message), 'the engine\'s own words travel');
    });
  }

  {
    const fake = await startFake('malformed');
    const server = registerFake(fake.url);
    let caught = null;
    try {
      await job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: { 'x': Buffer.from('x') } });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check('a done frame the SDK cannot read is crucible_protocol, not an empty success', () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, 'crucible_protocol');
    });
  }

  {
    // A port nobody listens on.
    const probe = await startFake('run');
    const url = probe.url;
    await probe.close();
    const server = registerFake(url);
    let caught = null;
    try {
      await job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: { 'x': Buffer.from('x') } });
    } catch (err) { caught = err; }
    await check('an unreachable server is crucible_unreachable, named, and nothing is retried', () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, 'crucible_unreachable');
    });
  }
}

async function cancellation() {
  {
    const fake = await startFake('cancel');
    const server = registerFake(fake.url);
    const outDir = freshDir('cancel');
    const controller = new AbortController();
    let caught = null;
    try {
      await job.runCrucibleJob({
        server, type: 'asr', model: 'm', params: {},
        inputs: { 'a': Buffer.from('a'), 'b': Buffer.from('b') },
        artifactsTo: outDir,
        signal: controller.signal,
        onProgress: (p) => {
          // The second progress frame is sent after the first artifact; abort then.
          if (p.kind === 'progress' && p.fraction === 0.5) controller.abort();
        },
      });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check('an aborted signal DELETEs the job and the stream ends `cancelled`, as its own class', () => {
      assert.deepStrictEqual(fake.state.cancelled, ['job-1'], 'the cancel reached the server');
      assert.ok(caught instanceof job.CrucibleJobCancelled, `got ${caught}`);
      assert.strictEqual(caught.jobId, 'job-1');
      assert.ok(/this side's request/.test(caught.message));
    });
    await check('what landed before the cancel stays on disk (R6)', () => {
      assert.ok(fs.existsSync(path.join(outDir, 'a.out')), 'the first artifact was written before the cancel');
      assert.ok(!fs.existsSync(path.join(outDir, 'b.out')), 'the second never came');
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const controller = new AbortController();
    controller.abort();
    let caught = null;
    try {
      await job.runCrucibleJob({
        server, type: 'asr', model: 'm', params: {}, inputs: { 'a': Buffer.from('a') }, signal: controller.signal,
      });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check('a signal already aborted submits nothing and uploads nothing', () => {
      assert.ok(caught instanceof job.CrucibleJobCancelled, `got ${caught}`);
      assert.strictEqual(caught.jobId, null);
      assert.strictEqual(fake.state.uploads.length, 0);
      assert.strictEqual(fake.state.submitted.length, 0);
    });
  }
}

async function resume() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  // Seed a job the fake knows about, as if a previous run had submitted it.
  fake.state.jobs.set('job-old', { body: { type: 'asr', model: 'm', params: {}, inputs: { 'a': {} } } });
  const progress = [];
  let outcome;
  try {
    outcome = await job.runCrucibleJob({
      server, type: 'asr', model: 'm', params: {}, inputs: { 'a': Buffer.from('never uploaded') },
      attachTo: { jobId: 'job-old', lastEventId: 4 },
      onProgress: (p) => progress.push(p),
    });
  } finally {
    await fake.close();
  }
  await check('attachTo uploads nothing, submits nothing, and asks for events after the id it had', () => {
    assert.strictEqual(fake.state.uploads.length, 0);
    assert.strictEqual(fake.state.submitted.length, 0);
    assert.deepStrictEqual(fake.state.eventsRequests, [{ jobId: 'job-old', lastEventId: 4 }]);
    // Frames 1-4 (queued, warming, progress 0, cue) were skipped by the server.
    assert.deepStrictEqual(progress.map((p) => p.kind), ['progress', 'progress']);
    assert.strictEqual(outcome.jobId, 'job-old');
    assert.strictEqual(outcome.lastEventId, 8, 'the last id seen, counted from the server\'s numbering');
  });
}

async function preflight() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  try {
    await check('a missing input file is refused by name before a byte crosses', async () => {
      await assert.rejects(
        job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: { 'a': path.join(work, 'nope.m4b') } }),
        (err) => err instanceof job.CrucibleJobRefused && err.code === 'crucible_input_missing',
      );
      assert.strictEqual(fake.state.uploads.length, 0);
    });
    await check('a missing artifacts directory is refused by name, never created', async () => {
      const missing = path.join(work, 'no-such-dir');
      await assert.rejects(
        job.runCrucibleJob({ server, type: 'asr', model: 'm', params: {}, inputs: {}, artifactsTo: missing }),
        (err) => err instanceof job.CrucibleJobRefused && err.code === 'crucible_artifacts_dir_missing',
      );
      assert.ok(!fs.existsSync(missing));
    });
    await check('an empty server name is refused by name', async () => {
      await assert.rejects(
        job.runCrucibleJob({ server: '', type: 'asr', params: {}, inputs: {} }),
        (err) => err instanceof job.CrucibleJobRefused && err.code === 'crucible_server_not_named',
      );
    });
  } finally {
    await fake.close();
  }
}

(async () => {
  await happyPath();
  await memoryArtifacts();
  await refusals();
  await cancellation();
  await resume();
  await preflight();
  summary('test-crucible-job');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
