#!/usr/bin/env node
/**
 * FOUR DOORS OF THE NARRATION BRIDGE THAT EACH TURNED A NON-EVENT INTO A LOSS.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-bridge-quit-and-owner.js
 *
 * Every check below is one finding from the 2026-09-20 bug hunt (§C, §D), and
 * every one of them is the same shape: a door that could not tell two different
 * facts apart, and answered with the destructive one.
 *
 *  **C5 — the packing check measured a number no refusal uses.** Prep packs a
 *  book to ONE server's band and the render may be admitted to another. The
 *  check compared the packed ceiling against the render server's SAFE CEILING
 *  and hard-failed a mismatch — after the venue was chosen and the GPU slot
 *  taken — on the strength of a reason retired the day before
 *  (`chunk_too_long`, gone from both Crucible doors 2026-09-19). The only
 *  refusal left is this app's own `refuseChunksOverVenueCap`, which measures the
 *  **cap**. So: over the cap refuses, inside the cap but over the ceiling is a
 *  NOTE, and a book that would have rendered fine is no longer killed for it.
 *
 *  **C5, second half — a held card read as a failed book.** The band read that
 *  answers that question is a live `GET /v1/voices`, and its `catch` flattened
 *  EVERY throw — a `409 server_busy` from a holder included — into
 *  `emitJobFailure`. A wait became a red row in *Needs you* over a card somebody
 *  else was merely using. A refusal carrying a holder's line, or Contract 1's
 *  `transient`, now propagates so the step seam parks the row.
 *
 *  **C9 — quit's remote cancels were serial.** Each is bounded at 10 s, and
 *  they were awaited one at a time inside the teardown loop, so three sessions
 *  cost 30 s of the quit step's whole 60 s budget before the WSL teardown and
 *  the cache flush got any. They are independent DELETEs; N of them cost one
 *  grace.
 *
 *  **P3 — an unreadable ownership sidecar read as "ours".** `readSessionOwner`
 *  had a bare `catch { return null; }`, which collapsed "no sidecar", "not
 *  JSON" and "the share would not answer" into one; `foreignSessionHost` mapped
 *  all three to sweepable. `scratch-sweep.ts` says of that probe *"Not wrapped
 *  in a try, and that is the point"* — the try was one frame down. One EIO at
 *  startup and the OTHER machine's live render is a leftover, which is the
 *  measured 2026-09-05 loss re-armed by an I/O blip.
 *
 * No GPU, no model, no server: the pure rules are driven directly, the cancel
 * handles are promises that never settle, and the unreadable sidecar is a real
 * filesystem refusal (a directory where a file is expected → EISDIR) rather
 * than a stubbed `fs`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
if (!fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'))) {
  console.error(
    'dist/electron/data/rvc-voice-assets.json is missing — this suite loads the whole bridge, '
    + 'which reads it at import.\n'
    + '  npx tsc -p tsconfig.electron.json && /bin/cp -R electron/data dist/electron/');
  process.exitCode = 1;
  return;
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bridge-quit-owner-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });
process.env.BOOKFORGE_USER_DATA = USER_DATA;      // cli/electron-stub.js honours this
process.env.BOOKFORGE_USERDATA_DIR = USER_DATA;   // managed-bins resolves its root at import
require(path.join(REPO, 'cli', 'electron-stub.js'));

const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));
const scratchSweep = require(path.join(DIST, 'scratch-sweep.js'));
const stepVenue = require(path.join(DIST, 'crucible', 'step-venue.js'));
const waitFor = require(path.join(DIST, '..', 'shared', 'queue', 'wait-for.js'));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
    process.exitCode = 1;
  }
}
const now = () => Number(process.hrtime.bigint() / 1000000n);

/** The bridge's own source, for the shape checks a value cannot make. */
const BRIDGE_TS = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
const TTS_STEP_TS = fs.readFileSync(
  path.join(REPO, 'electron', 'queue-steps', 'tts-conversion.ts'), 'utf8');

