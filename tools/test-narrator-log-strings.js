#!/usr/bin/env node
/**
 * THE WATCHDOG READS NARRATOR'S STDOUT. This is what keeps them in step.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-log-strings.js
 *
 * ── Why this is a keeper and not a comment ──────────────────────────────────
 *
 * `parallel-tts-bridge.ts` watches a render worker by reading printed lines.
 * Four matchers decide what the user is told and, in one case, whether the worker
 * is killed:
 *
 *   PROGRESS_LINE_RE        the render bar, and the watchdog's CLOCK
 *   GENERATION_ACTIVITY_RE  "still working" during a long batch flush
 *   MODEL_LOAD_START/DONE   the load bar
 *   REPAIR_START_RE         the "repairing sentence N" note
 *
 * Every one of them fails SILENTLY and in the wrong direction. A progress line
 * that stops matching does not raise anything: `lastProgressAt` freezes, and 12
 * minutes later WORKER_PROGRESS_TIMEOUT_MS terminates a worker that was rendering
 * perfectly — after up to two more retries that do the same thing. A repair line
 * that stops matching shows no repair. An activity line that stops matching
 * removes the only protection a multi-minute flush has.
 *
 * Nothing on either side would notice: narrator's tests assert what NARRATOR
 * prints, BookForge's regexes assert nothing at all, and the two repos are
 * separate. So this file holds narrator's real emitted lines — VERIFIED against
 * narrator's own source on every run, so a rename there fails here rather than in
 * production — and pushes them through BookForge's compiled matchers.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not assert that a matcher is "correct". It pins the CURRENT truth,
 * including one asymmetry that is real and surprising (the vLLM audio-token-cap
 * line does not trip REPAIR_START_RE, only GENERATION_ACTIVITY_RE — see below).
 * Pinning it is the point: if somebody changes it, that should be a decision.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BRIDGE = path.join(REPO, 'electron', 'parallel-tts-bridge.ts');
const PY = path.join(REPO, 'python', 'narrator');

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

// ─────────────────────────────────────────────────────────────────────────────
// The matchers, read out of the bridge's SOURCE
// ─────────────────────────────────────────────────────────────────────────────
//
// Not imported: `parallel-tts-bridge.ts` pulls in Electron, the GPU arbiter, the
// manifest service and a dozen more, and none of that is needed to test a regex.
// Reading the literal keeps the test honest anyway — it fails if the constant is
// renamed, which importing would too, and it fails if the regex is edited, which
// is the actual subject.
const bridgeSrc = fs.readFileSync(BRIDGE, 'utf-8');

function regexConst(name) {
  const m = bridgeSrc.match(new RegExp(`^const ${name} = (/.*/[a-z]*);$`, 'm'));
  assert.ok(m, `${name} is not declared as a single-line regex constant in parallel-tts-bridge.ts`);
  const body = m[1].slice(1, m[1].lastIndexOf('/'));
  const flags = m[1].slice(m[1].lastIndexOf('/') + 1);
  return new RegExp(body, flags);
}

const PROGRESS_LINE_RE = regexConst('PROGRESS_LINE_RE');
const GENERATION_ACTIVITY_RE = regexConst('GENERATION_ACTIVITY_RE');
const MODEL_LOAD_START_RE = regexConst('MODEL_LOAD_START_RE');
const MODEL_LOAD_DONE_RE = regexConst('MODEL_LOAD_DONE_RE');
const REPAIR_START_RE = regexConst('REPAIR_START_RE');

// ─────────────────────────────────────────────────────────────────────────────
// The lines narrator really prints
// ─────────────────────────────────────────────────────────────────────────────
//
// `emits` is the line as it reaches stdout, with the f-string holes filled.
// `source` is the file that prints it and `fragment` a literal substring of that
// print statement — checked to still be there, so a reword in narrator fails HERE
// instead of turning a watchdog off in production.
const LINES = [
  {
    what: 'the render progress line',
    emits: 'Converting sentence 996/3954 (25.2%)',
    source: 'render/worker.py',
    fragment: 'Converting sentence ',
    match: [PROGRESS_LINE_RE],
    noMatch: [REPAIR_START_RE, MODEL_LOAD_START_RE, MODEL_LOAD_DONE_RE],
  },
  {
    what: 'the model-load start line',
    emits: "Loading Orpheus TTS with voice 'deathstalker'...",
    source: 'engine/orpheus/engine.py',
    fragment: "Loading Orpheus TTS with voice ",
    match: [MODEL_LOAD_START_RE],
    noMatch: [MODEL_LOAD_DONE_RE, PROGRESS_LINE_RE, REPAIR_START_RE],
  },
  {
    what: 'the model-load done line',
    emits: 'Orpheus TTS Loaded!',
    source: 'engine/orpheus/engine.py',
    fragment: "print('Orpheus TTS Loaded!')",
    match: [MODEL_LOAD_DONE_RE],
    noMatch: [MODEL_LOAD_START_RE, PROGRESS_LINE_RE, REPAIR_START_RE],
  },
  {
    what: 'the vLLM audio-token-cap runaway',
    emits: 'Orpheus: sentence 812 hit the audio-token cap; re-rendering split at sentence boundaries',
    source: 'engine/orpheus/vllm_backend.py',
    fragment: 'hit the audio-token cap; re-rendering split at sentence boundaries',
    match: [GENERATION_ACTIVITY_RE],
    // NOT REPAIR_START_RE, and this is the asymmetry worth knowing about: that
    // matcher requires "hit the MLX audio-token cap", with the MLX. So on vLLM a
    // cap-hit refreshes the watchdog but never raises the "repairing sentence N"
    // detail — only the MLX backend does. Inherited from e2a unchanged; pinned
    // here so that changing it is a decision rather than an accident.
    noMatch: [REPAIR_START_RE, PROGRESS_LINE_RE],
  },
  {
    what: 'the MLX audio-token-cap runaway',
    emits: 'Orpheus: sentence 812 hit the MLX audio-token cap; re-rendering split at sentence boundaries',
    source: 'engine/orpheus/mlx_backend.py',
    fragment: 'hit the MLX audio-token cap; re-rendering split at sentence boundaries',
    match: [GENERATION_ACTIVITY_RE, REPAIR_START_RE],
    noMatch: [PROGRESS_LINE_RE],
  },
  {
    what: 'the empty-audio guard',
    emits: 'Orpheus: sentence 41 produced no audio - re-rendering split at sentence boundaries',
    source: 'engine/orpheus/guards.py',
    fragment: 'produced no audio - re-rendering split at sentence boundaries',
    match: [GENERATION_ACTIVITY_RE, REPAIR_START_RE],
    noMatch: [PROGRESS_LINE_RE],
  },
  {
    what: 'the truncation guard',
    emits: 'Orpheus: sentence 41 audio too short for text (28.4 ch/s > 19.0) - re-rendering split at sentence boundaries',
    source: 'engine/orpheus/guards.py',
    fragment: 'audio too short for text ',
    match: [GENERATION_ACTIVITY_RE, REPAIR_START_RE],
    noMatch: [PROGRESS_LINE_RE],
  },
  {
    what: 'the MLX batch heartbeat',
    emits: '[ORPHEUS] MLX batch generating: 95 rows, ~1259 tokens (step 1260/3400), 12/95 rows done, batch 1/2 live 72',
    source: 'engine/orpheus/mlx_backend.py',
    fragment: '[ORPHEUS] MLX batch generating: ',
    match: [GENERATION_ACTIVITY_RE],
    noMatch: [REPAIR_START_RE, PROGRESS_LINE_RE],
  },
];

console.log('narrator still prints what the bridge is watching for');
for (const row of LINES) {
  check(`${row.what}: narrator's source still contains it`, () => {
    const file = path.join(PY, row.source);
    assert.ok(fs.existsSync(file), `${row.source} does not exist — narrator moved it`);
    const src = fs.readFileSync(file, 'utf-8');
    assert.ok(src.includes(row.fragment),
      `${row.source} no longer contains ${JSON.stringify(row.fragment)}.\n`
      + 'The bridge watches for it. Changing the string on narrator\'s side without '
      + 'changing the matcher here turns a watchdog off silently.');
  });
}

