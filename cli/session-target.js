/**
 * session-target.js — which rendered session a headless enhancement pass reads.
 *
 * The denoise and the voice conversion are both passes over ONE session's
 * sentence cache, and both take exactly one thing: its `processDir`
 * (`FinalDenoiseConfig.processDir`, `RvcEnhancementConfig.processDir`). The
 * app's own steps resolve it through a stated ladder — the step's config, then
 * the parent artifact, then `getBfpCachedSession(projectId)` — and the CLI has
 * no queue lineage, so it has the two ends of that ladder and nothing invented
 * in between: an explicit `--process-dir`, or the project's CACHED session
 * through the SAME `reassembly-bridge.getBfpCachedSession` the steps fall back
 * to (`electron/queue-steps/final-denoise.ts`, `rvc-enhancement.ts`).
 *
 * A project with no cached session is a REFUSAL naming the project, never a
 * scan of the scratch root for something that looks close enough: the pass
 * derives a set that is recorded against the session it read, and deriving it
 * against a different copy of the sentences is the exact mismatch the derived
 * set's manifest exists to catch.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * @param {{project?: string, 'process-dir'?: string}} args  the adapter's parsed argv
 * @param {{getBfpCachedSession(projectDir: string): Promise<{processDir: string,
 *          sessionId: string, sessionDir: string} | null>}} [reassembly]
 *   injectable for tests; production omits it and gets the compiled bridge.
 * @returns {Promise<{processDir: string, projectDir: string | null}>}
 */
async function resolveSessionTarget(args, reassembly) {
  const explicit = args['process-dir'];
  if (explicit && args.project) {
    throw new Error('--project and --process-dir both name the session to read; pass one');
  }
  if (explicit) {
    const processDir = path.resolve(explicit);
    if (!fs.existsSync(processDir)) throw new Error(`--process-dir not found: ${processDir}`);
    return { processDir, projectDir: null };
  }
  if (!args.project) {
    throw new Error('--project <projectDir> or --process-dir <dir> is required');
  }
  const projectDir = path.resolve(args.project);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
  }
  const bridge = reassembly ?? require('../dist/electron/reassembly-bridge.js');
  if (typeof bridge.getBfpCachedSession !== 'function') {
    throw new Error(
      'compiled reassembly-bridge missing getBfpCachedSession — rebuild '
      + '(npx tsc -p tsconfig.electron.json)');
  }
  const session = await bridge.getBfpCachedSession(projectDir);
  if (!session) {
    throw new Error(
      `${path.basename(projectDir)} has no cached render (stages/03-tts/sessions holds no `
      + 'session with sentences). Render it first, or name the session with --process-dir.');
  }
  return { processDir: session.processDir, projectDir };
}

module.exports = { resolveSessionTarget };
