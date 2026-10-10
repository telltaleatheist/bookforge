/**
 * Keeper: no rename in electron/ bypasses electron/fs-retry.ts.
 *
 *   node tools/test-no-raw-renames.js
 *
 * Owen, 2026-10-10: *"can we make it less fragile so a temporary error like that
 * doesnt kill the whole thing?"* — after a pronunciation guide died on EPERM
 * replacing its file on the library's share. Measured the same day on
 * `\\TITAN\iO`: 18 of 300 replaces of a just-written file refused, each free
 * again within ~0.1 s; on the local disk, 0 of 300. Which paths sit on the share
 * is a fact about one library, not about the code, so EVERY rename goes through
 * the one retry policy (`renameWithRetry` / `renameSyncWithRetry`).
 *
 * Two files keep loops of their own, each over the same transient codes:
 * `metadata-tools.ts` (an in-place tag write's three-rename swap) and
 * `bounded-copy.ts` (`renameWaitingForHolders`, which tells its row each wait).
 * A single call with an answer of its own (library-trash marks a held tree in
 * place) says `// fs-retry: own policy — <why>` on the line above it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'electron');
const ALLOWED = new Set(['fs-retry.ts', 'metadata-tools.ts', 'bounded-copy.ts']);
// `fs.rename(`, `fsp.rename(`, `fsPromises.rename(`, `fs.promises.rename(`, `….renameSync(` — any module's.
const RAW = /\.rename(?:Sync)?\(/;

const offenders = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.name.endsWith('.ts') || ALLOWED.has(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      // A call whose holder is answered by a policy of its own says so on the line above.
      if (i > 0 && lines[i - 1].includes('fs-retry: own policy')) return;
      const code = line.replace(/\/\/.*$/, '');
      if (/^\s*\*/.test(code)) return; // a docblock line
      if (RAW.test(code)) offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
    });
  }
})(ROOT);

if (offenders.length > 0) {
  console.error('FAIL test-no-raw-renames — these rename without electron/fs-retry.ts:\n  '
    + offenders.join('\n  '));
  process.exit(1);
}
console.log('PASS test-no-raw-renames — every rename in electron/ goes through fs-retry');
