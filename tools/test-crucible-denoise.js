#!/usr/bin/env node
/**
 * THE HISS PASS ON SOMEBODY ELSE'S CARD, AND THE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-denoise.js
 *
 * `electron/crucible/denoise.ts` is deliberately NOT a whole-pass door: the
 * blocks, the offsets manifest, the frame-exact checks and the slicing stay in
 * `denoise-bridge.ts` (PHASE4-AUDIO.md §4.2: "Blocking stays in the client …
 * Crucible denoises one thing at a time"), and only the separator moves. So
 * what this pins, against a FAKE Crucible, is the separator seam and the venue:
 *
 *  1. The model id: the wire's manifest (`denoise-roformer`) is not the local
 *     checkpoint filename, and `params` is EMPTY — a statement, not an omission,
 *     because the server forbids extra keys.
 *  2. One block goes up under its own basename, every stem comes back, and the
 *     path returned is the one the SERVER named as primary — not the one whose
 *     filename happens to say `(dry)`.
 *  3. A `done` that names no primary, and a primary the job did not write, are
 *     each refused BY NAME. Neither is guessed at from a filename.
 *  4. The capability question is asked ONCE, in `start`, before any block
 *     crosses — and separating before that is refused rather than putting the
 *     refusal after the upload.
 *  5. Refusals by name: a server with no `denoise`, a model it does not have,
 *     `server_busy` with the holder's line.
 *  6. The venue door: there is no local arm left to run (docs/LEGACY-REMOVAL.md);
 *     a routed server runs the remote arm with that server's name; the run's
 *     venue beats the routing record; a caller naming a different server is
 *     refused.
 *
 * No GPU, no audio-separator, no network beyond 127.0.0.1.
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

const DENOISE = path.join(REPO, 'dist', 'electron', 'crucible', 'denoise.js');
if (!fs.existsSync(DENOISE)) {
  console.log(skipLine('dist/electron/crucible/denoise.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-denoise-');
const denoise = require(DENOISE);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/** What the roformer writes: the denoised signal and the noise it took out. */
const PRIMARY = 'block_00_(dry)_denoise_mel_band_roformer.wav';
const OTHER = 'block_00_(other)_denoise_mel_band_roformer.wav';

/**
 * The fake denoise server. `behaviour`:
 *   'run'          both stems, `done` naming the primary
 *   'no-denoise'   info offers no denoise capability
 *   'no-model'     info offers denoise with a different model id
 *   'busy'         the submit is 409 server_busy
 *   'no-primary'   `done` names no primary stem
 *   'lying'        `done` names a primary the job never wrote
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      state.infoAsked = (state.infoAsked || 0) + 1;
      const id = behaviour === 'no-model' ? 'denoise-something-else' : denoise.CRUCIBLE_DENOISE_MODEL;
      const capabilities = behaviour === 'no-denoise'
        ? [{ job_type: 'echo', models: [] }]
        : [
          { job_type: 'echo', models: [] },
          { job_type: 'denoise', models: [{ id, revision: 'rev1', source: 'Politrees/UVR_resources', resident: false, vram_bytes: 1 }] },
        ];
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux', gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 1 } },
        job_types: ['echo', 'denoise'],
        capabilities,
      });
      return true;
    }

    // THE LEASE. A pass is ~44 blocks and `crucible/settle.py` clears the card
    // the moment the last holder lets go, so without one the resident separator
    // is unloaded between every pair of blocks and each block reloads a 913 MB
    // checkpoint — the exact cost `separator_worker.py` was written to remove.
    const lease = /^\/v1\/models\/([^/]+)\/lease$/.exec(route);
    if (lease && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.leases = state.leases || [];
      state.leases.push({ subject: decodeURIComponent(lease[1]), act: body.act });
      send(res, 201, {
        lease_id: 'lease-1',
        subject: decodeURIComponent(lease[1]),
        kind: 'denoise',
        act: body.act,
        since: '2026-09-15T12:00:00Z',
        expires_at: '2026-09-15T12:05:00Z',
      });
      return true;
    }
    if (/^\/v1\/leases\/[^/]+$/.test(route) && req.method === 'DELETE') {
      state.leasesReleased = (state.leasesReleased || 0) + 1;
      res.writeHead(204).end();
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
      state.jobs.set(id, { body });
      send(res, 200, { job_id: id });
      return true;
    }

    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      sse.frame('warming', { message: 'loading denoise_mel_band_roformer' });
      sse.frame('artifact', { name: PRIMARY });
      sse.frame('artifact', { name: OTHER });
      sse.frame('progress', { fraction: 1, message: 'separated 1 file' });
      const done = { artifacts: [PRIMARY, OTHER] };
      if (behaviour === 'lying') done.primary = 'a_stem_nobody_wrote.wav';
      else if (behaviour !== 'no-primary') done.primary = PRIMARY;
      sse.frame('done', done);
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const name = decodeURIComponent(artifact[2]);
      if (name.endsWith('.provenance.json')) {
        send(res, 200, provenanceFor(name.replace(/\.provenance\.json$/, ''), 'denoise', denoise.CRUCIBLE_DENOISE_MODEL));
        return true;
      }
      const bytes = Buffer.from(`RIFF-fake-${name}`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
      res.end(bytes);
      return true;
    }
    return false;
  });
}

/** A block on disk and an empty directory for its stems. */
function freshBlock() {
  const dir = fs.mkdtempSync(path.join(work, 'denoise-'));
  const block = path.join(dir, 'block_00.wav');
  const out = path.join(dir, 'dn_00');
  fs.writeFileSync(block, Buffer.from('RIFF-fake-block'));
  fs.mkdirSync(out);
  return { block, out, dir };
}

