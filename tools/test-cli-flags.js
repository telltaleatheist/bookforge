#!/usr/bin/env node
/**
 * THE CLI MUST ALLOW WHAT THE APP ALLOWS, AND REFUSE BY NAME WHAT IT CANNOT DO.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-cli-flags.js
 *
 * Owen, 2026-09-12: *"we should be able to pick any model specifically,
 * including a checkpoint we want to test, and it should allow that. i just tried
 * to use the cli on a merged checkpoint as a test here on the mac and it wouldnt
 * let me. it should also let me run renders on anything, up to and including test
 * chunks. it should allow me to fully control what goes in and comes out."*
 *
 * So what is defended here is the OUTER SURFACE: every one of the model-picking
 * doors added that day reaches the settings object, and every flag that belongs
 * to the other engine, the other arm or the other door is refused BY NAME rather
 * than accepted and dropped. A flag silently ignored is the failure mode this
 * whole pass exists to end — a sweep whose temperature never arrived reads as a
 * measurement of the voice.
 *
 * HOW: `cli/bookforge-tts.py ... --dry-run`, whose output is the resolved spawn,
 * the override object and the env overrides. The dry run packs the input book
 * (CPU, a few kB, into the OS temp dir) and stops before the narration door and
 * the bridge, so nothing here loads a model, takes the GPU or touches the
 * library. Assertions are on the MESSAGE, never on the exit code alone —
 * `tools/tests/test-cli-flag-parity.sh` learned that the expensive way, where a
 * nonexistent --audio made every case fail for the wrong reason and the suite
 * was green.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// One check reads the app's OWN narrator-scratch override out of the compiled
// tool-paths module, and that module resolves userData through Electron's `app`
// at import time — so it needs the same shim every CLI adapter runs under. This
// is exactly what tools/test-cli-parity.js does, and for the same reason.
require('../cli/electron-stub.js');

const REPO = path.resolve(__dirname, '..');

// The wrapper's dry run in --mode tts hands off to the batch adapter, which
// requires the COMPILED bridge and the compiled EPUB writer. Say which build
// step is missing rather than failing inside a require four frames down.
for (const js of ['parallel-tts-bridge.js', 'epub-writer.js', 'streaming-engine.js']) {
  if (fs.existsSync(path.join(REPO, 'dist', 'electron', js))) continue;
  console.error(`dist/electron/${js} is missing — compile first:\n`
    + '  npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/**
 * Which python runs the wrapper. `PYTHON` wins (that is the seam
 * tools/tests/test-cli-flag-parity.sh uses, and on the PC it names an absolute
 * python.exe); otherwise the first interpreter on PATH that actually runs.
 */
function resolvePython() {
  const candidates = [process.env.PYTHON, 'python3', 'python'].filter(Boolean);
  for (const py of candidates) {
    const probe = spawnSync(py, ['-c', 'import sys'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return py;
  }
  console.error('no working python found — set PYTHON to an interpreter '
    + `(tried: ${candidates.join(', ')})`);
  process.exit(1);
  return '';
}
const PY = resolvePython();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cli-flags-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });

// Real files, because the wrapper stats its inputs before it validates flags —
// the vacuous-assertion trap from the parity shell suite.
const TXT = path.join(TMP, 'chunks.txt');
fs.writeFileSync(TXT, 'Chunk one, rendered in 1933.\n\nChunk two.\n', 'utf8');
const JSONL = path.join(TMP, 'chunks.jsonl');
fs.writeFileSync(JSONL, '{"text":"Row one."}\n"Row two."\n', 'utf8');
const EPUB = path.join(TMP, 'book.epub');
fs.writeFileSync(EPUB, '');                       // never opened: the flag refusals fire first
// THE CHECKPOINT IS ARM-SHAPED, LIKE THE WRAPPER'S RULE (2026-09-12, PC run).
// On the Mac the wrapper resolves --checkpoint-dir against cwd and stats it, so
// the fixture is a real host directory. On Windows a Higgs render is read INSIDE
// the WSL guest: the wrapper refuses anything but a guest-native '/…' path and
// passes it verbatim — it cannot stat the guest — so the fixture is that string
// and nothing on this host is created for it. A host temp dir here made three
// checks fail on the PC for doing exactly what the rule says.
const WIN = process.platform === 'win32';
const CKPT = WIN ? '/home/telltale/higgs_v3_merged/mb_v7_616' : path.join(TMP, 'mb_v7_616');
if (!WIN) fs.mkdirSync(CKPT);
/** What the override must carry for CKPT: the resolved host path, or the guest string verbatim. */
const CKPT_EXPECTED = WIN ? CKPT : fs.realpathSync(CKPT);
const OUT = path.join(TMP, 'out.wav');

