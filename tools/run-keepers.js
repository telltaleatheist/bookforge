#!/usr/bin/env node
/**
 * Run the keeper suites this phase must keep green, and print one line each.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/run-keepers.js
 *
 * Not a test itself — a runner, so the whole set can be checked in one command
 * on a shell that will not take a for-loop.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * REFUSE A STALE BUILD BEFORE RUNNING A SINGLE SUITE.
 *
 * The suites load COMPILED modules out of dist/electron, so a source-green tree
 * with an old dist reports red — and the failure names the test, which is the
 * wrong end to start debugging from (it cost a real debugging round on
 * 2026-08-18, on both machines' account). Newest source mtime vs newest compiled
 * mtime is a cheap honest proxy: tsc rewrites its outputs on every run, so a
 * compile that happened after the last edit always wins this comparison.
 */
function newestMtime(root, extension) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        const mtime = fs.statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  walk(root);
  return newest;
}

const repo = path.join(__dirname, '..');
const newestSource = Math.max(
  newestMtime(path.join(repo, 'electron'), '.ts'),
  newestMtime(path.join(repo, 'shared'), '.ts'),
  newestMtime(path.join(repo, 'packages', 'quire', 'src'), '.ts'),
);
const newestCompiled = newestMtime(path.join(repo, 'dist', 'electron'), '.js');
if (newestCompiled === 0) {
  console.error(
    'dist/electron holds no compiled output, and the keepers load compiled modules. '
    + 'Run: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
if (newestSource > newestCompiled) {
  console.error(
    'dist/electron is older than the TypeScript sources, so the keepers would test a build '
    + 'that no longer matches the code. Run: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

const SUITES = [
  'test-higgs-engine',
  // The TWO Higgs doctors and the platform dispatch between them. Separate from
  // test-higgs-engine because that suite is about the engine id, the catalog and
  // the spawn; this one is about which environment a machine is asked about, and
  // it drives every platform as a fixture.
  'test-higgs-doctor-arms',
  // The wsl.exe argv trap: a script handed to wsl.exe without --exec is run
  // through the distro's default shell, which expands every $ before bash sees
  // it. That silently made the Higgs doctor report a correctly patched env as
  // missing both patches (measured 2026-09-05). Half of this suite is pure and
  // runs everywhere; the live half is win32-and-wsl-gated and skips by name.
  'test-wsl-script-invocation',
  // 'test-orpheus-argv-snapshot' was here until 2026-09-04, and the file itself is
  // gone as of 2026-09-05. It pinned the five ebook2audiobook command lines; Phase
  // 3 replaced all five, so its anchors named code that no longer exists and it
  // could not run at all — a test nobody can run is worse than no test, because it
  // looks like coverage in a directory listing. Superseded by
  // test-narrator-argv-snapshot. Its BASELINE is kept, as data:
  // tools/snapshots/orpheus-argv-base.json, described in that directory's README.
  'test-narrator-argv-snapshot',
  'test-serve-spawn-env',
  'test-narrator-log-strings',
  'test-no-e2a-doors',
  'test-stream-engine-availability',
  'test-session-engine-provenance',
  'test-assembly-after-wsl-normalize',
  'test-wsl-sweep-serve-exclusion',
  'test-extension-typecheck',
  'test-gpu-ownership',
  'test-editor-state-store',
  'test-family-lifecycle',
  'test-working-copy-remint',
  'test-working-copy-lifecycle',
  'test-ledger-lifecycle',
  'test-narration-pairing',
  'test-pass-lifecycle',
  'test-pass-diff',
  'test-narration-deletions',
  'test-book-block-category',
  'test-chapter-heading-insert',
  'test-book-block-text',
  'test-element-text-edit',
  'test-layout-neutral-edit',
  'test-book-path-routing',
  'test-book-chapter-titles',
  'test-book-chapter-add',
  'test-narration-carry',
  'test-writer-attribute-safety',
  'test-element-uid-stamp',
  'test-legacy-layout-state',
  'test-epub-provenance-lifecycle',
  'test-processing-chain',
  'test-queue-engine',
  'test-queue-bench',
  'test-derived-sentences',
  'test-narration-chain',
  'test-text-normalization',
  'test-narration-text-pass',
  'test-narration-text-readiness',
  'test-prompt-examples',
  'test-narration-text-two-family',
  'test-tts-number-rules',
  'test-tts-number-normalizer',
  'test-cli-narration-prep',
  'test-library-lock',
  'test-job-timing',
  'test-vlm-convert-plan',
  'test-vlm-convert-attach',
  'test-foundry-host',
  'test-foundry-host-nodes',
  'test-foundry-host-status',
  'test-foundry-host-queue',
  'test-foundry-progress',
  // The narration text pass left this repository for the Foundry engine (Owen,
  // 2026-09-05). These two hold the two halves of what that leaves behind: that
  // what was handed over is what arrived and has not drifted since, and that the
  // stamp the engine WRITES is still readable by the reader BookForge KEPT — a
  // writer and a reader of one JSON object in two repositories, neither of which
  // compiles against the other. Both skip by name on a machine with no Foundry.
  'test-foundry-clean-text-vendor',
  'test-foundry-narration-stamp',
  // 'test-foundry-narrate-form' was here until 2026-08-26. It kept
  // electron/foundry-narrate-form.ts — the static field description Foundry drew
  // Narrate's dialog from — and both went together when the dialog came back to
  // BookForge's own window. The half of that press worth keeping, which of a
  // project's exports it means, is test-foundry-narrate-target below.
  'test-foundry-narrate-target',
  'test-foundry-landing',
  'test-foundry-adopt',
  'test-legacy-migration',
  'test-legacy-bilingual-manifest',
  'test-retired-engine-settings',
  'test-ipc-collision',
  'test-derivation-cache',
  'test-versions-page-data',
  'test-cover-thumbnails',
  'test-bookshelf-ids',
  'test-bookshelf-standalone',
  'test-bookshelf-queue-routes',
  'test-bookshelf-stream-teardown',
  'test-cli-exit-drain',
];

let failed = 0;
for (const suite of SUITES) {
  const file = path.join(__dirname, `${suite}.js`);
  let out = '';
  let ok = true;
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    ok = false;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const tally = out.trim().split('\n').filter((l) => /passed/.test(l)).pop() || out.trim().split('\n').pop();
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${suite.padEnd(32)} ${(tally || '').trim()}`);
  if (!ok) console.log(out.split('\n').filter((l) => /^FAIL|^ {6}/.test(l)).join('\n'));
}
console.log(failed === 0 ? '\nALL KEEPERS GREEN' : `\n${failed} SUITE(S) FAILING`);
process.exitCode = failed === 0 ? 0 : 1;
