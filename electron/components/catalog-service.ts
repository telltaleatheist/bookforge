/**
 * CatalogService — keeps the downloadable voice & language-pack lists current
 * from the remote catalog (catalog.json) instead of hardcoding them.
 *
 * Resolution order for the in-memory catalog:
 *   1. BUNDLED_CATALOG  — always available, embedded at build time. Used at
 *      startup before anything async runs, and as the permanent offline floor.
 *   2. userData cache   — the last good catalog fetched from the network. Loaded
 *      synchronously in init() if present and valid; supersedes the bundle.
 *   3. live fetch       — init() kicks off a network refresh; on success it
 *      writes the cache and swaps the in-memory catalog. Failures are logged and
 *      leave the current catalog in place (no degraded/empty list is ever used).
 *
 * The catalog only carries download COORDINATES (repo/sub/files, stanza code).
 * As a tamper boundary, voice entries whose repo isn't on REPO_ALLOWLIST are
 * dropped at load time, so a bad catalog can't point downloads at an arbitrary
 * HuggingFace repo.
 *
 * Fetched via Node https in the main process (no renderer fetch → no CORS, no
 * mixed-content), so no CORS header is required on the catalog endpoint.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';

import { BUNDLED_CATALOG } from './catalog.bundled';
import type { CatalogData, CatalogVoice, CatalogLanguage } from './catalog-types';

const CATALOG_URL =
  process.env.BOOKFORGE_CATALOG_URL || 'https://owenmorgan.com/bookforge/catalog.json';

// Schema this build understands. A catalog with a different major schema is
// ignored (we keep the bundle) rather than mis-parsed.
const SUPPORTED_SCHEMA = 1;

// Sanity floors — a valid catalog always has at least this many entries. A
// smaller one means a broken upstream; we refuse it and keep what we have.
const MIN_VOICES = 20;
const MIN_LANGUAGES = 60;

// Repos a voice download is allowed to target. The catalog can add voices, but
// only from these repos — a tamper boundary on the download coordinates.
const REPO_ALLOWLIST = new Set([
  'drewThomasson/fineTunedTTSModels',
  'coqui/XTTS-v2',
]);

function cachePath(): string {
  return path.join(app.getPath('userData'), 'catalog-cache.json');
}

/** True if `data` is a structurally valid, this-schema, sane-sized catalog. */
function isValidCatalog(data: unknown): data is CatalogData {
  if (!data || typeof data !== 'object') return false;
  const c = data as Partial<CatalogData>;
  if (c.schemaVersion !== SUPPORTED_SCHEMA) return false;
  if (!Array.isArray(c.voices) || !Array.isArray(c.languages)) return false;
  if (c.voices.length < MIN_VOICES || c.languages.length < MIN_LANGUAGES) return false;
  return true;
}

/** Strip voice entries that point at a non-allowlisted repo (tamper guard). */
function sanitize(data: CatalogData): CatalogData {
  const voices = data.voices.filter((v) => {
    const ok = REPO_ALLOWLIST.has(v.repo);
    if (!ok) console.warn(`[CATALOG] dropping voice ${v.id}: repo not allowlisted (${v.repo})`);
    return ok;
  });
  return { ...data, voices };
}

class CatalogService {
  // Start on the embedded bundle so voices()/languages() are never empty.
  private current: CatalogData = sanitize(BUNDLED_CATALOG);
  private initialized = false;

  /**
   * Load the cached catalog (if any) synchronously, then start a background
   * network refresh. Safe to call once after the app is ready. Returns after the
   * cache is loaded; the network refresh continues in the background.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      const raw = fs.readFileSync(cachePath(), 'utf-8');
      const parsed = JSON.parse(raw);
      if (isValidCatalog(parsed)) {
        this.current = sanitize(parsed);
        console.log(`[CATALOG] loaded cache: ${this.current.voices.length} voices, `
          + `${this.current.languages.length} languages (generated ${this.current.generatedAt})`);
      }
    } catch {
      // No cache yet, or unreadable/invalid — keep the bundle. Not an error.
    }

    // Fire and forget — a refresh failure must not block startup.
    void this.refresh();
  }

  /** Fetch the live catalog, validate, and (on success) cache + swap it in. */
  async refresh(): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = await fetchJson(CATALOG_URL);
    } catch (e) {
      console.warn(`[CATALOG] refresh failed (${(e as Error).message}); keeping current catalog`);
      return false;
    }
    if (!isValidCatalog(parsed)) {
      console.warn('[CATALOG] fetched catalog is invalid/incompatible; keeping current catalog');
      return false;
    }
    const next = sanitize(parsed);
    this.current = next;
    try {
      const tmp = cachePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(parsed));
      fs.renameSync(tmp, cachePath());
    } catch (e) {
      console.warn(`[CATALOG] could not write cache: ${(e as Error).message}`);
    }
    console.log(`[CATALOG] refreshed: ${next.voices.length} voices, `
      + `${next.languages.length} languages (generated ${next.generatedAt})`);
    return true;
  }

  voices(): CatalogVoice[] {
    return this.current.voices;
  }

  languages(): CatalogLanguage[] {
    return this.current.languages;
  }
}

/** GET JSON over https with a small transient-retry (matches download_model.py). */
function fetchJson(url: string, attempts = 3): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      const req = https.get(url, { timeout: 20000, headers: { 'User-Agent': 'BookForge' } }, (res) => {
        const status = res.statusCode || 0;
        if (status !== 200) {
          res.resume();
          const transient = status === 429 || (status >= 500 && status < 600);
          if (transient && n < attempts) return retry(n, `HTTP ${status}`);
          return reject(new Error(`HTTP ${status}`));
        }
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`bad JSON: ${(e as Error).message}`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => {
        if (n < attempts) return retry(n, e.message);
        reject(e);
      });
    };
    const retry = (n: number, why: string) => {
      const delay = 1000 * Math.pow(2, n - 1);
      console.warn(`[CATALOG] fetch attempt ${n}/${attempts} failed (${why}); retry in ${delay}ms`);
      setTimeout(() => attempt(n + 1), delay);
    };
    attempt(1);
  });
}

export const catalogService = new CatalogService();
