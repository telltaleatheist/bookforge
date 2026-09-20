/**
 * THE ZERO-SHOT REFERENCE CLIP, THROUGH BOTH CLIENTS.
 *
 * crucible `docs/PHASE3-TTS.md` §5's 2026-09-14 amendment,
 * docs/EXTENSION-TO-CRUCIBLE-PLAN.md §4b. A `zeroshot` voice is the base
 * weights plus somebody's recording: the weights are the server's, the CLIP is
 * the client's, and it travels with `load-voice` as
 * `params.reference {data, transcript, name}`.
 *
 * Two clients keep two clip stores against ONE voice subject — BookForge's
 * four `zeroshot-*` catalog rows out of
 * `<userData>/runtime/higgs-models/refs/`, and the browser extension's
 * IndexedDB store — so this suite covers both, plus the one module they share.
 *
 *  1. `shared/crucible/voice-reference.ts`, EXECUTED. The checks whose answer
 *     is already in the bytes, refused with the SERVER'S OWN CODES before a
 *     megabyte crosses a tailnet.
 *  2. The EXTENSION, as SOURCE PINS. Its code is a browser bundle (IndexedDB,
 *     `chrome.*`, an offscreen document) and cannot be required from node, so
 *     what is pinned is the same thing `test-extension-option-columns.js`
 *     pins: that the refusal, the picker and the resident-clip read are IN the
 *     source, by name. The behaviour they wrap is section 1's, executed.
 *  3. The APP, against a REAL FAKE CRUCIBLE over a real socket: the four
 *     catalog rows load as `zeroshot` with the catalog's own BOOK-EXACT
 *     transcript on the wire, a checkpoint sends none, and both mismatches are
 *     refused by name before the job is submitted.
 *  4. A TRIPWIRE on the SDK. Both clients read `resident.reference` off
 *     `/v1/activity` with their own `fetch`, because the SDK's activity
 *     shaper builds `resident` out of four named fields and DROPS the rest.
 *     The day it carries the field, this check goes red and says to delete
 *     both readers — the same discipline `test-crucible-settings-seam.js`
 *     applied to the capability route, which expired exactly that way.
 *
 * NO GPU, NO SERVER, NO NETWORK beyond 127.0.0.1.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { skipLine } = require('./keeper-skip.js');

const { REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer } =
  require('./fake-crucible.js');

const SHARED = path.join(REPO, 'dist', 'shared', 'crucible', 'voice-reference.js');
const DOOR = path.join(REPO, 'dist', 'electron', 'crucible', 'voice-load.js');
if (!fs.existsSync(SHARED) || !fs.existsSync(DOOR)) {
  console.log(skipLine('dist/shared/crucible/voice-reference.js or '
    + 'dist/electron/crucible/voice-load.js is not built — run npx tsc -p tsconfig.electron.json'));
  process.exit(0);
}

const { userData } = installElectronStub('bf-zeroshot-reference-');

const ref = require(SHARED);
const { check, summary } = makeChecker();

console.log('the zero-shot reference clip');

// ─────────────────────────────────────────────────────────────────────────────
// A WAV, built rather than fixtured — 16-bit mono PCM of the requested length.
// ─────────────────────────────────────────────────────────────────────────────

function wavOf(seconds, sampleRate = 24000) {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(((i * 37) % 30000) - 15000, 44 + i * 2);
  return buf;
}

function bytesOf(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function refusal(fn) {
  try { fn(); } catch (err) { return err; }
  throw new assert.AssertionError({ message: 'nothing was refused' });
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 1. The checks a client can make from the bytes — the server's own names
  // ───────────────────────────────────────────────────────────────────────────

  await check('a fifteen-second wav reads its own duration out of the header', () => {
    const facts = ref.readWavFacts(bytesOf(wavOf(15.09)), 'the clip');
    assert.ok(Math.abs(facts.seconds - 15.09) < 0.001, `read ${facts.seconds}s`);
    assert.strictEqual(facts.sampleRate, 24000);
    assert.strictEqual(facts.channels, 1);
    assert.strictEqual(facts.bitsPerSample, 16);
  });

  await check('an mp3 renamed .wav is reference_malformed, not uploaded and refused there', () => {
    const notAWav = Buffer.alloc(2048);
    notAWav.write('ID3', 0, 'ascii');
    const err = refusal(() => ref.refuseUnusableClip(bytesOf(notAWav), 'anything', 'the clip'));
    assert.strictEqual(err.code, 'reference_malformed');
    assert.match(err.message, /RIFF\/WAVE/);
  });

  await check('over narrator\'s 30-second budget is refused, and NOTHING trims it', () => {
    const err = refusal(() => ref.refuseUnusableClip(bytesOf(wavOf(30.5)), 'words', 'the clip'));
    assert.strictEqual(err.code, 'reference_malformed');
    assert.match(err.message, /30/);
    assert.match(err.message, /nothing here trims it/i);
    // The boundary itself is fine: 30.0 s is the cap, not the first refusal.
    assert.doesNotThrow(() => ref.refuseUnusableClip(bytesOf(wavOf(30)), 'words', 'the clip'));
  });

  await check('over 32 MiB is refused BEFORE the header is walked — a gigabyte is never parsed', () => {
    // Not a wav at all: if the size check did not come first this would be
    // refused as "not RIFF/WAVE", which is the wrong sentence for the problem.
    const huge = new Uint8Array(ref.REFERENCE_MAX_BYTES + 1);
    const err = refusal(() => ref.refuseUnusableClip(huge, 'words', 'the clip'));
    assert.strictEqual(err.code, 'reference_malformed');
    assert.match(err.message, /MiB/);
    assert.strictEqual(ref.REFERENCE_MAX_BYTES, 32 * 1024 * 1024);
    assert.strictEqual(ref.REFERENCE_MAX_SECONDS, 30.0);
  });

  await check('a blank transcript is refused, and the refusal says WHY it matters', () => {
    const err = refusal(() => ref.refuseUnusableClip(bytesOf(wavOf(15)), '   \n', 'the clip'));
    assert.strictEqual(err.code, 'reference_malformed');
    assert.match(err.message, /book-exact/);
    assert.match(err.message, /never an ASR guess/);
    assert.match(err.message, /reported as success/);
  });

  await check('the encoding is strict base64 — no data: prefix, no whitespace, byte-exact', () => {
    const wav = wavOf(0.01);
    const encoded = ref.encodeReferenceData(bytesOf(wav));
    assert.ok(!encoded.startsWith('data:'), 'a data: prefix is a refusal on the wire, not a habit');
    assert.ok(!/\s/.test(encoded), 'a pasted newline is `reference_malformed`');
    assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
    // The server hashes the DECODED audio, so this has to agree with every
    // other base64 in the world byte for byte — including the three padding
    // cases, which is where a hand-rolled encoder goes wrong.
    for (const len of [1, 2, 3, 4, 5, 6, 7, 255, 1024]) {
      const slice = wav.subarray(0, len);
      assert.strictEqual(ref.encodeReferenceData(bytesOf(slice)), slice.toString('base64'),
        `base64 of ${len} bytes disagrees with Node's`);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. The extension — source pins, because its code is a browser bundle
  // ───────────────────────────────────────────────────────────────────────────

  const src = (file) => fs.readFileSync(path.join(REPO, 'extension', file), 'utf-8');
  const offscreenTs = src(path.join('src', 'offscreen.ts'));
  const clipsTs = src(path.join('src', 'clips.ts'));
  const crucibleTs = src(path.join('src', 'crucible.ts'));
  const popupTs = src(path.join('src', 'popup.ts'));
  const optionsTs = src(path.join('src', 'options.ts'));
  const optionsHtml = src(path.join('static', 'options.html'));
  const popupHtml = src(path.join('static', 'popup.html'));

  await check('EXTENSION: a reference-needing voice with no clip is refused reference_required', () => {
    assert.match(offscreenTs, /row\?\.needsReference === true/,
      'the decision is the ROW\'s `needsReference`, never guessed from the voice id');
    assert.match(offscreenTs, /reference_required: "\$\{voice\}" is cloned from a recording/,
      'the refusal does not use the server\'s own word for it');
    // And it refuses BEFORE the job: the load call must not be reachable with
    // a needed-but-missing reference.
    const refuseAt = offscreenTs.indexOf('reference_required: "${voice}"');
    const loadAt = offscreenTs.indexOf('await loadVoiceJob(');
    assert.ok(refuseAt > 0 && loadAt > refuseAt,
      'the reference_required refusal does not precede the load-voice job');
  });

  await check('EXTENSION: the clip store runs the shared checks before a byte is stored', () => {
    assert.match(clipsTs, /from '\.\.\/\.\.\/shared\/crucible\/voice-reference'/,
      'the extension has its own copy of the checks instead of the shared module');
    assert.match(clipsTs, /refuseUnusableClip\(input\.bytes/, 'addClip stores without checking');
    // And on the way OUT as well: a clip stored by an older build, or one
    // edited into blankness, is refused here rather than on the wire.
    assert.match(clipsTs, /export async function referenceFor[\s\S]*?refuseUnusableClip\(/,
      'referenceFor trusts whatever is in the store');
  });

  await check('EXTENSION: the clip travels in loadVoice(voice, {reference}), and null is a real answer', () => {
    assert.match(crucibleTs, /client\.loadVoice\(voice, \{ reference \}\)/);
    assert.match(crucibleTs, /reference === null[\s\S]{0,80}client\.loadVoice\(voice\)/,
      'a checkpoint load sends something instead of nothing');
  });

  await check('EXTENSION: the server\'s reference_malformed is surfaced VERBATIM', () => {
    const at = crucibleTs.indexOf("err.code === 'reference_malformed'");
    assert.ok(at > 0, 'the extension does not name reference_malformed at all');
    const body = crucibleTs.slice(at, at + 600);
    assert.match(body, /VERBATIM/, 'the intent is not stated where the next reader will see it');
    assert.match(body, /return `\$\{at\}: \$\{err\.serverMessage\}`/,
      'the server\'s own sentence is reworded instead of passed through');
    for (const code of ['reference_required', 'reference_not_allowed']) {
      assert.ok(crucibleTs.includes(`err.code === '${code}'`), `${code} has no sentence`);
    }
  });

  await check('EXTENSION: the popup picks a clip under the voice, and shows the RESIDENT one', () => {
    assert.match(popupHtml, /id="clipRow"/, 'there is no clip row in the popup markup');
    assert.match(popupTs, /row\?\.needsReference === true/,
      'the picker is shown by something other than the row\'s own fact');
    assert.match(popupTs, /cmd: 'set-clip'/, 'picking a clip reaches nothing');
    assert.match(popupTs, /cloned from "\$\{engine\.residentClip\}"/,
      'the popup does not say WHICH clip is on the card');
    assert.match(popupTs, /residentClipNote/,
      'a server that could not be asked reads as "no clip", which would be a lie');
  });

  await check('EXTENSION: Options takes a WAV, a name and a REQUIRED transcript', () => {
    assert.match(optionsHtml, /Zero-shot clips/);
    assert.match(optionsHtml, /id="clipFile"[^>]*accept="audio\/wav,\.wav"/);
    assert.match(optionsHtml, /id="clipTranscript"/);
    assert.match(optionsHtml, /book-exact text it says/,
      'the page does not say the transcript must be the book\'s own words');
    assert.match(optionsTs, /addClip\(\{[\s\S]{0,200}transcript: clipTranscriptEl\.value/,
      'the transcript textarea is not what is stored');
    // The transcript is TYPED, never derived: no ASR call, no recogniser, no
    // "guess it for me" button anywhere in the page that takes the clip.
    assert.ok(!/whisper|SpeechRecognition|transcribe\(/i.test(optionsTs),
      'something in the Options page derives a transcript — it is never derived');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. The app — the four catalog rows, over a real socket to a fake Crucible
  // ───────────────────────────────────────────────────────────────────────────

  const voiceLoad = require(DOOR);
  const higgs = require(path.join(REPO, 'dist', 'electron', 'higgs-models.js'));
  const servers = require(path.join(REPO, 'dist', 'electron', 'crucible', 'servers.js'));
  const probe = require(path.join(REPO, 'dist', 'electron', 'crucible', 'probe.js'));

  // Stage the four clips where the catalog says they live. They are voice
  // ARTIFACTS, staged per machine like a checkpoint, so a repo checkout does
  // not have them and this suite makes its own.
  const refsDir = higgs.higgsRefsDir(userData);
  fs.mkdirSync(refsDir, { recursive: true });
  const zeroshots = higgs.listHiggsModels().filter((m) => m.kind === 'clips');
  for (const model of zeroshots) {
    fs.writeFileSync(path.join(refsDir, model.voice.clips[0].path), wavOf(15.09));
  }

  await check('the catalog still carries four zero-shot rows, each with a BOOK-EXACT transcript', () => {
    assert.strictEqual(zeroshots.length, 4, `the catalog has ${zeroshots.length} clips voices`);
    for (const model of zeroshots) {
      assert.strictEqual(model.voice.clips.length, 1,
        `${model.id} declares ${model.voice.clips.length} clips; exactly one travels with a load`);
      const clip = model.voice.clips[0];
      assert.ok(clip.transcript.trim().length > 40,
        `${model.id}'s clip has no usable transcript, and NOTHING here may invent one`);
      assert.ok(clip.path === path.basename(clip.path),
        `${model.id}'s clip path is not a bare name in the models area`);
    }
  });

  await check('all four load as ONE Crucible voice, distinguished by the clip', () => {
    for (const model of zeroshots) {
      const load = voiceLoad.crucibleVoiceLoadFor(model.id, userData);
      assert.strictEqual(load.voice, 'zeroshot',
        `${model.id} mapped to ${load.voice}; the four are one voice subject plus four clips`);
      assert.strictEqual(load.reference.transcript, model.voice.clips[0].transcript,
        `${model.id} sent a transcript that is not the catalog's`);
      assert.strictEqual(load.reference.name, model.id,
        'the resident report would not say WHICH of the four is up');
      assert.ok(!load.reference.data.startsWith('data:'));
      assert.ok(!/\s/.test(load.reference.data));
    }
  });

  await check('a checkpoint voice sends NO reference — its speaker is in its weights', () => {
    const load = voiceLoad.crucibleVoiceLoadFor('mistborn', userData);
    assert.strictEqual(load.voice, 'mistborn');
    assert.strictEqual(load.reference, null);
  });

  await check('a zero-shot clip that is not on this machine is refused, naming the folder', () => {
    fs.rmSync(path.join(refsDir, zeroshots[0].voice.clips[0].path));
    const err = refusal(() => voiceLoad.crucibleVoiceLoadFor(zeroshots[0].id, userData));
    assert.strictEqual(err.code, 'reference_required');
    assert.match(err.message, /runtime\/higgs-models\/refs/);
    fs.writeFileSync(path.join(refsDir, zeroshots[0].voice.clips[0].path), wavOf(15.09));
  });

  const registerFake = fakeNamer(servers);

  /** A fake whose voices row for `zeroshot` says it needs a reference. */
  function voicesDocument(shape = { preField: false, partial: false }) {
    const pace = {
      pace_chars_per_sec: 17.28, max_chars_per_sec: 22.46, min_chars_per_sec: 13.29,
      target_chars: null, safe_min_chars: 400, safe_max_chars: 800,
    };
    const row = (id, kind, needsReference) => ({
      id, display: id, kind, language: 'en', narrator_engine: 'higgs-v3',
      backend_supported: true, installed: true, resident: false, loadable: true, reason: null,
      revision: 'abc1234', fingerprint: `${id}@abc1234`, memory_bytes_estimate: 19000000000,
      estimate_basis: 'declared', max_chars: 600, sample_rate: 24000, takes: 1,
      needs_reference: needsReference, pace,
      // Required on every row since 2026-09-19; the SDK refuses a row with no
      // [voice.serving] block rather than inventing the width it was started at.
      serving: {
        max_num_seqs: 4, max_num_seqs_note: 'measured', mem_fraction: 0.6,
        mem_fraction_note: 'measured', context_length: 4096,
        context_length_note: 'measured',
      },
    });
    // `GET /v1/voices` answers the ARRAY, not an envelope around one.
    const rows = [row('mistborn', 'checkpoint', false), row('zeroshot', 'zeroshot', true)];
    // A server older than crucible `743dc1a` states the field on NO row; a
    // broken one states it on some. Both are shapes the SDK has a reading for,
    // and both are served from here rather than described in a comment.
    if (shape.preField) for (const r of rows) delete r.needs_reference;
    if (shape.partial) delete rows[0].needs_reference;
    return rows;
  }

  async function withFake(behaviour, fn) {
    const state = { residentReference: behaviour.residentReference, omitDoneReference: !!behaviour.omitDoneReference };
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname === '/v1/voices' && req.method === 'GET') {
        ctx.send(res, 200, voicesDocument({
          preField: !!behaviour.preFieldVoices && !ctx.state.partialVoices,
          partial: !!ctx.state.partialVoices,
        }));
        return true;
      }
      if (ctx.url.pathname === '/v1/activity' && req.method === 'GET') {
        ctx.send(res, 200, {
          server: { name: 'fake', version: '0.6.0', api_version: 1, backend: 'cuda-linux', uptime_s: 1 },
          resident: state.residentReference === undefined ? null : {
            kind: 'tts', id: 'zeroshot', since: '2026-09-14T00:00:00Z', memory_bytes_estimate: 1,
            reference: state.residentReference,
          },
          warming: null, claim: null, streaming: null, chat: { in_flight: 0, rows: [] },
          lease: null, slots: { accelerated: { busy: 0, capacity: 1 } }, running: [], queued: [],
        });
        return true;
      }
      if (ctx.url.pathname === '/v1/jobs' && req.method === 'POST') {
        const body = JSON.parse((await ctx.readBody(req)).toString('utf-8'));
        ctx.state.submitted.push(body);
        ctx.send(res, 202, { job_id: 'job-1', status: 'queued' });
        return true;
      }
      if (/^\/v1\/jobs\/[^/]+\/events$/.test(ctx.url.pathname) && req.method === 'GET') {
        const sse = ctx.sseWriter(req, res);
        const done = { artifacts: [], resident: 'zeroshot', fingerprint: 'zeroshot@abc1234' };
        if (!state.omitDoneReference) {
          done.reference = { name: 'zeroshot-mistborn', sha256: 'a'.repeat(64), seconds: 15.09 };
        }
        sse.frame('done', done);
        sse.end();
        return true;
      }
      return false;
    });
    const name = registerFake(fake.url);
    try {
      await fn({ name, fake, state });
    } finally {
      await fake.close();
    }
  }

  await withFake({}, async ({ name, fake }) => {
    await check('the transcript and the wav CROSS THE WIRE, in params.reference', async () => {
      const got = await probe.loadHiggsVoiceOn(name, 'zeroshot-mistborn', userData);
      assert.strictEqual(got.outcome, 'ok', got.message);
      assert.strictEqual(fake.state.submitted.length, 1);
      const body = fake.state.submitted[0];
      assert.strictEqual(body.type, 'load-voice');
      assert.strictEqual(body.model, 'zeroshot', 'the voice id is not `model` on the wire');
      const sent = body.params.reference;
      const expected = higgs.resolveHiggsModel('zeroshot-mistborn').voice.clips[0];
      assert.strictEqual(sent.transcript, expected.transcript,
        'the clip crossed without the catalog\'s book-exact text');
      assert.strictEqual(sent.name, 'zeroshot-mistborn');
      assert.ok(!sent.data.startsWith('data:'), 'a data: prefix is refused by the server');
      const decoded = Buffer.from(sent.data, 'base64');
      assert.strictEqual(decoded.subarray(0, 4).toString('ascii'), 'RIFF',
        'what arrived is not the wav that is on disk');
      assert.strictEqual(got.loaded.reference.name, 'zeroshot-mistborn',
        'the done frame\'s resident clip did not reach the caller');
      assert.strictEqual(got.loaded.reference.seconds, 15.09);
    });

    await check('a checkpoint load carries no reference at all', async () => {
      fake.state.submitted.length = 0;
      const got = await probe.loadHiggsVoiceOn(name, 'mistborn', userData);
      assert.strictEqual(got.outcome, 'ok', got.message);
      const body = fake.state.submitted[0];
      assert.strictEqual(body.model, 'mistborn');
      assert.strictEqual(body.params?.reference, undefined,
        'a clip was sent for a voice whose speaker is in its weights (reference_not_allowed)');
    });

    await check('the ROW decides, and both mismatches are refused BEFORE the job', async () => {
      const rows = await servers.crucibleClientFor(name, 'bookforge').voices();
      // A reference-needing row handed a load with no clip.
      const missing = refusal(() => voiceLoad.refuseMismatchedReference(
        rows, { voice: 'zeroshot', reference: null }, name));
      assert.strictEqual(missing.code, 'reference_required');
      assert.match(missing.message, /model's OWN speaker/);
      // A checkpoint row handed one.
      const extra = refusal(() => voiceLoad.refuseMismatchedReference(
        rows, { voice: 'mistborn', reference: { data: 'AA==', transcript: 'x', name: 'x' } }, name));
      assert.strictEqual(extra.code, 'reference_not_allowed');
      // A voice the server does not serve at all.
      const unknown = refusal(() => voiceLoad.refuseMismatchedReference(
        rows, { voice: 'nobody', reference: null }, name));
      assert.strictEqual(unknown.code, 'crucible_unknown_voice');
      assert.match(unknown.message, /mistborn, zeroshot/);
    });
  });

  await withFake({ preFieldVoices: true }, async ({ name, fake }) => {
    await check('a PRE-FIELD voices document reads as all-false, and a partial one is refused', async () => {
      /*
       * The SDK's reading, checked rather than assumed (crucible `00a59b16`,
       * PHASE15-HOST.md §3.3's rule applied to `needs_reference`): a document
       * in which NO row carries the field comes from a server older than
       * `743dc1a`, where every voice IS a checkpoint — so `needsReference`
       * reads false because the document's VINTAGE says so, not because a
       * client filled a default. It matters here because this app's load door
       * asks the row before it sends a clip: a false read of `true` would
       * refuse a legitimate checkpoint load `reference_required`.
       */
      const rows = await servers.crucibleClientFor(name, 'bookforge').voices();
      assert.ok(rows.length > 0);
      for (const row of rows) {
        assert.strictEqual(row.needsReference, false,
          `${row.id} reads needsReference ${row.needsReference} on a pre-field document`);
      }
      // And a HALF-stated document is a defect, not a vintage: the SDK
      // refuses it by name rather than reading the silent row as false.
      fake.state.partialVoices = true;
      await assert.rejects(
        () => servers.crucibleClientFor(name, 'bookforge').voices(),
        /voices_needs_reference_missing/,
        'a document where SOME rows state needs_reference and one does not was read anyway');
      fake.state.partialVoices = false;
    });
  });

  await withFake({ omitDoneReference: true }, async ({ name }) => {
    await check('a done frame with NO reference key is refused, not read as "no clip"', async () => {
      const got = await probe.loadHiggsVoiceOn(name, 'zeroshot-mistborn', userData);
      assert.strictEqual(got.outcome, 'refused');
      assert.match(got.message, /predates/);
      assert.match(got.message, /unknowable/);
    });
  });

  // `residentClipOn` reaches the registry directly for the token, so the fake
  // is named through `getServer` as well as through `crucibleClientFor`.
  const realGetServer = servers.getServer;
  await withFake({ residentReference: { name: 'the stranger', sha256: 'b'.repeat(64), seconds: 14.2 } },
    async ({ name, fake }) => {
      servers.getServer = (asked) => (asked === name
        ? { name, url: fake.url, token: 'test-token-abcd' }
        : realGetServer(asked));
      try {
        await check('WHICH clip is resident is readable — two clients, one card', async () => {
          const got = await probe.residentClipOn(name);
          assert.strictEqual(got.outcome, 'ok', got.message);
          assert.strictEqual(got.clip.name, 'the stranger');
          assert.strictEqual(got.clip.seconds, 14.2);
        });
      } finally {
        servers.getServer = realGetServer;
      }
    });

  await withFake({ residentReference: null }, async ({ name, fake }) => {
    servers.getServer = (asked) => (asked === name
      ? { name, url: fake.url, token: 'test-token-abcd' }
      : realGetServer(asked));
    try {
      await check('a checkpoint on the card reports reference: null, which is an ANSWER', async () => {
        const got = await probe.residentClipOn(name);
        assert.strictEqual(got.outcome, 'ok', got.message);
        assert.strictEqual(got.clip, null);
      });
    } finally {
      servers.getServer = realGetServer;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. THE SDK TRIPWIRE — delete both raw readers the day this goes red
  // ───────────────────────────────────────────────────────────────────────────

  await check('TRIPWIRE: the SDK still drops resident.reference from /v1/activity', () => {
    /*
     * THIS ASSERTS A GAP, DELIBERATELY, AND IT EXPIRES.
     *
     * PHASE3-TTS.md §5's amendment puts `reference: {name, sha256, seconds}`
     * on `/v1/activity`'s `resident` block. The SDK's activity reader
     * builds `resident` out of four named fields and drops everything else, so
     * BOTH clients read that one field with their own `fetch`:
     * `electron/crucible/probe.ts`'s `residentClipOn` and
     * `extension/src/crucible.ts`'s `residentClipOf`.
     *
     * Neither is a second opinion — they read ONE field the SDK does not model
     * and take everything else from `activity()` — and neither is worked
     * around in the SDK's absence, which is what this check is for.
     *
     * WHEN THIS GOES RED, NOTHING HAS REGRESSED — IT IS THE FIX ARRIVING.
     * Delete both readers, take the clip from `activity().resident.reference`,
     * and delete this check. (`test-crucible-settings-seam.js`'s capability
     * tripwire expired exactly this way on 2026-09-14.)
     */
    const sdk = fs.readFileSync(
      path.join(REPO, 'node_modules', '@crucible', 'client', 'dist', 'esm', 'client.js'), 'utf-8');
    const at = sdk.indexOf("nullableObject(body, 'resident', 'activity')");
    assert.ok(at > 0, 'the SDK\'s activity reader has moved — re-read it before trusting this');
    const shaper = sdk.slice(at, at + 1400);
    assert.ok(!/reference/.test(shaper),
      'THE SDK NOW CARRIES resident.reference — which is what this check was waiting for.\n'
      + '        Delete electron/crucible/probe.ts\'s `residentClipOn` and\n'
      + '        extension/src/crucible.ts\'s `residentClipOf`, read the clip from\n'
      + '        `activity().resident.reference` in both, and delete this check.');

    // The other half of the gap, stated so a reader of one is not surprised by
    // the other: the load job's `done` DOES reach us through the SDK, in
    // `DoneData.extra`, which carries every unmodelled key verbatim.
    const types = fs.readFileSync(
      path.join(REPO, 'node_modules', '@crucible', 'client', 'dist', 'esm', 'types.d.ts'), 'utf-8');
    assert.match(types, /readonly needsReference: boolean;/,
      'VoiceInfo lost needsReference — the pickers have nothing to ask');
    assert.match(types, /export interface VoiceReference/,
      'the SDK no longer models the reference clip at all');
    assert.match(types, /readonly extra: Readonly<Record<string, unknown>>;/,
      'DoneData lost `extra`, which is how the load\'s own resident clip reaches us');
  });

  summary('zero-shot reference');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
