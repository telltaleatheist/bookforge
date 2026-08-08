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
 *  0. It is CONTENT rather than a tool → keep, always. Owen, 2026-08-05: "the
 *     only situation in which a voice will be downloaded again is if its fully
 *     missing. they dont have versions." Weights are present or absent. A voice,
 *     a Stanza pack, a Whisper model, the page-layout GGUF — you have it or you
 *     do not, and the thing a user wants from a voice is the voice they already
 *     chose, not a newer one arriving unasked at launch. Tools are the opposite:
 *     a CLI at the wrong version breaks the pipeline, which is why upgrading it
 *     is maintenance rather than surprise. The `version` field on a voice asset
 *     is still a real lever — `rvc-voice-assets.json` documents it as "bump
 *     (with a new tarball) to force a re-download + re-extract" — but that lever
 *     belongs to the explicit install path, where a user asked for something,
 *     never to a background sweep.
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
 *  6b. The RECORD does not carry a version → keep. This is rule 6 from the other
 *     side and it is the one that got away: on 2026-08-05 the first Mac launch
 *     re-downloaded the US Female 1 RVC voice. Its record said `version: ''`
 *     (every voice record is written that way — see `installed-voices.ts` and
 *     `rvc-voice-components.ts`), the catalog names `2026.06.25`, and
 *     `'' !== '2026.06.25'` read as stale. It is not stale; it is UNKNOWN. An
 *     absent version is not version zero, and the difference matters because
 *     the remedy is a multi-gigabyte transfer of something already on disk.
 *     Windows escaped it only by not having that voice installed.
 *     Re-downloading on a guess is precisely what a NO FALLBACK rule forbids:
 *     when the fact needed to decide is missing, the answer is to do nothing and
 *     say so, not to assume the worse of the two possibilities.
 *  7. Versions equal → keep.
 *  8. Otherwise → upgrade. Note this is version INEQUALITY, not "is newer": the
 *     wanted version is whatever the catalog now names, and the catalog is the
 *     authority for a copy BookForge itself put there. A deliberate ROLLBACK —
 *     Owen moving `RVC_ENV_VERSION` back to a known-good tarball, or a bad
 *     foundry release being yanked so an older tag becomes latest again — has to
 *     reach machines, and it does so by exactly this rule.
 *
 * There used to be a rule between 7 and 8: "a component that may legitimately be
 * ahead of the catalog is left alone when the installed version is newer". It
 * existed for one component, foundry, and for one situation — a launch that
 * started offline could only see the PINNED foundry version, so without it a
 * machine that had taken a newer release would be dragged back to the pin. The
 * pin is gone (foundry-cli-components.ts): the newest published release is now
 * foundry's only authority, and offline that component reports version '' and is
 * kept by rule 6 instead. With no pin there is nothing to be "ahead" of, so the
 * rule protected nothing and blocked rollbacks.
 */

import type { ComponentKind } from './component-types';

/**
 * The kinds whose version is a fact about COMPATIBILITY rather than about
 * content — a tool at the wrong version breaks the pipeline that drives it, so
 * keeping it current is maintenance of a choice the user already made.
 *
 * Everything absent from this set is weights: `tts-model`, `rvc-model`,
 * `language-pack`, `stt-model`. Those are present or absent (rule 0). `system`
 * is here-or-not by definition and has nothing to download.
 */
const TOOL_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'binary', 'conda-env', 'foundry-cli',
]);

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
   * What this component IS, which decides whether "a newer version exists" is
   * even a question worth asking about it. See rule 0.
   */
  kind: ComponentKind;
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

/** The verdict for one component. See the header for the ordered rules. */
export function planUpgrade(c: UpgradeCandidate): UpgradePlanItem {
  const base = {
    id: c.id,
    name: c.name,
    fromVersion: c.installed ? c.installed.version : null,
    toVersion: c.targetVersion,
  };
  const keep = (reason: string): UpgradePlanItem => ({ ...base, verdict: 'keep', reason });

  if (!TOOL_KINDS.has(c.kind)) {
    // Rule 0. Content is present or absent — it is never upgraded in the
    // background. Listed as the kinds that ARE tools rather than the kinds that
    // are not, so a new content kind is silent by default and only a deliberate
    // edit here can put weights back into the startup sweep.
    return keep(`a ${c.kind} is downloaded when it is missing, not when a version moves`);
  }
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
  if (!c.installed.version) {
    // Rule 6b. The record carries no version, so there is nothing to compare —
    // and an unrecorded version is UNKNOWN, not old. Every voice record is
    // written with `version: ''`, so treating that as stale re-downloads
    // gigabytes of model weights that are already on disk (measured: a Mac's
    // first launch fetched the US Female 1 RVC voice for exactly this reason).
    return keep(
      'installed, but no version was recorded for it — nothing to compare against '
      + `the catalog's ${c.targetVersion}, and an absent version is not an old one`
    );
  }
  if (c.installed.version === c.targetVersion) {
    return keep(`up to date at ${c.targetVersion}`);
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
