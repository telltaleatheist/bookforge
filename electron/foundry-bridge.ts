/**
 * foundry-bridge — how BookForge talks to the `foundry` CLI.
 *
 * Foundry (github.com/telltaleatheist/foundry) is the extraction of this app's
 * page-layout model, OCR-repair contract and footnote-marker remover into a
 * standalone binary. BookForge drives it as a SUBPROCESS, the same way it drives
 * ebook2audiobook, and reads what it produces off disk.
 *
 * **The integration surface is files, not stdout.** Every foundry stage writes
 * its artifact to a documented path inside a run directory (foundry
 * docs/PIPELINE.md), and this module's `readRunDirectory` is the typed reader
 * for them. That is what lets pdf-picker paint its category layer from
 * `blocks/blocks.json`, let a user delete individual boxes, and re-export without
 * re-running a single model.
 *
 * This module is the transport and the typed reader. The PIPELINE that drives it
 * — render pages to PGM, scan, ocr, blocks, optionally footnotes, then export —
 * lives in `electron/foundry-run.ts`, which owns a run in MAIN so a renderer
 * reload cannot kill a thirty-minute book.
 *
 * ── How far the cutover has got ──
 *
 * The WEIGHTS are fully foundry's. Every model stage is spawned with
 * `--llama-server <ours>` and nothing else, so foundry resolves base and adapter
 * from its own catalog; the `--base-model` overrides this app used to pass for
 * `ocr` and `blocks` — pointing at the unpublished ocr and blocks checkpoints
 * — are gone, and so is the file that held them. A model this machine lacks is
 * foundry's error to raise, naming the model id and `foundry models pull`.
 *
 * The CODE cutover is not done. pdf-picker's OCR button goes to foundry and only
 * to foundry, but this app's own encoder and appliers are still in the tree —
 * `src/app/features/pdf-picker/services/blocks-encoder.ts` and the blocks
 * servers — because they still back two features foundry does not replace: the
 * picker's manual Detect panel and the Training tab's corpus building. The
 * extraction is not finished until those copies are *deleted*, because two
 * implementations of a prompt format is the failure it exists to prevent; that
 * deletion is a decision about those two features, not about this module.
 *
 * ── Resolution, and why there is no PATH lookup ──
 *
 * Two sources, in order:
 *   1. `FOUNDRY_CLI_PATH`, or the path the user set on the `foundry-cli`
 *      component (component-manager records it as an external install).
 *   2. The managed component's installed entry.
 *
 * There is deliberately no third. A `foundry` on PATH is an unknown build with
 * unknown prompt formats and an unknown Tesseract pin, and running it would
 * produce a book that is quietly worse rather than an error — which is exactly
 * the class of failure foundry itself refuses. A missing binary is an error
 * naming both places that were checked.
 *
 * ── …and what happens when neither has one ──
 *
 * `ensureFoundryPath()` DOWNLOADS it, through the same ComponentService install
 * every other component uses. `resolveFoundryPath()` and `requireFoundryPath()`
 * stay synchronous and never fetch anything: they answer "is there one here",
 * which is a question a spawn site has to be able to ask without awaiting a
 * 38 MB transfer. A pass that is about to need foundry awaits `ensureFoundryPath`
 * FIRST, so by the time `runFoundry` asks the sync question the answer is yes.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { InstallProgress } from './components/component-types';
import {
  FOUNDRY_CLI_COMPONENT_ID,
  FOUNDRY_CLI_ENV_VAR,
  FOUNDRY_CLI_VERSION,
} from './components/foundry-cli-components';

/** The artifact format versions this build of BookForge can read. */
const SUPPORTED_FORMATS = {
  run: 1,
  scanPages: 1,
  scanLines: 1,
  // v2 (Aug 3 2026): blocks.json gained the required `formation` marker when
  // para-split-v1 landed — block formation now cuts at paragraph openings, so
  // a v2 artifact's blocks are a finer grouping of the same lines than v1's.
  blocks: 2,
  ocrLines: 1,
  footnoteDeletions: 1,
  exportExclusions: 1,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

export class FoundryNotInstalledError extends Error {
  constructor(checked: string[]) {
    super(
      `The foundry CLI was not found. Checked:\n${checked.map((c) => `  ${c}`).join('\n')}\n`
      + `Set ${FOUNDRY_CLI_ENV_VAR} to the binary, or point the "Foundry CLI" `
      + `component at it in Settings → Add-ons. PATH is deliberately not searched: `
      + `an unknown foundry build carries an unknown prompt format and an unknown `
      + `Tesseract pin, and would degrade a book rather than fail.`
    );
    this.name = 'FoundryNotInstalledError';
  }
}

function usable(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return null;
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/** The foundry binary, or null. Use `requireFoundryPath` when it must exist. */
export function resolveFoundryPath(): string | null {
  const fromEnv = usable(process.env[FOUNDRY_CLI_ENV_VAR]?.trim());
  if (fromEnv) return fromEnv;

  // Covers BOTH the path a user set by hand (recorded as an external install)
  // and a managed download — one lookup, because to a caller they are the same
  // fact: this machine has a foundry, and here it is.
  //
  // Required lazily, not imported: component-manager reaches for `app` from
  // electron at module scope, and this bridge is deliberately loadable outside
  // the main process (a test, a CLI harness) — where the component registry does
  // not exist and the environment variable is the only source there can be.
  try {
    const { componentManager } =
      require('./components/component-manager') as typeof import('./components/component-manager');
    return usable(componentManager.resolveEntry(FOUNDRY_CLI_COMPONENT_ID));
  } catch {
    return null;
  }
}

export function requireFoundryPath(): string {
  const resolved = resolveFoundryPath();
  if (resolved) return resolved;
  throw new FoundryNotInstalledError([
    `$${FOUNDRY_CLI_ENV_VAR} (${process.env[FOUNDRY_CLI_ENV_VAR] || 'unset'})`,
    `the "${FOUNDRY_CLI_COMPONENT_ID}" component (Settings → Add-ons)`,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Getting one when there isn't one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one install this module will ever have running, shared by every caller.
 *
 * componentManager.install() does NOT serialize: its `inFlight` map exists for
 * cancellation, and a second call for the same id would mkdtemp a second staging
 * dir, overwrite the first's cancel handle, and race it into the same
 * `components/foundry-cli/` — two extractions renaming over each other, with the
 * loser's `dropRecord` able to land after the winner's `putRecord` and leave a
 * populated directory the manifest says nothing about. Two queued foundry passes
 * starting at once is the ordinary case, so the guard lives here: the first
 * caller starts the download and every other caller awaits the SAME promise.
 */
let foundryInstall: {
  promise: Promise<string>;
  /** Joiners' progress sinks. A run that joins still gets to draw a bar. */
  listeners: Set<(p: InstallProgress) => void>;
} | null = null;

/**
 * Tell Settings → Add-ons about an install a RUN started.
 *
 * `components:progress` is how the add-ons panel tracks a download, but the IPC
 * handler for a user-clicked install answers `event.sender` — the renderer that
 * invoked it. Nobody invoked this one, so it goes to every window instead.
 *
 * A failure here is reported and swallowed on purpose, and it is the one place
 * in this file that is: the download itself is fine, and killing a 38 MB
 * transfer because a window closed between the send and the tick would turn a
 * cosmetic problem into a failed book.
 */
function broadcastInstallProgress(p: InstallProgress): void {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('components:progress', p);
    }
  } catch (err) {
    console.warn(
      `[foundry] could not mirror install progress to the add-ons panel: ${(err as Error).message}`
    );
  }
}

async function downloadFoundry(
  listeners: Set<(p: InstallProgress) => void>,
  /** Set when a MANAGED install at this stale version is being replaced. */
  upgradeFrom?: string
): Promise<string> {
  // NOT wrapped in a try/catch, unlike the lookup in resolveFoundryPath: there,
  // "the component registry isn't loaded" legitimately means "no managed install
  // to find". Here it means the download that was asked for cannot happen, and
  // the caller has to hear that rather than get a null.
  const { componentManager } =
    require('./components/component-manager') as typeof import('./components/component-manager');

  // Detection first, download second. `getStatus` runs the component's detect
  // spec (for foundry: the env var, and nothing else) and RECORDS a hit, so a
  // machine that already has one stops here — and it also drops a record whose
  // entry has vanished, which is what makes the `status.installed` test below
  // mean "configured and present" rather than "configured at some point".
  const status = await componentManager.getStatus(FOUNDRY_CLI_COMPONENT_ID);
  if (!status) {
    throw new Error(
      `The "${FOUNDRY_CLI_COMPONENT_ID}" component is not in the component catalog, so there is `
      + 'nothing to download. This is a catalog bug in BookForge, not a missing install.'
    );
  }

  // On an upgrade both of these answer "one is already here" — about the very
  // binary being replaced — so they only guard the from-nothing install.
  if (!upgradeFrom) {
    const detected = resolveFoundryPath();
    if (detected) return detected;

    if (status.installed) {
      // Recorded, its entry exists — and it still did not resolve, so it is not a
      // runnable file. Downloading over it would overrule a path somebody chose;
      // say which one and why instead.
      throw new Error(
        `The "${FOUNDRY_CLI_COMPONENT_ID}" component points at ${status.installed.entryPath} `
        + `(recorded as an ${status.installed.source} install), but that is not a runnable file. `
        + 'Point it somewhere else or remove it in Settings → Add-ons; BookForge will not download '
        + 'over a location you chose.'
      );
    }
  }

  console.log(
    upgradeFrom
      ? `[foundry] managed install is ${upgradeFrom}; upgrading to ${FOUNDRY_CLI_VERSION}…`
      : `[foundry] no foundry on this machine; downloading ${FOUNDRY_CLI_VERSION}…`
  );
  const result = await componentManager.install(FOUNDRY_CLI_COMPONENT_ID, (p) => {
    broadcastInstallProgress(p);
    for (const listener of listeners) {
      try {
        listener(p);
      } catch {
        /* a caller's progress sink must not fail the download */
      }
    }
  });

  if (!result.ok) {
    if (!result.error) {
      throw new Error(
        `Installing the foundry CLI failed, and componentManager.install reported no reason. `
        + 'That is a contract violation in component-manager — every failure path there sets '
        + '`error` — so there is nothing to tell you about the download itself.'
      );
    }
    // result.error is component-manager's own text: the URL and HTTP status for a
    // failed fetch, both hashes for a checksum mismatch, the verify output for a
    // binary that would not run. Passed through, never summarized.
    throw new Error(`Could not download the foundry CLI ${FOUNDRY_CLI_VERSION}: ${result.error}`);
  }

  const installed = resolveFoundryPath();
  if (installed) {
    console.log(`[foundry] downloaded ${FOUNDRY_CLI_VERSION} to ${installed}`);
    return installed;
  }
  throw new Error(
    `The foundry CLI reported a successful install at ${result.record?.entryPath ?? '(no path recorded)'}, `
    + 'but no runnable binary is there afterwards. The download and its checksum passed, so this is '
    + 'the extracted layout or the file permissions, not the transfer.'
  );
}

/**
 * The foundry binary, downloading it if this machine has none.
 *
 * Awaited by every pass that is about to need foundry, BEFORE it renders a page
 * or reads a book — the same shape as the speech-to-text engine install in
 * generate-sentences-bridge, and for the same reason: the job owns the download,
 * where its progress and its failures are visible and logged, instead of the
 * picker refusing to start and telling a user to go and find a binary.
 *
 * A configured foundry is NEVER downloaded over. `FOUNDRY_CLI_PATH` that is set
 * but does not name a runnable file is an error here, not an invitation to fetch
 * one: the user said where their foundry is, and the useful answer is that it
 * isn't there — not a silent second copy that makes their setting a lie. An
 * EXTERNAL component record is the same choice made in Settings, honored at
 * whatever version it is.
 *
 * A MANAGED install is different: BookForge put it there, so BookForge keeps it
 * at the version the catalog names. When FOUNDRY_CLI_VERSION moves, the stale
 * copy is replaced HERE, on the next pass that needs foundry — the record's
 * `version` field exists precisely "to detect upgrades" (component-types.ts),
 * and without this check a catalog bump reaches only fresh machines, while
 * every machine that already installed keeps answering with the old binary
 * forever (the documented uninstall-reinstall limitation in rvc-env.ts, which
 * is livable for a 2 GiB env and wrong for a 38 MB CLI the app versions in
 * lockstep with its own foundry-run contract).
 */
export async function ensureFoundryPath(
  onProgress?: (p: InstallProgress) => void
): Promise<string> {
  const fromEnv = usable(process.env[FOUNDRY_CLI_ENV_VAR]?.trim());
  if (fromEnv) return fromEnv;

  const declared = process.env[FOUNDRY_CLI_ENV_VAR]?.trim();
  if (declared) {
    throw new Error(
      `$${FOUNDRY_CLI_ENV_VAR} is set to ${declared}, but that is not a runnable file. `
      + 'Fix it or unset it — while it is set it is the foundry BookForge uses, so no download '
      + 'will be attempted behind it.'
    );
  }

  // Loaded directly, not through resolveFoundryPath's try/catch: past this point
  // every answer needs the component registry (to read the record's source and
  // version), so a missing registry is a real error, not "nothing installed".
  const { componentManager } =
    require('./components/component-manager') as typeof import('./components/component-manager');
  const entry = usable(componentManager.resolveEntry(FOUNDRY_CLI_COMPONENT_ID));
  let staleManagedVersion: string | undefined;
  if (entry) {
    const status = await componentManager.getStatus(FOUNDRY_CLI_COMPONENT_ID);
    const record = status?.installed;
    if (record?.source !== 'managed' || record.version === FOUNDRY_CLI_VERSION) {
      return entry;
    }
    // A stale managed install. Replacing it can fail if the old exe is mid-run
    // (Windows locks a running binary) — that failure is loud and the retry is
    // the next pass, which is the right shape for an event this rare.
    staleManagedVersion = record.version;
  }

  if (foundryInstall) {
    if (onProgress) foundryInstall.listeners.add(onProgress);
    return foundryInstall.promise;
  }

  const listeners = new Set<(p: InstallProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const promise = downloadFoundry(listeners, staleManagedVersion).finally(() => {
    foundryInstall = null;
  });
  foundryInstall = { promise, listeners };
  return promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running it
// ─────────────────────────────────────────────────────────────────────────────

export interface FoundryRunOptions {
  cwd?: string;
  /** Extra environment. The parent environment is inherited. */
  env?: Record<string, string>;
  /** Called per stderr line. foundry writes progress to stderr, results to stdout. */
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** Overall ceiling. Omitted means none — a book-length convert takes as long as it takes. */
  timeoutMs?: number;
}

export interface FoundryResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run foundry and capture both streams.
 *
 * Spawned with an ARGUMENT ARRAY, never a shell string: the binary can sit under
 * `C:\Program Files\…` or `/Users/…/Application Support/…`, and interpolating
 * either into a command line hands cmd.exe `C:\Program` as the program name — a
 * perfectly good install reporting itself as missing.
 *
 * A nonzero exit is RETURNED, not thrown, because foundry's exit codes are
 * meaningful (2 = bad arguments, 1 = the run failed) and its stderr is the
 * message a user needs to see. Callers decide; `foundryVersion` throws.
 */
export function runFoundry(args: string[], opts: FoundryRunOptions = {}): Promise<FoundryResult> {
  const binary = requireFoundryPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let settled = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(() => reject(new Error(
          `foundry ${args[0] || ''} timed out after ${opts.timeoutMs}ms. Partial stderr:\n${stderr.slice(-2000)}`
        )));
      }, opts.timeoutMs)
      : null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    function onAbort(): void {
      try { child.kill(); } catch { /* already gone */ }
      finish(() => reject(new Error(`foundry ${args[0] || ''} was cancelled.`)));
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (!opts.onProgress) return;
      // Line-buffered: a progress callback fired on a half line is a UI that
      // shows half a page number.
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line.trim()) opts.onProgress(line);
    });

    child.on('error', (err) => finish(() => reject(new Error(
      `Could not run the foundry CLI at ${binary}: ${err.message}`
    ))));
    child.on('close', (code) => {
      if (pending.trim()) opts.onProgress?.(pending);
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });
  });
}

