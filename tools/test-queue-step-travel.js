#!/usr/bin/env node
/**
 * EVERY GPU STEP TRAVELS WITH ITS BOOK — `machines()` on each, and the run's
 * venue followed rather than re-decided.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-step-travel.js
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE7-LANES.md` §4.4: *"every step of one book runs on the
 * machine the book was assigned."* Until 2026-09-14 only `tts-conversion` and
 * `foundry-job` declared `machines()`, so a book rendered on the Mac did its
 * RVC, its hiss pass, its alignment and its page reads HERE. That is not a
 * theoretical split: at 00:50 on 2026-09-14 a post-render alignment decided its
 * own venue, read the top-ranked server and loaded the aligner on a card a
 * fine-tune owned.
 *
 * ── What is worth defending ────────────────────────────────────────────────
 *
 *  1. EVERY GPU STEP DECLARES `machines()`. A step that has not been taught to
 *     travel does not travel, and §4's safety default means the omission is
 *     SILENT — the row simply keeps running here while its book is elsewhere.
 *     So the declaration is pinned per type, not left to a reader to notice.
 *  2. THE ANSWER IS THE CONFIG'S WHERE THE CONFIG DECIDES. `epub-align` reads
 *     this machine's EPUB and has no Crucible job type; a pass against Claude
 *     has no card anywhere. Declaring `any` for either would occupy a slot on a
 *     machine nothing was submitted to.
 *  3. ALIGN REFUSES BY NAME WHEN IT IS SENT TO A SERVER, before anything is
 *     submitted. A remote alignment cannot finish — narrator has no items-in
 *     door — so submitting first would load a 3 GB aligner on somebody's card,
 *     run it, and then refuse. "Maybe" is what crucible `docs/ARCHITECTURE.md`
 *     R3 forbids, and running here in silence is what §4.4 forbids.
 *  4. ONE READING OF `waitForResolved`. Its three shapes — a server, the legacy
 *     marker, `any`/absent — were being spelled inline in five step modules,
 *     and `any` reaching `venueForRunStep` as a venue would be a machine named
 *     "any". `runVenueOfRow` is the one owner.
 *  5. THE AI PROVIDER REFUSES BY NAME RATHER THAN GUESSING A MACHINE. A default
 *     server here is the manufactured instruction §4.2.1a exists to prevent.
 *  6. TWO RECORDS OF ONE VENUE ARE COMPARED, NEVER RANKED. A session's own
 *     record and the row's answer are the same fact with two owners
 *     (`docs/ARCHITECTURE.md` R1).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-steps', 'align.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// The step modules reach bridges that reach Electron, so the stub goes in first
// — exactly as every other suite that loads a queue step does.
const { installElectronStub, makeChecker } = require('./fake-crucible.js');
installElectronStub('bf-step-travel-');

const stepVenue = require(path.join(DIST, 'crucible', 'step-venue.js'));
const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));
const aiProvider = require(path.join(DIST, 'queue-steps', 'ai-provider.js'));
const crucibleAlign = require(path.join(DIST, 'crucible', 'align.js'));

const { check, summary } = makeChecker();

/**
 * Every GPU step module, loaded through its own file.
 *
 * Read from the modules rather than from `registerAllStepModules` so a type
 * that is registered twice, or renamed, cannot make a missing declaration look
 * present.
 */
const STEPS = {
  'tts-conversion': () => require(path.join(DIST, 'queue-steps', 'tts-conversion.js')).ttsConversionStep,
  align: () => require(path.join(DIST, 'queue-steps', 'align.js')).alignStep,
  'rvc-enhancement': () => require(path.join(DIST, 'queue-steps', 'rvc-enhancement.js')).rvcEnhancementStep,
  'final-denoise': () => require(path.join(DIST, 'queue-steps', 'final-denoise.js')).finalDenoiseStep,
  'vlm-convert': () => require(path.join(DIST, 'queue-steps', 'vlm-convert.js')).vlmConvertStep,
  'generate-sentences': () => require(path.join(DIST, 'queue-steps', 'generate-sentences.js')).generateSentencesStep,
  translation: () => require(path.join(DIST, 'queue-steps', 'translation.js')).translationStep,
  'book-analysis': () => require(path.join(DIST, 'queue-steps', 'book-analysis.js')).bookAnalysisStep,
};

