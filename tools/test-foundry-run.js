#!/usr/bin/env node
/**
 * Tests for electron/foundry-run.ts — the main-owned foundry OCR pipeline.
 *
 *   node tools/test-foundry-run.js      (after `npx tsc -p tsconfig.electron.json`)
 *
 * The foundry BINARY and the page renderer are stubbed, so these cost no GPU
 * time and no mupdf — which is the point: they cover the things watching a real
 * run cannot show you.
 *
 *  - the stage ORDER, and specifically that `ocr` runs before `footnotes`.
 *    foundry's export refuses a footnotes artifact derived from a different text
 *    base, so getting this backwards ships raw text where corrected text was
 *    promised — and it does it silently, on the blocks the footnotes stage touched.
 *  - `footnotes` runs only when the user ticked the box.
 *  - a re-submitted pass RE-RUNS its own stages — the done markers in `run.json`
 *    do not skip them, and the artifacts they produced are cleared first — while
 *    the stages it merely reads are left exactly as they are. A pass that quietly
 *    returned this morning's artifacts would look like a fast success and test
 *    the model the user was replacing.
 *  - a run directory belongs to ONE page set.
 *  - the run index → DOCUMENT page mapping, which lives only in BookForge's own
 *    record: get it wrong and a whole book's labels land one page out.
 *  - the ocr stage's corrected text is what a block reports, not the raw scan.
 *  - the exclusion file is what the user deleted, and the EPUB lands atomically.
 *  - the OVERRIDES file is what the user retyped and relabelled — the seam that
 *    carries an edited chapter marker into the book — and a category foundry
 *    cannot render is refused here, naming the block, rather than downstream.
 *  - Detection's three modes, which reach this module as two stage lists: the
 *    difference between labelling a book and re-reading 350 pages first.
 *  - `footnotes` stands on the BLOCKS, not on a repair that never ran — the rule
 *    that lets a born-digital PDF have its markers removed without an ocr stage.
 *  - a FAILED run is swept by `attachOrClearFoundryRun` and reported exactly
 *    once, while `attachFoundryRun` stays a pure read and a cancelled run keeps
 *    its artifacts. A failure that stayed on disk went on answering "there is a
 *    run here" — enough to lock export and to make the picker act as though
 *    foundry output existed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
const bridgePath = require.resolve(path.join(DIST, 'foundry-bridge.js'));
const realBridge = require(bridgePath);

/** Every foundry invocation this run made, in order. */
let calls = [];
/** The FULL argv of each invocation — the export flags are the interesting part. */
let argvs = [];
/** What `run.json` should say about stage status, per test. */
let stageStatus = {};
/**
 * When set, `readRunDirectory` hands back exactly this `stages` object instead
 * of building one from `stageStatus`. The one caller is the pre-rename test,
 * which needs a run.json spelling a stage name this build no longer knows.
 */
let stagesVerbatim = null;
/** Extra work a stubbed stage does — writing artifacts, mostly. */
let onStage = () => {};

require.cache[bridgePath] = {
  id: bridgePath,
  filename: bridgePath,
  loaded: true,
  exports: {
    ...realBridge,
    requireFoundryPath: () => '/stub/foundry',
    // The preflights await this now — a machine with no foundry downloads one
    // rather than refusing. Stubbed to "already have one": these tests are about
    // stage order and artifacts, and a real one would reach out to GitHub.
    ensureFoundryPath: async () => '/stub/foundry',
    runFoundry: async (args) => {
      calls.push(args[0]);
      argvs.push([...args]);
      await onStage(args);
      return { code: 0, stdout: '', stderr: '' };
    },
    readRunDirectory: (dir) => {
      // Only `completedStages` uses this during a run; the reader tests call the
      // real one through a real directory.
      if (stagesVerbatim) return { runDir: dir, run: { stages: stagesVerbatim } };
      if (Object.keys(stageStatus).length === 0) return realBridge.readRunDirectory(dir);
      const stages = {};
      for (const name of ['scan', 'blocks', 'ocr', 'footnotes', 'export']) {
        stages[name] = { status: stageStatus[name] || 'pending' };
      }
      return { runDir: dir, run: { stages } };
    },
  },
};

