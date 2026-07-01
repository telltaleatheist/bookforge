import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { ReaderSummary } from '../models/types';

const TOKEN_KEY = 'bookshelf-reader-token';

/**
 * Lightweight server-side reader identity. The reader's profile and history live
 * on the server (keyed by id); the client only holds an opaque token. When no
 * reader is active, the app shows the "Who's reading?" gate.
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private readonly api = inject(ApiService);

  readonly reader = signal<ReaderSummary | null>(null);
  readonly ready = signal(false);       // finished checking the stored token
  readonly supported = signal(false);   // server exposes the readers API

  readonly signedIn = computed(() => !!this.reader());

  private tokenValue: string | null = localStorage.getItem(TOKEN_KEY);

  token(): string | null {
    return this.tokenValue;
  }

  /** On boot, probe reader support and validate any stored token. */
  async init(): Promise<void> {
    // Probe: a successful readers listing means the server supports profiles.
    // (Older servers return the SPA index.html for unknown routes, which throws.)
    try {
      await this.api.listReaders();
      this.supported.set(true);
    } catch {
      this.supported.set(false);
    }

    if (this.supported() && this.tokenValue) {
      try {
        const me = await this.api.getMe(this.tokenValue);
        if (me) this.reader.set(me);
        else this.clearToken();
      } catch {
        // Transient — leave gate up; don't wipe the token.
      }
    }
    this.ready.set(true);
  }

  listReaders(): Promise<ReaderSummary[]> {
    return this.api.listReaders();
  }

  async selectReader(id: string, pin?: string): Promise<void> {
    const { token, reader } = await this.api.loginReader(id, pin);
    this.setSession(token, reader);
  }

  async addReader(name: string, pin?: string): Promise<void> {
    const { token, reader } = await this.api.createReader(name, pin);
    this.setSession(token, reader);
  }

  /** Show the gate again to pick a different reader (keeps the old token until a new pick). */
  switchReader(): void {
    this.reader.set(null);
  }

  private setSession(token: string, reader: ReaderSummary): void {
    this.tokenValue = token;
    localStorage.setItem(TOKEN_KEY, token);
    this.reader.set(reader);
  }

  private clearToken(): void {
    this.tokenValue = null;
    localStorage.removeItem(TOKEN_KEY);
  }
}
