#!/usr/bin/env node
/**
 * The Listen server's spawn changed EXACTLY as much as it was supposed to.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-serve-spawn-env.js
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * Phase 2 of the e2a removal replaces `python <orpheus_stream.py>` with
 * `python -u -m narrator.serve`. `serve/worker.py` is a faithful port of that
 * script and PORT_NOTES section 9.4 lists 33 environment variables that keep
 * their name, value, default and precedence through the move. Every one of those
 * is a SILENT failure if it goes missing: drop `VLLM_USE_V1` and streaming keeps
 * working until the next vLLM bump; drop `ORPHEUS_DISABLE_EAGER` and CUDA graphs
 * quietly stop capturing, which costs 6x and looks like "WSL is slow today";
 * drop `ORPHEUS_STREAM_WARM_MAX` and every server start pays 176 s of warm-up
 * nobody asked for.
 *
 * A diff cannot prove that, because a rewritten function is a rewritten function
 * either way. So `tools/snapshots/serve-spawn-base.json` holds the plan the REAL
 * `buildSpawnPlan` produced on the commit before the cut-over, this re-runs it,
 * and the two are compared field by field against a list of the changes that were
 * intended. Anything else — a variable gone, a value changed, a flag moved — is a
 * failure that names itself.
 *
 * ── IT MUST GIVE THE SAME ANSWER ON WINDOWS AND ON A MAC ────────────────────
 *
 * A stated property, because it was broken and the breakage was invisible. Only
 * the `native-mac` fixture forced `process.platform`, so on a macOS host the `wsl`
 * and `native-win` fixtures resolved through the darwin branch and every row came
 * back as the Mac conda invocation — a capture that compares equal to itself while
 * describing an arm it never built. And `path.join` uses the HOST's separator
 * (faking the platform does not change it — the path module binds win32/posix at
 * load), so the same run stored `<REPO>\python` on Windows and `<REPO>/python` on
 * a Mac.
 *
 * Three rules keep it true: the extractor forces `process.platform` per fixture
 * arm, `canon()` collapses this checkout's location to one `<REPO>` token with
 * separators normalised, and `hostNeutral()` applies that same normalisation to
 * the stored BASELINE at read time — because that file records code that no longer
 * exists and cannot be regenerated.
 *
 * ── The intended changes ────────────────────────────────────────────────────
 *
 * Four, from PORT_NOTES section 9, on every arm:
 *
 *   1. the script path became `-m narrator.serve`
 *   2. `EBOOK2AUDIOBOOK_PATH` removed  (the sys.path bootstrap; narrator never
 *      reads it)
 *   3. `PYTHONPATH` added             (`-m` resolves the module before any of its
 *      code runs, so it cannot bootstrap itself)
 *   4. `NARRATOR_ENGINE` added        (names the engine this worker serves)
 *
 * Plus two that are consequences rather than choices, listed separately so they
 * are argued rather than absorbed:
 *
 *   5. cwd moved off the e2a root. Both arms used to `cd` there because
 *      `orpheus_stream.py:get_e2a_path()` read cwd as a fallback bootstrap.
 *      `narrator.serve` reads cwd for nothing (PORT_NOTES 9.3).
 *   6. macOS ONLY: the interpreter moved from the ebook2audiobook Orpheus env to
 *      `narrator-mlx`. The Mac backend needs mlx 0.32.0 / mlx-lm 0.31.3 /
 *      mlx-audio 0.4.8 and the e2a env is below two of those pins — it would not
 *      fail, it would decline to overlap decoding and read as a slow Mac.
 *
 * The 33 variables are the part that must NOT move, and the assertions below are
 * about them.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, 'snapshots', 'serve-spawn-base.json');
const ARMS = ['wsl', 'native-win', 'native-mac'];

if (!fs.existsSync(path.join(REPO, 'dist', 'electron', 'orpheus-worker-pool.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/**
 * THE BASELINE IS NORMALISED AT COMPARISON TIME, not rewritten.
 *
 * `serve-spawn-base.json` is the spawn as it stood BEFORE the cut-over. That code
 * is gone, so it cannot be regenerated — which means the host-independence fix
 * (collapsing `<REPO-WSL>` into `<REPO>` and normalising separators) has to be
 * applied to BOTH sides at read time instead of baked into the file. The stored
 * bytes stay what they were: a historical capture, from Windows, on 0f0a68d5.
 *
 * Without this the keeper is host-dependent in the same way the extractor was:
 * `path.join` uses the HOST's separator (faking `process.platform` does not change
 * it — the path module binds win32/posix at load), so a Mac would produce
 * `<REPO>/python` against a baseline holding `<REPO>\python` and every arm would
 * fail on a difference that is about the machine, not the spawn.
 */
