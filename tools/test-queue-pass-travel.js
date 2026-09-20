#!/usr/bin/env node
/**
 * THE PASS STEPS TRAVEL — simplify, translate and the narration text cleanup
 * follow the machine their book was assigned, through ONE provider mapping.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-queue-pass-travel.js
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 *
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md` §3, from the A3 audit: *"the PASS steps do
 * not travel yet — `simplify`, `translate-pass`, `narration-text` and
 * `footnote-refs`. They are `cleanupEpub` underneath, so they are exactly the
 * clean-then-simplify row A5 is about, but `electron/processing-passes.ts`
 * builds the provider block BY HAND — a fourth copy of the mapping
 * `queue-steps/ai-provider.ts` owns — and has no `crucible` arm at all."*
 *
 * Two facts made that invisible rather than loud. A pass config does not carry
 * `aiProvider` at the top level — it carries a `simplify` or a `translate`
 * sub-object that does — so every reader of a step's provider (the pool, the
 * venue, the lease) was reading `undefined` off a pass row and answering the
 * conservative thing. And §4's safety default means a step that has not been
 * taught to travel simply does not: the row runs HERE, silently, while its
 * book is on another machine.
 *
 * ── What is worth defending ────────────────────────────────────────────────
 *
 *  1. ONE PROVIDER MAPPING, AND THE COPY IS GONE. `providerConfigOf` is it.
 *     The copy it replaced also defaulted both credentials to an empty string,
 *     which sends an empty Authorization header and reports whatever the API
 *     says about it instead of refusing at the door.
 *  2. THE PASS ASKS ITS OWN BLOCK. `machines`, `leasesModel`, `crucibleClass`
 *     and `resource` all read the nested provider, not a field that is never
 *     there.
 *  3. THE CLEAN ACT TRAVELS TOO, and by a different owner: nobody picks its
 *     provider on the row, so its venue is the routing record's answer for the
 *     `clean` act and its model is `<userData>/crucible-models.json`.
 *  4. A ROW THAT NAMES NO SERVER IS REFUSED BY NAME. A default here would be
 *     the manufactured instruction crucible §4.2.1a exists to prevent.
 *  5. NO PASS NAMES THE MODEL IT LEASES (rewritten 2026-09-14, again
 *     2026-09-19). Each act used to name its id so the scheduler could compare
 *     it to what the row was already holding, and that was right while the row
 *     owned the mapping. It does not: the id is `capability.selected` for the
 *     class ON THE PLACED SERVER, so every module answered null — and a hook
 *     every module answers null for is a comparison that matches nothing, which
 *     is how `pause()` came to close a running step's lease (bug hunt §H). The
 *     `leasedModel` hook is GONE; what a pass states is `crucibleClass`, and
 *     the scheduler compares that on the row's server.
 *  6. THE TRANSPORT REALLY HAS A CRUCIBLE ARM. `callAI` is what a translate
 *     pass reaches the model through, and it had four providers; a declaration
 *     that the pass travels, over a transport that cannot, is a row that fails
 *     an hour in.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  REPO, installElectronStub, makeChecker, startFakeCrucible, fakeNamer, send,
} = require('./fake-crucible.js');

const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-steps', 'pass.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// The pass module reaches `processing-passes`, which reaches the manifest
// service and the diff cache — all of which import `electron`.
const stub = installElectronStub('bf-pass-travel-');

const pass = require(path.join(DIST, 'queue-steps', 'pass.js'));
const aiProvider = require(path.join(DIST, 'queue-steps', 'ai-provider.js'));
const runtime = require(path.join(DIST, 'queue-steps', 'runtime.js'));
// The cloud lane lives here now, not on a row's provider — see the `resource`
// check below, which is the one that used to read a provider for it.
const slots = require(path.join(REPO, 'dist', 'shared', 'queue', 'slot-sets.js'));
const textAi = require(path.join(DIST, 'text-ai.js'));
const servers = require(path.join(DIST, 'crucible', 'servers.js'));
const passes = require(path.join(DIST, 'processing-passes.js'));
const waitFor = require(path.join(REPO, 'dist', 'shared', 'queue', 'wait-for.js'));

const { check, summary } = makeChecker();
const nameFake = fakeNamer(servers);

/** Every pass module, by the job type it is registered under. */
const PASSES = {
  simplify: pass.simplifyStep,
  'translate-pass': pass.translatePassStep,
  'narration-text': pass.narrationTextStep,
  'footnote-refs': pass.footnoteRefsStep,
};

