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
 *        --input book.epub --provider claude --model claude-sonnet-4-... [--simplify --mode learner]
 *
 * The API key is read from BOOKFORGE_AI_API_KEY (env) so it never lands in argv.
 * No fallbacks: a missing key/model/provider or a failed job throws with a naming message.
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

function buildProviderConfig(provider, model, apiKey) {
  switch (provider) {
    case 'claude':
      if (!apiKey) throw new Error("provider 'claude' needs an API key (--api-key or ANTHROPIC_API_KEY)");
      if (!model) throw new Error("provider 'claude' needs --model (e.g. claude-sonnet-4-5)");
      return { provider, claude: { apiKey, model } };
    case 'openai':
      if (!apiKey) throw new Error("provider 'openai' needs an API key (--api-key or OPENAI_API_KEY)");
      if (!model) throw new Error("provider 'openai' needs --model (e.g. gpt-4o)");
      return { provider, openai: { apiKey, model } };
    case 'ollama':
      // Base URL + default model match ai-bridge constants (OLLAMA_BASE_URL, DEFAULT_MODEL).
      return { provider, ollama: { baseUrl: 'http://localhost:11434', model: model || 'cogito:14b' } };
    case 'local':
      // Bundled llama.cpp; the active model is resolved inside llama-bridge (active-model.json).
      return { provider, local: { model: model || undefined } };
    default:
      throw new Error(`unknown --provider '${provider}' (claude|openai|ollama|local)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) throw new Error('--input <file.epub> is required');
  if (!fs.existsSync(args.input)) throw new Error(`input epub not found: ${args.input}`);
  if (!args.provider) throw new Error('--provider <claude|openai|ollama|local> is required');

  const config = buildProviderConfig(args.provider, args.model, process.env.BOOKFORGE_AI_API_KEY);

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
  if (args['output-dir']) options.outputDir = args['output-dir'];
  if (args['custom-instructions']) options.customInstructions = String(args['custom-instructions']);
  if (args['no-parallel']) {
    options.useParallel = false;
  } else if (args['parallel-workers']) {
    options.useParallel = true;
    options.parallelWorkers = parseInt(args['parallel-workers'], 10);
  }
  if (args['test-mode']) {
    options.testMode = true;
    if (args['test-chunks']) options.testModeChunks = parseInt(args['test-chunks'], 10);
  }

  const bridge = require('../dist/electron/ai-bridge.js');
  const api = (bridge.aiBridge && bridge.aiBridge.cleanupEpub) ? bridge.aiBridge : bridge;
  if (typeof api.cleanupEpub !== 'function') {
    throw new Error('ai-bridge.cleanupEpub missing — rebuild BookForge (npx tsc -p tsconfig.electron.json)');
  }

  const jobId = `cli-ai-${crypto.randomUUID()}`;
  const task = options.simplifyForChildren
    ? `simplify(mode=${options.simplifyMode || 'default'}${options.enableAiCleanup ? '+cleanup' : ''})`
    : 'cleanup';
  const t0 = Date.now();
  console.log(`[ai] ${task} via ${args.provider}${args.model ? ' ' + args.model : ''} — driving aiBridge.cleanupEpub...`);

  const r = await api.cleanupEpub(args.input, jobId, null, undefined, config, options);
  if (!r || !r.success) throw new Error(`cleanupEpub failed: ${r && r.error ? r.error : 'unknown error'}`);

  console.log(`[ai] done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${r.outputPath}`);
  console.log(`[ai] chapters=${r.chaptersProcessed ?? '?'} ` +
    `contentSkips=${r.contentSkipsAffected || 0} truncated=${r.truncatedAffected || 0} ` +
    `copyright=${r.copyrightChunksAffected || 0} markerMismatch=${r.markerMismatchAffected || 0}`);
  if (r.skippedChunksPath) console.log(`[ai] skipped-chunks report: ${r.skippedChunksPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[ai] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