function hostNeutral(value) {
  if (typeof value === 'string') {
    return value.split('<REPO-WSL>').join('<REPO>').replace(/\\/g, '/');
  }
  if (Array.isArray(value)) return value.map(hostNeutral);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hostNeutral(v)]));
  }
  return value;
}

const base = hostNeutral(JSON.parse(fs.readFileSync(BASE, 'utf-8')));
const now = {};
for (const arm of ARMS) {
  now[arm] = hostNeutral(JSON.parse(execFileSync(
    process.execPath,
    [path.join(__dirname, 'serve-spawn-extract.js'), arm],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
  )));
}

/** The environment an arm sends the worker, whichever arm shape it has. */
function envOf(cap) {
  return cap.viaWsl ? cap.bash.exports : cap.env;
}
/** The command line, as one string, whichever arm shape it has. */
function cmdOf(cap) {
  return cap.viaWsl ? cap.bash.run : [cap.command, ...cap.args].join(' ');
}

const ADDED = ['PYTHONPATH', 'NARRATOR_ENGINE'];
const REMOVED = ['EBOOK2AUDIOBOOK_PATH'];

console.log('the 33 preserved variables');
for (const arm of ARMS) {
  const before = envOf(base[arm]);
  const after = envOf(now[arm]);

  check(`${arm}: every variable that survived kept its EXACT value`, () => {
    const changed = [];
    for (const [k, v] of Object.entries(before)) {
      if (REMOVED.includes(k)) continue;
      if (!(k in after)) { changed.push(`${k}: GONE (was ${JSON.stringify(v)})`); continue; }
      if (after[k] !== v) changed.push(`${k}: ${JSON.stringify(v)} -> ${JSON.stringify(after[k])}`);
    }
    assert.strictEqual(changed.length, 0,
      'the cut-over changed variables it was supposed to preserve:\n' + changed.join('\n'));
  });

  check(`${arm}: the ONLY new variables are PYTHONPATH and NARRATOR_ENGINE`, () => {
    const added = Object.keys(after).filter((k) => !(k in before)).sort();
    assert.deepStrictEqual(added, [...ADDED].sort(),
      'unexpected new environment variable(s): ' + JSON.stringify(added));
  });

  check(`${arm}: the ONLY removed variable is EBOOK2AUDIOBOOK_PATH`, () => {
    const gone = Object.keys(before).filter((k) => !(k in after)).sort();
    assert.deepStrictEqual(gone, [...REMOVED].sort(),
      'unexpected removal(s): ' + JSON.stringify(gone));
  });
}

console.log('the four intended changes actually happened');
for (const arm of ARMS) {
  const after = envOf(now[arm]);

  check(`${arm}: the command is now -m narrator.serve, and names no script file`, () => {
    assert.match(cmdOf(now[arm]), /-u -m narrator\.serve$/,
      'the command line does not end in `-u -m narrator.serve`: ' + cmdOf(now[arm]));
    assert.ok(!/orpheus_stream\.py|\.py(?:$|\s)/.test(cmdOf(now[arm])),
      'a python SCRIPT path survived in the command: ' + cmdOf(now[arm]));
  });

  check(`${arm}: PYTHONPATH points at the narrator package`, () => {
    assert.ok(after.PYTHONPATH, 'PYTHONPATH is not set');
    assert.match(after.PYTHONPATH, /python$/, 'PYTHONPATH is not <repo>/python: ' + after.PYTHONPATH);
    if (now[arm].viaWsl) {
      assert.ok(!/^[A-Za-z]:/.test(after.PYTHONPATH) && !after.PYTHONPATH.includes('\\'),
        'PYTHONPATH crossed into WSL as a Windows path: ' + after.PYTHONPATH);
    }
  });

  check(`${arm}: NARRATOR_ENGINE names orpheus`, () => {
    assert.strictEqual(after.NARRATOR_ENGINE, 'orpheus');
  });

  check(`${arm}: EBOOK2AUDIOBOOK_PATH is gone from the env AND the command`, () => {
    assert.ok(!('EBOOK2AUDIOBOOK_PATH' in after));
    assert.ok(!/EBOOK2AUDIOBOOK_PATH/.test(cmdOf(now[arm])));
  });
}

