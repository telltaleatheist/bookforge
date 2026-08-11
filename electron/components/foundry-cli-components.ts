/**
 * The `foundry` CLI as an optional component.
 *
 * Foundry (github.com/telltaleatheist/foundry) is the standalone binary that
 * reads a PDF's pages with a document vision model and assembles an EPUB.
 * BookForge drives it as a subprocess — see `electron/foundry-bridge.ts`.
 *
 * It was once the extraction of this app's page-layout model, OCR-repair edit
 * contract and footnote-marker remover, and BookForge read the run directory
 * those stages wrote. Both halves of that dropped the pipeline in Aug 2026 —
 * BookForge first, foundry after (its `pre-vlm-strip` tag is the last build that
 * had it) — so there is no run directory on either side of the process boundary.
 *
 * It is declared here so it flows through the SAME ComponentService
 * download/install/verify/remove machinery as Calibre, the voices and the model
 * GGUFs, rather than needing a bespoke downloader and a bespoke settings row.
 *
 * ── The download is the ordinary path ────────────────────────────────────────
 *
 * The foundry repository is PUBLIC, so the release assets below are fetchable
 * unauthenticated and the managed install is the normal way a machine gets a
 * foundry. `acquisition` lists managed first for that reason, and a run that
 * needs foundry and cannot find one downloads it rather than stopping to ask —
 * see `ensureFoundryPath` in `electron/foundry-bridge.ts`.
 *
 * The EXTERNAL path stays fully supported and still WINS when it is configured:
 * `FOUNDRY_CLI_PATH`, or a path set on this component in Settings → Add-ons, is
 * a developer running a build of their own, and an auto-download that quietly
 * replaced it would be this app overruling a deliberate choice.
 *
 * ── There is no pinned version, and nothing to paste ─────────────────────────
 *
 * THE NEWEST PUBLISHED RELEASE IS THE VERSION. This component has no constant to
 * bump and no hashes committed beside it: `checkFoundryRelease` asks GitHub what
 * the latest release is, reads every artifact's sha256 out of that release's own
 * `checksums.txt`, and hands the result to `setDiscoveredFoundryRelease` below.
 * From that moment this component describes that release — its version, its URLs
 * and its hashes.
 *
 * It used to carry a pinned version and four pasted sha256s, and the pasted hash
 * was a genuinely stronger guarantee: two independent assertions, one of them
 * shipped inside the app binary where the release host cannot reach it. It was
 * dropped deliberately (Owen, 2026-08-08) because foundry is rebuilt and
 * republished several times a day and often several times an hour, and a scheme
 * that needs a human to copy four hashes before the app can see a release is a
 * scheme that guarantees the app is behind. The cost is stated plainly at the top
 * of `foundry-release-check.ts`: verification still happens on every download,
 * but it defends against a corrupt transfer rather than against a compromised
 * repository.
 *
 * Two consequences follow, and both are intended:
 *
 *  - **A rollback lands like an upgrade.** The rule is version INEQUALITY, not
 *    "is newer" — if the newest release goes backwards because a bad build was
 *    yanked, machines follow it. Nothing here can be "ahead" of the authority,
 *    because the authority is whatever GitHub says right now.
 *  - **Offline, this component has no artifacts and no version.** That is the
 *    honest state rather than a stale constant pretending to be current: with no
 *    release discovered there is nothing to download and nothing to compare
 *    against, so `planUpgrade` leaves the installed copy alone (rule 6) and a
 *    machine with no foundry at all is told it needs the network.
 *
 * `effectiveFoundryVersion()` is the SINGLE answer to "which foundry should be on
 * this machine", and everything deciding whether an install is stale reads it.
 */

import type { OptionalComponent, Platform, Arch } from './component-types';

/** Component id. Also the key `componentManager.resolveEntry` is asked for. */
export const FOUNDRY_CLI_COMPONENT_ID = 'foundry-cli';

/** Environment variable holding an explicit path to the binary. */
export const FOUNDRY_CLI_ENV_VAR = 'FOUNDRY_CLI_PATH';

/**
 * What each platform's artifact is CALLED. Names only — no version, no hashes.
 *
 * This is the naming contract `tools/release-package.sh` produces and
 * docs/DISTRIBUTION.md §2.3 documents: a program reads these, not just a person.
 * It lives here so the release check reads the names from one place rather than
 * re-deriving them, because two places composing the same filename is how one of
 * them ends up subtly different and installs break on a single platform, quietly,
 * until somebody on that platform tries.
 */
export interface FoundryAsset {
  platform: Platform;
  arch: Arch;
  file: string;
}

const ASSETS: FoundryAsset[] = [
  { platform: 'darwin', arch: 'arm64', file: 'foundry-darwin-arm64.tar.gz' },
  { platform: 'darwin', arch: 'x64', file: 'foundry-darwin-x64.tar.gz' },
  { platform: 'linux', arch: 'x64', file: 'foundry-linux-x64.tar.gz' },
  { platform: 'win32', arch: 'x64', file: 'foundry-windows-x64.tar.gz' },
];

/**
 * The asset NAMING CONTRACT (`foundry-<platform>-<arch>.tar.gz`,
 * docs/DISTRIBUTION.md §2.3), exported so the release check reads the names from
 * here rather than re-deriving them. Two places composing the same filename is
 * how one of them ends up subtly different and installs break on one platform,
 * silently, until somebody on that platform tries.
 */
