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
  // The only throw on the result is the run-did-not-happen one.
  const throws = source.match(/throw new Error\(result\.error/g) || [];
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

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} CHECK(S) FAILING`);
process.exitCode = failures === 0 ? 0 : 1;
