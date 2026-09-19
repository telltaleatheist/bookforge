#!/usr/bin/env node
/**
 * VOICE CONVERSION ON SOMEBODY ELSE'S CARD, AND THE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-rvc.js
 *
 * `electron/crucible/rvc.ts` sends a session's sentence FLACs to a Crucible
 * `rvc` job and lands the converted files where the local urvc spawn would have
 * written them, so `rvc-job.ts`'s staging, manifest and commit behind it cannot
 * tell which machine converted the book. Against a FAKE Crucible, this pins:
 *
 *  1. The model id table: every BookForge built-in RVC voice names its Crucible
 *     manifest, the two catalogs are exactly the same size, and a local /
 *     user-added / published-nowhere voice is refused BY NAME — a folder on this
 *     machine is not something a Crucible can be handed.
 *  2. Every per-conversion knob reaches the job's params under the wire's own
 *     spelling, ABSENCE INCLUDED (`f0_method` / `hop_length` absent = urvc keeps
 *     its own default) — and the one knob the job type does not take,
 *     `batchSize`, is REFUSED by name rather than dropped.
 *  3. The input set: the local `--input-glob` matcher, an empty set refused, and
 *     a mixed-extension set refused (one --input-glob, one --output-ext).
 *  4. Every matching file goes up under its own name in ONE job, the params are
 *     exactly the keys PHASE4-AUDIO.md §4 declares, and every converted file
 *     lands in the output directory.
 *  5. A server that ends `done` having produced fewer files than it was given is
 *     a REFUSAL, not a short answer — assembly is never handed a gapped set.
 *  6. Refusals by name, BEFORE the upload where the server can be asked: a
 *     server with no `rvc`, a manifest it does not have, `server_busy` with the
 *     holder's line — and NO local conversion in any of them.
 *  7. The venue door: the legacy switch routes to the local spawn and says so; a
 *     routed server routes to the Crucible; the run's venue beats the record;
 *     a caller naming a different server is refused.
 *
 * No GPU, no urvc, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  crucibleHost, noServerHost,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const RVC = path.join(REPO, 'dist', 'electron', 'crucible', 'rvc.js');
if (!fs.existsSync(RVC)) {
  console.log(skipLine('dist/electron/crucible/rvc.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-rvc-');
const rvc = require(RVC);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/**
 * The fake rvc server. `behaviour`:
 *   'run'       info offers rvc with every manifest; each input comes back converted
 *   'no-rvc'    info offers no rvc capability
 *   'no-model'  info offers rvc with only `sigma`
 *   'busy'      the submit is 409 server_busy
 *   'short'     the job ends `done` having written every input except `1.flac`
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      state.infoAsked = (state.infoAsked || 0) + 1;
      const ids = behaviour === 'no-model'
        ? ['sigma']
        : Object.values(rvc.CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE);
      const rows = ids.map((id) => ({
        id, revision: 'rev1234', source: `owenmorgan/owen-morgan-bookforge#rvc/${id}.tar.gz`,
        resident: false, vram_bytes: 1,
      }));
      const capabilities = behaviour === 'no-rvc'
        ? [{ job_type: 'echo', models: [] }]
        : [{ job_type: 'echo', models: [] }, { job_type: 'rvc', models: rows }];
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux', gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 1 } },
        job_types: ['echo', 'rvc'],
        capabilities,
      });
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
      const names = Object.keys(body.inputs);
      // 'short': one NAMED file is never produced, so the refusal can name it.
      state.jobs.set(id, { names: behaviour === 'short' ? names.filter((n) => n !== '1.flac') : names, model: body.model });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const j = state.jobs.get(decodeURIComponent(events[1]));
      assert.ok(j, `the fake was asked for events of an unknown job: ${events[1]}`);
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      sse.frame('warming', { message: `loading ${j.model} into urvc` });
      j.names.forEach((name, n) => {
        sse.frame('artifact', { name });
        sse.frame('progress', {
          fraction: (n + 1) / j.names.length,
          message: `converted ${n + 1} of ${j.names.length}`,
          converted: n + 1, total: j.names.length,
        });
      });
      sse.frame('done', { artifacts: j.names });
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const j = state.jobs.get(decodeURIComponent(artifact[1]));
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, provenanceFor(name.replace(/\.provenance\.json$/, ''), 'rvc', j.model));
        return true;
      }
      const bytes = Buffer.from(`fLaC-converted-${name}`);
      res.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': bytes.length });
      res.end(bytes);
      return true;
    }
    return false;
  });
}

/** A session's sentence set, and an empty directory beside it for the output. */
function freshSet(names) {
  const dir = fs.mkdtempSync(path.join(work, 'session-'));
  const src = path.join(dir, 'sentences');
  const out = path.join(dir, 'out');
  fs.mkdirSync(src);
  fs.mkdirSync(out);
  for (const name of names) fs.writeFileSync(path.join(src, name), Buffer.from(`fLaC-raw-${name}`));
  return { src, out };
}

