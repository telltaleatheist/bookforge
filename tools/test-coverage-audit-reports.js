#!/usr/bin/env node
/**
 * THE COVERAGE AUDIT REPORTS. IT DOES NOT BLOCK.
 *
 *   npm run build:electron && node tools/test-coverage-audit-reports.js
 *
 * (`npm run build:electron` rather than a bare `tsc`: it loads the compiled
 * `coverage-align-job`, whose import chain reaches `rvc-models`, which reads
 * `dist/electron/data/` — a file the build copies and the compiler does not.)
 *
 * ── The bug this keeps out ──────────────────────────────────────────────────
 *
 * On 2026-09-05 a real Higgs v3 book — "Working Towards the Fuhrer", 50 chunks,
 * 36 minutes of good audio — could not be assembled at all. Three separate
 * places refused it: `narrator align` stopped at the first chunk it could not
 * place and wrote nothing; the Align queue row failed on a non-zero exit, so the
 * reassembly behind it was skipped; and `coverage_gate` refused the assembly for
 * an engine whose policy was "enforced".
 *
 * Owen's ruling, the same day:
 *
 *     there will always be truncations or errors of some sort. thats the nature
 *     of tts. nothing is going to come out perfect. we try our best to detect
 *     and reduce the number of errors but assembly will never function, ever, if
 *     we expect it to come out the other side flawless. we need to base assembly
 *     on the expected text and the actual real length of the audio.
 *
 * So the audit reports and the book is assembled. Every assertion below is one
 * of the three refusals, asserted gone — and the counts asserted present, because
 * "does not block" is only half of it: the operator has to be TOLD.
 *
 * The Python halves of the same ruling are `narrator/tests/test_align.py`
 * (`report_failures` never raises, an unplaceable chunk is estimated, a missing
 * report still assembles). This is the TypeScript half.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const JOB = path.join(REPO, 'dist', 'electron', 'coverage-align-job.js');

if (!fs.existsSync(JOB) || !fs.existsSync(path.join(REPO, 'dist', 'electron', 'data'))) {
  console.error('Build first: npm run build:electron');
  process.exit(1);
}

// The compiled job imports `electron`; the stub the other CLI adapters use makes
// that resolvable outside an Electron process.
require(path.join(REPO, 'cli', 'electron-stub.js'));
const { summarizeCoverageReport, coverageReportPath } = require(JOB);

const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8').replace(/\r\n/g, '\n');

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

/** A report shaped like the one tonight's audit produced: failures AND errors. */
function writeReport(dir, { failed = [14, 3], errored = [7, 2], aligned = 45 } = {}) {
  const document = {
    version: 1,
    engine: 'higgs-v3',
    audited: true,
    sessionId: 'sid',
    chunksInManifest: 50,
    summary: {
      chunksAligned: aligned,
      chunksSkipped: 0,
      chunksFailed: failed.length,
      failedIndices: failed,
      errors: errored.length,
      errorIndices: errored,
    },
    chunks: failed.map((index) => ({
      index, failed: true, reasons: ['aligned ratio 0.500 is below 0.90'],
      droppedText: [{ words: 9, text: 'the words it never said' }],
    })),
    errors: errored.map((index) => ({ index, stage: 'align', error: 'no alignment' })),
    skipped: [],
  };
  const file = coverageReportPath(dir);
  fs.writeFileSync(file, JSON.stringify(document, null, 2));
  return file;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-coverage-audit-'));

console.log('THE AUDIT REPORTS, AND THE BOOK IS ASSEMBLED\n');

check('a report with failures summarises into one line with the retake list', () => {
  writeReport(tmp);
  const found = summarizeCoverageReport(coverageReportPath(tmp));
  assert.ok(found, 'a report that exists must summarise');
  assert.strictEqual(found.chunksAligned, 45);
  assert.strictEqual(found.chunksFailed, 2);
  assert.strictEqual(found.chunksErrored, 2);
  assert.deepStrictEqual(found.retakeIndices, [2, 3, 7, 14],
    'the retake list is failed ∪ unplaceable, sorted and de-duplicated');
  assert.match(found.line, /45 aligned, 2 failed coverage, 2 could not be placed/);
  assert.match(found.line, /retake: 2,3,7,14/);
});

check('a chunk that is both failed and unplaceable is named once', () => {
  writeReport(tmp, { failed: [9], errored: [9] });
  const found = summarizeCoverageReport(coverageReportPath(tmp));
  assert.deepStrictEqual(found.retakeIndices, [9]);
});

check('a clean report says so and offers no retake list', () => {
  writeReport(tmp, { failed: [], errored: [], aligned: 50 });
  const found = summarizeCoverageReport(coverageReportPath(tmp));
  assert.deepStrictEqual(found.retakeIndices, []);
  assert.ok(!found.line.includes('retake'), found.line);
});

check('no report at all is null, not a throw — an Orpheus book carries none', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-coverage-none-'));
  assert.strictEqual(summarizeCoverageReport(coverageReportPath(empty)), null);
  fs.rmSync(empty, { recursive: true, force: true });
});

