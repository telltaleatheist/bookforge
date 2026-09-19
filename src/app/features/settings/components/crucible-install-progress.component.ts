import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type { CrucibleCoordinationState } from '@shared/crucible/coordinate-wire';
import type {
  CrucibleInstallDoorEvent,
  CrucibleInstallOutcome,
} from '@shared/crucible/install-door-wire';
import { bytesWords } from './crucible-words';

/**
 * GETTING A CRUCIBLE, AS ONE LIST OF THINGS THAT HAPPEN.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §3.1, and it replaces two things
 * that used to sit here: a folded "Show what it does" disclosure printing eight
 * shell commands, and a "Commands BookForge cannot run for you" list. Owen,
 * 2026-09-18: *"this should be idiot proof. we should assume the user doesn't
 * know how to do it, and we shouldn't offer to let them do it themselves."*
 * **Nobody is ever shown a command.** A command a person could run is a step
 * the app should be running, and the steps ARE this list.
 *
 * ── WHAT IT IS WATCHING, WHICH IS NOT WHAT IT STARTED ──────────────────────
 *
 * On any Windows machine that can host WSL2 the ORCHESTRATOR installs the
 * Linux engine by itself, as the last part of the same install, started by the
 * tray at login (§2.3) — so the move this list draws is usually one nothing in
 * this app pressed, and may already have been running before the app opened.
 * That is why it reads `installStatus()` on arrival and then listens: a list
 * that only knew about installs it started would show an empty screen on the
 * exact machine that has the most going on.
 *
 * ── THE TWO CONTROLS, AND WHY THERE ARE ONLY TWO ───────────────────────────
 *
 * **Restart now** (§2.3) runs `shutdown.exe /r /t 5` as the interactive user,
 * and only ever because somebody pressed it — Crucible never takes a reboot
 * itself. **Try again** (§2.5) is `POST /install`, drawn only when the outcome
 * is `cannot` or `failed`, because a person who has just gone and turned
 * virtualization on in their BIOS needs exactly one button. On a `done`
 * machine there is no control at all.
 *
 * ── THE LAST TWO ROWS BELONG TO A DIFFERENT OWNER, ON PURPOSE ──────────────
 *
 * §2.8: the move itself is small (an interpreter and a wheel, ~31 MB) and the
 * GIGABYTES arrive when the app coordinates with the engine that is left
 * standing. Those are `CrucibleCoordinationState`'s to report, so they are an
 * INPUT rather than something this component asks for: the parent already
 * holds that state for the engine it is about, and two readers of one fact is
 * the defect this whole phase is against.
 */

/** Where the whole sequence has got to. One ladder, advanced only by facts. */
type SetupPhase =
  | 'idle' | 'install' | 'windows-engine' | 'linux-engine' | 'job-types' | 'models' | 'finished';

/** One row's state. `stopped` is a row that will not finish, not one that failed silently. */
type RowState = 'waiting' | 'running' | 'done' | 'stopped';

const LADDER: readonly SetupPhase[] =
  ['idle', 'install', 'windows-engine', 'linux-engine', 'job-types', 'models', 'finished'];

/**
 * THE TWO STEP NAMES THIS BUILD CAN NAME, and nothing beyond them is guessed.
 *
 * `native-install` and `local-readiness` are emitted by
 * `electron/crucible/install.ts`'s own `onStep`, so they are ours and they are
 * certain. Every OTHER step name on the stream comes from the orchestrator's
 * move, whose step vocabulary is the orchestrator's to change — so an unknown
 * name advances to the Linux-engine row and the step's own words are shown
 * beneath it, rather than being matched against a table this app invented and
 * silently mislabelled.
 */
const OUR_STEPS: Readonly<Record<string, SetupPhase>> = {
  'native-install': 'install',
  'local-readiness': 'windows-engine',
};

