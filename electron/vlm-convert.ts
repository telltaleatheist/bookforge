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

import { ensureFoundryPath, foundryVersion, runFoundry } from './foundry-bridge';
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
import { familyStem, nextReadingName, resolveFamily } from '../shared/document/book-families';
import {
  FOUNDRY_VERSION_FOR_READINGS_FLAGS,
  describeReadingsDecision,
  foundryTooOldForReadingsFlags,
  foundryVersionAtLeast,
  readingsChoiceOfJob,
  vlmReadingsArgs,
  type VlmReadingsBank,
  type VlmReadingsChoice,
} from '../shared/vlm/readings-bank';
import {
  VLM_CONVERT_STAGE,
  parseVlmProgressLine,
  resolveVlmEndpoint,
  vlmEndpointArgs,
  vlmEndpointModelsUrl,
  resolveVlmRoute,
  vlmSkipPagesArgs,
  type VlmConvertDestination,
  type VlmConvertRequest,
  type VlmConvertResult,
  type VlmEndpointCheck,
  type VlmEndpointConfig,
  type VlmRoute,
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

/** foundry's completion marker, beside the readings it belongs to. */
function completionMarkerPath(readingsPath: string): string {
  return path.join(path.dirname(readingsPath), 'completed.json');
}

/**
 * How many DISTINCT pages this bank answers for, by reading it.
 *
 * Counted by page number rather than by line, because that is what foundry
 * counts and the two must agree — a dialog that says 317 while foundry resumes
 * 316 is a dialog nobody can act on. A book's bank is single-digit megabytes,
 * so it is read rather than streamed.
 *
 * A line that is not JSON is SKIPPED here and nowhere else: foundry appends and
 * fsyncs each answer, so a killed run leaves a half-written last line, and this
 * is a count for a dialog rather than the reader of the answers. foundry itself
 * refuses a malformed line that is not the last one, which is where that check
 * belongs.
 */
async function bankedPageCount(readingsPath: string): Promise<number> {
  if (!fs.existsSync(readingsPath)) return 0;
  const text = await fs.promises.readFile(readingsPath, 'utf8');
  const pages = new Set<number>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const page = (JSON.parse(line) as { page?: unknown }).page;
      if (typeof page === 'number') pages.add(page);
    } catch {
      continue;
    }
  }
  return pages.size;
}

/**
 * Everything known about the answers banked for one PDF — for the dialog that
 * asks what to do with them, and for the log line that says what was done.
 *
 * TWO witnesses to "a conversion of this book already finished", and both are
 * consulted because neither covers every book. foundry's own `completed.json` is
 * authoritative and is absent from every bank written before foundry wrote
 * markers; BookForge's provenance — the `vlm-convert` pass on `outputs.epub`,
 * matched on the PDF's sha256 — is the only record those legacy banks leave.
 * Either one means the same thing: re-ordering this conversion is ordering the
 * work, not a replay of it.
 */
export async function inspectVlmReadingsBank(
  request: VlmConvertRequest,
): Promise<VlmReadingsBank> {
  const project = await resolveDocumentProject({
    projectDir: request.projectDir,
    ...(request.variantId ? { variantId: request.variantId } : {}),
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
  });
  const pdfPath = primaryAbsPath(project);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `${project.primaryRelPath} is recorded as this project's PDF, but it is not on disk, so `
      + 'BookForge cannot tell whether any page readings are banked for it.'
    );
  }
  const { sha256 } = await sha256File(pdfPath);
  const manifest = await manifestService.getManifest(project.projectId);
  if (!manifest.success || !manifest.manifest) {
    throw new Error(
      `Could not read ${project.projectDir}'s manifest: ${manifest.error}`
    );
  }
  return readBank(vlmReadingsPath(sha256), manifest.manifest, sha256);
}

/**
 * The bank, measured. Split from `inspectVlmReadingsBank` so the run itself —
 * which has already resolved the project, hashed the PDF and read the manifest —
 * measures the SAME bank the dialog did without doing any of it twice.
 */
