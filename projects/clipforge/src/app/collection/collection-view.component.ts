import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ClipforgeApiService } from '../services/clipforge-api.service';
import { ClipforgeManifest, ClipforgeProbe, ClipforgeSource } from '../models/types';
import { AudioPlayerComponent } from '../player/audio-player.component';

const PROBE_DURATION_SECONDS = 60;

/**
 * Main area for the open collection: its sources and probes, the upload action,
 * and probe extraction. Every failure is surfaced in a visible banner — no
 * silent catches (project NO-FALLBACK rule).
 */
@Component({
  selector: 'cf-collection-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, FormsModule, AudioPlayerComponent],
  template: `
    @if (loadError()) {
      <div class="banner error">{{ loadError() }}</div>
    }

    @if (manifest(); as m) {
      <header class="head">
        <h1>{{ m.name }}</h1>
        <div class="meta">{{ m.sources.length }} source(s) · {{ m.probes.length }} probe(s)</div>
      </header>

      @if (notice(); as n) {
        <div class="banner info" (click)="notice.set(null)">{{ n }}</div>
      }
      @if (actionError(); as e) {
        <div class="banner error" (click)="actionError.set(null)">{{ e }}</div>
      }

      @if (nowPlaying(); as np) {
        <section class="playing">
          <cf-audio-player [src]="np.url" [label]="np.label" />
        </section>
      }

      <!-- Sources ------------------------------------------------------------->
      <section class="panel">
        <div class="panel-head">
          <h2>Sources</h2>
          <button type="button" class="btn" (click)="addSources()" [disabled]="busy()">
            {{ busy() ? 'Working…' : 'Add source audio' }}
          </button>
        </div>
        @if (m.sources.length === 0) {
          <p class="empty">No sources yet. "Add source audio" copies files in (originals are never modified) and probes their native rate.</p>
        } @else {
          <table class="grid">
            <thead>
              <tr>
                <th>File</th><th>Native rate</th><th>Ch</th><th>Duration</th><th>Codec</th><th>Size</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (s of m.sources; track s.id) {
                <tr [class.sel]="selectedSourceId() === s.id" (click)="selectSource(s.id)">
                  <td class="fn" [title]="s.filename">{{ s.filename }}</td>
                  <td>{{ s.sampleRate | number }} Hz</td>
                  <td>{{ s.channels }}</td>
                  <td>{{ fmtDuration(s.durationSeconds) }}</td>
                  <td>{{ s.codec }}</td>
                  <td>{{ fmtSize(s.sizeBytes) }}</td>
                  <td><button type="button" class="link" (click)="playSource(s); $event.stopPropagation()">Play</button></td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <!-- Probe extraction --------------------------------------------------->
      <section class="panel">
        <div class="panel-head"><h2>Extract probe</h2></div>
        @if (selectedSource(); as sel) {
          <div class="extract">
            <div class="ex-row">
              <span class="ex-label">Source</span>
              <span class="ex-value" [title]="sel.filename">{{ sel.filename }}</span>
            </div>
            <div class="ex-row">
              <span class="ex-label">Start</span>
              <input
                class="ex-range"
                type="range"
                min="0"
                [max]="maxStart(sel)"
                step="0.5"
                [ngModel]="probeStart()"
                (ngModelChange)="probeStart.set($event)"
              />
              <input
                class="ex-num"
                type="number"
                min="0"
                [max]="maxStart(sel)"
                step="0.5"
                [ngModel]="probeStart()"
                (ngModelChange)="probeStart.set($event)"
              />
              <span class="ex-unit">s of {{ fmtDuration(sel.durationSeconds) }}</span>
            </div>
            <div class="ex-row">
              <span class="ex-label">Length</span>
              <span class="ex-value">{{ probeDuration }} s (native {{ sel.sampleRate | number }} Hz, no resample)</span>
            </div>
            <button type="button" class="btn" (click)="extract(sel)" [disabled]="busy()">
              {{ busy() ? 'Extracting…' : 'Extract 1-minute probe' }}
            </button>
          </div>
        } @else {
          <p class="empty">Select a source above to extract a probe from it.</p>
        }
      </section>

      <!-- Probes ------------------------------------------------------------->
      <section class="panel">
        <div class="panel-head"><h2>Probes</h2></div>
        @if (m.probes.length === 0) {
          <p class="empty">No probes yet.</p>
        } @else {
          <table class="grid">
            <thead>
              <tr><th>File</th><th>From</th><th>Start</th><th>Length</th><th>Rate</th><th></th></tr>
            </thead>
            <tbody>
              @for (p of m.probes; track p.id) {
                <tr>
                  <td class="fn" [title]="p.filename">{{ p.filename }}</td>
                  <td class="fn" [title]="p.sourceFilename">{{ p.sourceFilename }}</td>
                  <td>{{ fmtDuration(p.startSeconds) }}</td>
                  <td>{{ p.durationSeconds }} s</td>
                  <td>{{ p.sampleRate | number }} Hz</td>
                  <td><button type="button" class="link" (click)="playProbe(p)">Play</button></td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    } @else if (!loadError()) {
      <div class="banner info">Loading collection…</div>
    }
  `,
  styles: [`
    :host { display: block; padding: var(--ui-spacing-xl, 24px); overflow-y: auto; height: 100%; }
    .head { margin-bottom: var(--ui-spacing-lg, 16px); }
    h1 { font-size: var(--ui-font-xl, 20px); color: var(--text-primary); }
    .meta { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); margin-top: 2px; }
    .banner {
      padding: 10px 14px; border-radius: 8px; margin-bottom: var(--ui-spacing-lg, 16px);
      font-size: var(--ui-font-sm, 13px); cursor: default;
    }
    .banner.error { background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error); }
    .banner.info { background: var(--accent-subtle); color: var(--text-secondary); border: 1px solid var(--border-default); }
    .playing { margin-bottom: var(--ui-spacing-lg, 16px); }
    .panel {
      background: var(--bg-card); border: 1px solid var(--border-default);
      border-radius: 10px; padding: var(--ui-spacing-lg, 16px); margin-bottom: var(--ui-spacing-lg, 16px);
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--ui-spacing-md, 12px); }
    h2 { font-size: var(--ui-font-lg, 18px); color: var(--text-primary); }
    .btn {
      height: var(--ui-btn-height-sm, 44px); padding: 0 16px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--accent); color: var(--text-inverse);
      font-weight: 600; cursor: pointer;
    }
    .btn:disabled { opacity: 0.55; cursor: default; }
    .empty { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .grid { width: 100%; border-collapse: collapse; font-size: var(--ui-font-sm, 13px); }
    .grid th { text-align: left; color: var(--text-tertiary); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle); }
    .grid td { padding: 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-secondary); vertical-align: middle; }
    .grid tbody tr { cursor: pointer; }
    .grid tbody tr:hover { background: var(--hover-bg); }
    .grid tbody tr.sel { background: var(--accent-subtle); }
    .fn { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
    .link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: inherit; padding: 0; }
    .extract { display: flex; flex-direction: column; gap: var(--ui-spacing-md, 12px); }
    .ex-row { display: flex; align-items: center; gap: var(--ui-spacing-md, 12px); }
    .ex-label { width: 60px; color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
    .ex-value { color: var(--text-primary); font-size: var(--ui-font-sm, 13px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 420px; }
    .ex-range { flex: 1; accent-color: var(--accent); }
    .ex-num { width: 90px; height: 32px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input); border-radius: 6px; padding: 0 8px; }
    .ex-unit { color: var(--text-tertiary); font-size: var(--ui-font-sm, 13px); }
  `],
})
export class CollectionViewComponent {
  private readonly api = inject(ClipforgeApiService);

