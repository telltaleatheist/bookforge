#!/usr/bin/env node
/**
 * "GENERATE SENTENCES" ON SOMEBODY ELSE'S CARD, AND THE WAYS IT GOES WRONG SILENTLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-asr.js
 *
 * `electron/crucible/asr.ts` sends an audiobook to a Crucible `asr` job and
 * writes the WebVTT the bridge embeds, at the path it embeds from. Against a
 * FAKE Crucible, this pins:
 *
 *  1. ONE model, Qwen3-ASR-1.7B — the same id the epub-align path uses — and
 *     the whisper size table it replaced is gone (no Crucible shipped those
 *     manifests, so every Whisper-method row was refused; REORG B2).
 *  2. Qwen is always told the language: the not-known values a media tag
 *     carries (`und`, `unknown`, …) are English, a region tag is dropped, and
 *     the params are Qwen's (no VAD, `speech_only: false`, word timestamps).
 *  3. The cue grouping is the deleted local script's, rule for rule: a cue ends at
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
 *  7. The venue door: a routed server routes to the Crucible, and with NOTHING
 *     ENABLED the door refuses `no_enabled_server` by name. There is no local
 *     whisper spawn to fall back to any more (docs/LEGACY-REMOVAL.md).
 *
 * No GPU, no whisper, no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, provenanceFor,
  crucibleHost, noServerHost,
  ENGINE_INFO_FIELDS,
} = require('./fake-crucible');
const { skipLine } = require('./keeper-skip.js');

const ASR = path.join(REPO, 'dist', 'electron', 'crucible', 'asr.js');
if (!fs.existsSync(ASR)) {
  console.log(skipLine('dist/electron/crucible/asr.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}
const { work } = installElectronStub('bf-crucible-asr-');
const asr = require(ASR);
const job = require(path.join(REPO, 'dist', 'electron', 'crucible', 'job.js'));
const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
const registerFake = fakeNamer(servers);
const { check, summary } = makeChecker();

/**
 * WHAT THE FAKE SERVES: a real Qwen3-ASR response, captured from a real server. A
 * hand-written fake that used Whisper's word shape is how unspaced cues reached main.
 */
const QWEN_RESPONSE = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'fixtures', 'qwen3-asr-transcript.json'), 'utf-8'));

