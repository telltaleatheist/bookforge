#!/usr/bin/env node
/**
 * Stage packaging resources for electron-builder.
 *
 * ── PHASE 6: THERE IS NOTHING LEFT TO STAGE ─────────────────────────────────
 *
 * This script used to do two things, and both are gone:
 *
 *   resources/e2a-env.tar.gz   the conda-pack'd Python env. It stopped being
 *                              bundled long before Phase 6 — a packaged build
 *                              downloads it from a GitHub release on first run
 *                              (electron/tools-env-bootstrap.ts) and unpacks it
 *                              into `<userData>/runtime/tools-env`.
 *   resources/e2a/             a snapshot of the whole ebook2audiobook checkout.
 *                              It shipped a source tree the app could not run:
 *                              the EXCLUDE_TOP list dropped `python_env`, and
 *                              `python_env` was the only thing anything ever
 *                              resolved out of the runtime copy. So every
 *                              installer carried tens of megabytes of code that
 *                              nothing spawned, and `e2aIsReady()` — which
 *                              gated on that missing interpreter — could never
 *                              have returned true on a packaged install.
 *
 * The English Stanza pack went with it: it was staged/downloaded for e2a's
 * `lib/core.py` pipeline, and narrator records in `text/sentences.py` that
 * stanza is never consulted on the render path (`test_text_paragraph_packer.py`
 * asserts the packer cannot even import it).
 *
 * The script is KEPT, rather than deleted with its npm scripts, because
 * `package:win` / `package:mac` still name it and because a build step that
 * PRINTS what it no longer does is how the next person finds out where the
 * runtime actually comes from. It accepts its old flags and reports that they
 * decide nothing, rather than failing on a command line somebody still has in
 * their shell history.
 *
 * Usage:
 *   node packaging/stage-resources.js [--seed] [--models]
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const resourcesDir = path.join(repoRoot, 'resources');

const args = process.argv.slice(2);
const legacyFlags = args.filter((a) => ['--seed', '--models', '--e2a'].includes(a));

fs.mkdirSync(resourcesDir, { recursive: true });

// A stale `resources/e2a` from a build made before Phase 6 must not be picked up
// by electron-builder's extraResources (it is no longer listed, but a leftover
// directory is still ~30 MB of confusion in a tree somebody is inspecting).
const staleSnapshot = path.join(resourcesDir, 'e2a');
if (fs.existsSync(staleSnapshot)) {
  fs.rmSync(staleSnapshot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  console.log('[stage-resources] removed the stale resources/e2a snapshot from a pre-Phase-6 build');
}

console.log('[stage-resources] nothing to stage.');
console.log('[stage-resources]   tools Python env: downloaded on first run (electron/tools-env-bootstrap.ts)');
console.log('[stage-resources]   ebook2audiobook snapshot: no longer shipped');
if (legacyFlags.length) {
  console.log(`[stage-resources] ignoring ${legacyFlags.join(' ')} — the payload they selected is gone`);
}
console.log('[stage-resources] done');
