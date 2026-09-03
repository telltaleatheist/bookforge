/**
 * Tests for the Tab Recorder — the two halves of it that can be pure.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-tab-recorder.js
 *
 * THE AUDIO MATH, because it runs on the audio thread and nobody will ever see
 * it fail: a render quantum that straddles a frame boundary has to split, not
 * drop; the interleave has to put channel 1 in channel 1 forever; and peak/RMS
 * are what the silence gates and the level meter are made of. A quiet bug here is
 * a six-hour file of the wrong thing.
 *
 * THE SESSION STATE MACHINE, because it owns a file. Start/stop/cancel/close
 * ordering, the refusal of a second recording, and — the one that matters most —
 * that a live recording is a hidden `.partial.flac` and only ever becomes a
 * `.flac` by being finished. A .flac in the user's folder must always be a real
 * recording, and this is what makes that true. Plus the save location itself:
 * `~` expansion, the refusal of a relative path, and the crash sweep.
 *
 * Everything is written to a temp directory; nothing here touches the library,
 * ffmpeg, or Electron (the session takes an injected encoder, which is the only
 * reason the encoder is an interface at all).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');
if (!fs.existsSync(path.join(DIST, 'electron', 'tab-recording.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  RECORDER,
  RECORD_SPEEDS,
  InterleavedFramer,
  SilenceWatch,
  bytesPerSecond,
  chunkFrameSize,
  formatElapsed,
  framePeak,
  frameRms,
  DEFAULT_RECORDINGS_DIR,
  expandHome,
  isPartialFileName,
  minimumCaptureRateFor,
  partialFileName,
  recordingFileName,
  relabelRefusal,
  relabelledSampleRate,
  safeRecordingTitle,
  secondsFromBytes,
  sidecarFileName,
  silenceStopReason,
  speedGuardRefusal,
} = require(path.join(DIST, 'shared', 'audio', 'tab-recording.js'));

const {
  TabRecorder,
  TabRecordingSession,
  resolveRecordingDir,
  setRecordingDirsStore,
  sweepPartialRecordings,
} = require(path.join(DIST, 'electron', 'tab-recording.js'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-recorder-'));

let failures = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (err) {
    failures++;
    results.push(['FAIL', name, err && err.message]);
  }
}

/** An encoder that is just a file. Everything the session does around it — the
 *  partial path, the rename, the sidecar, the refusals — is the thing under test;
 *  ffmpeg's own behaviour is not. */
function fileEncoder(events = []) {
  return async (spec) => {
    const fd = fs.openSync(spec.outputPath, 'w');
    let open = true;
    events.push(['spawn', spec.sampleRate, spec.channels, spec.outputPath]);
    return {
      write(chunk) {
        if (!open) throw new Error('encoder is closed');
        fs.writeSync(fd, chunk);
        return true;
      },
      async finish() {
        if (open) { fs.closeSync(fd); open = false; }
        events.push(['finish']);
      },
      kill() {
        if (open) { fs.closeSync(fd); open = false; }
        events.push(['kill']);
      },
    };
  };
}

/** An encoder that refuses to exist — the "ffmpeg not found" shape. */
function missingEncoder() {
  return async () => {
    throw new Error('ffmpeg not found at /nowhere/ffmpeg — set it in BookForge\'s tool paths');
  };
}

const FIXED = new Date(2026, 8, 3, 14, 5, 9); // 2026-09-03 14:05:09 local

function pcm(bytes) {
  return Buffer.alloc(bytes, 1);
}

