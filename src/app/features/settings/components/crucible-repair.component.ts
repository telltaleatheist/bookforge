import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import {
  CRUCIBLE_REPAIR_HERE,
  crucibleRepairBytes,
  crucibleRepairHeadline,
  crucibleRepairStopWords,
  reduceCrucibleRepair,
  type CrucibleRepairSubject,
  type CrucibleRepairView,
} from '@shared/crucible/repair-wire';

/**
 * CHECK OR REPAIR ONE CRUCIBLE: the row's button and the one view of what it found.
 *
 * Main decides whether this row is this machine's engine or one elsewhere, and both
 * arrive here as the same events (`shared/crucible/repair-wire.ts`). The numbers are
 * shown from the first frame because a check may hash hundreds of gigabytes.
 */
@Component({
  selector: 'app-crucible-repair',
  standalone: true,
  imports: [DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rep">
      <div class="rep-actions">
        <!-- A check asks a running server by its row. With no row there is nobody to ask. -->
        @if (server() !== HERE) {
          <desktop-button variant="ghost" size="sm" [disabled]="running()" (click)="start(true)">Check only</desktop-button>
        }
        @if (confirming()) {
          <span class="rep-confirm">
            Verify everything and download again whatever is broken?
            <desktop-button variant="ghost" size="sm" (click)="start(false)">Repair</desktop-button>
            <desktop-button variant="ghost" size="sm" (click)="confirming.set(false)">Cancel</desktop-button>
          </span>
        } @else {
          <desktop-button variant="ghost" size="sm" [disabled]="running()" (click)="confirming.set(true)">Repair</desktop-button>
        }
        @if (running() && view()?.taskId; as taskId) {
          <desktop-button variant="ghost" size="sm" (click)="stop(taskId)">Stop</desktop-button>
        }
      </div>

      @if (view(); as v) {
        @if (v.phase === 'running') {
          @if (v.waiting) {
            <p class="rep-wait">Waiting: {{ v.waiting }}</p>
          } @else {
            <p class="rep-line">{{ v.line }}</p>
          }
          @if (progressWords(); as words) {
            <div class="rep-bar"><div class="rep-fill" [style.width.%]="progressPct()"></div></div>
            <p class="rep-meta">{{ words }}</p>
          }
          @if (stopWords(); as words) { <p class="rep-meta">{{ words }}</p> }
        }

        @if (v.refusal; as r) {
          <p [class]="r.needsUpdate ? 'rep-warn' : 'rep-bad'">{{ r.message }}</p>
          @if (r.command) { <pre class="rep-cmd">{{ r.command }}</pre> }
        }

        @if (v.result; as res) {
          <p [class]="res.healthy ? 'rep-ok' : 'rep-bad'">{{ headline() }}</p>
          @if (v.hostNote) { <p class="rep-meta">{{ v.hostNote }}</p> }
          @if (res.repaired.length > 0) {
            <h5>Repaired</h5>
            <ul>@for (f of res.repaired; track $index) { <li>{{ name(f.subject) }}: was {{ f.was }}</li> }</ul>
          }
          @if (stillBroken().length > 0) {
            <h5>Broken</h5>
            <ul>@for (f of stillBroken(); track $index) { <li>{{ name(f.subject) }}: {{ f.was }}</li> }</ul>
          }
          @if (res.failed.length > 0) {
            <h5>Could not repair</h5>
            <ul>@for (f of res.failed; track $index) { <li class="rep-bad">{{ name(f.subject) }}: {{ f.message }} <code>{{ f.code }}</code></li> }</ul>
          }
          @if (res.unverified.length > 0 || res.notHashChecked.length > 0) {
            <h5>Not fully checked</h5>
            <ul>
              @for (f of res.unverified; track $index) { <li>{{ name(f.subject) }}: {{ f.why }}</li> }
              @for (f of res.notHashChecked; track $index) { <li>{{ name(f.subject) }} ({{ f.files.length }} file{{ f.files.length === 1 ? '' : 's' }}): {{ f.why }}</li> }
            </ul>
          }
          <p class="rep-meta">{{ bytesWords() }}</p>
        }
      }
    </div>
  `,
  styles: [`
    .rep { margin-top: 6px; font-size: 0.8rem; }
    .rep-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .rep-confirm { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .rep-line, .rep-meta { color: var(--text-secondary); margin: 4px 0; }
    .rep-wait, .rep-warn { color: var(--warning, #d97706); margin: 4px 0; }
    .rep-ok { color: var(--success, #22c55e); margin: 4px 0; }
    .rep-bad { color: var(--error, #ef4444); margin: 4px 0; }
    .rep-cmd { white-space: pre-wrap; margin: 4px 0; }
    .rep-bar { height: 4px; border-radius: 2px; background: var(--border-subtle, rgba(127,127,127,.25)); overflow: hidden; }
    .rep-fill { height: 100%; background: var(--accent-primary, #06b6d4); }
    h5 { margin: 8px 0 2px; font-size: 0.78rem; }
    ul { margin: 0; padding-left: 18px; }
  `],
})
export class CrucibleRepairComponent {
  private readonly electron = inject(ElectronService);

  readonly HERE = CRUCIBLE_REPAIR_HERE;
  /** A row's name, or the engine on this computer when no row names it. */
  readonly server = input<string>(CRUCIBLE_REPAIR_HERE);
  /** A run ended, so what the host knows about this machine may have changed. */
  readonly finished = output<void>();
  readonly view = signal<CrucibleRepairView | null>(null);
  readonly confirming = signal(false);

  readonly running = computed(() => this.view()?.phase === 'running');

  /** Found, not put back and not already under "Could not repair". */
  readonly stillBroken = computed(() => {
    const res = this.view()?.result;
    if (!res) return [];
    const said = new Set([...res.repaired, ...res.failed].map((f) => `${f.subject.kind}/${f.subject.id}`));
    return res.broken.filter((f) => !said.has(`${f.subject.kind}/${f.subject.id}`));
  });

  readonly stopWords = computed(() => {
    const v = this.view();
    return v ? crucibleRepairStopWords(v) : null;
  });

  readonly headline = computed(() => {
    const res = this.view()?.result;
    return res ? crucibleRepairHeadline(res) : '';
  });

  /** Against the plan's byte count while verifying, and the download's own total after. */
  private readonly progressTotal = computed(() => {
    const v = this.view();
    return v?.bytesTotal ?? v?.bytesToCheck ?? null;
  });

  readonly progressPct = computed(() => {
    const total = this.progressTotal();
    const done = this.view()?.bytesDone ?? 0;
    return total !== null && total > 0 ? Math.min(100, (done / total) * 100) : 0;
  });

  readonly progressWords = computed(() => {
    const v = this.view();
    const total = this.progressTotal();
    if (!v || total === null) return null;
    const done = crucibleRepairBytes(v.bytesDone ?? 0);
    return `${done} of ${crucibleRepairBytes(total)}${v.file ? ` · ${v.file}` : ''}`;
  });

  readonly bytesWords = computed(() => {
    const res = this.view()?.result;
    if (!res) return '';
    const skipped = res.bytesSkippedVerified > 0
      ? `, ${crucibleRepairBytes(res.bytesSkippedVerified)} not hashed again because a repair already vouched for it and it has not changed`
      : '';
    return `${crucibleRepairBytes(res.bytesHashed)} hashed${skipped}.`;
  });

  constructor() {
    const stop = this.electron.crucible.onRepairEvent((event) => {
      if (event.server !== this.server()) return;
      this.view.update((v) => reduceCrucibleRepair(v, event));
      if (event.kind === 'done' || event.kind === 'refused') this.finished.emit();
    });
    inject(DestroyRef).onDestroy(stop);
  }

  name(subject: CrucibleRepairSubject): string {
    return `${subject.kind} ${subject.id}`;
  }

  async start(verifyOnly: boolean): Promise<void> {
    this.confirming.set(false);
    const res = await this.electron.crucible.repair(this.server(), { verifyOnly });
    if (!res.success) {
      this.view.update((v) => reduceCrucibleRepair(v, {
        kind: 'refused', server: this.server(), code: 'repair_failed',
        message: res.error ?? 'The repair could not start.', command: null, needsUpdate: false,
      }));
    }
  }

  async stop(taskId: string): Promise<void> {
    await this.electron.crucible.cancelSetUp(this.server(), taskId);
  }
}
