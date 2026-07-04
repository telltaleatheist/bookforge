import { computed, inject, Injectable, signal, WritableSignal } from '@angular/core';
import { ApiService } from './api.service';
import { ServerConfigService } from './server-config.service';
import { ReaderSummary } from '../models/types';

const TOKENS_KEY = 'bookshelf-reader-tokens';      // { [serverId]: token }
const LEGACY_TOKEN_KEY = 'bookshelf-reader-token'; // pre-multi-server single token

/**
 * Reader identity, PER SERVER. A reader's profile + history live on the server
 * (keyed by id); the client holds one opaque token per server. Everything the UI
 * reads (reader/supported/ready/signedIn/token) is scoped to the ACTIVE server
 * via computeds, but the underlying maps hold an entry for every connected
 * server — so switching servers (or fanning analytics across them) never wipes
 * another server's login. See projects/bookshelf/MULTI_SERVER.md.
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly api = inject(ApiService);
  private readonly cfg = inject(ServerConfigService);

  private readonly tokens = new Map<string, string>(this.loadTokens());
  private readonly readers = signal<Map<string, ReaderSummary>>(new Map());
  private readonly supportedServers = signal<Set<string>>(new Set());
  private readonly readyServers = signal<Set<string>>(new Set());
  // "Browse as guest" this session — profiles are analytics-only, so the picker
  // is a soft prompt. App-wide + session-only (a fresh launch nudges again).
  readonly dismissed = signal(false);

  private activeId(): string { return this.cfg.activeServer()?.id ?? ''; }

  // Active-server-scoped views — the shape every existing caller already uses.
  readonly reader = computed(() => this.readers().get(this.activeId()) ?? null);
  readonly supported = computed(() => this.supportedServers().has(this.activeId()));
  readonly ready = computed(() => this.readyServers().has(this.activeId()));
  readonly signedIn = computed(() => !!this.reader());

  /** Token for a server (default: active). Per-book/analytics calls pass the
   *  book's origin server; the active server is used when omitted. */
  token(serverId?: string): string | null {
    return this.tokens.get(serverId ?? this.activeId()) ?? null;
  }

  /** The reader signed in on a specific server (for cross-server consolidation). */
  readerOn(serverId: string): ReaderSummary | null {
    return this.readers().get(serverId) ?? null;
  }

  /** Probe reader support + validate the stored token for a server (default:
   *  active). Idempotent — a server already checked is skipped, so app.ts can
   *  call this on every server switch without re-probing. */
  async init(serverId = this.activeId()): Promise<void> {
    if (this.readyServers().has(serverId)) return;
    // A successful readers listing means the server supports profiles. (Older
    // servers return the SPA index.html for unknown routes, which throws.)
    let supported = false;
    try { await this.api.listReaders(serverId); supported = true; } catch { supported = false; }
    if (supported) this.addTo(this.supportedServers, serverId);

    const tok = this.tokens.get(serverId);
    if (supported && tok) {
      try {
        const me = await this.api.getMe(tok, serverId);
        if (me) this.setReader(serverId, me);
        else this.dropToken(serverId); // token no longer valid on that server
      } catch {
        // Transient — leave the gate up, don't wipe the token.
      }
    }
    this.addTo(this.readyServers, serverId);
  }

  listReaders(): Promise<ReaderSummary[]> {
    return this.api.listReaders(this.activeId());
  }

  async selectReader(id: string, pin?: string): Promise<void> {
    const serverId = this.activeId();
    const { token, reader } = await this.api.loginReader(id, pin, serverId);
    this.setSession(serverId, token, reader);
  }

  async addReader(name: string, pin?: string): Promise<void> {
    const serverId = this.activeId();
    const { token, reader } = await this.api.createReader(name, pin, serverId);
    this.setSession(serverId, token, reader);
  }

  /** Re-open the picker for the active server (keeps the token until a new pick).
   *  Clears guest state so the picker actually appears. */
  switchReader(): void {
    this.dismissed.set(false);
    this.setReader(this.activeId(), null);
  }

  /** Browse without a profile this session (analytics just won't track). */
  browseAsGuest(): void {
    this.dismissed.set(true);
  }

  /** Forget the active server's session (used when leaving/removing a server). */
  reset(): void {
    const serverId = this.activeId();
    this.dropToken(serverId);
    this.removeFrom(this.supportedServers, serverId);
    this.removeFrom(this.readyServers, serverId);
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private setSession(serverId: string, token: string, reader: ReaderSummary): void {
    this.tokens.set(serverId, token);
    this.saveTokens();
    this.setReader(serverId, reader);
  }

  private setReader(serverId: string, reader: ReaderSummary | null): void {
    const next = new Map(this.readers());
    if (reader) next.set(serverId, reader); else next.delete(serverId);
    this.readers.set(next);
  }

  private dropToken(serverId: string): void {
    this.tokens.delete(serverId);
    this.saveTokens();
    this.setReader(serverId, null);
  }

  private addTo(sig: WritableSignal<Set<string>>, id: string): void {
    if (sig().has(id)) return;
    const next = new Set(sig());
    next.add(id);
    sig.set(next);
  }

  private removeFrom(sig: WritableSignal<Set<string>>, id: string): void {
    if (!sig().has(id)) return;
    const next = new Set(sig());
    next.delete(id);
    sig.set(next);
  }

  private saveTokens(): void {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(Object.fromEntries(this.tokens)));
  }

  /** Load the per-server token map, migrating the pre-multi-server single token
   *  into the active server's slot. */
  private loadTokens(): [string, string][] {
    const map: Record<string, string> = {};
    const raw = localStorage.getItem(TOKENS_KEY);
    if (raw) { try { Object.assign(map, JSON.parse(raw)); } catch { /* ignore */ } }

    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      const activeId = this.cfg.activeServer()?.id;
      if (activeId && !map[activeId]) map[activeId] = legacy;
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.setItem(TOKENS_KEY, JSON.stringify(map));
    }
    return Object.entries(map);
  }
}