const proxyPath = require.resolve(path.join(DIST, 'pdf-worker-proxy.js'));
let renderedPages = [];
require.cache[proxyPath] = {
  id: proxyPath, filename: proxyPath, loaded: true,
  exports: {
    async callRenderPagesToPgm(pdfPath, pageNumbers, outDir, dpi) {
      renderedPages.push({ pageNumbers: [...pageNumbers], dpi });
      fs.mkdirSync(outDir, { recursive: true });
      return pageNumbers.map((p) => {
        const file = path.join(outDir, `page-${String(p).padStart(6, '0')}.pgm`);
        fs.writeFileSync(file, 'P5\n1 1\n255\n\0');
        return { page: p, file, width: 1, height: 1 };
      });
    },
  },
};

const llamaPath = require.resolve(path.join(DIST, 'llama-bridge.js'));
require.cache[llamaPath] = {
  id: llamaPath, filename: llamaPath, loaded: true,
  exports: { resolveLlamaServerBinary: () => '/stub/llama-server' },
};

// foundryLlamaServerArgs probes the GPU to decide --gpu-layers. Stubbed as
// "no CUDA" so no test ever spawns nvidia-smi/wsl.exe, and so the stage argv
// these tests assert on stays the same on every machine that runs them.
const probePath = require.resolve(path.join(DIST, 'components', 'system-probe.js'));
require.cache[probePath] = {
  id: probePath, filename: probePath, loaded: true,
  exports: {
    systemProbe: {
      profile: async () => ({
        platform: 'win32', arch: 'x64', appleSilicon: false,
        cuda: { available: false }, ramMB: 32768, freeDiskMB: 1_000_000,
      }),
      evaluate: () => ({ compatible: true, reasons: [] }),
    },
  },
};

const run = require(path.join(DIST, 'foundry-run.js'));

// A throwaway PDF path that exists, because startFoundryRun checks.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-run-test-'));
const fakePdf = path.join(scratch, 'book.pdf');
fs.writeFileSync(fakePdf, '%PDF-1.4\n');