console.log('--fake-engine never reaches a production spawn');
check('no arm passes the protocol-test flag', () => {
  // It is an argv flag rather than an env var precisely so the pool cannot enable
  // it by forwarding process.env (PORT_NOTES 9.6). The only way it could ship is
  // somebody adding it here, which is what this refuses.
  for (const arm of ARMS) {
    assert.ok(!/--fake-engine/.test(JSON.stringify(now[arm])),
      `${arm} carries --fake-engine`);
  }
});

console.log('cwd left the e2a root, and is a directory that exists');
for (const arm of ARMS) {
  check(`${arm}: no longer cd's into the ebook2audiobook checkout`, () => {
    if (now[arm].viaWsl) {
      assert.strictEqual(now[arm].bash.cd, 'cd ~',
        'the guest cwd is not the WSL home: ' + now[arm].bash.cd);
      assert.notStrictEqual(now[arm].bash.cd, base[arm].bash.cd);
    } else {
      assert.ok(!/FAKE[\\/]e2a$/.test(now[arm].cwd),
        'the native cwd is still the e2a root: ' + now[arm].cwd);
    }
  });
}

console.log('the capture says the same thing on Windows and on a Mac');
check('no captured value carries a host path separator', () => {
  // The exact shape of the failure a macOS host reported: `path.join` gives
  // `<REPO>\python` on Windows and `<REPO>/python` on a Mac, so an un-normalised
  // capture can never match across the two. Checkable from one host.
  const blob = JSON.stringify(now);
  const at = blob.indexOf(String.fromCharCode(92));
  assert.strictEqual(at, -1,
    'a backslash survived canon() near: ' + blob.slice(Math.max(0, at - 90), at + 60));
});
check('the extractor forces the platform per fixture arm', () => {
  // Cannot be observed from a Windows host for the two win32 arms, so it is
  // asserted on the source: without it a macOS host resolves `wsl` and
  // `native-win` through the darwin branch and compares a capture it never built.
  const src = fs.readFileSync(path.join(__dirname, 'serve-spawn-extract.js'), 'utf-8');
  assert.match(src, /ARM === 'native-mac' \? 'darwin' : 'win32'/,
    'the extractor no longer forces process.platform from the fixture arm');
});

console.log('macOS moved to the narrator-mlx environment');
check('the mac arm runs the narrator-mlx env, not the ebook2audiobook one', () => {
  // The ONE difference beyond the four, and the one this file exists to make
  // visible rather than let ride along: mlx 0.32.0 / mlx-lm 0.31.3 /
  // mlx-audio 0.4.8 are hard floors, and the e2a env is below two of them.
  const line = cmdOf(now['native-mac']);
  assert.match(line, /narrator-mlx/, 'the mac arm does not name narrator-mlx: ' + line);
  assert.notStrictEqual(cmdOf(now['native-mac']), cmdOf(base['native-mac']));
});
check('the other two arms did NOT change interpreter', () => {
  // Everything up to `-u` is the interpreter and how it is reached (conda run, a
  // relocatable python, the WSL env by name). Everything after it is what
  // changed. Only the mac row may differ on the left of that split.
  const interpreter = (line) => line.split(' -u ')[0];
  for (const arm of ['wsl', 'native-win']) {
    assert.strictEqual(interpreter(cmdOf(now[arm])), interpreter(cmdOf(base[arm])),
      `${arm}'s interpreter changed: ${cmdOf(base[arm])} -> ${cmdOf(now[arm])}`);
  }
});

console.log(failures === 0 ? '\nAll serve-spawn checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
