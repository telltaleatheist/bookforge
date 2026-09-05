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
const { spawnSync } = require('child_process');

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

/** One arm's capture, PARSED but not yet host-neutralised. */
function capture(arm, engine) {
  // STDERR IS KEPT — see the note in test-narrator-argv-snapshot.js. An extractor
  // that fails because a door moved has a diagnostic worth reading; `stdio: 'ignore'`
  // replaced it with `Command failed`.
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'serve-spawn-extract.js'), arm, ...(engine ? [engine] : [])],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) {
    throw new Error(
      `serve-spawn-extract.js ${arm}${engine ? ` ${engine}` : ''} exited ${r.status}:\n`
      + `${(r.stderr || '(no stderr)').trim()}`);
  }
  return JSON.parse(r.stdout);
}

// RAW and neutralised are kept apart, and it matters. `hostNeutral` deletes every
// backslash it can find, so the separator check below — the whole reason the
// extractor canonicalises at all — was walking data with the evidence already
// removed from it and could not fail. It walks `raw` now.
const nowRaw = {};
const now = {};
for (const arm of ARMS) {
  nowRaw[arm] = capture(arm);
  now[arm] = hostNeutral(nowRaw[arm]);
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

console.log('the Higgs serve spawn, per arm');
// ONE POOL, TWO ENGINES: which one answers is `NARRATOR_ENGINE` in the spawn. These
// rows pin what a Higgs Listen session starts, and — on the two native arms — that
// it REFUSES rather than starting something that cannot run.
const higgsRowsRaw = {};
const higgsRows = {};
for (const arm of ARMS) {
  higgsRowsRaw[arm] = capture(arm, 'higgs');
  higgsRows[arm] = hostNeutral(higgsRowsRaw[arm]);
}

for (const arm of ARMS) {
  check(`higgs/${arm}: unchanged`, () => {
    assert.deepStrictEqual(higgsRows[arm], base[`higgs:${arm}`]);
  });
}

check('higgs/wsl: starts narrator.serve in the higgs3 env as higgs-v3', () => {
  const row = higgsRows.wsl;
  assert.ok(!row.refused, `the WSL arm refused: ${row.refused}`);
  assert.ok(row.viaWsl, 'the WSL arm did not route through WSL');
  assert.match(row.bash.run, /-n 'higgs3' python -u -m narrator\.serve$/,
    `not a higgs3 serve spawn: ${row.bash.run}`);
  // `higgs-v3`, never `higgs`: compat/flags.py lists the latter under
  // ENGINE_NEAR_MISSES and refuses it by name.
  assert.strictEqual(row.bash.exports.NARRATOR_ENGINE, 'higgs-v3');
  assert.ok(!/ORPHEUS_/.test(JSON.stringify(row)),
    'an ORPHEUS_* variable leaked into a Higgs spawn');
});

check('higgs/wsl: the voice document is named in the GUEST filesystem', () => {
  const doc = higgsRows.wsl.bash.exports.NARRATOR_HIGGS_VOICES;
  assert.ok(doc, 'no NARRATOR_HIGGS_VOICES — the engine would have no voice to resolve');
  assert.ok(!/^[A-Za-z]:/.test(doc), `the voice document crossed as a Windows path: ${doc}`);
});

check('higgs/native-win: refuses BY NAME rather than spawning', () => {
  // The SERVED backend is vLLM-Omni and there is no Windows build. Pinned so that
  // it changing is a decision.
  assert.ok(higgsRows['native-win'].refused,
    `native-win built a Higgs spawn it cannot run: ${JSON.stringify(higgsRows['native-win']).slice(0, 200)}`);
  assert.match(higgsRows['native-win'].refused, /Higgs/);
});

check('higgs/native-mac: runs IN PROCESS in narrator-mlx, not the served stack', () => {
  const row = higgsRows['native-mac'];
  assert.ok(!row.refused, `the darwin arm refused: ${row.refused}`);
  assert.ok(!row.viaWsl, 'the darwin arm routed through WSL');
  // narrator-mlx, NOT the `higgs-env` component: that is the SERVED stack's
  // environment and has no macOS build, so resolving it would refuse a Mac that
  // can render perfectly well. Same env the Orpheus MLX arm uses.
  assert.match(cmdOf(row), /narrator-mlx/, `the mac Higgs arm does not name narrator-mlx: ${cmdOf(row)}`);
  assert.strictEqual(envOf(row).NARRATOR_ENGINE, 'higgs-v3');
  // The served arm's variables must NOT come along: there is no launch script and
  // no distro on a Mac, and either one present would mean the wrong backend.
  assert.ok(!('NARRATOR_HIGGS3_SERVE_SCRIPT' in envOf(row)),
    'the darwin arm carries the SERVED launch script');
  assert.ok(!('NARRATOR_HIGGS3_WSL_DISTRO' in envOf(row)),
    'the darwin arm carries a WSL distro');
});

check('higgs/native-mac: NARRATOR_HIGGS3_MLX_MODEL names an existing directory', () => {
  // `mlx_backend.model_dir_from_env()` refuses BY NAME when this is unset — "no
  // default and no search", because an engine that guesses where its weights are
  // can render a whole book in the wrong model and report success. So the spawn
  // must name it, and the fixture provisions the directory so "does it exist" is a
  // question about the PATH DERIVATION rather than about the fixture.
  const row = higgsRows['native-mac'];
  const dir = envOf(row).NARRATOR_HIGGS3_MLX_MODEL;
  assert.ok(dir, 'the darwin arm sets no NARRATOR_HIGGS3_MLX_MODEL — narrator would refuse');
  assert.match(dir, /runtime\/higgs-models\/base$/,
    `not the base weights dir narrator's own refusal message points at: ${dir}`);
  assert.strictEqual(row.mlxModelDirExists, true,
    'the directory BookForge named does not exist even in the fixture');
  // HOST-NATIVE: there is no guest on a Mac, so nothing is translated.
  assert.ok(!dir.startsWith('/mnt/'), `the weights dir was guest-translated: ${dir}`);
});

// ── THE SERVING BLOCK REACHES THE LAUNCH SCRIPT ───────────────────────────
//
// Until 2026-09-05 it did not. `electron/data/higgs-models.json`'s `serving`
// block declared a bind address, two memory fractions, a context length and a
// batch width, and `higgsSpawnEnv` emitted only the NARRATOR_* set — so
// serve_higgs_v3.sh ran on its own built-in defaults and every number in that
// block was a description of a configuration nothing applied. Editing
// `maxNumSeqs` changed NOTHING, which is worse than having no field: it is a
// lever that reports success.
//
// These rows are why the `higgs/*: unchanged` snapshots above moved, and they
// are the argument for it — a snapshot says "something changed", these say what
// and hold it there.
const catalog = JSON.parse(
  fs.readFileSync(path.join(REPO, 'electron', 'data', 'higgs-models.json'), 'utf-8'));
const serving = catalog.serving;

check('higgs/wsl: every serving-block knob arrives as its HIGGS_* variable', () => {
  const e = envOf(higgsRows.wsl);
  // The mapping, asserted against the CATALOG rather than against literals, so a
  // retune is one edit and this keeper proves it travelled.
  assert.strictEqual(e.HIGGS_HOST, serving.host);
  assert.strictEqual(e.HIGGS_PORT, String(serving.port));
  assert.strictEqual(e.HIGGS_GPU_MEM_UTIL, String(serving.gpuMemoryUtilization));
  assert.strictEqual(e.HIGGS_CODEC_GPU_MEM_UTIL, String(serving.codecGpuMemoryUtilization));
  assert.strictEqual(e.HIGGS_MAX_MODEL_LEN, String(serving.maxModelLen));
  assert.strictEqual(e.HIGGS_MAX_NUM_SEQS, String(serving.maxNumSeqs));
  // HIGGS_ENV is the conda prefix the script builds CUDA_HOME, PATH,
  // LD_LIBRARY_PATH and its own `vllm-omni` path out of. Its script-side default
  // is a hardcoded $HOME/anaconda3/envs/higgs3 — true on the machine it was
  // transcribed from, a wrong-env server start anywhere else.
  assert.ok(e.HIGGS_ENV, 'the served arm names no HIGGS_ENV');
  assert.ok(e.NARRATOR_HIGGS3_SERVE_SCRIPT.startsWith(e.HIGGS_ENV + '/bin/'),
    `the launch script is not inside HIGGS_ENV: ${e.HIGGS_ENV} vs ${e.NARRATOR_HIGGS3_SERVE_SCRIPT}`);
});

check('higgs/wsl: the TWO memory fractions are separate, and they leave headroom', () => {
  const e = envOf(higgsRows.wsl);
  // vllm-omni applies a GLOBAL --gpu-memory-utilization to EVERY stage, and this
  // server is two (talker + codec decoder), so the campaign's single 0.60
  // reserved 0.60 twice — measured 24.2 GB of a 24.5 GB card, 2026-09-05. The
  // launch script passes them per stage through --stage-overrides, which is only
  // meaningful if the two variables actually differ here.
  const talker = Number(e.HIGGS_GPU_MEM_UTIL);
  const codec = Number(e.HIGGS_CODEC_GPU_MEM_UTIL);
  assert.ok(talker > 0 && talker <= 1, `talker fraction out of range: ${talker}`);
  assert.ok(codec > 0 && codec <= 1, `codec fraction out of range: ${codec}`);
  assert.ok(talker + codec <= 0.95,
    `the two stages together ask for ${(talker + codec).toFixed(2)} of the card, which leaves `
    + 'nothing for anything else on it');
});

check('higgs: HIGGS_MAX_NUM_SEQS is set on BOTH arms', () => {
  // narrator's `serve_concurrency()` reads it and REFUSES BY NAME when unset —
  // it is both stage 0's max_num_seqs and the width of narrator's own batch. A
  // door that renders and finds it missing dies after the session is built, so
  // it is set everywhere rather than only where a server is started.
  for (const arm of ['wsl', 'native-mac']) {
    assert.strictEqual(envOf(higgsRows[arm]).HIGGS_MAX_NUM_SEQS, String(serving.maxNumSeqs),
      `${arm} does not state the batch width`);
  }
});

check('higgs/native-mac: NO server-launch variable comes along', () => {
  // The Mac samples in-process. A bind address, a memory fraction or a conda
  // prefix there would be a lever read by nothing — the same defect as the
  // launch script and the distro, which this file already refuses.
  const e = envOf(higgsRows['native-mac']);
  for (const key of ['HIGGS_ENV', 'HIGGS_HOST', 'HIGGS_PORT', 'HIGGS_GPU_MEM_UTIL',
    'HIGGS_CODEC_GPU_MEM_UTIL', 'HIGGS_MAX_MODEL_LEN', 'HIGGS_DEPLOY_CONFIG']) {
    assert.ok(!(key in e), `the darwin arm carries the served stack's ${key}`);
  }
});

check('higgs: HIGGS_DEPLOY_CONFIG is emitted only when a profile is CHOSEN', () => {
  // `null` in the catalog means "vllm-omni's auto-discovered profile", which
  // keeps stage 0 in enforce_eager (no CUDA graphs on the talker). Exporting an
  // empty string would instead make the script take the `-n` branch and pass
  // `--deploy-config ''`.
  assert.ok('deployConfig' in serving,
    'the serving block no longer declares deployConfig — an absent key makes "nobody decided" '
    + 'look like a decision');
  const present = 'HIGGS_DEPLOY_CONFIG' in envOf(higgsRows.wsl);
  assert.strictEqual(present, serving.deployConfig !== null,
    `deployConfig is ${JSON.stringify(serving.deployConfig)} but HIGGS_DEPLOY_CONFIG is `
    + `${present ? 'set' : 'unset'}`);
});

check('higgs/wsl: a bare profile FILE NAME is resolved to the installer\'s copy', () => {
  // vllm-omni resolves a bare file name against its OWN deploy/ directory inside
  // site-packages, which is not where the installer puts ours: the profile is
  // copied into <env>/bin/, beside the launcher. So the name alone would either
  // miss it or find an upstream file of a similar name and start a
  // differently-configured server 297 s later — and the difference this profile
  // carries is the FRAME CEILING (stage 0 max_tokens 7500 = 300 s against the
  // auto profile's 2048 = 81.92 s), which does not crash, it truncates audio.
  if (serving.deployConfig === null) return; // nothing chosen; the check above owns that case
  const e = envOf(higgsRows.wsl);
  const bare = !serving.deployConfig.includes('/') && !serving.deployConfig.includes('\\');
  assert.strictEqual(e.HIGGS_DEPLOY_CONFIG,
    bare ? `${e.HIGGS_ENV}/bin/${serving.deployConfig}` : serving.deployConfig,
    'the deploy profile did not travel as the path the installer deploys to');
  // THE SAME DERIVATION AS THE LAUNCHER'S, which is the point: one prefix, and
  // everything the installer put under it named from that prefix.
  if (bare) {
    assert.strictEqual(
      path.posix.dirname(e.HIGGS_DEPLOY_CONFIG),
      path.posix.dirname(e.NARRATOR_HIGGS3_SERVE_SCRIPT),
      'the profile and the launcher resolved to different directories, so one of the two '
      + 'derivations is wrong');
  }
});

check('higgs: BookForge never sets HIGGS_MODEL_DIR', () => {
  // narrator exports it per voice from the voice document's checkpointDir
  // (v3_served.py `_launch_exports`). A copy from this side would be a second
  // authority on which weights serve, and the loser is a whole book in the wrong
  // narrator — the failure Owen hit on 2026-09-05 in its other direction.
  for (const arm of ARMS) {
    // native-win REFUSES rather than spawning (there is no Windows vLLM-Omni),
    // so it has no environment to inspect — asserted above, not re-asserted here.
    if (higgsRows[arm].refused) continue;
    assert.ok(!('HIGGS_MODEL_DIR' in envOf(higgsRows[arm])),
      `${arm} sets HIGGS_MODEL_DIR, which is narrator's to export per voice`);
  }
});

// ── THE MLX BATCH BUDGET REACHES THE LISTEN SERVER ────────────────────────
//
// The darwin Higgs serve door batches its READ-AHEAD (the row being listened to
// renders solo — a delay-pattern codec cannot token-stream, so width would land
// straight on the listener's wait). narrator's backend renders ONE ROW unless
// asked for more, so these two variables are the whole ask, and every wrong
// place to put them is silent: absent on darwin the read-ahead quietly runs
// single-row; present on the WSL arm they are read by nothing, because Higgs is
// a vLLM-Omni server there.
//
// The ceiling is the POOL's `streamBatchCeiling()` — the same number Orpheus
// gets as ORPHEUS_STREAM_BATCH — passed into `higgsEnvExtras` at the serve call
// site, because higgs-spawn cannot import the pool back (the pool imports it).
const MLX_BATCH_VARS = ['NARRATOR_HIGGS3_MLX_BATCH', 'NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB'];

check('higgs/native-mac: the serve door carries the batch ceiling and its budget', () => {
  const e = envOf(higgsRows['native-mac']);
  for (const name of MLX_BATCH_VARS) {
    assert.ok(e[name], `the darwin Higgs serve door sets no ${name}`);
    assert.ok(Number(e[name]) > 0, `${name} is not a positive number: ${e[name]}`);
  }
  // The fixture pins orpheusMemoryProfile to batchSize 16 / mlxMemBudgetGB 24,
  // and streamBatchCeiling() floors the width at 16 — so this row states the
  // POOL's ceiling, which is the number the Orpheus row states as
  // ORPHEUS_STREAM_BATCH. Asserted against that row rather than against a
  // literal, so a tier change moves both or fails here.
  assert.strictEqual(e.NARRATOR_HIGGS3_MLX_BATCH,
    envOf(now['native-mac']).ORPHEUS_STREAM_BATCH,
    'the Higgs serve ceiling is not the pool ceiling Orpheus gets');
  assert.strictEqual(e.NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB,
    envOf(now['native-mac']).ORPHEUS_MLX_MEM_BUDGET_GB,
    'the two MLX engines are budgeting different amounts of ONE memory pool');
});

check('higgs/wsl: NO MLX batch variable reaches the served arm', () => {
  const e = envOf(higgsRows.wsl);
  for (const name of MLX_BATCH_VARS) {
    assert.ok(!(name in e), `${name} reached the served arm, where nothing reads it`);
  }
});

check('no ORPHEUS_* name rides in ANY Higgs serve row', () => {
  // The Higgs spawn strips Orpheus's variables deliberately; a Higgs knob
  // SPELLED ORPHEUS_ would be stripped with them and read by nothing. Asserted
  // on every arm, not just the WSL one, now that the darwin row carries a
  // width the POOL derived — the tempting place to spell it ORPHEUS_.
  for (const arm of ARMS) {
    if (higgsRows[arm].refused) continue;
    assert.ok(!/ORPHEUS_/.test(JSON.stringify(higgsRows[arm])),
      `an ORPHEUS_* variable leaked into the ${arm} Higgs spawn`);
  }
});

check('the WSL Higgs arm sets NO MLX model var', () => {
  // It is the SERVED backend there: the weights are the launch script's argument.
  // Setting it would look like a lever and be read by nothing.
  assert.ok(!('NARRATOR_HIGGS3_MLX_MODEL' in envOf(higgsRows.wsl)),
    'the served arm carries the in-process backend\'s weights variable');
});

console.log('the capture says the same thing on Windows and on a Mac');
/** Every string in `v` that still contains a backslash, with the path that reached it. */
function hostSeparatorsIn(v, at = '', offenders = []) {
  // WALKS THE VALUES, not `JSON.stringify` of them: serialising re-introduces
  // backslashes of its own for every escaped quote, and the native-win Higgs
  // refusal quotes \"WSL2 for Higgs\" — which would fail a check that is supposed
  // to be about path separators. After JSON.parse those are plain quote characters.
  if (typeof v === 'string') {
    if (v.includes(String.fromCharCode(92))) offenders.push(`${at} = ${v}`);
  } else if (Array.isArray(v)) v.forEach((x, i) => hostSeparatorsIn(x, `${at}[${i}]`, offenders));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) hostSeparatorsIn(x, `${at}.${k}`, offenders);
  }
  return offenders;
}

check('no captured value carries a host path separator', () => {
  // The exact shape of the failure a macOS host reported: `path.join` gives
  // `<REPO>\python` on Windows and `<REPO>/python` on a Mac, so an un-normalised
  // capture can never match across the two. Checkable from one host.
  //
  // The RAW captures, deliberately. This check used to walk the hostNeutral'd ones,
  // which have had `.replace(/\\/g, '/')` applied to every string — so it was
  // asking whether a function that removes backslashes had left a backslash behind.
  // It passed on every machine and would have passed with canon() deleted entirely.
  const offenders = hostSeparatorsIn({ now: nowRaw, higgsRows: higgsRowsRaw }, '');
  assert.deepStrictEqual(offenders, [], 'a host path separator survived canon()');
});
check('MUTATION: the separator walk catches a Windows path when there is one', () => {
  // A keeper that cannot fail is worth nothing, and the row above spent this whole
  // branch unable to. This is what the un-canonicalised capture looked like.
  const offenders = hostSeparatorsIn({ env: { PYTHONPATH: 'C:\\repo\\python' } }, '');
  assert.strictEqual(offenders.length, 1,
    'the walk did not see a backslash in a Windows path — the check above proves nothing');
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
