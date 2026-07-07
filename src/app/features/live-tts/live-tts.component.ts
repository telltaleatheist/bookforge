import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  DesktopButtonComponent,
  DesktopSelectComponent,
  DesktopSelectOption,
} from '../../creamsicle-desktop';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';
import { ElectronService, StreamSchedulerEvent } from '../../core/services/electron.service';
import { WorkerConfigService } from '../../core/services/worker-config.service';
import { TtsServerService } from '../../core/services/tts-server.service';
import { PlayTextService } from '../audiobook/services/play-text.service';
import { PlaySettings } from '../audiobook/models/play.types';
import {
  LiveTake,
  bytesToBase64,
  concatInt16,
  decodePcm16Base64,
  encodeWav,
} from './wav.util';

/** A take plus the object URL powering its inline <audio> player. */
type SessionTake = LiveTake & { audioUrl: string };

/**
 * Live TTS — type a paragraph, render it in your voice via the streaming engine,
 * audition it, and download the WAV. Built on the same resident streaming engine
 * as the Listen player (WorkerConfigService / TtsServerService / stream:* IPC);
 * the only new bit is capturing the streamed PCM into a downloadable WAV
 * (wav.util.ts) since nothing in the streaming path writes files.
 */
@Component({
  selector: 'app-live-tts',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, DesktopSelectComponent],
  template: `
    <div class="live-tts">
      <header class="lt-header">
        <h1>🎤 Live TTS</h1>
        <p class="subtitle">Type text, render it in your voice, audition, and download the WAV. Great for ad reads and testing voice fidelity.</p>
      </header>

      <div class="lt-body">
        <!-- Left: compose + settings -->
        <section class="lt-compose">
          <div class="settings-card">
            <div class="settings-row">
              <label class="field-label">Engine</label>
              <div class="engine-toggle">
                @for (e of workerCfg.engines(); track e.id) {
                  <button
                    class="engine-btn"
                    [class.active]="workerCfg.engine() === e.id"
                    [disabled]="!e.available || busy()"
                    [title]="e.available ? '' : (e.reason || 'Unavailable on this machine')"
                    (click)="setEngine(e.id)"
                  >{{ e.name }}</button>
                }
              </div>
            </div>

            <div class="settings-row">
              <label class="field-label">Voice</label>
              <desktop-select
                class="lt-select"
                [options]="voiceOptions()"
                [ngModel]="workerCfg.voice()"
                (ngModelChange)="onVoiceChange($event)"
                [disabled]="busy()"
                placeholder="Choose a voice…"
                ariaLabel="Voice"
              />
            </div>

            @if (!workerCfg.isOrpheus()) {
              <div class="settings-row">
                <label class="field-label">Device</label>
                <desktop-select
                  class="lt-select"
                  [options]="deviceOptions"
                  [ngModel]="workerCfg.devicePref()"
                  (ngModelChange)="onDeviceChange($event)"
                  [disabled]="busy()"
                  ariaLabel="Device"
                />
              </div>
            }

            <div class="slider-row">
              <label class="field-label">Speed</label>
              <input type="range" min="0.5" max="2" step="0.05"
                [ngModel]="speed()" (ngModelChange)="speed.set($event)" [disabled]="busy()" />
              <span class="slider-value">{{ speed().toFixed(2) }}×</span>
            </div>

            @if (!workerCfg.isOrpheus()) {
              <div class="slider-row">
                <label class="field-label">Temperature</label>
                <input type="range" min="0.1" max="1" step="0.05"
                  [ngModel]="temperature()" (ngModelChange)="temperature.set($event)" [disabled]="busy()" />
                <span class="slider-value">{{ temperature().toFixed(2) }}</span>
              </div>
              <div class="slider-row">
                <label class="field-label">Top-P</label>
                <input type="range" min="0.1" max="1" step="0.05"
                  [ngModel]="topP()" (ngModelChange)="topP.set($event)" [disabled]="busy()" />
                <span class="slider-value">{{ topP().toFixed(2) }}</span>
              </div>
              <div class="slider-row">
                <label class="field-label">Repetition</label>
                <input type="range" min="1" max="10" step="0.5"
                  [ngModel]="repetitionPenalty()" (ngModelChange)="repetitionPenalty.set($event)" [disabled]="busy()" />
                <span class="slider-value">{{ repetitionPenalty().toFixed(1) }}</span>
              </div>
            }
          </div>

          <textarea
            class="lt-textarea"
            [ngModel]="text()"
            (ngModelChange)="text.set($event)"
            [disabled]="isGenerating()"
            placeholder="Type your ad copy or test text here…"
          ></textarea>

          <div class="lt-actions">
            @if (isGenerating()) {
              <desktop-button variant="secondary" icon="⏹" (click)="stop()">Stop</desktop-button>
            } @else {
              <desktop-button variant="primary" icon="🎙" [disabled]="!canGenerate()" (click)="generate()">
                Generate
              </desktop-button>
            }
            <span class="lt-status" [class.busy]="busy()">
              @if (busy()) { <span class="lt-spinner"></span> }
              {{ statusText() }}
            </span>
            <span class="char-count">{{ text().length }} chars</span>
          </div>

          @if (errorMsg()) {
            <p class="lt-error">{{ errorMsg() }}</p>
          }
          @if (busy() && ttsServer.warmupPct() !== null) {
            <div class="warmup-bar"><div class="warmup-fill" [style.width.%]="ttsServer.warmupPct()"></div></div>
          }
        </section>

        <!-- Right: take list -->
        <section class="lt-takes">
          <h2>Takes <span class="takes-count">{{ takes().length }}</span></h2>
          @if (takes().length === 0) {
            <p class="takes-empty">No takes yet. Render some text to build a list you can compare and download.</p>
          }
          @for (take of takes(); track take.id) {
            <div class="take-card">
              <div class="take-head">
                <div class="take-meta">
                  <span class="take-label">{{ take.label }}</span>
                  <span class="take-sub">{{ take.engine }} · {{ fmtDuration(take.durationSec) }}</span>
                </div>
                <button class="take-delete" title="Delete take" (click)="deleteTake(take.id)">✕</button>
              </div>
              <p class="take-text">{{ take.text }}</p>
              <audio class="take-audio" controls preload="metadata" [src]="take.audioUrl"></audio>
              <div class="take-actions">
                <desktop-button variant="secondary" size="sm" icon="⬇" (click)="download(take)">Download WAV</desktop-button>
              </div>
            </div>
          }
        </section>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .live-tts {
      display: flex; flex-direction: column; height: 100%;
      background: var(--surface-0); color: var(--text-primary);
    }
    .lt-header { padding: 20px 24px 12px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .lt-header h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .subtitle { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); max-width: 640px; }

    .lt-body { display: flex; flex: 1; min-height: 0; gap: 0; }
    .lt-compose {
      flex: 1 1 60%; min-width: 0; display: flex; flex-direction: column;
      gap: 12px; padding: 16px 24px; overflow-y: auto;
    }
    .lt-takes {
      flex: 1 1 40%; max-width: 420px; min-width: 300px;
      border-left: 1px solid var(--border-subtle);
      padding: 16px 20px; overflow-y: auto; background: var(--surface-1);
    }
    .lt-takes h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .takes-count {
      font-size: 11px; font-weight: 600; color: var(--text-secondary);
      background: var(--bg-hover, var(--surface-2)); border-radius: 10px; padding: 1px 8px;
    }
    .takes-empty { font-size: 13px; color: var(--text-muted); line-height: 1.5; }

    .settings-card {
      background: var(--bg-surface, var(--surface-1));
      border: 1px solid var(--border-subtle); border-radius: 10px;
      padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
    }
    .settings-row { display: flex; align-items: center; gap: 12px; }
    .field-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); width: 92px; flex-shrink: 0; }
    .lt-select { flex: 1; min-width: 0; }

    .engine-toggle { display: flex; gap: 6px; }
    .engine-btn {
      padding: 5px 14px; border: 1px solid var(--border-default); border-radius: 6px;
      background: var(--bg-surface, var(--surface-1)); color: var(--text-secondary);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    .engine-btn:hover:not(:disabled) { background: var(--bg-hover, var(--surface-2)); color: var(--text-primary); }
    .engine-btn.active {
      border-color: var(--accent, var(--accent-primary));
      background: color-mix(in srgb, var(--accent, var(--accent-primary)) 12%, transparent);
      color: var(--accent, var(--accent-primary));
    }
    .engine-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .slider-row { display: flex; align-items: center; gap: 12px; }
    .slider-row input[type=range] { flex: 1; accent-color: var(--accent, var(--accent-primary)); }
    .slider-value {
      font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums;
      min-width: 44px; text-align: right;
    }

    .lt-textarea {
      flex: 1; min-height: 160px; resize: vertical;
      padding: 12px 14px; border: 1px solid var(--border-input, var(--border-default));
      border-radius: 8px; background: var(--bg-input, var(--surface-1));
      color: var(--text-primary); font-size: 14px; line-height: 1.6; outline: none;
      font-family: inherit; transition: border-color 0.15s;
    }
    .lt-textarea::placeholder { color: var(--text-muted); }
    .lt-textarea:focus { border-color: var(--accent, var(--accent-primary)); }
    .lt-textarea:disabled { opacity: 0.6; }

    .lt-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .lt-status { font-size: 12px; color: var(--text-secondary); display: inline-flex; align-items: center; gap: 7px; }
    .lt-status.busy { color: var(--accent, var(--accent-primary)); font-weight: 600; }
    .char-count { margin-left: auto; font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .lt-error { margin: 0; font-size: 13px; color: var(--accent-danger, #ef4444); }

    .lt-spinner {
      width: 12px; height: 12px; border: 2px solid var(--border-default);
      border-top-color: var(--accent, var(--accent-primary)); border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .warmup-bar {
      width: 100%; height: 6px; background: var(--bg-sunken, rgba(127,127,127,0.2));
      border-radius: 3px; overflow: hidden;
    }
    .warmup-fill { height: 100%; background: var(--accent, var(--accent-primary)); transition: width 0.3s ease; }

    .take-card {
      background: var(--bg-surface, var(--surface-1)); border: 1px solid var(--border-subtle);
      border-radius: 10px; padding: 12px; margin-bottom: 12px;
    }
    .take-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .take-meta { display: flex; flex-direction: column; min-width: 0; }
    .take-label { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .take-sub { font-size: 11px; color: var(--text-muted); text-transform: capitalize; font-variant-numeric: tabular-nums; }
    .take-delete {
      width: 24px; height: 24px; border: none; border-radius: 6px; background: transparent;
      color: var(--text-muted); font-size: 12px; cursor: pointer; flex-shrink: 0; transition: all 0.15s;
    }
    .take-delete:hover { background: color-mix(in srgb, var(--accent-danger, #ef4444) 14%, transparent); color: var(--accent-danger, #ef4444); }
    .take-text {
      margin: 8px 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .take-audio { width: 100%; height: 34px; margin: 4px 0 8px; }
    .take-actions { display: flex; justify-content: flex-end; }
  `]
})
export class LiveTtsComponent implements OnInit, OnDestroy {
  readonly electron = inject(ElectronService);
  readonly workerCfg = inject(WorkerConfigService);
  readonly ttsServer = inject(TtsServerService);
  private readonly playText = inject(PlayTextService);
  private readonly dialog = inject(DialogService);

