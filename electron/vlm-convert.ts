/**
 * vlm-convert — the second route from a PDF to this project's book, driven from
 * BookForge.
 *
 * `foundry vlm-convert` hands each page picture to a document VLM (dots.ocr) and
 * assembles what comes back into an EPUB. Owen's design, 2026-08-07: one button
 * on a PDF-sourced project, and the EPUB it writes is the OFFICIAL, COMPLETE
 * book — everything kept — recorded as `manifest.outputs.epub`. What a listener
 * does not want to hear is struck out afterwards, in the picker, and exported as
 * a SECOND file (shared/vlm/narration-deletions.ts). This module is the first
 * half of that.
 *
 * ── Why it is a document STAGE and not a pass ───────────────────────────────
 *
 * A processing pass reads `outputs.epub`, transforms it, and renames the result
 * back onto the same path (docs/PROCESSING_PIPELINE_V2.md). A conversion is
 * where the book COMES FROM: there is nothing to read, nothing to diff against,
 * and no legal position for it in a chain except first. So it goes through
 * `withProjectStage`, exactly like the cast and the detect, and gets the three
 * things that come with it for free and correctly:
 *
 *  - a project can have ONE at a time, refused by name by the stage registry
 *    (a second conversion writing the same book is two writers on one file);
 *  - it is owned by MAIN, so an ng-serve reload cannot kill ninety minutes of
 *    GPU, and quit aborts it;
 *  - every window hears `document:stage-started` / `-progress` / `-finished`,
 *    which is what the picker already listens to.
 *
 * The chain planner never sees `vlm-convert` and must not: `buildJobConfig`
 * throws on a pass kind it does not know, which is the refusal.
 *
 * ── Resumability, and where the answers are banked ──────────────────────────
 *
 * `--readings <file.jsonl>` banks every page's answer as it lands and a re-run
 * reads only what is missing (foundry README §vlm-convert). A 300-page book is
 * about ninety minutes on the M1 Ultra, so a run that is interrupted at page 280
 * and has to start over is the difference between a feature and a threat. The
 * file is MACHINE-LOCAL — same rule as the render cache and the foundry run
 * directories: it is hundreds of megabytes of model output that means nothing on
 * another machine, and the library folder is Syncthing-synced.
 *
 * It is keyed by the PDF's sha256, so a re-imported or edited PDF gets a
 * different file without anything having to notice, and the answers can never be
 * about a different book than the pages being read.
 *
 * ── The two machines that can read the pages ────────────────────────────────
 *
 * MLX, here, is the default and on an Apple Silicon Mac it is the whole story.
 * It is also the ONLY thing Apple silicon can do and the only place it can be
 * done: mlx-vlm is Metal. So on every other machine there is no local route, and
 * this module refuses BY NAME before it spawns anything rather than letting
 * foundry's Python fail on `import mlx` — a traceback about a library the user
 * never chose is not an answer to "why did my book not convert".
 *
 * The other machine is somebody else's: `--vlm-endpoint` at an OpenAI-compatible
 * server (shared/vlm/conversion.ts `VlmEndpointConfig`). It is CONFIGURED, never
 * inferred, and neither route is ever a fallback for the other — a run that
 * quietly moved between them would be a run whose speed, cost and answers cannot
 * be explained. Which one ran is in the result, in the progress lines, and in
 * the provenance record.
 */

import { spawnSync } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureFoundryPath, runFoundry } from './foundry-bridge';
import { ensureVlmPageServer, wslVlmRefusal } from './vlm-page-server';
import { getActiveBundledEnvPath, relocatablePythonPath } from './e2a-env-bootstrap';
import { getDefaultE2aPath } from './e2a-paths';
import { resolveDocumentProject } from './document-project';
import { primaryAbsPath, workingAbsPath, type DocumentProject } from './document-stages';
import { readWorkingDocumentState } from './working-document';
import { withProjectStage } from './document-stage-run';
import { moveIntoPlace } from './processing-passes';
import { sha256File } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  VLM_CONVERT_STAGE,
  parseVlmProgressLine,
  resolveVlmEndpoint,
  vlmEndpointArgs,
  vlmEndpointModelsUrl,
  resolveVlmRoute,
  vlmSkipPagesArgs,
  type VlmConvertRequest,
  type VlmConvertResult,
  type VlmEndpointCheck,
  type VlmEndpointConfig,
} from '../shared/vlm/conversion';

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * `--python`, pointing at an interpreter that can RENDER the pages.
 *
 * Needed on EVERY route, including the endpoint one, and that is the part which
 * is easy to get wrong: `--vlm-endpoint` moves the model somewhere else, not the
 * rasteriser. foundry embeds pdf.js for text extraction only — its canvas layer
 * cannot survive `bun build --compile`, and every drawing method on the shim
 * throws on purpose — so a page becomes a picture in PyMuPDF, on this machine,
 * whichever GPU is going to read it (foundry src/vlm/vlm_page.py).
 *
 * ── Why the candidate is VERIFIED rather than assumed ───────────────────────
 *
 * The first version of this asked `getActiveBundledEnvPath()` and passed nothing
 * when it answered null. That function returns null in DEV on purpose — dev is
 * meant to use the live conda env, not the packaged relocatable copy — so under
 * `electron:dev` the flag was silently dropped and foundry fell back to hunting
 * for a conda env of its own, failing with four paths that mean nothing on this
 * machine (one of them under /opt/homebrew, because its candidate list is
 * written for the Mac it was built on). A silently omitted flag turned a missing
 * dependency into a message about somebody else's computer.
 *
 * So each candidate is TESTED — `python -c "import fitz"` — and the first that
 * answers is used. It costs about a second, once, at the front of a run that
 * takes minutes.
 */
