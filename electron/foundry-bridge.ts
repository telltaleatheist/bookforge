/**
 * foundry-bridge — how BookForge talks to the `foundry` CLI.
 *
 * Foundry (github.com/telltaleatheist/foundry) is a standalone document
 * pipeline. BookForge drives it as a SUBPROCESS, the same way it drives
 * ebook2audiobook, and reads what it produces off disk.
 *
 * This module is the TRANSPORT and nothing else: resolve the engine, spawn it,
 * report its lines, hand back its exit code.
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
 * directory left to read. Foundry then dropped the same pipeline from its own
 * side (`pre-vlm-strip` is its last build that had it), so the two agree: one
 * command, plus `doctor`, plus `--version`.
 *
 * Nothing is LENT to it any more. A model stage used to be spawned with
 * `--llama-server <ours>` — BookForge's own llama.cpp — while foundry resolved
 * base and adapter from its catalog. There are no model stages, foundry drives
 * no llama.cpp, and the flag no longer exists. Where the vision model runs is
 * decided by the conversion's route (electron/vlm-endpoint.ts) and passed as
 * `--vlm-endpoint`, or left to MLX on an Apple Silicon Mac.
 *
 * ── Which program: the engine vendored with foundry-app (2026-09-24) ──
 *
 * The engine is not a downloaded executable any more. Owen: *"foundry.exe — this
 * was intended to be a model runner originally. i dont think it needs to be an
 * exe anymore. it can be an engine but maybe we should explode it out into
 * normal code that moves along with the app."* Foundry bundles its engine into
 * its app folder (`app/engine/foundry-engine.cjs`, Foundry's
 * tools/build-engine.mjs), and BookForge vendors that folder as `foundry-app/` —
 * so the engine BookForge runs is the one beside the Foundry code it hosts, by
 * construction. There is no `foundry-cli` add-on, no release check, no download,
 * and no version gate: the gates existed only because a separately downloaded
 * engine could be older than the app driving it, and one copy cannot disagree
 * with itself.
 *
 * Two answers, in order — the same two the hosted Foundry's own
 * `engineCommand()` gives (foundry-app/electron/engine.ts), so the two doors
 * always run the same engine:
 *   1. `FOUNDRY_BIN` — a developer pointing at a build of their own. A command,
 *      run with the job's arguments and nothing in front of them.
 *   2. The vendored bundle, run by THIS process's own runtime as Node:
 *      `process.execPath` with `ELECTRON_RUN_AS_NODE=1` inside the app (the
 *      variable is inert under plain node, which is what the CLI harnesses in
 *      cli/ run on).
 *
 * There is deliberately no third. A `foundry` on PATH is an unknown build, and
 * running it would produce a book that is quietly worse rather than an error.
 * A missing bundle is a broken checkout or package, refused by name.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// The one owner of the endpoint header map, and of removing it. See the
// comment at the spawn in `runFoundry`.
import { stripEndpointHeaders } from './crucible/text-acts';

// ─────────────────────────────────────────────────────────────────────────────
// Which program
// ─────────────────────────────────────────────────────────────────────────────

export interface FoundryEngineCommand {
  command: string;
  /** Fixed leading arguments: the bundle's path, or none for FOUNDRY_BIN. */
  args: string[];
  /** Added to every run's environment: `ELECTRON_RUN_AS_NODE` for the bundle. */
  env: Readonly<Record<string, string>>;
  /** Why this one — `FOUNDRY_BIN` or `vendored engine`. */
  source: string;
}

/**
 * `foundry-app/engine/foundry-engine.cjs`, from this module's compiled home:
 * dist/electron -> dist -> the repo (or app.asar, packaged — the `files` list
 * in package.json carries `foundry-app/engine/**`).
 */
export function foundryEngineBundlePath(): string {
  return path.resolve(__dirname, '..', '..', 'foundry-app', 'engine', 'foundry-engine.cjs');
}

