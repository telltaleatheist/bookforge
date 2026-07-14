import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';
import {
  ElectronService,
  EnhanceCacheEntry,
  EnhanceProgress,
  EnhanceProcessParams,
} from '../../core/services/electron.service';

/** One file in the vertical list, with its live pipeline state. */
interface EnhanceFileRow {
  id: string;
  path: string;
  name: string;
  durationSec: number;
  sizeBytes: number;
  status: 'idle' | 'processing' | 'ready' | 'error' | 'stopped';
  phase: EnhanceProgress['phase'] | null;
  percentage: number;
  error: string | null;
  /** Absolute stem paths (populated once the cache is complete). */
  stems: { voice: string; rest: string; enhanced: string } | null;
}

/**
 * Enhance — local Adobe-Podcast-style speech cleanup for TTS training data.
 *
 * Add audio/video files, Process each (decode → separate speech from background →
 * Resemble-Enhance the speech), then audition the mix live: the Speech slider
 * crossfades the isolated speech ↔ the enhanced speech, and Background gains the
 * removed background stem back in. Export renders the current mix to a WAV.
 *
 * Preview uses three seek-synced <audio> elements (voice / enhanced / rest) served
 * off the app's bookforge-audio:// streaming protocol so multi-GB stems don't load
 * into memory; slider moves just change per-element volume, so they take effect
 * live. All of processing happens in the main process (enhance:* IPC); this
 * component only drives the UI and the cached stems.
 */
