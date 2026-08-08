/**
 * The `foundry` CLI as an optional component.
 *
 * Foundry (github.com/telltaleatheist/foundry) is the extraction of this app's
 * page-layout model, OCR-repair edit contract and footnote-marker remover into a
 * standalone binary. BookForge drives it as a subprocess and reads its run
 * directory — see `electron/foundry-bridge.ts`.
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
 * ── Bumping FOUNDRY_CLI_VERSION ──────────────────────────────────────────────
 *
 * Publish the release, then change the version constant and paste the four
 * sha256s and byte counts out of that release's `checksums.txt`. The URLs derive
 * from the version, so they follow on their own; the hashes never can.
 *
 * A hash is only ever PASTED from a published artifact, never predicted. An
 * invented hash turns a clear failure — "this asset is not there" — into a
 * checksum mismatch, which reads as a corrupt transfer and sends the reader off
 * to investigate their network instead of the release they forgot to upload.
 *
 * ── When a release is newer than the pin ─────────────────────────────────────
 *
 * The startup update check (electron/components/startup-upgrade-check.ts) can
 * discover a published release newer than FOUNDRY_CLI_VERSION and hand it to
 * `setDiscoveredFoundryRelease` below. From that moment this component describes
 * THAT release instead of the pin — its version, its URLs, and hashes read out of
 * its own `checksums.txt`. That is a weaker guarantee than the pasted hashes
 * above, and the trade-off is argued in full at the top of
 * `electron/components/foundry-release-check.ts`, which is the only thing that
 * ever calls the setter.
 *
 * `effectiveFoundryVersion()` is the SINGLE answer to "which foundry should be
 * on this machine". Everything that used to read FOUNDRY_CLI_VERSION to decide
 * whether an install is stale must read it instead — foundry-bridge's lazy
 * upgrade did, and had it kept reading the raw constant it would have reinstalled
 * the pin over a freshly-taken newer release on every pass.
 */

import type { OptionalComponent, Platform, Arch } from './component-types';

/** Component id. Also the key `componentManager.resolveEntry` is asked for. */
export const FOUNDRY_CLI_COMPONENT_ID = 'foundry-cli';

/** Environment variable holding an explicit path to the binary. */
export const FOUNDRY_CLI_ENV_VAR = 'FOUNDRY_CLI_PATH';

/** The release these artifacts come from. Bumping it means new URLs and hashes. */
export const FOUNDRY_CLI_VERSION = '0.7.0';

const RELEASE_BASE =
  `https://github.com/telltaleatheist/foundry/releases/download/v${FOUNDRY_CLI_VERSION}`;

/**
 * The published assets, verbatim from the release's `checksums.txt` — pasted,
 * never predicted (see the header).
 */
export interface FoundryAsset {
  platform: Platform;
  arch: Arch;
  file: string;
  sha256: string;
  bytes: number;
}

const ASSETS: FoundryAsset[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    file: 'foundry-darwin-arm64.tar.gz',
    sha256: '0138f67e72d6e2d5635895eba2fb2ab4b27daa4b51246c084dc9e44f53f7033e',
    bytes: 25197730,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    file: 'foundry-darwin-x64.tar.gz',
    sha256: '9b1538d7f165c204dbb9878418ebe92c842f5171d3de3d906b8ffd9d18e2e31e',
    bytes: 27725485,
  },
  {
    platform: 'linux',
    arch: 'x64',
    file: 'foundry-linux-x64.tar.gz',
    sha256: '3cf1bc94eb67d8482658dd446adc31d32fa5b566e798cf09acd096ea8c90e488',
    bytes: 37188870,
  },
  {
    platform: 'win32',
    arch: 'x64',
    file: 'foundry-windows-x64.tar.gz',
    sha256: 'ef01bce8999ab833b37001f3df301094d420e5df72d0cceb7e5a2f38bd1895a8',
    bytes: 39576931,
  },
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

/** A release newer than the pin, once one has been discovered and verified. */
export interface DiscoveredRelease {
  version: string;
  artifacts: FoundryReleaseArtifact[];
}

/**
 * Process-wide, set at most once per launch by the startup update check.
 *
 * Deliberately NOT persisted. What survives a restart is the InstalledRecord —
 * the version actually on disk — and the "a downgrade is not an upgrade" rule in
 * component-upgrades.ts is what keeps a launch that starts offline (and so can
 * only see the pin) from dragging a newer install backwards. A second on-disk
 * copy of "what we last saw on GitHub" would be a second authority to go stale.
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

/** The discovered release, or null when the pin is still what this launch uses. */
export function getDiscoveredFoundryRelease(): DiscoveredRelease | null {
  return discovered;
}

/**
 * Which foundry should be on this machine — the discovered release if one was
 * adopted this launch, else the pin. The single authority: anything asking "is
 * the installed copy stale?" must compare against THIS, never against
 * FOUNDRY_CLI_VERSION directly.
 */
export function effectiveFoundryVersion(): string {
  return discovered ? discovered.version : FOUNDRY_CLI_VERSION;
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
  const artifacts = discovered
    ? discovered.artifacts.map((a) => ({
      platform: a.platform,
      arch: a.arch,
      url: a.url,
      sha256: a.sha256,
      bytes: a.bytes,
    }))
    : ASSETS.map((a) => ({
      platform: a.platform,
      arch: a.arch,
      url: `${RELEASE_BASE}/${a.file}`,
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
      'Recasts scanned PDFs into clean EPUBs: line segmentation with a pinned Tesseract, '
      + 'block labelling, OCR repair and footnote-marker removal. Downloaded automatically '
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
      // No GPU of its own: the model stages drive llama-server, which BookForge
      // already bundles and passes in with --llama-server.
      gpu: 'none',
      minDiskMB: 200,
    },
    artifacts,
    detect: {
      // The env var ONLY. No command-name lookup and no candidate paths: a
      // `foundry` found on PATH is an unknown build with an unknown prompt
      // format and an unknown Tesseract pin, and using it would make a book
      // quietly worse instead of failing. Same rule foundry applies to its own
      // tesseract and llama-server.
      envVar: FOUNDRY_CLI_ENV_VAR,
    },
    // `foundry --version` prints `foundry <version> (<commit>)`, so this both
    // proves the binary runs and proves it is foundry rather than something else
    // that happens to accept --version.
    verify: { kind: 'exec', args: ['--version'], expect: 'foundry' },
    version,
    entryPath: entryName(),
    // Derived, not written out: a hardcoded tag went stale the first time the
    // version was bumped and pointed users at a release the app no longer ships.
    externalHelpUrl: `https://github.com/telltaleatheist/foundry/releases/tag/v${version}`,
  };
}
