#!/usr/bin/env node
/**
 * THE CLI RUNS THE APP'S CODE, NOT A COPY OF IT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-cli-parity.js
 *
 * Owen, 2026-09-05: *"we have the bookforge-cli specifically for testing code
 * paths from the command line. its supposed to use the exact same code path as
 * the app, so we can test bugs from a high level."* A CLI command that
 * reimplemented its job could not catch the app's bugs, which is the only reason
 * the CLI exists — so what is defended here is the WIRE, per command:
 *
 *   1. the adapter requires the COMPILED bridge (dist/electron/…), not a source
 *      file and not a local copy;
 *   2. it calls the exact exported symbol the app's queue step calls;
 *   3. that symbol is really ON the compiled module — so a rename in electron/
 *      fails here rather than at 3 a.m. in a shell;
 *   4. the Python front end registers the command, with a handler and the
 *      adapter path it names.
 *
 * This is the shape `tools/test-cli-narration-prep.js` established for the
 * narration door ("the render adapters call the door"), generalized to every
 * command added since. It loads compiled modules and touches no GPU, no model
 * and no library.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: that a command exists for every app
 * action. Several app actions cannot be reached headlessly at all (an offscreen
 * BrowserWindow, a non-nullable window parameter, a mounted Foundry renderer) —
 * those are recorded in docs/CLI_PARITY_AUDIT.md with the reason, and inventing
 * a CLI door for them would mean inventing a second implementation, which is the
 * thing this file exists to prevent.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The compiled bridges reach for Electron's `app` at IMPORT time (the managed-bin
// resolver wants userData), so loading them here needs the same shim every CLI
// adapter runs under — cli/electron-stub.js. Requiring it is exactly what the
// adapters do; a test that dodged it would be testing a different load order
// from the one production uses.
require('../cli/electron-stub.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  pending.push([name, fn]);
}

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/**
 * One row of the parity table: a CLI adapter, the compiled module it must
 * require, and the exported symbols it must call on it.
 *
 * The module list is what the APP's own step imports — see
 * electron/queue-steps/*.ts and the IPC handlers in electron/main.ts. A row here
 * that stops matching means the CLI and the app have drifted apart, which is
 * exactly the drift Owen's rule forbids.
 */
const WIRES = [
  {
    adapter: 'cli/final-denoise.js',
    module: 'denoise-job.js',
    calls: ['runFinalDenoise', 'stopFinalDenoise'],
    appDoor: 'electron/queue-steps/final-denoise.ts',
  },
  {
    adapter: 'cli/rvc-enhance.js',
    module: 'rvc-job.js',
    calls: ['runRvcEnhancement', 'stopRvcEnhancement'],
    appDoor: 'electron/queue-steps/rvc-enhancement.ts',
  },
  {
    adapter: 'cli/correct-sentences.js',
    module: 'correct-sentences-bridge.js',
    calls: ['getCorrectSentencesSession', 'generateCandidates', 'commitSentence',
            'revertSentence', 'cleanupCandidates'],
    appDoor: 'electron/main.ts',
  },
  {
    adapter: 'cli/processing-pass-step.js',
    module: 'processing-passes.js',
    calls: ['runProcessingPass'],
    appDoor: 'electron/queue-steps/pass.ts',
  },
  {
    adapter: 'cli/processing-pass-step.js',
    module: 'processing-chain.js',
    calls: ['planProcessingChain'],
    appDoor: 'electron/main.ts',
  },
  {
    adapter: 'cli/session-target.js',
    module: 'reassembly-bridge.js',
    calls: ['getBfpCachedSession'],
    appDoor: 'electron/queue-steps/final-denoise.ts',
  },
  {
    adapter: 'cli/orpheus-audiobook-render.js',
    module: 'reassembly-bridge.js',
    calls: ['startReassembly', 'getSession'],
    appDoor: 'electron/queue-steps/reassembly.ts',
  },
  {
    adapter: 'cli/orpheus-audiobook-render.js',
    module: 'denoise-job.js',
    calls: ['runFinalDenoise'],
    appDoor: 'electron/queue-steps/final-denoise.ts',
  },
];

for (const wire of WIRES) {
  test(`${wire.adapter} requires the COMPILED ${wire.module} and calls ${wire.calls.join('/')}`,
    () => {
      const source = read(wire.adapter);
      assert.ok(source.includes(`require('../dist/electron/${wire.module}')`),
        `${wire.adapter} loads dist/electron/${wire.module} — the app's own compiled module, `
        + 'not a source file and not a copy');
      for (const symbol of wire.calls) {
        assert.ok(source.includes(symbol),
          `${wire.adapter} names ${symbol} (the symbol ${wire.appDoor} calls)`);
      }
      // The symbol is really there. A rename in electron/ has to fail HERE.
      const compiled = require(path.join(DIST, wire.module));
      for (const symbol of wire.calls) {
        assert.strictEqual(typeof compiled[symbol], 'function',
          `dist/electron/${wire.module} exports ${symbol} as a function`);
      }
    });
}

