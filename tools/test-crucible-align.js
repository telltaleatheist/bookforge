#!/usr/bin/env node
/**
 * FORCED ALIGNMENT ON SOMEBODY ELSE'S CARD, TO THE SEAM NARRATOR OWNS PAST.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-align.js
 *
 * `electron/crucible/align.ts` sends a rendered session's chunk audio and
 * spoken text to a Crucible `align` job and lands `alignment.json` (the
 * model's own items per chunk) in the session directory; `coverage-align-job.ts`
 * decides where an alignment runs the way a render's venue is decided, and —
 * because narrator has no door yet that turns those items into `coverage.json`
 * — fails the Crucible run BY NAME past that seam. Against a FAKE Crucible,
 * this pins:
 *
 *  1. The aligner table: `qwen3` → `qwen3-aligner`; `whisperx` refused by name
 *     (it lost the bake-off and is not ported).
 *  2. The text sent is narrator's spoken reading — markers stripped, whitespace
 *     collapsed — read out of the session's own record; a marker-only chunk and
 *     a chunk with no audio are skipped and NAMED, never sent.
 *  3. One job for the whole session: every chunk's FLAC under `<index>.flac`,
 *     `params.chunks` as `{index, text}`, the model id, the language.
 *  4. `cue` events reach the caller (a failed chunk's too), `alignment.json`
 *     and its provenance land in the process directory, and `done.failed` is
 *     read strictly.
 *  5. The venue door in `runCoverageAlign`: the legacy switch runs the local
 *     spawn and says so; a routed server runs the Crucible job, lands the
 *     artifact, and fails naming the owed narrator door; a CPU row is refused
 *     by name; `server_busy` carries the holder's line for the queue to hold on.
 *
 * No GPU, no aligner, no narrator, no network beyond 127.0.0.1.
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

const ALIGN = path.join(REPO, 'dist', 'electron', 'crucible', 'align.js');
if (!fs.existsSync(ALIGN)) {
  console.log(skipLine('dist/electron/crucible/align.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-align-');
const align = require(ALIGN);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const coverage = require(path.join(REPO, 'dist', 'electron', 'coverage-align-job.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/**
 * A session: four chunks over two chapters; 1 is marker-only, 2 has no FLAC.
 * `renderedOn` writes the render's venue into `session_state.json` the way
 * `parallel-tts-bridge.decideAndRememberVenue` persists it.
 */
function freshSession(renderedOn) {
  const dir = path.join(work, `session-${Math.random().toString(36).slice(2)}`);
  const sentences = path.join(dir, 'chapters', 'sentences');
  fs.mkdirSync(sentences, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-state.json'), JSON.stringify({
    chapter_sentences: [
      ['[break][heading]Chapter   One.', '[break]'],
      ['He had  been walking for some time.', 'The road [pause:1.5] turned north.'],
    ],
  }));
  for (const index of [0, 1, 3]) fs.writeFileSync(path.join(sentences, `${index}.flac`), `fLaC-${index}`);
  if (renderedOn !== undefined) {
    fs.writeFileSync(path.join(dir, 'session_state.json'), JSON.stringify({
      sessionId: 'abc', processDir: dir, runs: [],
      settings: { ttsEngine: 'higgs', fineTuned: 'mistborn', crucible: { server: renderedOn } },
    }));
  }
  return dir;
}

const ITEMS = {
  0: [{ text: 'Chapter', start: 0.3, end: 0.8 }, { text: 'One.', start: 0.9, end: 1.3 }],
  3: [{ text: 'The road', start: 0.2, end: 0.9 }, { text: 'turned', start: 1.0, end: 1.4 }, { text: 'north.', start: 1.5, end: 1.9 }],
};