check('an unreadable report is null, not a throw', () => {
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-coverage-bad-'));
  fs.writeFileSync(coverageReportPath(broken), '{ this is not json');
  assert.strictEqual(summarizeCoverageReport(coverageReportPath(broken)), null);
  fs.rmSync(broken, { recursive: true, force: true });
});

console.log('\nTHE THREE REFUSALS, ASSERTED GONE\n');

check('the align row fails only when the RUN could not happen', () => {
  const source = read('electron/coverage-align-job.ts');
  assert.ok(!/is not ready to assemble/.test(source),
    'the align job still tells the operator a book is not ready to assemble — '
    + 'assembly assembles whatever was rendered now');
  assert.ok(/A NON-ZERO EXIT IS NOW ONE THING/.test(source),
    'the non-zero-exit branch no longer states that it is one thing (the run did '
    + 'not happen), which is the contract `narrator align` now keeps');
});

check('the align queue step succeeds on a report full of failures', () => {
  const source = read('electron/queue-steps/align.ts');
  /*
   * The only throw on the result is the run-did-not-happen one — and since
   * 2026-09-19 (A5) it is minted by `stepFailure`, which turns that same
   * refusal into a PARK when the server named a holder (`busyLine`) and leaves
   * it an ordinary failure otherwise. One refusal either way; what changed is
   * that the row waits instead of reddening when the card is merely held.
   */
  const throws = (source.match(/throw new Error\(result\.error/g) || [])
    .concat(source.match(/throw stepFailure\(/g) || []);
  assert.strictEqual(throws.length, 1, 'exactly one refusal, and it is !result.success');
  assert.ok(/retakeIndices/.test(source),
    'the row must carry the retake list into its artifact detail');
  assert.ok(/failed \`\n\s*\+ \`coverage/.test(source) || /failed /.test(source),
    'the row must say the counts');
});

check('the align row claims the slot its DEVICE names, and the job resolves the name', () => {
  // Owen, 2026-09-07: "make it an option the user can pick when adding it to the
  // queue. GPU or CPU? defaults to CPU." Two halves, and both are silent if they
  // drift: a row that declared 'cpu' and then ran on the card would align beside
  // a render, and a row that declared 'gpu' and ran on the CPU would have waited
  // for a card it never used.
  const step = read('electron/queue-steps/align.ts');
  assert.ok(/resource:\s*\(config[^)]*\)\s*=>\s*\(config\['device'\] === 'gpu' \? 'gpu' : 'cpu'\)/.test(step),
    "the align step must take its resource from the row's own device");
  const job = read('electron/coverage-align-job.ts');
  assert.ok(/'--device', device/.test(job),
    'the spawn must pass the RESOLVED device, not a hard-coded one');
  assert.ok(/appleSilicon/.test(job) && /cuda\.available/.test(job),
    "'gpu' is resolved to mps or cuda from the machine profile the app already probes");
  assert.ok(/no GPU the aligner can/.test(job),
    'a machine with neither refuses by name rather than aligning on the CPU nobody chose');
});

check('the aligner refuses BOTH gpu device names while a BookForge job owns the card', () => {
  // On the Mac "align on GPU" is `mps` — the same silicon and the same Metal
  // queue the render uses — so a lock that stopped cuda and waved mps through
  // would be a rule that protects the machine nobody is running on.
  const aligner = read('python/narrator/align/aligner.py');
  assert.ok(/GPU_DEVICES = \('cuda', 'mps'\)/.test(aligner),
    'aligner.check_device must treat mps as a GPU device');
  assert.ok(/if device not in GPU_DEVICES/.test(aligner),
    'and gate the lock check on that list rather than on cuda alone');
});

check('both assembly spawns pass the report when the FILE exists, not by engine', () => {
  for (const file of ['electron/reassembly-bridge.ts', 'electron/parallel-tts-bridge.ts']) {
    const source = read(file);
    assert.ok(!/coverageEnforcedFor/.test(source),
      `${file} still keys --coverage_report off the engine; a report that exists `
      + 'should be read out whatever rendered the book');
    assert.ok(/existsSync\(coverageReportPath\(/.test(source),
      `${file} must pass --coverage_report whenever the report file is there`);
  }
});

check('the assembly row repeats the retake list on the finished book', () => {
  assert.ok(/summarizeCoverageReport/.test(read('electron/queue-steps/reassembly.ts')),
    'the reassembly step must repeat the audit once, so an operator sees it on '
    + 'the finished book and not only on a card scrolled past hours ago');
  assert.ok(/Coverage audit/.test(read('electron/reassembly-bridge.ts')),
    'and the bridge must log it, so the CLI door says it too');
});

check('narrator itself no longer refuses a book on coverage', () => {
  const gate = read('python/narrator/assemble/coverage_gate.py');
  assert.ok(!/def refuse_on_failures/.test(gate),
    'coverage_gate still has refuse_on_failures — it is report_failures now');
  assert.ok(/def report_failures/.test(gate));
  // The refusals that remain are integrity ones, and `check` raises none itself.
  const body = gate.slice(gate.indexOf('def check('));
  assert.ok(!/raise CoverageRefusal/.test(body),
    'coverage_gate.check() raises a refusal of its own again');
});

// ── 2026-09-08: the qwen3 cutover ───────────────────────────────────────────
//
// Owen: *"good. go ahead and wire it up to alignment so itll be used to align the
// chunks in app"*, *"for generate-sentences logic and for normal post-render
// alignment"*. Two doors moved onto one backend, and the thing that would go
// wrong silently is a whisperx arm creeping back in behind one of them: the two
// score words on different scales (`Alignment.score_source`), so a book measured
// by the other instrument under the same label reads as a coverage regression
// nobody caused.

check('every app door states --backend qwen3, and none of them resolves a backend', () => {
  const job = read('electron/coverage-align-job.ts');
  assert.ok(/'--backend', 'qwen3'/.test(job),
    'the per-chunk door must STATE the backend: narrator\'s DEFAULT_BACKEND is '
    + 'still whisperx, which is its contract with a caller that names none');
  const bridge = read('electron/whisperx-align-bridge.ts');
  assert.ok(/'--backend', 'qwen3'/.test(bridge),
    'the whole-m4b door must state it too — "for generate-sentences logic AND '
    + 'for normal post-render alignment"');
  for (const [file, source] of [['coverage-align-job.ts', job],
                                ['whisperx-align-bridge.ts', bridge]]) {
    assert.ok(!/backend\s*[=:]\s*['"]whisperx['"]/.test(source),
      `${file} names whisperx as a backend somewhere — there is no fallback arm`);
  }
});

check('the per-chunk door resolves ONE aligner env, and no door gates on it up front', () => {
  const job = read('electron/coverage-align-job.ts');
  assert.ok(/resolveQwenAlignEnv/.test(job),
    'the job must ask qwen-aligner.ts — a second copy of that ladder is a second '
    + 'answer, and the copy is the one that goes stale');
  assert.ok(!/resolveWhisperxEnvRoot/.test(job),
    'the job still reaches for the whisperx env; the align stage does not run there');
  /*
   * THE PLAN-TIME GATE IS GONE (2026-09-19, bug hunt finding B2).
   *
   * `coverageAlignPython()` / `coverageAlignRefusal()` answered "can THIS
   * machine align?" by resolving the local `qwen-align` conda env, and two
   * doors refused up front on it. Both were asking about the wrong machine:
   * `runCoverageAlign` sends the model to a Crucible server and measures the
   * book here in the TOOLS env, which is native everywhere. A Mac — no
   * mlx-darwin block for qwen3-aligner, so `align` is off — was refused an
   * alignment the server it had just rendered on would have done.
   *
   * What survives is the env resolution INSIDE `runCoverageAlignLocally`'s
   * local-spawn arm, which is the arm that actually needs an interpreter.
   */
  const compiled = require(JOB);
  for (const symbol of ['coverageAlignPython', 'coverageAlignRefusal']) {
    assert.strictEqual(compiled[symbol], undefined,
      `the module still exports ${symbol} — the local-env gate in front of the Crucible `
      + 'alignment was removed because it refused machines that could align');
  }
  // Matched on the CALL (`job.…(`), not on the name: the adapter's comment
  // still explains what the gate was and why it went, and a test that fails on
  // its own history teaches people to delete history.
  assert.ok(!/job\.coverageAlign(Refusal|Python)\s*\(/.test(read('cli/coverage-align.js')),
    'the CLI adapter still gates on the local aligner env');
});

check('the alignment is a ROW, not a phase of the render — and the render ends at the render', () => {
  /*
   * THIS CHECK WAS THE OPPOSITE ONE UNTIL 2026-09-19.
   *
   * It pinned `runPostRenderAlignment` as the render's final phase, ordered
   * before `cacheSessionToProject`, and required that it NEVER THROW: no
   * aligner was an announced SKIP and a failure was an announced failure, and
   * the audiobook shipped either way carrying the proportional estimate.
   *
   * Owen ruled the phase out that evening — alignment *"is its own queue
   * step"*, *"as soon as the GPU finishes, it releases the lease"*, and *"if
   * alignment fails it should stop"*. Every property this used to defend was a
   * property of the wrong arrangement: the render row held a GPU slot for ten
   * minutes of model call after the card was idle; the skip arm was a dead
   * LOCAL-env gate in front of work that happens on a server (finding B2); and
   * "ships either way" is how a misconfigured aligner went a month unnoticed.
   *
   * So the defence is inverted, and it is the same discipline: the phase must
   * be GONE from the bridge, and the row must be composed by the run.
   */
  const bridge = read('electron/parallel-tts-bridge.ts');
  const ts = require('typescript');
  const parsed = ts.createSourceFile('parallel-tts-bridge.ts', bridge, ts.ScriptTarget.Latest, true);
  const phaseNode = parsed.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name?.text === 'runPostRenderAlignment');
  assert.ok(!phaseNode,
    'runPostRenderAlignment is back in the bridge — the alignment is the `align` queue row '
    + '(shared/queue/narration-run.ts), and a phase inside the render is what held the GPU slot');
  assert.ok(!/await runPostRenderAlignment\(/.test(bridge),
    'the completion path still awaits a post-render alignment phase');

  // THE CARD IS HANDED BACK BEFORE THE SESSION COPY, which is the half of the
  // old arrangement that WAS right and is measured: 458 s of file copy on
  // Owen's *Letter to the American Church*, every second charged to an idle
  // card. Scoped to the completion path — `cacheSessionToProject` is defined
  // earlier in this file and called by other doors.
  const at = bridge.indexOf('async function checkAllWorkersComplete');
  assert.ok(at > 0, 'checkAllWorkersComplete is the completion path');
  const complete = bridge.slice(at);
  const handoff = complete.indexOf('announceGpuPhaseOver(session');
  const cache = complete.indexOf('await cacheSessionToProject(');
  assert.ok(handoff > 0, 'the render must announce that the card is free');
  assert.ok(cache > 0, 'the copy to the project cache is here');
  assert.ok(handoff < cache,
    'the GPU slot must go back BEFORE the session is copied into the project: the copy is '
    + 'minutes of file IO on a card that has been idle since the last chunk landed');

  assert.ok(!/(await |function )normalizeWslSessionToWindows\s*\(/.test(bridge),
    'the WSL session normaliser is back — there is no guest render to normalise out of. '
    + '(Matched on a CALL or a DEFINITION, not on the name: several comments still explain '
    + 'what it did, and a test that fails on its own history teaches people to delete '
    + 'history.)');

  // AND THE ROW IS COMPOSED. A render whose alignment is nobody's step is a
  // book sealed with the estimate for a different reason.
  const plan = read('shared/queue/narration-run.ts');
  assert.ok(/narrationAlignStep\(/.test(plan) && /steps\.push\(narrationAlignStep\(book, settings\)\)/.test(plan),
    'the narration run must compose an align row behind the render');
});

check('the gate is one constant, in one place, imported by the whole-book door', () => {
  const run = read('python/narrator/align/run.py');
  assert.ok(/^GATE_MAX_SHIFT_S = 2\.0$/m.test(run),
    'narrator/align/run.py owns GATE_MAX_SHIFT_S');
  // The per-chunk gate takes the cues and the chunk index and NOTHING ELSE
  // (2026-09-12): the shift check compared a measurement to the proportional
  // guess and shipped the guess on disagreement — on Mutineer's Moon that put a
  // third of the book's cues 2-4.6 s off. A signature that still took the
  // estimate's inputs (span, text, heading flag) is how it would come back.
  assert.ok(/def gate_refusal\(measured: Sequence, \*, chunk_index: int\) -> Optional\[str\]:/.test(run),
    'gate_refusal(measured, *, chunk_index) — no span, no text, no heading flag');
  for (const stage of ['gate/order', 'gate/collapse']) {
    assert.ok(run.includes(stage), `the gate must name its check: ${stage}`);
  }
  assert.ok(!/gate\/shift/.test(run.replace(/"""[\s\S]*?"""|#[^\n]*/g, '')),
    'the per-chunk gate must not compare a measurement to the proportional '
    + 'estimate (gate/shift may be mentioned in prose, never raised)');
  assert.ok(/stage='gate'/.test(run),
    "a gated chunk must be recorded under stage 'gate' and estimated, exactly "
    + 'like one the aligner could not place');
  const script = read('electron/scripts/align_audiobook.py');
  assert.ok(/from narrator\.align\.run import GATE_MAX_SHIFT_S/.test(script),
    'align_audiobook.py must IMPORT the constant, not restate it — two spellings '
    + 'is how the two doors come to disagree about what "too far" means');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} CHECK(S) FAILING`);
process.exitCode = failures === 0 ? 0 : 1;
