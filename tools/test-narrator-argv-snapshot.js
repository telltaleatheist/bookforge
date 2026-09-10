#!/usr/bin/env node
/**
 * THE SEVEN NARRATOR DOORS: their flags, and the plan each one produces per arm.
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
 *
 * ── Re-baselines, and what each one was for ─────────────────────────────────
 *
 * 2026-09-06, the TWO ASSEMBLY DOORS, for **159a3d13** ("Merge coverage audit
 * rebuild: assembly reports, never refuses" — Owen's ruling, 2026-09-05). Both
 * doors moved from
 *
 *     ...(coverageEnforcedFor(<engine>) ? ['--coverage_report', <path>] : [])
 * to
 *     ...(fs.existsSync(coverageReportPath(<dir>)) ? ['--coverage_report', <path>] : [])
 *
 * i.e. assembly passes `--coverage_report` whenever the report file is actually
 * THERE, rather than whenever the engine is one that enforces coverage. That is
 * the ruling: assembly REPORTS coverage and never refuses on it, so the flag
 * follows the artifact and not the engine table.
 *
 * Nothing else in either argv moved, and that was checked rather than assumed
 * before the bytes were rewritten: the regeneration masked the coverage predicate
 * on both sides and required the remainder to compare EQUAL, so a second change
 * riding along would have failed the re-baseline instead of being absorbed by it.
 * That is the only way a snapshot survives being regenerated.
 *
 * 2026-09-07, THE ALIGN DOOR's `flags` literal, for Owen's ruling of that day
 * ("make it an option the user can pick when adding it to the queue. GPU or
 * CPU? defaults to CPU"). One token:
 *
 *     '--device', 'cpu'   ->   '--device', device
 *
 * where `device` is the row's own choice resolved to a name on the machine that
 * runs it — `cpu`, `mps` or `cuda` (`coverage-align-job.resolveAlignDevice`).
 * The three PLAN arms are unchanged and were not regenerated: they drive the
 * door with a CPU row, which is what every row before that day was. Checked, not
 * assumed: the regeneration masked the device literal on both sides and required
 * every other door to compare byte-equal, and exactly one line of the file moved.
 *
 * 2026-09-08, THE ALIGN DOOR's `flags` literal again, for the worker pool
 * (`narrator align --workers`; Owen, on Shift: "align is taking way too long...
 * 3x slower than the TTS render"). Two tokens appended:
 *
 *     '--workers', String(device === 'cpu' ? ALIGN_CPU_WORKERS : 1)
 *
 * `ALIGN_CPU_WORKERS` is 1 until measured (two rungs on this PC: 40 chunks in
 * 266 s at 1, 168 s at 2; the 4- and 8-worker rungs topped the box's 32 GB and
 * were abandoned), and a GPU row says 1 out loud. Checked, not assumed:
 * `narrator-argv-extract.js flags` was diffed door by door against the file and
 * `align` was the only key that moved; the three PLAN arms are unchanged. The
 * same day the narration run stopped composing this row at all (the checkbox is
 * gone; the estimate is the transcript), so this door is now the CLI's and a
 * restored queue file's only.
 *
 * 2026-09-08 (later the same day), THE ALIGN DOOR's `flags` literal a third
 * time, for the qwen3 cutover. Owen: *"good. go ahead and wire it up to alignment
 * so itll be used to align the chunks in app"*, *"for generate-sentences logic
 * and for normal post-render alignment"*. Two tokens added and one renamed:
 *
 *     '--backend', 'qwen3',        (added, before --device)
 *     '--python', python      ->   '--python', alignEnv.python
 *
 * The backend is STATED rather than left to narrator's `DEFAULT_BACKEND`, which
 * is still whisperx and is its contract with a caller that names none; the
 * interpreter now comes from `qwen-aligner.resolveQwenAlignEnv()` instead of the
 * whisperx env. Checked, not assumed: the regeneration MASKED exactly those two
 * edits and required the remainder to compare byte-equal to the old literal
 * (it did), and a key-by-key diff of `narrator-argv-extract.js flags` against the
 * baseline showed `align` as the only key that moved. The three PLAN arms were
 * NOT regenerated and still pass — the align door names no engine and no
 * `wslCondaEnv` in the fixture, so it is still the native tools-env spawn there.
 * (The real door DOES cross into the guest when the resolved env is a WSL one;
 * that is `narrator-spawn.ts`'s new `wslCondaEnv` field, and the fixture drives
 * this phase without it because the fixture's env resolution is stubbed out.)
 *
 * 2026-09-09, THE TWO ASSEMBLY DOORS' `flags` literals, for the chapter gap
 * (Owen: *"can we artificially insert 3 seconds of silence at the end of every
 * chapter so its easier to tell when it moves from one to the next"*). Two
 * tokens appended to each, and NOT behind a spread:
 *
 *     '--chapter_gap', String(chapterGap)
 *
 * Unconditional on purpose. The value is the answer for this book whether the
 * caller chose it or took `DEFAULT_CHAPTER_GAP` (shared/audio/chapter-gap.ts),
 * and a flag that is sometimes absent is a book whose gap depends on which of
 * the two doors assembled it. An explicit 0 is also a real answer and would be
 * eaten by a truthiness spread. Checked, not assumed: the regeneration masked
 * exactly that suffix on both doors and required the remainder to compare
 * byte-equal (it did), and the two assembly keys were the ONLY ones that moved -
 * every other door and all three PLAN arms are untouched.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
// STDERR IS KEPT. It used to be 'ignore', which threw away the one diagnostic that
// matters: the likeliest real failure here is an argv anchor that stopped matching
// after a door was rewritten, and `narrator-argv-extract.js` says exactly which
// anchor and where. Discarding it turned that into a bare `Command failed`.
const extract = (...args) => {
  const r = spawnSync(
    process.execPath, [path.join(__dirname, 'narrator-argv-extract.js'), ...args],
    { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(
      `narrator-argv-extract.js ${args.join(' ')} exited ${r.status}:\n`
      + `${(r.stderr || '(no stderr)').trim()}`);
  }
  return JSON.parse(r.stdout);
};

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
  /*
   * THE COVERAGE GUARD'S OWN DOOR, and every flag on it is load-bearing:
   *
   *   --session-dir  what to align. narrator refuses without it.
   *   --report       WHERE the report goes. Without it narrator defaults to
   *                  coverage.json beside the session, which happens to be the
   *                  same file — and "happens to be" is how the two halves of a
   *                  gate drift apart.
   *   --language     the acoustic model. A wrong one scores every word badly and
   *                  refuses a book that was read correctly.
   *   --device       cpu, by contract: the card belongs to the renders.
   *   --python       the whisperx env. Absent, narrator refuses BY NAME rather
   *                  than picking an interpreter — which is the behaviour we
   *                  want and the one thing this door must not leave to chance.
   */
  align: ['--session-dir', '--report', '--language', '--device', '--python'],
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