function renderPythonCandidates(): string[] {
  const userData = app.getPath('userData');
  const bundled = getActiveBundledEnvPath();
  return [
    // Packaged: the relocatable env this app installed.
    ...(bundled ? [relocatablePythonPath(bundled)] : []),
    // The same env by path, which exists in DEV too — it is where the packaged
    // build unpacks, and a dev machine that has ever run one still has it. This
    // is the entry that makes Convert to EPUB work under `electron:dev`.
    relocatablePythonPath(path.join(userData, 'runtime', 'e2a-env')),
    // e2a's own env, for a checkout-driven dev machine that has no unpacked copy.
    relocatablePythonPath(path.join(getDefaultE2aPath(), 'python_env')),
  ];
}

/** Can this interpreter turn a page into a picture? */
function hasPyMuPDF(python: string): boolean {
  if (!fs.existsSync(python)) return false;
  const probe = spawnSync(python, ['-c', 'import fitz'], { timeout: 30_000, windowsHide: true });
  return probe.status === 0;
}

/**
 * The `--python` flag, or a REFUSAL naming every interpreter that was tried.
 *
 * Never an empty list quietly: without this flag foundry looks for an env that
 * was never going to exist here, and the user reads a sentence about MLX — a
 * library they did not choose and, on the endpoint route, do not need.
 */
function renderPythonArgs(): string[] {
  const declared = process.env['FOUNDRY_VLM_PYTHON']?.trim();
  // Somebody set it deliberately; foundry reads the same variable, so let it,
  // and let its refusal be about the path they chose.
  if (declared) return [];

  const tried = renderPythonCandidates();
  const found = tried.find(hasPyMuPDF);
  if (!found) {
    throw new Error([
      'Converting a PDF needs a Python with PyMuPDF in it to turn each page into a picture — '
      + 'that happens on this machine even when a server reads the pages. None of these has it:',
      ...tried.map((t) => `  ${t}`),
      'Install the bundled environment in Settings → Add-ons, or set FOUNDRY_VLM_PYTHON to an '
      + 'interpreter that has PyMuPDF. Nothing was converted.',
    ].join('\n'));
  }
  return ['--python', found];
}

/**
 * Where this PDF's banked page answers live — machine-local, derived, never
 * recorded. A sibling of the foundry run directories for the same reason they
 * are there (electron/document-stages.ts `documentScratchDir`).
 */
export function vlmReadingsPath(pdfSha256: string): string {
  return path.join(
    os.homedir(), 'Documents', 'BookForge', 'foundry-runs',
    `vlm-${pdfSha256.slice(0, 16)}`, 'readings.jsonl'
  );
}

/**
 * `dc:language` for the book — DECLARED, never detected.
 *
 * foundry says so itself and it is right: nothing in the conversion reads a
 * language, and a guess would land in the EPUB's metadata wearing the authority
 * of a measurement. The project's own metadata is a thing a person set, so it is
 * the answer where there is one; `en` is foundry's own default, kept rather than
 * invented.
 */
function languageOf(manifest: { metadata?: { language?: string } }): string {
  const declared = (manifest.metadata?.language ?? '').trim();
  return declared.length > 0 ? declared : 'en';
}

