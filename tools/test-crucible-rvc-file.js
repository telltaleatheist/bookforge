#!/usr/bin/env node
/**
 * ONE WHOLE FILE THROUGH AN RVC VOICE, ON A CRUCIBLE — the door behind `--rvc`.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-rvc-file.js
 *
 * `electron/crucible/rvc-file.ts` chunks a finished audio file at its silences,
 * converts the chunks in a Crucible `rvc` job and stitches them back. It replaced
 * the local urvc worker (docs/REORG-PLAN.md, B2). Against a FAKE Crucible and real
 * ffmpeg, this pins: the chunk planner, the folder → asset id map, a real run end to
 * end (chunks uploaded as WAV, knobs on the wire, the stitched file readable and as
 * long as the chunks that came back), a missing chunk refused rather than stitched
 * over, and a server that cannot take it refused by name.
 *
 * No GPU, no urvc, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  crucibleHost, ENGINE_INFO_FIELDS,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const DOOR = path.join(REPO, 'dist', 'electron', 'crucible', 'rvc-file.js');
if (!fs.existsSync(DOOR)) {
  console.log(skipLine('dist/electron/crucible/rvc-file.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-rvc-file-');
const door = require(DOOR);
const rvc = require(path.join(REPO, 'dist', 'electron', 'crucible', 'rvc.js'));
const toolPaths = require(path.join(REPO, 'dist', 'electron', 'tool-paths.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

let ffmpeg;
let ffprobe;
try {
  ffmpeg = toolPaths.getFfmpegPath();
  ffprobe = toolPaths.getFfprobePath();
  execFileSync(ffmpeg, ['-version'], { stdio: 'ignore' });
} catch (err) {
  console.log(skipLine(`ffmpeg is not usable here (${err.message})`));
  process.exit(0);
}

const FOLDER = 'deathstalker_rvc_v1';
const VOICE_ID = 'rvc-voice-deathstalker-d3000-v1';
const KNOBS = { indexRate: 0, protectRate: 0.2, nSemitones: 0, f0Method: 'rmvpe' };

/** A real WAV of `seconds`, for the input and for what the fake hands back. */
function wav(file, seconds) {
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds}`,
    '-ar', '48000', '-ac', '1', '-y', file]);
  return file;
}
const secondsOf = (file) => parseFloat(execFileSync(ffprobe,
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString());

const CONVERTED = wav(path.join(work, 'converted-1s.wav'), 1);
const INPUT = wav(path.join(work, 'book.wav'), 200);

/** `behaviour`: 'run' | 'short' (the last chunk never comes back) | 'no-rvc'. */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;
    if (route === '/v1/info' && req.method === 'GET') {
      const rows = Object.values(rvc.CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE).map((id) => ({
        id, revision: 'rev1234', source: `x#${id}`, resident: false, vram_bytes: 1,
      }));
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux', gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 1 } },
        ...ENGINE_INFO_FIELDS,
        job_types: ['echo', 'rvc'],
        capabilities: behaviour === 'no-rvc'
          ? [{ job_type: 'echo', models: [] }]
          : [{ job_type: 'echo', models: [] }, { job_type: 'rvc', models: rows }],
      });
      return true;
    }
    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      const id = ctx.newJobId();
      const names = Object.keys(body.inputs).sort();
      state.jobs.set(id, { names: behaviour === 'short' ? names.slice(0, -1) : names, model: body.model });
      send(res, 200, { job_id: id });
      return true;
    }
    const events = /^\/v1\/jobs\/([^/]+)\/events$/.exec(route);
    if (events && req.method === 'GET') {
      const j = state.jobs.get(decodeURIComponent(events[1]));
      const sse = sseWriter(req, res);
      sse.frame('started', { waited_s: 0 });
      j.names.forEach((name, n) => {
        sse.frame('artifact', { name });
        sse.frame('progress', { fraction: (n + 1) / j.names.length, message: `${n + 1}`, converted: n + 1, total: j.names.length });
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
      const bytes = fs.readFileSync(CONVERTED);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
      res.end(bytes);
      return true;
    }
    return false;
  });
}

