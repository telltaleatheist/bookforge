/**
 * env-install — put a catalog environment where the engine will find it.
 *
 * The downloader (env-downloader.ts) moves bytes and the catalog
 * (env-catalog.ts) says which bytes; this file is everything between them that
 * is a DECISION: where an environment goes, whether an existing directory may be
 * replaced, how the WSL one gets inside the distro, and what gets written into
 * the engine's settings afterwards.
 *
 * ── Four phases, and only one of them has a percentage ───────────────────────
 *
 * download → verify → unpack → configure. The download counts bytes against a
 * known total. The other three do not have an honest number: a sha256 of five
 * gigabytes is one long read, tar knows how many files it has written but not
 * how many are left, and configure is three lines. They report a moving DETAIL
 * and the UI draws an indeterminate bar, rather than a percentage invented to
 * keep something animating.
 *
 * ── The WSL environment is extracted INSIDE the distro ───────────────────────
 *
 * Never through `\\wsl$`. A Python install is a thicket of symlinks —
 * `bin/python3 -> python3.12`, and every shared object under `lib/` — and the
 * 9P/Plan-9 redirector that serves `\\wsl$` turns them into copies or into
 * nothing. The archive is downloaded on the Windows side (the distro would have
 * to have curl, and its network is not always the host's), handed across as
 * `/mnt/c/…`, and unpacked by the distro's own tar.
 *
 * ── An install REPLACES, but only its own ────────────────────────────────────
 *
 * A destination that already holds `python/foundry-env.json` is a previous
 * install of ours and is removed first. A destination that holds ANYTHING ELSE
 * is refused, loudly. The picker lets a user name any directory on the machine,
 * and `rm -rf` on a directory they meant to install *beside* is not a bug you
 * get to apologise for afterwards.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  ENV_ASSETS,
  ENV_SPECS,
  MARKER_RELPATH,
  defaultDest,
  envSources,
  interpreterPath,
  isPublished,
  markerPath,
  requirePublished,
  targetsForPlatform,
} from './env-catalog';
import {
  AbortedError,
  fetchArchive,
  gib,
  isAborted,
  makeTempDir,
  removeTempDir,
  unpackTarGz,
  verifyHash,
} from './env-downloader';
import { readSettings, writeSettings } from './settings';
import {
  checkVllm,
  listDistros,
  networkPathBehind,
  runInDistro,
  shellQuote,
  streamInDistro,
  toWslPath,
} from './wsl';
import { VLLM_URL } from './vllm-server';
import { readJson } from '../shared/json';
import type {
  EnvCatalogItem,
  EnvInstallProgress,
  EnvInstallRequest,
  EnvInstallResult,
  EnvTarget,
} from '../shared/types';

/** How long the distro gets for one bookkeeping command (test, mkdir, cat). */
const GUEST_PROBE_MS = 30_000;
/** How long the distro gets to unpack ~5 GB. Generous: it is disk-bound. */
const GUEST_UNPACK_MS = 45 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Where an install would go, and whether one is already there
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The destination this request means. The picker's value when there is one, the
 * platform default otherwise — and ALWAYS the default for a WSL target, whose
 * destination is a path in the guest's home that no Windows directory picker can
 * express.
 */
export function destFor(request: EnvInstallRequest): string {
  if (ENV_SPECS[request.target].inWsl) return defaultDest(request.target);
  const named = request.dest?.trim();
  return named && named.length > 0 ? path.resolve(named) : defaultDest(request.target);
}

/**
 * Which distro a WSL install goes into: the request's, else the one settings
 * already names, else the only one there is.
 *
 * Null when the machine has several and nobody has said which. That is not a
 * default to guess at — the environment is five gigabytes and the wrong distro
 * is five gigabytes in a place the user will not think to look.
 */
export async function resolveDistro(request: EnvInstallRequest): Promise<string | null> {
  const named = request.distro?.trim();
  if (named) return named;
  const configured = readSettings().backend.wslDistro?.trim();
  if (configured) return configured;
  const facts = await listDistros();
  return facts.distros.length === 1 ? (facts.distros[0] ?? null) : null;
}