export interface FoundryVersion {
  /** The binary that answered. */
  path: string;
  /** e.g. '0.1.0'. */
  version: string;
  /** Short git commit the binary was built from, or null when none was baked in. */
  commit: string | null;
  /** The raw line, for logs. */
  raw: string;
}

/** `foundry --version`, parsed. Throws when the binary is missing or answers oddly. */
export async function foundryVersion(): Promise<FoundryVersion> {
  const binary = requireFoundryPath();
  const result = await runFoundry(['--version'], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(
      `foundry --version exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`
    );
  }
  const raw = result.stdout.trim();
  // `foundry 0.1.0 (a1b2c3d)` — the commit is optional, the version is not.
  const match = /^foundry\s+(\S+)(?:\s+\(([^)]+)\))?/.exec(raw);
  if (!match) {
    throw new Error(
      `The binary at ${binary} does not identify itself as foundry; --version said: ${raw.slice(0, 200)}`
    );
  }
  return { path: binary, version: match[1], commit: match[2] ?? null, raw };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a run directory
//
// The shapes below mirror foundry's `src/pipeline/artifacts.ts`. They are
// re-declared rather than imported because the two programs ship separately —
// but they are re-declared UNDER A VERSION CHECK, which is what makes that safe:
// every file carries `formatVersion`, and a version this build does not know is
// refused by name rather than read for the fields it recognizes. A silent
// misread of a moved field is the failure the versioning exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