check('the align door names no engine at all', () => {
  // It is ABOUT an engine — which one rendered the session is what decides
  // whether it runs — but it does not RUN one, and narrator's `align` subcommand
  // has no --tts_engine to take: `align_session` reads the engine off the
  // manifest. A door that started sending one would be naming a value nothing
  // reads, which is the shape the DEAD-flag check above exists to catch.
  assert.ok(!flags.align.includes("'--tts_engine'"),
    'the align door sends --tts_engine; narrator align has no such flag');
  assert.ok(!flags.align.includes("'--assemble_only'"),
    'the align door sends a compat-door flag; it spawns narrator.cli, not compat.app');
});

check('no door names an ENGINE_NEAR_MISS', () => {
  // 'higgs', 'higgs-v2', 'higgs-v2-scaffold', 'higgs_v3' are refused by name on
  // the routes that resolve an engine. Every door builds its value through
  // narratorEngineId(), which is the only place the mapping lives.
  //
  // ALIGN IS EXEMPT AND ONLY ALIGN, by the check above rather than by a skip
  // here: it is asserted to carry NO --tts_engine, so the "passes when the thing
  // it tests is absent" shape this loop was rewritten to avoid cannot come back
  // through the exemption.
  for (const [door, argv] of Object.entries(flags)) {
    if (door === 'align') continue;
    const at = argv.indexOf("'--tts_engine',");
    // NOT `continue`. A door with no --tts_engine at all would have skipped this
    // check silently — the "passes when the thing it tests is absent" shape. The
    // REQUIRED table above already demands the flag on four of the five doors, so
    // this only fires for a door that lost it; when it does, it must say so.
    assert.ok(at >= 0, `${door} sends no --tts_engine, so nothing here checked its source`);
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
    for (const d of ['assembly', 'align', 'resume', 'list']) {
      assert.ok(!('NARRATOR_ENGINE' in envOf(doors[d])),
        `${d} names an engine — it is engine-agnostic and runs in the tools env`);
    }
  });

  check(`${arm}: the tools doors are NEVER routed through WSL`, () => {
    for (const d of ['assembly', 'align', 'resume', 'list']) {
      assert.strictEqual(doors[d].viaWsl, false,
        `${d} was routed through WSL; assembly reads a session normalised onto `
        + 'Windows and the 9p mount would dominate the job');
    }
  });

  check(`${arm}: every door reaches a narrator module, never a script path`, () => {
    for (const [name, row] of Object.entries(doors)) {
      // `narrator.cli` is the align door and only the align door: e2a never had
      // a forced aligner, so there is no compat flag that would reach one, and
      // routing narrator's own subcommand through a translation layer written
      // for ebook2audiobook's spelling would be a compat door for a command e2a
      // never had.
      assert.match(runOf(row), /-m narrator\.(compat\.(app|worker)|serve|cli)\b/,
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
