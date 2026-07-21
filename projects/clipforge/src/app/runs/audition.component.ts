import {
  ChangeDetectionStrategy, Component, effect, inject, input, signal,
} from '@angular/core';
import { ClipforgeApiService } from '../services/clipforge-api.service';
import { ClipforgeProbe, ClipforgeRun, ClipforgeRunStage } from '../models/types';
import { AudioPlayerComponent } from '../player/audio-player.component';

/** One audition-able artifact of a run: the original, a per-stage render, or the final. */
interface AuditionTarget {
  key: string;                            // 'original' | 'output' | 'stage:N'
  kind: 'original' | 'stage' | 'output';
  which: string | null;                   // arg for runMediaPath ('output' | 'N'); null = original
  label: string;
  brief: string;                          // human key-settings summary
  filter: string;                         // literal ffmpeg filter (stages only), else ''
  duration: number;                       // known duration (for playhead-preservation)
}

/**
 * Audition loop — the whole point. For a selected run, one SHARED player instance
 * plays the original probe, the final output, or ANY per-stage intermediate
 * (stage solo). Switching keeps the playhead when the durations match; when they
 * differ (e.g. silence_truncate shortened the audio) it restarts from 0.
 *
 * NO FALLBACKS: media paths are resolved through the manifest-backed IPC, and any
 * failure is shown in a banner. "Copy for Claude" fetches the provenance JSON text
 * and writes it to the clipboard.
 */
@Component({
  selector: 'cf-audition',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AudioPlayerComponent],
  template: `
    <section class="panel">
      <div class="panel-head">
        <h2>Audition — {{ run().recipeName }}</h2>
        <button type="button" class="btn ghost" (click)="copyProvenance()">Copy provenance for Claude</button>
      </div>

      @if (error(); as e) {
        <div class="banner error" (click)="error.set(null)">{{ e }}</div>
      }
      @if (copyNotice(); as n) {
        <div class="banner info" (click)="copyNotice.set(null)">{{ n }}</div>
      }

      @if (playerSrc(); as src) {
        <cf-audio-player
          [src]="src"
          [label]="currentLabel()"
          [startAt]="playerStartAt()"
          [autoplay]="playerAutoplay()"
          (timeChange)="lastTime.set($event)"
        />
      }

      <ul class="targets">
        @for (t of targets(); track t.key) {
          <li class="target" [class.active]="t.key === currentKey()">
            <button type="button" class="solo" (click)="selectTarget(t)">
              {{ t.key === currentKey() ? '▶' : 'Solo' }}
            </button>
            <div class="t-meta">
              <span class="t-label">{{ t.label }}</span>
              <span class="t-brief">{{ t.brief }}</span>
              @if (t.filter) { <span class="t-filter">{{ t.filter }}</span> }
            </div>
            <span class="t-dur">{{ fmt(t.duration) }}</span>
          </li>
        }
      </ul>
    </section>
  `,
  styles: [`
    .panel {
      background: var(--bg-card); border: 1px solid var(--border-default);
      border-radius: 10px; padding: var(--ui-spacing-lg, 16px); margin-bottom: var(--ui-spacing-lg, 16px);
    }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: var(--ui-spacing-md, 12px); }
    h2 { font-size: var(--ui-font-lg, 18px); color: var(--text-primary); }
    .btn {
      height: var(--ui-btn-height-xs, 36px); padding: 0 14px; border-radius: 8px;
      border: 1px solid var(--border-strong); background: var(--accent); color: var(--text-inverse);
      font-weight: 600; cursor: pointer;
    }
    .btn.ghost { background: var(--bg-elevated); color: var(--text-primary); }
    .banner { padding: 10px 14px; border-radius: 8px; margin-bottom: 12px; font-size: var(--ui-font-sm, 13px); cursor: default; }
    .banner.error { background: var(--error-bg); color: var(--error-text); border: 1px solid var(--error); }
    .banner.info { background: var(--accent-subtle); color: var(--text-secondary); border: 1px solid var(--border-default); }
    .targets { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .target {
      display: flex; align-items: center; gap: 12px; padding: 8px 10px;
      border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-surface);
    }
    .target.active { border-color: var(--border-accent); background: var(--accent-subtle); }
    .solo {
      min-width: 56px; height: 32px; border-radius: 6px; border: 1px solid var(--border-strong);
      background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; font-weight: 600;
    }
    .t-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .t-label { color: var(--text-primary); font-size: var(--ui-font-sm, 13px); font-weight: 600; }
    .t-brief { color: var(--text-secondary); font-size: var(--ui-font-xs, 11px); }
    .t-filter {
      color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px);
      font-family: var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 640px;
    }
    .t-dur { color: var(--text-tertiary); font-size: var(--ui-font-xs, 11px); font-variant-numeric: tabular-nums; }
  `],
})
export class AuditionComponent {
  private readonly api = inject(ClipforgeApiService);

  readonly collectionName = input.required<string>();
  readonly run = input.required<ClipforgeRun>();
  readonly probe = input.required<ClipforgeProbe>();

  readonly currentKey = signal<string>('original');
  /** Duration of the artifact currently loaded (for the playhead-match decision). */
  readonly currentDuration = signal<number>(0);
  readonly lastTime = signal<number>(0);

