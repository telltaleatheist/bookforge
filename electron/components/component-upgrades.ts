/**
 * Which installed components are stale, and what should happen to each.
 *
 * This is the generalisation of the one upgrade rule the app already had:
 * `ensureFoundryPath` (electron/foundry-bridge.ts) compared a MANAGED install's
 * recorded version against the catalog's and reinstalled on a mismatch — but only
 * lazily, on the next pass that happened to need foundry. The rule was right; its
 * timing was not, and it existed for exactly one component. Here it is a pure
 * function over facts, so the startup sweep and foundry-bridge decide the same way
 * about the same component instead of drifting apart.
 *
 * NOTHING in this file does IO. It takes the facts (what the catalog names, what
 * installed.json records, whether an env var pins the path, whether an install is
 * already running) and returns a verdict with the reason it reached it. The reason
 * is not decoration: an upgrade that a user did not ask for has to be able to
 * explain itself in a log, and a component that was DELIBERATELY left alone has to
 * be distinguishable from one that was overlooked.
 *
 * ── The rules, in the order they are applied ─────────────────────────────────
 *
 *  1. Not installed → keep. A startup check that begins a multi-gigabyte download
 *     of an engine the user deliberately never installed is a bug, not a feature.
 *     Several of these artifacts are 2–4 GB (docs/DISTRIBUTION.md §4). Upgrading
 *     is maintenance of a choice already made; installing is a new choice, and it
 *     is the user's.
 *  2. Already installing → keep. Another code path (a first-run batch, an
 *     Add-ons click, a pass that needed foundry) is mid-transfer into the very
 *     directory this would replace.
 *  3. Env-var pinned → keep. `FOUNDRY_CLI_PATH` and friends are a developer
 *     running a build of their own; replacing it would be the app overruling a
 *     deliberate choice, and it could not even succeed — resolution reads the env
 *     var, not the managed directory.
 *  4. Recorded as an EXTERNAL install → keep, for the same reason: a path set in
 *     Settings → Add-ons is honored at whatever version it is.
 *  5. No managed acquisition mode → keep. There is nothing to download.
 *  6. The catalog does not version it (version: '') → keep. Calibre and Tesseract
 *     are detected, not versioned; "'' !== '6.29.0'" is not staleness.
 *  7. Versions equal → keep.
 *  8. The component can be legitimately AHEAD of the catalog, both versions are
 *     semver, and the installed one is newer → keep. A downgrade is not an
 *     upgrade. This is what keeps a machine that took a newer-than-the-pin GitHub
 *     release (see foundry-release-check.ts) from being dragged back to the pin
 *     on the next launch that starts offline, where the catalog can only offer
 *     the pin.
 *
 *     Deliberately narrow on BOTH counts. It needs the caller to say the
 *     component has a runtime-discovery path at all (`mayBeAheadOfCatalog`),
 *     because for everything else the catalog is the only authority and an
 *     installed version it does not name is stale in either direction — Owen
 *     rolling `RVC_ENV_VERSION` back to a known-good tarball must still reach
 *     machines. And it needs both strings to be X.Y.Z, because most version
 *     constants here are not semver ('b7482' for llama.cpp) and ordering them
 *     would invent a meaning they do not have. Note that the date-stamped env
 *     versions ('2026.06.16') DO parse as X.Y.Z and order chronologically — which
 *     is why rule 8 is gated on the flag and not on the shape alone.
 *  9. Otherwise → upgrade. Note this is version INEQUALITY, not "is newer": a
 *     bump is whatever the catalog now names, and the catalog is the authority
 *     for a copy BookForge itself put there.
 */

import { gt } from '../update/semver';

/** The facts about one component, gathered by the caller. */
export interface UpgradeCandidate {
  id: string;
  /** Display name, carried through to the verdict so the UI needs no second lookup. */
  name: string;
  /** The version the catalog names right now. '' when the component is unversioned. */
  targetVersion: string;
  /** Does this component offer a managed download at all? */
  supportsManaged: boolean;
  /** What installed.json records, or null when nothing is installed. */
  installed: { source: 'managed' | 'external'; version: string } | null;
  /** True when this component's DetectSpec env var is set on this machine. */
  envPinned: boolean;
  /** True when a managed install for this id is already in flight. */
  installing: boolean;
  /**
   * True when an installed version NEWER than the catalog's is a legitimate
   * on-disk state — i.e. this component can adopt a release discovered at
   * runtime, so the catalog is not its only authority. Today that is the foundry
   * CLI alone. Leave it false for anything the catalog fully controls: there, an
   * installed version the catalog does not name is stale in either direction,
   * and a deliberate rollback of the pin has to reach machines.
   */
  mayBeAheadOfCatalog?: boolean;
}

