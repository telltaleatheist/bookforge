/**
 * clean-step.js — the hosted Foundry window's **Clean text** press, headless.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/clean-step.js --project "<dir>" --dry-run
 *
 * ── IT IS THE PRESS, not a second way of doing what the press does ──────────
 *
 * "CLI drives the app path": a door that composed its own plan, its own request
 * or its own command line could not catch the app's bugs, which is the whole
 * reason there is a CLI. So every step here is a call into the SAME compiled
 * functions the button walks through, in the same order:
 *
 *   1. `recordHost({libraryDir})` — Foundry is HOSTED, exactly as `mountFoundry`
 *      tells it in main.ts. Without this it would answer for its own standalone
 *      library in ~/Documents and plan against a project that is not the book's.
 *   2. `listProjects()` + `originalOf(project.documents)` — the document the
 *      dialog's `source()` computes for the open tab (`mount.exportEpubFromStep`
 *      resolves a host's project the same way).
 *   3. `positionOf(ledgerOf(await readManifest(dir)))` — the standing step, which
 *      is `LedgerService.standingIn` on this side of the wire, and `canCleanFrom`
 *      is asked about it because the dialog asks it before it offers the button.
 *   4. `planCleanup(inputPath, standing)` — `workspace:plan-clean`'s own call. It
 *      MATERIALISES the position's book, mints the records/stamp paths and the
 *      step id. A dry run makes the plan too: the argv is a fact about a plan, and
 *      a preview of an argv composed without one would be a preview of nothing.
 *   5. The `CleanRequest` composed field for field as `clean-dialog.add()` does.
 *   6. `runJob(request, { parentStep, onProgress, signal })` — the seam
 *      `queue-steps/foundry-job.ts` calls, with `parentStep` resolved the way
 *      `ipc.madeFrom` resolves it (`positionStepId(dir)`), so the row this lands
 *      is filed under the same step the press would file it under.
 *
 * ── THE MODEL IS RELEASED WHEN THE RUN ENDS ─────────────────────────────────
 *
 * Owen, 2026-09-08: *"make sure the cli brings down the model when it finishes
 * using it."* Nothing here has to do that: `foundry clean-text` unloads the
 * weights (`keep_alive: 0`) unless it is told the machine is shared, so the
 * release is what an unasked-for run already does. `--keep-model` is the opt-in
 * for somebody doing several runs back to back, and it is the ONLY thing that
 * puts `--keep-model` on the line.
 *
 * ── WHICH ENGINE ANSWERS, AND WHY IT IS NOT THE INSTALLED ONE ───────────────
 *
 * A CLI run is a DEV run by construction — it runs out of the checkout, against
 * `dist/electron` — so this primes `FOUNDRY_CLI_PATH` at the locally-built binary
 * first, exactly as `main.ts` does under `isDev`, before `resolveFoundryPath()` is
 * asked. Skipping it resolves the INSTALLED component instead, which on this
 * machine is a foundry 1.0.2 with no `--concurrency` and no `--generation`: a
 * command line composed for an engine that cannot run it, discovered an hour into
 * a benchmark. The dry run prints the binary AND `foundry --version`, because a
 * path cannot say which release is sitting at it.
 *
 * ── WHICH BUILD OF FOUNDRY THIS DRIVES ──────────────────────────────────────
 *
 * `foundry-app/dist` — the vendored build the running app executes. `--foundry-dist`
 * points at another one (the foundry checkout's own `dist`, when a change has been
 * made there and not re-vendored yet). A build with no `argsFor` export is refused
 * BY NAME rather than fallen back from: composing the argv here instead would be
 * the parallel implementation this file exists not to be.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BF_DIST = path.join(REPO, 'dist', 'electron');
const VENDORED_FOUNDRY_DIST = path.join(REPO, 'foundry-app', 'dist');

const USAGE = `usage: clean-step.js (--project <BookForge project dir> | --foundry-project <dir>)
                     [--server ollama|vllm] [--model <tag>] [--ollama <url>] [--concurrency <n>]
                     [--keep-model] [--library <root>] [--foundry-dist <dir>] [--dry-run]`;

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

const said = (v) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** The library root, the same file `cli/library.js` reads. */
function resolveLibraryRoot(override) {
  if (said(override)) return path.resolve(said(override));
  const cfgPath = path.join(process.env.BOOKFORGE_USER_DATA || require('./electron-stub.js').USER_DATA,
    'library-root.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`No library root: ${cfgPath} does not exist and --library was not given.`);
  }
  const { libraryRoot } = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!libraryRoot) throw new Error(`${cfgPath} has no "libraryRoot" key.`);
  return libraryRoot;
}

