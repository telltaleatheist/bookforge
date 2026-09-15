#!/usr/bin/env node
/**
 * READING PAGES ON SOMEBODY ELSE'S CARD — and the four ways it would be wrong
 * in silence.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-pages.js
 *
 * Rollout tier 3: `foundry vlm-convert`'s `--vlm-endpoint` stops being a vLLM
 * BookForge spawns inside WSL and becomes a Crucible. It is an ENDPOINT and not
 * a job — crucible `docs/PHASE3-VLM.md` §1 says there is no `vlm-pages` job
 * type, because reading a page is an ordinary chat completion with a data-URI
 * PNG in its first content part — so what is under test is a URL, a model id, a
 * header map and a venue decision.
 *
 * What each group defends, and why it would otherwise be found on a real book:
 *
 *  1. **The act is `pages`, and it is not one of the four text acts.** Crucible
 *     refuses an act name it does not know (`400 unknown_act`), so the spelling
 *     is checked against crucible's own `capability.py` rather than against
 *     this repo's memory of it — including that its `job_type` is `llm`, which
 *     is the whole reason this door is not built on `runCrucibleJob`.
 *
 *  2. **THE BASE CARRIES ITS OWN `/v1`, and the text acts' base does not.**
 *     foundry composes the two routes' URLs by DIFFERENT rules: the text route
 *     normalises (`normaliseVllmEndpoint` appends `/v1`), the page route does
 *     NOT (`src/vlm/endpoint.ts` appends `/chat/completions` verbatim). Handing
 *     the page reader `<url>/openai` is a 404 against a door that exists —
 *     exactly the defect that cost 2.6 a correction. Both foundry rules are
 *     re-read out of foundry's source here when the checkout is present, so the
 *     day one of them changes this fails in this repo and not in a book.
 *
 *  3. **A Mac says "page reading is the PC's", not "something broke".**
 *     `dots-ocr` has no `mlx-darwin` block ON PURPOSE, so an Apple-silicon
 *     Crucible answers with `backendSupported: false`. That refusal has to read
 *     as a routing fact with two ways forward, and the manifest's own shape is
 *     checked so this test cannot pass on a premise that stopped being true.
 *
 *  4. **The credential is in the spawn's environment and NOWHERE else** — not
 *     on the argv, not in the log line, not in anything printable — and a
 *     foundry that would not send it at all is refused BEFORE a page is read
 *     rather than reaching the server unauthenticated.
 *
 * No GPU, no model, no page, and no network beyond 127.0.0.1.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PAGES = path.join(REPO, 'dist', 'electron', 'crucible', 'pages.js');

if (!fs.existsSync(PAGES)) {
  console.log('SKIP: dist/electron/crucible/pages.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

// vlm-convert reaches for `app.getPath('userData')`. The CLI's own shim answers
// that, and using it here means the modules under test load exactly as they do
// for `--generate-epub`.
require('../cli/electron-stub.js');

const pages = require(PAGES);
const acts = require(path.join(REPO, 'dist', 'electron', 'crucible', 'text-acts.js'));
const convert = require(path.join(REPO, 'dist', 'electron', 'vlm-convert.js'));
const conversion = require(path.join(REPO, 'dist', 'shared', 'vlm', 'conversion.js'));
const bank = require(path.join(REPO, 'dist', 'shared', 'vlm', 'readings-bank.js'));

const CRUCIBLE = path.join(path.dirname(REPO), 'crucible');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

const TOKEN = 'crux_pages_token_wxyz';
const URL = 'http://127.0.0.1:7100';

/** A model row as `GET /v1/models` sends one, with only what this door reads. */
function row(over) {
  return Object.assign({
    id: 'dots-ocr',
    family: 'dots',
    modalities: ['text', 'image'],
    backendSupported: true,
    installed: true,
    resident: true,
    loadable: true,
    fingerprint: 'dots-ocr@c0111ce6bc07803dbc267932ffef0ae3a51dc951',
  }, over || {});
}

