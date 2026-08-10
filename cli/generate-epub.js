/**
 * generate-epub.js — a project's PDF read into its book, headlessly, through
 * BookForge's REAL conversion.
 *
 * This is `Convert to EPUB` from Studio's Versions page with no window in front
 * of it. It reimplements NOTHING: it calls `runVlmConversion` (electron/vlm-convert.ts),
 * which is the same function `ipcMain.handle('vlm:convert')` calls, so one call
 * gets the whole of it — the route resolution (a configured server, MLX on Apple
 * silicon, or this machine's GPU through WSL), the readings bank and its foundry
 * ≥0.9.0 gate, `foundry vlm-convert` itself, the staged EPUB moved onto
 * `source/<archive basename>.generated.epub`, `registerGeneratedEpub`,
 * `mintWorkingCopyFrom` and the `vlm-convert` provenance record. A conversion run
 * from here is indistinguishable, afterwards, from one run from the app.
 *
 * Which is the point: 48 PDF-only projects converted through the app's own code
 * path is 48 chances to catch a bug in it.
 *
 *   node --require ./cli/electron-stub.js cli/generate-epub.js \
 *        --project "E:\…\projects\Some Book" [--readings fresh|reuse]
 *        [--destination replace|new-copy] [--variant-id <id>] [--source-pdf <file.pdf>]
 *        [--skip-deleted-pages] [--vlm-endpoint URL] [--vlm-endpoint-model NAME]
 *        [--vlm-concurrency N] [--dry-run]
 *
 * ── Progress ────────────────────────────────────────────────────────────────
 *
 * The conversion is a document STAGE, and a stage announces itself to every
 * window rather than returning progress to its caller. So this file BECOMES a
 * window: it puts a printing pseudo-window into the electron shim's window list,
 * and `broadcastToAllWindows` finds it. The lines printed are foundry's own,
 * verbatim, exactly as the modal shows them.
 *
 * ── --dry-run ───────────────────────────────────────────────────────────────
 *
 * Everything the run decides before it spawns anything — `planVlmConversion`,
 * which the run itself calls first and uses exclusively — reported and then
 * stopped. It proves the project resolves, the PDF is there, the route exists,
 * the book's name is derived, and the bank's decision is made, without asking
 * for a GPU. It is the plan, not a description of one.
 *
 * No fallbacks: every refusal here is the app's own sentence, thrown by the same
 * module the app throws it from.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { electronStub } = require('./electron-stub.js');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

/**
 * Become a window, so the stage's broadcasts have somewhere to land.
 *
 * `withProjectStage` sends `document:stage-started`, every `-progress` line and
 * `-finished` to `BrowserWindow.getAllWindows()`. The shim answers that with an
 * empty list, which is correct for every other CLI path and would make this one
 * silent for ninety minutes. One printing window is the whole fix, and it means
 * the lines shown here are the lines the app shows — not a second rendering of
 * foundry's stderr.
 */
function attachProgressWindow() {
  let last = '';
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => {
        if (channel === 'document:stage-started') {
          console.log(`[epub] stage started: ${payload.stage}`);
          return;
        }
        if (channel === 'document:stage-finished') {
          console.log(`[epub] stage finished: ${payload.stage}`);
          return;
        }
        if (channel !== 'document:stage-progress') return;
        // `render` is the rasterising pass, present only on the two-pass
        // (endpoint) route. Shown as its own count because that is what it is.
        const counted = payload.total > 0 ? `${payload.done}/${payload.total} ` : '';
        const rendering = payload.render
          ? `(rendered ${payload.render.done}/${payload.render.total}) `
          : '';
        const line = `[epub] ${counted}${rendering}${payload.message || ''}`.trimEnd();
        if (line === last) return;
        last = line;
        console.log(line);
      },
    },
  };
  electronStub.BrowserWindow.getAllWindows = () => [win];
}

/**
 * Tell manifest-service which library this project is in.
 *
 * In the app main sets this from the persisted library root at startup, and
 * every `getManifest(projectId)` resolves `{library}/projects/{projectId}/`
 * through it. Nothing sets it in a bare node process, so it would answer
 * `~/Documents/BookForge` and report a project of that name as missing — while
 * the conversion was pointed at a project on E:.
 *
 * Derived from the project's OWN location rather than read from a setting: a
 * project lives at `{library}/projects/{slug}`, so two levels up IS the library
 * this project is in, and it cannot disagree with wherever the app has its root
 * pointed for a project that is actually there. Then it is PROVEN — the path
 * manifest-service would resolve for this projectId must be this project's own
 * manifest — because every silent version of getting this wrong ends with the
 * conversion reading one project's manifest and writing another's files.
 */
