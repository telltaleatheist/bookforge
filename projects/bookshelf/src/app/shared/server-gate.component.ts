import { Component, inject, signal } from '@angular/core';
import { ServerConfigService } from '../services/server-config.service';

/** Known BookForge library servers, offered as one-tap choices. */
const SUGGESTED_SERVERS = [
  { label: 'Mac Studio', url: 'http://owens-mac-studio.owenmorgan.com:8765' },
  { label: 'PC', url: 'http://owens-pc.owenmorgan.com:8765' },
];

/**
 * Full-screen "Connect to your library" gate — the native app's first-run
 * pairing screen. Shown only in the Capacitor shell when no server is saved
 * (the web app is served by its server, so it never sees this). Verifies the
 * server with /api/health before saving.
 */
@Component({
  selector: 'app-server-gate',
  standalone: true,
  template: `
    <div class="gate">
      <div class="panel">
        @if (cfg.configured()) {
          <button class="back" (click)="cfg.closePrompt()">‹ Cancel</button>
        }
        <h1>Connect to your library</h1>
        <p class="hint">Enter the address of a BookForge library server on your tailnet.</p>
        <div class="suggested">
          @for (s of suggested; track s.url) {
            <button class="chip" (click)="url.set(s.url)" [class.active]="url() === s.url">{{ s.label }}</button>
          }
        </div>
        <input class="text" type="url" placeholder="http://host:8765" autocapitalize="off" autocorrect="off" spellcheck="false"
          [value]="url()" (input)="url.set($any($event.target).value)"
          (keyup.enter)="connect()" />
        <input class="text" type="password" placeholder="Access key (if required)" autocapitalize="off" autocorrect="off" spellcheck="false"
          [value]="key()" (input)="key.set($any($event.target).value)"
          (keyup.enter)="connect()" />
        <input class="text" type="text" placeholder="Name (optional — e.g. Owen's Mac)"
          [value]="name()" (input)="name.set($any($event.target).value)"
          (keyup.enter)="connect()" />
        @if (error()) { <p class="error">{{ error() }}</p> }
        <button class="primary" (click)="connect()" [disabled]="busy() || !url().trim()">
          {{ busy() ? 'Checking…' : 'Connect' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .gate { position: fixed; inset: 0; z-index: 1001; display: flex; align-items: center; justify-content: center;
      background: var(--bg-base); padding: 24px; }
    .panel { width: 100%; max-width: 440px; display: flex; flex-direction: column; align-items: center; gap: 20px; }
    .back { align-self: flex-start; border: none; background: transparent; color: var(--text-secondary); font-size: 14px; cursor: pointer; padding: 0; margin-bottom: -8px; }
    h1 { font-size: 24px; font-weight: 700; color: var(--text-primary); text-align: center; }
    .hint { font-size: 14px; color: var(--text-secondary); text-align: center; margin-top: -8px; }
    .error { font-size: 13px; color: var(--error); text-align: center; }

    .suggested { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
    .chip { padding: 10px 16px; border-radius: 999px; border: 1px solid var(--border-subtle); background: var(--bg-elevated);
      color: var(--text-secondary); font-size: 14px; cursor: pointer; }
    .chip.active { border-color: var(--accent); color: var(--text-primary); }

    .text { width: 100%; padding: 14px 16px; font-size: 16px; background: var(--bg-elevated);
      border: 1px solid var(--border-subtle); border-radius: 10px; color: var(--text-primary); outline: none; text-align: center; }
    .text:focus { border-color: var(--accent); }

    .primary { width: 100%; padding: 14px; border: none; border-radius: 10px; background: var(--accent); color: #fff;
      font-size: 15px; font-weight: 600; cursor: pointer; }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class ServerGateComponent {
  readonly cfg = inject(ServerConfigService);

  readonly suggested = SUGGESTED_SERVERS;
  readonly url = signal('');
  readonly key = signal('');
  readonly name = signal('');
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async connect(): Promise<void> {
    let base = this.url().trim().replace(/\/+$/, '');
    if (!base) return;
    if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
    const accessKey = this.key().trim();
    this.busy.set(true);
    this.error.set(null);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      // Probe with the key so a gated server accepts the health check.
      const healthUrl = accessKey
        ? `${base}/api/health?accessKey=${encodeURIComponent(accessKey)}`
        : `${base}/api/health`;
      const res = await fetch(healthUrl, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 401) throw new Error('access key required or incorrect');
      if (!res.ok) throw new Error(`server answered ${res.status}`);
      // Name = what the user typed, else the server's own reported name (/api/health),
      // else host-derived (addServer falls back to hostLabel when undefined).
      let serverName: string | undefined;
      try { serverName = (await res.json())?.name; } catch { /* older server / no body */ }
      this.cfg.setBaseUrl(base, accessKey, this.name().trim() || serverName || undefined);
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'AbortError' ? 'timed out' : (e as Error).message;
      this.error.set(`Couldn't reach that server (${msg}). Is BookForge running and the tailnet up?`);
    } finally {
      this.busy.set(false);
    }
  }
}