export class FoundryArtifactError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'FoundryArtifactError';
  }
}

export type FoundryStageName = 'scan' | 'blocks' | 'ocr' | 'footnotes' | 'export';
export type FoundryStageStatus = 'pending' | 'running' | 'done' | 'failed';

export interface FoundryStageState {
  status: FoundryStageStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface FoundryRunFile {
  formatVersion: number;
  runId: string;
  createdAt: string;
  foundryVersion: string;
  input: { path: string; sha256: string; pages: number };
  tesseract: { version: string; binarySha256: string; tessdata: string[]; dpi: number };
  models: { base?: string; blocks?: string; ocr?: string; footnotes?: string };
  stages: Record<FoundryStageName, FoundryStageState>;
}

export interface FoundryScanPage {
  page: number;
  widthPx: number;
  heightPx: number;
  /** Straightening applied BEFORE the boxes were measured. Anything cropping the
   *  render must apply the same rotation first, or every box is off by the tilt. */
  deskewDeg: number;
  dpi: number;
}

export interface FoundryScanLine {
  id: string;
  page: number;
  /** [x0,y0,x1,y1], half-open, full-page px, deskewed. */
  bbox: [number, number, number, number];
  text: string;
  conf: number | null;
  psm?: number;
}

export interface FoundryBlock {
  id: string;
  page: number;
  bbox: [number, number, number, number];
  /** Ids into scan/lines.json, in reading order. Blocks carry no text of their own. */
  lineIds: string[];
  category: string;
  continues?: { value: boolean; confidence?: number };
  geometry: {
    firstLineIndent: number;
    gapAbove: number | null;
    prevLineShort: boolean;
    prevEndsWrapHyphen: boolean;
  };
}

export interface FoundryCalibration {
  convention: 'indent' | 'block' | 'none';
  degraded: boolean;
  bodyHeight: number;
  pitch: number;
  flushLeft: number;
  measure: number;
  bodyRight: number;
  message: string;
}

/**
 * One line after the OCR-repair stage: the text that will SHIP.
 *
 * `text` is the corrected line when the model's answer survived the per-word
 * guard and could be expressed as contract-legal edits, and the ORIGINAL line
 * otherwise — foundry never ships a rewrite it could not prove, and it records
 * why in `rejected` rather than dropping it silently. So a consumer reads
 * `text` and gets the shipped words; it does not have to know which happened.
 */
export interface FoundryOcrLine {
  id: string;
  text: string;
  edits: Array<Record<string, unknown>>;
  rejected: Array<{ before: string; why: string }>;
}

export interface FoundryFootnoteDeletion {
  blockId: string;
  applied: Array<{ before: string; after: string }>;
  rejected: number;
  text: string;
}

/**
 * Everything a run directory currently holds, with absent stages left undefined.
 *
 * `undefined` here means "that stage has not run", which the run record also
 * says — it is never a read that failed. A malformed or unreadable artifact
 * THROWS; it does not come back as a missing one.
 */
export interface FoundryRunDirectory {
  runDir: string;
  run: FoundryRunFile;
  pages?: FoundryScanPage[];
  lines?: FoundryScanLine[];
  calibration?: FoundryCalibration;
  blocks?: FoundryBlock[];
  /** Present once the ocr stage has run. One entry per scan line, same ids. */
  ocrLines?: FoundryOcrLine[];
  footnoteDeletions?: FoundryFootnoteDeletion[];
  /** The EPUB, when the export stage has produced one. */
  epubPath?: string;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new FoundryArtifactError(file, `could not be read — ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new FoundryArtifactError(file, `is not valid JSON — ${(err as Error).message}`);
  }
}

/**
 * The version gate, run before any field is touched.
 *
 * Loud on purpose, and it names the remedy: an artifact from a newer foundry is
 * a "these two are out of step" problem, and the fix is upgrading one of them,
 * not editing a number in a file.
 */
function checkedRoot(file: string, expected: number): Record<string, unknown> {
  const root = readJson(file);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new FoundryArtifactError(file, 'is not a JSON object');
  }
  const found = (root as Record<string, unknown>)['formatVersion'];
  if (found !== expected) {
    throw new FoundryArtifactError(
      file,
      `formatVersion ${JSON.stringify(found)} cannot be read by this build of BookForge, `
      + `which reads version ${expected}. The foundry binary and BookForge are out of step — `
      + `upgrade one of them. Do not hand-edit the version.`
    );
  }
  return root as Record<string, unknown>;
}

function requireArray(file: string, root: Record<string, unknown>, key: string): unknown[] {
  const value = root[key];
  if (!Array.isArray(value)) {
    throw new FoundryArtifactError(file, `"${key}" must be an array`);
  }
  return value;
}

/**
 * Read a foundry run directory.
 *
 * `run.json` is required — without it this is not a run directory, and saying so
 * is more useful than an empty result. Every other artifact is read if present,
 * because a run directory is legitimately partial: that is the whole point of a
 * pipeline whose stages are separately runnable.
 */
export function readRunDirectory(runDir: string): FoundryRunDirectory {
  const runFile = path.join(runDir, 'run.json');
  if (!fs.existsSync(runFile)) {
    throw new FoundryArtifactError(
      runFile,
      `not found — ${runDir} is not a foundry run directory (run.json is written by \`foundry scan\`)`
    );
  }
  const run = checkedRoot(runFile, SUPPORTED_FORMATS.run) as unknown as FoundryRunFile;