/**
 * The fake align server. `behaviour`: 'run' | 'busy' | 'no-align' (a Mac: the
 * capability is off, `qwen3-aligner` has no mlx-darwin block). Chunk 3 is
 * reported failed.
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      state.infoAsked = (state.infoAsked || 0) + 1;
      const capabilities = behaviour === 'no-align'
        ? [{ job_type: 'echo', models: [] }, { job_type: 'tts', models: [] }]
        : [{ job_type: 'echo', models: [] }, { job_type: 'align', models: [
          { id: 'qwen3-aligner', revision: 'c7cbfc20', source: 'Qwen/Qwen3-ForcedAligner-0.6B', resident: false, vram_bytes: 1 },
        ] }];
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: behaviour === 'no-align' ? 'darwin' : 'linux', arch: 'arm64',
          backend: behaviour === 'no-align' ? 'mlx-darwin' : 'cuda-linux', gpu: { vendor: 'x', name: 'fake', vram_bytes: 1 } },
        job_types: ['echo'],
        capabilities,
      });
      return true;
    }

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      if (behaviour === 'busy') {
        send(res, 409, { error: { code: 'server_busy', message: 'one at a time', details: {
          holder: 'foundry', job_id: 'j-held', type: 'llm', model: 'qwen3.5-9b', status: 'running',
          since: '2026-09-14T01:00:00Z', progress: 0.3, message: null,
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
      const entry = state.jobs.get(decodeURIComponent(events[1]));
      const chunks = entry.body.params.chunks;
      const sse = sseWriter(req, res);
      sse.frame('queued', { position: null });
      sse.frame('warming', { message: 'loaded qwen3-aligner on cuda in 8.2s' });
      chunks.forEach((chunk, n) => {
        sse.frame('progress', {
          fraction: (n + 1) / chunks.length, message: `aligned ${n + 1} of ${chunks.length} chunk(s)`,
          stage: 'aligning', processed: n + 1, total: chunks.length,
        });
        if (chunk.index === 3) sse.frame('cue', { index: 3, error: '2.1s of audio for 4 word(s): could not place' });
        else sse.frame('cue', { index: chunk.index, items: ITEMS[chunk.index] });
      });
      sse.frame('artifact', { name: 'alignment.json' });
      sse.frame('done', { artifacts: ['alignment.json'], chunks: chunks.length, failed: [3], resident: 'qwen3-aligner' });
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const entry = state.jobs.get(decodeURIComponent(artifact[1]));
      const name = decodeURIComponent(artifact[2]);
      if (name === 'alignment.json.provenance.json') {
        send(res, 200, provenanceFor('alignment.json', 'align', 'qwen3-aligner'));
        return true;
      }
      if (name === 'alignment.json') {
        send(res, 200, {
          model: 'qwen3-aligner', revision: 'c7cbfc20', language: entry.body.params.language,
          items_are: "the model's own tokenization, not the caller's words",
          chunks: entry.body.params.chunks.map((c) => (c.index === 3
            ? { index: 3, error: 'could not place' }
            : { index: c.index, items: ITEMS[c.index] })),
        });
        return true;
      }
      return false;
    }
    return false;
  });
}

async function tables() {
  await check('qwen3 maps to qwen3-aligner and is the one backend the app passes', () => {
    assert.deepStrictEqual(align.CRUCIBLE_ALIGNER_BY_BOOKFORGE_BACKEND, { qwen3: 'qwen3-aligner' });
    assert.strictEqual(align.BOOKFORGE_ALIGN_BACKEND, 'qwen3');
    assert.strictEqual(align.crucibleAlignerFor('qwen3'), 'qwen3-aligner');
  });
  await check('whisperx is refused by name: it lost the bake-off and stays a local spawn', () => {
    assert.throws(() => align.crucibleAlignerFor('whisperx'),
      (err) => err.code === 'crucible_aligner_whisperx_local_only' && /bake-off/.test(err.message));
    assert.throws(() => align.crucibleAlignerFor('nemo'), (err) => err.code === 'crucible_aligner_unmapped');
  });
  await check('the spoken reading is narrator\'s: markers stripped, whitespace collapsed', () => {
    assert.strictEqual(align.spokenTextForStoredChunk('[break][heading]Chapter   One.'), 'Chapter One.');
    assert.strictEqual(align.spokenTextForStoredChunk('The road [pause:1.5] turned north.'), 'The road turned north.');
    assert.strictEqual(align.spokenTextForStoredChunk('[BREAK]'), '');
    assert.strictEqual(align.spokenTextForStoredChunk('  a [item] list [/item] row [sfx:door] '), 'a list row');
  });
}

async function sessionRead() {
  const dir = freshSession();
  await check('the session\'s chunks are read from its own record; marker-only and audio-less chunks are skipped and named', () => {
    const { chunks, skipped } = align.sessionAlignChunks(dir);
    assert.deepStrictEqual(chunks.map((c) => [c.index, c.text]), [
      [0, 'Chapter One.'],
      [3, 'The road turned north.'],
    ]);
    assert.strictEqual(chunks[0].audioPath, path.join(dir, 'chapters', 'sentences', '0.flac'));
    assert.deepStrictEqual(skipped, [
      { index: 1, reason: 'no spoken text' },
      { index: 2, reason: 'no audio on disk' },
    ]);
  });
  await check('a subset by index, and an index off the end refused by name', () => {
    const { chunks } = align.sessionAlignChunks(dir, [3]);
    assert.deepStrictEqual(chunks.map((c) => c.index), [3]);
    assert.throws(() => align.sessionAlignChunks(dir, [9]), (err) => err.code === 'crucible_align_index_out_of_range');
  });
  await check('a session with no record is refused by name', () => {
    assert.throws(() => align.sessionAlignChunks(path.join(work, 'nowhere')),
      (err) => err.code === 'crucible_align_session_state_missing');
  });
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const dir = freshSession();
  const { chunks } = align.sessionAlignChunks(dir);
  const cues = [];
  const progress = [];
  let outcome;
  try {
    outcome = await align.runCrucibleAlign({
      server, processDir: dir, language: 'en', backend: 'qwen3', chunks,
      onCue: (c) => cues.push(c), onProgress: (p) => progress.push(p),
    });
  } finally {
    await fake.close();
  }
  await check('one job for the session: every FLAC under <index>.flac, chunks as {index, text}, the model, the language', () => {
    assert.strictEqual(fake.state.infoAsked, 1, 'the server was asked whether it offers align BEFORE the uploads');
    assert.deepStrictEqual(fake.state.uploads.map((u) => u.filename).sort(), ['0.flac', '3.flac']);
    assert.strictEqual(fake.state.uploads.find((u) => u.filename === '3.flac').bytes.toString(), 'fLaC-3');
    assert.strictEqual(fake.state.submitted.length, 1);
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'align');
    assert.strictEqual(body.model, 'qwen3-aligner');
    assert.deepStrictEqual(body.params, {
      language: 'en',
      chunks: [{ index: 0, text: 'Chapter One.' }, { index: 3, text: 'The road turned north.' }],
    });
    assert.deepStrictEqual(Object.keys(body.inputs).sort(), ['0.flac', '3.flac']);
  });
  await check('cue events reach the caller as they land, a failed chunk\'s too', () => {
    assert.deepStrictEqual(cues, [
      { index: 0, items: ITEMS[0] },
      { index: 3, error: '2.1s of audio for 4 word(s): could not place' },
    ]);
    assert.strictEqual(outcome.cues, 2);
  });
  await check('alignment.json and its provenance land in the process directory; done.failed is read strictly', () => {
    assert.strictEqual(outcome.alignmentPath, path.join(dir, 'alignment.json'));
    assert.strictEqual(outcome.alignmentPath, align.crucibleAlignmentPath(dir));
    const doc = JSON.parse(fs.readFileSync(outcome.alignmentPath, 'utf-8'));
    assert.strictEqual(doc.model, 'qwen3-aligner');
    assert.deepStrictEqual(doc.chunks.map((c) => c.index), [0, 3]);
    assert.ok(fs.existsSync(outcome.provenancePath));
    assert.deepStrictEqual(outcome.failed, [3]);
    assert.strictEqual(outcome.chunks, 2);
  });
  await check('the server\'s warming line and its per-chunk progress reach the caller', () => {
    assert.strictEqual(progress[0].stage, 'warming');
    assert.deepStrictEqual(progress.slice(1).map((p) => [p.processed, p.total]), [[1, 2], [2, 2]]);
    assert.strictEqual(progress[progress.length - 1].fraction, 1);
  });
}

async function venueDoor() {
  const config = (dir, over = {}) => ({ processDir: dir, language: 'en', device: 'gpu', ...over });

  {
    /*
     * THERE IS NO LOCAL ALIGNER ARM LEFT. This used to pin the legacy switch
     * reaching `runCoverageAlignLocally`; the switch and the spawn behind it
     * are deleted (docs/LEGACY-REMOVAL.md), and `CoverageAlignDeps` has no
     * `legacyLocal` seam to hand one in through. With nothing enabled the job
     * returns a REFUSAL — it never throws, because the post-render phase's
     * contract is that this one answers — and it takes no card.
     */
    const dir = freshSession();
    const result = await coverage.runCoverageAlign('step-nothing-enabled', config(dir), null, {
      venueHost: noServerHost(),
    });
    await check('with nothing enabled the run fails by name and aligns nothing here', () => {
      assert.strictEqual(result.success, false);
      assert.ok(/nowhere to run/.test(result.error) && /no_enabled_server/.test(result.error), result.error);
      assert.strictEqual(result.venue, undefined);
      assert.ok(!fs.existsSync(path.join(dir, 'coverage.json')), 'nothing aligned locally instead');
    });
    await check('the coverage-align job has no local seam to hand a spawn in through', () => {
      const srcTs = fs.readFileSync(path.join(REPO, 'electron', 'coverage-align-job.ts'), 'utf-8');
      assert.ok(!/legacyLocal/.test(srcTs),
        'a `legacyLocal` dep is a fallback wearing a test seam\'s hat');
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const dir = freshSession();
    let result;
    try {
      result = await coverage.runCoverageAlign('step-crucible', config(dir), null, {
        venueHost: crucibleHost(server),
      });
    } finally {
      await fake.close();
    }
    await check('a routed server runs the Crucible job, lands alignment.json, and HANDS IT TO NARRATOR', () => {
      assert.strictEqual(fake.state.submitted.length, 1, 'the job ran');
      assert.ok(fs.existsSync(path.join(dir, 'alignment.json')), 'the GPU half is on disk (R6)');
      // THE OWED DOOR WAS BUILT (2026-09-18). Until then this returned
      // `narratorDoorOwedMessage` and the book was sealed with an estimated
      // transcript; now the run continues into `narrator align --alignment`,
      // which is `align.ts`'s shape (a). This box has no tools env, so what
      // comes back is NARRATOR'S OWN refusal about the interpreter — and that
      // is the assertion, because it proves the handoff happened rather than
      // the old gap being reworded.
      assert.strictEqual(result.success, false, 'no coverage.json here: this box has no tools env');
      assert.ok(!/narrator has no door/.test(result.error),
        `the owed-door gap is closed, not reworded: ${result.error}`);
      assert.ok(/tools Python environment is not installed/.test(result.error),
        `expected narrator's own refusal, got: ${result.error}`);
      // The card's work is a FILE, so a retry reads it rather than re-aligning.
      assert.strictEqual(result.alignmentPath, path.join(dir, 'alignment.json'));
      assert.deepStrictEqual(result.venue, { where: 'crucible', server, origin: 'decided here', because: 'the top-ranked server' });
      assert.strictEqual(result.busyLine, undefined);
    });
  }
  {
    // THE LIVE FINDING (2026-09-14): a run rendered on `mac` had its alignment
    // decide its own venue and land on `local`. Here the session's record says
    // the render went to one fake; the routing record ranks a DIFFERENT fake
    // first; the alignment must follow the run and never touch the other.
    const mac = await startFake('run');
    const local = await startFake('run');
    const macName = registerFake(mac.url);
    const localName = registerFake(local.url);
    const dir = freshSession(macName);
    let result;
    try {
      result = await coverage.runCoverageAlign('step-follows-run', config(dir), null, {
        venueHost: crucibleHost(localName),
      });
    } finally {
      await mac.close();
      await local.close();
    }
    await check('a run whose render resolved to "mac" aligns on "mac" — never on the top-ranked "local"', () => {
      assert.strictEqual(mac.state.submitted.length, 1, 'the job went where the render went');
      assert.strictEqual(local.state.submitted.length, 0, 'the top-ranked server was never asked');
      assert.strictEqual(local.state.uploads.length, 0);
      assert.deepStrictEqual(result.venue,
        { where: 'crucible', server: macName, origin: 'the run', because: "the run's venue (session_state.json)" });
    });
  }
  {
    // The queue row says one server, the session's record another: refused by
    // name, nothing submitted anywhere.
    const a = await startFake('run');
    const b = await startFake('run');
    const aName = registerFake(a.url);
    const bName = registerFake(b.url);
    const dir = freshSession(aName);
    let result;
    try {
      result = await coverage.runCoverageAlign('step-disagree', config(dir, { runVenue: { where: 'crucible', server: bName } }), null, {
        venueHost: crucibleHost(bName),
      });
    } finally {
      await a.close();
      await b.close();
    }
    await check('a row whose venue disagrees with the session\'s record is refused by name — two answers for one run', () => {
      assert.strictEqual(result.success, false);
      assert.ok(/crucible_align_venue_disagrees/.test(result.error), result.error);
      assert.strictEqual(a.state.submitted.length + b.state.submitted.length, 0);
      assert.strictEqual(result.venue, undefined);
    });
  }
  {
    // A caller naming a server the run did not go to is the same refusal, from the decision.
    const a = await startFake('run');
    const aName = registerFake(a.url);
    const dir = freshSession(aName);
    let result;
    try {
      result = await coverage.runCoverageAlign('step-named-disagree', config(dir, { crucible: { server: 'somewhere-else' } }), null, {
        venueHost: crucibleHost(aName),
      });
    } finally {
      await a.close();
    }
    await check('a caller naming a server the run did not go to is refused by name (run_venue_disagrees)', () => {
      assert.strictEqual(result.success, false);
      assert.ok(/run_venue_disagrees/.test(result.error), result.error);
      assert.strictEqual(a.state.submitted.length, 0);
    });
  }
  {
    // The row carries the run's venue (a narration job's waitForResolved) and the
    // session has no record (rendered before venues were recorded): the row's answer is followed.
    const a = await startFake('run');
    const other = await startFake('run');
    const aName = registerFake(a.url);
    const otherName = registerFake(other.url);
    const dir = freshSession();
    let result;
    try {
      result = await coverage.runCoverageAlign('step-row-venue', config(dir, { runVenue: { where: 'crucible', server: aName } }), null, {
        venueHost: crucibleHost(otherName),
      });
    } finally {
      await a.close();
      await other.close();
    }
    await check('a row carrying the run\'s venue follows it, and the log says it was the run\'s', () => {
      assert.strictEqual(a.state.submitted.length, 1);
      assert.strictEqual(other.state.submitted.length, 0);
      assert.deepStrictEqual(result.venue,
        { where: 'crucible', server: aName, origin: 'the run', because: "the run's venue (the queue row)" });
    });
  }
  {
    /*
     * A ROW WHOSE RUN THE DELETED NARRATOR RENDERED IS REFUSED, NOT RE-ROUTED.
     * It used to align locally without re-deciding. That run-venue shape no
     * longer exists in the type, and the row's own string is turned away one
     * level up by `runVenueOfRow` — re-deciding would send the alignment of a
     * book rendered here to somebody else's card, with no record on either side
     * of where the audio actually came from (PHASE7-LANES §4.3).
     */
    const stepVenue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'step-venue.js'));
    const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
    await check('a run the deleted narrator rendered is refused by name, never aligned here', () => {
      assert.throws(
        () => stepVenue.runVenueOfRow(waitFor.RETIRED_LOCAL_NARRATOR_VENUE),
        (err) => err.code === 'legacy_venue_retired',
      );
    });
  }
  {
    // The Mac: the run went there, and `align` is off there. Refused BEFORE any
    // upload, and the refusal says the proportional transcript ships.
    const mac = await startFake('no-align');
    const macName = registerFake(mac.url);
    const dir = freshSession(macName);
    let result;
    try {
      result = await coverage.runCoverageAlign('step-mac', config(dir), null, { venueHost: crucibleHost(macName) });
    } finally {
      await mac.close();
    }
    await check('a Mac-bound run\'s alignment is refused by name before any upload, and reads as "the proportional transcript ships"', () => {
      assert.strictEqual(result.success, false);
      assert.strictEqual(mac.state.infoAsked, 1);
      assert.strictEqual(mac.state.uploads.length, 0, 'nothing crossed the wire');
      assert.strictEqual(mac.state.submitted.length, 0);
      assert.ok(/crucible_align_not_offered/.test(result.error), result.error);
      assert.ok(/does not offer align/.test(result.error), result.error);
      assert.ok(/proportional sentence transcript/.test(result.error), 'says what the book carries instead');
      assert.ok(/rendered audio is intact/.test(result.error));
      assert.ok(!fs.existsSync(path.join(dir, 'alignment.json')));
      assert.deepStrictEqual(result.venue,
        { where: 'crucible', server: macName, origin: 'the run', because: "the run's venue (session_state.json)" });
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const dir = freshSession();
    let result;
    try {
      result = await coverage.runCoverageAlign('step-cpu', config(dir, { device: 'cpu' }), null, {
        venueHost: crucibleHost(server),
      });
    } finally {
      await fake.close();
    }
    await check('a CPU row has no Crucible answer and is refused by name, nothing uploaded', () => {
      assert.strictEqual(result.success, false);
      assert.ok(/crucible_align_cpu_row/.test(result.error), result.error);
      assert.strictEqual(fake.state.uploads.length, 0);
      assert.strictEqual(result.venue.where, 'crucible');
    });
  }
  {
    const fake = await startFake('busy');
    const server = registerFake(fake.url);
    const dir = freshSession();
    let result;
    try {
      result = await coverage.runCoverageAlign('step-busy', config(dir), null, { venueHost: crucibleHost(server) });
    } finally {
      await fake.close();
    }
    await check('server_busy carries the holder\'s line for the queue to hold the row on — a wait, not a failure', () => {
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.busyLine, 'busy: foundry, llm qwen3.5-9b, 30% done');
      assert.ok(/server_busy/.test(result.error));
      assert.ok(!fs.existsSync(path.join(dir, 'alignment.json')));
    });
  }
  {
    const fake = await startFake('run');
    const named = registerFake(fake.url);
    const dir = freshSession();
    let result;
    try {
      result = await coverage.runCoverageAlign('step-named', config(dir, { crucible: { server: named } }), null, {
        // NOTHING ENABLED: the record would refuse, so this proves the caller's
        // own instruction is answered before the record is ever read.
        venueHost: noServerHost(),
      });
    } finally {
      await fake.close();
    }
    await check('the caller\'s own server name is answered before the record is read at all', () => {
      assert.deepStrictEqual(result.venue, { where: 'crucible', server: named, origin: 'decided here', because: 'the caller named it' });
      assert.strictEqual(fake.state.submitted.length, 1);
    });
  }
}

(async () => {
  await tables();
  await sessionRead();
  await happyPath();
  await venueDoor();
  summary('test-crucible-align');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
