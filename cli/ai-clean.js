/**
 * ai-clean.js — headless AI cleanup / simplify through BookForge's REAL ai-bridge.
 * Drives the exact pipeline the app runs (aiBridge.cleanupEpub): same 8000-char
 * chunking, same per-provider prompts, same num_ctx / think:false / keep_alive /
 * temperature, same [SKIP]/truncation/copyright/repetition safeguards, same diff-cache
 * + checkpoint outputs, same two-lane per-job state. Simplify is the SAME call with
 * simplifyForChildren + simplifyMode — no separate path.
 *
 * cleanupEpub is already headless-callable: mainWindow=null, onProgress=undefined →
 * progress goes to console. The only Electron-runtime dependency is powerSaveBlocker,
 * no-op'd by cli/electron-stub.js. Requires BookForge built (dist/electron), not running.
 *
 * Run via the electron shim:
 *   node --require ./cli/electron-stub.js cli/ai-clean.js \
 *        --input book.epub --provider local [--simplify --mode learner]
 *   node --require ./cli/electron-stub.js cli/ai-clean.js \
 *        --input book.epub --provider crucible --server mac --model qwen3.5-9b --stages ocr
 *
 * PROVIDER `crucible` runs the pass on a Crucible inference server's GPU instead
 * of local Ollama (crucible docs/PHASE2-LLM.md section 7). --server names an
 * entry in this machine's registry, --model a model that must ALREADY be
 * resident there: the run refuses by name rather than loading one.
 *
 * THERE IS NO API KEY HERE ANY MORE (2026-09-15, crucible docs/PHASE15-HOST.md
 * section 0 and section 5.3). A cloud account belongs to the ENGINE: its key
 * lives in that Crucible's own config.toml, its routes are set through
 * `PUT /v1/settings`, and an app - the desktop one and this file alike - sends
 * `capability.selected` to a server and holds no credential at all. So
 * `--api-key`, BOOKFORGE_AI_API_KEY and the two provider env vars are gone,
 * and so are the `claude`, `openai` and `ollama` providers: `ai-bridge` deleted
 * those branches on 2026-09-14, and a CLI that still composed configs for them
 * was reading keys off a machine to hand them to a door that no longer exists.
 *
 * To run a pass through Anthropic today: configure the account ONCE on the
 * Crucible (BookForge -> Settings -> AI, or the engine's own console), route
 * the class to it, and run this file with `--provider crucible --server <name>
 * --model <the routed id>`.
 *
 * No fallbacks: a missing model/provider or a failed job throws with a naming message.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

function buildProviderConfig(provider, model, crucibleServer) {
  switch (provider) {
    case 'crucible':
      // A Crucible server runs the model; BookForge only sends the chunk. Neither
      // half is guessable — --server names an entry in this machine's registry
      // (bookforge-tts --crucible-list) and --model a Crucible model id that must
      // already be RESIDENT there. ai-bridge refuses by name if it is not; this
      // run never loads it (`--crucible-load` is the operator's door).
      if (!crucibleServer) throw new Error("provider 'crucible' needs --server <name> (a registered server: bookforge-tts --crucible-list)");
      if (!model) throw new Error("provider 'crucible' needs --model <id> (e.g. qwen3.5-9b)");
      return { provider, crucible: { server: crucibleServer, model } };
    case 'local':
      // Bundled llama.cpp; the active model is resolved inside llama-bridge (active-model.json).
      return { provider, local: { model: model || undefined } };
    // THE THREE DELETED PROVIDERS ARE REFUSED BY NAME rather than left out of
    // the switch. Somebody with a shell script from last month must be told
    // what happened to their flag and where the thing it named went, not
    // handed "unknown provider" about a word they have used for a year.
    case 'claude':
    case 'openai':
      throw new Error(
        `provider '${provider}' is gone: a cloud account belongs to the ENGINE now, not to an app `
        + '(crucible PHASE15-HOST.md section 0). Configure the account on the Crucible once - '
        + "BookForge Settings -> AI, or the engine's own console - route the class to it, then "
        + 'run --provider crucible --server <name> --model <the routed id>. No key is typed here.');
    case 'ollama':
      throw new Error(
        "provider 'ollama' is gone: an Ollama server is an UPSTREAM of a Crucible now, configured "
        + 'on the engine and routed to per class. Run --provider crucible --server <name> '
        + '--model <the routed id>.');
    default:
      throw new Error(`unknown --provider '${provider}' (crucible|local)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) throw new Error('--input <file.epub> is required');
  if (!fs.existsSync(args.input)) throw new Error(`input epub not found: ${args.input}`);
  if (!args.provider) throw new Error('--provider <crucible|local> is required');
  // --server belongs to ONE provider. Accepting it elsewhere and dropping it is
  // the failure mode the flags keeper exists to end: a run that silently went to
  // the local machine reads as a measurement of the remote one.
  if (args.server !== undefined && args.provider !== 'crucible') {
    throw new Error(`--server names a registered Crucible server and applies to --provider crucible only (got provider '${args.provider}')`);
  }

  // NO KEY IS READ HERE, and the two flags that used to carry one are REFUSED
  // rather than ignored: a flag that is silently dropped is a choice somebody
  // made that did not happen, and this particular choice was "send my book to
  // Anthropic", which must never quietly become "send it somewhere else".
  for (const gone of ['api-key', 'ollama-url']) {
    if (args[gone] !== undefined) {
      throw new Error(
        `--${gone} is gone: a cloud or Ollama account belongs to the Crucible engine, not to this `
        + 'app (crucible PHASE15-HOST.md section 0). Configure it once on the engine and route the '
        + 'class to it; this file then sends nothing but the chunk and the model id.');
    }
  }
  const config = buildProviderConfig(args.provider, args.model,
    args.server === true ? '' : args.server);

  // Options mirror the app's cleanupEpub option surface exactly.
  const options = {};
  if (args.simplify) {
    options.simplifyForChildren = true;
    if (args.mode) options.simplifyMode = args.mode;   // resolveSimplifyMode validates/throws
    // Default matches the app: simplify ALSO runs cleanup unless explicitly turned off.
    options.enableAiCleanup = !args['no-cleanup'];
  } else {
    options.enableAiCleanup = true;   // cleanup only
  }
  // Which cleanup passes to run is a required, explicit choice on the edit-list path —
  // cleanupEpub throws without it. Simplify and --cleanup-prompt take other paths that
  // never consult it, so it's only demanded when the edit-list path will actually run.
  const STAGES = ['ocr', 'tts', 'both'];
  const needsStages = !args.simplify && !args['cleanup-prompt'] && !args['detailed-cleanup'];
  if (args.stages !== undefined) {
    if (!STAGES.includes(args.stages)) {
      throw new Error(`--stages must be one of ${STAGES.join(' | ')}, got: ${args.stages}`);
    }
    options.cleanupStages = args.stages;
  } else if (needsStages) {
    throw new Error(
      'cleanup needs --stages <ocr|tts|both>: ocr = the per-chunk scanner-damage pass, ' +
      'writes repaired.epub and stops; tts = the deterministic prep only (footnote markers, ' +
      'quotes, numbers), writes cleaned.epub in seconds; both = repair then prep'
    );
  }
  if (args['output-dir']) options.outputDir = args['output-dir'];
  // The pristine imported epub, whose <sup> markup is proof of where the footnote
  // markers are. The app resolves this from manifest.archive; headless callers pass
  // it explicitly. Optional — without it pass 2 uses the inferred pipeline.
  if (args['structural-source']) {
    if (!fs.existsSync(args['structural-source'])) {
      throw new Error(`--structural-source epub not found: ${args['structural-source']}`);
    }
    options.structuralSourceEpub = args['structural-source'];
  }
  if (args['custom-instructions']) options.customInstructions = String(args['custom-instructions']);
  if (args['no-parallel']) {
    options.useParallel = false;
  } else if (args['parallel-workers']) {
    options.useParallel = true;
    options.parallelWorkers = parseInt(args['parallel-workers'], 10);
  }
  if (args['test-chunks'] && !args['test-mode']) {
    throw new Error('--test-chunks requires --test-mode (refusing to silently ignore it)');
  }
  if (args['test-mode']) {
    options.testMode = true;
    if (args['test-chunks']) options.testModeChunks = parseInt(args['test-chunks'], 10);
  }
  // Parity with the app's IPC handler: detailed-cleanup pass + custom prompt override.
  if (args['detailed-cleanup']) options.useDetailedCleanup = true;
  if (args['cleanup-prompt']) {
    if (!fs.existsSync(args['cleanup-prompt'])) {
      throw new Error(`--cleanup-prompt file not found: ${args['cleanup-prompt']}`);
    }
    options.cleanupPrompt = fs.readFileSync(args['cleanup-prompt'], 'utf8');
  }
  // Testing knob: override the prose chunk size (chars) so the REAL cleanupEpub path
  // can be exercised at different chunk sizes. No fallback — a bad value throws.
  if (args['chunk-size'] !== undefined) {
    const cs = parseInt(args['chunk-size'], 10);
    if (!Number.isInteger(cs) || cs <= 0) {
      throw new Error(`--chunk-size must be a positive integer, got: ${args['chunk-size']}`);
    }
    options.chunkSize = cs;
  }
  // Testing knob: override sampling temperature (default 0.1). 0 is valid
  // (fully deterministic); only a non-numeric/negative value throws. No fallback.
  if (args['temperature'] !== undefined) {
    const t = parseFloat(args['temperature']);
    if (!Number.isFinite(t) || t < 0) {
      throw new Error(`--temperature must be a number >= 0, got: ${args['temperature']}`);
    }
    options.temperature = t;
  }

  const bridge = require('../dist/electron/ai-bridge.js');
  const api = (bridge.aiBridge && bridge.aiBridge.cleanupEpub) ? bridge.aiBridge : bridge;
  if (typeof api.cleanupEpub !== 'function') {
    throw new Error('ai-bridge.cleanupEpub missing — rebuild BookForge (npx tsc -p tsconfig.electron.json)');
  }

  const jobId = `cli-ai-${crypto.randomUUID()}`;

  // Ctrl+C: abort through the bridge's real cancel (AbortController + llama stop) so
  // no request is left in flight and the local server never survives the CLI.
  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[ai] ${sig} — cancelling job ${jobId}...`);
    Promise.resolve(bridge.cancelCleanupJob ? bridge.cancelCleanupJob(jobId) : undefined)
      .then(() => stopLocalLlama())
      .then(() => process.exit(130))  // abort-path: SIGINT/SIGTERM teardown
      .catch(() => process.exit(130));  // abort-path: SIGINT/SIGTERM teardown
  };
  const stopLocalLlama = async () => {
    if (args.provider !== 'local') return;
    try {
      const { llamaBridge } = require('../dist/electron/llama-bridge.js');
      await llamaBridge.stop();
      console.log('[ai] local llama-server stopped (VRAM released)');
    } catch (e) {
      console.warn('[ai] llama-server stop failed:', e && e.message);
    }
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  const task = options.simplifyForChildren
    ? `simplify(mode=${options.simplifyMode || 'default'}${options.enableAiCleanup ? '+cleanup' : ''})`
    : 'cleanup';
  const t0 = Date.now();
  const via = args.provider === 'crucible'
    ? `crucible ${args.server}/${args.model}`
    : `${args.provider}${args.model ? ' ' + args.model : ''}`;
  console.log(`[ai] ${task} via ${via} — driving aiBridge.cleanupEpub...`);

  const r = await api.cleanupEpub(args.input, jobId, null, undefined, config, options);
  // The app is long-lived and lets the 5-min idle timer stop llama-server; the CLI
  // exits immediately, which would ORPHAN the server holding VRAM. Stop it explicitly
  // on every terminal path.
  await stopLocalLlama();
  if (!r || !r.success) throw new Error(`cleanupEpub failed: ${r && r.error ? r.error : 'unknown error'}`);

  console.log(`[ai] done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${r.outputPath}`);
  console.log(`[ai] chapters=${r.chaptersProcessed ?? '?'} ` +
    `contentSkips=${r.contentSkipsAffected || 0} truncated=${r.truncatedAffected || 0} ` +
    `copyright=${r.copyrightChunksAffected || 0} markerMismatch=${r.markerMismatchAffected || 0}`);
  if (r.skippedChunksPath) console.log(`[ai] skipped-chunks report: ${r.skippedChunksPath}`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[ai] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
