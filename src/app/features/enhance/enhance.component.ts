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
  EnhanceProgress,
  EnhanceProcessParams,
  EnhanceMethod,
  RvcEnhanceSettings,
  ReprocessScope,
} from '../../core/services/electron.service';
import { ComponentService } from '../../core/services/component.service';

/** One file in the rail, with its live pipeline state. */
interface EnhanceFileRow {
  id: string;
  path: string;
  /** Session key (cache folder). Empty until the cache entry is known; used to
   *  delete / re-process / export a restored session even if the source moved. */
  key: string;
  name: string;
  durationSec: number;
  sizeBytes: number;
  status: 'idle' | 'processing' | 'ready' | 'error' | 'stopped';
  phase: EnhanceProgress['phase'] | null;
  percentage: number;
  error: string | null;
  /** Main-process job id while processing. Equals `id` for a job started in this
   *  component instance; set to the running job's id when a job is re-adopted after
   *  the tab was unmounted, so Stop targets the correct run. Null when not running. */
  jobId: string | null;
  /** Absolute stem paths (populated once the cache is complete). */
  stems: { voice: string; denoised: string; rest: string; enhanced: string } | null;
  /** defaults ← config ← per-file overrides — what the Advanced panel displays. */
  effectiveParams: EnhanceProcessParams | null;
  /** Effective cleanup method for this file (persisted choice ← 'resemble'). */
  method: EnhanceMethod;
  /** Effective RVC settings for this file (persisted override ← defaults). */
  rvcSettings: RvcEnhanceSettings | null;
}

/**
 * Enhance — local Adobe-Podcast-style speech cleanup for TTS training data.
 *
 * Left rail: drop/add audio or video files, click to select. Center panel (for
 * the selected file): the Speech/Background sliders, live preview, an Advanced
 * disclosure with per-file enhancer params, and Process/Stop + Export.
 *
 * Process always cleans to the maximum: decode → separate → denoise the voice
 * stem (mask-based) AND enhance it generatively. The Speech slider spans
 * denoised (0%) ↔ enhanced (100%) — "just denoise" = enhancement at 0%. The
 * enhancer's input is the RAW voice stem, not the denoised one (pre-denoising
 * measurably increases wobble; ear-validated). The slider lands at 50% (mild
 * enhancement) — Owen's real-world default; 100% is the wobble-heavy extreme.
 *
 * Preview uses three seek-synced <audio> elements (denoised / enhanced / rest)
 * served off the app's bookforge-audio:// streaming protocol so multi-GB stems
 * don't load into memory; slider moves just change per-element volume, so they
 * take effect live. All processing happens in the main process (enhance:* IPC).
 *
 * Speech-slider preview is ENDPOINT-QUANTIZED on purpose: the enhanced render is
 * phase-decorrelated from the denoised stem, so playing both at comparable
 * volumes doubles the voice (comb-filter mud — ear-validated as worse than
 * either endpoint). Export renders intermediate values exactly via an STFT-domain
 * blend in the main process, but regenerating that blend per slider tick is far
 * too heavy for live audition (CPU python pass over potentially GB-scale stems),
 * so preview plays whichever endpoint is nearer (< 50% → denoised, ≥ 50% →
 * enhanced) and the UI says so. The Background stem is a different source, not a
 * phase-twin, so its live gain preview is exact.
 *
 * Advanced params are per-file overrides persisted in the cache manifest
 * (enhance:set-overrides), merged over the config block's defaults; the open
 * params dict passes through to the enhancer CLI, so future flags need no UI or
 * schema change to take effect via config.
 */