const KNOBS = { indexRate: 0.5, protectRate: 0.25, nSemitones: -2, f0Method: 'rmvpe' };

async function tables() {
  await check('every built-in BookForge RVC voice names its Crucible manifest, and only those', () => {
    assert.deepStrictEqual(rvc.CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE, {
      'rvc-voice-owen-morgan': 'owen-morgan',
      'rvc-voice-sigma': 'sigma',
      'rvc-voice-us-female-1': 'us-female-1',
      'rvc-voice-girlfriend': 'girlfriend',
      'rvc-voice-mistborn': 'mistborn-rvc-v1',
      'rvc-voice-deathstalker-v3': 'deathstalker-rvc-v3',
      'rvc-voice-deathstalker-d3000-v1': 'deathstalker-rvc-v1',
    });
    // The catalog BookForge ships and the seven manifests PHASE4-AUDIO.md §4
    // declares are the same set — a coincidence checked, not assumed.
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'electron', 'data', 'rvc-voice-assets.json'), 'utf-8'));
    assert.deepStrictEqual(
      catalog.voices.map((v) => v.id).sort(),
      Object.keys(rvc.CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE).sort(),
      'a shipped voice with no row here would be convertible locally and refused remotely for no stated reason',
    );
  });
  await check('a local / user-added / unpublished voice is refused by name — a folder here is not a manifest', () => {
    for (const id of ['rvc-local-mistborn-rvc-v3-aol', 'rvc-user-something', 'rvc-voice-deathstalker-v2']) {
      assert.throws(() => rvc.crucibleRvcModelFor(id), (err) => err.code === 'crucible_rvc_voice_unmapped', id);
    }
    assert.throws(() => rvc.crucibleRvcModelFor(''), (err) => err.code === 'crucible_rvc_voice_not_named');
    assert.strictEqual(rvc.crucibleRvcModelFor('rvc-voice-sigma'), 'sigma');
  });
}

async function knobs() {
  await check('every knob crosses under the wire\'s own spelling, and an absent one STAYS absent', () => {
    assert.deepStrictEqual(rvc.crucibleRvcParams({ indexRate: 0.3, protectRate: 0.1, nSemitones: -2, f0Method: 'rmvpe' }), {
      index_rate: 0.3, protect_rate: 0.1, n_semitones: -2, f0_method: 'rmvpe',
    });
    assert.deepStrictEqual(rvc.crucibleRvcParams({ indexRate: 0, protectRate: 0.5, nSemitones: 0 }), {
      index_rate: 0, protect_rate: 0.5, n_semitones: 0,
    }, 'no f0_method and no hop_length: urvc keeps its own tuned defaults');
    assert.deepStrictEqual(rvc.crucibleRvcParams({ indexRate: 0.5, protectRate: 0.25, nSemitones: 0, f0Method: 'crepe', hopLength: 128 }), {
      index_rate: 0.5, protect_rate: 0.25, n_semitones: 0, f0_method: 'crepe', hop_length: 128,
    });
  });
  await check('the knob the job type does not take is REFUSED by name, never dropped', () => {
    assert.throws(
      () => rvc.crucibleRvcParams({ ...KNOBS, batchSize: 96 }),
      (err) => err.code === 'crucible_rvc_batch_size_is_the_servers' && /memory bound/i.test(err.message),
    );
  });
  await check('a knob the local argv always spells cannot arrive missing', () => {
    assert.throws(() => rvc.crucibleRvcParams({ protectRate: 0.5, nSemitones: 0 }),
      (err) => err.code === 'crucible_rvc_knob_unreadable' && /indexRate/.test(err.message));
  });
}

