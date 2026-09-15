#!/usr/bin/env node
/**
 * WHICH MACHINE DID THE WORK IS PART OF THE MEASUREMENT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-analytics-venue.js
 *
 * ── What this keeps out ─────────────────────────────────────────────────────
 *
 * Owen, 2026-09-15: *"the analytics data should contain which crucible server
 * was used"*. He had just run "Working Towards The Fuhrer" on both machines and
 * could not tell the two rows apart: the records counted 89 chunks, 301
 * sentences and 42,059 characters on each and said nothing about where. Every
 * rate in those records — 151.3 sent/min against 109.5 — is a property of the
 * CARD as much as of the book, and the comparison is the reason they are
 * counted at all (`measureThroughput`: "Every number here is COUNTED from the
 * run"). A rate with no machine attached is not a measurement, it is half of
 * one.
 *
 * Four ways to get this wrong, and every one of them is silent:
 *
 * 1. **Recording the REQUEST instead of the RESOLVED venue.** What a caller
 *    asked for and where the job landed are two facts. The routing record picks
 *    for a caller that names nothing, so the request is frequently empty while
 *    the answer is not — and a record built from the request would be blank on
 *    exactly the runs the operator did not steer by hand.
 *
 * 2. **Defaulting the absence.** A record without the field is a record from
 *    before the field existed (every one written before 2026-09-15), or a step
 *    that genuinely had no Crucible venue. Both are honest. Filling either in
 *    with "local", with this machine, or with whichever server is configured
 *    NOW puts a card that did no work onto somebody else's figures — and once
 *    written it is indistinguishable from a recorded fact.
 *
 * 3. **Refusing an old record.** The absence must not make a row unreadable.
 *    Ten runs of history sit in each project's job-analytics.json and every one
 *    of them predates this field.
 *
 * 4. **Special-casing a name, or inventing a display label.** The reserved
 *    `local` identity is being erased (2026-09-15) — after it every Crucible
 *    server is an ordinary registry entry named by its GPU, "3090 Ti" or "M1
 *    Ultra", and BookForge cannot tell local from remote. Anything here that
 *    branched on a name, or mapped one to a prettier one, would be a second
 *    owner of a name the operator already chose (crucible
 *    `docs/ARCHITECTURE.md` R1) and would go stale the day that lands.
 *
 * And a fifth thing this pins, which is a FINDING rather than a rule: not every
 * record knows its venue, and the ones that do not say so in writing instead of
 * carrying a field that is always empty. See the RVC section at the bottom.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'ai-bridge.js'))) {
  console.log('SKIP: dist/electron/ai-bridge.js is not built — run '
    + 'npx tsc -p tsconfig.electron.json');
  process.exit(0);
}

// ai-bridge statically requires 'electron' for the power blocker; the CLI's own
// shim answers it, so the module under test loads exactly as it does headless.
// Same preamble as tools/test-simplify-blocks.js, for the same reason.
require('../cli/electron-stub.js');

// It also loads its prompt files on import and calls a missing one FATAL, which
// `npm run build:electron` copies into dist and a bare `npx tsc` does not.
const PROMPTS = path.join(DIST, 'prompts');
if (!fs.existsSync(PROMPTS)) {
  fs.cpSync(path.join(REPO, 'electron', 'prompts'), PROMPTS, { recursive: true });
}

const { aiCallServer } = require(path.join(DIST, 'ai-bridge.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err && err.message}`);
    process.exitCode = 1;
  }
}

/** Read a source file as text, for the assertions a runtime check cannot make. */
function source(relative) {
  return fs.readFileSync(path.join(REPO, relative), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The AI side: one reader of "which machine", and null is a real answer
// ─────────────────────────────────────────────────────────────────────────────

check('aiCallServer returns the crucible block\'s server, verbatim', () => {
  assert.strictEqual(
    aiCallServer({ provider: 'crucible', crucible: { server: '3090 Ti', act: 'clean' } }),
    '3090 Ti',
  );
});

check('no name is special-cased — the retired "local" identity is just a name', () => {
  // The `local` erasure lands underneath this: after it, a server called
  // "local" is an ordinary registry entry and nothing here may treat it as one
  // of a kind. Before it, "local" is what the reserved identity is called. Both
  // want the same behaviour, which is to repeat the name.
  for (const name of ['local', 'mac', 'M1 Ultra', '3090 Ti']) {
    assert.strictEqual(
      aiCallServer({ provider: 'crucible', crucible: { server: name, act: 'clean' } }),
      name,
      `"${name}" must be recorded verbatim`,
    );
  }
});

check('the local llama arm reports null, never a substituted machine', () => {
  assert.strictEqual(aiCallServer({ provider: 'local', local: { model: 'qwen' } }), null);
});

check('a provider this build removed reports null rather than a survivor', () => {
  // A row persisted before phase 15 can still name ollama/claude/openai. None of
  // them has a Crucible server, and pointing one at a survivor would attribute a
  // run to a machine it never touched.
  for (const gone of ['ollama', 'claude', 'openai']) {
    assert.strictEqual(aiCallServer({ provider: gone }), null, `"${gone}" must report null`);
  }
});

check('a crucible block that names no server reports null, not a guess', () => {
  assert.strictEqual(aiCallServer({ provider: 'crucible' }), null);
  assert.strictEqual(aiCallServer({ provider: 'crucible', crucible: { act: 'clean' } }), null);
});

check('aiCallServer reads only the block — no registry, no network, no clock', () => {
  // Purity is what makes it safe at the moment a record is written: the answer
  // is the one the run was placed with, not the routing record's answer today.
  const before = aiCallServer({ provider: 'crucible', crucible: { server: 'mac', act: 'clean' } });
  const after = aiCallServer({ provider: 'crucible', crucible: { server: 'mac', act: 'clean' } });
  assert.strictEqual(before, 'mac');
  assert.strictEqual(after, 'mac');
  assert.strictEqual(aiCallServer.length, 1, 'it takes the block and nothing else');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Every analytics record that HAS a venue writes it
// ─────────────────────────────────────────────────────────────────────────────

check('the TTS record names its venue on BOTH terminal paths', () => {
  const src = source('electron/parallel-tts-bridge.ts');
  const writes = src.match(/crucibleServer: renderVenueName\(session\)/g) || [];
  assert.strictEqual(
    writes.length, 2,
    'a finished render and a cancelled one each file a record, and a cancelled run '
    + 'measured real work on a real card — both must name it (found '
    + `${writes.length} of 2)`,
  );
});

check('renderVenueName reads the RESOLVED venue, not settings.crucible', () => {
  const src = source('electron/parallel-tts-bridge.ts');
  const body = /function renderVenueName\(session: ConversionSession\): string \| undefined \{([\s\S]*?)\n\}/
    .exec(src);
  assert.ok(body, 'renderVenueName must exist with that exact shape');
  assert.match(
    body[1], /return session\.venue\?\.server;/,
    '`session.venue` is what decideWhereGenerationRuns ANSWERED and what '
    + 'startCrucibleGeneration was handed. Reading `settings.crucible` instead would '
    + 'record the request, which is empty on every run the routing record placed.',
  );
  assert.ok(
    !/\?\?|\|\|/.test(body[1]),
    'no fallback: a session with no venue generated nothing, and "no name" is the '
    + 'honest answer for it',
  );
});

check('the cleanup record names its venue, as its own field', () => {
  const src = source('electron/ai-bridge.ts');
  assert.match(src, /crucibleServer: aiCallServer\(config\) \?\? undefined,/);
  // The composite `crucible/<server>/<model>` display string stays: old records
  // are full of it and the panel prints it. The point of the field is that
  // comparing two machines must not mean parsing a label.
  assert.match(
    src, /modelName = `crucible\/\$\{config\.crucible\.server\}\/\$\{config\.crucible\.model\}`/,
    'the existing composite model string must be left alone',
  );
});

check('both analysis records name their venue', () => {
  const src = source('electron/book-analysis.ts');
  const writes = src.match(/crucibleServer: aiCallServer\(providerConfig\) \?\? undefined,/g) || [];
  assert.strictEqual(
    writes.length, 2,
    'the book analysis and the audiobook analysis each file one (found '
    + `${writes.length} of 2)`,
  );
});

check('the translation record names its venue, read once beside the model', () => {
  const src = source('electron/mono-translation-job.ts');
  assert.match(src, /const serverName = aiCallServer\(config\.provider\);/);
  assert.match(src, /crucibleServer: serverName \?\? undefined,/);
});

check('undefined, never null, is what keeps an unknown venue OFF the record', () => {
  // Two spellings of "not known" in one file is the shape every defect in this
  // system turned out to be. `?? undefined` is what collapses them to one.
  for (const [file, needle] of [
    ['electron/ai-bridge.ts', /crucibleServer: aiCallServer\(config\) \?\? undefined/],
    ['electron/book-analysis.ts', /crucibleServer: aiCallServer\(providerConfig\) \?\? undefined/],
    ['electron/mono-translation-job.ts', /crucibleServer: serverName \?\? undefined/],
  ]) {
    assert.match(source(file), needle, `${file} must not write a null venue`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. An old record keeps opening, and nothing repairs its absence
// ─────────────────────────────────────────────────────────────────────────────

check('the field is OPTIONAL everywhere it is declared', () => {
  // Required would make every record written before 2026-09-15 — ten runs of
  // history per project — fail to type, and would invite a default to satisfy it.
  const declarations = [
    ['src/app/core/models/analytics.types.ts', 3],   // TTS, cleanup, translation
    ['electron/ai-bridge.ts', 1],                    // CleanupJobAnalytics
    ['electron/book-analysis.ts', 1],                // AnalysisAnalytics
    ['electron/mono-translation-job.ts', 1],         // TranslationJobAnalytics
  ];
  for (const [file, expected] of declarations) {
    const found = (source(file).match(/^\s*crucibleServer\?: string;$/gm) || []).length;
    assert.strictEqual(
      found, expected,
      `${file} must declare crucibleServer as optional ${expected} time(s), found ${found}`,
    );
    assert.ok(
      !/^\s*crucibleServer: string;$/m.test(source(file)),
      `${file} must not declare it required`,
    );
  }
});

check('the panel draws the venue only when the record has one', () => {
  const panel = source(
    'src/app/features/audiobook/components/analytics-panel/analytics-panel.component.ts');
  assert.match(
    panel, /@if \(job\.crucibleServer\) \{/,
    'an old record must draw no Server card at all — a placeholder reading "unknown", '
    + 'or this machine\'s current server, would be a venue the run never recorded',
  );
  assert.match(panel, /\{\{ job\.crucibleServer \}\}/, 'and it prints the name verbatim');
  assert.ok(
    !/crucibleServer\s*(\?\?|\|\|)/.test(panel),
    'no fallback value anywhere near it',
  );
});

check('nothing anywhere defaults, repairs or renames a missing venue', () => {
  // The whole repo, because the hazard is a well-meaning reader somewhere else:
  // `crucibleServer ?? 'local'`, `|| 'unknown'`, or a lookup table turning a
  // registry name into a prettier one. The `local` erasure makes the first of
  // those actively wrong, and a display-label indirection is ruled out outright.
  const roots = ['electron', 'src', 'shared', 'cli', 'tools'];
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
        walk(full);
      } else if (/\.(ts|js|html)$/.test(entry.name) && entry.name !== 'test-analytics-venue.js') {
        const text = fs.readFileSync(full, 'utf8');
        // A read of the field immediately followed by a substitute value.
        const bad = text.match(/crucibleServer\s*(\?\?|\|\|)\s*(?!undefined)\S+/g);
        if (bad) offenders.push(`${path.relative(REPO, full)}: ${bad.join(', ')}`);
      }
    }
  };
  for (const root of roots) walk(path.join(REPO, root));
  assert.deepStrictEqual(
    offenders, [],
    'a missing venue must stay missing:\n  ' + offenders.join('\n  '),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE RECORD THAT DOES NOT KNOW — written down, not papered over
// ─────────────────────────────────────────────────────────────────────────────

check('the RVC record carries NO venue field, and says why in both copies', () => {
  // Its one producer is the RVC pass inside a TTS session, which runs
  // `enhanceSentences` — the local urvc spawn, on this machine's card, whatever
  // venue the render went to. A field here would be absent on every row this
  // code can write, which reads as "a record from before the field" and is a lie
  // about the reason. The Crucible `rvc` door knows its venue and files no
  // analytics record at all, so there is no row to put it on.
  const main = source('electron/parallel-tts-bridge.ts');
  const rvcInterface = /interface RvcJobAnalytics \{([\s\S]*?)\n\}/.exec(main);
  assert.ok(rvcInterface, 'RvcJobAnalytics must exist in the main-process copy');
  // A DECLARATION, not the word: both copies are required (below) to NAME the
  // absent field in the comment explaining why it is absent.
  assert.ok(
    !/crucibleServer\s*\??:/.test(rvcInterface[1]),
    'the RVC record must not carry a venue field it can never fill',
  );
  assert.match(
    rvcInterface[1], /enhanceSentences/,
    'and must name the local spawn that is the reason, so the omission reads as a '
    + 'finding rather than an oversight',
  );

  const renderer = source('src/app/core/models/analytics.types.ts');
  const rendererInterface = /export interface RvcJobAnalytics \{([\s\S]*?)\n\}/.exec(renderer);
  assert.ok(rendererInterface, 'RvcJobAnalytics must exist in the renderer copy');
  assert.ok(!/crucibleServer\s*\??:/.test(rendererInterface[1]));
  assert.match(
    rendererInterface[1], /rvc-bridge|enhanceSentences/,
    'the renderer copy must carry the same reason — two copies of a type with one '
    + 'explanation between them is one place for the reason to be lost',
  );
});

check('the deterministic TTS-prep pass records no venue, and says so', () => {
  const src = source('electron/ai-bridge.ts');
  const prep = /model: 'none \(deterministic TTS prep\)',([\s\S]{0,400})/.exec(src);
  assert.ok(prep, 'the deterministic pass must still file its record');
  assert.ok(
    !/crucibleServer:/.test(prep[1]),
    'it sends nothing to any machine, so it has no venue to name',
  );
  assert.match(prep[1], /No `crucibleServer`/, 'and the omission must be written down');
});

console.log(`\n${passed} check(s) passed.`);
if (process.exitCode) {
  console.error('FAILED');
} else {
  console.log('PASS');
}
