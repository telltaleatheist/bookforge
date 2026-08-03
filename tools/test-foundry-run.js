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
 *  - a resumed run does not re-do stages foundry already recorded as done.
 *  - a run directory belongs to ONE page set.
 *  - the run index → DOCUMENT page mapping, which lives only in BookForge's own
 *    record: get it wrong and a whole book's labels land one page out.
 *  - the ocr stage's corrected text is what a block reports, not the raw scan.
 *  - the exclusion file is what the user deleted, and the EPUB lands atomically.
 *  - the OVERRIDES file is what the user retyped and relabelled — the seam that
 *    carries an edited chapter marker into the book — and a category foundry
 *    cannot render is refused here, naming the block, rather than downstream.
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

  console.log('\n3. a resumed run does not redo finished stages');
  {
    const key = 'resume-test';
    reset(key);
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'] });
    await settle(key);

    // foundry now reports scan and ocr done; only blocks should run.
    stageStatus = { scan: 'done', ocr: 'done', blocks: 'pending', footnotes: 'pending' };
    calls = [];
    renderedPages = [];
    run.__resetFoundryRunsForTest();
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'] });
    await settle(key);
    ok('only the unfinished stage ran',
      JSON.stringify(calls) === JSON.stringify(['blocks']), JSON.stringify(calls));
    ok('the pages were not re-rendered', renderedPages.length === 0);
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
    await run.startFoundryRun({ bookKey: key, pdfPath: fakePdf, pages: [0], stages: ['scan', 'ocr', 'blocks'] });
    const state = await settle(key);
    ok('the run stopped instead of resuming', state.status === 'error', JSON.stringify(state));
    ok('nothing was spawned', calls.length === 0, JSON.stringify(calls));
    ok('and the message names the rename',
      /predates the rename/.test(state.message || '')
      && /`boxes`/.test(state.message || '') && /`blocks`/.test(state.message || ''),
      state.message);
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
      ],
    }));
    fs.writeFileSync(path.join(dir, 'ocr', 'lines.json'), JSON.stringify({
      formatVersion: 1,
      lines: [{ id: 'p0001l0000', text: 'Müller said', edits: [{ a: 1 }], rejected: [] }],
    }));
    fs.writeFileSync(path.join(dir, 'blocks', 'blocks.json'), JSON.stringify({
      formatVersion: 1,
      calibration: { convention: 'block', degraded: false, message: 'ok' },
      blocks: [{
        id: 'p0001b000', page: 1, bbox: [200, 400, 600, 440], lineIds: ['p0001l0000'],
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

    console.log('\n7. export: the exclusion file, and an atomic landing');
    const target = path.join(scratch, 'project', 'source', 'exported.epub');
    onStage = async (args) => {
      const outIndex = args.indexOf('-o');
      fs.writeFileSync(args[outIndex + 1], 'EPUBBYTES');
    };
    calls = [];
    argvs = [];
    const exported = await run.foundryExport({
      bookKey: key, excludeBlockIds: ['p0001b000', 'p0000b003', 'p0001b000'],
      excludeCategories: ['footnote'], outputPath: target,
    });
    ok('the EPUB landed where it was asked for',
      exported.epubPath === target && fs.readFileSync(target, 'utf-8') === 'EPUBBYTES');
    ok('no staging leftovers beside it',
      !fs.existsSync(`${target}.bookforge-tmp`));
    const idsFile = path.join(dir, 'export', 'bookforge-exclude-ids.txt');
    const ids = fs.readFileSync(idsFile, 'utf-8').split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    ok('duplicate ids are collapsed',
      JSON.stringify(ids) === JSON.stringify(['p0000b003', 'p0001b000']), JSON.stringify(ids));
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
      excludeBlockIds: ['p0001b001'],
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
        bookKey: key, excludeBlockIds: [], excludeCategories: [],
        overrides: [{ id: 'p0001b000', category: 'table' }], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('a table relabel stops the export and names the block',
      refused !== null && refused.includes('table') && refused.includes('p0001b000'), refused);
    ok('and foundry was never invoked for it', calls.length === 0);

    refused = null;
    try {
      await run.foundryExport({
        bookKey: key, excludeBlockIds: [], excludeCategories: [],
        overrides: [{ id: 'p0001b000' }], outputPath: target,
      });
    } catch (err) { refused = err.message; }
    ok('an override that asks for nothing is refused, not shipped',
      refused !== null && refused.includes('p0001b000'), refused);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  for (const key of ['order-test', 'no-footnotes', 'resume-test', 'pageset-test', 'read-test']) {
    fs.rmSync(run.foundryRunDir(key), { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
