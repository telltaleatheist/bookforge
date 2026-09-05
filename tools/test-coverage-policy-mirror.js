#!/usr/bin/env node
/**
 * THE TWO COVERAGE TABLES SAY THE SAME THING.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-coverage-policy-mirror.js
 *
 * ── Why there are two ───────────────────────────────────────────────────────
 *
 * `python/narrator/assemble/engine_profiles.py` owns the coverage policy: the
 * thresholds, and the `enforced` flag that decides whether a failed chunk stops
 * a book. Assembly reads it and refuses.
 *
 * BookForge has to know the same yes/no BEFORE any of that happens — the run
 * description decides whether a run carries an Align row at all, the narration
 * dialog refuses a guarded run whose aligner is not installed, and both assembly
 * spawns decide whether to pass `--coverage_report`. None of those can import a
 * Python module, and `shared/queue/` may not even touch a disk.
 *
 * ── What a divergence costs ─────────────────────────────────────────────────
 *
 * It is silent in the direction that matters. If Python enforces an engine that
 * TypeScript thinks is unguarded, BookForge queues no Align row and passes no
 * report, and every book of that engine renders for hours and then stops dead at
 * assembly quoting a command line — which is the exact bug the Align row was
 * written to remove, reintroduced by a one-line edit in the other language.
 *
 * So the mirror is asserted rather than trusted. This reads the Python source
 * (no interpreter needed — it is a table of literals) and compares it with the
 * compiled TypeScript answer, engine by engine, in BOTH directions: an engine in
 * one table and not the other is a failure too.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PY = path.join(REPO, 'python', 'narrator', 'assemble', 'engine_profiles.py');
const TS = path.join(REPO, 'dist', 'shared', 'queue', 'coverage-policy.js');

if (!fs.existsSync(TS)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const { coverageEnforcedFor } = require(TS);
// LINE ENDINGS FIRST: this repo is core.autocrlf=true, so every working file is
// CRLF on Windows, and a pattern written with `\n` matches nothing on a tree
// where nothing has moved. The same trap `narrator-argv-extract.js` records.
const source = fs.readFileSync(PY, 'utf-8').replace(/\r\n/g, '\n');

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
 * `enforced=` out of each `CoveragePolicy(...)` constant, by the name it is
 * bound to. A `dict` of literals parsed by regex rather than by running Python:
 * this keeper has to work on a machine with no narrator environment, which is
 * every machine that only builds the app.
 */
function policiesFromPython(text) {
  const out = {};
  const re = /^([A-Z][A-Z0-9_]*)\s*=\s*CoveragePolicy\(([\s\S]*?)^\)/gm;
  let hit;
  while ((hit = re.exec(text)) !== null) {
    const enforced = /\benforced\s*=\s*(True|False)\b/.exec(hit[2]);
    assert.ok(enforced, `${hit[1]} does not state \`enforced\``);
    out[hit[1]] = enforced[1] === 'True';
  }
  return out;
}

/** `PROFILES`'s engine ids and which policy constant each names. */
function profilesFromPython(text) {
  const block = /^PROFILES: dict\[str, EngineProfile\] = \{([\s\S]*?)^\}/m.exec(text);
  assert.ok(block, 'PROFILES is not a dict literal any more — this keeper reads it as one');
  const out = {};
  const body = block[1];
  // The call spans lines and its arguments contain no parentheses of their own
  // today — but scanning for the BALANCED close is what keeps this reading the
  // right row when one of them grows a `field(default_factory=...)`.
  const re = /"([^"]+)":\s*EngineProfile\(/g;
  let hit;
  while ((hit = re.exec(body)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    assert.strictEqual(depth, 0, `engine ${hit[1]}'s EngineProfile( is never closed`);
    const args = body.slice(re.lastIndex, i - 1);
    const policy = /\bcoverage\s*=\s*([A-Z][A-Z0-9_]*)/.exec(args);
    assert.ok(policy, `engine ${hit[1]} names no coverage policy`);
    out[hit[1]] = policy[1];
  }
  return out;
}

const POLICIES = policiesFromPython(source);
const PROFILES = profilesFromPython(source);

check('the Python table was actually read', () => {
  // A regex that silently matched nothing would make every comparison below
  // vacuously true, which is the one way a mirror test can lie.
  assert.ok(Object.keys(POLICIES).length >= 2,
    `parsed ${Object.keys(POLICIES).length} CoveragePolicy constant(s) from ${PY}`);
  assert.ok(Object.keys(PROFILES).length >= 2,
    `parsed ${Object.keys(PROFILES).length} PROFILES row(s) from ${PY}`);
  assert.ok('orpheus' in PROFILES && 'higgs-v3' in PROFILES,
    `PROFILES parsed as ${Object.keys(PROFILES).join(', ')}`);
});

check('every engine narrator profiles has the same answer in BookForge', () => {
  for (const [engine, policyName] of Object.entries(PROFILES)) {
    const enforced = POLICIES[policyName];
    assert.strictEqual(typeof enforced, 'boolean',
      `${engine} names policy ${policyName}, which was not parsed`);
    assert.strictEqual(coverageEnforcedFor(engine), enforced,
      `narrator says enforced=${enforced} for '${engine}' and shared/queue/coverage-policy.ts `
      + `says ${coverageEnforcedFor(engine)}. A book of that engine would be queued without the `
      + 'Align row and refused at assembly, or aligned for a guard that does not exist.');
  }
});

check("BookForge's own picker spelling maps onto narrator's", () => {
  // 'higgs' is what the engine picker, the run settings and the queue configs
  // carry; 'higgs-v3' is what narrator and the session state call it. Both must
  // reach the same policy, because the two assembly spawns key off DIFFERENT
  // ones (the render door has the picker id, the reassembly door reads the
  // session's).
  assert.strictEqual(coverageEnforcedFor('higgs'), coverageEnforcedFor('higgs-v3'));
  assert.strictEqual(coverageEnforcedFor('orpheus'), false);
  assert.strictEqual(coverageEnforcedFor('higgs'), true);
});

check('an engine BookForge knows and narrator does not is a failure', () => {
  // The other direction. A row added here and not there would have BookForge
  // aligning books for a guard `profile_for` would refuse to describe at all.
  for (const engine of ['orpheus', 'higgs-v3']) {
    assert.ok(engine in PROFILES,
      `shared/queue/coverage-policy.ts knows '${engine}' and narrator's PROFILES does not`);
  }
});

check('an unknown engine is REFUSED, not answered', () => {
  assert.throws(() => coverageEnforcedFor('xtts'),
    /No coverage policy is declared for TTS engine 'xtts'/);
  assert.throws(() => coverageEnforcedFor('higgs-v2'), /No coverage policy is declared/);
});

console.log(failures === 0
  ? '\nThe coverage tables agree.'
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