let failures = 0;
function ok(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function settle(bookKey) {
  for (let i = 0; i < 400; i++) {
    const state = run.attachFoundryRun(bookKey);
    if (state && state.status !== 'running') return state;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('run never settled');
}

function reset(bookKey) {
  calls = [];
  argvs = [];
  renderedPages = [];
  stageStatus = { scan: 'pending', blocks: 'pending', ocr: 'pending', footnotes: 'pending' };
  stagesVerbatim = null;
  onStage = () => {};
  run.__resetFoundryRunsForTest();
  fs.rmSync(run.foundryRunDir(bookKey), { recursive: true, force: true });
}

(async () => {
  console.log('1. stage order — ocr runs BEFORE footnotes');
  {
    const key = 'order-test';
    reset(key);
    const state = await run.startFoundryRun({
      bookKey: key, pdfPath: fakePdf, pages: [0, 1],
      stages: ['scan', 'ocr', 'blocks', 'footnotes'],
    });
    await settle(key);
    ok('every stage ran, in the contract order',
      JSON.stringify(calls) === JSON.stringify(['scan', 'ocr', 'blocks', 'footnotes']),
      `got ${JSON.stringify(calls)}`);
    ok('pages were rendered at the pinned 200 dpi',
      renderedPages.length === 1 && renderedPages[0].dpi === 200,
      JSON.stringify(renderedPages));
    ok('the stage count includes footnotes', state.stageCount === 5);
  }

  console.log('\n2. footnotes only when the caller names the stage');
  {
    const key = 'no-footnotes';
    reset(key);
    const state = await run.startFoundryRun({
      bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'],
    });
    await settle(key);
    ok('footnotes was not run', !calls.includes('footnotes'), JSON.stringify(calls));
    ok('the stage count excludes it', state.stageCount === 4);
  }

  console.log('\n3. a re-submitted OCR pass re-runs every stage it owns');
  {
    const key = 'rerun-test';
    reset(key);
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'] });
    await settle(key);

    // foundry now reports every stage done. The pass is submitted again, which
    // is a person asking for it to run — so it runs, all of it.
    stageStatus = { scan: 'done', ocr: 'done', blocks: 'done', footnotes: 'pending' };
    calls = [];
    renderedPages = [];
    run.__resetFoundryRunsForTest();
    await run.startFoundryRun({
      bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'], redo: true,
    });
    await settle(key);
    ok('every stage the pass owns ran again',
      JSON.stringify(calls) === JSON.stringify(['scan', 'ocr', 'blocks']), JSON.stringify(calls));
    ok('and the pages were rasterized again', renderedPages.length === 1,
      JSON.stringify(renderedPages));
  }

  console.log('\n3b. a footnotes pass re-runs ITS stage and leaves the scan alone');
  {
    const key = 'footnotes-refresh-test';
    reset(key);
    const dir = run.foundryRunDir(key);

    // A book that has been scanned, corrected, laid out AND had its footnotes
    // removed once. The artifacts of each stage are on disk.
    stageStatus = { scan: 'done', ocr: 'done', blocks: 'done', footnotes: 'done' };
    for (const stage of ['scan', 'ocr', 'blocks', 'footnotes']) {
      fs.mkdirSync(path.join(dir, stage), { recursive: true });
      fs.writeFileSync(path.join(dir, stage, 'artifact.json'), `{"stage":"${stage}"}`);
    }
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
      formatVersion: 1,
      stages: {
        scan: { status: 'done' }, ocr: { status: 'done' },
        blocks: { status: 'done' }, footnotes: { status: 'done' },
      },
    }, null, 2));

    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['footnotes'] });
    await settle(key);

    ok('the footnotes stage ran, done marker or not',
      JSON.stringify(calls) === JSON.stringify(['footnotes']), JSON.stringify(calls));
    ok('its previous artifact was cleared first',
      !fs.existsSync(path.join(dir, 'footnotes', 'artifact.json')));
    ok('and so was its done marker',
      JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf-8'))
        .stages.footnotes.status === 'pending');
    for (const stage of ['scan', 'ocr', 'blocks']) {
      ok(`the ${stage} artifact it READS was left alone`,
        fs.existsSync(path.join(dir, stage, 'artifact.json')));
    }
    ok('and nothing was re-rendered', renderedPages.length === 0);
  }

  console.log('\n4. a run directory belongs to one page set');
  {
    const key = 'pageset-test';
    reset(key);
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0, 1], stages: ['scan', 'ocr', 'blocks'] });
    await settle(key);
    const marker = path.join(run.foundryRunDir(key), 'marker');
    fs.writeFileSync(marker, 'x');

    calls = [];
    run.__resetFoundryRunsForTest();
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [5, 6, 7], stages: ['scan', 'ocr', 'blocks'] });
    await settle(key);
    ok('a different page set starts a fresh directory', !fs.existsSync(marker));
    ok('and re-runs every stage',
      JSON.stringify(calls) === JSON.stringify(['scan', 'ocr', 'blocks']), JSON.stringify(calls));
  }

  console.log('\n5. a pre-rename run directory is refused, by name');
  {
    // foundry's `boxes` stage became `blocks`, and `boxes/blocks.json` became
    // `blocks/blocks.json`. Neither side keeps a compatibility arm. The failure
    // this guards is the SILENT one: `blocks` missing from the done set reads
    // as "not run yet", so the stage is spawned and the real complaint surfaces
    // minutes later, inside foundry, with the cause two hops away.
    const key = 'rename-test';
    reset(key);
    stagesVerbatim = {
      scan: { status: 'done' }, boxes: { status: 'done' }, ocr: { status: 'done' },
      footnotes: { status: 'pending' }, export: { status: 'pending' },
    };
    // The refusal comes out of `completedStages`, which runs before the run is
    // registered — so it is a THROW to the caller, not a failed run state. Both
    // are "the run stopped and said why"; the assertion is on the message.
    let stopped = null;
    try {
      await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'] });
      stopped = (await settle(key)).message;
    } catch (err) {
      stopped = err.message;
    }
    ok('the run stopped instead of resuming', typeof stopped === 'string' && stopped.length > 0);
    ok('nothing was spawned', calls.length === 0, JSON.stringify(calls));
    ok('and the message names the rename',
      /predates the rename/.test(stopped || '')
      && /`boxes`/.test(stopped || '') && /`blocks`/.test(stopped || ''),
      stopped);
    stagesVerbatim = null;
  }

  console.log('\n6. reading a run: page mapping, points, corrected text');
  {
    const key = 'read-test';
    reset(key);
    stageStatus = {};   // the reader uses the REAL readRunDirectory
    const dir = run.foundryRunDir(key);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'scan'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'ocr'), { recursive: true });

    // The pages submitted were document pages 40 and 41; foundry called them 0 and 1.
    fs.writeFileSync(path.join(dir, 'bookforge-run.json'), JSON.stringify({
      bookKey: key, runDir: dir, pdfPath: fakePdf, pages: [40, 41], status: 'done',
      stage: null, stageIndex: 4, stageCount: 4, message: '', done: 0, total: 0,
      startedAt: 1, updatedAt: 2,
    }));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
      formatVersion: 1, runId: 'r', createdAt: '', foundryVersion: '0',
      input: { path: '', sha256: '', pages: 2 },
      tesseract: { version: '5.5.1', binarySha256: '', tessdata: ['eng'], dpi: 200 },
      models: {}, stages: {},
    }));
    fs.writeFileSync(path.join(dir, 'scan', 'pages.json'), JSON.stringify({
      formatVersion: 1,
      pages: [
        { page: 0, widthPx: 1000, heightPx: 1600, deskewDeg: 0, dpi: 200 },
        { page: 1, widthPx: 1000, heightPx: 1600, deskewDeg: 0.5, dpi: 200 },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'scan', 'lines.json'), JSON.stringify({
      formatVersion: 1,
      lines: [
        { id: 'p0001l0000', page: 1, bbox: [200, 400, 600, 440], text: 'Miiller said', conf: 88 },
        { id: 'p0001l0001', page: 1, bbox: [200, 460, 600, 500], text: 'second line', conf: 90 },
        { id: 'p0001l0002', page: 1, bbox: [200, 520, 600, 560], text: 'third line', conf: 90 },
        { id: 'p0001l0003', page: 1, bbox: [200, 580, 600, 620], text: 'fourth line', conf: 90 },
      ],
    }));
    fs.writeFileSync(path.join(dir, 'ocr', 'lines.json'), JSON.stringify({
      formatVersion: 1,
      lines: [{ id: 'p0001l0000', text: 'Müller said', edits: [{ a: 1 }], rejected: [] }],
    }));
    fs.writeFileSync(path.join(dir, 'blocks', 'blocks.json'), JSON.stringify({
      formatVersion: 2,
      formation: { paraSplit: 'para-split-v1' },
      calibration: { convention: 'block', degraded: false, message: 'ok' },
      blocks: [{
        id: 'p0001b000', page: 1, bbox: [200, 400, 600, 440], lineIds: ['p0001l0000'],
        category: 'body',
        geometry: { firstLineIndent: 0, gapAbove: null, prevLineShort: false, prevEndsWrapHyphen: false },
      }, {
        id: 'p0001b001', page: 1, bbox: [200, 460, 600, 560], lineIds: ['p0001l0001', 'p0001l0002'],
        category: 'body',
        geometry: { firstLineIndent: 0, gapAbove: null, prevLineShort: false, prevEndsWrapHyphen: false },
      }, {
        id: 'p0001b002', page: 1, bbox: [200, 580, 600, 620], lineIds: ['p0001l0003'],
        category: 'body',
        geometry: { firstLineIndent: 0, gapAbove: null, prevLineShort: false, prevEndsWrapHyphen: false },
      }],
    }));

    const result = run.readFoundryRun(key);
    const block = result.blocks[0];
    ok('run page index 1 maps to document page 41', block.page === 41, `got ${block.page}`);
    ok('200-dpi px became points', Math.abs(block.x - 72) < 0.001 && Math.abs(block.width - 144) < 0.001,
      `x=${block.x} width=${block.width}`);
    ok('the block reports the CORRECTED text', block.text === 'Müller said', block.text);
    ok('the id is foundry\'s own', block.id === 'p0001b000');
    ok('confidence is 0..1', Math.abs(block.ocr_confidence - 0.88) < 0.001);
    ok('corrected/refused counts are reported',
      result.corrected === true && result.correctedLines === 1 && result.refusedLines === 0);
    ok('deskew is reported against the DOCUMENT page', result.deskewByPage[41] === 0.5,
      JSON.stringify(result.deskewByPage));

    ok('every block carries its scan lines', JSON.stringify(block.line_ids) === '["p0001l0000"]',
      JSON.stringify(block.line_ids));
    ok('the run names the scan its line ids belong to', result.scanId === 'r', result.scanId);

    console.log('\n7. export: deletions are LINES, and the block ids are derived from them');
    // The bug this is here for: foundry re-mints block ids by position on every
    // blocks run, so a deletion list written before an ocr/blocks re-run names
    // other blocks after it (Kershaw, Aug 3 2026 — `foundry export` refused 28
    // ids that no longer existed). Line ids are minted once, by the scan.
    const target = path.join(scratch, 'project', 'source', 'exported.epub');
    onStage = async (args) => {
      const outIndex = args.indexOf('-o');
      fs.writeFileSync(args[outIndex + 1], 'EPUBBYTES');
    };
    calls = [];
    argvs = [];
    const exported = await run.foundryExport({
      bookKey: key,
      excludeLines: { scanId: 'r', lineIds: ['p0001l0003', 'p0001l0000', 'p0001l0000'] },
      excludeCategories: ['footnote'], outputPath: target,
    });
    ok('the EPUB landed where it was asked for',
      exported.epubPath === target && fs.readFileSync(target, 'utf-8') === 'EPUBBYTES');
    ok('no staging leftovers beside it',
      !fs.existsSync(`${target}.bookforge-tmp`));
    const idsFile = path.join(dir, 'export', 'bookforge-exclude-ids.txt');
    const ids = fs.readFileSync(idsFile, 'utf-8').split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    ok('the derived ids are the blocks those lines fill, deduplicated',
      JSON.stringify(ids) === JSON.stringify(['p0001b000', 'p0001b002']), JSON.stringify(ids));
    const record = JSON.parse(
      fs.readFileSync(path.join(dir, 'export', 'bookforge-deleted-lines.json'), 'utf-8'));
    ok('the run directory keeps the RECORD, not just the derived list',
      record.scanId === 'r'
      && JSON.stringify(record.lineIds) === JSON.stringify(['p0001l0000', 'p0001l0003']),
      JSON.stringify(record));
    ok('export ran once and carried the category exclusion',
      calls.length === 1 && calls[0] === 'export');
    ok('with nothing edited, no overrides file and no --overrides flag',
      !fs.existsSync(path.join(dir, 'export', 'bookforge-overrides.json'))
      && !argvs[0].includes('--overrides'), JSON.stringify(argvs[0]));

    console.log('\n8. export: the overrides file carries what the user changed');
    // The gap this closes: a chapter heading retyped in the picker, and a block
    // the user relabelled, both used to stop at the window. The merged chapter
    // marker is the same mechanism — its swallowed siblings are excluded and the
    // survivor ships the joined line as a text override.
    calls = [];
    argvs = [];
    const withOverrides = await run.foundryExport({
      bookKey: key,
      excludeLines: { scanId: 'r', lineIds: ['p0001l0001', 'p0001l0002'] },
      excludeCategories: [],
      overrides: [
        { id: 'p0001b000', text: 'The Lost Empire' },
        { id: 'p0000b003', category: 'caption' },
        { id: 'p0000b001', text: 'A Promoted Heading', category: 'chapter' },
      ],
      outputPath: target,
    });
    ok('the EPUB still landed', withOverrides.epubPath === target);
    const ovFile = path.join(dir, 'export', 'bookforge-overrides.json');
    ok('--overrides names the file beside the exclusion list',
      argvs[0].includes('--overrides')
      && argvs[0][argvs[0].indexOf('--overrides') + 1] === ovFile,
      JSON.stringify(argvs[0]));
    const ov = JSON.parse(fs.readFileSync(ovFile, 'utf-8'));
    ok('every override reached the file, in id order, verbatim',
      JSON.stringify(ov.blocks) === JSON.stringify([
        { id: 'p0000b001', text: 'A Promoted Heading', category: 'chapter' },
        { id: 'p0000b003', category: 'caption' },
        { id: 'p0001b000', text: 'The Lost Empire' },
      ]), JSON.stringify(ov.blocks));
    ok('the file says who wrote it and when',
      typeof ov._comment === 'string' && ov._comment.includes('pdf-picker')
      && typeof ov._written === 'string');

    console.log('\n9. export: an override foundry cannot render is refused HERE');
    // `table` is BookForge's fourteenth class; foundry has thirteen and no rule
    // for it. Refused at this boundary so the message names the block instead of
    // arriving as a CLI exit code.
    calls = [];
    let refused = null;
    try {
      await run.foundryExport({
        bookKey: key, excludeLines: { scanId: 'r', lineIds: [] }, excludeCategories: [],
        overrides: [{ id: 'p0001b000', category: 'table' }], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('a table relabel stops the export and names the block',
      refused !== null && refused.includes('table') && refused.includes('p0001b000'), refused);
    ok('and foundry was never invoked for it', calls.length === 0);

    refused = null;
    try {
      await run.foundryExport({
        bookKey: key, excludeLines: { scanId: 'r', lineIds: [] }, excludeCategories: [],
        overrides: [{ id: 'p0001b000' }], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('an override that asks for nothing is refused, not shipped',
      refused !== null && refused.includes('p0001b000'), refused);

    console.log('\n10. export: a deletion that cannot be re-derived stops the book');
    // Three ways the record can fail to name blocks, and none of them may pick
    // a block anyway: the wrong block dropped is a book missing pages nobody
    // deleted, and it looks exactly like a successful export.
    calls = [];
    refused = null;
    try {
      await run.foundryExport({
        bookKey: key,
        excludeLines: { scanId: 'r', lineIds: ['p0001l0001'] },
        excludeCategories: [], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('a block the re-run cut through is named, not guessed at',
      refused !== null && refused.includes('p0001b001') && /page 42/.test(refused), refused);

    refused = null;
    try {
      await run.foundryExport({
        bookKey: key,
        excludeLines: { scanId: 'r', lineIds: ['p0009l0009'] },
        excludeCategories: [], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('a line this run does not have is named',
      refused !== null && refused.includes('p0009l0009'), refused);

    refused = null;
    try {
      await run.foundryExport({
        bookKey: key,
        excludeLines: { scanId: 'an-older-scan', lineIds: ['p0001l0000'] },
        excludeCategories: [], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('deletions stamped with another scan are refused, naming both scans',
      refused !== null && refused.includes('an-older-scan') && refused.includes('scan r'), refused);
    ok('and foundry was never invoked for any of the three', calls.length === 0);
  }

  console.log('\n11. Detection: the plan says where its scan comes from');
  {
    // The three modes of `PassJobConfig.detectionMode` reach foundry-run as two
    // stage lists, and which one this pass got is the difference between labelling
    // a book and re-reading 350 pages first. Asserted here because the stage list
    // is the only place that difference is observable.
    const key = 'detect-scan-here';
    reset(key);
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0, 1], stages: ['scan', 'blocks'] });
    await settle(key);
    ok('scan-here reads the pages, then labels them',
      JSON.stringify(calls) === JSON.stringify(['scan', 'blocks']), JSON.stringify(calls));
    ok('and the pages were rasterized for it', renderedPages.length === 1,
      JSON.stringify(renderedPages));
  }
  {
    const key = 'detect-scan-on-disk';
    reset(key);
    const dir = run.foundryRunDir(key);
    // A book somebody else scanned. The scan is INPUT to this pass, exactly as
    // the book EPUB is input to a simplify pass — it is not re-run, and it is not
    // cleared.
    stageStatus = { scan: 'done', ocr: 'pending', blocks: 'done', footnotes: 'pending' };
    for (const stage of ['scan', 'blocks']) {
      fs.mkdirSync(path.join(dir, stage), { recursive: true });
      fs.writeFileSync(path.join(dir, stage, 'artifact.json'), `{"stage":"${stage}"}`);
    }
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
      formatVersion: 1,
      stages: { scan: { status: 'done' }, blocks: { status: 'done' } },
    }, null, 2));

    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['blocks'] });
    await settle(key);
    ok('blocks-only runs the blocks stage and nothing else',
      JSON.stringify(calls) === JSON.stringify(['blocks']), JSON.stringify(calls));
    ok('the scan it READS was left alone',
      fs.existsSync(path.join(dir, 'scan', 'artifact.json')));
    ok('its own previous labels were cleared first',
      !fs.existsSync(path.join(dir, 'blocks', 'artifact.json')));
    ok('and nothing was re-rendered', renderedPages.length === 0);
  }
  {
    // The mode the planner would never emit, arriving anyway (a queue.json row
    // whose scan was deleted underneath it). Refused by name rather than run
    // against artifacts that are not there.
    const key = 'detect-no-scan';
    reset(key);
    let stopped = null;
    try {
      await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['blocks'] });
      stopped = (await settle(key)).message;
    } catch (err) { stopped = err.message; }
    ok('blocks with no scan anywhere is refused',
      /blocks stage reads what scan produced/.test(stopped || ''), stopped);
    ok('and nothing was spawned', calls.length === 0, JSON.stringify(calls));
  }

  console.log('\n12. footnotes stands on the BLOCKS, not on a repair that never ran');
  {
    // foundry's footnotes stage reads blocks/blocks.json and judges block text;
    // it takes the ocr artifact only when one is there. Requiring `ocr` used to
    // stop a born-digital book — nothing to repair — from having its markers
    // removed at all.
    const key = 'footnotes-no-ocr';
    reset(key);
    const dir = run.foundryRunDir(key);
    stageStatus = { scan: 'done', ocr: 'pending', blocks: 'done', footnotes: 'pending' };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
      formatVersion: 1,
      stages: { scan: { status: 'done' }, blocks: { status: 'done' } },
    }, null, 2));

    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['footnotes'] });
    const state = await settle(key);
    ok('it ran, with no ocr stage on disk',
      JSON.stringify(calls) === JSON.stringify(['footnotes']),
      `${JSON.stringify(calls)} — ${state.message}`);
  }
  {
    const key = 'footnotes-no-blocks';
    reset(key);
    let stopped = null;
    try {
      await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['footnotes'] });
      stopped = (await settle(key)).message;
    } catch (err) { stopped = err.message; }
    ok('but not without the blocks, and the refusal names the Detection pass',
      /footnotes stage reads what blocks produced/.test(stopped || '')
      && /Detection/.test(stopped || ''), stopped);
    ok('and nothing was spawned', calls.length === 0, JSON.stringify(calls));
  }

  console.log('\n13. a Detection job that does not say where its scan comes from');
  {
    // The executor's own refusal, mirroring `footnotesMode`. A job persisted in
    // queue.json before the split carries no `detectionMode`, and inferring one
    // from the disk is how a pass silently re-reads a whole book.
    const passes = require(path.join(DIST, 'processing-passes.js'));
    const result = await passes.runProcessingPass(
      'stale-job',
      { kind: 'detection', projectDir: scratch, stageRelDir: 'stages/01-detection' },
      null
    );
    ok('the job fails instead of guessing', result.success === false);
    ok('and the message names the field and the fix',
      /detectionMode/.test(result.error || '') && /Process tab/.test(result.error || ''),
      result.error);
  }

  console.log('\n14. a failed run is swept by the attach that reports it — once');
  {
    // The two attaches are deliberately different functions. Every main-process
    // caller but the picker's IPC handler READS: the passes take a previous
    // run's `pages` out of it and processing-reset uses it as a guard, so a
    // destructive attach would demolish the callers that depend on it.
    const persistFailed = (key, stage, message) => {
      const dir = run.foundryRunDir(key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'artifact-that-should-go'), 'x');
      fs.writeFileSync(path.join(dir, 'bookforge-run.json'), JSON.stringify({
        bookKey: key, runDir: dir, pdfPath: fakePdf, pages: [0, 1], status: 'error',
        stage, stageIndex: 2, stageCount: 4, message, error: message,
        done: 0, total: 0, startedAt: 1, updatedAt: 2,
      }));
      return dir;
    };

    const key = 'errored-persisted';
    reset(key);
    const dir = persistFailed(key, 'ocr', 'llama-server exited with code 1');

    const read = run.attachFoundryRun(key);
    ok('attachFoundryRun still hands back the failure and deletes nothing',
      read !== null && read.status === 'error' && fs.existsSync(dir),
      JSON.stringify(read));

    const first = run.attachOrClearFoundryRun(key);
    ok('attachOrClearFoundryRun answers "nothing here"', first.state === null,
      JSON.stringify(first.state));
    ok('and names the stage and foundry\'s own words',
      first.cleared && first.cleared.stage === 'ocr'
      && first.cleared.message === 'llama-server exited with code 1',
      JSON.stringify(first.cleared));
    ok('the run directory is gone', !fs.existsSync(dir));

    const second = run.attachOrClearFoundryRun(key);
    ok('a second attach reports an empty book, not the same failure again',
      second.state === null && second.cleared === undefined, JSON.stringify(second));
  }
  {
    // The in-memory half. Without `runs.delete` the entry outlives the swept
    // directory and every later attach re-announces a failure the user has
    // already been told about — "cleared" firing forever instead of once.
    const key = 'errored-in-memory';
    reset(key);
    onStage = async (args) => {
      if (args[0] === 'ocr') throw new Error('the ocr stage fell over');
    };
    await run.startFoundryRun({
      bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'],
    });
    const failed = await settle(key);
    ok('the run is registered as failed', failed.status === 'error', JSON.stringify(failed));

    const swept = run.attachOrClearFoundryRun(key);
    ok('the live entry is swept too, with foundry\'s message',
      swept.state === null && !!swept.cleared
      && /the ocr stage fell over/.test(swept.cleared.message),
      JSON.stringify(swept));
    ok('and nothing is left in memory to re-announce',
      run.attachFoundryRun(key) === null);
    ok('nor on disk', !fs.existsSync(run.foundryRunDir(key)));
  }
  {
    // Cancelling must not also destroy. A cancelled run's artifacts are real and
    // are what the OCR modal's stale-run affordance offers to stand on; resuming
    // costs GB of model load and is the user's decision, not a side effect of
    // opening the book.
    const key = 'cancelled-survives';
    reset(key);
    const dir = run.foundryRunDir(key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifact-worth-keeping'), 'x');
    fs.writeFileSync(path.join(dir, 'bookforge-run.json'), JSON.stringify({
      bookKey: key, runDir: dir, pdfPath: fakePdf, pages: [0, 1], status: 'cancelled',
      stage: 'ocr', stageIndex: 2, stageCount: 4, message: 'Cancelled.',
      done: 0, total: 0, startedAt: 1, updatedAt: 2,
    }));

    const attached = run.attachOrClearFoundryRun(key);
    ok('a cancelled run is handed over, not swept',
      attached.state !== null && attached.state.status === 'cancelled'
      && attached.cleared === undefined, JSON.stringify(attached));
    ok('and its artifacts are still there',
      fs.existsSync(path.join(dir, 'artifact-worth-keeping')));
  }
  {
    // A `running` record with no worker behind it means the app died mid-run.
    // The demotion to `cancelled` speaks FIRST, and a demoted run is kept — the
    // sweep is only ever for a run that said, in its own record, that it failed.
    const key = 'dead-running-demotes';
    reset(key);
    const dir = run.foundryRunDir(key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bookforge-run.json'), JSON.stringify({
      bookKey: key, runDir: dir, pdfPath: fakePdf, pages: [0], status: 'running',
      stage: 'ocr', stageIndex: 2, stageCount: 4, message: 'ocr: 10/100',
      done: 10, total: 100, startedAt: 1, updatedAt: 2,
    }));

    const attached = run.attachOrClearFoundryRun(key);
    ok('it comes back cancelled and not live',
      attached.state !== null && attached.state.status === 'cancelled'
      && attached.state.live === false, JSON.stringify(attached.state));
    ok('and it was not swept', attached.cleared === undefined && fs.existsSync(dir));
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  for (const key of [
    'order-test', 'no-footnotes', 'resume-test', 'pageset-test', 'read-test',
    'detect-scan-here', 'detect-scan-on-disk', 'detect-no-scan',
    'footnotes-no-ocr', 'footnotes-no-blocks',
    'errored-persisted', 'errored-in-memory', 'cancelled-survives', 'dead-running-demotes',
  ]) {
    fs.rmSync(run.foundryRunDir(key), { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