export function foundryEngineCommand(): FoundryEngineCommand {
  const declared = process.env['FOUNDRY_BIN']?.trim();
  if (declared) return { command: declared, args: [], env: {}, source: 'FOUNDRY_BIN' };

  const bundle = foundryEngineBundlePath();
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `The Foundry engine is missing: ${bundle} does not exist. It is vendored with `
      + 'foundry-app/ (foundry-app/VENDORED.md), so this checkout or package is incomplete.'
    );
  }
  return {
    command: process.execPath,
    args: [bundle],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    source: 'vendored engine',
  };
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
 * Spawned with an ARGUMENT ARRAY, never a shell string: the engine can sit under
 * `C:\Program Files\…` or `/Users/…/Application Support/…`, and interpolating
 * either into a command line hands cmd.exe `C:\Program` as the program name — a
 * perfectly good install reporting itself as missing.
 *
 * A nonzero exit is RETURNED, not thrown, because foundry's exit codes are
 * meaningful (2 = bad arguments, 1 = the run failed) and its stderr is the
 * message a user needs to see. Callers decide; `foundryVersion` throws.
 */
export function runFoundry(args: string[], opts: FoundryRunOptions = {}): Promise<FoundryResult> {
  const engine = foundryEngineCommand();
  return new Promise((resolve, reject) => {
    /*
     * ── THE CREDENTIAL IS OPT-IN PER SPAWN, NEVER INHERITED ──────────────────
     *
     * `FOUNDRY_ENDPOINT_HEADERS` carries a bearer token (crucible
     * `docs/PHASE7-LANES.md` §7.1(B)), and the contract's rule is that it is
     * *"stripped from the environment of any child that does not need it"*.
     * The hosted Foundry window can put one on THIS process's environment for
     * the duration of an act — it spawns the engine with `env: process.env` and
     * takes no overlay, so there is nowhere else to put it
     * (`electron/crucible/text-acts.ts`, `withHostedEndpointHeaders`) — and
     * every child spawned through this door during that window would otherwise
     * inherit it.
     *
     * So it is removed first and added back only by a caller that passed one.
     * A mechanical fix at the one door rather than a rule somebody has to
     * remember at each call site.
     */
    const inherited = stripEndpointHeaders(process.env);
    const child = spawn(engine.command, [...engine.args, ...args], {
      cwd: opts.cwd,
      env: { ...inherited, ...engine.env, ...(opts.env || {}) },
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
      `Could not run the Foundry engine (${engine.source}: ${[engine.command, ...engine.args].join(' ')}): ${err.message}`
    ))));
    child.on('close', (code) => {
      if (pending.trim()) opts.onProgress?.(pending);
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });
  });
}

export interface FoundryVersion {
  /** The engine that answered: the bundle's path, or FOUNDRY_BIN's command. */
  path: string;
  /** e.g. '0.1.0'. */
  version: string;
  /** The build stamp in parentheses — `src <digest>` for the bundle — or null when none was baked in. */
  commit: string | null;
  /** The raw line, for logs. */
  raw: string;
}

/** `foundry --version`, parsed. Throws when the engine is missing or answers oddly. */
export async function foundryVersion(): Promise<FoundryVersion> {
  const engine = foundryEngineCommand();
  const binary = engine.args[0] ?? engine.command;
  const result = await runFoundry(['--version'], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(
      `foundry --version exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`
    );
  }
  const raw = result.stdout.trim();
  // `foundry 2.0.2 (src 1a2b3c4d5e6f)` — the stamp is optional, the version is not.
  const match = /^foundry\s+(\S+)(?:\s+\(([^)]+)\))?/.exec(raw);
  if (!match) {
    throw new Error(
      `The engine at ${binary} does not identify itself as foundry; --version said: ${raw.slice(0, 200)}`
    );
  }
  return { path: binary, version: match[1], commit: match[2] ?? null, raw };
}
