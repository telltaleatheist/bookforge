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
  EnhanceStemAvailability,
  ReprocessScope,
} from '../../core/services/electron.service';

/** The three pipeline steps, in canonical order (also the chip ids). */
type ChipId = 'separate' | 'denoise' | 'enhance';
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
  /** Absolute stem PATHS (populated for any cached session; check `available` for
   *  which actually exist on disk). */
  stems: { voice: string; denoised: string; rest: string; enhanced: string } | null;
  /** Per-stem on-disk availability — drives the chip lit state + slider enable. */
  available: EnhanceStemAvailability | null;
  /** True when every stage output is present (full cascade done). Gates Export. */
  complete: boolean;
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
 * the selected file): a three-step CHIP STEPPER (Separate → Denoise → Enhance),
 * per-chip controls, an always-usable preview transport, and a split Process
 * button.
 *
 * Chip stepper: each chip lights when its stem exists on disk (à la carte steps
 * mean a session can have some stems without being fully complete). Exactly one
 * chip is ACTIVE; the active chip drives BOTH (a) what the preview plays and
 * (b) which controls show — Separate → the Background balance; Denoise → a note;
 * Enhance → the Original↔Enhanced (RVC: Original↔RVC) blend slider + RVC/resemble
 * Advanced settings.
 *
 * Process: the main button runs the full cascade (auto); the attached arrow opens
 * the three steps to run à la carte, in any order. A single step runs on the
 * best-available input — the separated raw voice if present, else the decoded
 * ORIGINAL — and never auto-runs its prerequisites (backend reprocess scope).
 * Generate always consumes the RAW input, never the denoised stem (pre-denoising
 * increases wobble; ear-validated); Denoise is a PARALLEL cleaned-speech view.
 *
 * Preview: four seek-synced <audio> elements (voice / denoised / enhanced / rest)
 * served off bookforge-audio://; volumes switch per active chip so a stage's
 * output plays instantly, and when the active step hasn't been rendered the
 * transport falls back to the ORIGINAL (so play/pause is ALWAYS usable, even
 * mid-process). The Speech blend is endpoint-quantized (the phase-decorrelated
 * renders never sum into a doubled voice); Export renders the exact STFT blend.
 * URLs carry a per-render ?v= so an in-place re-render reloads fresh audio.
 *
 * Advanced params are per-file overrides persisted in the cache manifest
 * (enhance:set-overrides), merged over the config block's defaults.
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
              <!-- Chip stepper (replaces the filename title). Each chip lights when
                   its stem exists; the ACTIVE chip drives both the preview and the
                   controls shown below. Exactly one chip is active. -->
              <div class="stepper" role="tablist" [attr.aria-label]="'Pipeline steps'">
                @for (c of chips(); track c.id) {
                  <!-- Three states: COMPLETED (stem exists) → lit + clickable;
                       ACTIVE (selected) → lit style + star badge; NOT-YET-RUN
                       (no stem) → dim + disabled. Clickability tracks completed,
                       NOT active — any completed chip can be made active. -->
                  <button type="button" class="chip" role="tab"
                    [class.lit]="c.lit" [class.active]="activeChip() === c.id"
                    [disabled]="!c.lit"
                    [attr.aria-selected]="activeChip() === c.id"
                    [title]="c.hint"
                    (click)="selectChip(c.id)">
                    <span class="chip-dot"></span>
                    <span class="chip-label">{{ c.label }}</span>
                    @if (activeChip() === c.id) { <span class="chip-star" aria-hidden="true">★</span> }
                  </button>
                  @if (!$last) { <span class="chip-arrow" aria-hidden="true">→</span> }
                }
              </div>
              <p class="panel-meta" [title]="selectedRow()!.path">
                {{ selectedRow()!.name }} · {{ formatDuration(selectedRow()!.durationSec) }} · {{ formatSize(selectedRow()!.sizeBytes) }}
              </p>

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
                   Drives the final chip's label + what Generate does. -->
              <div class="method-select">
                <label class="ms-label">Method</label>
                <div class="ms-seg">
                  <button type="button" class="ms-opt" [class.active]="method() === 'resemble'" (click)="onMethodChange('resemble')">Resemble Enhance</button>
                  <button type="button" class="ms-opt" [class.active]="method() === 'rvc'" (click)="onMethodChange('rvc')">RVC voice model</button>
                </div>
              </div>

              <!-- Per-chip controls: the active chip governs what's shown here. -->
              @switch (activeChip()) {
                @case ('separate') {
                  <div class="sliders">
                    <div class="slider-block" [class.disabled]="!bgAvailable()">
                      <div class="slider-head">
                        <label>Background</label>
                        <span class="slider-val">{{ backgroundPct() }}%</span>
                      </div>
                      <input type="range" min="0" max="100" step="1"
                        [ngModel]="backgroundPct()" (ngModelChange)="onBackgroundChange($event)"
                        [disabled]="!bgAvailable()" />
                      <div class="slider-ends"><span>Speech only</span><span>+ Background</span></div>
                      @if (!bgAvailable()) {
                        <p class="slider-note">Run Separate to isolate speech and get a background track.</p>
                      }
                    </div>
                  </div>
                }
                @case ('denoise') {
                  <p class="chip-note">
                    Denoised speech — the mask denoiser on the {{ selectedRow()!.available?.voice ? 'isolated speech' : 'full mix (nothing separated yet)' }}.
                    @if (!selectedRow()!.available?.denoised) { <br />Not rendered yet — run Denoise. }
                  </p>
                }
                @case ('enhance') {
                  <!-- Model selector (rvc) stays visible outside the Advanced accordion. -->
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

                  @if (method() === 'resemble') {
                    <div class="sliders">
                      <div class="slider-block" [class.disabled]="!speechBlendAvailable()">
                        <div class="slider-head">
                          <label>Speech enhancement</label>
                          <span class="slider-val">{{ speechPct() }}%</span>
                        </div>
                        <input type="range" min="0" max="100" step="1"
                          [ngModel]="speechPct()" (ngModelChange)="onSpeechChange($event)"
                          [disabled]="!speechBlendAvailable()"
                          title="Preview plays the nearer endpoint; Export renders the exact blend" />
                        <div class="slider-ends"><span>Denoised</span><span>Enhanced</span></div>
                        @if (!speechBlendAvailable()) {
                          <p class="slider-note">Run Enhance to render the enhanced speech.</p>
                        } @else if (speechPct() > 0 && speechPct() < 100) {
                          <p class="slider-note">
                            Preview plays the {{ speechPct() < 50 ? 'nearer (denoised)' : 'further (enhanced)' }} endpoint
                            — in-between values are spectrally blended on Export.
                          </p>
                        }
                      </div>
                    </div>
                  } @else {
                    <!-- RVC: no dry/wet blend. The converted voice IS the output —
                         blending the time-misaligned original + RVC doubles the
                         voice. Tune via index / protect / pitch below; A/B the
                         original by clicking the Separate chip. -->
                    <p class="chip-note">
                      @if (speechBlendAvailable()) {
                        The RVC voice is the output — tune it with the settings below, and A/B against the original via the Separate chip.
                      } @else {
                        Not rendered yet — run Convert to render the RVC voice.
                      }
                    </p>
                  }

                  @if (method() === 'resemble') {
                  <details class="advanced">
                    <summary>Advanced</summary>
                    <p class="adv-note">
                      Per-file enhancer settings, remembered for this file. Applied on the next
                      Enhance run — changing them re-renders only the enhanced speech.
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
                      Convert run — changing them re-renders only the RVC voice.
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
                }
              }

              <!-- Player: always usable (plays the active chip's stem, or the
                   original when that stem hasn't been rendered yet). -->
              <div class="player">
                <input
                  class="seek"
                  type="range" min="0" [max]="duration()" step="0.01"
                  [value]="currentTime()" (input)="onSeek($event)"
                  [disabled]="!canPlay()"
                />
                <div class="player-times">
                  <span>{{ formatDuration(currentTime()) }}</span>
                  <span>{{ formatDuration(duration()) }}</span>
                </div>
                <div class="player-controls">
                  <button class="pc-btn pc-skip" [disabled]="!canPlay()" (click)="skip(-10)" title="Back 10 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">10</span>
                  </button>
                  <button class="pc-btn pc-skip" [disabled]="!canPlay()" (click)="skip(-5)" title="Back 5 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">5</span>
                  </button>
                  <button class="pc-btn pc-play" [disabled]="!canPlay()" (click)="togglePlay()" [title]="isPlaying() ? 'Pause' : 'Play'">
                    {{ isPlaying() ? '⏸' : '▶' }}
                  </button>
                  <button class="pc-btn pc-skip fwd" [disabled]="!canPlay()" (click)="skip(5)" title="Forward 5 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">5</span>
                  </button>
                  <button class="pc-btn pc-skip fwd" [disabled]="!canPlay()" (click)="skip(10)" title="Forward 10 seconds">
                    <span class="pc-replay">↺</span><span class="pc-num">10</span>
                  </button>
                </div>
                @if (playingOriginal()) { <p class="play-note">Playing the original — this step hasn't been rendered yet.</p> }
              </div>

              <div class="panel-actions">
                @if (selectedRow()!.status === 'processing') {
                  <desktop-button variant="secondary" icon="⏹" (click)="stopFile(selectedRow()!)">Stop</desktop-button>
                } @else {
                  <!-- Split Process button: one attached control — Process (full
                       cascade) on the left, a square ▾ segment (à la carte steps) on
                       the right, joined by a thin divider with no gap. -->
                  <div class="process-split">
                    <button type="button" class="ps-main" (click)="processFile(selectedRow()!, 'auto')">
                      <span class="ps-icon" aria-hidden="true">▶</span> Process
                    </button>
                    <button type="button" class="ps-arrow" [class.open]="stepMenuOpen()"
                      title="Run a single step" aria-label="Run a single step" (click)="toggleStepMenu()">▾</button>
                    @if (stepMenuOpen()) {
                      <div class="step-menu">
                        <button type="button" (click)="runStep('separate')">Separate</button>
                        <button type="button" (click)="runStep('denoise')">Denoise</button>
                        <button type="button" (click)="runStep('enhance')">{{ method() === 'rvc' ? 'Convert' : 'Enhance' }}</button>
                      </div>
                    }
                  </div>
                }
                <desktop-button variant="secondary" icon="⬇" [disabled]="!canExport() || exporting()" (click)="exportMix()">
                  {{ exporting() ? 'Exporting…' : 'Export mix…' }}
                </desktop-button>
              </div>
            </div>
          }

          <!-- Seek-synced preview elements (kept in the DOM; sources swap on select).
               One per stem plus the raw voice; the active chip picks which is audible. -->
          <audio #voiceAudio class="hidden-audio" preload="metadata"
            (loadedmetadata)="onAnyMeta($event)" (timeupdate)="onAnyTime($event)" (ended)="onEnded()"></audio>
          <audio #denoisedAudio class="hidden-audio" preload="metadata"
            (loadedmetadata)="onAnyMeta($event)" (timeupdate)="onAnyTime($event)" (ended)="onEnded()"></audio>
          <audio #enhancedAudio class="hidden-audio" preload="metadata"
            (loadedmetadata)="onAnyMeta($event)" (timeupdate)="onAnyTime($event)" (ended)="onEnded()"></audio>
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
    /* Chip stepper — three clickable step chips with connectors. A lit chip means
       its stem exists; the active chip is highlighted (accent). */
    .stepper { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chip {
      position: relative;
      display: inline-flex; align-items: center; gap: 7px;
      padding: 6px 12px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border-subtle); background: var(--bg-sunken);
      color: var(--text-muted); font-size: 12px; font-weight: 600;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .chip-dot {
      width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
      background: var(--border-strong); transition: background 0.15s;
    }
    /* COMPLETED (lit) = this step's stem exists → highlighted + clickable. */
    .chip.lit { color: var(--text-primary); border-color: var(--border-strong); }
    .chip.lit .chip-dot { background: var(--accent); }
    .chip.lit:hover { background: var(--bg-hover); border-color: var(--accent); }
    /* ACTIVE = the selected chip driving preview + controls → accent + star badge. */
    .chip.active { border-color: var(--accent); background: var(--bg-elevated); color: var(--text-primary); }
    .chip-star { position: absolute; top: -6px; right: -1px; font-size: 11px; line-height: 1; color: var(--accent); pointer-events: none; }
    /* NOT-YET-RUN = no stem → dim + not clickable (nothing to show yet). */
    .chip:disabled { opacity: 0.45; cursor: default; }
    .chip-arrow { color: var(--text-muted); font-size: 12px; flex-shrink: 0; }
    .panel-meta { margin: 0; font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-note { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
    .play-note { margin: 2px 0 0; font-size: 11px; color: var(--text-muted); text-align: center; }

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
    .slider-block.disabled { opacity: 0.5; }
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

    /* Split Process button — ONE attached control: Process (left) + square ▾
       segment (right), joined by a thin divider, no gap, outer corners rounded
       only. Matches the desktop-button PRIMARY (md) look (accent bg, white text,
       32px tall, subtle depth). */
    .process-split { position: relative; display: inline-flex; align-items: stretch; }
    .ps-main, .ps-arrow {
      height: 32px; border: none; background: var(--accent); color: white;
      cursor: pointer; font-weight: 600;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      transition: background 0.15s;
    }
    .ps-main {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0 14px; font-size: 13px; border-radius: 6px 0 0 6px;
    }
    .ps-icon { font-size: 11px; line-height: 1; }
    .ps-arrow {
      display: inline-flex; align-items: center; justify-content: center;
      width: 30px; padding: 0; font-size: 10px; border-radius: 0 6px 6px 0;
      /* the thin divider between the two segments */
      border-left: 1px solid rgba(255, 255, 255, 0.28);
    }
    .ps-main:hover, .ps-arrow:hover, .ps-arrow.open { background: var(--accent-hover); }
    .ps-main:active, .ps-arrow:active { background: var(--accent-active); }
    .step-menu {
      position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 10;
      display: flex; flex-direction: column; min-width: 150px;
      background: var(--bg-elevated); border: 1px solid var(--border-default);
      border-radius: 8px; padding: 4px; box-shadow: 0 6px 20px rgba(0,0,0,0.28);
    }
    .step-menu button {
      text-align: left; padding: 7px 10px; border: none; border-radius: 6px;
      background: transparent; color: var(--text-primary); font-size: 12px; cursor: pointer;
    }
    .step-menu button:hover { background: var(--bg-hover); }

    .panel-actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; }

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

  @ViewChild('voiceAudio') voiceAudioRef!: ElementRef<HTMLAudioElement>;
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
  /** True while the audible element is the ORIGINAL fallback (active chip's stem
   *  not yet rendered), so the UI can say so. */
  readonly playingOriginal = signal(false);

  // Chip stepper: the active step (drives preview + controls) and the split-button
  // step menu open state.
  readonly activeChip = signal<ChipId>('separate');
  readonly stepMenuOpen = signal(false);

  readonly selectedRow = computed(() => this.files().find((f) => f.id === this.selectedId()) ?? null);

  /** The three step chips, method-labelled, each lit when its stem exists. */
  readonly chips = computed<{ id: ChipId; label: string; lit: boolean; hint: string }[]>(() => {
    const av = this.selectedRow()?.available ?? null;
    const rvc = this.method() === 'rvc';
    return [
      { id: 'separate', label: 'Separate', lit: !!av?.voice, hint: 'Isolate speech from music / background.' },
      { id: 'denoise', label: 'Denoise', lit: !!av?.denoised, hint: 'Clean up the speech (or the full mix).' },
      {
        id: 'enhance',
        label: rvc ? 'RVC Enhance' : 'Resemble Enhance',
        lit: !!av?.enhanced,
        hint: rvc ? 'Convert the voice with an RVC model.' : 'Generatively enhance the speech.',
      },
    ];
  });

  /** Transport is usable whenever a file is selected — it plays the active chip's
   *  stem, or the original if that stem hasn't landed yet (always available). */
  readonly canPlay = computed(() => !!this.selectedRow());
  /** Background slider needs a separated background track (rest stem). */
  readonly bgAvailable = computed(() => !!this.selectedRow()?.available?.rest);
  /** Speech (Original↔Enhanced) blend needs the enhanced stem rendered. */
  readonly speechBlendAvailable = computed(() => !!this.selectedRow()?.available?.enhanced);
  /** Export mixes the full result — gated on a complete session (all stages). */
  readonly canExport = computed(() => !!this.selectedRow()?.complete);

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
        // 'ready' whenever ANY stem exists (à la carte), not only when complete —
        // the row is playable/inspectable with partial results.
        status: (s.available && (s.available.voice || s.available.denoised || s.available.enhanced)) ? 'ready' : 'idle',
        phase: s.complete ? 'complete' : null,
        percentage: s.complete ? 100 : 0,
        error: null,
        stems: s.stems ?? null,
        available: s.available ?? null,
        complete: s.complete,
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
      available: null,
      complete: false,
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
      const av = cache.data.available ?? null;
      const anyStem = !!av && (av.voice || av.denoised || av.enhanced);
      const patch: Partial<EnhanceFileRow> = {
        key: cache.data.key,
        stems: cache.data.stems ?? null,
        available: av,
        complete: cache.data.complete,
        effectiveParams: cache.data.effectiveParams,
        method: cache.data.method,
        rvcSettings: cache.data.rvcSettings,
      };
      if (anyStem) {
        patch.status = 'ready';
        patch.percentage = cache.data.complete ? 100 : 0;
        patch.phase = cache.data.complete ? 'complete' : null;
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
    this.stepMenuOpen.set(false);
    this.selectedId.set(row.id);
    this.applyParamsToInputs(row.effectiveParams);
    this.applyMethodToInputs(row);
    // Default the active chip to the furthest-rendered step so the preview lands on
    // the latest output (falls back to the first step for a fresh file).
    this.activeChip.set(this.defaultChipFor(row));
    this.loadPreviewSources();
  }

  /** The furthest step that has a stem, else the Enhance chip — for a not-yet-
   *  processed file that lands on the Generate config (method / model / settings). */
  private defaultChipFor(row: EnhanceFileRow): ChipId {
    const av = row.available;
    if (av?.enhanced) return 'enhance';
    if (av?.denoised) return 'denoise';
    if (av?.voice) return 'separate';
    return 'enhance';
  }

  /** Switch the active chip: re-points the audible stem + re-syncs the transport. */
  selectChip(chip: ChipId): void {
    if (this.activeChip() === chip) return;
    this.activeChip.set(chip);
    this.applyVolumes();
    this.syncFollowersToMaster();
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
      const d = res.data;
      const av = d.available ?? null;
      // Availability is method-aware: switching method makes the OTHER method's
      // denoise/enhance stems stale, so the chips dim + sliders disable until those
      // steps are re-run under the now-selected method. Reload the preview so a
      // stale stem isn't played (the active chip falls back to the original).
      this.patchRow(row.id, {
        method: d.method,
        rvcSettings: d.rvcSettings,
        available: av,
        stems: d.stems ?? row.stems,
        complete: d.complete,
      });
      if (this.selectedId() === row.id) {
        // Land on the Enhance chip so the (now method-specific) Generate config is
        // front-and-centre — and it stays reachable even though its chip is now
        // dim/disabled for the freshly-selected method until re-run.
        this.activeChip.set('enhance');
        this.loadPreviewSources();
      }
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
    if (res.success && res.data) {
      const d = res.data;
      const av = d.available ?? null;
      const anyStem = !!av && (av.voice || av.denoised || av.enhanced);
      this.patchRow(row.id, {
        key: d.key || row.key,
        status: anyStem ? 'ready' : 'idle',
        stems: d.stems ?? null,
        available: av,
        complete: d.complete,
        percentage: d.complete ? 100 : 0,
        phase: d.complete ? 'complete' : null,
        error: null,
        jobId: null,
      });
      if (this.selectedId() === row.id) {
        // Land the preview on the step that just ran (à la carte) or the final
        // output (full cascade).
        this.activeChip.set(this.scopeToChip(reprocess));
        this.loadPreviewSources();
      }
    } else if (res.wasStopped) {
      this.patchRow(row.id, { status: 'stopped', phase: null });
    } else if (!res.success) {
      this.patchRow(row.id, { status: 'error', error: res.error || 'Processing failed', phase: null });
    }
  }

  /** Which chip a finished run should land the preview on. */
  private scopeToChip(scope: ReprocessScope): ChipId {
    if (scope === 'separate') return 'separate';
    if (scope === 'denoise') return 'denoise';
    return 'enhance'; // 'enhance' / 'auto' / 'all' → the final output
  }

  /** Toggle the split-button single-step menu. */
  toggleStepMenu(): void { this.stepMenuOpen.update((o) => !o); }

  /** Run a single pipeline step à la carte (from the split-button menu). */
  runStep(scope: 'separate' | 'denoise' | 'enhance'): void {
    this.stepMenuOpen.set(false);
    const row = this.selectedRow();
    if (row) void this.processFile(row, scope);
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
        if (cache.success && cache.data) {
          const d = cache.data;
          const av = d.available ?? null;
          const anyStem = !!av && (av.voice || av.denoised || av.enhanced);
          this.patchRow(id, {
            status: anyStem ? 'ready' : 'idle',
            stems: d.stems ?? null,
            available: av,
            complete: d.complete,
            percentage: d.complete ? 100 : 0,
            phase: d.complete ? 'complete' : null,
            error: null,
            jobId: null,
          });
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

  // ── Preview (four seek-synced <audio> elements, chip-driven) ──

  private stemEls(): {
    voice: HTMLAudioElement | null;
    denoised: HTMLAudioElement | null;
    enhanced: HTMLAudioElement | null;
    rest: HTMLAudioElement | null;
  } {
    return {
      voice: this.voiceAudioRef?.nativeElement ?? null,
      denoised: this.denoisedAudioRef?.nativeElement ?? null,
      enhanced: this.enhancedAudioRef?.nativeElement ?? null,
      rest: this.restAudioRef?.nativeElement ?? null,
    };
  }

  private audios(): HTMLAudioElement[] {
    const e = this.stemEls();
    return [e.voice, e.denoised, e.enhanced, e.rest].filter(Boolean) as HTMLAudioElement[];
  }

  /** The audible timebase element for the active chip (+ slider position). RVC has
   *  no dry/wet blend — its Enhance chip always plays the converted voice. */
  private currentMaster(): HTMLAudioElement | null {
    const e = this.stemEls();
    switch (this.activeChip()) {
      case 'separate': return e.voice;
      case 'denoise': return e.denoised;
      case 'enhance': return (this.method() === 'rvc' || this.speechPct() >= 50) ? e.enhanced : e.denoised;
    }
  }

  /** Load each element's source. The three speech elements fall back to the
   *  ORIGINAL when their stem hasn't been rendered, so the transport is always
   *  usable and the enhance-chip endpoint switch never hits an empty element.
   *  Cache-busted (?v=) so an in-place re-render reloads fresh audio (that's the
   *  "re-convert still plays the old voice" fix). */
  private loadPreviewSources(): void {
    const row = this.selectedRow();
    this.currentTime.set(0);
    this.duration.set(0);
    // Defer so the ViewChild audio elements exist for a freshly-selected file.
    setTimeout(() => {
      const e = this.stemEls();
      if (!e.voice || !e.denoised || !e.enhanced || !e.rest) return;
      if (!row) {
        for (const a of [e.voice, e.denoised, e.enhanced, e.rest]) a.removeAttribute('src');
        return;
      }
      const v = Date.now();
      const url = (p: string) => this.electron.enhanceAudioUrl(p, v);
      const original = url(row.path);
      const av = row.available;
      const stems = row.stems;
      e.voice.src = av?.voice && stems ? url(stems.voice) : original;
      e.denoised.src = av?.denoised && stems ? url(stems.denoised) : original;
      e.enhanced.src = av?.enhanced && stems ? url(stems.enhanced) : original;
      // Background has no fallback — with nothing separated there's nothing to add.
      if (av?.rest && stems) e.rest.src = url(stems.rest);
      else e.rest.removeAttribute('src');
      for (const a of [e.voice, e.denoised, e.enhanced, e.rest]) { if (a.getAttribute('src')) a.load(); }
      this.applyVolumes();
    }, 0);
  }

  private applyVolumes(): void {
    // Endpoint-quantized: only ONE speech element is audible at a time, so the
    // phase-decorrelated renders (denoised vs enhanced) never sum into a doubled
    // voice. RVC has no dry/wet blend — its Enhance chip always plays the converted
    // voice (the raw voice + RVC voice are time-misaligned; summing them doubles).
    // Background rides alongside on the Separate chip only.
    const chip = this.activeChip();
    const rvc = this.method() === 'rvc';
    const playEnhanced = chip === 'enhance' && (rvc || this.speechPct() >= 50);
    const playDenoised = chip === 'denoise' || (chip === 'enhance' && !rvc && this.speechPct() < 50);
    const bg = this.backgroundPct() / 100;
    const e = this.stemEls();
    if (e.voice) e.voice.volume = chip === 'separate' ? 1 : 0;
    if (e.denoised) e.denoised.volume = playDenoised ? 1 : 0;
    if (e.enhanced) e.enhanced.volume = playEnhanced ? 1 : 0;
    if (e.rest) e.rest.volume = chip === 'separate' ? bg : 0;
    this.updatePlayingOriginal();
  }

  /** Reflect whether the active chip's audible element is the original fallback. */
  private updatePlayingOriginal(): void {
    const av = this.selectedRow()?.available;
    const rvc = this.method() === 'rvc';
    let onStem = false;
    switch (this.activeChip()) {
      case 'separate': onStem = !!av?.voice; break;
      case 'denoise': onStem = !!av?.denoised; break;
      case 'enhance': onStem = (rvc || this.speechPct() >= 50) ? !!av?.enhanced : !!av?.denoised; break;
    }
    this.playingOriginal.set(!!this.selectedRow() && !onStem);
  }

  onSpeechChange(v: number): void { this.speechPct.set(+v); this.applyVolumes(); }
  onBackgroundChange(v: number): void { this.backgroundPct.set(+v); this.applyVolumes(); }

  togglePlay(): void {
    if (!this.canPlay()) return;
    if (this.isPlaying()) this.pausePreview();
    else this.playPreview();
  }

  /** Re-align every follower element to the current master's time. */
  private syncFollowersToMaster(): void {
    const master = this.currentMaster();
    if (!master) return;
    for (const a of this.audios()) {
      if (a !== master) { try { a.currentTime = master.currentTime; } catch { /* not seekable yet */ } }
    }
  }

  private playPreview(): void {
    const master = this.currentMaster();
    if (!master) return;
    this.syncFollowersToMaster();
    this.applyVolumes();
    // Play every sourced element (muted ones stay in sync so switching is instant).
    for (const a of this.audios()) { if (a.getAttribute('src')) a.play().catch(() => { /* autoplay/permission — ignore */ }); }
    this.isPlaying.set(true);
  }

  private pausePreview(): void {
    for (const a of this.audios()) { try { a.pause(); } catch { /* ignore */ } }
    this.isPlaying.set(false);
  }

  onSeek(e: Event): void {
    const t = parseFloat((e.target as HTMLInputElement).value);
    this.currentTime.set(t);
    for (const a of this.audios()) { try { a.currentTime = t; } catch { /* not seekable yet */ } }
  }

  /** Jump the transport by `delta` seconds (negative = rewind), clamped to the
   *  clip. Reads from the master element so it's accurate mid-playback. */
  skip(delta: number): void {
    if (!this.canPlay()) return;
    const master = this.currentMaster();
    const base = master ? master.currentTime : this.currentTime();
    const dur = this.duration();
    const t = Math.max(0, Math.min(dur > 0 ? dur : base, base + delta));
    this.currentTime.set(t);
    for (const a of this.audios()) { try { a.currentTime = t; } catch { /* not seekable yet */ } }
  }

  onAnyMeta(ev: Event): void {
    const el = ev.target as HTMLAudioElement;
    if (el && Number.isFinite(el.duration) && el.duration > 0) {
      if (el === this.currentMaster() || this.duration() === 0) this.duration.set(el.duration);
    }
  }

  onAnyTime(ev: Event): void {
    const el = ev.target as HTMLAudioElement;
    if (el === this.currentMaster()) this.currentTime.set(el.currentTime);
  }

  onEnded(): void {
    this.pausePreview();
    this.currentTime.set(0);
    for (const a of this.audios()) { try { a.currentTime = 0; } catch { /* ignore */ } }
  }

  // ── Export ──

  async exportMix(): Promise<void> {
    const row = this.selectedRow();
    if (!row || !this.canExport()) return;
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
