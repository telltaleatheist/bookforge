/**
 * remote-manifest — fetches + briefly caches the v2 manifest.json consumed by
 * component-updater.ts (our managed binaries) and starter-library.ts.
 *
 * One fetch, one cache, one source of truth. The manifest lists OUR server-hosted, watched
 * artifacts (components like ffmpeg, yt-dlp; the starter library) plus the HF catalog content
 * (voices / languages) — but only components/starter are subject to update logic. (It still
 * carries legacy launcher/code entries from the removed self-update system; ignored.)
 */

import * as http from 'http';
import * as https from 'https';
import type { UpdateManifest } from './manifest-types';

export const MANIFEST_URL =
  process.env.BOOKFORGE_MANIFEST_URL ||
  'https://raw.githubusercontent.com/telltaleatheist/bookforge/catalog-data/manifest.json';

const CACHE_TTL_MS = 60_000;
let cache: { at: number; manifest: UpdateManifest } | null = null;

/** Fetch + parse manifest.json (http/https, follows redirects, with a timeout). */
function fetchRaw(url: string, redirects = 0): Promise<UpdateManifest> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects fetching manifest'));
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'BookForge' } }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        return resolve(fetchRaw(new URL(loc, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Manifest fetch failed: HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as UpdateManifest;
          if (parsed.schemaVersion !== 2) {
            return reject(new Error(`Unexpected manifest schemaVersion ${parsed.schemaVersion}`));
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`Manifest parse error: ${(err as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error('Manifest fetch timed out')));
  });
}

/** Get the manifest, using the short-lived cache unless `force` is set. */
export async function getManifest(force = false): Promise<UpdateManifest> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.manifest;
  }
  const manifest = await fetchRaw(MANIFEST_URL);
  cache = { at: Date.now(), manifest };
  return manifest;
}