async function main() {
  await check('the chunk planner cuts at the nearest silence, and hard-cuts when there is none', () => {
    assert.deepStrictEqual(door.parseSilenceMids(
      '[silencedetect] silence_start: 10\n[silencedetect] silence_end: 12 | silence_duration: 2\n'), [11]);
    assert.deepStrictEqual(door.computeChunkCutPoints([590], 2000, 600).slice(0, 2), [0, 590]);
    assert.deepStrictEqual(door.computeChunkCutPoints([], 1000, 600), [0, 600, 1000]);
    assert.deepStrictEqual(door.computeChunkCutPoints([], 650, 600), [0, 650], 'the tail stays on the last chunk');
  });

  await check('a voice-model folder maps to its asset id; an unknown one is refused by name', () => {
    assert.strictEqual(door.rvcVoiceIdForModelFolder(FOLDER), VOICE_ID);
    assert.throws(() => door.rvcVoiceIdForModelFolder('no_such_voice'),
      (e) => e.code === 'crucible_rvc_voice_unmapped' && /no_such_voice/.test(e.message));
  });

  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const out = path.join(work, 'run', 'book RVC.flac');
    const r = await door.convertFileAtVenue({
      crucible: { server }, host: crucibleHost(server), inputPath: INPUT, outputPath: out,
      modelFolder: FOLDER, knobs: KNOBS, chunkSeconds: 30,
    });
    await fake.close();
    await check('a whole file goes up as WAV chunks, with the knobs on the wire', () => {
      const body = fake.state.submitted[0];
      assert.strictEqual(body.type, 'rvc');
      assert.strictEqual(body.model, rvc.CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE[VOICE_ID]);
      const names = Object.keys(body.inputs).sort();
      assert.strictEqual(names.length, r.chunks);
      assert.ok(r.chunks >= 2, `a 200 s file at 30 s chunks made ${r.chunks}`);
      assert.strictEqual(names[0], 'chunk_0000.wav');
      assert.strictEqual(body.params.index_rate, 0);
      assert.strictEqual(body.params.protect_rate, 0.2);
      assert.strictEqual(body.params.f0_method, 'rmvpe');
    });
    await check('the stitched file is readable, FLAC by its extension, and as long as the chunks', () => {
      assert.strictEqual(r.outputPath, out);
      assert.ok(Math.abs(secondsOf(out) - r.chunks) < 0.1, `${secondsOf(out)} s from ${r.chunks} 1 s chunk(s)`);
      assert.strictEqual(fs.readFileSync(out).subarray(0, 4).toString(), 'fLaC');
    });
  }

  {
    const fake = await startFake('short');
    const server = registerFake(fake.url);
    const out = path.join(work, 'short', 'o.flac');
    let caught = null;
    try {
      await door.convertFileAtVenue({
        crucible: { server }, host: crucibleHost(server), inputPath: INPUT, outputPath: out,
        modelFolder: FOLDER, knobs: KNOBS, chunkSeconds: 30,
      });
    } catch (err) { caught = err; }
    await fake.close();
    await check('a chunk that never came back fails the run, and nothing is stitched over the gap', () => {
      assert.ok(caught, 'a gapped book was reported as success');
      assert.ok(!fs.existsSync(out), 'a gapped file was written');
    });
  }

  {
    const fake = await startFake('no-rvc');
    const server = registerFake(fake.url);
    let caught = null;
    try {
      await door.convertFileAtVenue({
        crucible: { server }, host: crucibleHost(server), inputPath: INPUT,
        outputPath: path.join(work, 'no', 'o.flac'), modelFolder: FOLDER, knobs: KNOBS, chunkSeconds: 30,
      });
    } catch (err) { caught = err; }
    await fake.close();
    await check('a server with no rvc is refused by name, before anything is uploaded', () => {
      assert.ok(caught && /crucible_rvc_not_offered/.test(`${caught.code} ${caught.message}`), String(caught));
      assert.strictEqual(fake.state.uploads.length, 0);
    });
  }

  summary('test-crucible-rvc-file');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