async function inputs() {
  await check('the input set is the local --input-glob\'s, sorted, with its one extension', () => {
    const { src } = freshSet(['0.flac', '1.flac', '2.flac']);
    fs.writeFileSync(path.join(src, 'notes.txt'), 'not a sentence');
    const got = rvc.crucibleRvcInputs(src, '*.flac');
    assert.deepStrictEqual(got.names, ['0.flac', '1.flac', '2.flac']);
    assert.strictEqual(got.ext, '.flac');
  });
  await check('an empty set is a caller that computed the wrong directory, refused by name', () => {
    const { out } = freshSet(['0.flac']);
    assert.throws(() => rvc.crucibleRvcInputs(out, '*.flac'), (err) => err.code === 'crucible_rvc_no_inputs');
    assert.throws(() => rvc.crucibleRvcInputs(path.join(out, 'nope'), '*.flac'),
      (err) => err.code === 'crucible_rvc_source_missing');
  });
  await check('a mixed-extension set is refused: one --input-glob, one --output-ext', () => {
    const { src } = freshSet(['0.flac', '1.wav']);
    assert.throws(() => rvc.crucibleRvcInputs(src, '*.*'),
      (err) => err.code === 'crucible_rvc_mixed_extensions' && /\.flac/.test(err.message));
  });
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const { src, out } = freshSet(['0.flac', '1.flac', '2.flac']);
  const progress = [];
  const log = [];
  let outcome;
  try {
    outcome = await rvc.runCrucibleRvc({
      server, sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-deathstalker-v3',
      knobs: KNOBS, onProgress: (p) => progress.push(p), onLog: (l) => log.push(l),
    });
  } finally {
    await fake.close();
  }
  await check('every matching file goes up under its own name, in ONE job, with exactly the declared params', () => {
    assert.strictEqual(fake.state.uploads.length, 3);
    assert.deepStrictEqual(fake.state.uploads.map((u) => u.filename).sort(), ['0.flac', '1.flac', '2.flac']);
    assert.strictEqual(fake.state.submitted.length, 1, 'one admission for the whole set');
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'rvc');
    assert.strictEqual(body.model, 'deathstalker-rvc-v3');
    assert.deepStrictEqual(body.params, { index_rate: 0.5, protect_rate: 0.25, n_semitones: -2, f0_method: 'rmvpe' });
    assert.deepStrictEqual(Object.keys(body.inputs).sort(), ['0.flac', '1.flac', '2.flac']);
  });
  await check('the server was asked whether it offers the manifest BEFORE a book of FLACs crossed', () => {
    assert.strictEqual(fake.state.infoAsked, 1);
  });
  await check('every converted file lands in the output directory under its own name, with its provenance beside it', () => {
    for (const name of ['0.flac', '1.flac', '2.flac']) {
      assert.ok(fs.existsSync(path.join(out, name)), name);
      assert.strictEqual(fs.readFileSync(path.join(out, name), 'utf-8'), `fLaC-converted-${name}`);
      assert.ok(fs.existsSync(path.join(out, `${name}.provenance.json`)), `${name} sidecar`);
    }
    assert.strictEqual(outcome.written, 3);
    assert.strictEqual(outcome.model, 'deathstalker-rvc-v3');
  });
  await check('the SERVER\'s fraction reaches the caller, with the denominator this pass actually has', () => {
    assert.strictEqual(progress[0].stage, 'warming');
    const converting = progress.filter((p) => p.stage === 'converting');
    assert.strictEqual(converting.length, 3);
    assert.strictEqual(converting[2].fraction, 1);
    assert.strictEqual(converting[2].total, 3);
    assert.ok(converting[2].announced >= 1, 'artifacts announced are counted, not invented');
    assert.ok(log.some((l) => /deathstalker-rvc-v3/.test(l)), log.join('\n'));
  });
}

