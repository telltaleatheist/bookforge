/**
 * server-repair — Repair and Check only, for one server, and what came of them.
 *
 * One view for both doors, because both answer the same `RepairResult`. It says
 * what was looked at and what was not, and never more than that: a healthy
 * answer with files nothing could compare is still drawn with those files.
 */
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import type { RepairState } from '@owen/foundry-core/shared/crucible-repair-wire';

import { diskWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';

@Component({
  selector: 'app-server-repair',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './server-repair.component.html',
  styleUrl: './server-repair.component.scss',
})
export class ServerRepairComponent {
  /** The registered server's name, or null for this machine's Crucible with no row. */
  readonly server = input<string | null>(null);
  /** It cannot be repaired, and installing again is the cure: the card holding Install is told. */
  readonly reinstall = output<void>();

  protected readonly size = diskWords;
  private readonly states = signal<RepairState[]>([]);

  protected readonly state = computed(() =>
    this.states().find((one) => one.server === this.server()) ?? null);
  protected readonly running = computed(() => this.state()?.running === true);
  protected readonly outcome = computed(() => this.state()?.outcome ?? null);
  protected readonly finished = computed(() => {
    const outcome = this.outcome();
    return outcome?.outcome === 'finished' ? outcome : null;
  });
  protected readonly notAsked = computed(() => {
    const outcome = this.outcome();
    return outcome?.outcome === 'not-asked' ? outcome : null;
  });
  protected readonly stopped = computed(() => this.outcome()?.outcome === 'stopped');
  /** What stopping means where it is: a rebuild cannot be interrupted, and a download is finished by the next repair. */
  protected readonly stopWords = computed(() => {
    const step = this.state()?.step;
    if (step === 'rebuild') return 'It stops after this environment finishes.';
    if (step === 'repull') return 'It stops now, and the next repair finishes this download.';
    return 'It stops at the next file.';
  });
  protected readonly refused = computed(() => {
    const outcome = this.outcome();
    return outcome?.outcome === 'refused' ? outcome : null;
  });

  /** Of what, and how far. Counted from the plan frame, so it shows from the start of a long read. */
  protected readonly progress = computed(() => {
    const state = this.state();
    if (state === null || !state.running) return null;
    const total = state.bytesTotal ?? state.bytesToCheck;
    const done = state.bytesDone;
    if (total === null || total <= 0) return done === null ? null : `${diskWords(done)} so far`;
    const percent = done === null ? 0 : Math.min(100, Math.floor((done / total) * 100));
    return `${diskWords(done ?? 0)} of ${diskWords(total)} (${percent}%)`;
  });

  constructor() {
    if (!api) return;
    const stop = api.crucible.onRepairState((state) => this.take(state));
    inject(DestroyRef).onDestroy(stop);
    void api.crucible.repairStates().then((states) => this.states.set(states));
  }

  private take(state: RepairState): void {
    this.states.update((all) => [...all.filter((one) => one.server !== state.server), state]);
    if (state.server === this.server() && state.outcome?.outcome === 'refused' && state.outcome.reinstall) {
      this.reinstall.emit();
    }
  }

  protected async start(verifyOnly: boolean): Promise<void> {
    if (!api || this.running()) return;
    this.take(await api.crucible.repair(this.server(), verifyOnly));
  }

  protected stop(): void {
    if (!api) return;
    void api.crucible.repairStop(this.server());
  }

  protected subject(subject: { kind: string; id: string }): string {
    return `${subject.kind} ${subject.id}`;
  }
}
