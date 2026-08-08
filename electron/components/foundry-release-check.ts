/**
 * What is the newest published foundry release, and what are its artifacts?
 *
 * This module is the ONLY authority on which foundry BookForge should be running.
 * There is no pinned version and no committed hash to compare against: whatever
 * GitHub says is the latest release is what this app wants, in either direction.
 * That is a deliberate trade, and it costs something real. It is stated here, at
 * the decision, rather than left for a reader to infer from the absence of a
 * constant:
 *
 * ── The trust trade-off, deliberately made ──────────────────────────────────
 *
 * A PASTED hash is a second, independent assertion. It is read out of a release
 * a human already looked at, committed to this repo, and shipped inside the app
 * binary — so it is not something the release host can change afterwards. If
 * github.com ever served different bytes under the same tag, a pasted hash
 * catches it, because the bytes and the expectation come from two places.
 *
 * A hash read from the release's own `checksums.txt` is a WEAKER guarantee, and
 * it is weaker in exactly one way: whoever can rewrite the tarball can rewrite
 * `checksums.txt` beside it, and the check passes. It defends against a corrupt
 * or truncated transfer — the failure this code actually sees — and it does not
 * defend against a compromised repository. That is the whole of the difference.
 *
 * It is taken because the alternative was worse in practice, and then taken
 * FURTHER for the same reason (Owen, 2026-08-08): foundry is rebuilt and
 * republished several times a day, sometimes several times an hour, and any
 * scheme requiring a human to bump a constant and copy four hashes before the app
 * can see a release is a scheme that guarantees every machine runs a CLI behind
 * the document-stage contract the app was built against. The repo is Owen's own,
 * public, and read over HTTPS with certificate validation, so the residual risk
 * is "someone owns the GitHub account" — at which point a pasted hash in the next
 * BookForge release would have been pasted from the same compromised artifact.
 *
 * What is NOT traded away, and must never be:
 *
 *  - Verification still happens, ALWAYS. `checksums.txt` is fetched and the
 *    artifact's line is looked up before anything is installed. The download
 *    itself is still `downloadAndExtract` (electron/components/downloader.ts),
 *    which hashes the file it fetched and refuses on a mismatch — this module
 *    supplies the expectation, it does not perform or bypass the check.
 *  - A MISSING `checksums.txt`, or a release that has the tarball but no line
 *    for it, is a REFUSAL BY NAME — never a silent install of unverified bytes,
 *    and never a shrug back to the pin as though nothing happened. An artifact
 *    published without its checksum is a publishing mistake (docs/DISTRIBUTION.md
 *    §2.2 packages the two together), and the useful answer says which file had
 *    no hash.
 *  - The asset naming is a CONTRACT — `foundry-<platform>-<arch>.tar.gz`,
 *    docs/DISTRIBUTION.md §2.3. This module does not re-derive those names; it
 *    reads them from `FOUNDRY_ASSETS`, so nothing can disagree about what a
 *    release is called.
 *
 * ── A release going BACKWARDS is followed, not ignored ──────────────────────
 *
 * There is no "is it newer" test any more. The newest release is the answer, and
 * if a bad build is yanked and an older tag becomes latest again, machines follow
 * it down. That is the point of having one authority: with a pin, a rollback
 * reached nobody until someone edited a constant, which is the slowest possible
 * response to the one situation that is actually urgent.
 *
 * ── Freshness ───────────────────────────────────────────────────────────────
 *
 * The answer is cached for {@link RELEASE_CACHE_MS} so a burst of passes does not
 * mean a burst of API calls, and re-read after that. It is short on purpose: the
 * publish-to-running-it loop is minutes, so a check that only happened at launch
 * would mean restarting the app to pick up a release published two minutes ago.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';

import { downloadFile } from './downloader';
import { FOUNDRY_ASSETS, type FoundryReleaseArtifact } from './foundry-cli-components';
import { isSemver } from './component-upgrades';

/** The releases API for the repo the pinned URLs point at. */
export const FOUNDRY_RELEASES_API =
  process.env.BOOKFORGE_FOUNDRY_RELEASES_API
  || 'https://api.github.com/repos/telltaleatheist/foundry/releases/latest';