export type UpgradeVerdict = 'upgrade' | 'keep';

export interface UpgradePlanItem {
  id: string;
  name: string;
  verdict: UpgradeVerdict;
  /** The recorded version, or null when nothing is installed. */
  fromVersion: string | null;
  /** The version the catalog names (echoed even on 'keep', for the log). */
  toVersion: string;
  /** Why this verdict. Always set. */
  reason: string;
}

/** Does this string parse as an X.Y.Z version, so that ordering it means something? */
export function isSemver(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(version.trim());
}

/**
 * Pick the version to install for a component whose catalog pin may have been
 * superseded by a release discovered on the host.
 *
 * The pin WINS on a tie and whenever it is newer: a pin ahead of the newest
 * release is a version bump whose release is not published yet (or was rolled
 * back), and following the release there would be a downgrade. `release` is null
 * when nothing was discovered — offline, or nothing newer exists.
 */
export function chooseTargetVersion(
  pin: string,
  release: string | null
): { version: string; from: 'pin' | 'release'; reason: string } {
  if (!release) {
    return { version: pin, from: 'pin', reason: `no published release newer than the pinned ${pin}` };
  }
  if (!isSemver(pin) || !isSemver(release)) {
    return {
      version: pin,
      from: 'pin',
      reason:
        `cannot order "${release}" against the pinned "${pin}" — one of them is not X.Y.Z, `
        + 'so there is no way to tell which is newer; keeping the pin',
    };
  }
  if (gt(release, pin)) {
    return { version: release, from: 'release', reason: `release ${release} is newer than the pinned ${pin}` };
  }
  return { version: pin, from: 'pin', reason: `pinned ${pin} is at or ahead of the newest release ${release}` };
}

/** The verdict for one component. See the header for the ordered rules. */
export function planUpgrade(c: UpgradeCandidate): UpgradePlanItem {
  const base = {
    id: c.id,
    name: c.name,
    fromVersion: c.installed ? c.installed.version : null,
    toVersion: c.targetVersion,
  };
  const keep = (reason: string): UpgradePlanItem => ({ ...base, verdict: 'keep', reason });

  if (!c.installed) {
    return keep('not installed — a startup check upgrades what is here, it never installs what is not');
  }
  if (c.installing) {
    return keep('an install for this component is already running');
  }
  if (c.envPinned) {
    return keep('an environment variable pins this to a build of your own');
  }
  if (c.installed.source !== 'managed') {
    return keep('installed externally — BookForge did not put it there and will not replace it');
  }
  if (!c.supportsManaged) {
    return keep('no managed download exists for this component');
  }
  if (c.targetVersion === '') {
    return keep('the catalog does not version this component');
  }
  if (c.installed.version === c.targetVersion) {
    return keep(`up to date at ${c.targetVersion}`);
  }
  if (
    c.mayBeAheadOfCatalog === true
    && isSemver(c.installed.version)
    && isSemver(c.targetVersion)
    && gt(c.installed.version, c.targetVersion)
  ) {
    return keep(
      `installed ${c.installed.version} is newer than the catalog's ${c.targetVersion} — a downgrade is not an upgrade`
    );
  }
  return {
    ...base,
    verdict: 'upgrade',
    reason: `installed ${c.installed.version}, catalog names ${c.targetVersion}`,
  };
}

/** Every candidate's verdict, in the order given. */
export function planUpgrades(candidates: UpgradeCandidate[]): UpgradePlanItem[] {
  return candidates.map(planUpgrade);
}

/** Just the ones to act on. */
export function upgradesFrom(plan: UpgradePlanItem[]): UpgradePlanItem[] {
  return plan.filter((p) => p.verdict === 'upgrade');
}
