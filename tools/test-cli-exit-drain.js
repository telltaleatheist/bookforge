#!/usr/bin/env node
/**
 * test-cli-exit-drain — a script that writes then process.exit()s over a PIPE
 * can lose whatever stdout has not drained yet.
 *
 *   node tools/test-cli-exit-drain.js
 *
 * ── The defect this guards ───────────────────────────────────────────────────
 *
 * Measured on another repo under WSL2 node v18: a wrapper script that does one
 * large `process.stdout.write(...)` (or a big JSON/JSONL console.log) and then
 * calls `process.exit(code)` can lose whatever stdout has not drained yet WHEN
 * STDOUT IS A PIPE — output cut at ~65 KB, exit code 0, empty stderr. The bug is
 * silent: the caller sees a clean exit and truncated data, not a crash.
 *
 * Windows node v20 (this machine, checked below) happens to drain synchronous
 * pipe writes before the process dies, which is exactly what hid the defect
 * here — so part 1 below documents rather than asserts the process.exit()
 * fixture's behavior on THIS platform, and asserts only that the fixed pattern
 * (`process.exitCode = code`, then return and let the event loop drain) is
 * never lossy anywhere.
 *
 * ── Two parts ─────────────────────────────────────────────────────────────────
 *
 *  1. Two tiny fixture scripts, each spawned through a real PIPE, each writing
 *     ~300 KB of JSONL before exiting — one via `process.exitCode`, one via
 *     `process.exit()`. The exitCode fixture's output MUST arrive byte-for-byte
 *     whole; that is the one assertion. The process.exit() fixture's outcome is
 *     printed as a note, not a pass/fail — it is platform- and timing-dependent
 *     by nature of the bug, and asserting it either way would make this suite
 *     flaky where the drain happens to succeed and useless where it doesn't.
 *
 *  2. A source scan of every pipe-facing wrapper this campaign (fix/cli-exit-
 *     drain) converted — `cli/*.js`, `electron/scripts/*.js`, `tools/*.js`
 *     minus the `tools/test-*.js` keepers themselves — that FAILS if a
 *     `process.exit(` survives on a normal completion path. A signal-handler /
 *     process-replacement abort path is still allowed to call it directly (that
 *     class of exit needs to happen immediately and has nothing buffered to
 *     lose), recognised by an inline `process.on('SIG...` on the same line, or
 *     by an explicit `// abort-path` comment on the exit line or in the
 *     rationale immediately above it.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${name}`))
    .catch((err) => {
      failures++;
      console.log(`FAIL  ${name}\n      ${err && err.message}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 1 — the actual drain behavior, over a real pipe
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic ~300 KB of JSONL, so the expected byte count is exact. */
function buildPayload() {
  const rows = [];
  let bytes = 0;
  let i = 0;
  while (bytes < 300 * 1024) {
    const line = JSON.stringify({ i, text: 'x'.repeat(80), note: 'cli-exit-drain fixture row' }) + '\n';
    rows.push(line);
    bytes += Buffer.byteLength(line, 'utf-8');
    i++;
  }
  return rows.join('');
}

/**
 * Spawn `node <fixture> <payloadFile>` over a real pipe and collect whatever
 * stdout actually arrives. Resolves once the child's stdio has fully closed —
 * the correct point to have every byte the child managed to flush, whether it
 * exited cleanly, immediately, or anywhere in between.
 */
function runFixture(fixturePath, payloadPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, payloadPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr, received: Buffer.concat(chunks) });
    });
  });
}