  readonly playerSrc = signal<string>('');
  readonly playerStartAt = signal<number>(0);
  readonly playerAutoplay = signal<boolean>(false);

  readonly error = signal<string | null>(null);
  readonly copyNotice = signal<string | null>(null);

  constructor() {
    // Whenever the selected run (or probe) changes, reset to the original artifact.
    effect(() => {
      this.run();
      this.probe();
      void this.resetToOriginal();
    });
  }

  /** Build the ordered list of audition-able artifacts for the current run. */
  targets(): AuditionTarget[] {
    const run = this.run();
    const probe = this.probe();
    const list: AuditionTarget[] = [{
      key: 'original',
      kind: 'original',
      which: null,
      label: 'Original probe',
      brief: probe.filename,
      filter: '',
      duration: probe.durationSeconds,
    }];
    for (const st of run.stages) {
      list.push({
        key: `stage:${st.index}`,
        kind: 'stage',
        which: String(st.index),
        label: `Stage ${st.index + 1}: ${st.engine}`,
        brief: this.stageBrief(st),
        filter: st.ffmpegFilter,
        duration: st.outputDurationSeconds,
      });
    }
    const finalDuration = run.stages.length
      ? run.stages[run.stages.length - 1].outputDurationSeconds
      : probe.durationSeconds;
    list.push({
      key: 'output',
      kind: 'output',
      which: 'output',
      label: 'Final output',
      brief: run.outputFilename,
      filter: '',
      duration: finalDuration,
    });
    return list;
  }

  currentLabel(): string {
    return this.targets().find((t) => t.key === this.currentKey())?.label ?? '';
  }

  async selectTarget(t: AuditionTarget): Promise<void> {
    this.error.set(null);
    // Keep the playhead only when the durations match; otherwise restart from 0.
    const durMatch = Math.abs(this.currentDuration() - t.duration) < 0.05;
    const startAt = durMatch ? this.lastTime() : 0;
    try {
      const url = await this.resolveUrl(t);
      this.playerStartAt.set(startAt);
      this.playerAutoplay.set(true);
      this.currentKey.set(t.key);
      this.currentDuration.set(t.duration);
      this.playerSrc.set(url);
    } catch (err) {
      this.error.set(this.msg(err));
    }
  }

  async copyProvenance(): Promise<void> {
    this.error.set(null);
    this.copyNotice.set(null);
    try {
      const text = await this.api.readProvenance(this.collectionName(), this.run().id);
      await navigator.clipboard.writeText(text);
      this.copyNotice.set(`Copied provenance for run ${this.run().id.slice(0, 8)} to the clipboard.`);
    } catch (err) {
      this.error.set(this.msg(err));
    }
  }

  private async resetToOriginal(): Promise<void> {
    const probe = this.probe();
    this.error.set(null);
    this.copyNotice.set(null);
    this.currentKey.set('original');
    this.currentDuration.set(probe.durationSeconds);
    this.lastTime.set(0);
    this.playerStartAt.set(0);
    this.playerAutoplay.set(false);
    try {
      const url = await this.resolveUrl(this.targets()[0]);
      this.playerSrc.set(url);
    } catch (err) {
      this.playerSrc.set('');
      this.error.set(this.msg(err));
    }
  }

  private async resolveUrl(t: AuditionTarget): Promise<string> {
    const coll = this.collectionName();
    if (t.kind === 'original') {
      const run = this.run();
      let abs: string;
      if (run.probeId) {
        abs = await this.api.probeMediaPath(coll, run.probeId);
      } else if (run.sourceId) {
        abs = await this.api.sourceMediaPath(coll, run.sourceId);
      } else {
        throw new Error('Run has neither a probeId nor a sourceId to resolve the original from.');
      }
      return this.api.toAudioUrl(abs);
    }
    if (!t.which) throw new Error(`Audition target "${t.key}" has no artifact selector.`);
    const abs = await this.api.runMediaPath(coll, this.run().id, t.which);
    return this.api.toAudioUrl(abs);
  }

  /** Compact, human key-settings summary for a stage (exact filter shown separately). */
  private stageBrief(stage: ClipforgeRunStage): string {
    const s = stage.settings;
    switch (stage.engine) {
      case 'highpass': return `high-pass ${this.n(s['freq'])} Hz`;
      case 'lowpass': return `low-pass ${this.n(s['freq'])} Hz`;
      case 'eq': {
        const bands = Array.isArray(s['bands']) ? s['bands'].length : 0;
        return `${bands} EQ band(s)`;
      }
      case 'gate': return `gate ${this.n(s['thresholdDb'])} dB · atk ${this.n(s['attackMs'])}ms · rel ${this.n(s['releaseMs'])}ms`;
      case 'silence_truncate': return `truncate > ${this.n(s['maxSilenceS'])}s to ${this.n(s['keepS'])}s @ ${this.n(s['thresholdDb'])} dB`;
      case 'loudness':
        return s['mode'] === 'gain'
          ? `gain ${this.n(s['gainDb'])} dB`
          : `loudnorm I=${this.n(s['I'])} TP=${this.n(s['TP'])} LRA=${this.n(s['LRA'])}`;
      case 'resample': return `resample ${this.n(s['rate'])} Hz`;
      default: return JSON.stringify(s);
    }
  }

  private n(v: unknown): string {
    return typeof v === 'number' ? String(v) : '?';
  }

  fmt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
