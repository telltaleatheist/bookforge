#!/usr/bin/env node
/**
 * THE CLI FLAGS ORPHEUS TOOK WITH IT ARE REFUSED BY NAME (step 8, 2026-11-05).
 *
 * These parsers keep any `--flag` they are given, so a retired one would otherwise be silently
 * ignored: a user asking for a gap would get a book without one and no word about it. Each is
 * refused at its own door instead. cli/bookforge-tts.py passes `--sentence-gap` only when its user
 * gives `--sentence-gap` or `--assembly-gap`, so the refusal is what such a user now sees.
 *
 *   node tools/test-cli-retired-flags.js        (after the electron build)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(REPO, 'cli', 'electron-stub.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-retired-flags-'));
const input = path.join(scratch, 'in.txt');
fs.writeFileSync(input, 'A sentence.\n');

const CASES = [
  ['final-denoise.js', ['--process-dir', scratch, '--sentence-gap', '0.4'], /--sentence-gap is gone/],
  ['rvc-enhance.js', ['--process-dir', scratch, '--voice-id', 'x', '--sentence-gap', '0.4'], /--sentence-gap is gone/],
  ['orpheus-audiobook-render.js', ['--project', scratch, '--voice', 'x', '--engine', 'higgs', '--sentence-gap', '0.4'], /--sentence-gap is gone/],
  ['orpheus-audiobook-render.js', ['--project', scratch, '--voice', 'x', '--engine', 'higgs', '--de-ring'], /--de-ring is gone/],
  ['orpheus-audiobook-render.js', ['--project', scratch, '--voice', 'x', '--engine', 'orpheus'], /--engine orpheus: Orpheus is retired/],
  ['orpheus-batch-render.js', ['--voice', 'x', '--engine', 'orpheus', '--input', input, '--out', path.join(scratch, 'o.wav')], /--engine orpheus: Orpheus is retired/],
];

let failed = 0;
try {
  for (const [cli, args, refusal] of CASES) {
    const name = `${cli} ${args.filter((a) => a.startsWith('--') && !['--process-dir', '--project', '--voice', '--voice-id', '--input', '--out'].includes(a)).join(' ')}`;
    try {
      const r = spawnSync(process.execPath, ['--require', STUB, path.join(REPO, 'cli', cli), ...args], { encoding: 'utf8', timeout: 60000 });
      const said = `${r.stdout}${r.stderr}`;
      assert.notStrictEqual(r.status, 0, 'it exited 0');
      assert.match(said, refusal, `it did not refuse by name: ${said.slice(-300)}`);
      console.log(`  ok    ${name} is refused by name`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\ncli retired flags: ${CASES.length - failed}/${CASES.length} passed`);
process.exit(failed ? 1 : 0);