/** The checksum manifest every foundry release ships beside its tarballs. */
export const CHECKSUMS_FILE = 'checksums.txt';

/** One asset as the GitHub releases API describes it. */
interface ReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/** The subset of the releases API this module reads. */
export interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: ReleaseAsset[];
}

/** A release newer than the pin, with a verified-against-checksums artifact set. */
export interface DiscoveredFoundryRelease {
  version: string;
  /** One entry per platform/arch that the release published AND checksummed. */
  artifacts: FoundryReleaseArtifact[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parts (unit-tested in tools/test-component-upgrades.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The version a release tag names. Tags are `v<x.y.z>` (docs/DISTRIBUTION.md
 * §2.4); the leading `v` is stripped so it compares against the pin, which has
 * none. A tag that is not a version at all returns null — the caller treats that
 * as "nothing to compare" rather than guessing.
 */
export function versionFromTag(tag: string): string | null {
  const trimmed = String(tag || '').trim();
  const stripped = trimmed.replace(/^v/, '');
  return isSemver(stripped) ? stripped : null;
}

/**
 * Parse a `sha256sum`-format manifest into filename → hash.
 *
 * Both spellings the tool emits are accepted: `<hash>  <name>` (text mode) and
 * `<hash> *<name>` (binary mode, which is what foundry's release-package.sh
 * actually produces on this machine's `sha256sum`). A `./` prefix is stripped —
 * release-package.sh strips it too, but a manifest written by hand elsewhere may
 * not have.
 */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    const name = match[2].trim().replace(/^\.\//, '');
    out[name] = match[1].toLowerCase();
  }
  return out;
}

/**
 * Build the artifact set for a release, or say which file made that impossible.
 *
 * `wantPlatform`/`wantArch` are this machine's — the release may legitimately be
 * missing OTHER platforms (a target that failed to build is absent rather than
 * stale, docs/DISTRIBUTION.md §2.2), but a release with no artifact for the
 * machine doing the checking cannot be installed here and must say so instead of
 * producing an empty set that later reads as "no upgrade".
 *
 * Throws — never returns a partial or unverified set — when:
 *   • this machine's tarball is not in the release, or
 *   • any published tarball has no line in `checksums.txt`.
 */
export function artifactsForRelease(
  release: GithubRelease,
  checksums: Record<string, string>,
  version: string,
  wantPlatform: string,
  wantArch: string
): FoundryReleaseArtifact[] {
  const byName = new Map(release.assets.map((a) => [a.name, a]));
  const artifacts: FoundryReleaseArtifact[] = [];

  for (const declared of FOUNDRY_ASSETS) {
    const asset = byName.get(declared.file);
    if (!asset) continue; // that platform was not published in this release
    const sha256 = checksums[declared.file];
    if (!sha256) {
      // Refusal by name. The tarball is there and its hash is not, so there is
      // nothing to verify it against — and installing it anyway is precisely the
      // thing this module promises never to do.
      throw new Error(
        `foundry ${version} publishes ${declared.file} but its ${CHECKSUMS_FILE} has no hash for it. `
        + 'BookForge will not install an artifact it cannot verify. Republish the release with a '
        + `complete ${CHECKSUMS_FILE} (tools/release-package.sh writes both together).`
      );
    }
    artifacts.push({
      platform: declared.platform,
      arch: declared.arch,
      file: declared.file,
      url: asset.browser_download_url,
      sha256,
      bytes: asset.size,
    });
  }

  const mine = artifacts.find((a) => a.platform === wantPlatform && a.arch === wantArch);
  if (!mine) {
    throw new Error(
      `foundry ${version} has no ${wantPlatform}/${wantArch} artifact, so this machine cannot take it. `
      + 'A target that failed to build is absent from the release; republish it with that platform '
      + 'included. Whatever foundry is already installed is left alone.'
    );
  }
  return artifacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET a JSON document, following redirects, with a timeout.
 *
 * Same shape as `fetchRaw` in electron/update/remote-manifest.ts — node's http
 * modules rather than global fetch, so the timeout and the redirect budget are
 * explicit. GitHub's API rejects a request with no User-Agent outright, which is
 * why every request here carries one.
 */
function fetchJson<T>(url: string, redirects = 0): Promise<T> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects fetching ${url}`));
      return;
    }
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(
      url,
      { headers: { 'User-Agent': 'BookForge', Accept: 'application/vnd.github+json' } },
      (res) => {
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          resolve(fetchJson<T>(new URL(loc, url).toString(), redirects + 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(new Error(`Could not parse the response from ${url}: ${(err as Error).message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

/**
 * Fetch a release's `checksums.txt` and return filename → hash.
 *
 * Uses `downloadFile` — the downloader the installs themselves go through — so
 * this follows GitHub's asset redirect the same way the tarball fetch will,
 * rather than a second, subtly different HTTP path.
 */
async function fetchChecksums(url: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-foundry-checksums-'));
  const file = path.join(dir, CHECKSUMS_FILE);
  try {
    await downloadFile(url, file, 'foundry-cli', () => { /* 370 bytes; no progress worth showing */ }, signal);
    return parseChecksums(fs.readFileSync(file, 'utf-8'));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leaked temp dir must not fail an update check */
    }
  }
}

/** How long a fetched release answer is reused before GitHub is asked again. */
export const RELEASE_CACHE_MS = 90_000;

/** The last successful answer and when it was taken. Failures are never cached. */
let cached: { at: number; release: DiscoveredFoundryRelease } | null = null;

/**
 * The newest published foundry release, with a verified artifact for this machine.
 *
 * Returns null only when there is genuinely no answer: the latest release is a
 * draft or prerelease, or its tag is not a version. THROWS when a release exists
 * and cannot be used — no `checksums.txt`, a tarball with no hash line, no
 * artifact for this platform. Those are publishing faults, and a caller that
 * swallowed them would be choosing to stay silently behind.
 *
 * Note what is NOT here any more: a comparison against a pinned version. This
 * answers "what is published", and `planUpgrade` answers "is that what is
 * installed". Keeping those two questions in separate places is what lets a
 * rollback reach machines without a code change.
 */
export async function checkFoundryRelease(
  platform: string = process.platform,
  arch: string = process.arch,
  signal?: AbortSignal,
  opts?: { force?: boolean }
): Promise<DiscoveredFoundryRelease | null> {
  if (!opts?.force && cached && Date.now() - cached.at < RELEASE_CACHE_MS) {
    return cached.release;
  }

  const release = await fetchJson<GithubRelease>(FOUNDRY_RELEASES_API);

  // /releases/latest never returns a draft, and returns a prerelease only when
  // it is the only release. Neither is something to move a user onto.
  if (release.draft || release.prerelease) return null;

  const version = versionFromTag(release.tag_name);
  if (!version) return null;

  const checksumAsset = release.assets.find((a) => a.name === CHECKSUMS_FILE);
  if (!checksumAsset) {
    // Refusal by name. Never a silent install of unverified bytes, and never a
    // shrug that leaves the machine behind without saying why.
    throw new Error(
      `foundry ${version} was published without a ${CHECKSUMS_FILE}, so none of its artifacts can `
      + 'be verified and BookForge will not install unverified bytes. Republish the release '
      + `including ${CHECKSUMS_FILE}.`
    );
  }

  const checksums = await fetchChecksums(checksumAsset.browser_download_url, signal);
  const artifacts = artifactsForRelease(release, checksums, version, platform, arch);
  const answer = { version, artifacts };
  cached = { at: Date.now(), release: answer };
  return answer;
}
