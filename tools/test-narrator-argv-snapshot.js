#!/usr/bin/env node
/**
 * THE SIX NARRATOR DOORS: their flags, and the plan each one produces per arm.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-argv-snapshot.js
 *
 * Successor to `test-orpheus-argv-snapshot.js`, which pinned the five e2a doors
 * and is deleted — Phase 3 replaced all five, so it could no longer run. Its
 * baseline survives as data (`tools/snapshots/orpheus-argv-base.json`, described
 * in that directory's README). This pins what replaced them.
 *
 * ── What each half catches ──────────────────────────────────────────────────
 *
 * FLAGS, read out of the source. A door losing one is silent and expensive:
 * `--session_dir` off prep and narrator refuses BY NAME (it has no e2a root to
 * fall back to); `--sentences_dir` off a worker and a resume re-renders a book
 * that was already 90% done; `--session_dir` off assembly and it refuses too.
 * A flag that MOVES is as bad as one that goes, for the same reason the old
 * progress matcher had to be deleted rather than kept: argv is positional.
 *
 * PLAN, from the real `buildNarratorSpawn` on each of three arms. The literals
 * cannot see which conda environment a door lands in, whether a path crossed into
 * WSL translated, or whether an environment variable was forwarded at all — and
 * those are exactly what the cut-over changed. A door that quietly starts
 * resolving the Orpheus env for an ASSEMBLY would still have perfect flags.
 *
 * ── IT MUST GIVE THE SAME ANSWER ON WINDOWS AND ON A MAC ────────────────────
 *
 * A stated property, not an accident, because it was broken and the breakage was
 * invisible: only the `native-mac` fixture forced `process.platform`, so on a
 * macOS host the `wsl` and `native-win` fixtures resolved through the darwin
 * branch and every row came back as the Mac conda invocation. The snapshot still
 * compared equal to itself there — the keeper reported that the WSL argv had not
 * changed while never having built one.
 *
 * Two rules keep it true. The extractor forces `process.platform` PER FIXTURE ARM
 * (in a child process per arm, so nothing leaks between them) and stubs both WSL
 * toggles from the arm rather than from the machine. And `canon()` collapses this
 * checkout's location to one `<REPO>` token with separators normalised, because
 * `path.join` uses the HOST's separator — faking `process.platform` does not change
 * that, the path module binds win32/posix at load.
 *
 * ── Regenerating ────────────────────────────────────────────────────────────
 *
 * Deliberately, and never to make this pass:
 *   node -e "..."  # see the generator in the Phase 3 commit, or:
 *   node tools/narrator-argv-extract.js flags
 *   node tools/narrator-argv-extract.js plan wsl|native-win|native-mac
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BASE = path.join(__dirname, 'snapshots', 'narrator-argv-base.json');
const ARMS = ['wsl', 'native-win', 'native-mac'];

if (!fs.existsSync(path.join(REPO, 'dist', 'electron', 'narrator-spawn.js'))) {
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

// `narrator-spawn.js` is loaded directly for the pure-function checks below.
// `electron` is not require-able here and narrator-spawn pulls it in for
// `app.getAppPath()`; one stub, and only `toGuestPath` (which touches neither) is
// called from it.
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: { app: { getAppPath: () => REPO, getPath: () => REPO, isPackaged: false }, BrowserWindow: class {} },
};
const spawnMod = require(path.join(REPO, 'dist', 'electron', 'narrator-spawn.js'));

const base = JSON.parse(fs.readFileSync(BASE, 'utf-8'));
const extract = (...args) => JSON.parse(execFileSync(
  process.execPath, [path.join(__dirname, 'narrator-argv-extract.js'), ...args],
  { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));

const flags = extract('flags');
const plans = Object.fromEntries(ARMS.map((a) => [a, extract('plan', a)]));

// ─────────────────────────────────────────────────────────────────────────────
console.log('the flags each door sends');
// ─────────────────────────────────────────────────────────────────────────────

check('every door in the baseline is still present', () => {
  assert.deepStrictEqual(Object.keys(flags).sort(), Object.keys(base.flags).sort());
});

for (const door of Object.keys(base.flags)) {
  check(`${door}: argv unchanged`, () => {
    assert.strictEqual(flags[door], base.flags[door],
      `the ${door} door's flags moved.\n\nbefore: ${base.flags[door]}\n\nafter:  ${flags[door]}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('the flags narrator REQUIRES, present by name');
// ─────────────────────────────────────────────────────────────────────────────
//
// Not a diff — a fact about narrator's contract, asserted directly, so it holds
// even if somebody regenerates the baseline.

const REQUIRED = {
  prep: ['--session', '--session_dir', '--ebook', '--prep_only', '--tts_engine'],
  worker: ['--session', '--session_dir', '--sentences_dir', '--tts_engine'],
  retake: ['--session', '--session_dir', '--sentences_dir', '--tts_engine'],
  'assembly-render': ['--session', '--session_dir', '--output_dir', '--assemble_only'],
  'assembly-reassembly': ['--session', '--session_dir', '--output_dir', '--assemble_only'],
};
for (const [door, must] of Object.entries(REQUIRED)) {
  check(`${door}: carries ${must.join(' ')}`, () => {
    for (const flag of must) {
      assert.ok(flags[door].includes(`'${flag}'`),
        `${door} does not carry ${flag}. narrator refuses by name without it — `
        + 'it has no e2a root to fall back to and does not guess.');
    }
  });
}

check('no door sends a flag narrator files under IGNORE as XTTS-only', () => {
  // --speed / --enable_text_splitting / --temperature / --top_p / --top_k /
  // --repetition_penalty are parsed and honoured by nobody (compat/FLAGS.md).
  // Sending one claims a setting was applied.
  const DEAD = ['--speed', '--enable_text_splitting', '--temperature', '--top_p',
    '--top_k', '--repetition_penalty', '--skip_deps'];
  for (const [door, argv] of Object.entries(flags)) {
    for (const flag of DEAD) {
      assert.ok(!argv.includes(`'${flag}'`), `${door} still sends ${flag}`);
    }
  }
});

check('no door names an ENGINE_NEAR_MISS', () => {
  // 'higgs', 'higgs-v2', 'higgs-v2-scaffold', 'higgs_v3' are refused by name on
  // the routes that resolve an engine. Every door builds its value through
  // narratorEngineId(), which is the only place the mapping lives.
  for (const [door, argv] of Object.entries(flags)) {
    const at = argv.indexOf("'--tts_engine',");
    if (at < 0) continue;
    const value = argv.slice(at + "'--tts_engine',".length).trim().split(/[,\s]/)[0];
    assert.ok(/narratorEngineId|asmEngine/.test(value),
      `${door} sends --tts_engine ${value} — it must come from narratorEngineId()`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('the plan each door produces, per arm');
// ─────────────────────────────────────────────────────────────────────────────

for (const arm of ARMS) {
  check(`${arm}: every door's plan unchanged`, () => {
    assert.deepStrictEqual(plans[arm], base.plans[arm]);
  });
}

const runOf = (row) => (row.viaWsl ? row.bash.run : [row.command, ...row.args].join(' '));
const envOf = (row) => (row.viaWsl ? row.bash.exports : row.env);

for (const arm of ARMS) {
  const doors = plans[arm].doors;

  check(`${arm}: render doors go to the ENGINE env, tools doors to the tools env`, () => {
    for (const d of ['prep', 'worker', 'retake']) {
      assert.strictEqual(envOf(doors[d]).NARRATOR_ENGINE, 'orpheus',
        `${d} does not name its engine`);
    }
    for (const d of ['assembly', 'resume', 'list']) {
      assert.ok(!('NARRATOR_ENGINE' in envOf(doors[d])),
        `${d} names an engine — it is engine-agnostic and runs in the tools env`);
    }
  });

  check(`${arm}: the tools doors are NEVER routed through WSL`, () => {
    for (const d of ['assembly', 'resume', 'list']) {
      assert.strictEqual(doors[d].viaWsl, false,
        `${d} was routed through WSL; assembly reads a session normalised onto `
        + 'Windows and the 9p mount would dominate the job');
    }
  });

  check(`${arm}: every door reaches a narrator module, never a script path`, () => {
    for (const [name, row] of Object.entries(doors)) {
      assert.match(runOf(row), /-m narrator\.(compat\.(app|worker)|serve)\b/,
        `${name} does not spawn a narrator module: ${runOf(row)}`);
      assert.ok(!/\.py(?:'|"|\s|$)/.test(runOf(row)),
        `${name} still names a python SCRIPT: ${runOf(row)}`);
    }
  });

  check(`${arm}: PYTHONPATH is set on every door`, () => {
    for (const [name, row] of Object.entries(doors)) {
      const pp = envOf(row).PYTHONPATH;
      assert.ok(pp, `${name} has no PYTHONPATH — \`-m\` cannot bootstrap sys.path`);
      assert.match(pp, /python$/, `${name}'s PYTHONPATH is not the repo's python dir: ${pp}`);
    }
    // NOT "and it is a guest path on the WSL arm". That assertion read the
    // TRANSLATED REPO PATH out of the capture, which is the one thing canon() has
    // to normalise away (the repo lives somewhere different on every machine, and
    // on a Mac host there is no drive letter to translate). The translation itself
    // is asserted below, on `toGuestPath` directly — pure string logic, same answer
    // on any host.
  });

  check(`${arm}: EBOOK2AUDIOBOOK_PATH reaches nothing`, () => {
    for (const [name, row] of Object.entries(doors)) {
      assert.ok(!('EBOOK2AUDIOBOOK_PATH' in envOf(row)), `${name} still exports it`);
      assert.ok(!/EBOOK2AUDIOBOOK_PATH/.test(runOf(row)), `${name} still names it`);
    }
  });

  check(`${arm}: --fake-engine reaches nothing`, () => {
    assert.ok(!/--fake-engine/.test(JSON.stringify(plans[arm])),
      'the protocol-test flag is in a production plan');
  });
}

console.log('the capture says the same thing on Windows and on a Mac');
check('no captured value carries a host path separator', () => {
  // THE EXACT SHAPE OF THE MAC FAILURE. `path.join` uses the HOST's separator, so
  // an un-normalised capture stores `<REPO>\python` on Windows and `<REPO>/python`
  // on a Mac and the snapshot can never agree across the two. Asserting the
  // absence of backslashes anywhere in the capture is checkable from ONE host and
  // is precisely the property that was violated.
  // WALKS THE VALUES, not `JSON.stringify` of them: serialising re-introduces
  // backslashes of its own for every escaped quote, and a refusal message quoting
  // \"WSL2 for Higgs\" would fail a check that is supposed to be about path
  // separators.
  const offenders = [];
  const walk = (v, at) => {
    if (typeof v === 'string') {
      if (v.includes(String.fromCharCode(92))) offenders.push(`${at} = ${v}`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    }
  };
  walk(plans, '');
  assert.deepStrictEqual(offenders, [], 'a host path separator survived canon()');
});
check('the extractor forces the platform per fixture arm', () => {
  // The other half, and it cannot be observed from a Windows host for the two
  // win32 arms (they would look identical either way), so it is asserted on the
  // source. Without it a macOS host resolves `wsl` and `native-win` through the
  // darwin branch and the snapshot compares equal to itself while describing
  // nothing.
  const src = fs.readFileSync(path.join(__dirname, 'narrator-argv-extract.js'), 'utf-8');
  assert.match(src, /Object\.defineProperty\(process, 'platform', \{[\s\S]{0,160}ARM === 'native-mac' \? 'darwin' : 'win32'/,
    'the extractor no longer forces process.platform from the fixture arm');
});

console.log('the host->guest translation itself');
check('toGuestPath maps every shape a Windows host can name a file by', () => {
  // Asserted on the FUNCTION rather than inferred from a capture, so it holds on a
  // macOS host too — where the repo has no drive letter and the capture could not
  // show a translation even if one happened.
  const B = String.fromCharCode(92);
  assert.strictEqual(spawnMod.toGuestPath('C:' + B + 'lib' + B + 'python'), '/mnt/c/lib/python');
  assert.strictEqual(spawnMod.toGuestPath('C:/lib/python'), '/mnt/c/lib/python');
  assert.strictEqual(spawnMod.toGuestPath('E:' + B + 'training'), '/mnt/e/training');
  // The UNC form of a guest-resident path: tool-paths documents it for
  // orpheusModelsDir on a Windows+WSL machine.
  assert.strictEqual(
    spawnMod.toGuestPath(B + B + 'wsl$' + B + 'Ubuntu' + B + 'home' + B + 't' + B + 'm'),
    '/home/t/m');
  // Already guest-form, and non-paths, pass through untouched — which is what
  // makes it safe to apply to every argv element and every env value.
  assert.strictEqual(spawnMod.toGuestPath('/home/t/m'), '/home/t/m');
  assert.strictEqual(spawnMod.toGuestPath('--session_dir'), '--session_dir');
  assert.strictEqual(spawnMod.toGuestPath('higgs-v3'), 'higgs-v3');
});

check('wsl: argv paths AND env values are both translated for the guest', () => {
  // The pair that used to be done by different code — one correct, one not — which
  // is how the argv guard's bug stayed invisible in a log for weeks.
  const worker = plans.wsl.doors.worker;
  assert.ok(worker.viaWsl, 'the wsl arm did not route through WSL');
  assert.match(worker.bash.run, /\/mnt\/c\/lib\/tmp\/ebook-abc/,
    '--session_dir crossed untranslated');
  assert.strictEqual(worker.bash.exports.PROBE_PATH, '/mnt/c/lib/rejects',
    'a path-valued env var crossed untranslated');
  assert.strictEqual(worker.bash.exports.PROBE_PLAIN, 'x',
    'a non-path env value was mangled by the translation');
  assert.strictEqual(worker.bash.cd, 'cd ~',
    'the guest cwd is not the WSL home');
});

check('native-mac: Orpheus render runs in narrator-mlx, assembly does not', () => {
  const doors = plans['native-mac'].doors;
  assert.match(runOf(doors.worker), /narrator-mlx/,
    'the mac render door does not name narrator-mlx');
  assert.ok(!/narrator-mlx/.test(runOf(doors.assembly)),
    'the mac assembly door resolved the MLX env — it needs numpy/soundfile, not mlx');
});

console.log(failures === 0 ? '\nAll narrator argv checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
