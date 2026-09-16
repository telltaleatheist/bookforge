/**
 * IS THERE A CRUCIBLE ON THIS COMPUTER, IS IT UP, AND WHAT STARTS IT.
 *
 * -- The three states an app has to tell apart ------------------------------
 *
 * Owen, 2026-09-15: *"there should be a startup check for crucible. if theres
 * nothing running but it does exist on the system, it asks the user if they
 * want to start it."* That is THREE states, and only the middle one is a
 * question worth asking:
 *
 *   running   something answers on the address this machine's own config names.
 *   stopped   the config (or a pairing file) is here and nothing answers. THIS
 *             is the offer.
 *   absent    no Crucible on this computer at all. Offering to "start" it would
 *             offer to start something that does not exist; that state wants an
 *             INSTALL, which is a different door and a different sentence.
 *
 * -- AN APP NEVER STARTS AN ENGINE. IT STARTS THE TRAY ----------------------
 *
 * The tray owns the engine; that is its whole job on Windows, in its own help:
 * it "boots this machine's engine at login, claims it, watches it, restarts
 * it". So this launches the TRAY and waits for the engine, rather than reaching
 * for the engine itself.
 *
 * That matters most on Windows, where the engine lives in WSL and starting it
 * is not obvious: `crucible/host/presence.py` runs `systemctl --user start`
 * inside the distro with XDG_RUNTIME_DIR set explicitly, and the comment there
 * records why -- a `wsl.exe --exec` session gets no logind seat, so systemctl
 * cannot find the bus without it, and a missing variable and a missing socket
 * print the identical error. Re-deriving that here would be a second owner of a
 * fact that was measured once and is easy to get subtly wrong.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CrucibleDiscoveryError, discoverCrucible, processDiscoveryHost } from './discovery';
import type { DiscoveredCrucible } from './discovery';

export type EnginePresence =
  | { readonly state: 'running'; readonly where: string; readonly name: string }
  | { readonly state: 'stopped'; readonly where: string; readonly name: string; readonly because: string }
  | { readonly state: 'absent'; readonly detail: string };

/** How long a presence ping may take. Short: this runs while a window opens. */
const PING_MS = 2500;

/**
 * Ask the address this machine's config names whether anything is there.
 *
 * `/v1/ping` UNAUTHENTICATED and on purpose: the question is "is a server
 * there", not "may I use it". A stale token is a different problem with a
 * different remedy, and answering `stopped` for it would offer to start
 * something that is already running.
 */
