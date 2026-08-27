/**
 * ollama — detect it, help install it, and pull one model with a bar on screen.
 *
 * ── FOUNDRY DOES NOT MANAGE OLLAMA, AND THIS FILE DOES NOT CHANGE THAT ───────
 *
 * job-queue.ts says it plainly where it composes `--ollama`: *"Ollama is a
 * server this app never starts, stops or configures, so there is nothing here
 * to contradict."* Nothing below starts it, stops it, edits its configuration
 * or decides where its models live. What is new is only the FIRST-RUN help:
 * a person who has just installed foundry and has never heard of ollama needs
 * to be told there is a thing to install, handed the official installer, and
 * then asked which model to pull. After that this file's job is over and every
 * run goes through the URL exactly as before.
 *
 * ── THE INSTALLER IS FETCHED AND HANDED OVER, NEVER RUN SILENTLY ─────────────
 *
 * `shell.openPath` on the downloaded file, so the user lands in ollama's own
 * install screen with its own licence, its own destination choice and its own
 * elevation prompt. An app that ran a third-party installer unattended would be
 * making a decision about somebody else's computer that it has no standing to
 * make, and would swallow every question that installer wanted to ask.
 *
 * WHICH MEANS THERE IS NO "DONE" TO REPORT. The install finishes outside this
 * process, minutes later, in a window this app does not own. So nothing here
 * claims success: the wizard re-probes when the user comes back to the step,
 * and the probe is the only thing that ever says ollama is present.
 *
 * ── THE URLS ARE ONE CONST, AND THEY ARE THE VENDOR'S OWN ALIASES ────────────
 *
 * `ollama.com/download/OllamaSetup.exe` and `ollama.com/download/Ollama.dmg`
 * are the hrefs behind the download buttons on ollama.com — stable aliases that
 * redirect to whatever the current release is, which is why they are not
 * version-pinned. Verified 2026-08-26.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { shell } from 'electron';

import { AbortedError, fetchToFile, isAborted } from './env-downloader';
import type {
  OllamaFacts,
  OllamaInstallResult,
  OllamaPullProgress,
} from '../shared/types';

/** ★ THE DOWNLOAD ★ — the vendor's own button hrefs, one per platform. */
export const OLLAMA_INSTALLER: Partial<Record<NodeJS.Platform, { url: string; file: string; note: string }>> = {
  win32: {
    url: 'https://ollama.com/download/OllamaSetup.exe',
    file: 'OllamaSetup.exe',
    note: 'Ollama\'s installer will open in its own window. Follow it through, then come back here.',
  },
  darwin: {
    url: 'https://ollama.com/download/Ollama.dmg',
    file: 'Ollama.dmg',
    note: 'The disk image will open. Drag Ollama into Applications and launch it once, then come back here.',
  },
};