/** The cue RULES' fixture: two sentences in one word-timed segment, a word-less one, a boundary duplicate. Words carry their own spaces, which is the path `wordsAsPrinted` passes through. */
const TRANSCRIPT = {
  model: 'qwen3-asr-1.7b',
  revision: 'edaa852ec7e1',
  hf_repo: 'Qwen/Qwen3-ASR-1.7B',
  language: 'en',
  language_probability: 1.0,
  language_requested: 'en',
  vad_filter: false,
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
 *   'no-model'  info offers asr with only whisper-large-v3-turbo
 *   'busy'      the submit is 409 server_busy
 */
function startFake(behaviour) {
  return startFakeCrucible(async (req, res, ctx) => {
    const { state, send, sseWriter, url } = ctx;
    const route = url.pathname;

    if (route === '/v1/info' && req.method === 'GET') {
      state.infoAsked = (state.infoAsked || 0) + 1;
      const asrRows = behaviour === 'no-model'
        ? [{ id: 'whisper-large-v3-turbo', revision: 'ebe41f70', source: 'openai/whisper-large-v3-turbo', resident: false, vram_bytes: 1 }]
        : [{ id: 'qwen3-asr-1.7b', revision: 'edaa852e', source: 'Qwen/Qwen3-ASR-1.7B', resident: false, vram_bytes: 1 }];
      const capabilities = behaviour === 'no-asr'
        ? [{ job_type: 'echo', models: [] }]
        : [{ job_type: 'echo', models: [] }, { job_type: 'asr', models: asrRows }];
      send(res, 200, {
        server: { name: 'fake-crucible', version: '0.5.0', api_version: 1 },
        host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux', gpu: { vendor: 'nvidia', name: 'fake', vram_bytes: 1 } },
        ...ENGINE_INFO_FIELDS,
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
      sse.frame('started', { waited_s: 0 });
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
        send(res, 200, provenanceFor('transcript.json', 'asr', 'qwen3-asr-1.7b'));
        return true;
      }
      if (name === 'transcript.json') {
        send(res, 200, QWEN_RESPONSE);
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
  await check('ONE model: Qwen3-ASR-1.7B, the one the epub-align path transcribes with', () => {
    assert.strictEqual(asr.CRUCIBLE_ASR_MODEL, 'qwen3-asr-1.7b');
    const align = require(path.join(REPO, 'dist', 'electron', 'crucible', 'sentence-align.js'));
    assert.strictEqual(align.SENTENCE_ASR_MODEL, asr.CRUCIBLE_ASR_MODEL, 'two names for one model');
    assert.strictEqual(asr.CRUCIBLE_ASR_MODEL_BY_WHISPER_MODEL, undefined, 'the whisper size table is back');
    assert.strictEqual(asr.crucibleAsrModelFor, undefined, 'the whisper size mapping is back');
  });
  await check('Qwen is always TOLD the language: the not-known values are English, a region tag is dropped', () => {
    // Crucible refuses `auto` for Qwen by name (language_unsupported_by_engine);
    // English for an untagged book is the epub-align path's own rule.
    for (const raw of [undefined, '', 'auto', 'und', 'UND', 'undetermined', 'unknown', 'mul']) {
      assert.strictEqual(asr.crucibleAsrLanguage(raw), 'en', `${JSON.stringify(raw)} → en`);
    }
    assert.strictEqual(asr.crucibleAsrLanguage('en'), 'en');
    assert.strictEqual(asr.crucibleAsrLanguage('DE'), 'de');
    assert.strictEqual(asr.crucibleAsrLanguage('en-US'), 'en');
    assert.strictEqual(asr.crucibleAsrLanguage('pt_BR'), 'pt');
  });
  await check('the params are the ones Qwen accepts: no VAD, speech_only said out loud, word timestamps', () => {
    assert.deepStrictEqual(asr.crucibleAsrParams('und'),
      { language: 'en', vad_filter: false, speech_only: false, word_timestamps: true });
  });
}

async function grouping() {
  await check('decode_loop spans are read (Crucible 1.0.58), and a transcript without them reads as none', () => {
    const looped = asr.readCrucibleTranscript({ ...TRANSCRIPT,
      decode_loop: [{ start: 17395.2, end: 17397.1, reason: 'repetition', signal: 'x', detail: 'y' }] });
    assert.deepStrictEqual(looped.decodeLoops, [{ start: 17395.2, end: 17397.1, reason: 'repetition' }]);
    assert.deepStrictEqual(asr.readCrucibleTranscript(TRANSCRIPT).decodeLoops, []);
    assert.throws(() => asr.readCrucibleTranscript({ ...TRANSCRIPT, decode_loop: [{ start: 'x', end: 2 }] }),
      /decode_loop\[0\]\.start is not a number/);
  });
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
  await check("QWEN'S REAL RESPONSE: bare words take their spaces and punctuation from the segment text", () => {
    const segment = QWEN_RESPONSE.segments[0];
    assert.ok(segment.words.every((w) => /^[\p{L}\p{N}]+$/u.test(w.word) && w.probability === null),
      'the captured fixture must stay in the shape the server really sends');
    const { cues, vtt } = asr.transcriptToVtt(QWEN_RESPONSE);
    assert.strictEqual(cues, 2);
    assert.ok(vtt.includes('\nHistory can familiarize, and it can mourn.\n'), vtt);
    const flat = (t) => t.replace(/\s+/g, ' ').trim();
    const text = asr.groupTranscriptCues(QWEN_RESPONSE.segments).map((c) => c.text).join(' ');
    assert.strictEqual(flat(text), flat(segment.text), 'every printed character survives');
  });
  await check('printed text is never lost: a token the text lacks, and text no token covers', () => {
    const lost = asr.wordsAsPrinted({ start: 0, end: 3, text: 'One two three.',
      words: [{ start: 0, end: 1, word: 'One' }, { start: 1, end: 2, word: 'three' }] });
    assert.strictEqual(lost.map((w) => w.word).join(''), 'One two three.');
    const extra = asr.wordsAsPrinted({ start: 0, end: 2, text: 'One.',
      words: [{ start: 0, end: 1, word: 'One' }, { start: 1, end: 2, word: 'zzz' }] });
    assert.strictEqual(extra.map((w) => w.word).join(''), 'One. zzz');
  });
  await check('words that already carry their spaces (Whisper) pass through untouched', () => {
    const words = [{ start: 0, end: 1, word: ' Hello,' }, { start: 1, end: 2, word: ' there.' }];
    assert.strictEqual(asr.wordsAsPrinted({ start: 0, end: 2, text: 'Hello, there.', words }), words);
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
      server, audioPath: audio, language: 'und', outVttPath: outVtt,
      onProgress: (p) => progress.push(p), onLog: (l) => log.push(l),
    });
  } finally {
    await fake.close();
  }
  await check('the m4b goes up under its own basename and the params are exactly Qwen\'s four', () => {
    assert.strictEqual(fake.state.uploads.length, 1);
    assert.strictEqual(fake.state.uploads[0].filename, 'The Mutineer.m4b', 'the extension is what ffmpeg reads');
    assert.strictEqual(fake.state.uploads[0].bytes.toString(), 'fake-m4b-bytes');
    const body = fake.state.submitted[0];
    assert.strictEqual(body.type, 'asr');
    assert.strictEqual(body.model, 'qwen3-asr-1.7b');
    assert.deepStrictEqual(body.params, { language: 'en', vad_filter: false, speech_only: false, word_timestamps: true });
    assert.deepStrictEqual(Object.keys(body.inputs), ['The Mutineer.m4b']);
  });
  await check('the server was asked whether it offers the model BEFORE the upload', () => {
    assert.strictEqual(fake.state.infoAsked, 1);
  });
  await check('the VTT lands at the local path with the grouped cues, and the scratch is gone', () => {
    assert.ok(fs.existsSync(outVtt));
    const text = fs.readFileSync(outVtt, 'utf-8');
    assert.ok(text.startsWith('WEBVTT\n\n00:00:00.880 --> '), text.slice(0, 80));
    assert.ok(text.includes('And after the end of communism in 1989, many of the democracies'), text.slice(0, 200));
    assert.strictEqual(outcome.cues, 2);
    assert.strictEqual(outcome.model, 'qwen3-asr-1.7b');
    assert.strictEqual(outcome.language, 'en');
    assert.strictEqual(outcome.durationSec, QWEN_RESPONSE.duration_s);
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
    assert.ok(log.some((l) => /qwen3-asr-1\.7b@abc1234/.test(l) && /fake-crucible 0\.5\.0/.test(l)), log.join('\n'));
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
      await asr.runCrucibleAsr({ server, audioPath: audio, language: 'en', outVttPath: outVtt });
    } catch (err) { caught = err; } finally { await fake.close(); }
    await check(`${behaviour}: refused by name as ${code}, with ${uploads} upload(s) made and no VTT written`, () => {
      assert.ok(caught instanceof job.CrucibleJobRefused, `got ${caught}`);
      assert.strictEqual(caught.code, code);
      assert.strictEqual(fake.state.uploads.length, uploads);
      assert.ok(!fs.existsSync(outVtt), 'nothing transcribed locally instead');
      if (behaviour === 'busy') {
        assert.strictEqual(caught.busyLine, 'busy: bookforge/mac, align qwen3-aligner, 10% done — aligned 140 of 1400 chunk(s)');
      }
      if (behaviour === 'no-model') assert.ok(/whisper-large-v3-turbo/.test(caught.message), 'names what it does offer');
    });
  }
}

async function venueDoor() {
  {
    /*
     * THERE IS NO LOCAL ARM LEFT. This check used to pin the opposite — the
     * legacy switch reaching the local whisper script here — and that switch
     * and the spawn behind it are deleted (docs/LEGACY-REMOVAL.md). What must
     * be true now is the thing the old arm hid: with nothing to place the work
     * on, the door REFUSES BY NAME and touches no card, rather than quietly
     * transcribing a whole audiobook on whatever machine happened to run it.
     */
    const outVtt = path.join(work, 'never.vtt');
    let caught = null;
    try {
      await asr.transcribeAtVenue({
        host: noServerHost(),
        audioPath: freshAudio('book.m4b'), outVttPath: outVtt,
      });
    } catch (err) { caught = err; }
    await check('with nothing enabled the door refuses by name and transcribes nothing here', () => {
      assert.ok(caught !== null, 'it must not have quietly succeeded');
      assert.strictEqual(caught.code, 'no_enabled_server', caught.message);
      assert.ok(!fs.existsSync(outVtt), 'nothing transcribed locally instead');
    });
    await check('the asr door takes no local callback at all', () => {
      const src = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'asr.ts'), 'utf-8');
      assert.ok(!/legacyLocal/.test(src),
        'a `legacyLocal` option is a fallback wearing an option\'s hat');
    });
  }
  {
    const fake = await startFake('run');
    const server = registerFake(fake.url);
    const audio = freshAudio('book.m4b');
    const outVtt = path.join(path.dirname(audio), 'out.vtt');
    const localCalls = 0;
    let outcome;
    try {
      outcome = await asr.transcribeAtVenue({
        host: crucibleHost(server),
        audioPath: audio, language: 'en', outVttPath: outVtt,
      });
    } finally {
      await fake.close();
    }
    await check('a routed server routes to the Crucible, never the local spawn, and records the venue', () => {
      assert.strictEqual(localCalls, 0);
      assert.deepStrictEqual(outcome.venue, { where: 'crucible', server, origin: 'decided here', because: 'the first enabled server that answered' });
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
        // NOTHING ENABLED: the record would refuse, so this proves the caller's
        // own instruction is answered before the record is ever read.
        host: noServerHost(),
        audioPath: audio, language: 'en', outVttPath: path.join(path.dirname(audio), 'o.vtt'),
      });
    } finally {
      await fake.close();
    }
    await check('the caller\'s own server name is answered before the record is read at all', () => {
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
        audioPath: audio, language: 'en', outVttPath: path.join(path.dirname(audio), 'o.vtt'),
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
    /*
     * A RUN THE DELETED NARRATOR RENDERED IS REFUSED, NOT RE-DECIDED. It used
     * to transcribe locally without re-deciding, which is what a
     * `{where:'legacy-local-narrator'}` run venue meant. That shape no longer
     * exists in the type, and the row's own string is turned away one level up,
     * by `runVenueOfRow` — re-deciding would move a half-rendered book onto a
     * different card (PHASE7-LANES §4.3).
     */
    const stepVenue = require(path.join(REPO, 'dist', 'electron', 'crucible', 'step-venue.js'));
    const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
    await check('a run the deleted narrator rendered is refused by name, never transcribed here', () => {
      assert.throws(
        () => stepVenue.runVenueOfRow(waitFor.RETIRED_LOCAL_NARRATOR_VENUE),
        (err) => err.code === 'legacy_venue_retired',
      );
    });
    await assert.rejects(
      asr.transcribeAtVenue({
        runVenue: { where: 'crucible', server: 'mac' }, crucible: { server: 'local' },
        host: crucibleHost('local'),
        audioPath: freshAudio('book.m4b'), outVttPath: path.join(work, 'never2.vtt'),
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
