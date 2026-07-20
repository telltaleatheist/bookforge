import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, signal, viewChild } from '@angular/core';

/**
 * Plain seekable transport (play/pause + scrubber + time). BookForge has no
 * reusable waveform renderer for the desktop app, so per the phase-1 spec a
 * plain seekable player is used. It loads the `bookforge-audio://` URL passed in
 * (range-capable — seeking never buffers the whole file).
 */
@Component({
  selector: 'cf-audio-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (src()) {
      <div class="player">
        <button type="button" class="play" (click)="toggle()" [disabled]="!ready()">
          {{ playing() ? 'Pause' : 'Play' }}
        </button>
        <span class="label">{{ label() }}</span>
        <input
          class="scrub"
          type="range"
          min="0"
          [max]="duration() || 0"
          step="0.01"
          [value]="currentTime()"
          (input)="seek($event)"
          [disabled]="!ready()"
        />
        <span class="time">{{ fmt(currentTime()) }} / {{ fmt(duration()) }}</span>
      </div>
      <audio
        #audio
        [src]="src()"
        preload="metadata"
        (loadedmetadata)="onMeta()"
        (timeupdate)="onTime()"
        (play)="playing.set(true)"
        (pause)="playing.set(false)"
        (ended)="playing.set(false)"
        (error)="onError()"
      ></audio>
      @if (error()) {
        <div class="err">{{ error() }}</div>
      }
    }
  `,
  styles: [`
    :host { display: block; }
    .player {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md, 12px);
      padding: var(--ui-spacing-sm, 8px) var(--ui-spacing-md, 12px);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
    }
    .play {
      min-width: 72px;
      height: var(--ui-btn-height-xs, 36px);
      padding: 0 14px;
      border-radius: 6px;
      border: 1px solid var(--border-strong);
      background: var(--accent);
      color: var(--text-inverse);
      font-weight: 600;
      cursor: pointer;
    }
    .play:disabled { opacity: 0.5; cursor: default; }
    .label {
      color: var(--text-secondary);
      font-size: var(--ui-font-sm, 13px);
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .scrub { flex: 1; accent-color: var(--accent); }
    .time {
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      font-size: var(--ui-font-sm, 13px);
      min-width: 92px;
      text-align: right;
    }
    .err {
      margin-top: 6px;
      color: var(--error-text);
      font-size: var(--ui-font-sm, 13px);
    }
  `],
})
export class AudioPlayerComponent {
  /** bookforge-audio:// URL. Empty/undefined hides the player. */
  readonly src = input<string>('');
  readonly label = input<string>('');

  private readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audio');

  readonly playing = signal(false);
  readonly duration = signal(0);
  readonly currentTime = signal(0);
  readonly ready = signal(false);
  readonly error = signal<string | null>(null);

  readonly hasSrc = computed(() => !!this.src());

  constructor() {
    // Reset transport whenever the source changes.
    effect(() => {
      this.src();
      this.playing.set(false);
      this.duration.set(0);
      this.currentTime.set(0);
      this.ready.set(false);
      this.error.set(null);
    });
  }

  private el(): HTMLAudioElement | null {
    return this.audioRef()?.nativeElement ?? null;
  }

  onMeta(): void {
    const el = this.el();
    if (!el) return;
    this.duration.set(Number.isFinite(el.duration) ? el.duration : 0);
    this.ready.set(true);
  }

  onTime(): void {
    const el = this.el();
    if (!el) return;
    this.currentTime.set(el.currentTime);
  }

  onError(): void {
    this.ready.set(false);
    this.error.set('Playback failed for this file.');
  }

  toggle(): void {
    const el = this.el();
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => this.onError());
    } else {
      el.pause();
    }
  }

  seek(ev: Event): void {
    const el = this.el();
    if (!el) return;
    const value = parseFloat((ev.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      el.currentTime = value;
      this.currentTime.set(value);
    }
  }

  fmt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
}
