#!/usr/bin/env node
/**
 * THE GENERATION STEP ON SOMEBODY ELSE'S CARD, AND THE FIVE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-render.js
 *
 * `electron/crucible/render.ts` is the seam item 2.4 adds: when a parallel TTS
 * job names a Crucible server, the chunks the prep packed are submitted as ONE
 * `tts` job, the engine's guard verdicts come back on the `chunk` events, and
 * the FLACs are downloaded into the session's sentences directory so assembly
 * cannot tell which machine rendered the book.
 *
 * It drives a FAKE Crucible — an in-process HTTP server speaking the same
 * routes — because the real one needs a card and the card is fine-tuning. What
 * a fake can prove is exactly the set of things that would otherwise be found
 * on a real book, at 3 a.m., after two hours of GPU:
 *
 *  1. **Every chunk is in the submit.** The whole book goes up in one job, on
 *     purpose: it is what gives the server a denominator and therefore the
 *     progress bar a real percentage. A caller that submitted a chapter at a
 *     time would look identical until you watched the bar.
 *  2. **The server's fraction reaches the caller.** BookForge must not re-derive
 *     a percentage from files on disk while the server is reporting its own.
 *  3. **One ledger record per chunk, carrying the SERVER's verdict.** The guard
 *     belongs to the model (Owen, 2026-09-13). A render that recorded nothing,
 *     or recorded `unknown`, would report a book as flawless by saying nothing
 *     about it — which is the failure `chunk-guard-ledger.ts` exists to refuse.
 *  4. **`<index>.flac` lands under the LOCAL naming**, in the directory a local
 *     render writes to, because every consumer downstream — resume, the coverage
 *     audit, RVC, assembly — reads exactly that.
 *  5. **A 409 `server_busy` fails the render, naming the holder.** NO FALLBACK
 *     to the local card: rendering the book here instead would take a GPU
 *     somebody else is using and finish the book in whatever voice this machine
 *     happened to have.
 *  6. **Cancel reaches the server.** Dropping the event stream would leave that
 *     server rendering the rest of the book, holding its exclusive lane, and the
 *     next thing BookForge submitted would be refused by a job the user thinks
 *     they stopped.
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
const RENDER = path.join(REPO, 'dist', 'electron', 'crucible', 'render.js');

if (!fs.existsSync(RENDER)) {
  console.log(skipLine('dist/electron/crucible/render.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// A userData of our own, and an electron that answers for it
//
// `electron/crucible/servers.ts` reads the registry out of
// `app.getPath('userData')` at CALL time. The same interception cli/electron-
// stub.js uses, pointed at a temp directory, so this suite reads and writes its
// OWN registry and can never see (or clobber) the real one.
// ─────────────────────────────────────────────────────────────────────────────

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-render-'));
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

const render = require(RENDER);
const ledger = require(path.join(REPO, 'dist', 'electron', 'chunk-guard-ledger.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));

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
// The fake Crucible
//
// It speaks the routes the SDK actually calls, in the shapes the SDK actually
// parses — a fake that answered a looser shape would pass this suite and fail
// against a real server, which is worse than no suite. Every frame below is
// built from crucible/jobs/tts/render.py and the SDK's own readers.
// ─────────────────────────────────────────────────────────────────────────────

/** The `pace` block every voice row carries. Shape from readVoicePace(). */
const FAKE_PACE = {
  pace_chars_per_sec: 17.28,
  max_chars_per_sec: 22.46,
  min_chars_per_sec: 13.29,
  target_chars: null,
  safe_min_chars: 400,
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
    // Required on every row since the 0.6.0 SDK (PHASE3-TTS.md §5's amendment):
    // false for a checkpoint, whose voice is in its weights, true for the
    // `zeroshot` row, which is the base weights plus somebody's clip.
    needs_reference: false,
    pace: FAKE_PACE,
  }, over || {});
}