/** Run the wrapper and return { rc, out } with stdout+stderr merged. */
function run(...args) {
  const r = spawnSync(PY, [path.join('cli', 'bookforge-tts.py'), ...args],
    { cwd: REPO, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { rc: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

/** An accepted case must have got PAST validation — the DRY RUN line proves it. */
function expectAccepted(label, res) {
  assert.ok(res.out.includes('DRY RUN'),
    `${label}: expected the dry run to be reached (rc=${res.rc})\n${res.out.slice(0, 700)}`);
  assert.strictEqual(res.rc, 0, `${label}: expected exit 0, got ${res.rc}\n${res.out.slice(0, 700)}`);
}

/** A refused case must FAIL and say why, in words that name the flag. */
function expectRefused(label, res, ...needles) {
  assert.notStrictEqual(res.rc, 0, `${label}: expected a non-zero exit\n${res.out.slice(0, 700)}`);
  for (const needle of needles) {
    assert.ok(res.out.includes(needle),
      `${label}: refusal must name "${needle}"\n${res.out.slice(0, 700)}`);
  }
  assert.ok(!res.out.includes('Traceback'),
    `${label}: refused by name, not by stack trace\n${res.out.slice(0, 700)}`);
}

// ── 1. A CHECKPOINT AND A SAMPLING VALUE REACH THE SETTINGS OBJECT ──────────
check('a checkpoint + temperature reach settings.higgsOverride', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn',
    '--checkpoint-dir', CKPT, '--temperature', '0.8',
    '--input', TXT, '--out', OUT, '--dry-run');
  expectAccepted('checkpoint override', res);
  // The printed object is the object: parse the wrapper's own line back.
  const line = res.out.split('\n').find((l) => l.trim().startsWith('higgs override: {'));
  assert.ok(line, `no "higgs override:" line\n${res.out.slice(0, 700)}`);
  const override = JSON.parse(line.slice(line.indexOf('{')));
  assert.strictEqual(override.checkpointDir, CKPT_EXPECTED,
    'the override carries the resolved checkpoint directory (the guest string verbatim on Windows)');
  assert.strictEqual(override.sampling.temperature, 0.8,
    'the override carries temperature 0.8');
  assert.ok(override.note && override.note.includes('bookforge-tts'),
    'and a note saying who ran it (default: the command as typed)');
  // It must also be what the ADAPTER was handed, not only what was printed.
  assert.ok(res.out.includes('"higgsOverride"'),
    'the adapter\'s resolved settings carry higgsOverride');
  // ORPHEUS_* IS ORPHEUS'S: a Higgs temperature must not also leak into the env,
  // where nothing would read it.
  assert.ok(!res.out.includes('ORPHEUS_TEMPERATURE'),
    'a Higgs temperature does not also travel as ORPHEUS_TEMPERATURE');
});

// ── 2-4. EACH FLAG BELONGS TO ONE ENGINE, AND SAYS WHICH ────────────────────
check('--checkpoint-dir on --engine orpheus is refused, naming --model-dir', () => {
  expectRefused('orpheus checkpoint',
    run('--tts', '--engine', 'orpheus', '--voice', 'tara', '--checkpoint-dir', CKPT,
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--checkpoint-dir', '--model-dir');
});

check('--model-dir on --engine higgs is refused, naming --checkpoint-dir', () => {
  expectRefused('higgs model-dir',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--model-dir', '/home/x',
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--model-dir', '--checkpoint-dir');
});

check('--rep-penalty on --engine higgs is refused by name', () => {
  expectRefused('higgs rep-penalty',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--rep-penalty', '1.1',
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--rep-penalty');
});

// ── 5-6. EACH FLAG BELONGS TO ONE DOOR, AND SAYS WHICH ──────────────────────
check('--max-chunks with --audiobook is refused, naming --tts', () => {
  // The project path is deliberately absent: a flag that could never work on
  // this door is wrong before the path is even resolved, and the message has to
  // arrive without making the operator fix the path first.
  expectRefused('audiobook max-chunks',
    run('--audiobook', '--project', path.join(TMP, 'no-such-project'),
      '--voice', 'mistborn', '--engine', 'higgs', '--max-chunks', '3', '--dry-run'),
    '--max-chunks', '--tts');
});

check('--as-chunks with an .epub input is refused by name', () => {
  expectRefused('epub as-chunks',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--as-chunks',
      '--input', EPUB, '--out', OUT, '--dry-run'),
    '--as-chunks');
});

// ── 7. HIGGS STREAMS, AND THE WRAPPER NO LONGER SAYS OTHERWISE ──────────────
check('--engine higgs --mode streaming is no longer refused at the wrapper', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--mode', 'streaming',
    '--input', TXT, '--out', OUT, '--dry-run');
  expectAccepted('higgs streaming', res);
  assert.ok(/spawn:.*orpheus-stream\.js/.test(res.out),
    `the streaming adapter is the spawn target\n${res.out.slice(0, 700)}`);
  assert.ok(res.out.includes('--engine higgs'),
    'and the engine rides to it, so a mismatch with the selection is refused there');
  assert.ok(!res.out.includes('no streaming path'),
    'the retired "v3 has no streaming path" refusal is gone');
});

// ── 8. THE MAC ARM'S KNOBS REACH THE ENV THE BRIDGE READS ───────────────────
check('--batch-width becomes NARRATOR_HIGGS3_MLX_BATCH on this platform', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn',
    '--batch-width', '4', '--mem-budget-gb', '40',
    '--input', TXT, '--out', OUT, '--dry-run');
  if (process.platform === 'win32') {
    // On the PC a Higgs render is SERVED and the width is the server's admission
    // width — the flag is refused by name there, which is the same contract seen
    // from the other side.
    expectRefused('win32 batch-width', res, '--batch-width', 'HIGGS_MAX_NUM_SEQS');
    return;
  }
  expectAccepted('mlx batch width', res);
  assert.ok(res.out.includes("'NARRATOR_HIGGS3_MLX_BATCH': '4'"),
    `the batch width is an env override\n${res.out.slice(0, 700)}`);
  assert.ok(res.out.includes("'NARRATOR_HIGGS3_MLX_MEM_BUDGET_GB': '40'"),
    `and so is the memory budget\n${res.out.slice(0, 700)}`);
});

// ── The inputs Owen asked for, down to test chunks ──────────────────────────
check('a .jsonl of test chunks is packed into a real EPUB, one <p> per row', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--as-chunks',
    '--max-chunks', '2', '--input', JSONL, '--out', OUT, '--dry-run');
  expectAccepted('jsonl chunks', res);
  const m = /input book(?: \(reused\))?: (\S+\.epub) — (\d+) paragraph/.exec(res.out);
  assert.ok(m, `the packed book is named in the output\n${res.out.slice(0, 700)}`);
  assert.strictEqual(m[2], '2', 'both rows became paragraphs');
  assert.ok(fs.existsSync(m[1]), `the packed book exists at ${m[1]}`);
  const bytes = fs.readFileSync(m[1]);
  assert.strictEqual(bytes.slice(0, 4).toString('hex'), '504b0304', 'it is a zip');
  // The EPUB spec wants `mimetype` FIRST and STORED: local header (30 bytes) +
  // the 8-byte name, then the literal media type, uncompressed.
  assert.strictEqual(bytes.indexOf('mimetype'), 30, 'mimetype is the first entry');
  assert.strictEqual(bytes.slice(38, 58).toString(), 'application/epub+zip',
    'and it is stored uncompressed, so it is a real EPUB');
  assert.ok(res.out.includes('"sentencePerParagraph":true'),
    '--as-chunks reaches settings.sentencePerParagraph');
  assert.ok(res.out.includes('"testMode":true') && res.out.includes('"testSentences":2'),
    '--max-chunks reaches settings.testMode/testSentences');
  assert.ok(res.out.includes('text cleanup: skipped'),
    '--as-chunks narrates the chunks as printed (textCleanup skipped)');
});