(async () => {
  // ── the audio math ────────────────────────────────────────────────────────

  await check('peak and RMS read an interleaved frame', () => {
    const frame = Float32Array.from([0.5, -0.75, 0.25, -0.25]);
    assert.strictEqual(framePeak(frame), 0.75, 'peak must be the largest ABSOLUTE sample');
    const expected = Math.sqrt((0.25 + 0.5625 + 0.0625 + 0.0625) / 4);
    assert.ok(Math.abs(frameRms(frame) - expected) < 1e-9, 'rms is off');
    assert.strictEqual(framePeak(new Float32Array(64)), 0, 'digital silence must read 0');
    assert.strictEqual(frameRms(new Float32Array(0)), 0, 'an empty frame must not divide by zero');
  });

  await check('a quantum that straddles a frame boundary splits, it does not drop', () => {
    // frameSize 3, stereo: 6 samples per frame. Feed 4 per channel — one full
    // frame plus one sample held back.
    const framer = new InterleavedFramer(2, 3);
    const out = framer.push([
      Float32Array.from([1, 2, 3, 4]),
      Float32Array.from([-1, -2, -3, -4]),
    ]);
    assert.strictEqual(out.length, 1, 'exactly one frame should have completed');
    assert.deepStrictEqual(Array.from(out[0]), [1, -1, 2, -2, 3, -3], 'interleave is wrong');
    assert.strictEqual(framer.pending, 1, 'the straddling sample was not held');

    // The next quantum completes the frame using the held sample FIRST.
    const out2 = framer.push([
      Float32Array.from([5, 6]),
      Float32Array.from([-5, -6]),
    ]);
    assert.strictEqual(out2.length, 1, 'the held sample did not open the next frame');
    assert.deepStrictEqual(Array.from(out2[0]), [4, -4, 5, -5, 6, -6], 'the split lost or reordered audio');
    assert.strictEqual(framer.pending, 0);
    assert.strictEqual(framer.flush(), null, 'nothing pending, so nothing to flush');
  });

  await check('a quantum larger than a frame emits every frame it contains', () => {
    const framer = new InterleavedFramer(1, 2);
    const out = framer.push([Float32Array.from([1, 2, 3, 4, 5, 6, 7])]);
    assert.strictEqual(out.length, 3, 'three whole frames should have come out');
    assert.deepStrictEqual(Array.from(out[2]), [5, 6]);
    const tail = framer.flush();
    assert.deepStrictEqual(Array.from(tail), [7], 'the tail sample was lost');
    assert.strictEqual(framer.flush(), null, 'flush must not repeat itself');
  });

  await check('the framer refuses a channel count it was not built for', () => {
    const framer = new InterleavedFramer(2, 4);
    assert.throws(
      () => framer.push([Float32Array.from([1, 2])]),
      /expected 2 channels, got 1/,
      'a missing channel must be an error, not a silent shift of the interleave'
    );
    assert.throws(() => new InterleavedFramer(0, 4), /positive integer/);
    assert.throws(() => new InterleavedFramer(2, 0), /positive integer/);
  });

  await check('frame size and byte arithmetic agree with each other', () => {
    assert.strictEqual(chunkFrameSize(48000), 4800, '100 ms at 48 kHz is 4800 frames');
    assert.strictEqual(bytesPerSecond(48000, 2), 48000 * 2 * 4);
    assert.ok(Math.abs(secondsFromBytes(48000 * 2 * 4, 48000, 2) - 1) < 1e-12);
    assert.strictEqual(secondsFromBytes(1000, 0, 2), 0, 'a zero rate must not produce Infinity');
    assert.strictEqual(formatElapsed(3661), '1:01:01');
    assert.strictEqual(formatElapsed(-5), '0:00:00');
  });

  // ── the silence gates ─────────────────────────────────────────────────────

  await check('silence stops the recording wherever it falls — including at the start', () => {
    // The user pressed Record and never pressed Play. The rule is the same rule.
    const watch = new SilenceWatch();
    assert.strictEqual(watch.waiting, true, 'nothing heard yet must read as waiting');
    let verdict = null;
    let elapsed = 0;
    for (; elapsed < RECORDER.SILENCE_STOP_SECONDS + 5 && !verdict; elapsed += 0.1) {
      verdict = watch.feed(0, 0.1);
    }
    assert.strictEqual(verdict, 'silence-stop', 'leading silence never stopped the recording');
    assert.ok(Math.abs(elapsed - RECORDER.SILENCE_STOP_SECONDS) < 0.2,
      `it must fire at ${RECORDER.SILENCE_STOP_SECONDS}s, fired at ${elapsed}s`);
    assert.strictEqual(watch.feed(0, 0.1), null, 'the stop must fire once, not forever');
    assert.ok(/30 seconds of silence/.test(silenceStopReason()), 'the reason must name the window');
  });

  await check('the countdown is visible and resets whenever audio returns', () => {
    const watch = new SilenceWatch();
    assert.strictEqual(watch.secondsUntilStop, RECORDER.SILENCE_STOP_SECONDS);
    for (let t = 0; t < 10; t++) watch.feed(0, 1);
    assert.strictEqual(watch.silentSeconds, 10, 'the silence run was not counted');
    assert.strictEqual(watch.secondsUntilStop, RECORDER.SILENCE_STOP_SECONDS - 10,
      'the countdown must show what is left');
    assert.strictEqual(watch.waiting, true, 'still nothing heard');

    watch.feed(0.3, 1); // audio at last
    assert.strictEqual(watch.waiting, false, 'audio arrived and waiting did not clear');
    assert.strictEqual(watch.secondsUntilStop, RECORDER.SILENCE_STOP_SECONDS,
      'the countdown must reset the moment audio returns');
  });

  await check('a chapter gap is legitimate; thirty seconds is not', () => {
    const watch = new SilenceWatch();
    watch.feed(0.3, 1);
    // A real audiobook chapter gap is 2-4 s. It must not end the book.
    for (let t = 0; t < 4; t++) {
      assert.strictEqual(watch.feed(0, 1), null, `a ${t + 1}s chapter gap must not stop the recording`);
    }
    watch.feed(0.3, 1);
    let verdict = null;
    for (let t = 0; t < RECORDER.SILENCE_STOP_SECONDS + 5 && !verdict; t++) verdict = watch.feed(0, 1);
    assert.strictEqual(verdict, 'silence-stop', 'the end of the book never stopped the recording');
  });

  await check('quiet is not silence — the threshold judges "nothing is playing"', () => {
    const watch = new SilenceWatch();
    // A quiet passage still sits far above the floor and must never accumulate.
    for (let t = 0; t < 60; t++) {
      assert.strictEqual(watch.feed(0.01, 1), null, 'quiet audio was treated as silence');
    }
    assert.strictEqual(watch.silentSeconds, 0);
    assert.strictEqual(watch.waiting, false);
  });

  // ── speed capture ─────────────────────────────────────────────────────────

  await check('the speed guard refuses exactly what falls below the training floor', () => {
    // The table in the module header, asserted.
    assert.strictEqual(speedGuardRefusal(48000, 1), null, '48k @1x must be allowed');
    assert.strictEqual(speedGuardRefusal(48000, 1.5), null, '48k @1.5x = 32 kHz, allowed');
    assert.strictEqual(speedGuardRefusal(48000, 2), null, '48k @2x = 24 kHz, exactly the floor');
    assert.ok(speedGuardRefusal(48000, 3), '48k @3x = 16 kHz must be refused');
    assert.ok(speedGuardRefusal(48000, 4), '48k @4x = 12 kHz must be refused');
    assert.strictEqual(speedGuardRefusal(96000, 4), null, '96k @4x = 24 kHz, allowed');
    assert.ok(speedGuardRefusal(44100, 2), '44.1k @2x = 22.05 kHz is below the floor');

    const refusal = speedGuardRefusal(48000, 3);
    assert.ok(refusal.includes('3x'), 'the refusal must name the speed');
    assert.ok(refusal.includes('48000 Hz'), 'the refusal must name the capture rate');
    assert.ok(refusal.includes('16000 Hz'), 'the refusal must name what would be kept');
    assert.ok(/24 kHz training floor/.test(refusal), 'the refusal must name the floor');
    assert.ok(/Audio MIDI Setup/.test(refusal), 'the refusal must say what to do about it');

    assert.strictEqual(minimumCaptureRateFor(2), 48000);
    assert.strictEqual(minimumCaptureRateFor(4), 96000);
  });

  await check('the file is RELABELLED, never resampled — and only to a whole rate', () => {
    assert.strictEqual(relabelledSampleRate(48000, 2), 24000);
    assert.strictEqual(relabelledSampleRate(96000, 1.5), 64000);
    assert.strictEqual(relabelRefusal(48000, 2), null);
    assert.strictEqual(relabelRefusal(48000, 1.5), null, '48000/1.5 = 32000 is whole');
    const refusal = relabelRefusal(48000, 7);
    assert.ok(refusal, 'a speed that does not divide the rate must be refused');
    assert.ok(/does not divide/.test(refusal) && refusal.includes('7x'),
      'the refusal must name the speed and say why');
    assert.ok(RECORD_SPEEDS.every((s) => relabelRefusal(48000, s) === null),
      'every offered speed must divide 48 kHz into a whole rate');
  });

  // ── naming ────────────────────────────────────────────────────────────────

  await check('a page title becomes a filename every filesystem accepts', () => {
    assert.strictEqual(safeRecordingTitle('The Rise/Fall: A History?'), 'The Rise Fall A History');
    assert.strictEqual(safeRecordingTitle('   '), 'tab-audio', 'an empty title still needs a name');
    assert.strictEqual(safeRecordingTitle('trailing dots...'), 'trailing dots', 'Windows refuses trailing dots');
    assert.strictEqual(safeRecordingTitle('CON'), 'CON_', 'a reserved device name must be escaped');
    assert.ok(safeRecordingTitle('x'.repeat(400)).length <= 80, 'the title must be capped');
    assert.strictEqual(
      recordingFileName('Audible: The Waste Land', FIXED),
      'Audible The Waste Land-20260903-140509.flac'
    );
    assert.strictEqual(
      sidecarFileName('Audible The Waste Land-20260903-140509.flac'),
      'Audible The Waste Land-20260903-140509.json'
    );
  });

  await check('the save location is the user\'s, and ~ is expanded by the SERVER', () => {
    const home = os.homedir();
    assert.strictEqual(DEFAULT_RECORDINGS_DIR, '~/Downloads', 'the default must be Downloads');
    assert.strictEqual(expandHome('~', '/Users/x'), '/Users/x');
    assert.strictEqual(expandHome('~/Books', '/Users/x'), '/Users/x/Books');
    // Windows: the same rule, the same function, a backslash separator.
    assert.strictEqual(expandHome('~\\Books', 'C:\\Users\\x'), 'C:\\Users\\x\\Books');
    assert.strictEqual(expandHome('/tmp/books', '/Users/x'), '/tmp/books', 'no ~ means no rewriting');
    assert.strictEqual(expandHome('~notme/x', '/Users/x'), '~notme/x',
      "another user's home must not be guessed at");

    // Resolution, against the real home directory.
    assert.strictEqual(resolveRecordingDir(), path.join(home, 'Downloads'), 'no setting = Downloads');
    assert.strictEqual(resolveRecordingDir(''), path.join(home, 'Downloads'), 'blank = the default');
    assert.strictEqual(resolveRecordingDir('~/Books'), path.join(home, 'Books'));
    assert.strictEqual(resolveRecordingDir(ROOT), ROOT, 'an absolute path passes through');
  });

  await check('a relative save location is refused by name', () => {
    for (const bad of ['recordings', './out', '../up', '~notme/x']) {
      assert.throws(
        () => resolveRecordingDir(bad),
        /is not an absolute folder/,
        `'${bad}' should have been refused — it would resolve against the launch directory`
      );
    }
    let message = '';
    try { resolveRecordingDir('recordings'); } catch (err) { message = err.message; }
    assert.ok(message.includes("Save recordings to"),
      'the refusal must name the setting the user has to fix');
  });

  await check('an unfinished recording can never be mistaken for a finished one', () => {
    const partial = partialFileName('A Book-20260903-140509.flac');
    assert.ok(partial.startsWith('.'), 'the partial must be a dotfile');
    assert.ok(partial.endsWith('.partial.flac'), 'the partial must carry the .partial suffix');
    assert.ok(isPartialFileName(partial), 'the sweep must recognise its own naming');
    assert.ok(!isPartialFileName('A Book-20260903-140509.flac'), 'a finished file is NOT a partial');
    assert.ok(!isPartialFileName('.hidden.flac'), 'any old dotfile is not a partial');
  });

  // ── the session state machine ─────────────────────────────────────────────

  await check('a live recording is a hidden partial, and only stop makes it a .flac', async () => {
    const dir = path.join(ROOT, 'run-stop');
    const events = [];
    const session = new TabRecordingSession(
      { recordId: 'r1', title: 'A Book', sampleRate: 48000, channels: 2, sourceUrl: 'https://example/x' },
      { dir, now: () => FIXED, encoder: fileEncoder(events) }
    );
    assert.strictEqual(session.getState(), 'starting');
    await session.start();
    assert.strictEqual(session.getState(), 'recording');
    assert.deepStrictEqual(events[0].slice(1), [48000, 2, session.partialPath],
      'ffmpeg must be described the INPUT rate/channels and write the partial file');
    assert.strictEqual(path.dirname(session.partialPath), path.dirname(session.finalPath),
      "the partial MUST share the final file's directory or the rename can throw EXDEV");

    session.write(pcm(48000 * 2 * 4)); // one second
    session.mark('Chapter 2', 0.5);
    assert.ok(fs.existsSync(session.partialPath), 'the live recording is not in its partial file');
    assert.ok(isPartialFileName(path.basename(session.partialPath)), 'the partial is misnamed');
    assert.ok(!fs.existsSync(session.finalPath), 'an unfinished recording must NOT exist as a .flac');
    assert.ok(Math.abs(session.getSeconds() - 1) < 1e-9, 'seconds must come from the byte count');

    const result = await session.stop();
    assert.strictEqual(session.getState(), 'done');
    assert.strictEqual(result.path, session.finalPath);
    assert.ok(!fs.existsSync(session.partialPath), 'the partial file survived the rename');
    assert.strictEqual(fs.statSync(session.finalPath).size, 48000 * 2 * 4, 'the audio did not land intact');
    assert.strictEqual(path.basename(session.finalPath), 'A Book-20260903-140509.flac');

    const sidecar = JSON.parse(fs.readFileSync(session.finalPath.replace(/\.flac$/, '.json'), 'utf-8'));
    assert.strictEqual(sidecar.title, 'A Book');
    assert.strictEqual(sidecar.sourceUrl, 'https://example/x');
    assert.strictEqual(sidecar.sampleRate, 48000);
    assert.strictEqual(sidecar.captureSampleRate, 48000);
    assert.strictEqual(sidecar.speed, 1);
    assert.strictEqual(sidecar.channels, 2);
    assert.deepStrictEqual(sidecar.marks, [{ label: 'Chapter 2', seconds: 0.5 }]);
    assert.ok(Math.abs(sidecar.seconds - 1) < 1e-9);
  });

  await check('a 2x capture is written at half the rate, and clocks in BOOK seconds', async () => {
    const dir = path.join(ROOT, 'run-speed');
    const events = [];
    const session = new TabRecordingSession(
      { recordId: 'fast', title: 'Fast Book', sampleRate: 48000, channels: 2, speed: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder(events) }
    );
    await session.start();
    assert.strictEqual(session.sampleRate, 24000, 'the FILE must be labelled capture / speed');
    assert.strictEqual(session.captureSampleRate, 48000, 'the capture rate must be remembered');
    assert.strictEqual(events[0][1], 24000, "ffmpeg's INPUT -ar must be the relabelled rate");

    // 10 wall-seconds of 48 kHz stereo capture.
    session.write(pcm(48000 * 2 * 4 * 10));
    assert.ok(Math.abs(session.getSeconds() - 20) < 1e-9, 'book time must be wall time x speed');
    assert.ok(Math.abs(session.getWallSeconds() - 10) < 1e-9, 'wall time must be the capture clock');

    const result = await session.stop();
    // The samples are UNTOUCHED — only the label changed.
    assert.strictEqual(fs.statSync(result.path).size, 48000 * 2 * 4 * 10,
      'relabelling must not resample: every byte captured must be in the file');
    const sidecar = JSON.parse(fs.readFileSync(result.path.replace(/\.flac$/, '.json'), 'utf-8'));
    assert.strictEqual(sidecar.sampleRate, 24000, "the sidecar's sampleRate is the FILE's rate");
    assert.strictEqual(sidecar.captureSampleRate, 48000);
    assert.strictEqual(sidecar.speed, 2);
    assert.ok(Math.abs(sidecar.seconds - 20) < 1e-9, 'the sidecar must record book seconds');
  });

  await check('a speed that cannot be relabelled to a whole rate is refused up front', () => {
    const dir = path.join(ROOT, 'run-speed-bad');
    assert.throws(
      () => new TabRecordingSession(
        { recordId: 'x', title: 't', sampleRate: 48000, channels: 2, speed: 7 },
        { dir }
      ),
      /does not divide/,
      'the refusal must happen in the constructor, before anything is opened'
    );
    assert.throws(
      () => new TabRecordingSession(
        { recordId: 'x', title: 't', sampleRate: 48000, channels: 2, speed: 0.5 },
        { dir }
      ),
      /implausible speed/
    );
  });

  await check('cancel kills the encoder and leaves nothing behind', async () => {
    const dir = path.join(ROOT, 'run-cancel');
    const events = [];
    const session = new TabRecordingSession(
      { recordId: 'r2', title: 'Discarded', sampleRate: 44100, channels: 1 },
      { dir, now: () => FIXED, encoder: fileEncoder(events) }
    );
    await session.start();
    session.write(pcm(4410 * 4));
    await session.cancel();
    assert.strictEqual(session.getState(), 'cancelled');
    assert.ok(events.some((e) => e[0] === 'kill'), 'the encoder was not killed');
    assert.ok(!fs.existsSync(session.partialPath), 'the partial file survived a cancel');
    assert.ok(!fs.existsSync(session.finalPath), 'a cancelled recording must not exist');
    assert.ok(!fs.existsSync(session.finalPath.replace(/\.flac$/, '.json')), 'a cancelled recording wrote a sidecar');
  });

  await check('PCM outside the recording state is refused by name', async () => {
    const dir = path.join(ROOT, 'run-order');
    const session = new TabRecordingSession(
      { recordId: 'r3', title: 'Order', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder() }
    );
    assert.throws(() => session.write(pcm(16)), /while starting/,
      'a frame before record.started must be an error');
    await session.start();
    session.write(pcm(16));
    await session.stop();
    assert.throws(() => session.write(pcm(16)), /while done/,
      'a frame after the file is closed must be an error');
    await session.cancel(); // a terminal session absorbs a late cancel quietly
    assert.strictEqual(session.getState(), 'done', 'cancel must not un-finish a finished recording');
    assert.ok(fs.existsSync(session.finalPath), 'a late cancel deleted a saved recording');
  });

  await check('a recording that never started does not hold the slot', async () => {
    const recorder = new TabRecorder();
    await assert.rejects(
      () => recorder.start(
        { recordId: 'bad', title: 'No ffmpeg', sampleRate: 48000, channels: 2 },
        { dir: path.join(ROOT, 'run-noffmpeg'), now: () => FIXED, encoder: missingEncoder() }
      ),
      /ffmpeg not found/,
      'the encoder failure must surface by name'
    );
    assert.strictEqual(recorder.isRecording(), false, 'a failed start left the recorder busy forever');
    // …and the slot really is free.
    const ok = await recorder.start(
      { recordId: 'good', title: 'Second try', sampleRate: 48000, channels: 2 },
      { dir: path.join(ROOT, 'run-noffmpeg'), now: () => FIXED, encoder: fileEncoder() }
    );
    assert.strictEqual(ok.recordId, 'good');
    await recorder.cancel('good');
  });

  await check('a second record.start while one is live is refused by name', async () => {
    const recorder = new TabRecorder();
    const dir = path.join(ROOT, 'run-busy');
    await recorder.start(
      { recordId: 'first', title: 'First', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder() }
    );
    await assert.rejects(
      () => recorder.start(
        { recordId: 'second', title: 'Second', sampleRate: 48000, channels: 2 },
        { dir, now: () => FIXED, encoder: fileEncoder() }
      ),
      /Another recording is in progress/,
      'the second start must be refused, and the refusal must name itself'
    );
    assert.ok(/First-20260903/.test(recorder.busyMessage()), 'the refusal should name the live file');
    // The first recording is untouched by the refusal.
    assert.strictEqual(recorder.active.recordId, 'first');
    const done = await recorder.stop('first');
    assert.ok(fs.existsSync(done.path));
    assert.strictEqual(recorder.isRecording(), false, 'stop must free the slot');
  });

  await check('stop/cancel for a recordId that is not the live one is refused', async () => {
    const recorder = new TabRecorder();
    const dir = path.join(ROOT, 'run-ids');
    await assert.rejects(() => recorder.stop('nobody'), /no recording is in progress/);
    await recorder.start(
      { recordId: 'mine', title: 'Mine', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder() }
    );
    await assert.rejects(() => recorder.stop('theirs'), /does not name the live recording/);
    await assert.rejects(() => recorder.cancel('theirs'), /does not name the live recording/);
    assert.strictEqual(recorder.isRecording(), true, 'a mismatched id must not end the recording');
    await recorder.cancel('mine');
  });

  await check('the client vanishing finalizes exactly as stop does', async () => {
    const recorder = new TabRecorder();
    const dir = path.join(ROOT, 'run-close');
    const session = await recorder.start(
      { recordId: 'dropped', title: 'Dropped Socket', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder() }
    );
    recorder.write(pcm(48000 * 2 * 4 * 2)); // two seconds
    const result = await recorder.finalizeOrphan('client disconnected');
    assert.ok(result, 'a dropped socket must finalize, not discard');
    assert.strictEqual(result.path, session.finalPath);
    assert.ok(Math.abs(result.seconds - 2) < 1e-9, 'the file must be complete up to the last frame');
    assert.ok(fs.existsSync(session.finalPath), 'the recording never reached recordings/');
    assert.ok(!fs.existsSync(session.partialPath), 'an orphan partial was left behind');
    assert.strictEqual(recorder.isRecording(), false);
    assert.strictEqual(await recorder.finalizeOrphan('again'), null, 'finalizing twice must be a no-op');
  });

  await check('progress is reported about once a second, from the byte count', async () => {
    const recorder = new TabRecorder();
    const seen = [];
    const dir = path.join(ROOT, 'run-progress');
    await recorder.start(
      { recordId: 'tick', title: 'Ticking', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder(), onProgress: (p) => seen.push(p) }
    );
    recorder.write(pcm(48000 * 2 * 4 * 3)); // three seconds of audio
    await new Promise((r) => setTimeout(r, RECORDER.PROGRESS_INTERVAL_MS + 200));
    await recorder.stop('tick');
    assert.ok(seen.length >= 1, 'no progress event arrived within a second');
    assert.strictEqual(seen[0].recordId, 'tick');
    assert.ok(Math.abs(seen[0].seconds - 3) < 1e-9, 'progress seconds must come from the bytes written');
    const after = seen.length;
    await new Promise((r) => setTimeout(r, RECORDER.PROGRESS_INTERVAL_MS + 200));
    assert.strictEqual(seen.length, after, 'progress kept ticking after the recording stopped');
  });

  await check('an implausible stream description is refused before a file is opened', () => {
    const dir = path.join(ROOT, 'run-bad');
    assert.throws(
      () => new TabRecordingSession({ recordId: 'x', title: 't', sampleRate: NaN, channels: 2 }, { dir }),
      /implausible sampleRate/
    );
    assert.throws(
      () => new TabRecordingSession({ recordId: 'x', title: 't', sampleRate: 48000, channels: 0 }, { dir }),
      /implausible channel count/
    );
    assert.throws(
      () => new TabRecordingSession({ recordId: '', title: 't', sampleRate: 48000, channels: 2 }, { dir }),
      /requires a recordId/
    );
  });

  await check('the sweep clears partials in every folder used, and only those', async () => {
    // The folder list is machine-local; point it at the temp tree so the test
    // never touches the user's real one.
    const store = path.join(ROOT, 'tab-recordings.json');
    setRecordingDirsStore(store);

    const used = path.join(ROOT, 'sweep-used');
    const gone = path.join(ROOT, 'sweep-gone');
    fs.mkdirSync(used, { recursive: true });
    fs.writeFileSync(store, JSON.stringify({ dirs: [used, gone] }));

    const orphan = path.join(used, partialFileName('Half a Book-20260903-140509.flac'));
    const keeper = path.join(used, 'Whole Book-20260903-140509.flac');
    const sidecar = path.join(used, 'Whole Book-20260903-140509.json');
    fs.writeFileSync(orphan, 'partial');
    fs.writeFileSync(keeper, 'finished');
    fs.writeFileSync(sidecar, '{}');

    const swept = await sweepPartialRecordings();
    assert.deepStrictEqual(swept, [orphan], 'exactly the orphan should have been swept');
    assert.ok(!fs.existsSync(orphan), 'the orphan is still on disk');
    assert.ok(fs.existsSync(keeper), 'the sweep deleted a FINISHED recording');
    assert.ok(fs.existsSync(sidecar), 'the sweep deleted a sidecar');
    // A folder the user has since moved or deleted is skipped, not an error.
    assert.ok(!fs.existsSync(gone));
  });

  await check('recording into a folder remembers it for the next sweep', async () => {
    const store = path.join(ROOT, 'remember.json');
    setRecordingDirsStore(store);
    const dir = path.join(ROOT, 'remembered', 'nested');
    const recorder = new TabRecorder();
    await recorder.start(
      { recordId: 'mem', title: 'Remembered', sampleRate: 48000, channels: 2 },
      { dir, now: () => FIXED, encoder: fileEncoder() }
    );
    assert.ok(fs.existsSync(dir), 'the output folder must be created if missing (mkdir -p)');
    await recorder.stop('mem');
    const remembered = JSON.parse(fs.readFileSync(store, 'utf-8')).dirs;
    assert.deepStrictEqual(remembered, [dir], 'the folder was not remembered for the sweep');
    setRecordingDirsStore(path.join(ROOT, 'unused.json'));
  });

  // ── report ────────────────────────────────────────────────────────────────
  for (const [status, name, message] of results) {
    console.log(`${status === 'ok' ? '  ok  ' : ' FAIL '} ${name}${message ? `\n        ${message}` : ''}`);
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\n${results.length - failures}/${results.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
})();