@Component({
  selector: 'app-crucible-install-progress',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="setup">
        <!--
          SAID ONCE, AT THE TOP, BEFORE ANYTHING LOOKS STUCK (§3.1). Measured
          2026-09-19: the host install is about 70 seconds, the carry 19, and
          one job environment 217 from the mirrors. A fresh machine on a slow
          line is tens of minutes, and a list that did not say so would be read
          as a hang.
        -->
        <p class="lede">
          A first setup downloads several gigabytes and can take a while. It keeps going while you
          work; nothing here needs watching.
        </p>

        <ol class="rows">
          @for (row of rows(); track row.id) {
            <li class="row" [class.done]="row.state === 'done'" [class.running]="row.state === 'running'"
              [class.stopped]="row.state === 'stopped'">
              <span class="mark">
                @if (row.state === 'done') { &#10003; }
                @else if (row.state === 'running') { &#8226; }
                @else if (row.state === 'stopped') { &#215; }
              </span>
              <span class="what">
                <span class="title">{{ row.title }}</span>
                @if (row.bytes) { <span class="bytes">{{ row.bytes }}</span> }
                @if (row.detail) { <span class="detail">{{ row.detail }}</span> }
                <!--
                  pip's own lines, and NO BAR (§2.12): pip cannot say how big a
                  recipe is before it has resolved it, so a bar here would be a
                  number this app made up. The line is the honest thing.
                -->
                @for (line of row.lines; track line) { <span class="line">{{ line }}</span> }
              </span>
            </li>
          }
        </ol>

        <!--
          THE OUTCOME, AND THE ONE CONTROL IT EARNS. Every sentence is the
          state table's own (§2.2) — this component composes none of them,
          because the verdict on somebody's machine has one owner and it is the
          thing that probed it.
        -->
        @if (outcome(); as result) {
          @if (result.state === 'reboot-pending') {
            <div class="verdict">
              <p class="say">Restart Windows to finish setting up the Linux engine.</p>
              @if (result.sentence) { <p class="detail">{{ result.sentence }}</p> }
              <div class="actions">
                <desktop-button variant="primary" size="sm" [disabled]="busy()" (click)="restartNow()">
                  {{ busy() ? 'Restarting…' : 'Restart now' }}
                </desktop-button>
              </div>
              <p class="detail">
                Setting up carries on by itself when this computer comes back. Nothing restarts
                without you pressing that.
              </p>
            </div>
          } @else if (result.state === 'cannot') {
            <div class="verdict bad">
              <p class="say">This computer can't run the Linux engine: {{ result.sentence }}</p>
              <p class="detail">
                BookForge works on the Windows engine, which is already running. If you have
                changed something on this computer since, ask again.
              </p>
              <div class="actions">
                <desktop-button variant="ghost" size="sm" [disabled]="busy()" (click)="tryAgain()">
                  {{ busy() ? 'Trying…' : 'Try again' }}
                </desktop-button>
              </div>
            </div>
          } @else if (result.state === 'failed') {
            <div class="verdict bad">
              <p class="say">Setting up the Linux engine stopped: {{ result.sentence }}</p>
              <div class="actions">
                <desktop-button variant="ghost" size="sm" [disabled]="busy()" (click)="tryAgain()">
                  {{ busy() ? 'Trying…' : 'Try again' }}
                </desktop-button>
              </div>
            </div>
          } @else if (result.state === 'declined') {
            <p class="detail">This computer is set to stay on the Windows engine.</p>
          }
        }
        @if (error(); as message) { <p class="bad">{{ message }}</p> }
      </div>
    }
  `,
  styles: [`
    .setup { display: flex; flex-direction: column; gap: 8px; }
    .lede, .detail, .line { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .detail { color: var(--text-tertiary, var(--text-secondary)); }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; gap: 8px; align-items: baseline; }
    .row .mark { width: 12px; flex: none; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }
    .row.done .mark { color: var(--success, #4caf50); }
    .row.stopped .mark { color: var(--error, #d05a5a); }
    .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .title { font-size: 12px; color: var(--text-primary); }
    .row.waiting .title, .row:not(.done):not(.running):not(.stopped) .title { color: var(--text-secondary); }
    .row.running .title { font-weight: 600; }
    .bytes { font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .line {
      font-family: var(--font-mono, monospace); font-size: 11px; overflow-x: auto;
      white-space: pre; color: var(--text-tertiary, var(--text-secondary));
    }
    .verdict {
      display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 6px;
      border: 1px solid var(--border-subtle, var(--border-default));
      background: var(--bg-surface, var(--surface-1));
    }
    .say { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-primary); }
    .verdict.bad .say { color: var(--error, #d05a5a); }
    .bad { margin: 0; font-size: 12px; line-height: 1.45; color: var(--error, #d05a5a); }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  `],
})
export class CrucibleInstallProgressComponent {
  private readonly electron = inject(ElectronService);

  /**
   * WHAT THE APP IS DOING WITH THE ENGINE THAT IS LEFT STANDING (§2.8).
   *
   * An input, not a read: the parent already holds this for the engine its
   * face is about, and the gigabytes it reports are the LAST TWO ROWS of this
   * list rather than something that happens after the list says done.
   */
  readonly coordination = input<CrucibleCoordinationState | null>(null);

  /** Is a move running right now? `GET /install`'s own word. */
  readonly running = signal(false);
  readonly outcome = signal<CrucibleInstallOutcome | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  /** The move's own words for whatever it is doing. Null before it says any. */
  private readonly stepDetail = signal<string | null>(null);
  private readonly moveBytes = signal<string | null>(null);
  /** Where the door's half of the ladder has got to. Coordination advances it further. */
  private readonly doorPhase = signal<SetupPhase>('idle');

  constructor() {
    void this.readStatus();
    const stop = this.electron.crucible.onInstallEvent((event) => this.apply(event));
    inject(DestroyRef).onDestroy(stop);
  }

  /**
   * IS THERE ANYTHING TO DRAW?
   *
   * Nothing at all on a machine where no move has ever run and none is
   * running: a progress list that drew five grey rows on a finished machine
   * would be inventing work. A `done` outcome DOES draw, because the last row
   * of a finished setup is the sentence that says which engine won.
   */
  readonly visible = computed(() =>
    this.running() || this.outcome() !== null || this.coordination() !== null);

  /**
   * THE WHOLE SEQUENCE, as one phase.
   *
   * The door's phase and coordination's are the same ladder seen from two
   * sides, and the further of the two is where the machine actually is: the
   * install door goes quiet once the move is over, and coordination has
   * nothing to say until an engine is answering.
   */
  private readonly phase = computed<SetupPhase>(() => {
    const fromDoor = this.doorPhase();
    const fromCoordination = this.coordinationPhase();
    return LADDER.indexOf(fromCoordination) > LADDER.indexOf(fromDoor) ? fromCoordination : fromDoor;
  });

  /**
   * WHERE COORDINATION IS, READ FROM ITS OWN STATE AND NOTHING ELSE.
   *
   * `bytes` is what tells a pull from an install (`settings-wire.ts`: *"A
   * pull's byte counts"*), which is the whole difference between the two last
   * rows — so the row is chosen by the fact rather than by a step name this
   * app would have to keep in step with the module generator.
   */
  private readonly coordinationPhase = computed<SetupPhase>(() => {
    const state = this.coordination();
    if (state === null) return 'idle';
    if (state.phase === 'stocked') return 'finished';
    if (state.phase !== 'preparing') return 'idle';
    return state.progress.bytes !== null ? 'models' : 'job-types';
  });

  /** The rows of §3.1, each with the state the ladder gives it. */
  readonly rows = computed(() => {
    const at = LADDER.indexOf(this.phase());
    const stoppedAt = this.stoppedPhase();
    const state = (row: SetupPhase): RowState => {
      const index = LADDER.indexOf(row);
      if (stoppedAt !== null && index === LADDER.indexOf(stoppedAt)) return 'stopped';
      if (stoppedAt !== null && index > LADDER.indexOf(stoppedAt)) return 'waiting';
      if (index < at) return 'done';
      if (index === at) return 'running';
      return 'waiting';
    };
    const coordination = this.coordination();
    const progress = coordination !== null && coordination.phase === 'preparing'
      ? coordination.progress : null;
    const linuxState = state('linux-engine');
    return [
      { id: 'install', title: 'Installing Crucible', state: state('install'),
        detail: null as string | null, bytes: null as string | null, lines: [] as string[] },
      { id: 'windows-engine', title: 'Starting the Windows engine', state: state('windows-engine'),
        detail: null, bytes: null, lines: [] },
      { id: 'linux-engine', title: 'Setting up the Linux engine', state: linuxState,
        detail: linuxState === 'running' ? this.stepDetail() : null,
        bytes: linuxState === 'running' ? this.moveBytes() : null,
        lines: [] },
      { id: 'job-types', title: 'Installing what BookForge needs', state: state('job-types'),
        detail: progress !== null && progress.step !== null
          ? `${progress.step.name} (${progress.step.index} of ${progress.step.total})` : null,
        bytes: null,
        // pip's own line, and only the last: a scrolling console in a settings
        // panel is a thing people watch instead of a thing they read.
        lines: progress !== null && progress.line !== null ? [progress.line] : [] },
      { id: 'models', title: 'Downloading models', state: state('models'),
        detail: progress !== null && progress.bytes !== null ? progress.bytes.file : null,
        bytes: progress !== null && progress.bytes !== null
          ? bytesWords(progress.bytes.done, progress.bytes.total) : null,
        lines: [] },
      { id: 'finished', title: this.endingWords(), state: state('finished'),
        detail: null, bytes: null, lines: [] },
    ];
  });

  /**
   * THE LAST ROW'S WORDS, from the outcome and nothing else.
   *
   * §3.1 gives two endings and the outcome is what tells them apart: the guest
   * engine on `done`, the native one after a `cannot`. Nothing here asks a
   * backend what it is — that would be a second owner of "which engine won",
   * and the two would disagree for the seconds between the switch and the
   * next `/v1/info`.
   */
  private endingWords(): string {
    const result = this.outcome();
    if (result === null) return 'Done';
    if (result.state === 'done') return 'Done — running on the Linux engine';
    return 'Done — running on the Windows engine';
  }

  /**
   * WHICH ROW THE SEQUENCE STOPPED ON, or null when nothing has stopped.
   *
   * Only ever the Linux-engine row: `cannot` and `failed` and `reboot-pending`
   * are all verdicts about the move, and a reboot is a PAUSE rather than a
   * stop — the sequence resumes by itself when the machine comes back, so the
   * row keeps its running mark and the verdict below says what is owed.
   */
  private readonly stoppedPhase = computed<SetupPhase | null>(() => {
    const result = this.outcome();
    if (result === null) return null;
    return result.state === 'cannot' || result.state === 'failed' ? 'linux-engine' : null;
  });

  private async readStatus(): Promise<void> {
    const res = await this.electron.crucible.installStatus();
    if (!res.success || !res.data) {
      // NOT a silent zero state: "no move has run" and "the door would not
      // answer" are different facts, and only one of them has a fix.
      this.error.set(res.error ?? 'How this computer’s setup is going could not be read, and '
        + 'nothing said why.');
      return;
    }
    this.running.set(res.data.running);
    this.outcome.set(res.data.outcome);
    if (res.data.running && this.doorPhase() === 'idle') this.doorPhase.set('install');
  }

  /** One event off the door, applied to the ladder. */
  private apply(event: CrucibleInstallDoorEvent): void {
    if (event.event === 'step') {
      const known = OUR_STEPS[event.name];
      this.doorPhase.set(known === undefined ? 'linux-engine' : known);
      this.stepDetail.set(event.detail === '' ? event.name : event.detail);
      // A new step is not the old step's download.
      this.moveBytes.set(null);
      this.running.set(true);
      return;
    }
    if (event.event === 'state') {
      // The state table has spoken about THIS machine, which only ever happens
      // once the move is the thing running.
      this.doorPhase.set('linux-engine');
      this.stepDetail.set(event.sentence);
      this.running.set(true);
      return;
    }
    if (event.event === 'progress') {
      this.doorPhase.set('linux-engine');
      this.moveBytes.set(bytesWords(event.bytes_done, event.bytes_total));
      return;
    }
    if (event.event === 'line') {
      // A line from the move is not drawn: §3.1 gives the move a step and
      // bytes, and pip's lines belong to the coordinate rows further down.
      return;
    }
    this.outcome.set(event.outcome);
    this.running.set(false);
    this.moveBytes.set(null);
    this.stepDetail.set(null);
    if (event.outcome.state === 'done') this.doorPhase.set('job-types');
  }

  /** `shutdown.exe /r /t 5`, because somebody pressed **Restart now**. */
  async restartNow(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.electron.crucible.restartWindows();
      if (!res.success) {
        this.error.set(res.error ?? 'Restarting refused and said nothing about why.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** `POST /install` — the apps' one WSL control (§2.5). */
  async tryAgain(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const res = await this.electron.crucible.installRetry();
      if (!res.success) {
        this.error.set(res.error ?? 'Trying again refused and said nothing about why.');
        return;
      }
      this.outcome.set(null);
      this.running.set(true);
      this.doorPhase.set('install');
    } finally {
      this.busy.set(false);
    }
  }
}