check('a .jsonl row that names no text is refused BY LINE NUMBER', () => {
  const bad = path.join(TMP, 'bad.jsonl');
  fs.writeFileSync(bad, '"fine"\n{"words":"not text"}\n', 'utf8');
  expectRefused('bad jsonl row',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--as-chunks',
      '--input', bad, '--out', OUT, '--dry-run'),
    'bad.jsonl:2', "'text'");
});

check('an unreadable input format is refused, naming the three it reads', () => {
  const odd = path.join(TMP, 'passage.rtf');
  fs.writeFileSync(odd, 'x', 'utf8');
  expectRefused('rtf input',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn',
      '--input', odd, '--out', OUT, '--dry-run'),
    '.epub', '.jsonl');
});

check('--safe-band is the Higgs band and Orpheus refuses it, naming --max-chars', () => {
  const ok = run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--safe-band', '200-700',
    '--input', TXT, '--out', OUT, '--dry-run');
  expectAccepted('higgs safe band', ok);
  assert.ok(ok.out.includes('"safeMinChars":200') && ok.out.includes('"safeMaxChars":700'),
    `the band reaches the override\n${ok.out.slice(0, 700)}`);
  expectRefused('orpheus safe band',
    run('--tts', '--engine', 'orpheus', '--voice', 'tara', '--safe-band', '200-700',
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--safe-band', '--max-chars');
  expectRefused('malformed band',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--safe-band', '200',
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--safe-band', 'MIN-MAX');
});

check('--note is what the override is stamped with when it is given', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn',
    '--checkpoint-dir', CKPT, '--note', 'pause screen, mb_v7_616 vs 440',
    '--input', TXT, '--out', OUT, '--dry-run');
  expectAccepted('explicit note', res);
  assert.ok(res.out.includes('pause screen, mb_v7_616 vs 440'),
    `the note travels verbatim\n${res.out.slice(0, 700)}`);
});