/**
 * A host that answers from a script, so every branch is reachable with no
 * registry, no routing record and no network. The real one is
 * `processPagesVenueHost()`; this is the same interface, which is why that
 * interface exists.
 */
function scriptedHost(over) {
  return Object.assign({
    view: () => ({
      ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
      newJobsWaitFor: 'top-ranked',
      unknown: [],
      legacyLocalRender: false,
    }),
    enabled: () => [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
    ping: async () => ({ outcome: 'ok', message: 'ok' }),
    server: (name) => ({ name, url: URL, token: TOKEN, source: 'local' }),
    models: async () => [row(), { id: 'qwen3.5-9b', modalities: ['text'], backendSupported: true, installed: true, resident: false, loadable: true, fingerprint: null }],
  }, over || {});
}

async function main() {
  console.log('\nThe page reader on a Crucible: one endpoint, one act, one credential\n');

  // ── 1. The act, as CRUCIBLE names it ───────────────────────────────────────
  await check('`pages` is a crucible capability class whose job_type is llm', () => {
    assert.strictEqual(pages.CRUCIBLE_PAGES_ACT, 'pages');
    const capability = path.join(CRUCIBLE, 'crucible', 'capability.py');
    if (!fs.existsSync(capability)) {
      console.log('      (crucible checkout not here — the cross-repo half is skipped)');
      return;
    }
    const source = fs.readFileSync(capability, 'utf8');
    const block = /CapabilityClass\(\s*name="pages",[\s\S]*?\)/.exec(source);
    assert.ok(block, 'crucible/capability.py has no capability class named "pages" — every '
      + 'request naming it would be refused 400 unknown_act');
    assert.ok(/job_type="llm"/.test(block[0]),
      'crucible now serves `pages` as its own job type; this door is built on the llm proxy '
      + `and would have to become a job submit:\n${block[0]}`);
    // The other half of the same fact: there is no jobs/pages package.
    assert.ok(!fs.existsSync(path.join(CRUCIBLE, 'crucible', 'jobs', 'pages')),
      'crucible/jobs/pages/ now exists — PHASE3-VLM.md §1 said it must not, and if it does '
      + 'this door is the wrong shape');
  });

  await check('`pages` is NOT one of the four text acts', () => {
    assert.ok(!acts.CRUCIBLE_TEXT_ACTS.includes('pages'),
      'pages joined CRUCIBLE_TEXT_ACTS — a page read would be typed as a text act, which is '
      + 'the lie the four-act split exists to prevent');
    assert.strictEqual(acts.isCrucibleTextAct('pages'), false);
  });

  // ── 2. The header map ──────────────────────────────────────────────────────
  await check('the map carries the bearer, the api version and X-Crucible-Act: pages', () => {
    const map = pages.pagesEndpointHeaderMap(TOKEN);
    assert.strictEqual(map.Authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(map['X-Crucible-Api'], '1');
    assert.strictEqual(map['X-Crucible-Act'], 'pages');
    assert.deepStrictEqual(
      Object.keys(pages.pagesEndpointHeadersEnv(TOKEN)), ['FOUNDRY_ENDPOINT_HEADERS']);
  });

  await check('the masked render cannot print the token', () => {
    const shown = acts.maskEndpointHeaders(pages.pagesEndpointHeaderMap(TOKEN));
    assert.ok(!shown.includes(TOKEN), `the masked header map still contains the token: ${shown}`);
    assert.ok(shown.includes('****'), shown);
    assert.ok(shown.includes('"X-Crucible-Act":"pages"'), shown);
  });

  await check('an empty token is refused by name rather than sent as an empty bearer', () => {
    assert.throws(() => pages.pagesEndpointHeaderMap(''), (err) => {
      assert.strictEqual(err.code, 'crucible_empty_token');
      return true;
    });
  });

  // ── 3. THE BASE, AND THE SEGMENT THE TEXT ACTS DO NOT CARRY ────────────────
  /*
   * The one line in this seam that a reader will want to "unify" with the text
   * acts' base, and cannot. foundry composes the two routes' URLs by different
   * rules. Both are re-read from foundry's source below when it is here, so the
   * assertion is about foundry's behaviour and not about this repo's memory.
   */
  await check('the page base is <url>/openai/v1 — NOT the text acts\' <url>/openai', () => {
    assert.strictEqual(pages.cruciblePagesEndpoint(URL), 'http://127.0.0.1:7100/openai/v1');
    assert.strictEqual(pages.cruciblePagesEndpoint('http://mac:7100/'), 'http://mac:7100/openai/v1');
    assert.strictEqual(acts.crucibleChatBase(URL), 'http://127.0.0.1:7100/openai');
    assert.notStrictEqual(pages.cruciblePagesEndpoint(URL), acts.crucibleChatBase(URL),
      'the page base and the text base became the same string — one of the two routes is now '
      + 'composing the wrong URL');
  });

  await check('foundry\'s two composition rules, read out of foundry', () => {
    const foundry = path.join(path.dirname(REPO), 'foundry');
    if (!fs.existsSync(foundry)) {
      console.log('      (foundry checkout not here — the cross-repo half is skipped)');
    } else {
      // The PAGE route: verbatim, no version segment added.
      const endpointTs = fs.readFileSync(path.join(foundry, 'src', 'vlm', 'endpoint.ts'), 'utf8');
      assert.ok(/\$\{opts\.endpoint\.replace\(\/\\\/\+\$\/, ''\)\}\/chat\/completions/.test(endpointTs),
        'foundry src/vlm/endpoint.ts no longer appends /chat/completions verbatim to the base '
        + '— if it started normalising, cruciblePagesEndpoint is now adding a second /v1');
      assert.ok(!/normaliseVllmEndpoint/.test(endpointTs),
        'foundry\'s page route started normalising its endpoint; the /v1 this app adds would '
        + 'then be doubled');
      // The TEXT route: normalises.
      const vllmTs = fs.readFileSync(path.join(foundry, 'src', 'translate', 'vllm.ts'), 'utf8');
      assert.ok(/\/\\\/v\\d\+\$\/\.test\(base\)/.test(vllmTs),
        'foundry normaliseVllmEndpoint no longer tests for a trailing version');
    }
    // What each then asks for, from the base this app hands it.
    const pageBase = pages.cruciblePagesEndpoint(URL);
    assert.strictEqual(`${pageBase}/chat/completions`,
      'http://127.0.0.1:7100/openai/v1/chat/completions');
    // The listing DOES normalise, and /v1 already ends in a version, so it stays.
    const listing = /\/v\d+$/.test(pageBase) ? pageBase : `${pageBase}/v1`;
    assert.strictEqual(`${listing}/models`, 'http://127.0.0.1:7100/openai/v1/models');
  });

  // ── 4. The composed answer, and what lands on the argv ─────────────────────
  let reader = null;
  await check('a resident image model composes endpoint, model, act, env and fingerprint', async () => {
    reader = await pages.resolveCruciblePageReader('local', scriptedHost());
    assert.strictEqual(reader.server, 'local');
    assert.strictEqual(reader.endpoint, 'http://127.0.0.1:7100/openai/v1');
    assert.strictEqual(reader.model, 'dots-ocr');
    assert.strictEqual(reader.act, 'pages');
    assert.strictEqual(reader.fingerprint,
      'dots-ocr@c0111ce6bc07803dbc267932ffef0ae3a51dc951');
    const map = JSON.parse(reader.env.FOUNDRY_ENDPOINT_HEADERS);
    assert.strictEqual(map['X-Crucible-Act'], 'pages');
    assert.strictEqual(map.Authorization, `Bearer ${TOKEN}`);
  });

  await check('the foundry argv carries the endpoint and the model, and NOT the token', () => {
    const argv = conversion.vlmEndpointArgs(
      { url: reader.endpoint, model: reader.model, concurrency: 0 });
    const line = argv.join(' ');
    assert.ok(line.includes('--vlm-endpoint http://127.0.0.1:7100/openai/v1'), line);
    assert.ok(line.includes('--vlm-endpoint-model dots-ocr'), line);
    assert.ok(!line.includes(TOKEN), `the token reached the command line: ${line}`);
    assert.ok(!/FOUNDRY_ENDPOINT_HEADERS/.test(line), line);
    // concurrency 0 = foundry's own default of twelve, which PHASE3-VLM.md §4
    // makes a requirement of the manifest (--max-num-seqs 16). A number frozen
    // here would be this build's copy of somebody else's GPU property.
    assert.ok(!line.includes('--vlm-concurrency'), line);
    assert.strictEqual(conversion.DEFAULT_VLM_CONCURRENCY, 12);
  });

  await check('the token is in NOTHING a log can print', () => {
    for (const value of [reader.maskedHeaders, reader.endpoint, reader.model,
      reader.act, reader.server, reader.fingerprint]) {
      assert.ok(!String(value).includes(TOKEN), `the token is in a printable field: ${value}`);
    }
  });

  // ── 5. THE MAC, which is a routing fact and not a crash ────────────────────
  await check('an Apple-silicon Crucible says page reading is the PC\'s, with both ways forward',
    async () => {
      const host = scriptedHost({
        models: async () => [row({
          backendSupported: false,
          installed: false,
          resident: false,
          loadable: false,
          fingerprint: null,
          reason: 'dots-ocr.toml has no mlx-darwin block; it declares [\'cuda-linux\']',
        })],
      });
      await assert.rejects(
        () => pages.resolveCruciblePageReader('mac', host),
        (err) => {
          assert.strictEqual(err.code, 'crucible_pages_no_backend');
          assert.ok(err.message.includes(pages.CRUCIBLE_PAGES_NO_BACKEND), err.message);
          // The server's OWN reason, not a paraphrase of it.
          assert.ok(err.message.includes('mlx-darwin'), err.message);
          // BOTH WAYS FORWARD, or it is a dead end dressed as an explanation —
          // and the second one CHANGED when the local page readers were deleted
          // (docs/LEGACY-REMOVAL.md). It is no longer "turn the legacy switch
          // on"; it is the TYPED ENDPOINT under Settings → AI → Reading pages,
          // which survived that deletion because it is a deliberate choice of
          // GPU and is asked before the venue decision at all.
          assert.ok(/PC Crucible/.test(err.message), err.message);
          assert.ok(/Reading pages/.test(err.message), err.message);
          assert.ok(!/legacy|local engines/i.test(err.message),
            `it still offers a switch that no longer exists: ${err.message}`);
          assert.ok(err.message.includes('MLX'), err.message);
          // And it must not read as a fault.
          assert.ok(!/\b(crash|unexpected|internal error)\b/i.test(err.message), err.message);
          return true;
        });
    });

  await check('the manifest this refusal assumes still has no mlx-darwin block', () => {
    const manifest = path.join(CRUCIBLE, 'models', 'dots-ocr.toml');
    if (!fs.existsSync(manifest)) {
      console.log('      (crucible checkout not here — the cross-repo half is skipped)');
      return;
    }
    const toml = fs.readFileSync(manifest, 'utf8');
    assert.ok(/^\s*id\s*=\s*"dots-ocr"/m.test(toml), 'the page-reader manifest was renamed');
    assert.ok(/^\s*modalities\s*=\s*\[[^\]]*"image"/m.test(toml),
      'dots-ocr no longer declares the image modality, so every page would be refused at the '
      + 'content parts');
    assert.ok(/^\s*\[backends\.cuda-linux\]/m.test(toml), toml.slice(0, 200));
    assert.ok(!/^\s*\[backends\.mlx-darwin\]/m.test(toml),
      'dots-ocr gained an mlx-darwin block — the Mac refusal in pages.ts is now wrong and a '
      + 'Mac Crucible can read pages after all');
  });

  // ── 6. Image-capable is READ, never assumed ────────────────────────────────
  await check('a text-only page model is refused, naming what IS image-capable', async () => {
    const host = scriptedHost({
      models: async () => [
        row({ modalities: ['text'] }),
        row({ id: 'some-vlm', modalities: ['text', 'image'], resident: false }),
      ],
    });
    await assert.rejects(
      () => pages.resolveCruciblePageReader('local', host),
      (err) => {
        assert.strictEqual(err.code, 'crucible_pages_model_not_image_capable');
        assert.ok(err.message.includes('some-vlm'), err.message);
        return true;
      });
  });

  await check('a server with no page-reader manifest refuses as NOT OFFERED', async () => {
    const host = scriptedHost({
      models: async () => [{
        id: 'qwen3.5-9b', modalities: ['text'], backendSupported: true,
        installed: true, resident: true, loadable: true, fingerprint: null,
      }],
    });
    await assert.rejects(
      () => pages.resolveCruciblePageReader('local', host),
      (err) => {
        assert.strictEqual(err.code, 'crucible_pages_model_not_offered');
        assert.ok(err.message.includes('dots-ocr'), err.message);
        assert.ok(err.message.includes('qwen3.5-9b'), err.message);
        // No HuggingFace path is ever sent; the refusal must not suggest one.
        assert.ok(!err.message.includes('rednote-hilab'), err.message);
        return true;
      });
  });

  // ── 7. Residency is the operator's, and there is no load door here at all ──
  await check('a page reader that is not resident refuses by name', async () => {
    const host = scriptedHost({
      models: async () => [
        row({ resident: false }),
        { id: 'qwen3.5-9b', modalities: ['text'], backendSupported: true, installed: true, resident: true, loadable: true, fingerprint: null },
      ],
    });
    await assert.rejects(
      () => pages.resolveCruciblePageReader('local', host),
      (err) => {
        assert.strictEqual(err.code, 'crucible_pages_model_not_resident');
        assert.ok(err.message.includes('dots-ocr'), err.message);
        assert.ok(err.message.includes('local'), err.message);
        // It must say what IS resident: "nothing is resident" and "the wrong
        // one is" are different problems with different fixes.
        assert.ok(err.message.includes('qwen3.5-9b'), err.message);
        // And how to fix it by hand, because loading one is never done here.
        assert.ok(err.message.includes('--crucible-load'), err.message);
        return true;
      });
  });

  await check('this door has NO load door — a conversion cannot evict somebody\'s book', () => {
    const surface = Object.keys(pages).join(' ');
    assert.ok(!/load/i.test(surface),
      `electron/crucible/pages.ts exports something that can load a model: ${surface}. A load `
      + 'EVICTS whatever is resident, and on a shared server that is somebody else\'s book.');
    // And the host interface it asks the world through offers no loader either.
    assert.deepStrictEqual(
      Object.keys(pages.processPagesVenueHost()).sort(),
      ['enabled', 'models', 'ping', 'server', 'view']);
  });

  // ── 8. The venue: one record, no silent local run ─────────────────────────
  await check('there are NO local page readers left to route to — it refuses by name',
    async () => {
      /*
       * THIS CHECK USED TO DRIVE THE LEGACY SWITCH and assert it reached the
       * local page readers — MLX on Apple silicon, the WSL vLLM server on
       * Windows. Both went with the spawn layer (docs/LEGACY-REMOVAL.md), so
       * what it pins now is that the decision has one kind of answer and one
       * kind of refusal.
       *
       * What did NOT go is the TYPED endpoint in Settings → AI → Reading pages:
       * it is a deliberate choice of GPU, it is asked BEFORE this decision, and
       * section 10 below is where that precedence is pinned.
       */
      await assert.rejects(
        () => pages.decideWherePagesRun(scriptedHost({
          view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }),
          enabled: () => {
            // routing.ts's OWN refusal, which is what the real host throws.
            const err = new Error('no Crucible server is available to the queue');
            err.name = 'CrucibleRoutingError';
            err.code = 'no_enabled_server';
            throw err;
          },
        })),
        (err) => {
          assert.strictEqual(err.code, 'no_enabled_server');
          return true;
        });
      // And a record left over from that era cannot re-open the door.
      const stale = await pages.decideWherePagesRun(scriptedHost({
        view: () => ({
          ranked: [{ name: 'local', enabled: true }],
          newJobsWaitFor: 'top-ranked',
          unknown: [],
          legacyLocalRender: true,
        }),
        enabled: () => [{ name: 'local', enabled: true }],
      }));
      assert.strictEqual(stale.where, 'crucible');
      assert.strictEqual(stale.server, 'local');
      assert.strictEqual(stale.origin, 'decided here');
      assert.ok(stale.because.length > 0, 'the venue arrived with no reason');
    });

  await check('top-ranked is taken WITHOUT a ping — a named machine is an instruction', async () => {
    let pinged = 0;
    const where = await pages.decideWherePagesRun(scriptedHost({
      ping: async () => { pinged += 1; return { outcome: 'unreachable', message: 'no' }; },
    }));
    assert.strictEqual(where.where, 'crucible');
    assert.strictEqual(where.server, 'local');
    assert.strictEqual(pinged, 0);
  });

  await check('"any" takes the first that answers, in rank order', async () => {
    const where = await pages.decideWherePagesRun(scriptedHost({
      view: () => ({
        ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
        newJobsWaitFor: 'any',
        unknown: [],
      }),
      ping: async (name) => (name === 'mac'
        ? { outcome: 'ok', message: 'ok' }
        : { outcome: 'unreachable', message: 'nothing answered' }),
    }));
    assert.strictEqual(where.where, 'crucible');
    assert.strictEqual(where.server, 'mac');
  });

  await check('"any" with nothing reachable FAILS, naming each one tried', async () => {
    await assert.rejects(
      () => pages.decideWherePagesRun(scriptedHost({
        view: () => ({
          ranked: [{ name: 'local', enabled: true }, { name: 'mac', enabled: true }],
          newJobsWaitFor: 'any',
          unknown: [],
        }),
        ping: async (name) => ({ outcome: 'unreachable', message: `${name} said nothing` }),
      })),
      (err) => {
        assert.strictEqual(err.code, 'no_reachable_server');
        assert.ok(err.message.includes('local'), err.message);
        assert.ok(err.message.includes('mac'), err.message);
        // NO FALLBACK: it must not read as "so it read them here".
        assert.ok(/local narrator|local engines/.test(err.message), err.message);
        return true;
      });
  });

  await check('a caller that names a server wins over the record', async () => {
    const where = await pages.decideWherePagesRun(scriptedHost({
      view: () => ({ ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }),
    }), { server: 'mac' });
    assert.deepStrictEqual(
      { where: where.where, server: where.server }, { where: 'crucible', server: 'mac' });
  });

  // ── 9. The foundry that must carry the credential ─────────────────────────
  await check('a foundry that would drop the header map is refused, by name', () => {
    assert.strictEqual(
      bank.foundryVersionAtLeast('1.2.0', pages.FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES), false,
      'the pinned v1.2.0 release now clears the floor — its page reader does NOT read '
      + '$FOUNDRY_ENDPOINT_HEADERS (foundry 2d5d411 landed after the eb69b7a tag)');
    assert.strictEqual(
      bank.foundryVersionAtLeast(pages.FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES,
        pages.FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES), true);
    const said = pages.foundryTooOldForCruciblePages('1.2.0', 'local');
    assert.ok(said.includes('FOUNDRY_ENDPOINT_HEADERS'), said);
    assert.ok(said.includes(pages.FOUNDRY_VERSION_FOR_CRUCIBLE_PAGES), said);
    // A refusal with no way forward is what the no-band-aids rule is about —
    // and the way forward is now the TYPED endpoint, not the deleted switch.
    assert.ok(said.includes('Reading pages'), said);
    assert.ok(!/legacy|local engines/i.test(said),
      `it still offers a switch that no longer exists: ${said}`);
    assert.ok(/no page was sent without its credential/.test(said), said);
  });

  // ── 10. WHO IS ASKED, AND IN WHAT ORDER, before anything is spawned ───────
  /*
   * The precedence, driven through the real `planVlmConversion`. Both cases stop
   * at the project resolution — there is no project here — which is exactly the
   * point: what is asserted is which questions had ALREADY been asked by then.
   */
  await check('a TYPED endpoint wins and the Crucible record is never consulted', async () => {
    let consulted = 0;
    const host = scriptedHost({
      view: () => { consulted += 1; return { ranked: [], newJobsWaitFor: 'top-ranked', unknown: [] }; },
      enabled: () => { consulted += 1; return []; },
      models: async () => { consulted += 1; return []; },
    });
    await assert.rejects(() => convert.planVlmConversion({
      projectDir: path.join(os.tmpdir(), 'bf-pages-no-such-project'),
      endpoint: { url: 'http://127.0.0.1:8000/v1', model: '', concurrency: 0 },
    }, host));
    assert.strictEqual(consulted, 0,
      'a hand-typed page-reading endpoint asked the Crucible routing record anyway — two '
      + 'answers for one question, and the typed one is documented to win');
  });

  await check('with NO typed endpoint the record IS consulted, before the project is', async () => {
    let consulted = 0;
    const host = scriptedHost({
      view: () => {
        consulted += 1;
        return { ranked: [{ name: 'local', enabled: true }], newJobsWaitFor: 'top-ranked', unknown: [] };
      },
    });
    await assert.rejects(() => convert.planVlmConversion({
      projectDir: path.join(os.tmpdir(), 'bf-pages-no-such-project'),
    }, host));
    assert.ok(consulted > 0,
      'the venue decision never happened — page reading would silently keep whatever this '
      + 'machine does locally, whatever the routing record says');
  });

  // ── 11. The WSL page server is still here, and still labelled dated ────────
  await check('vlm-page-server is kept as a LABELLED stopgap, not a fallback', () => {
    const source = fs.readFileSync(path.join(REPO, 'electron', 'vlm-page-server.ts'), 'utf8');
    assert.ok(/DATED|scheduled for deletion/i.test(source),
      'electron/vlm-page-server.ts lost its deletion note — PHASE3-VLM.md §7 names it, its '
      + 'refusal, its three tool-paths keys and the wsl-server route as what this replaces');
    assert.ok(source.includes('PHASE3-VLM'), source.slice(0, 400));
  });

  // ── 12. A real request, so the map is proved on the WIRE ──────────────────
  //
  // Everything above proves what BookForge composes. This proves a server
  // receiving it sees the three headers at the path the page route builds —
  // because a map that is right in a JSON blob and wrong on the wire is the
  // defect a unit check cannot see.
  await check('the three headers arrive at /openai/v1/chat/completions', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const base = pages.cruciblePagesEndpoint(`http://127.0.0.1:${port}`);
      const map = pages.pagesEndpointHeaderMap(TOKEN);
      await new Promise((resolve, reject) => {
        // Composed exactly as foundry's page route composes it.
        const target = new (require('url').URL)(`${base.replace(/\/+$/, '')}/chat/completions`);
        const req = http.request(
          { host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: map },
          (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.end('{}');
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, '/openai/v1/chat/completions');
    assert.strictEqual(seen[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(seen[0].headers['x-crucible-api'], '1');
    assert.strictEqual(seen[0].headers['x-crucible-act'], 'pages');
  });

  console.log(`\n${passed} checks passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
