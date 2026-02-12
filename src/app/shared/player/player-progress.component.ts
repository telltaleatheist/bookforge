import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-player-progress',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="progress-bar-container">
      <div class="progress-bar" (click)="onProgressClick($event)">
        <div class="progress-fill" [style.width.%]="progressPercent()"></div>
        <input
          type="range"
          class="progress-slider"
          [min]="0"
          [max]="duration()"
          [value]="currentTime()"
          (input)="onSliderInput($event)"
        />
      </div>
      <div class="time-display">
        <span>{{ formatTime(currentTime()) }}</span>
        <span>{{ formatTime(duration()) }}</span>
      </div>
    </div>
  `,
  styles: [`
    .progress-bar-container {
      max-width: 500px;
      margin: 0 auto;
      width: 100%;
      flex-shrink: 0;
    }

    .progress-bar {
      position: relative;
      height: 6px;
      background: var(--bg-muted);
      border-radius: 3px;
      overflow: visible;
      cursor: pointer;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.1s;
      pointer-events: none;
    }

    .progress-slider {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
      margin: 0;
    }

    .time-display {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 8px;
    }
  `]
})
export class PlayerProgressComponent {
  readonly currentTime = input<number>(0);
  readonly duration = input<number>(0);

  readonly seek = output<number>();

  progressPercent(): number {
    const d = this.duration();
    if (d === 0) return 0;
    return (this.currentTime() / d) * 100;
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onSliderInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.seek.emit(parseFloat(input.value));
  }

  onProgressClick(event: MouseEvent): void {
    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    this.seek.emit(percent * this.duration());
  }
}