check('a --checkpoint-dir that is not a directory is refused before any render', () => {
  // On the Mac: a host path that does not exist. On Windows the host cannot
  // stat the guest, so the refusal the wrapper CAN make is the shape one — and
  // a C: path is exactly the wrong shape (it would drag the weights through the
  // 9p mount). Both refuse by name before any render.
  expectRefused('missing checkpoint',
    run('--tts', '--engine', 'higgs', '--voice', 'mistborn',
      '--checkpoint-dir', path.join(TMP, 'not-there'),
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--checkpoint-dir');
});

// ── WHERE THE SESSIONS GO — narrator has no default, so this must be STATED ─
check('--tts states the narrator scratch root, as the app does at startup', () => {
  const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--note', 'n',
    '--library', TMP, '--input', TXT, '--out', OUT, '--dry-run');
  expectAccepted('scratch root', res);
  const m = /\[batch\] scratch: (.+)/.exec(res.out);
  assert.ok(m, `the scratch root is stated and printed\n${res.out.slice(0, 700)}`);
  // The SAME two rules the app applies (`main.ts applyNarratorScratchRoot`): a
  // Settings override wins, else `<library>/tmp`. Read the override rather than
  // assuming it is unset, so this passes on a machine that has one.
  const override = require('../dist/electron/tool-paths.js').getConfig().narratorScratchPath;
  const expected = typeof override === 'string' && override.trim()
    ? override.trim()
    // realpath: the wrapper resolves --library against the user's cwd, and on
    // macOS /var is a symlink to /private/var — so the path that reaches the
    // adapter is the resolved one.
    : path.join(fs.realpathSync(TMP), 'tmp');
  assert.strictEqual(m[1].trim(), expected,
    'the stated root is the Settings override, else <library>/tmp');
});

check('a --tts run with no library and no recorded one is refused by name', () => {
  // The stub's USER_DATA follows HOME on the Mac and APPDATA on Windows
  // (cli/electron-stub.js mirrors app.getPath('userData')), so a fresh one is a
  // machine that has never chosen a library — which is the case that must NOT
  // silently become ~/Documents/BookForge. Both are pointed at the bare dir so
  // the check means the same thing on both machines.
  const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-no-library-'));
  const r = spawnSync(PY, [path.join('cli', 'bookforge-tts.py'),
    '--tts', '--engine', 'higgs', '--voice', 'mistborn', '--note', 'n',
    '--input', TXT, '--out', OUT, '--dry-run'],
    { cwd: REPO, encoding: 'utf8',
      env: { ...process.env, HOME: bareHome, USERPROFILE: bareHome, APPDATA: bareHome } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  try { fs.rmSync(bareHome, { recursive: true, force: true }); } catch { /* temp */ }
  assert.notStrictEqual(r.status, 0, `expected a non-zero exit\n${out.slice(0, 700)}`);
  assert.ok(out.includes('no library root') && out.includes('--library'),
    `refused by name, naming the flag that answers it\n${out.slice(0, 700)}`);
  assert.ok(!out.includes('Documents/BookForge'),
    'and NOT silently defaulted to ~/Documents/BookForge');
});

check('--library with --audiobook is refused: the project decides its library', () => {
  expectRefused('audiobook library',
    run('--audiobook', '--project', path.join(TMP, 'no-such-project'),
      '--voice', 'mistborn', '--engine', 'higgs', '--library', TMP, '--dry-run'),
    '--library', '--project');
});

check('--voice stays required: a checkpoint borrows a voice\'s certificate', () => {
  expectRefused('checkpoint with no voice',
    run('--tts', '--engine', 'higgs', '--checkpoint-dir', CKPT,
      '--input', TXT, '--out', OUT, '--dry-run'),
    '--voice');
});

// ─── THE HELP IS PART OF THE SURFACE (2026-09-12) ───────────────────────────
//
// Owen: *"ideally the bookforge cli would make it pretty straightforward how to
// use it by its flags and such."* So the help is defended like any other
// behaviour. What can rot: a flag registered outside a group (it then prints in
// argparse's anonymous "options:" heap and nothing says who reads it), a
// COMMAND_FLAGS entry naming a flag the parser does not have (a help page that
// lies), and a per-command page growing past what anyone reads in one screen or
// leaking another command's flags.
//
// The map and the groups are read out of the module itself, not scraped from its
// source: the point is what the PARSER was built with.
const INTROSPECT = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("bft", "cli/bookforge-tts.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
reg = m._flag_registry()
parser = m.build_parser()
print(json.dumps({
  "groups": reg.flag_groups(),
  "flags": [a.option_strings[0] for a in parser._actions if a.option_strings],
  "commands": {k: {"reads": v["reads"], "refuses": [f for f, _why in v["refuses"]],
                   "usage": v["usage"], "examples": v["examples"]}
               for k, v in m.COMMAND_FLAGS.items()},
  "registry": list(m.COMMANDS),
}))
`;

function introspect() {
  const r = spawnSync(PY, ['-c', INTROSPECT], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0,
    `introspection failed:\n${r.stdout || ''}${r.stderr || ''}`);
  return JSON.parse(r.stdout);
}
const CLI = introspect();

/** One command's --<cmd> --help page, as text. */
const helpCache = new Map();
function commandHelp(name) {
  if (!helpCache.has(name)) helpCache.set(name, run(`--${name}`, '--help'));
  return helpCache.get(name);
}

check('every parser flag belongs to exactly one group', () => {
  const owners = new Map();
  for (const [title, flags] of Object.entries(CLI.groups)) {
    for (const flag of flags) {
      assert.ok(!owners.has(flag),
        `${flag} is registered in two groups: "${owners.get(flag)}" and "${title}"`);
      owners.set(flag, title);
    }
  }
  for (const flag of CLI.flags) {
    if (flag === '-h') continue;                 // argparse's own
    assert.ok(owners.has(flag),
      `${flag} is in no group — it would print in argparse's anonymous "options:" `
      + 'heap, where nothing says which command reads it');
  }
  assert.strictEqual(owners.size, CLI.flags.length - 1,
    'a group names a flag the parser does not have');
});