async function answers(url: string): Promise<{ ok: true } | { ok: false; because: string }> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), PING_MS);
  try {
    /*
     * NO HEADERS AT ALL, AND THE API VERSION LEAST OF ALL.
     *
     * The question is "is something alive here", not "can I speak to it". A
     * server running an API version this build does not know is still a server
     * that is RUNNING, and announcing a version turns the first version skew
     * into a `stopped` — which would offer to start an engine that is already
     * up. (Foundry reached the same conclusion independently, 2026-09-15, and
     * checked the other half I had only assumed: `/v1/ping` answers with no
     * Authorization header, which is what lets this run for somebody who has
     * installed Crucible and never registered it — exactly the case the offer
     * exists for.)
     */
    const response = await fetch(url.replace(/\/+$/, '') + '/v1/ping', {
      signal: control.signal,
    });
    // ANY answer is a server. A 401 is a server with an opinion about the
    // token, and starting a second one would not improve it.
    return response.status < 500
      ? { ok: true }
      : { ok: false, because: 'it answered ' + response.status };
  } catch (err) {
    return { ok: false, because: (err as Error)?.message || 'no answer' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The three-state answer, for a window that is opening.
 *
 * `wslDistro` is PASSED IN rather than read here, and not for testing's sake:
 * `tool-paths` reaches Electron's `app.getPath('userData')` at import, so
 * asking it from this module would make "is there an engine on this computer"
 * a question only a fully booted Electron can be asked. The caller in `main.ts`
 * has the distro already.
 *
 * It matters on Windows, where the config lives inside WSL: a host built
 * without a distro looks for a Linux path on the C: drive and reports `absent`
 * about a machine that has an engine.
 */
export async function readEnginePresence(wslDistro: string | undefined): Promise<EnginePresence> {
  let found: DiscoveredCrucible;
  try {
    found = discoverCrucible(processDiscoveryHost(wslDistro));
  } catch (err) {
    if (err instanceof CrucibleDiscoveryError) {
      // Discovery's own words name the config path it looked for, which is what
      // somebody needs in order to act. Passed through, never summarised.
      return { state: 'absent', detail: err.message };
    }
    throw err;
  }
  const reached = await answers(found.url);
  return reached.ok
    ? { state: 'running', where: found.url, name: found.name }
    : { state: 'stopped', where: found.url, name: found.name, because: reached.because };
}

export interface EngineStartOutcome {
  readonly started: boolean;
  readonly detail: string;
}

/**
 * Start the TRAY, and let it bring the engine up.
 *
 * DETACHED AND UNREF'D on purpose: the tray outlives the app that asked for it.
 * Somebody who quits BookForge has not asked for the engine to stop -- the
 * whole point of a tray is that it belongs to the machine, not to this window.
 */
export async function startEngine(): Promise<EngineStartOutcome> {
  const launcher = trayLauncher();
  if (launcher === null) {
    return {
      started: false,
      detail: os.platform() === 'darwin'
        ? 'No Crucible app is installed on this Mac, so there is nothing to start it with. '
          + 'Run `crucible service start` in a terminal to start the server itself.'
        : 'No Crucible tray is installed on this machine, so there is nothing to start it with.',
    };
  }
  try {
    const child = spawn(launcher.command, [...launcher.args], { detached: true, stdio: 'ignore' });
    child.unref();
    return { started: true, detail: launcher.detail };
  } catch (err) {
    return { started: false, detail: launcher.detail + ' failed: ' + (err as Error).message };
  }
}

interface TrayLauncher {
  readonly command: string;
  readonly args: readonly string[];
  readonly detail: string;
}

/**
 * What starts the tray on THIS machine, or null when nothing does.
 *
 * NULL IS AN ANSWER, not a failure to look: a Mac with no menu bar app
 * installed genuinely has nothing to launch, and saying so beats spawning
 * something that is not there and reporting a spawn error about a path the
 * person has never seen.
 */
function trayLauncher(): TrayLauncher | null {
  const platform = os.platform();
  if (platform === 'win32') {
    /*
     * The ORCHESTRATOR, through the env's own windowless python.
     *
     * NOT the Scripts console-script wrapper: measured 2026-09-15 on Owen's PC,
     * `crucible.exe --version` exits 1 and prints nothing -- its embedded
     * interpreter path did not survive the env being placed under AppData --
     * while `python -m crucible.cli` answers correctly. `pythonw.exe` is what
     * the Startup shortcut on that machine already points at, so this starts
     * the tray the same way logging in does.
     */
    const home = path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Crucible', 'host',
    );
    const pythonw = path.join(home, 'pythonw.exe');
    if (!fs.existsSync(pythonw)) return null;
    return {
      command: pythonw,
      args: ['-m', 'crucible.cli', 'orchestrator'],
      detail: 'Started the Crucible tray, which brings up the WSL engine.',
    };
  }
  if (platform === 'darwin') {
    /*
     * The .app, opened with `open -a`, so launchd gives it a GUI session. A
     * menu bar item needs one, and a process spawned straight from here is not
     * in a session that can own one.
     */
    const bundle = '/Applications/Crucible.app';
    if (!fs.existsSync(bundle)) return null;
    return {
      command: 'open',
      args: ['-a', bundle],
      detail: 'Opened Crucible, which starts the server and puts an icon in the menu bar.',
    };
  }
  return null;
}

/**
 * Wait for the engine to come up after a start, or say it did not.
 *
 * A COLD ENGINE IS NOT FAST: the Windows tray has to boot a WSL distro before
 * anything answers, and the Mac's launchd agent has to load. So this polls, and
 * the window it allows is generous. What it will not do is wait forever -- a
 * tray that failed to bring the engine up has to become a sentence somebody
 * can read.
 */
export async function waitForEngine(url: string, withinMs = 45000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if ((await answers(url)).ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
