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
const path = require('path');

const SUITES = [
  'test-editor-state-store',
  'test-family-lifecycle',
  'test-book-chain',
  'test-working-copy-remint',
  'test-working-copy-lifecycle',
  'test-artifact-open',
  'test-ledger-lifecycle',
  'test-narration-pairing',
  'test-rail-tasks',
  'test-pass-lifecycle',
  'test-narration-deletions',
  'test-legacy-layout-state',
  'test-epub-provenance-lifecycle',
  'test-processing-chain',
  'test-job-timing',
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
process.exit(failed === 0 ? 0 : 1);