export const FOUNDRY_ASSETS: readonly FoundryAsset[] = ASSETS;

/** One artifact of a release discovered at runtime (hash from its checksums.txt). */
export interface FoundryReleaseArtifact {
  platform: Platform;
  arch: Arch;
  file: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** The newest published release, once it has been read off GitHub. */
export interface DiscoveredRelease {
  version: string;
  artifacts: FoundryReleaseArtifact[];
}

/**
 * Process-wide, replaced by every successful release check.
 *
 * Deliberately NOT persisted. What survives a restart is the InstalledRecord —
 * the version actually on disk. A second on-disk copy of "what we last saw on
 * GitHub" would be a second authority, able to go stale and able to disagree
 * with the only two things that are real: the file on disk, and the release.
 */
let discovered: DiscoveredRelease | null = null;

/**
 * Adopt a release discovered at runtime. Only `checkFoundryRelease` calls this,
 * and only after every artifact's hash has been read from the release's own
 * `checksums.txt` — see that file's header for what is and is not guaranteed.
 */
export function setDiscoveredFoundryRelease(release: DiscoveredRelease): void {
  discovered = release;
}

/** The newest release as last read off GitHub, or null if it has not been read. */
export function getDiscoveredFoundryRelease(): DiscoveredRelease | null {
  return discovered;
}

/**
 * Which foundry should be on this machine.
 *
 * The newest published release, or `''` when GitHub has not been reached this
 * launch. Empty is not a stand-in for a version — it is "unknown", and every
 * rule that reads it treats it that way: `planUpgrade` rule 6 keeps an install
 * whose target version is '' rather than guessing it is stale. Anything asking
 * "is the installed copy out of date?" compares against THIS.
 */
export function effectiveFoundryVersion(): string {
  return discovered ? discovered.version : '';
}

/**
 * The executable inside the archive, for THIS machine.
 *
 * Resolved at catalog-build time rather than declared per artifact, because
 * `entryPath` is one string on the component and the catalog is built in the
 * main process on the machine that will run it.
 */
function entryName(): string {
  return process.platform === 'win32' ? 'foundry.exe' : 'foundry';
}

export function foundryCliComponent(): OptionalComponent {
  // The catalog is rebuilt on every getCatalog() call, so a release adopted
  // mid-launch is picked up by the very next install() without any invalidation.
  const version = effectiveFoundryVersion();
  // No release read yet ⇒ NO artifacts. There is nothing to download that this
  // process can name, and inventing URLs from a remembered version would be
  // guessing at a release that may not exist. install() surfaces the empty list
  // as "not available for download", which offline is the truth.
  const artifacts = (discovered?.artifacts ?? []).map((a) => ({
    platform: a.platform,
    arch: a.arch,
    url: a.url,
    sha256: a.sha256,
    bytes: a.bytes,
  }));
  const mine = artifacts.find(
    (a) => a.platform === process.platform && a.arch === process.arch
  );

  return {
    id: FOUNDRY_CLI_COMPONENT_ID,
    name: 'Foundry CLI',
    description:
      'Recasts PDFs into clean EPUBs: a document vision model reads every page picture '
      + 'and foundry assembles the answers into a book. Downloaded automatically '
      + 'the first time a pass needs it — or point this at a build of your own '
      + `(or set ${FOUNDRY_CLI_ENV_VAR}), which always wins.`,
    kind: 'foundry-cli',
    // Managed FIRST: the download works, and a run that needs foundry fetches it
    // without asking. External stays listed because a configured path still wins
    // over the download — see the header.
    acquisition: ['managed', 'external'],
    // 0 when this machine's platform/arch has no artifact at all — a real state
    // (a target that failed to build is absent from the release), and install()
    // surfaces it as "not available for download" rather than fetching nothing.
    sizeBytes: mine ? mine.bytes : 0,
    requirements: {
      // No GPU of its own. The vision model runs wherever the conversion's route
      // put it — an endpoint, the WSL reader, or MLX on an Apple Silicon Mac —
      // and none of those is this binary. (It used to be llama-server, bundled by
      // BookForge and handed over with `--llama-server`; foundry drives no
      // llama.cpp at all now, and the flag is gone.)
      gpu: 'none',
      minDiskMB: 200,
    },
    artifacts,
    detect: {
      // The env var ONLY. No command-name lookup and no candidate paths: a
      // `foundry` found on PATH is an unknown build with an unknown prompt
      // format, and using it would make a book quietly worse instead of failing.
      // Same rule foundry applies to the interpreters it resolves for itself.
      envVar: FOUNDRY_CLI_ENV_VAR,
    },
    // `foundry --version` prints `foundry <version> (<commit>)`, so this both
    // proves the binary runs and proves it is foundry rather than something else
    // that happens to accept --version.
    verify: { kind: 'exec', args: ['--version'], expect: 'foundry' },
    version,
    entryPath: entryName(),
    // The specific release when one has been read, else the releases page. Never
    // a tag built from a remembered version: with nothing discovered that would
    // link to a release this app has not seen and may not exist.
    externalHelpUrl: version
      ? `https://github.com/telltaleatheist/foundry/releases/tag/v${version}`
      : 'https://github.com/telltaleatheist/foundry/releases',
  };
}