/**
 * The pages this project's working copy marks deleted, zero-based — read off the
 * DOCUMENT, which is the only thing that knows.
 *
 * A page deletion is `/FoundryPageDeleted` on the page itself, written at the
 * gesture that made it (electron/working-document-writer.ts). The manifest also
 * carries a `source.deletedPages` mirror, written when the picker SAVES the
 * project, and it is deliberately not what is read here: it is a copy that can be
 * a session behind the file, and a conversion that left a page in because a save
 * had not happened yet would be ninety minutes producing a book the user can see
 * is wrong. One authority, and it is the file the button names.
 *
 * A missing working copy is a refusal rather than an empty list. The caller asked
 * for the book as curated; there is no curation, and quietly converting the
 * untouched original instead would answer a different question at full price.
 */
async function deletedPagesOfWorkingCopy(project: DocumentProject): Promise<number[]> {
  const working = workingAbsPath(project);
  if (!fs.existsSync(working)) {
    throw new Error(
      `${project.primaryRelPath} has no working copy, so there are no page deletions to honour. `
      + 'Create one from the archive row on the Versions page first, or convert the archive PDF '
      + 'itself. Nothing was converted.'
    );
  }
  const state = await readWorkingDocumentState(working);
  return state.pages.filter((page) => page.deleted).map((page) => page.index);
}

/**
 * Read one page count out of foundry's own summary lines, or null.
 *
 * `vlm-convert: 317 pages in 5120.4s (…)` is the last line of a successful run
 * and is the only place the whole page count is stated as a number rather than
 * as the right-hand side of a progress fraction.
 */
function totalPagesFrom(stderr: string): number | null {
  const match = /vlm-convert:\s+(\d+)\s+pages\s+in\s/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** The pages that are NOT in the book, with foundry's own reason for each. */
function unreadablePagesFrom(stderr: string): Array<{ page: number; reason: string }> {
  const out: Array<{ page: number; reason: string }> = [];
  const pattern = /vlm-convert:\s+page\s+(\d+)\s+SKIPPED\s+—\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    out.push({ page: Number(match[1]), reason: match[2].trim() });
  }
  return out;
}

function inferredPagesFrom(stderr: string): number {
  const match = /vlm-convert:\s+(\d+)\s+read this run at\s/.exec(stderr);
  return match ? Number(match[1]) : 0;
}

/**
 * Convert a project's PDF into its book, and record it.
 *
 * The four acts, in this order, and the order is the design:
 *
 *  1. foundry writes the EPUB into `/tmp/bookforge-staging/`. Nothing lands in
 *     the synced library until the run has finished and exited zero — a
 *     half-written EPUB inside the library is a half-written EPUB propagating to
 *     every other machine.
 *  2. It is moved onto `exportEpubTarget`'s path, atomically at the destination.
 *     WHERE it goes and what it is CALLED are `manifest-service`'s answers, not
 *     this module's: the book's name is derived in one place
 *     (docs: "One place derives the name").
 *  3. `registerEpubExport` records it — which also ends the OLD book's
 *     provenance and drops the narration copy cut from it, because this is a
 *     rebuild and the passes applied to the previous bytes did not happen to
 *     these.
 *  4. `appendAppliedPass` writes the conversion into the fresh provenance, so
 *     the versions page can say where this book came from. It goes AFTER the
 *     export for the same reason the foundry passes' records do: an export
 *     starts provenance over, and a record written before it would be erased by
 *     it.
 */
