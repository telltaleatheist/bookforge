/**
 * The Doctor — one page that says what this machine is missing, and fixes it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-17: *"the user wont be able to function without ffmpeg or tools
 * python environment. those shouldnt be on the settings page. maybe we can
 * consolidate all necessary components into a single page with a doctor or
 * something so they can re-download missing dependencies"* — and *"it can do it
 * by downloading the environment from gh releases again and reinstalling it,
 * just like when they reach the original setup page"*.
 *
 * The things this app cannot run without were spread across two settings
 * sections and two unrelated mechanisms. **Settings → Advanced** held ffmpeg,
 * conda and the tools Python env as raw text boxes with a Browse button, which
 * asks a person to know a path. **Settings → General Add-ons** held Calibre and
 * the Foundry CLI as "add-ons", which is the wrong word for a thing the system
 * does not function without. Neither offered the one action that actually fixes
 * a broken machine: fetch it again.
 *
 * ── Two mechanisms, one list ────────────────────────────────────────────────
 *
 * There are genuinely two systems underneath and this does NOT unify them,
 * because they are different things:
 *
 * - `tool-paths.ts` resolves BINARIES and ENVIRONMENTS by looking at the disk
 *   (`getToolStatus()`), and `tools-env-bootstrap.ts` can re-download the tools
 *   env from a GitHub release (`ensureToolsEnv()`). That is the repair Owen
 *   described, and it already existed — `doRuntimeSetup()` in `main.ts` calls
 *   exactly this on first run.
 * - `components/component-manager.ts` owns catalogued components with install,
 *   verify and locate (`calibre`). The foundry engine is not a component any
 *   more: it ships inside `foundry-app/engine/` (2026-09-24), so there is
 *   nothing of it to check, fix or download here.
 *
 * What this module adds is a SINGLE READING over both, in the vocabulary a
 * person has: is it here, is it broken, and what happens when I press Fix.
 *
 * ── What "required" means, and why Calibre is not ───────────────────────────
 *
 * `required: true` means the app cannot do its job without it. Calibre is
 * deliberately NOT required: measured 2026-09-17, it converts Kindle and legacy
 * formats (`.azw3 .mobi .kfx .fb2 .lit .docx .rtf .cbz …`) to EPUB, and PDF is
 * NOT in that list — the document vision model reads those. So a machine with
 * no Calibre opens EPUBs and PDFs perfectly well and is missing one import
 * path. Calling that "broken" would send people to install 200 MB they may
 * never need.
 *
 * ── This module REPORTS; it does not decide to repair ───────────────────────
 *
 * `check()` reads and changes nothing, so it is safe to run on every visit to
 * the page. `fix()` acts, and only on the one id it is given. Nothing here
 * sweeps or repairs on startup: a download is a thing a person chooses.
 */
import type { ComponentStatus } from './components/component-types';

/** How healthy one necessary thing is. */
export type DoctorState = 'ok' | 'missing' | 'broken';

/**
 * What pressing Fix will do. Named rather than inferred at the call site,
 * because the button's LABEL is drawn from this and a button whose words are
 * guessed is a button that lies on some machine.
 */
export type DoctorFix =
  /** Re-download the tools env tarball from its GitHub release and unpack it. */
  | 'reinstall-env'
  /** `componentManager.install(id)` — a catalogued, managed install. */
  | 'install-component'
  /** An external vendor installer (Calibre's own .msi/.dmg). */
  | 'run-installer'
  /** Nothing here can repair it; the person is told what to do instead. */
  | 'none';

export interface DoctorCheck {
  readonly id: string;
  readonly name: string;
  /** One line: what it does for this app. */
  readonly description: string;
  readonly state: DoctorState;
  /** What was actually observed. Shown under the name. */
  readonly detail: string;
  /** Where it was found, when it was. */
  readonly path: string | null;
  readonly fix: DoctorFix;
  /** True when the app cannot do its job without this. */
  readonly required: boolean;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** True when every REQUIRED check is ok. Optional ones do not count. */
  readonly healthy: boolean;
}

type ToolStatus = { configured: boolean; detected: boolean; path: string };

/**
 * The tools Python environment: assembly, resume, whisper and the metadata
 * tools all run through it.
 *
 * BROKEN vs MISSING is a real distinction here and it decides the sentence a
 * person reads. `toolsEnvPath` stated in `tool-paths.json` but pointing at a
 * directory that is not there is BROKEN — somebody configured something and it
 * has since moved — and the fix is different from never having had one.
 */