  const out: FoundryRunDirectory = { runDir, run };

  const pagesFile = path.join(runDir, 'scan', 'pages.json');
  if (fs.existsSync(pagesFile)) {
    const root = checkedRoot(pagesFile, SUPPORTED_FORMATS.scanPages);
    out.pages = requireArray(pagesFile, root, 'pages') as FoundryScanPage[];
  }

  const linesFile = path.join(runDir, 'scan', 'lines.json');
  if (fs.existsSync(linesFile)) {
    const root = checkedRoot(linesFile, SUPPORTED_FORMATS.scanLines);
    out.lines = requireArray(linesFile, root, 'lines') as FoundryScanLine[];
  }

  const blocksFile = path.join(runDir, 'blocks', 'blocks.json');
  if (fs.existsSync(blocksFile)) {
    const root = checkedRoot(blocksFile, SUPPORTED_FORMATS.blocks);
    out.blocks = requireArray(blocksFile, root, 'blocks') as FoundryBlock[];
    out.calibration = root['calibration'] as FoundryCalibration;
  }

  const ocrFile = path.join(runDir, 'ocr', 'lines.json');
  if (fs.existsSync(ocrFile)) {
    const root = checkedRoot(ocrFile, SUPPORTED_FORMATS.ocrLines);
    out.ocrLines = requireArray(ocrFile, root, 'lines') as FoundryOcrLine[];
  }