type DestVerdict =
  /** Nothing there, or an empty directory. Unpack straight into it. */
  | { kind: 'fresh' }
  /** A previous install of ours. Removed first, then unpacked. */
  | { kind: 'replace' }
  /** Someone else's directory. Refused. */
  | { kind: 'refuse'; reason: string };

/** The guard, for a destination on this machine's own filesystem. */
export function inspectDest(target: EnvTarget, dest: string): DestVerdict {
  if (!fs.existsSync(dest)) return { kind: 'fresh' };

  let entries: string[];
  try {
    entries = fs.readdirSync(dest);
  } catch (err) {
    return { kind: 'refuse', reason: `${dest} exists but could not be read: ${(err as Error).message}` };
  }
  if (entries.length === 0) return { kind: 'fresh' };
  if (fs.existsSync(markerPath(target, dest))) return { kind: 'replace' };

  return {
    kind: 'refuse',
    reason:
      `${dest} already has ${entries.length} item(s) in it and no ${MARKER_RELPATH}, so it is not an `
      + 'environment this app installed. Refusing to delete it — choose an empty directory, or one '
      + 'you previously installed into.',
  };
}

/** The same guard, asked of the distro. Exit codes carry the three answers. */
async function inspectGuestDest(distro: string, target: EnvTarget, dest: string): Promise<DestVerdict> {
  const quoted = shellQuote(dest);
  const marker = shellQuote(markerPath(target, dest));
  const probe = await runInDistro(
    distro,
    `if [ ! -e ${quoted} ]; then exit 10; fi; `
    + `if [ -f ${marker} ]; then exit 11; fi; `
    + `if [ -z "$(ls -A ${quoted} 2>/dev/null)" ]; then exit 10; fi; `
    + `ls -A ${quoted} | head -20; exit 12`,
    GUEST_PROBE_MS,
  );
  if (probe.code === 10) return { kind: 'fresh' };
  if (probe.code === 11) return { kind: 'replace' };
  if (probe.code === 12) {
    return {
      kind: 'refuse',
      reason:
        `${dest} inside ${distro} already has content and no ${MARKER_RELPATH}, so it is not an `
        + `environment this app installed. Refusing to delete it. It holds: ${probe.stdout.trim().split(/\s+/).join(', ')}`,
    };
  }
  const said = probe.failure ?? probe.stderr.trim();
  return {
    kind: 'refuse',
    reason: `${distro} could not be asked about ${dest}: ${said || `exit ${probe.code}`}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalog, as this machine sees it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every entry this platform could use, with installed state measured rather than
 * remembered. Nothing is cached: a user who deleted the directory by hand should
 * see the card say so the next time the page loads.
 */
export async function catalogForThisMachine(): Promise<EnvCatalogItem[]> {
  const settings = readSettings();
  const items: EnvCatalogItem[] = [];

  for (const target of targetsForPlatform()) {
    const spec = ENV_SPECS[target];
    const asset = ENV_ASSETS[target];
    const dest = defaultDest(target);
    const expected = interpreterPath(target, dest);

    let installedPath: string | null = null;
    let detail: string;

    if (spec.inWsl) {
      const distro = settings.backend.wslDistro?.trim() ?? (await resolveDistro({ target }));
      if (!distro) {
        detail = 'No distro is configured yet, so there is nowhere to look for it.';
      } else {
        const probe = await runInDistro(distro, `test -x ${shellQuote(expected)}`, GUEST_PROBE_MS);
        if (probe.code === 0) {
          installedPath = expected;
          detail = `Installed in ${distro} at ${expected}.`;
        } else if (probe.code === 1) {
          detail = `Not installed in ${distro}.`;
        } else {
          detail = `${distro} could not be asked: ${probe.failure ?? `exit ${probe.code}`}.`;
        }
      }
    } else if (fs.existsSync(expected)) {
      installedPath = expected;
      detail = `Installed at ${dest}.`;
    } else {
      detail = 'Not installed.';
    }

    const configuredPath = spec.inWsl ? settings.backend.vllmPython : settings.backend.python;
    items.push({
      target,
      label: spec.label,
      purpose: spec.purpose,
      pythonVersion: spec.pythonVersion,
      packages: spec.packages,
      bytes: asset.bytes,
      partCount: Math.max(1, asset.parts.length),
      published: isPublished(target),
      defaultDest: dest,
      inWsl: spec.inWsl,
      installedPath,
      configured: installedPath !== null && configuredPath?.trim() === installedPath,
      detail,
    });
  }

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running an install
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvInstallHandle {
  /** Resolves with the outcome. Never rejects — every failure is a sentence. */
  done: Promise<EnvInstallResult>;
  cancel(): void;
}

/**
 * The one install in flight. A backstop, not the mechanism: the serial queue
 * already prevents a second one, and cancelling is the QUEUE's job (it owns
 * whether a stopped row reads `cancelled` or `failed`) — so this guard exists
 * only so a direct caller cannot start two downloads into one directory.
 */
let active: AbortController | null = null;

/**
 * Where progress is published for anyone who is not the caller — main wires this
 * to the `env:install-progress` broadcast, so the settings card sees the same
 * phases the shelf does without either of them owning the run.
 */
let progressListener: (progress: EnvInstallProgress) => void = () => { /* set by main */ };

export function onEnvInstallProgress(listener: (progress: EnvInstallProgress) => void): void {
  progressListener = listener;
}

export function installEnv(
  request: EnvInstallRequest,
  onProgress: (progress: EnvInstallProgress) => void = () => { /* the queue's mirror */ },
): EnvInstallHandle {
  if (active) {
    return {
      done: Promise.resolve({
        ok: false,
        pythonPath: null,
        detail: 'Another environment is being installed. Wait for it, or cancel it first.',
      }),
      cancel: () => { /* not ours to cancel */ },
    };
  }

  const controller = new AbortController();
  active = controller;

  const emit = (
    phase: EnvInstallProgress['phase'],
    percent: number,
    detail: string,
  ): void => {
    const progress: EnvInstallProgress = { target: request.target, phase, percent, detail };
    onProgress(progress);
    progressListener(progress);
  };

  const done = run(request, controller.signal, emit)
    .catch((err: unknown): EnvInstallResult => ({
      ok: false,
      pythonPath: null,
      detail: isAborted(err) ? 'Cancelled.' : (err instanceof Error ? err.message : String(err)),
    }))
    .finally(() => { active = null; });

  return { done, cancel: () => controller.abort() };
}

async function run(
  request: EnvInstallRequest,
  signal: AbortSignal,
  emit: (phase: EnvInstallProgress['phase'], percent: number, detail: string) => void,
): Promise<EnvInstallResult> {
  const { target } = request;
  const spec = ENV_SPECS[target];

  // Refused before a byte moves. An entry with no sha256 is not "verify later".
  const asset = requirePublished(target);
  const totalBytes = asset.bytes ?? 0;

  const dest = destFor(request);
  const distro = spec.inWsl ? await resolveDistro(request) : null;
  if (spec.inWsl && !distro) {
    const facts = await listDistros();
    return {
      ok: false,
      pythonPath: null,
      detail: facts.distros.length > 1
        ? `This machine has ${facts.distros.length} WSL distros (${facts.distros.join(', ')}). `
          + 'Open Settings → Environments and choose which one to install into.'
        : (facts.reason ?? 'There is no WSL distro to install into.'),
    };
  }

  // ── The guard, before anything is downloaded ────────────────────────────────
  const verdict = distro
    ? await inspectGuestDest(distro, target, dest)
    : inspectDest(target, dest);
  if (verdict.kind === 'refuse') {
    return { ok: false, pythonPath: null, detail: verdict.reason };
  }

  const tempDir = makeTempDir();
  // WSL2 auto-mounts FIXED drives only, so a download folder on a mapped network
  // drive is invisible to the distro that has to unpack it — and FOUNDRY_ENV_TMP
  // is exactly how a machine with a small system disk ends up pointing at one.
  // Checked here rather than left to toWslPath, because there it would surface
  // only after five gigabytes had been fetched to a place that cannot be used.
  const share = distro === null ? null : networkPathBehind(tempDir);
  if (share !== null) {
    await removeTempDir(tempDir);
    return {
      ok: false,
      pythonPath: null,
      detail: `The download folder ${tempDir} is on the network share ${share}, which ${distro} cannot see: `
        + 'WSL mounts local drives only. Point FOUNDRY_ENV_TMP at a folder on a local drive and try again.',
    };
  }
  const archivePath = path.join(tempDir, asset.archive);

  try {
    // ── download ────────────────────────────────────────────────────────────
    emit('download', 0, `Starting ${gib(totalBytes)} from the ${target} release…`);
    const actual = await fetchArchive(
      envSources(target),
      archivePath,
      totalBytes,
      (received, total, detail) => {
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        emit('download', percent, detail);
      },
      signal,
    );

    // ── verify ──────────────────────────────────────────────────────────────
    // The hash was computed on the way to disk, so this is a comparison rather
    // than a second pass over five gigabytes. A mismatch deletes the archive and
    // names both hashes (env-downloader.ts).
    emit('verify', 0, `Checking sha256 of ${asset.archive}…`);
    verifyHash(asset.archive, archivePath, asset.sha256, actual);
    emit('verify', 100, 'sha256 matches the catalog.');
    if (signal.aborted) throw new AbortedError();

    // ── unpack ──────────────────────────────────────────────────────────────
    const pythonPath = interpreterPath(target, dest);
    if (distro) {
      await unpackInDistro(distro, dest, archivePath, verdict.kind === 'replace', emit, signal);
      const there = await runInDistro(distro, `test -x ${shellQuote(pythonPath)}`, GUEST_PROBE_MS);
      if (there.code !== 0) {
        return {
          ok: false,
          pythonPath: null,
          detail: `The archive unpacked into ${distro}, but ${pythonPath} is not there. `
            + 'The asset\'s layout does not match what the catalog expects.',
        };
      }
    } else {
      if (verdict.kind === 'replace') {
        emit('unpack', 0, `Removing the previous install at ${dest}…`);
        fs.rmSync(dest, { recursive: true, force: true });
      }
      emit('unpack', 0, 'Unpacking…');
      await unpackTarGz(
        archivePath,
        dest,
        (count) => emit('unpack', 0, `Unpacked ${count.toLocaleString()} files…`),
        signal,
      );
      if (!fs.existsSync(pythonPath)) {
        return {
          ok: false,
          pythonPath: null,
          detail: `The archive unpacked into ${dest}, but ${pythonPath} is not there. `
            + 'The asset\'s layout does not match what the catalog expects.',
        };
      }
    }
    if (signal.aborted) throw new AbortedError();

    // ── configure ───────────────────────────────────────────────────────────
    emit('configure', 0, 'Writing the interpreter into the engine\'s settings…');
    const manifest = await readManifest(target, dest, distro);

    if (distro) {
      /*
       * FOUR KEYS, AND THE TWO NEW ONES ARE WHY A FRESH INSTALL COULD NOT OCR.
       *
       * Nothing in this app had ever written `backend.mode`. The installers set
       * the distro and the interpreter — where the environment IS — and left the
       * mode at whatever the engine's shipped settings said, which on a machine
       * that had never been configured is not `endpoint`. So the engine, asked
       * to read a book, looked for a local MLX path that does not exist off
       * Apple silicon and refused with "no reading backend for this run" — on a
       * machine where the user had just watched a reading server install
       * successfully.
       *
       * INSTALLING THE SERVER IS THE STATEMENT. Somebody who has just built
       * vLLM in WSL has said which backend reads their pages as plainly as it
       * can be said; making them then find the Settings screen and repeat it in
       * a drop-down is asking a question they have already answered.
       *
       * `writeSettings` preserves every other key, so a user who had pointed the
       * app at a different endpoint keeps their URL — this only writes the two
       * that describe the server it just made.
       */
      writeSettings({
        wslDistro: distro,
        vllmPython: pythonPath,
        mode: 'endpoint',
        endpointUrl: VLLM_URL,
      });
      emit('configure', 50, `Asking ${pythonPath} whether it can import vllm…`);
      const check = await checkVllm(distro, pythonPath);
      if (!check.ok) {
        return {
          ok: false,
          pythonPath,
          detail: `The environment is installed and settings are written, but ${check.detail}`,
        };
      }
      emit('configure', 100, `${check.detail} Reading through ${VLLM_URL}.`);
      return {
        ok: true,
        pythonPath,
        detail: `${spec.label} is ready in ${distro}: ${pythonPath}${manifest}`,
      };
    }

    writeSettings({ python: pythonPath });
    emit('configure', 100, `backend.python = ${pythonPath}`);
    return {
      ok: true,
      pythonPath,
      detail: `${spec.label} is installed at ${dest} and backend.python now points at it${manifest}`,
    };
  } finally {
    // The archive and any surviving part file, always. Five gigabytes of temp
    // left behind by a failed install is a second failure.
    await removeTempDir(tempDir);
  }
}

/**
 * Hand the archive across and let the distro's own tar do the work.
 *
 * `mkdir -p` on the FULL destination first: tar's `-C` requires the directory to
 * already exist, and the usual mistake is creating the parent and passing the
 * child. The commands are joined with `&&` inside one `bash -lc` so a failed
 * mkdir cannot be followed by a tar that writes into the current directory.
 */
async function unpackInDistro(
  distro: string,
  dest: string,
  archivePath: string,
  replacing: boolean,
  emit: (phase: EnvInstallProgress['phase'], percent: number, detail: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const guestArchive = shellQuote(toWslPath(archivePath));
  const guestDest = shellQuote(dest);

  if (replacing) {
    emit('unpack', 0, `Removing the previous install at ${dest} in ${distro}…`);
    const removed = await runInDistro(distro, `rm -rf ${guestDest}`, GUEST_PROBE_MS);
    if (removed.code !== 0) {
      throw new Error(`Could not remove ${dest} in ${distro}: ${removed.stderr.trim() || `exit ${removed.code}`}`);
    }
  }
  if (signal.aborted) throw new AbortedError();

  emit('unpack', 0, `Unpacking inside ${distro} — this takes a few minutes.`);
  const command = `mkdir -p ${guestDest} && tar -xzf ${guestArchive} -C ${guestDest}`;

  // Streamed rather than collected, for the reason wsl.ts's streamInDistro
  // exists: minutes of silence is indistinguishable from a hang. tar is quiet on
  // success, so what this actually forwards is the first error it hits.
  const handle = streamInDistro(distro, command, (line) => emit('unpack', 0, line));
  const timer = setTimeout(() => handle.cancel(), GUEST_UNPACK_MS);
  const onAbort = (): void => handle.cancel();
  signal.addEventListener('abort', onAbort, { once: true });

  const result = await handle.done.finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  });

  if (signal.aborted) throw new AbortedError();
  if (result.failure) throw new Error(`Unpacking in ${distro} failed: ${result.failure}`);
  if (result.code !== 0) {
    throw new Error(
      `tar exited ${result.code} unpacking into ${dest} inside ${distro}. `
      + 'The usual cause is no room left on the distro\'s disk — the environment needs about 12 GB unpacked.',
    );
  }
}

/**
 * The manifest the archive carries, as a clause to hang off the success line.
 * Never fatal: an environment whose interpreter is there and runs is installed
 * whether or not we could pretty-print what is in it.
 */
async function readManifest(target: EnvTarget, dest: string, distro: string | null): Promise<string> {
  const file = markerPath(target, dest);
  try {
    const text = distro
      ? (await runInDistro(distro, `cat ${shellQuote(file)}`, GUEST_PROBE_MS)).stdout
      : fs.readFileSync(file, 'utf8');
    const parsed: unknown = readJson(text);
    if (typeof parsed !== 'object' || parsed === null) return '.';
    const record = parsed as Record<string, unknown>;
    // The built archives write `python`; `python-version` is accepted too so a
    // manifest that gets renamed does not silently stop being printed.
    const version = record['python'] ?? record['python-version'];
    const packages = record['packages'];
    const bits: string[] = [];
    if (typeof version === 'string') bits.push(`python ${version}`);
    if (Array.isArray(packages)) bits.push(...packages.map(String));
    else if (packages && typeof packages === 'object') {
      bits.push(...Object.entries(packages as Record<string, unknown>).map(([k, v]) => `${k} ${String(v)}`));
    }
    return bits.length > 0 ? ` (${bits.join(', ')}).` : '.';
  } catch {
    return '.';
  }
}
