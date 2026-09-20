#!/usr/bin/env node
/**
 * THREE DOORS THAT SAY THEY CANCEL, AND WHAT EACH OF THEM ACTUALLY WAITS FOR.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-cancel-doors.js
 *
 * A cancel that reaches the server and a cancel that is FINISHED are two
 * different facts, and every defect below is one of them being read as the
 * other.
 *
 *  A. **A render's cancel handle resolves on the DELETE's 200.** `client.cancel`
 *     is one HTTP round trip and the server answers it `cancelling` in
 *     milliseconds — the engine is still mid-chunk. `stopParallelConversion`
 *     awaits that handle precisely so the cache flush cannot race the far end
 *     still writing, and then deletes the session, frees the GPU slot and
 *     flushes a directory the downloader is still writing `<index>.flac` into.
 *     So: the handle must resolve only after the job's own terminal frame has
 *     been seen on the stream this render is already reading, and no artifact
 *     may land after it resolves.
 *
 *  B. **Quitting BookForge during a remote render cancels nothing.**
 *     `killAllWorkers` kills PROCESSES, and a Crucible render is not one — the
 *     job renders the rest of the book on somebody else's card, holding its
 *     exclusive lane, its claim and its voice, and nothing persists the job id
 *     so a relaunch cannot DELETE it either. The quit path must call the
 *     session's own cancel handle, and it must do it under a BOUND: a server
 *     that will not stop cannot be allowed to hang the quit.
 *
 *  C. **The hours-long align has no ✕.** `runLongformAlign` takes a `signal`
 *     and `whisperx-align-bridge` passed none, so `cancelEpubAlign` — the door
 *     that kills the local align child, whole tree — reached nothing at all
 *     when the same alignment ran on a Crucible.
 *
 * No GPU, no model, no aligner, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const { skipLine } = require('./keeper-skip.js');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  refuseRenderParams,
} = require('./fake-crucible');

const DIST = path.join(REPO, 'dist', 'electron');
for (const built of ['crucible/render.js', 'parallel-tts-bridge.js', 'whisperx-align-bridge.js']) {
  if (!fs.existsSync(path.join(DIST, built))) {
    console.log(skipLine(`dist/electron/${built} is not built — run npx tsc -p tsconfig.electron.json`));
    process.exit(0);
  }
}
if (!fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'))) {
  console.log(skipLine('dist/electron/data is not staged — run npm run build:electron'));
  process.exit(0);
}

const { work } = installElectronStub('bf-cancel-doors-');
const render = require(path.join(DIST, 'crucible', 'render.js'));
const alignLongform = require(path.join(DIST, 'crucible', 'align-longform.js'));
const servers = require(path.join(DIST, 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/** One clock for both sides of every ordering claim below. */
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// ─────────────────────────────────────────────────────────────────────────────
// A. The render's cancel handle
// ─────────────────────────────────────────────────────────────────────────────

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
    // `[voice.serving]` — what the server under narrator is sized by. Required
    // on every row since 2026-09-19 (crucible docs/PHASE18-UNCERTIFIED.md 4.0):
    // `max_num_seqs` is the ceiling a render's `width` must not exceed, and the
    // SDK refuses a row without the block rather than inventing one.
    serving: {
      max_num_seqs: 4, max_num_seqs_note: 'measured 2026-09-19 on a 24 GB card',
      mem_fraction: 0.6, mem_fraction_note: 'measured beside it',
      context_length: 4096, context_length_note: 'the engine was started at it',
    },
    pace: FAKE_PACE,
  };
}

/** A real `GuardPlan.verdict()` object, shaped from PHASE6-REMOTE-RENDER.md §3. */
const CLEAN_VERDICT = {
  verdict: 'clean',
  clean: true,
  parts: 1,
  band: {
    max_chars_per_sec: 22.46, min_chars_per_sec: 13.29,
    reference: 17.28, observed: 4, warm: false,
  },
  takes: [],
};

const CHUNKS = [
  { index: 0, text: 'He had been walking for some time.' },
  { index: 1, text: 'The road turned north at the mill and did not turn again.' },
  { index: 2, text: 'By evening he could see the lights.' },
];