  // ── Compose state ──
  readonly text = signal('');
  readonly speed = signal(1.0);
  readonly temperature = signal(0.75);
  readonly topP = signal(0.85);
  readonly repetitionPenalty = signal(5.0);

  // ── Generation state ──
  readonly isGenerating = signal(false);
  readonly sentencesDone = signal(0);
  readonly sentencesTotal = signal(0);
  readonly errorMsg = signal<string | null>(null);

  // ── Take list (session-only) ──
  readonly takes = signal<SessionTake[]>([]);

  readonly deviceOptions: DesktopSelectOption[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'cpu', label: 'CPU' },
    { value: 'gpu', label: 'GPU' },
    { value: 'mps', label: 'MPS (Apple)' },
  ];

  readonly voiceOptions = computed<DesktopSelectOption[]>(() =>
    this.workerCfg.voices().map(v => ({ value: v, label: this.prettyVoice(v) })),
  );

  readonly busy = computed(() =>
    this.isGenerating() || this.ttsServer.state() === 'warming' || this.ttsServer.state() === 'starting',
  );

  readonly canGenerate = computed(() => this.text().trim().length > 0 && !this.busy());

  readonly statusText = computed(() => {
    if (this.isGenerating()) {
      const total = this.sentencesTotal();
      return total > 0 ? `Generating… ${this.sentencesDone()}/${total}` : 'Generating…';
    }
    switch (this.ttsServer.state()) {
      case 'starting': return 'Starting engine…';
      case 'warming': {
        const p = this.ttsServer.warmupPct();
        return p !== null ? `Loading voice model ${p}%…` : 'Loading voice model…';
      }
      case 'running': return 'Engine ready';
      default: return 'Engine idle';
    }
  });

  // Monotonic id so stale stream events (from an aborted render) are ignored.
  private streamRequestId = 0;
  private unsubscribeStreamEvents?: () => void;

  // PCM capture for the in-flight render, keyed by sentence index → seq'd chunks.
  private captureChunks = new Map<number, Array<{ seq: number; s: Int16Array }>>();
  private captureSampleRate = 24000;
  private captureText = '';
  private captureSettings: PlaySettings = { voice: '', speed: 1 };
  private captureEngine: 'xtts' | 'orpheus' = 'xtts';

  ngOnInit(): void {
    this.unsubscribeStreamEvents = this.electron.onStreamEvent(e => this.handleStreamEvent(e));
  }

  ngOnDestroy(): void {
    this.unsubscribeStreamEvents?.();
    if (this.isGenerating()) void this.electron.streamStop();
    this.streamRequestId++;
    for (const t of this.takes()) URL.revokeObjectURL(t.audioUrl);
  }

  // ── Settings handlers (persist through WorkerConfigService, engine-aware) ──
  setEngine(engine: 'xtts' | 'orpheus'): void { void this.workerCfg.setEngine(engine); }
  onVoiceChange(voice: string): void { void this.workerCfg.setVoice(voice); }
  onDeviceChange(pref: string): void { void this.workerCfg.setDevicePref(pref as 'auto' | 'cpu' | 'gpu' | 'mps'); }

  // ── Generate ──
  async generate(): Promise<void> {
    const raw = this.text().trim();
    if (!raw || this.isGenerating()) return;

    const sentences = this.playText
      .optimizeForTTS(this.playText.splitIntoSentences(raw))
      .map(s => s.text)
      .filter(t => t.trim().length > 0);
    if (sentences.length === 0) return;

    this.errorMsg.set(null);
    this.sentencesTotal.set(sentences.length);
    this.sentencesDone.set(0);

    const voice = this.workerCfg.voice();
    if (!voice) { this.errorMsg.set('No voice selected'); return; }

    // Ensure the resident engine is running + warm (persists between renders).
    if (this.ttsServer.state() !== 'running') {
      const started = await this.ttsServer.start(voice);
      if (!started.success) {
        this.errorMsg.set(started.error || 'Failed to start the TTS engine');
        return;
      }
    }
    // Make sure the selected voice is the one actually loaded (no-op if it matches).
    await this.electron.playLoadVoice(voice);

    const requestId = ++this.streamRequestId;
    this.captureChunks.clear();
    this.captureSampleRate = 24000;
    this.captureText = raw;
    this.captureEngine = this.workerCfg.engine();
    const settings: PlaySettings = this.workerCfg.isOrpheus()
      ? { voice, speed: this.speed() }
      : {
          voice,
          speed: this.speed(),
          temperature: this.temperature(),
          topP: this.topP(),
          repetitionPenalty: this.repetitionPenalty(),
        };
    this.captureSettings = settings;

    this.isGenerating.set(true);

    const result = await this.electron.streamStart(sentences, 0, settings, requestId);
    if (!result.success && requestId === this.streamRequestId) {
      this.isGenerating.set(false);
      this.errorMsg.set(result.error || 'Failed to start streaming');
    }
  }

  /** Abort the in-flight render — its events go stale and no take is produced. */
  stop(): void {
    this.streamRequestId++;
    this.isGenerating.set(false);
    void this.electron.streamStop();
  }

  private handleStreamEvent(e: StreamSchedulerEvent): void {
    if (e.requestId !== this.streamRequestId) return; // stale / aborted render

    switch (e.kind) {
      case 'chunk': {
        if (!e.data) break;
        const idx = e.sentenceIndex ?? 0;
        const arr = this.captureChunks.get(idx) ?? [];
        arr.push({ seq: e.seq ?? arr.length, s: decodePcm16Base64(e.data) });
        this.captureChunks.set(idx, arr);
        if (e.sampleRate) this.captureSampleRate = e.sampleRate;
        break;
      }
      case 'done':
        this.sentencesDone.update(n => n + 1);
        break;
      case 'failed':
        this.sentencesDone.update(n => n + 1);
        console.warn('[LiveTTS] sentence failed:', e.sentenceIndex, e.error);
        break;
      case 'complete':
        this.finishTake();
        break;
    }
  }

  /** Assemble the captured PCM into a WAV and push a new take. */
  private finishTake(): void {
    this.isGenerating.set(false);

    const indices = [...this.captureChunks.keys()].sort((a, b) => a - b);
    const parts: Int16Array[] = [];
    for (const i of indices) {
      const ordered = this.captureChunks.get(i)!.sort((a, b) => a.seq - b.seq).map(c => c.s);
      parts.push(concatInt16(ordered));
    }
    const pcm = concatInt16(parts);
    if (pcm.length === 0) {
      this.errorMsg.set('No audio was produced for that text.');
      return;
    }

    const sampleRate = this.captureSampleRate;
    const wavBytes = encodeWav(pcm, sampleRate);
    const durationSec = pcm.length / sampleRate;
    // encodeWav returns a full-span Uint8Array, so .buffer is the exact backing
    // ArrayBuffer (the cast just narrows TS's ArrayBufferLike union for Blob).
    const audioUrl = URL.createObjectURL(new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }));
    const createdAt = Date.now();

    const take: SessionTake = {
      id: `take-${createdAt}`,
      label: `${this.prettyVoice(this.captureSettings.voice)} · ${new Date(createdAt).toLocaleTimeString()}`,
      text: this.captureText,
      wavBytes,
      sampleRate,
      durationSec,
      engine: this.captureEngine,
      settings: this.captureSettings,
      createdAt,
      audioUrl,
    };
    this.takes.update(list => [take, ...list]);
  }

  // ── Take actions ──
  async download(take: SessionTake): Promise<void> {
    const safeVoice = (take.settings.voice || 'voice').replace(/[^a-z0-9]+/gi, '_');
    const b64 = bytesToBase64(take.wavBytes);
    const res = await this.electron.saveWav(b64, `live-tts-${safeVoice}-${take.createdAt}.wav`);
    if (!res.success && !res.canceled) {
      await this.dialog.alert({ title: 'Save failed', message: res.error || 'Could not save the WAV file.' });
    }
  }

  deleteTake(id: string): void {
    const take = this.takes().find(t => t.id === id);
    if (take) URL.revokeObjectURL(take.audioUrl);
    this.takes.update(list => list.filter(t => t.id !== id));
  }

  // ── Helpers ──
  fmtDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${sec.toFixed(1)}s`;
  }

  /** XTTS voice ids can be library paths like `eng/Foo/bar.wav`; show a readable name. */
  private prettyVoice(v: string): string {
    if (!v) return '';
    const base = v.split('/').pop() || v;
    return base.replace(/\.(wav|pth)$/i, '');
  }
}