function setLibraryRootFor(projectDir) {
  const manifestService = require('../dist/electron/manifest-service.js');
  const manifestPath = path.join(projectDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${projectDir} is not a BookForge project — there is no manifest.json in it.`);
  }
  const projectId = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).projectId;
  if (!projectId) {
    throw new Error(
      `${manifestPath} has no projectId, so nothing can say which project this is. Every v2 `
      + 'manifest carries one; a project without it is damaged.'
    );
  }

  const libraryRoot = path.dirname(path.dirname(projectDir));
  manifestService.setLibraryBasePath(libraryRoot);

  // Compared with the app's own comparator, which is what every other surface
  // uses to decide whether two spellings are one file.
  const { samePath } = require('../dist/shared/document/same-path.js');
  const resolved = manifestService.getManifestPath(projectId);
  if (!samePath(path.resolve(resolved), path.resolve(manifestPath))) {
    throw new Error(
      `This project is at ${projectDir}, but BookForge resolves project "${projectId}" to `
      + `${resolved}. A project has to sit at {library}/projects/{projectId} for the manifest, the `
      + 'covers and the variants to resolve; converting it from where it is would read one '
      + "project's records and write another's files. Nothing was converted."
    );
  }
  return { projectId, libraryRoot };
}

/** The endpoint setting, as the renderer would hand it over. */
function endpointFromArgs(args) {
  const { DEFAULT_VLM_ENDPOINT_CONFIG } = require('../dist/shared/vlm/conversion.js');
  const url = args['vlm-endpoint'];
  const model = args['vlm-endpoint-model'];
  const concurrency = args['vlm-concurrency'];
  if (url === true || model === true || concurrency === true) {
    throw new Error('--vlm-endpoint / --vlm-endpoint-model / --vlm-concurrency each need a value');
  }
  const config = { ...DEFAULT_VLM_ENDPOINT_CONFIG };
  if (url !== undefined) config.url = String(url);
  if (model !== undefined) config.model = String(model);
  if (concurrency !== undefined) {
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`--vlm-concurrency must be a whole number of pages >= 0, got '${concurrency}'`);
    }
    config.concurrency = n;
  }
  return config;
}

function buildRequest(args) {
  if (!args.project || args.project === true) throw new Error('--project <project dir> is required');

  const CHOICES = ['fresh', 'reuse'];
  if (args.readings !== undefined && !CHOICES.includes(args.readings)) {
    throw new Error(
      `--readings must be one of ${CHOICES.join(' | ')}, got '${args.readings}'. `
      + 'fresh archives the banked page answers and reads the whole book again; reuse answers out '
      + 'of the bank (resuming an interrupted run, or rebuilding a finished one).'
    );
  }
  const DESTINATIONS = ['replace', 'new-copy'];
  if (args.destination !== undefined && !DESTINATIONS.includes(args.destination)) {
    throw new Error(
      `--destination must be one of ${DESTINATIONS.join(' | ')}, got '${args.destination}'. `
      + "replace makes the reading this project's book; new-copy adds it beside the archive files "
      + 'the project already has and leaves the book you are editing alone.'
    );
  }
  if (args['variant-id'] === true) throw new Error('--variant-id needs a value');
  if (args['source-pdf'] === true) throw new Error('--source-pdf needs a value');

  return {
    projectDir: path.resolve(args.project),
    ...(args['variant-id'] ? { variantId: String(args['variant-id']) } : {}),
    ...(args['source-pdf'] ? { sourcePath: path.resolve(String(args['source-pdf'])) } : {}),
    ...(args['skip-deleted-pages'] ? { skipDeletedPages: true } : {}),
    ...(args.readings ? { readings: args.readings } : {}),
    ...(args.destination ? { destination: args.destination } : {}),
    endpoint: endpointFromArgs(args),
  };
}

/** What the run would do, in the run's own words. Nothing is spawned. */
async function dryRun(request) {
  const { planVlmConversion } = require('../dist/electron/vlm-convert.js');
  const { vlmRouteLabel } = require('../dist/shared/vlm/conversion.js');
  const { foundryVersion } = require('../dist/electron/foundry-bridge.js');

  const plan = await planVlmConversion(request);
  const foundry = await foundryVersion();

  console.log('[epub] DRY RUN — this is the plan the conversion would run, and nothing else.');
  console.log(`  project            ${plan.project.projectDir}`);
  console.log(`  projectId          ${plan.project.projectId}`);
  console.log(`  source PDF         ${plan.pdfPath}`);
  console.log(`  source (recorded)  ${plan.project.primaryRelPath}`);
  console.log(`  source sha256      ${plan.sha256}`);
  console.log(`  reads the pages    ${vlmRouteLabel(plan.route)} (${plan.route.kind})`);
  console.log(`  language           ${plan.language}`);
  console.log(`  destination        ${plan.destination}`);
  console.log(plan.destination === 'replace'
    ? `  book lands at      ${plan.generatedTarget.absPath}\n`
      + `                     (${plan.generatedTarget.relPath}, then a working copy minted from it)`
    : '  book lands at      a new archive file beside this project\'s existing ones, named as it '
      + 'lands, with a working chain of its own');
  console.log(`  readings bank      ${plan.readingsPath}`);
  console.log(`  banked pages       ${plan.bank.pages}`
    + (plan.bank.totalPages === null ? '' : ` of ${plan.bank.totalPages}`));
  console.log(`  readings choice    ${plan.readingsChoice}`
    + (plan.readingsFlags.length === 0 ? ' (no bank, so no flag)' : ` (${plan.readingsFlags.join(' ')})`));
  console.log(`  readings decision  ${plan.readingsDecision}`);
  console.log(`  skipped pages      ${plan.skippedPages.length === 0 ? 'none' : plan.skippedPages.join(', ')}`);
  console.log(`  foundry            ${foundry.version} at ${foundry.path}`);
  console.log('[epub] Nothing was converted.');
}

async function convert(request) {
  const { runVlmConversion } = require('../dist/electron/vlm-convert.js');
  const { abortStageFor } = require('../dist/electron/document-stage-registry.js');

  // Ctrl-C stops the stage the way the app's Stop button does — `abortStageFor`
  // is what `document:cancel-stage` calls. foundry banks each page as it lands,
  // so this costs the page in flight and nothing else.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (abortStageFor(request.projectDir)) {
      console.log(`\n[epub] ${signal} — stopping the conversion. Every page already read is kept.`);
      return;
    }
    // Nothing has claimed the project yet: the ~44 s model load happens BEFORE the
    // stage is claimed, on purpose (holding a project's stage lock through it would
    // refuse every other stage for a run that has not begun). Said rather than
    // swallowed — and rather than killing this process, which would orphan a vLLM
    // holding the CUDA device inside WSL, the one thing that wedges it.
    stopping = false;
    console.log(
      `\n[epub] ${signal} — nothing to stop yet: the page reader is still starting and no page has `
      + 'been read. Press Ctrl-C again once the first progress line appears.'
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  const started = Date.now();
  const result = await runVlmConversion(request);
  const minutes = ((Date.now() - started) / 60000).toFixed(1);

  const where = result.endpoint === null ? 'this machine' : result.endpoint;
  console.log(`[epub] the book is built: ${result.relPath}`);
  console.log(`[epub]   ${result.totalPages} page(s), ${result.inferredPages} read this run by ${where}, in ${minutes} min`);
  console.log(`[epub]   ${result.epubPath}`);
  if (result.skippedPages.length > 0) {
    console.log(`[epub]   ${result.skippedPages.length} page(s) left out because the working copy `
      + `marks them deleted: ${result.skippedPages.join(', ')}`);
  }
  // A page the model could not read is a page of the user's book that is not in
  // it — said here for the same reason the app puts it in the dialog.
  if (result.unreadable.length > 0) {
    console.warn(`[epub]   WARNING: ${result.unreadable.length} page(s) could NOT be read and are missing:`);
    for (const p of result.unreadable) console.warn(`[epub]     page ${p.page}: ${p.reason}`);
  }
  if (result.newCopy) {
    console.log(result.newCopy.refusal === null
      ? `[epub]   it has a working chain of its own (${result.newCopy.familyId})`
      : `[epub]   WARNING: it could NOT be given a working chain: ${result.newCopy.refusal}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const request = buildRequest(args);
  const { libraryRoot } = setLibraryRootFor(request.projectDir);
  console.log(`[epub] library: ${libraryRoot}`);
  attachProgressWindow();

  if (args['dry-run']) {
    await dryRun(request);
  } else {
    await convert(request);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n[epub] ERROR: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