/** A real `GuardPlan.verdict()` object, shaped from PHASE6-REMOTE-RENDER.md §3. */
function verdictObject(word) {
  return {
    verdict: word,
    clean: word === 'clean',
    parts: 1,
    band: {
      max_chars_per_sec: 22.46, min_chars_per_sec: 13.29,
      reference: 17.28, observed: 4, warm: false,
    },
    takes: word === 'clean' ? [] : [{ index: 0, action: word, chars: 120, seconds: 7.1 }],
  };
}

/** The provenance sidecar, in the shape the SDK's readProvenance() demands. */
function provenanceFor(name, voice) {
  return {
    server: { name: 'fake-crucible', version: '0.5.0' },
    backend: 'cuda-linux',
    job_type: 'tts',
    model: { id: voice, revision: 'abc1234', fingerprint: `${voice}@abc1234` },
    params: { language: 'en', take: 0 },
    started: '2026-09-13T20:00:00Z',
    finished: '2026-09-13T20:04:00Z',
    artifact: name,
  };
}

/**
 * One fake server. `behaviour` decides what it does with a submit:
 *   'render' — the happy path, one chunk/artifact/progress triple per chunk
 *   'busy'   — 409 server_busy with the holder named
 *   'leased' — 409 leased: a CLIENT is mid-run on what is on the card
 *   'cancel' — streams two chunks, then waits for DELETE and ends `cancelled`
 */