(async () => {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('1. C5 — the cap refuses, the ceiling only notes');
  // ───────────────────────────────────────────────────────────────────────────

  /*
   * The live scenario, 2026-09-19: an `any` row packed to the tightest enabled
   * server (ceiling 700) and admitted to another whose ceiling is 650 and whose
   * cap is 800. Every chunk is inside that cap; the render would have been fine.
   */
  await check('packed 700, venue ceiling 650 / cap 800 → a NOTE, not a refusal', () => {
    const verdict = bridge.packingVerdictFor(
      { server: 'crucible-a', ceilingChars: 700 },
      { server: 'crucible-b', maxChars: 800, ceilingChars: 650 },
    );
    assert.strictEqual(verdict.kind, 'note',
      `a book inside the venue's cap must render; got ${verdict.kind}: ${
        verdict.reason || verdict.note || ''}`);
    // BOTH numbers, because a note nobody can check against the book is not a
    // note — it is a line of noise in a log.
    assert.ok(verdict.note.includes('700') && verdict.note.includes('650'),
      `the note must name both ceilings; got: ${verdict.note}`);
    assert.ok(verdict.note.includes('800'), 'and the cap it is inside of');
  });

  await check('packed 900, venue cap 800 → refused, before the render is submitted', () => {
    const verdict = bridge.packingVerdictFor(
      { server: 'crucible-a', ceilingChars: 900 },
      { server: 'crucible-b', maxChars: 800, ceilingChars: 800 },
    );
    assert.strictEqual(verdict.kind, 'refused',
      'chunks over the venue cap are what `refuseChunksOverVenueCap` throws on, chunk by chunk, '
      + 'after the book has crossed the wire');
    assert.ok(/crucible_packing_over_venue_cap/.test(verdict.reason),
      `the refusal must be named; got: ${verdict.reason}`);
    assert.ok(verdict.reason.includes('900') && verdict.reason.includes('800'),
      'and name both numbers');
  });

  await check('the ordinary case — a roomier venue — travels silently', () => {
    assert.strictEqual(
      bridge.packingVerdictFor(
        { server: 'crucible-a', ceilingChars: 650 },
        { server: 'crucible-b', maxChars: 800, ceilingChars: 700 },
      ).kind,
      'travels');
  });

  await check('the door reads the venue CAP, not its safe ceiling', () => {
    const at = BRIDGE_TS.indexOf('async function packingRefusalFor(');
    assert.ok(at > 0, 'packingRefusalFor is gone — has the door moved?');
    const body = BRIDGE_TS.slice(at, at + 1400);
    assert.ok(/maxChars: band\.maxChars/.test(body),
      'the venue\'s cap must reach the rule: it is the only number any refusal still measures '
      + '(chunk_too_long was retired on both Crucible doors 2026-09-19)');
    assert.ok(!/packingTravelsTo\(packed\.ceilingChars, band\.ceilingChars\)/.test(body),
      'the retired safe-ceiling comparison is back');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('2. C5 second half — a held card is a wait, not a failed book');
  // ───────────────────────────────────────────────────────────────────────────

  await check('a refusal carrying a holder\'s busyLine is a wait', async () => {
    assert.strictEqual(
      await bridge.refusalIsAWait(Object.assign(new Error('409'), {
        busyLine: 'GPU busy: foundry, tts 62% done',
      })),
      true);
  });

  await check('the SDK\'s other spelling — leasedLine — is a wait too', async () => {
    assert.strictEqual(
      await bridge.refusalIsAWait(Object.assign(new Error('409'), {
        leasedLine: 'leased: foundry, translate, until 04:12',
      })),
      true, 'a held MODEL arrives as leasedLine; runtime.ts\'s busyLineOf reads both');
  });

  await check('Contract 1\'s transient flag is a wait', async () => {
    assert.strictEqual(
      await bridge.refusalIsAWait(Object.assign(new Error('read ECONNRESET'), {
        transient: true,
      })),
      true);
  });

  await check('an ordinary failure is NOT a wait', async () => {
    assert.strictEqual(await bridge.refusalIsAWait(new Error('the voice is not on that server')),
      false, 'parking a row on a real misconfiguration is a book that never finishes');
    assert.strictEqual(await bridge.refusalIsAWait(null), false);
    assert.strictEqual(await bridge.refusalIsAWait('a string'), false);
    assert.strictEqual(await bridge.refusalIsAWait({ busyLine: '' }), false,
      'an empty line would park the row on a blank sentence, which reads as a stall with no cause');
  });

  await check('the band read\'s catch re-throws a wait instead of flattening it', () => {
    const at = BRIDGE_TS.indexOf('const refusal = await packingRefusalFor(');
    assert.ok(at > 0, 'the packing check is gone from startParallelConversion');
    const tail = BRIDGE_TS.slice(at, at + 2600);
    const rethrow = tail.indexOf('if (await refusalIsAWait(err))');
    const flatten = tail.indexOf('emitJobFailure(jobId, error)', tail.indexOf('} catch (err) {'));
    assert.ok(rethrow > 0, 'the catch no longer asks whether the throw was a wait');
    assert.ok(rethrow < flatten,
      'the wait must be answered BEFORE the failure path: a 409 read as a failure is finding C1 '
      + 'again, at the moment the venue has just been chosen');
    assert.ok(/stopPowerBlock\(\);\s*\n\s*throw err;/.test(tail),
      'the sleep block taken at the top of the door must be given back before the re-throw');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('3. C6 — the render step reads its venue through the one reader');
  // ───────────────────────────────────────────────────────────────────────────

  await check('runVenueOfRow refuses a RETIRED_LOCAL_NARRATOR_VENUE row by name', () => {
    let thrown = null;
    try {
      stepVenue.runVenueOfRow(waitFor.RETIRED_LOCAL_NARRATOR_VENUE);
    } catch (err) { thrown = err; }
    assert.ok(thrown, 'an old row admitted to the deleted local narrator must be refused, not '
      + 'silently re-decided onto a card §4.3 says it may not finish on');
    assert.strictEqual(thrown.code, 'legacy_venue_retired',
      `the refusal must be named; got ${thrown.code}: ${thrown.message}`);
  });

  await check('runVenueOfRow answers a named server and "any" differently', () => {
    assert.deepStrictEqual(stepVenue.runVenueOfRow('crucible-a'),
      { where: 'crucible', server: 'crucible-a' });
    assert.strictEqual(stepVenue.runVenueOfRow(waitFor.WAIT_FOR_ANY), undefined,
      '"any" is the row saying it does not mind — not a venue');
    assert.strictEqual(stepVenue.runVenueOfRow(undefined), undefined);
  });

  await check('tts-conversion routes waitForResolved through it, like align.ts', () => {
    assert.ok(/import \{ runVenueOfRow \} from '\.\.\/crucible\/step-venue'/.test(TTS_STEP_TS),
      'the render step must use the ONE reader of waitForResolved\'s three shapes');
    assert.ok(/const runVenue = runVenueOfRow\(ctx\.job\.waitForResolved\)/.test(TTS_STEP_TS),
      'the row\'s field must go through the reader, not into settings raw');
    assert.ok(
      /\.\.\.\(runVenue === undefined \? \{\} : \{ crucible: \{ server: runVenue\.server \} \}\)/
        .test(TTS_STEP_TS),
      'and be spread exactly as align.ts spreads it — never sent as undefined');
    assert.ok(!/const crucibleServer = venue === undefined/.test(TTS_STEP_TS),
      'the raw inline conversion is back');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('4. C9 — quit cancels every remote render at once');
  // ───────────────────────────────────────────────────────────────────────────

  await check('three servers that never answer cost ONE grace, not three', async () => {
    const graceMs = 200;
    const sessions = [1, 2, 3].map((n) => ({
      jobId: `bf-job-${n}`,
      crucibleJobId: `job-${n}`,
      // The measured case (2026-09-15): the DELETE is recorded `cancelling` and
      // nothing on the server acts on it, so the terminal frame never arrives.
      crucibleCancel: () => new Promise(() => {}),
    }));
    const started = now();
    await bridge.cancelAllRemoteRendersOnQuit(sessions, graceMs);
    const waited = now() - started;
    assert.ok(waited < graceMs * 2,
      `three independent DELETEs took ${waited} ms against a ${graceMs} ms grace — they are being `
      + 'awaited one at a time, which is 30 s of the quit step\'s 60 s budget on a real machine');
    assert.ok(waited >= graceMs - 50,
      `the grace must still be honoured per session; the sweep returned in ${waited} ms`);
  });

  await check('every session\'s handle is called, and a thrown one cannot stop the rest', async () => {
    const called = [];
    await bridge.cancelAllRemoteRendersOnQuit([
      { jobId: 'a', crucibleJobId: 'j1', crucibleCancel: async () => { called.push('a'); } },
      // Synchronously throwing is exactly the handle whose server is already gone.
      { jobId: 'b', crucibleJobId: 'j2', crucibleCancel: () => { called.push('b'); throw new Error('gone'); } },
      { jobId: 'c', crucibleJobId: 'j3', crucibleCancel: async () => { called.push('c'); } },
      { jobId: 'd' },
    ], 200);
    assert.deepStrictEqual(called.sort(), ['a', 'b', 'c'],
      'a quit must reach every server it can');
  });

  await check('killAllWorkers goes through that door, once, before the process teardown', () => {
    const at = BRIDGE_TS.indexOf('export async function killAllWorkers');
    const body = BRIDGE_TS.slice(at, at + 2500);
    assert.ok(/await cancelAllRemoteRendersOnQuit\(activeSessions\.values\(\)\)/.test(body),
      'a Crucible render is not a process: without this call the job renders the rest of the book '
      + 'holding that server\'s lane, claim and voice');
    assert.ok(body.indexOf('cancelAllRemoteRendersOnQuit') < body.indexOf('for (const [jobId, session]'),
      'the cancels must be hoisted OUT of the per-session loop — that loop is what made them serial');
  });

  await check('the docstring points at the in-flight ledger, not at "nothing persists the id"', () => {
    const at = BRIDGE_TS.indexOf('export async function cancelRemoteRenderOnQuit');
    const doc = BRIDGE_TS.slice(BRIDGE_TS.lastIndexOf('/**', at), at);
    assert.ok(/in-flight-ledger\.ts/.test(doc),
      'the ledger has recorded every submitted job id against its server since 2026-09-19, and '
      + 'the startup sweep DELETEs what a hard kill left — a docstring that denies the other door '
      + 'exists is how the next person re-derives it');
    assert.ok(!/relaunch cannot DELETE it/.test(doc), 'the stale sentence is back');
    assert.ok(fs.existsSync(path.join(REPO, 'electron', 'crucible', 'in-flight-ledger.ts')),
      'the docstring now names a module that must exist');
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('5. P3 — an unreadable ownership sidecar is foreign, never swept');
  // ───────────────────────────────────────────────────────────────────────────

  const SCRATCH = path.join(WORK, 'scratch');
  fs.mkdirSync(SCRATCH, { recursive: true });

  /** A scratch session dir with whatever sidecar the case needs. */
  function session(name, sidecar) {
    const dir = path.join(SCRATCH, `ebook-${name}`);
    fs.mkdirSync(path.join(dir, 'chapters', 'sentences'), { recursive: true });
    const file = path.join(dir, 'bookforge-session.json');
    if (sidecar === 'unreadable') {
      // A DIRECTORY where a file is expected: a real errno from the real
      // filesystem (EISDIR), which is what an EIO/ESTALE on the SMB mount the
      // library lives on looks like to this door — a read that did not answer.
      fs.mkdirSync(file, { recursive: true });
    } else if (sidecar === 'malformed') {
      fs.writeFileSync(file, '{"jobId": "half-writ');
    } else if (sidecar !== 'absent') {
      fs.writeFileSync(file, JSON.stringify(sidecar));
    }
    return dir;
  }

  const OURS = session('ours', { jobId: 'j-ours', language: 'en', host: os.hostname() });
  const THEIRS = session('theirs', { jobId: 'j-theirs', language: 'en', host: 'the-other-machine' });
  const BLIND = session('blind', 'unreadable');
  const NONE = session('none', 'absent');
  const HALF = session('half', 'malformed');

  await check('readSessionOwner answers three kinds, and they are not the same fact', async () => {
    assert.strictEqual((await bridge.readSessionOwner(OURS)).kind, 'owner');
    assert.strictEqual((await bridge.readSessionOwner(NONE)).kind, 'absent',
      'no sidecar is an answer the filesystem gave');
    assert.strictEqual((await bridge.readSessionOwner(HALF)).kind, 'absent',
      'read fine, not JSON: there is no owner in it and never will be');
    const blind = await bridge.readSessionOwner(BLIND);
    assert.strictEqual(blind.kind, 'unreadable',
      'the read FAILED — that is a doubt, not an absence, and the old bare catch erased it');
    assert.ok(typeof blind.error === 'string' && blind.error.length > 0,
      'the errno must survive to the log line');
  });

  await check('foreignSessionHost calls an unreadable sidecar FOREIGN', async () => {
    assert.strictEqual(await bridge.foreignSessionHost(OURS), null);
    assert.strictEqual(await bridge.foreignSessionHost(NONE), null,
      'a pre-sidecar session has always been a leftover');
    assert.strictEqual(await bridge.foreignSessionHost(THEIRS), 'the-other-machine');
    const blind = await bridge.foreignSessionHost(BLIND);
    assert.ok(typeof blind === 'string' && blind.length > 0,
      '"I could not tell whose it is" must not answer "mine": the two outcomes are keeping a '
      + 'leftover one more launch and deleting a live render somebody is eight minutes into');
    assert.ok(/could not be read/.test(blind),
      `the reason must reach scratch-sweep's own log line; got: ${blind}`);
  });

  await check('the sweep therefore does NOT remove it', async () => {
    const plan = await scratchSweep.planScratchSweepOf(
      SCRATCH, new Set(), bridge.foreignSessionHost);
    assert.ok(plan, 'the scratch root exists, so there must be a plan');
    assert.ok(!plan.remove.includes('ebook-blind'),
      'a session whose ownership could not be established was swept — this is the 2026-09-05 loss '
      + 'armed by an I/O error');
    assert.ok(!plan.remove.includes('ebook-theirs'), 'and neither is the other machine\'s');
    assert.ok(plan.keptForeign.some((k) => k.name === 'ebook-blind'),
      'it must be KEPT by name, with the doubt as its reason');
    assert.ok(plan.remove.includes('ebook-ours') && plan.remove.includes('ebook-none'),
      'ours and the pre-sidecar leftover are still swept — the fix must not turn the sweep off');
  });

  await check('the rescue pass logs the unreadable sidecar by path and leaves it', async () => {
    const at = BRIDGE_TS.indexOf('export async function rescueOrphanedScratchSessions');
    const body = BRIDGE_TS.slice(at, at + 3000);
    assert.ok(/read\.kind === 'unreadable'/.test(body),
      'the rescue must ask the same three-valued read');
    assert.ok(/sidecar: path\.join\(sessionDir, SESSION_OWNER_FILE\)/.test(body),
      'BY PATH: this is the one line that tells an operator why a scratch dir is still there at '
      + 'the next launch');
    // And it really does leave the directory alone.
    const before = fs.readdirSync(BLIND).sort();
    await bridge.rescueOrphanedScratchSessions(SCRATCH);
    assert.deepStrictEqual(fs.readdirSync(BLIND).sort(), before,
      'the rescue touched a session it could not establish ownership of');
  });

  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch { /* a temp dir that will not go is not a test failure */ }

  console.log(`\nbridge-quit-and-owner: ${passed} check(s) passed`
    + (failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''));
})().catch((err) => {
  console.error('bridge-quit-and-owner: the suite itself failed:', err);
  process.exitCode = 1;
});