check('every flag in COMMAND_FLAGS exists on the parser', () => {
  const known = new Set(CLI.flags);
  assert.deepStrictEqual(Object.keys(CLI.commands).sort(), CLI.registry.slice().sort(),
    'COMMAND_FLAGS covers exactly the COMMANDS registry');
  for (const [name, spec] of Object.entries(CLI.commands)) {
    for (const list of ['reads', 'refuses']) {
      for (const flag of spec[list]) {
        assert.ok(known.has(flag), `COMMAND_FLAGS["${name}"].${list} names ${flag}, `
          + 'which is not a flag on the parser — a help page that lies');
      }
    }
    // Usage and examples are copy-pasteable or they are worse than nothing: every
    // flag they spell must be one this command actually reads.
    const shown = new Set(`${spec.usage}\n${spec.examples.join('\n')}`
      .match(/--[a-z0-9][a-z0-9-]*/g) || []);
    for (const flag of shown) {
      if (flag === `--${name}`) continue;
      assert.ok(spec.reads.includes(flag),
        `COMMAND_FLAGS["${name}"] shows ${flag} in its usage/examples, but does not read it`);
    }
  }
});

check('every --<command> --help exits 0, fits a screen, and names its own flags', () => {
  for (const [name, spec] of Object.entries(CLI.commands)) {
    const res = commandHelp(name);
    assert.strictEqual(res.rc, 0, `--${name} --help exited ${res.rc}\n${res.out.slice(0, 400)}`);
    const lines = res.out.replace(/\n$/, '').split('\n');
    assert.ok(lines.length < 120,
      `--${name} --help is ${lines.length} lines — past what anyone reads in one screen`);
    assert.ok(res.out.includes('Examples'), `--${name} --help carries no Examples`);
    assert.ok(spec.reads.some((flag) => res.out.includes(flag)),
      `--${name} --help names none of the flags it reads`);
    assert.ok(res.out.includes(spec.usage.split(' ').slice(0, 3).join(' ')),
      `--${name} --help carries no usage line for the command`);
  }
});

