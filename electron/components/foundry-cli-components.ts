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
 * ── THE DOWNLOAD DOES NOT WORK TODAY, AND THIS IS NOT A BUG IN THIS FILE ──
 *
 * **The foundry repository is PRIVATE.** GitHub serves release assets of a
 * private repository only to an authenticated request, and — this is the part
 * that misleads — it answers an unauthenticated one with **404, not 401**. So a
 * download attempt looks exactly like a missing asset.
 *
 * The URLs and hashes below are real: they are the v0.2.0 release assets and
 * their sha256s as published in that release's `checksums.txt`. If the owner
 * makes the repository public, the managed install starts working with no
 * change here. Until then the supported path is the EXTERNAL one — the user
 * points at a binary they built or downloaded with `gh`, or sets
 * `FOUNDRY_CLI_PATH` — which is why `acquisition` lists external first and the
 * description says so in words a user will see.
 *
 * That choice is deliberate: a component that quietly fails to download is worse
 * than one that says why, and "the repository is private" is a fact the user can
 * act on, whereas "404" sends them looking for a broken link.
 */

import type { OptionalComponent } from './component-types';

/** Component id. Also the key `componentManager.resolveEntry` is asked for. */
export const FOUNDRY_CLI_COMPONENT_ID = 'foundry-cli';

/** Environment variable holding an explicit path to the binary. */
export const FOUNDRY_CLI_ENV_VAR = 'FOUNDRY_CLI_PATH';

/** The release these artifacts come from. Bumping it means new URLs and hashes. */
export const FOUNDRY_CLI_VERSION = '0.2.0';

const RELEASE_BASE =
  `https://github.com/telltaleatheist/foundry/releases/download/v${FOUNDRY_CLI_VERSION}`;

/**
 * The published assets, verbatim from the release's `checksums.txt`.
 *
 * A hash is only ever pasted from a published artifact, never predicted: an
 * invented hash turns "this download is not available" — a clear message — into
 * a checksum mismatch, which reads as a corrupt transfer and sends the reader
 * to their network.
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
    sha256: '4de160a474cbba3c867647d2dda00011909a49870a2f4a95ede6c30c1d33c4aa',
    bytes: 24012880,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    file: 'foundry-darwin-x64.tar.gz',
    sha256: 'c325d2bac4403d448fc59c484f0e71584664773241a911cb4eab60b2dc0a01c3',
    bytes: 26581452,
  },
  {
    platform: 'linux',
    arch: 'x64',
    file: 'foundry-linux-x64.tar.gz',
    sha256: '3c8d60222a35f991016d536c933b1ccaaf721afcc91c8a25d54a8f28c44941cd',
    bytes: 36044676,
  },
  {
    platform: 'win32',
    arch: 'x64',
    file: 'foundry-windows-x64.tar.gz',
    sha256: '2af267dcb256befa86854d29c043e404d8df2c0d461db9fb8c08193d0ff65c48',
    bytes: 38430956,
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
      + 'block labelling, OCR repair and footnote-marker removal. The download requires access '
      + 'to a private repository — until it is public, point this at a binary you already have '
      + `(or set ${FOUNDRY_CLI_ENV_VAR}).`,
    kind: 'foundry-cli',
    // External FIRST, and that order is the honest one: it is the path that
    // works today.
    acquisition: ['external', 'managed'],
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
    // `foundry --version` prints `foundry 0.1.0 (a1b2c3d)`, so this both proves
    // the binary runs and proves it is foundry rather than something else that
    // happens to accept --version.
    verify: { kind: 'exec', args: ['--version'], expect: 'foundry' },
    version: FOUNDRY_CLI_VERSION,
    entryPath: entryName(),
    externalHelpUrl: 'https://github.com/telltaleatheist/foundry/releases/tag/v0.1.0',
  };
}
