#!/usr/bin/env node
/**
 * "GENERATE SENTENCES" ON SOMEBODY ELSE'S CARD, AND THE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-asr.js
 *
 * `electron/crucible/asr.ts` sends an audiobook to a Crucible `asr` job and
 * writes the SAME WebVTT the local `transcribe_audiobook.py` writes, at the
 * same path, so the embed and the binding behind it cannot tell which machine
 * transcribed the book. Against a FAKE Crucible, this pins:
 *
 *  1. The model id table: every BookForge whisper size names its Crucible
 *     manifest, and an unmapped size is refused by name — there is no default
 *     model on either side.
 *  2. The language sentinels a media tag carries (`und`, `unknown`, …) become
 *     the VALUE `auto`; a real code is sent as given.
 *  3. The cue grouping is the local script's, rule for rule: a cue ends at
 *     sentence-final punctuation or 240 characters, a word-less segment is one
 *     cue, boundary duplicates are dropped, timestamps are `HH:MM:SS.mmm`.
 *  4. The m4b goes up under its own basename (the extension is what ffmpeg
 *     reads the container from), the params are exactly the three required
 *     ones, and the VTT lands at the given path with the grouped cues.
 *  5. The server's stages (`warming`, `decoding` with a moving position,
 *     `transcribing` with the fraction) reach the caller.
 *  6. Refusals by name, before the upload where the server can be asked: a
 *     server with no `asr`, a model it does not offer, `server_busy` with the
 *     holder's line — and NO local transcription in any of them.
 *  7. The venue door: the legacy switch routes to the local spawn and says so;
 *     a routed server routes to the Crucible.
 *
 * No GPU, no whisper, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  crucibleHost, legacyHost,
} = require('./fake-crucible');

const ASR = path.join(REPO, 'dist', 'electron', 'crucible', 'asr.js');
if (!fs.existsSync(ASR)) {
  console.log('SKIP: dist/electron/crucible/asr.js is not built — run npx tsc -p tsconfig.electron.json');
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-asr-');
const asr = require(ASR);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/** A transcript the fake serves: two sentences in one word-timed segment, a word-less one, a boundary duplicate. */
const TRANSCRIPT = {
  model: 'faster-whisper-large-v3',
  revision: 'edaa852ec7e1',
  hf_repo: 'Systran/faster-whisper-large-v3',
  language: 'en',
  language_probability: 0.99,
  language_requested: 'auto',
  vad_filter: true,
  word_timestamps: true,
  duration_s: 12.5,
  window_s: 900,
  overlap_s: 15,
  windows: 1,
  segments: [
    {
      start: 0.2, end: 4.1, text: ' He walked. Then he stopped!',
      words: [
        { start: 0.2, end: 0.5, word: ' He', probability: 0.9 },
        { start: 0.5, end: 1.1, word: ' walked.', probability: 0.9 },
        { start: 1.4, end: 1.8, word: ' Then', probability: 0.9 },
        { start: 1.8, end: 2.0, word: ' he', probability: 0.9 },
        { start: 2.0, end: 4.1, word: ' stopped!', probability: 0.9 },
      ],
    },
    // No words: one cue of its own text.
    { start: 4.5, end: 6.0, text: '  A   lone segment.  ' },
    // Begins inside the previous cue's span: the boundary duplicate. (Ends in
    // punctuation, because the grouper carries an UNPUNCTUATED cue across
    // segments — that is the local script's rule, mirrored, not a segment edge.)
    { start: 5.0, end: 6.2, text: 'A lone segment.', words: [{ start: 5.0, end: 6.2, word: 'A lone segment.', probability: 0.5 }] },
    // Past the tolerance: kept.
    { start: 6.0, end: 12.5, text: 'By evening.', words: [{ start: 6.0, end: 12.5, word: 'By evening.', probability: 0.5 }] },
  ],
};