/** How long after the DELETE the engine finishes the chunk it was on. */
const STRAGGLER_MS = 120;
/** And how long after THAT the job reports it has stopped. */
const TERMINAL_MS = 250;

/**
 * A render server that behaves the way a real one does under a cancel: the
 * DELETE is answered `cancelling` at once, one more chunk lands because the
 * engine was mid-sentence, and only then does the job report `cancelled`.
 *
 * That gap is the defect's whole habitat. A fake that ended the job on the
 * DELETE would make a handle which resolves there look correct.
 */
function startCancellingRenderServer() {
  return startFakeCrucible(async (req, res, ctx) => {
    const route = ctx.url.pathname;
    const { state, send, sseWriter } = ctx;

    if (route === '/v1/voices' && req.method === 'GET') {
      send(res, 200, [voiceRow('mistborn')]);
      return true;
    }

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      // The render door's own refusals (retake without a band, a malformed
      // band), so a cancel is measured against a submit a real server accepts.
      const badParams = refuseRenderParams(body.params);
      if (badParams) {
        send(res, badParams.status, { error: { code: badParams.code, message: badParams.message } });
        return true;
      }
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const entry = state.jobs.get(decodeURIComponent(events[1]));
      const chunks = entry.body.params.chunks;
      const sse = sseWriter(req, res);
      const emit = (chunk, n) => {
        sse.frame('chunk', {
          index: chunk.index,
          seconds: 7.1,
          chars: chunk.text.length,
          chars_per_sec: chunk.text.length / 7.1,
          tokens: null,
          capped: null,
          take: 0,
          guard: CLEAN_VERDICT,
        });
        sse.frame('artifact', { name: `${chunk.index}.flac` });
        sse.frame('progress', {
          fraction: (n + 1) / chunks.length,
          message: `${n + 1} of ${chunks.length} chunk(s) rendered`,
          rendered: n + 1, failed: 0, total: chunks.length,
        });
      };
      sse.frame('queued', { position: null });
      for (let n = 0; n < chunks.length - 1; n++) emit(chunks[n], n);

      const waitForDelete = setInterval(() => {
        if (state.cancelled.length === 0) return;
        clearInterval(waitForDelete);
        // The chunk the engine was already generating when the DELETE arrived.
        setTimeout(() => {
          emit(chunks[chunks.length - 1], chunks.length - 1);
          setTimeout(() => {
            state.terminalFrameAt = now();
            sse.frame('cancelled', { status: 'cancelled' });
            sse.end();
          }, TERMINAL_MS);
        }, STRAGGLER_MS);
      }, 5);
      req.on('close', () => clearInterval(waitForDelete));
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, provenanceFor(name.replace(/\.provenance\.json$/, ''), 'tts', 'mistborn'));
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

async function renderCancelChecks() {
  const fake = await startCancellingRenderServer();
  const server = registerFake(fake.url);
  const sentencesDir = path.join(work, 'session-render', 'chapters', 'sentences');
  fs.mkdirSync(sentencesDir, { recursive: true });

  const writes = [];
  let resolvedAt = null;
  /** What the sentences directory held at the instant the handle resolved. */
  let dirAtResolve = null;
  let jobId = null;
  let thrown = null;
  try {
    await render.runCrucibleRender({
      server,
      renderId: 'cancel-doors-render',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir,
      onChunkWritten: (index) => writes.push({ index, at: now() }),
      onStarted: (started) => {
        jobId = started.jobId;
        // Stop it once the stream is up, the way the app's Stop button does.
        const settled = () => {
          resolvedAt = now();
          dirAtResolve = fs.readdirSync(sentencesDir).sort();
        };
        setTimeout(() => { started.cancel().then(settled, settled); }, 120);
      },
    });
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }

  await check('the cancel reaches the server as DELETE /v1/jobs/<id>, once', () => {
    assert.deepStrictEqual(fake.state.cancelled, [jobId],
      'abandoning the stream would leave that server rendering the rest of the book');
  });

  await check('the fake really did write one more chunk after the DELETE', () => {
    // Without this the two claims below could pass on a server that stopped
    // instantly, which is the one case the defect does not show up in.
    assert.strictEqual(writes.length, CHUNKS.length,
      `the straggler chunk must land: ${writes.length} of ${CHUNKS.length} chunk(s) were written`);
    assert.ok(typeof fake.state.terminalFrameAt === 'number',
      'the fake never sent its terminal frame, so this suite proved nothing');
  });

  await check('cancel() resolves only AFTER the job\'s terminal frame', () => {
    assert.ok(resolvedAt !== null, 'the cancel handle never resolved at all');
    assert.ok(resolvedAt >= fake.state.terminalFrameAt,
      `cancel() resolved ${(fake.state.terminalFrameAt - resolvedAt).toFixed(1)} ms BEFORE the `
      + 'job said it had stopped — the DELETE\'s 200 is the server accepting the cancel, not the '
      + 'engine having finished');
  });

  await check('nothing lands in the sentences directory after cancel() resolves', () => {
    // Measured on the DIRECTORY, not on a clock: what was there when the stop
    // path was told the cancel was done, against what is there now. Anything
    // that appeared between the two is the flush racing the far end that
    // `stopParallelConversion` awaits this handle to prevent.
    assert.ok(dirAtResolve !== null, 'the cancel handle never resolved at all');
    const appearedLater = fs.readdirSync(sentencesDir).sort()
      .filter((name) => !dirAtResolve.includes(name));
    assert.deepStrictEqual(appearedLater, [],
      `${appearedLater.length} file(s) were written into the sentences directory AFTER the stop `
      + `path was told the cancel was done: ${appearedLater.join(', ')}`);
  });

  await check('the render\'s own chunk tally has stopped moving by then', () => {
    const late = writes.filter((w) => w.at > resolvedAt);
    assert.deepStrictEqual(late.map((w) => w.index), [],
      `chunk(s) ${late.map((w) => w.index).join(', ')} were reported to the caller after its `
      + 'cancel resolved, so the session it has already torn down is still being written to');
  });

  await check('the chunks already downloaded SURVIVE the cancel (R6)', () => {
    for (const w of writes) {
      assert.ok(fs.existsSync(path.join(sentencesDir, `${w.index}.flac`)),
        `${w.index}.flac was deleted by the cancel — partial work survives failure, always`);
    }
  });

  await check('a cancelled render still ends as a named failure', () => {
    assert.ok(thrown, 'a cancelled job must not resolve as a finished render');
    assert.ok(/cancelled/.test(String(thrown.message)),
      `the failure must say it was cancelled; got: ${thrown && thrown.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The quit path
// ─────────────────────────────────────────────────────────────────────────────

async function quitChecks() {
  const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

  await check('the quit path has a door that cancels a session\'s remote render', () => {
    assert.strictEqual(typeof bridge.cancelRemoteRenderOnQuit, 'function',
      'quitting during a remote render must DELETE the job: it is not a process, so nothing '
      + 'killAllWorkers does reaches it, and nothing persists the id for a relaunch to cancel');
  });
  if (typeof bridge.cancelRemoteRenderOnQuit !== 'function') return;

  await check('it calls the session\'s own cancel handle, and only once', async () => {
    let calls = 0;
    const session = {
      jobId: 'bf-job-1',
      crucibleJobId: 'job-7',
      crucibleCancel: async () => { calls += 1; },
    };
    assert.strictEqual(await bridge.cancelRemoteRenderOnQuit(session), 'cancelled');
    assert.strictEqual(calls, 1, 'the handle must be invoked');
    assert.strictEqual(session.crucibleCancel, undefined,
      'the handle is taken off the session, so a second teardown cannot DELETE a second time');
    assert.strictEqual(await bridge.cancelRemoteRenderOnQuit(session), 'no-remote-render');
    assert.strictEqual(calls, 1);
  });

  await check('a session with no remote render is left alone', async () => {
    assert.strictEqual(
      await bridge.cancelRemoteRenderOnQuit({ jobId: 'bf-job-2' }), 'no-remote-render');
  });

  await check('a server that will not stop does not hang the quit', async () => {
    // The measured case (2026-09-15): a DELETE is recorded `cancelling` and
    // nothing on the server acts on it, so the terminal frame never arrives.
    const started = now();
    const outcome = await bridge.cancelRemoteRenderOnQuit(
      { jobId: 'bf-job-3', crucibleJobId: 'job-9', crucibleCancel: () => new Promise(() => {}) },
      150,
    );
    const waited = now() - started;
    assert.strictEqual(outcome, 'still-cancelling');
    assert.ok(waited < 2000, `the quit waited ${waited.toFixed(0)} ms on a server that never answered`);
  });

  await check('a cancel that FAILS is reported, and the quit continues', async () => {
    assert.strictEqual(
      await bridge.cancelRemoteRenderOnQuit({
        jobId: 'bf-job-4',
        crucibleJobId: 'job-11',
        crucibleCancel: async () => { throw new Error('the server is gone'); },
      }),
      'failed');
  });

  await check('killAllWorkers — the quit path itself — goes through that door', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function killAllWorkers'));
    // Since 2026-09-20 (bug hunt C9) the quit path calls the PLURAL door, which
    // fans these out with `Promise.all` so N sessions cost one grace and not N;
    // each is still `cancelRemoteRenderOnQuit` under its own clock. Either
    // spelling satisfies what this check is about — that the quit reaches the
    // servers at all. The fan-out itself is measured in
    // tools/test-bridge-quit-and-owner.js.
    assert.ok(/cancelAllRemoteRendersOnQuit\(|cancelRemoteRenderOnQuit\(/.test(body.slice(0, 4000)),
      'killAllWorkers kills processes and a Crucible render is not one; without this call the '
      + 'job renders the rest of the book holding that server\'s lane, claim and voice');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C. The long-form align
// ─────────────────────────────────────────────────────────────────────────────

const VTT = 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHe had been walking for some time.\n';

/**
 * An `align-longform` server that waits for a DELETE before it will finish.
 *
 * It gives up waiting after `patienceMs` and completes the job normally, so a
 * bridge that cancels NOTHING fails this suite on an assertion instead of
 * hanging it.
 */
function startCancellingAlignServer(patienceMs) {
  return startFakeCrucible(async (req, res, ctx) => {
    const route = ctx.url.pathname;
    const { state, send, sseWriter } = ctx;

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      const id = ctx.newJobId();
      state.jobs.set(id, { body });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      sse.frame('progress', {
        fraction: 0.1, message: 'transcribing', stage: 'transcribe', processed: 1, total: 10,
      });
      const waited = Date.now();
      const poll = setInterval(() => {
        if (state.cancelled.length > 0) {
          clearInterval(poll);
          sse.frame('cancelled', { status: 'cancelled' });
          sse.end();
          return;
        }
        if (Date.now() - waited < patienceMs) return;
        clearInterval(poll);
        sse.frame('artifact', { name: 'alignment.vtt' });
        sse.frame('artifact', { name: 'align-report.json' });
        sse.frame('done', { artifacts: ['alignment.vtt', 'align-report.json'], placed: 1 });
        sse.end();
      }, 10);
      req.on('close', () => clearInterval(poll));
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, provenanceFor(
          name.replace(/\.provenance\.json$/, ''), 'align-longform', 'qwen3-aligner'));
        return true;
      }
      if (name === 'alignment.vtt') {
        res.writeHead(200, { 'Content-Type': 'text/vtt', 'Content-Length': Buffer.byteLength(VTT) });
        res.end(VTT);
        return true;
      }
      if (name === 'align-report.json') {
        send(res, 200, { placed: 1, sentences: 1 });
        return true;
      }
      return false;
    }
    return false;
  });
}

async function longformSignalCheck() {
  const fake = await startCancellingAlignServer(5000);
  const server = registerFake(fake.url);
  const outputDir = path.join(work, 'align-direct');
  fs.mkdirSync(outputDir, { recursive: true });
  const audio = path.join(work, 'direct.m4b');
  fs.writeFileSync(audio, Buffer.from('not really an m4b'));

  const stop = new AbortController();
  let thrown = null;
  try {
    const running = alignLongform.runLongformAlign({
      server,
      audioPath: audio,
      sentences: [{ index: 0, text: 'He had been walking for some time.', kind: 'prose' }],
      language: 'en',
      outputDir,
      onProgress: () => stop.abort(),
      signal: stop.signal,
    });
    await running;
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }

  await check('an aborted signal DELETEs the align job on the server', () => {
    assert.strictEqual(fake.state.cancelled.length, 1,
      'runLongformAlign must pass its signal to the generic job door, which cancels rather than '
      + 'hanging up');
    assert.ok(thrown && /cancel/i.test(String(thrown.message)),
      `an aborted align must fail saying so; got: ${thrown && thrown.message}`);
  });
}

async function bridgeAlignCancelChecks() {
  const bridge = require(path.join(DIST, 'whisperx-align-bridge.js'));
  const { ZipWriter } = require(path.join(DIST, 'epub-processor.js'));

  const fake = await startCancellingAlignServer(4000);
  const server = registerFake(fake.url);
  const dir = path.join(work, 'align-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const audio = path.join(dir, 'book.m4b');
  fs.writeFileSync(audio, Buffer.from('not really an m4b'));
  const epub = path.join(dir, 'book.epub');
  await writeEpub(ZipWriter, epub, [
    'He had been walking for some time.',
    'The road turned north at the mill and did not turn again.',
  ]);

  const jobId = 'align-cancel-doors';
  const win = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: () => {} } };
  // The ✕, arriving while the server is still transcribing — the same door the
  // local align child is killed through, called the way the queue calls it.
  const stopPolling = cancelWhenRunning(bridge, jobId, fake);
  let thrown = null;
  try {
    await bridge.runEpubAlignOnFiles(jobId, win, epub, audio, 'en', {
      crucibleServer: server,
      reportPath: path.join(dir, 'align-report.json'),
    });
  } catch (err) {
    thrown = err;
  } finally {
    stopPolling();
    await fake.close();
  }

  await check('cancelEpubAlign reaches a remote align as a DELETE', () => {
    assert.strictEqual(fake.state.cancelled.length, 1,
      'the ✕ killed the local align child and reached NOTHING when the same alignment ran on a '
      + 'Crucible — the hours-long job is the one with no cancel');
    assert.ok(thrown, 'a cancelled alignment must not return as a finished one');
  });
}

/** The ✕, fired once the server reports it has started. */
function cancelWhenRunning(bridge, jobId, fake) {
  const poll = setInterval(() => {
    if (fake.state.submitted.length === 0) return;
    clearInterval(poll);
    bridge.cancelEpubAlign(jobId);
  }, 10);
  return () => clearInterval(poll);
}

/** A tiny EPUB: one chapter, one paragraph per sentence. */
async function writeEpub(ZipWriter, outPath, paragraphs) {
  const doc = '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body>'
    + paragraphs.map((p) => `<p>${p}</p>`).join('')
    + '</body></html>';
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="i">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="i">urn:uuid:cancel-doors</dc:identifier>
<dc:title>The Cancel</dc:title><dc:language>en</dc:language></metadata>
<manifest><item id="d0" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>
<spine><itemref idref="d0"/></spine></package>`;
  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter 1</a></li></ol></nav></body></html>`;
  const zw = new ZipWriter();
  zw.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
  zw.addFile('META-INF/container.xml', Buffer.from(container, 'utf8'));
  zw.addFile('OEBPS/content.opf', Buffer.from(opf, 'utf8'));
  zw.addFile('OEBPS/nav.xhtml', Buffer.from(nav, 'utf8'));
  zw.addFile('OEBPS/ch1.xhtml', Buffer.from(doc, 'utf8'));
  await zw.write(outPath);
  return outPath;
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await renderCancelChecks();
  await quitChecks();
  await longformSignalCheck();
  await bridgeAlignCancelChecks();
  summary('crucible-cancel-doors');
})().catch((err) => {
  console.error('crucible-cancel-doors: the suite itself failed:', err);
  process.exitCode = 1;
});