/** A planned pass config, as the Process tab composes one. */
function passConfig(kind, ai) {
  const base = { kind, projectDir: '/p', stageRelDir: 'stages/01' };
  if (kind === 'simplify') return { ...base, simplify: { mode: 'dejargon', ...ai } };
  if (kind === 'translate') {
    return { ...base, translate: { sourceLang: 'de', targetLang: 'en', ...ai } };
  }
  return base;
}

(async () => {
  // ── 1. The declarations exist at all ─────────────────────────────────────

  await check('every pass module declares machines(), leasesModel() and crucibleClass()', () => {
    for (const [type, mod] of Object.entries(PASSES)) {
      assert.ok(mod, `${type} exports no step module`);
      for (const name of ['machines', 'leasesModel', 'crucibleClass', 'resource']) {
        assert.strictEqual(typeof mod[name], 'function', `${type} declares no ${name}()`);
      }
      assert.strictEqual(mod.leasedModel, undefined,
        `${type} declares leasedModel — the hook is gone (2026-09-19): every module answered `
        + 'null for it, so the comparison it fed matched nothing');
    }
  });

  // ── 2. Where the config decides ──────────────────────────────────────────

  await check('a simplify or translate pass travels only against a Crucible', () => {
    for (const [type, kind] of [['simplify', 'simplify'], ['translate-pass', 'translate']]) {
      const mod = PASSES[type];
      assert.strictEqual(
        mod.machines(passConfig(kind, { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' })),
        'any', type);
      for (const provider of ['ollama', 'local', 'claude', 'openai']) {
        assert.strictEqual(
          mod.machines(passConfig(kind, { aiProvider: provider, aiModel: 'm' })), 'local',
          `${type} against ${provider} has no server to be sent to`);
      }
    }
  });

  await check('the provider is read out of the pass\'s OWN block, not a field that is never there',
    () => {
      // The defect in one line: a top-level `aiProvider` is what the other AI
      // steps carry and what a pass row never has. If the module read that, a
      // crucible simplify would answer `local` — which is the silent one.
      assert.strictEqual(PASSES.simplify.machines({ kind: 'simplify', aiProvider: 'crucible' }),
        'local', 'a stray top-level field must not be mistaken for the pass\'s provider');
      assert.strictEqual(
        PASSES.simplify.machines(passConfig('simplify', { aiProvider: 'crucible', aiModel: 'm' })),
        'any');
    });

  await check('the clean pass travels unconditionally; footnote-refs never does', () => {
    assert.strictEqual(PASSES['narration-text'].machines(passConfig('narration-text')), 'any',
      'the clean act is one of crucible\'s four and its venue is the routing record\'s');
    assert.strictEqual(PASSES['footnote-refs'].machines(passConfig('footnote-refs')), 'local',
      'a string replace over a zip would occupy a remote slot with nothing');
  });

  await check('the cloud lane hangs off the SERVER now — every provider left is the card', () => {
    /*
     * REWRITTEN 2026-09-14, and the fact did NOT disappear — it changed owner.
     *
     * This check used to say "a pass against a cloud API contends for the CPU
     * pool, not the card", and drove it with `aiProvider: 'claude'`. The
     * observation behind it is still true: a run forwarded to a hosted API is
     * network latency, it holds no card, and making it wait behind a
     * nine-hour narration is the queue punishing a job for the company it
     * keeps. What is gone is the ROW being able to answer it. `claude` and
     * `openai` are not providers any more (crucible `docs/PHASE15-HOST.md`
     * §5.3); an engine ROUTES a capability class upstream, and whether this
     * run is such a run depends on the SERVER it was placed on, which the
     * row's own config knows nothing about. Two books on two engines can
     * route the same class differently.
     *
     * So `resourceForProvider` now answers `gpu` for both survivors, which is
     * the honest remainder — both are a model on a card — and the cloud arm
     * is a LANE per server in `shared/queue/slot-sets.ts`, chosen at
     * admission from the route. Pinned here together so the pair cannot drift
     * apart: the day something teaches `resource` a `cpu` answer again, this
     * goes red beside the lane that already does the job.
     */
    for (const provider of ['local', 'crucible']) {
      assert.strictEqual(
        PASSES.simplify.resource(passConfig('simplify', { aiProvider: provider, aiModel: 'm' })),
        'gpu', `${provider} is a model on a card`);
      assert.strictEqual(runtime.resourceForProvider({ aiProvider: provider }), 'gpu',
        `${provider}: the pass reads the same one rule every AI step reads`);
    }
    assert.strictEqual(PASSES['narration-text'].resource(passConfig('narration-text')), 'gpu',
      'the cleanup holds a 17 GB model for as long as a translation does');

    // AND THE LANE IT MOVED TO EXISTS, with both its numbers literal: no card
    // is settled by an upstream-routed run, and what it does occupy is this
    // queue's own willingness to have two requests outstanding per engine.
    assert.strictEqual(slots.cloudLaneOf('mac'), 'mac:cloud');
    assert.strictEqual(slots.isCloudLane('mac:cloud'), true);
    assert.strictEqual(slots.isCloudLane('mac'), false, 'the engine itself is not its own lane');
    assert.strictEqual(slots.CLOUD_LANE_SLOTS, 2);
    const lane = slots.slotSets({
      rankedServers: [{ name: 'mac', enabled: true }], upstreams: { mac: 'configured' },
      roles: { mac: 'engine' },
      occupied: [],
      // Nothing is queued in this check, so no in-app GPU row is drawn — which
      // is not what it is about either way.
      alignerCharged: false, serversOnThisMachine: [],
    })
      .find((set) => set.id === slots.cloudLaneOf('mac'));
    // `configured` rather than `unknown`: an engine that ROUTES a class upstream
    // necessarily has that upstream configured — the server itself refuses
    // `route_upstream_unconfigured` otherwise (crucible PHASE15 §3.2) — so this
    // is the engine this test is about, said in the fact the lane is drawn on.
    assert.ok(lane, 'an engine with an upstream has a lane for the classes it routes there');
    assert.strictEqual(lane.gpu, 0, 'not "a card we are not counting" — there is none');
    assert.strictEqual(lane.cpu, 2, 'the same width `local-work` gets, for the same reason');
  });

  // ── 3. Which model each act leases ───────────────────────────────────────

  await check('EVERY pass leases without naming a model — the server owns that mapping', () => {
    /*
     * ONE CHECK OUT OF THREE, 2026-09-14, because there is one answer now.
     *
     * It used to be split: `simplify` and `translate-pass` named the id from
     * the row's own `aiModel`, `narration-text` already answered null, and a
     * third check pinned that a BLANK `aiModel` did not become an empty id.
     * Phase 15 makes the clean pass's reason true of all of them — a text
     * door sends `capability.selected` for its CLASS, read from the server
     * the run was placed on (crucible PHASE15 §5.3), so the row carries no id
     * to name and the blank case is not a case any more.
     *
     * What each pass DOES state is its class, and that is what the scheduler
     * compares on the row's server (`nextActWouldUseHeldCard`, 2026-09-19). A
     * lookup here saying "simplify is the 27B" would be a second owner of a
     * per-host fact (crucible `docs/ARCHITECTURE.md` R1) and wrong on the
     * first machine with a smaller card — which is why the id is not named
     * here and the class is.
     */
    for (const [type, config] of [
      ['simplify', passConfig('simplify', { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' })],
      ['translate-pass', passConfig('translate', { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' })],
      ['narration-text', passConfig('narration-text')],
    ]) {
      assert.strictEqual(PASSES[type].leasesModel(config), true,
        `${type} asks the model about every block of the book`);
      assert.strictEqual(typeof PASSES[type].crucibleClass(config), 'string',
        `${type} must name the CLASS its lease is taken under — the id is the SERVER's, `
        + 'chosen from its own capability record');
    }
    // The two that lease nothing, for two different reasons. `footnote-refs`
    // names no class either — a string replace over a zip asks no model.
    const legacy = passConfig('simplify', { aiProvider: 'local', aiModel: 'cogito' });
    assert.strictEqual(PASSES.simplify.leasesModel(legacy), false,
      'the bundled llama is this machine\'s process; there is no server lease to take');
    assert.strictEqual(PASSES['footnote-refs'].leasesModel(passConfig('footnote-refs')), false);
    assert.strictEqual(PASSES['footnote-refs'].crucibleClass(passConfig('footnote-refs')), null);

    /*
     * AND THE TWO WAYS THE TABLE COULD COME BACK ARE PINNED BY ABSENCE.
     *
     * `crucibleModelForAiStep` was the helper beside `providerConfigOf` that
     * read a row's `aiModel` and handed it to the scheduler as the lease's
     * subject. It is DELETED, and its absence is asserted by name rather than
     * left to a reader to notice — an export that comes back would be the
     * whole mapping back with it.
     */
    assert.strictEqual(aiProvider.crucibleModelForAiStep, undefined,
      'crucibleModelForAiStep is back — the id is the server\'s answer, asked at run time, '
      + 'and a synchronous reader of the row cannot know it');
    const src = fs.readFileSync(path.join(REPO, 'electron', 'queue-steps', 'pass.ts'), 'utf-8');
    assert.ok(!/['"]qwen/i.test(src),
      'pass.ts names a model id — the act-to-model mapping is the server\'s, not a table here');
    assert.ok(!fs.existsSync(path.join(stub.userData, 'crucible-models.json')),
      'and the retired per-act record is not being written again');
  });

  // ── 4. The row's machine, refused by name when it names none ─────────────

  await check('a crucible pass with no assigned machine is refused by name, and does no work',
    async () => {
      for (const [assigned, why] of [
        [undefined, 'a row that was never assigned'],
        [waitFor.WAIT_FOR_ANY, '`any` is not a machine'],
      ]) {
        const result = await passes.runProcessingPass(
          'step-1',
          passConfig('simplify', { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' }),
          null,
          assigned,
        );
        assert.strictEqual(result.success, false, why);
        assert.match(result.error, /^crucible_server_not_named: /, why);
      }
    });

  await check('the hand-built provider block is gone from processing-passes.ts', () => {
    /*
     * A SOURCE READ, deliberately. Nothing about the pass's OUTPUT
     * distinguishes "built by the one owner" from "built by an identical
     * copy" — the thing worth pinning is that the second author is not there
     * to drift. The copy's signature was three `params.aiProvider === '…'`
     * ternaries choosing which arm to fill.
     *
     * `provider: params.aiProvider` is NOT what is looked for: that spelling
     * also appears in the ledger record each pass files about itself, where
     * naming the provider is the point.
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'processing-passes.ts'), 'utf-8');
    assert.ok(!/params\.aiProvider === '/.test(src),
      'processing-passes builds a provider block by hand again — it is providerConfigOf\'s job');
    assert.ok(!/(claudeApiKey|openaiApiKey) \|\| ''/.test(src),
      'a credential defaulted to an empty string sends an empty Authorization header');
    /*
     * AND EACH CALL STATES ITS OWN ACT — the argument that arrived 2026-09-14.
     *
     * `providerConfigOf(params, act, assignedVenue)`. The act is the
     * capability class the run is; it decides which model the engine answers
     * with and it travels to the server in `X-Crucible-Act`, so `/v1/activity`
     * says what is actually running. Owen, 2026-09-13: *"they can't lie to the
     * user and say a translate job is running when it's actually a simplify
     * job."* A shared spelling would be exactly that lie, so the two passes
     * are pinned to DIFFERENT literal acts — one each, matched to the pass —
     * rather than to a count of identical calls.
     */
    for (const [act, count] of [['simplify', 1], ['translate', 1]]) {
      const calls = src.match(
        new RegExp(`providerConfigOf\\(params, '${act}', assignedVenue\\)`, 'g')) || [];
      assert.strictEqual(calls.length, count,
        `the ${act} pass must hand providerConfigOf its own act AND the row's assigned machine `
        + '— a missing venue leaves the crucible arm with nothing, and a borrowed act reports '
        + 'the wrong work on the server');
    }
    assert.strictEqual((src.match(/providerConfigOf\(/g) || []).length, 2,
      'two AI passes, two calls — a third would be a door nothing above accounts for');
  });

  // ── 5. The mapping's own answer ──────────────────────────────────────────

  await check('one mapping answers for a pass block exactly as it does for a step config', () => {
    /*
     * A pass's `simplify`/`translate` sub-object carries the same two fields a
     * step config carries at the top level, and it is handed to the SAME
     * function — which is the point of the module. The block it composes lost
     * its `model` and gained its `act` on 2026-09-14 (crucible PHASE15 §5.3):
     * the id is `capability.selected` on the placed server, so the only two
     * things this app knows here are WHICH engine and WHAT CLASS.
     */
    const params = { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' };
    assert.deepStrictEqual(aiProvider.providerConfigOf(params, 'simplify', 'mac'), {
      provider: 'crucible',
      crucible: { server: 'mac', act: 'simplify' },
    });
    assert.deepStrictEqual(aiProvider.providerConfigOf(params, 'translate', 'mac'), {
      provider: 'crucible',
      crucible: { server: 'mac', act: 'translate' },
    });
  });

  // ── 6. The transport really reaches a Crucible ───────────────────────────

  await check('callAI takes the same block and really talks to a Crucible', async () => {
    const seen = [];
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/openai/chat/completions' || req.method !== 'POST') return false;
      seen.push(JSON.parse((await ctx.readBody(req)).toString('utf-8')));
      send(res, 200, {
        id: 'c1',
        model: 'qwen3.8-27b-4bit',
        choices: [{ message: { role: 'assistant', content: '<<<1>>> Hallo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return true;
    });
    const server = nameFake(fake.url);
    try {
      const answer = await textAi.callAI(
        '<<<1>>> Hello',
        { provider: 'crucible', crucible: { server, model: 'qwen3.8-27b-4bit' } },
        'Translate to German.',
      );
      assert.strictEqual(answer, '<<<1>>> Hallo');
      assert.strictEqual(seen.length, 1, 'one completion, on the OpenAI door');
      assert.strictEqual(seen[0].model, 'qwen3.8-27b-4bit');
      assert.strictEqual(seen[0].messages[0].role, 'system');
      assert.strictEqual(seen[0].messages[0].content, 'Translate to German.');
    } finally {
      await fake.close();
    }
  });

  await check('the chat door STATES ITS ACT, so a bench can say what is running', async () => {
    /*
     * ── THIS CHECK USED TO BE THE OPPOSITE, AND THAT IS THE STORY ─────────
     *
     * Owen, 2026-09-13: *"they can't lie to the user and say a translate job
     * is running when it's actually a simplify job. It must accurately
     * represent the job that's running."* The engine SPAWN door has carried
     * `X-Crucible-Act` since that day (`text-acts.ts`'s header map). The CHAT
     * door could not: the SDK's `ChatOptions` had nowhere to put it, so this
     * suite pinned the absence and named what would end it.
     *
     * The SDK gained `ChatOptions.act` on 2026-09-14 and this check went red
     * with the instruction on it. So now it pins the thing itself: the header
     * travels, and it carries the act the CALLER named rather than a literal
     * this file chose. Crucible cannot work it out — a simplify and a
     * translate are the same model on the same route, and the only difference
     * is a prompt the server does not own.
     *
     * There is no default, here or in the SDK, whose own docblock says why:
     * "a name nobody chose on a bench is the thing this header exists to
     * prevent."
     */
    const seen = [];
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/openai/chat/completions') return false;
      await ctx.readBody(req);
      seen.push(req.headers);
      send(res, 200, {
        id: 'c1',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return true;
    });
    const server = nameFake(fake.url);
    try {
      for (const act of ['translate', 'simplify', 'clean', 'analysis']) {
        await textAi.callAI('hi', { provider: 'crucible', crucible: { server, act, model: 'm' } });
        const headers = seen[seen.length - 1];
        assert.strictEqual(headers['x-crucible-api'], '1', 'the API version travels');
        assert.strictEqual(headers['x-crucible-act'], act,
          `a ${act} run must say ${act}, not whatever act was spelled first`);
      }
      assert.strictEqual(seen.length, 4);
    } finally {
      await fake.close();
    }
  });

  await check('a truncated Crucible answer is refused, never written into the book', async () => {
    const fake = await startFakeCrucible(async (req, res, ctx) => {
      if (ctx.url.pathname !== '/v1/openai/chat/completions') return false;
      await ctx.readBody(req);
      send(res, 200, {
        id: 'c1',
        model: 'qwen3.8-27b-4bit',
        choices: [{ message: { role: 'assistant', content: '<<<1>>> Hal' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return true;
    });
    const server = nameFake(fake.url);
    try {
      await assert.rejects(
        () => textAi.callAI('<<<1>>> Hello',
          { provider: 'crucible', crucible: { server, model: 'qwen3.8-27b-4bit' } }),
        /^Error: crucible_answer_truncated: /,
        'the numbered-paragraph parse would take a truncated batch for a short one');
    } finally {
      await fake.close();
    }
  });

  await check('a provider block with no block for its own provider is refused by name',
    async () => {
      await assert.rejects(() => textAi.callAI('hi', { provider: 'crucible' }),
        /^Error: ai_provider_block_incomplete: /,
        'better than a TypeError from inside a translation at chapter nine');
    });

  await check('aiCallModel names the model each block carries, and null until one is stamped', () => {
    /*
     * TWO PROVIDERS NOW, and the crucible case gained a second null.
     *
     * The `ollama`, `claude` and `openai` arms this used to walk are gone
     * (crucible PHASE15 §5.3). What is left is the pair, and one new fact
     * worth pinning: a crucible block does not carry a model when it is
     * BUILT. `providerConfigOf` composes `{server, act}`; the id is STAMPED
     * on it later, by `crucibleActModel` (electron/crucible/text-venue.ts),
     * out of the capability record of the server the run was placed on.
     *
     * So before the run has asked, `null` is the truth and the only safe
     * answer — this function's one consumer is a log line and the provenance
     * record a run files about itself, and writing a guessed id into a book's
     * provenance is worse than writing none.
     */
    assert.strictEqual(
      textAi.aiCallModel({ provider: 'crucible', crucible: { server: 's', act: 'clean', model: 'a' } }),
      'a', 'once the server has answered, the stamped id is what the ledger records');
    assert.strictEqual(
      textAi.aiCallModel(aiProvider.providerConfigOf(
        { aiProvider: 'crucible', aiModel: 'ignored' }, 'clean', 'mac')),
      null,
      'a freshly built crucible block has not asked the server yet, and a guess in the ledger '
      + 'is worse than a blank');
    /*
     * THE BUNDLED ARM REPORTS NOTHING, AND THAT IS CORRECT (2026-09-17).
     *
     * This used to assert that a `local` block still named its model. Owen
     * retired `local` as a provider and `aiCallModel` narrowed to the one
     * survivor with it — so the question is whether that narrowing lost
     * anything, and MEASURED against its two callers it did not:
     * `text-ai.ts`'s own log line and `mono-translation-job.ts` both read a
     * config for a run IN PROGRESS. `providerConfigOf` refuses `local` before
     * any such run exists (pinned in `test-queue-step-travel.js`), so a block
     * naming it cannot reach here at all.
     *
     * It is NOT the renderer for a stored ledger row — nothing calls it that
     * way — which is what would have made the narrowing a loss of history.
     */
    assert.strictEqual(textAi.aiCallModel({ provider: 'local', local: { model: 'cogito' } }), null,
      'a retired provider reports no model. If this ever starts mattering, the reason will be '
      + 'that something began calling aiCallModel on a STORED row — check the callers before '
      + 'widening it back.');
    assert.strictEqual(textAi.aiCallModel({ provider: 'crucible', crucible: { server: 's', act: 'clean' } }), null,
      'and a block that names none reports none rather than inventing a name for the ledger');
  });

  // ── 8. A TRAVELLED TRANSLATE THAT IS REFUSED A WAIT STAYS A WAIT ─────────
  //
  // `settleStep` parks a queue row against a server only when the failure
  // carries `busyLine` (`queue-engine.ts`, `busyLineOf`); without one the row
  // reddens as though the book were broken. The translate path threw a
  // `CrucibleTextActError` that HAS the holder's line and then flattened it:
  // `runMonoTranslation`'s own outer catch rebuilt the answer as
  // `{success, error}` and the line was gone before any pass code could read
  // it. Simplify parks because its refusal reaches the step as an exception;
  // translate goes through this result object, so the result has to carry it.
  //
  // What this check owns is exactly that half — the throw reaching the
  // TranslationJobResult. Carrying it onward (`runTranslatePass` →
  // `PassJobResult` → `pass.ts` → `stepFailure`) is pinned by
  // `tools/test-queue-step-parks.js`, which drives every module's park.
  await check('a leased server\'s holder line survives runMonoTranslation\'s catch', async () => {
    const mono = require(path.join(DIST, 'mono-translation-job.js'));
    const textVenue = require(path.join(DIST, 'crucible', 'text-venue.js'));
    const epub = require(path.join(DIST, 'epub-processor.js'));

    const BUSY = 'leased: foundry, translate since 2026-09-14T01:00:00+00:00';
    const book = path.join(stub.work, 'leased-translate.epub');
    const zip = new epub.ZipWriter();
    zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), false);
    zip.addFile('META-INF/container.xml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
      + '<rootfiles><rootfile full-path="OEBPS/content.opf" '
      + 'media-type="application/oebps-package+xml"/></rootfiles></container>', 'utf8'), true);
    zip.addFile('OEBPS/content.opf', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">'
      + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + '<dc:identifier id="pub-id">urn:uuid:leased-translate</dc:identifier>'
      + '<dc:title>Ein Buch</dc:title><dc:language>de</dc:language></metadata>'
      + '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>'
      + '<spine><itemref idref="c1"/></spine></package>', 'utf8'), true);
    zip.addFile('OEBPS/c1.xhtml', Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Eins</title></head>'
      + '<body><p>Der Hof erhob sich um vier Uhr.</p></body></html>', 'utf8'), true);
    await zip.write(book);

    // The model call is where the refusal arrives on a real run; throwing it
    // here is the same exception from the same class, without a server.
    const realCallAI = textAi.callAI;
    textAi.callAI = async () => {
      throw new textVenue.CrucibleTextActError(
        'crucible_model_leased',
        'crucible "mac"\'s resident model is leased by another run, so the translate act was '
        + `not started: ${BUSY}.`,
        BUSY);
    };
    let result;
    try {
      result = await mono.runMonoTranslation('job-leased', {
        cleanedEpubPath: book,
        sourceLang: 'de',
        targetLang: 'en',
        provider: { provider: 'crucible', crucible: { server: 'mac', act: 'translate', model: 'qwen3.5-27b' } },
        outputEpubPath: path.join(stub.work, 'leased-translate-out.epub'),
      }, null);
    } finally {
      textAi.callAI = realCallAI;
    }
    assert.strictEqual(result.success, false, 'a leased server did not stop the translation');
    assert.ok(result.error.includes('crucible_model_leased'),
      `the refusal lost its name: ${result.error}`);
    assert.strictEqual(result.busyLine, BUSY,
      'the holder\'s line did not survive the catch, so the queue row would redden rather than '
      + 'park against that server');
  });

  summary('queue pass travel');
})();