// Two concrete pairs, because "does not leak" is only testable against a flag
// that unambiguously belongs to somebody else.
check('a command\'s page does not name another command\'s exclusive flags', () => {
  for (const [name, alien] of [['tts', '--indices'], ['retake', '--checkpoint-dir'],
                               ['assemble', '--max-chars'], ['rvc', '--rvc-voice-id']]) {
    const owner = Object.entries(CLI.commands)
      .filter(([, s]) => s.reads.includes(alien)).map(([n]) => n);
    assert.ok(!owner.includes(name),
      `${alien} is read by --${name}, so it is the wrong flag to test leakage with`);
    assert.ok(!commandHelp(name).out.includes(alien),
      `--${name} --help mentions ${alien}, which belongs to --${owner.join('/--')}`);
  }
});

check('the full --help still lists every command selector', () => {
  const res = run('--help');
  assert.strictEqual(res.rc, 0, `--help exited ${res.rc}`);
  for (const name of CLI.registry) {
    assert.ok(res.out.includes(`--${name}`), `--help does not list --${name}`);
  }
  assert.ok(res.out.includes('Commands (pick one)'),
    'the selectors sit in a group that says they are the commands');
  // Two selectors plus --help is the ordinary full help, not a guess at which one
  // the question was about.
  const both = run('--tts', '--audiobook', '--help');
  assert.strictEqual(both.rc, 0, 'two selectors + --help still exits 0');
  assert.ok(both.out.includes('Commands (pick one)') && both.out.includes('--generate-epub'),
    'two selectors + --help is the FULL help');
});

// ── A TYPED DRIVE LETTER SURVIVES THE WRAPPER ON WINDOWS (2026-09-12) ────────
//
// `Path.resolve()` on Windows rewrites a mapped network drive to its UNC target:
// the titan library `Z:\bookforge` came out of the wrapper as
// `\\TITAN\iO\bookforge`, a spelling the app never uses and the bridge's WSL
// mapping cannot open in the guest (the CLI defect recorded 2026-09-11). The
// wrapper now makes a typed path absolute WITHOUT resolving it (`_user_path`).
// Proved here with a `subst` drive — the same class of drive letter, and one
// this check can create and remove without a share — pointed at the temp dir.
check('a typed drive letter reaches the adapter as typed, not as its UNC/target (Windows)', () => {
  const src = fs.readFileSync(path.join(REPO, 'cli', 'bookforge-tts.py'), 'utf8');
  assert.ok(/def _user_path\(/.test(src), 'the wrapper has ONE helper for operator-typed paths');
  assert.ok(!/Path\(args\.[a-z_]+\)(\.expanduser\(\))?\.resolve\(\)/.test(src),
    'no operator-typed path goes through Path.resolve() directly — every one goes through _user_path');
  if (!WIN) return;                                   // resolve() keeps drive letters nowhere else
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-subst-'));
  // A free letter: the first one with no drive behind it. `subst` refuses a
  // letter in use, and a machine with Q: mapped would otherwise fail the check
  // for the wrong reason.
  const letter = 'QRSTUVWXY'.split('').find((l) => !fs.existsSync(`${l}:\\`));
  assert.ok(letter, 'no free drive letter in Q–Y to subst');
  const made = spawnSync('subst', [`${letter}:`, target], { encoding: 'utf8' });
  assert.strictEqual(made.status, 0, `subst ${letter}: failed: ${made.stdout}${made.stderr}`);
  try {
    const res = run('--tts', '--engine', 'higgs', '--voice', 'mistborn', '--note', 'n',
      '--library', `${letter}:\\`, '--input', TXT, '--out', OUT, '--dry-run');
    expectAccepted('subst library', res);
    const m = /\[batch\] scratch: (.+)/.exec(res.out);
    assert.ok(m, `the scratch root is printed\n${res.out.slice(0, 700)}`);
    assert.strictEqual(m[1].trim(), `${letter}:\\tmp`,
      `the drive letter is kept (Path.resolve() would have given ${target}\\tmp)`);
  } finally {
    spawnSync('subst', [`${letter}:`, '/D'], { encoding: 'utf8' });
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