async function runDrainFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exit-drain-'));
  const payload = buildPayload();
  const expectedBytes = Buffer.byteLength(payload, 'utf-8');
  const payloadPath = path.join(dir, 'payload.jsonl');
  fs.writeFileSync(payloadPath, payload, 'utf-8');

  const exitCodeFixture = path.join(dir, 'fixture-exitcode.js');
  fs.writeFileSync(exitCodeFixture,
    "'use strict';\n" +
    "const fs = require('fs');\n" +
    "const payload = fs.readFileSync(process.argv[2]);\n" +
    "process.stdout.write(payload);\n" +
    "// THE FIX: set exitCode and return — never process.exit() after output.\n" +
    "process.exitCode = 0;\n",
    'utf-8');

  const processExitFixture = path.join(dir, 'fixture-processexit.js');
  fs.writeFileSync(processExitFixture,
    "'use strict';\n" +
    "const fs = require('fs');\n" +
    "const payload = fs.readFileSync(process.argv[2]);\n" +
    "process.stdout.write(payload);\n" +
    "// THE BUG: exit right after a large write over a pipe can lose the tail.\n" +
    "process.exit(0);\n",
    'utf-8');

  try {
    await check('exitCode fixture: full 300 KB payload arrives whole', async () => {
      const result = await runFixture(exitCodeFixture, payloadPath);
      assert.strictEqual(result.code, 0, `exit code was ${result.code}, stderr: ${result.stderr}`);
      assert.strictEqual(result.received.length, expectedBytes,
        `received ${result.received.length} bytes, expected ${expectedBytes} — ` +
        'exitCode + return dropped output, which is exactly the regression this guards against');
      assert.strictEqual(result.received.toString('utf-8'), payload, 'received bytes differ from the payload');
    });

    // Documented, not asserted — see the header. On this platform (Windows,
    // node v20) the write typically drains before the process dies anyway,
    // which is the exact situation that hid the original bug; a slower node,
    // WSL2, or a larger payload can flip this without the fix being wrong.
    const direct = await runFixture(processExitFixture, payloadPath);
    const truncated = direct.received.length !== expectedBytes;
    console.log(
      `  note  process.exit() fixture: ${direct.received.length}/${expectedBytes} bytes arrived ` +
      `(${truncated ? 'TRUNCATED on this run — the bug reproduced' : 'arrived whole on this run — platform/timing did not lose it here'})`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Part 2 — source scan: no bare process.exit() on a normal completion path
// ─────────────────────────────────────────────────────────────────────────────

function jsFilesIn(relDir) {
  const full = path.join(REPO, relDir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(relDir, f));
}

/** cli/*.js and electron/scripts/*.js are pipe-facing wrappers in full; under
 * tools/*.js the test-*.js keepers are excluded — they print small human text
 * and were never in scope for the conversion this scan checks. */
const SCOPE_FILES = [
  ...jsFilesIn('cli'),
  ...jsFilesIn('electron/scripts'),
  ...jsFilesIn('tools').filter((f) => !path.basename(f).startsWith('test-')),
];

const EXIT_RE = /process\.exit\(/;
const ABORT_MARK_RE = /abort-path/;
const INLINE_SIGNAL_RE = /process\.on\(\s*['"]SIG/;

/**
 * A process.exit( on line `idx` is legitimate only as an abort path: an inline
 * `process.on('SIG...` on the same line, an `// abort-path` marker on the exit
 * line itself, or one in the rationale comment block immediately above it (the
 * electron-relaunch.js shape — a multi-line comment, then the call). Walking
 * upward stops as soon as a line is neither a comment, blank, nor another exit
 * call, since that means we have left this call's immediate context.
 */
function isLegitimateAbortExit(lines, idx) {
  const line = lines[idx];
  if (ABORT_MARK_RE.test(line) || INLINE_SIGNAL_RE.test(line)) return true;
  for (let back = 1; back <= 20 && idx - back >= 0; back++) {
    const prev = lines[idx - back];
    if (ABORT_MARK_RE.test(prev)) return true;
    const isCommentOrBlankOrExit =
      /^\s*(\/\/|\/\*|\*)/.test(prev) || prev.trim() === '' || EXIT_RE.test(prev);
    if (!isCommentOrBlankOrExit) break;
  }
  return false;
}

function scanForBareExits() {
  const offenders = [];
  for (const relPath of SCOPE_FILES) {
    const full = path.join(REPO, relPath);
    const lines = fs.readFileSync(full, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      // A `process.exit(` NAMED IN A COMMENT is not a call. The scan counted one,
      // so a comment explaining why an exit was REMOVED failed the check that it was
      // removed — which teaches people to delete the explanation. The line-comment
      // strip omits `$` on purpose: this repo is core.autocrlf=true and a split on
      // '\n' leaves the '\r' behind.
      const code = line.replace(/\/\/.*/, '');
      if (!EXIT_RE.test(code)) return;
      if (!isLegitimateAbortExit(lines, i)) {
        offenders.push(`${relPath}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  return offenders;
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('cli-exit-drain — pipe-facing wrappers set exitCode and return, never process.exit() after output');
  console.log(`  scope: ${SCOPE_FILES.length} file(s) — ${SCOPE_FILES.join(', ')}`);

  await runDrainFixtures();

  await check('no bare process.exit() on a normal completion path in scope', () => {
    const offenders = scanForBareExits();
    assert.strictEqual(offenders.length, 0,
      `${offenders.length} bare process.exit() call(s) survive outside an abort path:\n` +
      offenders.map((o) => `      ${o}`).join('\n'));
  });

  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
