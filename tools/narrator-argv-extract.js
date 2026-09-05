#!/usr/bin/env node
/**
 * The narrator command lines BookForge builds — the FLAGS from source, and the
 * PLAN (interpreter, env, cwd) from the real spawn builder.
 *
 *   node tools/narrator-argv-extract.js flags    # the seven argv literals
 *   node tools/narrator-argv-extract.js plan <arm>   # wsl | native-win | native-mac
 *
 * ── Two halves, because two different things can break ─────────────────────
 *
 * A door can lose a FLAG (`--session_dir` dropped from prep, and narrator refuses
 * by name; `--sentences_dir` dropped from a worker, and a resume silently
 * re-renders the book). That is a property of the source: the argv is assembled
 * inside `prepareSession` / `startWorker` / `runAssembly`, none of which is
 * exported and all of which touch Electron, a live session and the GPU arbiter
 * before they reach the array. Driving them for a snapshot would mean faking all
 * of that, and the fakes would become the thing under test. So the array literals
 * are read out of the source, with comments and whitespace stripped.
 *
 * A door can also lose its ENVIRONMENT or land in the wrong conda env, which the
 * literals cannot see at all. That half CAN be executed: `buildNarratorSpawn` is
 * exported and pure given its inputs, so the plan is captured by calling it with
 * a fixed argv on each of the three arms.
 *
 * ── Why a child process per arm ─────────────────────────────────────────────
 *
 * `process.platform` is forced for the mac arm and read at module load in several
 * places. One process per arm, so every capture starts from a cold module.
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Half one: the seven argv literals
// ─────────────────────────────────────────────────────────────────────────────
//
// SEVEN DOORS, because "the argv did not move" is a claim that a door left out of
// the snapshot does not cover. The e2a snapshot had five; `assembly-reassembly`
// is the sixth, and it is in a different FILE, which is exactly why it was the
// door that kept its `--tts_engine xtts` literal for a year after the render path
// stopped needing one. `align` is the seventh, in a file of its own again, and it
// is the one door narrator refuses a Higgs book for the absence of.
const ANCHORS = [
  { name: 'prep', file: 'electron/parallel-tts-bridge.ts', start: "const args = [\n    '--headless',\n    '--ebook', ebookArgPath," },
  { name: 'retake', file: 'electron/parallel-tts-bridge.ts', start: "args = [\n      '--session', sessionId," },
  // NOT anchored on "const args: string[] = [" — the first `[` after that anchor
  // is the one in `string[]`, so the capture comes back as the empty array, for
  // the one door that renders every sentence of every book. Anchored on the
  // assignment instead.
  { name: 'worker', file: 'electron/parallel-tts-bridge.ts', start: "= [\n    '--session', prepInfo.sessionId," },
  { name: 'assembly-render', file: 'electron/parallel-tts-bridge.ts', start: "const args = [\n    '--headless',\n    // Only include --ebook" },
  { name: 'assembly-reassembly', file: 'electron/reassembly-bridge.ts', start: "const appArgs = [\n      '--headless',\n      '--ebook', epubPath," },
  // SEVEN NOW. The align door is the coverage guard's own spawn, and it is the
  // one door in narrator's OWN spelling (dashes-and-words) rather than e2a's —
  // which is exactly why it is worth pinning: a flag renamed on either side
  // silently stops producing the report, and the only symptom is an assembly
  // refusing a Higgs book for a reason that reads like the report was never
  // asked for.
  { name: 'align', file: 'electron/coverage-align-job.ts', start: "const args = [\n    'align',\n    '--session-dir', config.processDir," },
  // resume and list are single-line arrays inside their spawn call, so they are
  // pinned by the plan half rather than by a literal walk.
];

/** Strip comments and collapse whitespace so formatting is not a diff. */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * From `start`, read forward to the closing `];` of the array literal it sits in,
 * tracking bracket depth so a nested `[...]` (a ternary spread) does not end it
 * early.
 */
