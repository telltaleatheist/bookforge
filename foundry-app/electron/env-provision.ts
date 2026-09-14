/**
 * env-provision — deciding, at startup, which environments this machine is
 * missing, and putting them in the queue.
 *
 * The app provisions ITSELF. A user who installs foundry and opens a PDF should
 * not first have to read a settings screen and press a button labelled with a
 * word ("rasteriser") they have no reason to know. So on startup the app asks
 * the engine what it can do, and whatever is missing goes into the shelf as a
 * job, beside the conversions, cancellable like them.
 *
 * ── The engine's verdict, never our own re-derivation ────────────────────────
 *
 * The check is `foundry doctor --json` and nothing else. It is tempting to look
 * at `backend.python` and test whether the file exists — and it is WRONG: the
 * engine has its own candidate list and routinely finds a perfectly good PyMuPDF
 * that this app never installed (BookForge's e2a environment, a conda env, a
 * system python). Deriving "missing" from an unset settings key would download
 * sixty megabytes over the top of a working install and then point the engine at
 * ours instead of the one it was happy with. doctor already answers the actual
 * question — "can a run rasterise a page" — so that answer is the one used.
 *
 * ── Never install what the machine cannot use ────────────────────────────────
 *
 * Each rule below is a conjunction of things doctor measured. The WSL
 * environment in particular is ~5 GB and is provisioned only when the settings
 * say the user WANTS a local endpoint, the vLLM tier is not already available,
 * and WSL is actually present. A machine with no distro is never asked to
 * download a Linux Python it has nowhere to put.
 *
 * ── What is NOT provisioned from here ────────────────────────────────────────
 *
 * The local page reader. It is three gigabytes of model weights plus a
 * llama.cpp build, it has a row on the settings screen and a step in the
 * wizard, and a download that size starts when somebody presses a button that
 * says how big it is — never at startup on this file's judgement
 * (`page-reader.ts`, docs/SLOTS.md §6).
 */
import { runDoctor } from './engine';
import { targetsForPlatform } from './env-catalog';
import { readSettings } from './settings';
import type { DoctorReport, EnvTarget, SettingsView } from '../shared/types';

export interface ProvisionNeed {
  target: EnvTarget;
  /** What doctor said that makes this missing. Shown on the shelf row. */
  reason: string;
}

/**
 * doctor's report + the settings file -> what to fetch. Pure, so the rules can
 * be argued with (and checked) without a five-gigabyte download attached.
 *
 * A null report means doctor could not be run at all. Nothing is provisioned in
 * that case: an app that cannot ask the engine what it needs has no business
 * guessing, and the settings screen already shows why there is no report.
 */
export function decideProvisioning(
  report: DoctorReport | null,
  settings: SettingsView,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ProvisionNeed[] {
  if (!report) return [];

  const offerable = new Set(targetsForPlatform(platform, arch));
  const needs: ProvisionNeed[] = [];
  const tier = (id: string): boolean => report.tiers.find((t) => t.id === id)?.available === true;

  const want = (target: EnvTarget, reason: string): void => {
    if (offerable.has(target)) needs.push({ target, reason });
  };

  if (platform === 'win32') {
    // Every tier rasterises locally before anything reads. No PyMuPDF anywhere
    // on this machine means no conversion of any kind can run.
    if (!report.rasteriser.available) {
      want('windows-x64', `The engine found no PyMuPDF to rasterise with: ${report.rasteriser.detail}`);
    }

    /*
     * THE READING SERVER IS NOT PROVISIONED FROM HERE ANY MORE.
     *
     * A `wsl-x64` rule used to stand at this line and queue five gigabytes of
     * vLLM wheels into a WSL distro whenever the mode was `endpoint` and the URL
     * was loopback. The local page reader replaced it (docs/SLOTS.md §6, package
     * B), and it is deliberately NOT provisioned automatically: it is three
     * gigabytes of weights, it has a row of its own on the settings screen and a
     * step of its own in the wizard, and a download that size begins when
     * somebody presses a button that says how big it is.
     */
  }

  if (platform === 'darwin') {
    // One archive carries both, so one missing tier is not enough to justify
    // 220 MB — a Mac with a working MLX and a working PyMuPDF needs nothing, and
    // a Mac missing only one of them is better served by the settings screen
    // than by this app writing over whichever half already worked.
    if (!tier('mlx') && !report.rasteriser.available) {
      want('mac-arm64', `Neither MLX nor a rasteriser is available: ${report.rasteriser.detail}`);
    }
  }

  return needs;
}

/**
 * Ask the engine, then decide. Never throws — a doctor that will not run is an
 * empty list and a sentence, not a startup that fails.
 */
export async function planProvisioning(): Promise<{ needs: ProvisionNeed[]; note: string }> {
  const result = await runDoctor();
  if (!result.ok) {
    return { needs: [], note: `Nothing was provisioned: ${result.reason}` };
  }
  const settings = readSettings();
  const needs = decideProvisioning(result.report, settings);
  return {
    needs,
    note: needs.length === 0
      ? 'Every environment this machine needs is already there.'
      : `Missing: ${needs.map((n) => n.target).join(', ')}.`,
  };
}