function toolsEnvCheck(status: ToolStatus | undefined, hasManaged: boolean): DoctorCheck {
  const found = status?.detected === true;
  const stated = status?.configured === true;
  return {
    id: 'tools-env',
    name: 'Tools Python environment',
    description: 'Runs audiobook assembly, session resume, whisper and the metadata tools.',
    state: found ? 'ok' : stated ? 'broken' : 'missing',
    detail: found
      ? (stated ? 'Using the environment you pointed at.' : 'Installed and working.')
      : stated
        ? 'You pointed BookForge at an environment that is no longer there.'
        : 'Not installed on this computer.',
    path: found ? (status?.path ?? null) : null,
    // Only offer a download where there IS one to download. A dev checkout runs
    // on its own interpreter and has nothing published to fetch; offering the
    // button there would fail in a way that looks like a broken download.
    fix: found ? 'none' : hasManaged ? 'reinstall-env' : 'none',
    required: true,
  };
}

/**
 * ffmpeg. Note the fix: the tools env SHIPS one, so on a machine with no system
 * ffmpeg the repair is to install that env rather than to send somebody to go
 * and find a binary. That is why this check reads the env's health too.
 */
function ffmpegCheck(
  status: ToolStatus | undefined,
  envOk: boolean,
  hasManaged: boolean,
): DoctorCheck {
  const found = status?.detected === true;
  return {
    id: 'ffmpeg',
    name: 'FFmpeg',
    description: 'Converts and writes every audio file BookForge produces.',
    state: found ? 'ok' : 'missing',
    detail: found
      ? (status?.configured ? 'Using the ffmpeg you pointed at.' : 'Found on this computer.')
      : envOk
        ? 'Not found. Install it, or point BookForge at one below.'
        : 'Not found. The tools Python environment ships one — installing that fixes this too.',
    path: found ? (status?.path ?? null) : null,
    fix: found ? 'none' : (!envOk && hasManaged) ? 'reinstall-env' : 'none',
    required: true,
  };
}

/** A catalogued component, read into the same vocabulary as the tool checks. */
function componentCheck(
  id: string,
  name: string,
  description: string,
  required: boolean,
  found: ComponentStatus | undefined,
  installable: boolean,
  hasExternalInstaller: boolean,
): DoctorCheck {
  // `installed` is a RECORD, not a boolean — its presence is the fact, and its
  // `entryPath` is where the thing actually resolved to. Read as a boolean this
  // was always truthy, which the typechecker caught before it could ship a page
  // reporting every component as fine.
  const record = found?.installed;
  const ok = record !== undefined;
  return {
    id,
    name,
    description,
    state: ok ? 'ok' : 'missing',
    detail: ok
      ? `Installed${record?.version ? ` (${record.version})` : ''}.`
      : required
        ? 'Not installed. BookForge needs this.'
        : 'Not installed. Only needed to open Kindle and other non-EPUB formats.',
    path: record?.entryPath ?? null,
    fix: ok
      ? 'none'
      : installable
        ? 'install-component'
        : hasExternalInstaller
          ? 'run-installer'
          : 'none',
    required,
  };
}

export interface DoctorInputs {
  readonly tools: Record<string, ToolStatus> | null;
  readonly components: readonly ComponentStatus[];
  readonly hasManagedEnv: boolean;
  /** Component ids `componentManager.install()` can fetch on this platform. */
  readonly installableIds: readonly string[];
  /** Component ids with a vendor installer for this platform. */
  readonly externalInstallerIds: readonly string[];
}

/**
 * Compose the report. PURE — every observation is an argument, so the whole
 * thing is testable on a machine that has none of these installed, which is
 * exactly the machine whose behaviour matters most here.
 */
export function composeReport(inputs: DoctorInputs): DoctorReport {
  const tool = (key: string): ToolStatus | undefined => inputs.tools?.[key];
  const component = (id: string): ComponentStatus | undefined =>
    inputs.components.find((row) => row.component?.id === id);

  const env = toolsEnvCheck(tool('toolsEnv'), inputs.hasManagedEnv);
  const checks: DoctorCheck[] = [
    env,
    ffmpegCheck(tool('ffmpeg'), env.state === 'ok', inputs.hasManagedEnv),
    componentCheck(
      'calibre',
      'Calibre',
      'Converts Kindle and other non-EPUB formats so they can be opened.',
      false,
      component('calibre'),
      inputs.installableIds.includes('calibre'),
      inputs.externalInstallerIds.includes('calibre'),
    ),
  ];

  return {
    checks,
    healthy: checks.every((row) => !row.required || row.state === 'ok'),
  };
}
