import { Component, computed, inject, signal, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

import { SetupDownloadService } from '../../core/services/setup-download.service';
import { ComponentService } from '../../core/services/component.service';
import { RuntimeService } from '../../core/services/runtime.service';

/**
 * Dockable download-progress widget, mounted in the app shell so it survives
 * navigation away from first-run setup. Appears whenever a batch download is
 * live (running or just finished). Click the arrow to expand the per-item list
 * or collapse it to a corner pill; cancel the batch or finished-state dismiss
 * from here. Reads everything reactively from SetupDownloadService.
 */
@Component({
  selector: 'app-setup-download-dock',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (svc.visible()) {
      <div class="dock" [class.expanded]="svc.expanded()" [class.dragging]="dragging()"
           [style.right.px]="pos().right" [style.bottom.px]="pos().bottom">
        <!-- Header / collapsed pill — also the drag handle -->
        <button class="dock-head" (pointerdown)="onDragStart($event)" (click)="onHeadClick()"
                [title]="svc.expanded() ? 'Collapse (drag to move)' : 'Expand downloads (drag to move)'">
          @if (svc.phase() === 'running') {
            <span class="dock-spinner"></span>
          } @else if (allDone()) {
            <span class="dock-check">&#10003;</span>
          } @else {
            <span class="dock-warn">!</span>
          }
          <span class="dock-title">{{ headline() }}</span>
          <span class="dock-chevron">{{ svc.expanded() ? '▾' : '▸' }}</span>
        </button>

        <!-- Aggregate bar (always visible while running) -->
        @if (svc.phase() === 'running') {
          <div class="dock-aggregate">
            <div class="dock-bar"><div class="dock-fill" [style.width.%]="svc.aggregatePct()"></div></div>
          </div>
        }

        <!-- Expanded item list -->
        @if (svc.expanded()) {
          <div class="dock-body">
            <!-- The engine setup itself, pinned on top: queued add-ons wait on it
                 (they need the bundled python), so showing its live progress
                 explains the wait and that it's moving. -->
            @if (engineSetup(); as eng) {
              <div class="dock-item engine-row" data-status="downloading">
                <span class="di-name" [title]="eng.label">⚙ {{ eng.label }}</span>
                <div class="di-bar"><div class="di-fill" [style.width.%]="eng.pct"></div></div>
                <span class="di-pct">{{ eng.pct }}%</span>
              </div>
            }
            @for (id of svc.order(); track id) {
              <div class="dock-item" [attr.data-status]="svc.statusOf(id)">
                <span class="di-name" [title]="nameOf(id)">{{ nameOf(id) }}</span>

                @switch (svc.statusOf(id)) {
                  @case ('downloading') {
                    <div class="di-bar"><div class="di-fill" [style.width.%]="svc.pctOf(id)"></div></div>
                    <span class="di-pct">{{ svc.pctOf(id) }}%</span>
                    <button class="di-x" (click)="svc.remove(id)" title="Cancel this download">✕</button>
                  }
                  @case ('done') { <span class="di-done">✓</span> }
                  @case ('failed') { <span class="di-failed" [title]="svc.failed()[id]">Failed</span> }
                  @case ('skipped') { <span class="di-skipped">Skipped</span> }
                  @default {
                    <span class="di-queued">Queued</span>
                    <button class="di-x" (click)="svc.remove(id)" title="Remove from queue">✕</button>
                  }
                }
              </div>
            }

            <div class="dock-foot">
              @if (svc.phase() === 'running') {
                <button class="dock-btn ghost" (click)="svc.cancelAll()">Cancel all</button>
              } @else {
                <button class="dock-btn ghost" (click)="svc.dismiss()">Dismiss</button>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .dock {
      position: fixed;
      z-index: 9000;
      width: 300px;
      max-width: calc(100vw - 32px);
      background: var(--bg-elevated, #242424);
      border: 1px solid var(--border-default, #333);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      font-size: 13px;
      color: var(--text-primary, #f0f0f0);
    }

    .dock-head {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 10px 12px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    .dock-head:hover { background: var(--bg-hover, rgba(255,255,255,0.05)); }
    .dock-head { cursor: grab; touch-action: none; }
    .dock.dragging .dock-head { cursor: grabbing; }
    .dock.dragging { user-select: none; }

    .dock-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dock-chevron { color: var(--text-tertiary, #888); flex-shrink: 0; }

    .dock-spinner {
      width: 13px; height: 13px; flex-shrink: 0;
      border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: dockspin 0.8s linear infinite;
    }
    @keyframes dockspin { to { transform: rotate(360deg); } }
    .dock-check { color: #22c55e; font-weight: 700; flex-shrink: 0; }
    .dock-warn { color: var(--error, #d9534f); font-weight: 700; flex-shrink: 0; }

    .dock-aggregate { padding: 0 12px 8px; }
    .dock-bar { height: 4px; background: var(--bg-sunken, #1a1a1a); border-radius: 2px; overflow: hidden; }
    .dock-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }

    .dock-body {
      border-top: 1px solid var(--border-subtle, #2c2c2c);
      max-height: 280px;
      overflow-y: auto;
      padding: 4px 0;
    }

    .dock-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      min-height: 28px;
    }
    /* The pinned engine-setup row. */
    .engine-row {
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      border-bottom: 1px solid var(--border-subtle, #2c2c2c);
    }
    .engine-row .di-name { font-weight: 600; }
    .di-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .di-bar { flex: 0 0 60px; height: 4px; background: var(--bg-sunken, #1a1a1a); border-radius: 2px; overflow: hidden; }
    .di-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
    .di-pct { font-size: 11px; color: var(--text-secondary); min-width: 30px; text-align: right; }
    .di-done { color: #22c55e; }
    .di-failed { color: var(--error, #d9534f); font-size: 11px; }
    .di-skipped, .di-queued { color: var(--text-tertiary, #888); font-size: 11px; }

    .di-x {
      flex-shrink: 0;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary, #888); font-size: 12px; padding: 0 2px;
    }
    .di-x:hover { color: var(--text-primary, #f0f0f0); }

    .dock-foot {
      display: flex; justify-content: flex-end;
      padding: 8px 12px;
      border-top: 1px solid var(--border-subtle, #2c2c2c);
    }
    .dock-btn {
      font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
      background: transparent; border: 1px solid var(--border-default, #333); color: var(--text-secondary, #c0c0c0);
    }
    .dock-btn.ghost:hover { color: var(--text-primary, #f0f0f0); border-color: var(--text-secondary, #888); }
  `],
})
export class SetupDownloadDockComponent {
  readonly svc = inject(SetupDownloadService);
  private readonly components = inject(ComponentService);
  protected readonly runtime = inject(RuntimeService);

  /**
   * The bundled-engine setup as a top line item. While it's still downloading /
   * unpacking, the queued add-ons can't start (voices/packs/GPU need its python),
   * so surfacing its live progress explains the wait and shows it's progressing.
   */
  readonly engineSetup = computed(() => {
    if (this.runtime.ready() || !this.runtime.preparing()) return null;
    return {
      pct: this.runtime.setupProgress(),
      label: this.runtime.status().message || 'Setting up the audiobook engine…',
    };
  });

  // Draggable position (distance from the bottom-right corner, px).
  readonly pos = signal({ right: 16, bottom: 16 });
  readonly dragging = signal(false);
  private dragOrigin = { x: 0, y: 0, right: 16, bottom: 16 };
  private moved = false;

  onDragStart(event: PointerEvent): void {
    this.dragging.set(true);
    this.moved = false;
    const p = this.pos();
    this.dragOrigin = { x: event.clientX, y: event.clientY, right: p.right, bottom: p.bottom };
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const dx = event.clientX - this.dragOrigin.x;
    const dy = event.clientY - this.dragOrigin.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.moved = true;
    // Anchored bottom-right, so dragging right/down DECREASES the offsets.
    const maxRight = Math.max(0, window.innerWidth - 80);
    const maxBottom = Math.max(0, window.innerHeight - 60);
    this.pos.set({
      right: Math.min(maxRight, Math.max(0, this.dragOrigin.right - dx)),
      bottom: Math.min(maxBottom, Math.max(0, this.dragOrigin.bottom - dy)),
    });
  }

  @HostListener('document:pointerup')
  onPointerUp(): void {
    this.dragging.set(false);
  }

  /** A click that wasn't a drag toggles expand/collapse. */
  onHeadClick(): void {
    if (this.moved) { this.moved = false; return; }
    if (this.svc.expanded()) this.svc.collapse();
    else this.svc.expand();
  }

  /** All batch items finished successfully. */
  readonly allDone = computed(() =>
    this.svc.order().every((id) => {
      const s = this.svc.statusOf(id);
      return s === 'done' || s === 'skipped';
    }),
  );

  headline(): string {
    const total = this.svc.order().length;
    const done = this.svc.doneCount();
    if (this.engineSetup()) {
      return total > 0 ? `Setting up engine · ${total} queued` : 'Setting up engine…';
    }
    if (this.svc.phase() === 'running') return `Downloading ${done}/${total}…`;
    const failed = Object.keys(this.svc.failed()).length;
    if (failed > 0) return `${done}/${total} done · ${failed} failed`;
    return `All downloads complete`;
  }

  nameOf(id: string): string {
    return this.components.components().find((c) => c.component.id === id)?.component.name ?? id;
  }
}