console.log('the bridge matches it');
for (const row of LINES) {
  check(`${row.what}: matches what it must`, () => {
    for (const re of row.match) {
      assert.ok(re.test(row.emits),
        `${re} did NOT match:\n  ${row.emits}`);
    }
  });
  check(`${row.what}: matches nothing it must not`, () => {
    for (const re of row.noMatch) {
      assert.ok(!re.test(row.emits),
        `${re} matched a line it must not:\n  ${row.emits}`);
    }
  });
}

console.log('the progress line is read off the right capture groups');
check('groups are (index, total, percent) — not the retired e2a order', () => {
  // e2a had a second, OLDER shape tried FIRST: `Converting sentence 49 - 0.53%:
  // 49/9248`, whose groups are (index, percent, done, total). A line matching the
  // wrong alternative is not a miss — it is four fields read off the wrong
  // positions and a progress bar that lies. narrator emits only this shape and
  // asserts it emits nothing matching the other (render/PORT_NOTES.md s6); the
  // bridge no longer carries the alternative at all.
  const m = 'Converting sentence 996/3954 (25.2%)'.match(PROGRESS_LINE_RE);
  assert.ok(m);
  assert.strictEqual(m[1], '996', 'group 1 is not the sentence index');
  assert.strictEqual(m[2], '3954', 'group 2 is not the total');
  assert.strictEqual(m[3], '25.2', 'group 3 is not the percentage');
});
check('the retired e2a progress shape is gone from the bridge', () => {
  assert.ok(!/Converting sentence \(\\d\+\) - /.test(bridgeSrc),
    'the older `Converting sentence N - P%: N/M` matcher is back in the bridge');
});

console.log('the guard-event prefix is exact on both sides');
check('[ORPHEUS][ORPHEUS_GUARD_EVENT] is a literal both repos agree on', () => {
  const PREFIX = '[ORPHEUS][ORPHEUS_GUARD_EVENT]';
  assert.ok(bridgeSrc.includes(PREFIX), 'the bridge no longer slices on the guard prefix');
  const guards = fs.readFileSync(path.join(PY, 'engine/orpheus/guards.py'), 'utf-8');
  assert.ok(guards.includes('ORPHEUS_GUARD_EVENT'),
    'narrator no longer tags guard events — the bridge indexes rejects by this line');
});

console.log("the worker's own bookkeeping does not falsely trip anything");
for (const line of [
  '[WORKER] skipped 10 already-rendered sentences (0..9)',
  '[WORKER] Take 2: sampling temperature = 0.7',
  '[MEMORY] After first sentence TTS',
  'Loading safetensors checkpoint shards: 100%',
]) {
  check(`no false repair/progress from: ${line.slice(0, 48)}`, () => {
    assert.ok(!REPAIR_START_RE.test(line), 'REPAIR_START_RE fired on worker bookkeeping');
    assert.ok(!PROGRESS_LINE_RE.test(line), 'PROGRESS_LINE_RE fired on worker bookkeeping');
  });
}

console.log(failures === 0 ? '\nAll narrator log-string checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
