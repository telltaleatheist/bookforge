/** The installer and its native/WSL decisions belong to Crucible. */
import {
  hostInstalled, install, installStatus, processRunner, RELEASE_REPO, startLocal,
  TERMINAL_OUTCOME_STATES,
  type HostEvent, type Runner,
} from '@crucible/bootstrap';
import { addLocalCrucible, probeCrucible, probeCrucibleAt } from './crucible-registry';
import { pairingFileRead } from './crucible-pairing';
import { hosted } from './host';
import { probeSystem } from './system-probe';
import type { CrucibleInstallPlan, CrucibleInstallStep, InstallPlatform } from '../shared/slots';
import type { CrucibleInstallEvent } from '../shared/crucible-install-wire';

// ─────────────────────────────────────────────────────────────────────────────
// WHICH Crucible: the release channel, and never an older one
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE RELEASE CHANNEL — GitHub's pointer at the PROMOTED release.
 *
 * crucible `docs/INSTALL-UNINSTALL.md` §6.5.1. Every Crucible is cut
 * `--prerelease --latest=false` and becomes `releases/latest` only when
 * `promote_release.py --publish` moves it, after its packs and a fresh-install
 * smoke have been verified — so this is the one place that answers "which
 * Crucible should this machine have". `releases?per_page=1` is the newest TAG,
 * which between a cut and its promotion is the candidate that gate holds back.
 *
 * Built from the package's `RELEASE_REPO` because the slug already has an owner.
 * The URL SHAPE is spelled twice today: crucible's
 * `sdk/bootstrap/src/channel.ts` owns it as `LATEST_RELEASE_URL`, and this app
 * cannot import it until a release carrying that module is cut and re-vendored.
 * That re-vendor turns this constant into an import and deletes this paragraph.
 */
export const CRUCIBLE_CHANNEL_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/*
 * ── THE COPYABLE LINE IS GONE (PHASE19 §0) ────────────────────────────────
 *
 * `CRUCIBLE_LATEST_PS1` used to live here — the channel's own
 * `irm … | iex` — and the install door printed it for somebody to paste.
 * Owen, 2026-09-18: *"we should assume they have no idea how to do it and it
 * should do it automatically."* PHASE19 makes the rule absolute: **nobody is
 * ever shown a command.** A command a person could run is a step the app
 * should be running, and this app has run this one since `@crucible/bootstrap`
 * landed — the constant was a second, worse door beside the button.
 *
 * The line itself still exists inside the SDK (`hostInstallCommand`), which is
 * what {@link driveCrucibleInstall} hands to PowerShell below. It is a command
 * this app RUNS; it is not a string any screen reads.
 */

/** A refusal with a name, because a sentence in a log has to be searchable. */
export class CrucibleInstallRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleInstallRefusal';
  }
}

/**
 * Order two Crucible versions: negative when `a` is older.
 *
 * NUMBER BY NUMBER, because a string comparison puts 1.0.10 before 1.0.2 and
 * the only question this is asked is which of two versions is older. Something
 * that is not three numbers is REFUSED rather than sorted to one end: "older"
 * has no answer about it, and guessing one is how a gate lets a downgrade past.
 *
 * Crucible's `sdk/bootstrap/src/channel.ts` owns `compareReleases`, and this is
 * the same arithmetic until the re-vendor that lets it be imported.
 */
