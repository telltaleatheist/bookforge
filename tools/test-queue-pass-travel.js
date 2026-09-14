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
 *  2. THE PASS ASKS ITS OWN BLOCK. `machines`, `leasesModel`, `leasedModel`
 *     and `resource` all read the nested provider, not a field that is never
 *     there.
 *  3. THE CLEAN ACT TRAVELS TOO, and by a different owner: nobody picks its
 *     provider on the row, so its venue is the routing record's answer for the
 *     `clean` act and its model is `<userData>/crucible-models.json`.
 *  4. A ROW THAT NAMES NO SERVER IS REFUSED BY NAME. A default here would be
 *     the manufactured instruction crucible §4.2.1a exists to prevent.
 *  5. WHICH MODEL EACH ACT LEASES, so the scheduler can compare it to what the
 *     row is already holding — a lease is per model and a server holds one.
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

  await check('every pass module declares machines(), leasesModel() and leasedModel()', () => {
    for (const [type, mod] of Object.entries(PASSES)) {
      assert.ok(mod, `${type} exports no step module`);
      for (const name of ['machines', 'leasesModel', 'leasedModel', 'resource']) {
        assert.strictEqual(typeof mod[name], 'function', `${type} declares no ${name}()`);
      }
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

  await check('a pass against a cloud API contends for the CPU pool, not the card', () => {
    assert.strictEqual(
      PASSES.simplify.resource(passConfig('simplify', { aiProvider: 'claude', aiModel: 'm' })),
      'cpu', 'network latency made to wait behind a nine-hour narration is the old defect');
    assert.strictEqual(
      PASSES.simplify.resource(passConfig('simplify', { aiProvider: 'crucible', aiModel: 'm' })),
      'gpu');
    assert.strictEqual(PASSES['narration-text'].resource(passConfig('narration-text')), 'gpu',
      'the cleanup holds a 17 GB model for as long as a translation does');
  });

  // ── 3. Which model each act leases ───────────────────────────────────────

  await check('a pass leases only against a Crucible, and names the model it will hold', () => {
    const crucible = passConfig('simplify', { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' });
    assert.strictEqual(PASSES.simplify.leasesModel(crucible), true);
    assert.strictEqual(PASSES.simplify.leasedModel(crucible), 'qwen3.8-27b-4bit',
      'the id comes from the row\'s own aiModel — the field the act itself runs on');
    const ollama = passConfig('simplify', { aiProvider: 'ollama', aiModel: 'qwen3.5:9b' });
    assert.strictEqual(PASSES.simplify.leasesModel(ollama), false,
      'Ollama keeps its own VRAM through keep_alive');
    assert.strictEqual(PASSES.simplify.leasedModel(ollama), null);
    assert.strictEqual(PASSES['footnote-refs'].leasesModel(passConfig('footnote-refs')), false);
    assert.strictEqual(PASSES['footnote-refs'].leasedModel(passConfig('footnote-refs')), null);
  });

  await check('the clean pass leases, and names no model — the SERVER owns that now', () => {
    const config = passConfig('narration-text');
    assert.strictEqual(PASSES['narration-text'].leasesModel(config), true,
      'it asks the model about every block of the book');
    assert.strictEqual(PASSES['narration-text'].leasedModel(config), null,
      'the act-to-model mapping moved to the chosen server\'s capability record (2026-09-14), '
      + 'which needs a server name and a round trip — and this question is synchronous and '
      + 'asked before the step is placed');
    /*
     * AND THE TABLE MUST NOT COME BACK. Null costs a clean row its lease
     * across a chain, which is a real cost and is recorded as OWED in the
     * module — but the repair is an async `leasedModel` given the run's venue,
     * NOT a second copy of the mapping over here. A server measures its own
     * card; an id chosen in this app is a second opinion about a decision that
     * already has an owner (crucible `docs/ARCHITECTURE.md` R1).
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'queue-steps', 'pass.ts'), 'utf-8');
    assert.ok(!/['"]qwen/i.test(src),
      'pass.ts names a model id — the act-to-model mapping is the server\'s, not a table here');
    assert.ok(!fs.existsSync(path.join(stub.userData, 'crucible-models.json')),
      'and the retired per-act record is not being written again');
  });

  await check('a crucible pass whose model is blank names none rather than an empty id', () => {
    const blank = passConfig('simplify', { aiProvider: 'crucible', aiModel: '  ' });
    assert.strictEqual(PASSES.simplify.leasedModel(blank), null,
      'an empty id would be compared against an open lease and could never match anything');
  });

  // ── 4. The row's machine, refused by name when it names none ─────────────

  await check('a crucible pass with no assigned machine is refused by name, and does no work',
    async () => {
      for (const [assigned, why] of [
        [undefined, 'a row that was never assigned'],
        [waitFor.WAIT_FOR_ANY, '`any` is not a machine'],
        [waitFor.LEGACY_LOCAL_NARRATOR, 'the legacy switch is on'],
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
    assert.strictEqual((src.match(/providerConfigOf\(params, assignedVenue\)/g) || []).length, 2,
      'both AI passes must hand it the row\'s assigned machine, or the crucible arm has nothing');
  });

  // ── 5. The mapping's own answer ──────────────────────────────────────────

  await check('one mapping answers for a pass block exactly as it does for a step config', () => {
    const params = { aiProvider: 'crucible', aiModel: 'qwen3.8-27b-4bit' };
    assert.deepStrictEqual(aiProvider.providerConfigOf(params, 'mac'), {
      provider: 'crucible',
      crucible: { server: 'mac', model: 'qwen3.8-27b-4bit' },
    });
    assert.strictEqual(aiProvider.crucibleModelForAiStep(params), 'qwen3.8-27b-4bit');
    assert.strictEqual(aiProvider.crucibleModelForAiStep({ aiProvider: 'ollama', aiModel: 'm' }),
      null);
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

  await check('the chat door sends NO X-Crucible-Act — the act is stated on the lease',
    async () => {
      /*
       * A TRIPWIRE ON A GAP, not a check that a gap is fine.
       *
       * Owen, 2026-09-13: *"they can't lie to the user and say a translate job
       * is running when it's actually a simplify job."* Every act BookForge
       * spawns states itself in `FOUNDRY_ENDPOINT_HEADERS`
       * (`crucible/text-acts.ts`), and every lease states itself in its own
       * `act`. But the app's own chat completions do not: `@crucible/client`'s
       * `ChatOptions` has no `act` field and the client sends no such header,
       * so `/v1/activity`'s in-flight entry for a simplify run through
       * `crucibleChatOnce` carries no act at all.
       *
       * That is a RULING OWED on the server's side (the vocabulary is
       * Crucible's) and it is recorded here rather than remembered: the day
       * the SDK's typings gain the field, this goes red with the reason on it,
       * and `crucibleChatOnce` is where it belongs.
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
        await textAi.callAI('hi', { provider: 'crucible', crucible: { server, model: 'm' } });
        assert.strictEqual(seen[0]['x-crucible-api'], '1', 'the API version does travel');
        assert.strictEqual(seen[0]['x-crucible-act'], undefined,
          'if this is now sent, the pin below is stale and the comment above is the fix');
        const sdk = fs.readFileSync(
          path.join(REPO, 'node_modules', '@crucible', 'client', 'dist', 'esm', 'types.d.ts'),
          'utf-8');
        const chatOptions = /export interface ChatOptions \{([\s\S]*?)\n\}/.exec(sdk);
        assert.ok(chatOptions, 'the SDK no longer declares ChatOptions where this reads it');
        assert.ok(!/\bact\??:/.test(chatOptions[1]),
          'THE SDK NOW CARRIES AN ACT ON A CHAT. Set it in `crucibleChatOnce` '
          + '(electron/ai-bridge.ts) from the caller\'s own act, delete this check, and give '
          + 'each AI door a truthful act the way the engine spawns already have one.');
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

  await check('aiCallModel names the model each block carries', () => {
    assert.strictEqual(textAi.aiCallModel({ provider: 'crucible', crucible: { server: 's', model: 'a' } }), 'a');
    assert.strictEqual(textAi.aiCallModel({ provider: 'claude', claude: { apiKey: 'k', model: 'b' } }), 'b');
    assert.strictEqual(
      textAi.aiCallModel(aiProvider.providerConfigOf({ aiProvider: 'local', aiModel: 'cogito' })),
      'cogito',
      'a local pass keeps its chosen model, which providerConfigOf files in the ollama arm');
    assert.strictEqual(textAi.aiCallModel({ provider: 'local' }), null,
      'and a block that names none reports none rather than inventing a name for the ledger');
  });

  summary('queue pass travel');
})();