async function identity() {
  await check('the wire names a MANIFEST, which is not the local checkpoint filename', () => {
    assert.strictEqual(denoise.CRUCIBLE_DENOISE_MODEL, 'denoise-roformer');
    const bridge = fs.readFileSync(path.join(REPO, 'electron', 'denoise-bridge.ts'), 'utf-8');
    assert.ok(/denoise_mel_band_roformer_aufr33_sdr_27\.9959\.ckpt/.test(bridge),
      'the local path still resolves the model by checkpoint filename — two names for one model');
    assert.ok(!bridge.includes(`'${denoise.CRUCIBLE_DENOISE_MODEL}'`),
      'the manifest id is the wire\'s and is not spelled a second time in the local bridge');
  });
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const { block, out } = freshBlock();
  const log = [];
  const sep = denoise.crucibleBlockSeparator({ server, onLog: (l) => log.push(l) });
  let primaryPath;
  try {
    const announce = sep.starting(3);
    log.push(announce);
    log.push(await sep.start(out, 3));
    primaryPath = await sep.separate(block, out);
  } finally {
    await sep.dispose();
    await fake.close();
  }
  await check('a pass HOLDS the separator: one lease, named truthfully, released at the end', () => {
    /*
     * THE HALF OF THE RESIDENCY THAT IS THIS SIDE'S.
     *
     * Crucible holds the separator across jobs (KIND_DENOISE, 2026-09-15), but
     * `crucible/settle.py` clears the card the moment the last holder lets go —
     * and a pass is ~44 separate jobs. Without a lease open across them the
     * card is cleared between every pair, each block reloads a 913 MB
     * checkpoint, and the pass is ~a third slower with every job succeeding and
     * every log clean. That is the exact cost `separator_worker.py` removed on
     * the local side (bookforge `019afa52`) and the exact shape this whole
     * campaign is about, so it is pinned rather than trusted.
     */
    assert.deepStrictEqual(fake.state.leases, [
      { subject: denoise.CRUCIBLE_DENOISE_MODEL, act: 'denoise' },
    ], 'a pass must take exactly one lease, on the separator, named `denoise`');
    // Taken AFTER the first block, never in start(): a lease names what is
    // already resident, and nothing is resident until a job has made it so.
    assert.ok(log.some((line) => /holding denoise-roformer/.test(line)), log.join(' | '));
    // And given back, or somebody else's card stays held for the lease's ttl
    // over a pass that has finished.
    assert.strictEqual(fake.state.leasesReleased, 1);
  });

  await check('the capability question is asked once, in start(), before any block crosses', () => {
    assert.strictEqual(fake.state.infoAsked, 1);
    assert.ok(log.some((l) => /will be denoised on crucible/.test(l)), log.join('\n'));
  });
  await check('one block goes up under its own basename, with params EXACTLY empty', () => {
    assert.strictEqual(fake.state.uploads.length, 1);
    assert.strictEqual(fake.state.uploads[0].filename, 'block_00.wav');
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'denoise');
    assert.strictEqual(body.model, 'denoise-roformer');
    assert.deepStrictEqual(body.params, {}, 'every knob is an engine default the server owns');
    assert.deepStrictEqual(Object.keys(body.inputs), ['block_00.wav']);
  });
  await check('every stem lands, and the path returned is the one the SERVER named primary', () => {
    assert.strictEqual(primaryPath, path.join(out, PRIMARY));
    assert.ok(fs.existsSync(path.join(out, PRIMARY)));
    assert.ok(fs.existsSync(path.join(out, OTHER)), 'the other stems are kept, not discarded');
    assert.ok(fs.existsSync(path.join(out, `${PRIMARY}.provenance.json`)));
  });
}

