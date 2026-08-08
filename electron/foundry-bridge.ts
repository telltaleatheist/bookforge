/**
 * foundry-bridge — how BookForge talks to the `foundry` CLI.
 *
 * Foundry (github.com/telltaleatheist/foundry) is a standalone document
 * pipeline. BookForge drives it as a SUBPROCESS, the same way it drives
 * ebook2audiobook, and reads what it produces off disk.
 *
 * This module is the TRANSPORT and nothing else: resolve the binary, download it
 * if this machine has none, spawn it, report its lines, hand back its exit code.
 * It has no opinion about what is being run.
 *
 * ── What is run ──
 *
 * One thing: `foundry vlm-convert` (electron/vlm-convert.ts), which hands each
 * page picture to a document vision model and assembles the answers into an
 * EPUB. That is the whole of BookForge's use of foundry.
 *
 * It used to be more. A run-directory pipeline — Tesseract scan, block
 * labelling, OCR repair, footnote removal, reflow — wrote versioned JSON
 * artifacts into a run directory, and this module carried the typed readers for
 * every one of them. All of it went in Aug 2026 when `vlm-convert` became the
 * only PDF→EPUB conversion, and the readers went with it: there is no run
 * directory left to read.
 *
 * The WEIGHTS are foundry's and always were. A model stage is spawned with
 * `--llama-server <ours>` and nothing else, so foundry resolves base and adapter
 * from its own catalog. A model this machine lacks is foundry's error to raise,
 * naming the model id and `foundry models pull`.
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
  effectiveFoundryVersion,
} from './components/foundry-cli-components';
import { planUpgrade } from './components/component-upgrades';

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

  const wanted = effectiveFoundryVersion();
  console.log(
    upgradeFrom
      ? `[foundry] managed install is ${upgradeFrom}; upgrading to ${wanted}…`
      : `[foundry] no foundry on this machine; downloading ${wanted}…`
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
    throw new Error(`Could not download the foundry CLI ${wanted}: ${result.error}`);
  }

  const installed = resolveFoundryPath();
  if (installed) {
    console.log(`[foundry] downloaded ${wanted} to ${installed}`);
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
 * at the version the catalog names. When the wanted version moves, the stale
 * copy is replaced HERE, on the next pass that needs foundry — the record's
 * `version` field exists precisely "to detect upgrades" (component-types.ts),
 * and without this check a catalog bump reaches only fresh machines, while
 * every machine that already installed keeps answering with the old binary
 * forever (the documented uninstall-reinstall limitation in rvc-env.ts, which
 * is livable for a 2 GiB env and wrong for a 38 MB CLI the app versions in
 * lockstep with its own document-stage contract).
 *
 * That verdict is now `planUpgrade` (electron/components/component-upgrades.ts),
 * the same pure rule the startup sweep applies to every component — so the two
 * cannot come to different conclusions about this one. It also decides against
 * two cases the old inline `record.version !== FOUNDRY_CLI_VERSION` got wrong:
 * a version DISCOVERED on GitHub is what `effectiveFoundryVersion()` names, and
 * an installed copy newer than the wanted one is left alone (a launch that
 * starts offline can only see the pin, and must not drag a newer install back).
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

  // NOTHING is checked for here. Which foundry should be on this machine is
  // decided ONCE, by the startup sweep (electron/components/startup-upgrade-check.ts),
  // and this function only acts on what that decided.
  //
  // Owen, 2026-08-08: "make sure it only downloads the latest version on
  // bookforge startup, not while its running." This briefly did ask GitHub on
  // every pass, so a release published mid-session was picked up without a
  // restart. That is the wrong trade. A pass that needs foundry is a pass about
  // to RUN it, and swapping the binary underneath a session means the run that
  // starts is not the one whose version was reported — worse on Windows, where
  // replacing a running .exe fails outright and the failure lands on whichever
  // book happened to be converting. A version that changes only at launch is a
  // version that holds still for as long as anyone is working.

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
    const verdict = planUpgrade({
      id: FOUNDRY_CLI_COMPONENT_ID,
      name: status?.component.name ?? FOUNDRY_CLI_COMPONENT_ID,
      // A tool, so rule 0 lets it through to the version rules. Stated rather
      // than read off `status?.component` so this candidate cannot silently
      // become content and stop upgrading — the CLI at the wrong version is the
      // one case where a mismatch actually breaks the pipeline.
      kind: 'foundry-cli',
      targetVersion: effectiveFoundryVersion(),
      supportsManaged: true,
      installed: record ? { source: record.source, version: record.version } : null,
      // $FOUNDRY_CLI_PATH was already handled (and rejected) above; reaching here
      // means it is unset, so nothing pins this to a build of the user's own.
      envPinned: false,
      // Always false HERE. The startup sweep uses this flag to stay out of the
      // way of an install it did not start; this function is the other side of
      // that — it must reach the shared-promise join below, where a concurrent
      // install is awaited rather than raced or answered with the stale binary.
      installing: false,
    });
    if (verdict.verdict === 'keep') {
      return entry;
    }
    // A stale managed install. Replacing it can fail if the old exe is mid-run
    // (Windows locks a running binary) — that failure is loud and the retry is
    // the next pass, which is the right shape for an event this rare.
    staleManagedVersion = verdict.fromVersion ?? undefined;
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