/**
 * The fake asr server. `behaviour`:
 *   'run'       info offers asr with large-v3; the job runs to done with transcript.json
 *   'no-asr'    info offers no asr capability
 *   'no-model'  info offers asr with only faster-whisper-base
 *   'busy'      the submit is 409 server_busy
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      state.infoAsked = (state.infoAsked || 0) + 1;
      const asrRows = behaviour === 'no-model'
        ? [{ id: 'faster-whisper-base', revision: 'ebe41f70', source: 'Systran/faster-whisper-base', resident: false, vram_bytes: 1 }]
        : [{ id: 'faster-whisper-large-v3', revision: 'edaa852e', source: 'Systran/faster-whisper-large-v3', resident: false, vram_bytes: 1 }];
      const capabilities = behaviour === 'no-asr'
        ? [{ job_type: 'echo', models: [] }]
        : [{ job_type: 'echo', models: [] }, { job_type: 'asr', models: asrRows }];
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux', gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 1 } },
        job_types: ['echo', 'asr'],
        capabilities,
      });
      return true;
    }

    if (route === '/v1/jobs' && req.method === 'POST') {
      const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
      state.submitted.push(body);
      if (behaviour === 'busy') {
        send(res, 409, { error: { code: 'server_busy', message: 'one at a time', details: {
          holder: 'bookforge/mac', job_id: 'j-held', type: 'align', model: 'qwen3-aligner', status: 'running',
          since: '2026-09-14T01:00:00Z', progress: 0.1, message: 'aligned 140 of 1400 chunk(s)',
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
      sse.frame('warming', { message: '12s of audio decoded, 1 window(s) of 900s to transcribe on cuda at float16' });
      sse.frame('progress', { fraction: 0, message: 'decoding book.m4b', stage: 'decoding', processed_s: 0, total_s: 0 });
      sse.frame('progress', { fraction: 0, message: 'decoding 6s of 12s, 0 segments', stage: 'decoding', processed_s: 6, total_s: 12.5 });
      sse.frame('progress', { fraction: 0.48, message: 'transcribing 6s of 12s, 2 segments', stage: 'transcribing', processed_s: 6, total_s: 12.5, cues: 2 });
      sse.frame('artifact', { name: 'transcript.json' });
      sse.frame('progress', { fraction: 1, message: '4 segments over 12s of audio', stage: 'transcribing', processed_s: 12.5, total_s: 12.5, cues: 4 });
      sse.frame('done', { artifacts: ['transcript.json'] });
      sse.end();
      return true;
    }

    const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/(.+)$/.exec(route);
    if (artifact && req.method === 'GET') {
      const name = decodeURIComponent(artifact[2]);
      if (name === 'transcript.json.provenance.json') {
        send(res, 200, provenanceFor('transcript.json', 'asr', 'faster-whisper-large-v3'));
        return true;
      }
      if (name === 'transcript.json') {
        send(res, 200, TRANSCRIPT);
        return true;
      }
      return false;
    }
    return false;
  });
}

function freshAudio(name) {
  const dir = path.join(work, `book-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.from('fake-m4b-bytes'));
  return file;
}

async function tables() {
  await check('every BookForge whisper size maps to its Crucible manifest id', () => {
    assert.deepStrictEqual(asr.CRUCIBLE_ASR_MODEL_BY_WHISPER_MODEL, {
      'tiny': 'faster-whisper-tiny',
      'base': 'faster-whisper-base',
      'small': 'faster-whisper-small',
      'medium': 'faster-whisper-medium',
      'large-v3': 'faster-whisper-large-v3',
      'distil-large-v3': 'faster-whisper-distil-large-v3',
    });
    assert.strictEqual(asr.crucibleAsrModelFor('large-v3'), 'faster-whisper-large-v3');
    assert.strictEqual(asr.crucibleAsrModelFor('distil-large-v3'), 'faster-whisper-distil-large-v3');
  });
  await check('an unmapped size is refused by name — no default model on either side', () => {
    assert.throws(() => asr.crucibleAsrModelFor('large-v2'), (err) => err.code === 'crucible_asr_model_unmapped');
    assert.throws(() => asr.crucibleAsrModelFor(''), (err) => err.code === 'crucible_asr_model_not_named');
  });
  await check('the media-tag sentinels become the value `auto`; a real code is sent as given', () => {
    for (const raw of [undefined, '', 'auto', 'und', 'UND', 'undetermined', 'unknown', 'mul']) {
      assert.strictEqual(asr.crucibleAsrLanguage(raw), 'auto', `${JSON.stringify(raw)} → auto`);
    }
    assert.strictEqual(asr.crucibleAsrLanguage('en'), 'en');
    assert.strictEqual(asr.crucibleAsrLanguage('DE'), 'de');
  });
}

async function grouping() {
  await check('the cue grouping is the local script\'s: punctuation ends a cue, a word-less segment is one, duplicates drop', () => {
    const { vtt, cues } = asr.transcriptToVtt(TRANSCRIPT);
    assert.strictEqual(cues, 4);
    assert.strictEqual(vtt, [
      'WEBVTT',
      '',
      '00:00:00.200 --> 00:00:01.100',
      'He walked.',
      '',
      '00:00:01.400 --> 00:00:04.100',
      'Then he stopped!',
      '',
      '00:00:04.500 --> 00:00:06.000',
      'A lone segment.',
      '',
      '00:00:06.000 --> 00:00:12.500',
      'By evening.',
      '',
    ].join('\n'));
  });
  await check('an unpunctuated cue carries across segments within a window — the local script\'s rule', () => {
    const cues = asr.groupTranscriptCues([
      { start: 0, end: 1, text: 'He', words: [{ start: 0, end: 1, word: 'He' }] },
      { start: 1, end: 2, text: 'walked.', words: [{ start: 1, end: 2, word: ' walked.' }] },
    ]);
    assert.deepStrictEqual(cues, [{ start: 0, end: 2, text: 'He walked.' }]);
  });
  await check('a cue that never meets punctuation is flushed at 240 characters', () => {
    const words = Array.from({ length: 60 }, (_, i) => ({ start: i, end: i + 0.5, word: ' abcde' }));
    const cues = asr.groupTranscriptCues([{ start: 0, end: 60, text: 'x', words }]);
    assert.strictEqual(cues.length, 2, '60 × 6 chars = 360 → one flush at 240, one tail');
    assert.strictEqual(cues[0].text.split(' ').length, 40);
  });
  await check('timestamps are HH:MM:SS.mmm with the 999.5 ms carry', () => {
    assert.strictEqual(asr.vttTimestamp(3661.0005), '01:01:01.001');
    assert.strictEqual(asr.vttTimestamp(59.9996), '00:01:00.000', 'carries into the minute (the local script would print 60.000)');
    assert.strictEqual(asr.vttTimestamp(-1), '00:00:00.000');
  });
  await check('a transcript missing a field is refused by name, never patched', () => {
    assert.throws(() => asr.transcriptToVtt({ ...TRANSCRIPT, segments: [{ start: 1, text: 'no end' }] }),
      (err) => err.code === 'crucible_asr_transcript_unreadable' && /segments\[0\]\.end/.test(err.message));
    assert.throws(() => asr.transcriptToVtt({ ...TRANSCRIPT, segments: [] }),
      (err) => err.code === 'crucible_asr_no_text');
  });
}

async function happyPath() {
  const fake = await startFake('run');
  const server = registerFake(fake.url);
  const audio = freshAudio('The Mutineer.m4b');
  const outVtt = path.join(path.dirname(audio), 'out.vtt');
  const progress = [];
  const log = [];
  let outcome;
  try {
    outcome = await asr.runCrucibleAsr({
      server, audioPath: audio, whisperModelId: 'large-v3', language: 'und', outVttPath: outVtt,
      onProgress: (p) => progress.push(p), onLog: (l) => log.push(l),
    });
  } finally {
    await fake.close();
  }
  await check('the m4b goes up under its own basename and the params are exactly the three required ones', () => {
    assert.strictEqual(fake.state.uploads.length, 1);
    assert.strictEqual(fake.state.uploads[0].filename, 'The Mutineer.m4b', 'the extension is what ffmpeg reads');
    assert.strictEqual(fake.state.uploads[0].bytes.toString(), 'fake-m4b-bytes');
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'asr');
    assert.strictEqual(body.model, 'faster-whisper-large-v3');
    assert.deepStrictEqual(body.params, { language: 'auto', vad_filter: true, word_timestamps: true });
    assert.deepStrictEqual(Object.keys(body.inputs), ['The Mutineer.m4b']);
  });
  await check('the server was asked whether it offers the model BEFORE the upload', () => {
    assert.strictEqual(fake.state.infoAsked, 1);
  });
  await check('the VTT lands at the local path with the grouped cues, and the scratch is gone', () => {
    assert.ok(fs.existsSync(outVtt));
    const text = fs.readFileSync(outVtt, 'utf-8');
    assert.ok(text.startsWith('WEBVTT\n\n00:00:00.200 --> 00:00:01.100\nHe walked.\n'), text.slice(0, 80));
    assert.strictEqual(outcome.cues, 4);
    assert.strictEqual(outcome.model, 'faster-whisper-large-v3');
    assert.strictEqual(outcome.language, 'en');
    assert.strictEqual(outcome.durationSec, 12.5);
    assert.ok(!fs.existsSync(`${outVtt}.${process.pid}.part`), 'no temp file left beside the VTT');
    assert.ok(!fs.readdirSync(require('os').tmpdir()).some((n) => n.startsWith('bookforge-crucible-asr-') && (() => {
      try { return fs.readdirSync(path.join(require('os').tmpdir(), n)).includes('transcript.json'); } catch { return false; }
    })()), 'the scratch directory holding transcript.json was not removed');
  });
  await check('the server\'s stages reach the caller: warming, a moving decode position, then the fraction', () => {
    assert.deepStrictEqual(progress.map((p) => p.stage), ['warming', 'decoding', 'decoding', 'transcribing', 'transcribing']);
    assert.strictEqual(progress[2].processedSec, 6);
    assert.strictEqual(progress[2].totalSec, 12.5);
    assert.strictEqual(progress[2].fraction, 0, 'the decode drives no fraction');
    assert.strictEqual(progress[3].fraction, 0.48);
    assert.strictEqual(progress[3].cues, 2);
  });
  await check('the provenance (server, model fingerprint) is on the job log', () => {
    assert.ok(log.some((l) => /faster-whisper-large-v3@abc1234/.test(l) && /fake-crucible 0\.5\.0/.test(l)), log.join('\n'));
  });
}

async function refusals() {
  for (const [behaviour, code, uploads] of [
    ['no-asr', 'crucible_asr_not_offered', 0],
    ['no-model', 'crucible_asr_model_not_offered', 0],
    ['busy', 'server_busy', 1],
  ]) {
    const fake = await startFake(behaviour);
    const server = registerFake(fake.url);
    const audio = freshAudio('book.m4b');
    const outVtt = path.join(path.dirname(audio), 'out.vtt');
    let caught = null;
    try {
      await asr.runCrucibleAsr({ server, audioPath: audio, whisperModelId: 'large-v3', language: 'en', outVttPath: outVtt });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code}, with ${uploads} upload(s) made and no VTT written`, () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, code);
      assert.strictEqual(fake.state.uploads.length, uploads);
      assert.ok(!fs.existsSync(outVtt), 'nothing transcribed locally instead');
      if (behaviour === 'busy') {
        assert.strictEqual(caught.busyLine, 'busy: bookforge/mac, align qwen3-aligner, 10% done — aligned 140 of 1400 chunk(s)');
      }
      if (behaviour === 'no-model') assert.ok(/faster-whisper-base/.test(caught.message), 'names what it does offer');
    });
  }
}

async function venueDoor() {
  {
    let localCalls = 0;
    const log = [];
    const outcome = await asr.transcribeAtVenue({
      host: legacyHost(),
      audioPath: freshAudio('book.m4b'), whisperModelId: 'large-v3', outVttPath: path.join(work, 'never.vtt'),
      legacyLocal: async () => { localCalls += 1; return { cues: 7 }; },
      onLog: (l) => log.push(l),
    });
    await check('the legacy switch routes to the local spawn and says so', () => {
      assert.strictEqual(localCalls, 1);
      assert.strictEqual(outcome.venue.where, 'legacy-local-narrator');
      assert.strictEqual(outcome.venue.origin, 'decided here');
      assert.strictEqual(outcome.cues, 7);
      assert.strictEqual(outcome.crucible, undefined);
      assert.ok(log.some((l) => /local whisper spawn/.test(l) && /decided here/.test(l) && /legacy/.test(l)), log.join('\n'));
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const audio = freshAudio('book.m4b');
    const outVtt = path.join(path.dirname(audio), 'out.vtt');
    let localCalls = 0;
    let outcome;
    try {
      outcome = await asr.transcribeAtVenue({
        host: crucibleHost(server),
        audioPath: audio, whisperModelId: 'large-v3', language: 'en', outVttPath: outVtt,
        legacyLocal: async () => { localCalls += 1; return { cues: 0 }; },
      });
    } finally {
      await fake.close();
    }
    await check('a routed server routes to the Crucible, never the local spawn, and records the venue', () => {
      assert.strictEqual(localCalls, 0);
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server, origin: 'decided here', because: 'the top-ranked server' });
      assert.strictEqual(outcome.crucible.jobId, 'job-1');
      assert.ok(fs.existsSync(outVtt));
    });
  }
  {
    const fake = await startFake('run');
    const named = registerFake(fake.url);
    const audio = freshAudio('book.m4b');
    let outcome;
    try {
      outcome = await asr.transcribeAtVenue({
        crucible: { server: named },
        host: legacyHost(),   // would go local if the caller's name did not win
        audioPath: audio, whisperModelId: 'large-v3', language: 'en', outVttPath: path.join(path.dirname(audio), 'o.vtt'),
        legacyLocal: async () => { throw new Error('the caller named a server; local must not run'); },
      });
    } finally {
      await fake.close();
    }
    await check('the caller\'s own server name wins over the legacy switch when the run has no venue yet', () => {
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server: named, origin: 'decided here', because: 'the caller named it' });
    });
  }
  {
    // THE RUN'S VENUE WINS OVER THE ROUTING RECORD: the row was admitted to one
    // server; the record now ranks another first; the transcription follows the row.
    const mine = await startFake('run');
    const other = await startFake('run');
    const mineName = registerFake(mine.url);
    const otherName = registerFake(other.url);
    const audio = freshAudio('book.m4b');
    const log = [];
    let outcome;
    try {
      outcome = await asr.transcribeAtVenue({
        runVenue: { where: 'crucible', server: mineName }, runVenueSource: 'the queue row',
        host: crucibleHost(otherName),
        audioPath: audio, whisperModelId: 'large-v3', language: 'en', outVttPath: path.join(path.dirname(audio), 'o.vtt'),
        legacyLocal: async () => { throw new Error('must not run locally'); },
        onLog: (l) => log.push(l),
      });
    } finally {
      await mine.close();
      await other.close();
    }
    await check('a run already resolved to one server never transcribes on the top-ranked other, and the log says it was the run\'s', () => {
      assert.strictEqual(mine.state.submitted.length, 1);
      assert.strictEqual(other.state.submitted.length, 0);
      assert.deepStrictEqual(outcome.venue,
        { where: 'crucible', server: mineName, origin: 'the run', because: "the run's venue (the queue row)" });
      assert.ok(log.some((l) => /the run: the run's venue \(the queue row\)/.test(l)), log.join('\n'));
    });
  }
  {
    let localCalls = 0;
    const outcome = await asr.transcribeAtVenue({
      runVenue: { where: 'legacy-local-narrator' }, runVenueSource: 'the queue row',
      host: crucibleHost('never-asked'),
      audioPath: freshAudio('book.m4b'), whisperModelId: 'large-v3', outVttPath: path.join(work, 'never.vtt'),
      legacyLocal: async () => { localCalls += 1; return { cues: 1 }; },
    });
    await check('a run the legacy narrator rendered transcribes locally without re-deciding', () => {
      assert.strictEqual(localCalls, 1);
      assert.strictEqual(outcome.venue.origin, 'the run');
    });
    await assert.rejects(
      asr.transcribeAtVenue({
        runVenue: { where: 'crucible', server: 'mac' }, crucible: { server: 'local' },
        host: crucibleHost('local'),
        audioPath: freshAudio('book.m4b'), whisperModelId: 'large-v3', outVttPath: path.join(work, 'never2.vtt'),
        legacyLocal: async () => { throw new Error('no'); },
      }),
      (err) => err.code === 'run_venue_disagrees',
    );
    await check('a caller naming a server the run did not go to is refused by name', () => {});
  }
}

(async () => {
  await tables();
  await grouping();
  await happyPath();
  await refusals();
  await venueDoor();
  summary('test-crucible-asr');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
