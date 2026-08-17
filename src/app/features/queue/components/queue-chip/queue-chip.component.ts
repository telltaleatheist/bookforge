/**
 * The queue chip — the app's one persistent readout of what the GPU is doing.
 *
 * It sits in the title bar of EVERY window, main and standalone alike, because
 * the queue is main's and every window mirrors it: a user watching a Listen
 * window has the same right to know a nine-hour narration is at 62% as one
 * looking at the library. The nav rail is suppressed in standalone windows; this
 * deliberately is not.
 *
 * Three forms, and they are genuinely different states rather than one form with
 * blanks in it:
 *   running — cover, meter, "Narrating <book>", the running step's percentage.
 *   pending — no meter and no percentage, because nothing is moving; just the
 *             count of runs waiting, so pressing it is obviously worth doing.
 *   empty   — a quiet icon. Still a button: the tray is where Start lives, and a
 *             queue you cannot open when it is empty is one you cannot start.
 *
 * The tray is a CDK overlay rather than an absolutely-positioned child: the
 * title bar is a 40px strip with its own stacking context and `-webkit-app-region:
 * drag`, and a panel parented inside it would be clipped, would sit under the
 * window body, and would be draggable.
 */

import { ChangeDetectionStrategy, Component, ViewChild, computed, inject } from '@angular/core';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';

import { QueueTrayService } from '../../services/queue-tray.service';
import { QueueTrayComponent } from '../queue-tray/queue-tray.component';

@Component({
  selector: 'app-queue-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayModule, QueueTrayComponent],
  template: `
    <button
      type="button"
      class="chip"
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      [class.running]="chip().state === 'running'"
      [class.quiet]="chip().state === 'empty'"
      [attr.aria-expanded]="tray.open()"
      aria-haspopup="dialog"
      [attr.aria-label]="ariaLabel()"
      (click)="tray.toggle()"
    >
      @if (chip().state === 'running') {
        @if (chip().cover) {
          <img class="mini" [src]="chip().cover" alt="" />
        } @else {
          <span class="mini mini-blank" aria-hidden="true"></span>
        }
        <span class="meter" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="what">{{ chip().verb }} <b>{{ chip().title }}</b></span>
        <span class="pct">{{ chip().percent }}%</span>
      } @else {
        <span class="glyph" aria-hidden="true">⏳</span>
        @if (chip().state === 'empty') {
          <span class="what quiet-text">Queue</span>
        }
      }

      @if (chip().pending > 0) {
        <span class="badge">{{ chip().pending }}</span>
      }
    </button>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="tray.open()"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      (backdropClick)="tray.close()"
      (detach)="tray.close()"
      (attach)="focusTray()"
    >
      <app-queue-tray #panel (dismiss)="tray.close()" />
    </ng-template>
  `,
  styles: [`
    :host {
      display: inline-flex;
      /* The title bar is a drag region; its buttons are already no-drag, but the
         host is not a button, so it says so for itself. */
      -webkit-app-region: no-drag;
    }

    .chip {
      display: flex;
      align-items: center;
      gap: 7px;
      height: 28px;
      max-width: 380px;
      padding: 0 10px 0 6px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 14px;
      color: var(--text-primary);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }

    .chip.running { border-color: var(--accent); }

    .chip.quiet {
      background: transparent;
      border-color: transparent;
      color: var(--text-tertiary);
    }

    .chip:hover { border-color: var(--border-strong); }
    .chip.running:hover { border-color: var(--accent-hover); }

    .chip:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }

    .mini {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      flex: none;
      object-fit: cover;
      background: var(--bg-elevated);
    }

    .mini-blank { display: block; border: 1px solid var(--border-subtle); }

    .glyph { font-size: 13px; line-height: 1; }

    .what {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
    }

    .what b { font-weight: 600; color: var(--text-primary); }

    .quiet-text { color: inherit; }

    .pct {
      color: var(--accent);
      font-variant-numeric: tabular-nums;
      font-size: 11.5px;
      flex: none;
    }

    .badge {
      min-width: 17px;
      height: 17px;
      padding: 0 5px;
      display: grid;
      place-items: center;
      background: var(--accent-subtle);
      color: var(--accent);
      border-radius: 9px;
      font-size: 10.5px;
      font-weight: 700;
      flex: none;
    }

    /* The equalizer: three bars, the only motion in the title bar. */
    .meter {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 11px;
      flex: none;
    }

    .meter i {
      width: 2.5px;
      background: var(--accent);
      border-radius: 1px;
      animation: chip-eq 1s ease-in-out infinite;
    }

    .meter i:nth-child(1) { height: 55%; animation-delay: -0.2s; }
    .meter i:nth-child(2) { height: 100%; animation-delay: -0.55s; }
    .meter i:nth-child(3) { height: 40%; animation-delay: -0.8s; }

    @keyframes chip-eq {
      0%, 100% { transform: scaleY(0.4); }
      50% { transform: scaleY(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .meter i { animation: none; transform: scaleY(0.7); }
    }
  `],
})
export class QueueChipComponent {
  readonly tray = inject(QueueTrayService);

  readonly chip = computed(() => this.tray.chip());

  @ViewChild('panel') private panel?: QueueTrayComponent;

  /** Under the chip, right edges aligned; flips above if the window is tiny. */
  readonly positions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly ariaLabel = computed(() => {
    const chip = this.chip();
    if (chip.state === 'running') {
      return `${chip.verb} ${chip.title}, ${chip.percent} percent. Open the queue tray.`;
    }
    if (chip.state === 'pending') {
      return `${chip.pending} runs waiting. Open the queue tray.`;
    }
    return 'Queue is empty. Open the queue tray.';
  });

  /** Escape has to land somewhere; the panel takes focus as it attaches. */
  focusTray(): void {
    queueMicrotask(() => this.panel?.focus());
  }
}