  const deletionsFile = path.join(runDir, 'footnotes', 'deletions.json');
  if (fs.existsSync(deletionsFile)) {
    const root = checkedRoot(deletionsFile, SUPPORTED_FORMATS.footnoteDeletions);
    out.footnoteDeletions = requireArray(deletionsFile, root, 'blocks') as FoundryFootnoteDeletion[];
  }

  const epub = path.join(runDir, 'export', 'book.epub');
  if (fs.existsSync(epub)) out.epubPath = epub;

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// `foundry footnotes --epub` — the review report
//
// The EPUB reading of the footnotes stage produces no run directory: it takes a
// finished book and writes an edited copy plus ONE report file, named by
// `--report`. The shape below mirrors foundry's `EpubFootnotesReport`
// (src/epub/footnotes-stage.ts), narrowed to what BookForge reads.
//
// It carries no `formatVersion` — it is a review document rather than a
// pipeline artifact — so the gate here is structural: the fields this app acts
// on must be present and the right type, or the file is refused by name. A
// report that cannot be read is a failed pass, never a pass with no findings.
// ─────────────────────────────────────────────────────────────────────────────

/** One deletion foundry actually made, with the text around it. */
export interface FoundryEpubFootnoteApplied {
  /** Archive path of the document it happened in. */
  document: string;
  /** The characters removed. */
  removed: string;
  /** `…anchor [REMOVED: "1"] following…`, whitespace collapsed. */
  context: string;
  /** The model's anchor, verbatim: with the marker, and without it. */
  before: string;
  after: string;
}

export interface FoundryEpubFootnotesReport {
  epub: string;
  output: string | null;
  dryRun: boolean;
  model: string;
  askEverything: boolean;
  totals: {
    documents: number;
    documentsEdited: number;
    units: number;
    unitsAsked: number;
    unitsFired: number;
    deletionsApplied: number;
    deletionsRejected: number;
    elementsRemoved: number;
  };
  documents: Array<{ path: string; edited: boolean; indexDocument: boolean }>;
  applied: FoundryEpubFootnoteApplied[];
  rejected: Array<{ document: string; before: string; after: string; reason: string }>;
}

export function readEpubFootnotesReport(file: string): FoundryEpubFootnotesReport {
  const root = readJson(file);
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new FoundryArtifactError(file, 'is not a JSON object');
  }
  const report = root as Record<string, unknown>;
  if (typeof report['totals'] !== 'object' || report['totals'] === null) {
    throw new FoundryArtifactError(
      file,
      'has no "totals" — this is not a `foundry footnotes --epub` report, or foundry and '
      + 'BookForge are out of step'
    );
  }
  for (const key of ['applied', 'rejected', 'documents']) {
    if (!Array.isArray(report[key])) {
      throw new FoundryArtifactError(file, `"${key}" must be an array`);
    }
  }
  return report as unknown as FoundryEpubFootnotesReport;
}

/**
 * The text of a block, joined from the lines it was formed out of.
 *
 * Blocks deliberately carry no text: the words live in `scan/lines.json`, and a
 * block holding its own copy would be a second source of truth for what the book
 * says. Every consumer joins, so the join lives here once.
 */
export function foundryBlockText(block: FoundryBlock, lines: readonly FoundryScanLine[]): string {
  const byId = new Map(lines.map((l) => [l.id, l]));
  return block.lineIds.map((id) => {
    const line = byId.get(id);
    if (!line) {
      throw new FoundryArtifactError(
        'blocks/blocks.json',
        `block ${block.id} references line ${id}, which is not in scan/lines.json — the artifacts are out of step`
      );
    }
    return line.text;
  }).join('\n');
}
