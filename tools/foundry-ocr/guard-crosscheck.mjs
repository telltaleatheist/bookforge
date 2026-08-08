/**
 * Does eval-guard.py's guard decide the same thing as the SHIPPED guard?
 *
 * `eval-guard.py` scores a dump under three policies, and two of them are the
 * per-word guard. That guard's authority lives in foundry `src/ocr/guard.ts` —
 * the Python in the scorer is a PORT, and a port is a second implementation.
 * Two implementations of a safety rule drift, and when a scorer's guard drifts
 * from the stage's guard the scorer stops measuring the thing that ships: the
 * numbers stay plausible and stop being about the product.
 *
 * So this runs the SAME (src, model output) pairs through the real TypeScript
 * and fails on any disagreement — verdict, rejected-run count, or shipped text.
 * Text equality is checked byte for byte, because `per-run` REBUILDS a string
 * and the whitespace it rebuilds with is exactly the kind of detail two ports
 * get differently.
 *
 *   python3 tools/foundry-ocr/eval-guard.py score --dump lines.dump.jsonl \
 *       --emit-verdicts verdicts.jsonl
 *   bun tools/foundry-ocr/guard-crosscheck.mjs verdicts.jsonl [--foundry ../foundry]
 *
 * Run with BUN, not node: it imports foundry's TypeScript directly, so there is
 * no build step whose staleness could hide a difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const foundryFlag = argv.indexOf('--foundry');
// `--foundry <path>` takes a value, and that value is not a file to read.
const files = argv.filter((a, i) => !a.startsWith('--') && i !== foundryFlag + 1);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const foundryRoot = foundryFlag >= 0
  ? path.resolve(argv[foundryFlag + 1])
  : path.resolve(repoRoot, '..', 'foundry');

if (!files.length) {
  console.error('usage: bun tools/foundry-ocr/guard-crosscheck.mjs <verdicts.jsonl> [--foundry <path>]');
  process.exit(2);
}

const guardPath = path.join(foundryRoot, 'src', 'ocr', 'guard.ts');
if (!fs.existsSync(guardPath)) {
  console.error(`guard-crosscheck: ${guardPath} not found. Pass --foundry <path to the foundry checkout>.`);
  process.exit(2);
}
const { ocrGuardResolve, OCR_GUARD_SHIPPED_POLICY } = await import(`file://${guardPath.replace(/\\/g, '/')}`);

let rows = 0;
let mismatches = 0;
const shown = [];

for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    rows++;
    for (const [policy, want] of [['whole-unit', r.wholeUnit], ['per-run', r.perRun]]) {
      const got = ocrGuardResolve(r.src, r.out, { policy });
      const bad = [];
      if (got.ok !== want.ok) bad.push(`ok ${got.ok} vs ${want.ok}`);
      if (got.text !== want.text) bad.push(`text differs`);
      if (got.rejectedRuns !== want.rejectedRuns) bad.push(`rejectedRuns ${got.rejectedRuns} vs ${want.rejectedRuns}`);
      if (got.acceptedRuns !== want.acceptedRuns) bad.push(`acceptedRuns ${got.acceptedRuns} vs ${want.acceptedRuns}`);
      if (!bad.length) continue;
      mismatches++;
      if (shown.length < 10) {
        shown.push({ policy, why: bad.join(', '), src: r.src, out: r.out, ts: got.text, py: want.text });
      }
    }
  }
}

console.log(`guard-crosscheck — ${rows} pairs x 2 policies against ${guardPath}`);
console.log(`  shipped policy: ${OCR_GUARD_SHIPPED_POLICY}`);
for (const m of shown) {
  console.log(`\n  MISMATCH (${m.policy}): ${m.why}`);
  console.log(`    SRC ${JSON.stringify(m.src)}`);
  console.log(`    OUT ${JSON.stringify(m.out)}`);
  console.log(`    ts  ${JSON.stringify(m.ts)}`);
  console.log(`    py  ${JSON.stringify(m.py)}`);
}
if (mismatches) {
  console.log(`\n  ${mismatches} MISMATCHES — the scorer is not measuring the shipped guard.`);
  process.exit(1);
}
console.log(`  ${rows * 2} verdicts, 0 mismatches.`);