(async () => {
  // ── 1. Every GPU step declares it ────────────────────────────────────────

  await check('every GPU step module declares machines() — the omission is silent', () => {
    const missing = [];
    for (const [type, load] of Object.entries(STEPS)) {
      const mod = load();
      assert.ok(mod, `${type} exports no step module`);
      if (typeof mod.machines !== 'function') missing.push(type);
    }
    assert.deepStrictEqual(missing, [],
      'a step with no machines() keeps running on THIS card while its book is on another '
      + 'machine — §4.4, and nothing says so at run time');
  });

  await check('video-assembly declares CPU — it is deterministic work, not inference', () => {
    /*
     * MEASURED 2026-09-15, because it had declared `gpu` with no comment since
     * before the slot sets existed and that charged it to the legacy local
     * narrator set: a video mux waited for the 3090 Ti, and a render waited
     * behind a video mux. `electron/video-assembly-bridge.ts` end to end —
     * PNG frames drawn in an OFFSCREEN BrowserWindow and read back with
     * `capturePage()`, then `ffmpeg -f concat … -c:v libx264 -preset medium
     * -crf 23 -c:a aac`. A SOFTWARE x264 encode: no NVENC, no `-hwaccel`, no
     * encoder selection, no weights, no VRAM held.
     *
     * Owen's boundary is MODEL INFERENCE vs DETERMINISTIC work, not GPU vs CPU,
     * so this belongs in `local-work` beside assembly and muxing. Pinned here
     * because the only thing standing between this step and the card is one
     * word in one module.
     */
    const mod = require(path.join(DIST, 'queue-steps', 'video-assembly.js')).videoAssemblyStep;
    assert.strictEqual(mod.resource({}), 'cpu');
    assert.strictEqual(mod.resource({ resolution: '1080p', mode: 'bilingual' }), 'cpu',
      'no config makes drawing subtitles onto frames an inference job');
    assert.strictEqual(mod.machines, undefined,
      'and a CPU step is never sent to a server (SERVER_CPU_SLOTS is 0), so the omission is '
      + 'the honest one rather than the silent one §4 warns about');
  });

  await check('the unconditional travellers say `any` whatever the config says', () => {
    for (const type of ['tts-conversion', 'align', 'rvc-enhancement', 'final-denoise', 'vlm-convert']) {
      assert.strictEqual(STEPS[type]().machines({}), 'any', type);
      assert.strictEqual(STEPS[type]().machines({ device: 'cpu' }), 'any', type);
    }
  });

  // ── 2. Where the CONFIG decides ──────────────────────────────────────────

  await check('generate-sentences travels for whisper and never for epub-align', () => {
    const mod = STEPS['generate-sentences']();
    assert.strictEqual(mod.machines({ method: 'whisper' }), 'any');
    assert.strictEqual(mod.machines({}), 'any', 'absent is the whisper default the step reads');
    assert.strictEqual(mod.machines({ method: 'epub-align' }), 'local',
      'it aligns against the project EPUB on THIS disk, and Crucible has no job type for it');
  });

  await check('an AI step travels only against a Crucible, and both read one rule', () => {
    for (const type of ['translation', 'book-analysis']) {
      const mod = STEPS[type]();
      assert.strictEqual(mod.machines({ aiProvider: 'crucible' }), 'any', type);
      for (const provider of ['ollama', 'local', 'claude', 'openai']) {
        assert.strictEqual(mod.machines({ aiProvider: provider }), 'local',
          `${type} against ${provider} has no server to be sent to`);
      }
    }
    assert.strictEqual(STEPS.translation().machines, STEPS['book-analysis']().machines,
      'ONE function, so a new provider cannot be taught to one step and forgotten by the other');
  });

  await check('an AI step leases its model only against a Crucible', () => {
    for (const type of ['translation', 'book-analysis']) {
      const mod = STEPS[type]();
      assert.strictEqual(typeof mod.leasesModel, 'function', type);
      assert.strictEqual(mod.leasesModel({ aiProvider: 'crucible' }), true, type);
      assert.strictEqual(mod.leasesModel({ aiProvider: 'ollama' }), false,
        'Ollama keeps its own VRAM through keep_alive; a lease there holds nothing');
      assert.strictEqual(mod.leasesModel({ aiProvider: 'claude' }), false,
        'a cloud provider has no card to hold');
    }
  });

  // ── 3. Align refuses by name, before any card is touched ─────────────────

  await check('align refuses a server venue BY NAME and says what is owed', async () => {
    const mod = STEPS.align();
    const ctx = {
      stepId: 's1',
      step: { config: { language: 'en', processDir: '/p' }, label: 'Align' },
      job: { waitForResolved: 'mac' },
      input: { kind: 'audio-session', sessionId: 'x', sessionDir: '/s', processDir: '/p' },
      report: () => {},
    };
    await assert.rejects(() => mod.run(ctx), (err) => {
      assert.match(err.message, /^crucible_align_narrator_door_owed: /,
        'the code leads the message, so every surface reads the same name');
      assert.match(err.message, /mac/, 'and it says which machine it was sent to');
      assert.match(err.message, /Nothing was submitted and no card was taken/,
        'the whole point is that it refuses BEFORE loading a 3 GB aligner');
      /*
       * IT USED TO OFFER THE LEGACY SWITCH as the way forward. That switch is
       * deleted (docs/LEGACY-REMOVAL.md), so the honest refusal names the BUILD
       * that is owed and says the audio is intact — a refusal must not point at
       * a control that no longer exists, which is worse than a dead row.
       */
      assert.match(err.message, /rendered audio is intact/, 'the user is told what survived');
      assert.match(err.message, /B5/, 'and which build unblocks it');
      assert.ok(!/turn on|legacy switch/i.test(err.message),
        `it still offers a switch that no longer exists: ${err.message}`);
      return true;
    });
  });

  await check('align does NOT refuse an unassigned run, and DOES refuse the retired venue',
    async () => {
    const mod = STEPS.align();
    // It gets past the venue gate and fails on something else — the session, or
    // the language — which is what proves the gate let it through.
    for (const resolved of [undefined, waitFor.WAIT_FOR_ANY]) {
      const ctx = {
        stepId: 's1',
        step: { config: {}, label: 'Align' },
        job: { ...(resolved === undefined ? {} : { waitForResolved: resolved }) },
        input: { kind: 'audio-session' },
        report: () => {},
      };
      await assert.rejects(() => mod.run(ctx), (err) => {
        assert.ok(!/crucible_align_narrator_door_owed/.test(err.message),
          `${String(resolved)} must not be read as a Crucible server`);
        return true;
      });
    }
    // The DELETED local narrator is refused by its own name rather than read as
    // a machine called "legacy-local-narrator" and refused as an unreachable one.
    await assert.rejects(
      () => mod.run({
        stepId: 's1',
        step: { config: {}, label: 'Align' },
        job: { waitForResolved: waitFor.RETIRED_LOCAL_NARRATOR_VENUE },
        input: { kind: 'audio-session' },
        report: () => {},
      }),
      /^Error: legacy_venue_retired: /,
    );
  });

  await check('the two align refusals share one code and say different things', () => {
    assert.strictEqual(crucibleAlign.CRUCIBLE_ALIGN_NARRATOR_DOOR_OWED,
      'crucible_align_narrator_door_owed');
    const before = crucibleAlign.narratorDoorOwedBeforeSubmit('mac');
    const after = crucibleAlign.narratorDoorOwedMessage('/s/alignment.json');
    assert.match(before, /Nothing was submitted/);
    assert.match(after, /alignment landed/,
      'the after-the-fact one reports banked work (R6); the before one reports none');
    assert.notStrictEqual(before, after);
  });

  // ── 4. One reading of the row's answer ───────────────────────────────────

  await check('runVenueOfRow reads all three shapes, and `any` is NOT a venue', () => {
    assert.deepStrictEqual(stepVenue.runVenueOfRow('mac'), { where: 'crucible', server: 'mac' });
    assert.strictEqual(stepVenue.runVenueOfRow(undefined), undefined);
    assert.strictEqual(stepVenue.runVenueOfRow(waitFor.WAIT_FOR_ANY), undefined,
      '`any` means the row does not mind — handing it on as a venue would name a machine "any"');
    // The third shape is the DELETED one, and it is a refusal rather than a
    // venue: re-deciding would move a half-rendered book to another card.
    assert.throws(
      () => stepVenue.runVenueOfRow(waitFor.RETIRED_LOCAL_NARRATOR_VENUE),
      (err) => err.code === 'legacy_venue_retired',
    );
  });

  await check('two records of one venue are compared, and the comparison has one spelling', () => {
    const mac = { where: 'crucible', server: 'mac' };
    const local = { where: 'crucible', server: 'local' };
    assert.strictEqual(stepVenue.sameRunVenue(mac, { where: 'crucible', server: 'mac' }), true);
    assert.strictEqual(stepVenue.sameRunVenue(mac, local), false);
    assert.strictEqual(stepVenue.describeRunVenue(mac), 'crucible "mac"');
    assert.strictEqual(stepVenue.describeRunVenue(local), 'crucible "local"');
  });

  // ── 5. The AI provider block ─────────────────────────────────────────────

  await check('the crucible provider takes the row\'s machine and the ACT, and invents neither',
    () => {
      /*
       * THE BLOCK LOST ITS MODEL AND GAINED AN ACT (2026-09-14, crucible
       * PHASE15 §5.3). It used to be `{server, model}` with the model copied
       * off the row's `aiModel`; a text door now sends `capability.selected`
       * for its CLASS, read from the server it was placed on, so the row has
       * no id to hand over and the block carries the class instead. The act
       * is required and never defaulted — Owen, 2026-09-13: *"they can't lie
       * to the user and say a translate job is running when it's actually a
       * simplify job."*
       */
      const config = { aiProvider: 'crucible', aiModel: 'qwen3.5-9b' };
      assert.deepStrictEqual(aiProvider.providerConfigOf(config, 'clean', 'mac'), {
        provider: 'crucible',
        crucible: { server: 'mac', act: 'clean' },
      });
      assert.deepStrictEqual(aiProvider.providerConfigOf(config, 'translate', 'mac'), {
        provider: 'crucible',
        crucible: { server: 'mac', act: 'translate' },
      });
      for (const [assigned, why] of [
        [undefined, 'a row that was never assigned'],
        ['any', '`any` is not a machine'],
      ]) {
        assert.throws(() => aiProvider.providerConfigOf(config, 'clean', assigned), (err) => {
          assert.match(err.message, /^crucible_server_not_named: /, why);
          return true;
        }, why);
      }
      // And the DELETED narrator is refused by ITS name, not read as a server.
      assert.throws(
        () => aiProvider.providerConfigOf(config, 'clean', waitFor.RETIRED_LOCAL_NARRATOR_VENUE),
        /^Error: legacy_venue_retired: /,
      );
    });

  await check('a provider this build REMOVED is refused by name, never re-pointed', () => {
    /*
     * REWRITTEN 2026-09-14. This used to be "every other provider is untouched
     * by the new argument" and asserted that `ollama` still produced an
     * `{baseUrl, model}` block and that `claude` refused for want of a key.
     * There is no other provider now. Owen: *"they dont have ollama fallbacks
     * or cloud anything at all"* — `ollama`, `claude` and `openai` are gone as
     * providers and are UPSTREAMS on the engine, reached by ROUTING a class to
     * one (crucible `docs/PHASE15-HOST.md` §5.3).
     *
     * A row queued before that still names one on disk, so the thing worth
     * pinning is the ABSENCE, by name: it is refused with a code, and it is
     * NOT quietly re-pointed at a survivor. Re-pointing is the fallback this
     * codebase forbids, and it would move somebody's book onto a different
     * engine and a different bill without asking.
     */
    for (const gone of ['ollama', 'claude', 'openai']) {
      assert.throws(
        () => aiProvider.providerConfigOf({ aiProvider: gone, aiModel: 'm' }, 'clean', 'mac'),
        (err) => {
          assert.match(err.message, /^ai_provider_removed: /,
            'the code leads the message, so every surface reads the same name');
          assert.ok(err.message.includes(`"${gone}"`), `and it says which one: ${err.message}`);
          assert.match(err.message, /Settings → AI/,
            'and where the upstream lives now, or the row is dead with no way to act on it');
          return true;
        },
        gone);
    }
    // And the two survivors are exactly two: a provider list that grew a
    // fourth arm here would be a second opinion about what this build has.
    assert.deepStrictEqual(
      aiProvider.providerConfigOf({ aiProvider: 'local', aiModel: 'cogito' }, 'clean'),
      { provider: 'local', local: { model: 'cogito' } });
  });

  summary('queue step travel');
})();