@Component({
  selector: 'app-enhance',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="enh">
      <header class="enh-header">
        <h1>✨ Enhance</h1>
        <p class="subtitle">Clean noisy narration (music + chatter behind a voice) into isolated, enhanced speech for TTS training.</p>
      </header>

      @if (readiness() === null) {
        <div class="enh-setup"><p class="setup-loading">Checking Enhance setup…</p></div>
      } @else if (!readiness()!.ok) {
        <div class="enh-setup">
          <div class="setup-card">
            <span class="setup-icon">🧩</span>
            <h2>Voice Enhancement needs setup</h2>
            <p class="setup-reason">{{ readiness()!.reason }}</p>
            <p class="setup-lead">Install the engines below to start cleaning up narration.</p>
            <ul class="setup-list">
              @for (c of setupComponents(); track c.id) {
                <li class="setup-row">
                  <div class="sr-info">
                    <span class="sr-name">{{ c.label }}</span>
                    <span class="sr-note">{{ c.note }}</span>
                  </div>
                  <div class="sr-action">
                    @if (c.busy) {
                      <div class="sr-progress"><div class="sr-fill" [style.width.%]="c.pct"></div></div>
                      <span class="sr-pct">{{ c.pct }}%</span>
                    } @else if (c.installed) {
                      <span class="sr-ok">✓ Installed</span>
                      <desktop-button variant="secondary" size="xs" (click)="installComponent(c.id)">Reinstall</desktop-button>
                    } @else {
                      <desktop-button variant="primary" size="xs" icon="⬇" (click)="installComponent(c.id)">Install</desktop-button>
                    }
                  </div>
                </li>
              }
            </ul>
            @if (addons.error()) { <p class="setup-error">{{ addons.error() }}</p> }
            <div class="setup-foot">
              <desktop-button variant="secondary" size="xs" (click)="recheckReadiness()">Re-check</desktop-button>
              <span class="setup-hint">Engines can also be managed in Settings → Add-ons.</span>
            </div>
          </div>
        </div>
      } @else {
      <div class="enh-body">
        <!-- Left rail: drop zone + file list -->
        <aside class="enh-rail">
          <div
            class="dropzone"
            [class.dragging]="isDragging()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave($event)"
            (drop)="onDrop($event)"
          >
            <span class="dz-icon">🎧</span>
            <p class="dz-text">Drop files here</p>
            <desktop-button variant="secondary" size="xs" icon="＋" (click)="addFiles()">Add files…</desktop-button>
          </div>

          @if (files().length === 0) {
            <p class="rail-empty">No files yet. Video files work too — the audio is extracted automatically.</p>
          } @else {
            <ul class="rail-list">
              @for (f of files(); track f.id) {
                <li class="rail-row" [class.selected]="selectedId() === f.id" (click)="selectFile(f)">
                  <div class="rr-main">
                    <span class="rr-name" [title]="f.path">{{ f.name }}</span>
                    <span class="rr-meta">
                      {{ formatDuration(f.durationSec) }} · {{ formatSize(f.sizeBytes) }}
                      @if (f.status === 'ready') { <span class="rr-ready">✓</span> }
                      @else if (f.status === 'error') { <span class="rr-error-dot" [title]="f.error || ''">✕</span> }
                      @else if (f.status === 'stopped') { <span class="rr-stopped">⏹</span> }
                    </span>
                    @if (f.status === 'processing') {
                      <div class="rr-bar"><div class="rr-fill" [style.width.%]="f.percentage"></div></div>
                    }
                  </div>
                  <button
                    class="rr-delete"
                    title="Delete (clears this file's cache)"
                    [disabled]="f.status === 'processing'"
                    (click)="$event.stopPropagation(); deleteFile(f)"
                  >✕</button>
                </li>
              }
            </ul>
          }
        </aside>

        <!-- Center: selected file's controls, in a contained panel -->
        <main class="enh-main">
          @if (!selectedRow()) {
            <p class="main-hint">Add a file and select it to clean it up.</p>
          } @else {
            <div class="panel">
              <div class="panel-title">
                <h2 [title]="selectedRow()!.path">{{ selectedRow()!.name }}</h2>
                <span class="pt-meta">{{ formatDuration(selectedRow()!.durationSec) }} · {{ formatSize(selectedRow()!.sizeBytes) }}</span>
              </div>

              @if (selectedRow()!.status === 'error') {
                <div class="panel-error">{{ selectedRow()!.error }}</div>
              }

              @if (selectedRow()!.status === 'processing') {
                <div class="panel-progress">
                  <div class="pp-bar"><div class="pp-fill" [style.width.%]="selectedRow()!.percentage"></div></div>
                  <span class="pp-phase">{{ phaseLabel(selectedRow()!.phase) }} {{ selectedRow()!.percentage }}%</span>
                </div>
              }

              <!-- Method: Resemble Enhance (default) vs RVC voice-model conversion.
                   Switching re-renders the voice stem on the next Process. -->
              <div class="method-select">
                <label class="ms-label">Method</label>
                <div class="ms-seg">
                  <button type="button" class="ms-opt" [class.active]="method() === 'resemble'" (click)="onMethodChange('resemble')">Resemble Enhance</button>
                  <button type="button" class="ms-opt" [class.active]="method() === 'rvc'" (click)="onMethodChange('rvc')">RVC voice model</button>
                </div>
              </div>

              <!-- Model selector stays visible (outside the Advanced accordion); the
                   numeric RVC knobs live in the "Advanced" disclosure below. -->
              @if (method() === 'rvc') {
                <div class="rvc-settings">
                  <div class="rvc-row">
                    <label>Voice model</label>
                    @if (rvcVoices().length === 0) {
                      <span class="rvc-empty">No RVC voices installed — add one in Settings → Voice Enhancement.</span>
                    } @else {
                      <select [ngModel]="rvcVoiceId()" (ngModelChange)="onRvcVoiceChange($event)">
                        <option value="">Select a model…</option>
                        @for (v of rvcVoices(); track v.id) { <option [value]="v.id">{{ v.label }}</option> }
                      </select>
                    }
                  </div>
                </div>
              }

              <div class="sliders" [class.disabled]="!previewReady()">
                <div class="slider-block">
                  <div class="slider-head">
                    <label>{{ method() === 'rvc' ? 'Voice conversion' : 'Speech enhancement' }}</label>
                    <span class="slider-val">{{ speechPct() }}%</span>
                  </div>
                  <input
                    type="range" min="0" max="100" step="1"
                    [ngModel]="speechPct()" (ngModelChange)="onSpeechChange($event)"
                    [disabled]="!previewReady()"
                    title="Preview plays the nearer endpoint; Export renders the exact blend"
                  />
                  <div class="slider-ends">
                    <span>{{ method() === 'rvc' ? 'Original' : 'Denoised' }}</span>
                    <span>{{ method() === 'rvc' ? 'RVC voice' : 'Enhanced' }}</span>
                  </div>
                  @if (speechPct() > 0 && speechPct() < 100) {
                    <p class="slider-note">
                      Preview plays the {{ speechPct() < 50 ? 'nearer' : 'further' }} endpoint
                      ({{ speechPct() < 50 ? (method() === 'rvc' ? 'original' : 'denoised') : (method() === 'rvc' ? 'RVC' : 'enhanced') }})
                      — in-between values are spectrally blended on Export.
                    </p>
                  }
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

              <!-- Player: full-width seek bar, then transport controls below -->
              <div class="player">
                <input
                  class="seek"
                  type="range" min="0" [max]="duration()" step="0.01"
                  [value]="currentTime()" (input)="onSeek($event)"
                  [disabled]="!previewReady()"
                />
                <div class="player-times">
                  <span>{{ formatDuration(currentTime()) }}</span>
                  <span>{{ formatDuration(duration()) }}</span>
                </div>
                <div class="player-controls">
                  <button class="pc-btn pc-skip" [disabled]="!previewReady()" (click)="skip(-10)" title="Back 10 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">10</span>
                  </button>
                  <button class="pc-btn pc-skip" [disabled]="!previewReady()" (click)="skip(-5)" title="Back 5 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">5</span>
                  </button>
                  <button class="pc-btn pc-play" [disabled]="!previewReady()" (click)="togglePlay()" [title]="isPlaying() ? 'Pause' : 'Play'">
                    {{ isPlaying() ? '⏸' : '▶' }}
                  </button>
                  <button class="pc-btn pc-skip fwd" [disabled]="!previewReady()" (click)="skip(5)" title="Forward 5 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">5</span>
                  </button>
                  <button class="pc-btn pc-skip fwd" [disabled]="!previewReady()" (click)="skip(10)" title="Forward 10 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">10</span>
                  </button>
                </div>
              </div>

              @if (method() === 'resemble') {
              <details class="advanced">
                <summary>Advanced</summary>
                <p class="adv-note">
                  Per-file enhancer settings, remembered for this file. Applied on the next
                  Process — changing them re-runs only the enhancement stage (separation and
                  denoising are reused).
                </p>
                <div class="adv-grid">
                  <label>NFE steps</label>
                  <input type="number" min="1" max="128" step="1" [ngModel]="nfe()" (ngModelChange)="onParamChange('nfe', +$event)" />
                  <label>Tau</label>
                  <input type="number" min="0" max="1" step="0.05" [ngModel]="tau()" (ngModelChange)="onParamChange('tau', +$event)" />
                  <label>Lambda</label>
                  <input type="number" min="0" max="1" step="0.05" [ngModel]="lambd()" (ngModelChange)="onParamChange('lambd', +$event)" />
                  <label>Solver</label>
                  <select [ngModel]="solver()" (ngModelChange)="onParamChange('solver', $event)">
                    <option value="midpoint">midpoint</option>
                    <option value="rk4">rk4</option>
                    <option value="euler">euler</option>
                  </select>
                  <label>Seeds</label>
                  <input type="number" min="1" max="15" step="1" [ngModel]="seeds()" (ngModelChange)="onParamChange('seeds', +$event)" />
                  <label class="adv-check">
                    <input type="checkbox" [ngModel]="smartChunk()" (ngModelChange)="onParamChange('smartChunk', $event)" />
                    Smart chunking (silence-aware; needed for long files)
                  </label>
                  <label class="adv-check">
                    <input type="checkbox" [ngModel]="anchor()" (ngModelChange)="onParamChange('anchor', $event)" />
                    Envelope anchoring
                  </label>
                </div>
              </details>
              }

              @if (method() === 'rvc') {
              <details class="advanced">
                <summary>Advanced</summary>
                <p class="adv-note">
                  Per-file RVC settings, remembered for this file. Applied on the next
                  Process — changing them re-runs only the voice-conversion stage (separation
                  and denoising are reused).
                </p>
                <div class="adv-grid">
                  <label>Index rate</label>
                  <input type="number" min="0" max="1" step="0.05" [ngModel]="rvcIndexRate()" (ngModelChange)="onRvcSettingChange('indexRate', +$event)" />
                  <label>Protect</label>
                  <input type="number" min="0" max="0.5" step="0.05" [ngModel]="rvcProtect()" (ngModelChange)="onRvcSettingChange('protectRate', +$event)" />
                  <label>Pitch (semitones)</label>
                  <input type="number" min="-24" max="24" step="1" [ngModel]="rvcSemitones()" (ngModelChange)="onRvcSettingChange('nSemitones', +$event)" />
                </div>
              </details>
              }

              <!-- Per-step re-run controls: force ONE pipeline step (and everything
                   after it), reusing every step before it. Only shown once the file
                   is fully processed; hidden while a run is in flight. The RVC path
                   has no real Denoise step (it's a raw-voice copy), so that button is
                   Resemble-only. Decode is never a button — re-running it alone is
                   meaningless and a changed source re-keys the session anyway. -->
              @if (previewReady() && selectedRow()!.status !== 'processing') {
                <div class="reprocess-actions">
                  <span class="ra-label" title="Each step also re-runs the steps after it (upstream steps are reused).">Re-run a step:</span>
                  <desktop-button variant="secondary" size="sm"
                    title="Re-separate speech from background, then re-run everything after it."
                    (click)="processFile(selectedRow()!, 'separate')">Separate</desktop-button>
                  @if (method() === 'resemble') {
                    <desktop-button variant="secondary" size="sm"
                      title="Re-denoise the voice, then re-run Enhance."
                      (click)="processFile(selectedRow()!, 'denoise')">Denoise</desktop-button>
                  }
                  <desktop-button variant="secondary" size="sm"
                    [title]="method() === 'rvc' ? 'Re-run only the RVC voice conversion.' : 'Re-run only the speech enhancement.'"
                    (click)="processFile(selectedRow()!, 'enhance')">{{ method() === 'rvc' ? 'Convert' : 'Enhance' }}</desktop-button>
                  <desktop-button variant="ghost" size="sm"
                    title="Force every step from the start."
                    (click)="processFile(selectedRow()!, 'all')">Everything</desktop-button>
                </div>
              }

              <div class="panel-actions">
                @if (selectedRow()!.status === 'processing') {
                  <desktop-button variant="secondary" icon="⏹" (click)="stopFile(selectedRow()!)">Stop</desktop-button>
                } @else {
                  <desktop-button
                    variant="primary" icon="▶"
                    (click)="processFile(selectedRow()!)"
                  >Process</desktop-button>
                }
                <desktop-button variant="secondary" icon="⬇" [disabled]="!previewReady() || exporting()" (click)="exportMix()">
                  {{ exporting() ? 'Exporting…' : 'Export mix…' }}
                </desktop-button>
              </div>
            </div>
          }

          <!-- Seek-synced preview elements (kept in the DOM; sources swap on select). -->
          <audio #denoisedAudio class="hidden-audio" preload="metadata"
            (loadedmetadata)="onMasterMeta()" (timeupdate)="onMasterTime()" (ended)="onEnded()"></audio>
          <audio #enhancedAudio class="hidden-audio" preload="metadata"></audio>
          <audio #restAudio class="hidden-audio" preload="metadata"></audio>
        </main>
      </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .enh { display: flex; flex-direction: column; height: 100%; background: var(--bg-base); color: var(--text-primary); }
    .enh-header { padding: 20px 24px 12px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .enh-header h1 { margin: 0; font-size: 20px; font-weight: 700; }
    .subtitle { margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); max-width: 680px; }

    /* Setup gate — shown instead of the workspace when an engine is missing. */
    .enh-setup { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; overflow: auto; }
    .setup-loading { color: var(--text-secondary); font-size: 14px; }
    .setup-card {
      width: 100%; max-width: 560px; padding: 28px 28px 22px; border-radius: 12px;
      background: var(--bg-elevated, var(--bg-sunken)); border: 1px solid var(--border-default);
      text-align: center;
    }
    .setup-icon { font-size: 34px; line-height: 1; }
    .setup-card h2 { margin: 12px 0 6px; font-size: 18px; font-weight: 700; }
    .setup-reason { margin: 0 auto 4px; font-size: 13px; color: var(--accent); max-width: 460px; }
    .setup-lead { margin: 0 0 18px; font-size: 13px; color: var(--text-secondary); }
    .setup-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 10px; text-align: left; }
    .setup-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 12px 14px; border-radius: 8px; background: var(--bg-sunken); border: 1px solid var(--border-subtle);
    }
    .sr-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .sr-name { font-size: 14px; font-weight: 600; }
    .sr-note { font-size: 12px; color: var(--text-secondary); }
    .sr-action { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .sr-ok { font-size: 12px; color: var(--text-secondary); }
    .sr-progress { width: 90px; height: 6px; border-radius: 3px; background: var(--bg-base); overflow: hidden; }
    .sr-fill { height: 100%; background: var(--accent); transition: width .2s ease; }
    .sr-pct { font-size: 12px; color: var(--text-secondary); min-width: 34px; text-align: right; }
    .setup-error { margin: 10px 0 0; font-size: 12px; color: var(--danger, #e5484d); }
    .setup-foot { margin-top: 16px; display: flex; align-items: center; justify-content: center; gap: 12px; }
    .setup-hint { font-size: 12px; color: var(--text-secondary); }

    .enh-body { display: flex; flex: 1; min-height: 0; }

    /* ── Left rail ── */
    .enh-rail {
      width: 280px; flex-shrink: 0; display: flex; flex-direction: column; gap: 10px;
      padding: 12px; overflow-y: auto;
      background: var(--bg-sidebar); border-right: 1px solid var(--border-subtle);
    }
    .dropzone {
      border: 2px dashed var(--border-default); border-radius: 10px;
      background: var(--bg-sunken); transition: border-color 0.15s, background 0.15s;
      display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 10px;
    }
    .dropzone.dragging { border-color: var(--accent); background: var(--bg-elevated); }
    .dz-icon { font-size: 20px; }
    .dz-text { margin: 0; font-size: 12px; color: var(--text-secondary); }

    .rail-empty { font-size: 12px; color: var(--text-muted); line-height: 1.5; padding: 0 4px; }

    .rail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .rail-row {
      display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      border: 1px solid var(--border-subtle); border-radius: 8px;
      background: var(--bg-card); cursor: pointer; transition: border-color 0.15s, background 0.15s;
    }
    .rail-row:hover { background: var(--bg-hover); }
    .rail-row.selected { border-color: var(--accent); background: var(--bg-elevated); }
    .rr-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .rr-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rr-meta { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 6px; }
    .rr-ready { color: var(--text-secondary); }
    .rr-error-dot { color: var(--accent); }
    .rr-stopped { color: var(--text-muted); }
    .rr-bar { height: 4px; border-radius: 2px; background: var(--bg-sunken); overflow: hidden; }
    .rr-fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    .rr-delete {
      flex-shrink: 0; width: 22px; height: 22px; border-radius: 5px;
      border: none; background: transparent; color: var(--text-muted);
      font-size: 11px; cursor: pointer; transition: all 0.15s;
    }
    .rr-delete:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .rr-delete:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Center panel ── */
    .enh-main { flex: 1; min-width: 0; overflow-y: auto; padding: 24px; }
    .main-hint { font-size: 13px; color: var(--text-muted); text-align: center; margin-top: 48px; }
    .panel {
      max-width: 620px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px;
      background: var(--bg-card); border: 1px solid var(--border-subtle); border-radius: 12px;
      padding: 20px 24px;
    }
    .panel-title { display: flex; flex-direction: column; gap: 2px; }
    .panel-title h2 { margin: 0; font-size: 16px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pt-meta { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }

    .panel-error {
      padding: 10px 14px; border-radius: 8px; font-size: 13px;
      background: var(--bg-sunken); border: 1px solid var(--border-accent); color: var(--text-primary);
    }
    .panel-progress { display: flex; flex-direction: column; gap: 6px; }
    .pp-bar { height: 6px; border-radius: 3px; background: var(--bg-sunken); overflow: hidden; }
    .pp-fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    .pp-phase { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

    .sliders { display: flex; flex-direction: column; gap: 18px; }
    .sliders.disabled { opacity: 0.5; }
    .slider-block { display: flex; flex-direction: column; gap: 6px; }
    .slider-head { display: flex; justify-content: space-between; align-items: baseline; }
    .slider-head label { font-size: 13px; font-weight: 600; }
    .slider-val { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .slider-block input[type=range] { width: 100%; accent-color: var(--accent); }
    .slider-ends { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); }
    .slider-note { margin: 2px 0 0; font-size: 11px; color: var(--text-muted); line-height: 1.4; }

    /* Player — a distinct block, divided from the effect sliders above. */
    .player {
      display: flex; flex-direction: column; gap: 8px;
      border-top: 1px solid var(--border-subtle); padding-top: 16px;
    }
    .player .seek { width: 100%; accent-color: var(--accent); }
    .player-times {
      display: flex; justify-content: space-between;
      font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums;
    }
    /* Round transport buttons matching the BookForge / bookshelf player windows:
       muted round skip/secondary buttons + a larger accent play button. */
    .player-controls { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 4px; }
    .pc-btn {
      position: relative; flex-shrink: 0; width: 44px; height: 44px; padding: 0;
      border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary);
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .pc-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--text-primary) 12%, transparent); }
    .pc-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    /* Skip buttons: a replay glyph with the seconds count overlaid; forward
       mirrors the glyph (as the players do). */
    .pc-skip .pc-replay { font-size: 30px; line-height: 1; }
    .pc-skip.fwd .pc-replay { transform: scaleX(-1); }
    .pc-num {
      position: absolute; top: 53%; left: 50%; transform: translate(-50%, -50%);
      font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; pointer-events: none;
    }
    .pc-play {
      width: 60px; height: 60px; background: var(--accent); color: white; font-size: 22px;
      transition: transform 0.15s, background 0.15s;
    }
    .pc-play:hover:not(:disabled) { transform: scale(1.05); background: var(--accent); }

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

    /* Method selector — segmented control matching the panel's card idiom. */
    .method-select { display: flex; flex-direction: column; gap: 6px; }
    .ms-label { font-size: 13px; font-weight: 600; }
    .ms-seg { display: inline-flex; border: 1px solid var(--border-input); border-radius: 8px; overflow: hidden; align-self: flex-start; }
    .ms-opt {
      padding: 6px 14px; border: none; background: var(--bg-input); color: var(--text-secondary);
      font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s;
    }
    .ms-opt + .ms-opt { border-left: 1px solid var(--border-input); }
    .ms-opt:hover:not(.active) { background: var(--bg-hover); }
    .ms-opt.active { background: var(--accent); color: white; }

    /* RVC settings (shown when method = rvc). */
    .rvc-settings { display: flex; flex-direction: column; gap: 12px; }
    .rvc-row { display: flex; flex-direction: column; gap: 6px; }
    .rvc-row > label { font-size: 12px; color: var(--text-secondary); }
    .rvc-row select {
      padding: 6px 8px; border: 1px solid var(--border-input); border-radius: 6px;
      background: var(--bg-input); color: var(--text-primary); font-size: 12px;
    }
    .rvc-empty { font-size: 12px; color: var(--text-muted); }

    /* Per-phase re-run row — a labelled group of small secondary buttons, above the
       primary Process/Export row and divided from it like the player block. */
    .reprocess-actions {
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
      border-top: 1px solid var(--border-subtle); padding-top: 14px;
    }
    .ra-label { font-size: 12px; color: var(--text-muted); margin-right: 2px; }

    .panel-actions { display: flex; justify-content: flex-end; gap: 10px; }

    .hidden-audio { display: none; }
  `],
})
export class EnhanceComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly dialog = inject(DialogService);
  private readonly zone = inject(NgZone);
  readonly addons = inject(ComponentService);

  /** The managed engines the Enhance tab needs. Stable public component ids. */
  private readonly REQUIRED = [
    { id: 'resemble-env', label: 'Resemble Enhance', note: 'denoise + speech enhancement engine' },
    { id: 'rvc-env', label: 'Voice separation (RVC)', note: 'isolates speech from music / background' },
  ];

  @ViewChild('denoisedAudio') denoisedAudioRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('enhancedAudio') enhancedAudioRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('restAudio') restAudioRef!: ElementRef<HTMLAudioElement>;

  readonly files = signal<EnhanceFileRow[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly readiness = signal<{ ok: boolean; reason?: string } | null>(null);
  readonly isDragging = signal(false);
  readonly exporting = signal(false);

  // Mix sliders (0–100 in the UI, 0–1 to the mixer). Speech lands at 50% — mild
  // enhancement is Owen's real-world default; 100% is the wobble-heavy extreme.
  readonly speechPct = signal(50);
  readonly backgroundPct = signal(0);

  // Advanced enhancer params for the SELECTED file (per-file overrides, persisted
  // in the cache manifest). Populated from effectiveParams on select; edits are
  // saved via enhance:set-overrides. The dict is open — these are the v1 knobs.
  readonly nfe = signal(64);
  readonly tau = signal(0.75);
  readonly lambd = signal(0.1);
  readonly solver = signal('midpoint');
  readonly seeds = signal(5);
  readonly smartChunk = signal(true);
  readonly anchor = signal(true);

  // Cleanup method + RVC settings for the SELECTED file (persisted per-file in the
  // cache manifest, like the resemble Advanced params above). 'resemble' is the
  // default; 'rvc' re-renders the isolated voice through a chosen RVC voice model
  // (the same conversion the assembly page runs post-TTS).
  readonly method = signal<EnhanceMethod>('resemble');
  readonly rvcVoiceId = signal('');
  readonly rvcIndexRate = signal(0.5);
  readonly rvcProtect = signal(0.5);
  readonly rvcSemitones = signal(0);

  /** Installed RVC voice models, from the SAME component catalog the Settings /
   *  assembly page uses (kind 'rvc-model'); the component id is the voiceId the
   *  backend resolves to a model folder. */
  readonly rvcVoices = computed(() =>
    this.addons.components()
      .filter((s) => s.component.kind === 'rvc-model' && s.state === 'installed')
      .map((s) => ({ id: s.component.id, label: s.component.name })));

  // Preview transport state.
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);

  readonly selectedRow = computed(() => this.files().find((f) => f.id === this.selectedId()) ?? null);
  readonly previewReady = computed(() => {
    const row = this.selectedRow();
    return !!row && row.status === 'ready' && !!row.stems;
  });

  /** Per-required-engine view state for the setup panel. Reactive on the
   *  component list, so cards live-update as installs progress. */
  readonly setupComponents = computed(() => {
    const list = this.addons.components();
    return this.REQUIRED.map((r) => {
      const c = list.find((x) => x.component.id === r.id);
      return {
        ...r,
        installed: c?.state === 'installed',
        busy: c?.state === 'installing' || this.addons.isBusy(r.id),
        pct: c?.progress?.pct ?? 0,
      };
    });
  });

  private unsubscribeProgress: (() => void) | null = null;
  private nextId = 1;

  async ngOnInit(): Promise<void> {
    await this.recheckReadiness();
    // Load the add-ons catalog so the setup panel can show install state/actions.
    this.addons.ensureLoaded();
    // Rebuild the working set from disk so files persist across app restarts.
    await this.restoreSessions();

    this.unsubscribeProgress = this.electron.onEnhanceProgress((data) => {
      this.zone.run(() => this.applyProgress(data.jobId, data.key, data.progress));
    });

    // Re-adopt any Process job still running in the main process. A job keeps
    // running when the user navigates away from this tab (the component unmounts
    // but the main-process child does not stop), so on return we restore the row's
    // live 'processing' state instead of leaving it looking idle/orphaned.
    await this.reconnectActiveJobs();
  }

  /** Restore the 'processing' state of jobs that kept running while this tab was
   *  unmounted. Matches a running job to its row by the stable session key and
   *  adopts the job's id so Stop and later progress events target the right run. */
  private async reconnectActiveJobs(): Promise<void> {
    const res = await this.electron.enhanceListActive();
    if (!res.success || !res.data) return;
    for (const job of res.data) {
      const row = this.files().find((f) => (job.key && f.key === job.key) || f.path === job.sourcePath);
      if (!row) continue;
      const p = job.progress;
      this.patchRow(row.id, {
        jobId: job.jobId,
        status: 'processing',
        phase: p?.phase ?? 'preparing',
        percentage: p?.percentage ?? 0,
        error: null,
      });
    }
  }

  /** Rebuild the file rail from cached sessions on disk so the working set
   *  persists across restarts (until the user deletes or exports them). */
  private async restoreSessions(): Promise<void> {
    const res = await this.electron.enhanceListSessions();
    if (!res.success || !res.data) return;
    const existingKeys = new Set(this.files().map((f) => f.key).filter(Boolean));
    const restored: EnhanceFileRow[] = res.data
      .filter((s) => !existingKeys.has(s.key))
      .map((s) => ({
        id: `enh-${this.nextId++}`,
        jobId: null,
        path: s.sourcePath,
        key: s.key,
        name: s.sourceName,
        durationSec: s.durationSec,
        sizeBytes: s.sizeBytes,
        status: s.complete ? 'ready' : 'idle',
        phase: s.complete ? 'complete' : null,
        percentage: s.complete ? 100 : 0,
        error: null,
        stems: s.complete && s.stems ? s.stems : null,
        effectiveParams: s.effectiveParams,
        method: s.method,
        rvcSettings: s.rvcSettings,
      }));
    if (!restored.length) return;
    this.files.update((list) => [...list, ...restored]);
    if (!this.selectedId()) this.selectFile(restored[0]);
  }

  /** Re-evaluate whether Enhance can run (env presence, script, etc.). */
  async recheckReadiness(): Promise<void> {
    const r = await this.electron.enhanceReadiness();
    if (r.success && r.data) this.readiness.set(r.data);
  }

  /** Install (or reinstall) one required engine, then re-check readiness so the
   *  workspace appears automatically once everything resolves. */
  async installComponent(id: string): Promise<void> {
    await this.addons.install(id);
    await this.recheckReadiness();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
    this.pausePreview();
  }

  // ── File rail ──

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
      jobId: null,
      path,
      key: '',
      name,
      durationSec: 0,
      sizeBytes: 0,
      status: 'idle',
      phase: null,
      percentage: 0,
      error: null,
      stems: null,
      effectiveParams: null,
      method: 'resemble',
      rvcSettings: null,
    };
    this.files.update((list) => [...list, row]);

    const probe = await this.electron.enhanceProbeFile(path);
    if (probe.success && probe.data) {
      this.patchRow(row.id, { durationSec: probe.data.durationSec, sizeBytes: probe.data.sizeBytes });
    }

    // Restore state from a prior session's cache (stems + per-file overrides) so
    // a re-add is instantly playable with its remembered settings.
    const cache = await this.electron.enhanceGetCache(path);
    if (cache.success && cache.data) {
      const patch: Partial<EnhanceFileRow> = {
        key: cache.data.key,
        effectiveParams: cache.data.effectiveParams,
        method: cache.data.method,
        rvcSettings: cache.data.rvcSettings,
      };
      if (cache.data.complete && cache.data.stems) {
        patch.status = 'ready';
        patch.stems = cache.data.stems;
        patch.percentage = 100;
        patch.phase = 'complete';
      }
      this.patchRow(row.id, patch);
    }

    // Auto-select the first file added so the center panel isn't empty.
    if (!this.selectedId()) {
      const added = this.files().find((f) => f.id === row.id);
      if (added) this.selectFile(added);
    }
  }

  selectFile(row: EnhanceFileRow): void {
    if (this.selectedId() === row.id) return;
    this.pausePreview();
    this.selectedId.set(row.id);
    this.applyParamsToInputs(row.effectiveParams);
    this.applyMethodToInputs(row);
    this.loadPreviewSources();
  }

  async deleteFile(row: EnhanceFileRow): Promise<void> {
    if (row.status === 'processing') return;
    if (this.selectedId() === row.id) {
      this.pausePreview();
      this.selectedId.set(null);
    }
    this.files.update((list) => list.filter((f) => f.id !== row.id));
    // Delete the whole session folder — original + all enhancement assets. Key
    // it by the session key so it works even if the source file has moved.
    if (row.key) await this.electron.enhanceClearCacheByKey(row.key);
    else await this.electron.enhanceClearCache(row.path);
  }

  // ── Advanced params (per-file overrides) ──

  private applyParamsToInputs(params: EnhanceProcessParams | null): void {
    if (!params) return;
    if (typeof params['nfe'] === 'number') this.nfe.set(params['nfe']);
    if (typeof params['tau'] === 'number') this.tau.set(params['tau']);
    if (typeof params['lambd'] === 'number') this.lambd.set(params['lambd']);
    if (typeof params['solver'] === 'string') this.solver.set(params['solver']);
    if (typeof params['seeds'] === 'number') this.seeds.set(params['seeds']);
    if (typeof params['smartChunk'] === 'boolean') this.smartChunk.set(params['smartChunk']);
    if (typeof params['anchor'] === 'boolean') this.anchor.set(params['anchor']);
  }

  /** Populate the method selector + RVC controls from a row's persisted settings. */
  private applyMethodToInputs(row: EnhanceFileRow): void {
    this.method.set(row.method ?? 'resemble');
    const rvc = row.rvcSettings;
    this.rvcVoiceId.set(rvc?.voiceId ?? '');
    this.rvcIndexRate.set(rvc?.indexRate ?? 0.5);
    this.rvcProtect.set(rvc?.protectRate ?? 0.5);
    this.rvcSemitones.set(rvc?.nSemitones ?? 0);
  }

  // ── Method + RVC settings (per-file overrides) ──

  async onMethodChange(method: EnhanceMethod): Promise<void> {
    if (this.method() === method) return;
    this.method.set(method);
    const row = this.selectedRow();
    if (!row) return;
    const res = await this.electron.enhanceSetOverrides(row.path, { method }, row.key || undefined);
    if (res.success && res.data) {
      this.patchRow(row.id, { method: res.data.method, rvcSettings: res.data.rvcSettings });
    }
  }

  async onRvcVoiceChange(voiceId: string): Promise<void> {
    this.rvcVoiceId.set(voiceId);
    await this.saveRvcSettings({ voiceId });
  }

  async onRvcSettingChange(key: 'indexRate' | 'protectRate' | 'nSemitones', value: number): Promise<void> {
    switch (key) {
      case 'indexRate': this.rvcIndexRate.set(value); break;
      case 'protectRate': this.rvcProtect.set(value); break;
      case 'nSemitones': this.rvcSemitones.set(value); break;
    }
    await this.saveRvcSettings({ [key]: value });
  }

  /** Persist just the changed RVC field — the manifest merges it over existing
   *  RVC overrides, so unrelated fields are never clobbered. */
  private async saveRvcSettings(patch: Partial<RvcEnhanceSettings>): Promise<void> {
    const row = this.selectedRow();
    if (!row) return;
    const res = await this.electron.enhanceSetOverrides(row.path, { rvcSettings: patch }, row.key || undefined);
    if (res.success && res.data) {
      this.patchRow(row.id, { method: res.data.method, rvcSettings: res.data.rvcSettings });
    }
  }

  async onParamChange(key: string, value: number | string | boolean): Promise<void> {
    switch (key) {
      case 'nfe': this.nfe.set(value as number); break;
      case 'tau': this.tau.set(value as number); break;
      case 'lambd': this.lambd.set(value as number); break;
      case 'solver': this.solver.set(value as string); break;
      case 'seeds': this.seeds.set(value as number); break;
      case 'smartChunk': this.smartChunk.set(value as boolean); break;
      case 'anchor': this.anchor.set(value as boolean); break;
    }
    const row = this.selectedRow();
    if (!row) return;
    // Persist just the edited key — the manifest merges it over existing
    // overrides, so config-driven or future keys are never clobbered.
    const res = await this.electron.enhanceSetOverrides(row.path, { params: { [key]: value } }, row.key || undefined);
    if (res.success && res.data) {
      this.patchRow(row.id, { effectiveParams: res.data.effectiveParams });
    }
  }

  // ── Process / stop ──

  /** Process the file. `reprocess` forces a phase (and its downstream) regardless
   *  of cache; the default 'auto' does only what's needed (the primary Process). */
  async processFile(row: EnhanceFileRow, reprocess: ReprocessScope = 'auto'): Promise<void> {
    if (this.readiness() && !this.readiness()!.ok) return;
    this.patchRow(row.id, { jobId: row.id, status: 'processing', phase: 'preparing', percentage: 0, error: null });

    // No explicit resemble params: the bridge resolves defaults ← config ← this
    // file's persisted Advanced overrides. Method + RVC settings ARE passed
    // explicitly from the current UI selection (they also persist in the manifest).
    // Pass the session key (if known) so a restored session re-processes even
    // when its source file has moved (decode falls back to the stored original).
    const res = await this.electron.enhanceProcess(row.id, {
      sourcePath: row.path,
      key: row.key || undefined,
      method: this.method(),
      rvcSettings: this.method() === 'rvc'
        ? {
            voiceId: this.rvcVoiceId(),
            indexRate: this.rvcIndexRate(),
            protectRate: this.rvcProtect(),
            nSemitones: this.rvcSemitones(),
          }
        : undefined,
      reprocess,
    });
    // The terminal 'complete'/'error' progress event usually lands first; this
    // reconciles the row in case the invoke result arrives on its own.
    if (res.success && res.data?.key && !row.key) this.patchRow(row.id, { key: res.data.key });
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
    // Target the main-process job id (may differ from row.id after a re-adopt).
    await this.electron.enhanceStop(row.jobId ?? row.id);
    this.patchRow(row.id, { status: 'stopped', phase: null, jobId: null });
  }

  private applyProgress(jobId: string, key: string, progress: EnhanceProgress): void {
    // Match by the main-process job id OR the stable session key: after a
    // navigate-away/back the row's id is fresh, so a still-running job's events
    // only line up on its (re-adopted) jobId or on the key.
    const row = this.files().find((f) => f.jobId === jobId || f.id === jobId || (key && f.key === key));
    if (!row) return;
    const id = row.id;

    if (progress.phase === 'complete') {
      this.electron.enhanceGetCache(row.path).then((cache) => {
        if (cache.success && cache.data?.complete && cache.data.stems) {
          this.patchRow(id, { status: 'ready', stems: cache.data.stems, percentage: 100, phase: 'complete', error: null, jobId: null });
          if (this.selectedId() === id) this.loadPreviewSources();
        }
      });
      return;
    }
    if (progress.phase === 'error') {
      this.patchRow(id, { status: 'error', error: progress.error || 'Processing failed', phase: null, jobId: null });
      return;
    }
    this.patchRow(id, { status: 'processing', phase: progress.phase, percentage: progress.percentage });
  }

  private patchRow(id: string, patch: Partial<EnhanceFileRow>): void {
    this.files.update((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  // ── Preview (three seek-synced <audio> elements) ──

  private audios(): HTMLAudioElement[] {
    return [
      this.denoisedAudioRef?.nativeElement,
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
      const [denoised, enhanced, rest] = [
        this.denoisedAudioRef?.nativeElement,
        this.enhancedAudioRef?.nativeElement,
        this.restAudioRef?.nativeElement,
      ];
      if (!denoised || !enhanced || !rest) return;
      if (row?.stems) {
        denoised.src = this.electron.enhanceAudioUrl(row.stems.denoised);
        enhanced.src = this.electron.enhanceAudioUrl(row.stems.enhanced);
        rest.src = this.electron.enhanceAudioUrl(row.stems.rest);
        denoised.load(); enhanced.load(); rest.load();
        this.applyVolumes();
      } else {
        denoised.removeAttribute('src'); enhanced.removeAttribute('src'); rest.removeAttribute('src');
      }
    }, 0);
  }

  private applyVolumes(): void {
    // Speech preview is endpoint-quantized: NEVER play denoised + enhanced
    // together at comparable volumes — they're phase-decorrelated twins and their
    // sum doubles the voice (see the class comment). Export handles in-betweens.
    const playEnhanced = this.speechPct() >= 50;
    const background = this.backgroundPct() / 100;
    const denoised = this.denoisedAudioRef?.nativeElement;
    const enhanced = this.enhancedAudioRef?.nativeElement;
    const rest = this.restAudioRef?.nativeElement;
    if (denoised) denoised.volume = playEnhanced ? 0 : 1;
    if (enhanced) enhanced.volume = playEnhanced ? 1 : 0;
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
    const master = this.denoisedAudioRef?.nativeElement;
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

  /** Jump the transport by `delta` seconds (negative = rewind), clamped to the
   *  clip. Reads from the master element so it's accurate mid-playback, and
   *  re-syncs every follower to stay aligned. */
  skip(delta: number): void {
    if (!this.previewReady()) return;
    const master = this.denoisedAudioRef?.nativeElement;
    const base = master ? master.currentTime : this.currentTime();
    const dur = this.duration();
    const t = Math.max(0, Math.min(dur > 0 ? dur : base, base + delta));
    this.currentTime.set(t);
    for (const a of this.audios()) a.currentTime = t;
  }

  onMasterMeta(): void {
    const master = this.denoisedAudioRef?.nativeElement;
    if (master && Number.isFinite(master.duration)) this.duration.set(master.duration);
  }

  onMasterTime(): void {
    const master = this.denoisedAudioRef?.nativeElement;
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
        key: row.key || undefined,
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
      case 'denoising': return 'Denoising';
      case 'enhancing': return 'Enhancing';
      case 'complete': return 'Done';
      case 'error': return 'Error';
      default: return '';
    }
  }
}