function literalFrom(source, start) {
  const at = source.indexOf(start);
  if (at < 0) {
    throw new Error(
      `The argv anchor was not found:\n  ${JSON.stringify(start)}\n` +
      'Either the door was rewritten (in which case decide whether its argv really ' +
      'should change, and regenerate the baseline deliberately) or the anchor needs ' +
      'updating.',
    );
  }
  // The opening bracket is INSIDE the anchor (every anchor is written as
  // `const args = [` + its first elements), so it is found forward from `at`
  // rather than by walking backwards. Walking backwards was the e2a extractor's
  // approach and it lands on the wrong bracket here: the nearest `[` behind a
  // `const args = [` is often inside a preceding template string — `[PARALLEL-TTS]`
  // in a console.log — and the whole capture becomes the string "[PARALLEL-TTS]"
  // rather than an argv, silently, for every door.
  const open = source.indexOf('[', at);
  if (open < 0) throw new Error(`No array literal after anchor ${JSON.stringify(start)}`);
  let depth = 0;
  let i = open;
  for (i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return normalize(source.slice(open, i + 1));
    }
  }
  throw new Error(`Unterminated array literal from anchor ${JSON.stringify(start)}`);
}

function extractFlags(repo) {
  const fs = require('fs');
  const path = require('path');
  const out = {};
  for (const a of ANCHORS) {
    // LINE ENDINGS FIRST: the anchors are written with `\n` and this repo is
    // core.autocrlf=true, so on Windows every working file is CRLF and every
    // `indexOf` would return -1 on a tree where nothing had moved.
    const src = fs.readFileSync(path.join(repo, a.file), 'utf-8').replace(/\r\n/g, '\n');
    out[a.name] = literalFrom(src, a.start);
  }
  return out;
}

module.exports = { extractFlags, ANCHORS, normalize };