test('no new adapter reimplements the pass it drives', () => {
  // A CLI that spawned its own python, built its own ffmpeg command line, or
  // wrote its own derived-sentence directory would be the second implementation
  // this whole design exists to avoid. The three enhancement adapters are
  // argument plumbing and progress printing, and nothing else.
  for (const adapter of ['cli/final-denoise.js', 'cli/rvc-enhance.js', 'cli/session-target.js',
                         'cli/processing-pass-step.js']) {
    const source = read(adapter);
    for (const forbidden of ['spawn(', 'spawnSync(', 'execFile(', 'ffmpeg']) {
      assert.ok(!source.includes(forbidden),
        `${adapter} does not ${forbidden} — the compiled job owns every process it starts`);
    }
  }
});

test('--assemble is the SAME adapter as --audiobook, with --assemble-only', () => {
  // Not a second assembly: the app's "Assemble" over a cached session is
  // runFinalDenoise + startReassembly, and orpheus-audiobook-render.js already
  // makes exactly those two calls. A separate cli/assemble.js would have been a
  // second copy of the config the reassembly bridge is handed.
  const py = read('cli/bookforge-tts.py');
  assert.ok(/COMMANDS = \{[\s\S]*"assemble": cmd_assemble,/.test(py), 'registered');
  assert.ok(py.includes('def cmd_assemble(args):'), 'and has its handler');
  assert.ok(py.includes('def _audiobook_spawn(args, assemble_only):'),
    'both commands share one spawn builder');
  assert.ok(py.includes('return _audiobook_spawn(args, assemble_only=True)'),
    '--assemble is that builder with assemble_only');
  assert.ok(py.includes('return _audiobook_spawn(args, assemble_only=False)'),
    'and --audiobook is the same builder without it');
  assert.ok(!fs.existsSync(path.join(REPO, 'cli', 'assemble.js')),
    'there is no second assembly adapter');
  const adapter = read('cli/orpheus-audiobook-render.js');
  assert.ok(adapter.includes("args['assemble-only']"), 'the adapter reads the flag');
});

test('the render-time gap and the assembly-time gap are two different flags', () => {
  // --sentence-gap is what the WORKER bakes into each FLAC (env
  // ORPHEUS_SENTENCE_GAP, read at render). --assembly-gap is what the pass in
  // FRONT of assembly re-lays. One flag for both would mean a value whose
  // meaning depended on which command read it.
  const py = read('cli/bookforge-tts.py');
  assert.ok(py.includes('"--assembly-gap", dest="assembly_gap"'), '--assembly-gap exists');
  assert.ok(py.includes('env["ORPHEUS_SENTENCE_GAP"] = str(args.sentence_gap)'),
    '--sentence-gap still travels as the render-time env seam');
  assert.ok(/if args\.assembly_gap is not None:\s*\n\s*cmd \+= \["--sentence-gap", str\(args\.assembly_gap\)\]/
    .test(py), 'and --assembly-gap is what reaches the adapter\'s assembly flag');
});

test('every new command is registered, with a handler and an adapter that exists', () => {
  const py = read('cli/bookforge-tts.py');
  const rows = [
    ['assemble', 'cmd_assemble', null],
    ['denoise', 'cmd_denoise', 'cli/final-denoise.js'],
    ['rvc-enhance', 'cmd_rvc_enhance', 'cli/rvc-enhance.js'],
    ['retake', 'cmd_retake', 'cli/correct-sentences.js'],
    ['pass', 'cmd_pass', 'cli/pass.js'],
  ];
  for (const [name, handler, adapter] of rows) {
    assert.ok(new RegExp(`COMMANDS = \\{[\\s\\S]*"${name}": ${handler},`).test(py),
      `--${name} is in the registry`);
    assert.ok(py.includes(`def ${handler}(args):`), `--${name} has its handler`);
    if (adapter) {
      assert.ok(fs.existsSync(path.join(REPO, adapter)), `${adapter} exists`);
    }
  }
});

test('--rvc and --rvc-enhance are named as two different jobs, not one', () => {
  // rvc-bridge.convertFileRvcChunked converts ONE FINISHED FILE; rvc-job
  // .runRvcEnhancement converts a session's PER-SENTENCE cache into a derived
  // set assembly reads. Collapsing them would silently answer a request for one
  // with the other.
  const py = read('cli/bookforge-tts.py');
  assert.ok(py.includes('"rvc": cmd_rvc,') && py.includes('"rvc-enhance": cmd_rvc_enhance,'),
    'both are registered');
  assert.ok(read('cli/rvc-convert.js').includes('convertFileRvcChunked'),
    '--rvc is the whole-file door');
  assert.ok(read('cli/rvc-enhance.js').includes('runRvcEnhancement'),
    '--rvc-enhance is the session door');
  assert.ok(read('cli/rvc-enhance.js').includes('NOT `--rvc`'),
    'and the adapter says which one it is not');
});

test('the enhancement adapters resolve their session through ONE rule', () => {
  // Both passes take a processDir and nothing else, and both resolve it the same
  // way the app's steps do at the end of their ladder: an explicit dir, or the
  // project's CACHED session via getBfpCachedSession. Two copies of that rule
  // would be two answers to "which session is this".
  for (const adapter of ['cli/final-denoise.js', 'cli/rvc-enhance.js']) {
    const source = read(adapter);
    assert.ok(source.includes("require('./session-target.js')"),
      `${adapter} shares the resolver`);
    assert.ok(source.includes('resolveSessionTarget('), `${adapter} calls it`);
    assert.ok(!source.includes('scanProjectSessions'),
      `${adapter} does not scan for a session of its own`);
  }
  // And the shared resolver REFUSES rather than guessing.
  const resolver = read('cli/session-target.js');
  assert.ok(/has no cached render/.test(resolver), 'a project with no session is refused by name');
});

test('the pass adapter refuses a kind that is not a live processing pass', () => {
  // `narration-text` is a live kind but has its own command (it also has a
  // bare-EPUB door); `vlm-convert` and the retired kinds are not passes at all.
  // Both cases are refused with a sentence rather than planned and failed later.
  const source = read('cli/pass.js');
  assert.ok(/const KINDS = \['simplify', 'translate', 'footnote-refs'\];/.test(source),
    'the three kinds --pass owns');
  assert.ok(source.includes('narration-text has its own command'),
    'and it names where the fourth one lives');
});

test('the help lists every command AND the sibling adapters', () => {
  // Owen's gate: `--help` names every action. argparse generates a flag per
  // COMMANDS key; the three adapters with grammars of their own (library verbs,
  // ClipForge chains, the bookshelf server) are named in the epilog, because
  // wrapping them in this flat flag namespace would mean inventing a second
  // spelling for every option they already have.
  const py = read('cli/bookforge-tts.py');
  assert.ok(py.includes('SIBLING_ADAPTERS = {'), 'the siblings are declared');
  for (const sibling of ['cli/library.js', 'cli/clipforge-process.js', 'cli/serve-bookshelf.js']) {
    assert.ok(py.includes(`"${sibling}"`), `${sibling} is named in the help`);
    assert.ok(fs.existsSync(path.join(REPO, sibling)), `${sibling} exists`);
  }
  assert.ok(py.includes('epilog=epilog'), 'and the epilog reaches the parser');
});

test('the CLI declares its own output encoding, so --help survives a cp1252 console', () => {
  // Measured 2026-09-05: on a default Windows console `--help` died with
  // UnicodeEncodeError on the "≤" in the packing-cap help, before printing a
  // single command. The fix is to state the encoding; deleting the character
  // would be rewriting documentation to suit a codec.
  const py = read('cli/bookforge-tts.py');
  assert.ok(py.includes('_stream.reconfigure(encoding="utf-8")'),
    'stdout and stderr are declared UTF-8');
});

test('the ALIGN gap is recorded, and no second spawn builder was invented for it', () => {
  // `narrator align` exists in python/narrator and `compat/app.py` already takes
  // --coverage_report, but NOTHING in TypeScript builds either: there is no
  // 'align' phase on buildNarratorSpawn and no --coverage_report anywhere under
  // electron/. Until the app-side step lands, a CLI align door would be the
  // FIRST implementation of a spawn the app does not yet have — a second one by
  // the time it does. So it is a named gap, and this asserts it stayed one.
  const spawn = read('electron/narrator-spawn.ts');
  const phases = /export type NarratorPhase =([^;]*);/.exec(spawn);
  assert.ok(phases, 'NarratorPhase is declared');
  const appSideAlignExists = phases[1].includes("'align'");
  const cliAlignExists = fs.existsSync(path.join(REPO, 'cli', 'narrator-align.js'));
  if (!appSideAlignExists) {
    assert.ok(!cliAlignExists,
      'no cli/narrator-align.js while the app has no align phase — the CLI mirrors the '
      + 'app\'s code path, it does not lead it');
    const audit = read('docs/CLI_PARITY_AUDIT.md');
    assert.ok(/align/i.test(audit) && /MISSING/.test(audit),
      'and docs/CLI_PARITY_AUDIT.md records align as MISSING');
  }
});

(async () => {
  for (const [name, fn] of pending) {
    try {
      await fn();
      passed++;
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`      ${err.message}`);
    }
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
