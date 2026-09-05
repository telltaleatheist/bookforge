/**
 * pass.js — run ONE of the app's processing passes on a project, headless.
 *
 * SIMPLIFY, TRANSLATE and FOOTNOTE-REFS are queue rows in the app
 * (`shared/queue/engine-types.ts` job types `simplify` / `translate-pass` /
 * `footnote-refs`), and every one of them is `queue-steps/pass.ts` calling
 * `processing-passes.runProcessingPass(stepId, config, queueMainWindow())` over
 * a config that `processing-chain.planProcessingChain` laid out. This adapter
 * calls that same pair through `processing-pass-step.js`, with the same null
 * window the queue passes headlessly. Nothing here re-plans a stage directory,
 * re-derives a family, or writes a ledger row of its own.
 *
 * NARRATION-TEXT is the fourth kind and has its own command
 * (`--narration-text`), because it also has a bare-EPUB door for a file with no
 * project around it. Both go through this same step for a project.
 *
 * NOT `--ai-cleanup` / `--ai-simplify`. Those drive `ai-bridge.cleanupEpub` over
 * a LOOSE EPUB and write `cleaned.epub` / `simplified.epub` beside it — the
 * file-in, file-out door. This one is the PROJECT act: it stages, records a
 * ledger row and promotes a working copy, which is what the app's button does
 * and what a loose-file run cannot be made to do afterwards.
 *
 * NOT "Clean text" either. That is Foundry's own pass, ordered inside the hosted
 * Foundry window and executed by `foundry-host-queue`, which cannot be reached
 * without mounting that window — see docs/CLI_PARITY_AUDIT.md.
 *
 *   node --require ./cli/electron-stub.js cli/pass.js --project "<dir>" \
 *        --kind footnote-refs
 *   node --require ./cli/electron-stub.js cli/pass.js --project "<dir>" \
 *        --kind simplify --mode learner --provider ollama --model gemma3:12b
 *   node --require ./cli/electron-stub.js cli/pass.js --project "<dir>" \
 *        --kind translate --source-lang en --target-lang de \
 *        --provider claude --model claude-sonnet-4-5
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { USER_DATA } = require('./electron-stub.js');
const { applyNarratorSessionsRoot } = require('./narrator-sessions-root.js');
const { runProjectPass } = require('./processing-pass-step.js');

const KINDS = ['simplify', 'translate', 'footnote-refs'];
const PROVIDERS = ['ollama', 'claude', 'openai', 'local'];
const MODES = ['dejargon', 'destiffen', 'learner'];

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

/** The provider half of a SimplifyPassParams / TranslatePassParams, built the way
 *  the app's own dialog builds it: the key travels in the process env, never argv. */
function providerParams(args) {
  const provider = args.provider;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`--provider must be one of ${PROVIDERS.join('|')} (got: ${provider ?? 'none'})`);
  }
  if (!args.model) throw new Error('--model <name> is required for this pass');
  const params = { aiProvider: provider, aiModel: args.model };
  if (args['ollama-url']) params.ollamaBaseUrl = args['ollama-url'];
  const key = process.env.BOOKFORGE_AI_API_KEY;
  if (provider === 'claude') {
    if (!key) throw new Error('provider claude needs an API key (BOOKFORGE_AI_API_KEY in the env)');
    params.claudeApiKey = key;
  }
  if (provider === 'openai') {
    if (!key) throw new Error('provider openai needs an API key (BOOKFORGE_AI_API_KEY in the env)');
    params.openaiApiKey = key;
  }
  if (args['custom-instructions']) params.customInstructions = args['custom-instructions'];
  return params;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) throw new Error('--project <projectDir> is required');
  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
  }
  const kind = args.kind;
  if (!KINDS.includes(kind)) {
    throw new Error(`--kind must be one of ${KINDS.join('|')} (got: ${kind ?? 'none'}). `
      + 'narration-text has its own command: --narration-text');
  }

  const pass = { kind };
  if (kind === 'simplify') {
    if (!MODES.includes(args.mode)) {
      throw new Error(`--mode must be one of ${MODES.join('|')} for --kind simplify`);
    }
    pass.simplify = { mode: args.mode, ...providerParams(args) };
    if (args['test-mode']) {
      pass.simplify.testMode = true;
      if (args['test-chunks'] !== undefined && args['test-chunks'] !== true) {
        pass.simplify.testModeChunks = parseInt(args['test-chunks'], 10);
      }
    }
  } else if (kind === 'translate') {
    if (!args['source-lang']) throw new Error('--source-lang <code> is required for --kind translate');
    if (!args['target-lang']) throw new Error('--target-lang <code> is required for --kind translate');
    pass.translate = {
      sourceLang: args['source-lang'],
      targetLang: args['target-lang'],
      ...providerParams(args),
    };
    if (args['translation-prompt']) {
      const p = path.resolve(args['translation-prompt']);
      if (!fs.existsSync(p)) throw new Error(`--translation-prompt file not found: ${p}`);
      pass.translate.translationPrompt = fs.readFileSync(p, 'utf8');
    }
  }
  // footnote-refs takes no parameters at all — it is a deterministic string
  // replace over the zip, and a pass that "removed 0" reports that as a failure
  // with its own sentence rather than a silent success.

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));
  const libraryRoot = path.dirname(path.dirname(projectDir));
  console.log(`[${kind}] scratch: ${applyNarratorSessionsRoot(libraryRoot)}`);

  await runProjectPass(projectDir, pass,
    { family: typeof args.family === 'string' ? args.family : null, label: kind });
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[pass] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