// ─────────────────────────────────────────────────────────────────────────────
// Half two: the plan, per arm
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  const REPO = path.resolve(__dirname, '..');
  const mode = process.argv[2];

  if (mode === 'flags') {
    console.log(JSON.stringify(extractFlags(REPO), null, 2));
    // exitCode + return, never a hard exit call: this writes the whole flags
    // snapshot to a PIPE, and an undrained tail is a capture that parses as
    // something else. See tools/test-cli-exit-drain.js.
    process.exitCode = 0;
    return;
  }
  if (mode !== 'plan') {
    console.error('usage: narrator-argv-extract.js flags | plan <wsl|native-win|native-mac>');
    process.exitCode = 64;
    return;
  }

  const ARM = process.argv[3];
  if (!['wsl', 'native-win', 'native-mac'].includes(ARM)) {
    console.error('usage: narrator-argv-extract.js plan <wsl|native-win|native-mac>');
    process.exitCode = 64;
    return;
  }

  // stdout is the capture and nothing else; module chatter goes to stderr.
  console.log = (...a) => console.error(...a);

  const Module = require('module');
  const DIST = path.join(REPO, 'dist', 'electron');

  const FAKE = {
      wslConda: '/home/fake/anaconda3/bin/conda',
    orpheusEnv: 'orpheus_tts',
    higgsEnv: 'higgs3',
    distro: 'Ubuntu',
    // NOT RENAMED BY PHASE 6 — see the same note in serve-spawn-extract.js.
    // `getPythonInvocation` is stubbed to return this, so the literal decides
    // nothing; keeping it keeps `narrator-argv-base.json` comparable across the
    // change.
    python: 'C:\\FAKE\\e2a\\python_env\\python.exe',
    conda: '/fake/miniconda/bin/conda',
    mlxEnv: '/opt/homebrew/Caskroom/miniconda/base/envs/narrator-mlx',
  };

  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return 'electron-stub';
    return originalResolve.call(this, request, ...rest);
  };
  require.cache['electron-stub'] = {
    id: 'electron-stub', filename: 'electron-stub', loaded: true,
    exports: {
      app: {
        getAppPath: () => REPO,
        getPath: () => 'C:\\FAKE\\userData',
        isPackaged: false,
      },
      BrowserWindow: class {},
    },
  };

  // THE ARM IS THE FIXTURE'S, NOT THE HOST'S.
  //
  // Only the mac arm forced `process.platform`, so on a macOS host the 'wsl' and
  // 'native-win' fixtures silently resolved through the darwin branch and every
  // row came back as the Mac conda invocation. The snapshot still compared equal
  // to ITSELF on that machine, which is the worst kind of green: the keeper
  // reported that the WSL argv had not changed while never having built one.
  //
  // Forced before any module is loaded, because `narratorRunsInWsl`,
  // `getEnvPathForEngine` and the pool all read `process.platform` at call time
  // and some read it at module scope. This is a child process per arm (see the
  // header), so nothing is restored and nothing else is affected.
  Object.defineProperty(process, 'platform', {
    value: ARM === 'native-mac' ? 'darwin' : 'win32',
    configurable: true,
  });

  const paths = require(path.join(DIST, 'narrator-paths.js'));
  const toolPaths = require(path.join(DIST, 'tool-paths.js'));

  function stub(mod, name, fn) {
    const d = Object.getOwnPropertyDescriptor(mod, name);
    if (d && !d.set && !d.writable && !d.configurable) {
      throw new Error(`${name} is a sealed re-export — stub it on the module that owns it`);
    }
    if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
    else mod[name] = fn;
  }

  // Both toggles follow the fixture: 'wsl' means the guest arm, 'native-win'
  // means a Windows machine with the toggle off, 'native-mac' has no guest.
  stub(toolPaths, 'shouldUseWsl2ForOrpheus', () => ARM === 'wsl');
  stub(toolPaths, 'shouldUseWsl2ForHiggs', () => ARM === 'wsl');
  stub(toolPaths, 'getWslCondaPath', () => FAKE.wslConda);
  stub(toolPaths, 'getWslOrpheusCondaEnv', () => FAKE.orpheusEnv);
  stub(toolPaths, 'getWslHiggsCondaEnv', () => FAKE.higgsEnv);
  stub(toolPaths, 'getWslDistro', () => FAKE.distro);
    stub(paths, 'getPythonInvocation', () => ({ command: FAKE.python, args: [] }));
  stub(paths, 'buildToolsSpawnEnv', (extra) => ({ ...extra }));
  stub(paths, 'getNarratorMlxEnv', () => FAKE.mlxEnv);
  stub(paths, 'getCondaPath', () => FAKE.conda);

  const spawnMod = require(path.join(DIST, 'narrator-spawn.js'));

  // A representative argv per phase. NOT the door's real argv (that is the flags
  // half) — a fixed one, so the plan capture shows the ENV and the interpreter
  // without a session id or a temp path making it differ per run. The paths are
  // deliberately Windows-shaped so the WSL arm's translation is visible.
  const WIN_SESSION = 'C:\\lib\\tmp\\ebook-abc';
  const PHASE_ARGS = {
    prep: ['--headless', '--ebook', 'C:\\books\\b.epub', '--session', 'abc',
           '--session_dir', WIN_SESSION, '--prep_only'],
    worker: ['--session', 'abc', '--session_dir', WIN_SESSION,
             '--sentences_dir', 'C:\\lib\\sent', '--device', 'CUDA'],
    assembly: ['--headless', '--session', 'abc', '--session_dir', WIN_SESSION,
               '--output_dir', 'C:\\out', '--assemble_only', '--no_split'],
    // narrator's own spelling, and a Windows path for `--python` so the capture
    // shows that the align door does NOT cross into the guest: it runs natively
    // on the session `normalizeWslSessionToWindows` has already copied out.
    align: ['align', '--session-dir', WIN_SESSION,
            '--report', WIN_SESSION + '\\coverage.json',
            '--language', 'en', '--device', 'cpu',
            '--python', 'C:\\FAKE\\whisperx\\python.exe'],
    resume: ['--headless', '--resume_session', WIN_SESSION],
    list: ['--headless', '--list_sessions'],
  };

  // engine: undefined means the tools env (assembly/resume/list); 'orpheus' is
  // the render engine. Higgs is covered by tools/test-higgs-engine.js, which owns
  // the voice document this capture would have to fake.
  const DOORS = [
    { name: 'prep', engine: 'orpheus', phase: 'prep' },
    { name: 'worker', engine: 'orpheus', phase: 'worker' },
    { name: 'retake', engine: 'orpheus', phase: 'worker' },
    { name: 'assembly', engine: undefined, phase: 'assembly' },
    { name: 'align', engine: undefined, phase: 'align' },
    { name: 'resume', engine: undefined, phase: 'resume' },
    { name: 'list', engine: undefined, phase: 'list' },
  ];

  /**
   * This checkout's location, replaced by ONE token, with separators normalised.
   *
   * HOST-INDEPENDENT ON PURPOSE. Three things here are the running machine's and
   * none of them is what the snapshot is about:
   *
   *   - `path.join` uses the HOST's separator (faking `process.platform` does not
   *     change it — the path module binds win32/posix at load), so
   *     `narratorPythonRoot()` yields `<REPO>\python` on Windows and `<REPO>/python`
   *     on a Mac;
   *   - the repo lives at a different absolute path on every machine;
   *   - on the WSL arm the repo's own path is translated to `/mnt/<drive>/...` on a
   *     Windows host and left alone on a Mac (it has no drive letter to translate).
   *
   * So all three forms collapse to `<REPO>` and every backslash becomes a forward
   * slash. What that gives up is the ability to SEE the host->guest translation of
   * the repo path in the snapshot; that property is asserted directly instead, as a
   * unit check on `toGuestPath`, which is pure and host-independent. The fixture's
   * own argv paths (`C:\lib\tmp\ebook-abc`) are still translated to `/mnt/c/...`
   * in the capture on either host, because that translation is string logic.
   */
  function canon(s) {
    if (typeof s !== 'string') return s;
    const fwd = REPO.replace(/\\/g, '/');
    const guest = fwd.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
    return s
      .split(REPO).join('<REPO>')
      .split(fwd).join('<REPO>')
      .split(guest).join('<REPO>')
      .replace(/\\/g, '/');
  }

  function splitBash(bash) {
    const m = bash.match(/^export ([\s\S]*?) && (cd [\s\S]*?) && ([\s\S]*)$/);
    if (!m) return { raw: bash };
    const exportsMap = {};
    const re = /([A-Za-z_][A-Za-z0-9_]*)=('(?:[^']|'\\'')*'|[^\s]*)/g;
    let hit;
    while ((hit = re.exec(m[1]))) {
      let v = hit[2];
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
      exportsMap[hit[1]] = canon(v);
    }
    return { exports: exportsMap, cd: canon(m[2]), run: canon(m[3]) };
  }

  const out = { arm: ARM, doors: {} };
  for (const door of DOORS) {
    const plan = spawnMod.buildNarratorSpawn({
      engine: door.engine,
      phase: door.phase,
      args: PHASE_ARGS[door.phase],
      // The env every door's own code contributes is captured by the flags half's
      // call sites; here a FIXED pair proves forwarding and translation, and a
      // path-valued one proves env values are translated like argv.
      envExtras: { PROBE_PLAIN: 'x', PROBE_PATH: 'C:\\lib\\rejects' },
      cwdHint: undefined,
    });
    // `command` goes through canon() like everything else: it is a host path
    // (a conda exe, a relocatable python) and an un-normalised one is exactly the
    // separator difference that makes a Windows capture and a Mac capture disagree.
    const row = { command: canon(plan.command), viaWsl: !!plan.viaWsl };
    if (plan.viaWsl) {
      row.args = plan.args.slice(0, -1).map(canon);
      row.bash = splitBash(plan.args[plan.args.length - 1]);
      row.cwd = '(process.cwd — wsl.exe is a normal Windows child)';
    } else {
      row.args = plan.args.map(canon);
      row.env = Object.fromEntries(
        Object.entries(plan.env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canon(v)]),
      );
      row.cwd = canon(plan.cwd);
    }
    out.doors[door.name] = row;
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