export async function runVlmConversion(request: VlmConvertRequest): Promise<VlmConvertResult> {
  // FIRST, before a project is resolved or 38 MB of foundry is fetched: whether
  // there is a machine that can read these pages at all. `resolveVlmEndpoint`
  // throws on a half-configured endpoint, and with no endpoint at all a machine
  // that is not an Apple Silicon Mac has no local reader — both are the user's
  // settings being wrong, and both are cheapest to say before anything starts.
  const configured = resolveVlmEndpoint(request.endpoint);
  const route = resolveVlmRoute({
    platform: process.platform,
    arch: process.arch,
    endpoint: configured,
    wslReaderRefusal: wslVlmRefusal(),
  });
  if (route.kind === 'refused') throw new Error(`${route.reason} Nothing was converted.`);

  const project = await resolveDocumentProject({
    projectDir: request.projectDir,
    ...(request.variantId ? { variantId: request.variantId } : {}),
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
  });
  const pdfPath = primaryAbsPath(project);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `${project.primaryRelPath} is recorded as this project's PDF, but it is not on disk. `
      + 'Nothing was converted.'
    );
  }

  // Awaited BEFORE the stage is claimed: `ensureFoundryPath` may download 38 MB,
  // and holding a project's stage lock through a transfer would refuse every
  // other stage for the duration of something that has not started yet.
  await ensureFoundryPath();

  const target = await manifestService.exportEpubTarget(project.projectDir);
  const manifest = await manifestService.getManifest(project.projectId);
  if (!manifest.success || !manifest.manifest) {
    throw new Error(
      `Could not read ${project.projectDir}'s manifest before converting: ${manifest.error}`
    );
  }
  const language = languageOf(manifest.manifest);

  // Resolved HERE, with the language and the readings path, rather than inside
  // the stage: it reads a file and can refuse (no working copy, an unreadable
  // record), and every refusal this run can make is cheaper before the stage is
  // claimed and the GPU is asked for.
  const skipPages = request.skipDeletedPages === true
    ? vlmSkipPagesArgs(await deletedPagesOfWorkingCopy(project))
    : [];
  // What went on the command line, back as numbers, so the record and the result
  // say exactly what foundry was told rather than a second derivation of it.
  const skippedPages = skipPages.length === 0
    ? []
    : skipPages[1].split(',').map(Number);

  const { sha256 } = await sha256File(pdfPath);
  const readingsPath = vlmReadingsPath(sha256);
  await fs.promises.mkdir(path.dirname(readingsPath), { recursive: true });
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const stagedEpub = path.join(STAGING_DIR, `vlm-convert-${sha256.slice(0, 16)}.epub`);

  // Started BEFORE the stage is claimed, for the same reason `ensureFoundryPath`
  // is: this waits on the GPU arbiter — potentially behind a TTS job — and then
  // on ~44 s of model load, and holding a project's stage lock through that
  // would refuse every other stage for a run that has not begun.
  //
  // `configured` WINS when it is set, so a user who pointed at their own server
  // is not made to start a second one on this machine.
  const reader = route.kind === 'wsl-server' ? await ensureVlmPageServer() : null;
  try {
    return await convertWith(reader === null
      ? configured
      : { url: reader.url, model: reader.model, concurrency: 0 });
  } finally {
    // On success, on failure and on cancellation alike — this is what takes the
    // server down and hands the 20 GB and the GPU arbiter to whatever the queue
    // runs next. A release that did not happen pins the card indefinitely.
    reader?.release();
  }

  async function convertWith(endpoint: VlmEndpointConfig | null): Promise<VlmConvertResult> {
  const result = await withProjectStage(project.projectDir, VLM_CONVERT_STAGE, async (opts) => {
    let lastMessage = '';
    let done = 0;
    let total = 0;
    // The rasterising pass, counted separately and only once it has spoken. It
    // stays null on the MLX route, and a null here is what tells the renderer to
    // show one bar rather than two.
    //
    // Gated on the ROUTE rather than on whether a render line turned up, because
    // those are not the same question. Only the endpoint route runs foundry with
    // `renderOnly`, which is what makes a conversion two passes. A RESUMED MLX
    // run also prints `page N/M: rendered` — for pages already banked in the
    // readings file, which it draws and then does not read — and reading those
    // as a rasterising pass would put up a bar that tracked which pages were
    // cached rather than any progress at all.
    const twoPass = endpoint !== null;
    let render: { done: number; total: number } | null = null;

    // Said before the first page, on the same channel the progress lines use, so
    // the modal states which GPU is about to be busy for the next ninety
    // minutes rather than implying the local one.
    opts.onProgress({
      stage: 'vlm-convert',
      message: endpoint === null
        ? 'Loading the vision model on this machine…'
        : reader !== null
          ? `Reading the pages on this machine's GPU, through WSL (${reader.model})…`
          : `Reading the pages on ${endpoint.url}…`,
      done: 0,
      total: 0,
    });

    const run = await runFoundry(
      [
        'vlm-convert',
        '--pdf', pdfPath,
        '--out', stagedEpub,
        '--readings', readingsPath,
        '--language', language,
        ...renderPythonArgs(),
        // Never stripped and retried on a foundry that does not know the flag:
        // that foundry would read every page, and a book silently containing the
        // pages the user deleted is the failure this is meant to prevent. Its own
        // unknown-flag error is the answer.
        ...skipPages,
        ...vlmEndpointArgs(endpoint),
      ],
      {
        signal: opts.signal,
        onProgress: (line) => {
          lastMessage = line;
          const parsed = parseVlmProgressLine(line);
          if (parsed?.phase === 'render') {
            if (twoPass) render = { done: parsed.done, total: parsed.total };
          } else if (parsed) {
            done = parsed.done;
            total = parsed.total;
            // Reading has begun, so every page that was going to be drawn has
            // been. foundry renders the whole book before it posts the first
            // page, and the last render line is the one for the last page it
            // was asked for — but a book with pages excluded never reaches its
            // own page count, so the bar would stop short of the end of work it
            // had actually finished.
            if (render !== null) render = { done: render.total, total: render.total };
          }
          opts.onProgress({
            stage: 'vlm-convert',
            message: line,
            done,
            total,
            ...(render !== null ? { render } : {}),
          });
        },
      }
    );

    if (run.code !== 0) {
      // foundry's own stderr is the message a user needs — it names the missing
      // Python, the model it could not load, the page it choked on. Never
      // paraphrased, and never replaced with an exit code.
      throw new Error(
        `foundry vlm-convert failed (exit ${run.code}).\n${run.stderr.trim() || lastMessage}`
      );
    }
    if (!fs.existsSync(stagedEpub)) {
      throw new Error(
        `foundry vlm-convert reported success but wrote no EPUB at ${stagedEpub}. `
        + 'Nothing was recorded.'
      );
    }
    return run;
  });

  await moveIntoPlace(stagedEpub, target.absPath);
  await manifestService.registerEpubExport(project.projectDir, target.absPath);

  const unreadable = unreadablePagesFrom(result.stderr);
  const totalPages = totalPagesFrom(result.stderr) ?? 0;
  const inferredPages = inferredPagesFrom(result.stderr);

  await manifestService.appendAppliedPass(project.projectDir, {
    kind: 'vlm-convert',
    at: new Date().toISOString(),
    params: {
      source: project.primaryRelPath,
      sourceSha256: sha256,
      language,
      totalPages,
      inferredPages,
      // Which machine read the pages, recorded with the book it wrote. Two
      // servers running two builds of the same model produce two different
      // books from one PDF, and months later this record is the only thing that
      // can tell them apart.
      endpoint: endpoint === null ? null : endpoint.url,
      ...(endpoint !== null && endpoint.model.length > 0 ? { endpointModel: endpoint.model } : {}),
      // Named in the record, not just in a log line: a page the model could not
      // read is a page of the user's book that is not in it, and the versions
      // page is where they would look for that months later.
      unreadablePages: unreadable.map((p) => p.page),
      // Recorded SEPARATELY from the unreadable ones and always — an empty list
      // is the positive statement that this conversion read the whole document.
      // A book missing pages 4-9 months from now is either a decision somebody
      // made in the working copy or a fault, and only the record can say which.
      skippedPages,
    },
  });

  return {
    endpoint: endpoint === null ? null : endpoint.url,
    epubPath: target.absPath,
    relPath: target.relPath,
    inferredPages,
    totalPages,
    unreadable,
    skippedPages,
  };
  }
}