/** Long enough for a server that is loading a model; short enough not to hang a screen. */
const PROBE_MS = 4_000;
/** A pull can be an hour on a slow line; the deadline is on SILENCE, not on the pull. */
const PULL_SILENCE_MS = 5 * 60_000;

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
 * nothing on 11434 while being fully installed. Offering that person a second
 * install would be the app failing to look.
 *
 * The known paths are tried BEFORE the PATH probe because spawning is the
 * expensive half and because a Windows PATH is not refreshed inside a process
 * that was launched before the installer ran — which is exactly the process
 * asking this question during setup.
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
 * Everything the wizard needs to know about ollama, in one answer.
 *
 * Never throws and never caches: unlike the hardware, this changes while the
 * app is open — that is the entire shape of the flow, where somebody installs
 * ollama in another window and comes back.
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

  const models: string[] = [];
  if (typeof tags === 'object' && tags !== null && Array.isArray((tags as { models?: unknown }).models)) {
    for (const entry of (tags as { models: unknown[] }).models) {
      if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
        models.push((entry as { name: string }).name);
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
    url: base,
    detail: installed
      ? `Ollama is installed on this machine but nothing is answering at ${base}. Start it — on Windows and macOS it runs from the menu bar or system tray — and check again.`
      : `Nothing is answering at ${base} and no ollama was found on this machine. Translation, simplification and analysis all speak to it, so it has to be here.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Getting it
// ─────────────────────────────────────────────────────────────────────────────

let installerAbort: AbortController | null = null;

/**
 * Fetch the official installer and hand it to the operating system.
 *
 * The temp file is NOT cleaned up, deliberately: the installer is still running
 * when this returns, out of this process's sight, and deleting the file out
 * from under it is the one way to turn a working install into a mysterious one.
 * The OS's own temp sweep is what removes it, on its own schedule.
 */
export async function installOllama(
  onProgress: (progress: OllamaPullProgress) => void,
): Promise<OllamaInstallResult> {
  const spec = OLLAMA_INSTALLER[process.platform];
  if (!spec) {
    return {
      ok: false,
      path: null,
      detail: `There is no ollama installer for ${process.platform} here. Install it the way this platform installs things, then press Check again.`,
    };
  }

  if (installerAbort) {
    return { ok: false, path: null, detail: 'The installer is already downloading.' };
  }
  const controller = new AbortController();
  installerAbort = controller;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ollama-'));
  const dest = path.join(dir, spec.file);

  try {
    onProgress({ tag: 'ollama', phase: 'download', percent: 0, detail: `Fetching ${spec.file} from ollama.com…` });
    await fetchToFile(
      spec.url,
      dest,
      (received, total) => {
        const percent = total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        const mb = (received / 1e6).toFixed(0);
        onProgress({
          tag: 'ollama',
          phase: 'download',
          percent,
          detail: total && total > 0
            ? `${mb} MB of ${(total / 1e6).toFixed(0)} MB`
            : `${mb} MB`,
        });
      },
      controller.signal,
    );

    onProgress({ tag: 'ollama', phase: 'write', percent: 100, detail: 'Opening the installer…' });
    const failure = await shell.openPath(dest);
    if (failure) {
      return {
        ok: false,
        path: dest,
        detail: `The installer downloaded to ${dest} but this machine would not open it: ${failure}. Open it by hand.`,
      };
    }

    onProgress({ tag: 'ollama', phase: 'done', percent: 100, detail: spec.note });
    return { ok: true, path: dest, detail: spec.note };
  } catch (err) {
    const detail = isAborted(err)
      ? 'Cancelled.'
      : `The ollama installer could not be fetched: ${err instanceof Error ? err.message : String(err)}`;
    onProgress({ tag: 'ollama', phase: 'error', percent: 0, detail });
    return { ok: false, path: null, detail };
  } finally {
    installerAbort = null;
  }
}

export function cancelOllamaInstall(): void {
  installerAbort?.abort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Pulling a model
// ─────────────────────────────────────────────────────────────────────────────

let pullAbort: AbortController | null = null;

/**
 * `POST /api/pull`, streamed, turned into a bar.
 *
 * ── THE PERCENTAGE IS ONE LAYER'S, AND THE BAR SAYS SO ──────────────────────
 *
 * ollama reports `completed` and `total` PER LAYER, and a model is several
 * layers of wildly different sizes. Summing them is not available — the totals
 * arrive as each layer starts, so an early sum is a denominator that keeps
 * growing and a bar that goes backwards. What is drawn instead is the current
 * layer's progress with the layer's own size beside it, which is honest about
 * what it is measuring; the DETAIL line carries ollama's own status word, which
 * is what actually tells somebody whether anything is happening.
 *
 * ── A DEADLINE ON SILENCE, NOT ON THE PULL ──────────────────────────────────
 *
 * Eighty-one gigabytes on a domestic line is most of a day and is not a
 * failure. Five minutes with nothing on the socket is. The timer is re-armed by
 * every line that arrives, so it measures the thing that actually indicates a
 * dead transfer.
 */
export async function pullModel(
  tag: string,
  url: string,
  onProgress: (progress: OllamaPullProgress) => void,
): Promise<{ ok: boolean; detail: string }> {
  if (pullAbort) {
    return { ok: false, detail: 'Another model is already being pulled. Wait for it, or cancel it first.' };
  }
  const controller = new AbortController();
  pullAbort = controller;

  const base = url.replace(/\/+$/, '');
  let silence = setTimeout(() => controller.abort(), PULL_SILENCE_MS);
  const heard = (): void => {
    clearTimeout(silence);
    silence = setTimeout(() => controller.abort(), PULL_SILENCE_MS);
  };

  try {
    onProgress({ tag, phase: 'download', percent: 0, detail: `Asking ollama for ${tag}…` });
    const response = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: tag, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = `Ollama answered HTTP ${response.status} when asked to pull ${tag}.`;
      onProgress({ tag, phase: 'error', percent: 0, detail });
      return { ok: false, detail };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let lastError: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      heard();
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const text = line.trim();
        if (text.length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // A line that is not JSON is not a reason to abandon a download that
          // is otherwise working; the status line is cosmetic.
          continue;
        }
        if (typeof message['error'] === 'string') {
          lastError = message['error'];
          continue;
        }
        const status = typeof message['status'] === 'string' ? message['status'] : '';
        const completed = typeof message['completed'] === 'number' ? message['completed'] : null;
        const total = typeof message['total'] === 'number' ? message['total'] : null;
        const percent = completed !== null && total !== null && total > 0
          ? Math.min(100, Math.round((completed / total) * 100))
          : 0;
        const phase: OllamaPullProgress['phase'] = /verif/i.test(status)
          ? 'verify'
          : /writ|manifest|success/i.test(status)
            ? 'write'
            : 'download';
        const size = completed !== null && total !== null
          ? ` — ${(completed / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB in this layer`
          : '';
        onProgress({ tag, phase, percent, detail: `${status || 'working'}${size}` });
      }
    }

    if (lastError !== null) {
      const detail = `Ollama refused to pull ${tag}: ${lastError}`;
      onProgress({ tag, phase: 'error', percent: 0, detail });
      return { ok: false, detail };
    }

    onProgress({ tag, phase: 'done', percent: 100, detail: `${tag} is on this machine.` });
    return { ok: true, detail: `${tag} is on this machine.` };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const detail = aborted
      ? `The pull of ${tag} stopped. If it was not cancelled, ollama went quiet for five minutes — check that it is still running.`
      : `The pull of ${tag} failed: ${err instanceof Error ? err.message : String(err)}`;
    onProgress({ tag, phase: 'error', percent: 0, detail });
    return { ok: false, detail };
  } finally {
    clearTimeout(silence);
    pullAbort = null;
  }
}

export function cancelPull(): void {
  pullAbort?.abort();
}

/** So the module's own abort type is not a stranger to callers that catch it. */
export { AbortedError };