async function readBank(
  readingsPath: string,
  manifest: {
    families?: Array<{
      id: string;
      source: { path: string; kind: 'archive-epub' | 'generated-epub'; sha256: string | null };
      epub?: { appliedPasses?: Array<{ kind: string; at: string; params?: Record<string, unknown> }> };
    }>;
  },
  pdfSha256: string,
): Promise<VlmReadingsBank> {
  const pages = await bankedPageCount(readingsPath);

  // foundry's marker. A marker that will not parse is a REFUSAL rather than a
  // shrug: "there is a file here I cannot read" and "no run ever completed" are
  // different facts, and reading the second out of the first is how a finished
  // conversion gets replayed out of a cache.
  const markerPath = completionMarkerPath(readingsPath);
  let completedAt: string | null = null;
  let markerPages: number | null = null;
  if (fs.existsSync(markerPath)) {
    const raw = await fs.promises.readFile(markerPath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${markerPath} is where foundry records a finished conversion, and it is not JSON `
        + `(${(err as Error).message}). BookForge cannot tell whether the readings beside it are a `
        + 'finished book or an interrupted one. Move it aside to convert this book again.'
      );
    }
    const marker = parsed as { completedAt?: unknown; pages?: unknown };
    if (typeof marker.completedAt !== 'string') {
      throw new Error(
        `${markerPath} carries no completedAt, so it is not a foundry completion marker. `
        + 'BookForge cannot tell whether the readings beside it are a finished book or an '
        + 'interrupted one. Move it aside to convert this book again.'
      );
    }
    completedAt = marker.completedAt;
    markerPages = typeof marker.pages === 'number' ? marker.pages : null;
  }

  // BookForge's own record: the conversion pass on this project's book, matched
  // on the PDF it was read from. The LAST one, because a book converted twice
  // has two and the recent one is the one this bank belongs to.
  //
  // An absent list is a book with no provenance — a project that has never
  // exported an EPUB — which is a real state and the honest answer is "no
  // conversion is recorded", not a missing value being papered over.
  //
  // WHICH chain's provenance, through the one resolver every surface uses
  // (shared/document/book-families.ts) — with the NO-CHAIN case answered here
  // rather than refused, because it is the ordinary state of the project this
  // dialog is usually open on: a PDF nobody has converted has no chain, so it
  // has no book, so no conversion is recorded against one. That is a fact about
  // the project, not a question this cannot answer.
  //
  // Several chains IS refused. Matching this PDF's cast against another
  // version's passes would read a finished conversion out of a book that is not
  // the one being converted.
  const families = manifest.families ?? [];
  let passes: Array<{ kind: string; at: string; params?: Record<string, unknown> }> = [];
  if (families.length > 0) {
    const chain = resolveFamily(families, undefined, path.basename(readingsPath));
    if (chain.refusal !== null) throw new Error(chain.refusal);
    passes = chain.family.epub?.appliedPasses ?? [];
  }
  const mine = passes.filter(
    (pass) => pass.kind === 'vlm-convert' && pass.params?.['sourceSha256'] === pdfSha256,
  );
  const recorded = mine.length === 0 ? null : mine[mine.length - 1];
  const recordedTotal = recorded?.params?.['totalPages'];

  return {
    path: readingsPath,
    pages,
    completedAt,
    recordedConversionAt: recorded === null || recorded === undefined ? null : recorded.at,
    // foundry's marker first — it is a count of the book the model actually
    // read. Never zero passed off as a total: a provenance record written by a
    // run whose summary line was not parsed carries 0, and "0 of 0 pages" in a
    // dialog is a sentence that describes nothing.
    totalPages: markerPages !== null && markerPages > 0
      ? markerPages
      : typeof recordedTotal === 'number' && recordedTotal > 0 ? recordedTotal : null,
  };
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
 * What to call a SECOND reading of the same pages — the naming rule, applied to
 * the chains this project already has.
 *
 * The rule itself is pure and lives with the other naming rules
 * (`nextReadingName`, shared/document/book-families.ts), where it can be tested
 * without a project. This is the half that reads the disk: the CHAINS rather
 * than the directory, because a chain's stem is what collides, and two files may
 * share a stem with different extensions while only one of those facts can
 * destroy a working copy.
 */
async function unusedReadingName(projectDir: string, stem: string): Promise<string> {
  const families = await manifestService.readBookFamilies(projectDir);
  return `${nextReadingName(families.map((f) => familyStem(f.source)), stem)}.epub`;
}

/**
 * Everything a conversion has DECIDED before anything is spawned.
 *
 * Split out of `runVlmConversion` on 2026-08-10 so the headless CLI can say what
 * a run WOULD do (`--generate-epub --dry-run`) without a GPU, and say it in the
 * run's own words. It is the plan, not a second opinion: `runVlmConversion`
 * begins by calling this and uses nothing else, so a `--dry-run` that names a
 * source, a target, a route or a readings decision is naming the one the run
 * would use. A separate derivation would be a report that can be right about a
 * run that no longer happens that way.
 *
 * Everything here is READ-ONLY of the project — a plan writes nothing — with the
 * two exceptions the ordering comments in `runVlmConversion` already argued for:
 * `ensureFoundryPath` may download the binary, and the `--fresh-readings` version
 * gate runs `foundry --version`. Both are checks that must happen before a stage
 * is claimed, and both are exactly as cheap in a plan as in a run.
 */
export interface VlmConversionPlan {
  project: DocumentProject;
  /** The PDF whose pages would be read. On disk — the plan proved it. */
  pdfPath: string;
  /** Its digest, which is what keys the readings bank. */
  sha256: string;
  /** Which machine would read the pages. Never 'refused' — that throws here. */
  route: VlmRoute;
  /** The CONFIGURED endpoint, or null when nothing was configured. */
  configured: VlmEndpointConfig | null;
  /** Where the book lands. Absent on the request means 'replace'. */
  destination: VlmConvertDestination;
  /** `source/<archive basename>.generated.epub`, as manifest-service derives it. */
  generatedTarget: manifestService.ExportEpubLocation;
  /** `dc:language` for the book, declared by the project. */
  language: string;
  readingsPath: string;
  bank: VlmReadingsBank;
  readingsChoice: VlmReadingsChoice;
  /** `--fresh-readings` / `--reuse-readings`, or nothing when there is no bank. */
  readingsFlags: string[];
  /** The one sentence the job log gets about the bank, before a page is read. */
  readingsDecision: string;
  /** `--skip-pages 4,5`, or nothing. Exactly what goes on the command line. */
  skipPages: string[];
  /** The same pages back as numbers, one-based, for the record and the result. */
  skippedPages: number[];
}

export async function planVlmConversion(request: VlmConvertRequest): Promise<VlmConversionPlan> {
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

  const generatedTarget = await manifestService.generatedEpubTarget(project.projectDir);
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

  /*
   * What happens to the answers already banked for this PDF — decided by the
   * user when the job was added to the queue, obeyed here, and never re-decided.
   *
   * The choice travels ON THE REQUEST because that is what makes a retry honour
   * it: the queue re-runs the same config, so the second attempt reads the same
   * answer as the first and cannot flip to something the user did not ask for.
   * A request carrying NO choice is one made before the question existed — a job
   * enqueued by an older build, or the headless CLI, where there is nobody to
   * ask — and Owen's rule for those is that they were expecting the bank and
   * rely on it.
   *
   * Measured HERE rather than trusted from the renderer: the bank is a fact
   * about this machine's disk at this instant, and a job that sat in the queue
   * overnight would otherwise be carrying last night's page count into a
   * decision about which flag to pass.
   */
  const bank = await readBank(readingsPath, manifest.manifest, sha256);
  const readingsChoice = readingsChoiceOfJob(request.readings);
  const readingsFlags = vlmReadingsArgs(readingsChoice, bank.pages);

  // A foundry that predates the flag cannot be told any of this, and running it
  // anyway would let it decide on its own — which for a completed conversion is
  // the silent replay this whole path exists to end. Named, and nothing runs.
  if (readingsFlags.length > 0) {
    const installed = await foundryVersion();
    if (!foundryVersionAtLeast(installed.version, FOUNDRY_VERSION_FOR_READINGS_FLAGS)) {
      throw new Error(foundryTooOldForReadingsFlags(installed.version, readingsFlags[0]));
    }
  }

  return {
    project,
    pdfPath,
    sha256,
    route,
    configured,
    // Absent means 'replace' — the historic act, stated here once so nothing
    // downstream has to remember what an absent field meant
    // (shared/vlm/conversion.ts).
    destination: request.destination ?? 'replace',
    generatedTarget,
    language,
    readingsPath,
    bank,
    readingsChoice,
    readingsFlags,
    readingsDecision: describeReadingsDecision(
      readingsChoice, bank, request.readings === undefined),
    skipPages,
    skippedPages,
  };
}

/**
 * Convert a project's PDF into its book, and record it.
 *
 * The five acts, in this order, and the order is the design:
 *
 *  1. foundry writes the EPUB into `/tmp/bookforge-staging/`. Nothing lands in
 *     the synced library until the run has finished and exited zero — a
 *     half-written EPUB inside the library is a half-written EPUB propagating to
 *     every other machine.
 *  2. It is moved onto `generatedEpubTarget`'s path, atomically at the
 *     destination. WHERE it goes and what it is CALLED are `manifest-service`'s
 *     answers, not this module's: the book's name is derived in one place
 *     (docs: "One place derives the name").
 *
 *     This is the GENERATED BOOK, and it is archive-grade — nothing writes to it
 *     ever again. It used to land straight on `outputs.epub`, which made the
 *     cast and the editable book one file and put this hour of GPU inside the
 *     thing a user throws away to start their edits over (Owen, 2026-08-09: "an
 *     epub generated from a pdf… should be treated as an archive file").
 *  3. `registerGeneratedEpub` records it with its digest.
 *  4. `mintWorkingCopyFrom` makes the byte-identical working copy the user edits
 *     and records THAT as `outputs.epub` — which also ends the old book's
 *     provenance and drops the narration copy cut from it, because this is a
 *     rebuild and the passes applied to the previous bytes did not happen to
 *     these. It is the same mint an EPUB-native project's copy gets, so there is
 *     one answer to "where did this working copy come from" whatever the project
 *     started as.
 *  5. `appendAppliedPass` writes the conversion into the fresh provenance, so
 *     the versions page can say where this book came from. It goes AFTER the
 *     mint for the same reason the foundry passes' records do: registering an
 *     export starts provenance over, and a record written before it would be
 *     erased by it.
 *
 * What is NOT done here is a reset. The user's deleted pages are a fact about
 * the PDF and were just OBEYED by this run (`--skip-pages`); clearing them
 * because the book was rebuilt would silently un-skip them on the next cast.
 *
 * Acts 2-5 are what makes a cast into THIS PROJECT'S BOOK, and a request that
 * asked for a NEW COPY (`destination: 'new-copy'`) does none of them — it
 * registers the reading as another archive-grade variant and stops. See the
 * branch below, which says what it deliberately leaves alone and why.
 */
export async function runVlmConversion(request: VlmConvertRequest): Promise<VlmConvertResult> {
  // Every decision this run makes before it spawns anything, made once, in the
  // order the comments in `planVlmConversion` argue for. Nothing below re-derives
  // any of it — which is what lets `--dry-run` report a plan that IS this run's.
  const {
    project, pdfPath, sha256, route, configured, destination, generatedTarget, language,
    readingsPath, readingsFlags, readingsDecision, skipPages, skippedPages,
  } = await planVlmConversion(request);

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

    // What is being done about the banked readings, in one sentence, before
    // anything spawns. On the progress channel because that is the job log — a
    // decision nobody can read in the log is a decision nobody can check, and
    // this bug was invisible for exactly that reason.
    opts.onProgress({
      stage: 'vlm-convert',
      message: readingsDecision,
      done: 0,
      total: 0,
    });

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
        // Explicit, always, whenever a bank exists — never left to foundry's own
        // marker. BookForge knows things the marker does not: a bank written
        // before markers existed carries none, and this app's provenance is the
        // only record that the conversion finished. One decision, made in
        // shared/vlm/readings-bank.ts, obeyed on both sides of the process
        // boundary. Gated on the installed foundry above, so it is never
        // silently dropped against a binary that would ignore it.
        ...readingsFlags,
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

  const unreadableEarly = unreadablePagesFrom(result.stderr);

  /*
   * ── A SECOND archive file, and nothing else ────────────────────────────────
   *
   * Owen, 2026-08-09: a conversion ordered on a project that already has an EPUB
   * can be told to leave that book alone — the new reading "is added as a new
   * archive file right next to the archive epub that already exists".
   *
   * What this branch does NOT do is the whole of it. No `registerGeneratedEpub`,
   * no `mintWorkingCopyFrom`, no `appendAppliedPass`: those three are what make a
   * cast into THIS PROJECT'S BOOK, and running them would replace the working
   * copy the user is editing and end its ledger — which is the exact thing they
   * chose not to do. The file is registered as an ordinary ebook VARIANT
   * (`addVariant`), which is the one path that lands a book in `archive/` with a
   * readable name and a record, whatever a project's migration state
   * (`getVariants` only synthesises `arch:` rows for projects with no real
   * variants, so writing to `manifest.archive[]` would leave most projects with a
   * file and no row).
   *
   * It DOES get a working chain of its own, as of 2026-08-10. Owen: "i do have
   * different versions of books, and i want to be able to run adjustment chains
   * on different versions." A second reading beside the first is exactly such a
   * version, and a chain per archive file is what makes that sayable — so the
   * file is registered as a variant AND given a chain, and the two acts are
   * reported separately because the second can refuse while the first stands.
   */
  if (destination === 'new-copy') {
    // Named before it is registered. `addVariant` reads the FILENAME for the
    // version's title, and the staging name is a sha — a version called
    // "vlm-convert-3f2a9c11" is a row nobody can identify a month later.
    //
    // And named DISTINCTLY from every chain the project already has. Every file
    // in a chain is called `source/<the source's basename>.…`, so a second
    // reading called `<book>.epub` beside a cast called `<book>.generated.epub`
    // would want the same working copy as the first — which `addBookFamily`
    // refuses, correctly and uselessly, because the name was never the user's
    // choice to begin with. The reading number is what makes them different
    // books to the naming rule as well as to the reader.
    const readableName = await unusedReadingName(
      project.projectDir, path.basename(generatedTarget.absPath, '.generated.epub'));
    const readable = path.join(path.dirname(stagedEpub), readableName);
    await moveIntoPlace(stagedEpub, readable);
    const { addVariant } = await import('./library-actions.js');
    const added = await addVariant(project.projectId, readable);
    // The staged copy has served its purpose either way — `addVariant` COPIES
    // into archive/, so leaving this behind would fill the staging directory
    // with whole books.
    try { await fs.promises.rm(readable, { force: true }); } catch { /* staging */ }
    if (!added.success || !added.variant) {
      throw new Error(
        `The pages were read, but the book could not be added beside this project's existing `
        + `archive files: ${added.error ?? 'no reason given'}. Nothing else was changed — the book `
        + 'you were editing is untouched.'
      );
    }
    const absPath = path.join(project.projectDir, added.variant.path.split('/').join(path.sep));

    // ── And a chain of its own ────────────────────────────────────────────────
    //
    // The whole point of the second copy: a version the user can run their own
    // adjustments on, with its own working copy, its own ledger, its own strikes
    // and its own narration copy. `addBookFamily` is the one act that makes one,
    // and the one place the naming rule is enforced.
    //
    // Its refusal is CARRIED BACK, not thrown: the reading succeeded and the
    // file is in the project, so failing the whole conversion would tell the
    // user their hour of GPU produced nothing when it produced a book. The
    // sentence names which two files collide and what to rename, and the caller
    // shows it verbatim.
    let newCopy: VlmConvertResult['newCopy'];
    try {
      const chain = await manifestService.addBookFamily(
        project.projectDir, { absPath, kind: 'archive-epub' });
      newCopy = { familyId: chain.id, refusal: null };
      console.log(
        `[vlm-convert] ${path.basename(project.projectDir)}: the new reading ${added.variant.path} `
        + `has its own working chain, ${chain.id}.`
      );
    } catch (err) {
      newCopy = { familyId: null, refusal: (err as Error).message };
      console.warn(
        `[vlm-convert] ${path.basename(project.projectDir)}: ${added.variant.path} was added, but `
        + `it could not be given a working chain: ${(err as Error).message}`
      );
    }

    console.log(
      `[vlm-convert] ${path.basename(project.projectDir)}: read the pages into a NEW archive file, `
      + `${added.variant.path}. The project's book, its working copy and its ledger are untouched.`
    );
    return {
      endpoint: endpoint === null ? null : endpoint.url,
      epubPath: absPath,
      relPath: added.variant.path,
      inferredPages: inferredPagesFrom(result.stderr),
      totalPages: totalPagesFrom(result.stderr) ?? 0,
      unreadable: unreadableEarly,
      skippedPages,
      newCopy,
    };
  }

  // ── The hour of GPU is RECORDED as soon as it is on disk ──────────────────
  //
  // The move and the record used to be two statements with nothing tying them
  // together, and a crash in the gap left `source/<stem>.generated.epub` sitting
  // there unrecorded — invisible to every consumer (the record is the only thing
  // that says a project has a cast book) and silently overwritten by the next
  // run, which is an hour of somebody's GPU thrown away without a word.
  //
  // So the record is written IMMEDIATELY after the move, and a failure to write
  // it takes the file back out: better an interrupted conversion the user can
  // simply run again than a book on disk that nothing can find and nothing can
  // account for. `registerGeneratedEpub` measures the file's digest, so it has
  // to run after the bytes are in place — this is the one act whose record
  // cannot come first.
  await moveIntoPlace(stagedEpub, generatedTarget.absPath);
  let generated: Awaited<ReturnType<typeof manifestService.registerGeneratedEpub>>;
  try {
    generated = await manifestService.registerGeneratedEpub(
      project.projectDir, generatedTarget.absPath, 'cast');
  } catch (err) {
    try { await fs.promises.unlink(generatedTarget.absPath); } catch { /* already gone */ }
    throw new Error(
      `The pages were read, but the book could not be recorded in ${path.basename(project.projectDir)}`
      + `'s manifest: ${(err as Error).message}. The file was removed rather than left where nothing `
      + 'can find it — run Convert to EPUB again once the project can be written to.'
    );
  }
  const target = await manifestService.mintWorkingCopyFrom(
    project.projectDir, { absPath: generated.absPath, kind: 'generated-epub' });

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
