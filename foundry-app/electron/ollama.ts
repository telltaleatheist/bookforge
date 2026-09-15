/**
 * ollama — look for it, and list what it holds. Nothing else.
 *
 * ── FOUNDRY DOES NOT MANAGE OLLAMA, AND IT NO LONGER USES IT EITHER ─────────
 *
 * This file used to do three things: detect ollama, fetch its official
 * installer and hand it to the OS, and stream `POST /api/pull` into a progress
 * bar for the first-run wizard. Two of the three are gone, with the wizard step
 * that asked for them — Owen, 2026-09-15: *"we dont have any local models.
 * crucible handles all model orchestration. if theres no connected crucible
 * server then tiles should be disabled."* Foundry pulls no models, so it has no
 * standing to install the thing that pulls them.
 *
 * ── WHAT THE PROBE IS STILL FOR ─────────────────────────────────────────────
 *
 * ONE READER: the "Models on this machine" inventory (machine-models.ts,
 * docs/SLOTS.md §5b), whose whole purpose is that *"duplication is seen rather
 * than discovered from a full disk"*. Somebody who pulled a 27B into Ollama
 * before any of this, or who runs an Ollama for something else entirely, has
 * twenty gigabytes on their disk and is entitled to see it counted. That is a
 * statement about the disk and not about where work runs.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { OllamaFacts, OllamaHolding } from '../shared/types';

/** Long enough for a server that is loading a model; short enough not to hang a screen. */
const PROBE_MS = 4_000;

// ─────────────────────────────────────────────────────────────────────────────
// Is it here?
// ─────────────────────────────────────────────────────────────────────────────

async function ask(url: string, timeoutMs = PROBE_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is there an `ollama` on this machine even though nothing is listening?
 *
 * A REAL AND COMMON STATE, and the reason it is asked separately: on Windows
 * the installer puts ollama in the user's own application data and starts it,
 * but a machine that has been rebooted without the tray app running answers
 * nothing on 11434 while being fully installed. An inventory that called that
 * machine "no ollama here" would be the app failing to look.
 *
 * The known paths are tried BEFORE the PATH probe because spawning is the
 * expensive half and because a Windows PATH is not refreshed inside a process
 * that was launched before the installer ran.
 */
async function binaryPresent(platform: NodeJS.Platform): Promise<boolean> {
  const home = os.homedir();
  const known = platform === 'win32'
    ? [
      path.join(process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    ]
    : platform === 'darwin'
      ? ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
      : ['/usr/local/bin/ollama', '/usr/bin/ollama'];

  for (const candidate of known) {
    try {
      if (fs.existsSync(candidate)) return true;
    } catch { /* an unreadable path is a no */ }
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('ollama', ['--version'], { windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(false);
    }, PROBE_MS);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Is it here, is it answering, and what does it hold — in one answer.
 *
 * Never throws and never caches: what an Ollama holds changes while this app is
 * open, in another window, and the inventory is worth nothing if it is showing
 * what was true when the app started.
 */
export async function probeOllama(url: string): Promise<OllamaFacts> {
  const base = url.replace(/\/+$/, '');
  const [version, tags] = await Promise.all([
    ask(`${base}/api/version`),
    ask(`${base}/api/tags`),
  ]);

  const versionText = typeof version === 'object' && version !== null
    && typeof (version as { version?: unknown }).version === 'string'
    ? (version as { version: string }).version
    : null;

  /*
   * `/api/tags` REPORTS A SIZE PER MODEL, and it is read here because this is
   * the only moment anything asks ollama what it holds. The settings inventory
   * (SLOTS.md §5b) prints those bytes so that three copies of a 27B in three
   * stores are SEEN rather than discovered from a full disk; a missing or
   * unreadable `size` is a null and the row says so, never a zero, because "this
   * model costs nothing" is the one thing it certainly does not mean.
   */
  const models: string[] = [];
  const holdings: OllamaHolding[] = [];
  if (typeof tags === 'object' && tags !== null && Array.isArray((tags as { models?: unknown }).models)) {
    for (const entry of (tags as { models: unknown[] }).models) {
      if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
        const name = (entry as { name: string }).name;
        const size = (entry as { size?: unknown }).size;
        models.push(name);
        holdings.push({ name, bytes: typeof size === 'number' && size > 0 ? size : null });
      }
    }
  }

  if (version !== null) {
    const named = versionText === null ? 'Ollama' : `Ollama ${versionText}`;
    const holds = models.length === 0
      ? 'with no models pulled yet'
      : `and holds ${models.length} model${models.length === 1 ? '' : 's'}`;
    return {
      running: true,
      version: versionText,
      // A server that is answering IS installed. The binary probe below exists
      // only for the machine where nothing is listening, and running it here
      // would be spawning a process to learn something already known.
      installed: true,
      models,
      holdings,
      url: base,
      detail: `${named} is running at ${base} ${holds}.`,
    };
  }

  const installed = await binaryPresent(process.platform);
  return {
    running: false,
    version: null,
    installed,
    models: [],
    holdings: [],
    url: base,
    /*
     * NEITHER SENTENCE ASKS FOR ANYTHING NOW, and that is the change rather than
     * a softening. They said "Start it… and check again" and "it has to be here",
     * which were instructions to somebody the wizard was about to ask for a
     * download. Foundry pulls no models and runs none, so an absent Ollama costs
     * nothing and there is nothing to go and do; the only surface that reads this
     * is a disk inventory, where the honest sentence is that there is nothing of
     * Ollama's here to count.
     */
    detail: installed
      ? `Ollama is installed on this machine but nothing is answering at ${base}, so what it holds cannot be counted here.`
      : `Nothing is answering at ${base} and no ollama was found on this machine. Nothing in Foundry needs one — the text work runs on a connected GPU engine.`,
  };
}