function startFakeCrucible(behaviour) {
  const state = {
    submitted: [],          // every POST /v1/jobs body
    cancelled: [],          // every DELETE /v1/jobs/<id>
    voicesAsked: 0,
    jobs: new Map(),        // id -> {voice, chunks}
  };
  let nextJob = 1;

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;

    if (route === '/v1/voices' && req.method === 'GET') {
      state.voicesAsked += 1;
      return send(res, 200, [voiceRow('mistborn'), voiceRow('deathstalker')]);
    }

    if (route === '/v1/jobs' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.submitted.push(body);
        if (behaviour === 'busy') {
          return send(res, 409, {
            error: {
              code: 'server_busy',
              message: 'one job at a time, and it is not yours',
              details: {
                holder: 'foundry',
                job_id: 'j-held',
                type: 'tts',
                model: 'deathstalker',
                status: 'running',
                since: '2026-09-13T19:00:00Z',
                progress: 0.62,
                message: '640 of 1030 chunk(s) rendered',
              },
            },
          });
        }
        if (behaviour === 'leased') {
          // `crucible/crucible/leases.py`, `Lease.to_dict()` — the six fields a
          // `409 leased` carries. A `tts` submit is refused one because `tts` is
          // in `EVICTS_THE_RESIDENT_MODEL`: the render would take the 27B this
          // lease is holding off the card.
          return send(res, 409, {
            error: {
              code: 'leased',
              message: "'qwen3.8-27b-4bit' is leased by 'foundry' for 'translate'",
              details: {
                lease_id: 'lease-held',
                kind: 'llm',
                client: 'foundry',
                act: 'translate',
                since: '2026-09-18T01:00:00+00:00',
                expires_at: '2026-09-18T01:02:00+00:00',
              },
            },
          });
        }
        const id = `job-${nextJob++}`;
        state.jobs.set(id, { voice: body.model, chunks: body.params.chunks });
        return send(res, 200, { job_id: id });
      });
      return undefined;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const job = state.jobs.get(decodeURIComponent(events[1]));
      assert.ok(job, `the fake was asked for events of an unknown job: ${events[1]}`);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let id = 0;
      const frame = (name, data) => {
        id += 1;
        res.write(`id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const total = job.chunks.length;
      frame('queued', { position: null });
      frame('progress', {
        fraction: 0, message: `rendering ${total} chunk(s) at take 0`,
        rendered: 0, failed: 0, total,
      });

      // How far this run gets before it is told to stop.
      const upTo = behaviour === 'cancel' ? Math.min(2, total) : total;
      const names = [];
      for (let n = 0; n < upTo; n++) {
        const chunk = job.chunks[n];
        const verdict = n === 1 ? 'rerolled' : 'clean';
        frame('chunk', {
          index: chunk.index,
          seconds: 7.1,
          chars: chunk.text.length,
          chars_per_sec: chunk.text.length / 7.1,
          tokens: null,
          capped: null,
          take: 0,
          guard: verdictObject(verdict),
        });
        const name = `${chunk.index}.flac`;
        names.push(name);
        frame('artifact', { name });
        frame('progress', {
          fraction: (n + 1) / total,
          message: `${n + 1} of ${total} chunk(s) rendered`,
          rendered: n + 1, failed: 0, total,
        });
      }

      if (behaviour === 'cancel') {
        // Hold the stream open until the DELETE arrives, then end `cancelled` —
        // which is exactly what a real Crucible does with a running job.
        const waitForCancel = setInterval(() => {
          if (state.cancelled.length === 0) return;
          clearInterval(waitForCancel);
          frame('cancelled', { status: 'cancelled' });
          res.end();
        }, 10);
        req.on('close', () => clearInterval(waitForCancel));
        return undefined;
      }

      frame('done', {
        artifacts: names,
        rendered: upTo,
        failed: [],
        take: 0,
        sample_rate: 24000,
      });
      res.end();
      return undefined;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const job = state.jobs.get(decodeURIComponent(artifact[1]));
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        return send(res, 200, provenanceFor(name.replace(/\.provenance\.json$/, ''), job.voice));
      }
      // Not a real FLAC — the downloader checks that the bytes are non-empty and
      // that the sidecar parses, and nothing in this path decodes audio.
      const bytes = Buffer.from(`fLaC-fake-${name}`);
      res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': bytes.length });
      res.end(bytes);
      return undefined;
    }

    const cancel = /^\/v1\/jobs\/([^/]+)$/.exec(route);
    if (cancel && req.method === 'DELETE') {
      const id = decodeURIComponent(cancel[1]);
      state.cancelled.push(id);
      return send(res, 200, { job_id: id, status: 'cancelling' });
    }

    return send(res, 404, { error: { code: 'not_found', message: route } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        // `close()` alone waits out every keep-alive socket the SDK left open,
        // which is forever for a suite that never exits the agent. Drop them.
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming the fake
//
// `addServer` REFUSES a loopback URL, and `getServer` refuses a registry entry
// that has one — deliberately: the server on this machine has one owner, its
// own config.toml, and a registered copy of its token goes stale the moment
// `crucible init --force` runs. A fake on 127.0.0.1 is exactly the shape that
// rule exists to keep out of the registry, and weakening the rule so a test can
// pass is the wrong direction.
//
// So the fake is named through the ONE function `render.ts` uses to turn a
// server name into a client, and every byte still crosses a real socket to the
// real fake. The registry's own rules keep their own suite; what is under test
// here is what the render does with a client, which is untouched by this.
// ─────────────────────────────────────────────────────────────────────────────

const { CrucibleClient } = require('@crucible/client');
const fakesByName = new Map();
const realCrucibleClientFor = servers.crucibleClientFor;
servers.crucibleClientFor = function crucibleClientForWithFakes(name, clientName) {
  const fake = fakesByName.get(name);
  if (!fake) return realCrucibleClientFor(name, clientName);
  return new CrucibleClient({ url: fake.url, token: fake.token, clientName });
};

/** Name a fake so the code under test can reach it, and hand back that name. */
let registered = 0;
function registerFake(url) {
  const name = `fake${++registered}`;
  fakesByName.set(name, { url, token: 'test-token-abcd' });
  return name;
}

function freshSentencesDir() {
  const dir = path.join(WORK, `sentences-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const CHUNKS = [
  { index: 0, text: 'He had been walking for some time.' },
  { index: 1, text: 'The road turned north at the mill and did not turn again.' },
  { index: 2, text: 'By evening he could see the lights.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// The voice map: an explicit table, and everything it will not guess
// ─────────────────────────────────────────────────────────────────────────────

async function voiceMapChecks() {
  await check('the five fine-tunes and the base voice map to Crucible voice ids', () => {
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'mistborn'), 'mistborn');
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'deathstalker'), 'deathstalker');
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'owen'), 'owen');
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'sigma'), 'sigma');
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'thirdreich'), 'thirdreich');
    // The one id that is NOT the same word on both sides, which is the whole
    // reason the correspondence is a table and not a pass-through.
    assert.strictEqual(render.crucibleVoiceFor('higgs', 'default'), 'higgs-default');
  });

  await check('a zero-shot voice is refused by name, never mapped onto its fine-tune', () => {
    // Mapping `zeroshot-deathstalker` onto `deathstalker` would render a
    // DIFFERENT SPEAKER — the trained clone instead of the clip clone — and
    // nothing downstream would say so.
    assert.throws(() => render.crucibleVoiceFor('higgs', 'zeroshot-deathstalker'), (err) => {
      assert.strictEqual(err.code, 'crucible_voice_unmapped');
      assert.ok(/zeroshot/.test(err.message), 'the refusal must say what it will not guess');
      return true;
    });
  });

  await check('an Orpheus job is refused: every Crucible voice is higgs-v3', () => {
    assert.throws(() => render.crucibleVoiceFor('orpheus', 'mistborn'), (err) => {
      assert.strictEqual(err.code, 'crucible_engine_unsupported');
      return true;
    });
  });

  await check('a checkpoint override is refused: those weights are on this machine', () => {
    assert.throws(() => render.crucibleVoiceFor('higgs', 'mistborn+mb_v7_616'), (err) => {
      assert.strictEqual(err.code, 'crucible_voice_is_an_override');
      return true;
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The happy path
// ─────────────────────────────────────────────────────────────────────────────

async function happyPathChecks() {
  const fake = await startFakeCrucible('render');
  const server = registerFake(fake.url);
  const sentencesDir = freshSentencesDir();
  const progress = [];
  const written = [];
  let outcome;
  let started = null;

  try {
    outcome = await render.runCrucibleRender({
      server,
      renderId: 'test-render-1',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir,
      onStarted: (s) => {
        started = s;
        // Simulate a host moving its advertised engine after admission. The
        // running job and its artifacts still belong to the submitting client.
        fakesByName.set(server, { url: 'http://127.0.0.1:1', token: 'test-token-abcd' });
      },
      onProgress: (p) => progress.push(p),
      onChunkWritten: (index) => written.push(index),
    });
  } finally {
    await fake.close();
  }

  await check('every chunk is in ONE submitted job, with the voice as the model', () => {
    assert.strictEqual(fake.state.submitted.length, 1,
      'the whole book goes up in one job — that is what gives the server a denominator');
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'tts');
    assert.strictEqual(body.model, 'mistborn', 'for tts the model IS the voice id');
    assert.strictEqual(body.params.language, 'en');
    assert.strictEqual(body.params.take, 0,
      'take 0 is the engine\'s own sampling; the client no longer picks a rung');
    assert.deepStrictEqual(body.params.chunks, CHUNKS,
      'every chunk, with its own index and text, unchanged');
    assert.deepStrictEqual(body.inputs, {}, 'a render carries no uploaded inputs');
  });

  await check('a render keeps following the submitting engine after its registered address changes', () => {
    assert.strictEqual(outcome.written, CHUNKS.length);
    assert.strictEqual(fake.state.submitted.length, 1);
  });

  await check('the server is asked whether it has the voice BEFORE the book is sent', () => {
    assert.strictEqual(fake.state.voicesAsked, 1,
      'one GET /v1/voices per render — at job start, not per chunk');
  });

  await check('the SERVER\'s own progress fraction reaches the caller', () => {
    assert.ok(progress.length >= CHUNKS.length,
      `expected a progress frame per chunk, got ${progress.length}`);
    const fractions = progress.map((p) => p.fraction);
    assert.strictEqual(fractions[0], 0, 'the first frame is the server\'s own zero');
    assert.strictEqual(fractions[fractions.length - 1], 1, 'the last frame is the server\'s own one');
    for (let i = 1; i < fractions.length; i++) {
      assert.ok(fractions[i] >= fractions[i - 1], 'fractions never walk backwards');
    }
    const last = progress[progress.length - 1];
    assert.strictEqual(last.total, CHUNKS.length, 'the job type\'s own `total` is carried');
    assert.strictEqual(last.rendered, CHUNKS.length, 'and its own `rendered`');
    assert.strictEqual(last.failed, 0);
  });

  await check('each <index>.flac lands in sentencesDir under the LOCAL naming', () => {
    for (const chunk of CHUNKS) {
      const file = path.join(sentencesDir, `${chunk.index}.flac`);
      assert.ok(fs.existsSync(file), `${chunk.index}.flac is not in the sentences dir`);
      assert.ok(fs.statSync(file).size > 0, `${chunk.index}.flac is empty`);
      // DESIGN.md section 7: the sidecar is persisted beside the output, and the
      // writer lands it FIRST, so the FLAC's existence implies the sidecar's.
      assert.ok(fs.existsSync(`${file}.provenance.json`),
        `${chunk.index}.flac has no provenance sidecar`);
    }
    assert.strictEqual(outcome.written, CHUNKS.length);
    assert.deepStrictEqual(written.slice().sort((a, b) => a - b), CHUNKS.map((c) => c.index),
      'the caller is told which chunk each landed file is');
  });

  await check('the resume scan sees exactly the chunk files and no sidecar', () => {
    // `findMissingSentenceFiles` matches /^(\d+)\.flac$/ and the coverage audit
    // filters on `.flac`; a sidecar that matched either would read as a chunk.
    const asChunks = fs.readdirSync(sentencesDir).filter((f) => /^(\d+)\.flac$/.test(f));
    assert.strictEqual(asChunks.length, CHUNKS.length);
    const asAudio = fs.readdirSync(sentencesDir).filter((f) => f.endsWith('.flac'));
    assert.strictEqual(asAudio.length, CHUNKS.length,
      'a *.provenance.json must not read as audio');
  });

  await check('the ledger holds ONE record per chunk, carrying the server\'s verdict', () => {
    const guard = outcome.guard;
    assert.strictEqual(guard.chunks, CHUNKS.length, 'one record per chunk');
    assert.strictEqual(guard.unknown, 0,
      'a verdict that arrived must never be recorded as unknown — unknown is not clean');
    assert.deepStrictEqual(guard.unknownBy, {});
    assert.deepStrictEqual(guard.sources, ['crucible-chunk']);
    // The WORDS are narrator's, carried verbatim: this suite asserts the count
    // per word the fake sent, never a vocabulary of its own.
    assert.strictEqual(guard.byVerdict.clean, 2);
    assert.strictEqual(guard.byVerdict.rerolled, 1);
  });

  await check('the ledger POPS — a finished render leaves nothing behind', () => {
    assert.deepStrictEqual(ledger.chunkGuards('test-render-1'), [],
      'downloadRenderArtifacts takes the summary, the way GuardPlan.verdict() pops');
  });

  await check('the terminal news comes back: rendered, failed, take, sample rate', () => {
    assert.strictEqual(outcome.result.rendered, CHUNKS.length);
    assert.deepStrictEqual(outcome.result.failed, []);
    assert.strictEqual(outcome.result.take, 0);
    assert.strictEqual(outcome.result.sampleRate, 24000);
    assert.ok(outcome.lastEventId > 0, 'the last event id is reported, for a later attach');
    assert.ok(started && started.jobId === outcome.jobId,
      'onStarted hands over the job id and the cancel handle before the stream runs');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A busy server is a refusal, not a reason to use the local card
// ─────────────────────────────────────────────────────────────────────────────

async function busyChecks() {
  const fake = await startFakeCrucible('busy');
  const server = registerFake(fake.url);
  const sentencesDir = freshSentencesDir();
  let thrown = null;
  try {
    await render.runCrucibleRender({
      server,
      renderId: 'test-render-busy',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir,
    });
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }

  await check('409 server_busy fails the render and names the holder', () => {
    assert.ok(thrown, 'a busy server must not produce a render');
    assert.strictEqual(thrown.code, 'server_busy');
    assert.ok(/foundry/.test(thrown.message),
      `the holder must be named; got: ${thrown.message}`);
    assert.ok(/62% done/.test(thrown.message),
      'the SDK\'s busyLine carries how far along the holder is');
  });

  await check('a busy server renders NOTHING locally and writes no file', () => {
    assert.strictEqual(fs.readdirSync(sentencesDir).length, 0,
      'a refused render leaves an empty sentences dir — no silent downgrade');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A LEASED card is the same WAIT a busy lane is, with a longer clock
// ─────────────────────────────────────────────────────────────────────────────
//
// `CrucibleLeased` is a subclass of `CrucibleRefused` and NOT of `CrucibleBusy`
// (`crucible/sdk/ts/src/errors.ts`), so `describeCrucibleRefusal` used to fall
// straight through to its generic arm: the row went red and waited for somebody
// to press Retry. Foundry, on the identical refusal, parks with the holder's
// name and comes back on its own — so Foundry waited out BookForge's narrations
// while BookForge died on Foundry's translations.
//
// `busyLine` is what the park is made of: `parallel-tts-bridge.ts` keeps it on
// the session (`crucibleBusyLine`), it rides out on `parallel-tts:complete`,
// the narration step throws it through `stepFailure`, and `settleStep` puts the
// row back to `queued` carrying that line. Absent, the row FAILS.

async function leasedChecks() {
  const fake = await startFakeCrucible('leased');
  const server = registerFake(fake.url);
  const sentencesDir = freshSentencesDir();
  let thrown = null;
  try {
    await render.runCrucibleRender({
      server,
      renderId: 'test-render-leased',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir,
    });
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }

  await check('409 leased is a WAIT the queue can park on, not a red row', () => {
    assert.ok(thrown, 'a leased card must not produce a render');
    assert.strictEqual(thrown.code, 'leased');
    assert.strictEqual(thrown.busyLine, 'leased: foundry, translate, until 2026-09-18T01:02:00+00:00',
      'without a busyLine nothing carries the wait to the seam and the row FAILS instead of holding');
    assert.ok(/foundry/.test(thrown.message), `the holder must be named; got: ${thrown.message}`);
    assert.ok(/translate/.test(thrown.message),
      'and what they are doing, so a person can judge the wait');
    assert.ok(/2026-09-18T01:02:00\+00:00/.test(thrown.message),
      'and until when — a lease may hold for an hour where a lane frees in minutes');
  });

  await check('a leased card renders NOTHING locally and writes no file', () => {
    assert.strictEqual(fs.readdirSync(sentencesDir).length, 0,
      'a refused render leaves an empty sentences dir — no silent downgrade');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel reaches the server
// ─────────────────────────────────────────────────────────────────────────────

async function cancelChecks() {
  const fake = await startFakeCrucible('cancel');
  const server = registerFake(fake.url);
  const sentencesDir = freshSentencesDir();
  let thrown = null;
  let jobId = null;
  const landed = [];

  try {
    await render.runCrucibleRender({
      server,
      renderId: 'test-render-cancel',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir,
      onChunkWritten: (index) => landed.push(index),
      onStarted: (started) => {
        jobId = started.jobId;
        // Stop it once the stream is up, the way the app's Stop button does.
        setTimeout(() => { started.cancel().catch(() => undefined); }, 150);
      },
    });
  } catch (err) {
    thrown = err;
  } finally {
    await fake.close();
  }

  await check('cancel reaches the server as DELETE /v1/jobs/<id>', () => {
    assert.strictEqual(fake.state.cancelled.length, 1,
      'abandoning the stream would leave that server rendering the rest of the book');
    assert.strictEqual(fake.state.cancelled[0], jobId,
      'the DELETE must name the job this render actually submitted');
  });

  await check('a cancelled render ends as a named failure, not as a short success', () => {
    assert.ok(thrown, 'a cancelled job must not resolve as a finished render');
    assert.ok(/cancelled/.test(String(thrown.message)),
      `the failure must say it was cancelled; got: ${thrown && thrown.message}`);
  });

  await check('the chunks already downloaded SURVIVE the cancel (R6)', () => {
    assert.ok(landed.length > 0, 'the fake sent two chunks before it was stopped');
    for (const index of landed) {
      assert.ok(fs.existsSync(path.join(sentencesDir, `${index}.flac`)),
        `${index}.flac was deleted by the cancel — partial work survives failure, always`);
    }
  });

  await check('a cancelled render leaves no ledger behind to pollute the next attempt', () => {
    assert.deepStrictEqual(ledger.chunkGuards('test-render-cancel'), []);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals that never reach the wire
// ─────────────────────────────────────────────────────────────────────────────

async function refusalChecks() {
  await check('an unregistered server name is refused by name, not defaulted', async () => {
    await assert.rejects(() => render.runCrucibleRender({
      server: 'no-such-server',
      renderId: 'r',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir: freshSentencesDir(),
    }), (err) => {
      assert.ok(/no crucible server named "no-such-server"/.test(err.message),
        `expected the registry's refusal, got: ${err.message}`);
      return true;
    });
  });

  await check('a sentences dir that does not exist is refused, never created', async () => {
    const missing = path.join(WORK, 'not-a-real-session', 'sentences');
    await assert.rejects(() => render.runCrucibleRender({
      server: 'anything',
      renderId: 'r',
      voice: 'mistborn',
      language: 'en',
      chunks: CHUNKS,
      sentencesDir: missing,
    }), (err) => {
      assert.strictEqual(err.code, 'crucible_sentences_dir_missing');
      return true;
    });
    assert.ok(!fs.existsSync(missing),
      'creating it would turn a typo into a directory that reads as a render with no output');
  });

  await check('an empty chunk list is refused: it is a caller bug, not an empty book', async () => {
    await assert.rejects(() => render.runCrucibleRender({
      server: 'anything',
      renderId: 'r',
      voice: 'mistborn',
      language: 'en',
      chunks: [],
      sentencesDir: freshSentencesDir(),
    }), (err) => {
      assert.strictEqual(err.code, 'crucible_no_chunks');
      return true;
    });
  });

  await check('a voice the server does not advertise is refused before the book is sent', async () => {
    const fake = await startFakeCrucible('render');
    const server = registerFake(fake.url);
    try {
      await assert.rejects(() => render.runCrucibleRender({
        server,
        renderId: 'r',
        voice: 'owen',           // the fake advertises mistborn + deathstalker only
        language: 'en',
        chunks: CHUNKS,
        sentencesDir: freshSentencesDir(),
      }), (err) => {
        assert.strictEqual(err.code, 'crucible_unknown_voice');
        assert.ok(/mistborn/.test(err.message), 'the refusal names what the server DOES have');
        return true;
      });
      assert.strictEqual(fake.state.submitted.length, 0,
        'the book must not be POSTed to a server that cannot render it');
    } finally {
      await fake.close();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The seam in the bridge
//
// `startCrucibleGeneration` cannot be driven from here — it wants a prepared
// session on disk, a GPU lease and the whole completion tail. What CAN be
// pinned, and what is worth pinning, is the three ways the seam silently stops
// being a seam: a generation launch point that still spawns a worker, a
// Crucible failure that `completeAfterWorkers` then RETRIES locally (which is
// the no-fallback rule broken by a retry loop nobody remembered), and a Stop
// that never reaches the server.
// ─────────────────────────────────────────────────────────────────────────────

async function bridgeSeamChecks() {
  const bridge = fs.readFileSync(
    path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');

  await check('every generation launch point asks WHERE this render runs', () => {
    // startParallelConversion (the app), renderRangeHeadless (the CLI) and
    // resumeParallelConversion (Continue). A fourth that forgot would spawn
    // narrator for a job the operator sent to another machine.
    //
    // The question used to be `crucibleServerForJob(settings)` — "did the
    // caller name a server". Item 2.2's routing record answers it for the app,
    // which never named one, so the ask is now `decideGenerationVenue`. The two
    // FRESH launch points ask it BEFORE prep (the answer places the session —
    // tools/test-crucible-render-session.js); the resume asks through
    // `decideAndRememberVenue`, which records the answer on a session that
    // already exists.
    const asked = bridge.match(/decideGenerationVenue\(/g) || [];
    assert.strictEqual(asked.length, 4,
      `decideGenerationVenue is called ${asked.length} time(s): its own definition, the two fresh `
      + 'launch points (startParallelConversion, renderRangeHeadless), and decideAndRememberVenue. '
      + 'A new launch point must ask too.');
    const remembered = bridge.match(/decideAndRememberVenue\(/g) || [];
    assert.strictEqual(remembered.length, 2,
      `decideAndRememberVenue is called ${remembered.length} time(s): its own definition plus the `
      + 'resume (resumeParallelConversion).');
    const takes = bridge.match(/startCrucibleGeneration\(session, venue\.server\)/g) || [];
    assert.strictEqual(takes.length, 3, 'each launch point takes the seam');
    assert.strictEqual((bridge.match(/crucibleServerForJob/g) || []).length, 0,
      'the old caller-only question is gone: two ways to decide where a render runs is two answers');
  });

  await check('the local narrator is reachable by NO route at all', () => {
    /*
     * THIS CHECK USED TO COUNT THE ONE PRODUCER of `legacy-local-narrator` and
     * refuse a second, because a second producer would have been a second
     * fallback. The layer is DELETED (docs/LEGACY-REMOVAL.md), so what it counts
     * now is ZERO: the venue decision is still the only thing that can place a
     * render, and every answer it can give is a Crucible server. A branch that
     * fell back to a local path on a failure would be the silent downgrade
     * crucible/render.ts refuses in its header.
     */
    assert.ok(/venue\.where === 'crucible'/.test(bridge),
      'the seam branches on the venue, not on a nullable server name');
    for (const file of ['generation-venue.ts', 'step-venue.ts']) {
      const src = fs.readFileSync(path.join(REPO, 'electron', 'crucible', file), 'utf8');
      assert.strictEqual((src.match(/where: 'legacy-local-narrator'/g) || []).length, 0,
        `${file} produces no local venue: there is no such venue to produce`);
    }
    // And the TYPE is what makes that checkable rather than remembered — one
    // member, so a new producer cannot be written without changing the union.
    const venueFile = fs.readFileSync(
      path.join(REPO, 'electron', 'crucible', 'generation-venue.ts'), 'utf8');
    const decl = venueFile.slice(venueFile.indexOf('export type GenerationVenue'));
    const body = decl.slice(0, decl.indexOf('};') + 2);
    assert.ok(/^export type GenerationVenue = \{/.test(body),
      `GenerationVenue must be a single object type, not a union: ${body.slice(0, 120)}`);
    assert.ok(!/\|\s*\{/.test(body), `GenerationVenue has a second arm: ${body}`);
  });

  await check('a Crucible failure is never retried by spawning narrator locally', () => {
    // completeAfterWorkers respawns a failed worker while retryCount <
    // MAX_WORKER_RETRIES, and retryWorker calls startWorker. Exhausting the
    // count is what keeps a refusal from becoming a local render.
    assert.ok(/worker\.retryCount = MAX_WORKER_RETRIES;/.test(bridge),
      'the Crucible failure path must exhaust the retry count, or retryWorker spawns narrator '
      + 'for a job that was deliberately sent elsewhere');
  });

  await check('Stop cancels the remote job before it tears the local session down', () => {
    const stop = bridge.slice(bridge.indexOf('export async function stopParallelConversion'));
    assert.ok(/session\.crucibleCancel/.test(stop.slice(0, 4000)),
      'stopParallelConversion must call the render\'s cancel handle: there is no process here to '
      + 'kill, and hanging up leaves that server rendering the rest of the book');
  });

  await check('the seam is on the job, and it is not a boolean toggle', () => {
    assert.ok(/crucible\?: \{\s*\n\s*server: string;/.test(bridge),
      'ParallelTtsSettings carries crucible: { server } — a NAME, never a URL and never a flag');
  });
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  await voiceMapChecks();
  await bridgeSeamChecks();
  await happyPathChecks();
  await busyChecks();
  await leasedChecks();
  await cancelChecks();
  await refusalChecks();

  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch { /* a temp dir that will not go is not a test failure */ }

  console.log(`\ncrucible-render: ${passed} check(s) passed`
    + (failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''));
})().catch((err) => {
  console.error('crucible-render: the suite itself failed:', err);
  process.exitCode = 1;
});
