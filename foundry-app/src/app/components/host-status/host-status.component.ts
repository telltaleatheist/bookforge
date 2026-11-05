import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import type { HostStatus } from '@owen/foundry-core/shared/host-ops';

import { HostOpsService } from '../../core/host-ops.service';
import { NoticeService } from '../../core/notice.service';

/**
 * THE HOST STATUS CHIP — the one thing another application may draw in this
 * window's chrome, in the corner where an application says what it is doing.
 *
 * ── The gap it fills ────────────────────────────────────────────────────────
 *
 * Foundry mounted inside a host is a whole window of somebody else's app that
 * their own chrome does not reach. The host runs a queue this app knows nothing
 * about, and in the host's own windows that queue's state is in the top corner
 * where anybody can glance at it; in this window it was invisible, so a person
 * editing a book here had to go and find another window to learn whether the
 * work they had ordered was moving. This is that corner, lent out.
 *
 * ── IT IS DOMAIN-BLIND, WHICH IS THE WHOLE DESIGN ───────────────────────────
 *
 * There is no word in this file about queues, narration, books or audio. What
 * arrives is a headline, maybe a second line, maybe a number and maybe a count
 * (`HostStatus`, shared/host-ops.ts), and every one of them is drawn exactly as
 * it was declared: never abbreviated, never re-cased, never re-ordered, never
 * reconciled against anything else on screen. This component reads the headline
 * for LENGTH and for nothing else. That is the same rule the tree draws host
 * nodes by and the same rule the action menu draws host acts by — a host says
 * what it is doing and Foundry believes it, because the host is the only side
 * that knows.
 *
 * ── AND IT IS CONDITIONAL BY CONSTRUCTION ───────────────────────────────────
 *
 * Standalone nothing ever pushes, the status is null, the host element is
 * `display: none`, and the chrome is exactly the chrome this app has always
 * had — no gap, no placeholder, no reserved strip. Hosted, the same is true of
 * a host that has said nothing yet and of a host that has cleared its status
 * with null. There is no "am I hosted" branch here for the same reason there is
 * none in the tree: the emptiness IS the guard.
 *
 * ── A BUTTON OR A READOUT, AND THE DIFFERENCE IS DECLARED ───────────────────
 *
 * A host that registered `onStatusOpen` (electron/host.ts) gets a chip that can
 * be pressed — cursor, hover, focus ring — and a host that did not gets a chip
 * that plainly cannot be, drawn as text rather than as a control. Two elements
 * rather than one element with its affordances switched off, because a
 * <button> nobody may press is a lie told to the keyboard and to the screen
 * reader as well as to the eye. The readout is written once and shared between
 * them, so the two can never drift into saying different things.
 */
@Component({
  selector: 'app-host-status',
  imports: [NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Reflected onto the host element so the whole strip can take itself out of
  // the shell's layout when there is nothing to say — see the styles.
  host: { '[class.up]': 'hostOps.hostStatus() !== null' },
  templateUrl: './host-status.component.html',
  styleUrl: './host-status.component.scss',
})
export class HostStatusComponent {
  protected readonly hostOps = inject(HostOpsService);
  private readonly notices = inject(NoticeService);

  /**
   * THE HOVER: the host's two lines, and what a press would do.
   *
   * The chip ellipses whatever does not fit, so the tooltip is where a long
   * headline is readable in full — which is the same trade every truncating row
   * in this app makes. The lines are joined and nothing else is done to them.
   *
   * THE SENTENCE ABOUT THE PRESS IS FOUNDRY'S AND IS DELIBERATELY VAGUE. This
   * app does not know what the host will open and must not promise a window, a
   * page or a list; what it can honestly say is that the press is handed to the
   * application this one is running inside, which is the same phrasing the
   * action menu uses for the host's own acts.
   */
  protected tip(shown: HostStatus): string {
    const lines = shown.detail === undefined
      ? shown.headline
      : `${shown.headline}\n${shown.detail}`;
    return this.hostOps.opensStatus()
      ? `${lines}\n\nClick to open this in the app Foundry is running inside.`
      : lines;
  }

  /**
   * The press, handed straight over.
   *
   * A REFUSAL IS A SENTENCE ON THE STRIP, on this app's habit for every button
   * whose failure lives in another process. It can only be reached by a chip
   * drawn pressable over a host that registered nothing — the affordance and the
   * door are gated on the same probe — so seeing it means the two sides
   * disagree, which is worth putting in front of somebody rather than
   * swallowing.
   */
  protected open(): void {
    void this.hostOps.openStatus().catch((err: Error) => {
      this.notices.notice.set(err.message);
    });
  }
}