async function primaryRefusals() {
  for (const [behaviour, code] of [
    ['no-primary', 'crucible_denoise_primary_unnamed'],
    ['lying', 'crucible_denoise_primary_missing'],
  ]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    const { block, out } = freshBlock();
    const sep = denoise.crucibleBlockSeparator({ server });
    let caught = null;
    try {
      await sep.start(out, 1);
      await sep.separate(block, out);
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code} — the primary stem is never guessed from a filename`, () => {
      assert.ok(caught, 'it must not resolve');
      assert.strictEqual(caught.code, code);
      assert.ok(/PHASE4|primary/.test(caught.message));
    });
  }
  await check('separating before start() is refused — the refusal must not land after the upload', async () => {
    const sep = denoise.crucibleBlockSeparator({ server: 'never' });
    const { block, out } = freshBlock();
    await assert.rejects(sep.separate(block, out), (err) => err.code === 'crucible_denoise_not_started');
  });
}

async function refusals() {
  for (const [behaviour, code, uploads] of [
    ['no-denoise', 'crucible_denoise_not_offered', 0],
    ['no-model', 'crucible_denoise_model_not_offered', 0],
    ['busy', 'server_busy', 1],
  ]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    const { block, out } = freshBlock();
    const sep = denoise.crucibleBlockSeparator({ server });
    let caught = null;
    try {
      await sep.start(out, 1);
      await sep.separate(block, out);
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code}, with ${uploads} upload(s) and no stem on disk`, () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, code);
      assert.strictEqual(fake.state.uploads.length, uploads);
      assert.strictEqual(fs.readdirSync(out).length, 0, 'nothing was separated here instead');
      if (behaviour === 'busy') {
        assert.strictEqual(caught.busyLine, 'busy: foundry, tts deathstalker, 62% done — 640 of 1030 chunk(s) rendered');
      }
      if (behaviour === 'no-model') assert.ok(/denoise-something-else/.test(caught.message), 'names what it does offer');
    });
  }
}

async function venueDoor() {
  {
    /*
     * THE LOCAL AUDIO-SEPARATOR ARM IS GONE. This used to pin the legacy switch
     * reaching the resident `separator_worker.py` in the rvc-env; that switch
     * and the spawn behind it are deleted (docs/LEGACY-REMOVAL.md). With
     * nothing to place the pass on, the door REFUSES BY NAME and separates
     * nothing — the one arm that remains is the remote one, and it is never
     * called for a venue that could not be decided.
     */
    let remote = 0;
    let caught = null;
    try {
      await denoise.denoiseAtVenue({
        host: noServerHost(),
        onCrucibleServer: async () => { remote += 1; return { dir: '/never' }; },
      });
    } catch (err) { caught = err; }
    await check('with nothing enabled the door refuses by name and separates nothing here', () => {
      assert.ok(caught !== null, 'it must not have quietly succeeded');
      assert.strictEqual(caught.code, 'no_enabled_server', caught.message);
      assert.strictEqual(remote, 0, 'and no server was asked to do it either');
    });
    await check('the denoise door takes no local callback at all', () => {
      const srcTs = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'denoise.ts'), 'utf-8');
      assert.ok(!/legacyLocal/.test(srcTs),
        'a `legacyLocal` option is a fallback wearing an option\'s hat');
    });
  }
  {
    let named = null;
    const outcome = await denoise.denoiseAtVenue({
      host: crucibleHost('mac'),
      onCrucibleServer: async (server) => { named = server; return { dir: '/remote/set' }; },
    });
    await check('a routed server runs the remote arm with that server\'s name', () => {
      assert.strictEqual(named, 'mac');
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server: 'mac', origin: 'decided here', because: 'the top-ranked server' });
      assert.deepStrictEqual(outcome.outcome, { dir: '/remote/set' });
    });
  }
  {
    let named = null;
    const log = [];
    const outcome = await denoise.denoiseAtVenue({
      runVenue: { where: 'crucible', server: 'mac' }, runVenueSource: 'session_state.json',
      host: crucibleHost('local'),
      onLog: (l) => log.push(l),
      onCrucibleServer: async (server) => { named = server; return { dir: '/mac/set' }; },
    });
    await check('a run already resolved to one server never denoises on the top-ranked other', () => {
      assert.strictEqual(named, 'mac');
      assert.strictEqual(outcome.venue.origin, 'the run');
      assert.ok(log.some((l) => /the run: the run's venue \(session_state\.json\)/.test(l)), log.join('\n'));
    });
  }
  {
    await assert.rejects(
      denoise.denoiseAtVenue({
        runVenue: { where: 'crucible', server: 'mac' }, crucible: { server: 'local' },
        host: crucibleHost('local'),
        onCrucibleServer: async () => { throw new Error('no'); },
      }),
      (err) => err.code === 'run_venue_disagrees',
    );
    await check('a caller naming a server the run did not go to is refused by name', () => {});
  }
  {
    /*
     * A RUN THE DELETED NARRATOR RENDERED IS REFUSED, NOT RE-DECIDED. It used
     * to denoise locally without re-deciding; that run-venue shape no longer
     * exists in the type, and the row's own string is turned away one level up
     * by `runVenueOfRow`, because re-deciding would put the second half of a
     * book on a different card (PHASE7-LANES §4.3).
     */
    const stepVenue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'step-venue.js'));
    const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
    await check('a run the deleted narrator rendered is refused by name, never denoised here', () => {
      assert.throws(
        () => stepVenue.runVenueOfRow(waitFor.RETIRED_LOCAL_NARRATOR_VENUE),
        (err) => err.code === 'legacy_venue_retired',
      );
    });
  }
}

(async () => {
  await identity();
  await happyPath();
  await primaryRefusals();
  await refusals();
  await venueDoor();
  summary('test-crucible-denoise');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