/**
 * The Foundry project a BookForge book claims, joined to a path the one way
 * main.ts joins them: the manifest records a KEY, and `<library>/foundry/projects`
 * is where the keys live. A book with no record has no Foundry project — it is
 * never "the one named after the folder".
 */
async function foundryProjectFor(projectDir, libraryRoot) {
  const manifestService = require(path.join(BF_DIST, 'manifest-service.js'));
  const ref = await manifestService.readFoundryProjectRef(projectDir);
  if (ref === null || !said(ref.dir)) {
    throw new Error(
      `${path.basename(projectDir)} records no Foundry project, so there is no book to clean. `
      + 'Open it in Foundry once from its page in BookForge, so the two are joined, and try again.');
  }
  const dir = path.join(libraryRoot, 'foundry', 'projects', ref.dir);
  if (!fs.existsSync(dir)) {
    throw new Error(`${projectDir} claims Foundry project "${ref.dir}", and ${dir} does not exist.`);
  }
  return dir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectArg = said(args.project);
  const foundryArg = said(args['foundry-project']);
  if (projectArg === null && foundryArg === null) {
    throw new Error(`--project or --foundry-project is required.\n\n${USAGE}`);
  }
  const dryRun = args['dry-run'] === true;

  if (!fs.existsSync(path.join(BF_DIST, 'manifest-service.js'))) {
    throw new Error('BookForge is not built — run `npx tsc -p tsconfig.electron.json` first '
      + '(dist/electron/manifest-service.js missing)');
  }
  const FOUNDRY_DIST = said(args['foundry-dist'])
    ? path.resolve(said(args['foundry-dist']))
    : VENDORED_FOUNDRY_DIST;
  const fdist = (rel) => require(path.join(FOUNDRY_DIST, rel));
  if (!fs.existsSync(path.join(FOUNDRY_DIST, 'electron', 'job-queue.js'))) {
    throw new Error(`No Foundry build at ${FOUNDRY_DIST} — expected electron/job-queue.js under it.`);
  }

  const libraryRoot = resolveLibraryRoot(args.library);
  const foundryProjectDir = foundryArg !== null
    ? path.resolve(foundryArg)
    : await foundryProjectFor(path.resolve(projectArg), libraryRoot);

  /*
   * THE ENGINE, named the way main.ts names it before it mounts — and in main.ts's
   * own ORDER, which is the whole of this paragraph.
   *
   * `primeFoundryDevCliPath()` FIRST (main.ts ~12083, `if (isDev)`), because a CLI
   * run IS a dev run by construction: it runs out of the checkout, against
   * `dist/electron`, with no packaged component tree around it. Without the prime,
   * `resolveFoundryPath()` falls through to the INSTALLED component — on this
   * machine a foundry 1.0.2 from August with no `--concurrency` and no
   * `--generation` — and the door would compose a command line the binary it named
   * cannot run. It honours an already-set `FOUNDRY_CLI_PATH` and says which way it
   * went, which is the point: the one question that matters when a run behaves
   * oddly is WHICH BINARY ANSWERED.
   *
   * Then `resolveFoundryPath()`, whose rule is unchanged and stays two sources
   * (the env var, then the component). Hosted, Foundry refuses its own dev-checkout
   * fallback by design — the checkout three levels up from a vendored file is the
   * HOST's — so `FOUNDRY_BIN` is the host's to set, and an environment that already
   * said something wins exactly as it does there.
   */
  require(path.join(BF_DIST, 'foundry-dev-cli.js')).primeFoundryDevCliPath();
  if (!process.env.FOUNDRY_BIN) {
    const { resolveFoundryPath } = require(path.join(BF_DIST, 'foundry-bridge.js'));
    const bin = resolveFoundryPath();
    if (bin) process.env.FOUNDRY_BIN = bin;
  }

  // Foundry is HOSTED here, and its library is BookForge's — `mountFoundry`'s own
  // first fact. `onExport` is required by the shape; a cleanup lands no export.
  fdist('electron/host.js').recordHost({
    libraryDir: path.join(libraryRoot, 'foundry'),
    onExport: () => {},
  });

  const { listProjects, readManifest, ledgerOf, positionStepId } = fdist('electron/projects.js');
  const { originalOf } = fdist('shared/original.js');
  const { positionOf } = fdist('shared/ledger.js');
  const { canCleanFrom } = fdist('shared/stages.js');
  const { planCleanup } = fdist('electron/workspace.js');
  const jobQueue = fdist('electron/job-queue.js');
  const { readAppSettings } = fdist('electron/app-settings.js');
  if (typeof jobQueue.argsFor !== 'function') {
    throw new Error(
      `The Foundry build at ${FOUNDRY_DIST} does not export \`argsFor\` from electron/job-queue.js, `
      + 'so this door cannot show the command line a run would spawn — and it will not compose one '
      + 'of its own, which would be a second answer to what a request runs. Re-vendor foundry-app '
      + '(or pass --foundry-dist <foundry>/app/dist) and try again.');
  }

  const fold = (p) => path.resolve(p).normalize();
  const project = (await listProjects()).find((row) => fold(row.dir) === fold(foundryProjectDir));
  if (project === undefined) {
    throw new Error(`${foundryProjectDir} is not a project in this library's Foundry folder.`);
  }
  const original = originalOf(project.documents);
  if (original === null) throw new Error(`${foundryProjectDir} holds no document to clean.`);

  const manifest = await readManifest(foundryProjectDir);
  const standing = positionOf(ledgerOf(manifest));
  if (!canCleanFrom(project, standing)) {
    throw new Error(
      `Clean text is not offered from where this project is standing (`
      + `${standing === null ? 'no history yet' : `${standing.action} — ${standing.label}`}), so `
      + 'nothing was planned. The dialog draws the same refusal by leaving the button off.');
  }

  const settings = readAppSettings();
  /*
   * WHICH SERVER, and therefore which URL and which model field. Foundry 19f5e70
   * (Owen, 2026-09-08: "lets build in vllm batching. ollama batching doesnt
   * work"): the three text acts take `--server ollama|vllm`, declared and never
   * sniffed from a URL, and the app keeps BOTH servers' settings so switching
   * back costs no retyping — `llmServer` picks, `vllmUrl`/`vllmModel` are the
   * vLLM pair, `ollamaUrl`/`cleanTextModel` the Ollama pair. This door mirrors
   * `clean-dialog.add()` field for field, so under vLLM the model is
   * `vllmModel`, which is EMPTY by default and means "whatever the server is
   * serving" — the engine asks /v1/models and records the served id. An empty
   * model is therefore a real value here, not a missing one, and `argsFor`
   * omits `--model` for it rather than sending an empty name.
   */
  const server = said(args.server) ?? settings.llmServer;
  if (server !== 'ollama' && server !== 'vllm') {
    throw new Error(`--server ${server} is not a server kind this door knows; it is ollama or vllm.`);
  }
  const model = said(args.model) ?? (server === 'vllm' ? settings.vllmModel : settings.cleanTextModel);
  const ollama = said(args.ollama) ?? (server === 'vllm' ? settings.vllmUrl : settings.ollamaUrl);
  let concurrency;
  if (args.concurrency !== undefined && args.concurrency !== true) {
    concurrency = Number(args.concurrency);
    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new Error(`--concurrency ${args.concurrency} is not a whole number of blocks in flight.`);
    }
  }

  // `workspace:plan-clean`'s call, with its own answer's rename: the handler
  // returns `{...plan, inputPath: plan.sourcePath}` and the dialog reads that.
  const plan = await planCleanup(original.path, standing);
  if (plan.stampPath === undefined || plan.stampPath.length === 0) {
    throw new Error('Foundry could not work out where to record what the cleanup did, so the run '
      + 'was not started.');
  }

  // `clean-dialog.add()`, field for field.
  const request = {
    kind: 'clean',
    inputPath: plan.sourcePath,
    ...(plan.bookPath !== undefined ? { bookPath: plan.bookPath } : {}),
    recordsPath: plan.recordsPath,
    stampPath: plan.stampPath,
    ...(plan.deferred !== undefined ? { deferred: plan.deferred } : {}),
    model,
    ollama,
    ...(server === 'vllm' ? { server: 'vllm' } : {}),
    ...(plan.seedRecords !== undefined ? { seedRecords: plan.seedRecords } : {}),
    ...(plan.generation !== undefined ? { generation: plan.generation } : {}),
    stepId: plan.stepId,
    // The two headless-only fields. Absent is the engine's own default in both
    // cases — 4 blocks in flight, and the weights released at the end.
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(args['keep-model'] === true ? { keepModel: true } : {}),
  };

  const parentStep = await positionStepId(foundryProjectDir);
  const engine = fdist('electron/engine.js').engineCommand();
  const argv = jobQueue.argsFor(request);

  /*
   * WHICH BUILD ANSWERED, asked of the binary rather than assumed from its path —
   * `foundryVersion()`, the app's own `foundry --version`. It is printed on a dry
   * run because that is exactly the run somebody makes to find out whether the
   * flags on the line are flags this engine has: `--concurrency` arrived in 1.2.0,
   * and a path alone cannot say which release is sitting at it.
   */
  const { foundryVersion } = require(path.join(BF_DIST, 'foundry-bridge.js'));
  let version;
  try {
    const said = await foundryVersion();
    version = `foundry ${said.version}${said.commit ? ` (${said.commit})` : ''}`;
  } catch (err) {
    version = `could not be asked — ${err.message}`;
  }

  console.log(`[clean] library          ${libraryRoot}`);
  if (projectArg !== null) console.log(`[clean] book             ${path.resolve(projectArg)}`);
  console.log(`[clean] foundry project  ${foundryProjectDir}`);
  console.log(`[clean] document         ${original.path}`);
  console.log(`[clean] position         ${standing === null ? '(none)'
    : `${standing.id}  ${standing.action} — ${standing.label}`}`);
  console.log(`[clean] parentStep       ${parentStep ?? '(none)'}`);
  console.log(`[clean] mints step       ${plan.stepId ?? '(none)'}`);
  console.log(`[clean] server           ${server}${said(args.server) ? ' (--server)' : ' (app-settings llmServer)'}`);
  console.log(`[clean] model            ${model.length > 0 ? model : '(none — the served model, resolved and recorded by the engine)'}`
    + `${said(args.model) ? ' (--model)' : server === 'vllm' ? ' (app-settings vllmModel)' : ' (app-settings cleanTextModel)'}`);
  console.log(`[clean] endpoint         ${ollama}${said(args.ollama) ? ' (--ollama)' : server === 'vllm' ? ' (app-settings vllmUrl)' : ' (app-settings ollamaUrl)'}`);
  console.log(`[clean] concurrency      ${concurrency ?? "the engine's own default (4)"}`);
  console.log(`[clean] keep model       ${request.keepModel === true
    ? 'yes — --keep-model, the weights stay resident'
    : 'no — the weights are released when the run ends'}`);
  console.log(`[clean] engine           ${engine.command}${engine.args.length ? ` ${engine.args.join(' ')}` : ''}  (${engine.source})`);
  console.log(`[clean] engine version   ${version}`);
  console.log(`[clean] foundry build    ${FOUNDRY_DIST}`);
  console.log(`[clean] request          ${JSON.stringify(request, null, 2).split('\n').join('\n                         ')}`);
  console.log(`[clean] spawn            ${[engine.command, ...engine.args, ...argv].join(' ')}`);

  if (dryRun) {
    console.log('[clean] DRY RUN — nothing was spawned, no model was loaded.');
    return;
  }

  /*
   * THE VERSION GATE, where `queue-steps/foundry-job.ts` puts it: the last moment
   * anything on this side can say the installed engine has no `clean-text`, asked
   * before Foundry is told to spawn and before a model is loaded.
   */
  const { foundryVersionAtLeast } = require(path.join(REPO, 'dist', 'shared', 'vlm', 'readings-bank.js'));
  const { FOUNDRY_VERSION_FOR_CLEAN_TEXT, foundryTooOldForCleanText, parseFoundryProgressLine } =
    require(path.join(BF_DIST, 'foundry-host-queue.js'));
  const installed = await foundryVersion();
  if (!foundryVersionAtLeast(installed.version, FOUNDRY_VERSION_FOR_CLEAN_TEXT)) {
    throw new Error(foundryTooOldForCleanText(installed.version));
  }

  // Ctrl+C aborts through an AbortController, which is what the queue step hands
  // `runJob` — the same gesture the ✕ makes on a running row.
  const controller = new AbortController();
  process.on('SIGINT', () => {
    console.log('\n[clean] stopping — the records written so far are kept, and a re-run asks only '
      + 'about the blocks with no answer.');
    controller.abort();
  });

  const startedAt = Date.now();
  let last = null;
  const row = await jobQueue.runJob(request, {
    parentStep,
    signal: controller.signal,
    onProgress: (line) => {
      const counted = parseFoundryProgressLine(line);
      if (counted === null) { console.log(`[clean] ${line}`); return; }
      last = counted;
      console.log(`clean-text: ${counted.page}/${counted.total}`);
    },
  });

  const seconds = (Date.now() - startedAt) / 1000;
  const blocks = last === null ? null : last.total;
  console.log(`[clean] ${row.state}${row.error ? ` — ${row.error}` : ''}`);
  console.log(`[clean] blocks           ${blocks ?? '(the engine reported no count)'}`);
  console.log(`[clean] elapsed          ${seconds.toFixed(1)}s`
    + (blocks ? `  (${(blocks / (seconds / 60)).toFixed(1)} blocks/min)` : ''));

  /*
   * WHAT THE RECEIPT SAYS. The stamp is the run's own account of itself — every
   * count in it is the engine's, never counted again here.
   */
  if (fs.existsSync(request.stampPath)) {
    const stamp = JSON.parse(fs.readFileSync(request.stampPath, 'utf8'));
    console.log(`[clean] stamp            ${request.stampPath}`);
    console.log(`[clean]                  ${JSON.stringify(stamp)}`);
  }

  // THE STEP IT LANDED, read back out of the ledger rather than assumed: the run
  // writes it, and a door that printed the id it asked for would report a landing
  // that may not have happened.
  const after = ledgerOf(await readManifest(foundryProjectDir));
  const landed = after.steps.find((step) => step.id === plan.stepId);
  console.log(`[clean] landed step      ${landed === undefined
    ? '(none — the ledger has no step with the planned id)'
    : `${landed.id}  ${landed.action} — ${landed.label}`}`);

  if (row.state !== 'done') process.exitCode = 1;
}

main().catch((err) => {
  console.error(`[clean] ${err.message}`);
  process.exitCode = 1;
});
