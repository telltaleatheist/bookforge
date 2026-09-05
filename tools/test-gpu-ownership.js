/**
 * Tests for the "someone else already owns this Mac's GPU" refusal.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-gpu-ownership.js
 *
 * The guard's whole job is telling a stranger's render from our own, and every
 * way it can be wrong is a way it fails silently in exactly one direction:
 *
 * TOO EAGER and the app refuses to render at all — the CLI's own parent chain
 * (`bookforge-tts.py` -> `node orpheus-batch-render.js` -> this process) matches
 * the very patterns we search for, our own workers carry `--session`, and the
 * resident Listen server (`python -m narrator.serve`) has coexisted with audiobook
 * renders since it shipped. Any of those counted as a stranger and nobody can
 * start a book.
 *
 * TOO SLACK and we get Sep 1 2026 again: an orphaned worker.py rendering for
 * 1h31m, a second worker started on top of it, a third from a CLI run over ssh,
 * 55-60 GB wired and the renderer OOM-killed.
 *
 * So the fixtures are a real `ps -Ao pid,ppid,etime,command` shape, with the
 * near-misses that a substring match would get wrong: `separator_worker.py`
 * (not `worker.py`), a Flask `app.py` (not e2a's `app.py --worker_mode`), and a
 * `--sentences_dir` path that contains the session id without being `--session`.
 *
 * Pure: no processes are spawned, nothing touches the GPU.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const MODULE = path.join(REPO, 'dist', 'shared', 'tts', 'gpu-ownership.js');
if (!fs.existsSync(MODULE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const {
  parsePsRows,
  ancestorPids,
  findForeignRenders,
  gpuOwnershipRefusal,
  gpuOwnershipOverrideNote,
  describeForeignRender,
  ALLOW_SHARED_GPU_ENV,
  COMMAND_PREVIEW_CHARS,
} = require(MODULE);

let failures = 0;
function check(cond, label) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.log(`  FAIL ${label}`); failures++; }
}

// ── The world ────────────────────────────────────────────────────────────────
// Pids chosen to make the chains readable:
//   1      launchd
//   400    sshd (the PC's fine-tuning agent came in this way)
//   410    python cli/bookforge-tts.py --voice=thirdreich      <- our ancestor
//   420    node cli/orpheus-batch-render.js                     <- OUR PROCESS
//   430    worker.py --session ours-1234                        <- our own worker
//   900    worker.py --session someone-else                     <- THE ORPHAN
//   910    app.py --worker_mode --session other                 <- foreign full worker
//   920    python cli/bookforge-tts.py (another machine's run)   <- foreign CLI
//   930    node cli/orpheus-batch-render.js (its child)          <- foreign CLI render
//   700    python -m narrator.serve (the resident Listen server) <- never a fault
//   710    separator_worker.py (audio separation)                <- NOT worker.py
//   720    python app.py (someone's Flask app)                   <- NOT e2a
const E2A = '/Users/telltale/Projects/ebook2audiobook-latest';
const PY = '/Users/telltale/Library/Application Support/BookForge/runtime/e2a-env/bin/python';
const OUR_SESSION = 'ours-1234-abcd';

const PS = [
  '  PID  PPID     ELAPSED COMMAND',
  '    1     0 24-03:25:14 /sbin/launchd',
  '  400     1    02:10:00 sshd: telltale@notty',
  `  410   400    01:40:11 ${PY} ${E2A}/../BookForgeApp/cli/bookforge-tts.py --voice=thirdreich --input book.epub`,
  `  420   410    01:40:09 node --require ./cli/electron-stub.js cli/orpheus-batch-render.js --voice thirdreich --input passage.txt`,
  `  430   420    01:39:02 ${PY} ${E2A}/worker.py --session ${OUR_SESSION} --sentence_start 0 --sentence_end 5312`,
  `  700     1    09:12:44 ${PY} -u -m narrator.serve`,
  `  710     1       04:31 ${PY} electron/scripts/separator_worker.py --model htdemucs`,
  '  720     1     1:02:00 /usr/bin/python3 /Users/telltale/dashboards/app.py --port 5000',
  `  900     1    01:31:07 ${PY} ${E2A}/worker.py --session orphan-9999 --sentences_dir /Volumes/iO/bookforge/projects/Kershaw/stages/03-tts --sentence_start 0 --sentence_end 4210`,
  `  910     1       12:03 ${PY} ${E2A}/app.py --headless --worker_mode --session other-5555 --tts_engine orpheus`,
  '  920   400       06:45 /usr/bin/python3 cli/bookforge-tts.py --voice=rohan --input other.epub',
  '  930   920       06:44 node --require ./cli/electron-stub.js cli/orpheus-batch-render.js --voice rohan',
].join('\n');

// ── parsing ──────────────────────────────────────────────────────────────────
console.log('parsing `ps -Ao pid,ppid,etime,command`');
{
  const rows = parsePsRows(PS);
  check(rows.length === 12, `header dropped, 12 process rows (got ${rows.length})`);
  check(rows[0].pid === 1 && rows[0].ppid === 0 && rows[0].etime === '24-03:25:14',
    'day-form ELAPSED (24-03:25:14) parses as one field');
  const worker = rows.find((r) => r.pid === 900);
  check(worker.etime === '01:31:07', 'the orphan\'s elapsed time survives verbatim');
  check(worker.command.includes('--sentence_end 4210'),
    'the command keeps every space-separated argument (only the first 3 fields are delimited)');
  const sshd = rows.find((r) => r.pid === 400);
  check(sshd.command === 'sshd: telltale@notty', 'a command containing a colon is not mangled');
  check(parsePsRows('').length === 0 && parsePsRows('  PID  PPID     ELAPSED COMMAND\n').length === 0,
    'an empty list, and a header with no rows, are both empty');
}

// ── the ancestor chain ───────────────────────────────────────────────────────
console.log('the caller\'s own chain');
{
  const rows = parsePsRows(PS);
  assert.deepStrictEqual(ancestorPids(rows, 420), [420, 410, 400, 1]);
  check(true, 'node orpheus-batch-render.js -> bookforge-tts.py -> sshd -> launchd');
  assert.deepStrictEqual(ancestorPids(rows, 999999), [999999]);
  check(true, 'a pid missing from the snapshot is its own whole chain');
  // A corrupt snapshot must not hang the guard.
  const cyclic = parsePsRows('  PID  PPID ELAPSED COMMAND\n  50    51   00:01 a\n  51    50   00:01 b');
  check(ancestorPids(cyclic, 50).length === 2, 'a ppid cycle terminates instead of looping');
}

// ── selection: run as the CLI ────────────────────────────────────────────────
console.log('selection — the CLI (pid 420) asking, with its own session already spawned');
{
  const found = findForeignRenders(PS, { selfPid: 420, sessionId: OUR_SESSION });
  const pids = found.map((p) => p.pid);
  assert.deepStrictEqual(pids, [900, 910, 920, 930], `foreign pids were ${JSON.stringify(pids)}`);
  check(true, 'exactly the four strangers, in pid order');

  check(!pids.includes(410) && !pids.includes(420),
    'the CLI\'s own chain (bookforge-tts.py 410, orpheus-batch-render.js 420) is the CALLER, not a stranger');
  check(!pids.includes(430), 'our own worker.py is excluded by --session ' + OUR_SESSION);
  check(!pids.includes(700), 'the resident Listen server (-m narrator.serve) is not a fault');
  check(!pids.includes(710), 'separator_worker.py is not worker.py (name boundary, not substring)');
  check(!pids.includes(720), 'a bare app.py is somebody\'s Flask app, not an e2a batch worker');

  const byPid = Object.fromEntries(found.map((p) => [p.pid, p]));
  check(byPid[900].kind === 'e2a-worker', 'the orphaned worker.py is classed e2a-worker');
  check(byPid[910].kind === 'e2a-app-worker', 'app.py --worker_mode is classed e2a-app-worker');
  check(byPid[920].kind === 'cli-tts', 'a foreign bookforge-tts.py is classed cli-tts');
  check(byPid[930].kind === 'cli-batch-render', 'a foreign orpheus-batch-render.js is classed cli-batch-render');
}

// ── selection: run as the app, before any worker exists ──────────────────────
console.log('selection — Electron (pid 42) asking, no worker of ours yet');
{
  // Electron is not in this snapshot at all, so its chain is just itself. The
  // CLI chain is now genuinely foreign, and so is our-session-that-isn\'t-ours.
  const found = findForeignRenders(PS, { selfPid: 42, sessionId: 'fresh-session-0001' });
  const pids = found.map((p) => p.pid);
  assert.deepStrictEqual(pids, [410, 420, 430, 900, 910, 920, 930], `got ${JSON.stringify(pids)}`);
  check(true, 'a CLI render started from another terminal IS a stranger to the app');
  check(!pids.includes(700), 'the Listen server stays excluded whoever is asking');
}

// ── selection: the session id must be matched as an argument, not a substring ─
console.log('session-id matching');
{
  const sneaky = [
    '  PID  PPID ELAPSED COMMAND',
    `  901     1   00:30 ${PY} ${E2A}/worker.py --session other-1 --sentences_dir /lib/${OUR_SESSION}/sentences`,
  ].join('\n');
  const found = findForeignRenders(sneaky, { selfPid: 42, sessionId: OUR_SESSION });
  check(found.length === 1 && found[0].pid === 901,
    'our session id appearing inside --sentences_dir does not make a stranger ours');

  const equalsForm = [
    '  PID  PPID ELAPSED COMMAND',
    `  902     1   00:30 ${PY} ${E2A}/worker.py --session=${OUR_SESSION} --sentence_start 0`,
  ].join('\n');
  check(findForeignRenders(equalsForm, { selfPid: 42, sessionId: OUR_SESSION }).length === 0,
    '--session=<id> is recognised as ours as well as --session <id>');

  check(findForeignRenders(PS, { selfPid: 420, sessionId: null }).length === 5,
    'with no session id, our own worker.py counts too — the caller must pass one');
}

// ── the message the user actually sees ───────────────────────────────────────
console.log('the refusal');
{
  const found = findForeignRenders(PS, { selfPid: 420, sessionId: OUR_SESSION });
  const text = gpuOwnershipRefusal(found);
  check(text.includes('900') && text.includes('01:31:07'),
    'the orphan is named by pid AND by how long it has been running');
  check(text.includes('worker.py'), 'the command is quoted so the user can recognise it');
  check(/910[\s\S]*920[\s\S]*930/.test(text), 'every offender is listed, not just the first');
  check(text.includes(ALLOW_SHARED_GPU_ENV + '=1'), 'the override is named in the message');
  check(/[Ss]top that render/.test(text), 'the message says what to do about it');

  const one = gpuOwnershipRefusal([found[0]]);
  check(one.startsWith('Another Orpheus render is already using'),
    'one offender reads as one, not "1 other Orpheus renders"');

  const orphanLine = describeForeignRender(found.find((p) => p.pid === 900));
  check(orphanLine.includes('worker.py --session orphan-9999'),
    'the preview starts at the script, not at the 87-character interpreter path');
  check(orphanLine.startsWith('  pid 900  running 01:31:07  …worker.py'),
    'the elided interpreter prefix is marked with a leading ellipsis');

  const long = 'worker.py ' + 'x'.repeat(400);
  const line = describeForeignRender({ pid: 7, ppid: 1, etime: '00:01', command: '/opt/py ' + long, kind: 'e2a-worker', script: 'worker.py' });
  check(line.includes('x'.repeat(COMMAND_PREVIEW_CHARS - 'worker.py '.length))
    && !line.includes('x'.repeat(COMMAND_PREVIEW_CHARS)),
    `a runaway argv is cut at ${COMMAND_PREVIEW_CHARS} chars so the pid stays readable`);
  check(line.endsWith('…'), 'the cut is marked');
}

console.log('the override note');
{
  const found = findForeignRenders(PS, { selfPid: 420, sessionId: OUR_SESSION });
  const note = gpuOwnershipOverrideNote(found);
  check(note.startsWith(ALLOW_SHARED_GPU_ENV + '=1'), 'the note says which switch let it through');
  check(note.includes('900') && note.includes('930'),
    'the override still prints the list — proceeding quietly is how the night got lost');
  check(!note.includes('Stop that render'), 'the note does not tell you to stop something you chose to share with');
}

console.log('a clear machine');
{
  const clean = [
    '  PID  PPID     ELAPSED COMMAND',
    '    1     0 24-03:25:14 /sbin/launchd',
    `  700     1    09:12:44 ${PY} -u -m narrator.serve`,
  ].join('\n');
  check(findForeignRenders(clean, { selfPid: 42, sessionId: 'x' }).length === 0,
    'nothing but launchd and the Listen server: the GPU is ours');
}

console.log(failures === 0 ? '\nAll GPU-ownership checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
