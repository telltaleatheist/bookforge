/**
 * The startup sweep: which installed components are out of date, and (for the
 * foundry CLI) whether a release newer than the pin has been published.
 *
 * Runs once per launch, after the window has loaded, and its result is a LIST —
 * it downloads nothing itself. The renderer feeds that list to
 * SetupDownloadService, so the upgrades run through the same queue, the same
 * `componentManager.install()`, the same checksum verification and the same
 * bottom-right download shelf as every other download in the app. Nothing here
 * is a second installer or a second widget.
 *
 * Three properties this module is responsible for:
 *
 *  - **It never blocks startup.** Everything is async and every failure is
 *    caught and REPORTED rather than thrown. The app opens whether or not the
 *    network answers; a check that could not be completed becomes a line in the
 *    shelf saying so, never a modal and never a window that does not appear.
 *  - **It never installs what is not installed.** The verdicts come from
 *    `planUpgrade`, whose first rule is exactly that. Several managed components
 *    are 2–4 GB (docs/DISTRIBUTION.md §4) and a startup check that began
 *    fetching one the user had deliberately skipped would be a bug.
 *  - **It never touches an external or env-pinned component.** Also `planUpgrade`
 *    rules, applied to every component rather than remembered per call site.
 */

import { componentManager, isInstalling } from './component-manager';
import { planUpgrades, upgradesFrom, type UpgradeCandidate } from './component-upgrades';
import { FOUNDRY_CLI_COMPONENT_ID, setDiscoveredFoundryRelease } from './foundry-cli-components';
import { checkFoundryRelease } from './foundry-release-check';
import type { ComponentStatus } from './component-types';

/** One component to move, as the renderer receives it. */
export interface ComponentUpgrade {
  id: string;
  name: string;
  fromVersion: string;
  toVersion: string;
}

/**
 * The sweep's result.
 *
 * `problems` is not an error channel that someone forgot to throw on — it is the
 * product. A release published without its checksums, or a GitHub that would not
 * answer, is something the user is told about in the shelf; the rest of the
 * sweep still runs, because one unreachable host is no reason to leave three
 * other stale components unmentioned.
 */
export interface StartupUpgradeReport {
  upgrades: ComponentUpgrade[];
  problems: string[];
}

/** Is this component's detect-spec env var set to something on this machine? */
function envPinned(status: ComponentStatus): boolean {
  const name = status.component.detect?.envVar;
  if (!name) return false;
  return (process.env[name] ?? '').trim() !== '';
}

/**
 * Ask GitHub whether foundry has a release newer than the pin, and adopt it.
 *
 * Gated on foundry ALREADY being installed as a managed component: a machine
 * with no foundry has nothing to upgrade, and asking anyway would put a network
 * call — and, offline, a shelf complaint — in front of a user who never opted
 * into this component at all. Returns a problem line instead of throwing; the
 * refusals `checkFoundryRelease` raises (a release with no `checksums.txt`, a
 * tarball with no hash, no artifact for this platform) are exactly what belongs
 * in front of a user, and none of them should take the rest of the sweep down.
 */
async function adoptNewerFoundryRelease(statuses: ComponentStatus[]): Promise<string | null> {
  const foundry = statuses.find((s) => s.component.id === FOUNDRY_CLI_COMPONENT_ID);
  if (!foundry) return null;
  if (foundry.installed?.source !== 'managed') return null;
  if (envPinned(foundry)) return null;

  try {
    const release = await checkFoundryRelease();
    if (!release) return null;
    setDiscoveredFoundryRelease(release);
    console.log(`[updates] foundry ${release.version} is published and newer than the pin — adopting it`);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[updates] foundry release check failed: ${message}`);
    return `Could not check for a newer Foundry CLI: ${message}`;
  }
}

/**
 * Everything installed that the catalog now names a different version for.
 *
 * The foundry release check runs FIRST and re-lists afterwards, because adopting
 * a release changes what the catalog says foundry's version is — and the whole
 * point of the sweep is to compare the record against the catalog. Re-listing is
 * how the discovery reaches the comparison without this function knowing
 * anything special about foundry.
 */
export async function checkForComponentUpgrades(): Promise<StartupUpgradeReport> {
  const problems: string[] = [];

  let statuses: ComponentStatus[];
  try {
    statuses = await componentManager.listStatus();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[updates] could not read the component list: ${message}`);
    return { upgrades: [], problems: [`Could not check installed add-ons for updates: ${message}`] };
  }

  const foundryProblem = await adoptNewerFoundryRelease(statuses);
  if (foundryProblem) problems.push(foundryProblem);
  if (!foundryProblem) {
    // Only re-read when the check ran to completion — a failed check changed
    // nothing, and a second full listStatus() is detection work for no answer.
    try {
      statuses = await componentManager.listStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`Could not re-read installed add-ons after the Foundry check: ${message}`);
    }
  }

  const candidates: UpgradeCandidate[] = statuses.map((s) => ({
    id: s.component.id,
    name: s.component.name,
    targetVersion: s.component.version,
    supportsManaged: s.component.acquisition.includes('managed'),
    installed: s.installed ? { source: s.installed.source, version: s.installed.version } : null,
    envPinned: envPinned(s),
    installing: isInstalling(s.component.id),
    // Foundry alone can be ahead of the catalog: it is the one component whose
    // version can come from a release discovered at runtime, so a launch that
    // starts offline sees only the pin and must not drag it backwards. Every
    // other component's version comes from the catalog and nowhere else.
    mayBeAheadOfCatalog: s.component.id === FOUNDRY_CLI_COMPONENT_ID,
  }));

  const plan = planUpgrades(candidates);
  const upgrades = upgradesFrom(plan).map((p) => ({
    id: p.id,
    name: p.name,
    // `planUpgrade` only ever returns 'upgrade' for an installed component, so
    // fromVersion is non-null here; the ?? keeps the wire type free of a null
    // the renderer would have to render as something.
    fromVersion: p.fromVersion ?? '',
    toVersion: p.toVersion,
  }));

  for (const item of plan) {
    if (item.verdict === 'upgrade') {
      console.log(`[updates] ${item.id}: upgrade — ${item.reason}`);
    }
  }
  if (upgrades.length === 0 && problems.length === 0) {
    console.log('[updates] every installed component is at the version the catalog names');
  }

  return { upgrades, problems };
}