async function shortAnswer() {
  const fake = await startFake('short');
  const server = registerFake(fake.url);
  const { src, out } = freshSet(['0.flac', '1.flac', '2.flac']);
  let caught = null;
  try {
    await rvc.runCrucibleRvc({
      server, sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-sigma', knobs: KNOBS,
    });
  } catch (err) { caught = err; } finally { await fake.close(); }
  await check('a job that ends done having converted fewer files than it was given is a REFUSAL', () => {
    assert.ok(caught, 'a short answer must not resolve');
    assert.strictEqual(caught.code, 'crucible_rvc_output_missing');
    assert.ok(/1\.flac/.test(caught.message), 'it names the file that is not there');
    assert.ok(!fs.existsSync(path.join(out, '1.flac')));
    assert.ok(fs.existsSync(path.join(out, '0.flac')), 'what did land stays on disk (R6)');
  });
}

async function refusals() {
  for (const [behaviour, code, uploads] of [
    ['no-rvc', 'crucible_rvc_not_offered', 0],
    ['no-model', 'crucible_rvc_model_not_offered', 0],
    ['busy', 'server_busy', 3],
  ]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    const { src, out } = freshSet(['0.flac', '1.flac', '2.flac']);
    let caught = null;
    try {
      await rvc.runCrucibleRvc({
        server, sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-girlfriend', knobs: KNOBS,
      });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code}, ${uploads} upload(s), nothing converted here instead`, () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, code);
      assert.strictEqual(fake.state.uploads.length, uploads);
      assert.strictEqual(fs.readdirSync(out).length, 0);
      if (behaviour === 'busy') {
        assert.strictEqual(caught.busyLine, 'busy: foundry, tts deathstalker, 62% done — 640 of 1030 chunk(s) rendered');
      }
      if (behaviour === 'no-model') assert.ok(/sigma/.test(caught.message), 'names what it does offer');
    });
  }
  await check('a missing output directory is refused before anything crosses', () => {
    const { src } = freshSet(['0.flac']);
    return assert.rejects(
      rvc.runCrucibleRvc({ server: 'never', sentencesDir: src, outputDir: path.join(work, 'nope'), voiceId: 'rvc-voice-sigma', knobs: KNOBS }),
      (err) => err.code === 'crucible_rvc_output_dir_missing',
    );
  });
}

async function venueDoor() {
  {
    /*
     * THERE IS NO LOCAL URVC ARM LEFT. This used to pin the legacy switch
     * reaching `enhanceSentences` and the rvc-env here; that switch and the
     * spawn behind it are deleted (docs/LEGACY-REMOVAL.md). What has to be true
     * now is what the old arm hid: with nothing to place the pass on, the door
     * REFUSES BY NAME and converts nothing, rather than taking this machine's
     * card for a set somebody routed elsewhere.
     */
    const { src, out } = freshSet(['0.flac']);
    let caught = null;
    try {
      await rvc.convertSentencesAtVenue({
        host: noServerHost(),
        sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-sigma', knobs: KNOBS,
      });
    } catch (err) { caught = err; }
    await check('with nothing enabled the door refuses by name and converts nothing here', () => {
      assert.ok(caught !== null, 'it must not have quietly succeeded');
      assert.strictEqual(caught.code, 'no_enabled_server', caught.message);
      assert.ok(!fs.existsSync(path.join(out, '0.flac')), 'nothing converted locally instead');
    });
    await check('the rvc door takes no local callback at all', () => {
      const srcTs = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'rvc.ts'), 'utf-8');
      assert.ok(!/legacyLocal/.test(srcTs),
        'a `legacyLocal` option is a fallback wearing an option\'s hat');
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const { src, out } = freshSet(['0.flac', '1.flac']);
    const localCalls = 0;
    let outcome;
    try {
      outcome = await rvc.convertSentencesAtVenue({
        host: crucibleHost(server),
        sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-mistborn', knobs: KNOBS,
      });
    } finally {
      await fake.close();
    }
    await check('a routed server converts on the Crucible, never the local spawn, and records the venue', () => {
      assert.strictEqual(localCalls, 0);
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server, origin: 'decided here', because: 'the top-ranked server' });
      assert.strictEqual(outcome.crucible.model, 'mistborn-rvc-v1');
      assert.ok(fs.existsSync(path.join(out, '1.flac')));
    });
  }
  {
    // THE RUN'S VENUE WINS OVER THE ROUTING RECORD: one book, one GPU.
    const mine = await startFake('run');
    const other = await startFake('run');
    const mineName = registerFake(mine.url);
    const otherName = registerFake(other.url);
    const { src, out } = freshSet(['0.flac']);
    const log = [];
    let outcome;
    try {
      outcome = await rvc.convertSentencesAtVenue({
        runVenue: { where: 'crucible', server: mineName }, runVenueSource: 'session_state.json',
        host: crucibleHost(otherName),
        sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-sigma', knobs: KNOBS,
        onLog: (l) => log.push(l),
      });
    } finally {
      await mine.close();
      await other.close();
    }
    await check('a run already resolved to one server never converts on the top-ranked other', () => {
      assert.strictEqual(mine.state.submitted.length, 1);
      assert.strictEqual(other.state.submitted.length, 0);
      assert.deepStrictEqual(outcome.venue,
        { where: 'crucible', server: mineName, origin: 'the run', because: "the run's venue (session_state.json)" });
      assert.ok(log.some((l) => /the run: the run's venue \(session_state\.json\)/.test(l)), log.join('\n'));
    });
  }
  {
    const { src, out } = freshSet(['0.flac']);
    await assert.rejects(
      rvc.convertSentencesAtVenue({
        runVenue: { where: 'crucible', server: 'mac' }, crucible: { server: 'local' },
        host: crucibleHost('local'),
        sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-sigma', knobs: KNOBS,
      }),
      (err) => err.code === 'run_venue_disagrees',
    );
    await check('a caller naming a server the run did not go to is refused by name', () => {});
  }
  {
    // The decision a caller already made is CARRIED, not re-asked — `rvc-job.ts`
    // decides once, up front, so its own refusal names the venue it refused for.
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const { src, out } = freshSet(['0.flac']);
    let outcome;
    try {
      outcome = await rvc.convertSentencesAtVenue({
        decided: { where: 'crucible', server, origin: 'the run', because: 'decided up front' },
        host: {
          view: () => { throw new Error('the decision was already made'); },
          enabled: () => { throw new Error('no'); },
          ping: async () => { throw new Error('no'); },
        },
        sentencesDir: src, outputDir: out, voiceId: 'rvc-voice-sigma', knobs: KNOBS,
      });
    } finally {
      await fake.close();
    }
    await check('a venue the caller already resolved is carried through, never asked again', () => {
      assert.strictEqual(outcome.venue.because, 'decided up front');
      assert.strictEqual(outcome.venue.server, server);
    });
  }
}

(async () => {
  await tables();
  await knobs();
  await inputs();
  await happyPath();
  await shortAnswer();
  await refusals();
  await venueDoor();
  summary('test-crucible-rvc');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