/**
 * Can this endpoint be reached, and what is it serving?
 *
 * A GET of the OpenAI model list — the cheapest question a server of this shape
 * answers, and the one that distinguishes the four ways this setting is wrong
 * from each other: nothing listening (connection refused), something listening
 * that is not this (404, or HTML), the server up with no model loaded (an empty
 * list), and the server up with a DIFFERENT model than the name configured
 * here. All four are reported as themselves; none is repaired.
 *
 * It runs in MAIN because the renderer is a page on a different origin and a
 * CORS preflight to somebody's vLLM would fail for reasons that have nothing to
 * do with whether the server is up.
 */
export async function checkVlmEndpoint(config: VlmEndpointConfig): Promise<VlmEndpointCheck> {
  // The same validation the run does, so Test and Convert cannot disagree about
  // whether a setting is usable.
  const endpoint = resolveVlmEndpoint(config);
  if (endpoint === null) {
    return {
      reachable: false,
      models: [],
      error: 'No endpoint URL is set — the pages would be read on this machine with MLX.',
    };
  }

  const url = vlmEndpointModelsUrl(endpoint.url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      // Long enough for a loaded server on a slow link, short enough that a
      // wrong address does not look like a hang.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { reachable: false, models: [], error: `${url} — ${(err as Error).message}` };
  }

  if (!response.ok) {
    return {
      reachable: false,
      models: [],
      error: `${url} answered HTTP ${response.status} ${response.statusText}`.trim(),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      reachable: false,
      models: [],
      error:
        `${url} answered, but not with JSON (${(err as Error).message}). It is probably not an `
        + 'OpenAI-compatible server — the URL should end in /v1.',
    };
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return {
      reachable: false,
      models: [],
      error:
        `${url} answered JSON with no "data" list in it, which is not the OpenAI model-list shape.`,
    };
  }
  const models = data
    .map((entry) => (entry as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');

  const missing = endpoint.model.length > 0 && !models.includes(endpoint.model);
  return {
    reachable: true,
    models,
    ...(missing ? { modelMissing: endpoint.model } : {}),
  };
}
