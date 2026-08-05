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
 */

import type { OptionalComponent } from './component-types';

/** Component id. Also the key `componentManager.resolveEntry` is asked for. */
export const FOUNDRY_CLI_COMPONENT_ID = 'foundry-cli';

/** Environment variable holding an explicit path to the binary. */
export const FOUNDRY_CLI_ENV_VAR = 'FOUNDRY_CLI_PATH';

/** The release these artifacts come from. Bumping it means new URLs and hashes. */
export const FOUNDRY_CLI_VERSION = '0.6.0';

const RELEASE_BASE =
  `https://github.com/telltaleatheist/foundry/releases/download/v${FOUNDRY_CLI_VERSION}`;

/**
 * The published assets, verbatim from the release's `checksums.txt` — pasted,
 * never predicted (see the header).
 */
interface FoundryAsset {
  platform: 'darwin' | 'win32' | 'linux';
  arch: 'arm64' | 'x64';
  file: string;
  sha256: string;
  bytes: number;
}

const ASSETS: FoundryAsset[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    file: 'foundry-darwin-arm64.tar.gz',
    sha256: '4dd9274042670ad1f7457e68d85b07e4321d70d7218c83c5f951028c3eb0c6aa',
    bytes: 25187010,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    file: 'foundry-darwin-x64.tar.gz',
    sha256: '92324cb7eb74455e1c4a0d7508f01ef61393f7346561f59fc8f1f4c360ef03f6',
    bytes: 27711800,
  },
  {
    platform: 'linux',
    arch: 'x64',
    file: 'foundry-linux-x64.tar.gz',
    sha256: '0eff778e1aa8609297dca35779936666b15ad88665f986fadf497c341ae6f830',
    bytes: 37172417,
  },
  {
    platform: 'win32',
    arch: 'x64',
    file: 'foundry-windows-x64.tar.gz',
    sha256: '77e985982350e0e476b33b3ae8d90a36f3aeae8528ea90423ef42f922c7b9983',
    bytes: 39540799,
  },
];

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
    sizeBytes: ASSETS.find(
      (a) => a.platform === process.platform && a.arch === process.arch
    )?.bytes ?? 0,
    requirements: {
      // No GPU of its own: the model stages drive llama-server, which BookForge
      // already bundles and passes in with --llama-server.
      gpu: 'none',
      minDiskMB: 200,
    },
    artifacts: ASSETS.map((a) => ({
      platform: a.platform,
      arch: a.arch,
      url: `${RELEASE_BASE}/${a.file}`,
      sha256: a.sha256,
      bytes: a.bytes,
    })),
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
    version: FOUNDRY_CLI_VERSION,
    entryPath: entryName(),
    // Derived, not written out: a hardcoded tag went stale the first time the
    // version was bumped and pointed users at a release the app no longer ships.
    externalHelpUrl: `https://github.com/telltaleatheist/foundry/releases/tag/v${FOUNDRY_CLI_VERSION}`,
  };
}
