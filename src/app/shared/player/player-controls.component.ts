import { Component, input, output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { TransportAction } from './player.types';

@Component({
  selector: 'app-player-controls',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="audio-controls">
      <button class="btn-control" (click)="transport.emit('previous')" [disabled]="!canPrevious()" title="Previous">
        ⏮
      </button>
      <button class="btn-play" (click)="transport.emit(isPlaying() ? 'pause' : 'play')" [title]="isPlaying() ? 'Pause' : 'Play'">
        {{ isPlaying() ? '⏸' : '▶' }}
      </button>
      <button class="btn-control" (click)="transport.emit('next')" [disabled]="!canNext()" title="Next">
        ⏭
      </button>
    </div>
  `,
  styles: [`
    .audio-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin-bottom: 20px;
      flex-shrink: 0;
    }

    .btn-control {
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 50%;
      background: var(--bg-hover);
      color: var(--text-primary);
      font-size: 18px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: var(--bg-muted);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .btn-play {
      width: 64px;
      height: 64px;
      border: none;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      font-size: 24px;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s;

      &:hover {
        transform: scale(1.05);
      }
    }
  `]
})
export class PlayerControlsComponent {
  readonly isPlaying = input<boolean>(false);
  readonly canPrevious = input<boolean>(true);
  readonly canNext = input<boolean>(true);

  readonly transport = output<TransportAction>();
}