@Component({
  selector: 'app-enhance',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="enh">
      <header class="enh-header">
        <h1>✨ Enhance</h1>
        <p class="subtitle">Clean noisy narration (music + chatter behind a voice) into isolated, enhanced speech for TTS training. Add files, Process, then audition the mix and export.</p>
      </header>

      @if (readiness() && !readiness()!.ok) {
        <div class="enh-warning">
          <span class="warn-icon">⚠</span>
          <span>{{ readiness()!.reason }}</span>
        </div>
      }

      <div class="enh-body">
        <!-- Left: drop zone + file list -->
        <section class="enh-files">
          <div
            class="dropzone"
            [class.dragging]="isDragging()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave($event)"
            (drop)="onDrop($event)"
          >
            <div class="dz-inner">
              <span class="dz-icon">🎧</span>
              <p class="dz-text">Drop audio or video files here</p>
              <desktop-button variant="secondary" size="sm" icon="＋" (click)="addFiles()">Add files…</desktop-button>
            </div>
          </div>

          @if (files().length === 0) {
            <p class="files-empty">No files yet. Video files work too — the audio is extracted automatically.</p>
          } @else {
            <ul class="file-list">
              @for (f of files(); track f.id) {
                <li class="file-row" [class.selected]="selectedId() === f.id" (click)="selectFile(f)">
                  <div class="fr-main">
                    <span class="fr-name" [title]="f.path">{{ f.name }}</span>
                    <span class="fr-meta">{{ formatDuration(f.durationSec) }} · {{ formatSize(f.sizeBytes) }}</span>
                  </div>

                  @if (f.status === 'processing') {
                    <div class="fr-progress">
                      <div class="fr-bar"><div class="fr-fill" [style.width.%]="f.percentage"></div></div>
                      <span class="fr-phase">{{ phaseLabel(f.phase) }} {{ f.percentage }}%</span>
                    </div>
                  } @else if (f.status === 'error') {
                    <span class="fr-error" [title]="f.error || ''">{{ f.error }}</span>
                  } @else if (f.status === 'ready') {
                    <span class="fr-ready">✓ Processed</span>
                  } @else if (f.status === 'stopped') {
                    <span class="fr-stopped">Stopped</span>
                  }

                  <div class="fr-actions" (click)="$event.stopPropagation()">
                    @if (f.status === 'processing') {
                      <button class="fr-btn fr-stop" (click)="stopFile(f)">Stop</button>
                    } @else {
                      <button class="fr-btn fr-process" [disabled]="readiness() ? !readiness()!.ok : false" (click)="processFile(f)">Process</button>
                    }
                    <button class="fr-btn fr-delete" [disabled]="f.status === 'processing'" (click)="deleteFile(f)">Delete</button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>

        <!-- Right: preview + sliders -->
        <aside class="enh-panel">
          <h2>Mix</h2>
          @if (!selectedRow()) {
            <p class="panel-hint">Select a processed file to audition and export its mix.</p>
          }

          <div class="sliders" [class.disabled]="!previewReady()">
            <div class="slider-block">
              <div class="slider-head">
                <label>Speech</label>
                <span class="slider-val">{{ speechPct() }}%</span>
              </div>
              <input
                type="range" min="0" max="100" step="1"
                [ngModel]="speechPct()" (ngModelChange)="onSpeechChange($event)"
                [disabled]="!previewReady()"
              />
              <div class="slider-ends"><span>Original</span><span>Enhanced</span></div>
            </div>

            <div class="slider-block">
              <div class="slider-head">
                <label>Background</label>
                <span class="slider-val">{{ backgroundPct() }}%</span>
              </div>
              <input
                type="range" min="0" max="100" step="1"
                [ngModel]="backgroundPct()" (ngModelChange)="onBackgroundChange($event)"
                [disabled]="!previewReady()"
              />
              <div class="slider-ends"><span>Removed</span><span>Original</span></div>
            </div>
          </div>

          <!-- Transport -->
          <div class="transport">
            <button class="tp-btn" [disabled]="!previewReady()" (click)="togglePlay()">
              {{ isPlaying() ? '⏸' : '▶' }}
            </button>
            <input
              class="seek"
              type="range" min="0" [max]="duration()" step="0.01"
              [value]="currentTime()" (input)="onSeek($event)"
              [disabled]="!previewReady()"
            />
            <span class="tp-time">{{ formatDuration(currentTime()) }} / {{ formatDuration(duration()) }}</span>
          </div>

          <details class="advanced">
            <summary>Enhance parameters</summary>
            <p class="adv-note">Applied on the next Process. Changing these re-runs only the enhancement stage (decode + separation are reused).</p>
            <div class="adv-grid">
              <label>NFE steps</label>
              <input type="number" min="1" max="128" step="1" [ngModel]="nfe()" (ngModelChange)="nfe.set(+$event)" />
              <label>Tau</label>
              <input type="number" min="0" max="1" step="0.05" [ngModel]="tau()" (ngModelChange)="tau.set(+$event)" />
              <label>Lambda</label>
              <input type="number" min="0" max="1" step="0.05" [ngModel]="lambd()" (ngModelChange)="lambd.set(+$event)" />
              <label>Solver</label>
              <select [ngModel]="solver()" (ngModelChange)="solver.set($event)">
                <option value="midpoint">midpoint</option>
                <option value="rk4">rk4</option>
                <option value="euler">euler</option>
              </select>
              <label class="adv-check">
                <input type="checkbox" [ngModel]="denoiseOnly()" (ngModelChange)="denoiseOnly.set($event)" />
                Denoise only
              </label>
            </div>
          </details>

          <div class="panel-actions">
            <desktop-button variant="primary" icon="⬇" [disabled]="!previewReady() || exporting()" (click)="exportMix()">
              {{ exporting() ? 'Exporting…' : 'Export mix…' }}
            </desktop-button>
          </div>

          <!-- Seek-synced preview elements (kept in the DOM; sources swap on select). -->
          <audio #voiceAudio class="hidden-audio" preload="metadata"
            (loadedmetadata)="onMasterMeta()" (timeupdate)="onMasterTime()" (ended)="onEnded()"></audio>
          <audio #enhancedAudio class="hidden-audio" preload="metadata"></audio>
          <audio #restAudio class="hidden-audio" preload="metadata"></audio>
        </aside>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .enh { display: flex; flex-direction: column; height: 100%; background: var(--bg-base); color: var(--text-primary); }
    .enh-header { padding: 20px 24px 12px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .enh-header h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .subtitle { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); max-width: 680px; }

    .enh-warning {
      margin: 12px 24px 0; padding: 10px 14px; border-radius: 8px;
      background: var(--bg-sunken); border: 1px solid var(--border-default);
      color: var(--text-secondary); font-size: 13px; display: flex; align-items: center; gap: 8px;
    }
    .warn-icon { color: var(--accent); }

    .enh-body { display: flex; flex: 1; min-height: 0; }
    .enh-files { flex: 1 1 60%; min-width: 0; display: flex; flex-direction: column; gap: 12px; padding: 16px 24px; overflow-y: auto; }
    .enh-panel {
      flex: 1 1 40%; max-width: 440px; min-width: 320px;
      border-left: 1px solid var(--border-subtle); background: var(--bg-surface);
      padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;
    }
    .enh-panel h2 { margin: 0; font-size: 15px; font-weight: 600; }
    .panel-hint { margin: 0; font-size: 13px; color: var(--text-muted); line-height: 1.5; }

    .dropzone {
      border: 2px dashed var(--border-default); border-radius: 12px;
      background: var(--bg-sunken); transition: border-color 0.15s, background 0.15s;
    }
    .dropzone.dragging { border-color: var(--accent); background: var(--bg-elevated); }
    .dz-inner { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 16px; }
    .dz-icon { font-size: 26px; }
    .dz-text { margin: 0; font-size: 13px; color: var(--text-secondary); }

    .files-empty { font-size: 13px; color: var(--text-muted); line-height: 1.5; }

    .file-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .file-row {
      display: flex; align-items: center; gap: 12px; padding: 10px 12px;
      border: 1px solid var(--border-subtle); border-radius: 8px;
      background: var(--bg-card); cursor: pointer; transition: border-color 0.15s, background 0.15s;
    }
    .file-row:hover { background: var(--bg-hover); }
    .file-row.selected { border-color: var(--accent); }
    .fr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .fr-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fr-meta { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

    .fr-progress { display: flex; flex-direction: column; gap: 4px; min-width: 150px; }
    .fr-bar { height: 5px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden; }
    .fr-fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    .fr-phase { font-size: 11px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .fr-error { font-size: 11px; color: var(--accent); max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fr-ready { font-size: 12px; color: var(--text-secondary); }
    .fr-stopped { font-size: 12px; color: var(--text-muted); }

    .fr-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .fr-btn {
      padding: 5px 12px; border: 1px solid var(--border-default); border-radius: 6px;
      background: var(--bg-surface); color: var(--text-secondary);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .fr-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .fr-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .fr-process { border-color: var(--border-accent); color: var(--accent); }
    .fr-stop { border-color: var(--border-accent); color: var(--accent); }

    .sliders { display: flex; flex-direction: column; gap: 18px; }
    .sliders.disabled { opacity: 0.5; }
    .slider-block { display: flex; flex-direction: column; gap: 6px; }
    .slider-head { display: flex; justify-content: space-between; align-items: baseline; }
    .slider-head label { font-size: 13px; font-weight: 600; }
    .slider-val { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .slider-block input[type=range] { width: 100%; accent-color: var(--accent); }
    .slider-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); }

    .transport { display: flex; align-items: center; gap: 10px; }
    .tp-btn {
      width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
      border: 1px solid var(--border-default); background: var(--bg-surface);
      color: var(--text-primary); font-size: 13px; cursor: pointer;
    }
    .tp-btn:hover:not(:disabled) { background: var(--bg-hover); }
    .tp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .seek { flex: 1; min-width: 0; accent-color: var(--accent); }
    .tp-time { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

    .advanced { border-top: 1px solid var(--border-subtle); padding-top: 12px; }
    .advanced summary { font-size: 13px; font-weight: 600; cursor: pointer; color: var(--text-secondary); }
    .adv-note { margin: 8px 0; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
    .adv-grid { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; }
    .adv-grid label { font-size: 12px; color: var(--text-secondary); }
    .adv-grid input[type=number], .adv-grid select {
      padding: 5px 8px; border: 1px solid var(--border-input); border-radius: 6px;
      background: var(--bg-input); color: var(--text-primary); font-size: 12px; width: 100%;
    }
    .adv-check { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .adv-check input { accent-color: var(--accent); }

    .panel-actions { display: flex; justify-content: flex-end; }

    .hidden-audio { display: none; }
  `],
})
export class EnhanceComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly dialog = inject(DialogService);
  private readonly zone = inject(NgZone);

  @ViewChild('voiceAudio') voiceAudioRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('enhancedAudio') enhancedAudioRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('restAudio') restAudioRef!: ElementRef<HTMLAudioElement>;

  readonly files = signal<EnhanceFileRow[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly readiness = signal<{ ok: boolean; reason?: string } | null>(null);
  readonly isDragging = signal(false);
  readonly exporting = signal(false);

  // Mix sliders (0–100 in the UI, 0–1 to the mixer).
  readonly speechPct = signal(100);
  readonly backgroundPct = signal(0);

  // Enhance params (applied on the next Process).
  readonly nfe = signal(64);
  readonly tau = signal(0.5);
  readonly lambd = signal(0.9);
  readonly solver = signal('midpoint');
  readonly denoiseOnly = signal(false);

  // Preview transport state.
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);

  readonly selectedRow = computed(() => this.files().find((f) => f.id === this.selectedId()) ?? null);
  readonly previewReady = computed(() => {
    const row = this.selectedRow();
    return !!row && row.status === 'ready' && !!row.stems;
  });

  private unsubscribeProgress: (() => void) | null = null;
  private nextId = 1;

  async ngOnInit(): Promise<void> {
    const r = await this.electron.enhanceReadiness();
    if (r.success && r.data) this.readiness.set(r.data);

    this.unsubscribeProgress = this.electron.onEnhanceProgress((data) => {
      this.zone.run(() => this.applyProgress(data.jobId, data.progress));
    });
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
    this.pausePreview();
  }

  // ── File list ──

  async addFiles(): Promise<void> {
    const res = await this.electron.enhancePickFiles();
    if (res.success && res.filePaths) {
      for (const p of res.filePaths) await this.addPath(p);
    }
  }

  onDragOver(e: DragEvent): void {
    e.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(e: DragEvent): void {
    e.preventDefault();
    this.isDragging.set(false);
  }

  async onDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.isDragging.set(false);
    const dropped = e.dataTransfer?.files;
    if (!dropped) return;
    for (let i = 0; i < dropped.length; i++) {
      // Electron exposes the absolute path on dropped File objects.
      const p = (dropped[i] as unknown as { path?: string }).path;
      if (p) await this.addPath(p);
    }
  }

  private async addPath(path: string): Promise<void> {
    if (this.files().some((f) => f.path === path)) return; // already listed
    const name = path.split(/[\\/]/).pop() || path;
    const row: EnhanceFileRow = {
      id: `enh-${this.nextId++}`,
      path,
      name,
      durationSec: 0,
      sizeBytes: 0,
      status: 'idle',
      phase: null,
      percentage: 0,
      error: null,
      stems: null,
    };
    this.files.update((list) => [...list, row]);

    const probe = await this.electron.enhanceProbeFile(path);
    if (probe.success && probe.data) {
      this.patchRow(row.id, { durationSec: probe.data.durationSec, sizeBytes: probe.data.sizeBytes });
    }

    // Restore state from a prior session's cache so a re-add is instantly playable.
    const cache = await this.electron.enhanceGetCache(path);
    if (cache.success && cache.data?.complete && cache.data.stems) {
      this.patchRow(row.id, { status: 'ready', stems: cache.data.stems, percentage: 100, phase: 'complete' });
    }
  }

  selectFile(row: EnhanceFileRow): void {
    if (this.selectedId() === row.id) return;
    this.pausePreview();
    this.selectedId.set(row.id);
    this.loadPreviewSources();
  }

  async deleteFile(row: EnhanceFileRow): Promise<void> {
    if (row.status === 'processing') return;
    if (this.selectedId() === row.id) {
      this.pausePreview();
      this.selectedId.set(null);
    }
    this.files.update((list) => list.filter((f) => f.id !== row.id));
    await this.electron.enhanceClearCache(row.path);
  }

  // ── Process / stop ──

  async processFile(row: EnhanceFileRow): Promise<void> {
    if (this.readiness() && !this.readiness()!.ok) return;
    this.patchRow(row.id, { status: 'processing', phase: 'preparing', percentage: 0, error: null });

    const params: Partial<EnhanceProcessParams> = {
      nfe: this.nfe(),
      tau: this.tau(),
      lambd: this.lambd(),
      solver: this.solver(),
      denoiseOnly: this.denoiseOnly(),
    };

    const res = await this.electron.enhanceProcess(row.id, { sourcePath: row.path, params });
    // The terminal 'complete'/'error' progress event usually lands first; this
    // reconciles the row in case the invoke result arrives on its own.
    if (res.success && res.data?.complete && res.data.stems) {
      this.patchRow(row.id, { status: 'ready', stems: res.data.stems, percentage: 100, phase: 'complete', error: null });
      if (this.selectedId() === row.id) this.loadPreviewSources();
    } else if (res.wasStopped) {
      this.patchRow(row.id, { status: 'stopped', phase: null });
    } else if (!res.success) {
      this.patchRow(row.id, { status: 'error', error: res.error || 'Processing failed', phase: null });
    }
  }

  async stopFile(row: EnhanceFileRow): Promise<void> {
    await this.electron.enhanceStop(row.id);
    this.patchRow(row.id, { status: 'stopped', phase: null });
  }

  private applyProgress(jobId: string, progress: EnhanceProgress): void {
    const row = this.files().find((f) => f.id === jobId);
    if (!row) return;

    if (progress.phase === 'complete') {
      this.electron.enhanceGetCache(row.path).then((cache) => {
        if (cache.success && cache.data?.complete && cache.data.stems) {
          this.patchRow(jobId, { status: 'ready', stems: cache.data.stems, percentage: 100, phase: 'complete', error: null });
          if (this.selectedId() === jobId) this.loadPreviewSources();
        }
      });
      return;
    }
    if (progress.phase === 'error') {
      this.patchRow(jobId, { status: 'error', error: progress.error || 'Processing failed', phase: null });
      return;
    }
    this.patchRow(jobId, { status: 'processing', phase: progress.phase, percentage: progress.percentage });
  }

  private patchRow(id: string, patch: Partial<EnhanceFileRow>): void {
    this.files.update((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  // ── Preview (three seek-synced <audio> elements) ──

  private audios(): HTMLAudioElement[] {
    return [
      this.voiceAudioRef?.nativeElement,
      this.enhancedAudioRef?.nativeElement,
      this.restAudioRef?.nativeElement,
    ].filter(Boolean) as HTMLAudioElement[];
  }

  private loadPreviewSources(): void {
    const row = this.selectedRow();
    this.currentTime.set(0);
    this.duration.set(0);
    // Defer so the ViewChild audio elements exist for a freshly-selected file.
    setTimeout(() => {
      const [voice, enhanced, rest] = [
        this.voiceAudioRef?.nativeElement,
        this.enhancedAudioRef?.nativeElement,
        this.restAudioRef?.nativeElement,
      ];
      if (!voice || !enhanced || !rest) return;
      if (row?.stems) {
        voice.src = this.electron.enhanceAudioUrl(row.stems.voice);
        enhanced.src = this.electron.enhanceAudioUrl(row.stems.enhanced);
        rest.src = this.electron.enhanceAudioUrl(row.stems.rest);
        voice.load(); enhanced.load(); rest.load();
        this.applyVolumes();
      } else {
        voice.removeAttribute('src'); enhanced.removeAttribute('src'); rest.removeAttribute('src');
      }
    }, 0);
  }

  private applyVolumes(): void {
    const speech = this.speechPct() / 100;
    const background = this.backgroundPct() / 100;
    const voice = this.voiceAudioRef?.nativeElement;
    const enhanced = this.enhancedAudioRef?.nativeElement;
    const rest = this.restAudioRef?.nativeElement;
    if (voice) voice.volume = 1 - speech;
    if (enhanced) enhanced.volume = speech;
    if (rest) rest.volume = background;
  }

  onSpeechChange(v: number): void { this.speechPct.set(+v); this.applyVolumes(); }
  onBackgroundChange(v: number): void { this.backgroundPct.set(+v); this.applyVolumes(); }

  togglePlay(): void {
    if (!this.previewReady()) return;
    if (this.isPlaying()) this.pausePreview();
    else this.playPreview();
  }

  private playPreview(): void {
    const master = this.voiceAudioRef?.nativeElement;
    if (!master) return;
    // Re-sync the followers to the master before playing so they stay aligned.
    for (const a of this.audios()) {
      if (a !== master) a.currentTime = master.currentTime;
    }
    this.applyVolumes();
    for (const a of this.audios()) a.play().catch(() => { /* preview autoplay/permission — ignore */ });
    this.isPlaying.set(true);
  }

  private pausePreview(): void {
    for (const a of this.audios()) { try { a.pause(); } catch { /* ignore */ } }
    this.isPlaying.set(false);
  }

  onSeek(e: Event): void {
    const t = parseFloat((e.target as HTMLInputElement).value);
    this.currentTime.set(t);
    for (const a of this.audios()) a.currentTime = t;
  }

  onMasterMeta(): void {
    const master = this.voiceAudioRef?.nativeElement;
    if (master && Number.isFinite(master.duration)) this.duration.set(master.duration);
  }

  onMasterTime(): void {
    const master = this.voiceAudioRef?.nativeElement;
    if (master) this.currentTime.set(master.currentTime);
  }

  onEnded(): void {
    this.pausePreview();
    this.currentTime.set(0);
    for (const a of this.audios()) a.currentTime = 0;
  }

  // ── Export ──

  async exportMix(): Promise<void> {
    const row = this.selectedRow();
    if (!row || !this.previewReady()) return;
    const defaultName = row.name.replace(/\.[^.]+$/, '') + '_enhanced.wav';
    const pick = await this.electron.enhancePickExportPath(defaultName);
    if (!pick.success || !pick.filePath) return;

    this.exporting.set(true);
    try {
      const res = await this.electron.enhanceExport({
        sourcePath: row.path,
        outputPath: pick.filePath,
        speech: this.speechPct() / 100,
        background: this.backgroundPct() / 100,
      });
      if (res.success) {
        await this.dialog.alert({ title: 'Export complete', message: `Saved to:\n${res.outputPath}` });
      } else {
        await this.dialog.alert({ title: 'Export failed', message: res.error || 'Unknown error' });
      }
    } finally {
      this.exporting.set(false);
    }
  }

  // ── Formatting ──

  formatDuration(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return (h > 0 ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
  }

  formatSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
  }

  phaseLabel(phase: EnhanceProgress['phase'] | null): string {
    switch (phase) {
      case 'preparing': return 'Preparing';
      case 'decoding': return 'Decoding';
      case 'separating': return 'Separating';
      case 'enhancing': return 'Enhancing';
      case 'complete': return 'Done';
      case 'error': return 'Error';
      default: return '';
    }
  }
}