  /** Name of the collection to display. */
  readonly name = input.required<string>();

  readonly manifest = signal<ClipforgeManifest | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly busy = signal(false);

  readonly selectedSourceId = signal<string | null>(null);
  readonly probeStart = signal<number>(0);
  readonly probeDuration = PROBE_DURATION_SECONDS;

  readonly nowPlaying = signal<{ url: string; label: string } | null>(null);

  private loadToken = 0;

  constructor() {
    // Reload whenever the selected collection changes.
    effect(() => {
      const name = this.name();
      void this.load(name);
    });
  }

  selectedSource(): ClipforgeSource | null {
    const id = this.selectedSourceId();
    const m = this.manifest();
    if (!id || !m) return null;
    return m.sources.find((s) => s.id === id) ?? null;
  }

  private async load(name: string): Promise<void> {
    const token = ++this.loadToken;
    this.loadError.set(null);
    this.actionError.set(null);
    this.notice.set(null);
    this.nowPlaying.set(null);
    this.selectedSourceId.set(null);
    this.manifest.set(null);
    try {
      const manifest = await this.api.openCollection(name);
      if (token !== this.loadToken) return; // superseded by a newer selection
      this.manifest.set(manifest);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.loadError.set(this.msg(err));
    }
  }

  selectSource(id: string): void {
    this.selectedSourceId.set(id);
    this.probeStart.set(0);
  }

  maxStart(source: ClipforgeSource): number {
    // Leave room for at least a fraction of a second before EOF.
    return Math.max(0, Math.floor((source.durationSeconds - 1) * 10) / 10);
  }

  async addSources(): Promise<void> {
    const m = this.manifest();
    if (!m) return;
    this.busy.set(true);
    this.actionError.set(null);
    this.notice.set(null);
    try {
      const res = await this.api.addSources(m.name);
      this.manifest.set(res.manifest);
      const parts: string[] = [];
      if (res.added.length) parts.push(`Added ${res.added.length}: ${res.added.join(', ')}`);
      if (res.skipped.length) parts.push(`Skipped ${res.skipped.length} already-present: ${res.skipped.join(', ')}`);
      this.notice.set(parts.length ? parts.join(' · ') : 'No files selected.');
    } catch (err) {
      this.actionError.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  async extract(source: ClipforgeSource): Promise<void> {
    const m = this.manifest();
    if (!m) return;
    this.busy.set(true);
    this.actionError.set(null);
    this.notice.set(null);
    try {
      const res = await this.api.extractProbe(m.name, source.id, this.probeStart(), this.probeDuration);
      this.manifest.set(res.manifest);
      this.notice.set(`Extracted probe: ${res.probe.filename}`);
    } catch (err) {
      this.actionError.set(this.msg(err));
    } finally {
      this.busy.set(false);
    }
  }

  async playSource(source: ClipforgeSource): Promise<void> {
    const m = this.manifest();
    if (!m) return;
    this.actionError.set(null);
    try {
      const abs = await this.api.sourceMediaPath(m.name, source.id);
      this.nowPlaying.set({ url: this.api.toAudioUrl(abs), label: source.filename });
    } catch (err) {
      this.actionError.set(this.msg(err));
    }
  }

  async playProbe(probe: ClipforgeProbe): Promise<void> {
    const m = this.manifest();
    if (!m) return;
    this.actionError.set(null);
    try {
      const abs = await this.api.probeMediaPath(m.name, probe.id);
      this.nowPlaying.set({ url: this.api.toAudioUrl(abs), label: probe.filename });
    } catch (err) {
      this.actionError.set(this.msg(err));
    }
  }

  fmtDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  fmtSize(bytes: number): string {
    if (!Number.isFinite(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
  }

  private msg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
