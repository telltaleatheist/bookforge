import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { StateSwitchWording } from '@shared/queue/state-switch';

/**
 * RUNNING / PAUSED — the segmented control, drawn once for every scope that has
 * one.
 *
 * It began as the queue master's own markup in `queue.component.ts`. When Owen
 * asked for the Crucible servers' Enabled/Disabled checkboxes to become the same
 * switch (2026-09-22), that markup would have had to be spelled three times — the
 * master, the GPU lane header, the Settings row — in three files, two features
 * apart. So it is a component, and the words it draws come from
 * `shared/queue/state-switch.ts`: one drawing, one dialect.
 *
 * ── BOTH SIDES ARE ALWAYS PRESSABLE ─────────────────────────────────────────
 *
 * Pressing the state you are already in is not a no-op anywhere this is used:
 * on the master it picks up anything that stopped, and on a server it re-asks a
 * question the operator may have answered while the machine was asleep. The
 * component therefore emits on EVERY press and lets the owner decide — it never
 * swallows one as "already in that state".
 *
 * ── `heldReason` IS NOT `busy` ──────────────────────────────────────────────
 *
 * `busy` is a write in flight: the switch is uninteractable for the moment it
 * takes to land. `heldReason` is a fact about something ELSE that makes Running
 * mean less than it says — the queue master being paused, for a server switch —
 * and it must NOT disable the control: the operator is still allowed to say what
 * this machine is for while the whole queue rests. It mutes the live dot and
 * puts the reason in the tooltip, which is the honest amount of noise for it.
 */
@Component({
  selector: 'desktop-state-switch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="seg"
      [class.compact]="size() === 'sm'"
      [class.held]="heldReason() !== null"
      role="group"
      [attr.aria-label]="ariaLabel()"
    >
      <button
        type="button"
        class="seg-btn"
        [class.on]="running()"
        [attr.aria-pressed]="running()"
        [disabled]="busy()"
        [title]="runningTitle()"
        (click)="press(true)"
      ><span class="seg-dot" aria-hidden="true"></span>{{ wording().running.label }}</button>
      <button
        type="button"
        class="seg-btn paused"
        [class.on]="!running()"
        [attr.aria-pressed]="!running()"
        [disabled]="busy()"
        [title]="wording().paused.title"
        (click)="press(false)"
      ><span class="seg-dot" aria-hidden="true"></span>{{ wording().paused.label }}</button>
    </div>
  `,
  styles: [`
    :host { display: inline-flex; min-width: 0; }

    .seg {
      display: inline-flex;
      border: 1px solid var(--border-default);
      border-radius: 7px;
      overflow: hidden;
      background: var(--bg-surface);
    }

    .seg-btn {
      font-family: inherit;
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 4px 11px;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    .seg-btn + .seg-btn { border-left: 1px solid var(--border-default); }
    .seg-btn:hover:not(:disabled) { color: var(--text-primary); }
    .seg-btn:disabled { cursor: progress; }
    .seg-btn.on { background: var(--accent-subtle); color: var(--accent); }
    .seg-btn.paused.on { background: var(--warning-bg); color: var(--warning-text); }

    /* The tighter drawing, for a lane header that also carries a slot ordinal,
       a state word and a temperature. Same control, less air. */
    .compact .seg-btn { font-size: 0.625rem; padding: 2px 8px; gap: 5px; }
    .compact .seg-dot { width: 5px; height: 5px; }

    .seg-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
      opacity: 0.35;
    }
    .seg-btn.on .seg-dot { opacity: 1; }

    /* A borderless button on a control with its own background shows no default
       ring. Carried in with the markup — the page that used to say this for the
       master cannot reach inside the component. */
    .seg-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Held by something above it: the choice stands and is still pressable, but
       the lit side does not get to look like work is happening. */
    .held .seg-btn.on:not(.paused) { background: var(--bg-elevated); color: var(--text-muted); }
    .held .seg-btn.on:not(.paused) .seg-dot { opacity: 0.4; }
  `],
})
export class DesktopStateSwitchComponent {
  /** Which side is lit. */
  readonly running = input.required<boolean>();
  /** The two sides' words — `QUEUE_STATE_CONTROL` or `SERVER_STATE_CONTROL`. */
  readonly wording = input.required<StateSwitchWording>();
  /** What this switch governs, for a screen reader: "Queue state", "3090 Ti". */
  readonly label = input<string>('');
  /** A write is in flight; both sides go uninteractable until it lands. */
  readonly busy = input<boolean>(false);
  /** Why Running will not start anything anyway, or null. See the class docs. */
  readonly heldReason = input<string | null>(null);
  readonly size = input<'sm' | 'md'>('md');

  /** Every press, including one for the state already shown. */
  readonly stateChange = output<boolean>();

  protected readonly ariaLabel = computed(
    () => (this.label() ? `${this.label()} — running or paused` : 'Running or paused'));

  /** The held reason is appended rather than replacing: both facts are true. */
  protected readonly runningTitle = computed(() => {
    const held = this.heldReason();
    const own = this.wording().running.title;
    return held === null ? own : `${own}\n\n${held}`;
  });

  protected press(running: boolean): void {
    this.stateChange.emit(running);
  }
}