export function compareCrucibleVersions(a: string, b: string): number {
  const left = /^v?(\d+)\.(\d+)\.(\d+)/.exec(a.trim());
  const right = /^v?(\d+)\.(\d+)\.(\d+)/.exec(b.trim());
  if (left === null || right === null) {
    throw new CrucibleInstallRefusal(
      'release_channel_unreadable',
      `${JSON.stringify(left === null ? a : b)} is not a Crucible version, so it cannot be compared with `
      + `${JSON.stringify(left === null ? b : a)}`,
    );
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The two facts the never-older gate compares, each from its own source.
 *
 * An interface so a keeper can put a channel at one version in front of an
 * engine at another and watch what the gate does. There is no second
 * implementation behind it.
 */
export interface CrucibleReleaseSources {
  /** What the channel calls latest. Refuses `release_channel_unreadable`. */
  latest(): Promise<string>;
  /** The version of the engine answering on THIS machine, or null when there is none. */
  running(): Promise<string | null>;
}

/**
 * The channel's latest.
 *
 * NO CACHE AND NO FALLBACK (§6.5.2). A channel that will not answer is a
 * refusal by name; installing the vendored library's version instead is the
 * silent downgrade being removed. An operator with no network names an exact
 * release to `install.sh --release` instead.
 */
export async function crucibleChannelLatest(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const unreadable = (why: string) => new CrucibleInstallRefusal(
    'release_channel_unreadable', `could not read the release channel at ${CRUCIBLE_CHANNEL_URL}: ${why}`);
  let response: Response;
  try {
    response = await fetchImpl(CRUCIBLE_CHANNEL_URL, { headers: { accept: 'application/vnd.github+json' } });
  } catch (err) {
    throw unreadable((err as Error).message);
  }
  const body = await response.text();
  if (!response.ok) throw unreadable(`HTTP ${response.status}`);
  let tag: unknown;
  try {
    tag = (JSON.parse(body) as Record<string, unknown>)['tag_name'];
  } catch (err) {
    throw unreadable(`it is not JSON (${(err as Error).message})`);
  }
  if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+/.test(tag)) {
    throw unreadable(`its tag_name is ${JSON.stringify(tag)}, which is not a Crucible version`);
  }
  return tag.replace(/^v/, '');
}

/**
 * WHAT IS RUNNING ON THIS MACHINE, asked of the engine itself.
 *
 * The connect code Crucible left here, then `GET /v1/info` through the probe
 * this app already uses — `CrucibleProbe.version` is `info().server.version`.
 *
 * `absent` is null: a machine with no engine has nothing to compare against and
 * that is the ordinary state of a fresh install. `refused` and a probe that
 * failed are NOT null and are raised, because "there is no server here" and
 * "the server would not say what it is" are different facts, and installing
 * over the second one blind is what this gate exists to stop.
 */
export async function runningCrucibleVersion(): Promise<string | null> {
  const read = await pairingFileRead();
  if (read.found === 'absent') return null;
  if (read.found === 'refused') {
    throw new CrucibleInstallRefusal('install_precheck_failed', read.message);
  }
  const probe = await probeCrucibleAt(read.pairing.url, read.pairing.token);
  if (probe.outcome !== 'ok') {
    throw new CrucibleInstallRefusal(
      'install_precheck_failed',
      `this computer publishes a Crucible at ${read.pairing.url} and it did not say what version it is: `
      + `${probe.message}. Nothing is installed over an engine that cannot be read.`,
    );
  }
  return probe.version;
}

/** The real pair. Injected in keepers; nothing else switches on it. */
export function processReleaseSources(): CrucibleReleaseSources {
  return { latest: () => crucibleChannelLatest(), running: () => runningCrucibleVersion() };
}

/**
 * WHICH RELEASE TO INSTALL, or the refusal that says not to.
 *
 * crucible `docs/INSTALL-UNINSTALL.md` §6.5.3, and it runs before anything is
 * spawned. Four answers and no fifth:
 *
 *   nothing running  → the channel's latest
 *   channel newer    → the channel's latest
 *   channel equal    → `crucible_already_latest`
 *   channel older    → `install_older_than_running`
 *
 * There is no force. One Crucible per machine is the ruling, so this engine may
 * be the one BookForge is using; the way back from a newer one is the
 * bootstrapper's exact-version rollback, never a button in an app.
 */
export async function releaseToInstall(
  sources: CrucibleReleaseSources = processReleaseSources(),
): Promise<string> {
  const latest = await sources.latest();
  const running = await sources.running();
  if (running === null) return latest;
  const order = compareCrucibleVersions(latest, running);
  if (order < 0) {
    throw new CrucibleInstallRefusal(
      'install_older_than_running',
      `the release channel's latest is ${latest} and crucible ${running} is running on this computer; `
      + 'refusing to install an older engine over it.',
    );
  }
  if (order === 0) {
    throw new CrucibleInstallRefusal(
      'crucible_already_latest',
      `crucible ${running} is running on this computer and the release channel's latest is ${latest} — `
      + 'there is nothing to install.',
    );
  }
  return latest;
}

/**
 * §3.1's PROGRESS LIST, as a skeleton with every row still waiting.
 *
 * ── It is a list of ROWS now, not a list of instructions ───────────────────
 *
 * What stood here was two steps with a command under the first, because the
 * door was a printed document: "here is the line, here is what to do after
 * it". PHASE19 §3.1 replaces the document with the progress of the thing the
 * button already does, so these titles are the rows that fill in while it
 * runs (shared/crucible-install-wire.ts) rather than a sequence anybody
 * performs. `command` is null on every row and stays null: §0's rule is that
 * no screen shows a command, so the field survives only because
 * {@link CrucibleInstallStep} is also the (empty) `elevated` list's shape.
 *
 * ── THE PLATFORM DECIDES WHICH ROWS EXIST, NOT THE EVENTS ──────────────────
 *
 * A Mac has no native-Windows engine and no guest to move into, so it has
 * neither row — and a `windows-engine` event arriving there is dropped by the
 * reducer rather than drawn. Windows has both, because §2.8 is explicit that
 * the native engine answers first and the move runs behind it: those are two
 * rows because they are two facts a person watching wants separately.
 *
 * The last two rows are the COORDINATE step's (§2.8), which runs against
 * whichever engine is left standing once the move is terminal.
 */
export function installationSteps(platform: InstallPlatform): CrucibleInstallStep[] {
  if (platform === 'other') return [];
  const rows: CrucibleInstallStep[] = [{
    id: 'install',
    title: 'Installing Crucible',
    detail: 'Crucible installs its own runtime and the service that manages it.',
    command: null, done: false,
  }];
  if (platform === 'win32') {
    rows.push({
      id: 'windows-engine',
      title: 'Starting the Windows engine',
      detail: 'This engine answers within seconds and keeps answering while the rest happens.',
      command: null, done: false,
    }, {
      id: 'linux-engine',
      title: 'Setting up the Linux engine',
      detail: 'Crucible sets this up by itself. Windows may ask for permission, and may ask for a restart.',
      command: null, done: false,
    });
  }
  rows.push({
    id: 'job-types',
    title: 'Installing what Foundry needs',
    detail: 'The environments this app asks the engine for.',
    command: null, done: false,
  }, {
    id: 'models',
    title: 'Downloading models',
    detail: 'The weights the engine runs. Several gigabytes on a first install.',
    command: null, done: false,
  });
  return rows;
}

export async function crucibleInstallPlan(): Promise<CrucibleInstallPlan> {
  const platform: InstallPlatform = ['win32', 'darwin', 'linux'].includes(process.platform)
    ? process.platform as InstallPlatform : 'other';
  return {
    platform, wsl: null, machine: (await probeSystem()).detail,
    steps: installationSteps(platform), elevated: [],
    readme: 'https://github.com/telltaleatheist/crucible',
    driven: platform !== 'other' && !hosted(),
    drivenWhy: hosted() ? 'Install Crucible from BookForge.'
      : platform === 'other' ? 'Crucible does not support this platform.' : '',
  };
}

let installing = false;

/**
 * THE DRIVEN INSTALL, narrating itself in §3.1's rows.
 *
 * It takes an EVENT sink and not a line sink, because this function is the one
 * thing that knows which row it is on. The old signature handed out prose and
 * the door printed the last sentence of it; a screen that had to recover "we
 * are past the installer and verifying now" from English would be guessing
 * about our own control flow. Lines still travel — as `line` events under
 * whichever row is running, which is exactly what pip's output is for (§2.12:
 * pip has no byte total, so the line IS the progress).
 */
/**
 * THE THREE SINKS A RUN NARRATES INTO, all three owned by the door
 * (electron/crucible-install-door.ts) and none of them by this file.
 *
 * `event` is this app's own rows — the ones only this sequence knows about.
 * `hostEvent` is the orchestrator's stream, verbatim, which the door folds
 * into rows because the fold is a statement about a screen. `windowsEngineUp`
 * is a one-shot the door makes idempotent: §3.1's second row is finished
 * either when the tray starts answering (its first move step proves the native
 * engine is up, §2.8) or, on a machine with no move at all, when this sequence
 * gets past the installer. Two callers, one row, and the door is where "only
 * once" is decided.
 */
export interface InstallNarration {
  event(event: CrucibleInstallEvent): void;
  hostEvent(event: HostEvent): void;
  windowsEngineUp(): void;
}

export async function driveCrucibleInstall(
  narrate: InstallNarration,
  runner: Runner = processRunner(),
  sources: CrucibleReleaseSources = processReleaseSources(),
): Promise<void> {
  const onEvent = (event: CrucibleInstallEvent) => narrate.event(event);
  const line = (text: string) => onEvent({ event: 'line', text, stream: 'stdout' });
  if (hosted()) throw new Error('Install Crucible from BookForge.');
  if (installing) throw new Error('A Crucible installation is already running.');
  /*
   * THE FLAG IS TAKEN BEFORE THE FIRST `await`, and it has to be: the check
   * above and the first suspension point must not have a gap between them, or
   * two callers both read `installing === false` and both walk the sequence.
   * The gate below is the first `await` there is, so setting the flag after it
   * is exactly that gap — measured, 2026-09-18, as two concurrent installs.
   */
  installing = true;
  try {
    /*
     * NOW THE GATE, and it is the first thing that happens (§6.5.3): the
     * channel says which release, the engine on this machine says which release
     * it already is, and a channel older than the engine refuses by name. Every
     * process below is downstream of this line, so a refused install is one
     * where nothing was spawned rather than one that has to be unwound. Inside
     * the `try`, so the `finally` releases the flag over a refusal too.
     */
    const release = await releaseToInstall(sources);
    narrate.event({ event: 'step', row: 'install', jobType: null });
    if (runner.platform === 'win32' || runner.platform === 'darwin' || runner.platform === 'linux') {
      line(`Crucible ${release}`);
      /*
       * ── ONE CALL DOES BOTH HALVES ON WINDOWS NOW (PHASE19 §2.6) ──────────
       *
       * This used to spawn PowerShell here with `hostInstallCommand(release)`
       * — the channel's `irm … | iex` — because the SDK on win32 refused to
       * run an installer of its own accord. §2.6 changed that: `install()`
       * runs `install.ps1` when the host pack is absent and then
       * `watchInstall()`s the move the TRAY started, replaying the ring so a
       * late attacher sees the step it joined at. It never POSTs the move
       * itself, which is the whole reason there is no second owner of it.
       *
       * So the sequence below is the SDK's, and this file's job shrank to
       * narrating it. On darwin and linux nothing changed: there is no host,
       * the machine is the server, and the same call walks the steps directly.
       */
      await install({
        release, jobTypes: ['echo'],
        onLine: (text, _stream, step) => line(`${step}: ${text}`),
        onHostEvent: (event) => narrate.hostEvent(event),
      }, runner).catch(async (error: unknown) => {
        /*
         * A TERMINAL OUTCOME THAT IS NOT `done` IS NOT A FAILED INSTALL.
         *
         * `install()` promises an {@link InstallResult} and refuses when there
         * is none, carrying the outcome's OWN 4c code — so `cannot`,
         * `reboot-pending` and `declined` all arrive here as exceptions. None
         * of them means the install failed: §0 says a machine that cannot host
         * WSL2 ends on the native Windows engine and the app says so in one
         * sentence, and §2.3 says a `reboot-pending` machine is waiting for a
         * person to press Restart now. Each is a READOUT (§2.2), drawn from the
         * outcome by the screens, and the sequence carries on to start and
         * register the engine that IS there.
         *
         * `host_install_unwitnessed` lands here too and is the same shape: the
         * outcome says `done`, the tray's ring simply no longer holds the
         * `done` event that would have described the guest. The machine is on
         * the Linux engine either way.
         *
         * EVERYTHING ELSE IS RAISED. A `failed` outcome is NOT terminal — the
         * tray retries it once — and install.ps1 dying leaves no outcome at
         * all; both reach the door as the refusal they are.
         */
        if (runner.platform !== 'win32') throw error;
        /*
         * THE PROBE MUST NOT REPLACE THE THING IT IS PROBING.
         *
         * Measured here, 2026-09-19: an `install.ps1` that exited 9 refused
         * `host_not_installed`, and this recovery then asked the tray for an
         * outcome — on a machine that has no tray, no config.toml and no token,
         * because the installer had just failed. `installStatus` refused
         * `host_no_token`, and THAT is the sentence that reached the screen.
         * The original failure, which is the only one that says what went
         * wrong, was gone.
         *
         * So two guards, both about the same rule: ask only when there is
         * something to ask, and let nothing this recovery does become the
         * error it is recovering from.
         */
        if (!hostInstalled(runner)) throw error;
        let outcome;
        try {
          outcome = (await installStatus({}, runner)).outcome;
        } catch {
          throw error;
        }
        if (outcome === null || !TERMINAL_OUTCOME_STATES.includes(outcome.state)) throw error;
        line(outcome.sentence ?? `The engine move ended as ${outcome.state}.`);
      });
    } else {
      throw new Error('Crucible does not support this platform.');
    }
    /*
     * §3.1's SECOND ROW IS WINDOWS'S ALONE (§2.8: the native engine answers
     * first and the move runs behind it). Elsewhere the service that just
     * installed IS the engine, so starting and registering it is the tail of
     * row one and a second row would be this screen counting the same fact
     * twice. The door has usually drawn it already, off the tray's first move
     * step; this is the machine that had no move to prove it with.
     */
    if (runner.platform === 'win32') narrate.windowsEngineUp();
    const status = await startLocal({}, runner);
    if (status.state !== 'running') throw new Error(status.detail);
    const connected = await addLocalCrucible('');
    let backend: string | null = null;
    if (connected.outcome !== 'added') {
      if (connected.code !== 'already_registered') throw new Error(connected.message);
      /*
       * ALREADY REGISTERED IS NOT A FAILURE and is not verified either: that arm
       * carries no server name, because nothing was added to name. The row it is
       * talking about was checked when it was added and is checked again by the
       * Servers card's own Test, which is where somebody looking at a suspicious
       * engine goes. It also leaves `backend` null, and the last row then says
       * the engine is running without naming which one — there is nothing here
       * that measured it, and guessing from the platform is the fallback this
       * codebase does not write.
       */
    } else {
      backend = await verifyInstalled(status.name, connected.serverName, line);
    }
    onEvent({ event: 'done', backend });
  } finally {
    installing = false;
  }
}

/**
 * IS THE ENGINE ANSWERING THE ENGINE WE JUST INSTALLED?
 *
 * ── The distinction, which is not pedantry ────────────────────────────────
 *
 * Everything above proves the installer exited 0 and that SOMETHING is serving
 * on the address Crucible published here. Neither of those is the thing worth
 * knowing. A machine can already be running an engine — somebody else's, an
 * older one, one reached through a tray that points into WSL — and the steps
 * above would report a clean install while the row that got registered belongs
 * to a different process than the one the installer built.
 *
 * bookforge-02, 2026-09-17, having built this first and offering it verbatim:
 * it is *"the difference between 'the installer exited 0' and 'the engine
 * answering is the engine we installed'."* Foundry had the first half only.
 *
 * ── THREE COMPARISONS, AND WHY EACH IS A DIFFERENT QUESTION ───────────────
 *
 *   1. **The installation record against the pairing file.** `startLocal` reads
 *      what Crucible installed here; `addLocalCrucible` reads the connection
 *      Crucible published here. They are two files written by one installer, and
 *      disagreeing means the published connection is not this installation's.
 *   2. **The pairing file against the engine that answers it.** A name in a file
 *      is a claim. `info().server.name` is the process on the socket saying what
 *      it is, and this is the only one of the three that involves the running
 *      engine at all.
 *   3. **The backend against the kinds this build knows.** Not an identity
 *      check — a vocabulary one. An engine reporting something outside the set
 *      is newer than this app, which is a fact worth naming rather than a
 *      failure to swallow.
 *
 * NONE OF THEM IS FATAL TO THE INSTALL, and that is deliberate: the engine IS
 * installed and IS registered by the time this runs, so throwing would report a
 * completed install as a failure and leave a working row behind a refusal. Each
 * mismatch is said on the installer's own line feed, where somebody watching
 * will see it, and the log keeps it.
 */
async function verifyInstalled(
  installedName: string | null,
  registeredName: string,
  onLine: (line: string) => void,
): Promise<string | null> {
  if (installedName !== null && installedName !== registeredName) {
    onLine(
      `Note: Crucible installed an engine calling itself "${installedName}", but the connection `
      + `published on this computer names "${registeredName}". Foundry registered the published `
      + 'one. If this machine runs more than one engine, check Settings › Crucible Servers.',
    );
  }
  const probe = await probeCrucible(registeredName);
  if (probe.outcome !== 'ok') {
    onLine(`Note: "${registeredName}" was registered but did not answer: ${probe.message}`);
    return null;
  }
  if (probe.serverName !== registeredName) {
    onLine(
      `Note: the engine at that address calls itself "${probe.serverName}" rather than `
      + `"${registeredName}". The row is registered under the published name.`,
    );
  }
  /*
   * `none` IS A KIND AND NOT AN ABSENCE — PHASE15 §3.5's host mode, a Windows
   * machine with no WSL2, which has no accelerator and says so. Treating it as
   * unknown would warn about the one configuration this installer most often
   * produces on a fresh machine.
   */
  const KNOWN = ['cuda-linux', 'mlx-darwin', 'llama-windows', 'none'];
  if (!KNOWN.includes(probe.backend)) {
    onLine(
      `Note: this engine reports a backend this version of Foundry does not know `
      + `("${probe.backend}"). It is registered and should work; Foundry may be older than `
      + 'the Crucible now on this computer.',
    );
  }
  /*
   * AND THE ONE THING THE LAST ROW NEEDS. §3.1 ends "Done — running on the
   * Linux engine" or "on the Windows engine", and this is where that is
   * MEASURED: the engine on the socket said what it is. Returned rather than
   * re-probed by the caller so the sentence and the check above it are looking
   * at the same answer.
   */
  return probe.backend;
}
